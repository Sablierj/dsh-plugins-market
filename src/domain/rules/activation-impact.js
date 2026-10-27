/**
 * P3-2 规则版本激活的影响面预览。
 *
 * ## 为什么只有这一个动作还缺预览
 *
 * 逐个核过：ASIN 归档/删除、字段覆盖、产品线信号、保留清理、提示词删除、发布登记
 * 都已经有「先算影响面再执行」的入口（`archiveImpact` / `asinReferenceReport` /
 * `overwriteList` / `previewSignalImpact` / `referencedBy` / `scanPromptReferences` /
 * `delivery.js` 的字段三分类）。规则版本激活是唯一只有审批开关、没有影响面的。
 *
 * ## 这个动作和别的不一样，必须说清
 *
 * 别的动作动的是**已经存在的行**，所以「影响 N 条」数得出来。规则版本激活**不动任何既有行**
 * —— 它换的是**以后**拿哪一份规则去判。所以这里能数的是：
 *
 *   ① 这次激活会让多少条规则**变成新的**（新增）／**消失**（移除）／**改了判据**（变更）；
 *   ② 有多少条规则**当前是停用的**，激活后仍是停用（不会被"顺便启用"）；
 *   ③ 有多少**已有的判定结果会因此过时** —— 这一项**本仓算不出来**，
 *      因为判定结果没有存「当时用的是哪一版规则」。不能说成 0，只能说不知道。
 *
 * 第三点是这个模块存在的主要意义：**别让"影响面为 0"看起来像"没有影响"**。
 */

/** 一条规则的身份键：规则 id 在版本之间稳定，是唯一可靠的对齐依据。 */
function byRuleId(rules) {
  const map = new Map()
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule !== null && typeof rule === 'object' && typeof rule.id === 'string' && rule.id !== '') {
      map.set(rule.id, rule)
    }
  }
  return map
}

/** 两条规则在影响判定语义的字段上是否等价。 */
function sameJudgement(a, b) {
  return a.kind === b.kind
    && a.severity === b.severity
    && a.scope === b.scope
    && JSON.stringify(a.appliesTo ?? []) === JSON.stringify(b.appliesTo ?? [])
    && JSON.stringify(a.params ?? null) === JSON.stringify(b.params ?? null)
}

/**
 * @param current 当前生效版本的规则数组（`loadRosterVersion().rules`）
 * @param next    要激活的版本的规则数组
 *
 * 注意：**停用状态在规则行上**（`rowToRule` 的 `enabled`，来自 `rule.enabled`），
 * 不需要调用方另外传一个 disabled 集合 —— 我第一版就是那么写的，
 * 那会让调用方有机会传一份与库不一致的集合，而两份口径迟早分叉。
 */
export function activationImpact(current, next, { currentVersion = null, nextVersion = null } = {}) {
  const before = byRuleId(current)
  const after = byRuleId(next)

  const added = [...after.keys()].filter(id => !before.has(id))
  const removed = [...before.keys()].filter(id => !after.has(id))
  const changed = [...after.keys()].filter((id) => {
    if (!before.has(id)) return false
    return !sameJudgement(before.get(id), after.get(id))
  })
  const unchanged = [...after.keys()].filter((id) => {
    if (!before.has(id)) return false
    return sameJudgement(before.get(id), after.get(id))
  })

  /* 停用的规则在两版里都存在时，激活**不会**把它打开 —— 停用是独立于版本的状态。
     这一点必须说出来，否则用户会以为"换了版本就全都生效了"。 */
  const staysDisabled = [...after.keys()].filter((id) => after.get(id).enabled === false)

  const blocks = added.filter(id => after.get(id).severity === 'block').length
  const newlyBlocking = changed.filter(id => before.get(id).severity !== 'block' && after.get(id).severity === 'block').length

  return {
    currentVersion,
    nextVersion,
    /* 会变的 */
    added: { count: added.length, ids: added.slice(0, 20), more: Math.max(0, added.length - 20) },
    removed: { count: removed.length, ids: removed.slice(0, 20), more: Math.max(0, removed.length - 20) },
    changed: { count: changed.length, ids: changed.slice(0, 20), more: Math.max(0, changed.length - 20) },
    unchangedCount: unchanged.length,
    /* 最容易误判的两项，单独说 */
    staysDisabled: { count: staysDisabled.length, ids: staysDisabled.slice(0, 20) },
    becomesBlocking: { count: newlyBlocking, ids: changed.filter(id => before.get(id).severity !== 'block' && after.get(id).severity === 'block').slice(0, 20) },
    blockRuleCount: blocks,
    /* 明确说「不知道」的那一项 */
    staleJudgements: null,
    staleJudgementsReason:
      '本仓没有存「某条判定结果是用哪一版规则算出来的」，所以「激活后有多少既有判定会过时」'
      + '算不出来 —— 这不是 0，是不知道。要能回答它，得先给判定结果加一列 rule_version。',
    /** 一句话结论，供页面直接显示。 */
    conclusion: (() => {
      const changedCount = added.length + removed.length + changed.length
      if (changedCount === 0) {
        return `两版在「判哪些、判多重」上没有差别（各 ${after.size} 条规则，${unchanged.length} 条判据相同）；`
          + '激活只会换掉版本号本身。'
      }
      const parts = []
      if (added.length > 0) parts.push(`新增 ${added.length} 条`)
      if (removed.length > 0) parts.push(`移除 ${removed.length} 条`)
      if (changed.length > 0) parts.push(`判据变更 ${changed.length} 条`)
      const extra = newlyBlocking > 0 ? `，其中 ${newlyBlocking} 条从非阻断升为阻断` : ''
      const dis = staysDisabled.length > 0 ? `；另有 ${staysDisabled.length} 条处于停用状态，激活不会把它们打开` : ''
      return `激活后：${parts.join('、')}${extra}${dis}。`
    })(),
  }
}
