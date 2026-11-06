/**
 * 深度总报告：把「运营数据 + 关键词 + 竞品 + Listing 诊断 + 改稿 + 待办 + 数据缺口」
 * 合成**一份**交付物，输出两种形态：
 *   - markdown：发群里/进库/给模型读
 *   - html：自包含单文件（内联 CSS + 内联 SVG），能直接发客户、能打印成 PDF
 *
 * 铁律：
 *   1. 没有任何外部引用（无 CDN、无字体、无图片链接），断网也能打开；
 *   2. 每个数字都标口径；没有来源的维度写「无数据来源」，不当成通过；
 *   3. 结论必须能回溯到证据（哪一周、哪个词、差几位）。
 */

export function buildDeepReport({ asin, board, audit, draft, actions = [], health = null, competition = null, now = new Date() }) {
  const item = (board?.asins ?? []).find(row => row.asin === asin) ?? null
  const weeks = item?.weeks ?? []
  const markdown = renderMarkdown({ asin, item, weeks, audit, draft, actions, health, competition, now })
  const html = renderHtml({ asin, item, weeks, audit, draft, actions, health, competition, now })
  return { asin, markdown, html, generatedAt: now.toISOString() }
}

// ── 共用小工具 ────────────────────────────────────────────
const fmt = value => (value === null || value === undefined ? '—' : Math.round(Number(value)).toLocaleString('en-US'))
const pct = value => (value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`)
const signed = value => (value === null || value === undefined ? '—' : `${value >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(1)}%`)
const statusLabel = status => ({ ok: '通过', warn: '待优化', fail: '不合格', nodata: '无数据来源' }[status] ?? status)

function chartSvg(weeks, { width = 560, height = 160 } = {}) {
  if (!weeks.length) return '<p class="muted">还没有流量数据（先跑 L1）。</p>'
  const pad = 24
  const max = Math.max(1, ...weeks.map(week => Math.max(week.total_score ?? 0, week.nf_score ?? 0, week.ad_score ?? 0)))
  const step = weeks.length === 1 ? 0 : (width - pad * 2) / (weeks.length - 1)
  const point = (value, index) => {
    const x = pad + step * index
    const y = height - pad - (height - pad * 2) * ((value ?? 0) / max)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }
  const line = key => weeks.map((week, index) => point(week[key], index)).join(' ')
  const labels = weeks
    .map((week, index) => {
      if (weeks.length > 8 && index % 3 !== 0 && index !== weeks.length - 1) return ''
      const x = pad + step * index
      return `<text x="${x.toFixed(0)}" y="${height - 6}" font-size="9" fill="#8b95a5" text-anchor="middle">${week.period_start.slice(5)}</text>`
    })
    .join('')
  return `
<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="周流量走势">
  <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#2a3240" stroke-width="1"/>
  <polyline fill="none" stroke="#4cc2ff" stroke-width="2" points="${line('nf_score')}"/>
  <polyline fill="none" stroke="#ffb454" stroke-width="2" points="${line('ad_score')}"/>
  ${labels}
  <text x="${pad}" y="12" font-size="10" fill="#8b95a5">峰值 ${Math.round(max)}</text>
  <text x="${width - pad - 90}" y="12" font-size="10" fill="#4cc2ff">━ 自然</text>
  <text x="${width - pad - 40}" y="12" font-size="10" fill="#ffb454">━ 广告</text>
</svg>`
}

function barRow(label, ratio, color) {
  const width = Math.max(0, Math.min(100, (ratio ?? 0) * 100))
  return `<div class="bar"><span>${label}</span><i style="width:${width.toFixed(1)}%;background:${color}"></i><b>${width.toFixed(1)}%</b></div>`
}

// ── Markdown 版 ───────────────────────────────────────────
function renderMarkdown({ asin, item, weeks, audit, draft, actions, health, competition, now }) {
  const lines = []
  const latest = weeks[weeks.length - 1] ?? null
  lines.push(`# ${asin} 商品深度分析与优化总报告`)
  lines.push('')
  lines.push(`生成时间：${now.toISOString().slice(0, 16).replace('T', ' ')} · 数据截止：${item?.dataDate ?? '未知'}`)
  lines.push(`商品：${item?.title ?? '（未采集标题）'} · ${item?.price != null ? '$' + item.price : '—'} · ${item?.star ?? '—'} 星 / ${item?.reviews ?? '—'} 评`)
  lines.push('')

  lines.push('## 一、结论（先看这一段）')
  lines.push('')
  if (actions.length) {
    lines.push(`**今天先做这 ${Math.min(actions.length, 3)} 件：**`)
    lines.push('')
    actions.slice(0, 3).forEach((action, index) => lines.push(`${index + 1}. 【${action.verb}】${action.title}`))
  } else {
    lines.push('**没有触发阈值**，按既有节拍观察。')
  }
  lines.push('')
  lines.push(`Listing 诊断分 **${audit?.score ?? '—'}/100**（高 ${audit?.counts.high ?? 0} / 中 ${audit?.counts.medium ?? 0} / 低 ${audit?.counts.low ?? 0} / 无来源 ${audit?.counts.nodata ?? 0} 项）。`)
  lines.push('')

  lines.push('## 二、流量与结构')
  lines.push('')
  if (!weeks.length) lines.push('_未采集：先跑 L1。_')
  else {
    lines.push('| 周起始 | 总流量 | 自然 | 广告 | 自然占比 | 环比 |')
    lines.push('|---|---|---|---|---|---|')
    for (const week of [...weeks].reverse().slice(0, 12)) {
      lines.push(`| ${week.period_start} | ${fmt(week.total_score)} | ${fmt(week.nf_score)} | ${fmt(week.ad_score)} | ${pct(week.nf_ratio)} | ${signed(week.total_change_ratio)} |`)
    }
    lines.push('')
    if (latest) lines.push(`最近一周：总 ${fmt(latest.total_score)}，自然 ${fmt(latest.nf_score)}（${pct(latest.nf_ratio)}），广告 ${fmt(latest.ad_score)}（${pct(latest.ad_ratio)}）。`)
  }
  lines.push('')

  lines.push('## 三、关键词（带量词与位置）')
  lines.push('')
  if (!audit?.coverage?.length) lines.push('_未采集：先跑 L2。_')
  else {
    lines.push('| 词 | 流量占比 | 标题 | 五点 | 亮点 |')
    lines.push('|---|---|---|---|---|')
    for (const row of audit.coverage.slice(0, 10)) {
      lines.push(`| ${row.keyword} | ${row.share != null ? pct(row.share) : '—'} | ${row.inTitle ? '✓' : '—'} | ${row.inBullets ? '✓' : '—'} | ${row.inHighlights ? '✓' : '—'} |`)
    }
  }
  lines.push('')

  lines.push('## 四、竞品与市场格局')
  lines.push('')
  if (!competition?.snapshot) lines.push('_未采集：在「竞品」页跑一次（2 点/词）。_')
  else {
    const snap = competition.snapshot
    lines.push(`词 **${snap.keyword}** · 覆盖 ${snap.visible_asin_count ?? '—'} 个 ASIN · 集中度 ${snap.concentration_level ?? '—'} · 模式 ${snap.competition_mode ?? '—'}`)
    lines.push('')
    lines.push(`Top3 点击 ${pct(snap.top3_click_share)}，Top3 转化 ${pct(snap.top3_conversion_share)}。`)
    if (snap.divergence_insight) { lines.push(''); lines.push(`> ${snap.divergence_insight}`) }
    if (snap.leader_note) { lines.push(''); lines.push(`> ${snap.leader_note}`) }
  }
  lines.push('')

  lines.push('## 五、Listing 逐项诊断')
  lines.push('')
  for (const section of audit?.sections ?? []) {
    lines.push(`### ${section.name} — ${statusLabel(section.status)}`)
    lines.push('')
    if (!section.findings?.length) lines.push('_未发现问题。_')
    else {
      for (const finding of section.findings) {
        lines.push(`- **[${finding.severity}] ${finding.issue}**`)
        if (finding.evidence) lines.push(`  - 依据：${finding.evidence}`)
        if (finding.fix) lines.push(`  - 改法：${finding.fix}`)
      }
    }
    lines.push('')
  }

  lines.push('## 六、改稿草稿与复测')
  lines.push('')
  if (!draft) lines.push('_未生成：在「优化」页点「生成改稿草稿」。_')
  else {
    lines.push(`复测：**${draft.diff.scoreBefore} → ${draft.diff.scoreAfter}（${draft.diff.delta >= 0 ? '+' : ''}${draft.diff.delta}）**`)
    lines.push('')
    lines.push('```')
    lines.push(`标题：${draft.draft.title}`)
    lines.push('```')
    lines.push('')
    lines.push(`亮点：\`${draft.draft.itemHighlights}\``)
    lines.push('')
    draft.draft.bullets.forEach((text, index) => lines.push(`${index + 1}. ${text}`))
    lines.push('')
  }

  lines.push('## 七、数据健康与无来源项')
  lines.push('')
  if (health) {
    lines.push(`覆盖：流量 ${Math.round((health.coverage.traffic ?? 0) * 100)}% · 关键词 ${Math.round((health.coverage.keywords ?? 0) * 100)}% · 销量 ${Math.round((health.coverage.sales ?? 0) * 100)}% · 广告 ${Math.round((health.coverage.ads ?? 0) * 100)}%`)
    lines.push('')
  }
  const nodata = (audit?.sections ?? []).filter(section => section.status === 'nodata')
  for (const section of nodata) lines.push(`- **${section.name}**：无数据来源 —— ${section.findings?.[0]?.fix ?? ''}`)
  lines.push('')

  lines.push('## 八、口径与政策说明')
  lines.push('')
  lines.push('- 流量分是 SIF 的相对量，只看趋势与结构，不能跨站点横比。')
  lines.push('- 自然位/广告位来自 SIF 周期采集；「未进前 3 页」与「未被采集」是两件事。')
  lines.push('- 政策校验用美国站常见上限（标题 200 / 亮点 125 / 五点 500 / 描述 2000 / 后台词 250 字节），**类目可能更严**，发布前以后台模板为准。')
  lines.push('')
  lines.push(`_生成器：sif-ops · ${now.toISOString().slice(0, 10)}_`)
  return lines.join('\n')
}

// ── HTML 版（自包含）────────────────────────────────────────
function renderHtml({ asin, item, weeks, audit, draft, actions, health, competition, now }) {
  const latest = weeks[weeks.length - 1] ?? null
  const rows = [...weeks].reverse().slice(0, 12).map(week => `
    <tr>
      <td>${week.period_start}</td><td>${fmt(week.total_score)}</td><td>${fmt(week.nf_score)}</td>
      <td>${fmt(week.ad_score)}</td><td>${pct(week.nf_ratio)}</td><td>${signed(week.total_change_ratio)}</td>
    </tr>`).join('')

  const actionItems = actions.slice(0, 5).map(action => `
    <li><b>[${action.verb}]</b> ${escapeHtml(action.title)}<div class="muted">${escapeHtml(action.detail ?? '')}</div>
    ${action.action ? `<div class="fix">动作：${escapeHtml(action.action)}</div>` : ''}</li>`).join('')

  const sectionCards = (audit?.sections ?? []).map(section => `
    <div class="card">
      <div class="card-head"><span class="badge ${section.status}">${statusLabel(section.status)}</span><b>${escapeHtml(section.name)}</b></div>
      ${(section.findings ?? []).map(finding => `
        <div class="finding ${finding.severity}">
          <div>${escapeHtml(finding.issue)}</div>
          ${finding.evidence ? `<div class="muted">依据：${escapeHtml(finding.evidence)}</div>` : ''}
          ${finding.fix ? `<div class="fix">改法：${escapeHtml(finding.fix)}</div>` : ''}
        </div>`).join('') || '<div class="muted">未发现问题。</div>'}
    </div>`).join('')

  const coverageRows = (audit?.coverage ?? []).slice(0, 12).map(row => `
    <tr><td>${escapeHtml(row.keyword)}</td><td>${row.share != null ? pct(row.share) : '—'}</td>
    <td>${row.inTitle ? '✓' : '—'}</td><td>${row.inBullets ? '✓' : '—'}</td><td>${row.inHighlights ? '✓' : '—'}</td></tr>`).join('')

  const draftBlock = draft ? `
    <h3>复测：${draft.diff.scoreBefore} → ${draft.diff.scoreAfter}（${draft.diff.delta >= 0 ? '+' : ''}${draft.diff.delta}）</h3>
    <pre>${escapeHtml(draft.draft.title)}</pre>
    <p class="muted">亮点：${escapeHtml(draft.draft.itemHighlights)}</p>
    <ol>${draft.draft.bullets.map(text => `<li><pre>${escapeHtml(text)}</pre></li>`).join('')}</ol>
    <p class="muted">后台搜索词：${escapeHtml(draft.draft.searchTerms || '（无需补充）')}</p>` : '<p class="muted">未生成改稿草稿。</p>'

  const nodata = (audit?.sections ?? []).filter(section => section.status === 'nodata')
  const competitionBlock = competition?.snapshot ? `
    <p>词 <b>${escapeHtml(competition.snapshot.keyword)}</b> · 覆盖 ${competition.snapshot.visible_asin_count ?? '—'} 个 ASIN · 集中度 ${escapeHtml(competition.snapshot.concentration_level ?? '—')}</p>
    ${barRow('Top3 点击份额', competition.snapshot.top3_click_share, '#4cc2ff')}
    ${barRow('Top3 转化份额', competition.snapshot.top3_conversion_share, '#38d39f')}
    ${competition.snapshot.divergence_insight ? `<p class="muted">${escapeHtml(competition.snapshot.divergence_insight)}</p>` : ''}` : '<p class="muted">未采集竞品格局。</p>'

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${asin} 商品深度分析与优化总报告</title>
<style>
  :root{ --bg:#0f1115; --panel:#161a21; --line:#262d38; --text:#e6e9ef; --muted:#8b95a5;
         --accent:#4cc2ff; --ok:#38d39f; --warn:#ffb454; --err:#ff6b6b; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{max-width:980px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:22px;margin:0 0 6px}
  h2{font-size:16px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  h3{font-size:14px;margin:18px 0 8px}
  .muted{color:var(--muted);font-size:12px}
  .meta{color:var(--muted);font-size:12px;margin-bottom:18px}
  .kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}
  .kpi div{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
  .kpi b{display:block;font-size:20px;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0}
  th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left}
  th{color:var(--muted);font-weight:500}
  ol,ul{padding-left:20px}
  li{margin:8px 0}
  pre{background:#0b0e13;border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,Consolas,monospace;margin:6px 0}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0}
  .card-head{display:flex;gap:8px;align-items:center;margin-bottom:6px}
  .badge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line)}
  .badge.ok{color:var(--ok);border-color:var(--ok)}
  .badge.warn{color:var(--warn);border-color:var(--warn)}
  .badge.fail{color:var(--err);border-color:var(--err)}
  .badge.nodata{color:var(--muted)}
  .finding{border-left:2px solid var(--line);padding-left:8px;margin:6px 0}
  .finding.high{border-left-color:var(--err)}
  .finding.medium{border-left-color:var(--warn)}
  .fix{color:var(--text);font-size:12px;margin-top:2px}
  .bar{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px}
  .bar span{width:110px;color:var(--muted)}
  .bar i{display:block;height:8px;border-radius:4px}
  .bar b{margin-left:auto}
  [data-nodata]{color:var(--muted)}
  @media print{ body{background:#fff;color:#111} .card,.kpi div{background:#fff} }
</style></head>
<body><div class="wrap">
  <h1>${asin} 商品深度分析与优化总报告</h1>
  <div class="meta">生成 ${now.toISOString().slice(0, 16).replace('T', ' ')} · 数据截止 ${item?.dataDate ?? '未知'} ·
    商品：${escapeHtml(item?.title ?? '（未采集标题）')} · ${item?.price != null ? '$' + item.price : '—'} · ${item?.star ?? '—'} 星 / ${item?.reviews ?? '—'} 评</div>

  <div class="kpi">
    <div><span class="muted">最新周总流量</span><b>${fmt(latest?.total_score)}</b></div>
    <div><span class="muted">自然占比</span><b>${pct(latest?.nf_ratio)}</b></div>
    <div><span class="muted">广告占比</span><b>${pct(latest?.ad_ratio)}</b></div>
    <div><span class="muted">Listing 诊断分</span><b>${audit?.score ?? '—'}</b></div>
  </div>

  <h2>一、今天先做这几件</h2>
  <ol>${actionItems || '<li class="muted">没有触发阈值</li>'}</ol>

  <h2>二、流量走势（自然 vs 广告）</h2>
  ${chartSvg(weeks)}
  <table><thead><tr><th>周</th><th>总流量</th><th>自然</th><th>广告</th><th>自然占比</th><th>环比</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">未采集</td></tr>'}</tbody></table>

  <h2>三、关键词覆盖</h2>
  <table><thead><tr><th>词</th><th>流量占比</th><th>标题</th><th>五点</th><th>亮点</th></tr></thead><tbody>${coverageRows || '<tr><td colspan="5" class="muted">未采集</td></tr>'}</tbody></table>

  <h2>四、竞品与市场格局</h2>
  ${competitionBlock}

  <h2>五、Listing 逐项诊断（12 维）</h2>
  ${sectionCards || '<p class="muted">未诊断</p>'}

  <h2>六、改稿草稿与复测</h2>
  ${draftBlock}

  <h2>七、数据缺口（不能当成通过）</h2>
  ${nodata.length ? `<ul>${nodata.map(section => `<li><b>${escapeHtml(section.name)}</b>：${escapeHtml(section.findings?.[0]?.fix ?? '无数据来源')}</li>`).join('')}</ul>` : '<p class="muted">无。</p>'}

  <h2>八、口径与政策说明</h2>
  <ul class="muted">
    <li>流量分为 SIF 相对量，只看趋势与结构，不跨站点横比。</li>
    <li>自然位/广告位来自周期性采集；「未进前 3 页」与「未被采集」不同。</li>
    <li>政策校验取美国站常见上限（标题 200 / 亮点 125 / 五点 500 / 描述 2000 / 后台词 250 字节），类目可能更严，以后台模板为准。</li>
    <li>数据健康：${health ? `流量 ${Math.round((health.coverage.traffic ?? 0) * 100)}% · 关键词 ${Math.round((health.coverage.keywords ?? 0) * 100)}% · 销量 ${Math.round((health.coverage.sales ?? 0) * 100)}% · 广告 ${Math.round((health.coverage.ads ?? 0) * 100)}%` : '—'}</li>
  </ul>
  <p class="muted">sif-ops · ${now.toISOString().slice(0, 10)}</p>
</div></body></html>`
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, char => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ))
}
