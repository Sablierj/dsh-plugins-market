/**
 * 报告：把看板数据写成一份**能直接发给运营的 markdown**。
 *
 * 三条硬规矩：
 *   1. 每个数字都标口径与数据截止日（T-1），不写「今天」；
 *   2. 结论必须带证据行（哪几周、哪个词、差几位）；
 *   3. 缺什么数据要明写「未采集」，不能留空让人误读成 0。
 */

export function buildReport(dashboard, { asin, keywordRows = [], competition = null, actions = [], now = new Date() } = {}) {
  const item = (dashboard.asins ?? []).find(row => row.asin === asin)
  if (!item) return null

  const lines = []
  const date = isoDate(now)
  const latest = item.latest
  const prev = item.previous

  lines.push(`# ${item.asin} 运营分析报告`)
  lines.push('')
  lines.push(`生成时间：${now.toISOString().slice(0, 16).replace('T', ' ')}（本地时区 Asia/Shanghai）`)
  lines.push(`数据截止：${item.dataDate ?? '未知'}（SIF 每日更新，T-1）`)
  lines.push(`商品：${item.title ?? '（未采集标题）'}`)
  lines.push(`价格 / 评分 / 评论：${item.price != null ? '$' + item.price : '—'} · ${item.star ?? '—'} 星 · ${item.reviews ?? '—'} 评`)
  lines.push('')

  // 一句话结论（排除式）
  lines.push('## 一句话结论')
  lines.push('')
  const head = item.insights?.[0]
  if (head) {
    lines.push(`**${head.title}**`)
    if (head.suggestion) lines.push('')
    if (head.suggestion) lines.push(`> 建议：${head.suggestion}`)
  } else {
    lines.push('**本周没有触发任何告警阈值**：流量与结构都在历史区间内，按既有节拍继续观察。')
  }
  lines.push('')

  // 今日待办（按影响面排序，最多 5 条）
  lines.push('## 今日待办（按影响面排序）')
  lines.push('')
  if (!actions.length) {
    lines.push('_没有触发阈值；保持节拍即可。_')
  } else {
    actions.slice(0, 5).forEach((item, index) => {
      lines.push(`${index + 1}. **【${item.verb}】${item.title}**`)
      if (item.detail) lines.push(`   - 依据：${item.detail}`)
      if (item.action) lines.push(`   - 动作：${item.action}`)
    })
  }
  lines.push('')

  // 流量
  lines.push('## 流量走势（周，口径 = 父体+子体聚合）')
  lines.push('')
  if (!item.weeks.length) {
    lines.push('_未采集：还没有跑过 L1 同步。_')
  } else {
    lines.push('| 周起始 | 总流量分 | 自然 | 广告 | 自然占比 | 环比 |')
    lines.push('|---|---|---|---|---|---|')
    for (const week of [...item.weeks].reverse()) {
      lines.push(`| ${week.period_start} | ${fix(week.total_score)} | ${fix(week.nf_score)} | ${fix(week.ad_score)} | ${pct(week.nf_ratio)} | ${signed(week.total_change_ratio)} |`)
    }
    lines.push('')
    if (latest && prev) {
      const nfDelta = delta(latest.nf_score, prev.nf_score)
      const adDelta = delta(latest.ad_score, prev.ad_score)
      lines.push(`最近一周（${latest.period_start}）：总流量 ${fix(latest.total_score)}，自然 ${fix(latest.nf_score)}（${signed(nfDelta)}），广告 ${fix(latest.ad_score)}（${signed(adDelta)}）。`)
      const adLed = adDelta !== null && nfDelta !== null && Math.abs(adDelta) > Math.abs(nfDelta) * 1.5
      if (adLed) lines.push('')
      if (adLed) lines.push('> 变化主要来自广告侧，不是自然位：先查广告结构，别动 Listing。')
    }
  }
  lines.push('')

  // 关键词
  lines.push('## 关键词（近 30 天，L2 口径）')
  lines.push('')
  if (!item.keywords.length) {
    lines.push('_未采集：L2 还没跑过（6 点/ASIN）。跑完才有「哪些词带量、在哪一页」。_')
  } else {
    lines.push('| 词 | 流量占比 | 归因份额 | 自然位 | 缺口 |')
    lines.push('|---|---|---|---|---|')
    for (const keyword of item.keywords) {
      const rank = keyword.organic_page ? `第 ${keyword.organic_page} 页 / ${keyword.organic_pos} 位` : '未进前 3 页'
      lines.push(`| ${keyword.keyword} | ${pct(keyword.traffic_share)} | ${signed(keyword.contri_change)} | ${rank} | ${keyword.gap_severity ?? '—'} |`)
    }
    const gaps = item.keywords.filter(keyword => keyword.organic_page && keyword.organic_page >= 2 && (keyword.traffic_share ?? 0) >= 0.05)
    if (gaps.length) {
      lines.push('')
      lines.push(`带量但没进首页：**${gaps.length} 个**（${gaps.map(keyword => keyword.keyword).join('、')}）。`)
    }
  }
  lines.push('')

  // 广告
  lines.push('## 广告结构')
  lines.push('')
  if (!item.ads) {
    lines.push('_未采集：L2 还没跑过。_')
  } else {
    lines.push(`SP ${item.ads.sp_count ?? 0} 个 campaign · SB ${item.ads.sb_count ?? 0} 个 · SBV ${item.ads.sbv_count ?? 0} 个，合计 ${item.ads.total_count ?? '—'} 个。`)
    const zero = []
    if (!item.ads.sbv_count) zero.push('SBV（视频位）')
    if (!item.ads.sb_count) zero.push('SB（品牌位）')
    if (zero.length) {
      lines.push('')
      lines.push(`> 空位：${zero.join('、')} 目前没有 campaign —— 这是现成的曝光增量位，成本通常低于 SP 加价。`)
    }
  }
  lines.push('')

  // 需求侧（ABA + 生命周期）
  lines.push('## 需求侧：这些词在涨还是在缩')
  lines.push('')
  const withAba = keywordRows.filter(row => row.aba_volume !== null && row.aba_volume !== undefined)
  if (!withAba.length) {
    lines.push('_未采集：词库里还没有 ABA 数据（关键词级 3 点/词，在「词库」页拉）。_')
  } else {
    lines.push('| 词 | ABA 周量 | 诊断 | 动量 | 距旺季 | 我的位置 |')
    lines.push('|---|---|---|---|---|---|')
    for (const row of withAba.slice(0, 12)) {
      const myPos = row.my_page ? `第 ${row.my_page} 页 ${row.my_pos ?? ''} 位` : (row.my_share ? '未进前 3 页' : '未覆盖')
      lines.push(`| ${row.keyword} | ${Math.round(row.aba_volume).toLocaleString('en-US')} | ${row.diagnosis ?? '—'} | ${row.momentum ?? '—'} | ${row.weeks_to_peak != null ? row.weeks_to_peak + ' 周' : '—'} | ${myPos} |`)
    }
    const declining = withAba.filter(row => String(row.diagnosis ?? '').includes('下滑') || String(row.diagnosis ?? '').includes('萎缩'))
    if (declining.length) {
      lines.push('')
      lines.push(`> 结构性下滑的词：${declining.map(row => row.keyword).join('、')} —— 这些词只保留卡位预算，不冲量。`)
    }
    const nearPeak = withAba.filter(row => typeof row.weeks_to_peak === 'number' && row.weeks_to_peak <= 8)
    if (nearPeak.length) {
      lines.push('')
      lines.push(`> 旺季窗口（≤8 周）：${nearPeak.map(row => `${row.keyword}（${row.weeks_to_peak} 周）`).join('、')} —— 现在铺自然位最划算。`)
    }
  }
  lines.push('')

  // 竞品格局
  lines.push('## 竞品格局（头词）')
  lines.push('')
  if (!competition || !competition.snapshot) {
    lines.push('_未采集：还没有跑过竞品格局（2 点/词，在「竞品」页跑）。_')
  } else {
    const snap = competition.snapshot
    lines.push(`词：**${snap.keyword}** · 覆盖 ${snap.visible_asin_count ?? '—'} 个 ASIN · 集中度 ${snap.concentration_level ?? '—'} · 竞争模式 ${snap.competition_mode ?? '—'}`)
    lines.push('')
    lines.push(`Top3 点击份额 ${pct(snap.top3_click_share)}，Top3 转化份额 ${pct(snap.top3_conversion_share)}。`)
    if (snap.divergence_insight) {
      lines.push('')
      lines.push(`> ${snap.divergence_insight}`)
    }
    if (snap.leader_note) {
      lines.push('')
      lines.push(`> ${snap.leader_note}`)
    }
    const top = (competition.competitors ?? []).slice(0, 8)
    if (top.length) {
      lines.push('')
      lines.push('| 竞品 ASIN | 价格 |')
      lines.push('|---|---|')
      for (const row of top) lines.push(`| ${row.asin} | ${row.price != null ? '$' + row.price : '—'} |`)
    }
  }
  lines.push('')

  // 销量
  lines.push('## 销量')
  lines.push('')
  if (!item.sales?.length) {
    lines.push('_未采集：销量序列为空（SIF 前台未展示档位时属正常）。_')
  } else {
    lines.push('| 月份 | 销量 | 前台档位 |')
    lines.push('|---|---|---|')
    for (const month of item.sales) {
      lines.push(`| ${month.month} | ${month.bought ?? '—'} | ${month.bought_band ?? '—'} |`)
    }
  }
  lines.push('')

  // 洞察
  lines.push('## 待办（按严重度）')
  lines.push('')
  if (!item.insights?.length) {
    lines.push('_没有触发规则。_')
  } else {
    item.insights.forEach((insight, index) => {
      lines.push(`${index + 1}. **[${insight.severity}] ${insight.title}**`)
      if (insight.suggestion) lines.push(`   - 动作：${insight.suggestion}`)
      const evidence = JSON.stringify(insight.evidence ?? {})
      lines.push(`   - 证据：\`${evidence.length > 220 ? evidence.slice(0, 220) + '…' : evidence}\``)
    })
  }
  lines.push('')

  // 边界
  lines.push('## 口径与残余不确定性')
  lines.push('')
  lines.push('- 流量分是 SIF 的相对量（不是绝对访问量），只看趋势与结构，不能跨站点横比。')
  lines.push('- `contri_change` 是「本期波动里该词占多少」，不是该词自身的增长率。')
  lines.push('- 自然位与广告位来自 SIF 的周期性抓取；`未进前 3 页` 与 `未被采集` 是两件事，本报告按前者表述。')
  if (!item.coverage?.keywordRows) lines.push('- **关键词层缺失**：本报告的关键词段落是空的，跑一次 L2（6 点）即可补齐。')
  if (!item.coverage?.salesRows) lines.push('- **销量层缺失**：无月度销量序列，报告不做销量判断。')
  lines.push('')
  lines.push(`_生成器：sif-ops · ${date}_`)

  return {
    asin,
    title: `${asin} 运营分析报告 ${date}`,
    markdown: lines.join('\n'),
    rangeFrom: item.weeks[0]?.period_start ?? null,
    rangeTo: latest?.period_start ?? null,
    dataDate: item.dataDate ?? null,
  }
}

function fix(value) {
  return value === null || value === undefined ? '—' : Math.round(value).toLocaleString('en-US')
}

function pct(value) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

function signed(value) {
  return value === null || value === undefined ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`
}

function delta(current, previous) {
  if (current === null || current === undefined || !previous) return null
  return (current - previous) / previous
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
