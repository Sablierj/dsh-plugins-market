/**
 * Transport: one GET, two carriers.
 *
 * - direct  → global fetch (fast, no subprocess)
 * - proxied → curl.exe (handles http/https/socks5 proxies, TLS, redirects;
 *   Clash's mixed port speaks both). Verified on this host: curl 8.21 / Node 24.
 *
 * No external imports: only node builtins, so a `link:` install resolves nothing
 * from the profile's node_modules.
 */
import { execFile } from 'node:child_process'

const CURL = process.env.DSH_CURL_PATH || 'curl.exe'

export function proxyConfigured(settings) {
  const p = settings?.proxy
  return Boolean(p && p.enabled && p.url)
}

/** Resolve the proxy actually used for this request. */
export function resolveProxy(settings) {
  const p = settings.proxy || {}
  if (p.mode === 'direct') return null
  if (!p.enabled || !p.url) return null
  return p.url
}

async function getWithFetch(url, { timeoutMs, userAgent, headers }) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': userAgent,
        accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(headers || {}),
      },
    })
    const body = await response.text()
    return { ok: response.ok, status: response.status, body, via: 'direct', tookMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

const STATUS_MARK = '\n__DSH_STATUS__:'

async function getWithCurl(url, { timeoutMs, userAgent, headers, proxy }) {
  const started = Date.now()
  const args = [
    '-sS',
    '-L',
    '--max-time',
    String(Math.max(2, Math.ceil(timeoutMs / 1000))),
    '--proxy',
    proxy,
    '-A',
    userAgent,
    '-H',
    'accept: application/json, text/html;q=0.9,*/*;q=0.8',
    '-w',
    `${STATUS_MARK}%{http_code}`,
  ]
  for (const [key, value] of Object.entries(headers || {})) args.push('-H', `${key}: ${value}`)
  args.push(url)

  return await new Promise((resolve) => {
    execFile(
      CURL,
      args,
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs + 3000 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          const message = String(stderr || error.message || '').trim()
          resolve({
            ok: false,
            status: 0,
            body: '',
            via: `curl via ${proxy}`,
            tookMs: Date.now() - started,
            error: message || 'curl failed',
          })
          return
        }
        const text = String(stdout || '')
        const at = text.lastIndexOf(STATUS_MARK)
        const body = at >= 0 ? text.slice(0, at) : text
        const status = at >= 0 ? Number(text.slice(at + STATUS_MARK.length).trim()) || 0 : 0
        resolve({
          ok: status >= 200 && status < 400,
          status,
          body,
          via: `curl via ${proxy}`,
          tookMs: Date.now() - started,
          error: status >= 400 ? String(stderr || '').trim() || null : null,
        })
      },
    )
  })
}

export async function httpGet(url, options) {
  const { timeoutMs = 9000, userAgent = 'dsh-web-search-searxng/0.1', headers, proxy } = options || {}
  if (proxy) return getWithCurl(url, { timeoutMs, userAgent, headers, proxy })
  try {
    return await getWithFetch(url, { timeoutMs, userAgent, headers })
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: '',
      via: 'direct',
      tookMs: 0,
      error: error?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String(error?.message || error),
    }
  }
}
