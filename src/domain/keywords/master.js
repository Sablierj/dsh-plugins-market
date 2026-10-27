/**
 * Composing one master record from the facts about a keyword.
 *
 * The hub built `master.json` by mutating a dictionary as it walked the source
 * tree, which made the result depend on the order the files were read and on
 * whether a previous run had already written a value. This is the same merge
 * expressed as a **pure function of the facts**, so the same facts always give
 * the same record and re-running the merge is a no-op rather than a second
 * accumulation.
 *
 * ## Two conventions worth stating once
 *
 * **Units are in the field names.** Every rate carries its unit: `cvrPct`,
 * `ctrPct`, `acosPct`, `brandClickPct`. The hub's `cvr` was a percentage in the
 * ABA path and a fraction in the ad path, compared against the same threshold;
 * a suffix makes that class of mistake impossible to write.
 *
 * **A missing number stays missing.** `searchVolume: null` means nobody told us
 * the volume — it is not 0. Several downstream rules (`classifySvTier`,
 * `classifyPriority`, `forListing`) branch on whether the value is known, and
 * collapsing null to 0 would file every unmeasured word as a long-tail word and
 * every unmeasured word as P2, which reads like a finding.
 */

import { createHash } from 'node:crypto'

import {
  classifyFunnel, classifyOwnStatus, classifyPriority, classifySvTier,
  detectProductLine, extractModifiers, forListing, opportunityFor } from './classify.js'
import { classifyRole } from './role.js'
import { abaTrend } from './trend.js'
import { listingPlacement } from './placement.js'

/** Which source kinds are present, in a stable order. */
const SOURCE_ORDER = ['brand_aba', 'ad_report', 'sellersprite', 'xiyou', 'manual']

/**
 * @param {object} input
 * @param {string} input.keyword
 * @param {string} input.marketplace
 * @param {object|null} input.aba        newest ABA fact, or null
 * @param {Array} input.abaHistory       every ABA fact for this word (any period)
 * @param {Array} input.ads              every ad fact (any period/file)
 * @param {Array} input.competitor       every competitor fact (any ASIN)
 * @param {Array} input.listed           keywords added by hand / from a list
 * @param {object} [input.signals]       product-line signals
 */
export function composeMaster({
  keyword, marketplace, aba = null, abaHistory = [], ads = [], competitor = [], listed = [], signals = undefined,
} = {}) {
  const word = String(keyword ?? '').replace(/\s+/g, ' ').trim()
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (word === '') throw new Error('composeMaster: keyword is required')
  if (market === '') throw new Error('composeMaster: marketplace is required')

  /* ── ad rollup ─────────────────────────────────────────────────────── */
  const ad = { impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0, rows: 0, files: ads.length }
  const adAsins = new Set()
  const adPeriods = new Set()
  const adMatchTypes = new Set()
  for (const fact of ads) {
    ad.impressions += num(fact?.impressions) ?? 0
    ad.clicks += num(fact?.clicks) ?? 0
    ad.orders += num(fact?.orders) ?? 0
    ad.spend += num(fact?.spend) ?? 0
    ad.sales += num(fact?.sales) ?? 0
    ad.rows += num(fact?.adRows) ?? 0
    for (const asin of fact?.asins ?? []) adAsins.add(String(asin).toUpperCase())
    if (fact?.period !== undefined && fact?.period !== null) adPeriods.add(String(fact.period))
    for (const type of fact?.matchTypes ?? []) adMatchTypes.add(String(type))
  }
  const hasAd = ads.length > 0

  /* ── competitor rollup ─────────────────────────────────────────────── */
  const competitorAsins = []
  const rankedCompetitors = []
  const absentCompetitors = []
  const competitorTags = new Set()
  let bestRank = null
  let bestRankAsin = null
  let topTrafficShare = null
  let competitorMonthlyVolume = null
  let competitorWeeklySearches = null
  let competitorCpc = null
  let competitorDifficulty = null
  let competitorSources = new Set()

  for (const fact of competitor) {
    const asin = fact?.asin === null || fact?.asin === undefined ? null : String(fact.asin).toUpperCase()
    if (asin !== null) competitorAsins.push(asin)
    if (fact?.sourceId !== undefined) competitorSources.add(String(fact.sourceId))
    for (const tag of fact?.keywordTypes ?? []) competitorTags.add(String(tag))

    const rank = num(fact?.organicRank)
    if (rank !== null && rank >= 1 && (bestRank === null || rank < bestRank)) {
      bestRank = rank
      bestRankAsin = asin
    }
    if (rank !== null && rank >= 1) rankedCompetitors.push({ asin, rank })
    else if (fact?.organicNoRank === true) absentCompetitors.push({ asin, reason: 'no-rank' })

    topTrafficShare = maxOr(topTrafficShare, num(fact?.trafficShare))
    competitorMonthlyVolume = maxOr(competitorMonthlyVolume, num(fact?.monthlyVolume))
    competitorWeeklySearches = maxOr(competitorWeeklySearches, num(fact?.weeklySearches))
    competitorCpc = maxOr(competitorCpc, num(fact?.cpc) ?? num(fact?.bid?.low))
    competitorDifficulty = maxOr(competitorDifficulty, num(fact?.difficulty))
  }

  /* ── search volume: ABA, then a third party, then whatever was listed ── */
  const abaVolume = num(aba?.searchVolume)
  const listedVolume = listed.map(entry => num(entry?.searchVolume)).find(value => value !== null) ?? null
  const listedDifficulty = listed.map(entry => num(entry?.difficulty)).find(value => value !== null) ?? null

  let searchVolume = abaVolume
  let searchVolumeSource = abaVolume === null ? null : 'brand_aba'
  let searchVolumePeriod = abaVolume === null ? null : (aba?.period ?? null)
  if (searchVolume === null && competitorMonthlyVolume !== null) {
    searchVolume = Math.round(competitorMonthlyVolume)
    searchVolumeSource = 'competitor-monthly'
    searchVolumePeriod = null
  }
  // Last resort, and labelled as such: a volume somebody typed is still a
  // volume, but a query that cannot tell it from an ABA measurement would
  // weight the two the same.
  if (searchVolume === null && listedVolume !== null) {
    searchVolume = Math.round(listedVolume)
    searchVolumeSource = 'manual'
    searchVolumePeriod = null
  }

  /* ── rates ─────────────────────────────────────────────────────────── */
  const ctrPct = ad.impressions > 0 ? round((ad.clicks / ad.impressions) * 100, 4) : null
  const abaCvr = num(aba?.cvr)
  const adCvr = ad.clicks > 0 ? (ad.orders / ad.clicks) * 100 : null
  const cvrPct = abaCvr ?? (adCvr === null ? null : round(adCvr, 4))
  const cvrSource = abaCvr !== null ? 'brand_aba' : (adCvr !== null ? 'ad_report' : null)
  const acosPct = ad.sales > 0 ? round((ad.spend / ad.sales) * 100, 4) : null
  const roas = ad.spend > 0 ? round(ad.sales / ad.spend, 4) : null
  const cpc = ad.clicks > 0 ? round(ad.spend / ad.clicks, 4) : null

  /* ── classification ───────────────────────────────────────────────── */
  const line = detectProductLine(word, signals)
  const svTier = classifySvTier(searchVolume)
  const brandClickPct = num(aba?.brandClickPct)
  const brandConvPct = num(aba?.brandConvPct)
  // `ownStatus` needs ABA to mean anything: without it every word is 'none',
  // which is the opportunity signal — so it is reported as null instead.
  const ownStatus = aba === null ? null : classifyOwnStatus(brandClickPct, brandConvPct)
  const funnel = classifyFunnel(searchVolume, cvrPct)
  const priority = classifyPriority({ searchVolume, cvr: cvrPct })
  const opportunity = ownStatus === null ? null : opportunityFor({ ownStatus, searchVolume })
  const modifiers = extractModifiers(word)
  /* 这个词到底是不是在说"本产品"：产品线 id 当身份短语，`bench-cushion` 要求
     同时含 bench 与 cushion。标题只放行 identity —— 这一条挡的是
     `patio furniture set` / `chair covers` 那种高搜索量但会稀释主身份的泛词。 */
  const role = classifyRole(word, { productLine: line.productLine })
  /* 趋势：用这个词的**全部** ABA 期，不是最新一条 —— 逐月累积的回报就在这里。 */
  const trend = abaTrend(abaHistory)
  /* 落位处方：这个词该写进标题 / 五点 / 后台的哪一档（不是"能不能写"）。 */
  const placement = listingPlacement({ role: role.role, searchVolume, svTier: svTier.tier })

  const sources = SOURCE_ORDER.filter(kind => (
    kind === 'brand_aba' ? aba !== null
      : kind === 'ad_report' ? hasAd
        : kind === 'manual' ? listed.length > 0
          : competitorSources.has(kind)
  ))

  return {
    keyword: word,
    marketplace: market,
    productLine: line.productLine,
    productLineMatched: line.matched,
    productLines: line.productLines,
    sources,

    hasAba: aba !== null,
    hasAd,
    hasCompetitor: competitor.length > 0,

    searchVolume,
    searchVolumeSource,
    searchVolumePeriod,
    weeklySearches: competitorWeeklySearches === null ? null : round(competitorWeeklySearches, 2),
    // ABA's own 搜索查询分数: 1 is the most-searched query in the report. It is
    // not a volume and not a rank, so it gets its own column rather than being
    // folded into either.
    abaScore: num(aba?.score),

    impressions: Math.round(ad.impressions),
    clicks: Math.round(ad.clicks),
    orders: Math.round(ad.orders),
    spend: round(ad.spend, 2),
    sales: round(ad.sales, 2),
    adRows: ad.rows,
    adFiles: ad.files,
    adPeriods: [...adPeriods].sort(),
    adMatchTypes: [...adMatchTypes].sort(),
    adAsins: [...adAsins].sort(),
    asinCount: adAsins.size,

    ctrPct,
    cvrPct,
    cvrSource,
    acosPct,
    roas,
    cpc: cpc ?? competitorCpc,

    brandImpressions: num(aba?.brandImpressions),
    brandImpressionPct: num(aba?.brandImpressionPct),
    brandClicks: num(aba?.brandClicks),
    brandClickPct,
    brandPurchases: num(aba?.brandPurchases),
    brandConvPct,
    totalImpressions: num(aba?.totalImpressions),
    totalClicks: num(aba?.totalClicks),
    totalPurchases: num(aba?.totalPurchases),
    ownStatus,

    funnel,
    svTier: svTier.tier,
    svTierLabel: svTier.label,
    svTierKnown: svTier.known,
    modifiers,
    /* 角色：identity / partial / offline / unknown，附判定依据。 */
    role: role.role,
    roleBasis: role.basis,
    trend,
    placement,
    priority,
    opportunity,

    competitorBestRank: bestRank,
    competitorBestAsin: bestRankAsin,
    competitorRankedCount: rankedCompetitors.length,
    competitorAbsentCount: absentCompetitors.length,
    competitorAsins: [...new Set(competitorAsins)].sort(),
    competitorTags: [...competitorTags].sort(),
    competitorTopTrafficShare: topTrafficShare,
    competitorCpc,
    competitorDifficulty,
    competitorSources: [...competitorSources].sort(),
    competitorRanked: rankedCompetitors.sort((a, b) => a.rank - b.rank).slice(0, 20),

    listed: listed.length > 0,
    listedVolume,
    listedDifficulty,

    forListing: forListing({ searchVolume, svTier: svTier.tier, cvr: cvrPct, role: role.role }),
  }
}

/**
 * The `word_id` the hub used: `sha256(lowercased keyword)[0..16]`.
 *
 * Kept because it is the only key the hub's JSON artefacts share with anything
 * else, and a re-import of an old export can then be matched up. It is *not*
 * the primary key here — `(keyword, marketplace)` is, because the same word on
 * two storefronts is two different rows and a hash of the word alone cannot
 * tell them apart.
 */
export function wordId(keyword) {
  // Collapses inner whitespace as well as trimming: the hub's `sha16` did not,
  // so `Bench  Cushion` and `bench cushion` hashed differently while
  // `normalizeKeyword` stored them as one row. A key that disagrees with the
  // primary key it is meant to identify is worse than no key.
  const canonical = String(keyword ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function maxOr(current, candidate) {
  if (candidate === null) return current
  if (current === null) return candidate
  return Math.max(current, candidate)
}
