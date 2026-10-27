/**
 * T70 评论分析 —— domain 纯逻辑（LLD §2.2）。
 *
 * 三件纯函数：评分分布（家族口径）、样本不足判定、四类标注方法槽。
 * **方法未拍板（O-01）**：annotate 只有「跳过」分支是真的——拍板前不产标注、
 * 不造方法（没定的方法写出来就是编造）。阈值 5/2 是占位，拍板可调（常量在下方）。
 *
 * run/标注的落库（review_analysis_runs / review_annotations）**不在本文件**：
 * 两表迁移与 store 面等 O-01 拍板后一并落（b05d-honesty H9 锚——「主题分析表
 * 不许存在」——此刻正有效，建表要等拍板后正当更新锚并经 QA 验证）。
 */

import { createHash } from 'node:crypto'

/** run 级：分析样本数低于此值不产标注（占位，O-01 拍板可调）。 */
export const INSUFFICIENT_RUN_N = 5
/** 标签级：计数低于此值只列不判（占位，O-01 拍板可调）。 */
export const INSUFFICIENT_LABEL_N = 2

/**
 * 评分分布（家族去重口径）。
 *
 * 输入是 reviews 表的**家族去重后行**（唯一键已保证一行一评，此处不二次去重）。
 * rating 为 NULL/非法值（0、6、非数）→ 计入 unrated，不进 1-5 分母：「未取到评分」
 * 不是 0 星，0 星在 Amazon 口径里也不存在（评分域 1-5）。
 */
export function distribution(rows) {
  if (!Array.isArray(rows)) throw new Error('distribution 需要 reviews 行数组（坏输入 fail-closed，不猜）')
  const stars = [1, 2, 3, 4, 5].map(star => ({ star, numerator: 0, reviewKeys: [] }))
  let unrated = 0
  for (const row of rows) {
    const rating = row === null || row === undefined ? null : row.rating
    const valid = Number.isInteger(rating) && rating >= 1 && rating <= 5
    if (!valid) {
      unrated += 1
      continue
    }
    const entry = stars[rating - 1]
    entry.numerator += 1
    entry.reviewKeys.push(String(row.dedupe_key ?? ''))
  }
  const denominator = stars.reduce((sum, entry) => sum + entry.numerator, 0)
  return { stars, denominator, unrated }
}

/**
 * 样本不足判定（LLD §2.2.3 / FR-M4-14 AC⑤）。
 *
 * run 级 n < INSUFFICIENT_RUN_N → 整体不产标注（印「样本不足以判读」，不给 0 结论）；
 * 标签级 count < INSUFFICIENT_LABEL_N → 只列计数不给结论句。
 */
export function insufficientRun({ sampleN, labels } = {}) {
  const n = Number(sampleN)
  if (!Number.isInteger(n) || n < 0) throw new Error('sampleN 必须是非负整数（坏输入 fail-closed）')
  if (!Array.isArray(labels)) throw new Error('labels 必须是数组（坏输入 fail-closed）')
  const out = []
  for (const label of labels) {
    const count = Number(label === null || label === undefined ? NaN : label.count)
    if (!Number.isInteger(count) || count < 0) throw new Error('标签 count 必须是非负整数（坏输入 fail-closed）')
    out.push({
      label: String(label.label ?? ''),
      count,
      conclusionAllowed: count >= INSUFFICIENT_LABEL_N,
    })
  }
  return { insufficient: n < INSUFFICIENT_RUN_N, sampleN: n, labels: out }
}

/**
 * 四类标注（主题/痛点/异议/场景）—— O-01 已拍板（C 案词典法 v1，
 * 凭据 team/decisions/O-01-review-analysis-method-2026-10-23.md）。
 *
 * method 分支：`'lexicon'` = 词典法 v1（下方 LEXICON_V1）；空 = 跳过并说明；
 * 未知值仍**拒并点名**（fail-closed 不猜——方法版本是 run 行的字段，不许悄悄换）。
 * 计数口径（O-01 §一）：一条评论每类**至多一条** annotation，matched_terms 存全部
 * 命中词；label = 该类命中短语中字典序最小者（代表标签）。同一评论重复命中同一词
 * 仍是一条（去重评论条数由 readAnnotationCounts 的 COUNT(DISTINCT review_key) 保证）。
 */

/** 词典法 v1 的词表：四类各一张内置表（英文短语；改词表=新版本，旧标注不重算）。
 *  显式屈折形随列（lead 裁决 #4：词边界匹配不认屈折，leaks/leaked 等必须单列）——
 *  词表条数因此超过「8–15」的初稿指引，以 lead 裁决为准。 */
export const LEXICON_V1 = {
  topic: [
    'quality', 'material', 'durability', 'well made', 'sturdy', 'design',
    'appearance', 'craftsmanship', 'finish', 'texture', 'lightweight', 'solid',
    'materials', 'designed', 'sturdier',
  ],
  pain: [
    'leak', 'leaks', 'leaking', 'leaked', 'broke', 'broken', 'breaks', 'crack',
    'cracks', 'cracked', 'flimsy', 'smell', 'smells', 'hard to clean',
    'fell apart', 'wore out', 'fade', 'fades', 'faded', 'scratch', 'scratches',
    'scratched', 'uncomfortable', 'rust', 'rusts', 'rusted', 'chipped',
  ],
  objection: [
    'too expensive', 'overpriced', 'not worth', 'smaller than', 'not as pictured',
    'disappointed', 'disappointing', 'return', 'returned', 'refund', 'refunded',
    'misleading', 'cheaply made', 'expected better',
  ],
  scene: [
    'camping', 'patio', 'garden', 'office', 'bedroom', 'living room', 'outdoor',
    'indoor', 'balcony', 'porch', 'beach', 'travel', 'rv', 'garage',
  ],
}

/** 方法版本标识（写进 run.method_version；词表内容变 → 必须升版本号）。 */
export const LEXICON_V1_VERSION = 'lexicon-v1'

/**
 * 词表哈希（O-01 §二.2）：四类词表稳定序列化（逐类内排序后 join）取 sha256 前 16 hex。
 * 同一份词表两次哈希**必须相同**（测试钉死）；改一个词 → 哈希变（=新版本）。
 */
export function lexiconHash() {
  const payload = Object.keys(LEXICON_V1).sort()
    .map(category => `${category}:${[...LEXICON_V1[category]].sort().join('\u0000')}`)
    .join('\u0001')
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

export function annotate({ method = null, rows = [], categories = [] } = {}) {
  if (method === null || method === undefined || String(method).trim() === '') {
    return { skipped: true, note: '方法待拍板（O-01），本轮不产标注', annotations: [] }
  }
  if (String(method) !== 'lexicon') {
    throw new Error(`标注方法未实现：${String(method)} —— 不产伪标注（未知方法 fail-closed）`)
  }
  const wanted = categories.length === 0 ? Object.keys(LEXICON_V1) : categories
  for (const category of wanted) {
    if (!Object.hasOwn(LEXICON_V1, category)) {
      throw new Error(`category 不在四类穷举内：${String(category)} —— 不猜不引第五类`)
    }
  }
  const annotations = []
  const matchedReviewKeys = []
  for (const row of rows) {
    const reviewKey = String(row?.dedupe_key ?? '')
    /* 匹配口径（lead 裁决 #4）：**词边界子串**——规范化保留全部 token（含停用词与
       短词，否则 hard to clean / rv 永远匹配不到），只把非字母数字折叠成单空格、
       小写；短语两侧补空格后 includes。词序无关的 token 集分支**已删**（会把
       "well worth…made of…" 误判成 well made——宁漏不错，漏有覆盖率兜着）。
       leakproof 不算 leak（词边界杀假命中）。 */
    const normalized = ` ${String(row?.body ?? '')} ${String(row?.title ?? '')} `
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    let reviewHit = false
    for (const category of wanted) {
      const hits = LEXICON_V1[category].filter(phrase => normalized.includes(` ${phrase} `))
      if (hits.length === 0) continue
      reviewHit = true
      /* lead 裁决 #3：**每个命中的短语各产一条 annotation**（label=短语本体，
         matched_terms=[该短语]）——计数不许变成字母顺序的函数。标签不互斥：
         各标签计数合计可以大于样本数（页面与载荷都印这句）。 */
      for (const phrase of [...hits].sort()) {
        annotations.push({ reviewKey, category, label: phrase, matchedTerms: [phrase] })
      }
    }
    if (reviewHit) matchedReviewKeys.push(reviewKey)
  }
  return {
    skipped: false, note: null, annotations, matchedReviewKeys,
    labelsNote: '标签不互斥：各标签计数合计可以大于样本数（一条评论可命中多个标签）',
  }
}
