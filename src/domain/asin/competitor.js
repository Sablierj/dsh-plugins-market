/**
 * Per-ASIN competitor comparison (module 05, F05-02 tab 7 of 9).
 *
 * ## What this tab is allowed to compare, and what it is not
 *
 * F06-03's "comparison matrix" (rows = dimension fields, columns = ours + theirs)
 * has **no source in this repository**: there is no dimension table and
 * `domain/keywords/competitor.js` only works on the keyword side. F06-05's "review
 * topics" likewise: there is no review/theme table. Both are reported through
 * `unsourced[]` rather than drawn as an empty matrix, because an empty matrix reads
 * as "we compared and nothing differed".
 *
 * What *does* have a source is the keyword side, and this module does not
 * re-implement any of it:
 *
 *   · group membership      → `listCompetitorSets`   (`store/kw.js`)
 *   · both sides' facts     → `readCompetitorSides`  (`store/kw.js`)
 *   · the five-bucket split → `quadrantRows` + `classifyQuadrants` (`domain/keywords/competitor.js`)
 *   · brand isolation       → `competitorBrandHits`  (`store/keyword-ownership.js`)
 *
 * The bucketing is a judgement with a vocabulary (`QUADRANTS`), a display order
 * (`QUADRANT_ORDER`) and a page size (`QUADRANT_PAGE_SIZE`), all of which already
 * exist. A copy here would be a second answer to "which bucket is this word in",
 * and the two would drift on exactly the words that matter — the brand-hits and the
 * never-measured ones.
 *
 * ## `comparison: null` is a normal answer with four different reasons
 *
 * "This ASIN is in no competitor set", "the sets it is in contain nobody else",
 * "the peers have no keyword facts", and "there is a real comparison" are four
 * different situations. The first two have nothing to compare; the third has a
 * comparison that is empty because the *other side was never measured* — which is
 * not the same as "they hold none of our words". Each gets its own sentence.
 */

import { listCompetitorSets, readCompetitorSides } from '../../store/kw.js'
import { readCompetitorEvidence } from '../../store/competitor-evidence.js'
import { competitorBrandHits } from '../../store/keyword-ownership.js'
import {
  QUADRANTS, QUADRANT_ORDER, QUADRANT_PAGE_SIZE, buildEvidenceView, classifyQuadrants, quadrantRows,
} from '../keywords/competitor.js'
import { ASIN_NO_SOURCE_TEXT, unsourced } from './unsourced.js'

export const ASIN_COMPETITOR_DIMENSION_MATRIX_REASON =
  'F06-03 的对比矩阵（行=维度字段、列=自有+竞品）本仓没有来源：schema 里没有维度对比表，'
  + 'domain/keywords/competitor.js 只做关键词侧。这里能给的对比是关键词侧的五桶分类，不是字段矩阵。'

export const ASIN_COMPETITOR_REVIEW_TOPICS_REASON =
  'F06-05 的口碑主题（竞品侧）本仓没有来源 —— 这个洞是**真的**，原因要点名结构（T70 后修订；'
  + '旧理由断言「主题分析表不存在」，自 v64 起已不成立，不许再引）：'
  + '① 评论采集只采**自有** ASIN（reviews 节只跑自有 targets），竞品 ASIN 的评论本仓从不采集；'
  + '② T70 的主题标注（review_analysis_runs / review_annotations）只作用于**我方家族**，'
  + '不覆盖任何竞品；③ 我方的口碑主题在「评论」页签（评论分析区块），不在竞品对比页签。'
  + '所以这里没有可引用的竞品侧评论样本与时间窗——缺的是竞品侧评论数据本身，不是读取口。'

/** The four sentences. `comparisonNote` is one of these, or `null` when comparable. */
export const ASIN_COMPETITOR_NOTES = {
  noSet: '这条 ASIN 不在任何竞品组里 —— 没有对端，就无从对比（不是「对比结果是空」）',
  noPeer: '这些竞品组里只有它自己 —— 没有对端',
  peerUnmeasured: '对端没有任何关键词事实（kw_competitor_fact 里没有这些 ASIN 的行）—— '
    + '这是「没测到」，不是「它们没有词」',
}

const blankToNull = value => {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/**
 * One ASIN's competitor picture.
 *
 * `limit` defaults to `QUADRANT_PAGE_SIZE` and is clamped to it: the page size is
 * the one ceiling both the route and this builder honour, and letting a caller ask
 * for more here would make the page render a list the route would have truncated.
 */
export function buildAsinCompetitorView(store, { asin, marketplace, limit } = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (key === '') return { ok: false, code: 'BAD_REQUEST', error: 'asin is required' }
  if (market === '') return { ok: false, code: 'BAD_REQUEST', error: 'marketplace is required' }

  const requested = Number(limit)
  const bound = Number.isFinite(requested) && requested >= 1
    ? Math.min(Math.trunc(requested), QUADRANT_PAGE_SIZE)
    : QUADRANT_PAGE_SIZE

  const allSets = listCompetitorSets(store, { marketplace: market, limit: 200 })
  const membership = []
  const peerSet = new Set()
  for (const set of allSets) {
    const members = Array.isArray(set.asins) ? set.asins : []
    const containsThis = members.includes(key)
    /* Every set is listed, not only the ones that contain this ASIN: "this ASIN is
       in 2 of the 5 sets on this marketplace" is the answer to "why is my
       comparison missing a competitor", and a list filtered to the containing sets
       cannot say it. */
    membership.push({
      id: set.id,
      name: set.name,
      note: set.note ?? null,
      memberCount: members.length,
      updatedAt: set.updated_at ?? null,
      containsThis,
      members,
    })
    /* 2026-10-25（R-18）：这一行原来是 `if (!containsThis) continue` ——
       **它把竞品组整个废掉了**。`containsThis` 是「这个组的成员里有本 ASIN」，
       而竞品组的成员**从来不含自己**（那才叫竞品组）。于是对端恒为空，
       报告永远印「这条 ASIN 不在任何竞品组里 —— 没有对端，就无从对比」，
       而 `amzn_competitor_quadrants` 拿着同一个组能算出 1,432 条词的五桶。

       正确判据：**任何竞品组都是对端来源** ——
         · 组里含本 ASIN → 对端 = 组内其他成员（下面是 `member !== key` 那一层）；
         · 组里不含本 ASIN → 对端 = 组内全部成员（**这就是竞品组的正常用法**）。
       两种情形都不会把本 ASIN 自己算成对端，因为 `member !== key` 一直在。
       `containsThis` 仍然保留在 membership 里：它回答的是「我在几个组里」，
       那是另一个问题，不该拿它来决定「能不能对比」。 */
    for (const member of members) if (member !== key) peerSet.add(member)
  }

  const memberSets = membership.filter(set => set.containsThis)
  const peers = [...peerSet].sort()

  let comparison = null
  let comparisonNote = null
  let excludedSelf = false

  /* 2026-10-25（R-18）：这里原来先判 `memberSets.length === 0` —— 而 memberSets 是
     「成员里含本 ASIN 的组」，正常竞品组不含本 ASIN，所以它恒为空，
     **整段对比被短路成「不在任何竞品组里」**（对端明明找到了 4 个）。
     正确的两档：
       · 这个站点**一个竞品组都没有** → noSet（真没有可比的组）；
       · 有组、但组里只有自己 → noPeer（这正是 b05d-tabs 的第二种情形）。
     用 `allSets` 而不是 `memberSets`：问的是「有没有组」，不是「有没有我所在的组」。 */
  if (allSets.length === 0) {
    comparisonNote = ASIN_COMPETITOR_NOTES.noSet
  } else if (peers.length === 0) {
    comparisonNote = ASIN_COMPETITOR_NOTES.noPeer
  } else {
    const sides = readCompetitorSides(store, { asin: key, marketplace: market, competitors: peers })
    excludedSelf = sides.excludedSelf === true
    /* T68 载荷接线：双侧测量期 + 逐词判读。读端与判据都不新写 ——
       读走 store/competitor-evidence.js 的 readCompetitorEvidence（与 §20.7 证据
       视图同一个读端：时间/来源逐条保留，竞品侧跨观测日不合并），判走
       domain/keywords/competitor.js 的 buildEvidenceView（§20.3 的唯一判据：
       两侧周期一致才给 verdict，不一致 verdict=null 并给警告原话）。
       这里是接线，不是第二份判据 —— 判据只有一处，页面也只印不判。 */
    const evidence = readCompetitorEvidence(store, {
      asin: key, marketplace: market, peers,
      keywords: [...sides.theirs.keys(), ...sides.ours.keys()],
    })
    const rows = quadrantRows(sides).map(row => {
      const pair = evidence.get(row.keyword) ?? { our: null, their: null }
      const view = buildEvidenceView({ keyword: row.keyword, marketplace: market, our: pair.our, their: pair.their })
      return {
        ...row,
        /* 扫描深度两边都兜：quadrantRows 已带（sides.ours），证据读端的事实里也
           有同一个值 —— 谁先有算谁的，缺失留 null（渲染层「本处未记」）。 */
        our_scan_depth: row.our_scan_depth ?? view.our.facts?.scan_depth ?? null,
        our_period: view.our.period,
        their_period: view.their.period,
        their_periods: view.their.periods,
        period_mismatch: view.periodMismatch,
        their_periods_mixed: view.theirPeriodsMixed,
        comparable: view.comparable,
        verdict: view.verdict,
        period_warning: view.warning,
      }
    })
    const classified = classifyQuadrants(rows, {
      marketplace: market,
      brandHitsFor: keyword => competitorBrandHits(store, keyword),
    })

    /* Truncated here, at the one page size, so the payload the page renders is
       already the payload a reader gets. The route truncates with the same
       constant; two different numbers was the defect `QUADRANT_PAGE_SIZE`
       documents, and this builder does not reintroduce it. */
    const quadrants = {}
    const truncated = {}
    for (const bucket of QUADRANT_ORDER) {
      const list = classified.quadrants[bucket] ?? []
      truncated[bucket] = list.length > bound
      quadrants[bucket] = list.slice(0, bound)
    }

    comparison = {
      quadrants,
      truncated,
      counts: classified.counts,
      /* T-4b：对端未测量的行数（按桶）。派生字段，**不改任何归属**。
         页面凭它加一句「本页 N 条词的对端没测过、归类口径待定」，避免
         「左边算自有优势、右边印该词无竞品数据」这种同一行自相矛盾。 */
      noDataByBucket: classified.noDataByBucket,
      noDataTotal: classified.noDataTotal,
      order: [...QUADRANT_ORDER],
      labels: { ...QUADRANTS },
      inputTotal: classified.inputTotal,
      classified: classified.classified,
      candidates: classified.candidates.slice(0, bound),
      isolated: classified.isolated.slice(0, bound),
      peers: sides.peers,
      peerCount: sides.peers.length,
      limit: bound,
      /* Their side was read for every keyword of the union; an empty `theirs` map
         means the peers contributed no fact at all. That is a different fact from
         "they rank for nothing", and the sentence says which. */
      peerFactKeywords: sides.theirs.size,
      ourFactKeywords: sides.ours.size,
      /* T68：卡头「两侧测量期」与判读闸门的载荷。日期集合去重排序后如实给
         （一个日期就是 period；多个日期不压成一个 —— 压了就假装同一天了）。
         judgementBlocked 是 §2.2 铁律的机器口径：两侧周期不同 / 竞品侧自己跨
         多个观测日 → 本轮不出判读，页面照此收起结论块；warning 是判据给的原话。 */
      periods: (() => {
        const ourDates = [...new Set(rows.map(row => row.our_period).filter(value => value !== null && value !== undefined))].sort()
        const theirDates = [...new Set(rows.flatMap(row => (
          row.their_periods.length > 0
            ? row.their_periods
            : (row.their_period !== null && row.their_period !== undefined ? [row.their_period] : [])
        )))].sort()
        const periodMismatch = rows.some(row => row.period_mismatch === true)
        const theirPeriodsMixed = rows.some(row => row.their_periods_mixed === true)
        return {
          ours: { dates: ourDates, period: ourDates.length === 1 ? ourDates[0] : null },
          theirs: { dates: theirDates, period: theirDates.length === 1 ? theirDates[0] : null },
          periodMismatch,
          theirPeriodsMixed,
          comparable: rows.length > 0 && rows.every(row => row.comparable === true),
          judgementBlocked: periodMismatch || theirPeriodsMixed,
          warning: [...new Set(rows
            .filter(row => row.period_mismatch === true || row.their_periods_mixed === true)
            .map(row => row.period_warning)
            .filter(value => value !== null && value !== undefined))].join(' ') || null,
        }
      })(),
    }
    comparisonNote = sides.theirs.size === 0 ? ASIN_COMPETITOR_NOTES.peerUnmeasured : null
  }

  const notes = []
  if (excludedSelf) {
    notes.push('这条 ASIN 自己也出现在竞品事实里，已从对端剔除 —— 拿自己跟自己比会把我们持有的每个词都报成「他们也有」。')
  }
  if (comparison !== null && Object.values(comparison.truncated).some(Boolean)) {
    notes.push(`每个象限只印前 ${bound} 条 —— 「没印出来」与「这个象限里没有」不是一件事。`)
  }

  return {
    ok: true,
    asin: key,
    marketplace: market,
    source: 'competitor_set + readCompetitorSides + classifyQuadrants',
    membership,
    setCount: membership.length,
    memberSets: memberSets.map(set => set.id),
    memberSetCount: memberSets.length,
    peers,
    peerCount: peers.length,
    peersSource: memberSets.length === 0
      ? null
      : `成员并集来自 ${memberSets.map(set => set.name).join('、')}`,
    comparison,
    comparisonNote,
    unsourced: [
      unsourced({
        id: 'dimension-matrix',
        label: '按维度字段的对比矩阵',
        feature: 'F06-03',
        reason: ASIN_COMPETITOR_DIMENSION_MATRIX_REASON,
      }),
      unsourced({
        id: 'review-topics',
        label: '口碑主题',
        feature: 'F06-05',
        reason: ASIN_COMPETITOR_REVIEW_TOPICS_REASON,
      }),
    ],
    noSourceText: ASIN_NO_SOURCE_TEXT,
    notes,
  }
}
