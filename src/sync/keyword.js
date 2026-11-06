/**
 * 关键词级数据：ABA 历史（1 点/词）+ 需求诊断（2 点/词）。
 *
 * 这两个是「词库」的骨架：ABA 回答「这个词有多大、在涨还是在缩」，
 * 需求诊断回答「现在是入场时机还是收割时机」。
 * 批量调用：history 一次最多 10 词、demand 一次最多 20 词，按上限分块，避免逐词打请求。
 */
import { upsertKeyword } from '../store/keywords.js'
import { nowIso } from '../store/time.js'
import { parseDataDate } from './normalize.js'
import { callTool } from './plan.js'

export const KEYWORD_COST = { history: 1, demand: 2 }

/**
 * 关键词级数据的真实计费：**按调用次数，不按词数**。
 * history 一次最多 10 词、1 点；demand 一次最多 20 词、2 点。
 * 实测 3 个词只扣 3 点（1 + 2）—— 预算必须按这个算，否则报价会虚高十倍。
 */
export function keywordSyncCost(count) {
  const n = Number(count) || 0
  if (n <= 0) return 0
  return Math.ceil(n / 10) * KEYWORD_COST.history + Math.ceil(n / 20) * KEYWORD_COST.demand
}

export async function fetchKeywordData({ client, store, marketplace = 'US', keywords = [], logger = console }) {
  const list = [...new Set(keywords.map(word => String(word).trim().toLowerCase()).filter(Boolean))]
  const result = { keywords: list, cost: 0, abaRows: 0, demandRows: 0, cached: true, errors: [] }

  for (const chunk of chunked(list, 10)) {
    try {
      const history = await callTool({
        client,
        store,
        tool: 'market_get_keyword_history',
        params: { country: marketplace, granularity: 'week', keywords: chunk, returnFields: ['granularity', 'keywords', 'data_notice', '_quota'] },
      })
      result.cost += history.cost
      result.cached = result.cached && history.cached
      const payload = history.payload ?? {}
      const dataDate = parseDataDate(payload.data_notice)
      for (const item of payload.keywords ?? []) {
        const keyword = String(item.keyword ?? '').trim().toLowerCase()
        if (!keyword) continue
        const dates = item.dates ?? []
        const insert = store.raw.prepare(
          `INSERT INTO sif_keyword_aba (marketplace, keyword, week_start, volume, rank, top3_click_share, top3_conversion_share, top3_asins_json, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT (marketplace, keyword, week_start) DO UPDATE SET
             volume = excluded.volume, rank = excluded.rank,
             top3_click_share = excluded.top3_click_share, top3_conversion_share = excluded.top3_conversion_share,
             top3_asins_json = excluded.top3_asins_json, fetched_at = excluded.fetched_at`)
        dates.forEach((week, index) => {
          insert.run(marketplace, keyword, week,
            num(item.volumes?.[index]), num(item.ranks?.[index]),
            num(item.top3_click_shares?.[index]), num(item.top3_conversion_shares?.[index]),
            index === dates.length - 1 ? JSON.stringify(item.latest?.top3_asins ?? null) : null,
            nowIso())
          result.abaRows += 1
        })
        upsertKeyword(store, {
          marketplace, keyword, translate: item.translateKeyword ?? null, source: 'aba', status: 'tracked',
        })
      }
    } catch (error) {
      result.errors.push(`history: ${error.message}`)
      logger.warn?.(`[sif-ops] ABA 拉取失败：${error.message}`)
    }
  }

  for (const chunk of chunked(list, 20)) {
    try {
      const demand = await callTool({
        client,
        store,
        tool: 'market_get_keyword_demand',
        params: { country: marketplace, keywords: chunk, returnFields: ['profiles', 'data_notice', '_quota'] },
      })
      result.cost += demand.cost
      result.cached = result.cached && demand.cached
      const payload = demand.payload ?? {}
      for (const profile of payload.profiles ?? []) {
        const keyword = String(profile.keyword ?? '').trim().toLowerCase()
        if (!keyword) continue
        store.run(
          `INSERT INTO sif_keyword_demand (marketplace, keyword, period_start, search_volume, search_ctr_week, search_ctr_90d,
             clicks_week, clicks_90d, search_volume_90d, diagnosis, momentum, trend_direction, yoy_change, annual_decay_rate,
             season_strength, peak_month, trough_month, weeks_to_peak, weeks_to_trough, season_position, vs_seasonal_baseline,
             demand_type, demand_confidence, ad_strategy_hint, interpretation, action_hint, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (marketplace, keyword, period_start) DO UPDATE SET
             search_volume = excluded.search_volume, search_ctr_week = excluded.search_ctr_week,
             search_ctr_90d = excluded.search_ctr_90d, clicks_week = excluded.clicks_week,
             clicks_90d = excluded.clicks_90d, search_volume_90d = excluded.search_volume_90d,
             diagnosis = excluded.diagnosis, momentum = excluded.momentum, trend_direction = excluded.trend_direction,
             yoy_change = excluded.yoy_change, annual_decay_rate = excluded.annual_decay_rate,
             season_strength = excluded.season_strength, peak_month = excluded.peak_month,
             trough_month = excluded.trough_month, weeks_to_peak = excluded.weeks_to_peak,
             weeks_to_trough = excluded.weeks_to_trough, season_position = excluded.season_position,
             vs_seasonal_baseline = excluded.vs_seasonal_baseline, demand_type = excluded.demand_type,
             demand_confidence = excluded.demand_confidence, ad_strategy_hint = excluded.ad_strategy_hint,
             interpretation = excluded.interpretation, action_hint = excluded.action_hint,
             fetched_at = excluded.fetched_at`,
          [
            marketplace, keyword, profile.ctr_data_period ?? 'unknown',
            num(profile.current?.search_volume), num(profile.search_ctr_week), num(profile.search_ctr_90d),
            num(profile.clicks_week), num(profile.clicks_90d), num(profile.search_volume_90d),
            profile.diagnosis ?? null, profile.trend?.momentum ?? null, profile.trend?.direction ?? null,
            num(profile.trend?.yoy_change), num(profile.trend?.annual_decay_rate),
            profile.seasonality?.strength ?? null, int(profile.peak_month), int(profile.trough_month),
            int(profile.weeks_to_peak), int(profile.weeks_to_trough),
            profile.current?.season_position ?? null, num(profile.current?.vs_seasonal_baseline),
            profile.demand_structure?.primary_type ?? null, profile.demand_structure?.type_confidence ?? null,
            profile.demand_structure?.ad_strategy_hint ?? null, profile.interpretation ?? null,
            profile.action_hint ?? null, nowIso(),
          ],
        )
        result.demandRows += 1
      }
    } catch (error) {
      result.errors.push(`demand: ${error.message}`)
      logger.warn?.(`[sif-ops] 需求诊断失败：${error.message}`)
    }
  }

  result.ok = result.errors.length === 0
  return result
}

export function chunked(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function int(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}
