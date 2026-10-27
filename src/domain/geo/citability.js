/**
 * T71 GEO 可引用性 —— 四组事实，各算各的，**永不合成总分**（FR-M4-15，PRD 铁律 4）。
 *
 * ## 四组是什么，以及为什么必须是四个独立对象
 *
 *   ① `attribute`      属性完整度：43 项必填属性有值数 / 43。分子、分母、缺键名单
 *                       全部来自 `domain/asin/health.js#buildAsinHealthSummary` 的
 *                       `attributes-43` 项与同一个 `attributeCoverage` —— 本文件
 *                       不写第二份完整度算法。
 *   ② `qa`             Q&A 覆盖：**本仓没有来源**。13 个采集节没有 `qa`，schema 没有
 *                       qa 表，`qa_1..qa_8` 只是优化草案的字段声明。整组 state='no-source'，
 *                       numerator/denominator 为 null —— 不是 0，也不是 0/0。
 *   ③ `comparability`  对比维度可比性：我方 ASIN × 一组竞品，逐属性维度判
 *                       「值相同 / 值不同 / 无值 / 单位不一致 / 测量期不一致 / 测量期未记」。
 *                       「无值」与「值相同」分开计数；单位不一致不猜换算；测量期判据
 *                       复用 `domain/keywords/competitor.js#buildEvidenceView`（§20.3 唯一实现）。
 *   ④ `consistency`    事实一致性：按 **O-02 A 案**（2026-10-25 拍板）实现提案 §4
 *                       的 J1–J6。A 组（数值一致）与 B 组（声明有据）**两组独立计数**，
 *                       非数值声明单列「v1 未覆盖」且**不入任何分母**。抽取复用
 *                       `optimize/plan.js#buildFactLedger`，本文件不含第二条数字正则。
 *
 * 四组是四个**平级**对象。任何 `totalScore` / `overall` / 加权平均 / 综合得分
 * 的行或列都不许出现；这不是样式问题，是 PRD 的硬红线。本文件不导出任何聚合函数，
 * 也不提供 `score()`。
 *
 * ## 四态口径（没取到 ≠ 没有）
 *
 * - `no-source`：结构性缺口（本仓没有这个来源）。整组不给比值，印「本仓没有来源」。
 * - `empty`：来源在、但这一栏从没被写过 / 写出来是空的。可以印 0/N，但 0 的含义是
 *   「没人记过」，不是「记了、全是空」。
 * - `error`：读数失败或两处读数打架。**不回落成空态**，不挑一个数继续印。
 * - `ok`：确实量到了。
 *
 * ## 时间与来源
 *
 * 每组都带 `source` 与 `observedAt`。`observedAt` 是**事实在世界上成立的时间**
 * （`asin_field_source.observed_at`），不是本函数的计算时刻；没记就是 `null`，
 * 由展示层印「本处未记」。组③的 `observedAtAll` 列出所有侧的时间，因为一个
 * 比值可能跨多个观测日 —— 逐维度的 `cells` 各自带时间，跨期的维度按 §20.3
 * 单独归入不可比，不进分子。
 *
 * ## 分层
 *
 * 本文件的上半部分是纯函数（只吃入参，不碰 store），测试可以直接喂 fixture；
 * 下半部分 `readGeoFacts` / `readAttributeFacts` 是**薄读取适配层**：只做
 * 「从 store 取行 → 调既有 builder」，不含任何判据。页面与工具接线（T70 收口后
 * 另行派单）只应调用 `readGeoFacts`，不应重写这里的任何一条规则。
 */

import { ATTRIBUTES, REQUIRED_ATTRIBUTES, attributeCoverage, isPlaceholderValue } from '../rules/attributes.js'
import { ASIN_NO_SOURCE_TEXT } from '../asin/unsourced.js'
import { buildEvidenceView } from '../keywords/competitor.js'
import { buildAsinHealthSummary } from '../asin/health.js'
import { buildFieldFacts } from '../asin/fields.js'
import { evaluatePrecheck } from '../optimize/precheck.js'
/* 尺寸/重量的**唯一**抽取器（GEO 派单：不许写第二份正则）。台账把「值」归并了，
   所以按字段问它一遍，拿「哪个字段、原文是什么」用于证据回指。 */
import { buildFactLedger } from '../optimize/plan.js'
import { familyCompetitorsFor } from '../../store/asin-competitor.js'

/** The four groups, in the order the page draws them. Closed set. */
export const GEO_GROUP_IDS = ['attribute', 'qa', 'comparability', 'consistency']

/** Chinese labels, one spelling. The page reads this table rather than inventing its own. */
export const GEO_GROUP_LABELS = {
  attribute: '属性完整度',
  qa: 'Q&A 覆盖',
  comparability: '对比维度可比性',
  consistency: '事实一致性',
}

/**
 * The one sentence for "this repository has no source".
 *
 * **Re-exported, not re-declared** — the literal lives in `domain/asin/unsourced.js`
 * so the health summary, the five detail tabs and this module cannot drift into
 * three spellings of one claim.
 */
export const GEO_NO_SOURCE_TEXT = ASIN_NO_SOURCE_TEXT

/** §11 / O-02: the fourth group's criterion is not decided yet. One spelling. */
export const GEO_PENDING_NOTE = '判据待 O-02 拍板'

/**
 * The six comparability states. Closed set; every dimension row carries exactly one.
 *
 * `no-value` is **not** `same`: a missing value is "nobody recorded this", while
 * `same` is "both sides recorded a value and the values agree". Collapsing them
 * would turn every unmeasured dimension into a false claim of agreement.
 */
export const GEO_COMPARABILITY_STATUSES = [
  'same', 'different', 'no-value', 'unit-mismatch', 'period-mismatch', 'period-unknown',
]

export const GEO_COMPARABILITY_STATUS_LABELS = {
  same: '值相同',
  different: '值不同',
  'no-value': '无值',
  'unit-mismatch': '单位不一致',
  'period-mismatch': '测量期不一致',
  'period-unknown': '测量期未记',
}

/**
 * Field names that would make this payload a black-box score.
 *
 * Exported so the test can assert against the same vocabulary the module refuses
 * to emit — a guard that only exists in a test is a guard the next module forgets.
 */
export const GEO_FORBIDDEN_AGGREGATE_KEYS = [
  'score', 'total', 'overall', 'composite', 'weighted', 'grade',
  'totalScore', 'overallScore', 'weightedScore', 'compositeScore', 'geoScore',
]

/* ─────────────────────────────── small helpers ─────────────────────────────── */

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function upper(value) {
  const text = blankToNull(value)
  return text === null ? null : text.toUpperCase()
}

function badRequest(error) {
  return { ok: false, code: 'BAD_REQUEST', error }
}

function baseGroup(id) {
  return { id, label: GEO_GROUP_LABELS[id], feature: 'FR-M4-15' }
}

/**
 * `listing.attributes_json` keyed either way (`material` or `attribute.material`).
 * Returns `null` for a non-object, so "never written" and "written empty" stay apart.
 */
export function normalizeAttributeMap(attributes) {
  if (attributes === null || attributes === undefined) return null
  if (typeof attributes !== 'object' || Array.isArray(attributes)) return null
  const out = {}
  for (const [key, value] of Object.entries(attributes)) {
    const name = String(key)
    const id = name.startsWith('attribute.') ? name.slice('attribute.'.length) : name
    if (id === '') continue
    out[id] = value
  }
  return out
}

/** A value counts only when it is non-empty **and** not a placeholder (same rule as the 43 gate). */
function hasAttributeValue(value) {
  if (value === null || value === undefined) return false
  const text = String(value).trim()
  if (text === '') return false
  return !isPlaceholderValue(text)
}

/* Unit tokens. This is a **normalisation of synonyms**, not a conversion table:
   lb/lbs/pound are one unit; lb and kg are two units and stay two. */
const UNIT_ALIASES = new Map([
  ['in', 'inch'], ['inch', 'inch'], ['inches', 'inch'],
  ['cm', 'cm'], ['centimeter', 'cm'], ['centimeters', 'cm'],
  ['mm', 'mm'], ['millimeter', 'mm'], ['millimeters', 'mm'],
  ['ft', 'ft'], ['foot', 'ft'], ['feet', 'ft'],
  ['lb', 'lb'], ['lbs', 'lb'], ['pound', 'lb'], ['pounds', 'lb'],
  ['kg', 'kg'], ['kilogram', 'kg'], ['kilograms', 'kg'],
  ['g', 'g'], ['gram', 'g'], ['grams', 'g'],
  ['oz', 'oz'], ['ounce', 'oz'], ['ounces', 'oz'],
])

/* A unit must follow a digit / `)` (or start the string) and end the value, be
   followed by punctuation, or be followed by `x <number>` (a compound value such
   as "10 cm x 8 in"). That keeps "2 in 1" from reading `in` as inches while still
   catching "44x19x4 inches", "2.5 lbs" and mixed-unit dimensions. */
const UNIT_RE = /(?:^|[\d)])\s*(inches|inch|in|cm|mm|ft|feet|foot|lbs|lb|pounds|pound|kg|kilograms|kilogram|grams|gram|g|oz|ounces|ounce)\s*(?=$|[,;/().]|\s*x\s*\d)/gi

/**
 * The canonical units named inside a value, e.g. `'2.5 lbs' → ['lb']`.
 *
 * More than one distinct unit (`'2.5 lbs (1.1 kg)'`) is returned as two entries;
 * the caller treats that as ambiguous rather than picking one.
 */
export function attributeUnitsOf(value) {
  const text = String(value ?? '')
  const units = new Set()
  for (const match of text.matchAll(UNIT_RE)) {
    const canonical = UNIT_ALIASES.get(String(match[1]).toLowerCase())
    if (canonical !== undefined) units.add(canonical)
  }
  return [...units].sort()
}

/** Rewrite unit synonyms to their canonical spelling, preserving the number. */
function canonicalizeUnitTokens(text) {
  return String(text).replace(UNIT_RE, (whole, unit) => {
    const canonical = UNIT_ALIASES.get(String(unit).toLowerCase())
    if (canonical === undefined) return whole
    const at = whole.indexOf(String(unit))
    if (at < 0) return whole
    return `${whole.slice(0, at)}${canonical}${whole.slice(at + String(unit).length)}`
  })
}

/**
 * A comparison-only normalisation: whitespace, `×/✕` → `x`, unit synonyms,
 * trailing zeros. **No conversion** — `2.5 lbs` and `1.1 kg` stay different
 * strings because they are different units.
 */
export function normalizeComparableValue(value) {
  let text = String(value ?? '').trim().toLowerCase()
  text = text.replace(/[×✕✖]/g, 'x')
  text = text.replace(/\s*x\s*/g, 'x')
  text = text.replace(/\s+/g, ' ')
  text = canonicalizeUnitTokens(text)
  text = text.replace(/\b(\d+)\.(\d*?[1-9])0+\b/g, '$1.$2')
  text = text.replace(/\b(\d+)\.0+\b/g, '$1')
  return text.trim()
}

/* ───────────────────────────── group ① attribute ───────────────────────────── */

/**
 * `listing.attributes_json` → `{ 'attribute.<id>': value }`, the shape
 * `attributeCoverage` reads. A key prefix, not an algorithm.
 */
function attributeFieldsOf(attributes) {
  const out = {}
  for (const [key, value] of Object.entries(attributes ?? {})) {
    const name = String(key)
    const id = name.startsWith('attribute.') ? name.slice('attribute.'.length) : name
    out[`attribute.${id}`] = value
  }
  return out
}

/**
 * Group ① — the 43-attribute coverage, **read out of the health summary**.
 *
 * The numerator/denominator are `health.items[attributes-43]`'s own numbers. The
 * missing-key list is produced by the **same** `attributeCoverage` function the
 * health gate uses (the gate's `missing` is a sentence and its breakdown notes
 * truncate at 12 keys, so it cannot name all 40). If the two readings disagree,
 * the group becomes `error` — the one thing this module must not do is pick one
 * of two numbers and print it as if there were only one.
 *
 * `core-fields` is carried as a secondary breakdown row because F05-01's 17-column
 * table's completeness column is the same 10 writable fields; it is not a second
 * completeness algorithm.
 */
export function attributeGroupFromHealth(health, { attributes = null, observedAt = null, state = null } = {}) {
  const base = baseGroup('attribute')
  const common = {
    unit: '项必填属性有非占位值',
    source: 'domain/asin/health.js#buildAsinHealthSummary 的 attributes-43 项'
      + '（listing.attributes_json → domain/rules/attributes.js#attributeCoverage）',
    observedAt: blankToNull(observedAt),
    observedAtAll: blankToNull(observedAt) === null ? [] : [blankToNull(observedAt)],
    /* R4：两个比值并排、各自带分母；错误态两者都是 null，不挑一个数。 */
    attributes43: null,
    coreFields: null,
    missing: [],
    breakdown: [],
    basis: '分子/分母直接取 health 的 attributes-43 项，不在这里重算；缺键名单由同一个 attributeCoverage 给出'
      + '（health 的门只截断列 12 个键，点名不全）。两者不一致时本组报 error，不挑一个数。',
    note: null,
  }

  if (health === null || health === undefined || health.ok !== true) {
    return {
      ...base, ...common,
      state: 'error',
      numerator: null,
      denominator: null,
      conclusion: 'GEO 事实没算出来：取不到健康摘要（不是「0 项」）',
      note: health?.error ?? 'buildAsinHealthSummary 没有返回 ok:true',
    }
  }

  const items = Array.isArray(health.items) ? health.items : []
  const attributeItem = items.find(entry => entry.id === 'attributes-43') ?? null
  const coreItem = items.find(entry => entry.id === 'core-fields') ?? null

  if (attributeItem === null) {
    return {
      ...base, ...common,
      state: 'error',
      numerator: null,
      denominator: null,
      conclusion: 'GEO 事实没算出来：健康摘要里没有 attributes-43 项（不是「0 项」）',
      note: 'precheck 报告里没有 attributes-sufficient 门，或摘要版本比本功能点旧。',
    }
  }

  if (attributeItem.state === 'error') {
    return {
      ...base, ...common,
      state: 'error',
      numerator: null,
      denominator: null,
      conclusion: attributeItem.conclusion ?? 'GEO 事实没算出来：健康摘要的 attributes-43 项本身是 error（不是「0 项」）',
      note: attributeItem.note ?? null,
    }
  }

  if (state === 'unreadable') {
    return {
      ...base, ...common,
      state: 'error',
      numerator: null,
      denominator: null,
      conclusion: 'GEO 事实没算出来：我方 attributes_json 读不出来（不是「没有值」）',
      note: 'attributes_json 不是 JSON 对象；读失败不回落空态。',
    }
  }

  const attributeMap = normalizeAttributeMap(attributes)
  let coverage = null
  if (attributeMap !== null) coverage = attributeCoverage(attributeFieldsOf(attributeMap))

  if (attributeMap === null && Number(attributeItem.numerator) > 0) {
    return {
      ...base, ...common,
      state: 'error',
      numerator: null,
      denominator: null,
      conclusion: `GEO 事实没算出来：health 说 ${attributeItem.numerator}/${attributeItem.denominator} 项有值，`
        + '但我方 attributes_json 是空的 —— 两处输入不一致，不挑一个数',
      note: '检查 readGeoFacts 是否把同一个 listing 的 attributes 同时交给了 health 与本组。',
    }
  }

  if (coverage !== null) {
    const healthNumerator = Number(attributeItem.numerator)
    const healthDenominator = Number(attributeItem.denominator)
    if (healthNumerator !== coverage.filledCount || healthDenominator !== coverage.target) {
      return {
        ...base, ...common,
        state: 'error',
        numerator: null,
        denominator: null,
        conclusion: `GEO 事实没算出来：health 的 ${attributeItem.numerator}/${attributeItem.denominator}`
          + ` 与 attributeCoverage 的 ${coverage.filledCount}/${coverage.target} 不一致 —— 两处读数打架时不挑一个数`,
        note: '同一个 43 属性判据出现了两个答案；先查 health/precheck 的版本与 listing.attributes_json 是否同一份。',
      }
    }
  }

  const missing = coverage === null ? [] : [...coverage.empty, ...coverage.placeholder]
  const breakdown = []
  let coreFields = null
  if (coreItem !== null) {
    coreFields = {
      id: 'core-fields',
      label: '核心字段完整率（10 个可写字段；F05-01 的 17 列里只有这 10 列是 asin 行事实）',
      numerator: coreItem.numerator,
      denominator: coreItem.denominator,
      unit: coreItem.unit ?? '个核心字段有值',
      missing: [...(coreItem.missing ?? [])],
      source: coreItem.source ?? null,
    }
    breakdown.push(coreFields)
  }

  return {
    ...base, ...common,
    state: attributeItem.state,
    /* R4：两个比值并排，各自带自己的分母，绝不合并、绝不相加。
       `attributes43` 是字面「属性完整度」；`coreFields` 是核心字段完整度
       （分母取 health 的实际分母，不写死 10 或 17）。顶层 `numerator/denominator`
       保留为 attributes43 的兼容别名，老读者不需要改。 */
    attributes43: {
      numerator: attributeItem.numerator,
      denominator: attributeItem.denominator,
    },
    coreFields,
    numerator: attributeItem.numerator,
    denominator: attributeItem.denominator,
    conclusion: attributeItem.conclusion,
    missing,
    missingNote: attributeMap === null
      ? 'attributes_json 从没被写过：43 项不是「都填错了」，是「没人记过」—— 0 是「从没记过」，不是「记了 43 项都是空的」。'
      : (missing.length > 0 ? `缺 ${missing.length} 项必填属性（空值 + 占位值），逐键见 missing。` : null),
    breakdown,
    note: attributeItem.note ?? null,
  }
}

/* ───────────────────────────────── group ② qa ─────────────────────────────── */

/**
 * Group ② — Q&A coverage has **no source in this repository**.
 *
 * The anchors are code facts, not a guess:
 *   - `domain/collect/sections.js` `COLLECTION_SECTIONS` is the 13-section
 *     collection vocabulary; it has no `qa` (its own header says so).
 *   - `domain/rules/listing-fields.js` `QA_FIELDS` (`qa_1..qa_8`) is the optimizer's
 *     **draft field** vocabulary — `publishable: false`, no collector, no section.
 *   - `store/schema.js` has no `qa` / `qa_*` table.
 *
 * Therefore this group has no numerator and no denominator. `null` is the answer;
 * `0` would be a measurement that never happened.
 */
export function qaGroup() {
  return {
    ...baseGroup('qa'),
    state: 'no-source',
    numerator: null,
    denominator: null,
    unit: null,
    source: GEO_NO_SOURCE_TEXT,
    observedAt: null,
    observedAtAll: [],
    conclusion: GEO_NO_SOURCE_TEXT,
    reason: '本仓没有 Q&A 来源：13 个采集节（src/domain/collect/sections.js 的 COLLECTION_SECTION_IDS）'
      + '没有 qa；src/domain/rules/listing-fields.js 的 QA_FIELDS（qa_1..qa_8）只是优化草案的字段声明'
      + '（publishable:false），没有采集节也没有写入方；src/store/schema.js 没有 qa / qa_* 表。',
    anchors: [
      {
        file: 'src/domain/collect/sections.js',
        symbol: 'COLLECTION_SECTION_IDS',
        fact: '13 个采集节 id 不含 qa（basic/bullets/images/variations/attributes/description/aplus/video/seo_meta/bsr/reviews/page_signals/related_competitors）',
      },
      {
        file: 'src/domain/rules/listing-fields.js',
        symbol: 'QA_FIELDS',
        fact: 'qa_1..qa_8 是优化草案字段声明（publishable:false），不是采集节',
      },
      {
        file: 'src/store/schema.js',
        symbol: 'CREATE TABLE',
        fact: 'schema 的建表清单里没有 qa / qa_* 表',
      },
    ],
    basis: '无来源组不参与任何比值：numerator/denominator 为 null，不是 0/0，也不是 0%。',
  }
}

/* ────────────────────────────── group ③ comparability ─────────────────────── */

function cellOf(side, attributes, key) {
  const map = normalizeAttributeMap(attributes)
  const raw = map === null ? undefined : map[key]
  const present = hasAttributeValue(raw)
  const units = present ? attributeUnitsOf(raw) : []
  return {
    asin: upper(side?.asin),
    present,
    value: present ? String(raw).trim() : null,
    unit: units.length === 1 ? units[0] : null,
    units,
    /* Per-key time wins over the side's latest time: two attributes collected on
       different days must not both look like the latest one. */
    observedAt: blankToNull(side?.observedByKey?.[key] ?? side?.observedAt),
    absence: present
      ? null
      : (side?.state === 'unreadable' ? 'unreadable' : (map === null ? 'never-written' : 'no-value')),
  }
}

function comparePair(marketplace, key, ourCell, theirCell) {
  if (!ourCell.present || !theirCell.present) {
    return { status: 'no-value', reasonCode: 'missing-value' }
  }
  if (ourCell.units.length > 1 || theirCell.units.length > 1) {
    return { status: 'unit-mismatch', reasonCode: 'unit-ambiguous' }
  }
  if (ourCell.units.length !== theirCell.units.length) {
    return { status: 'unit-mismatch', reasonCode: 'unit-missing-one-side' }
  }
  if (ourCell.units.length === 1 && ourCell.units[0] !== theirCell.units[0]) {
    return { status: 'unit-mismatch', reasonCode: 'unit-differs' }
  }
  /* §20.3's one implementation. `buildEvidenceView` says "comparable only when both
     sides have a measurement and the same period"; we map its answer, we do not
     re-derive it. */
  const view = buildEvidenceView({
    keyword: key,
    marketplace,
    our: { measured: true, period: ourCell.observedAt },
    their: {
      measured: true,
      period: theirCell.observedAt,
      periods: theirCell.observedAt === null ? [] : [theirCell.observedAt],
    },
  })
  if (view.periodMismatch) return { status: 'period-mismatch', reasonCode: 'period-differs' }
  if (!view.comparable) return { status: 'period-unknown', reasonCode: 'period-unknown' }
  const same = normalizeComparableValue(ourCell.value) === normalizeComparableValue(theirCell.value)
  return { status: same ? 'same' : 'different', reasonCode: null }
}

function absenceText(cell) {
  if (cell.absence === 'never-written') return `${cell.asin ?? '一侧'} 的属性表从没被写过（不是「这一项为空」）`
  if (cell.absence === 'unreadable') return `${cell.asin ?? '一侧'} 的属性表读不出来（不是「没有值」）`
  return `${cell.asin ?? '一侧'} 没有值`
}

function reasonFor(status, reasonCode, ourCell, theirCells) {
  if (status === 'no-value') {
    const parts = []
    if (!ourCell.present) parts.push(absenceText(ourCell))
    for (const cell of theirCells) {
      if (!cell.present) parts.push(absenceText(cell))
    }
    return `无值：${parts.join('；')} —— 「无值」不是「值相同」`
  }
  if (status === 'unit-mismatch') {
    if (reasonCode === 'unit-ambiguous') {
      return `单位不一致：${[ourCell, ...theirCells].map(cell => `${cell.asin ?? '一侧'}=${cell.units.join('/') || '无单位'}`).join('，')}`
        + ' 一个值里出现多个单位，无法判定同一单位；不猜换算'
    }
    if (reasonCode === 'unit-missing-one-side') {
      return `单位不一致：${[ourCell, ...theirCells].map(cell => `${cell.asin ?? '一侧'}=${cell.units[0] ?? '未标单位'}`).join('，')}`
        + ' 一侧未标单位，无法确认同一单位；不猜换算'
    }
    return `单位不一致：${[ourCell, ...theirCells].map(cell => `${cell.asin ?? '一侧'}=${cell.units[0] ?? '无单位'}`).join('，')}`
      + '；不猜换算'
  }
  if (status === 'period-mismatch') {
    return `测量期不一致（${[ourCell, ...theirCells].map(cell => `${cell.asin ?? '一侧'} ${cell.observedAt ?? '本处未记'}`).join(' / ')}），`
      + '按 §20.3 不用不同周期的两侧直接对比，本次不给判读'
  }
  if (status === 'period-unknown') {
    return `测量期未记（${[ourCell, ...theirCells].filter(cell => cell.observedAt === null).map(cell => cell.asin ?? '一侧').join('、') || '一侧'} 没有 observed_at），`
      + '无法确认同期 —— 「本处未记」不是「期不一致」'
  }
  return null
}

/**
 * Group ③ — compare our ASIN's attributes with a non-empty competitor set.
 *
 * Dimension set: by default the **43 required attributes** (the same denominator as
 * group ①, so "17/43 filled but only 2/43 comparable" is a sentence a reader can
 * check). `dimensions` overrides it for a focused audit. Values outside the
 * registry are reported in `ignoredKeys`, never silently dropped.
 *
 * Per dimension the aggregate is:
 *   - `no-value`        at least one side has no value (missing is not "same")
 *   - `unit-mismatch`   all sides have values, units differ / one side has none / ambiguous
 *   - `period-mismatch` all sides have values, units agree, observation periods differ (§20.3)
 *   - `period-unknown`  all sides have values, units agree, at least one period was never recorded
 *   - `same`            all pairs comparable and every competitor's value equals ours
 *   - `different`       all pairs comparable and at least one differs
 *
 * `numerator` = same + different (comparable dimensions). The six status counts
 * always sum to `denominator`; the test asserts that.
 */
export function compareDimensions({ marketplace = 'US', ours = null, competitors = [], dimensions = null } = {}) {
  const market = upper(marketplace)
  if (market === null) return badRequest('marketplace is required')
  if (!Array.isArray(competitors) || competitors.length === 0) {
    return badRequest('competitors must be a non-empty array')
  }

  const ourAsin = upper(ours?.asin)
  const seen = new Set()
  for (let index = 0; index < competitors.length; index += 1) {
    const competitorAsin = upper(competitors[index]?.asin)
    if (competitorAsin === null) return badRequest(`competitors[${index}].asin is required`)
    if (ourAsin !== null && competitorAsin === ourAsin) {
      return badRequest(`competitors[${index}] is the same ASIN as ours (${competitorAsin}) —— 自己和自己比会把每个维度都报成「值相同」`)
    }
    if (seen.has(competitorAsin)) return badRequest(`duplicate competitor ${competitorAsin}`)
    seen.add(competitorAsin)
  }

  const base = {
    ...baseGroup('comparability'),
    unit: '个维度可比',
    source: 'listing.attributes_json（我方 + 各竞品）→ 本文件逐维度三态；'
      + '测量期判据复用 domain/keywords/competitor.js#buildEvidenceView（§20.3 唯一实现）',
    observedAt: blankToNull(ours?.observedAt),
    observedAtAll: [],
    dimensions: [],
    counts: {
      same: 0, different: 0, noValue: 0, unitMismatch: 0, periodMismatch: 0, periodUnknown: 0,
      dimensionCount: 0,
    },
    basis: '分子 = 值相同 + 值不同（两侧都有值、单位一致、测量期一致）；分母 = 维度总数（默认 43 项必填属性）。'
      + '无值、单位不一致、测量期不一致/未记各自单列，都不进分子。计数来自枚举，不是 NOT NULL DEFAULT 0 的列，D-9 不适用：0 是数出来的 0。',
    note: null,
  }

  if (ours?.state === 'unreadable') {
    return {
      ...base,
      state: 'error',
      numerator: null,
      denominator: null,
      conclusion: 'GEO 事实没算出来：我方 attributes_json 读不出来（不是「没有值」）',
      note: '读失败不回落空态；先查 listing.attributes_json 的 JSON 是否损坏。',
    }
  }

  if (ours === null || ours === undefined || ours?.attributes === null || ours?.attributes === undefined) {
    return {
      ...base,
      state: 'no-source',
      numerator: null,
      denominator: null,
      conclusion: GEO_NO_SOURCE_TEXT,
      reason: '我方 listing 没有 attributes_json（这一栏从没被写过）—— 没有可比的一侧，不出 0/43。',
    }
  }

  const ourMap = normalizeAttributeMap(ours.attributes)
  if (ourMap === null) {
    return {
      ...base,
      state: 'error',
      numerator: null,
      denominator: null,
      conclusion: 'GEO 事实没算出来：我方 attributes_json 读不出来（不是「没有值」）',
      note: 'attributes_json 不是 JSON 对象；读失败不回落空态。',
    }
  }

  const competitorMaps = competitors.map(entry => normalizeAttributeMap(entry?.attributes))
  const explicit = Array.isArray(dimensions) && dimensions.length > 0
  let dimensionIds = explicit
    ? dimensions.map(id => String(id))
    : REQUIRED_ATTRIBUTES.filter(id => hasAttributeValue(ourMap[id])
      || competitorMaps.some(map => map !== null && hasAttributeValue(map[id])))
  /* Nothing filled on either side: keep the fixed 43 denominator and let every
     dimension be `no-value`. That is a measured 0/43 ("43 项都没有值"), not a
     no-source 0/0. */
  if (dimensionIds.length === 0) dimensionIds = [...REQUIRED_ATTRIBUTES]

  const ourCellFor = key => cellOf(ours, ours.attributes, key)
  const theirCellsFor = key => competitors.map((entry, index) => cellOf(entry, entry?.attributes, key))

  const rows = dimensionIds.map(key => {
    const ourCell = ourCellFor(key)
    const theirCells = theirCellsFor(key)
    const pairResults = theirCells.map(cell => comparePair(market, key, ourCell, cell))
    const statuses = pairResults.map(result => result.status)

    let status
    if (statuses.some(value => value === 'no-value')) status = 'no-value'
    else if (statuses.some(value => value === 'unit-mismatch')) status = 'unit-mismatch'
    else if (statuses.some(value => value === 'period-mismatch')) status = 'period-mismatch'
    else if (statuses.some(value => value === 'period-unknown')) status = 'period-unknown'
    else if (statuses.every(value => value === 'same')) status = 'same'
    else status = 'different'

    const reasonCode = pairResults.find(result => result.status === status)?.reasonCode ?? null
    return {
      key,
      label: ATTRIBUTES[key]?.label ?? key,
      modeled: Object.prototype.hasOwnProperty.call(ATTRIBUTES, key),
      status,
      statusLabel: GEO_COMPARABILITY_STATUS_LABELS[status],
      comparable: status === 'same' || status === 'different',
      reasonCode: status === 'same' || status === 'different' ? null : reasonCode,
      reason: status === 'same' || status === 'different' ? null : reasonFor(status, reasonCode, ourCell, theirCells),
      ours: ourCell,
      competitors: theirCells,
    }
  })

  const counts = {
    same: rows.filter(row => row.status === 'same').length,
    different: rows.filter(row => row.status === 'different').length,
    noValue: rows.filter(row => row.status === 'no-value').length,
    unitMismatch: rows.filter(row => row.status === 'unit-mismatch').length,
    periodMismatch: rows.filter(row => row.status === 'period-mismatch').length,
    periodUnknown: rows.filter(row => row.status === 'period-unknown').length,
    dimensionCount: rows.length,
  }
  const numerator = counts.same + counts.different

  const times = [...new Set([
    blankToNull(ours?.observedAt),
    ...competitors.map(entry => blankToNull(entry?.observedAt)),
  ].filter(value => value !== null))].sort()

  const registryKeys = new Set(Object.keys(ATTRIBUTES))
  const presentKeys = new Set([
    ...Object.keys(ourMap),
    ...competitorMaps.filter(map => map !== null).flatMap(map => Object.keys(map)),
  ])
  const dimensionSet = new Set(dimensionIds)
  /* Two different kinds of "not compared", kept apart:
     - unmodeledKeys: the key is not in the attribute registry at all;
     - ignoredKeys:   the key is modeled but outside this comparison's dimension set
                      (the 9 near-duplicates when the default 43 are used). */
  const unmodeledKeys = [...presentKeys].filter(key => !registryKeys.has(key)).sort()
  const ignoredKeys = [...presentKeys].filter(key => !dimensionSet.has(key)).sort()
  const allEmpty = Object.keys(ourMap).length === 0
    && competitorMaps.every(map => map === null || Object.keys(map).length === 0)

  return {
    ...base,
    state: allEmpty ? 'empty' : 'ok',
    numerator,
    denominator: counts.dimensionCount,
    observedAtAll: times,
    conclusion: `${numerator}/${counts.dimensionCount} 个对比维度可比`
      + `（值相同 ${counts.same} / 值不同 ${counts.different} / 无值 ${counts.noValue}`
      + ` / 单位不一致 ${counts.unitMismatch} / 测量期不一致 ${counts.periodMismatch}`
      + ` / 测量期未记 ${counts.periodUnknown}）`,
    dimensions: rows,
    counts,
    ignoredKeys,
    unmodeledKeys,
    note: allEmpty
      ? '我方与竞品的 attributes_json 都是空对象：43 个维度全部无值 —— 这是「写过了、里面没有值」，不是「本仓没有来源」。'
      : (ignoredKeys.length > 0
        ? `有 ${ignoredKeys.length} 个属性键不在本次对比维度内（${ignoredKeys.join('、')}），不进分母；`
          + `其中 ${unmodeledKeys.length} 个不在属性注册表里 —— 不拿未建模的键凑维度。`
        : null),
  }
}

/* ─────────────────────────────── group ④ consistency ──────────────────────── */

/**
 * Group ④ — fact consistency, implemented per **O-02 A 案**
 * (`team/decisions/O-02-geo-fact-consistency-2026-10-25.md`).
 *
 * ## 判据（提案 §4 J1–J6，逐条落在下面的函数里）
 *
 * J1 两处抽出的尺寸归一后不等 → 冲突；J2 ≥2 处抽出且归一后全等 → 一致；
 * J3 仅 1 处 / 两处单位不同 / 解析歧义 → 无法判定（三码）；J4 重量同 J1–J3；
 * J5 文案的数值声明指不到属性键的值 → 不可指；J6 指得到 → 可指（**不等于一致**）。
 *
 * ## 两组独立，绝不合成
 *
 * A 组（数值一致）的分母是**事实条数**（v1 只有 `dimensions` 与 `weight` 两条事实，
 * 所以 N ≤ 2）；B 组（声明有据）的分母是**文案里的数值声明条数**。两个分母量的是
 * 两个问题 —— 「值打不打架」与「说了有没有依据」—— 相加就是那个被禁的总分。
 *
 * `numerator/denominator` 印的是 **A 组的一致/可比计数**，供页面画 `n₁/N`；
 * 它不是一致性得分，B 组另有分母，两组不相加。`note` 逐字说明这件事。
 *
 * ## 抽取只用一份正则
 *
 * 尺寸/重量的抽取**全部走** `domain/optimize/plan.js#buildFactLedger`（GEO 派单
 * 明令「不许写第二份正则」）。本文件只加三样提案要求补的东西：归一化后的分组、
 * 三种「无法判定」原因码、B 组的可指/不可指计数。归一化复用本文件既有的
 * `normalizeComparableValue`（去空格 / 分隔符统一 x / 单位同义词 / 去尾零）。
 *
 * ## 明确不做的（v1）
 *
 * 非数值声明（防水/可机洗/材质词）**没有词典**，不抽 → 第四态 `uncovered`，
 * 不入任何分母。单位换算（lbs↔kg）不猜 → `unit-mismatch`。行事实数值比对
 * （文案 `$29.99` vs `asin.price`）要新增价格抽取口径 → v1 不做。
 * 模型判排除（不可复现）。
 *
 * ## 证据行的 `evidenceType` 不是 `empty.kind`
 *
 * 本文件**不用** `{ kind, text }` 这个形状：那是本仓留给**空切片**的（见
 * `domain/ui/empty-kind.js` 文件头「domain 里的空切片长这样」），它的 `kind` 必须
 * 在映射表里有归宿，否则 `tests/empty-kind-map.mjs` 会红。证据行是「这一条证据是
 * 什么类型」（冲突 / 一致 / 单源 / …），不是空态，套用那个形状等于把两套词汇混成
 * 一套。所以字段叫 `evidenceType`，空的时候的做法是**整块不画**（页面只在
 * `evidence.length > 0` 时渲染），而不是画一个「这一类是空的」。
 */

/** v1 覆盖的两条事实。闭集 —— 加一条就要同时想清它的属性键与归一化。 */
export const GEO_CONSISTENCY_FACT_IDS = ['dimensions', 'weight']

/**
 * 三种「无法判定」原因码。闭集，且**优先级写死在 classify 里**：
 * 解析歧义 > 单位不一致 > 单源。理由：越读不出原值越不能判，而「只有一处」
 * 是最后才轮到的问题 —— 一处也能读，只是没有对照物。
 */
export const GEO_UNDECIDABLE_CODES = ['single-source', 'unit-mismatch', 'parse-ambiguous']

/**
 * 一条声明指向的属性键（提案 §4 J5 的键清单）。
 *
 * `item_thickness` 在提案清单里，但 v1 的抽取器没有「单个数 = 厚度」这种形状
 * （`DIMENSION_RE` 要三段、`WEIGHT_RE` 要单位），所以它**映射不到任何事实**，
 * 单独列进 `GEO_UNMAPPED_ATTRIBUTE_KEYS` 而不是悄悄当作没有。
 */
export const GEO_FACT_ATTRIBUTE_KEYS = {
  dimensions: ['product_dimensions', 'size'],
  weight: ['item_weight', 'product_weight'],
}

export const GEO_UNMAPPED_ATTRIBUTE_KEYS = ['item_thickness']

/* v1 的文案面就是这五栏（title 与 bullets 逐条铺开成 bullet_N）。`a_plus` 不在内 ——
   提案把 A+ 内文字归「本仓没有来源」（无 OCR 通道），借这一列会造出一个假来源。 */
const GEO_CONSISTENCY_SOURCE = 'listing.title/bullets_json/description/search_terms/item_highlights'
  + ' + listing.attributes_json（抽取复用 optimize/plan.js#buildFactLedger）'

/** 证据原文截断长度：够认出是哪一句，又不至于把整条描述抄进报告。 */
const EVIDENCE_CLIP = 60

function evidenceClip(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > EVIDENCE_CLIP ? `${text.slice(0, EVIDENCE_CLIP)}…` : text
}

/** `{ title, bullets[], description, search_terms, item_highlights }` → `{ field: text }`. */
function copyFieldsOf(copy) {
  const out = {}
  const put = (name, value) => {
    const text = blankToNull(value)
    if (text !== null) out[name] = text
  }
  if (copy === null || copy === undefined) return out
  put('title', copy.title)
  const bullets = Array.isArray(copy.bullets) ? copy.bullets : []
  bullets.forEach((bullet, index) => put(`bullet_${index + 1}`, bullet))
  put('description', copy.description)
  put('search_terms', copy.search_terms)
  put('item_highlights', copy.item_highlights)
  return out
}

/**
 * 一份字段文本 → 尺寸/重量抽取结果。**一次一个字段**地调 `buildFactLedger`：
 * 台账把「值」归并了，而证据要的是「哪个字段说的哪个原文」，所以按字段问一遍。
 * 抽取器仍然只有那一份 —— 这里没有一条自己的数字正则。
 */
function factOccurrencesOf(fields) {
  const out = []
  for (const [field, text] of Object.entries(fields)) {
    const ledger = buildFactLedger({ listing: null, fields: { [field]: text } })
    for (const row of ledger.rows) {
      if (!GEO_CONSISTENCY_FACT_IDS.includes(row.id)) continue
      for (const occurrence of row.occurrences) {
        out.push({
          factId: row.id,
          field,
          raw: String(occurrence.raw ?? ''),
          value: String(row.value),
        })
      }
    }
  }
  return out
}

/**
 * 同一个字段里**两段**的尺寸（`44x19`）—— 提案 J3 点名的解析歧义。
 *
 * 先把完整的三段原文遮掉再找两段：`DIMENSION_RE` 结构上就匹配不到两段，
 * 所以「44x19 会静默消失」是它的正常行为，必须由这一层补出来，否则这条声明
 * 会被当成「没有声明」而不是「读不出来」。这不是第二份抽取正则 —— 它找的是
 * 抽取器**故意不认**的形状。
 */
function ambiguousSegmentTokens(text, completeRaws) {
  let rest = String(text ?? '')
  for (const raw of completeRaws) {
    if (raw !== '') rest = rest.replace(raw, ' ')
  }
  const out = []
  for (const match of rest.matchAll(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/g)) {
    out.push(String(match[0]).trim())
  }
  return out
}

/** 重量原文 → 它的单位（canonical）。一个值里两个单位 = 判不出来。 */
function weightUnitsOf(raw) {
  const units = attributeUnitsOf(raw)
  return units.length === 1 ? units[0] : null
}

function consistencyFailClosed(reason) {
  return {
    ...baseGroup('consistency'),
    state: 'error',
    pending: false,
    errorCode: 'BAD_REQUEST',
    numerator: null,
    denominator: null,
    unit: null,
    source: GEO_CONSISTENCY_SOURCE,
    observedAt: null,
    writtenAt: null,
    conclusion: '缺入参：本组不出计数',
    reason,
    factIds: [...GEO_CONSISTENCY_FACT_IDS],
    undecidableCodes: [...GEO_UNDECIDABLE_CODES],
    consistencyA: null,
    consistencyB: null,
    uncoveredCount: null,
    uncovered: [],
    evidence: [],
    basis: '缺 asin / marketplace 就不知道该判谁 —— 出 0/0 或空计数都是编数。',
    note: null,
  }
}

/**
 * Group ④ from injected facts. **Pure** — no store access.
 *
 * `copy` is the flattened listing copy (`{ title, bullet_1, …, description, … }`),
 * `attributes` is the raw `listing.attributes_json` object (either keying).
 * `copyState` distinguishes the ways there can be no copy: `present` / `empty`
 * (row exists, six surfaces blank) / `no-row` (no listing row at all) /
 * `unreadable` (the column holds something that is not JSON) / `bad-request`.
 *
 * Returns a group object. `consistencyA.factCount === consistent + conflicted +
 * undecidable` and `consistencyB.declarationCount === pointable + unpointable +
 * undecidable` hold by construction; `uncoveredCount` is in **neither**.
 */
export function consistencyGroupFromFacts({
  asin, marketplace, copy = null, copyState = null, attributes = null, writtenAt = null,
} = {}) {
  if (blankToNull(asin) === null) {
    return consistencyFailClosed('asin is required —— 缺 ASIN 不知道该判哪条 listing 的一致性')
  }
  if (blankToNull(marketplace) === null) {
    return consistencyFailClosed('marketplace is required —— 同一个 ASIN 在不同站点是两条记录')
  }

  const copyMap = copy === null || copy === undefined
    ? {}
    : (typeof copy === 'object' && !Array.isArray(copy) ? copy : {})
  const copyNames = Object.keys(copyMap).sort()
  const attributeMap = normalizeAttributeMap(attributes)
  const attributeFields = attributeMap === null ? {} : attributeFieldsOf(attributeMap)

  const base = {
    ...baseGroup('consistency'),
    pending: false,
    source: GEO_CONSISTENCY_SOURCE,
    observedAt: null,          /* 文案没有「事实在世界上成立的时间」这一列 */
    writtenAt: blankToNull(writtenAt),  /* listing.updated_at：写入时间，不是观测时间 */
    factIds: [...GEO_CONSISTENCY_FACT_IDS],
    undecidableCodes: [...GEO_UNDECIDABLE_CODES],
    attributeKeys: { ...GEO_FACT_ATTRIBUTE_KEYS },
    unmappedAttributeKeys: [...GEO_UNMAPPED_ATTRIBUTE_KEYS],
    uncovered: [],
    uncoveredCount: 0,
    evidence: [],
    note: 'numerator/denominator 是 A 组的「一致/可比」计数，供页面画 n₁/N —— **不是一致性得分**；'
      + 'B 组另有分母（数值声明条数），两组不相加。',
    basis: 'O-02 A 案：A 组（数值一致）+ B 组（声明有据）两组独立计数；'
      + '非数值声明不入任何分母，单列「v1 未覆盖」。',
  }

  const state = copyState ?? (copyNames.length === 0 ? 'empty' : 'present')

  /* 既没有文案也没有属性 —— 三种「没有」要分开说，且都不许印成 0。 */
  if (copyNames.length === 0 && Object.keys(attributeFields).length === 0) {
    const reason = state === 'no-row'
      ? 'listing 表里没有这条 ASIN 的行：不是「一致」，是这一条从来没被采过文案。'
      : (state === 'unreadable'
        ? 'listing.bullets_json 读不成 JSON 数组：这是读失败，不是「文案为空」。'
        : 'listing 行在，但六栏文案与 attributes_json 都是空的：没有可比的声明。')
    return {
      ...base,
      state: 'empty',
      numerator: null,
      denominator: null,
      unit: null,
      conclusion: '没有可比的文案，本组不出比值',
      reason,
      copyState: state,
      consistencyA: {
        factCount: 0, consistent: 0, conflicted: 0, undecidable: 0,
        undecidableCodes: { singleSource: 0, unitMismatch: 0, parseAmbiguous: 0 },
        facts: [], evidence: [],
      },
      consistencyB: {
        declarationCount: 0, pointable: 0, unpointable: 0, undecidable: 0, declarations: [], evidence: [],
      },
    }
  }

  const allFields = { ...copyMap, ...attributeFields }
  const copySet = new Set(copyNames)
  const extracted = factOccurrencesOf(allFields)

  /* 解析歧义按「字段」找：完整三段先遮掉，剩下的两段就是读不出来的形状。 */
  const ambiguous = []
  for (const [field, text] of Object.entries(allFields)) {
    const completeRaws = extracted
      .filter(entry => entry.factId === 'dimensions' && entry.field === field)
      .map(entry => entry.raw)
    for (const token of ambiguousSegmentTokens(text, completeRaws)) {
      ambiguous.push({ field, raw: token })
    }
  }

  /* ── A 组：数值一致（J1–J4） ─────────────────────────────────────────── */
  const facts = []
  for (const factId of GEO_CONSISTENCY_FACT_IDS) {
    const entries = extracted.filter(entry => entry.factId === factId)
    const ambiguousHere = factId === 'dimensions' ? ambiguous : []
    /* 一处都没抽出、也没有读不出来的形状 —— 这条事实在这次 listing 里不存在，
       不進分母（「没写」不是「无法判定」）。 */
    if (entries.length === 0 && ambiguousHere.length === 0) continue

    const places = [...new Set(entries.map(entry => entry.field))].sort()
    const label = factId === 'dimensions' ? '尺寸（长x宽x高）' : '重量'
    const fact = { factId, label, status: null, reasonCode: null, places, occurrences: entries.length }

    if (ambiguousHere.length > 0) {
      /* J3：解析歧义优先 —— 连原值都读不出来的字段，不能据它判「一致」。 */
      fact.status = 'undecidable'
      fact.reasonCode = 'parse-ambiguous'
      fact.reason = `有 ${ambiguousHere.length} 处只有两段，抽取器读不成三元组：`
        + ambiguousHere.map(entry => `${entry.field}="${evidenceClip(entry.raw)}"`).join(' / ')
      fact.evidence = ambiguousHere.map(entry => ({
        evidenceType: 'parse-ambiguous', field: entry.field, raw: entry.raw,
        text: `${label}：${entry.field} 里的 "${evidenceClip(entry.raw)}" 只有两段，读不成三元组（解析歧义）`,
      }))
    } else if (places.length < 2) {
      /* J3：只有一处 —— 没有对照物。 */
      fact.status = 'undecidable'
      fact.reasonCode = 'single-source'
      fact.reason = `只在 ${places.join('、')} 出现过一次，没有第二处可对照`
      fact.evidence = entries.map(entry => ({
        evidenceType: 'single-source', field: entry.field, raw: entry.raw,
        text: `${label}：只有 ${entry.field} 说了 "${evidenceClip(entry.raw)}"，没有第二处可对照`,
      }))
    } else {
      const units = factId === 'weight'
        ? [...new Set(entries.map(entry => weightUnitsOf(entry.raw)))]
        : []
      if (factId === 'weight' && (units.length !== 1 || units[0] === null)) {
        /* J4/J3：异单位不换算 —— 20 lbs 与 9 kg 是「判不了」，不是「冲突」。 */
        fact.status = 'undecidable'
        fact.reasonCode = 'unit-mismatch'
        const shown = [...new Set(entries.map(entry => String(entry.raw).trim()))].sort()
        fact.reason = `单位不一致（${shown.join(' / ')}），v1 不换算`
        fact.evidence = entries.map(entry => ({
          evidenceType: 'unit-mismatch', field: entry.field, raw: entry.raw,
          text: `${label}：${entry.field} 说 "${evidenceClip(entry.raw)}" —— 单位不一致，v1 不换算，判不了`,
        }))
      } else {
        const byValue = new Map()
        for (const entry of entries) {
          const normalized = normalizeComparableValue(entry.value)
          if (!byValue.has(normalized)) byValue.set(normalized, [])
          byValue.get(normalized).push(entry)
        }
        const values = [...byValue.keys()].sort()
        if (values.length > 1) {
          /* J1：两处归一后不等 → 冲突。证据**一行带齐每一处的字段名+原文**，
             读者点开就在同一行里看到 "title=… vs attribute.…=…"。 */
          fact.status = 'conflicted'
          fact.reasonCode = null
          fact.values = values
          fact.reason = `同一个事实出现了 ${values.length} 个不同取值：`
            + values.map(value => `${value}`).join(' / ')
          const sides = []
          for (const value of values) {
            const entriesOfValue = byValue.get(value)
              .slice()
              .sort((a, b) => a.field.localeCompare(b.field))
            for (const entry of entriesOfValue) {
              sides.push({ value, field: entry.field, raw: entry.raw })
            }
          }
          fact.evidence = [{
            evidenceType: 'conflict',
            field: sides[0].field,
            raw: sides[0].raw,
            sides: sides.map(side => ({ value: side.value, field: side.field, raw: side.raw })),
            text: `${label} 冲突：` + sides
              .map(side => `${side.field}="${evidenceClip(side.raw)}"（${side.value}）`)
              .join(' vs '),
          }]
        } else {
          /* J2：≥2 处抽出且归一后全等 → 一致。 */
          fact.status = 'consistent'
          fact.reasonCode = null
          fact.values = values
          fact.reason = `${places.length} 处抽出同一取值 ${values[0]}`
          fact.evidence = [{
            evidenceType: 'consistent', field: places[0], raw: entries[0].raw,
            text: `${label}：${places.length} 处（${places.join('、')}）归一后都是 "${values[0]}"`,
          }]
        }
      }
    }
    facts.push(fact)
  }

  const consistent = facts.filter(fact => fact.status === 'consistent').length
  const conflicted = facts.filter(fact => fact.status === 'conflicted').length
  const undecidable = facts.filter(fact => fact.status === 'undecidable').length
  const factCount = facts.length
  const codeCount = code => facts.filter(fact => fact.reasonCode === code).length

  const consistencyA = {
    factCount,
    consistent,
    conflicted,
    undecidable,
    undecidableCodes: {
      singleSource: codeCount('single-source'),
      unitMismatch: codeCount('unit-mismatch'),
      parseAmbiguous: codeCount('parse-ambiguous'),
    },
    facts: facts
      .map(fact => ({ ...fact, evidence: (fact.evidence ?? []).slice() }))
      .sort((a, b) => a.factId.localeCompare(b.factId)),
    evidence: facts.flatMap(fact => fact.evidence ?? []),
    unit: '条可比事实',
  }

  /* ── B 组：声明有据（J5/J6） ─────────────────────────────────────────── */
  /* 「一条声明」= 一个 (事实, 归一后的值)。同一句复述三遍是世界上的同一个主张，
     数三遍会把分母吹大 —— 所以按值去重，并把出现位置全部留下。 */
  const declarationMap = new Map()
  for (const entry of extracted) {
    if (!copySet.has(entry.field)) continue
    const normalized = normalizeComparableValue(entry.value)
    const key = `${entry.factId}|${normalized}`
    if (!declarationMap.has(key)) {
      declarationMap.set(key, { factId: entry.factId, value: normalized, places: [], raws: [] })
    }
    const declaration = declarationMap.get(key)
    if (!declaration.places.includes(entry.field)) declaration.places.push(entry.field)
    declaration.raws.push(entry.raw)
  }

  const declarations = []
  for (const declaration of [...declarationMap.values()]
    .sort((a, b) => (a.factId === b.factId ? a.value.localeCompare(b.value) : a.factId.localeCompare(b.factId)))) {
    const keys = GEO_FACT_ATTRIBUTE_KEYS[declaration.factId] ?? []
    const pointed = keys.filter(key => hasAttributeValue(attributeMap?.[key]))
    const places = declaration.places.slice().sort()
    const raw = declaration.raws[0]
    const row = {
      factId: declaration.factId,
      value: declaration.value,
      places,
      raw,
      candidateKeys: keys.slice(),
    }
    if (pointed.length > 0) {
      /* J6：可指 —— 只回答「指得到一处有值证据」，**不声称一致**。 */
      row.status = 'pointable'
      row.pointedKeys = pointed
      row.pointedValues = pointed.map(key => `${key}="${evidenceClip(attributeMap[key])}"`)
      row.evidence = [{
        evidenceType: 'pointable', field: places[0], raw,
        text: `声明 ${places.join('、')} "${evidenceClip(raw)}" → 证据 ${row.pointedValues.join(' / ')}（可指 ≠ 一致）`,
      }]
    } else {
      /* J5：指不到 —— 对应属性键 NULL 或占位。这是 B 组真正要抓的那类问题。 */
      row.status = 'unpointable'
      row.pointedKeys = []
      row.gapKeys = keys.map(key => ({
        key,
        state: attributeMap === null || attributeMap[key] === undefined ? 'never-written' : 'placeholder',
      }))
      row.evidence = [{
        evidenceType: 'unpointable', field: places[0], raw,
        text: `声明 ${places.join('、')} "${evidenceClip(raw)}" 指不到值：`
          + keys.map(key => `${key}=本处未记`).join('、'),
      }]
    }
    declarations.push(row)
  }

  /* 解析歧义的声明也进 B 组，但只能记「无法判定」—— 连它是不是尺寸都读不准。 */
  const copyAmbiguous = ambiguous
    .filter(entry => copySet.has(entry.field))
    .slice()
    .sort((a, b) => (a.field === b.field ? a.raw.localeCompare(b.raw) : a.field.localeCompare(b.field)))
  for (const entry of copyAmbiguous) {
    declarations.push({
      factId: 'dimensions',
      value: entry.raw,
      places: [entry.field],
      raw: entry.raw,
      candidateKeys: GEO_FACT_ATTRIBUTE_KEYS.dimensions.slice(),
      status: 'undecidable',
      reasonCode: 'parse-ambiguous',
      evidence: [{
        evidenceType: 'parse-ambiguous', field: entry.field, raw: entry.raw,
        text: `声明 ${entry.field} "${evidenceClip(entry.raw)}" 只有两段，读不出是尺寸还是别的，无法判定`,
      }],
    })
  }

  const pointable = declarations.filter(row => row.status === 'pointable').length
  const unpointable = declarations.filter(row => row.status === 'unpointable').length
  const bUndecidable = declarations.filter(row => row.status === 'undecidable').length
  const consistencyB = {
    declarationCount: declarations.length,
    pointable,
    unpointable,
    undecidable: bUndecidable,
    declarations: declarations.slice().sort((a, b) => {
      if (a.status !== b.status) return a.status.localeCompare(b.status)
      return a.factId === b.factId ? String(a.value).localeCompare(String(b.value)) : a.factId.localeCompare(b.factId)
    }),
    evidence: declarations.flatMap(row => row.evidence ?? []),
  }

  /* ── 第四态：v1 未覆盖（不入任何分母） ───────────────────────────────── */
  /* 没有词典就数不出「几条非数值声明」。这里数的是**这一栏文案没有任何可抽取的
     数值事实** —— 一个可复现、可点开原文的数，而不是一个猜出来的声明条数。 */
  const uncovered = copyNames
    .filter(field => !extracted.some(entry => entry.field === field)
      && !copyAmbiguous.some(entry => entry.field === field))
    .map(field => ({ field, excerpt: evidenceClip(copyMap[field]) }))

  const hasAnyFact = factCount > 0

  return {
    ...base,
    state: hasAnyFact ? 'ok' : 'empty',
    numerator: hasAnyFact ? consistent : null,
    denominator: hasAnyFact ? factCount : null,
    unit: hasAnyFact ? '条可比事实' : null,
    conclusion: hasAnyFact
      ? `可比事实 ${factCount} 条 = 一致 ${consistent} / 冲突 ${conflicted} / 无法判定 ${undecidable}`
      : '文案里抽不出尺寸/重量数值事实：不是「一致」，是这一组没有可比的事实',
    reason: hasAnyFact
      ? null
      : '抽取器（DIMENSION_RE 三段 / WEIGHT_RE 带单位）在这条 listing 的文案与属性里都没有命中：'
        + '本组不画 0/0 —— 0/0 会被读成「全都不一致」。',
    copyState: state,
    consistencyA,
    consistencyB,
    uncoveredCount: uncovered.length,
    uncovered,
    evidence: [...consistencyA.evidence, ...consistencyB.evidence],
  }
}

/**
 * Group ④ 在没有**文案输入**时的兼容态。
 *
 * ⚠ 这是**过渡契约**，不是判据：`buildGeoFacts` 的旧调用方不传文案，这一路就
 * 只回 pending。需求方已按 O-02 **A 案拍板**，判据实现在 `consistencyGroupFromFacts`；
 * 详情页走 `readGeoFacts`，会拿到真实的 A/B 两组计数。
 * 退役这一个 pending 分支需要同步改 `tests/t71-geo-citability.mjs` 的 T71-1 / T71-8 / T71-15
 * （它把 `pending:true` + `判据待 O-02 拍板` 逐字钉死），故不在本次写域内。
 */
export function consistencyGroup() {
  return {
    ...baseGroup('consistency'),
    state: 'pending',
    pending: true,
    numerator: null,
    denominator: null,
    unit: null,
    source: 'field_conflict（拟）—— 这一路没有文案输入，本组不读表',
    observedAt: null,
    observedAtAll: [],
    conclusion: GEO_PENDING_NOTE,
    note: GEO_PENDING_NOTE,
    basis: '第四组判据已由 O-02 A 案拍板，实现在 consistencyGroupFromFacts；'
      + '本分支只覆盖「调用方没有传入文案」这一路，不出任何一致性结论。',
  }
}

/* ─────────────────────────────── assemble four ────────────────────────────── */

/**
 * Group ③ when there is **no competitor set at all**.
 *
 * This is not a coverage hole: keyword-position comparability belongs to the
 * existing competitor quadrant F06-04. What is missing here is the competitor
 * relationship itself (`asin_competitor` has no active edge), so the group cannot
 * compare attributes and must say so — not print `0/43` and not call it "no
 * difference". `numerator/denominator` stay `null` for the same reason a
 * no-source group does: there is no ratio to compute.
 */
export function noCompetitorGroup() {
  return {
    ...baseGroup('comparability'),
    state: 'no-source',
    numerator: null,
    denominator: null,
    unit: null,
    source: 'asin_competitor（active 竞品关系）',
    observedAt: null,
    observedAtAll: [],
    conclusion: '没有竞品组：本组无法比较',
    reason: 'asin_competitor 里没有这条 ASIN 的 active 竞品关系（family 或 child scope）—— 缺的是竞品组本身，不是「没有差异」；'
      + '词位可比性由既有竞品象限 F06-04 覆盖，不是本组的覆盖洞。',
    dimensions: [],
    counts: {
      same: 0, different: 0, noValue: 0, unitMismatch: 0, periodMismatch: 0, periodUnknown: 0,
      dimensionCount: 0,
    },
    ignoredKeys: [],
    unmodeledKeys: [],
    basis: '没有竞品组 = 组③未比较；不出 0/43，也不把「没有竞品」写成「0 个维度可比」。',
    note: null,
  }
}

/** Fold the four groups into the one payload. No aggregate key, on purpose. */
function assembleGeoFacts({ asin, marketplace, attribute, qa, comparability, consistency }) {
  return {
    ok: true,
    asin,
    marketplace,
    at: new Date().toISOString(),
    groups: [attribute, qa, comparability, consistency],
    groupIds: [...GEO_GROUP_IDS],
    noSourceText: GEO_NO_SOURCE_TEXT,
    pendingNote: GEO_PENDING_NOTE,
  }
}

/**
 * Build the four groups from injected data. **Pure** — no store access.
 *
 * `health` is required (the output of `buildAsinHealthSummary`); `ours` is the
 * attribute facts of the ASIN under audit (`{ asin, attributes, observedAt }`);
 * `competitors` is a non-empty array of the same shape.
 *
 * Group ④ (O-02 A 案) needs the listing copy. Two ways in, both **injections**
 * rather than a second read (same discipline as `fields` below):
 *   - `consistency` — an already-built group (the `readGeoFacts` path);
 *   - `copy` — the flattened copy (`{ title, bullet_1, … }`), built here.
 * Neither given ⇒ the legacy `pending` slot: the old callers have no copy, and
 * inventing a verdict from nothing is the thing this module must not do.
 *
 * Returns `{ ok: true, asin, marketplace, at, groups, groupIds, noSourceText,
 * pendingNote }`. There is deliberately **no** aggregate/score/summary key.
 */
export function buildGeoFacts({
  asin, marketplace = 'US', health, ours = null, competitors = [], dimensions = null,
  copy = null, copyState = null, consistency = null,
} = {}) {
  const code = upper(asin)
  if (code === null) return badRequest('asin is required')
  const market = upper(marketplace)
  if (market === null) return badRequest('marketplace is required')
  if (!Array.isArray(competitors) || competitors.length === 0) {
    return badRequest('competitors must be a non-empty array')
  }
  if (health === undefined || health === null) {
    const error = new Error('buildGeoFacts 需要调用方给出 health（domain/asin/health.js#buildAsinHealthSummary 的产出）—— '
      + '不给就会把「没人算过」静默读成「0 项」')
    error.code = 'GEO_HEALTH_REQUIRED'
    throw error
  }

  const attribute = attributeGroupFromHealth(health, {
    attributes: ours?.attributes ?? null,
    observedAt: ours?.observedAt ?? null,
    state: ours?.state ?? null,
  })
  const qa = qaGroup()
  const comparability = compareDimensions({
    marketplace: market,
    ours: ours === null || ours === undefined ? null : { ...ours, asin: ours.asin ?? code },
    competitors,
    dimensions,
  })
  if (comparability.ok === false) return comparability

  let consistencyGroupBuilt
  if (consistency !== null && consistency !== undefined) {
    consistencyGroupBuilt = consistency
  } else if (copy === null || copy === undefined) {
    consistencyGroupBuilt = consistencyGroup()
  } else {
    consistencyGroupBuilt = consistencyGroupFromFacts({
      asin: code,
      marketplace: market,
      copy,
      copyState,
      attributes: ours?.attributes ?? null,
      writtenAt: ours?.writtenAt ?? null,
    })
  }

  return assembleGeoFacts({
    asin: code, marketplace: market, attribute, qa, comparability, consistency: consistencyGroupBuilt,
  })
}

/* ─────────────────────────── thin store adapters ──────────────────────────── */

/**
 * Read one side's attribute facts. **Thin**: two SELECTs, no judgement.
 *
 * `state` distinguishes the three ways a side can have no attributes:
 *   - `present`       `attributes_json` parsed to an object (may be `{}`)
 *   - `never-written` no row / NULL / empty string — "nobody recorded this"
 *   - `unreadable`    the column holds something that is not a JSON object — an error,
 *                     not "empty"
 *
 * `observedAt` is `MAX(asin_field_source.observed_at)` over `attribute.*` — the
 * time the fact was true in the world. `writtenAt` is `listing.updated_at`, which
 * is a write time and is **not** substituted for an observation time.
 */
export function readAttributeFacts(store, { asin, marketplace = 'US' } = {}) {
  const code = upper(asin)
  const market = upper(marketplace)
  if (code === null) return { asin: null, marketplace: market, attributes: null, state: 'unreadable', observedAt: null, writtenAt: null }
  if (market === null) return { asin: code, marketplace: null, attributes: null, state: 'unreadable', observedAt: null, writtenAt: null }

  const row = store.get(
    'SELECT attributes_json, updated_at FROM listing WHERE asin = ? AND marketplace = ?',
    [code, market],
  )

  let attributes = null
  let state = 'never-written'
  if (row !== undefined && row !== null && row.attributes_json !== null && String(row.attributes_json).trim() !== '') {
    try {
      const parsed = JSON.parse(String(row.attributes_json))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        attributes = parsed
        state = 'present'
      } else {
        state = 'unreadable'
      }
    } catch {
      state = 'unreadable'
    }
  }

  const observed = store.get(
    `SELECT MAX(observed_at) AS at FROM asin_field_source
      WHERE asin = ? AND marketplace = ? AND field LIKE 'attribute.%'`,
    [code, market],
  )
  /* Per-key times, so a dimension does not borrow another dimension's date. */
  const observedRows = store.all(
    `SELECT field, MAX(observed_at) AS at FROM asin_field_source
      WHERE asin = ? AND marketplace = ? AND field LIKE 'attribute.%'
      GROUP BY field`,
    [code, market],
  )
  const observedByKey = {}
  for (const entry of observedRows) {
    const field = String(entry.field ?? '')
    const key = field.startsWith('attribute.') ? field.slice('attribute.'.length) : field
    if (key !== '' && entry.at !== null && entry.at !== undefined) observedByKey[key] = entry.at
  }

  return {
    asin: code,
    marketplace: market,
    attributes,
    state,
    observedAt: observed?.at ?? null,
    observedByKey,
    writtenAt: row?.updated_at ?? null,
  }
}

/**
 * Read the listing copy group ④ compares. **Thin**: one SELECT, no judgement.
 *
 * `state` keeps the ways of having no copy apart, because they are three different
 * sentences to a reader:
 *   - `present`    at least one copy surface holds text
 *   - `empty`      the listing row exists but all six surfaces are blank
 *   - `no-row`     there is no `listing` row at all — never collected
 *   - `unreadable` `bullets_json` is not a JSON array — a read failure, not "empty"
 *
 * `writtenAt` is `listing.updated_at`: **a write time**, not the time the fact was
 * true in the world. Group ④ reports it as such and leaves `observedAt` null.
 * `a_plus` is deliberately not read: the proposal puts A+ image text in
 * 「本仓没有来源」(no OCR channel), so borrowing the column would fake a source.
 */
export function readListingCopy(store, { asin, marketplace = 'US' } = {}) {
  const code = upper(asin)
  const market = upper(marketplace)
  if (code === null || market === null) {
    return { asin: code, marketplace: market, fields: {}, state: 'bad-request', writtenAt: null }
  }
  const row = store.get(
    `SELECT title, bullets_json, description, search_terms, item_highlights, updated_at
       FROM listing WHERE asin = ? AND marketplace = ?`,
    [code, market],
  )
  if (row === undefined || row === null) {
    return { asin: code, marketplace: market, fields: {}, state: 'no-row', writtenAt: null }
  }

  let bullets = []
  let bulletsUnreadable = false
  if (row.bullets_json !== null && row.bullets_json !== undefined && String(row.bullets_json).trim() !== '') {
    try {
      const parsed = JSON.parse(String(row.bullets_json))
      if (Array.isArray(parsed)) bullets = parsed
      else bulletsUnreadable = true
    } catch {
      bulletsUnreadable = true
    }
  }

  const fields = copyFieldsOf({
    title: row.title,
    bullets,
    description: row.description,
    search_terms: row.search_terms,
    item_highlights: row.item_highlights,
  })

  const state = Object.keys(fields).length > 0
    ? 'present'
    : (bulletsUnreadable ? 'unreadable' : 'empty')

  return {
    asin: code,
    marketplace: market,
    fields,
    state,
    bulletsUnreadable,
    writtenAt: row.updated_at ?? null,
  }
}

/**
 * The integration entry point: resolve the injections the pure builder needs and
 * call it. It reads `buildFieldFacts` / `evaluatePrecheck` / `buildAsinHealthSummary`
 * — the **same** three calls `amzn_asin_health` makes — so group ① cannot drift
 * from the health card.
 *
 * Group ④ (O-02 A 案) reads the listing copy once here and injects the finished
 * group, so the pure builder does not read the store and the copy is not read twice.
 *
 * `competitors`:
 *   - **omitted** — resolve the ASIN's active competitor set from `asin_competitor`
 *     (the detail page's path). If there is no competitor set, group ③ is a
 *     `no-source` "没有竞品组" card, not a `BAD_REQUEST`: a page must still render
 *     the other three groups.
 *   - **provided** — must be a non-empty array (ASIN strings or `{ asin }` objects).
 *     An explicit empty array is still fail-closed, because "I passed nobody" is a
 *     caller bug, not the same fact as "this ASIN has no competitor set".
 *
 * `fields` may be injected (the detail builder already computed it) to avoid a
 * second `buildFieldFacts` pass; it is the same function either way.
 */
export function readGeoFacts(store, { asin, marketplace = 'US', competitors, fields } = {}) {
  const code = upper(asin)
  if (code === null) return badRequest('asin is required')
  const market = upper(marketplace)
  if (market === null) return badRequest('marketplace is required')
  if (competitors !== undefined && (!Array.isArray(competitors) || competitors.length === 0)) {
    return badRequest('competitors must be a non-empty array')
  }

  const fieldFacts = fields === undefined ? buildFieldFacts(store, { asin: code, marketplace: market }) : fields
  if (fieldFacts === null) {
    return {
      ok: false,
      code: 'ASIN_NOT_FOUND',
      error: `${code} (${market}) 不在库内`,
      hint: '先用 amzn_asin_upsert 导入，或确认站点代码对不对 —— 同一个 ASIN 在不同站点是两条记录',
    }
  }
  const precheck = evaluatePrecheck(store, { asin: code, marketplace: market, mode: 'full' })
  const health = buildAsinHealthSummary(store, { asin: code, marketplace: market, fields: fieldFacts, precheck })
  if (health.ok !== true) return health

  const ours = readAttributeFacts(store, { asin: code, marketplace: market })
  const copy = readListingCopy(store, { asin: code, marketplace: market })
  const consistency = consistencyGroupFromFacts({
    asin: code,
    marketplace: market,
    copy: copy.fields,
    copyState: copy.state,
    attributes: ours.attributes,
    writtenAt: copy.writtenAt ?? ours.writtenAt,
  })

  let list
  if (competitors === undefined) {
    const family = familyCompetitorsFor(store, { marketplace: market, asin: code })
    list = Array.isArray(family.competitors) ? family.competitors : []
  } else {
    list = competitors
  }

  if (list.length === 0) {
    const attribute = attributeGroupFromHealth(health, {
      attributes: ours.attributes,
      observedAt: ours.observedAt,
      state: ours.state,
    })
    return assembleGeoFacts({
      asin: code,
      marketplace: market,
      attribute,
      qa: qaGroup(),
      comparability: noCompetitorGroup(),
      consistency,
    })
  }

  const sides = list.map(entry => {
    const competitorAsin = typeof entry === 'string' ? entry : entry?.asin
    return readAttributeFacts(store, { asin: competitorAsin, marketplace: market })
  })

  return buildGeoFacts({
    asin: code, marketplace: market, health, ours, competitors: sides, consistency,
  })
}
