/**
 * The listing rule set, as data.
 *
 * Source of truth: `amazon-ops-hub/04-agents/shared/rules/
 * amazon-listing-comprehensive-rules-2026.md` (v3.0) plus
 * `04-agents/shared/sop/03-optimizer/sop-optimization-v3.0.md`. Every rule
 * carries the section it came from, because the SOP requires each change to say
 * *which rule* it answers to — a violation the reader cannot trace back to a
 * published rule is just an opinion.
 *
 * Two decisions worth stating, because they are what make this usable rather
 * than infuriating:
 *
 *   1. **`block` vs `warn` is not severity theatre.** `block` means Amazon will
 *      reject or de-index the field (over the character limit, a banned
 *      character, a promo word). `warn` means the field is legal but weaker than
 *      it could be (below the recommended length, adjectives doing the work a
 *      number should do). A warn must never be presented as a reason not to
 *      publish.
 *
 *   2. **A blanket substring ban is wrong more often than it is right.** The
 *      rules doc bans "prevent" as a medical claim, and then uses
 *      "prevents rust" as its own example of *good* copy. It bans "perfect",
 *      and its own bullet template is "PERFECT FIT". So: `prevent` is not
 *      banned at all, `perfect` is only counted (never banned), and the fluff
 *      check fires on *density* — three or more filler adjectives — which is
 *      what "凑字数" actually means. Getting this wrong is how a rules engine
 *      teaches people to ignore it.
 *
 * Everything here is deterministic on purpose. Judgement calls the doc also asks
 * for — hallucinated specs, title/description contradiction, whether a bullet
 * answers two real buyer questions — need the model, and are listed in
 * `LLM_ONLY_CHECKS` so the split is explicit rather than accidental.
 */

import { GLOBAL_LIMITS } from './marketplaces.js'
import { APLUS_FIELDS, ATTRIBUTE_WILDCARD, BULLET_FIELDS, IMAGE_ALT_FIELDS, QA_FIELDS } from './listing-fields.js'
import { ATTRIBUTES, attributeCoverage, attributeIdOf, isGenericValue, isPlaceholderValue, specificityExamplesFor } from './attributes.js'
import { lexiconFor } from './lexicon.js'

export const RULES_VERSION = '2026.4'

export const RULES_SOURCE =
  'amazon-listing-comprehensive-rules-2026.md v3.0 + SOP-optimization-v2.1.md + OPTIMIZATION-ENGINE-SPEC.md'

/**
 * Fields a draft can carry.
 *
 * Re-exported from `listing-fields.js` rather than re-listed, so the vocabulary
 * has exactly one definition. Adding a field there must not require remembering
 * to add it here — that is how the first version ended up covering 8 fields out
 * of 11 sections without anyone noticing.
 */
export { BULLET_FIELDS, DRAFT_FIELDS } from './listing-fields.js'

/** Hard limits, in the same units Amazon uses (chars, except backend = bytes). */
export const LIMITS = {
  ...GLOBAL_LIMITS,
  bulletsTotalMax: 1000,
}

/** Categories whose title limit is 80, not 200 (§1.3). */
export const APPAREL_CATEGORIES = ['apparel', 'clothing', 'shoes', 'footwear', 'jewelry', 'watches', 'bags', 'accessories', '服装', '鞋', '珠宝', '箱包']

/* ── word lists ─────────────────────────────────────────────────────────────
   Deliberately narrow. See decision 2 in the header: every phrase here was
   checked against the doc's own good examples before being added. */

const PROMO_WORDS = [
  'best seller', 'bestseller', 'best-selling', 'free shipping', 'free delivery',
  'on sale', 'for sale', 'sale price', 'discount', 'hot item', 'limited time',
  'act now', 'order now', 'buy now', 'shop now', 'money back', 'money-back',
]

const RANKING_WORDS = [
  '#1', 'no.1', 'no 1', 'number 1', 'number one', 'top rated', 'top-rated',
  'best selling', 'best-selling', 'amazon\'s choice', 'amazons choice', 'best on the market',
]

const ABSOLUTE_WORDS = [
  '100% quality', '100% guarantee', 'money back guarantee', 'money-back guarantee',
  'lifetime warranty', 'unconditional guarantee', 'risk free', 'risk-free',
]

/** §12.2 — an unverified environmental claim. Needs a factual replacement. */
const ENVIRONMENTAL_CLAIMS = [
  'eco-friendly', 'eco friendly', 'biodegradable', 'non-toxic', 'non toxic',
  'sustainable', 'carbon neutral', 'planet friendly',
]

/**
 * §12.3 / §12.4 — medical and pesticidal claims, the highest-risk category.
 *
 * `prevent` and `protect` are NOT here. The doc lists them as claim categories,
 * but its own approved example is "prevents rust" and "protect" appears in
 * ordinary copy ("protective padding"). Banning the bare verb would fire on
 * correct writing, so only the unambiguous claim forms are listed.
 */
const MEDICAL_CLAIMS = [
  'cure', 'cures', 'heal', 'heals', 'treat', 'treats', 'diagnose',
  'anti-bacterial', 'antibacterial', 'anti-microbial', 'antimicrobial',
  'anti-viral', 'antiviral', 'germ-killing', 'germ killing', 'mold resistant',
  'mould resistant', 'disinfect', 'sanitize', 'sanitise', 'sterilize',
  'fda approved', 'clinically proven', 'medical grade',
]

const GUARANTEE_WORDS = [
  'full refund', 'money-back guarantee', 'money back guarantee',
  'satisfaction guaranteed', 'guaranteed refund', 'lifetime guarantee',
]

const PLACEHOLDERS = ['n/a', 'na/', 'tbd', 'tba', 'copy pending', 'lorem ipsum', 'todo', 'xxx', 'placeholder', 'coming soon']

/** §3.3 / §2.3 — characters Amazon strips or rejects. */
const FORBIDDEN_TITLE_CHARS = ['!', '$', '?', '_', '{', '}', '^', '¬', '¦', '~']
const FORBIDDEN_BULLET_SYMBOLS = ['™', '®', '©', '€', '£', '¥', '†', '‡', '…', '±', '~', '§']

/** §10.2 — filler adjectives the AI auditor scores as "fluff". Counted, not banned. */
const FLUFF_WORDS = [
  'amazing', 'incredible', 'wonderful', 'awesome', 'fantastic', 'marvelous',
  'unmatched', 'unparalleled', 'world-class', 'world class', 'ultimate',
  'great quality', 'best quality', 'top quality', 'high quality', 'premium quality',
  'perfect quality', 'superior quality', 'amazing quality', 'wonderful comfort',
  'incredible value', 'you will love', 'must have', 'must-have',
]

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F900}-\u{1F9FF}]/u

const ALLOWED_DESCRIPTION_TAGS = ['br', 'b', 'strong', 'p', 'ul', 'ol', 'li']

/**
 * Prose fields: judged by the claim rules, not by the bullet formatting rules.
 *
 * These are the fields a buyer reads as sentences rather than as a labelled
 * fragment. None of them is a bullet, so none of the bullet rules apply — but
 * every claim rule does, and a promo word is just as banned in an A+ module as
 * in a bullet. Declaring the set once means the claim rules are written once;
 * written four times they would be fixed three times.
 */
const PROSE_FIELDS = ['item_highlights', 'brand_story', 'video_script', ...APLUS_FIELDS, ...QA_FIELDS]

/** Marker that a Q&A value carries its question half. */
const QA_QUESTION_RE = /(?:^|\n)\s*Q\s*[:：]/i
/** Marker that a Q&A value carries its answer half. */
const QA_ANSWER_RE = /(?:^|\n)\s*A\s*[:：]/i

/* ── matching helpers ─────────────────────────────────────────────────────── */

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whole-phrase match that works for phrases starting with a non-word character.
 *
 * `\b#1\b` never matches: `#` is not a word character, so there is no word
 * boundary before it. The same trap as the keyword matcher in step 3, so the
 * same fix — assert the neighbours are not alphanumeric.
 */
export function phraseMatches(haystack, phrase) {
  const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(phrase)}(?![a-z0-9])`, 'gi')
  return [...String(haystack ?? '').matchAll(pattern)].map(match => match[0])
}

/**
 * All phrases from `list` that appear in `haystack`, without double-counting.
 *
 * Longer phrases win. "amazing quality, wonderful comfort" is two pieces of
 * filler, not four, but `amazing` and `amazing quality` both match it — and a
 * fluff count that inflates itself would fire the density rule on copy that is
 * fine. The same overlap exists for promo words ("best seller" vs "seller").
 */
function findPhrases(haystack, list) {
  const ordered = [...list].sort((a, b) => b.length - a.length)
  const claimed = []
  const hits = []
  for (const phrase of ordered) {
    if (claimed.some(longer => longer.includes(phrase))) continue
    const found = phraseMatches(haystack, phrase)
    if (found.length === 0) continue
    claimed.push(phrase)
    hits.push({ phrase, count: found.length })
  }
  return hits
}

/**
 * Fold a word for duplicate counting: "apples" and "apple" are one word (§3.3).
 *
 * Only a trailing `s` is folded, and only past three characters, so "glass"
 * stays "glass" and "is" stays "is".
 */
export function foldWord(word) {
  const lower = String(word ?? '').toLowerCase()
  if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1)
  return lower
}

/**
 * Word frequency over a title, plural-folded, in the site's own lexicon.
 *
 * The tokeniser is `lexicon.tokenize`, not a regex of this file's own. It used
 * to split on `/[^A-Za-z0-9']+/`, which is the *English* alphabet: a Japanese
 * title produced `[]` and every word-counting rule here silently passed on a
 * site where it never ran. `marketplace` selects the lexicon; omitting it uses
 * the fallback (English), so a caller that cannot name the site keeps today's
 * behaviour rather than guessing a different script.
 *
 * @param {string} text
 * @param {string|null} [marketplace]
 */
export function wordCounts(text, marketplace = null) {
  const counts = new Map()
  for (const raw of lexiconFor(marketplace).tokenize(text)) {
    if (raw.length === 0) continue
    const word = foldWord(raw)
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return counts
}

/* Case-preserving split for the two rules that need it: `title.uppercase.word`
   looks for `^[A-Z]+$`, which a lowercasing tokeniser would erase, and
   `backend.title.repeat` compares surface words. This is deliberately *not* the
   lexicon tokeniser (that one lowercases on purpose) — it is a plain split, kept
   here so the case-sensitive rules have their own, clearly-labelled tool. */
const words = (text) => String(text ?? '').split(/[^A-Za-z0-9']+/).filter(Boolean)

/* ── the rules ────────────────────────────────────────────────────────────── */

/**
 * A rule is `{ id, appliesTo, scope, severity, source, title, check }`.
 *
 *   appliesTo  field names, or 'bullets' / 'draft' for set-scope rules
 *   scope      'field' — checked once per field
 *              'set'   — checked once over the whole draft
 *   check(ctx) returns [] when it passes, or a list of messages
 *
 * A rule may also carry an optional `notApplicable(ctx)`. It returns a reason
 * string when the rule **cannot be judged on this site** (the title word-repeat
 * rule on a script whose words this tokeniser cannot split), and null otherwise.
 * A rule that returns a reason is recorded as *skipped*, not as a pass: a silent
 * pass on a rule that never ran is the failure this hook exists to remove.
 *
 * `ctx` = { field, value, fields, bullets, listing, keywords, options }
 */
export const RULES = [
  /* ── title ─────────────────────────────────────────────────────────────── */
  {
    id: 'title.length.max',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'block',
    source: '§1.1 / §1.2 字符限制',
    title: '标题超过字符上限',
    check({ value, options }) {
      const limit = Number.isFinite(options?.maxTitleChars)
        ? options.maxTitleChars
        : (APPAREL_CATEGORIES.includes(String(options?.category ?? '').toLowerCase()) ? LIMITS.titleMaxApparel : LIMITS.titleMax)
      const length = value.length
      if (length <= limit) return []
      return [`${length} 字符，上限 ${limit}${limit === LIMITS.titleMaxApparel ? '（服装/鞋/珠宝类目）' : ''}，超出 ${length - limit}`]
    },
  },
  {
    id: 'title.length.recommended',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'warn',
    source: 'SOP §3.3 建议不超过150',
    title: '标题长于建议值',
    check({ value }) {
      return value.length <= LIMITS.titleRecommended
        ? []
        : [`${value.length} 字符，建议 ≤${LIMITS.titleRecommended}`]
    },
  },
  {
    id: 'title.length.min',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'warn',
    source: 'SOP §3.2 黄金锚点 + 语义扩展',
    title: '标题短于建议值',
    check({ value }) {
      return value.length >= LIMITS.titleMin
        ? []
        : [`${value.length} 字符，建议 ≥${LIMITS.titleMin}（黄金锚点 0–70 + 语义扩展 70–150）`]
    },
  },
  {
    id: 'title.chars.forbidden',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'block',
    source: '§2.3 标题禁止内容',
    title: '标题含禁止字符',
    check({ value }) {
      const found = FORBIDDEN_TITLE_CHARS.filter(char => value.includes(char))
      return found.length === 0 ? [] : [`禁止字符: ${found.join(' ')}`]
    },
  },
  {
    id: 'title.emoji',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'block',
    source: '§2.3 禁止表情符号',
    title: '标题含表情符号',
    check({ value }) {
      const found = [...new Set(String(value).match(EMOJI_RE) ?? [])]
      return found.length === 0 ? [] : [`表情/符号: ${found.join(' ')}`]
    },
  },
  {
    id: 'title.word.repeat',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'block',
    source: '§1.2 / §10.2 同一词最多出现2次',
    title: '标题重复词超限',
    /* The rule is about space-separated Latin words. On a site whose lexicon
       cannot tokenise its own script (CJK, Arabic) the tokeniser returned `[]`
       and the rule looked like it passed when it never ran — a silent pass. This
       declares that up front so the runner records "not applicable" instead of a
       clean result. See `lexicon.js`'s `repeatApplicable`. */
    notApplicable({ options }) {
      const lex = lexiconFor(options?.marketplace)
      if (lex.repeatApplicable !== false) return null
      const reason = lex.repeatReason === null ? '' : ` —— ${lex.repeatReason}`
      return `本站点（${lex.script}）关键词法无法分词，单词级重复约束不适用${reason}`
    },
    check({ value, options }) {
      const over = [...wordCounts(value, options?.marketplace).entries()].filter(([, count]) => count > 2)
      return over.length === 0 ? [] : [`同一词超过2次: ${over.map(([word, count]) => `${word}×${count}`).join(', ')}（单复数视为同一词）`]
    },
  },
  {
    id: 'title.uppercase.word',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'warn',
    source: '§1.2 禁止全大写单词',
    title: '标题含全大写单词',
    check({ value, listing }) {
      const brand = String(listing?.brand ?? '').toUpperCase()
      const found = words(value).filter(word =>
        /* Letters only. "IP67" and "USB3" are spec codes that are legitimately
           upper case — flagging them would fire on most electronics listings and
           teach the reader to skip this rule. */
        /^[A-Z]+$/.test(word)
        && word.length >= 4
        && word !== brand)
      return found.length === 0 ? [] : [`全大写: ${[...new Set(found)].join(' ')}${brand ? `（品牌名 ${brand} 已豁免）` : ''}`]
    },
  },
  {
    id: 'title.promo',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'block',
    source: '§2.3 / §12.1 促销词',
    title: '标题含促销词',
    check({ value }) {
      const hits = findPhrases(value, PROMO_WORDS)
      return hits.length === 0 ? [] : [`促销词: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'title.ranking',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'block',
    source: '§2.3 / §12.1 排名词',
    title: '标题含排名/认证词',
    check({ value }) {
      const hits = findPhrases(value, RANKING_WORDS)
      return hits.length === 0 ? [] : [`排名/认证词: ${hits.map(hit => hit.phrase).join(', ')}（未经授权不得使用）`]
    },
  },
  {
    id: 'title.absolute',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'block',
    source: '§2.3 绝对词',
    title: '标题含绝对承诺词',
    check({ value }) {
      const hits = findPhrases(value, ABSOLUTE_WORDS)
      return hits.length === 0 ? [] : [`绝对承诺: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'title.anchor.first80',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'warn',
    source: 'SOP §3.5 移动端截断检查',
    title: '前80字符没有核心关键词',
    check({ value, keywords }) {
      const priority = topKeywords(keywords, 5)
      if (priority.length === 0) return []
      const window = String(value).slice(0, LIMITS.titleMobileAnchor).toLowerCase()
      const hit = priority.some(entry => phraseMatches(window, entry.keyword).length > 0)
      return hit ? [] : [`前 ${LIMITS.titleMobileAnchor} 字符内没有出现任何核心关键词（候选: ${priority.map(entry => entry.keyword).join(' / ')}）。移动端在这里截断。`]
    },
  },
  {
    id: 'title.brand.prefix',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'warn',
    source: 'SOP §3.2 黄金锚点 = 品牌+品类+核心卖点',
    title: '品牌不在黄金锚点内',
    check({ value, listing }) {
      const brand = String(listing?.brand ?? '').trim()
      if (brand === '') return []
      const window = String(value).slice(0, LIMITS.titleGoldenZone).toLowerCase()
      return window.includes(brand.toLowerCase())
        ? []
        : [`品牌「${brand}」不在前 ${LIMITS.titleGoldenZone} 字符内`]
    },
  },
  {
    id: 'title.ampersand',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'warn',
    source: 'SOP §3.3 用 and 不用 &',
    title: '标题用了 &',
    check({ value }) {
      return value.includes('&') ? ['标题内用 "and" 而不是 "&"'] : []
    },
  },
  {
    id: 'title.number.spelled',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'warn',
    source: '§1.2 / §3.4 使用阿拉伯数字',
    title: '标题用了拼写数字',
    check({ value }) {
      /* 'one' is excluded: "One Size" is standard and would false-fire. */
      const hits = findPhrases(value, ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'])
      return hits.length === 0 ? [] : [`用阿拉伯数字: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },

  /* ── each bullet ───────────────────────────────────────────────────────── */
  {
    id: 'bullet.length.max',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§1.1 / §3.1 每条10-255字符',
    title: '五点超出字符上限',
    check({ value }) {
      return value.length <= LIMITS.bulletMax ? [] : [`${value.length} 字符，上限 ${LIMITS.bulletMax}`]
    },
  },
  {
    id: 'bullet.length.min',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§1.1 / §3.1 每条10-255字符',
    title: '五点短于字符下限',
    check({ value }) {
      return value.length >= LIMITS.bulletMin ? [] : [`${value.length} 字符，下限 ${LIMITS.bulletMin}`]
    },
  },
  {
    id: 'bullet.length.recommended',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'warn',
    source: 'SOP §4.4 推荐 80-200 字符/条',
    title: '五点长度偏离建议区间',
    check({ value }) {
      if (value.length >= LIMITS.bulletRecommendedMin && value.length <= LIMITS.bulletRecommendedMax) return []
      return [`${value.length} 字符，建议 ${LIMITS.bulletRecommendedMin}-${LIMITS.bulletRecommendedMax}`]
    },
  },
  {
    id: 'bullet.label',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'warn',
    source: '§3.1 标题+冒号开头',
    title: '五点没有"标题+冒号"开头',
    check({ value }) {
      return /^[^:：]{2,40}[:：]/.test(String(value).trim())
        ? []
        : ['建议以 "MATERIAL:" 这类「标题+冒号」开头，Alexa 依赖这个结构切分语义']
    },
  },
  {
    id: 'bullet.firstword.upper',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'warn',
    source: '§3.1 首字母大写',
    title: '五点首词未大写',
    check({ value }) {
      const first = words(value)[0]
      if (first === undefined) return []
      return first[0] === first[0].toUpperCase() ? [] : [`首词「${first}」未大写`]
    },
  },
  {
    id: 'bullet.trailing.punctuation',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'warn',
    source: '§3.1 句片段格式，不加句尾标点',
    title: '五点句尾带标点',
    check({ value }) {
      return /[.;]$/.test(String(value).trim()) ? ['句片段格式不应有句尾标点'] : []
    },
  },
  {
    id: 'bullet.symbols',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§3.3 五点禁止内容',
    title: '五点含禁止符号',
    check({ value }) {
      const found = FORBIDDEN_BULLET_SYMBOLS.filter(char => value.includes(char))
      return found.length === 0 ? [] : [`禁止符号: ${found.join(' ')}`]
    },
  },
  {
    id: 'bullet.emoji',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§3.3 五点禁止内容',
    title: '五点含表情符号',
    check({ value }) {
      const found = [...new Set(String(value).match(EMOJI_RE) ?? [])]
      return found.length === 0 ? [] : [`表情/符号: ${found.join(' ')}`]
    },
  },
  {
    id: 'bullet.placeholder',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§3.3 占位符',
    title: '五点含占位符',
    check({ value }) {
      const hits = findPhrases(value, PLACEHOLDERS)
      return hits.length === 0 ? [] : [`占位符: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'bullet.guarantee',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§3.3 保证承诺',
    title: '五点含保证承诺',
    check({ value }) {
      const hits = findPhrases(value, GUARANTEE_WORDS)
      return hits.length === 0 ? [] : [`保证承诺: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'bullet.external',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§3.3 外部引用',
    title: '五点含站外引用',
    check({ value }) {
      const text = String(value)
      const found = []
      if (/https?:\/\/|www\.[a-z0-9-]+\./i.test(text)) found.push('网址')
      if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) found.push('邮箱')
      if (/(?:\+?\d[\d\s().-]{7,}\d)/.test(text)) found.push('电话')
      if (/\b(?:facebook|instagram|twitter|tiktok|youtube|whatsapp)\b/i.test(text)) found.push('社交媒体')
      return found.length === 0 ? [] : [`站外引用: ${found.join(', ')}`]
    },
  },
  {
    id: 'bullet.asin',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§3.3 ASIN引用',
    title: '五点含 ASIN',
    check({ value }) {
      const found = [...new Set(String(value).match(/\bB0[A-Z0-9]{8}\b/gi) ?? [])]
      return found.length === 0 ? [] : [`ASIN 引用: ${found.join(', ')}`]
    },
  },
  {
    id: 'bullet.environmental',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§3.3 / §12.2 未经证实声明',
    title: '五点含未经证实的环保声明',
    check({ value }) {
      const hits = findPhrases(value, ENVIRONMENTAL_CLAIMS)
      return hits.length === 0 ? [] : [`环保声明需事实依据: ${hits.map(hit => hit.phrase).join(', ')}（改为 "Made of 100% organic cotton" 这类可验证表述）`]
    },
  },
  {
    id: 'bullet.medical',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§12.3 / §12.4 医疗与杀虫剂声称',
    title: '五点含医疗/功效声称',
    check({ value }) {
      const hits = findPhrases(value, MEDICAL_CLAIMS)
      return hits.length === 0 ? [] : [`高风险声称: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'bullet.subjective',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§3.3 主观极端',
    title: '五点含主观极端表述',
    check({ value }) {
      const hits = findPhrases(value, RANKING_WORDS.concat(ABSOLUTE_WORDS))
      return hits.length === 0 ? [] : [`主观/绝对表述: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'bullet.promo',
    appliesTo: BULLET_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§12.1 促销词',
    title: '五点含促销词',
    check({ value }) {
      const hits = findPhrases(value, PROMO_WORDS)
      return hits.length === 0 ? [] : [`促销词: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },

  /* ── the bullet set ────────────────────────────────────────────────────── */
  {
    id: 'bullets.count.max',
    appliesTo: ['bullets'],
    scope: 'set',
    severity: 'block',
    source: '§3.1 最多5条',
    title: '五点超过5条',
    check({ bullets }) {
      return bullets.length <= LIMITS.bulletsMax ? [] : [`${bullets.length} 条，超出部分会被删除`]
    },
  },
  {
    id: 'bullets.count.recommended',
    appliesTo: ['bullets'],
    scope: 'set',
    severity: 'warn',
    source: '§3.1 五点结构',
    title: '五点不是5条',
    check({ bullets }) {
      return bullets.length === LIMITS.bulletsMax ? [] : [`当前 ${bullets.length} 条，标准结构是 5 条`]
    },
  },
  {
    id: 'bullets.total.length',
    appliesTo: ['bullets'],
    scope: 'set',
    severity: 'warn',
    source: 'SOP §4.4 总 ≤1000 字符',
    title: '五点总长超建议',
    check({ bullets }) {
      const total = bullets.reduce((sum, bullet) => sum + bullet.length, 0)
      return total <= LIMITS.bulletsTotalMax ? [] : [`总 ${total} 字符，建议 ≤${LIMITS.bulletsTotalMax}`]
    },
  },
  {
    id: 'bullets.opening.repeat',
    appliesTo: ['bullets'],
    scope: 'set',
    severity: 'warn',
    source: '§10.2 自动审核：重复短语',
    title: '多条五点句式重复',
    check({ bullets }) {
      const openings = new Map()
      for (const bullet of bullets) {
        const first = words(bullet)[0]
        if (first === undefined) continue
        const key = first.toLowerCase()
        openings.set(key, (openings.get(key) ?? 0) + 1)
      }
      const repeated = [...openings.entries()].filter(([, count]) => count > 1)
      return repeated.length === 0
        ? []
        : [`${repeated.map(([word, count]) => `「${word}」开头 ×${count}`).join(', ')}。AI 审核把相同句式判为重复短语，每条换一种句式。`]
    },
  },
  {
    id: 'bullets.fluff',
    appliesTo: ['bullets'],
    scope: 'set',
    severity: 'warn',
    source: '§10.2 / §12.5 凑字数 Fluff',
    title: '五点形容词空话偏多',
    check({ bullets }) {
      /* Density, not a single hit: the doc's own template says "PERFECT FIT". */
      const text = bullets.join(' ')
      const hits = findPhrases(text, FLUFF_WORDS)
      if (hits.length < 3) return []
      return [`${hits.length} 个无信息量形容词: ${hits.map(hit => hit.phrase).join(', ')}。AI 审核标记为 fluff，改用名词短语+具体参数。`]
    },
  },
  {
    id: 'bullets.duplicate',
    appliesTo: ['bullets'],
    scope: 'set',
    severity: 'block',
    source: '§10.2 重复短语 / §3.1 五点结构',
    title: '有五点内容完全重复',
    check({ bullets }) {
      const seen = new Map()
      for (const [index, bullet] of bullets.entries()) {
        const key = bullet.trim().toLowerCase().replace(/\s+/g, ' ')
        if (!seen.has(key)) { seen.set(key, index + 1); continue }
        return [`第 ${seen.get(key)} 条和第 ${index + 1} 条内容完全相同。重复的卖点占掉了整条的位置，而且会被审核判为凑数。`]
      }
      return []
    },
  },
  {
    id: 'bullets.digits',
    appliesTo: ['bullets'],
    scope: 'set',
    severity: 'warn',
    source: 'SOP §4.5 参数数字 ≥2个/条',
    title: '五点缺具体数字',
    check({ bullets }) {
      const digits = (bullets.join(' ').match(/\d/g) ?? []).length
      const wanted = bullets.length * 2
      return digits >= wanted ? [] : [`全文只有 ${digits} 个数字字符，建议每条 ≥2 个具体参数（约 ${wanted} 个）。具体数字是 Alexa 判断"事实密度"的依据。`]
    },
  },

  /* ── description ───────────────────────────────────────────────────────── */
  {
    id: 'description.length.max',
    appliesTo: ['description'],
    scope: 'field',
    severity: 'block',
    source: '§1.1 / §4.1 描述 ≤2000 字符',
    title: '描述超长',
    check({ value }) {
      return value.length <= LIMITS.descriptionMax ? [] : [`${value.length} 字符，上限 ${LIMITS.descriptionMax}`]
    },
  },
  {
    id: 'description.length.recommended',
    appliesTo: ['description'],
    scope: 'field',
    severity: 'warn',
    source: 'OPTIMIZATION-ENGINE-SPEC 描述优化要求',
    title: '描述偏短',
    check({ value }) {
      return value.length >= LIMITS.descriptionRecommendedMin
        ? []
        : [`${value.length} 字符，建议 ≥${LIMITS.descriptionRecommendedMin}（上限 2000，尽量用满）`]
    },
  },
  {
    id: 'description.repeat.phrase',
    appliesTo: ['description'],
    scope: 'field',
    severity: 'warn',
    source: '§11.1 描述：无重复短语',
    title: '描述里有重复句子',
    check({ value }) {
      /* The checklist calls this out explicitly for the description, and it is
         the failure mode of padding to reach 2000 characters: the same sentence
         pasted until the field is full. Counting sentences is enough — a repeated
         six-word phrase inside otherwise different sentences is normal writing. */
      const sentences = String(value)
        .split(/[.!?\n]+/)
        .map(sentence => sentence.trim().toLowerCase().replace(/\s+/g, ' '))
        .filter(sentence => sentence.split(' ').length >= 4)
      const counts = new Map()
      for (const sentence of sentences) counts.set(sentence, (counts.get(sentence) ?? 0) + 1)
      const repeated = [...counts.entries()].filter(([, count]) => count > 1)
      if (repeated.length === 0) return []
      const worst = repeated.sort((a, b) => b[1] - a[1])[0]
      return [`${repeated.length} 个句子重复出现，最多的一句出现了 ${worst[1]} 次：「${worst[0].slice(0, 60)}…」。这是凑字数的典型形态。`]
    },
  },
  {
    id: 'description.html.allowed',
    appliesTo: ['description'],
    scope: 'field',
    severity: 'block',
    source: '§4.2 允许的HTML标签',
    title: '描述含不允许的标签',
    check({ value }) {
      const found = [...new Set([...String(value).matchAll(/<\s*\/?\s*([a-z][a-z0-9]*)/gi)].map(match => match[1].toLowerCase()))]
      const bad = found.filter(tag => !ALLOWED_DESCRIPTION_TAGS.includes(tag))
      return bad.length === 0 ? [] : [`不支持的标签: ${bad.map(tag => `<${tag}>`).join(', ')}（只允许 ${ALLOWED_DESCRIPTION_TAGS.map(tag => `<${tag}>`).join(' ')}）`]
    },
  },

  /* ── backend search terms ──────────────────────────────────────────────── */
  {
    id: 'backend.bytes.max',
    appliesTo: ['search_terms'],
    scope: 'field',
    severity: 'block',
    source: '§5.1 / §12 后台搜索词 ≤249 字节',
    title: '后台词超过字节上限',
    check({ value }) {
      /* Bytes, not characters. A Chinese character is 3 bytes and a Latin one is
       1, so a 249-character limit would silently allow a 700-byte field. */
      const bytes = Buffer.byteLength(value, 'utf8')
      return bytes <= LIMITS.backendMaxBytes ? [] : [`${bytes} 字节（${value.length} 字符），上限 ${LIMITS.backendMaxBytes} 字节。超出可能导致整个字段不被索引。`]
    },
  },
  {
    id: 'backend.comma',
    appliesTo: ['search_terms'],
    scope: 'field',
    severity: 'warn',
    source: '§5.2 用空格分隔，无需逗号',
    title: '后台词用了逗号',
    check({ value }) {
      return String(value).includes(',') ? ['用空格分隔，不用逗号（逗号会占用字节且不参与索引）'] : []
    },
  },
  {
    id: 'backend.promo',
    appliesTo: ['search_terms'],
    scope: 'field',
    severity: 'block',
    source: '§5.3 后台词禁止内容',
    title: '后台词含促销词',
    check({ value }) {
      const hits = findPhrases(value, PROMO_WORDS)
      return hits.length === 0 ? [] : [`促销词: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'backend.subjective',
    appliesTo: ['search_terms'],
    scope: 'field',
    severity: 'block',
    source: '§5.3 subjective claims',
    title: '后台词含主观词',
    check({ value }) {
      const hits = findPhrases(value, ['amazing', 'great', 'best', 'cheap', 'top'])
      return hits.length === 0 ? [] : [`主观词不参与索引: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'backend.asin',
    appliesTo: ['search_terms'],
    scope: 'field',
    severity: 'block',
    source: '§5.3 无意义字符',
    title: '后台词含 ASIN',
    check({ value }) {
      const found = [...new Set(String(value).match(/\bB0[A-Z0-9]{8}\b/gi) ?? [])]
      return found.length === 0 ? [] : [`ASIN 不参与索引: ${found.join(', ')}`]
    },
  },
  {
    id: 'backend.duplicate',
    appliesTo: ['search_terms'],
    scope: 'field',
    severity: 'warn',
    source: '§5.2 / §6.1 不浪费字节',
    title: '后台词自我重复',
    check({ value, options }) {
      const counts = wordCounts(value, options?.marketplace)
      const repeated = [...counts.entries()].filter(([, count]) => count > 1)
      return repeated.length === 0
        ? []
        : [`重复词浪费字节: ${repeated.map(([word, count]) => `${word}×${count}`).join(', ')}`]
    },
  },
  {
    id: 'backend.title.repeat',
    appliesTo: ['search_terms'],
    scope: 'field',
    severity: 'warn',
    source: '§6.1 禁止重复标题关键词',
    title: '后台词重复了前端词',
    check({ value, fields }) {
      const front = [fields.title, fields.description, ...(Object.entries(fields).filter(([key]) => key.startsWith('bullet_')).map(([, text]) => text))].filter(Boolean).join(' ')
      if (front === '') return []
      const frontWords = new Set(words(front).map(foldWord))
      const wasted = [...new Set(words(value).map(foldWord))].filter(word => frontWords.has(word) && word.length > 2)
      return wasted.length === 0
        ? []
        : [`这些词前端已有，后台再写一遍等于白占字节: ${wasted.slice(0, 15).join(', ')}${wasted.length > 15 ? ` …共 ${wasted.length}` : ''}`]
    },
  },

  /* ── item highlights — the Alexa for Shopping surface ──────────────────────
     Added to the registry 2026-07-28, and the field most likely to be blank,
     because it did not exist when most listings were written. It is the one
     place where being terse beats being complete: 125 characters, every one of
     them a noun phrase, because an answer engine reads this field when it
     composes a recommendation. */
  {
    id: 'item_highlights.length.max',
    appliesTo: ['item_highlights'],
    scope: 'field',
    severity: 'block',
    source: 'delivery-2026-07-28 §4（2026-07-27 起非媒体类目 ≤125 字符）',
    title: '产品亮点超过字符上限',
    check({ value, options }) {
      const limit = Number.isFinite(options?.maxHighlightsChars) ? options.maxHighlightsChars : LIMITS.itemHighlightsMax
      return value.length <= limit ? [] : [`${value.length} 字符，上限 ${limit}，超出 ${value.length - limit}`]
    },
  },
  {
    id: 'item_highlights.length.min',
    appliesTo: ['item_highlights'],
    scope: 'field',
    severity: 'warn',
    source: 'delivery-2026-07-28 §4',
    title: '产品亮点太短，没占满 AI 入口',
    check({ value }) {
      return value.length >= LIMITS.itemHighlightsRecommendedMin
        ? []
        : [`${value.length} 字符，建议 ≥${LIMITS.itemHighlightsRecommendedMin}。上限 ${LIMITS.itemHighlightsMax}，不必留空`]
    },
  },
  {
    id: 'item_highlights.title.duplicate',
    appliesTo: ['item_highlights'],
    scope: 'field',
    severity: 'warn',
    source: '§9.3.2 NPO + 独立 AI 检索入口',
    title: '产品亮点只是把标题抄了一遍',
    check({ value, fields }) {
      const title = String(fields.title ?? '').trim()
      if (title === '') return []
      const titleWords = new Set(words(title).map(foldWord))
      const own = words(value).map(foldWord)
      if (own.length === 0 || titleWords.size === 0) return []
      const shared = own.filter(word => titleWords.has(word)).length
      const ratio = shared / own.length
      return ratio < 0.9
        ? []
        : [`与标题重复度 ${Math.round(ratio * 100)}%。产品亮点是独立的 AI 检索入口，重复标题等于少一个入口`]
    },
  },

  /* ── claims, across every prose field ───────────────────────────────────── */
  {
    id: 'prose.promo',
    appliesTo: PROSE_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§2.3 / §3.3 促销词禁止（全字段适用）',
    title: '文案含促销词',
    check({ value }) {
      const hits = findPhrases(value, PROMO_WORDS)
      return hits.length === 0 ? [] : [`促销词: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'prose.absolute',
    appliesTo: PROSE_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§2.3 绝对词禁止',
    title: '文案含绝对词',
    check({ value }) {
      const hits = findPhrases(value, ABSOLUTE_WORDS)
      return hits.length === 0 ? [] : [`绝对词: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'prose.medical',
    appliesTo: PROSE_FIELDS,
    scope: 'field',
    severity: 'block',
    source: '§12.3 / §12.4 医疗与杀虫声称',
    title: '文案含医疗/杀虫声称',
    check({ value }) {
      const hits = findPhrases(value, MEDICAL_CLAIMS)
      return hits.length === 0 ? [] : [`高风险声称: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'prose.environmental',
    appliesTo: PROSE_FIELDS,
    scope: 'field',
    severity: 'warn',
    source: '§12.2 环保声称需可证',
    title: '文案含环保声称',
    check({ value }) {
      const hits = findPhrases(value, ENVIRONMENTAL_CLAIMS)
      return hits.length === 0 ? [] : [`环保声称需要可证依据: ${hits.map(hit => hit.phrase).join(', ')}`]
    },
  },
  {
    id: 'prose.fluff',
    appliesTo: ['draft'],
    scope: 'set',
    severity: 'warn',
    source: '§9.3.2 NPO / §10.2 凑字数',
    title: '文案形容词堆砌（NPO）',
    check({ fields }) {
      const text = PROSE_FIELDS.map(field => fields[field]).filter(Boolean).join(' ')
      if (text === '') return []
      const hits = findPhrases(text, FLUFF_WORDS)
      const total = hits.reduce((sum, hit) => sum + hit.count, 0)
      if (total < 3) return []
      return [`${total} 处无信息量形容词: ${hits.map(hit => `${hit.phrase}×${hit.count}`).join(', ')}。AI 审核会标为 fluff，改用名词短语（"70D high-density foam core"）`]
    },
  },

  /* ── A+ ─────────────────────────────────────────────────────────────────── */
  {
    id: 'aplus.module.count',
    appliesTo: ['draft'],
    scope: 'set',
    severity: 'warn',
    source: 'OPTIMIZATION-ENGINE-SPEC「A+ 5 模块建议」/ 范例 §8.1（6 个）',
    title: 'A+ 模块数量不足',
    check({ fields }) {
      const present = APLUS_FIELDS.filter(field => fields[field] !== undefined && String(fields[field]).trim() !== '')
      if (present.length === 0) return []
      return present.length >= LIMITS.aplusModules
        ? []
        : [`${present.length} 个模块，引擎规格要求 ≥${LIMITS.aplusModules}（品牌故事/核心卖点/对比/场景/参数）`]
    },
  },
  {
    id: 'aplus.front.repeat',
    appliesTo: ['draft'],
    scope: 'set',
    severity: 'warn',
    source: '范例 §8.2「不重复前台 Bullets（要有增量）」',
    title: 'A+ 文案重复了前台五点',
    check({ fields }) {
      const front = [fields.title, fields.description, ...BULLET_FIELDS.map(field => fields[field])].filter(Boolean).join(' ')
      if (front === '') return []
      const frontWords = new Set(words(front).map(foldWord))
      const offenders = []
      for (const field of APLUS_FIELDS) {
        const value = fields[field]
        if (value === undefined) continue
        const list = words(value).map(foldWord)
        if (list.length < 8) continue
        const shared = list.filter(word => frontWords.has(word) && word.length > 3).length
        if (shared / list.length > 0.8) offenders.push(field)
      }
      return offenders.length === 0
        ? []
        : [`这些 A+ 模块与前台高度重复，A+ 要有增量: ${offenders.join(', ')}`]
    },
  },

  /* ── Q&A — the highest-priority source for Alexa for Shopping ──────────────
     SOP §八 puts the citation order as Q&A > 五点 > 标题 > 后台搜索词. So this is
     not a nice-to-have section; it is the field the answer engine quotes first,
     and the one where a vague answer is worse than no answer. */
  {
    id: 'qa.count',
    appliesTo: ['draft'],
    scope: 'set',
    severity: 'warn',
    source: 'SOP §八（至少5对）/ 范例 §9.1（8个）',
    title: 'Q&A 对数不足',
    check({ fields }) {
      const present = QA_FIELDS.filter(field => fields[field] !== undefined && String(fields[field]).trim() !== '')
      if (present.length === 0) return []
      return present.length >= LIMITS.qaMin
        ? []
        : [`${present.length} 对，SOP 要求 ≥${LIMITS.qaMin}（范例做到 ${LIMITS.qaRecommended}）`]
    },
  },
  {
    id: 'qa.shape',
    appliesTo: QA_FIELDS,
    scope: 'field',
    severity: 'warn',
    source: 'SOP §八 QA 结构（Q + A）',
    title: 'Q&A 缺问或缺答',
    check({ value }) {
      const hasQuestion = QA_QUESTION_RE.test(value)
      const hasAnswer = QA_ANSWER_RE.test(value)
      if (hasQuestion && hasAnswer) return []
      if (!hasQuestion && !hasAnswer) return ['既没有 Q 也没有 A。格式：Q: 问题 / 换行 / A: 回答']
      return [hasQuestion ? '只有问题没有回答' : '只有回答没有问题']
    },
  },
  {
    id: 'qa.specific',
    appliesTo: QA_FIELDS,
    scope: 'field',
    severity: 'warn',
    source: 'SOP §八「具体参数化：必须包含具体数字/尺寸」',
    title: 'Q&A 回答没有具体参数',
    check({ value }) {
      const answer = String(value).split(QA_ANSWER_RE)[1] ?? ''
      if (answer.trim() === '') return []
      return /\d/.test(answer)
        ? []
        : ['回答里没有数字/尺寸。Alexa 引用 Q&A 回答买家问题时，带参数的答案才被采信']
    },
  },

  /* ── image alt text ─────────────────────────────────────────────────────── */
  {
    id: 'image_alt.length.max',
    appliesTo: IMAGE_ALT_FIELDS,
    scope: 'field',
    severity: 'warn',
    source: '§6.3 图片SEO（面向AI）',
    title: 'Alt Text 过长',
    check({ value }) {
      return value.length <= LIMITS.imageAltMax ? [] : [`${value.length} 字符，建议 ≤${LIMITS.imageAltMax}`]
    },
  },
  {
    id: 'image_alt.generic',
    appliesTo: IMAGE_ALT_FIELDS,
    scope: 'field',
    severity: 'warn',
    source: '§6.3 / §9.4 差例「product image 1」',
    title: 'Alt Text 是占位式描述',
    check({ value }) {
      const text = String(value).trim().toLowerCase()
      const placeholder = /^(product\s*)?(image|photo|picture|img)\s*\d*$/.test(text)
        || /^(product|item)\s+(image|photo|picture)\s*\d*$/.test(text)
      return placeholder
        ? ['这是占位式描述。要写成能读出场景与动作的句子，如 "Woman making green smoothie with high-speed blender"']
        : []
    },
  },
  {
    id: 'image_alt.count',
    appliesTo: ['draft'],
    scope: 'set',
    severity: 'warn',
    source: '范例 §7.3（主图 + 副图逐张给 Alt Text）',
    title: 'Alt Text 覆盖的图片不足',
    check({ fields }) {
      const present = IMAGE_ALT_FIELDS.filter(field => fields[field] !== undefined && String(fields[field]).trim() !== '')
      if (present.length === 0) return []
      return present.length >= IMAGE_ALT_FIELDS.length
        ? []
        : [`${present.length}/${IMAGE_ALT_FIELDS.length} 张有 Alt Text`]
    },
  },

  /* ── brand story ────────────────────────────────────────────────────────── */
  {
    id: 'brand_story.three.things',
    appliesTo: ['brand_story'],
    scope: 'field',
    severity: 'warn',
    source: 'SOP §2.2 品牌故事（品牌理念 / 产品匠心 / 售后承诺）',
    title: '品牌故事没讲全三件事',
    check({ value }) {
      const text = String(value).toLowerCase()
      const missing = []
      if (!/(brand|we |our |since|founded|family|story)/.test(text)) missing.push('品牌理念')
      if (!/(craft|design|quality|material|made|hand|engineer|built)/.test(text)) missing.push('产品匠心')
      if (!/(warranty|guarantee|support|service|replace|return|care|contact)/.test(text)) missing.push('售后承诺')
      return missing.length === 0 ? [] : [`SOP §2.2 要求品牌故事讲清三件事，这里看不出: ${missing.join('、')}`]
    },
  },

  /* ── attributes — coverage and specificity (§七 / §7.2) ────────────────────
     Attributes are the one part of the listing where "filled in" and "useful"
     diverge sharply, so they get two separate checks: is it filled, and is the
     value specific enough to connect anything. */
  {
    id: 'geo.attribute.placeholder',
    appliesTo: [ATTRIBUTE_WILDCARD],
    scope: 'field',
    severity: 'block',
    source: '§7.2「每个空白字段 = 知识图谱中的一个断连」',
    title: '属性填了占位值',
    check({ value }) {
      return isPlaceholderValue(value)
        ? [`「${value}」不是有效属性值。占位值看起来填了，在知识图谱里和空白一样，而且更难被发现`]
        : []
    },
  },
  {
    id: 'attributes.unknown',
    appliesTo: [ATTRIBUTE_WILDCARD],
    scope: 'field',
    severity: 'warn',
    source: 'listing_field_registry.py ATTRIBUTE_DISPLAY_NAMES（52 项）',
    title: '属性名不在注册表里',
    check({ field }) {
      const id = attributeIdOf(field)
      if (id === null || ATTRIBUTES[id] !== undefined) return []
      return [`「${id}」不在 52 项属性注册表里，多半是拼写错误。亚马逊会忽略未知属性，所以它看起来填了但连不上任何节点`]
    },
  },
  {
    id: 'geo.kgo.generic',
    appliesTo: [ATTRIBUTE_WILDCARD],
    scope: 'field',
    severity: 'warn',
    source: '§7.2 / §9.3.1 知识图谱优化（KGO）',
    title: '属性值太泛，连不上知识图谱',
    check({ field, value, options }) {
      const id = attributeIdOf(field)
      if (id === null || !isGenericValue(id, value, options?.marketplace)) return []
      const example = specificityExamplesFor(options?.marketplace).find(item => item.generic.toLowerCase() === String(value).trim().toLowerCase())
      return [`「${value}」太泛，填了等于没填。${example ? `改成 ${example.specific}` : '要写成具体规格，如 70D High-Density Foam 而不是 Foam'}`]
    },
  },
  {
    id: 'geo.attributes.coverage',
    appliesTo: ['draft'],
    scope: 'set',
    severity: 'warn',
    source: 'SOP §七（43 个必填）/ §11.1（2026 最高优先级）',
    title: '属性字段填写不全',
    check({ fields }) {
      const hasCore = ['title', 'description', ...BULLET_FIELDS].some(field => fields[field] !== undefined)
      if (!hasCore) return []
      const coverage = attributeCoverage(fields)
      if (coverage.complete) return []
      return [`已填 ${coverage.filledCount}/${coverage.target}，缺 ${coverage.missingCount} 项。属性权重已超过后台搜索词，每个空字段是知识图谱的一个断连`]
    },
  },

  /* ── the two 2026 tightenings, and one conflict resolved in the open ─────── */
  {
    id: 'title.length.nonmedia',
    appliesTo: ['title'],
    scope: 'field',
    severity: 'warn',
    source: 'delivery-2026-07-28 §4（2026-07-27 起非媒体类目 ≤75 字符）',
    title: '标题长于 2026-07-27 的新目标值',
    check({ value, options }) {
      if (options?.media === true) return []
      const target = LIMITS.titleNonMediaTarget
      return value.length <= target
        ? []
        : [`${value.length} 字符，2026-07-27 起的非媒体类目目标是 ≤${target}。这是目标不是硬上限 —— §1.3 仍列 200，且 hub 自己的范例标题是 186 字符，所以这里不阻断`]
    },
  },
  {
    id: 'geo.intent.phrasing',
    appliesTo: ['draft'],
    scope: 'set',
    severity: 'warn',
    source: 'SOP §八 对话式意图词',
    title: '没有对话式意图词',
    check({ fields }) {
      const text = [
        fields.title, ...BULLET_FIELDS.map(field => fields[field]), fields.description, fields.search_terms,
        ...QA_FIELDS.map(field => fields[field]),
      ].filter(Boolean).join(' ').toLowerCase()
      if (text === '') return []
      const markers = ['how to', 'best for', 'what is', 'which ', 'can i', 'does it', 'will it', 'is it', 'fits my', 'how do i', 'how long', 'what size']
      return markers.some(marker => text.includes(marker))
        ? []
        : ['五点和 Q&A 里没有 how to / best for / what is 这类对话式意图词。Alexa for Shopping 按问句检索，缺这些词命中率会低']
    },
  },
  {
    id: 'geo.nounphrase.opener',
    appliesTo: ['draft'],
    scope: 'set',
    severity: 'warn',
    source: '§9.3.2 NPO 名词短语优化',
    title: '五点开头是形容词而不是名词短语',
    check({ fields }) {
      const offenders = []
      for (const field of BULLET_FIELDS) {
        const value = fields[field]
        if (value === undefined) continue
        const head = String(value).split(/[:：]/)[0].trim().toLowerCase()
        if (head === '') continue
        const first = head.split(/\s+/)[0]
        if (FLUFF_WORDS.some(word => word === first || word.startsWith(`${first} `))) offenders.push(head)
      }
      return offenders.length === 0
        ? []
        : [`这些五点开头是形容词而非名词短语: ${offenders.join(' / ')}。NPO 要求「Rocking chair cushion with 70D foam core」这种写法`]
    },
  },
]

/* ── the roster and its judgements, split apart ────────────────────────────────

   B02 turned the rule set from "a code constant" into "a row in the database".
   That needs the two halves of a rule pulled apart, because only one of them can
   be stored:

     * `RULES` above is now the **seed**. It is what a fresh store is populated
       with, and it stays the place a new rule is written first. It is no longer
       what `validate` runs against when a run is judged — the roster from the
       store is. Keeping the name (and `RULES_VERSION` / `RULES_SOURCE`) avoids a
       rename rippling through `optimize.js` and the report for no benefit.

     * `CHECKS` is the **judgement**, indexed by rule id. A `check()` reads
       `options.marketplace`, `lexiconFor()`, `attributeCoverage()` — none of
       which is a string. So the function stays in code and the store holds only
       the id; `registry.resolveCheck` is what reconnects the two.

     * `SEED_ROSTER` is the serialisable projection: everything a rule carries
       *except* its functions. That is exactly the columns of the `rule` table, so
       the seed is generated from this array rather than typed out — a second
       hand-written copy of 72 rows would be the very "same fact in two places,
       one of them stale" bug this step exists to remove. */

/** Judgement implementations, by rule id. The store holds data; the code holds this. */
export const CHECKS = Object.fromEntries(
  RULES.map(rule => [rule.id, { check: rule.check, notApplicable: rule.notApplicable }]),
)

/** The serialisable roster — the seed the `rule` table is generated from. */
export const SEED_ROSTER = RULES.map(({ check, notApplicable, ...data }) => data)

/**
 * Checks the doc asks for that code cannot decide.
 *
 * Listed here rather than silently skipped: if a report says "0 violations" and
 * the reader assumes that covers hallucination and contradiction, the report is
 * lying by omission. These are the model's job, and the prepare package says so.
 */
export const LLM_ONLY_CHECKS = [
  { id: 'audit.hallucination', source: '§10.2 虚假声称', ask: '文案里的每个参数是否都能在采集到的属性/详情里找到依据' },
  { id: 'audit.contradiction', source: '§10.2 前后矛盾', ask: '标题、五点、描述之间有没有互相否定的说法（如标题说防水、描述说不防水）' },
  { id: 'audit.intent.coverage', source: '§11.2 意图匹配检查', ask: '文案是否回答了 Who is this for / What does it do / How is it different / Will it solve my problem / Is it real' },
  { id: 'audit.cosmo.causal', source: '§9.3.1 / SOP §4.2 COSMO因果链', ask: '每条五点是否构成「功能→痛点→利益」的因果链，而不是功能罗列' },
  { id: 'audit.npo', source: '§9.3.2 名词短语优化', ask: '卖点是否写成名词短语（"70D high-density foam core"）而非形容词堆砌' },
  { id: 'audit.review.alignment', source: '§9.3.4 Review 发现机制', ask: '文案是否回应了差评里的高频痛点（没有差评数据时明确说明无法判断）' },
  { id: 'audit.geo.answerable', source: '§9.2 从关键词匹配 → 意图理解', ask: '买家问「shoes for plantar fasciitis on concrete」这种长问句时，listing 里有没有一句可以被直接摘出来回答它' },
  { id: 'audit.qa.buyer', source: '§9.3.3 Q&A 播种策略', ask: '播种的问题是否是买家真的会问的（不是卖家想说的），回答是否给了参数而不是承诺' },
  { id: 'audit.aplus.increment', source: '范例 §8.2 A+ 要有增量', ask: '每个 A+ 模块相对前台五点有没有新增信息（机检只能查重复度，增量与否要人判断）' },
  { id: 'audit.attribute.fact', source: '§7.2 属性与实物一致', ask: '写进去的属性值是否与实物一致（模型只能提议，属性是事实，必须由人确认）' },
  { id: 'audit.ai.disclosure', source: '§10.1 AI 生成内容 ≥50% 需标注', ask: '若最终图片/文案的 AI 生成占比 ≥50%，是否已按新规标注 "AI Generated" 或 "Enhanced with AI"' },
]

/** The keywords worth anchoring the title on: best tier first. */
const TIER_ORDER = { T1: 0, T2: 1, T3: 2, T4: 3 }
export function topKeywords(keywords, limit = 5) {
  return (keywords ?? [])
    .filter(entry => entry?.keyword)
    .slice()
    .sort((a, b) => {
      const rank = (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9)
      if (rank !== 0) return rank
      const rankA = a.rank ?? Number.MAX_SAFE_INTEGER
      const rankB = b.rank ?? Number.MAX_SAFE_INTEGER
      return rankA - rankB
    })
    .slice(0, limit)
}

export { FLUFF_WORDS, PROMO_WORDS, RANKING_WORDS }
