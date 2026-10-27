/**
 * The page extractors this plugin knows.
 *
 * One entry today (Amazon product pages). The list exists so the second one —
 * a 卖家精灵 dashboard, a 西柚 keyword report — is a new file plus a line here,
 * and nothing in the collector changes: the collector drives the browser and
 * hands the page to whichever extractor claims the target.
 */

import {
  amazonProduct, attributeKeyFor, locationMatches, MARKETPLACE_DOMAINS, MARKETPLACES,
  parseSectionReading, SECTION_READER_IDS, sectionReadingSpec, storefrontFor, urlFor, verifyStorefront,
} from './amazon.js'

export const EXTRACTORS = [amazonProduct]

export {
  amazonProduct, attributeKeyFor, locationMatches, MARKETPLACE_DOMAINS, MARKETPLACES,
  parseSectionReading, SECTION_READER_IDS, sectionReadingSpec, storefrontFor, urlFor, verifyStorefront,
}
export { buildSetLocationScript, ensureStorefront, readState } from './amazon-session.js'

/**
 * Pick the extractor for a target.
 *
 * With one extractor this always returns it, but it is a lookup rather than a
 * hard reference on purpose: hard-coding the import at the call site is how a
 * "single source" assumption ends up spread across five files.
 */
export function extractorForTarget() {
  return EXTRACTORS[0]
}

/** Union of every field any extractor can fill — what `amzn_source_list` reports. */
export function supportedFields() {
  return [...new Set(EXTRACTORS.flatMap(extractor => extractor.fields))]
}
