/**
 * The keyword-ownership tools (module 08 F08-04).
 *
 * Five tools, split read/write on purpose:
 *
 *   amzn_keyword_ownership_list     read  — the workbench: 词 / 候选 ASIN / 主人 / 冲突 / 建议
 *   amzn_keyword_ownership_preview  read  — what a batch would do, writing nothing
 *   amzn_keyword_ownership_batch    write — 批量分配 / 释放 / 锁定 / 解锁
 *   amzn_keyword_ownership_suggest  write — the Agent writes a suggestion back
 *   amzn_keyword_ownership_resolve  write — 人工裁决：采纳建议或指定主人
 *
 * ## The two names that were not chosen
 *
 * `amzn_keyword_ownership_apply` does not exist and never will: this plugin has
 * a guard (`tests/m14-observation.mjs`) that refuses any tool whose name
 * contains `publish|apply|push|deploy` after the `amzn_` prefix, because a tool
 * that *sounds* like it touches the live listing must not exist here. The batch
 * tool writes local ownership rows and nothing else, so the honest fix is the
 * name (`_batch`), not the guard. (F08-07 hit the same guard and fixed it the
 * same way.)
 *
 * ## The three things the descriptions must not overstate
 *
 *   - **变体共用五点导致重复占位** is a conflict reason the prototype shows. This
 *     batch cannot derive it **today** — and the honest reason changed in T-8: the
 *     variant relationship tables **exist** (`asin_variant_relation` et al., schema
 *     v37), what is missing is the data (this library has zero rows). The tools
 *     read the counts and say 「表在，本库还没有这条关系」 rather than 「表未建」,
 *     so a reader can tell "checked, fine" from "cannot check" from "nothing to check".
 *   - **「位置计划已变化」** is not marked — and the honest reason is the same shape
 *     as the variant one: the position plan tables **exist** (`keyword_plan` /
 *     `keyword_plan_entry`, schema v35 migration `keyword-plan`, requirement F08-05),
 *     what is missing is a stored plan (this library has zero versions). An affected
 *     running optimization run is *listed* and *confirmed*, and that confirmation is
 *     recorded — nothing is stamped.
 *   - **The competitor-brand rule** is data-driven: it fires on `brand`
 *     (`is_own = 0`) against an ASIN that is ours (`asin_ownership side=self`, or
 *     a brand we own). With no competitor brand in the library it cannot fire,
 *     and that is "no signal", not "passed".
 */

import { table, text, truncate } from './render.js'
import {
  applyKeywordOwnershipBatch, conflictNotesFor, keywordOwnershipStats, keywordOwnershipView,
  keywordPlanNotes, previewKeywordOwnershipBatch, recordOwnershipSuggestion, resolveKeywordOwnership,
} from '../store/keyword-ownership.js'
import { KEYWORD_OWNERSHIP_CLAIM_SOURCES, KEYWORD_OWNERSHIP_LABELS } from '../domain/states.js'

const LABEL = status => KEYWORD_OWNERSHIP_LABELS[status] ?? status
const ACTIONS = ['assign', 'release', 'lock', 'unlock', 'claim']
const ACTION_LABELS = { assign: '分配', release: '释放', lock: '锁定', unlock: '解锁', claim: '认领' }

/** The owner column, spelled the way the page spells it. */
function ownerText(row) {
  if (row.conflicted) return '未决（冲突）'
  if (row.owner === null) return row.claimCount === 0 ? '无' : '未决'
  return row.owner
}

function conflictText(row) {
  if (row.conflictReasons.length === 0) return '—'
  return row.conflictReasons.join('；')
}

function suggestionText(row) {
  if (row.suggestion === null) return '（无建议）'
  const adopted = row.suggestion.adoptedAt === null ? '' : `（已采纳 ${row.suggestion.adoptedAsin}）`
  return `${row.suggestion.suggestedAsin}${adopted}`
}

/** The shared note about what this batch cannot judge. */
const HONESTY = [
  '说明：主人与冲突都是**推导**的（主人 = 该词下唯一生效主张；≥2 条生效主张即冲突），库里不存冲突标志位。',
  '竞品品牌词约束依赖 brand(is_own=0) 与 asin_ownership(side=self)；库里没有竞品品牌或没有标记自有 ASIN 时，'
    + '该约束不会触发 —— 那是「没有信号可判」，不是「检查通过」。',
]

/**
 * 变体那一条的说明：**从库里读出来**，不是写死的（T-8 缺陷 1）。
 *
 * 修复前这里是 `HONESTY` 里的一个常量字符串，把这层说成「表不存在（F05-06）」——
 * 一句关于**代码**的假话（表从 schema v37 起就在），而且它会进工具输出、也会进
 * 工具描述（Agent 上下文）。现在它由 `store/keyword-ownership.js` 的
 * `conflictNotesFor` 按**本库真实的边数**给出，与页面提示、关键词详情共用同一份。
 */
function honestNotes(store) {
  return conflictNotesFor(store, {})
}

/**
 * 位置计划那一条的说明：同一套纪律（同一个形状的第二例）。
 *
 * 修复前它写死在 `HONESTY` 里，把这一层说成「表不存在」，而且引用了一个**错的编号** ——
 * 表在（schema v35），位置计划是 **F08-05**（F05-08 是 ASIN 归档，T-5）。现在由
 * `store/keyword-ownership.js` 的 `keywordPlanNotes` 按**本库真实的计划版数**给出，
 * 工具输出与 `renderImpact` 两处共用这一份（不再各写一遍措辞）。
 * ⚠️ 注释里**不复述那句旧话**（同 `keyword-ownership.js` 的说明）：被注释引用的旧话
 * 会让源码级 grep 守卫分不清「它回来了」与「只是在讲历史」。
 */
function planNotes(store) {
  return keywordPlanNotes(store, {})
}

export function keywordOwnershipListTool({ store }) {
  return {
    name: 'amzn_keyword_ownership_list',
    description:
      'Read the keyword ownership workbench: one row per word that has a claim or a suggestion — '
      + '词 / 候选 ASIN / 当前主人 / 冲突原因 / 建议. '
      + '**The owner and the conflict are derived, never stored**: the owner is the single active claim, '
      + 'and two or more active claims *are* the conflict — there is no conflict flag to drift out of date. '
      + 'A word with no claim and no suggestion is not a row here (it is not a conflict). '
      + 'A released claim is not deleted; it stays with its release reason, and the full trail is in '
      /* 2026-10-25（R-73）：这里原来写的是 `amzn_keyword_ownership_history` —— **那个工具不存在**
         （实测调用直接 `unknown tool`）。所以这句说明是在把人指向一个点不动的地方。
         事件本身一直都在：`keyword_ownership_event` 表，而 `amzn_keyword_detail` 的「所有权事件」一节
         就是它的读取口。现在指向那个能用的入口。 */
      + 'the 「所有权事件」 section of amzn_keyword_detail (keyword + marketplace). '
      + '「变体共用五点导致重复占位」 is reported as **还判不出来** for the honest reason '
      + '(the variant relationship tables exist — schema v37 — but this library has no relation rows yet, '
      + 'so there is nothing to judge), not guessed.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US. Omit for all.' },
        keyword: { type: 'string', description: 'Only this word. Case-insensitive.' },
        limit: { type: 'number', description: 'Rows to return. Default 100, max 1000.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const view = keywordOwnershipView(store, {
          marketplace: args?.marketplace ?? null,
          keyword: args?.keyword ?? null,
          limit: args?.limit ?? 100,
        })
        const stats = keywordOwnershipStats(store, { marketplace: args?.marketplace ?? null })
        const lines = [
          `关键词所有权${stats.marketplace === null ? '（全部站点）' : ` · ${stats.marketplace}`}`,
          `有主张/建议 ${stats.total} 词 · 有生效主张 ${stats.claimed} · **冲突 ${stats.conflicted}** · `
            + `建议 ${stats.suggestions}（待采纳 ${stats.pendingSuggestions} / 已采纳 ${stats.adopted}）`,
          '',
        ]
        if (view.rows.length === 0) {
          lines.push('没有任何所有权主张或建议。')
        } else {
          lines.push(table(view.rows, [
            { label: '词', value: row => truncate(row.keyword, 32) },
            { label: '候选 ASIN', value: row => row.candidates.join(' · ') || '—' },
            { label: '当前主人', value: ownerText },
            { label: '冲突原因', value: row => truncate(conflictText(row), 44) },
            { label: '建议（Agent 回写）', value: suggestionText },
          ]))
        }
        lines.push('', HONESTY[0], ...honestNotes(store), ...planNotes(store), HONESTY[1])
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message, hint: 'keyword 与 marketplace 都可选；limit 默认 100。' }
      }
    },
  }
}

export function keywordOwnershipPreviewTool({ store }) {
  return {
    name: 'amzn_keyword_ownership_preview',
    description:
      'What a batch ownership operation **would** do, writing nothing. '
      + 'Returns 直接 N 词 / 牵连 M 词 / 解除 K 起冲突 / 受影响的活跃优化运行列表. '
      + 'The preview and the real batch are the **same function** with a dryRun flag, so their numbers cannot '
      + 'diverge — a preview that says 3 while the write changes 24 is the failure this design removes. '
      + '牵连 (related) is the honest blast radius: other words claimed by the same ASINs. They are **not** '
      + 'changed by this operation, and the tool says so rather than implying they are. '
      + 'When a running optimization run is affected, `requiresConfirmation` is true and the run ids are listed — '
      + 'that is what the real batch then demands.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'assign | release | lock | unlock | claim' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'The words this batch names.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
        asin: { type: 'string', description: 'Target ASIN (required for assign and claim; optional for release).' },
      },
      required: ['action', 'keywords', 'marketplace'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const impact = previewKeywordOwnershipBatch(store, {
          action: args?.action,
          keywords: args?.keywords,
          marketplace: args?.marketplace,
          asin: args?.asin ?? null,
        })
        return renderImpact(impact, '预览（未写库）', planNotes(store))
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: `action 必须是 ${ACTIONS.join(' / ')}；assign 必须给 asin；词必须在总库里。`,
        }
      }
    },
  }
}

export function keywordOwnershipBatchTool({ store }) {
  return {
    name: 'amzn_keyword_ownership_batch',
    description:
      'Run a batch ownership operation: assign / release / lock / unlock / claim. '
      + '`assign` makes the target ASIN the single owner and **releases the other live claims** (they are not '
      + 'deleted — a release keeps the row and its reason, and the history keeps both) — that is how a human '
      + 'batch assignment settles a conflict. '
      + '`claim` adds one claim and touches nothing else: it is the Agent / import path, and it is how a conflict '
      + '(two or more live claims on one word) comes to exist before a human adjudicates it. '
      + '`release` releases the live claims; `lock` / `unlock` set the lock that stops a release or a transfer. '
      + 'Fail-closed and all-or-nothing: a word outside the library, a locked word, or a competitor brand word on '
      + 'our own ASIN refuses the whole batch and lists the offenders. '
      + '**If a running optimization run is affected, `confirmed: true` is required** — without it the call is '
      + 'refused and nothing is written; with it, the confirmation and the run list are recorded on every event row. '
      + 'Nothing is stamped 「位置计划已变化」: the position plan tables exist (keyword_plan / '
      + 'keyword_plan_entry, schema v35, requirement F08-05), but this library has no stored plan '
      + 'to compare against — so the tool says that reason out loud instead of claiming the check happened.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'assign | release | lock | unlock | claim' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'The words this batch names.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
        asin: { type: 'string', description: 'Target ASIN (required for assign and claim; optional for release).' },
        reason: { type: 'string', description: 'Why. Recorded on every event row.' },
        source: { type: 'string', enum: KEYWORD_OWNERSHIP_CLAIM_SOURCES, description: 'manual (default) | agent | auto.' },
        by: { type: 'string', description: 'Who ran it.' },
        confirmed: { type: 'boolean', description: 'Explicit second confirmation for an operation that affects a running optimization run.' },
      },
      required: ['action', 'keywords', 'marketplace'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const impact = applyKeywordOwnershipBatch(store, {
          action: args?.action,
          keywords: args?.keywords,
          marketplace: args?.marketplace,
          asin: args?.asin ?? null,
          reason: args?.reason ?? null,
          source: args?.source ?? 'manual',
          by: args?.by ?? null,
          confirmed: args?.confirmed === true,
        })
        return renderImpact(impact, `${ACTION_LABELS[impact.action] ?? impact.action}完成`, planNotes(store))
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: 'action 必须是 assign / release / lock / unlock / claim；assign 与 claim 必须给合法 asin；'
            + '锁定词不能释放或转移；词必须在总库；影响活跃运行时必须 confirmed: true。',
        }
      }
    },
  }
}

export function keywordOwnershipSuggestTool({ store }) {
  return {
    name: 'amzn_keyword_ownership_suggest',
    description:
      'Write an Agent suggestion back into the 建议 column: one ASIN, a reason, and an evidence snapshot. '
      + 'This is one half of §22.2\'s 「请求 Agent 建议回写建议列」 — the Agent computes it, the system records '
      + 'it, and a human then adopts it (or not) with amzn_keyword_ownership_resolve. '
      + 'One suggestion per (word, marketplace): it is the **current best judgement**, not a history — a new '
      + 'suggestion replaces the old one, and both are kept in the event log. The word must be in the master library.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The keyword. Case-insensitive; stored folded.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
        suggestedAsin: { type: 'string', description: 'The ASIN the Agent suggests as the owner.' },
        reason: { type: 'string', description: 'Why this ASIN.' },
        evidence: { type: 'object', description: 'Structured evidence snapshot, stored as JSON.' },
        by: { type: 'string', description: 'Which agent / run wrote it.' },
      },
      required: ['keyword', 'marketplace', 'suggestedAsin'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const result = recordOwnershipSuggestion(store, {
          keyword: args?.keyword,
          marketplace: args?.marketplace,
          suggestedAsin: args?.suggestedAsin,
          reason: args?.reason ?? null,
          evidence: args?.evidence ?? null,
          by: args?.by ?? null,
        })
        return [
          `已登记 Agent 建议：${result.keyword} · ${result.marketplace} → ${result.suggestedAsin}`,
          `时间 ${result.at}`,
          '采纳与否由人决定：调 amzn_keyword_ownership_resolve（不传 asin 即采纳这条建议）。',
        ].join('\n')
      } catch (error) {
        return { ok: false, error: error.message, hint: 'keyword / marketplace / suggestedAsin 必填；词必须在总库里。' }
      }
    },
  }
}

export function keywordOwnershipResolveTool({ store }) {
  return {
    name: 'amzn_keyword_ownership_resolve',
    description:
      'Human adjudication — the first of §22.2\'s two exits from an ownership conflict. '
      + 'Adopts one ASIN as the owner: with no `asin` it adopts the pending suggestion (that is 「采纳」); '
      + 'with one it is a manual decision. The other live claims are **released, not deleted** — the release keeps '
      + 'its row and reason, and the history keeps both. '
      + 'Refuses a transfer of a locked word, and refuses a competitor brand word on our own listing (§22.6). '
      + 'A word with no pending suggestion and no explicit `asin` is refused: adopting a suggestion that does not '
      + 'exist is not a decision.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The keyword. Case-insensitive; stored folded.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
        asin: { type: 'string', description: 'The ASIN to make the owner. Omit to adopt the pending suggestion.' },
        reason: { type: 'string', description: 'Why. Recorded on every event row.' },
        by: { type: 'string', description: 'Who decided.' },
      },
      required: ['keyword', 'marketplace'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const result = resolveKeywordOwnership(store, {
          keyword: args?.keyword,
          marketplace: args?.marketplace,
          asin: args?.asin ?? null,
          reason: args?.reason ?? null,
          by: args?.by ?? null,
        })
        const lines = [
          `所有权已裁决：${result.keyword} · ${result.marketplace} → ${result.asin}`
            + `（${result.adopted ? '采纳 Agent 建议' : '人工指定'}）`,
        ]
        if (result.changes.length > 0) {
          lines.push(`同时释放 ${result.changes.length} 条其它生效主张：${result.changes.map(change => change.asin).join('、')}`)
        }
        lines.push('释放不删行，完整轨迹见 amzn_keyword_detail 的「所有权事件」一节。')
        return lines.join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: '不传 asin 时必须有待采纳的建议；锁定词不能转移；竞品品牌词不能归自有 ASIN。',
        }
      }
    },
  }
}

/** The rendered impact — one shape, used by the preview and by the batch. */
function renderImpact(impact, title, planNotesLines = []) {
  const lines = [
    `${title} · ${ACTION_LABELS[impact.action] ?? impact.action}${impact.marketplace === null ? '' : ` · ${impact.marketplace}`}`,
    `直接 ${impact.directCount} 词 · 牵连共 ${impact.relatedCount} 词 × ${impact.affectedAsins.length} ASIN · `
      + `解除 ${impact.resolvedConflicts} 起冲突 · 新增 ${impact.createdConflicts} 起冲突`,
  ]
  if (impact.activeRuns.length === 0) {
    lines.push('没有受影响的活跃优化运行。')
  } else {
    lines.push(`**${impact.activeRuns.length} 个活跃优化运行受影响**：`
      + impact.activeRuns.map(run => `${run.id}（${run.asin} · ${run.status}）`).join('、'))
    /* 这一行不说「表未建」了（T-8）：由服务端按**本库真实的计划版数**给出。
       ⚠️ 空数组时不印半句话 —— 一个没有原因的「不标记」会让人以为它被检查过。 */
    if (planNotesLines.length === 0) {
      lines.push('本系统不标记「位置计划已变化」，也不声称检查过 —— 原因那一段这次没有读上来。')
    } else {
      lines.push(...planNotesLines, '⇒ 所以本批只做「列出 + 要求确认 + 留痕」，不标记「位置计划已变化」。')
    }
  }
  if (impact.related.length > 0) {
    lines.push(`牵连（同一批 ASIN 名下、本次**不改动**的其它词）：${impact.related.slice(0, 20).join('、')}`
      + (impact.related.length > 20 ? ` 等 ${impact.related.length} 词` : ''))
  }
  if (impact.changes.length > 0) {
    lines.push('', table(impact.changes, [
      { label: '词', value: change => truncate(change.keyword, 30) },
      { label: 'ASIN', value: change => change.asin },
      { label: '从', value: change => change.from ?? '(首次)' },
      { label: '到', value: change => change.to },
    ]))
  }
  if (impact.unchanged.length > 0) {
    lines.push(`无变化：${impact.unchanged.join('、')}`)
  }
  if (impact.requiresConfirmation && impact.dryRun) {
    lines.push('', '执行时必须带 confirmed: true —— 否则会被拒且不写任何东西。')
  }
  if (impact.dryRun) lines.push('', '这是预览，**没有写任何东西**。')
  return lines.join('\n')
}
