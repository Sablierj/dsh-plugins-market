// 浏览器电脑操作插件（Chrome DevTools Protocol）。
//
// 为什么是单文件 CJS：本部署的插件行用绝对路径 `file:///...` 加载一个模块文件，
// 且不允许引第三方依赖（本机没有安装步骤，插件就是拷进来的一份文件）。CDP 的
// 传输层 Node 24 自带（全局 WebSocket，实测运行时是 24.18.1），所以够用的部分是
// 消息分帧 + 会话路由 + 几个页面助手，不值得引入 puppeteer/playwright。
//
// 设计取舍：
//   - 走**浏览器级**端点 + `Target.createTarget` / `Target.attachToTarget(flatten)`，
//     而不是 POST `/json/new`：后者在 Chrome 111+ 需要 PUT，且响应丢失时会漏掉标签页。
//   - 连接与当前标签页是**进程内单例状态**，跨工具调用复用（同一个浏览器、同一个页）。
//   - `apply()` 绝不抛错、工具绝不抛错：本仓库的实测教训是 apply() 抛错会让整棵插件树
//     失败、Host 根本不起监听；工具抛错会让整轮失败。两类问题都转成返回值/日志。
//   - 浏览器**按需拉起**，默认专用 profile + 端口 9333，与用户日常浏览器隔离。

'use strict'

const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, writeFileSync, statSync } = require('node:fs')
const { get: httpGet } = require('node:http')
const { homedir } = require('node:os')
const { join } = require('node:path')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9333
const DEFAULT_WINDOW = '1440,900'
const VERSION_TIMEOUT_MS = 1500
const CALL_TIMEOUT_MS = 20000
const STARTUP_TIMEOUT_MS = 30000
const MAX_TEXT_CHARS = 20000
const DEFAULT_TEXT_CHARS = 4000
const MAX_EVAL_CHARS = 200000

/** Chrome / Edge 的常见位置。第一条命中即用；环境变量可覆盖。 */
const BROWSER_CANDIDATES = [
  process.env.DSH_BROWSER_PATH,
  process.env.AMZN_OPS_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

/** amazon-ops 的采集 profile（里面有登录态）；不在就退到 DSH home 下的独立 profile。 */
const AMAZON_OPS_PROFILE = 'C:\\Users\\win11\\dsh-plugins\\amazon-ops\\data\\chrome-profile'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 从工具入参来的数字：非有限、非正一律回落默认值，并报告**实际生效**的上限。 */
function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return { value: clampInt(fallback, fallback, min, max).value, effective: true }
  return { value: Math.min(Math.max(Math.trunc(number), min), max), effective: false }
}

function clampInt2(value, fallback, min, max) {
  const number = Number(value)
  const base = Number.isFinite(Number(fallback)) ? Math.trunc(Number(fallback)) : min
  if (!Number.isFinite(number) || number <= 0) return { value: Math.min(Math.max(base, min), max), applied: false }
  return { value: Math.min(Math.max(Math.trunc(number), min), max), applied: true }
}

function findBrowser(explicitPath) {
  const candidates = explicitPath ? [String(explicitPath), ...BROWSER_CANDIDATES] : BROWSER_CANDIDATES
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* 读不到就当没命中 */
    }
  }
  return null
}

/** 问 Chrome 的 HTTP 端点它是谁；没人在听是**正常状态**，返回 null 而不是抛错。 */
function probeVersion(host, port, timeoutMs = VERSION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    let request
    try {
      request = httpGet({ host, port, path: '/json/version', timeout: timeoutMs }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
          if (body.length > 65536) request.destroy()
        })
        response.on('end', () => {
          try { done(JSON.parse(body)) } catch { done(null) }
        })
      })
    } catch {
      done(null)
      return
    }
    request.on('timeout', () => { request.destroy(); done(null) })
    request.on('error', () => done(null))
  })
}

/** 当前所有标签页；用于状态查询与「页在哪」。 */
function listTargets(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ host, port, path: '/json/list', timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 524288) request.destroy()
      })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          resolve(Array.isArray(parsed) ? parsed : [])
        } catch (error) {
          reject(new Error('/json/list 返回的不是 JSON: ' + error.message))
        }
      })
    })
    request.on('timeout', () => { request.destroy(); reject(new Error('/json/list 超时')) })
    request.on('error', reject)
  })
}

/** 一条 WebSocket 多路复用所有标签页：请求按协议 id、事件按 `sessionId|method` 路由。 */
class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()
  #closed = false

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => this.#onMessage(event))
    socket.addEventListener('close', () => this.#onClose('socket closed'))
    socket.addEventListener('error', () => this.#onClose('socket error'))
  }

  static open(wsUrl, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        reject(new Error('这个 Node 运行时没有全局 WebSocket（需要 Node 22+），浏览器操作不可用'))
        return
      }
      let socket
      try {
        socket = new WebSocket(wsUrl)
      } catch (error) {
        reject(new Error('打不开 CDP socket ' + wsUrl + ': ' + error.message))
        return
      }
      const timer = setTimeout(() => {
        try { socket.close() } catch { /* 无事可做 */ }
        reject(new Error('CDP 握手超时 ' + timeoutMs + 'ms（' + wsUrl + '）'))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new Cdp(socket)) }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket 连接出错：' + wsUrl)) }, { once: true })
    })
  }

  get closed() { return this.#closed }

  send(method, params = {}, { sessionId, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    if (this.#closed) return Promise.reject(new Error('CDP 连接已关闭（试图调用 ' + method + '）'))
    const id = this.#nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('CDP ' + method + ' 超时 ' + timeoutMs + 'ms'))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.#pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try {
        this.#socket.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new Error('CDP 发送失败 ' + method + ': ' + error.message))
      }
    })
  }

  on(method, handler, { sessionId } = {}) {
    const key = (sessionId ?? '') + '|' + method
    const handlers = this.#listeners.get(key) ?? new Set()
    handlers.add(handler)
    this.#listeners.set(key, handlers)
    return () => handlers.delete(handler)
  }

  close() {
    this.#onClose('closed by caller')
    try { this.#socket.close() } catch { /* 已在关闭中 */ }
  }

  #onMessage(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(pending.method + ': ' + (message.error.message ?? 'protocol error')))
      else pending.resolve(message.result ?? {})
      return
    }
    if (message.method === undefined) return
    const handlers = this.#listeners.get((message.sessionId ?? '') + '|' + message.method)
    if (handlers === undefined) return
    for (const handler of [...handlers]) {
      try { handler(message.params ?? {}) } catch { /* 订阅者的 bug 不该拖垮传输层 */ }
    }
  }

  #onClose(reason) {
    if (this.#closed) return
    this.#closed = true
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id)
      pending.reject(new Error('CDP 连接在等待 ' + pending.method + ' 时断开（' + reason + '）'))
    }
    this.#listeners.clear()
  }
}

/* ───────────────────────────── 浏览器会话 ───────────────────────────── */

function profileDir(settings) {
  if (settings.profileDir) return settings.profileDir
  try {
    if (existsSync(AMAZON_OPS_PROFILE)) return AMAZON_OPS_PROFILE
  } catch { /* 退到默认 */ }
  return join(homedir(), '.dsh', 'computer-ops', 'chrome-profile')
}

async function ensureBrowser(state) {
  const { host, port } = state.settings
  const running = await probeVersion(host, port)
  if (running !== null) return { launched: false, version: running }

  const exe = findBrowser(state.settings.chromePath)
  if (exe === null) {
    throw new Error('找不到 Chrome 或 Edge 可执行文件；用 DSH_BROWSER_PATH 或插件的 chromePath 配置指定一个')
  }
  const dir = profileDir(state.settings)
  mkdirSync(dir, { recursive: true })

  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + dir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
    '--window-size=' + (state.settings.windowSize ?? DEFAULT_WINDOW),
    'about:blank',
  ]
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', (error) => console.error('[browser-cdp] 拉起浏览器失败: ' + error.message))
  if (typeof child.unref === 'function') child.unref()

  const deadline = Date.now() + (state.settings.startupTimeoutMs ?? STARTUP_TIMEOUT_MS)
  while (Date.now() < deadline) {
    await sleep(400)
    const version = await probeVersion(host, port)
    if (version !== null) return { launched: true, version }
  }
  throw new Error('已拉起 ' + exe + '，但端口 ' + port + ' 在超时内没有响应。若浏览器弹了首次运行对话框，关掉它再试。profile: ' + dir)
}

/** 连上浏览器（没有就拉起来），返回 CDP 连接。 */
async function connect(state) {
  if (state.cdp !== null && !state.cdp.closed) return state.cdp
  const info = await ensureBrowser(state)
  const wsUrl = info.version?.webSocketDebuggerUrl
  if (typeof wsUrl !== 'string' || wsUrl === '') throw new Error('Chrome 没给出 webSocketDebuggerUrl，无法建立 CDP 连接')
  state.cdp = await Cdp.open(wsUrl)
  state.tab = null
  return state.cdp
}

/** 复用当前标签页；没有（或要求新开）就建一个并 attach。 */
async function currentTab(state, { newTab = false } = {}) {
  const cdp = await connect(state)
  if (!newTab && state.tab !== null && state.tab.targetId) return state.tab
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
  await cdp.send('Page.enable', {}, { sessionId: attached.sessionId })
  await cdp.send('Runtime.enable', {}, { sessionId: attached.sessionId })
  state.tab = { targetId: created.targetId, sessionId: attached.sessionId }
  return state.tab
}

async function evaluate(state, sessionId, expression, { timeoutMs = 30000 } = {}) {
  const result = await state.cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, { sessionId, timeoutMs })
  if (result.exceptionDetails !== undefined) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知页面错误'
    throw new Error('页面脚本抛错: ' + String(description).split('\n')[0].slice(0, 300))
  }
  return result.result?.value
}

/**
 * 导航并等文档真正就绪。
 *
 * 先等 `Page.frameNavigated` 是必须的：`Page.navigate` 在导航**开始**就返回，
 * 立刻轮询 `document.readyState` 读到的是**上一个**文档（新标签页是 about:blank，
 * 已经是 complete）。那个失败长得和「选择器写错」一模一样。
 */
async function navigate(state, sessionId, url, { timeoutMs = 45000, pollMs = 250 } = {}) {
  const committed = new Promise((resolve) => {
    const unsubscribe = state.cdp.on('Page.frameNavigated', (params) => {
      if (params.frame !== undefined && params.frame.parentId !== undefined) return
      unsubscribe()
      resolve(params.frame?.url ?? '')
    }, { sessionId })
    setTimeout(() => { unsubscribe(); resolve(null) }, timeoutMs).unref?.()
  })

  const result = await state.cdp.send('Page.navigate', { url }, { sessionId, timeoutMs })
  if (result.errorText !== undefined && result.errorText !== '') throw new Error('导航失败: ' + result.errorText)

  const landed = await committed
  if (landed === null) throw new Error('导航到 ' + url + ' 在 ' + timeoutMs + 'ms 内没有提交')

  const deadline = Date.now() + timeoutMs
  let lastState = 'unknown'
  while (Date.now() < deadline) {
    try {
      lastState = await evaluate(state, sessionId, 'document.readyState', { timeoutMs: 5000 })
    } catch (error) {
      if (!/context|Cannot find|detached/i.test(error.message)) throw error
      lastState = 'navigating'
    }
    if (lastState === 'complete') return { landedUrl: landed, readyState: lastState, timedOut: false }
    await sleep(pollMs)
  }
  return { landedUrl: landed, readyState: lastState, timedOut: true }
}

function sessionCwd(exec) {
  const session = exec && exec.agent && exec.agent.session ? exec.agent.session : undefined
  const cwd = session && session.header ? session.header.cwd : undefined
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/* ───────────────────────────── 工具定义 ───────────────────────────── */

const textOut = (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]

/** 所有工具共用：串行执行（一个浏览器、一个当前标签页），异常一律转成返回值。 */
function tool(state, definition) {
  return {
    ...definition,
    async execute(args, exec) {
      const run = async () => {
        try {
          return await definition.execute(args ?? {}, exec ?? {})
        } catch (error) {
          return { ok: false, error: error && error.message ? error.message : String(error) }
        }
      }
      const next = state.queue.then(run, run)
      state.queue = next.then(() => undefined, () => undefined)
      return next
    },
  }
}

function buildTools(state) {
  const base = {
    parameters: (properties, required) => ({ type: 'object', properties, required }),
    output: { schema: {}, render: textOut },
  }

  return [
    tool(state, {
      name: 'browser_open',
      description: 'Open a URL in the automation browser (Chrome DevTools Protocol on 127.0.0.1:9333, dedicated profile) and wait for the page to be ready. Launches the browser on first use and reuses it afterwards. Returns the landed URL and page title. Use this before browser_page / browser_click / browser_type / browser_screenshot.',
      parameters: base.parameters({
        url: { type: 'string', description: 'Absolute URL to open, e.g. https://www.amazon.com/dp/B0XXXXXXXX.' },
        new_tab: { type: 'boolean', description: 'Open in a new tab instead of reusing the current one. Default false.' },
        wait_ms: { type: 'number', description: 'Extra settle time after load, milliseconds (0-30000). Default 0.' },
      }, ['url']),
      output: base.output,
      async execute(args) {
        const settle = clampInt2(args.wait_ms, 0, 0, 30000)
        const tab = await currentTab(state, { newTab: args.new_tab === true })
        const nav = await navigate(state, tab.sessionId, String(args.url))
        if (settle.value > 0) await sleep(settle.value)
        const title = await evaluate(state, tab.sessionId, 'document.title').catch(() => '')
        return { ok: true, url: nav.landedUrl, title: String(title ?? ''), readyState: nav.readyState, timedOut: nav.timedOut }
      },
    }),

    tool(state, {
      name: 'browser_page',
      description: 'Read the current automation-browser page: its URL, title, and visible text (optionally only inside one CSS selector). Use it to ground a claim in what the real page says instead of a guess. Text is capped; the effective cap is returned.',
      parameters: base.parameters({
        selector: { type: 'string', description: 'Optional CSS selector; when given, only that element\'s innerText is returned.' },
        max_chars: { type: 'number', description: 'Maximum characters of text to return (default 4000, max 20000).' },
      }, []),
      output: base.output,
      async execute(args) {
        const tab = await currentTab(state)
        const cap = clampInt2(args.max_chars, DEFAULT_TEXT_CHARS, 200, MAX_TEXT_CHARS)
        const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? args.selector.trim() : null
        const script = selector === null
          ? '({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "") })'
          : '(function(){ var el = document.querySelector(' + JSON.stringify(selector) + ');'
            + ' return { url: location.href, title: document.title, found: el !== null,'
            + ' text: el === null ? "" : el.innerText }; })()'
        const value = await evaluate(state, tab.sessionId, script)
        const raw = String(value?.text ?? '')
        const truncated = raw.length > cap.value
        return {
          ok: true,
          url: String(value?.url ?? ''),
          title: String(value?.title ?? ''),
          ...(selector === null ? {} : { selector, found: value?.found === true }),
          text: truncated ? raw.slice(0, cap.value) : raw,
          truncated,
          maxCharsApplied: cap.value,
        }
      },
    }),

    tool(state, {
      name: 'browser_click',
      description: 'Click in the automation browser, either by CSS selector (the element is scrolled into view and clicked at its center) or at absolute viewport coordinates. Dispatches real input events through CDP so the page\'s own handlers run.',
      parameters: base.parameters({
        selector: { type: 'string', description: 'CSS selector of the element to click.' },
        x: { type: 'number', description: 'Viewport X in CSS pixels; use with y instead of selector.' },
        y: { type: 'number', description: 'Viewport Y in CSS pixels; use with x instead of selector.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default left.' },
        clicks: { type: 'number', description: 'Click count 1-3. Default 1.' },
      }, []),
      output: base.output,
      async execute(args) {
        const tab = await currentTab(state)
        let point = null
        if (typeof args.selector === 'string' && args.selector.trim() !== '') {
          const selector = args.selector.trim()
          const found = await evaluate(state, tab.sessionId, '(function(){ var el = document.querySelector(' + JSON.stringify(selector) + ');'
            + ' if (el === null) return { found: false };'
            + ' el.scrollIntoView({ block: "center", inline: "center" });'
            + ' var r = el.getBoundingClientRect();'
            + ' return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, text: (el.innerText || el.value || "").slice(0, 120) }; })()')
          if (found?.found !== true) return { ok: false, error: '页面上找不到选择器 ' + selector + '（先用 browser_page 或 browser_eval 确认元素存在）' }
          point = { x: Math.round(found.x), y: Math.round(found.y), tag: found.tag, text: found.text }
        } else if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
          point = { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)), tag: null, text: null }
        } else {
          return { ok: false, error: '要么给 selector，要么同时给 x 和 y' }
        }

        const buttons = { left: 'left', right: 'right', middle: 'middle' }
        const button = buttons[args.button] ?? 'left'
        const count = clampInt2(args.clicks, 1, 1, 3).value
        for (let index = 0; index < count; index += 1) {
          await state.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 }, { sessionId: tab.sessionId })
          await state.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: index + 1 }, { sessionId: tab.sessionId })
          await state.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: index + 1 }, { sessionId: tab.sessionId })
          await sleep(80)
        }
        return { ok: true, clicked: point, button, clicks: count }
      },
    }),

    tool(state, {
      name: 'browser_type',
      description: 'Type text into the automation browser: focuses the element (CSS selector) or the currently focused element, inserts the text, and optionally presses Enter. Use it for search boxes and login forms; pair it with browser_click for the submit button when Enter is not enough.',
      parameters: base.parameters({
        text: { type: 'string', description: 'Text to insert.' },
        selector: { type: 'string', description: 'CSS selector of the input to focus first. Optional.' },
        submit: { type: 'boolean', description: 'Press Enter after typing. Default false.' },
        clear: { type: 'boolean', description: 'Clear the field first. Default true.' },
      }, ['text']),
      output: base.output,
      async execute(args) {
        const tab = await currentTab(state)
        let focused = null
        if (typeof args.selector === 'string' && args.selector.trim() !== '') {
          const selector = args.selector.trim()
          const result = await evaluate(state, tab.sessionId, '(function(){ var el = document.querySelector(' + JSON.stringify(selector) + ');'
            + ' if (el === null) return { found: false };'
            + ' el.focus();'
            + (args.clear === false ? '' : ' if (typeof el.value === "string") { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }')
            + ' return { found: true, tag: el.tagName }; })()')
          if (result?.found !== true) return { ok: false, error: '页面上找不到选择器 ' + selector }
          focused = result.tag
        }
        const text = String(args.text)
        await state.cdp.send('Input.insertText', { text }, { sessionId: tab.sessionId })
        if (args.submit === true) {
          await state.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, { sessionId: tab.sessionId })
          await state.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, { sessionId: tab.sessionId })
          await sleep(400)
        }
        return { ok: true, chars: text.length, focusedTag: focused, submitted: args.submit === true }
      },
    }),

    tool(state, {
      name: 'browser_eval',
      description: 'Evaluate a JavaScript expression in the current automation-browser page and return its JSON value. The expression is evaluated with awaitPromise and returnByValue, so it must produce a JSON-serialisable value. Use it to read fields the page renders dynamically, or to assert that a control exists before clicking it.',
      parameters: base.parameters({
        expression: { type: 'string', description: 'JavaScript expression, e.g. document.querySelectorAll("h2").length.' },
        timeout_ms: { type: 'number', description: 'Evaluation timeout, milliseconds (default 30000).' },
      }, ['expression']),
      output: base.output,
      async execute(args) {
        const tab = await currentTab(state)
        const timeout = clampInt2(args.timeout_ms, 30000, 1000, 120000).value
        const value = await evaluate(state, tab.sessionId, String(args.expression), { timeoutMs: timeout })
        let json
        try {
          json = JSON.stringify(value)
        } catch {
          json = String(value)
        }
        const capped = json === undefined ? 'undefined' : json
        const overflow = capped.length > MAX_EVAL_CHARS
        return { ok: true, json: overflow ? capped.slice(0, MAX_EVAL_CHARS) : capped, truncated: overflow, type: typeof value }
      },
    }),

    tool(state, {
      name: 'browser_screenshot',
      description: 'Capture a PNG of the current automation-browser page and save it to disk, then read that path with read_image to actually look at the result. Use it as visual evidence for acceptance (layout, empty states, error states) instead of describing what you assume the page shows.',
      parameters: base.parameters({
        file_path: { type: 'string', description: 'Absolute path for the PNG. Default: browser-shot.png in the session working directory.' },
        full_page: { type: 'boolean', description: 'Capture the whole page instead of just the viewport. Default false.' },
      }, []),
      output: base.output,
      async execute(args, exec) {
        const tab = await currentTab(state)
        const target = typeof args.file_path === 'string' && args.file_path.trim() !== ''
          ? args.file_path.trim()
          : join(sessionCwd(exec), 'browser-shot.png')
        const shot = await state.cdp.send('Page.captureScreenshot', {
          format: 'png',
          ...(args.full_page === true ? { captureBeyondViewport: true } : {}),
        }, { sessionId: tab.sessionId, timeoutMs: 30000 })
        if (typeof shot.data !== 'string' || shot.data === '') throw new Error('Page.captureScreenshot 没有返回图像数据')
        const buffer = Buffer.from(shot.data, 'base64')
        writeFileSync(target, buffer)
        let bytes = buffer.length
        try { bytes = statSync(target).size } catch { /* 用内存里的大小 */ }
        return { ok: true, file_path: target, bytes, fullPage: args.full_page === true }
      },
    }),

    tool(state, {
      name: 'browser_close',
      description: 'Close the current automation-browser tab (default) or the whole automation browser. Use it to clean up after a verification run so the user is not left with windows they did not ask for. Closing the browser only affects the CDP-attached automation instance on the debugging port, never the user\'s everyday browser.',
      parameters: base.parameters({
        close_browser: { type: 'boolean', description: 'Close the entire automation browser instead of just the current tab. Default false.' },
      }, []),
      output: base.output,
      async execute(args) {
        const { host, port } = state.settings
        const version = await probeVersion(host, port)
        if (version === null) return { ok: true, closed: 'nothing', note: '调试端口上本来就没有浏览器在跑' }
        const cdp = await connect(state)
        if (args.close_browser === true) {
          try { await cdp.send('Browser.close', {}, { timeoutMs: 5000 }) } catch { /* 进程会自己退，报错不算失败 */ }
          state.cdp = null
          state.tab = null
          return { ok: true, closed: 'browser' }
        }
        if (state.tab === null || !state.tab.targetId) return { ok: true, closed: 'nothing', note: '当前没有已挂载的标签页' }
        const targetId = state.tab.targetId
        state.tab = null
        try { await cdp.send('Target.closeTarget', { targetId }, { timeoutMs: 5000 }) } catch { /* 已经自己关了 */ }
        return { ok: true, closed: 'tab', targetId }
      },
    }),

    tool(state, {
      name: 'browser_status',
      description: 'Report the automation browser\'s state without changing it: whether the debugging port answers, which browser/version it is, the profile directory in use, and every open tab. Use it first when a browser step failed, to tell "browser not running" apart from "selector wrong".',
      parameters: base.parameters({}, []),
      output: base.output,
      async execute() {
        const { host, port } = state.settings
        const version = await probeVersion(host, port)
        if (version === null) {
          return { ok: true, listening: false, port, profile: profileDir(state.settings), launchable: findBrowser(state.settings.chromePath) !== null }
        }
        let tabs = []
        try {
          const listed = await listTargets(host, port)
          tabs = listed
            .filter(target => target.type === 'page')
            .slice(0, 30)
            .map(target => ({ title: String(target.title ?? '').slice(0, 120), url: String(target.url ?? '').slice(0, 300) }))
        } catch (error) {
          tabs = [{ title: '读取标签页失败', url: String(error.message) }]
        }
        return {
          ok: true,
          listening: true,
          port,
          profile: profileDir(state.settings),
          browser: String(version.Browser ?? version.browser ?? ''),
          tabs,
          currentTabAttached: state.tab !== null,
        }
      },
    }),
  ]
}

/* ───────────────────────────── 挂载 ───────────────────────────── */

function normalize(config) {
  const settings = config && typeof config === 'object' ? config : {}
  return {
    host: typeof settings.host === 'string' && settings.host !== '' ? settings.host : DEFAULT_HOST,
    port: Number.isFinite(Number(settings.port)) && Number(settings.port) > 0 ? Math.trunc(Number(settings.port)) : DEFAULT_PORT,
    profileDir: typeof settings.profileDir === 'string' && settings.profileDir !== '' ? settings.profileDir : null,
    chromePath: typeof settings.chromePath === 'string' && settings.chromePath !== '' ? settings.chromePath : null,
    windowSize: typeof settings.windowSize === 'string' && settings.windowSize !== '' ? settings.windowSize : DEFAULT_WINDOW,
    startupTimeoutMs: Number.isFinite(Number(settings.startupTimeoutMs)) && Number(settings.startupTimeoutMs) > 0
      ? Math.trunc(Number(settings.startupTimeoutMs))
      : STARTUP_TIMEOUT_MS,
  }
}

module.exports = {
  name: 'browser-cdp',
  // Cordis 的 ctx 是受限代理：不声明 inject 就访问 ctx.tools 会抛
  // 「cannot get property "tools" without inject」，整行激活失败。实测踩过这一次。
  inject: ['tools'],
  apply(ctx, config) {
    try {
      const state = { settings: normalize(config), cdp: null, tab: null, queue: Promise.resolve() }
      const disposers = []
      for (const definition of buildTools(state)) {
        try {
          const dispose = ctx.tools.register(definition)
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          // 注册失败只失去这一个工具；抛出去会让整棵插件树失败、Host 起不来。
          console.error('[browser-cdp] 注册工具 ' + definition.name + ' 失败: ' + (error && error.message ? error.message : error))
        }
      }
      console.log('[browser-cdp] 已注册浏览器操作工具（CDP ' + state.settings.host + ':' + state.settings.port + '，profile=' + profileDir(state.settings) + '）')
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* 撤不掉也不该拖垮卸载 */ }
        }
        if (state.cdp !== null) {
          try { state.cdp.close() } catch { /* 已经断开 */ }
        }
      }
    } catch (error) {
      console.error('[browser-cdp] apply 失败（刻意不抛，Host 必须还能起来）: ' + (error && error.message ? error.message : error))
      return undefined
    }
  },
}
