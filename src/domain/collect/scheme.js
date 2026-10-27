/**
 * The collection scheme and plan tools' logic (module 04 F04-09 / F04-10;
 * contract §6.2.8–§6.2.11).
 *
 * ## Why the coordinate is (id, version) and not "the scheme"
 *
 * `collection_scheme`'s primary key is `(id, version)` and its store module
 * appends only — a task freezes `(scheme_id, scheme_version)` and that pair must
 * keep meaning what it meant when the task ran. So every edit here is one of
 * three things, and never "change the scheme":
 *
 *   · **append a version** (`baseVersion` given, or a new id) — the old rows are
 *     not touched at all;
 *   · **edit the draft** (`id` given, no `baseVersion`) — legal only while the
 *     newest version is a `draft`, because a draft is the one version nothing has
 *     ever referenced. Anything else is `SCHEME_IMMUTABLE`;
 *   · **move `status`** along `COLLECTION_SCHEME_TRANSITIONS`.
 *
 * ## `verify` is the only path that makes a version usable
 *
 * `activate` exists in the action vocabulary because the page has an 启用 button,
 * but it refuses a version that never went through `verify` — otherwise "was this
 * scheme ever actually validated" would be answerable only by looking at
 * `verified_at` and noticing it is NULL, which is the kind of fact that gets
 * missed. The refusal reuses `SCHEME_VERIFY_FAILED`: the closed code set stays
 * closed, and the sentence says which of the two situations it is.
 *
 * ## The probe is `collector.doctor`, not a real collection
 *
 * Contract §10-9 says `verify` opens a real browser and collects 1 ASIN × the
 * minimum section set. Opening a real page is what is needed and what happens
 * here — but through `doctor`, the repo's own probe (`amzn_collect_doctor`),
 * which loads the page, reports which selector matched each field and **writes
 * nothing**. A scheme verification that wrote product data into the library would
 * make "may I use this scheme" a decision with side effects on the data it is
 * about. The probe still runs through the same browser gate as a collection.
 */

import {
  COLLECTION_PLAN_FAILURE_POLICIES, COLLECTION_PLAN_NOTIFY, COLLECTION_SCHEME_TRANSITIONS,
  canTransitionScheme,
} from '../states.js'
import { COLLECTION_SECTION_IDS, normalizeSectionIds } from './sections.js'
import { windowState } from './window.js'
import { runEnvCheck } from './env.js'
import { MARKETPLACES } from '../../sources/pages/amazon.js'
import {
  currentSchemeVersion, getSchemeVersion, insertSchemeVersion, listSchemes, newSchemeId,
  schemeUsage, updateSchemeStatus, updateSchemeDraft,
} from '../../store/collection-scheme.js'
import { getPlan, getPlanByName, listPlans, newPlanId, savePlan } from '../../store/collection-plan.js'

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function refusal(code, error, extra = {}) {
  return { ok: false, code, error, ...extra }
}

/* ── F04-09: schemes ────────────────────────────────────────────────────────── */

/** The list the page's cards and the agent's tool both read (§6.2.8). */
export function schemeList({ store, args = {} } = {}) {
  const rows = listSchemes(store, {
    status: blankToNull(args.status),
    schemeId: blankToNull(args.schemeId),
    includeVersions: args.includeVersions === true,
  })
  return {
    ok: true,
    schemes: rows.map(row => ({ ...row, usage: schemeUsage(store, { id: row.id, version: row.version }) })),
  }
}

/**
 * Create a version, or edit the newest one when it is still a draft.
 *
 * The five refusal codes are all pre-checked here rather than inferred from a
 * store message: a code the caller branches on must not depend on the wording of
 * an exception.
 */
export function schemeSave({ store, args = {} } = {}) {
  const name = blankToNull(args.name)
  if (name === null) return refusal('NAME_REQUIRED', 'name is required')

  const requested = normalizeSectionIds(args.sections)
  if (requested.unknown.length > 0) {
    return refusal('SECTION_UNKNOWN', `unknown section(s): ${requested.unknown.join(', ')}`, {
      hint: `13 节 id：${COLLECTION_SECTION_IDS.join(', ')}`,
    })
  }
  /* An empty list is a deliberate "collect nothing" (the table's `sections_json`
     is NOT NULL for exactly this reason), so `undefined` is refused too — the
     caller has to decide rather than inherit. */
  if (!Array.isArray(args.sections)) {
    return refusal('SECTION_UNKNOWN', 'sections must be an array — 空数组是合法选择，但不给就是没决定')
  }

  const marketplaces = Array.isArray(args.marketplaces)
    ? args.marketplaces.map(value => String(value).trim().toUpperCase())
    : null
  if (marketplaces !== null) {
    const unknown = marketplaces.filter(code => !Object.prototype.hasOwnProperty.call(MARKETPLACES, code))
    if (unknown.length > 0) {
      return refusal('MARKETPLACE_UNKNOWN', `unknown marketplace(s): ${unknown.join(', ')}`, {
        hint: `known marketplaces: ${Object.keys(MARKETPLACES).join(', ')}`,
      })
    }
  }

  const id = blankToNull(args.id)
  const baseVersion = args.baseVersion === undefined || args.baseVersion === null ? null : Math.trunc(Number(args.baseVersion))
  const sections = requested.sections

  try {
    if (id !== null && baseVersion === null) {
      const current = currentSchemeVersion(store, id)
      if (current === null) return refusal('SCHEME_NOT_FOUND', `collection_scheme ${id} does not exist`)
      if (current.status !== 'draft') {
        return refusal('SCHEME_IMMUTABLE',
          `方案 ${id} v${current.version} 是 ${current.status}，不能原地改`,
          { hint: '要改内容就带 baseVersion 出一版新的（旧版一字不动）' })
      }
      const updated = updateSchemeDraft(store, {
        id,
        version: current.version,
        name,
        sections,
        marketplaces,
        requiresLogin: args.requiresLogin,
        riskLevel: args.riskLevel,
        defaultPacing: args.defaultPacing,
        note: args.note,
      })
      return { ok: true, created: false, scheme: updated }
    }

    if (id !== null && baseVersion !== null) {
      const base = getSchemeVersion(store, id, baseVersion)
      if (base === null) return refusal('SCHEME_NOT_FOUND', `collection_scheme ${id} v${baseVersion} does not exist`)
    }

    const created = insertSchemeVersion(store, {
      id: id ?? newSchemeId(),
      name,
      /* With a baseVersion the new version is `max + 1` — `insertSchemeVersion`
         computes that itself, which is why `version` is not passed here. The
         point of naming the base at all is that the *content* is derived from
         that version by the caller; the store's job is the new coordinate. */
      sections,
      marketplaces,
      requiresLogin: args.requiresLogin,
      riskLevel: args.riskLevel,
      defaultPacing: args.defaultPacing,
      note: args.note,
    })
    return { ok: true, created: true, scheme: created }
  } catch (error) {
    /* Anything else the store refuses (a duplicate version number, an unknown
       driver) is reported with its own sentence — inventing a contract code for
       it would make the code set a fiction. */
    return refusal('STORE_REFUSED', error.message)
  }
}

const SCHEME_ACTION_TO_STATUS = {
  verify: 'active',
  activate: 'active',
  disable: 'disabled',
  obsolete: 'obsolete',
  restore: 'active',
}

/**
 * Move a scheme version along the status machine (§6.2.10).
 *
 * `verify` and `activate` share a target status but not the right to get there:
 * only `verify` runs the probe and writes `verified_at` (the store stamps it on
 * any transition into `active`, so `activate` inherits whatever verification the
 * version already had — and refuses when there is none).
 */
export async function schemeTransition({
  store, collector = null, dataDir = null, args = {}, now = null,
} = {}) {
  const id = blankToNull(args.id)
  const version = args.version === undefined || args.version === null ? null : Math.trunc(Number(args.version))
  const action = String(args.action ?? '').trim()
  if (id === null || version === null) return refusal('SCHEME_NOT_FOUND', 'id and version are required')
  if (SCHEME_ACTION_TO_STATUS[action] === undefined) {
    return refusal('ILLEGAL_TRANSITION', `unknown action "${args.action}"`, {
      hint: `known actions: ${Object.keys(SCHEME_ACTION_TO_STATUS).join(' / ')}`,
    })
  }

  const current = getSchemeVersion(store, id, version)
  if (current === null) return refusal('SCHEME_NOT_FOUND', `collection_scheme ${id} v${version} does not exist`)

  /* `restore` on a `disabled` version lands back in `active`, but the transition
     table also allows `disabled → draft`; the tool has no action that means
     "back to draft", so restore means active and the table's other edge stays
     reachable by `insertSchemeVersion`'s append path when someone re-edits. */
  if (action === 'restore' && current.status !== 'disabled') {
    return refusal('ILLEGAL_TRANSITION', `restore 只对 disabled 有效（当前 ${current.status}）`, {
      allowed: COLLECTION_SCHEME_TRANSITIONS[current.status] ?? [],
    })
  }
  if (action !== 'restore' && !canTransitionScheme(current.status, SCHEME_ACTION_TO_STATUS[action])) {
    return refusal('ILLEGAL_TRANSITION', `方案 ${id} v${version} 不能 ${current.status} → ${SCHEME_ACTION_TO_STATUS[action]}`, {
      allowed: COLLECTION_SCHEME_TRANSITIONS[current.status] ?? [],
      hint: (COLLECTION_SCHEME_TRANSITIONS[current.status] ?? []).length === 0 ? 'obsolete 是终态' : null,
    })
  }

  const destructive = action === 'disable' || action === 'obsolete'
  if (destructive) {
    const reason = blankToNull(args.reason)
    if (reason === null) return refusal('REASON_REQUIRED', `${action} 必须给 reason`)
    if (args.confirm !== true) {
      return refusal('APPROVAL_REQUIRED', `${action} 会让新任务不能再选这份方案`, {
        hint: '确认要这么做就再调一次并带 confirm: true',
      })
    }
  }

  if (action === 'obsolete') {
    const active = store.get(
      `SELECT COUNT(*) AS rows FROM collection_task
        WHERE scheme_id = ? AND scheme_version = ?
          AND status IN ('queued','checking_env','running','waiting_human','cooling_down')`,
      [id, version],
    )
    if (Number(rowsOf(active)) > 0) {
      return refusal('SCHEME_IN_USE', `还有 ${rowsOf(active)} 个未结束的任务在用这份方案`, {
        hint: '等这些任务结束，或先取消它们',
      })
    }
  }

  if (action === 'verify' || action === 'activate') {
    if (args.confirm !== true) {
      return refusal('APPROVAL_REQUIRED', `${action} 会打开采集浏览器并真实加载一个商品页`, {
        hint: '确认要验证就再调一次并带 confirm: true',
      })
    }
    if (action === 'activate') {
      if (current.verifiedAt === null || current.verifiedAt === undefined) {
        return refusal('SCHEME_VERIFY_FAILED',
          `方案 ${id} v${version} 没有通过 verify（verified_at 为空），不能直接启用`,
          { hint: '用 action="verify" 走一次体检 + 探针' })
      }
    } else {
      const probed = await verifyScheme({ store, collector, dataDir, scheme: current, now })
      if (probed.ok !== true) return probed
    }
  }

  try {
    const updated = updateSchemeStatus(store, {
      id,
      version,
      to: SCHEME_ACTION_TO_STATUS[action],
      verifiedBy: blankToNull(args.reason) ?? (action === 'verify' ? 'amzn_collect_scheme_transition' : null),
    })
    return { ok: true, action, scheme: updated }
  } catch (error) {
    return refusal('ILLEGAL_TRANSITION', error.message)
  }
}

function rowsOf(row) {
  return Number(row?.rows ?? 0)
}

/**
 * The probe behind `verify`: environment first, then one real page.
 *
 * The sample ASIN is the newest ASIN already in the library for the scheme's
 * marketplace — the tool has no ASIN parameter (contract §6.2.10 lists none), and
 * asking the user to pick one for a button labelled 验证 would be adding a field
 * the contract does not have.
 */
async function verifyScheme({ store, collector, dataDir, scheme, now = null }) {
  const env = await runEnvCheck({
    store,
    collector,
    dataDir,
    marketplace: Array.isArray(scheme.marketplaces) && scheme.marketplaces.length > 0 ? scheme.marketplaces[0] : 'US',
    now,
  })
  if (env.ok !== true) return env
  if (env.summary.fail > 0) {
    return refusal('SCHEME_VERIFY_FAILED', `体检有 ${env.summary.fail} 项未通过`, {
      checks: env.checks.filter(check => check.status === 'fail').map(check => ({ id: check.id, detail: check.detail })),
    })
  }
  if (collector === null) {
    return refusal('SCHEME_VERIFY_FAILED', '本 profile 没有注入浏览器采集器，无法做加载探针')
  }

  const marketplace = Array.isArray(scheme.marketplaces) && scheme.marketplaces.length > 0
    ? scheme.marketplaces[0]
    : 'US'
  const sample = store.get(
    'SELECT asin FROM asin WHERE marketplace = ? ORDER BY updated_at DESC LIMIT 1',
    [marketplace],
  )
  if (sample === undefined) {
    return refusal('SCHEME_VERIFY_FAILED', `库里还没有 ${marketplace} 的 ASIN，无法做加载探针`, {
      hint: '先采一个 ASIN，再来验证方案',
    })
  }

  let report = null
  try {
    report = await collector.doctor({ asin: sample.asin, marketplace })
  } catch (error) {
    return refusal('SCHEME_VERIFY_FAILED', `探针加载失败：${error.message}`)
  }
  if (report?.error !== undefined || report?.status !== 'ok') {
    return refusal('SCHEME_VERIFY_FAILED', `探针未通过：${report?.error ?? report?.reason ?? report?.status ?? '未知原因'}`, {
      asin: sample.asin,
      marketplace,
    })
  }
  return { ok: true, asin: sample.asin, marketplace, probedAt: now ?? new Date().toISOString() }
}

/* ── F04-10: plans ──────────────────────────────────────────────────────────── */

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/
/* 	o 允许 24:00：区间右端开区间，整天只能用  0:00–24:00 表达（见 domain/collect/window.js）。 */
const HH_MM_END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/

/**
 * The plans, with `nextWindow` **computed per read** (contract §6.2.11).
 *
 * Not stored, and not storable: the plan has no date, so "is the window open"
 * depends on the clock at the moment of reading. `openNow` and the local time it
 * was judged at are both reported, because "closed" without "at 14:32 Asia/Shanghai"
 * is a verdict nobody can check.
 */
export function planList({ store, args = {}, now = new Date() } = {}) {
  const rows = listPlans(store, { enabled: args.enabled === undefined ? null : args.enabled, marketplace: blankToNull(args.marketplace) })
  return {
    ok: true,
    plans: rows.map(plan => ({ ...plan, nextWindow: plan.window === null ? null : windowState(plan.window, now) })),
  }
}

/**
 * Create or replace a plan definition (§6.2.11).
 *
 * `enabled` defaults to **false**: a plan that started running because it was
 * created is a subscription nobody asked for (F04-10's acceptance is exactly
 * 「默认关闭」). Omitting it therefore writes 0, and the only way to get a 1 is to
 * say so — for a new plan, for an existing one the stored value is kept.
 */
export function planSave({ store, args = {}, now = new Date() } = {}) {
  const name = blankToNull(args.name)
  if (name === null) return refusal('NAME_REQUIRED', 'name is required')

  const id = blankToNull(args.id)
  if (id !== null && getPlan(store, id) === null) {
    /* An explicit id is a claim that the plan exists. A typo would otherwise
       silently create a second plan under a random-looking name/id pair, and the
       caller would never learn that nothing was updated. */
    return refusal('PLAN_NOT_FOUND', `collection_plan ${id} does not exist`, { hint: '新建时不要给 id' })
  }
  const clash = getPlanByName(store, name)
  if (clash !== null && clash.id !== id) {
    return refusal('DUPLICATE_NAME', `计划名 "${name}" 已被 ${clash.id} 占用`, { hint: '计划名是「暂停哪一个」的把手，必须唯一' })
  }

  if (!Array.isArray(args.targets) || args.targets.length === 0) {
    return refusal('TARGETS_EMPTY', 'targets 不能为空 —— 一个没有目标的计划被启用后会什么都不采')
  }

  if (args.window !== undefined && args.window !== null) {
    const win = args.window
    if (typeof win !== 'object') return refusal('WINDOW_INVALID', 'window 必须是 {from,to,tz}')
    const from = String(win.from ?? '').trim()
    const to = String(win.to ?? '').trim()
    if (!HH_MM.test(from) || !HH_MM_END.test(to)) return refusal('WINDOW_INVALID', `window 的 from/to 必须是 HH:MM（收到 ${from} / ${to}）`)
    if (from >= to) {
      return refusal('WINDOW_INVALID', `window.from 必须早于 window.to（收到 ${from} >= ${to}）；跨午夜的窗口不支持`, {
        hint: '跨午夜需要日期，而计划里没有日期 —— 分成两个窗口',
      })
    }
  }

  if (args.intervalMinutes !== undefined && args.intervalMinutes !== null) {
    const minutes = Number(args.intervalMinutes)
    if (!Number.isFinite(minutes) || minutes < 1) {
      return refusal('INTERVAL_INVALID', `intervalMinutes 必须 >= 1（收到 ${args.intervalMinutes}）`)
    }
  }
  if (args.failurePolicy !== undefined && args.failurePolicy !== null
    && !COLLECTION_PLAN_FAILURE_POLICIES.includes(String(args.failurePolicy).trim())) {
    return refusal('FAILURE_POLICY_UNKNOWN', `failurePolicy "${args.failurePolicy}" 不是 ${COLLECTION_PLAN_FAILURE_POLICIES.join(' / ')}`)
  }
  if (args.notify !== undefined && args.notify !== null && !COLLECTION_PLAN_NOTIFY.includes(String(args.notify).trim())) {
    return refusal('NOTIFY_UNKNOWN', `notify "${args.notify}" 不是 ${COLLECTION_PLAN_NOTIFY.join(' / ')}`)
  }

  const schemeId = blankToNull(args.schemeId)
  if (schemeId !== null) {
    const version = args.schemeVersion === undefined || args.schemeVersion === null
      ? (currentSchemeVersion(store, schemeId)?.version ?? null)
      : Math.trunc(Number(args.schemeVersion))
    const scheme = version === null ? null : getSchemeVersion(store, schemeId, version)
    if (scheme === null) return refusal('SCHEME_NOT_SELECTABLE', `方案 ${schemeId} v${version} 不存在`)
    if (scheme.status !== 'active') {
      return refusal('SCHEME_NOT_SELECTABLE', `方案 ${schemeId} v${scheme.version} 是 ${scheme.status}，不能选`)
    }
  }

  try {
    const plan = savePlan(store, {
      id: id ?? newPlanId(),
      name,
      enabled: args.enabled,
      marketplace: blankToNull(args.marketplace),
      targets: args.targets,
      schemeId,
      schemeVersion: args.schemeVersion,
      window: args.window,
      intervalMinutes: args.intervalMinutes,
      maxObjects: args.maxObjects,
      failurePolicy: args.failurePolicy,
      cooldownMinutes: args.cooldownMinutes,
      notify: args.notify,
      pauseCondition: args.pauseCondition,
      at: now instanceof Date ? now.toISOString() : now,
    })
    return { ok: true, plan: { ...plan, nextWindow: plan.window === null ? null : windowState(plan.window, now) } }
  } catch (error) {
    return refusal('STORE_REFUSED', error.message)
  }
}
