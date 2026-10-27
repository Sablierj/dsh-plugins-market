/**
 * 审批策略 — which actions ask a person first, and which can never be turned off.
 *
 * Two lists, and the difference between them is the whole design.
 *
 * ## The hard three have no setting key, and that is the implementation
 *
 * 「自动发布 / 删历史快照 / 覆盖原始事实」 cannot be turned off. The obvious
 * way to build that is a declared key plus a write-time refusal — and it is the
 * wrong way: it leaves a switch that exists, is documented in the settings list,
 * and is one validator bug away from being flipped. A refusal is a rule enforced
 * at one door; an absent key is a rule with no door.
 *
 * So the hard approvals are declared here with a `label` and a `why` and
 * **nothing else** — no `key`, no default, no way to name them as settings.
 * `setSetting('approval.autoPublish', false)` does not fail because something
 * checked it; it fails because the key is not declared, which is the same throw
 * every other typo gets. That is why the assertion for it is 「unknown setting」
 * rather than a bespoke error code.
 *
 * Each one carries its reason because "cannot be turned off" on its own reads as
 * an arbitrary restriction. The three reasons are not the same reason:
 *
 *   - **自动发布** pushes a change nobody read onto a live listing. The review is
 *     the point; there is no version of this that is safe to skip.
 *   - **删历史快照** destroys 「当时是什么样」. The snapshot's value is precisely
 *     that it survives the decision it was captured for.
 *   - **覆盖原始事实** rewrites the evidence under a conclusion. Every lineage
 *     chain in this plugin ends at an original fact; overwriting one leaves the
 *     conclusion intact and its support gone, which is worse than deleting both.
 *
 * ## The configurable six default to off, and that is a reading, not a guess
 *
 * §29.3's matrix describes which *roles* may do these things; it does not ask for
 * extra confirmation on any of them. Turning the default to `true` would invent a
 * gate the document does not have — and would make six conversations that used to
 * go through start asking. So the declared default is `false` for all six, and
 * `approvalPolicy` reports the value that is actually in effect either way.
 *
 * ## 收紧不可放宽, as code
 *
 * `setApproval` refuses any write that is **looser than the item's declared
 * default**. Today all six defaults are `false`, so the rule never fires in
 * production — which is exactly why it is written down here rather than left as
 * a sentence in a design doc: the first item that ships with `default: true`
 * would otherwise be relaxable by whoever got there first. The rule is measured
 * against the item's own `default`, so it stays true for items this file has not
 * been given yet.
 */

import { getSetting, setSetting } from '../../store/settings.js'

/**
 * The three that cannot be turned off. No `key` field — see the header. The
 * absence is the mechanism, so adding one here would silently delete the rule.
 */
export const HARD_APPROVALS = [
  {
    id: 'autoPublish',
    label: '自动发布',
    why: '自动发布会把没人看过的改动直接推到线上 listing。复核就是这一步的意义，没有可以跳过的版本。',
  },
  {
    id: 'deleteSnapshot',
    label: '删历史快照',
    why: '删快照会毁掉「当时是什么样」。快照的价值正在于它能在它服务的那个决定之后继续存在。',
  },
  {
    id: 'overwriteFact',
    label: '覆盖原始事实',
    why: '覆盖原始事实是在结论下面改写证据。本插件每条血缘链的尽头都是一个原始事实；改写它，结论还在、支撑没了 —— 比两个都删更糟。',
  },
]

/**
 * The six a workspace may turn on, each with a declared setting key.
 *
 * `default` is both the declared default (the settings whitelist uses the same
 * value — an assertion pins the two together) and the floor the "cannot relax"
 * rule compares against.
 */
export const CONFIGURABLE_APPROVALS = [
  {
    id: 'batchCollect',
    key: 'approval.batchCollect',
    label: '批量采集',
    default: false,
    note: '一次提交多个目标前先确认。目标数越多，一次误操作撞上风控的面越大。',
  },
  {
    id: 'overwriteField',
    key: 'approval.overwriteField',
    label: '覆盖字段',
    default: false,
    note: '用新值覆盖已存字段前先确认。覆盖会留下前后值，但不会把旧值还回来。',
  },
  {
    id: 'activateVersion',
    key: 'approval.activateVersion',
    label: '激活版本',
    default: false,
    note: '切换生效中的规则集 / 产品线版本前先确认。进行中的运行用的是配置快照，不受影响。',
  },
  {
    id: 'archive',
    key: 'approval.archive',
    label: '归档',
    default: false,
    note: '归档对象前先确认。归档是隐藏而不是删除，按 id 仍然解析得出来。',
  },
  {
    id: 'acceptDraft',
    key: 'approval.acceptDraft',
    label: '接受草案',
    default: false,
    note: '采纳优化草案前先确认。采纳只写进报告，真正改 listing 还要 amzn_optimize_save 的 applyListing。',
  },
  {
    id: 'markPublished',
    key: 'approval.markPublished',
    label: '标记发布',
    default: false,
    /* 这条 note 原来写的是「真正的『标记发布』动作不存在（属模块 14），观测期也不存在」。
       模块 14 交付之后那句话过期了：动作就是 `amzn_publication_record`（写一条发布登记，
       §6），观测期就是 `observation_plan` / `observation_checkpoint`（§7/§8）。现在这一项
       是**六项里最后一个接上动作的**，闸门接在 `tools/observe.js` 的 publication_record 上。
       写下来的原因与「什么都不写」不同：一个登记了却不接动作的开关，会把「打开了」读成
       「已经保护了」。 */
    note: '把对象标记为已发布前先确认。这一项接在 amzn_publication_record 上（§6 的发布登记，'
      + '观测计划与观测节点由它派生）：开关打开时该工具会拒绝一次，带 confirm: true 再调一次才写。',
  },
]
/**
 * The routing test the two write paths share.
 *
 * `setting-set` and `amzn_setting_set` both have to send approval keys through
 * `setApproval` instead of writing them directly. Neither of them deciding for
 * itself what an approval key looks like is the point: two spellings of that
 * question is two answers, and the one that says "no" is the one that gets it
 * wrong in the permissive direction.
 */
export function approvalFor(key) {
  const wanted = String(key ?? '').trim()
  return CONFIGURABLE_APPROVALS.find(item => item.key === wanted) ?? null
}

/**
 * The policy in effect: one boolean per configurable item.
 *
 * Read from the settings table every time, so the answer is the value the store
 * actually holds rather than a copy that has to be invalidated. Six `getSetting`
 * calls against a table of a dozen rows, once per settings-page read.
 */
export function approvalPolicy(store) {
  const policy = {}
  for (const item of CONFIGURABLE_APPROVALS) policy[item.id] = getSetting(store, item.key) === true
  return policy
}

/**
 * Turn one confirmation on or off.
 *
 * Returns a result rather than throwing, because every caller is a surface that
 * has to render the refusal: the page shows it next to the toggle, the tool
 * returns it to the agent. A throw would make each of them wrap it in its own
 * try/catch and invent its own wording.
 *
 * `items` is injectable so the "cannot relax" rule can be exercised by an item
 * that has a floor — see the header on why none of today's six do.
 */
export function setApproval(store, id, enabled, { items = CONFIGURABLE_APPROVALS } = {}) {
  const item = items.find(entry => entry.id === String(id ?? '').trim())
  if (item === undefined) {
    return {
      ok: false,
      code: 'APPROVAL_UNKNOWN',
      error: `unknown approval: ${id} — expected one of: ${items.map(entry => entry.id).join(' | ')}`,
      floor: null,
    }
  }
  if (typeof enabled !== 'boolean') {
    return { ok: false, code: 'APPROVAL_NOT_A_BOOLEAN', error: `${item.key} must be true or false`, floor: item.default }
  }
  /* The floor. 「比声明的默认值更松」 is the whole of it: turning a gate ON is
     always allowed, turning one OFF below where it shipped is not. */
  if (item.default === true && enabled === false) {
    return {
      ok: false,
      code: 'APPROVAL_CANNOT_RELAX',
      error: `${item.key} 不能放宽：它的下限是 ${item.default}，只能收紧不能关。`,
      floor: item.default,
    }
  }

  try {
    /* Through `setSetting`, which is the audited path — `setting-set` and
       `amzn_setting_set` both record it as `setting.set`. A second writer here
       would be a second place to keep the audit funnel wired. */
    const value = setSetting(store, item.key, enabled)
    return { ok: true, code: 'APPROVAL_SET', id: item.id, key: item.key, value, floor: item.default }
  } catch (error) {
    return { ok: false, code: 'APPROVAL_REFUSED', error: error.message, floor: item.default }
  }
}

/**
 * Whether an action needs a person first — the single judgement callers make.
 *
 * Callers ask this instead of reading the boolean, for the same reason the rest
 * of this plugin returns sentences rather than codes: a caller that reads
 * `policy.acceptDraft` has to invent the reason itself, and the third caller
 * invents a different one. The answer carries its own explanation, and the
 * explanation is data — the same input gives the same sentence no matter who
 * asked.
 */
export function requireApproval(policy, id) {
  const wanted = String(id ?? '').trim()

  const hard = HARD_APPROVALS.find(item => item.id === wanted)
  if (hard !== undefined) {
    return {
      required: true,
      id: hard.id,
      hard: true,
      code: 'APPROVAL_REQUIRED',
      reason: `「${hard.label}」是硬审批，不能关：${hard.why}`,
    }
  }

  const item = CONFIGURABLE_APPROVALS.find(entry => entry.id === wanted)
  if (item === undefined) {
    return {
      required: false,
      id: wanted,
      hard: false,
      code: 'APPROVAL_NOT_A_GATE',
      reason: `「${wanted}」不在审批策略里 —— 它本来就不需要二次确认。`,
    }
  }

  if (policy?.[item.id] !== true) {
    return {
      required: false,
      id: item.id,
      hard: false,
      code: 'APPROVAL_OFF',
      reason: `「${item.label}」当前不额外确认（默认）。要开关去设置中心 → 审批策略，键是 ${item.key}。`,
    }
  }
  return {
    required: true,
    id: item.id,
    hard: false,
    code: 'APPROVAL_REQUIRED',
    reason: `「${item.label}」已开启二次确认：${item.note} 要停止确认去设置中心 → 审批策略关掉 ${item.key}。`,
  }
}

/**
 * The refusal an action returns when its gate is on and nobody confirmed.
 *
 * Returns `null` when there is nothing to refuse — the gate is off, or the
 * caller passed `confirm: true`. One shape, five call sites: a second spelling
 * of this object would be a second thing for the page's error handler to learn,
 * and the whole point of the batch this belongs to is that the gates are asked
 * *by the actions* rather than by the caller of `requireApproval`.
 *
 * **The caller decides whether the gated thing is happening at all**, and asks
 * this only when it is. That distinction is load-bearing for two of the five:
 * `approval.overwriteField` may not fire for a create (nothing is being
 * overwritten) and `approval.batchCollect` may not fire for a single target
 * (that is not a batch). A gate that fires on everything its tool can do makes
 * its own name false, and the reader's conclusion is to turn it off.
 *
 * `confirm === true` is the only thing that opens it, and it has to be an
 * explicit `true`: a truthy string from a form field would silently open every
 * gate, which is the failure mode of every "confirm" flag that used a truthiness
 * test.
 */
export function approvalRefusal(store, gateId, confirm, hint = null) {
  if (confirm === true) return null
  const verdict = requireApproval(approvalPolicy(store), gateId)
  if (verdict.required !== true) return null
  return {
    ok: false,
    code: 'APPROVAL_REQUIRED',
    gate: verdict.id,
    reason: verdict.reason,
    hint: hint ?? '这是本工作空间开着的二次确认。确认无误就再调一次并带 confirm: true；要停止确认，去设置中心 → 审批策略关掉这一项。',
  }
}
