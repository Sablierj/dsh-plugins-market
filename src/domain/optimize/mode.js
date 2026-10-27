/**
 * F13-04 — the four optimization modes, as one declaration the tools and the
 * page both read.
 *
 * §4 of the module design names four modes and each one changes a *different*
 * thing, which is why they cannot be a single boolean:
 *
 *   全量 full         覆盖全部可优化字段。First build, or a listing that is
 *                     missing most of its sections.
 *   增量 incremental  存量单轮 ≤30%，优先阻断 / 事实错误 / 高价值缺口。The
 *                     mode is defined by a *cap* plus an *order*, not by a field
 *                     list: it works on the whole listing and promises to touch
 *                     very little of it.
 *   专项 targeted     八个专项之一（标题 / 五点 / 后台词 / 属性 / A+ / 评论痛点 /
 *                     SEO·GEO / 本地化）。The mode is defined by a *scope*.
 *   审核 audit        只检查不生成。No field list at all, and `generates:false`
 *                     is the load-bearing part of the declaration.
 *
 * ## Why the mode is data and not a chain of `if`s in the tool
 *
 * The three things a mode has to control — which fields may be written, whether
 * a draft is legal at all, and how large a single round may be — are asked in
 * three different places (prepare builds the package, validate decides what may
 * be persisted, save decides what may be accepted). If each place carried its
 * own `if (mode === 'audit')`, the three answers would drift and a field the
 * package never offered could still be persisted. So the mode is resolved once
 * here into a spec object, and every caller reads that spec.
 *
 * ## `audit` generates nothing — and that has to be checkable
 *
 * "只检查不生成" is easy to claim and easy to break: the drafting instruction in
 * the package is a block of text, and a `mode` value that only changes a label
 * would still hand the agent a template to fill. So `generates` is explicit,
 * `fields` is empty for audit, and `tool.js` refuses to persist *any* draft on
 * an audit run. The falsifiable form of the claim is: an audit run's package
 * carries no drafting template, and a draft submitted against it is refused.
 */

import { REQUIRED_ATTRIBUTES, REQUIRED_ATTRIBUTE_TARGET, attributeField } from '../rules/attributes.js'
import {
  APLUS_FIELDS, BULLET_FIELDS, DRAFT_FIELDS, IMAGE_ALT_FIELDS, QA_FIELDS,
} from '../rules/listing-fields.js'

/** The four modes. A closed set, so a caller cannot invent a fifth. */
export const OPTIMIZE_MODES = ['full', 'incremental', 'targeted', 'audit']

/** One-word labels, so the tool, the page and the report say them identically. */
export const OPTIMIZE_MODE_LABELS = {
  full: '全量',
  incremental: '增量',
  targeted: '专项',
  audit: '审核（只检查不生成）',
}

/**
 * The cap an incremental round has to respect, and where it comes from.
 *
 * §4.2 states the number and the reason: "存量 Listing 单轮修改幅度原则上 ≤30%，
 * 优先解决阻断、事实错误和高价值缺口；不为了'看起来不一样'重写稳定内容". The ratio
 * lives here as a value so a report can print the cap it applied instead of a
 * reader having to trust that 30% was used.
 */
export const INCREMENTAL_CHANGE_RATIO = 0.3

/** The priority ladder, best-first. §4.2's own ordering, not the field order. */
export const INCREMENTAL_PRIORITIES = ['blocking', 'fact-error', 'high-value-gap', 'stable']

export const INCREMENTAL_PRIORITY_LABELS = {
  blocking: '阻断',
  'fact-error': '事实错误',
  'high-value-gap': '高价值缺口',
  stable: '稳定内容',
}

export const INCREMENTAL_PRIORITY_WHY = {
  blocking: '当前文案有一条 block 级机检违规：会被拒收或降权，改它最急。',
  'fact-error': '数据质量问题把 validity / consistency 指到了这条字段上：文案与已确认事实不一致。',
  'high-value-gap': '已经在排名、文案里却没有的高价值词（T1/T2）落在这条字段上，是白拿的相关性。',
  stable: '没有以上任一理由。默认不动 —— 不为了「看起来不一样」重写稳定的内容。',
}

/**
 * One sentence per mode, kept here rather than typed at each presentation site.
 *
 * The page, the prepare package and the report all need to say what a mode means;
 * three copies of the same sentence drift the first time one of them is reworded,
 * and then the page and the tool are describing different modes. The incremental
 * sentence interpolates the ratio so the prose cannot disagree with the cap that
 * is actually enforced.
 */
export const OPTIMIZE_MODE_TAGLINES = {
  full: '首次建立或严重缺失时覆盖全部可优化字段。',
  incremental: `存量单轮修改幅度 ≤${Math.round(INCREMENTAL_CHANGE_RATIO * 100)}%，优先解决阻断、事实错误和高价值缺口；不为了「看起来不一样」重写稳定内容。`,
  targeted: '只做一个专项：标题 / 五点 / 后台词 / 属性 / A+ / 评论痛点 / SEO·GEO / 本地化。',
  audit: '不生成新文案，只检查现有 Listing 的事实、规则、关键词、完整性和竞品差距。',
}

/**
 * The eight targeted scopes, each with the fields it owns.
 *
 * `fields` is the whole point of the mode: a 标题专项 that could also rewrite
 * the description is not a 专项. `why` is carried so the page and the report can
 * say why `item_highlights` travels with 标题 (they are a forced-linkage group,
 * §7.2) instead of looking like an arbitrary extra.
 */
export const TARGETED_SCOPES = [
  {
    id: 'title',
    label: '标题',
    fields: ['title', 'item_highlights'],
    why: '标题与 Item Highlights 是 §7.2 的强制联动组：改了一个不同步另一个，两个承诺会对不上。',
  },
  {
    id: 'bullets',
    label: '五点',
    fields: [...BULLET_FIELDS],
    why: 'B1–B5 固定分工（§7.3），五条一起改才能保持 What+Why+How 的分工不串位。',
  },
  {
    id: 'backend',
    label: '后台词',
    fields: ['search_terms'],
    why: '后台搜索词只用前台未覆盖的词（§7.5），单独一轮才能按 249 字节预算重新分配。',
  },
  {
    id: 'attributes',
    label: '属性',
    fields: REQUIRED_ATTRIBUTES.map(attributeField),
    why: '43 项属性是事实不是文案（§7.6），单独一轮才能逐项标「需人工确认」。',
  },
  {
    id: 'aplus',
    label: 'A+',
    fields: [...APLUS_FIELDS, 'brand_story'],
    why: 'A+ 与品牌故事走独立编辑器（§7.4），一起改才能保证与五点的卖点排序一致。',
  },
  {
    id: 'review-pain',
    label: '评论痛点',
    fields: [...BULLET_FIELDS, 'description', ...QA_FIELDS],
    why: '评论痛点要落在能被消费者读到的位置：五点讲解决、描述讲细节、Q&A 直接回应。',
  },
  {
    id: 'seo-geo',
    label: 'SEO·GEO',
    fields: ['title', 'item_highlights', ...BULLET_FIELDS, 'description', 'search_terms', ...QA_FIELDS],
    why: '搜索引擎与生成式引擎读的是同一批可被抓取的文本面，后台词单独留一个入口。',
  },
  {
    id: 'localization',
    label: '本地化',
    fields: ['title', 'item_highlights', ...BULLET_FIELDS, 'description', 'search_terms', ...QA_FIELDS, ...IMAGE_ALT_FIELDS],
    why: '站点本地化改的是计量单位、颜色命名与场景词（站点档案的 habits），落在全部可读文本上；图片 Alt Text 也要跟着换。',
  },
]

export const TARGETED_SCOPE_LABELS = Object.fromEntries(TARGETED_SCOPES.map(scope => [scope.id, scope.label]))

const TARGETED_SCOPE_BY_ID = new Map(TARGETED_SCOPES.map(scope => [scope.id, scope]))

/** One targeted scope by id, or `null`. */
export function targetedScope(id) {
  return TARGETED_SCOPE_BY_ID.get(String(id ?? '').trim()) ?? null
}

/**
 * Every field an optimization round may propose a value for.
 *
 * 32 static fields plus the 43 attributes. The attributes are listed by id here
 * (rather than as the `attribute.*` wildcard the rule runner uses) because a
 * budget has to count actual fields, and a wildcard cannot be counted.
 */
export function optimizableFields() {
  return [...DRAFT_FIELDS, ...REQUIRED_ATTRIBUTES.map(attributeField)]
}

export const OPTIMIZABLE_FIELD_COUNT = DRAFT_FIELDS.length + REQUIRED_ATTRIBUTE_TARGET

/**
 * How many fields one incremental round may change.
 *
 * `Math.floor`, not `Math.round` or `ceil`: a cap that rounds up lets 30.4% of a
 * listing through under a rule that says ≤30%, and nobody reading the report
 * would see the difference. The floor is then lifted to 1, because a listing
 * small enough to compute a 0-field budget would make 增量 unusable — but only
 * for a *finite* total. A missing or unreadable total returns `null` rather than
 * `Math.max(1, NaN)`: NaN survives `Math.max` as NaN and the cap would silently
 * disappear at every comparison (`NaN < x` is false), which is the exact trap
 * `plugin-contract.md` §8.2 records.
 */
export function incrementalBudget({ total = OPTIMIZABLE_FIELD_COUNT, ratio = INCREMENTAL_CHANGE_RATIO } = {}) {
  const size = Number(total)
  const share = Number(ratio)
  if (!Number.isFinite(size) || !Number.isFinite(share) || size <= 0 || share <= 0) return null
  return { ratio: share, total: size, allowed: Math.max(1, Math.floor(size * share)) }
}

/**
 * Resolve a mode (+ scope) into the spec every caller reads.
 *
 * Returns `null` for an unknown mode and for `targeted` without a known scope:
 * both are caller errors, and each caller has its own way of saying so (the tool
 * returns `{ ok:false }`, the page shows the refusal). Returning a default here
 * would hide the typo behind a plausible-looking run.
 */
export function modeSpec(mode, { scope = null } = {}) {
  const id = String(mode ?? '').trim()
  if (!OPTIMIZE_MODES.includes(id)) return null

  if (id === 'audit') {
    return {
      id,
      label: OPTIMIZE_MODE_LABELS[id],
      generates: false,
      scope: null,
      scopeLabel: null,
      fields: [],
      budget: null,
      priority: null,
      note: OPTIMIZE_MODE_TAGLINES.audit,
    }
  }

  if (id === 'targeted') {
    const picked = targetedScope(scope)
    if (picked === null) return null
    return {
      id,
      label: `${OPTIMIZE_MODE_LABELS[id]}·${picked.label}`,
      generates: true,
      scope: picked.id,
      scopeLabel: picked.label,
      fields: [...picked.fields],
      budget: null,
      priority: null,
      note: picked.why,
    }
  }

  const fields = optimizableFields()
  if (id === 'incremental') {
    return {
      id,
      label: OPTIMIZE_MODE_LABELS[id],
      generates: true,
      scope: null,
      scopeLabel: null,
      fields,
      budget: incrementalBudget({ total: fields.length }),
      priority: [...INCREMENTAL_PRIORITIES],
      note: `${OPTIMIZE_MODE_TAGLINES.incremental}优先级：${INCREMENTAL_PRIORITIES.map(key => INCREMENTAL_PRIORITY_LABELS[key]).join(' > ')}。`,
    }
  }

  return {
    id: 'full',
    label: OPTIMIZE_MODE_LABELS.full,
    generates: true,
    scope: null,
    scopeLabel: null,
    fields,
    budget: null,
    priority: null,
    note: OPTIMIZE_MODE_TAGLINES.full,
  }
}

/**
 * The four modes as a picker list, without needing a scope to be chosen first.
 *
 * `modeSpec('targeted')` needs a scope by design, so the catalog reports targeted
 * as `fieldCount: null` — "depends on which专项" — rather than picking one and
 * implying the others are not options.
 */
export function modeCatalog() {
  return OPTIMIZE_MODES.map((id) => {
    const spec = id === 'targeted' ? null : modeSpec(id)
    return {
      id,
      label: OPTIMIZE_MODE_LABELS[id],
      tagline: OPTIMIZE_MODE_TAGLINES[id],
      generates: id !== 'audit',
      pickScope: id === 'targeted',
      fieldCount: spec === null ? null : spec.fields.length,
      budget: spec === null ? null : spec.budget,
    }
  })
}

/** Is this field inside the given spec's scope? */
export function fieldInScope(spec, field) {
  if (spec === null || spec === undefined) return false
  return spec.fields.includes(String(field ?? '').trim())
}

/**
 * Order the optimizable fields by §4.2's priority, best-first.
 *
 * The three signals are read, never guessed:
 *
 *   blocking        a `block` violation the rule engine already produced for the
 *                   *current* copy (the caller passes it in), or an open data
 *                   quality issue with severity `block` on this field.
 *   fact-error      an open data quality issue whose dimension is `validity` or
 *                   `consistency` on this field. §7.6 forbids inferring hard
 *                   facts from copy, so this deliberately does not try to spot a
 *                   wrong number by reading the text — it reads the findings the
 *                   data-quality module already made.
 *   high-value-gap  the field is where a T1/T2 keyword that is already ranking
 *                   but absent from the copy is planned to go.
 *
 * Ties keep the canonical field order, so the list is stable across runs and two
 * reports of the same listing can be compared line by line.
 */
export function rankIncrementalFields({
  fields = optimizableFields(),
  blockedFields = [],
  issueFields = [],
  quickWinFields = [],
} = {}) {
  const blocked = new Set(blockedFields)
  const errors = new Set(issueFields)
  const gaps = new Set(quickWinFields)

  const rankOf = (field) => {
    if (blocked.has(field)) return 'blocking'
    if (errors.has(field)) return 'fact-error'
    if (gaps.has(field)) return 'high-value-gap'
    return 'stable'
  }

  const rows = fields.map((field, index) => {
    const priority = rankOf(field)
    return { field, index, priority, label: INCREMENTAL_PRIORITY_LABELS[priority], why: INCREMENTAL_PRIORITY_WHY[priority] }
  })

  const order = new Map(INCREMENTAL_PRIORITIES.map((key, index) => [key, index]))
  rows.sort((a, b) => (order.get(a.priority) - order.get(b.priority)) || (a.index - b.index))
  return rows.map((row, position) => ({ ...row, position: position + 1 }))
}

/**
 * Which of a draft's fields an audit run is not allowed to have at all.
 *
 * Used by the submit path to name every offending field in the refusal instead
 * of the first one: a caller that is refused for `title` and then refused again
 * for `bullet_3` learns the rule one field at a time.
 */
export function generatedFieldsOf(fields = {}) {
  return Object.keys(fields ?? {}).filter(field => String(field).trim() !== '')
}

/** Is this draft payload a generation at all? An audit run tolerates nothing. */
export function auditRefusal(spec, fields = {}) {
  if (spec === null || spec.generates !== false) return null
  const generated = generatedFieldsOf(fields)
  if (generated.length === 0) return null
  return {
    code: 'OPTIMIZE_AUDIT_MODE_NO_WRITE',
    fields: generated,
    error: `审核模式不生成文案，这次提交带了 ${generated.length} 个生成字段（${generated.slice(0, 8).join('、')}${generated.length > 8 ? ' 等' : ''}）。`
      + '审核模式只输出检查结论；要生成文案请用 amzn_optimize_prepare 开一轮 full / incremental / targeted 的运行。',
  }
}

/**
 * Which fields a 专项 draft carries that the scope does not include, or `null`.
 *
 * A scope is a permission list, not a label. Without this, a 标题专项 run could
 * persist a rewritten description and the report would still call itself a
 * 标题专项 — the mode would describe an intention rather than a boundary.
 */
export function scopeRefusal(spec, fields = {}) {
  if (spec === null || spec.id !== 'targeted') return null
  const outside = Object.keys(fields ?? {}).filter(field => !spec.fields.includes(String(field).trim()))
  if (outside.length === 0) return null
  return {
    code: 'OPTIMIZE_FIELD_OUT_OF_SCOPE',
    scope: spec.scope,
    scopeLabel: spec.scopeLabel,
    fields: outside,
    error: `本轮是「${spec.label}」专项，不在作用域内的字段会被拒绝：`
      + `${outside.slice(0, 8).join('、')}${outside.length > 8 ? ' 等' : ''}（共 ${outside.length} 个）。`
      + `这个专项只写：${spec.fields.join('、')}。要改别的字段，另开一轮对应模式的运行。`,
  }
}

/**
 * How far over the incremental cap a set of changed fields is, or `null`.
 *
 * `changed` is the number of fields whose proposed value differs from the stored
 * one — counted by the caller, because only the caller knows whether it is
 * counting drafts, accepted drafts or accepted-and-written fields.
 */
export function incrementalOverflow(spec, changed) {
  if (spec === null || spec.budget === null || spec.budget === undefined) return null
  const count = Number(changed)
  if (!Number.isFinite(count)) return null
  if (count <= spec.budget.allowed) return null
  return {
    code: 'OPTIMIZE_INCREMENTAL_OVER_BUDGET',
    changed: count,
    allowed: spec.budget.allowed,
    ratio: spec.budget.ratio,
    total: spec.budget.total,
    error: `增量模式单轮最多改 ${spec.budget.allowed} 个字段（${Math.round(spec.budget.ratio * 100)}% × ${spec.budget.total}），这次是 ${count} 个。`
      + '先按优先级只改阻断、事实错误和高价值缺口，其余留给下一轮。',
  }
}
