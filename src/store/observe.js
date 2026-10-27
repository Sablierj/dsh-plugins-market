/**
 * 模块 14 §6/§7 的写入层：发布记录与观测计划。
 *
 * ## 守卫放在这里，因为这里是所有写入者都要过的门
 *
 * 本仓反复出现的一个形状是「承诺了能力然后把它丢掉」：一个字段写进去了、没有任何
 * 人读，或者一个开关定义了、没有任何调用方。发布记录这边最容易出的同类问题是反的
 * 一个：**一条内部自相矛盾的记录被收下**。所以下面每一条校验都在 store 层，而不是
 * 留给工具或页面：
 *
 *   - `kind` 决定这条记录**是什么**，而三种 kind 要求的东西不一样：`draft` 必须
 *     带 run 与草案版本（§6 的原话），`manual` 必须**两者都不带**（§6：「无关联的
 *     记录标记为『手工登记』，不计算草案差异、不参与发布率统计」），`rollback`
 *     必须指出它在回滚哪一条。传错了不是「多余信息」，是调用方搞错了自己在做什么。
 *   - 带了 run 的记录，其 asin/marketplace 必须与那次 run 一致。一条声称在优化
 *     A 的同时发布了 B 的记录，会把 B 的后续观测挂到 A 的报告上。
 *   - `draftVersion` 必须等于 run 的**当前**草案版本。不等说明调用方在描述一个
 *     已经不存在的批准 —— 而 §6 的「与已批准草案差异」正是相对那一版算的。
 *
 * ## 为什么差异在这里算，而不是在读的时候算
 *
 * 差异在**登记时**算出并冻结（`deviation_json`）。实时重算要读「当前草案」，而草案
 * 在登记之后还会被人改 —— 改完再问「当时为什么说它偏离」，答案就变了。§15 的
 * 「历史运行跟随快照」是同一条道理。
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'
import { getOptimizationRun } from './queries.js'
import { upsertNotification } from './notification.js'
import { buildApprovedSnapshot, computeDeviation } from '../domain/observe/deviation.js'
import { checkChangeBudget, parseWindowDays } from '../domain/observe/plan.js'
import { checkObservationData, snapshotMetrics } from '../domain/observe/metrics.js'
import {
  CONCLUSION_LABELS, INSUFFICIENT_ONLY, OBSERVATION_CONCLUSIONS,
  cardState, checkpointIdFor, checkpointSchedule, deriveStatus, refuteConclusion,
} from '../domain/observe/observation.js'

/** §6 的三种发布记录。闭集：加第四种是代码改动，所以它在这里而不是在调用方。 */
export const PUBLICATION_KINDS = ['draft', 'manual', 'rollback']

/** §6 的偏离处置。闭集，理由同上。 */
export const BASELINE_CHOICES = ['reobserve', 'mispublish']

function parse(json, fallback) {
  if (json === null || json === undefined || json === '') return fallback
  if (typeof json === 'object') return json
  try {
    const value = JSON.parse(json)
    return value === null || value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeAsin(value) {
  const asin = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`invalid ASIN "${value}" (expected 10 letters/digits)`)
  return asin
}

function normalizeMarketplace(value) {
  const marketplace = String(value ?? '').trim().toUpperCase()
  if (marketplace === '') throw new Error('marketplace is required')
  return marketplace
}

function hydratePublication(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    asin: row.asin,
    marketplace: row.marketplace,
    kind: row.kind,
    runId: row.run_id ?? null,
    draftVersion: row.draft_version === null || row.draft_version === undefined ? null : Number(row.draft_version),
    rollbackOf: row.rollback_of ?? null,
    approved: parse(row.approved_json, null),
    published: parse(row.published_json, {}),
    deviation: parse(row.deviation_json, null),
    deviated: row.deviated === 1,
    deviationRule: row.deviation_rule ?? null,
    uncovered: parse(row.uncovered_json, []),
    baselineChoice: row.baseline_choice ?? null,
    baselineDecidedAt: row.baseline_decided_at ?? null,
    operator: row.operator ?? null,
    note: row.note ?? null,
    evidenceRef: row.evidence_ref ?? null,
    publishedAt: row.published_at,
    observationStartAt: row.observation_start_at,
    /* §9 的终止事实记在**发布记录**上，不是从节点行推断的：刚发布就撤回时一个节点
       都还没物化，那时没有任何节点行能承载这个事实。 */
    observationTerminatedAt: row.observation_terminated_at ?? null,
    observationTerminatedReason: row.observation_terminated_reason ?? null,
    rollbackProtected: row.rollback_protected === 1,
    createdAt: row.created_at,
  }
}

function hydratePlan(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    publicationId: row.publication_id,
    hypothesis: row.hypothesis ?? null,
    baselineStart: row.baseline_start ?? null,
    baselineEnd: row.baseline_end ?? null,
    changed: parse(row.changed_json, []),
    unchanged: parse(row.unchanged_json, []),
    success: parse(row.success_json, []),
    fail: parse(row.fail_json, []),
    /* 读取路径容错，写入路径严格（`saveObservationPlan` 会拒收坏值）。这两个方向
       故意不对称：写入时一个坏窗口必须当场报错，而读取时**一行坏数据不该让整份
       计划列表打不开** —— 这一列可以被手工编辑，把页面搞崩只会让人更不敢看它。 */
    windowDays: safeWindowDays(row.window_days),
    confounders: row.confounders ?? null,
    rollbackConditions: row.rollback_conditions ?? null,
    rebuild: row.rebuild === 1,
    status: row.status,
    supersededReason: row.superseded_reason ?? null,
    createdAt: row.created_at,
  }
}

function safeWindowDays(value) {
  try {
    return parseWindowDays(value)
  } catch {
    return parseWindowDays(null)
  }
}

export function getPublication(store, id) {
  const key = String(id ?? '').trim()
  if (key === '') return null
  return hydratePublication(store.get('SELECT * FROM publication_record WHERE id = ?', [key]))
}

/**
 * §6 的登记。返回存下来的那一行（含算好的差异）。
 *
 * 这条路径**只由人触发**：本插件不自动发布，所以记录永远是「运营改完了，回来登记」。
 */
export function recordPublication(store, record = {}) {
  const kind = String(record.kind ?? '').trim()
  if (!PUBLICATION_KINDS.includes(kind)) {
    throw new Error(`unknown publication kind "${kind}" — known: ${PUBLICATION_KINDS.join(', ')}`)
  }

  const asin = normalizeAsin(record.asin)
  const marketplace = normalizeMarketplace(record.marketplace)

  const published = asObject(record.published)
  if (Object.keys(published).length === 0) {
    throw new Error('published is empty — a publication record with no actual values cannot drive anything (§6)')
  }

  const runId = record.runId === undefined || record.runId === null || String(record.runId).trim() === ''
    ? null : String(record.runId).trim()
  const rollbackOf = record.rollbackOf === undefined || record.rollbackOf === null || String(record.rollbackOf).trim() === ''
    ? null : String(record.rollbackOf).trim()

  /* ── 三种 kind 各自的要求，见文件头 ───────────────────────────────────────── */
  /* 「没带 draftVersion」有**三种写法**：省略 / null / 空串 —— 和上面 `runId` 的归一化
     是同一件事。三种都要当「没带」：工具（`amzn_publication_record`）与页面路由都把
     未提供的 draftVersion 归一成 `null`，只认 `undefined` 会让 kind=manual 经由这两条
     真实调用路径**永远**被拒 —— 一个声明的能力（§6 的手工登记）在实际调用上不可达，
     而 store 层的测试直接调本函数、绕过归一化，所以这个洞不会被那层测试看见。 */
  const carriesDraftVersion = record.draftVersion !== undefined && record.draftVersion !== null
    && String(record.draftVersion).trim() !== ''
  if (kind === 'manual' && (runId !== null || carriesDraftVersion)) {
    throw new Error('a manual record must not carry a runId or draftVersion — §6 keeps it out of the deviation and the publication rate')
  }
  if (kind === 'draft' && runId === null) {
    throw new Error('a draft publication must reference the optimization run it came from (§6)')
  }
  if (kind === 'draft' && (record.draftVersion === undefined || record.draftVersion === null || String(record.draftVersion).trim() === '')) {
    throw new Error('a draft publication must reference the draft version it was approved against (§6)')
  }
  if (kind === 'rollback' && rollbackOf === null) {
    throw new Error('a rollback publication must say which publication record it rolls back (§9)')
  }

  let draftVersion = null
  let approved = null
  let deviation = null
  if (runId !== null) {
    const run = getOptimizationRun(store, runId)
    if (run === null) throw new Error(`no optimization run ${runId}`)
    if (String(run.asin).toUpperCase() !== asin || String(run.marketplace).toUpperCase() !== marketplace) {
      throw new Error(
        `run ${runId} is ${run.asin}/${run.marketplace} but this record claims ${asin}/${marketplace} — `
        + 'a publication must be recorded against the ASIN it was actually published on',
      )
    }

    const current = Number(run.draft_version ?? 0)
    const wanted = Number(record.draftVersion)
    if (!Number.isInteger(wanted)) throw new Error(`draftVersion must be a whole number, got "${record.draftVersion}"`)
    if (wanted !== current) {
      throw new Error(
        `run ${runId} is at draft version ${current}, not ${wanted} — the approval this record describes no longer exists. `
        + 'Re-read the run and record the version you actually published.',
      )
    }
    draftVersion = current

    approved = buildApprovedSnapshot(run.drafts)
    deviation = computeDeviation({ approved, published })
  }

  if (rollbackOf !== null) {
    const target = getPublication(store, rollbackOf)
    if (target === null) throw new Error(`no publication record ${rollbackOf} to roll back`)
    if (target.asin !== asin || target.marketplace !== marketplace) {
      throw new Error(`publication ${rollbackOf} is ${target.asin}/${target.marketplace}, not ${asin}/${marketplace}`)
    }
  }

  const publishedAt = record.publishedAt === undefined || record.publishedAt === null || String(record.publishedAt).trim() === ''
    ? nowIso() : String(record.publishedAt).trim()
  /* §6 把「观测起点」单列，§9 说窗口自发布记录重新计时 —— 默认等于发布时间，但它是
     一个可以不同的时刻（偏离处置里「以实际发布值为新基线」会把它推到现在）。 */
  const observationStartAt = record.observationStartAt === undefined || record.observationStartAt === null
    || String(record.observationStartAt).trim() === ''
    ? publishedAt : String(record.observationStartAt).trim()

  const id = String(record.id ?? '').trim() || `pub-${randomUUID()}`
  store.run(
    `INSERT INTO publication_record (
       id, asin, marketplace, kind, run_id, draft_version, rollback_of, approved_json, published_json,
       deviation_json, deviated, deviation_rule, uncovered_json, baseline_choice, baseline_decided_at,
       operator, note, evidence_ref, published_at, observation_start_at, rollback_protected, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, asin, marketplace, kind, runId, draftVersion, rollbackOf,
      approved === null ? null : JSON.stringify(approved),
      JSON.stringify(published),
      deviation === null ? null : JSON.stringify(deviation),
      deviation !== null && deviation.deviated ? 1 : 0,
      deviation === null ? null : deviation.rule,
      deviation === null ? null : JSON.stringify(deviation.uncovered),
      record.operator === undefined || record.operator === null ? null : String(record.operator),
      record.note === undefined || record.note === null ? null : String(record.note),
      record.evidenceRef === undefined || record.evidenceRef === null ? null : String(record.evidenceRef),
      publishedAt, observationStartAt,
      record.rollbackProtected === true ? 1 : 0,
      nowIso(),
    ],
  )
  const saved = getPublication(store, id)
  /* §9 的闭环（关掉待发布的回滚任务 + 终止原观测）挂在**登记**这一步，不挂在生成
     交付包那一步 —— 原话是「必须回到 §6 登记一条新发布记录……直到对应发布记录登记
     才闭环」。生成交付包的时候人还没改，那时闭环就是在说谎。

     `rollbackClosure` 是一个独立的键而不是混进记录字段里：它不是这条发布记录的性质，
     是这次登记触发的副作用，读的人要能一眼分清。 */
  if (kind !== 'rollback') return saved
  return { ...saved, rollbackClosure: closeRollbackFor(store, saved) }
}

/**
 * §6 的偏离处置：偏离了的发布必须由人二选一。
 *
 * 拒绝的两种情况都不是防御性编程：
 *   - 没偏离就没有要处置的东西；
 *   - 已经选过就不能改选 —— 第一次处置**就是**当时发生的事，改选等于把历史改成
 *     另一个样子，而这条记录存在的意义正是「当时到底怎么处理的」。
 */
export function setBaselineChoice(store, publicationId, choice, { note = null } = {}) {
  const record = getPublication(store, publicationId)
  if (record === null) throw new Error(`no publication record ${publicationId}`)
  const wanted = String(choice ?? '').trim()
  if (!BASELINE_CHOICES.includes(wanted)) {
    throw new Error(`unknown baseline choice "${choice}" — known: ${BASELINE_CHOICES.join(', ')}`)
  }
  if (!record.deviated) {
    throw new Error(`publication ${publicationId} did not deviate from the approved draft — there is nothing to decide (§6)`)
  }
  if (record.baselineChoice !== null) {
    throw new Error(
      `publication ${publicationId} was already decided as "${record.baselineChoice}" at ${record.baselineDecidedAt} — `
      + 'the first decision is the one that happened',
    )
  }

  const decidedAt = nowIso()
  store.run(
    'UPDATE publication_record SET baseline_choice = ?, baseline_decided_at = ?, note = COALESCE(?, note) WHERE id = ?',
    [wanted, decidedAt, note === null ? null : String(note), record.id],
  )

  if (wanted === 'reobserve') {
    /* §6：「以实际发布值为新基线重新观测（原观测计划作废并留痕）」。作废的计划**还在**
       （status = superseded），因为「当时是这么计划的」本身是要留下来的事实。 */
    store.run(
      "UPDATE observation_plan SET status = 'superseded', superseded_reason = ? WHERE publication_id = ? AND status = 'active'",
      [`实际发布偏离批准草案，以实际发布值为新基线重新观测（§6 处置①）`, record.id],
    )
    store.run('UPDATE publication_record SET observation_start_at = ? WHERE id = ?', [decidedAt, record.id])
  }
  /* `mispublish` 只记事实：§9 的回滚交付包由 `suggestRollback` 生成，是**另一次调用**。
     不在这里顺手生成，是因为交付包有两条真会踩到的前置条件（被回滚的那一版必须仍是线上那
     一版、同一记录同时只能有一个待发布回滚），在最深处悄悄造一个半截流程，只会让人以为
     它已经能用。这里原先写的是「§9 的回滚建议流程是下一批」—— 那句话过期了，流程在
     `tools/observe.js` 的 amzn_rollback_suggest 里。 */
  return getPublication(store, record.id)
}

/**
 * §6：「未选择前该 ASIN 观测卡片为 `waiting_human`」。
 *
 * 这一条只提供**事实**：哪些记录偏离了、还没处置。观测卡片本身是 §8 的产物，已经交付
 * （`observation_checkpoint` + `publicationObservation` + `amzn_observation_list`）——
 * 原先这里写的「观测卡片是下一批」在模块 14 那几批之后过期了。
 */
export function awaitingBaselineChoice(store, { asin = null, marketplace = null } = {}) {
  const where = ['deviated = 1', 'baseline_choice IS NULL']
  const params = []
  if (asin !== null && String(asin).trim() !== '') { where.push('asin = ?'); params.push(normalizeAsin(asin)) }
  if (marketplace !== null && String(marketplace).trim() !== '') {
    where.push('marketplace = ?'); params.push(normalizeMarketplace(marketplace))
  }
  return store.all(
    `SELECT * FROM publication_record WHERE ${where.join(' AND ')} ORDER BY published_at DESC`,
    params,
  ).map(hydratePublication)
}

/**
 * §6 的发布率：分母是**有已采纳草案的运行**，分子是其中登记了 `draft` 发布的。
 *
 * 手工登记不参与（§6 原话），所以它被单独数出来而不是被默默丢掉 —— 「多少条记录
 * 被排除在统计外」本身是读这个数字的人该知道的事。
 *
 * 分母为 0 时 `ratio` 是 `null` 而不是 0：0/0 不是「发布率 0%」，是**还没有可统计
 * 的对象**。把它渲染成 0% 会让一个从没发布过任何东西的账号看起来「发布全都失败了」。
 */
export function publicationRate(store, { asin = null, marketplace = null } = {}) {
  const where = []
  const params = []
  if (asin !== null && String(asin).trim() !== '') { where.push('r.asin = ?'); params.push(normalizeAsin(asin)) }
  if (marketplace !== null && String(marketplace).trim() !== '') {
    where.push('r.marketplace = ?'); params.push(normalizeMarketplace(marketplace))
  }
  const scope = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const eligible = store.all(
    `SELECT DISTINCT r.id, r.asin, r.marketplace
       FROM optimization_run r
       JOIN optimization_draft d ON d.run_id = r.id AND d.accepted = 1
       ${scope}`,
    params,
  )
  const published = store.all(
    `SELECT DISTINCT run_id FROM publication_record WHERE kind = 'draft' AND run_id IS NOT NULL`,
  )
  const publishedIds = new Set(published.map(row => row.run_id))
  const numerator = eligible.filter(row => publishedIds.has(row.id)).length
  const manual = store.get("SELECT COUNT(*) AS n FROM publication_record WHERE kind = 'manual'").n

  return {
    numerator,
    denominator: eligible.length,
    ratio: eligible.length === 0 ? null : numerator / eligible.length,
    manualExcluded: Number(manual),
    note: eligible.length === 0
      ? '还没有「采纳过草案」的运行，因此没有可统计的发布率 —— 不是 0%。'
      : `${numerator}/${eligible.length} 次已采纳草案的运行登记了实际发布。`,
  }
}

/** §6/§7 的列表：按 ASIN/站点/类型/时间筛。 */
export function listPublications(store, { asin = null, marketplace = null, kind = null, since = null, limit = 50 } = {}) {
  const where = []
  const params = []
  if (asin !== null && String(asin).trim() !== '') { where.push('asin = ?'); params.push(normalizeAsin(asin)) }
  if (marketplace !== null && String(marketplace).trim() !== '') {
    where.push('marketplace = ?'); params.push(normalizeMarketplace(marketplace))
  }
  if (kind !== null && String(kind).trim() !== '') {
    const wanted = String(kind).trim()
    if (!PUBLICATION_KINDS.includes(wanted)) throw new Error(`unknown publication kind "${kind}"`)
    where.push('kind = ?'); params.push(wanted)
  }
  if (since !== null && String(since).trim() !== '') { where.push('published_at >= ?'); params.push(String(since).trim()) }

  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), 500)
  const rows = store.all(
    `SELECT * FROM publication_record ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY published_at DESC, rowid DESC LIMIT ?`,
    [...params, cap],
  )
  return {
    rows: rows.map(hydratePublication),
    total: Number(store.get('SELECT COUNT(*) AS n FROM publication_record').n),
    limit: cap,
  }
}

/**
 * §7：存一份变更声明。
 *
 * 超预算又不标重建 → **拒收**（`checkChangeBudget` 的 `accepted === false`）。这不是
 * 建议，是这道门：一份说不清自己是什么的变更声明，会让观测期的结论无法解释。
 */
export function saveObservationPlan(store, plan = {}) {
  const publicationId = String(plan.publicationId ?? '').trim()
  if (publicationId === '') throw new Error('publicationId is required — a plan is a plan for one publication')
  const publication = getPublication(store, publicationId)
  if (publication === null) throw new Error(`no publication record ${publicationId}`)

  const budget = checkChangeBudget({ changed: plan.changed, unchanged: plan.unchanged, rebuild: plan.rebuild === true })
  if (!budget.accepted) throw new Error(budget.note)

  const windowDays = parseWindowDays(plan.windowDays)
  const id = String(plan.id ?? '').trim() || `plan-${randomUUID()}`
  store.run(
    `INSERT INTO observation_plan (
       id, publication_id, hypothesis, baseline_start, baseline_end, changed_json, unchanged_json,
       success_json, fail_json, window_days, confounders, rollback_conditions, rebuild, status,
       superseded_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
    [
      id, publicationId,
      plan.hypothesis === undefined || plan.hypothesis === null ? null : String(plan.hypothesis),
      plan.baselineStart ?? null, plan.baselineEnd ?? null,
      JSON.stringify(Array.isArray(plan.changed) ? plan.changed : []),
      JSON.stringify(Array.isArray(plan.unchanged) ? plan.unchanged : []),
      JSON.stringify(Array.isArray(plan.success) ? plan.success : []),
      JSON.stringify(Array.isArray(plan.fail) ? plan.fail : []),
      windowDays.join(','),
      plan.confounders === undefined || plan.confounders === null ? null : String(plan.confounders),
      plan.rollbackConditions === undefined || plan.rollbackConditions === null ? null : String(plan.rollbackConditions),
      plan.rebuild === true ? 1 : 0,
      nowIso(),
    ],
  )
  return { plan: getObservationPlan(store, id), budget }
}

/** The newest plan for a publication, superseded ones included. `null` when there is none. */
export function getObservationPlan(store, id) {
  return hydratePlan(store.get('SELECT * FROM observation_plan WHERE id = ?', [String(id ?? '').trim()]))
}

/** The **active** plan for a publication — the one §8's cards will read. */
export function activeObservationPlan(store, publicationId) {
  return hydratePlan(store.get(
    "SELECT * FROM observation_plan WHERE publication_id = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    [String(publicationId ?? '').trim()],
  ))
}

/** Every plan of a publication, newest first — superseded ones stay visible (§6). */
export function listObservationPlans(store, publicationId) {
  return store.all(
    'SELECT * FROM observation_plan WHERE publication_id = ? ORDER BY created_at DESC, rowid DESC',
    [String(publicationId ?? '').trim()],
  ).map(hydratePlan)
}

/* ══════════════════════════════════════════════════════════════════════════
   模块 14 §8：观测节点
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * §8 的观测窗口是 `[观测起点, 现在]`。
 *
 * 起点取 `observation_start_at` 而不是 `published_at`：§6 把它单列，§9 说窗口自发布
 * 记录**重新计时**（偏离处置①把它推到现在）。用发布时间算，一条被重新起算的记录
 * 会立刻显示「所有节点都已过期」。
 */
function observationWindow(publication, now) {
  return { windowStart: publication.observationStartAt, windowEnd: now }
}

function dataFor(store, publication, now) {
  return checkObservationData(store, {
    asin: publication.asin,
    marketplace: publication.marketplace,
    ...observationWindow(publication, now),
  })
}

/**
 * 一行观测记录 → 视图。
 *
 * ## 状态以**派生**为准，表里那一列只是缓存
 *
 * `deriveStatus` 是权威：`pending` 是时间的函数（还没到点），`ready`/`blocked` 是
 * 「到点了 + 窗口内有没有数据」的函数。表里的 `status` 列只在 `ensureCheckpoints`
 * 时刷新一次，为的是让 `idx_observation_due` 能用来找「哪些该看了」—— 读的时候
 * 若以列为准，一个从没被扫描过的库会把所有节点显示成 `pending`，即使它们早就到期。
 *
 * `storedStatus` 一并给出，是为了让「列和派生不一致」这件事可被看见，而不是被
 * 悄悄修正掉。
 */
function hydrateCheckpoint(row, { now, data, materialised = true, publicationTerminatedAt = null }) {
  if (row === undefined || row === null) return null
  const conclusion = row.conclusion ?? null
  const terminatedAt = row.terminated_at ?? null
  /* 发布记录一旦被回滚终止，它的节点就不再是「待观测」—— 包括那些在终止之后才被视图
     补出来的虚拟节点。终止的权威在**发布记录**上（见 v32 的 migration 注释），所以
     这里以它为准，而不是只看这一行自己的 status：一行在终止时还不存在，它自己的
     status 里没有任何东西能说明这件事。 */
  const status = publicationTerminatedAt !== null && conclusion === null
    ? 'terminated'
    : deriveStatus({ storedStatus: row.status, dueAt: row.due_at, now, sufficient: data.sufficient })
  return {
    id: row.id,
    publicationId: row.publication_id,
    day: Number(row.day),
    dueAt: row.due_at,
    status,
    storedStatus: row.status,
    materialised,
    blockedReason: row.blocked_reason ?? null,
    missing: parse(row.missing_json, []),
    metrics: parse(row.metrics_json, null),
    conclusion,
    conclusionLabel: conclusion === null ? null : (CONCLUSION_LABELS[conclusion] ?? conclusion),
    conclusionNote: row.conclusion_note ?? null,
    concludedAt: row.concluded_at ?? null,
    concludedBy: row.concluded_by ?? null,
    terminatedAt,
    terminatedReason: row.terminated_reason ?? null,
    retiredAt: row.retired_at ?? null,
    retiredReason: row.retired_reason ?? null,
    createdAt: row.created_at,
    /* §9：「原观测结论**保留**并标注『已回滚终止』」。终止不删结论，只在旁边加一笔 ——
       于是「当时判断保留」和「后来整体回滚了」两件事同时成立，都能读到。 */
    conclusionTerminated: conclusion !== null && terminatedAt !== null,
    /* 哪些结论在这个节点上真的成立。由 domain 的 `refuteConclusion` 定义，这里只把
       结果摊开：页面据此只画可点的按钮，工具据此告诉模型能报什么 —— 两边都不自己
       猜一遍规则。 */
    availableConclusions: status === 'blocked'
      ? [...INSUFFICIENT_ONLY]
      : (status === 'ready' ? [...OBSERVATION_CONCLUSIONS] : []),
  }
}

/**
 * 一条发布记录的观测节点视图 = **当前计划的排期** ∪ **库里已有的行**。
 *
 * ## 为什么要并集，而不是只读库里已有的行
 *
 * 只读库会让「还没被扫描过」和「没有观测计划」长得一模一样：一条刚登记、还没人
 * 打开过观测视图的发布记录，卡片上会是空的，而它其实有 7/14/30 三个到期日。读到
 * 的东西比事实少，与读到的东西比事实多一样是错的 —— 前者会让人以为不用观测。
 *
 * 所以按 `checkpointSchedule` 补齐缺失的节点，标 `materialised: false`。这些节点
 * 有确定性 id（`checkpointIdFor`），下结论时会先物化（见 `saveObservationConclusion`），
 * 所以「看得见但点不动」不会发生。
 *
 * 库里**不在**排期里的行仍然列出（退休的、窗口刚变的）：它们是历史，不是垃圾。
 */
function checkpointViews(store, publication, now, data) {
  const plan = activeObservationPlan(store, publication.id)
  const schedule = checkpointSchedule(publication.observationStartAt, plan?.windowDays ?? null)
  const stored = store.all(
    'SELECT * FROM observation_checkpoint WHERE publication_id = ? ORDER BY day',
    [publication.id],
  )
  const byDay = new Map(stored.map(row => [Number(row.day), row]))
  const context = { now, data, publicationTerminatedAt: publication.observationTerminatedAt }

  const views = []
  for (const { day, dueAt } of schedule) {
    const row = byDay.get(day)
    if (row !== undefined) {
      byDay.delete(day)
      views.push(hydrateCheckpoint(row, context))
      continue
    }
    const terminated = publication.observationTerminatedAt !== null
    const status = terminated
      ? 'terminated'
      : deriveStatus({ storedStatus: 'pending', dueAt, now, sufficient: data.sufficient })
    views.push(hydrateCheckpoint({
      id: checkpointIdFor(publication.id, day),
      publication_id: publication.id,
      day,
      due_at: dueAt,
      status,
      blocked_reason: status === 'blocked' ? data.note : null,
      missing_json: status === 'pending' || terminated ? null : JSON.stringify(data.missing),
      metrics_json: null,
      conclusion: null,
      conclusion_note: null,
      concluded_at: null,
      concluded_by: null,
      terminated_at: publication.observationTerminatedAt,
      terminated_reason: publication.observationTerminatedReason,
      retired_at: null,
      retired_reason: null,
      created_at: null,
    }, { ...context, materialised: false }))
  }
  for (const row of byDay.values()) views.push(hydrateCheckpoint(row, context))

  return views.sort((left, right) => left.day - right.day)
}

/**
 * §8 的物化：把 §7 的观测窗口展开成到期节点。幂等 —— 每次调用只补缺的、刷新未终态的。
 *
 * ## 偏离未处置时**不物化**
 *
 * §6：「未选择前该 ASIN 观测卡片为 `waiting_human`」。此时观测起点还可能被处置①
 * 推到现在，现在算出来的到期日会建立在一个即将移动的起点上 —— 卡片上于是出现一批
 * 「已经过期」的节点，而它们其实一天都还没过。等处置完再算。
 *
 * 这个判据只有**这一处**：`scanDueObservations` 不另写一遍 `deviated && choice === null`，
 * 而是读这里的 `materialised === false`。两份同样的条件迟早会分叉，然后「扫描说该看、
 * 物化说不该看」会变成一条查不出来的告警。
 */
export function ensureCheckpoints(store, publicationId, { now = nowIso() } = {}) {
  const publication = getPublication(store, publicationId)
  if (publication === null) throw new Error(`no publication record ${publicationId}`)

  if (publication.deviated && publication.baselineChoice === null) {
    return {
      publication,
      materialised: false,
      blockedBy: 'waiting_human',
      created: 0,
      refreshed: 0,
      retired: 0,
      reason: `publication ${publicationId} deviated from the approved draft and nobody has decided how to handle it (§6). `
        + 'A 「以实际发布值为新基线」decision moves the observation start, so due dates cannot be fixed yet.',
    }
  }

  /* 已被回滚终止的观测**不再长出新节点**。没有这条，一条终止后又被扫描到的发布记录会
     凭空多出几个 `pending` 节点，于是卡片显示「还有 3 个观测没做」—— 而它早就结束了。 */
  if (publication.observationTerminatedAt !== null) {
    return {
      publication,
      materialised: false,
      blockedBy: 'terminated',
      created: 0,
      refreshed: 0,
      retired: 0,
      reason: `publication ${publicationId} had its observation terminated by a rollback at `
        + `${publication.observationTerminatedAt} — a terminated observation does not get new nodes (§9).`,
    }
  }

  const plan = activeObservationPlan(store, publication.id)
  const schedule = checkpointSchedule(publication.observationStartAt, plan?.windowDays ?? null)
  const data = dataFor(store, publication, now)
  /* 补数清单只在**到点之后**才有意义。`pending` 的节点上窗口天然是空的，把「什么都
     没有」写成清单会让人以为要去补数据 —— 而那个节点只是还没到期。 */
  const checklist = status => (status === 'pending' ? null : JSON.stringify(data.missing))

  let created = 0
  let refreshed = 0
  let retired = 0
  const scheduled = new Set(schedule.map(entry => entry.day))

  /* 窗口收窄时，旧节点**退休**而不是删掉。§7 的 `window_days` 是设计项，它会变
     （先登记发布、后补计划的顺序就会变），而「当时计划在第 30 天看」是要留下来的
     事实。用 `retired` 而不是 `terminated`：这不是回滚，卡片状态不能因此说「已回滚
     终止」（见 domain/observe/observation.js 的词表注释）。 */
  const holes = schedule.map(() => '?').join(', ')
  for (const row of store.all(
    `SELECT id, day, status FROM observation_checkpoint WHERE publication_id = ? AND day NOT IN (${holes})`,
    [publication.id, ...schedule.map(entry => entry.day)],
  )) {
    if (row.status === 'concluded' || row.status === 'terminated' || row.status === 'retired') continue
    store.run(
      "UPDATE observation_checkpoint SET status = 'retired', retired_at = ?, retired_reason = ?, blocked_reason = NULL, missing_json = NULL WHERE id = ?",
      [now, `观测窗口已改为 ${schedule.map(entry => entry.day).join(',')} 天（§7），第 ${row.day} 天不再在窗口里`, row.id],
    )
    retired += 1
  }

  for (const { day, dueAt } of schedule) {
    const status = deriveStatus({ storedStatus: 'pending', dueAt, now, sufficient: data.sufficient })
    const existing = store.get(
      'SELECT id, status FROM observation_checkpoint WHERE publication_id = ? AND day = ?',
      [publication.id, day],
    )
    if (existing === undefined) {
      /* `ON CONFLICT DO NOTHING` 加在 `UNIQUE (publication_id, day)` 上：并发或重入时
         宁可不插，也不要让「同一个节点两行」变成可能。计数读 `changes` 而不是加一 ——
         一个被 ON CONFLICT 吞掉的插入不该被算成新建。 */
      const result = store.run(
        `INSERT INTO observation_checkpoint
           (id, publication_id, day, due_at, status, blocked_reason, missing_json, metrics_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (publication_id, day) DO NOTHING`,
        [
          checkpointIdFor(publication.id, day), publication.id, day, dueAt, status,
          status === 'blocked' ? data.note : null, checklist(status), now,
        ],
      )
      if (Number(result?.changes ?? 0) > 0) created += 1
      continue
    }
    /* 终态是人的动作（或已结束的事实），不是时间的函数 —— 重算它们会让一个已下结论的
       节点在数据被清理之后倒回 `blocked`。 */
    if (existing.status === 'concluded' || existing.status === 'terminated' || existing.status === 'retired') continue
    store.run(
      'UPDATE observation_checkpoint SET status = ?, blocked_reason = ?, missing_json = ? WHERE id = ?',
      [status, status === 'blocked' ? data.note : null, checklist(status), existing.id],
    )
    refreshed += 1
  }

  return {
    publication,
    plan,
    data,
    materialised: true,
    blockedBy: null,
    created,
    refreshed,
    retired,
    checkpoints: checkpointViews(store, publication, now, data),
  }
}

/**
 * §9：「30 天无改善可触发回滚建议，但执行仍需人工确认」。
 *
 * ## 「30 天」是**默认窗口的最后一个节点**，不是硬编码的 30
 *
 * 观察窗口是 §7 的设计项（`observation_plan.window_days`）。写死 30 会让一份
 * 7/14 窗口的计划永远触发不了建议；而「最后一个节点」在任何窗口下都保持原意：
 * **给够了观察期再说要不要撤**。
 *
 * ## `insufficient` 不算「无改善」
 *
 * §12 验收 6：「不可比较或不能归因时明确说『不足以判断』」。没有数据支撑的
 * 「无改善」正是这个模块从头到尾在防的东西 —— 用它触发回滚，等于用「我没看」
 * 支持「撤回去」。所以只有 `watch` / `revise` / `rollback` 触发建议。
 */
export function rollbackReadiness(store, publicationId, { now = nowIso(), checkpoints = null } = {}) {
  const publication = getPublication(store, publicationId)
  if (publication === null) throw new Error(`no publication record ${publicationId}`)
  const all = checkpoints ?? checkpointViews(store, publication, now, dataFor(store, publication, now))

  /* 退休的节点不算数：它们不在当前窗口里，拿它们当「最后一个节点」会让一份改成 3/9
     天的计划永远等不到建议（它在等一个已经不看的第 30 天）。 */
  const nodes = all.filter(item => item.status !== 'retired')
  if (nodes.length === 0) {
    return {
      ready: false,
      checkpoint: null,
      reason: all.length === 0
        ? '这条发布记录还没有观测节点，先物化观测计划。'
        : '所有观测节点都已结束（回滚终止或窗口变更），不再产生建议。',
    }
  }
  const last = nodes[nodes.length - 1]
  if (last.status === 'terminated') {
    return { ready: false, checkpoint: last, reason: `第 ${last.day} 天的观测已被回滚终止，不再产生建议。` }
  }
  if (last.status !== 'concluded') {
    return {
      ready: false,
      checkpoint: last,
      reason: `最后一个观测节点（第 ${last.day} 天，${last.dueAt} 到期）还没有结论 —— 没有结论就谈不上「无改善」。`,
    }
  }
  if (last.conclusion === 'keep') {
    return { ready: false, checkpoint: last, reason: `第 ${last.day} 天的结论是「保留」，没有触发回滚建议的依据。` }
  }
  if (last.conclusion === 'insufficient') {
    return {
      ready: false,
      checkpoint: last,
      reason: `第 ${last.day} 天的结论是「无法判断」—— 数据不足不能作为回滚依据（§12 验收 6）。先补数再判。`,
    }
  }
  return {
    ready: true,
    checkpoint: last,
    reason: `第 ${last.day} 天的结论是「${last.conclusionLabel ?? last.conclusion}」，按 §9 可以生成回滚建议（执行仍需人工确认）。`,
  }
}

/**
 * 一条发布记录的完整 §8 卡片。
 *
 * `state` 是卡片级状态，比节点多两个：`waiting_human`（§6 偏离未处置）与
 * `terminated`（§9 回滚终止）。
 */
export function publicationObservation(store, publicationId, { now = nowIso() } = {}) {
  const publication = getPublication(store, publicationId)
  if (publication === null) return null
  const plan = activeObservationPlan(store, publication.id)
  const data = dataFor(store, publication, now)
  const checkpoints = checkpointViews(store, publication, now, data)
  const waitingHuman = publication.deviated && publication.baselineChoice === null
  /* 终止事实取自**发布记录**，不是节点行的最大值 —— 刚发布就撤回时没有节点行可看。 */
  const terminatedAt = publication.observationTerminatedAt
  return {
    publication,
    plan,
    data,
    checkpoints,
    waitingHuman,
    terminatedAt,
    terminatedReason: publication.observationTerminatedReason,
    state: cardState({ waitingHuman, terminatedAt, checkpoints }),
    rollback: rollbackReadiness(store, publication.id, { now, checkpoints }),
    nextDue: checkpoints.find(item => item.status === 'pending') ?? null,
    /* §12 验收 5：「7/14/30 天指标使用清晰周期和来源」—— 窗口与来源跟着卡片一起给，
       而不是留给读的人自己去别处找。 */
    window: observationWindow(publication, now),
  }
}

/** 一个 ASIN/站点（或全库）的观测卡片列表 —— 页面用。 */
export function listPublicationObservations(store, { asin = null, marketplace = null, limit = 50, now = nowIso() } = {}) {
  const listed = listPublications(store, { asin, marketplace, limit })
  return {
    rows: listed.rows.map(row => publicationObservation(store, row.id, { now })).filter(card => card !== null),
    total: listed.total,
    limit: listed.limit,
  }
}

/**
 * 一个观测节点的视图，按 id 取。**虚拟节点也能取到**（用确定性 id），
 * 所以「审计要记下结论之前那个节点是什么状态」不会因为节点还没落库而读成 null ——
 * `null` 在这里的意思是「没有这个节点」，不是「还没物化」。
 */
export function getCheckpoint(store, checkpointId, { now = nowIso() } = {}) {
  const key = String(checkpointId ?? '').trim()
  if (key === '') return null
  const row = store.get('SELECT publication_id FROM observation_checkpoint WHERE id = ?', [key])
  if (row !== undefined) {
    const card = publicationObservation(store, row.publication_id, { now })
    return card?.checkpoints.find(item => item.id === key) ?? null
  }
  const resolved = resolveVirtualCheckpoint(store, key)
  if (resolved === null) return null
  const card = publicationObservation(store, resolved.publication.id, { now })
  return card?.checkpoints.find(item => item.day === resolved.day) ?? null
}

/**
 * §8 的结论：人看完数据之后说的话。
 *
 * 守卫全部走 `refuteConclusion`（domain），这里只负责取数、冻结、落库。
 *
 * ## 冻结的是「下结论时的读数」，不是「现在的读数」
 *
 * 与 §6 的差异同样道理：结论落库之后数据还会变（窗口继续走、报告再导入），
 * 事后重算 `metrics_json` 会让「当时凭什么这么判」消失。所以快照在这里算一次就固定。
 */
/**
 * 从确定性 id 反推发布记录 —— 视图里的节点可能是**虚拟**的（还没物化）。
 *
 * 依赖 `checkpointIdFor` 的格式（`<publicationId>:d<day>`）。这是一个**约定**，所以
 * 它只在这一处被解析，而且解析失败时如实报错而不是猜。发布记录 id 形如
 * `pub-<uuid>`，不含 `:d`，所以这个正则不会切错。
 */
function resolveVirtualCheckpoint(store, checkpointId) {
  const match = /^(.*):d(\d+)$/.exec(String(checkpointId ?? '').trim())
  if (match === null) return null
  const publication = getPublication(store, match[1])
  return publication === null ? null : { publication, day: Number(match[2]) }
}

export function saveObservationConclusion(store, checkpointId, conclusion, { note = null, by = null, now = nowIso() } = {}) {
  const key = String(checkpointId ?? '').trim()
  if (key === '') throw new Error('checkpointId is required')

  const row = store.get('SELECT * FROM observation_checkpoint WHERE id = ?', [key])
  let publicationId = row === undefined ? null : row.publication_id
  let day = row === undefined ? null : Number(row.day)
  if (publicationId === null) {
    /* 视图会给没被扫描过的发布记录补出**虚拟**节点（`materialised: false`），而虚拟
       节点只是还没落库，不是不存在。从确定性 id 反推是哪一条发布记录。 */
    const resolved = resolveVirtualCheckpoint(store, key)
    if (resolved === null) throw new Error(`no observation checkpoint ${key}`)
    publicationId = resolved.publication.id
    day = resolved.day
  }

  /* 先按**视图**判定，再落库。顺序是刻意的：一个会被拒的调用不该在库里留下任何行，
     而「先物化再校验」会让每一次被拒都在库里留下一批没人要的节点。 */
  const card = publicationObservation(store, publicationId, { now })
  if (card === null) throw new Error(`checkpoint ${key} points at a publication record that no longer exists`)
  const view = card.checkpoints.find(item => item.day === day)
  if (view === undefined) {
    throw new Error(
      `observation checkpoint ${key} is not in the current observation window for ${publicationId} — `
      + 'it may have been retired when the plan window changed (§7)',
    )
  }

  const refusal = refuteConclusion({ conclusion, status: view.status, day: view.day, dueAt: view.dueAt })
  if (refusal !== null) throw new Error(refusal)

  if (view.materialised === false) ensureCheckpoints(store, publicationId, { now })

  const plan = activeObservationPlan(store, publicationId)
  const data = card.data
  const snapshot = snapshotMetrics(store, {
    asin: card.publication.asin,
    marketplace: card.publication.marketplace,
    ...observationWindow(card.publication, now),
    baselineStart: plan?.baselineStart ?? null,
    baselineEnd: plan?.baselineEnd ?? null,
  })

  const result = store.run(
    `UPDATE observation_checkpoint
        SET status = 'concluded', conclusion = ?, conclusion_note = ?, concluded_at = ?, concluded_by = ?,
            metrics_json = ?, missing_json = ?
      WHERE id = ?`,
    [
      String(conclusion).trim(),
      note === null ? null : String(note),
      now,
      by === null ? null : String(by),
      JSON.stringify(snapshot),
      JSON.stringify(data.missing),
      key,
    ],
  )
  /* 一行都没改到就是**失败**，不是「成功但无事发生」：这条 UPDATE 只在节点行不存在时
     才会空转，而那说明物化没成功（例如发布记录其实在 waiting_human）。静默返回会让
     调用方以为结论记下了。 */
  if (Number(result?.changes ?? 0) === 0) {
    throw new Error(
      `the conclusion for observation checkpoint ${key} was not written — the node is not in the store. `
      + 'It may be waiting on a §6 deviation decision, or the observation may already be terminated (§9).',
    )
  }

  const after = publicationObservation(store, publicationId, { now })
  return {
    checkpoint: after.checkpoints.find(item => item.day === day) ?? null,
    snapshot,
    card: after,
  }
}

/**
 * §9：「原观测结论保留并标注『已回滚终止』」。
 *
 * ## 已下结论的节点**保留** `concluded`，只加终止标注
 *
 * 把它们的 status 改成 `terminated` 会丢掉「这个节点当时是下过结论的」—— 而
 * 「当时判断保留，后来整体回滚了」正是这次回滚最该留下的记录。所以：
 * 已结论的加 `terminated_at`；没结论的直接转 `terminated`（它们从未产生结论，
 * 没什么可保留的）。
 *
 * 幂等：重复调用只更新没标过的行。
 */
export function terminateObservation(store, publicationId, reason, { now = nowIso() } = {}) {
  const publication = getPublication(store, publicationId)
  if (publication === null) throw new Error(`no publication record ${publicationId}`)
  const why = String(reason ?? '').trim()
  if (why === '') {
    throw new Error('a termination needs a reason — "why did we stop observing this" is the only thing this annotation will ever say')
  }

  /* 先盖发布记录 —— 这是「终止」这个事实的**唯一权威**，而且它必须在零节点的情况下
     也成立（刚发布就撤回）。重复终止时保留第一次的时刻与理由：第一次才是发生的那次。 */
  const firstTime = publication.observationTerminatedAt === null
  if (firstTime) {
    store.run(
      'UPDATE publication_record SET observation_terminated_at = ?, observation_terminated_reason = ? WHERE id = ?',
      [now, why, publication.id],
    )
  }

  const rows = store.all(
    'SELECT id, status, conclusion, terminated_at FROM observation_checkpoint WHERE publication_id = ?',
    [publication.id],
  )
  let terminated = 0
  let conclusionsKept = 0
  let already = 0
  let retiredSkipped = 0
  for (const row of rows) {
    if (row.terminated_at !== null) { already += 1; continue }
    /* 退休的节点不属于这次发布的观测，不该被盖上「已回滚终止」—— 它们早在窗口变更时
       就结束了，而且那次结束与回滚无关。 */
    if (row.status === 'retired') { retiredSkipped += 1; continue }
    if (row.status === 'concluded' || row.conclusion !== null) {
      store.run(
        'UPDATE observation_checkpoint SET terminated_at = ?, terminated_reason = ? WHERE id = ?',
        [now, why, row.id],
      )
      conclusionsKept += 1
    } else {
      store.run(
        "UPDATE observation_checkpoint SET status = 'terminated', blocked_reason = NULL, terminated_at = ?, terminated_reason = ? WHERE id = ?",
        [now, why, row.id],
      )
      terminated += 1
    }
  }

  return {
    publicationId: publication.id,
    terminated,
    conclusionsKept,
    alreadyTerminated: already,
    retiredSkipped,
    /* 重复终止时是 `false`：理由与时刻保留第一次的，这一次没有改动发布记录。 */
    stampedPublication: firstTime,
    reason: why,
    at: now,
  }
}

/* ── §8 的通知生产者 ──────────────────────────────────────────────────────── */

/** 通知链接的锚点约定：`#optimize#observation:<publicationId>`（见下）。 */
function observationLink(publication) {
  /* 页面链接是 `#<module>#<anchor>`（与 dashboard/todos.js 同一约定），而通知表只有
     `link` 一列、没有 filters。所以对象标识放进锚点：忽略后缀的页面仍然落在观测视图
     上（降级可用），认识后缀的页面可以直接展开那一条。 */
  return `#optimize#observation:${publication.id}`
}

/**
 * §8：「15 §6 的『7/14/30 天观测到期』通知在数据不足时**改写为**『观测数据待补』」。
 *
 * 用同一个 `dedupeKey`，所以它是在原地改写而不是并列多出一条 —— §15 的
 * 「同一问题去重聚合」正是靠这个键实现的，而不是靠调用方记得去查重。
 */
function notifyCheckpoint(store, card, checkpoint) {
  const publication = card.publication
  const blocked = checkpoint.status === 'blocked'
  const fillable = checkpoint.missing.filter(item => item.available === true)
  const noPath = checkpoint.missing.filter(item => item.available === false)
  const result = upsertNotification(store, {
    dedupeKey: `observation-due:${checkpoint.id}`,
    kind: 'observation-due',
    title: blocked
      ? `观测数据待补：${publication.asin} 第 ${checkpoint.day} 天`
      : `观测到期：${publication.asin} 第 ${checkpoint.day} 天`,
    body: blocked
      ? `观测窗口内没有可用数据，不能给出结论。可补 ${fillable.length} 类（排名/BSR/评分走采集，广告/SQP 走导入）；`
        + `${noPath.length} 类在本插件里没有通道。`
      : `窗口内有 ${card.data.present.length} 类数据可用，可以下结论。`,
    severity: blocked ? 'warn' : 'info',
    objectType: 'observation_checkpoint',
    objectId: checkpoint.id,
    link: observationLink(publication),
  })
  return { ...result, checkpointId: checkpoint.id, publicationId: publication.id, blocked }
}

function notifyRollbackReady(store, card) {
  const result = upsertNotification(store, {
    dedupeKey: `rollback-ready:${card.publication.id}`,
    kind: 'rollback-ready',
    title: `达到回滚条件：${card.publication.asin}`,
    body: `${card.rollback.reason} 系统不会代改，交付包生成后需人工在 Seller Central 改回并登记回滚发布记录。`,
    severity: 'warn',
    objectType: 'publication_record',
    objectId: card.publication.id,
    link: observationLink(card.publication),
  })
  return { ...result, publicationId: card.publication.id }
}

/**
 * §8/§15 §6 的到期扫描 —— 通知表**第一个真正的生产者**。
 *
 * 在此之前 `upsertNotification` 只有测试在调，所以通知面板在生产里一直是空的：
 * 「7/14/30 天观测到期」写在文档里，但没有任何代码会去算它。
 *
 * ## 它先物化，再报告
 *
 * 不物化就扫描，等于只看得见「已经被打开过的」发布记录 —— 一次都没被打开过的
 * 记录永远不会到期，于是通知也永远不会来。所以顺序是「先把节点算出来，再看哪些到点」。
 *
 * ## 一条坏记录不停下整次扫描
 *
 * 但要**记进结果**：安静跳过的失败与「本来就没有」在返回值里长得一样，而这两种
 * 情况该有的反应完全不同。
 */
export function scanDueObservations(store, { now = nowIso(), notify = true, limit = 200 } = {}) {
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 200), 1), 2000)
  const candidates = store.all(
    'SELECT id FROM publication_record ORDER BY published_at DESC, rowid DESC LIMIT ?',
    [cap],
  )

  const due = []
  const notified = []
  const errors = []
  let waitingHuman = 0
  let terminated = 0

  for (const candidate of candidates) {
    let materialised
    try {
      materialised = ensureCheckpoints(store, candidate.id, { now })
    } catch (error) {
      errors.push({ publicationId: candidate.id, error: error.message })
      continue
    }
    /* 分档按 `blockedBy` 而不是靠读理由字符串 —— 两种「没物化」的原因要用不同的数字
       报出去，而字符串匹配会在有人改一次措辞时静默错档。 */
    if (materialised.materialised === false) {
      if (materialised.blockedBy === 'terminated') terminated += 1
      else waitingHuman += 1
      continue
    }

    const card = publicationObservation(store, candidate.id, { now })
    if (card === null) continue

    for (const checkpoint of card.checkpoints) {
      if (checkpoint.status !== 'ready' && checkpoint.status !== 'blocked') continue
      due.push({ publicationId: card.publication.id, asin: card.publication.asin, checkpoint })
      if (notify) notified.push(notifyCheckpoint(store, card, checkpoint))
    }
    if (notify && card.rollback.ready) notified.push(notifyRollbackReady(store, card))
  }

  return {
    scanned: candidates.length,
    waitingHuman,
    terminated,
    due,
    notified,
    errors,
    at: now,
    note: due.length === 0
      ? '没有到期的观测节点。'
      : `${due.length} 个观测节点到期（其中 ${due.filter(item => item.checkpoint.status === 'blocked').length} 个数据不足）。`,
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   模块 14 §9：决策与回滚
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一条发布记录所描述的**线上状态**。
 *
 * `approved` 是「这次运行考虑过的每个字段的目标值」，`published` 是「运营实际填进去
 * 的」。实际填的优先（它就是当时线上被改成的样子），`approved` 补齐那些运营没有
 * 单独报告的字段 —— 它们没被改动，所以线上等于目标值。
 *
 * §9 的原话是回滚目标为「上一次实际发布记录**全字段**」，这个函数就是那个全字段。
 */
export function observedState(record) {
  if (record === null || record === undefined) return {}
  return { ...(record.approved ?? {}), ...(record.published ?? {}) }
}

/** 同一 ASIN/站点上**当前**最新的发布记录。 */
function livePublication(store, reference) {
  return hydratePublication(store.get(
    `SELECT * FROM publication_record
      WHERE asin = ? AND marketplace = ?
      ORDER BY published_at DESC, rowid DESC LIMIT 1`,
    [reference.asin, reference.marketplace],
  ))
}

/**
 * 同一 ASIN/站点上、比 `reference` **早**的那一条发布记录（§9 的回滚目标）。
 *
 * `rowid` 是并列时的第二判据：同一个毫秒里登记的两条记录，只按 `published_at` 排序
 * 会变成「看运气」—— 而回滚目标选错一条，交付包里的每个值都会错。
 */
function previousPublication(store, reference) {
  return hydratePublication(store.get(
    `SELECT * FROM publication_record
      WHERE asin = ? AND marketplace = ?
        AND (published_at < ?
             OR (published_at = ? AND rowid < (SELECT rowid FROM publication_record WHERE id = ?)))
      ORDER BY published_at DESC, rowid DESC LIMIT 1`,
    [reference.asin, reference.marketplace, reference.publishedAt, reference.publishedAt, reference.id],
  ))
}

/**
 * §9 的回滚交付包：当前线上值、回滚目标值、逐字段对照、人工回改清单。
 *
 * ## 它每次**重算**，不读生成时的那份快照
 *
 * 交付包的值来自两条发布记录，所以任何时刻重建都等于「那两条记录之间的差异」。
 * 生成时的那份只存进 `rollback_task.package_json` 留痕，不参与渲染 —— 一份会
 * 腐烂的快照被当成现行清单，会让人照着改错的值。
 *
 * ## 没有上一条记录时**拒收**，不回落成空
 *
 * §9 说得很清楚：「回滚恢复到已记录的实际发布历史，**而不是某个未发布草案**」。
 * 所以第一条发布记录没有可回滚的目标 —— 回落成「清空所有字段」是最糟的答案。
 */
export function buildRollbackPackage(store, publicationId) {
  const from = getPublication(store, publicationId)
  if (from === null) throw new Error(`no publication record ${publicationId}`)
  const to = previousPublication(store, from)
  if (to === null) {
    throw new Error(
      `publication ${publicationId} is the earliest recorded publication for ${from.asin}/${from.marketplace} — `
      + '§9 restores from recorded publication history, and there is nothing earlier to restore to. '
      + 'A rollback needs a previous **actual publication**, not an unpublished draft.',
    )
  }

  const currentState = observedState(from)
  const restoreState = observedState(to)
  const fields = [...new Set([...Object.keys(restoreState), ...Object.keys(currentState)])].sort()
    .map(field => ({ field, current: currentState[field] ?? null, restore: restoreState[field] ?? null }))
    .filter(entry => String(entry.current ?? '') !== String(entry.restore ?? ''))

  return {
    publicationId: from.id,
    asin: from.asin,
    marketplace: from.marketplace,
    currentFrom: { id: from.id, kind: from.kind, publishedAt: from.publishedAt, observed: currentState },
    restoreTo: { id: to.id, kind: to.kind, publishedAt: to.publishedAt, observed: restoreState },
    fields,
    /* 「人工回改操作清单」—— §9 明列的一项交付物。它必须是**可照着做**的一步一条，
       而不是一张差异表：差异表要人自己翻译成动作，而翻译错了没人发现。 */
    steps: fields.map((entry, index) => ({
      step: index + 1,
      field: entry.field,
      from: entry.current,
      to: entry.restore,
      instruction: entry.restore === null
        ? `把 ${entry.field} 清空`
        : `把 ${entry.field} 改回 ${JSON.stringify(entry.restore)}`,
    })),
    note: fields.length === 0
      ? '当前线上值与回滚目标逐字段相同 —— 这次回滚不会改变任何东西，先确认是不是选错了目标。'
      : `${fields.length} 个字段需要人工改回（见 steps）。本插件不代改 Seller Central。`,
  }
}

/**
 * §9：生成回滚交付包，状态「回滚待发布」。
 *
 * ## 两条前置条件都是真的会踩到的
 *
 *   - 被回滚的那一版必须**仍是线上那一版**。若之后又发布过一次，照旧回滚会丢掉那次
 *     新做的工作 —— 这不是理论：偏离处置②、局部修订都会产生新记录。
 *   - 同一个发布记录**同时只能有一个待发布回滚**。否则「回滚待发布」这句话没有
 *     唯一的含义，而闭环时也无法知道关的是哪一个。
 */
export function suggestRollback(store, publicationId, { reason = null, now = nowIso() } = {}) {
  const publication = getPublication(store, publicationId)
  if (publication === null) throw new Error(`no publication record ${publicationId}`)

  const live = livePublication(store, publication)
  if (live === null || live.id !== publication.id) {
    throw new Error(
      `publication ${publicationId} is no longer the live version for ${publication.asin}/${publication.marketplace}`
      + (live === null ? '' : ` — ${live.id} was published at ${live.publishedAt} and supersedes it`)
      + '. Rolling back from a superseded version would discard the newer work (§9).',
    )
  }

  const open = store.get(
    "SELECT id FROM rollback_task WHERE publication_id = ? AND status = 'pending_publish' ORDER BY created_at DESC LIMIT 1",
    [publication.id],
  )
  if (open !== undefined) {
    throw new Error(
      `publication ${publicationId} already has an open rollback task ${open.id} — one at a time, `
      + 'so that 「回滚待发布」 means exactly one thing',
    )
  }

  const pkg = buildRollbackPackage(store, publication.id)

  /* §9 的「30 天无改善可触发回滚建议」是**系统主动提醒**的条件，不是人工生成交付包的
     门槛。两者的区别很实际：库存断货、合规问题、差评爆发都可能在 30 天内就要求撤回，
     那时拒收交付包只会逼人去手工拼一份更不可追溯的清单。

     所以这里**不拦**，但把 readiness 一起返回 —— 提前回滚是一件要留痕的事，而不是
     一件要静默放行的事。主动提醒（`scanDueObservations` 的 `rollback-ready` 通知）
     仍然只按 readiness 触发。 */
  const readiness = rollbackReadiness(store, publication.id, { now })

  const id = `rb-${randomUUID()}`
  /* `from_publication_id` 与 `publication_id` 在生成时必然相同。分开存是因为 stale 判定
     要一个**不随新发布而移动**的锚点，而 `publication_id` 的语义是「这次回滚针对哪一版」，
     不是「当时线上是哪一版」—— 两者在任务进行中会分叉，分叉正是要判定的东西。 */
  store.run(
    `INSERT INTO rollback_task
       (id, publication_id, from_publication_id, to_publication_id, status, package_json, reason,
        created_at, closed_at, closed_by_publication_id)
     VALUES (?, ?, ?, ?, 'pending_publish', ?, ?, ?, NULL, NULL)`,
    [id, publication.id, publication.id, pkg.restoreTo.id, JSON.stringify(pkg),
      reason === null ? null : String(reason), now],
  )
  return {
    task: getRollbackTask(store, id),
    package: pkg,
    readiness,
    early: readiness.ready === false,
    note: readiness.ready
      ? readiness.reason
      : `这次回滚是**提前**发起的：${readiness.reason}`,
  }
}

function hydrateRollbackTask(store, row) {
  if (row === undefined || row === null) return null
  const publication = getPublication(store, row.publication_id)
  const live = publication === null ? null : livePublication(store, publication)
  const stale = row.status === 'pending_publish' && live !== null && live.id !== row.from_publication_id
  return {
    id: row.id,
    publicationId: row.publication_id,
    fromPublicationId: row.from_publication_id ?? null,
    toPublicationId: row.to_publication_id ?? null,
    status: row.status,
    statusLabel: row.status === 'pending_publish' ? '回滚待发布' : (row.status === 'closed' ? '已闭环' : '已取消'),
    package: parse(row.package_json, null),
    reason: row.reason ?? null,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? null,
    closedByPublicationId: row.closed_by_publication_id ?? null,
    livePublicationId: live?.id ?? null,
    stale,
    staleReason: stale
      ? `${live.id} 在 ${live.publishedAt} 发布，已经取代了这份交付包依据的 ${row.from_publication_id}。`
        + '照旧回滚会丢掉那次新做的工作 —— 先决定新的那一版怎么办。'
      : null,
  }
}

export function getRollbackTask(store, id) {
  const key = String(id ?? '').trim()
  if (key === '') return null
  return hydrateRollbackTask(store, store.get('SELECT * FROM rollback_task WHERE id = ?', [key]))
}

export function listRollbackTasks(store, { publicationId = null, status = null, limit = 50 } = {}) {
  const where = []
  const params = []
  if (publicationId !== null && String(publicationId).trim() !== '') {
    where.push('publication_id = ?'); params.push(String(publicationId).trim())
  }
  if (status !== null && String(status).trim() !== '') { where.push('status = ?'); params.push(String(status).trim()) }
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), 500)
  return {
    rows: store.all(
      `SELECT * FROM rollback_task ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [...params, cap],
    ).map(row => hydrateRollbackTask(store, row)),
    limit: cap,
  }
}

/**
 * §9 的闭环：登记一条 `rollback` 发布记录时，关掉对应的待发布任务，并终止原观测。
 *
 * 挂在**登记发布记录**上，不是挂在生成交付包上 —— §9 的原话是「用户按清单在 SC
 * 改回后，必须回到 §6 登记一条新发布记录……直到对应发布记录登记才闭环」。生成交付包
 * 的时候人还没改，那时闭环就是在说谎。
 *
 * 即使没有待发布任务也终止原观测：运营可能自己改回去然后直接登记，那次回滚同样是
 * 真的，原结论同样该标注「已回滚终止」。
 */
function closeRollbackFor(store, rollbackPublication) {
  const targetId = rollbackPublication.rollbackOf
  if (targetId === null || targetId === undefined || String(targetId).trim() === '') return null
  const now = nowIso()
  const open = store.get(
    "SELECT id FROM rollback_task WHERE publication_id = ? AND status = 'pending_publish' ORDER BY created_at DESC LIMIT 1",
    [String(targetId).trim()],
  )
  let taskId = null
  let closed = false
  if (open !== undefined) {
    const result = store.run(
      "UPDATE rollback_task SET status = 'closed', closed_at = ?, closed_by_publication_id = ? WHERE id = ? AND status = 'pending_publish'",
      [now, rollbackPublication.id, open.id],
    )
    closed = Number(result?.changes ?? 0) > 0
    taskId = open.id
  }
  const terminated = terminateObservation(
    store,
    targetId,
    `已回滚：${rollbackPublication.id} 在 ${rollbackPublication.publishedAt} 登记为回滚发布（§9）`,
    { now },
  )
  return { taskId, closed, terminated }
}
