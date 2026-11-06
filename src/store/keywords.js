/**
 * 关键词总库的读写。
 *
 * 三种词在一个库里，靠 `status` 分开：
 *   candidate —— 挖掘出来的候选词（还没追踪）
 *   tracked   —— 正在追踪（有 ABA / 需求数据的通常是这类）
 *   excluded  —— 明确放弃（留着不删，理由在 note）
 */
import { nowIso } from './time.js'

export function upsertKeyword(store, row) {
  const keyword = String(row.keyword ?? '').trim().toLowerCase()
  if (!keyword) return null
  store.run(
    `INSERT INTO sif_keyword (marketplace, keyword, translate, first_seen, last_seen, status, source, root, volume_week, clicks_week, ctr_week, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (marketplace, keyword) DO UPDATE SET
       last_seen = excluded.last_seen,
       translate = COALESCE(excluded.translate, sif_keyword.translate),
       status = CASE WHEN sif_keyword.status = 'excluded' THEN sif_keyword.status ELSE excluded.status END,
       source = COALESCE(excluded.source, sif_keyword.source),
       root = COALESCE(excluded.root, sif_keyword.root),
       volume_week = COALESCE(excluded.volume_week, sif_keyword.volume_week),
       clicks_week = COALESCE(excluded.clicks_week, sif_keyword.clicks_week),
       ctr_week = COALESCE(excluded.ctr_week, sif_keyword.ctr_week),
       note = COALESCE(excluded.note, sif_keyword.note)`,
    [
      row.marketplace, keyword, row.translate ?? null, row.firstSeen ?? nowIso(), nowIso(),
      row.status ?? 'tracked', row.source ?? null, row.root ?? null,
      row.volumeWeek ?? null, row.clicksWeek ?? null, row.ctrWeek ?? null, row.note ?? null,
    ],
  )
  return store.get('SELECT * FROM sif_keyword WHERE marketplace = ? AND keyword = ?', [row.marketplace, keyword])
}

export function setKeywordStatus(store, { marketplace, keyword, status, note = null }) {
  const allowed = ['candidate', 'tracked', 'excluded']
  if (!allowed.includes(status)) throw new Error(`status 只能是 ${allowed.join(' / ')}`)
  const clean = String(keyword ?? '').trim().toLowerCase()
  const result = store.run(
    'UPDATE sif_keyword SET status = ?, note = COALESCE(?, note), last_seen = ? WHERE marketplace = ? AND keyword = ?',
    [status, note, nowIso(), marketplace, clean],
  )
  return { changed: result.changes > 0, keyword: clean, status }
}

/**
 * 词库视图：一个词一行，带上它的 ABA 最新水位、需求诊断、以及在本 ASIN 上的位置。
 * 用 LEFT JOIN 保证「没采到 ABA 的词」也出现——词库不是「有数据的词」，是「我关心的词」。
 */
export function listKeywordLibrary(store, { marketplace, asin = null, status = null, limit = 200 } = {}) {
  // 参数按 SQL 文本里 ? 的出现顺序排：先把 ak.asin（LEFT JOIN 里），再是 WHERE 的 marketplace
  const args = [asin ?? null, marketplace]
  let where = 'k.marketplace = ?'
  if (status) {
    where += ' AND k.status = ?'
    args.push(status)
  }
  args.push(limit)
  return store.all(
    `SELECT k.keyword, k.status, k.source, k.root, k.volume_week, k.clicks_week, k.ctr_week, k.note,
            k.first_seen, k.last_seen,
            aba.week_start AS aba_week, aba.volume AS aba_volume, aba.rank AS aba_rank,
            aba.top3_click_share, aba.top3_conversion_share,
            d.diagnosis, d.momentum, d.weeks_to_peak, d.season_position, d.action_hint,
            ak.traffic_share AS my_share, ak.organic_page AS my_page, ak.organic_pos AS my_pos, ak.gap_severity
     FROM sif_keyword k
     LEFT JOIN v_aba_latest aba ON aba.marketplace = k.marketplace AND aba.keyword = k.keyword
     LEFT JOIN sif_keyword_demand d ON d.marketplace = k.marketplace AND d.keyword = k.keyword
       AND d.period_start = (SELECT MAX(period_start) FROM sif_keyword_demand WHERE marketplace = k.marketplace AND keyword = k.keyword)
     LEFT JOIN sif_asin_keyword ak ON ak.marketplace = k.marketplace AND ak.keyword = k.keyword AND ak.asin = ?
     WHERE ${where}
     ORDER BY COALESCE(aba.volume, k.volume_week, 0) DESC
     LIMIT ?`,
    args,
  )
}

export function upsertMarketSnapshot(store, row) {
  store.run(
    `INSERT INTO sif_market_snapshot (marketplace, keyword, observed_at, visible_asin_count, concentration_level, competition_mode,
       top3_click_share, top3_conversion_share, divergence, divergence_insight, leader_note, payload_json, data_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (marketplace, keyword, observed_at) DO UPDATE SET
       visible_asin_count = excluded.visible_asin_count, concentration_level = excluded.concentration_level,
       competition_mode = excluded.competition_mode, top3_click_share = excluded.top3_click_share,
       top3_conversion_share = excluded.top3_conversion_share, divergence = excluded.divergence,
       divergence_insight = excluded.divergence_insight, leader_note = excluded.leader_note,
       payload_json = excluded.payload_json, data_date = excluded.data_date`,
    [row.marketplace, row.keyword, row.observedAt ?? nowIso(), row.visibleAsinCount ?? null,
      row.concentrationLevel ?? null, row.competitionMode ?? null, row.top3ClickShare ?? null,
      row.top3ConversionShare ?? null, row.divergence ?? null, row.divergenceInsight ?? null,
      row.leaderNote ?? null, JSON.stringify(row.payload ?? null), row.dataDate ?? null],
  )
}

export function listCompetitors(store, { marketplace, keyword, limit = 30 } = {}) {
  return store.all(
    `SELECT asin, scope, share, price, reviews, posture, observed_at
     FROM sif_competitor WHERE marketplace = ? AND keyword = ? AND scope = 'competition'
     ORDER BY observed_at DESC, COALESCE(price, 0) DESC LIMIT ?`, [marketplace, String(keyword).toLowerCase(), limit])
}

export function latestCompetitors(store, { marketplace, keyword } = {}) {
  const latest = store.get(
    `SELECT MAX(observed_at) AS at FROM sif_competitor WHERE marketplace = ? AND keyword = ? AND scope = 'competition'`,
    [marketplace, String(keyword).toLowerCase()])
  if (!latest?.at) return []
  return store.all(
    `SELECT asin, price, share FROM sif_competitor
     WHERE marketplace = ? AND keyword = ? AND scope = 'competition' AND observed_at = ?`,
    [marketplace, String(keyword).toLowerCase(), latest.at])
}

export function latestMarketSnapshot(store, { marketplace, keyword } = {}) {
  return store.get(
    `SELECT * FROM sif_market_snapshot WHERE marketplace = ? AND keyword = ?
     ORDER BY observed_at DESC LIMIT 1`, [marketplace, String(keyword).toLowerCase()]) ?? null
}
