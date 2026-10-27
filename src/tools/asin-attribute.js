/**
 * `amzn_asin_attribute_status` / `amzn_asin_attribute_set` —— 属性补齐的工具面（R-95）。
 *
 * 判定与写库都在 `src/domain/asin/attributes.js`：页面路由 `asin-attributes` /
 * `asin-attribute-save` 调的是**同一对函数**（本仓规矩：页面不内联重算，两条入口同一次动作）。
 * 这个文件只负责两件事：把结果渲染成人读的文本、把错误码原样交出去。
 */

import { ATTRIBUTE_FIELD_PREFIX, attributeField, labelForAttribute } from '../domain/rules/attributes.js'
import { attributeStatus, saveAttributes } from '../domain/asin/attributes.js'
import { table, text } from './render.js'

export function asinAttributeStatusTool({ store }) {
  return {
    name: 'amzn_asin_attribute_status',
    description:
      'Read the 43 required Amazon attributes for one ASIN and say exactly what is still missing: filled / empty / '
      + 'placeholder counted separately, with the human label of each missing attribute and the storage key it belongs '
      + 'at. Read-only. Use it before filling attributes by hand, and before an optimization round whose 43-attribute '
      + 'gate degrades.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
      },
      required: ['asin'],
    },
    output: {
      schema: {},
      render: (_args, result) => text(result?.text ?? JSON.stringify(result, null, 2)),
    },
    async execute(args = {}) {
      const result = attributeStatus(store, { asin: args.asin, marketplace: args.marketplace })
      if (result.ok === false) return result

      const { coverage, missing, asin, marketplace } = result
      const lines = []
      lines.push(`${asin}@${marketplace}：必填属性 ${coverage.filledCount} / ${coverage.target}`
        + `（空 ${coverage.empty.length} · 占位 ${coverage.placeholder.length}）`)
      lines.push(coverage.complete
        ? '43 项都已有非占位值 —— 「43 属性足够」这道门不会再降级。'
        : `还差 ${coverage.missingCount} 项。占位值等同于空：它看起来填了，其实是一个断开的节点。`)

      if (missing.length > 0) {
        lines.push('')
        lines.push(table(missing, [
          { label: '#', value: (row) => String(missing.indexOf(row) + 1) },
          { label: '属性 id', value: (row) => row.id },
          { label: '名称', value: (row) => (row.label === null || row.label === undefined ? '（登记表里没有这个名字）' : row.label) },
          { label: '状态', value: (row) => row.kind },
          { label: '写到哪', value: (row) => `${ATTRIBUTE_FIELD_PREFIX}${row.id}` },
        ]))
        lines.push('')
        lines.push('补：amzn_asin_attribute_set { asin, values: { "<属性 id>": "<值>" } }')
        lines.push('这些是**事实**，只能人来填或后台导出 —— 采集只覆盖页面规格表里列出的那几项，文案里猜不得。')
      }
      return { ...result, text: lines.join('\n') }
    },
  }
}

export function asinAttributeSetTool({ store }) {
  return {
    name: 'amzn_asin_attribute_set',
    description:
      'Fill Amazon attributes for one ASIN by hand (module 05). Merges into listing.attributes_json — keys you do not '
      + 'pass are left untouched, so this only ever adds or corrects. Refuses unknown attribute ids, empty values and '
      + 'placeholder values (N/A / 待定 / 无 …), because a placeholder counts as unfilled in every count and would only '
      + 'make the gap look closed. Each written value records a manual source row with a timestamp.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        values: {
          type: 'object',
          description: 'Attribute id → value, e.g. { "material": "polyester", "country_of_origin": "China" }. '
            + 'Ids come from amzn_asin_attribute_status (registry ids, not storage keys).',
        },
        note: { type: 'string', description: 'Why — recorded on the source rows.' },
        by: { type: 'string', description: 'Who filled them. Default manual.' },
      },
      required: ['asin', 'values'],
    },
    output: {
      schema: {},
      render: (_args, result) => text(result?.text ?? JSON.stringify(result, null, 2)),
    },
    async execute(args = {}) {
      const result = saveAttributes(store, {
        asin: args.asin,
        marketplace: args.marketplace,
        values: args.values,
        note: args.note,
        by: args.by,
      })
      if (result.ok === false) return result

      const { coverage, written, asin, marketplace, by, note } = result
      const lines = []
      lines.push(`${asin}@${marketplace}：写入 ${written.length} 项属性（${by}${note === null ? '' : ` · ${note}`}）`)
      lines.push(`必填属性现在 ${coverage.filledCount} / ${coverage.target}`
        + (coverage.complete ? ' —— 43 项齐了，「43 属性足够」这道门不再降级' : ` —— 还差 ${coverage.missingCount} 项`))
      if (coverage.missingCount > 0) {
        const rest = [...coverage.empty, ...coverage.placeholder]
        const labels = rest.slice(0, 12).map(id => `${id}（${labelForAttribute(id) ?? id}）`)
        lines.push(`还缺：${labels.join('、')}${rest.length > 12 ? ` …（共 ${rest.length} 项）` : ''}`)
      }
      return { ...result, text: lines.join('\n') }
    },
  }
}

/** 存储键：路由与报告共用同一份映射，别各自拼字符串。 */
export { attributeField }
