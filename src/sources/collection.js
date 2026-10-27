/**
 * The collection task lifecycle: submit now, run in the background, report later.
 *
 * The split exists because collection is a minutes-long job and a tool call is
 * not. `amzn_collect_submit` writes a row and returns a task id immediately, so
 * the agent can go and do something else and come back to `amzn_collect_status`.
 * Blocking the turn for four minutes would burn the conversation's time budget
 * on waiting.
 *
 * Three things this module is careful about:
 *
 *   - **One task at a time.** They all share one browser window and one login,
 *     so running two concurrently would just interleave two scrapers in the same
 *     tab. Submissions queue instead of being refused: the user's intent is
 *     "collect these", and honouring it in order is more useful than an error.
 *   - **A restart must not lie.** A `running` row with no process behind it is
 *     marked failed on startup; a `queued` row is re-enqueued, because dropping
 *     work the user asked for would be the wrong kind of tidy.
 *   - **The gap between tasks is enforced here, not in the collector.** Pacing
 *     between navigations is the collector's business; the pause between two
 *     separate tasks belongs to whatever decides to start the next one.
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from '../store/db.js'
import {
  getCollectionTask,
  insertCollectionTask,
  listCollectionTasks,
  recoverStaleTasks,
  updateCollectionTask,
} from '../store/queries.js'
import { ACTIONS } from '../domain/audit/targets.js'
import { recordWorkerWrite, WORKER_NAMES } from '../domain/audit/worker.js'
import { canTransitionCollectionTask } from '../domain/states.js'
/* 目标 / 字段 / 工期的三条规则从本文件搬到了 domain：预览、发起、服务三处必须用同一把
   尺子（见 domain/collect/targets.js 的文件头）。这里只留调用点，行为一字未改。 */
import {
  estimateMinutes, normalizeTargets, validateFieldSelection,
} from '../domain/collect/targets.js'
/* 状态与历史成对写入的唯一入口（契约 §5.2）。见 src/store/collection-transition.js。 */
import { transitionCollectionTask } from '../store/collection-transition.js'
import { appendTaskEvent } from '../store/collection-task-event.js'
import { createPassThroughGate } from './browser/gate.js'
import { resolvePacing } from './pacing.js'
import { pacingSettings, getSetting } from '../store/settings.js'
import { getPlan, listPlans } from '../store/collection-plan.js'
import { SITE_COOLDOWN_DEFAULT_MINUTES, runEnvCheck, siteCooldown } from '../domain/collect/env.js'
import { previewCollection } from '../domain/collect/preview.js'
import { buildWaiting, applyWaitingSweep } from '../domain/collect/waiting.js'
import { isWindowOpen, windowState } from '../domain/collect/window.js'
import { prefillFor } from '../domain/collect/prefill.js'
import { progressView } from '../domain/collect/progress.js'
import { approvalRefusal } from '../domain/approval/policy.js'

/** Progress is written while the task runs; once a second is plenty. */
const PROGRESS_THROTTLE_MS = 1_000

/**
 * `gate` serialises the browser across *services*. This service's own queue
 * only keeps its own tasks apart; a keyword scan running at the same time would
 * still interleave in the one shared tab (see `sources/browser/gate.js`). When
 * no gate is injected the service runs one-at-a-time on its own, which is what
 * an isolated instance in a test wants.
 */
export function createCollectionService({ store, workbench, sources, logger = console, pacing: pacingOverrides, gate, collector = null, dataDir = null, chromePath = null } = {}) {
  const pacing = resolvePacing(pacingOverrides)
  const browserGate = gate ?? createPassThroughGate()

  /**
   * The pacing for a task about to run: the declared settings under the config
   * overrides.
   *
   * Read **per task**, not once at construction, because a settings change has to
   * take effect on the next task without a plugin reload (ARCHITECTURE §6, B07
   * acceptance ②). Resolving it at boot would mean the settings page reports a
   * new interval while the collector keeps using the old one until a restart —
   * the worst kind of write, one that appears to work.
   *
   * The precedence is deliberate: `config.pacing` (an operator's plugin config)
   * wins over `setting` (the in-app preference), because the config is the harder
   * statement of intent. Settings fill what the config left unset — which is why
   * this is one `resolvePacing({ ...fromSettings, ...overrides })` and not two
   * competing absolute values.
   */
  function pacingForTask() {
    if (store === null || store === undefined) return pacing
    const stored = pacingSettings(store)
    return resolvePacing({
      perTaskMax: stored.maxAsinsPerTask,
      taskGapMs: [stored.taskIntervalSec * 1000, stored.taskIntervalSec * 1000 * 1.5],
      dailyLimit: stored.dailyLimit,
      ...(pacingOverrides ?? {}),
    })
  }

  /** Task ids waiting to run, oldest first. */
  const queue = []
  /**
   * Task ids a person resumed out of `waiting_human`, in order.
   *
   * A separate list rather than an append to `queue` because the two are
   * different states: a queued task still has to be moved to `running`, while a
   * resumed one is **already** `running` (that is the state machine's only edge
   * out of `waiting_human`) and must not be transitioned twice.
   */
  const resumeQueue = []
  /**
   * Per-task pacing overrides, for the lifetime of one queued run.
   *
   * In memory on purpose: a restart fails every in-flight task (see
   * `recoverStaleTasks`), so an override that does not survive a restart can
   * never be missing when it matters. Without this map the `perTaskMax` /
   * `humanize` / `strictStorefront` arguments would be accepted and then
   * silently ignored — a promise the code does not keep.
   */
  const taskOverrides = new Map()
  let draining = false
  let active = null // { taskId, controller }
  let lastFinishedAt = 0

  /**
   * How many targets this workbench has already collected since local midnight.
   *
   * Counts **targets**, not tasks: `pacing.dailyLimit` says "每天最多采集多少条",
   * and a task of 50 ASINs is 50 rows against the cap. Read from the task table
   * rather than kept in a counter, so a restart does not reset the day's usage —
   * an in-memory counter would make the limit trivially bypassable by reloading
   * the profile, which is the opposite of what a rate limit is for.
   *
   * `submitted_at` is an ISO UTC string, so the comparison is on the first ten
   * characters against today's local date. That is a deliberate simplification:
   * a task submitted at 23:59 local counts against the local day it was submitted
   * in, which is what a person means by "today". It can be wrong by the timezone
   * offset at the boundary, and that is stated rather than hidden.
   */
  function collectedToday() {
    if (store === null || store === undefined) return 0
    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const rows = store.all(
      `SELECT targets_json FROM collection_task
       WHERE kind = 'asin' AND substr(submitted_at, 1, 10) = ?`,
      [stamp],
    )
    let total = 0
    for (const row of rows) {
      const targets = safeParse(row.targets_json, [])
      total += Array.isArray(targets) ? targets.length : 0
    }
    return total
  }

  /** Exposed so the page and a test can both ask without re-implementing it. */
  function dailyUsage() {
    const limits = pacingForTask()
    const used = collectedToday()
    return { used, limit: limits.dailyLimit, remaining: Math.max(0, limits.dailyLimit - used) }
  }

  /**
   * Bring the store's task rows in line with reality. Called once at plugin
   * startup, before anything can be submitted.
   */
  function recover() {
    // `'asin'` scopes this to collection tasks; keyword scans have their own
    // service and their own queue, and mixing them would run a keyword list
    // through the ASIN collector.
    const { interrupted, requeued, held = [] } = recoverStaleTasks(store, 'asin')
    if (interrupted.length > 0) {
      logger?.warn?.(`[amazon-ops] ${interrupted.length} collection task(s) interrupted by a restart: ${interrupted.join(', ')}`)
    }
    /* `waiting_human` rows are deliberately untouched by the recovery (their
       30-minute clock is counted from when the person first saw them), so they
       are named here instead of being left to look like rows somebody forgot. */
    if (held.length > 0) {
      logger?.info?.(`[amazon-ops] ${held.length} collection task(s) still waiting for a person: ${held.join(', ')}`)
    }
    for (const id of requeued) queue.push(id)
    if (requeued.length > 0) {
      logger?.info?.(`[amazon-ops] re-queued ${requeued.length} pending collection task(s)`)
      void drain()
    }
    return { interrupted, requeued, held }
  }

  /**
   * Validate and record a task. Throws with an actionable message rather than
   * returning `{ok:false}`, because every caller here is a tool and the tool
   * wrapper already turns a throw into a readable failure.
   *
   * One of those throws is a **refusal with a code**: a site in cooldown gets an
   * error carrying `code: 'COOLING_DOWN'` and the reading behind it. The tool
   * turns that one back into `{ok:false, code, …}` (see `amzn_collect_submit`), so
   * the two collection doors report the same refusal the same way.
   */
  function submit({ source, targets, fields = null, options = {} } = {}) {
    /* The channel the user chose on the settings page is the default, read
       **per task** for the same reason the pacing is: a change has to take
       effect on the next task without a plugin reload. An explicit `source` on
       the call still wins — the setting is a default, not an override. */
    const chosen = String(source ?? '').trim() === ''
      ? String((store === null || store === undefined ? null : getSetting(store, 'collect.defaultSource')) ?? 'browser-local')
      : String(source).trim()
    const adapter = sources.get(chosen)
    if (adapter === null) {
      const known = store.all('SELECT id FROM source ORDER BY id').map(row => row.id)
      throw new Error(`unknown source "${chosen}"; known sources: ${known.join(', ')}`)
    }
    if (adapter.collectible === false) {
      throw new Error(`source "${chosen}" is not a collection channel: ${adapter.statusNote}`)
    }
    if (adapter.status !== 'ready') {
      throw new Error(`source "${chosen}" is not connected yet: ${adapter.statusNote}`)
    }

    /* The daily cap, checked before a task is recorded rather than after it
       fails. `pacing.dailyLimit` existed in the settings table and was read by
       nothing, which is worse than not offering it: the page would show a number
       the collector ignored. A day already at its limit refuses the submission and
       says by how much — the alternative is queueing work that will never run. */
    const limits = pacingForTask()
    const usedToday = collectedToday()
    if (usedToday >= limits.dailyLimit) {
      throw new Error(
        `daily limit reached: ${usedToday} >= pacing.dailyLimit ${limits.dailyLimit}. `
        + 'Raise pacing.dailyLimit on the settings page, or wait for tomorrow (the count resets at 00:00 local).',
      )
    }

    const normalized = normalizeTargets(targets)
    if (normalized.length === 0) throw new Error('targets is empty')
    if (normalized.length > limits.perTaskMax) {
      throw new Error(
        `too many targets: ${normalized.length} > perTaskMax ${limits.perTaskMax}. `
        + 'Split it into several submissions, or raise pacing.maxAsinsPerTask on the settings page.',
      )
    }
    const validatedFields = validateFieldSelection(fields, adapter.capabilities?.().fields ?? [], { sourceId: chosen })

    /* ── the site cooldown, judged **at submission**, on this door too ─────────
       `submitCollectionTask` (the `amzn_collect_run` path) refuses a cooling site
       with `COOLING_DOWN`; this door is what `amzn_collect_submit` calls, and it
       used to record the task and start it anyway — so the one-hour protection a
       block installs could be walked around by choosing the lower-level tool
       (T-01's own known boundary, logged as `docs/COORDINATION.md` §7.4 item ②).

       Two decisions, and both are load-bearing:

       · **It is judged here, not in the runner.** The runner (`runTask`) has no
         release pass for a *site-wide* cooldown: a task parked there waits for a
         person, so holding one would turn "the site is cooling" into "every task
         this process queued for that site is dead", including tasks that never met
         the block. T-01 removed exactly that, and re-adding it would redden seven
         assertions about unrelated tasks. A refusal at submission is a code the
         caller can act on; a hold at start is a dead end.
       · **Every marketplace in the submission is checked, not just the first.**
         `submitCollectionTask` reads `preview.marketplace` (the first target's
         site, or the explicit argument), so a mixed batch could still run US
         targets while US was cooling. The honest rule for a list is "refuse if any
         target's site is cooling", and the refusal names the sites.

       `siteCooldown` is the same reader the full path, the preview and 体检项
       10-cooldown use (contract §5.3-3) — one rule, four readers. */
    const sites = [...new Set(normalized.map(target => String(target.marketplace ?? 'US').trim().toUpperCase()))]
    const cooling = sites
      .map(site => ({ site, state: siteCooldown(store, site) }))
      .filter(entry => entry.state.active === true)
    if (cooling.length > 0) {
      const described = cooling.map(entry => `${entry.site}（至 ${entry.state.until}`
        + `${entry.state.minutesRemaining === null ? '' : `，还剩约 ${entry.state.minutesRemaining} 分钟`}）`).join('、')
      const error = new Error(
        `${described} 站点在冷却期内：这次提交被拒，一个目标都没入队，code COOLING_DOWN。`
        + '等冷却结束再提交；本插件不会替你清掉冷却，也没有「立即重跑」这条路'
        + '（刚被拦就连着重跑，是账号被更严风控盯上的典型路径）。',
      )
      /* The code rides on the error so the tool can hand back the same shape the
         full path returns. `status`/`cooling` carry the reading itself, because
         "被拒" without "直到什么时候" is the sentence that makes a person retry. */
      error.code = 'COOLING_DOWN'
      error.status = 'cooling_down'
      error.cooling = cooling.map(entry => ({
        marketplace: entry.site, until: entry.state.until, minutesRemaining: entry.state.minutesRemaining,
      }))
      error.hint = '等冷却结束（见上面每个站点的截止时刻）再提交，或先用 amzn_collect_env_check 的 10-cooldown 项看实时读数'
      throw error
    }

    const id = randomUUID()
    insertCollectionTask(store, {
      id,
      sourceId: chosen,
      targets: normalized,
      fields: validatedFields,
    })

    workbench?.record('collect:queued', {
      taskId: id,
      source: chosen,
      total: normalized.length,
      queueDepth: queue.length + (active === null ? 0 : 1),
    }, 'plugin')

    queue.push(id)
    void drain()

    return {
      taskId: id,
      source: chosen,
      targets: normalized,
      total: normalized.length,
      perTaskMax: limits.perTaskMax,
      status: 'queued',
      estimatedMinutes: estimateMinutes(normalized.length, limits),
    }
  }

  /** Run queued tasks one after another until the queue is empty. */
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0 || resumeQueue.length > 0) {
        const resuming = queue.length === 0
        const taskId = resuming ? resumeQueue.shift() : queue.shift()
        const task = getCollectionTask(store, taskId)
        // A task cancelled while queued has already been marked; skip it.
        if (task === undefined) continue
        /* A resumed task is already `running` (that is the edge out of
           `waiting_human`); a queued one must still be `queued`. Anything else
           was moved behind our back — most likely cancelled — and must not run. */
        if (resuming ? task.status !== 'running' : task.status !== 'queued') continue
        await runTask(task, { resuming })
      }
    } catch (error) {
      logger?.error?.(`[amazon-ops] collection runner failed: ${error.stack ?? error.message}`)
    } finally {
      draining = false
    }
  }

  /**
   * The last gate before a task is allowed to start: **this task's own cooldown
   * deadline**, judged at start time rather than at submission time (T-01).
   *
   * `recoverStaleTasks` hands a `cooling_down` row back to `queued` — that is the
   * exit the contract gives that state (§5.5) and it is also what puts the row
   * back in front of the runner — and the row keeps the `risk_json.cooldownUntil`
   * it was parked with. So the restart is exactly the moment a cooldown can be
   * lost: on main nothing re-read that field, and the live event log shows the
   * result — `cooling_down → queued` with 52 minutes of cooldown left, then
   * `queued → running` 0.002 s later. This is the re-check.
   *
   * It reads the **task's own deadline and nothing else**, for three reasons:
   *
   *   · The own deadline is the fact the restart carried over, and it is a plain
   *     countdown: a deadline that has passed is passed, so no task can be held
   *     by its own record forever.
   *   · `siteCooldown()` looks back over the newest `risk_json` row for the site,
   *     which **is this task's own row** the moment it is parked — asking it here
   *     is the task's verdict echoing back at itself.
   *   · The site-wide rule belongs to the **submit** path (contract §5.3-4,
   *     `submitCollectionTask`), where a refusal is a `COOLING_DOWN` code the
   *     caller can act on. The runner has no release pass for a site cooldown, so
   *     a site-wide block here would turn "the site is cooling" into "every task
   *     this process queued for that site is dead" — including tasks that never
   *     met the block themselves and carry no deadline at all.
   *
   * Returns `{ until, minutesRemaining }` while the task must wait, `null` when
   * it may run.
   */
  function cooldownBlockingStart(task) {
    if (store === null || store === undefined) return null
    const risk = safeParse(task.risk_json, null)
    const until = typeof risk?.cooldownUntil === 'string' && Number.isFinite(new Date(risk.cooldownUntil).getTime())
      ? risk.cooldownUntil
      : null
    if (until === null) return null
    const remainingMs = new Date(until).getTime() - Date.now()
    /* Expired is expired: no release pass is needed for the task's own deadline,
       which is what keeps this gate from becoming a permanent block. */
    if (remainingMs <= 0) return null
    return { until, minutesRemaining: Math.ceil(remainingMs / 60_000) }
  }

  /**
   * Move a task's status **and** leave a row in its history (contract §5.2).
   *
   * The pair is written by `store/collection-transition.js`, which the human
   * decisions and the timeout scan also go through: three writers and one rule
   * is the only arrangement in which "every transition is recorded" is a
   * property of the code rather than of three authors' memories.
   */
  function transition(taskId, fromStatus, toStatus, options = {}) {
    return transitionCollectionTask(store, { taskId, fromStatus, toStatus, ...options })
  }

  /**
   * The site-level cooldown a blocked run leaves behind (contract §5.3-3).
   *
   * `risk_json` is what the **next submission** for the same marketplace reads,
   * so a captcha does not turn into three more captchas: the run ends where it
   * ended, and the site is declared cooling for a bounded time. `null` when
   * nothing was blocked, because an empty risk object on every task would make
   * "was this blocked" unanswerable.
   */
  function blockedRisk(result, cooldownMinutes) {
    const blocked = result?.stopped === 'blocked'
      || (result?.results ?? []).some(entry => entry?.status === 'blocked')
    if (!blocked) return null
    const minutes = Number.isFinite(Number(cooldownMinutes)) && Number(cooldownMinutes) >= 0
      ? Math.trunc(Number(cooldownMinutes))
      : SITE_COOLDOWN_DEFAULT_MINUTES
    const since = new Date()
    return {
      level: 'high',
      reasons: [result?.stopReason ?? '站点风控拦截'],
      since: since.toISOString(),
      cooldownMinutes: minutes,
      cooldownUntil: new Date(since.getTime() + minutes * 60_000).toISOString(),
    }
  }

  async function runTask(task, { resuming = false } = {}) {
    const taskId = task.id
    const adapter = sources.get(task.source_id)
    const targets = safeParse(task.targets_json, [])
    const fields = task.fields_json === null ? null : safeParse(task.fields_json, null)

    /* The pacing this task actually runs under, read now rather than at boot.
       Both the inter-task gap and the browser's own delays come from here, so a
       change made on the settings page applies to this task and not to some
       later restart. Per-task overrides handed in at submission ride on top and
       are consumed once — they belong to this run, not to the task's row. */
    const overrides = taskOverrides.get(taskId) ?? {}
    taskOverrides.delete(taskId)
    const limits = { ...pacingForTask(), ...overrides }

    // Spacing between tasks, so a queue of submissions does not become one long
    // uninterrupted burst.
    const gap = lastFinishedAt === 0 ? 0 : Math.max(0, lastFinishedAt + randomBetween(limits.taskGapMs) - Date.now())
    if (gap > 0) await sleep(gap)

    /* The cooldown re-check, **at start time** (T-01): `recoverStaleTasks` puts a
       `cooling_down` row back in front of the runner and the row still carries
       the deadline it was parked with, so this is the last place the cooldown can
       be served. It runs after the inter-task gap (also a wait the cooldown may
       expire during) and before anything touches the browser.

       The hold **does not move the status**, and that is forced by the state
       machine rather than chosen: the only edges out of `queued` are
       `checking_env` and `cancelled` (contract §5.2, pinned by B04-⑩), so there
       is no legal way to park a queued task in `cooling_down` — writing that
       status anyway would put a transition in the history that §5.2 says cannot
       happen, and `appendTaskEvent`'s own charter is to record moves, not to
       validate them. So the row stays `queued` — work the user asked for, and
       what `recover()` hands back to the runner at the next startup (§5.5) —
       the reason goes onto the row **and** into its history, and the id is
       dropped from this process's in-memory queue so the pass terminates. What
       must never happen is the silent version of this: `queued` with nothing
       saying why it is not running. */
    if (resuming !== true) {
      const cooling = cooldownBlockingStart(task)
      if (cooling !== null) {
        const heldReason = `本任务冷却未过（至 ${cooling.until}，还剩 ${cooling.minutesRemaining} 分钟），未开跑，留在队列`
        /* The reason goes on the row as well as into the history, and that is not
           belt-and-braces: the two surfaces a person actually reads render
           `error` and not the event stream — the workbench's 备注 column
           (`web/page.js` renderTasks) and `amzn_collect_status`'s 「错误:」 line —
           and the event stream has no production reader yet (it is on the
           orphan list). `runTask`'s `queued → running` patch clears `error`, so
           the note disappears the moment the task really does start. */
        updateCollectionTask(store, taskId, { error: heldReason })
        appendTaskEvent(store, {
          taskId,
          fromStatus: 'queued',
          toStatus: 'queued',
          reason: heldReason,
          source: 'plugin',
          evidence: { cooldownUntil: cooling.until, minutesRemaining: cooling.minutesRemaining, gate: 'cooldownBlockingStart' },
        })
        workbench?.record('collect:queued', {
          taskId, source: task.source_id, total: targets.length,
          queueDepth: queue.length + (active === null ? 0 : 1),
          cooling: true,
        }, 'plugin')
        logger?.info?.(`[amazon-ops] collection task ${taskId} held: its own cooldown runs to ${cooling.until} (${cooling.minutesRemaining} min left)`)
        lastFinishedAt = Date.now()
        return null
      }
    }

    const controller = new AbortController()
    active = { taskId, controller }

    /* `queued → running` is a transition, so it is recorded as one: before this
       batch only `cancel()` appended history, which made the timeline of every
       task that ever completed a single line — or none at all. A **resumed**
       task is already `running` (the edge out of `waiting_human` was written by
       the resume itself), so writing it again here would record a transition
       that never happened and duplicate the row. */
    if (resuming !== true) {
      transition(taskId, task.status, 'running', {
        patch: {
          error: null,
          progress_json: JSON.stringify({ done: 0, total: targets.length, phase: 'starting', startedAt: nowIso() }),
        },
      })
    }
    workbench?.record('collect:start', { taskId, source: task.source_id, total: targets.length }, 'plugin')

    let lastProgressAt = 0
    let lastPhase = 'starting'
    const onProgress = (event) => {
      const now = Date.now()
      // Throttled, except for a phase change — those are what the page shows as
      // "navigating now", so dropping one would make the UI look stuck.
      const phaseChanged = event.phase !== lastPhase
      if (!phaseChanged && now - lastProgressAt < PROGRESS_THROTTLE_MS && event.index !== event.total) return
      lastProgressAt = now
      lastPhase = event.phase

      updateCollectionTask(store, taskId, {
        progress_json: JSON.stringify({
          done: event.index,
          total: event.total,
          phase: event.phase,
          asin: event.target?.asin ?? null,
          marketplace: event.target?.marketplace ?? null,
          written: countOrNull(event.written),
          failed: countOrNull(event.failed),
        }),
      })
    }

    try {
      /* What the store looked like **before** the adapter runs. This has to be
         read here rather than by the adapter: once the browser has written, the
         old value is gone, and "the ASIN row this collection replaced" is the
         fact an audit reader comes for. Read per target and bounded — the whole
         `getAsin` view (snapshots, provenance, up to 200 keywords) would put a
         keyword table into `before_json` for every ASIN in the task.

         A failed read is **not** a reason to refuse the collection: the write is
         the adapter's business and this is bookkeeping. It is named in the audit
         row's `reason` instead, so "there was no previous row" and "we could not
         read one" stay apart. */
      const beforeState = new Map()
      let beforeNote = null
      for (const target of targets) {
        try {
          beforeState.set(targetKey(target), readTargetState(store, target))
        } catch (error) {
          beforeNote = `前值读取失败: ${error.message}（写仍然发生，前值未知）`
        }
      }

      // The whole task's browser work runs under the shared gate: one browser,
      // one task at a time, across every service. A keyword scan submitted at
      // the same moment waits here rather than interleaving in the same tab.
      const result = await browserGate.run(() => adapter.collect({
        targets,
        fields,
        // The resolved pacing rides with the request, so the browser's own
        // per-navigation delays (and the humanize flag) come from the same
        // settings the pacer above used — one source of truth per task.
        //
        // `taskId` and `schemeVersion` ride along for the same reason: a section
        // row's identity is `<taskId>:<asin>:<marketplace>:<section>` and the
        // reading is frozen at the scheme version this task ran under. The
        // adapter could not read either off the page, so both have to be handed
        // in — and they are handed in here, where the task row is known, rather
        // than looked up by the collector (which would make the writer's
        // coordinate depend on a second read of the store).
        options: {
          sourceId: task.source_id,
          taskId,
          schemeVersion: task.scheme_version ?? null,
          pacing: limits,
        },
        onProgress,
        signal: controller.signal,
      }))

      /* §31: the collection worker's write leaves a row of its own. Without this,
         `amzn_collect_submit`'s audit row ("a task was submitted", see
         domain/audit/targets.js) was the only trace — and a submitted task that
         is later blocked writes nothing, so the two facts must not be confused.
         These rows say what the library gained. */
      recordCollectedWrites({
        store, targets, beforeState, beforeNote, result, taskId, workbench,
      })

      const status = deriveStatus(result, targets.length)
      const failure = result.ok === false ? (result.error ?? result.stopReason ?? null) : null
      /* The cooldown duration comes from the plan that asked for this run when
         there is one, and from the default otherwise — a plan that says "cool 90
         minutes" must not be overruled by a constant in the runner. */
      const planned = task.plan_id === null || task.plan_id === undefined ? null : getPlan(store, task.plan_id)
      const risk = blockedRisk(result, planned?.cooldownMinutes)
      transition(taskId, 'running', status, {
        reason: failure ?? result.stopReason ?? null,
        evidence: { stopped: result.stopped ?? null, written: countOrNull(result.written), failed: countOrNull(result.failed) },
        patch: {
          finished_at: nowIso(),
          error: failure,
          result_json: JSON.stringify(compactResult(result)),
          progress_json: JSON.stringify({
            done: countOrNull(result.attempted),
            total: targets.length,
            phase: 'finished',
            written: countOrNull(result.written),
            failed: countOrNull(result.failed),
            stopped: result.stopped ?? null,
          }),
          ...(risk === null ? {} : { risk_json: JSON.stringify(risk) }),
        },
      })

      workbench?.record('collect:done', {
        taskId,
        status,
        written: countOrNull(result.written),
        failed: countOrNull(result.failed),
        stopped: result.stopped ?? null,
      }, 'plugin')

      return result
    } catch (error) {
      /* The run path's third exit. Same rule as the other two: the status and the
         history move together, so a crashed task is not a task whose timeline
         stops mid-sentence. */
      transition(taskId, 'running', 'failed', {
        reason: error.message,
        patch: {
          finished_at: nowIso(),
          error: error.message,
          progress_json: JSON.stringify({ done: 0, total: targets.length, phase: 'failed' }),
        },
      })
      workbench?.record('collect:done', { taskId, status: 'failed', error: error.message }, 'plugin')
      return null
    } finally {
      lastFinishedAt = Date.now()
      active = null
    }
  }

  return {
    recover,
    submit,

    /** The pacing in force right now, and how much of today's cap is used. Both
     *  read live from the store, so the page shows what the next task will obey. */
    pacing: pacingForTask,
    dailyUsage,

    /** The gate this service runs browser work through. Asserted by a test to
     *  be the *same object* the keyword service holds — see `index.js`. */
    gate: browserGate,

    status(taskId) {
      const task = getCollectionTask(store, taskId)
      if (task === undefined) {
        const recent = listCollectionTasks(store, 5)
        return {
          ok: false,
          error: `no collection task "${taskId}"`,
          hint: recent.length === 0
            ? '还没有任何采集任务。用 amzn_collect_submit 提交一个。'
            : `最近的 task id: ${recent.map(row => row.id).join(', ')}`,
        }
      }
      return { ok: true, task: hydrate(task), running: active?.taskId === task.id, queueDepth: queue.length }
    },

    list(limit = 10) {
      return {
        ok: true,
        running: active?.taskId ?? null,
        queue: [...queue],
        tasks: listCollectionTasks(store, limit).map(hydrate),
      }
    },

    /**
     * Stop a running task, or drop one that has not started.
     *
     * The state machine has the last word on what may be cancelled: the guard is
     * `canTransitionCollectionTask(status, 'cancelled')` (domain/states.js). A
     * terminal task (`done` / `cancelled`) and a finished-but-retryable one
     * (`partial` / `failed` — those are retried by submitting a **new** task, not
     * by cancelling this one) are refused with a **code** and the current status
     * (`NOT_CANCELLABLE`) instead of a sentence the caller has to parse. Every
     * state the machine does give an edge out of — `queued`, `running`, and the
     * four v36 states (`draft` / `checking_env` / `cooling_down` /
     * `waiting_human`) — can now be cancelled; before this change only `queued`
     * and the active task could be, and the other four fell through to
     * "nothing to cancel" whether or not anything was running.
     *
     * Cancelling **deletes nothing**. The section rows already written stay (the
     * section store has no delete path at all), which is what F04-06's
     * 「放弃本次（保留已采节）」 is about, and the transition is recorded in
     * `collection_task_event` rather than overwritten.
     */
    cancel(taskId, { reason = null, source = 'plugin', by = null } = {}) {
      const id = String(taskId)
      const task = getCollectionTask(store, id)
      if (task === undefined) {
        return { ok: false, code: 'TASK_NOT_FOUND', error: `no collection task "${id}"` }
      }

      if (!canTransitionCollectionTask(task.status, 'cancelled')) {
        return {
          ok: false,
          code: 'NOT_CANCELLABLE',
          status: task.status,
          error: `task ${id} is ${task.status}, nothing to cancel`,
        }
      }

      /* Wherever it is, it must not start later. Dropping it from the in-memory
         queue first is what makes this true for a task that is already `queued`
         AND sitting in the queue. */
      const at = queue.indexOf(id)
      if (at >= 0) queue.splice(at, 1)

      if (active?.taskId === id) {
        /* The row write belongs to `runTask`: its terminal write runs
           `deriveStatus`, which turns `stopped === 'cancelled'` into the status.
           Recording the transition **here** would claim a state the running task
           has not reached — an adapter that ignores the abort would finish
           normally and leave the history saying it was cancelled. `runTask`'s own
           transitions (the `queued → running` it writes on entry and the terminal
           one it writes on every exit) already carry the history, so a request
           that only asks leaves no row of its own. */
        active.controller.abort()
        return { ok: true, taskId: id, status: task.status, note: '已请求停止：当前目标采完后结束' }
      }

      const neverStarted = task.status === 'queued' || task.status === 'draft'
      const note = at >= 0 ? '已在队列中取消' : `已取消（任务处于 ${task.status}，未在运行）`
      const message = neverStarted
        ? '提交后取消，未开始执行'
        : `任务在 ${task.status} 状态被取消${reason === null || reason === undefined || String(reason).trim() === '' ? '' : `：${String(reason).trim()}`}`
      const now = nowIso()
      /* Cancelling stops what has not happened yet; it does not rewrite what has.
         So the counters already reported ride along and only the phase moves —
         overwriting `{done, total}` with zeros would say "nothing was attempted"
         about a task that was, which is the same mistake as deleting its section
         rows. A task that never started has no counters to keep. */
      const progress = safeParse(task.progress_json, null)
      const progressJson = JSON.stringify(progress === null
        ? { done: 0, total: 0, phase: 'cancelled' }
        : { ...progress, phase: 'cancelled' })

      updateCollectionTask(store, id, {
        status: 'cancelled',
        finished_at: now,
        /* `resolved_at` is the v36 column for "reached a terminal state". It is
           stamped here as well as by `transitionCollectionTask` (which the run
           path's terminal write goes through): cancelling a task that never ran —
           `queued` / `draft` / `checking_env` / `cooling_down` / `waiting_human` —
           never reaches `runTask`, so without this line "when did this end" would
           be NULL for exactly the tasks a person ended by hand. */
        resolved_at: now,
        error: message,
        progress_json: progressJson,
      })
      appendTaskEvent(store, {
        taskId: id,
        fromStatus: task.status,
        toStatus: 'cancelled',
        reason: reason === null || reason === undefined || String(reason).trim() === '' ? message : String(reason).trim(),
        source,
        by,
      })
      /* Reusing `collect:done` with `status: 'cancelled'` rather than inventing a
         kind: the workbench feed renders this one as 采集结束, and a new kind
         would show up as a raw identifier on a page this batch does not touch. */
      workbench?.record('collect:done', { taskId: id, status: 'cancelled', note }, 'plugin')

      return { ok: true, taskId: id, status: 'cancelled', note }
    },

    /**
     * The full run path — F04-03's orchestration (contract §6.2.4).
     *
     * The order is part of the contract and it is the order here:
     *
     *   1. preview (which validates the source, the targets, the fields and the
     *      scheme — the same function the panel's "跑预览" button calls, so the
     *      numbers a person approved are the numbers this acts on);
     *   2. the batch gate, then the two pacing caps;
     *   3. the task row, **before** the environment check, so the check's rows can
     *      be attached to it (F04-01 wants them per task) and so a run that parks
     *      is visible instead of vanishing;
     *   4. the environment check → `checking_env` / `waiting_human` on a blocking
     *      failure, then a closed plan window → `waiting_human`, then the site's
     *      cooldown → `cooling_down`, otherwise the queue. (The window is judged
     *      before the cooldown; see the note on that pair below.)
     *
     * A `draft` skips 4 entirely and never joins the queue: it is a form the
     * person has not committed to, and running an environment check for it would
     * make saving a draft a side effect on the environment.
     */
    async submitCollectionTask(args = {}) {
      const preview = previewCollection({ store, sources, args })
      if (preview.ok !== true) return preview

      if (preview.targets.length > 1) {
        const refusal = approvalRefusal(store, 'batchCollect', args?.confirm,
          `这次要提交 ${preview.targets.length} 个目标。确认无误就再调一次并带 confirm: true。`)
        if (refusal !== null) return refusal
      }

      const overrides = pacingOverridesFrom(args)
      const limits = { ...pacingForTask(), ...overrides }
      const usedToday = collectedToday()
      if (usedToday >= limits.dailyLimit) {
        return {
          ok: false,
          code: 'DAILY_LIMIT_REACHED',
          error: `daily limit reached: ${usedToday} >= pacing.dailyLimit ${limits.dailyLimit}`,
          hint: '调高 pacing.dailyLimit，或等明天（本地 00:00 归零）',
        }
      }
      if (preview.targets.length > limits.perTaskMax) {
        return {
          ok: false,
          code: 'TOO_MANY_TARGETS',
          error: `too many targets: ${preview.targets.length} > perTaskMax ${limits.perTaskMax}`,
          hint: '拆成几次提交，或调高 pacing.maxAsinsPerTask',
        }
      }

      const adapter = sources.get(preview.source)
      const supported = adapter?.capabilities?.().fields ?? []
      const draft = args?.draft === true
      const id = randomUUID()
      /* A draft gets the prefill trace too. What a draft skips is step 4 (the
         environment check and the queue) — not the record of *which external
         entry filled this form in and what the person changed*. That record is
         the point of F04-04 (contract §2.3 `prefill_json`), and a form saved
         before it is committed is precisely where "what did I start from" has to
         survive a reload. `prefillFor` itself returns null when no
         `sourceContextId` was handed in, which is the honest value for a form
         typed from scratch, draft or not. */
      const prefill = prefillFor({
        store, sourceContextId: args?.sourceContextId, args, targets: preview.targets, supported,
      })
      /* The field range: what the caller asked for, else the prefill's default
         range, else every field the source provides (`null`). An empty prefill
         range means "nothing in this list was out of date" and falls back to the
         source's own set — collecting literally nothing is not a collection. */
      const prefillFields = prefill === null ? [] : prefill.defaultFields.filter(field => supported.includes(field))
      const fields = Array.isArray(preview.fields) && preview.fields.length > 0
        ? preview.fields
        : (prefillFields.length > 0 ? prefillFields : null)

      const plan = draft ? null : matchPlan(store, { marketplace: preview.marketplace, targets: preview.targets })

      insertCollectionTask(store, {
        id,
        sourceId: preview.source,
        targets: preview.targets,
        fields,
        status: draft ? 'draft' : 'queued',
        side_split_json: JSON.stringify(preview.sideSplit),
        ownership_evidence_json: JSON.stringify(preview.ownershipEvidence),
        scheme_id: preview.scheme?.id ?? null,
        scheme_version: preview.scheme?.version ?? null,
        plan_id: plan?.id ?? null,
        prefill_json: prefill === null ? null : JSON.stringify(prefill),
        reused_snapshots_json: preview.reuse.count > 0 ? JSON.stringify(preview.reuse.asins) : null,
        retry_of: blankToNullValue(args?.retryOf),
        attempt: 1,
      })

      const base = {
        ok: true,
        taskId: id,
        source: preview.source,
        targets: preview.targets,
        total: preview.targets.length,
        sideSplit: preview.sideSplit,
        scheme: preview.scheme,
        planId: plan?.id ?? null,
        risk: preview.risk,
        reuse: preview.reuse,
        preview,
        estimatedMinutes: estimateMinutes(preview.targets.length, limits),
        perTaskMax: limits.perTaskMax,
      }

      if (draft) {
        workbench?.record('collect:draft', { taskId: id, total: preview.targets.length }, 'plugin')
        return { ...base, status: 'draft', note: '已存为草稿，未入队（drain 的守卫只收 queued）' }
      }

      const env = await runEnvCheck({
        store, collector, dataDir, chromePath, marketplace: preview.marketplace, taskId: id,
      })
      const envSummary = { ok: true, summary: env.summary, checks: env.checks, checkedAt: env.checkedAt }
      if (env.ok !== true) {
        /* The check itself could not run (an unknown marketplace, a missing
           task). The row stays `queued` — no queue entry was ever made, so it
           cannot start, and the caller gets the code to act on. */
        return { ...base, ...env, taskId: id, status: 'queued', envSummary: null }
      }

      if (env.loginBlocked === true) {
        const waiting = buildWaiting({
          trigger: 'profile-logged-out',
          reason: `专用 profile 未登录 ${preview.marketplace}，需要在本机浏览器完成登录`,
          since: env.checkedAt,
        })
        transition(id, 'queued', 'checking_env', { reason: '环境体检未通过：登录态为 logged_out' })
        transition(id, 'checking_env', 'waiting_human', {
          reason: waiting.reason,
          patch: { waiting_json: JSON.stringify(waiting) },
        })
        workbench?.record('collect:waiting', { taskId: id, trigger: 'profile-logged-out' }, 'plugin')
        return { ...base, status: 'waiting_human', waiting, envSummary }
      }

      if (env.blocking.length > 0) {
        transition(id, 'queued', 'checking_env', { reason: `环境体检未通过：${env.blocking.join(', ')}` })
        return {
          ...base,
          ok: false,
          code: 'ENV_CHECK_FAILED',
          status: 'checking_env',
          envSummary,
          failures: env.checks.filter(check => env.blocking.includes(check.id)).map(check => ({ id: check.id, detail: check.detail })),
          error: `环境体检未通过：${env.blocking.join(', ')}`,
          hint: '用 amzn_collect_env_check 看十项明细；修好后可对同一个 taskId 重试',
        }
      }

      /* ── the plan window is judged **before** the site cooldown ──────────────
         The contract's step 3 (`§6.2.4`) names both outcomes in one line and does
         not say which wins when both hit; adjudicated here and written into
         `§5.4` of the contract, because the choice is observable.

         The window wins, for a reason that is not about severity: the two states
         have different exits. `cooling_down` returns to `queued` **by itself** when
         the cooldown expires (`§5.5`), while a closed window has to be released by
         a person (`force-resume`). Judging the cooldown first would therefore hand
         the task to an automatic edge that walks straight back into the closed
         window — and the person would see "cooling down", never the actual reason
         the run is not allowed to start. Reporting the window makes the blocking
         rule that *needs a decision* the one on screen. */
      if (plan !== null && plan.window !== null && !isWindowOpen(plan.window)) {
        const state = windowState(plan.window)
        const waiting = buildWaiting({
          trigger: 'plan-window',
          reason: `计划 ${plan.name} 的运行窗口 ${state.from}–${state.to}（${state.tz}）未到`,
          since: env.checkedAt,
        })
        transition(id, 'queued', 'checking_env', { reason: '计划窗口判定：窗口未开' })
        transition(id, 'checking_env', 'waiting_human', {
          reason: waiting.reason,
          patch: { waiting_json: JSON.stringify(waiting) },
        })
        return { ...base, status: 'waiting_human', waiting, envSummary }
      }

      const cooldown = siteCooldown(store, preview.marketplace)
      if (cooldown.active === true) {
        const risk = {
          level: 'high',
          reasons: [`站点冷却中：至 ${cooldown.until}`],
          since: cooldown.since,
          cooldownMinutes: cooldown.minutesRemaining,
          cooldownUntil: cooldown.until,
        }
        transition(id, 'queued', 'checking_env', { reason: '站点冷却判定：命中' })
        transition(id, 'checking_env', 'cooling_down', {
          reason: `${preview.marketplace} 站点冷却中，至 ${cooldown.until}（不入队）`,
          patch: { risk_json: JSON.stringify(risk) },
        })
        return {
          ...base,
          ok: false,
          code: 'COOLING_DOWN',
          status: 'cooling_down',
          risk,
          envSummary,
          error: `${preview.marketplace} 站点在冷却期内（至 ${cooldown.until}）`,
          hint: '等冷却结束再提交；任务行已建，可在页面上看到',
        }
      }

      taskOverrides.set(id, overrides)
      queue.push(id)
      workbench?.record('collect:queued', {
        taskId: id,
        source: preview.source,
        total: preview.targets.length,
        queueDepth: queue.length + (active === null ? 0 : 1),
      }, 'plugin')
      void drain()
      return { ...base, status: 'queued', envSummary }
    },

    /**
     * Put a task that a person resumed back on the runner.
     *
     * It does **not** write a status: `domain/collect/waiting.js` already moved
     * the row `waiting_human → running` (the only edge the state machine has out
     * of that state), and this only has to hand it to the one-at-a-time queue.
     */
    resumeWaiting(taskId) {
      const id = String(taskId)
      if (!resumeQueue.includes(id)) resumeQueue.push(id)
      void drain()
      return { ok: true, taskId: id, queueDepth: queue.length, resumeDepth: resumeQueue.length }
    },

    /**
     * The 30-minute sweep (contract §5.4/§5.5), called from `GET /api/state` and
     * from plugin startup. Without it, nobody opening the workbench means a
     * `waiting_human` row waits forever and a stalled `checking_env` row never
     * reaches a terminal state.
     */
    scanWaitingTimeouts(now = new Date()) {
      return applyWaitingSweep(store, { now })
    },

    /** Abort whatever is running; used when the plugin is disposed. */
    stop() {
      active?.controller.abort()
      queue.length = 0
      resumeQueue.length = 0
      taskOverrides.clear()
    },

    get runningTaskId() {
      return active?.taskId ?? null
    },
  }
}

/**
 * Turn a task row into something a tool can render without re-parsing JSON at
 * every call site.
 */
export function hydrate(task) {
  const rawProgress = task.progress_json === null ? null : safeParse(task.progress_json, null)
  return {
    id: task.id,
    kind: task.kind ?? 'asin',
    source: task.source_id,
    status: task.status,
    submittedAt: task.submitted_at,
    finishedAt: task.finished_at ?? null,
    updatedAt: task.updated_at ?? null,
    error: task.error ?? null,
    targets: safeParse(task.targets_json, []),
    fields: task.fields_json === null ? null : safeParse(task.fields_json, null),
    progress: rawProgress,
    /* 进度视图：`done/total` 原样保留在 `progress` 里（既有页面读它），
       另加一层派生 —— 剩余分钟、百分比、以及每一处「算不出来」的原因。
       派生放在这里而不是引擎里，是为了不动已经跑了很多测试的采集写入路径。 */
    progressView: progressView(rawProgress, {
      status: task.status,
      submittedAt: task.submitted_at,
      finishedAt: task.finished_at ?? null,
    }),
    result: task.result_json === null ? null : safeParse(task.result_json, null),
  }
}

/* `normalizeTargets` / `validateFieldSelection` / `estimateMinutes` used to live
   here. They moved to `domain/collect/targets.js` unchanged — the preview and the
   section detail builder need the same three answers, and a second copy of "is
   this a 10-character ASIN" or of the request count is exactly the drift that
   makes a preview disagree with the submission it is previewing. */

function blankToNullValue(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/**
 * The per-task pacing overrides a submission may carry.
 *
 * Only the three the run path can actually honour are read; anything else is
 * ignored *by name* rather than silently — an unrecognised key would otherwise
 * ride along looking applied.
 */
function pacingOverridesFrom(args) {
  const overrides = {}
  if (Number.isFinite(Number(args?.perTaskMax))) overrides.perTaskMax = Number(args.perTaskMax)
  if (typeof args?.humanize === 'boolean') overrides.humanize = args.humanize
  if (typeof args?.strictStorefront === 'boolean') overrides.strictStorefront = args.strictStorefront
  return overrides
}

/**
 * The enabled plan that governs this submission, if any (contract §5.4).
 *
 * The contract's own wording for the `plan-window` trigger is "`plan_id` 非空且
 * 当前时刻在 `window_json` 之外", so a submission has to be able to *acquire* a
 * plan id without being handed one — `amzn_collect_run` has no `planId`
 * parameter. The rule: prefer an enabled plan for the same marketplace whose
 * target list overlaps what is being submitted; fall back to the enabled plan for
 * that marketplace when there is exactly one. Two enabled plans and no overlap is
 * **ambiguous**, and guessing would apply somebody else's window to this run.
 */
function matchPlan(store, { marketplace, targets }) {
  if (store === null || store === undefined) return null
  const candidates = listPlans(store, { enabled: true, marketplace }).filter(plan => plan.window !== null)
  if (candidates.length === 0) return null
  const wanted = new Set(targets.map(target => target.asin))
  const overlapping = candidates.filter(plan => (plan.targets ?? []).some(target => wanted.has(String(target?.asin ?? '').trim().toUpperCase())))
  if (overlapping.length === 1) return overlapping[0]
  if (overlapping.length > 1) return null
  return candidates.length === 1 ? candidates[0] : null
}

/**
 * `partial` is the interesting one: some data was written, so the result is
 * useful, but the task did not finish what it was asked to do. Calling that
 * either `done` or `failed` would hide one half of the truth.
 */
function deriveStatus(result, total) {
  if (result === null || result === undefined) return 'failed'
  if (result.stopped === 'cancelled') return 'cancelled'
  if (result.stopped === 'no-browser') return 'failed'
  /* 「没报数」不等于「写了 0 条」。原来三处都写 `result.written ?? 0`，
     于是**通道没报行数**时会被判成 `failed`（什么都没采到）——那是替它下了一个它没说的结论。
     现在：知道数才按数判；不知道数时只能说「不能确认完整」，即 `partial`。 */
  const writtenKnown = Number.isFinite(Number(result.written)) && result.written !== null && result.written !== undefined
  const written = writtenKnown ? Number(result.written) : null
  const failedKnown = Number.isFinite(Number(result.failed)) && result.failed !== null && result.failed !== undefined
  if (result.stopped === 'blocked') return written !== null && written > 0 ? 'partial' : (written === null ? 'partial' : 'failed')
  if (written === null) return 'partial'
  if (written === 0) return 'failed'
  if ((failedKnown && Number(result.failed) > 0) || written < total) return 'partial'
  /* A run that wrote ASIN rows but **no** section rows leaves the 13-section
     page empty while every other panel says the collection succeeded — that is
     the exact shape of the defect this writer removes, and it must not be
     allowed to report `done`. Only judged when the adapter actually reported the
     count: a channel that fills no section rows at all (a future API source)
     must not be called partial for a column it never claimed to write. */
  if (Number.isFinite(Number(result.sectionsWritten)) && Number(result.sectionsWritten) === 0) return 'partial'
  if (Array.isArray(result.sectionErrors) && result.sectionErrors.length > 0) return 'partial'
  return 'done'
}

/** Keep the stored result small; the per-target detail is capped too. */
/* 计数字段的统一口径：知道数才写数，不知道写 null（读到 null 的人会问，读到 0 的人不会）。countOrNull 提在模块级，因为同一份结果要落到 result_json / evidence_json / progress_json / feed 四个地方。 */
function countOrNull(value) {
  return Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value) : null
}

function compactResult(result) {
  /* ⚠️ 这几个**计数**字段不许用 `?? 0` 兜底（复验席 2026-10-25 §10 抓到）：
     `deriveStatus` 刚刚因为「通道没报数」把状态判成 `partial`（我们不知道），
     结果同一行的 `result_json.written` 又被写成 `0`（它写了 0 条）——
     **状态列说「不知道」，存下来的结果说「就是 0」**，下游读 `result_json.written`
     的汇总/导出看到的是 0。新区分在上游成立、在这里被抹平。
     所以：知道数才写数，不知道就写 null（读到 null 的人会问，读到 0 的人不会）。
     `sectionErrors` / `missingFields` 那几行是**列表**，`[]` 与 null 的语义差别另算（T-24 已处理）。 */
  return {
    ok: result.ok ?? false,
    attempted: countOrNull(result.attempted),
    written: countOrNull(result.written),
    failed: countOrNull(result.failed),
    selectorMiss: countOrNull(result.selectorMiss),
    /* The 13-section half of the run, kept next to the ASIN half: "13 rows per
       ASIN" is what the section page reads, and a stored result that only counts
       ASINs cannot answer why that page is empty. */
    sectionsWritten: countOrNull(result.sectionsWritten),
    sectionCorrections: countOrNull(result.sectionCorrections),
    sectionErrors: (result.sectionErrors ?? []).slice(0, 20),
    stopped: result.stopped ?? null,
    stopReason: result.stopReason ?? null,
    missingFields: result.missingFields ?? [],
    durationMs: result.durationMs ?? null,
    pacing: result.pacing ?? null,
    error: result.error ?? null,
    results: (result.results ?? []).slice(0, 200),
  }
}

/* `estimateMinutes` moved to `domain/collect/targets.js` (see the note above). */

const randomBetween = ([min, max]) => min + Math.random() * Math.max(0, max - min)

/* ── what the collection worker leaves in the audit log (W1-7 / §31) ───────── */

/** The key a target is identified by, in the same shape the store keys on. */
function targetKey(target) {
  return `${String(target?.asin ?? '').trim().toUpperCase()}|${String(target?.marketplace ?? '').trim().toUpperCase()}`
}

/**
 * The bounded state of one ASIN: its row, plus the identity of its newest
 * snapshot.
 *
 * Deliberately **not** `getAsin`: that view carries up to 20 snapshots (with
 * their payloads), the provenance rows and up to 200 keywords, and this runs
 * once per target — a 50-ASIN task would write a keyword table into the audit
 * log fifty times over. What is kept is what the question "what changed in the
 * library" needs: the writable columns of the row, and which snapshot is now the
 * newest. The snapshot's own body is already append-only in `asin_snapshot`, and
 * the version registry points at it (W1-1) — a third copy here would be a third
 * thing to keep in step.
 */
function readTargetState(store, target) {
  const asin = String(target?.asin ?? '').trim().toUpperCase()
  const marketplace = String(target?.marketplace ?? '').trim().toUpperCase()
  if (asin === '' || marketplace === '') return { asin: null, listing: null }

  const row = store.get('SELECT * FROM asin WHERE asin = ? AND marketplace = ?', [asin, marketplace])
  const snapshot = store.get(
    `SELECT id, source_id, collected_at FROM asin_snapshot
      WHERE asin = ? AND marketplace = ? ORDER BY collected_at DESC, id DESC LIMIT 1`,
    [asin, marketplace],
  )
  return {
    /* A copy, not the row itself: an audit value that aliases a live row is a
       value that can change after it was recorded. */
    asin: row === undefined ? null : { ...row },
    listing: snapshot === undefined
      ? null
      : { snapshotId: snapshot.id, collectedAt: snapshot.collected_at, sourceId: snapshot.source_id },
  }
}

/**
 * One audit row per object the collection actually wrote.
 *
 * **Which targets count as written** is the adapter's own per-target report
 * (`result.results`, the same list the task row stores), not a re-derivation
 * here: two definitions of "written" is two answers to "did this collection
 * write". A target that failed, was blocked or hit a changed selector is not in
 * this list and gets no row — no write, no row.
 *
 * The listing row is emitted only when the newest snapshot is a **different**
 * row than it was before. An adapter that reports success without writing a
 * snapshot (a stub, a future channel) must not leave a row claiming a page was
 * captured.
 */
function recordCollectedWrites({ store, targets, beforeState, beforeNote, result, taskId, workbench }) {
  const byKey = new Map(targets.map(target => [targetKey(target), target]))
  const report = error => workbench?.record('audit:error', {
    worker: WORKER_NAMES.collect,
    taskId,
    error: error.message,
  })

  for (const entry of result?.results ?? []) {
    if (entry === null || entry === undefined || entry.status !== 'ok') continue
    const target = byKey.get(targetKey(entry)) ?? { asin: entry.asin, marketplace: entry.marketplace }
    if (String(target.asin ?? '').trim() === '') continue

    const before = beforeState.get(targetKey(target)) ?? null
    let after = null
    let reason = beforeNote
    try {
      after = readTargetState(store, target)
    } catch (error) {
      reason = `${beforeNote === null ? '' : `${beforeNote}；`}新值读取失败: ${error.message}（写已发生，新值未知）`
    }

    recordWorkerWrite(store, {
      worker: WORKER_NAMES.collect,
      action: ACTIONS.asinUpsert,
      objectType: 'asin',
      objectId: target.asin,
      before: before?.asin ?? null,
      after: after?.asin ?? null,
      impact: { taskId },
      reason,
    }, report)

    const beforeListing = before?.listing ?? null
    const afterListing = after?.listing ?? null
    if (afterListing !== null && afterListing.snapshotId !== beforeListing?.snapshotId) {
      recordWorkerWrite(store, {
        worker: WORKER_NAMES.collect,
        action: ACTIONS.listingSnapshot,
        objectType: 'listing',
        /* The same object id the snapshot registry uses for a listing version
           (`<asin>@<marketplace>`): one object, one name. */
        objectId: `${String(target.asin).trim().toUpperCase()}@${String(target.marketplace ?? '').trim().toUpperCase()}`,
        before: beforeListing,
        after: afterListing,
        impact: { taskId },
        reason,
      }, report)
    }
  }
}

function safeParse(json, fallback) {
  try {
    const value = JSON.parse(json)
    return value === null || value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
