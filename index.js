/**
 * dsh-web-search-searxng — Host plugin.
 *
 * 一条线：**自己部署 SearXNG → 面板里启停 → 搜索工具用它**。
 *
 * 工具
 *   searxng_search      search / doctor / config / status
 *   searxng_web_search  与内置 web_search 同形的别名（queries: [...]）
 *   searxng_service     status / deploy / start / stop / restart / remove / logs / health
 *
 * 面板（设置页「SearXNG 搜索」）
 *   GET  /dsh-searxng/status    现场快照（docker / 容器 / 镜像 / 健康）
 *   POST /dsh-searxng/action    启停等动作（与工具同一批函数）
 *   GET/POST /dsh-searxng/config 读写配置
 *   GET  /dsh-searxng/logs      容器日志
 *
 * 零外部依赖：只用 node 内置与 ./lib。
 */
import {
  CONFIG_FILE,
  clearRuntimeConfig,
  describeSettings,
  loadSettings,
  normalize,
  writeRuntimeConfig,
} from './lib/settings.js'
import { SearchError, searchSearxng } from './lib/searxng.js'
import { searchBingFallback } from './lib/bing.js'
import { runDoctor } from './lib/doctor.js'
import {
  containerLogs,
  containerState,
  deployContainer,
  dockerProbe,
  healthCheck,
  restartContainer,
  removeContainer,
  snapshot,
  startContainer,
  stopContainer,
} from './lib/service.js'
import { backendAction, backendStatus, resolveBackend } from './lib/backend.js'
import { runtimeStatus, startRuntime } from './lib/runtime.js'
import { registerAdminRoutes } from './lib/admin.js'
import { COMPAT_PROVIDER_IDS, createSearxngProvider, PROVIDER_ID } from './lib/web-provider.js'

// webServer 必须显式 inject：不声明时插件可能在它挂载前 apply，路由会被静默跳过（实测 404）。
export const inject = ['tools', 'webServer']

const PLUGIN_VERSION = '0.2.0'

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function apply(ctx, config) {
  let settings = loadSettings(config)
  const cache = new Map()
  const registered = []
  const failures = []
  let adminState = null
  let webProviderState = null
  let job = { running: false, name: null, startedAt: null, steps: [], result: null }

  const pruneCache = () => {
    if (!settings.cacheTtlMs) return
    const now = Date.now()
    for (const [key, entry] of cache) if (now - entry.at > settings.cacheTtlMs) cache.delete(key)
  }

  const search = async (query, overrides = {}) => {
    const text = asString(query)
    if (!text) throw new SearchError('EMPTY_QUERY', 'query 不能为空', '')

    const cacheKey = JSON.stringify([
      text,
      overrides.count ?? settings.maxResults,
      overrides.language ?? settings.language,
      overrides.categories ?? settings.categories,
      overrides.engines ?? settings.engines,
      overrides.time_range ?? '',
      settings.baseUrl,
      settings.proxy?.enabled ? settings.proxy.url : '',
    ])
    if (settings.cacheTtlMs > 0) {
      pruneCache()
      const hit = cache.get(cacheKey)
      if (hit) return { ...hit.value, cached: true }
    }

    const local = { ...settings }
    if (overrides.count) local.maxResults = Math.max(1, Math.min(20, Number(overrides.count) || settings.maxResults))

    let result
    let primaryError = null
    if (settings.enabled !== false) {
      try {
        result = await searchSearxng(local, text, overrides)
      } catch (error) {
        primaryError = error
      }
    } else {
      primaryError = new SearchError('DISABLED', '插件已禁用（enabled=false）', '')
    }

    if (!result) {
      if (settings.fallback?.enabled !== false) {
        result = await searchBingFallback(local, text, overrides)
        result.primaryError = {
          code: primaryError?.code || 'UNKNOWN',
          message: primaryError?.message || 'SearXNG 不可用',
        }
      } else {
        throw primaryError
      }
    }

    if (settings.cacheTtlMs > 0) cache.set(cacheKey, { at: Date.now(), value: result })
    return { ...result, cached: false }
  }

  // ------------------------------------------------------------ service actions
  const startJob = (name, exec) => {
    if (job.running) {
      return { ok: false, busy: true, error: `正在执行「${job.name}」，等它结束再试` }
    }
    job = { running: true, name, startedAt: Date.now(), steps: [], result: null }
    const onStep = (step) => job.steps.push(step)
    exec(onStep)
      .then((result) => {
        job.result = result
        job.running = false
        job.finishedAt = Date.now()
        if (result?.ok === false) ctx.logger?.warn?.(`[web-search-searxng] ${name} 失败：${result.error}`)
        else ctx.logger?.info?.(`[web-search-searxng] ${name} 完成`)
      })
      .catch((error) => {
        job.result = { ok: false, error: String(error?.message || error) }
        job.running = false
        job.finishedAt = Date.now()
      })
    return { ok: true, started: true, job: name, note: '已开始，轮询 status 看进度' }
  }

  const runServiceAction = async (action, args = {}) => {
    if (action === 'doctor') {
      return runDoctor(settings, { version: PLUGIN_VERSION, tools: registered, configFile: CONFIG_FILE })
    }
    if (action === 'status') {
      const status = await backendStatus(settings)
      return { ...status, job }
    }
    if (action === 'deploy' || action === 'install') {
      return startJob('deploy', (onStep) => backendAction(settings, action, args, { onStep }))
    }
    return await backendAction(settings, action, args)
  }

  const applySettings = (patch) => {
    writeRuntimeConfig(patch || {})
    settings = normalize(loadSettings(config))
    cache.clear()
    return describeSettings(settings)
  }

  // ---------------------------------------------------------------- agent tools
  const tools = ctx.get('tools')
  if (!tools) {
    ctx.logger?.warn?.('[web-search-searxng] tools service unavailable; nothing registered')
    return
  }

  const register = (definition) => {
    try {
      const disposer = tools.register(definition)
      registered.push(definition.name)
      ctx.effect(() => disposer)
      return true
    } catch (error) {
      failures.push({ name: definition.name, error: String(error?.message || error) })
      ctx.logger?.warn?.(`[web-search-searxng] cannot register ${definition.name}: ${String(error?.message || error)}`)
      return false
    }
  }

  const statusValue = () => ({
    ok: registered.length > 0,
    version: PLUGIN_VERSION,
    registeredTools: registered,
    registrationFailures: failures,
    configFile: CONFIG_FILE,
    job,
    panel: adminState,
    webProvider: webProviderState,
    settings: describeSettings(settings),
  })

  const configValue = (args) => {
    if (args?.reset === true) {
      clearRuntimeConfig()
      settings = normalize(loadSettings(config))
      cache.clear()
      return { ok: true, action: 'reset', configFile: CONFIG_FILE, settings: describeSettings(settings) }
    }
    if (args?.set && typeof args.set === 'object') {
      const effective = applySettings(args.set)
      return {
        ok: true,
        action: 'set',
        applied: args.set,
        configFile: CONFIG_FILE,
        settings: effective,
        note: '已写入运行时配置并即时生效（不需要重启）。传 reset:true 可清空回默认。',
      }
    }
    return { ok: true, action: 'get', configFile: CONFIG_FILE, settings: describeSettings(settings) }
  }

  register({
    name: 'searxng_search',
    description:
      '用自建 SearXNG 实例做网页搜索（替代/补充内置 web_search）。' +
      'action=search 传 query 返回结构化结果（标题/链接/摘要/引擎/时间），可带 count、language、categories、engines、time_range、safesearch 覆盖默认值；' +
      'action=doctor 逐项体检（SearXNG 端口、JSON 接口、代理端口与出网、Bing 兜底、工具注册）；' +
      'action=config 读/写运行时配置（set 传对象，reset:true 清空），落盘 ~/.dsh/dsh-web-search-searxng/config.json，改完即时生效；' +
      'action=status 看插件状态。启停容器用 searxng_service。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'doctor', 'config', 'status'],
          description: 'search=搜索；doctor=环境体检；config=读写配置；status=插件状态。',
        },
        query: { type: 'string', description: '搜索词（action=search 必填）。' },
        count: { type: 'number', description: '返回条数 1-20，默认取配置 maxResults。' },
        language: { type: 'string', description: '语言，如 zh-CN / en-US / all。' },
        categories: { type: 'string', description: '分类，如 general / news / it / science，逗号分隔。' },
        engines: { type: 'string', description: '指定引擎，如 google,bing,duckduckgo,baidu；空则用实例默认。' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '时间范围过滤。' },
        safesearch: { type: 'number', description: '0 关 / 1 中 / 2 严。' },
        set: { type: 'object', description: 'action=config 时要写入的配置片段，例如 { "proxy": { "enabled": true, "url": "http://127.0.0.1:7890" } }。' },
        reset: { type: 'boolean', description: 'action=config 时清空运行时配置。' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const action = asString(args?.action) || 'search'
      try {
        if (action === 'search') {
          const result = await search(args?.query, {
            count: args?.count,
            language: asString(args?.language) || undefined,
            categories: asString(args?.categories) || undefined,
            engines: asString(args?.engines) || undefined,
            time_range: asString(args?.time_range) || undefined,
            safesearch: typeof args?.safesearch === 'number' ? args.safesearch : undefined,
          })
          return { ok: true, ...result }
        }
        if (action === 'doctor') {
          return await runDoctor(settings, { version: PLUGIN_VERSION, tools: registered, configFile: CONFIG_FILE })
        }
        if (action === 'config') return configValue(args)
        if (action === 'status') return statusValue()
        return { ok: false, error: `未知 action：${action}（可用 search / doctor / config / status）` }
      } catch (error) {
        if (error instanceof SearchError) {
          return {
            ok: false,
            code: error.code,
            message: error.message,
            detail: error.detail || undefined,
            hint:
              error.code === 'FORMAT_NOT_ENABLED'
                ? 'SearXNG 的 settings.yml → search.formats 需要包含 json，然后重启容器'
                : error.code === 'HTTP_ERROR' || error.code === 'TIMEOUT'
                  ? '跑一次 action=doctor 看是哪一层断了（端口 / JSON / 代理）'
                  : undefined,
          }
        }
        return { ok: false, code: 'INTERNAL', message: String(error?.message || error) }
      }
    },
  })

  register({
    name: 'searxng_service',
    description:
      '管理插件自带的那套 SearXNG（Docker 容器）：status 看现场、deploy 一键部署（检测 Docker→写配置→拉镜像→起容器，异步执行）、' +
      'start / stop / restart / remove、logs 看日志、health 做一次真实查询探活。' +
      'deploy 是异步的：返回 started 后用 status 轮询 job 进度。面板按钮调的是同一批函数。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'deploy', 'install', 'start', 'stop', 'restart', 'remove', 'uninstall', 'logs', 'health', 'versions', 'switch', 'export', 'import'],
          description: '管理动作。deploy/install 按当前后端安装；export 打离线包；import 从离线包装。',
        },
        lines: { type: 'number', description: 'logs 时取最后多少行，默认 40。' },
        name: { type: 'string', description: 'versions 查看后，用 switch 切换到某个已装版本；uninstall 指定要删的版本（省略=当前）。' },
        file: { type: 'string', description: 'export 的输出路径（省略则写到 ~/.dsh/dsh-web-search-searxng/export/）；import 要读的离线包路径。' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      try {
        return await runServiceAction(asString(args?.action), args)
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  })

  if (settings.registerAlias) {
    register({
      name: 'searxng_web_search',
      description:
        '搜索网页（SearXNG 提供，可配置引擎/语言/代理；SearXNG 不可用时降级为 Bing HTML 兜底并标记 degraded）。' +
        'queries 传 1-4 个查询词；返回合并去重后的来源列表。与内置 web_search 同为一次搜索，区别是本工具走自建 SearXNG。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: '1-4 个搜索词。',
          },
        },
        required: ['queries'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const queries = Array.isArray(args?.queries)
          ? args.queries.map(asString).filter(Boolean).slice(0, 4)
          : [asString(args?.queries)].filter(Boolean)
        if (queries.length === 0) return { ok: false, error: 'queries 不能为空' }

        const merged = []
        const seen = new Set()
        let provider = null
        let degraded = false
        const problems = []

        for (const query of queries) {
          try {
            const result = await search(query)
            provider = result.provider
            degraded = degraded || result.degraded === true
            for (const item of result.results) {
              const key = item.url.replace(/[#?].*$/, '').toLowerCase()
              if (seen.has(key)) continue
              seen.add(key)
              merged.push({ ...item, query })
            }
          } catch (error) {
            problems.push({ query, code: error?.code || 'ERROR', message: String(error?.message || error) })
          }
        }

        return {
          ok: merged.length > 0,
          provider,
          degraded,
          queries,
          count: merged.length,
          sources: merged.map((item) => ({ title: item.title, url: item.url })),
          results: merged,
          problems,
          note: degraded ? 'SearXNG 不可用，本次结果来自 Bing HTML 兜底（已标记 degraded）。' : undefined,
        }
      },
    })
  }

  // ------------------------------------------------------- web search provider
  // 内置 web_search 工具走的是 ctx.web.search()；注册 provider 才算真正接管这条链路。
  const webService = ctx.get('web')
  if (webService?.registerSearchProvider) {
    const ids = [PROVIDER_ID, ...COMPAT_PROVIDER_IDS]
    const registeredIds = []
    const failed = []
    for (const id of ids) {
      try {
        const disposer = webService.registerSearchProvider(createSearxngProvider(() => settings, id))
        ctx.effect(() => disposer)
        registeredIds.push(id)
      } catch (error) {
        failed.push({ id, error: String(error?.message || error) })
      }
    }
    webProviderState = { registered: registeredIds.length > 0, ids: registeredIds, failed }
    ctx.logger?.info?.(`[web-search-searxng] 已注册 web 搜索提供者：${registeredIds.join(', ') || 'none'}`)
  } else {
    webProviderState = { registered: false, error: 'web 服务不可用' }
  }

  // -------------------------------------------------------------- panel routes
  const admin = registerAdminRoutes(ctx, {
    getSettings: () => describeSettings(settings),
    applySettings,
    // 面板必须能看到部署进度：裸快照里没有 job，这里补上
    snapshot: async () => ({ ...(await backendStatus(settings)), job }),
    runAction: (action, args) => runServiceAction(action, args),
    logs: (lines) => backendAction(settings, 'logs', { lines }),
  })
  adminState = admin

  ctx.logger?.info?.(
    `[web-search-searxng] v${PLUGIN_VERSION} ready — base ${settings.baseUrl}, tools: ${registered.join(', ') || 'none'}` +
      (admin.registered ? `，panel: ${admin.paths.length} routes` : '，panel: 未注册'),
  )

  // 自启动：按当前后端把已经装了但停着的东西拉起来（不阻塞加载）
  if (settings.service.autoStart) {
    setTimeout(async () => {
      try {
        const backend = await resolveBackend(settings)
        if (backend.kind === 'portable') {
          const state = await runtimeStatus(settings, { health: false })
          if (state.installed && !state.running) {
            ctx.logger?.info?.('[web-search-searxng] autoStart：启动便携运行时')
            await startRuntime(settings)
          }
          return
        }
        if (backend.kind === 'docker') {
          const probe = await dockerProbe()
          if (!probe.engine) return
          const container = await containerState(settings)
          if (container.exists && !container.running) {
            ctx.logger?.info?.('[web-search-searxng] autoStart：启动容器')
            await startContainer(settings)
          }
        }
      } catch {}
    }, 1500)
  }
}
