/**
 * `waiting_human`: the three reasons a collection parks, the decisions a person
 * can then make, and the 30-minute timeout (module 04 F04-06; contract §5.4).
 *
 * ## Why three triggers instead of one "waiting" state
 *
 * The triggers need **different** fixes and therefore different buttons:
 *
 *   · `profile-logged-out` — the dedicated profile is not signed in. The person
 *     signs in in the browser window, then asks for a re-check.
 *   · `login-wall` — the page threw a login wall or a bot check mid-run. The
 *     person handles it, then continues from where it stopped.
 *   · `plan-window` — the configured window has not opened. The person either
 *     lets it run now, or gives up on this attempt.
 *
 * Rendering all three as "等待中" would leave whoever is looking at the panel
 * guessing which of three unrelated actions to take.
 *
 * ## The timeout has no timer, and that is the design
 *
 * `deadlineAt` is `since + 30 min` and it is **compared**, never scheduled: the
 * sweep runs when the workbench is opened and on every `GET /api/state` poll,
 * plus once at plugin startup. `since` is a real instant, so the cancellation can
 * land later than `deadlineAt` — the task is cancelled on the first look after
 * it expired, which is when anybody can see it anyway. A resident timer is
 * explicitly out of scope for this batch, so "30 分钟无操作" honestly means "the
 * next time somebody looks, it is over" (contract §10-6).
 *
 * ## Nothing is deleted
 *
 * Every exit keeps the sections already collected — `放弃本次（保留已采节）` is the
 * contract's own wording, and the section store has no delete path at all, so
 * the promise is structural rather than remembered.
 */

import { COLLECTION_WAITING_TRIGGERS, canTransitionCollectionTask } from '../states.js'
import { countSectionResults, countKeptSnapshots } from '../../store/collection-section.js'
import { getCollectionTask } from '../../store/queries.js'
import { transitionCollectionTask } from '../../store/collection-transition.js'

/** Contract §3 / §5.4: 30 minutes, counted from `waiting_json.since`. */
export const WAITING_TIMEOUT_MS = 30 * 60 * 1_000

/** The timeout sentence, in one place: the sweep and the tool both report it. */
export const WAITING_TIMEOUT_NOTE = '等待人工 30 分钟无操作，自动取消（已采数据保留）'

const WAITING_TRIGGERS = COLLECTION_WAITING_TRIGGERS

/**
 * The buttons each trigger offers, exactly as contract §5.4 lists them.
 *
 * Served to the page rather than hard-coded there, so a button can never exist
 * for an action the server will refuse with `ACTION_NOT_ALLOWED`.
 */
export const WAITING_ACTIONS = {
  'profile-logged-out': [
    { id: 'open-browser', label: '打开采集浏览器' },
    { id: 'recheck', label: '已登录，重试体检' },
  ],
  'login-wall': [
    { id: 'resume', label: '已处理，继续采集' },
    { id: 'abandon', label: '放弃本次（保留已采节）' },
  ],
  'plan-window': [
    { id: 'force-resume', label: '本次放行' },
    { id: 'abandon', label: '放弃本次' },
  ],
}

/** The abandon button is on every trigger — giving up is always allowed. */
export function actionsForTrigger(trigger) {
  const actions = WAITING_ACTIONS[String(trigger ?? '').trim()]
  return actions === undefined ? [] : actions.map(action => ({ ...action }))
}

/**
 * May `action` be taken for `trigger`?
 *
 * `abandon` is allowed on every trigger **by the contract's own table** ("任意"),
 * which is why it is not repeated in the three lists above: an action that
 * appears in all three rows is one rule, not three.
 */
export function actionAllowed(trigger, action) {
  const chosen = String(action ?? '').trim()
  const which = String(trigger ?? '').trim()
  if (!WAITING_TRIGGERS.includes(which)) return false
  if (chosen === 'abandon') return true
  return actionsForTrigger(which).some(entry => entry.id === chosen)
}

/**
 * The allowed set for one trigger, `abandon` included — the refusal lists it.
 *
 * De-duplicated: `abandon` is already one of the buttons on `login-wall` and
 * `plan-window`, so concatenating the two lists would hand back a set with an
 * entry twice. A refusal that prints the allowed actions is the *list the page
 * renders*, and a duplicated entry there is two identical buttons under one
 * rule.
 */
export function allowedActions(trigger) {
  return [...new Set(['abandon', ...actionsForTrigger(trigger).map(entry => entry.id)])]
}

/** The stored `waiting_json`, parsed, or null when the task is not waiting. */
export function waitingOf(task) {
  if (task === null || task === undefined) return null
  const raw = task.waiting_json
  if (raw === null || raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Build the `waiting_json` a trigger writes.
 *
 * `deadlineAt` is derived here and nowhere else: a second computation of
 * "since + 30 min" is how the panel and the sweep come to disagree about whether
 * a task has expired.
 */
export function buildWaiting({ trigger, reason = null, since = null, evidence = null } = {}) {
  const chosen = String(trigger ?? '').trim()
  if (!WAITING_TRIGGERS.includes(chosen)) {
    throw new Error(`waiting trigger "${trigger}" is not one of ${WAITING_TRIGGERS.join(' / ')}`)
  }
  const from = since === null || since === undefined ? new Date().toISOString() : new Date(since).toISOString()
  return {
    trigger: chosen,
    reason,
    actions: actionsForTrigger(chosen),
    since: from,
    deadlineAt: new Date(new Date(from).getTime() + WAITING_TIMEOUT_MS).toISOString(),
    ...(evidence === null ? {} : { evidence }),
  }
}

/** Has this waiting window expired at `now`? */
export function waitingExpired(waiting, now = new Date()) {
  if (waiting === null || waiting === undefined) return false
  const deadline = waiting.deadlineAt
  if (deadline === null || deadline === undefined) return false
  const at = new Date(deadline).getTime()
  if (!Number.isFinite(at)) return false
  return at <= new Date(now).getTime()
}

/**
 * The 30-minute sweep — a pure decision; the collection service applies it.
 *
 * Two states can stall forever, and both are swept here because they are the
 * same question ("is this row waiting for something that will never come?"):
 *
 *   · `waiting_human` past `deadlineAt` → `cancelled`, by the contract's own
 *     sentence. Sections already collected are untouched.
 *   · `checking_env` whose check is older than the same window → `failed`. The
 *     contract says a task that fails its environment check "停在 `checking_env`
 *     直至超时转 `failed`", and nothing else moves it — so without this it is
 *     exactly the "row that never moves". A restart is one answer to that, but a
 *     restart is not guaranteed to ever happen.
 *
 * Returns the ids to move plus why, so the caller (which owns the status writer)
 * does the writes. This function touches nothing.
 */
export function dueWaitingSweep(rows, now = new Date(), { timeoutMs = WAITING_TIMEOUT_MS } = {}) {
  const cancel = []
  const fail = []
  for (const task of rows ?? []) {
    if (task.status === 'waiting_human') {
      const waiting = waitingOf(task)
      if (waitingExpired(waiting, now)) cancel.push({ id: task.id, trigger: waiting?.trigger ?? null })
      continue
    }
    if (task.status === 'checking_env') {
      const since = task.env_checked_at ?? task.updated_at ?? task.submitted_at
      const at = new Date(since).getTime()
      if (Number.isFinite(at) && new Date(now).getTime() - at >= timeoutMs) fail.push({ id: task.id, since })
    }
  }
  return { cancel, fail }
}

/**
 * Click one of the buttons (contract §6.2.6).
 *
 * The five actions reduce to three effects: **run it now** (`resume`,
 * `force-resume`, and `recheck` when the re-check passes), **open the window**
 * (`open-browser`, which changes nothing in the database on purpose — it takes
 * no credentials and signs nobody in), and **give up** (`abandon`).
 *
 * `collection` is passed in rather than imported so this module does not depend
 * on the service that depends on it: the queue and the run loop live there, and
 * a resume has to go through them.
 */
export async function resolveWaiting({
  store, collection = null, collector = null, taskId, action, reason = null, by = null,
  openBrowser = null, recheck = null,
} = {}) {
  const id = String(taskId ?? '').trim()
  const task = id === '' ? undefined : getCollectionTask(store, id)
  if (task === undefined) {
    return { ok: false, code: 'TASK_NOT_FOUND', error: `no collection task "${taskId}"` }
  }
  if (task.status !== 'waiting_human') {
    /* A cancelled task that was waiting before is the timeout having already
       fired — a different answer from "this task was never waiting", and the
       caller has to be able to tell them apart. */
    const expired = task.status === 'cancelled' && waitingOf(task) !== null
    return {
      ok: false,
      code: expired ? 'WAITING_EXPIRED' : 'NOT_WAITING',
      status: task.status,
      error: expired
        ? `task ${id} 的等待已超时并被取消：${task.error ?? WAITING_TIMEOUT_NOTE}`
        : `task ${id} is ${task.status}, not waiting_human`,
    }
  }

  const waiting = waitingOf(task) ?? { trigger: null, since: task.updated_at, deadlineAt: null }
  const trigger = waiting.trigger
  const chosen = String(action ?? '').trim()
  if (!actionAllowed(trigger, chosen)) {
    return {
      ok: false,
      code: 'ACTION_NOT_ALLOWED',
      status: task.status,
      trigger,
      allowed: allowedActions(trigger),
      error: `action "${action}" is not allowed for trigger "${trigger}"`,
    }
  }

  const keptSections = countSectionResults(store, { taskId: id })
  /* Two counts, both reported, neither standing in for the other: the section
     rows kept and the product snapshots those rows reference. */
  const keptSnapshots = countKeptSnapshots(store, { taskId: id })

  if (chosen === 'abandon') {
    const text = String(reason ?? '').trim()
    if (text === '') {
      return { ok: false, code: 'REASON_REQUIRED', error: 'abandon 必须给 reason（放弃本次要留原因）' }
    }
    transitionCollectionTask(store, {
      taskId: id,
      fromStatus: 'waiting_human',
      toStatus: 'cancelled',
      reason: text,
      source: 'human',
      by,
      evidence: { trigger, keptSections },
    })
    return {
      ok: true, taskId: id, status: 'cancelled', keptSections, keptSnapshots,
      note: '放弃本次，已采节保留',
    }
  }

  if (chosen === 'open-browser') {
    if (collector === null) return { ok: false, code: 'REPAIR_FAILED', error: '本 profile 没有注入浏览器采集器' }
    /* Opens the window and nothing else. It never types a credential — that is
       the F04-02 refusal, and it is also why this action is not called "log in". */
    const launched = await (openBrowser ?? defaultOpenBrowser)({ collector })
    if (launched.ok !== true) return launched
    return {
      ok: true,
      taskId: id,
      status: 'waiting_human',
      keptSections,
      keptSnapshots,
      note: '已拉起采集浏览器窗口，请在其中手动登录后调用 action="recheck"',
    }
  }

  if (chosen === 'recheck') {
    if (collector === null) return { ok: false, code: 'REPAIR_FAILED', error: '本 profile 没有注入浏览器采集器' }
    const checked = await (recheck ?? defaultRecheck)({ store, collector, taskId: id })
    if (checked.ok !== true) return checked
    const login = (checked.checks ?? []).find(check => check.id === '05-login')
    if (login === undefined || login.status !== 'ok') {
      /* Still not signed in. The task stays where it is — and the waiting window
         is **not** restarted, because `since` is when the person first saw it
         (contract §5.5: 重启不该让人工等待重新计时). */
      return {
        ok: false,
        code: 'LOGIN_STILL_UNKNOWN',
        taskId: id,
        status: 'waiting_human',
        keptSections,
        keptSnapshots,
        login: login?.status ?? 'unknown',
        detail: login?.detail ?? null,
        error: '重新体检后登录态仍不是 logged_in',
      }
    }
    return resumeNow({ store, collection, id, keptSections, keptSnapshots, reason: '已登录，重试体检通过', by, trigger })
  }

  return resumeNow({
    store,
    collection,
    id,
    keptSections,
    keptSnapshots,
    reason: chosen === 'force-resume' ? '计划窗口外，本次放行' : '人工处理后继续',
    by,
    trigger,
  })
}

/**
 * Put a waiting task back on the runner.
 *
 * The state machine's edge is `waiting_human → running`, and that is the edge
 * used here — not `queued`, which is not an edge at all. The runner is told this
 * is a resume (`resumeWaiting`) so it does not write `queued → running` a second
 * time; `waiting_json` stays in place, because why the task waited is evidence
 * and a resume does not un-happen it.
 */
function resumeNow({ store, collection, id, keptSections, keptSnapshots, reason, by, trigger }) {
  if (!canTransitionCollectionTask('waiting_human', 'running')) {
    return { ok: false, code: 'ACTION_NOT_ALLOWED', error: '状态机不允许 waiting_human → running' }
  }
  transitionCollectionTask(store, {
    taskId: id,
    fromStatus: 'waiting_human',
    toStatus: 'running',
    reason,
    source: 'human',
    by,
    evidence: { trigger, keptSections },
  })
  const requeued = typeof collection?.resumeWaiting === 'function' ? collection.resumeWaiting(id) : null
  return {
    ok: true,
    taskId: id,
    status: 'running',
    keptSections,
    keptSnapshots,
    requeued,
    note: `${reason}；已采节保留 ${keptSections} 行，继续从未完成的节开始`,
  }
}

async function defaultOpenBrowser({ collector }) {
  const { ensureBrowser } = await import('../../sources/cdp/launcher.js')
  try {
    await ensureBrowser({
      host: collector.host, port: collector.port, profileDir: collector.profileDir, exePath: collector.chromePath,
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, code: 'REPAIR_FAILED', error: `拉起浏览器失败：${error.message}` }
  }
}

async function defaultRecheck({ store, collector, taskId }) {
  const { runEnvCheck } = await import('./env.js')
  return runEnvCheck({ store, collector, checks: ['05-login'], taskId })
}

/**
 * Apply the sweep. Idempotent: the selection is by status, so a row already
 * moved is not selected again.
 *
 * Both branches write the reason onto the **task row** as well as into the
 * history. Contract §5.4 says the timeout writes
 * `error='等待人工 30 分钟无操作，自动取消（已采数据保留）'`, and that sentence is
 * what the task list shows: an event-only write leaves the row `cancelled` with
 * `error = NULL`, which reads on the page as a task somebody cancelled by hand —
 * the one thing this state exists to be distinguishable from.
 */
export function applyWaitingSweep(store, { now = new Date(), timeoutMs = WAITING_TIMEOUT_MS } = {}) {
  const rows = store.all("SELECT * FROM collection_task WHERE status IN ('waiting_human','checking_env')")
  const due = dueWaitingSweep(rows, now, { timeoutMs })
  for (const entry of due.cancel) {
    transitionCollectionTask(store, {
      taskId: entry.id,
      fromStatus: 'waiting_human',
      toStatus: 'cancelled',
      reason: WAITING_TIMEOUT_NOTE,
      source: 'timeout',
      evidence: { trigger: entry.trigger },
      patch: { error: WAITING_TIMEOUT_NOTE },
    })
  }
  for (const entry of due.fail) {
    const note = '环境体检未通过且无人处理，超过 30 分钟自动失败'
    transitionCollectionTask(store, {
      taskId: entry.id,
      fromStatus: 'checking_env',
      toStatus: 'failed',
      reason: note,
      source: 'timeout',
      evidence: { since: entry.since },
      patch: { finished_at: new Date(now).toISOString(), error: note },
    })
  }
  return { cancelled: due.cancel.map(entry => entry.id), failed: due.fail.map(entry => entry.id) }
}

/** Read the timeout state of one task, for the panel. */
export function waitingView(task, now = new Date()) {
  const waiting = waitingOf(task)
  if (waiting === null) return null
  return {
    trigger: waiting.trigger,
    reason: waiting.reason ?? null,
    actions: actionsForTrigger(waiting.trigger),
    since: waiting.since ?? null,
    deadlineAt: waiting.deadlineAt ?? null,
    expired: waitingExpired(waiting, now),
    minutesLeft: waiting.deadlineAt === null || waiting.deadlineAt === undefined
      ? null
      : Math.max(0, Math.round((new Date(waiting.deadlineAt).getTime() - new Date(now).getTime()) / 60_000)),
  }
}
