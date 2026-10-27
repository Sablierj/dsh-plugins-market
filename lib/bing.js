/**
 * Fallback: Bing HTML results when SearXNG is unavailable.
 *
 * Rationale: a search tool that returns "0 results" because its backend is down
 * is worse than useless — the agent cannot tell "nothing exists" from "I broke".
 * So the failure is explicit (`degraded: true`) and the source is named.
 *
 * This parses Bing's public result page; it is best-effort by design and marked
 * as degraded, never as an equal provider.
 */
import { cleanText, canonicalUrl, SearchError } from './searxng.js'
import { httpGet, resolveProxy } from './transport.js'

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

function decodeEntities(input) {
  return String(input ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Split the page into `<li class="b_algo">` blocks — one per organic result. */
function splitBlocks(html) {
  const blocks = []
  const re = /<li class="b_algo[\s\S]*?(?=<li class="b_algo|<\/ol>|<\/main>)/g
  const match = String(html ?? '').match(re)
  if (match) blocks.push(...match)
  return blocks
}

export function parseBingHtml(html, settings) {
  const out = []
  const seen = new Set()
  for (const block of splitBlocks(html)) {
    const anchor = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!anchor) continue
    const url = decodeEntities(anchor[1])
    if (!/^https?:\/\//i.test(url)) continue
    const key = canonicalUrl(url)
    if (seen.has(key)) continue
    seen.add(key)
    const title = stripTags(anchor[2])
    const snippetMatch =
      block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    out.push({
      title: title || url,
      url,
      snippet: cleanText(stripTags(snippetMatch?.[1] ?? ''), settings.snippetMaxChars),
      engine: 'bing-html',
    })
    if (out.length >= Math.min(settings.fallback.maxResults, settings.maxResults)) break
  }
  return out
}

export async function searchBingFallback(settings, query, overrides = {}) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=${encodeURIComponent(
    overrides.language || settings.language || 'zh-CN',
  )}&count=${Math.min(20, settings.fallback.maxResults + 4)}`

  const response = await httpGet(url, {
    timeoutMs: settings.timeoutMs,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    proxy: resolveProxy(settings),
    headers: { accept: 'text/html' },
  })

  if (!response.ok) {
    throw new SearchError('FALLBACK_FAILED', `Bing 兜底也失败：HTTP ${response.status || '(无响应)'}`, response.error || '')
  }
  const results = parseBingHtml(response.body, settings)
  if (results.length === 0) {
    throw new SearchError('FALLBACK_EMPTY', 'Bing 兜底返回了页面但没解析出结果（页面结构可能变了）', '')
  }
  return {
    provider: 'bing-html',
    degraded: true,
    query,
    url,
    via: response.via,
    tookMs: response.tookMs,
    count: results.length,
    results,
    suggestions: [],
    answers: [],
    note: 'SearXNG 不可用，已降级为 Bing HTML 兜底；结果同样是一次性抓取，稳定性低于 SearXNG。',
  }
}
