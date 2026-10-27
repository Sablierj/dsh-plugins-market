/**
 * The audit log: the one place an `audit_log` row is written.
 *
 * ## Why this exists next to `workbench.record`
 *
 * `src/state/workbench.js`'s `record()` is the live activity feed: it pushes
 * into an in-memory array capped at 200 events, it is replayed to the browser
 * over SSE, and it is gone when the process restarts. It answers "what is
 * happening right now". It carries no before value, no after value, and no
 * contract about its payload.
 *
 * This module answers a different question — "what did this object look like
 * before, and who changed it" — and it has to survive a restart to do that. So
 * it is a table, not an array, and `record()` is left exactly as it is: the two
 * are not the same mechanism and neither replaces the other.
 *
 * ## The rules this file keeps
 *
 *   - **`recordAudit` is the only INSERT.** Nothing else writes `audit_log`,
 *     which is what makes "every write is audited" a structural claim rather
 *     than a promise each caller keeps.
 *
 *   - **No delete.** There is no `deleteAudit`, no `clearAudit`, no retention
 *     sweep. An audit row that can be removed is a row whose absence means
 *     nothing.
 *
 *   - **Redacted on the way in.** `before`, `after` and `impact` all pass
 *     through `redactAuditValue` before they are stringified, so a credential
 *     cannot reach the table by way of a new caller forgetting to mask it.
 *
 *   - **A missing action / objectType / route throws.** A row that cannot say
 *     what happened is worse than no row: it is a row a reader will trust. The
 *     caller here is always the funnel, never a user, so a throw is a bug
 *     caught at the seam rather than an error to hand back.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AUDIT_OBJECT_TYPES } from '../domain/states.js'
import { redactAuditValue } from '../domain/audit/redact.js'
import { nowIso } from './db.js'
import { getDefaultWorkspace } from './workspace.js'

/** 审计镜像文件名（与库同目录）。 */
export const AUDIT_MIRROR_FILE = 'audit.jsonl'

/** 超过这个大小就转一份 `.1`（只留一份），避免文件无声地长到几个 G。 */
export const AUDIT_MIRROR_MAX_BYTES = 8 * 1024 * 1024

/**
 * 把一行审计**镜像**到库同目录的 `audit.jsonl`。
 *
 * ## 为什么除了表还要一份文件
 *
 * `audit_log` 表回答「这个对象之前长什么样、谁改的」，但它只能通过插件自己读 ——
 * 出事的时候（进程崩了、库被锁、人在终端里），最想要的是**不依赖这个进程**就能 grep 的东西。
 * 一行的 JSONL 正好：`tail -f`、`grep`、丢给别的脚本都行。
 *
 * ## 三条硬规矩
 *
 * 1. **脱敏后的值。** 写进文件的是 `toJson()` 的产物（已经过 `redactAuditValue`），
 *    **不是**原始 `entry`。凭据不该因为「多了一个出口」而漏出去。
 * 2. **失败不阻断业务写入。** 表里那一行是权威，文件只是镜像：磁盘满 / 只读 / 权限问题
 *    都不该让一次业务操作失败。失败信息挂在返回值的 `mirrorError` 上，
 *    **不吞掉** —— 静默失败的镜像比没有镜像更坏，因为你以为它在。
 * 3. **不轮转就设上限。** 超 `AUDIT_MIRROR_MAX_BYTES` 就转成 `.1`（只留一份）。
 */
function mirrorAudit(store, row) {
  /* 没有 `file` 的 store 是测试替身：镜像不是它要验的东西，安静跳过。 */
  const file = store?.file
  if (typeof file !== 'string' || file === '') return null

  const path = join(dirname(file), AUDIT_MIRROR_FILE)
  try {
    if (existsSync(path) && statSync(path).size > AUDIT_MIRROR_MAX_BYTES) {
      renameSync(path, `${path}.1`)
    }
    const line = JSON.stringify({
      id: row.id,
      at: row.at,
      actor: row.actor,
      actorKind: row.actor_kind,
      action: row.action,
      objectType: row.object_type,
      objectId: row.object_id ?? null,
      workspaceId: row.workspace_id ?? null,
      route: row.route,
      reason: row.reason ?? null,
      sourceRunId: row.source_run_id ?? null,
      approvalId: row.approval_id ?? null,
      /* 这两列在库里是已脱敏的 JSON 文本；原样搬进文件即可，不要再拿 entry 重新序列化。 */
      before: parseJson(row.before_json),
      after: parseJson(row.after_json),
      impact: parseJson(row.impact_json),
    })
    appendFileSync(path, `${line}\n`, 'utf8')
    return null
  } catch (error) {
    return `${error?.code ?? 'ERROR'}: ${error?.message ?? String(error)}`
  }
}

/** DB row (snake_case) to the camelCase shape the page and the tool agree on. */
function toEntry(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    actorKind: row.actor_kind,
    action: row.action,
    objectType: row.object_type,
    objectId: row.object_id ?? null,
    workspaceId: row.workspace_id ?? null,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    reason: row.reason ?? null,
    sourceRunId: row.source_run_id ?? null,
    approvalId: row.approval_id ?? null,
    impact: parseJson(row.impact_json),
    route: row.route,
  }
}

/** A stored JSON column back to a value. An unreadable one stays null. */
function parseJson(text) {
  if (text === null || text === undefined || text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A value to a JSON column, redacted first. `null` stays `NULL`, not `'null'`. */
function toJson(value) {
  if (value === undefined || value === null) return null
  return JSON.stringify(redactAuditValue(value))
}

/** The workspace a write belongs to: the default one, or null if there is none. */
function defaultWorkspaceId(store) {
  const row = getDefaultWorkspace(store)
  return row === undefined || row === null ? null : row.id
}

/**
 * Write one audit row and return it.
 *
 * `entry` carries the descriptor's answers plus the funnel's own:
 *   action, objectType, objectId, before, after, impact,
 *   route, actorKind, reason, sourceRunId, approvalId.
 *
 * `actor` is always 'local' in phase 1 — there is no user table (Q4) — and it
 * is written here rather than passed in so a caller cannot invent an actor.
 */
export function recordAudit(store, entry = {}) {
  const action = String(entry.action ?? '').trim()
  const objectType = String(entry.objectType ?? '').trim()
  const route = String(entry.route ?? '').trim()
  if (action === '') throw new Error('audit_log.action is required')
  if (objectType === '') throw new Error('audit_log.objectType is required')
  if (route === '') throw new Error('audit_log.route is required')
  /* The vocabulary check lives here rather than in a CHECK constraint: the enum
     is the domain's, and a table that froze its own copy would go on accepting
     a type the domain had retired. */
  if (!AUDIT_OBJECT_TYPES.includes(objectType)) {
    throw new Error(`audit_log.objectType "${objectType}" is not one of AUDIT_OBJECT_TYPES`)
  }

  const id = `audit-${randomUUID()}`
  const at = nowIso()
  store.run(
    `INSERT INTO audit_log
       (id, at, actor, actor_kind, action, object_type, object_id, workspace_id,
        before_json, after_json, reason, source_run_id, approval_id, impact_json, route)
     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      at,
      String(entry.actorKind ?? 'system'),
      action,
      objectType,
      entry.objectId === undefined || entry.objectId === null ? null : String(entry.objectId),
      entry.workspaceId === undefined || entry.workspaceId === null
        ? defaultWorkspaceId(store)
        : String(entry.workspaceId),
      toJson(entry.before),
      toJson(entry.after),
      entry.reason === undefined || entry.reason === null ? null : String(entry.reason),
      entry.sourceRunId === undefined || entry.sourceRunId === null ? null : String(entry.sourceRunId),
      entry.approvalId === undefined || entry.approvalId === null ? null : String(entry.approvalId),
      toJson(entry.impact),
      route,
    ],
  )
  const row = store.get('SELECT * FROM audit_log WHERE id = ?', [id])
  const written = toEntry(row)
  /* 文件镜像是附加物：它失败不影响这次写入已经成功的事实，但必须报出来。 */
  const mirrorError = mirrorAudit(store, row)
  if (mirrorError !== null) written.mirrorError = mirrorError
  return written
}

/**
 * The audit rows, newest first, optionally filtered.
 *
 * `from` / `to` are ISO strings compared as text, which is the same ordering the
 * `at` column already sorts by — no date parsing, so a malformed bound filters
 * to nothing rather than throwing inside a read.
 */
export function listAudit(store, filters = {}) {
  const where = []
  const params = []
  const add = (column, value) => {
    if (value === undefined || value === null || value === '') return
    where.push(`${column} = ?`)
    params.push(String(value))
  }
  add('action', filters.action)
  add('object_type', filters.objectType)
  add('object_id', filters.objectId)
  add('actor_kind', filters.actorKind)
  if (filters.from !== undefined && filters.from !== null && filters.from !== '') {
    where.push('at >= ?')
    params.push(String(filters.from))
  }
  if (filters.to !== undefined && filters.to !== null && filters.to !== '') {
    where.push('at <= ?')
    params.push(String(filters.to))
  }

  const limit = Math.min(Math.max(Number(filters.limit ?? 100) || 100, 1), 1000)
  const rows = store.all(
    `SELECT * FROM audit_log
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY at DESC, id DESC
      LIMIT ?`,
    [...params, limit],
  )
  return rows.map(toEntry)
}

/**
 * Counts for the audit view's header.
 *
 * Derived from one read of the table rather than three queries that could
 * disagree about which rows are in scope.
 */
export function auditStats(store) {
  const rows = store.all('SELECT action, actor_kind FROM audit_log')
  const byAction = {}
  const byActorKind = {}
  for (const row of rows) {
    byAction[row.action] = (byAction[row.action] ?? 0) + 1
    byActorKind[row.actor_kind] = (byActorKind[row.actor_kind] ?? 0) + 1
  }
  return { total: rows.length, byAction, byActorKind }
}
