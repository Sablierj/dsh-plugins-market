/**
 * `amzn_asin_history` — the ASIN snapshot history and the diff between two chosen
 * snapshots (module 05, F05-04).
 *
 * Read-only, and the same builder the page's `GET /api/asin-history` calls. Two
 * paths that each computed "what changed" would eventually disagree, and the
 * disagreement would look like two true sentences.
 *
 * The renderer's job is to make the four "there is no diff" states unmergeable:
 * never collected / one snapshot / collected but identical / changed. The first two
 * have no diff at all, and printing "no changes" for them is how "nobody collected
 * this" becomes "we checked and it is fine".
 */

import {
  ASIN_ATTRIBUTIONS, ASIN_ATTRIBUTION_LABELS, ASIN_CHANGE_KINDS, ASIN_CHANGE_KIND_LABELS, buildAsinHistory,
} from '../domain/asin/history.js'
import { table, text, truncate } from './render.js'

/** A cell as a readable string; `null` is a real value and prints as such. */
function cell(value) {
  if (value === null || value === undefined) return '（无）'
  if (typeof value === 'object') return truncate(JSON.stringify(value), 40)
  return truncate(String(value), 40)
}

export function asinHistoryTool({ store }) {
  return {
    name: 'amzn_asin_history',
    description:
      'Read one ASIN\'s collection-snapshot history and the field-level diff between any two of its snapshots '
      + '(F05-04). Pass from / to as a snapshot id or an ISO instant (an instant resolves to the newest snapshot at '
      + 'or before it); omit both to compare the newest two, which is what the detail view shows as "与上一版". '
      + 'Every changed field comes back with a change kind (文本 / 数值 / 图片A+ / 属性 / 变体 / 其他) and an attribution '
      + '(人工修正 / 优化发布 / 来源冲突 / Amazon 页面 / 未知) derived from the store, never self-reported. '
      + 'Read-only. "No snapshots" and "no changes" are different answers and come back as different fields.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        from: { type: 'string', description: 'Earlier snapshot: id or ISO instant. Omit for the one before the newest.' },
        to: { type: 'string', description: 'Later snapshot: id or ISO instant. Omit for the newest.' },
        limit: { type: 'number', description: 'History rows to list. Default 100, max 500.' },
      },
      required: ['asin'],
    },
    /* 2026-10-25（R-67）：原来是 `text(value)` —— 而 execute 返回的对象里**有一份完整的 `text`**
       （7 份快照的表格 + 字段差异 + 归因说明），于是用户看到的是 JSON。

       与 R-65（`asin.js:1616` 的 `amzn_asin_competitor`）同一个形状。
       **这一轮扫出 17 处「render 用 text(value) 而 execute 返回带 text 字段的对象」的可疑位置，
       但其中有些是误报（`amzn_asin_health` 我跑过、它显示的是文本）。**
       所以只改**已实锤**的这一处，其余 16 处留在账上逐个验。 */
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      try {
        const result = buildAsinHistory(store, {
          asin: args?.asin,
          marketplace: args?.marketplace ?? 'US',
          from: args?.from ?? null,
          to: args?.to ?? null,
          limit: args?.limit ?? 100,
        })
        if (result.ok !== true) return { ...result, tool: 'amzn_asin_history' }

        const lines = [`${result.asin} · ${result.marketplace} —— 采集快照 ${result.total} 份`
          + `${result.truncated ? `（下面列了最近 ${result.limit} 份）` : ''}`]

        if (result.snapshots.length === 0) {
          lines.push('')
          lines.push(result.notes[0])
          lines.push('先用 amzn_collect_run 采一次，或 amzn_asin_upsert 带 rawSnapshot: true 写一份带原始读数的快照。')
          return { ...result, text: lines.join('\n') }
        }

        lines.push('')
        lines.push(table(result.snapshots, [
          { label: '快照 id', value: row => row.id },
          { label: '采集时间', value: row => row.collectedAt },
          { label: '来源', value: row => row.sourceId },
          { label: '字段数', value: row => row.fieldCount },
          { label: '版本索引', value: row => (row.registryId === null ? '无指针' : `#${row.registryVersion}`) },
        ]))

        if (result.notes.length > 0) {
          lines.push('')
          for (const note of result.notes) lines.push(`⚠ ${note}`)
        }

        if (result.diff === null) {
          lines.push('')
          /* Not "no changes": there is nothing to compare. The builder's note
             already says which of the two reasons it is. */
          lines.push(`没有可比较的两个时间点：${result.notes[0] ?? '快照不足两份'}`)
          return { ...result, text: lines.join('\n') }
        }

        const { diff, pair } = result
        lines.push('')
        lines.push(`比较 ${pair.from.id}@${pair.from.collectedAt} → ${pair.to.id}@${pair.to.collectedAt}`
          + `（${pair.selection === 'explicit' ? '按你选的' : '默认：最新两份'}）`)
        lines.push(`来源变化: ${diff.sourceChange.label}`)
        lines.push(`  ⚠ ${diff.sourceChange.note}`)

        if (diff.empty) {
          lines.push('')
          lines.push(diff.note)
          return { ...result, text: lines.join('\n') }
        }

        lines.push('')
        lines.push(`字段差异 ${diff.changes.length} 处`
          + `（文本 ${diff.counts.text} / 数值 ${diff.counts.numeric} / 图片A+ ${diff.counts.image}`
          + ` / 属性 ${diff.counts.attribute} / 变体 ${diff.counts.variant} / 其他 ${diff.counts.other}）:`)
        lines.push(table(diff.changes, [
          { label: '字段', value: row => row.field },
          { label: '类别', value: row => row.kindLabel },
          { label: '前值', value: row => cell(row.before) },
          { label: '后值', value: row => cell(row.after) },
          { label: '归因', value: row => row.attributionLabel },
          { label: '证据', value: row => (row.evidence === null ? '—' : row.evidence) },
        ]))
        lines.push('')
        lines.push('每条归因都是从库里读出来的证据推的，不是自报：人工修正来自 asin_field_source 的 manual 来源行，'
          + '优化发布来自 publication_record，来源冲突来自 field_conflict，Amazon 页面来自「这份快照的采集来源' 
          + '在这个字段上有来源行」，都不是就是「未知」。')
        lines.push(`归因取值: ${ASIN_ATTRIBUTIONS.map(id => ASIN_ATTRIBUTION_LABELS[id]).join(' / ')}；`
          + `变化类别取值: ${ASIN_CHANGE_KINDS.map(id => ASIN_CHANGE_KIND_LABELS[id]).join(' / ')}。`)
        return { ...result, text: lines.join('\n') }
      } catch (error) {
        return { ok: false, error: error.message, tool: 'amzn_asin_history' }
      }
    },
  }
}
