/**
 * dsh-session-model-bridge — Host plugin.
 *
 * Starts a local, OpenAI- and Anthropic-compatible HTTP endpoint that serves ONE
 * unified model name (default `dsh-session`) and routes every request to whatever
 * model the owning DSH session currently has selected. Other agents (Claude Code,
 * Codex, any OpenAI/Anthropic SDK client, DSH's own subagent backends) then use
 * that free/local model through a normal base URL + API key.
 *
 * Design notes:
 * - The backend is resolved LIVE per request from the source session's
 *   `requestContext()`, so switching models mid-conversation changes what the
 *   bridge serves without touching client config.
 * - Tokens are per session and persisted under `~/.dsh/session-model-bridge/state.json`
 *   so that other agents keep working across Harness restarts.
 * - No external imports: only Node builtins and this package's own modules, so a
 *   linked workspace install resolves nothing from the profile.
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { describeError, fail } from './lib/bridge-core.js'
import { handleChatCompletions, listModels } from './lib/openai.js'
import { handleMessages } from './lib/anthropic.js'

/** The `tools` service must exist before this plugin registers its agent tool. */
export const inject = ['tools']

/** Reported by `GET /healthz` and by the agent tool's `status` action. */
const PLUGIN_VERSION = '0.1.0'

const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 8788,
  modelName: 'dsh-session',
  autoPublish: true,
  requireToken: true,
  allowTokenless: false,
  maxTokens: 8192,
  requestTimeoutMs: 900000,
  maxBodyBytes: 32 * 1024 * 1024,
  logRequests: true,
  corsOrigin: '*',
  statePath: '',
  fallbackToDefaultModel: true,
}

const MAX_LOG_ENTRIES = 30

/** Wording the OpenCode Zen provider uses for the placeholders it declares itself. */
const ZEN_PLACEHOLDER_TEXT = 'Requirement placeholder from OpenCode Zen: this harness cannot execute it.'

/** One declared-but-inert tool, shaped like the provider's own placeholder. */
function placeholderTool(name, property) {
  return {
    name,
    description: ZEN_PLACEHOLDER_TEXT,
    parameters: {
      type: 'object',
      properties: { [property]: { type: 'string', description: ZEN_PLACEHOLDER_TEXT } },
      required: [property],
    },
  }
}

/**
 * Providers whose upstream gate inspects the declared tool list.
 *
 * The OpenCode Zen free tier answers any request that does not declare lowercase
 * `bash` and `read` with `403 FreeTierError`, and the free provider only pads its
 * own in-harness requests (it rewrites the transcript's leading system message,
 * which a bridged request does not have). Verified through this bridge: no tools
 * -> FreeTierError, `bash`+`read` declared -> normal completion. So the transport
 * declares the same placeholders for that provider only.
 *
 * Replace or extend with `providerTools: { "<provider>": [ToolSchema, ...] }`, or
 * disable the built-ins entirely with `providerTools: false`.
 */
const BUILTIN_PROVIDER_TOOLS = {
  'opencode-zen-free-provider': [placeholderTool('bash', 'command'), placeholderTool('read', 'file_path')],
}

/** Build the effective settings from the loader entry's `config`. */
function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const settings = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue
    settings[key] = value
  }
  settings.port = Number.isFinite(settings.port) ? Math.trunc(settings.port) : DEFAULTS.port
  settings.maxTokens = Number.isFinite(settings.maxTokens) ? Math.trunc(settings.maxTokens) : DEFAULTS.maxTokens
  settings.requestTimeoutMs = Number.isFinite(settings.requestTimeoutMs) ? Math.trunc(settings.requestTimeoutMs) : DEFAULTS.requestTimeoutMs
  settings.maxBodyBytes = Number.isFinite(settings.maxBodyBytes) ? Math.trunc(settings.maxBodyBytes) : DEFAULTS.maxBodyBytes
  settings.modelName = typeof settings.modelName === 'string' && settings.modelName.length > 0 ? settings.modelName : DEFAULTS.modelName
  settings.host = typeof settings.host === 'string' && settings.host.length > 0 ? settings.host : DEFAULTS.host
  settings.statePath = typeof settings.statePath === 'string' && settings.statePath.length > 0
    ? settings.statePath
    : join(homedir(), '.dsh', 'session-model-bridge', 'state.json')
  return settings
}

/** Short, stable, human-recognizable name for a session. */
function sessionLabel(sessionId, session) {
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    const parts = cwd.replaceAll('\\', '/').split('/').filter(Boolean)
    const tail = parts[parts.length - 1]
    if (tail) return `${tail} · ${sessionId}`
  }
  return sessionId
}

/** `sk-dsh-…` token: enough entropy for a loopback-only service, stable per session. */
function mintToken() {
  return `sk-dsh-${randomBytes(16).toString('hex')}`
}

export function apply(ctx, config) {
  const settings = resolveSettings(config)
  if (settings.enabled === false) {
    ctx.logger?.info?.('[session-model-bridge] disabled by config')
    return
  }

  /** Provider id → tools the upstream gate requires to be declared. */
  const providerTools =
    settings.providerTools === false ? {} : { ...BUILTIN_PROVIDER_TOOLS, ...(settings.providerTools ?? {}) }

  /** Append the provider's required placeholders, leaving a compliant list untouched. */
  function withProviderTools(provider, tools) {
    const extra = providerTools[provider]
    if (!Array.isArray(extra) || extra.length === 0) return tools
    const declared = new Set((Array.isArray(tools) ? tools : []).map((tool) => tool?.name))
    const missing = extra.filter((tool) => !declared.has(tool?.name))
    if (missing.length === 0) return tools
    return [...(Array.isArray(tools) ? tools : []), ...missing]
  }

  /** @type {Map<string, object>} token → target */  const targets = new Map()
  /** @type {Map<string, string>} sessionId → token */
  const bySession = new Map()
  /** @type {object[]} newest-last request log */
  const requestLog = []
  const state = { server: undefined, status: 'starting', error: undefined, startedAt: Date.now() }

  // ---------------------------------------------------------------- persistence

  function loadPersisted() {
    try {
      const parsed = JSON.parse(readFileSync(settings.statePath, 'utf8'))
      return parsed && typeof parsed === 'object' && parsed.targets && typeof parsed.targets === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  function persist() {
    const snapshot = {
      version: 1,
      updatedAt: new Date().toISOString(),
      targets: {},
    }
    for (const [sessionId, token] of bySession) {
      const target = targets.get(token)
      if (!target) continue
      snapshot.targets[sessionId] = {
        token,
        label: target.label,
        pinned: target.pinned,
        lastKnown: target.lastKnown,
      }
    }
    try {
      mkdirSync(dirname(settings.statePath), { recursive: true })
      writeFileSync(settings.statePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      return true
    } catch (error) {
      ctx.logger?.warn?.(`[session-model-bridge] cannot persist state to ${settings.statePath}: ${error?.message ?? error}`)
      return false
    }
  }

  const persisted = loadPersisted()

  // ------------------------------------------------------------------- targets

  function ensureTarget(sessionId, options = {}) {
    const existingToken = bySession.get(sessionId)
    if (existingToken) {
      const target = targets.get(existingToken)
      if (target) {
        if (options.label && options.label !== target.label) target.label = options.label
        if (options.persist !== false) persist()
        return target
      }
    }
    const stored = persisted?.targets?.[sessionId]
    const token = typeof stored?.token === 'string' && stored.token.length > 0 ? stored.token : mintToken()
    const target = {
      token,
      sessionId,
      label: options.label ?? stored?.label ?? sessionId,
      pinned: stored?.pinned ?? null,
      lastKnown: stored?.lastKnown ?? null,
      createdAt: Date.now(),
      requests: 0,
      lastUsedAt: null,
      lastError: null,
    }
    // A token must never address two sessions.
    for (const [otherToken, other] of targets) {
      if (otherToken === token && other.sessionId !== sessionId) {
        target.token = mintToken()
        break
      }
    }
    targets.set(target.token, target)
    bySession.set(sessionId, target.token)
    if (options.persist !== false) persist()
    return target
  }

  function syncLiveSessions() {
    const sessions = ctx.get('sessions')
    if (!sessions) return
    for (const session of sessions.list()) {
      ensureTarget(session.id, { label: sessionLabel(session.id, session), persist: false })
    }
    persist()
  }

  // ------------------------------------------------------------------ backends

  /**
   * Resolve the model this target should call right now.
   * @returns {{provider: string, model: string, sessionId: string|null, label: string, stale: boolean, source: string}}
   */
  function resolveBackend(target) {
    if (target.pinned?.provider && target.pinned?.model) {
      return { ...target.pinned, sessionId: target.sessionId, label: target.label, stale: false, source: 'pinned' }
    }
    const session = ctx.get('sessions')?.get(target.sessionId)
    if (session) {
      const context = typeof session.requestContext === 'function' ? session.requestContext() : undefined
      if (context?.provider && context?.model) {
        target.lastKnown = { provider: context.provider, model: context.model }
        return { provider: context.provider, model: context.model, sessionId: target.sessionId, label: target.label, stale: false, source: 'session' }
      }
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
      if (header?.config?.provider && header?.config?.model) {
        target.lastKnown = { provider: header.config.provider, model: header.config.model }
        return { provider: header.config.provider, model: header.config.model, sessionId: target.sessionId, label: target.label, stale: false, source: 'session' }
      }
    }
    if (target.lastKnown?.provider && target.lastKnown?.model) {
      target.lastKnown = { provider: target.lastKnown.provider, model: target.lastKnown.model }
      return { ...target.lastKnown, sessionId: target.sessionId, label: target.label, stale: true, source: 'cached' }
    }
    if (settings.fallbackToDefaultModel) {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        target.lastKnown = { provider: selection.provider, model: selection.model }
        return { provider: selection.provider, model: selection.model, sessionId: target.sessionId, label: target.label, stale: false, source: 'default' }
      }
    }
    throw fail(409, 'no_backend', `会话 ${target.sessionId} 还没有选择模型（该会话未发过请求且无默认模型）。先在会话里选一个模型再试。`)
  }

  function streamModel(backend, options, signal) {
    const llm = ctx.get('llm')
    if (!llm) throw fail(503, 'llm_unavailable', 'llm 服务不可用')
    const tools = withProviderTools(backend.provider, options.tools)
    return llm.stream({
      provider: backend.provider,
      model: backend.model,
      messages: options.messages,
      ...(options.system ? { system: options.system } : {}),
      ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
      ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
      maxTokens: options.maxTokens ?? settings.maxTokens,
      ...(Array.isArray(options.stop) && options.stop.length > 0 ? { stop: options.stop } : {}),
      signal,
    })
  }

  // -------------------------------------------------------------- http plumbing

  function record(entry) {
    requestLog.push(entry)
    if (requestLog.length > MAX_LOG_ENTRIES) requestLog.shift()
    if (settings.logRequests) {
      ctx.logger?.info?.(`[session-model-bridge] ${entry.protocol} ${entry.status} ${entry.provider}/${entry.model} ${entry.ms}ms${entry.stream ? ' (stream)' : ''}`)
    }
  }

  function errorPayload(protocol, status, code, message) {
    if (protocol === 'anthropic') {
      const type = status === 401 ? 'authentication_error' : status >= 500 ? 'api_error' : 'invalid_request_error'
      return { type: 'error', error: { type, message, code } }
    }
    const type = status === 401 ? 'invalid_request_error' : status >= 500 ? 'api_error' : 'invalid_request_error'
    return { error: { message, type, code } }
  }

  function makeResponders(res, protocol) {
    let started = false
    return {
      get started() { return started },
      sendJson(status, payload) {
        if (started) return
        const body = JSON.stringify(payload)
        started = true
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      },
      sse: {
        start() {
          if (started) return
          started = true
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
        },
        send(payload) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
        },
        event(name, payload) {
          res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
        },
        end() {
          if (!started) {
            this.start()
          }
          // OpenAI clients expect the `[DONE]` sentinel; Anthropic clients
          // treat the final `message_stop` event as the end of the stream.
          if (protocol === 'openai' && !res.writableEnded) {
            res.write('data: [DONE]\n\n')
          }
          if (!res.writableEnded) res.end()
        },
      },
    }
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > settings.maxBodyBytes) {
        throw fail(413, 'payload_too_large', `请求体超过 ${settings.maxBodyBytes} 字节上限`)
      }
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim().length === 0) return {}
    try {
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('body must be a JSON object')
      }
      return parsed
    } catch (error) {
      throw fail(400, 'invalid_json', `请求体不是合法 JSON 对象：${error?.message ?? error}`)
    }
  }

  function bearerToken(req, url) {
    const header = req.headers.authorization
    if (typeof header === 'string' && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim()
    const apiKey = req.headers['x-api-key']
    if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey.trim()
    for (const key of ['key', 'api_key', 'token']) {
      const value = url.searchParams.get(key)
      if (value) return value.trim()
    }
    return undefined
  }

  async function handleRequest(req, res) {
    const started = Date.now()
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const protocol = path.startsWith('/v1/messages') || path === '/messages' ? 'anthropic' : 'openai'
    const responders = makeResponders(res, protocol)

    res.setHeader('access-control-allow-origin', settings.corsOrigin)
    res.setHeader('access-control-allow-headers', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('access-control-expose-headers', '*')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const isMessages = path === '/v1/messages' || path === '/messages'
    const isCompletions = path === '/v1/chat/completions' || path === '/chat/completions'
    const isModels = path === '/v1/models' || path === '/models'
    const isHealth = path === '/healthz' || path === '/'

    if (isHealth) {
      responders.sendJson(200, {
        ok: true,
        plugin: 'dsh-session-model-bridge',
        version: PLUGIN_VERSION,
        status: state.status,
        model: settings.modelName,
        port: settings.port,
        host: settings.host,
        targets: targets.size,
        extraTools: Object.keys(providerTools),
        endpoints: ['/v1/models', '/v1/chat/completions', '/v1/messages'],
      })
      return
    }

    const token = bearerToken(req, url)
    const target = token ? targets.get(token) : undefined
    if (settings.requireToken && settings.allowTokenless !== true && !target) {
      const message = token
        ? 'API key 无效：该 token 不属于任何会话（Harness 重启后令牌会从 ~/.dsh/session-model-bridge/state.json 恢复）'
        : '缺少 API key：请在 Authorization: Bearer <token> 或 x-api-key 中带上会话令牌'
      responders.sendJson(401, errorPayload(protocol, 401, 'invalid_api_key', message))
      record({ time: Date.now(), protocol, path, status: 401, stream: false, provider: '-', model: '-', ms: Date.now() - started })
      return
    }

    if (!isModels && !isCompletions && !isMessages) {
      responders.sendJson(404, errorPayload(protocol, 404, 'not_found', `未知端点 ${path}`))
      return
    }

    if (req.method === 'GET') {
      if (!isModels) {
        responders.sendJson(405, errorPayload(protocol, 405, 'method_not_allowed', `GET ${path} 不支持`))
        return
      }
      let modelsBackend
      if (target) {
        try {
          modelsBackend = resolveBackend(target)
        } catch {
          modelsBackend = undefined
        }
      }
      await listModels({
        modelName: settings.modelName,
        backend: modelsBackend,
        signal: new AbortController().signal,
        streamModel: undefined,
        sendJson: responders.sendJson,
        sse: responders.sse,
        log: () => {},
      })
      return
    }

    if (req.method !== 'POST') {
      responders.sendJson(405, errorPayload(protocol, 405, 'method_not_allowed', `${req.method} ${path} 不支持`))
      return
    }

    let body
    try {
      body = await readBody(req)
    } catch (error) {
      const info = describeError(error)
      responders.sendJson(info.status, errorPayload(protocol, info.status, info.code, info.message))
      return
    }

    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) controller.abort(new Error('client disconnected'))
    }
    res.on('close', onClose)
    const timeout = settings.requestTimeoutMs > 0 ? setTimeout(() => controller.abort(new Error('bridge request timeout')), settings.requestTimeoutMs) : undefined

    if (!target) {
      responders.sendJson(
        400,
        errorPayload(protocol, 400, 'missing_session', '本服务用会话令牌来确定后端模型；请用 Authorization: Bearer <token> 指定一个会话（见 session_model_bridge 工具）。'),
      )
      return
    }

    let backend
    try {
      backend = resolveBackend(target)
    } catch (error) {
      const info = describeError(error)
      target.lastError = info.message
      responders.sendJson(info.status, errorPayload(protocol, info.status, info.code, info.message))
      record({ time: Date.now(), protocol, path, status: info.status, stream: false, provider: '-', model: '-', ms: Date.now() - started })
      return
    }

    const api = {
      modelName: settings.modelName,
      backend,
      signal: controller.signal,
      streamModel: (options) => streamModel(backend, options, controller.signal),
      sendJson: responders.sendJson,
      sse: responders.sse,
      log: (message, data) => ctx.logger?.debug?.(`[session-model-bridge] ${message}`, data),
    }

    target.requests += 1
    target.lastUsedAt = Date.now()
    target.lastError = null
    persist()

    const stream = body.stream === true
    try {
      if (isCompletions) {
        await handleChatCompletions(body, api)
      } else {
        await handleMessages(body, api)
      }
      record({
        time: Date.now(),
        protocol,
        path,
        status: 200,
        stream,
        provider: backend.provider,
        model: backend.model,
        sessionId: target.sessionId,
        ms: Date.now() - started,
      })
    } catch (error) {
      const info = describeError(error)
      target.lastError = info.message
      ctx.logger?.warn?.(`[session-model-bridge] ${protocol} ${path} failed: ${info.message}`)
      if (!responders.started) {
        responders.sendJson(info.status, errorPayload(protocol, info.status, info.code, info.message))
      } else if (!res.writableEnded) {
        res.end()
      }
      record({
        time: Date.now(),
        protocol,
        path,
        status: info.status,
        stream,
        provider: backend.provider,
        model: backend.model,
        sessionId: target.sessionId,
        error: info.message,
        ms: Date.now() - started,
      })
    } finally {
      if (timeout) clearTimeout(timeout)
      res.off('close', onClose)
      if (!res.writableEnded) res.end()
    }
  }

  // ------------------------------------------------------------------- server

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      ctx.logger?.error?.(`[session-model-bridge] unhandled: ${error?.stack ?? error}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(errorPayload('openai', 500, 'bridge_error', String(error?.message ?? error))))
      } else if (!res.writableEnded) {
        res.end()
      }
    })
  })

  server.on('error', (error) => {
    state.status = 'error'
    state.error = String(error?.message ?? error)
    ctx.logger?.error?.(`[session-model-bridge] listen ${settings.host}:${settings.port} failed: ${state.error}`)
  })

  server.listen(settings.port, settings.host, () => {
    state.status = 'listening'
    ctx.logger?.info?.(`[session-model-bridge] listening on http://${settings.host}:${settings.port} (model "${settings.modelName}")`)
  })

  ctx.effect(() => {
    state.running = true
    return () => {
      server.close()
      state.status = 'closed'
    }
  })

  // -------------------------------------------------------------- agent tools

  const tools = ctx.get('tools')
  if (tools) {
    const baseUrl = () => `http://${settings.host === '0.0.0.0' ? '127.0.0.1' : settings.host}:${settings.port}`

    const toolValue = (args, exec) => {
      const sessionId = exec?.agent?.id
      const action = typeof args?.action === 'string' ? args.action : 'status'
      const session = sessionId ? ctx.get('sessions')?.get(sessionId) : undefined
      const self = sessionId ? ensureTarget(sessionId, { label: sessionLabel(sessionId, session) }) : undefined
      const targetView = (target, reveal) => {
        let backend
        try {
          backend = resolveBackend(target)
        } catch (error) {
          backend = { error: describeError(error).message }
        }
        return {
          sessionId: target.sessionId,
          label: target.label,
          apiKey: reveal ? target.token : `${target.token.slice(0, 12)}…${target.token.slice(-4)}`,
          model: settings.modelName,
          backend,
          pinned: target.pinned,
          requests: target.requests,
          lastUsedAt: target.lastUsedAt ? new Date(target.lastUsedAt).toISOString() : null,
          lastError: target.lastError ?? null,
        }
      }

      switch (action) {
        case 'status': {
          return {
            ok: state.status === 'listening',
            version: PLUGIN_VERSION,
            status: state.status,
            error: state.error ?? null,
            baseUrl: baseUrl(),
            model: settings.modelName,
            config: {
              host: settings.host,
              port: settings.port,
              requireToken: settings.requireToken,
              autoPublish: settings.autoPublish,
              maxTokens: settings.maxTokens,
              statePath: settings.statePath,
            },
            targets: targets.size,
            recentRequests: requestLog.slice(-5).reverse(),
          }
        }
        case 'publish': {
          if (!self) return { ok: false, error: '当前调用没有关联会话，无法发布（请在某个会话里调用本工具）' }
          const view = targetView(self, true)
          const origin = baseUrl()
          return {
            ok: true,
            sessionId: self.sessionId,
            baseUrl: `${origin}/v1`,
            origin,
            model: settings.modelName,
            apiKey: self.token,
            backend: view.backend,
            note: '把下面的环境变量交给其他 agent 即可；后台模型始终跟随本会话当前选择的模型。',
            clients: {
              claudeCode: {
                env: {
                  ANTHROPIC_BASE_URL: origin,
                  ANTHROPIC_AUTH_TOKEN: self.token,
                  ANTHROPIC_MODEL: settings.modelName,
                  ANTHROPIC_SMALL_FAST_MODEL: settings.modelName,
                },
              },
              openaiCompatible: {
                env: {
                  OPENAI_BASE_URL: `${origin}/v1`,
                  OPENAI_API_KEY: self.token,
                  OPENAI_MODEL: settings.modelName,
                },
              },
              curl: `curl ${origin}/v1/chat/completions -H "Authorization: Bearer ${self.token}" -H "content-type: application/json" -d '{"model":"${settings.modelName}","messages":[{"role":"user","content":"ping"}]}'`,
            },
          }
        }
        case 'list': {
          const reveal = args?.reveal === true
          return {
            ok: true,
            baseUrl: baseUrl(),
            model: settings.modelName,
            targets: [...targets.values()].map((target) => ({
              ...targetView(target, reveal),
              current: target.sessionId === sessionId,
            })),
          }
        }
        case 'revoke': {
          const all = args?.all === true
          const token = typeof args?.apiKey === 'string' && args.apiKey.length > 0 ? args.apiKey : self?.token
          if (all) {
            const count = targets.size
            targets.clear()
            bySession.clear()
            persist()
            return { ok: true, revoked: count }
          }
          if (!token) return { ok: false, error: '未指定 apiKey，且当前会话没有令牌' }
          const target = targets.get(token)
          if (!target) return { ok: false, error: '未找到该 apiKey 对应的会话' }
          targets.delete(token)
          bySession.delete(target.sessionId)
          persist()
          return { ok: true, revoked: 1, sessionId: target.sessionId }
        }
        case 'pin': {
          if (!self) return { ok: false, error: '当前调用没有关联会话' }
          const provider = args?.provider
          const model = args?.model
          if (typeof provider !== 'string' || typeof model !== 'string' || provider.length === 0 || model.length === 0) {
            self.pinned = null
            persist()
            return { ok: true, pinned: null, note: '已取消固定，后端重新跟随会话当前模型。' }
          }
          self.pinned = { provider, model }
          persist()
          return { ok: true, pinned: { provider, model } }
        }
        default:
          return { ok: false, error: `未知 action：${action}（可用：status / publish / list / revoke / pin）` }
      }
    }

    const outputSchema = {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        status: { type: 'string' },
        baseUrl: { type: 'string' },
        model: { type: 'string' },
        apiKey: { type: 'string' },
        targets: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    }

    const disposer = tools.register({
      name: 'session_model_bridge',
      description:
        '把「当前会话正在使用的模型」通过本机 HTTP 反代出去，供其他 agent 使用：统一模型名（默认 dsh-session），后台模型始终等于本会话当前选择的模型（含免费模型）。' +
        'action=publish 返回 baseUrl + apiKey + 各客户端环境变量（Claude Code / OpenAI 兼容 / curl）；action=list 查看所有会话的令牌与当前后端；action=status 查看服务状态；action=revoke 吊销令牌；action=pin 固定到指定 provider/model（不带参数则取消固定）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'publish', 'list', 'revoke', 'pin'],
            description: 'status=服务状态；publish=发布当前会话并返回可抄的配置；list=列出全部会话令牌；revoke=吊销令牌；pin=固定后端模型。',
          },
          reveal: { type: 'boolean', description: 'list 时显示完整 apiKey（默认打码）。' },
          apiKey: { type: 'string', description: 'revoke 时指定要吊销的令牌，默认吊销当前会话的令牌。' },
          all: { type: 'boolean', description: 'revoke 时吊销全部令牌。' },
          provider: { type: 'string', description: 'pin 时的 provider 路由名，省略则取消固定。' },
          model: { type: 'string', description: 'pin 时的模型 id。' },
        },
        required: ['action'],
      },
      output: {
        schema: outputSchema,
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args, exec) {
        return toolValue(args, exec)
      },
    })

    ctx.effect(() => disposer)
  } else {
    ctx.logger?.warn?.('[session-model-bridge] tools service unavailable; agent tool not registered')
  }

  // Auto-publish: one stable token per live session, including sessions that
  // already existed when this plugin mounted.
  syncLiveSessions()
  ctx.on('session/created', (session) => {
    if (settings.autoPublish === false) return
    ensureTarget(session.id, { label: sessionLabel(session.id, session) })
  })

  ctx.logger?.info?.(
    `[session-model-bridge] ready — model "${settings.modelName}" on ${settings.host}:${settings.port}, ${targets.size} session token(s)`,
  )
}
