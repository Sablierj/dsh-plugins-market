/**
 * The browser collector: drive a real Chrome, read one page per ASIN, write the
 * result, stop the moment anything looks like a bot check.
 *
 * The loop is small; the interesting decisions are all about what happens when
 * things go wrong, because that is the normal case for a scraper:
 *
 *   - **Blocked means stop the whole task.** Requirement 4 of DESIGN.md §4.2.
 *     Retrying past a CAPTCHA is how an account gets flagged, and the value of
 *     the remaining ASINs is not worth that. The task ends with a `blocked`
 *     status and an honest reason, and the operator decides what to do.
 *   - **Blocked also leaves the page open, on purpose.** The operator's field
 *     knowledge is that the interception page carries a button
 *     (`Continue shopping`) which lets them carry on. `closePage` in the
 *     `finally` took that button away — measured on the real machine: after a
 *     block the window held only `about:blank`, and the verifier had to re-open
 *     the page by hand in the same profile. So the blocked tab is **kept**, and
 *     its target id, URL and the label of the control that is on it ride in the
 *     task result and in `diagnostics().blockedPage`. Nothing is clicked, nothing
 *     is retried and the site cooldown stays in force: the page is left for the
 *     person to click, which is the only thing here that is not ours to do.
 *   - **A page that renders but yields no title is a selector failure**, not a
 *     product with no title. It is counted separately and surfaced through
 *     `healthCheck`, so a DOM change shows up as "选择器失效" instead of as an
 *     empty library that looks like it worked.
 *   - **Nothing is retried.** A failed target is recorded and the loop moves on,
 *     except for a block, which ends it.
 *
 * The connection is kept between tasks on purpose: the browser stays up with
 * its profile and login state, so the next task skips the ~10s cold start. The
 * window staying open is also where the user logs into the third-party
 * platforms, so closing it after every task would be actively unhelpful.
 */

import {
  applyStorefront,
  CdpConnection,
  closePage,
  evaluate,
  humanize,
  navigate,
  openPage,
  probeVersion,
} from '../cdp/client.js'
import { ensureBrowser, findBrowser } from '../cdp/launcher.js'
import { createPacer, DEFAULT_PACING, resolvePacing } from '../pacing.js'
import { ensureStorefront, extractorForTarget, storefrontFor, supportedFields, verifyStorefront } from '../pages/index.js'
import { postalCodeFor } from '../../store/settings.js'
import { upsertAsin, upsertSnapshot } from '../../store/queries.js'
import { nowIso } from '../../store/db.js'
import { recordSectionResult } from '../../store/collection-section.js'
import { resolveReviewFamily } from '../../store/review.js'
import { ingestReviews } from '../../domain/collect/reviews-ingest.js'
import { projectCollectedAttributes } from '../../domain/collect/attribute-projection.js'
import {
  auditStoredSectionResult, buildSectionRecords, SECTION_PAGE_STATUSES,
} from '../../domain/collect/section-reading.js'
import { continueControlProbeScript } from '../../domain/collect/blocked-page.js'

const EXTRACT_WAIT_MS = 9_000

export function createBrowserCollector({
  store,
  workbench,
  logger = console,
  host = '127.0.0.1',
  port = 9333,
  profileDir,
  chromePath,
  pacing: pacingOverrides = {},
  /**
   * Where the CDP socket comes from, replaceable **for the self-check only**.
   *
   * Everything downstream of this one function is a sequence of protocol calls,
   * so replacing it replaces the browser and nothing else: the same `collect()`
   * loop runs, the same storefront switch, the same storefront verdict, the same
   * section writer. That is the only way to assert "the *collector* writes the
   * thirteen rows" without a live Chrome — and a test that called the section
   * writer itself would prove nothing about the path production takes.
   *
   * `null` means the real thing. It is not a general-purpose knob.
   */
  openConnection = null,
} = {}) {
  let connection = null

  /**
   * The storefront for one marketplace, with the **setting** applied.
   *
   * `storefrontFor` returns the site's built-in postal code, which is a sensible
   * default and the wrong answer the moment a user says "collect as 94107, not
   * 10001". Reading it directly is what made a saved `marketplace.US.postalCode`
   * silently ignored — the settings page would report the override and the
   * collector would carry on using the built-in one.
   *
   * The override is applied **here, per target**, not once at service
   * construction: the setting has to take effect on the *next task* without a
   * plugin reload (ARCHITECTURE §6, B07 acceptance ②). A `storefrontFor` call on
   * a marketplace whose postal code is null (AE) is left alone — there is
   * nothing to override and inventing one would break that dialog.
   */
  function storefrontWithSettings(marketplace) {
    const storefront = storefrontFor(marketplace)
    if (store === null || store === undefined) return storefront
    const override = postalCodeFor(store, storefront.code)
    if (override === null || override === undefined || String(override).trim() === '') return storefront
    return { ...storefront, postalCode: override, postalCodeSource: 'setting' }
  }

  /**
   * What the last run saw. `healthCheck` reads this, which is how a broken
   * selector reaches the user: the adapter reports `ok: false` with the field
   * names that stopped matching, instead of looking healthy while returning
   * nothing.
   */
  const diagnostics = {
    at: null, ok: 0, selectorMiss: 0, blocked: 0, failed: 0, storefrontMiss: 0, storefrontAdjusted: 0,
    /* T-1 / T-5：本轮计数（每轮在 collect() 里复位并写回）。没跑过时是 0，
       与「跑了、这轮没被拦」同值——所以**只有跑过一轮之后**这两个数才有意义。 */
    blockedThisRun: 0, storefrontMissThisRun: 0,
    missing: [],
    /* The blocked page we deliberately did **not** close, so a person can click
       the control on it. `null` means "this process is not holding one" — which
       is *not* the same fact as "there was no block": a plugin reload or a
       browser restart takes the page away, and the task's own result is what
       survives that. Both facts are reported, labelled, by
       `domain/collect/blocked-page.js`. */
    blockedPage: null,
    /* Sections are written on a path of their own, and a failure there must not
       change the collection's verdict. Swallowing it would be the silent-failure
       shape this repository keeps finding, so the messages are kept here and
       `healthCheck` reports them the same way it reports a missed selector. */
    sectionWrites: 0, sectionCorrections: 0, sectionErrors: [],
  }

  /** The real connection: discover a browser, handshake, keep the socket. */
  async function openRealConnection() {
    const { version } = await ensureBrowser({ host, port, profileDir, exePath: chromePath, logger })
    const wsUrl = version?.webSocketDebuggerUrl
    if (typeof wsUrl !== 'string' || wsUrl === '') {
      throw new Error(`Chrome on ${host}:${port} did not report a webSocketDebuggerUrl`)
    }
    return CdpConnection.open(wsUrl)
  }

  const connectToBrowser = openConnection ?? openRealConnection

  async function connect() {
    if (connection !== null && !connection.closed) return connection

    connection = await connectToBrowser()
    // Dropping the reference on close means the next task reconnects instead of
    // reusing a socket that will fail every call.
    connection.onClose((reason) => {
      logger?.warn?.(`[amazon-ops] CDP connection lost: ${reason}`)
      connection = null
    })
    return connection
  }

  /* ── the thirteen sections (module 04 F04-07) ─────────────────────────────── */

  /**
   * Write every section row for **one target whose page was read**.
   *
   * Called from `collect()` and nowhere else: this is the production writer
   * `collection_section_result` did not have, which is why the table was empty
   * after a successful collection on 2026-10-09 (`ok:true / written:1 /
   * selectorMiss:0`, zero rows). Before it, `recordSectionResult` was reached
   * only from tests.
   *
   * The verdict is **not** an argument. `buildSectionRecords` derives it from the
   * page verdict and from what the parser actually produced, and the row that
   * lands in the database is read back and audited against its own payload
   * (`auditStoredSectionResult`) — because a `collected` claim next to a
   * one-field payload is a row only the writer can prevent, and only a read-back
   * can catch.
   *
   * Returns a small report; the caller decides what to do with it (nothing about
   * the collection's own verdict depends on it).
   */
  function writeSectionResults({ taskId, target, raw, observedAt, schemeVersion = null, snapshotRef = null, sourceId = 'browser-local' }) {
    const id = String(taskId ?? '').trim()
    if (id === '') {
      /* Without a task id the coordinate `<taskId>:<asin>:<marketplace>:<section>`
         does not exist and the row cannot be attributed to the run that made it.
         A collection driven without a task — a channel that predates them, or a
         direct call — writes no section rows rather than inventing an owner. */
      return { written: 0, corrections: 0, error: 'no taskId; section rows skipped' }
    }

    const extractor = extractorForTarget(target)
    const sections = typeof extractor.sections === 'function' ? extractor.sections(raw, target) : null
    const records = buildSectionRecords({
      page: { status: sectionPageStatus(raw?.status), sections },
      observedAt,
      schemeVersion,
      snapshotRef,
      evidence: pageEvidence(raw),
    })

    let written = 0
    let corrections = 0
    const codes = []
    /* T69：reviews 节的样本进分析层（reviews / review_bindings —— 铁律 2 双绑定 +
       家族去重 upsert，LLD §1.5 的 ingestReviews 环节）。失败不许把一次成功的采集
       判成 error，也**不静默吞** —— 进 report 与 codes，由调用方/诊断看得到。
       parentAsin 按「变体父否则自身」解析（store/review.js#resolveReviewFamily），
       双绑定是 fail-closed 的，解析不塞进 ingest 里猜。 */
    let reviewsReport = null
    const reviewsRecord = records.find(record => record.section === 'reviews'
      && record.parsedValue !== null && record.parsedValue !== undefined)
    if (reviewsRecord !== undefined) {
      try {
        reviewsReport = ingestReviews(store, {
          taskId: id,
          parentAsin: resolveReviewFamily(store, { asin: target.asin, marketplace: target.marketplace }),
          childAsin: target.asin,
          marketplace: target.marketplace,
          parsed: reviewsRecord.parsedValue,
          observedAt,
          sourceSnapshotId: snapshotRef,
        })
      } catch (error) {
        reviewsReport = { ok: false, code: error.code ?? 'INTERNAL', error: error.message }
        codes.push('REVIEWS_INGEST_FAILED')
      }
    }
    for (const record of records) {
      const stored = recordSectionResult(store, {
        taskId: id,
        asin: target.asin,
        marketplace: target.marketplace,
        ...record,
      })
      const problem = auditStoredSectionResult(stored)
      if (problem === null) {
        written += 1
        continue
      }
      codes.push(problem.code)
      /* Only an under-claim is left alone: a row that is merely pessimistic does
         not tell a reader anything false, and the drift is still named so the
         two definitions moving apart stays visible. Everything else — an
         over-claim, a row that came back empty, a section id the vocabulary does
         not know — is rewritten to match what the payload actually carries, with
         the reason in `errors_json` so the row explains its own correction. */
      if (problem.code !== 'STATUS_UNDERCLAIMED') {
        recordSectionResult(store, {
          taskId: id,
          asin: target.asin,
          marketplace: target.marketplace,
          ...record,
          status: 'partial',
          errors: [...record.errors, { code: problem.code, detail: problem.detail }],
        })
        corrections += 1
      }
    }
    return { written, corrections, codes, reviews: reviewsReport, attributes: projectAttributes(records, target, observedAt, sourceId) }
  }

  /**
   * 把这一页采到的属性投影进库（`asin_field_source` + `listing.attributes_json`）。
   *
   * 放在这里而不是任务收尾处，是因为它只依赖这一页的结果；而放在 `writeSectionResults`
   * 里面，是为了让外层的 `sectionWriteSafely` 一并兜住 —— 属性投影失败不该把一次
   * 成功的采集判成 error，也不该悄悄吞掉。
   */
  function projectAttributes(records, target, observedAt, sourceId) {
    const record = records.find(row => row.section === 'attributes'
      && (row.status === 'collected' || row.status === 'partial'))
    if (record === undefined) return null
    return projectCollectedAttributes(store, {
      asin: target.asin,
      marketplace: target.marketplace,
      parsed: record.parsedValue,
      observedAt,
      sourceId,
    })
  }

  /**
   * Run `writeSectionResults`, and never let it change the collection's verdict.
   *
   * A section row is a record *about* a collection, not part of it: a failure
   * here must not turn a successful target into `error` and must not lose the
   * ASIN that was just written. The failure is not swallowed either — it goes to
   * the workbench feed and to `diagnostics`, which `healthCheck` reports.
   */
  function sectionWriteSafely(args) {
    try {
      const report = writeSectionResults(args)
      diagnostics.sectionWrites += report.written
      diagnostics.sectionCorrections += report.corrections
      if (report.error !== undefined) diagnostics.sectionErrors.push(report.error)
      for (const code of report.codes ?? []) diagnostics.sectionErrors.push(`${args.target.asin}/${code}`)
      workbench?.record('collect:sections', {
        asin: args.target.asin,
        marketplace: args.target.marketplace,
        written: report.written,
        corrections: report.corrections,
      }, 'plugin')
      return report
    } catch (error) {
      diagnostics.sectionErrors.push(`${args.target.asin}: ${error.message}`)
      workbench?.record('collect:section-error', {
        asin: args.target.asin,
        marketplace: args.target.marketplace,
        error: error.message,
      }, 'plugin')
      logger?.warn?.(`[amazon-ops] section rows for ${args.target.asin} failed: ${error.message}`)
      return { written: 0, corrections: 0, error: error.message }
    }
  }

  /**
   * Collect one batch. Never throws for an ordinary failure — a task that
   * cannot run should record *why*, not crash the runner that owns it.
   */
  async function collect(request = {}) {
    const targets = Array.isArray(request.targets) ? request.targets : []
    const pacing = resolvePacing({ ...pacingOverrides, ...(request.options?.pacing ?? {}) })
    const sourceId = String(request.options?.sourceId ?? 'browser-local')
    const fields = resolveFields(request.fields)
    // Default on: writing a row for the wrong storefront, language or currency
    // is worse than not writing it, and it is invisible once stored.
    const strictStorefront = request.options?.strictStorefront !== false

    const startedAt = Date.now()
    /* Per-run, like the rest of `diagnostics`: a section failure from the
       previous run must not keep failing the health check after a clean one. */
    diagnostics.sectionWrites = 0
    diagnostics.sectionCorrections = 0
    diagnostics.sectionErrors = []
    const results = []
    const missingFields = new Set()
    let written = 0
    let failed = 0
    let selectorMiss = 0
    let storefrontAdjusted = 0
    /* T-1：**本轮**被风控拦过的次数。累计的 `diagnostics.blocked` 保留给诊断展示，
       但「现在能不能修」必须看本轮 —— 否则进程里被拦过一次之后，连 `mkdir` 都会被
       永久按「不绕过验证码」拒掉（消费方是 `env.js#repairRefusal`）。 */
    let blockedThisRun = 0
    let storefrontMissThisRun = 0
    let stopped = null
    let stopReason = null

    if (targets.length === 0) {
      return { ok: false, error: 'no targets', attempted: 0, written: 0, failed: 0, results: [], stopped: 'empty' }
    }

    let cdp
    try {
      cdp = await connect()
    } catch (error) {
      // No browser means no work at all, so this is a task-level failure rather
      // than fifty identical per-target ones.
      return {
        ok: false,
        error: error.message,
        attempted: 0,
        written: 0,
        failed: targets.length,
        results: [],
        stopped: 'no-browser',
        durationMs: Date.now() - startedAt,
      }
    }

    const pacer = createPacer({ pacing })

    for (const [index, target] of targets.entries()) {
      if (request.signal?.aborted === true) {
        stopped = 'cancelled'
        stopReason = '用户取消'
        break
      }

      const position = index + 1
      const label = `${target.asin}/${target.marketplace}`

      await request.onProgress?.({
        phase: 'pacing', index: position, total: targets.length, target, written, failed,
      })
      const pausedMs = await pacer.beforeNavigate(index)

      /* Whether this iteration's tab is the one the person is meant to click.
         Set on the block path only; the `finally` below reads it to decide
         whether to close the tab. It is declared **inside** the loop (not once
         outside) so a kept page can never leak into the next target's cleanup. */
      let keepPage = false
      let page = null
      try {
        const extractor = extractorForTarget(target)
        const url = extractor.urlFor(target)
        // What the storefront must be rendered as: host, language, currency.
        // Applied per target, not per task, so a task mixing marketplaces gets
        // each one right. The postal code comes through `storefrontWithSettings`
        // so a saved `marketplace.<CODE>.postalCode` wins over the built-in one.
        const storefront = storefrontWithSettings(target.marketplace)

        page = await openPage(cdp, 'about:blank')
        // Headers and the fallback cookies have to be in place *before* the
        // first request, or Amazon serves the page from whatever storefront the
        // profile last visited and the switch becomes a correction after the
        // fact — which is exactly how a German listing arrives priced in CNY.
        await applyStorefront(cdp, page.sessionId, storefront)
        await request.onProgress?.({
          phase: 'navigating', index: position, total: targets.length, target, url, pausedMs,
        })

        const nav = await navigate(cdp, page.sessionId, url, { timeoutMs: pacing.pageTimeoutMs })

        // Only now do the delivery location and the per-storefront language
        // cookie exist, because Amazon writes both into a real document. This
        // is the step that clicks the "Deliver to" dialog; see amazon-session.js
        // for why that cannot be done with a cookie.
        await request.onProgress?.({
          phase: 'storefront', index: position, total: targets.length, target,
        })
        const session = await ensureStorefront(cdp, page.sessionId, storefront, { logger })
        if (session.actions.length > 1) storefrontAdjusted += 1

        // Submitting the address dialog navigates, and it does not always come
        // back to the listing. Returning there is cheap; collecting the
        // storefront home page instead is not.
        if (!String(session.state?.url ?? '').includes(target.asin)) {
          await navigate(cdp, page.sessionId, url, { timeoutMs: pacing.pageTimeoutMs })
        }

        if (pacing.humanize) await humanize(cdp, page.sessionId)
        await pacer.afterLoad()

        const raw = await evaluate(cdp, page.sessionId, extractor.buildScript({ waitMs: EXTRACT_WAIT_MS }), {
          timeoutMs: EXTRACT_WAIT_MS + 20_000,
        })

        const status = raw?.status ?? 'unexpected'
        /* The task id and the frozen scheme version ride on the request, set by
           `runTask`. Both are needed for a section row: the id is half of the
           row's identity coordinate, and the scheme version is what the reading
           was taken under (contract §2.5). */
        const sectionContext = {
          taskId: request.options?.taskId ?? null,
          schemeVersion: request.options?.schemeVersion ?? null,
        }

        if (status === 'blocked') {
          stopped = 'blocked'
          stopReason = raw.blockReason ?? '未识别的风控页'
          diagnostics.blocked += 1
          blockedThisRun += 1
          /* Every one of the thirteen is `blocked`: the request was cut off, and
             no per-section parsing can be more precise than that. Written rather
             than skipped because "we tried this ASIN and were shut out" and "we
             never tried it" are different facts — and only the second is allowed
             to produce no rows. */
          sectionWriteSafely({
            ...sectionContext, target, raw, observedAt: nowIso(), snapshotRef: null,
          })
          const pageUrl = raw.url ?? nav.landedUrl
          /* The control the person has to click. Read off the page, never
             clicked, and allowed to fail: a probe that throws leaves the label
             `null`, which the exit text reports as "not read on this page"
             rather than by inventing the label. */
          let continueControl = null
          try {
            continueControl = await evaluate(cdp, page.sessionId, continueControlProbeScript(), {
              timeoutMs: 5_000,
            })
          } catch (error) {
            logger?.warn?.(`[amazon-ops] blocked-page control probe failed at ${label}: ${error.message}`)
          }
          const continueLabel = typeof continueControl?.label === 'string' && continueControl.label.trim() !== ''
            ? continueControl.label.trim()
            : null
          /* Kept, not closed — see the header. This is the one tab in the whole
             run that outlives its target, and the only reason it does is that a
             person has an action to take on it. */
          keepPage = true
          /* `continueSource` is kept although nothing reads it: it is the evidence
             for *why* the label is what it is (matched by the known wording, or by
             "some submit control in the CAPTCHA form"), and a person debugging an
             unusual interception page needs to know which of the two matched. */
          diagnostics.blockedPage = {
            targetId: page.targetId,
            url: pageUrl,
            continueLabel,
            continueSource: continueControl?.source ?? null,
            marketplace: target.marketplace,
            reason: stopReason,
            at: nowIso(),
          }
          results.push({
            ...target,
            status: 'blocked',
            reason: stopReason,
            url: pageUrl,
            /* The durable half of "where the button was", so the exit can still
               name the page after a restart: `compactResult` keeps the per-target
               entries as they are, and the two fields below are what the status
               tool reads. */
            pageTargetId: page.targetId,
            pageKept: true,
            continueLabel,
          })
          logger?.warn?.(`[amazon-ops] blocked at ${label}: ${stopReason} — task stopped, page kept for the operator`)
          break
        }

        if (status === 'notfound') {
          failed += 1
          /* `failed`, not `missing`: a 404 says "we got no page", it does not say
             "Amazon publishes no BSR for this product". */
          sectionWriteSafely({
            ...sectionContext, target, raw, observedAt: nowIso(), snapshotRef: null,
          })
          results.push({ ...target, status: 'notfound', reason: raw.notFoundReason ?? '页面不存在', url: raw.url ?? nav.landedUrl })
          continue
        }

        if (status !== 'ok') {
          failed += 1
          selectorMiss += 1
          for (const field of raw?.missing ?? []) missingFields.add(field)
          /* The document rendered; it just did not look like the product page the
             selectors expect. Its sections are still read, and a section that
             carried content is reported as what it is — the domain layer is the
             one that turns the *empty* ones into `failed` rather than `missing`,
             because on an unrecognised layout "we did not find it" and "it is not
             there" are not the same claim. */
          sectionWriteSafely({
            ...sectionContext, target, raw, observedAt: nowIso(), snapshotRef: null,
          })
          results.push({
            ...target, status: 'selector-miss',
            reason: raw?.reason ?? '无法从页面解析出字段',
            missing: raw?.missing ?? [],
            url: raw?.url ?? nav.landedUrl,
          })
          continue
        }

        // The page parsed. Now check it is the page that was asked for: setting
        // the storefront cookies is a request, this is the verification. A wrong
        // storefront, language or currency all produce data that looks fine and
        // is not, so nothing is written when the check fails.
        const check = verifyStorefront(raw, target)
        if (!check.ok && strictStorefront) {
          failed += 1
          diagnostics.storefrontMiss += 1
          storefrontMissThisRun += 1
          /* **No section rows here, on purpose.** The page that was read belongs
             to another storefront, so writing its readings under this target's
             coordinate would attribute one marketplace's content to another —
             exactly what this check exists to prevent. The five states have no
             word for "refused", and inventing `failed` for it would put "we could
             not read it" on the page where the truth is "we read the wrong
             marketplace and refused to keep it". The refusal is recorded where
             target verdicts live (`results`, and the task's `result_json`). */
          // Only the *blocking* problems justify the refusal. The advisory ones
          // (the DOM language attribute, the delivery location) are recorded
          // alongside but did not cause it — see verifyStorefront.
          const reasons = [...check.blocking.map(problem => problem.detail), ...session.problems]
          results.push({
            ...target,
            status: 'wrong-storefront',
            reason: reasons.join('；'),
            problems: check.problems,
            storefrontActions: session.actions,
            url: raw.url ?? nav.landedUrl,
          })
          logger?.warn?.(`[amazon-ops] ${label} rejected: ${reasons.join('；')}`)
          continue
        }

        for (const field of raw.missing ?? []) missingFields.add(field)

        const normalized = extractor.normalize(raw, target)
        const picked = pickFields(normalized, fields)

        /* One timestamp for the field provenance and the snapshot it comes from:
           this is the moment the page was read, which is the only moment anyone
           knows the values were true. A second `nowIso()` a few milliseconds
           later would leave the two records disagreeing about when we looked.
           `sourceType: 'collect'` is said out loud rather than derived, because
           this is the one path that both collects and knows the observation
           time — the distinction the trace columns exist for. */
        const observedAt = nowIso()
        const saved = upsertAsin(store, {
          ...target, ...picked, sourceId, sourceType: 'collect', observedAt,
        })
        const snapshot = upsertSnapshot(store, {
          asin: target.asin,
          marketplace: target.marketplace,
          sourceId,
          collectedAt: observedAt,
          payload: {
            url: raw.url ?? nav.landedUrl,
            pageTitle: raw.pageTitle,
            lang: raw.lang ?? null,
            // The evidence for "this really was the DE storefront": which
            // language cookie was in play, and where Amazon thinks it ships.
            langCookie: raw.langCookie ?? null,
            deliveryLocation: raw.deliveryLocation ?? null,
            storefront: { domain: storefront.domain, request: storefront.request, currency: storefront.currency },
            storefrontActions: session.actions,
            storefrontProblems: [...session.problems, ...check.problems],
            fields: picked,
            // The price as the page wrote it, next to the number it parsed to.
            // A price is the one field where a parsing mistake is invisible —
            // `12.8` looks like a price — and it is the field every report is
            // built on, so the original text is kept for auditing.
            rawPrice: raw.fields?.priceText ?? null,
            missing: raw.missing ?? [],
            matched: raw.matched ?? {},
            raw: raw.raw ?? {},
          },
        })

        /* The thirteen rows, **after** the snapshot they came from exists:
           `snapshot_ref` is the row id the section readings are pinned to, and
           writing it before the snapshot would point at a row that does not exist
           yet (or at the previous one, which would be a lie about provenance). */
        const sectionReport = sectionWriteSafely({
          ...sectionContext,
          target,
          raw,
          observedAt,
          snapshotRef: snapshot === null || snapshot === undefined ? null : String(snapshot.lastInsertRowid),
        })

        written += 1
        results.push({
          ...target,
          status: 'ok',
          created: saved.created,
          /* How many section rows this target produced. The same field name the
             task summary reports for a target, so "written: 1" (the ASIN row) and
             "sections: 13" (the readings) cannot be read as each other. */
          sections: sectionReport.written,
          fields: Object.keys(picked),
          missing: raw.missing ?? [],
          lang: raw.lang ?? null,
          langCookie: raw.langCookie ?? null,
          deliveryLocation: raw.deliveryLocation ?? null,
          problems: check.problems,
          storefrontActions: session.actions,
        })
      } catch (error) {
        failed += 1
        results.push({ ...target, status: 'error', reason: error.message })
      } finally {
        /* The blocked tab is the one exception, and it is the whole point of this
           batch: closing it left the person with `about:blank` and nothing to
           click. Every other outcome still closes its tab — a leaked tab per
           target would turn a 50-ASIN task into 50 open tabs. Pages kept earlier
           in the process lifetime are *not* closed here either: the person may be
           part-way through clicking one, and the site cooldown (60 minutes by
           default) bounds how many a run can leave behind. */
        if (page !== null && keepPage !== true) await closePage(cdp, page.targetId)
      }

      // The feed is capped and rendered in a browser panel, so only the
      // interesting ticks are pushed; the full per-target detail is in the task
      // row, which the status tool reads.
      const last = results[results.length - 1]
      if (last?.status !== 'ok' || position % 10 === 0 || position === targets.length) {
        workbench?.record('collect:progress', {
          done: position,
          total: targets.length,
          asin: target.asin,
          marketplace: target.marketplace,
          status: last?.status ?? 'unknown',
          written,
          failed,
        }, 'plugin')
      }
    }

    diagnostics.at = nowIso()
    diagnostics.ok = written
    diagnostics.selectorMiss = selectorMiss
    diagnostics.failed = failed
    diagnostics.storefrontAdjusted = storefrontAdjusted
    diagnostics.missing = [...missingFields]
    /* T-1 / T-5：**本轮**的计数写回诊断。累计的 `blocked` / `storefrontMiss` 是进程级历史，
       留给展示；这两个是「这一轮发生了什么」，修不修、判不判得看它。 */
    diagnostics.blockedThisRun = blockedThisRun
    diagnostics.storefrontMissThisRun = storefrontMissThisRun

    return {
      ok: written > 0 && stopped === null,
      attempted: results.length,
      written,
      failed,
      selectorMiss,
      /* T-5：本轮的站点不符数。原来读 `diagnostics.storefrontMiss`（进程级累计），
         于是同进程的第二次采集会把第一次的数带进本轮的 result —— 与本函数上面那句
         「counting rows afterwards cannot tell this run's from the last one's」自相矛盾。 */
      storefrontMiss: storefrontMissThisRun,
      storefrontAdjusted,
      /* How many section rows this run wrote, and whether any of them had to be
         corrected. Reported rather than inferred from the store: "the collection
         wrote 13 rows per ASIN" is the fact a reader of the task needs, and
         counting rows afterwards cannot tell this run's from the last one's. */
      sectionsWritten: diagnostics.sectionWrites,
      sectionCorrections: diagnostics.sectionCorrections,
      sectionErrors: [...diagnostics.sectionErrors],
      stopped,
      stopReason,
      results,
      missingFields: [...missingFields],
      durationMs: Date.now() - startedAt,
      pacing: describeRun(pacing),
    }
  }

  /**
   * Load one page and report everything about how it parsed, writing nothing.
   * This is the tool for "did Amazon change their DOM" — it answers with the
   * selector that matched each field and the ones that did not.
   */
  async function doctor({ asin, marketplace = 'US', fields } = {}) {
    const extractor = extractorForTarget({ asin, marketplace })
    const target = { asin: String(asin ?? '').trim().toUpperCase(), marketplace: String(marketplace).toUpperCase() }

    let url
    let storefront
    try {
      url = extractor.urlFor(target)
      /* Same override the collector applies, so the doctor reports the storefront
         a real collection would use — not the built-in one the user overrode. */
      storefront = storefrontWithSettings(target.marketplace)
    } catch (error) {
      return { ok: false, error: error.message, url: null }
    }

    let cdp
    try {
      cdp = await connect()
    } catch (error) {
      return { ok: false, error: error.message, url, storefront }
    }

    let page = null
    try {
      page = await openPage(cdp, 'about:blank')
      // The doctor applies the same storefront context the collector does, so
      // what it reports is what a real collection would get.
      await applyStorefront(cdp, page.sessionId, storefront)
      const nav = await navigate(cdp, page.sessionId, url, { timeoutMs: DEFAULT_PACING.pageTimeoutMs })

      // Including the address click. A doctor that skipped it would report a
      // clean storefront while a real collection kept rejecting targets — the
      // opposite of what this tool is for.
      const session = await ensureStorefront(cdp, page.sessionId, storefront, { logger })
      if (!String(session.state?.url ?? '').includes(target.asin)) {
        await navigate(cdp, page.sessionId, url, { timeoutMs: DEFAULT_PACING.pageTimeoutMs })
      }

      const raw = await evaluate(cdp, page.sessionId, extractor.buildScript({ waitMs: EXTRACT_WAIT_MS }), {
        timeoutMs: EXTRACT_WAIT_MS + 20_000,
      })

      const check = verifyStorefront(raw ?? {}, target)
      /* On a block, read the control the person has to click — **before** the
         `finally` closes this tab. The doctor deliberately closes its own tab
         (it is a probe: it writes nothing and leaves nothing behind), so what it
         can hand over is the URL plus the label that was on the page, which is
         how the real-machine verification got past the block by hand. */
      let continueControl = null
      if (raw?.status === 'blocked') {
        try {
          continueControl = await evaluate(cdp, page.sessionId, continueControlProbeScript(), { timeoutMs: 5_000 })
        } catch (error) {
          logger?.warn?.(`[amazon-ops] blocked-page control probe failed in doctor: ${error.message}`)
        }
      }
      return {
        ok: raw?.status === 'ok' && check.ok,
        url: raw?.url ?? nav.landedUrl,
        requestedUrl: url,
        redirected: (raw?.url ?? nav.landedUrl) !== url,
        pageTitle: raw?.pageTitle ?? null,
        lang: raw?.lang ?? null,
        langCookie: raw?.langCookie ?? null,
        deliveryLocation: raw?.deliveryLocation ?? null,
        status: raw?.status ?? 'unexpected',
        reason: raw?.reason ?? raw?.blockReason ?? raw?.notFoundReason ?? null,
        /* Null means "not read on this page", which the exit reports in words
           rather than by inventing a label. */
        continueLabel: typeof continueControl?.label === 'string' && continueControl.label.trim() !== ''
          ? continueControl.label.trim()
          : null,
        waitedMs: raw?.waitedMs ?? null,
        matched: raw?.matched ?? {},
        missing: raw?.missing ?? [],
        fields: extractor.normalize(raw ?? {}, target),
        extractor: extractor.id,
        storefront,
        storefrontSession: session,
        storefrontCheck: check,
        requestedFields: resolveFields(fields),
        supportedFields: supportedFields(),
      }
    } catch (error) {
      return { ok: false, error: error.message, url, requestedUrl: url, storefront }
    } finally {
      if (page !== null) await closePage(cdp, page.targetId)
    }
  }

  /**
   * The adapter's `healthCheck`, wired to real state rather than a ping.
   *
   * The judgement it has to make is "did Amazon change their page", and the two
   * signals are not equally strong:
   *
   *   - A page that rendered but had **no title** is structural. Every product
   *     page has a title, so this means the selector is gone. That is a failure.
   *   - A field that was not found is weaker evidence. A rank, a rating or a
   *     brand can genuinely be absent from a listing — verified against a live
   *     accessory page with no Best Sellers Rank anywhere on it. Reporting that
   *     as a broken selector would cry wolf until the warning meant nothing, so
   *     it is reported as information and left `ok`.
   */
  async function healthCheck() {
    const version = await probeVersion(host, port)
    if (version === null) {
      return {
        ok: false,
        /* Not a login verdict: the browser is not even running, so nothing about
           the session has been established. `unknown` is the honest answer. */
        login: 'unknown',
        detail: `采集用 Chrome 未启动（${host}:${port}）；提交采集任务时会自动拉起`
        + `${findBrowser(chromePath) === null ? '；⚠️ 未找到 Chrome/Edge 可执行文件' : ''}`,
      }
    }

    const base = `CDP ${host}:${port} — ${version.Browser ?? 'unknown browser'}`
    if (diagnostics.at === null) {
      return {
        ok: true,
        login: 'unknown',
        detail: `${base}；本次启动后还没采过，选择器未经实际验证`,
      }
    }
    if (diagnostics.selectorMiss > 0) {
      return {
        ok: false,
        /* A selector problem says nothing about the session. */
        login: 'unknown',
        detail: `${base}；上次采集(${diagnostics.at})有 ${diagnostics.selectorMiss} 个页面渲染完成但解析不出标题`
        + ' — 亚马逊很可能改了页面结构，用 amzn_collect_doctor 复查',
      }
    }
    if (diagnostics.storefrontMiss > 0) {
      return {
        ok: false,
        /* **This is the login signal.** Setting the delivery address, the
           interface language and the currency is the login-gated action: a
           session that cannot do it is not signed in to that storefront. It is
           reported as `logged_out` rather than as a plain failure because that
           is the fix the message already suggests. */
        login: 'logged_out',
        detail: `${base}；上次采集(${diagnostics.at})有 ${diagnostics.storefrontMiss} 个目标落在错误的站点/语言/币种上，已拒绝写入`
        + ' — 用 amzn_collect_doctor 看具体是哪一项不符；若配送地址改不动，先在那个 Chrome 窗口里手动登一次目标站点',
      }
    }

    const adjusted = diagnostics.storefrontAdjusted > 0
      ? `；其中 ${diagnostics.storefrontAdjusted} 个在采集前调整了配送地址/界面语言`
      : ''
    const summary = `${base}；上次采集(${diagnostics.at})成功 ${diagnostics.ok} 个${adjusted}`
    /* A collection that passed the storefront check proves the session works —
       the address change is the login-gated step, and it just succeeded. That is
       evidence, not an assumption. Computed **before** the section check so that
       a bookkeeping failure does not throw away a login verdict it has no
       bearing on: "the write failed" says nothing about whether we are signed
       in. */
    const login = diagnostics.ok > 0 ? 'logged_in' : 'unknown'
    /* A section row that could not be written (or had to be corrected) is a
       failure of this plugin's own bookkeeping, not of the page — and it is
       exactly the failure that is invisible afterwards, because the 13-section
       page just looks empty. Reported before the "which fields were missing"
       note for that reason: an empty section table with a healthy-looking
       collection is the defect this writer exists to remove. */
    if (diagnostics.sectionErrors.length > 0) {
      return {
        ok: false,
        login,
        detail: `${summary}；13 节写入有 ${diagnostics.sectionErrors.length} 处问题: `
          + diagnostics.sectionErrors.slice(0, 5).join('; '),
      }
    }
    if (diagnostics.missing.length > 0) {
      return {
        ok: true,
        login,
        detail: `${summary}；未采到的字段: ${diagnostics.missing.join(', ')}`
        + '（商品本身可能就没有，例如没有排名的商品；用 amzn_collect_doctor 复查可区分）',
      }
    }
    return { ok: true, login, detail: `${summary}，选择器全部命中` }
  }

  /**
   * Run `fn(cdp, page)` on a fresh tab.
   *
   * Keyword discovery and keyword scans need a page too, and they must share
   * this browser: it is the one holding the login and the already-corrected
   * delivery address. Opening a second browser would pay the storefront-switch
   * cost again and, worse, would be a second session Amazon can correlate.
   *
   * The tab is always closed, including on failure — a leaked tab per keyword
   * would turn a 60-keyword scan into 60 open tabs.
   */
  async function withPage(fn) {
    const cdp = await connect()
    const page = await openPage(cdp)
    try {
      return await fn(cdp, page)
    } finally {
      try {
        await closePage(cdp, page.targetId)
      } catch {
        // A tab that already died with a navigation is not worth reporting.
      }
    }
  }

  return {
    id: 'browser-local',
    host,
    port,
    profileDir,
    /* Exposed so the environment check asks the launcher about the **configured**
       executable rather than doing its own discovery — an operator's `chromePath`
       that the check ignored would report a browser that is not the one this
       collector drives. */
    chromePath,
    collect,
    doctor,
    healthCheck,
    withPage,
    pacing: resolvePacing(pacingOverrides),
    diagnostics: () => ({
      ...diagnostics,
      missing: [...diagnostics.missing],
      /* Copied out, not aliased: `blockedPage` is the record of where a person
         has to click, and a caller holding a reference into live diagnostics
         could watch it change under them. */
      blockedPage: diagnostics.blockedPage === null ? null : { ...diagnostics.blockedPage },
    }),
    /** Close the socket but leave the browser running, so the profile survives. */
    close() {
      connection?.close()
      connection = null
    },
    get connected() {
      return connection !== null && !connection.closed
    },
  }
}

/** Keep only the requested fields, and say which requested fields are unavailable. */
export function resolveFields(requested) {
  const supported = new Set(supportedFields())
  if (!Array.isArray(requested) || requested.length === 0) return [...supported]
  const wanted = requested.map(String).filter(field => supported.has(field))
  return wanted.length > 0 ? [...new Set(wanted)] : [...supported]
}

function pickFields(normalized, fields) {
  const picked = {}
  for (const field of fields) {
    const value = normalized[field]
    if (value !== undefined && value !== null) picked[field] = value
  }
  return picked
}

/**
 * The page verdict, in the section vocabulary.
 *
 * The collector's per-target statuses (`ok` / `blocked` / `notfound` /
 * `selector-miss` / `wrong-storefront` / `error`) and `SECTION_PAGE_STATUSES`
 * are two different lists on purpose: the first describes what happened to the
 * ASIN row, the second what happened to one page reading. The four page verdicts
 * line up; anything else (an extractor that invented a status, a `null` from an
 * old build) is `unexpected` — "the page rendered but we could not classify it",
 * which is the honest bucket and the one the domain layer turns into `failed`
 * for every section it could not fill.
 */
function sectionPageStatus(status) {
  const value = String(status ?? '').trim()
  return SECTION_PAGE_STATUSES.includes(value) ? value : 'unexpected'
}

/**
 * The little that is known about a page that produced no usable reading.
 *
 * It becomes the `raw_value_json` of a `blocked` / `notfound` row, because "what
 * did we see" must not be an empty cell even when the answer is "a CAPTCHA".
 * Clipped, and **never the page's own field values**: this is evidence about the
 * attempt, not a second, unverified copy of the listing.
 */
function pageEvidence(raw) {
  if (raw === null || raw === undefined) return null
  const clip = (value, limit = 300) => {
    if (value === null || value === undefined) return null
    const text = String(value)
    return text.length > limit ? text.slice(0, limit) : text
  }
  return {
    url: clip(raw.url, 500),
    pageTitle: clip(raw.pageTitle),
    status: raw.status ?? null,
    reason: clip(raw.reason ?? raw.blockReason ?? raw.notFoundReason ?? null, 500),
    lang: raw.lang ?? null,
    langCookie: raw.langCookie ?? null,
    deliveryLocation: clip(raw.deliveryLocation),
    waitedMs: Number.isFinite(Number(raw.waitedMs)) ? Math.trunc(Number(raw.waitedMs)) : null,
  }
}

/** What the pacing settings resolved to, so the task row can explain its runtime. */
function describeRun(pacing) {
  return {
    perTaskMax: pacing.perTaskMax,
    humanize: pacing.humanize,
    beforeNavigateMs: pacing.beforeNavigateMs,
    afterLoadMs: pacing.afterLoadMs,
    longBreakEvery: pacing.longBreakEvery,
    longBreakMs: pacing.longBreakMs,
  }
}
