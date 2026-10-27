/**
 * 扫描排班的存取。
 *
 * 排班是**人定的规则**，不是派生的数据：改了就是改了，不重算、不推断。
 * 唯一会被自动改写的是 `next_run_at` —— 每次跑完从「这次该跑的时间」往后推下一格，
 * 而不是从"现在"推 —— 否则每次延迟几秒，一年就漂走几分钟。
 */

import { nowIso } from './db.js'
import { computeNextRun, parseAtTime } from '../domain/keywords/schedule.js'

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(String(value))
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

/** 数据库行 → 领域对象。空数组与 null 分开保留。 */
export function rowToSchedule(row) {
  if (row === null || row === undefined) return null
  return {
    id: row.id,
    name: row.name,
    marketplace: row.marketplace,
    cadence: row.cadence,
    atTime: row.at_time,
    /* null = 「用监控清单」，[] = 「一个词都不扫」。两者不能混。 */
    weekdays: parseJson(row.weekdays_json, null),
    keywords: parseJson(row.keywords_json, null),
    asins: parseJson(row.asins_json, null),
    pages: Number(row.pages),
    enabled: Number(row.enabled) === 1,
    lastRunAt: row.last_run_at ?? null,
    lastTaskId: row.last_task_id ?? null,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listSchedules(store) {
  return store.all('SELECT * FROM kw_scan_schedule ORDER BY id').map(rowToSchedule)
}

export function getSchedule(store, id) {
  return rowToSchedule(store.get('SELECT * FROM kw_scan_schedule WHERE id = ?', [Number(id)]))
}

/**
 * 新建或修改一条排班。
 *
 * `nextRunAt` 由规则算出来，不接受调用方指定 —— 让调用方给时间就等于允许
 * 「规则说每天 9 点、实际下次跑 3 点」这种自相矛盾的行存在。
 */
export function saveSchedule(store, {
  id = null,
  name,
  marketplace = 'US',
  cadence,
  atTime,
  weekdays = null,
  keywords = null,
  asins = null,
  pages = 1,
  enabled = true,
  from = new Date(),
} = {}) {
  const at = parseAtTime(atTime)
  if (at === null) throw new Error(`atTime must be HH:MM, got ${JSON.stringify(atTime)}`)
  const next = computeNextRun({ cadence, atTime: at.text, weekdays: weekdays ?? [], from })
  if (next === null) {
    throw new Error('cannot compute the next run from this rule (weekly needs at least one weekday)')
  }
  const now = nowIso()
  const payload = [
    String(name ?? '').trim() || '未命名排班',
    String(marketplace).toUpperCase(),
    cadence,
    at.text,
    weekdays === null ? null : JSON.stringify(weekdays.map(Number)),
    keywords === null ? null : JSON.stringify(keywords.map(word => String(word).trim().toLowerCase())),
    asins === null ? null : JSON.stringify(asins.map(code => String(code).toUpperCase())),
    Math.max(1, Math.min(20, Math.trunc(Number(pages) || 1))),
    enabled ? 1 : 0,
    next.toISOString(),
    now,
    now,
  ]

  if (id === null || id === undefined) {
    const result = store.run(
      `INSERT INTO kw_scan_schedule
         (name, marketplace, cadence, at_time, weekdays_json, keywords_json, asins_json,
          pages, enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      payload,
    )
    return getSchedule(store, result.lastInsertRowid)
  }

  /* 改规则就重算下次时间 —— 但不动 last_run_at：那是一次真实发生过的运行记录。 */
  store.run(
    `UPDATE kw_scan_schedule SET
       name = ?, marketplace = ?, cadence = ?, at_time = ?, weekdays_json = ?, keywords_json = ?,
       asins_json = ?, pages = ?, enabled = ?, next_run_at = ?, updated_at = ?
     WHERE id = ?`,
    [...payload.slice(0, 10), now, Number(id)],
  )
  return getSchedule(store, id)
}

export function deleteSchedule(store, id) {
  const before = getSchedule(store, id)
  if (before === null) return null
  store.run('DELETE FROM kw_scan_schedule WHERE id = ?', [Number(id)])
  return before
}

/** 现在该跑的排班。只认 `next_run_at <= now` 且 enabled。 */
export function dueSchedules(store, now = new Date()) {
  return store.all(
    'SELECT * FROM kw_scan_schedule WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at',
    [now.toISOString()],
  ).map(rowToSchedule)
}

/**
 * 记一次运行，并把下次时间从**这次本该跑的时间**往后推。
 *
 * 从 `scheduledAt` 推而不是从 `now` 推：否则每天晚几秒，一年就漂出几分钟，
 * 最终「每天 09:00」会变成「每天 09:07」。
 */
export function markRun(store, { id, scheduledAt, taskId = null, now = new Date() }) {
  const schedule = getSchedule(store, id)
  if (schedule === null) return null
  const anchor = Date.parse(String(scheduledAt ?? schedule.nextRunAt))
  const next = computeNextRun({
    cadence: schedule.cadence,
    atTime: schedule.atTime,
    weekdays: schedule.weekdays ?? [],
    from: new Date(Number.isFinite(anchor) ? anchor : now.getTime()),
  })
  store.run(
    'UPDATE kw_scan_schedule SET last_run_at = ?, last_task_id = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
    [now.toISOString(), taskId, next === null ? schedule.nextRunAt : next.toISOString(), now.toISOString(), Number(id)],
  )
  return getSchedule(store, id)
}
