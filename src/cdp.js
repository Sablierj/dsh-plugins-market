/**
 * 极简 CDP 客户端（与 mail-resume 同一套思路，独立实现一份，互不依赖）。
 *
 * 为什么自己驱动浏览器而不是发 HTTP：拼多多的登录态、风控 cookie、H5 渲染都在
 * 浏览器里；插件要拿到和真人在页面上看到的一模一样的数据，就必须驱动那个浏览器。
 *
 * 传输层优先 Node 内置 WebSocket（Node 22+），老版本退到 ws 包。
 */

const DEFAULT_TIMEOUT = 30000

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function trimBase(baseUrl) {
  return String(baseUrl || 'http://127.0.0.1:9333').replace(/\/+$/, '')
}

let wsImplCache = null
async function resolveWebSocketImpl() {
  if (wsImplCache) return wsImplCache
  if (typeof globalThis.WebSocket === 'function') {
    wsImplCache = globalThis.WebSocket
    return wsImplCache
  }
  try {
    const mod = await import('ws')
    wsImplCache = mod.WebSocket || mod.default
    if (!wsImplCache) throw new Error('ws 包未导出 WebSocket')
    return wsImplCache
  } catch (error) {
    throw new Error(
      `当前运行环境没有内置 WebSocket，也没能加载 ws 包（${String((error && error.message) || error)}）；` +
        '无法连接 Chrome 调试端口',
    )
  }
}

async function httpJson(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/** 浏览器调试端口是否活着，以及它管着哪些标签页。 */
export async function probe(cdpUrl) {
  const base = trimBase(cdpUrl)
  try {
    const targets = await httpJson(`${base}/json/list`)
    if (!Array.isArray(targets)) {
      return { ok: false, base, error: '调试端口有响应但不是标签页列表', detail: targets }
    }
    const pages = targets
      .filter((t) => t.type === 'page')
      .map((t) => ({ id: t.id, url: t.url, title: t.title }))
    return { ok: true, base, pages }
  } catch (error) {
    return { ok: false, base, error: `连不上调试端口 ${base}（${String((error && error.message) || error)}）` }
  }
}

export class CdpPage {
  constructor(socket, target) {
    this.socket = socket
    this.target = target
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false

    socket.addEventListener('message', (event) => this.#onMessage(event))
    socket.addEventListener('close', () => {
      this.closed = true
      for (const [, entry] of this.pending) entry.reject(new Error('浏览器调试连接已断开'))
      this.pending.clear()
    })
    socket.addEventListener('error', () => {
      this.closed = true
    })
  }

  #onMessage(event) {
    let payload
    try {
      payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (payload && payload.id && this.pending.has(payload.id)) {
      const entry = this.pending.get(payload.id)
      this.pending.delete(payload.id)
      if (payload.error) entry.reject(new Error(payload.error.message || 'CDP 命令失败'))
      else entry.resolve(payload.result)
      return
    }
    if (payload && payload.method) {
      for (const listener of this.listeners) {
        try {
          listener(payload)
        } catch {
          /* 监听器异常不影响会话 */
        }
      }
    }
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT) {
    if (this.closed) return Promise.reject(new Error('浏览器调试连接已断开'))
    const id = this.nextId++
    const message = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.socket.send(message)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`CDP 发送失败：${String((error && error.message) || error)}`))
      }
    })
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true, userGesture: true },
      timeoutMs,
    )
    if (result && result.exceptionDetails) {
      const details = result.exceptionDetails
      const text =
        (details.exception && (details.exception.description || details.exception.value)) ||
        details.text ||
        '页面脚本执行失败'
      throw new Error(String(text).split('\n')[0])
    }
    return result && result.result ? result.result.value : undefined
  }

  async currentUrl() {
    return this.evaluate('location.href', { awaitPromise: false })
  }

  async navigate(url, { timeoutMs = 45000 } = {}) {
    await this.send('Page.navigate', { url })
    await this.waitForReady(timeoutMs)
    // 给前端 hydration 一点余地：readyState=complete 之后 React 还要挂载
    await sleep(800)
  }

  async waitForReady(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState', { awaitPromise: false })
        if (state === 'complete') return true
      } catch {
        /* 导航过程中上下文会被销毁 */
      }
      await sleep(250)
    }
    return false
  }

  async waitFor(expression, { timeoutMs = 15000, intervalMs = 300 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression, { awaitPromise: true })
        if (last) return last
      } catch (error) {
        last = String((error && error.message) || error)
      }
      await sleep(intervalMs)
    }
    return null
  }

  async screenshot(filePath) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' })
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(filePath), { recursive: true })
    const buffer = Buffer.from(shot.data, 'base64')
    await writeFile(filePath, buffer)
    return filePath
  }

  /** 真人式点击：先滚动到可见，再用 CDP 鼠标事件点元素中心附近。 */
  async clickHuman(elementExpression, { jitter = 6, settleMs = 220 } = {}) {
    const point = await this.evaluate(`(() => {
      const el = (${elementExpression})
      if (!el) return null
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return null
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
    })()`)
    if (!point) return false
    const x = Math.round(point.x + (Math.random() * 2 - 1) * jitter)
    const y = Math.round(point.y + (Math.random() * 2 - 1) * jitter)
    await sleep(120 + Math.random() * 240)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 12, y: y - 8 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await sleep(80 + Math.random() * 160)
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await sleep(40 + Math.random() * 80)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(settleMs + Math.random() * 180)
    return true
  }

  /**
   * 滚动。注意：这个 Chrome（155）上 CDP 的 Input mouseWheel 会挂住不返回，
   * PageDown 也不生效，所以用页面内 scrollBy —— 滚动事件本身完全一样。
   */
  async wheelScroll(deltaY, { x = 640, y = 420 } = {}) {
    await this.evaluate(`window.scrollBy({ top: ${Math.round(deltaY)}, left: 0, behavior: 'instant' })`)
    await sleep(300 + Math.random() * 500)
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 连到一个标签页。match(url) 命中就复用；没命中时，pickExisting=false 会新开标签页。
 */
export async function connect(cdpUrl, { match, pickExisting = true, newTabUrl = 'about:blank' } = {}) {
  const base = trimBase(cdpUrl)
  const WebSocketImpl = await resolveWebSocketImpl()
  const targets = await httpJson(`${base}/json/list`)
  if (!Array.isArray(targets)) {
    throw new Error(`调试端口 ${base} 没有返回标签页列表；确认浏览器是用 --remote-debugging-port 启动的`)
  }
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!pages.length) throw new Error(`调试端口 ${base} 上一个标签页都没有`)

  let target = null
  if (match) target = pages.find((t) => match(t.url || '')) || null
  if (!target && pickExisting) target = pages[0]
  if (!target) {
    const created = await httpJson(`${base}/json/new?${encodeURIComponent(newTabUrl)}`, { method: 'PUT' })
    if (!created || !created.webSocketDebuggerUrl) throw new Error('新建标签页失败')
    target = created
  }

  const socket = new WebSocketImpl(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接标签页调试通道超时')), 10000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('连接标签页调试通道失败'))
    })
  })
  return new CdpPage(socket, target)
}
