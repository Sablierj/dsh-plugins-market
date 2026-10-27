/**
 * reviews 入库主流程（S2-T69，LLD §1.2.2 伪代码的实现）。
 *
 * 三条硬语义：
 *   1. **dedupe_key 唯一实现点**（DB v1.1 §4.2）：有 review_id 用 'id:'+id；无则
 *      'h:'+sha256(author␀date␀title␀body) 前 32 hex —— 四元组缺项用 '' 参与哈希
 *      （不是跳过），缺项样本仍可稳定复现同一 key；
 *   2. **reviews 永不复制 / bindings 补绑定**（铁律 2，R1/R2/R3）：撞主键只刷
 *      updated_at，内容字段不回写（首次观测为准）；跨子体只追加绑定行；
 *   3. **collect_state 内容级判定**（铁律 3）：seen<total → partial（含 0/N、含登录墙
 *      截断 —— 登录墙不记 blocked）；seen===total（含 0/0）→ collected。failed/blocked
 *      是节级判定（页面解析失败 / 风控真被拦），不由本函数产生。
 *
 * 事务：全量单事务（store.tx），任一行失败整体回滚 —— 禁止「采到一半入库」。
 * 落库对账（reviewRowsAdded / bindingRowsAdded / bindingRowsRebound / duplicatesHit）
 * 逐数返回，调用方落任务事件，可复验。
 */
import { createHash } from 'node:crypto'

import { upsertReviewRow, upsertReviewBinding } from '../../store/review.js'
import { reviewsVisibleVerdict } from './sections.js'

/** 样本上限（O-05 待定）：页面样本存 50 条，超限截断并如实报 samplesTruncated。 */
export const REVIEW_SAMPLE_LIMIT = 50

/** dedupe_key 的唯一实现点（DB v1.1 §4.2）。四元组缺项用 '' 参与哈希，不跳过。 */
export function reviewDedupeKey(item) {
  const row = item !== null && typeof item === 'object' ? item : {}
  const id = String(row.review_id ?? '').trim()
  if (id !== '') return 'id:' + id
  const parts = [row.author, row.date, row.title, row.body]
    .map(value => String(value ?? ''))
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex')
  return 'h:' + digest.slice(0, 32)
}

export function ingestReviews(store, {
  taskId, parentAsin, childAsin, marketplace, parsed, observedAt, sourceSnapshotId = null,
} = {}) {
  /* 前置校验 fail-closed（I-T69-1）：缺绑定/站点/任务 → BAD_REQUEST。 */
  const missing = []
  if (String(taskId ?? '').trim() === '') missing.push('taskId')
  if (String(parentAsin ?? '').trim() === '') missing.push('parentAsin')
  if (String(childAsin ?? '').trim() === '') missing.push('childAsin')
  if (String(marketplace ?? '').trim() === '') missing.push('marketplace')
  if (missing.length > 0) {
    const error = new Error('缺 ' + missing.join(' / ') + '（铁律 2 双绑定必填）')
    error.code = 'BAD_REQUEST'
    throw error
  }
  const reading = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const rawItems = Array.isArray(reading.review_items) ? reading.review_items : []
  const truncated = rawItems.length > REVIEW_SAMPLE_LIMIT
  const items = rawItems.slice(0, REVIEW_SAMPLE_LIMIT)

  /* n/N（R6）：seen 用 reviews_visible（页面识别出的块数），不是样本数 ——
     样本有 50 上限，拿它当 seen 会把「样本截断」误判成「可见受限」。 */
  const verdict = reviewsVisibleVerdict(reading)
  const seen = verdict.seen ?? items.length
  const total = verdict.total
  const nOverN = total === null
    ? null
    : '采到 ' + String(seen) + ' 条/页面显示 ' + String(total) + ' 条'
  const collectState = verdict.decided ? verdict.state : 'collected'
  /* 判定注：两数没测到时（decided:false）按「解析成功、有多少记多少」记 collected ——
     0/0 与「页面明示无评论」同形；真正的 failed/blocked 由节级判定产生，不进这里。 */

  const result = store.tx(() => {
    let reviewRowsAdded = 0
    let bindingRowsAdded = 0
    let bindingRowsRebound = 0
    let duplicatesHit = 0
    for (const entry of items) {
      const key = reviewDedupeKey(entry)
      const written = upsertReviewRow(store, {
        dedupeKey: key,
        reviewId: entry.review_id ?? null,
        parentAsin,
        childAsin,
        marketplace,
        author: entry.author ?? null,
        reviewDate: entry.date ?? null,
        rating: entry.rating ?? null,
        title: entry.title ?? null,
        body: entry.body ?? null,
        verified: entry.verified ?? null,
        variantNote: entry.variant_note ?? null,
        sourceTaskId: taskId,
        sourceSnapshotId,
        observedAt,
        nOverN,
        collectState,
      })
      if (written.inserted) reviewRowsAdded += 1
      else duplicatesHit += 1
      const bound = upsertReviewBinding(store, {
        dedupeKey: key,
        parentAsin,
        marketplace,
        childAsin,
        variantNote: entry.variant_note ?? null,
        boundAt: observedAt,
        boundByTask: taskId,
      })
      if (bound.inserted) bindingRowsAdded += 1
      else bindingRowsRebound += 1
    }
    return { reviewRowsAdded, bindingRowsAdded, bindingRowsRebound, duplicatesHit }
  })

  return {
    ok: true,
    collectState,
    nOverN,
    samplesSeen: items.length,
    samplesTruncated: truncated,
    ...result,
  }
}
