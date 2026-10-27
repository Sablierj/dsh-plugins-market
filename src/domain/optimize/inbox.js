/**
 * F13-01 草案收件箱 — 五态分组、六个列、两个动作的判据。
 *
 * ## 这个文件存在的理由：五态必须由内容重算
 *
 * 收件箱要按 待人工选择 / 待审批 / 驳回待修订 / 稍后 / 已作废 分组。`optimization_draft`
 * 里能表达这件事的只有 `accepted`（`1` / `0` / `NULL`），而「稍后」与「已作废」是人做过的
 * 两件它表达不了的事 —— 所以 v40 加了两列 `deferred_at` / `voided_at`。
 *
 * 到这里为止都很顺，而顺的地方正是要停一下的地方：**最省事的下一步是再加一个自报的
 * `status` 列**，让写入方写一个词、读者照着显示。本仓刚修过一个同形的反例 —— 13 节的
 * 五态曾经是「写入方自报、读者另算、两者之间没有一致性检查」，于是同一份数据可以同时
 * 是「待审批」和「已作废」而两边都不报错。
 *
 * 所以这里没有 `status` 列。**五态全部由 `draftInboxGroup` 从行自己的列重算**，而且
 * 写入方写完之后必须**读回那一行、重算一遍、与它回报的分组逐字比对**（`reconcileInboxGroup`）
 * —— 对不上就拒绝这次回报。一个能重算出来的状态，才配叫状态。
 *
 * ## 一条规则一份实现
 *
 * `draftInboxGroup` / `inboxMatches` / `draftInboxBuckets` 是判据的唯一定义处：
 *
 *   · 工具 `amzn_optimize_inbox` 直接调它们；
 *   · 页面拿到的是**算好的** `group` / `buckets` / `contextState`（`run-view.js` 逐行调
 *     `draftInboxRow`），只做 `buckets.includes(id)` 这样的成员测试，**不重算任何判据**。
 *
 * 把 `draftInboxGroup` 改坏，工具侧与页面侧两条断言必须同时变红 —— 页面没有第二份可以
 * 自己算出来。
 */

import { randomUUID } from 'node:crypto'
import { draftContextState } from './context.js'
import { labelForField, needsConfirmation } from '../rules/listing-fields.js'
import { insertOptimizationRun } from '../../store/queries.js'

/**
 * The five groups, in reading order. `short` is the compact form the filter bar
 * prints; both spellings come from **this one entry**, so the bar and the group
 * header can never name the same state differently.
 *
 * `why` is not decoration: a reader who sees 「驳回待修订」 and no explanation has
 * to guess whether it means "the rules rejected it" (no — the human did).
 */
export const INBOX_GROUPS = [
  {
    id: 'pending',
    label: '待人工选择',
    short: '未定',
    why: '还没有人做过决定。这些是收件箱存在的理由 —— 一条草案不会自己变成决定。',
  },
  {
    id: 'approval',
    label: '待审批',
    short: '待审批',
    why: '已经选了「采纳」，还没收尾（收尾走 amzn_optimize_save，那一步才写报告、才碰 listing）。',
  },
  {
    id: 'revision',
    label: '驳回待修订',
    short: '驳回待修订',
    why: '被**人**驳回了，不是被规则拦下的。规则拦下的在「阻断」那一列，两者要做的事不一样。',
  },
  {
    id: 'deferred',
    label: '稍后',
    short: '稍后',
    why: '明确押后了。它不是一个模糊的「还没看」—— 那是待人工选择。',
  },
  {
    id: 'voided',
    label: '已作废',
    short: '已作废',
    why: '明确作废了。行还在（作废不是删除），按 field 仍然解析得出来，也可以恢复。',
  },
]

export const INBOX_GROUP_IDS = INBOX_GROUPS.map(group => group.id)

/**
 * The context dimension of the filter. Three values, and they are three different
 * problems: a draft written under another scope (submittable nowhere here), one
 * that never recorded a scope (v19 and earlier — refused fail-closed), and one
 * that matches the scope selected now.
 */
export const DRAFT_CONTEXT_FILTERS = ['current', 'changed', 'orphan']

export const DRAFT_CONTEXT_LABELS = {
  current: '当前上下文',
  changed: '上下文已变化',
  orphan: '没有上下文',
}

/** Every value the filter bag may carry, groups and context states together. */
export const INBOX_FILTER_IDS = [...INBOX_GROUP_IDS, ...DRAFT_CONTEXT_FILTERS]

/**
 * The labels the page prints for a filter id. UI copy — but it is derived from
 * the two tables above rather than retyped, because a bar that says 「未定」 while
 * the group header says 「待人工选择」 for the same id is two names for one state.
 */
export const INBOX_FILTER_LABELS = {
  ...Object.fromEntries(INBOX_GROUPS.map(group => [group.id, group.short])),
  ...DRAFT_CONTEXT_LABELS,
}

/** `1` / `0` / `null`, from either a SQLite row or a JSON payload. */
function normalizeAccepted(value) {
  if (value === 1 || value === true) return 1
  if (value === 0 || value === false) return 0
  return null
}

function blank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

/**
 * The five-state derivation. **Reads only the row's own columns.**
 *
 * Precedence is spelled out rather than implied, because 「已作废的草案同时还带着一个
 * accepted=1」 是一个真实会出现的组合（先采纳、后作废），而它必须只有一个答案。
 * 作废与押后压过 `accepted`：人后做的那件事是更晚的意图。
 */
export function draftInboxGroup(draft) {
  if (!blank(draft?.voided_at ?? draft?.voidedAt)) return 'voided'
  if (!blank(draft?.deferred_at ?? draft?.deferredAt)) return 'deferred'
  const accepted = normalizeAccepted(draft?.accepted)
  if (accepted === 1) return 'approval'
  if (accepted === 0) return 'revision'
  return 'pending'
}

/** The label for a group id, or the id itself for a value nobody defined. */
export function inboxGroupLabel(id) {
  const group = INBOX_GROUPS.find(entry => entry.id === id)
  return group === undefined ? String(id ?? '—') : group.label
}

/**
 * The state a draft's context is in **relative to the scope selected now**.
 *
 * Thin wrapper over `draftContextState` (the same function `amzn_optimize_save`
 * asks before it accepts anything) so the inbox cannot come to a different answer
 * from the submit gate about the same draft.
 */
export function draftInboxContextState(draft, currentContextId) {
  return draftContextState(draft, currentContextId)
}

/**
 * Block / warn counts over a violations array.
 *
 * Lives here because two readers need the same arithmetic — the run panel's
 * per-run totals and the inbox's per-draft column — and two copies of a counting
 * rule is how the same draft ends up with two different block counts.
 */
export function countViolations(violations) {
  const counts = { block: 0, warn: 0 }
  for (const violation of Array.isArray(violations) ? violations : []) {
    const severity = String(violation?.severity ?? '')
    if (severity === 'block' || severity === 'warn') counts[severity] += 1
  }
  return counts
}

/**
 * 待确认项 — the named reasons this draft cannot be accepted on autopilot.
 *
 * A list rather than a number, because "2" does not tell a reader whether to go
 * and measure something or to switch the scope back. Both entries come from a
 * function that already exists: `needsConfirmation` is the field registry's own
 * answer to "is this a fact or copy", and the context verdict is the submit
 * gate's own answer to "may this be submitted here at all".
 */
export function draftConfirmations(row) {
  const out = []
  if (row?.fieldNeedsConfirmation === true) {
    out.push({
      code: 'field-fact',
      text: '这一项是事实不是文案：模型只能提议，要人对着实物确认后再填。',
    })
  }
  if (row?.contextState === 'unknown') {
    out.push({
      code: 'context-mismatch',
      text: '这份草案没有记录它是在哪个上下文里生成的（v19 之前的草案），提交会被拒。',
    })
  } else if (row?.contextState === 'context_changed') {
    out.push({
      code: 'context-mismatch',
      text: '上下文已变化：生成时的上下文与当前选中的不一致，提交会被拒。',
    })
  }
  return out
}

export const DRAFT_APPROVAL_LABELS = { required: '需二次确认', off: '免确认' }

/**
 * One draft as an inbox row — the six columns plus what the filter needs.
 *
 * Accepts either a raw `optimization_draft` row (snake_case) or an already
 * projected draft, because both callers are real: the tool reads rows straight
 * from the store, `run-view.js` projects a run's drafts. Projecting twice with
 * two functions is what this signature exists to prevent.
 */
export function draftInboxRow(draft, { run = null, currentContextId = null, approvalRequired = false } = {}) {
  const field = String(draft?.field ?? '').trim()
  const contextState = draftInboxContextState(draft, currentContextId)
  const violations = Array.isArray(draft?.violations)
    ? draft.violations
    : parseJson(draft?.violations_json, [])
  const counts = countViolations(violations)
  const acceptedRaw = draft?.accepted === undefined ? null : draft.accepted
  const accepted = normalizeAccepted(acceptedRaw)

  const row = {
    field,
    label: draft?.label ?? labelForField(field),
    runId: run?.id ?? draft?.runId ?? draft?.run_id ?? null,
    asin: run?.asin ?? draft?.asin ?? null,
    marketplace: run?.marketplace ?? draft?.marketplace ?? null,

    group: draftInboxGroup(draft),
    accepted,
    acceptedRaw,

    /* 生成时间 = 这一轮开始的那一刻。草案自己**没有**生成时间列（v25 的回填纪律
       已经写死这个口径：schema.js 的 optimization_draft 回填取所属 run 的
       started_at），所以这里不发明第二个来源，只把口径带出来。 */
    generatedAt: run?.started_at ?? run?.startedAt ?? draft?.generatedAt ?? null,
    generatedAtSource: 'run.started_at',
    updatedAt: draft?.updated_at ?? draft?.updatedAt ?? null,

    blocked: counts.block,
    warnings: counts.warn,

    approvalState: approvalRequired === true ? 'required' : 'off',
    approvalLabel: DRAFT_APPROVAL_LABELS[approvalRequired === true ? 'required' : 'off'],

    contextId: draft?.context_id ?? draft?.contextId ?? null,
    contextState,

    voidedAt: draft?.voided_at ?? draft?.voidedAt ?? null,
    deferredAt: draft?.deferred_at ?? draft?.deferredAt ?? null,

    fieldNeedsConfirmation: needsConfirmation(field) === true,

    before: draft?.before ?? null,
    after: draft?.after ?? null,
    rationale: draft?.rationale ?? null,
    violations,
  }
  row.groupLabel = inboxGroupLabel(row.group)
  row.confirmations = draftConfirmations(row)
  /* The filter values this row satisfies. **Derived from `inboxMatches`**, not
     written out again: a hand-written bucket list is exactly the second copy of
     the predicate that drifts the first time a group is added. */
  row.buckets = draftInboxBuckets(row)
  return row
}

/**
 * Which filter values a row satisfies — the whole of what the page needs.
 *
 * The page does `row.buckets.includes(id)`. It does not know what `pending` means
 * and does not need to: the meaning lives here, once.
 */
export function draftInboxBuckets(row) {
  return INBOX_FILTER_IDS.filter(id => inboxMatches(row, filterDescriptorFor(id)))
}

/**
 * One filter id → its descriptor. The group ids and the context ids are two
 * vocabularies, and this is the one place that knows which is which — a caller
 * that guessed would ask `inboxFilterFrom({draftStatus: 'current'})`, which is not
 * a filter anybody defined, and get "matches everything" back.
 */
function filterDescriptorFor(id) {
  return INBOX_GROUP_IDS.includes(id) ? { group: id, context: null } : { group: null, context: id }
}

/**
 * The filter bag → `{group, context}`.
 *
 * One alias, named rather than silently dropped: `draftStatus=orphan` is what a
 * link saved before this batch carries (`page.js` had exactly two filters, and
 * one of them was this). It means the same thing as `draftContext=orphan`, and
 * both spellings resolve to the same predicate.
 *
 * Anything unrecognised resolves to `{group: null, context: null}` — show
 * everything. A filter nobody understands that emptied the list would look
 * exactly like 「这里没有草案」, which is the silent-empty shape this page refuses.
 */
export function inboxFilterFrom(filters = {}) {
  const status = String(filters?.draftStatus ?? '').trim()
  const context = String(filters?.draftContext ?? '').trim()
  const group = INBOX_GROUP_IDS.includes(status) ? status : null
  const contextFromStatus = status === 'orphan' ? 'orphan' : null
  const resolvedContext = DRAFT_CONTEXT_FILTERS.includes(context) ? context : contextFromStatus
  return { group, context: resolvedContext }
}

/** Does this row belong under this filter? **The one predicate.** */
export function inboxMatches(row, filter) {
  if (filter === null || filter === undefined) return true
  if (filter.group !== null && filter.group !== undefined && row?.group !== filter.group) return false
  if (filter.context !== null && filter.context !== undefined) {
    if (filter.context === 'current') return row?.contextState === 'ok'
    if (filter.context === 'changed') return row?.contextState === 'context_changed'
    if (filter.context === 'orphan') return row?.contextState === 'unknown'
    return false
  }
  return true
}

/**
 * The inbox: group counts, the context picture, the filtered rows, and — when
 * there is nothing to show — **which** kind of nothing it is.
 *
 * Three empties, three sentences, and the difference is load-bearing:
 *
 *   `no-drafts`           这一轮还没有草案（跑过 prepare / validate 才会有）
 *   `no-match`            有草案，但当前筛选把它们全排除了（带上未筛选的总数）
 *   `no-current-context`  筛了「当前上下文」而工作台没有上下文 —— 空是因为**没有可比的东西**，
 *                         不是因为没有草案
 *
 * Collapsing them into one grey box is how 「筛选没匹配上」 gets read as 「这里没有草案」.
 */
export function buildInbox(rows, { filter = { group: null, context: null }, currentContextId = null } = {}) {
  const all = Array.isArray(rows) ? rows : []
  const resolved = filter ?? { group: null, context: null }

  const groups = INBOX_GROUPS.map(group => ({
    id: group.id,
    label: group.label,
    short: group.short,
    why: group.why,
    count: all.filter(row => row.group === group.id).length,
  }))
  const byGroup = Object.fromEntries(groups.map(group => [group.id, group.count]))

  const matched = all.filter(row => row.contextState === 'ok').length
  const changed = all.filter(row => row.contextState === 'context_changed').length
  const unknown = all.filter(row => row.contextState === 'unknown').length

  const context = {
    currentId: currentContextId === null || currentContextId === undefined ? null : String(currentContextId),
    available: !blank(currentContextId),
    matched,
    changed,
    unknown,
    /* A `current` filter with no current context cannot match anything, and that
       is a fact about the workbench rather than about the drafts. Said out loud
       so the empty list is not read as "no drafts". */
    state: blank(currentContextId) && resolved.context === 'current' ? 'no-current-context' : 'ok',
  }

  const filtered = all.filter(row => inboxMatches(row, resolved))

  let empty = null
  if (all.length === 0) {
    empty = {
      kind: 'no-drafts',
      text: '这一轮还没有任何草案 —— 草案是 amzn_optimize_validate 写进来的，跑过一次校验才会有。',
    }
  } else if (context.state === 'no-current-context') {
    empty = {
      kind: 'no-current-context',
      text: `筛选是「只看当前上下文」，而工作台现在没有上下文（没有选中的范围）。`
        + `这不是「没有草案」—— 这一轮有 ${all.length} 条，其中 ${changed + unknown} 条的上下文与任何范围都对不上。`,
    }
  } else if (filtered.length === 0) {
    empty = {
      kind: 'no-match',
      text: `这个筛选下没有草案（未筛选共 ${all.length} 条，都在别的分组或别的上下文里）。`,
    }
  }

  return {
    groups,
    context,
    filter: resolved,
    counts: { total: all.length, shown: filtered.length, byGroup },
    rows: filtered,
    empty,
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/* ───────────────────────────── the write half (F13-01) ───────────────────────────── */

/**
 * 作废 / 恢复 / 押后 / 取消押后 —— 四个动作，一个写入口。
 *
 * ## 为什么要读回对账
 *
 * 每个动作写完都**重新 SELECT 那一行**，把原始列喂回 `draftInboxGroup`，再与本次
 * 意图应当产生的分组比对。对不上就报 `INBOX_STATE_MISMATCH`，**不谎报成功**。
 *
 * 这不是自检的洁癖：写入方自报状态、读者另算一遍，而两者之间没有检查，正是本仓刚
 * 修过的那个反例（13 节的五态）。读回对账是这条反例的**机器可验证**版本 —— 它不是
 * 一句「我们会保持一致」，是一条会红的断言。
 *
 * ## 幂等
 *
 * 已经作废的再作废、没作废的恢复，都不是错误，但也不写：`unchanged: true`。
 * 「做了一次没改变任何东西的调用」与「状态变了」是两件不同的事，审计里也该分开。
 */
export const INBOX_ACTIONS = ['void', 'restore', 'defer', 'resume', 'reoptimize']

export const INBOX_CODES = {
  UNKNOWN_ACTION: 'INBOX_UNKNOWN_ACTION',
  DRAFT_NOT_FOUND: 'INBOX_DRAFT_NOT_FOUND',
  RUN_FINALISED: 'INBOX_RUN_FINALISED',
  STATE_MISMATCH: 'INBOX_STATE_MISMATCH',
  REOPTIMIZE_NO_PARENT: 'INBOX_REOPTIMIZE_NO_PARENT',
  REOPTIMIZE_NO_DRAFT: 'INBOX_REOPTIMIZE_NO_DRAFT',
}

/** The four state actions: which column each one touches, and where it lands. */
const STATE_ACTIONS = {
  void: { column: 'voided_at', set: true, to: 'voided' },
  restore: { column: 'voided_at', set: false, to: null },
  defer: { column: 'deferred_at', set: true, to: 'deferred' },
  resume: { column: 'deferred_at', set: false, to: null },
}

/**
 * A run is finalised once it has a report. After that its draft states are the
 * ones the report was written from, and moving them would make the document
 * disagree with the rows it describes — silently, because nothing re-renders the
 * report. So the refusal is here, at the write, not in the page's button state.
 */
export function runFinalisedRefusal(run) {
  const finalised = Boolean(run?.report_md) || String(run?.status ?? '') !== 'running'
  if (!finalised) return null
  return {
    ok: false,
    code: INBOX_CODES.RUN_FINALISED,
    error: `这一轮已经收尾（状态 ${run?.status ?? '未知'}${run?.report_md ? '，报告已生成' : ''}）：`
      + '草案状态是报告写下来的那一份，改它会让报告与行对不上。要接着改，用「基于此草案重新优化」开新的一轮。',
  }
}

/**
 * Apply one state action and reconcile.
 *
 * Returns `{ok, action, runId, field, unchanged, group, groupLabel, before, after, at}`
 * or a refusal object (`{ok:false, code, error}`).
 *
 * `now` is injectable so the reconciliation can be exercised against a fixed clock
 * — a check that asserts on "the group after the write" must not depend on how
 * long the write took.
 */
export function applyInboxAction(store, { action, run, field, now = new Date() } = {}) {
  const spec = STATE_ACTIONS[String(action ?? '').trim()]
  if (spec === undefined) {
    return {
      ok: false,
      code: INBOX_CODES.UNKNOWN_ACTION,
      error: `unknown inbox action ${JSON.stringify(action)} — expected one of: ${Object.keys(STATE_ACTIONS).join(' | ')}（reoptimize 由调用方单独处理）`,
    }
  }
  const name = String(field ?? '').trim()
  const runId = String(run?.id ?? '').trim()
  if (name === '') {
    return { ok: false, code: INBOX_CODES.DRAFT_NOT_FOUND, error: 'field is required' }
  }

  const finalised = runFinalisedRefusal(run)
  if (finalised !== null) return finalised

  const before = readDraftRow(store, runId, name)
  if (before === null) {
    return {
      ok: false,
      code: INBOX_CODES.DRAFT_NOT_FOUND,
      error: `第 ${runId.slice(0, 8)} 轮里没有字段 ${name} 的草案。`,
    }
  }

  const stamp = spec.set ? isoOf(now) : null
  /* 幂等看的是「这一列本来是不是空的」，**不是**「它等不等于一个新的时刻戳」。
     拿新戳去比永远不等，于是每一次重复调用都会被报成「变了」—— 而「做了一次没改变任何
     东西的调用」与「状态变了」是两件不同的事，审计里也该分开。 */
  const already = blank(before[spec.column])
  const changed = spec.set ? already : !already
  if (changed) {
    store.run(
      `UPDATE optimization_draft SET ${spec.column} = ?, updated_at = ? WHERE run_id = ? AND field = ?`,
      [stamp, isoOf(now), runId, name],
    )
    /* 押后与决定是互斥的：一个「稍后」的草案如果还挂着 accepted=1，它到底在哪一组就
       要靠优先级去猜 —— 而优先级是给读者兜底的，不该是常态。所以押后时把决定清掉，
       取消押后**不**恢复它（那需要一次新的决定）。 */
    if (spec.column === 'deferred_at' && spec.set) {
      store.run(
        'UPDATE optimization_draft SET accepted = NULL WHERE run_id = ? AND field = ?',
        [runId, name],
      )
    }
  }

  const after = readDraftRow(store, runId, name)
  const group = draftInboxGroup(after)

  /* ── 读回对账 ──────────────────────────────────────────────────────────────
     两边都是**从内容算出来的**，而且是两条不同的路：
       expected  从**写之前**那一行算，把这次动作要动的那一列按目标值替换掉
                 （set → 打上时刻；clear → 置 NULL），再问「内容应该怎么说」；
       group     从**写之后**读回来的那一行算，「内容实际怎么说」。
     写入没落地、落到了别的行、或者列名写错了，两者就会分叉。这才是对账，
     不是把同一个表达式算两遍。 */
  const expected = spec.set
    ? spec.to
    : draftInboxGroup({ ...before, [spec.column]: null })
  if (group !== expected) {
    return {
      ok: false,
      code: INBOX_CODES.STATE_MISMATCH,
      error: `动作 ${action} 之后读回重算的分组是「${inboxGroupLabel(group)}」，`
        + `按内容它应当是「${inboxGroupLabel(expected)}」—— 这次写入没有产生它声称的结果。`,
    }
  }

  return {
    ok: true,
    action: String(action),
    runId,
    field: name,
    unchanged: !changed,
    group,
    groupLabel: inboxGroupLabel(group),
    before: draftInboxGroup(before),
    after: group,
    at: stamp,
  }
}

function isoOf(now) {
  const date = now instanceof Date ? now : new Date(now)
  return date.toISOString()
}

/** The raw row, read back through the same SELECT the reconciliation uses. */
export function readDraftRow(store, runId, field) {
  const row = store.get(
    'SELECT * FROM optimization_draft WHERE run_id = ? AND field = ?',
    [String(runId ?? '').trim(), String(field ?? '').trim()],
  )
  return row ?? null
}

/**
 * 「基于此草案重新优化」— a **new round seeded from the parent's frozen package**.
 *
 * ## Why this creates a run instead of generating copy
 *
 * This plugin does not generate copy; the module header in `src/tools/optimize.js`
 * says why, and it is not a limitation to work around. So the honest落点 for "redo
 * this from that draft" is: mint a new round that inherits **exactly** the facts
 * the parent round worked from — the same keyword set, the same limits, the same
 * position plan, the same rule and prompt snapshots, the same `before` copy — and
 * hand it to the agent. The new round starts with no drafts, which is the truth:
 * nothing has been written yet.
 *
 * The inheritance is a **copy of the parent's frozen package**, not a re-read of
 * today's data. Re-reading would quietly change the keywords and the limits under
 * a round the user believes continues the previous one.
 *
 * `derivedFrom` / `derivedFromDraft` are written **inside the package**, so a
 * report re-read months later can answer "which round was this forked from" —
 * and it is a fact about the round, not a second column to keep in sync.
 */
export function reoptimizeFromDraft(store, { parentRun = null, field = null, now = new Date() } = {}) {
  if (parentRun === null || parentRun === undefined) {
    return {
      ok: false,
      code: INBOX_CODES.REOPTIMIZE_NO_PARENT,
      error: '找不到父轮次 —— 「基于此草案重新优化」必须有一个被基于的草案。',
    }
  }
  const name = String(field ?? '').trim()
  if (name !== '' && readDraftRow(store, parentRun.id, name) === null) {
    return {
      ok: false,
      code: INBOX_CODES.REOPTIMIZE_NO_DRAFT,
      error: `第 ${String(parentRun.id).slice(0, 8)} 轮里没有字段 ${name} 的草案。`,
    }
  }

  const storedPackage = parseJson(parentRun.package_json, null)
  const id = randomUUID()
  insertOptimizationRun(store, {
    id,
    asin: parentRun.asin,
    marketplace: parentRun.marketplace,
    status: 'running',
    sessionId: null,
    rulesVersion: parentRun.rules_version ?? null,
    ruleSetVersion: parentRun.rule_set_version ?? null,
    rules: parseJson(parentRun.rules_json, null),
    package: storedPackage === null
      ? null
      : { ...storedPackage, derivedFrom: parentRun.id, derivedFromDraft: name === '' ? null : { field: name } },
    startedAt: isoOf(now),
  })
  return { ok: true, runId: id, derivedFrom: parentRun.id, field: name === '' ? null : name }
}
