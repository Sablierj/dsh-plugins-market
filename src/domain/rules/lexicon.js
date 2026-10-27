/**
 * Per-marketplace keyword lexicon — the words the plan's rules are written in.
 *
 * ## The problem this exists to fix
 *
 * `optimize/plan.js` decided which *supporting* positions a keyword also belongs
 * in by matching it against three English word lists — `QUESTION_RE`
 * (`how/what/why…`), `SPEC_RE` (`foam/steel/cm…`) and `SCENE_RE`
 * (`indoor/patio/pool…`). `attributes.js` did the same for the "too generic"
 * check, and `embedding.js` split words on `/[^a-z0-9']+/`.
 *
 * On the twenty marketplaces this plugin can drive, only **Japan** writes CJK
 * (Singapore is English). So on eighteen of them a German, French, Turkish or
 * Arabic keyword simply never matches a rule, and `qa.question` /
 * `attributes.spec` / `image_alt.scene` come back **silently empty** — the plan
 * is thinner and nothing in the report says why. That is the failure this file
 * removes: not by inventing twenty verified word lists (which would be a new set
 * of confident guesses), but by **naming the word list each site actually used**
 * and declaring, in the report, when it is an approximation.
 *
 * ## Three tiers, and what `authored` does and does not mean
 *
 *   - **English** (`US`/`CA`): the original lists, unchanged. `authored: true`,
 *     no caveat. This is the hub's own rule scope, so it is the one tier with
 *     nothing to disclose.
 *   - **Japan** (`JP`): `authored: true` — we wrote site-specific markers rather
 *     than falling back — but the markers are a *minimal* CJK set that has **not
 *     been checked against a real Japanese listing**. So JP still carries a
 *     caveat. `authored` means "we wrote values for this site", not "verified";
 *     the two are different facts and the report treats them as such.
 *   - **Everything else**: falls back to the English lists. `authored: false`,
 *     with an explicit caveat naming the English approximation.
 *
 * ## `repeatApplicable` — the word-repeat rule is not universal, and why
 *
 * `titleCapacity` enforces "no word may appear in the title more than twice",
 * and the `title.word.repeat` *validation* rule enforces the same thing. That is
 * a rule about **space-separated Latin words** — it comes from English
 * orthography, not from Amazon. The tokeniser behind it is the English
 * `[a-z0-9']` one. On a site whose script that tokeniser cannot see, it returns
 * `[]` and the rule looks like it passed when it never ran: a silent pass, which
 * is worse than no rule.
 *
 * So each site is tagged with the **script** it is written in, and the flag is
 * derived rather than typed per tier:
 *
 *     repeatApplicable = script === 'latin'
 *
 * `JP` is `cjk`; `AE`/`SA` are `arabic`; every other marketplace — including
 * `DE`/`FR`/`ES`/`IT`/`NL`/`SE`/`PL`/`TR`/`MX`/`BR` — is `latin`, so the rule
 * still applies there. On a non-Latin site the flag is `false`, which makes both
 * the plan and the validator **decline the rule out loud** instead of pretending
 * to have computed it.
 *
 * Zero dependencies on purpose — this is data plus a few pure helpers.
 */

export const LEXICON_VERSION = 'lexicon.v1'

export const LEXICON_SOURCE =
  'plan.js 原有的英文 QUESTION_RE / SPEC_RE / SCENE_RE + attributes.js GENERIC_VALUES'
  + '（英文档，即 hub 规则手册的北美适用范围）；日本站为最小 CJK 标记集（尚未用真实日文样本核验）'

/** Sites whose lexicon is the original English one — the hub's rule scope. */
export const ENGLISH_SITES = ['US', 'CA']

/** The only CJK site in the marketplace table. Singapore is English. */
export const CJK_SITES = ['JP']

/** Sites we wrote site-specific values for, rather than falling back to English. */
export const AUTHORED_SITES = [...ENGLISH_SITES, ...CJK_SITES]

/* ── the scripts ──────────────────────────────────────────────────────────────
   The word-repeat rule is about space-separated Latin words, so its
   applicability is a property of the *script*, not of the tier. Tagging each
   site with its script lets `repeatApplicable` be derived (`script === 'latin'`)
   instead of hand-set per lexicon, so adding a site cannot forget the flag.
   Unknown/blank codes default to Latin — the same English approximation the
   fallback lexicon already declares. */

const DEFAULT_SCRIPT = 'latin'

/** Marketplaces that are not written in Latin script. Everything else is. */
const SCRIPT_BY_SITE = {
  JP: 'cjk',
  AE: 'arabic',
  SA: 'arabic',
}

function scriptFor(code) {
  return SCRIPT_BY_SITE[code] ?? DEFAULT_SCRIPT
}

/* ── the word lists ─────────────────────────────────────────────────────────── */

/* English — verbatim from the modules this file replaces. Do not "improve" these
   here: they are the hub's rule scope and changing them changes US behaviour,
   which is the one site we have a verified source for. */
const ENGLISH_WORD_RE = /[a-z0-9']+/g
const ENGLISH_QUESTION_RE = /\b(how|what|which|can|does|do|is|are|will|why|where|when)\b/i
const ENGLISH_SPEC_RE = /\b(foam|steel|fabric|chenille|polyester|cotton|inch|cm|mm|lb|kg|oz|d|gsm|material|waterproof|density)\b/i
const ENGLISH_SCENE_RE = /\b(indoor|outdoor|patio|porch|nursery|pool|garden|balcony|deck|kitchen|office|bedroom|travel|camping|beach)\b/i

/* Japan — a deliberately *minimal* marker set. The review that scoped this work
   said an invented CJK lexicon would introduce new false positives, so this is
   the smallest set that lets the three support rules fire at all, and the caveat
   below is what keeps that honest. Every group is capturing (`(…)`) because the
   attribute rule uses group 1 as its probe — the token to look for in a field. */
const JP_QUESTION_RE = /(ですか|ますか|でしょうか|ありますか|できますか|どんな|どの|どこ|いつ|なぜ|どう|どれ|ですか？)/
const JP_SPEC_RE = /(mm|cm|kg|ml|インチ|密度|素材|材質|厚さ|防水|耐水|サイズ|重量|ポリエステル|コットン|綿|フォーム|スチール|ウール|布)/
const JP_SCENE_RE = /(屋外|室外|室内|リビング|寝室|キッチン|バルコニー|ベランダ|庭|ガーデン|オフィス|キャンプ|ビーチ|プール|旅行|玄関)/

/** CJK has no spaces, so tokens are runs of letters/digits — CJK and Latin alike. */
const CJK_TOKEN_RE = /[\p{L}\p{N}']+/gu

/* ── generic values (§7.2 "a generic value connects nothing") ───────────────── */

const GENERIC_VALUES_EN = new Set([
  'kitchen', 'cooking', 'home', 'household', 'general', 'other', 'various',
  'metal', 'fabric', 'foam', 'plastic', 'wood', 'cotton', 'polyester', 'synthetic',
  'universal', 'multi-purpose', 'multipurpose', 'all purpose', 'all-purpose',
  'indoor', 'outdoor', 'any', 'all', 'misc',
])

/* Japanese generic values. The English set is unioned in rather than replaced:
   a Japanese attribute value is often written in English ("Cotton"), and that
   value is just as generic there as it is on US — dropping the English words
   would make the JP check quieter than the US one for no reason. */
const GENERIC_VALUES_JP = new Set([
  ...GENERIC_VALUES_EN,
  'キッチン', '料理', '家庭用', '一般', 'その他', '各種', '金属', '布', '生地',
  'フォーム', 'プラスチック', '木', '綿', 'ポリエステル', '合成', '汎用', '多目的',
  '屋内', '屋外', '任意', 'すべて',
])

/** The doc's own generic → specific examples, kept verbatim. */
export const SPECIFICITY_EXAMPLES_EN = [
  { generic: 'Kitchen', specific: 'Searing, Baking, Induction Cooking, Campfire' },
  { generic: 'Cooking', specific: 'Searing, Baking, Induction Cooking' },
  { generic: 'Metal', specific: '304 Stainless Steel, Cast Iron, Bamboo' },
  { generic: 'Foam', specific: '70D High-Density Foam' },
  { generic: 'Fabric', specific: 'Fade-Resistant Chenille' },
]

/** Japanese additions, so a JP report can show what "specific" means locally. */
const SPECIFICITY_EXAMPLES_JP = [
  { generic: 'キッチン', specific: '焼き菓子、IH 調理、焚き火' },
  { generic: '金属', specific: '304 ステンレス、鋳鉄、竹' },
  { generic: 'フォーム', specific: '70D 高密度フォーム' },
  { generic: '布', specific: '色落ちしにくいシェニール' },
]

/* ── tokenisers ─────────────────────────────────────────────────────────────── */

/** Lowercase Latin tokens, matching the English `WORD_RE` exactly. */
function tokenizeEnglish(text) {
  return String(text ?? '').toLowerCase().match(ENGLISH_WORD_RE) ?? []
}

/** Runs of letters/digits: a Japanese phrase and a Latin word both come out whole. */
function tokenizeCjk(text) {
  return String(text ?? '').toLowerCase().match(CJK_TOKEN_RE) ?? []
}

/* ── the caveats ────────────────────────────────────────────────────────────── */

/* Both caveats share a fixed opening and closing so a reader (and an assertion)
   can recognise the disclosure regardless of which site produced it; only the
   middle clause — *how* the support rules are approximated — differs. The
   closing clause is the part that matters: it tells the reader the support
   positions may be under-counted, which is the whole point of the disclosure. */
const CAVEAT_PREFIX = '⚠️ 该站点关键词词法未核验，'
const CAVEAT_SUFFIX = '；命中的支持位可能偏少'

const CAVEAT_FALLBACK = `${CAVEAT_PREFIX}支持位规则用英文词法近似${CAVEAT_SUFFIX}`
const CAVEAT_JP = `${CAVEAT_PREFIX}支持位规则用最小 CJK 标记集近似${CAVEAT_SUFFIX}`

/* Why the title word-repeat rule is declined, per script. This is the *reason*
   carried on the lexicon (and printed by the plan's decline and the validator's
   "not applicable" note); it is deliberately not the same sentence as the
   support-position caveat, because "the plan may be thinner" and "a rule was not
   applied" are different facts. */
const REPEAT_REASON = {
  cjk: '日语等 CJK 文案没有空格分词，单词级重复规则不适用',
  arabic: '本站点词法只覆盖拉丁字母，阿拉伯文无法用英文词法分词，单词级重复规则不适用',
}

/** The derived `repeatApplicable` / `repeatReason` pair for a script. */
function repeatFields(script) {
  if (script === 'latin') return { repeatApplicable: true, repeatReason: null }
  return {
    repeatApplicable: false,
    repeatReason: REPEAT_REASON[script] ?? `本站点（${script} 文字）无法用拉丁字母词法分词，单词级重复规则不适用`,
  }
}

/**
 * The title-rule disclosure for a script, or null when there is nothing to say.
 *
 * This is a *second* sentence beside the support-position caveat, not a
 * replacement for it: the caveat says the support positions may be thinner, this
 * says a rule was **not applied at all**. The report prints both under the same
 * ⚠️ heading, so the disclosure covers the title word-repeat rule and not only
 * the support positions. Latin sites have none — the rule genuinely applies
 * there, so there is nothing to disclose.
 */
function repeatNoteOf(script) {
  if (script === 'latin') return null
  return `标题的单词重复约束以拉丁字母分词为前提：本站点（${script}）不适用，校验时该规则会被标为「不适用」，而不是「通过」。`
}

/* ── the lexicons ───────────────────────────────────────────────────────────── */

function englishLexicon(code) {
  const script = scriptFor(code)
  return {
    code,
    tier: 'english',
    /** We wrote these values for this site (they are the hub's rule scope). */
    authored: true,
    /** Nothing to disclose: this is the tier the rules were written in. */
    note: null,
    script,
    questionRe: ENGLISH_QUESTION_RE,
    specRe: ENGLISH_SPEC_RE,
    sceneRe: ENGLISH_SCENE_RE,
    genericValues: GENERIC_VALUES_EN,
    specificityExamples: SPECIFICITY_EXAMPLES_EN,
    tokenize: tokenizeEnglish,
    repeatNote: repeatNoteOf(script),
    ...repeatFields(script),
  }
}

function japaneseLexicon() {
  const script = scriptFor('JP')
  return {
    code: 'JP',
    tier: 'cjk',
    /** We wrote CJK markers for this site — but they are minimal and unverified. */
    authored: true,
    note: CAVEAT_JP,
    script,
    questionRe: JP_QUESTION_RE,
    specRe: JP_SPEC_RE,
    sceneRe: JP_SCENE_RE,
    genericValues: GENERIC_VALUES_JP,
    specificityExamples: [...SPECIFICITY_EXAMPLES_EN, ...SPECIFICITY_EXAMPLES_JP],
    tokenize: tokenizeCjk,
    repeatNote: repeatNoteOf(script),
    ...repeatFields(script),
  }
}

function fallbackLexicon(code) {
  const script = scriptFor(code)
  return {
    code,
    tier: 'fallback',
    /** We did *not* write values for this site — the English lists are standing in. */
    authored: false,
    note: CAVEAT_FALLBACK,
    script,
    questionRe: ENGLISH_QUESTION_RE,
    specRe: ENGLISH_SPEC_RE,
    sceneRe: ENGLISH_SCENE_RE,
    genericValues: GENERIC_VALUES_EN,
    specificityExamples: SPECIFICITY_EXAMPLES_EN,
    tokenize: tokenizeEnglish,
    repeatNote: repeatNoteOf(script),
    ...repeatFields(script),
  }
}

const ENGLISH_LEXICON = englishLexicon('US')
const JP_LEXICON = japaneseLexicon()

/**
 * The lexicon for a marketplace code.
 *
 * `null`/blank/unknown codes get the **fallback** lexicon, not the English one:
 * the useful answer to "which words does amazon.com.tr use" is "the English
 * lists, unverified" — and the fallback carries the caveat that says so. An
 * unknown site must never be handed a lexicon that claims to be authored.
 *
 * @param {string|null|undefined} marketplace
 * @returns {{
 *   code: string|null, tier: string, authored: boolean, note: string|null,
 *   script: string,
 *   questionRe: RegExp, specRe: RegExp, sceneRe: RegExp,
 *   genericValues: Set<string>, specificityExamples: Array<{generic: string, specific: string}>,
 *   tokenize: (text: string) => string[],
 *   repeatApplicable: boolean, repeatReason: string|null, repeatNote: string|null,
 * }}
 */
export function lexiconFor(marketplace) {
  const raw = marketplace === null || marketplace === undefined ? '' : String(marketplace).trim()
  if (raw === '') return fallbackLexicon(null)
  const code = raw.toUpperCase()
  if (code === 'JP') return JP_LEXICON
  if (ENGLISH_SITES.includes(code)) return code === 'US' ? ENGLISH_LEXICON : englishLexicon(code)
  return fallbackLexicon(code)
}

/**
 * The disclosure a report must print for this site, or null when there is none.
 *
 * Kept as a function (rather than read off `lexiconFor`) so callers that only
 * have a code can ask the narrow question, and so it is obvious this is a
 * *different* disclosure from `marketplaces.js`'s `provisionalNote` — that one is
 * about unverified **site rules** (limits, units), this one is about an
 * approximated **keyword lexicon** (support positions). A site can have both,
 * one, or neither.
 *
 * This is the *support-position* caveat only; the title word-repeat disclosure
 * is the separate `repeatNote` on the lexicon, and the report prints both.
 */
export function lexiconNote(marketplace) {
  return lexiconFor(marketplace).note
}
