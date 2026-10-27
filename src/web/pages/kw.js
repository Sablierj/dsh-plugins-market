/**
 * 页签「kw」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
import { pipelineScript } from './pipeline.js'
export const kwScript = `/* 关键词总库每个 chip 的取值。null / undefined / NaN 是「没有这个值」，可见文本印「—」——
   绝不能 String(undefined)：那会让界面直接出现「有 ABA undefined」这种字，数据是对的、
   字是错的。0 与 '0' 是真实读数，照印（「读到了 0」与「没有这个值」是两件事）。
   数字带千分位：30,778 比 30778 更容易读出量级（#8 规格）。
   缺失值的说明放 title「未提供数据」（ADR-001 D10：主文本用「—」，不用「未提供」）。 */
function keywordChipMissing(value) {
  return value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value));
}
function keywordChipValue(value) {
  if (keywordChipMissing(value)) return '—';
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('en-US');
  return String(value);
}
function keywordChipTitle(value) {
  return keywordChipMissing(value) ? ' title="未提供数据"' : '';
}

/* 关键词总库自己的搜索定时器。筛选键是 masterQ，不是 q —— q 属于 ASIN 列表 /
   关键词库，换页签后仍留在 context.filters 里，复用会把总库筛成 0 行（R2 P0）。 */
let masterQTimer = null;

/* 上一次批量改生命周期的结果文本。刷新会重画生命周期整块（计数变了），所以结果不能只
   放在 DOM 里 —— 那样一次 refresh 就把它抹掉，而「还剩 30,278 条」正是最该留下的那句话。 */
let lastLifecycleBatchText = null;

function renderMaster() {
  const master = state.master;
  if (!master) { $('kmltable').innerHTML = ''; $('kmldetail').innerHTML = ''; return; }

  const qInput = $('kmlq');
  if (qInput !== null && document.activeElement !== qInput) qInput.value = state.filters.masterQ || '';

  const lineSelect = $('kmlLine');
  if (lineSelect.options.length <= 1 && master.productLines.length > 0) {
    lineSelect.innerHTML = '<option value="">全部产品线</option>'
      + master.productLines.map(line => '<option value="' + escapeHtml(line.key) + '">'
        + escapeHtml(line.key) + ' (' + line.n + ')</option>').join('');
    lineSelect.value = state.filters.masterLine || '';
  }
  $('kmlTier').value = state.filters.masterTier || '';
  $('kmlOrder').value = state.filters.masterOrder || 'volume';

  /* 模块 08 F08-07：两个下拉的九态选项都从服务端的词表填进来 —— 页面里不重写第二份
     词表，否则它会与服务端的第一份迟早分叉。与产品线下拉同一套做法（只在还没填过时
     填一次）。 */
  const states = (master.lifecycle && master.lifecycle.states) ? master.lifecycle.states : [];
  const lifeSelect = $('kmlLifecycle');
  if (lifeSelect.options.length <= 1 && states.length > 0) {
    lifeSelect.innerHTML = '<option value="">全部状态</option>'
      + states.map(entry => '<option value="' + escapeHtml(entry.status) + '">'
        + escapeHtml(entry.status) + ' ' + escapeHtml(entry.label) + '</option>').join('');
  }
  lifeSelect.value = state.filters.masterLifecycle || '';
  const toSelect = $('kmlTo');
  if (toSelect.options.length <= 1 && states.length > 0) {
    toSelect.innerHTML = '<option value="">改生命周期 →</option>'
      + states.map(entry => '<option value="' + escapeHtml(entry.status) + '">'
        + escapeHtml(entry.status) + ' ' + escapeHtml(entry.label) + '</option>').join('');
  }

  /* 「库内有没有词」与「当前筛选有没有结果」是两件事。老代码看 master.total
     （筛选后的 total）为 0 就画「还没有关键词总库」，于是 context.filters.q 残留
     一个 ZZZ 时，顶栏 30,778 词、正文却说库是空的。库内总数从 stats.total 取 ——
     它不带任何页面筛选。 */
  const libraryTotal = master.stats && Number.isFinite(Number(master.stats.total))
    ? Number(master.stats.total)
    : (Number(master.total) || 0);
  if (libraryTotal === 0) {
    $('kmlstats').innerHTML = '';
    $('kmlLifecycleCounts').innerHTML = '';
    $('kmltable').innerHTML = emptyState('not-recorded', {
      subject: '关键词总库',
      /* 路径用正斜杠：这个字符串要经过**两道**转义（模板字符串 → 浏览器字符串字面量），
         写反斜杠时双反斜杠先变成单个反斜杠，浏览器再把反斜杠加 0 当成 NUL、
         把反斜杠加 k/m/s 当成裸字母 —— 实机显示成 D:amazon-ops-hub<NUL>3-knowledgekeywordsmastersource。
         这是原有文案里就有的隐性 bug（我搬过来时没注意），真机上才看得见。 */
      next: '在对话里说「把 D:/amazon-ops-hub/03-knowledge/keywords/master/source 导进来」，'
        + '或用 amzn_kw_import 指定一个文件/目录。',
    });
    $('kmldetail').innerHTML = '';
    $('kmlsources').innerHTML = '';
    bindMasterControls(master);
    return;
  }

  const s = master.stats;
  const card = (label, value, cls) => '<span class="chip ' + (cls || '') + keywordChipTitle(value) + '">'
    + escapeHtml(label) + ' ' + escapeHtml(keywordChipValue(value)) + '</span>';
  /* v69：产品线归属的三档计数（人工 / 自动 / 未分类），分母都是该站点总库条数。
     老读数 s.productLineDefaulted 只在切片里没有 productLineDecisions 时兜底 ——
     它数的是「派生侧无信号」，与新口径「未分类」在没人写过人工值之前相等。 */
  const plCounts = (master.productLineDecisions && master.productLineDecisions.counts)
    ? master.productLineDecisions.counts
    : null;
  $('kmlstats').innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + card('库内', libraryTotal)
    + card('有搜索量', s.withVolume, 'ok')
    + card('无搜索量', s.withoutVolume, s.withoutVolume > 0 ? 'warn' : '')
    + card('有 ABA', s.withAba)
    + card('有广告', s.withAd)
    + card('有竞品', s.withCompetitor)
    + (plCounts === null
      ? card('产品线未分类', s.productLineDefaulted)
      : card('产品线·人工', plCounts.manual, plCounts.manual > 0 ? 'ok' : '')
        + card('产品线·自动', plCounts.derived)
        + card('产品线·未分类', plCounts.unclassified, plCounts.unclassified > 0 ? 'warn' : ''))
    /* 不能直接 Math.round(totalSpend)：null 会被算成 0，把「还没导入广告报告」
       说成「花了 0 元」。null 原样交给 keywordChipValue，显示「未提供」。 */
    + card('广告花费', s.totalSpend === null ? null : Math.round(s.totalSpend))
    + card('广告订单', s.totalOrders === null ? null : s.totalOrders)
    /* R2 P0 的可见残留：q 属于 ASIN 列表 / 关键词库，深链进总库时它仍留在
       context.filters 里。本表不再按它筛选，但也不能假装它不存在 —— 显示一个可点的
       chip，让人知道「这是别的页的搜索词」，一键清掉。 */
    + (state.filters.q
      ? '<button type="button" class="chip warn" data-kmlqclear="1"'
        + ' title="来自 ASIN 列表 / 关键词库的搜索；本表不按它筛选">清掉别的页搜索词：'
        + escapeHtml(String(state.filters.q)) + '</button>'
      : '')
    /* FR-M6-19：视图切换。对比视图的行集是**被观测过的词**（kw_rank_observation），
       所以它切换的是「这一屏看什么」，不是给总库加一列空数据。 */
    + (master.compare
      ? '<button type="button" class="chip ok" data-kmlcompare="off">← 返回总库</button>'
      : '<button type="button" class="chip" data-kmlcompare="us-ca"'
        + ' title="两侧排名对比：行集是已观测过的词，未测量会印「未测量」而不是 0">US/CA 对比 →</button>')
    /* FR-M6-03：批次视图。批次 = 一次导入（kw_import 一行），期间标签原样显示。 */
    + (master.batchList !== null && master.batchList !== undefined
      ? '<button type="button" class="chip ok" data-kmlbatchopen="off">← 返回总库</button>'
      : '<button type="button" class="chip" data-kmlbatchopen="open"'
        + ' title="按导入批次看词：批次 = kw_import 一行，period 原样显示不折算月份">批次视图 →</button>')
    + '</div>';

  if (master.batchList !== null && master.batchList !== undefined) {
    renderBatchView(master, libraryTotal);
  } else if (master.compare) {
    /* 对比模式：总库大表让位给对比表。其余块（生命周期/所有权/计划/来源）照常 ——
       它们是同一个页面的上下文，不是在给对比视图让路。 */
    renderMarketplaceCompare(master.compare, libraryTotal);
  } else {
    renderMasterTable(master, libraryTotal);
  }
  bindMasterControls(master);
  bindCompareControls();
  bindBatchViewControls();

  renderMasterLifecycle(master);
  /* 勾选框是 renderMasterTable 写出来的，绑在重画之后。批量条是 renderMasterLifecycle
     写出来的，所以顺序是先画条、再绑勾选（计数那一格在条里）。 */
  bindMasterPicks();
  renderMasterOwnership(master);
  renderMasterPlan(master);
  renderMasterSources(master);
  /* 模块 08 F08-08：总库大表的行点击改用**容器事件委托**（bindKeywordDetailClicks），
     不再逐行挂 onclick。逐行 onclick 的旧写法在表格重画时会漏挂（一个渲染成可点、
     却没有处理器的行，是这个项目已经出过一次的缺陷），委托挂在容器上，重画多少次都
     还在。顺序：先画表（含 data-keyword 的行），再挂委托，最后画详情 —— 详情读的是
     上一次刷新带回来的 state.master.detail，与表是同一份服务端切片。 */
  bindKeywordDetailClicks();
  renderKeywordDetail(master);
}

/* 上一次批量改产品线的结果文本。与生命周期同一个理由：刷新会重画这一块，结果不能只放在
   DOM 里 —— 「还剩 2,886 条未分类」正是最该留下的那句话。 */
let lastProductLineBatchText = null;

/* v69：产品线归属的**三档来源**。页面只读服务端切片，不自己判断「人工 > 派生」：
   那个判定只有 store 的 effectiveProductLine 一处（t78 ⑩ 是源码级断言）。 */
function productLineSlice() {
  return (state.master && state.master.productLineDecisions) ? state.master.productLineDecisions : null;
}

function productLineNames() {
  const slice = productLineSlice();
  const names = new Map();
  if (slice && Array.isArray(slice.options)) {
    for (const option of slice.options) names.set(String(option.id), String(option.name === undefined ? option.id : option.name));
  }
  return names;
}

function productLineSourceLabels() {
  const slice = productLineSlice();
  return (slice && slice.sourceLabels) ? slice.sourceLabels : { manual: '人工', derived: '自动', unclassified: '未分类' };
}

function productLineValueLabel(value, names) {
  if (value === null || value === undefined) return '—';
  const name = names.get(String(value));
  return name === undefined ? String(value) : name + '(' + String(value) + ')';
}

/* 「产品线」列：值 + **来源徽标**。三个来源必须长得不一样，否则等于把人的决定和机器的
   猜测混成一个数。未分类**不印默认线的名字** —— 「没有信号命中，暂落默认线」不等于
   「属于默认线」，那正是这个 bug 最开始的样子。 */
function productLineCell(row) {
  const labels = productLineSourceLabels();
  const names = productLineNames();
  const source = String(row.product_line_source || 'unclassified');
  const value = row.product_line_effective;
  if (source === 'manual') {
    const manual = row.product_line_manual || null;
    const why = manual === null ? '' : (' title="' + escapeHtml('by ' + String(manual.by || '(未记)') + ' · '
      + String(manual.reason || '(未记理由)') + ' · ' + String(manual.changedAt || '')) + '"');
    return '<span class="mono strong"' + why + '>' + escapeHtml(productLineValueLabel(value, names)) + '</span> '
      + '<span class="chip ok">' + escapeHtml(labels.manual) + '</span>';
  }
  if (source === 'derived') {
    return escapeHtml(productLineValueLabel(value, names)) + ' <span class="chip">' + escapeHtml(labels.derived) + '</span>';
  }
  return '<span class="chip warn">' + escapeHtml(labels.unclassified) + '（暂无信号）</span>';
}

/* 总库大表：**有总数就必须出表**，但「库为空」与「筛选 0 条」要分开。
   master.total 是筛选后的条数，libraryTotal 是不带筛选的库内总数（来自
   master.stats.total）。老代码用 master.total 判空，才会在顶栏 30,778 时画
   「还没有关键词总库」。分页参数从服务端来（master.limit / master.offset），
   每页条数与总条数一起显示，不把「只显示这一页」说成「全部」。 */
function renderMasterTable(master, libraryTotal) {
  const rows = Array.isArray(master.rows) ? master.rows : [];
  const total = Number(master.total) || 0;
  const limit = Math.max(1, Number(master.limit) || 100);
  const offset = Math.max(0, Number(master.offset) || 0);

  if (total === 0) {
    $('kmltable').innerHTML = emptyState('filtered', {
      subject: '关键词',
      reason: '当前筛选没有关键词；全库 ' + keywordChipValue(libraryTotal)
        + ' 条 —— 清掉「搜索 / 产品线 / 层级 / 状态」再看。',
      next: '全库一共 ' + keywordChipValue(libraryTotal) + ' 条，一条都没有被删。',
    })
      + '<div class="bar" style="border-top:1px solid var(--line)">'
      + '<button type="button" data-kmlclear="1">清除筛选</button></div>';
    return;
  }

  if (rows.length === 0) {
    $('kmltable').innerHTML = emptyState('filtered', {
      subject: '这一页的关键词',
      reason: '筛选后有 ' + keywordChipValue(total) + ' 条，但这一页从第 ' + keywordChipValue(offset + 1) + ' 条开始没有行了。',
      next: '回到第一页。',
    })
      + '<div class="bar" style="border-top:1px solid var(--line)">'
      + '<button type="button" data-kmlpage="first">回到第一页</button></div>';
    return;
  }

  const cell = value => (value === null || value === undefined || value === '' ? '' : escapeHtml(String(value)));
  const fixed = value => (value === null || value === undefined ? '' : Number(value).toFixed(2));
  const table = '<table><thead><tr>'
    + '<th title="勾选后可批量改生命周期">选</th>'
    + '<th>关键词</th><th>站点</th><th>搜索量</th><th>层级</th><th>优先级</th><th>漏斗</th>'
    + '<th>曝光</th><th>点击</th><th>订单</th><th>花费</th><th>CVR%</th><th>ACoS%</th>'
    + '<th>竞品最好</th><th>产品线</th><th>主人</th><th>来源</th><th>状态</th></tr></thead><tbody>'
    + rows.map(row => '<tr data-keyword="' + escapeHtml(row.keyword) + '" data-marketplace="' + escapeHtml(row.marketplace) + '">'
      /* F-5（走查 2026-10-25）：批量改生命周期的输入就是这一列。勾选框**只**放在总库大表，
         因为「未设置」的 3 万词全在这里 —— 所有权工作台那张表只列有主张/建议的词，照字面
         复用它等于给一个没有行可选的入口。点击冒泡到容器的行点击委托会打开详情，所以
         bindMasterPicks 里对勾选框 stopPropagation。 */
      + '<td><input type="checkbox" class="kmpick"></td>'
      + '<td title="' + escapeHtml(row.keyword) + '">' + escapeHtml(row.keyword) + '</td>'
      + '<td>' + cell(row.marketplace) + '</td>'
      + '<td>' + cell(row.search_volume) + '</td>'
      + '<td>' + cell(row.sv_tier) + '</td>'
      + '<td>' + cell(row.priority) + '</td>'
      + '<td>' + cell(row.funnel) + '</td>'
      + '<td>' + cell(row.impressions) + '</td>'
      + '<td>' + cell(row.clicks) + '</td>'
      + '<td>' + cell(row.orders) + '</td>'
      + '<td>' + (row.spend ? Math.round(row.spend) : '') + '</td>'
      + '<td>' + fixed(row.cvr_pct) + '</td>'
      + '<td>' + fixed(row.acos_pct) + '</td>'
      + '<td>' + (row.competitor_best_rank === null ? '' : '#' + row.competitor_best_rank) + '</td>'
      + '<td>' + productLineCell(row) + '</td>'
      /* 模块 08 F08-04 的「主人」列。三种取值必须长得不一样：有唯一生效主张 → ASIN；
         有冲突 → 冲突 ×N（N 是生效主张数，不是「2」这个常数）；一条主张都没有 →
         未分配。「未分配」与「未决」不能都渲染成同一个「无」。 */
      + '<td>' + (row.ownership_conflict
        ? '<span class="chip warn">冲突 ×' + row.ownership_conflict_count + '</span>'
        : (row.ownership_owner ? escapeHtml(row.ownership_owner) : '未分配')) + '</td>'
      + '<td title="' + escapeHtml((row.sources || []).join(' / ')) + '">' + escapeHtml((row.sources || []).join(',')) + '</td>'
      /* 模块 08 F08-07 的状态列。**没有记录时写「未设置」，不是 candidate** ——
         「没人决定过」与「决定为候选」是两件事，写成 candidate 会让页面对这两件事
         给出同一个答案。 */
      + '<td>' + (row.lifecycle_status ? escapeHtml(row.lifecycle_status) : '未设置') + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';
  const first = offset + 1;
  const last = offset + rows.length;
  const hasPrev = offset > 0;
  const hasNext = offset + rows.length < total;
  $('kmltable').innerHTML = table
    + '<div class="bar" style="border-top:1px solid var(--line);flex-wrap:wrap">'
    + '<button type="button" data-kmlpage="prev"' + (hasPrev ? '' : ' disabled') + '>上一页</button>'
    + '<button type="button" data-kmlpage="next"' + (hasNext ? '' : ' disabled') + '>下一页</button>'
    + '<span class="hint">筛选后 ' + keywordChipValue(total) + ' 条 · 全库 ' + keywordChipValue(libraryTotal)
    + ' 条 · 第 ' + keywordChipValue(first) + '–' + keywordChipValue(last) + ' 条（每页 ' + keywordChipValue(limit) + '）。'
    + '「层级」按搜索量分档（L5 含没有搜索量的词）；浏览器实测的 T1–T4 在「关键词库」页。</span></div>';
}

/* 总库筛选控件与分页按钮的接线。控件在 page.js 的静态 HTML 里，分页按钮是这次
   innerHTML 写出来的，所以后者用 data-* 委托——页面里不按 id 取动态元素。 */
function bindMasterControls(master) {
  const q = $('kmlq');
  if (q !== null) {
    if (document.activeElement !== q) q.value = state.filters.masterQ || '';
    q.oninput = (event) => {
      clearTimeout(masterQTimer);
      const value = event.target.value;
      masterQTimer = setTimeout(() => {
        patchContext({ filters: { ...state.filters, masterQ: value, masterOffset: 0 } });
      }, 250);
    };
  }
  const bindSelect = (id, key) => {
    const element = $(id);
    if (element === null) return;
    element.onchange = (event) => patchContext({
      filters: { ...state.filters, [key]: event.target.value, masterOffset: 0 },
    });
  };
  bindSelect('kmlLine', 'masterLine');
  bindSelect('kmlTier', 'masterTier');
  bindSelect('kmlOrder', 'masterOrder');
  bindSelect('kmlLifecycle', 'masterLifecycle');

  const total = Number(master.total) || 0;
  const limit = Math.max(1, Number(master.limit) || 100);
  const offset = Math.max(0, Number(master.offset) || 0);
  for (const button of $('kmltable').querySelectorAll('button[data-kmlpage]')) {
    button.onclick = () => {
      const dir = String(button.dataset.kmlpage || '');
      const next = dir === 'first' ? 0
        : dir === 'prev' ? Math.max(0, offset - limit)
          : offset + limit;
      patchContext({ filters: { ...state.filters, masterOffset: next } });
    };
  }
  for (const button of $('kmltable').querySelectorAll('button[data-kmlclear]')) {
    button.onclick = () => patchContext({
      filters: {
        ...state.filters,
        masterQ: '', masterLine: '', masterTier: '', masterLifecycle: '', masterOffset: 0,
      },
    });
  }
  for (const button of $('kmlstats').querySelectorAll('button[data-kmlqclear]')) {
    button.onclick = () => patchContext({ filters: { ...state.filters, q: '' } });
  }
  if (total < 0) return;
}

/* ── FR-M6-19：US/CA 排名对比 ────────────────────────────────────────────────
   这一屏存在的理由就是两条口径，所以它们写在代码旁边：
   ① 缺一侧印「未测量」，**不是 0** —— 0 比 1 小，会被读成「排第一」；
   ② 两侧测量期不一致就**不判读**（§20.3），一侧自己跨了多个观测日也不判读。
   判定在 store（复用竞品页的 buildEvidenceView，两个方向各问一次）；页面只负责把
   「不判读」画成不判读，绝不自己拿两个数字相减凑一个结论。 */
function compareSideCell(side) {
  if (side === null || side === undefined || side.measured !== true) return '<span class="chip warn">未测量</span>';
  if (side.rank !== null && side.rank !== undefined) {
    return '#' + keywordChipValue(side.rank)
      + (side.asin ? ' <span class="tertiary">' + escapeHtml(String(side.asin)) + '</span>' : '');
  }
  /* 扫了，但那天没有一条 found=1 —— 与「没扫过」必须分开说。 */
  return side.scannedNotRanked === true
    ? '<span class="chip warn">未进前 ' + escapeHtml(String(side.scanDepth === null || side.scanDepth === undefined ? '—' : side.scanDepth)) + '</span>'
    : '<span class="chip">已测量·无有效名次</span>';
}

function comparePeriodCell(side) {
  if (side === null || side === undefined || side.measured !== true) return '<span class="tertiary">—</span>';
  if (side.mixedPeriods === true) {
    return '<span class="chip warn" title="' + escapeHtml(String((side.periods || []).join('、'))) + '">多观测日 ×'
      + escapeHtml(String(side.periodCount)) + '</span>';
  }
  return escapeHtml(String(side.period === null || side.period === undefined ? '—' : side.period));
}

function renderMarketplaceCompare(compare, libraryTotal) {
  const box = $('kmltable');
  if (box === null) return;
  const left = String(compare.left || '');
  const right = String(compare.right || '');
  const rows = Array.isArray(compare.rows) ? compare.rows : [];
  const summary = compare.summary || {};
  const observed = compare.observed || {};
  const leftObs = observed[left] || { rows: 0, keywords: 0 };
  const rightObs = observed[right] || { rows: 0, keywords: 0 };
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + keywordChipTitle(value) + '">'
    + escapeHtml(label) + ' ' + escapeHtml(keywordChipValue(value)) + '</span>';
  const stateSelect = '<select data-kmlcomparefilter="state">'
    + [['all', '全部'], ['both', '两侧都有测量'], ['left', '只有 ' + left], ['right', '只有 ' + right]]
      .map(entry => '<option value="' + entry[0] + '"'
        + (String(compare.state) === entry[0] ? ' selected' : '') + '>' + escapeHtml(entry[1]) + '</option>').join('')
    + '</select>';
  const head = '<div class="bar" style="flex-wrap:wrap">'
    + stateSelect
    + '<button type="button" data-kmlcompare="off">返回总库</button>'
    + '<span class="hint">对比 ' + escapeHtml(left) + ' / ' + escapeHtml(right)
    + ' · 命中 ' + keywordChipValue(compare.total) + ' 条（行集 = 被观测过的词，不是全库 ' + keywordChipValue(libraryTotal) + '）</span>'
    + '</div>';
  const summaryBar = '<div class="bar" style="flex-wrap:wrap">'
    + chip(left + ' 已测量', summary.leftMeasured)
    + chip(right + ' 已测量', summary.rightMeasured)
    + chip('两侧都有', summary.bothMeasured)
    + chip('可判读（本页）', summary.comparable, summary.comparable > 0 ? 'ok' : '')
    + chip('不判读（本页）', summary.noVerdict, summary.noVerdict > 0 ? 'warn' : '')
    + '</div>';
  const note = '<div class="hint">口径：缺一侧印「未测量」，<strong>不填 0</strong> —— 0 比 1 小，会被读成「排第一」。'
    + '两侧测量期不一致就<strong>不判读</strong>（§20.3）；一侧自己跨了多个观测日也不判读。'
    + '「未进前 N」= 扫过但不在前 N 名，与「没扫过」是两件事。汇总的分母是<strong>这一页</strong>。</div>';
  if (rows.length === 0) {
    box.innerHTML = head + summaryBar + note + emptyState('not-recorded', {
      subject: '排名对比行',
      reason: '这个筛选下没有行。观测行数：' + left + ' ' + keywordChipValue(leftObs.rows) + ' 行 / '
        + right + ' ' + keywordChipValue(rightObs.rows) + ' 行'
        + (leftObs.rows === 0 && rightObs.rows === 0
          ? ' —— 两侧都还<strong>没有扫描过</strong>任何词，所以「未测量」是当前唯一正确的读数，不是缺陷。'
          : '。'),
      next: '用 amzn_keyword_scan 扫一次排名，或把筛选放宽到「全部」。',
    });
    return;
  }
  const table = '<table><thead><tr><th>关键词</th>'
    + '<th>' + escapeHtml(left) + ' 排名</th><th>' + escapeHtml(left) + ' 测量期</th>'
    + '<th>' + escapeHtml(right) + ' 排名</th><th>' + escapeHtml(right) + ' 测量期</th>'
    + '<th>判读</th><th>不判读的原因</th></tr></thead><tbody>'
    + rows.map(row => '<tr data-comparekeyword="' + escapeHtml(row.keyword) + '">'
      + '<td>' + escapeHtml(row.keyword) + '</td>'
      + '<td>' + compareSideCell(row.left) + '</td>'
      + '<td>' + comparePeriodCell(row.left) + '</td>'
      + '<td>' + compareSideCell(row.right) + '</td>'
      + '<td>' + comparePeriodCell(row.right) + '</td>'
      + '<td>' + (row.verdict
        ? '#' + keywordChipValue(row.verdict.left_rank) + ' / #' + keywordChipValue(row.verdict.right_rank)
          + '（差 ' + (row.verdict.delta > 0 ? '+' : '') + keywordChipValue(row.verdict.delta) + '）'
        : '<span class="chip warn">不判读</span>')
      + '</td>'
      + '<td class="tertiary">' + (row.warning ? escapeHtml(row.warning) : '—') + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';
  const limit = Math.max(1, Number(compare.limit) || 50);
  const offset = Math.max(0, Number(compare.offset) || 0);
  const hasPrev = offset > 0;
  const hasNext = offset + rows.length < Number(compare.total || 0);
  box.innerHTML = head + summaryBar + note + table
    + '<div class="bar" style="border-top:1px solid var(--line);flex-wrap:wrap">'
    + '<button type="button" data-kmlcomparepage="prev"' + (hasPrev ? '' : ' disabled') + '>上一页</button>'
    + '<button type="button" data-kmlcomparepage="next"' + (hasNext ? '' : ' disabled') + '>下一页</button>'
    + '<span class="hint">第 ' + keywordChipValue(offset + 1) + '–' + keywordChipValue(offset + rows.length)
    + ' 条，共 ' + keywordChipValue(compare.total) + ' 条（每页 ' + keywordChipValue(limit) + '）。</span></div>';
}

/* 对比视图的接线：切换开关 + 状态筛选 + 分页。控件都是动态写出来的，所以用 data-*
   委托；按 id 取会被「静态 HTML 里必须有这个 id」的守卫拦下，而它们本来就不该进静态 HTML。 */
function bindCompareControls() {
  const bindToggle = (root) => {
    if (root === null) return;
    for (const button of root.querySelectorAll('[data-kmlcompare]')) {
      button.onclick = () => {
        const target = String(button.dataset.kmlcompare || '');
        patchContext({
          filters: {
            ...state.filters,
            kwCompare: target,
            kwCompareOffset: 0,
            /* 两个视图互斥：进来一个就关掉另一个。 */
            kwBatchView: '',
            kwBatch: '',
          },
        });
      };
    }
  };
  bindToggle($('kmlstats'));
  const box = $('kmltable');
  bindToggle(box);
  if (box === null) return;
  const stateEl = within(box, '[data-kmlcomparefilter="state"]');
  if (stateEl !== null) {
    stateEl.onchange = (event) => patchContext({
      filters: { ...state.filters, kwCompareState: String(event.target.value || 'all'), kwCompareOffset: 0 },
    });
  }
  const slice = (state.master && state.master.compare) ? state.master.compare : {};
  const limit = Math.max(1, Number(slice.limit) || 50);
  const offset = Math.max(0, Number(slice.offset) || 0);
  for (const button of box.querySelectorAll('button[data-kmlcomparepage]')) {
    button.onclick = () => {
      const dir = String(button.dataset.kmlcomparepage || '');
      const next = dir === 'prev' ? Math.max(0, offset - limit) : offset + limit;
      patchContext({ filters: { ...state.filters, kwCompareOffset: next } });
    };
  }
}

/* ── FR-M6-03：批次视图（期间标签分组）─────────────────────────────────────────
   批次 = kw_import 一行（一次导入），词 → 批次走事实表的 source_file。**没有新造列**。
   两条限制写在界面上而不是报告里：
     ① period 实际有五种形状（季度 / 月两种写法 / 区间 / 跨月区间），本视图**不折算
        自然月** —— 文案由服务端带上来（master.batchNote），页面不抄第二份；
     ② 一条事实都没有的词，批次是**未知**，印「批次未知」，不印 0、不编一个默认批次。 */
function renderBatchView(master, libraryTotal) {
  const box = $('kmltable');
  if (box === null) return;
  const list = Array.isArray(master.batchList) ? master.batchList : [];
  const view = master.batchView || null;
  const selected = view !== null && view.batch ? String(view.batch.id || '') : String(state.filters.kwBatch || '');
  const options = ['<option value="">选择一次导入…</option>']
    .concat(list.map(batch => '<option value="' + escapeHtml(String(batch.id)) + '"'
      + (selected === String(batch.id) ? ' selected' : '') + '>'
      + escapeHtml(String(batch.period || '?') + ' · ' + String(batch.kind || '?') + ' · '
        + String(batch.imported_at || '') + (batch.included === 0 ? ' · 已被排除' : '')
        + ' · ' + keywordChipValue(batch.words) + ' 词')
      + '</option>'))
    .join('');
  const head = '<div class="bar" style="flex-wrap:wrap">'
    + '<select data-kmlbatchpick="import">' + options + '</select>'
    + '<button type="button" data-kmlbatchopen="off">返回总库</button>'
    + '<span class="hint">批次 = 一次导入；共 ' + keywordChipValue(list.length) + ' 次导入</span>'
    + '</div>';
  const note = '<div class="hint">' + escapeHtml(master.batchNote || '') + '</div>';
  if (view === null) {
    box.innerHTML = head + note + emptyState('not-recorded', {
      subject: '批次词表',
      reason: '还没有选导入。这个视图按**一次导入**看词，所以先在上面选一次 —— '
        + '不选就画一张表等于把 36 次导入混成一次。',
      next: '选一个期间标签（如 202603）看那次导入带来了哪些词。',
    });
    return;
  }
  const batch = view.batch || {};
  const rows = Array.isArray(view.rows) ? view.rows : [];
  const meta = '<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip">' + escapeHtml(String(batch.period || '?')) + '</span>'
    + '<span class="chip">' + escapeHtml(String(batch.kind || '?')) + '</span>'
    + '<span class="chip">导入 ' + escapeHtml(String(batch.importedAt || '?')) + '</span>'
    + '<span class="chip">' + keywordChipValue(view.total) + ' 词</span>'
    + (batch.included === false
      ? '<span class="chip warn">该导入已被排除：它的事实不参与汇总，所以这里可能是 0 行</span>'
      : '')
    + (batch.rowsReadMissing === true
      ? '<span class="chip warn">这份导入没报读过多少行（未记录，不是 0）</span>'
      : '')
    + '</div>'
    + '<div class="hint">文件：' + escapeHtml(String(batch.fileName || '?')) + '</div>';
  if (rows.length === 0) {
    box.innerHTML = head + note + meta + emptyState('filtered', {
      subject: '这次导入的词',
      reason: '这次导入没有留下可显示在总库里的词'
        + (batch.included === false ? ' —— 它的事实被排除在汇总之外。' : '。'),
      next: '换一次导入，或清掉搜索词。',
    });
    return;
  }
  const batchCell = (entry) => {
    if (entry === null || entry === undefined) return '<span class="chip warn">批次未知</span>';
    return escapeHtml(entry.periods.join('、')) + ' <span class="chip">×' + escapeHtml(String(entry.count)) + '</span>'
      + (entry.latest ? '<br><span class="tertiary">最近 ' + escapeHtml(String(entry.latest.importedAt || '')) + '</span>' : '');
  };
  const table = '<table><thead><tr><th>关键词</th><th>搜索量</th><th>层级</th>'
    + '<th>产品线</th><th>该词的全部批次（期间标签）</th></tr></thead><tbody>'
    + rows.map(row => '<tr data-batchkeyword="' + escapeHtml(row.keyword) + '">'
      + '<td>' + escapeHtml(row.keyword) + '</td>'
      + '<td>' + keywordChipValue(row.searchVolume) + '</td>'
      + '<td>' + escapeHtml(String(row.svTier || '')) + '</td>'
      + '<td>' + (row.productLineUnclassified
        ? '<span class="chip warn">未分类</span>'
        : escapeHtml(String(row.productLine || ''))) + '</td>'
      + '<td>' + batchCell(row.batch) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';
  const limit = Math.max(1, Number(view.limit) || 100);
  const offset = Math.max(0, Number(view.offset) || 0);
  const hasPrev = offset > 0;
  const hasNext = offset + rows.length < Number(view.total || 0);
  box.innerHTML = head + note + meta + table
    + '<div class="bar" style="border-top:1px solid var(--line);flex-wrap:wrap">'
    + '<button type="button" data-kmlbatchpage="prev"' + (hasPrev ? '' : ' disabled') + '>上一页</button>'
    + '<button type="button" data-kmlbatchpage="next"' + (hasNext ? '' : ' disabled') + '>下一页</button>'
    + '<span class="hint">第 ' + keywordChipValue(offset + 1) + '–' + keywordChipValue(offset + rows.length)
    + ' 条，共 ' + keywordChipValue(view.total) + ' 条（每页 ' + keywordChipValue(limit) + '）。'
    + '「产品线」读的是 kw_master 的派生值 —— 未分类 = 没有信号命中，不是「属于默认线」。</span></div>';
}

/* 批次视图的接线：开关 + 选批次 + 分页。控件都是动态写的，走 data-*。 */
function bindBatchViewControls() {
  const bindToggle = (root) => {
    if (root === null) return;
    for (const button of root.querySelectorAll('[data-kmlbatchopen]')) {
      button.onclick = () => {
        const on = String(button.dataset.kmlbatchopen || '') === 'open';
        patchContext({
          filters: {
            ...state.filters,
            kwBatchView: on ? 'batch' : '',
            kwBatch: on ? String(state.filters.kwBatch || '') : '',
            kwBatchOffset: 0,
            /* 两个视图是互斥的：进来一个就关掉另一个，否则「我在看哪一屏」会有两个答案。 */
            kwCompare: '',
          },
        });
      };
    }
  };
  bindToggle($('kmlstats'));
  const box = $('kmltable');
  bindToggle(box);
  if (box === null) return;
  const pick = within(box, '[data-kmlbatchpick="import"]');
  if (pick !== null) {
    pick.onchange = (event) => patchContext({
      filters: { ...state.filters, kwBatch: String(event.target.value || ''), kwBatchOffset: 0 },
    });
  }
  const view = (state.master && state.master.batchView) ? state.master.batchView : null;
  const limit = Math.max(1, Number((view && view.limit) || 100));
  const offset = Math.max(0, Number((view && view.offset) || 0));
  for (const button of box.querySelectorAll('button[data-kmlbatchpage]')) {
    button.onclick = () => {
      const dir = String(button.dataset.kmlbatchpage || '');
      const next = dir === 'prev' ? Math.max(0, offset - limit) : offset + limit;
      patchContext({ filters: { ...state.filters, kwBatchOffset: next } });
    };
  }
}

/* 模块 08 F08-07 的生命周期计数块。九态**全画**（含 0），因为「0 个已排除」与「没有
   这个状态」必须长得不一样。「未设置」是一个**真算出来**的数（总库里没有对应生命周期
   行的条数），不是「总数减已设置」——那样会把两个站点口径不同时的差异藏起来。
   这个函数存在的理由写在 HTML 那块注释里：一个存在但没人写的 div 就是承诺了能力然后
   把它丢掉。 */
function renderMasterLifecycle(master) {
  const box = $('kmlLifecycleCounts');
  if (box === null) return;
  const life = master.lifecycle;
  if (!life) { box.innerHTML = ''; return; }
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + keywordChipTitle(value) + '">'
    + escapeHtml(label) + ' ' + escapeHtml(keywordChipValue(value)) + '</span>';
  const parts = [chip('已设置', life.total), chip('未设置', life.unset, life.unset > 0 ? 'warn' : '')];
  for (const entry of life.byStatus) {
    parts.push(chip(entry.status + ' ' + entry.label, entry.n, entry.n > 0 ? 'ok' : ''));
  }
  const states = Array.isArray(life.states) ? life.states : [];
  const stateOptions = states.map(entry => '<option value="' + escapeHtml(entry.status) + '">'
    + escapeHtml(entry.status) + ' ' + escapeHtml(entry.label) + '</option>').join('');
  /* 换行用 String.fromCharCode(10)，不写转义：这一段在模板字符串里，写反斜杠 n 会在
     浏览器拿到之前就变成一个真换行，把生成的脚本截断成语法错误（本文件顶部记过同一个坑）。 */
  const keptResult = lastLifecycleBatchText === null ? '' : escapeHtml(lastLifecycleBatchText).split(String.fromCharCode(10)).join('<br>');
  box.innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + parts.join('')
    + '</div>'
    + '<div class="hint">生命周期九态：'
    + escapeHtml((life.states || []).map(entry => entry.status).join(' → '))
    + '。「未设置」是没人决定过，不是 candidate；excluded 与 archived 不是终态，可回 active。</div>'
    /* F-5（走查 2026-10-25）：批量入口。走查时这里只有一句「先在下面的表里点选**一条**词」，
       而库是 30,778 条 —— 那不是效率问题，是这条路走不通。两处选区：
         勾选：总库大表每行的勾选框（本页，最多 100 条）；
         筛选：服务端按当前筛选解析，仍受 500 硬上限，命中数与剩余量一起带回。
       批量是「先预览、再确认」两步，且 all-or-nothing —— 一个词不合法整批都不写。 */
    + '<div class="bar" style="border-top:1px solid var(--line);flex-wrap:wrap">'
    + '<select data-kmlbatch="from">'
    + '<option value="picked">选区：勾选的词（本页）</option>'
    + '<option value="filter">选区：当前筛选（服务端解析，≤500）</option>'
    + '</select>'
    + '<select data-kmlbatch="to"><option value="">改生命周期 →</option>' + stateOptions + '</select>'
    + '<input type="search" data-kmlbatch="reason" placeholder="理由（必填：人的决定要能复核）">'
    + '<button type="button" data-kmlbatchact="pick-all">全选本页</button>'
    + '<button type="button" data-kmlbatchact="pick-none">清空勾选</button>'
    + '<button type="button" data-kmlbatchact="preview">预览影响</button>'
    + '<button type="button" data-kmlbatchact="commit" hidden>确认执行（批量）</button>'
    + '</div>'
    + '<div class="bar" style="flex-wrap:wrap">'
    + '<span class="hint" data-kmlbatch="picked">已勾选 0 条（本页）</span>'
    + '<span class="hint" data-kmlbatch="mode">按勾选改：最多一页；按筛选改：服务端解析筛选，命中数与剩余量在结果里给出。</span>'
    + '</div>'
    + '<div class="hint" data-kmlbatch="result">' + keptResult + '</div>'
    /* v69：产品线归属的批量条。与上面那条**共用勾选框与「当前筛选」的选区语义**，
       只把目标换成产品线（或撤销人工归属）。 */
    + productLineBatchBar(master);
  bindLifecycleBatch();
  bindProductLineBatch();
}

/* ── 批量改生命周期（F-5）的接线 ──────────────────────────────────────────── */

/* 取块内的一个控件。用 querySelectorAll(...) 的第 0 个，而不是 element.querySelector：
   页面脚本在测试里是**按真实 HTML 里的 id 造替身**跑的，替身只实现了 querySelectorAll；
   直接调 querySelector 会让「替身少一个方法」变成一个假缺陷，而它和页面行为无关。
   （真 DOM 上两种写法等价。） */
function within(el, selector) {
  if (el === null || el === undefined || typeof el.querySelectorAll !== 'function') return null;
  const found = el.querySelectorAll(selector);
  return found !== null && found !== undefined && found.length > 0 ? found[0] : null;
}

/* 勾选的行 —— 唯一的选区来源。勾选框在总库大表的每一行（renderMasterTable 写出来的），
   所以这里读的是表的 tr[data-keyword]，与行点击委托读的是同一份数据。 */
function pickedRows() {
  const picked = [];
  const table = $('kmltable');
  if (table === null) return picked;
  for (const input of table.querySelectorAll('input.kmpick')) {
    if (input.checked !== true) continue;
    const tr = input.closest('tr');
    if (tr === null || !tr.dataset || !tr.dataset.keyword) continue;
    picked.push({ keyword: tr.dataset.keyword, marketplace: String(tr.dataset.marketplace || '') });
  }
  return picked;
}

/* 「已勾选 N 条」那一格。勾选变化、全选、清空都要重算 —— 数字与勾选不一致比没有数字更糟。 */
function updatePickedCount() {
  const box = $('kmlLifecycleCounts');
  if (box === null) return;
  const label = within(box, '[data-kmlbatch="picked"]');
  if (label === null) return;
  label.textContent = '已勾选 ' + pickedRows().length + ' 条（本页）';
}

/* 勾选框的接线：stopPropagation 是必须的 —— 容器的行点击委托会把「点到的行」写进
   context 并打开详情，不拦的话勾一个词就跳一次详情。 */
function bindMasterPicks() {
  const table = $('kmltable');
  if (table === null) return;
  for (const input of table.querySelectorAll('input.kmpick')) {
    input.onclick = (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    };
    input.onchange = () => updatePickedCount();
  }
  updatePickedCount();
}

/* 当前站点：勾选派从行上读；筛选派从 context.filters 读（没有就退回本页第一行的站点）。
   读不出来就报错 —— 猜一个站点会把决定写到别的站点上。 */
function currentMarketplace() {
  if (state.filters && state.filters.marketplace) return String(state.filters.marketplace).toUpperCase();
  const rows = (state.master && Array.isArray(state.master.rows)) ? state.master.rows : [];
  return rows.length > 0 ? String(rows[0].marketplace || '').toUpperCase() : '';
}

/* 组装一次批量的请求体。校验在**这里先挡一遍**（空目标态、空理由、跨站点、没勾选），
   服务端仍然会再挡一遍 —— 页面的校验是为了少跑一次请求，不是替换服务端的判断。 */
function batchSelectionBody() {
  const box = $('kmlLifecycleCounts');
  if (box === null) return null;
  const fromEl = within(box, '[data-kmlbatch="from"]');
  const toEl = within(box, '[data-kmlbatch="to"]');
  const reasonEl = within(box, '[data-kmlbatch="reason"]');
  const mode = fromEl === null ? 'picked' : String(fromEl.value || 'picked');
  const to = toEl === null ? '' : String(toEl.value || '');
  const reason = reasonEl === null ? '' : String(reasonEl.value || '').trim();
  if (to === '') { showPageError(new Error('先选一个目标状态，再批量改生命周期。')); return null; }
  if (reason === '') {
    showPageError(new Error('批量改生命周期要填理由 —— 一次动几百条的决定，事后必须能复核。'));
    return null;
  }
  const body = { to: to, reason: reason, by: 'page', dryRun: true };
  if (mode === 'filter') {
    const marketplace = currentMarketplace();
    if (marketplace === '') {
      showPageError(new Error('按筛选改需要先确定站点：筛选里没有站点，本页也没有行。'));
      return null;
    }
    body.marketplace = marketplace;
    body.filter = {
      q: state.filters.masterQ || '',
      productLine: state.filters.masterLine || '',
      svTier: state.filters.masterTier || '',
      lifecycleStatus: state.filters.masterLifecycle || '',
    };
    return body;
  }
  const picked = pickedRows();
  if (picked.length === 0) {
    showPageError(new Error('先在下面的总库表里勾选至少一个词，或把选区改成「当前筛选」。'));
    return null;
  }
  const markets = [...new Set(picked.map(row => row.marketplace))];
  if (markets.length !== 1) {
    showPageError(new Error('勾选的词跨了站点（' + markets.join(' / ') + '），一次批量只能针对一个站点。'));
    return null;
  }
  body.marketplace = markets[0];
  body.keywords = picked.map(row => row.keyword);
  return body;
}

/* 预览与执行是**同一个路由、同一个 store 函数**，只差一个 dryRun —— 「预览说 500、执行改了
   30,778」这种分叉在这个形状下不可能发生。 */
function postLifecycleBatch(body) {
  return api('keyword-lifecycle-batch', { method: 'POST', body: JSON.stringify(body) });
}

function bindLifecycleBatch() {
  const box = $('kmlLifecycleCounts');
  if (box === null) return;
  const resultEl = within(box, '[data-kmlbatch="result"]');
  const modeEl = within(box, '[data-kmlbatch="mode"]');
  const fromEl = within(box, '[data-kmlbatch="from"]');
  const previewBtn = within(box, '[data-kmlbatchact="preview"]');
  const commitBtn = within(box, '[data-kmlbatchact="commit"]');
  const pickAllBtn = within(box, '[data-kmlbatchact="pick-all"]');
  const pickNoneBtn = within(box, '[data-kmlbatchact="pick-none"]');
  let pending = null;
  const say = (value) => {
    lastLifecycleBatchText = value === null || value === undefined || value === '' ? null : String(value);
    if (resultEl !== null) resultEl.textContent = lastLifecycleBatchText === null ? '' : lastLifecycleBatchText;
  };
  const fail = (error) => {
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  };

  if (fromEl !== null) {
    fromEl.onchange = () => {
      pending = null;
      if (commitBtn !== null) commitBtn.hidden = true;
      if (modeEl !== null) {
        modeEl.textContent = String(fromEl.value || 'picked') === 'filter'
          ? '按当前筛选改：服务端解析筛选（命中数/已在目标态/剩余量都会带回）；一次最多 500 词。'
          : '按勾选改：只改总库大表里勾选的行（本页）；一次最多 500 词。';
      }
    };
  }
  if (pickAllBtn !== null) pickAllBtn.onclick = () => {
    const table = $('kmltable');
    if (table === null) return;
    for (const input of table.querySelectorAll('input.kmpick')) input.checked = true;
    updatePickedCount();
  };
  if (pickNoneBtn !== null) pickNoneBtn.onclick = () => {
    const table = $('kmltable');
    if (table === null) return;
    for (const input of table.querySelectorAll('input.kmpick')) input.checked = false;
    updatePickedCount();
  };
  if (previewBtn !== null) previewBtn.onclick = () => {
    const body = batchSelectionBody();
    if (body === null) return;
    postLifecycleBatch(body).then((data) => {
      clearPageError();
      say(data && data.text ? data.text : '');
      pending = body;
      if (commitBtn !== null) commitBtn.hidden = false;
    }).catch((error) => {
      pending = null;
      if (commitBtn !== null) commitBtn.hidden = true;
      say('');
      fail(error);
    });
  };
  if (commitBtn !== null) commitBtn.onclick = () => {
    if (pending === null) {
      showPageError(new Error('先点「预览影响」看清这批会改多少词，再确认执行。'));
      return;
    }
    const body = { ...pending, dryRun: false };
    postLifecycleBatch(body).then((data) => {
      clearPageError();
      pending = null;
      commitBtn.hidden = true;
      say(data && data.text ? data.text : '');
      return refresh();
    }).catch(fail);
  };
}

/* ── v69：产品线归属的批量条 ────────────────────────────────────────────────
   与生命周期那条共用勾选框与「当前筛选」的选区语义；两处不同都是这张表的事：
   目标是产品线 id（或撤销），并且「已经在目标值」按**人工值**判断。
   三档来源与「未分类」的措辞由服务端切片带上来，页面不抄第二份。 */
function productLineBatchBar(master) {
  const slice = master.productLineDecisions || null;
  const options = (slice && Array.isArray(slice.options)) ? slice.options : [];
  const counts = (slice && slice.counts) ? slice.counts : null;
  const optionHtml = options.map(option => '<option value="' + escapeHtml(String(option.id)) + '">'
    + escapeHtml(String(option.name === undefined ? option.id : option.name))
    + '(' + escapeHtml(String(option.id)) + ')</option>').join('');
  const countLine = counts === null ? '' : '<span class="hint">当前 ' + keywordChipValue(counts.total) + ' 词：人工 '
    + keywordChipValue(counts.manual) + ' / 自动 ' + keywordChipValue(counts.derived) + ' / 未分类 '
    + keywordChipValue(counts.unclassified) + '（分母是总库条数）</span>';
  const kept = lastProductLineBatchText === null
    ? ''
    : escapeHtml(lastProductLineBatchText).split(String.fromCharCode(10)).join('<br>');
  return '<div class="bar" style="border-top:1px solid var(--line);flex-wrap:wrap">'
    + '<select data-kmlpline="from">'
    + '<option value="picked">选区：勾选的词（本页）</option>'
    + '<option value="filter">选区：当前筛选（服务端解析，≤500）</option>'
    + '</select>'
    + '<select data-kmlpline="to"><option value="">改产品线 →</option>' + optionHtml
    + '<option value="__revoke__">撤销人工归属（回到自动）</option></select>'
    + '<input type="search" data-kmlpline="reason" placeholder="理由（必填：人的决定要能复核）">'
    + '<button type="button" data-kmlplineact="preview">预览影响（产品线）</button>'
    + '<button type="button" data-kmlplineact="commit" hidden>确认执行（产品线）</button>'
    + '</div>'
    + '<div class="bar" style="flex-wrap:wrap">' + countLine
    + '<span class="hint">「未分类」= 没有任何产品线信号命中（暂落默认线），<strong>不是</strong>「属于默认线」；'
    + '人工值优先于自动值，撤销后回到自动值。</span></div>'
    + '<div class="hint" data-kmlpline="result">' + kept + '</div>';
}

function productLineBatchBody() {
  const box = $('kmlLifecycleCounts');
  if (box === null) return null;
  const fromEl = within(box, '[data-kmlpline="from"]');
  const toEl = within(box, '[data-kmlpline="to"]');
  const reasonEl = within(box, '[data-kmlpline="reason"]');
  const mode = fromEl === null ? 'picked' : String(fromEl.value || 'picked');
  const to = toEl === null ? '' : String(toEl.value || '');
  const reason = reasonEl === null ? '' : String(reasonEl.value || '').trim();
  if (to === '') { showPageError(new Error('先选一条产品线（或「撤销人工归属」），再批量改。')); return null; }
  if (reason === '') {
    showPageError(new Error('批量改产品线要填理由 —— 一次动几百条的决定，事后必须能复核。'));
    return null;
  }
  const body = { reason: reason, by: 'page', dryRun: true };
  if (to === '__revoke__') body.revoke = true;
  else body.to = to;
  if (mode === 'filter') {
    const marketplace = currentMarketplace();
    if (marketplace === '') {
      showPageError(new Error('按筛选改需要先确定站点：筛选里没有站点，本页也没有行。'));
      return null;
    }
    body.marketplace = marketplace;
    body.filter = {
      q: state.filters.masterQ || '',
      productLine: state.filters.masterLine || '',
      svTier: state.filters.masterTier || '',
      lifecycleStatus: state.filters.masterLifecycle || '',
    };
    return body;
  }
  const picked = pickedRows();
  if (picked.length === 0) {
    showPageError(new Error('先在下面的总库表里勾选至少一个词，或把选区改成「当前筛选」。'));
    return null;
  }
  const markets = [...new Set(picked.map(row => row.marketplace))];
  if (markets.length !== 1) {
    showPageError(new Error('勾选的词跨了站点（' + markets.join(' / ') + '），一次批量只能针对一个站点。'));
    return null;
  }
  body.marketplace = markets[0];
  body.keywords = picked.map(row => row.keyword);
  return body;
}

function postProductLineBatch(body) {
  return api('keyword-product-line-batch', { method: 'POST', body: JSON.stringify(body) });
}

function bindProductLineBatch() {
  const box = $('kmlLifecycleCounts');
  if (box === null) return;
  const resultEl = within(box, '[data-kmlpline="result"]');
  const previewBtn = within(box, '[data-kmlplineact="preview"]');
  const commitBtn = within(box, '[data-kmlplineact="commit"]');
  let pending = null;
  const say = (value) => {
    lastProductLineBatchText = value === null || value === undefined || value === '' ? null : String(value);
    if (resultEl !== null) resultEl.textContent = lastProductLineBatchText === null ? '' : lastProductLineBatchText;
  };
  const fail = (error) => {
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  };
  if (previewBtn !== null) previewBtn.onclick = () => {
    const body = productLineBatchBody();
    if (body === null) return;
    postProductLineBatch(body).then((data) => {
      clearPageError();
      say(data && data.text ? data.text : '');
      pending = body;
      if (commitBtn !== null) commitBtn.hidden = false;
    }).catch((error) => {
      pending = null;
      if (commitBtn !== null) commitBtn.hidden = true;
      say('');
      fail(error);
    });
  };
  if (commitBtn !== null) commitBtn.onclick = () => {
    if (pending === null) {
      showPageError(new Error('先点「预览影响（产品线）」看清这批会改多少词，再确认执行。'));
      return;
    }
    const body = { ...pending, dryRun: false };
    postProductLineBatch(body).then((data) => {
      clearPageError();
      pending = null;
      commitBtn.hidden = true;
      say(data && data.text ? data.text : '');
      return refresh();
    }).catch(fail);
  };
}

/* 模块 08 F08-04 的所有权工作台。主人与冲突都是**服务端推导**的（主人 = 唯一生效
   主张；≥2 条生效主张即冲突），页面只渲染、不重算 —— 重算就是第二份实现，迟早与
   服务端分叉。每一行带一个勾选框（批量操作的输入）；「操作」列里的按钮是动态生成的，
   所以用 data-* + querySelectorAll 接线，而不是按 id 去取 —— 页面脚本里按 id 取的每个
   元素都必须在静态 HTML 里存在（测试套件有守卫），动态按钮不在其中。
   这个函数存在的理由写在 HTML 那块注释里：一个存在但没人写的 div 就是承诺了能力然后
   把它丢掉。 */
function renderMasterOwnership(master) {
  const box = $('kmlOwnershipCounts');
  if (box === null) return;
  const own = master.ownership;
  const table = $('kmlOwnershipTable');
  const preview = $('kmlOwnershipPreview');
  if (!own) {
    box.innerHTML = '';
    table.innerHTML = '';
    preview.innerHTML = '';
    return;
  }
  const stats = own.stats || {};
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + keywordChipTitle(value) + '">'
    + escapeHtml(label) + ' ' + escapeHtml(keywordChipValue(value)) + '</span>';
  box.innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('有主张/建议', stats.total)
    + chip('有生效主张', stats.claimed)
    + chip('冲突', stats.conflicted, stats.conflicted > 0 ? 'warn' : '')
    + chip('建议', stats.suggestions)
    + chip('待采纳', stats.pendingSuggestions, stats.pendingSuggestions > 0 ? 'warn' : '')
    + '</div>'
    + '<div class="hint">主人 = 该词下**唯一**生效主张；同一词下 ≥2 条生效主张就是冲突 —— '
    + '库里不存冲突标志位，所以释放一条之后冲突会自己消失。释放不删行，历史见 amzn_keyword_detail 的「所有权事件」一节。'
    /* 「变体关系表到底有没有、库里有没有这条关系」由服务端读库得出（own.notes），
       这一行**不再自己写一句结论**。修复前这里写死了「这层表不存在（F05-06）」，
       而表从 schema v37 起就存在 —— 那是把「我没建」当成「它不存在」，而且这一处是
       **唯一印给人看的那一面**（T-8 缺陷 1）。页面脚本是模板字符串、没有模块系统：
       它读状态里的结果，不调函数、不写第二份措辞。 */
    + ((Array.isArray(own.notes) ? own.notes : []).join('') || '变体关系那一条判据的说明还没读上来（服务端没给 notes）——「读不到」不等于「没有这条判据」。')
    + '建议由 Agent 回写（amzn_keyword_ownership_suggest）：点「请求 Agent 建议」到 Agent 画布，'
    + '或在对话里说「为某词请求所有权建议」。</div>';

  if (own.rows.length === 0) {
    table.innerHTML = emptyState('not-recorded', {
      subject: '所有权主张或建议',
      next: '批量操作若影响运行中的优化运行，执行前会要求二次确认。',
    });
    return;
  }
  const ownerCell = row => (row.conflicted
    ? '<span class="chip warn">未决</span>'
    : (row.owner ? escapeHtml(row.owner) : '<span class="tertiary">无</span>'));
  const suggestCell = row => {
    if (!row.suggestion) return '<span class="tertiary">（无建议）</span>';
    const adopted = row.suggestion.adoptedAt === null ? ''
      : ' <span class="chip ok">已采纳 ' + escapeHtml(String(row.suggestion.adoptedAsin || '')) + '</span>';
    return '<span class="mono strong">' + escapeHtml(String(row.suggestion.suggestedAsin)) + '</span>' + adopted
      + (row.suggestion.reason
        ? '<br><span class="tertiary">' + escapeHtml(String(row.suggestion.reason)) + '</span>'
        : '');
  };
  table.innerHTML = '<table><thead><tr>'
    + '<th></th><th>词</th><th>候选 ASIN</th><th>当前主人</th><th>冲突原因</th>'
    + '<th>建议（Agent 回写）</th><th>操作</th></tr></thead><tbody>'
    + own.rows.map(row => '<tr data-ownkeyword="' + escapeHtml(row.keyword) + '" data-ownmarket="' + escapeHtml(row.marketplace) + '">'
      + '<td><input type="checkbox" class="ownpick"></td>'
      + '<td>' + escapeHtml(row.keyword) + '</td>'
      + '<td>' + escapeHtml(row.candidates.join(' · ') || '—') + '</td>'
      + '<td>' + ownerCell(row) + '</td>'
      + '<td>' + (row.conflictReasons.length > 0
        ? escapeHtml(row.conflictReasons.join('；'))
        : '<span class="tertiary">—</span>') + '</td>'
      + '<td>' + suggestCell(row) + '</td>'
      + '<td class="nowrap">'
      + (row.suggestion ? '<button class="btn btn--primary btn--sm" data-ownadopt="1">采纳</button> ' : '')
      + '<button class="btn btn--ghost btn--sm" data-ownagent="1">请求 Agent 建议</button>'
      + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';

  for (const tr of table.querySelectorAll('tbody tr')) {
    const keyword = tr.dataset.ownkeyword;
    const marketplace = tr.dataset.ownmarket;
    const adopt = tr.querySelector('button[data-ownadopt]');
    if (adopt !== null) adopt.onclick = () => adoptOwnership(keyword, marketplace);
    const ask = tr.querySelector('button[data-ownagent]');
    if (ask !== null) ask.onclick = () => patchContext({ module: 'agent' });
  }
}

/* 模块 08 F08-05 的位置计划块。计划是**分配决定**（哪个词归哪个位置），与
   kw_master.for_listing_json 的**资格**（哪个词**允许**进哪个位置）不是一回事 ——
   资格说「可以」，计划说「就放这里」。计划覆盖与实际覆盖**分开画**：没有 listing 文案
   时实际覆盖显示「无法计算（null）」而不是 0 —— 0 与「计划了 10、实际到 0」无法区分。
   这个函数存在的理由写在 HTML 那块注释里：一个存在但没人写的 div 就是承诺了能力然后
   把它丢掉。 */
function renderMasterPlan(master) {
  const box = $('kmlPlanCounts');
  if (box === null) return;
  const table = $('kmlPlanTable');
  const proposal = $('kmlPlanProposal');
  const coverage = $('kmlPlanCoverage');
  const plan = master.plan;
  if (!plan) {
    box.innerHTML = '';
    table.innerHTML = '';
    proposal.innerHTML = '';
    coverage.innerHTML = '';
    return;
  }
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + keywordChipTitle(value) + '">'
    + escapeHtml(label) + ' ' + escapeHtml(keywordChipValue(value)) + '</span>';
  const versions = plan.versions || [];
  const current = plan.current;
  box.innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('计划版本', versions.length)
    + chip('当前', current ? ('v' + current.version) : '无')
    + chip('当前词数', current ? current.entryCount : 0)
    + '</div>'
    + '<div class="hint">计划是**分配决定**：哪个词归哪个位置。一词一主人（同一个词在一个'
    + '计划里只能有一个主人），一位一用途（位置的用途在词表里声明，条目不能改写）。'
    + '它与 kw_master 的资格不是一回事 —— 资格说「可以」，计划说「就放这里」。</div>';

  const proposalEntries = (plan.proposal && plan.proposal.entries) || [];
  state.planProposal = proposalEntries;
  state.planMarketplace = plan.marketplace || '';
  if (proposalEntries.length === 0) {
    proposal.innerHTML = emptyState('not-recorded', {
      subject: '位置计划提案',
      next: '填一个 ASIN，点「生成提案」，或在对话里说「为这个 ASIN 生成位置计划提案」。',
    });
  } else {
    proposal.innerHTML = '<div class="hint">提案（未写库）· ' + proposalEntries.length + ' 词 · 每个词一个主人：</div>'
      + '<table><thead><tr><th>词</th><th>主人位置</th><th>层级</th><th>搜索量</th></tr></thead><tbody>'
      + proposalEntries.slice(0, 40).map(entry => '<tr><td>' + escapeHtml(entry.keyword) + '</td>'
        + '<td>' + escapeHtml(entry.ownerPosition) + '</td>'
        + '<td>' + escapeHtml(entry.tier || '') + '</td>'
        + '<td>' + (entry.searchVolume === null ? '' : entry.searchVolume) + '</td></tr>').join('')
      + '</tbody></table>';
  }

  if (!current) {
    table.innerHTML = emptyState('not-recorded', {
      subject: '这个站点的已保存位置计划',
      next: '先生成提案，确认之后保存 —— 一个词一个主人，保存的位置计划是模块 08 唯一的计划持久层。',
    });
  } else {
    const rows = plan.rows || [];
    table.innerHTML = '<div class="hint">当前计划 v' + current.version + ' · '
      + escapeHtml(current.statusLabel || '') + ' · ' + escapeHtml(current.source || '') + ' · ' + rows.length + ' 词</div>'
      + (rows.length === 0 ? '' : '<table><thead><tr><th>词</th><th>主人位置</th><th>层级</th><th>复现位</th></tr></thead><tbody>'
        + rows.slice(0, 60).map(row => '<tr><td>' + escapeHtml(row.keyword) + '</td>'
          + '<td>' + escapeHtml(row.ownerPosition) + '</td>'
          + '<td>' + escapeHtml(row.tier || '') + '</td>'
          + '<td>' + escapeHtml((row.supporting || []).map(slot => slot.position).join(' / ') || '—') + '</td></tr>').join('')
        + '</tbody></table>');
  }

  const cov = plan.coverage;
  if (!cov) {
    coverage.innerHTML = '<div class="hint">还没有计划，无法统计覆盖。</div>';
  } else {
    const lines = ['<div class="hint">**计划覆盖**：' + cov.plannedTotal + ' 格（可核对 ' + cov.checkableTotal + ' 格）</div>'];
    if (cov.actualIsNull) {
      lines.push('<div class="hint">**实际覆盖：无法计算（null）** —— ' + escapeHtml(cov.reason || '') + '</div>');
    } else {
      /* fillRate 为 null = 没有可核对的分母（store/keyword-plan.js 在 actual 未提供时不返回它）。
         印 null 会让人以为字段坏了，印 0 会让人以为「一个都没填」——都不对，印「不判读」。
         注意：本块位于模板字符串内部，注释里不能出现反引号，否则会把模板字符串截断。 */
      lines.push('<div class="hint">**实际覆盖**：' + cov.actualTotal + ' 格 / 可核对 ' + cov.checkableTotal
        + ' 格（fillRate ' + (cov.fillRate === null || cov.fillRate === undefined ? '不判读' : cov.fillRate) + '）</div>');
    }
    coverage.innerHTML = lines.join('');
  }
}

/* 采纳建议：走 keyword-ownership-resolve 路由（路由再走工具，审计漏斗挂在工具上）。
   不传 asin —— 服务端采纳那条待采纳的建议；没有建议会被拒，理由原样上屏。 */
function adoptOwnership(keyword, marketplace) {  api('keyword-ownership-resolve', {
    method: 'POST',
    body: JSON.stringify({ keyword, marketplace, by: 'page' }),
  }).then(() => {
    clearPageError();
    return refresh();
  }).catch((error) => {
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  });
}

/* The batch bar's first step: read the checked workbench rows, ask the server what
   the operation would do (a POST because the body carries the selection, but a
   read — it writes nothing), and draw the impact. The confirm button is what
   actually writes, and it always carries the confirmed flag — that button IS the
   second confirmation the server demands when a running optimization run is
   affected.
   NB: no backticks in this comment — it sits inside the script string. */
async function previewOwnershipBatch() {
  const preview = $('kmlOwnershipPreview');
  const confirm = $('kmlOwnConfirmBtn');
  const picks = [];
  for (const box of $('kmlOwnershipTable').querySelectorAll('input.ownpick')) {
    if (box.checked !== true) continue;
    const tr = box.closest('tr');
    if (tr === null) continue;
    picks.push({ keyword: tr.dataset.ownkeyword, marketplace: tr.dataset.ownmarket });
  }
  if (picks.length === 0) {
    showPageError(new Error('先在工作台表里勾选至少一个词，再预览批量操作。'));
    return;
  }
  const markets = [...new Set(picks.map(pick => pick.marketplace))];
  if (markets.length !== 1) {
    showPageError(new Error('勾选的词不在同一个站点（' + markets.join(' / ') + '），一次批量操作只能针对一个站点。'));
    return;
  }
  const action = String($('kmlOwnAction').value || '');
  const asinEl = $('kmlOwnAsin');
  const reasonEl = $('kmlOwnReason');
  const body = {
    action,
    keywords: picks.map(pick => pick.keyword),
    marketplace: markets[0],
    asin: asinEl === null ? '' : String(asinEl.value || '').trim(),
    reason: reasonEl === null ? '' : String(reasonEl.value || '').trim(),
  };
  try {
    const data = await api('keyword-ownership-preview', { method: 'POST', body: JSON.stringify(body) });
    clearPageError();
    preview.textContent = String(data.text || '');
    pendingOwnership = body;
    if (confirm !== null) confirm.hidden = false;
  } catch (error) {
    pendingOwnership = null;
    if (confirm !== null) confirm.hidden = true;
    preview.textContent = '';
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  }
}

/* The second step: actually write. Refuses to run without a preview first — a
   confirm button that writes something the operator never saw is the shape this
   whole two-step flow exists to prevent. */
function confirmOwnershipBatch() {
  const confirm = $('kmlOwnConfirmBtn');
  if (pendingOwnership === null) {
    showPageError(new Error('先点「预览影响」看清楚这批操作会动到什么，再确认执行。'));
    return;
  }
  const body = { ...pendingOwnership, by: 'page', confirmed: true };
  api('keyword-ownership', { method: 'POST', body: JSON.stringify(body) }).then((data) => {
    clearPageError();
    pendingOwnership = null;
    if (confirm !== null) confirm.hidden = true;
    $('kmlOwnershipPreview').textContent = String(data.text || '');
    return refresh();
  }).catch((error) => {
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  });
}

${pipelineScript}

/* ── competitor: us vs them ────────────────────────────────────────────── */

/* The two lists are stacked and full width, not side by side. Measured on a
   1280 viewport: two columns leave ~330px each, and "patio furniture cushions"
   is truncated in both — the column that matters most is the one that cannot
   show its own data. They also each carry their own sort, which side-by-side
   cannot express. Only the two count cards share a row. */
const DIFF_ORDER_LABELS = {
  volume: '按搜索量', best_rank: '按竞品最好排名', ranked_count: '按竞品有排名数',
  our_rank: '按我们排名', keyword: '按关键词',
};

function diffOrderSelect(id, current) {
  return '<select id="' + id + '">'
    + Object.keys(DIFF_ORDER_LABELS).map(key => '<option value="' + key + '"'
      + (key === current ? ' selected' : '') + '>' + escapeHtml(DIFF_ORDER_LABELS[key]) + '</option>').join('')
    + '</select>';
}
`
