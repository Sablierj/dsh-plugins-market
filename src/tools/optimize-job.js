/**
 * 优化作业单工具 —— 只读：告诉人「这一轮走到哪一步、下一步该调哪个工具」。
 *
 * 阶段**不存**在库里（见 `domain/optimize/job.js` 顶部）：每次从行重算。
 * 所以删掉一个草案，阶段会自动退回去，不需要谁去同步。
 *
 * 单独一个文件而不是塞进 `tools/optimize.js`：那个文件已经 2800 行，
 * 而这一条与它没有共享的内部函数 —— 放一起只会在下次改它时多一层噪音。
 */

import { JOB_STEPS, jobStage } from '../domain/optimize/job.js'
import { text } from './render.js'

export function optimizeJobTool({ store }) {
  return {
    name: 'amzn_optimize_job',
    description:
      'Where does this optimization round stand, and what is the next legal step. '
      + 'Read-only, and the stage is DERIVED from rows on every call — nothing stores it: '
      + 'delete a draft and the stage moves back by itself. '
      + 'Give runId, or asin + marketplace to use the newest round. '
      + 'Blockers are counted from optimization_draft.violations_json, not from whether anyone '
      + 'called validate — calling validate is not the same as passing it.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The optimization run id.' },
        asin: { type: 'string', description: 'Use the newest round for this ASIN.' },
        marketplace: { type: 'string', description: 'Site code. Default US.' },
      },
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args = {}) {
      let runId = String(args.runId ?? '').trim()

      if (runId === '') {
        const asin = String(args.asin ?? '').trim().toUpperCase()
        const marketplace = String(args.marketplace ?? 'US').trim().toUpperCase()
        if (asin === '') return '给 runId，或给 asin + marketplace（用最新一轮）。'
        const row = store.get(
          'SELECT id FROM optimization_run WHERE asin = ? AND marketplace = ? ORDER BY started_at DESC LIMIT 1',
          [asin, marketplace],
        )
        if (row === undefined || row === null) {
          return `${asin}@${marketplace} 还没有任何优化轮次。下一步：amzn_optimize_prepare`
            + '（它会先跑九道前置检查，有阻断就不建轮次）。'
        }
        runId = row.id
      }

      const result = jobStage(store, { runId })
      const run = store.get('SELECT asin, marketplace, status, draft_version FROM optimization_run WHERE id = ?', [runId])
      const head = run === undefined || run === null
        ? `优化作业单 · run ${runId}`
        : `优化作业单 · ${run.asin}@${run.marketplace} · run ${String(runId).slice(0, 8)} · status=${run.status}`

      const lines = [head, '']
      const step = JOB_STEPS[result.stageIndex] ?? null
      lines.push(`当前阶段: ${result.stageIndex + 1}/9 ${step === null ? result.stage : step.label}`)
      lines.push('')
      lines.push('判据（这一阶段的结论是从这些行算出来的）:')
      for (const fact of result.facts) lines.push(`  · ${fact}`)

      if (result.blockers.length > 0) {
        lines.push('', '阻断:')
        for (const blocker of result.blockers.slice(0, 10)) lines.push(`  · ${blocker}`)
      }

      lines.push('')
      const next = result.next ?? {}
      if (next.tool === null || next.tool === undefined) {
        lines.push(`下一步: ${next.why ?? '没有可自动推进的下一步'}`)
      } else {
        const pairs = Object.entries(next.args ?? {})
        const argText = pairs.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')
        lines.push(`下一步: ${next.tool}${argText === '' ? '' : `(${argText})`}`)
        if (next.why !== undefined) lines.push(`        ${next.why}`)
      }

      lines.push('', '九步:')
      JOB_STEPS.forEach((entry, index) => {
        const mark = index < result.stageIndex ? '✅' : (index === result.stageIndex ? '▶' : '·')
        lines.push(`  ${mark} ${index + 1}. ${entry.label}`)
      })
      return lines.join('\n')
    },
  }
}
