/**
 * `amzn_asin_import` — header-mapped batch import of the ASIN library (module 05,
 * F05-05).
 *
 * ## Why the default is "do not write"
 *
 * `dryRun` defaults to **true**. The whole point of the eight-step shape is that the
 * preview comes before the write, and a tool whose default writes means an agent
 * that calls it once with a pasted file has already changed the library before
 * anybody looked. Writing has to be asked for.
 *
 * ## And a preview leaves no audit row
 *
 * The write target for this tool carries `skip: args => args.dryRun !== false`, so a
 * preview records nothing. An audit row saying "an import happened" for an import
 * that did not happen is worse than no row at all — the same mistake the archive
 * path's `preview` already avoids.
 *
 * ## The render is the quality report, not a summary of it
 *
 * Steps ⑤–⑧ are the value here, so the output prints the blocking problems, the
 * warnings, the per-line actions and the rollback file size. A renderer that said
 * "12 rows would be imported" would throw away everything this feature exists to
 * show.
 */

import { applyAsinImport, buildAsinImportPlan } from '../domain/asin/import.js'
import { text, truncate } from './render.js'

const ACTION_LABELS = {
  create: '新增',
  update: '更新',
  unchanged: '无变化',
  invalid: '不合法',
  duplicate: '重复行',
  superseded: '被后面一行顶掉',
}

const CELL_LABELS = { fill: '填', overwrite: '覆盖', same: '同值', absent: '不写' }

/** A cell as a short string; `null` means "empty", which is not "unchanged". */
function cell(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return truncate(JSON.stringify(value), 18)
  return truncate(String(value), 18)
}

export function asinImportTool({ store }) {
  return {
    name: 'amzn_asin_import',
    description:
      'Batch-import ASINs from pasted CSV/TSV text (F05-05). The first row must be a header and columns are matched '
      + 'BY HEADER NAME, never by position, so a reordered export still lands in the right fields. '
      + 'Defaults to dryRun: true, which returns the full plan — per-line action, per-cell before/after, conflicts, '
      + 'impact preview, quality report and a rollback CSV of every cell that would be overwritten — and writes nothing. '
      + 'Call it again with dryRun: false to write. An empty cell means "not stated" and is never written (upsertAsin '
      + 'coalesces; omitting a field is silence, not a deletion). '
      + 'A duplicate (ASIN, site) in the file is refused unless onDuplicate "last"; an invalid line is refused unless '
      + 'onInvalid "skip" — both fail closed because the two policies look identical in a preview. '
      + 'Overwriting a non-empty field needs confirm: true when this workspace has the 覆盖字段 gate on.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The CSV/TSV body, header row first. Comma, tab or semicolon delimited.' },
        marketplace: { type: 'string', description: 'Site used when the file has no 站点 / marketplace column. Default US.' },
        sourceId: { type: 'string', description: 'Source recorded on every written field. Omit and the result warns that provenance is missing.' },
        dryRun: { type: 'boolean', description: 'true (default) = plan only, nothing written. false = write.' },
        onInvalid: { type: 'string', enum: ['reject', 'skip'], description: 'reject (default) = refuse the whole file and name the bad lines; skip = write the valid ones.' },
        onDuplicate: { type: 'string', enum: ['reject', 'last'], description: 'reject (default) = refuse; last = the last line for each (ASIN, site) wins.' },
        confirm: { type: 'boolean', description: 'Set true to allow overwriting existing non-empty values when the 覆盖字段 gate is on.' },
      },
      required: ['text'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const dryRun = args?.dryRun !== false
        const plan = buildAsinImportPlan(store, {
          text: args?.text,
          marketplace: args?.marketplace ?? 'US',
          sourceId: args?.sourceId ?? null,
          onInvalid: args?.onInvalid ?? 'reject',
          onDuplicate: args?.onDuplicate ?? 'reject',
          confirm: args?.confirm === true,
        })

        if (plan.ok !== true) {
          const lines = [`导入未执行（${plan.code}）: ${plan.error ?? ''}`]
          if (plan.hint) lines.push(`提示: ${plan.hint}`)
          /* A refusal that carries the plan prints it: the operator needs to see
             which lines are wrong, not just that something is. */
          if (Array.isArray(plan.rows) && plan.rows.length > 0) {
            lines.push('')
            lines.push(...describePlan(plan, true))
          }
          return { ...plan, text: lines.join('\n'), tool: 'amzn_asin_import' }
        }

        const lines = []
        lines.push(`格式: ${plan.format.label}（${plan.format.reason}）`)
        lines.push(`映射: ${Object.entries(plan.mapping).map(([field, index]) => `${field}←第${index + 1}列`).join('　')}`)
        if (plan.unmapped.length > 0) {
          lines.push(`认不出/重复的列: ${plan.unmapped.map(entry => `${entry.header}（第 ${entry.index + 1} 列，${entry.reason}）`).join('、')}`)
        }
        lines.push('')
        lines.push(...describePlan(plan, false))

        if (dryRun) {
          lines.push('')
          lines.push('以上是预览，库一行都没动。确认无误就再调一次并带 dryRun: false。')
          return { ...plan, text: lines.join('\n'), tool: 'amzn_asin_import' }
        }

        const applied = applyAsinImport(store, plan, { confirm: args?.confirm === true })
        if (applied.ok !== true) return { ...applied, text: [lines.join('\n'), '', `写入失败: ${applied.error}`].join('\n'), tool: 'amzn_asin_import' }

        lines.push('')
        lines.push(`写入完成: 新增 ${applied.summary.created}，更新 ${applied.summary.updated}，`
          + `无变化 ${applied.summary.unchanged}，跳过 ${applied.summary.skipped}，失败 ${applied.summary.failed}`)
        if (applied.failed.length > 0) {
          lines.push(`失败的行:\n${applied.failed.map(entry => `- 第 ${entry.line} 行 ${entry.asin}: ${entry.reason}`).join('\n')}`)
        }
        lines.push(`读回对账: 每一行写完都重新读了一遍，${applied.readBackVerified === true ? '与计划一致' : '有不一致（见返回值的 mismatches）'}`)
        lines.push('')
        lines.push(`回滚: ${plan.rollback.rows} 行、${plan.rollback.fields.length} 个字段的前值在返回值的 rollback.csv 里。`
          + `${plan.rollback.note} 要撤回就把那份 CSV 当输入再导一次（onDuplicate: "last"、confirm: true）。`)
        return { ...applied, plan, text: lines.join('\n'), tool: 'amzn_asin_import' }
      } catch (error) {
        return { ok: false, error: error.message, tool: 'amzn_asin_import' }
      }
    },
  }
}

/** The preview table plus the quality report — steps ④, ⑤, ⑥ and ⑧. */
function describePlan(plan, refusal) {
  const lines = []
  const summary = plan.summary
  lines.push(`影响预览: ${summary.rows} 行 —— 新增 ${summary.create} / 更新 ${summary.update} / 无变化 ${summary.unchanged}`
    + ` / 不合法 ${summary.invalid} / 重复 ${summary.duplicate} / 被顶掉 ${summary.superseded}`
    + `；会填 ${summary.filledCells} 格、覆盖 ${summary.overwrittenCells} 格、落在多源冲突字段上 ${summary.conflictCells} 格`)
  if (summary.writeCount === 0) lines.push('这份文件不会写任何一行。')

  lines.push('')
  lines.push('逐行（前 40 行）:')
  for (const row of plan.rows.slice(0, 40)) {
    const cells = row.cells
      .filter(entry => entry.action !== 'absent')
      .map(entry => `${entry.field}=${cell(entry.before)}→${cell(entry.after)}[${CELL_LABELS[entry.action]}]`)
      .join('　')
    lines.push(`  第 ${row.line} 行 ${row.asin}@${row.marketplace} ${ACTION_LABELS[row.action] ?? row.action}`
      + `${row.invalidReason === null ? '' : `（${row.invalidReason}）`}`)
    if (cells !== '') lines.push(`    ${truncate(cells, 160)}`)
  }
  if (plan.rows.length > 40) lines.push(`  …… 其余 ${plan.rows.length - 40} 行在返回值的 rows 里`)

  const report = plan.qualityReport
  if (report.blocking.length > 0) {
    lines.push('')
    lines.push('质量报告 —— 阻断项:')
    for (const entry of report.blocking) lines.push(`  ✖ ${entry.code}: ${entry.message}`)
  }
  if (report.warnings.length > 0) {
    lines.push('')
    lines.push(`质量报告 —— 提示（${report.warnings.length}）:`)
    for (const entry of report.warnings) lines.push(`  ⚠ ${entry.code}: ${entry.message}`)
  }
  if (report.blocking.length === 0 && report.warnings.length === 0) {
    lines.push('')
    lines.push('质量报告: 没有阻断项，也没有提示。')
  }
  if (refusal) {
    lines.push('')
    lines.push('（上面这份预览就是被拒的那一批，库里一行都没动。）')
  }
  return lines
}
