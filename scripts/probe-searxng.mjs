#!/usr/bin/env node
/**
 * Real-channel probe for the T72 policy search.
 *
 * This is **not** a test and is **not** in `tests/run.mjs`: it drives the actual
 * SearXNG instance once and prints HTTP status / result count / duration / URL.
 * That is the difference between "the code can call a fetcher" and "the channel
 * answers on this machine".
 *
 * It deliberately does **not** skip when the channel is down. A skip would turn
 * "the channel is unreachable" into a permanently green line, which is exactly
 * the failure this probe exists to make visible.
 *
 * Usage:
 *   node scripts/probe-searxng.mjs
 *   node scripts/probe-searxng.mjs "amazon seller policy update"
 *   AMZN_SEARXNG_URL=http://127.0.0.1:8080 AMZN_SEARXNG_TIMEOUT_MS=45000 node scripts/probe-searxng.mjs
 *
 * Exit code 0 only when the channel answered HTTP 200 with a `results` array;
 * 1 otherwise.
 */

import {
  DEFAULT_POLICY_QUERY, buildSearchUrl, resolveSearxngUrl, resolveSearchTimeoutMs,
} from '../src/domain/policy/candidate.js'

const query = process.argv.slice(2).join(' ').trim() || DEFAULT_POLICY_QUERY
const baseUrl = resolveSearxngUrl({})
const timeoutMs = resolveSearchTimeoutMs({})
const url = buildSearchUrl(baseUrl, query, { language: 'en-US' })

const startedAt = Date.now()
let response
let body = null
let error = null
try {
  response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  try {
    body = await response.json()
  } catch (parseError) {
    error = `response is not JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
  }
} catch (fetchError) {
  error = fetchError instanceof Error ? fetchError.message : String(fetchError)
}
const durationMs = Date.now() - startedAt

const results = body !== null && typeof body === 'object' && Array.isArray(body.results)
  ? body.results
  : null
const report = {
  url,
  query,
  timeoutMs,
  httpStatus: response === undefined ? null : response.status,
  ok: response !== undefined && response.ok === true && results !== null && error === null,
  durationMs,
  resultCount: results === null ? null : results.length,
  nonEmptySnippetCount: results === null
    ? null
    : results.filter(item => String(item?.content ?? item?.snippet ?? '').trim() !== '').length,
  error,
  firstResults: results === null
    ? []
    : results.slice(0, 3).map(item => ({
      title: String(item?.title ?? '').trim() || null,
      url: String(item?.url ?? item?.link ?? '').trim() || null,
      snippetChars: String(item?.content ?? item?.snippet ?? '').trim().length,
    })),
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
