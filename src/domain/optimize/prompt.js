/**
 * The prompt template engine: two constructs, no more.
 *
 * Prompts live in the database so the user can change them without editing code,
 * which means the template syntax is a contract the user types against. That
 * contract is deliberately tiny — a placeholder and an optional section:
 *
 *   - `{{name}}`            — a placeholder
 *   - `{{#name}}…{{/name}}` — an optional section, dropped whole when empty
 *
 * There is **no** `{{#if}}`, no comparison, no arithmetic. The moment a template
 * can compute, "which prompt produced this text" stops being answerable by reading
 * it, and the whole point of putting prompts in a library is that they stay
 * readable.
 *
 * Three rules that are easy to get subtly wrong, so they are stated here and
 * asserted in the tests:
 *
 *   1. **The `from` set is closed.** `scope` / `selectedKeywords` / `rulesVersion`.
 *      Any other name is an error at parse time, not an empty string at render
 *      time. `{{selctedKeywords}}` must fail loudly: a typo that renders to
 *      nothing looks exactly like a prompt that chose not to say anything, and
 *      the user would never find out.
 *
 *   2. **Empty renders as nothing** — a placeholder becomes the empty string, and
 *      an optional section is removed **including whatever punctuation it wrapped**.
 *      `''` / `[]` / `null` / `undefined` are empty; `0` and `'0'` are **not** (a
 *      count of zero is a fact, not an absence).
 *
 *   3. **The renderer adds and removes nothing.** It does not insert a separator,
 *      strip a trailing comma, or collapse a double space. So a conditional clause
 *      has to carry its own punctuation inside the section — that is why the seed
 *      writes `{{#selectedKeywords}}重点看 {{selectedKeywords}}。{{/selectedKeywords}}`
 *      with the full stop inside the braces.
 *
 * A consequence worth naming: because the renderer never invents text, a value
 * that needs a *default* has to get it from the resolver, not from the template.
 * The rules prompts render 「把规则版本 当前生效版本 设为生效版本」 when no version
 * is loaded, and `当前生效版本` is supplied as the *value* of `rulesVersion` — see
 * `promptVariables` in src/web/page.js.
 */

import { PROMPT_VARIABLE_NAMES } from '../prompts/variables.js'

/** The only variable names a template may reference.
 *
 * **单一来源（T73）**：名字清单由 `domain/prompts/variables.js` 的注册表派生，
 * 这里不再手写第二份。曾经这里有一份 4 个名字的硬编码副本，T73 把注册表扩到
 * 43 个之后两处就漂了——b11 ① 的守卫立刻抓到。手写第二份清单迟早会漂，
 * 而漂了以后「模板能不能用某个变量」会有两个答案。 */
export const PROMPT_VARIABLES = PROMPT_VARIABLE_NAMES

/** The two kinds of prompt: page buttons, and the assemble block `prepare` reads. */
export const PROMPT_SCENARIOS = ['button', 'assemble']

/** The three layers an `assemble` prompt is composed of, in reading order. */
export const PROMPT_LAYERS = ['fixed', 'evidence', 'contract']

/** A template that does not parse, or names a variable outside the closed set. */
export class PromptTemplateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PromptTemplateError'
  }
}

function assertVariableName(name, raw) {
  if (!PROMPT_VARIABLES.includes(name)) {
    throw new PromptTemplateError(
      `unknown variable "${raw}" — the closed set is ${PROMPT_VARIABLES.join(' / ')}. `
      + 'A misspelled name must fail here rather than render as nothing.',
    )
  }
}

/**
 * Parse a template into a node tree, collecting the variables it references.
 *
 * @param {string} body
 * @returns {{children: Array, variables: string[]}}
 * @throws {PromptTemplateError} on an unknown variable, an unclosed tag, or a
 *   section close that does not match its open
 */
export function parseTemplate(body) {
  const source = String(body ?? '')
  const root = { type: 'root', children: [] }
  const stack = [root]
  const variables = new Set()
  const push = node => stack[stack.length - 1].children.push(node)

  let index = 0
  while (index < source.length) {
    const open = source.indexOf('{{', index)
    if (open < 0) {
      push({ type: 'text', value: source.slice(index) })
      break
    }
    if (open > index) push({ type: 'text', value: source.slice(index, open) })

    const close = source.indexOf('}}', open + 2)
    if (close < 0) {
      throw new PromptTemplateError(`unclosed placeholder: "${source.slice(open, open + 24)}"`)
    }
    const inner = source.slice(open + 2, close).trim()
    index = close + 2

    if (inner === '') throw new PromptTemplateError('empty placeholder "{{}}"')

    if (inner.startsWith('#')) {
      const name = inner.slice(1).trim()
      assertVariableName(name, inner)
      variables.add(name)
      const section = { type: 'section', name, children: [] }
      push(section)
      stack.push(section)
    } else if (inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      const top = stack[stack.length - 1]
      if (stack.length < 2 || top.type !== 'section' || top.name !== name) {
        throw new PromptTemplateError(`section close "{{/${name}}}" has no matching open`)
      }
      stack.pop()
    } else {
      assertVariableName(inner, inner)
      variables.add(inner)
      push({ type: 'var', name: inner })
    }
  }

  if (stack.length !== 1) {
    throw new PromptTemplateError(`section "{{#${stack[stack.length - 1].name}}}" was never closed`)
  }
  return { children: root.children, variables: [...variables] }
}

/** The variable names a template references, in first-seen order. */
export function templateVariables(body) {
  return parseTemplate(body).variables
}

/**
 * Whether a value counts as absent. `0` and `'0'` are **not** empty — a count of
 * zero is a fact, and dropping the sentence that carries it would hide it.
 */
export function isPromptEmpty(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Render a template against a variable bag.
 *
 * Values are stringified as-is; the renderer never adds a separator or trims
 * punctuation. A template that does not parse throws rather than rendering
 * something plausible — see the module header.
 *
 * @param {string|{children: Array}} body the template, or an already-parsed tree
 * @param {Record<string, unknown>} variables
 * @returns {string}
 */
export function renderTemplate(body, variables = {}) {
  const parsed = body !== null && typeof body === 'object' && Array.isArray(body.children)
    ? body
    : parseTemplate(body)

  const renderNodes = nodes => {
    let out = ''
    for (const node of nodes) {
      if (node.type === 'text') {
        out += node.value
      } else if (node.type === 'var') {
        const value = variables[node.name]
        out += isPromptEmpty(value) ? '' : String(value)
      } else {
        const value = variables[node.name]
        out += isPromptEmpty(value) ? '' : renderNodes(node.children)
      }
    }
    return out
  }
  return renderNodes(parsed.children)
}
