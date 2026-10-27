/**
 * Persistence for the position plan (schema v35, module 08 F08-05).
 *
 * ## What this object is, and what it is not
 *
 * A `keyword_plan` is a **decision**: which position each keyword is assigned to.
 * Three things in this repo look like it and are not:
 *
 *   - `kw_master.for_listing_json` — **eligibility**: which positions a keyword is
 *     *allowed* to occupy (title sv≥10000 & tier≤3, bullets sv≥1000 & tier≤4,
 *     adsExact sv≥5000 & tier≤3, adsPhrase sv≥2000 & tier≤4, adsBroad sv≥500 &
 *     cvr≥3%, backend always true). Eligibility ≠ assignment. Eligibility says
 *     "may"; the plan says "here". The audit report (§4.5) names the counting
 *     mistake of treating two related numbers as the same number; conflating
 *     these two is exactly that mistake in a different costume.
 *   - `keyword_ownership` (v34) — which **ASIN** claims the word. Nothing to do
 *     with position.
 *   - `keyword_lifecycle` (v33) — how far the word has got. Nothing to do with
 *     position.
 *
 * `domain/optimize/plan.js` (module 13) builds the same-shaped model **per
 * optimization run and never persists it**. Requirement §10 is explicit: 「位置
 * 计划的唯一持久层在模块 08；13 只引用与冻结，不产生第二份口径。」 So this file
 * is that one persistence layer, and 13 reads from here.
 *
 * ## 一词一主人 is structural
 *
 * `keyword_plan_entry` has `PRIMARY KEY (plan_id, keyword_key)` — the **folded**
 * key, not the raw spelling. A second owner for a keyword inside one plan is
 * impossible **at the schema level**, and because the key is folded it holds for
 * `'Bench  Cushion'` beside `'bench cushion'` too, which is what the repo means
 * by one keyword (`keywordKey`, domain/keywords/key.js, the ruler v15 folded the
 * whole library with). `savePlan` also refuses duplicates in code (so the caller
 * gets a readable reason), but the primary key is the backstop: a silent
 * last-wins would make 一词一主人 a lie.
 *
 * ## 一位一用途
 *
 * Positions are a closed vocabulary (`PLAN_POSITION_PURPOSES`, domain/states.js).
 * A plan entry *assigns* a keyword to a position; it can never *redefine* what
 * that position is for. Two of the eight positions (attributes, negatives) have
 * **no eligibility rule** in this module — their eligibility is `manual` — so
 * `proposePlan` never assigns an owner from them.
 *
 * ## 计划覆盖 ≠ 实际覆盖 (the sharp edge)
 *
 * `planCoverage` returns `planned` and `actual` as **two separate values**. When
 * no listing text is supplied, `actual` is `null` **with a reason** — never `0`.
 * A zero is indistinguishable from "planned 10, reached 0", and returning the
 * planned number as the actual number is the failure 「把计划覆盖当实际覆盖」
 * (§22.5) that this batch exists to prevent.
 */

import { randomUUID } from 'node:crypto'

import { keywordKey, normalizeKeyword } from '../domain/keywords/key.js'
import { forListing } from '../domain/keywords/classify.js'
import { keywordInText } from '../sources/keyword-tiers.js'
import {
  PLAN_MANUAL_POSITIONS, PLAN_POSITIONS, PLAN_POSITION_PURPOSES, PLAN_SOURCES,
  PLAN_STATUSES, PLAN_STATUS_LABELS, isPlanPosition,
} from '../domain/states.js'
import { nowIso } from './db.js'

/* ── input normalisation ─────────────────────────────────────────────────────
   The same rulers `keyword-lifecycle.js` / `keyword-ownership.js` use, so the
   three tables fold the same way and a lookup cannot miss because one side
   lower-cased and the other did not. */

function marketplaceOf(value) {
  const marketplace = String(value ?? '').trim().toUpperCase()
  if (marketplace === '') throw new Error('marketplace is required')
  return marketplace
}

function asinOf(value) {
  const asin = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new Error(`asin "${value}" is not a 10-character ASIN`)
  }
  return asin
}

function statusOf(value) {
  const status = String(value ?? 'draft').trim() || 'draft'
  if (!PLAN_STATUSES.includes(status)) {
    throw new Error(`status "${value}" is not one of ${PLAN_STATUSES.join(' / ')}`)
  }
  return status
}

function sourceOf(value) {
  const source = String(value ?? 'manual').trim() || 'manual'
  if (!PLAN_SOURCES.includes(source)) {
    throw new Error(`source "${value}" is not one of ${PLAN_SOURCES.join(' / ')}`)
  }
  return source
}

function positionOf(value) {
  const position = String(value ?? '').trim()
  if (!isPlanPosition(position)) {
    throw new Error(
      `position "${value}" is not one of ${PLAN_POSITIONS.join(' / ')} — `
      + '一位一用途：位置的用途在 domain/states.js 里声明，计划条目不能自己定义位置',
    )
  }
  return position
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/* ── the eligibility positions, and the proposal's owner policy ───────────────
   The six positions that carry a threshold rule are the keys `forListing`
   returns — read from it rather than retyped, so the two cannot drift. The two
   `manual` positions are appended. */

const ELIGIBILITY_POSITIONS = Object.keys(forListing({ searchVolume: 0, svTier: 'L5', cvr: 0 }))

/**
 * Which eligible position a proposal should give a keyword, strongest first.
 *
 * This is a **policy**, not a vocabulary — but it must still be exactly the
 * eligibility positions and never a manual one, so `tests/b08-plan.mjs` asserts
 * it is a permutation of `ELIGIBILITY_POSITIONS`. Backend is last on purpose: it
 * is the fallback for words the front positions cannot hold, and picking it
 * before `adsExact` would send every eligible word to the backend.
 */
export const OWNER_PRIORITY = ['title', 'bullets', 'adsExact', 'adsPhrase', 'adsBroad', 'backend']

/**
 * The positions a listing's own text can prove. Ad positions live in the ad
 * console and `negatives` lives in the backend negative list, so a plan cell
 * there **cannot be checked from listing copy** — they are reported as
 * unverifiable rather than silently counted as reached.
 */
export const CHECKABLE_POSITIONS = ['title', 'bullets', 'attributes', 'backend']

/* ── row hydration ─────────────────────────────────────────────────────────── */

function hydratePlan(row) {
  if (!PLAN_STATUSES.includes(row.status)) {
    throw new Error(
      `keyword_plan row ${row.id} has status "${row.status}", not one of ${PLAN_STATUSES.join(' / ')}`,
    )
  }
  return {
    id: row.id,
    asin: row.asin,
    marketplace: row.marketplace,
    name: row.name ?? null,
    note: row.note ?? null,
    lineageId: row.lineage_id,
    version: Number(row.version),
    status: row.status,
    statusLabel: PLAN_STATUS_LABELS[row.status] ?? row.status,
    source: row.source,
    createdAt: row.created_at,
    createdBy: row.created_by ?? null,
    entryCount: row.entry_count === undefined ? undefined : Number(row.entry_count),
  }
}

/**
 * One entry, in the shape **both** `getPlan` and `proposePlan` return.
 *
 * Same shape on purpose: the UI diffs a proposal against the saved plan, and two
 * shapes would make the diff a translation instead of a comparison.
 */
function hydrateEntry(row) {
  const supporting = parseJson(row.support_json, []) ?? []
  return {
    keyword: row.keyword,
    ownerPosition: row.owner_position,
    tier: row.tier ?? null,
    searchVolume: row.search_volume === null || row.search_volume === undefined ? null : Number(row.search_volume),
    supporting: supporting.map(item => ({
      position: item.position,
      reason: item.reason ?? null,
      probe: item.probe ?? null,
    })),
  }
}

/** The positions an entry's cells occupy: its owner, then its supporting slots. */
function cellsOf(entry) {
  return [entry.ownerPosition, ...entry.supporting.map(item => item.position)]
}

/* ── reads ─────────────────────────────────────────────────────────────────── */

/** Plans for one ASIN + marketplace (or any subset of those two filters). */
export function listPlans(store, { marketplace = null, asin = null } = {}) {
  const clauses = []
  const params = []
  if (marketplace !== null && marketplace !== undefined && String(marketplace).trim() !== '') {
    clauses.push('marketplace = ?')
    params.push(marketplaceOf(marketplace))
  }
  if (asin !== null && asin !== undefined && String(asin).trim() !== '') {
    clauses.push('asin = ?')
    params.push(asinOf(asin))
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  return store.all(
    `SELECT *, (SELECT COUNT(*) FROM keyword_plan_entry e WHERE e.plan_id = keyword_plan.id) AS entry_count
     FROM keyword_plan ${where}
     ORDER BY marketplace, asin, lineage_id, version DESC`,
    params,
  ).map(hydratePlan)
}

/** One plan and its entries, or `null`. */
export function getPlan(store, { planId } = {}) {
  const id = String(planId ?? '').trim()
  if (id === '') throw new Error('planId is required')
  /* entry_count 必须与 listPlans 一样由 SQL 算出来：hydratePlan 会读这一列，
     少了它就得到 entryCount: undefined，页面「当前词数」那个 chip 就会印
     「当前词数 undefined」。同一个读数在两处读取路径上必须是同一件事。 */
  const row = store.get(
    `SELECT *, (SELECT COUNT(*) FROM keyword_plan_entry e WHERE e.plan_id = keyword_plan.id) AS entry_count
       FROM keyword_plan WHERE id = ?`,
    [id],
  )
  if (row === undefined || row === null) return null
  const entries = store.all(
    'SELECT * FROM keyword_plan_entry WHERE plan_id = ? ORDER BY keyword, owner_position',
    [id],
  ).map(hydrateEntry)
  return { plan: hydratePlan(row), entries }
}

/** Versions of one lineage, newest first. */
export function planHistory(store, { lineageId } = {}) {
  const lineage = String(lineageId ?? '').trim()
  if (lineage === '') throw new Error('lineageId is required')
  return store.all(
    `SELECT *, (SELECT COUNT(*) FROM keyword_plan_entry e WHERE e.plan_id = keyword_plan.id) AS entry_count
     FROM keyword_plan WHERE lineage_id = ? ORDER BY version DESC`,
    [lineage],
  ).map(hydratePlan)
}

/**
 * A **proposal**, derived from the master library and writing nothing.
 *
 * One owner per keyword, chosen by `OWNER_PRIORITY` from the eligibility flags
 * in `for_listing_json` (falling back to `forListing` only when the column is
 * `NULL` — never computed). It never picks `attributes` / `negatives`: those have
 * no eligibility rule in this module, and inventing one would be manufacturing a
 * rule.
 *
 * ## One bad row does not destroy the whole proposal
 *
 * A row whose stored eligibility has **no** position set to true is reported in
 * `skipped` with its reason and the rest of the proposal is still produced. The
 * earlier version threw for the whole call, so a single hand-edited
 * `for_listing_json` (all false, or `{}`) meant the user got an error and no
 * proposal instead of "N−1 words plus one marked row".
 *
 * It **reports** such a row rather than silently recomputing `forListing` for it:
 * storing all-false is a manual edit meaning 「哪都不合格」, and quietly
 * overriding it with the thresholds is the same class of defect as the one this
 * module exists to prevent.
 *
 * Supporting slots are **not** derived here. Eligibility is not assignment, and
 * a supporting slot is an assignment decision with a reason attached — the
 * domain model (`plan.js`, module 13) owns that reasoning.
 *
 * `kw_master` is not ASIN-scoped, so the proposal is per **marketplace**; `asin`
 * is carried through only to name the plan it is meant for.
 */
export function proposePlan(store, { asin = null, marketplace } = {}) {
  const market = marketplaceOf(marketplace)
  const asinKey = asin === null || asin === undefined || String(asin).trim() === '' ? null : asinOf(asin)
  /* 2026-10-25（R-29）：这里原来**只按 marketplace 过滤**，`asinKey` 算出来却从没用过。
     实测：给 B0GV55Q4JG（长凳垫）提案，返回「共 30778 词可提案」——
     里面是 `patio furniture set`（167 万搜索量）、`chair`、`boat seats`、`amazon message center`，
     和这个 ASIN 毫无关系。任何照它保存的人，会得到一个把长凳垫和整个户外家具类目
     混在一起的位置计划。

     **kw_master 回答的是「全市场有哪些词」，不是「这个 ASIN 有哪些词」。**
     后者在本仓有两个来源：`asin_keyword`（我们测到过排名的）与 legacy `keyword`（这个 ASIN 的候选词）。
     提案要用的是这两个的**并集**；kw_master 只负责提供量、层级与资格。

     不传 asin 时保持原行为（全库），因为那是「看看全库能怎么分」的合法用法。 */
  const scoped = asinKey === null
    ? null
    : `AND m.keyword IN (
         SELECT keyword FROM asin_keyword WHERE asin = ? AND marketplace = ?
         UNION
         SELECT keyword FROM keyword WHERE marketplace = ?
       )`
  const rows = store.all(
    `SELECT m.keyword AS keyword, m.marketplace AS marketplace, m.search_volume AS search_volume,
            m.sv_tier AS sv_tier, m.for_listing_json AS for_listing_json
       FROM kw_master m WHERE m.marketplace = ?
       ${scoped === null ? '' : scoped}
       ORDER BY m.search_volume DESC, m.keyword`,
    scoped === null ? [market] : [market, asinKey, market, market],
  )
  const entries = []
  const skipped = []
  for (const row of rows) {
    const stored = parseJson(row.for_listing_json, null)
    /* Only a genuinely absent column falls back to the thresholds. A stored `{}`
       or an all-false object is used as-is and reported below. */
    const eligibility = stored === null
      ? forListing({ searchVolume: row.search_volume, svTier: row.sv_tier, cvr: null })
      : stored
    const owner = OWNER_PRIORITY.find(position => eligibility?.[position] === true)
    if (owner === undefined) {
      skipped.push({
        keyword: row.keyword,
        reason: stored === null
          ? '资格缺失，且按 sv / cvr 重算后没有任何位置合格'
          : '存下的资格 for_listing_json 里没有任何位置为 true —— 这是人工编辑的「哪都不合格」，不是可自动分配的词，所以不静默重算',
      })
      continue
    }
    if (PLAN_MANUAL_POSITIONS.includes(owner)) {
      /* Structurally impossible given OWNER_PRIORITY, kept as an explicit refusal
         so the invariant is stated where it is relied on, not only in the test. */
      throw new Error(`proposePlan picked the manual position ${owner} — manual positions have no eligibility rule`)
    }
    entries.push({
      keyword: row.keyword,
      ownerPosition: owner,
      tier: row.sv_tier ?? null,
      searchVolume: row.search_volume === null || row.search_volume === undefined ? null : Number(row.search_volume),
      supporting: [],
    })
  }
  const notes = [
    '这是**提案**（未写库）：主人按 for_listing_json 的资格 + OWNER_PRIORITY 推出，'
      + '每个词恰好一个主人；attributes / negatives 没有资格规则，提案不会把它们当主人。'
      + 'supporting 不由资格推导 —— 资格不是分配。',
  ]
  if (entries.length === 0) {
    notes.push(`0 条可提案：${rows.length} 行里没有一行能推出主人`
      + (skipped.length > 0 ? `；主要原因是「${skipped[0].reason}」` : '（总库里没有这个词站的词）') + '。')
  }
  if (skipped.length > 0) {
    notes.push(`跳过 ${skipped.length} 行（见 skipped）：${skipped.slice(0, 5).map(item => item.keyword).join('、')}`
      + (skipped.length > 5 ? ` 等 ${skipped.length} 行` : '') + '。')
  }
  return {
    asin: asinKey,
    marketplace: market,
    entries,
    skipped,
    note: notes.join(' '),
  }
}

/* ── the write ─────────────────────────────────────────────────────────────── */

/** Validate and normalise the entries a caller wants to save. Throws before any write. */
function normalizeEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('entries must be an array')
  /* Deduplicate on the **folded** key, the same ruler the primary key uses. Using the
     raw spelling here would let `Bench  Cushion` and `bench cushion` both through and
     the schema would catch it — but the caller would get a SQLite constraint message
     instead of a sentence. Both layers use one fold, so they agree on what a duplicate
     is. `keywordKey` is the repo's one definition (domain/keywords/key.js). */
  const seen = new Set()
  return entries.map((entry, index) => {
    const folded = keywordKey(entry?.keyword)
    if (folded === '') throw new Error('keyword is required')
    if (seen.has(folded)) {
      throw new Error(
        `计划里「${normalizeKeyword(entry?.keyword)}」出现了两次（第 ${index + 1} 条）—— 一词一主人：`
        + '一个词在一个计划里只能有一个主人（大小写与空格折叠后算同一个词）。整个保存被拒绝，没有写入任何东西。',
      )
    }
    seen.add(folded)
    const ownerPosition = positionOf(entry?.ownerPosition)
    const supportingRaw = entry?.supporting ?? []
    if (!Array.isArray(supportingRaw)) throw new Error(`supporting for "${folded}" must be an array`)
    const supportingSeen = new Set()
    const supporting = supportingRaw.map((slot) => {
      const position = positionOf(slot?.position)
      if (position === ownerPosition) {
        throw new Error(`「${folded}」的 supporting 位置等于主人（${position}）—— 一个位置不能既是主人又是复现位`)
      }
      if (supportingSeen.has(position)) {
        throw new Error(`「${folded}」的 supporting 里 ${position} 出现了两次`)
      }
      supportingSeen.add(position)
      const reason = blankToNull(slot?.reason)
      if (reason === null) {
        throw new Error(
          `「${folded}」在 ${position} 的 supporting 没有理由 —— `
          + 'supporting_reuse_requires_field_and_reason：一个没有理由的复现位只是这个词碰巧待过的第二个地方',
        )
      }
      return { position, reason, probe: blankToNull(slot?.probe) }
    })
    return {
      /* `keyword` is what the operator typed (trimmed, inner runs collapsed) and is
         what the reader sees; `keywordKey` is the folded identity the primary key is
         built on. Two columns, one ruler each, no third spelling. */
      keyword: normalizeKeyword(entry?.keyword),
      keywordKey: folded,
      ownerPosition,
      tier: blankToNull(entry?.tier),
      searchVolume: entry?.searchVolume === null || entry?.searchVolume === undefined
        ? null
        : Number(entry.searchVolume),
      supporting,
    }
  })
}

/**
 * Create v1, or a new version in the same lineage when revising.
 *
 * `lineageId` names the family to add a version to; omit it to start a new one.
 * A prior version is **never touched** — a revision that mutated v1 in place
 * would make "what did we decide before" unanswerable, which is the whole point
 * of keeping versions.
 */
export function savePlan(store, {
  asin, marketplace, name = null, note = null, entries = [],
  source = 'manual', createdBy = null, lineageId = null, status = 'draft',
} = {}) {
  const market = marketplaceOf(marketplace)
  const asinKey = asinOf(asin)
  const src = sourceOf(source)
  const statusKey = statusOf(status)
  /* Validate everything before opening a transaction: a refusal must write
     nothing, and validating first makes that true even if `tx` were ever to
     swallow a rollback. */
  const normalized = normalizeEntries(entries)

  return store.tx(() => {
    const requested = blankToNull(lineageId)
    let lineage = requested
    let version = 1
    if (lineage !== null) {
      const existing = store.get('SELECT MAX(version) AS v FROM keyword_plan WHERE lineage_id = ?', [lineage])
      if (existing === null || existing.v === null) {
        throw new Error(`lineage "${lineage}" does not exist — omit lineageId to start a new plan`)
      }
      version = Number(existing.v) + 1
    } else {
      lineage = randomUUID()
    }
    const id = randomUUID()
    const at = nowIso()
    store.run(
      `INSERT INTO keyword_plan
        (id, asin, marketplace, name, note, lineage_id, version, status, source, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, asinKey, market, blankToNull(name), blankToNull(note), lineage, version, statusKey, src, at, blankToNull(createdBy)],
    )
    for (const entry of normalized) {
      store.run(
        `INSERT INTO keyword_plan_entry
          (plan_id, keyword, keyword_key, owner_position, tier, search_volume, support_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, entry.keyword, entry.keywordKey, entry.ownerPosition, entry.tier, entry.searchVolume, json(entry.supporting), at],
      )
    }
    return getPlan(store, { planId: id })
  })
}

/* ── coverage: planned and actual are two values, never one ─────────────────── */

/** The listing text each checkable position contributes, from a draft or a row. */
function positionTextOf(fields = {}) {
  const bullets = Array.isArray(fields.bullets)
    ? fields.bullets
    : Object.entries(fields)
      .filter(([key]) => key.startsWith('bullet_'))
      .sort((a, b) => Number(a[0].slice(7)) - Number(b[0].slice(7)))
      .map(([, value]) => value)
  const attributes = Object.entries(fields)
    .filter(([key]) => key.startsWith('attribute.'))
    .map(([, value]) => value)
  return {
    title: String(fields.title ?? ''),
    bullets: bullets.filter(Boolean).join(' '),
    attributes: attributes.filter(Boolean).join(' '),
    backend: String(fields.search_terms ?? ''),
  }
}

/**
 * Planned coverage vs actual coverage, as **two separate values**.
 *
 * `planned` is read from the persisted entries: how many cells each position is
 * supposed to hold, and the total.
 *
 * `actual` is computed **only when listing text (`fields`) is supplied and it
 * actually contains text**. "Has listing text" is a property of the **content**,
 * not of the argument's nullness: `{}` and `{ title: '' }` are an *absent* listing
 * written a different way, and treating them as "a listing with nothing in it"
 * would report `actual: 0` — indistinguishable from "planned 10, reached 0", the
 * very reading 「把计划覆盖当实际覆盖」 (§22.5) this function exists to prevent.
 * So when none of the four checkable positions carries any text, `actual` is
 * `null` with a reason, and the reason says **which** of the two cases it is
 * ("not supplied" vs "supplied but empty"). `fillRate` is returned **only** when
 * `actual` is not null.
 *
 * Only the positions a listing's own text can prove are counted (`title`,
 * `bullets`, `attributes`, `backend`). Ad positions and `negatives` are reported
 * under `unverifiable` rather than counted as reached — a cell nobody can check
 * must not read as a cell that was filled.
 */
export function planCoverage(store, { planId, fields = null } = {}) {
  const loaded = getPlan(store, { planId })
  if (loaded === null) throw new Error(`no plan ${planId}`)

  const byPosition = {}
  let total = 0
  for (const entry of loaded.entries) {
    for (const cell of cellsOf(entry)) {
      byPosition[cell] = (byPosition[cell] ?? 0) + 1
      total += 1
    }
  }
  const checkable = CHECKABLE_POSITIONS.filter(position => (byPosition[position] ?? 0) > 0)
  const checkableTotal = checkable.reduce((sum, position) => sum + byPosition[position], 0)
  const unverifiable = Object.entries(byPosition)
    .filter(([position]) => !CHECKABLE_POSITIONS.includes(position))
    .map(([position, count]) => ({ position, planned: count }))

  const planned = {
    byPosition,
    total,
    checkable,
    checkableTotal,
    unverifiable,
  }

  const supplied = fields !== null && fields !== undefined
  const textOf = supplied ? positionTextOf(fields) : null
  const hasText = supplied && CHECKABLE_POSITIONS.some(position => (textOf[position] ?? '').trim() !== '')
  if (!hasText) {
    return {
      planId: loaded.plan.id,
      planned,
      actual: null,
      reason: supplied
        ? '提供了 fields，但可核对的四个位置（title / bullets / attributes / backend）都是空文本 —— '
          + '这等于**没有文案**，所以无法计算实际覆盖：实际覆盖是 null，不是 0。'
          + '把 0 当成「测过、且一格都没覆盖」，就是「把计划覆盖当实际覆盖」。'
        : '没有提供 listing 文案（fields），所以**无法计算实际覆盖** —— 实际覆盖是 null，不是 0。'
          + '0 与「计划了 10、实际到 0」无法区分；把计划数当成实际数正是 F08-05 要防的「把计划覆盖当实际覆盖」。',
    }
  }
  const actualByPosition = {}
  let actualTotal = 0
  for (const entry of loaded.entries) {
    for (const cell of cellsOf(entry)) {
      if (!CHECKABLE_POSITIONS.includes(cell)) continue
      const text = textOf[cell] ?? ''
      if (text !== '' && keywordInText(entry.keyword, text)) {
        actualByPosition[cell] = (actualByPosition[cell] ?? 0) + 1
        actualTotal += 1
      }
    }
  }
  for (const position of checkable) {
    if (!(position in actualByPosition)) actualByPosition[position] = 0
  }

  return {
    planId: loaded.plan.id,
    planned,
    actual: {
      byPosition: actualByPosition,
      total: actualTotal,
      checkable,
      unverifiable,
    },
    reason: null,
    /* 只在有可核对格时才有意义。`checkableTotal === 0` 时给 **null**，不给 1：
       给 1 等于「一个格都没法核对 → 100% 完成」，与 `optimize/plan.js` 在
       `totalPlanned === 0` 时给 null 的口径也不一致。两个「没有分母」必须是同一个答案。 */
    fillRate: checkableTotal === 0 ? null : Number((actualTotal / checkableTotal).toFixed(3)),
  }
}

/** The declared position vocabulary, for tools and the page. */
export function planPositions() {
  return PLAN_POSITIONS.map(position => ({
    id: position,
    label: PLAN_POSITION_PURPOSES[position].label,
    purpose: PLAN_POSITION_PURPOSES[position].purpose,
    manual: PLAN_MANUAL_POSITIONS.includes(position),
  }))
}
