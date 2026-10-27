/**
 * The rule registry: reconnecting a stored roster row to the judgement that
 * decides it.
 *
 * A roster row is data — `{ id, kind, appliesTo, scope, severity, title, source,
 * params }` — and a judgement is code. This module is the one place the two meet,
 * so `validate` never has to know whether a rule came from the code constant
 * (`RULES`, which carries its own `check`) or from the store (which does not).
 *
 * Three ways a rule can be judged, in priority order:
 *
 *   1. **It carries its own `check`.** That is the `RULES` seed and any caller
 *      that still passes the constant. Kept first so nothing about the existing
 *      path changes.
 *   2. **`CHECKS[id]`.** The stored case: a `kind='code'` row names an
 *      implementation that lives in `listing-rules.js`.
 *   3. **`genericCheck`.** A `kind='lexicon'` / `'threshold'` row is judged from
 *      its own `params` — the user-authored rules, which need no engineer.
 *
 * A `kind='code'` row that resolves to none of these is **not a pass**. It is
 * reported by name (`rule-check-missing`), because a rule that never ran reading
 * as a rule that passed is how "6/6 通过" becomes a lie (DESIGN §5.12, arch §3.4).
 */

import { CHECKS } from './listing-rules.js'

/**
 * `params` of a rule, from either shape.
 *
 * A stored row carries `params_json` (a string, because that is what SQLite
 * holds); a hand-built rule carries `params` (an object). Both are accepted so a
 * caller never has to pre-parse, and a malformed string degrades to `{}` rather
 * than throwing inside the validation loop.
 */
function paramsOf(rule) {
  if (rule?.params !== null && typeof rule?.params === 'object') return rule.params
  const raw = rule?.params_json ?? rule?.paramsJson
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * The judgement for a rule, or `null` when there is none to be had here.
 *
 * Returns `{ check, notApplicable }` — the same pair `validate` uses for a
 * code-carried rule. `notApplicable` is `null` (not `undefined`) when absent so
 * the caller's `typeof === 'function'` test reads the same for both sources.
 *
 * @param {{id?: string, check?: Function, notApplicable?: Function}} rule
 * @returns {{check: Function, notApplicable: Function|null}|null}
 */
export function resolveCheck(rule) {
  if (rule === null || rule === undefined) return null
  if (typeof rule.check === 'function') {
    return { check: rule.check, notApplicable: typeof rule.notApplicable === 'function' ? rule.notApplicable : null }
  }
  const impl = rule.id === undefined || rule.id === null ? undefined : CHECKS[rule.id]
  if (impl === undefined || impl === null || typeof impl.check !== 'function') return null
  return { check: impl.check, notApplicable: typeof impl.notApplicable === 'function' ? impl.notApplicable : null }
}

/**
 * A judgement built from a rule's own parameters — the user-authored path.
 *
 * This is the B+ of arch §3.4: the two rule shapes a user can add from a page
 * without an engineer. Neither reads the marketplace, the lexicon or the
 * attribute registry, which is exactly why they can be data.
 *
 *   - `lexicon`   — `params.words[]`; a hit in the field is a violation.
 *   - `threshold` — `params.{min,max,unit}` compared against the field length.
 *
 * Returns `null` for any other kind, so `validate` can tell "generic judgement"
 * from "no judgement" without guessing.
 *
 * @param {{kind?: string, params?: object, params_json?: string}} rule
 * @returns {((ctx: object) => string[])|null}
 */
export function genericCheck(rule) {
  const kind = String(rule?.kind ?? '')
  const params = paramsOf(rule)

  if (kind === 'lexicon') {
    const words = Array.isArray(params.words)
      ? params.words.map(word => String(word)).filter(word => word !== '')
      : []
    if (words.length === 0) return null
    return ({ value }) => {
      const text = String(value ?? '')
      const found = words.filter(word => text.toLowerCase().includes(word.toLowerCase()))
      return found.length === 0 ? [] : [`命中禁用词: ${found.join(', ')}`]
    }
  }

  if (kind === 'threshold') {
    const min = Number.isFinite(params.min) ? params.min : null
    const max = Number.isFinite(params.max) ? params.max : null
    if (min === null && max === null) return null
    const unit = params.unit === 'bytes' ? 'bytes' : 'chars'
    return ({ value }) => {
      const text = String(value ?? '')
      const size = unit === 'bytes' ? Buffer.byteLength(text, 'utf8') : text.length
      const suffix = unit === 'bytes' ? '字节' : '字符'
      if (max !== null && size > max) return [`${size} ${suffix}，上限 ${max} ${suffix}`]
      if (min !== null && size < min) return [`${size} ${suffix}，下限 ${min} ${suffix}`]
      return []
    }
  }

  return null
}

/**
 * Rule ids that exist in the roster as `code` but have no implementation.
 *
 * The self-check arch §3.4 asks for: "roster 里每个 `kind='code'` 的 rule_id 都
 * 必须在 `CHECKS` 里存在". A non-empty result means the rule set claims to judge
 * something it cannot — the report would call it a pass.
 *
 * @param {Array} roster
 * @returns {string[]}
 */
export function missingChecks(roster) {
  return (roster ?? [])
    .filter(rule => String(rule?.kind ?? 'code') === 'code')
    .filter(rule => typeof CHECKS[rule?.id]?.check !== 'function')
    .map(rule => rule.id)
}

/**
 * The other direction: implementations the roster never mentions.
 *
 * "有判定无文档" — a function that runs for no published rule. Not a violation in
 * itself (a rule may be retired from the roster while its code stays), but it is
 * the signal that a rule was removed from the roster without anyone deciding
 * whether its judgement should go too.
 *
 * Named `orphanChecks` rather than a "…Missing" name on purpose: the manual gaps
 * (`rulesWithoutDoc` / `docsWithoutCheck`, `parse.js`) are about the *manual*, and
 * this is about the code — two different axes that were once spelled almost the
 * same and read as each other.
 *
 * @param {Array} roster
 * @returns {string[]}
 */
export function orphanChecks(roster) {
  const ids = new Set((roster ?? []).map(rule => rule?.id).filter(id => id !== undefined && id !== null))
  return Object.keys(CHECKS).filter(id => !ids.has(id))
}
