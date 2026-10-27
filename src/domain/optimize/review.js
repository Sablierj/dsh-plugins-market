/**
 * Agent 审阅（F13-08 的第三块）—— 清单、结论、证据引用。
 *
 * ## 这一块补的是什么
 *
 * 审计 `RESEARCH-module-alignment-v2.0.md:353` 的原话：Agent 审阅那半
 * 「只有一张静态清单：结论不落库、不逐字段，没有「自然度 / 说服力 / 品牌语气」条目，
 * 也没有「结论引用证据」的载体」。四件事，这份文件一件一件对：
 *
 *   ① **一张静态清单** → `REVIEW_ITEMS` 是**可以下结论的那张单子**，14 项。
 *      其中 11 项**不是抄来的**：它们是 `listing-rules.js` 的 `LLM_ONLY_CHECKS`，
 *      这里 `map` 出来的。抄一份的后果是上游加一条检查、报告与面板还停在旧的 11 条 ——
 *      本仓对「同一件事两处写」的代价已经付过很多次。只补两样**显示**属性
 *      （中文标签、分组）与一样**归属**属性（`needsHuman`），`id / source / ask`
 *      原样取自上游。`reviewRoster()` 会把三边的漂移算出来（不抛错 ——
 *      `apply()` 抛错会拖垮整棵插件树），由测试钉住它是空的。
 *
 *   ② **结论不落库** → 一行一条结论，落在 `optimization_review`（schema v44）。
 *
 *   ③ **不逐字段** → 主键含 `field`：`field = ''` 是「整份草稿」这一条，
 *      `field = 'title'` 是逐字段的那一条。两者是**两条不同的结论**，不是同一条的两种填法。
 *
 *   ④ **没有「结论引用证据」的载体** → `evidence` 是 `{ kind, ref }` 的数组，
 *      而且它**可被证伪**：`rule` 必须是真实存在的规则 id、`draft` 必须是这一轮真的
 *      有的字段、`evidence` 必须是一个真的证据类。解不开就拒
 *      （`REVIEW_EVIDENCE_UNRESOLVED`，逐条报）。一段自由文字做不到这件事 ——
 *      这正是「有依据」与「声称有依据」的区别。
 *
 * ## 状态由内容重算
 *
 * 表里**没有** `state` 列。一项的汇总状态（`pending` / `pass` / `fail` / `unclear`）
 * 由它下面的行重算（`reviewItemState`），写入方没有自报的机会。
 * 「这一项没有人下过结论」（没有行，`pending`）与「下过结论是 unclear」分开：
 * 前者是**没有数据**，后者是**数据说判不了** —— 本仓把这两句压成一句已经付过代价。
 *
 * ## 三值，不是布尔
 *
 * `pass` / `fail` / `unclear`。`unclear` **必须带一句 note**：一个「判不了」而不说
 * 判不了什么的结论，读者拿它没有任何办法（是缺数据、还是要人对着实物看？）。
 * 这跟 `absent` / `not_modelled` 必须带 note 是同一条纪律。
 *
 * 英文注释解释「为什么」；本文件的注释与代码不符按缺陷处理。
 */

import { LLM_ONLY_CHECKS, RULES } from '../rules/listing-rules.js'
import { listOptimizationDrafts } from '../../store/queries.js'
import { labelForField } from '../rules/listing-fields.js'
import { EVIDENCE_KINDS } from './evidence.js'

export const REVIEW_VERSION = 'optimize-review.v1'

export const REVIEW_SOURCE =
  'listing-rules.js 的 LLM_ONLY_CHECKS（11 项）+ 本批新增三项（自然度 / 说服力 / 品牌语气）'

/** The three conclusions. Not a boolean: "could not judge" is a real answer. */
export const REVIEW_CONCLUSIONS = ['pass', 'fail', 'unclear']

export const REVIEW_CODES = {
  NO_RUN: 'REVIEW_NO_RUN',
  UNKNOWN_ITEM: 'REVIEW_UNKNOWN_ITEM',
  UNKNOWN_FIELD: 'REVIEW_UNKNOWN_FIELD',
  BAD_CONCLUSION: 'REVIEW_BAD_CONCLUSION',
  NOTE_REQUIRED: 'REVIEW_NOTE_REQUIRED',
  EVIDENCE_REQUIRED: 'REVIEW_EVIDENCE_REQUIRED',
  EVIDENCE_UNRESOLVED: 'REVIEW_EVIDENCE_UNRESOLVED',
  STATE_MISMATCH: 'REVIEW_STATE_MISMATCH',
  /* 批量入口专用：这一批里有不合法的条目，**一条都没写**。 */
  BATCH_REJECTED: 'REVIEW_BATCH_REJECTED',
}

/** What each evidence reference points at. `ref` must resolve for every one of them. */
export const REVIEW_EVIDENCE_KINDS = ['rule', 'draft', 'evidence', 'fact', 'human']

/** Reader-facing group names. The ids come from the roster; only the words are here. */
const REVIEW_GROUPS = {
  fact: '事实与依据',
  intent: '意图与说服',
  structure: '结构与自然度',
  brand: '品牌与合规',
}

/**
 * 显示属性（中文标签）与归属属性（要不要人），**按 id** 挂在 LLM_ONLY_CHECKS 的 11 项上。
 *
 * 为什么这两张表不与 `LLM_ONLY_CHECKS` 写在一起：那个文件不在本批的写作用域里
 * （它是规则中心的词表）。而这两样**不是判据** —— 判据（`ask` / `source`）仍然只有
 * 上游那一份。改判据只可能改 `listing-rules.js`，改叫法只可能改这里。
 */
const REVIEW_LABELS = {
  'audit.hallucination': '虚假声称',
  'audit.contradiction': '前后矛盾',
  'audit.intent.coverage': '意图匹配',
  'audit.cosmo.causal': 'COSMO 因果链',
  'audit.npo': '名词短语',
  'audit.review.alignment': '差评回应',
  'audit.geo.answerable': '可摘录回答',
  'audit.qa.buyer': 'Q&A 播种',
  'audit.aplus.increment': 'A+ 增量',
  'audit.attribute.fact': '属性与实物一致',
  'audit.ai.disclosure': 'AI 生成披露',
}

const REVIEW_ITEM_GROUP_OF = {
  'audit.hallucination': 'fact',
  'audit.contradiction': 'fact',
  'audit.intent.coverage': 'intent',
  'audit.cosmo.causal': 'structure',
  'audit.npo': 'structure',
  'audit.review.alignment': 'intent',
  'audit.geo.answerable': 'intent',
  'audit.qa.buyer': 'intent',
  'audit.aplus.increment': 'structure',
  'audit.attribute.fact': 'fact',
  'audit.ai.disclosure': 'brand',
}

/**
 * 这三项**只能由人下结论**，而且理由是三条不同的理由 —— 不是一句「机器判不了」。
 *
 *   · `audit.attribute.fact`：规则文档自己写死了「属性是事实，模型只能提议，必须由人确认」
 *     （`LLM_ONLY_CHECKS` 的 `ask` 里就有这句）。
 *   · `audit.ai.disclosure`：AI 生成占比是**最终图片/视频资产**的属性，而本插件既没有
 *     图片也没有视频的生成方式 —— 它连看都看不到那两样。
 *   · `audit.brand_voice`：见下面那条注释，本仓没有语气的来源。
 */
const REVIEW_NEEDS_HUMAN = ['audit.attribute.fact', 'audit.ai.disclosure', 'audit.brand_voice']

/**
 * 审计点名缺的三项。`id` 沿用 `audit.*` 前缀，与上游那 11 项同一套命名。
 *
 * `audit.brand_voice` 的 `source` 是**这次实测**写出来的：本仓有 `brand` 表
 * （`schema.js` v17：`name / aliases_json / forbidden_json / is_own / note`），
 * 所以「品牌名怎么写、哪些写法禁用」是有来源的；但**语气（郑重 / 轻松 / 技术 /
 * 生活化）没有任何一列存它**，也没有采集节去采它。因此这一项的结论只能来自人 ——
 * 注意这**不是** `not_modelled`：这一项**建模了**（它在清单里、有人能下结论），
 * 缺的是本仓没有语气的**来源**，报告与面板都要把这两句分开说。
 */
const EXTRA_REVIEW_ITEMS = [
  {
    id: 'audit.naturalness',
    label: '自然度',
    group: 'structure',
    source: 'SOP §9.3.1 / 可读性',
    ask: '读起来是不是母语者会写的句子，而不是把关键词一个个塞进去的堆砌（同一个词在一句话里被硬塞两遍也算）',
    needsHuman: false,
  },
  {
    id: 'audit.persuasion',
    label: '说服力',
    group: 'intent',
    source: '§11.2 买家决策五问',
    ask: '每个卖点是否回答了「为什么买这个而不是隔壁那个」—— 只描述功能、说不出差异的不算',
    needsHuman: false,
  },
  {
    id: 'audit.brand_voice',
    label: '品牌语气',
    group: 'brand',
    source: 'brand 表（name / aliases_json / forbidden_json）—— 只有品牌名与禁用写法，没有语气',
    ask: '文案的语气是否与品牌一贯的语气一致（郑重 / 轻松 / 技术 / 生活化）',
    needsHuman: true,
  },
]

/**
 * 14 项清单：上游 11 项在前、本批新增 3 项在后，顺序固定。
 *
 * 顺序固定不是审美：`REVIEW_ITEM_IDS` 会被报告、工具输出与页面同时按序渲染，
 * 一处按项排、一处按状态排会让「第 7 项」在两个地方指两个东西。
 */
export const REVIEW_ITEMS = [
  ...LLM_ONLY_CHECKS.map(check => ({
    id: check.id,
    label: REVIEW_LABELS[check.id] ?? check.id,
    ask: check.ask,
    source: check.source,
    group: REVIEW_ITEM_GROUP_OF[check.id] ?? 'fact',
    needsHuman: REVIEW_NEEDS_HUMAN.includes(check.id),
    origin: 'listing-rules.LLM_ONLY_CHECKS',
  })),
  ...EXTRA_REVIEW_ITEMS.map(item => ({
    ...item,
    group: item.group ?? 'fact',
    needsHuman: item.needsHuman === true,
    origin: 'b13d',
  })),
]

export const REVIEW_ITEM_IDS = REVIEW_ITEMS.map(item => item.id)

export const REVIEW_ITEM_BY_ID = Object.fromEntries(REVIEW_ITEMS.map(item => [item.id, item]))

/** A group's reader-facing name, or the raw id when someone adds a group and no word. */
export function reviewGroupLabel(group) {
  return REVIEW_GROUPS[group] ?? String(group ?? '')
}

/**
 * 清单三边是否一致 —— 算出来，不抛。
 *
 * `apply()` 里抛错会拖垮整棵插件树（`docs/plugin-contract.md` §4），所以这里只把
 * 不一致**当成数据**交出去，由测试断言它是空的。三个检查各对一件事：
 *   · `missing`  —— 上游新加了一条检查，本文件没跟上（报告与面板会漏掉它）；
 *   · `duplicate` —— 同一个 id 出现两次（同一件事两行，状态算两遍）；
 *   · `unlabelled` —— 上游新加的检查没有中文标签（面板上会印出一个 id）。
 */
export function reviewRoster() {
  const ids = REVIEW_ITEMS.map(item => item.id)
  const upstream = LLM_ONLY_CHECKS.map(check => check.id)
  const extras = EXTRA_REVIEW_ITEMS.map(item => item.id)
  const seen = new Set()
  const duplicate = []
  for (const id of ids) {
    if (seen.has(id)) duplicate.push(id)
    seen.add(id)
  }
  return {
    items: REVIEW_ITEMS,
    ids,
    drift: {
      missing: upstream.filter(id => !seen.has(id)),
      duplicate,
      unlabelled: upstream.filter(id => REVIEW_LABELS[id] === undefined),
      extra: extras.filter(id => !seen.has(id)),
    },
  }
}

/* ── 状态重算 ──────────────────────────────────────────────────────────────── */

/**
 * 一项的汇总状态，只看它下面的行。
 *
 *   fail     —— 至少一条 fail（一项里有任何一条不过，这一项就不过）
 *   unclear  —— 没有 fail，但有 unclear（判不了的比通过的更值得先看）
 *   pass     —— 全部 pass
 *   pending  —— **一条行都没有**（不是 pass，也不是 unclear）
 *
 * 「有行」与「没有行」在这里第一次分开，后面所有地方都靠它：`counts.rows === 0`
 * 是唯一能得出 `pending` 的条件。
 */
export function reviewItemState(rows = []) {
  const list = Array.isArray(rows) ? rows : []
  const counts = { pass: 0, fail: 0, unclear: 0 }
  for (const row of list) {
    const conclusion = String(row?.conclusion ?? '')
    if (counts[conclusion] !== undefined) counts[conclusion] += 1
  }
  const state = list.length === 0
    ? 'pending'
    : counts.fail > 0
      ? 'fail'
      : counts.unclear > 0
        ? 'unclear'
        : 'pass'
  return {
    state,
    counts: { ...counts, rows: list.length },
    fields: list.map(row => String(row?.field ?? '')).filter(field => field !== ''),
  }
}

const CONCLUSION_LABELS = { pass: '通过', fail: '不通过', unclear: '判不了', pending: '没有结论' }

export function reviewStateLabel(state) {
  return CONCLUSION_LABELS[state] ?? String(state ?? '')
}

/* ── 读写 ──────────────────────────────────────────────────────────────────── */

const parseJson = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

const trim = (value) => String(value ?? '').trim()

function hydrateReviewRow(row) {
  if (row === null || row === undefined) return null
  return {
    runId: row.run_id,
    itemId: row.item_id,
    field: row.field ?? '',
    conclusion: row.conclusion,
    note: row.note ?? null,
    evidence: parseJson(row.evidence_json, []),
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by ?? null,
    updatedAt: row.updated_at,
  }
}

/** Every review row of one run, hydrated. The only reader of the table. */
export function listReviewRows(store, runId) {
  const run = trim(runId)
  if (run === '') return []
  const rows = store.all(
    'SELECT * FROM optimization_review WHERE run_id = ? ORDER BY item_id, field',
    [run],
  )
  return rows.map(hydrateReviewRow)
}

/** The raw row — the same SELECT the reconciliation uses, so audit reads one shape. */
export function readReviewRow(store, runId, itemId, field = '') {
  const row = store.get(
    'SELECT * FROM optimization_review WHERE run_id = ? AND item_id = ? AND field = ?',
    [trim(runId), trim(itemId), trim(field)],
  )
  return row ?? null
}

const REVIEW_NO_RUN = (runId) => ({
  ok: false,
  code: REVIEW_CODES.NO_RUN,
  error: `没有第 ${trim(runId).slice(0, 8)} 轮优化 —— 审阅结论挂在轮次上，先跑一次 amzn_optimize_prepare。`,
})

/** Everything a reader needs about one run's Agent review. */
export function readReview(store, runId) {
  const run = store.get('SELECT * FROM optimization_run WHERE id = ?', [trim(runId)]) ?? null
  if (run === null) return REVIEW_NO_RUN(runId)

  const rows = listReviewRows(store, run.id)
  const byItem = new Map()
  for (const row of rows) {
    if (!byItem.has(row.itemId)) byItem.set(row.itemId, [])
    byItem.get(row.itemId).push(row)
  }

  const items = REVIEW_ITEMS.map(item => {
    const own = byItem.get(item.id) ?? []
    const state = reviewItemState(own)
    return {
      id: item.id,
      label: item.label,
      ask: item.ask,
      source: item.source,
      group: item.group,
      groupLabel: reviewGroupLabel(item.group),
      needsHuman: item.needsHuman,
      origin: item.origin,
      state: state.state,
      stateLabel: reviewStateLabel(state.state),
      counts: state.counts,
      /* 逐字段的那几条；`field === ''` 的「整份草稿」那一条也在里面，读的时候看 field。 */
      rows: own.map(row => ({ ...row, fieldLabel: row.field === '' ? '整份草稿' : labelForField(row.field) })),
    }
  })

  const counts = {
    items: REVIEW_ITEMS.length,
    pending: items.filter(item => item.state === 'pending').length,
    pass: items.filter(item => item.state === 'pass').length,
    fail: items.filter(item => item.state === 'fail').length,
    unclear: items.filter(item => item.state === 'unclear').length,
    rows: rows.length,
    fields: new Set(rows.map(row => row.field).filter(field => field !== '')).size,
  }

  return {
    ok: true,
    runId: run.id,
    asin: run.asin,
    marketplace: run.marketplace,
    status: run.status,
    /* 「有没有人审过」与「审的结果是什么」分开：present 为假时，14 项全是 pending，
       而那不是「14 项都没通过」。 */
    present: rows.length > 0,
    items,
    counts,
    /* 两个词表随载荷带出去：页面上的下拉框直接用它渲染，不在页面里再写一份
       「三值是哪三个」—— 页面里写死的那一份会在加值的时候静默变成旧词表。 */
    conclusions: [...REVIEW_CONCLUSIONS],
    evidenceKinds: [...REVIEW_EVIDENCE_KINDS],
    /* 清单三边是否一致。正常情况下永远是空对象里的空数组；测试钉住它。 */
    rosterDrift: reviewRoster().drift,
    empty: rows.length > 0
      ? null
      : {
        kind: 'no-review',
        text: '这一轮还没有任何审阅结论 —— 这 14 项是**没有人下过结论**，不是「全部通过」。'
          + '结论由人/Agent 逐项写下（每条必须引用可核对的证据），落在 optimization_review 上。',
      },
  }
}

/* ── 证据引用 ──────────────────────────────────────────────────────────────── */

/**
 * 把一次提交的证据引用逐条解开。
 *
 * 返回 `{ refs, unresolved }`，`unresolved` 里每条都带着「为什么解不开」——
 * 一个只报「第 2 条不对」的拒绝会让人回去猜。三种 `kind` 各有各的解：
 *   · rule     → `RULES` 的 id（`listing-rules.js` 的规则台账，唯一的规则名单）
 *   · draft    → 这一轮真的有的字段（`optimization_draft.field`）
 *   · evidence → `EVIDENCE_KINDS` 的 id（模块 13 的十类证据）
 * `fact` 与 `human` 是**人写的自由文字**（事实台账的标签是动态的、人看过什么是描述），
 * 只要求非空 —— 编一个假的 fact 名字没有意义，因为没人能列举所有事实名。
 */
function resolveEvidence(store, run, evidence) {
  const ruleIds = new Set(RULES.map(rule => rule.id))
  const draftFields = new Set(listOptimizationDrafts(store, run.id).map(draft => draft.field))
  const evidenceIds = new Set(EVIDENCE_KINDS.map(kind => kind.id))
  const refs = []
  const unresolved = []
  for (const [index, entry] of (Array.isArray(evidence) ? evidence : []).entries()) {
    const kind = trim(entry?.kind)
    const ref = trim(entry?.ref)
    if (!REVIEW_EVIDENCE_KINDS.includes(kind)) {
      unresolved.push({ index, kind, ref, why: `kind 必须是 ${REVIEW_EVIDENCE_KINDS.join(' / ')} 之一` })
      continue
    }
    if (ref === '') {
      unresolved.push({ index, kind, ref, why: 'ref 不能是空的 —— 一个指不到东西的引用等于没有引用' })
      continue
    }
    if (kind === 'rule' && !ruleIds.has(ref)) {
      unresolved.push({ index, kind, ref, why: '规则台账（listing-rules.js 的 RULES）里没有这个 id' })
      continue
    }
    if (kind === 'draft' && !draftFields.has(ref)) {
      unresolved.push({ index, kind, ref, why: '这一轮没有这个字段的草案 —— 引用一个不存在的字段是在引用空气' })
      continue
    }
    if (kind === 'evidence' && !evidenceIds.has(ref)) {
      unresolved.push({ index, kind, ref, why: '不是模块 13 的十类证据之一（domain/optimize/evidence.js 的 EVIDENCE_KINDS）' })
      continue
    }
    refs.push({ kind, ref })
  }
  return { refs, unresolved }
}

/* ── 写 ────────────────────────────────────────────────────────────────────── */

/**
 * 一条结论的**全部校验**，不写任何东西。
 *
 * 拆出来是为了那个批量入口（`amzn_optimize_review` 一次记多条）：先逐条校验、
 * 有坏的**一条都不写**，否则「3 条里第 2 条写错了」会留下一个半批的写入 ——
 * 而半批写入是没法解释的：库里那两行看起来与一次故意提交的两行完全一样。
 * `recordReview` 内部也走这个函数，所以「工具校验用的判据」与「写入用的判据」
 * 是同一个，不存在两套。
 */
export function checkReviewInput(store, runId, entry = {}) {
  const run = store.get('SELECT * FROM optimization_run WHERE id = ?', [trim(runId)]) ?? null
  if (run === null) return REVIEW_NO_RUN(runId)

  const item = REVIEW_ITEM_BY_ID[trim(entry?.itemId)] ?? null
  if (item === null) {
    return {
      ok: false,
      code: REVIEW_CODES.UNKNOWN_ITEM,
      error: `审阅清单里没有 ${trim(entry?.itemId)} —— 清单是 14 项（review.js 的 REVIEW_ITEMS），`
        + '加一项就是给这一轮编一条新判据。',
    }
  }

  const field = trim(entry?.field)
  if (field !== '') {
    const known = listOptimizationDrafts(store, run.id).map(draft => draft.field)
    if (!known.includes(field)) {
      return {
        ok: false,
        code: REVIEW_CODES.UNKNOWN_FIELD,
        error: `这一轮没有 ${field} 这个字段的草案 —— 审阅结论只能挂在这一轮真的有的字段上。`
          + `（这一轮有 ${known.length} 个字段。）`,
      }
    }
  }

  const conclusion = trim(entry?.conclusion)
  if (!REVIEW_CONCLUSIONS.includes(conclusion)) {
    return {
      ok: false,
      code: REVIEW_CODES.BAD_CONCLUSION,
      error: `conclusion 必须是 ${REVIEW_CONCLUSIONS.join(' / ')} 之一 —— 「判不了」也是一个结论，`
        + '不要把它压成 false。',
    }
  }

  const note = entry?.note === null || entry?.note === undefined ? null : String(entry.note)
  if (conclusion === 'unclear' && (note === null || note.trim() === '')) {
    return {
      ok: false,
      code: REVIEW_CODES.NOTE_REQUIRED,
      error: 'unclear 必须带一句 note 说清「判不了什么」（缺哪份数据、还是要人对着什么看一眼）——'
        + '一个不说什么判不了的「判不了」，读者拿它没有任何办法。',
    }
  }

  const evidence = entry?.evidence
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return {
      ok: false,
      code: REVIEW_CODES.EVIDENCE_REQUIRED,
      error: '结论必须引用证据（evidence 至少一条 { kind, ref }）。'
        + '这条要求的反面就是审计说的那个缺口：一句「我看过了」不是审阅。',
    }
  }
  const { refs, unresolved } = resolveEvidence(store, run, evidence)
  if (unresolved.length > 0) {
    return {
      ok: false,
      code: REVIEW_CODES.EVIDENCE_UNRESOLVED,
      unresolved,
      error: `有 ${unresolved.length} 条证据引用解不开：`
        + unresolved.map(entry2 => `[${entry2.index}] ${entry2.kind}:${entry2.ref} —— ${entry2.why}`).join('；'),
    }
  }

  return { ok: true, run, item, field, conclusion, note, refs }
}

/**
 * 写一条审阅结论。**写完读回那一行、重算状态、与这次意图比对。**
 *
 * `expected` 是这次意图应当产生的状态（写之前那一项的行 + 这一条，重算）；
 * `actual` 是**写之后从库里读回来的行**重算出来的。写入没落地、落到了别的键上、
 * 或者列名写错了，两者就会分叉 → `REVIEW_STATE_MISMATCH`，不谎报成功
 * （与 B-13c 的 `confirmStrategy` 同一条理由、同一种做法）。
 *
 * 幂等：同 (item, field) 再写一次同样的内容 → `unchanged: true`，不动时刻戳。
 * 内容**变了** → 覆盖并更新 `reviewed_at`：一条能被后来的审阅改掉的结论，
 * 才是一条结论；改不掉的是刻在石头上的字，而石头上的字不会因为有人不同意就变对。
 */
export function recordReview(store, {
  runId,
  itemId,
  field = '',
  conclusion,
  note = null,
  evidence = [],
  by = null,
  now = new Date(),
} = {}) {
  const checked = checkReviewInput(store, runId, { itemId, field, conclusion, note, evidence })
  if (checked.ok !== true) return checked

  const { run, item, refs } = checked
  const fieldValue = checked.field
  const value = checked.conclusion
  const noteValue = checked.note

  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  const existing = readReviewRow(store, run.id, item.id, fieldValue)
  const payload = JSON.stringify(refs)
  const unchanged = existing !== null
    && String(existing.conclusion) === value
    && String(existing.note ?? '') === String(noteValue ?? '')
    && String(existing.evidence_json) === payload

  /* The rows this item should have after the write, built from what the intent says.
     Compared below against what the table actually gives back. */
  const intendedRows = listReviewRows(store, run.id)
    .filter(row => row.itemId === item.id && row.field !== fieldValue)
    .concat([{ itemId: item.id, field: fieldValue, conclusion: value }])

  if (existing === null) {
    store.run(
      `INSERT INTO optimization_review
         (run_id, item_id, field, conclusion, note, evidence_json, reviewed_at, reviewed_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [run.id, item.id, fieldValue, value, noteValue, payload, at, by === null || by === undefined ? null : String(by), at],
    )
  } else if (!unchanged) {
    store.run(
      `UPDATE optimization_review SET conclusion = ?, note = ?, evidence_json = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ?
       WHERE run_id = ? AND item_id = ? AND field = ?`,
      [value, noteValue, payload, at, by === null || by === undefined ? null : String(by), at, run.id, item.id, fieldValue],
    )
  }

  /* ── 读回对账 ────────────────────────────────────────────────────────────── */
  const after = listReviewRows(store, run.id).filter(row => row.itemId === item.id)
  const state = reviewItemState(after)
  const expectedState = reviewItemState(intendedRows).state
  const row = after.find(entry => entry.field === fieldValue) ?? null
  if (row === null || row.conclusion !== value) {
    return {
      ok: false,
      code: REVIEW_CODES.STATE_MISMATCH,
      error: `写完之后读回 (${item.id}, ${fieldValue || '整份草稿'}) 得到的是`
        + `${row === null ? '「没有这一行」' : `「${row.conclusion}」`}，`
        + `按这次意图它应当是「${value}」—— 这次写入没有产生它声称的结果。`,
    }
  }
  if (state.state !== expectedState) {
    return {
      ok: false,
      code: REVIEW_CODES.STATE_MISMATCH,
      error: `写完之后重算 ${item.id} 的汇总状态是「${state.state}」，按这次意图它应当是「${expectedState}」——`
        + '这次写入没有落在它该落的那一项上。',
    }
  }

  return {
    ok: true,
    runId: run.id,
    itemId: item.id,
    field: fieldValue,
    conclusion: value,
    note: noteValue,
    evidence: refs,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    unchanged,
    state: state.state,
    counts: state.counts,
  }
}
