/**
 * `amzn_audit_query` — the read half of the audit log.
 *
 * The log itself has one writer (`recordAudit`, reached by the two funnels) and
 * no delete. That is deliberate, and it means the only thing left to build is a
 * way to *read* it: without a reader, "every write is audited" is a claim about
 * a table nobody can see.
 *
 * ## What this tool will not do
 *
 * It does not summarise a change into "有变化". The whole reason the log stores
 * a before and an after is so a reader can see *which field* moved and what it
 * moved from — a row that says "changed" is a row that answers nothing, and the
 * page's audit view makes the same refusal.
 *
 * It also does not pretend the log is complete. There is no backfill: rows only
 * exist for writes that happened after the log was introduced. A query that
 * returns nothing means "nothing was written since then", never "nothing was
 * ever written" — and the answer says so rather than letting an empty table
 * imply a clean history.
 *
 * Read-only. It is declared `null` in `WRITE_TARGETS`, which is the file that
 * decides such things.
 */

import { num, table, text, truncate } from './render.js'
import { auditStats, listAudit } from '../store/audit.js'

const ACTOR_LABELS = { agent: 'Agent', page: '页面', system: '系统' }

export function auditQueryTool({ store }) {
  return {
    name: 'amzn_audit_query',
    description:
      'Read the global audit log: every write that reached the database, with what the object looked like before and after. '
      + 'Filter by action, object type, object id, actor kind (agent / page / system), or a time range. '
      + 'Returns the newest rows first. '
      + 'Use it to answer "who changed this, and what did it look like before" — for a setting, an ASIN, a rule, a workspace, '
      + 'a quality issue, or anything else the plugin writes. '
      + 'The log has no backfill: it only holds writes that happened after it was introduced, so an empty result means '
      + '"nothing was written since then", not "nothing was ever written".',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Exact action, e.g. setting.set, asin.upsert, dq_issue.status.' },
        objectType: { type: 'string', description: 'Exact object type, e.g. setting, asin, rule, workspace, dq_issue.' },
        objectId: { type: 'string', description: 'Exact object id, e.g. a setting key, an ASIN, a workspace id.' },
        actorKind: { type: 'string', enum: ['agent', 'page', 'system'], description: 'Who wrote it: the agent plane, the page, or the system.' },
        from: { type: 'string', description: 'ISO timestamp; only rows at or after it.' },
        to: { type: 'string', description: 'ISO timestamp; only rows at or before it.' },
        limit: { type: 'number', description: 'How many rows, newest first. Default 50, max 500.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const filters = {
        action: args?.action,
        objectType: args?.objectType,
        objectId: args?.objectId,
        actorKind: args?.actorKind,
        from: args?.from,
        to: args?.to,
        limit: clampLimit(args?.limit),
      }

      const rows = listAudit(store, filters)
      const stats = auditStats(store)
      const narrowed = Object.entries(filters)
        .some(([key, value]) => key !== 'limit' && value !== undefined && value !== null && value !== '')

      const head = [
        `审计日志: 库内共 ${num(stats.total)} 条${narrowed ? `，本次条件命中 ${num(rows.length)} 条` : ''}`,
        `来源: Agent 平面 ${num(stats.byActorKind.agent ?? 0)} 条，页面 ${num(stats.byActorKind.page ?? 0)} 条`
          + `${stats.byActorKind.system ? `，系统 ${num(stats.byActorKind.system)} 条` : ''}`,
      ]

      if (stats.total === 0) {
        head.push('', '日志是空的。它不回填历史 —— 只有日志上线之后发生的写才会有行，'
          + '所以「空」是「这段时间没有写」，不是「从来没人写过」。')
        return head.join('\n')
      }

      if (rows.length === 0) {
        head.push('', '这个筛选条件下没有行。放宽条件再试 —— 不要把它读成「这个对象没被改过」：'
          + `库内共有 ${num(stats.total)} 条。`)
        return head.join('\n')
      }

      const body = table(rows, [
        { label: '时间', value: row => shortTime(row.at) },
        { label: '动作', value: row => row.action },
        { label: '对象', value: row => `${row.objectType}${row.objectId === null ? '' : `:${truncate(row.objectId, 28)}`}` },
        { label: '变更', value: row => truncate(describeChange(row.before, row.after), 72) },
        { label: '谁', value: row => ACTOR_LABELS[row.actorKind] ?? row.actorKind },
        { label: '入口', value: row => row.route },
      ])

      return [
        ...head,
        '',
        body,
        '',
        '「变更」是字段级的前值 → 后值：一个只写「有变化」的审计行回答不了任何问题。',
        '凭据在写入时就被掩码（值换成掩码，字段名保留），所以这里看到的永远是掩码，不是原值。',
        '日志只记成功的写：失败或被拒的调用不留行 —— 记一条没发生的写是审计唯一不能撒的谎。',
      ].join('\n')
    },
  }
}

function clampLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 50
  return Math.min(Math.max(Math.trunc(n), 1), 500)
}

/** `2026-10-01T12:34:56.789Z` → `10-01 12:34:56`; a missing time is named. */
function shortTime(at) {
  if (typeof at !== 'string' || at.length < 19) return at ?? '—'
  return `${at.slice(5, 10)} ${at.slice(11, 19)}`
}

/**
 * The field-level change, as one line.
 *
 * Two objects are compared key by key and only the keys whose value moved are
 * named. Anything else (a scalar, an array, a create or a clear) is written as
 * a plain before → after. `null` is a value here, not a gap: "there was no
 * before" is exactly what a create row means.
 */
function describeChange(before, after) {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    const moved = keys.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    if (moved.length === 0) return '（值未变）'
    return moved.map(key => `${key}: ${brief(before[key])} → ${brief(after[key])}`).join('；')
  }
  if (before === null && after !== null) return `新建: ${brief(after)}`
  if (before !== null && after === null) return `清空（原 ${brief(before)}）`
  return `${brief(before)} → ${brief(after)}`
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function brief(value) {
  if (value === undefined) return '—'
  if (value === null) return '空'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return truncate(text, 24)
}
