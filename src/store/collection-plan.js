/**
 * `collection_plan`: a saved "collect this set regularly" definition (schema v36,
 * module 04 F04-10).
 *
 * ## There is no scheduler, and this file does not pretend otherwise
 *
 * The plugin has no resident timer (time-driven rules run when the workbench is
 * opened). So a plan is a **definition**, and the window judgement happens on the
 * submit path, at the moment someone submits — it returns `cooling_down` or parks
 * the task in `waiting_human` with a `plan-window` trigger. That is why there is
 * no `next_run_at` column: nobody in this system can compute a trustworthy "next
 * run time", and a stored column that only a human can work out is a calculation
 * error saved to disk.
 *
 * ## Off by default
 *
 * `enabled` defaults to **0** and `savePlan` never flips it as a side effect.
 * A plan that started running because it was created would be a subscription the
 * user did not ask for; F04-10's acceptance is exactly "默认关闭".
 *
 * ## The name is the handle, so it is unique
 *
 * `UNIQUE (name)` in the schema, plus a readable refusal here. "Pause the
 * 计划" has to name exactly one row; two rows called 每周全量 make that question
 * unanswerable. As everywhere else in this store, the code refuses with a
 * sentence and the constraint is the backstop.
 */

import { randomUUID } from 'node:crypto'

import {
  COLLECTION_PLAN_FAILURE_POLICIES, COLLECTION_PLAN_NOTIFY,
} from '../domain/states.js'
import { nowIso } from './db.js'

const MAX_PLANS = 500
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/
/* `to` 允许 `24:00`：右端开区间，`00:00–24:00` 才是整天（见 normalizeWindow 的注释）。 */
const HH_MM_END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/

/** The contract's `plan-<8 random>` handle. */
export function newPlanId() {
  return `plan-${randomUUID().replace(/-/g, '').slice(0, 8)}`
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

function integerOf(value, { name, fallback = null, min = null }) {
  if (value === undefined || value === null) return fallback
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number (got ${JSON.stringify(value)})`)
  if (min !== null && number < min) throw new Error(`${name} must be >= ${min} (got ${number})`)
  return number
}

/**
 * `{from, to, tz}` with `from < to`.
 *
 * A window that wraps past midnight (`22:00`–`02:00`) is **refused** rather than
 * guessed at: "is 23:30 inside 22:00–02:00" is answerable, but "is the window
 * open now" would then need a date, and the plan has no date. Refusing says so;
 * silently reading it as closed would make a plan that never runs look fine.
 */
function normalizeWindow(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') throw new Error('window must be an object {from,to,tz}')
  const from = String(value.from ?? '').trim()
  const to = String(value.to ?? '').trim()
  /* 右端是**开**区间，所以「整天」只能用 `00:00–24:00` 表达。
     `00:00–23:59` 会漏掉每天最后一分钟（复验席 2026-10-25 §10：那条断言每天 UTC 23:59 必然红）。
     左端仍然不许 24:00 —— 那不是一天的起点。 */
  if (!HH_MM.test(from) || !HH_MM_END.test(to)) {
    throw new Error(`window must use HH:MM for from/to (got ${JSON.stringify({ from, to })})`)
  }
  if (from >= to) {
    throw new Error(`window.from must be earlier than window.to (got ${from} >= ${to}); windows that cross midnight are not supported`)
  }
  return { from, to, tz: blankToNull(value.tz) ?? 'Asia/Shanghai' }
}

function enabledOf(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (value === true || value === 1 || value === '1') return 1
  if (value === false || value === 0 || value === '0') return 0
  throw new Error(`enabled must be a boolean (got ${JSON.stringify(value)})`)
}

function hydrate(row) {
  if (row === null || row === undefined) return null
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    marketplace: row.marketplace ?? null,
    targets: parseJson(row.targets_json, []),
    schemeId: row.scheme_id ?? null,
    schemeVersion: row.scheme_version === null || row.scheme_version === undefined ? null : Number(row.scheme_version),
    window: parseJson(row.window_json, null),
    intervalMinutes: row.interval_minutes === null ? null : Number(row.interval_minutes),
    maxObjects: Number(row.max_objects),
    failurePolicy: row.failure_policy,
    cooldownMinutes: Number(row.cooldown_minutes),
    notify: row.notify,
    pauseCondition: parseJson(row.pause_condition_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getPlan(store, id) {
  const text = blankToNull(id)
  if (text === null) return null
  return hydrate(store.get('SELECT * FROM collection_plan WHERE id = ?', [text]))
}

export function getPlanByName(store, name) {
  const text = blankToNull(name)
  if (text === null) return null
  return hydrate(store.get('SELECT * FROM collection_plan WHERE name = ?', [text]))
}

/** Plans for the page and the list tool. `enabled: false` means "only the off ones". */
export function listPlans(store, { enabled = null, marketplace = null, limit = MAX_PLANS } = {}) {
  const clauses = []
  const params = []
  if (enabled !== null && enabled !== undefined) {
    clauses.push('enabled = ?')
    params.push(enabled === true || enabled === 1 || enabled === '1' ? 1 : 0)
  }
  if (blankToNull(marketplace) !== null) {
    clauses.push('marketplace = ?')
    params.push(String(marketplace).trim().toUpperCase())
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const bound = Math.min(Math.max(Math.trunc(Number(limit) || MAX_PLANS), 1), MAX_PLANS)
  return store
    .all(`SELECT * FROM collection_plan ${where} ORDER BY updated_at DESC, id LIMIT ?`, [...params, bound])
    .map(hydrate)
}

/**
 * Create or replace one plan definition.
 *
 * An update replaces **every** field, not just the ones passed: `plan_save`
 * returns the whole row to the caller (contract §6.2.11), and a partial update
 * here would make "the plan the page showed" and "the plan in the store" two
 * different objects whenever a field is left out. `created_at` is preserved on
 * update; that is the only column the caller cannot move.
 */
export function savePlan(store, record = {}) {
  const name = blankToNull(record.name)
  if (name === null) throw new Error('name is required')

  const id = blankToNull(record.id) ?? newPlanId()
  const existing = getPlan(store, id)

  /* The readable half of `UNIQUE (name)`: the caller gets told which plan holds
     the name instead of a constraint-violation string. Re-saving the same plan
     under its own name is obviously fine. */
  const clash = getPlanByName(store, name)
  if (clash !== null && clash.id !== id) {
    throw new Error(`plan name "${name}" is already used by ${clash.id} — names are the handle for "pause that plan", so they are unique`)
  }

  if (!Array.isArray(record.targets)) {
    throw new Error('targets must be an array — a plan with no targets would be enabled and collect nothing')
  }

  const failurePolicy = String(record.failurePolicy ?? 'stop').trim() || 'stop'
  if (!COLLECTION_PLAN_FAILURE_POLICIES.includes(failurePolicy)) {
    throw new Error(`failurePolicy "${record.failurePolicy}" is not one of ${COLLECTION_PLAN_FAILURE_POLICIES.join(' / ')}`)
  }
  const notify = String(record.notify ?? 'none').trim() || 'none'
  if (!COLLECTION_PLAN_NOTIFY.includes(notify)) {
    throw new Error(`notify "${record.notify}" is not one of ${COLLECTION_PLAN_NOTIFY.join(' / ')}`)
  }

  const at = blankToNull(record.at) ?? nowIso()
  const fields = {
    name,
    enabled: enabledOf(record.enabled, existing === null ? 0 : (existing.enabled ? 1 : 0)),
    marketplace: blankToNull(record.marketplace) === null ? null : String(record.marketplace).trim().toUpperCase(),
    /* Targets are stored as given: the ASIN shape is checked on the submit path
       (`normalizeTargets`, sources/collection.js), and checking it twice would
       be two rulers for one rule. What must be true here is that the column is
       NOT NULL, which is why a non-array is refused. */
    targets_json: json(record.targets),
    scheme_id: blankToNull(record.schemeId),
    scheme_version: integerOf(record.schemeVersion, { name: 'schemeVersion' }),
    window_json: json(normalizeWindow(record.window)),
    interval_minutes: integerOf(record.intervalMinutes, { name: 'intervalMinutes', min: 1 }),
    max_objects: integerOf(record.maxObjects, { name: 'maxObjects', fallback: existing?.maxObjects ?? 50, min: 1 }),
    failure_policy: failurePolicy,
    cooldown_minutes: integerOf(record.cooldownMinutes, { name: 'cooldownMinutes', fallback: existing?.cooldownMinutes ?? 60, min: 0 }),
    notify,
    pause_condition_json: json(record.pauseCondition ?? null),
  }

  if (existing === null) {
    store.run(
      `INSERT INTO collection_plan
         (id, name, enabled, marketplace, targets_json, scheme_id, scheme_version, window_json,
          interval_minutes, max_objects, failure_policy, cooldown_minutes, notify, pause_condition_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, fields.name, fields.enabled, fields.marketplace, fields.targets_json, fields.scheme_id,
        fields.scheme_version, fields.window_json, fields.interval_minutes, fields.max_objects,
        fields.failure_policy, fields.cooldown_minutes, fields.notify, fields.pause_condition_json, at, at,
      ],
    )
  } else {
    store.run(
      `UPDATE collection_plan
          SET name = ?, enabled = ?, marketplace = ?, targets_json = ?, scheme_id = ?, scheme_version = ?,
              window_json = ?, interval_minutes = ?, max_objects = ?, failure_policy = ?,
              cooldown_minutes = ?, notify = ?, pause_condition_json = ?, updated_at = ?
        WHERE id = ?`,
      [
        fields.name, fields.enabled, fields.marketplace, fields.targets_json, fields.scheme_id,
        fields.scheme_version, fields.window_json, fields.interval_minutes, fields.max_objects,
        fields.failure_policy, fields.cooldown_minutes, fields.notify, fields.pause_condition_json, at, id,
      ],
    )
  }
  return getPlan(store, id)
}

/**
 * Flip `enabled` without touching anything else.
 *
 * Separate from `savePlan` because "turn the plan off now" is a one-field
 * decision, and routing it through a full replace means the caller has to send
 * every other field back unchanged — which is how a stale form silently reverts
 * a window someone else edited.
 */
export function setPlanEnabled(store, id, enabled, { at = null } = {}) {
  const current = getPlan(store, id)
  if (current === null) throw new Error(`collection_plan ${id} does not exist`)
  store.run(
    'UPDATE collection_plan SET enabled = ?, updated_at = ? WHERE id = ?',
    [enabledOf(enabled, 0), blankToNull(at) ?? nowIso(), current.id],
  )
  return getPlan(store, current.id)
}
