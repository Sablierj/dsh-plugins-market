/**
 * 「本仓没有来源」 — the sentence, said once, and the one shape of an entry that
 * says it.
 *
 * ## Why this is a module and not a string in five files
 *
 * F05-02's five remaining tabs each have at least one thing they cannot answer,
 * and every one of those things has to be said out loud rather than drawn as `0`,
 * a grey dot, or a blank cell. A blank cell reads as "there is no such column"; a
 * `0` reads as a measurement. Both are lies about the same fact, and the fact is
 * "nothing in this repository produces this".
 *
 * The word for that fact is a **label**, and a label with five spellings is five
 * different claims. So the literal lives here, the page reads it out of the
 * payload (`noSourceText`), and `health.js` re-exports it under the name it has
 * always exported (`ASIN_HEALTH_NO_SOURCE_TEXT`) so the existing B-05c assertions
 * and the page's injected constant keep working unchanged — the *name* is stable,
 * the *literal* has one home.
 *
 * ## 「没有来源」 and 「没测到」 are two different sentences
 *
 * `unsourced()` entries are **not** states of a row. A row that was never collected
 * is `state: 'never-collected'` (or `'empty'`) and its action is "go collect it".
 * An `unsourced()` entry is a structural hole — no table, no column, no writer —
 * and its action is "this cannot be answered here at all". Merging them would send
 * an operator to re-collect data that no collector reads.
 */

/** The one spelling. Compared literally by the tests and printed by the page. */
export const ASIN_NO_SOURCE_TEXT = '本仓没有来源'

/**
 * One structural hole, named with the feature point it belongs to.
 *
 * `feature` is not decoration: a reader has to be able to tell whether the hole is
 * "this batch did not get to it" (`F05-02`) or "the module that owns it does not
 * exist yet" (`F06-03` / `F06-05`). Both are holes; only the first one closes with
 * more work on this tab.
 *
 * `state: 'no-source'` is carried on the entry so the page can take its label from
 * the same vocabulary it uses for every other state — a state name that only ever
 * appears in prose is a state name that will drift.
 */
export function unsourced({ id, label, feature, reason }) {
  return {
    id: String(id),
    label: String(label),
    feature: String(feature),
    state: 'no-source',
    conclusion: ASIN_NO_SOURCE_TEXT,
    reason: String(reason),
  }
}
