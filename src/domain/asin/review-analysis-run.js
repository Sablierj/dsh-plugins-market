/**
 * T70 评论分析 —— run 编排（LLD §2.3 I-T70-1/2；O-01 拍板）。
 *
 * runReviewAnalysis：读家族去重评论 → 分布 + 词典法标注 → 写 run 行 + 标注行 →
 * 返回可判读载荷。sampleN < 5（O-01 阈值）→ **只写 run 行不写标注**（insufficient:true）。
 * readReviewAnalysis：最近 run + 标签计数 + 覆盖率 + 三元组（来源=method_version/
 * lexicon_hash，时间=created_at，样本=n/N）；**没有 run → hasRun:false，不编空分布**。
 *
 * 计数与判读不住这里：计数口径在 store/review-analysis.js（DISTINCT review_key），
 * D-9 判读在 domain/ui/count-verdict.js（import 不重写）。
 */

import { insertRun, insertAnnotations, readLatestRun, readAnnotationCounts } from '../../store/review-analysis.js'
import { readReviewFamily } from '../../store/review.js'
import { countVerdict } from '../ui/count-verdict.js'
import {
  INSUFFICIENT_LABEL_N, INSUFFICIENT_RUN_N, LEXICON_V1_VERSION, annotate, distribution, insufficientRun, lexiconHash,
} from './review-analysis.js'

const isFilled = value => value !== null && value !== undefined && String(value).trim() !== ''

/** run id：ISO 时间 + 短随机（可读且不撞）。 */
const newRunId = () => `ra-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`

export function runReviewAnalysis({ store, parentAsin, marketplace, asin } = {}) {
  if (!isFilled(parentAsin)) throw new Error('runReviewAnalysis 需要 parentAsin（坏输入 fail-closed）')
  if (!isFilled(marketplace)) throw new Error('runReviewAnalysis 需要 marketplace（坏输入 fail-closed）')
  if (!isFilled(asin)) throw new Error('runReviewAnalysis 需要 asin（坏输入 fail-closed，不猜入口子体）')
  const market = String(marketplace).toUpperCase()
  const family = readReviewFamily(store, { parentAsin, marketplace: market })
  const sampleN = family.length
  const dist = distribution(family)
  const createdAt = new Date().toISOString()
  const runId = newRunId()

  /* O-01 阈值：n<5 不产标注（只写 run 行，insufficient 如实）。 */
  const early = insufficientRun({ sampleN, labels: [] })
  if (early.insufficient) {
    insertRun(store, {
      id: runId, parentAsin: String(parentAsin), marketplace: market, asin: String(asin),
      method: 'lexicon', methodVersion: LEXICON_V1_VERSION, lexiconHash: lexiconHash(),
      insufficientRunN: INSUFFICIENT_RUN_N, insufficientLabelN: INSUFFICIENT_LABEL_N,
      sampleN, matchedN: 0, createdAt,
    })
    return {
      runId, sampleN, matchedN: 0, coverage: sampleN === 0 ? null : 0,
      distribution: dist, labels: [], insufficient: true,
      triple: { source: LEXICON_V1_VERSION, time: createdAt, sample: `${0}/${sampleN}` },
    }
  }

  const result = annotate({ method: 'lexicon', rows: family })
  insertRun(store, {
    id: runId, parentAsin: String(parentAsin), marketplace: market, asin: String(asin),
    method: 'lexicon', methodVersion: LEXICON_V1_VERSION, lexiconHash: lexiconHash(),
    insufficientRunN: INSUFFICIENT_RUN_N, insufficientLabelN: INSUFFICIENT_LABEL_N,
    sampleN, matchedN: result.matchedReviewKeys.length, createdAt,
  })
  insertAnnotations(store, result.annotations.map(entry => ({
    ...entry,
    runId, parentAsin: String(parentAsin), marketplace: market,
    methodVersion: LEXICON_V1_VERSION,
  })))

  /* 标签级阈值（count<2 只列不判）在读回的聚合上判定——计数以库内 DISTINCT 为准。 */
  const counts = readAnnotationCounts(store, runId)
  const labelState = insufficientRun({ sampleN, labels: counts })
  return {
    runId,
    sampleN,
    matchedN: result.matchedReviewKeys.length,
    coverage: sampleN === 0 ? null : result.matchedReviewKeys.length / sampleN,
    distribution: dist,
    labels: labelState.labels.map(entry => ({
      ...entry,
      category: counts.find(row => row.label === entry.label)?.category ?? null,
      matchedTerms: counts.find(row => row.label === entry.label)?.matchedTerms ?? [],
    })),
    insufficient: false,
    labelsNote: result.labelsNote ?? null,
    triple: {
      source: `${LEXICON_V1_VERSION} / ${lexiconHash()}`,
      time: createdAt,
      sample: `${result.matchedReviewKeys.length}/${sampleN}`,
    },
  }
}

export function readReviewAnalysis({ store, parentAsin, marketplace } = {}) {
  if (!isFilled(parentAsin)) throw new Error('readReviewAnalysis 需要 parentAsin（坏输入 fail-closed）')
  if (!isFilled(marketplace)) throw new Error('readReviewAnalysis 需要 marketplace（坏输入 fail-closed）')
  const market = String(marketplace).toUpperCase()
  const run = readLatestRun(store, { parentAsin: String(parentAsin), marketplace: market })
  /* 没有 run 就是没跑过分析——不编空分布（四态：没跑 ≠ 跑了是 0）。 */
  if (run === null) return { hasRun: false }
  const counts = readAnnotationCounts(store, run.id)
  const labelState = insufficientRun({ sampleN: Number(run.sample_n), labels: counts })
  /* 分布=当前家族行的聚合（与 run 时间无关的现况数；run 的 n/N 是 run 时刻的样本口径，
     两者并排印、各带各的口径——不混成一个数）。 */
  const dist = distribution(readReviewFamily(store, { parentAsin: String(parentAsin), marketplace: market }))
  return {
    hasRun: true,
    distribution: dist,
    runId: run.id,
    state: run.state ?? null,
    method: run.method,
    methodVersion: run.method_version,
    lexiconHash: run.lexicon_hash,
    sampleN: Number(run.sample_n),
    matchedN: Number(run.matched_n),
    coverage: Number(run.sample_n) === 0 ? null : Number(run.matched_n) / Number(run.sample_n),
    insufficient: Number(run.sample_n) < Number(run.insufficient_run_n),
    labelsNote: '标签不互斥：各标签计数合计可以大于样本数（一条评论可命中多个标签）',
    labels: labelState.labels.map(entry => ({
      ...entry,
      category: counts.find(row => row.label === entry.label)?.category ?? null,
      matchedTerms: counts.find(row => row.label === entry.label)?.matchedTerms ?? [],
    })),
    triple: {
      /* D-9 判读单点：run 的计数格按 created_at 有无判读（有 run 行必有 created_at，
         但展示层仍走 countVerdict —— 一处判读、处处一致）。 */
      source: `${run.method_version} / ${run.lexicon_hash}`,
      time: run.created_at,
      sample: `${countVerdict(Number(run.matched_n), run.created_at)}/${countVerdict(Number(run.sample_n), run.created_at)}`,
    },
  }
}
