/**
 * 极简 CDP 客户端。
 *
 * 为什么需要它：企业邮箱的登录态在浏览器里，插件要“全自动”就必须驱动那个已经
 * 登录的浏览器，而不是自己发 HTTP —— 附件下载既要同源 Cookie，又要走页面自己的
 * 鉴权链路。所以这里只做三件事：找到/新建标签页、发 CDP 命令、在页面里求值。
 *
 * 传输层优先用 Node 内置 WebSocket（Node 22+），老版本退到 ws 包。
 */

const DEFAULT_TIMEOUT = 30000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function trimBase(baseUrl) {
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
    return { ok: true, base, pages, browser: null }
  } catch (error) {
    return {
      ok: false,
      base,
      error: `连不上调试端口 ${base}（${String((error && error.message) || error)}）`,
    }
  }
}

/** 一个标签页的 CDP 会话。 */
export class CdpPage {
  constructor(socket, target, WebSocketImpl) {
    this.socket = socket
    this.target = target
    this.WebSocketImpl = WebSocketImpl
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
          /* 监听器自己的异常不影响会话 */
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

  /** 在页面里求值并取回可序列化结果；页面抛错时把页面栈一起带出来。 */
  async evaluate(expression, { awaitPromise = true, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
        userGesture: true,
      },
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
  }

  async waitForReady(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState', { awaitPromise: false })
        if (state === 'complete') return true
      } catch {
        /* 导航过程中上下文会被销毁，重试即可 */
      }
      await sleep(250)
    }
    return false
  }

  /** 轮询一段页面脚本直到它返回真值。 */
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

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.close()
    } catch {
      /* 关闭失败不影响调用方 */
    }
  }
}

/**
 * 连到一个标签页。
 * match(url) 命中就复用；没命中时，pickExisting=false 会新开一个标签页。
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
  return new CdpPage(socket, target, WebSocketImpl)
}
