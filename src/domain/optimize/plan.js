/**
 * The global plan — decided once, before any field is written.
 *
 * Source of truth: `01-system/app/schemas/listing_contract.py`'s `global_plan`,
 * which is explicit that the plan comes **first**: 「先生成关键词分配、事实台账、
 * 合规矩阵和字段联动矩阵，再提供…审阅行」. Its four matrices are
 * `keyword_allocation`, `fact_ledger`, `compliance_matrix` and `linkage_matrix`,
 * and its three stated invariants are:
 *
 *     one_primary_owner_per_keyword
 *     supporting_reuse_requires_field_and_reason
 *     backend_terms_must_avoid_visible_exact_duplicates
 *
 * ## Why this module had to exist
 *
 * The first version of step 4 mapped each keyword's tier to *one* position and
 * stopped. That is a complete answer to "where does this word go" and a wrong
 * answer to "how much of the listing am I using" — with four positions modelled
 * out of the SOP's eleven, a keyword that could legitimately appear in the
 * title, the description, an attribute, a Q&A pair and the image alt text was
 * assigned to exactly one of them and the other four went unused. The report
 * then said the word was "covered", which was true and useless.
 *
 * So the allocation here has two halves per keyword: an **owner** (exactly one —
 * the position that has to carry it) and **supporting** positions (zero or more,
 * each carrying the reason it is worth repeating there). The reason is not
 * decoration: the hub requires it, and a supporting slot without a reason is
 * just a second place the word happens to be.
 *
 * ## The 12th position
 *
 * `SOP-optimization-v2.1.md` §三 lists **11** 埋词位置 and does not include
 * Item Highlights — the SOP predates the field. But
 * `delivery-2026-07-28-listing-whole-optimization.md` adds it to the registry as
 * a first-class field with its own 125-character budget, and it is the surface
 * Alexa for Shopping reads when composing a recommendation. Dropping it to keep
 * the count at 11 would be tidy and wrong, so it is position 12 and its `source`
 * says exactly why it is not in the SOP's list.
 */

import { keywordInText, listingText } from '../../sources/keyword-tiers.js'
import { APLUS_FIELDS, BULLET_FIELDS, IMAGE_ALT_FIELDS, QA_FIELDS, isAttributeField } from '../rules/listing-fields.js'
import { lexiconFor } from '../rules/lexicon.js'
import { buildEmbeddingPlan, frontText } from './embedding.js'

export const PLAN_VERSION = 'global-plan.v1'

export const PLAN_SOURCE =
  'listing_contract.py global_plan + SOP-optimization-v2.1.md §三（11 个埋词位置）+ delivery-2026-07-28 §4（Item Highlights）'

/**
 * The embedding positions, in weight order.
 *
 * `weight` is a 0–100 number for sorting and bars; `weightLabel` is the SOP's
 * own wording, kept verbatim so the report can quote the doc rather than
 * paraphrase it. The title is the only position the SOP quantifies (40%), so it
 * is the only 100.
 *
 * The list below is written in the SOP's own order and then sorted by weight,
 * because the panel and the report both head this table 「按权重降序」. Item
 * Highlights sits between the 中高 and 中 bands: appending it at the end kept the
 * SOP's eleven together but made the heading a lie, and a heading that
 * misdescribes its own table is worse than an unfamiliar ordering.
 */
const POSITION_LIST = [
  { id: 'title', label: '标题', where: '前 60 字符', weight: 100, weightLabel: '40%', front: true, source: 'SOP §三 #1' },
  { id: 'bullets', label: '五点', where: '每点首句', weight: 85, weightLabel: '高', front: true, source: 'SOP §三 #2' },
  { id: 'description', label: '产品描述', where: '分散', weight: 70, weightLabel: '中高', front: true, source: 'SOP §三 #3' },
  { id: 'attributes', label: '属性字段', where: '后台更多详情', weight: 70, weightLabel: '中高', front: false, source: 'SOP §三 #7' },
  { id: 'product_type', label: 'Product Type', where: '后台更多详情', weight: 70, weightLabel: '中高', front: false, source: 'SOP §三 #5' },
  {
    id: 'item_highlights',
    label: '产品亮点',
    where: 'Alexa for Shopping',
    weight: 60,
    weightLabel: '高（AI 入口）',
    front: true,
    source: 'delivery-2026-07-28 §4 —— SOP §三 的 11 个位置未含此字段，2026-07 才进注册表',
  },
  { id: 'search_terms', label: '后台搜索词', where: '隐藏', weight: 50, weightLabel: '中', front: false, source: 'SOP §三 #4' },
  { id: 'aplus', label: 'A+ 模块标题', where: 'A+ 模块标题', weight: 50, weightLabel: '中', front: false, source: 'SOP §三 #6' },
  { id: 'image_alt', label: '图片 Alt Text', where: '上传图片时', weight: 50, weightLabel: '中', front: false, source: 'SOP §三 #8' },
  { id: 'qa', label: 'Q&A', where: '买家问答区', weight: 50, weightLabel: '中', front: false, source: 'SOP §三 #9' },
  { id: 'variation_parent', label: '变体关系父产品', where: '变体 Tab', weight: 50, weightLabel: '中', front: false, source: 'SOP §三 #10' },
  { id: 'search_terms_recommendations', label: 'Search Terms 推荐', where: '亚马逊后台', weight: 25, weightLabel: '低', front: false, source: 'SOP §三 #11' },
]

export const EMBED_POSITIONS = [...POSITION_LIST].sort((a, b) => b.weight - a.weight)

export const POSITION_BY_ID = Object.fromEntries(EMBED_POSITIONS.map(position => [position.id, position]))

/**
 * Which draft fields each position reads.
 *
 * Two positions have no writable fields on purpose: `variation_parent` and
 * `search_terms_recommendations` are set in Seller Central and cannot be
 * delivered as copy. They stay in the list because a keyword allocated to them
 * is a keyword the operator has to place by hand, and a plan that silently drops
 * those words is a plan that loses them.
 */
export const POSITION_FIELDS = {
  title: ['title'],
  bullets: BULLET_FIELDS,
  description: ['description'],
  attributes: null,
  product_type: ['attribute.item_type'],
  search_terms: ['search_terms'],
  aplus: APLUS_FIELDS,
  image_alt: IMAGE_ALT_FIELDS,
  qa: QA_FIELDS,
  variation_parent: [],
  item_highlights: ['item_highlights'],
  search_terms_recommendations: [],
}

/** Positions that cannot receive copy — the operator places these by hand. */
export const MANUAL_POSITIONS = ['variation_parent', 'search_terms_recommendations']

/** The text of one position, from a draft. */
export function positionText(fields = {}, positionId) {
  const list = POSITION_FIELDS[positionId]
  if (list === null) {
    return Object.entries(fields)
      .filter(([field]) => isAttributeField(field))
      .map(([, value]) => value)
      .join(' ')
  }
  if (list === undefined) return ''
  return list.map(field => fields[field]).filter(Boolean).join(' ')
}

/** Which positions a draft actually writes to. */
export function writtenPositions(fields = {}) {
  return EMBED_POSITIONS
    .filter(position => positionText(fields, position.id).trim() !== '')
    .map(position => position.id)
}

/* ── supporting-slot rules ────────────────────────────────────────────────────
   Each rule says "this kind of keyword also belongs in this position, and here
   is why". `cap` bounds how many keywords one position absorbs, because the
   point of a supporting slot is emphasis — sending every keyword to the
   description would satisfy the letter of "more embedding" and defeat it. */

/**
 * The support rules, written in a site's own lexicon.
 *
 * `when`/`probe` used to close over three module-level English regexes, so a
 * German or Japanese keyword never matched and the `qa.question` /
 * `attributes.spec` / `image_alt.scene` positions came back silently empty on
 * eighteen of the twenty sites. The rules are the same; only the word list is
 * per-site now. `lexiconFor(null)` is the fallback (English, with a caveat), so
 * a caller that genuinely cannot name the site still gets the honest default
 * rather than a silent US assumption.
 *
 * @param {object|null} lexicon from `lexiconFor`
 */
export function supportRulesFor(lexicon = null) {
  const lex = lexicon ?? lexiconFor(null)
  const questionRe = lex.questionRe
  const specRe = lex.specRe
  const sceneRe = lex.sceneRe
  return [
    {
      id: 'description.narrative',
      position: 'description',
      cap: 10,
      when: entry => entry.front === true,
      reason: '描述是用来铺场景的，前端主词在这里自然复现一次能提高语义密度，而不多占标题字符',
    },
    {
      id: 'qa.question',
      position: 'qa',
      cap: 5,
      when: entry => questionRe.test(entry.keyword),
      reason: '问句式的词正好做 Q&A 播种。Alexa 的引用优先级是 Q&A > 五点 > 标题 > 后台词，所以这是回报最高的一处复现',
    },
    {
      id: 'attributes.spec',
      position: 'attributes',
      cap: 40,
      when: entry => specRe.test(entry.keyword),
      /* Measured against the spec *word*, not the whole phrase. An attribute value
         is a value — "Chenille" — so requiring the phrase "chenille throw blanket"
         to appear in a 100-character field asks for something no attribute can
         satisfy. A gap nobody can close is how a reader learns to ignore the gap
         count, which costs more than the cell was worth. */
      probe: keyword => specRe.exec(String(keyword ?? ''))?.[1] ?? null,
      reason: '规格与材质词进属性字段。属性权重 2026 起已超过后台搜索词，且每个填对的属性是 COSMO 知识图谱的一个节点',
    },
    {
      id: 'item_highlights.ai',
      position: 'item_highlights',
      cap: 4,
      when: entry => entry.tier === 'T1' || entry.tier === 'T2',
      reason: '产品亮点是 Alexa for Shopping 的检索入口，只有最高优先级的词值得占它的 125 字符',
    },
    {
      id: 'image_alt.scene',
      position: 'image_alt',
      cap: 4,
      when: entry => sceneRe.test(entry.keyword),
      reason: '场景词写进图片 Alt Text —— 图片是 AI 检索的另一条入口，Alt Text 是唯一能被读到的图片文本',
    },
    {
      id: 'aplus.module',
      position: 'aplus',
      cap: 6,
      when: entry => entry.tier === 'T1',
      reason: 'A+ 模块标题是 SOP 列的埋词位置之一，但要求「不重复前台」，所以只放最核心的词做标题',
    },
  ]
}

/** The English default, kept as an export for callers that predate the lexicon. */
export const SUPPORT_RULES = supportRulesFor(lexiconFor('US'))

/** Owner position for each plan position the embedding plan produces. */
const OWNER_BY_PLAN = { title: 'title', bullets: 'bullets', search_terms: 'search_terms' }

/** The title rule: no word may appear more than twice. Mirrors `title.word.repeat`. */
export const TITLE_WORD_REPEAT_LIMIT = 2

/**
 * Which of these keyword phrases can share the title.
 *
 * The plan used to hand the title as many keywords as the tiers produced — six in
 * one measured case, four after the tier fix — and no title can hold them. The
 * binding constraint is not the character budget, it is the repetition rule: any
 * word may appear at most twice, and product keywords almost always share their
 * head noun. For a throw blanket, six of seven keywords contained "blanket", so
 * two of them exhaust the word and the rest cannot be written at all.
 *
 * A plan the copy cannot satisfy is worse than no plan: the fill rate it reports
 * is then measuring the plan's own error rather than the copy, which teaches the
 * reader to ignore the number.
 *
 * Greedy by rank — the strongest claim on the title is the best-ranked one, so it
 * is considered first and later phrases give way to it. The rejected ones are
 * returned rather than dropped so the report can say where they went and why.
 *
 * ## When the rule does not apply
 *
 * The rule is about *space-separated words*. Japanese is written without spaces,
 * so the English tokeniser returns `[]` for a Japanese title and the loop below
 * would keep every phrase while looking like it had applied a rule — a pass that
 * never ran, which is worse than no rule. On a site whose lexicon says
 * `repeatApplicable === false`, this therefore **declines the rule out loud**:
 * it returns `applicable: false`, keeps every phrase, and carries the `note` the
 * report prints (「本站点不做单词重复约束…」). `limit` is `null` — not `2` — so
 * nothing downstream can mistake a declined rule for an applied one.
 *
 * @param {Array<{keyword: string, rank?: number}>} phrases
 * @param {number} limit
 * @param {object|null} lexicon from `lexiconFor`
 */
export function titleCapacity(phrases, limit = TITLE_WORD_REPEAT_LIMIT, lexicon = null) {
  const lex = lexicon ?? lexiconFor('US')
  if (lex.repeatApplicable === false) {
    return {
      applicable: false,
      limit: null,
      kept: [...phrases],
      rejected: [],
      note: `本站点不做单词重复约束 —— ${lex.repeatReason ?? '该站点的关键词没有空格分词，单词级重复规则不适用'}`,
    }
  }
  const kept = []
  const rejected = []
  const counts = new Map()
  const byRank = [...phrases].sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  )
  for (const phrase of byRank) {
    const next = new Map(counts)
    for (const word of wordsOf(phrase.keyword, lex)) next.set(word, (next.get(word) ?? 0) + 1)
    if ([...next.values()].some(value => value > limit)) {
      rejected.push(phrase)
      continue
    }
    counts.clear()
    for (const [word, value] of next) counts.set(word, value)
    kept.push(phrase)
  }
  return { applicable: true, limit, kept, rejected, note: null }
}

/** Tokens of `text` in the site's own lexicon. English by default. */
function wordsOf(text, lexicon) {
  const lex = lexicon ?? lexiconFor('US')
  return lex.tokenize(text)
}

/**
 * Which visible position already carries this keyword, or null.
 *
 * The three checks are ordered by where a word is cheapest to keep, and they are
 * separate texts rather than the concatenated one because the answer is used as
 * an *owner* — "the title already has it" and "the bullets already have it" are
 * different statements, and a word reported as owned by the bullets when it is
 * actually in the description is a claim the reader can disprove by looking.
 */
function visibleOwnerOf(keyword, visible) {
  if (visible.title !== '' && keywordInText(keyword, visible.title)) return 'title'
  if (visible.bullets !== '' && keywordInText(keyword, visible.bullets)) return 'bullets'
  if (visible.description !== '' && keywordInText(keyword, visible.description)) return 'description'
  return null
}

/**
 * Allocate every keyword to one owner and zero or more justified supporting slots.
 *
 * `embedding` is the tier→position plan from `embedding.js`; passing it in keeps
 * the tier judgement in one place instead of re-deriving it here.
 *
 * `marketplace` decides the keyword lexicon — which words count as questions,
 * specs and scenes, and whether the title's word-repeat rule applies at all. A
 * caller that omits it gets the fallback lexicon (English, with the caveat the
 * report prints), never a silent US assumption.
 */
export function buildKeywordAllocation({ keywords = [], listing = null, fields = {}, embedding = null, marketplace = null } = {}) {
  const lex = lexiconFor(marketplace)
  const supportRules = supportRulesFor(lex)
  const plan = embedding ?? buildEmbeddingPlan({ keywords, listing })
  /* `listingText` for a stored row ({ title, bullets[] }), `frontText` for a draft
     ({ title, bullet_1 … }). Handing a listing row to `frontText` would cover only
     the title and description and report every bullet keyword as missing — the
     same trap step 4 hit once already. */
  const currentText = listing === null ? '' : listingText(listing)
  const draftText = frontText(fields)
  const supportUsed = new Map()

  /* The visible copy, split by position, for the re-owning below. A draft wins
     over the live listing when both exist: the draft is what is being judged. */
  const draftBullets = Object.entries(fields)
    .filter(([key]) => key.startsWith('bullet_'))
    .sort((a, b) => Number(a[0].slice(7)) - Number(b[0].slice(7)))
    .map(([, value]) => value)
    .join(' ')
  const visible = draftText === ''
    ? {
      title: String(listing?.title ?? ''),
      bullets: Array.isArray(listing?.bullets) ? listing.bullets.join(' ') : '',
      description: String(listing?.description ?? ''),
    }
    : {
      title: String(fields.title ?? ''),
      bullets: draftBullets,
      description: String(fields.description ?? ''),
    }

  /* Pass 1 — who would own each keyword, before the title capacity is applied. */
  const decisions = plan.entries.map(entry => {
    let owner = OWNER_BY_PLAN[entry.position] ?? 'search_terms'
    let ownerReason = entry.reason

    /* A word that is already visible must not be sent to the backend.
       The third invariant forbids repeating a visible term in `search_terms`
       (the front end already indexes it, so the bytes buy nothing), which means
       an allocator that sends it there and then flags it is arguing with itself:
       one line of the report says "put it in the backend", the next says "do not".
       The reader cannot satisfy both.
       The fix is not to drop the invariant but to re-own the word to the front
       position that actually carries it — which is where it belongs anyway. The
       job for an already-visible keyword is to *keep* it, not to move it. */
    if (owner === 'search_terms') {
      const alreadyVisible = visibleOwnerOf(entry.keyword, visible)
      if (alreadyVisible !== null) {
        owner = alreadyVisible
        ownerReason = `前端文案里已经有这个词，主人是它现在所在的位置 —— 不需要动它，也不要再写进后台词（前台已索引，后台重复只是白占字节）`
      }
    }
    return { entry, owner, ownerReason }
  })

  /* Pass 2 — the title's claims are settled by the repetition rule, not by the
     tiers. Whatever does not fit moves to the bullets, which is a real position
     with its own budget, not a consolation prize. */
  const capacity = titleCapacity(
    decisions.filter(decision => decision.owner === 'title').map(decision => ({ keyword: decision.entry.keyword, rank: decision.entry.rank })),
    TITLE_WORD_REPEAT_LIMIT,
    lex,
  )
  const keepsTitle = new Set(capacity.kept.map(item => item.keyword))
  for (const decision of decisions) {
    if (decision.owner !== 'title' || keepsTitle.has(decision.entry.keyword)) continue
    decision.owner = 'bullets'
    decision.ownerReason = `${decision.entry.reason}　→ 改放五点：标题里同一个词最多出现 ${capacity.limit} 次，这个词组和排名更好的词共用核心词，位置让给它`
  }

  /* Pass 3 — supporting slots and the final entry shape. */
  const entries = decisions.map(({ entry, owner, ownerReason }) => {
    const supporting = []
    for (const rule of supportRules) {
      if (rule.position === owner) continue
      const used = supportUsed.get(rule.position) ?? 0
      if (used >= rule.cap) continue
      if (!rule.when(entry)) continue
      supportUsed.set(rule.position, used + 1)
      supporting.push({
        position: rule.position,
        positionLabel: POSITION_BY_ID[rule.position]?.label ?? rule.position,
        ruleId: rule.id,
        /* What the coverage matrix looks for in this position. Defaults to the
           whole keyword; a rule that targets a *token* overrides it. */
        probe: rule.probe ? (rule.probe(entry.keyword) ?? entry.keyword) : entry.keyword,
        reason: rule.reason,
      })
    }
    return {
      keyword: entry.keyword,
      tier: entry.tier,
      tierLabel: entry.tierLabel,
      rank: entry.rank,
      owner,
      ownerLabel: POSITION_BY_ID[owner]?.label ?? owner,
      ownerReason,
      supporting,
      /** Positions the word should end up in, owner first. */
      targets: [owner, ...supporting.map(item => item.position)],
      inListingNow: currentText === '' ? false : keywordInText(entry.keyword, currentText),
      inDraft: draftText === '' ? false : keywordInText(entry.keyword, draftText),
    }
  })

  /* The hub's third invariant: a backend term that repeats a visible term
     verbatim buys nothing, because the front end already indexes it. Checked
     against the draft when there is one, otherwise against what is live. */
  const violations = []
  const visibleText = draftText !== '' ? draftText : currentText
  /* Checked against the *backend text the draft actually carries*, not against
     the owner above. Keying it to the owner made it unreachable: a visible word
     is re-owned to the front a few lines earlier, so `owner === 'search_terms'`
     never held for the exact case the invariant exists to catch — a word the
     writer put in the backend even though the front end already indexes it.
     Ownership is a plan; the bytes are spent by what is in the field. */
  const backendText = String(fields.search_terms ?? '')
  for (const entry of entries) {
    if (backendText === '' || !keywordInText(entry.keyword, backendText)) continue
    if (visibleText === '' || !keywordInText(entry.keyword, visibleText)) continue
    violations.push({
      id: 'backend.exact.duplicate',
      keyword: entry.keyword,
      detail: `「${entry.keyword}」在前端可见文案里已经有了，放进后台词等于白占字节`,
    })
  }
  for (const entry of entries) {
    if (entry.targets.length === 0) {
      violations.push({ id: 'allocation.no.owner', keyword: entry.keyword, detail: `「${entry.keyword}」没有被分到任何位置` })
    }
  }

  const byOwner = {}
  for (const entry of entries) {
    if (!byOwner[entry.owner]) byOwner[entry.owner] = []
    byOwner[entry.owner].push(entry.keyword)
  }

  return {
    entries,
    byOwner,
    violations,
    /** Which word list the support rules and the title rule were written in. */
    lexicon: { code: lex.code, tier: lex.tier, authored: lex.authored, note: lex.note },
    /** How the title's claims were settled, so the report can explain the spill. */
    titleCapacity: {
      applicable: capacity.applicable,
      limit: capacity.limit,
      kept: capacity.kept.map(item => item.keyword),
      rejected: capacity.rejected.map(item => item.keyword),
      note: capacity.note,
    },
    summary: {
      total: entries.length,
      owned: entries.filter(entry => entry.targets.length > 0).length,
      supported: entries.filter(entry => entry.supporting.length > 0).length,
      backendOwned: entries.filter(entry => entry.owner === 'search_terms').length,
      alreadyInListing: entries.filter(entry => entry.inListingNow).length,
      inDraft: entries.filter(entry => entry.inDraft).length,
    },
  }
}

/* ── the fact ledger ──────────────────────────────────────────────────────────
   "One value per fact, with a source reference." The failure this prevents is
   the quiet one: the title says 44x19x4, the description says 44 x 19 x 4, and
   an attribute says 40x19x4 — three renderings of one fact, one of them wrong,
   and nothing in the listing says which. */

const DIMENSION_RE = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/g
const WEIGHT_RE = /(\d+(?:\.\d+)?)\s*(lbs?|pounds?|kg|kilograms?|oz|ounces?|g|grams?)\b/gi

/** Facts the listing row carries rather than the copy. */
function rowFacts(listing) {
  if (listing === null || listing === undefined) return []
  const rows = [
    ['brand', '品牌', listing.brand],
    ['asin', 'ASIN', listing.asin],
    ['price', '价格', listing.price === null || listing.price === undefined ? null : `${listing.price} ${listing.currency ?? ''}`.trim()],
    ['bsr', 'BSR', listing.bsr === null || listing.bsr === undefined ? null : String(listing.bsr)],
    /* 同 report.js：评论数没采集时印「— 条」，不印「0 条」——0 条是读数，没取到是缺口。 */
    ['rating', '评分', listing.rating === null || listing.rating === undefined ? null : `${listing.rating}（${listing.reviews ?? '—'} 条）`],
  ]
  return rows
    .filter(([, , value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(([id, label, value]) => ({ id, label, value: String(value).trim(), source: '商品数据（采集）', occurrences: [] }))
}

/**
 * Build the fact ledger for a draft.
 *
 * Only two fact shapes are extracted mechanically — dimensions and weights —
 * because those are the ones that get restated in several fields with different
 * punctuation and then disagree. Everything else in the ledger comes from the
 * listing row or from attributes, where a fact has one home by construction.
 */
export function buildFactLedger({ listing = null, fields = {} } = {}) {
  const facts = new Map()
  const put = (id, label, value, unit, field, raw, source) => {
    const key = `${id}|${String(value).toLowerCase()}`
    if (!facts.has(key)) facts.set(key, { id, label, value, unit, source, occurrences: [] })
    const fact = facts.get(key)
    if (field !== null) fact.occurrences.push({ field, raw })
  }

  for (const fact of rowFacts(listing)) {
    put(fact.id, fact.label, fact.value, null, null, null, fact.source)
  }

  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    const text = String(value)
    for (const match of text.matchAll(DIMENSION_RE)) {
      const triple = `${match[1]}x${match[2]}x${match[3]}`
      put('dimensions', '尺寸（长x宽x高）', triple, null, field, match[0], '文案')
    }
    for (const match of text.matchAll(WEIGHT_RE)) {
      put('weight', '重量', `${match[1]} ${match[2].toLowerCase()}`, null, field, match[0], '文案')
    }
    if (field.startsWith('attribute.')) {
      const id = field.slice('attribute.'.length)
      if (!['product_dimensions', 'size', 'item_weight', 'product_weight'].includes(id)) {
        put(`attribute.${id}`, id, text.trim(), null, field, text, '属性字段')
      }
    }
  }

  /* Group by fact id: more than one distinct value for one fact is the conflict. */
  const byId = new Map()
  for (const fact of facts.values()) {
    if (!byId.has(fact.id)) byId.set(fact.id, [])
    byId.get(fact.id).push(fact)
  }

  const rows = []
  const conflicts = []
  for (const [id, group] of byId) {
    const values = [...new Set(group.map(fact => fact.value))]
    const row = {
      id,
      label: group[0].label,
      value: values[0],
      source: group[0].source,
      occurrences: group.flatMap(fact => fact.occurrences),
      distinctValues: values,
      conflicted: values.length > 1,
    }
    rows.push(row)
    if (row.conflicted) {
      conflicts.push({
        id,
        label: row.label,
        values,
        detail: `同一个事实出现了 ${values.length} 个不同取值: ${values.join(' / ')}。必须统一，否则亚马逊的 AI 审核会按「前后矛盾」处理`,
      })
    }
  }

  return {
    rows: rows.sort((a, b) => a.id.localeCompare(b.id)),
    conflicts,
    summary: {
      total: rows.length,
      conflicted: conflicts.length,
      fromRow: rows.filter(row => row.source !== '文案').length,
      fromCopy: rows.filter(row => row.source === '文案').length,
    },
  }
}

/* ── the compliance matrix ────────────────────────────────────────────────────
   One row per field, with what fired on it. Built from the validation result so
   the matrix and the violation list can never disagree — a matrix computed
   separately from the checks is a second opinion, not a summary. */

export function buildComplianceMatrix({ validation = null, fields = {} } = {}) {
  const rows = []
  const seen = new Set()
  for (const field of Object.keys(fields)) {
    seen.add(field)
    const counts = validation?.byField?.[field] ?? { block: 0, warn: 0 }
    rows.push({
      field,
      block: counts.block ?? 0,
      warn: counts.warn ?? 0,
      ruleIds: (validation?.violations ?? []).filter(violation => violation.field === field).map(violation => violation.ruleId),
    })
  }
  /* Set-scope rules report against 'draft' or 'bullets'; keep them visible rather
     than dropping them for not being a field. */
  for (const violation of validation?.violations ?? []) {
    if (seen.has(violation.field)) continue
    seen.add(violation.field)
    rows.push({ field: violation.field, block: violation.severity === 'block' ? 1 : 0, warn: violation.severity === 'warn' ? 1 : 0, ruleIds: [violation.ruleId] })
  }
  return {
    rows,
    summary: {
      fieldsChecked: rows.length,
      blocked: rows.filter(row => row.block > 0).length,
      warned: rows.filter(row => row.warn > 0).length,
      clean: rows.filter(row => row.block === 0 && row.warn === 0).length,
    },
  }
}

/* ── the linkage matrix ───────────────────────────────────────────────────────
   `delivery-2026-07-28 §2` added `title_item_highlights` as a **mandatory**
   linkage group: the model must plan the title and the Item Highlights together.
   The rest are advisory pairings that exist because the fields restate each
   other, and a change to one is a change to the other. */

export const LINKAGE_GROUPS = [
  {
    id: 'title_item_highlights',
    label: '标题 ↔ 产品亮点',
    fields: ['title', 'item_highlights'],
    mandatory: true,
    why: 'listing_contract 的强制联动组。产品亮点是独立的 AI 检索入口，两者必须一起规划，不能只改标题',
  },
  {
    id: 'front_backend',
    label: '前端 ↔ 后台搜索词',
    fields: ['title', ...BULLET_FIELDS, 'description', 'search_terms'],
    mandatory: true,
    why: '后台词不得与前端可见词重复，两者只能一起决定',
  },
  {
    id: 'title_bullets',
    label: '标题 ↔ 五点',
    fields: ['title', ...BULLET_FIELDS],
    mandatory: false,
    why: '标题放核心词，五点展开卖点，同一批词分工不同',
  },
  {
    id: 'bullets_description',
    label: '五点 ↔ 描述',
    fields: [...BULLET_FIELDS, 'description'],
    mandatory: false,
    why: '描述要在五点之外有增量，不重复短语（§10.2 重复短语降分）',
  },
  {
    id: 'attributes_front',
    label: '属性 ↔ 前端文案',
    fields: ['attribute.item_type', 'attribute.material', 'title', ...BULLET_FIELDS],
    mandatory: false,
    why: '§10.2 要求属性字段必须在标题/五点中验证存在一致性',
  },
  {
    id: 'qa_bullets',
    label: 'Q&A ↔ 五点',
    fields: [...QA_FIELDS, ...BULLET_FIELDS],
    mandatory: false,
    why: 'Q&A 回答的问题应该正是五点里承诺的卖点，两者不一致会被判前后矛盾',
  },
]

export function buildLinkageMatrix({ fields = {} } = {}) {
  const groups = LINKAGE_GROUPS.map(group => {
    const present = group.fields.filter(field => fields[field] !== undefined && String(fields[field]).trim() !== '')
    const missing = group.fields.filter(field => !present.includes(field))
    return {
      id: group.id,
      label: group.label,
      why: group.why,
      mandatory: group.mandatory,
      present,
      missing,
      /** A group with none of its members written is not "incomplete", it is unused. */
      touched: present.length > 0,
      complete: present.length === group.fields.length,
    }
  })
  const broken = groups.filter(group => group.touched && !group.complete)
  return {
    groups,
    broken,
    summary: {
      total: groups.length,
      complete: groups.filter(group => group.complete).length,
      broken: broken.length,
      mandatoryBroken: broken.filter(group => group.mandatory).length,
    },
  }
}

/* ── the coverage matrix ──────────────────────────────────────────────────────
   The hub's worked example prints this as §2.2 埋词覆盖矩阵: keywords down the
   side, positions across the top. It is the single clearest answer to "how many
   places does this word appear", which is the question the user asked. */

/**
 * The coverage matrix: keywords down the side, positions across the top.
 *
 * The hub's worked example prints this as §2.2 埋词覆盖矩阵, and it is the single
 * clearest answer to "how many places does this word appear" — which is the
 * question that started this rewrite.
 *
 * Each row carries **both** halves: where the word actually landed, and where the
 * plan said it should land. Only showing the first is how a word that appears in
 * one position out of four reads as "covered" — true, and the reason nobody
 * noticed the depth was missing.
 */
export function buildCoverageMatrix({ allocation, fields = {} } = {}) {
  const positions = EMBED_POSITIONS.filter(position => POSITION_FIELDS[position.id] === null || POSITION_FIELDS[position.id].length > 0)
  const textCache = new Map(positions.map(position => [position.id, positionText(fields, position.id)]))
  const checkable = new Set(positions.map(position => position.id))

  const rows = (allocation?.entries ?? []).map(entry => {
    const cells = {}
    let total = 0
    /* What to look for in a given position. The owner cell looks for the whole
       keyword; a supporting cell looks for that rule's probe, which for the
       attribute rule is the spec word rather than the phrase. */
    const needleIn = (positionId) => entry.supporting?.find(item => item.position === positionId)?.probe ?? entry.keyword
    for (const position of positions) {
      const text = textCache.get(position.id) ?? ''
      const needle = needleIn(position.id)
      const hit = text !== '' && needle !== null && keywordInText(needle, text)
      cells[position.id] = hit
      if (hit) total += 1
    }
    /* Only the positions a reader could verify count toward the plan — the two
       manual positions cannot be checked from copy, so counting them would show
       a permanent gap nobody can close. */
    const planned = (entry.targets ?? []).filter(target => checkable.has(target))
    const reached = planned.filter(target => cells[target] === true)
    return {
      keyword: entry.keyword,
      tier: entry.tier,
      owner: entry.owner,
      cells,
      total,
      planned,
      plannedCount: planned.length,
      /** Positive means the plan wants more places than the draft uses. */
      gap: Math.max(0, planned.length - reached.length),
    }
  })

  const byPosition = {}
  for (const position of positions) byPosition[position.id] = rows.filter(row => row.cells[position.id]).length

  const totalPlanned = rows.reduce((sum, row) => sum + row.plannedCount, 0)
  const totalReached = rows.reduce((sum, row) => sum + row.planned.filter(target => row.cells[target] === true).length, 0)

  return {
    positions: positions.map(position => ({ id: position.id, label: position.label, weightLabel: position.weightLabel })),
    rows,
    byPosition,
    summary: {
      keywords: rows.length,
      positions: positions.length,
      cellsFilled: rows.reduce((sum, row) => sum + row.total, 0),
      /** The number the user was actually asking about. */
      averagePlaces: rows.length === 0 ? 0 : Number((rows.reduce((sum, row) => sum + row.total, 0) / rows.length).toFixed(2)),
      averagePlanned: rows.length === 0 ? 0 : Number((totalPlanned / rows.length).toFixed(2)),
      plannedCells: totalPlanned,
      reachedCells: totalReached,
      /** How much of the plan the draft has actually delivered.
       *  没有计划（`totalPlanned === 0`）时给 **null**，不给 1。
       *  以前写 `? 1`：一个从没排过位的稿子会显示「完成率 100%」——「没测过」被读成「满分」，
       *  正是本批反复在修的那类错。null 的意思是「这一轮没有可判的分母」。 */
      fillRate: totalPlanned === 0 ? null : Number((totalReached / totalPlanned).toFixed(3)),
      keywordsInNoPosition: rows.filter(row => row.total === 0).length,
      keywordsUnderfilled: rows.filter(row => row.gap > 0).length,
    },
  }
}

/**
 * The whole plan, in the hub's order: allocation, facts, compliance, linkage —
 * plus the coverage matrix, which is the readable form of the first one.
 *
 * `marketplace` is threaded through so the site reaches the support rules and
 * the title rule. It is recorded on the result as `lexicon` so a reader (and the
 * report) can see which word list the plan was actually built with — the plan
 * must never be silently thinner on a site whose lexicon is an approximation.
 */
export function buildGlobalPlan({ keywords = [], listing = null, fields = {}, validation = null, embedding = null, marketplace = null } = {}) {
  const lex = lexiconFor(marketplace)
  const allocation = buildKeywordAllocation({ keywords, listing, fields, embedding, marketplace })
  const factLedger = buildFactLedger({ listing, fields })
  const complianceMatrix = buildComplianceMatrix({ validation, fields })
  const linkageMatrix = buildLinkageMatrix({ fields })
  const coverageMatrix = buildCoverageMatrix({ allocation, fields })

  return {
    version: PLAN_VERSION,
    source: PLAN_SOURCE,
    positions: EMBED_POSITIONS,
    writtenPositions: writtenPositions(fields),
    lexicon: { code: lex.code, tier: lex.tier, authored: lex.authored, note: lex.note, repeatApplicable: lex.repeatApplicable },
    allocation,
    factLedger,
    complianceMatrix,
    linkageMatrix,
    coverageMatrix,
  }
}
