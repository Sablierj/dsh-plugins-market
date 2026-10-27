/**
 * Environment doctor: answers "why will this not search" with machine-readable
 * checks instead of a stack trace.
 *
 * Every item is { id, label, status: pass|warn|fail, detail, hint }.
 * `hint` is the fix, written so a person can act on it without reading code.
 */
import net from 'node:net'
import { httpGet, resolveProxy } from './transport.js'
import { buildSearchUrl } from './searxng.js'

export function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (ok, message) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, ms: Date.now() - started, message })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, 'connected'))
    socket.once('timeout', () => finish(false, `timeout ${timeoutMs}ms`))
    socket.once('error', (error) => finish(false, error?.code || error?.message || 'error'))
  })
}

function parseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function portOf(url) {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

export async function runDoctor(settings, context = {}) {
  const items = []
  const push = (item) => items.push(item)

  // 1. runtime
  const major = Number(String(process.versions.node || '0').split('.')[0])
  push({
    id: 'runtime',
    label: 'Node 运行时',
    status: major >= 18 ? 'pass' : 'fail',
    detail: `node ${process.versions.node} / ${process.platform}`,
    hint: major >= 18 ? '' : '需要 Node 18+（fetch 与 AbortSignal.timeout）',
  })

  // 2. config shape
  const base = parseUrl(settings.baseUrl)
  push({
    id: 'config.baseUrl',
    label: 'SearXNG 地址',
    status: base && /^https?:$/.test(base.protocol) ? 'pass' : 'fail',
    detail: settings.baseUrl,
    hint: base ? '' : 'baseUrl 必须是 http(s)://host:port，例如 http://127.0.0.1:8080',
  })

  // 3. TCP reachability of SearXNG
  if (base) {
    const probe = await tcpProbe(base.hostname, portOf(base), 2500)
    push({
      id: 'searxng.tcp',
      label: 'SearXNG 端口可达',
      status: probe.ok ? 'pass' : 'fail',
      detail: `${base.hostname}:${portOf(base)} → ${probe.message} (${probe.ms}ms)`,
      hint: probe.ok
        ? ''
        : process.platform === 'win32'
          ? '先确认 SearXNG 真的在跑：docker ps | Select-String searxng；WSL 未启动时 wsl.exe 会报 E_ACCESSDENIED'
          : '先确认 SearXNG 容器/进程在跑：docker ps | grep searxng',
    })
  } else {
    push({ id: 'searxng.tcp', label: 'SearXNG 端口可达', status: 'fail', detail: 'baseUrl 无法解析', hint: '先修 baseUrl' })
  }

  // 4. JSON format actually enabled
  let searxngOk = false
  if (base) {
    const url = buildSearchUrl({ ...settings, maxResults: 5 }, 'dsh doctor probe')
    const response = await httpGet(url, {
      timeoutMs: Math.min(settings.timeoutMs, 8000),
      userAgent: settings.userAgent,
      proxy: resolveProxy(settings),
      headers: { accept: 'application/json' },
    })
    const text = String(response.body || '').trim()
    if (!response.ok) {
      const hint =
        response.status === 403 || text.startsWith('<')
          ? '实例未开 json：编辑 searxng/settings.yml → search.formats 加 - json，然后重启容器'
          : `SearXNG 返回 HTTP ${response.status}；检查容器日志`
      push({ id: 'searxng.json', label: 'JSON 搜索接口', status: 'fail', detail: `HTTP ${response.status || '无响应'}`, hint })
    } else if (text.startsWith('<')) {
      push({
        id: 'searxng.json',
        label: 'JSON 搜索接口',
        status: 'fail',
        detail: '返回 HTML',
        hint: 'settings.yml → search.formats 里加 json（只加 html 不够），重启生效',
      })
    } else {
      try {
        const payload = JSON.parse(text)
        const count = Array.isArray(payload.results) ? payload.results.length : 0
        searxngOk = true
        push({
          id: 'searxng.json',
          label: 'JSON 搜索接口',
          status: count > 0 ? 'pass' : 'warn',
          detail: `HTTP ${response.status} · ${count} 条 · ${response.tookMs}ms · ${response.via}`,
          hint: count > 0 ? '' : '接口通了但没结果：检查实例的 engines 是否可用（部分引擎在墙外会超时）',
        })
      } catch (error) {
        push({
          id: 'searxng.json',
          label: 'JSON 搜索接口',
          status: 'fail',
          detail: `JSON 解析失败：${String(error?.message || error)}`,
          hint: '确认访问的是 /search?format=json，而不是 HTML 页面',
        })
      }
    }
  } else {
    push({ id: 'searxng.json', label: 'JSON 搜索接口', status: 'fail', detail: '跳过（baseUrl 无效）', hint: '' })
  }

  // 5-7. proxy
  const proxy = settings.proxy || {}
  if (!proxy.enabled || !proxy.url) {
    push({
      id: 'proxy.config',
      label: '代理配置',
      status: 'warn',
      detail: '未启用（直连）',
      hint: '需要翻墙/绕行时：searxng_search { action:"config", set:{ proxy:{ enabled:true, url:"http://127.0.0.1:7890" } } }',
    })
  } else {
    const proxyUrl = parseUrl(proxy.url)
    push({
      id: 'proxy.config',
      label: '代理配置',
      status: proxyUrl ? 'pass' : 'fail',
      detail: proxy.url,
      hint: proxyUrl ? '' : '代理地址格式：http://127.0.0.1:7890 或 socks5://127.0.0.1:7891',
    })
    if (proxyUrl) {
      const probe = await tcpProbe(proxyUrl.hostname, portOf(proxyUrl), 2500)
      push({
        id: 'proxy.tcp',
        label: '代理端口可达',
        status: probe.ok ? 'pass' : 'fail',
        detail: `${proxyUrl.hostname}:${portOf(proxyUrl)} → ${probe.message}`,
        hint: probe.ok ? '' : 'Clash 没开或端口不对：Clash 默认 http 7890 / socks5 7891，混合端口 7890 两种都支持',
      })
      if (probe.ok) {
        const started = Date.now()
        const e2e = await httpGet('https://www.google.com/generate_204', {
          timeoutMs: Math.min(settings.timeoutMs, 10000),
          userAgent: settings.userAgent,
          proxy: proxy.url,
          headers: { accept: '*/*' },
        })
        push({
          id: 'proxy.e2e',
          label: '代理出网（google 204）',
          status: e2e.ok ? 'pass' : 'warn',
          detail: e2e.ok ? `HTTP ${e2e.status} · ${Date.now() - started}ms` : `失败：${e2e.error || e2e.status}`,
          hint: e2e.ok ? '' : '代理端口通但出不了网：检查 Clash 节点是否可用 / 规则是否把 google 走了直连',
        })
      }
    }
  }

  // 8. fallback
  if (settings.fallback?.enabled !== false) {
    const started = Date.now()
    const response = await httpGet('https://cn.bing.com/search?q=dsh+probe', {
      timeoutMs: Math.min(settings.timeoutMs, 8000),
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      proxy: resolveProxy(settings),
      headers: { accept: 'text/html' },
    })
    push({
      id: 'fallback.bing',
      label: 'Bing 兜底可用',
      status: response.ok ? 'pass' : 'warn',
      detail: `HTTP ${response.status || '无响应'} · ${Date.now() - started}ms`,
      hint: response.ok ? '' : '兜底不可用；SearXNG 挂了时会直接报错而不是返回空结果',
    })
  } else {
    push({ id: 'fallback.bing', label: 'Bing 兜底可用', status: 'warn', detail: '已关闭', hint: 'fallback.enabled=false 时，SearXNG 故障会直接失败' })
  }

  // 9. tools
  const tools = Array.isArray(context.tools) ? context.tools : []
  push({
    id: 'tools',
    label: '工具注册',
    status: tools.includes('searxng_search') ? 'pass' : 'fail',
    detail: tools.length ? tools.join(', ') : '(none)',
    hint: tools.length ? '' : 'tools 服务未就绪，或 apply() 没跑到注册那一步',
  })

  const counts = { pass: 0, warn: 0, fail: 0 }
  for (const item of items) counts[item.status] += 1
  return {
    ok: counts.fail === 0,
    version: context.version,
    summary: counts,
    canSearch: searxngOk,
    effectiveProvider: searxngOk ? 'searxng' : settings.fallback?.enabled !== false ? 'bing-fallback' : 'none',
    items,
    configFile: context.configFile,
    registeredTools: tools,
  }
}
