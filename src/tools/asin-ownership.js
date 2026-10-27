/**
 * `amzn_asin_ownership_set` — 改一条 ASIN 的归属（自有/竞品、产品线）。
 *
 * ## 为什么必须有这个工具（而不是「页面能改就行」）
 *
 * 1. **页面能做的事，工具就该能做** —— 否则 agent 永远改不了归属，而「归属」正是它
 *    最该能提议的东西（它已经有 `amzn_keyword_ownership_suggest`）。
 * 2. **审计必须同源**：`correctAsinField` 只收 `asin` 表的列，而归属住在
 *    `asin_ownership` 决策表。两个写入点、两套审计，等于没有审计。
 * 3. 这条与 F-7（关键动作不许只靠对话）是同一件事的两面：页面与工具走**同一个 store 函数**
 *    （`setAsinOwnership`），落**同一个** `ACTIONS.asinOwnershipSet`。
 *
 * ## 它不写 `asin.product_line_id`
 *
 * 那一列是 `asin_ownership` 的**缓存**，由 `syncProductLineCache` 从边刷出来。
 * 直接写它会被下一次归属写入刷掉，且不留痕 —— 见 `team/dev/derived-columns-2026-10-25.md`。
 */

import { refusalForAsinOwnership, setAsinOwnership } from '../store/ownership.js'
import { INLINE_OWNERSHIP_TYPES } from '../store/ownership.js'
import { text } from './render.js'

export function asinOwnershipSetTool({ store }) {
  return {
    name: 'amzn_asin_ownership_set',
    description:
      'Set one ASIN\'s ownership edge (FR-M2-05): 自有/竞品归属 (`objectType: "side"`, objectId `self` | `competitor`) '
      + 'or 产品线归属 (`objectType: "product_line"`, objectId = a product line id). '
      + 'Writing a new value retracts the previous live edge of the same type — rows are kept, never deleted, so '
      + '"what did it used to be" stays readable. '
      + 'To remove the judgement entirely pass `revoke: true` **explicitly**: a missing objectId and a deliberate '
      + 'revoke are different facts and must not look alike. '
      + 'It does NOT write `asin.product_line_id`: that column is a cache of these edges and is refreshed from them, '
      + 'so writing it directly would be overwritten by the next ownership write without leaving a trace. '
      + 'The page route `asin-ownership-set` calls the same store function and records the same audit action.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        objectType: { type: 'string', enum: INLINE_OWNERSHIP_TYPES, description: 'side | product_line' },
        objectId: { type: 'string', description: 'self / competitor for side; the product line id for product_line. Omit when revoking.' },
        revoke: { type: 'boolean', description: 'Remove the judgement explicitly (retract every live edge of this type).' },
        source: { type: 'string', enum: ['manual', 'auto'], description: 'Who decided. Default manual.' },
        reason: { type: 'string', description: 'Why — recorded in the audit row.' },
        by: { type: 'string', description: 'Who ran it. Recorded in the audit row.' },
      },
      required: ['asin', 'objectType'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args = {}) {
      const refusal = refusalForAsinOwnership(args)
      if (refusal !== null) return { ok: false, ...refusal }
      const result = setAsinOwnership(store, args)
      if (result.ok !== true) return result
      return {
        ...result,
        /* 一句话说清这次到底改了什么 —— 调用方不必自己拼。 */
        summary: result.revoked
          ? `已撤销 ${result.objectType} 归属（撤了 ${result.retracted} 条 live 边，行都留着）`
          : `${result.objectType} 归属已写为 ${result.objectId}`
            + (result.retracted > 0 ? `（旧的 ${result.retracted} 条已标撤销）` : ''),
      }
    },
  }
}
