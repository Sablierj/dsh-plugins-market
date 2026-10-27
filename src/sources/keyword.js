/**
 * The keyword library: discovery, coverage scanning, and the task that runs it.
 *
 * Two jobs, one browser:
 *
 *   **Discovery** turns a handful of seed words into a set of keywords, by
 *   typing them into Amazon's real search box and reading the dropdown it
 *   opens. Typing rather than calling the completion endpoint directly is a
 *   deliberate choice — see `pages/amazon-search.js` for the reasoning, and
 *   `DESIGN.md` §5.4 for the measured alternative.
 *
 *   **Coverage** answers "where does our ASIN sit for this word", by walking
 *   real search result pages and reading the organic positions. That is the
 *   measurement `asin_keyword.rank` holds and the gap the coverage tool
 *   computes from.
 *
 * Both write, so both go through the same task lifecycle as collection: a row
 * in `collection_task` with `kind`, submitted immediately and drained in the
 * background. The reason is the same — a scan of ten keywords across three
 * pages is ~30 page loads, which is minutes, and a tool call is not.
 *
 * The one thing this module refuses to do is store a verdict it did not
 * measure. A bot-check page renders no results, and "no results" is
 * indistinguishable from "our ASIN does not rank" — so a page that fails
 * `classifySearchPage` produces *no* rows for that keyword, and the keyword
 * keeps whatever it had. Writing a null there would look like a finding.
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from '../store/db.js'
import { recordRankObservation } from '../store/rank-observation.js'
import {
  getCollectionTask,
  insertCollectionTask,
  latestSnapshotPayload,
  listCollectionTasks,
  recoverStaleTasks,
  updateCollectionTask,
  upsertAsinKeyword,
  upsertKeyword,
} from '../store/queries.js'
import { applyStorefront, evaluate, navigate, sleep } from './cdp/client.js'
import { createPassThroughGate } from './browser/gate.js'
import { createPacer, resolvePacing } from './pacing.js'
import {
  classifySearchPage,
  DISMISS_SUGGESTIONS,
  FOCUS_SEARCH_BOX,
  MAX_SCAN_PAGES,
  mergeSuggestionSets,
  pickKeywordSuggestions,
  pickPlacements,
  READ_SEARCH_RESULTS,
  READ_SUGGESTIONS,
  searchUrl,
  SUGGESTION_LIMIT,
} from './pages/amazon-search.js'
import { ensureStorefront, storefrontFor } from './pages/index.js'
import { classifyKeyword, keywordInText, listingText, RESULTS_PER_PAGE, rollupTier } from './keyword-tiers.js'

/** 一次扫描最多记多少条自然位结果 —— 自动发现竞品的原料，取前 3 页的量。 */
const TOP_RESULT_LIMIT = 60

/** Progress writes are throttled the same way collection throttles them. */
const PROGRESS_THROTTLE_MS = 1_000

/** How long to give the dropdown's XHR after the last keystroke. */
const SUGGESTION_WAIT_MS = 1_200

/** Seeds per discovery call. A tool call should not run for minutes. */
export const DISCOVERY_SEED_MAX = 8

/** Keywords per scan task, and pages per keyword. */
export const SCAN_KEYWORD_MAX = 40
export const SCAN_PAGE_MAX = MAX_SCAN_PAGES

/* ──────────────────────────── discovery ──────────────────────────── */

/**
 * Type one seed into the search box and read what Amazon suggests.
 *
 * The box is cleared with real keystrokes rather than by assigning `.value`:
 * Amazon's handler reads the input's own state, and a scripted assignment fires
 * no `input` event, so the dropdown would keep offering completions of the
 * *previous* seed. The result would be plausible keywords filed under the wrong
 * seed — the kind of wrong that never announces itself.
 */
async function harvestSeed(cdp, sessionId, seed, { limit = SUGGESTION_LIMIT } = {}) {
  await evaluate(cdp, sessionId, FOCUS_SEARCH_BOX)

  // Ctrl+A, then Backspace. Sent as key events so the page sees them.
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
  }, { sessionId, timeoutMs: 5_000 })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
  }, { sessionId, timeoutMs: 5_000 })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
  }, { sessionId, timeoutMs: 5_000 })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
  }, { sessionId, timeoutMs: 5_000 })

  for (const ch of seed) {
    // `keyDown` carries no `text`; `char` is the event that inserts. Sending
    // text on both inserts every character twice — which happened, and produced
    // a search box reading "bblluueettooootthh".
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: ch, code: keyCodeFor(ch),
    }, { sessionId, timeoutMs: 5_000 })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'char', key: ch, text: ch, unmodifiedText: ch,
    }, { sessionId, timeoutMs: 5_000 })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ch, code: keyCodeFor(ch),
    }, { sessionId, timeoutMs: 5_000 })
    // Human-ish, and it gives the page a chance to keep up.
    await sleep(70 + Math.random() * 120)
  }

  await sleep(SUGGESTION_WAIT_MS)
  const raw = await evaluate(cdp, sessionId, READ_SUGGESTIONS)
  await evaluate(cdp, sessionId, DISMISS_SUGGESTIONS)

  const picked = pickKeywordSuggestions(raw, { limit })
  const typed = String(raw?.typed ?? '')
  const problems = []
  if (typed.trim().toLowerCase() !== seed.trim().toLowerCase()) {
    // The dropdown may still have been showing the previous term. Saying so is
    // the difference between "no suggestions" and "we typed into a stale box".
    problems.push({
      code: 'seed-not-in-box',
      detail: `期望搜索框为 "${seed}"，实际为 "${typed}"`,
    })
  }
  if (picked.keywords.length === 0 && problems.length === 0) {
    // Two very different situations, and they must not look alike: an empty
    // dropdown, and a dropdown full of rows our filter rejected. The second
    // means the page changed and the filter needs revisiting — it happened
    // once already, when a container check rejected every real suggestion.
    problems.push(picked.rejected.length > 0
      ? {
        code: 'all-candidates-filtered',
        detail: `${picked.rejected.length} 个候选全部被判为组件行，可能页面结构变了：${picked.rejected.slice(0, 5).join(' | ')}`,
      }
      : { code: 'no-suggestions', detail: '下拉没有出现任何候选（可能是该词无联想，也可能页面结构变了）' })
  }

  return {
    seed,
    typed,
    keywords: picked.keywords,
    // Kept rather than dropped: seeing "Under $25" here is how you know the
    // widget filter is working.
    rejected: picked.rejected,
    candidateCount: raw?.candidateCount ?? 0,
    problems,
  }
}

/**
 * Seeds → keywords, against one storefront.
 *
 * Synchronous on purpose. Each seed is one short interaction, so a capped batch
 * finishes inside a tool call; making it a task would add a lifecycle for
 * something that does not need one. The cap is enforced here and reported, not
 * silently applied.
 */
export async function discoverKeywords({
  collector, marketplace, seeds, limit = SUGGESTION_LIMIT, logger, onProgress, signal,
} = {}) {
  const list = [...new Set((seeds ?? []).map(seed => String(seed ?? '').trim()).filter(seed => seed !== ''))]
  if (list.length === 0) throw new Error('seeds is empty')
  if (list.length > DISCOVERY_SEED_MAX) {
    throw new Error(`too many seeds: ${list.length} > ${DISCOVERY_SEED_MAX}. Split it into several calls.`)
  }

  const storefront = storefrontFor(marketplace)
  const startedAt = Date.now()

  return collector.withPage(async (cdp, page) => {
    await applyStorefront(cdp, page.sessionId, storefront)
    await navigate(cdp, page.sessionId, `https://${storefront.domain}/`)
    // Same storefront correction as collection, for the same reason: the
    // suggestions must come back in this storefront's language, and the profile
    // carries whatever storefront it visited last.
    const session = await ensureStorefront(cdp, page.sessionId, storefront, { logger })

    const perSeed = []
    for (const [index, seed] of list.entries()) {
      if (signal?.aborted === true) break
      await onProgress?.({ phase: 'discovering', index: index + 1, total: list.length, seed })

      let outcome
      try {
        outcome = await harvestSeed(cdp, page.sessionId, seed, { limit })
      } catch (error) {
        outcome = { seed, typed: null, keywords: [], rejected: [], candidateCount: 0, problems: [{ code: 'threw', detail: error.message }] }
      }
      perSeed.push(outcome)

      // Between seeds: a short, uneven pause. Discovery is a burst of searches
      // from one session, and a metronome is the easiest pattern to notice.
      if (index < list.length - 1) await sleep(700 + Math.random() * 900)
    }

    // `limit` is per seed, and the union is capped at `limit × seeds` — one
    // function so the two caps cannot drift apart. They did once, and the only
    // symptom was a library quietly two words short.
    const merged = mergeSuggestionSets(perSeed, { limit })

    return {
      ok: true,
      marketplace,
      storefront: { domain: storefront.domain, language: storefront.request },
      storefrontActions: session.actions,
      storefrontProblems: session.problems,
      seeds: list,
      keywords: merged.keywords,
      limit,
      unionCap: merged.cap,
      perSeed,
      durationMs: Date.now() - startedAt,
    }
  })
}

/* ─────────────────────────── coverage scan ─────────────────────────── */

/**
 * Walk a keyword's result pages and record where our ASINs sit.
 *
 * `depth` is the honest part of the answer: it is how many natural positions
 * were actually looked at. Without it, `rank IS NULL` cannot be read — "not on
 * page one" and "nowhere" are different claims.
 */
async function scanOneKeyword(cdp, sessionId, { storefront, keyword, tracked, pages, pacer, step }) {
  const placements = new Map()
  /* 同一页上**所有人**的自然位，不只我们自己的 —— 自动发现竞品要用它。
     只收自然位（sponsored 另算），最多 TOP_RESULT_LIMIT 条。 */
  const results = []
  const problems = []
  let scanned = 0
  let lastRowCount = 0
  let infoLine = null

  for (let page = 1; page <= pages; page += 1) {
    await pacer.beforeNavigate(step.value)
    step.value += 1

    const url = searchUrl(storefront, keyword, page)
    let scan
    try {
      await navigate(cdp, sessionId, url)
      await pacer.afterLoad()
      scan = await evaluate(cdp, sessionId, READ_SEARCH_RESULTS)
    } catch (error) {
      problems.push({ code: 'navigate-failed', page, detail: error.message })
      break
    }

    const verdict = classifySearchPage(scan)
    if (!verdict.ok) {
      // No verdict is stored from a page that did not render results.
      problems.push({ code: verdict.reason, page, detail: '页面没有渲染出结果，本条关键词本次不写库' })
      break
    }

    infoLine = scan.infoLine ?? infoLine
    scanned = page
    lastRowCount = Array.isArray(scan.rows) ? scan.rows.length : 0

    for (const hit of pickPlacements(scan, { page, tracked })) {
      if (!placements.has(hit.asin)) placements.set(hit.asin, hit)
    }


    /* 这一页的全部自然位（不限 tracked）。自动发现竞品的原料就是它。 */
    for (const hit of pickPlacements(scan, { page })) {
      if (hit.sponsored === true) continue
      if (results.length >= TOP_RESULT_LIMIT) break
      results.push({ asin: hit.asin, rank: hit.rank, page: hit.page })
    }
    // A short page is the last page. Continuing would navigate to an empty
    // result set for every remaining page, which is pure noise in the log.
    if (lastRowCount < RESULTS_PER_PAGE) break
  }

  // Positions actually examined. Page N contributes up to RESULTS_PER_PAGE.
  const depth = scanned === 0 ? null : (scanned - 1) * RESULTS_PER_PAGE + lastRowCount

  return { keyword, placements, results, depth, pagesScanned: scanned, problems, infoLine }
}

/**
 * Everything the keyword scan needs from the store to write its result: the
 * listing text of each tracked ASIN, so `inListing` is a measurement rather
 * than an assumption.
 *
 * Read once before the walk rather than per keyword: the listing does not
 * change while we scan, and re-reading it for every keyword would be one query
 * per keyword per ASIN.
 */
function listingCoverage(store, asins, marketplace) {
  const text = new Map()
  for (const asin of asins) text.set(asin, listingTextFor(store, asin, marketplace))
  return text
}

/**
 * Write one keyword's result.
 *
 * Every tracked ASIN gets a row, including the ones that did not appear — that
 * absence *is* the gap, and a row is the only way to say "we looked, and it was
 * not there". `scanDepth` travels with it so the claim is bounded.
 */
function persistScan(store, {
  marketplace, sourceId, keyword, tracked, placements, results = [], depth, inListing, taskId = null,
}) {
  const now = nowIso()
  /* 现场搜到的自然位写了几条 —— 返回给任务结果，好知道竞品原料有没有进库。 */
  let writtenSearchResults = 0
  const tiers = []

  for (const asin of tracked) {
    const hit = placements.get(asin) ?? null
    const covered = keywordInText(keyword, inListing.get(asin) ?? '')
    const { tier, basis } = classifyKeyword({
      rank: hit === null ? null : hit.rank,
      scanDepth: depth,
      inListing: covered,
    })

    upsertAsinKeyword(store, {
      asin,
      marketplace,
      keyword,
      sourceId,
      rank: hit === null ? null : hit.rank,
      page: hit === null ? null : hit.page,
      scanDepth: depth,
      tier,
      tierBasis: basis,
      collectedAt: now,
    })
    /* 同一次扫描再写一条**只追加**的观测：上面那条是覆盖写的「当前状态」，
       这条是历史。没有它，一周后重扫就把上周的名次抹掉了，也就谈不上监控。
       taskId 由调用方传（扫描任务 id），没有就留空 —— 空是「不知道」，不是「没有任务」。 */
    recordRankObservation(store, {
      keyword,
      marketplace,
      asin,
      observedAt: now,
      rank: hit === null ? null : hit.rank,
      organicPage: hit === null ? null : hit.page,
      /* 广告位当前还没采：留空并在查询侧报「未采集」，
         不要写 0 —— 0 会被读成「广告排第 0 名」。 */
      adRank: null,
      adPage: null,
      scanDepth: depth,
      source: sourceId,
      taskId: taskId ?? null,
    })
    if (tier !== null) tiers.push(tier)
  }

  /* 这一页上的**所有**自然位，写进竞品事实表 —— 自动发现竞品的原料。
     source_file 用 `search:<站点>:<词>`：同一个词重扫是替换，不会越积越多。
     source_id='search-scan' 标明「现场搜的」，与卖家精灵/西柚的反查区分开。 */
  if (Array.isArray(results) && results.length > 0) {
    const sourceFile = 'search:' + marketplace + ':' + keyword
    let written = 0
    for (const hit of results) {
      if (hit === null || hit.asin === undefined) continue
      store.run(
        `INSERT OR REPLACE INTO kw_competitor_fact
           (keyword, marketplace, asin, source_id, source_file, organic_rank, organic_page,
            organic_no_rank, imported_at)
         VALUES (?, ?, ?, 'search-scan', ?, ?, ?, 0, ?)`,
        [keyword, marketplace, String(hit.asin).toUpperCase(), sourceFile, hit.rank ?? null, hit.page ?? null, now],
      )
      written += 1
    }
    if (written > 0) writtenSearchResults += written
  }

  upsertKeyword(store, {
    keyword,
    marketplace,
    sourceId,
    tier: rollupTier(tiers).tier,
    tierBasis: { reason: 'scan-rollup', tiers, depth },
  })
  return { searchResults: writtenSearchResults }
}

/**
 * The listing text a keyword is matched against, for one ASIN.
 *
 * Taken from the newest snapshot rather than from the `listing` table: the
 * snapshot is what collection actually wrote, so this reflects the page as it
 * was seen. An ASIN that has never been collected yields an empty string, and
 * `keywordInText` then reports "not covered" — which is the honest answer, and
 * the reason a tier built on it is labelled with its basis.
 */
export function listingTextFor(store, asin, marketplace) {
  const payload = latestSnapshotPayload(store, asin, marketplace)
  if (payload === null) return ''
  return listingText({
    title: payload.fields?.title ?? null,
    bullets: payload.raw?.bullets ?? null,
    description: payload.fields?.description ?? null,
  })
}

/**
 * Recompute tiers for one ASIN from what is already stored.
 *
 * Needed after a manual or third-party import: an imported row carries a rank
 * and a depth but no tier, and an untiered row is invisible to every
 * tier-ordered view. Also refreshes the library rollup, so the master list and
 * the per-ASIN view cannot drift apart.
 *
 * @returns how many per-ASIN rows changed tier.
 */
export function recomputeTiersForAsin(store, asin, marketplace) {
  const market = String(marketplace).trim().toUpperCase()
  const id = String(asin).trim().toUpperCase()
  const rows = store.all(
    `SELECT keyword, source_id, rank, scan_depth, tier FROM asin_keyword
      WHERE asin = ? AND marketplace = ?`,
    [id, market],
  )
  if (rows.length === 0) return { updated: 0, keywords: 0 }

  const text = listingTextFor(store, id, market)
  let updated = 0

  store.tx(() => {
    for (const row of rows) {
      const { tier, basis } = classifyKeyword({
        rank: row.rank,
        scanDepth: row.scan_depth,
        inListing: keywordInText(row.keyword, text),
      })
      if (tier !== row.tier) {
        store.run(
          `UPDATE asin_keyword SET tier = ?, tier_basis_json = ?
            WHERE asin = ? AND marketplace = ? AND keyword = ? AND source_id = ?`,
          [tier, JSON.stringify(basis), id, market, row.keyword, row.source_id],
        )
        updated += 1
      }
    }

    for (const keyword of new Set(rows.map(row => row.keyword))) {
      const tiers = store
        .all('SELECT tier FROM asin_keyword WHERE keyword = ? AND marketplace = ?', [keyword, market])
        .map(entry => entry.tier)
      store.run(
        'UPDATE keyword SET tier = ?, updated_at = ? WHERE keyword = ? AND marketplace = ?',
        [rollupTier(tiers).tier, nowIso(), keyword, market],
      )
    }
  })

  return { updated, keywords: new Set(rows.map(row => row.keyword)).size }
}

/* ───────────────────────── task lifecycle ───────────────────────── */

/**
 * Keyword scans run through the same queue and the same task table as
 * collection. They share one browser and one login, so running them at the same
 * time as a collection task would interleave two scrapers in one tab — the
 * queue is what prevents that, and it is why the two live in one service.
 */
export function createKeywordService({ store, workbench, collector, logger = console, pacing: pacingOverrides, gate } = {}) {
  const pacing = resolvePacing(pacingOverrides)
  const browserGate = gate ?? createPassThroughGate()
  const queue = []
  let draining = false
  let active = null
  let lastFinishedAt = 0

  function recover() {
    const { interrupted, requeued } = recoverStaleTasks(store, 'keyword')
    if (interrupted.length > 0) {
      logger?.warn?.(`[amazon-ops] ${interrupted.length} keyword scan(s) interrupted by a restart: ${interrupted.join(', ')}`)
    }
    for (const id of requeued) queue.push(id)
    if (requeued.length > 0) {
      logger?.info?.(`[amazon-ops] re-queued ${requeued.length} pending keyword scan(s)`)
      void drain()
    }
    return { interrupted, requeued }
  }

  function submit({ source = 'browser-local', marketplace, keywords, asins = null, pages = 1, options = {} } = {}) {
    if (collector === undefined || collector === null) {
      throw new Error('no browser collector is configured, so keyword scanning is unavailable')
    }
    const market = String(marketplace ?? '').trim().toUpperCase()
    if (market === '') throw new Error('marketplace is required')

    const list = [...new Set((keywords ?? []).map(word => String(word ?? '').trim()).filter(word => word !== ''))]
    if (list.length === 0) throw new Error('keywords is empty')
    if (list.length > SCAN_KEYWORD_MAX) {
      throw new Error(`too many keywords: ${list.length} > ${SCAN_KEYWORD_MAX}. Split it into several submissions.`)
    }

    const pageCount = Math.max(1, Math.min(SCAN_PAGE_MAX, Math.trunc(Number(pages) || 1)))

    // Default: every ASIN we track on this storefront. That is what "coverage"
    // means — a scan that silently covered only some of the catalogue would
    // report gaps that are really just ASINs it was not asked about.
    const tracked = resolveTrackedAsins(store, market, asins)
    if (tracked.length === 0) {
      throw new Error(
        `no ASINs to measure on ${market}. Collect or import some first `
        + '(amzn_collect_submit / amzn_asin_upsert), or pass asins explicitly.',
      )
    }

    const id = randomUUID()
    insertCollectionTask(store, {
      id,
      sourceId: source,
      kind: 'keyword',
      targets: list.map(keyword => ({ keyword, marketplace: market })),
      fields: { pages: pageCount, asins: tracked, strictStorefront: options.strictStorefront !== false },
    })

    workbench?.record('keyword:queued', { taskId: id, marketplace: market, keywords: list.length, asins: tracked.length }, 'plugin')
    queue.push(id)
    void drain()

    return {
      taskId: id,
      kind: 'keyword',
      marketplace: market,
      keywords: list,
      asins: tracked,
      pages: pageCount,
      // Worst case, and deliberately not optimistic: a status check that looks
      // hung is worse than a number that turned out generous.
      estimatedMinutes: Math.max(1, Math.round((list.length * pageCount * 9_000) / 60_000)),
      status: 'queued',
    }
  }

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        const taskId = queue.shift()
        const task = getCollectionTask(store, taskId)
        if (task === undefined || task.status !== 'queued') continue
        await runTask(task)
      }
    } catch (error) {
      logger?.error?.(`[amazon-ops] keyword runner failed: ${error.stack ?? error.message}`)
    } finally {
      draining = false
    }
  }

  async function runTask(task) {
    const taskId = task.id
    const options = safeParse(task.fields_json, {}) ?? {}
    const targets = safeParse(task.targets_json, [])
    const keywords = targets.map(target => target.keyword).filter(Boolean)
    const marketplace = String(targets[0]?.marketplace ?? 'US').toUpperCase()
    const pages = Math.max(1, Math.trunc(Number(options.pages) || 1))
    const tracked = Array.isArray(options.asins) ? options.asins : []
    const sourceId = task.source_id
    const storefront = storefrontFor(marketplace)

    const gap = lastFinishedAt === 0 ? 0 : Math.max(0, lastFinishedAt + randomBetween(pacing.taskGapMs) - Date.now())
    if (gap > 0) await sleep(gap)

    const controller = new AbortController()
    active = { taskId, controller }

    updateCollectionTask(store, taskId, {
      status: 'running',
      error: null,
      progress_json: JSON.stringify({ done: 0, total: keywords.length, phase: 'starting' }),
    })
    workbench?.record('keyword:start', { taskId, marketplace, keywords: keywords.length }, 'plugin')

    const inListing = listingCoverage(store, tracked, marketplace)
    const results = []
    const missingFields = new Set()
    let scanned = 0
    let blocked = null
    let storefrontAdjusted = false
    let lastProgressAt = 0
    const step = { value: 0 }

    const startedAt = Date.now()
    try {
      // The whole scan runs under the shared browser gate: it must not overlap
      // a collection task, or the two would switch the shared cookie jar under
      // each other's feet (see sources/browser/gate.js).
      await browserGate.run(() => collector.withPage(async (cdp, page) => {
        await applyStorefront(cdp, page.sessionId, storefront)
        await navigate(cdp, page.sessionId, `https://${storefront.domain}/`)
        const session = await ensureStorefront(cdp, page.sessionId, storefront, { logger })
        storefrontAdjusted = session.actions.length > 0

        const pacer = createPacer({ pacing })

        for (const [index, keyword] of keywords.entries()) {
          if (controller.signal.aborted) { blocked = blocked ?? 'cancelled'; break }

          const outcome = await scanOneKeyword(cdp, page.sessionId, {
            storefront, keyword, tracked, pages, pacer, step,
          })

          /* 2026-10-25（R-28）：**这个功能从第一次调用就是坏的。**
             原来 scanWritten 用 const 定义在 if 块**里面**，而第 639 行在**块外**读它。
             node --check 抓不到（语法合法），测试也抓不到（没有一条真的跑到这一步），
             但**任何一次真实扫描都会立刻抛 ReferenceError: scanWritten is not defined**。
             实测 task 1e095d44（3 词 / 1 页 / 4 ASIN）11 秒后失败，错误正是这一句。
             **这就是 kw_rank_observation 一直 0 行的真正原因** —— 不是没人跑，是跑了就崩。 */
          let scanWritten = null
          if (outcome.depth !== null) {
            scanWritten = persistScan(store, {
              marketplace, sourceId, keyword, tracked,
              placements: outcome.placements, depth: outcome.depth, inListing, taskId,
            })
            scanned += 1
          }
          for (const problem of outcome.problems) missingFields.add(problem.code)
          if (outcome.problems.some(problem => problem.code === 'captcha')) blocked = blocked ?? 'blocked'

          results.push({
            keyword,
            depth: outcome.depth,
            pagesScanned: outcome.pagesScanned,
            found: [...outcome.placements.values()].map(hit => ({ asin: hit.asin, rank: hit.rank, page: hit.page })),
            searchResults: scanWritten === null ? 0 : scanWritten.searchResults,
            problems: outcome.problems,
          })

          const now = Date.now()
          if (now - lastProgressAt > PROGRESS_THROTTLE_MS || index === keywords.length - 1) {
            lastProgressAt = now
            updateCollectionTask(store, taskId, {
              progress_json: JSON.stringify({
                done: index + 1, total: keywords.length, phase: 'scanning',
                keyword, scanned, blocked,
              }),
            })
          }
        }
      }))

      const status = blocked === 'blocked' ? (scanned > 0 ? 'partial' : 'failed')
        : scanned === 0 ? 'failed'
          : scanned < keywords.length ? 'partial' : 'done'

      updateCollectionTask(store, taskId, {
        status,
        finished_at: nowIso(),
        error: blocked === 'blocked' ? '遇到验证码/风控页，已停止（不重试、不绕过）' : null,
        result_json: JSON.stringify({
          ok: status === 'done',
          scanned,
          total: keywords.length,
          blocked,
          storefrontAdjusted,
          asins: tracked.length,
          missingFields: [...missingFields],
          durationMs: Date.now() - startedAt,
          results: results.slice(0, 200),
        }),
        progress_json: JSON.stringify({ done: scanned, total: keywords.length, phase: 'finished', scanned, blocked }),
      })
      workbench?.record('keyword:done', { taskId, status, scanned, blocked }, 'plugin')
    } catch (error) {
      updateCollectionTask(store, taskId, {
        status: 'failed',
        finished_at: nowIso(),
        error: error.message,
        progress_json: JSON.stringify({ done: 0, total: keywords.length, phase: 'failed' }),
      })
      workbench?.record('keyword:done', { taskId, status: 'failed', error: error.message }, 'plugin')
    } finally {
      lastFinishedAt = Date.now()
      active = null
    }
  }

  return {
    recover,
    submit,

    /** The gate this service runs browser work through. Asserted by a test to
     *  be the *same object* the collection service holds — see `index.js`. */
    gate: browserGate,

    status(taskId) {
      const task = getCollectionTask(store, taskId)
      if (task === undefined) {
        const recent = listCollectionTasks(store, 5)
        return {
          ok: false,
          error: `no task "${taskId}"`,
          hint: recent.length === 0
            ? '还没有任何任务。用 amzn_keyword_scan 提交一个关键词覆盖扫描。'
            : `最近的 task id: ${recent.map(row => row.id).join(', ')}`,
        }
      }
      return { ok: true, task, running: active?.taskId === task.id, queueDepth: queue.length }
    },

    stop() {
      active?.controller.abort()
      queue.length = 0
    },

    get runningTaskId() {
      return active?.taskId ?? null
    },
  }
}

/** The ASINs a scan measures: explicit list, or everything on the storefront. */
function resolveTrackedAsins(store, marketplace, requested) {
  if (Array.isArray(requested) && requested.length > 0) {
    return [...new Set(requested.map(asin => String(asin).trim().toUpperCase()).filter(Boolean))]
  }
  return store
    .all('SELECT asin FROM asin WHERE marketplace = ? ORDER BY asin', [marketplace])
    .map(row => row.asin)
}

function keyCodeFor(ch) {
  if (/[a-z]/i.test(ch)) return `Key${ch.toUpperCase()}`
  if (/[0-9]/.test(ch)) return `Digit${ch}`
  if (ch === ' ') return 'Space'
  return ''
}

const randomBetween = ([min, max]) => min + Math.random() * Math.max(0, max - min)

function safeParse(json, fallback) {
  try {
    const value = JSON.parse(json)
    return value === null || value === undefined ? fallback : value
  } catch {
    return fallback
  }
}
