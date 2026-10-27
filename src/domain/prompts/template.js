/**
 * T73 —— 提示词模板的语法层，按**调用方给的闭集**解析。
 *
 * 为什么不是直接复用 `domain/optimize/prompt.js` 的 `parseTemplate`：那个函数把
 * 4 个名字写死在模块里（`PROMPT_VARIABLES`），T73 的 43 名闭集一进来，新变量在
 * 解析期就会被拒。本文件只做语法，不认识任何具体变量名 —— 名字集合由调用方传入
 * （注册表在 `variables.js`，单源），这样「能引用什么」只有一处答案。
 *
 * 语法刻意保持原样，一个字都没加：
 *
 *   - `{{name}}`            内联占位
 *   - `{{#name}}…{{/name}}` 可选段，缺值时整段（连自带标点）消失
 *
 * 不引入 `{{#if}}`、比较、算术：模板一旦能计算，「这段文字是怎么来的」就不再能靠
 * 读模板回答，而提示词入库的全部意义就是它可读、可复核。
 *
 * 与旧解析器一样，**未知变量在解析期抛错**，不是渲染成空串。拼错的变量名和
 * 「提示词选择不说」在输出里长得一模一样，必须在这里响亮地失败。
 */

/** 模板语法错误（未知变量 / 标签不闭合 / 段关闭不匹配）。 */
export class PromptTemplateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PromptTemplateError'
    this.code = 'TEMPLATE_SYNTAX'
  }
}

/**
 * 解析一个模板。
 *
 * @param {string} body 模板正文
 * @param {Iterable<string>} allowedNames 闭集：模板里允许出现的变量名
 * @returns {{children: Array, variables: string[]}}
 * @throws {PromptTemplateError} 未知变量、未闭合占位、段关闭不匹配
 */
export function parsePromptTemplate(body, allowedNames) {
  const allowed = allowedNames instanceof Set ? allowedNames : new Set(allowedNames ?? [])
  const source = String(body ?? '')
  const root = { type: 'root', children: [] }
  const stack = [root]
  const variables = new Set()
  const push = node => stack[stack.length - 1].children.push(node)

  const assertName = (name, raw) => {
    if (!allowed.has(name)) {
      throw new PromptTemplateError(
        `unknown variable "${raw}" — the closed set is ${[...allowed].join(' / ')}. `
        + 'A misspelled name must fail here rather than render as nothing.',
      )
    }
  }

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
      assertName(name, inner)
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
      assertName(inner, inner)
      variables.add(inner)
      push({ type: 'var', name: inner })
    }
  }

  if (stack.length !== 1) {
    throw new PromptTemplateError(`section "{{#${stack[stack.length - 1].name}}}" was never closed`)
  }
  return { children: root.children, variables: [...variables] }
}

/**
 * 模板里每个变量是内联、可选段、还是两者都有。
 *
 * `both` 是真实存在的形态（种子里 `{{#selectedKeywords}}…{{selectedKeywords}}…{{/selectedKeywords}}`），
 * 不能猜成其中一种：`omit` 只能用于可选段，而一个既做段头又做内联的变量如果按内联
 * 处理就会变成「静默空串」。
 *
 * @param {{children: Array}} parsed
 * @returns {Record<string, 'inline'|'optional_section'|'both'>}
 */
export function templateUsage(parsed) {
  const inline = new Set()
  const section = new Set()
  const walk = nodes => {
    for (const node of nodes) {
      if (node.type === 'var') inline.add(node.name)
      else if (node.type === 'section') {
        section.add(node.name)
        walk(node.children)
      }
    }
  }
  walk(parsed.children)

  const usage = {}
  for (const name of parsed.variables) {
    const asInline = inline.has(name)
    const asSection = section.has(name)
    usage[name] = asInline && asSection ? 'both' : (asSection ? 'optional_section' : 'inline')
  }
  return usage
}

/** 这个段里有没有引用同名变量（决定 placeholder 是替换整段还是替换段内值）。 */
export function sectionReferencesVariable(node, name) {
  for (const child of node.children ?? []) {
    if (child.type === 'var' && child.name === name) return true
    if (child.type === 'section' && sectionReferencesVariable(child, name)) return true
  }
  return false
}
