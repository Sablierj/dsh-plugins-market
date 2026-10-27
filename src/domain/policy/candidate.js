/**
 * T72 — the policy button's four-step chain (PRD R-4 / decision D-c).
 *
 * The chain is: button → search → compare with the library → **human confirm**
 * before anything enters the policy library. This module owns the middle three
 * steps; the page owns the button and the human decision.
 *
 * Three boundaries are load-bearing:
 *
 *   1. **There is no "summary" step in v1.** This plugin has no model call, so
 *      pretending to summarise would be fake intelligence. The search returns the
 *      result title / URL / snippet verbatim, and the snippet is stored as
 *      evidence. The UI and the report must say 「摘要是搜索结果的原文片段，不是本
 *      插件生成的总结」. The Agent can summarise in the conversation later.
 *   2. **A failed search is a failure, not an empty result.** Connect error,
 *      timeout, non-200, or a body with no `results` array all produce
 *      `UNAVAILABLE` with the reason written down. A legitimate `results: []` is a
 *      separate `empty` outcome: the channel answered, it found nothing, and that
 *      still does not mean "there is no new policy".
 *   3. **Nothing enters the policy library without a human confirm.** A candidate
 *      row is evidence; only `confirmPolicyCandidate` writes a policy, and it goes
 *      through the **same** `parsePolicy` + `importPolicy` + `linkPolicyToRules`
 *      path `amzn_policy_import` / `amzn_policy_link` use. There is no second
 *      import path.
 *
 * The diff is machine-readable only: same normalised title (or same URL), then
 * compare effective dates and whether the library body contains the snippet
 * verbatim. No semantic judgement is made here — 「疑似失效」 would need a human,
 * and this version does not even claim it.
 */

import { randomUUID } from 'node:crypto'

import { parsePolicy, PolicyParseError } from './parse.js'
import { getPolicy, importPolicy, linkPolicyToRules, listPolicies } from '../../store/policy.js'
import {
  createCheckRun, decideCandidate, ensureSearchPolicySource, finishCheckRun, getCandidate, getCheckRun,
  insertCandidates, recomputeRunStatus,
} from '../../store/policy-candidate.js'

/** The local SearXNG instance. A caller may override it; the default is the LLD's. */
export const SEARXNG_DEFAULT_URL = 'http://127.0.0.1:8080'

/** Environment variables read for the channel URL, in order. */
export const SEARXNG_URL_ENV = ['AMZN_SEARXNG_URL', 'SEARXNG_URL']

/** The query the button starts with. Editable on the page; never silently invented. */
export const DEFAULT_POLICY_QUERY = 'Amazon seller central policy update'

/** How many results one check asks for, and the hard cap. */
export const DEFAULT_RESULT_LIMIT = 8
export const MAX_RESULT_LIMIT = 20

/**
 * Search timeout.
 *
 * 10s was measured against the real channel and lost: a cold SearXNG query took
 * 20362 ms, a warm one 10042 ms. The old value made the button fail on its first
 * press while every injected-fetcher test stayed green. 45s = measured cold 20s
 * plus one full margin. `AMZN_SEARXNG_TIMEOUT_MS` overrides it (same shape as
 * `SEARXNG_URL_ENV`); a bad value falls back to this default rather than hanging.
 */
export const SEARCH_TIMEOUT_MS = 45000

/** Environment variable that overrides the search timeout. */
export const SEARXNG_TIMEOUT_ENV = 'AMZN_SEARXNG_TIMEOUT_MS'

/** The policy_source row a confirmed candidate is imported under (seeded in v65). */
export const SEARCH_POLICY_SOURCE_ID = 'web-search'

/** Marketplace → SearXNG language hint. Unknown sites fall back to English. */
const MARKETPLACE_LANGUAGE = {
  US: 'en-US', UK: 'en-GB', CA: 'en-CA', DE: 'de-DE', FR: 'fr-FR',
  IT: 'it-IT', ES: 'es-ES', JP: 'ja-JP', MX: 'es-MX',
}

/** Trim + collapse whitespace + lower-case. Used only for equality, never for display. */
function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Resolve the channel URL: explicit option → env → default.
 *
 * Deliberately not a settings key: `store/settings.js` is a closed whitelist and
 * this version has no settings-page field for it, so an env var is the honest
 * "configurable" answer rather than writing an undeclared key into the store.
 */
export function resolveSearxngUrl(options = {}) {
  const explicit = String(options.searxngUrl ?? '').trim()
  if (explicit !== '') return explicit.replace(/\/+$/, '')
  for (const name of SEARXNG_URL_ENV) {
    const value = String(process.env[name] ?? '').trim()
    if (value !== '') return value.replace(/\/+$/, '')
  }
  return SEARXNG_DEFAULT_URL
}

/**
 * Resolve the timeout: explicit option → `AMZN_SEARXNG_TIMEOUT_MS` → 45s.
 *
 * A non-numeric / non-positive env value is **ignored in favour of the default**,
 * not turned into "no timeout": a typo must not remove the guard that makes a
 * hung channel fail loudly.
 */
export function resolveSearchTimeoutMs(options = {}) {
  const explicit = Number(options.timeoutMs)
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit)
  const fromEnv = Number(String(process.env[SEARXNG_TIMEOUT_ENV] ?? '').trim())
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.round(fromEnv)
  return SEARCH_TIMEOUT_MS
}

/** The SearXNG JSON search URL for one query. */
export function buildSearchUrl(baseUrl, query, options = {}) {
  const params = new URLSearchParams({
    q: String(query ?? ''),
    format: 'json',
    categories: 'general',
    safesearch: '0',
  })
  const language = String(options.language ?? '').trim()
  if (language !== '') params.set('language', language)
  return `${String(baseUrl).replace(/\/+$/, '')}/search?${params.toString()}`
}

function timeoutSignal(ms) {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined
  return AbortSignal.timeout(ms)
}

/**
 * One search through the channel. **Never throws for a channel failure** — the
 * failure is returned as `{ ok: false, code: 'UNAVAILABLE', error }` so the caller
 * can write it down. `fetcher` is injectable so tests do not need a live SearXNG.
 *
 * `results: []` is `ok: true` with `resultState: 'empty'`. A payload whose
 * `results` is missing or not an array is `ok: false` — an empty response body is
 * not the same fact as "the search found nothing".
 */
export async function searchPolicySources(options = {}) {
  const query = String(options.query ?? '').trim()
  if (query === '') {
    return {
      ok: false, code: 'BAD_REQUEST', query, resultState: 'failed',
      error: 'query 是必填项：告诉检索什么，例如「Amazon seller central policy update」。',
    }
  }
  const limitRaw = options.limit === undefined || options.limit === null ? DEFAULT_RESULT_LIMIT : Number(options.limit)
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_RESULT_LIMIT) {
    return {
      ok: false, code: 'BAD_REQUEST', query, resultState: 'failed',
      error: `limit 必须是 1..${MAX_RESULT_LIMIT} 的整数（收到 ${String(options.limit)}）。`,
    }
  }
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== 'function') {
    return {
      ok: false, code: 'UNAVAILABLE', query, resultState: 'failed',
      error: '搜索通道不可用：运行时没有 fetch（本插件要求 Node 22+ 的内置 fetch）。',
    }
  }

  const searxngUrl = resolveSearxngUrl(options)
  const language = String(options.language ?? MARKETPLACE_LANGUAGE[String(options.marketplace ?? '').toUpperCase()] ?? '')
  const url = buildSearchUrl(searxngUrl, query, { language })
  const timeoutMs = resolveSearchTimeoutMs(options)
  let signal
  try {
    /* `AbortSignal.timeout` throws RangeError for a timeout above its ceiling
       (e.g. Number.MAX_SAFE_INTEGER). Left outside the try this would escape
       `searchPolicySources`, leave the run at `running` forever, and the page
       would spin with nobody knowing it died. */
    signal = timeoutSignal(timeoutMs)
  } catch (error) {
    return {
      ok: false,
      code: 'UNAVAILABLE',
      query,
      searxngUrl,
      url,
      resultState: 'failed',
      error: `搜索通道不可用：超时配置 ${timeoutMs}ms 非法（${error instanceof Error ? error.message : String(error)}）。`
        + '这次没查到，不代表没有新政策。',
    }
  }

  let response
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timeout = /abort|timeout|timed out/i.test(message)
    return {
      ok: false,
      code: 'UNAVAILABLE',
      query,
      searxngUrl,
      url,
      resultState: 'failed',
      error: `搜索通道不可用：${timeout ? '请求超时' : '连不上'} ${searxngUrl}（${message}）。`
        + '这次没查到，不代表没有新政策。',
    }
  }

  if (response === null || typeof response !== 'object') {
    return {
      ok: false, code: 'UNAVAILABLE', query, searxngUrl, url, resultState: 'failed',
      error: '搜索通道不可用：响应不是 Response 对象。这次没查到，不代表没有新政策。',
    }
  }
  const status = Number(response.status ?? 0)
  if (response.ok === false || (status !== 0 && status !== 200)) {
    return {
      ok: false, code: 'UNAVAILABLE', query, searxngUrl, url, resultState: 'failed',
      error: `搜索通道返回 HTTP ${status === 0 ? '（无状态）' : status}，不是 200。`
        + '这次没查到，不代表没有新政策。',
    }
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    return {
      ok: false, code: 'UNAVAILABLE', query, searxngUrl, url, resultState: 'failed',
      error: `搜索通道返回的不是 JSON（${error instanceof Error ? error.message : String(error)}）。`
        + '这次没查到，不代表没有新政策。',
    }
  }
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    return {
      ok: false, code: 'UNAVAILABLE', query, searxngUrl, url, resultState: 'failed',
      error: '搜索通道的响应里没有 results 数组（空响应不是「0 条结果」）。'
        + '这次没查到，不代表没有新政策。',
    }
  }

  const retrievedAt = options.now ?? new Date().toISOString()
  const results = []
  const seen = new Set()
  let skipped = 0
  let processed = 0
  for (const item of payload.results) {
    if (results.length >= limitRaw) break
    processed += 1
    const title = String(item?.title ?? '').trim()
    const resultUrl = String(item?.url ?? item?.link ?? '').trim()
    const snippet = String(item?.content ?? item?.snippet ?? '').trim()
    if (title === '') {
      /* A hit without a title cannot be imported (parsePolicy requires one) and
         cannot be presented as a policy. Count it instead of silently dropping. */
      skipped += 1
      continue
    }
    const key = resultUrl !== '' ? resultUrl : title.toLowerCase()
    if (seen.has(key)) {
      skipped += 1
      continue
    }
    seen.add(key)
    results.push({ title, url: resultUrl === '' ? null : resultUrl, snippet, retrievedAt })
  }

  return {
    ok: true,
    query,
    searxngUrl,
    url,
    resultState: results.length === 0 ? 'empty' : 'candidates',
    results,
    /* `processedCount` is what this run actually read (capped by `limit`);
       `rawCount` is what the channel offered. The page prints the former and the
       run record keeps it, so "100 hits, read 8" cannot read as "100 sources". */
    processedCount: processed,
    rawCount: payload.results.length,
    skipped,
  }
}

/**
 * The machine-readable diff of one candidate against the policy library.
 *
 * Matching is by **normalised title** or **exact URL** — never by fuzzy title or
 * embedding. For each match it compares:
 *
 *   - `effective_from` when both sides have a readable date → `effective_date_changed`;
 *   - a library policy with no date → `effective_date_missing_in_library`;
 *   - whether the library body contains the snippet **verbatim** →
 *     `excerpt_not_in_library`.
 *
 * A source date the parser cannot read is a **note**, not a difference: "we could
 * not read it" is not "it changed". Multiple title matches are also a note — the
 * code does not pick a winner.
 */
export function diffPolicyCandidate(store, candidate = {}) {
  const title = String(candidate.title ?? '').trim()
  const url = String(candidate.url ?? '').trim()
  const snippet = String(candidate.snippet ?? '').trim()
  const matched = []
  const differences = []
  const notes = []

  if (title === '' && url === '') {
    return { matched, differences, notes: [{ kind: 'no_identity', message: '候选没有标题也没有链接，无法与库内政策比对。' }] }
  }

  const policies = listPolicies(store, {}).rows
  const byId = new Map()
  for (const policy of policies) {
    const titleHit = title !== '' && normalizeText(policy.title) === normalizeText(title)
    const urlHit = url !== '' && policy.url !== null && String(policy.url).trim() === url
    if (!titleHit && !urlHit) continue
    byId.set(policy.id, {
      policyId: policy.id,
      title: policy.title,
      status: policy.status,
      effectiveFrom: policy.effectiveFrom,
      matchedBy: titleHit && urlHit ? 'title+url' : titleHit ? 'title' : 'url',
    })
  }
  for (const entry of byId.values()) matched.push(entry)

  if (matched.length === 0) {
    notes.push({
      kind: 'not_in_library',
      message: '库内没有这个来源（按标题与链接都没匹配到）。这是一条新来源，不是「已变更」。',
    })
    return { matched, differences, notes }
  }
  if (matched.length > 1) {
    notes.push({
      kind: 'multiple_matches',
      policyIds: matched.map(entry => entry.policyId),
      message: `库内同标题/同链接的政策有 ${matched.length} 条，未判定哪一条是同一份。`,
    })
  }

  const parsed = parseCandidateText(title, snippet)
  for (const entry of matched) {
    const libraryDate = entry.effectiveFrom === null || entry.effectiveFrom === undefined
      ? null
      : String(entry.effectiveFrom)
    const sourceDate = parsed === null ? null : parsed.effective_from
    if (libraryDate !== null && sourceDate !== null && libraryDate !== sourceDate) {
      differences.push({
        kind: 'effective_date_changed',
        policyId: entry.policyId,
        field: 'effective_from',
        library: libraryDate,
        source: sourceDate,
        message: `库内已有同标题政策但生效日期不同（库内 ${libraryDate}，检索片段 ${sourceDate}）。`,
      })
    } else if (libraryDate === null && sourceDate !== null) {
      differences.push({
        kind: 'effective_date_missing_in_library',
        policyId: entry.policyId,
        field: 'effective_from',
        library: null,
        source: sourceDate,
        message: `库内这条政策没有生效日期，检索片段给出 ${sourceDate}（补哪边由人决定）。`,
      })
    } else if (libraryDate !== null && sourceDate === null) {
      notes.push({
        kind: 'source_effective_date_unrecognized',
        policyId: entry.policyId,
        message: '检索片段里没有可识别的生效日期，无法与库内日期比对（不是「没变化」）。',
      })
    }

    const body = normalizeText(policies.find(policy => policy.id === entry.policyId)?.body_md ?? '')
    if (snippet !== '' && body !== '' && !body.includes(normalizeText(snippet))) {
      differences.push({
        kind: 'excerpt_not_in_library',
        policyId: entry.policyId,
        field: 'body_md',
        message: '库内正文不包含这段原文片段（逐字比对，不是语义判断）。',
      })
    }
  }

  if (differences.length === 0) {
    notes.push({
      kind: 'matched_no_machine_readable_difference',
      policyIds: matched.map(entry => entry.policyId),
      message: `对比了 ${matched.length} 条库内政策，没有机器可读的差异。`,
    })
  }
  return { matched, differences, notes }
}

/** `title + blank line + snippet` → parsePolicy, or `null` when unparseable. */
function parseCandidateText(title, snippet) {
  const text = `${String(title ?? '').trim()}\n\n${String(snippet ?? '').trim()}`
  try {
    return parsePolicy(text)
  } catch (error) {
    if (error instanceof PolicyParseError) return null
    throw error
  }
}

/**
 * Step ①–③: search, persist the raw hits as candidates, persist the run.
 *
 * The run row is written first (`running`), then closed as `pending_confirm` or
 * `failed`. A failed search **writes no candidate rows** — an empty candidate
 * table after a failure is a fact about the failure, not "0 results".
 */
export async function startPolicyCheck(store, options = {}) {
  const query = String(options.query ?? '').trim()
  if (query === '') {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      resultState: 'failed',
      error: 'query 是必填项：告诉检索什么，例如「Amazon seller central policy update」。',
    }
  }
  const limit = options.limit === undefined || options.limit === null ? DEFAULT_RESULT_LIMIT : Number(options.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      resultState: 'failed',
      error: `limit 必须是 1..${MAX_RESULT_LIMIT} 的整数（收到 ${String(options.limit)}）。`,
    }
  }

  const marketplace = options.marketplace === undefined || options.marketplace === null
    ? null
    : String(options.marketplace).trim().toUpperCase() || null
  const observedAt = options.now ?? new Date().toISOString()
  const run = createCheckRun(store, { query, marketplace, observedAt })

  const startedAt = Date.now()
  let searched
  try {
    searched = await searchPolicySources({
      query,
      marketplace,
      limit,
      fetcher: options.fetcher,
      searxngUrl: options.searxngUrl,
      timeoutMs: options.timeoutMs,
      now: observedAt,
    })
  } catch (error) {
    /* Last-resort guard: any unexpected throw from the search step must close
       the run as failed. A run stuck at `running` is the worst failure — the
       page waits forever and no one can tell it died. */
    searched = {
      ok: false,
      code: 'UNAVAILABLE',
      resultState: 'failed',
      error: `搜索通道异常：${error instanceof Error ? error.message : String(error)}。这次没查到，不代表没有新政策。`,
    }
  }
  /* Wall-clock duration of the search step. Recorded on **both** outcomes: a
     failed run without a duration leaves the next reader guessing whether the
     channel hung or the timeout was too short. */
  const durationMs = Math.max(0, Date.now() - startedAt)

  if (searched.ok === false) {
    finishCheckRun(store, {
      id: run.id,
      status: 'failed',
      errorCode: searched.code ?? 'UNAVAILABLE',
      error: searched.error,
      sourceCount: 0,
      diffCount: 0,
      durationMs,
      sources: null,
    })
    return {
      ok: false,
      code: searched.code ?? 'UNAVAILABLE',
      status: 'failed',
      resultState: 'failed',
      runId: run.id,
      sourceCount: 0,
      candidateCount: 0,
      diffCount: 0,
      durationMs,
      error: searched.error,
    }
  }

  const rows = []
  let diffCount = 0
  for (const result of searched.results) {
    const diff = diffPolicyCandidate(store, result)
    diffCount += diff.differences.length
    rows.push({
      id: randomUUID(),
      runId: run.id,
      sourceUrl: result.url,
      sourceTitle: result.title,
      snippet: result.snippet,
      retrievedAt: result.retrievedAt,
      query,
      diff,
    })
  }
  if (rows.length > 0) insertCandidates(store, rows)

  finishCheckRun(store, {
    id: run.id,
    status: 'pending_confirm',
    /* `source_count` is what this run **read**, not what survived as a candidate:
       12 hits with 12 missing titles is not "0 sources". `rawCount` (what the
       channel offered before the limit) stays in the reply, not in the column. */
    sourceCount: searched.processedCount,
    diffCount,
    durationMs,
    sources: searched.results,
  })

  return {
    ok: true,
    runId: run.id,
    status: 'pending_confirm',
    resultState: searched.resultState,
    sourceCount: searched.processedCount,
    rawCount: searched.rawCount,
    skipped: searched.skipped,
    candidateCount: rows.length,
    diffCount,
    durationMs,
  }
}

/**
 * Step ④ — adopt one candidate: parse its title + snippet through the **existing**
 * import path, optionally link the rules the human selected, then mark the
 * candidate confirmed.
 *
 * `ruleIds` are validated before anything is written, so a typo cannot leave a
 * policy imported but unlinked. If the link still fails after the import, the
 * reply says so and keeps the candidate open — retrying is safe because
 * `importPolicy` is idempotent on `(source_id, title, body_md)`.
 */
export async function confirmPolicyCandidate(store, options = {}) {
  const candidateId = String(options.candidateId ?? '').trim()
  const by = String(options.by ?? '').trim()
  if (candidateId === '') return { ok: false, code: 'BAD_REQUEST', error: 'candidateId 是必填项。' }
  if (by === '') return { ok: false, code: 'BAD_REQUEST', error: 'by 是必填项：确认入库要留操作人（自述标签）。' }

  const candidate = getCandidate(store, candidateId)
  if (candidate === null) return { ok: false, code: 'NOT_FOUND', error: `没有这个候选：${candidateId}` }
  if (candidate.status !== 'candidate') {
    return {
      ok: false,
      code: 'CONFLICT',
      error: `候选已经处理过（status=${candidate.status}），首决为准，不能重裁。`,
    }
  }

  const parsed = parseCandidateText(candidate.sourceTitle, candidate.snippet)
  if (parsed === null) {
    return {
      ok: false,
      code: 'PARSE_FAILED',
      error: '这条候选无法入库：标题之后没有可用正文（snippet 为空或只有标题）。没有写库。',
    }
  }

  const ruleIds = [...new Set((Array.isArray(options.ruleIds) ? options.ruleIds : [])
    .map(id => String(id).trim())
    .filter(id => id !== ''))]
  if (ruleIds.length > 0) {
    const known = new Set(store.all('SELECT DISTINCT rule_id FROM rule').map(row => row.rule_id))
    const unknown = ruleIds.filter(id => !known.has(id))
    if (unknown.length > 0) {
      return { ok: false, code: 'BAD_REQUEST', error: `未知 rule_id：${unknown.join('、')}（没有写库）。` }
    }
  }

  const run = getCheckRun(store, candidate.runId)
  const marketplace = run?.marketplace ?? null
  let stored
  try {
    /* Lazy provenance row (v65 does not seed it — see ensureSearchPolicySource). */
    ensureSearchPolicySource(store)
    stored = importPolicy(store, {
      sourceId: SEARCH_POLICY_SOURCE_ID,
      title: parsed.title,
      bodyMd: parsed.body_md,
      marketplace,
      url: candidate.sourceUrl ?? parsed.url,
      publishedAt: parsed.published_at,
      effectiveFrom: parsed.effective_from,
      effectiveTo: parsed.effective_to,
      severityHint: parsed.severity_hint,
      severityRaw: parsed.severity_raw,
    })
  } catch (error) {
    return { ok: false, code: 'IMPORT_FAILED', error: `入库失败：${error.message}（政策库未变）。` }
  }

  let linked = []
  let linksAdded = 0
  if (ruleIds.length > 0) {
    const linker = typeof options.linker === 'function' ? options.linker : linkPolicyToRules
    try {
      /* MERGE, not replace: `linkPolicyToRules` replaces the whole set, and a
         policy that already existed may carry links a person made. A machine
         path may add the rules the human ticked; it must not drop the others
         (跨模块铁律 #6). `fields` is omitted so a stored field list is untouched. */
      const existing = getPolicy(store, stored.id)?.rules ?? []
      const merged = [...new Set([...existing, ...ruleIds])]
      const result = linker(store, { policyId: stored.id, ruleIds: merged })
      linked = result.ruleIds
      linksAdded = result.added.length
    } catch (error) {
      /* Never leave a half-write: the policy row was already inserted, so a
         candidate that stayed `candidate` would be a 「待确认」 row whose policy
         is already in the library — a rejection could not remove it. Roll the
         new row back (only if this call created it), mark the candidate
         `rejected` with a system actor, and say exactly what happened. */
      let rolledBack = false
      if (stored.created === true) {
        try {
          store.run('DELETE FROM policy_rule WHERE policy_id = ?', [stored.id])
          store.run('DELETE FROM policy WHERE id = ?', [stored.id])
          rolledBack = true
        } catch {
          rolledBack = false
        }
      }
      const reason = `系统：挂规则失败，政策行${rolledBack ? '已回滚' : '保留（原已存在）'}；规则未挂。${error.message}`
      const failed = decideCandidate(store, {
        id: candidate.id,
        status: 'rejected',
        policyId: null,
        by: 'system',
        at: options.now,
        reason,
      })
      const failedRun = recomputeRunStatus(store, candidate.runId)
      return {
        ok: false,
        code: 'LINK_FAILED',
        policyId: rolledBack ? null : stored.id,
        rolledBack,
        candidateStatus: failed?.status ?? null,
        runStatus: failedRun?.status ?? null,
        error: reason,
      }
    }
  }

  const decided = decideCandidate(store, {
    id: candidate.id,
    status: 'confirmed',
    policyId: stored.id,
    by,
    at: options.now,
    reason: String(options.reason ?? '').trim() || null,
  })
  if (decided === null) {
    return { ok: false, code: 'CONFLICT', error: '候选在本次确认过程中已被别的操作处理，首决为准。' }
  }
  const finalRun = recomputeRunStatus(store, candidate.runId)

  return {
    ok: true,
    candidateId: candidate.id,
    policyId: stored.id,
    created: stored.created,
    ruleIds: linked,
    linksWritten: linksAdded,
    runStatus: finalRun?.status ?? null,
  }
}

/**
 * Step ④ — reject one candidate. A reason is **required**: a rejection without a
 * reason is unreviewable six months later. Nothing is written to `policy`.
 */
export async function rejectPolicyCandidate(store, options = {}) {
  const candidateId = String(options.candidateId ?? '').trim()
  const by = String(options.by ?? '').trim()
  const reason = String(options.reason ?? '').trim()
  if (candidateId === '') return { ok: false, code: 'BAD_REQUEST', error: 'candidateId 是必填项。' }
  if (by === '') return { ok: false, code: 'BAD_REQUEST', error: 'by 是必填项：驳回要留操作人（自述标签）。' }
  if (reason === '') return { ok: false, code: 'BAD_REQUEST', error: '驳回必须留理由（reason 不能为空）。' }

  const candidate = getCandidate(store, candidateId)
  if (candidate === null) return { ok: false, code: 'NOT_FOUND', error: `没有这个候选：${candidateId}` }
  if (candidate.status !== 'candidate') {
    return {
      ok: false,
      code: 'CONFLICT',
      error: `候选已经处理过（status=${candidate.status}），首决为准，不能重裁。`,
    }
  }

  const decided = decideCandidate(store, {
    id: candidate.id,
    status: 'rejected',
    policyId: null,
    by,
    at: options.now,
    reason,
  })
  if (decided === null) {
    return { ok: false, code: 'CONFLICT', error: '候选在本次驳回过程中已被别的操作处理，首决为准。' }
  }
  const finalRun = recomputeRunStatus(store, candidate.runId)
  return { ok: true, candidateId: candidate.id, status: 'rejected', runStatus: finalRun?.status ?? null }
}
