/**
 * The per-ASIN data health summary (module 05, F05-07).
 *
 * ## Not the home page's six cards
 *
 * `domain/dashboard/health.js` draws six **workspace-level** cards — a freshness
 * rate over every ASIN in scope, a collection success rate, and so on. This is a
 * different question: "how healthy is *this* ASIN's data", where two of the six
 * items (43-attribute coverage and the optimization pre-flight) only have a meaning
 * for one product. Both exist; neither replaces the other, and this module does not
 * touch the cards.
 *
 * ## Every item names its denominator, its source and its criterion
 *
 * §19.2 F05-07: 「必须显示分母和扣分项」. So an item is never just a number: it
 * carries `numerator`, `denominator` (`null` when the item is a count rather than a
 * ratio), `missing` (the specific things that are not there, named), `source` (the
 * table or module the number came from) and `basis` (the sentence that says what was
 * counted). A conclusion with no denominator is an opinion.
 *
 * ## 没有数据 ≠ 数据是 0 —— and the four states say which
 *
 * `state` answers *whether the item could be measured*, not whether the answer is
 * good:
 *
 *   - `ok`        — there was something to measure. `0/43` is an `ok` item whose
 *                   answer happens to be zero: the column was written and nothing in
 *                   it is filled.
 *   - `empty`     — the item's own subject has **never been written** (`listing`
 *                   row's `attributes_json` IS NULL, or this ASIN has no provenance
 *                   rows at all). The conclusion still prints `0/N`, because the
 *                   denominator is fixed and known; what `empty` adds is that the
 *                   zero is "nobody has recorded this yet", which is a different
 *                   repair from "recorded and incomplete".
 *   - `no-source` — **this repository has no source for this item at all.** Nothing
 *                   to fix by collecting; the item cannot be computed here. Printed
 *                   as {@link ASIN_HEALTH_NO_SOURCE_TEXT}, never as a zero, a grey
 *                   dot or a blank.
 *   - `error`     — the item's own builder could not produce an answer.
 *
 * ## Two things this module refuses to compute, and says so
 *
 * The `unsourced[]` list is the honest half of F05-07. Each entry is a criterion a
 * reader would reasonably expect to find in a health summary and that this
 * repository **cannot** answer — with the reason (which table is missing what)
 * rather than a plausible-looking zero. See {@link ASIN_HEALTH_UNSOURCED}.
 *
 * ## The numbers come from where they were computed, not from a second pass
 *
 * Core-field completeness and freshness are the same two facts `buildFieldFacts`
 * already produced for the detail view; 43-attribute coverage and the pre-flight
 * are module 13's answers, read out of its report. This module **derives nothing
 * twice** — the caller injects `fields` and `precheck`, and an absent injection is a
 * programming error that throws, exactly like `buildOverview` refusing an absent
 * `archived`. A health summary whose numbers came from its own arithmetic would be
 * the second opinion this repository keeps paying for.
 */

import { REQUIRED_ATTRIBUTE_TARGET } from '../rules/attributes.js'
import { DIMENSION_LABELS } from '../data/quality-rules.js'
import { FRESHNESS_DAYS, freshnessLabel } from '../data/freshness.js'
import { listIssues } from '../../store/quality.js'
import { listConflicts } from '../../store/conflict.js'
import { listFieldSources } from '../../store/field-source.js'
import { fieldConflictsOf } from './conflicts.js'
import { ASIN_NO_SOURCE_TEXT } from './unsourced.js'

/** The six items, in the order the page draws them. */
export const ASIN_HEALTH_ITEM_IDS = [
  'core-fields',
  'attributes-43',
  'freshness',
  'conflicts',
  'rule-risk',
  'optimization-readiness',
]

/** The four states. `empty` is "never written", **not** "measured as zero". */
export const ASIN_HEALTH_STATES = ['ok', 'empty', 'no-source', 'error']

/**
 * The one sentence for "this repository has no source for this item".
 *
 * **Re-exported, not re-declared.** The literal used to live here; the five
 * remaining F05-02 tabs (B-05d) each have a hole of their own and need the same
 * words, so the literal moved to `unsourced.js` and this name now aliases it. The
 * exported *name* is unchanged on purpose: the tool, the page's injected constant
 * and the existing B-05c assertions all still read `ASIN_HEALTH_NO_SOURCE_TEXT`,
 * so nothing had to be renamed to remove the duplicate spelling.
 */
export const ASIN_HEALTH_NO_SOURCE_TEXT = ASIN_NO_SOURCE_TEXT

/**
 * The Chinese label per state, next to the vocabulary.
 *
 * It lives here rather than once in the tool and again in the page because
 * `no-source`'s label **is** the no-source sentence: two copies of that would be two
 * spellings of one claim, and the page is required to print the server's words
 * rather than invent its own.
 */
/* 2026-10-25（R-17）：我第一版在这里加过一个 attention 档，**被两条测试当场驳回**：
   「四态与标签不是一一对应」和「写了 attributes_json（哪怕里面是空的）就是『测出来是 0』」。
   **测试是对的**：这四个词的语义是**「判据取到的状态」**（ok / empty / no-source / error），
   不是「值达不达标」。把达标度塞进这个字段，等于让一个词同时回答两个问题。

   真正误导人的是 ok 的中文写成了「正常」：实拍里 43 属性完整率 17/43 和
   优化前置 6/9（3 个降级）都印「正常」，读者看到就不动了。
   改成「已取得」——它说的是「这条判据我取到了」，不是「这条合格」；
   达标与否看结论列（那列本来就写着 17/43、6 通过 / 3 降级）。 */
export const ASIN_HEALTH_STATE_LABELS = {
  ok: '已取得',
  empty: '从没记过',
  'no-source': ASIN_HEALTH_NO_SOURCE_TEXT,
  error: '取不到判据',
}

/** Issue statuses that are still live. The two terminal ones are in `states.js`. */
const LIVE_ISSUE_STATUSES = ['open', 'acknowledged', 'fixing']

/**
 * The criteria this repository cannot answer, each with the reason.
 *
 * ⚠️ Two items the task brief expected to find here are **not** here, because the
 * measurements say otherwise:
 *
 *   - **43 属性完整率 has a source.** The column exists (`listing.attributes_json`,
 *     `store/schema.js` v-something `ALTER TABLE listing`), the criterion exists
 *     (`attributeCoverage`, `domain/rules/attributes.js`), a writer exists (draft
 *     apply: `tools/optimize.js` → `upsertListing`), and a reader already uses it
 *     (module 13's `attributes-sufficient` gate). Recording it as "no source" would
 *     be inventing a gap.
 *   - **优化前置 has a source.** `precheckFor` (`tools/optimize.js`) is what
 *     `amzn_optimize_precheck` and the page's run button both call.
 *
 * What genuinely has no source is below: the scan baseline, the history of a
 * field's `source_type`, and where an attribute snapshot came from.
 */
export const ASIN_HEALTH_UNSOURCED = [
  {
    id: 'rule-risk-scan-baseline',
    label: '规则风险「扫过没有」',
    feature: 'F05-07',
    reason: 'dq_issue 只存**发现**，不存一次扫描本身 —— runQualityScan 只对 scan() 的结果做 upsert，'
      + '既不落任何「扫描发生过」的行，也没有 dq_scan 表。所以「0 条问题」既可能是「扫过、干净」，'
      + '也可能是「从来没扫过」，本仓分不开。',
  },
  {
    id: 'source-type-history',
    label: '来源类型（collect/import/manual/derived）的变化',
    feature: 'F05-04',
    reason: 'asin_field_source 的主键是 (asin, marketplace, field, source_id)，同一来源再写是原地覆盖，'
      + '没有任何列或表记录该字段的来源类型历史。所以「来源变化」只能报快照行的采集来源（source_id）变化。',
  },
  {
    id: 'attribute-snapshot-origin',
    label: '「43 属性是从 Amazon 页面采集来的」',
    feature: 'F05-07',
    reason: 'listing.attributes_json 的唯一生产写入方是草案采纳（tools/optimize.js，origin=draft-applied）。'
      + '采集侧没有任何路径把属性写进 listing.attributes_json 或 asin_field_source 的 attribute.*'
      + '（upsertAsin 只写 ASIN_LISTING_FIELDS 那 10 列）。所以属性完整率不能说成「页面采集的覆盖率」。',
  },
]

/** The one sentence that must travel with a rule-risk count of zero. */
export const ASIN_HEALTH_SCAN_BASELINE_CAVEAT =
  `${ASIN_HEALTH_NO_SOURCE_TEXT}：「扫过、干净」与「从来没扫过」在 dq_issue 里长得一样（只存发现，不存扫描），`
  + '所以下面的 0 条不能说成「没有风险」。'

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/**
 * 一道门的「这一格该写什么」。
 *
 * 优先写**实测**，没有实测才写判据 —— 因为判据是用陈述句写的，和结论并排会被读成结论。
 * 实测有两种形状：`counts`（分子/分母，例如身份要素 3/5）与 `missing`（缺什么）。
 * 两者都有时都写：先给分子/分母，再点出缺的那几项 —— 「3/5 符合」与「缺店铺、产品线」
 * 是同一件事的两面，只给一面都读不全。
 */
function gateNote(gate) {
  const parts = []
  const counts = gate?.counts
  if (counts && Number.isFinite(counts.matched) && Number.isFinite(counts.total)) {
    parts.push(`${counts.matched}/${counts.total} ${counts.label ?? '项'}符合`)
  }
  const missing = Array.isArray(gate?.missing) ? gate.missing.filter(text => typeof text === 'string' && text.trim() !== '') : []
  if (missing.length > 0) parts.push(`缺：${missing.slice(0, 3).join('；')}${missing.length > 3 ? ` 等 ${missing.length} 项` : ''}`)
  if (parts.length > 0) return parts.join(' · ')
  return gate?.criterion ? `判据：${gate.criterion}` : null
}

function item({ id, label, feature, source, state, numerator, denominator, unit, conclusion, missing = [], breakdown = [], basis, note = null, caveat = null }) {
  return {
    id, label, feature, source, state,
    numerator: numerator ?? null,
    denominator: denominator ?? null,
    unit: unit ?? null,
    conclusion,
    missing,
    breakdown,
    basis,
    note,
    caveat,
  }
}

/**
 * Build the summary.
 *
 * `fields` is `buildFieldFacts(store, {asin, marketplace})`'s result and `precheck`
 * is `precheckFor(store, {asin, marketplace, mode:'full'})`'s. Both are injected
 * rather than recomputed here; `undefined` means the caller forgot and throws,
 * while `null` on `precheck` is a real answer (`precheckFor` returns `null` for an
 * unknown mode/scope pair) and becomes an `error` item, never a zero.
 */
export function buildAsinHealthSummary(store, { asin, marketplace = 'US', fields, precheck } = {}) {
  const key = blankToNull(asin)
  if (key === null) return { ok: false, code: 'BAD_REQUEST', error: 'asin is required' }
  const market = blankToNull(marketplace)
  if (market === null) return { ok: false, code: 'BAD_REQUEST', error: 'marketplace is required' }

  const asinKey = key.toUpperCase()
  const marketKey = market.toUpperCase()
  const row = store.get('SELECT asin, marketplace FROM asin WHERE asin = ? AND marketplace = ?', [asinKey, marketKey])
  if (row === undefined) {
    return {
      ok: false,
      code: 'ASIN_NOT_FOUND',
      error: `${asinKey} (${marketKey}) 不在库内`,
      hint: '先用 amzn_asin_upsert 导入，或确认站点代码对不对 —— 同一个 ASIN 在不同站点是两条记录',
    }
  }

  /* Same discipline as `buildOverview`'s `archived`: a missing injection is a bug
     in the caller, and defaulting it would silently turn "we forgot to compute it"
     into "there is nothing to report". */
  if (fields === undefined) {
    const error = new Error('buildAsinHealthSummary 需要调用方给出 fields（domain/asin/fields.js 的 buildFieldFacts 产出）—— '
      + '不给就会把「没人算过」静默读成「没有这一项」')
    error.code = 'HEALTH_FIELDS_REQUIRED'
    throw error
  }
  if (precheck === undefined) {
    const error = new Error('buildAsinHealthSummary 需要调用方给出 precheck（tools/optimize.js 的 precheckFor 产出）—— '
      + '不给就会把「没人算过」静默读成「前置不满足」')
    error.code = 'HEALTH_PRECHECK_REQUIRED'
    throw error
  }
  if (fields === null) {
    return { ok: false, code: 'ASIN_NOT_FOUND', error: `${asinKey} (${marketKey}) 不在库内` }
  }

  const objectId = `${asinKey}@${marketKey}`
  const sourceRows = listFieldSources(store, { asin: asinKey, marketplace: marketKey })
  const conflicts = listConflicts(store, { asin: asinKey, marketplace: marketKey })
  /* 2026-10-25（R-87）：这里原来只查 `object_type = 'asin'`。
     而「Listing 标题为空」那条 **block** 级问题的 `object_type` 是 **`listing`**，
     `object_id` 同样是 `ASIN@站点`（字段名在 `field` 列里）。
     于是同一个 ASIN 的一条 block 在健康摘要里读成「0 条未处置的问题」，
     而 `amzn_dq_scan` 正列着它是 open。实测：`asin` 口径 0 条、`listing` 口径 1 条 block。
     两列都查 —— 这一项回答的是「这个 ASIN 身上有哪些未处置的问题」，不是「哪个对象类型下」。 */
  const issues = [
    ...listIssues(store, { objectType: 'asin', objectId }),
    ...listIssues(store, { objectType: 'listing', objectId }),
  ]
  const listing = store.get('SELECT attributes_json FROM listing WHERE asin = ? AND marketplace = ?', [asinKey, marketKey])
  const items = []

  /* ── ① 核心字段完整率 ───────────────────────────────────────────────── */
  const fieldTotal = fields.summary.total
  const fieldValue = fields.summary.withValue
  items.push(item({
    id: 'core-fields',
    label: '核心字段完整率',
    feature: 'F05-07',
    source: 'asin 行 × store/queries.js 的 ASIN_FIELDS（写白名单，10 列）',
    state: 'ok',
    numerator: fieldValue,
    denominator: fieldTotal,
    unit: '个核心字段有值',
    conclusion: `${fieldValue}/${fieldTotal} 个核心字段有值`,
    missing: fields.fields
      .filter(entry => entry.adoptedValue === null || entry.adoptedValue === undefined
        || String(entry.adoptedValue).trim() === '')
      .map(entry => entry.field),
    breakdown: [
      { label: '有值', value: `${fieldValue}`, note: null },
      { label: '缺', value: `${fieldTotal - fieldValue}`, note: null },
      { label: '有来源行', value: `${fields.summary.withAnySource}`, note: '有值的字段不一定有来源行：人工写入也可以有值' },
    ],
    basis: '分母是写白名单那 10 列；数字由 domain/asin/fields.js 的 buildFieldFacts 算好传进来，这里不重算。',
  }))

  /* ── ② 43 属性完整率 ───────────────────────────────────────────────── */
  const attributeGate = (precheck?.gates ?? []).find(gate => gate.id === 'attributes-sufficient') ?? null
  const attributesWritten = listing !== undefined && listing !== null
    && listing.attributes_json !== null && String(listing.attributes_json).trim() !== ''
  if (attributeGate === null) {
    items.push(item({
      id: 'attributes-43',
      label: '43 属性完整率',
      feature: 'F05-07',
      source: '模块 13 的 attributes-sufficient 门（判据 attributeCoverage）',
      state: 'error',
      numerator: null,
      denominator: REQUIRED_ATTRIBUTE_TARGET,
      unit: '项必填属性',
      conclusion: '取不到模块 13 的属性门结果 —— 不是「0 项」',
      basis: '这一项读的是 precheck 报告里的 attributes-sufficient 门，不在这里重算 —— 判据只有一份。',
      note: 'precheck 报告里没有这道门（报告为 null，或版本比本功能点旧）。',
    }))
  } else {
    const filled = Number(attributeGate.counts?.matched ?? 0)
    const target = Number(attributeGate.counts?.total ?? REQUIRED_ATTRIBUTE_TARGET)
    items.push(item({
      id: 'attributes-43',
      label: '43 属性完整率',
      feature: 'F05-07',
      source: `listing.attributes_json → attributeCoverage（模块 13 第 ${attributeGate.index} 道门）`,
      state: attributesWritten ? 'ok' : 'empty',
      numerator: filled,
      denominator: target,
      unit: '项必填属性有非占位值',
      conclusion: `${filled}/${target} 项必填属性有非占位值`,
      missing: [...(attributeGate.missing ?? [])],
      breakdown: (attributeGate.measured ?? []).map(entry => ({ label: entry.name, value: entry.value, note: entry.note })),
      basis: attributeGate.basis ?? '判据来自 attributeCoverage：空值与 N/A / 待定 这类占位值同样算缺；分母固定 43。',
      note: attributesWritten
        ? null
        : '这个 ASIN 的 listing 里没有 attributes_json（这一栏从没被写过）—— 0 是「没人记过」，不是「记了 43 项都是空的」；分母仍固定 43。',
    }))
  }

  /* ── ③ 新鲜度 ───────────────────────────────────────────────────────── */
  const observed = fields.summary.fresh + fields.summary.stale
  items.push(item({
    id: 'freshness',
    label: '数据新鲜度',
    feature: 'F05-07',
    source: 'asin_field_source.observed_at × domain/data/freshness.js 的 7/30/90 天表',
    state: sourceRows.length === 0 ? 'empty' : 'ok',
    numerator: fields.summary.fresh,
    denominator: fieldTotal,
    unit: `个核心字段在各自阈值内（${FRESHNESS_DAYS.price} 天档）`,
    conclusion: `${fields.summary.fresh}/${fieldTotal} 个核心字段新鲜`,
    missing: fields.fields
      .filter(entry => entry.freshness === 'stale')
      .map(entry => entry.field),
    breakdown: [
      { label: '新鲜', value: `${fields.summary.fresh}`, note: null },
      { label: '已过期', value: `${fields.summary.stale}`, note: null },
      { label: '无阈值', value: `${fields.summary.noThreshold}`, note: '这个字段没在 7/30/90 表里 —— 「没有阈值」不是「新鲜」' },
      { label: '有观测时间未知', value: `${fields.summary.noObservationTime}`, note: '有人记过这个值，但没记它什么时候是真的' },
      { label: '有观测时间的字段', value: `${observed}`, note: null },
    ],
    basis: `阈值只有一份：${freshnessLabel(FRESHNESS_DAYS.price)} / ${freshnessLabel(FRESHNESS_DAYS.bsr)} / ${freshnessLabel(FRESHNESS_DAYS.attributes)}（domain/data/freshness.js）。`
      + '「unknown」拆成「无阈值」与「没有观测时间」两句，因为修法不同。',
    note: sourceRows.length === 0
      ? '这条 ASIN 一行来源记录都没有（asin_field_source 为空）—— 不是「全都不新鲜」，是「还没有人来记过」。'
      : null,
  }))

  /* ── ④ 多源冲突 ─────────────────────────────────────────────────────── */
  /* 每个字段有几个不同的来源 —— 用来解释「0 条冲突」是哪种 0（R-25）。 */
  const sourcesPerField = new Map()
  for (const row of sourceRows) {
    const key = String(row.field ?? '')
    if (!sourcesPerField.has(key)) sourcesPerField.set(key, new Set())
    sourcesPerField.get(key).add(String(row.sourceId ?? row.source_id ?? ''))
  }
  const singleSourced = sourcesPerField.size > 0
    && [...sourcesPerField.values()].every(set => set.size <= 1)
  const openConflicts = conflicts.filter(entry => entry.status === 'open')
  const contested = fieldConflictsOf(sourceRows)
  items.push(item({
    id: 'conflicts',
    label: '多源冲突',
    feature: 'F05-07',
    source: 'field_conflict（裁决对象）+ asin_field_source（DQ-CONSIST-001 口径的发现）',
    state: sourceRows.length === 0 && conflicts.length === 0 ? 'empty' : 'ok',
    numerator: openConflicts.length,
    denominator: fieldTotal,
    unit: '个字段待裁决（分母是核心字段数）',
    /* Two answers in one sentence on purpose: they are two facts and they can
       disagree. The conflict row is the adjudication object; the scan is the
       detection. Merging them into one number is how "we decided" and "we found"
       start contradicting each other on one screen. */
    conclusion: `${openConflicts.length} 条未裁决的冲突，另有 ${contested.size} 个字段在多源上有不同值`
      /* 2026-10-25（R-25）：**「0 条冲突」有四种可能的 0，读者一眼分不开。**
         实测这条 ASIN 的 144 个 (asin, field) 组合**每个都只有 1 个来源** ——
         单来源在结构上就不可能冲突，所以这个 0 是「测了是 0」，不是「没扫过」。
         检测器确实会被调用（`field-source.js:146` 每次写字段都 `refreshConflictsFor`），
         但它跑出来是空的，而「跑过、空的」与「从没跑过」在这个数字上长得一模一样。
         所以把**为什么是 0** 说出来；说不了原因时才说原因未知。 */
      + (openConflicts.length === 0 && contested.size === 0
        ? (singleSourced
          ? `（这 ${fieldTotal} 个核心字段**每个都只有一个来源** —— 单来源在结构上不可能冲突，所以这个 0 是真的 0）`
          : '（没有冲突记录，但字段里有多来源的 —— 见「分档」里的多源不同值）')
        : ''),
    missing: [...new Set([
      ...openConflicts.map(entry => entry.field),
      ...contested.keys(),
    ])],
    breakdown: [
      { label: '待裁决（field_conflict）', value: `${openConflicts.length}`, note: conflicts.length === 0 ? '一个冲突行都没有' : `共 ${conflicts.length} 条（含已裁决）` },
      { label: '多源不同值（现算）', value: `${contested.size}`, note: '与 DQ-CONSIST-001 同一个判据，从 asin_field_source 现算' },
      { label: '已裁决', value: `${conflicts.length - openConflicts.length}`, note: null },
    ],
    basis: '两个面分开报，不合成一个数：「待裁决」是 field_conflict 的状态机（有人要动手），「多源不同值」是发现（可能已经被裁决过）。',
    note: sourceRows.length === 0
      ? '没有来源行，也就没有「多源」可言 —— 0 是「只有主记录、没有溯源」，不是「来源都一致」。'
      : null,
  }))

  /* ── ⑤ 规则风险 ─────────────────────────────────────────────────────── */
  const live = issues.filter(entry => LIVE_ISSUE_STATUSES.includes(entry.status))
  const bySeverity = severity => live.filter(entry => entry.severity === severity).length
  items.push(item({
    id: 'rule-risk',
    label: '规则风险',
    feature: 'F05-07',
    /* 2026-10-26（R-87 后续）：这一项现在查两个 `object_type`，所以 `source` 那句话也跟着改 ——
       留着「按 object_type=asin 反查」就是在说一件已经不做的事（R-75 / R-79 是同一种错）。 */
    source: 'dq_issue（按 object_id=ASIN@站点 反查，object_type 取 asin 与 listing 两种）',
    state: 'ok',
    /* A count, not a ratio: `denominator: null` says that out loud instead of
       printing a 0 that a reader would take as "0 out of 0". */
    numerator: live.length,
    denominator: null,
    unit: '条未处置的问题',
    conclusion: `${live.length} 条未处置的问题（阻断 ${bySeverity('block')} / 警告 ${bySeverity('warn')} / 提示 ${bySeverity('info')}）`,
    missing: live.map(entry => `${entry.ruleId}${entry.field ? `@${entry.field}` : ''}`),
    breakdown: [
      { label: '阻断（block）', value: `${bySeverity('block')}`, note: null },
      { label: '警告（warn）', value: `${bySeverity('warn')}`, note: null },
      { label: '提示（info）', value: `${bySeverity('info')}`, note: null },
      { label: '维度', value: `${[...new Set(live.map(entry => DIMENSION_LABELS[entry.dimension] ?? entry.dimension))].join('、') || '—'}`, note: '七维度来自 domain/data/quality-rules.js' },
    ],
    basis: 'dq_issue 的 object_id 是 <ASIN>@<站点>（objectKey 口径），所以 per-ASIN 反查可行；这一项是计数不是比率，分母为空而不是 0。',
    caveat: ASIN_HEALTH_SCAN_BASELINE_CAVEAT,
  }))

  /* ── ⑥ 优化前置 ─────────────────────────────────────────────────────── */
  if (precheck === null) {
    items.push(item({
      id: 'optimization-readiness',
      label: '优化前置是否满足',
      feature: 'F05-07',
      source: 'precheckFor（模块 13）',
      state: 'error',
      numerator: null,
      denominator: null,
      unit: null,
      conclusion: '取不到模块 13 的判定 —— 不是「前置不满足」',
      basis: '这一项读 precheckFor 的产出，不在这里重算九道门。',
      note: 'precheckFor 对未知的 mode/scope 组合返回 null；本次调用没有拿到报告。',
    }))
  } else {
    const counts = precheck.counts ?? { pass: 0, degrade: 0, block: 0, total: 0 }
    items.push(item({
      id: 'optimization-readiness',
      label: '优化前置是否满足',
      feature: 'F05-07',
      source: `precheckFor（模块 13，版本 ${precheck.version ?? '—'}）的九道门`,
      state: 'ok',
      numerator: counts.pass,
      denominator: counts.total,
      unit: '道门通过',
      conclusion: `${counts.pass} 通过 / ${counts.degrade} 降级 / ${counts.block} 阻断（共 ${counts.total} 道门）`,
      missing: (precheck.supplement ?? []).map(entry => `${entry.gateLabel}：${(entry.missing ?? []).join('、')}`),
      breakdown: (precheck.gates ?? []).map(gate => ({
        label: gate.label,
        value: gate.verdict,
        /* 这里原来放的是 gate.criterion —— 那是**判据**，而且是用陈述句写的
           （「两份快照都在 30 天内」「N 个关键词的搜索量观测都在 90 天内」）。
           把它和实测结论并排印，读者会把它读成结论：实拍里出现过
           `属性 ≤30 天 = degrade` 旁边写着「属性与后台词两份快照都在 30 天内」，
           而同一屏的 missing 说「后台词快照不存在」—— 一屏两句话互相打架。
           现在优先印**实测**（分子/分母 + 缺什么），没有实测值时才退回判据，
           并且明写「判据：」——判据和结论不能长得一样。 */
        note: gateNote(gate),
      })),
      basis: '判据在模块 13 的 precheckFor（amzn_optimize_precheck 与页面的「开跑这一轮」按钮同一个入口），本摘要只读它的产出 —— 九道门一条都不重算。',
      note: precheck.blocked === true
        ? '有阻断项：amzn_optimize_prepare 会拒绝开跑，先把阻断项补上。'
        : null,
    }))
  }

  /* ── state counts and the verdict, both derived from `items` ─────────── */
  const counts = {
    ok: items.filter(entry => entry.state === 'ok').length,
    empty: items.filter(entry => entry.state === 'empty').length,
    /* 本批恒 0，且这是**有意的**：这六项都有来源，没有一项本身是 `no-source`。
       「本仓没有来源」的三条在 `unsourced[]` 里，它们的计数是 `counts.unsourced`。
       两个数字分开，是因为它们回答的问题不同：「哪一项算不出来」（六项里）与
       「这个摘要点了几处本仓没有来源的判据」。 */
    noSource: items.filter(entry => entry.state === 'no-source').length,
    error: items.filter(entry => entry.state === 'error').length,
    total: items.length,
    unsourced: ASIN_HEALTH_UNSOURCED.length,
  }

  /* The verdict is not stored anywhere and not an input: it is a fold over the
     items that were just built, so "changed an item, forgot the verdict" is not a
     bug that can exist. */
  const errorItems = items.filter(entry => entry.state === 'error')
  const blocked = precheck?.blocked === true
  const verdict = errorItems.length > 0 ? 'attention' : (blocked ? 'blocked' : 'ok')

  return {
    ok: true,
    asin: asinKey,
    marketplace: marketKey,
    objectId,
    at: new Date().toISOString(),
    items,
    itemIds: [...ASIN_HEALTH_ITEM_IDS],
    /* Each entry carries `state: 'no-source'` so the vocabulary value is **load-bearing**
       rather than declared-and-unused: the page renders its chip from the same label
       table the six items use, and a reader sees the same word in both places. */
    unsourced: ASIN_HEALTH_UNSOURCED.map(entry => ({
      ...entry,
      state: 'no-source',
      conclusion: ASIN_HEALTH_NO_SOURCE_TEXT,
    })),
    counts,
    verdict,
    verdictReason: errorItems.length > 0
      ? `有 ${errorItems.length} 项取不到判据：${errorItems.map(entry => entry.label).join('、')}`
      : (blocked ? '优化前置有阻断项' : '六项都取到了判据；结论里为 0 的项要看它自己的 note'),
    noSourceText: ASIN_HEALTH_NO_SOURCE_TEXT,
  }
}
