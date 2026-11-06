/**
 * 组合视图：一次看所有 ASIN，回答「今天先动哪个品」。
 *
 * 单个品的深度报告解决「怎么改」，组合视图解决「先改谁」——这是运营每天真正要做的决策。
 * 排序不是按流量大小，而是按「问题严重度 × 流量权重」：一个 40 分的品配 10% 流量，不如
 * 一个 70 分的品配 60% 流量值得先动。
 */
export function renderPortfolio({ marketplace = 'US', rows = [], now = new Date() }) {
  const sorted = [...rows].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const markdown = []
  markdown.push(`# ${marketplace} 站点 · 商品组合总览`)
  markdown.push('')
  markdown.push(`生成时间：${now.toISOString().slice(0, 16).replace('T', ' ')} · 共 ${rows.length} 个商品`)
  markdown.push('')
  markdown.push('## 结论：先动这几个')
  markdown.push('')
  const top = sorted.slice(0, 3)
  if (!top.length) markdown.push('_还没有对象。_')
  else {
    top.forEach((row, index) => {
      markdown.push(`${index + 1}. **${row.asin}** — ${row.headline}`)
      if (row.nextAction) markdown.push(`   - 下一步：${row.nextAction}`)
    })
  }
  markdown.push('')
  markdown.push('## 全部商品')
  markdown.push('')
  markdown.push('| ASIN | 标题 | 最新周流量 | 自然占比 | 诊断分 | 数据截止 | 首要问题 |')
  markdown.push('|---|---|---|---|---|---|---|')
  for (const row of sorted) {
    markdown.push(`| ${row.asin} | ${truncate(row.title, 28)} | ${fmt(row.totalScore)} | ${pct(row.nfRatio)} | ${row.score ?? '—'} | ${row.dataDate ?? '—'} | ${truncate(row.headline, 40)} |`)
  }
  markdown.push('')
  markdown.push('## 口径')
  markdown.push('')
  markdown.push('- 排序 = 问题严重度 × 流量权重；流量大的品，同样的问题更值得先修。')
  markdown.push('- 诊断分来自 Listing 12 维规则（0–100，保底 5）；不同轮次权重若调整过，跨轮分数不可直接比较。')
  markdown.push('- 无数据来源的维度不计分，也不当成通过。')
  markdown.push('')
  markdown.push(`_生成器：sif-ops · ${now.toISOString().slice(0, 10)}_`)

  return { markdown: markdown.join('\n'), rows: sorted }
}

/** 把单个品诊断结果压成一行摘要：标题即「最该修的那件事」。 */
export function summarizeForPortfolio({ asin, item, audit, actions = [] }) {
  const latest = item?.latest ?? null
  const topAction = actions[0] ?? null
  const headline = topAction
    ? `${topAction.verb}：${topAction.title}`
    : (audit?.issues?.[0]?.issue ?? '未发现问题')
  const severity = audit
    ? audit.counts.high * 3 + audit.counts.medium * 1.5 + audit.counts.low * 0.5
    : 0
  const flowWeight = (latest?.total_score ?? 0) / 1000
  return {
    asin,
    title: item?.title ?? null,
    totalScore: latest?.total_score ?? null,
    nfRatio: latest?.nf_ratio ?? null,
    dataDate: item?.dataDate ?? null,
    score: audit?.score ?? null,
    headline,
    nextAction: topAction?.action ?? null,
    priority: Number((severity * (1 + Math.min(3, flowWeight))).toFixed(3)),
  }
}

const fmt = value => (value === null || value === undefined ? '—' : Math.round(Number(value)).toLocaleString('en-US'))
const pct = value => (value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`)
const truncate = (text, size) => {
  const value = String(text ?? '')
  return value.length > size ? value.slice(0, size) + '…' : value
}
