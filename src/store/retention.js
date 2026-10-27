/**
 * Retention: what still points at a versioned object, so a version that is
 * still in use cannot be retired by accident — and the refusal says who is
 * holding it.
 *
 * ## The reference graph is declared, and it is narrow on purpose
 *
 * `REFERENCE_EDGES` lists the tables that point at a **snapshot's identity**.
 * It is deliberately not "every foreign key that happens to mention one of the
 * snapshotted tables". The difference is the one that decides whether the
 * feature is useful at all:
 *
 *   - An **external consumer** points at a version and would still want it
 *     tomorrow: an `optimization_run` records the rule set version it was judged
 *     against — under **either** of two synonymous columns, `rule_set_version`
 *     (v15) and `rules_version` (v10) — and that is the whole reason `rule_set`
 *     versions get registered as snapshots (v25 backfill). This is a real edge
 *     and the only one today. Reading only one of the two columns is a
 *     half-read edge: an upgraded store's pre-v15 runs carry the version in the
 *     older column alone, and a graph that missed them would delete the version
 *     a run still points at.
 *   - A snapshotted object's **own rows** are its body, not a referrer: `rule`
 *     has `rule_set_version REFERENCES rule_set(version)` and `prompt` has
 *     `set_id REFERENCES prompt_set(id)`, but those rows *are* the set. Counting
 *     them would mean every set with any content is permanently undeletable,
 *     which is a policy that refuses everything and therefore says nothing.
 *
 * So the graph is discovered from the schema and then read honestly: six of the
 * seven `SNAPSHOT_OBJECT_TYPES` have no external referrer at all, and
 * `referencedBy` returns `[]` for them rather than throwing. That empty list is
 * a finding, not a gap — `retentionSummary` reports the unreferenced types by
 * name so a reader can see how wide the check actually is instead of assuming
 * every type is guarded.
 *
 * ## Soft delete is the snapshot registry's own archive
 *
 * `softDelete` does **not** write a second mechanism. It checks the references
 * first and then delegates to `archiveSnapshot` (S1-B11), which sets
 * `archived_at`: the default view hides the version and `getSnapshot(id)` still
 * resolves it, so every id that pointed at it keeps working. "Delete" and
 * "archive" are the same flag on purpose — the difference this batch adds is
 * that *delete* asks first.
 *
 * ## There is no wipe-everything entry point here
 *
 * This module never issues `DELETE`, `DROP` or `TRUNCATE`. The one destructive
 * shape it can reach is the soft delete above, which hides one row and is
 * reversible through `restore`. A test greps the source for the bulk shapes so
 * that stays true.
 */

import {
  archiveSnapshot, getSnapshot, listSnapshots, restoreSnapshot, SNAPSHOT_OBJECT_TYPES,
} from './snapshot.js'

/**
 * Where a versioned object is pointed at from outside itself.
 *
 * `objectType` matches `snapshot_registry.object_type`. To find the referrers
 * of one snapshot, every edge with that type is read as
 * `SELECT id FROM <table> WHERE (<column> = ? OR <column> = ? ...)`, one
 * placeholder per column in `columns`.
 *
 * `columns` is a **list** because a version can be recorded under more than one
 * column name. `optimization_run` is the case that matters: v10 added
 * `rules_version`, v15 added `rule_set_version`, both hold the same rule set
 * version, `insertOptimizationRun` writes both, and **neither is backfilled**.
 * So an upgraded store's older runs have only `rules_version` set and a
 * `rule_set_version` of NULL. An edge that read one column would answer "nothing
 * references this version" for those runs — and then let the version be deleted
 * out from under a run that still points at it. Matching either column is the
 * only reading that is true of both shapes.
 *
 * `label` is what the refusal prints ("优化运行 run-1"), and `note` records why
 * this is an external consumer and not the object's own body — the distinction
 * above, written down at the one place it is decided.
 */
export const REFERENCE_EDGES = [
  {
    objectType: 'rule_set',
    table: 'optimization_run',
    columns: ['rule_set_version', 'rules_version'],
    label: '优化运行',
    note: '一次运行被它当时所依据的规则集版本判定。两列同义且都不回填：'
      + 'rule_set_version（v15）与 rules_version（v10）；升级库上更早的 run 只有后者有值。'
      + '规则行本身（rule.rule_set_version）是这一版的内容，不是引用者。',
  },
]

/** The edges that apply to one object type. An unknown type has none. */
function edgesFor(objectType) {
  return REFERENCE_EDGES.filter(edge => edge.objectType === objectType)
}

/**
 * Everything that points at one versioned object.
 *
 * Returns `[{ table, id, label, column }]` — `column` says which of the edge's
 * columns matched, which is the fact that explains why this run was found at
 * all on an upgraded store (it may be the pre-v15 name). Empty array for an
 * object type with no edge at all, and for one whose edges match nothing. It
 * never throws on an unknown type: "no known referrer" and "we know of none"
 * are the same answer here, and a caller that wants to tell them apart can read
 * `REFERENCE_EDGES`.
 *
 * The table and the column names come from the static `REFERENCE_EDGES` above,
 * never from the caller, so the identifiers interpolated into the SQL are not
 * input. The `OR` is over one row's own columns, so a run that holds the version
 * in *both* columns is still one referrer, not two.
 */
export function referencedBy(store, { objectType = null, objectId = null } = {}) {
  const type = String(objectType ?? '').trim()
  const id = String(objectId ?? '').trim()
  if (id === '') return []

  const out = []
  for (const edge of edgesFor(type)) {
    const where = edge.columns.map(column => `${column} = ?`).join(' OR ')
    const params = edge.columns.map(() => id)
    const sql = `SELECT id, ${edge.columns.join(', ')} FROM ${edge.table} WHERE ${where}`
    for (const row of store.all(sql, params)) {
      const column = edge.columns.find(name => String(row[name] ?? '') === id) ?? edge.columns[0]
      out.push({ table: edge.table, id: row.id, label: edge.label, column })
    }
  }
  return out
}

/**
 * Resolve the snapshot a retention call is about.
 *
 * By `id` when one is given (the page has the row id), otherwise by
 * `(objectType, objectId)` — and `version` narrows that when an object has more
 * than one registered version. Returns `null` for anything that cannot be
 * resolved, including an object type outside the closed vocabulary, so the
 * callers below answer "not found" instead of throwing a message the route
 * would have to translate.
 */
function resolveSnapshot(store, { objectType = null, objectId = null, id = null, version = null } = {}) {
  const snapId = id === null || id === undefined ? '' : String(id).trim()
  if (snapId !== '') return getSnapshot(store, snapId)

  const type = String(objectType ?? '').trim()
  const objId = String(objectId ?? '').trim()
  if (type === '' || objId === '' || !SNAPSHOT_OBJECT_TYPES.includes(type)) return null

  const rows = listSnapshots(store, { objectType: type, objectId: objId, includeArchived: true, limit: 1000 }).rows
  if (rows.length === 0) return null
  const wantVersion = version === null || version === undefined ? '' : String(version).trim()
  if (wantVersion === '') return rows[0]
  return rows.find(row => String(row.version ?? '') === wantVersion) ?? null
}

/** A refusal names the referrers; "you cannot delete this" is a dead end. */
function referencedError(snapshot, referrers) {
  const named = referrers.map(referrer => `${referrer.label} ${referrer.id}`).join('、')
  return `快照 ${snapshot.objectType}/${snapshot.objectId} 被 ${referrers.length} 处引用（${named}），`
    + '不能删除：先解除这些引用，或保留它。'
}

/**
 * Retire one version — unless something still points at it.
 *
 * The check runs first, and on a hit **nothing is written**: the reply carries
 * the referrer list and the snapshot is left exactly as it was. On a miss the
 * call delegates to the registry's own `archiveSnapshot`, so delete and archive
 * cannot drift about what hiding a version means.
 */
export function softDelete(store, { objectType = null, objectId = null, id = null, version = null, note = null } = {}) {
  const snapshot = resolveSnapshot(store, { objectType, objectId, id, version })
  if (snapshot === null) {
    return {
      ok: false,
      code: 'RETENTION_NOT_FOUND',
      error: `没有可删除的快照（id=${id ?? ''} type=${objectType ?? ''} object=${objectId ?? ''}）`,
      referrers: [],
    }
  }

  const referrers = referencedBy(store, { objectType: snapshot.objectType, objectId: snapshot.objectId })
  if (referrers.length > 0) {
    return {
      ok: false,
      code: 'RETENTION_REFERENCED',
      error: referencedError(snapshot, referrers),
      referrers,
    }
  }

  const result = archiveSnapshot(store, snapshot.id, { note })
  return { ok: true, changed: result.changed, snapshot: result.after, referrers: [] }
}

/**
 * Undo a soft delete: back into the default view, body untouched.
 *
 * Restoring a version that is not archived is a plain `changed: false`, not an
 * error — "already visible" and "we could not find it" are different, and only
 * the second is a refusal.
 */
export function restore(store, { objectType = null, objectId = null, id = null, version = null, note = null } = {}) {
  const snapshot = resolveSnapshot(store, { objectType, objectId, id, version })
  if (snapshot === null) {
    return {
      ok: false,
      code: 'RETENTION_NOT_FOUND',
      error: `没有可恢复的快照（id=${id ?? ''} type=${objectType ?? ''} object=${objectId ?? ''}）`,
    }
  }
  if (!snapshot.archived) return { ok: true, changed: false, snapshot }

  const result = restoreSnapshot(store, snapshot.id, { note })
  return { ok: true, changed: result.changed, snapshot: result.after }
}

/**
 * The retained list: every snapshot, with its referrers attached, so a page can
 * say *why* a row cannot be deleted without a second round trip.
 *
 * `includeDeleted` false is the default view (archived rows hidden); true shows
 * archived rows too, each still carrying its referrers — a hidden version can be
 * referenced as well, and a restore that ignores that would be the same mistake
 * in the other direction.
 */
export function listRetained(store, { objectType = null, includeDeleted = false } = {}) {
  const list = listSnapshots(store, { objectType, includeArchived: includeDeleted })
  const rows = list.rows.map(row => {
    const referrers = referencedBy(store, { objectType: row.objectType, objectId: row.objectId })
    return { ...row, referrers, referenced: referrers.length > 0 }
  })
  return { rows, matched: list.matched, total: list.total, includeDeleted }
}

/**
 * What the retention policy actually covers, computed rather than claimed.
 *
 * `referenced` counts the snapshots something points at; `deletable` is the
 * rest of the visible ones. `unreferencedTypes` names the object types with no
 * edge at all — the honest width of the check, so a reader does not assume every
 * type is guarded. The numbers are derived from `REFERENCE_EDGES` and the live
 * table, so adding an edge changes them without a second edit here.
 */
export function retentionSummary(store) {
  const all = listSnapshots(store, { includeArchived: true, limit: 1000 }).rows
  const active = all.filter(row => !row.archived)
  let referenced = 0
  for (const row of active) {
    if (referencedBy(store, { objectType: row.objectType, objectId: row.objectId }).length > 0) referenced += 1
  }
  return {
    total: all.length,
    active: active.length,
    deleted: all.length - active.length,
    referenced,
    deletable: active.length - referenced,
    edges: REFERENCE_EDGES.map(edge => ({
      objectType: edge.objectType,
      table: edge.table,
      columns: [...edge.columns],
      label: edge.label,
      note: edge.note,
    })),
    referencedTypes: SNAPSHOT_OBJECT_TYPES.filter(type => edgesFor(type).length > 0),
    unreferencedTypes: SNAPSHOT_OBJECT_TYPES.filter(type => edgesFor(type).length === 0),
  }
}

/**
 * The page's slice: the summary plus per-snapshot referrer info keyed by id, so
 * the snapshot tab can annotate rows without re-reading the table per row.
 *
 * Built lazily for the one module that draws it, like every other slice.
 */
export function retentionView(store, { objectType = null, includeDeleted = true } = {}) {
  const listed = listRetained(store, { objectType, includeDeleted })
  const byId = {}
  for (const row of listed.rows) byId[row.id] = { referenced: row.referenced, referrers: row.referrers }
  return {
    summary: retentionSummary(store),
    byId,
    includeDeleted,
  }
}
