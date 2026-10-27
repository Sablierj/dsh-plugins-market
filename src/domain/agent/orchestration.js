/**
 * F12-05 编排模式 —— 把角色的步骤契约变成**有读者的声明**。
 *
 * ## 这一批只做两种模式，并且说清楚为什么不做的两种
 *
 * `roles.js` 的每个可用角色都声明了 `steps: [...]`，`amzn_agent_run_step` 的说明也说
 * 「按角色的步骤契约逐步回报」。但在此之前**没有一条代码读那份声明**：`store/agent.js`
 * 的 `recordStep` 只校验「状态在词表里、seq 是正整数、名字非空」，从不比对角色声明的
 * 步骤名与顺序。这正是本仓的招牌缺陷 —— **承诺了能力然后把它丢掉**。本模块给那份声明
 * 装上读者，交付两种模式：
 *
 *   - **顺序（sequential）**：契约里每一条按顺序 passed，才轮到下一条。
 *   - **审阅循环（review-loop，超限转人工）**：同一条契约步骤被重复 `running` 到
 *     `reviewLimit` 就不再自动重试 —— store 的状态机本来就支持 `waiting_human`。
 *
 * 条件分支与并行**不做**，理由是它们各自需要一个**不存在的数字**：
 *   - 分支条件是「评分 < 3.8」「站点非 authoritative」—— 本插件没有 LLM 通道，
 *     `scores` 没有产生者。假造一个 0 会让「缺失」被渲染成「算过」。
 *   - 真正的并行要求「多个子步骤同时 running 且各自可中断/可恢复」，而 `agent_step`
 *     是 `UNIQUE(run_id, seq)` upsert、同一 seq 只能有一行，且没有取消/恢复出口。
 *     改成「允许跳号」只是把串行伪装成并行。
 *
 * ⚠️ **给下一个读者的判据**：你要补「条件分支」之前，先回答
 * 「分支条件里那个数字是谁算的、他在哪张表里」。答不上来就不要做。
 *
 * ## 判词是**算出来的**，不是存下来的（本批不动 schema）
 *
 * 没有新表、没有新列。判词是运行状态的函数，存下来就会有两个来源 —— 而本仓
 * 「两个常量活在不同文件」已经付过代价（B-06.1）。**算得出来的不要存。**
 *
 * ## 本模块是**纯函数**
 *
 * 不碰 store、不碰 DB、不碰 I/O。入参就是 `role`、`recorded`、`options` 三样，
 * 结果只由它们决定。特别是 `reviewCount`：`agent_step` 的 `UNIQUE(run_id, seq)` 让
 * 「同一个 seq 反复 upsert 不增加行数」，所以重试次数**只能从「不同 seq 上出现同名
 * step」算**，或从传入的 `recorded` 数组算。本函数只从 `recorded` 算 —— 这一点在
 * 测试里被单独钉住，否则下一个人会以为它读库。
 */

/** 审阅循环的默认上限：同一条契约步骤被重复 running 的次数（不是总步骤数上限）。 */
export const DEFAULT_REVIEW_LIMIT = 3

/**
 * 编排模式的中文标签。**只有这两个值，而且只有这一份。**
 *
 * 页面与工具都照它画，不自己写第二份 —— 「声明与词表是两份清单」是本仓的招牌缺陷
 * （见 `docs/COORDINATION.md` §3.8b）。这里只列**实际存在的两种模式**：
 * §7.2 并行与 §7.4 条件分支没有实现（见文件头的理由），所以它们**不进词表**。
 * 什么时候真做了什么时候加 —— 先加名字后补行为 = 把缺失渲染成能力。
 */
export const AGENT_PLAN_MODE_LABELS = {
  sequential: '顺序',
  'review-loop': '审阅循环',
}

/**
 * 状态里哪些算「这一步已经过了」。只有 `passed` 算数：`skipped` 是一个**决定**，
 * 不是通过 —— 跳过一条契约步骤与通过它是两件事（与「没读到 ≠ 确实没有」同一条规矩）。
 */
function isPassed(status) {
  return String(status ?? '').trim() === 'passed'
}

/**
 * 一个契约步骤被「重试」了多少次：这门手艺的名称**出现次数 − 1**（第一次不算重试）。
 *
 * 这是本函数与 `agent_step` 表的唯一接口，而且是**弱**接口：它读的是传进来的
 * `recorded` 数组，不读表。名字相同但 seq 不同的行才算一次新的重试 —— 同一 seq 的
 * upsert 根本不增加行，所以按 seq 去重没有意义，按名字计数才是诚实的口径。
 */
function reviewCountFor(stepName, recorded) {
  return recorded.filter(entry => String(entry?.step ?? '') === stepName).length - 1
}

/**
 * 下一个该做的步骤：契约里第一条还没 `passed` 的。
 *
 * 「按**契约**顺序」而不是「按记录顺序」：记录里可能先做了后面的步骤（那正是要报的
 * `out-of-order`），而 next 应回答的是「契约上还差哪一条」。
 */
function nextExpected(expected, recorded) {
  const passedNames = new Set(recorded.filter(entry => isPassed(entry?.status)).map(entry => String(entry?.step ?? '')))
  return expected.find(name => !passedNames.has(name)) ?? null
}

/**
 * 记录里**不在**契约里的步骤名，按 seq 排。
 *
 * 同一个越界名字只报一次（去重），但顺序按它第一次出现的位置 —— 读的人要的是
 * 「哪个名字越界了」，不是「越界出现了几次」。
 */
function outOfContractNames(expected, recorded) {
  const allowed = new Set(expected)
  const ordered = [...recorded]
    .filter(entry => !allowed.has(String(entry?.step ?? '')))
    .sort((a, b) => Number(a?.seq ?? 0) - Number(b?.seq ?? 0))
  const seen = new Set()
  const names = []
  for (const entry of ordered) {
    const name = String(entry?.step ?? '')
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

/**
 * 是否出现过「先做了后面的契约步骤」：存在一条 `passed` 的契约步骤，它**前面**还有
 * 没 passed 的契约步骤。
 *
 * 只看契约内的步骤。契约外步骤由 `outOfContract` 报，且优先级更高（见下）——
 * 名字都不在契约里时，「顺序对不对」这个问题无意义。
 */
function isMisordered(expected, recorded) {
  const passedNames = new Set(recorded.filter(entry => isPassed(entry?.status)).map(entry => String(entry?.step ?? '')))
  let seenUnpassed = false
  for (const name of expected) {
    if (passedNames.has(name)) {
      if (seenUnpassed) return true
    } else {
      seenUnpassed = true
    }
  }
  return false
}

/**
 * 从运行状态算出下一条该做什么、以及为什么。
 *
 * @param {{ role?: string, steps?: string[] }} role  角色的步骤契约（来自 `AGENT_ROLES`）
 * @param {{ seq: number, step: string, status: string }[]} recorded  已记录的步骤
 * @param {{ reviewLimit?: number }} [options]
 * @returns {{
 *   mode: 'sequential' | 'review-loop',   由 reviewCount 派生：> 0 即审阅循环
 *   expected: string[],
 *   done: string[],
 *   next: string | null,
 *   outOfContract: string[],
 *   misordered: boolean,
 *   reviewCount: number,
 *   reviewLimit: number,
 *   verdict: 'ok' | 'done' | 'out-of-contract' | 'out-of-order' | 'review-exhausted',
 *   reason: string
 * }}
 */
export function planNextStep(role, recorded, options = {}) {
  const expected = Array.isArray(role?.steps) ? role.steps.map(name => String(name)) : []
  const steps = Array.isArray(recorded) ? recorded : []
  const limit = Number.isInteger(options?.reviewLimit) && options.reviewLimit > 0
    ? options.reviewLimit
    : DEFAULT_REVIEW_LIMIT

  const done = expected.filter(name => steps.some(entry => String(entry?.step ?? '') === name && isPassed(entry?.status)))
  const outOfContract = outOfContractNames(expected, steps)
  const misordered = isMisordered(expected, steps)
  const next = nextExpected(expected, steps)

  /* 审阅计数取「所有契约步骤里被重试得最多的那一个」—— 报最坏的那条，而不是总和：
     「同一条步骤被重复 running」才是上限要拦的东西，总和会随步骤条数膨胀。 */
  let reviewCount = 0
  for (const name of expected) reviewCount = Math.max(reviewCount, reviewCountFor(name, steps))
  /* 契约外名字也算重试：一个反复写错的步骤名同样是在原地打转。 */
  for (const name of outOfContract) reviewCount = Math.max(reviewCount, steps.filter(entry => String(entry?.step ?? '') === name).length - 1)

  /* §7.1 顺序 vs §7.3 审阅循环。判据是**已经发生过什么**，不是角色声明了什么：
     reviewCount > 0 意味着至少有一条步骤被重复记录过 —— 那就是审阅循环转过了。
     这两个值是**实际存在的两种模式**；§7.2 并行与 §7.4 条件分支没有实现，
     所以它们**不进词表**（什么时候真做了什么时候加）。
     ⚠️ reviewCount 必须在上面算完（它确实在上面），别挪顺序。 */
  const mode = reviewCount > 0 ? 'review-loop' : 'sequential'
  let verdict
  let reason

  /* ── 优先级：out-of-contract **先于** out-of-order ──────────────────────────
     名字都不在契约里时，「顺序对不对」这个问题无意义 —— 不能报一个自己都算不出来的
     判词。这与「没读到 ≠ 确实没有」是同一条规矩：分不清就明说，不要猜。 */
  if (outOfContract.length > 0) {
    verdict = 'out-of-contract'
    reason = `步骤 ${outOfContract.join('、')} 不在角色「${String(role?.role ?? role?.id ?? '')}」的步骤契约里；`
      + `契约允许的是: ${expected.length === 0 ? '（该角色未声明任何步骤）' : expected.join(' → ')}`
  } else if (misordered) {
    verdict = 'out-of-order'
    reason = `先做了后面的步骤：契约顺序是 ${expected.join(' → ')}，`
      + `下一步该先补 ${next === null ? '（无）' : next}`
  } else if (reviewCount >= limit) {
    verdict = 'review-exhausted'
    reason = `同一条步骤已重复 ${reviewCount + 1} 次（上限 ${limit}），达到审阅上限，转人工（waiting_human），不再自动重试`
  } else if (expected.length > 0 && next === null) {
    verdict = 'done'
    reason = `契约里 ${expected.length} 条步骤全部 passed：${expected.join(' → ')} —— 可以收尾`
  } else {
    verdict = 'ok'
    reason = expected.length === 0
      ? '该角色未声明步骤契约，无可编排的下一步'
      : `还有契约步骤未 passed，下一步做 ${next}（已完成 ${done.length}/${expected.length}）`
  }

  return {
    mode,
    expected,
    done,
    next,
    outOfContract,
    misordered,
    reviewCount,
    reviewLimit: limit,
    verdict,
    reason,
  }
}
