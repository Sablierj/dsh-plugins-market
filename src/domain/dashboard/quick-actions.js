/**
 * 快捷动作 — the six entry points on the home page.
 *
 * ## The six come from the prototype, not from here
 *
 * The mapping table is `prototype/index.html` (PRD F01-05 / R-16: 「六个动作 +
 * 落地目标映射（原型 index.html）」), and this file is a transcription of it.
 * Inventing a seventh or rewording one would break the one thing the feature is
 * for — the operator and the prototype agreeing on what the six are.
 *
 * ## One target, used twice
 *
 * The failure this shape exists to prevent: a card whose caption says 「去设置
 * 站点」 while its click handler goes to `#keywords`. Two tables, two chances to
 * edit one and forget the other, and nothing throws when they disagree.
 *
 * So there is exactly **one** field. `target` is what the card's caption is
 * derived from *and* what the click resolves to (`targetLink`). There is no
 * second, prose copy of the destination anywhere in this file — a caption that
 * could drift is a caption that will.
 *
 * The module **label** is looked up from the nav registry (`MODULE_GROUPS`) by
 * the renderer, so a module renamed in the nav renames here too. A target that
 * names a module which does not exist has to carry its own label
 * (`moduleLabel`), because there is no registry entry to read — that is the
 * only case where the name lives in this file, and it is spelled out per target
 * rather than defaulted. **No target needs one today**: all six land on modules
 * the nav has, and the S1-B14 assertion fails if one of them stops being in the
 * nav, so the override cannot come back unnoticed.
 *
 * ## An anchor is only allowed when the page has that block
 *
 * `anchor` resolves to the element id `sect-<anchor>` (page.js's `scrollToSection`), so
 * naming one here is a promise that a block with that id exists. Two actions name one
 * now (`precheck` in module 13, `ownership` in module 08): S1-B14 fails if a target's
 * *module* leaves the nav, and T-9 ② fails if the page stops having the `sect-` block —
 * the same rule the prototype's `#agent#canvas` was dropped for, applied in the other
 * direction: an anchor is added when the block is built, not when the intent is written
 * down.
 *
 * ## The one that used to have nowhere to go (W1-8 / F01-05)
 *
 * 生成优化准备包 declared `available: false` with the reason 「阶段 1 不做模块
 * 12，导航里没有这一项」. That reason stopped being true at `253871e`: module 12
 * is delivered — `MODULE_GROUPS` has the `agent` group, the page has a renderer
 * for it, and the `amzn_agent_*` tools write its three tables — so the module
 * the action is about exists and the six are no longer five-plus-a-declaration.
 * A shown reason that no longer holds is worse than no reason, because the reader
 * acts on it. The declaration was corrected instead of kept.
 *
 * What it did **not** get back is the prototype's section anchor. The prototype's
 * landing is 「12 Agent 编排 · 任务画布」, and module 12's panel has no block that
 * answers to `canvas`: this version draws a run log (运行 / 步骤 / 产物 / 门禁)
 * and says so on itself. An anchor that resolves to no element is the
 * promised-but-unreachable link this project keeps rejecting (`page.js`'s
 * `scrollToSection` resolves an anchor by element id, so `#agent#canvas` would
 * land on nothing), hence the target names the module and the `note` says which
 * half of the prototype's landing is missing — the shape the other two 有差异
 * actions use.
 */

import { UNAVAILABLE_KIND_TEXT } from './recent.js'

/**
 * The six, in the prototype's order.
 *
 * `effect` is what the action is *for* — the task goal it fills in — and it
 * deliberately does not name a module: that is `target`'s job, and a second
 * mention is a second thing to keep true. It also does not promise a control
 * that does not exist: the prototype's 「发起表单预填 8 ASIN」 describes a form
 * phase 1 does not have, and a caption that sends the reader looking for it is
 * worse than a shorter caption.
 *
 * `note` is present only where the prototype's landing point is not what phase 1
 * has, and it says which of the two is missing.
 */
export const QUICK_ACTIONS = [
  {
    id: 'collect-stale',
    label: '采集 8 个过期 ASIN',
    effect: '发起一次采集，目标就是这批过期 ASIN；提交后任务出现在本模块，可改、留痕。',
    target: { module: 'collect', anchor: null },
  },
  {
    id: 'check-readiness',
    label: '检查数据可用性',
    effect: '看数据可用性：哪些字段还缺证据、缺到什么程度。',
    /* 这条 note 原来写的是「13 的前置检查清单（九项），阶段 1 还没建」。**那句话过期了**：
       九项门槛在 F13-02 交付（`domain/optimize/precheck.js`，`amzn_optimize_precheck`，
       页面上的 `#optprecheck` 与它同源，`sect-precheck` 就是它的落点）。所以落点从
       「模块本身」改成那一块，note 只说今天仍成立的分工：「这一块按当前筛选逐项判定」与
       「全库视角的字段缺失看 03 的 DQ 问题」是两件事，谁也没替代谁。 */
    note: '原型的落点是 13 的前置检查清单（九项）。那一块已交付，按当前筛选逐项判定数据够不够；'
      + '全库视角的字段缺失与时效问题仍看 03 数据资产与质量的 DQ 问题。',
    target: { module: 'optimize', anchor: 'precheck', anchorLabel: '前置检查（九项门槛）' },
  },
  {
    id: 'competitor-gap',
    label: '评估竞品缺口',
    effect: '看机会清单：竞品有而我们没有的词，按可行动排序。',
    target: { module: 'competitor', anchor: 'opps', anchorLabel: '机会清单' },
  },
  {
    id: 'keyword-ownership',
    label: '整理关键词所有权',
    effect: '看关键词归属：每个词归哪条产品线、有没有多头认领。',
    /* 同上：note 原来是「08 的所有权工作台，阶段 1 还没建」。F08-04 交付后那句话不成立 ——
       工作台在模块 08（`sect-ownership`：批量分配 / 认领 / 释放 + 影响预览 + 二次确认），
       工具是 `amzn_keyword_ownership_*` 五个。所以落点从「模块本身」改成那一块，note 只留
       仍然成立的那半句分工：03 的冲突工作台**看**冲突，裁决落点在 08。 */
    note: '原型的落点是 08 的所有权工作台。那一块已交付（批量分配 / 认领 / 释放 + 影响预览 + 二次确认）；'
      + '03 数据资产与质量的冲突工作台只列冲突，裁决归属的入口在这里。',
    target: { module: 'kw', anchor: 'ownership', anchorLabel: '所有权工作台' },
  },
  {
    id: 'optimize-prepare',
    label: '生成优化准备包',
    effect: '看这轮准备包编排了哪几个角色、跑到哪一步；准备包由对话里的 amzn_optimize_prepare 产出，草案落在优化队列。',
    note: '原型的落点是 12 Agent 编排 · 任务画布；模块 12 已交付，但它这一版画的是运行留痕（运行 / 步骤 / 产物 / 门禁），'
      + '没有单独的「任务画布」区块，所以这里落到模块本身，不指一个不存在的分区。',
    /* The module label comes from the nav (the `agent` module is in it now), so
       this target carries none — see the header. The prototype's `#agent#canvas`
       anchor is deliberately dropped rather than kept as a link to nothing. */
    target: { module: 'agent', anchor: null },
  },
  {
    id: 'review-drafts',
    label: '审核 3 份待审批草案',
    effect: '看草案收件箱：逐份采纳或驳回；采纳前会先跑机检，阻断项不会被静默放过。',
    target: { module: 'optimize', anchor: 'inbox', anchorLabel: '草案收件箱' },
  },
]

/** The link format the todo buckets and the 最近运行 rows already use. */
export function targetLink(target) {
  const module = String(target?.module ?? '').trim()
  if (module === '') throw new Error('a quick action target needs a module')
  const anchor = String(target?.anchor ?? '').trim()
  return '#' + module + (anchor === '' ? '' : '#' + anchor)
}

/**
 * The six, resolved for the page.
 *
 * `link` is derived from `target` here rather than left to the renderer, so the
 * value that is clicked and the value the caption is built from come out of one
 * object even if a renderer is rewritten. An unavailable action would get
 * `link: null` and the shared 「未接入」 wording rather than a link that lands
 * somewhere plausible — **no declaration sets `available: false` today** (W1-8
 * removed the last one, module 12 having been delivered), which is the current
 * state and not a pending item. The field stays because it is the renderer's
 * input and the one way a future action without a destination says so; the
 * S1-B14 suite drives that branch with a synthetic action so it cannot rot.
 */
export function buildQuickActions() {
  return QUICK_ACTIONS.map(action => {
    const available = action.available !== false
    return {
      id: action.id,
      label: action.label,
      effect: action.effect ?? null,
      note: action.note ?? null,
      available,
      unavailableText: available ? null : UNAVAILABLE_KIND_TEXT,
      target: {
        module: action.target.module,
        moduleLabel: action.target.moduleLabel ?? null,
        anchor: action.target.anchor ?? null,
        anchorLabel: action.target.anchorLabel ?? null,
      },
      link: available ? targetLink(action.target) : null,
    }
  })
}
