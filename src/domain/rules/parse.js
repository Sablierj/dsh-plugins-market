/**
 * The rule manual, parsed into `doc` rows.
 *
 * B02c is the literal reading of the user's "规则获取": the 72 machine checks in
 * `listing-rules.js` were written *from* a markdown manual, and the manual itself
 * has never been visible in the workbench. This module turns that document into
 * rows a person can read on the rules page and an agent can cite.
 *
 * Four decisions, each of which is a trap if reversed:
 *
 *   1. **A section is one `doc` row, never split.** The manual has no stable
 *      per-rule ids — one section can hold five rules (§1.2 does) — so inventing
 *      `rule_id`s for its bullet points would be inventing facts, and a fabricated
 *      id is worse than no row. A doc row cites the section; a code rule that
 *      answers to that section names it in its own `source`.
 *
 *   2. **The id is the anchor, not a sequence number.** `doc.1.1`, `doc.12.4`,
 *      `doc.checklist13`. A `doc.<n>` sequence would renumber every row the moment
 *      a section is inserted, and every citation in the store would silently
 *      re-point to a different section.
 *
 *   3. **A `doc` row is not a rule.** It has no judgement, so it never reaches
 *      `validate`. `kind='doc'` says exactly that, and the page shows it in its
 *      own colour so "导入手册" is never read as "规则就绪".
 *
 *   4. **The parse is all-or-nothing.** A section whose table lost a column, or
 *      whose code fence is unclosed, is a *broken* manual, and half a roster
 *      published silently is the failure this exists to prevent. Any structural
 *      problem aborts the whole parse with the section named; nothing is written.
 *
 *   5. **Both gaps use one criterion — semantic attribution, never string
 *      containment.** A rule cites the manual only when its `source` carries a
 *      `§N.M` with no `SOP` / `范例` / `SPEC` / `delivery` prefix: those documents
 *      number their sections independently, so `SOP §3.3` is not the manual's
 *      §3.3. Using containment on one side and attribution on the other makes
 *      `SOP §3.2` "not the manual" for one list and "the manual's §3.2" for the
 *      other, and five sections fall out of the doc gap for no defensible reason.
 *
 * The source is a single, fixed file on purpose. There is a second file with the
 * same name under `01-system/rules/` that a global find-and-replace once damaged
 * ("Rufus" → "Alexa for Shopping", producing the sentence "Alexa for Shopping AI
 * 购物助手"). Importing *that* file would write the corrupted prose into the
 * store as if it were the rule text, so the path is not a parameter a caller can
 * get wrong by accident.
 */

import { readFileSync } from 'node:fs'

/**
 * The manual this plugin imports from, fixed.
 *
 * `04-agents/shared/rules/` is the maintained copy. Do not point this at the
 * same-named file under `01-system/rules/` — see the header.
 */
export const DEFAULT_MANUAL_PATH =
  'D:/amazon-ops-hub/04-agents/shared/rules/amazon-listing-comprehensive-rules-2026.md'

/** Chapters that are reference material rather than rules. Skipped whole. */
const SKIP_TITLES = [/^十四/]

/**
 * A level-2 heading is imported only when it is a numbered chapter (`一、`…`十三、`).
 *
 * The manual opens with `## ⚠️ 2026-05-13 重大变更` — a changelog (Rufus →
 * Alexa for Shopping), not a rule and not guidance, and it sits outside the
 * chapter structure. Importing it would raise "does a stray `##` count?" as a new
 * question, and a changelog row would read as a rule on the page. Chapters are
 * `一、`…`十三、`; anything else at level 2 is skipped.
 */
const CHAPTER_RE = /^[一二三四五六七八九十]+、/

/**
 * Documents a rule's `source` may cite *besides* the manual.
 *
 * A code rule's `source` is a free-form citation, and several of them point at
 * the SOP, the engine spec, a delivery note or a Python asset instead of the
 * manual. `SOP §3.3` must not be read as the manual's §3.3 — the two documents
 * number their sections independently, and the coincidence is exactly how a
 * "documented" claim would become false.
 */
const FOREIGN_DOCS = ['sop', '范例', 'spec', 'delivery', 'registry', 'engine-spec', 'optimization-engine']

const HEADING_RE = /^(#{2,4})\s+(.+?)\s*$/
const FENCE_RE = /^\s*```/

/** A heading's anchor: `1.1` / `9.3.2`, the fixed slug for 十三, else `null`. */
export function anchorOfHeading(title) {
  const text = String(title ?? '')
  const numbered = /^(\d+(?:\.\d+)*)\b/.exec(text)
  if (numbered !== null) return numbered[1]
  if (/^十三/.test(text)) return 'checklist13'
  return null
}

/** The doc row id for an anchor. Anchor, never a sequence — see the header. */
export function docIdFor(anchor) {
  return `doc.${anchor}`
}

/** `§1.1` for a numbered section, `§十三` for the checklist. */
export function sourceOf(anchor) {
  if (anchor === 'checklist13') return '§十三'
  return `§${anchor}`
}

/**
 * Fields a doc row's section can be inferred to touch, or `null`.
 *
 * Deliberately shallow: the manual is prose, and guessing a field list from a
 * heading is a hint, not a fact. `null` (rather than `[]`) says "not inferred",
 * so a reader can tell a guess that came up empty from one that never ran.
 */
function appliesToOf(title) {
  const text = String(title ?? '')
  const out = []
  if (/标题/.test(text)) out.push('title')
  if (/五点|Bullet/i.test(text)) out.push('bullets')
  if (/描述/.test(text)) out.push('description')
  if (/后台|搜索词/.test(text)) out.push('search_terms')
  if (/图片|Alt Text/i.test(text)) out.push('image_alt')
  return out.length > 0 ? out : null
}

/** Headings of the document, with the line each sits on (0-based). */
function headingsOf(lines) {
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING_RE.exec(lines[index])
    if (match !== null) out.push({ level: match[1].length, title: match[2].trim(), line: index })
  }
  return out
}

/** A `ParseError` carries the section so the message can name it, not just fail. */
export class ManualParseError extends Error {
  constructor(ordinal, title, reason) {
    super(`第 ${ordinal} 节解析失败（${title}）：${reason}`)
    this.name = 'ManualParseError'
    this.ordinal = ordinal
    this.sectionTitle = title
    this.reason = reason
  }
}

/**
 * The table blocks of a section body, as arrays of raw rows.
 *
 * A markdown table is recognised loosely on purpose: the manual's tables are not
 * uniform, and the only thing this needs from them is their *shape* — a table
 * whose rows disagree on how many cells they have is a table that was cut off.
 */
function tableBlocks(body) {
  const blocks = []
  let current = null
  for (const line of body.split(/\r?\n/)) {
    const isRow = /^\s*\|.*\|\s*$/.test(line)
    if (isRow) {
      if (current === null) { current = []; blocks.push(current) }
      current.push(line)
    } else {
      current = null
    }
  }
  return blocks
}

/** Throw unless the section's structure is intact. */
function assertSectionIntact(ordinal, title, body) {
  if (body.trim() === '') throw new ManualParseError(ordinal, title, '小节没有正文')
  const fences = body.split(/\r?\n/).filter(line => FENCE_RE.test(line)).length
  if (fences % 2 !== 0) throw new ManualParseError(ordinal, title, '代码围栏没有闭合')
  for (const block of tableBlocks(body)) {
    const widths = new Set(block.map(row => row.split('|').length))
    if (widths.size > 1) {
      throw new ManualParseError(ordinal, title, `表格列数不一致（${[...widths].join('/')}）`)
    }
  }
}

/**
 * Parse the manual into the sections worth importing.
 *
 * A section is importable when it carries body of its own, is neither reference
 * material (`十四`) nor a pure container (a heading whose body is nothing but
 * deeper headings, like `9.3`), and is either a level-3/4 heading or a numbered
 * level-2 chapter (`十三`; the change notice is neither — see `CHAPTER_RE`).
 *
 * @param {string} text the markdown
 * @returns {{sections: Array, docs: Array, anchors: string[]}}
 */
export function parseManual(text) {
  const source = String(text ?? '')
  if (source.trim() === '') throw new ManualParseError(1, '(空文件)', '文件是空的')
  const lines = source.split(/\r?\n/)
  const heads = headingsOf(lines)

  const sections = []
  for (let index = 0; index < heads.length; index += 1) {
    const head = heads[index]
    const end = index + 1 < heads.length ? heads[index + 1].line : lines.length
    const body = lines.slice(head.line + 1, end).join('\n').trim()
    const next = index + 1 < heads.length ? heads[index + 1] : null
    const isContainer = next !== null && next.level > head.level
    const skipped = SKIP_TITLES.some(pattern => pattern.test(head.title))
    const isChapter = head.level === 2 && CHAPTER_RE.test(head.title)
    sections.push({
      level: head.level,
      title: head.title,
      body,
      line: head.line + 1,
      isContainer,
      skipped,
      importable: !skipped && !isContainer && body !== '' && (head.level >= 3 || isChapter),
    })
  }

  const importable = sections.filter(section => section.importable)
  if (importable.length === 0) throw new ManualParseError(1, '(无小节)', '没有解析出任何可导入小节')

  const docs = importable.map((section, index) => {
    const ordinal = index + 1
    assertSectionIntact(ordinal, section.title, section.body)
    const anchor = anchorOfHeading(section.title)
    if (anchor === null) throw new ManualParseError(ordinal, section.title, '无法从标题推出锚点')
    return {
      id: docIdFor(anchor),
      anchor,
      kind: 'doc',
      /* severity is a placeholder and says so: the manual carries no severity
         marks at all — every `block` in the code set was a judgement the engineer
         added. Pretending the doc supplied one would be inventing a fact. */
      severity: 'warn',
      scope: 'field',
      appliesTo: appliesToOf(section.title),
      title: section.title,
      source: sourceOf(anchor),
      body_md: section.body,
      sortOrder: index,
    }
  })

  return { sections, docs, anchors: docs.map(doc => doc.anchor) }
}

/** Read and parse the manual from disk. Throws if it is missing. */
export function readManual(path = DEFAULT_MANUAL_PATH) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ManualParseError(0, path, `读不到手册：${error.message}`)
  }
  return { ...parseManual(text), path }
}

/**
 * The manual anchors a `source` string points at — foreign citations removed.
 *
 * `§1.1 / §1.2 字符限制` cites the manual twice. `SOP §3.3` cites the SOP, whose
 * §3.3 is unrelated to the manual's §3.3, so it does not count. Only anchors the
 * manual actually has are returned, so a citation to a section that does not
 * exist cannot masquerade as documentation.
 *
 * @param {string} source
 * @param {Set<string>} anchors the manual's own anchors
 */
export function manualAnchorsIn(source, anchors) {
  const text = String(source ?? '')
  const out = []
  const pattern = /§\s*(\d+(?:\.\d+)*)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(0, match.index)
    /* The clause the § sits in: after the last separator, so `SOP §七 …/ §11.1`
       judges each citation on its own and does not smear the SOP prefix across
       the bare §11.1 that follows. */
    const clause = before.split(/[/、,;；()（）「」【】]/).pop() ?? before
    const lower = clause.toLowerCase()
    if (FOREIGN_DOCS.some(name => lower.includes(name))) continue
    if (anchors.has(match[1])) out.push(match[1])
  }
  return out
}

/**
 * Code rules the manual does not document: "有判定无文档".
 *
 * A `kind='code'` rule whose `source` cites no section of the manual. It has a
 * judgement but no published origin — the reverse of a doc row with no check —
 * and the list is named rather than counted, because "21 rules are undocumented"
 * is a number nobody can act on.
 *
 * @param {Array} roster
 * @param {Set<string>} anchors the manual's anchors
 * @returns {string[]}
 */
export function rulesWithoutDoc(roster, anchors) {
  return (roster ?? [])
    .filter(rule => String(rule?.kind ?? 'code') === 'code')
    .filter(rule => manualAnchorsIn(rule?.source, anchors).length === 0)
    .map(rule => rule.id)
}

/**
 * Doc sections no code rule answers to: "有文档无判定".
 *
 * A section imported from the manual that no `kind='code'` rule cites — where
 * "cites" means the *same* semantic attribution `rulesWithoutDoc` uses: a
 * `§N.M` with no `SOP` / `范例` / `SPEC` / `delivery` prefix. Both gaps must use
 * one criterion or they contradict each other: with string containment here and
 * attribution there, `SOP §3.2` counts as "not the manual" on one side and as
 * "the manual's §3.2" on the other, and §2.2 / §3.2 / §8.1 / §8.2 / §9.1 fall
 * out of the gap for no reason a reader could defend.
 *
 * It is not a defect in itself — §8.3 is strategy, not a check — but it is the
 * reason "导入手册" must not be read as "规则就绪".
 *
 * @param {Array} docs parsed doc rows
 * @param {Array} roster
 * @param {Set<string>} anchors the manual's own anchors
 * @returns {string[]} doc ids
 */
export function docsWithoutCheck(docs, roster, anchors) {
  const cited = new Set()
  for (const rule of roster ?? []) {
    /* Only `code` rules count. A doc row's own `source` IS its anchor, so
       counting doc rows would make every section cite itself and the gap would
       collapse the moment it was imported — which is backwards, since the import
       is what creates the sections that have no judgement. */
    if (String(rule?.kind ?? 'code') !== 'code') continue
    for (const anchor of manualAnchorsIn(rule?.source, anchors)) cited.add(anchor)
  }
  return (docs ?? []).filter(doc => !cited.has(doc.anchor)).map(doc => doc.id)
}

/**
 * Both gaps at once, from one parse and one roster — and one criterion.
 *
 * `21 = 72 − 51` (rules the manual documents) and `18 = 42 − 24` (sections a code
 * rule cites) are the two identities the numbers have to satisfy.
 *
 * @returns {{rulesWithoutDoc: string[], docsWithoutCheck: string[]}}
 */
export function documentationGaps(roster, docs) {
  const anchors = new Set((docs ?? []).map(doc => doc.anchor))
  return {
    rulesWithoutDoc: rulesWithoutDoc(roster, anchors),
    docsWithoutCheck: docsWithoutCheck(docs, roster, anchors),
  }
}
