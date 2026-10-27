/**
 * The keyword lifecycle tools (module 08 F08-07).
 *
 * Five tools, split read/write on purpose:
 *
 *   amzn_keyword_lifecycle_list       read  — the counts, and the words in one state
 *   amzn_keyword_lifecycle_history    read  — one word's full transition timeline
 *   amzn_keyword_lifecycle_set        write — move one word along a legal edge
 *   amzn_keyword_lifecycle_batch      write — an explicitly declared publication association
 *   amzn_keyword_lifecycle_batch_set  write — move a selection of words as one human decision
 *
 * The fourth was almost named `_apply`, and it is not: this plugin has a guard
 * (`tests/m14-observation.mjs`) that refuses any tool whose name contains
 * `publish|apply|push|deploy` after the `amzn_` prefix, because a tool that
 * sounds like it touches the live listing must never exist here. `apply` is a
 * substring of `_apply`, so the guard would have failed on a tool that in fact
 * only writes a local lifecycle row. The honest fix is the name, not the guard.
 * The fifth is `_batch_set` rather than a new verb: it is the batch form of
 * `lifecycle_set`, and the family reads that way.
 *
 * ## The two refusals that carry the design
 *
 *   - **A no-op is refused.** Setting a word to the state it is already in is not
 *     a transition. The tool says so and writes no history — otherwise an event
 *     row would claim a change that did not happen.
 *   - **A word with no record is not `candidate`.** "Nobody decided" and "somebody
 *     decided candidate" are different, and `getKeywordLifecycle` returns `null`
 *     for the first. The tools never invent the second.
 *
 * The batch adds a third, and it is why the tool exists: the 2026-10-25
 * walkthrough found the library at `已设置 0 / 未设置 30,778` while the page said
 * "click one word". The batch is **all-or-nothing**, it demands `by` and
 * `reason` (500 rows in one call is a decision somebody must be able to review),
 * and it can take a **filter** so 30,778 words are not 300+ rounds of ticking
 * boxes. Whatever it selects goes into the event rows, so "why were these 500
 * words changed" is answerable later.
 *
 * The nine states and the legal edges live in `src/domain/states.js` — this file
 * reads them and does not restate them, so the description a model reads and the
 * machine that enforces it cannot drift.
 */

import { table, text, truncate } from './render.js'
import {
  KEYWORD_LIFECYCLE_BATCH_MAX, applyKeywordLifecycleBatch, getKeywordLifecycle, keywordLifecycleCounts,
  keywordLifecycleHistory, listKeywordLifecycle, setKeywordLifecycle, setKeywordLifecycleBatch,
} from '../store/keyword-lifecycle.js'
import {
  KEYWORD_LIFECYCLE_LABELS, KEYWORD_LIFECYCLE_SOURCES, KEYWORD_LIFECYCLE_STATES,
  KEYWORD_LIFECYCLE_TRANSITIONS,
} from '../domain/states.js'

/** The chain, spelled the way the requirement spells it, for the tool prose. */
const CHAIN = KEYWORD_LIFECYCLE_STATES.join(' → ')
const LABEL = status => KEYWORD_LIFECYCLE_LABELS[status] ?? status

/** The states reachable from one state, as prose — read from the table, not typed. */
function exitsFrom(status) {
  const exits = KEYWORD_LIFECYCLE_TRANSITIONS[status] ?? []
  return exits.length === 0 ? '（无）' : exits.join(' / ')
}

export function keywordLifecycleListTool({ store }) {
  return {
    name: 'amzn_keyword_lifecycle_list',
    description:
      'Read the keyword lifecycle. Nine states, in this order: ' + CHAIN + '. '
      + 'This is the *current* state of a word — a human decision, stored separately from the keyword master '
      + '(a master recompute would erase a column kept there). '
      + 'A word with **no lifecycle record** is reported as 未设置 and is NOT counted as candidate: '
      + '"nobody decided" and "decided candidate" are different facts. '
      + 'Pass `status` to list the words in one state; an unknown status is refused rather than returning an empty list. '
      + 'There is no delete — a word can be excluded or archived, and both can come back to active.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US. Omit for all.' },
        status: { type: 'string', enum: KEYWORD_LIFECYCLE_STATES, description: 'Only words currently in this state.' },
        limit: { type: 'number', description: 'Rows to return. Default 50, max 1000.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const counts = keywordLifecycleCounts(store, { marketplace: args?.marketplace ?? null })
        const rows = listKeywordLifecycle(store, {
          marketplace: args?.marketplace ?? null,
          status: args?.status ?? null,
          limit: args?.limit ?? 50,
        })
        const lines = [
          `关键词生命周期${counts.marketplace === null ? '（全部站点）' : ` · ${counts.marketplace}`}`,
          `已设置 ${counts.total} 条 · 未设置 ${counts.unset} 条（未设置 ≠ candidate：没人决定过）`,
          counts.byStatus.map(entry => `${LABEL(entry.status)}=${entry.n}`).join('  '),
          '',
        ]
        if (rows.length === 0) {
          lines.push('没有符合条件的关键词。')
        } else {
          lines.push(table(rows, [
            { label: '关键词', value: row => truncate(row.keyword, 40) },
            { label: '站点', value: row => row.marketplace },
            { label: '状态', value: row => `${row.status}(${LABEL(row.status)})` },
            { label: '来源', value: row => row.source },
            { label: '改动时间', value: row => row.changed_at },
            { label: '理由', value: row => truncate(row.reason ?? '', 30) },
          ]))
        }
        lines.push('', `链条：${CHAIN}；excluded 与 archived 不是终态，可回 active。`)
        return lines.join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: `status 必须是九态之一（${CHAIN}）；漏了状态就返回全部。`,
        }
      }
    },
  }
}

export function keywordLifecycleHistoryTool({ store }) {
  return {
    name: 'amzn_keyword_lifecycle_history',
    description:
      'The full transition history of one keyword, oldest first. Every legal transition appends one row here; '
      + 'the rows are never updated and never deleted. `from_status` is null on the first row — that is '
      + '"there was no prior state", not a made-up initial state. '
      + 'A refused transition leaves no row, so the history is exactly the set of changes that happened.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The keyword, e.g. bench cushion. Case-insensitive.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
      },
      required: ['keyword', 'marketplace'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const current = getKeywordLifecycle(store, { keyword: args?.keyword, marketplace: args?.marketplace })
        const events = keywordLifecycleHistory(store, { keyword: args?.keyword, marketplace: args?.marketplace })
        if (current === null && events.length === 0) {
          return `关键词 "${args?.keyword}" 在 ${String(args?.marketplace ?? '').toUpperCase()} 没有任何生命周期记录 —— `
            + '未设置，不是 candidate。'
        }
        const lines = [
          `${current?.keyword ?? String(args?.keyword ?? '')} · ${current?.marketplace ?? String(args?.marketplace ?? '').toUpperCase()}`
          + `    当前 ${current === null ? '未设置' : `${current.status}(${LABEL(current.status)})`}`,
          '',
        ]
        if (events.length === 0) {
          lines.push('（有当前状态但没有事件行 —— 不该发生，说明数据被手工改过。）')
        } else {
          lines.push(table(events, [
            { label: '时间', value: row => row.at },
            { label: '从', value: row => (row.from_status === null ? '(首次)' : row.from_status) },
            { label: '到', value: row => row.to_status },
            { label: '来源', value: row => row.source },
            { label: '发布', value: row => row.publication_id ?? '' },
            { label: '理由', value: row => truncate(row.reason ?? '', 30) },
          ]))
        }
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message, hint: 'keyword 与 marketplace 都是必填。' }
      }
    },
  }
}

export function keywordLifecycleSetTool({ store }) {
  return {
    name: 'amzn_keyword_lifecycle_set',
    description:
      'Move one keyword to a new lifecycle state, appending a history row. Nine states, in order: ' + CHAIN + '. '
      + 'A transition is only accepted along a legal edge of the state machine, and **a move to the state the word is '
      + 'already in is refused** — it is not a transition, it is a no-op, and it would write a history row claiming a '
      + 'change that did not happen. A word with no record yet may be set to any state: the first decision is a creation, '
      + 'not a transition, and requiring candidate first would fabricate a step nobody took. '
      + '`excluded` and `archived` are not terminal — both can return to active, which is why there is no delete. '
      + 'Source is one of ' + KEYWORD_LIFECYCLE_SOURCES.join(' / ') + '.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The keyword. Case-insensitive; stored folded.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
        to: { type: 'string', enum: KEYWORD_LIFECYCLE_STATES, description: 'The target state.' },
        reason: { type: 'string', description: 'Why it changed. Recorded on both the current row and the event.' },
        source: { type: 'string', enum: KEYWORD_LIFECYCLE_SOURCES, description: 'manual (default) | publication | observation.' },
        evidence: { type: 'object', description: 'Structured evidence for the decision, stored as JSON.' },
        by: { type: 'string', description: 'Who made the decision.' },
      },
      required: ['keyword', 'marketplace', 'to'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const result = setKeywordLifecycle(store, {
          keyword: args?.keyword,
          marketplace: args?.marketplace,
          to: args?.to,
          reason: args?.reason ?? null,
          source: args?.source ?? 'manual',
          evidence: args?.evidence ?? null,
          by: args?.by ?? null,
        })
        return [
          `${result.keyword} · ${result.marketplace}`,
          `${result.from === null ? '(首次)' : `${result.from}(${LABEL(result.from)})`} → ${result.to}(${LABEL(result.to)})`,
          `事件已追加: ${result.eventId} @ ${result.at}`,
          `从 ${result.to} 可以去：${exitsFrom(result.to)}`,
        ].join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: '只在状态机允许的边上流转；同态（设成它已经是的状态）会被拒，且不写历史。'
            + 'excluded / archived 要回到 active 是允许的，但必须给 reason。',
        }
      }
    },
  }
}

export function keywordLifecycleBatchTool({ store }) {
  return {
    name: 'amzn_keyword_lifecycle_batch',
    description:
      'Record an **explicitly declared** publication association: "this publication used these keywords", and move each '
      + 'of them to `to` (normally assigned → used). This plugin cannot know which words a publication used — there is no '
      + 'such link in the database (no position plan), so the caller must state it and the system records the declaration. '
      + 'Fail-closed: a publicationId that does not name a real publication is refused; a keyword not in the master library '
      + 'is refused **and listed**; an illegal transition refuses the **whole** batch and lists the offenders. Nothing is '
      + 'applied unless everything is valid. A word already at `to` is reported as unchanged and writes no event. '
      + 'The event rows carry source=publication and the publication id.',
    parameters: {
      type: 'object',
      properties: {
        publicationId: { type: 'string', description: 'The publication record id this association came from.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'The exact keywords this publication used.' },
        to: { type: 'string', enum: KEYWORD_LIFECYCLE_STATES, description: 'Target state, normally used.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
        reason: { type: 'string', description: 'Why. Recorded on every event.' },
        by: { type: 'string', description: 'Who declared it.' },
      },
      required: ['publicationId', 'keywords', 'to', 'marketplace'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const result = applyKeywordLifecycleBatch(store, {
          publicationId: args?.publicationId,
          keywords: args?.keywords,
          to: args?.to,
          marketplace: args?.marketplace,
          reason: args?.reason ?? null,
          by: args?.by ?? null,
        })
        const lines = [
          `发布关联已登记: ${result.publicationId} → ${result.to}(${LABEL(result.to)}) · ${result.marketplace}`,
          `流转 ${result.applied.length} 词，追加 ${result.eventIds.length} 条事件（source=publication）。`,
        ]
        for (const entry of result.applied) {
          lines.push(`  · ${entry.keyword}: ${entry.from === null ? '(首次)' : entry.from} → ${result.to}`)
        }
        if (result.unchanged.length > 0) {
          lines.push(`  已在 ${result.to}、未产生流转：${result.unchanged.join('、')}`)
        }
        lines.push('', '这是一次**显式声明**：系统没有从 listing 文本反推关键词 —— 那会把碰巧出现在文案里的词判成「被使用」。')
        return lines.join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: 'publicationId 必须是已登记的发布记录；keywords 必须在总库里；非法流转会拒整批并列出。',
        }
      }
    },
  }
}

/**
 * 批量改生命周期 —— **一次人的决定，all-or-nothing**（F-5）。
 *
 * 为什么需要它：走查（2026-10-25）看到 `已设置 0 / 未设置 30,778`，而页面写着
 * 「先在下面的表里点选**一条**词」。3 万条只支持单条操作，那不是效率问题。
 */
export function keywordLifecycleBatchSetTool({ store }) {
  return {
    name: 'amzn_keyword_lifecycle_batch_set',
    description:
      'Move a **selection** of keywords to one lifecycle state, as one human decision. Nine states, in order: ' + CHAIN + '. '
      + 'Name **exactly one** selection: `keywords` (the words that were ticked, at most ' + KEYWORD_LIFECYCLE_BATCH_MAX + ' per call) '
      + 'or `filter` (the current filter — q / productLine / svTier / lifecycleStatus / … — resolved on the server against the same '
      + 'filter implementation the master library uses). A filter selection is hard-capped at ' + KEYWORD_LIFECYCLE_BATCH_MAX + ' words too: '
      + 'a single call never widens itself, and the result reports `matched` (how many the filter hits), `alreadyAtTarget` (already there, '
      + 'so not this batch) and `remaining` (still to go after this batch) — without those numbers "500 changed" says nothing about 30,778. '
      + '**All-or-nothing**: one word outside the library, one bad entry, one illegal edge or one word already at the target refuses the '
      + '**whole** batch and lists every offender; nothing is written. `by` and `reason` are required — a batch of up to ' + KEYWORD_LIFECYCLE_BATCH_MAX
      + ' rows has to be reviewable. The resolved selection (which filter, how many matched, how many selected) is written into every event '
      + 'row, so "why were these words changed" stays answerable. `dryRun: true` returns the plan and writes nothing. '
      + 'Not the publication association — that one is `amzn_keyword_lifecycle_batch` and carries a publicationId.',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: `The words to move (the ticked ones). At most ${KEYWORD_LIFECYCLE_BATCH_MAX}. Give this or filter, not both.`,
        },
        filter: {
          type: 'object',
          description: 'A selection by filter instead of by words: { q, productLine, svTier, priority, opportunity, ownStatus, '
            + 'minVolume, maxVolume, hasAba, hasAd, hasCompetitor, lifecycleStatus }. Unknown keys are refused (they would widen the selection silently).',
        },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US. Required — a transition is per (keyword, marketplace).' },
        to: { type: 'string', enum: KEYWORD_LIFECYCLE_STATES, description: 'The target state.' },
        by: { type: 'string', description: 'Who made this decision. Required and non-blank — an unattributed batch is not a decision.' },
        reason: { type: 'string', description: 'Why. Required and non-blank, recorded on every event row.' },
        evidence: { type: 'object', description: 'Structured evidence for the decision, stored as JSON on every event row.' },
        dryRun: { type: 'boolean', description: 'Report the plan (wouldApply) and write nothing. Default false.' },
      },
      required: ['marketplace', 'to', 'by', 'reason'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const result = setKeywordLifecycleBatch(store, {
          keywords: args?.keywords ?? null,
          filter: args?.filter ?? null,
          marketplace: args?.marketplace,
          to: args?.to,
          by: args?.by ?? null,
          reason: args?.reason ?? null,
          evidence: args?.evidence ?? null,
          dryRun: args?.dryRun === true,
        })
        const selection = result.selection
        const picked = result.dryRun ? result.wouldApply : result.applied
        const lines = [
          `批量改生命周期${result.dryRun ? '（预览，未写库）' : ''} · ${result.marketplace}  → ${result.to}(${LABEL(result.to)})`,
          selection.kind === 'filter'
            ? `选区：筛选命中 ${selection.matched} 词；已在 ${result.to} ${selection.alreadyAtTarget} 词（不是本批对象）；本批选中 ${selection.selected} 词`
            : `选区：勾选 ${selection.selected} 词`,
          result.dryRun
            ? `预览：会写 ${picked.length} 条流转（预览与执行是同一个函数，数字不会分叉）`
            : `已写 ${picked.length} 条流转，追加 ${result.eventIds.length} 条事件（source=manual，by=${args?.by ?? ''}）`,
        ]
        const head = picked.slice(0, 20)
        for (const entry of head) {
          lines.push(`  · ${truncate(entry.keyword, 40)}: ${entry.from === null ? '(首次)' : entry.from} → ${result.to}`)
        }
        if (picked.length > head.length) lines.push(`  … 其余 ${picked.length - head.length} 条略（事件表里逐条都在）`)
        lines.push('')
        if (selection.kind === 'filter') {
          lines.push(
            `剩余：本筛选下还有 ${result.remaining} 词可流转`
            + (result.remaining > 0 ? '；用同一个筛选再调一次即接着改下一批（一次最多 ' + KEYWORD_LIFECYCLE_BATCH_MAX + ' 词）。' : '。'),
          )
        }
        /* 「还剩多少」要有一个分母：全库仍「未设置」的条数。30,778 条里的 500 条，
           不印分母就是一句没有信息量的话。 */
        lines.push(`全库口径：${result.marketplace} 仍「未设置」${result.libraryUnset} 条（没人决定过，不是 candidate）。`)
        if (selection.kind === 'filter') {
          lines.push('', '这次改动的选区（哪个筛选、命中多少、选中多少）已写进每一条事件行 —— 事后可回答「这 500 个词为什么被改」。')
        }
        return lines.join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: 'all-or-nothing：一个词不合法就整批不写。一次最多 ' + KEYWORD_LIFECYCLE_BATCH_MAX + ' 词；'
            + 'keywords 与 filter 只能给一个；by 与 reason 必填；同态与非法边都会被拒（不会静默成功）。',
        }
      }
    },
  }
}
