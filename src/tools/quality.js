/**
 * `amzn_dq_scan` — run the quality rules and report the issue list.
 *
 * This is the agent's door into the cockpit: the same `runQualityScan` the page
 * uses, so "what is wrong with the data" asked in the chat and shown on the page
 * cannot be two different answers. A second implementation for the model would
 * drift the way a second prompt renderer would — invisibly, because both would
 * look like a list.
 *
 * Writing, not read-only: a scan persists the findings so a status can be attached
 * to them later. It is **idempotent** — running it twice over an unchanged store
 * changes no row count — which is what makes "scan whenever you like" safe rather
 * than a way to bury real issues under copies of themselves.
 *
 * The thresholds it applies are read from `FRESHNESS_DAYS` (7 / 30 / 90); it
 * invents none, and it does **not** use the prototype's 14-day band, which was
 * rejected (Q11).
 */

import { runQualityScan, listIssues, issueStats } from '../store/quality.js'
import { getConflict, resolveConflict } from '../store/conflict.js'
import { DIMENSION_LABELS, DIMENSIONS } from '../domain/data/quality-rules.js'
import { normalizeScope, SCOPE_ALL } from '../domain/context/scope.js'
import { table, text } from './render.js'

export function qualityScanTool({ store }) {
  return {
    name: 'amzn_dq_scan',
    description:
      'Scan the store against the seven data-quality dimensions (完整 / 有效 / 一致 / 时效 / 唯一 / 可追溯 / 可行动) '
      + 'and return the issue list: severity, object, field, rule id, message and status. Call this before saying '
      + '"the data is fine" — it is the same scan the data-quality page runs, so the answer and the screen agree. '
      + 'It is idempotent: scanning twice over an unchanged store does not duplicate issues (an issue is upserted by '
      + 'rule + object + field, not appended). Pass a marketplace to narrow the scan to one site. '
      + 'Freshness uses the 7 / 30 / 90-day bands from §33 and nothing else; a field with no band is reported as '
      + 'undated (traceability), not as stale.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Site code, e.g. US / DE / JP. Omit for every site.' },
        workspaceId: { type: 'string', description: 'Workspace id. Defaults to ws-default.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value.text ?? value) },
    async execute(args) {
      const scope = normalizeScope({
        workspaceId: args?.workspaceId,
        /* An absent site means EVERY site, which is SCOPE_ALL — not the
           DEFAULT_MARKETPLACE an empty string would fold to. A scan that silently
           narrowed to US when nobody named a site would report "no problems" for
           a store whose only problems are on DE. */
        marketplace: args?.marketplace ?? SCOPE_ALL,
        shopId: SCOPE_ALL,
        brandId: SCOPE_ALL,
        productLineId: SCOPE_ALL,
      })

      let summary
      try {
        summary = runQualityScan(store, scope, { workspaceId: scope.workspaceId })
      } catch (error) {
        return { ok: false, error: error.message, hint: '扫描失败；检查库是否可写，或换一个站点再试。' }
      }

      const issues = listIssues(store)
      const stats = issueStats(store)

      const lines = [
        `质量扫描（站点 ${scope.marketplace === SCOPE_ALL ? '全部' : scope.marketplace}）：`
          + `本轮 ${summary.scanned} 条发现（新增 ${summary.created} / 更新 ${summary.updated}），`
          + `库内共 ${stats.total} 条问题。`,
      ]

      /* 2026-10-25（R-16）：把「本轮没再发现、但状态还是 open」的线索**印出来**。
         它此前只存在于 `runQualityScan` 的返回值里，屏幕上完全看不到 —— 于是
         `listing.title` 明明已经写好了，报告仍把「标题为空」列在最上面，读者会去修一个不存在的问题。
         **不改状态**（t6 钉死了：扫描不许动状态机，处置动作是人做的），只把线索交出去。 */
      if (Array.isArray(summary.notSeenAgain) && summary.notSeenAgain.length > 0) {
        /* 2026-10-25（R-41）：**这一批里有一部分永远不会消失。**
           R-36 让扫描只扫自有 ASIN（正确），但那 5 条竞品的问题是缩小范围之前留下的：
           扫描不再看它们 → 永远进不了「本轮发现」；而扫描只 upsert 不关旧行（R-16）→ 永远 open。
           于是看板上永久挂着 5 条「block 级问题」，指向的对象根本不是我们的产品。

           两条原则都对，但它们撞在一起造出了这个状态。**不改状态**（R-16 不变），
           但要**把这两类分开**，让读者第一次能看出哪些是真需要他确认的。 */
        const sideOf = (objectId) => {
          const asin = String(objectId ?? '').split('@')[0]
          const row = store.get(
            "SELECT object_id FROM asin_ownership WHERE asin = ? AND object_type = 'side' AND retracted_at IS NULL",
            [asin],
          )
          return row?.object_id ?? null
        }
        const mine = []
        const notMine = []
        for (const item of summary.notSeenAgain) {
          (sideOf(item.objectId) === 'competitor' ? notMine : mine).push(item)
        }
        lines.push('')
        if (mine.length > 0) {
          lines.push(`⚠️ 本轮**没有再发现**的 ${mine.length} 条（状态仍是 open —— 按当前数据算不出来，但**没有谁确认过它已修好**）：`)
          for (const item of mine.slice(0, 20)) {
            lines.push(`  · ${item.ruleId} ${item.objectType}:${item.objectId}${item.field ? '#' + item.field : ''}`)
          }
          if (mine.length > 20) lines.push(`  …还有 ${mine.length - 20} 条`)
          lines.push('  处置：确认数据真的修好了，再由人把它标成 resolved（`amzn_dq_scan` 不会替你关）。')
        }
        if (notMine.length > 0) {
          lines.push(`${mine.length > 0 ? '' : 'ℹ️ '}另外 ${notMine.length} 条**不会再消失了** —— 它们指向的对象已经不是我们的 ASIN：`)
          for (const item of notMine.slice(0, 20)) {
            lines.push(`  · ${item.ruleId} ${item.objectType}:${item.objectId}${item.field ? '#' + item.field : ''}`)
          }
          if (notMine.length > 20) lines.push(`  …还有 ${notMine.length - 20} 条`)
          lines.push('  说明：这些对象在 `asin_ownership` 里是 **side=competitor**，扫描不再覆盖它们（竞品没有 listing 是正常的），')
          lines.push('  所以它们既不「本轮发现」也不「已修好」—— **按当前扫描口径永远不会变**。')
          lines.push('  处置：由人把它们标成 dismissed（理由写「对象不是我们的 ASIN」）。扫描不会自己动它们，也不该动。')
        }
      }

      if (issues.length === 0) {
        lines.push('')
        lines.push('暂无问题。注意这是「按现有规则没发现问题」，不是「数据一定够用」——'
          + '没有观测时间的字段会走「可追溯」规则，而不是被当成新鲜。')
        return { text: lines.join('\n'), scope, summary, stats, issues }
      }

      lines.push('')
      lines.push(table(issues.slice(0, 50), [
        { label: '严重级', value: row => row.severity },
        { label: '维度', value: row => DIMENSION_LABELS[row.dimension] ?? row.dimension },
        { label: '规则', value: row => row.ruleId },
        { label: '对象', value: row => `${row.objectType}:${row.objectId}${row.field ? '#' + row.field : ''}` },
        { label: '说明', value: row => row.message },
        { label: '状态', value: row => row.status },
      ]))
      if (issues.length > 50) lines.push(`（仅列前 50 条，共 ${issues.length} 条）`)

      lines.push('')
      lines.push(`按严重级：${SEVERITY_SUMMARY(stats.bySeverity)}`)
      lines.push(`按维度：${DIMENSIONS.map(id => `${DIMENSION_LABELS[id]}=${stats.byDimension[id] ?? 0}`).join(' / ')}`)
      /* 这句原来是「供优化前置检查（模块 13）消费：阶段 1 只产出问题，不阻断」。两处要改：
         前置检查确实在（`amzn_optimize_precheck` 的九项门槛），但它**不读这里的 issue 行** ——
         它按同一张 `FRESHNESS_DAYS`（7 / 30 / 90）自己判，所以「供它消费」是不准确的；
         而「阶段 1」是会过期的话术。今天的真话是：两侧同一口径、各判各的，阻断在前置检查那侧。 */
      lines.push('过期的 DQ-FRESH-* 与优化前置检查用的是同一张时效表（FRESHNESS_DAYS 的 7 / 30 / 90）：'
        + '本工具只产出问题，不阻断；阻断发生在 amzn_optimize_precheck 的九项门槛里，那一侧按同一张表自己判，不读这里的行。')

      return { text: lines.join('\n'), scope, summary, stats, issues }
    },
  }
}

/** `block=2 / warn=3 / info=1`, worst-first so an empty band is still visible. */
function SEVERITY_SUMMARY(bySeverity = {}) {
  return ['block', 'warn', 'info'].map(level => `${level}=${bySeverity[level] ?? 0}`).join(' / ')
}

/**
 * `amzn_conflict_resolve` — adopt one value for a field two sources disagree on.
 *
 * This is the write half of the conflict workbench, and the one thing it must
 * *not* do is delete anything. Adopting a value records a decision **beside**
 * the sources; the sources that lost stay exactly where they were. That is the
 * sentence the batch is built around, so the tool writes only `field_conflict`
 * and says so in its answer.
 *
 * Every refusal carries a machine `code` (`CONFLICT_NOT_FOUND` /
 * `CONFLICT_ILLEGAL_TRANSITION` / `CONFLICT_VALUE_REQUIRED` /
 * `CONFLICT_UNKNOWN_SOURCE`) **and writes nothing**, so a caller that branches
 * on the reason and a caller that reads the store afterwards agree.
 */
export function conflictResolveTool({ store }) {
  return {
    name: 'amzn_conflict_resolve',
    description:
      'Resolve one field conflict by adopting a value: the field two sources disagree about gets a recorded decision, '
      + 'and the sources that lost are left untouched — a conflict is never silently overwritten. '
      + 'Pass the conflict id (from the 冲突工作台 page), the value being adopted, and optionally the source id that '
      + 'value came from, who decided, and a note. It writes ONLY the conflict row: it never deletes or edits '
      + 'asin_field_source. A missing id, a value already resolved, an empty adopted value, or a source id that is '
      + 'not one of that field\'s sources is refused with a code and writes nothing.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The field_conflict id to resolve.' },
        adoptedValue: { type: 'string', description: 'The stored value being adopted. Must not be empty.' },
        adoptedSourceId: { type: 'string', description: 'The source the adopted value came from; must be a source of this field.' },
        resolvedBy: { type: 'string', description: 'Who made the decision (a permission-level value in phase 1).' },
        note: { type: 'string', description: 'Why this value was adopted.' },
      },
      required: ['id', 'adoptedValue'],
    },
    output: { schema: {}, render: (_args, value) => text(value.text ?? value) },
    async execute(args) {
      let result
      try {
        result = resolveConflict(store, {
          id: args?.id,
          adoptedValue: args?.adoptedValue,
          adoptedSourceId: args?.adoptedSourceId,
          resolvedBy: args?.resolvedBy,
          note: args?.note,
        })
      } catch (error) {
        return { ok: false, error: error.message, hint: '裁决失败；检查库是否可写，或换一个冲突再试。' }
      }

      if (result.ok !== true) {
        return {
          ok: false,
          code: result.code,
          error: result.error,
          hint: '拒绝时不会写入任何东西：先核对冲突 id、要采纳的值，以及来源是否属于这个字段。',
        }
      }

      const conflict = result.conflict ?? getConflict(store, args?.id)
      const lines = [
        `已裁决冲突 ${conflict?.id ?? args?.id}：采纳 ${result.after.adoptedValue}`
          + (conflict?.adoptedSourceId ? `（来源 ${conflict.adoptedSourceId}）` : '（未记录来源）')
          + `，状态 ${result.before.status} → ${result.after.status}。`,
        `字段 ${conflict?.asin ?? '?'}@${conflict?.marketplace ?? '?'}#${conflict?.field ?? '?'}。`,
        '来源表未被改动：采纳是记在来源旁边的决定，不是删掉落选的那几条。',
      ]
      return { ok: true, text: lines.join('\n'), before: result.before, after: result.after, conflict }
    },
  }
}
