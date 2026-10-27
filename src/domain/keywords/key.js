/**
 * The canonical spelling of a keyword. Two pure functions, no dependencies.
 *
 * They live in their own module rather than in `store/kw.js` because four
 * modules need them and they sit on both sides of the store/domain line:
 * `store/kw.js`, `store/queries.js`, `domain/keywords/importers.js` and
 * `domain/keywords/export.js`. Leaving the definition in the store would have
 * forced the two domain modules to import the database layer to get a string
 * transform — a file parser has no business depending on the store. Here, every
 * caller imports "down" or sideways, and there is exactly one definition of what
 * counts as the same keyword.
 *
 * That single definition is the point of B05.1. The defect it fixes was not that
 * any one comparison was wrong; it was that several places each decided for
 * themselves, and they disagreed.
 */

/** One canonical spelling per keyword: trimmed, inner runs collapsed. */
export function normalizeKeyword(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The spelling a keyword is **stored** as — the one ruler the write path uses.
 *
 * `normalizeKeyword` (trim, collapse inner runs) plus a case fold, so
 * `Wireless Mouse`, `wireless  mouse` and `WIRELESS MOUSE` are one word and one
 * row.
 *
 * Why this exists (B05.1). Before v15 the write path kept case, so the library
 * held `B002VNJF8W` and `b002vnjf8w` as two rows — both with a `word_id` of
 * `bcb071adb0a96ac8`, because `wordId` lowercases. A table that already agrees
 * two rows are one word, and stores them as two rows anyway, is the defect the
 * fold fixes. The real data had 1028 such pairs, and not one of them was a
 * harmless duplicate: the two rows carried different ad figures and different
 * `ad_asins_json`, so each pair was two half-records of one word.
 *
 * The pairs had a specific cause, and it is worth recording because it was the
 * same mistake in miniature: the ad-report importer grouped rows by a folded key
 * but stored the raw spelling, so two report files spelling an ASIN differently
 * produced two entries. Half a fold is what produced 1028 rows.
 *
 * Folding is also what makes the existing SQL joins correct. `keywordCoverage`
 * and `queryMaster` match keywords with `=`, which is `BINARY` and therefore
 * case-sensitive; those comparisons are left alone and become correct by
 * construction once both sides are stored folded. That is why this is a storage
 * rule rather than a scatter of `COLLATE NOCASE` patches.
 *
 * It is also the truthful form: Amazon matches search terms case-insensitively,
 * so `wireless mouse` and `Wireless Mouse` are the same search. The cost is that
 * the library no longer records which spelling arrived first. That was the
 * deliberate trade — one canonical spelling per word — and a `keyword_raw`
 * column was considered and rejected: for a word written twice in two spellings
 * there is no non-arbitrary answer to "which one is the original".
 *
 * Callers that compare an **outside** string against the store (a tool argument,
 * a pasted keyword list, a search box) must fold it through here. Callers that
 * compare two strings they both read out of the store need not: those are already
 * folded, and folding them again is a no-op. That distinction is the whole
 * integration rule, and `tests/kw-key.mjs` asserts both halves of it.
 */
export function keywordKey(value) {
  return normalizeKeyword(value).toLowerCase()
}
