/**
 * 最小 MCP 客户端（Streamable HTTP + Bearer）。
 *
 * 为什么不复用 `@deepseek-ai/dsh-mcp-client`：那个插件把工具注册给**模型**用；
 * 我们要的是**插件自己**在后台取数入库，拿不到它的进程内句柄。所以这里只实现
 * 我们真正用到的三条：initialize → tools/list → tools/call。
 *
 * 三个实测事实（2026-11-05 用 curl 打过）：
 *   1. Accept 必须同时含 application/json 与 text/event-stream，否则 -32601；
 *   2. 无密钥是 401（不是 400，别把两种错混成「连不上」）；
 *   3. 返回可能是 SSE（text/event-stream），要按 `data:` 行取 JSON-RPC 消息。
 */
const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

export function createMcpClient({ endpoint, secret, logger = console, timeoutMs = 60_000 } = {}) {
  let sessionId = null
  let nextId = 1
  let cached = { connected: false, note: '尚未测试' }

  function headers() {
    const h = { ...JSON_HEADERS, authorization: `Bearer ${secret}` }
    if (sessionId) h['mcp-session-id'] = sessionId
    return h
  }

  /** 一次请求，返回解析后的 JSON-RPC 消息（SSE 或纯 JSON 都吃）。 */
  async function post(payload) {
    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? `请求超时（${timeoutMs}ms）` : error.message
      throw tagged('NETWORK', `网络请求失败：${reason}`, error)
    }

    const sid = response.headers.get('mcp-session-id')
    if (sid && !sessionId) sessionId = sid

    if (response.status === 401) {
      throw tagged('UNAUTHORIZED', '密钥无效或已过期（HTTP 401）')
    }

    const text = await response.text()
    if (!response.ok) {
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        /* 非 JSON 错误体，保留原文 */
      }
      const code = parsed?.code
      if (code === -32601) throw tagged('BAD_ACCEPT', '服务端拒绝了 Accept 头（-32601），检查内容协商')
      throw tagged('HTTP_' + response.status, `服务端返回 HTTP ${response.status}：${parsed?.message ?? text.slice(0, 200)}`)
    }

    if (text.trim() === '') return null // 202 / notification 的正常空响应
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) return pickSse(text, payload.id)
    return JSON.parse(text)
  }

  /** 从 SSE 文本里挑出 id 匹配的那条；没有 id（通知）就取第一条。 */
  function pickSse(text, id) {
    const messages = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (raw === '') continue
      try {
        messages.push(JSON.parse(raw))
      } catch {
        /* 忽略心跳等非 JSON 行 */
      }
    }
    if (messages.length === 0) return null
    return messages.find(message => message.id === id) ?? messages[0]
  }

  function unwrap(message) {
    if (!message) return null
    if (message.error) {
      const error = new Error(message.error.message ?? 'JSON-RPC 调用失败')
      error.rpcCode = message.error.code
      throw error
    }
    return message.result
  }

  async function rpc(method, params) {
    const id = nextId++
    const message = await post({ jsonrpc: '2.0', id, method, params })
    return unwrap(message)
  }

  async function notify(method, params) {
    await post({ jsonrpc: '2.0', method, params })
  }

  async function initialize() {
    const result = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-plugin-sif-ops', version: '0.1.0' },
    })
    await notify('notifications/initialized', {})
    return result
  }

  async function listTools() {
    const result = await rpc('tools/list', {})
    return result?.tools ?? []
  }

  async function callTool(name, args = {}) {
    const result = await rpc('tools/call', { name, arguments: args })
    // MCP 的 isError 只是一面旗，别当成成功
    const text = (result?.content ?? [])
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('')
    if (result?.isError) throw new Error(`工具 ${name} 报错：${text.slice(0, 300)}`)
    try {
      return text === '' ? (result?.structuredContent ?? null) : JSON.parse(text)
    } catch {
      return text
    }
  }

  /** 连通性测试：initialize + tools/list + query_quota（全部 0 点）。 */
  async function test() {
    const started = Date.now()
    const info = await initialize()
    const tools = await listTools()
    let quota = null
    try {
      quota = await callTool('query_quota', {})
    } catch (error) {
      quota = { error: error.message }
    }
    cached = {
      connected: true,
      serverInfo: info?.serverInfo ?? null,
      toolCount: tools.length,
      tools: tools.map(tool => tool.name),
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
    }
    logger.info?.(`[sif-ops] mcp ok: ${info?.serverInfo?.name ?? '?'} / ${tools.length} tools`)
    return { ok: true, ...cached, quota }
  }

  function status() {
    return { ...cached, endpoint, hasSession: sessionId !== null }
  }

  function close() {
    sessionId = null
    cached = { connected: false, note: '已断开' }
  }

  return { test, status, close, callTool, listTools, initialize }
}

function tagged(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  return error
}
