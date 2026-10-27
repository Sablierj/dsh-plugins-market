/**
 * SearXNG client: build the query URL, call it, normalize the JSON.
 *
 * JSON output must be enabled on the instance:
 *   searxng/settings.yml
 *   search:
 *     formats:
 *       - html
 *       - json
 * Without it SearXNG answers 403 / HTML, and that is reported as
 * FORMAT_NOT_ENABLED instead of being reported as "no results".
 */
import { httpGet, resolveProxy } from './transport.js'

export class SearchError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'SearchError'
    this.code = code
    this.detail = detail
  }
}

export function buildSearchUrl(settings, query, overrides = {}) {
  const url = new URL(`${settings.baseUrl.replace(/\/+$/, '')}/search`)
  const params = url.searchParams
  params.set('q', query)
  params.set('format', 'json')
  params.set('categories', overrides.categories || settings.categories || 'general')
  params.set('language', overrides.language || settings.language || 'zh-CN')
  params.set('safesearch', String(overrides.safesearch ?? settings.safesearch))
  params.set('pageno', '1')
  const engines = overrides.engines || settings.engines
  if (engines) params.set('engines', engines)
  const timeRange = overrides.time_range || overrides.timeRange
  if (timeRange) params.set('time_range', timeRange)
  return url.toString()
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

export function cleanText(input, maxChars) {
  let text = String(input ?? '')
  text = text.replace(/<[^>]+>/g, ' ')
  text = text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
  // Anything still looking like an entity is a decode miss (e.g. &ensp;, &mdash;):
  // drop it to a space rather than leaking it into the snippet.
  text = text.replace(/&[a-zA-Z][a-zA-Z0-9]{1,10};/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  if (maxChars && text.length > maxChars) text = `${text.slice(0, maxChars - 1).trimEnd()}…`
  return text
}

export function canonicalUrl(raw) {
  try {
    const url = new URL(raw)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.*|fbclid|gclid|spm|ref)$/i.test(key)) url.searchParams.delete(key)
    }
    const host = url.host.toLowerCase().replace(/^www\./, '')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const query = url.searchParams.toString()
    return `${url.protocol}//${host}${path}${query ? `?${query}` : ''}`
  } catch {
    return String(raw ?? '')
  }
}

function normalizeResults(rawResults, settings) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(rawResults) ? rawResults : []) {
    const link = typeof item?.url === 'string' ? item.url : ''
    if (!/^https?:\/\//i.test(link)) continue
    const key = canonicalUrl(link)
    if (settings.dedupe && seen.has(key)) continue
    seen.add(key)
    const engine = typeof item.engine === 'string' ? item.engine : undefined
    const score = typeof item.score === 'number' ? Number(item.score.toFixed(3)) : undefined
    const publishedAt = item.publishedDate || item.pubdate || undefined
    // 只放真实存在的字段：工具返回值必须是 lossless JSON，
    // 带 undefined 的键会让校验器判为「无法无损序列化」。
    const row = {
      title: cleanText(item.title, 200) || link,
      url: link,
      snippet: cleanText(item.content, settings.snippetMaxChars),
    }
    if (engine) row.engine = engine
    if (score !== undefined) row.score = score
    if (publishedAt) row.publishedAt = publishedAt
    out.push(row)
    if (out.length >= settings.maxResults) break
  }
  return out
}

export async function searchSearxng(settings, query, overrides = {}) {
  const proxy = resolveProxy(settings)
  const url = buildSearchUrl(settings, query, overrides)
  const response = await httpGet(url, {
    timeoutMs: settings.timeoutMs,
    userAgent: settings.userAgent,
    proxy,
    headers: { accept: 'application/json' },
  })

  if (!response.ok) {
    const head = String(response.body || '').trimStart().slice(0, 200)
    if (response.status === 404) {
      throw new SearchError('NOT_FOUND', `SearXNG 在 ${settings.baseUrl} 上没有 /search（HTTP 404）`, head)
    }
    if (response.status === 403 || head.startsWith('<')) {
      throw new SearchError(
        'FORMAT_NOT_ENABLED',
        'SearXNG 拒绝返回 JSON：要么实例未开启 json 格式，要么触发了反爬',
        head.slice(0, 160),
      )
    }
    throw new SearchError(
      'HTTP_ERROR',
      `SearXNG 返回 HTTP ${response.status || '(无响应)'}`,
      response.error || head,
    )
  }

  const text = String(response.body || '').trim()
  if (text.startsWith('<')) {
    throw new SearchError(
      'FORMAT_NOT_ENABLED',
      'SearXNG 返回的是 HTML 而不是 JSON：需要在该实例 settings.yml 的 search.formats 里加 json',
      text.slice(0, 160),
    )
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw new SearchError('PARSE_ERROR', `SearXNG 返回的不是合法 JSON（${String(error?.message || error)}）`, text.slice(0, 160))
  }

  const results = normalizeResults(payload.results, settings)
  return {
    provider: 'searxng',
    query,
    url,
    via: response.via,
    tookMs: response.tookMs,
    count: results.length,
    results,
    suggestions: Array.isArray(payload.suggestions) ? payload.suggestions.slice(0, 8) : [],
    answers: Array.isArray(payload.answers) ? payload.answers.slice(0, 3) : [],
    number_of_results: payload.number_of_results ?? null,
  }
}
