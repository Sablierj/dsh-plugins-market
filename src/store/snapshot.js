/**
 * The snapshot registry: one index of every versioned object the workbench can
 * point at, so "the version this run referenced" stays answerable forever.
 *
 * The versioned object types live in `SNAPSHOT_OBJECT_TYPES` (§3.0.1). All of
 * them are real; `context_package` is the one type this version deliberately
 * does **not** register a row for — and the reason is no longer "the Agent plane
 * is not wired up" (that reason went stale the day module 12 shipped:
 * `agent_run` / `agent_step` / `agent_artifact` exist, the tools are registered,
 * and the page has the view). The context package is real and frozen: it is the
 * four immutable columns on `agent_run` (§17-3 fixes four of §4's ten items and
 * calls the rest 占位). A run does not get a `context_package` snapshot row
 * because a context package is a **field of a run**, not an independently
 * versioned object — the run row already answers 「这次用了哪一版规则 / Prompt」,
 * and a second name for the same fact is the drift this registry refuses. See
 * `SNAPSHOT_PENDING_REASONS`, the one place that reason is written. The page
 * prints it rather than hiding the category, because a category that is absent
 * reads as "snapshots do not cover it".
 *
 * The discipline is the same as the report registry (`store/reports.js`, §3.6):
 * **an index, not a second copy.** A snapshot row points at the table that owns
 * the body; only a *mutable* object (a competitor set, the keyword master) gets a
 * frozen `payload_json`, because the row it points at is overwritten in place and
 * a pointer to it would drift. The one invariant is that a row must be readable
 * one way or the other: a `ref_id` pointer, or a payload. A row with neither can
 * be listed and never opened — the silent-empty shape this project keeps
 * refusing, checked here at the one boundary every writer crosses.
 *
 * New data **appends a version**; it never overwrites one. `registerSnapshot`
 * therefore always inserts a new row: a second registration of the same object
 * is a second version (auto-numbered when the caller does not name one), and an
 * explicit version that already exists is refused rather than silently merged.
 * The current value of an object is the *choice of which version you read*, not
 * a deletion of the others.
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'
import { SNAPSHOT_OBJECT_TYPES } from '../domain/states.js'
import { diffPayloads } from '../domain/snapshot/diff.js'

/* Re-exported so a reader of this module does not have to know that the closed
   vocabulary lives in `domain/states.js` — it is the same list either way. */
export { SNAPSHOT_OBJECT_TYPES }

/** Human labels for the tabs. A type with no entry falls back to its own id. */
export const SNAPSHOT_TYPE_LABELS = {
  listing: 'Listing 快照',
  kw_master: '关键词总库',
  competitor_set: '竞品组',
  rule_set: '规则集',
  prompt_set: '提示词集',
  /* B-11.2b：单条提示词的**保存前正文**。与 `prompt_set` 不同 —— set 的正文不会被
     就地覆盖，单行 `prompt.body` 会，所以冻结的是行本身（payload，不是指针）。 */
  prompt: '提示词',
  draft: '优化草案',
  context_package: '上下文包',
}

/**
 * The declared types this version deliberately does **not** register a row for.
 *
 * `pending` here means 「本版不登记行」, **not** 「未接入」 —— the `context_package`
 * Agent plane is delivered (see `SNAPSHOT_PENDING_REASONS`). The name is kept so a
 * reader can tell "declared, and this version has no row for it" apart from
 * "declared and forgot", and the page still shows the category rather than hiding
 * it.
 */
export const PENDING_SNAPSHOT_TYPES = ['context_package']

/**
 * Why a declared-but-unregistered type has no row — **the one place** that reason
 * is written.
 *
 * 模块 12 交付后，`context_package` 的理由不再是「Agent 平面没接入」：那个理由已经
 * 过期了 —— `agent_run` / `agent_step` / `agent_artifact` 三张表都在，工具已注册，
 * 页面也有视图。上下文包是**真的、被冻结的**：它就是 `agent_run` 上的**七个**不可变项
 * （§17-3 固定了 §4 十项里的**七项**，其余仍占位 —— 成本上限那一类**没有来源**，
 * 不是「占位等着填」）。
 *
 * **哪七项，以及判据**：在 `startRun` 里**写一次、之后没有任何写入路径改它们**的
 * `agent_run` 列，就是上下文包的一部分 —— 对象范围（`scope_json`）、数据快照
 * （`data_snapshot_json`）、规则快照（`rules_snapshot_json`）、Prompt 快照
 * （`prompts_snapshot_json`）、角色配置版本（`role_config_version` + `role_config_json`，
 * F12-02）、人工约束（`human_constraint`，F12-03）、输出格式（`output_format`，F12-03）。
 * ⚠️ `supersedes_run_id`（F12-09）**不算**：它是**溯源指针**（指向上一次运行），
 * 不在这次运行的内容里 —— 「这次用什么跑的」与「这次取代了谁」是两件事。
 *
 * 本版**不**为每次运行登记一条 `context_package` 快照行，理由是**设计**而不是机制：
 * 上下文包是**一次运行的字段**，不是一个独立版本化的对象。运行行本身已经回答了
 * 「这次用了哪一版规则 / Prompt」，再登记一条同名快照就是 `snapshot_registry` 一直
 * 拒绝的那种「同一件事的第二个名字」。（`registerSnapshot` 既能接一个指向 `agent_run`
 * 的指针、也能接一份 payload，两条路在机制上都合法 —— 这里拒绝的是设计。）
 *
 * 这份理由由 `snapshotView` 带进页面的 `objectTypes[].pendingReason`，页面渲染**它**
 * 而不是自己写一句 —— 一句事实活在两个文件里，就是本仓已经记过的那条教训。
 */
export const SNAPSHOT_PENDING_REASONS = {
  context_package: '本版不登记行（不是「未接入」）：上下文包是 agent_run 上的七个不可变项'
    + '（对象范围 / 数据快照 / 规则快照 / Prompt 快照 / 角色配置版本 / 人工约束 / 输出格式，§17-3 —— '
    + '其余项仍占位，其中成本上限那一类**没有来源**），是**一次运行的字段**而不是一个'
    + '独立版本化的对象 —— 运行行本身已回答「这次用了哪一版」，再登记一条同名快照就是同一个'
    + '事实的第二个名字。',
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/**
 * The next version for an object when the caller does not name one.
 *
 * The schema's version is a free-form label (a rule set's is `v1`, a listing
 * collection's is its snapshot id), so "next" has to cope with labels that are
 * not numbers. It takes the larger of the highest numeric label and the row
 * count, plus one: every existing row is either a number ≤ the numeric max or a
 * non-number the count already accounts for, so the result collides with
 * neither. New data appends; it does not reuse a version that is on record.
 */
function nextVersion(store, objectType, objectId) {
  const row = store.get(
    `SELECT COUNT(*) AS n, MAX(CAST(version AS INTEGER)) AS top
       FROM snapshot_registry WHERE object_type = ? AND object_id = ?`,
    [objectType, objectId],
  )
  const count = Number(row?.n ?? 0)
  const top = Number(row?.top ?? 0)
  const base = Math.max(Number.isFinite(top) ? top : 0, Number.isFinite(count) ? count : 0)
  return String(base + 1)
}

/**
 * Register one snapshot. Returns the stored row.
 *
 * The object type is checked against the closed set, and the pointer invariant
 * is checked here, both **by name** — a snapshot that cannot be read is refused
 * at write time rather than discovered when someone clicks it.
 */
export function registerSnapshot(store, record = {}) {
  const objectType = String(record.objectType ?? '').trim()
  if (!SNAPSHOT_OBJECT_TYPES.includes(objectType)) {
    throw new Error(`unknown snapshot object type "${objectType}" — known: ${SNAPSHOT_OBJECT_TYPES.join(', ')}`)
  }

  const objectId = String(record.objectId ?? '').trim()
  if (objectId === '') {
    throw new Error(`snapshot "${objectType}" needs an objectId — a snapshot of nothing cannot be listed or read`)
  }

  const refTable = blankToNull(record.refTable)
  const refId = blankToNull(record.refId)
  const payload = record.payload === undefined ? null : record.payload
  const hasPayload = payload !== null && payload !== undefined

  /* The invariant. A row that points at nothing and freezes nothing is listable
     and unopenable. */
  if (refId === null && !hasPayload) {
    throw new Error(
      `snapshot "${objectType}" needs a refId pointer or a payload — a row with neither can be listed but never read`,
    )
  }
  if (refTable !== null && refId === null) {
    throw new Error('refTable without refId names a table but not a row')
  }

  const explicitVersion = blankToNull(record.version)
  if (explicitVersion !== null) {
    const existing = store.get(
      'SELECT id FROM snapshot_registry WHERE object_type = ? AND object_id = ? AND version = ?',
      [objectType, objectId, explicitVersion],
    )
    if (existing !== undefined && existing !== null) {
      throw new Error(
        `snapshot ${objectType}/${objectId} version "${explicitVersion}" already exists — new data appends a version, it does not overwrite history`,
      )
    }
  }
  const version = explicitVersion ?? nextVersion(store, objectType, objectId)

  const id = blankToNull(record.id) ?? randomUUID()
  store.run(
    `INSERT INTO snapshot_registry
       (id, object_type, object_id, version, ref_table, ref_id, payload_json,
        created_at, created_by, archived_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, objectType, objectId, version, refTable, refId,
      hasPayload ? JSON.stringify(payload) : null,
      record.createdAt ?? nowIso(),
      record.createdBy ?? null,
      null,
      record.note ?? null,
    ],
  )
  return getSnapshot(store, id)
}

export function hydrateSnapshot(row) {
  const payload = parseJson(row.payload_json, null)
  return {
    id: row.id,
    objectType: row.object_type,
    objectId: row.object_id,
    version: row.version ?? null,
    refTable: row.ref_table ?? null,
    refId: row.ref_id ?? null,
    payload,
    createdAt: row.created_at,
    createdBy: row.created_by ?? null,
    archivedAt: row.archived_at ?? null,
    note: row.note ?? null,
    archived: row.archived_at !== null && row.archived_at !== undefined,
    /* Whether the body is reachable: a frozen copy is always readable, a
       pointer says its table/row are recorded. The page prints this rather than
       discovering it on click. */
    readable: payload !== null || row.ref_id !== null,
    /* Whether the two versions could be compared field by field. Only a frozen
       payload can; a pure pointer has no body to diff. */
    comparable: payload !== null && typeof payload === 'object',
  }
}

/**
 * One snapshot by id, **including archived ones**.
 *
 * This is the whole point of archiving being a flag rather than a delete: a run
 * that referenced version 3 can still resolve it after someone hid it from the
 * default list. There is no `includeArchived` here on purpose.
 */
export function getSnapshot(store, id) {
  const row = store.get('SELECT * FROM snapshot_registry WHERE id = ?', [String(id ?? '').trim()])
  return row === undefined || row === null ? null : hydrateSnapshot(row)
}

/**
 * The list the snapshot page draws.
 *
 * The default view is `archived_at IS NULL` — archived versions are hidden here
 * and nowhere else. `objectType` and `objectId` are plain columns; the type is
 * validated against the closed set so a typo filters to nothing loudly rather
 * than silently (a filter that matches nothing already warns at the call site).
 */
export function listSnapshots(store, { objectType = null, objectId = null, includeArchived = false, limit = 200 } = {}) {
  const where = []
  const params = []
  if (objectType !== null && objectType !== '') {
    const type = String(objectType)
    if (!SNAPSHOT_OBJECT_TYPES.includes(type)) {
      throw new Error(`unknown snapshot object type "${type}" — known: ${SNAPSHOT_OBJECT_TYPES.join(', ')}`)
    }
    where.push('object_type = ?')
    params.push(type)
  }
  if (objectId !== null && objectId !== '') {
    where.push('object_id = ?')
    params.push(String(objectId))
  }
  if (!includeArchived) where.push('archived_at IS NULL')

  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 200), 1), 1000)
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const rows = store.all(
    `SELECT * FROM snapshot_registry
     ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [...params, cap],
  )
  return {
    rows: rows.map(hydrateSnapshot),
    /* `matched` is the filtered count; `total` is the whole table. The page needs
       both: `matched` says whether a filter is hiding anything, `total` is what
       "库内共 N 条" means when a type tab is empty. */
    matched: Number(store.get(`SELECT COUNT(*) AS n FROM snapshot_registry ${whereSql}`, params)?.n ?? 0),
    total: Number(store.get('SELECT COUNT(*) AS n FROM snapshot_registry')?.n ?? 0),
    limit: cap,
  }
}

/** Counts per object type, so the tabs can be drawn without a query each. */
export function snapshotCounts(store) {
  const out = Object.fromEntries(SNAPSHOT_OBJECT_TYPES.map(type => [type, 0]))
  for (const row of store.all('SELECT object_type, COUNT(*) AS n FROM snapshot_registry GROUP BY object_type')) {
    if (row.object_type in out) out[row.object_type] = Number(row.n)
  }
  return { ...out, total: Object.values(out).reduce((sum, n) => sum + n, 0) }
}

/**
 * Hide a version from the default view **without breaking history**.
 *
 * Archiving is idempotent: a second call keeps the first `archived_at`, because
 * the timestamp records when it was hidden and re-stamping it would lie about
 * that. The row and its pointer/payload are untouched, so every id that pointed
 * at it still resolves through `getSnapshot`.
 */
export function archiveSnapshot(store, id, { at = null, note = null } = {}) {
  const before = getSnapshot(store, id)
  if (before === null) throw new Error(`no snapshot with id "${id}"`)
  if (before.archived) return { changed: false, before, after: before }
  store.run(
    'UPDATE snapshot_registry SET archived_at = ?, note = COALESCE(?, note) WHERE id = ?',
    [at ?? nowIso(), note, before.id],
  )
  return { changed: true, before, after: getSnapshot(store, before.id) }
}

/**
 * Bring a hidden version back into the default view — the inverse of
 * `archiveSnapshot`, and deliberately the same size.
 *
 * It clears `archived_at` and touches nothing else: the pointer or payload
 * stays where it was, so a restore cannot resurrect a different body than the
 * one that was hidden. Like archiving it is idempotent in the harmless
 * direction — a version that is already visible comes back as
 * `{ changed: false }` with its current row, not as an error.
 */
export function restoreSnapshot(store, id, { note = null } = {}) {
  const before = getSnapshot(store, id)
  if (before === null) throw new Error(`no snapshot with id "${id}"`)
  if (!before.archived) return { changed: false, before, after: before }
  store.run(
    'UPDATE snapshot_registry SET archived_at = NULL, note = COALESCE(?, note) WHERE id = ?',
    [note, before.id],
  )
  return { changed: true, before, after: getSnapshot(store, before.id) }
}

/**
 * The field-level diff between two frozen snapshots.
 *
 * Returns the `{ field, before, after }` array itself — the acceptance criterion
 * is "a field-level array, not one line saying it changed", so the array is the
 * whole answer. A pointer snapshot has no frozen body to compare, and inventing
 * an empty diff for it would read as "identical"; that case is refused by name.
 */
export function diffSnapshots(store, idA, idB) {
  const left = getSnapshot(store, idA)
  if (left === null) throw new Error(`no snapshot with id "${idA}"`)
  const right = getSnapshot(store, idB)
  if (right === null) throw new Error(`no snapshot with id "${idB}"`)
  if (!left.comparable || !right.comparable) {
    throw new Error(
      'diffSnapshots compares frozen payloads only — a pointer snapshot has no body here (read the ref table instead)',
    )
  }
  return diffPayloads(left.payload, right.payload)
}

/**
 * Attach each row's field-level diff against the **previous version of the same
 * object** (the next row down the list, which is older).
 *
 * The compare view needs a diff, and computing it here rather than in the page
 * keeps one definition of "what counts as a change" (`diffPayloads`) — the page
 * has no module system to import it with, and a second copy there would drift.
 * A row with no older sibling gets `previousId: null`; a pair where either side
 * is a pointer (no frozen body) gets `changes: null` and the page says why.
 */
function withPreviousDiffs(rows) {
  const out = rows.map(row => ({ ...row, previousId: null, changes: null }))
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      if (out[j].objectType === out[i].objectType && out[j].objectId === out[i].objectId) {
        out[i].previousId = out[j].id
        if (out[i].comparable && out[j].comparable) {
          out[i].changes = diffPayloads(out[j].payload, out[i].payload)
        }
        break
      }
    }
  }
  return out
}

/**
 * The snapshot page's data slice: the list, the per-type counts, and the tab
 * vocabulary (with `pending` flagging the one type that is declared, not wired).
 *
 * Built server-side for the same reason `reportState` is: the page must not own
 * a second copy of which types exist or which one is still pending.
 */
export function snapshotView(store, filters = {}) {
  const objectType = blankToNull(filters.snapshotType)
  const objectId = blankToNull(filters.snapshotObjectId)
  const includeArchived = filters.snapshotArchived === true || filters.snapshotArchived === 'true'
  const list = listSnapshots(store, { objectType, objectId, includeArchived })

  return {
    rows: withPreviousDiffs(list.rows),
    total: list.total,
    counts: snapshotCounts(store),
    objectTypes: SNAPSHOT_OBJECT_TYPES.map(type => ({
      id: type,
      label: SNAPSHOT_TYPE_LABELS[type] ?? type,
      pending: PENDING_SNAPSHOT_TYPES.includes(type),
      /* 为什么这一类本版不登记行 —— 单一来源在这里，页面只渲染这个值，不自己写一句。 */
      pendingReason: PENDING_SNAPSHOT_TYPES.includes(type) ? (SNAPSHOT_PENDING_REASONS[type] ?? null) : null,
    })),
    pendingTypes: [...PENDING_SNAPSHOT_TYPES],
    filters: {
      type: objectType ?? '',
      objectId: objectId ?? '',
      includeArchived,
    },
  }
}
