/**
 * Seeds → candidates, from three places that measure three different things.
 *
 * Research used to live in the conversation: you typed seed words at the agent,
 * the agent ran `amzn_keyword_discover`, and the answer scrolled away. B06 moves
 * the flow into the page (seed box → candidates → tick → import), which means
 * the merge has to be a function rather than a paragraph of prose in a prompt.
 *
 * ## The three sources, and why each one is a different kind of evidence
 *
 *   - `suggest`  — Amazon's own completion dropdown, read from a real storefront.
 *                  Evidence that the word is *used*; says nothing about demand.
 *   - `library`  — a word already in `keyword`/`kw_master`. Evidence that we
 *                  already track it; says nothing about whether we should.
 *   - `competitor` — a word a competitor ranks for, from `kw_competitor_fact`.
 *                  Evidence that the word *converts* for this category.
 *
 * None of them implies another, and a candidate carries **every** source that
 * produced it rather than the first one seen. Collapsing to one source would
 * lose exactly the signal the user is looking for: a word that both Amazon
 * suggests and a competitor ranks for is a different proposition from a word
 * that only appeared in a dropdown.
 *
 * ## `sources` is not `in_library`, and the difference is load-bearing
 *
 * These look like the same fact and are not:
 *
 *   - `sources` includes `'library'` when the library read *produced* the
 *     candidate — a substring match on the seed, i.e. "here is a word we track
 *     that relates to what you typed".
 *   - `in_library` is "this exact word is already ours", answered by an exact
 *     lookup (`input.inLibrary`), whatever route the candidate took to get here.
 *
 * Using the first for the second is a bug that actually happened: a word that
 * arrived from Amazon's dropdown is normally *not* a substring match for the
 * seed that produced it, so `sources` said `['suggest']` and the candidate was
 * bucketed `fresh` — offered for import while the library already held it at T2.
 * The bucket has to come from `in_library`.
 *
 * ## This module collects nothing
 *
 * The competitor source reads `kw_competitor_fact` and **only** that. It does
 * not trigger a collection, does not open a browser, and does not call the
 * collector. §7 of the architecture is explicit that competitor data arrives
 * through the existing importer, and a "research" button that quietly started a
 * scrape would be the kind of side effect a user cannot see and did not ask for.
 * Everything here is a pure function over rows the caller already has.
 *
 * ## The three buckets, which are the actual output
 *
 * A list of 400 words is not an answer. What makes it actionable is which of
 * three situations each word is in:
 *
 *   - `gap`   — not in our library, and a competitor ranks for it. Someone else
 *               holds a word we do not even track. Act on it.
 *   - `fresh` — not in our library, nobody we track ranks for it. Worth a look.
 *   - `known` — already in our library. Nothing to do; carried so the user can
 *               see that a seed was already covered instead of re-importing it.
 *
 * Sorting is `gap` → `fresh` → `known`, then by search volume, then by spelling.
 * Volume is the only quantity in the whole pipeline that is a measurement rather
 * than a judgement, so it is the only thing used to order within a bucket.
 */

import { keywordKey } from './key.js'

/**
 * Where a candidate's `search_volume` came from. The value alone is not enough:
 * a library full of competitor-monthly volumes must not read as a library of
 * measured ones (`competitor.js` makes the same distinction).
 */
export const VOLUME_ORIGINS = ['competitor_fact', 'library']

/** The three buckets, in display order. */
export const RESEARCH_BUCKETS = ['gap', 'fresh', 'known']

/** Source priority when a candidate carries several. `competitor` wins. */
const SOURCE_RANK = { competitor: 0, suggest: 1, library: 2 }

/**
 * Every keyword the inputs mention, folded, deduplicated.
 *
 * Exists so the caller can ask the store "which of these are already ours?"
 * **before** calling `buildResearchCandidates`. The alternative — looking
 * membership up inside the merge — would either make this module impure or make
 * the store call happen mid-loop, and both are worse than one extra pass over
 * the same rows.
 */
export function collectCandidateKeywords(input = {}) {
  const words = new Set()
  for (const key of ['suggest', 'library', 'competitor']) {
    for (const row of input[key] ?? []) {
      const keyword = keywordKey(row?.keyword)
      if (keyword !== '') words.add(keyword)
    }
  }
  return [...words]
}

/**
 * Merge the three sources into one ranked candidate list.
 *
 * @param {object} input
 * @param {string[]} input.seeds
 * @param {string} input.marketplace
 * @param {Array<{seed?: string, keyword: string, searchVolume?: number|null, difficulty?: number|null}>} [input.suggest]
 * @param {Array<{seed?: string, keyword: string, tier?: string|null, searchVolume?: number|null, difficulty?: number|null}>} [input.library]
 *   The library **source**: words we already track that relate to a seed.
 * @param {Map<string, {tier?: string|null, searchVolume?: number|null, difficulty?: number|null}>|Array} [input.inLibrary]
 *   Exact membership, keyed by folded keyword. Decides `in_library`; `library`
 *   above does not. An array of rows is accepted for callers that have one.
 * @param {Array<{seed?: string, keyword: string, searchVolume?: number|null, bestRank?: number|null,
 *                rankedCount?: number, presentCount?: number, asins?: string[]}>} [input.competitor]
 * @param {{limit?: number}} [options]
 */
export function buildResearchCandidates(input = {}, { limit = 200 } = {}) {
  const seeds = [...new Set((input.seeds ?? []).map(seed => String(seed ?? '').trim()).filter(Boolean))]
  const marketplace = String(input.marketplace ?? '').trim().toUpperCase()
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 200), 1), 2000)

  /* Keyed by the folded spelling, not the raw one. The candidates are headed for
     `amzn_keyword_import`, which stores folded, so a candidate shown as
     "Bluetooth Speaker" would land as "bluetooth speaker" — the page would offer
     a word and then write a different one. Folding here is what makes the
     checkbox honest. See `key.js` and ARCHITECTURE §7.1-E4 决定 D1. */
  const byKeyword = new Map()
  const seedHits = new Map()

  const touch = (rawKeyword, source, seed = null) => {
    const keyword = keywordKey(rawKeyword)
    if (keyword === '') return null
    let entry = byKeyword.get(keyword)
    if (entry === undefined) {
      entry = {
        keyword,
        sources: [],
        seeds: [],
        search_volume: null,
        volume_origin: null,
        difficulty: null,
        in_library: false,
        library_tier: null,
        competitor_best_rank: null,
        competitor_ranked_count: 0,
        competitor_total: 0,
        competitor_present_count: 0,
        competitor_asins: [],
      }
      byKeyword.set(keyword, entry)
    }
    if (!entry.sources.includes(source)) entry.sources.push(source)
    if (seed !== null && seed !== '' && !entry.seeds.includes(seed)) {
      entry.seeds.push(seed)
      seedHits.set(seed, (seedHits.get(seed) ?? 0) + 1)
    }
    return entry
  }

  /* ── the library *source*: words we already track that relate to a seed. This
     sets `sources`/tier/volume but **not** `in_library` — see below. ── */
  for (const row of input.library ?? []) {
    const entry = touch(row.keyword, 'library', row.seed ?? null)
    if (entry === null) continue
    if (entry.library_tier === null || entry.library_tier === undefined) entry.library_tier = row.tier ?? null
    if (entry.search_volume === null && row.searchVolume !== null && row.searchVolume !== undefined) {
      entry.search_volume = row.searchVolume
      entry.volume_origin = 'library'
    }
    if (entry.difficulty === null && row.difficulty !== null && row.difficulty !== undefined) {
      entry.difficulty = row.difficulty
    }
  }

  for (const row of input.suggest ?? []) {
    const entry = touch(row.keyword, 'suggest', row.seed ?? null)
    if (entry === null) continue
    if (entry.difficulty === null && row.difficulty !== null && row.difficulty !== undefined) {
      entry.difficulty = row.difficulty
    }
  }

  /* ── competitor last, and it overwrites the volume origin rather than losing
     to it. `monthly_volume` from a competitor export is a real measurement of
     demand for that word; a library figure may itself have come from a competitor
     export (that is where most of them come from), so preferring the direct read
     avoids attributing it to the library. ── */
  for (const row of input.competitor ?? []) {
    const entry = touch(row.keyword, 'competitor', row.seed ?? null)
    if (entry === null) continue
    if (row.searchVolume !== null && row.searchVolume !== undefined) {
      entry.search_volume = row.searchVolume
      entry.volume_origin = 'competitor_fact'
    }
    // `null`, never 0. A best rank of 0 reads as "ranked first".
    entry.competitor_best_rank = row.bestRank ?? null
    entry.competitor_ranked_count = Number(row.rankedCount ?? 0)
    entry.competitor_present_count = Number(row.presentCount ?? 0)
    entry.competitor_total = Number(row.total ?? 0)
    entry.competitor_asins = row.asins ?? []
  }

  /* ── membership, last, and over every candidate regardless of how it got here.
     `in_library` is "is this exact word already ours", and it has to be answered
     by an exact lookup, not by whether the library *source* happened to surface
     the word. A candidate from Amazon's dropdown is usually not a substring
     match for the seed that produced it, so a substring-derived answer called it
     `fresh` and offered it for import while the library already held it. ── */
  const membership = input.inLibrary ?? new Map()
  for (const entry of byKeyword.values()) {
    const known = membership instanceof Map
      ? membership.get(entry.keyword)
      : (membership ?? []).find(row => keywordKey(row.keyword) === entry.keyword)
    if (known === undefined || known === null) continue
    entry.in_library = true
    if (entry.library_tier === null || entry.library_tier === undefined) entry.library_tier = known.tier ?? null
    if (entry.search_volume === null && known.searchVolume !== null && known.searchVolume !== undefined) {
      entry.search_volume = known.searchVolume
      entry.volume_origin = 'library'
    }
    if (entry.difficulty === null && known.difficulty !== null && known.difficulty !== undefined) {
      entry.difficulty = known.difficulty
    }
  }

  const candidates = []
  const counts = { total: 0, suggest: 0, library: 0, competitor: 0, gap: 0, fresh: 0, known: 0 }

  for (const entry of byKeyword.values()) {
    const bucket = entry.in_library ? 'known' : (entry.sources.includes('competitor') ? 'gap' : 'fresh')
    const source = [...entry.sources].sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b])[0]

    counts.total += 1
    counts[bucket] += 1
    for (const s of entry.sources) counts[s] += 1

    candidates.push({
      ...entry,
      source,
      bucket,
      /* No volume from any source. `no_volume` rather than a 0 that would sort to
         the bottom and read as "no demand".

         Named `no_volume` and **not** `no_data` on purpose: `competitor.js` uses
         `no_data` for "we hold no competitor-side measurement for this word",
         which is a different claim about a different thing. One field name
         carrying two meanings across two modules is how a view ends up rendering
         an empty competitor cell for a word whose volume is simply unmeasured.
         (The same collision is why `amzn_rule_list` renamed its two gap counts —
         see ARCHITECTURE §4.1.) */
      no_volume: entry.search_volume === null,
      reason: explain(entry, bucket),
    })
  }

  const bucketRank = Object.fromEntries(RESEARCH_BUCKETS.map((b, i) => [b, i]))
  candidates.sort((a, b) => bucketRank[a.bucket] - bucketRank[b.bucket]
    || (b.search_volume ?? -1) - (a.search_volume ?? -1)
    || (a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0))

  /* A seed that produced nothing is a result, not an absence. Amazon's dropdown
     is empty for plenty of real words, and a user who typed a seed and got a
     blank panel cannot tell that from a broken button. Reported per seed.

     Every source has to tag its rows with the seed, which is why the two store
     reads take one seed each: with a batch `OR`ed `LIKE` there is no way to
     recover which pattern matched, and a seed that only matched library rows
     would be reported as having produced nothing. That was the first version's
     bug, and it read as "your seed found nothing" while the table below it was
     full of that seed's words. */
  const barrenSeeds = seeds.filter(seed => (seedHits.get(seed) ?? 0) === 0)

  return {
    seeds,
    marketplace,
    candidates: candidates.slice(0, cap),
    counts,
    // `counts.total` is the pre-cap total, so a truncated list says so instead of
    // looking complete. The pipeline makes the same distinction.
    truncated: counts.total > cap,
    barrenSeeds,
    /* Input rows supplied, **not** the same number as `counts.suggest` /
       `counts.library` / `counts.competitor` — those count *candidates* that
       carry the source, and one candidate can carry three. Two numbers that
       both read as "how many suggestions" is how a reader concludes the merge
       dropped rows; the names have to say which is which. */
    inputRows: {
      suggest: (input.suggest ?? []).length,
      library: (input.library ?? []).length,
      competitor: (input.competitor ?? []).length,
    },
  }
}

/**
 * One line saying why this word is in this bucket.
 *
 * The page shows it verbatim. It is derived from the row rather than stored, so
 * it cannot drift from the bucket it explains.
 *
 * `fresh` needs no branch on the source: by construction it is `!in_library`
 * and has no `competitor` row, which leaves `suggest` as the only source it can
 * have come from. A `?? '扩词候选'` fallback here would be unreachable, and an
 * unreachable branch is a claim about the code that nothing checks.
 */
export function explain(entry, bucket) {
  if (bucket === 'known') {
    return `库里已有${entry.library_tier === null || entry.library_tier === undefined ? '' : `（${entry.library_tier}）`}，无需再导入`
  }
  if (bucket === 'gap') {
    // `ranked_count === 0` with a competitor row means they hold the word
    // without ranking for it. Still a gap, but a different one, and the reason
    // line is the only place the user can see which.
    return entry.competitor_ranked_count > 0
      ? `竞品 ${entry.competitor_ranked_count}/${entry.competitor_total} 有排名，我们库里没有`
      : `竞品有该词但都没排名，我们库里也没有`
  }
  return 'Amazon 搜索建议，库里没有，也没有竞品排名'
}
