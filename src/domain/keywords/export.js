/**
 * Turning the master library into the four artefacts the SOP asks for, plus a
 * report.
 *
 * `KEYWORD-MASTER-SOP.md` §六 defines the application rules, and the hub only
 * ever implemented them as flags on each record (`for_listing`). Flags are not
 * a deliverable: an operator wants the *list*, in the order to work in, with
 * the words the backend can actually hold already selected. So this module
 * turns the flags into sets, and applies the two constraints the flags cannot
 * express:
 *
 *   - **the backend field has a byte budget.** §6.3 rule 5 caps it at 249
 *     bytes, and §6.3 rule 1 forbids repeating title/bullet words. A flag
 *     cannot know either, because both depend on the finished title.
 *   - **negatives are a set too.** §6.4 says to filter low-relevance and
 *     high-ACoS words; the hub mentions it in the workflow and never produces
 *     the list. `negatives` is spend with no orders, which is a measurement
 *     rather than a judgement.
 *
 * The report is a self-contained HTML document: no `<script>`, no external
 * reference. That is the same contract as the optimization report — a file the
 * user can open from disk, mail on, or archive, and which cannot break because
 * a CDN moved.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PRIORITY_MEANING, SV_TIERS } from './classify.js'
import { keywordKey } from './key.js'

/** The backend search-term field's budget, in bytes (§6.3 rule 5). */
export const BACKEND_BYTE_BUDGET = 249

/** Sets the SOP defines, and the flag on the master record that fills each. */
export const ACTIVE_SETS = [
  { id: 'title', label: '标题关键词', flag: 'title', rule: 'P0/P1 + 搜索量 ≥ 10,000 + 层级 ≤ L3（SOP §6.1）' },
  { id: 'bullets', label: '五点关键词', flag: 'bullets', rule: '搜索量 ≥ 1,000 + 层级 ≤ L4（SOP §6.2）' },
  { id: 'backend', label: '后台搜索词', flag: 'backend', rule: '标题/五点放不下的词，去重后 ≤ 249 字节（SOP §6.3）' },
  { id: 'adsExact', label: '广告·精确匹配', flag: 'adsExact', rule: '搜索量 ≥ 5,000 + 层级 ≤ L3（SOP §6.4）' },
  { id: 'adsPhrase', label: '广告·词组匹配', flag: 'adsPhrase', rule: '搜索量 ≥ 2,000 + 层级 ≤ L4（SOP §6.4）' },
  { id: 'adsBroad', label: '广告·广泛匹配', flag: 'adsBroad', rule: '搜索量 ≥ 500 + 转化率 ≥ 3%（SOP §6.4）' },
]

/**
 * Build the six sets for one product line.
 *
 * Rows are expected in volume order (what `queryMaster` returns by default).
 * Order is preserved inside each set, because "which word goes in the title
 * first" is the actual question — and it is answered by volume, the only
 * comparable number the sources agree on.
 */
export function buildActiveSets(rows, { backendByteBudget = BACKEND_BYTE_BUDGET } = {}) {
  const sets = {}
  for (const definition of ACTIVE_SETS) sets[definition.id] = []

  /* 正文章位（标题/五点）优先听**落位处方**：处方说这个词进后台，就不该出现在标题里。
     处方是 v52 才有的；没有处方的行（老库、未重算）退回原来的布尔，
     避免"升级后导出突然变空"。广告三档不受处方约束 —— 处方只管正文，不管投放。 */
  const PRESCRIBED = new Set(['title', 'bullets'])

  /* 有处方的词按档位排（档 1 在前），同档再按搜索量。导出顺序就是"先写哪个"的顺序，
     档位不参与排序等于没给处方。 */
  const frontRows = [...rows].sort((a, b) => {
    const tierA = a.placement?.tier ?? 9
    const tierB = b.placement?.tier ?? 9
    if (tierA !== tierB) return tierA - tierB
    return (Number(b.searchVolume) || 0) - (Number(a.searchVolume) || 0)
  })
  const rank = new Map(frontRows.map((row, index) => [keywordKey(row.keyword), index]))

  const usedByFront = new Set()
  for (const row of rows) {
    for (const definition of ACTIVE_SETS) {
      if (definition.id === 'backend') continue
      if (PRESCRIBED.has(definition.id) && row.placement !== null && row.placement !== undefined) {
        if (row.placement.slot !== definition.id) continue
      } else if (row.forListing?.[definition.flag] !== true) continue
      sets[definition.id].push(entry(row))
      if (definition.id === 'title' || definition.id === 'bullets') {
        usedByFront.add(keywordKey(row.keyword))
      }
    }
  }

  /* 上面按 rows 的原始顺序塞的，这里按处方档位重排 —— 插入顺序不是导出顺序。 */
  for (const definition of ACTIVE_SETS) {
    if (!PRESCRIBED.has(definition.id)) continue
    sets[definition.id].sort((a, b) => (
      (rank.get(keywordKey(a.keyword)) ?? 1e9) - (rank.get(keywordKey(b.keyword)) ?? 1e9)
    ))
  }

  // Backend: everything the front cannot hold, cheapest-to-lose last. Words
  // already in the title or bullets are excluded (§6.3 rule 1) rather than
  // repeated, and the list is cut at the byte budget (§6.3 rule 5).
  const candidates = rows.filter(row => keywordKey(row.keyword) !== '' && !usedByFront.has(keywordKey(row.keyword)))
  const fitted = fitBackend(candidates.map(entry), { budget: backendByteBudget })
  sets.backend = fitted.items

  return { sets, backend: fitted }
}

/**
 * Greedily fill the backend budget.
 *
 * Greedy-by-volume rather than exact, and the result says so: `overflow` counts
 * the words that did not fit, so "249 bytes of 400 candidates" is visible
 * instead of looking like the whole set. An exact fit is a bin-packing problem
 * and would still have to pick an order; picking by volume is the order an
 * operator would pick anyway.
 */
export function fitBackend(items, { budget = BACKEND_BYTE_BUDGET } = {}) {
  const chosen = []
  const skipped = []
  let used = 0
  for (const item of items) {
    const cost = Buffer.byteLength(item.keyword, 'utf8') + (chosen.length === 0 ? 0 : 2) // ", "
    if (used + cost > budget) { skipped.push(item); continue }
    chosen.push(item)
    used += cost
  }
  return { items: chosen, bytes: used, budget, overflow: skipped.length, overflowSample: skipped.slice(0, 10).map(item => item.keyword) }
}

/**
 * Words that spent money and returned nothing.
 *
 * `spend >= minSpend && orders === 0` is a fact, not a recommendation. Whether
 * to negate depends on whether the word is relevant and merely badly bid, which
 * only the operator knows — so the list is labelled 建议 and carries the numbers
 * that make the call.
 */
export function buildNegatives(rows, { minSpend = 5, minClicks = 10 } = {}) {
  return rows
    .filter(row => Number(row.spend) >= minSpend && Number(row.orders) === 0 && Number(row.clicks) >= minClicks)
    .map(row => ({ ...entry(row), spend: row.spend, clicks: row.clicks, impressions: row.impressions }))
    .sort((a, b) => b.spend - a.spend)
}

function entry(row) {
  return {
    keyword: row.keyword,
    searchVolume: row.search_volume,
    svTier: row.sv_tier,
    priority: row.priority,
    funnel: row.funnel,
    impressions: row.impressions,
    clicks: row.clicks,
    orders: row.orders,
    spend: row.spend,
    sales: row.sales,
    cvrPct: row.cvr_pct,
    acosPct: row.acos_pct,
    competitorBestRank: row.competitor_best_rank,
  }
}

/* ─────────────────────────────── CSV ─────────────────────────────── */

/** RFC 4180 quoting, and a BOM so Excel opens UTF-8 Chinese headers. */
export function toCsv(rows, columns) {
  const escape = value => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [columns.map(column => escape(column.label)).join(',')]
  for (const row of rows) lines.push(columns.map(column => escape(column.value(row))).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** The column set every active-set CSV shares. */
export const ACTIVE_CSV_COLUMNS = [
  { label: '关键词', value: row => row.keyword },
  { label: '月搜索量', value: row => row.searchVolume ?? '' },
  { label: '搜索量层级', value: row => row.svTier ?? '' },
  { label: '优先级', value: row => row.priority ?? '' },
  { label: '漏斗', value: row => row.funnel ?? '' },
  { label: '曝光', value: row => row.impressions ?? '' },
  { label: '点击', value: row => row.clicks ?? '' },
  { label: '订单', value: row => row.orders ?? '' },
  { label: '花费', value: row => row.spend ?? '' },
  { label: '销售额', value: row => row.sales ?? '' },
  { label: '转化率%', value: row => row.cvrPct ?? '' },
  { label: 'ACoS%', value: row => row.acosPct ?? '' },
  { label: '竞品最好排名', value: row => row.competitorBestRank ?? '' },
]

/* ────────────────────────── writing the sets ────────────────────────── */

/**
 * Write the SOP's application sets — and, when asked, the negative list — as
 * CSV files, and report what was written.
 *
 * **One implementation, two callers.** `amzn_kw_export` and the pipeline
 * orchestrator both land here. That is the point: the B05 design makes their
 * output byte-identical (acceptance rule 8), and two functions that each "write
 * the same CSVs" is precisely how byte-identity stops being true — one gains a
 * column, the other does not, and nobody finds out until someone diffs the two
 * files months later. The rule that a flag cannot express (the backend byte
 * budget, the title/bullet exclusion) is applied by `buildActiveSets` inside
 * here, so there is no path that skips it.
 *
 * File names are `<set>-<marketplace>[-<productLine>]-<date>.csv`. The date is a
 * parameter rather than read inside, so a caller can pin it: two runs either
 * side of midnight would otherwise write the same sets under two names and look
 * like two different exports.
 *
 * `write: false` computes exactly the same files and counts and writes none of
 * them. That is what a dry run needs: the preview and the real export have to
 * agree on the numbers, and computing the preview by a second route is how they
 * stop agreeing.
 *
 * Throws on a purpose it does not know, naming the ones it does — an unknown
 * purpose that silently writes nothing is a caller that thinks it exported.
 */
export function writeActiveSets({
  rows,
  outDir,
  purpose = 'all',
  marketplace = 'US',
  productLine = null,
  stamp = new Date().toISOString().slice(0, 10),
  write = true,
} = {}) {
  const market = String(marketplace ?? 'US').toUpperCase()
  const line = productLine === undefined || productLine === null || String(productLine).trim() === ''
    ? null
    : String(productLine)
  const scope = String(purpose ?? 'all').toLowerCase()

  const built = buildActiveSets(rows)
  const negatives = buildNegatives(rows)
  const suffix = [market, line].filter(Boolean).join('-')
  const wanted = scope === 'all'
    ? ACTIVE_SETS.map(definition => definition.id)
    : scope === 'ads' ? ['adsExact', 'adsPhrase', 'adsBroad'] : [scope]

  if (write === true) mkdirSync(outDir, { recursive: true })
  const files = []
  for (const id of wanted) {
    const definition = ACTIVE_SETS.find(entry => entry.id === id)
    if (definition === undefined) {
      throw new Error(`unknown purpose "${purpose}" (expected all / title / bullets / backend / ads / negatives)`)
    }
    const items = built.sets[id] ?? []
    const file = join(outDir, `${id}-${suffix}-${stamp}.csv`)
    if (write === true) writeFileSync(file, toCsv(items, ACTIVE_CSV_COLUMNS), 'utf8')
    files.push({ id, label: definition.label, count: items.length, file, rule: definition.rule })
  }

  if (scope === 'all' || scope === 'negatives') {
    const file = join(outDir, `negatives-${suffix}-${stamp}.csv`)
    if (write === true) {
      writeFileSync(file, toCsv(negatives, [
        ...ACTIVE_CSV_COLUMNS,
        { label: '花费', value: row => row.spend },
        { label: '点击', value: row => row.clicks },
      ]), 'utf8')
    }
    files.push({ id: 'negatives', label: '否定词建议', count: negatives.length, file, rule: '花费 ≥ 5 且订单 = 0 且点击 ≥ 10' })
  }

  return { files, sets: built.sets, backend: built.backend, negatives }
}

/* ────────────────────────────── report ────────────────────────────── */

/**
 * A self-contained HTML report of the library.
 *
 * Every number carries where it came from. A report that says "31,805
 * keywords" without saying that 18,110 of them have no volume is a report that
 * gets acted on wrongly, so the coverage section is not an appendix — it is
 * printed above the tables.
 */
export function renderMasterReport({
  stats, sets, negatives, topVolume = [], topSpend = [], opportunities = [], competitorTop = [],
  generatedAt = new Date().toISOString(), marketplace = null, productLine = null,
} = {}) {
  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const num = value => (value === null || value === undefined || value === '' ? '—' : Number(value).toLocaleString('en-US'))
  const pct = value => (value === null || value === undefined || value === '' ? '—' : `${Number(value).toFixed(2)}%`)

  const scope = [marketplace === null ? null : `站点 ${marketplace}`, productLine === null ? null : `产品线 ${productLine}`]
    .filter(Boolean).join(' · ') || '全部站点'

  const groupRows = (groups) => groups.map(group => (
    `<tr><td>${esc(group.key ?? '未分类')}</td><td class="n">${num(group.n)}</td><td class="n">${num(group.volume)}</td></tr>`
  )).join('')

  const wordRows = (rows, extra = () => '') => rows.map(row => (
    `<tr><td>${esc(row.keyword)}</td>`
    + `<td class="n">${num(row.searchVolume)}</td>`
    + `<td>${esc(row.svTier ?? '—')}</td>`
    + `<td>${esc(row.priority ?? '—')}</td>`
    + `<td class="n">${num(row.impressions)}</td>`
    + `<td class="n">${num(row.clicks)}</td>`
    + `<td class="n">${num(row.orders)}</td>`
    + `<td class="n">${num(row.spend)}</td>`
    + `<td class="n">${pct(row.cvrPct)}</td>`
    + `<td class="n">${pct(row.acosPct)}</td>`
    + `<td>${extra(row)}</td></tr>`
  )).join('')

  const setRows = ACTIVE_SETS.map(definition => {
    const items = sets?.sets?.[definition.id] ?? []
    return `<tr><td>${esc(definition.label)}</td><td class="n">${num(items.length)}</td><td class="rule">${esc(definition.rule)}</td></tr>`
  }).join('')

  /* 「行」这一格：`rows_read_missing = 1` 时印「未记录」，不印 `num(0)`。
     这份报告是**发出去给别人看的**，一个 0 在这里读起来就是「这份文件一行都没有」。 */
  const importRowCount = row => (row.rows_read_missing === 1 ? '未记录' : num(row.rows_read))

  const importRows = (stats?.imports ?? []).map(row => (
    `<tr><td>${esc(row.file_name)}</td><td>${esc(row.kind)}</td><td>${esc(row.marketplace)}</td>`
    + `<td>${esc(row.period)}</td><td class="n">${importRowCount(row)}</td><td class="n">${num(row.facts_written)}</td>`
    + `<td>${row.included === 1 ? '计入' : '已排除'}</td><td>${esc(String(row.imported_at).slice(0, 19).replace('T', ' '))}</td></tr>`
  )).join('')

  const overlapRows = (stats?.overlaps ?? []).map(entry => (
    `<li>${esc(entry.a.file_name)} (${esc(entry.a.period)}) ∩ ${esc(entry.b.file_name)} (${esc(entry.b.period)})</li>`
  )).join('')

  const backendBytes = sets?.backend?.bytes ?? 0
  const backendBudget = sets?.backend?.budget ?? BACKEND_BYTE_BUDGET

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>关键词总库报告 — ${esc(scope)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 32px 40px 64px; color: #1a1a1a; background: #fff; line-height: 1.6; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 32px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #eee; }
  h3 { font-size: 14px; margin: 20px 0 8px; color: #444; }
  .meta { color: #666; font-size: 13px; margin-bottom: 24px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin-bottom: 8px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #f7f7f7; font-weight: 600; white-space: nowrap; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.rule { color: #666; font-size: 12px; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0 4px; }
  .card { border: 1px solid #e5e5e5; border-radius: 6px; padding: 10px 14px; min-width: 132px; }
  .card .k { font-size: 12px; color: #666; }
  .card .v { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .warn { background: #fff8e6; border-left: 3px solid #e0a800; padding: 10px 14px; margin: 12px 0; font-size: 13px; }
  .note { color: #555; font-size: 12.5px; }
  ul { margin: 6px 0; padding-left: 20px; }
  code { background: #f2f2f2; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
</style>
</head>
<body>
<h1>关键词总库报告</h1>
<div class="meta">${esc(scope)} · 生成于 ${esc(generatedAt.slice(0, 19).replace('T', ' '))} UTC</div>

<h2>一、数据边界（先读这一节）</h2>
${productLine === null || String(productLine).trim() === '' ? '' : `<div class="meta">⚠ 下面这六张卡是<b>站点全库</b>口径 —— <code>masterStats</code> 不接产品线筛选（src/store/kw.js），所以它们不是本次「${esc(String(productLine))}」范围的数。本报告的范围见标题行；各节的样本量看该节表格标题里的「/N」。</div>`}
<div class="cards">
  <div class="card"><div class="k">库内关键词</div><div class="v">${num(stats?.total)}</div></div>
  <div class="card"><div class="k">有搜索量</div><div class="v">${num(stats?.withVolume)}</div></div>
  <div class="card"><div class="k">无搜索量</div><div class="v">${num(stats?.withoutVolume)}</div></div>
  <div class="card"><div class="k">有 ABA</div><div class="v">${num(stats?.withAba)}</div></div>
  <div class="card"><div class="k">有广告</div><div class="v">${num(stats?.withAd)}</div></div>
  <div class="card"><div class="k">有竞品</div><div class="v">${num(stats?.withCompetitor)}</div></div>
</div>
<div class="note">
  <p><strong>没有搜索量的词不会被当成 0。</strong>它们只是没有任何来源告诉过我们这个数字 ——
  ABA 月报只覆盖它报告的那些查询，竞品工具只覆盖它反查的那些 ASIN，两者都不覆盖的词就是「不知道」。
  ${num(stats?.withoutVolume)} 条属于这一类，它们在「层级」「优先级」上都会落到最低档，
  这是缺数据的结果，不是低价值的结果。</p>
  <p><strong>产品线默认值。</strong>没有任何信号词命中的词会被归到默认产品线（bench-cushion）。
  本报告中有 <strong>${num(stats?.productLineDefaulted)}</strong> 条属于这种「未分类」，
  它们出现在 bench-cushion 的计数里，但并不是判定的结果。信号词表见
  <code>src/domain/keywords/classify.js</code> 的 <code>PRODUCT_LINE_SIGNALS</code>。</p>
  <p><strong>单位。</strong>所有比率都是百分数，且写在列名里（cvr_pct / ctr_pct / acos_pct）。
  ABA 的转化率与广告报告的转化率来自不同口径、不同时间窗，主库优先用 ABA 并记录
  <code>cvr_source</code>。</p>
  ${(stats?.overlaps ?? []).length > 0
    ? `<p><strong>广告报告周期重叠。</strong>下面这些文件的统计窗口互相覆盖，把它们全部相加会重复计数：</p><ul>${overlapRows}</ul>
       <p>需要用其中一部分时，用 <code>amzn_kw_source</code> 把不需要的文件设为 excluded，再重算。</p>`
    : ''}
</div>

<h2>二、总体指标</h2>
<div class="cards">
  <div class="card"><div class="k">广告曝光</div><div class="v">${num(stats?.totalImpressions)}</div></div>
  <div class="card"><div class="k">广告点击</div><div class="v">${num(stats?.totalClicks)}</div></div>
  <div class="card"><div class="k">广告订单</div><div class="v">${num(stats?.totalOrders)}</div></div>
  <div class="card"><div class="k">广告花费</div><div class="v">${stats?.totalSpend === null || stats?.totalSpend === undefined ? '—' : `$${num(Math.round(stats.totalSpend))}`}</div></div>
  <div class="card"><div class="k">广告销售额</div><div class="v">${stats?.totalSales === null || stats?.totalSales === undefined ? '—' : `$${num(Math.round(stats.totalSales))}`}</div></div>
  <div class="card"><div class="k">整体 ACoS</div><div class="v">${stats?.totalSales > 0 ? `${((stats.totalSpend / stats.totalSales) * 100).toFixed(1)}%` : '—'}</div></div>
</div>

<h2>三、应用集（SOP §六）</h2>
<table>
<thead><tr><th>集合</th><th class="n">词数</th><th>规则</th></tr></thead>
<tbody>${setRows}</tbody>
</table>
<p class="note">后台搜索词受 <strong>${backendBytes}/${backendBudget}</strong> 字节预算限制，
${sets?.backend?.overflow > 0 ? `有 ${num(sets.backend.overflow)} 个词没放下（按搜索量从低到高落选）。` : '全部装得下。'}
标题/五点里已有的词不会重复进后台（SOP §6.3 规则 1）。</p>

<h2>四、分布</h2>
<h3>产品线</h3>
<table><thead><tr><th>产品线</th><th class="n">词数</th><th class="n">搜索量合计</th></tr></thead>
<tbody>${groupRows(stats?.byProductLine ?? [])}</tbody></table>
<h3>漏斗阶段</h3>
<table><thead><tr><th>阶段</th><th class="n">词数</th><th class="n">搜索量合计</th></tr></thead>
<tbody>${groupRows(stats?.byFunnel ?? [])}</tbody></table>
<h3>搜索量层级</h3>
<table><thead><tr><th>层级</th><th class="n">词数</th><th class="n">搜索量合计</th></tr></thead>
<tbody>${groupRows(stats?.bySvTier ?? [])}</tbody></table>
<h3>优先级 / 机会</h3>
<table><thead><tr><th>维度</th><th class="n">词数</th><th class="n">搜索量合计</th></tr></thead>
<tbody>
${groupRows((stats?.byPriority ?? []).map(row => ({ ...row, key: `优先级 ${row.key}` })))}
${groupRows((stats?.byOpportunity ?? []).map(row => ({ ...row, key: `机会 ${row.key}` })))}
${groupRows((stats?.byOwnStatus ?? []).map(row => ({ ...row, key: `我方存在 ${row.key}` })))}
</tbody></table>

<h2>五、搜索量 Top 30</h2>
<table>
<thead><tr><th>关键词</th><th class="n">搜索量</th><th>层级</th><th>优先级</th><th class="n">曝光</th><th class="n">点击</th><th class="n">订单</th><th class="n">花费</th><th class="n">CVR</th><th class="n">ACoS</th><th>竞品最好排名</th></tr></thead>
<tbody>${wordRows(topVolume, row => (row.competitorBestRank === null ? '—' : `#${row.competitorBestRank}`))}</tbody>
</table>

<h2>六、机会词（我们缺席 + 有量）</h2>
<p class="note">定义：ABA 显示我方点击/购买占比为 <code>none</code>，而搜索量 ≥ 5,000。
这类词我们已经错过了 —— 需要判断的是相关度，而不是有没有量。</p>
<table>
<thead><tr><th>关键词</th><th class="n">搜索量</th><th>层级</th><th>优先级</th><th class="n">曝光</th><th class="n">点击</th><th class="n">订单</th><th class="n">花费</th><th class="n">CVR</th><th class="n">ACoS</th><th>我方状态</th></tr></thead>
<tbody>${wordRows(opportunities, row => esc(row.own_status ?? '—'))}</tbody>
</table>

<h2>七、花费 Top 30</h2>
<table>
<thead><tr><th>关键词</th><th class="n">搜索量</th><th>层级</th><th>优先级</th><th class="n">曝光</th><th class="n">点击</th><th class="n">订单</th><th class="n">花费</th><th class="n">CVR</th><th class="n">ACoS</th><th>竞品最好排名</th></tr></thead>
<tbody>${wordRows(topSpend, row => (row.competitorBestRank === null ? '—' : `#${row.competitorBestRank}`))}</tbody>
</table>

<h2>八、否定词建议（花了钱没出单）</h2>
<p class="note">这是<strong>测量结果</strong>，不是结论：花费 ≥ 5 且订单为 0 且点击 ≥ 10。
是否否定取决于这个词是否相关 —— 相关但出价过高应该降价，不相关才应该否定。</p>
<table>
<thead><tr><th>关键词</th><th class="n">搜索量</th><th>层级</th><th>优先级</th><th class="n">曝光</th><th class="n">点击</th><th class="n">订单</th><th class="n">花费</th><th class="n">CVR</th><th class="n">ACoS</th><th></th></tr></thead>
<tbody>${wordRows(negatives.slice(0, 30), () => '')}</tbody>
</table>

<h2>九、竞品覆盖 Top 30</h2>
<p class="note">按「有多少个竞品 ASIN 在这个词上有自然排名」排序。竞品排名是<strong>它们的位置</strong>，
不是我们的；它回答的是「这个词的竞争格局有多拥挤」。</p>
<table>
<thead><tr><th>关键词</th><th class="n">搜索量</th><th>层级</th><th>优先级</th><th class="n">曝光</th><th class="n">点击</th><th class="n">订单</th><th class="n">花费</th><th class="n">CVR</th><th class="n">ACoS</th><th>竞品最好排名</th></tr></thead>
<tbody>${wordRows(competitorTop, row => (row.competitorBestRank === null ? '—' : `#${row.competitorBestRank}`))}</tbody>
</table>

<h2>十、导入清单</h2>
<table>
<thead><tr><th>文件</th><th>类型</th><th>站点</th><th>周期</th><th class="n">读取行</th><th class="n">事实</th><th>计入</th><th>导入时间</th></tr></thead>
<tbody>${importRows}</tbody>
</table>

<h2>十一、口径说明</h2>
<h3>搜索量层级（按 ABA 月搜索量分档）</h3>
<table>
<thead><tr><th>层级</th><th class="n">下限</th><th>说明</th></tr></thead>
<tbody>${SV_TIERS.map(tier => (
    `<tr><td>${esc(tier.label)}</td><td class="n">${num(tier.min)}</td>`
    + `<td class="rule">搜索量 ≥ ${num(tier.min)}${tier.id === 'L5' ? '（含没有搜索量的词 —— 缺数据也会落到这里）' : ''}</td></tr>`
  )).join('')}</tbody>
</table>
<h3>优先级（SOP §5.2）</h3>
<table>
<thead><tr><th>优先级</th><th>定义</th></tr></thead>
<tbody>${Object.entries(PRIORITY_MEANING).map(([key, meaning]) => (
    `<tr><td>${esc(key)}</td><td class="rule">${esc(meaning)}</td></tr>`
  )).join('')}</tbody>
</table>
<p class="note"><strong>注意层级与「分层」不是一回事。</strong>这里的 L1–L5 是搜索量分档（来自导入的数据）；
第 3 步里浏览器扫出来的 T1–T4（守位/冲刺/抢占/观察）是<strong>我们自己的 ASIN 在搜索结果里的位置</strong>，
两者在 <code>amzn_keyword_query</code> 与 <code>amzn_kw_query</code> 里分别是不同的列。</p>

</body>
</html>
`
}
