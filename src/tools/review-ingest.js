/**
 * 评论回填的工具层 —— 把 `src/domain/asin/review-ingest.js` 那条线接到一个**能触发的入口**上。
 *
 * ## 为什么需要这个工具（R-27 断点二，2026-10-25）
 *
 * `upsertReviewRow` 此前**全仓只有测试在调用**，生产代码一处都没有 ——
 * 所以即使采集结果里躺着评论正文，`reviews` 表照样空。
 * 补了 `review-ingest.js` 之后，它被 `tests/wired-source.mjs` 判成**待接线**
 * （那个名单会自我清理，它不允许「已经接好的」赖在里面，也不允许「接好了却没人用」赖着）。
 *
 * 这个工具就是那个「谁来触发」的答案：**显式调用，而不是塞进读路径做副作用**。
 *
 * ## 为什么不接在 `amzn_asin_detail` 上
 *
 * 那是一个**读**工具。读的时候顺手写库，会让「看一次详情」产生无法解释的写入 ——
 * 而今天整批修的正是「读的东西和它说的不一致」。**读就是读。**
 *
 * ## 为什么不是「采集完成自动回填」
 *
 * 采集管线（`src/sources/collection.js`）是调度器，落库由它管；
 * 在里面加一个写评论的分支，等于把「评论正文从哪来」这件事**藏在采集器的实现细节里**。
 * 而这个工具把它变成一个**可以被调用、被记录、被追问**的动作。
 *
 * ## 它现在是「跑得出 0 行」的状态，而且如实说为什么
 *
 * 实测：库里 10 个 reviews 分节，`parsed_value_json.review_items` **全是空数组**
 * （外部采集器只给 `reviews_total`：2545 / 1032 / 41 …）。
 * 所以调用它会得到 `written: 0`，并逐条列出**每个分节空在哪** ——
 * 这是「线上确实还没有正文」，不是「这个工具没工作」。
 */

import { ingestAllCollectedReviews, ingestReviewsFromSection } from '../domain/asin/review-ingest.js'

const render = (result) => {
  const lines = []
  if (result.sections !== undefined) {
    lines.push(`评论回填：扫过 ${result.sections} 个 reviews 分节，写入 ${result.written} 条，跳过 ${result.skipped} 条。`)
    if (result.written === 0) {
      lines.push('')
      if (result.empty.length === 0) {
        lines.push('写入 0 条，但**没有给出任何原因** —— 这不该发生，请查 review-ingest.js。')
      } else {
        lines.push('**一条都没写进去，原因逐条在下面**：')
        for (const line of result.empty.slice(0, 20)) lines.push(`  · ${line}`)
        if (result.empty.length > 20) lines.push(`  …还有 ${result.empty.length - 20} 条`)
        lines.push('')
        lines.push('⚠️ 本仓**不采集评论正文**：`src/sources/collection.js` 是调度器不是解析器，')
        lines.push('   `parsed_value_json` 里那些字段由外部采集器产出。它目前只给总数，不给正文。')
        lines.push('   所以「写入 0 条」是**线上确实还没有评论正文**，不是这个工具没工作。')
        lines.push('   一旦外部采集器开始产出 `review_items`，再调一次这个工具就会落库 —— **不需要改代码**。')
      }
    } else {
      lines.push('')
      lines.push('已写进 `reviews` 表。父/子 ASIN 双绑定、去重都走 `upsertReviewRow` 自己的约束。')
    }
    return lines.join('\n')
  }

  /* 单节模式 */
  if (result.reason !== null) return `这一节没有可回填的评论：${result.reason}`
  return `写入 ${result.written} 条，跳过 ${result.skipped} 条。`
}

export function reviewIngestTool({ store }) {
  return {
    name: 'amzn_review_ingest',
    description: '把已经采到的评论正文回填进 reviews 表（R-27 断点二的入口）。'
      + ' 不传 asin 时扫全库所有 reviews 分节；传了只回填那一节。'
      + ' 幂等：同一份采集结果跑两遍不会重复插行（靠 dedupe_key 唯一约束）。'
      + ' 注意：本仓不采集评论正文，正文由外部采集器产出；它目前只给 reviews_total，'
      + ' 所以调用它会如实返回「写入 0 条」并逐条说明每个分节空在哪。',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: '只回填这个 ASIN 的 reviews 分节。省略则扫全库。' },
        marketplace: { type: 'string', description: '配合 asin 使用，默认 US。' },
        limit: { type: 'number', description: '全量模式下最多扫多少个分节，默认 500。' },
      },
    },
    /* 工具的渲染契约：必须是 `output.render`，不是扁平的 `render`。
       **这是同一个坑第二次踩** —— 今天上午写 amzn_shop_upsert 时第一次就是扁平 render，
       被同一条断言拦住（`has no output.render`）。两次之间隔了 20 多轮，还是没记住。
       这次把它写在这里：本仓的工具渲染住 `output.render`。 */
    output: {
      schema: {},
      render: (result) => String(result?.text ?? ''),
    },
    async execute(args = {}) {
      const asin = String(args.asin ?? '').trim().toUpperCase()
      if (asin !== '') {
        const market = String(args.marketplace ?? 'US').trim().toUpperCase()
        const row = store.get(
          `SELECT task_id, asin, marketplace, status, parsed_value_json, snapshot_ref, collected_at
             FROM collection_section_result
            WHERE section = 'reviews' AND asin = ? AND marketplace = ?
            ORDER BY collected_at DESC LIMIT 1`,
          [asin, market],
        )
        if (row === undefined) {
          return {
            ok: true,
            text: `库里没有 ${asin}@${market} 的 reviews 分节结果 —— 这个 ASIN 还没采集过评论分节。`,
          }
        }
        const result = ingestReviewsFromSection(store, row)
        return { ok: true, ...result, text: render(result) }
      }

      const result = ingestAllCollectedReviews(store, { limit: args.limit ?? 500 })
      return { ok: true, ...result, text: render(result) }
    },
  }
}
