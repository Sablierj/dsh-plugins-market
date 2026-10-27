/**
 * 首次使用引导 — the three steps a new workbench walks through.
 *
 * ## The state comes from facts, never from a progress record
 *
 * There is no `onboarding.step` counter anywhere, and that is the point. A
 * stored "the user said they were done" keeps saying done after the data it was
 * about has been deleted — the freshness card goes back to 「暂无数据」 while
 * the guide still shows a tick beside it, and the reader has two contradicting
 * statements on one screen. So each step is answered by **looking**, every
 * render, at the thing the step is about:
 *
 *   1. **02 最小配置** — a workspace that is not archived, plus at least one
 *      shop or brand. The workspace row and the site profiles are seeded, so
 *      neither can tell "configured" from "fresh install"; the shop/brand
 *      declaration (S1-B03) is the part a person actually has to fill in, and
 *      it is empty on a new store.
 *   2. **首个采集/导入** — a collection task or an import. Counted from the two
 *      tables that record the act, not from a flag set when it happened.
 *   3. **健康卡激活** — at least one of the six cards came back with data. This
 *      reads the cards the page is about to draw, so the tick and the card can
 *      never disagree.
 *
 * The cost of looking is three `COUNT(*)`s on tables with indexes, once per
 * home-page poll. The cost of remembering is being wrong.
 *
 * ## 可跳步, and the consequence is stated where it bites
 *
 * Any step can be jumped to (each undone step carries the module to go do it
 * in), and the whole guide can be collapsed at any time. Both leave the six
 * health cards with nothing to compute — so when the cards are empty and a step
 * is still undone, the **cards block itself** says which step is missing and
 * why that makes it empty (`emptyCardsNote`). A block that showed a bare
 * 「暂无数据」 would be the same sentence whether the cause was a skipped step
 * or a genuinely empty dataset, and those call for different next actions.
 *
 * ## 完成后永久收起 is one setting
 *
 * `onboarding.dismissedAt` — an ISO timestamp, `null` when the guide has never
 * been collapsed. A timestamp rather than a boolean because "it is collapsed"
 * and "it was collapsed on the 3rd" are the same amount of work to store and
 * only one of them can be read later. It is declared in the settings whitelist
 * (`store/settings.js`) rather than written around it: the whitelist is what
 * makes a typo'd key a throw instead of a silent no-op, and bypassing it for
 * this one key would be the hole the whitelist exists to not have.
 *
 * Collapsed is permanent in the sense that nothing brings it back on its own;
 * clearing the setting is the deliberate way back, and the setting's own note
 * says so.
 */

import { getSetting } from '../../store/settings.js'

/** The setting that records the collapse. One name, used by the page and the tests. */
export const DISMISS_SETTING_KEY = 'onboarding.dismissedAt'

/**
 * The three steps, in order.
 *
 * `fact` is what completing the step looks like, shown under the step so the
 * reader is not asked to guess what "最小配置" means. `consequence` is what its
 * absence costs, and it is what the cards block prints — so the two are written
 * as one sentence each, not assembled from fragments.
 */
export const ONBOARDING_STEPS = [
  {
    id: 'minimal-config',
    label: '02 最小配置',
    module: 'settings',
    fact: '在 02 设置中心声明至少一个店铺或品牌',
    consequence: '没有声明「这是谁的」，采回来的数就不知道算在谁头上',
    probe({ store }) {
      const writable = store.get('SELECT COUNT(*) AS n FROM workspace WHERE archived_at IS NULL').n
      const owned = store.get('SELECT COUNT(*) AS n FROM shop').n
        + store.get('SELECT COUNT(*) AS n FROM brand').n
      return writable > 0 && owned > 0
    },
  },
  {
    id: 'first-data',
    label: '首个采集/导入',
    module: 'collect',
    fact: '采过一次数据，或导入过一次文件',
    consequence: '没有采过数据，就没有可算的分母',
    probe({ store }) {
      return store.get('SELECT COUNT(*) AS n FROM collection_task').n > 0
        || store.get('SELECT COUNT(*) AS n FROM kw_import').n > 0
    },
  },
  {
    id: 'cards-live',
    label: '健康卡激活',
    /* No module: this step is an outcome of the two above, not a place to go.
       A link here would send the reader to a page they are already looking at. */
    module: null,
    fact: '首页六张卡里至少一张算出了结论',
    consequence: '还没有任何一条数据落进这六张卡的分母',
    probe({ cards, prior }) {
      /* An outcome of the two steps above rather than a fact about the cards on
         their own. The 规则与政策 card is `ok` on a store nobody has ever
         collected from, because its denominator is the **code seed** rather than
         collected data (health.js: its own comment argues for that, and it is
         right). So "some card concluded something" on its own ticks this step on
         a fresh install, and the guide claims the pipeline ran before it did. */
      return prior.every(Boolean) && (cards ?? []).some(card => card.status === 'ok')
    },
  },
]

/** The three states a step can be in. `current` is the first one still undone. */
export const STEP_STATES = ['done', 'current', 'pending']

/**
 * The guide, as the page draws it.
 *
 * `steps` always has three entries with one of `STEP_STATES` each, so the three
 * states are distinguishable on screen rather than inferred from a count: a
 * guide that showed "1 / 3" would say how far along it is and not *which* step
 * is the current one.
 */
export function buildOnboarding({ store, cards = [] } = {}) {
  /* Walked in order rather than mapped, so a step can see how the ones before it
     came out. The third step is an outcome of the first two — it cannot be true
     while either of them is false, and the sequential walk is what makes that
     structural instead of something the probe has to re-derive. */
  const done = []
  for (const step of ONBOARDING_STEPS) {
    done.push(step.probe({ store, cards, prior: done }) === true)
  }
  const firstUndone = done.indexOf(false)

  const steps = ONBOARDING_STEPS.map((step, index) => ({
    id: step.id,
    label: step.label,
    fact: step.fact,
    consequence: step.consequence,
    module: step.module,
    done: done[index],
    state: done[index] ? 'done' : (index === firstUndone ? 'current' : 'pending'),
  }))

  const stored = getSetting(store, DISMISS_SETTING_KEY)
  const dismissedAt = typeof stored === 'string' && stored.trim() !== '' ? stored.trim() : null

  return {
    steps,
    complete: firstUndone === -1,
    dismissed: dismissedAt !== null,
    dismissedAt,
    /* The first step still undone — the one the cards block names as the cause
       of its own emptiness. */
    missingId: firstUndone === -1 ? null : steps[firstUndone].id,
  }
}

/**
 * Why some cards have no numbers, when a step is still undone.
 *
 * Returns `null` in two cases, and they are different: every step is done (an
 * empty card is then a statement about the data, and attaching a step to it
 * would invent a cause), or there is no empty card to explain.
 *
 * The second test is "**every** card is ok", not "any card is ok", and the
 * difference is not academic. The 规则与政策 card is `ok` on a store nobody has
 * ever collected from, because its denominator is the code seed rather than
 * collected data (health.js argues for that, correctly). An "any card ok" test
 * therefore silences this note on **every** install — and a cause that can never
 * be printed is not a cause, it is decoration.
 *
 * The emptiness test lives here rather than in the renderer so the sentence and
 * the condition that shows it cannot be separated: a caller that decided for
 * itself when to print this could print it over a full dashboard.
 */
export function emptyCardsNote(onboarding, cards = []) {
  const steps = onboarding?.steps
  if (!Array.isArray(steps)) return null
  const list = Array.isArray(cards) ? cards : []
  if (list.length === 0) return null
  const index = steps.findIndex(step => !step.done)
  if (index === -1) return null
  if (list.every(card => card.status === 'ok')) return null
  const step = steps[index]
  return '有卡还没有数：第 ' + (index + 1) + ' 步「' + step.label + '」还没做 —— ' + step.consequence + '。'
}
