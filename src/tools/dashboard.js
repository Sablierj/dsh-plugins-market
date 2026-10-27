/**
 * `amzn_dashboard` — the home page's numbers, for the agent.
 *
 * The same six cards the page draws, from the same `buildHealthCards`, so the
 * model and the user cannot be looking at two different dashboards. A second
 * implementation for the agent would drift exactly like the prompt renderer
 * would have, and the drift would be invisible: both would look like numbers.
 *
 * Read-only, and it says which cards are empty rather than dropping them. A tool
 * that returned five cards because the sixth had no data would make "we have
 * never collected" look like "everything is fine".
 */

import { buildHealthCards, CARD_IDS, EMPTY_CONCLUSION } from '../domain/dashboard/health.js'
import { normalizeScope, SCOPE_ALL } from '../domain/context/scope.js'
import { table, text } from './render.js'

export function dashboardTool({ store }) {
  return {
    name: 'amzn_dashboard',
    description:
      'Read the Amazon workbench dashboard: six health cards, each with a conclusion, a numerator/denominator and when '
      + 'it was last updated. Call this when the user asks "今天怎么样 / 有什么问题 / 数据新不新 / 该先做什么" — it is the '
      + 'same set of numbers the home page shows, so the answer and the screen agree. '
      + 'Pass a marketplace to narrow the cards to one site; without it they cover every site in the store. '
      + 'A card that could not be computed comes back with status "error" and says why; a card with nothing to measure '
      + 'says 「暂无数据」 rather than reporting 0, because a rate over no rows is not 0%.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Site code, e.g. US / DE / JP. Omit for every site.' },
        workspaceId: { type: 'string', description: 'Workspace id. Defaults to ws-default.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value.text ?? value) },
    async execute(args) {
      const scope = normalizeScope({
        workspaceId: args?.workspaceId,
        marketplace: args?.marketplace,
        shopId: SCOPE_ALL,
        brandId: SCOPE_ALL,
        productLineId: SCOPE_ALL,
      })
      const cards = buildHealthCards(store, scope, {})

      const lines = [`仪表盘（站点 ${scope.marketplace === SCOPE_ALL ? '全部' : scope.marketplace}）:`]
      lines.push(table(cards, [
        { label: '卡', value: row => row.label },
        { label: '状态', value: row => (row.status === 'error' ? '计算失败' : row.status === 'empty' ? '暂无数据' : row.status === 'attention' ? '注意' : '正常') },
        { label: '结论', value: row => (row.status === 'error' ? String(row.error ?? '') : row.conclusion) },
        { label: '分子/分母', value: row => (row.denominator === null ? '' : `${row.numerator}/${row.denominator}`) },
        { label: '阈值', value: row => row.threshold ?? '' },
        { label: '更新于', value: row => (row.updatedAt === null ? '未记录' : row.updatedAt) },
      ]))

      const empty = cards.filter(row => row.status === 'empty')
      const broken = cards.filter(row => row.status === 'error')
      if (empty.length > 0) {
        lines.push('')
        lines.push(`暂无数据的卡（${empty.length}）：${empty.map(row => row.label).join('、')} —— `
          + `「${EMPTY_CONCLUSION}」是「还没测过」，不是「测出来是 0」。`)
      }
      if (broken.length > 0) {
        lines.push('')
        lines.push(`计算失败的卡（${broken.length}）：${broken.map(row => `${row.label}(${row.error})`).join('、')}`
          + ' —— 其余卡不受影响，可以先看那些。')
      }
      lines.push('')
      lines.push(`六卡顺序固定：${CARD_IDS.join(' / ')}。每张卡的分母都随作用域收窄，所以换站点会换分母。`)

      return { text: lines.join('\n'), cards, scope }
    },
  }
}
