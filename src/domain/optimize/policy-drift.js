/**
 * 政策与规则集的**挂空**检查。
 *
 * ## 这条要解决的问题
 *
 * 政策通过 `policy_rule` 挂到规则上：一条「标题不得超过 200 字符」的政策，
 * 如果它挂的是 `title.length.max`，那么**代码是在查它的**；如果它没挂任何规则，
 * 或者挂的那条规则已经不在生效规则集里（被停用、被删、版本换了没跟过来），
 * 那这条政策就只是**一段文字** —— 报告会引用它，代码却从不执行它。
 *
 * 这种"看起来在管、其实没管"的状态比完全没有政策更危险：人以为有保护，
 * 于是不再盯这件事。
 *
 * ## 为什么不能做"数值冲突检测"
 *
 * 政策正文是自然语言（「标题不得超过 200 个字符」），规则是结构化阈值。
 * 想比较两者就得解析正文里的数字 —— 解析错一次，就会把一条 80 字符的服饰类政策
 * 当成适用于全场。所以这里**只做可判定的部分**：这条政策引用的规则，
 * 在不在当前生效规则集里。判不了的（数值是否一致）不猜。
 */

/**
 * @param {Array<{id: string, title: string, ruleIds: string[]}>} policies 生效中的政策
 * @param {{version: string, rules: Array<{id: string}>}} roster 当前生效规则集
 * @returns {{checkedPolicies: number, linkedRules: number, missing: Array<{policyId: string, title: string, ruleId: string}>}}
 */
export function policyRuleDrift(policies, roster) {
  const active = new Set(
    (Array.isArray(roster?.rules) ? roster.rules : [])
      .map(rule => String(rule?.id ?? rule?.ruleId ?? '').trim())
      .filter(id => id !== ''),
  )

  const missing = []
  let checkedPolicies = 0
  let linkedRules = 0

  for (const policy of Array.isArray(policies) ? policies : []) {
    const ruleIds = Array.isArray(policy?.ruleIds) ? policy.ruleIds : []
    if (ruleIds.length === 0) continue
    checkedPolicies += 1
    for (const ruleId of ruleIds) {
      linkedRules += 1
      if (active.has(String(ruleId))) continue
      missing.push({
        policyId: String(policy.id ?? ''),
        title: String(policy.title ?? ''),
        ruleId: String(ruleId),
      })
    }
  }

  return { checkedPolicies, linkedRules, missing }
}

/** 一句话结论，工具与报告共用，避免两处措辞漂移。 */
export function policyRuleDriftLine(drift, rosterVersion) {
  if (drift === null || drift === undefined) return null
  if (drift.checkedPolicies === 0) {
    return '这些政策都没有挂规则 —— 它们是纯文字约束，代码不检查其中任何一条。'
      + '要让它真的生效，用 amzn_policy_link 挂到对应规则上。'
  }
  if (drift.missing.length === 0) {
    return `这些政策共挂 ${drift.linkedRules} 条规则，全部在当前生效规则集（${rosterVersion}）里。`
  }
  const names = drift.missing.slice(0, 5).map(item => `${item.title} → ${item.ruleId}`).join('；')
  return `⚠️ ${drift.missing.length} 条政策挂的规则不在生效规则集（${rosterVersion}）里：${names}`
    + `。这些政策只是文字，代码没有在查它们。`
}
