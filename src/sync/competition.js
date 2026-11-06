/**
 * 竞品与市场格局：一个词一次 2 点。
 *
 * 拿到两样东西：
 *   1. 这个词的 Top 竞品（ASIN + 价格）——直接回答「谁在跟我抢同一个词」；
 *   2. 格局快照（集中度、Top3 点击/转化份额、点击与转化的背离）——回答「我挤得进去吗」。
 *
 * 注意：SIF 这个工具的 top_competitors 只给 asin/price，**没有 share 字段**，
 * 所以 share 存 NULL 而不是 0 —— 「没给」和「份额是 0」是两件事。
 */
import { latestMarketSnapshot, upsertMarketSnapshot } from '../store/keywords.js'
import { nowIso } from '../store/time.js'
import { parseDataDate, stripAsin } from './normalize.js'
import { callTool } from './plan.js'

export const COMPETITION_COST = 2

export async function fetchCompetition({ client, store, marketplace = 'US', keyword, pageSize = 30, logger = console }) {
  const word = String(keyword ?? '').trim().toLowerCase()
  if (!word) throw new Error('关键词不能为空')

  const result = await callTool({
    client,
    store,
    tool: 'market_get_keyword_competition',
    params: {
      keyword: word,
      country: marketplace,
      pageSize,
      returnFields: ['market_structure', 'concentration_profile', 'top_competitors', 'leadership', 'pagination', 'data_notice', '_quota'],
    },
  })

  const payload = result.payload ?? {}
  const observedAt = nowIso()
  const dataDate = parseDataDate(payload.data_notice)
  const structure = payload.market_structure ?? {}
  const profile = payload.concentration_profile ?? {}
  const leadership = profile.leadership ?? payload.leadership ?? {}

  // 竞品行：同一 (词, 抓取时间) 下先清后写，避免重复抓取堆行
  store.tx(() => {
    store.run(
      `DELETE FROM sif_competitor WHERE marketplace = ? AND keyword = ? AND scope = 'competition' AND observed_at = ?`,
      [marketplace, word, observedAt])
    const insert = store.raw.prepare(
      `INSERT INTO sif_competitor (marketplace, keyword, scope, asin, share, natural_share, sp_share, price, reviews, posture, payload_json, observed_at, data_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const item of payload.top_competitors ?? []) {
      const asin = stripAsin(item.asin)
      if (!asin) continue
      insert.run(marketplace, word, 'competition', asin, null, null, null,
        num(item.price), int(item.reviews), item.posture ?? null, JSON.stringify(item), observedAt, dataDate)
    }
  })

  upsertMarketSnapshot(store, {
    marketplace,
    keyword: word,
    observedAt,
    visibleAsinCount: int(structure.visible_asin_count),
    concentrationLevel: structure.concentration_level ?? null,
    competitionMode: structure.competition_mode ?? null,
    top3ClickShare: num(structure.top3_click_share),
    top3ConversionShare: num(structure.top3_conversion_share),
    divergence: profile.trend?.divergence ?? null,
    divergenceInsight: profile.trend?.divergence_insight ?? profile.divergence_insight ?? null,
    leaderNote: leadership.leader_diverge_insight ?? null,
    payload,
    dataDate,
  })

  const competitors = store.all(
    `SELECT asin, price FROM sif_competitor WHERE marketplace = ? AND keyword = ? AND scope = 'competition' AND observed_at = ?`,
    [marketplace, word, observedAt])
  logger.info?.(`[sif-ops] 竞品格局 ${word}: ${competitors.length} 个 ASIN，集中度 ${structure.concentration_level ?? '?'}`)

  return {
    keyword: word,
    ok: true,
    cost: result.cost,
    cached: result.cached,
    competitors,
    structure: {
      visibleAsinCount: structure.visible_asin_count ?? null,
      concentrationLevel: structure.concentration_level ?? null,
      competitionMode: structure.competition_mode ?? null,
      top3ClickShare: structure.top3_click_share ?? null,
      top3ConversionShare: structure.top3_conversion_share ?? null,
      divergence: profile.trend?.divergence ?? null,
      divergenceInsight: profile.divergence_insight ?? null,
      leaderNote: leadership.leader_diverge_insight ?? null,
    },
    snapshot: latestMarketSnapshot(store, { marketplace, keyword: word }),
    dataDate,
  }
}

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function int(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}
