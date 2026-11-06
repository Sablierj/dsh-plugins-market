/**
 * L2 周报：每 ASIN 6 点。
 *   market_get_asin_keyword_signals (3) → 词 × 份额 × 自然位 × 缺口
 *   ads_get_asin_ad_structure      (2) → SP/SB/SBV 的 campaign 数量
 *   ops_get_asin_sales_trend       (1) → 月销量序列
 *
 * 这三个是「为什么会这样」的解释层：有了它们，报告才不是只有一条曲线。
 */
import { upsertAdSummary, upsertAsinKeyword, upsertSalesMonth } from '../store/queries.js'
import { nowIso } from '../store/time.js'
import { parseDataDate, parseRank, stripAsin } from './normalize.js'
import { callTool } from './plan.js'

export async function runL2({ client, store, marketplace = 'US', asin, logger = console }) {
  const fetchedAt = nowIso()
  const result = { asin, ok: true, cost: 0, rows: 0, cached: true, parts: {} }

  // ── 1) 关键词信号 ──────────────────────────────────────
  try {
    const kw = await callTool({
      client,
      store,
      tool: 'market_get_asin_keyword_signals',
      params: {
        asin, country: marketplace, time_type: 'lately', time_value: '30', pageSize: 50,
        returnFields: ['summary', 'primary_signals', 'top_keywords', 'pagination', 'data_notice', '_quota'],
      },
    })
    result.cost += kw.cost
    result.cached = result.cached && kw.cached
    const payload = kw.payload ?? {}
    const dataDate = parseDataDate(payload.data_notice)
    const enriched = indexByKeyword(payload.primary_signals)
    const rows = Array.isArray(payload.top_keywords) ? payload.top_keywords : []
    let written = 0
    for (const raw of rows) {
      const extra = enriched[String(raw.keyword ?? '').toLowerCase()] ?? {}
      const merged = { ...extra, ...raw }
      if (!merged.keyword) continue
      const organic = parseRank(merged.organic_rank)
      upsertAsinKeyword(store, {
        marketplace,
        asin,
        keyword: String(merged.keyword).toLowerCase(),
        periodType: 'lately',
        periodValue: '30',
        trafficShare: num(merged.traffic_share),
        contriChange: num(merged.contri_change),
        contriSeverity: merged.contri_severity ?? null,
        organicPage: organic.page,
        organicPos: organic.pos,
        organicTotal: organic.total,
        organicRaw: merged.organic_rank ?? null,
        spRank: merged.sp_rank ?? null,
        sbRank: merged.sb_rank ?? null,
        rankEvolution: merged.rank_evolution ?? null,
        gapSeverity: merged.gap_severity ?? null,
        keywordHealth: merged.keyword_health ?? null,
        trafficDependency: merged.traffic_dependency ?? null,
        channelCoverage: merged.channel_coverage ?? null,
        keywordTags: merged.keyword_tags ?? null,
        fetchedAt,
        dataDate,
      })
      written += 1
    }
    result.parts.keywords = { rows: written, totalInPeriod: payload.summary?.total_keywords_in_period ?? null, cost: kw.cost, cached: kw.cached }
    result.rows += written
  } catch (error) {
    result.ok = false
    result.parts.keywords = { error: error.message }
    logger.warn?.(`[sif-ops] L2 关键词失败 ${asin}: ${error.message}`)
  }

  // ── 2) 广告结构 ────────────────────────────────────────
  try {
    const ads = await callTool({
      client,
      store,
      tool: 'ads_get_asin_ad_structure',
      params: { asin, country: marketplace, granularity: 'week', returnFields: ['asin', 'country', 'structureScope', 'ad_types', 'total_campaign_count', 'data_notice', '_quota'] },
    })
    result.cost += ads.cost
    result.cached = result.cached && ads.cached
    const payload = ads.payload ?? {}
    const byType = Object.fromEntries((payload.ad_types ?? []).map(item => [String(item.type).toUpperCase(), item.campaign_count]))
    upsertAdSummary(store, {
      marketplace, asin, observedAt: fetchedAt,
      spCount: byType.SP ?? 0, sbCount: byType.SB ?? 0, sbvCount: byType.SBV ?? 0,
      totalCount: payload.total_campaign_count ?? null,
      structureScope: payload.structureScope ?? null,
      dataDate: parseDataDate(payload.data_notice),
    })
    result.parts.ads = { sp: byType.SP ?? 0, sb: byType.SB ?? 0, sbv: byType.SBV ?? 0, total: payload.total_campaign_count ?? 0, cost: ads.cost, cached: ads.cached }
    result.rows += 1
  } catch (error) {
    result.ok = false
    result.parts.ads = { error: error.message }
    logger.warn?.(`[sif-ops] L2 广告结构失败 ${asin}: ${error.message}`)
  }

  // ── 3) 销量（形状不稳定，解析失败不算致命）──────────────
  try {
    const sales = await callTool({
      client,
      store,
      tool: 'ops_get_asin_sales_trend',
      params: { asin, country: marketplace, returnFields: ['boughtHistoryDates', 'boughtInPastMonth', 'pasinBoughtInPastMonth', 'chars[:1]', 'data_notice', '_quota'] },
    })
    result.cost += sales.cost
    result.cached = result.cached && sales.cached
    const payload = sales.payload ?? {}
    const dates = Array.isArray(payload.boughtHistoryDates) ? payload.boughtHistoryDates : []
    const series = Array.isArray(payload.chars) && Array.isArray(payload.chars[0]?.boughtList)
      ? payload.chars[0].boughtList
      : []
    let written = 0
    const band = payload.pasinBoughtInPastMonth ?? payload.boughtInPastMonth ?? null
    dates.forEach((month, index) => {
      const cell = series[index]
      const bought = typeof cell === 'number' ? cell : (cell?.bought ?? null)
      if (bought === null && !band) return
      upsertSalesMonth(store, {
        marketplace, asin, month,
        bought,
        band,
        lower: parseBand(band),
        isParent: true,
      })
      written += 1
    })
    result.parts.sales = { months: written, band, cost: sales.cost, cached: sales.cached }
    result.rows += written
  } catch (error) {
    result.parts.sales = { error: error.message }
    logger.warn?.(`[sif-ops] L2 销量失败 ${asin}: ${error.message}`)
  }

  result.dataDate = store.get('SELECT MAX(data_date) AS d FROM sif_traffic WHERE marketplace = ? AND asin = ?', [marketplace, asin])?.d ?? null
  return result
}

/** primary_signals 的三个列表拼成 keyword → 行 的索引，用来补 top_keywords 缺的字段。 */
function indexByKeyword(signals = {}) {
  const map = {}
  for (const list of Object.values(signals ?? {})) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!item?.keyword) continue
      map[String(item.keyword).toLowerCase()] = item
    }
  }
  return map
}

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** "<50" → 0（不足 50 的下界）、"5,000+" → 5000、"1.2K+" → 1200。只用于排序，不当前台精确值。 */
export function parseBand(band) {
  if (!band) return null
  const text = String(band).replace(/[,+]/g, '').trim()
  const match = /([\d.]+)\s*([KkMm]?)/.exec(text)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  // 「不足 N」的下界是 0：前台只说 <50，真实值落在 [0,50)，排序时按 0 处理
  if (text.startsWith('<')) return 0
  const unit = match[2].toUpperCase()
  if (unit === 'K') return amount * 1000
  if (unit === 'M') return amount * 1_000_000
  return amount
}

export { stripAsin }
