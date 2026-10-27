/* 探针 D：双上限与 total 语义。 */
import { boot, draft, callRoute, frozenRows } from './harness.mjs'
import { upsertPrompt, promptHistory } from '../src/store/prompt.js'
import { listSnapshots } from '../src/store/snapshot.js'
import { renderWorkbenchPage } from '../src/web/page.js'

const out = (...a) => console.log(...a)

function loadPage() {
  const html = renderWorkbenchPage({
    pagePath: '/custom/amazon-ops',
    initialState: { context: { module: 'prompts', selection: { asins: [], keywords: [] }, filters: {} } },
  })
  const source = /<script>([\s\S]*)<\/script>/.exec(html)[1]
  const elements = new Map()
  const parseAttrs = (text) => {
    const attrs = {}
    for (const match of text.matchAll(/([a-zA-Z_:][\w:.-]*)="([^"]*)"/g)) attrs[match[1]] = match[2]
    return attrs
  }
  const makeElement = (id) => {
    const store = { id, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, checked: false }
    const el = {
      ...store, dataset: {}, style: {}, onclick: null, oninput: null, onchange: null,
      options: { length: 1 }, children: [],
      appendChild(c) { this.children.push(c); return c }, removeChild(c) { this.children = this.children.filter(i => i !== c); return c },
      addEventListener() {}, removeEventListener() {},
      effectiveHtml() { return this.innerHTML !== '' ? this.innerHTML : String(this.hostHtml ?? '') },
      querySelectorAll(selector) {
        const css = selector.startsWith('.') ? selector.slice(1) : null
        if (css === null) return []
        const outp = []
        const re = /<([a-zA-Z][\w-]*)((?:\s+[a-zA-Z_:][\w:.-]*="[^"]*")*)\s*\/?>/g
        for (const match of String(this.effectiveHtml()).matchAll(re)) {
          const attrs = parseAttrs(match[2])
          const classes = String(attrs.class ?? '').split(/\s+/).filter(Boolean)
          if (!classes.includes(css)) continue
          const child = makeElement(attrs.id || null); child.className = attrs.class || ''
          if (attrs['data-snapshot'] !== undefined) child.dataset.snapshot = attrs['data-snapshot']
          outp.push(child)
        }
        return outp
      },
      querySelector(s) { const a = this.querySelectorAll(s); return a.length > 0 ? a[0] : null },
      closest(s) { const css = s.startsWith('.') ? s.slice(1) : null; return css && String(this.className ?? '').split(/\s+/).includes(css) ? this : null },
      classList: { add() {}, remove() {}, toggle() {} }, scrollIntoView() {},
    }
    Object.defineProperty(el, 'innerHTML', { get() { return store.innerHTML }, set(v) { store.innerHTML = String(v) } })
    Object.defineProperty(el, 'textContent', { get() { return store.textContent }, set(v) { store.textContent = String(v) } })
    return el
  }
  const get = (id) => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id) }
  for (const match of html.matchAll(/id="([^"]+)"/g)) if (!elements.has(match[1])) elements.set(match[1], makeElement(match[1]))
  Object.defineProperty(get('promptHistory'), 'hostHtml', { get() { return get('promptForm').innerHTML }, configurable: true })
  const document = {
    getElementById(id) { return get(id) }, querySelectorAll() { return [] },
    createElement(tag) { return makeElement('<' + tag + '>') },
    documentElement: { style: { setProperty() {} } }, querySelector() { return null },
  }
  const EventSource = class { constructor() {} close() {} }
  const factory = new Function('document', 'fetch', 'EventSource', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'addEventListener',
    source + '\nreturn { state, renderPromptEditor, renderSnapshots, escapeHtml };')
  const api = factory(document, () => new Promise(() => {}), EventSource, { clipboard: { writeText() { return Promise.resolve() } } }, setTimeout, clearTimeout, console, () => {})
  return { api, elements, get }
}

const app = boot()
try {
  // ── D1: 60 次编辑 → 59 冻结；页面切片 50 ──
  const p = upsertPrompt(app.store, draft({ body: 'z1：{{scope}}' }))
  for (let n = 2; n <= 60; n += 1) upsertPrompt(app.store, draft({ id: p.id, body: `z${n}：{{scope}}` }))
  await callRoute(app.api, 'POST', app.api.path + '/context', { module: 'prompts' })
  const payload = JSON.parse((await callRoute(app.api, 'GET', app.api.path + '/state')).text)
  const row = payload.prompts.editor.rows.find(r => r.id === p.id)
  out(`\n===== D1 60 次编辑 =====`)
  out(`version=${row.version}  库里冻结=${frozenRows(app.store, p.id).length}  route 下发 history=${row.history.length}`)
  const page = loadPage()
  page.api.state.prompts = payload.prompts
  page.api.state.selectedPromptId = p.id
  page.api.renderPromptEditor()
  const form = page.elements.get('promptForm').innerHTML
  out(`表单渲染冻结行数 = ${(form.match(/class="prompt-version"/g) || []).length}`)
  out(`页面有没有「已截断 / 仅显示前 N」提示? ${/截断|仅显示|只显示/.test(form)}`)
  out(`→ 页面少画 ${frozenRows(app.store, p.id).length - (form.match(/class="prompt-version"/g) || []).length} 版且不告知`)

  // ── D2: promptHistory.total 的语义 ──
  out(`\n===== D2 promptHistory.total 语义 =====`)
  const hist = promptHistory(app.store, { id: p.id })
  const filtered = listSnapshots(app.store, { objectType: 'prompt', objectId: p.id, includeArchived: false, limit: 200 })
  const allTypes = listSnapshots(app.store, { includeArchived: true, limit: 2000 })
  out(`promptHistory.total = ${hist.total}`)
  out(`listSnapshots(同过滤).matched = ${filtered.matched}  (这才是「这条提示词的冻结数」)`)
  out(`listSnapshots(无过滤).total = ${allTypes.total}  (整张表)`)
  out(`→ promptHistory.total 等于整表总数而非本对象数: ${hist.total === allTypes.total && hist.total !== filtered.matched}`)
  out(`   （提示词 p 的真实冻结数 = ${frozenRows(app.store, p.id).length}）`)

  // ── D3: 两个上限并存 ──
  out(`\n===== D3 上限对照 =====`)
  out(`页面 promptEditor limit = 50；工具 promptHistory 默认 limit = 200；listSnapshots 上限 = 1000`)
  out(`同一份数据，两个地方各切一刀，互不知情。`)
} finally { app.close() }
out('\n完成。')
