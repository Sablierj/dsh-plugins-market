/**
 * 读写语句集中在这里：页面、工具、同步三条路都调同一份，口径不会分叉。
 * 所有时序表一律 `ON CONFLICT … DO UPDATE` —— 重抓覆盖，绝不累加。
 */
import { nowIso } from './time.js'

export function upsertObject(store, { marketplace, asin, label = 'mine', note = null }) {
  store.run(
    `INSERT INTO sif_object (marketplace, asin, label, note, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (marketplace, asin) DO UPDATE SET label = excluded.label, note = COALESCE(excluded.note, sif_object.note)`,
    [marketplace, asin, label, note, nowIso()],
  )
  return getObject(store, marketplace, asin)
}

export function getObject(store, marketplace, asin) {
  return store.get('SELECT * FROM sif_object WHERE marketplace = ? AND asin = ?', [marketplace, asin]) ?? null
}

export function deleteObject(store, marketplace, asin) {
  const result = store.run('DELETE FROM sif_object WHERE marketplace = ? AND asin = ?', [marketplace, asin])
  return result.changes > 0
}

/** 对象清单 + 每个对象的「最后同步 / 数据截止 / 行数」，页面直接画。 */
export function listObjects(store, marketplace) {
  return store.all(
    `SELECT o.marketplace, o.asin, o.label, o.note, o.created_at,
            a.title, a.price, a.star_rating, a.rating_num, a.first_available_day,
            (SELECT MAX(t.fetched_at)  FROM sif_traffic t WHERE t.marketplace = o.marketplace AND t.asin = o.asin) AS last_sync,
            (SELECT MAX(t.period_start) FROM sif_traffic t WHERE t.marketplace = o.marketplace AND t.asin = o.asin) AS last_period,
            (SELECT MAX(t.data_date)   FROM sif_traffic t WHERE t.marketplace = o.marketplace AND t.asin = o.asin) AS last_data_date,
            (SELECT COUNT(*)           FROM sif_traffic t WHERE t.marketplace = o.marketplace AND t.asin = o.asin) AS traffic_rows
     FROM sif_object o
     LEFT JOIN sif_asin a ON a.marketplace = o.marketplace AND a.asin = o.asin
     WHERE o.marketplace = ?
     ORDER BY o.created_at`,
    [marketplace],
  )
}

export function upsertAsin(store, marketplace, profile, { dataDate = null, observedAt = nowIso() } = {}) {
  const bsr = Array.isArray(profile.bsr_list) && profile.bsr_list.length ? profile.bsr_list[0] : null
  store.run(
    `INSERT INTO sif_asin (marketplace, asin, title, brand, price, star_rating, rating_num, bsr_rank, bsr_category,
                           first_available_day, variation_num, color, size, weight_oz, package_dims_json,
                           feature_list_json, item_highlights, bullets_json, observed_at, data_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (marketplace, asin) DO UPDATE SET
       title = excluded.title, brand = excluded.brand, price = excluded.price,
       star_rating = excluded.star_rating, rating_num = excluded.rating_num,
       bsr_rank = excluded.bsr_rank, bsr_category = excluded.bsr_category,
       first_available_day = excluded.first_available_day, variation_num = excluded.variation_num,
       color = excluded.color, size = excluded.size, weight_oz = excluded.weight_oz,
       package_dims_json = excluded.package_dims_json, feature_list_json = excluded.feature_list_json,
       item_highlights = excluded.item_highlights, bullets_json = excluded.bullets_json,
       observed_at = excluded.observed_at, data_date = excluded.data_date`,
    [
      marketplace, profile.asin, profile.title ?? null, profile.brand ?? null, profile.price ?? null,
      profile.star_rating ?? null, profile.rating_num ?? null,
      bsr?.rank ?? null, bsr?.category_name ?? null,
      profile.first_available_day ?? null, profile.variation_num ?? null,
      profile.color ?? null, profile.size ?? null, profile.weight_oz ?? null,
      JSON.stringify(profile.package_dims_in ?? null), JSON.stringify(profile.feature_list ?? null),
      profile.item_highlights ?? null,
      // SIF 的 feature_descriptions 就是五点/特性描述（最多 6 条），存成 JSON 数组
      JSON.stringify(Array.isArray(profile.feature_descriptions) ? profile.feature_descriptions : null),
      observedAt, dataDate,
    ],
  )
}

/** 一行 = (ASIN, 口径, 周期类型, 周期首日)。重抓同一周就覆盖。 */
export function upsertTraffic(store, row) {
  store.run(
    `INSERT INTO sif_traffic (marketplace, asin, scope, period_type, period_start,
       total_score, nf_score, ad_score, sp_score, rec_sp_score, sb_score, sbv_score,
       total_change, total_change_ratio, nf_ratio, ad_ratio,
       price, bsr_rank, star_rating, review_num, is_complete, tool, fetched_at, data_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (marketplace, asin, scope, period_type, period_start) DO UPDATE SET
       total_score = excluded.total_score, nf_score = excluded.nf_score, ad_score = excluded.ad_score,
       sp_score = excluded.sp_score, rec_sp_score = excluded.rec_sp_score,
       sb_score = excluded.sb_score, sbv_score = excluded.sbv_score,
       total_change = excluded.total_change, total_change_ratio = excluded.total_change_ratio,
       nf_ratio = excluded.nf_ratio, ad_ratio = excluded.ad_ratio,
       price = excluded.price, bsr_rank = excluded.bsr_rank,
       star_rating = excluded.star_rating, review_num = excluded.review_num,
       is_complete = excluded.is_complete, tool = excluded.tool,
       fetched_at = excluded.fetched_at, data_date = excluded.data_date`,
    [
      row.marketplace, row.asin, row.scope ?? 'listing', row.periodType, row.periodStart,
      row.totalScore ?? null, row.nfScore ?? null, row.adScore ?? null, row.spScore ?? null,
      row.recSpScore ?? null, row.sbScore ?? null, row.sbvScore ?? null,
      row.totalChange ?? null, row.totalChangeRatio ?? null, row.nfRatio ?? null, row.adRatio ?? null,
      row.price ?? null, row.bsr ?? null, row.star ?? null, row.review ?? null,
      row.isComplete ?? null, row.tool, row.fetchedAt ?? nowIso(), row.dataDate ?? null,
    ],
  )
}

export function upsertListingOverview(store, row) {
  store.run(
    `INSERT INTO sif_listing_overview (marketplace, asin, window_type, window_value, total_score, nf_ratio, ad_ratio, payload_json, data_date, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (marketplace, asin, window_type, window_value) DO UPDATE SET
       total_score = excluded.total_score, nf_ratio = excluded.nf_ratio, ad_ratio = excluded.ad_ratio,
       payload_json = excluded.payload_json, data_date = excluded.data_date, fetched_at = excluded.fetched_at`,
    [
      row.marketplace, row.asin, row.windowType, row.windowValue,
      row.totalScore ?? null, row.nfRatio ?? null, row.adRatio ?? null,
      JSON.stringify(row.payload ?? {}), row.dataDate ?? null, row.fetchedAt ?? nowIso(),
    ],
  )
}

// ── 运维表 ────────────────────────────────────────────────
export function insertRaw(store, { tool, params, hash, dataDate, cost, ok, response }) {
  store.run(
    `INSERT INTO sif_raw (tool, params_json, params_hash, data_date, cost_points, ok, response_json, fetched_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [tool, JSON.stringify(params ?? {}), hash, dataDate ?? null, cost ?? null, ok ? 1 : 0,
      JSON.stringify(response ?? null), nowIso()],
  )
}

/** 同一个 hash 在 windowMs 内抓过就复用（SIF 一天一更，6 小时足够）。 */
export function recentRaw(store, hash, windowMs = 6 * 3600_000) {
  const row = store.get(
    'SELECT * FROM sif_raw WHERE params_hash = ? AND ok = 1 ORDER BY fetched_at DESC LIMIT 1', [hash])
  if (!row) return null
  const age = Date.now() - Date.parse(row.fetched_at)
  if (!Number.isFinite(age) || age > windowMs) return null
  try {
    return { ...row, response: JSON.parse(row.response_json) }
  } catch {
    return null
  }
}

export function logQuota(store, tool, payload) {
  const quota = payload?._quota
  if (!quota) return
  const scopes = Array.isArray(quota.scopes) ? quota.scopes : []
  const scope = scopes[0] ?? null
  store.run(
    'INSERT INTO sif_quota_log (tool, cost_this_call, remaining, period_start, period_end, recorded_at) VALUES (?,?,?,?,?,?)',
    [tool, quota.costThisCall ?? null, quota.remainingTotal ?? null, scope?.periodStart ?? null, scope?.periodEnd ?? null, nowIso()],
  )
}

export function startRun(store, { level, tool, params, objects }) {
  const result = store.run(
    `INSERT INTO sif_sync_run (level, tool, params_json, params_hash, objects_json, cost_points, rows_written, status, started_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [level, tool, JSON.stringify(params ?? {}), hashOf(tool, params), JSON.stringify(objects ?? []), 0, 0, 'running', nowIso()],
  )
  return Number(result.lastInsertRowid)
}

export function finishRun(store, runId, { cost = 0, rows = 0, status = 'ok', error = null } = {}) {
  store.run(
    'UPDATE sif_sync_run SET cost_points = ?, rows_written = ?, status = ?, error = ?, ended_at = ? WHERE id = ?',
    [cost, rows, status, error, nowIso(), runId],
  )
}

export function spentToday(store) {
  const row = store.get(
    `SELECT COALESCE(SUM(cost_points), 0) AS spent FROM sif_sync_run WHERE date(started_at) = date('now')`)
  return Number(row?.spent ?? 0)
}

export function trafficSeries(store, marketplace, asin, { limit = 12 } = {}) {
  return store.all(
    `SELECT period_start, total_score, nf_score, ad_score, nf_ratio, ad_ratio, total_change_ratio, data_date, is_complete
     FROM sif_traffic WHERE marketplace = ? AND asin = ? AND period_type = 'week'
     ORDER BY period_start DESC LIMIT ?`, [marketplace, asin, limit])
}

export function counts(store) {
  const one = sql => Number(store.get(sql)?.n ?? 0)
  return {
    objects: one('SELECT COUNT(*) AS n FROM sif_object'),
    trafficRows: one('SELECT COUNT(*) AS n FROM sif_traffic'),
    keywordRows: one('SELECT COUNT(*) AS n FROM sif_asin_keyword'),
    abaRows: one('SELECT COUNT(*) AS n FROM sif_keyword_aba'),
    adRows: one('SELECT COUNT(*) AS n FROM sif_ad_campaign'),
    runs: one('SELECT COUNT(*) AS n FROM sif_sync_run'),
    rawRows: one('SELECT COUNT(*) AS n FROM sif_raw'),
  }
}

/** 参数哈希：缓存与「同一次查询」判定都用它。 */
export function hashOf(tool, params) {
  const stable = JSON.stringify(sortKeys(params ?? {}))
  let h = 0x811c9dc5
  const text = `${tool}|${stable}`
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

// ── M4-L2：关键词 / 广告结构 / 销量 ──────────────────────────
export function upsertAsinKeyword(store, row) {
  store.run(
    `INSERT INTO sif_asin_keyword (marketplace, asin, keyword, period_type, period_value,
       traffic_share, contri_change, contri_severity, organic_page, organic_pos, organic_total, organic_rank_raw,
       sp_rank, sb_rank, rank_evolution, gap_severity, keyword_health, traffic_dependency,
       channel_coverage_json, keyword_tags_json, fetched_at, data_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (marketplace, asin, keyword, period_type, period_value) DO UPDATE SET
       traffic_share = excluded.traffic_share, contri_change = excluded.contri_change,
       contri_severity = excluded.contri_severity,
       organic_page = excluded.organic_page, organic_pos = excluded.organic_pos,
       organic_total = excluded.organic_total, organic_rank_raw = excluded.organic_rank_raw,
       sp_rank = excluded.sp_rank, sb_rank = excluded.sb_rank,
       rank_evolution = excluded.rank_evolution, gap_severity = excluded.gap_severity,
       keyword_health = excluded.keyword_health, traffic_dependency = excluded.traffic_dependency,
       channel_coverage_json = excluded.channel_coverage_json, keyword_tags_json = excluded.keyword_tags_json,
       fetched_at = excluded.fetched_at, data_date = excluded.data_date`,
    [
      row.marketplace, row.asin, row.keyword, row.periodType ?? 'lately', row.periodValue,
      row.trafficShare ?? null, row.contriChange ?? null, row.contriSeverity ?? null,
      row.organicPage ?? null, row.organicPos ?? null, row.organicTotal ?? null, row.organicRaw ?? null,
      row.spRank ?? null, row.sbRank ?? null, row.rankEvolution ?? null, row.gapSeverity ?? null,
      row.keywordHealth ?? null, row.trafficDependency ?? null,
      JSON.stringify(row.channelCoverage ?? null), JSON.stringify(row.keywordTags ?? null),
      row.fetchedAt ?? nowIso(), row.dataDate ?? null,
    ],
  )
}

export function upsertAdSummary(store, row) {
  store.run(
    `INSERT INTO sif_ad_summary (marketplace, asin, observed_at, sp_count, sb_count, sbv_count, total_count, structure_scope, data_date)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (marketplace, asin, observed_at) DO UPDATE SET
       sp_count = excluded.sp_count, sb_count = excluded.sb_count, sbv_count = excluded.sbv_count,
       total_count = excluded.total_count, structure_scope = excluded.structure_scope, data_date = excluded.data_date`,
    [row.marketplace, row.asin, row.observedAt ?? nowIso(), row.spCount ?? null, row.sbCount ?? null,
      row.sbvCount ?? null, row.totalCount ?? null, row.structureScope ?? null, row.dataDate ?? null],
  )
}

export function upsertSalesMonth(store, row) {
  store.run(
    `INSERT INTO sif_sales_month (marketplace, asin, month, bought, bought_band, bought_lower, is_parent, fetched_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT (marketplace, asin, month, is_parent) DO UPDATE SET
       bought = excluded.bought, bought_band = excluded.bought_band, bought_lower = excluded.bought_lower,
       fetched_at = excluded.fetched_at`,
    [row.marketplace, row.asin, row.month, row.bought ?? null, row.band ?? null, row.lower ?? null,
      row.isParent ? 1 : 0, nowIso()],
  )
}

// ── M5：洞察（可重算，open 的按 ASIN 整体替换）──────────────
export function replaceInsights(store, { marketplace, asin, insights }) {
  store.tx(() => {
    store.run(
      `DELETE FROM sif_insight WHERE marketplace = ? AND asin = ? AND state = 'open'`, [marketplace, asin])
    const insert = store.raw.prepare(
      `INSERT INTO sif_insight (marketplace, asin, keyword, kind, severity, title, evidence_json, suggestion, computed_at, state)
       VALUES (?,?,?,?,?,?,?,?,?, 'open')`)
    for (const item of insights) {
      insert.run(marketplace, asin, item.keyword ?? null, item.kind, item.severity, item.title,
        JSON.stringify(item.evidence ?? {}), item.suggestion ?? null, nowIso())
    }
  })
  return listInsights(store, { marketplace, asin })
}

export function listInsights(store, { marketplace, asin = null } = {}) {
  const args = [marketplace]
  let where = 'marketplace = ? AND state = \'open\''
  if (asin) {
    where += ' AND asin = ?'
    args.push(asin)
  }
  return store.all(
    `SELECT id, marketplace, asin, keyword, kind, severity, title, evidence_json, suggestion, computed_at
     FROM sif_insight WHERE ${where}
     ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id`, args)
}

// ── M7：报告 ────────────────────────────────────────────────
export function saveReport(store, row) {
  const result = store.run(
    `INSERT INTO sif_report (marketplace, asin, kind, title, markdown, range_from, range_to, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [row.marketplace, row.asin ?? null, row.kind, row.title, row.markdown,
      row.rangeFrom ?? null, row.rangeTo ?? null, nowIso()],
  )
  return { id: Number(result.lastInsertRowid), ...row }
}

export function listReports(store, { marketplace, asin = null, limit = 20 } = {}) {
  const args = [marketplace]
  let where = 'marketplace = ?'
  if (asin) {
    where += ' AND asin = ?'
    args.push(asin)
  }
  args.push(limit)
  return store.all(
    `SELECT id, asin, kind, title, range_from, range_to, created_at, length(markdown) AS chars
     FROM sif_report WHERE ${where} ORDER BY id DESC LIMIT ?`, args)
}

export function getReport(store, id) {
  return store.get('SELECT * FROM sif_report WHERE id = ?', [Number(id)]) ?? null
}

// ── 素材补录（主图 / A+ / 评论主题）────────────────────────
export function upsertAsset(store, row) {
  store.run(
    `INSERT INTO sif_listing_asset (marketplace, asin, images_total, has_white_bg, min_px_ok, has_video, aplus, review_themes, notes, source, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (marketplace, asin) DO UPDATE SET
       images_total = COALESCE(excluded.images_total, sif_listing_asset.images_total),
       has_white_bg = COALESCE(excluded.has_white_bg, sif_listing_asset.has_white_bg),
       min_px_ok = COALESCE(excluded.min_px_ok, sif_listing_asset.min_px_ok),
       has_video = COALESCE(excluded.has_video, sif_listing_asset.has_video),
       aplus = COALESCE(excluded.aplus, sif_listing_asset.aplus),
       review_themes = COALESCE(excluded.review_themes, sif_listing_asset.review_themes),
       notes = COALESCE(excluded.notes, sif_listing_asset.notes),
       source = excluded.source, updated_at = excluded.updated_at`,
    [
      row.marketplace, row.asin, int(row.imagesTotal), bool(row.hasWhiteBg), bool(row.minPxOk),
      bool(row.hasVideo), bool(row.aplus), row.reviewThemes ?? null, row.notes ?? null,
      row.source ?? 'manual', nowIso(),
    ],
  )
  return getAsset(store, row.marketplace, row.asin)
}

export function getAsset(store, marketplace, asin) {
  const row = store.get('SELECT * FROM sif_listing_asset WHERE marketplace = ? AND asin = ?', [marketplace, asin])
  if (!row) return null
  return {
    imagesTotal: row.images_total,
    hasWhiteBg: row.has_white_bg === null ? null : row.has_white_bg === 1,
    minPxOk: row.min_px_ok === null ? null : row.min_px_ok === 1,
    hasVideo: row.has_video === null ? null : row.has_video === 1,
    aplus: row.aplus === null ? null : row.aplus === 1,
    reviewThemes: row.review_themes,
    notes: row.notes,
    source: row.source,
    updatedAt: row.updated_at,
  }
}

function int(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

export function removeAsset(store, marketplace, asin) {
  const result = store.run('DELETE FROM sif_listing_asset WHERE marketplace = ? AND asin = ?', [marketplace, asin])
  return result.changes > 0
}

function bool(value) {
  if (value === undefined || value === null || value === '') return null
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0
}
