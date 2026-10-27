/**
 * 把 SearXNG 注册成 harness 的「web 搜索提供者」。
 *
 * 为什么不是抢工具名：内置 web_search 工具调用的是 `ctx.web.search()`，
 * 而 web 服务按 provider 解析（配置 id → 唯一可用者）。注册一个 provider 之后，
 * 内置工具、别的 agent、以及任何调用 web.search() 的地方都会自动走 SearXNG ——
 * 抢名字只能影响工具列表，改不了这条链路。
 *
 * 契约（来自 cordis_inspect Service: web）：
 *   WebSearchProvider { id, available(): boolean, search(request, signal): Promise<WebSearchResult> }
 *   WebSearchResult   { content?, sources: [{ url, title?, snippet?, publishedAt? }], truncated }
 */
import { searchSearxng } from './searxng.js'
import { searchBingFallback } from './bing.js'

export const PROVIDER_ID = 'searxng'

/**
 * 兼容别名：harness 的 web 服务里「配置的 provider id」是 `deepseek-official`
 * （见错误 `configured web provider "deepseek-official" is not registered`）。
 * 这个 id 是选择键，不是实现——所以在该 id 空缺时，用同一个实现顶上，
 * 让内置 web_search 不必改任何上层配置就能走 SearXNG。
 */
export const COMPAT_PROVIDER_IDS = ['deepseek-official']

export function createSearxngProvider(getSettings, id = PROVIDER_ID) {
  return {
    id,
    // 只要插件启用就算可用：SearXNG 不可用时内部会降级到 Bing，并如实标注。
    available() {
      const settings = getSettings()
      return settings?.enabled !== false
    },
    async search(request, signal) {
      const settings = getSettings()
      const limit = Math.max(1, Math.min(20, Number(request?.maxResults) || settings.maxResults || 8))
      const query = String(request?.query || '').trim()
      if (!query) return { sources: [], truncated: false }

      let result
      let degraded = false
      try {
        result = await searchSearxng({ ...settings, maxResults: limit }, query)
      } catch (error) {
        if (signal?.aborted) throw error
        result = await searchBingFallback({ ...settings, maxResults: limit }, query)
        degraded = true
      }

      const sources = []
      for (const item of result.results || []) {
        if (!item?.url) continue
        const source = { url: item.url }
        if (item.title) source.title = item.title
        if (item.snippet) source.snippet = item.snippet
        if (item.publishedAt) source.publishedAt = item.publishedAt
        sources.push(source)
      }

      const payload = {
        sources,
        truncated: Boolean(result.results && result.results.length >= limit),
      }
      if (degraded) {
        payload.content = `SearXNG 不可用，本次结果来自 Bing HTML 兜底（${sources.length} 条）。`
      }
      return payload
    },
  }
}
