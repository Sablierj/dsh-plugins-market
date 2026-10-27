/**
 * The ten-item environment check and the four repair actions (module 04
 * F04-01 / F04-02; contract §6.2.1, §6.2.2).
 *
 * ## What this file is allowed to say
 *
 * Every item answers with one of four states, and the two that look alike are
 * not: `fail` is "it is broken", `unknown` is "**we could not tell**". `09-proxy`
 * is permanently `unknown` — this version does not go through a proxy, and
 * drawing a green tick there would be inventing a check that never ran (that is
 * the adjudication §3 decision, and it is why the item exists at all rather than
 * being omitted).
 *
 * ## No repair happens by accident
 *
 * The four refusal rules are checked **before** anything is touched, and the one
 * destructive-ish action (`launch_browser` opens a GUI window) additionally needs
 * `confirm: true`. A refusal is a `code`, not a sentence: the caller branches on
 * it. The four are: install the browser, type the password, kill an unknown
 * browser process, get past a captcha — none of which this plugin will ever do.
 *
 * ## The timeout is per item, and it does not abort the round
 *
 * One item that hangs must not delete the nine others' answers: the page prints
 * "unknown" for it and moves on (contract §3: 3 000 ms per item, fixed order, no
 * parallelism — the probes affect each other, since launching a browser changes
 * the port's state).
 */

import { accessSync, existsSync, mkdirSync, constants as FS } from 'node:fs'
import { join } from 'node:path'

import { MARKETPLACES, storefrontFor } from '../../sources/pages/amazon.js'
import { applyStorefront, CdpConnection, navigate, probeVersion } from '../../sources/cdp/client.js'
import { ensureBrowser, findBrowser } from '../../sources/cdp/launcher.js'
import { ensureStorefront, readState } from '../../sources/pages/amazon-session.js'
import { liveBlockedPage, CONTINUE_CONTROL_LABEL } from './blocked-page.js'
import { discoverProfiles, resolveImportDir } from './profile.js'
import { COLLECTION_REPAIR_ACTIONS, COLLECTION_RISK_LEVELS } from '../states.js'
import { getCollectionTask, updateCollectionTask } from '../../store/queries.js'
import { listSchemes } from '../../store/collection-scheme.js'
import { recordEnvCheckRound } from '../../store/collection-env.js'

/** The ten item ids, in the fixed order they are run and printed. */
export const ENV_CHECK_IDS = [
  '01-runtime',
  '02-browser',
  '03-profile',
  '04-port',
  '05-login',
  '06-storefront',
  '07-datadir',
  '08-scheme',
  '09-proxy',
  '10-cooldown',
]

/**
 * Label and risk per item.
 *
 * The risk is a property of the item, not of its current state: "the selectors
 * changed" is a high-risk thing to be wrong about whether or not it is true
 * right now, and a state-derived risk would make the column mean "how bad is it
 * today", which the status column already says.
 */
export const ENV_CHECK_META = {
  '01-runtime': { label: '运行时', risk: 'low' },
  '02-browser': { label: '浏览器', risk: 'medium' },
  '03-profile': { label: '专用 profile', risk: 'low' },
  '04-port': { label: 'CDP 端口', risk: 'medium' },
  '05-login': { label: '登录态', risk: 'medium' },
  '06-storefront': { label: '站点上下文', risk: 'high' },
  '07-datadir': { label: '数据目录', risk: 'medium' },
  '08-scheme': { label: '采集方案', risk: 'high' },
  '09-proxy': { label: '代理', risk: 'low' },
  '10-cooldown': { label: '站点冷却', risk: 'high' },
}

/** Contract §3: one item may take 3 000 ms; a hung item becomes `unknown`. */
export const ENV_CHECK_TIMEOUT_MS = 3_000

/** Contract §3 / §9-O7: the site cooldown when no plan names one. */
export const SITE_COOLDOWN_DEFAULT_MINUTES = 60

/** How many recent tasks the site-cooldown read looks back through. */
const SITE_COOLDOWN_LOOKBACK = 50

const TIMED_OUT = Symbol('env-check-timeout')

/** Is `id` one of the ten? */
export function isEnvCheckId(id) {
  return ENV_CHECK_IDS.includes(String(id ?? '').trim())
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function safeParse(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback
  try {
    const value = JSON.parse(text)
    return value === null || value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

function errorCode(error) {
  return error?.code ?? error?.message ?? 'unknown error'
}

/** Run one probe under the per-item budget. */
async function withDeadline(fn, ms = ENV_CHECK_TIMEOUT_MS) {
  let timer = null
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms) }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function item(id, status, detail, { repairable = false, repairAction = null } = {}) {
  const meta = ENV_CHECK_META[id]
  return {
    id,
    label: meta.label,
    status,
    detail,
    repairable,
    repairAction: repairable ? repairAction : null,
    risk: meta.risk,
  }
}

function unknownItem(id, detail) {
  return item(id, 'unknown', detail)
}

/** Counts by state, plus how many items are repairable. Same shape as the store's. */
export function envSummaryOf(checks) {
  const summary = { ok: 0, warn: 0, fail: 0, unknown: 0, repairable: 0, total: checks.length }
  for (const check of checks) {
    summary[check.status] = (summary[check.status] ?? 0) + 1
    if (check.repairable) summary.repairable += 1
  }
  return summary
}

/**
 * The site-level cooldown in force for one marketplace, read from the most
 * recent task for that site that left a `risk_json` (contract §5.3-3).
 *
 * Only the **most recent** blocked task is consulted, and only if its targets
 * include this marketplace: an older block does not extend a newer one, and a
 * block on DE says nothing about US. An expired cooldown is not "cooling" —
 * returning it as active would make the state permanent.
 */
export function siteCooldown(store, marketplace, now = new Date()) {
  const site = String(marketplace ?? '').trim().toUpperCase()
  const blank = { active: false, since: null, until: null, minutesRemaining: null, minutes: null, reasons: [] }
  if (store === null || store === undefined || site === '') return blank

  const rows = store.all(
    `SELECT risk_json, targets_json FROM collection_task
      WHERE risk_json IS NOT NULL
      ORDER BY submitted_at DESC LIMIT ?`,
    [SITE_COOLDOWN_LOOKBACK],
  ).map(row => ({ risk: safeParse(row.risk_json, null), targets: safeParse(row.targets_json, []) }))

  for (const row of rows) {
    const hit = Array.isArray(row.targets)
      && row.targets.some(target => String(target?.marketplace ?? 'US').trim().toUpperCase() === site)
    if (!hit) continue
    const until = blankToNull(row.risk?.cooldownUntil)
    if (until === null) continue
    const remainingMs = new Date(until).getTime() - new Date(now).getTime()
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return blank
    /* The duration the block installed, next to how much of it is left. Both are
       needed to explain a refusal honestly: "至 <until>，还剩 12 分钟" says what
       is happening, "拦截一次装的是 60 分钟" says why waiting is the answer
       rather than retrying. `null` — not `0` — when the record does not name one:
       "no duration recorded" and "a duration of zero" are different claims. */
    const installed = Number(row.risk?.cooldownMinutes)
    return {
      active: true,
      since: row.risk?.since ?? null,
      until,
      minutesRemaining: Math.ceil(remainingMs / 60_000),
      minutes: Number.isFinite(installed) && installed >= 0 ? Math.trunc(installed) : null,
      reasons: Array.isArray(row.risk?.reasons) ? row.risk.reasons : [],
    }
  }
  return blank
}

/* ── the ten items ──────────────────────────────────────────────────────────── */

function checkRuntime() {
  return item('01-runtime', 'ok', `Node ${process.version} · ${process.platform}/${process.arch}`)
}

async function checkBrowser({ collector, chromePath }) {
  if (collector === null) {
    return unknownItem('02-browser', '本 profile 没有注入浏览器采集器，无法判定（这不等于浏览器有问题）')
  }
  const exe = findBrowser(chromePath ?? collector.chromePath)
  if (exe === null) {
    /* Not repairable: `launch_browser` refuses when there is nothing to launch,
       and marking it repairable would offer the user a button that cannot work.
       Installing a browser is the user's action, not ours. */
    return item('02-browser', 'fail', '未找到 Chrome/Edge 可执行文件；本插件不会静默下载，请先自行安装')
  }
  const version = await withDeadline(() => probeVersion(collector.host, collector.port, ENV_CHECK_TIMEOUT_MS))
  if (version === TIMED_OUT) return unknownItem('02-browser', `探测 ${collector.host}:${collector.port} 超过 ${ENV_CHECK_TIMEOUT_MS} ms 未返回`)
  if (version === null) {
    return item('02-browser', 'warn', `已找到浏览器（${exe}），但 CDP ${collector.host}:${collector.port} 还没起来；提交采集任务时会自动拉起`, {
      repairable: true, repairAction: 'launch_browser',
    })
  }
  return item('02-browser', 'ok', `CDP ${collector.host}:${collector.port} — ${version.Browser ?? '未报告版本'}（${exe}）`, {})
}

/**
 * Pull `--user-data-dir` out of one command line.
 *
 * The path itself may contain spaces, so "split on whitespace" is not enough:
 * `--user-data-dir` is the **last** switch on a browser's own launcher line
 * (Chromium appends it last when respawning, and our own launcher puts it
 * second — both covered because we stop at the first `/^--/` **after** it or
 * at end of line). Returns `null` when the switch is absent, which is a real
 * answer ("that process is not running a dedicated profile").
 */
export function userDataDirFromCommandLine(commandLine) {
  const match = /--user-data-dir=(?:"([^"]*)"|(\S+))/i.exec(String(commandLine ?? ''))
  const value = match?.[1] ?? match?.[2]
  if (value === undefined || value === null || value === '') return null
  return value
}

/**
 * The profile the browser on `host:port` is **actually** using, read from its
 * own process command line via the DevTools protocol (`Browser.getVersion`'s
 * `commandLine` field — Chrome exposes exactly this so automation does not
 * have to go and guess at process lists).
 *
 * Returns `null` rather than throwing when nothing is listening or the field
 * is absent: "we could not tell" is what the `unknown` state is for. A socket
 * is opened and closed for the one call — borrowing the collector's live
 * connection would make a health check hold a connection open it does not
 * own.
 */
export async function probeActualProfileDir(host, port, timeoutMs = ENV_CHECK_TIMEOUT_MS) {
  const version = await probeVersion(host, port, timeoutMs)
  const wsUrl = version?.webSocketDebuggerUrl
  if (typeof wsUrl !== 'string' || wsUrl === '') return null
  let connection = null
  try {
    connection = await CdpConnection.open(wsUrl, { timeoutMs })
    const result = await connection.send('Browser.getVersion', {}, { timeoutMs })
    return userDataDirFromCommandLine(result?.commandLine)
  } catch {
    return null
  } finally {
    try { connection?.close() } catch { /* already closing */ }
  }
}

async function checkProfile({ collector, dataDir }) {
  const configured = blankToNull(collector?.profileDir)
    ?? (blankToNull(dataDir) === null ? null : join(dataDir, 'chrome-profile'))
  let discovered = 0
  try {
    discovered = discoverProfiles().length
  } catch {
    /* Listing the user's own Chrome profiles is context, never a verdict. */
  }
  const tail = `（本机另有 ${discovered} 个浏览器 profile）`
  if (configured === null) return unknownItem('03-profile', '没有配置 dataDir，无法判定专用 profile 目录')

  /* 口径问题：launcher 遇到端口已有人会**收养**现成的浏览器，此时配置里的
     profileDir 从未被使用过——报「配置目录还不存在」是在陈述一个无效配置，
     而不是这台浏览器的事实。端口在听时先问浏览器自己（进程命令行的
     `--user-data-dir`）；问不到才退回配置口径，并把口径说在句子里。 */
  if (collector !== null && collector !== undefined) {
    const version = await withDeadline(() => probeVersion(collector.host, collector.port, ENV_CHECK_TIMEOUT_MS))
    if (version !== null && version !== TIMED_OUT) {
      const actual = await withDeadline(() => probeActualProfileDir(collector.host, collector.port, ENV_CHECK_TIMEOUT_MS))
      if (actual !== null && actual !== TIMED_OUT) {
        const adopted = actual !== configured ? `（端口上是被收养的浏览器；配置口径为 ${configured}）` : ''
        try {
          accessSync(actual, FS.W_OK)
          return item('03-profile', 'ok', `在用的 profile 目录可写：${actual}${adopted}${tail}`)
        } catch (error) {
          return item('03-profile', 'fail', `在用的 profile 目录不可写：${actual}（${errorCode(error)}）${adopted}${tail}`)
        }
      }
      /* 浏览器在听但不肯说（老版本、非 Chromium、或打桩的调试端口）：退回配置口径，
         并明说口径——不是「判不出」，而是「这一句是按配置说的」。 */
      return checkConfiguredProfileDir(configured, tail,
        `${collector.host}:${collector.port} 的浏览器没有报出自己的 --user-data-dir，以下按配置口径`)
    }
  }

  /* 端口没人在听：眼下没有在用的 profile，配置的目录就是下一次拉起时会用的事实。 */
  return checkConfiguredProfileDir(configured, tail, '浏览器未运行，配置口径')
}

/** The configured-directory verdict, with the口径 named in every sentence. */
function checkConfiguredProfileDir(configured, tail, basis) {
  try {
    accessSync(configured, FS.W_OK)
    return item('03-profile', 'ok', `专用 profile 目录可写：${configured}（${basis}）${tail}`)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return item('03-profile', 'warn', `专用 profile 目录还不存在（首次采集时会创建）：${configured}（${basis}）${tail}`, {
        repairable: true, repairAction: 'mkdir',
      })
    }
    return item('03-profile', 'fail', `专用 profile 目录不可写：${configured}（${errorCode(error)}）（${basis}）${tail}`, {
      repairable: true, repairAction: 'mkdir',
    })
  }
}

async function checkPort({ collector }) {
  if (collector === null) return unknownItem('04-port', '本 profile 没有注入浏览器采集器，无法探测 CDP 端口')
  const version = await withDeadline(() => probeVersion(collector.host, collector.port, ENV_CHECK_TIMEOUT_MS))
  if (version === TIMED_OUT) return unknownItem('04-port', `${collector.host}:${collector.port} 超过 ${ENV_CHECK_TIMEOUT_MS} ms 未响应`)
  if (version === null) {
    return item('04-port', 'fail', `${collector.host}:${collector.port} 未连通（CDP 无响应）`, {
      repairable: true, repairAction: 'reconnect_port',
    })
  }
  return item('04-port', 'ok', `${collector.host}:${collector.port} 已连通（${version.Browser ?? '未报告版本'}）`)
}

async function checkLogin({ collector }) {
  if (collector === null) return unknownItem('05-login', '本 profile 没有注入浏览器采集器，无法判定登录态')
  const health = await withDeadline(() => collector.healthCheck())
  if (health === TIMED_OUT) return unknownItem('05-login', `healthCheck 超过 ${ENV_CHECK_TIMEOUT_MS} ms 未返回`)
  const state = health?.login
  const detail = blankToNull(health?.detail)
  if (state === 'logged_in') return item('05-login', 'ok', detail ?? '上次采集已通过站点上下文校验，登录态可用')
  if (state === 'logged_out') {
    return item('05-login', 'fail', detail ?? '专用 profile 未登录该站点；请在本机采集浏览器窗口里手动登录后再重试')
  }
  /* `unknown` is **not** treated as "logged out". The product pages this batch
     collects are anonymous, and `unknown` means "no collection has established
     it yet" — parking every first-ever run in 待人工 would be a false alarm. The
     run path parks in `waiting_human` only on an explicit `logged_out`. */
  return item('05-login', 'warn', detail ?? '登录态尚未建立（前台商品页匿名可采，未登录不影响基础信息采集）')
}

function checkStorefront({ collector }) {
  const diagnostics = collector?.diagnostics?.()
  if (collector === null || diagnostics === undefined || diagnostics === null || diagnostics.at === null) {
    return unknownItem('06-storefront', '还没有采集过，站点上下文未经校验')
  }
  if (diagnostics.storefrontMiss > 0) {
    return item('06-storefront', 'fail',
      `${diagnostics.at} 有 ${diagnostics.storefrontMiss} 个目标落在错误的站点/语言/币种上（已拒收不写库）`, {
        repairable: true, repairAction: 'set_context',
      })
  }
  const adjusted = diagnostics.storefrontAdjusted > 0 ? `；其中 ${diagnostics.storefrontAdjusted} 个调整过配送地址/界面语言` : ''
  return item('06-storefront', 'ok', `${diagnostics.at} 采集成功 ${diagnostics.ok} 个，站点上下文校验通过${adjusted}`)
}

function checkDataDir({ store, dataDir }) {
  const targets = []
  if (blankToNull(dataDir) !== null) targets.push({ what: 'dataDir', path: dataDir })
  if (store !== null) {
    try {
      const resolved = resolveImportDir(store)
      targets.push({ what: '导入目录', path: resolved.path })
    } catch (error) {
      targets.push({ what: '导入目录', path: null, error: errorCode(error) })
    }
  }
  if (targets.length === 0) return unknownItem('07-datadir', '没有配置 dataDir，无法判定')

  const verdicts = []
  let worst = 'ok'
  for (const target of targets) {
    if (target.path === null || target.path === undefined) {
      verdicts.push(`${target.what}: 无法解析（${target.error ?? '未知'}）`)
      worst = 'fail'
      continue
    }
    try {
      accessSync(target.path, FS.W_OK)
      verdicts.push(`${target.what}: 可写 ${target.path}`)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        verdicts.push(`${target.what}: 不存在（可创建）${target.path}`)
        if (worst === 'ok') worst = 'warn'
      } else {
        verdicts.push(`${target.what}: 不可写 ${target.path}（${errorCode(error)}）`)
        worst = 'fail'
      }
    }
  }
  /* Both directories are repairable with `mkdir`, including the failing case:
     the mkdir action creates the path and the round then re-reads it, which is
     what turns "repairable" into a claim the recheck can falsify. An item that
     is already `ok` names no fix, so it is not counted as repairable — a
     "repairable" count that includes healthy items is a number about nothing. */
  return item('07-datadir', worst, verdicts.join('；'), worst === 'ok'
    ? {}
    : { repairable: true, repairAction: 'mkdir' })
}

function checkScheme({ store }) {
  if (store === null) return unknownItem('08-scheme', '没有库，无法判定采集方案')
  const active = listSchemes(store, { status: 'active' })
  if (active.length === 0) {
    return item('08-scheme', 'warn', '还没有可用的采集方案（draft 方案不能选；用 amzn_collect_scheme_save 建一份并 verify）')
  }
  const unverified = active.filter(scheme => scheme.verifiedAt === null)
  if (unverified.length > 0) {
    return item('08-scheme', 'warn', `${active.length} 份可用方案里有 ${unverified.length} 份没有验证时间戳（当时未走过 verify）`)
  }
  const newest = active.map(scheme => scheme.verifiedAt).sort().at(-1)
  return item('08-scheme', 'ok', `${active.length} 份可用方案，最近验证 ${newest}`)
}

function checkProxy() {
  /* Adjudication §3 / contract §9-O4: the repo has no proxy implementation at
     all, so this item is permanently `unknown` and says so. A tick here would be
     a check that never ran. */
  return unknownItem('09-proxy', '未配置代理（本版采集不走代理）')
}

function checkCooldown({ store, marketplace, now, collector = null }) {
  /* `now` arrives as `null` when the caller has no opinion about the clock —
     that is `runEnvCheck`'s documented default, and line 410 below branches on
     exactly that. Passing it on would **override** `siteCooldown`'s own
     `now = new Date()` default with `new Date(null)`, i.e. the epoch, and the
     health check would print "about 29 860 089 minutes" (~57 years).
     Measured on a store with a live cooldown:
       siteCooldown(store, 'US')             -> 30        (correct)
       siteCooldown(store, 'US', null)       -> 29860069  (the bug)
       siteCooldown(store, 'US', new Date()) -> 30        (correct)
     Only pass an instant we actually have. The *judgement* path
     (`submitCollectionTask`) never passes `now`, so it was never affected —
     this is a display defect, and it stays a display fix. */
  const state = now === null || now === undefined
    ? siteCooldown(store, marketplace)
    : siteCooldown(store, marketplace, now)

  /* The blocked page the collector is deliberately keeping open for the person
     (see `blocked-page.js`). It belongs on this item and not on a new one: the
     cooldown **is** the block's aftermath, the ten items are a closed list
     (contract §6.2.1), and inventing an eleventh would change a contract the
     page and the tools both read.

     Two different things are gathered here, and folding them together is how a
     check starts lying:
       · `action` — a page **is** being kept and a person has something to click.
         That alone justifies `warn`: a green tick sitting next to a pending human
         action is the silent-failure shape this check exists to remove.
       · `unreadable` — we could not tell (no collector injected, or no snapshot
         to read). That is a note, not a verdict: it must not turn a healthy site
         into a warning, and it must not read as "there is no blocked page". */
  let action = null
  let unreadable = null
  if (collector === null || collector === undefined) {
    unreadable = '这一轮没有注入浏览器采集器，读不到「被拦的那一页还在不在」'
  } else {
    const kept = liveBlockedPage(collector.diagnostics?.() ?? null, { marketplace })
    if (kept !== null) {
      action = `站点返回了拦截页，浏览器里那一页还开着（CDP target ${kept.targetId ?? '未记录'}）：`
        + `在那一页上点「${kept.continueLabel ?? CONTINUE_CONTROL_LABEL}」，然后重跑`
    } else {
      unreadable = '采集器还在跑，但它的诊断里没有留着的被拦页（也可能只是没被拦过）'
    }
  }

  const suffix = [action, unreadable].filter(part => part !== null).map(part => `；${part}`).join('')
  if (!state.active) {
    if (action !== null) return item('10-cooldown', 'warn', `${marketplace} 没有生效中的站点冷却${suffix}`)
    return item('10-cooldown', 'ok', `${marketplace} 没有生效中的站点冷却${suffix}`)
  }
  const installed = state.minutes === null ? '时长未记录' : `${state.minutes} 分钟`
  return item('10-cooldown', 'warn',
    `${marketplace} 站点冷却中：至 ${state.until}（约 ${state.minutesRemaining} 分钟；拦截一次装的是 ${installed}）`
    + `${state.reasons.length > 0 ? ` — ${state.reasons.join('；')}` : ''}`
    + '。冷却期内提交会被拒（code COOLING_DOWN），等它走完再重跑（本插件不会替你清掉冷却）'
    + `${suffix}`)
}

/* ── the round ──────────────────────────────────────────────────────────────── */

/**
 * Run the ten items (or a subset) and report.
 *
 * Writes `collection_env_check` (one row per item, one `checked_at` for the
 * round) and, when a `taskId` is given, the task's `env_check_json` +
 * `env_checked_at`. Those are the summary on the task and the detail in the
 * table — the same division the schema documents.
 */
export async function runEnvCheck({
  store = null, collector = null, dataDir = null, chromePath = null,
  marketplace = 'US', taskId = null, checks = null, repair = false, confirm = false,
  logger = null, now = null,
} = {}) {
  const site = String(marketplace ?? 'US').trim().toUpperCase() || 'US'
  if (!Object.prototype.hasOwnProperty.call(MARKETPLACES, site)) {
    return {
      ok: false,
      code: 'MARKETPLACE_UNKNOWN',
      error: `unknown marketplace "${marketplace}"`,
      hint: `known marketplaces: ${Object.keys(MARKETPLACES).join(', ')}`,
    }
  }
  const task = blankToNull(taskId)
  if (task !== null) {
    if (store === null || getCollectionTask(store, task) === undefined) {
      return { ok: false, code: 'TASK_NOT_FOUND', error: `no collection task "${task}"` }
    }
  }

  /* An empty array means "run all ten" — never "run none". A caller that sends
     `[]` is asking for the default, and reading it as an empty round would make
     the panel show a spotless environment that nothing measured. */
  let selected = ENV_CHECK_IDS
  if (Array.isArray(checks) && checks.length > 0) {
    const unknown = checks.map(value => String(value ?? '').trim()).filter(id => id !== '' && !isEnvCheckId(id))
    if (unknown.length > 0) {
      return {
        ok: false,
        code: 'UNKNOWN_CHECK_ID',
        error: `unknown check id(s): ${unknown.join(', ')}`,
        hint: `known checks: ${ENV_CHECK_IDS.join(', ')}`,
      }
    }
    selected = ENV_CHECK_IDS.filter(id => checks.map(value => String(value ?? '').trim()).includes(id))
  }

  const checkedAt = now === null ? new Date().toISOString() : new Date(now).toISOString()
  const context = { store, collector, dataDir, chromePath, marketplace: site, now }
  const runners = {
    '01-runtime': () => checkRuntime(),
    '02-browser': () => checkBrowser(context),
    '03-profile': () => checkProfile(context),
    '04-port': () => checkPort(context),
    '05-login': () => checkLogin(context),
    '06-storefront': () => checkStorefront(context),
    '07-datadir': () => checkDataDir(context),
    '08-scheme': () => checkScheme(context),
    '09-proxy': () => checkProxy(),
    '10-cooldown': () => checkCooldown(context),
  }

  const results = []
  for (const id of selected) {
    try {
      results.push(await runners[id]())
    } catch (error) {
      /* A probe that throws is "we could not tell", not "the environment is
         broken": the difference is exactly what the four-state vocabulary is
         for, and swallowing it into `fail` would blame the user's machine for
         our bug. */
      logger?.warn?.(`[amazon-ops] env check ${id} failed: ${error.message}`)
      results.push(unknownItem(id, `检查本身出错：${error.message}`))
    }
  }

  const repairs = []
  if (repair === true) {
    for (const check of results) {
      if (!check.repairable || check.status === 'ok') continue
      const outcome = await repairEnvironment({
        store, collector, dataDir, chromePath, action: check.repairAction, marketplace: site, confirm, logger, now: checkedAt,
      })
      repairs.push({ id: check.id, action: check.repairAction, ok: outcome.ok === true, code: outcome.code ?? null, detail: outcome.detail ?? outcome.error ?? null })
      if (outcome.ok === true && outcome.checkedAfter?.[check.id] !== undefined) {
        const index = results.indexOf(check)
        results[index] = outcome.checkedAfter[check.id]
      }
    }
  }

  const summary = envSummaryOf(results)

  if (store !== null) {
    /* The item shape above is the **contract's** (`id`, as §6.2.1 prints it); the
       store's row shape is `checkId` plus its own generated primary key. Both
       halves matter: without the rename the round throws `checkId is required`,
       and spreading the item wholesale would put the item's `id` (`"03-profile"`)
       into the row's primary key — so the second round for the same item collides
       on `UNIQUE (id)` instead of upserting. The mapping is written out field by
       field rather than spread for exactly that reason. */
    recordEnvCheckRound(store, {
      taskId: task,
      checks: results.map(check => ({
        checkId: check.id,
        status: check.status,
        detail: check.detail,
        repairable: check.repairable,
        repairAction: check.repairAction,
        risk: check.risk,
      })),
      checkedAt,
    })
    if (task !== null) {
      updateCollectionTask(store, task, {
        env_check_json: JSON.stringify({
          checkedAt,
          marketplace: site,
          summary,
          /* The summary shape on the task is the ten items' status only — the
             detail (selector hits, paths, versions) lives in the table, so the
             task row cannot grow to the size of the table. */
          checks: results.map(check => ({ id: check.id, status: check.status, detail: check.detail })),
        }),
        env_checked_at: checkedAt,
      })
    }
  }

  return {
    ok: true,
    checkedAt,
    marketplace: site,
    taskId: task,
    summary,
    checks: results,
    repairs,
    /* Every `fail` the caller must act on. Repairable ones are **not** here: the
       run path tries to repair those once (contract §5.2) rather than parking. */
    blocking: results.filter(check => check.status === 'fail' && !check.repairable).map(check => check.id),
    loginBlocked: results.some(check => check.id === '05-login' && check.status === 'fail'),
  }
}

/* ── repairs ────────────────────────────────────────────────────────────────── */

/** Actions that need a browser to exist at all. */
const BROWSER_ACTIONS = ['launch_browser', 'reconnect_port', 'set_context']

/** Keys whose presence means "you are trying to hand us a credential". */
const CREDENTIAL_KEYS = ['password', 'passwd', 'pwd', 'username', 'user', 'credential', 'credentials', 'token', 'secret', 'apiKey', 'api_key']

/** Keys whose presence means "you are trying to make us kill a process". */
const PROCESS_KEYS = ['pid', 'kill', 'processId', 'process']

function hasNonEmptyKey(source, keys) {
  if (source === null || typeof source !== 'object') return false
  return keys.some(key => {
    const value = source[key]
    if (value === undefined || value === null) return false
    if (typeof value === 'string') return value.trim() !== ''
    return true
  })
}

/**
 * The four standing refusals (F04-02's禁令), each as a **code**.
 *
 * Each condition is one the code can actually detect — the alternative (declare
 * the codes and never return them) is an enum nobody can branch on. In order:
 *
 *   · `BROWSER_NOT_INSTALLED` — an action that needs a browser, on a machine
 *     with no browser. The hint says the user installs it; we never download.
 *   · `CREDENTIALS_REQUIRED` — the call carries a credential field. We do not
 *     take credentials at all: the login is done by the person, in the window.
 *   · `PROCESS_KILL_REFUSED` — the call names a process to kill. We only ever
 *     drop *our own* CDP socket (`reconnect_port`); killing a Chrome we did not
 *     start is how a user loses their own session.
 *   · `CAPTCHA_NOT_BYPASSABLE` — the last run saw a bot check, or the caller
 *     asked us to bypass one. This is not a capability we are missing; it is one
 *     we decline.
 */
export function repairRefusal({ action, args = {}, collector = null, chromePath = null }) {
  if (BROWSER_ACTIONS.includes(action) && findBrowser(chromePath ?? collector?.chromePath) === null) {
    return {
      ok: false,
      code: 'BROWSER_NOT_INSTALLED',
      error: '找不到 Chrome/Edge 可执行文件',
      hint: '请先自行安装浏览器；本插件不会静默下载',
    }
  }
  if (hasNonEmptyKey(args, CREDENTIAL_KEYS)) {
    return {
      ok: false,
      code: 'CREDENTIALS_REQUIRED',
      error: '本插件不接受账号密码',
      hint: '请在本机浏览器窗口手动登录',
    }
  }
  if (hasNonEmptyKey(args, PROCESS_KEYS)) {
    return {
      ok: false,
      code: 'PROCESS_KILL_REFUSED',
      error: '不杀未知浏览器进程',
      hint: '不杀未知浏览器进程',
    }
  }
  /* 明确「要求绕过验证码」的两条：与状态无关，永远拒。 */
  if (args?.bypassCaptcha === true || args?.captcha === true) {
    return {
      ok: false,
      code: 'CAPTCHA_NOT_BYPASSABLE',
      error: '目标页是验证码/反机器人页',
      hint: '不绕过验证码',
    }
  }
  /* T-1（P0）：`blocked` 是**进程级累计**（`collector.js:117` init、`:445` 只增、
     复位清单不含它）。原先这里写 `blocked ?? 0` 并用 `blocked > 0` 当「当前页是验证码页」，
     后果是：**这个进程里被拦过一次之后，连 `mkdir`（纯文件系统动作）都会被永久拒掉**，
     而文案还说「目标页是验证码页」——那时页面早关了。

     现在分三态：
       · `blockedThisRun > 0`（本轮真被拦过）→ 拒；
       · 读数明确为 0 → 放行；
       · **读不到 / 不是数字** → 状态未知：`mkdir` / `launch_browser` / `reconnect_port`
         放行（三个都不打开站点页面），`set_context` 拒绝 —— 它是唯一真会 `navigate`
         进站并操作配送地址对话框的动作，风控未知时进站是唯一有代价的那个。 */
  const snapshot = typeof collector?.diagnostics === 'function' ? collector.diagnostics() : null
  const perRun = snapshot !== null && typeof snapshot?.blockedThisRun === 'number'
    ? snapshot.blockedThisRun
    : null
  const cumulative = snapshot !== null && typeof snapshot?.blocked === 'number' ? snapshot.blocked : null
  const blockedNow = perRun ?? cumulative

  if (blockedNow === null) {
    if (action === 'set_context') {
      return {
        ok: false,
        code: 'REPAIR_UNVERIFIED',
        error: '读不到浏览器状态，无法确认目标页是不是验证码页',
        hint: 'set_context 会真的导航进 Amazon 站点，状态未知时不放行；先跑一次环境检查',
      }
    }
    return null
  }
  if (blockedNow > 0) {
    return {
      ok: false,
      code: 'CAPTCHA_NOT_BYPASSABLE',
      error: '目标页是验证码/反机器人页',
      hint: '不绕过验证码',
    }
  }
  return null
}

/** The items a repair action is expected to move, and which are re-read after it. */
export const REPAIR_AFFECTS = {
  mkdir: ['03-profile', '07-datadir'],
  launch_browser: ['02-browser', '04-port'],
  reconnect_port: ['02-browser', '04-port'],
  set_context: ['06-storefront'],
}

/**
 * Execute one repair action and re-read the items it was supposed to move.
 *
 * Re-reading is part of the contract (§6.2.2: 修复后重跑受影响的体检项): without
 * it, "the repair ran" and "the repair worked" are the same answer, and the
 * caller has to go and ask again — which is how a fix that did nothing looks
 * like a fix.
 */
export async function repairEnvironment({
  store = null, collector = null, dataDir = null, chromePath = null,
  action, marketplace = 'US', postalCode = null, profileDir = null, confirm = false,
  logger = null, now = null, args = {},
} = {}) {
  const chosen = String(action ?? '').trim()
  if (!COLLECTION_REPAIR_ACTIONS.includes(chosen)) {
    return {
      ok: false,
      code: 'UNKNOWN_ACTION',
      error: `unknown repair action "${action}"`,
      hint: `known actions: ${COLLECTION_REPAIR_ACTIONS.join(', ')}`,
    }
  }

  const refusal = repairRefusal({ action: chosen, args, collector, chromePath })
  if (refusal !== null) return refusal

  /* A GUI window on the user's screen is the one action here that is visible
     without being asked for, so it is the one that asks. Same mechanism as the
     batch gate (`domain/approval/policy.js`), and deliberately **no new setting**
     — this batch does not widen the settings surface. */
  if (chosen === 'launch_browser' && confirm !== true) {
    return {
      ok: false,
      code: 'APPROVAL_REQUIRED',
      error: 'launch_browser 会在桌面上打开一个浏览器窗口',
      hint: '确认要打开就再调一次并带 confirm: true',
    }
  }

  const changed = []
  let detail = null
  try {
    if (chosen === 'mkdir') {
      const target = blankToNull(profileDir)
        ?? (blankToNull(dataDir) === null ? null : join(dataDir, 'chrome-profile'))
      if (target === null) {
        return { ok: false, code: 'REPAIR_FAILED', error: 'mkdir 需要 profileDir 或 dataDir' }
      }
      const existed = existsSync(target)
      mkdirSync(target, { recursive: true })
      if (!existed) changed.push({ what: 'mkdir', from: '不存在', to: target })
      detail = existed ? `目录已存在，未改动：${target}` : `已创建目录：${target}`
    } else if (chosen === 'launch_browser') {
      if (collector === null) return { ok: false, code: 'REPAIR_FAILED', error: '本 profile 没有注入浏览器采集器' }
      const { version } = await ensureBrowser({
        host: collector.host,
        port: collector.port,
        profileDir: collector.profileDir,
        exePath: chromePath ?? collector.chromePath,
        logger: logger ?? undefined,
      })
      changed.push({ what: 'launch_browser', from: '未运行', to: `${collector.host}:${collector.port}` })
      detail = `已启动采集浏览器：${version?.Browser ?? '未报告版本'}`
    } else if (chosen === 'reconnect_port') {
      if (collector === null) return { ok: false, code: 'REPAIR_FAILED', error: '本 profile 没有注入浏览器采集器' }
      /* Only our own socket is dropped. `close()` exists exactly for this and the
         next collection reconnects on demand (see collector.close's note). */
      collector.close()
      const version = await probeVersion(collector.host, collector.port, ENV_CHECK_TIMEOUT_MS)
      if (version === null) {
        await ensureBrowser({
          host: collector.host,
          port: collector.port,
          profileDir: collector.profileDir,
          exePath: chromePath ?? collector.chromePath,
          logger: logger ?? undefined,
        })
        changed.push({ what: 'reconnect_port', from: 'CDP 无响应', to: '已重新拉起浏览器' })
      } else {
        changed.push({ what: 'reconnect_port', from: '旧连接已断开', to: `${collector.host}:${collector.port}` })
      }
      detail = '已丢弃旧 CDP 连接并重新探测端口'
    } else if (chosen === 'set_context') {
      if (collector === null) return { ok: false, code: 'REPAIR_FAILED', error: '本 profile 没有注入浏览器采集器' }
      const site = String(marketplace ?? 'US').trim().toUpperCase()
      const storefront = storefrontFor(site)
      const override = blankToNull(postalCode)
      const applied = override === null ? storefront : { ...storefront, postalCode: override }
      const home = `https://${storefront.domain}/`
      const outcome = await collector.withPage(async (cdp, page) => {
        await applyStorefront(cdp, page.sessionId, storefront)
        await navigate(cdp, page.sessionId, home, { timeoutMs: 45_000 })
        const session = await ensureStorefront(cdp, page.sessionId, applied, { logger: logger ?? console })
        const state = await readState(cdp, page.sessionId)
        return { session, state }
      })
      changed.push({ what: 'set_context', from: '未套用', to: `${storefront.code} ${storefront.domain}` })
      if (outcome?.session?.problems?.length > 0) {
        /* The dialog reported trouble. That is not a thrown error, and calling it
           a success because the call returned would be the lie the recheck below
           is designed to catch — so it is named in the detail as well. */
        detail = `已套用站点上下文 ${storefront.code}，但页面报告：${outcome.session.problems.join('；')}`
      } else {
        detail = `已套用站点上下文：${storefront.code}（${storefront.domain}），配送地址 ${outcome?.state?.deliveryLocation ?? '读取不到'}`
      }
    }
  } catch (error) {
    return {
      ok: false,
      code: 'REPAIR_FAILED',
      error: `${chosen} 执行失败：${error.message}`,
      hint: '动作执行了但没成功；先看体检项详情，再决定是否需要人工处理',
    }
  }

  const affected = REPAIR_AFFECTS[chosen] ?? []
  const after = await runEnvCheck({
    store, collector, dataDir, chromePath, marketplace, checks: affected, now,
  })
  const checkedAfter = {}
  if (after.ok === true) {
    for (const check of after.checks) checkedAfter[check.id] = check
  }

  const stillBad = affected.filter(id => checkedAfter[id] !== undefined && checkedAfter[id].status !== 'ok')
  if (stillBad.length > 0) {
    return {
      ok: false,
      code: 'REPAIR_FAILED',
      action: chosen,
      changed,
      detail,
      checkedAfter,
      error: `修复后复查仍有未通过项：${stillBad.map(id => `${id}=${checkedAfter[id].status}`).join(', ')}`,
    }
  }

  return { ok: true, action: chosen, changed, detail, checkedAfter }
}

/* Re-exported so a caller that only needs the vocabulary does not have to import
   the risk levels from two places. */
export { COLLECTION_RISK_LEVELS }
