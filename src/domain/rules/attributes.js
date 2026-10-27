/**
 * The attribute registry — the COSMO knowledge-graph nodes.
 *
 * Source of truth: `amazon-ops-hub/01-system/app/services/listing_field_registry.py`
 * (`ATTRIBUTE_DISPLAY_NAMES`, 52 entries) plus
 * `04-agents/shared/rules/amazon-listing-comprehensive-rules-2026.md` §7.1–7.2 and
 * `04-agents/shared/rules/SOP-optimization-v2.1.md` §七.
 *
 * Why this is a file of its own rather than a corner of `listing-rules.js`: the
 * SOP records a 2026 weight change — **attribute fields now outweigh the backend
 * search terms** (§七: 「属性字段权重已超过后台搜索词」) — and the rules doc says an
 * empty attribute is not a missing value but a *disconnected node* (§7.2:
 * 「每个空白字段 = 知识图谱中的一个断连」). That makes attributes a coverage
 * problem, not a copy problem, and coverage is counted in filled fields rather
 * than in characters.
 *
 * The second rule here is specificity, and it is the one that is easy to satisfy
 * on paper and fail in practice: 「Metal」 fills a field and connects nothing,
 * 「304 Stainless Steel」 connects. So each entry carries the doc's own
 * too-generic / specific examples where it has them.
 *
 * One honest caveat. SOP §七 states the requirement as 「43 个必填」 but does not
 * publish *which* 43, and the hub registry is a flat name map — the per-category
 * required set actually comes from the Product Type Definition, which we do not
 * have. So this file ships the full 52-entry candidate pool, marks 43 of them
 * `required`, and lets `REQUIRED_ATTRIBUTE_TARGET` carry the SOP's count. The 9
 * left out are exactly the near-duplicates of required entries (`brand_name` vs
 * `brand`, `special_features` vs `special_feature`, `product_weight` vs
 * `item_weight`, `indoor_outdoor` vs `indoor_outdoor_usage`) plus the vaguest
 * ones. Inventing a different specific 43 would look more precise and be less
 * true.
 */

import { lexiconFor } from './lexicon.js'

export const ATTRIBUTES_VERSION = 'attributes.v1'

export const ATTRIBUTES_SOURCE =
  'listing_field_registry.py ATTRIBUTE_DISPLAY_NAMES (52) + amazon-listing-comprehensive-rules-2026.md §7.1–7.2 + SOP §七'

/** The SOP's stated count. The completeness gate measures against this. */
export const REQUIRED_ATTRIBUTE_TARGET = 43

/**
 * @typedef {object} AttributeDefinition
 * @property {string}  label      Chinese display name, from the hub registry
 * @property {boolean} required   one of the 43
 * @property {boolean} [specific] §7.2 applies: a generic value connects nothing
 * @property {string}  [note]     what a good value looks like
 */

/** @type {Record<string, AttributeDefinition>} */
export const ATTRIBUTES = {
  /* ── identity & classification ─────────────────────────────────────────── */
  item_type: { label: '商品类型', required: true, note: '更精准的类目，如 PILLOW → Furniture Cushion' },
  subject_matter: { label: '主题', required: true, specific: true, note: '具体主题而非泛词' },
  brand: { label: '品牌', required: true },
  manufacturer: { label: '制造商', required: true },
  country_of_origin: { label: '原产国', required: true },

  /* ── what it is for (COSMO intent nodes) ───────────────────────────────── */
  intended_use: { label: '预期用途', required: true, specific: true },
  specific_uses: { label: '具体用途', required: true, specific: true },
  recommended_uses: { label: '推荐用途', required: true, specific: true, note: '场景穷举，用逗号分隔多个' },
  target_audience: { label: '目标人群', required: true },

  /* ── materials (the highest-value specificity fields) ──────────────────── */
  material: { label: '材质', required: true, specific: true },
  material_composition: { label: '材质成分', required: true, specific: true },
  fill_material: { label: '填充材质', required: true, specific: true },
  cover_material: { label: '面料材质', required: true, specific: true },
  outer_material: { label: '外层材质', required: true, specific: true },
  inner_material: { label: '内层材质', required: true, specific: true },

  /* ── physical ──────────────────────────────────────────────────────────── */
  color: { label: '颜色', required: true },
  size: { label: '尺寸', required: true },
  product_dimensions: { label: '产品尺寸', required: true },
  item_weight: { label: '商品重量', required: true },
  item_thickness: { label: '厚度', required: true },
  shape: { label: '形状', required: true },
  pattern: { label: '图案', required: true },
  style: { label: '风格', required: true },
  item_firmness: { label: '软硬度', required: true },
  number_of_pieces: { label: '件数', required: true },
  number_of_items: { label: '商品数量', required: true },

  /* ── use & environment ─────────────────────────────────────────────────── */
  indoor_outdoor_usage: { label: '使用场景', required: true, specific: true },
  room_type: { label: '适用房间', required: true },
  seasons: { label: '适用季节', required: true },
  occasion: { label: '适用场合', required: true },
  surface_recommendation: { label: '适用表面', required: true },
  assembly_required: { label: '是否需要组装', required: true },
  installation_type: { label: '安装方式', required: true },
  age_range: { label: '适用年龄', required: true },
  reversible: { label: '是否双面可用', required: true },
  cushion_type: { label: '坐垫类型', required: true },

  /* ── claims & care ─────────────────────────────────────────────────────── */
  care_instructions: { label: '保养说明', required: true },
  fabric_care: { label: '面料护理', required: true },
  product_benefits: { label: '产品益处', required: true },
  special_feature: { label: '特殊功能', required: true },
  water_resistance_level: { label: '防水等级', required: true },
  weather_resistant: { label: '耐候性', required: true },
  warranty_description: { label: '保修说明', required: true },

  /* ── not one of the 43: near-duplicates and the vaguest ────────────────── */
  brand_name: { label: '品牌名称', required: false, note: '与 brand 重复' },
  brand_color_name: { label: '品牌颜色名称', required: false, note: '与 color 重复' },
  indoor_outdoor: { label: '室内外用途', required: false, note: '与 indoor_outdoor_usage 重复' },
  product_weight: { label: '产品重量', required: false, note: '与 item_weight 重复' },
  special_features: { label: '特殊功能', required: false, note: '与 special_feature 重复' },
  target_audience_detail: { label: '目标人群详情', required: false, note: '与 target_audience 重复' },
  item_package_quantity: { label: '包装数量', required: false, note: '与 number_of_items 重复' },
  unit_count: { label: '单位数量', required: false },
  seat_cushion_style: { label: '坐垫样式', required: false, note: '与 cushion_type / style 重复' },
}

/** The 43, in registry order. */
export const REQUIRED_ATTRIBUTES = Object.entries(ATTRIBUTES)
  .filter(([, definition]) => definition.required)
  .map(([id]) => id)

/** Fields where §7.2 applies — a generic value is worse than an empty one. */
export const SPECIFICITY_ATTRIBUTES = Object.entries(ATTRIBUTES)
  .filter(([, definition]) => definition.specific === true)
  .map(([id]) => id)

/** Attribute ids a value can be written for — `attribute.<id>`. */
export const ATTRIBUTE_FIELD_PREFIX = 'attribute.'

/** `attribute.material` → `material`. Returns null for anything else. */
export function attributeIdOf(field) {
  const name = String(field ?? '')
  return name.startsWith(ATTRIBUTE_FIELD_PREFIX) ? name.slice(ATTRIBUTE_FIELD_PREFIX.length) : null
}

export function attributeField(id) {
  return `${ATTRIBUTE_FIELD_PREFIX}${id}`
}

export function labelForAttribute(id) {
  return ATTRIBUTES[id]?.label ?? id
}

/**
 * How complete the attribute set is.
 *
 * Counts only fields whose value is non-empty **and** not a placeholder, because
 * `N/A` in an attribute field is the same disconnected node as a blank one —
 * and it is worse, since it looks filled to every count that only checks for
 * presence.
 */
export function attributeCoverage(fields = {}) {
  const filled = []
  const empty = []
  const placeholder = []
  for (const id of REQUIRED_ATTRIBUTES) {
    const value = fields[attributeField(id)]
    const text = value === undefined || value === null ? '' : String(value).trim()
    if (text === '') { empty.push(id); continue }
    if (isPlaceholderValue(text)) { placeholder.push(id); continue }
    filled.push(id)
  }
  const target = REQUIRED_ATTRIBUTE_TARGET
  return {
    filled,
    empty,
    placeholder,
    filledCount: filled.length,
    target,
    /** A placeholder counts as unfilled: it is a disconnected node that looks connected. */
    effectiveCount: filled.length,
    missingCount: target - filled.length,
    ratio: target === 0 ? 1 : Math.min(1, filled.length / target),
    complete: filled.length >= target,
  }
}

const PLACEHOLDER_VALUES = new Set(['n/a', 'na', 'none', 'null', 'tbd', 'tba', '-', '--', '待定', '无', '未知'])

export function isPlaceholderValue(text) {
  return PLACEHOLDER_VALUES.has(String(text ?? '').trim().toLowerCase())
}

/** The generic → specific examples for a site (English when the site is unknown). */
export function specificityExamplesFor(marketplace = null) {
  return lexiconFor(marketplace).specificityExamples
}

/**
 * Is this value too generic to connect a knowledge-graph node, for this site?
 *
 * `marketplace` selects the lexicon. Omitting it uses the fallback (English)
 * set — the honest default, because a caller that cannot name the site also
 * cannot claim its generic-word list is the right one.
 */
export function isGenericValue(id, value, marketplace = null) {
  if (!SPECIFICITY_ATTRIBUTES.includes(id)) return false
  return lexiconFor(marketplace).genericValues.has(String(value ?? '').trim().toLowerCase())
}
