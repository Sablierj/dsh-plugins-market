/* 探针 B：页面接线 —— 快照页签遇到 prompt 行 / 提示词编辑器的历史块 / 缺 history。 */
import { boot, draft, frozenRows, callRoute } from './harness.mjs'
import { upsertPrompt, promptHistory } from '../src/store/prompt.js'
import { snapshotView, archiveSnapshot } from '../src/store/snapshot.js'
import { renderWorkbenchPage } from '../src/web/page.js'

const out = (...a) => console.log(...a)

/* 与 tests/b11-2b-prompt-freeze.mjs 的 loadPage 同路子，但多导出 renderSnapshots。 */
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
      ...store,
      dataset: {}, style: {}, onclick: null, oninput: null, onchange: null,
      options: { length: 1 }, children: [],
      appendChild(child) { this.children.push(child); return child },
      removeChild(child) { this.children = this.children.filter(item => item !== child); return child },
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
          const child = makeElement(attrs.id || null)
          child.className = attrs.class || ''
          if (attrs['data-prompt'] !== undefined) child.dataset.prompt = attrs['data-prompt']
          if (attrs['data-snapshot'] !== undefined) child.dataset.snapshot = attrs['data-snapshot']
          outp.push(child)
        }
        return outp
      },
      querySelector(selector) {
        const all = this.querySelectorAll(selector)
        return all.length > 0 ? all[0] : null
      },
      closest(selector) {
        const css = selector.startsWith('.') ? selector.slice(1) : null
        if (css === null) return null
        return String(this.className ?? '').split(/\s+/).includes(css) ? this : null
      },
      classList: { add() {}, remove() {}, toggle() {} }, scrollIntoView() {},
    }
    Object.defineProperty(el, 'innerHTML', { get() { return store.innerHTML }, set(v) { store.innerHTML = String(v) } })
    Object.defineProperty(el, 'textContent', { get() { return store.textContent }, set(v) { store.textContent = String(v) } })
    return el
  }
  const get = (id) => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id) }
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    if (!elements.has(match[1])) elements.set(match[1], makeElement(match[1]))
  }
  const hostFor = (containerId, hostId) => {
    Object.defineProperty(get(containerId), 'hostHtml', { get() { return get(hostId).innerHTML }, configurable: true })
  }
  hostFor('promptHistory', 'promptForm')
  const document = {
    getElementById(id) { return get(id) },
    querySelectorAll() { return [] },
    createElement(tag) { return makeElement('<' + tag + '>') },
    documentElement: { style: { setProperty() {} } },
    querySelector() { return null },
  }
  const EventSource = class { constructor() {} close() {} }
  const factory = new Function(
    'document', 'fetch', 'EventSource', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'addEventListener',
    source + '\nreturn { state, renderPromptEditor, renderSnapshots, escapeHtml };',
  )
  const api = factory(
    document, () => new Promise(() => {}), EventSource, { clipboard: { writeText() { return Promise.resolve() } } },
    setTimeout, clearTimeout, console, () => {},
  )
  return { api, elements, html, get }
}

// ── B1: 快照页签遇到 prompt 行会怎样 ──────────────────────────────────────
{
  out('\n===== B1 快照页签渲染 prompt 行 =====')
  const app = boot()
  try {
    const p = upsertPrompt(app.store, draft({ body: 'v1：{{scope}}' }))
    upsertPrompt(app.store, draft({ id: p.id, body: 'v2：{{scope}}' }))
    const view = snapshotView(app.store, {})
    const promptRows = view.rows.filter(r => r.objectType === 'prompt')
    out(`snapshotView 里 prompt 行数 = ${promptRows.length}`)
    out(`第一条 prompt 行的 shape: ${JSON.stringify({
      objectType: promptRows[0]?.objectType, label: (view.objectTypes.find(t => t.id === 'prompt') || {}).label,
      version: promptRows[0]?.version, readable: promptRows[0]?.readable,
      comparable: promptRows[0]?.comparable, previousId: promptRows[0]?.previousId,
      changes: promptRows[0]?.changes ? promptRows[0].changes.map(c => c.field) : null,
    })}`)

    const page = loadPage()
    page.api.state.snapshots = view
    page.api.state.retention = null
    const panel = page.get('qsnapshot')
    let crashed = null
    try { page.api.renderSnapshots(panel) } catch (e) { crashed = e.message }
    out(`renderSnapshots 抛错? ${crashed === null ? '否' : crashed}`)
    const html = panel.innerHTML
    out(`渲染长度 = ${html.length}`)
    // 提示词行是否出现在表格里
    out(`含「提示词」标签 = ${html.includes('提示词')}`)
    // 抓那句硬编码的「其余六类」
    const m = /其余([一二三四五六七八九十]+)类（([^）]*)）已可用/.exec(html)
    out(`页签文案：其余${m ? m[1] : '?'}类（${m ? m[2] : '?'}）已可用`)
    const vocab = view.objectTypes.filter(t => !t.pending).map(t => t.label)
    out(`非 pending 的类型共 ${vocab.length} 个：${vocab.join(' / ')}`)
    out(`→ 文案里列举的类数 == 实际非 pending 类数? ${m && m[2].split(' / ').length === vocab.length}`)
    // prompt 行的 objectId 是否被短 id 截断（行渲染用的是 shortId）
    out(`prompt 行的 objectId 全量 = ${promptRows[0]?.objectId}；表格里显示为 shortId（>22 截断）`)
  } finally { app.close() }
}

// ── B2: 提示词编辑器历史块 —— 数量与「同一个数」文案 ──────────────────────
{
  out('\n===== B2 编辑器历史块 vs 文案「同一个数」 =====')
  const app = boot()
  try {
    const p = upsertPrompt(app.store, draft({ body: 'h1：{{scope}}' }))
    upsertPrompt(app.store, draft({ id: p.id, body: 'h2：{{scope}}' }))
    upsertPrompt(app.store, draft({ id: p.id, body: 'h3：{{scope}}' }))
    await callRoute(app.api, 'POST', app.api.path + '/context', { module: 'prompts' })
    const payload = JSON.parse((await callRoute(app.api, 'GET', app.api.path + '/state')).text)
    const row = payload.prompts.editor.rows.find(r => r.id === p.id)
    out(`route 下发 version=${row.version}，history 条数=${row.history.length}`)
    const page = loadPage()
    page.api.state.prompts = payload.prompts
    page.api.state.selectedPromptId = p.id
    page.api.renderPromptEditor()
    const form = page.elements.get('promptForm').innerHTML
    out(`表单里「改过 N 次」显示：${/改过 (\d+) 次/.exec(form)?.[1]}`)
    out(`表单里冻结行数（.prompt-version 计数）：${(form.match(/class="prompt-version"/g) || []).length}`)
    out(`文案含「是同一个数」= ${form.includes('是同一个数')}`)
    out(`→ 「改过 ${row.version} 次」与「${row.history.length} 个可回滚版本」相等? ${row.version === row.history.length}`)
  } finally { app.close() }
}

// ── B3: 51 版时页面切片被 50 截断 ────────────────────────────────────────
{
  out('\n===== B3 51 版时页面切片截断 =====')
  const app = boot()
  try {
    const p = upsertPrompt(app.store, draft({ body: 'x1：{{scope}}' }))
    for (let n = 2; n <= 51; n += 1) upsertPrompt(app.store, draft({ id: p.id, body: `x${n}：{{scope}}` }))
    await callRoute(app.api, 'POST', app.api.path + '/context', { module: 'prompts' })
    const payload = JSON.parse((await callRoute(app.api, 'GET', app.api.path + '/state')).text)
    const row = payload.prompts.editor.rows.find(r => r.id === p.id)
    out(`version=${row.version}，route 下发 history=${row.history.length}，库里冻结=${frozenRows(app.store, p.id).length}`)
    const page = loadPage()
    page.api.state.prompts = payload.prompts
    page.api.state.selectedPromptId = p.id
    page.api.renderPromptEditor()
    const form = page.elements.get('promptForm').innerHTML
    out(`表单渲染的冻结行数 = ${(form.match(/class="prompt-version"/g) || []).length}`)
    out(`→ 页面少画了 ${frozenRows(app.store, p.id).length - (form.match(/class="prompt-version"/g) || []).length} 版，且没有任何「已截断」提示`)
  } finally { app.close() }
}

// ── B4: 归档一个冻结版本后，页面历史块与文案 ────────────────────────────
{
  out('\n===== B4 归档冻结版本后的编辑器 =====')
  const app = boot()
  try {
    const p = upsertPrompt(app.store, draft({ body: 'a1：{{scope}}' }))
    upsertPrompt(app.store, draft({ id: p.id, body: 'a2：{{scope}}' }))
    upsertPrompt(app.store, draft({ id: p.id, body: 'a3：{{scope}}' }))
    const target = promptHistory(app.store, { id: p.id }).rows.find(r => r.version === '1')
    archiveSnapshot(app.store, target.id)
    await callRoute(app.api, 'POST', app.api.path + '/context', { module: 'prompts' })
    const payload = JSON.parse((await callRoute(app.api, 'GET', app.api.path + '/state')).text)
    const row = payload.prompts.editor.rows.find(r => r.id === p.id)
    out(`version=${row.version}，route history=${row.history.length}（库里含归档=${frozenRows(app.store, p.id).length}）`)
    out(`→ 归档后默认口径 ${row.history.length} != version ${row.version}，文案仍称「同一个数」`)
  } finally { app.close() }
}

// ── B5: history 缺字段时页面会说什么 ────────────────────────────────────
{
  out('\n===== B5 route 行缺 history 字段（absent，不是空数组） =====')
  const app = boot()
  try {
    const p = upsertPrompt(app.store, draft({ body: 'n1：{{scope}}' }))
    upsertPrompt(app.store, draft({ id: p.id, body: 'n2：{{scope}}' }))
    await callRoute(app.api, 'POST', app.api.path + '/context', { module: 'prompts' })
    const payload = JSON.parse((await callRoute(app.api, 'GET', app.api.path + '/state')).text)
    // 人为删掉 history 字段，模拟「route 没下发」
    for (const r of payload.prompts.editor.rows) delete r.history
    const page = loadPage()
    page.api.state.prompts = payload.prompts
    page.api.state.selectedPromptId = p.id
    page.api.renderPromptEditor()
    const form = page.elements.get('promptForm').innerHTML
    out(`缺 history 时表单含「还没有冻结版本」= ${form.includes('还没有冻结版本')}`)
    out(`→ 缺字段被渲染成「确实没有版本」（把缺失当成真实值），而不是「数据没拿到」`)
    // 对比：history 为空数组时
    for (const r of payload.prompts.editor.rows) r.history = []
    const page2 = loadPage()
    page2.api.state.prompts = payload.prompts
    page2.api.state.selectedPromptId = p.id
    page2.api.renderPromptEditor()
    const form2 = page2.elements.get('promptForm').innerHTML
    out(`空数组时表单含「还没有冻结版本」= ${form2.includes('还没有冻结版本')}`)
    out(`→ absent 与 empty 渲染成同一句话：${form.includes('还没有冻结版本') === form2.includes('还没有冻结版本')}`)
  } finally { app.close() }
}

out('\n完成。')
