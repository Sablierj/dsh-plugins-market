/**
 * A Chrome DevTools Protocol client, small enough to live in one file.
 *
 * Why not Playwright/Puppeteer: a DSH local plugin cannot add dependencies
 * (there is no install step — the plugin is a directory you copy in), and the
 * part of CDP a page-scraper actually needs is not large. Node ships a global
 * `WebSocket` since 22, so the transport is already there; what is left is
 * message framing, session routing, and three page helpers.
 *
 * The client talks to the **browser-level** endpoint (`/json/version` →
 * `webSocketDebuggerUrl`) and creates tabs with `Target.createTarget`, rather
 * than POSTing to `/json/new`. Two reasons:
 *
 *   - `/json/new` requires the HTTP `PUT` method since Chrome 111, and leaks
 *     targets if the response is lost. `Target.createTarget` is a normal
 *     protocol call with a matching `Target.closeTarget`.
 *   - With `flatten: true`, one socket carries every tab. There is no second
 *     connection to keep alive, so there is no half-dead-socket state to detect.
 *
 * Everything here is transport. Which page to open and what to read off it
 * belongs to `src/sources/pages/`, so a new site is a new extractor and not a
 * change to this file.
 */

import { get as httpGet } from 'node:http'

const DEFAULT_CALL_TIMEOUT_MS = 20_000
const VERSION_TIMEOUT_MS = 1_500

/**
 * Ask Chrome's HTTP endpoint who it is.
 *
 * Returns `null` rather than throwing when nothing is listening: "no Chrome
 * here" is the normal state before the first collection, not an error.
 */
export function probeVersion(host, port, timeoutMs = VERSION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const request = httpGet({ host, port, path: '/json/version', timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 64_000) request.destroy()
      })
      response.on('end', () => {
        try {
          done(JSON.parse(body))
        } catch {
          done(null)
        }
      })
    })

    request.on('timeout', () => {
      request.destroy()
      done(null)
    })
    request.on('error', () => done(null))
  })
}

/**
 * One WebSocket to the browser, multiplexing every tab.
 *
 * Request/response is keyed by the protocol's own `id`; events are keyed by
 * `sessionId|method` so a handler for one tab never sees another tab's events.
 */
export class CdpConnection {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()
  #closed = false
  #closeHandlers = new Set()

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => this.#onMessage(event))
    socket.addEventListener('close', () => this.#onClose('socket closed'))
    socket.addEventListener('error', () => this.#onClose('socket error'))
  }

  /** Connect and wait for the handshake. Rejects if Chrome never answers. */
  static open(wsUrl, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      let socket
      try {
        socket = new WebSocket(wsUrl)
      } catch (error) {
        reject(new Error(`cannot open CDP socket ${wsUrl}: ${error.message}`))
        return
      }

      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {
          /* nothing to close */
        }
        reject(new Error(`CDP handshake timed out after ${timeoutMs}ms (${wsUrl})`))
      }, timeoutMs)
      timer.unref?.()

      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new CdpConnection(socket))
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        // The browser's WebSocket error event carries no message on purpose, so
        // there is nothing more specific to report than the URL.
        reject(new Error(`CDP socket error connecting to ${wsUrl}`))
      }, { once: true })
    })
  }

  get closed() {
    return this.#closed
  }

  /**
   * Send one protocol call and wait for its result.
   *
   * `options.sessionId` targets a tab; omitting it targets the browser. A
   * protocol-level error rejects with the method name included, because
   * "Cannot find context with specified id" on its own does not say which call
   * produced it.
   */
  send(method, params = {}, { sessionId, timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    if (this.#closed) return Promise.reject(new Error(`CDP connection is closed (tried ${method})`))

    const id = this.#nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()

      this.#pending.set(id, {
        method,
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
        this.#socket.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new Error(`CDP send failed for ${method}: ${error.message}`))
      }
    })
  }

  /**
   * Subscribe to a protocol event. Pass `sessionId` to hear one tab's events;
   * omit it for browser-level events like `Target.targetDestroyed`.
   * Returns the unsubscribe function.
   */
  on(method, handler, { sessionId } = {}) {
    const key = `${sessionId ?? ''}|${method}`
    const handlers = this.#listeners.get(key) ?? new Set()
    handlers.add(handler)
    this.#listeners.set(key, handlers)
    return () => handlers.delete(handler)
  }

  /** Called with a reason when the socket dies, so a long task can abort early. */
  onClose(handler) {
    this.#closeHandlers.add(handler)
    return () => this.#closeHandlers.delete(handler)
  }

  close() {
    this.#onClose('closed by caller')
    try {
      this.#socket.close()
    } catch {
      /* already closing */
    }
  }

  #onMessage(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return // A frame we cannot parse is not worth failing the connection over.
    }

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) {
        pending.reject(new Error(`${pending.method}: ${message.error.message ?? 'protocol error'}`))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }

    if (message.method === undefined) return
    const key = `${message.sessionId ?? ''}|${message.method}`
    const handlers = this.#listeners.get(key)
    if (handlers === undefined) return
    for (const handler of [...handlers]) {
      try {
        handler(message.params ?? {})
      } catch {
        // A subscriber's bug must not take down the transport.
      }
    }
  }

  #onClose(reason) {
    if (this.#closed) return
    this.#closed = true

    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id)
      pending.reject(new Error(`CDP connection lost while waiting for ${pending.method} (${reason})`))
    }
    for (const handler of [...this.#closeHandlers]) {
      try {
        handler(reason)
      } catch {
        /* ignore */
      }
    }
    this.#closeHandlers.clear()
    this.#listeners.clear()
  }
}

/* ─────────────────────────── page-level helpers ─────────────────────────── */

/** Open a new tab and enable the domains a scrape needs. */
export async function openPage(connection, url = 'about:blank') {
  const { targetId } = await connection.send('Target.createTarget', { url })
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })

  await connection.send('Page.enable', {}, { sessionId })
  await connection.send('Runtime.enable', {}, { sessionId })

  return { targetId, sessionId }
}

/** Close a tab, ignoring the case where it is already gone. */
export async function closePage(connection, targetId) {
  if (connection.closed) return
  try {
    await connection.send('Target.closeTarget', { targetId }, { timeoutMs: 5_000 })
  } catch {
    // A tab that closed itself (or died with a crash) is not a problem worth
    // reporting — the caller's work is already done.
  }
}

/**
 * Evaluate an expression in the page and return its value.
 *
 * `returnByValue` means the result must be JSON-serialisable, which is a
 * deliberate constraint: it stops a scraper from accidentally trying to pass a
 * DOM node back across the wire.
 */
export async function evaluate(connection, sessionId, expression, { timeoutMs = 30_000 } = {}) {
  const result = await connection.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    // Lets the page's own event handlers see the calls we dispatch, so a
    // scroll or a click behaves like a user's rather than like a script's.
    userGesture: true,
  }, { sessionId, timeoutMs })

  if (result.exceptionDetails !== undefined) {
    const description = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'unknown page error'
    throw new Error(`page script threw: ${String(description).split('\n')[0].slice(0, 300)}`)
  }

  return result.result?.value
}

/**
 * Navigate and wait until the new document reports itself complete.
 *
 * The first wait is for `Page.frameNavigated`, and it is not optional. A
 * `Page.navigate` call returns as soon as the navigation *starts*, so polling
 * `document.readyState` straight away reads the **previous** document — which
 * for a fresh tab is `about:blank`, already `complete`. The scrape would then
 * run against an empty page and report a title of `null`, looking exactly like
 * a broken selector. Waiting for the commit first removes that failure mode.
 *
 * The second wait polls `document.readyState` rather than listening for
 * `Page.loadEventFired`: a load event can be missed between the commit and the
 * listener being installed, and it never fires at all for a navigation that
 * fails. Polling has one failure mode, and it is the one the caller already has
 * to handle.
 */
export async function navigate(connection, sessionId, url, { timeoutMs = 45_000, pollMs = 250 } = {}) {
  // Installed before the call, so a fast commit cannot slip past us.
  const committed = new Promise((resolve) => {
    const unsubscribe = connection.on('Page.frameNavigated', (params) => {
      // Sub-frames (ads, widgets) navigate constantly; only the main frame counts.
      if (params.frame !== undefined && params.frame.parentId !== undefined) return
      unsubscribe()
      resolve(params.frame?.url ?? '')
    }, { sessionId })
    connection.onClose(() => resolve(null))
  })

  const result = await connection.send('Page.navigate', { url }, { sessionId, timeoutMs })

  // `errorText` is set for things like net::ERR_NAME_NOT_RESOLVED, which is a
  // real answer about the target rather than a transport failure.
  if (result.errorText !== undefined && result.errorText !== '') {
    throw new Error(`navigation failed: ${result.errorText}`)
  }

  const landedUrl = await Promise.race([committed, sleep(timeoutMs).then(() => null)])
  if (landedUrl === null) throw new Error(`navigation to ${url} never committed within ${timeoutMs}ms`)

  const deadline = Date.now() + timeoutMs
  let lastState = 'unknown'
  while (Date.now() < deadline) {
    try {
      lastState = await evaluate(connection, sessionId, 'document.readyState', { timeoutMs: 5_000 })
    } catch (error) {
      // The execution context is replaced mid-navigation; that is expected, and
      // the next poll usually succeeds. Anything else is worth surfacing.
      if (!/context|Cannot find|detached/i.test(error.message)) throw error
      lastState = 'navigating'
    }
    if (lastState === 'complete') return { landedUrl, readyState: lastState, timedOut: false }
    await sleep(pollMs)
  }

  return { landedUrl, readyState: lastState, timedOut: true }
}

/**
 * Make the tab render one storefront correctly, before it navigates.
 *
 * The host in the URL is not enough. Amazon picks the interface language and the
 * displayed currency from the `lc-main` and `i18n-prefs` cookies and from
 * `Accept-Language`, and a shared profile carries those from whatever storefront
 * it visited last. Without this, collecting amazon.de from a profile last used on
 * amazon.com can return an English page with USD prices — plausible-looking data
 * for the wrong marketplace, which is worse than no data.
 *
 * Cookies go on the registrable domain (`.amazon.de`), not the `www.` host, so
 * they still apply after a redirect to another subdomain.
 */
export async function applyStorefront(connection, sessionId, { header, cookies = [], cookieDomain }) {
  // `Network.enable` has to come first; the two calls below are no-ops otherwise.
  await connection.send('Network.enable', {}, { sessionId })
  await connection.send('Network.setExtraHTTPHeaders', {
    headers: { 'Accept-Language': header },
  }, { sessionId })

  for (const cookie of cookies) {
    await connection.send('Network.setCookie', {
      name: cookie.name,
      value: cookie.value,
      domain: cookieDomain,
      path: '/',
      secure: true,
    }, { sessionId })
  }
}

/**
 * A little mouse and wheel activity.
 *
 * This is pacing, not disguise. It makes the traffic pattern less machine-like
 * and, more practically, the scroll is what gets Amazon's lazy-loaded detail
 * sections to render — the BSR line is not always in the initial HTML.
 * See DESIGN.md §4.2 for what this does and does not buy.
 */
export async function humanize(connection, sessionId, random = Math.random) {
  let x = 260 + random() * 500
  let y = 240 + random() * 240

  for (let step = 0; step < 4; step += 1) {
    x = clamp(x + (random() - 0.5) * 260, 20, 1_400)
    y = clamp(y + (random() - 0.5) * 170, 20, 860)
    try {
      await connection.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: Math.round(x), y: Math.round(y), buttons: 0,
      }, { sessionId, timeoutMs: 5_000 })
    } catch {
      return // Input domain unavailable: the scroll below is what actually matters.
    }
    await sleep(40 + random() * 160)
  }

  const scrolls = 3 + Math.floor(random() * 3)
  for (let step = 0; step < scrolls; step += 1) {
    try {
      await connection.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: 180 + random() * 420,
      }, { sessionId, timeoutMs: 5_000 })
    } catch {
      return
    }
    await sleep(120 + random() * 380)
  }
}

/**
 * A plain sleep, deliberately **not** `unref`'d.
 *
 * An unref'd timer does not hold the event loop open, so a script whose only
 * pending work is a pacing delay would exit successfully before the delay
 * finished — a bug that looks like "the tool returned nothing". The few seconds
 * this keeps a process alive are cheaper than that.
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}
