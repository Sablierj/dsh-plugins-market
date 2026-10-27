/**
 * Per-ASIN keywords and their measured ranks (module 05, F05-02 tab 5 of 9).
 *
 * ## The unit is the (keyword, source) row, and that is deliberate
 *
 * `asin_keyword`'s primary key is `(asin, marketplace, keyword, source_id)`, so one
 * word measured by two sources is two rows. This tab shows **both**, one row each.
 * Collapsing them into "the rank" would require picking a winner, and picking a
 * winner is a judgement about which source to believe — that judgement has its own
 * machinery (`field_conflict` + the quality cockpit's `DQ-CONSIST-001`) and its own
 * module. A view that quietly took the best rank would disagree with the conflict
 * workbench about the same word and neither would report an error.
 *
 * `readCompetitorSides` (`store/kw.js`) *does* take the best rank, because it
 * answers a different question — "how do we look against them on this word" — and
 * one number per word is what that question needs. The two are not two
 * implementations of one rule; they are two stated rules for two questions.
 *
 * ## Three states, derived from content, never stored
 *
 * `rank IS NULL` in this table means "we looked and were not there"
 * (`store/schema.js` says so at the top of the file). But that reading only holds
 * when the row also carries evidence that a scan actually happened. So the state is
 * a three-way split.
 *
 * **The split is not re-derived here.** `classifyOurSide` in
 * `domain/keywords/competitor.js` already answers exactly this question — its own
 * comment states the rule: a null rank with no `scan_depth` "cannot support the
 * claim 'we are absent'". The first draft of this module judged it on
 * `collected_at` instead, and the two rules disagreed on a real row (a keyword with
 * a collection time but no scan depth): the keywords tab called it 「测过、没找到」
 * while the competitor tab called the same word 「未测」. Two answers to one question
 * on one page, with nothing failing anywhere. So the function is imported and the
 * states are renamed to the vocabulary it already uses.
 *
 * The page prints `stateLabel` and never re-derives it (`row.rank === null` appears
 * nowhere in the page's block for this tab).
 *
 * ## What this tab cannot say, and says so
 *
 * 「排名历史」. The upsert overwrites `rank` in place for the same
 * `(asin, marketplace, keyword, source_id)` — verified, see the contract §3.6 — so
 * the table keeps the *current* rank per source and no series. Reporting a trend
 * would mean inventing one. This is a **structural** hole, not "we have not
 * measured yet", so it is reported through `unsourced[]` and not as a state.
 */

import { ASIN_NO_SOURCE_TEXT, unsourced } from './unsourced.js'
import { clampLimit } from './limits.js'
import { classifyOurSide } from '../keywords/competitor.js'

/**
 * The three states, named with the vocabulary `classifyOurSide` already uses so
 * that this tab and the competitor tab cannot describe one word two ways.
 *
 * `absent` and `untested` are the pair that must not merge: the first is a
 * measurement, the second is the lack of one.
 */
export const ASIN_KEYWORD_STATES = ['ranked', 'absent', 'untested']

export const ASIN_KEYWORD_STATE_LABELS = {
  ranked: '有名次',
  absent: '测过、没找到',
  untested: '未测（没有扫描深度）',
}

/** Row cap for the per-(keyword, source) list, and its hard ceiling. */
export const ASIN_KEYWORD_ROW_LIMIT = 200
export const ASIN_KEYWORD_ROW_LIMIT_MAX = 1000

/**
 * Why 「排名历史」 has no source here. Kept next to the entry that carries it so a
 * change to the table's key has one obvious place to be noticed.
 */
export const ASIN_KEYWORD_RANK_HISTORY_REASON =
  'asin_keyword 的主键是 (asin, marketplace, keyword, source_id)，upsertAsinKeyword 对同一个来源是原地覆盖'
  + '（rank = excluded.rank，src/store/queries.js:572-579），没有任何列或表记录「这个词的名次在两次观测之间怎么变」。'
  + '所以这里报的是当前名次，不是趋势；跨来源的多行仍然各自保留 —— 那是「同一时刻不同来源的读数」，不是历史。'

/**
 * `ranked` / `absent` / `untested` — **delegated**, not re-derived.
 *
 * `classifyOurSide` is the one implementation of "did we measure this word and find
 * nothing". Calling it here is what keeps this tab and the competitor tab from
 * describing the same keyword two different ways; the falsification test for this
 * tab changes that function and watches both tabs go red.
 */
export function classifyKeywordState(row) {
  return classifyOurSide({
    rank: row?.rank ?? null,
    scanDepth: row?.scanDepth ?? row?.scan_depth ?? null,
  })
}

const blankToNull = value => {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

const parseJson = (text, fallback) => {
  if (text === null || text === undefined) return fallback
  try {
    const parsed = JSON.parse(String(text))
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/**
 * One ASIN's keyword readings.
 *
 * `master` is the `keyword` library row for the same word, read in one pass and
 * keyed, rather than a correlated sub-select per row: the library holds the
 * volume/difficulty the ASIN row does not, and a word measured by us but never
 * imported into the library legitimately has no master row — `null`, not a zero.
 */
export function buildAsinKeywordView(store, { asin, marketplace, limit } = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  if (key === '') return { ok: false, code: 'BAD_REQUEST', error: 'asin is required' }
  if (market === '') return { ok: false, code: 'BAD_REQUEST', error: 'marketplace is required' }

  const bound = clampLimit(limit, ASIN_KEYWORD_ROW_LIMIT, ASIN_KEYWORD_ROW_LIMIT_MAX)

  /* Ordered by rank with NULLs last: the words we are actually visible for are the
     ones a reader came for, and `ORDER BY rank` alone puts every unranked word
     first on SQLite. The tie-breakers make the order total, so a page that shows
     "the first N" shows the same N twice in a row. */
  const raw = store.all(
    `SELECT keyword, source_id, rank, page, scan_depth, tier, tier_basis_json,
            search_volume, collected_at
       FROM asin_keyword
      WHERE asin = ? AND marketplace = ?
      ORDER BY (rank IS NULL), rank, keyword, source_id
      LIMIT ?`,
    [key, market, bound + 1],
  )
  const truncated = raw.length > bound
  const page = truncated ? raw.slice(0, bound) : raw

  /* 「总库」原来的来源是 `keyword` 表（扫描层，16 行），而真正的总库是 `kw_master`
     （30,778 行）。两件事被一个变量名混在一起，后果是**搜索量永远显示为空** ——
     asin_keyword 自己没有 search_volume，而这里只去 keyword 找，keyword 又没有这一列。
     实测：8 个词在 kw_master 里分别有 73,233 / 18,665 / 12,594 … 的搜索量，
     页面上一律显示「—（没有值）」。运营看到的就是"这个词没有搜索量"。

     现在分两次查：扫描层给 tier（T1–T4），总库给搜索量/难度/优先级。 */
  const wordList = page.map(row => row.keyword)
  const placeholders = wordList.map(() => '?').join(',')
  const scanRows = wordList.length === 0 ? [] : store.all(
    `SELECT keyword, tier FROM keyword WHERE marketplace = ? AND keyword IN (${placeholders})`,
    [market, ...wordList],
  )
  const scanTiers = new Map(scanRows.map(row => [row.keyword, row.tier]))
  const masterRows = wordList.length === 0 ? [] : store.all(
    `SELECT keyword, sv_tier, priority, search_volume, listed_difficulty, first_seen_at, updated_at
       FROM kw_master WHERE marketplace = ? AND keyword IN (${placeholders})`,
    [market, ...wordList],
  )
  const masters = new Map(masterRows.map(row => [row.keyword, row]))

  const rows = page.map(row => {
    const state = classifyKeywordState(row)
    const master = masters.get(row.keyword) ?? null
    return {
      keyword: row.keyword,
      sourceId: row.source_id,
      rank: row.rank ?? null,
      page: row.page ?? null,
      scanDepth: row.scan_depth ?? null,
      tier: row.tier ?? null,
      tierBasis: parseJson(row.tier_basis_json, null),
      searchVolume: row.search_volume ?? master?.search_volume ?? null,
      collectedAt: row.collected_at ?? null,
      state,
      stateLabel: ASIN_KEYWORD_STATE_LABELS[state],
      master: master === null ? null : {
        /* 扫描层给 tier（T1–T4），总库给其余。两边的 tier 不是一回事，别混。 */
        tier: scanTiers.get(row.keyword) ?? master.sv_tier ?? null,
        svTier: master.sv_tier ?? null,
        priority: master.priority ?? null,
        searchVolume: master.search_volume ?? null,
        difficulty: master.listed_difficulty ?? null,
        firstSeenAt: master.first_seen_at ?? null,
        updatedAt: master.updated_at ?? null,
      },
    }
  })

  /* The counts are a recount of `rows`, never accumulators. Three states that sum
     to the row count is the invariant the tests pin; an accumulator that drifts
     from the list it describes is the defect this shape exists to make impossible. */
  const counts = {
    rows: rows.length,
    ranked: rows.filter(row => row.state === 'ranked').length,
    absent: rows.filter(row => row.state === 'absent').length,
    untested: rows.filter(row => row.state === 'untested').length,
    sources: new Set(rows.map(row => row.sourceId)).size,
    keywords: new Set(rows.map(row => row.keyword)).size,
    withMaster: rows.filter(row => row.master !== null).length,
  }

  const totalRows = Number(store.get(
    'SELECT COUNT(*) AS n FROM asin_keyword WHERE asin = ? AND marketplace = ?', [key, market],
  )?.n ?? 0)

  const notes = []
  if (truncated) {
    notes.push(`库里这条 ASIN 有 ${totalRows} 行读数，这次只读回 ${bound} 行 —— `
      + '「没读回来」与「库里没有」不是一件事：补全请调大 limit（上限 '
      + `${ASIN_KEYWORD_ROW_LIMIT_MAX}）。`)
  }
  /* 「测过，没找到」只代表**没进这一次扫描的深度**。深度 48（一页）时，
     第 49 名和第 500 名在页面上长得一模一样 —— 运营会把它读成「这个词没排名」。
     把深度单独交出去，页面据此说清这句话。 */
  const depths = rows.map(row => row.scanDepth).filter(value => Number.isFinite(Number(value)) && Number(value) > 0)
  const scanDepthMax = depths.length === 0 ? null : Math.max(...depths)
  if (counts.absent > 0 && scanDepthMax !== null) {
    notes.push(`${counts.absent} 个词「测过，没找到」—— 那是**没进前 ${scanDepthMax} 名**，`
      + '不代表这个词没有排名。深度是可调的（amzn_keyword_scan 的 pages）。')
  }
  if (counts.withMaster < counts.rows) {
    notes.push(`${counts.rows - counts.withMaster} 行读数在关键词总库里没有对应的词 —— `
      + '那是「总库里没有这个词」，不是「这个词没有搜索量」。')
  }

  return {
    ok: true,
    asin: key,
    marketplace: market,
    source: 'asin_keyword + keyword',
    unit: 'row per (keyword, source_id)',
    rows,
    counts,
    totals: { rows: totalRows, read: rows.length, limit: bound, truncated },
    states: [...ASIN_KEYWORD_STATES],
    stateLabels: { ...ASIN_KEYWORD_STATE_LABELS },
    unsourced: [unsourced({
      id: 'keyword-rank-history',
      label: '关键词排名的历史变化',
      feature: 'F05-02',
      reason: ASIN_KEYWORD_RANK_HISTORY_REASON,
    })],
    noSourceText: ASIN_NO_SOURCE_TEXT,
    notes,
  }
}
