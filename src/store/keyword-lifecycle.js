/**
 * Persistence for the keyword lifecycle (schema v33, module 08 F08-07).
 *
 * Two tables and no more:
 *
 *   keyword_lifecycle        the **current** state, one row per (keyword, marketplace).
 *   keyword_lifecycle_event  the history — appended, never updated, never deleted.
 *
 * ## Why this is not a column on `kw_master`
 *
 * `recomputeMaster` (store/kw.js) rebuilds `kw_master` wholesale: it deletes the
 * rows this pass covers and re-inserts them from the facts. That table is a pure
 * function of `kw_aba_fact` / `kw_ad_fact` / `kw_competitor_fact`, and the only
 * column exempted from that rule is `first_seen_at` — history, kept because it is
 * not derivable. A lifecycle state is a **human decision**, so it is the same kind
 * of thing: if it lived on `kw_master` it would be silently erased on the next
 * import-triggered recompute, and nothing would throw. It is a separate table for
 * exactly that reason, and `tests/b08-lifecycle.mjs` proves it by running a real
 * recompute between the write and the read.
 *
 * ## What "no record" means
 *
 * `getKeywordLifecycle` returns `null` when nobody has decided anything about a
 * word — it does **not** default to `candidate`. "Nobody ever decided" and
 * "somebody decided it is a candidate" are different facts, and the page has to
 * be able to tell them apart (it prints 未设置 for the first). Defaulting here
 * would erase the distinction for every caller at once.
 *
 * ## The one automatic trigger this batch can honestly support
 *
 * §22.2 wants `assigned → used` set automatically by a publication record, and
 * §915 wants `observing → retained / paused / assigned` driven by an observation
 * conclusion. **Neither association exists in the database today**: there is no
 * "which keywords did this publication use" column anywhere (`optimization_run`
 * has no position plan, `publication_record.approved_json` is the target listing
 * text, not structured word slots), and no "which keywords does this observation
 * cover" either. So `applyKeywordLifecycleBatch` implements the mechanism as an
 * **explicitly declared association**: the caller must name the publication and
 * the exact words, and the system records that declaration. That is real and
 * auditable; matching words out of listing prose would be a guess dressed up as
 * a fact. The true prerequisite is F08-05 (the position-plan persistence layer),
 * which is out of scope here.
 *
 * ## Batch by a human (`setKeywordLifecycleBatch`)
 *
 * The walkthrough of 2026-10-25 found the library at `已设置 0 / 未设置 30,778`
 * while the page said "click **one** word in the table below". Single-word clicks
 * are not a workflow, so this batch entry exists. Three rules carry it, and each
 * lives here rather than at the tool or the route so the page and the
 * conversation cannot disagree:
 *
 *   - **One state machine.** `setKeywordLifecycle` and the batch both ask
 *     `refusalFor`, the only place that consults `canTransitionKeyword`. A second
 *     copy of the edge table would drift on the first untested edge — this file
 *     has no copy, and `tests/t77-keyword-bulk.mjs` proves both paths agree on all
 *     81 (from, to) pairs.
 *   - **All-or-nothing.** Every word is validated before anything is written; one
 *     offender refuses the **whole** batch and lists them. "Skip the bad ones,
 *     write the good ones" is the failure mode this refuses: the caller would be
 *     told 300 words changed and have no way to know 12 did not.
 *   - **A same-state word is not a success.** It is not a transition. With an
 *     explicit word list that refuses the batch; with a **filter** selection the
 *     words already at the target are excluded from the selection by
 *     construction and reported as `alreadyAtTarget`, because the operator's
 *     decision there is "every word this filter matches should end at X" — a
 *     word already at X already satisfies it. The exclusion is part of the
 *     recorded selection, never a silent skip.
 *
 * ## Why a filter selection exists at all
 *
 * 30,778 words at 100 rows per page is 300+ rounds of ticking boxes. So the
 * caller may name a **filter** instead of words; it is resolved here against
 * `queryMaster`'s own filter implementation (one place defines what a filter
 * means), hard-capped at {@link KEYWORD_LIFECYCLE_BATCH_MAX}, and the resolved
 * selection is written into every event row — otherwise nobody can answer "why
 * were these 500 words changed" three months later.
 */

import { randomUUID } from 'node:crypto'

import { keywordKey } from '../domain/keywords/key.js'
import { KEYWORD_LIFECYCLE_LABELS, KEYWORD_LIFECYCLE_SOURCES, KEYWORD_LIFECYCLE_STATES, canTransitionKeyword } from '../domain/states.js'
import { nowIso } from './db.js'
import { queryMaster } from './kw.js'

/**
 * How many words one batch may move.
 *
 * A cap is not a performance guard (500 rows in one transaction is nothing) — it
 * is a reviewability guard: a single call that changes 30,778 rows cannot be
 * read back by anyone. 500 also keeps the selection's `IN (?, …)` well under
 * SQLite's bind-variable limit and makes `remaining` a number an operator can
 * act on.
 */
export const KEYWORD_LIFECYCLE_BATCH_MAX = 500

/**
 * The filter keys a batch selection may use — `queryMaster`'s own vocabulary,
 * spelled the way it spells them.
 *
 * Closed on purpose. An unknown key would be ignored by `queryMaster`, i.e. the
 * selection would be **wider** than the caller thinks, and the dangerous
 * direction here is selecting 30,778 words when 12 were meant. A typo is
 * refused by name instead.
 */
const KEYWORD_LIFECYCLE_FILTER_KEYS = [
  'q', 'productLine', 'svTier', 'priority', 'opportunity', 'ownStatus',
  'minVolume', 'maxVolume', 'hasAba', 'hasAd', 'hasCompetitor', 'lifecycleStatus',
]

/** The stored spelling of a keyword — folded, the same ruler `kw_master` uses. */
function keywordOf(value) {
  const keyword = keywordKey(value)
  if (keyword === '') throw new Error('keyword is required')
  return keyword
}

/** The stored spelling of a marketplace. Upper case, same as everywhere else. */
function marketplaceOf(value) {
  const marketplace = String(value ?? '').trim().toUpperCase()
  if (marketplace === '') throw new Error('marketplace is required')
  return marketplace
}

/** A state must be one of the nine; a typo is refused rather than silently empty. */
function stateOf(value, what) {
  const status = String(value ?? '').trim()
  if (!KEYWORD_LIFECYCLE_STATES.includes(status)) {
    throw new Error(`${what} "${value}" is not one of the nine lifecycle states (${KEYWORD_LIFECYCLE_STATES.join(' / ')})`)
  }
  return status
}

/** A source must be one of the declared three. Same reasoning as `stateOf`. */
function sourceOf(value) {
  const source = String(value ?? 'manual').trim() || 'manual'
  if (!KEYWORD_LIFECYCLE_SOURCES.includes(source)) {
    throw new Error(`source "${value}" is not one of ${KEYWORD_LIFECYCLE_SOURCES.join(' / ')}`)
  }
  return source
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function hydrateLifecycle(row) {
  if (row === null || row === undefined) return null
  return { ...row, evidence: parseJson(row.evidence_json, null) }
}

function hydrateEvent(row) {
  return { ...row, evidence: parseJson(row.evidence_json, null) }
}

/** The current state for one word, or `null` when nobody has decided. */
export function getKeywordLifecycle(store, { keyword, marketplace } = {}) {
  const row = store.get(
    'SELECT * FROM keyword_lifecycle WHERE keyword = ? AND marketplace = ?',
    [keywordOf(keyword), marketplaceOf(marketplace)],
  )
  return row === undefined ? null : hydrateLifecycle(row)
}

/**
 * Current states, newest change first.
 *
 * `status` is validated rather than passed through: an unknown status would
 * return an empty list, and an empty list is indistinguishable from "no word is
 * in that state" — the silent empty this project refuses.
 */
export function listKeywordLifecycle(store, { marketplace = null, status = null, limit = 200 } = {}) {
  const where = []
  const params = []
  if (marketplace !== null && marketplace !== undefined && String(marketplace).trim() !== '') {
    where.push('marketplace = ?')
    params.push(marketplaceOf(marketplace))
  }
  if (status !== null && status !== undefined && String(status).trim() !== '') {
    where.push('status = ?')
    params.push(stateOf(status, 'status'))
  }
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000)
  return store
    .all(
      `SELECT * FROM keyword_lifecycle
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY changed_at DESC, keyword ASC LIMIT ?`,
      [...params, cap],
    )
    .map(hydrateLifecycle)
}

/**
 * The full history for one word, oldest first — the order a timeline is read in.
 *
 * `from_status` is `null` on the first row: there was no prior state. It is not
 * an initial state invented to fill the column.
 */
export function keywordLifecycleHistory(store, { keyword, marketplace } = {}) {
  return store
    .all(
      `SELECT * FROM keyword_lifecycle_event
        WHERE keyword = ? AND marketplace = ?
        ORDER BY at ASC, rowid ASC`,
      [keywordOf(keyword), marketplaceOf(marketplace)],
    )
    .map(hydrateEvent)
}

/**
 * Counts per state, for the page and the tools.
 *
 * Every one of the nine is present, zero included, in the vocabulary's own
 * order — a chip row that omits the empty states makes "0 excluded" and "this
 * state does not exist" look the same. `unset` counts the master rows that have
 * **no** lifecycle record at all, so the page can show 未设置 as a real number
 * instead of letting it hide inside `candidate`.
 */
export function keywordLifecycleCounts(store, { marketplace = null } = {}) {
  const market = marketplace === null || marketplace === undefined || String(marketplace).trim() === ''
    ? null
    : marketplaceOf(marketplace)
  const params = market === null ? [] : [market]

  const counts = new Map(
    store
      .all(
        `SELECT status, COUNT(*) AS n FROM keyword_lifecycle
          ${market === null ? '' : 'WHERE marketplace = ?'}
          GROUP BY status`,
        params,
      )
      .map(row => [row.status, Number(row.n ?? 0)]),
  )
  /* label 必须一起给：页面渲染的是 entry.status + ' ' + entry.label，少一个字段
    就在九个 chip 上印出「candidate undefined」—— 数据是对的，字是错的。 */
  const byStatus = KEYWORD_LIFECYCLE_STATES.map(status => ({
    status,
    label: KEYWORD_LIFECYCLE_LABELS[status] ?? status,
    n: counts.get(status) ?? 0,
  }))
  const total = byStatus.reduce((sum, entry) => sum + entry.n, 0)

  const unset = Number(store.get(
    `SELECT COUNT(*) AS n FROM kw_master m
      WHERE NOT EXISTS (
        SELECT 1 FROM keyword_lifecycle l
         WHERE l.keyword = m.keyword AND l.marketplace = m.marketplace)
        ${market === null ? '' : 'AND m.marketplace = ?'}`,
    params,
  )?.n ?? 0)

  return { marketplace: market, total, unset, byStatus }
}

/**
 * Why a word at `currentStatus` may not go to `target` — or `null` when it may.
 *
 * **This is the one place the lifecycle edge question is answered.** All three
 * write paths ask it: the single word path throws `message`, the human batch
 * collects, and the publication batch treats `same-state` as `unchanged`. So
 * `canTransitionKeyword` is consulted from exactly one call site, and no path can
 * grow its own copy of the table `tests/t77-keyword-bulk.mjs` would then have to
 * keep in sync.
 *
 * `kind` is returned alongside the sentence because the three callers need to
 * tell the two refusals apart — "already there" is an error for an explicit word
 * list but a legitimate `unchanged` for a publication association — and doing
 * that by matching the prose would break the moment the wording changed.
 *
 * `currentStatus === null` means "no record yet" — a creation, not a transition,
 * so it is allowed to land on any of the nine. A transition to the same state is
 * refused: it is a no-op, and writing it would make an event row claim a change
 * that did not happen.
 *
 * @returns {{ kind: 'same-state'|'illegal', message: string }|null}
 */
function refusalFor(keyword, currentStatus, target) {
  if (currentStatus === null) return null
  if (currentStatus === target) {
    return {
      kind: 'same-state',
      message: `${keyword} is already ${target} — this is not a transition, it is a no-op, `
        + 'and no state changed so no history is written',
    }
  }
  if (!canTransitionKeyword(currentStatus, target)) {
    return {
      kind: 'illegal',
      message: `${keyword} cannot go ${currentStatus} → ${target}: that edge is not in the lifecycle `
        + 'state machine (see KEYWORD_LIFECYCLE_TRANSITIONS in src/domain/states.js)',
    }
  }
  return null
}

/**
 * Move one word to a new state, appending the history row.
 *
 * Rules, all of them here rather than at the tools so the tool and the page
 * route cannot disagree:
 *
 *   - `to` must be one of the nine.
 *   - **No record yet → a creation.** There is no prior state, so there is no
 *     edge to check; the first decision may land on any state. (Requiring
 *     `candidate` first would fabricate a candidate step nobody took.)
 *   - **Already in `to` → refused.** A transition to the same state is not a
 *     transition; letting it through would write an event row that says the
 *     status changed when it did not, and would make "the status changed"
 *     untestable.
 *   - Otherwise the edge must be in `KEYWORD_LIFECYCLE_TRANSITIONS`.
 *
 * The last two are `refusalFor`'s, shared with the batch — read it there.
 *
 * There is **no delete**. Not "no tool calls it" — there is no statement here
 * that removes a lifecycle row or an event, and both `excluded` and `archived`
 * can return to `active`, so a word is never destroyed by a state change.
 *
 * @returns {{ keyword: string, marketplace: string, from: string|null, to: string,
 *             status: string, eventId: string, at: string }}
 */
export function setKeywordLifecycle(store, { keyword, marketplace, to, reason = null, source = 'manual', evidence = null, publicationId = null, by = null } = {}) {
  const key = keywordOf(keyword)
  const market = marketplaceOf(marketplace)
  const target = stateOf(to, 'to')
  const from = sourceOf(source)
  const current = getKeywordLifecycle(store, { keyword: key, marketplace: market })

  const refusal = refusalFor(key, current === null ? null : current.status, target)
  if (refusal !== null) throw new Error(refusal.message)

  return store.tx(() => writeTransition(store, {
    keyword: key,
    marketplace: market,
    from: current === null ? null : current.status,
    to: target,
    reason,
    source: from,
    evidence,
    publicationId,
    by,
  }))
}

/** The two writes of one transition, without its own transaction. */
function writeTransition(store, { keyword, marketplace, from, to, reason, source, evidence, publicationId, by }) {
  const at = nowIso()
  const eventId = randomUUID()
  store.run(
    `INSERT INTO keyword_lifecycle
       (keyword, marketplace, status, reason, source, evidence_json, changed_at, changed_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(keyword, marketplace) DO UPDATE SET
       status = excluded.status,
       reason = excluded.reason,
       source = excluded.source,
       evidence_json = excluded.evidence_json,
       changed_at = excluded.changed_at,
       changed_by = excluded.changed_by`,
    [keyword, marketplace, to, reason ?? null, source, json(evidence), at, by ?? null, at],
  )
  store.run(
    `INSERT INTO keyword_lifecycle_event
       (id, keyword, marketplace, from_status, to_status, reason, source, evidence_json, publication_id, at, by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [eventId, keyword, marketplace, from, to, reason ?? null, source, json(evidence), publicationId ?? null, at, by ?? null],
  )
  return { keyword, marketplace, from, to, status: to, eventId, at }
}

/**
 * The **explicitly declared** publication association.
 *
 * §22.2's `assigned → used` is set by "the publication used these words". The
 * database cannot answer which words a publication used — there is no such link
 * (see the module header). So this entry makes the caller state it: a
 * `publicationId` and the exact `keywords`. What is recorded is that
 * declaration, with `source: 'publication'` and the id on every event row.
 *
 * Fail-closed, in three places, because each failure mode looks like success:
 *
 *   1. The publication must exist. A bad id is refused, not skipped — otherwise
 *      the events would point at nothing and read as a real association.
 *   2. Every word must be in the master library for that marketplace. A word
 *      that is not is refused **and listed**; skipping it would let a typo look
 *      like a word that was already fine.
 *   3. Every transition must be legal. The whole batch is refused and the
 *      offenders are listed, so the declaration is all-or-nothing rather than
 *      half-applied.
 *
 * A word already at the target is reported in `unchanged` — it is not an error
 * (the publication really did use it) and it writes no event (no state changed).
 *
 * @returns {{ publicationId: string, to: string, marketplace: string,
 *             applied: Array<{keyword: string, from: string|null}>,
 *             unchanged: string[], eventIds: string[] }}
 */
export function applyKeywordLifecycleBatch(store, { publicationId, keywords, to, marketplace, reason = null, by = null } = {}) {
  const market = marketplaceOf(marketplace)
  const target = stateOf(to, 'to')
  const id = String(publicationId ?? '').trim()
  if (id === '') throw new Error('publicationId is required — this association must name the publication it came from')

  const publication = store.get('SELECT id FROM publication_record WHERE id = ?', [id])
  if (publication === undefined) {
    throw new Error(`no publication record ${id} — refusing to record an association to a publication that does not exist`)
  }

  const list = Array.isArray(keywords) ? keywords : []
  const wanted = [...new Set(list.map(entry => keywordKey(entry)).filter(entry => entry !== ''))]
  if (wanted.length === 0) throw new Error('keywords must be a non-empty list')

  const missing = wanted.filter((keyword) => {
    const row = store.get(
      'SELECT 1 AS ok FROM kw_master WHERE keyword = ? AND marketplace = ?',
      [keyword, market],
    )
    return row === undefined
  })
  if (missing.length > 0) {
    throw new Error(`these keywords are not in the ${market} master library, so they cannot be declared used: ${missing.join(', ')}`)
  }

  const current = new Map(
    store
      .all(
        `SELECT keyword, status FROM keyword_lifecycle
          WHERE marketplace = ? AND keyword IN (${wanted.map(() => '?').join(',')})`,
        [market, ...wanted],
      )
      .map(row => [row.keyword, row.status]),
  )

  const illegal = []
  for (const keyword of wanted) {
    const status = current.get(keyword) ?? null
    /* 同一判定点（`refusalFor`）。这里「已经在目标态」不是错误 —— 发布确实用了这个词，
       它进 `unchanged` 且不写事件（没有状态变化）；非法边则拒整批并列出。 */
    const refusal = refusalFor(keyword, status, target)
    if (refusal === null || refusal.kind === 'same-state') continue
    illegal.push(refusal.message)
  }
  if (illegal.length > 0) {
    throw new Error(`these transitions are not legal, so nothing was written: ${illegal.join(', ')}`)
  }

  return store.tx(() => {
    const applied = []
    const unchanged = []
    const eventIds = []
    for (const keyword of wanted) {
      const from = current.get(keyword) ?? null
      if (from === target) {
        unchanged.push(keyword)
        continue
      }
      const written = writeTransition(store, {
        keyword,
        marketplace: market,
        from,
        to: target,
        reason,
        source: 'publication',
        evidence: { publicationId: id },
        publicationId: id,
        by,
      })
      applied.push({ keyword, from })
      eventIds.push(written.eventId)
    }
    return { publicationId: id, to: target, marketplace: market, applied, unchanged, eventIds }
  })
}

/* ─────────────────── 批量：人的决定（F-5，走查 2026-10-25） ─────────────────── */

/** A required text argument; blank is refused by name rather than accepted as "none". */
function requiredText(value, what, why) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error(`${what} is required — ${why}`)
  return text
}

/**
 * 把一份词表规范化成可写的词：非空、≤上限、每一项都能折叠成词、去重。
 *
 * **两个批量入口共用这一份**（生命周期、产品线归属）。上限、去重、以及「坏项要拒收并
 * 点名，不许静默丢掉」这三条是批量语义，不是某一张表的语义 —— 分成两份之后，第一个
 * 分叉一定出现在最不该分叉的地方。
 *
 * @returns {string[]}
 */
export function normalizeBatchKeywords(keywords, max = KEYWORD_LIFECYCLE_BATCH_MAX) {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    throw new Error('keywords must be a non-empty array of words')
  }
  if (keywords.length > max) {
    throw new Error(
      `at most ${max} keywords per batch (got ${keywords.length}) — `
      + 'split the list, or select by filter so the server pages through it',
    )
  }
  const bad = []
  const folded = []
  for (const entry of keywords) {
    const word = typeof entry === 'string' ? keywordKey(entry) : ''
    if (word === '') {
      bad.push(typeof entry === 'string' ? JSON.stringify(entry) : `${typeof entry} ${JSON.stringify(entry)}`)
      continue
    }
    folded.push(word)
  }
  if (bad.length > 0) {
    throw new Error(
      'these entries are not words (empty or non-string), so nothing was written: '
      + bad.join(', ') + ' — a bad entry is refused, never skipped',
    )
  }
  return [...new Set(folded)]
}

/**
 * 把「按筛选选」的参数**规范化**成一个只含已知键的对象。
 *
 * 两个批量入口共用（生命周期、产品线归属）：筛选的词表是 `queryMaster` 的词汇表，
 * 未知键必须拒收 —— 一个被忽略的键会让选区**变宽**，而这里危险的方向正是「选了 12 个
 * 却动了 3 万个」。
 *
 * @returns {object} 只含已知键、已去掉空串/null 的对象（可能为空 = 不筛）
 */
export function normalizeBatchFilter(filter) {
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error('filter must be an object of selection keys: ' + KEYWORD_LIFECYCLE_FILTER_KEYS.join(' / '))
  }
  const unknown = Object.keys(filter).filter(key => !KEYWORD_LIFECYCLE_FILTER_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `filter has unknown key(s): ${unknown.join(', ')} — allowed: ${KEYWORD_LIFECYCLE_FILTER_KEYS.join(' / ')}. `
      + 'An unknown key is refused because it would be ignored and silently widen the selection',
    )
  }
  const clean = {}
  for (const key of KEYWORD_LIFECYCLE_FILTER_KEYS) {
    const raw = filter[key]
    if (raw === undefined || raw === null) continue
    if (typeof raw === 'string' && raw.trim() === '') continue
    clean[key] = raw
  }
  if (clean.lifecycleStatus !== undefined) {
    clean.lifecycleStatus = stateOf(clean.lifecycleStatus, 'filter.lifecycleStatus')
  }
  return clean
}

/**
 * 一次批量改动的**选区**，写进每一条事件的 `evidence_json.batchSelection`。
 *
 * 「这 500 个词为什么被改」三个月后只能靠这一行回答，所以它不是可选字段；调用方传的
 * evidence 覆盖不掉它（`batchSelection` 放在最后）。两个批量工具共用这一个形状 ——
 * 一边有、一边忘了，事后就有一半的改动无法解释。
 */
export function batchSelectionEvidence(selection, { to, marketplace }, evidence = null) {
  return {
    ...(evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {}),
    batchSelection: {
      kind: selection.kind,
      filter: selection.filter,
      matched: selection.matched,
      alreadyAtTarget: selection.alreadyAtTarget,
      selected: selection.words.length,
      to: to ?? null,
      marketplace,
    },
  }
}

/**
 * Which words the caller selected — the one vocabulary question of this batch.
 *
 * Returns `{ kind, filter, words, matched, alreadyAtTarget }`, where `words` are
 * exactly the words that still need the transition:
 *
 *   - **keywords**: the caller named them. Already-at-target is a refusal (see
 *     `refusalFor`), not a skip, and a non-string or blank entry is refused
 *     **and named** — silently dropping it is how "300 words changed" becomes a
 *     lie.
 *   - **filter**: resolved against `queryMaster`'s own filters, so what the page
 *     means by a filter and what the batch means by it are one implementation.
 *     Words already at the target are excluded here and counted in
 *     `alreadyAtTarget`, which the caller must report.
 */
function resolveKeywordSelection(store, { keywords, filter, marketplace, target }) {
  const hasKeywords = keywords !== null && keywords !== undefined
  const hasFilter = filter !== null && filter !== undefined
  if (hasKeywords === hasFilter) {
    throw new Error(
      'name exactly one selection: `keywords` (the words you ticked) or `filter` '
      + '(the current filter, resolved on the server) — both at once leaves it ambiguous '
      + 'which one was the decision',
    )
  }

  if (hasKeywords) {
    /* 上限 / 坏项 / 去重由 `normalizeBatchKeywords` 一处定义（产品线批量共用同一份）。 */
    const words = normalizeBatchKeywords(keywords, KEYWORD_LIFECYCLE_BATCH_MAX)
    return { kind: 'keywords', filter: null, words, matched: words.length, alreadyAtTarget: 0 }
  }

  /* ── filter ── */
  const clean = normalizeBatchFilter(filter)

  const matched = Number(queryMaster(store, { ...clean, marketplace, limit: 1, offset: 0 }).total)
  const alreadyAtTarget = clean.lifecycleStatus === undefined
    ? Number(queryMaster(store, { ...clean, marketplace, lifecycleStatus: target, limit: 1, offset: 0 }).total)
    : (clean.lifecycleStatus === target ? matched : 0)

  const words = []
  const pageSize = 1000
  let offset = 0
  while (words.length < KEYWORD_LIFECYCLE_BATCH_MAX) {
    const page = queryMaster(store, { ...clean, marketplace, order: 'keyword', limit: pageSize, offset })
    if (page.rows.length === 0) break
    for (const row of page.rows) {
      if (row.lifecycle_status === target) continue
      words.push(row.keyword)
      if (words.length === KEYWORD_LIFECYCLE_BATCH_MAX) break
    }
    offset += page.rows.length
    if (offset >= page.total) break
  }

  if (matched === 0) {
    throw new Error(
      'nothing to change: this filter matches no word — the filter was '
      + JSON.stringify(clean) + ' (recorded here so a wrong filter is visible, not silent)',
    )
  }
  if (words.length === 0) {
    throw new Error(
      `nothing to change: all ${matched} word(s) this filter matches are already ${target} — `
      + 'no state changed, so no history is written',
    )
  }
  return { kind: 'filter', filter: clean, words, matched, alreadyAtTarget }
}

/**
 * Move up to {@link KEYWORD_LIFECYCLE_BATCH_MAX} words to one state — as **one
 * human decision**, all-or-nothing.
 *
 * Six things are refused rather than smoothed over, because each one has a
 * shape that looks like success:
 *
 *   1. **No `by` / no `reason`.** Up to 500 rows in one call is not reviewable
 *      without both; "who decided this and why" is the whole audit trail.
 *   2. **Both or neither of `keywords` / `filter`.** Two selections at once
 *      leaves it ambiguous which one was the decision.
 *   3. **A bad entry** (non-string, blank) — refused and named, never skipped.
 *   4. **More than the cap** — refused with the count and the cap.
 *   5. **A word not in the master library** — refused and listed.
 *   6. **Any illegal edge, or a word already at the target** — the whole batch is
 *      refused and every offender listed (`refusalFor` supplies the wording, so
 *      this file has no second copy of the state machine).
 *
 * `dryRun: true` runs every check and returns the plan — `wouldApply` names each
 * word with its `from` — and writes nothing. The preview and the write are the
 * same function, so the numbers an operator saw cannot differ from the write.
 *
 * @returns {{ to: string, marketplace: string, dryRun: boolean,
 *             selection: { kind: 'keywords'|'filter', filter: object|null,
 *                          matched: number, alreadyAtTarget: number, selected: number },
 *             applied: Array<{keyword: string, from: string|null}>,
 *             wouldApply: Array<{keyword: string, from: string|null}>,
 *             eventIds: string[],
 *             remaining: number, libraryUnset: number }}
 */
export function setKeywordLifecycleBatch(store, {
  keywords = null,
  filter = null,
  marketplace,
  to,
  reason = null,
  by = null,
  evidence = null,
  dryRun = false,
} = {}) {
  const market = marketplaceOf(marketplace)
  const target = stateOf(to, 'to')
  /* 一条批量最多动 500 行 —— 没有 by 与 reason 的 500 行改动，事后没有人能复核。
     单条那条路径仍然允许不填（既有契约），这里更严是**故意的**：批量不是单条的重载，
     是一次覆盖面大得多的决定。 */
  const decisionBy = requiredText(by, 'by', 'a batch lifecycle change is a human decision, and an unattributed one is not one')
  const decisionReason = requiredText(reason, 'reason', 'a batch lifecycle change has to say why, or it cannot be reviewed later')

  const selection = resolveKeywordSelection(store, { keywords, filter, marketplace: market, target })
  const words = selection.words

  if (selection.kind === 'keywords') {
    const present = new Set(store.all(
      `SELECT keyword FROM kw_master WHERE marketplace = ? AND keyword IN (${words.map(() => '?').join(', ')})`,
      [market, ...words],
    ).map(row => row.keyword))
    const missing = words.filter(word => !present.has(word))
    if (missing.length > 0) {
      throw new Error(
        `these keywords are not in the ${market} master library, so nothing was written: ${missing.join(', ')}`,
      )
    }
  }

  const current = new Map(store.all(
    `SELECT keyword, status FROM keyword_lifecycle
      WHERE marketplace = ? AND keyword IN (${words.map(() => '?').join(', ')})`,
    [market, ...words],
  ).map(row => [row.keyword, row.status]))

  const already = []
  const illegal = []
  for (const word of words) {
    const refusal = refusalFor(word, current.get(word) ?? null, target)
    if (refusal === null) continue
    /* 同态与非法边分开列：前者的修法是「这些词已经是了」，后者的修法是「这条边不存在」，
       混成一条会让人不知道下一步该改什么。 */
    if (refusal.kind === 'same-state') already.push(word)
    else illegal.push(refusal.message)
  }
  if (already.length > 0) {
    throw new Error(
      `these keywords are already ${target}, so there is no transition to make and nothing was written: ${already.join(', ')}`,
    )
  }
  if (illegal.length > 0) {
    throw new Error(`these transitions are not legal, so nothing was written: ${illegal.join('; ')}`)
  }

  /* 选区原样进事件行：**哪个筛选、命中多少、选中多少**。形状由
     `batchSelectionEvidence` 一处定义 —— 产品线批量共用同一份，免得一边有、一边忘了。 */
  const evidenceRow = batchSelectionEvidence(
    { ...selection, selected: words.length },
    { to: target, marketplace: market },
    evidence,
  )

  const plan = words.map(word => ({ keyword: word, from: current.get(word) ?? null }))
  const remaining = selection.kind === 'filter'
    ? Math.max(0, selection.matched - selection.alreadyAtTarget - words.length)
    : 0

  if (dryRun === true) {
    return {
      to: target,
      marketplace: market,
      dryRun: true,
      selection: { ...selection, filter: selection.filter, selected: words.length },
      applied: [],
      wouldApply: plan,
      eventIds: [],
      remaining,
      libraryUnset: keywordLifecycleCounts(store, { marketplace: market }).unset,
    }
  }

  const eventIds = store.tx(() => {
    const ids = []
    for (const entry of plan) {
      ids.push(writeTransition(store, {
        keyword: entry.keyword,
        marketplace: market,
        from: entry.from,
        to: target,
        reason: decisionReason,
        /* 人的决定，恒为 manual。这个入口**不接受** publication / observation：
           那两条是另外的写路径（`applyKeywordLifecycleBatch`、将来的观测结论），
           从这里传进来的话，一条人的批量就能冒充机器判定。 */
        source: 'manual',
        evidence: evidenceRow,
        publicationId: null,
        by: decisionBy,
      }).eventId)
    }
    return ids
  })

  return {
    to: target,
    marketplace: market,
    dryRun: false,
    selection: { ...selection, selected: words.length },
    applied: plan,
    wouldApply: [],
    eventIds,
    remaining,
    libraryUnset: keywordLifecycleCounts(store, { marketplace: market }).unset,
  }
}
