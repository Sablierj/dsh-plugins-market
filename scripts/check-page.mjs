#!/usr/bin/env node
/**
 * `check-page.mjs` — the three checks `src/web/page.js` keeps needing, in one
 * command that says which of them failed and why.
 *
 * ## Why this file exists
 *
 * `src/web/page.js` is one enormous template literal that builds the workbench
 * HTML, and the browser script inside it is *text* to Node. That makes two whole
 * classes of mistake invisible to every other check in this repository, and both
 * have already cost this project real time:
 *
 *   1. **A backtick inside the template literal.** The outer literal ends there.
 *      `node --check src/web/page.js` then reports a syntax error somewhere
 *      unrelated (`Unexpected identifier`) — and when the stray backtick is in a
 *      comment, the message points at prose, not at the mistake.
 *   2. **An unescaped `\n` inside the emitted browser script.** The outer
 *      template turns it into a REAL newline, which closes a string literal in
 *      the script. `node --check src/web/page.js` passes (the file is a valid
 *      module), and Node never looks inside the literal — so the page loads, the
 *      script throws inside the browser, and it reads as "the page had no data".
 *
 * Nothing else in the suite can see either one, which is why this is a script
 * rather than a paragraph in a document.
 *
 * ## The three steps
 *
 *   ① **outer** — `node --check` on `page.js` itself. Catches anything that makes
 *      the module unparseable, including a backtick that broke the literal.
 *   ② **inner** — render the page, pull the `<script>` block out of the rendered
 *      HTML, write it to a temp file with a **`.cjs`** extension, and `node
 *      --check` that. The extension is not cosmetic: `package.json` says
 *      `"type": "module"`, so a `.js` file would be parsed as *strict* ESM while
 *      a browser runs this block as a sloppy classic script. The difference is
 *      real — the script carries Windows paths in single-quoted strings, and
 *      strict mode rejects their `\0` as an octal escape. Checking the
 *      **rendered** text (not the source) is also the point: that is the only
 *      place an unescaped `\n` becomes visible as the real newline the browser
 *      would see.
 *   ③ **templates** — lex `page.js` and check the literal's own integrity: the
 *      document template must open once, close once, contain the whole document,
 *      and end at the last backtick in the file. A stray backtick inside the
 *      literal (a comment is the usual home) either leaves the literal unterminated
 *      or splits the document in two, and this step names which happened.
 *
 * ## Usage
 *
 *   node scripts/check-page.mjs                 # checks src/web/page.js
 *   node scripts/check-page.mjs path/to/page.js # checks another page module
 *
 * Exit code 0 when all three pass, 1 when any fails. Each step prints its own
 * `OK` / `FAIL` line, so a grep for FAIL is a truthful summary.
 *
 * ## No dependencies, like everything else here
 *
 * Only `node:` built-ins. Subprocesses are `spawnSync(process.execPath, …)`, with
 * an `stdio: 'inherit'` fallback: under a sandbox that forbids pipes, `pipe`
 * fails with EPERM, and the fallback still runs the real check and still reads
 * its exit status (the message goes straight to the terminal instead of into a
 * variable).
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const BACKTICK = String.fromCharCode(96)

const results = []

function record(step, ok, detail) {
  results.push({ step, ok, detail })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${step}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Run a real `node --check` and return `{ok, output}`.
 *
 * `pipe` first so the message can be printed next to the step it belongs to; if
 * the sandbox refuses a pipe (EPERM), the same command is re-run with
 * `stdio: 'inherit'`, which still produces the exit status. The fallback is
 * reported in the detail line rather than hidden: "we could not capture the
 * message" and "there was no message" are different facts.
 */
function nodeCheck(file) {
  const piped = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (piped.error === undefined || piped.error === null) {
    const text = `${piped.stdout ?? ''}${piped.stderr ?? ''}`.trim()
    return { ok: piped.status === 0, output: text, captured: true }
  }
  const inherited = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  return {
    ok: inherited.status === 0,
    output: `(could not capture output: ${piped.error.message}; re-ran with stdio: inherit)`,
    captured: false,
  }
}

/**
 * ③ The template-literal lexer.
 *
 * A line-based scan is not enough: backticks are **legal** inside `${…}`
 * interpolations (the nav generator uses one) and legal inside comments that sit
 * *outside* the literal (`page.js` has many, in the module doc blocks). Only a
 * scan that knows which region it is in can tell a stray backtick from a normal
 * one — so this walks the source with a small state machine for comments,
 * strings, regexes, template literals and their interpolations.
 *
 * Returns every template literal found (with its `${}` depth) plus the errors
 * that make the file's literal structure impossible: an unterminated template,
 * string, block comment or regex.
 */
function scanTemplateLiterals(source) {
  const literals = []
  const errors = []
  const stack = [{ kind: 'code', brace: 0, depth: 0 }]
  const length = source.length
  let index = 0

  const position = (at) => {
    let line = 1
    let lastBreak = -1
    for (let cursor = 0; cursor < at && cursor < length; cursor += 1) {
      if (source[cursor] === '\n') { line += 1; lastBreak = cursor }
    }
    return `line ${line}, col ${at - lastBreak}`
  }

  while (index < length) {
    const frame = stack[stack.length - 1]
    const character = source[index]

    if (frame.kind === 'template') {
      if (character === '\\') { index += 2; continue }
      if (character === BACKTICK) { frame.literal.end = index; stack.pop(); index += 1; continue }
      if (character === '$' && source[index + 1] === '{') {
        stack.push({ kind: 'code', brace: 0, depth: frame.depth })
        index += 2
        continue
      }
      index += 1
      continue
    }

    const next = source[index + 1]
    if (character === '/' && next === '/') {
      index = source.indexOf('\n', index)
      if (index === -1) index = length
      continue
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) {
        errors.push(`unterminated block comment at ${position(index)}`)
        index = length
        continue
      }
      index = end + 2
      continue
    }
    if (character === "'" || character === '"') {
      const end = skipQuoted(source, index, character)
      if (end === -1) {
        errors.push(`unterminated string literal at ${position(index)}`)
        index = length
        continue
      }
      index = end
      continue
    }
    if (character === BACKTICK) {
      const literal = { start: index, end: -1, depth: frame.depth }
      literals.push(literal)
      stack.push({ kind: 'template', literal, depth: frame.depth + 1 })
      index += 1
      continue
    }
    if (character === '/' && regexAllowed(source, index)) {
      const end = skipRegex(source, index)
      if (end === -1) {
        errors.push(`unterminated regular expression at ${position(index)}`)
        index = length
        continue
      }
      index = end
      continue
    }
    if (character === '{') { frame.brace += 1; index += 1; continue }
    if (character === '}') {
      /* A `}` that closes an interpolation returns to template text; anything
         else is an ordinary brace and only moves the counter. */
      if (frame.brace === 0 && stack.length > 1) { stack.pop(); index += 1; continue }
      frame.brace -= 1
      index += 1
      continue
    }
    index += 1
  }

  for (const frame of stack) {
    if (frame.kind === 'template') {
      errors.push(`unterminated template literal opened at ${position(frame.literal.start)}`)
    } else if (stack.length > 1 && frame.brace >= 0 && frame !== stack[0]) {
      errors.push('unterminated `${` interpolation')
    }
  }

  return { literals, errors }
}

function skipQuoted(source, start, quote) {
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') { index += 1; continue }
    if (character === quote) return index + 1
    if (character === '\n') return -1
  }
  return -1
}

/** Would a `/` here start a regex rather than divide? Previous meaningful token decides. */
const REGEX_PRECEDERS = new Set(['(', ',', '{', '[', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '~', '^', '<', '>'])
const REGEX_KEYWORDS = ['return', 'typeof', 'instanceof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'new', 'delete', 'void']

function regexAllowed(source, index) {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1
  if (cursor < 0) return true
  if (REGEX_PRECEDERS.has(source[cursor])) return true
  const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(source.slice(Math.max(0, cursor - 12), cursor + 1))
  return word !== null && REGEX_KEYWORDS.includes(word[0])
}

function skipRegex(source, start) {
  let inClass = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') { index += 1; continue }
    if (character === '\n') return -1
    if (character === '[') { inClass = true; continue }
    if (character === ']') { inClass = false; continue }
    if (character === '/' && !inClass) {
      let cursor = index + 1
      while (cursor < source.length && /[a-z]/i.test(source[cursor])) cursor += 1
      return cursor
    }
  }
  return -1
}

/* ── the run ─────────────────────────────────────────────────────────────── */

const target = resolve(process.argv[2] === undefined ? join(PLUGIN_ROOT, 'src', 'web', 'page.js') : process.argv[2])
console.log(`checking ${target}`)

const source = readFileSync(target, 'utf8')
let tempDir = null

try {
  /* ① the outer module parses */
  const outer = nodeCheck(target)
  record('① outer node --check', outer.ok, outer.ok ? '' : outer.output)
  if (outer.ok !== true && outer.captured) {
    console.log('   (a stray backtick inside the template literal is the usual cause — see step ③)')
  }

  /* ③ before ②: it explains the failure ① just reported. */
  const scanned = scanTemplateLiterals(source)
  const pageLiterals = scanned.literals.filter(literal => literal.depth === 0)
  const withScript = pageLiterals.filter(literal => source.slice(literal.start, literal.end + 1).includes('<script>'))
  const problems = [...scanned.errors]

  if (pageLiterals.length === 0) {
    problems.push('no top-level template literal was found — the page document is missing')
  }
  if (withScript.length !== 1) {
    problems.push(`expected exactly 1 top-level template literal carrying the document, found ${withScript.length}`
      + (pageLiterals.length > 1
        ? ` (${pageLiterals.length} top-level literals: ${pageLiterals.map(l => `@${l.start}`).join(', ')})`
        : ''))
  }
  for (const literal of withScript) {
    const body = source.slice(literal.start, literal.end === -1 ? source.length : literal.end + 1)
    if (!body.includes('<!doctype')) problems.push(`the document template at @${literal.start} does not start with <!doctype`)
    if (!body.includes('</html>')) {
      problems.push(`the document template opened at @${literal.start} does not contain </html> — `
        + 'it ends early, which is what a backtick inside the literal does')
    }
    const tail = source.slice(literal.end + 1)
    if (tail.replace(/[}\s;]/g, '') !== '') {
      problems.push(`code follows the document template (${JSON.stringify(tail.trim().slice(0, 40))}) — `
        + 'the literal closed before the file ended')
    }
  }
  record('③ template literal integrity', problems.length === 0,
    problems.length === 0
      ? `${scanned.literals.length} template literal(s), ${scanned.literals.filter(l => l.depth > 0).length} nested in \${\u2026}`
      : problems.join('; '))

  /* ② the browser script parses — checked as the browser would receive it */
  if (outer.ok !== true) {
    record('② inner node --check (.cjs)', false, 'skipped: the outer module does not parse, so the page cannot be rendered')
  } else {
    let rendered
    try {
      const pageUrl = pathToFileURL(target).href
      const module = await import(pageUrl)
      rendered = module.renderWorkbenchPage({
        pagePath: '/custom/amazon-ops',
        initialState: {
          context: {
            module: 'asin',
            scope: {},
            selection: { asins: [], keywords: [] },
            filters: {},
          },
        },
      })
    } catch (error) {
      record('② inner node --check (.cjs)', false, `rendering the page threw: ${error.message}`)
      rendered = null
    }
    if (rendered !== null) {
      const blocks = [...rendered.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      if (blocks.length !== 1) {
        record('② inner node --check (.cjs)', false, `expected exactly 1 <script> block in the rendered page, found ${blocks.length}`)
      } else {
        tempDir = mkdtempSync(join(tmpdir(), 'amzn-page-check-'))
        const inner = join(tempDir, 'page-inner.cjs')
        writeFileSync(inner, blocks[0][1])
        const checked = nodeCheck(inner)
        record('② inner node --check (.cjs)', checked.ok,
          checked.ok
            ? `${blocks[0][1].length} chars, checked as a sloppy classic script`
            : `${checked.output}${checked.captured ? '' : ''}`)
      }
    }
  }
} finally {
  if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true })
}

const failed = results.filter(result => result.ok !== true)
console.log(failed.length === 0
  ? `\n${results.length}/${results.length} passed`
  : `\n${results.length - failed.length}/${results.length} passed — failed: ${failed.map(result => result.step).join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
