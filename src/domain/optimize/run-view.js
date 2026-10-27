/**
 * One optimization run, resolved — and the difference between two of them.
 *
 * ## Why this is not in the page
 *
 * It started there. `describeOptimizationRun` lived in `src/web/routes.js` and was called by
 * exactly one consumer, the run panel, which is why it was private for as long as
 * it was. `amzn_report_diff` (the UI's 「轮次对比」) needs the same thing, and the
 * requirement was to *reuse* it rather than re-derive it. The two ways to reuse it
 * were an import from the tool into the web layer — which drags the whole page
 * template into the tool graph to get at one function, and inverts the layering
 * for good — or moving the function down to where both layers can read it. This
 * is the second one.
 *
 * The reason reuse is not optional: whether a field is capped in characters or in
 * bytes, whether this site's limits are verified at all, and which roster judged
 * the draft are rules of the marketplace and of the store. A second copy of those
 * rules would answer "did this field get longer?" differently from the panel, and
 * the copy that drifts is always the one nobody reads.
 *
 * ## The options come from the run, not from today
 *
 * `limitsFor` is driven by the options stored in the run's own package, so a run
 * started for JP with a category override keeps its numbers when the page is
 * opened a week later, or when the diff is run a month later. Re-deriving from
 * current defaults would silently re-judge an old run under new limits.
 *
 * ## What `diffRunViews` refuses to do
 *
 * Comparing two runs of *different ASINs* or different marketplaces is the
 * dangerous case, and it is dangerous because it succeeds: the numbers are all
 * real, the tables line up, and the answer is meaningless. So it is refused by
 * name. Two runs of the same listing where the caller passed the newer one first
 * is not an error — the arithmetic is still right — but it is reported, because a
 * diff read in the wrong direction says the opposite of what happened.
 */

import { measureDraft } from './budget.js'
import { buildGlobalPlan } from './plan.js'
import { parseJson } from './report.js'
import { runGates, validateDraft } from './validate.js'
import { limitsFor, profileFor, provisionalNote } from '../rules/marketplaces.js'
import { getListing } from '../../store/queries.js'
import { rosterForValidation } from '../../store/rules.js'
/* F13-01: the inbox projection per draft — group / context verdict / the six
   columns. **One implementation**, shared with `amzn_optimize_inbox`: the panel
   does not derive a draft's state itself, it reads what this put on the row. */
import { countViolations, draftInboxRow } from './inbox.js'

/**
 * One run, with its budgets, gates and coverage resolved.
 *
 * Resolved here rather than in the browser on purpose: whether a field is capped
 * in characters or in bytes, and whether this site's limits are verified at all,
 * are rules of the marketplace rather than display choices. Recomputing them in
 * the page would be a second copy of those rules.
 *
 * `currentContextId` and `approvalRequired` are passed in rather than looked up:
 * the first belongs to the workbench (the page's scope bar) and the second to the
 * approval policy, and neither is a property of the run. Defaulting them keeps the
 * diff tool's call site unchanged — it compares two runs and does not care which
 * scope is selected now.
 */
export function describeOptimizationRun(store, run, { currentContextId = null, approvalRequired = false } = {}) {
  const storedPackage = parseJson(run.package_json, null)
  const storedOptions = storedPackage?.options ?? {}
  const options = {
    marketplace: run.marketplace,
    category: storedOptions.category,
    maxTitleChars: storedOptions.maxTitleChars,
    maxHighlightsChars: storedOptions.maxHighlightsChars,
  }
  const limits = limitsFor(run.marketplace, options)
  const profile = profileFor(run.marketplace)
  const provisional = provisionalNote(run.marketplace)

  const fields = draftFieldsOf(run.drafts)
  const listing = getListing(store, run.asin, run.marketplace)
  const keywords = (storedPackage?.keywords ?? []).map(entry => ({
    keyword: entry.keyword,
    tier: entry.tier ?? null,
    rank: entry.rank ?? null,
  }))

  /* Judged through the same resolver `amzn_optimize_validate` and
     `amzn_optimize_save` use, so the panel cannot give a different verdict from
     the report for the same draft — the "two answers, one draft" failure. Reading
     the code constant here would do exactly that. */
  const roster = rosterForValidation(store, run)
  const validation = validateDraft({
    fields,
    listing,
    keywords,
    options,
    roster,
  })
  const plan = buildGlobalPlan({ keywords, listing, fields, validation, marketplace: run.marketplace })
  const gates = runGates({ fields, listing, keywords, validation, plan, options })
  const drafts = run.drafts.map(draft => draftInboxRow(draft, { run, currentContextId, approvalRequired }))

  return {
    id: run.id,
    asin: run.asin,
    marketplace: run.marketplace,
    status: run.status,
    summary: run.summary,
    rulesVersion: run.rules_version,
    /* F13-09：发布登记要求「草案版本必须等于该运行的当前 draft_version」
       （`tools/observe.js` 的 `amzn_publication_record`）。工作台要在**跳转过去之前**
       就把这个数字预填进表单，而它必须是从 run 行**读回来**的当前值 —— 写在链接里的
       字面量会在草案又改过之后变成一次注定被拒的登记。`draft_version` 是 v25 迁移
       加的 NOT NULL DEFAULT 0，所以这里不可能是 undefined；仍按数字兜底，
       免得一个 undefined 被读成「版本 0」。 */
    draftVersion: Number.isFinite(Number(run.draft_version)) ? Number(run.draft_version) : null,
    /* Which roster judged this run, from the verdict itself. The panel can then
       say "规则库当前版本 2026.4.3" for a live verdict and "本次运行快照 2026.4" for
       a frozen one — the difference is what tells the reader whether a rule edit
       in 规则中心 should have changed what they are looking at. */
    roster: validation.roster,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    hasReport: Boolean(run.report_md),
    counts: countRunViolations(drafts),
    /* The site the report was judged against, so the panel can show the same
       numbers the report does instead of implying they are universal. */
    profile: { code: profile.code, label: profile.label, authoritative: profile.authoritative, units: profile.units },
    provisional,
    limits,
    budgets: measureDraft(fields, options),
    gates: {
      passed: gates.passed,
      total: gates.total,
      ok: gates.ok,
      /* `what`（这道闸门判什么）与 `source`（依据哪份文档）一起带出来：F13-08 要的是
         「闸门判定面板」，而一个只有 label 与 pass 的闸门行，读者只能猜它为什么没过。
         两者都来自 `GATES` 自己（`validate.js:484-590`），这里只是把 `runGates`
         丢掉的那两个字段原样接上，不重写一句判据。 */
      rows: gates.gates.map(gate => ({
        id: gate.id,
        label: gate.label,
        what: gate.what ?? null,
        source: gate.source ?? null,
        pass: gate.pass,
        detail: gate.detail,
      })),
    },
    coverage: {
      positions: plan.positions.length,
      written: plan.writtenPositions.length,
      plannedCells: plan.coverageMatrix.summary.plannedCells,
      reachedCells: plan.coverageMatrix.summary.reachedCells,
      fillRate: plan.coverageMatrix.summary.fillRate,
      averagePlaces: plan.coverageMatrix.summary.averagePlaces,
      averagePlanned: plan.coverageMatrix.summary.averagePlanned,
      keywordsUnderfilled: plan.coverageMatrix.summary.keywordsUnderfilled,
    },
    allocationViolations: plan.allocation.violations.map(violation => ({ keyword: violation.keyword, detail: violation.detail })),
    /* F13-01: the inbox row per draft — group, context verdict, the six columns
       and the filter buckets. Projected by `draftInboxRow` so this panel and
       `amzn_optimize_inbox` cannot disagree about which group a draft is in. */
    drafts,
  }
}

/** The proposal per field — `after` when written, otherwise what is in the library. */
function draftFieldsOf(drafts) {
  const fields = {}
  for (const draft of drafts) {
    const value = draft.after ?? draft.before
    if (value === null || value === undefined || value === '') continue
    fields[draft.field] = value
  }
  return fields
}

/**
 * Block / warn totals over a run's projected drafts.
 *
 * The arithmetic itself lives in `inbox.js#countViolations` — this only sums it,
 * so the run total and the per-draft column cannot be two different countings of
 * the same violations.
 */
function countRunViolations(drafts) {
  const counts = { block: 0, warn: 0 }
  for (const draft of drafts) {
    const one = countViolations(draft.violations)
    counts.block += one.block
    counts.warn += one.warn
  }
  return counts
}

/* ─────────────────────────────── the difference ─────────────────────────────── */

/**
 * What the caller has to know before a diff means anything.
 *
 * Reads only `id`, `asin` and `marketplace`, so it accepts either the stored run
 * rows or two resolved views — which is deliberate: the guard should be able to
 * fire *before* the two runs are resolved, since resolving them is the expensive
 * half and there is no point doing it for a comparison that cannot be read.
 *
 * Returned as a refusal, not a warning, because every number in the diff below
 * would be individually correct and the comparison still worthless.
 */
export function diffGuard(from, to) {
  if (from === null || from === undefined) return 'from 的那次运行不存在。'
  if (to === null || to === undefined) return 'to 的那次运行不存在。'
  if (String(from.id) === String(to.id)) {
    return `from 和 to 是同一次运行（${String(from.id).slice(0, 8)}）—— 和它自己比，差异永远是零，那不是一个发现。`
  }
  if (String(from.asin).toUpperCase() !== String(to.asin).toUpperCase()) {
    return `两次运行的 ASIN 不同（${from.asin} → ${to.asin}），字段差异无法归属到同一个 listing，对比没有意义。`
  }
  if (String(from.marketplace).toUpperCase() !== String(to.marketplace).toUpperCase()) {
    return `两次运行的站点不同（${from.marketplace} → ${to.marketplace}），限速/字数上限/判定规则都不是同一套，差异不能当改动读。`
  }
  return null
}

/**
 * Two resolved runs, subtracted.
 *
 * Deliberately reports *three* kinds of field change rather than one: a field only
 * the newer run proposed (added), one only the older run proposed (dropped), and
 * one both proposed with different text (changed). Collapsing the first two into
 * "changed" would hide the case that matters most — a rewrite that quietly stopped
 * proposing a field the previous round wrote, which reads as "no change" and is
 * actually a regression.
 *
 * And a *fourth* list, `acceptedChanged`, for the field whose text is identical
 * but whose write state is not. That one is not a nicety: the row is stored as
 * `accepted = 1|0|NULL` rather than a boolean, and a first version of this function
 * compared the raw values — so a field going from `NULL` to `0` (undecided to
 * rejected, both meaning "not written") was reported as a change while a field
 * going from `0` to `1` was filed under "未变". Every write state below is
 * therefore normalised to a boolean, and "written" means exactly `accepted === 1`.
 * The distinction between "undecided" and "rejected" is real, but it belongs to the
 * field's own panel, not to a round-to-round summary.
 */
export function diffRunViews(from, to) {
  const written = (draft) => draft.accepted === 1
  const fromByField = new Map(from.drafts.map(draft => [draft.field, draft]))
  const toByField = new Map(to.drafts.map(draft => [draft.field, draft]))

  const added = []
  const removed = []
  const changed = []
  const unchanged = []
  const acceptedChanged = []

  for (const [field, draft] of toByField) {
    const previous = fromByField.get(field)
    if (previous === undefined) {
      added.push({ field, label: draft.label, after: draft.after, accepted: written(draft) })
      continue
    }
    if (written(previous) !== written(draft)) {
      acceptedChanged.push({
        field,
        label: draft.label,
        acceptedFrom: written(previous),
        acceptedTo: written(draft),
      })
    }
    const same = previous.after === draft.after && previous.before === draft.before
    if (same) {
      unchanged.push({ field, label: draft.label, accepted: written(draft), wasAccepted: written(previous) })
      continue
    }
    changed.push({
      field,
      label: draft.label,
      beforeFrom: previous.before,
      afterFrom: previous.after,
      beforeTo: draft.before,
      afterTo: draft.after,
      acceptedFrom: written(previous),
      acceptedTo: written(draft),
    })
  }

  for (const [field, draft] of fromByField) {
    if (toByField.has(field)) continue
    removed.push({ field, label: draft.label, after: draft.after, accepted: written(draft) })
  }

  /* Gate-by-gate, so a gate that flipped can be named instead of inferred from a
     changed pass count. Two gates flipping in opposite directions cancel out in
     the total, and the total is what a careless reader looks at. */
  const toGates = new Map(to.gates.rows.map(row => [row.id, row]))
  const flipped = []
  for (const row of from.gates.rows) {
    const now = toGates.get(row.id)
    if (now === undefined) {
      flipped.push({ id: row.id, label: row.label, from: row.pass, to: null, detail: '这次运行不再判这一项' })
      continue
    }
    if (now.pass !== row.pass) flipped.push({ id: row.id, label: row.label, from: row.pass, to: now.pass, detail: now.detail })
  }
  for (const row of to.gates.rows) {
    if (from.gates.rows.some(previous => previous.id === row.id)) continue
    flipped.push({ id: row.id, label: row.label, from: null, to: row.pass, detail: row.detail })
  }

  /* 差值只在**两边都有读数**时才算得出来。
     原来写 `to - from`：null 被当 0 参与减法（「上轮没记录、这轮 50%」会印成 −50pt 的退步），
     undefined 直接得 NaN（下游印 `NaN%`）。拿不到就是 null —— 不判读，不是「变化了」。 */
  const isReading = value => value !== null && value !== undefined && Number.isFinite(Number(value))
  const numeric = (key, label) => {
    const fromValue = from.coverage[key]
    const toValue = to.coverage[key]
    return {
      key,
      label,
      from: fromValue,
      to: toValue,
      delta: isReading(fromValue) && isReading(toValue) ? Number(toValue) - Number(fromValue) : null,
    }
  }

  return {
    sameListing: true,
    /* A diff read in the wrong direction says the opposite of what happened, and
       the run ids are not ordered in any way a reader can see. */
    backwards: Boolean(from.finishedAt && to.finishedAt && String(from.finishedAt) > String(to.finishedAt)),
    status: { from: from.status, to: to.status, changed: from.status !== to.status },
    roster: {
      from: from.roster?.version ?? null,
      to: to.roster?.version ?? null,
      changed: (from.roster?.version ?? null) !== (to.roster?.version ?? null),
    },
    counts: {
      block: { from: from.counts.block, to: to.counts.block, delta: to.counts.block - from.counts.block },
      warn: { from: from.counts.warn, to: to.counts.warn, delta: to.counts.warn - from.counts.warn },
    },
    gates: {
      passed: { from: from.gates.passed, to: to.gates.passed, delta: to.gates.passed - from.gates.passed },
      total: { from: from.gates.total, to: to.gates.total, delta: to.gates.total - from.gates.total },
      flipped,
    },
    coverage: [
      numeric('fillRate', '词覆盖率'),
      numeric('reachedCells', '已覆盖格'),
      numeric('plannedCells', '计划格'),
      numeric('written', '写入位置'),
      numeric('keywordsUnderfilled', '欠填词数'),
    ],
    drafts: { added, removed, changed, unchanged, acceptedChanged },
  }
}
