/**
 * 关键词的**产品线归属**工具（v69，F-5 的 B 半）。
 *
 * 一条写：`amzn_keyword_product_line_batch_set` —— 把一批词的人工归属改成一条产品线，
 * 或者撤销（回到派生值）。读口是 `store/keyword-product-line.js` 的
 * `effectiveProductLine`（**唯一**判定处）；这个文件不判断任何「人工 > 派生」，
 * 它只把参数交给 store，再把人读得懂的结果画出来。
 *
 * ## 为什么是「批量」而不是「单条 + 循环」
 *
 * 与 `amzn_keyword_lifecycle_batch_set` 同一条理由：走查看到总库 30,778 条、
 * 「未分类」3,386 条，单条操作走不通。而且归属是**一次裁决**（这批词属于哪条线），
 * 不是 300 次独立决定 —— 事件行要能回答「这一次为什么把它们划过去」。
 *
 * ## 与生命周期批量的同一套骨架（不另起一套）
 *
 * 上限 / 坏项拒收 / 筛选词表 / 选区进事件行 / `dryRun` 与执行同函数，全部复用
 * `store/keyword-lifecycle.js` 里的 `normalizeBatchKeywords` / `normalizeBatchFilter` /
 * `batchSelectionEvidence`。两处不同都是这张表的事：`to` 必须是**已存在的产品线 id**
 * （或撤销），并且「已经在目标值」按**人工值**判断。
 */

import { table, text, truncate } from './render.js'
import {
  KEYWORD_PRODUCT_LINE_BATCH_MAX, effectiveProductLine, keywordProductLineHistory,
  productLineOptions, setKeywordProductLineBatch,
} from '../store/keyword-product-line.js'

/** 三档来源的人读写法。页面与工具用同一组词：人工 / 自动 / 未分类。 */
const SOURCE_LABELS = { manual: '人工', derived: '自动', unclassified: '未分类' }

export function keywordProductLineBatchSetTool({ store }) {
  return {
    name: 'amzn_keyword_product_line_batch_set',
    description:
      'Set the **manual product line** of a selection of keywords — or revoke it, falling back to the derived value. '
      + 'Name exactly one selection: `keywords` (the ticked words, at most ' + KEYWORD_PRODUCT_LINE_BATCH_MAX + ' per call) or `filter` '
      + '(the current filter — q / productLine / svTier / lifecycleStatus / … — resolved on the server against the same filter '
      + 'implementation the master library uses; hard-capped at ' + KEYWORD_PRODUCT_LINE_BATCH_MAX + ' too, and it reports '
      + '`matched` / `alreadyAtTarget` / `remaining`). '
      + 'The effective product line is **manual > derived**: `kw_master.product_line` is recomputed from the facts on every import, '
      + 'so a manual value cannot live there — it is stored in `keyword_product_line` and survives recomputes. `source` in a read is '
      + 'one of manual / derived / unclassified, and **`unclassified` means "no signal matched, so it fell back to the default line"**, '
      + 'not "it belongs to the default line". '
      + '**All-or-nothing**: one word outside the library, one bad entry, one unknown product line id or one word already at the target '
      + 'refuses the whole batch and lists the offenders; nothing is written. `by` and `reason` are required; the resolved selection is '
      + 'written into every event row. Pass `revoke: true` (no `to`) to drop the manual decision and go back to the derived value. '
      + '`dryRun: true` returns the plan and writes nothing.',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: `The words to reassign (the ticked ones). At most ${KEYWORD_PRODUCT_LINE_BATCH_MAX}. Give this or filter, not both.`,
        },
        filter: {
          type: 'object',
          description: 'A selection by filter instead of by words. Unknown keys are refused (they would widen the selection silently).',
        },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US. Required.' },
        to: { type: 'string', description: 'The product line id to assign. Must exist in the product_line table. Omit when revoking.' },
        revoke: {
          type: 'boolean',
          description: 'Drop the manual decision for these words so they fall back to the derived value. Give this or `to`, not both.',
        },
        by: { type: 'string', description: 'Who made this decision. Required and non-blank.' },
        reason: { type: 'string', description: 'Why. Required and non-blank, recorded on every event row.' },
        evidence: { type: 'object', description: 'Structured evidence for the decision, stored as JSON on every event row.' },
        dryRun: { type: 'boolean', description: 'Report the plan and write nothing. Default false.' },
      },
      required: ['marketplace', 'by', 'reason'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const wantsRevoke = args?.revoke === true
        const hasTo = args?.to !== undefined && args?.to !== null && String(args.to).trim() !== ''
        if (wantsRevoke && hasTo) {
          return {
            ok: false,
            error: 'revoke and to are mutually exclusive — one decision cannot both assign and drop a product line',
            hint: '撤销只给 revoke: true；设定归属只给 to。',
          }
        }
        if (!wantsRevoke && !hasTo) {
          return {
            ok: false,
            error: 'name the decision: `to` (a product line id) or `revoke: true`',
            hint: '设定归属给 to；撤销给 revoke: true。两者都不给就是没说清要做什么。',
          }
        }
        const result = setKeywordProductLineBatch(store, {
          keywords: args?.keywords ?? null,
          filter: args?.filter ?? null,
          marketplace: args?.marketplace,
          to: wantsRevoke ? null : String(args.to),
          by: args?.by ?? null,
          reason: args?.reason ?? null,
          evidence: args?.evidence ?? null,
          dryRun: args?.dryRun === true,
        })
        const selection = result.selection
        const picked = result.dryRun ? result.wouldApply : result.applied
        const names = new Map(productLineOptions(store).map(option => [option.id, option.name]))
        const targetLabel = result.to === null
          ? '撤销人工归属（回到派生值）'
          : `${result.to}(${names.get(result.to) ?? '?'})`
        const lines = [
          `批量改产品线归属${result.dryRun ? '（预览，未写库）' : ''} · ${result.marketplace}  → ${targetLabel}`,
          selection.kind === 'filter'
            ? `选区：筛选命中 ${selection.matched} 词；已达到目标 ${selection.alreadyAtTarget} 词（不是本批对象）；本批选中 ${selection.selected} 词`
            : `选区：勾选 ${selection.selected} 词`,
          result.dryRun
            ? `预览：会写 ${picked.length} 条归属变更（预览与执行是同一个函数，数字不会分叉）`
            : `已写 ${picked.length} 条归属变更，追加 ${result.eventIds.length} 条事件（source=manual，by=${args?.by ?? ''}）`,
        ]
        for (const entry of picked.slice(0, 20)) {
          lines.push(`  · ${truncate(entry.keyword, 40)}: ${entry.from === null ? '(无人工归属)' : entry.from} → ${result.to === null ? '(撤销)' : result.to}`)
        }
        if (picked.length > 20) lines.push(`  … 其余 ${picked.length - 20} 条略（事件表里逐条都在）`)
        lines.push('')
        if (selection.kind === 'filter') {
          lines.push(`剩余：本筛选下还有 ${result.remaining} 词可改` + (result.remaining > 0
            ? `；用同一个筛选再调一次即接着改下一批（一次最多 ${KEYWORD_PRODUCT_LINE_BATCH_MAX} 词）。`
            : '。'))
        }
        /* 三档计数：改完这一批之后，这个站点分别有多少是人工 / 自动 / 未分类。
           分母是总库条数 —— 没有分母的「改了 500 个」不构成信息。 */
        lines.push('', '改完之后用 amzn_keyword 的 action="query" 看某一类的词；「未分类」= 没有信号命中（暂落默认线），不是「属于默认线」。')
        return lines.join('\n')
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: 'all-or-nothing：一个词不合法就整批不写。一次最多 ' + KEYWORD_PRODUCT_LINE_BATCH_MAX + ' 词；'
            + 'keywords 与 filter 只能给一个；by 与 reason 必填；product line id 必须已存在；'
            + '撤销用 revoke: true（不是 to: null）。',
        }
      }
    },
  }
}

/**
 * 读一个词的归属（含三档来源与人工决定）。工具层只做展示：
 * 「凭什么」全部来自 store 的 `effectiveProductLine`。
 */
export function keywordProductLineGetTool({ store }) {
  return {
    name: 'amzn_keyword_product_line_get',
    description:
      'Read the **effective** product line of one keyword: the manual value when there is one, otherwise the derived value, '
      + 'and which of the three it is (manual / derived / unclassified). `unclassified` means no signal matched and the value you '
      + 'see is only the default-line fallback — it is NOT "belongs to the default line". Also returns the manual decision '
      + '(who / why / when) when one exists, and the full decision history.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The keyword. Case-insensitive; stored folded.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
      },
      required: ['keyword', 'marketplace'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const effective = effectiveProductLine(store, { keyword: args?.keyword, marketplace: args?.marketplace })
        if (effective === null) {
          return `关键词 "${args?.keyword}" 不在 ${String(args?.marketplace ?? '').toUpperCase()} 总库里 —— `
            + '「不在总库」不是「未分类」，两者不能印成同一句话。'
        }
        const names = new Map(productLineOptions(store).map(option => [option.id, option.name]))
        const label = id => (id === null || id === undefined ? '(无)' : `${id}(${names.get(id) ?? '?'})`)
        const events = keywordProductLineHistory(store, { keyword: args?.keyword, marketplace: args?.marketplace })
        const lines = [
          `${effective.keyword} · ${effective.marketplace}`,
          `生效归属：${label(effective.value)} · ${SOURCE_LABELS[effective.source] ?? effective.source}`,
        ]
        if (effective.source === 'unclassified') {
          lines.push('  「未分类」= 没有任何产品线信号命中，于是落到默认线 —— 不是「属于默认线」。')
        }
        if (effective.source === 'derived') {
          lines.push(`  派生依据：命中信号「${effective.matched ?? '?'}」；全部命中 ${effective.productLines.join(' / ') || '（无）'}。`)
        }
        if (effective.manual !== null) {
          lines.push(
            `  人工决定：by ${effective.manual.by ?? '(未记)'} · ${effective.manual.reason ?? '(未记理由)'} · ${effective.manual.changedAt}`,
          )
        }
        if (effective.revoked) lines.push('  人工归属已被撤销（有事件可查），生效值回到派生值。')
        lines.push('')
        if (events.length === 0) {
          lines.push('归属历史：没有任何人工归属事件（未设置，不是「设为默认线」）。')
        } else {
          lines.push(table(events, [
            { label: '时间', value: row => row.at },
            { label: '从', value: row => (row.from_product_line_id === null ? '(无)' : row.from_product_line_id) },
            { label: '到', value: row => (row.to_product_line_id === null ? '(撤销)' : row.to_product_line_id) },
            { label: '来源', value: row => row.source },
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
