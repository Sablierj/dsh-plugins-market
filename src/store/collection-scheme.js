/**
 * `collection_scheme`: a scheme is a **versioned asset**, not a settings row
 * (schema v36, module 04 F04-09).
 *
 * ## Why the version is part of the identity
 *
 * The primary key is `(id, version)`, so a scheme's "current version" is not a
 * column anyone can point somewhere else: it is the newest row for that id. The
 * migration deliberately has no `is_current` flag — a task freezes the version it
 * ran under (`collection_task.scheme_id` / `scheme_version`), and a "make this
 * current" button elsewhere would silently change what a historical task is
 * understood to have used. Removing the flag removes the possibility.
 *
 * ## Immutability is a property of the row, not of the caller
 *
 * `insertSchemeVersion` only ever **appends**. Nothing here updates a name, a
 * section list or a driver on an existing `(id, version)`. The one column a
 * version may move is `status`, and only along `COLLECTION_SCHEME_TRANSITIONS`
 * (domain/states.js) — see `updateSchemeStatus`. A scheme whose content could be
 * edited in place would make "this task used scheme v3" mean whatever v3 says
 * today.
 *
 * ## NULL means "not declared", never "declared empty"
 *
 *   · `marketplaces_json IS NULL`  — every marketplace is allowed
 *   · `sections_json`              — NOT NULL on purpose: `[]` is a real choice
 *     ("collect nothing"), and an absent list is not a choice at all, so the
 *     writer is made to decide instead of inheriting a default.
 *   · `risk_level IS NULL`         — never assessed (≠ `low`)
 *   · `verified_at IS NULL`        — never verified (≠ "verification failed")
 */

import { randomUUID } from 'node:crypto'

import {
  COLLECTION_RISK_LEVELS, COLLECTION_SCHEME_DEFAULT_DRIVER, COLLECTION_SCHEME_STATUSES,
  COLLECTION_SCHEME_STATUS_LABELS, COLLECTION_SCHEME_TRANSITIONS, canTransitionScheme,
} from '../domain/states.js'
import { nowIso } from './db.js'

/** Bounded like every other list query in this store; a scheme has few versions. */
const MAX_VERSIONS = 500

/** The contract's `scheme-<8 random>` handle. */
export function newSchemeId() {
  return `scheme-${randomUUID().replace(/-/g, '').slice(0, 8)}`
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

function schemeStatusOf(value) {
  const status = String(value ?? 'draft').trim() || 'draft'
  if (!COLLECTION_SCHEME_STATUSES.includes(status)) {
    throw new Error(`status "${value}" is not one of ${COLLECTION_SCHEME_STATUSES.join(' / ')}`)
  }
  return status
}

function idOf(value) {
  const id = String(value ?? '').trim()
  if (id === '') throw new Error('id is required')
  return id
}

/**
 * The driver's domain is `source.id` (contract §2.1), so a typo is refused here
 * rather than stored: a scheme whose driver cannot be resolved is a scheme that
 * fails at submit time with a message about a source nobody has heard of, and
 * the row that caused it would still be there looking selectable.
 */
function driverOf(store, value) {
  const driver = blankToNull(value) ?? COLLECTION_SCHEME_DEFAULT_DRIVER
  const known = store.get('SELECT id FROM source WHERE id = ?', [driver])
  if (known === undefined) {
    const ids = store.all('SELECT id FROM source ORDER BY id').map(row => row.id)
    throw new Error(`driver "${driver}" is not a known source id; known sources: ${ids.join(', ')}`)
  }
  return driver
}

/**
 * The caller's version, or the next free one.
 *
 * `MAX(version) + 1` and not `COUNT(*) + 1`: counting would reuse a number as
 * soon as a version is missing (an import, a hand-deleted row), and a reused
 * `(id, version)` is the one thing this table's primary key exists to prevent.
 */
function nextVersion(store, id) {
  const row = store.get('SELECT MAX(version) AS top FROM collection_scheme WHERE id = ?', [id])
  const top = Number(row?.top ?? 0)
  return Number.isFinite(top) && top >= 1 ? top + 1 : 1
}

function hydrate(row) {
  if (row === null || row === undefined) return null
  return {
    id: row.id,
    name: row.name,
    version: Number(row.version),
    status: row.status,
    statusLabel: COLLECTION_SCHEME_STATUS_LABELS[row.status] ?? row.status,
    driver: row.driver,
    /* null is not the same as []: "no marketplace restriction" versus
       "restricted to an empty set" (which would mean usable nowhere). */
    marketplaces: parseJson(row.marketplaces_json, null),
    sections: parseJson(row.sections_json, []),
    requiresLogin: row.requires_login === 1,
    riskLevel: row.risk_level ?? null,
    defaultPacing: parseJson(row.default_pacing_json, null),
    verifiedAt: row.verified_at ?? null,
    verifiedBy: row.verified_by ?? null,
    note: row.note ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Append one version row.
 *
 * Passing `version` explicitly is how an import or a re-numbering lands; leaving
 * it out appends `MAX(version) + 1`, which is what "save a new draft" means. The
 * old versions are never touched by either path.
 */
export function insertSchemeVersion(store, record = {}) {
  const id = blankToNull(record.id) ?? newSchemeId()
  const name = blankToNull(record.name)
  if (name === null) throw new Error('name is required')

  /* An absent list and an empty list are different statements. `[]` says "this
     scheme collects nothing" (legal, deliberate); `undefined` says the caller
     forgot to decide, and a default would put that non-decision into the store
     where it looks like a decision. */
  if (!Array.isArray(record.sections)) {
    throw new Error('sections must be an array — an empty array is a legal but deliberate choice, and there is no default')
  }

  const explicit = record.version === undefined || record.version === null ? null : Math.trunc(Number(record.version))
  if (explicit !== null && (!Number.isFinite(explicit) || explicit < 1)) {
    throw new Error(`version must be a positive integer (got ${record.version})`)
  }
  const version = explicit ?? nextVersion(store, id)

  const exists = store.get('SELECT id FROM collection_scheme WHERE id = ? AND version = ?', [id, version])
  if (exists !== undefined) {
    throw new Error(`collection_scheme ${id} v${version} already exists — versions are appended, never rewritten`)
  }

  const status = schemeStatusOf(record.status ?? 'draft')
  const riskLevel = blankToNull(record.riskLevel)
  if (riskLevel !== null && !COLLECTION_RISK_LEVELS.includes(riskLevel)) {
    throw new Error(`riskLevel "${record.riskLevel}" is not one of ${COLLECTION_RISK_LEVELS.join(' / ')}`)
  }
  const marketplaces = Array.isArray(record.marketplaces)
    ? record.marketplaces.map(value => String(value).trim().toUpperCase()).filter(value => value !== '')
    : null

  const at = blankToNull(record.at) ?? nowIso()
  store.run(
    `INSERT INTO collection_scheme
       (id, name, version, status, driver, marketplaces_json, sections_json, requires_login,
        risk_level, default_pacing_json, verified_at, verified_by, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      name,
      version,
      status,
      driverOf(store, record.driver),
      json(marketplaces),
      json(record.sections.map(section => String(section))),
      record.requiresLogin === true || record.requiresLogin === 1 ? 1 : 0,
      riskLevel,
      json(record.defaultPacing ?? null),
      blankToNull(record.verifiedAt),
      blankToNull(record.verifiedBy),
      blankToNull(record.note),
      at,
      at,
    ],
  )
  return getSchemeVersion(store, id, version)
}

/** One version, or null. Version is required — "the scheme" is not a thing here. */
export function getSchemeVersion(store, id, version) {
  const row = store.get(
    'SELECT * FROM collection_scheme WHERE id = ? AND version = ?',
    [idOf(id), Math.trunc(Number(version))],
  )
  return hydrate(row)
}

/** The newest version of a scheme, or null when the id is unknown. */
export function currentSchemeVersion(store, id) {
  const row = store.get(
    'SELECT * FROM collection_scheme WHERE id = ? ORDER BY version DESC LIMIT 1',
    [idOf(id)],
  )
  return hydrate(row)
}

/** Every version of one scheme, newest first. */
export function listSchemeVersions(store, id, { limit = MAX_VERSIONS } = {}) {
  return store
    .all(
      'SELECT * FROM collection_scheme WHERE id = ? ORDER BY version DESC LIMIT ?',
      [idOf(id), Math.min(Math.max(Math.trunc(Number(limit) || MAX_VERSIONS), 1), MAX_VERSIONS)],
    )
    .map(hydrate)
}

/**
 * Schemes for the page and the list tool.
 *
 * By default one row per scheme — **the newest version** — because a list that
 * shows four versions of the same offering answers "what can I pick" with four
 * rows that differ only in a number. `includeVersions: true` is for the history
 * view.
 */
export function listSchemes(store, { status = null, schemeId = null, includeVersions = false, limit = 200 } = {}) {
  const clauses = []
  const params = []
  if (blankToNull(schemeId) !== null) {
    clauses.push('id = ?')
    params.push(String(schemeId).trim())
  }
  if (blankToNull(status) !== null) {
    clauses.push('status = ?')
    params.push(schemeStatusOf(status))
  }
  if (!includeVersions) {
    clauses.push('version = (SELECT MAX(inner_scheme.version) FROM collection_scheme inner_scheme WHERE inner_scheme.id = collection_scheme.id)')
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const bound = Math.min(Math.max(Math.trunc(Number(limit) || 200), 1), MAX_VERSIONS)
  return store
    .all(`SELECT * FROM collection_scheme ${where} ORDER BY updated_at DESC, id, version DESC LIMIT ?`, [...params, bound])
    .map(hydrate)
}

/**
 * Edit the **draft** version of a scheme in place.
 *
 * The one exception to "this file appends and never rewrites", and it is narrow
 * on purpose: a `draft` is the single version no task can reference (only
 * `active` versions are selectable — `domain/collect/preview.js` refuses the
 * rest), so rewriting one cannot change what a historical task is understood to
 * have used. The guard is here rather than at the caller because a caller that
 * forgot it would silently rewrite a frozen version — the exact thing the
 * `(id, version)` primary key exists to prevent.
 *
 * `status`, `verified_at` and `verified_by` are deliberately not writable here:
 * moving along the state machine is `updateSchemeStatus`'s job, and a draft edit
 * that could also flip status would be two operations wearing one name.
 */
export function updateSchemeDraft(store, { id, version, ...fields } = {}) {
  const schemeId = idOf(id)
  const current = getSchemeVersion(store, schemeId, version)
  if (current === null) throw new Error(`collection_scheme ${schemeId} v${version} does not exist`)
  if (current.status !== 'draft') {
    throw new Error(
      `collection_scheme ${schemeId} v${version} is ${current.status}, not draft — only a draft may be edited in place; `
      + 'append a new version instead',
    )
  }

  const name = blankToNull(fields.name)
  if (name === null) throw new Error('name is required')
  if (!Array.isArray(fields.sections)) {
    throw new Error('sections must be an array — an empty array is a legal but deliberate choice, and there is no default')
  }
  const riskLevel = blankToNull(fields.riskLevel)
  if (riskLevel !== null && !COLLECTION_RISK_LEVELS.includes(riskLevel)) {
    throw new Error(`riskLevel "${fields.riskLevel}" is not one of ${COLLECTION_RISK_LEVELS.join(' / ')}`)
  }
  const marketplaces = Array.isArray(fields.marketplaces)
    ? fields.marketplaces.map(value => String(value).trim().toUpperCase()).filter(value => value !== '')
    : null

  const at = blankToNull(fields.at) ?? nowIso()
  store.run(
    `UPDATE collection_scheme
        SET name = ?, driver = ?, marketplaces_json = ?, sections_json = ?, requires_login = ?,
            risk_level = ?, default_pacing_json = ?, note = ?, updated_at = ?
      WHERE id = ? AND version = ?`,
    [
      name,
      driverOf(store, fields.driver),
      json(marketplaces),
      json(fields.sections.map(section => String(section))),
      fields.requiresLogin === true || fields.requiresLogin === 1 ? 1 : 0,
      riskLevel,
      json(fields.defaultPacing ?? null),
      blankToNull(fields.note),
      at,
      schemeId,
      Math.trunc(Number(version)),
    ],
  )
  return getSchemeVersion(store, schemeId, version)
}

/**
 * Move one version along the status machine.
 *
 * `verify` is not here: verifying a scheme means actually running a health check
 * and a probe collection (contract §6.2.10), which is a tool-level action that
 * *ends* in this call. What this function guarantees is the half that must not
 * be skippable — the edge is legal, and `verified_at` is only ever written on
 * the transition into `active`.
 */
export function updateSchemeStatus(store, { id, version, to, verifiedBy = null, at = null } = {}) {
  const schemeId = idOf(id)
  const current = getSchemeVersion(store, schemeId, version)
  if (current === null) {
    throw new Error(`collection_scheme ${schemeId} v${version} does not exist`)
  }
  const target = schemeStatusOf(to)
  if (!canTransitionScheme(current.status, target)) {
    const allowed = COLLECTION_SCHEME_TRANSITIONS[current.status] ?? []
    throw new Error(
      `collection_scheme ${schemeId} v${version} cannot go ${current.status} → ${target}; `
      + `allowed from ${current.status}: ${allowed.length === 0 ? '(terminal)' : allowed.join(' / ')}`,
    )
  }
  const stamp = blankToNull(at) ?? nowIso()
  /* Only the transition into `active` stamps the verification — otherwise a
     later `disable` would refresh `verified_at` and a scheme that was verified
     two years ago would look freshly verified. */
  if (target === 'active') {
    store.run(
      'UPDATE collection_scheme SET status = ?, verified_at = ?, verified_by = ?, updated_at = ? WHERE id = ? AND version = ?',
      [target, stamp, blankToNull(verifiedBy), stamp, schemeId, Math.trunc(Number(version))],
    )
  } else {
    store.run(
      'UPDATE collection_scheme SET status = ?, updated_at = ? WHERE id = ? AND version = ?',
      [target, stamp, schemeId, Math.trunc(Number(version))],
    )
  }
  return getSchemeVersion(store, schemeId, version)
}

/**
 * How many tasks reference a version, and when the last one was submitted.
 *
 * This is the answer to "may this be obsoleted": a scheme that tasks have used
 * cannot be deleted — but nothing is deleted here anyway, which is why usage is
 * reported rather than enforced. The caller (contract §6.2.10 `SCHEME_IN_USE`)
 * decides what to do with the number.
 */
export function schemeUsage(store, { id, version = null } = {}) {
  const schemeId = idOf(id)
  const clauses = ['scheme_id = ?']
  const params = [schemeId]
  if (version !== null && version !== undefined) {
    clauses.push('scheme_version = ?')
    params.push(Math.trunc(Number(version)))
  }
  const row = store.get(
    `SELECT COUNT(*) AS task_count, MAX(submitted_at) AS last_used_at
       FROM collection_task WHERE ${clauses.join(' AND ')}`,
    params,
  )
  return {
    taskCount: Number(row?.task_count ?? 0),
    lastUsedAt: row?.last_used_at ?? null,
  }
}
