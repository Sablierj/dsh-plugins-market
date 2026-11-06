/**
 * 把 Listing 诊断结果渲染成一份可以直接交给运营/供应商改稿的 markdown。
 *
 * 结构固定：结论 → 现状快照 → 12 项逐段（现状/问题/改法/预期影响）→ 关键词覆盖矩阵
 *          → 改造优先级 → 数据缺口（无来源项单列）。
 */
export function renderListingReport(audit, { asin, now = new Date() } = {}) {
  const lines = []
  const listing = audit.listing
  lines.push(`# ${asin} Listing 深度诊断与优化方案`)
  lines.push('')
  lines.push(`生成时间：${now.toISOString().slice(0, 16).replace('T', ' ')} · 诊断分：**${audit.score}/100**`)
  lines.push(`问题分布：高风险 ${audit.counts.high} · 中 ${audit.counts.medium} · 低 ${audit.counts.low} · 无数据来源 ${audit.counts.nodata} 项`)
  lines.push('')

  lines.push('## 一句话结论')
  lines.push('')
  const top = audit.issues.filter(finding => finding.severity === 'high').slice(0, 2)
  if (top.length) {
    lines.push(`**不是素材不够，是${top.map(item => item.section.replace(/（.*?）/g, '')).join(' 与 ')}这两处先把流量挡在了外面。**`)
    lines.push('')
    lines.push(`> 先修：${top.map(item => item.fix).join('；')}`)
  } else {
    lines.push('**没有高风险项**：文案层已具备放量条件，瓶颈更可能在广告结构与价格带。')
  }
  lines.push('')

  lines.push('## 现状快照')
  lines.push('')
  lines.push('| 字段 | 内容 |')
  lines.push('|---|---|')
  lines.push(`| 标题长度 | ${listing.title.length} 字符 |`)
  lines.push(`| 标题 | ${escapeCell(listing.title || '（空）')} |`)
  lines.push(`| 亮点长度 | ${listing.highlights.length} 字符 |`)
  lines.push(`| 五点条数 | ${listing.bullets.length} |`)
  lines.push(`| 属性数 | ${listing.attributes.length} |`)
  lines.push(`| 价格 | ${listing.price != null ? '$' + listing.price : '—'} |`)
  lines.push(`| 评分 / 评论 | ${listing.rating ?? '—'} / ${listing.reviews ?? '—'} |`)
  lines.push(`| 变体数 | ${listing.variants ?? '—'} |`)
  lines.push('')

  lines.push('## 逐项诊断')
  lines.push('')
  for (const section of audit.sections) {
    lines.push(`### ${section.name} — ${labelOf(section.status)}`)
    lines.push('')
    if (!section.findings.length) {
      lines.push('_未发现问题。_')
      lines.push('')
      continue
    }
    for (const finding of section.findings) {
      lines.push(`- **[${finding.severity}] ${finding.issue}**`)
      if (finding.evidence) lines.push(`  - 依据：${finding.evidence}`)
      if (finding.fix) lines.push(`  - 改法：${finding.fix}`)
    }
    lines.push('')
  }

  lines.push('## 关键词覆盖矩阵')
  lines.push('')
  if (!audit.coverage.length) {
    lines.push('_词库里没有该 ASIN 的词，先跑 L2。_')
  } else {
    lines.push('| 词 | 流量占比 | 标题 | 五点 | 亮点 | 描述 |')
    lines.push('|---|---|---|---|---|---|')
    for (const row of audit.coverage) {
      lines.push(`| ${row.keyword} | ${row.share != null ? (row.share * 100).toFixed(1) + '%' : '—'} | ${mark(row.inTitle)} | ${mark(row.inBullets)} | ${mark(row.inHighlights)} | ${mark(row.inDesc)} |`)
    }
    const uncovered = audit.coverage.filter(row => !row.covered)
    lines.push('')
    if (uncovered.length) lines.push(`> 完全没覆盖的词：${uncovered.map(row => row.keyword).join('、')} —— 优先补进五点或后台词。`)
    else lines.push('> 所有 tracked 词至少在文案里出现过一次。')
  }
  lines.push('')

  lines.push('## 改造优先级（按对流量/转化的影响排）')
  lines.push('')
  const ordered = [...audit.issues]
    .filter(finding => ['high', 'medium'].includes(finding.severity))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1))
  if (!ordered.length) {
    lines.push('_没有需要立刻改的项。_')
  } else {
    ordered.slice(0, 8).forEach((finding, index) => {
      lines.push(`${index + 1}. **${finding.section}**：${finding.issue}`)
      if (finding.fix) lines.push(`   - ${finding.fix}`)
    })
  }
  lines.push('')

  lines.push('## 数据缺口（这些维度本仓没有来源）')
  lines.push('')
  const nodata = audit.sections.filter(section => section.status === 'nodata')
  if (!nodata.length) lines.push('_无。_')
  else {
    for (const section of nodata) {
      lines.push(`- **${section.name}**：${section.findings[0]?.issue ?? '无来源'} —— ${section.findings[0]?.fix ?? ''}`)
    }
    lines.push('')
    lines.push('> 这些项**不能当作「没问题」**：它们是「没看过」，需要人工或 amazon-ops 采集后补判。')
  }
  lines.push('')

  lines.push('## 政策口径说明')
  lines.push('')
  lines.push('本报告使用美国站常见上限：标题 200 字符、亮点 125 字符、五点每条 500 字符、描述 2000 字符、后台词 250 字节、主图 7 张起。')
  lines.push('**具体类目可能更严**（如部分类目标题限 80 字符），发布前以该 ASIN 所在类目的后台模板为准。')
  lines.push('')
  lines.push('> 如果刚刚补录了素材（图片数/A+/差评主题），分数**下降是正常的**：那不是 Listing 变差，而是把之前「没看过的」看清楚了。')
  lines.push('')
  lines.push(`_生成器：sif-ops · ${now.toISOString().slice(0, 10)}_`)

  return lines.join('\n')
}

function labelOf(status) {
  return { ok: '通过', warn: '待优化', fail: '不合格', nodata: '无数据来源' }[status] ?? status
}

function mark(value) {
  return value ? '✓' : '—'
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').slice(0, 160)
}
