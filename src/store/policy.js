/**
 * The policy library, as data.
 *
 * A policy is the input that produces rules — the same pipeline as 「规则获取」, one
 * step upstream. This module is the store-side half of it: read policies, write
 * one in, link a policy to the rules it touches, and record that one policy
 * supersedes another.
 *
 * Three properties hold the shape together:
 *
 *   - **Publish and effect are two dates.** `published_at` and `effective_from` are
 *     separate columns because an announcement is typically published weeks before
 *     it takes effect. Merging them would make "which policies take effect this
 *     month" unanswerable, and that question is the module's whole reason to exist.
 *
 *   - **A policy is linked by rule *id*, not by version.** `policy_rule` holds the
 *     plain `rule_id` string, because a policy affects "this rule" rather than "this
 *     rule's 2026.4 revision". The roster can be republished ten times and the link
 *     still means what it meant.
 *
 *   - **Superseding is a forward link, not a delete.** A policy that another one
 *     replaces keeps its row, changes `status` to `superseded`, and points at its
 *     replacement with `superseded_by`. Deleting it would break the chain that
 *     answers "what did this rule used to say", which is the question a compliance
 *     record exists for.
 *
 * Nothing here fetches anything. Policies arrive by paste or by file; see
 * `src/domain/policy/parse.js` for why.
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** A marketplace code, upper-cased, or `null` — never a guessed default. */
function normalizeMarketplace(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim().toUpperCase()
  return text === '' ? null : text
}

/** One `policy` row in the shape the tools and the page consume. */
function rowToPolicy(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name ?? null,
    sourceKind: row.source_kind ?? null,
    marketplace: row.marketplace,
    title: row.title,
    body_md: row.body_md,
    url: row.url,
    publishedAt: row.published_at,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    severityHint: row.severity_hint,
    /* The phrase the level was derived from. Kept in its own queryable column so a
       chip that says 「高」 can also say which words it came from — see the v12
       migration. */
    severityRaw: row.severity_raw,
    status: row.status,
    supersededBy: row.superseded_by,
    fields: parseJson(row.fields_json, []),
    importedAt: row.imported_at,
  }
}

/** Every configured source, seeded by v11 and readable by the tools and the page. */
export function listPolicySources(store) {
  return store.all('SELECT id, kind, name, url, note FROM policy_source ORDER BY id')
}

/**
 * Store one policy.
 *
 * `title` and `body` are required and an empty one is refused rather than written:
 * a row that looks like a policy and says nothing is the silent-empty failure this
 * module exists to prevent. `status` defaults to `active`; `severity_hint` is
 * written as given, so `null` stays `null` and the page can show 「未判定」 —
 * alongside `severity_raw`, the phrase the level was read from, so the chip can
 * disclose where the level came from instead of looking like a label Amazon gave.
 * The two severity columns are **paired at this boundary**: a level without its
 * wording (or the reverse) is refused by name, so no future caller can write a
 * level that reads as a fact. Both NULL is the legal "stated no severity" case.
 *
 * Re-importing the same text is a no-op: a policy is identified by
 * `(source_id, title, body_md)`, and a second paste of the same announcement
 * returns the existing row with `created: false` instead of duplicating it.
 *
 * `supersedes`, when given, names the policy this one replaces — the import and the
 * supersede happen in **one** transaction (see `applySupersede`), so a policy that
 * arrived and a policy that was replaced are one fact rather than two half-writes.
 * An unknown id is refused **by name** before the transaction opens, so the library
 * is left exactly as it was.
 *
 * @param {{sourceId?: string, title: string, bodyMd?: string, body_md?: string,
 *          marketplace?: string, url?: string, publishedAt?: string, effectiveFrom?: string,
 *          effectiveTo?: string, severityHint?: string, severityRaw?: string, status?: string,
 *          supersedes?: string, fields?: string[]}} record
 * @returns {object} the stored row, plus `created` and `supersedesRelation`
 */
export function importPolicy(store, record = {}) {
  const sourceId = String(record.sourceId ?? 'manual-paste').trim()
  const title = String(record.title ?? '').trim()
  const body = String(record.bodyMd ?? record.body_md ?? '').trim()
  if (sourceId === '') throw new Error('sourceId is required')
  if (title === '') throw new Error('title is required')
  if (body === '') throw new Error('body is required — an empty policy must not be written')

  const source = store.get('SELECT id FROM policy_source WHERE id = ?', [sourceId])
  if (source === undefined || source === null) throw new Error(`unknown policy_source "${sourceId}"`)

  /* The pairing invariant lives at the **resource boundary**, not in the caller.
     A level with no wording reads as Amazon's own classification, and a wording
     with no level is a reading nobody made — so the two columns live and die
     together. `parse.js` states the same rule, but a guard in the caller only
     protects the one caller we know about; the store is where every caller has to
     pass, so a future tool cannot write a level that reads as a fact. Both NULL
     stays legal: a policy that stated no severity has no wording either. */
  const severityHint = record.severityHint ?? record.severity_hint ?? null
  const severityRaw = record.severityRaw ?? record.severity_raw ?? null
  const hasHint = severityHint !== null && String(severityHint).trim() !== ''
  const hasRaw = severityRaw !== null && String(severityRaw).trim() !== ''
  if (hasHint !== hasRaw) {
    throw new Error(
      'severity_hint and severity_raw must be written together: a level with no wording is a judgement, '
      + 'not a hint — a policy that states no severity has both as NULL',
    )
  }

  /* Checked before the transaction opens so an unknown id writes nothing at all.
     The id is in the message because a bare "no policy" does not say which of the
     two policies involved was the one that could not be found. */
  const supersedes = String(record.supersedes ?? '').trim()
  if (supersedes !== '') {
    const target = store.get('SELECT id FROM policy WHERE id = ? AND deleted_at IS NULL', [supersedes])
    if (target === undefined || target === null) throw new Error(`unknown supersedes policy "${supersedes}"`)
  }

  return store.tx(() => {
    const duplicate = store.get(
      'SELECT * FROM policy WHERE source_id = ? AND title = ? AND body_md = ? AND deleted_at IS NULL',
      [sourceId, title, body],
    )
    if (duplicate !== undefined && duplicate !== null) {
      /* A re-import of the same text may still record the supersede: "this one
         replaces that one" is a fact about the pair, not about the paste. */
      const supersedesRelation = supersedes === ''
        ? null
        : applySupersede(store, supersedes, duplicate.id)
      return {
        ...rowToPolicy(store.get('SELECT * FROM policy WHERE id = ?', [duplicate.id])),
        created: false,
        supersedesRelation,
      }
    }

    const id = String(record.id ?? randomUUID())
    const fields = Array.isArray(record.fields)
      ? record.fields.map(field => String(field).trim()).filter(field => field !== '')
      : []
    store.run(
      `INSERT INTO policy
         (id, source_id, marketplace, title, body_md, url, published_at, effective_from,
          effective_to, severity_hint, severity_raw, status, superseded_by, fields_json, deleted_at, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
      [
        id,
        sourceId,
        normalizeMarketplace(record.marketplace),
        title,
        body,
        record.url === undefined || record.url === null || String(record.url).trim() === '' ? null : String(record.url).trim(),
        record.publishedAt ?? record.published_at ?? null,
        record.effectiveFrom ?? record.effective_from ?? null,
        record.effectiveTo ?? record.effective_to ?? null,
        severityHint,
        /* The words the level came from. Written alongside the level, never instead
           of it: a level with no phrase would read as a fact rather than a reading. */
        severityRaw,
        String(record.status ?? 'active'),
        fields.length > 0 ? JSON.stringify(fields) : null,
        nowIso(),
      ],
    )
    /* Applied inside the same transaction as the insert: a policy that arrived and
       a policy that was replaced are one fact, and half of it — the new row in place
       with the old one still active — is worse than neither half. */
    const supersedesRelation = supersedes === ''
      ? null
      : applySupersede(store, supersedes, id)
    return {
      ...rowToPolicy(store.get('SELECT * FROM policy WHERE id = ?', [id])),
      created: true,
      supersedesRelation,
    }
  })
}

/**
 * Policies, newest effect first, each with the rule ids it is linked to.
 *
 * `since` filters on `effective_from`, because "which policies take effect from
 * this date on" is the question the two date columns were split for. A policy whose
 * effective date could not be read has `effective_from IS NULL` and is therefore
 * *excluded* by `since` — it cannot honestly be said to take effect after a date it
 * does not carry. `sinceExcluded` counts exactly those rows so the caller can say
 * so instead of quietly returning a shorter list.
 *
 * `sinceExcluded` is counted over **the same scope as the query**, minus the `since`
 * clause itself. Counting the whole library instead made the number follow someone
 * else's filters: `since + DE` reported the unread count for every marketplace,
 * which is a number that changes when you filter by something unrelated to it.
 *
 * @returns {{rows: Array, total: number, sinceExcluded: number}}
 */
export function listPolicies(store, options = {}) {
  const where = ['p.deleted_at IS NULL']
  const params = []
  /* The same filters without `since`, kept in step by construction — every clause
     below is pushed to both. Used only for `sinceExcluded`. */
  const scopeWhere = ['p.deleted_at IS NULL']
  const scopeParams = []
  const push = (clause, value) => {
    where.push(clause)
    params.push(value)
    scopeWhere.push(clause)
    scopeParams.push(value)
  }

  if (options.marketplace !== undefined && options.marketplace !== null && String(options.marketplace).trim() !== '') {
    push('p.marketplace = ?', normalizeMarketplace(options.marketplace))
  }
  if (options.status !== undefined && options.status !== null && String(options.status).trim() !== '') {
    push('p.status = ?', String(options.status).trim())
  }
  const since = options.since === undefined || options.since === null ? '' : String(options.since).trim()
  if (since !== '') {
    where.push('p.effective_from IS NOT NULL AND p.effective_from >= ?')
    params.push(since)
  }

  const rows = store.all(
    `SELECT p.*, s.name AS source_name, s.kind AS source_kind
       FROM policy p
       JOIN policy_source s ON s.id = p.source_id
      WHERE ${where.join(' AND ')}
      ORDER BY (p.effective_from IS NULL), p.effective_from DESC, p.imported_at DESC`,
    params,
  )

  const byPolicy = new Map()
  for (const link of store.all('SELECT policy_id, rule_id FROM policy_rule ORDER BY rule_id')) {
    if (!byPolicy.has(link.policy_id)) byPolicy.set(link.policy_id, [])
    byPolicy.get(link.policy_id).push(link.rule_id)
  }
  const replaced = supersedesMap(store)

  let sinceExcluded = 0
  if (since !== '') {
    sinceExcluded = Number(store.get(
      `SELECT COUNT(*) AS n
         FROM policy p JOIN policy_source s ON s.id = p.source_id
        WHERE ${scopeWhere.join(' AND ')} AND p.effective_from IS NULL`,
      scopeParams,
    )?.n ?? 0)
  }

  return {
    rows: rows.map(row => ({
      ...rowToPolicy(row),
      rules: byPolicy.get(row.id) ?? [],
      supersedes: replaced.get(row.id) ?? [],
    })),
    total: rows.length,
    sinceExcluded,
  }
}

/**
 * `Map<policy_id, string[]>` — for each policy, the ids it replaced.
 *
 * The reverse of the stored `superseded_by` direction. The list and the page need
 * both directions: 「被谁取代」 is on the row, 「取代了谁」 is only derivable, and a
 * chain a reader can walk one way only is half a chain.
 */
function supersedesMap(store) {
  const map = new Map()
  for (const row of store.all(
    'SELECT id, superseded_by FROM policy WHERE superseded_by IS NOT NULL AND deleted_at IS NULL',
  )) {
    if (!map.has(row.superseded_by)) map.set(row.superseded_by, [])
    map.get(row.superseded_by).push(row.id)
  }
  return map
}

/** One policy by id, or `null`. */
export function getPolicy(store, id) {
  const target = String(id ?? '').trim()
  if (target === '') return null
  const row = store.get(
    `SELECT p.*, s.name AS source_name, s.kind AS source_kind
       FROM policy p JOIN policy_source s ON s.id = p.source_id
      WHERE p.id = ? AND p.deleted_at IS NULL`,
    [target],
  )
  if (row === undefined || row === null) return null
  const rules = store.all('SELECT rule_id FROM policy_rule WHERE policy_id = ? ORDER BY rule_id', [target])
    .map(entry => entry.rule_id)
  const replaced = store.all(
    'SELECT id FROM policy WHERE superseded_by = ? AND deleted_at IS NULL ORDER BY effective_from, imported_at',
    [target],
  ).map(entry => entry.id)
  return { ...rowToPolicy(row), rules, supersedes: replaced }
}

/** Which policies touch each rule: `Map<rule_id, [{id, title, severityHint, status}]>`. */
export function policyLinksByRule(store) {
  const map = new Map()
  const rows = store.all(
    `SELECT l.rule_id, p.id, p.title, p.severity_hint, p.status
       FROM policy_rule l JOIN policy p ON p.id = l.policy_id
      WHERE p.deleted_at IS NULL
      ORDER BY p.effective_from DESC, p.title`,
  )
  for (const row of rows) {
    if (!map.has(row.rule_id)) map.set(row.rule_id, [])
    map.get(row.rule_id).push({
      id: row.id,
      title: row.title,
      severityHint: row.severity_hint,
      status: row.status,
    })
  }
  return map
}

/** The policies that touch one rule. */
export function policiesForRule(store, ruleId) {
  return policyLinksByRule(store).get(String(ruleId ?? '').trim()) ?? []
}

/**
 * Point a policy at the rules it affects, and record the fields it touches.
 *
 * `ruleIds` **replaces** the policy's link set rather than adding to it, so the
 * page can both link and unlink with one POST of one fact ("this policy's rules are
 * now these"), and a caller that wants to add one rule sends the whole set. An
 * unknown `rule_id` is refused by name — a link to a rule that does not exist is a
 * dangling citation, and the one moment it can be caught is here.
 *
 * `fields` is only written when the caller passes it: omitting it leaves whatever
 * is stored alone, so a rule-only link cannot silently wipe the field list.
 *
 * @returns {{policyId: string, ruleIds: string[], fields: string[], added: string[], removed: string[]}}
 */
export function linkPolicyToRules(store, options = {}) {
  const policyId = String(options.policyId ?? '').trim()
  if (policyId === '') throw new Error('policyId is required')
  const policy = store.get('SELECT * FROM policy WHERE id = ? AND deleted_at IS NULL', [policyId])
  if (policy === undefined || policy === null) throw new Error(`no policy ${policyId}`)

  const ruleIds = [...new Set((Array.isArray(options.ruleIds) ? options.ruleIds : [])
    .map(id => String(id).trim())
    .filter(id => id !== ''))]
  const known = new Set(store.all('SELECT DISTINCT rule_id FROM rule').map(row => row.rule_id))
  const unknown = ruleIds.filter(id => !known.has(id))
  if (unknown.length > 0) throw new Error(`unknown rule_id: ${unknown.join(', ')}`)

  const fields = options.fields === undefined || options.fields === null
    ? null
    : [...new Set((Array.isArray(options.fields) ? options.fields : [])
      .map(field => String(field).trim())
      .filter(field => field !== ''))]

  return store.tx(() => {
    const before = new Set(store.all('SELECT rule_id FROM policy_rule WHERE policy_id = ?', [policyId])
      .map(row => row.rule_id))
    const after = new Set(ruleIds)
    const added = ruleIds.filter(id => !before.has(id))
    const removed = [...before].filter(id => !after.has(id))

    for (const id of removed) {
      store.run('DELETE FROM policy_rule WHERE policy_id = ? AND rule_id = ?', [policyId, id])
    }
    for (const id of added) {
      store.run(
        'INSERT INTO policy_rule (policy_id, rule_id, note) VALUES (?, ?, ?)',
        [policyId, id, options.note ?? null],
      )
    }
    if (fields !== null) {
      store.run(
        'UPDATE policy SET fields_json = ? WHERE id = ?',
        [fields.length > 0 ? JSON.stringify(fields) : null, policyId],
      )
    }

    return {
      policyId,
      ruleIds,
      fields: fields === null ? parseJson(policy.fields_json, []) : fields,
      added,
      removed,
    }
  })
}

/**
 * The two writes a supersede needs, plus the refusals. **Assumes an open
 * transaction** — it is called both from `supersede` and from `importPolicy`, so an
 * import that also replaces a policy is one transaction rather than two (a policy
 * that arrived and a policy that was replaced are one fact, and half of it is worse
 * than neither).
 *
 * Four refusals, all by name:
 *
 *   - an unknown `older` or `newer`;
 *   - self-reference;
 *   - an `older` that is **already superseded** — re-pointing it would silently
 *     rewrite history and, worse, flip it back out of `superseded` if the previous
 *     replacement is the one doing the pointing;
 *   - a back edge that would close a cycle, walked through the whole chain rather
 *     than just the first hop, since a longer loop is no less a loop.
 *
 * The one idempotent case is superseding a policy by the same replacement it already
 * points at: that is the state the caller asked for, so it returns `already: true`
 * instead of failing a repeated import.
 *
 * @returns {{older: string, newer: string, already: boolean}}
 */
function applySupersede(store, older, newer) {
  if (older === '' || newer === '') throw new Error('older and newer are both required')
  if (older === newer) throw new Error('a policy cannot supersede itself')

  const oldRow = store.get('SELECT id, status, superseded_by FROM policy WHERE id = ? AND deleted_at IS NULL', [older])
  if (oldRow === undefined || oldRow === null) throw new Error(`no policy ${older}`)
  if (oldRow.status === 'superseded') {
    if (String(oldRow.superseded_by ?? '') === newer) return { older, newer, already: true }
    throw new Error(`policy ${older} is already superseded by ${oldRow.superseded_by}`)
  }

  const newRow = store.get('SELECT id, superseded_by FROM policy WHERE id = ? AND deleted_at IS NULL', [newer])
  if (newRow === undefined || newRow === null) throw new Error(`no policy ${newer}`)

  /* Walk the whole forward chain from `newer`: if it reaches `older`, pointing
     `older` at `newer` closes a loop. Checking only the first hop would let a
     three-policy loop through. */
  const seen = new Set([newer])
  let cursor = newRow.superseded_by
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    if (cursor === older) {
      throw new Error(`policy ${newer} already leads to ${older} — refusing to close a cycle`)
    }
    seen.add(cursor)
    const next = store.get('SELECT superseded_by FROM policy WHERE id = ?', [cursor])
    cursor = next === undefined || next === null ? null : next.superseded_by
  }

  store.run("UPDATE policy SET status = 'superseded', superseded_by = ? WHERE id = ?", [newer, older])
  store.run("UPDATE policy SET status = 'active' WHERE id = ?", [newer])
  return { older, newer, already: false }
}

/**
 * Record that `newer` replaces `older`.
 *
 * The superseded policy keeps its row, becomes `status = 'superseded'`, and points
 * at its replacement. Both halves are written in one transaction: a status change
 * without the pointer would leave a policy marked replaced with nothing to follow,
 * which is worse than either state on its own.
 *
 * @returns {{older: string, newer: string, already: boolean}}
 */
export function supersede(store, options = {}) {
  const older = String(options.older ?? '').trim()
  const newer = String(options.newer ?? '').trim()
  return store.tx(() => applySupersede(store, older, newer))
}

/**
 * The chain from one policy forward through `superseded_by`.
 *
 * A cycle is impossible through `supersede` (it refuses self-reference and only
 * ever points forward), but the walk guards against one anyway: an infinite loop
 * inside a page request is a worse failure than a truncated chain.
 *
 * @returns {Array<{id: string, title: string, status: string}>} oldest first
 */
export function policyChain(store, id) {
  const chain = []
  const seen = new Set()
  let current = String(id ?? '').trim()
  while (current !== '' && !seen.has(current)) {
    seen.add(current)
    const row = store.get('SELECT id, title, status, superseded_by FROM policy WHERE id = ?', [current])
    if (row === undefined || row === null) break
    chain.push({ id: row.id, title: row.title, status: row.status })
    current = row.superseded_by === null || row.superseded_by === undefined ? '' : String(row.superseded_by)
  }
  return chain
}

/** Counts for the page's chips: how many are active, superseded, or unjudged. */
export function policyStats(store) {
  const rows = store.all(
    `SELECT status, severity_hint, effective_from FROM policy WHERE deleted_at IS NULL`,
  )
  const stats = { total: rows.length, active: 0, superseded: 0, unjudged: 0, unknownEffective: 0, linked: 0 }
  for (const row of rows) {
    if (row.status === 'active') stats.active += 1
    if (row.status === 'superseded') stats.superseded += 1
    /* 「未判定」 is not zero and not a guess: the policy never said. */
    if (row.severity_hint === null || row.severity_hint === undefined) stats.unjudged += 1
    if (row.effective_from === null || row.effective_from === undefined) stats.unknownEffective += 1
  }
  stats.linked = Number(store.get('SELECT COUNT(DISTINCT policy_id) AS n FROM policy_rule')?.n ?? 0)
  return stats
}
