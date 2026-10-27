/**
 * The twelve collection-centre tools (module 04 F04-01…F04-10; contract §6.2).
 *
 * ## One implementation, two doors
 *
 * Every one of these is a thin wrapper over a domain function that the page's
 * route also calls (`src/web/routes.js` calls the very same functions). That is
 * the repo's standing anti-drift rule: a panel button and a tool call must be the
 * same operation, and the only way to guarantee it is for the code to be the same
 * code.
 *
 * ## Every tool returns structure, and a `text` for the model
 *
 * `render` prints `value.text`. The structured half rides along because it has
 * readers that are not the model: the audit funnel reads a **creation's id** out
 * of the result (`domain/audit/targets.js:65`), and the page's route hands the
 * object straight to the browser. A tool that returned only prose would leave
 * `audit_log.object_id` null forever — which is what happened to every creation
 * tool before the ids were put back into their results.
 *
 * ## Nothing here throws
 *
 * A tool that throws kills the turn. Every refusal is `{ok:false, code, error,
 * hint}` (contract §6.1), including the ones the domain layer signals with an
 * exception.
 */

import { table, text, truncate, yes } from './render.js'
import { runEnvCheck, repairEnvironment } from '../domain/collect/env.js'
import { previewCollection } from '../domain/collect/preview.js'
import { buildSectionDetail } from '../domain/collect/detail.js'
import { resolveWaiting } from '../domain/collect/waiting.js'
import { schemeList, schemeSave, schemeTransition, planList, planSave } from '../domain/collect/scheme.js'
import { sectionLabel } from '../domain/collect/sections.js'
import { countSectionResults } from '../store/collection-section.js'

const output = { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) }

/** The deps every tool in this file is built with. Named once so a new one cannot forget. */
function context(deps) {
  return {
    store: deps.store,
    collector: deps.collector ?? null,
    dataDir: deps.dataDir ?? null,
    chromePath: deps.chromePath ?? null,
    collection: deps.collection ?? null,
    sources: deps.sources ?? null,
  }
}

/** A refusal, with the code the caller branches on. */
function refuse(result) {
  return { ok: false, code: result.code ?? null, error: result.error, hint: result.hint ?? null, ...pickExtras(result) }
}

function pickExtras(result) {
  const extras = {}
  for (const key of ['allowed', 'status', 'invalid', 'checks', 'failures', 'envSummary', 'keptSections', 'login', 'detail']) {
    if (result[key] !== undefined) extras[key] = result[key]
  }
  return extras
}

/* ── F04-01 / F04-02 ────────────────────────────────────────────────────────── */

export function collectEnvCheckTool(deps) {
  return {
    name: 'amzn_collect_env_check',
    description:
      'Run the ten-item collection environment check (runtime / browser / profile / CDP port / login / storefront / data dirs / scheme / proxy / cooldown) '
      + 'and report each item with a machine status. Reads only **the environment**: it never changes the environment unless repair=true, which attempts the repairable failures once. But a call is **not** side-effect free in the library — every round is recorded: ten rows in `collection_env_check` (one per check) plus one audit row. So calling it repeatedly leaves a trail by design. '
      + 'The proxy item is always `unknown` because this version does not go through a proxy — it says so rather than drawing a tick. '
      + 'Use it before a batch, when collection fails with an environment error, or to answer "why will this not run".',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Attach the round to this task. Omit for an independent check.' },
        marketplace: { type: 'string', description: 'Marketplace whose storefront/login is judged. Default US.' },
        repair: { type: 'boolean', description: 'Default false. true attempts the repairable failures once and re-reads them.' },
        checks: { type: 'array', items: { type: 'string' }, description: 'Run only these check ids. Empty or omitted runs all ten.' },
      },
    },
    output,
    async execute(args) {
      const result = await runEnvCheck({
        ...context(deps),
        marketplace: args?.marketplace ?? 'US',
        taskId: args?.taskId ?? null,
        checks: Array.isArray(args?.checks) ? args.checks : null,
        repair: args?.repair === true,
      })
      if (result.ok !== true) return refuse(result)
      return { ...result, text: renderEnvCheck(result) }
    },
  }
}

export function collectRepairTool(deps) {
  return {
    name: 'amzn_collect_repair',
    description:
      'Execute one environment repair action and re-read the items it was supposed to move. Actions: mkdir (create a directory), '
      + 'launch_browser (open the collection browser — needs confirm:true), reconnect_port (drop our own CDP socket and re-probe), '
      + 'set_context (apply a site\'s storefront context in the browser). '
      + 'Four things are refused with a code rather than attempted: installing a browser, taking a password, killing a browser process we did not start, '
      + 'and getting past a captcha. Nothing is downloaded, typed or killed.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['mkdir', 'launch_browser', 'reconnect_port', 'set_context'] },
        marketplace: { type: 'string', description: 'set_context only. Default US.' },
        postalCode: { type: 'string', description: 'set_context only: override the site\'s default delivery postal code.' },
        profileDir: { type: 'string', description: 'mkdir only. Default <dataDir>/chrome-profile.' },
        confirm: { type: 'boolean', description: 'launch_browser opens a GUI window, so it requires confirm:true.' },
      },
      required: ['action'],
    },
    output,
    async execute(args) {
      const result = await repairEnvironment({ ...context(deps), ...args, args })
      if (result.ok !== true) return refuse(result)
      return { ...result, text: renderRepair(result) }
    },
  }
}

/* ── F04-03 / F04-04 ────────────────────────────────────────────────────────── */

const RUN_PARAMETERS = {
  source: { type: 'string', description: 'Source id. Default browser-local.' },
  targets: {
    type: 'array',
    description: 'What to collect. `side` marks the ASIN as ours or a competitor\'s (ownership level 1).',
    items: {
      type: 'object',
      properties: {
        asin: { type: 'string' },
        marketplace: { type: 'string' },
        side: { type: 'string', enum: ['self', 'competitor'] },
      },
    },
  },
  asins: { type: 'array', items: { type: 'string' }, description: 'Shorthand: a list of ASINs, all on `marketplace`.' },
  selfAsins: { type: 'array', items: { type: 'string' }, description: 'The 自有 box of the form.' },
  competitorAsins: { type: 'array', items: { type: 'string' }, description: 'The 竞品 box of the form.' },
  marketplace: { type: 'string', description: 'Marketplace for the shorthand boxes. Default US.' },
  postalCode: { type: 'string', description: 'Delivery postal code to use for this run.' },
  schemeId: { type: 'string', description: 'Collection scheme to freeze for this task.' },
  schemeVersion: { type: 'number', description: 'Scheme version. Defaults to the scheme\'s newest.' },
  fields: { type: 'array', items: { type: 'string' }, description: 'Only collect these fields. Omit for the source\'s full set (or the prefill\'s range).' },
  reuseFreshSnapshots: { type: 'boolean', description: 'Default true: report snapshots young enough to reuse.' },
  freshnessDays: { type: 'number', description: 'Reuse/prefill freshness window in days. Default 7.' },
}

export function collectPreviewTool(deps) {
  return {
    name: 'amzn_collect_preview',
    description:
      'Preview a collection before submitting it: how many valid ASINs, which are duplicated, which have no settled ownership, how many page requests '
      + 'it will cost, what the risk is, and which snapshots are fresh enough to reuse. Read-only and fast — it never opens a browser and never writes a task. '
      + 'Call it before a batch so the user sees the same five numbers the submission will act on.',
    parameters: { type: 'object', properties: RUN_PARAMETERS },
    output,
    async execute(args) {
      const result = previewCollection({ store: deps.store, sources: deps.sources, args })
      if (result.ok !== true) return refuse(result)
      return { ...result, text: renderPreview(result) }
    },
  }
}

export function collectRunTool(deps) {
  return {
    name: 'amzn_collect_run',
    description:
      'Start a collection the way the panel does: resolve the targets\' ownership, validate the source and the fields, run the environment check, judge the '
      + 'site cooldown and the plan window, then either queue the task or park it in `checking_env` / `cooling_down` / `waiting_human` with the reason. '
      + 'Returns immediately with the task id — the work runs in the background. A draft (draft:true) is stored and never queued. '
      + 'A batch of more than one target may need confirm:true. It never bypasses a captcha and never retries a blocked site.',
    parameters: {
      type: 'object',
      properties: {
        ...RUN_PARAMETERS,
        perTaskMax: { type: 'number', description: 'Raise the per-task cap for this submission.' },
        humanize: { type: 'boolean', description: 'Dispatch mouse movement and scrolling for this run.' },
        strictStorefront: { type: 'boolean', description: 'Refuse targets that landed on a different storefront. Default true.' },
        sourceContextId: { type: 'string', description: 'Which external entry this came from. Sets the prefill\'s default field range and leaves a trace of what changed.' },
        draft: { type: 'boolean', description: 'Store the form as a draft and do not queue it.' },
        retryOf: { type: 'string', description: 'The task this one retries (a retry is a NEW task; the old one is never edited).' },
        confirm: { type: 'boolean', description: 'Confirms a batch (>1 target) when the workspace turned on the 批量采集 gate.' },
      },
    },
    output,
    async execute(args) {
      if (deps.collection?.submitCollectionTask === undefined) {
        return { ok: false, error: 'no collection service is registered in this profile' }
      }
      const result = await deps.collection.submitCollectionTask(args ?? {})
      if (result.ok !== true) {
        return {
          ...refuse(result),
          taskId: result.taskId ?? null,
          risk: result.risk ?? null,
          preview: result.preview ?? null,
          text: renderRun(result),
        }
      }
      return { ...result, text: renderRun(result) }
    },
  }
}

/* ── F04-05 / F04-06 ────────────────────────────────────────────────────────── */

export function collectCancelTool(deps) {
  return {
    name: 'amzn_collect_cancel',
    description:
      'Cancel a collection task. Cancelling stops what has NOT happened yet and keeps everything already collected — the section rows are never deleted. '
      + 'A task that is already terminal (done / cancelled) is refused with NOT_CANCELLABLE; a partial or failed task is retried by starting a new one, not by cancelling it. '
      + 'It reports how many section rows were kept, because "kept the data" is the point of this operation.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string', description: 'Why it is being cancelled. Recorded in the task history.' },
      },
      required: ['taskId'],
    },
    output,
    async execute(args) {
      if (deps.collection?.cancel === undefined) return { ok: false, error: 'no collection service is registered in this profile' }
      const before = countSectionResults(deps.store, { taskId: String(args?.taskId ?? '') })
      const result = deps.collection.cancel(String(args?.taskId ?? ''), { reason: args?.reason ?? null, source: 'plugin' })
      if (result.ok !== true) return refuse(result)
      const kept = countSectionResults(deps.store, { taskId: String(args?.taskId ?? '') })
      return {
        ...result,
        keptSections: kept,
        note: result.note ?? null,
        text: `任务 ${result.taskId}：${result.status === 'cancelled' ? '已取消' : '已请求停止'}\n`
          + `保留已采节 ${kept} 行（取消前 ${before} 行，一行都没删）。\n`
          + `${result.note ?? ''}`,
      }
    },
  }
}

export function collectWaitingResolveTool(deps) {
  return {
    name: 'amzn_collect_waiting_resolve',
    description:
      'Answer a task that is waiting for a person. The action must match the task\'s trigger: profile-logged-out accepts open-browser / recheck, '
      + 'login-wall accepts resume, plan-window accepts force-resume, and abandon works for all three (it needs a reason). '
      + 'open-browser only opens the window — it never types a credential. Every exit keeps the sections already collected. '
      + 'A waiting task times out after 30 minutes of no action and is cancelled, keeping its data.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        action: { type: 'string', enum: ['resume', 'recheck', 'open-browser', 'force-resume', 'abandon'] },
        reason: { type: 'string', description: 'Required for action "abandon".' },
      },
      required: ['taskId', 'action'],
    },
    output,
    async execute(args) {
      const result = await resolveWaiting({
        ...context(deps),
        taskId: args?.taskId,
        action: args?.action,
        reason: args?.reason ?? null,
      })
      if (result.ok !== true) return refuse(result)
      return { ...result, text: `${result.note ?? '已处置'}\n状态: ${result.status}    保留已采节: ${result.keptSections ?? 0} 行` }
    },
  }
}

/* ── F04-07 ─────────────────────────────────────────────────────────────────── */

export function collectDetailTool(deps) {
  return {
    name: 'amzn_collect_detail',
    description:
      'Read the thirteen collection sections of one ASIN in one task, or the per-ASIN summary of the whole task when `asin` is omitted. '
      + 'Each section carries one of five states: collected / missing (the page really has none) / partial / failed (we could not tell) / blocked (a bot check or login wall stopped it). '
      + 'A section that was never attempted comes back with status null and notCollected:true — it is NOT reported as missing. '
      + '`includeRaw` is off by default because raw bodies can be large.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        asin: { type: 'string', description: 'Omit to get one summary per ASIN instead of the section detail.' },
        marketplace: { type: 'string' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Only these section ids.' },
        includeRaw: { type: 'boolean', description: 'Default false.' },
        includeDiff: { type: 'boolean', description: 'Default true: the changed/added/removed lists against the previous snapshot.' },
      },
      required: ['taskId'],
    },
    output,
    async execute(args) {
      const result = buildSectionDetail({
        store: deps.store,
        taskId: args?.taskId,
        asin: args?.asin ?? null,
        marketplace: args?.marketplace ?? null,
        sections: Array.isArray(args?.sections) ? args.sections : null,
        includeRaw: args?.includeRaw === true,
        includeDiff: args?.includeDiff !== false,
      })
      if (result.ok !== true) return refuse(result)
      return { ...result, text: renderDetail(result) }
    },
  }
}

/* ── F04-09 / F04-10 ────────────────────────────────────────────────────────── */

export function collectSchemeListTool(deps) {
  return {
    name: 'amzn_collect_scheme_list',
    description:
      'List collection schemes — what can be selected for a run, one row per scheme (its newest version) unless includeVersions is set. '
      + 'Each row carries `usage.taskCount`, which is how you tell whether a scheme can still be obsoleted: a scheme tasks have used cannot be deleted, only obsoleted. '
      + 'A scheme is a versioned asset: the current version is the newest row, not a flag.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: draft / active / disabled / obsolete.' },
        schemeId: { type: 'string' },
        includeVersions: { type: 'boolean', description: 'Default false: newest version per scheme.' },
      },
    },
    output,
    async execute(args) {
      const result = schemeList({ store: deps.store, args: args ?? {} })
      return { ...result, text: renderSchemes(result.schemes) }
    },
  }
}

export function collectSchemeSaveTool(deps) {
  return {
    name: 'amzn_collect_scheme_save',
    description:
      'Create a collection scheme, or edit the newest version when it is still a draft. A version that is not a draft can never be edited in place — '
      + 'pass baseVersion to produce a new version (max+1) while leaving the old row untouched. That immutability is what makes "this task used scheme v3" keep meaning something. '
      + 'sections is required and an empty array is a legal, deliberate "collect nothing".',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Omit to create a new scheme at version 1.' },
        name: { type: 'string' },
        baseVersion: { type: 'number', description: 'Publish a new version derived from this one.' },
        sections: { type: 'array', items: { type: 'string' }, description: 'The thirteen section ids to collect. Required; [] is allowed and deliberate.' },
        marketplaces: { type: 'array', items: { type: 'string' }, description: 'Restrict the scheme to these marketplaces. Omit for every marketplace.' },
        requiresLogin: { type: 'boolean' },
        riskLevel: { type: 'string', description: 'low / medium / high. Omit when never assessed.' },
        defaultPacing: { type: 'object' },
        note: { type: 'string' },
      },
      required: ['name'],
    },
    output,
    async execute(args) {
      const result = schemeSave({ store: deps.store, args: args ?? {} })
      if (result.ok !== true) return refuse(result)
      return {
        ...result,
        text: `${result.created ? '已新建方案' : '已更新草稿'}：${result.scheme.name}（${result.scheme.id} v${result.scheme.version}，${result.scheme.status}）\n`
          + `覆盖节：${result.scheme.sections.length === 0 ? '（空：什么都不采）' : result.scheme.sections.map(sectionLabel).join(' / ')}`,
      }
    },
  }
}

export function collectSchemeTransitionTool(deps) {
  return {
    name: 'amzn_collect_scheme_transition',
    description:
      'Move one scheme version along its status machine: verify (run the environment check and load one real product page, then draft → active — the only way a '
      + 'version becomes usable), activate (draft/disabled → active, refused if it never passed verify), disable, obsolete (both destructive and both need reason + confirm:true), '
      + 'restore (disabled → active). obsolete is terminal: an obsoleted scheme cannot be revived, or "obsoleted" would mean nothing.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        version: { type: 'number' },
        action: { type: 'string', enum: ['verify', 'activate', 'disable', 'obsolete', 'restore'] },
        reason: { type: 'string', description: 'Required for disable / obsolete.' },
        confirm: { type: 'boolean', description: 'Required for verify / activate / disable / obsolete.' },
      },
      required: ['id', 'version', 'action'],
    },
    output,
    async execute(args) {
      const result = await schemeTransition({ ...context(deps), args: args ?? {} })
      if (result.ok !== true) return refuse(result)
      return {
        ...result,
        text: `方案 ${result.scheme.id} v${result.scheme.version}：${args?.action} → ${result.scheme.status}`
          + `${result.scheme.verifiedAt === null ? '' : `（验证于 ${result.scheme.verifiedAt}）`}`,
      }
    },
  }
}

export function collectPlanListTool(deps) {
  return {
    name: 'amzn_collect_plan_list',
    description:
      'List saved collection plans. `nextWindow` is computed on every read (from/to/tz/openNow/localTime) and never stored — there is no scheduler, and a stored '
      + '"next run time" would be a calculation error saved to disk. Plans are off by default; a disabled plan never runs.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Filter by the enabled flag.' },
        marketplace: { type: 'string' },
      },
    },
    output,
    async execute(args) {
      const result = planList({ store: deps.store, args: args ?? {} })
      return { ...result, text: renderPlans(result.plans) }
    },
  }
}

export function collectPlanSaveTool(deps) {
  return {
    name: 'amzn_collect_plan_save',
    description:
      'Create or replace a collection plan. `enabled` defaults to FALSE — a plan that started running because it was created is a subscription nobody asked for. '
      + 'A window is {from,to,tz} on a single day (windows crossing midnight are refused: they need a date, and a plan has none). '
      + 'The name is the handle for "pause that plan", so it is unique. Nothing here schedules anything: the window is judged when somebody submits.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Omit to create. An id that does not exist is refused (a typo would otherwise create a second plan).' },
        name: { type: 'string' },
        enabled: { type: 'boolean', description: 'Default false.' },
        marketplace: { type: 'string' },
        targets: { type: 'array', items: { type: 'object' }, description: 'What the plan collects. Required and non-empty.' },
        schemeId: { type: 'string' },
        schemeVersion: { type: 'number' },
        window: { type: 'object', description: '{from,to,tz} with from < to.' },
        intervalMinutes: { type: 'number', description: '>= 1.' },
        maxObjects: { type: 'number' },
        failurePolicy: { type: 'string', description: 'stop / continue / retry_once.' },
        cooldownMinutes: { type: 'number', description: 'Site cooldown after a blocked run. Default 60.' },
        notify: { type: 'string', description: 'none / on_failure / always.' },
        pauseCondition: { type: 'object' },
      },
      required: ['name'],
    },
    output,
    async execute(args) {
      const result = planSave({ store: deps.store, args: args ?? {} })
      if (result.ok !== true) return refuse(result)
      return {
        ...result,
        text: `计划已保存：${result.plan.name}（${result.plan.id}）${result.plan.enabled ? '已启用' : '默认关闭'}\n`
          + `目标 ${result.plan.targets.length} 个，冷却 ${result.plan.cooldownMinutes} 分钟`
          + `${result.plan.nextWindow === null ? '' : `，窗口 ${result.plan.nextWindow.from}–${result.plan.nextWindow.to}（${result.plan.nextWindow.tz}）现在${result.plan.nextWindow.openNow ? '开着' : '没开'}`}`,
      }
    },
  }
}

/* ── rendering ──────────────────────────────────────────────────────────────── */

function renderEnvCheck(result) {
  const summary = result.summary
  /* The table is 80 characters wide per column, and one of these details is the
     instruction a person has to follow after a block (item `10-cooldown` names
     the page that is still open and the control to click). Truncating an
     instruction is how it stops being one, so any detail the table had to cut is
     printed in full underneath. */
  const CUT = 80
  const truncated = result.checks.filter(check => String(check.detail ?? '').length > CUT)
  return [
    `环境体检 ${result.marketplace} @ ${result.checkedAt}`,
    `结果: ok ${summary.ok} / warn ${summary.warn} / fail ${summary.fail} / unknown ${summary.unknown}（可修 ${summary.repairable}）`,
    '',
    table(result.checks, [
      { label: '检查项', value: row => `${row.id} ${row.label}` },
      { label: '状态', value: row => row.status },
      { label: '可修', value: row => (row.repairable ? row.repairAction : '—') },
      { label: '风险', value: row => row.risk },
      { label: '说明', value: row => truncate(row.detail, CUT) },
    ]),
    truncated.length === 0
      ? ''
      : `\n完整说明（上面被截断的 ${truncated.length} 项）：\n`
        + truncated.map(check => `· ${check.id} ${check.label}: ${check.detail}`).join('\n'),
    result.repairs.length === 0 ? '' : `\n已尝试修复 ${result.repairs.length} 项：${result.repairs.map(repair => `${repair.id}→${repair.ok ? '成功' : repair.code}`).join(', ')}`,
    result.blocking.length === 0 ? '' : `\n阻断项：${result.blocking.join(', ')} —— 不修好就发不出采集任务。`,
  ].filter(Boolean).join('\n')
}

function renderRepair(result) {
  return [
    `修复动作 ${result.action}：成功`,
    result.detail ?? '',
    result.changed.length === 0 ? '（没有需要改动的地方）' : result.changed.map(change => `· ${change.what}: ${change.from} → ${change.to}`).join('\n'),
    '',
    '复查结果:',
    Object.values(result.checkedAfter ?? {}).map(check => `  ${check.id} ${check.label}: ${check.status} — ${check.detail}`).join('\n'),
  ].filter(Boolean).join('\n')
}

function renderPreview(result) {
  return [
    `提交前预览（${result.source}，站点 ${result.marketplace}）`,
    `有效目标: ${result.validAsins.total}（自有 ${result.validAsins.self} / 竞品 ${result.validAsins.competitor}）`,
    `重复项: ${result.duplicates.length === 0 ? '无' : result.duplicates.map(item => `${item.asin}×${item.occurrences}`).join(', ')}`,
    `归属待定: ${result.unknownOwnership.length === 0 ? '无' : result.unknownOwnership.map(item => `${item.asin}(${item.tier}${item.suggestion === null ? '' : `→建议${item.suggestion.side}`})`).join(', ')}`,
    `预计请求: ${result.estimatedRequests.asins} ASIN × ${result.estimatedRequests.sections} 节 = ${result.estimatedRequests.total} 次`
      + `（其中需要登录态的节 ${result.estimatedRequests.loginRequiredSections} 个）`,
    `风险: ${result.risk.level}${result.risk.reasons.length === 0 ? '' : ` — ${result.risk.reasons.join('；')}`}`,
    `可复用快照: ${result.reuse.count} 个${result.reuse.skipped === true ? '（本次要求不复用）' : ''}`
      + `${result.reuse.count === 0 ? '' : ` — ${result.reuse.asins.map(item => `${item.asin}(${item.ageDays}天)`).join(', ')}`}`,
    /* 「没有方案」不是一个错误状态 —— 提交照样放行，按该源的全量字段采。
       2026-10-20 走查里三处说法不一致：预览写「（没有可用的 active 方案）」像在报错，
       提交却照样入队，环境体检第 08 项又标 warn。运营于是不知道到底要不要先建方案。
       现在这一句直接说出**会发生什么**，与体检那项对齐。 */
    `方案: ${result.scheme === null
      ? '（没有 active 方案 —— 本次按该源的全量字段采集；要用固定的节范围与限速，先建一份并 verify）'
      : `${result.scheme.name} v${result.scheme.version}`}`,
    '',
    ...result.notes.map(note => `注: ${note}`),
  ].join('\n')
}

function renderRun(result) {
  if (result.ok === false && result.taskId === null) {
    return `采集未发起：${result.code ?? ''} ${result.error ?? ''}\n${result.hint ?? ''}`
  }
  const lines = [
    `采集任务: ${result.taskId}`,
    `状态: ${result.status}${result.status === 'queued' ? '（已入队，后台执行）' : ''}`,
    `源: ${result.source}    目标: ${result.total} 个 ASIN`,
  ]
  if (result.planId !== null && result.planId !== undefined) lines.push(`计划: ${result.planId}`)
  if (result.sideSplit !== undefined) {
    lines.push(`归属: 自有 ${result.sideSplit.self.length} / 竞品 ${result.sideSplit.competitor.length} / 待定 ${result.sideSplit.unknown.length}`)
  }
  if (result.envSummary !== null && result.envSummary !== undefined) {
    const summary = result.envSummary.summary
    lines.push(`体检: ok ${summary.ok} / warn ${summary.warn} / fail ${summary.fail} / unknown ${summary.unknown}`)
  }
  if (result.estimatedMinutes !== undefined) lines.push(`预计: 约 ${result.estimatedMinutes} 分钟`)
  if (result.risk !== undefined && result.risk !== null && result.risk.level !== 'low') {
    lines.push(`风险: ${result.risk.level} — ${(result.risk.reasons ?? []).join('；')}`)
  }
  if (result.waiting !== null && result.waiting !== undefined) {
    lines.push('', `等人工: ${result.waiting.reason}`, `可选动作: ${result.waiting.actions.map(action => action.id).join(' / ')}`)
  }
  if (result.ok === false) lines.push('', `未入队：${result.code} ${result.error ?? ''}`, result.hint ?? '')
  if (result.preview !== undefined && result.preview !== null) {
    lines.push('', `预览: ${result.preview.validAsins.total} 个有效目标，预计 ${result.preview.estimatedRequests.total} 次请求`)
  }
  lines.push('', `查进度: amzn_collect_status(taskId="${result.taskId}")`)
  return lines.filter(line => line !== undefined).join('\n')
}

function renderDetail(result) {
  if (result.asin === null) {
    if (result.summaries.length === 0) return `任务 ${result.taskId} 还没有写出任何节结果。`
    return [
      `任务 ${result.taskId} 的逐 ASIN 摘要（不含节明细）`,
      table(result.summaries, [
        { label: 'ASIN', value: row => row.asin },
        { label: '站点', value: row => row.marketplace },
        { label: '已采到', value: row => row.summary.collected },
        { label: '页面没有', value: row => row.summary.missing },
        { label: '部分', value: row => row.summary.partial },
        { label: '失败', value: row => row.summary.failed },
        { label: '被拦截', value: row => row.summary.blocked },
        { label: '最近采集', value: row => row.collectedAt ?? '—' },
      ]),
      /* A capped read makes this list a claim about the first N rows, not about the
         task. Saying nothing would turn a capped list into "these are all the ASINs
         the task collected". */
      result.coverage?.truncated === true
        ? `⚠ ${result.coverage.note} —— 上面这份列表可能不全，「不在列表里」不等于「没采过」`
        : '',
    ].filter(Boolean).join('\n')
  }
  const summary = result.summary
  return [
    `任务 ${result.taskId} / ${result.asin} / ${result.marketplace ?? ''}`,
    `摘要: 已采到 ${summary.collected} / 页面没有 ${summary.missing} / 部分 ${summary.partial} / 失败 ${summary.failed} / 被拦截 ${summary.blocked}（共 ${summary.total} 节）`,
    result.hiddenSections > 0 ? `（本次过滤隐藏了 ${result.hiddenSections} 节）` : '',
    result.coverage?.truncated === true
      ? `⚠ ${result.coverage.note} —— 下表标「未采（没跑过）」的行里可能有节只是没被读出来`
      : '',
    '',
    table(result.sections, [
      { label: '#', value: row => row.order },
      { label: '节', value: row => row.label },
      { label: '状态', value: row => row.status ?? '未采（没跑过）' },
      /* T73k：没有读数不是一个读数 —— 未采集的节分子是 null 不是 0，直接拼会印成
         `null/5`。与 `amzn_asin_detail` 同一个口径：那一列早就是 `notCollected ? '—'`。 */
      { label: '字段', value: row => (row.notCollected === true || row.collected === null ? '—' : `${row.collected}/${row.total}`) },
      { label: '采集于', value: row => row.collectedAt ?? '—' },
    ]),
    result.truncated ? '\n注: 有节的原始值超过 64 KB 被截断（errors 里记了 TRUNCATED）。' : '',
  ].filter(Boolean).join('\n')
}

function renderSchemes(schemes) {
  if (schemes.length === 0) return '还没有任何采集方案。用 amzn_collect_scheme_save 建一份。'
  return table(schemes, [
    { label: '方案', value: row => row.id },
    { label: '名称', value: row => row.name },
    { label: '版本', value: row => `v${row.version}` },
    { label: '状态', value: row => row.status },
    { label: '节数', value: row => row.sections.length },
    { label: '需登录', value: row => yes(row.requiresLogin) },
    { label: '验证于', value: row => row.verifiedAt ?? '—' },
    { label: '任务数', value: row => row.usage?.taskCount ?? 0 },
  ])
}

function renderPlans(plans) {
  if (plans.length === 0) return '还没有任何计划采集。用 amzn_collect_plan_save 建一份（默认关闭）。'
  return table(plans, [
    { label: '计划', value: row => row.id },
    { label: '名称', value: row => row.name },
    { label: '启用', value: row => yes(row.enabled) },
    { label: '站点', value: row => row.marketplace ?? '—' },
    { label: '目标', value: row => row.targets.length },
    { label: '窗口', value: row => (row.nextWindow === null ? '不限' : `${row.nextWindow.from}–${row.nextWindow.to} ${row.nextWindow.tz}${row.nextWindow.openNow ? '（开着）' : '（没开）'}`) },
    { label: '冷却', value: row => `${row.cooldownMinutes} 分钟` },
  ])
}
