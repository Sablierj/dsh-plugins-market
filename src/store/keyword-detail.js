/**
 * 模块 08 F08-08 —— 关键词详情视图的读半边。
 *
 * 这个文件只**读**，一行都不写，也不做判断。它把七个 §8.2 项各自的数据源读出来，
 * 组装成一个纯对象交给路由（`masterState`）和工具（`amzn_keyword_detail`）。
 *
 * ## 为什么不复用 `getMaster`
 *
 * `getMaster`（store/kw.js）返回的是**聚合后的标量**：ABA 只留最新一个周期，广告把
 * 所有周期、所有文件**求和**，竞品值取 `MAX(...)`。详情视图要的恰好是它在聚合那一
 * 步扔掉的东西 —— 逐周期、逐文件、逐 ASIN 的原始行。所以这里直接读三张事实表。
 *
 * ## 单位不做换算
 *
 * 三张事实表里的数都是**导入边界上写下的原始单位**（`cvr_pct` 是百分数、
 * `spend`/`sales` 是金额、`weekly_searches` 是实数）。这里原样带出，不乘不除 ——
 * 换算只发生在导入边界一处（见 schema.js 列名上的说明）。
 *
 * ## 两种「没有」必须长得不一样
 *
 * 本仓反复出现的缺陷是**把缺失渲染成真实值**（一个 0、一个空串、一个看起来像
 * 「查过、没有」的空列表）。这里把两种缺失写成**词表常量**，渲染层只能引用它们，
 * 不能自己编词：
 *
 *   - `未测量`：字段**存在且被建模**，只是这个词没有对应的行。
 *   - `本系统没有这个字段`：这个概念**根本没有被建模**（相关性 / 逐词实际落点 /
 *     逐词效果），所以不是「没测到」，是「没有这个字段可测」。
 *
 * 把这两者混为一谈就是那个缺陷本身。尤其：**不得**从 CVR、搜索量、层级或 embedding
 * 距离推导出一个「相关性」再当作观测值展示 —— 那是把猜测装扮成事实。
 *
 * ## 反向查计划要扫表（成本如实写在注释里）
 *
 * `keyword_plan_entry` 的主键是 `(plan_id, keyword_key)`，索引是
 * `(plan_id, owner_position)`。两者**首列都是 plan_id**，所以「哪些计划包含这个词、
 * 在什么位置」这个方向**没有索引可用**，只能全表扫 `keyword_plan_entry` 再按
 * `keyword_key` 过滤。这是一次 O(词表条目数) 的扫描，不是一次索引查找。本批按单
 * 关键词调用（一次 state 读最多一条），所以代价可接受；若将来要批量，必须先加一条
 * `keyword_key` 上的索引，否则会退化成 N 次全表扫。
 */

import { keywordKey } from '../domain/keywords/key.js'
import { KEYWORD_LIFECYCLE_LABELS, PLAN_STATUS_LABELS } from '../domain/states.js'
import { QUALITY_RULES } from '../domain/data/quality-rules.js'
import { getKeywordOwnership, keywordOwnershipHistory } from './keyword-ownership.js'
import { getKeywordLifecycle, keywordLifecycleHistory } from './keyword-lifecycle.js'

/* ── 缺失词表：渲染层只能引用这两个常量 ─────────────────────────────────────── */

/** 字段存在且被建模，只是这个词没有对应的行。 */
export const ABSENCE_UNMEASURED = '未测量'

/** 概念根本没有被建模 —— 没有列、没有词表、没有阈值可测。 */
export const ABSENCE_NOT_MODELLED = '本系统没有这个字段'

/**
 * 关键词级数据质量规则只有两条。另外七条（新鲜度 / 完整性 / 有效性 / 一致性 /
 * 可追溯）打的是 asin / listing 级对象（见 domain/data/quality-rules.js 的扫描器）。
 * 说出来的理由：一个近乎空的列表不能读成「这个词很干净」—— 它多半只是「没有规则
 * 盯着它」。值逐字对应 quality-rules.js 里 objectType: 'keyword' 的两处。
 */
export const KEYWORD_LEVEL_RULE_IDS = ['DQ-UNIQUE-001', 'DQ-ACTION-001']

/** 明确「没有建模」的概念，各自附上「为什么」。渲染层照抄，不另编。 */
export const NOT_MODELLED = {
  relevance: {
    kind: ABSENCE_NOT_MODELLED,
    field: '相关性 / 相关性证据',
    /* 「§4.2 的相关性门槛尚未实现」是会过期的写法（今天没做的，明天可能做，而这句话不会
       跟着改）。改成今天可核对的三条事实：没有列、没有词表、没有阈值。 */
    why: 'schema 里没有「相关性」这一列，也没有相关性词表与阈值 —— 本仓没有相关性模型，'
      + '所以这个词与这条产品的相关程度既读不出来也判不出来。'
      + '不得由 CVR、搜索量、层级或 embedding 距离推导出一个「相关性」再当作观测值展示。',
  },
  actualUsage: {
    kind: ABSENCE_NOT_MODELLED,
    field: '逐词实际使用位置（标题 / 五点 / 后台 / 广告）',
    why: '实际落点不落库：系统只存位置计划的**计划**位置；实际覆盖只在提供 listing 文案时'
      + '临时计算，算完即弃，没有任何地方留下「这个词实际出现在哪」。',
  },
  effect: {
    kind: ABSENCE_NOT_MODELLED,
    field: '逐词效果',
    why: '效果观测发生在发布 / ASIN 粒度，从不按关键词记录，所以没有逐词效果可读。',
  },
}

/** One absence descriptor. The two kinds are the vocabulary; the text is the phrase. */
function absent(kind, text, why) {
  return { kind, text, why }
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function num(value) {
  return value === null || value === undefined ? null : Number(value)
}

/* ── the reader ─────────────────────────────────────────────────────────────── */

/**
 * One keyword's detail view, assembled from the fact tables and the three
 * module-08 side tables. Read-only.
 *
 * @param {object} store
 * @param {{keyword: string, marketplace: string, asin?: string|null}} args
 */
export function readKeywordDetail(store, { keyword, marketplace, asin = null } = {}) {
  const word = keywordKey(keyword)
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (word === '') throw new Error('keyword is required')
  if (market === '') throw new Error('marketplace is required')
  const ownAsin = blankToNull(asin) === null ? null : String(asin).trim().toUpperCase()

  return {
    keyword: word,
    marketplace: market,
    asin: ownAsin,
    master: readMasterRow(store, { word, market }),
    timeline: readTimeline(store, { word, market }),
    rank: readRank(store, { word, market, ownAsin }),
    ownership: readOwnership(store, { word, market }),
    plans: readPlans(store, { word }),
    quality: readQuality(store, { word, market }),
    history: readHistory(store, { word, market }),
    variants: readVariants(store, { word, market }),
    /* 两个词表常量随视图一起带出去，渲染层引用它们而不是自己写字符串。 */
    absenceVocabulary: { unmeasured: ABSENCE_UNMEASURED, notModelled: ABSENCE_NOT_MODELLED },
    notModelled: NOT_MODELLED,
  }
}

/* ── 1. 多源事实时间线 ──────────────────────────────────────────────────────── */

/**
 * The three fact sources, raw rows, no aggregation and no unit conversion.
 *
 * ABA is keyed one row per period; ads are one row per period **per file**
 * (overlapping aggregate and raw exports both count); competitor facts are one
 * row per (ASIN, source). `counts` is what the timeline header prints, and it is
 * read from these very rows — a separate COUNT would be a second answer.
 */
function readTimeline(store, { word, market }) {
  const aba = store.all(
    `SELECT period, report_date, score, search_volume, total_impressions, brand_impressions,
            brand_impression_pct, total_clicks, brand_clicks, brand_click_pct, total_purchases,
            brand_purchases, brand_conv_pct, cvr_pct, source_file, imported_at
       FROM kw_aba_fact
      WHERE keyword = ? AND marketplace = ?
      ORDER BY period DESC, source_file`,
    [word, market],
  )
  const ad = store.all(
    `SELECT period, source_file, impressions, clicks, orders, spend, sales, first_date, last_date, imported_at
       FROM kw_ad_fact
      WHERE keyword = ? AND marketplace = ?
      ORDER BY period DESC, source_file`,
    [word, market],
  )
  const competitor = store.all(
    `SELECT asin, source_id, organic_rank, ad_rank, collected_at, source_file,
            monthly_volume, weekly_searches, cpc, difficulty, imported_at
       FROM kw_competitor_fact
      WHERE keyword = ? AND marketplace = ?
      ORDER BY organic_rank IS NULL, organic_rank ASC, asin ASC, source_id ASC`,
    [word, market],
  )
  return {
    counts: { aba: aba.length, ad: ad.length, competitor: competitor.length, total: aba.length + ad.length + competitor.length },
    aba: aba.map(row => ({
      period: row.period,
      reportDate: row.report_date ?? null,
      score: num(row.score),
      searchVolume: num(row.search_volume),
      totalImpressions: num(row.total_impressions),
      brandImpressions: num(row.brand_impressions),
      brandImpressionPct: num(row.brand_impression_pct),
      totalClicks: num(row.total_clicks),
      brandClicks: num(row.brand_clicks),
      brandClickPct: num(row.brand_click_pct),
      totalPurchases: num(row.total_purchases),
      brandPurchases: num(row.brand_purchases),
      brandConvPct: num(row.brand_conv_pct),
      cvrPct: num(row.cvr_pct),
      sourceFile: row.source_file,
      importedAt: row.imported_at,
    })),
    ad: ad.map(row => ({
      period: row.period,
      sourceFile: row.source_file,
      impressions: num(row.impressions),
      clicks: num(row.clicks),
      orders: num(row.orders),
      spend: num(row.spend),
      sales: num(row.sales),
      firstDate: row.first_date ?? null,
      lastDate: row.last_date ?? null,
      importedAt: row.imported_at,
    })),
    competitor: competitor.map(row => ({
      asin: row.asin,
      sourceId: row.source_id,
      organicRank: num(row.organic_rank),
      adRank: num(row.ad_rank),
      collectedAt: row.collected_at ?? null,
      sourceFile: row.source_file,
      monthlyVolume: num(row.monthly_volume),
      weeklySearches: num(row.weekly_searches),
      cpc: num(row.cpc),
      difficulty: num(row.difficulty),
      importedAt: row.imported_at,
    })),
  }
}

/* ── 2. 自有与竞品排名 ─────────────────────────────────────────────────────── */

/**
 * Competitor ranks come from `kw_master` (the ≤20 ranked pairs) plus the full
 * per-ASIN detail in `kw_competitor_fact`. Own rank is **ASIN-scoped** and lives
 * in `asin_keyword`; `kw_master` has no own-rank column, so with no ASIN
 * selected this reads 需选定 ASIN — never 0 and never blank.
 */
function readRank(store, { word, market, ownAsin }) {
  const master = store.get(
    `SELECT competitor_best_rank, competitor_best_asin, competitor_ranked_count,
            competitor_absent_count, competitor_ranked_json
       FROM kw_master WHERE keyword = ? AND marketplace = ?`,
    [word, market],
  )
  const ranked = parseJson(master?.competitor_ranked_json, []) ?? []

  const own = { asin: ownAsin, needAsin: ownAsin === null, measured: false, rank: null, rows: [], absence: null }
  if (ownAsin === null) {
    own.absence = absent(ABSENCE_UNMEASURED, '需选定 ASIN',
      '自有排名按 ASIN 维度存在（asin_keyword.rank），kw_master 没有自有排名列 —— 选一个 ASIN 才能读。')
  } else {
    const rows = store.all(
      `SELECT source_id, rank, search_volume, collected_at
         FROM asin_keyword
        WHERE asin = ? AND marketplace = ? AND keyword = ?
        ORDER BY collected_at DESC, source_id ASC`,
      [ownAsin, market, word],
    )
    own.rows = rows.map(row => ({
      sourceId: row.source_id,
      rank: num(row.rank),
      searchVolume: num(row.search_volume),
      collectedAt: row.collected_at,
    }))
    /* 有排名的最好一条；都没有排名时 measured 仍为真（测过、没排名），
       这与「一条观测都没有」是两件事。 */
    const rankedRows = own.rows.filter(row => row.rank !== null)
    own.measured = own.rows.length > 0
    own.rank = rankedRows.length === 0
      ? null
      : rankedRows.reduce((best, row) => (best === null || row.rank < best ? row.rank : best), null)
    if (!own.measured) {
      own.absence = absent(ABSENCE_UNMEASURED, ABSENCE_UNMEASURED,
        '这个 ASIN 在该词下没有任何 asin_keyword 观测行。')
    }
  }

  return {
    competitor: {
      bestRank: num(master?.competitor_best_rank),
      bestAsin: master?.competitor_best_asin ?? null,
      rankedCount: num(master?.competitor_ranked_count) ?? 0,
      absentCount: num(master?.competitor_absent_count) ?? 0,
      ranked: ranked.map(entry => ({ asin: entry.asin ?? null, rank: num(entry.rank) })),
    },
    own,
  }
}

/* ── 3. 所有权与位置 ───────────────────────────────────────────────────────── */

function readOwnership(store, { word, market }) {
  /* `getKeywordOwnership` returns null when nobody has said anything — that is
     "no claim", not a conflict, and the renderer says so. */
  const row = getKeywordOwnership(store, { keyword: word, marketplace: market })
  if (row === null) return null
  return {
    owner: row.owner,
    conflicted: row.conflicted,
    conflictCount: row.conflictCount ?? row.claimCount ?? 0,
    claimCount: row.claimCount,
    candidates: row.candidates ?? [],
    claims: (row.claims ?? []).map(claim => ({
      asin: claim.asin,
      status: claim.status,
      locked: claim.locked === true,
      claimSource: claim.claimSource,
      claimedAt: claim.claimedAt,
      claimedBy: claim.claimedBy ?? null,
      releasedAt: claim.releasedAt ?? null,
      releasedReason: claim.releasedReason ?? null,
    })),
    conflictReasons: row.conflictReasons ?? [],
    conflictNotes: row.conflictNotes ?? [],
    suggestion: row.suggestion === null || row.suggestion === undefined ? null : {
      suggestedAsin: row.suggestion.suggestedAsin,
      reason: row.suggestion.reason ?? null,
      suggestedAt: row.suggestion.suggestedAt,
      adoptedAt: row.suggestion.adoptedAt ?? null,
      adoptedAsin: row.suggestion.adoptedAsin ?? null,
    },
  }
}

/**
 * Which plans contain this word, and in what position.
 *
 * ⚠️ No index serves this direction (see the file header): `keyword_plan_entry`'s
 * primary key and its only other index both lead with `plan_id`, so this is a
 * scan of the entry table filtered by `keyword_key`. The position stored here is
 * the **plan** (`owner_position`) — it is not `kw_master.for_listing_json`
 * (eligibility) and it is not actual coverage.
 */
function readPlans(store, { word }) {
  return store.all(
    `SELECT e.keyword, e.owner_position, e.tier, e.search_volume, e.support_json,
            p.id AS plan_id, p.asin, p.marketplace, p.name, p.version, p.status, p.lineage_id
       FROM keyword_plan_entry e
       JOIN keyword_plan p ON p.id = e.plan_id
      WHERE e.keyword_key = ?
      ORDER BY p.marketplace ASC, p.asin ASC, p.version DESC`,
    [word],
  ).map(row => ({
    planId: row.plan_id,
    lineageId: row.lineage_id,
    asin: row.asin,
    marketplace: row.marketplace,
    name: row.name ?? null,
    version: num(row.version),
    status: row.status,
    statusLabel: PLAN_STATUS_LABELS[row.status] ?? row.status,
    ownerPosition: row.owner_position,
    tier: row.tier ?? null,
    searchVolume: num(row.search_volume),
    supporting: (parseJson(row.support_json, []) ?? []).map(slot => ({
      position: slot.position ?? null,
      reason: slot.reason ?? null,
    })),
  }))
}

/* ── 4. 数据质量 ───────────────────────────────────────────────────────────── */

function readQuality(store, { word, market }) {
  /* The object key the whole quality module agrees on: `objectKey(keyword,
     marketplace)` = `keyword@SITE` (domain/data/quality-rules.js). */
  const objectId = `${word}@${market}`
  const issues = store.all(
    `SELECT rule_id, dimension, severity, status, field, message, detected_at
       FROM dq_issue
      WHERE object_type = 'keyword' AND object_id = ?
      ORDER BY detected_at DESC, rule_id`,
    [objectId],
  ).map(row => ({
    ruleId: row.rule_id,
    dimension: row.dimension,
    severity: row.severity,
    status: row.status,
    field: row.field ?? null,
    message: row.message,
    detectedAt: row.detected_at,
  }))
  return {
    objectId,
    issues,
    /* Only two of the nine rules ever target a keyword. An empty list here is
       "no rule flagged this word", NOT "this word is clean" — the note says so. */
    keywordRuleIds: [...KEYWORD_LEVEL_RULE_IDS],
    keywordRuleCount: KEYWORD_LEVEL_RULE_IDS.length,
    totalRuleCount: QUALITY_RULES.length,
    note: `数据质量共 ${QUALITY_RULES.length} 条规则，其中只有 ${KEYWORD_LEVEL_RULE_IDS.length} 条`
      + `（${KEYWORD_LEVEL_RULE_IDS.join(' / ')}）会产出关键词级问题；另外 `
      + `${QUALITY_RULES.length - KEYWORD_LEVEL_RULE_IDS.length} 条打的是 ASIN / Listing 级对象。`
      + '这里为空只代表「没有规则报过这个词」，不代表「这个词很干净」。',
  }
}

/* ── 5. 历史使用和效果 ─────────────────────────────────────────────────────── */

/**
 * What actually exists as history: the lifecycle event timeline and the
 * ownership event timeline. Both carry a time and a reason. What does **not**
 * exist — which of title / bullets / backend / ads the word landed in, and any
 * per-keyword effect — is named in `notModelled` (see the file header).
 */
function readHistory(store, { word, market }) {
  const lifecycle = getKeywordLifecycle(store, { keyword: word, marketplace: market })
  const lifecycleEvents = keywordLifecycleHistory(store, { keyword: word, marketplace: market }).map(event => ({
    fromStatus: event.from_status ?? null,
    toStatus: event.to_status,
    toLabel: KEYWORD_LIFECYCLE_LABELS[event.to_status] ?? event.to_status,
    reason: event.reason ?? null,
    source: event.source,
    publicationId: event.publication_id ?? null,
    at: event.at,
    by: event.by ?? null,
  }))
  const ownershipEvents = keywordOwnershipHistory(store, { keyword: word, marketplace: market }).map(event => ({
    action: event.action,
    asin: event.asin ?? null,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus ?? null,
    reason: event.reason ?? null,
    source: event.source,
    at: event.at,
    by: event.by ?? null,
  }))
  return {
    lifecycle: {
      current: lifecycle === null ? null : {
        status: lifecycle.status,
        label: KEYWORD_LIFECYCLE_LABELS[lifecycle.status] ?? lifecycle.status,
        reason: lifecycle.reason ?? null,
        source: lifecycle.source,
        changedAt: lifecycle.changed_at,
        changedBy: lifecycle.changed_by ?? null,
      },
      events: lifecycleEvents,
    },
    ownershipEvents,
    /* The publications the lifecycle events point at, so a reader can tell a
       real link from a free-text reason. */
    publicationIds: [...new Set(lifecycleEvents.map(event => event.publicationId).filter(id => id !== null))],
  }
}

/* ── 6. 原始变体与合并记录 ─────────────────────────────────────────────────── */

/**
 * Pre-fold spellings, from the one-off v15 archive — and **only** for the pairs
 * that were actually merged.
 *
 * `kw_master_case_merge_archive` was populated by the v15 migration (before the
 * case fold) with every row of every merged group, so it holds the raw
 * spellings. It is not a per-word variant history: the library deliberately
 * keeps no raw-variant column (`domain/keywords/key.js`: for a word written in
 * two spellings there is no non-arbitrary answer to "which one is the
 * original"). So a word that was never merged has **no** variant record **by
 * design** — that is not missing data.
 *
 * The lookup is `lower(keyword) = ?` because the v15 grouping folded by
 * `lower()` and the archive was left un-folded. Words that differed only in
 * inner whitespace were never merged by v15, so no whitespace collapsing is
 * needed here.
 */
function readVariants(store, { word, market }) {
  const rows = store.all(
    `SELECT keyword, merged_into, archived_at, updated_at
       FROM kw_master_case_merge_archive
      WHERE lower(keyword) = ? AND marketplace = ?
      ORDER BY archived_at, keyword`,
    [word, market],
  ).map(row => ({
    keyword: row.keyword,
    mergedInto: row.merged_into || null,
    archivedAt: row.archived_at || null,
    updatedAt: row.updated_at ?? null,
  }))
  return {
    rows,
    merged: rows.length > 0,
    note: rows.length > 0
      ? '这些是 v15 折叠前被合并的原始拼写（一次性归档，不是逐词变体历史）。'
      : '这个词没有合并记录 —— 库**刻意**不保留原始拼写列（两个拼写里哪个是「原件」没有非任意的答案），'
        + '没被合并过的词**按设计**就没有变体记录，不是数据缺失。',
  }
}

/* ── the master row subset ─────────────────────────────────────────────────── */

function readMasterRow(store, { word, market }) {
  const row = store.get(
    `SELECT keyword, marketplace, search_volume, search_volume_source, sv_tier, sv_tier_label,
            funnel, priority, opportunity, product_line, product_line_matched,
            sources_json, updated_at
       FROM kw_master WHERE keyword = ? AND marketplace = ?`,
    [word, market],
  )
  if (row === undefined || row === null) return null
  return {
    keyword: row.keyword,
    marketplace: row.marketplace,
    searchVolume: num(row.search_volume),
    searchVolumeSource: row.search_volume_source ?? null,
    svTier: row.sv_tier ?? null,
    svTierLabel: row.sv_tier_label ?? null,
    funnel: row.funnel ?? null,
    priority: row.priority ?? null,
    opportunity: row.opportunity ?? null,
    productLine: row.product_line ?? null,
    productLineMatched: row.product_line_matched ?? null,
    sources: parseJson(row.sources_json, []) ?? [],
    updatedAt: row.updated_at ?? null,
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}
