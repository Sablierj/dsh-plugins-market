/**
 * Workbench context tools.
 *
 * `amzn_workbench_context` is the seam that makes the page and the conversation
 * one thing instead of two. Without it the user has to paste an ASIN into the
 * chat after selecting it on the page; with it, "优化这个" already has a referent.
 * It is cheap — one tool reading one in-memory object — which is exactly why it
 * is worth having.
 *
 * `amzn_workbench_focus` is the same channel backwards: the agent can move the
 * page (open a module, select rows) so a follow-up question lands on the right
 * screen.
 */

import { MODULES } from '../state/workbench.js'
import { text, table } from './render.js'
import { counts } from '../store/queries.js'
import { SCOPE_ALL, SCOPE_LEVELS } from '../domain/context/scope.js'

const MODULE_LABEL = new Map(MODULES.map(module => [module.id, module.label]))

export function workbenchContextTool({ workbench, store }) {
  return {
    name: 'amzn_workbench_context',
    description:
      'Read what the Amazon workbench page currently has selected and open. '
      + 'Call this FIRST whenever the user refers to a product without naming it — "这个", "它", "当前这个 ASIN", '
      + '"选中的几个", "优化这个" — because the page and this conversation share one selection. '
      + 'It also returns the five-level scope the page is showing (workspace / site / shop / brand / product line) and '
      + 'the id of that scope, so you can tell which slice of the store every number below is about, plus the module '
      + 'the user is looking at, the active filters, and the most recent agent activity.',
    parameters: {
      type: 'object',
      properties: {
        includeActivity: { type: 'boolean', description: 'Include the recent activity feed. Default true.' },
        activityLimit: { type: 'number', description: 'How many recent activity entries to return. Default 10, max 50.' },
      },
    },
    /* The tool answers with an object rather than a string so the scope id and
       the scope it was derived from stay separable: the rendered text is for the
       model, `contextId` / `scope` are for anything that has to compare them
       without parsing prose. */
    output: { schema: {}, render: (_args, value) => text(value.text ?? value) },
    async execute(args) {
      const context = workbench.get()
      const includeActivity = args?.includeActivity !== false
      const limit = Number.isFinite(Number(args?.activityLimit)) ? Number(args.activityLimit) : 10
      const scope = context.scope ?? {}

      const lines = [
        `模块: ${MODULE_LABEL.get(context.module) ?? context.module} (${context.module})`,
        /* One line, from the same `describeScope` the page's bar uses, so what
           the user reads on screen and what the model is told cannot differ. */
        `上下文: ${context.scopeText}`,
        `context_id: ${context.contextId}`,
        `作用域(${SCOPE_LEVELS.join(' / ')}): ${SCOPE_LEVELS.map(level => `${level}=${scope[level] ?? SCOPE_ALL}`).join(', ')}`,
        `选中 ASIN: ${context.selection.asins.length}`,
      ]

      if (context.selection.asins.length > 0) {
        lines.push(table(context.selection.asins, [
          { label: 'ASIN', value: row => row.asin },
          { label: '站点', value: row => row.marketplace },
        ]))
        lines.push('→ 用户说「这个 / 它」时，默认指上面这些 ASIN。')
      } else {
        lines.push('（页面上没有选中任何 ASIN；如果用户说「这个」而这里为空，直接问他是哪一个）')
      }

      const sets = context.selection.competitorSets ?? []
      lines.push(`选中竞品组: ${sets.length}${sets.length > 0 ? ' — ' + sets.join(', ') : ''}`)
      if (context.selection.keywords.length > 0) {
        lines.push(`选中关键词: ${context.selection.keywords.join(', ')}`)
      }
      if (Object.keys(context.filters).length > 0) {
        lines.push(`当前筛选: ${JSON.stringify(context.filters)}`)
      }
      if (context.note) lines.push(`备注: ${context.note}`)

      const stats = counts(store)
      lines.push('')
      lines.push(`库内数据: ASIN ${stats.asin} / 关键词 ${stats.keyword} / ASIN-关键词关联 ${stats.asinKeyword} / 采集任务 ${stats.collectionTask} / 优化轮次 ${stats.optimizationRun}`)
      lines.push(`上下文更新时间: ${context.updatedAt}`)

      if (includeActivity) {
        // Only finished calls: `tool:start` exists for the page's live feed, but
        // for the model it would double every line and say nothing.
        const events = workbench.recent(limit * 2)
          .filter(event => event.kind === 'tool:done' || event.kind === 'tool:error')
          .slice(-limit)
        lines.push('')
        lines.push(`最近操作 (${events.length}):`)
        if (events.length === 0) lines.push('(暂无)')
        for (const event of events) {
          const payload = event.payload ?? {}
          const detail = payload.ok === false ? `失败: ${payload.error ?? ''}` : (payload.summary ?? '')
          lines.push(`- ${event.at} ${payload.tool ?? event.kind} ${detail}`.trim())
        }
      }

      return {
        text: lines.join('\n'),
        contextId: context.contextId,
        scope,
        scopeText: context.scopeText,
        scopeRevision: context.scopeRevision,
        selectedAsins: context.selection.asins.length,
        selectedCompetitorSets: sets.length,
      }
    },
  }
}

export function workbenchFocusTool({ workbench }) {
  return {
    name: 'amzn_workbench_focus',
    description:
      'Point the Amazon workbench page at something: switch the open module, replace the ASIN selection, set the '
      + 'five-level scope, choose competitor sets, set filters, or leave a note. Use it to put the user in front of '
      + 'the right screen before asking them to look at it, and to clear the selection once you have finished with it. '
      + 'Setting the scope is what narrows every panel: the site is required, the other four levels accept the literal '
      + '"__all__" for "everything at this level". '
      + 'This changes only the page — it writes nothing to the database.',
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', description: `One of: ${MODULES.map(m => m.id).join(' | ')}` },
        scope: {
          type: 'object',
          description: 'The five-level context. Levels not given keep their current value.',
          properties: {
            workspaceId: { type: 'string', description: 'Workspace id. Defaults to ws-default.' },
            marketplace: { type: 'string', description: 'Site code, e.g. US / DE / JP. Required in effect — an empty one falls back to US.' },
            shopId: { type: 'string', description: 'Shop id, or "__all__".' },
            brandId: { type: 'string', description: 'Brand id, or "__all__".' },
            productLineId: { type: 'string', description: 'Product line id, or "__all__".' },
          },
        },
        asins: {
          type: 'array',
          description: 'Replace the selection with these ASINs. An empty array clears it.',
          items: {
            type: 'object',
            properties: {
              asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
              marketplace: { type: 'string', description: 'Marketplace code, e.g. US / DE / JP. Default US.' },
            },
          },
        },
        keywords: {
          type: 'array',
          description: 'Replace the selected keywords. A bare string works, but pass the marketplace when you know it — the same word ranks differently per site.',
          items: {
            type: 'object',
            properties: {
              keyword: { type: 'string', description: 'The search term.' },
              marketplace: { type: 'string', description: 'Marketplace code, e.g. US / DE / JP. Optional.' },
            },
          },
        },
        competitorSets: {
          type: 'array',
          description: 'Replace the selected competitor sets with these ids. An empty array clears them.',
          items: { type: 'string', description: 'A competitor_set id.' },
        },
        filters: { type: 'object', description: 'Arbitrary filter object shown in the page chips.' },
        note: { type: 'string', description: 'A short note shown above the selection.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const patch = {}
      if (args?.module !== undefined) patch.module = args.module
      /* A partial scope merges into the current one rather than replacing it:
         "show me DE" should not also reset the shop, the brand and the product
         line the user had narrowed to. `set()` canonicalises the result, so a
         level left out arrives as its current value, not as a hole. */
      if (args?.scope !== undefined) patch.scope = { ...workbench.get().scope, ...args.scope }
      if (args?.asins !== undefined || args?.keywords !== undefined || args?.competitorSets !== undefined) {
        const current = workbench.get().selection
        patch.selection = {
          asins: args.asins !== undefined ? args.asins : current.asins,
          keywords: args.keywords !== undefined ? args.keywords : current.keywords,
          competitorSets: args.competitorSets !== undefined ? args.competitorSets : current.competitorSets,
        }
      }
      if (args?.filters !== undefined) patch.filters = args.filters
      if (args?.note !== undefined) patch.note = args.note

      const context = workbench.set(patch, 'agent')
      return `工作台已更新。模块=${context.module}，上下文=${context.scopeText}，context_id=${context.contextId}，`
        + `选中 ASIN=${context.selection.asins.length}，选中竞品组=${context.selection.competitorSets.length}，更新于 ${context.updatedAt}`
    },
  }
}
