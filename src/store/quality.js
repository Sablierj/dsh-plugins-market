/**
 * The quality issue list: the one place a `dq_issue` row is written.
 *
 * Three things live here and only here:
 *
 *   - **The idempotent upsert.** A scan runs over the whole store and produces
 *     the findings that are true *right now*; writing them must not append a
 *     second copy of every problem on the second run. The natural key
 *     (`rule_id, object_type, object_id, field`, with NULL folded to empty) is a
 *     UNIQUE index, so "one issue, one row" is structural rather than a promise
 *     the code keeps by looking first. Re-scanning updates the message and the
 *     detection time; it never changes the row count.
 *
 *   - **The state machine's only door.** `setIssueStatus` is the sole writer of
 *     `status`, and it consults `canTransition` (domain/states.js). A move the
 *     machine does not have is refused with `DQ_ILLEGAL_TRANSITION` **and no
 *     write** — a status column that accepts anything is a status nobody can
 *     branch on.
 *
 *   - **The scan orchestration.** `runQualityScan` joins the pure `scan`
 *     (domain/data/quality-rules.js) to the upsert, so the read rules and the
 *     write path cannot disagree about what was found.
 *
 * ## A re-scan updates, it does not reopen
 *
 * An `acknowledged` issue stays `acknowledged` when the next scan finds it again:
 * the finding persisting is not the same event as the status changing, and
 * letting a scan reset the state would mean a resolved issue could never stay
 * resolved while its fix was still queued behind another one. The machine's
 * terminal states are terminal; the way out is a new issue, which the natural key
 * deliberately does not create — because a problem that is genuinely still there
 * is the *same* problem, and pretending otherwise is how a list of 40 open issues
 * becomes unreadable.
 */

import { randomUUID } from 'node:crypto'

import { DQ_ISSUE_STATUSES, PROBLEM_CODES, SEVERITIES, canTransition } from '../domain/states.js'
import { scan } from '../domain/data/quality-rules.js'
import { nowIso } from './db.js'

/** DB row (snake_case) → the camelCase object the page, tool and tests agree on. */
function toIssue(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    ruleId: row.rule_id,
    dimension: row.dimension,
    severity: row.severity,
    status: row.status,
    objectType: row.object_type,
    objectId: row.object_id,
    field: row.field ?? null,
    message: row.message,
    workspaceId: row.workspace_id ?? null,
    assignee: row.assignee ?? null,
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
    note: row.note ?? null,
  }
}

/**
 * Write one finding, creating it or refreshing the existing row.
 *
 * The lookup uses `field IS ?`, not `field = ?`: with `=`, a NULL field never
 * matches anything (NULL = NULL is NULL, not true), and every object-level issue
 * would be inserted fresh on every scan — the exact silent doubling the UNIQUE
 * index exists to prevent.
 */
export function upsertIssue(store, finding, { workspaceId = 'ws-default' } = {}) {
  const ruleId = String(finding?.ruleId ?? '').trim()
  const objectType = String(finding?.objectType ?? '').trim()
  const objectId = String(finding?.objectId ?? '').trim()
  const field = finding?.field === undefined || finding.field === null ? null : String(finding.field)
  if (ruleId === '') throw new Error('dq_issue.ruleId is required')
  if (objectType === '') throw new Error('dq_issue.objectType is required')
  if (objectId === '') throw new Error('dq_issue.objectId is required')

  const severity = String(finding?.severity ?? '').trim()
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`dq_issue.severity must be one of: ${SEVERITIES.join(' | ')} (got ${JSON.stringify(finding?.severity)})`)
  }
  const message = String(finding?.message ?? '').trim()
  if (message === '') throw new Error('dq_issue.message is required')

  const now = nowIso()
  const existing = store.get(
    `SELECT * FROM dq_issue
      WHERE rule_id = ? AND object_type = ? AND object_id = ? AND field IS ?`,
    [ruleId, objectType, objectId, field],
  )

  if (existing !== undefined) {
    store.run(
      `UPDATE dq_issue
          SET dimension = ?, severity = ?, message = ?, detected_at = ?, updated_at = ?
        WHERE id = ?`,
      [finding.dimension ?? existing.dimension, severity, message, now, now, existing.id],
    )
    return { id: existing.id, created: false, issue: toIssue(store.get('SELECT * FROM dq_issue WHERE id = ?', [existing.id])) }
  }

  const id = `dq-${randomUUID()}`
  store.run(
    `INSERT INTO dq_issue
       (id, rule_id, dimension, severity, status, object_type, object_id, field, message,
        workspace_id, assignee, detected_at, updated_at, note)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    [
      id, ruleId, String(finding.dimension ?? '').trim(), severity,
      objectType, objectId, field, message,
      workspaceId, now, now,
    ],
  )
  return { id, created: true, issue: toIssue(store.get('SELECT * FROM dq_issue WHERE id = ?', [id])) }
}

/**
 * Run every rule and persist the findings. Idempotent by construction: the second
 * run over an unchanged store updates rows and inserts none.
 */
export function runQualityScan(store, scope = {}, { workspaceId = 'ws-default' } = {}) {
  const findings = scan(store, scope)
  let created = 0
  let updated = 0
  for (const finding of findings) {
    const result = upsertIssue(store, finding, { workspaceId })
    if (result.created) created += 1
    else updated += 1
  }

  /* ── 2026-10-25（R-16，**我第一版改错了，被 t6 当场拦住**）────────────────
     实测：`listing.title` 在 10-25 写进了真标题（74 字符），但 10-22 报的
     「Listing 标题为空」仍是 `open`，数据质量报告照样把它列在最上面 ——
     读者会去修一个已经不存在的问题。

     我第一版的修法：扫描时把「本轮没再发现」的 `open` 自动改成 `resolved`。
     **这是错的**，`tests/t6-variant-dq.mjs:516-524` 把这条边界钉死了，原话：

       「那一行**不消失**（扫描只 upsert）… 把这条边界钉死，
         比假装它能自己关掉更诚实：处置动作是**人**标已解决。」

     设计者是对的，我的理由更弱：`dq_issue` 记的是「**曾经发现过**」，
     而 `resolved` 是**人的判断**（"我确认修好了"）。扫描替人下这个判断，
     等于给一个没人确认过的结论盖章。

     正确的修法：**只报告，不动状态** —— 把「本轮没再发现」的清单交出去，
     让报告能说「这条已经不再成立，但状态还是 open，等你确认」。 */
  /* 这里**不**加「本轮有发现才算」的前置条件。我第一版加了，写测试时才发现它错：
     那个条件会让「扫描器正常、但库里确实干净」的场合一条提醒都不给 ——
     而这正是读者最需要知道「那些老问题是不是已经不成立了」的时候。
     反过来，「扫描器坏了 → 全部提醒」的代价只是**多看两眼**，
     而「关闭」的代价是**替人盖章**。**提醒总是安全的，关闭才危险。** */
  const notSeenAgain = []
  const seen = new Set(findings.map(finding =>
    [finding.ruleId, finding.objectType, finding.objectId, finding.field ?? ''].join('|')))
  for (const row of store.all("SELECT id, rule_id, object_type, object_id, field FROM dq_issue WHERE status = 'open'")) {
    const key = [row.rule_id, row.object_type, row.object_id, row.field ?? ''].join('|')
    if (seen.has(key)) continue
    notSeenAgain.push({ id: row.id, ruleId: row.rule_id, objectType: row.object_type, objectId: row.object_id, field: row.field })
  }

  return {
    scanned: findings.length,
    created,
    updated,
    /* 「本轮没再发现」不是「已解决」——它只是「按当前数据算不出来」。
       状态由人改；这里只把线索交出去。 */
    notSeenAgain,
    total: store.get('SELECT COUNT(*) AS n FROM dq_issue')?.n ?? 0,
  }
}

/** One issue by id, camelCased, or `null`. */
export function getIssue(store, id) {
  return toIssue(store.get('SELECT * FROM dq_issue WHERE id = ?', [String(id ?? '').trim()]))
}

/**
 * The issues, worst-first, optionally filtered.
 *
 * Severity is ordered `block` before `warn` before `info` with a CASE rather than
 * alphabetically, because "info before warn" is a list where the reader's eye
 * lands on the wrong row first.
 */
export function listIssues(store, filters = {}) {
  const where = []
  const params = []
  const add = (column, value) => {
    if (value === undefined || value === null || value === '') return
    where.push(`${column} = ?`)
    params.push(String(value))
  }
  add('status', filters.status)
  add('severity', filters.severity)
  add('dimension', filters.dimension)
  add('object_type', filters.objectType)
  add('object_id', filters.objectId)

  const rows = store.all(
    `SELECT * FROM dq_issue
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE severity WHEN 'block' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
               detected_at DESC, rule_id ASC`,
    params,
  )
  return rows.map(toIssue)
}

/**
 * Move one issue along the state machine, or refuse.
 *
 * Returns `{ ok:false, code:'DQ_ILLEGAL_TRANSITION' }` for every edge the machine
 * does not have — including a move to the same state (a no-op, not a transition)
 * and a move from a terminal state. A missing issue is a different refusal with
 * no machine code: it is not an illegal transition, it is a row that is not
 * there, and conflating the two would let a typo'd id look like a state error.
 */
export function setIssueStatus(store, { id, to, note = null, assignee = null } = {}) {
  const key = String(id ?? '').trim()
  const next = String(to ?? '').trim()
  if (key === '') return { ok: false, error: 'id 为空' }

  const row = store.get('SELECT * FROM dq_issue WHERE id = ?', [key])
  if (row === undefined) return { ok: false, error: `找不到问题 ${key}` }

  if (!DQ_ISSUE_STATUSES.includes(next) || !canTransition(row.status, next)) {
    return {
      ok: false,
      code: PROBLEM_CODES.DQ_ILLEGAL_TRANSITION,
      error: `非法迁移：${row.status} → ${next || '(空)'}`,
      hint: `允许的迁移见 domain/states.js 的 DQ_ISSUE_TRANSITIONS。`,
    }
  }

  const now = nowIso()
  store.run(
    `UPDATE dq_issue
        SET status = ?, note = COALESCE(?, note), assignee = COALESCE(?, assignee), updated_at = ?
      WHERE id = ?`,
    [next, note === null ? null : String(note), assignee === null ? null : String(assignee), now, key],
  )
  return { ok: true, before: row.status, after: next, issue: toIssue(store.get('SELECT * FROM dq_issue WHERE id = ?', [key])) }
}

/**
 * Counts for the cockpit header.
 *
 * `total` is a plain count of rows; the three breakdowns are derived from the one
 * table rather than from three queries that could disagree about which rows are
 * in scope.
 */
export function issueStats(store) {
  const rows = store.all('SELECT status, severity, dimension FROM dq_issue')
  const byStatus = {}
  const bySeverity = {}
  const byDimension = {}
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + 1
    byDimension[row.dimension] = (byDimension[row.dimension] ?? 0) + 1
  }
  return { total: rows.length, byStatus, bySeverity, byDimension }
}
