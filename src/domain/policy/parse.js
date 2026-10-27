/**
 * A policy announcement, parsed into the fields a `policy` row needs.
 *
 * B03 is the literal reading of the user's 「最新政策」, and it is the *upstream* of
 * 「规则获取」: a policy is the input, a rule is the product, and both run through
 * the same pipeline. This module is the step that turns pasted text into fields.
 *
 * Three decisions, each of which is a trap if reversed:
 *
 *   1. **A field that cannot be read stays NULL.** No default marketplace, no
 *      "today" for a missing effective date, no guessed severity, and no date that
 *      does not exist — `2026-02-30`, `2026-04-31` and `2026-02-29` are refused by
 *      the calendar, because a non-existent date in the store looks exactly like
 *      real data and nothing downstream can tell it was invented. The result also
 *      says *which* fields were not recognised, so a page that shows 「未判定」 is
 *      making a statement about the document rather than a claim about the policy.
 *
 *   2. **Nothing usable at all is an error, never an empty row.** A `policy` row
 *      with a title and no body would sit on the page looking like a policy while
 *      saying nothing — exactly the silent-empty failure this module exists to
 *      prevent, so the parse refuses instead of writing it.
 *
 *   3. **Ambiguity is reported, never resolved by picking one.** Two marketplaces,
 *      or two different effective dates, means the text is not one policy
 *      statement; choosing which one "wins" invents a fact.
 *
 * There is deliberately no fetch here. The announcement pages sit behind bot
 * checks, and a failed fetch reads as "there is no new policy" — the worst
 * possible failure for this module, because it is indistinguishable from the good
 * news. `policy_source.kind` already carries `'url'` for when that changes.
 */

/** Human labels for the fields a parse can fail to recognise. */
export const FIELD_LABELS = {
  marketplace: '站点',
  effective_from: '生效日期',
  effective_to: '失效日期',
  published_at: '发布日期',
  severity_hint: '严重度提示',
  url: '原文链接',
}

/** The optional fields — title and body are required, so they are never "unrecognised". */
export const OPTIONAL_FIELDS = Object.keys(FIELD_LABELS)

/** The severity levels a hint can resolve to. A hint, not a judgement. */
export const SEVERITY_HINTS = ['high', 'medium', 'low']

export class PolicyParseError extends Error {
  constructor(reason) {
    super(`政策解析失败：${reason}`)
    this.name = 'PolicyParseError'
    this.reason = reason
  }
}

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

/** Which field a date belongs to, judged by the words around it. */
const PUBLISH_RE = /发布|公告日|publish/i
const EFFECTIVE_TO_RE = /失效|截止|有效至|有效到|until|expire/i
const EFFECTIVE_FROM_RE = /生效|执行|施行|effective/i

/**
 * Marketplaces a policy can name, and the tokens that name them.
 *
 * Deliberately not `\bUS\b` / `\bIT\b` / `\bDE\b` on their own: a bare `IT` is the
 * English word "it" and a bare `DE`/`FR` are common in prose, so the two-letter
 * codes are only accepted after an explicit 「站点：」/「marketplace:」 label. The
 * Chinese names and the storefront domains are unambiguous and need no label.
 */
const MARKETPLACE_TOKENS = [
  ['US', /美国|amazon\.com(?!\.)|站点[:：]\s*US\b|marketplace[:：]\s*US\b/i],
  ['DE', /德国|amazon\.de|站点[:：]\s*DE\b|marketplace[:：]\s*DE\b/i],
  ['JP', /日本|amazon\.co\.jp|站点[:：]\s*JP\b|marketplace[:：]\s*JP\b/i],
  ['UK', /英国|amazon\.co\.uk|站点[:：]\s*(?:UK|GB)\b|marketplace[:：]\s*(?:UK|GB)\b/i],
  ['CA', /加拿大|amazon\.ca|站点[:：]\s*CA\b|marketplace[:：]\s*CA\b/i],
  ['FR', /法国|amazon\.fr|站点[:：]\s*FR\b|marketplace[:：]\s*FR\b/i],
  ['IT', /意大利|amazon\.it|站点[:：]\s*IT\b|marketplace[:：]\s*IT\b/i],
  ['ES', /西班牙|amazon\.es|站点[:：]\s*ES\b|marketplace[:：]\s*ES\b/i],
  ['MX', /墨西哥|amazon\.com\.mx|站点[:：]\s*MX\b|marketplace[:：]\s*MX\b/i],
]

/**
 * Words that hint at how serious the policy is.
 *
 * The strongest match wins, and the result is one of three levels rather than the
 * raw phrase: a chip that sometimes says 「紧急」 and sometimes says 「immediate」
 * is not something a reader can compare. Mapping the policy's own words onto a
 * level is reading, not judging — the *judgement* (block vs warn) is what the
 * rules carry, and that is deliberately not invented here.
 *
 * **The matched phrase is kept as well** (`severity_raw`), because the level on its
 * own reads as Amazon's own classification. 「严重度：高」 is our reading of 「必须
 * 立即整改」, not a label the announcement carried, and a derived value that hides
 * its origin is a derived value pretending to be a fact — the same reason the
 * keyword library records which source a search volume came from. The level is
 * still what the chip is keyed on; the phrase is what makes it a hint.
 */
const SEVERITY_TOKENS = [
  ['high', /严重|紧急|立即|立刻|必须|禁止|下架|停售|封店|冻结|critical|urgent|immediate|must\b|required/i],
  ['medium', /重要|注意|建议|提醒|important|notice|recommend/i],
  ['low', /可选|提示|informational|optional|FYI/i],
]

const URL_RE = /https?:\/\/[^\s<>"'）)】]+/

/** Days per month, January first. February is corrected for leap years in `isoDate`. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** The Gregorian rule: `(y%4===0 && y%100!==0) || y%400===0`. */
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * `2026-5-1` → `2026-05-01`, or `null` when the triple is not a real date.
 *
 * The day is checked against **that month's** length, not against 31. `2026-02-30`,
 * `2026-04-31` and `2026-02-29` (2026 is not a leap year) are not dates, and a date
 * that does not exist is *worse than a NULL*: it goes into the store looking exactly
 * like real data, and every later reader has no way to tell it was invented by a
 * regex. A day/month range check that stops at 31 lets all three through.
 */
function isoDate(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  if (year < 1990 || year > 2100) return null
  if (month < 1 || month > 12) return null
  const limit = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  if (day < 1 || day > limit) return null
  const pad = value => String(value).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}`
}

/** `May` / `may` → 5; anything else → `NaN`. */
function monthNumber(name) {
  const key = String(name).toLowerCase().replace(/\.$/, '')
  return MONTHS[key] ?? Number.NaN
}

/**
 * The date shapes accepted, and how to read their three groups.
 *
 * `MM/DD/YYYY` is deliberately absent: without a locale it is indistinguishable
 * from `DD/MM/YYYY`, and reading `05/06/2026` as May 6th when the author meant
 * June 5th would put a wrong effective date in the store, where it looks certain.
 * A date without a day (`2026年5月`) is absent for the same reason — the day would
 * be invented.
 */
const DATE_PATTERNS = [
  { re: /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g, order: 'ymd' },
  { re: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, order: 'ymd' },
  { re: /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g, order: 'mdy' },
  { re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g, order: 'dmy' },
]

/**
 * What the parser does and does not read, in plain words.
 *
 * Exported so a tool can state the boundary instead of leaving the user to guess
 * why a date they can see did not come through: "生效日期未识别" is only actionable
 * next to the list of shapes that *are* read. See `DATE_REJECTED` for the other
 * half, which matters just as much — those are not bugs to be fixed later, they are
 * shapes whose reading would require inventing a fact.
 */
export const DATE_PHRASINGS = [
  'YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD',
  'YYYY年M月D日',
  'May 1, 2026 / 1 May 2026',
  '紧跟在日期之后的「起」/「开始」/「起生效」/「起施行」/「生效」/「执行」/「施行」'
    + '（关键词与日期之间最多一个半角或全角空格）',
]

/** Shapes deliberately left unread, and why. */
export const DATE_REJECTED = [
  'MM/DD/YYYY 与 DD/MM/YYYY —— 不区分先后，猜错就写进一个错的生效日期',
  '只给到月份（如 2026年5月）—— 缺的那个「日」只能编',
  '不存在的日期（如 2026-02-30、2026-02-29、2026-04-31）—— 入库后会像真数据一样',
]

/** Every date on one line, with the offsets needed to read the words around it. */
function findDates(line) {
  const found = []
  for (const pattern of DATE_PATTERNS) {
    pattern.re.lastIndex = 0
    let match
    while ((match = pattern.re.exec(line)) !== null) {
      let year
      let month
      let day
      if (pattern.order === 'ymd') {
        year = Number(match[1]); month = Number(match[2]); day = Number(match[3])
      } else if (pattern.order === 'mdy') {
        year = Number(match[3]); month = monthNumber(match[1]); day = Number(match[2])
      } else {
        year = Number(match[3]); month = monthNumber(match[2]); day = Number(match[1])
      }
      const iso = isoDate(year, month, day)
      if (iso !== null) found.push({ index: match.index, end: match.index + match[0].length, iso })
    }
  }
  found.sort((a, b) => a.index - b.index)
  /* Two patterns can match the same date (an English one and a numeric one); the
     later match is dropped rather than counted twice. */
  const out = []
  for (const entry of found) {
    if (out.length > 0 && entry.index < out[out.length - 1].end) continue
    out.push(entry)
  }
  return out
}

/** Which field a run of text points at, most specific first. */
function classify(text) {
  if (text === '') return null
  if (PUBLISH_RE.test(text)) return 'published_at'
  if (EFFECTIVE_TO_RE.test(text)) return 'effective_to'
  if (EFFECTIVE_FROM_RE.test(text)) return 'effective_from'
  return null
}

/**
 * A date whose effective keyword comes *after* it: 「自 2026-05-01 起」,
 * 「2026-05-01 起施行」, and the bare 「2026-05-01 生效 / 执行 / 施行」.
 *
 * **Two sets, and both are kept — this slot accepts the union.** A previous
 * revision replaced the bare verbs with the 起 forms and silently lost three shapes
 * that used to parse; the fix is to ADD, never to swap:
 *
 *   - 起 / 开始, optionally followed by 生效 / 执行 / 施行;
 *   - a bare 生效 / 执行 / 施行 with no 起.
 *
 * The keyword must follow the date **immediately** — at most one whitespace
 * character, half- or full-width — and end at a boundary or take one of the known
 * verbs. That bound is what makes it safe: 「… 起价」 / 「… 起运」 / 「… 执行中」 are
 * not date claims, and 「起失效」 never reaches here because `classifyAfter` tests
 * the expiry words first.
 */
const EFFECTIVE_FROM_TRAILING_RE = /^\s?(?:(?:起|开始)(?:生效|执行|施行)?|(?:生效|执行|施行))(?=$|[\s，,。；;、])/

/**
 * Which field a run of text *following* a date points at.
 *
 * The three tests run in the same order as `classify` — publish, then expiry, then
 * effective-from — so 「2026-06-01 起失效」 is an expiry (the more specific word
 * wins) while 「2026-06-01 起施行」 is an effective date. The effective-from slot is
 * the one difference: after a date it accepts the trailing shapes above, which the
 * before-the-date reading cannot see.
 */
function classifyAfter(text) {
  if (text === '') return null
  if (PUBLISH_RE.test(text)) return 'published_at'
  if (EFFECTIVE_TO_RE.test(text)) return 'effective_to'
  if (EFFECTIVE_FROM_TRAILING_RE.test(text)) return 'effective_from'
  return null
}

/** Markdown heading marks and emphasis stripped; a trailing full stop removed. */
function cleanTitle(value) {
  return String(value)
    .replace(/^#{1,6}\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s*#+\s*$/, '')
    .replace(/[。．.]\s*$/, '')
    .trim()
}

/**
 * Parse one policy announcement.
 *
 * @param {string} text the pasted announcement
 * @returns {{
 *   title: string, body_md: string, marketplace: string|null,
 *   effective_from: string|null, effective_to: string|null, published_at: string|null,
 *   severity_hint: string|null, severity_raw: string|null, url: string|null,
 *   unrecognized: string[], ambiguous: string[],
 * }}
 * @throws {PolicyParseError} when there is no usable title or no body at all
 */
export function parsePolicy(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  if (source.trim() === '') throw new PolicyParseError('文本是空的')

  const lines = source.split('\n')

  /* The title is the first non-empty line, with its heading marks stripped. This is
     the one field that is always present: a document with no first line has no
     content, and that is the "nothing usable" branch below. */
  let titleLine = -1
  let title = ''
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue
    title = cleanTitle(lines[index])
    titleLine = index
    break
  }
  if (titleLine < 0 || title === '') throw new PolicyParseError('没有可用的标题')

  const body = lines.slice(titleLine + 1).join('\n').trim()
  if (body === '') throw new PolicyParseError('标题之后没有正文（拒绝写入一条空政策）')

  const result = {
    title,
    body_md: body,
    marketplace: null,
    effective_from: null,
    effective_to: null,
    published_at: null,
    severity_hint: null,
    severity_raw: null,
    url: null,
  }
  const ambiguous = []
  const seenDates = { effective_from: new Set(), effective_to: new Set(), published_at: new Set() }

  /* Dates are read line by line, and each date is attributed from the words *before*
     it (「生效日期：2026-05-01」) or, failing that, the words *after* it
     (「2026年5月1日起生效」, 「自 2026-05-01 起」). Reading before-then-after is what
     keeps 「生效日期：… 失效日期：…」 on one line from attributing both dates to the
     same field. */
  for (const line of lines) {
    const dates = findDates(line)
    let previousEnd = 0
    for (const entry of dates) {
      const before = line.slice(previousEnd, entry.index)
      const after = line.slice(entry.end, entry.end + 6)
      previousEnd = entry.end
      const field = classify(before) ?? classifyAfter(after)
      if (field === null) continue
      seenDates[field].add(entry.iso)
      if (result[field] === null) result[field] = entry.iso
    }
  }
  for (const field of ['effective_from', 'effective_to', 'published_at']) {
    if (seenDates[field].size > 1) {
      result[field] = null
      ambiguous.push(field)
    }
  }

  /* Marketplace: exactly one distinct token, else NULL. Two named sites means the
     text covers two markets, and picking one would be inventing scope.
     2026-10-25（R-78）：**这条判据本身是对的，是 token 的写法跟不上。**
     每个站点的正则都锚在「标签 + 该站点」上（`站点[:：]\s*US`），于是
     「站点：US / CA」只有第一个站点能命中 —— 另一个被默默丢掉，而返回值里没有任何迹象：
       站点：US / CA   → US      ← ❌ 明明点了两个站
       站点：US / DE   → US      ← ❌
       站点：美国站和加拿大站 → null（歧义，对）
       站点：US / 德国站        → null（歧义，对）
     所以补一条：**在标签那一行里枚举出来的站点码也算命中**，然后照原判据办
     （两个就 NULL + 标歧义，不挑一个）。 */
  const markets = []
  const scopeSegment = /(?:站点|marketplace)\s*[:：]\s*([^\n]*)/i.exec(source)?.[1] ?? ''
  for (const [code, pattern] of MARKETPLACE_TOKENS) {
    const inSegment = scopeSegment !== '' && new RegExp(`(?:^|[\\s/／,，、])${code}(?![A-Za-z])`).test(scopeSegment)
    if (pattern.test(source) || inSegment) markets.push(code)
  }
  if (markets.length === 1) result.marketplace = markets[0]
  else if (markets.length > 1) ambiguous.push('marketplace')

  /* Severity: the strongest level any token names, and the phrase it came from.
     Both or neither — a level with no phrase is a judgement, not a hint.
     2026-10-25（R-77）：**标签词本身不是原文。** 标签是「严重度」，而 `high` 的 token 里就有「严重」——
     于是只要文本里出现「严重度：」这一行，raw 就记成「严重」、hint 恒为 high，
     连原文写的是「高」甚至写的是英文 `block` 时也一样（实测三种输入 raw 全是「严重」）。
     一个把「原文」记错的字段，比没有这个字段更糟：它让人以为原文就是这么写的。
     所以：①先剥掉标签词再找；②先认「标签 冒号 高中低」这个最具体的形式。 */
  const severitySource = source.replace(/严重度|严重程度|严重级别|风险等级|等级/g, ' ')
  const levelWord = /[:：]\s*(高|中|低)\s*(?:风险|级|级别)?/.exec(severitySource)
  if (levelWord !== null) {
    result.severity_hint = levelWord[1] === '高' ? 'high' : levelWord[1] === '中' ? 'medium' : 'low'
    result.severity_raw = levelWord[1]
  } else {
    for (const [level, pattern] of SEVERITY_TOKENS) {
      const match = pattern.exec(severitySource)
      if (match !== null) {
        result.severity_hint = level
        result.severity_raw = match[0].trim()
        break
      }
    }
  }

  const link = URL_RE.exec(source)
  if (link !== null) result.url = link[0]

  const unrecognized = OPTIONAL_FIELDS.filter(field => result[field] === null)
  return { ...result, unrecognized, ambiguous }
}

/** The `站点` / `生效日期` style labels for a list of field names. */
export function labelFields(fields) {
  return (fields ?? []).map(field => FIELD_LABELS[field] ?? field).join('、')
}
