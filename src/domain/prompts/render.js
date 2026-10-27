/**
 * T73 —— 按注册表执行缺失行为 / 类型序列化 / 上限截断的渲染器。
 *
 * 旧渲染器（`domain/optimize/prompt.js#renderTemplate`）的三条语义在 T73 里被
 * **有意替换**，因为它们是「静默空串」的来源：
 *
 *   1. 内联 `{{name}}` 缺值 → 旧实现印空串；T73 按注册的 `missingBehavior` 分派：
 *      `placeholder` 印固定文案、`fail` 拒绝渲染、`omit` 只允许出现在自己的
 *      `{{#name}}…{{/name}}` 段里（内联 omit = 静默空串的变体，拒绝）。
 *   2. `String(value)` → 旧实现把对象印成 `[object Object]`；T73 按 `type` 序列化：
 *      object → 稳定 key 序 JSON，array → 「、」连接。
 *   3. `maxLength` 只声明不执行 → T73 在插入前截断（按码点），并记 `truncated[]`。
 *
 * ## 缺失的四种来源，先归一再分派
 *
 * `''` / 纯空白 / `null` / `undefined` / `[]` / `{}` 都是「缺失」；`0` / `'0'`
 * 不是 —— 0 是事实。归一在 `variables.js#isPromptValueMissing`，本文件不另写一份。
 *
 * ## fail 是「拒绝渲染」，不是「警告后照渲染」
 *
 * `fail` 变量缺失时**不产出半截文本**：先在渲染前收集全部缺失，抛一个
 * `PromptVariableError`，`message` 点名每个变量，`missingNamed[]` 供调用方逐条展示。
 * 配对缺失（`pairWith`）是独立的 `PAIR_MISSING`：A 有值而 B 不在包里时同样拒绝，
 * 因为「只有分子没有分母」比空白更容易被读成事实。
 */

import {
  PROMPT_VARIABLES,
  PromptVariableError,
  formatPromptPlaceholder,
  formatPromptValue,
  isPromptValueMissing,
  promptVariableSpec,
  truncatePromptValue,
  variableReport,
} from './variables.js'
import { parsePromptTemplate, sectionReferencesVariable, templateUsage } from './template.js'

export { PromptVariableError }

/**
 * 这个变量是不是在**自己的可选段之外**被内联引用了。
 *
 * `{{#selectedKeywords}}…{{selectedKeywords}}…{{/selectedKeywords}}` 是合法形态：
 * 段本身被 omit 掉时，段内的内联引用根本不会渲染。真正危险的是
 * `重点看 {{selectedKeywords}}。` —— 段没了、句子还在，就是静默空串。
 */
function inlineOutsideOwnSection(nodes, name, insideOwnSection = false) {
  for (const node of nodes) {
    if (node.type === 'var' && node.name === name && !insideOwnSection) return true
    if (node.type === 'section') {
      if (inlineOutsideOwnSection(node.children, name, insideOwnSection || node.name === name)) return true
    }
  }
  return false
}

/**
 * 渲染前拒绝：fail 缺失 / 配对缺失（可选）/ omit 用错位置。
 *
 * 配对默认**不**在单次渲染里强制（`checkPairs: false`）：模板可能只引用一个数字，
 * 而变量包级配对由 `variableReport` 的 `pairMissing` 独立报告；调用方要做严格包
 * 校验时传 `checkPairs: true`，缺 B 即 `PAIR_MISSING`。这样不会因为「模板只引用
 * 一个字段」就把一份本来可读的提示词拒掉，同时契约 §2.0 的配对能力仍然可用。
 */
function assertRenderable(parsed, bag, options = {}) {
  const report = variableReport(parsed, bag)
  const pairFails = options.checkPairs === true ? report.pairMissing : []

  if (report.missingRequired.length > 0 || pairFails.length > 0) {
    const names = []
    for (const item of [...report.missingRequired, ...pairFails]) {
      if (!names.some(entry => entry.name === item.name)) names.push(item)
    }
    const parts = []
    if (report.missingRequired.length > 0) {
      parts.push(`缺少必填变量：${report.missingRequired.map(item => `${item.name}（来源：${item.source}）`).join('；')}`)
    }
    if (pairFails.length > 0) {
      parts.push(`配对变量缺失：${pairFails.map(item => `${item.name}（被 ${item.requiredBy} 需要）`).join('；')}`)
    }
    const code = report.missingRequired.length > 0 ? 'MISSING_REQUIRED' : 'PAIR_MISSING'
    throw new PromptVariableError(
      code,
      `${parts.join('。')}。拒绝渲染：这些值缺了，句子里会是空洞或半截数字，不是提示词选择了不说。`,
      { missingNamed: names, report },
    )
  }

  for (const name of parsed.variables) {
    const spec = promptVariableSpec(name)
    if (!spec || spec.missingBehavior !== 'omit') continue
    if (inlineOutsideOwnSection(parsed.children, name)) {
      throw new PromptVariableError(
        'OMIT_INLINE',
        `变量 ${name} 的缺失行为是 omit，但模板在可选段之外内联引用了 {{${name}}} —— `
        + 'omit 只能用于 {{#name}}…{{/name}} 段；内联 omit 会静默留下一个空串，拒绝渲染。',
        { missingNamed: [{ name, label: spec.label, source: spec.source }] },
      )
    }
  }
  return report
}

/** 真正把节点树摊平成文本。前置校验已保证不会有 fail / 非法 omit 走到这里。 */
function renderNodes(nodes, bag, truncated, options = {}) {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value
      continue
    }

    const spec = promptVariableSpec(node.name)
    const value = bag[node.name]

    if (node.type === 'var') {
      if (isPromptValueMissing(value)) {
        /* fail / 非法 omit 已在 assertRenderable 拒绝；能到这里只剩 placeholder。 */
        out += formatPromptPlaceholder(spec)
        continue
      }
      const formatted = formatPromptValue(value, spec)
      const cut = truncatePromptValue(formatted, spec.maxLength)
      if (cut.truncated && options.overLimit === 'fail') {
        throw new PromptVariableError(
          'OVER_LIMIT',
          `变量 ${node.name} 渲染后 ${cut.originalLength} 字符，超过上限 ${spec.maxLength}；`
          + '按 overLimit=fail 拒绝渲染（契约表 §2.0：超限不静默截断）。',
          { variable: node.name, maxLength: spec.maxLength, originalLength: cut.originalLength },
        )
      }
      if (cut.truncated && !truncated.some(item => item.name === node.name)) {
        truncated.push({
          name: node.name,
          maxLength: spec.maxLength,
          originalLength: cut.originalLength,
          renderedLength: Array.from(cut.text).length,
        })
      }
      out += cut.text
      continue
    }

    /* section */
    if (isPromptValueMissing(value)) {
      if (spec.missingBehavior === 'omit') continue
      /* placeholder：段内若引用了同名变量，让段内那个占位印在原来的句子里；
         段里没有同名引用时，整段替换成固定文案。 */
      if (sectionReferencesVariable(node, node.name)) {
        out += renderNodes(node.children, bag, truncated, options)
      } else {
        out += formatPromptPlaceholder(spec)
      }
      continue
    }
    out += renderNodes(node.children, bag, truncated, options)
  }
  return out
}

function parseBody(body) {
  if (body !== null && typeof body === 'object' && Array.isArray(body.children)) return body
  return parsePromptTemplate(body, PROMPT_VARIABLES)
}

/**
 * 渲染一个模板并**同时**返回逐变量报告（预览 / 页面 / 组装都用这一个出口）。
 *
 * 这里曾经有两个近乎相同的出口：`renderPromptTemplate`（只给文本）和
 * `renderPromptWithReport`（文本 + 报告）。二者做的是同一件事（`assertRenderable`
 * + `renderNodes`），只是后者多带一份报告；结果前者一直没有生产调用方，
 * 在待接线名单里躺成一条「待接线」。**同一个行为两个出口，早晚会有人只改一个。**
 * T77 处理：删掉只给文本的那个，只留这一个；只要文本的调用方取 `.text`。
 *
 * 缺 `fail` 变量时**抛错**，不返回半截文本；配对变量在 `checkPairs:true` 时同样抛
 * `PAIR_MISSING`（默认只由 `variableReport` 报告）。
 *
 * @param {string|{children: Array}} body
 * @param {Record<string, unknown>} variables
 * @param {{overLimit?: 'truncate'|'fail', checkPairs?: boolean}} options
 *   `overLimit` 默认 `truncate`；`checkPairs` 默认 `false`，传 `true` 把 `pairWith`
 *   缺失升级为拒绝（预览路径 `store/prompt.js#previewPrompt` 传的是 `true`）。
 * @returns {{text: string, report: object}}
 * @throws {PromptVariableError} MISSING_REQUIRED / PAIR_MISSING / OMIT_INLINE / TYPE_MISMATCH / OVER_LIMIT
 */
export function renderPromptWithReport(body, variables = {}, options = {}) {
  const parsed = parseBody(body)
  const bag = variables !== null && typeof variables === 'object' ? variables : {}
  const report = assertRenderable(parsed, bag, options)
  const truncated = []
  const text = renderNodes(parsed.children, bag, truncated, options)
  return {
    text,
    report: {
      ...report,
      truncated,
      usage: templateUsage(parsed),
    },
  }
}
