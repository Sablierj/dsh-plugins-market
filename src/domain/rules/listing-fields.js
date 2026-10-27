/**
 * The listing field vocabulary — every field an optimization can write.
 *
 * Source of truth: `amazon-ops-hub/01-system/app/services/listing_field_registry.py`
 * (`SECTION_ORDER` + `CORE_FIELDS`), `01-system/app/schemas/listing_contract.py`
 * (`model_controlled_fields` vs `server_controlled_fields`), and
 * `03-knowledge/reports/Listing字段映射-采集vs上传.md` (which fields must be
 * hand-filled).
 *
 * ## Why this file exists
 *
 * The first version of step 4 wrote eight fields: title, five bullets,
 * description, backend terms. The hub's registry covers eleven sections, and the
 * SOP's 埋词位置 list names eleven *places* — of which those eight fields are
 * four. So a report could be fully compliant with every rule and still leave
 * most of the listing untouched. That is the gap this file closes: it is the
 * single place that says what a field *is*, and everything downstream (budgets,
 * rules, the plan, the report) derives from it instead of re-listing fields.
 *
 * ## The two distinctions that matter
 *
 * **`publishable`** — whether the field can be delivered as copy the operator
 * pastes into Seller Central, or whether it lives in a surface we cannot write
 * to. The hub marks `aplus`, `brand_story`, `qa`, `image.*` and `video.*` as
 * `publishable=False`: A+ has its own editor, brand story has its own console,
 * Q&A is posted by the seller as answers, and images are assets. We still write
 * the copy — it is what the user asked for — but the report must not imply it
 * can be pasted into the same form as the title. That is why `publishable` is a
 * field on every entry rather than a footnote.
 *
 * **`modelControlled`** — the hub's split between fields the model may rewrite
 * and fields the server or a human owns. `attribute.*` and `image.*` and
 * `video.*` are *not* model-controlled in the hub: an attribute value is a fact
 * about the product, so the model may propose it but cannot invent it. We keep
 * the flag so the report can route those to "confirm this value" rather than
 * "accept this copy".
 */

import { ATTRIBUTES } from './attributes.js'

export const FIELDS_VERSION = 'listing-fields.v1'

export const FIELDS_SOURCE =
  'listing_field_registry.py SECTION_ORDER + CORE_FIELDS + listing_contract.py model/server split + Listing字段映射-采集vs上传.md'

/**
 * Sections in the hub's `SECTION_ORDER`. The numbers are the hub's own, and they
 * are what makes report output stable: a new field type slots in by order rather
 * than by wherever it happened to be added to an array.
 */
export const SECTIONS = [
  { id: 'title', label: '标题', order: 10 },
  { id: 'bullets', label: '五点描述', order: 20 },
  { id: 'description', label: '产品描述', order: 30 },
  { id: 'search_terms', label: '后台搜索词', order: 40 },
  { id: 'item_highlights', label: '产品亮点', order: 50 },
  { id: 'attributes', label: '属性字段', order: 60 },
  { id: 'aplus', label: 'A+ 内容', order: 70 },
  { id: 'brand_story', label: '品牌故事', order: 80 },
  { id: 'qa', label: 'Q&A 问答', order: 90 },
  { id: 'images', label: '图片', order: 100 },
  { id: 'video', label: '视频', order: 110 },
]

export const SECTION_BY_ID = Object.fromEntries(SECTIONS.map(section => [section.id, section]))

/** Where the attributes live — the prefix every attribute field carries. */
export const ATTRIBUTE_FIELD_PREFIX = 'attribute.'

/**
 * Wildcard a rule can target to reach every attribute field in a draft.
 *
 * The 43 attributes are dynamic, so a rule cannot enumerate them the way
 * `appliesTo: ['title']` does. The runner expands this prefix against the fields
 * actually present, which keeps the rule written once instead of 43 times.
 */
export const ATTRIBUTE_WILDCARD = 'attribute.*'

/** Bullets, and how many the registry allows. */
export const BULLET_FIELDS = ['bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5']

/** A+ modules. The engine spec names 5; the worked example recommends 6. */
export const APLUS_FIELDS = ['aplus_1', 'aplus_2', 'aplus_3', 'aplus_4', 'aplus_5', 'aplus_6']

/** Q&A pairs. The SOP asks for at least 5, the worked example ships 8. */
export const QA_FIELDS = ['qa_1', 'qa_2', 'qa_3', 'qa_4', 'qa_5', 'qa_6', 'qa_7', 'qa_8']

/** Main image plus six secondary — the worked example's §7.2 副图规划. */
export const IMAGE_ALT_FIELDS = [
  'image_alt_main', 'image_alt_1', 'image_alt_2', 'image_alt_3', 'image_alt_4', 'image_alt_5', 'image_alt_6',
]

/**
 * Every field a draft may carry, in canonical order.
 *
 * `attribute.<id>` fields are deliberately *not* listed here: there are 43 of
 * them and they are dynamic, so they are matched by prefix. Listing them would
 * mean this array goes stale the first time the attribute registry changes.
 */
export const DRAFT_FIELDS = [
  'title',
  ...BULLET_FIELDS,
  'description',
  'search_terms',
  'item_highlights',
  'brand_story',
  ...APLUS_FIELDS,
  ...QA_FIELDS,
  ...IMAGE_ALT_FIELDS,
  'video_script',
]

/**
 * @typedef {object} FieldDefinition
 * @property {string}  label            Chinese display name
 * @property {string}  section          one of SECTIONS ids
 * @property {boolean} publishable      copy can be pasted into Seller Central
 * @property {boolean} modelControlled  the model may rewrite it (vs confirm it)
 * @property {string}  [amazonPath]     the hub's amazon_path, for traceability
 * @property {'text'|'pair'|'list'} [kind]  shape hint for normalisation
 */

/** @type {Record<string, FieldDefinition>} */
export const FIELDS = {
  title: { label: '标题', section: 'title', publishable: true, modelControlled: true, amazonPath: 'item_name' },
  bullet_1: { label: '五点 1', section: 'bullets', publishable: true, modelControlled: true, amazonPath: 'bullet_point1' },
  bullet_2: { label: '五点 2', section: 'bullets', publishable: true, modelControlled: true, amazonPath: 'bullet_point2' },
  bullet_3: { label: '五点 3', section: 'bullets', publishable: true, modelControlled: true, amazonPath: 'bullet_point3' },
  bullet_4: { label: '五点 4', section: 'bullets', publishable: true, modelControlled: true, amazonPath: 'bullet_point4' },
  bullet_5: { label: '五点 5', section: 'bullets', publishable: true, modelControlled: true, amazonPath: 'bullet_point5' },
  description: { label: '产品描述', section: 'description', publishable: true, modelControlled: true, amazonPath: 'product_description' },
  search_terms: { label: '后台搜索词', section: 'search_terms', publishable: true, modelControlled: true, amazonPath: 'generic_keyword' },

  item_highlights: {
    label: '产品亮点',
    section: 'item_highlights',
    publishable: true,
    modelControlled: true,
    amazonPath: 'item_highlights',
    kind: 'list',
  },

  aplus_1: { label: 'A+ 品牌故事模块', section: 'aplus', publishable: false, modelControlled: false, amazonPath: 'aplus_brand_story' },
  aplus_2: { label: 'A+ 核心卖点模块', section: 'aplus', publishable: false, modelControlled: false, amazonPath: 'aplus_selling_points' },
  aplus_3: { label: 'A+ 对比模块', section: 'aplus', publishable: false, modelControlled: false, amazonPath: 'aplus_comparison' },
  aplus_4: { label: 'A+ 场景模块', section: 'aplus', publishable: false, modelControlled: false, amazonPath: 'aplus_lifestyle' },
  aplus_5: { label: 'A+ 参数模块', section: 'aplus', publishable: false, modelControlled: false, amazonPath: 'aplus_specs' },
  aplus_6: { label: 'A+ FAQ 模块', section: 'aplus', publishable: false, modelControlled: false, amazonPath: 'aplus_faq' },

  brand_story: { label: '品牌故事', section: 'brand_story', publishable: false, modelControlled: false, amazonPath: 'brand_story' },

  qa_1: { label: 'Q&A 1', section: 'qa', publishable: false, modelControlled: false, amazonPath: 'customer_questions_and_answers', kind: 'pair' },
  qa_2: { label: 'Q&A 2', section: 'qa', publishable: false, modelControlled: false, amazonPath: 'customer_questions_and_answers', kind: 'pair' },
  qa_3: { label: 'Q&A 3', section: 'qa', publishable: false, modelControlled: false, amazonPath: 'customer_questions_and_answers', kind: 'pair' },
  qa_4: { label: 'Q&A 4', section: 'qa', publishable: false, modelControlled: false, amazonPath: 'customer_questions_and_answers', kind: 'pair' },
  qa_5: { label: 'Q&A 5', section: 'qa', publishable: false, modelControlled: false, amazonPath: 'customer_questions_and_answers', kind: 'pair' },
  qa_6: { label: 'Q&A 6', section: 'qa', publishable: false, modelControlled: false, amazonPath: 'customer_questions_and_answers', kind: 'pair' },
  qa_7: { label: 'Q&A 7', section: 'qa', publishable: false, modelControlled: false, amazonPath: 'customer_questions_and_answers', kind: 'pair' },
  qa_8: { label: 'Q&A 8', section: 'qa', publishable: false, modelControlled: false, amazonPath: 'customer_questions_and_answers', kind: 'pair' },

  image_alt_main: { label: '主图 Alt Text', section: 'images', publishable: false, modelControlled: false, amazonPath: 'image_alt_text' },
  image_alt_1: { label: '副图 1 Alt Text', section: 'images', publishable: false, modelControlled: false, amazonPath: 'image_alt_text' },
  image_alt_2: { label: '副图 2 Alt Text', section: 'images', publishable: false, modelControlled: false, amazonPath: 'image_alt_text' },
  image_alt_3: { label: '副图 3 Alt Text', section: 'images', publishable: false, modelControlled: false, amazonPath: 'image_alt_text' },
  image_alt_4: { label: '副图 4 Alt Text', section: 'images', publishable: false, modelControlled: false, amazonPath: 'image_alt_text' },
  image_alt_5: { label: '副图 5 Alt Text', section: 'images', publishable: false, modelControlled: false, amazonPath: 'image_alt_text' },
  image_alt_6: { label: '副图 6 Alt Text', section: 'images', publishable: false, modelControlled: false, amazonPath: 'image_alt_text' },

  video_script: { label: '视频脚本要点', section: 'video', publishable: false, modelControlled: false, amazonPath: 'video' },
}

/**
 * Fields that must be **hand-filled** and are therefore reported, never written.
 *
 * From `Listing字段映射-采集vs上传.md` §二: these are the upload fields the
 * collection layer cannot supply and no model can infer — a SKU, a quantity, a
 * price, a variation theme. Generating plausible text for them would be
 * fabrication with a confident tone, so they get their own bucket and the report
 * lists them as an operator checklist.
 */
export const MANUAL_FIELDS = [
  { id: 'item_sku', label: 'SKU', why: '上架时人工指定，采集不到' },
  { id: 'item_quantity', label: '库存数量', why: '库存数据在后台，不来自商品页' },
  { id: 'standard_price', label: '标准价格', why: '以后台定价为准，商品页价格可能含促销' },
  { id: 'target_audience', label: '目标人群', why: '类目属性，需按 PTD 选择' },
  { id: 'variation_theme', label: '变体主题', why: '父子变体关系，改错影响整组链接' },
  { id: 'product_category', label: '产品类目', why: '类目路径决定属性集与标题上限' },
  { id: 'recommended_browse_nodes', label: '浏览节点', why: '决定曝光节点，需按后台类目树选' },
]

/** Writable fields, in canonical order — the static half of a draft. */
export function isAttributeField(field) {
  return String(field ?? '').startsWith(ATTRIBUTE_FIELD_PREFIX)
}

/** Section id for any field, attributes included. */
export function sectionOf(field) {
  if (isAttributeField(field)) return 'attributes'
  return FIELDS[field]?.section ?? null
}

/** Sort rank for a field, from its section's hub order. */
export function fieldRank(field) {
  const section = sectionOf(field)
  if (section === null) return Number.MAX_SAFE_INTEGER
  const order = SECTION_BY_ID[section]?.order ?? Number.MAX_SAFE_INTEGER
  /* Inside a section, numbered fields keep their number. */
  const number = Number(String(field).match(/_(\d+)$/)?.[1] ?? 0)
  return order * 100 + number
}

/** Every field id present in a draft, in canonical order. */
export function orderFields(fields = {}) {
  return Object.keys(fields).sort((a, b) => {
    const byRank = fieldRank(a) - fieldRank(b)
    return byRank !== 0 ? byRank : a.localeCompare(b)
  })
}

/**
 * True when the field can be delivered as pasteable copy.
 *
 * Attributes are `true` even though they are not in `FIELDS`: they are typed
 * into the *same* Seller Central listing editor as the title and bullets, just
 * on the "More Details" tab. Reporting them as needing a separate editor would
 * send the user looking for a screen that does not exist — the four surfaces
 * that genuinely are separate are A+, 品牌故事, Q&A and 图片, and each of those
 * has its own `FIELDS` entry saying so.
 *
 * The distinction that *does* apply to attributes is `needsConfirmation`: they
 * are facts, so a human has to vouch for the value even though the paste is easy.
 */
export function isPublishable(field) {
  if (isAttributeField(field)) return true
  return FIELDS[field]?.publishable === true
}

/**
 * Display name for any field, attributes included.
 *
 * Lives here rather than in the report because three callers need it (the
 * report, the tools, the page) and three copies of a label map is how a field
 * ends up named differently in two places the user is comparing.
 *
 * `attributes.js` imports nothing, so importing it here cannot make a cycle.
 */
export function labelForField(field) {
  if (field === 'bullets') return '五点（整组）'
  if (field === 'draft') return '整份草稿'
  if (isAttributeField(field)) {
    const id = field.slice(ATTRIBUTE_FIELD_PREFIX.length)
    return `属性 · ${ATTRIBUTES[id]?.label ?? id}`
  }
  return FIELDS[field]?.label ?? field
}

/** Section display names, keyed by section id. */
export const SECTION_LABELS = Object.fromEntries(SECTIONS.map(section => [section.id, section.label]))

/** Fields whose value is a fact to confirm rather than copy to accept. */
export function needsConfirmation(field) {
  if (isAttributeField(field)) return true
  return FIELDS[field]?.modelControlled === false
}

/* ── write-back: what the listing table can actually store ──────────────────
 *
 * `publishable` says a field can be delivered as pasteable copy; the listing
 * table can store exactly those fields (title / bullets / description /
 * search_terms / item_highlights / attributes). Everything else a draft carries
 * (A+ / 品牌故事 / Q&A / Alt Text / 视频脚本) is drafted and validated but has
 * no write path.
 *
 * This split used to live in `src/tools/optimize.js` as a hand-written field
 * list, which made it a second source of truth for a fact the registry already
 * knew. It is here now so the tool's stdout and the report body are computed
 * from the same place — a hand-typed "52 / 23" would drift the moment a field
 * was added, and it is precisely the kind of second source the report fixes
 * removed elsewhere.
 */

/** Short, reader-facing labels for the write-back disclosure, one per section. */
export const SECTION_SHORT_LABELS = {
  title: '标题',
  bullets: '五点',
  description: '描述',
  search_terms: '后台词',
  item_highlights: '产品亮点',
  attributes: '属性',
  aplus: 'A+',
  brand_story: '品牌故事',
  qa: 'Q&A',
  images: 'Alt Text',
  video: '视频脚本',
}

/** A section's short label, falling back to the full label then the raw id. */
export function sectionShortLabel(section) {
  return SECTION_SHORT_LABELS[section] ?? SECTION_LABELS[section] ?? section
}

/**
 * The distinct sections a field list touches, in **registry order**, short-labelled.
 *
 * Sorted by the section's hub `order`, never by the order the fields arrive in.
 * The comment said "registry order" while the code preserved input order, which
 * is how the same 23 draft-only group names came out in one order in the save
 * tool's stdout (fields in the order the operator accepted them) and a different
 * order in the report body (fields sorted by `fieldRank`). One list, one order:
 * this function decides it, so both callers cannot disagree.
 */
export function groupLabels(fields = []) {
  const sections = new Set()
  for (const field of fields) {
    const section = sectionOf(field)
    if (section !== null) sections.add(section)
  }
  return [...sections]
    .sort((a, b) => (SECTION_BY_ID[a]?.order ?? Number.MAX_SAFE_INTEGER) - (SECTION_BY_ID[b]?.order ?? Number.MAX_SAFE_INTEGER))
    .map(sectionShortLabel)
}

/**
 * True when `upsertListing` will actually store this field.
 *
 * The listing table owns exactly the publishable fields, so this is derived
 * rather than enumerated — see the block comment above.
 */
export function isListingWritable(field) {
  return isPublishable(field)
}

/**
 * Split a set of fields into what can be written back and what is drafted only.
 *
 * The counts and the group labels are both derived from the registry, so a
 * caller can state "N 可写回（…）/ M 只出草案（…）" without typing any of the
 * numbers or names. `groups` is the reader-facing string ("标题 / 五点 / …").
 *
 * @param {string[]} fields
 * @returns {{
 *   total: number,
 *   writable: { count: number, fields: string[], groups: string },
 *   draftOnly: { count: number, fields: string[], groups: string },
 * }}
 */
export function writebackSplit(fields = []) {
  const writable = []
  const draftOnly = []
  for (const field of fields) {
    if (isListingWritable(field)) writable.push(field)
    else draftOnly.push(field)
  }
  return {
    total: fields.length,
    writable: { count: writable.length, fields: writable, groups: groupLabels(writable).join(' / ') },
    draftOnly: { count: draftOnly.length, fields: draftOnly, groups: groupLabels(draftOnly).join(' / ') },
  }
}
