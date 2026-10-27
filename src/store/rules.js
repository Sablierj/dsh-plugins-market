/**
 * The rule roster, as data.
 *
 * Two halves live in different places, and this module is the store-side half:
 *
 *   - **The judgement** is code — `listing-rules.js`'s `CHECKS`, indexed by rule
 *     id. It reads the marketplace, the lexicon and the attribute registry, none
 *     of which is serialisable (arch §3.4, rejected option A).
 *   - **The roster** is data — which rules exist, their severity, their citation,
 *     their body, their parameters. That is what the user edits, and it is what
 *     this module reads and writes.
 *
 * `rosterForValidation` is the single entry point `validate` goes through: it
 * picks between the run's frozen snapshot and the live roster, and returns which
 * one it picked. Everything that judges a draft calls that, so there is exactly
 * one place where "which rules apply" is decided. The write path is `upsertRule` /
 * `setRuleEnabled`, and both of them **publish a new
 * version** rather than editing a row in place. That is not fastidiousness: the
 * `rule` primary key is `(rule_set_version, rule_id)`, so a run from March points
 * at its own version and that chain has to resolve forever. Editing in place would
 * silently rewrite the rules a past report was judged against.
 *
 * When the store has no roster at all (a store that predates v10, or one whose
 * migration was interrupted), `loadActiveRoster` falls back to the code seed and
 * says so with `fromCode: true`. It falls back only on a genuinely empty rule
 * table — an active version whose rules were all disabled is *not* empty, and
 * reporting the code set there would resurrect exactly what the user turned off.
 */

import { RULES_SOURCE, RULES_VERSION, SEED_ROSTER } from '../domain/rules/listing-rules.js'
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

/** One `rule` row as the roster shape the registry and `validate` consume. */
function rowToRule(row) {
  return {
    id: row.rule_id,
    kind: row.kind,
    appliesTo: parseJson(row.applies_to_json, []),
    scope: row.scope,
    severity: row.severity,
    title: row.title,
    source: row.source,
    body_md: row.body_md ?? null,
    params: parseJson(row.params_json, null),
    sortOrder: row.sort_order,
    enabled: row.enabled === 1,
  }
}

/** The code seed, when the store has no roster to read. `fromCode` is the honest flag. */
function codeFallback() {
  return {
    version: RULES_VERSION,
    source: RULES_SOURCE,
    count: SEED_ROSTER.length,
    fromCode: true,
    rules: SEED_ROSTER.map(rule => ({ ...rule, kind: 'code' })),
  }
}

/** The version currently marked active, or null. */
export function activeVersion(store) {
  const row = store.get('SELECT version FROM rule_set WHERE is_active = 1 ORDER BY published_at DESC, version DESC LIMIT 1')
  return row === undefined || row === null ? null : row.version
}

/**
 * The roster in force right now.
 *
 * @returns {{version: string, source: string, count: number, fromCode: boolean, rules: Array}}
 */
export function loadActiveRoster(store) {
  const set = store.get('SELECT * FROM rule_set WHERE is_active = 1 ORDER BY published_at DESC, version DESC LIMIT 1')
  if (set === undefined || set === null) return codeFallback()
  const total = Number(store.get('SELECT COUNT(*) AS n FROM rule')?.n ?? 0)
  if (total === 0) return codeFallback()
  const rows = store.all(
    'SELECT * FROM rule WHERE rule_set_version = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY sort_order, rule_id',
    [set.version],
  )
  return {
    version: set.version,
    source: set.source,
    count: rows.length,
    fromCode: false,
    rules: rows.map(rowToRule),
  }
}

/**
 * A run's own rule snapshot, or `null` when it has none.
 *
 * `null` and `[]` mean different things here and are deliberately kept apart:
 *
 *   `null`  no snapshot at all — a run made before B02, or one whose
 *           `rules_json` is missing or malformed. The caller has to get its
 *           roster from somewhere else.
 *   `[]`    a snapshot that deliberately holds no rules, i.e. every rule was
 *           disabled when the run was made. That is a *finding*, not an absence,
 *           and folding it into `null` would resurrect the rules the user turned
 *           off — the exact failure the header comment warns about.
 */
function snapshotOf(run) {
  if (run === null || run === undefined) return null
  const snapshot = parseJson(run.rules_json, null)
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.rules)) return null
  return snapshot
}

/**
 * The one place that decides which roster a validation runs against.
 *
 * Two sources, and the order is not arbitrary:
 *
 *   1. **The run's own snapshot**, when it has one. A report from March has to be
 *      explainable in June, so re-checking an existing run is judged by the rules
 *      in force when it was made — never by today's.
 *   2. **The active roster**, otherwise. This is the branch that makes the rule
 *      centre a switch rather than a viewer: a rule the user disabled is disabled
 *      here, and a `lexicon` rule they added is in force here.
 *
 * Branch 2 used to read the code constant instead. The consequence was narrow and
 * nasty: `amzn_optimize_validate` with no `runId` fired rules the user had
 * switched off, so the switch looked inert exactly where a user would first try
 * it. `loadActiveRoster` still falls back to the code seed, but only when the
 * store has no roster at all — and it says so with `fromCode: true`, which the
 * callers now print rather than swallow.
 *
 * `origin` is returned so a caller can tell the reader which of the two it got.
 * "This is what your rule library says today" and "this is what it said when the
 * run was made" are different claims, and hiding the difference is how a user
 * concludes the rule switch is broken while looking at an old run.
 *
 * @returns {{origin: 'run-snapshot'|'active', version: string|null, source: string|null,
 *            count: number, fromCode: boolean, rules: Array}}
 */
export function rosterForValidation(store, run = null) {
  const snapshot = snapshotOf(run)
  if (snapshot !== null) {
    return {
      origin: 'run-snapshot',
      version: snapshot.version ?? run.rule_set_version ?? run.rules_version ?? null,
      source: snapshot.source ?? null,
      count: snapshot.rules.length,
      fromCode: snapshot.fromCode === true,
      rules: snapshot.rules,
    }
  }
  return { origin: 'active', ...loadActiveRoster(store) }
}

/**
 * One specific version's full roster — enabled *and* disabled rows — or null.
 *
 * `loadActiveRoster` returns only the enabled rules, which is what `validate`
 * needs. The page's rule table needs the disabled rows too, or a checkbox could
 * never show "off": it would render the rule as absent instead of as disabled.
 */
export function loadRosterVersion(store, version) {
  const target = String(version ?? '').trim()
  if (target === '') return null
  const set = store.get('SELECT * FROM rule_set WHERE version = ?', [target])
  if (set === undefined || set === null) return null
  const rows = store.all(
    'SELECT * FROM rule WHERE rule_set_version = ? AND deleted_at IS NULL ORDER BY sort_order, rule_id',
    [target],
  )
  return {
    version: set.version,
    source: set.source,
    note: set.note ?? null,
    isActive: set.is_active === 1,
    fromCode: false,
    count: rows.length,
    rules: rows.map(rowToRule),
  }
}

/** Every published version, newest first, with how many live rules it carries. */
export function listVersions(store) {
  return store.all(
    `SELECT s.*,
            (SELECT COUNT(*) FROM rule r
              WHERE r.rule_set_version = s.version AND r.deleted_at IS NULL) AS rule_count,
            (SELECT COUNT(*) FROM rule r
              WHERE r.rule_set_version = s.version AND r.deleted_at IS NULL AND r.enabled = 1) AS enabled_count
       FROM rule_set s
      ORDER BY s.published_at DESC, s.version DESC`,
  )
}

/** Point the active flag at one version. At most one row is ever active. */
export function activateVersion(store, version) {
  const target = String(version ?? '').trim()
  if (target === '') throw new Error('version is required')
  return store.tx(() => {
    const exists = store.get('SELECT version FROM rule_set WHERE version = ?', [target])
    if (exists === undefined || exists === null) throw new Error(`no rule set ${target}`)
    store.run('UPDATE rule_set SET is_active = 0 WHERE is_active = 1')
    store.run('UPDATE rule_set SET is_active = 1 WHERE version = ?', [target])
    return { version: target }
  })
}

/** Escape a string for use inside a `RegExp`, so a version's dots stay literal. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The root of a version lineage: the first two segments of any version. */
function versionRoot(base) {
  const parts = String(base).split('.')
  return parts.length <= 2 ? String(base) : parts.slice(0, 2).join('.')
}

/**
 * The next free sibling under the lineage root: `2026.4` → `2026.4.1` → `2026.4.2`.
 *
 * Derived from the **root**, not from the base version. Deriving from the base
 * made the base drift: publishing from `2026.4.1` produced `2026.4.1.1`, then
 * `2026.4.1.1.1` — the number grew a segment on every edit instead of counting
 * siblings, and the promised `2026.4 → 2026.4.1 → 2026.4.2` never happened.
 *
 * The root is the first two segments (`2026.4`, `2026.4.1` and `2026.4.1.1` all
 * have the root `2026.4`). Siblings are the three-segment versions under it;
 * anything deeper is a leftover from the bug and is deliberately not counted.
 */
function nextVersion(store, base) {
  const root = versionRoot(base)
  const pattern = new RegExp(`^${escapeRegExp(root)}\\.(\\d+)$`)
  const used = []
  for (const row of store.all('SELECT version FROM rule_set')) {
    const match = pattern.exec(String(row.version))
    if (match !== null) used.push(Number.parseInt(match[1], 10))
  }
  const next = used.length === 0 ? 1 : Math.max(...used) + 1
  return `${root}.${next}`
}

/**
 * Copy the base version into a brand-new version, apply `mutate`, then activate it.
 *
 * The copy takes every non-deleted row of the base — including the *disabled*
 * ones — so disabling a rule survives into the next version. Copying only the
 * enabled rows would quietly switch a rule back on the moment any other rule was
 * edited, which is the kind of resurrection nobody notices until a report
 * disagrees with itself.
 */
function publishFrom(store, baseVersion, mutate, note) {
  return store.tx(() => {
    const base = store.get('SELECT * FROM rule_set WHERE version = ?', [baseVersion])
    if (base === undefined || base === null) throw new Error(`no rule set ${baseVersion}`)
    const version = nextVersion(store, baseVersion)
    const now = nowIso()
    store.run(
      `INSERT INTO rule_set (version, name, source, effective_from, published_at, is_active, note)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [version, base.name, base.source, base.effective_from, now, note ?? null],
    )
    const rows = store.all(
      'SELECT * FROM rule WHERE rule_set_version = ? AND deleted_at IS NULL ORDER BY sort_order, rule_id',
      [baseVersion],
    )
    for (const row of rows) {
      store.run(
        `INSERT INTO rule
           (rule_set_version, rule_id, kind, applies_to_json, scope, severity, title,
            body_md, source, params_json, sort_order, enabled, deleted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          version, row.rule_id, row.kind, row.applies_to_json, row.scope, row.severity, row.title,
          row.body_md, row.source, row.params_json, row.sort_order, row.enabled, now,
        ],
      )
    }
    if (typeof mutate === 'function') mutate(version, now)
    store.run('UPDATE rule_set SET is_active = 0 WHERE is_active = 1')
    store.run('UPDATE rule_set SET is_active = 1 WHERE version = ?', [version])
    return version
  })
}

/**
 * The version an edit is based on: the caller's choice, else the active one.
 *
 * A caller may name a base explicitly (`amzn_rule_upsert` exposes it as
 * `version`); naming one that does not exist is an error rather than a silent
 * fallback, because editing "the active version" when the caller meant another is
 * exactly the surprise this parameter exists to prevent.
 */
function baseVersionFor(store, requested) {
  const wanted = String(requested ?? '').trim()
  if (wanted !== '') {
    const exists = store.get('SELECT version FROM rule_set WHERE version = ?', [wanted])
    if (exists === undefined || exists === null) throw new Error(`no rule set ${wanted}`)
    return wanted
  }
  const active = activeVersion(store)
  if (active === null) throw new Error('no active rule set to edit')
  return active
}

/**
 * Turn one rule on or off by publishing a new version.
 *
 * @returns {{version: string, ruleId: string, enabled: boolean}}
 */
export function setRuleEnabled(store, ruleId, enabled, options = {}) {
  const id = String(ruleId ?? '').trim()
  if (id === '') throw new Error('ruleId is required')
  const base = baseVersionFor(store, options.baseVersion)
  const row = store.get('SELECT rule_id FROM rule WHERE rule_set_version = ? AND rule_id = ? AND deleted_at IS NULL', [base, id])
  if (row === undefined || row === null) throw new Error(`no rule ${id} in version ${base}`)
  const flag = enabled ? 1 : 0
  const version = publishFrom(
    store,
    base,
    (next, now) => {
      store.run(
        'UPDATE rule SET enabled = ?, updated_at = ? WHERE rule_set_version = ? AND rule_id = ?',
        [flag, now, next, id],
      )
    },
    options.note ?? `规则 ${id} ${flag === 1 ? '启用' : '停用'}`,
  )
  return { version, ruleId: id, enabled: flag === 1 }
}

/** Fields `upsertRule` can change, and the column each maps to. */
const RULE_FIELDS = {
  kind: 'kind',
  title: 'title',
  severity: 'severity',
  source: 'source',
  body_md: 'body_md',
  scope: 'scope',
}

/**
 * Create or edit one rule by publishing a new version.
 *
 * The record accepts `appliesTo` (array) and `params` (object) and serialises
 * them, because a caller should not have to know the column names. A rule that
 * does not yet exist in the active version is appended with the next `sort_order`.
 *
 * @returns {{version: string, ruleId: string, created: boolean}}
 */
export function upsertRule(store, record = {}) {
  const id = String(record.ruleId ?? '').trim()
  if (id === '') throw new Error('ruleId is required')
  const base = baseVersionFor(store, record.baseVersion)
  const existing = store.get('SELECT * FROM rule WHERE rule_set_version = ? AND rule_id = ?', [base, id])
  const created = existing === undefined || existing === null

  const version = publishFrom(
    store,
    base,
    (next, now) => {
      const appliesToJson = Array.isArray(record.appliesTo) ? JSON.stringify(record.appliesTo) : null
      const paramsJson = record.params === undefined || record.params === null ? null : JSON.stringify(record.params)
      if (created) {
        const maxSort = Number(store.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM rule WHERE rule_set_version = ?', [next])?.m ?? -1)
        store.run(
          `INSERT INTO rule
             (rule_set_version, rule_id, kind, applies_to_json, scope, severity, title,
              body_md, source, params_json, sort_order, enabled, deleted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          [
            next, id,
            String(record.kind ?? 'doc'),
            appliesToJson,
            record.scope ?? 'field',
            String(record.severity ?? 'warn'),
            String(record.title ?? id),
            record.body_md ?? null,
            record.source ?? null,
            paramsJson,
            maxSort + 1,
            record.enabled === false ? 0 : 1,
            now,
          ],
        )
        return
      }
      /* COALESCE on every column: a field the caller did not mention keeps its
         value. `enabled` is converted to 0/1 up front so a boolean never reaches
         SQLite as a string. */
      const sets = []
      const params = []
      for (const [key, column] of Object.entries(RULE_FIELDS)) {
        if (record[key] === undefined) continue
        sets.push(`${column} = ?`)
        params.push(record[key])
      }
      if (appliesToJson !== null) { sets.push('applies_to_json = ?'); params.push(appliesToJson) }
      if (paramsJson !== null) { sets.push('params_json = ?'); params.push(paramsJson) }
      if (record.enabled !== undefined) { sets.push('enabled = ?'); params.push(record.enabled ? 1 : 0) }
      sets.push('updated_at = ?')
      params.push(now, next, id)
      store.run(`UPDATE rule SET ${sets.join(', ')} WHERE rule_set_version = ? AND rule_id = ?`, params)
    },
    record.note ?? `编辑规则 ${id}`,
  )
  return { version, ruleId: id, created }
}

/**
 * Import a parsed manual into a new version, as `doc` rows.
 *
 * The 72 `kind='code'` rows are carried over untouched by `publishFrom` — this
 * only ever writes rows whose id starts `doc.`. That is the whole point of the
 * import: "导入手册" must be provably unable to change a judgement, and the way to
 * prove it is that the code rows are copied byte-for-byte rather than rewritten.
 *
 * A doc row that the manual no longer has is soft-deleted (`deleted_at`), not
 * dropped, so a run that cited it still resolves. Re-importing the same manual
 * therefore changes nothing: same ids, same bodies, no new rows.
 *
 * @param {{baseVersion?: string, docs: Array, note?: string}} options
 * @returns {{version: string, count: number}}
 */
export function importDocRules(store, options = {}) {
  const docs = Array.isArray(options.docs) ? options.docs : []
  const base = baseVersionFor(store, options.baseVersion)
  const version = publishFrom(
    store,
    base,
    (next, now) => {
      const wanted = new Set(docs.map(doc => doc.id))
      for (const doc of docs) {
        const appliesToJson = doc.appliesTo === null || doc.appliesTo === undefined
          ? null
          : JSON.stringify(doc.appliesTo)
        const existing = store.get(
          'SELECT rule_id FROM rule WHERE rule_set_version = ? AND rule_id = ?',
          [next, doc.id],
        )
        if (existing === undefined || existing === null) {
          /* Docs sort after the code rules so the table reads "the checks, then
             the prose". 1000 keeps them clear of any hand-added rule. */
          store.run(
            `INSERT INTO rule
               (rule_set_version, rule_id, kind, applies_to_json, scope, severity, title,
                body_md, source, params_json, sort_order, enabled, deleted_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, NULL, ?)`,
            [
              next, doc.id, 'doc', appliesToJson, doc.scope ?? 'field',
              doc.severity ?? 'warn', String(doc.title ?? doc.id),
              doc.body_md ?? null, doc.source ?? null, 1000 + Number(doc.sortOrder ?? 0), now,
            ],
          )
          continue
        }
        store.run(
          `UPDATE rule
              SET kind = 'doc', applies_to_json = ?, scope = ?, severity = ?, title = ?,
                  body_md = ?, source = ?, sort_order = ?, deleted_at = NULL, updated_at = ?
            WHERE rule_set_version = ? AND rule_id = ?`,
          [
            appliesToJson, doc.scope ?? 'field', doc.severity ?? 'warn',
            String(doc.title ?? doc.id), doc.body_md ?? null, doc.source ?? null,
            1000 + Number(doc.sortOrder ?? 0), now, next, doc.id,
          ],
        )
      }
      /* A doc the manual dropped. Only doc rows — a code rule is never touched by
         an import, not even to delete it. */
      for (const row of store.all(
        `SELECT rule_id FROM rule WHERE rule_set_version = ? AND kind = 'doc' AND deleted_at IS NULL`,
        [next],
      )) {
        if (wanted.has(row.rule_id)) continue
        store.run(
          'UPDATE rule SET deleted_at = ?, updated_at = ? WHERE rule_set_version = ? AND rule_id = ?',
          [now, now, next, row.rule_id],
        )
      }
    },
    options.note ?? `导入手册（${docs.length} 节）`,
  )
  return { version, count: docs.length }
}

/** The live rules of one version, keyed by id. */
function rulesOf(store, version) {
  const map = new Map()
  for (const row of store.all('SELECT * FROM rule WHERE rule_set_version = ? AND deleted_at IS NULL', [version])) {
    map.set(row.rule_id, row)
  }
  return map
}

const DIFF_COLUMNS = ['kind', 'applies_to_json', 'scope', 'severity', 'title', 'body_md', 'source', 'params_json', 'sort_order', 'enabled']

/**
 * What changed between two versions: added, removed, and per-rule field changes.
 *
 * Used by the import preview (arch §B02 acceptance ④) and by anyone asking "what
 * did that edit actually do". Compares by `rule_id`, not by row, because the row
 * is keyed by version and would always differ.
 */
export function diffVersions(store, from, to) {
  const before = rulesOf(store, String(from ?? '').trim())
  const after = rulesOf(store, String(to ?? '').trim())
  const added = []
  const removed = []
  const changed = []
  for (const [id, row] of after) {
    const old = before.get(id)
    if (old === undefined) { added.push(id); continue }
    const fields = DIFF_COLUMNS.filter(column => old[column] !== row[column])
    if (fields.length > 0) changed.push({ ruleId: id, fields })
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(id)
  }
  return { from: String(from ?? ''), to: String(to ?? ''), added, removed, changed }
}
