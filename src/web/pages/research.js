/**
 * 页签「research」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const researchScript = `function renderResearch() {
  renderResearchCandidates();
  /* The measured-coverage table is a *section* of this module now, not the whole
     of it: "what does this ASIN rank for" and "what should I research next" are
     two questions, and the second one is why the tab exists. */
  renderKeywords();
}

function renderResearchCandidates() {
  const research = state.research;
  $('rsSeed').value = (research?.seeds ?? []).join(', ');
  if (!research || research.candidates === null) {
    $('rsstats').innerHTML = '';
    $('rscands').innerHTML = '<div class="empty">在上面的框里输入种子词（逗号分隔）再点「查候选」。'
      + '这里先给出<strong>库内已有</strong>与<strong>竞品反查</strong>两个来源的候选 —— 这两个不需要浏览器。'
      + '第三个来源是 Amazon 搜索建议，要真开一个 storefront、每个种子几秒，所以由 agent 跑 '
      + '<code>amzn_keyword_research</code>。</div>';
    return;
  }

  const c = research.candidates;
  $('rsstats').innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + '<span class="chip">候选 ' + c.counts.total + '</span>'
    + '<span class="chip' + (c.counts.gap > 0 ? ' warn' : '') + '">可行动 ' + c.counts.gap + '</span>'
    + '<span class="chip">扩词 ' + c.counts.fresh + '</span>'
    + '<span class="chip">库里已有 ' + c.counts.known + '</span>'
    + '<span class="hint" style="padding:0;margin-left:auto">库内 ' + c.inputRows.library
    + ' · 竞品 ' + c.inputRows.competitor + ' 行输入（本次未取搜索建议）</span>'
    + '</div>';

  if (c.barrenSeeds.length > 0) {
    /* A seed that found nothing is a result. Without this the user who typed it
       cannot tell "no suggestions for that word" from "the box is broken". */
    $('rscands').innerHTML = '<div class="hint">⚠️ 这些种子没有产生任何候选：'
      + escapeHtml(c.barrenSeeds.join('、')) + '（该词可能确实没有建议，也不在库内、没有竞品数据）</div>'
      + candidateSections(c);
    return;
  }
  $('rscands').innerHTML = candidateSections(c);
}

const BUCKET_TITLES = {
  gap: '竞品有、我们库里没有（可行动）',
  fresh: '扩词候选（库里没有，也没有竞品排名）',
  known: '库里已有（无需导入）',
};

function candidateSections(c) {
  return ['gap', 'fresh', 'known'].map(bucket => {
    const rows = c.candidates.filter(row => row.bucket === bucket);
    const head = '<div class="rule-sect">' + escapeHtml(BUCKET_TITLES[bucket]) + '：' + c.counts[bucket] + ' 条</div>';
    if (rows.length === 0) {
      /* 「（无）」是典型的**压缩的零**：它不说这一档的 0 意味着什么，而三个档位的 0
         各有各的意思、各有各的下一步。所以按档位各说一句，而不是共用一个括号。 */
      const WHY = {
        gap: '这一档是「库里没有、但竞品有排名」—— 现在一条都没有：要么竞品反查没拿到词，要么这些词都已经在库里了。',
        fresh: '这一档是「库里没有、竞品也没排名」—— 现在是空的。',
        known: '这一档是「库里已有」—— 现在一条都没有，说明候选词一个都还没入库。',
      };
      return head + emptyState('none', {
        subject: BUCKET_TITLES[bucket],
        reason: WHY[bucket],
      });
    }
    return head
      + '<table><thead><tr><th></th><th>关键词</th><th>来源</th><th>搜索量</th>'
      + '<th>竞品排名</th><th>库内</th><th>为什么在这里</th></tr></thead><tbody>'
      + rows.map(row => '<tr>'
        + '<td><input type="checkbox" class="kwchk" data-keyword="' + escapeHtml(row.keyword) + '"></td>'
        + '<td title="' + escapeHtml(row.keyword) + '">' + escapeHtml(row.keyword) + '</td>'
        + '<td>' + escapeHtml(row.sources.join('+')) + '</td>'
        + '<td>' + numOrDash(row.search_volume) + '</td>'
        + '<td>' + (row.competitor_total === 0 ? '—' : row.competitor_ranked_count + '/' + row.competitor_total) + '</td>'
        + '<td>' + escapeHtml(row.in_library ? (row.library_tier || '是') : '') + '</td>'
        + '<td class="hint" style="padding:0">' + escapeHtml(row.reason) + '</td>'
        + '</tr>').join('')
      + '</tbody></table>';
  }).join('')
    + '<div class="hint">勾选后点上面工具条里的「扩词入库」，由 '
    + '<code>amzn_keyword_import</code> 写库 —— 这个面板本身不写库，'
    + '否则勾选框就成了装饰。<br>搜索量为空表示<strong>没有任何来源给过这个数</strong>，不是 0。</div>';
}

/* The import list, with the one control that changes the totals. Excluding is a
   button rather than something the agent must be asked to do, because the
   overlap warning above it is only useful if there is something to do about
   it. */
function renderMasterSources(master) {
  if (master.imports.length === 0) { $('kmlsources').innerHTML = ''; return; }
  const overlapNote = master.overlaps.length > 0
    ? '<div class="chip warn" style="margin:8px">⚠️ ' + master.overlaps.length
      + ' 对广告报告周期重叠 —— 两份都计入会重复计数，可排除其中一个</div>'
    : '';
  $('kmlsources').innerHTML = overlapNote
    + '<table><thead><tr><th>文件</th><th>类型</th><th>站点</th><th>周期</th>'
    + '<th>行</th><th>事实</th><th>计入</th><th></th></tr></thead><tbody>'
    + master.imports.map(row => '<tr>'
      + '<td title="' + escapeHtml(row.file_name) + '">' + escapeHtml(row.file_name) + '</td>'
      + '<td>' + escapeHtml(row.kind) + '</td>'
      + '<td>' + escapeHtml(row.marketplace) + '</td>'
      + '<td>' + escapeHtml(row.period) + '</td>'
      + '<td>' + escapeHtml(row.rows_read_missing === 1 ? '未记录' : row.rows_read) + '</td>'
      + '<td>' + row.facts_written + '</td>'
      + '<td>' + (row.included === 1 ? '<span class="chip ok">计入</span>' : '<span class="chip warn">已排除</span>') + '</td>'
      + '<td><button data-import="' + escapeHtml(row.id) + '" data-included="' + (row.included === 1 ? '0' : '1') + '">'
      + (row.included === 1 ? '排除' : '恢复') + '</button></td>'
      + '</tr>').join('')
    + '</tbody></table>'
    + '<div class="bar" style="border-top:1px solid var(--line)"><span class="hint">'
    + '排除只把这份文件从汇总里拿掉，事实表不动 —— 恢复即可原样回来。改动会立刻重算。</span></div>';

  for (const button of $('kmlsources').querySelectorAll('button[data-import]')) {
    button.onclick = async (event) => {
      event.stopPropagation();
      button.disabled = true;
      try {
        await api('kw-source', {
          method: 'POST',
          body: JSON.stringify({ id: button.dataset.import, included: button.dataset.included === '1' }),
        });
      } finally {
        button.disabled = false;
        await refresh();
      }
    };
  }
}

/* ── 模块 08 F08-08：关键词详情 ─────────────────────────────────────────────
   总库大表点一行 → 这里画这个词的七个 §8.2 项。触发用**容器事件委托**（挂在
   kmltable 上），不是逐行 onclick。

   两种「没有」必须长得不一样：「未测量」（字段存在、这个词没有行）与
   「本系统没有这个字段」（概念根本没有被建模）。词表由服务端随视图带出
   （state.master.detail 的 absenceVocabulary / notModelled），页面**不自己编**
   第二个词表 —— 两处各写一份迟早分叉。 */

/* 值缺失时的统一写法。永不写 0：0 是一个测量值，缺失不是。 */
function detailValue(value) {
  return (value === null || value === undefined || value === '') ? '未测量' : String(value);
}

function detailFact(label, value) {
  return '<div class="hint" style="padding:0">' + escapeHtml(label) + ': ' + escapeHtml(detailValue(value)) + '</div>';
}

/* 缺失按词表渲染：显示 absence.text（人读的短语，如「需选定 ASIN」），没有 text
   就退回 absence.kind（两个常量之一），再没有就退回 未测量。why 说清为什么。 */
function detailAbsence(label, absence) {
  const kind = (absence && absence.kind) ? absence.kind : '未测量';
  const shown = (absence && absence.text) ? absence.text : kind;
  const why = (absence && absence.why) ? absence.why : '';
  return '<div class="hint" style="padding:0">' + escapeHtml(label) + ': '
    + '<span class="chip warn">' + escapeHtml(shown) + '</span>'
    + (why ? ' ' + escapeHtml(why) : '') + '</div>';
}

function detailTimeline(detail) {
  const t = detail.timeline;
  const cap = 20;
  const parts = ['<div class="rule-sect">多源事实时间线（原始行、原始单位，不做换算）</div>'];
  parts.push('<div class="hint" style="padding:0">ABA ' + t.counts.aba + ' 行 · 广告 '
    + t.counts.ad + ' 行 · 竞品 ' + t.counts.competitor + ' 行</div>');

  if (t.aba.length === 0) {
    parts.push(detailAbsence('ABA', { kind: '未测量', text: '未测量', why: '这个词没有任何 kw_aba_fact 行。' }));
  } else {
    parts.push('<table><thead><tr><th>周期</th><th>搜索量</th><th>总分</th><th>CVR%</th>'
      + '<th>来源</th><th>导入时间</th></tr></thead><tbody>'
      + t.aba.slice(0, cap).map(row => '<tr>'
        + '<td>' + escapeHtml(row.period) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.searchVolume)) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.score)) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.cvrPct)) + '</td>'
        + '<td title="' + escapeHtml(row.sourceFile) + '">' + escapeHtml(row.sourceFile) + '</td>'
        + '<td>' + escapeHtml(row.importedAt) + '</td>'
        + '</tr>').join('') + '</tbody></table>');
    if (t.aba.length > cap) {
      parts.push('<div class="hint" style="padding:0">ABA 只显示前 ' + cap + ' 行，共 ' + t.aba.length + ' 行。</div>');
    }
  }

  if (t.ad.length === 0) {
    parts.push(detailAbsence('广告', { kind: '未测量', text: '未测量', why: '这个词没有任何 kw_ad_fact 行。' }));
  } else {
    parts.push('<table><thead><tr><th>周期</th><th>曝光</th><th>点击</th><th>订单</th>'
      + '<th>花费</th><th>销售额</th><th>来源</th></tr></thead><tbody>'
      + t.ad.slice(0, cap).map(row => '<tr>'
        + '<td>' + escapeHtml(row.period) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.impressions)) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.clicks)) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.orders)) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.spend)) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.sales)) + '</td>'
        + '<td title="' + escapeHtml(row.sourceFile) + '">' + escapeHtml(row.sourceFile) + '</td>'
        + '</tr>').join('') + '</tbody></table>');
    if (t.ad.length > cap) {
      parts.push('<div class="hint" style="padding:0">广告只显示前 ' + cap + ' 行，共 ' + t.ad.length + ' 行（逐周期逐文件）。</div>');
    }
  }

  if (t.competitor.length === 0) {
    parts.push(detailAbsence('竞品', { kind: '未测量', text: '未测量', why: '这个词没有任何 kw_competitor_fact 行。' }));
  } else {
    parts.push('<table><thead><tr><th>ASIN</th><th>来源</th><th>自然排名</th><th>广告排名</th>'
      + '<th>月搜索量</th><th>观测时间</th></tr></thead><tbody>'
      + t.competitor.slice(0, cap).map(row => '<tr>'
        + '<td>' + escapeHtml(row.asin) + '</td>'
        + '<td>' + escapeHtml(row.sourceId) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.organicRank)) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.adRank)) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.monthlyVolume)) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.collectedAt)) + '</td>'
        + '</tr>').join('') + '</tbody></table>');
    if (t.competitor.length > cap) {
      parts.push('<div class="hint" style="padding:0">竞品只显示前 ' + cap + ' 行，共 ' + t.competitor.length + ' 行。</div>');
    }
  }
  return parts.join('');
}

function detailRank(detail) {
  const rank = detail.rank;
  const c = rank.competitor;
  const parts = ['<div class="rule-sect">自有与竞品排名</div>'];
  parts.push('<div class="hint" style="padding:0"><strong>竞品侧</strong></div>'
    + detailFact('竞品最好排名', c.bestRank)
    + detailFact('最好排名 ASIN', c.bestAsin)
    + detailFact('有排名的竞品', c.rankedCount)
    + detailFact('缺席的竞品', c.absentCount));
  if (c.ranked.length > 0) {
    parts.push('<div class="hint" style="padding:0">'
      + c.ranked.map(entry => escapeHtml(String(entry.asin)) + ' #' + escapeHtml(detailValue(entry.rank))).join(' · ')
      + '</div>');
  }
  parts.push('<div class="hint" style="padding:0"><strong>我方</strong></div>');
  /* 自有排名是 ASIN 维度的（asin_keyword.rank），kw_master 没有这一列。没有选中
     ASIN 时读「需选定 ASIN」——**不是 0，也不是空白**。0 会被读成「排第一」。 */
  if (rank.own.needAsin || !rank.own.measured) {
    parts.push(detailAbsence('自有排名', rank.own.absence));
  } else {
    parts.push(detailFact('自有排名（' + rank.own.asin + '）', rank.own.rank));
    parts.push('<div class="hint" style="padding:0">'
      + rank.own.rows.map(row => escapeHtml(row.sourceId) + ' #' + escapeHtml(detailValue(row.rank))
        + ' @' + escapeHtml(row.collectedAt)).join(' · ') + '</div>');
  }
  return parts.join('');
}

function detailOwnership(detail) {
  const parts = ['<div class="rule-sect">所有权与位置</div>'];
  if (detail.ownership === null) {
    parts.push('<div class="hint" style="padding:0">所有权: 没有任何主张 —— <strong>未分配</strong>（不是冲突，也不是未决）。</div>');
  } else if (detail.ownership.conflicted) {
    parts.push('<div class="hint" style="padding:0">所有权: <span class="chip warn">冲突 ×'
      + detail.ownership.conflictCount + '</span> ' + escapeHtml(detail.ownership.conflictReasons.join('；')) + '</div>');
  } else {
    parts.push(detailFact('所有权主人', detail.ownership.owner));
  }
  if (detail.ownership !== null && detail.ownership.claims.length > 0) {
    parts.push('<table><thead><tr><th>ASIN</th><th>状态</th><th>来源</th><th>认领时间</th><th>释放</th></tr></thead><tbody>'
      + detail.ownership.claims.map(claim => '<tr>'
        + '<td>' + escapeHtml(claim.asin) + '</td>'
        + '<td>' + escapeHtml(claim.status) + (claim.locked ? ' <span class="chip warn">锁定</span>' : '') + '</td>'
        + '<td>' + escapeHtml(claim.claimSource) + '</td>'
        + '<td>' + escapeHtml(claim.claimedAt) + '</td>'
        + '<td>' + escapeHtml(claim.releasedAt ? claim.releasedAt : '—') + '</td>'
        + '</tr>').join('') + '</tbody></table>');
  }
  /* 计划位置是**分配决定**，与 kw_master.for_listing_json 的**资格**不是一回事，
     也不是实际覆盖（实际覆盖不落库，见下面的「逐词实际落点」）。 */
  if (detail.plans.length === 0) {
    parts.push('<div class="hint" style="padding:0">位置计划: 没有任何计划包含这个词。</div>');
  } else {
    parts.push('<div class="hint" style="padding:0">位置计划（<strong>计划</strong>位置，不是实际落点）：</div>'
      + '<table><thead><tr><th>计划</th><th>ASIN</th><th>v</th><th>状态</th><th>主人位置</th><th>复现位</th></tr></thead><tbody>'
      + detail.plans.map(plan => '<tr>'
        + '<td title="' + escapeHtml(plan.planId) + '">' + escapeHtml(plan.planId.slice(0, 8)) + '</td>'
        + '<td>' + escapeHtml(plan.asin) + '</td>'
        + '<td>' + escapeHtml(String(plan.version)) + '</td>'
        + '<td>' + escapeHtml(plan.statusLabel) + '</td>'
        + '<td>' + escapeHtml(plan.ownerPosition) + '</td>'
        + '<td>' + escapeHtml(plan.supporting.length === 0 ? '—' : plan.supporting.map(slot => slot.position).join(' / ')) + '</td>'
        + '</tr>').join('') + '</tbody></table>');
  }
  return parts.join('');
}

function detailHistory(detail) {
  const h = detail.history;
  const parts = ['<div class="rule-sect">历史使用和效果</div>'];
  if (h.lifecycle.current === null) {
    parts.push('<div class="hint" style="padding:0">当前生命周期: 未设置（没人决定过，<strong>不是</strong> candidate）。</div>');
  } else {
    parts.push(detailFact('当前生命周期', h.lifecycle.current.status + ' ' + h.lifecycle.current.label));
  }
  if (h.lifecycle.events.length === 0) {
    parts.push(detailAbsence('生命周期流转', { kind: '未测量', text: '未测量', why: '这个词没有任何生命周期流转事件。' }));
  } else {
    parts.push('<table><thead><tr><th>从</th><th>到</th><th>来源</th><th>发布关联</th><th>时间</th></tr></thead><tbody>'
      + h.lifecycle.events.map(event => '<tr>'
        + '<td>' + escapeHtml(event.fromStatus === null ? '（首次）' : event.fromStatus) + '</td>'
        + '<td>' + escapeHtml(event.toStatus + ' ' + event.toLabel) + '</td>'
        + '<td>' + escapeHtml(event.source) + '</td>'
        + '<td>' + escapeHtml(event.publicationId === null ? '—' : event.publicationId) + '</td>'
        + '<td>' + escapeHtml(event.at) + '</td>'
        + '</tr>').join('') + '</tbody></table>');
  }
  if (h.ownershipEvents.length === 0) {
    parts.push(detailAbsence('所有权事件', { kind: '未测量', text: '未测量', why: '这个词没有任何所有权事件。' }));
  } else {
    parts.push('<table><thead><tr><th>动作</th><th>ASIN</th><th>来源</th><th>时间</th></tr></thead><tbody>'
      + h.ownershipEvents.map(event => '<tr>'
        + '<td>' + escapeHtml(event.action) + '</td>'
        + '<td>' + escapeHtml(event.asin === null ? '—' : event.asin) + '</td>'
        + '<td>' + escapeHtml(event.source) + '</td>'
        + '<td>' + escapeHtml(event.at) + '</td>'
        + '</tr>').join('') + '</tbody></table>');
  }
  /* 历史到此为止：系统只有「状态怎么变」和「谁认领过」。真正落到哪个位置、效果
     怎么样，都**没有建模** —— 说出来，别让它读成「没有数据」。 */
  parts.push(detailAbsence('逐词实际落点', detail.notModelled.actualUsage));
  parts.push(detailAbsence('逐词效果', detail.notModelled.effect));
  return parts.join('');
}

function detailVariants(detail) {
  const parts = ['<div class="rule-sect">原始变体与合并记录</div>'];
  if (detail.variants.rows.length > 0) {
    parts.push('<table><thead><tr><th>拼写</th><th>并入</th><th>归档时间</th></tr></thead><tbody>'
      + detail.variants.rows.map(row => '<tr>'
        + '<td>' + escapeHtml(row.keyword) + '</td>'
        + '<td>' + escapeHtml(row.mergedInto === null ? '—' : row.mergedInto) + '</td>'
        + '<td>' + escapeHtml(detailValue(row.archivedAt)) + '</td>'
        + '</tr>').join('') + '</tbody></table>');
  }
  parts.push('<div class="hint" style="padding:0">' + escapeHtml(detail.variants.note) + '</div>');
  return parts.join('');
}

function detailQuality(detail) {
  const parts = ['<div class="rule-sect">数据质量</div>'];
  if (detail.quality.issues.length === 0) {
    parts.push(emptyState('none', {
      subject: '关键词级问题',
      reason: '没有关键词级问题。这是读到的结论，不是「还没检查」。',
    }));
  } else {
    parts.push('<table><thead><tr><th>规则</th><th>严重级</th><th>状态</th><th>问题</th></tr></thead><tbody>'
      + detail.quality.issues.map(row => '<tr>'
        + '<td>' + escapeHtml(row.ruleId) + '</td>'
        + '<td>' + escapeHtml(row.severity) + '</td>'
        + '<td>' + escapeHtml(row.status) + '</td>'
        + '<td>' + escapeHtml(row.message) + '</td>'
        + '</tr>').join('') + '</tbody></table>');
  }
  /* 只有两条规则打关键词级。空列表不是「这个词很干净」—— 多半只是「没有规则盯着它」。 */
  parts.push('<div class="hint" style="padding:0">' + escapeHtml(detail.quality.note) + '</div>');
  return parts.join('');
}

function detailRelevance(detail) {
  return '<div class="rule-sect">相关性</div>'
    + detailAbsence('相关性 / 相关性证据', detail.notModelled.relevance);
}

function detailHtml(detail) {
  return '<div class="rule-sect">关键词详情: ' + escapeHtml(detail.keyword)
    + '（站点 ' + escapeHtml(detail.marketplace || '—') + '）</div>'
    + '<div class="hint" style="padding:0">缺失分两种，混为一谈就是把「没有」渲染成了「真实值」：'
    + '<strong>未测量</strong> = 字段存在、这个词没有行；'
    + '<strong>本系统没有这个字段</strong> = 概念根本没有被建模。</div>'
    + detailTimeline(detail)
    + detailRank(detail)
    + detailOwnership(detail)
    + detailHistory(detail)
    + detailVariants(detail)
    + detailQuality(detail)
    + detailRelevance(detail);
}

function renderKeywordDetail(master) {
  const box = $('kmldetail');
  if (!box) return;
  const detail = master.detail;
  if (!detail) {
    box.innerHTML = '<div class="empty">点选总库里的一行，查看这个词的详情'
      + '（多源事实时间线 / 排名 / 所有权与位置 / 数据质量 / 历史 / 变体 / 相关性）。</div>';
    return;
  }
  if (detail.unavailable) {
    box.innerHTML = '<div class="rule-sect">关键词详情: ' + escapeHtml(detail.keyword) + '</div>'
      + detailAbsence('站点', detail.unavailable);
    return;
  }
  box.innerHTML = detailHtml(detail);
}

/* 总库大表行的点击：容器事件委托，挂在 kmltable 上。选中的 (关键词, 站点) 写进
   context（服务端据此把 detail 切片带回来），不是在这一层直接读库。 */
function bindKeywordDetailClicks() {
  const container = $('kmltable');
  if (!container) return;
  container.onclick = (event) => {
    const target = event ? event.target : null;
    const row = target && typeof target.closest === 'function' ? target.closest('[data-keyword]') : null;
    if (!row || !row.dataset || !row.dataset.keyword) return;
    patchContext({
      selection: {
        ...state.context.selection,
        keywords: [{ keyword: row.dataset.keyword, marketplace: row.dataset.marketplace }],
      },
    });
  };
}

/* ── 规则获取 ─────────────────────────────────────────────────────────── */

/* 把一个 prompt 交给用户，让"按钮不能调工具"仍然落在"agent 会去做"上。
   Arch §4.6：页面按钮只有两种结局 —— 提交一个事实，或给一段 prompt；绝不自调工具。

   2026-10-21：右侧栏拆掉之后没有 promptBox 了，所以这里不再"先塞进框再复制"，
   直接写剪贴板 + 一句屏幕上的确认。**失败必须说出来** —— 空 catch 会让
   "复制成功"和"克隆被拒"长得一模一样，而用户会以为粘过去有内容。 */
function showToast(text) {
  let stack = document.getElementById('toaststack');
  if (stack === null) {
    stack = document.createElement('div');
    stack.id = 'toaststack';
    stack.className = 'toaststack';
    document.body.appendChild(stack);
  }
  const box = document.createElement('div');
  box.className = 'toast on';
  /* 对象/数字一律 String() 兜底：直接把对象塞进 textContent 会得到
     「[object Object]」，而那句话对用户和日志都没有信息。 */
  box.textContent = typeof text === 'string' ? text : String(text ?? '');
  stack.appendChild(box);
  while (stack.children.length > 3) stack.removeChild(stack.firstChild);
  setTimeout(() => {
    box.classList.remove('on');
    setTimeout(() => { if (box.parentNode === stack) stack.removeChild(box); }, 200);
  }, 2600);
}

function usePrompt(value) {
  const text = String(value ?? '');
  if (text === '') { showToast('这段 prompt 是空的 —— 没有可复制的内容'); return; }
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    showToast('这台机器不允许写剪贴板，请手动复制：' + text.slice(0, 60));
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => showToast('已复制 —— 到对话里粘贴发送'),
    () => showToast('剪贴板被拒（需要安全上下文），请手动复制：' + text.slice(0, 60)),
  );
}
`
