/**
 * `collection_env_check`: one row per health-check item, per round (schema v36,
 * module 04 F04-01).
 *
 * ## Why the detail is a table and not a JSON blob on the task
 *
 * The task row keeps a **summary** (`collection_task.env_check_json`), and the
 * per-item detail lives here. The reason is the question the page actually asks:
 * "which item failed, on which task, and when" — as JSON on the task that is a
 * scan of every task row, and it cannot be filtered or counted. A note on the
 * check_id is that it is a **closed vocabulary of ten** owned by the tool layer
 * (contract §6.2.1); this file validates its *shape* and does not keep a second
 * copy of the ten ids, because a copy here would have to be updated in step with
 * the one in the tool — exactly the drift `COLLECTION_SECTION_STATES`-style
 * closed sets exist to avoid.
 *
 * ## `task_id IS NULL` means an independent check, and that is deliberate
 *
 * A health check can be run without a task ("is my environment OK right now?").
 * SQLite's UNIQUE treats NULLs as distinct, so an independent check can be run
 * as many times as the user likes — while a check attached to a task keeps one
 * row per (item, timestamp). `recordEnvCheck` upserts on that key so a re-run in
 * the same millisecond overwrites its own row instead of throwing: two rows for
 * one instant would be a duplicate, not a history.
 *
 * ## `unknown` is an answer
 *
 * `unknown` means "we could not tell" (`09-proxy` is always this: this version
 * does not go through a proxy, and saying `ok` would be inventing a check that
 * never ran). It is a state, not a failure — `fail` is the failure.
 */

import { randomUUID } from 'node:crypto'

import {
  COLLECTION_ENV_CHECK_STATES, COLLECTION_REPAIR_ACTIONS, COLLECTION_RISK_LEVELS,
} from '../domain/states.js'
import { nowIso } from './db.js'

const MAX_ROWS = 1000

export function newEnvCheckId() {
  return `env-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function integerFlag(value, fallback = 0) {
  if (value === undefined || value === null) return fallback
  if (value === true || value === 1 || value === '1') return 1
  if (value === false || value === 0 || value === '0') return 0
  /* Not coerced: `'yes'` / `'maybe'` becoming "not repairable" would turn a
     caller's typo into a statement about the environment. */
  throw new Error(`expected a boolean (got ${JSON.stringify(value)})`)
}

function hydrate(row) {
  if (row === null || row === undefined) return null
  return {
    id: row.id,
    taskId: row.task_id ?? null,
    checkId: row.check_id,
    status: row.status,
    detail: row.detail ?? null,
    repairable: row.repairable === 1,
    repairAction: row.repair_action ?? null,
    risk: row.risk,
    checkedAt: row.checked_at,
  }
}

/**
 * Write one item.
 *
 * `repairable` and `repair_action` are kept in step **here**, because the pair is
 * a single statement: "this can be fixed" with no fix named, or a fix named for
 * something declared unfixable, are both rows a reader cannot act on. Either half
 * missing is refused rather than inferred — defaulting `repairable` from the
 * presence of an action would turn "the caller forgot" into "the environment
 * says this is fixable", which is the kind of silent decision that later reads
 * as a fact.
 */
export function recordEnvCheck(store, record = {}) {
  const checkId = blankToNull(record.checkId)
  if (checkId === null) throw new Error('checkId is required')

  const status = String(record.status ?? '').trim()
  if (!COLLECTION_ENV_CHECK_STATES.includes(status)) {
    throw new Error(`status "${record.status}" is not one of ${COLLECTION_ENV_CHECK_STATES.join(' / ')}`)
  }
  const risk = String(record.risk ?? 'low').trim() || 'low'
  if (!COLLECTION_RISK_LEVELS.includes(risk)) {
    throw new Error(`risk "${record.risk}" is not one of ${COLLECTION_RISK_LEVELS.join(' / ')}`)
  }
  const repairAction = blankToNull(record.repairAction)
  if (repairAction !== null && !COLLECTION_REPAIR_ACTIONS.includes(repairAction)) {
    throw new Error(`repairAction "${record.repairAction}" is not one of ${COLLECTION_REPAIR_ACTIONS.join(' / ')}`)
  }
  /* No inference from either half: `repairable: true` with no action, and an
     action with no `repairable`, are both refused. */
  const repairable = integerFlag(record.repairable, 0)
  if (repairable === 1 && repairAction === null) {
    throw new Error(`check "${checkId}" is marked repairable but names no repair action — say which of ${COLLECTION_REPAIR_ACTIONS.join(' / ')} fixes it`)
  }
  if (repairable === 0 && repairAction !== null) {
    throw new Error(`check "${checkId}" names the action "${repairAction}" but is not marked repairable — pass repairable: true`)
  }

  const taskId = blankToNull(record.taskId)
  const checkedAt = blankToNull(record.checkedAt) ?? nowIso()
  const id = blankToNull(record.id) ?? newEnvCheckId()

  store.run(
    `INSERT INTO collection_env_check
       (id, task_id, check_id, status, detail, repairable, repair_action, risk, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, check_id, checked_at) DO UPDATE SET
       status = excluded.status,
       detail = excluded.detail,
       repairable = excluded.repairable,
       repair_action = excluded.repair_action,
       risk = excluded.risk`,
    [id, taskId, checkId, status, blankToNull(record.detail), repairable, repairAction, risk, checkedAt],
  )
  return hydrate(store.get(
    'SELECT * FROM collection_env_check WHERE task_id IS ? AND check_id = ? AND checked_at = ?',
    [taskId, checkId, checkedAt],
  ))
}

/**
 * Write one whole round under a single timestamp.
 *
 * One `checkedAt` for the round is not cosmetic: it is what makes "the ten items
 * I am looking at were read at the same moment" true, and it is the key the
 * UNIQUE constraint counts with — ten rows sharing one instant read back as one
 * round, ten rows with ten instants read back as ten rounds. In one transaction
 * so a half-written round (which would look like the check never finished) is
 * impossible.
 */
export function recordEnvCheckRound(store, { taskId = null, checks, checkedAt = null, at = null } = {}) {
  if (!Array.isArray(checks)) throw new Error('checks must be an array')
  const stamp = blankToNull(checkedAt) ?? blankToNull(at) ?? nowIso()
  const task = blankToNull(taskId)
  const rows = []
  store.tx(() => {
    for (const check of checks) {
      rows.push(recordEnvCheck(store, { ...check, taskId: task, checkedAt: stamp }))
    }
  })
  return { checkedAt: stamp, taskId: task, checks: rows }
}

/** Every row for a task (or for independent checks), newest first. */
export function listEnvChecks(store, { taskId = null, limit = MAX_ROWS } = {}) {
  const bound = Math.min(Math.max(Math.trunc(Number(limit) || MAX_ROWS), 1), MAX_ROWS)
  return store
    .all(
      'SELECT * FROM collection_env_check WHERE task_id IS ? ORDER BY checked_at DESC, check_id LIMIT ?',
      [blankToNull(taskId), bound],
    )
    .map(hydrate)
}

/**
 * The newest row per check item — what the page shows.
 *
 * Ties on `checked_at` (two rounds in the same millisecond) return both rows for
 * that item rather than picking one by rowid: which of two same-instant reads is
 * "the" reading is not something this layer can answer, and silently picking
 * would hide that they disagree.
 */
export function latestEnvChecks(store, { taskId = null } = {}) {
  const task = blankToNull(taskId)
  return store
    .all(
      `SELECT * FROM collection_env_check
        WHERE task_id IS ?
          AND checked_at = (SELECT MAX(inner_check.checked_at) FROM collection_env_check inner_check
                             WHERE inner_check.task_id IS ? AND inner_check.check_id = collection_env_check.check_id)
        ORDER BY check_id`,
      [task, task],
    )
    .map(hydrate)
}

/** Counts by state, plus how many failed items can be repaired. */
export function envCheckSummary(store, { taskId = null } = {}) {
  const rows = latestEnvChecks(store, { taskId })
  const summary = { ok: 0, warn: 0, fail: 0, unknown: 0, repairable: 0, total: rows.length }
  for (const row of rows) {
    summary[row.status] = (summary[row.status] ?? 0) + 1
    if (row.repairable) summary.repairable += 1
  }
  return summary
}
