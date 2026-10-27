/**
 * T70 评论分析 —— store 面（LLD §2.4 表映射；O-01 拍板 §一）。
 *
 * 两张表的读写口，最小面：写（run + annotations，事务、幂等）、读（单 run / 最新 run /
 * 标签聚合）。**判读与分类不住这里**——判读走 domain/ui/count-verdict.js（D-9 单点），
 * 标注走 domain/asin/review-analysis.js（词典法），本文件只搬行。
 *
 * 幂等：annotations 唯一键 (run_id, review_key, category, label)，冲突即跳过不报错
 * （「同一 run 同一评论同一标签只有一行」由约束保证，重跑不翻倍）。
 * 计数口径（O-01 §一）：标签计数 = COUNT(DISTINCT review_key)（按评论条数，不按词次）。
 */

const bad = message => { throw new Error(`${message}（坏输入 fail-closed，不猜）`) }

const isFilled = value => value !== null && value !== undefined && String(value).trim() !== ''

/** 写一行 run。缺关键列即拒（id/parent_asin/marketplace/asin/method/method_version/created_at）。 */
export function insertRun(store, row = {}) {
  if (!isFilled(row.id)) bad('insertRun 需要 id')
  if (!isFilled(row.parentAsin)) bad('insertRun 需要 parentAsin')
  if (!isFilled(row.marketplace)) bad('insertRun 需要 marketplace')
  if (!isFilled(row.asin)) bad('insertRun 需要 asin')
  if (!isFilled(row.method)) bad('insertRun 需要 method')
  if (!isFilled(row.methodVersion)) bad('insertRun 需要 methodVersion')
  if (!isFilled(row.createdAt)) bad('insertRun 需要 createdAt')
  store.run(
    `INSERT INTO review_analysis_runs
       (id, parent_asin, marketplace, asin, method, method_version, lexicon_hash,
        insufficient_run_n, insufficient_label_n, sample_n, matched_n, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(row.id), String(row.parentAsin), String(row.marketplace).toUpperCase(), String(row.asin),
      String(row.method), String(row.methodVersion), String(row.lexiconHash ?? ''),
      Number(row.insufficientRunN), Number(row.insufficientLabelN),
      Number(row.sampleN), Number(row.matchedN), String(row.createdAt),
    ],
  )
  return { id: String(row.id) }
}

/**
 * 批量写标注（单事务、幂等）。run_id 缺失或 category 不在四类穷举内 → 整批拒（不猜）。
 * 唯一键冲突跳过——「重跑同一 run 不翻倍」是唯一键的职责，不是先查后插的职责。
 */
export function insertAnnotations(store, rows = []) {
  if (!Array.isArray(rows)) bad('insertAnnotations 需要数组')
  const allowed = new Set(['topic', 'pain', 'objection', 'scene'])
  for (const row of rows) {
    if (!isFilled(row?.runId)) bad('insertAnnotations 需要每行 runId')
    if (!isFilled(row?.reviewKey)) bad('insertAnnotations 需要每行 reviewKey')
    if (!allowed.has(row?.category)) bad(`category 不在四类穷举内：${String(row?.category)}`)
  }
  let inserted = 0
  store.tx(() => {
    for (const row of rows) {
      const result = store.run(
        `INSERT INTO review_annotations
           (id, run_id, review_key, parent_asin, marketplace, category, label, matched_terms, method_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, review_key, category, label) DO NOTHING`,
        [
          String(row.id ?? `${row.runId}:${row.reviewKey}:${row.category}:${row.label}`),
          String(row.runId), String(row.reviewKey),
          String(row.parentAsin), String(row.marketplace).toUpperCase(),
          String(row.category), String(row.label),
          JSON.stringify(row.matchedTerms ?? []), String(row.methodVersion ?? ''),
        ],
      )
      inserted += Number(result?.changes ?? 0)
    }
  })
  return { inserted }
}

/* readRun（开工单 §2 初稿列的最小读口）已删：无消费方，属开工单 over-spec
   （lead 2026-10-23 裁决 #2 记账）；读口以 readLatestRun + readAnnotationCounts 为准。 */

export function readLatestRun(store, { parentAsin, marketplace } = {}) {
  if (!isFilled(parentAsin)) bad('readLatestRun 需要 parentAsin')
  if (!isFilled(marketplace)) bad('readLatestRun 需要 marketplace')
  const row = store.get(
    `SELECT * FROM review_analysis_runs
      WHERE parent_asin = ? AND marketplace = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [String(parentAsin), String(marketplace).toUpperCase()],
  )
  return row === undefined ? null : row
}

/**
 * 标签聚合：按 category+label 计数，**count = COUNT(DISTINCT review_key)**（O-01 §一：
 * 一条评论刷 20 次同一个词仍只算 1 条）。matched_terms 逐行取回在 JS 里并集去重
 * （GROUP_CONCAT 拼 JSON 数组会把数组切碎——那是错的口径）。
 */
export function readAnnotationCounts(store, runId) {
  if (!isFilled(runId)) bad('readAnnotationCounts 需要 runId')
  const groups = store.all(
    `SELECT category, label, COUNT(DISTINCT review_key) AS count
       FROM review_annotations
      WHERE run_id = ?
      GROUP BY category, label
      ORDER BY category, count DESC, label`,
    [String(runId)],
  )
  const terms = new Map()
  for (const row of store.all(
    'SELECT category, label, matched_terms FROM review_annotations WHERE run_id = ?',
    [String(runId)],
  )) {
    const key = `${row.category}\u0000${row.label}`
    const set = terms.get(key) ?? new Set()
    let parsed = []
    try { parsed = JSON.parse(row.matched_terms ?? '[]') } catch { parsed = [] }
    for (const term of Array.isArray(parsed) ? parsed : []) set.add(String(term))
    terms.set(key, set)
  }
  return groups.map(row => ({
    category: String(row.category),
    label: String(row.label),
    count: Number(row.count),
    matchedTerms: [...(terms.get(`${row.category}\u0000${row.label}`) ?? [])],
  }))
}
