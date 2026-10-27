/**
 * Settings: defaults → loader config (cordis.patch.yml) → runtime file → env.
 *
 * Runtime file is the "配置入口" that does not need a restart:
 *   ~/.dsh/dsh-web-search-searxng/config.json
 * Written by the tool action `config` (set/reset).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULTS = {
  enabled: true,

  // auto = 便携优先（有 Python 就用运行时，没有再退 Docker）
  backend: 'auto',

  // 便携运行时：免管理员、不依赖 Docker
  runtime: {
    pythonPath: '',
    sourceUrl: '',
    pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    timeoutMs: 600000,
  },

  baseUrl: 'http://127.0.0.1:8080',
  // SearXNG 首次查询某个引擎要现抓页面，20s 是常态；9s 会把「慢」误判成「挂了」。
  timeoutMs: 25000,

  // 默认用国内可达的引擎；换到墙外环境可留空（=用实例自身配置）
  engines: '360so,sogou',
  categories: 'general',
  language: 'zh-CN',
  safesearch: 1,
  maxResults: 8,
  snippetMaxChars: 220,
  dedupe: true,
  cacheTtlMs: 60000,
  userAgent: 'dsh-web-search-searxng/0.1 (+https://github.com/searxng/searxng)',

  proxy: {
    enabled: false,
    url: '',
    mode: 'auto', // auto | direct | always
  },

  fallback: {
    enabled: true,
    provider: 'bing',
    maxResults: 8,
  },

  registerAlias: true,

  // 自部署：插件自己拉镜像、起容器、给面板做启停
  service: {
    containerName: 'dsh-searxng',
    image: 'searxng/searxng:latest',
    port: 8080,
    autoStart: true,
    restartPolicy: 'unless-stopped',
    // 容器内的引擎抓取（Google/Bing…）要不要也走代理。
    // 注意：这和 proxy.* 不是一件事 —— proxy.* 管插件自己发出的搜索请求，
    // 这里管容器里 SearXNG 去抓各个引擎时用不用代理。
    engineProxy: false,
    dataDir: '',
  },
}

/** `DSH_SEARCH_CONFIG_DIR` makes the store relocatable (tests, portable installs, CI). */
export const CONFIG_DIR = process.env.DSH_SEARCH_CONFIG_DIR || join(homedir(), '.dsh', 'dsh-web-search-searxng')
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeDeep(base[key], value) : value
  }
  return out
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function readRuntimeConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return {}
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function writeRuntimeConfig(patch) {
  const current = readRuntimeConfig()
  const next = mergeDeep(current, patch)
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

export function clearRuntimeConfig() {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, '{}\n', 'utf8')
}

/** Env overrides are last so an operator can pin a value without editing files. */
function applyEnv(settings) {
  const env = process.env
  if (env.SEARXNG_BASE_URL) settings.baseUrl = env.SEARXNG_BASE_URL
  if (env.SEARXNG_PROXY) {
    settings.proxy = { ...settings.proxy, enabled: true, url: env.SEARXNG_PROXY }
  }
  if (env.DSH_SEARCH_TIMEOUT_MS) settings.timeoutMs = clampInt(env.DSH_SEARCH_TIMEOUT_MS, 1000, 120000, settings.timeoutMs)
  return settings
}

export function loadSettings(loaderConfig) {
  let settings = mergeDeep(structuredClone(DEFAULTS), loaderConfig || {})
  settings = mergeDeep(settings, readRuntimeConfig())
  settings = applyEnv(settings)
  return normalize(settings)
}

export function normalize(settings) {
  settings.enabled = settings.enabled !== false
  settings.backend = ['auto', 'portable', 'docker', 'external'].includes(settings.backend) ? settings.backend : 'auto'
  settings.baseUrl = String(settings.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')
  settings.timeoutMs = clampInt(settings.timeoutMs, 1000, 120000, DEFAULTS.timeoutMs)
  settings.maxResults = clampInt(settings.maxResults, 1, 20, DEFAULTS.maxResults)
  settings.snippetMaxChars = clampInt(settings.snippetMaxChars, 60, 2000, DEFAULTS.snippetMaxChars)
  settings.safesearch = clampInt(settings.safesearch, 0, 2, DEFAULTS.safesearch)
  settings.cacheTtlMs = clampInt(settings.cacheTtlMs, 0, 3600000, DEFAULTS.cacheTtlMs)
  settings.language = String(settings.language || 'zh-CN')
  settings.categories = String(settings.categories || 'general')
  settings.engines = String(settings.engines || '')
  settings.userAgent = String(settings.userAgent || DEFAULTS.userAgent)

  const proxy = isPlainObject(settings.proxy) ? settings.proxy : {}
  settings.proxy = {
    enabled: proxy.enabled === true,
    url: typeof proxy.url === 'string' ? proxy.url.trim() : '',
    mode: ['auto', 'direct', 'always'].includes(proxy.mode) ? proxy.mode : 'auto',
  }

  const fallback = isPlainObject(settings.fallback) ? settings.fallback : {}
  settings.fallback = {
    enabled: fallback.enabled !== false,
    provider: 'bing',
    maxResults: clampInt(fallback.maxResults, 1, 20, 8),
  }

  settings.registerAlias = settings.registerAlias !== false

  const service = isPlainObject(settings.service) ? settings.service : {}
  const port = clampInt(service.port, 1, 65535, 8080)
  settings.service = {
    containerName: String(service.containerName || 'dsh-searxng'),
    image: String(service.image || 'searxng/searxng:latest'),
    port,
    autoStart: service.autoStart !== false,
    restartPolicy: ['unless-stopped', 'always', 'no', 'on-failure'].includes(service.restartPolicy)
      ? service.restartPolicy
      : 'unless-stopped',
    engineProxy: service.engineProxy === true,
    dataDir: typeof service.dataDir === 'string' && service.dataDir.trim() ? service.dataDir.trim() : join(CONFIG_DIR, 'searxng'),
  }
  // 面板改端口时，baseUrl 跟着走（除非用户显式写了别的 host）
  if (settings.service.port !== 8080 && /^http:\/\/(127\.0\.0\.1|localhost):8080$/.test(settings.baseUrl)) {
    settings.baseUrl = `http://127.0.0.1:${settings.service.port}`
  }

  const runtime = isPlainObject(settings.runtime) ? settings.runtime : {}
  settings.runtime = {
    pythonPath: typeof runtime.pythonPath === 'string' ? runtime.pythonPath.trim() : '',
    sourceUrl: typeof runtime.sourceUrl === 'string' ? runtime.sourceUrl.trim() : '',
    pipIndex:
      typeof runtime.pipIndex === 'string' && runtime.pipIndex.trim()
        ? runtime.pipIndex.trim()
        : 'https://pypi.tuna.tsinghua.edu.cn/simple',
    timeoutMs: clampInt(runtime.timeoutMs, 60000, 3600000, 600000),
  }

  // 便捷别名：运行时与后端都用 settings.port
  settings.port = port
  return settings
}

/** Mask nothing here (no secrets), but keep the view stable for the tool output. */
export function describeSettings(settings) {
  return {
    enabled: settings.enabled,
    backend: settings.backend,
    runtime: settings.runtime,
    baseUrl: settings.baseUrl,
    timeoutMs: settings.timeoutMs,
    engines: settings.engines || '(searxng default)',
    categories: settings.categories,
    language: settings.language,
    safesearch: settings.safesearch,
    maxResults: settings.maxResults,
    snippetMaxChars: settings.snippetMaxChars,
    dedupe: settings.dedupe,
    cacheTtlMs: settings.cacheTtlMs,
    proxy: settings.proxy,
    fallback: settings.fallback,
    registerAlias: settings.registerAlias,
    service: settings.service,
    configFile: CONFIG_FILE,
    source: 'defaults ← cordis.patch.yml ← ~/.dsh/.../config.json ← env',
  }
}
