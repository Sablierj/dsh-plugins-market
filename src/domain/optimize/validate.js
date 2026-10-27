/**
 * The rule runner and the gates.
 *
 * Two jobs that look similar and are not:
 *
 *   **Rules** (`validateDraft`) answer *is this legal*. Over the character limit,
 *   a banned character, a promo word, a medical claim. Each violation carries the
 *   rule id and the doc section it came from, because the SOP requires every
 *   proposed change to name the rule it answers to — a violation without a
 *   citation is unusable to the person reading the report.
 *
 *   **Gates** (`runGates`) answer *is this finished*. The hub's
 *   `validation_gates` are six named conditions, and none of them is about
 *   legality: a listing can be perfectly legal and still be missing four of its
 *   eleven sections. Keeping the two apart matters because they fail differently
 *   — a gate failure means "keep working", a rule failure means "this would be
 *   rejected".
 *
 * ## Two normalisation decisions
 *
 * Shapes are accepted loosely because both show up in practice: an agent asked
 * for "five bullets" answers with an array, a form on a page produces numbered
 * fields. `normalizeDraft` folds both into numbered fields so exactly one code
 * path does the judging — the alternative is a rule that fires for one caller
 * and not the other, which is the kind of inconsistency nobody finds until it
 * matters. Where both shapes are present the **array wins**, because reading both
 * would double the entries and the count rules would then report a problem the
 * author does not have.
 *
 * Blank entries are dropped rather than kept as empty strings: an empty bullet is
 * not a bullet, and keeping it would fire `bullet.length.min` on a field nobody
 * wrote.
 */

import {
  APLUS_FIELDS, BULLET_FIELDS, IMAGE_ALT_FIELDS, QA_FIELDS,
  orderFields, sectionOf,
} from '../rules/listing-fields.js'
import { ATTRIBUTES, REQUIRED_ATTRIBUTE_TARGET, attributeCoverage } from '../rules/attributes.js'
import { RULES, RULES_SOURCE, RULES_VERSION } from '../rules/listing-rules.js'
import { genericCheck, resolveCheck } from '../rules/registry.js'
import { measureDraft } from './budget.js'
import { buildGlobalPlan } from './plan.js'

/**
 * The roster used when a caller supplies neither a validation result nor a roster.
 *
 * It exists because `runGates` is a pure function with no store to read, so it
 * cannot resolve the live roster itself. What matters is that it is *named*: a
 * verdict that came from the code seed can now say so, instead of looking
 * identical to one that came from the user's rule library. `origin` is the
 * difference between a disclosed fallback and the silent one this used to be.
 */
const CODE_SEED_ROSTER = {
  origin: 'code-seed',
  version: RULES_VERSION,
  source: RULES_SOURCE,
  count: RULES.length,
  fromCode: true,
  rules: RULES,
}

const pickText = (value) => {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** One Q&A pair, from whatever shape it arrived in. */
function qaPairText(entry) {
  if (entry === null || entry === undefined) return null
  if (typeof entry === 'string') return pickText(entry)
  if (typeof entry !== 'object') return null
  const question = pickText(entry.question ?? entry.q ?? entry.Q)
  const answer = pickText(entry.answer ?? entry.a ?? entry.A)
  if (question === null && answer === null) return null
  return `Q: ${question ?? ''}\nA: ${answer ?? ''}`
}

/**
 * Numbered fields from either an array or the numbered keys.
 *
 * Shared by bullets, A+ modules and Q&A because all three have the same two
 * input shapes and the same rule about which one wins — writing it three times
 * is how the three drift.
 */
function collectNumbered(draft, { arrayKeys, prefix, numbered, map = pickText }) {
  const list = []
  let fromArray = false
  for (const key of arrayKeys) {
    if (Array.isArray(draft[key]) && draft[key].length > 0) {
      list.push(...draft[key])
      fromArray = true
      break
    }
  }
  if (!fromArray) {
    for (const field of numbered) {
      if (draft[field] !== undefined) list.push(draft[field])
    }
  }
  const out = {}
  list.forEach((entry, index) => {
    const text = map(entry)
    if (text !== null) out[`${prefix}${index + 1}`] = text
  })
  return out
}

/** Image alt text, from an object keyed by position, an array, or numbered fields. */
function collectImageAlt(draft) {
  const out = {}
  const source = draft.image_alt ?? draft.imageAlts ?? draft.alt_text
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const main = pickText(source.main ?? source.main_image ?? source.mainImage)
    if (main !== null) out.image_alt_main = main
    for (let index = 1; index <= 6; index += 1) {
      const text = pickText(source[index] ?? source[String(index)])
      if (text !== null) out[`image_alt_${index}`] = text
    }
  } else if (Array.isArray(source) && source.length > 0) {
    source.forEach((entry, index) => {
      const text = pickText(entry)
      if (text === null) return
      out[index === 0 ? 'image_alt_main' : `image_alt_${index}`] = text
    })
  } else {
    for (const field of IMAGE_ALT_FIELDS) {
      const text = pickText(draft[field])
      if (text !== null) out[field] = text
    }
  }
  return out
}

/** Attribute values, from an `attributes` object or from `attribute.<id>` keys. */
function collectAttributes(draft) {
  const out = {}
  if (draft.attributes !== null && typeof draft.attributes === 'object' && !Array.isArray(draft.attributes)) {
    for (const [id, value] of Object.entries(draft.attributes)) {
      const text = pickText(value)
      if (text !== null) out[`attribute.${id}`] = text
    }
  }
  for (const [key, value] of Object.entries(draft)) {
    if (!key.startsWith('attribute.')) continue
    const text = pickText(value)
    if (text !== null) out[key] = text
  }
  return out
}

/**
 * Accept every reasonable draft shape and return numbered fields.
 *
 * Recognised top-level shapes, all optional:
 *   title, description / productDescription, search_terms / searchTerms / backend,
 *   item_highlights / highlights, brand_story, video_script,
 *   bullets[] | bullet_1..5, aplus[] | aplus_1..6,
 *   qa[] | qa_1..8  (each pair as `{question, answer}`, `{q, a}` or a string),
 *   image_alt{main,1..6} | image_alts[] | image_alt_*,
 *   attributes{id: value} | attribute.<id>
 */
export function normalizeDraft(draft = {}) {
  const fields = {}

  const title = pickText(draft.title)
  if (title !== null) fields.title = title
  const description = pickText(draft.description ?? draft.productDescription)
  if (description !== null) fields.description = description
  const searchTerms = pickText(draft.search_terms ?? draft.searchTerms ?? draft.backend ?? draft.backendKeywords)
  if (searchTerms !== null) fields.search_terms = searchTerms
  const highlights = pickText(draft.item_highlights ?? draft.highlights ?? draft.itemHighlights)
  if (highlights !== null) fields.item_highlights = highlights
  const brandStory = pickText(draft.brand_story ?? draft.brandStory)
  if (brandStory !== null) fields.brand_story = brandStory
  const videoScript = pickText(draft.video_script ?? draft.videoScript)
  if (videoScript !== null) fields.video_script = videoScript

  Object.assign(fields, collectNumbered(draft, {
    arrayKeys: ['bullets', 'bullet_points', 'bulletPoints'],
    prefix: 'bullet_',
    numbered: BULLET_FIELDS,
  }))
  Object.assign(fields, collectNumbered(draft, {
    arrayKeys: ['aplus', 'aplus_modules', 'aplusModules'],
    prefix: 'aplus_',
    numbered: APLUS_FIELDS,
  }))
  Object.assign(fields, collectNumbered(draft, {
    arrayKeys: ['qa', 'qa_pairs', 'qaPairs', 'questions'],
    prefix: 'qa_',
    numbered: QA_FIELDS,
    map: qaPairText,
  }))
  Object.assign(fields, collectImageAlt(draft))
  Object.assign(fields, collectAttributes(draft))

  return fields
}

/** Fields present in a draft, in the vocabulary's canonical order. */
export function draftFields(fields = {}) {
  return orderFields(fields).filter(field => fields[field] !== undefined)
}

/** The bullets of a draft, in order, however many there are. */
export function draftBullets(fields = {}) {
  return Object.entries(fields)
    .filter(([field]) => field.startsWith('bullet_'))
    .sort((a, b) => Number(a[0].slice(7)) - Number(b[0].slice(7)))
    .map(([, value]) => value)
}

/**
 * Expand a rule's `appliesTo` against the fields a draft actually carries.
 *
 * The `attribute.*` wildcard is why this exists: there are 43 attributes and
 * they are dynamic, so a rule cannot enumerate them the way `['title']` does.
 * Expanding the prefix here means the rule is written once instead of 43 times.
 */
function targetsFor(rule, fields) {
  const targets = []
  for (const pattern of rule.appliesTo) {
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1)
      for (const field of Object.keys(fields)) {
        if (field.startsWith(prefix)) targets.push({ field, value: fields[field] })
      }
      continue
    }
    if (fields[pattern] !== undefined) targets.push({ field: pattern, value: fields[pattern] })
  }
  return targets
}

/**
 * Describe a bare rule array, for the callers that pass one instead of a roster.
 *
 * The point is to not lie about provenance. A caller that passes `RULES` really
 * did hand over the code seed; a caller that passes an array read back from the
 * store handed over a real roster that simply has no descriptor attached. Both
 * are reported as what they are, and the second is `version: null` rather than a
 * guessed version — a wrong version in a report is worse than no version.
 */
function describeRules(rules) {
  if (rules === RULES) return CODE_SEED_ROSTER
  return {
    origin: 'explicit',
    version: null,
    source: null,
    count: rules.length,
    fromCode: false,
    rules,
  }
}

/**
 * Run every applicable rule.
 *
 * `roster` is the preferred input and the one every production call site passes:
 * a descriptor from `rosterForValidation`, which carries the rules *and* where
 * they came from. Passing the descriptor rather than a bare array is what makes
 * the origin impossible to lose — the array alone cannot say whether it is
 * today's library or a March snapshot.
 *
 * `rules` remains supported for callers that only have an array (the test suite,
 * and any caller that deliberately wants the code seed). It is a *fallback*, not
 * a default: when neither is given the code seed is used and the result says
 * `origin: 'code-seed'`, so a caller that forgot to resolve a roster produces a
 * verdict that admits it rather than one that looks authoritative.
 *
 * The injected list may be either the code seed (each rule carries its own
 * `check`) or a roster read back from the store (each rule carries only an id).
 * `registry.resolveCheck` bridges the two; a `code` rule with no implementation
 * is reported as `rule-check-missing`, never silently passed.
 */
export function validateDraft({ fields = {}, listing = null, keywords = [], options = {}, rules = null, roster = null } = {}) {
  /* One resolution, one place. A descriptor wins over a bare array because it is
     strictly more informative — it carries the same rules plus their provenance. */
  const source = roster !== null && roster !== undefined && Array.isArray(roster.rules)
    ? roster
    : (Array.isArray(rules) ? describeRules(rules) : CODE_SEED_ROSTER)
  const ruleList = source.rules

  const bullets = draftBullets(fields)
  const violations = []
  /* Rules that could not be judged on this site. Kept apart from `violations`
     on purpose: "the rule does not apply here" is neither a pass nor a fail, and
     folding it into either would misreport it. A rule that never ran must never
     read as a rule that passed. */
  const skipped = []

  for (const rule of ruleList) {
    const kind = String(rule.kind ?? 'code')
    /* A `doc` row is documentation only: a rule the manual lists and the code
       does not implement. It has no judgement to make, so it is neither a pass
       nor a fail and is not reported at all — but it is explicitly `doc`, never
       an unimplemented `code` rule quietly treated the same way. */
    if (kind === 'doc') continue

    /* The judgement may live on the rule (the `RULES` seed carries its own
       `check`) or be indexed by id (`CHECKS`, for a roster read back from the
       store). `resolveCheck` is the one place that difference is resolved. */
    const impl = resolveCheck(rule)
    let checkFn = impl === null ? null : impl.check
    let notApplicableFn = impl === null ? null : impl.notApplicable
    /* lexicon / threshold are judged from their own params — the user-authored
       path. An empty or malformed param set yields no function, which then falls
       through to the missing-check branch and is reported, never skipped. */
    if (checkFn === null && (kind === 'lexicon' || kind === 'threshold')) {
      checkFn = genericCheck(rule)
    }
    /* A `code` rule with no implementation is NOT a pass. This is the discipline
       arch §3.4 names: a rule that never ran must never read as a rule that
       passed, or "6/6 通过" becomes a lie (DESIGN §5.12). */
    const missing = checkFn === null

    let targets
    if (rule.scope === 'set') {
      if (Array.isArray(rule.appliesTo) && rule.appliesTo.includes('bullets')) {
        if (bullets.length === 0) {
          if (missing) violations.push(missingViolation(rule, 'bullets'))
          continue
        }
        targets = [{ field: 'bullets', value: null }]
      } else {
        targets = [{ field: 'draft', value: null }]
      }
    } else {
      targets = targetsFor(rule, fields)
      if (targets.length === 0) {
        /* The rule targets nothing in this draft. Normally that is a no-op — but
           an unimplemented rule is still reported once, so it can never slip
           through as a silent pass just because its field happened to be absent. */
        if (missing) violations.push(missingViolation(rule, 'draft'))
        continue
      }
    }

    if (missing) {
      for (const target of targets) violations.push(missingViolation(rule, target.field))
      continue
    }

    for (const target of targets) {
      const context = { field: target.field, value: target.value, fields, bullets, listing, keywords, options }
      let messages
      let notApplicable = null
      try {
        /* A rule can decline itself (see `notApplicable` in `listing-rules.js`):
           the title word-repeat rule on a script this tokeniser cannot split.
           Asking first means a declined rule is never run and never reported as a
           pass — the silent pass is the bug this exists to remove. */
        if (typeof notApplicableFn === 'function') {
          const reason = notApplicableFn(context)
          if (reason !== null && reason !== undefined && reason !== false && String(reason) !== '') {
            notApplicable = String(reason)
          }
        }
        if (notApplicable === null) messages = checkFn(context)
      } catch (error) {
        /* A rule that throws must not take the whole validation down: the other
           rules still have something useful to say. Report it as a violation of
           its own so it cannot pass silently. */
        messages = [`规则执行出错，未能判定: ${error.message}`]
      }
      if (notApplicable !== null) {
        skipped.push({
          ruleId: rule.id,
          field: target.field,
          section: sectionOf(target.field),
          severity: rule.severity,
          title: rule.title,
          source: rule.source,
          reason: notApplicable,
        })
        continue
      }
      if (!Array.isArray(messages) || messages.length === 0) continue
      violations.push({
        ruleId: rule.id,
        field: target.field,
        section: sectionOf(target.field),
        severity: rule.severity,
        title: rule.title,
        source: rule.source,
        messages,
      })
    }
  }

  return summarize(violations, fields, skipped, source)
}

/**
 * A `kind='code'` rule whose implementation is missing.
 *
 * Severity is forced to `block`: the rule claims to judge legality and cannot, so
 * "is this legal" has no answer — and an unanswered legality question must fail
 * closed rather than pass. `code` names it so a caller (and the test suite) can
 * find it without matching on message text.
 */
function missingViolation(rule, field) {
  return {
    ruleId: rule.id,
    field,
    section: sectionOf(field),
    severity: 'block',
    title: rule.title,
    source: rule.source,
    code: 'rule-check-missing',
    messages: [`规则「${rule.id}」（kind=code）在 CHECKS 里没有对应判定函数 —— 这条规则无法判定，不能当作通过。补上实现，或把它改成 kind=doc / 停用它`],
  }
}

function summarize(violations, fields, skipped = [], roster = null) {
  const counts = { block: 0, warn: 0 }
  const byField = {}
  for (const violation of violations) {
    counts[violation.severity] = (counts[violation.severity] ?? 0) + 1
    const entry = byField[violation.field] ?? { block: 0, warn: 0 }
    entry[violation.severity] += 1
    byField[violation.field] = entry
  }
  return {
    violations,
    /* Not violations: rules that do not apply on this site. Exposed so the report
       can state them instead of letting them read as passes. */
    skipped,
    counts,
    byField,
    ok: counts.block === 0,
    fields: draftFields(fields),
    /* Which roster produced this verdict, and where it came from. Attached to the
       result rather than returned separately so a caller cannot print the verdict
       without also having the means to say what judged it — `origin: 'code-seed'`
       is the one that matters, because it means nobody resolved a roster. */
    roster: roster === null
      ? null
      : {
          origin: roster.origin ?? 'unknown',
          version: roster.version ?? null,
          source: roster.source ?? null,
          count: roster.rules.length,
          fromCode: roster.fromCode === true,
        },
  }
}

/**
 * A draft is publishable when nothing blocks it.
 *
 * Warns are deliberately excluded from `publishable`: treating a warning as a
 * blocker is how a checklist turns into a reason not to ship anything.
 *
 * Named `isDraftPublishable` rather than `isPublishable` because the field
 * vocabulary already exports an `isPublishable(field)` meaning something
 * entirely different — whether a *field* can be pasted into Seller Central. Two
 * functions with one name, one taking a field and one taking a validation
 * result, is how a caller ends up passing the wrong thing and getting a
 * plausible boolean back.
 */
export function isDraftPublishable(result) {
  return result.counts.block === 0
}

/* ── the gates ────────────────────────────────────────────────────────────────
   The hub's six `validation_gates`, in its order. Each returns a verdict with
   the reason attached, because "字段完整性: 未通过" without the missing list is a
   gate that tells you to keep guessing. */

/**
 * Fields the gate expects before a draft counts as complete.
 *
 * Exported because module 14 §6 needs the same four: its deviation threshold is
 * 「任一**核心字段**被改动，或差异字段数 >30%」 and it never defines 核心字段.
 * This is the only declaration of that idea in the repo, so the deviation rule
 * imports it rather than writing a second list — two lists with the same meaning
 * is how a threshold silently moves when someone edits one of them.
 */
export const REQUIRED_CORE_FIELDS = ['title', 'description', 'search_terms', 'item_highlights']

export const GATES = [
  {
    id: 'complete_field_set',
    label: '字段完整性',
    what: '该有内容的字段是否都有内容：核心四项、五条五点、Item Highlights、属性是否够 43 项',
    source: 'listing_contract.py validation_gates',
    check({ fields }) {
      /* 2026-10-25 需求方指出（R-13）：**后台搜索词采集不到，可以空；优化后不能空。**
         查下来这一门原来判的是 `fields[field] === undefined` —— 于是
         `search_terms: ''`（给了个空串）算「有内容」，**字段完整性门照绿**。
         `title: ''` 同理。**把「空字符串」当成「有内容」，就是这一门在说谎。**

         判据改成「有没有实质内容」：undefined / null / 纯空白都算没有。
         这条对 `REQUIRED_CORE_FIELDS` 里四个字段一视同仁 ——
         因为一个只有空格的标题和一个没写标题，对 listing 是同一件事。 */
       const blank = value => value === undefined || value === null || String(value).trim() === ''
       const missing = REQUIRED_CORE_FIELDS.filter(field => blank(fields[field]))
      const bullets = BULLET_FIELDS.filter(field => fields[field] !== undefined)
      if (bullets.length < BULLET_FIELDS.length) missing.push(`五点（已有 ${bullets.length}/${BULLET_FIELDS.length}）`)
      if (fields.item_highlights === undefined) missing.push('产品亮点')
      const attributes = attributeCoverage(fields)
      if (!attributes.complete) missing.push(`属性（已有 ${attributes.filledCount}/${REQUIRED_ATTRIBUTE_TARGET}）`)
      /* 后台搜索词单独给一句：它和别的字段不一样——
         **它是采集不到的那一个**（后台词只在卖家后台，采集拿不到），
         所以当它缺席时，读者最容易把它理解成「本来就没有」，而不是「这一轮没写」。 */
      const backendMissing = blank(fields.search_terms)
      return {
        pass: missing.length === 0,
        detail: missing.length === 0
          ? `核心字段齐全，属性 ${attributes.filledCount}/${REQUIRED_ATTRIBUTE_TARGET}`
          : `还缺: ${missing.join('、')}`
            + (backendMissing
              ? '（**后台搜索词这一项特殊：它采集不到，所以「现状为空」是正常的；'
                + '但优化产出必须给它内容 —— 优化后仍然为空，等于这一轮没做后台词。**）'
              : ''),
        missing,
        backendMissing,
      }
    },
  },
  {
    id: 'keyword_allocation_unique',
    label: '关键词分配唯一',
    what: '每个词是否只有一个主人 —— 两个字段抢同一个词会互相稀释，而不是双倍权重',
    source: 'listing_contract.py global_plan.keyword_allocation',
    check({ plan }) {
      /* 「没有输入」不等于「没有违规」。以前这里是 `plan?.allocation?.violations ?? []`
         → 空数组 → pass:true → 一个根本没跑的选择被画成「N 个词各有唯一主人」。
         未执行必须说未执行（unverified），不能混进通过率里。 */
      if (plan === null || plan === undefined || typeof plan !== 'object') {
        return { pass: false, unverified: true, detail: '没有 plan 输入 —— 这一关没有执行（不是通过）', violations: [] }
      }
      const violations = plan.allocation?.violations ?? []
      /* 2026-10-25（R-14）：`plan` 有值、但**一个词都没分**时，这里原来报
         `PASS · 0 个词各有唯一主人` —— **没有输入被画成通过**。
         读者会以为「分配得很好」，实际是「这一轮没做分配」。
         上面那条 `plan === null` 的 unverified 只挡住「整个 plan 没跑」，
         挡不住「plan 跑了但一个词都没有」。**「0 个」和「没有」是两件事。** */
      const total = plan.allocation?.summary?.total ?? 0
      if (total === 0 && violations.length === 0) {
        return {
          pass: false,
          unverified: true,
          detail: '一个词都没有分配 —— 这一关没有执行（不是通过）',
          violations: [],
        }
      }
      return {
        pass: violations.length === 0,
        detail: violations.length === 0
          ? `${total} 个词各有唯一主人`
          : violations.map(violation => violation.detail).join('；'),
        violations,
      }
    },
  },
  {
    id: 'product_fact_consistency',
    label: '产品事实一致',
    what: '同一个事实（尺寸、重量、材质、容量）在全文是否只有一个取值',
    source: 'listing_contract.py global_plan.fact_ledger',
    check({ plan }) {
      /* 同 keyword_allocation_unique：没有 plan 时「0 个冲突」是一句没跑过的话。 */
      if (plan === null || plan === undefined || typeof plan !== 'object') {
        return { pass: false, unverified: true, detail: '没有 plan 输入 —— 这一关没有执行（不是通过）', conflicts: [] }
      }
      const conflicts = plan.factLedger?.conflicts ?? []
      return {
        pass: conflicts.length === 0,
        detail: conflicts.length === 0
          ? `${plan.factLedger?.summary?.total ?? 0} 个事实各只有一个取值`
          : conflicts.map(conflict => conflict.detail).join('；'),
        conflicts,
      }
    },
  },
  {
    id: 'compliance_coverage',
    label: '合规覆盖',
    what: '机检是否 0 阻断项。警告不拦 —— 有警告但无阻断的文案是可以发布的',
    source: 'listing_contract.py validation_gates',
    check({ validation }) {
      /* `validation?.counts?.block ?? 0` 会让「没有跑过校验」变成「无阻断项」——
         这是本仓最不能接受的那句话：没执行写成通过。缺 counts 就是未判定。 */
      if (validation === null || validation === undefined
        || typeof validation !== 'object' || validation.counts === null || validation.counts === undefined
        || typeof validation.counts !== 'object') {
        return { pass: false, unverified: true, detail: '没有 validation 结果 —— 这一关没有执行（不是通过）', blocks: null, warns: null }
      }
      const blocks = validation.counts.block
      const warns = validation.counts.warn
      if (!Number.isFinite(blocks) || !Number.isFinite(warns)) {
        return { pass: false, unverified: true, detail: 'validation.counts 不是数字 —— 这一关没有执行（不是通过）', blocks: null, warns: null }
      }
      return {
        pass: blocks === 0,
        detail: blocks === 0
          ? `无阻断项，${warns} 条警告`
          : `${blocks} 条阻断项必须先处理`,
        blocks,
        warns,
      }
    },
  },
  {
    id: 'character_and_byte_budgets',
    label: '字符与字节预算',
    what: '每个字段是否在自己的上限内。后台搜索词按字节算，其余按字符算',
    source: 'listing_contract.py field_budgets',
    check({ budgets }) {
      const over = (budgets ?? []).filter(row => row.over)
      const total = budgets?.length ?? 0
      /* 2026-10-25（R-50）：原来通过时一律印 `${total} 个字段都在预算内`。
         当 `total === 0` 时它印成「**0 个字段都在预算内**」——
         字面意思是「确实没有字段超预算」（空集的平凡真），
         **但读起来像「0 个字段」**，而真实情况是「没有字段可判」。

         实测 run 4e60241a（真实库，草案为空）：
           ✅ 字符与字节预算: 0 个字段都在预算内

         同一个 `0` 在这里同时可能是「0 个字段」和「0 个超预算的字段」——
         **两个相反的意思印成同一句话。** 空集要单独说。 */
      const detail = over.length > 0
        ? over.map(row => `${row.label} ${row.used}/${row.max}${row.unit === 'bytes' ? 'B' : '字符'}`).join('；')
        : (total === 0
          ? '没有字段可判（草案为空，0 个字段进预算）'
          : `${total} 个字段都在预算内`)
      return { pass: over.length === 0, detail, over }
    },
  },
  {
    id: 'cross_module_linkage',
    label: '跨模块联动',
    what: '强制联动组是否成对：标题↔Item Highlights、前端可见词↔后台搜索词',
    source: 'listing_contract.py global_plan.linkage_matrix',
    check({ plan }) {
      const mandatory = (plan?.linkageMatrix?.broken ?? []).filter(group => group.mandatory)
      const advisory = (plan?.linkageMatrix?.broken ?? []).filter(group => !group.mandatory)
      return {
        pass: mandatory.length === 0,
        detail: mandatory.length === 0
          ? (advisory.length === 0 ? '所有联动组都完整' : `强制联动组完整；${advisory.length} 个建议组未配对（不阻断）`)
          : mandatory.map(group => `${group.label} 缺 ${group.missing.length} 项`).join('；'),
        mandatory,
        advisory,
      }
    },
  },
]

/**
 * Run the six gates.
 *
 * Builds the plan itself when one is not supplied, so a caller that only has a
 * draft still gets a meaningful answer for the plan-dependent gates rather than
 * three "not run" rows.
 *
 * `roster` is passed straight through to the validation this builds when the
 * caller did not already supply one. In practice every production caller supplies
 * `validation`, and the gates then read the roster *from that result* — which is
 * why the roster is attached to the result instead of being threaded separately
 * here. The parameter exists for the fallback path only, so that path can be
 * judged against the live roster rather than the code seed.
 */
export function runGates({ fields = {}, listing = null, keywords = [], validation = null, plan = null, budgets = null, options = {}, roster = null } = {}) {
  const result = validation ?? validateDraft({ fields, listing, keywords, options, roster })
  const globalPlan = plan ?? buildGlobalPlan({ keywords, listing, fields, validation: result, marketplace: options?.marketplace })
  const measured = budgets ?? measureDraft(fields, options)
  const context = { fields, listing, keywords, validation: result, plan: globalPlan, budgets: measured, options }

  const gates = GATES.map(gate => {
    let outcome
    try {
      outcome = gate.check(context)
    } catch (error) {
      outcome = { pass: false, detail: `闸门执行出错，未能判定: ${error.message}` }
    }
    /* `what`（这道闸门判什么）与 `source`（依据哪份文档）一起带上：F13-08 的闸门面板
       要给读者一个判据，而一个只有 label 与 pass 的闸门行只能让人猜它为什么没过。
       它们本来就是 `GATES` 自己的字段，早先被这里的展开丢掉了 —— 丢掉之后要重新拿到，
       唯一的办法是从别处再查一次表，那就是同一件事的第二份口径。 */
    return { id: gate.id, label: gate.label, what: gate.what ?? null, source: gate.source, ...outcome }
  })

  return {
    gates,
    passed: gates.filter(gate => gate.pass).length,
    total: gates.length,
    /** Blocking gates are the first three the hub names plus budgets; linkage is too. */
    ok: gates.every(gate => gate.pass),
    failed: gates.filter(gate => !gate.pass).map(gate => gate.id),
  }
}

export { ATTRIBUTES }
