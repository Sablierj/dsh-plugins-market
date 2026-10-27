/**
 * The position-plan tools (module 08 F08-05).
 *
 * Five tools, split read/write on purpose:
 *
 *   amzn_keyword_plan_list      read  — the ASIN's plan versions
 *   amzn_keyword_plan_get       read  — one plan and its entries
 *   amzn_keyword_plan_propose   read  — a proposal derived from kw_master, writing nothing
 *   amzn_keyword_plan_save      write — create v1, or a new version in the same lineage
 *   amzn_keyword_plan_coverage  read  — planned vs actual, as two separate values
 *
 * ## The name that was not chosen
 *
 * `amzn_keyword_plan_apply` does not exist and never will: this plugin has a
 * guard (`tests/m14-observation.mjs`) that refuses any tool whose name after the
 * `amzn_` prefix matches `publish|apply|push|deploy`, because a tool that
 * *sounds* like it touches the live listing must not exist here. The write is a
 * local plan row, so the honest name is `_save`. (F08-07 and F08-04 hit the same
 * guard and fixed it the same way.)
 *
 * ## The one thing the coverage tool must never do
 *
 * `amzn_keyword_plan_coverage` returns `planned` and `actual` as **two separate
 * values**. With no listing text it returns `actual: null` and a reason — never
 * `0`, and never the planned number. 「把计划覆盖当实际覆盖」 is §22.5's named
 * Agent prohibition, and a single number would make it the silent default.
 */

import { table, text, truncate } from './render.js'
import {
  getPlan, listPlans, planCoverage, planHistory, planPositions, proposePlan, savePlan,
} from '../store/keyword-plan.js'
import { PLAN_SOURCES, PLAN_STATUSES, PLAN_STATUS_LABELS } from '../domain/states.js'

const STATUS_LABEL = status => PLAN_STATUS_LABELS[status] ?? status

/** The eight positions, one line each, for the honest footnote. */
function positionFootnote() {
  return planPositions().map(position => `${position.id}（${position.label}${position.manual ? '·人工' : ''}）：${position.purpose}`)
}

function planLine(plan) {
  return `${plan.asin} · ${plan.marketplace} · v${plan.version} · ${STATUS_LABEL(plan.status)} · `
    + `${plan.source} · ${plan.entryCount ?? '?'} 词${plan.name ? ` · ${plan.name}` : ''}`
}

export function keywordPlanListTool({ store }) {
  return {
    name: 'amzn_keyword_plan_list',
    description:
      'List the position-plan versions for an ASIN and marketplace (both optional; omit for all). '
      + 'A plan is a **decision** — which position each keyword is assigned to — and it is the **only** '
      + 'persisted form of it (module 08; module 13 references it, never stores a second copy). '
      + 'This is not `kw_master.for_listing_json`: that is *eligibility* (which positions a word may occupy), '
      + 'not the assignment. Versions of one plan share a lineage; the newest is first.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US. Omit for all.' },
        asin: { type: 'string', description: 'ASIN. Omit for all.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const plans = listPlans(store, { marketplace: args?.marketplace ?? null, asin: args?.asin ?? null })
        const lines = [`位置计划 · ${plans.length} 个版本`]
        if (plans.length === 0) {
          lines.push('还没有任何位置计划。用 amzn_keyword_plan_propose 生成一份提案，再用 amzn_keyword_plan_save 存下。')
        } else {
          lines.push('', table(plans, [
            { label: 'ASIN', value: plan => plan.asin },
            { label: '站点', value: plan => plan.marketplace },
            { label: '版本', value: plan => `v${plan.version}` },
            { label: '状态', value: plan => STATUS_LABEL(plan.status) },
            { label: '词数', value: plan => String(plan.entryCount ?? '') },
            { label: '来源', value: plan => plan.source },
            { label: '名称', value: plan => truncate(plan.name ?? '', 30) },
          ]))
        }
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message, hint: 'marketplace 与 asin 都可选。' }
      }
    },
  }
}

export function keywordPlanGetTool({ store }) {
  return {
    name: 'amzn_keyword_plan_get',
    description:
      'Read one position plan by id: its header and every entry (keyword, owner position, supporting slots). '
      + '一词一主人 is structural here — `keyword_plan_entry` is keyed by (plan_id, keyword), so a keyword '
      + 'cannot have two owners inside one plan. 一位一用途: an entry assigns a word to a position and can '
      + 'never redefine what that position is for. Returns the same entry shape as amzn_keyword_plan_propose, '
      + 'so a proposal and a saved plan can be diffed directly.',
    parameters: {
      type: 'object',
      properties: { planId: { type: 'string', description: 'The plan id.' } },
      required: ['planId'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const loaded = getPlan(store, { planId: args?.planId })
        if (loaded === null) return { ok: false, error: `no plan ${args?.planId}` }
        const { plan, entries } = loaded
        const lines = [
          `位置计划 ${plan.id}`,
          `${planLine(plan)} · 版本族 ${plan.lineageId}`,
          plan.note ? `备注：${plan.note}` : '（无备注）',
          '',
        ]
        if (entries.length === 0) {
          lines.push('这个计划没有任何条目。')
        } else {
          lines.push(table(entries, [
            { label: '词', value: entry => truncate(entry.keyword, 32) },
            { label: '主人位置', value: entry => entry.ownerPosition },
            { label: '层级', value: entry => entry.tier ?? '—' },
            { label: '搜索量', value: entry => (entry.searchVolume === null ? '—' : String(entry.searchVolume)) },
            { label: '复现位', value: entry => (entry.supporting.length === 0
              ? '—'
              : entry.supporting.map(slot => slot.position).join(' / ')) },
          ]))
        }
        /* The lineage's other versions, so "this is v2" is not the only thing the
           reader learns — the whole point of versions is to see them together. */
        const history = planHistory(store, { lineageId: plan.lineageId })
        if (history.length > 1) {
          lines.push('', `版本族 ${plan.lineageId} 共 ${history.length} 版：`
            + history.map(item => `v${item.version}（${STATUS_LABEL(item.status)}·${item.entryCount ?? '?'} 词）`).join(' · '))
        }
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message, hint: 'planId 必填。' }
      }
    },
  }
}

export function keywordPlanProposeTool({ store }) {
  return {
    name: 'amzn_keyword_plan_propose',
    description:
      'Derive a **proposal** from the keyword master library: one owner position per keyword, chosen from '
      + 'kw_master.for_listing_json (eligibility) by strength order title → bullets → adsExact → adsPhrase → '
      + 'adsBroad → backend. **Read-only — it writes nothing.** '
      + 'It never proposes `attributes` or `negatives` as an owner: those two positions have **no eligibility '
      + 'rule** in this module (their eligibility is manual), so assigning from them would be inventing a rule. '
      + 'Supporting slots are not derived either — eligibility is not assignment. '
      + 'Returns the same entry shape as amzn_keyword_plan_get, so the result can be diffed against a saved plan '
      + 'before amzn_keyword_plan_save stores it.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'The ASIN this proposal is for. Optional.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
      },
      required: ['marketplace'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      try {
        const proposal = proposePlan(store, { asin: args?.asin ?? null, marketplace: args?.marketplace })
        const lines = [
          `位置计划提案（未写库） · ${proposal.marketplace}${proposal.asin ? ` · ${proposal.asin}` : ''}`,
          `共 ${proposal.entries.length} 词可提案，每词一个主人`
            + (proposal.skipped.length > 0 ? ` · 跳过 ${proposal.skipped.length} 行` : ''),
          '',
        ]
        if (proposal.entries.length > 0) {
          const byOwner = {}
          for (const entry of proposal.entries) byOwner[entry.ownerPosition] = (byOwner[entry.ownerPosition] ?? 0) + 1
          lines.push('按主人位置：' + Object.entries(byOwner).map(([position, n]) => `${position} ${n}`).join(' · '))
          lines.push('', table(proposal.entries.slice(0, 50), [
            { label: '词', value: entry => truncate(entry.keyword, 34) },
            { label: '主人位置', value: entry => entry.ownerPosition },
            { label: '层级', value: entry => entry.tier ?? '—' },
            { label: '搜索量', value: entry => (entry.searchVolume === null ? '—' : String(entry.searchVolume)) },
          ]))
          if (proposal.entries.length > 50) lines.push(`（只显示前 50 条，共 ${proposal.entries.length} 条）`)
        }
        /* 被跳过的行**列出来**，不静默丢 —— 一行坏资格不该让整份提案消失，也不该
           悄无声息地少一个词。 */
        if (proposal.skipped.length > 0) {
          lines.push('', `跳过 ${proposal.skipped.length} 行（没有可用的资格，未静默重算）：`)
          lines.push(table(proposal.skipped.slice(0, 20), [
            { label: '词', value: item => truncate(item.keyword, 34) },
            { label: '原因', value: item => truncate(item.reason, 60) },
          ]))
        }
        lines.push('', proposal.note)
        return { ok: true, entries: proposal.entries, skipped: proposal.skipped, text: lines.join('\n') }
      } catch (error) {
        return { ok: false, error: error.message, hint: 'marketplace 必填；asin 可选。这个工具不写库。' }
      }
    },
  }
}

export function keywordPlanSaveTool({ store }) {
  return {
    name: 'amzn_keyword_plan_save',
    description:
      'Save a position plan: create version 1, or a **new version in the same lineage** when `lineageId` is '
      + 'given (the prior version is left untouched, so "what did we decide before" stays answerable). '
      + 'Refuses, writing nothing, when: an owner position is outside the vocabulary; a keyword appears twice '
      + '(一词一主人 — the table primary key makes this impossible anyway, and the refusal gives a readable '
      + 'reason); a supporting position is outside the vocabulary, equals the owner, or has no reason '
      + '(supporting_reuse_requires_field_and_reason). This is the **only** persistence layer for the plan '
      + '(module 08); it does not publish anything.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'The ASIN this plan is for.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
        name: { type: 'string', description: 'Optional plan name.' },
        note: { type: 'string', description: 'Optional note.' },
        entries: {
          type: 'array',
          description: 'One object per keyword: { keyword, ownerPosition, tier?, searchVolume?, supporting?: [{ position, reason, probe? }] }.',
          items: { type: 'object' },
        },
        source: { type: 'string', enum: PLAN_SOURCES, description: 'manual (default) | agent | proposal.' },
        status: { type: 'string', enum: PLAN_STATUSES, description: 'draft (default) | active | archived.' },
        lineageId: { type: 'string', description: 'Revise an existing plan: the lineage to add a version to. Omit to start a new plan.' },
        createdBy: { type: 'string', description: 'Who saved it.' },
      },
      required: ['asin', 'marketplace', 'entries'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      try {
        const saved = savePlan(store, {
          asin: args?.asin,
          marketplace: args?.marketplace,
          name: args?.name ?? null,
          note: args?.note ?? null,
          entries: args?.entries ?? [],
          source: args?.source ?? 'manual',
          status: args?.status ?? 'draft',
          lineageId: args?.lineageId ?? null,
          createdBy: args?.createdBy ?? null,
        })
        /* 返回**结构化**值（不是纯字符串），照 `amzn_workspace_upsert` 的先例：新建时
           计划 id 只在返回值里，审计描述符的 `objectId` 才能读到它（`value?.plan?.id`）。
           否则工具路径的审计行 `object_id` 恒为 null，与页面路径不一致 —— 正是
           S1-B13.1「带出去的 id 得有人读」要防的。 */
        return {
          ok: true,
          plan: saved.plan,
          text: [
            `位置计划已保存：${planLine({ ...saved.plan, entryCount: saved.entries.length })}`,
            `id ${saved.plan.id} · 版本族 ${saved.plan.lineageId}`,
            '改计划请带上 lineageId —— 新版本进同一个版本族，旧版本保持原样。',
          ].join('\n'),
        }
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: 'ownerPosition 必须是八个位置之一；同一个词不能出现两次；'
            + 'supporting 的位置必须在词表里、不能等于主人、且必须有 reason。',
        }
      }
    },
  }
}

export function keywordPlanCoverageTool({ store }) {
  return {
    name: 'amzn_keyword_plan_coverage',
    description:
      'Planned coverage vs **actual** coverage, as two separate values. '
      + '`planned` comes from the persisted entries: cells per position and the total. '
      + '`actual` is computed **only when listing text (`fields`) is supplied**; with no text it is `null` '
      + 'together with a reason — **never 0 and never the planned number**. A zero cannot be told apart from '
      + '"planned 10, reached 0", and returning the planned number as the actual is 「把计划覆盖当实际覆盖」 '
      + '(§22.5) — the failure this tool exists to make impossible. `fillRate` is returned only when `actual` '
      + 'is not null. Ad positions and `negatives` cannot be proven from listing copy, so they are reported '
      + 'under `unverifiable`, not counted as reached.',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'The plan to measure.' },
        fields: {
          type: 'object',
          description: 'Listing copy to check actual coverage against (title / bullet_1… / attribute.* / search_terms). '
            + 'Omit to get planned only, with actual = null.',
        },
      },
      required: ['planId'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      try {
        /* Explicitly, not `args?.fields ?? null`: `{}` and `{ title: '' }` are an
           absent listing written another way, and `planCoverage` decides that by
           content. Passing them through is what lets it return `actual: null`
           instead of a zero nobody can tell from "measured, nothing filled". */
        const hasFields = args !== null && args !== undefined
          && args.fields !== null && args.fields !== undefined
        const coverage = planCoverage(store, { planId: args?.planId, fields: hasFields ? args.fields : null })
        const lines = [
          `位置计划覆盖 · ${coverage.planId}`,
          `**计划覆盖**：共 ${coverage.planned.total} 格`
            + `（可核对 ${coverage.planned.checkableTotal} 格：${coverage.planned.checkable.join(' / ') || '—'}）`,
          '按位置：' + Object.entries(coverage.planned.byPosition)
            .map(([position, n]) => `${position} ${n}`).join(' · '),
        ]
        if (coverage.planned.unverifiable.length > 0) {
          lines.push('无法从 listing 文案核对（广告后台 / 后台否定词）：'
            + coverage.planned.unverifiable.map(item => `${item.position} ${item.planned}`).join(' · '))
        }
        lines.push('')
        if (coverage.actual === null) {
          lines.push('**实际覆盖：无法计算（null）**', coverage.reason)
          lines.push('要算实际覆盖，请传入 listing 文案（fields）。')
        } else {
          lines.push(`**实际覆盖**：${coverage.actual.total} 格 / 可核对 ${coverage.planned.checkableTotal} 格`
            + `（fillRate ${coverage.fillRate}）`)
          lines.push('按位置：' + Object.entries(coverage.actual.byPosition)
            .map(([position, n]) => `${position} ${n}`).join(' · '))
          lines.push('计划与实际是两个数，**分开统计** —— 计划数不是实际数。')
        }
        lines.push('', ...positionFootnote())
        return lines.join('\n')
      } catch (error) {
        return { ok: false, error: error.message, hint: 'planId 必填；fields 可选，不传则实际覆盖为 null。' }
      }
    },
  }
}
