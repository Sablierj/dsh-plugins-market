/**
 * `amzn_asin_health` — the per-ASIN data health summary (module 05, F05-07).
 *
 * Read-only, and the same builder the page's `GET /api/asin-health` calls. The two
 * injections the builder demands (`fields` from `buildFieldFacts`, `precheck` from
 * `precheckFor`) are resolved here, which is what keeps the "one criterion, one
 * implementation" promise: this tool computes nothing twice, and neither does the
 * page.
 *
 * The renderer prints the `unsourced[]` block even when every item succeeded. It is
 * the half a reader would otherwise not know to ask for: a criterion they expect to
 * see, which this repository cannot answer, said in words rather than drawn as a
 * zero.
 */

import {
  ASIN_HEALTH_ITEM_IDS, ASIN_HEALTH_NO_SOURCE_TEXT, ASIN_HEALTH_STATE_LABELS,
  buildAsinHealthSummary,
} from '../domain/asin/health.js'
import { buildFieldFacts } from '../domain/asin/fields.js'
import { precheckFor } from './optimize.js'
import { table, text, truncate } from './render.js'

/** `3/10` with its unit, or a bare count when the item has no denominator. */
function ratio(entry) {
  if (entry.denominator === null || entry.denominator === undefined) return `${entry.numerator ?? '—'}`
  return `${entry.numerator ?? '—'}/${entry.denominator}`
}

/* The labels live with the vocabulary in `domain/asin/health.js` — the page reads the
   same table, so `no-source` cannot be spelled two ways. */
const STATE_LABELS = ASIN_HEALTH_STATE_LABELS

export function asinHealthTool({ store }) {
  return {
    name: 'amzn_asin_health',
    description:
      'Read the data health summary of ONE ASIN (F05-07): core-field completeness, 43-attribute coverage, freshness, '
      + 'multi-source conflicts, rule risk and whether the optimization pre-flight is satisfied — each with its '
      + 'numerator, denominator, criterion, source table and the specific things that are missing. '
      + 'Use it to answer "这块数据能不能用来下结论 / 该先补什么". '
      + 'Two of the six read module 13 (attribute coverage and the nine pre-flight gates) rather than computing them '
      + 'again. The result also carries `unsourced`: criteria this repository has NO SOURCE for — they are printed as '
      + `「${ASIN_HEALTH_NO_SOURCE_TEXT}」 and must never be read as zero. `
      + 'Read-only.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
      },
      required: ['asin'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const asin = String(args?.asin ?? '').trim().toUpperCase()
        const marketplace = String(args?.marketplace ?? 'US').trim().toUpperCase()

        const fields = buildFieldFacts(store, { asin, marketplace })
        if (fields === null) {
          return {
            ok: false,
            code: 'ASIN_NOT_FOUND',
            error: `${asin} (${marketplace}) 不在库内`,
            hint: '先用 amzn_asin_upsert 导入，或确认站点代码对不对 —— 同一个 ASIN 在不同站点是两条记录',
            tool: 'amzn_asin_health',
          }
        }

        /* The same entry the run button and `amzn_optimize_precheck` use. `full` is
           the strictest mode, which is the right reading of "is the pre-flight
           satisfied" — 审核 mode is never blocked, so it would answer "yes" to a
           listing nobody can optimize yet. */
        const precheck = precheckFor(store, { asin, marketplace, mode: 'full' })

        const summary = buildAsinHealthSummary(store, { asin, marketplace, fields, precheck })
        if (summary.ok !== true) return { ...summary, tool: 'amzn_asin_health' }

        const lines = [`${summary.asin} · ${summary.marketplace} 数据健康摘要`
          + `（${summary.verdict === 'ok' ? '六项都取到了判据' : summary.verdict === 'blocked' ? '优化前置有阻断项' : '有项取不到判据'}）`]

        lines.push('')
        lines.push(table(summary.items, [
          { label: '项', value: entry => entry.label },
          { label: '状态', value: entry => STATE_LABELS[entry.state] ?? entry.state },
          { label: '分子/分母', value: entry => ratio(entry) },
          { label: '结论', value: entry => truncate(entry.conclusion, 52) },
          { label: '来源', value: entry => truncate(entry.source, 40) },
        ]))

        for (const entry of summary.items) {
          const details = []
          if (entry.breakdown.length > 0) {
            details.push(`    分档: ${entry.breakdown.map(row => `${row.label}=${row.value}`).join('　')}`)
          }
          if (entry.missing.length > 0) {
            details.push(`    扣分项: ${entry.missing.slice(0, 12).map(item => String(item)).join('、')}`
              + `${entry.missing.length > 12 ? ` 等 ${entry.missing.length} 项` : ''}`)
          }
          details.push(`    口径: ${entry.basis}`)
          if (entry.note !== null) details.push(`    ⚠ ${entry.note}`)
          if (entry.caveat !== null) details.push(`    ⚠ ${entry.caveat}`)
          if (details.length > 0) {
            lines.push('')
            lines.push(`  ${entry.label}（${entry.state}）`)
            lines.push(...details)
          }
        }

        lines.push('')
        lines.push(`本仓没有来源的判据（${summary.unsourced.length}）—— 「${ASIN_HEALTH_NO_SOURCE_TEXT}」不是 0，也不是「没问题」:`)
        for (const entry of summary.unsourced) {
          lines.push(`  · ${entry.label}（${entry.feature}）: ${entry.conclusion}`)
          lines.push(`    ${entry.reason}`)
        }

        lines.push('')
        lines.push(`六项的顺序固定：${ASIN_HEALTH_ITEM_IDS.join(' / ')}。`
          + '每一项的分母都印在上面，结论里为 0 的项要连同它自己的注一起读。')
        return { ...summary, text: lines.join('\n') }
      } catch (error) {
        return { ok: false, error: error.message, code: error.code ?? null, tool: 'amzn_asin_health' }
      }
    },
  }
}
