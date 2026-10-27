/**
 * Field budgets — how much room each field has, and how to fit into it.
 *
 * This is a different job from `rules/listing-rules.js` and is kept apart on
 * purpose. A rule answers "is this legal"; a budget answers "how much space is
 * left". A field can be perfectly legal at 40 characters and still be a waste of
 * a 200-character slot, and it can be legal at 249 backend bytes and still be
 * the last byte it will ever get.
 *
 * The unit is part of the budget, not an afterthought: `search_terms` is capped
 * in **bytes**, everything else in characters. A Chinese character costs 3 bytes
 * and a Latin one costs 1, so treating the backend cap as 249 characters would
 * quietly permit a field nearly three times over the limit — and Amazon's
 * response to an oversized backend field is to index none of it.
 *
 * ## Two things this module is careful about
 *
 * **The site resolves the number.** `budgetFor` takes a marketplace and asks
 * `limitsFor` for that site's caps, rather than reading a constant. A US listing
 * and a JP listing therefore get different budgets from the same call, and the
 * `limitsVerified` flag rides along so nothing can print an unverified number as
 * though it were settled.
 *
 * **`limitSource` says where the number came from.** A budget whose maximum is
 * printed in the hub's rule manual is `documented`; one we chose because it is
 * sensible is a `guideline`. Both are useful, and conflating them is how a
 * recommendation starts being quoted as a rule. The report prints them
 * differently.
 */

import {
  APLUS_FIELDS, BULLET_FIELDS, DRAFT_FIELDS, IMAGE_ALT_FIELDS, QA_FIELDS,
  isAttributeField, orderFields,
} from '../rules/listing-fields.js'
import { GLOBAL_LIMITS, limitsFor } from '../rules/marketplaces.js'
import { labelForAttribute } from '../rules/attributes.js'

/** How an attribute value is budgeted. The PTD carries the real per-field caps. */
const ATTRIBUTE_MAX = 100

/**
 * One spec per field family. `max` / `min` / `target` are **keys into the
 * resolved limit set**, not numbers — that is what lets one spec serve every
 * marketplace without a table of tables.
 */
const BUDGET_SPEC = {
  title: {
    label: '标题',
    unit: 'chars',
    max: 'titleMax',
    min: 'titleMin',
    target: 'titleRecommended',
    anchor: 'titleMobileAnchor',
    limitSource: 'documented',
    note: `前 ${GLOBAL_LIMITS.titleGoldenZone} 字符是黄金锚点（品牌+品类+核心卖点），移动端约在第 ${GLOBAL_LIMITS.titleMobileAnchor} 字符截断`,
  },
  bullet: {
    label: '五点',
    unit: 'chars',
    max: 'bulletMax',
    min: 'bulletRecommendedMin',
    target: 'bulletRecommendedMax',
    limitSource: 'documented',
  },
  description: {
    label: '产品描述',
    unit: 'chars',
    max: 'descriptionMax',
    min: 'descriptionRecommendedMin',
    target: 'descriptionMax',
    limitSource: 'documented',
    note: '上限 2000，尽量用满',
  },
  search_terms: {
    label: '后台搜索词',
    unit: 'bytes',
    max: 'backendMaxBytes',
    min: 0,
    target: 'backendMaxBytes',
    limitSource: 'documented',
    note: '只填前端未覆盖的词；超出可能导致整个字段不被索引',
  },
  item_highlights: {
    label: '产品亮点',
    unit: 'chars',
    max: 'itemHighlightsMax',
    min: 'itemHighlightsRecommendedMin',
    target: 'itemHighlightsMax',
    limitSource: 'documented',
    note: 'Alexa for Shopping 的 AI 购物入口，2026-07-27 起非媒体类目 ≤125 字符',
  },
  brand_story: {
    label: '品牌故事',
    unit: 'chars',
    max: 1000,
    min: 200,
    target: 500,
    limitSource: 'guideline',
    note: 'SOP §2.2 只要求讲清品牌理念/产品匠心/售后承诺三件事，没有给字符数；这里是经验区间',
  },
  aplus: {
    label: 'A+ 模块',
    unit: 'chars',
    max: 1000,
    min: 100,
    target: 400,
    limitSource: 'guideline',
    note: 'A+ 在独立编辑器里排版，字符不是硬约束；这段文案是模块文案草案',
  },
  qa: {
    label: 'Q&A',
    unit: 'chars',
    max: 600,
    min: 40,
    target: 200,
    limitSource: 'guideline',
    note: 'SOP §八 要求回答具体参数化，字符数无硬上限',
  },
  image_alt: {
    label: 'Alt Text',
    unit: 'chars',
    max: 'imageAltMax',
    min: 30,
    target: 'imageAltMax',
    limitSource: 'guideline',
    note: '§6.3 只要求「描述性文字」没给数字；125 是常见无障碍上限',
  },
  video_script: {
    label: '视频脚本要点',
    unit: 'chars',
    max: 1000,
    min: 50,
    target: 400,
    limitSource: 'guideline',
    note: '视频素材本插件不生成，这里只给拍摄脚本要点',
  },
  attribute: {
    label: '属性',
    unit: 'chars',
    max: ATTRIBUTE_MAX,
    min: 0,
    target: ATTRIBUTE_MAX,
    limitSource: 'guideline',
    note: '属性值的真实上限由类目 PTD 决定，这里只拦住明显过长的一段话',
  },
}

/** Which spec family a field belongs to. */
function familyOf(field) {
  if (isAttributeField(field)) return 'attribute'
  if (BULLET_FIELDS.includes(field)) return 'bullet'
  if (APLUS_FIELDS.includes(field)) return 'aplus'
  if (QA_FIELDS.includes(field)) return 'qa'
  if (IMAGE_ALT_FIELDS.includes(field)) return 'image_alt'
  return field
}

/** Resolve a spec's limit keys against a resolved limit set. */
function resolveLimit(spec, key, limits, fallback) {
  if (typeof key === 'number') return key
  if (key === undefined || key === null) return fallback
  const value = limits[key]
  return Number.isFinite(value) ? value : fallback
}

/**
 * The budget for one field, for one marketplace.
 *
 * Returns null for a field the vocabulary does not know, so a caller can tell
 * "no budget" from "zero budget" — the latter is a real thing (`min: 0`).
 */
export function budgetFor(field, options = {}) {
  const family = familyOf(field)
  const spec = BUDGET_SPEC[family]
  if (spec === undefined) return null

  const limits = limitsFor(options.marketplace, { category: options.category, maxTitleChars: options.maxTitleChars })

  /* Two fields carry a per-field override the site profile cannot express. */
  let maxKey = spec.max
  if (family === 'title' && Number.isFinite(options.maxTitleChars)) maxKey = options.maxTitleChars
  if (family === 'item_highlights' && Number.isFinite(options.maxHighlightsChars)) maxKey = options.maxHighlightsChars

  const max = resolveLimit(spec, maxKey, limits, 0)
  const label = isAttributeField(field) ? labelForAttribute(field.slice('attribute.'.length)) : spec.label
  const numbered = /_(\d+)$/.test(field) ? ` ${field.match(/_(\d+)$/)[1]}` : ''

  return {
    field,
    label: isAttributeField(field) || !numbered ? label : `${label}${numbered}`,
    unit: spec.unit,
    max,
    min: resolveLimit(spec, spec.min, limits, 0),
    target: resolveLimit(spec, spec.target, limits, max),
    anchor: spec.anchor === undefined ? null : resolveLimit(spec, spec.anchor, limits, null),
    limitSource: spec.limitSource,
    note: spec.note ?? null,
    marketplace: limits.marketplace,
    limitsVerified: limits.limitsVerified,
  }
}

const measureIn = (unit, text) => (unit === 'bytes' ? Buffer.byteLength(text, 'utf8') : [...text].length)

/** How much of a field's budget a value uses. */
export function measure(field, text, options = {}) {
  const budget = budgetFor(field, options)
  if (budget === null) return null
  const value = String(text ?? '')
  const used = measureIn(budget.unit, value)
  return {
    field,
    label: budget.label,
    unit: budget.unit,
    used,
    max: budget.max,
    min: budget.min,
    target: budget.target,
    anchor: budget.anchor,
    limitSource: budget.limitSource,
    marketplace: budget.marketplace,
    limitsVerified: budget.limitsVerified,
    remaining: budget.max - used,
    over: used > budget.max,
    /** 0–1, clamped, for a progress bar. */
    ratio: budget.max === 0 ? 1 : Math.min(1, used / budget.max),
    under: used < budget.min,
  }
}

/**
 * Trim a value to fit, **without cutting a word in half**.
 *
 * Cutting mid-word is how a title ends up with "Non-Slip Bott" — a defect that
 * reads as a typo rather than as a bug, so nobody reports it. Trimming only at
 * separators means the worst case is a dropped word, which is visible.
 *
 * Returns the original value untouched when it already fits, so callers can
 * always use the result without checking `trimmed` first.
 */
export function trimToBudget(field, text, options = {}) {
  const budget = budgetFor(field, options)
  if (budget === null) return { field, text: String(text ?? ''), trimmed: false, dropped: '', used: 0, max: 0 }
  const value = String(text ?? '')
  const before = measureIn(budget.unit, value)
  if (before <= budget.max) {
    return { field, text: value, trimmed: false, dropped: '', used: before, max: budget.max, unit: budget.unit }
  }

  const parts = value.split(/(\s+)/)
  let kept = ''
  let used = 0
  for (const part of parts) {
    const next = measureIn(budget.unit, kept + part)
    if (next > budget.max) break
    kept += part
    used = next
  }

  /* A single token longer than the whole budget cannot be split at a separator.
     Truncate it by unit and say so, rather than returning an empty field. */
  let hardCut = false
  if (kept.trim() === '') {
    if (budget.unit === 'bytes') {
      let slice = ''
      for (const char of value) {
        if (Buffer.byteLength(slice + char, 'utf8') > budget.max) break
        slice += char
      }
      kept = slice
      used = Buffer.byteLength(slice, 'utf8')
    } else {
      kept = [...value].slice(0, budget.max).join('')
      used = [...kept].length
    }
    hardCut = true
  }

  const trimmed = kept.replace(/\s+$/, '')
  return {
    field,
    text: trimmed,
    trimmed: true,
    hardCut,
    dropped: value.slice(kept.length).trim(),
    used: measureIn(budget.unit, trimmed),
    max: budget.max,
    unit: budget.unit,
  }
}

/**
 * Usage for every field present in a draft, in the vocabulary's canonical order.
 *
 * Order comes from `orderFields`, which follows the hub's `SECTION_ORDER` — so
 * adding a field to the vocabulary puts its budget in the right place in the
 * report without touching this function.
 */
export function measureDraft(fields = {}, options = {}) {
  const rows = []
  for (const field of orderFields(fields)) {
    const value = fields[field]
    if (value === undefined || value === null || value === '') continue
    const row = measure(field, value, options)
    if (row !== null) rows.push(row)
  }
  return rows
}

/**
 * How much of the writable vocabulary this draft actually fills.
 *
 * Counts the static field list plus any attribute fields present. `missing` is
 * the point: a report that shows only what was written cannot tell the reader
 * whether 8 fields or 75 were expected.
 */
export function draftCoverage(fields = {}) {
  const written = orderFields(fields).filter(field => {
    const value = fields[field]
    return value !== undefined && value !== null && String(value).trim() !== ''
  })
  const attributes = written.filter(isAttributeField)
  return {
    written,
    writtenCount: written.length,
    attributeCount: attributes.length,
    staticWrittenCount: written.length - attributes.length,
    staticTotal: DRAFT_FIELDS.length,
  }
}

/**
 * Trim every field of a draft to its budget.
 *
 * Reports what it dropped per field; a caller that silently loses a clause is
 * worse than one that refuses, because the loss is invisible in the result.
 */
export function trimDraft(fields = {}, options = {}) {
  const out = {}
  const changes = []
  for (const [field, value] of Object.entries(fields)) {
    const result = trimToBudget(field, value, options)
    out[field] = result.text
    if (result.trimmed) {
      const budget = budgetFor(field, options)
      changes.push({
        field,
        label: budget?.label ?? field,
        dropped: result.dropped,
        used: result.used,
        max: result.max,
        unit: result.unit,
        hardCut: result.hardCut === true,
      })
    }
  }
  return { fields: out, changes }
}

export { BUDGET_SPEC, ATTRIBUTE_MAX }
