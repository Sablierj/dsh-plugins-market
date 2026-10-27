/**
 * `field_conflict`: the one place a conflict row is written.
 *
 * The object this table records is "these sources disagree about this field, and
 * a human has to decide". Its whole reason to exist is the sentence the batch is
 * built around: **a conflict is never silently overwritten.** Adopting a value is
 * a decision recorded *beside* the sources, not a deletion of the sources that
 * lost — so `resolveConflict` writes `field_conflict` and **touches
 * `asin_field_source` not at all** (no delete, no update). The acceptance test
 * pins that: the source row count is identical before and after a resolve.
 *
 * ## One row per field, and detection is a refresh
 *
 * `UNIQUE(asin, marketplace, field)` means a field has one conflict, not one per
 * disagreeing pair. Re-detecting the same disagreement is a refresh of the
 * *suggestion*, not a new row and not a new `opened_at`: the timestamp is when
 * the disagreement was first seen, and re-detection is not a new event.
 *
 * ## Reopening, and the one case that must not
 *
 * A `resolved` / `accepted_risk` conflict reopens to `open` when **a source that
 * disagrees with the adopted value is written after the decision** — new
 * evidence, not a re-reading of the same evidence. The sources that lost are
 * never deleted, so a rule phrased as "the current values still contain a
 * non-adopted one" would reopen the conflict on the very next detection and a
 * decision could never stand. Re-writing the *same* value that was adopted is
 * therefore not a reopen either: the collector seeing the same number again must
 * not wake a conflict a human just settled. `resolved_at` / `resolved_by` are
 * left in place when reopening: the last decision stays readable, and `status`
 * is the authority.
 *
 * ## Not auto-closing
 *
 * When a field's sources stop disagreeing, this module does **nothing**. Auto-
 * closing would mark a conflict settled that nobody settled; if the disagreement
 * genuinely vanishes, a human closing it is the honest record.
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'
import {
  CONFLICT_STATUSES, CONFLICT_TRANSITIONS, detectConflicts, suggestResolution,
} from '../domain/data/conflict.js'

/* Re-exported so a reader of this module does not have to know the vocabulary
   lives in the domain layer — it is the same closed set either way. */
export { CONFLICT_STATUSES, CONFLICT_TRANSITIONS }

/** Human labels for the page. A status with no entry falls back to its own id. */
export const CONFLICT_STATUS_LABELS = {
  open: '待裁决',
  resolved: '已裁决',
  accepted_risk: '接受风险',
}

/** The machine codes this module returns. Kept together so callers can branch. */
export const CONFLICT_CODES = {
  NOT_FOUND: 'CONFLICT_NOT_FOUND',
  ILLEGAL_TRANSITION: 'CONFLICT_ILLEGAL_TRANSITION',
  VALUE_REQUIRED: 'CONFLICT_VALUE_REQUIRED',
  UNKNOWN_SOURCE: 'CONFLICT_UNKNOWN_SOURCE',
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/** DB row (snake_case) → the camelCase object the page, tool and tests agree on. */
function toConflict(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    asin: row.asin,
    marketplace: row.marketplace,
    field: row.field,
    status: row.status,
    statusLabel: CONFLICT_STATUS_LABELS[row.status] ?? row.status,
    adoptedValue: row.adopted_value ?? null,
    adoptedSourceId: row.adopted_source_id ?? null,
    suggestion: parseJson(row.suggestion_json, null),
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at ?? null,
    resolvedBy: row.resolved_by ?? null,
    note: row.note ?? null,
  }
}

/**
 * One field's sources, in the shape the pure module reads.
 *
 * `sourceId` / `sourceType` / `observedAt` are the camelCase names
 * `domain/data/conflict.js` compares on; the raw DB columns never leak past here.
 */
function readSources(store, { asin, marketplace, field }) {
  return store.all(
    `SELECT asin, marketplace, field, value, source_id, source_type, confidence, observed_at, updated_at
       FROM asin_field_source
      WHERE asin = ? AND marketplace = ? AND field = ?
      ORDER BY source_id ASC`,
    [asin, marketplace, field],
  ).map(row => ({
    asin: row.asin,
    marketplace: row.marketplace,
    field: row.field,
    value: row.value ?? null,
    sourceId: row.source_id,
    sourceType: row.source_type ?? null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    observedAt: row.observed_at ?? null,
    updatedAt: row.updated_at ?? null,
  }))
}

/**
 * Create, refresh, or reopen the one conflict row for a field.
 *
 * The three branches are the whole policy, and they are separated here rather
 * than folded into `refreshConflictsFor` so the rule is readable in one place:
 * new → open; already open → refresh the suggestion only (never move
 * `opened_at`); decided → reopen **only** when a value other than the adopted
 * one is now on the table.
 */
export function upsertConflict(store, descriptor, suggestion) {
  const asin = String(descriptor.asin ?? '').trim().toUpperCase()
  const marketplace = String(descriptor.marketplace ?? '').trim().toUpperCase()
  const field = String(descriptor.field ?? '').trim()
  const suggestionJson = suggestion === undefined || suggestion === null ? null : JSON.stringify(suggestion)

  const existing = store.get(
    'SELECT * FROM field_conflict WHERE asin = ? AND marketplace = ? AND field = ?',
    [asin, marketplace, field],
  )

  if (existing === undefined || existing === null) {
    const id = `conflict-${randomUUID()}`
    store.run(
      `INSERT INTO field_conflict
         (id, asin, marketplace, field, status, adopted_value, adopted_source_id,
          suggestion_json, opened_at, resolved_at, resolved_by, note)
       VALUES (?, ?, ?, ?, 'open', NULL, NULL, ?, ?, NULL, NULL, NULL)`,
      [id, asin, marketplace, field, suggestionJson, nowIso()],
    )
    return { id, created: true, reopened: false }
  }

  if (existing.status === 'open') {
    /* Re-detection is not a new event: the suggestion may improve, the opening
       time must not move. */
    store.run('UPDATE field_conflict SET suggestion_json = ? WHERE id = ?', [suggestionJson, existing.id])
    return { id: existing.id, created: false, reopened: false }
  }

  const adopted = existing.adopted_value ?? null
  const resolvedAt = existing.resolved_at ?? null
  /* New evidence means a source that *disagrees with the decision* and was
     written **after** it. A plain "the current values still contain something
     other than the adopted one" test would reopen the conflict on the very next
     detection, because the sources that lost are never deleted — a decision
     could never stand. So the comparison is against `resolved_at`: re-writing
     the adopted value (the collector seeing the same number again) is not new
     evidence, while a different value arriving after the decision is. */
  const hasNewEvidence = (descriptor.values ?? []).some(entry => {
    const value = entry.value ?? null
    if (value === adopted) return false
    const updatedAt = entry.updatedAt ?? null
    if (resolvedAt === null || updatedAt === null) return true
    return updatedAt > resolvedAt
  })
  if (!hasNewEvidence) {
    return { id: existing.id, created: false, reopened: false }
  }

  store.run(
    "UPDATE field_conflict SET status = 'open', suggestion_json = ? WHERE id = ?",
    [suggestionJson, existing.id],
  )
  return { id: existing.id, created: false, reopened: true }
}

/**
 * The single detection entry point, called from the two write paths that put a
 * value into `asin_field_source`.
 *
 * Returns counts rather than rows: the caller is a writer finishing its own
 * work, and the workbench reads the result through `conflictView`. A field with
 * fewer than two distinct values is skipped and **nothing is closed**.
 */
export function refreshConflictsFor(store, { asin, marketplace, fields } = {}) {
  const asinKey = String(asin ?? '').trim().toUpperCase()
  const marketplaceKey = String(marketplace ?? '').trim().toUpperCase()
  const list = fields === undefined || fields === null
    ? []
    : (Array.isArray(fields) ? fields : [fields])

  const result = { checked: 0, opened: 0, refreshed: 0, reopened: 0 }
  if (asinKey === '' || marketplaceKey === '') return result

  for (const rawField of list) {
    const field = String(rawField ?? '').trim()
    if (field === '') continue
    result.checked += 1

    const sources = readSources(store, { asin: asinKey, marketplace: marketplaceKey, field })
    const conflicts = detectConflicts(sources)
    /* Fewer than two distinct values: do nothing at all. Auto-closing would mark
       a conflict settled that nobody settled. */
    if (conflicts.length === 0) continue

    const outcome = upsertConflict(store, conflicts[0], suggestResolution(sources))
    if (outcome.created) result.opened += 1
    else if (outcome.reopened) result.reopened += 1
    else result.refreshed += 1
  }
  return result
}

/** One conflict by id, camelCased, or `null`. */
export function getConflict(store, id) {
  return toConflict(store.get('SELECT * FROM field_conflict WHERE id = ?', [String(id ?? '').trim()]))
}

/** The conflicts, filtered and ordered by status then most-recently-opened. */
export function listConflicts(store, filters = {}) {
  const where = []
  const params = []
  const add = (column, value, upper) => {
    const text = blankToNull(value)
    if (text === null) return
    where.push(`${column} = ?`)
    params.push(upper ? text.toUpperCase() : text)
  }
  add('status', filters.status, false)
  add('asin', filters.asin, true)
  add('marketplace', filters.marketplace, true)

  const rows = store.all(
    `SELECT * FROM field_conflict
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY status ASC, opened_at DESC`,
    params,
  )
  return rows.map(toConflict)
}

/**
 * Counts for the workbench header, from the one table.
 *
 * `total` is a plain row count; the three breakdowns are derived from the same
 * read rather than three queries that could disagree about scope.
 */
export function conflictStats(store) {
  const counts = { open: 0, resolved: 0, accepted_risk: 0 }
  let total = 0
  for (const row of store.all('SELECT status FROM field_conflict')) {
    total += 1
    if (row.status in counts) counts[row.status] += 1
  }
  return { ...counts, total }
}

/**
 * Resolve a conflict by adopting one value.
 *
 * Four refusals, each with its own code, and **none of them writes**: a missing
 * row, an edge the machine does not have, an empty adopted value, and a source
 * id that is not one of that field's sources (recording a source that does not
 * exist would make the trace a lie).
 *
 * On success it writes **only** `field_conflict`. The sources are untouched —
 * adopting a value is a choice recorded beside them, not a deletion of the ones
 * that lost.
 */
export function resolveConflict(store, { id, adoptedValue, adoptedSourceId = null, resolvedBy = null, note = null } = {}) {
  const key = String(id ?? '').trim()
  if (key === '') return { ok: false, code: CONFLICT_CODES.NOT_FOUND, error: 'id 为空，找不到要裁决的冲突' }

  const row = store.get('SELECT * FROM field_conflict WHERE id = ?', [key])
  if (row === undefined || row === null) {
    return { ok: false, code: CONFLICT_CODES.NOT_FOUND, error: `找不到冲突 ${key}` }
  }

  const allowed = CONFLICT_TRANSITIONS[row.status]
  if (allowed === undefined || !allowed.includes('resolved')) {
    return {
      ok: false,
      code: CONFLICT_CODES.ILLEGAL_TRANSITION,
      error: `非法迁移：${row.status} → resolved（允许的迁移见 domain/data/conflict.js 的 CONFLICT_TRANSITIONS）`,
    }
  }

  if (blankToNull(adoptedValue) === null) {
    return {
      ok: false,
      code: CONFLICT_CODES.VALUE_REQUIRED,
      error: `冲突 ${key} 必须给出 adoptedValue —— 采纳一个空值等于没裁决`,
    }
  }

  const sourceKey = blankToNull(adoptedSourceId)
  if (sourceKey !== null) {
    const known = store.get(
      `SELECT source_id FROM asin_field_source
        WHERE asin = ? AND marketplace = ? AND field = ? AND source_id = ?`,
      [row.asin, row.marketplace, row.field, sourceKey],
    )
    if (known === undefined || known === null) {
      return {
        ok: false,
        code: CONFLICT_CODES.UNKNOWN_SOURCE,
        error: `来源 ${sourceKey} 不是 ${row.asin}@${row.marketplace} 字段 ${row.field} 的来源，记下它会伪造溯源`,
      }
    }
  }

  const value = String(adoptedValue)
  store.run(
    `UPDATE field_conflict
        SET status = 'resolved', adopted_value = ?, adopted_source_id = ?, resolved_at = ?, resolved_by = ?, note = ?
      WHERE id = ?`,
    [value, sourceKey, nowIso(), blankToNull(resolvedBy), blankToNull(note), key],
  )

  return {
    ok: true,
    before: { status: row.status },
    after: { status: 'resolved', adoptedValue: value },
    conflict: getConflict(store, key),
  }
}

/**
 * Put a decided conflict back in front of a human.
 *
 * Only `resolved` / `accepted_risk` may reopen; anything else is refused with
 * the same code shape as `resolveConflict`. The decision's timestamp and author
 * are kept — the record of what was decided stays readable, and `status` is what
 * says whether it is still standing.
 */
export function reopenConflict(store, { id, reason = null } = {}) {
  const key = String(id ?? '').trim()
  if (key === '') return { ok: false, code: CONFLICT_CODES.NOT_FOUND, error: 'id 为空，找不到要重开的冲突' }

  const row = store.get('SELECT * FROM field_conflict WHERE id = ?', [key])
  if (row === undefined || row === null) {
    return { ok: false, code: CONFLICT_CODES.NOT_FOUND, error: `找不到冲突 ${key}` }
  }

  const allowed = CONFLICT_TRANSITIONS[row.status]
  if (allowed === undefined || !allowed.includes('open')) {
    return {
      ok: false,
      code: CONFLICT_CODES.ILLEGAL_TRANSITION,
      error: `非法迁移：${row.status} → open（允许的迁移见 domain/data/conflict.js 的 CONFLICT_TRANSITIONS）`,
    }
  }

  store.run(
    "UPDATE field_conflict SET status = 'open', note = COALESCE(?, note) WHERE id = ?",
    [blankToNull(reason), key],
  )
  return { ok: true, before: { status: row.status }, after: { status: 'open' }, conflict: getConflict(store, key) }
}

/**
 * The page's data slice.
 *
 * Each row is enriched with the **current** sources of its field, read live:
 * the conflict row records the decision, and the values it is a decision about
 * live in `asin_field_source`. Copying them into the conflict row would be a
 * second, drifting copy of the sources.
 */
export function conflictView(store, filters = {}) {
  const status = blankToNull(filters.conflictStatus)
  const asin = blankToNull(filters.conflictAsin)
  const rows = listConflicts(store, { status, asin })

  for (const row of rows) {
    row.values = readSources(store, { asin: row.asin, marketplace: row.marketplace, field: row.field })
  }

  return {
    rows,
    counts: conflictStats(store),
    filters: { status: status ?? '', asin: asin ?? '' },
  }
}
