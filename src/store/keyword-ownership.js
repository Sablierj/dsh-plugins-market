/**
 * Persistence for keyword ownership (schema v34, module 08 F08-04).
 *
 * ## What this object is, and what it is not
 *
 * A row in `keyword_ownership` is a **claim**: "this ASIN claims this keyword".
 * Two names in this repo look like it and are not:
 *
 *   - `asin_ownership` — *whose ASIN is this* (ASIN → product_line / brand /
 *     shop / side). Nothing to do with keywords.
 *   - `field_conflict` — several sources disagree about one **ASIN field**
 *     (price / title / bsr). A different object again.
 *
 * The boundary is written down here because "two numbers are both 14, so they
 * are aligned" is exactly the counting mistake the audit report (§4.5) says has
 * hidden a gap in this repo before.
 *
 * ## The owner and the conflict are derived, never stored
 *
 * The owner of a word is the **single** active claim (`status = 'claimed'`).
 * A conflict is **two or more** active claims. Neither is a column, on purpose:
 * a stored `conflict` flag would drift from the facts the first time a claim is
 * released, and nothing would throw. The view recomputes both from the claims
 * every time it is read.
 *
 * ## Releasing does not delete
 *
 * Following `asin_ownership.retracted_at` (whose comment says 「人工撤销置位；
 * **不删行**」), a release sets `released_at` + `released_reason` and keeps the row.
 * Re-claiming upserts the same row back to `claimed`. The full story — claimed,
 * released, claimed again — lives in `keyword_ownership_event`, which is
 * append-only.
 *
 * ## Preview and execution are one function, not two
 *
 * `previewKeywordOwnershipBatch` and `applyKeywordOwnershipBatch` both call the
 * private `runBatch(store, opts, dryRun)`. The preview runs it inside a
 * transaction and then **rolls the transaction back** by throwing a private
 * `DryRun` sentinel. That is the only way the preview's "直接 N 词 / 牵连 M 词 /
 * 解除 K 起冲突" and the execution's numbers are guaranteed equal: they are not
 * two implementations that have to be kept in step — they are one. Two copies
 * would drift, and the drift would look like "the preview said 3, the write
 * changed 24".
 *
 * ## The active-run gate
 *
 * A batch that touches ASINs which have a **running** optimization run is
 * refused unless the caller passes `confirmed: true`. The preview never refuses
 * — reporting the affected runs is what the preview is for. When the write does
 * go through, the confirmation and the run list are recorded on every event row
 * (`confirmed` / `impact_json`), because the audit question is "what did the
 * operator see and confirm", not "was a box ticked".
 *
 *   ⚠️ `optimization_run.status` has four values — `running` / `done` /
 *   `failed` / `abandoned` (`OPTIMIZATION_RUN_STATUSES`, domain/states.js). It
 *   has **no** `waiting_human`; that value belongs to `agent_run` and the
 *   observation cards. So 「运行中 / 待人工」 reduces to `running` here, and the
 *   prototype's 「将被标记『位置计划已变化』」 is **not** written — and the honest
 *   reason is a **data** one, not a missing table: the position plan tables exist
 *   (schema v35 migration `keyword-plan`, requirement F08-05), this library just has
 *   no stored plan to compare against (`keywordPlanNotes` says so out loud). This
 *   batch only lists, requires confirmation, and leaves a trace.
 */

import { randomUUID } from 'node:crypto'

import { keywordKey } from '../domain/keywords/key.js'
import { KEYWORD_OWNERSHIP_CLAIM_SOURCES, KEYWORD_OWNERSHIP_STATUSES } from '../domain/states.js'
import { nowIso } from './db.js'
/* 「生效的变体边」的判据（T-8 缺陷 2）：与列表页 SQL、变体页检测同一条。 */
import { ACTIVE_VARIANT_RELATION_STATUS } from './variant-status.js'

/* ── input normalisation ─────────────────────────────────────────────────────
   The same rulers `keyword-lifecycle.js` uses, so the two tables fold the same
   way and a lookup cannot miss because one side lower-cased and the other did
   not. */

function keywordOf(value) {
  const keyword = keywordKey(value)
  if (keyword === '') throw new Error('keyword is required')
  return keyword
}

function marketplaceOf(value) {
  const marketplace = String(value ?? '').trim().toUpperCase()
  if (marketplace === '') throw new Error('marketplace is required')
  return marketplace
}

function asinOf(value) {
  const asin = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new Error(`asin "${value}" is not a 10-character ASIN`)
  }
  return asin
}

function sourceOf(value) {
  const source = String(value ?? 'manual').trim() || 'manual'
  if (!KEYWORD_OWNERSHIP_CLAIM_SOURCES.includes(source)) {
    throw new Error(`source "${value}" is not one of ${KEYWORD_OWNERSHIP_CLAIM_SOURCES.join(' / ')}`)
  }
  return source
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
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

/* ── row hydration ─────────────────────────────────────────────────────────── */

function hydrateClaim(row) {
  /* Fail closed on an unknown status. The owner is *derived* by comparing
     `status === 'claimed'`; a row whose status fell outside the vocabulary
     would silently read as "not the owner" and the word would look unowned
     instead of broken. The vocabulary lives in states.js so the read path and
     the label path cannot disagree about what a status means. */
  if (!KEYWORD_OWNERSHIP_STATUSES.includes(row.status)) {
    throw new Error(
      `keyword_ownership row ${row.id} has status "${row.status}", `
      + `not one of ${KEYWORD_OWNERSHIP_STATUSES.join(' / ')}`,
    )
  }
  return {
    id: row.id,
    keyword: row.keyword,
    marketplace: row.marketplace,
    asin: row.asin,
    status: row.status,
    locked: row.locked === 1,
    claimSource: row.claim_source,
    evidence: parseJson(row.evidence_json, null),
    claimedAt: row.claimed_at,
    claimedBy: row.claimed_by ?? null,
    releasedAt: row.released_at ?? null,
    releasedReason: row.released_reason ?? null,
    createdAt: row.created_at,
  }
}

function hydrateSuggestion(row) {
  if (row === undefined || row === null) return null
  return {
    keyword: row.keyword,
    marketplace: row.marketplace,
    suggestedAsin: row.suggested_asin,
    reason: row.reason ?? null,
    evidence: parseJson(row.evidence_json, null),
    suggestedAt: row.suggested_at,
    suggestedBy: row.suggested_by ?? null,
    adoptedAt: row.adopted_at ?? null,
    adoptedAsin: row.adopted_asin ?? null,
  }
}

function hydrateEvent(row) {
  return {
    id: row.id,
    keyword: row.keyword,
    marketplace: row.marketplace,
    asin: row.asin ?? null,
    action: row.action,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status ?? null,
    reason: row.reason ?? null,
    source: row.source,
    evidence: parseJson(row.evidence_json, null),
    confirmed: row.confirmed === 1,
    impact: parseJson(row.impact_json, null),
    at: row.at,
    by: row.by ?? null,
  }
}

/* ── the conflict derivation ─────────────────────────────────────────────────
   One function, used by the view, the stats, the batch's before/after count and
   the header badge. If the badge and the table could disagree about whether a
   word is conflicted, the badge would be worse than useless. */

/** The ASIN's product line, from `asin`, falling back to its product_line ownership. */
function asinProductLine(store, { asin, marketplace }) {
  const row = store.get('SELECT product_line_id FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace])
  if (row !== undefined && row.product_line_id !== null && row.product_line_id !== undefined) return row.product_line_id
  const owned = store.get(
    `SELECT object_id FROM asin_ownership
      WHERE asin = ? AND marketplace = ? AND object_type = 'product_line' AND retracted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [asin, marketplace],
  )
  return owned === undefined ? null : owned.object_id
}

/** The keyword's product line, from the master library. `null` when unknown. */
function keywordProductLine(store, { keyword, marketplace }) {
  const row = store.get('SELECT product_line FROM kw_master WHERE keyword = ? AND marketplace = ?', [keyword, marketplace])
  return row === undefined ? null : (row.product_line ?? null)
}

/**
 * Why this word is in conflict, derived **only** from data that is really there.
 *
 * Two reasons can be derived today:
 *
 *   1. Two or more active claims.
 *   2. An active claim whose ASIN belongs to a different product line than the
 *      word (both sides must be known; a missing product line derives nothing).
 *
 * 「变体共用五点导致重复占位」 is deliberately **not** derived — `conflictNotesFor`
 * says why in words, and `variantRelationCoverage` is what it reads to say it.
 * Inventing the reason would be a guess dressed as a fact.
 *
 *   ⚠️ T-8 (2026-10-13): this used to claim the variant relationship table did
 *   not exist. That claim was **false** — `asin_variant_relation` has existed since
 *   schema v37 (`asin-datacenter`, now v45). What is actually true on this machine
 *   is that the table exists and **the library has zero relations in it**: the real
 *   DB `data/amazon-ops.db` has 0 rows in all three variant tables. So the honest
 *   sentence is 「表存在，但本库还没有这条关系」 = **no data**, which is a different
 *   statement from both 「没建模」 (not modelled) and 「数据是 0」 (a measured zero —
 *   a zero you could only have measured by reading something).
 */
export function conflictReasonsFor(store, { keyword, marketplace, activeClaims }) {
  const reasons = []
  if (activeClaims.length >= 2) {
    reasons.push(`双 ASIN 同时认领（同一词下 ${activeClaims.length} 条生效主张）`)
  }
  const kwLine = keywordProductLine(store, { keyword, marketplace })
  if (kwLine !== null) {
    for (const claim of activeClaims) {
      const line = asinProductLine(store, { asin: claim.asin, marketplace })
      if (line !== null && line !== kwLine) {
        reasons.push(`跨产品线误认领（${claim.asin} 属于 ${line}，本词属于 ${kwLine}）`)
      }
    }
  }
  return [...new Set(reasons)]
}

/**
 * 「变体关系」这一层**今天到底有什么**：表在不在、这个站点有多少条边。
 *
 * 这个函数存在的理由是 T-8 缺陷 1：修复前那句把这层说成「表不存在（F05-06 缺失）」
 * 是一句写死的假话，而 `asin_variant_relation` 从 schema v37 起就在。
 *
 * 三个数分开读，因为它们回答三个不同的问题：
 *
 *   · `activeRelations` —— 生效的边（与列表页 / 变体页**同一条判据**，T-8 缺陷 2）；
 *   · `correctedRelations` —— 被纠正过的边：那是历史，不是现状；
 *   · `dimensions` / `events` —— 维度值与事件历史。一条边可以没有维度、没有事件，
 *     所以「有没有这条关系」看的是前面两个数，不是这两个。
 *
 * ## 「没有数据」与「数据是 0」的区别就是在这里被保住的
 *
 * 三个数都是 `COUNT(*)`，所以 **0 是测出来的 0**：它来自一次成功的查询，不是一个
 * 兜底默认值。而「这个站点还没有任何生效边」这句话成立时，本函数给出
 * `noData: true` —— 于是调用方可以说「本库还没有这条关系」，
 * 而不是说「表未建」（假），也不是说「共用五点确实没重复」（把「没数据」当结论）。
 *
 * 查不出来（表被删 / 查询失败）与查到 0 条是两件事：前一种**抛**，让调用方去说
 * 「这一次没读出来」，绝不在这里 `?? 0` 折成一个看起来正常的 0。
 */
export function variantRelationCoverage(store, { marketplace = null } = {}) {
  /* 子句数组 + 一个拼 WHERE 的小工具：四个 COUNT 的筛选条件长得不一样，
     而「WHERE 只有一个条件时不要写成 AND」这种事最容易在各写一遍时出错 ——
     写错了不会抛，只会静默返回一个看起来正常的数。 */
  const base = []
  const baseParams = []
  if (blankToNull(marketplace) !== null) { base.push('marketplace = ?'); baseParams.push(marketplaceOf(marketplace)) }
  const whereOf = clauses => (clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`)

  const statusClauses = [...base, 'status = ?']
  const otherStatusClauses = [...base, 'status <> ?']
  const active = store.get(
    `SELECT COUNT(*) AS n FROM asin_variant_relation${whereOf(statusClauses)}`,
    [...baseParams, ACTIVE_VARIANT_RELATION_STATUS],
  )?.n ?? 0
  const corrected = store.get(
    `SELECT COUNT(*) AS n FROM asin_variant_relation${whereOf(otherStatusClauses)}`,
    [...baseParams, ACTIVE_VARIANT_RELATION_STATUS],
  )?.n ?? 0
  const dimensions = store.get(
    `SELECT COUNT(*) AS n FROM asin_variant_dimension${whereOf(base)}`,
    baseParams,
  )?.n ?? 0
  const events = store.get(
    `SELECT COUNT(*) AS n FROM asin_variant_relation_event e`
      + ' JOIN asin_variant_relation r ON r.id = e.relation_id'
      + whereOf(base.map(clause => `r.${clause}`)),
    baseParams,
  )?.n ?? 0

  return {
    marketplace: blankToNull(marketplace) === null ? null : marketplaceOf(marketplace),
    activeRelations: active,
    correctedRelations: corrected,
    dimensions,
    events,
    /* 「一条生效的边都没有」是**读出来**的结论（上面那次 COUNT 成功），不是兜底。 */
    noData: active === 0,
  }
}

/**
 * The reasons that cannot be judged, said out loud rather than left blank.
 *
 * 这句话是**读出来的**，不是写死的：它先说清表在（它的名字与「谁写的」），再说清
 * 本库里有没有边。修复前这里（以及工具描述、页面提示里的另外两份拷贝）写的是一句
 * 关于**代码**的断言（「表未建」），而今天的事实是「有表、没有数据」——
 * 前者会让读的人 / Agent 以为这个能力还没做，后者才是它们需要知道的。
 *
 * 三种状态分开说，与本仓「没测到 ≠ 没有」的同一条纪律：
 *   · `noData` 为真 —— 表在、判据在，但本库还没有这条关系，所以**还判不出来**；
 *   · 有生效边 —— 判据可以跑了，但「共用五点」还要看到文案才谈得上重复占位；
 *   · 读不出来 —— 这一句会带着错误文本（由调用方 `try/catch`），不折成上面两种。
 */
export function conflictNotesFor(store, { marketplace = null } = {}) {
  const coverage = variantRelationCoverage(store, { marketplace })
  return [
    '「变体共用五点导致重复占位」目前判不出来：变体关系表存在'
      + '（asin_variant_relation，schema v37 建），本系统也已经按它推导「生效的边」；'
      + '但本库还没有这条关系，所以没有可判的对象 —— 这是「没有数据」，不是「数据是 0」，'
      + '也不是「这个能力没建」。',
    `实测：本库生效边 ${coverage.activeRelations} 条、被纠正的边 ${coverage.correctedRelations} 条、`
      + `维度值 ${coverage.dimensions} 条、事件 ${coverage.events} 条`
      + `（${coverage.marketplace === null ? '全部站点' : coverage.marketplace}）。`
      + '边由 amzn_asin_variant_upsert 写入（store/variant.js 是唯一写入口），'
      + '采集层还没有直连写入 —— 所以「0 条」是「还没写进来」，不是「查不到」。',
    '本系统不猜：要让这条判据能回答，先有边（谁是父体、谁是子体），再有子体的五点文案 —— '
      + '那时「共用五点」才是可比的。',
  ]
}

/**
 * 「位置计划」这一层**今天到底有什么**：表在不在、这个站点有多少版计划。
 *
 * 同一个形状的第二例（缺陷 1 是变体关系那一层）：修复前 `tools/kw-ownership.js` 两处
 * 把这一层说成「表不存在」（措辞里还带了一个**错的编号**），而
 * `keyword_plan` / `keyword_plan_entry` 从
 * **schema v35**（迁移名 `keyword-plan`，需求 **F08-05**）就在 —— `web/routes.js` 的
 * 总库切片早就在用 `listPlans` 读它。
 *
 *   ⚠️ 旧句里那个编号（F05-08）也是错的：**F05-08 是「ASIN 归档与恢复」**（T-5，schema v46）。
 *   位置计划是 **F08-05**。一句话里错两处（表在不在、编号是谁）—— 所以这里按
 *   schema 迁移名与表名说话，不引用一个可能记错的编号。
 *   ⚠️ 本注释**不复述那句旧话的原文**：被注释引用的旧话会让源码级 grep 守卫分不清
 *   「它回来了」与「只是在讲历史」。
 *
 * 三个数都是 `COUNT(*)` ⇒ **0 是测出来的 0**；`noData` 为真时调用方说
 * 「表存在，但本库还没有计划」，不说「表未建」，也不说「位置计划已变化一定不会发生」。
 * 查不出来会抛，不在这里 `?? 0` 折成一个看起来正常的 0。
 */
export function keywordPlanCoverage(store, { marketplace = null } = {}) {
  const market = blankToNull(marketplace) === null ? null : marketplaceOf(marketplace)
  const clauses = market === null ? [] : ['marketplace = ?']
  const params = market === null ? [] : [market]
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`

  const plans = store.get(`SELECT COUNT(*) AS n FROM keyword_plan${where}`, params)?.n ?? 0
  const entries = store.get(
    'SELECT COUNT(*) AS n FROM keyword_plan_entry e'
      + ' JOIN keyword_plan p ON p.id = e.plan_id'
      + (market === null ? '' : ' WHERE p.marketplace = ?'),
    params,
  )?.n ?? 0

  return {
    marketplace: market,
    plans,
    entries,
    /* 「一版计划都没有」是**读出来**的结论（上面那次 COUNT 成功），不是兜底。 */
    noData: plans === 0,
  }
}

/**
 * 「位置计划」那一条的说明：**从库里读出来**，不是写死的（与 `conflictNotesFor` 同一条纪律）。
 *
 * 它回答的是「为什么本系统只做『列出 + 要求确认 + 留痕』，不标记『位置计划已变化』」：
 * 判据要拿**当前那一版计划**去和运行中那批词比对，而本库还没有任何一版。
 * ⚠️ 这不是「位置计划一定不会变化」——那是拿「没数据」当结论；表在，写入口在
 * （`amzn_keyword_plan_save` / `savePlan`），缺的只是**这一版数据**。
 */
export function keywordPlanNotes(store, { marketplace = null } = {}) {
  const coverage = keywordPlanCoverage(store, { marketplace })
  return [
    /* 2026-10-25（R-42）：这一段原来是**写死**的「但本库还没有任何一版计划」，
       而紧跟着下一行就是**动态实测**「本库计划 N 版、条目 M 条」。
       第 89 轮存了第一版之后，同一段输出变成了：
         「…但本库还没有任何一版计划 —— 没有可比对的计划」
         「实测：本库计划 1 版、条目 16 条」
       **两句自相矛盾，而且在同一屏里。** 前半句是模板、后半句是实测 ——
       模板不随数据变，于是数据一变它就变成假话。

       这正是今天出现了一整天的那个主题：**静态的话 vs 动态的事实**。 */
    coverage.plans > 0
      ? '「位置计划已变化」不标记：位置计划表存在（keyword_plan / keyword_plan_entry，'
        + 'schema v35 迁移 `keyword-plan` 建，需求 F08-05），本库**已有 '
        + `${coverage.plans} 版计划** —— owner 仍只做「列出 + 要求确认 + 留痕」，`
        + '不自动标记「位置计划已变化」：那需要拿**当前那一版**去和运行中那批词逐个比对，'
        + '而本仓没有这条比对通道。'
      : '「位置计划已变化」不标记：位置计划表存在（keyword_plan / keyword_plan_entry，'
        + 'schema v35 迁移 `keyword-plan` 建，需求 F08-05），但本库还没有任何一版计划 —— '
        + '没有可比对的计划，也就没有「变化」可言。这是「没有数据」，不是「表未建」，'
        + '也不是「位置计划一定不会变」。',
    `实测：本库计划 ${coverage.plans} 版、条目 ${coverage.entries} 条`
      + `（${coverage.marketplace === null ? '全部站点' : coverage.marketplace}）。`
      + '写入口是 amzn_keyword_plan_save（store/keyword-plan.js 的 savePlan，页面「存一版」'
      + '路由同一条）—— 所以「0 版」是「还没存过」，不是「查不到」。',
    '本系统不猜：要让这条判据能回答，先在 08 里存一版位置计划'
      + '（amzn_keyword_plan_propose → amzn_keyword_plan_save）。',
  ]
}

/* ── readers ───────────────────────────────────────────────────────────────── */

function claimsFor(store, { keyword, marketplace }) {
  return store
    .all(
      'SELECT * FROM keyword_ownership WHERE keyword = ? AND marketplace = ? ORDER BY asin ASC',
      [keyword, marketplace],
    )
    .map(hydrateClaim)
}

function activeClaimsOf(claims) {
  return claims.filter(claim => claim.status === 'claimed')
}

/** One keyword's workbench row, from its claims and suggestion. */
function buildRow(store, { keyword, marketplace, claims, suggestion }) {
  const active = activeClaimsOf(claims)
  const conflictReasons = conflictReasonsFor(store, { keyword, marketplace, activeClaims: active })
  return {
    keyword,
    marketplace,
    claimCount: active.length,
    candidates: active.map(claim => claim.asin),
    claims,
    /* The owner is the single active claim. Zero claims → nobody; two or more →
       undecided (and `conflicted` is what says which of the two it is). */
    owner: active.length === 1 ? active[0].asin : null,
    conflicted: conflictReasons.length > 0,
    conflictReasons,
    conflictNotes: conflictNotesFor(store, { marketplace }),
    suggestion,
  }
}

/**
 * The workbench view: one row per word that has **any** claim or suggestion.
 *
 * A word with neither is not a row — it is not a conflict, and listing every
 * master word here would make the workbench a second copy of the master table.
 */
export function keywordOwnershipView(store, { marketplace = null, keyword = null, limit = 200 } = {}) {
  const market = blankToNull(marketplace) === null ? null : marketplaceOf(marketplace)
  const key = blankToNull(keyword) === null ? null : keywordOf(keyword)
  const rows = collectRows(store, { marketplace: market, keyword: key })
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000)
  /* 顶层的 `notes` 与每行的 `conflictNotes` 是**同一份**推导（同一个函数、同一批
     计数），只是位置不同：表格印在行上，提示行（页面 / 工具）印在整块上。
     两份措辞就是「一条规则两份实现」，所以页面读的是这一份（T-8 缺陷 1 的第三处
     拷贝在 page.js 里被删掉后，改由这里带出去）。 */
  return { rows: rows.slice(0, cap), stats: statsFrom(rows, market), notes: conflictNotesFor(store, { marketplace: market }) }
}

/** Every word with a claim or a suggestion, as workbench rows. */
function collectRows(store, { marketplace, keyword }) {
  const where = []
  const params = []
  if (marketplace !== null) { where.push('marketplace = ?'); params.push(marketplace) }
  if (keyword !== null) { where.push('keyword = ?'); params.push(keyword) }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const claims = store
    .all(`SELECT * FROM keyword_ownership ${clause} ORDER BY keyword ASC, asin ASC`, params)
    .map(hydrateClaim)
  const suggestions = store
    .all(`SELECT * FROM keyword_ownership_suggestion ${clause}`, params)
    .map(hydrateSuggestion)

  const keys = new Map()
  for (const claim of claims) keys.set(`${claim.keyword}@${claim.marketplace}`, { keyword: claim.keyword, marketplace: claim.marketplace })
  for (const suggestion of suggestions) keys.set(`${suggestion.keyword}@${suggestion.marketplace}`, { keyword: suggestion.keyword, marketplace: suggestion.marketplace })

  const ordered = [...keys.values()].sort((a, b) => (a.keyword === b.keyword ? a.marketplace.localeCompare(b.marketplace) : a.keyword.localeCompare(b.keyword)))
  return ordered.map(({ keyword: word, marketplace: market }) => buildRow(store, {
    keyword: word,
    marketplace: market,
    claims: claims.filter(claim => claim.keyword === word && claim.marketplace === market),
    suggestion: suggestions.find(entry => entry.keyword === word && entry.marketplace === market) ?? null,
  }))
}

/** One word's workbench row, or `null` when nobody has said anything about it. */
export function getKeywordOwnership(store, { keyword, marketplace } = {}) {
  const word = keywordOf(keyword)
  const market = marketplaceOf(marketplace)
  const claims = claimsFor(store, { keyword: word, marketplace: market })
  const suggestion = getOwnershipSuggestion(store, { keyword: word, marketplace: market })
  if (claims.length === 0 && suggestion === null) return null
  return buildRow(store, { keyword: word, marketplace: market, claims, suggestion })
}

/** Counts for the page header badge, derived from the same rows the table draws. */
export function keywordOwnershipStats(store, { marketplace = null } = {}) {
  const market = blankToNull(marketplace) === null ? null : marketplaceOf(marketplace)
  return statsFrom(collectRows(store, { marketplace: market, keyword: null }), market)
}

function statsFrom(rows, marketplace) {
  let claimed = 0
  let conflicted = 0
  let suggestions = 0
  let adopted = 0
  for (const row of rows) {
    if (row.claimCount > 0) claimed += 1
    if (row.conflicted) conflicted += 1
    if (row.suggestion !== null) {
      suggestions += 1
      if (row.suggestion.adoptedAt !== null) adopted += 1
    }
  }
  return {
    marketplace,
    total: rows.length,
    claimed,
    conflicted,
    suggestions,
    adopted,
    pendingSuggestions: suggestions - adopted,
  }
}

/** The full history for one word, oldest first — the order a timeline is read in. */
export function keywordOwnershipHistory(store, { keyword, marketplace } = {}) {
  return store
    .all(
      `SELECT * FROM keyword_ownership_event
        WHERE keyword = ? AND marketplace = ?
        ORDER BY at ASC, rowid ASC`,
      [keywordOf(keyword), marketplaceOf(marketplace)],
    )
    .map(hydrateEvent)
}

/** The current suggestion for one word, or `null`. Used as an audit `readBefore`. */
export function getOwnershipSuggestion(store, { keyword, marketplace } = {}) {
  const row = store.get(
    'SELECT * FROM keyword_ownership_suggestion WHERE keyword = ? AND marketplace = ?',
    [keywordOf(keyword), marketplaceOf(marketplace)],
  )
  return hydrateSuggestion(row)
}

/**
 * A `Map<keyword, {owner, conflicted, conflictCount, candidates, claimCount}>`
 * for the master table's 主人 column.
 *
 * Reads the same rows the workbench does (`collectRows`), so the column and the
 * workbench cannot disagree about who owns a word.
 */
export function ownershipForKeywords(store, { marketplace, keywords } = {}) {
  const market = blankToNull(marketplace) === null ? null : marketplaceOf(marketplace)
  const wanted = new Set((Array.isArray(keywords) ? keywords : []).map(entry => keywordKey(entry)).filter(entry => entry !== ''))
  const map = new Map()
  if (wanted.size === 0) return map
  for (const row of collectRows(store, { marketplace: market, keyword: null })) {
    if (!wanted.has(row.keyword)) continue
    map.set(row.keyword, {
      owner: row.owner,
      conflicted: row.conflicted,
      conflictCount: row.conflicted ? row.claimCount : 0,
      claimCount: row.claimCount,
      candidates: row.candidates,
    })
  }
  return map
}

/* ── §22.6: a competitor brand word cannot be owned by our own listing ────────
 *
 * The signal is real and data-driven, and it is this:
 *
 *   - a **competitor brand** is a `brand` row with `is_own = 0`; its `name` and
 *     its `aliases_json` are the strings a keyword would contain.
 *   - an ASIN is **ours** when `asin_ownership` holds a live `side = 'self'` row
 *     for it, or when `asin.brand` matches a brand with `is_own = 1`.
 *
 * The rule: when the target ASIN is ours and the keyword contains a competitor
 * brand string, the claim is refused. When the library has no competitor brand
 * (or nothing is marked as ours), the rule cannot fire — that is "there is no
 * signal to judge by", and the tool text says so rather than implying the check
 * passed.
 *
 * Matching is a substring test on the folded keyword, and only for brand strings
 * of two characters or more: a one-letter alias would match half the library.
 */

/** The competitor brand strings a keyword contains. Empty when there is no signal. */
export function competitorBrandHits(store, keyword) {
  const text = String(keyword ?? '').toLowerCase()
  if (text === '') return []
  const hits = []
  for (const row of store.all('SELECT name, aliases_json FROM brand WHERE is_own = 0')) {
    const candidates = [row.name, ...parseJson(row.aliases_json, [])]
      .filter(value => typeof value === 'string' && value.trim() !== '')
    for (const candidate of candidates) {
      const needle = candidate.trim().toLowerCase()
      if (needle.length >= 2 && text.includes(needle)) {
        hits.push({ brand: row.name, matched: candidate.trim() })
        break
      }
    }
  }
  return hits
}

/** Whether an ASIN is one of ours: a live `side=self` row, or a brand that is ours. */
export function isOwnAsin(store, { asin, marketplace } = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (key === '' || market === '') return false
  const side = store.get(
    `SELECT 1 AS ok FROM asin_ownership
      WHERE asin = ? AND marketplace = ? AND object_type = 'side' AND object_id = 'self' AND retracted_at IS NULL`,
    [key, market],
  )
  if (side !== undefined) return true
  const row = store.get('SELECT brand FROM asin WHERE asin = ? AND marketplace = ?', [key, market])
  if (row === undefined || row.brand === null || row.brand === undefined) return false
  const name = String(row.brand).trim().toLowerCase()
  if (name === '') return false
  for (const brand of store.all('SELECT name, aliases_json FROM brand WHERE is_own = 1')) {
    const candidates = [brand.name, ...parseJson(brand.aliases_json, [])]
    if (candidates.some(candidate => typeof candidate === 'string' && candidate.trim().toLowerCase() === name)) return true
  }
  return false
}

/* ── the event log ─────────────────────────────────────────────────────────── */

function appendEvent(store, entry) {
  const at = nowIso()
  store.run(
    `INSERT INTO keyword_ownership_event
       (id, keyword, marketplace, asin, action, from_status, to_status, reason, source,
        evidence_json, confirmed, impact_json, at, by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(), entry.keyword, entry.marketplace, entry.asin ?? null, entry.action,
      entry.fromStatus ?? null, entry.toStatus ?? null, entry.reason ?? null, entry.source,
      json(entry.evidence ?? null), entry.confirmed === true ? 1 : 0, json(entry.impact ?? null),
      at, entry.by ?? null,
    ],
  )
  return at
}

/* ── writes: one claim, one transition ─────────────────────────────────────── */

/**
 * Put a claim into `claimed`. Re-claiming a released row clears the release —
 * the release stays readable in the event log, which is where history belongs.
 */
function claimRow(store, { keyword, marketplace, asin, source, evidence, reason, confirmed, impact, by }) {
  const at = nowIso()
  const existing = store.get(
    'SELECT * FROM keyword_ownership WHERE keyword = ? AND marketplace = ? AND asin = ?',
    [keyword, marketplace, asin],
  )
  if (existing === undefined) {
    store.run(
      `INSERT INTO keyword_ownership
         (id, keyword, marketplace, asin, status, locked, claim_source, evidence_json,
          claimed_at, claimed_by, released_at, released_reason, created_at)
       VALUES (?, ?, ?, ?, 'claimed', 0, ?, ?, ?, ?, NULL, NULL, ?)`,
      [`own-${randomUUID()}`, keyword, marketplace, asin, source, json(evidence), at, by ?? null, at],
    )
  } else {
    store.run(
      `UPDATE keyword_ownership
          SET status = 'claimed', claim_source = ?, evidence_json = ?,
              claimed_at = ?, claimed_by = ?, released_at = NULL, released_reason = NULL
        WHERE keyword = ? AND marketplace = ? AND asin = ?`,
      [source, json(evidence), at, by ?? null, keyword, marketplace, asin],
    )
  }
  appendEvent(store, {
    keyword, marketplace, asin, action: 'claim',
    fromStatus: existing === undefined ? null : existing.status, toStatus: 'claimed',
    reason, source, evidence, confirmed, impact, by,
  })
  return { keyword, asin, from: existing === undefined ? null : existing.status, to: 'claimed', at }
}

/** Release a live claim. Never deletes: `released_at` + `released_reason` are set. */
function releaseRow(store, claim, { reason, source, confirmed, impact, by }) {
  const at = nowIso()
  store.run(
    `UPDATE keyword_ownership SET status = 'released', released_at = ?, released_reason = ?
      WHERE id = ?`,
    [at, reason ?? null, claim.id],
  )
  appendEvent(store, {
    keyword: claim.keyword, marketplace: claim.marketplace, asin: claim.asin,
    action: 'release', fromStatus: 'claimed', toStatus: 'released',
    reason, source, evidence: null, confirmed, impact, by,
  })
  return { keyword: claim.keyword, asin: claim.asin, from: 'claimed', to: 'released', at }
}

/** Lock or unlock one claim. A move to the state it is already in writes nothing. */
function lockRow(store, claim, locked, { reason, source, confirmed, impact, by }) {
  if (claim.locked === locked) return null
  store.run('UPDATE keyword_ownership SET locked = ? WHERE id = ?', [locked ? 1 : 0, claim.id])
  appendEvent(store, {
    keyword: claim.keyword, marketplace: claim.marketplace, asin: claim.asin,
    action: locked ? 'lock' : 'unlock', fromStatus: claim.status, toStatus: claim.status,
    reason, source, evidence: { locked }, confirmed, impact, by,
  })
  return { keyword: claim.keyword, asin: claim.asin, from: claim.locked ? 'locked' : 'unlocked', to: locked ? 'locked' : 'unlocked' }
}

/* ── writes: the suggestion and the adjudication ───────────────────────────── */

/** Refuse a word that is not in the master library — a claim on nothing is a lie. */
function assertInLibrary(store, { keyword, marketplace }) {
  const row = store.get('SELECT 1 AS ok FROM kw_master WHERE keyword = ? AND marketplace = ?', [keyword, marketplace])
  if (row === undefined) {
    throw new Error(`${keyword} is not in the ${marketplace} master library, so nothing can be claimed about it`)
  }
}

/**
 * Record an Agent suggestion for one word.
 *
 * One row per (keyword, marketplace): the row is "the current best judgement",
 * not a suggestion history — that is the event log. A new suggestion replaces
 * the old one *including its adoption mark*, because the adoption belonged to
 * the suggestion that was replaced; both are still in the event log.
 */
export function recordOwnershipSuggestion(store, { keyword, marketplace, suggestedAsin, reason = null, evidence = null, by = null } = {}) {
  const word = keywordOf(keyword)
  const market = marketplaceOf(marketplace)
  const asin = asinOf(suggestedAsin)
  assertInLibrary(store, { keyword: word, marketplace: market })

  return store.tx(() => {
    const at = nowIso()
    const existing = store.get(
      'SELECT * FROM keyword_ownership_suggestion WHERE keyword = ? AND marketplace = ?',
      [word, market],
    )
    if (existing === undefined) {
      store.run(
        `INSERT INTO keyword_ownership_suggestion
           (id, keyword, marketplace, suggested_asin, reason, evidence_json, suggested_at,
            suggested_by, adopted_at, adopted_asin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        [`ownsg-${randomUUID()}`, word, market, asin, blankToNull(reason), json(evidence), at, blankToNull(by)],
      )
    } else {
      store.run(
        `UPDATE keyword_ownership_suggestion
            SET suggested_asin = ?, reason = ?, evidence_json = ?, suggested_at = ?, suggested_by = ?,
                adopted_at = NULL, adopted_asin = NULL
          WHERE keyword = ? AND marketplace = ?`,
        [asin, blankToNull(reason), json(evidence), at, blankToNull(by), word, market],
      )
    }
    appendEvent(store, {
      keyword: word, marketplace: market, asin, action: 'suggest',
      reason, source: 'agent', evidence, by,
    })
    return { keyword: word, marketplace: market, suggestedAsin: asin, at }
  })
}

/**
 * Human adjudication — the first of §22.2's two exits from a conflict.
 *
 * Adopts one ASIN as the owner. With no explicit `asin` it adopts the pending
 * suggestion's; with one, it is a manual decision. Either way the other live
 * claims are **released, not deleted**, and the whole thing is one transaction
 * plus an `adopt` (or `claim`) event.
 *
 * The §22.6 competitor-brand rule and the lock rule are the same here as in the
 * batch: a locked word cannot be transferred, and a competitor brand word
 * cannot be owned by our own listing.
 */
export function resolveKeywordOwnership(store, { keyword, marketplace, asin = null, reason = null, by = null } = {}) {
  const word = keywordOf(keyword)
  const market = marketplaceOf(marketplace)
  assertInLibrary(store, { keyword: word, marketplace: market })

  return store.tx(() => {
    const suggestion = getOwnershipSuggestion(store, { keyword: word, marketplace: market })
    const explicit = blankToNull(asin) !== null
    const target = explicit ? asinOf(asin) : (suggestion === null ? null : suggestion.suggestedAsin)
    if (target === null) {
      throw new Error(`${word}@${market} 没有待采纳的建议，必须显式给出 asin —— 采纳一个不存在的建议等于没裁决`)
    }
    const adoptingSuggestion = suggestion !== null && suggestion.suggestedAsin === target

    const claims = claimsFor(store, { keyword: word, marketplace: market })
    const live = activeClaimsOf(claims)
    const lockedOther = live.filter(claim => claim.locked && claim.asin !== target)
    if (lockedOther.length > 0) {
      throw new Error(`${word} 已锁定给 ${lockedOther.map(claim => claim.asin).join(' / ')}，不能转移 —— 先显式解锁`)
    }
    if (isOwnAsin(store, { asin: target, marketplace: market })) {
      const hits = competitorBrandHits(store, word)
      if (hits.length > 0) {
        throw new Error(`竞品品牌词不能成为自有 Listing 的拥有词：${word} 命中竞品品牌 ${hits.map(hit => `${hit.brand}(${hit.matched})`).join('、')}，而 ${target} 是自有 ASIN`)
      }
    }

    const source = adoptingSuggestion ? 'agent' : 'manual'
    const at = nowIso()
    const changes = []
    for (const claim of live) {
      if (claim.asin === target) continue
      releaseRow(store, claim, { reason: reason ?? `采纳 ${target} 为唯一主人`, source, by })
      changes.push({ asin: claim.asin, from: 'claimed', to: 'released' })
    }
    const claim = claimRow(store, {
      keyword: word, marketplace: market, asin: target,
      source, evidence: suggestion === null ? null : suggestion.evidence, reason, by,
    })
    if (adoptingSuggestion) {
      store.run(
        'UPDATE keyword_ownership_suggestion SET adopted_at = ?, adopted_asin = ? WHERE keyword = ? AND marketplace = ?',
        [at, target, word, market],
      )
      appendEvent(store, {
        keyword: word, marketplace: market, asin: target, action: 'adopt',
        reason, source: 'manual', evidence: { suggestedAsin: suggestion.suggestedAsin }, by,
      })
    }
    return { keyword: word, marketplace: market, asin: target, claim, adopted: adoptingSuggestion, changes, at }
  })
}

/* ── the batch: one function for preview and execution ─────────────────────── */

const BATCH_ACTIONS = ['assign', 'release', 'lock', 'unlock', 'claim']

/** A private sentinel: thrown inside the preview transaction to force a ROLLBACK. */
class DryRun {
  constructor(impact) { this.impact = impact }
}

function uniqueFolded(list) {
  const seen = new Set()
  const out = []
  for (const entry of Array.isArray(list) ? list : []) {
    const key = keywordKey(entry)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function liveClaimsByKeyword(store, { marketplace, keywords }) {
  const map = new Map(keywords.map(keyword => [keyword, []]))
  if (keywords.length === 0) return map
  const rows = store.all(
    `SELECT * FROM keyword_ownership
      WHERE marketplace = ? AND status = 'claimed' AND keyword IN (${keywords.map(() => '?').join(',')})
      ORDER BY keyword ASC, asin ASC`,
    [marketplace, ...keywords],
  ).map(hydrateClaim)
  for (const row of rows) map.get(row.keyword)?.push(row)
  return map
}

function hasConflict(store, { keyword, marketplace }) {
  const claims = claimsFor(store, { keyword, marketplace })
  return conflictReasonsFor(store, { keyword, marketplace, activeClaims: activeClaimsOf(claims) }).length > 0
}

/** Other words that a set of ASINs claims — the honest blast radius, not a change list. */
function relatedKeywords(store, { marketplace, asins, exclude }) {
  if (asins.length === 0) return []
  const excludeSet = new Set(exclude)
  return store
    .all(
      `SELECT DISTINCT keyword FROM keyword_ownership
        WHERE marketplace = ? AND status = 'claimed' AND asin IN (${asins.map(() => '?').join(',')})`,
      [marketplace, ...asins],
    )
    .map(row => row.keyword)
    .filter(keyword => !excludeSet.has(keyword))
    .sort()
}

/**
 * The **running** optimization runs touching a set of ASINs.
 *
 * See the module header: `optimization_run` has no `waiting_human`; 「运行中/待人工」
 * is `running` here.
 */
export function activeOptimizationRuns(store, { marketplace, asins } = {}) {
  if (!Array.isArray(asins) || asins.length === 0) return []
  return store
    .all(
      `SELECT id, asin, marketplace, status, started_at FROM optimization_run
        WHERE status = 'running' AND marketplace = ? AND asin IN (${asins.map(() => '?').join(',')})
        ORDER BY started_at DESC, id ASC`,
      [marketplace, ...asins],
    )
    .map(row => ({ id: row.id, asin: row.asin, marketplace: row.marketplace, status: row.status, startedAt: row.started_at }))
}

/**
 * Validate, write, and measure a batch. `dryRun` only changes one thing: whether
 * the caller keeps the transaction.
 *
 * All refusals are all-or-nothing and happen before any write, so a refused
 * batch leaves the store untouched — which is what makes "a refusal is not a
 * change" true rather than merely intended.
 */
function runBatch(store, opts, dryRun) {
  const action = String(opts?.action ?? '').trim()
  if (!BATCH_ACTIONS.includes(action)) {
    throw new Error(`action "${opts?.action}" is not one of ${BATCH_ACTIONS.join(' / ')}`)
  }
  const market = marketplaceOf(opts?.marketplace)
  const keywords = uniqueFolded(opts?.keywords)
  if (keywords.length === 0) throw new Error('keywords must be a non-empty list')
  const source = sourceOf(opts?.source ?? 'manual')
  const reason = blankToNull(opts?.reason)
  const by = blankToNull(opts?.by)
  const confirmed = opts?.confirmed === true

  const targetAsin = (action === 'assign' || action === 'claim')
    ? asinOf(opts?.asin)
    : (blankToNull(opts?.asin) === null ? null : asinOf(opts.asin))

  /* 1. Every word must be in the master library — a typo must not look like a
        word that was already fine. */
  const missing = keywords.filter(keyword => store.get(
    'SELECT 1 AS ok FROM kw_master WHERE keyword = ? AND marketplace = ?', [keyword, market],
  ) === undefined)
  if (missing.length > 0) {
    throw new Error(`these keywords are not in the ${market} master library, so nothing was written: ${missing.join(', ')}`)
  }

  /* 2. §22.6 — a competitor brand word cannot be owned by our own listing. */
  if ((action === 'assign' || action === 'claim') && isOwnAsin(store, { asin: targetAsin, marketplace: market })) {
    const offenders = keywords
      .map(keyword => ({ keyword, hits: competitorBrandHits(store, keyword) }))
      .filter(entry => entry.hits.length > 0)
    if (offenders.length > 0) {
      throw new Error('竞品品牌词不能成为自有 Listing 的拥有词：'
        + offenders.map(entry => `${entry.keyword} 命中 ${entry.hits.map(hit => `${hit.brand}(${hit.matched})`).join('、')}`).join('；')
        + `，而 ${targetAsin} 是自有 ASIN`)
    }
  }

  /* 3. The lock rules — checked against the live claims, before anything is written. */
  const live = liveClaimsByKeyword(store, { marketplace: market, keywords })
  const offenders = []
  if (action === 'release') {
    for (const keyword of keywords) {
      const locked = live.get(keyword).filter(claim => claim.locked)
      if (locked.length > 0) offenders.push(`${keyword}（已锁定：${locked.map(claim => claim.asin).join('/')}）`)
    }
  }
  if (action === 'assign' || action === 'claim') {
    for (const keyword of keywords) {
      const lockedOther = live.get(keyword).filter(claim => claim.locked && claim.asin !== targetAsin)
      if (lockedOther.length > 0) offenders.push(`${keyword}（已锁定给 ${lockedOther.map(claim => claim.asin).join('/')}）`)
    }
  }
  if (action === 'lock' || action === 'unlock') {
    for (const keyword of keywords) {
      if (live.get(keyword).length === 0) offenders.push(keyword)
    }
  }
  if (offenders.length > 0) {
    throw new Error(action === 'release'
      ? `这些词的所有权已锁定，不能释放：${offenders.join('、')}`
      : (action === 'assign' || action === 'claim')
        ? `这些词已锁定给别的 ASIN，不能转移、也不能新增竞争认领：${offenders.join('、')}`
        : `这些词没有生效主张，${action === 'lock' ? '锁定' : '解锁'}一个不存在的主人没有意义：${offenders.join('、')}`)
  }

  /* 4. The before-state, used for the impact and for resolved/created conflicts. */
  const conflictsBefore = new Set(keywords.filter(keyword => hasConflict(store, { keyword, marketplace: market })))

  const affectedAsins = new Set()
  for (const keyword of keywords) for (const claim of live.get(keyword)) affectedAsins.add(claim.asin)
  if (targetAsin !== null) affectedAsins.add(targetAsin)
  const affected = [...affectedAsins].sort()
  const related = relatedKeywords(store, { marketplace: market, asins: affected, exclude: keywords })
  const activeRuns = activeOptimizationRuns(store, { marketplace: market, asins: affected })

  /* 5. The active-run gate. The preview never trips it; the write does. */
  if (!dryRun && activeRuns.length > 0 && !confirmed) {
    /* 这里原来把位置计划那层说成「表不存在」—— 也是同一个形状的假话（T-8）：
       表在（schema v35），缺的是**本库还没有一版计划**。原因由 `keywordPlanNotes`
       按真实读数给出，与工具输出、`renderImpact` 共用同一份措辞。
       ⚠️ 注释里**不复述那句旧话**：一句被注释引用的旧话，会让任何源码级 grep 守卫
       分不清「它回来了」与「只是在讲历史」（与 D9 那三处同一个道理）。 */
    throw new Error(
      `本次操作会影响 ${activeRuns.length} 个活跃优化运行（${activeRuns.map(run => run.id).join('、')}），`
      + '需要显式二次确认（confirmed: true）后才能执行。'
      + keywordPlanNotes(store, { marketplace: market })[0]
      + '所以本系统只做「列出 + 要求确认 + 留痕」，不会去标记「位置计划已变化」—— '
      + '那是原型示意，不是本批能诚实产出的东西。',
    )
  }

  /* 6. The writes. One event per claim, carrying what the operator confirmed. */
  const impact = { activeRuns, directCount: keywords.length, relatedCount: related.length, requiresConfirmation: activeRuns.length > 0 }
  const changes = []
  for (const keyword of keywords) {
    const claims = live.get(keyword)
    if (action === 'assign' || action === 'claim') {
      /* `assign` is adjudication: the target becomes the **only** owner, so the
         other live claims are released. `claim` is a plain claim: it adds one and
         touches nothing else — that is the path an Agent or an import takes
         before a human decides, and it is the only way a conflict can be created
         through the API (a conflict nobody can create is a feature nobody can
         reach). */
      if (action === 'assign') {
        for (const claim of claims) {
          if (claim.asin === targetAsin) continue
          releaseRow(store, claim, { reason: reason ?? `批量分配给 ${targetAsin}`, source, confirmed, impact, by })
          changes.push({ keyword, asin: claim.asin, from: 'claimed', to: 'released' })
        }
      }
      const existing = store.get(
        'SELECT * FROM keyword_ownership WHERE keyword = ? AND marketplace = ? AND asin = ?',
        [keyword, market, targetAsin],
      )
      if (existing !== undefined && existing.status === 'claimed') continue
      claimRow(store, {
        keyword, marketplace: market, asin: targetAsin, source,
        evidence: null, reason, confirmed, impact, by,
      })
      changes.push({ keyword, asin: targetAsin, from: existing === undefined ? null : existing.status, to: 'claimed' })
      continue
    }
    if (action === 'release') {
      const targets = targetAsin === null ? claims : claims.filter(claim => claim.asin === targetAsin)
      for (const claim of targets) {
        releaseRow(store, claim, { reason, source, confirmed, impact, by })
        changes.push({ keyword, asin: claim.asin, from: 'claimed', to: 'released' })
      }
      continue
    }
    /* lock / unlock — on the live claims for both; `unlock` cannot reach a claim
       that is already released, and there is nothing to unlock there anyway. */
    const locked = action === 'lock'
    for (const claim of claims) {
      const moved = lockRow(store, claim, locked, { reason, source, confirmed, impact, by })
      if (moved !== null) changes.push({ keyword, asin: claim.asin, ...moved })
    }
  }
  const changedKeywords = new Set(changes.map(change => change.keyword))
  const unchanged = keywords.filter(keyword => !changedKeywords.has(keyword))

  /* 7. The after-state — read in the same transaction, so the preview's numbers
        and the execution's numbers are the same numbers. */
  const conflictsAfter = new Set(keywords.filter(keyword => hasConflict(store, { keyword, marketplace: market })))
  const resolvedConflicts = [...conflictsBefore].filter(keyword => !conflictsAfter.has(keyword)).length
  const createdConflicts = [...conflictsAfter].filter(keyword => !conflictsBefore.has(keyword)).length

  const result = {
    action,
    marketplace: market,
    direct: keywords,
    directCount: keywords.length,
    affectedAsins: affected,
    related,
    relatedCount: related.length,
    resolvedConflicts,
    createdConflicts,
    activeRuns,
    requiresConfirmation: activeRuns.length > 0,
    confirmed,
    dryRun,
    changes,
    unchanged,
  }
  if (dryRun) throw new DryRun(result)
  return result
}

/** What this batch would do, writing nothing. Shares every line with the write. */
export function previewKeywordOwnershipBatch(store, opts = {}) {
  try {
    return store.tx(() => runBatch(store, opts, true))
  } catch (error) {
    if (error instanceof DryRun) return error.impact
    throw error
  }
}

/** Do it. Refuses when a running optimization run is affected and `confirmed` is not set. */
export function applyKeywordOwnershipBatch(store, opts = {}) {
  return store.tx(() => runBatch(store, opts, false))
}
