/**
 * 排名观测 —— 某词在某 ASIN 上，某一天排第几。
 *
 * ## 为什么要这张表
 *
 * `asin_keyword` 是**覆盖写**（ON CONFLICT DO UPDATE）：一周后重扫，上周的名次就没了。
 * 它能回答「现在第几」，回答不了「变了多少」。监控要的是后者，所以历史必须单独、
 * 只追加地存。
 *
 * ## 两种「没有」
 *
 * `found = 0` 且 `scan_depth = 48` 说的是「扫了前 48 名，没进去」；
 * 而**没有这一行**说的是「那天没扫」。两者都表现成 rank = NULL，混在一起就再也
 * 分不清「掉出榜」和「没监控」—— 这正是运营最需要区分的两件事。
 */

import { nowIso } from './db.js'

/** 今天（本地日），用作 observed_on 的默认值。 */
export function today() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 记一个观察点。同一天同一 (词, 站点, ASIN) 重扫是幂等更新。
 */
export function recordRankObservation(store, {
  keyword,
  marketplace,
  asin,
  observedOn = null,
  observedAt = null,
  rank: inputRank = null,
  organicPage = null,
  adRank = null,
  adPage = null,
  scanDepth = null,
  source = null,
  taskId = null,
} = {}) {
  const word = String(keyword ?? '').trim().toLowerCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  const code = String(asin ?? '').trim().toUpperCase()
  if (word === '' || market === '' || code === '') {
    throw new Error('recordRankObservation: keyword / marketplace / asin are required')
  }
  /* 深度缺失时不要编一个 0 —— 那会让「没找到」变成「扫了 0 个结果」。
     缺就是缺，用 NULL 表示「这次没说扫多深」。 */
  /* `Number(null) === 0` —— 直接 Number() 会把「没有排名」写成「第 0 名」。
     空值必须显式挡掉，否则 found 永远是 1，所有「新进榜 / 掉出榜」都会判反。 */
  const toNumberOrNull = value => {
    if (value === null || value === undefined || String(value).trim() === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const depth = toNumberOrNull(scanDepth)
  const rank = toNumberOrNull(inputRank)
  const found = rank !== null ? 1 : 0

  store.run(
    `INSERT INTO kw_rank_observation
       (keyword, marketplace, asin, observed_on, observed_at,
        organic_rank, organic_page, ad_rank, ad_page, scan_depth, found, source, task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(keyword, marketplace, asin, observed_on) DO UPDATE SET
       observed_at = excluded.observed_at,
       organic_rank = excluded.organic_rank,
       organic_page = excluded.organic_page,
       ad_rank = excluded.ad_rank,
       ad_page = excluded.ad_page,
       scan_depth = excluded.scan_depth,
       found = excluded.found,
       source = excluded.source,
       task_id = excluded.task_id`,
    [word, market, code, observedOn ?? today(), observedAt ?? nowIso(),
      rank, toNumberOrNull(organicPage),
      toNumberOrNull(adRank),
      toNumberOrNull(adPage),
      depth, found, source, taskId],
  )
  /* 明细写完之后，只重算这一个 (词, ASIN) 的汇总行 —— 一行主键更新，
    看板不用再在明细上跑窗口函数。 */
  refreshRankAnalysis(store, { keyword: word, marketplace: market, asin: code })
  return { keyword: word, marketplace: market, asin: code, found: found === 1 }
}

/** 一个 (词, ASIN) 的完整曲线，按日期升序。 */
export function rankSeries(store, { keyword, marketplace, asin, limit = 200 } = {}) {
  return store.all(
    `SELECT observed_on, observed_at, organic_rank, organic_page, ad_rank, ad_page,
            scan_depth, found, source
       FROM kw_rank_observation
      WHERE keyword = ? AND marketplace = ? AND asin = ?
      ORDER BY observed_on ASC
      LIMIT ?`,
    [String(keyword).trim().toLowerCase(), String(marketplace).toUpperCase(), String(asin).toUpperCase(), limit],
  )
}
/**
 * 每个 (词, ASIN) 的最近一次 vs 上一次 —— **读分析表**，不扫明细。
 *
 * 以前这里是 `ROW_NUMBER() OVER (PARTITION BY keyword, asin ORDER BY observed_on DESC)`
 * 扫整张明细；词一多、周数一长，看板每次都全表扫。现在一行一个 (词, ASIN)，
 * 主键查询直接出结果，明细表只留给曲线与复盘。
 */
export function rankChanges(store, { marketplace = null, asin = null, limit = 500 } = {}) {
  const where = []
  const params = []
  if (marketplace !== null) { where.push('marketplace = ?'); params.push(String(marketplace).toUpperCase()) }
  if (asin !== null) { where.push('asin = ?'); params.push(String(asin).toUpperCase()) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  return store.all(
    `SELECT keyword, asin, latest_on, latest_rank, prev_on, prev_rank, delta, verdict,
            best_rank, best_on, observed_days, ranked_days, missing_streak, avg_rank_4, scan_depth
       FROM kw_rank_analysis
       ${whereSql}
      ORDER BY (latest_rank IS NULL), latest_rank ASC
      LIMIT ?`,
    [...params, limit],
  ).map(row => ({
    keyword: row.keyword,
    asin: row.asin,
    latestOn: row.latest_on,
    latestRank: row.latest_rank,
    previousOn: row.prev_on,
    previousRank: row.prev_rank,
    delta: row.delta,
    verdict: row.verdict,
    bestRank: row.best_rank,
    bestOn: row.best_on,
    observedDays: row.observed_days,
    rankedDays: row.ranked_days,
    missingStreak: row.missing_streak,
    avgRank4: row.avg_rank_4,
    scanDepth: row.scan_depth,
  }))
}

/** 一句话结论，工具与页面共用。 */
export const VERDICT_MEANING = {
  up: '名次上升',
  down: '名次下降',
  new: '新进榜（上一次没进扫描深度）',
  lost: '掉出榜（这次没进扫描深度）',
  flat: '名次未变',
  'missing-both': '两次都没进榜',
  first: '只有一次观测，还谈不上变化',
}

/* ──────────────────── 分析表：词 + ASIN 一行 ──────────────────── */

/**
 * 从明细序列算一条分析记录。**纯函数**，不碰数据库 —— 这样规则能单独测。
 *
 * @param {Array} series 按 observed_on 升序的明细行
 */
export function computeAnalysis(series = []) {
  const rows = Array.isArray(series) ? series : []
  if (rows.length === 0) return null
  const latest = rows[rows.length - 1]
  const previous = rows.length >= 2 ? rows[rows.length - 2] : null
  const latestRank = Number(latest.found) === 1 ? Number(latest.organic_rank) : null
  const previousRank = previous !== null && Number(previous.found) === 1 ? Number(previous.organic_rank) : null

  let verdict = 'first'
  let delta = null
  if (previous === null) verdict = 'first'
  else if (latestRank === null && previousRank === null) verdict = 'missing-both'
  else if (latestRank === null) verdict = 'lost'
  else if (previousRank === null) verdict = 'new'
  else {
    delta = previousRank - latestRank
    verdict = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
  }

  const ranked = rows.filter(row => Number(row.found) === 1 && Number.isFinite(Number(row.organic_rank)))
  const best = ranked.reduce((acc, row) => (acc === null || Number(row.organic_rank) < acc.rank
    ? { rank: Number(row.organic_rank), on: row.observed_on }
    : acc), null)

  /* 连续未进榜次数：从最后一行往回数，遇到一次「进榜」就停。 */
  let missingStreak = 0
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (Number(rows[index].found) === 1) break
    missingStreak += 1
  }

  const lastFour = ranked.slice(-4)
  const avgRank4 = lastFour.length === 0
    ? null
    : Math.round(lastFour.reduce((sum, row) => sum + Number(row.organic_rank), 0) / lastFour.length)

  return {
    latestOn: latest.observed_on ?? null,
    latestRank,
    latestFound: Number(latest.found) === 1 ? 1 : 0,
    prevOn: previous?.observed_on ?? null,
    prevRank: previousRank,
    delta,
    verdict,
    bestRank: best?.rank ?? null,
    bestOn: best?.on ?? null,
    observedDays: rows.length,
    rankedDays: ranked.length,
    missingStreak,
    avgRank4,
    scanDepth: latest.scan_depth ?? null,
  }
}

/** 重算一个 (词, ASIN) 的分析行。写入观测之后调用 —— 只重算这一行。 */
export function refreshRankAnalysis(store, { keyword, marketplace, asin } = {}) {
  const word = String(keyword ?? '').trim().toLowerCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  const code = String(asin ?? '').trim().toUpperCase()
  if (word === '' || market === '' || code === '') return null

  const series = store.all(
    `SELECT observed_on, organic_rank, found, scan_depth
       FROM kw_rank_observation
      WHERE keyword = ? AND marketplace = ? AND asin = ?
      ORDER BY observed_on ASC`,
    [word, market, code],
  )
  const analysis = computeAnalysis(series)
  if (analysis === null) {
    store.run('DELETE FROM kw_rank_analysis WHERE keyword = ? AND marketplace = ? AND asin = ?', [word, market, code])
    return null
  }

  store.run(
    `INSERT INTO kw_rank_analysis
       (asin, marketplace, keyword, latest_on, latest_rank, latest_found, prev_on, prev_rank, delta,
        verdict, best_rank, best_on, observed_days, ranked_days, missing_streak, avg_rank_4,
        scan_depth, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asin, marketplace, keyword) DO UPDATE SET
       latest_on = excluded.latest_on, latest_rank = excluded.latest_rank,
       latest_found = excluded.latest_found, prev_on = excluded.prev_on, prev_rank = excluded.prev_rank,
       delta = excluded.delta, verdict = excluded.verdict, best_rank = excluded.best_rank,
       best_on = excluded.best_on, observed_days = excluded.observed_days,
       ranked_days = excluded.ranked_days, missing_streak = excluded.missing_streak,
       avg_rank_4 = excluded.avg_rank_4, scan_depth = excluded.scan_depth,
       updated_at = excluded.updated_at`,
    [code, market, word, analysis.latestOn, analysis.latestRank, analysis.latestFound,
      analysis.prevOn, analysis.prevRank, analysis.delta, analysis.verdict,
      analysis.bestRank, analysis.bestOn, analysis.observedDays, analysis.rankedDays,
      analysis.missingStreak, analysis.avgRank4, analysis.scanDepth, nowIso()],
  )
  return analysis
}

/**
 * 全量重建分析表。用于迁移后补数据，或明细被手工改动之后。
 * 返回重建的行数。
 */
export function rebuildRankAnalysis(store, { marketplace = null } = {}) {
  const where = marketplace === null ? '' : 'WHERE marketplace = ?'
  const params = marketplace === null ? [] : [String(marketplace).toUpperCase()]
  const keys = store.all(
    `SELECT DISTINCT keyword, marketplace, asin FROM kw_rank_observation ${where}`,
    params,
  )
  let rows = 0
  for (const key of keys) {
    if (refreshRankAnalysis(store, key) !== null) rows += 1
  }
  return { keys: keys.length, rows }
}
