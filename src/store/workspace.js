/**
 * The `workspace` table: the object every configuration row now belongs to.
 *
 * Before v20 there was no such object, and "the settings" meant "the settings",
 * full stop. That was fine for one store and wrong for the first one that wanted
 * two, because the question "which of these product lines is mine?" had no
 * answer — the rows were the only ones there were.
 *
 * Two rules shape everything here:
 *
 *   - **At most one default**, and it is a structural constraint (the partial
 *     unique index `idx_ws_default` from v20), not a convention this file
 *     maintains. A second default is a state where every reader has to decide
 *     which one to believe, and that decision belongs in the schema.
 *
 *   - **Archived means read-only**, enforced by `assertWorkspaceWritable` at the
 *     write, not by the page hiding buttons. A hidden button is a UI opinion; the
 *     store is the one that has to refuse. Archiving is also *reversible* — the
 *     row and its `archived_at` both survive, so "what was it" stays answerable.
 *
 * Deleting is deliberately absent. A workspace is the parent of every
 * configuration row; a delete either cascades (destroying history the reports
 * cite) or orphans them. Phase 1 offers archive, and retention (S1-B19) is where
 * "remove this for real" gets designed.
 */

import { randomUUID } from 'node:crypto'

import { PROBLEM_CODES } from '../domain/states.js'
import { DEFAULT_WORKSPACE_ID } from '../domain/context/scope.js'
import { nowIso } from './db.js'
import { counts } from './queries.js'
import { redactSource } from './settings.js'

/** An error the caller can branch on, carrying the machine code from states.js. */
function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** The workspace, or `undefined`. */
export function getWorkspace(store, id) {
  const key = String(id ?? '').trim()
  if (key === '') return undefined
  return store.get('SELECT * FROM workspace WHERE id = ?', [key])
}

/** The default one. v20 guarantees exactly one exists. */
export function getDefaultWorkspace(store) {
  return store.get('SELECT * FROM workspace WHERE is_default = 1')
}

/**
 * Every workspace, default first, then oldest first.
 *
 * The default is pinned to the top because it is the one most reads mean, and a
 * list that reorders itself by name would make the answer to "which one am I in"
 * depend on alphabet. Archived rows are included — the page has to be able to
 * show them, and a list that silently omitted them would make an archived
 * workspace look deleted.
 */
export function listWorkspaces(store) {
  return store.all('SELECT * FROM workspace ORDER BY is_default DESC, created_at ASC')
}

/**
 * Create one. Never the default — a second default cannot exist, and promoting
 * it is `setDefaultWorkspace`'s job, which demotes the old one in the same
 * transaction.
 */
export function createWorkspace(store, record = {}) {
  const name = String(record.name ?? '').trim()
  if (name === '') throw new Error('workspace name is required')
  const id = String(record.id ?? '').trim() || `ws-${randomUUID()}`
  if (getWorkspace(store, id) !== undefined) throw new Error(`workspace "${id}" already exists`)
  const now = nowIso()
  store.run(
    `INSERT INTO workspace (id, name, is_default, archived_at, note, created_at, updated_at)
     VALUES (?, ?, 0, NULL, ?, ?, ?)`,
    [id, name, record.note === undefined || record.note === null ? null : String(record.note), now, now],
  )
  return getWorkspace(store, id)
}

/** Rename one. Archived or not: a name is not a write to the workspace's data. */
export function renameWorkspace(store, id, name) {
  const row = getWorkspace(store, id)
  if (row === undefined) throw codedError(`no workspace "${id}"`, PROBLEM_CODES.WORKSPACE_NOT_FOUND)
  const next = String(name ?? '').trim()
  if (next === '') throw new Error('workspace name is required')
  store.run('UPDATE workspace SET name = ?, updated_at = ? WHERE id = ?', [next, nowIso(), row.id])
  return getWorkspace(store, row.id)
}

/**
 * Archive (or restore) one.
 *
 * The default workspace cannot be archived: every read that has no explicit
 * workspace falls back to it, and archiving it would make the fallback point at
 * a read-only space. Refusing here rather than at the page is what makes that a
 * rule instead of a habit.
 */
export function archiveWorkspace(store, id, archived = true) {
  const row = getWorkspace(store, id)
  if (row === undefined) throw codedError(`no workspace "${id}"`, PROBLEM_CODES.WORKSPACE_NOT_FOUND)
  if (archived && row.is_default === 1) {
    throw codedError('the default workspace cannot be archived', PROBLEM_CODES.WORKSPACE_ARCHIVED)
  }
  store.run(
    'UPDATE workspace SET archived_at = ?, updated_at = ? WHERE id = ?',
    [archived ? nowIso() : null, nowIso(), row.id],
  )
  return getWorkspace(store, row.id)
}

/**
 * Promote one to default, demoting whichever held it.
 *
 * Both statements run in one transaction because the partial unique index makes
 * the intermediate state ("two defaults") illegal: demote-then-promote as two
 * separate writes would fail on the second, and promote-then-demote would fail
 * on the first. Archived workspaces are refused — the fallback has to point at
 * something writable.
 */
export function setDefaultWorkspace(store, id) {
  const row = getWorkspace(store, id)
  if (row === undefined) throw codedError(`no workspace "${id}"`, PROBLEM_CODES.WORKSPACE_NOT_FOUND)
  if (row.archived_at !== null) {
    throw codedError(`workspace "${row.id}" is archived and cannot be the default`, PROBLEM_CODES.WORKSPACE_ARCHIVED)
  }
  const now = nowIso()
  return store.tx(() => {
    store.run('UPDATE workspace SET is_default = 0, updated_at = ? WHERE is_default = 1', [now])
    store.run('UPDATE workspace SET is_default = 1, updated_at = ? WHERE id = ?', [now, row.id])
    return getWorkspace(store, row.id)
  })
}

/**
 * Refuse a write into an archived workspace, and return the row when it is fine.
 *
 * Every configuration write calls this first. Throwing — rather than returning a
 * boolean the caller may forget to check — is deliberate: the failure mode of a
 * forgotten boolean is a silent write into a read-only space, which is exactly
 * what archiving was supposed to prevent.
 *
 * An unknown workspace id also throws. A write into a workspace that does not
 * exist is not "probably the default" — it is a caller that lost track of which
 * space it was addressing, and guessing would put the row somewhere nobody looks.
 */
export function assertWorkspaceWritable(store, workspaceId) {
  const key = String(workspaceId ?? '').trim() || DEFAULT_WORKSPACE_ID
  const row = getWorkspace(store, key)
  if (row === undefined) throw codedError(`no workspace "${key}"`, PROBLEM_CODES.WORKSPACE_NOT_FOUND)
  if (row.archived_at !== null) {
    throw codedError(`workspace "${key}" is archived`, PROBLEM_CODES.WORKSPACE_ARCHIVED)
  }
  return row
}

/**
 * The refusal a configuration write should get, or `null` when it may proceed.
 *
 * A non-throwing twin of `assertWorkspaceWritable`, for the two entrances that
 * have to turn the answer into a **reply** rather than an exception: a page route
 * and a tool. Both report `{ ok: false, code, error }` and neither may kill a
 * request or a turn — so the refusal shape is built here, from the store's own
 * code and message, and the two entrances cannot come to different conclusions
 * about the same workspace.
 *
 * Takes several ids because one write has more than one target: the workspace the
 * row **lands in** (resolved the way its writer resolves it) and the workspace the
 * **scope bar** is showing — "archived means read-only" has to hold for both, or
 * a page sitting in an archived space could still edit the default one's
 * settings. Each id is checked in order and the first refusal wins. An absent id
 * is not a wildcard; `assertWorkspaceWritable` reads it as the default workspace,
 * which is where a writer that has not learned the dimension puts its row.
 */
export function workspaceWriteRefusal(store, ...workspaceIds) {
  for (const id of workspaceIds) {
    try {
      assertWorkspaceWritable(store, id)
    } catch (error) {
      return { ok: false, code: error.code ?? null, error: error.message }
    }
  }
  return null
}

/**
 * Everything this workspace's configuration consists of, as a JSON-able tree.
 *
 * The shape is the answer to "what would I have to recreate elsewhere": the
 * workspace itself, its preferences, its product lines, its sources **without
 * credentials**, its site profiles and the verification events behind them.
 *
 * Secrets are excluded, not redacted. This tree is meant to be written to a file
 * and handed to somebody, and a `config_json` that survives a round trip through
 * `JSON.stringify` is a credential leak with a friendly name. The source rows
 * therefore carry identity and enabled-ness only.
 *
 * `capacity` is `counts()` verbatim — not a second counting rule. Two counters
 * for one table is how "the export says 412 and the page says 411" starts.
 */
export function exportWorkspaceConfig(store, workspaceId) {
  const key = String(workspaceId ?? '').trim() || DEFAULT_WORKSPACE_ID
  const row = getWorkspace(store, key)
  if (row === undefined) throw codedError(`no workspace "${key}"`, PROBLEM_CODES.WORKSPACE_NOT_FOUND)

  /* v20's own rule, applied on read: **NULL means the default workspace.**
     The backfill filled every row that existed at v20, but writers that have not
     learned about the dimension yet (the source registry, a hand-run INSERT)
     leave it NULL — and a reader that treated NULL as "no workspace" would
     silently drop exactly the rows the backfill could not reach. Scoping this way
     keeps "the default space" meaning what it has always meant.
     A non-default workspace does **not** inherit NULLs: those rows belong to the
     default, and claiming them for a second space would invent an ownership
     nobody declared. */
  const isDefault = row.is_default === 1
  const scope = isDefault
    ? { clause: '(workspace_id = ? OR workspace_id IS NULL)', params: [key] }
    : { clause: 'workspace_id = ?', params: [key] }

  const settings = store.all(
    `SELECT key, value_json, note, updated_at FROM setting WHERE ${scope.clause} ORDER BY key`,
    scope.params,
  ).map(entry => ({
    key: entry.key,
    value: safeJson(entry.value_json),
    note: entry.note,
    updatedAt: entry.updated_at,
  }))

  const productLines = store.all(
    `SELECT id, name, signals_json, note FROM product_line WHERE ${scope.clause} ORDER BY id`,
    scope.params,
  ).map(entry => ({
    id: entry.id,
    name: entry.name,
    signals: safeJson(entry.signals_json),
    note: entry.note,
  }))

  /* `redactSource`, then the config itself is dropped. The redaction replaces a
     secret's value with a constant, which is right for a screen and wrong for a
     file: a tree that gets written out and read back would carry the literal
     mask as if it were the credential. What an export needs is which source it
     was and which credential fields it had, so that is all it gets. */
  const sources = store.all(
    `SELECT * FROM source WHERE ${scope.clause} ORDER BY kind, id`,
    scope.params,
  ).map(entry => {
    const redacted = redactSource(entry)
    return {
      id: redacted.id,
      kind: redacted.kind,
      name: redacted.name,
      enabled: redacted.enabled,
      configKeys: redacted.configKeys,
      hasSecret: redacted.hasSecret,
      lastHealth: redacted.lastHealth,
      checkedAt: redacted.checkedAt,
    }
  })

  const sites = store.all(
    `SELECT marketplace, localization_json, note, updated_at FROM site_profile WHERE ${scope.clause} ORDER BY marketplace`,
    scope.params,
  ).map(entry => ({
    marketplace: entry.marketplace,
    localization: safeJson(entry.localization_json),
    note: entry.note,
    updatedAt: entry.updated_at,
  }))

  const verifications = store.all(
    `SELECT id, marketplace, verified_at, verified_by, evidence_url, evidence_note
       FROM site_verification WHERE ${scope.clause} ORDER BY marketplace, verified_at`,
    scope.params,
  )

  return {
    exportedAt: nowIso(),
    workspace: {
      id: row.id,
      name: row.name,
      isDefault: row.is_default === 1,
      archivedAt: row.archived_at,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    settings,
    productLines,
    sources,
    sites,
    verifications,
    capacity: counts(store),
  }
}

/** The row as the page and the model read it — camelCase, booleans, no raw ints. */
export function view(row) {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default === 1,
    archived: row.archived_at !== null,
    archivedAt: row.archived_at,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Parse a stored JSON blob, or hand back the raw text a hand-edited row holds. */
function safeJson(text) {
  if (text === null || text === undefined) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
