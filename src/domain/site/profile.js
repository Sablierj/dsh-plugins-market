/**
 * A site's dossier, as one object the page can draw.
 *
 * This is a **projection**, and that word is doing work. Everything factual here
 * — the domain, the language, the currency, the units, the title cap — is read
 * from `marketplaces.js` on every call. Nothing is cached and nothing is stored,
 * so there is exactly one place those numbers can be wrong, and it is the file
 * that cites the manual for them.
 *
 * ## The three rule states, and why they are derived rather than stored
 *
 *   - `authoritative` — the rule source states its own scope covers this site.
 *     Today: US and CA, because the manual says 「适用: 北美站」.
 *   - `provisional` — the site is known, but nobody has verified its rules. The
 *     Amazon-wide numbers are applied and the page says so.
 *   - `unsupported` — the site is not in the registry at all. Applying the
 *     general numbers to it and calling it verified would be a confident answer
 *     about a rule set nobody has looked at, which is worse than saying so.
 *
 * Storing this would create a second answer to "is this site's rule set
 * verified", and the first time the two disagreed, nothing would say which one
 * the report used.
 *
 * ## `needsReverify` is deliberately strict
 *
 * It is true whenever the newest verification is not from *today*. For the two
 * seeded rows that means it is always true, and that is the intended reading:
 * a manual that says it was updated months ago is not a fresh verification, and
 * the seeded actor is a self-report rather than a person checking. A flag that
 * only lit up after some threshold would be a threshold nobody has evidence for.
 */

import { GLOBAL_LIMITS, limitsFor, profileFor } from '../rules/marketplaces.js'
import { isSeedVerification } from '../../store/site.js'

/** The three values `ruleState` can take. Exhaustive on purpose. */
export const RULE_STATES = ['authoritative', 'provisional', 'unsupported']

/** `YYYY-MM-DD`, the granularity the comparison below is made at. */
function dayOf(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

/**
 * One site's dossier.
 *
 * `verifications` are the rows from `site_verification` (newest first or not —
 * this sorts). `localization` is the stored preference object, or null.
 *
 * The returned `code` is the code the caller asked about, not the code the
 * profile fell back to: an unsupported site must be shown *as the site that was
 * asked for*, otherwise the page would print `US` for a query about `ZZ` and the
 * reader would have no way to tell the answer was about a different country.
 */
export function siteProfileView(code, { verifications = [], localization = null, now = new Date() } = {}) {
  const requested = String(code ?? '').trim().toUpperCase()
  const profile = profileFor(requested)
  const limits = limitsFor(requested)

  /* `collectible`, not `recognised`: the question is "is this a site we know
     about", and `MARKETPLACES` is the registry that answers it. The two lists are
     kept in sync by assertion (marketplaces.js), so this also means the three
     states below cover every site the collector can drive. */
  const ruleState = profile.authoritative
    ? 'authoritative'
    : (profile.collectible ? 'provisional' : 'unsupported')

  const sorted = [...verifications]
    .filter(row => row?.verified_at)
    .sort((a, b) => String(b.verified_at).localeCompare(String(a.verified_at)))
  const newest = sorted[0] ?? null
  const lastVerifiedAt = newest?.verified_at ?? null
  const today = dayOf(now)

  return {
    code: requested === '' ? profile.code : requested,
    label: profile.label,
    domain: profile.domain,
    language: profile.language,
    currency: profile.currency,
    units: limits.units,
    /* `limitsFor`, never `profileFor(code).titleMax` — the profile carries the
       site's identity and the limits are a separate lookup. Reading the wrong one
       yields `undefined`, which renders as a blank cell that looks like "this
       site has no title cap". */
    titleMax: limits.titleMax,
    titleMaxApparel: limits.titleMaxApparel,
    ruleState,
    ruleSource: profile.ruleSource ?? null,
    lastVerifiedAt,
    /* Who says so, and whether that someone is a person. The page has to be able
       to draw the seed rows differently, and it must not have to guess from the
       note text. */
    lastVerifiedBy: newest?.verified_by ?? null,
    lastVerificationIsSeed: isSeedVerification(newest),
    verificationCount: sorted.length,
    needsReverify: lastVerifiedAt === null || dayOf(lastVerifiedAt) !== today,
    localization: localization ?? null,
    /** The Amazon-wide numbers a provisional site is being judged against. */
    globalTitleMax: GLOBAL_LIMITS.titleMax,
  }
}
