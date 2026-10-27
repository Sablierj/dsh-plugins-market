/**
 * Source-file importers: bytes in, normalised facts out.
 *
 * Six source shapes, all of which really occur in
 * `D:\amazon-ops-hub\03-knowledge\keywords\master\source`:
 *
 *   brand_terms                  ABA 品牌视图 CSV (metadata line + header)
 *   ad_report                    SP/SB/聚合 搜索词报告 xlsx
 *   competitor_sellersprite      ASIN 反查 xlsx **or** csv
 *   competitor_sellersprite_json the `sellersprite_api` JSON dump
 *   competitor_xiyou             西柚 关键词反查 xlsx
 *   keyword_list                 anything else with one keyword per row
 *
 * ## The thing that had to change from the hub
 *
 * `00_import_ad_xlsx.py` reads the ad report by **fixed column index**
 * (1, 5, 8, 9, 15, 16, 18). That is correct for exactly one of the three ad
 * layouts on disk:
 *
 *   `数据聚合-ASIN-搜索词(0)-*.xlsx`  搜索词 is col 1, ASIN col 5 ✓
 *   `深谷-us-sp-搜索词-*.xlsx`        用户搜索词 col 2, no ASIN column at all ✗
 *   `深谷-us-sb-搜索词-*.xlsx`        用户搜索词 col 2, 可见展示次数 col 18 ✗
 *
 * Against the SP file — 57,637 rows, the largest source in the folder — those
 * indices read 站点 as impressions, 投放 as clicks, 广告曝光量 as orders,
 * 广告点击量 as spend and 广告花费 as sales. Every number is the right order of
 * magnitude for the column it lands in, so the import *succeeds* and writes a
 * keyword library full of wrong metrics.
 *
 * Every importer here is therefore **header-driven**: columns are found by
 * name, aliases are listed explicitly, and a required column that cannot be
 * found fails the file rather than defaulting to a position.
 *
 * Facts are returned, not written. The store layer owns persistence, which is
 * what lets these be tested against the real files with no database.
 */

import { parseCsv, toNumber, toText } from './csv.js'
import { keywordKey } from './key.js'
import { cell, decodeXmlEntities, headerIndex, readFirstSheet, readWorkbook } from './xlsx.js'
import {
  parseBadgeTags, parseBidRange, parseDifficultyBand, parseKeywordTypeTags, parseOrganicRank, parsePageRank,
} from './classify.js'

export class ImportError extends Error {}

/** Where a fact came from, for the master record's `sources` list. */
export const FACT_SOURCE = {
  brand_terms: 'brand_aba',
  ad_report: 'ad_report',
  competitor_sellersprite: 'sellersprite',
  competitor_sellersprite_json: 'sellersprite',
  competitor_xiyou: 'xiyou',
  keyword_list: 'manual',
}

/* ───────────────────────── kind & metadata ───────────────────────── */

/**
 * Which importer a file belongs to, from its name.
 *
 * Name-based rather than content-based because every one of these exports is
 * named by its tool, and the names are stable: `竞品关键词数据ASIN-US-…`,
 * `关键词反查结果_US_…`, `…搜索查询绩效…品牌视图…`, `…搜索词…`. Content sniffing
 * would need a full parse of a 12 MB workbook to answer a question the filename
 * already answers.
 *
 * `kind` is overridable on the tool, so a renamed file is not a dead end.
 */
export function detectImportKind(fileName) {
  const name = String(fileName ?? '')
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase()

  if (/竞品关键词数据|^[A-Z0-9]{10}_keywords_/i.test(name) === false && /^B0[A-Z0-9]{8}_keywords_/i.test(name)) {
    return { kind: 'competitor_sellersprite_json', confident: true }
  }
  if (/^B0[A-Z0-9]{8}_keywords_/i.test(name) && ext === 'json') {
    return { kind: 'competitor_sellersprite_json', confident: true }
  }
  if (/竞品关键词数据/i.test(name)) return { kind: 'competitor_sellersprite', confident: true }
  if (/关键词反查结果/i.test(name)) return { kind: 'competitor_xiyou', confident: true }
  if (/搜索查询绩效|品牌视图/i.test(name)) return { kind: 'brand_terms', confident: true }
  if (/搜索词/.test(name) && ext === 'xlsx') return { kind: 'ad_report', confident: true }
  if (/^B0[A-Z0-9]{8}_keywords_/i.test(name)) return { kind: 'competitor_sellersprite_json', confident: true }

  if (ext === 'csv') return { kind: 'keyword_list', confident: false }
  if (ext === 'json') return { kind: 'keyword_list', confident: false }
  return { kind: 'keyword_list', confident: false }
}

/** Marketplace from a filename, or the US default these exports all use. */
export function marketplaceFromName(fileName, fallback = 'US') {
  const name = String(fileName ?? '')
  if (/[美国]|[-_](us|US)[-_]|^us-|_US_|-us-/i.test(name)) return 'US'
  if (/加拿大|[-_](ca|CA)[-_]/.test(name)) return 'CA'
  if (/墨西哥|[-_](mx|MX)[-_]/.test(name)) return 'MX'
  if (/英国|[-_](uk|UK)[-_]/.test(name)) return 'UK'
  if (/德国|[-_](de|DE)[-_]/.test(name)) return 'DE'
  if (/日本|[-_](jp|JP)[-_]/.test(name)) return 'JP'
  // `null` must stay null, not become the string "NULL" — the caller's `??`
  // fallback depends on it, and `String(null).toUpperCase()` silently defeats it.
  return fallback === null || fallback === undefined ? null : String(fallback).toUpperCase()
}

/**
 * The period a file covers, as a sortable string.
 *
 * This is the fact tables' grouping key, so it has to be stable across
 * re-imports of the same file and *different* between files that cover
 * different windows. Falling back to `unknown` is deliberate: a period we
 * cannot read is not a period, and inventing today's date would merge two
 * unrelated reports into one bucket.
 */
export function periodFromName(fileName, kind) {
  const name = String(fileName ?? '')

  // ABA: `…_Month_2026_03_31.csv` / `…_Quarter_2025_03_31.csv`
  if (kind === 'brand_terms') {
    const m = /_(20\d{2})_(\d{2})_(\d{2})/.exec(name)
    if (m === null) return { period: 'unknown', granularity: 'unknown' }
    const quarter = /Quarter|季度/i.test(name)
    if (quarter) {
      const q = Math.floor((Number(m[2]) - 1) / 3) + 1
      return { period: `${m[1]}-Q${q}`, granularity: 'quarterly' }
    }
    return { period: `${m[1]}-${m[2]}`, granularity: 'monthly' }
  }

  // Ad report: `…20260401-20260416.xlsx`, `…-202603.xlsx`, `…-1-20260415152615799.xlsx`
  if (kind === 'ad_report') {
    const range = /(20\d{2})(\d{2})(\d{2})\s*-\s*(20\d{2})(\d{2})(\d{2})/.exec(name)
    if (range !== null) {
      const start = `${range[1]}${range[2]}${range[3]}`
      const end = `${range[4]}${range[5]}${range[6]}`
      // An inverted range is a filename typo, not a window: the hub's
      // `深谷-us-sp-搜索词-20260314-20160412-…` says it ends in 2016 while its
      // sibling file ends in 2026. Reported, not repaired — guessing the
      // intended date would put a wrong period label in the primary key.
      return { period: `${start}-${end}`, granularity: 'range', inverted: end < start }
    }
    const month = /[-_](20\d{2})(0[1-9]|1[0-2])(?!\d)/.exec(name)
    if (month !== null) return { period: `${month[1]}${month[2]}`, granularity: 'monthly' }
    return { period: 'unknown', granularity: 'unknown' }
  }

  // Competitor: a `202606~202607` window, or a trailing `…-20260328` snapshot.
  const window = /(\d{6})\s*[~-]\s*(\d{6})/.exec(name)
  if (window !== null) return { period: `${window[1]}-${window[2]}`, granularity: 'range' }

  const trailing = /(20\d{2})(\d{2})(\d{2})/g
  let last = null
  let m
  while ((m = trailing.exec(name)) !== null) last = m
  if (last !== null) return { period: `${last[1]}${last[2]}${last[3]}`, granularity: 'snapshot' }

  return { period: 'unknown', granularity: 'unknown' }
}

/** ASIN out of a 卖家精灵 filename, or null. */
export function asinFromName(fileName) {
  const name = String(fileName ?? '')
  const named = /竞品关键词数据ASIN-([A-Z]{2})-([A-Z0-9]{10})/i.exec(name)
  if (named !== null) return { asin: named[2].toUpperCase(), marketplace: named[1].toUpperCase() }
  const plain = /(?:^|[_-])(B0[A-Z0-9]{8})(?:[_-]|$)/i.exec(name)
  if (plain !== null) return { asin: plain[1].toUpperCase(), marketplace: null }
  const xiyou = /_(B0[A-Z0-9]{8})_/i.exec(name)
  if (xiyou !== null) return { asin: xiyou[1].toUpperCase(), marketplace: null }
  return { asin: null, marketplace: null }
}

/* ─────────────────────── column resolution ─────────────────────── */

/**
 * Header cell → comparable token: no spaces, no underscores, no quotes,
 * lowercased.
 *
 * Underscores are stripped because the same field is written `search_volume`
 * in a machine-made CSV, `Search Volume` in an English export and `月搜索量` in
 * a Chinese one, and a matcher that only removes spaces treats the first as a
 * different column — silently, so the volume column is simply not found and the
 * list imports with no volumes.
 */
function norm(value) {
  return String(value ?? '').replace(/[\s_"']/g, '').toLowerCase()
}

/**
 * Find a column by alias list.
 *
 * Exact match across all aliases first, then a substring pass. The two passes
 * matter: `点击率` is a substring of `广告点击率`, so a naive single pass over
 * `['点击率']` would resolve to whichever came first in the header. Exact-first
 * means an explicitly-listed alias always wins over a coincidental one.
 */
function findColumn(header, aliases, { required = false, what = '' } = {}) {
  const wanted = aliases.map(norm)
  for (let i = 0; i < header.length; i += 1) {
    if (wanted.includes(norm(header[i]))) return i
  }
  for (let i = 0; i < header.length; i += 1) {
    const token = norm(header[i])
    if (token === '') continue
    if (wanted.some(alias => token.includes(alias))) return i
  }
  if (required) {
    throw new ImportError(
      `找不到必需列 ${what || aliases[0]}（候选名: ${aliases.join(' / ')}）。`
      + `表头为: ${header.map(h => String(h ?? '')).filter(Boolean).slice(0, 24).join(', ')}`,
    )
  }
  return -1
}

const COLUMNS = {
  keyword: ['用户搜索词', '搜索词', '客户搜索词', '搜索词条', '关键词', 'keyword', 'keywords', '流量词'],
  impressions: ['广告曝光量', '曝光量', '展示量', 'impressions'],
  clicks: ['广告点击量', '点击量', 'clicks'],
  orders: ['广告订单量', '订单量', '订单数', 'orders'],
  spend: ['广告花费', '花费', '广告支出', 'spend', 'cost'],
  sales: ['广告销售额', '销售额', 'sales', 'revenue'],
  cpc: ['平均点击费用', 'CPC', '每次点击费用'],
  ctr: ['广告点击率', '点击率', 'ctr'],
  cvr: ['广告转化率', '转化率', 'cvr'],
  matchType: ['匹配类型', 'matchtype'],
  campaign: ['广告活动', 'campaign'],
  adGroup: ['广告组', 'adgroup'],
  asin: ['ASIN', '广告ASIN', '商品ASIN', 'advertisedasin'],
  adType: ['广告类型', 'adtype'],
  date: ['日期', 'date'],
  searchVolume: ['月搜索量', '搜索量', 'searchvolume', 'searches'],
  organicRank: ['自然排名'],
  organicRankPage: ['自然排名页码'],
  adRank: ['广告排名'],
  adRankPage: ['广告排名页码'],
  trafficShare: ['流量占比', '流量'],
  keywordType: ['关键词类型'],
  trafficWordType: ['流量词类型', '词标签'],
  purchases: ['购买量'],
  purchaseRate: ['购买率', '点击转化率(均值)'],
  weeklyImpressions: ['预估周曝光量'],
  spr: ['SPR'],
  titleDensity: ['标题密度'],
  cpcRange: ['建议竞价范围'],
  competition: ['竞争难度档位', '周平均竞争难度'],
  products: ['商品数'],
}

/* ─────────────────────────── ABA brand terms ─────────────────────────── */

/**
 * `品牌视图` CSV → ABA facts.
 *
 * Row 0 is a metadata line (`品牌=["ROFIEJOX"],报告范围=["每月"],…`), row 1 is
 * the header. Located by looking for the header rather than assuming index 1,
 * because the monthly and quarterly exports are translated per storefront and a
 * Chinese one says `搜索查询` where an English one says `Search Query`.
 *
 * `cvr` is converted to **percent** here (the export already is), so the
 * master's single `cvr` column has one unit.
 */
export function importBrandTerms(text, { fileName = '', marketplace = null } = {}) {
  const rows = parseCsv(text)
  const headerRow = findHeaderRowIndex(rows, ['搜索查询', 'Search Query'])
  const header = (rows[headerRow] ?? []).map(value => String(value ?? '').trim())

  const col = {
    keyword: findColumn(header, ['搜索查询', 'Search Query'], { required: true, what: '搜索查询' }),
    score: findColumn(header, ['搜索查询分数', 'Search Query Score']),
    volume: findColumn(header, ['搜索查询数量', 'Search Query Volume']),
    totalImpressions: findColumn(header, ['曝光量：总数', 'Impressions: Total Count']),
    brandImpressions: findColumn(header, ['曝光量：品牌数量']),
    brandImpressionPct: findColumn(header, ['曝光量：品牌占比%']),
    totalClicks: findColumn(header, ['点击量：总数']),
    brandClicks: findColumn(header, ['点击量：品牌数量']),
    brandClickPct: findColumn(header, ['点击量：品牌占比%']),
    totalPurchases: findColumn(header, ['购买量：总数']),
    brandPurchases: findColumn(header, ['购买量：品牌数量']),
    brandConvPct: findColumn(header, ['购买量：品牌占比%']),
    reportDate: findColumn(header, ['报告日期', 'Report Date']),
  }

  const facts = []
  const problems = []
  let skipped = 0

  for (let i = headerRow + 1; i < rows.length; i += 1) {
    const row = rows[i]
    if (row === undefined || row.every(value => String(value ?? '').trim() === '')) continue
    const keyword = toText(cell(row, col.keyword))
    if (keyword === null) { skipped += 1; continue }

    const totalClicks = toNumber(cell(row, col.totalClicks), { fallback: 0 }) ?? 0
    const totalPurchases = toNumber(cell(row, col.totalPurchases), { fallback: 0 }) ?? 0
    const brandClicks = toNumber(cell(row, col.brandClicks), { fallback: 0 }) ?? 0
    const brandPurchasesRaw = toNumber(cell(row, col.brandPurchases), { fallback: null })

    facts.push({
      keyword,
      score: toNumber(cell(row, col.score)),
      /* 搜索量缺失 → **null**，不是 0。同文件里另外两个反查导入（:558 / :797）本来就是
         null，只有这里写了 `fallback:0`，结果「这一行没有量」被写进总库成「这个词 0 次搜索」，
         直接污染「有量/无量」的判断。缺失是缺口，0 是读数。 */
      searchVolume: toNumber(cell(row, col.volume)),
      totalImpressions: toNumber(cell(row, col.totalImpressions), { fallback: 0 }) ?? 0,
      brandImpressions: toNumber(cell(row, col.brandImpressions), { fallback: 0 }) ?? 0,
      brandImpressionPct: toNumber(cell(row, col.brandImpressionPct), { fallback: 0 }) ?? 0,
      totalClicks,
      brandClicks,
      brandClickPct: toNumber(cell(row, col.brandClickPct), { fallback: 0 }) ?? 0,
      totalPurchases,
      // The export has both a brand *count* and a brand *share*; the count is
      // authoritative when present, and the share is the fallback (which is what
      // `01_import_brand.py` computed by hand).
      brandPurchases: brandPurchasesRaw ?? Math.round(totalPurchases * (toNumber(cell(row, col.brandConvPct), { fallback: 0 }) ?? 0) / 100),
      brandConvPct: toNumber(cell(row, col.brandConvPct), { fallback: 0 }) ?? 0,
      cvr: totalClicks > 0 ? round((totalPurchases / totalClicks) * 100, 2) : null,
      reportDate: toText(cell(row, col.reportDate)),
    })
  }

  if (facts.length === 0) throw new ImportError(`${fileName}: 解析出 0 条 ABA 记录（表头行 ${headerRow + 1}）`)
  return {
    kind: 'brand_terms',
    marketplace,
    sourceId: FACT_SOURCE.brand_terms,
    facts: { aba: facts, ads: [], competitor: [], keywords: [] },
    problems,
    stats: { rowsRead: rows.length - headerRow - 1, facts: facts.length, skipped, headerRow: headerRow + 1 },
  }
}

function findHeaderRowIndex(rows, mustInclude) {
  const wanted = mustInclude.map(norm)
  for (let i = 0; i < Math.min(5, rows.length); i += 1) {
    const joined = (rows[i] ?? []).map(norm).join('|')
    if (wanted.some(name => joined.includes(name))) return i
  }
  return 0
}

/* ──────────────────────────── ad reports ──────────────────────────── */

/**
 * A 搜索词 report → ad facts, aggregated per keyword.
 *
 * The three layouts on disk differ in column order, in whether an ASIN column
 * exists, and in granularity (the 聚合 export is one row per ASIN, the raw SP
 * and SB exports are one row per keyword per day). Aggregating here means the
 * fact table's grain is `(keyword, period, file)` regardless of which layout
 * produced it, so the rollup does not have to know.
 *
 * `*` is dropped: it is what Amazon writes for an auto-targeting row whose
 * search term it does not disclose. It is not a keyword, and summing it would
 * create a phantom word that ranks nowhere.
 */
export function importAdReport(rows, { fileName = '', marketplace = null } = {}) {
  const header = (rows[0] ?? []).map(value => String(value ?? '').trim())
  if (header.length < 5) throw new ImportError(`${fileName}: 广告报告表头不足 5 列，无法识别`)

  const col = {
    keyword: findColumn(header, COLUMNS.keyword, { required: true, what: '搜索词' }),
    impressions: findColumn(header, COLUMNS.impressions, { required: true, what: '广告曝光量' }),
    clicks: findColumn(header, COLUMNS.clicks, { required: true, what: '广告点击量' }),
    orders: findColumn(header, COLUMNS.orders, { required: true, what: '广告订单量' }),
    spend: findColumn(header, COLUMNS.spend, { required: true, what: '广告花费' }),
    sales: findColumn(header, COLUMNS.sales, { required: true, what: '广告销售额' }),
    cpc: findColumn(header, COLUMNS.cpc),
    matchType: findColumn(header, COLUMNS.matchType),
    campaign: findColumn(header, COLUMNS.campaign),
    adGroup: findColumn(header, COLUMNS.adGroup),
    asin: findColumn(header, COLUMNS.asin),
    adType: findColumn(header, COLUMNS.adType),
    date: findColumn(header, COLUMNS.date),
  }

  const layout = col.asin >= 0 && col.date < 0 ? 'aggregate'
    : col.adType >= 0 && col.date >= 0 ? 'raw'
      : 'unknown'

  const byKeyword = new Map()
  const problems = []
  let rowsRead = 0
  let starred = 0

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]
    if (row === undefined) continue
    if (row.every(value => value === undefined || value === null || value === '')) continue
    rowsRead += 1

    const raw = toText(cell(row, col.keyword))
    if (raw === null) continue
    if (raw === '*') { starred += 1; continue }

    /* The group key and the stored spelling are the same string, deliberately.
       Before B05.1 this folded for grouping but kept `raw` as the keyword, so two
       report files spelling one ASIN differently produced two entries, and both
       reached `kw_master` as two rows — which is where 1028 duplicate pairs came
       from. Folding only half of the pair is what produced them. */
    const key = keywordKey(raw)
    let entry = byKeyword.get(key)
    if (entry === undefined) {
      entry = {
        keyword: key,
        impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0,
        adRows: 0,
        /* T-3：**源单元格为空**的行数。库里的 spend 列是 NOT NULL DEFAULT 0，
           装不下「没有数据」——所以缺失必须在这里单独记一笔，写到 fact 的
           spend_missing 上，否则「缺数据」和「花了 0 元」在库里永远是同一个值。 */
        missing: { spend: 0, sales: 0 },
        asins: new Set(), matchTypes: new Set(), campaigns: new Set(), adTypes: new Set(),
        dates: new Set(),
        /* 逐日累计：键 = 日期|广告类型。只有行内真有日期才会有内容。 */
        daily: new Map(),
      }
      byKeyword.set(key, entry)
    }

    entry.impressions += toNumber(cell(row, col.impressions), { fallback: 0 }) ?? 0
    entry.clicks += toNumber(cell(row, col.clicks), { fallback: 0 }) ?? 0
    entry.orders += toNumber(cell(row, col.orders), { fallback: 0 }) ?? 0
    /* T-3：先判「有没有」，再当 0 累加。源单元格为空 = 这一行缺数据，
       记到 entry.missing，最终落到 fact 的 spend_missing / sales_missing。 */
    const spendValue = toNumber(cell(row, col.spend))
    if (spendValue === null) entry.missing.spend += 1
    entry.spend += spendValue ?? 0
    const salesValue = toNumber(cell(row, col.sales))
    if (salesValue === null) entry.missing.sales += 1
    entry.sales += salesValue ?? 0
    entry.adRows += 1

    const asin = col.asin >= 0 ? toText(cell(row, col.asin)) : null
    if (asin !== null) entry.asins.add(asin.toUpperCase())
    const matchType = col.matchType >= 0 ? toText(cell(row, col.matchType)) : null
    if (matchType !== null) entry.matchTypes.add(matchType)
    const campaign = col.campaign >= 0 ? toText(cell(row, col.campaign)) : null
    if (campaign !== null) entry.campaigns.add(campaign)
    const adType = col.adType >= 0 ? toText(cell(row, col.adType)) : null
    if (adType !== null) entry.adTypes.add(adType)
    const date = col.date >= 0 ? toText(cell(row, col.date)) : null
    if (date !== null) entry.dates.add(date)
    /* 行内日期是真的日期（SP/SB 导出逐行带），聚合成「这一天 × 这个广告类型」。
       只认 ISO 形态 YYYY-MM-DD；别的写法（Excel 序列号、文本）宁可丢掉也不猜。 */
    if (date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const dayKey = date + "|" + (adType ?? "")
      let bucket = entry.daily.get(dayKey)
      if (bucket === undefined) {
        bucket = { date, adType: adType ?? "", impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0 }
        entry.daily.set(dayKey, bucket)
      }
      bucket.impressions += toNumber(cell(row, col.impressions), { fallback: 0 }) ?? 0
      bucket.clicks += toNumber(cell(row, col.clicks), { fallback: 0 }) ?? 0
      bucket.orders += toNumber(cell(row, col.orders), { fallback: 0 }) ?? 0
      bucket.spend += toNumber(cell(row, col.spend), { fallback: 0 }) ?? 0
      bucket.sales += toNumber(cell(row, col.sales), { fallback: 0 }) ?? 0
    }
  }

  if (byKeyword.size === 0) throw new ImportError(`${fileName}: 广告报告里没有可用的搜索词行（${rowsRead} 行数据）`)

  if (col.asin < 0 && layout === 'raw') {
    problems.push({
      code: 'no-asin-column',
      detail: '该广告报告没有 ASIN 列，导入后这些词的「关联 ASIN」为空 —— 这是文件本身的限制，不是解析问题。',
    })
  }
  if (starred > 0) {
    problems.push({ code: 'starred-rows-skipped', detail: `跳过 ${starred} 行搜索词为 "*" 的自动投放行（Amazon 未披露实际搜索词）` })
  }

  const ads = [...byKeyword.values()].map(entry => ({
    keyword: entry.keyword,
    impressions: Math.round(entry.impressions),
    clicks: Math.round(entry.clicks),
    orders: Math.round(entry.orders),
    spend: round(entry.spend, 2),
    sales: round(entry.sales, 2),
    /* 1 = 这个词本期**至少有一行源单元格是空的**。0 = 没发现缺失。
       ⚠️ 0 也可能是「迁移前的老行」，所以它只能证明「没记到缺失」，不能证明「数据完整」。 */
    spendMissing: entry.missing.spend > 0 ? 1 : 0,
    salesMissing: entry.missing.sales > 0 ? 1 : 0,
    adRows: entry.adRows,
    asins: [...entry.asins],
    matchTypes: [...entry.matchTypes],
    campaigns: [...entry.campaigns].slice(0, 20),
    adTypes: [...entry.adTypes],
    firstDate: entry.dates.size > 0 ? [...entry.dates].sort()[0] : null,
    lastDate: entry.dates.size > 0 ? [...entry.dates].sort().at(-1) : null,
    /* 日粒度：有日期的文件才带得出来；聚合报表这里是空数组。 */
    daily: [...entry.daily.values()].map(b => ({
      date: b.date, adType: b.adType,
      impressions: Math.round(b.impressions), clicks: Math.round(b.clicks),
      orders: Math.round(b.orders), spend: round(b.spend, 2), sales: round(b.sales, 2),
    })),
  }))

  return {
    kind: 'ad_report',
    marketplace,
    sourceId: FACT_SOURCE.ad_report,
    layout,
    facts: { aba: [], ads, competitor: [], keywords: [] },
    problems,
    stats: {
      rowsRead,
      facts: ads.length,
      aggregatedFrom: rowsRead - starred,
      columns: Object.fromEntries(Object.entries(col).filter(([, index]) => index >= 0).map(([name, index]) => [name, header[index]])),
    },
  }
}

/* ─────────────────── 卖家精灵 ASIN 反查 (xlsx/csv) ─────────────────── */

/**
 * `竞品关键词数据ASIN-US-…` → competitor facts.
 *
 * Reads both `关键词类型` and `流量词类型`. The hub read only the former, and in
 * the real export that column is blank on many rows — including the first data
 * row of `…B0DS49VC81(823)-20260328.xlsx`, which is that file's largest traffic
 * word. Reading both is the difference between tagging it and losing it.
 */
export function importCompetitorSellersprite(rows, { fileName = '', marketplace = null, asin = null } = {}) {
  const header = (rows[0] ?? []).map(value => String(value ?? '').trim())
  const col = {
    keyword: findColumn(header, ['流量词', '关键词'], { required: true, what: '流量词' }),
    keywordType: findColumn(header, COLUMNS.keywordType),
    trafficWordType: findColumn(header, COLUMNS.trafficWordType),
    trafficShare: findColumn(header, COLUMNS.trafficShare),
    weeklyImpressions: findColumn(header, COLUMNS.weeklyImpressions),
    organicRank: findColumn(header, COLUMNS.organicRank),
    organicRankPage: findColumn(header, COLUMNS.organicRankPage),
    adRank: findColumn(header, COLUMNS.adRank),
    adRankPage: findColumn(header, COLUMNS.adRankPage),
    searchVolume: findColumn(header, COLUMNS.searchVolume),
    spr: findColumn(header, COLUMNS.spr),
    titleDensity: findColumn(header, COLUMNS.titleDensity),
    purchases: findColumn(header, COLUMNS.purchases),
    purchaseRate: findColumn(header, COLUMNS.purchaseRate),
    cpcRange: findColumn(header, COLUMNS.cpcRange),
    products: findColumn(header, COLUMNS.products),
  }

  const resolvedAsin = asin ?? asinFromName(fileName).asin
  const facts = []
  const problems = []
  let malformed = 0
  let noRank = 0

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]
    if (row === undefined) continue
    const keyword = toText(cell(row, col.keyword))
    if (keyword === null) continue

    const organicRaw = col.organicRank >= 0 ? cell(row, col.organicRank) : ''
    const parsed = parseOrganicRank(organicRaw)
    if (parsed.malformed) malformed += 1
    if (parsed.noRank) noRank += 1

    facts.push({
      keyword,
      asin: resolvedAsin,
      sourceId: FACT_SOURCE.competitor_sellersprite,
      organicRank: parsed.rank,
      organicPage: parsed.page ?? (col.organicRankPage >= 0 ? parseOrganicRank(cell(row, col.organicRankPage)).page : null),
      organicNoRank: parsed.noRank,
      adRank: col.adRank >= 0 ? toNumber(cell(row, col.adRank)) : null,
      keywordTypes: parseKeywordTypeTags(
        col.keywordType >= 0 ? cell(row, col.keywordType) : '',
        col.trafficWordType >= 0 ? cell(row, col.trafficWordType) : '',
      ),
      trafficShare: col.trafficShare >= 0 ? toNumber(cell(row, col.trafficShare)) : null,
      weeklyImpressions: col.weeklyImpressions >= 0 ? toNumber(cell(row, col.weeklyImpressions)) : null,
      monthlyVolume: col.searchVolume >= 0 ? toNumber(cell(row, col.searchVolume)) : null,
      purchases: col.purchases >= 0 ? toNumber(cell(row, col.purchases)) : null,
      purchaseRatePct: pct(cell(row, col.purchaseRate)),
      spr: col.spr >= 0 ? toNumber(cell(row, col.spr)) : null,
      titleDensity: col.titleDensity >= 0 ? toNumber(cell(row, col.titleDensity)) : null,
      products: col.products >= 0 ? toNumber(cell(row, col.products)) : null,
      bid: parseBidRange(col.cpcRange >= 0 ? cell(row, col.cpcRange) : ''),
      difficulty: null,
      collectedAt: null,
    })
  }

  if (facts.length === 0) throw new ImportError(`${fileName}: 卖家精灵反查文件里没有关键词行`)
  if (resolvedAsin === null) {
    problems.push({ code: 'no-asin', detail: '文件名里没有 ASIN，竞争排名无法归属到具体竞品 —— 这些词仍会进总库，但竞品维度为空。' })
  }
  if (malformed > 0) {
    problems.push({
      code: 'column-drift',
      detail: `${malformed} 行的「自然排名」列装的是别列的值（卖家精灵导出的列错位）。这些行按「未测」处理，不会伪造成缺口。`,
    })
  }
  if (noRank > 0) {
    problems.push({ code: 'no-rank', detail: `${noRank} 行明确写了「前 N 页无排名」，这是实测结论，已保留。` })
  }

  return {
    kind: 'competitor_sellersprite',
    marketplace,
    sourceId: FACT_SOURCE.competitor_sellersprite,
    facts: { aba: [], ads: [], competitor: facts, keywords: [] },
    problems,
    stats: { rowsRead: rows.length - 1, facts: facts.length, malformed, noRank, asin: resolvedAsin },
  }
}

/* ──────────────── 卖家精灵 sellersprite_api JSON ──────────────── */

/**
 * The `sellersprite_api` dump — a much richer source than the xlsx.
 *
 * `rankPosition` is an object (`{page, pageSize, index, position}`), not the
 * `第1页 75/82` string the xlsx carries, so no text parsing is needed. `searches`
 * is the monthly volume and `calculatedWeeklySearches` the weekly one, both
 * already numbers.
 *
 * `purchaseRate` is a fraction (0.0242 = 2.42%) and is converted to percent at
 * this boundary, like every other rate in this module.
 */
export function importCompetitorSellerspriteJson(json, { fileName = '', marketplace = null } = {}) {
  const items = Array.isArray(json?.keywords) ? json.keywords : (Array.isArray(json) ? json : null)
  if (items === null) {
    throw new ImportError(`${fileName}: 不是 sellersprite_api 导出（找不到 keywords 数组）`)
  }

  const asin = toText(json?.asin) ?? asinFromName(fileName).asin
  const market = toText(json?.country) ?? marketplace
  const exportedAt = toText(json?.exported_at)
  const collectedAt = exportedAt === null ? null : exportedAt.slice(0, 19).replace('T', ' ')

  const facts = []
  let unnamed = 0

  for (const item of items) {
    const keyword = toText(item?.keywords ?? item?.keyword)
    if (keyword === null) { unnamed += 1; continue }
    const organic = item?.rankPosition ?? null
    const ad = item?.adPosition ?? null

    facts.push({
      keyword,
      asin,
      sourceId: FACT_SOURCE.competitor_sellersprite_json,
      organicRank: numberOrNull(organic?.position ?? organic?.index),
      organicPage: numberOrNull(organic?.page),
      organicNoRank: organic === null,
      adRank: numberOrNull(ad?.position ?? ad?.index),
      // `position` is the same `自然搜索词/HR推荐词/SP广告词` string the xlsx
      // carries; `badges` is the API's own enum (`NATURAL_SEARCHING`, `ADS`, …).
      // Both are tags, so both are read.
      keywordTypes: [...new Set([...parseKeywordTypeTags(item?.position), ...parseBadgeTags(item?.badges)])],
      trafficShare: numberOrNull(item?.trafficPercentage),
      // `calculatedWeeklySearches` is searches, not impressions — a different
      // quantity from the xlsx's `预估周曝光量`, so a different field.
      weeklySearches: numberOrNull(item?.calculatedWeeklySearches),
      monthlyVolume: numberOrNull(item?.searches),
      purchases: numberOrNull(item?.purchases),
      purchaseRatePct: pct(numberOrNull(item?.purchaseRate)),
      // `searchesRank` is Amazon's own search-frequency rank, not 卖家精灵's SPR.
      // Storing it under `spr` would put an ABA number in a SPR column.
      abaRank: numberOrNull(item?.searchesRank),
      titleDensity: numberOrNull(item?.titleDensityExact),
      products: numberOrNull(item?.products),
      bid: { low: numberOrNull(item?.bidMin), high: numberOrNull(item?.bidMax) },
      cpc: numberOrNull(item?.bid),
      difficulty: null,
      naturalRatio: numberOrNull(item?.naturalRatio),
      adRatio: numberOrNull(item?.adRatio),
      topAsins: toText(item?.top10Asin),
      collectedAt,
    })
  }

  if (facts.length === 0) throw new ImportError(`${fileName}: JSON 里没有可用的关键词`)
  return {
    kind: 'competitor_sellersprite_json',
    marketplace: market,
    sourceId: FACT_SOURCE.competitor_sellersprite_json,
    facts: { aba: [], ads: [], competitor: facts, keywords: [] },
    problems: unnamed > 0 ? [{ code: 'rows-without-keyword', detail: `${unnamed} 条记录没有关键词字段，已跳过` }] : [],
    stats: { rowsRead: items.length, facts: facts.length, asin, exportedAt },
  }
}

/* ──────────────────────────── 西柚 反查 ──────────────────────────── */

/**
 * 西柚 `关键词反查结果_US_<ASIN>_<period>.xlsx` → competitor facts.
 *
 * Two rank representations are present and they agree: a numeric `自然排名` and
 * a `自然排名(页码-页内排名)` reading `P1-2`. The numeric column is preferred
 * and the `P` form is the fallback; using one to check the other is what makes
 * the fallback safe (`parsePageRank` in classify.js).
 */
export function importCompetitorXiyou(rows, { fileName = '', marketplace = null } = {}) {
  const header = (rows[0] ?? []).map(value => String(value ?? '').trim())
  const col = {
    keyword: findColumn(header, ['关键词 (数据来源于西柚洞察)', '关键词'], { required: true, what: '关键词' }),
    trafficShare: findColumn(header, ['流量占比']),
    organicRank: findColumn(header, ['自然排名'], { required: true, what: '自然排名' }),
    organicRankPage: findColumn(header, ['自然排名(页码-页内排名)']),
    adRank: findColumn(header, ['SP广告排名']),
    weeklyVolume: findColumn(header, ['周平均搜索量']),
    weeklyRank: findColumn(header, ['周平均关键词排名']),
    cpc: findColumn(header, ['CPC建议竞价($)']),
    cvr: findColumn(header, ['点击转化率(均值)']),
    difficulty: findColumn(header, ['周平均竞争难度']),
    difficultyBand: findColumn(header, ['竞争难度档位']),
    topAsins: findColumn(header, ['Top3 ASIN']),
    trafficSource: findColumn(header, ['展示位置']),
  }

  const resolvedAsin = asinFromName(fileName).asin
  const facts = []
  let unparsed = 0

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]
    if (row === undefined) continue
    const keyword = toText(cell(row, col.keyword))
    if (keyword === null) continue

    let rank = col.organicRank >= 0 ? toNumber(cell(row, col.organicRank)) : null
    let page = null
    if (col.organicRankPage >= 0) {
      const fallback = parsePageRank(cell(row, col.organicRankPage))
      page = fallback.page
      if (rank === null) rank = fallback.rank
    }
    // An empty rank cell is *absence of a value*, not a finding. 西柚 returns a
    // row for every keyword the ASIN could rank for, so a blank means "not
    // recorded" — which cannot be told apart from "not ranked" or "not crawled".
    // It is counted here and reported, and `organicNoRank` stays false so the
    // master never turns it into a measured gap.
    if (rank === null && page === null) unparsed += 1

    facts.push({
      keyword,
      asin: resolvedAsin,
      sourceId: FACT_SOURCE.competitor_xiyou,
      organicRank: rank,
      organicPage: page,
      organicNoRank: false,
      adRank: col.adRank >= 0 ? toNumber(cell(row, col.adRank)) : null,
      keywordTypes: col.trafficSource >= 0 ? parseKeywordTypeTags(cell(row, col.trafficSource)) : [],
      trafficShare: col.trafficShare >= 0 ? toNumber(cell(row, col.trafficShare)) : null,
      weeklySearches: col.weeklyVolume >= 0 ? toNumber(cell(row, col.weeklyVolume)) : null,
      monthlyVolume: null,
      weeklyRank: col.weeklyRank >= 0 ? toNumber(cell(row, col.weeklyRank)) : null,
      purchases: null,
      purchaseRatePct: col.cvr >= 0 ? pct(cell(row, col.cvr)) : null,
      cpc: col.cpc >= 0 ? toNumber(cell(row, col.cpc)) : null,
      bid: { low: null, high: null },
      difficulty: col.difficulty >= 0 ? toNumber(cell(row, col.difficulty)) : null,
      difficultyBand: col.difficultyBand >= 0 ? parseDifficultyBand(cell(row, col.difficultyBand)) : null,
      topAsins: col.topAsins >= 0 ? toText(cell(row, col.topAsins)) : null,
      collectedAt: null,
    })
  }

  if (facts.length === 0) throw new ImportError(`${fileName}: 西柚反查文件里没有关键词行`)
  return {
    kind: 'competitor_xiyou',
    marketplace,
    sourceId: FACT_SOURCE.competitor_xiyou,
    facts: { aba: [], ads: [], competitor: facts, keywords: [] },
    problems: unparsed > 0
      ? [{
        code: 'rank-blank',
        detail: `${unparsed} 行的自然排名为空 —— 导出里就是空值，无法区分「没排名」和「没抓到」。按未测处理，不会算成缺口。`,
      }]
      : [],
    stats: { rowsRead: rows.length - 1, facts: facts.length, asin: resolvedAsin },
  }
}

/* ────────────────────────── generic keyword list ────────────────────────── */

/**
 * Anything else with one keyword per row — a pasted list, a CSV a user made.
 *
 * Deliberately permissive: it looks for a keyword column, and takes volume and
 * difficulty if they happen to be there. A file it cannot read produces no
 * facts and a clear problem, rather than importing the first column whatever it
 * is.
 */
export function importKeywordList(rows, { fileName = '', marketplace = null } = {}) {
  const header = (rows[0] ?? []).map(value => String(value ?? '').trim())
  const col = {
    keyword: findColumn(header, COLUMNS.keyword, { required: true, what: '关键词列' }),
    volume: findColumn(header, COLUMNS.searchVolume),
    difficulty: findColumn(header, ['难度', 'difficulty']),
    productLine: findColumn(header, ['产品线', 'productline']),
  }

  const keywords = []
  const seen = new Set()
  let skipped = 0
  for (let i = 1; i < rows.length; i += 1) {
    const keyword = toText(cell(rows[i] ?? [], col.keyword))
    if (keyword === null) { skipped += 1; continue }
    /* Folded for the same reason as the ad-report importer above: the dedupe and
       the stored spelling have to agree on what one word is, or the dedupe is
       decorative. */
    const key = keywordKey(keyword)
    if (seen.has(key)) { skipped += 1; continue }
    seen.add(key)
    keywords.push({
      keyword: key,
      searchVolume: col.volume >= 0 ? toNumber(cell(rows[i], col.volume)) : null,
      difficulty: col.difficulty >= 0 ? toNumber(cell(rows[i], col.difficulty)) : null,
      productLine: col.productLine >= 0 ? toText(cell(rows[i], col.productLine)) : null,
    })
  }

  if (keywords.length === 0) throw new ImportError(`${fileName}: 关键词列表里没有可用的行`)
  return {
    kind: 'keyword_list',
    marketplace,
    sourceId: FACT_SOURCE.keyword_list,
    facts: { aba: [], ads: [], competitor: [], keywords },
    problems: skipped > 0 ? [{ code: 'rows-skipped', detail: `${skipped} 行没有关键词或重复，已跳过` }] : [],
    stats: { rowsRead: rows.length - 1, facts: keywords.length, skipped },
  }
}

/* ───────────────────────────── dispatch ───────────────────────────── */

/**
 * Parse one source file into facts.
 *
 * `kind` overrides detection; `marketplace` overrides the filename. Returns the
 * same envelope from every branch so the caller — and the pipeline — never has
 * to know which importer ran.
 */
export function parseSourceFile({ buffer, text, fileName, kind, marketplace = null }) {
  const detected = detectImportKind(fileName)
  const resolved = kind ?? detected.kind
  const market = marketplace ?? marketplaceFromName(fileName, null)
  const { period, granularity, inverted } = periodFromName(fileName, resolved)

  let result
  switch (resolved) {
    case 'brand_terms':
      result = importBrandTerms(text ?? buffer?.toString('utf8') ?? '', { fileName, marketplace: market })
      break
    case 'ad_report':
      result = importAdReport(readFirstSheet(buffer).rows, { fileName, marketplace: market })
      break
    case 'competitor_sellersprite': {
      const rows = /\.csv$/i.test(fileName)
        ? parseCsv(text ?? buffer?.toString('utf8') ?? '')
        : readFirstSheet(buffer).rows
      result = importCompetitorSellersprite(rows, { fileName, marketplace: market })
      break
    }
    case 'competitor_sellersprite_json':
      result = importCompetitorSellerspriteJson(JSON.parse(text ?? buffer?.toString('utf8') ?? 'null'), { fileName, marketplace: market })
      break
    case 'competitor_xiyou':
      result = importCompetitorXiyou(readFirstSheet(buffer).rows, { fileName, marketplace: market })
      break
    case 'keyword_list': {
      const rows = /\.csv$/i.test(fileName)
        ? parseCsv(text ?? buffer?.toString('utf8') ?? '')
        : /\.json$/i.test(fileName) ? jsonToRows(text ?? buffer?.toString('utf8') ?? '') : readFirstSheet(buffer).rows
      result = importKeywordList(rows, { fileName, marketplace: market })
      break
    }
    default:
      throw new ImportError(`不认识的文件类型 "${resolved}"（${fileName}）`)
  }

  const problems = [...result.problems]
  if (inverted === true) {
    problems.push({
      code: 'period-inverted',
      detail: `文件名里的周期区间是反的（${period}），看起来是年份笔误。周期标签按原样保留，`
        + '但这个文件不参与「周期重叠」检测 —— 与其猜成 2026 往事实表里写一个错标签，不如让它显式地不确定。',
    })
  }

  return {
    ...result,
    problems,
    marketplace: result.marketplace ?? market ?? 'US',
    period,
    granularity,
    periodInverted: inverted === true,
    detectedKind: detected.kind,
    kindOverridden: kind !== undefined && kind !== detected.kind,
    detectionConfident: detected.confident,
  }
}

/** A JSON array of strings or objects → a header row plus data rows. */
function jsonToRows(text) {
  const parsed = JSON.parse(text)
  const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.keywords) ? parsed.keywords : [])
  if (items.length === 0) throw new ImportError('JSON 里没有数组元素')
  if (typeof items[0] === 'string') return [['keyword'], ...items.map(value => [value])]
  const keys = [...new Set(items.flatMap(item => Object.keys(item ?? {})))]
  return [keys, ...items.map(item => keys.map(key => item?.[key] ?? ''))]
}

/* ───────────────────────── helpers ───────────────────────── */

/** A fraction (`0.0242`) → percent (`2.42`). Already-percent values pass through. */
function pct(value) {
  const n = numberOrNull(value)
  if (n === null) return null
  // Anything above 1 cannot be a fraction — the export already gave percent.
  return n > 1 ? n : round(n * 100, 4)
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Exposed for the tests: a header row plus data rows is what every parser takes. */
export { readWorkbook, headerIndex, decodeXmlEntities }
