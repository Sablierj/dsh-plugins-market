/**
 * Redaction for audit payloads.
 *
 * `recordAudit` stores a before value and an after value for every write. Those
 * values are rows — and some rows carry credentials (`source.config_json` holds
 * an apiKey). An audit table that stores a token in plaintext is a credential
 * leak with a timestamp on it, and it is worse than the row it copied, because
 * the audit row is never deleted.
 *
 * ## One ruler, not two
 *
 * `SECRET_KEY` and `REDACTED` are imported from `src/store/settings.js` — the
 * same two the source list already uses. This module deliberately does not
 * define its own regex or its own mask. Two rulers eventually disagree, and the
 * one that disagrees by being narrower is the one that publishes a token.
 *
 * ## Why the walk is recursive
 *
 * The shape that actually occurs is `{ config: { apiKey: '...' } }` — the secret
 * is one level down, inside a nested object, and inside an array for rows that
 * carry several of them. A top-level `Object.entries().map()` would redact
 * nothing at all here and look like it worked.
 *
 * ## Why strings that hold JSON are walked too
 *
 * A credential is not always a nested object. `source.config_json` is a TEXT
 * column holding `{"apiKey":"..."}` — from a key-based walker's point of view
 * that is one opaque string under a key named `config_json`, which is not a
 * secret-shaped name, and the token would have gone into `audit_log` verbatim.
 * This was not a hypothetical: the first run of the funnel leaked a test token
 * exactly this way.
 *
 * So a string that parses as a JSON object or array is walked as well. Two
 * things keep that from being clever-for-its-own-sake:
 *
 *   - The string is **only rewritten when something was actually masked**.
 *     A string with no credential-shaped key inside comes back byte-identical,
 *     so this cannot quietly reformat every JSON column in the log.
 *   - It stays a string. The column was a string before and after, and the
 *     audit row does not silently change the shape of the row it copied.
 *
 * ## What is not redacted
 *
 * Keys are matched, never values. A value that merely *looks* like a token
 * (a long random-looking string under a key named `note`) is left alone,
 * because redacting by value shape is how a report loses the one field the
 * reader needed, and the key name is the only thing that actually says what a
 * field is.
 */

import { REDACTED, SECRET_KEY } from '../../store/settings.js'

/** True when this key names a credential. Exported so the tests can pin it. */
export function isSecretKey(key) {
  return SECRET_KEY.test(String(key))
}

/**
 * A copy of `value` with every credential-shaped key replaced by the mask.
 *
 * Returns a new structure; the input is never mutated. Scalars come back as
 * they are — including `null` and `undefined`, which are meaningful audit
 * values ("there was no before") and must not be turned into `{}` or a mask.
 */
export function redactAuditValue(value) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(entry => redactAuditValue(entry))
  if (typeof value === 'string') return redactJsonString(value)
  if (typeof value !== 'object') return value

  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redactAuditValue(entry)
  }
  return out
}

/**
 * A JSON-in-a-string column, walked and put back — but only when the walk
 * changed something.
 *
 * Returns the original string untouched in every other case, including a string
 * that is not JSON at all (a note, a title, a selector) and a JSON string whose
 * keys are all ordinary.
 */
function redactJsonString(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return text
  const first = trimmed[0]
  if (first !== '{' && first !== '[') return text

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return text
  }
  if (parsed === null || typeof parsed !== 'object') return text

  const redacted = redactAuditValue(parsed)
  const rewritten = JSON.stringify(redacted)
  /* Unchanged means nothing was masked; returning the original keeps this from
     normalising whitespace across every JSON column in the log. */
  return rewritten === JSON.stringify(parsed) ? text : rewritten
}
