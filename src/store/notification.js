/**
 * `notification` — the workbench's own alert list (F01-07).
 *
 * ## De-duplication is the unique index, not a check
 *
 * `dedupe_key` carries a UNIQUE index and the writer is an upsert against it.
 * The tempting alternative — `SELECT` for a row with this key, then `INSERT` if
 * it is missing — is wrong in a way that only shows up when two triggers land
 * close together: both reads miss, both inserts run, and the second one throws
 * against the index (best case) or the list has two copies of the same alert
 * (if the index were absent). The upsert is one statement and there is no
 * window between the look and the write.
 *
 * ## Re-seeing something is not the same as changing it
 *
 * A notification that fires again increments `count` and **clears `read_at`**.
 * Repeating an alert is new evidence: the condition is still true, and a reader
 * who marked the last one read should see it come back rather than watch the
 * count climb on something already dismissed. The text and the link are
 * refreshed too — the newest statement of the problem is the one worth showing.
 *
 * ## `read_at` rather than a boolean
 *
 * "It is read" and "it was read on the 3rd" cost the same column, and only the
 * second can be read later. There is no `is_read` beside it, because two
 * columns that can disagree will.
 *
 * ## Why the 30-day purge is not a migration
 *
 * A migration runs **once**, on upgrade, so a purge inside v29 would only ever
 * clear the rows present on the day somebody upgraded — the list would grow
 * forever after that. It runs on every open instead (see `index.js`), which is
 * what "keep 30 days" actually means.
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'

/** The three levels, worst last in the sort. Same vocabulary as an audit issue. */
export const NOTIFICATION_SEVERITIES = ['info', 'warn', 'block']

/** The default retention window, in days. */
export const KEEP_DAYS = 30

/**
 * Record one notification, de-duplicated by `dedupeKey`.
 *
 * Returns `{ id, created, count, reopened }` — `reopened` is what tells a caller
 * that a row the reader had already dismissed has come back, which is a
 * different thing to report than a brand-new one.
 */
export function upsertNotification(store, record = {}) {
  const dedupeKey = String(record.dedupeKey ?? '').trim()
  const kind = String(record.kind ?? '').trim()
  const title = String(record.title ?? '').trim()
  if (dedupeKey === '') throw new Error('dedupeKey is required')
  if (kind === '') throw new Error('kind is required')
  if (title === '') throw new Error('title is required')

  const severity = record.severity === undefined || record.severity === null
    ? null
    : String(record.severity)
  if (severity !== null && !NOTIFICATION_SEVERITIES.includes(severity)) {
    throw new Error(`severity must be one of: ${NOTIFICATION_SEVERITIES.join(' | ')} (got ${JSON.stringify(record.severity)})`)
  }

  const now = nowIso()
  const existing = store.get('SELECT id, count, read_at FROM notification WHERE dedupe_key = ?', [dedupeKey])

  if (existing === undefined) {
    const id = `notif-${randomUUID()}`
    store.run(
      `INSERT INTO notification
         (id, kind, dedupe_key, title, body, severity, object_type, object_id, link,
          count, read_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [
        id, kind, dedupeKey, title,
        optional(record.body), severity,
        optional(record.objectType), optional(record.objectId), optional(record.link),
        now, now,
      ],
    )
    return { id, created: true, count: 1, reopened: false }
  }

  store.run(
    `UPDATE notification
        SET count = count + 1,
            read_at = NULL,
            title = ?, body = ?, severity = ?, object_type = ?, object_id = ?, link = ?,
            updated_at = ?
      WHERE id = ?`,
    [
      title, optional(record.body), severity,
      optional(record.objectType), optional(record.objectId), optional(record.link),
      now, existing.id,
    ],
  )
  return {
    id: existing.id,
    created: false,
    count: Number(existing.count) + 1,
    reopened: existing.read_at !== null,
  }
}

/** `undefined` keeps nothing here — the row is whole, so absent means absent. */
function optional(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** Worst first, then newest: a block is why you opened the panel. */
const SEVERITY_RANK = { block: 0, warn: 1, info: 2 }

export function listNotifications(store, { kind, unreadOnly = false, limit = 50 } = {}) {
  const clauses = []
  const params = []
  if (kind !== undefined && kind !== null && String(kind).trim() !== '') {
    clauses.push('kind = ?')
    params.push(String(kind).trim())
  }
  if (unreadOnly === true) clauses.push('read_at IS NULL')
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  const rows = store.all(
    `SELECT * FROM notification${where} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit],
  )
  return rows
    .map(row => ({
      id: row.id,
      kind: row.kind,
      dedupeKey: row.dedupe_key,
      title: row.title,
      body: row.body,
      severity: row.severity,
      objectType: row.object_type,
      objectId: row.object_id,
      link: row.link,
      count: Number(row.count),
      readAt: row.read_at,
      unread: row.read_at === null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    .sort((a, b) => {
      const rank = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
      if (rank !== 0) return rank
      return String(b.createdAt) > String(a.createdAt) ? 1 : -1
    })
}

export function unreadCount(store) {
  return Number(store.get('SELECT COUNT(*) AS n FROM notification WHERE read_at IS NULL').n)
}

/** Per-kind totals and unread counts — the panel's group headers. */
export function countsByKind(store) {
  return store.all(
    `SELECT kind,
            COUNT(*) AS total,
            SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread
       FROM notification GROUP BY kind ORDER BY kind`,
  ).map(row => ({ kind: row.kind, total: Number(row.total), unread: Number(row.unread) }))
}

/** Mark one read. Returns how many rows changed (0 means it was already read). */
export function markRead(store, id) {
  const key = String(id ?? '').trim()
  if (key === '') throw new Error('id is required')
  const before = store.get('SELECT read_at FROM notification WHERE id = ?', [key])
  if (before === undefined) return { ok: false, code: 'NOTIFICATION_NOT_FOUND', error: `no notification "${key}"` }
  if (before.read_at !== null) return { ok: true, changed: false, readAt: before.read_at }
  const at = nowIso()
  store.run('UPDATE notification SET read_at = ?, updated_at = ? WHERE id = ?', [at, at, key])
  return { ok: true, changed: true, readAt: at }
}

export function markAllRead(store) {
  const at = nowIso()
  const before = unreadCount(store)
  store.run('UPDATE notification SET read_at = ?, updated_at = ? WHERE read_at IS NULL', [at, at])
  return { changed: before, readAt: at }
}

/**
 * Delete one kind.
 *
 * Returns the count so the caller can say what happened — "cleared 4" and
 * "there was nothing of that kind" are different answers, and a silent success
 * for the second is how a user concludes the button is broken.
 */
export function clearByKind(store, kind) {
  const key = String(kind ?? '').trim()
  if (key === '') throw new Error('kind is required')
  const before = Number(store.get('SELECT COUNT(*) AS n FROM notification WHERE kind = ?', [key]).n)
  if (before > 0) store.run('DELETE FROM notification WHERE kind = ?', [key])
  return { kind: key, removed: before }
}

/**
 * Drop everything older than `keepDays`.
 *
 * Age is measured from `created_at`, not `updated_at`: a notification that keeps
 * re-firing is re-created in spirit, and its `count` and cleared `read_at` say
 * so — but its age is still how long ago the condition first appeared, and a
 * permanently-firing alert should not be immortal for that reason.
 * Idempotent, so it is safe on every open.
 */
export function purgeNotifications(store, { keepDays = KEEP_DAYS } = {}) {
  const days = Number(keepDays)
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`keepDays must be a positive number (got ${JSON.stringify(keepDays)})`)
  }
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const before = Number(store.get('SELECT COUNT(*) AS n FROM notification').n)
  store.run('DELETE FROM notification WHERE created_at < ?', [cutoff])
  const after = Number(store.get('SELECT COUNT(*) AS n FROM notification').n)
  return { removed: before - after, keepDays: days, cutoff }
}

/** What the page slice gets. `filters.notificationKind` narrows the list. */
export function notificationView(store, filters = {}) {
  const kind = String(filters.notificationKind ?? '').trim()
  return {
    rows: listNotifications(store, { kind: kind === '' ? undefined : kind }),
    unread: unreadCount(store),
    counts: countsByKind(store),
    keepDays: KEEP_DAYS,
    filters: { kind },
  }
}
