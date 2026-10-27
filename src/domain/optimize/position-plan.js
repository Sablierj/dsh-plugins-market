/**
 * F13-06 位置计划核对 —— 继承模块 08，不产生第二份口径。
 *
 * ## 这个文件存在的理由
 *
 * 需求 §10 的原话是「位置计划的唯一持久层在模块 08；13 只引用与冻结，不产生第二份
 * 口径」，`src/store/keyword-plan.js` 的文件头也这么写着。而在这一批之前，13 的
 * prepare **没有读** 08 的计划：它建自己那份 `buildGlobalPlan`，只把**计数**
 * （`plan: { positions, plannedCells }`）塞进 run 包。于是：
 *
 *   · 「继承 08」这句话没有任何落点；
 *   · 没有「本轮建议计划」可以给人确认；
 *   · 没有版本可核对 —— 「不产生第二份口径」成了一句无法证伪的承诺。
 *
 * ## 继承的是哪一份，以及为什么是这个读法
 *
 * `listPlans(store, { marketplace, asin })[0]` —— **与工作台总库面板「当前计划」
 * 完全同一条读取**（`src/web/routes.js` 的 planSlice 就是这么取当前版的）。这里
 * 刻意**不另立**一个「哪一版算当前」的判据：给「当前」造第二个定义，就是这一批要
 * 消灭的那种第二份口径，哪怕新定义看起来更合理。
 *
 * ## 两个词表，一张映射表
 *
 * 08 的位置是**八个**（`PLAN_POSITIONS`：title / bullets / attributes / backend /
 * adsExact / adsPhrase / adsBroad / negatives，一位一用途）；13 的埋词位置是
 * **十二个**（`EMBED_POSITIONS`，可写文案的表面）。它们是两个不同的对象，所以需要
 * 一张映射表 —— 而它只能有一处，就是下面的 `PLAN_POSITION_EMBED`。
 *
 * 映射不到的（`attributes` / 广告三位置 / `negatives`）**逐条报出来**，不静默丢弃：
 *   · 08 的 `attributes` 是「这个词要不要进属性字段」（无资格规则、人工判断）；
 *     13 的 `attributes` 是一个**可写字段位置**。同名不同义，接上去就是造一个假继承。
 *   · 广告三位置与否定词在 listing 文案里根本无法核对（08 自己也是这么标的：
 *     `keyword-plan.js` 的 `CHECKABLE_POSITIONS` 只含 title / bullets / attributes / backend）。
 *
 * ## 写回：唯一走 `savePlan`
 *
 * 本文件**没有任何一处** `INSERT INTO keyword_plan`。写回走
 * `savePlan(store, { ..., lineageId })` —— 与 `amzn_keyword_plan_save` 工具、页面
 * 「存一版」路由是**同一个函数**。这是「不产生第二份口径」的机制，不是一句承诺：
 * 把 `savePlan` 改坏，模块 08 的测试、这一批的测试、页面两侧会同时红。
 *
 * 写回之后**读回对账**：新版本的族与旧版一致、版本号**变大**（是追加不是覆盖）、
 * 旧版本**原封不动**、新版本的词集合与提交的一致。四条里任何一条不成立都报
 * `PLAN_CHECK_MISMATCH`，并且如实报告「已经写进去的那一版是什么」—— 不谎报成功，
 * 也不假装没写。
 */

import { keywordKey } from '../keywords/key.js'
import { PLAN_POSITIONS, PLAN_POSITION_PURPOSES } from '../states.js'
import { getPlan, listPlans, savePlan } from '../../store/keyword-plan.js'

export const PLAN_CHECK_VERSION = 'optimize-plan-check.v1'

export const PLAN_CHECK_SOURCE =
  'listPlans / getPlan @ src/store/keyword-plan.js（模块 08 F08-05，schema v35）—— 位置计划的唯一持久层'

/**
 * 08 的位置 → 13 的埋词位置。**唯一的一处映射。**
 *
 * `null` 不是「还没接」，是「不接」——理由写在 `UNMAPPED_REASONS` 里，并且会逐条
 * 出现在 `unmapped` 里。把 `null` 折成一个猜测的对应物，就是这一批要消灭的第二份口径。
 */
export const PLAN_POSITION_EMBED = {
  title: 'title',
  bullets: 'bullets',
  backend: 'search_terms',
  attributes: null,
  adsExact: null,
  adsPhrase: null,
  adsBroad: null,
  negatives: null,
}

export const UNMAPPED_REASONS = {
  attributes: '08 的 attributes 是「这个词要不要进属性字段」（本模块无资格规则、人工判断），'
    + '13 的 attributes 是一个可写字段位置 —— 同名不同义，接上去就是造一个假继承。',
  adsExact: '广告 exact 在广告后台，listing 文案里无法核对（08 自己也只把 title / bullets / attributes / backend 列为可核对）。',
  adsPhrase: '广告 phrase 同上：不在文案里。',
  adsBroad: '广告 broad 同上：不在文案里。',
  negatives: '后台否定词不在 listing 文案里，无法从文案核对。',
}

export const PLAN_CHECK_CODES = {
  NO_RUN: 'PLAN_CHECK_NO_RUN',
  NOT_INHERITED: 'PLAN_CHECK_NOT_INHERITED',
  WRITE_REFUSED: 'PLAN_CHECK_WRITE_REFUSED',
  MISMATCH: 'PLAN_CHECK_MISMATCH',
  STATE_MISMATCH: 'PLAN_CHECK_STATE_MISMATCH',
}

/** The declared position vocabulary of module 08, for readers that need labels. */
export function planPositionLabel(position) {
  return PLAN_POSITION_PURPOSES[position]?.label ?? String(position ?? '—')
}

function blank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/**
 * The plan this round **inherits** from module 08. Read-only.
 *
 * Three statuses, and the first two must never be collapsed:
 *
 *   `none`       这个 ASIN 一份计划都没有（08 里没有行）。
 *   `inherited`  继承到了一版（`planId` 非空）。**它可能有 0 条条目** ——
 *                「计划里有 0 个位置」与「没有计划」是两句不同的话，所以
 *                `entryCount` 单独给，不靠 `entries.length` 猜。
 *
 * `uncovered` 是本轮有、计划没决定的词；`unmapped` 是 08 用了、而 13 没有对应埋词
 * 位置的。两个都不静默丢。
 */
export function inheritPlan(store, { asin, marketplace, keywords = [] } = {}) {
  const asinKey = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  const plans = market === '' || asinKey === '' ? [] : listPlans(store, { marketplace: market, asin: asinKey })

  const roundKeys = new Map()
  for (const entry of keywords) {
    const key = keywordKey(entry?.keyword)
    if (key !== '') roundKeys.set(key, String(entry.keyword))
  }

  if (plans.length === 0) {
    return {
      status: 'none',
      planId: null,
      lineageId: null,
      version: null,
      versionCount: 0,
      lineageCount: 0,
      entryCount: null,
      at: null,
      source: PLAN_CHECK_SOURCE,
      entries: [],
      uncovered: [...roundKeys.values()],
      unmapped: [],
      note: `这个 ASIN（${asinKey || '—'} ${market || '—'}）还没有位置计划 —— 08 里一行都没有。`
        + '先用 amzn_keyword_plan_propose 生成提案、amzn_keyword_plan_save 存一版，'
        + '再重开一轮优化；这一轮没有可继承的东西，**也不是「计划里有 0 个位置」**。',
    }
  }

  /* 与工作台总库面板同一条读取：`[0]` 就是它的「当前计划」。不另立判据。 */
  const current = plans[0]
  const loaded = getPlan(store, { planId: current.id })
  const entries = loaded === null ? [] : loaded.entries
  const planKeys = new Map(entries.map(entry => [keywordKey(entry.keyword), entry]))

  const matched = entries.filter(entry => roundKeys.has(keywordKey(entry.keyword)))
  const uncovered = [...roundKeys.entries()]
    .filter(([key]) => !planKeys.has(key))
    .map(([, spelling]) => spelling)

  const unmappedCounts = new Map()
  for (const entry of matched) {
    const positions = [entry.ownerPosition, ...(entry.supporting ?? []).map(slot => slot.position)]
    for (const position of positions) {
      if (PLAN_POSITION_EMBED[position] !== undefined && PLAN_POSITION_EMBED[position] !== null) continue
      unmappedCounts.set(position, (unmappedCounts.get(position) ?? 0) + 1)
    }
  }
  const unmapped = [...unmappedCounts.entries()].map(([position, count]) => ({
    position,
    label: planPositionLabel(position),
    count,
    reason: UNMAPPED_REASONS[position] ?? `13 的埋词位置里没有 ${position} 的对应物。`,
  }))

  const lineages = new Set(plans.map(plan => plan.lineageId))
  return {
    status: 'inherited',
    planId: current.id,
    lineageId: current.lineageId,
    version: current.version,
    versionCount: plans.length,
    lineageCount: lineages.size,
    entryCount: entries.length,
    at: current.createdAt ?? null,
    source: PLAN_CHECK_SOURCE,
    entries: matched.map(entry => ({
      keyword: entry.keyword,
      ownerPosition: entry.ownerPosition,
      tier: entry.tier,
      searchVolume: entry.searchVolume,
      supporting: (entry.supporting ?? []).map(slot => ({ position: slot.position, reason: slot.reason, probe: slot.probe })),
    })),
    uncovered,
    unmapped,
    note: `继承 ${current.asin} ${current.marketplace} v${current.version}（${current.statusLabel}，`
      + `${entries.length} 条）· 版本族 ${current.lineageId}（共 ${plans.length} 版 / ${lineages.size} 个族）。`
      + `本轮 ${roundKeys.size} 个词里，计划决定过的 ${matched.length} 个、没决定过的 ${uncovered.length} 个。`,
  }
}

/**
 * 本轮建议计划 —— 08 的位置词表，加一条「与 13 的分配对得上吗」。
 *
 * `roundChange` 的四个取值都有话直说：
 *
 *   `unchanged`       08 的主人位置映射到 13 之后与本轮分配的埋词主人一致。
 *   `owner-moved`     不一致（例：标题装不下，13 把它挪到了五点）。
 *   `not-comparable`  08 的主人是 attributes / 广告 / negatives —— 没有对应物，**比不了**，
 *                     不是「一致」也不是「不一致」。
 *   `plan-only`       计划里有这个词，而本轮的分配没提到它（本轮包里没有这个关键词）。
 *
 * ⚠️ 建议计划**不新增** 08 词表以外的位置，也不为本轮没决定的词编一个位置 ——
 * 那些词进 `uncovered`。要加词，是人在 08 里加（amzn_keyword_plan_save）。
 */
export function suggestPlan({ inherited, allocation = null } = {}) {
  const byKeyword = new Map()
  for (const entry of allocation?.entries ?? []) {
    byKeyword.set(keywordKey(entry.keyword), entry)
  }
  const entries = (inherited?.entries ?? []).map((entry) => {
    const mapped = PLAN_POSITION_EMBED[entry.ownerPosition]
    const round = byKeyword.get(keywordKey(entry.keyword)) ?? null
    let roundChange = 'plan-only'
    let roundOwner = null
    if (mapped === null || mapped === undefined) {
      roundChange = 'not-comparable'
    } else if (round !== null) {
      roundOwner = round.owner ?? null
      roundChange = roundOwner === mapped ? 'unchanged' : 'owner-moved'
    }
    return {
      keyword: entry.keyword,
      ownerPosition: entry.ownerPosition,
      ownerPositionLabel: planPositionLabel(entry.ownerPosition),
      embedPosition: mapped ?? null,
      tier: entry.tier ?? null,
      searchVolume: entry.searchVolume ?? null,
      supporting: entry.supporting ?? [],
      roundChange,
      roundOwner,
    }
  })

  const counts = {
    suggested: entries.length,
    uncovered: (inherited?.uncovered ?? []).length,
    unmapped: (inherited?.unmapped ?? []).length,
    unchanged: entries.filter(entry => entry.roundChange === 'unchanged').length,
    moved: entries.filter(entry => entry.roundChange === 'owner-moved').length,
    notComparable: entries.filter(entry => entry.roundChange === 'not-comparable').length,
    planOnly: entries.filter(entry => entry.roundChange === 'plan-only').length,
  }
  return {
    entries,
    uncovered: inherited?.uncovered ?? [],
    unmapped: inherited?.unmapped ?? [],
    positions: PLAN_POSITIONS,
    counts,
  }
}

/* ── persistence ────────────────────────────────────────────────────────────── */

/** The raw row, read back through the same SELECT the reconciliation uses. */
export function readPlanCheckRow(store, runId) {
  const row = store.get('SELECT * FROM optimization_plan_check WHERE run_id = ?', [String(runId ?? '').trim()])
  return row ?? null
}

function hydratePlanCheck(row) {
  if (row === null || row === undefined) return null
  return {
    runId: row.run_id,
    planId: row.plan_id ?? null,
    lineageId: row.lineage_id ?? null,
    version: row.version === null || row.version === undefined ? null : Number(row.version),
    entries: parseJson(row.entries_json, []),
    uncovered: parseJson(row.uncovered_json, []),
    unmapped: parseJson(row.unmapped_json, []),
    acceptedAt: row.accepted_at ?? null,
    declinedAt: row.declined_at ?? null,
    decidedBy: row.decided_by ?? null,
    writtenPlanId: row.written_plan_id ?? null,
    writtenVersion: row.written_version === null || row.written_version === undefined ? null : Number(row.written_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * The decision state — **recomputed from the row's own columns**.
 *
 *   `pending`   accepted_at 与 declined_at 都空（还没裁决）
 *   `accepted`  accepted_at 非空
 *   `declined`  declined_at 非空（且没被后来的采纳覆盖）
 *
 * 「已写回」由 `written_plan_id` 非空重算，不由一个自报的布尔值。
 */
export function planCheckState(row) {
  if (row === null || row === undefined) {
    return {
      present: false,
      state: 'absent',
      inheritedStatus: 'absent',
      decidedAt: null,
      decidedBy: null,
      writtenBack: null,
    }
  }
  const accepted = !blank(row.accepted_at ?? row.acceptedAt)
  const declined = !blank(row.declined_at ?? row.declinedAt)
  const writtenId = row.written_plan_id ?? row.writtenPlanId ?? null
  const writtenVersion = row.written_version ?? row.writtenVersion ?? null
  return {
    present: true,
    state: accepted ? 'accepted' : (declined ? 'declined' : 'pending'),
    inheritedStatus: blank(row.plan_id ?? row.planId) ? 'none' : 'inherited',
    decidedAt: accepted ? (row.accepted_at ?? row.acceptedAt) : (declined ? (row.declined_at ?? row.declinedAt) : null),
    decidedBy: row.decided_by ?? row.decidedBy ?? null,
    writtenBack: blank(writtenId) ? null : { planId: writtenId, version: writtenVersion === null ? null : Number(writtenVersion) },
  }
}

/**
 * Record the round's inheritance + suggestion. Written once, at `prepare`.
 *
 * Idempotent by content; a second call with different content is refused rather
 * than overwriting, for the same reason `writeStrategy` refuses: the row is what
 * the human was shown when they decided.
 */
export function writePlanCheck(store, runId, snapshot, { now = new Date() } = {}) {
  const run = String(runId ?? '').trim()
  if (run === '') throw new Error('runId is required')
  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  const payload = {
    planId: snapshot?.planId ?? null,
    lineageId: snapshot?.lineageId ?? null,
    version: snapshot?.version ?? null,
    entries: JSON.stringify(snapshot?.entries ?? []),
    uncovered: JSON.stringify(snapshot?.uncovered ?? []),
    unmapped: JSON.stringify(snapshot?.unmapped ?? []),
  }
  const existing = readPlanCheckRow(store, run)
  if (existing === null) {
    store.run(
      `INSERT INTO optimization_plan_check
         (run_id, plan_id, lineage_id, version, entries_json, uncovered_json, unmapped_json,
          accepted_at, declined_at, decided_by, written_plan_id, written_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      [run, payload.planId, payload.lineageId, payload.version, payload.entries, payload.uncovered, payload.unmapped, at, at],
    )
    return { ok: true, written: true, unchanged: false, at }
  }
  const same = String(existing.plan_id ?? '') === String(payload.planId ?? '')
    && String(existing.lineage_id ?? '') === String(payload.lineageId ?? '')
    && String(existing.version ?? '') === String(payload.version ?? '')
    && String(existing.entries_json) === payload.entries
    && String(existing.uncovered_json) === payload.uncovered
    && String(existing.unmapped_json) === payload.unmapped
  if (same) return { ok: true, written: false, unchanged: true, at: existing.created_at }
  return {
    ok: false,
    code: PLAN_CHECK_CODES.STATE_MISMATCH,
    error: '这一轮已经有位置计划核对，且内容与这次要写的不一致 —— 它在 prepare 时记一次，'
      + '之后只由人的裁决改写。要换计划，另开一轮。',
  }
}

/** Everything a reader needs about one run's plan check. */
export function readPlanCheck(store, runId) {
  const run = store.get('SELECT * FROM optimization_run WHERE id = ?', [String(runId ?? '').trim()]) ?? null
  if (run === null) {
    return {
      ok: false,
      code: PLAN_CHECK_CODES.NO_RUN,
      error: `没有第 ${String(runId ?? '').slice(0, 8)} 轮优化 —— 计划核对挂在轮次上，先跑一次 amzn_optimize_prepare。`,
    }
  }
  const row = readPlanCheckRow(store, run.id)
  const hydrated = hydratePlanCheck(row)
  const state = planCheckState(row)
  const inheritedNote = hydrated === null
    ? null
    : (hydrated.planId === null
      ? '这一轮当时**没有**可继承的位置计划（这个 ASIN 在 08 里一份都没有）—— 不是「计划里有 0 个位置」。'
      : `继承 ${run.asin} ${run.marketplace} v${hydrated.version}（族 ${hydrated.lineageId}）—— `
        + `位置计划的唯一持久层是模块 08，13 只引用不另存。`)

  /* ── 「本轮没有建议计划」与「计划里有 0 个位置」必须分开 ────────────────────
     两个都会让 `entries.length` 是 0，而它们是两件完全不同的事：一个是这一轮的关键词
     一个都没被计划决定过（计划本身有内容），另一个是计划本身就是空的（没有可继承的
     内容）。所以继承到的那一版**有多少条**要单独读出来，不靠 `entries.length` 猜 ——
     那正是本仓反复付代价换来的那条纪律。
     `plan_id` 钉的是**那一版**，而 `keyword_plan` 的行是追加式、永不修改的，所以
     重新读它拿到的条数就是当时那一版的条数，不是「今天的样子」。 */
  let inheritedEntryCount = null
  if (hydrated !== null && hydrated.planId !== null) {
    const loaded = getPlan(store, { planId: hydrated.planId })
    inheritedEntryCount = loaded === null ? null : loaded.entries.length
  }
  const suggestedNote = hydrated === null
    ? null
    : (hydrated.planId === null
      ? '没有可继承的计划，所以没有建议计划 —— 这是「没得建议」，不是「建议了 0 条」。'
      : (hydrated.entries.length > 0
        ? null
        : (inheritedEntryCount === 0
          ? '继承到的那一版计划里**一条条目都没有** —— 计划存在，但它是空的。'
          : (inheritedEntryCount === null
            ? '继承到的那一版计划**已经读不到了**（行不见了）—— 这是「读不到」，不是「0 条」。'
            : `继承到的那一版有 ${inheritedEntryCount} 条，但**这一轮的关键词一个都没被它决定过**`
              + ' —— 这是「本轮没有建议计划」，不是「计划里有 0 个位置」。'))))
  return {
    ok: true,
    runId: run.id,
    asin: run.asin,
    marketplace: run.marketplace,
    status: run.status,
    present: hydrated !== null,
    inherited: {
      status: state.inheritedStatus,
      planId: hydrated === null ? null : hydrated.planId,
      lineageId: hydrated === null ? null : hydrated.lineageId,
      version: hydrated === null ? null : hydrated.version,
      /* 继承到的那一版有几条 —— 单独给，**不靠 `suggested.entries.length` 猜**。 */
      entryCount: inheritedEntryCount,
      source: PLAN_CHECK_SOURCE,
      at: null,
      note: inheritedNote,
    },
    suggested: {
      entries: hydrated === null ? [] : hydrated.entries,
      uncovered: hydrated === null ? [] : hydrated.uncovered,
      unmapped: hydrated === null ? [] : hydrated.unmapped,
      note: suggestedNote,
    },
    decision: {
      state: state.state,
      acceptedAt: hydrated === null ? null : hydrated.acceptedAt,
      declinedAt: hydrated === null ? null : hydrated.declinedAt,
      decidedBy: hydrated === null ? null : hydrated.decidedBy,
    },
    writtenBack: state.writtenBack,
    positions: PLAN_POSITIONS,
    counts: {
      suggested: hydrated === null ? 0 : hydrated.entries.length,
      uncovered: hydrated === null ? 0 : hydrated.uncovered.length,
      unmapped: hydrated === null ? 0 : hydrated.unmapped.length,
      moved: hydrated === null ? 0 : hydrated.entries.filter(entry => entry.roundChange === 'owner-moved').length,
      unchanged: hydrated === null ? 0 : hydrated.entries.filter(entry => entry.roundChange === 'unchanged').length,
    },
    empty: hydrated === null
      ? {
        kind: 'no-plan-check',
        text: '这一轮没有位置计划核对记录 —— 它在 amzn_optimize_prepare 建完轮次时写下来。'
          + '本批之前建的轮次没有它。',
      }
      : null,
  }
}

/* ── the decision, and the write-back ───────────────────────────────────────── */

/** One stored suggestion entry as a `savePlan` entry. Reasons are preserved verbatim. */
function toSaveEntries(entries) {
  return (entries ?? []).map((entry) => ({
    keyword: entry.keyword,
    ownerPosition: entry.ownerPosition,
    tier: entry.tier ?? null,
    searchVolume: entry.searchVolume ?? null,
    supporting: (entry.supporting ?? []).map(slot => ({
      position: slot.position,
      reason: slot.reason,
      probe: slot.probe ?? null,
    })),
  }))
}

/**
 * 采纳（写回 08 新版本）或否决。
 *
 * ## 写回走的是 08 的唯一持久层
 *
 * `savePlan(store, { ..., lineageId })` —— 与 `amzn_keyword_plan_save` 是同一个函数。
 * 本文件没有、也不会有 `INSERT INTO keyword_plan`。`savePlan` 的拒绝（位置不在词表、
 * 同一个词出现两次、复现位没有理由）**原样透传**，并且**不写** `accepted_at`：
 * 一次被拒的写回不是「已采纳」。
 *
 * ## 读回对账（四条，四条都是不同的路）
 *
 *   ① 新版本的 `lineageId` 与继承的那一版**相同**；
 *   ② 新版本的 `version` **大于**继承的那一版（是追加，不是覆盖）；
 *   ③ 继承的那一版**原封不动**（重新 `getPlan` 读它，条目数与主人位置逐条相同）；
 *   ④ 新版本的词集合与提交的**一致**。
 *
 * 任何一条不成立 → `PLAN_CHECK_MISMATCH`，并把「已经写进去的那一版是什么」如实
 * 报出来 —— 不谎报成功，也不假装没写。
 */
export function decidePlanCheck(store, { runId, decision, by = null, now = new Date() } = {}) {
  const run = String(runId ?? '').trim()
  const row = readPlanCheckRow(store, run)
  if (run === '' || row === null) {
    return {
      ok: false,
      code: PLAN_CHECK_CODES.NO_RUN,
      error: `第 ${run.slice(0, 8)} 轮没有位置计划核对记录 —— 没有可裁决的东西。`
        + '它在 amzn_optimize_prepare 建完轮次时写下来；本批之前建的轮次没有它。',
    }
  }
  const wanted = String(decision ?? '').trim()
  if (wanted !== 'accept' && wanted !== 'decline') {
    return {
      ok: false,
      code: PLAN_CHECK_CODES.STATE_MISMATCH,
      error: `unknown decision ${JSON.stringify(decision)} — 只能是 accept（采纳并写回 08 新版本）或 decline（不采纳）。`,
    }
  }
  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  const entries = parseJson(row.entries_json, [])

  if (wanted === 'decline') {
    const already = !blank(row.declined_at)
    if (!already) {
      store.run(
        'UPDATE optimization_plan_check SET declined_at = ?, accepted_at = NULL, decided_by = ?, updated_at = ? WHERE run_id = ?',
        [at, by === null || by === undefined ? null : String(by), at, run],
      )
    }
    const after = readPlanCheckRow(store, run)
    const state = planCheckState(after)
    if (state.state !== 'declined') {
      return {
        ok: false,
        code: PLAN_CHECK_CODES.STATE_MISMATCH,
        error: `否决之后读回重算的状态是「${state.state}」，按内容它应当是「declined」——这次写入没有产生它声称的结果。`,
      }
    }
    return { ok: true, decision: 'decline', unchanged: already, runId: run, state: state.state, decidedAt: after.declined_at, writtenBack: null }
  }

  /* ── accept ─────────────────────────────────────────────────────────────── */
  if (blank(row.plan_id)) {
    return {
      ok: false,
      code: PLAN_CHECK_CODES.NOT_INHERITED,
      error: `第 ${run.slice(0, 8)} 轮当时**没有**可继承的位置计划（这个 ASIN 在 08 里一份都没有），`
        + '所以没有可写回的版本族。先在 08 里建一份计划（amzn_keyword_plan_propose → _save），再重开一轮。',
    }
  }

  /* The inherited version, read again **before** the write, so the "old version
     untouched" check below compares against bytes we actually saw. The run row is
     read for asin / marketplace because the check row does not carry them —
     they belong to the run, and copying them here would be a second copy of a
     fact that already has a home. */
  const runRow = store.get('SELECT asin, marketplace FROM optimization_run WHERE id = ?', [run]) ?? null
  const inheritedBefore = getPlan(store, { planId: row.plan_id })

  let saved = null
  try {
    saved = savePlan(store, {
      asin: runRow?.asin ?? inheritedBefore?.plan?.asin,
      marketplace: runRow?.marketplace ?? inheritedBefore?.plan?.marketplace,
      name: null,
      note: `由优化轮次 ${run} 的位置计划核对采纳并写回（F13-06）`,
      entries: toSaveEntries(entries),
      source: 'agent',
      /* 状态跟着继承的那一版走，不硬写 draft：把一份「生效」的计划写回成「草稿」是一次
         没人要求的状态降级，而状态是计划的一部分。读不到那一版时才落到 draft。 */
      status: inheritedBefore?.plan?.status ?? 'draft',
      lineageId: row.lineage_id,
      createdBy: by === null || by === undefined ? null : String(by),
    })
  } catch (error) {
    /* 08 的拒绝原样透传，`accepted_at` 一个字都不写 —— 一次被拒的写回不是「已采纳」。 */
    return {
      ok: false,
      code: PLAN_CHECK_CODES.WRITE_REFUSED,
      error: `写回模块 08 被拒：${error.message}`,
      hint: '位置计划的唯一持久层是 08 的 savePlan。它拒绝的三种情况：主人位置不在词表、同一个词出现两次、复现位没有理由。',
    }
  }

  const written = getPlan(store, { planId: saved.plan.id })
  const inheritedAfter = getPlan(store, { planId: row.plan_id })
  const problems = []
  if (String(saved.plan.lineageId) !== String(row.lineage_id)) {
    problems.push(`新版本的版本族是 ${saved.plan.lineageId}，继承的那一版属于 ${row.lineage_id}`)
  }
  if (!(Number(saved.plan.version) > Number(row.version))) {
    problems.push(`新版本号 ${saved.plan.version} 没有大于继承的 v${row.version} —— 这不是一次追加`)
  }
  if (inheritedBefore !== null && inheritedAfter !== null) {
    const sameCount = inheritedBefore.entries.length === inheritedAfter.entries.length
    const sameOwners = inheritedBefore.entries.every((entry, index) =>
      entry.keyword === inheritedAfter.entries[index]?.keyword
      && entry.ownerPosition === inheritedAfter.entries[index]?.ownerPosition)
    if (!sameCount || !sameOwners) {
      problems.push(`继承的那一版（v${row.version}）被改动了 —— 版本化的意义正是旧版不动`)
    }
  }
  const submitted = new Set(entries.map(entry => keywordKey(entry.keyword)))
  const writtenKeys = new Set((written?.entries ?? []).map(entry => keywordKey(entry.keyword)))
  const missing = [...submitted].filter(key => !writtenKeys.has(key))
  const extra = [...writtenKeys].filter(key => !submitted.has(key))
  if (missing.length > 0 || extra.length > 0) {
    problems.push(`写回后的词集合与提交的不一致（缺 ${missing.length}、多 ${extra.length}）`)
  }
  if (problems.length > 0) {
    return {
      ok: false,
      code: PLAN_CHECK_CODES.MISMATCH,
      /* 如实报告已经写进去的那一版：一次失败的写回**仍然产生了**一个版本，
         假装没写会让下一个人以为版本族里没有它。 */
      writtenBack: { planId: saved.plan.id, version: saved.plan.version },
      error: `写回之后读回对账有 ${problems.length} 处不符：${problems.join('；')}。`
        + `已经写入的那一版是 ${saved.plan.id}（v${saved.plan.version}）—— 它确实存在，请据此处置。`,
    }
  }

  store.run(
    `UPDATE optimization_plan_check
        SET accepted_at = ?, declined_at = NULL, decided_by = ?, written_plan_id = ?, written_version = ?, updated_at = ?
      WHERE run_id = ?`,
    [at, by === null || by === undefined ? null : String(by), saved.plan.id, saved.plan.version, at, run],
  )

  const after = readPlanCheckRow(store, run)
  const state = planCheckState(after)
  if (state.state !== 'accepted' || state.writtenBack === null) {
    return {
      ok: false,
      code: PLAN_CHECK_CODES.STATE_MISMATCH,
      writtenBack: { planId: saved.plan.id, version: saved.plan.version },
      error: `采纳之后读回重算的状态是「${state.state}」/ 写回 ${state.writtenBack === null ? '缺失' : '有'}，`
        + '按内容它应当是「accepted」且带写回版本 —— 这次写入没有产生它声称的结果。',
    }
  }

  return {
    ok: true,
    decision: 'accept',
    unchanged: false,
    runId: run,
    state: state.state,
    decidedAt: after.accepted_at,
    writtenBack: { planId: saved.plan.id, version: saved.plan.version },
    inherited: { planId: row.plan_id, version: row.version },
    entryCount: written?.entries?.length ?? entries.length,
  }
}
