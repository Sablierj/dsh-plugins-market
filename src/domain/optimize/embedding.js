/**
 * Where each keyword should go, and what the draft actually covers.
 *
 * This module is the joint between step 3 and step 4. Step 3 established that
 * "no rank" and "never looked" are different facts and stored a tier for every
 * word it could; step 4 has to turn that into an instruction a writer can follow
 * ("this word goes in the title") instead of a list of words to sprinkle.
 *
 * The plan is a mapping from tier to position, and it is the one place in the
 * plugin where a *recommendation* rather than a fact is produced. So it carries
 * its reasoning: each entry says which tier it came from and why that tier means
 * that position. A recommendation nobody can argue with is not advice.
 *
 * The mapping follows the SOP's 分层埋词 (`SOP §2.3`):
 *
 *   核心大词+场景词 → 标题      ← our T1/T2: already ranking, or close
 *   意图词+差异化词 → 五点      ← our T3/T4: relevance to build or reinforce
 *   未覆盖词+同义/拼错 → 后台   ← our blind spots: unknown, so cheapest slot
 *
 * Note what is deliberately absent: the hub grades keywords S/A/B/C, but that
 * grade needs search volume and conversion rate, which only a paid source can
 * supply (`build_keyword_master.py` computes it from `vol` and `cvr`). We have
 * neither, so we do not invent a grade — we use the two facts we do have, rank
 * and listing coverage, and say so.
 */

import { keywordInText, listingText, TIER_LABELS } from '../../sources/keyword-tiers.js'
import { lexiconFor } from '../rules/lexicon.js'

/**
 * Front-end text of a *draft*, which is numbered fields rather than a listing row.
 *
 * `listingText` takes `{ title, bullets, description }` — a stored listing. A
 * draft is `{ title, bullet_1 … bullet_5, description }`, so handing it to
 * `listingText` would silently cover only the title and description and report
 * every bullet keyword as missing. That is the kind of wrong answer that looks
 * like a finding, so the adapter is explicit and shared.
 */
export function frontText(fields = {}) {
  const bullets = Object.entries(fields)
    .filter(([key]) => key.startsWith('bullet_'))
    .sort((a, b) => Number(a[0].slice(7)) - Number(b[0].slice(7)))
    .map(([, value]) => value)
  return listingText({ title: fields.title, bullets, description: fields.description })
}

/**
 * Tier → position. `front` is what goes in the listing text; `note` is the
 * argument for it, and it ends up in the report verbatim.
 */
export const TIER_POSITION = {
  T1: { position: 'title', front: true, note: '第一页已有排名。丢了它排名就没了，标题里必须留着' },
  T2: { position: 'title', front: true, note: '有排名但不在第一页。放进标题是最省力的推法' },
  T3: { position: 'bullets', front: true, note: '平台认为相关却没给排名。五点里补上，把相关性坐实' },
  T4: { position: 'bullets', front: true, note: '测过、没排名、文案也没提。相关性还没建立，先埋进五点' },
}

/** Never measured: no verdict, so it only gets the cheapest slot. */
export const UNMEASURED = {
  position: 'search_terms',
  front: false,
  note: '从未测过排名。不占前端字符，先放后台词，测过之后再决定要不要上前台',
}

/** Ranked, but the listing never says the word — free relevance being left on the table.
 *
 *  `position: 'title'` here is only the *fallback* for a ranked word with no tier,
 *  where there is no better front slot to pick. A word that has a tier keeps the
 *  tier's position — see `buildEmbeddingPlan`. */
export const RANKED_BUT_SILENT = {
  position: 'title',
  front: true,
  note: '已经有排名，但当前文案里根本没有这个词。这是白拿的相关性，优先补',
}

/**
 * Build the per-keyword plan.
 *
 * `keywords` are coverage rows (keyword, tier, rank, scan_depth). `listing` is
 * the current listing row, used to see whether the word is already in the text.
 */
export function buildEmbeddingPlan({ keywords = [], listing = null } = {}) {
  const current = listingText(listing ?? {})
  const entries = keywords.map(row => {
    const inListing = row.inListing ?? (current === '' ? false : keywordInText(row.keyword, current))
    const tier = row.tier ?? null
    const ranked = row.rank !== null && row.rank !== undefined
    const measured = row.scan_depth !== null && row.scan_depth !== undefined
    /** Ranked but absent from the copy: the cheapest relevance available. */
    const silent = ranked && !inListing

    /* The tier decides *where*; `silent` only decides *how urgent*, and it used to
       override the placement. Sending every ranked-but-missing word to the title
       reads as "these are the best wins" but produces a plan no title can satisfy:
       in one measured case six phrases were told to go into a 200-character title,
       three of them from T3/T4 whose own note says to seed the bullets. The plan
       was unsatisfiable, so the fill rate it reported was measuring its own error
       rather than the copy. `quickWins` already carries the urgency signal, and the
       reason text below says it out loud. */
    let decision
    if (tier !== null && TIER_POSITION[tier] !== undefined) decision = TIER_POSITION[tier]
    else if (silent) decision = RANKED_BUT_SILENT
    else decision = UNMEASURED

    return {
      keyword: row.keyword,
      tier,
      tierLabel: tier === null ? '未测' : `${tier} ${TIER_LABELS[tier] ?? ''}`.trim(),
      rank: row.rank ?? null,
      scanDepth: row.scan_depth ?? null,
      inListing,
      measured,
      silent,
      position: decision.position,
      front: decision.front,
      reason: silent
        ? `${decision.note}　⚠️ 已经有排名却不在文案里 —— 白拿的相关性，优先补`
        : decision.note,
    }
  })

  /* Order by how much the entry is worth acting on: title candidates first, then
     bullets, then the backend. Inside a group, the better rank wins. */
  const order = { title: 0, bullets: 1, search_terms: 2 }
  entries.sort((a, b) => {
    const byPosition = order[a.position] - order[b.position]
    if (byPosition !== 0) return byPosition
    return (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
  })

  return {
    entries,
    counts: {
      title: entries.filter(entry => entry.position === 'title').length,
      bullets: entries.filter(entry => entry.position === 'bullets').length,
      search_terms: entries.filter(entry => entry.position === 'search_terms').length,
    },
    titleCandidates: entries.filter(entry => entry.position === 'title'),
    bulletCandidates: entries.filter(entry => entry.position === 'bullets'),
    backendCandidates: entries.filter(entry => entry.position === 'search_terms'),
    /** Ranked but missing from the copy — the cheapest wins available. */
    quickWins: entries.filter(entry => entry.rank !== null && entry.inListing === false),
  }
}

/**
 * Which keywords the draft covers, versus which the current listing covers.
 *
 * `lost` is the reason this exists. A rewrite that drops a word we already rank
 * for is a regression the author cannot see — the new copy reads better, and
 * the rank quietly disappears weeks later. Naming the lost words at review time
 * is the only moment the mistake is cheap to fix.
 *
 * Scope is the front-end text only (title + bullets + description). Backend
 * search terms are not indexed against these words the same way, and counting
 * them here would overstate coverage.
 */
export function coverageDelta({ keywords = [], before = null, after = {} } = {}) {
  const beforeText = listingText(before ?? {})
  const afterText = frontText(after)

  const gained = []
  const lost = []
  const kept = []
  const still = []

  for (const row of keywords) {
    const keyword = row.keyword
    if (keyword === undefined || keyword === null || keyword === '') continue
    const was = beforeText === '' ? false : keywordInText(keyword, beforeText)
    const now = afterText === '' ? false : keywordInText(keyword, afterText)
    const entry = { keyword, tier: row.tier ?? null, rank: row.rank ?? null, tierLabel: row.tier === null || row.tier === undefined ? '未测' : `${row.tier} ${TIER_LABELS[row.tier] ?? ''}`.trim() }
    if (!was && now) gained.push(entry)
    else if (was && !now) lost.push(entry)
    else if (was && now) kept.push(entry)
    else still.push(entry)
  }

  const byTier = (list) => {
    const counts = { T1: 0, T2: 0, T3: 0, T4: 0, untiered: 0 }
    for (const entry of list) {
      if (entry.tier === null || entry.tier === undefined) counts.untiered += 1
      else counts[entry.tier] = (counts[entry.tier] ?? 0) + 1
    }
    return counts
  }

  return {
    gained,
    lost,
    kept,
    still,
    summary: {
      beforeCovered: kept.length + lost.length,
      afterCovered: kept.length + gained.length,
      delta: gained.length - lost.length,
      total: keywords.length,
      gainedByTier: byTier(gained),
      lostByTier: byTier(lost),
    },
  }
}

/**
 * The backend search terms worth filling the 249 bytes with.
 *
 * Excludes anything already in the front-end copy: the SOP is explicit that
 * repeating a front-end word there wastes bytes, and bytes are the whole budget.
 *
 * The word-splitting goes through the site's lexicon rather than a bare
 * `/[^a-z0-9']+/`: on a Japanese listing that English class returns nothing, so
 * every keyword looked "uncovered" and the backend list filled with words the
 * front end already carried. `marketplace` picks the tokeniser; omitting it
 * falls back to the English one (with the caveat the report prints).
 */
export function backendCandidates({ plan, fields = {}, marketplace = null } = {}) {
  const lexicon = lexiconFor(marketplace)
  const front = frontText(fields)
  const used = new Set()
  if (front !== '') {
    for (const word of lexicon.tokenize(front)) if (word.length > 2) used.add(word)
  }
  return (plan?.backendCandidates ?? []).filter(entry => {
    const parts = lexicon.tokenize(entry.keyword).filter(word => word.length > 2)
    if (parts.length === 0) return true
    /* Keep the keyword if any of its significant words is missing up front — a
       partially covered phrase still adds something. */
    return parts.some(word => !used.has(word))
  })
}
