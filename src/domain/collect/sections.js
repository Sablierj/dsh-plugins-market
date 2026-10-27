/**
 * The thirteen collection sections (module 04 F04-07, contract §4.1).
 *
 * ## Why this file exists at all
 *
 * The section column (`collection_section_result.section`) was validated for
 * **shape** when the storage layer landed (`store/collection-section.js` accepts
 * any lower-case id), deliberately, because the thirteen legal ids were owned by
 * the sub-batch that writes them. This is that sub-batch: the vocabulary arrives
 * here, in one place, and the shape check stays where it is — a shape check is
 * not a vocabulary and cannot substitute for one.
 *
 * ## Two things this list is NOT
 *
 *   · **Not `listing-fields.js`'s `SECTIONS`.** That is the optimizer's *field*
 *     vocabulary (11 entries, `title` / `bullets` / `qa` / …), it is pinned by an
 *     `eleven sections` assertion, and reusing it here would silently redefine
 *     what a collection section is. The two lists answer different questions:
 *     "which fields does an optimizer draft have" versus "which parts of a
 *     product page do we go and read". They must be free to diverge — and they
 *     already do (this list has no `qa`, that one has no `bsr`).
 *   · **Not the prototype's thirteen badges.** `prototype/04-collect.html` draws
 *     标题/五点/描述/价格/图片/A+/属性/变体/BSR/评分/后台词/QA/评论, which splits
 *     `basic` into three and invents `后台词`/`QA` as sections. The adjudication
 *     (`G2-B04-adjudication.md` §1) chose the document's thirteen; the prototype's
 *     labels are a *rendering* of them, not the taxonomy.
 *
 * ## A+ and video are two sections on purpose
 *
 * They are separate here because they fail separately: A+ comes through a module
 * interface, video is a media asset. Merging them would let "video was not
 * collected" hide behind "A+ was", which is precisely the §18.3 rule that a task
 * ending successfully must not be allowed to mask a locally missing part.
 *
 * ## `field` lists are the *raw/parsed* keys, not the adapter's field names
 *
 * `basic.fields` lists the keys a section's `parsed_value_json` holds. They are
 * unrelated to `registry.js`'s `KNOWN_FIELDS` (`title` / `price` / …), which are
 * what the *collector* can fill today. The mapping from "page region" to
 * "section key" is the collector's business (P5); this file only says which keys
 * belong to which section so a count of "how much of this section did we get"
 * has one definition.
 */

import { ATTRIBUTE_FIELD_PREFIX } from '../rules/listing-fields.js'

/**
 * The thirteen, in the order contract §4.1 numbers them (1–13).
 *
 * `order` is 1-based and is what the page prints; it is not an array index so
 * that a reader comparing the page to the contract does not have to add one.
 */
export const COLLECTION_SECTIONS = [
  {
    id: 'basic',
    label: '基础信息',
    order: 1,
    fields: [
      'asin', 'url', 'title', 'brand', 'price', 'currency', 'availability',
      'rating', 'reviews_count', 'selected_color', 'selected_size',
    ],
  },
  {
    id: 'bullets',
    label: '五点',
    order: 2,
    fields: ['bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5'],
  },
  { id: 'images', label: '主图与副图', order: 3, fields: ['main_image', 'image_count', 'images'] },
  { id: 'variations', label: '变体结构', order: 4, fields: ['parent_asin', 'variation_dimensions', 'children'] },
  {
    id: 'attributes',
    label: '产品规格与属性',
    order: 5,
    /* Dynamic: the attribute keys are whatever the page carries, so the section
       declares the **prefix** rather than a list. `attribute.*` is the same
       wildcard `listing-fields.js` uses, imported rather than retyped so the two
       cannot drift into two different prefixes. */
    fields: [],
    dynamicPrefix: ATTRIBUTE_FIELD_PREFIX,
  },
  { id: 'description', label: '产品描述', order: 6, fields: ['description', 'item_highlights'] },
  { id: 'aplus', label: 'A+ 模块及文案/图片链接', order: 7, fields: ['modules'] },
  { id: 'video', label: '视频', order: 8, fields: ['videos'] },
  {
    id: 'seo_meta',
    label: 'SEO 元信息',
    order: 9,
    fields: ['page_title', 'meta_description', 'canonical_url', 'search_terms'],
  },
  { id: 'bsr', label: 'BSR、类目与子类排名', order: 10, fields: ['bsr', 'category', 'subcategory_ranks'] },
  {
    id: 'reviews',
    label: '评论',
    order: 11,
    fields: ['reviews_total', 'reviews_visible', 'review_summary', 'review_items'],
  },
  {
    id: 'page_signals',
    label: '徽章、库存/退货风险等页面信号',
    order: 12,
    fields: ['badges', 'availability', 'return_policy', 'risk_signals'],
  },
  {
    id: 'related_competitors',
    label: '页面发现的关联竞品',
    order: 13,
    /* `groups` 说明这些 ASIN 从哪来、有没有验证过。2026-10-21 之前只声明了
       related_asins，于是"这批候选是否可能含广告位"没有地方记 —— 而页面上确实有一组
       是 sponsored（Similar brands on Amazon），把它当竞品会让后续对比全偏。 */
    fields: ['related_asins', 'groups'],
  },
]

/** The thirteen ids, in contract order. The single source for "is this legal". */
export const COLLECTION_SECTION_IDS = COLLECTION_SECTIONS.map(section => section.id)

/** id → section, for the label/order lookups the tools and the page need. */
export const SECTION_BY_ID = Object.fromEntries(COLLECTION_SECTIONS.map(section => [section.id, section]))

/**
 * The sections this version believes need a logged-in session.
 *
 * Contract §9-O3: the requirement document asks the preview to report "needs
 * login for N sections" but never says **which** sections, and the adjudication
 * (§2) refused to invent a section-level login map. So this is the conservative
 * assumption the contract itself names — `aplus` and `reviews` — kept as one
 * named constant with the note attached, so the reader sees a declared
 * assumption rather than a fact dressed up as one. Ops revisits it.
 */
export const LOGIN_REQUIRED_SECTIONS = ['aplus', 'reviews']

/** Is `id` one of the thirteen? */
export function isCollectionSection(id) {
  return Object.prototype.hasOwnProperty.call(SECTION_BY_ID, String(id ?? '').trim())
}

/** The Chinese label, or the id itself when it is not one of the thirteen. */
export function sectionLabel(id) {
  return SECTION_BY_ID[String(id ?? '').trim()]?.label ?? String(id ?? '')
}

/**
 * Split a caller's section list into known and unknown ids.
 *
 * Duplicates are collapsed: naming `basic` twice is a slip, not a request to
 * collect it twice, and the detail builder writes one row per coordinate.
 */
export function normalizeSectionIds(values) {
  if (!Array.isArray(values) || values.length === 0) return { sections: [], unknown: [] }
  const unknown = []
  const sections = []
  for (const value of values) {
    const id = String(value ?? '').trim()
    if (id === '') continue
    if (!isCollectionSection(id)) {
      if (!unknown.includes(id)) unknown.push(id)
      continue
    }
    if (!sections.includes(id)) sections.push(id)
  }
  return { sections, unknown }
}

/** How many of the thirteen a scheme's list covers, for `loginRequiredSections`. */
export function loginRequiredSectionCount(sections) {
  const list = Array.isArray(sections) && sections.length > 0 ? sections : COLLECTION_SECTION_IDS
  return list.filter(id => LOGIN_REQUIRED_SECTIONS.includes(id)).length
}

/**
 * Does this value count as "collected"?
 *
 * The judgement is on **content**, never on "was the key present". `{title: ''}`
 * and `{}` are the same fact about a page — we did not get a title — and a
 * `hasOwnProperty` test would call the first one collected. This is the same
 * trap as reading an empty object as a positive answer; it is checked here once
 * rather than at every count site.
 */
function hasValue(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/**
 * How much of one section a `parsed_value_json` actually carries.
 *
 * Returns `{collected, total, missing}` where `total` is the number of fields
 * this section *could* have reported in this reading:
 *
 *   · a static section — its declared field list;
 *   · `attributes` — the `attribute.*` keys the reading contains, because the
 *     attribute set is a property of the product, not of the section.
 *
 * `total === 0` for `attributes` means "no attribute keys at all", which is a
 * `missing` section (the page carried none), not a complete one. Treating
 * `0 / 0` as complete is how a section that was never parsed reads as perfect.
 */
export function sectionValueCounts(sectionId, value) {
  const section = SECTION_BY_ID[String(sectionId ?? '').trim()]
  if (section === undefined) return null
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}

  if (section.dynamicPrefix !== undefined) {
    const keys = Object.keys(record).filter(key => key.startsWith(section.dynamicPrefix))
    const missing = keys.filter(key => !hasValue(record[key]))
    return { collected: keys.length - missing.length, total: keys.length, missing }
  }

  const missing = section.fields.filter(field => !hasValue(record[field]))
  return { collected: section.fields.length - missing.length, total: section.fields.length, missing }
}

/**
 * reviews 的**内容级**判据（T69 / 铁律 3）——字段覆盖表达不了的那条规则。
 *
 * 五态里 reviews 的 partial/collected 由 n/N 决定，不是「四个格子读到几个」：
 *   · seen < total → partial（未登录可见范围受限：含 **0/N**、含登录墙截断 ——
 *     v1.3 消歧：登录墙不记 blocked，blocked 只留给风控页/验证码真被拦）；
 *   · seen === total（两数都测到）→ collected（含 0/0：页面明示无评论，如实记 0 条）。
 *   · 两数任一没测到 → decided:false，回落字段覆盖派生（不猜）。
 *
 * seen = reviews_visible（页面上识别出的评论块数）；total = reviews_total（页面显示
 * 共几条）。review_items 是**样本**（有 50 条上限），不能当 seen 用 —— 上限截断时
 * items.length < seen，拿 items 当 seen 会把「样本截断」误判成「可见受限」。
 * 从存货行可完全复算（audit 用同一函数），与 `sectionContentUnread` 同一形状。
 */
export function reviewsVisibleVerdict(parsedValue) {
  const record = parsedValue !== null && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
    ? parsedValue
    : null
  if (record === null) return { decided: false, short: false, seen: null, total: null, reason: null }
  const hasShape = Object.prototype.hasOwnProperty.call(record, 'reviews_total')
    || Object.prototype.hasOwnProperty.call(record, 'review_items')
    || Object.prototype.hasOwnProperty.call(record, 'reviews_visible')
  if (!hasShape) return { decided: false, short: false, seen: null, total: null, reason: null }
  const total = Number.isFinite(record.reviews_total) ? record.reviews_total : null
  const seen = Number.isFinite(record.reviews_visible)
    ? record.reviews_visible
    : (Array.isArray(record.review_items) ? record.review_items.length : null)
  if (total === null || seen === null) {
    return { decided: false, short: false, seen, total, reason: null }
  }
  if (seen < total) {
    return {
      decided: true,
      short: true,
      state: 'partial',
      seen,
      total,
      reason: `采到 ${seen} 条/页面显示 ${total} 条（未登录可见范围受限，含 0/N 与登录墙截断）`,
    }
  }
  return { decided: true, short: false, state: 'collected', seen, total, reason: null }
}

/**
 * The three data-derived section states, from a reading.
 *
 * Deliberately **not** the whole five-state vocabulary: `failed` ("we could not
 * tell" — selector missed, page never rendered, timeout) and `blocked` (stopped
 * by a bot check or a login wall) are verdicts about *how the attempt went*, and
 * no amount of staring at a parsed value can produce them. A function that
 * guessed them would be inventing the one distinction (`missing` vs `failed`)
 * this vocabulary exists to keep.
 */
export function sectionStatusFromValue(sectionId, value) {
  const counts = sectionValueCounts(sectionId, value)
  if (counts === null) return null
  /* T69（铁律 3）：reviews 的 n/N 内容级判据**先于**字段覆盖 —— 0/N 是 partial
     含 0 条（不是 missing），0/0 是 collected（页面明示无评论，如实 0 条），
     字段覆盖判不了这两件事（见 reviewsVisibleVerdict 注）。 */
  const reviews = reviewsVisibleVerdict(value)
  if (reviews.decided) return reviews.state
  if (counts.total === 0) return 'missing'
  if (counts.collected === 0) return 'missing'
  if (counts.collected < counts.total) return 'partial'
  return 'collected'
}

/**
 * What a reader prints for a row whose **content** says "we saw it and could
 * not read it", as opposed to a row whose field counts say "the page has part
 * of it". Measured live on 2026-10-10: one `variations` row read
 * `{"variation_dimensions":["color_name"],"children":[],"child_tiles":12}` —
 * the dimension row was read and all 12 ASIN-bearing tiles went unparsed —
 * while a healthy sibling read `"children":[11 个]` with the same
 * `child_tiles: 12`. Both print `partial` (`1/3` and `2/3`), and in the same
 * table those two are indistinguishable, even though one says "Amazon's page
 * is missing a parent ASIN" and the other says "our child selector is stale".
 *
 * The two are told apart by signals **already in the stored row** — never by a
 * new flag a reader invents: `errors_json` carries `VARIATION_CHILDREN_UNREAD`
 * and the payload carries `child_tiles > 0` next to `children: []` (both are
 * what `variationsChildrenUnread` in `domain/collect/section-reading.js` decides
 * from, so the row and its marker can never disagree). The five states stay
 * untouched — `partial` still means "part of it was collected"; this label only
 * marks the row's content so the two `partial` rows stop looking alike.
 *
 * ## Why the label and the rule live in *this* file
 *
 * They used to live in `domain/asin/sections.js`, next to
 * `SECTION_READ_TRUNCATED_LABEL` — and that is exactly how the marker ended up
 * with **two implementations**. The ASIN-detail payload (`buildSectionView`)
 * carried the computed boolean, but the collection panel's payload
 * (`domain/collect/detail.js`, B-04) did not, so the page recomputed the rule
 * inline from `errors` / `child_tiles` for that one call site. Both spellings
 * agreed until one of them changed; the page then fell back to its own copy and
 * **nothing failed** (measured: breaking `sectionContentUnread` turned the tool
 * assertion red and left the page assertion green).
 *
 * So the rule now lives in the one module **both** readers already import —
 * `sectionValueCounts` above is the same kind of thing: a pure function that
 * reads a stored row. The dependency direction is unchanged (the ASIN view
 * imports from here, never the other way round), and
 * `domain/asin/sections.js` re-exports these two bindings rather than
 * re-declaring them.
 */
export const SECTION_CONTENT_UNREAD_LABEL = '没读到（不是页面没有）'

/**
 * Does this view entry carry the "saw it, read none" signal? Recomputed from
 * the row's own errors / parsed value — the same inputs `sectionRecordStatus`
 * decided from — so a row the writer marked is a row the reader marks, and a
 * row whose payload says the opposite (`children: [...]`, or `child_tiles: 0`)
 * is never marked. No new signal is created here.
 *
 * "Not measured" is not a measurement: a payload without `child_tiles` (a row
 * written before the probe existed, a non-Amazon source) is **not** read as `0`,
 * so it stays unmarked instead of being called "we saw none".
 *
 * `entry` is the shape both builders hand to a reader: `{notCollected, errors,
 * parsedValue}`. A section that was never attempted is never marked — that is
 * "we never looked", not "we looked and could not read it".
 */
export function sectionContentUnread(entry) {
  if (entry === null || typeof entry !== 'object') return false
  if (entry.notCollected === true) return false
  const errors = Array.isArray(entry.errors) ? entry.errors : []
  if (errors.some(error => error?.code === 'VARIATION_CHILDREN_UNREAD')) return true
  const parsed = entry.parsedValue
  return Array.isArray(parsed?.children) && parsed.children.length === 0
    && Number.isFinite(parsed?.child_tiles) && parsed.child_tiles > 0
}
