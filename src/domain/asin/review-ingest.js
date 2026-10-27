#!/usr/bin/env node
/**
 * 把「已经采到的评论正文」接进 `reviews` 表 —— 补上 R-27 的断点二。
 *
 * ## 为什么需要这个文件
 *
 * 2026-10-25 查清：`src/store/review.js` 的 `upsertReviewRow` ——
 * **全仓只有测试在调用它**（`tests/t70-review-analysis-store.mjs`），生产代码一处都没有。
 *
 * 所以即使 `collection_section_result.parsed_value_json.review_items` 里真的躺着一批评论，
 * `reviews` 表**照样是空的** —— 没有那条线。
 *
 * ## 它的边界（必须先说清，否则会被误读成「评论采集好了」）
 *
 * **本仓不采集评论。** `src/sources/collection.js` 是调度器，不是解析器；
 * `parsed_value_json` 里那些字段（`reviews_total` / `review_items`）由**外部采集器**产出，
 * 本仓只负责读。实测当前库里 `review_items` 是 `[]` —— 外部采集器只给了总数。
 *
 * 所以这个文件做的是**接线**，不是采集：
 *   输入：已经落在 `collection_section_result` 里的 `review_items`
 *   输出：`reviews` 表一行一条
 *
 * **它现在跑出来是 0 行**，因为库里的 `review_items` 全是空的。
 * 这不是失败，是「线上确实还没有评论正文」。
 * 一旦外部采集器开始产出正文，这个函数就会跟上——**不需要再改代码**。
 *
 * ## 双绑定（需求原文：评论要跟父 ASIN 和 ASIN 绑定且去重）
 *
 * `upsertReviewRow` 自己就强制 `parentAsin` / `childAsin` / `dedupeKey` 三个必填，
 * 并在 `(dedupe_key, parent_asin, marketplace)` 上做 upsert —— 去重靠的是这条唯一约束。
 * 这个文件不另造一套去重规则，**照它的签名传**。
 */

import { upsertReviewRow } from '../../store/review.js'

/** 采集结果里一条评论的字段可能叫这些名字（外部采集器不是本仓写的，别名留宽一点）。 */
const pick = (item, keys) => {
  for (const key of keys) {
    const value = item?.[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return null
}

/**
 * 从一条 `collection_section_result.reviews` 行，回填该 ASIN 的评论到 `reviews` 表。
 *
 * @param store  打开的库
 * @param row    `collection_section_result` 的一行（需含 asin / marketplace / task_id / snapshot_ref / collected_at / parsed_value_json）
 * @returns {{ written: number, skipped: number, reason: string|null }}
 */
export function ingestReviewsFromSection(store, row) {
  const parsed = row?.parsed_value_json
  if (typeof parsed !== 'string' || parsed.trim() === '') {
    return { written: 0, skipped: 0, reason: '这一行没有 parsed_value_json —— 采集结果没落下来' }
  }
  let payload
  try {
    payload = JSON.parse(parsed)
  } catch {
    return { written: 0, skipped: 0, reason: 'parsed_value_json 不是合法 JSON' }
  }

  const items = Array.isArray(payload?.review_items) ? payload.review_items : []
  if (items.length === 0) {
    return {
      written: 0,
      skipped: 0,
      /* 这是当前库的真实状态：外部采集器只给 reviews_total，不给正文。 */
      reason: `这一节没有 review_items（reviews_total=${payload?.reviews_total ?? '—'}）`
        + ' —— 本仓不采集评论，正文由外部采集器产出',
    }
  }

  const parentAsin = String(row.asin ?? '').trim().toUpperCase()
  const marketplace = String(row.marketplace ?? '').trim().toUpperCase()
  if (parentAsin === '' || marketplace === '') {
    return { written: 0, skipped: items.length, reason: '这一行没有 asin / marketplace' }
  }

  let written = 0
  let skipped = 0
  for (const item of items) {
    /* 去重键：优先采集器给的 review id；没有就用「作者 + 日期 + 标题前 40 字」兜底。
       兜底不是完美去重，但**比写一个空键进库好** —— 空键会让唯一约束失去意义。 */
    const reviewId = pick(item, ['review_id', 'reviewId', 'id'])
    const author = pick(item, ['author', 'reviewer', 'name'])
    const reviewDate = pick(item, ['review_date', 'reviewDate', 'date'])
    const title = pick(item, ['title', 'headline'])
    const body = pick(item, ['body', 'text', 'content'])
    const dedupeKey = reviewId !== null
      ? `rid:${String(reviewId).trim()}`
      : `txt:${[author ?? '', reviewDate ?? '', String(title ?? '').slice(0, 40)].join('|')}`

    if (body === null && title === null) {
      /* 一条既没有标题也没有正文的「评论」不是评论 —— 不写空行。 */
      skipped += 1
      continue
    }

    try {
      upsertReviewRow(store, {
        dedupeKey,
        reviewId: reviewId === null ? null : String(reviewId),
        parentAsin,
        /* 双绑定：采集结果若标了子 ASIN 就用它；否则这条评论挂在这个 ASIN 自己身上。
           不编一个子 ASIN —— 编出来的绑定比没有绑定更坏。 */
        childAsin: String(pick(item, ['child_asin', 'childAsin']) ?? parentAsin).trim().toUpperCase(),
        marketplace,
        author,
        reviewDate,
        rating: pick(item, ['rating', 'stars', 'score']),
        title,
        body,
        verified: pick(item, ['verified', 'verified_purchase']),
        variantNote: pick(item, ['variant_note', 'variant', 'variantNote']),
        sourceTaskId: row.task_id,
        sourceSnapshotId: row.snapshot_ref ?? null,
        observedAt: row.collected_at ?? undefined,
        nOverN: pick(item, ['n_over_n', 'nOverN']),
        collectState: row.status === 'collected' ? 'collected' : 'partial',
      })
      written += 1
    } catch (error) {
      /* 单条失败不打断整批：一条脏数据不该让剩下 40 条都进不去。 */
      skipped += 1
    }
  }

  return { written, skipped, reason: null }
}

/**
 * 扫一遍库里所有 reviews 分节结果，把能回填的都回填。
 *
 * 幂等：同一份采集结果跑两遍，第二遍是 upsert（靠 `dedupe_key + parent_asin + marketplace` 的唯一约束），
 * **不会重复插行**。
 */
export function ingestAllCollectedReviews(store, { limit = 500 } = {}) {
  const rows = store.all(
    `SELECT task_id, asin, marketplace, status, parsed_value_json, snapshot_ref, collected_at
       FROM collection_section_result
      WHERE section = 'reviews'
      ORDER BY collected_at DESC
      LIMIT ?`,
    [limit],
  )
  let written = 0
  let skipped = 0
  const empty = []
  for (const row of rows) {
    const result = ingestReviewsFromSection(store, row)
    written += result.written
    skipped += result.skipped
    if (result.reason !== null) empty.push(`${row.asin}@${row.marketplace}: ${result.reason}`)
  }
  return { sections: rows.length, written, skipped, empty }
}
