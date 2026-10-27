/**
 * `collection_task_event`: the append-only history of a collection task's status
 * (schema v36, module 04 F04-05).
 *
 * ## Append-only is a property of this file, not a habit
 *
 * The table was added together with `keyword_lifecycle_event`'s pattern: a status
 * is a decision made by a person, a plan or a timeout, and the history of those
 * decisions is evidence. Evidence that can be edited is not evidence. So this
 * module exports **no** update and no delete — its only write is the INSERT
 * below, and everything else in it is a read.
 *
 * That is why `from_status` is nullable: the first row for a task is written when
 * there was no prior status, and writing some initial state there would invent a
 * transition that never happened. `null` is the honest value, and readers must
 * treat it as "this is where the task started", not as a missing field.
 *
 * ## The vocabulary is checked, the edge is not
 *
 * `to_status` must be one of `COLLECTION_TASK_STATES` — an unknown state is a
 * typo, and a typo stored as history is a lie that survives forever. The
 * **legality of the edge** (`canTransitionCollectionTask`) is deliberately not
 * enforced here: this table records what happened, and refusing to record an
 * illegal move would hide it. The guard belongs on the write that moves the task
 * (`updateCollectionTask` / the service), which is where it is.
 */

import { randomUUID } from 'node:crypto'

import { COLLECTION_TASK_EVENT_SOURCES, COLLECTION_TASK_STATES } from '../domain/states.js'
import { nowIso } from './db.js'

const MAX_EVENTS = 1000

export function newTaskEventId() {
  return `cte-${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
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

function hydrate(row) {
  if (row === null || row === undefined) return null
  return {
    id: row.id,
    taskId: row.task_id,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status,
    reason: row.reason ?? null,
    source: row.source,
    evidence: parseJson(row.evidence_json, null),
    at: row.at,
    by: row.by ?? null,
  }
}

/**
 * Append one row. There is no other write path.
 *
 * `source` is required and closed: "who moved this" is half of what the history
 * is for, and a marker invented at a call site (`'auto'`, `'system'`) would
 * fragment the answer across spellings.
 */
export function appendTaskEvent(store, record = {}) {
  const taskId = blankToNull(record.taskId)
  if (taskId === null) throw new Error('taskId is required')

  const toStatus = String(record.toStatus ?? '').trim()
  if (!COLLECTION_TASK_STATES.includes(toStatus)) {
    throw new Error(`toStatus "${record.toStatus}" is not one of ${COLLECTION_TASK_STATES.join(' / ')}`)
  }
  const fromStatus = blankToNull(record.fromStatus)
  if (fromStatus !== null && !COLLECTION_TASK_STATES.includes(fromStatus)) {
    throw new Error(`fromStatus "${record.fromStatus}" is not one of ${COLLECTION_TASK_STATES.join(' / ')}`)
  }
  const source = String(record.source ?? '').trim()
  if (!COLLECTION_TASK_EVENT_SOURCES.includes(source)) {
    throw new Error(`source "${record.source}" is not one of ${COLLECTION_TASK_EVENT_SOURCES.join(' / ')}`)
  }

  const id = blankToNull(record.id) ?? newTaskEventId()
  const at = blankToNull(record.at) ?? nowIso()
  store.run(
    `INSERT INTO collection_task_event
       (id, task_id, from_status, to_status, reason, source, evidence_json, at, by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, taskId, fromStatus, toStatus, blankToNull(record.reason), source, json(record.evidence ?? null), at, blankToNull(record.by)],
  )
  return hydrate(store.get('SELECT * FROM collection_task_event WHERE id = ?', [id]))
}

/** One task's timeline, oldest first — the order the transitions happened in. */
export function listTaskEvents(store, { taskId, limit = MAX_EVENTS } = {}) {
  const bound = Math.min(Math.max(Math.trunc(Number(limit) || MAX_EVENTS), 1), MAX_EVENTS)
  return store
    .all(
      'SELECT * FROM collection_task_event WHERE task_id = ? ORDER BY at, rowid LIMIT ?',
      [String(taskId).trim(), bound],
    )
    .map(hydrate)
}

/** How many transitions a task has on record. */
export function countTaskEvents(store, taskId) {
  const row = store.get(
    'SELECT COUNT(*) AS rows FROM collection_task_event WHERE task_id = ?',
    [String(taskId).trim()],
  )
  return Number(row?.rows ?? 0)
}
