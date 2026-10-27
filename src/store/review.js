/**
 * `reviews` / `review_bindings` 的存取层（S2-T69，DB v1.1 §4 方案 A / LLD §1.3）。
 *
 * 铁律 2 的两条腿都在这里：
 *   · **reviews 主行永不复制** —— PK(dedupe_key, parent_asin, marketplace) 原子保证
 *     「家族内一行一评」；重采撞主键只刷新 updated_at，内容字段**不回写**（首次观测
 *     为准——「后来采到的变了」是快照层的事）；
 *   · **补绑定走 review_bindings**（3NF 方案 A）：同一条评论在别的子体下再采到是
 *     追加一行绑定，不新增 review 行。
 *
 * 盲区 #7（FR-M4-19）：机器写不覆盖人工修正值 —— ON CONFLICT 只写 updated_at，
 * 人工改过的内容行原样保留（判据见 t69-reviews-model 的 TC-M3-12-3.3 后半）。
 *
 * 人工/机器的边界也在这层写清：upsertReviewRow / upsertReviewBinding 是**机器写**
 * （采集路径）；人工修正走直接 UPDATE（现状没有 review 修正工具，FR-M4-19 的通道
 * 后开），两者相遇时机器让路。
 */
import { nowIso } from './db.js'

const norm = value => String(value ?? '').trim().toUpperCase()

/**
 * 写一条 review 主行（机器写，首次观测为准）。
 * 已存在（家族内同 dedupe_key）→ 只刷 updated_at，返回 inserted:false（dup 命中）。
 */
export function upsertReviewRow(store, {
  dedupeKey, reviewId = null, parentAsin, childAsin, marketplace,
  author = null, reviewDate = null, rating = null, title = null, body = null,
  verified = null, variantNote = null, sourceTaskId, sourceSnapshotId = null,
  observedAt, nOverN = null, collectState,
} = {}) {
  const market = norm(marketplace)
  const parent = norm(parentAsin)
  const child = norm(childAsin)
  const key = String(dedupeKey ?? '').trim()
  if (key === '' || parent === '' || child === '' || market === '') {
    const error = new Error('dedupeKey / parentAsin / childAsin / marketplace 必填（铁律 2 双绑定）')
    error.code = 'BAD_REQUEST'
    throw error
  }
  const existed = store.get(
    'SELECT dedupe_key FROM reviews WHERE dedupe_key = ? AND parent_asin = ? AND marketplace = ?',
    [key, parent, market],
  )
  store.run(
    `INSERT INTO reviews (dedupe_key, review_id, parent_asin, child_asin, marketplace,
                          author, review_date, rating, title, body, verified, variant_note,
                          source_task_id, source_snapshot_id, observed_at, updated_at,
                          n_over_n, collect_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key, parent_asin, marketplace) DO UPDATE SET
       updated_at = excluded.updated_at`,
    [key, reviewId === null ? null : String(reviewId), parent, child, market,
      author, reviewDate, rating, title, body,
      /* verified 是 1/0/NULL 三值列（NULL=未取到≠0）：JS 布尔不能绑 SQLite。 */
      verified === null || verified === undefined ? null : (verified ? 1 : 0),
      variantNote,
      String(sourceTaskId ?? ''), sourceSnapshotId, String(observedAt ?? nowIso()), nowIso(),
      nOverN, String(collectState ?? 'collected')],
  )
  return { inserted: existed === undefined, dedupeKey: key }
}

/**
 * 补绑定（方案 A）：不改 reviews 主行，只在 review_bindings 追加/更新一行。
 * 四键缺一 → BAD_REQUEST；主行不存在 → NOT_FOUND（先有主行才能补绑定）。
 */
export function upsertReviewBinding(store, {
  dedupeKey, parentAsin, marketplace, childAsin,
  variantNote = null, boundAt, boundByTask = null,
} = {}) {
  const market = norm(marketplace)
  const parent = norm(parentAsin)
  const child = norm(childAsin)
  const key = String(dedupeKey ?? '').trim()
  if (key === '' || parent === '' || child === '' || market === '') {
    const error = new Error('upsertReviewBinding 四键缺一')
    error.code = 'BAD_REQUEST'
    throw error
  }
  const owner = store.get(
    'SELECT dedupe_key FROM reviews WHERE dedupe_key = ? AND parent_asin = ? AND marketplace = ?',
    [key, parent, market],
  )
  if (owner === undefined) {
    const error = new Error('review 主行不存在，先有主行才能补绑定')
    error.code = 'NOT_FOUND'
    throw error
  }
  const existed = store.get(
    'SELECT review_dedupe_key FROM review_bindings WHERE review_dedupe_key = ? AND parent_asin = ? AND marketplace = ? AND child_asin = ?',
    [key, parent, market, child],
  )
  store.run(
    `INSERT INTO review_bindings (review_dedupe_key, parent_asin, marketplace, child_asin,
                                  variant_note, bound_at, bound_by_task)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(review_dedupe_key, parent_asin, marketplace, child_asin) DO UPDATE SET
       variant_note = COALESCE(excluded.variant_note, review_bindings.variant_note),
       bound_at = excluded.bound_at`,
    [key, parent, market, child, variantNote, String(boundAt ?? nowIso()), boundByTask],
  )
  return { inserted: existed === undefined }
}

/** 家族池（R8 的 Y）：同父同站的去重后评论行。 */
export function readReviewFamily(store, { parentAsin, marketplace } = {}) {
  return store.all(
    'SELECT * FROM reviews WHERE parent_asin = ? AND marketplace = ? ORDER BY observed_at, dedupe_key',
    [norm(parentAsin), norm(marketplace)],
  )
}

/** 绑定到本体的行（R8 的 X）：只认 bindings，不看主行归属。 */
export function readReviewBindings(store, { childAsin, marketplace } = {}) {
  return store.all(
    'SELECT * FROM review_bindings WHERE child_asin = ? AND marketplace = ? ORDER BY bound_at, review_dedupe_key',
    [norm(childAsin), norm(marketplace)],
  )
}

/** 家族总数 = 去重后行数（R3：不随子体数翻倍）。 */
export function countReviewFamily(store, { parentAsin, marketplace } = {}) {
  const row = store.get(
    'SELECT COUNT(*) AS n FROM reviews WHERE parent_asin = ? AND marketplace = ?',
    [norm(parentAsin), norm(marketplace)],
  )
  return Number(row?.n ?? 0)
}

/**
 * 家族解析：变体父优先，无父边则自身为父（与竞品家族同一规则，asin-competitor
 * 的 familyCompetitorsFor 同源思路）。调用方拿它把 childAsin 翻成 parentAsin 再进
 * ingestReviews —— ingest 的双绑定是 fail-closed 的，解析不塞进 ingest 里猜。
 */
export function resolveReviewFamily(store, { asin, marketplace } = {}) {
  const child = norm(asin)
  const market = norm(marketplace)
  const row = store.get(
    'SELECT parent_asin FROM asin_variant_relation WHERE marketplace = ? AND child_asin = ? LIMIT 1',
    [market, child],
  )
  return row === undefined ? child : norm(row.parent_asin)
}
