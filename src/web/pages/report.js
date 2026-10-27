/**
 * 页签「report」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const reportScript = `
/* F14-10 — 导出按钮。**页面不拼 URL、也不猜有没有**：row.exports.formats 由服务端的
   exportPlan 下发（可用的带地址，不可用的带理由）。

   两条决定值得写下来：

   - 可用的画成一个带 download 属性的链接，让浏览器按服务端的 content-disposition 存盘。
     不在 JS 里 fetch 再拼 Blob —— 那会把「文件叫什么名字」变成客户端再猜一次的事，而名字
     是服务端为这份报告算的（类型 + 日期 + 短 id + 标题）。
   - 不可用的**照样画出来**，带一个说明原因的悬停提示。画成点不动的灰块，读者只知道
     「不行」，不知道「为什么不行、要做什么才行」—— 而后者正是这一栏要回答的。

   一个函数，列表与详情面板共用：两处各写一遍，就是两处会漂的按钮。 */
function reportExportBits(row) {
  const formats = Array.isArray(row.exports && row.exports.formats) ? row.exports.formats : [];
  if (formats.length === 0) return '';
  /* 文件类（CSV 等 pointer=path）：正文就是磁盘上那个文件，Markdown / HTML / Excel
     三种转换对它没有意义。三个「取不到」并排只会把「不适用」画成「坏了」；
     这边只给一个「复制路径」，路径放 title，成功后在按钮上回「已复制」。
     （ADR-001 D11：S1 只做复制路径，不做「打开文件」。） */
  if (formats.every(format => format.available !== true) && row.path) {
    return '<button type="button" data-rp-copy="' + escapeHtml(String(row.path)) + '"'
      + ' title="' + escapeHtml(String(row.path)) + '">复制路径</button>'
      + '<span class="hint" style="padding:0">CSV 文件本身就是导出件，不再转成 Markdown / HTML / Excel。</span>';
  }
  return formats.map(format => {
    const id = escapeHtml(format.id);
    if (format.available) {
      return '<a download data-rp-export="' + id + '"'
        + ' href="' + escapeHtml(format.url) + '"'
        + ' title="下载 ' + escapeHtml(format.label) + '（' + escapeHtml(format.type) + '）"'
        + '>导出 ' + escapeHtml(format.label) + '</a>';
    }
    return '<span class="chip" data-rp-export="' + id + '"'
      + ' title="' + escapeHtml(format.reason || '这一份导出件取不到') + '"'
      + ' style="opacity:.55;cursor:help">' + escapeHtml(format.label) + ' 取不到</span>';
  }).join('');
}

function renderReports() {
  const data = state.reports;
  if (!data) { $('rptable').innerHTML = ''; return; }

  /* P2-4 的月度花费卡在这里画，**必须在任何早退之前** —— 报告库里一条都没有时，
     下面的表格分支会直接 return（那是"没有报告"的分支），而月度花费和"有没有报告"
     完全无关：广告报告是导入的，报告库是生成的。放晚了就会出现"数据取到了、卡片空白"，
     我第一次就写成放在函数末尾，真机上验证时看到的是空的。 */
  renderReportSpend();

  /* Fill the kind select from the payload. Rebuilt only when the set changed,
     so an open dropdown is not replaced on every 3s poll. */
  const kindIds = (data.kinds || []).map(entry => entry.id).join(',');
  if ($('rpKind').dataset.filled !== kindIds) {
    $('rpKind').innerHTML = '<option value="">全部类型</option>'
      + (data.kinds || []).map(entry => '<option value="' + escapeHtml(entry.id) + '">'
        + escapeHtml(entry.label) + '（' + entry.count + '）</option>').join('');
    $('rpKind').dataset.filled = kindIds;
  }
  $('rpKind').value = data.filters.kind || '';
  $('rpStatus').value = data.filters.status || 'all';
  $('rpAsin').value = data.filters.asin || '';
  $('rpMarket').value = data.filters.marketplace || '';
  $('rpSince').value = data.filters.since || '';
  $('rpFav').checked = data.filters.favorite === true;

  /* The three facet selects: options come from the values that actually occur,
     so a select cannot offer a filter the store has no row for. */
  const fill = (id, values, allLabel, selected) => {
    const key = id + ':' + values.join(',');
    if ($(id).dataset.filled !== key) {
      $(id).innerHTML = '<option value="">' + allLabel + '</option>'
        + values.map(v => '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>').join('');
      $(id).dataset.filled = key;
    }
    $(id).value = selected || '';
  };
  const facets = data.facets || {};
  fill('rpProductLine', facets.productLines || [], '全部产品线', data.filters.productLine);
  fill('rpCreatedBy', facets.creators || [], '全部创建者', data.filters.createdBy);
  fill('rpTag', facets.tags || [], '全部标签', data.filters.tag);

  /* The build controls: the eight generated kinds, from the payload. The three
     indexed kinds are not in this list because nothing can build them — they are
     written by the work that produces them. */
  const buildable = data.buildable || [];
  const buildIds = buildable.map(entry => entry.id).join(',');
  if ($('rpBuildKind').dataset.filled !== buildIds) {
    $('rpBuildKind').innerHTML = buildable
      .map(entry => '<option value="' + escapeHtml(entry.id) + '">' + escapeHtml(entry.label) + '</option>').join('');
    $('rpBuildKind').dataset.filled = buildIds;
  }
  const needsAsin = $('rpBuildKind').value === 'asin-health' || $('rpBuildKind').value === 'competitor-gap';
  $('rpBuildAsin').style.display = needsAsin ? '' : 'none';
  $('rpBuildMarket').style.display = needsAsin ? '' : 'none';
  $('rpBuildHint').textContent = needsAsin
    ? '这一类是「一条 ASIN」的报告，必须填 ASIN 与站点'
    : '生成的那一刻冻结；同一天同一范围重跑是更新当天那一份';

  const counts = data.counts || {};
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + '">'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + '</span>';
  const byStatus = data.byStatus || {};
  $('rpstats').innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('库内共', counts.total ?? 0)
    + (data.kinds || []).map(entry => chip(entry.label, entry.count, entry.count ? 'ok' : '')).join('')
    + '</div>'
    + '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('可取回', byStatus.ready ?? 0, (byStatus.ready ? 'ok' : ''))
    + chip('取不回', byStatus.unopenable ?? 0, (byStatus.unopenable ? 'warn' : ''))
    + chip('已归档', byStatus.archived ?? 0)
    + chip('收藏', counts.favorites ?? 0)
    + chip('本次命中', data.matched ?? 0)
    + '</div>';

  const filtered = data.rows.length !== data.total;

  if (data.rows.length === 0) {
    /* Four different emptiness, said four different ways. Before F14-01 all of
       them read as one sentence, and the sentence that matters most — "this kind
       has a writer and nobody has run it yet" — did not exist. */
    const kindFilter = data.filters.kind || '';
    const kindRow = (data.kinds || []).find(entry => entry.id === kindFilter);
    let sentence;
    if (data.total === 0) {
      sentence = '库内还没有任何报告。<br>两条路都能让它出现：'
        + '① 索引类由产生它的那一步登记 —— 跑一次优化收尾（<code>amzn_optimize_save</code>）或让关键词总库出表；'
        + '② 生成类用上面那排<strong>生成报告</strong>按钮（或 <code>amzn_report_build</code>）。<br>'
        + '这不是「本仓不支持报告」：' + (data.kinds || []).length + ' 个类别每一个都登记了写入方。';
    } else if (kindFilter !== '' && kindRow !== undefined && kindRow.count === 0) {
      sentence = '库内有 ' + data.total + ' 条报告，但<strong>这一类一条都没有</strong>：'
        + escapeHtml(kindRow.label) + '。<br>这不是「筛选条件太窄」—— 是这一类还没被生成过。'
        + '写入方：<code>' + escapeHtml(kindRow.writer) + '</code>。';
    } else if (data.filters.status === 'archived' && (byStatus.archived ?? 0) === 0) {
      sentence = '库里<strong>没有已归档的报告</strong>。<br>这是一次真实的读取结果：'
        + '归档不改正文、不删行，只是给行盖一个时间戳（「已归档」）。';
    } else {
      sentence = '这个筛选条件下没有报告。<br>放宽条件再试 —— 不要把它读成「库里没有报告」：'
        + '库内共 ' + data.total + ' 条' + (data.matched !== undefined ? '，本条件命中 ' + data.matched + ' 条' : '') + '。';
    }
    $('rptable').innerHTML = '<div class="empty">' + sentence + '</div>';
    $('rpdetail').innerHTML = '';
    return;
  }

  /* Six columns, and the fifth carries the **recomputed** status plus the two
     flags. Widening the table for star/tags would push a terminal row past what
     it can hold, and the flags are usually empty. */
  const statusCell = (row) => {
    const parts = ['<span class="chip ' + (row.status === 'ready' ? 'ok' : (row.status === 'unopenable' ? 'warn' : '')) + '">'
      + escapeHtml(row.statusLabel || row.status) + '</span>'];
    if (row.favorite) parts.push('<span class="chip">★</span>');
    if (Array.isArray(row.tags) && row.tags.length > 0) {
      parts.push(row.tags.map(tag => '<span class="chip">#' + escapeHtml(tag) + '</span>').join(''));
    }
    return parts.join(' ');
  };
  const actions = (row) => {
    const bits = [];
    if (row.url) {
      bits.push('<a href="' + escapeHtml(row.url) + '" target="_blank" rel="noreferrer">打开 ↗</a>');
    } else if (!row.openable) {
      bits.push('<span class="chip warn">取不回</span>');
    } else if (row.path) {
      bits.push('<code title="' + escapeHtml(row.path) + '">' + escapeHtml(shortPath(row.path)) + '</code>');
    }
    const exports = reportExportBits(row);
    if (exports !== '') bits.push(exports);
    bits.push('<button data-rp-fav="' + escapeHtml(row.id) + '" data-rp-on="' + (row.favorite ? '0' : '1') + '">'
      + (row.favorite ? '取消收藏' : '收藏') + '</button>');
    bits.push('<button data-rp-arch="' + escapeHtml(row.id) + '" data-rp-on="' + (row.archivedAt ? '0' : '1') + '">'
      + (row.archivedAt ? '恢复' : '归档') + '</button>');
    bits.push('</div>');
    return '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">' + bits.join('');
  };

  /* 列宽策略（R2-07 / T60-5）：table-layout:fixed + 显式 colgroup。自动布局下
     「打开 / 操作」里的路径文本会把整表撑出容器，最右的 id 列就被裁掉了 ——
     裁的是**表头**，读者连列名都认不出来。fixed 布局下列宽由 colgroup 决定，
     长路径按字符折行（overflow-wrap:anywhere 继承给每个格子），id 列固定 96px
     且不折行，1440 内不再横向裁切。列宽是这份表格的**策略**，不是市场事实。 */
  $('rptable').innerHTML = '<table style="table-layout:fixed;width:100%;overflow-wrap:anywhere">'
    + '<colgroup><col style="width:92px"><col style="width:88px"><col style="width:14%">'
    + '<col><col style="width:132px"><col style="width:30%"><col style="width:96px"></colgroup>'
    + '<thead><tr><th>时间</th><th>类型</th><th>范围</th>'
    + '<th>标题</th><th>状态</th><th>打开 / 操作</th><th title="报告 id（完整值在行里悬停）" style="white-space:nowrap">id</th></tr></thead><tbody>'
    + data.rows.map(row => {
      return '<tr data-report="' + escapeHtml(row.id) + '">'
        + '<td>' + escapeHtml(shortTime(row.createdAt)) + '</td>'
        + '<td>' + escapeHtml(row.kindLabel || row.kind) + '</td>'
        + '<td>' + escapeHtml(row.scopeLine || '—') + '</td>'
        + '<td title="' + escapeHtml(row.title || '') + '">' + escapeHtml(row.title || '—')
        + (row.createdBy ? '<br><span class="hint" style="padding:0">创建者 ' + escapeHtml(row.createdBy) + '</span>' : '')
        + '</td>'
        + '<td>' + statusCell(row) + '</td>'
        + '<td>' + actions(row) + '</td>'
        + '<td style="white-space:nowrap"><code title="' + escapeHtml(String(row.id)) + '">'
        + escapeHtml(String(row.id).slice(0, 8)) + '</code></td>'
        + '</tr>';
    }).join('')
    + '</tbody></table>'
    + '<div class="hint">显示 ' + data.rows.length + ' / ' + data.total + ' 条'
    + (filtered ? '（已筛选）' : '')
    + ' · 报告正文与索引分开存放，所以「列表里有」和「点得开」是两件事，这一页把两件都说了。'
    + ' · 「导出」的每一档可用性与地址都由服务端下发，点不动的那一个把<strong>理由</strong>写在悬停提示里 ——'
    + ' 它不是坏了，是这一类报告没有那一档（例如文件类报告的正文就是磁盘上那个文件本身）。'
    + (Array.isArray(data.facets && data.facets.creators) && data.facets.creators.length === 0
      ? ' · 创建者一栏是空的：' + (data.facets.creatorsUnrecorded || 0) + ' 条报告<strong>没有记录</strong>是谁生成的（不是「本系统没有创建者」）。'
      : '')
    + '</div>';

  renderReportDetail();
}

/* P2-4 月度花费。
   标的是**广告花费**，不是采集成本 —— 采集走本地浏览器，不按次计费，本仓也没有
   记录采集花费的表。这个区别必须印在标题旁边，否则读者会把它当成采集开销。

   口径陷阱在服务端算好了（同一期间多文件覆盖取较大值、ROAS 分母为 0 时是 null、
   读不出月份的行单独列出），这里只负责显示，并且把那些"不算数"的部分也显示出来。 */
function renderReportSpend() {
  const box = $('rpspend');
  if (box === null) return;
  const data = (state.reports || {}).spendMonthly || null;

  if (data === null) {
    box.innerHTML = emptyState('not-recorded', {
      subject: '月度花费数据',
      next: '报告页载荷里没有 spendMonthly —— 交付时漏接了，这不是"还没有数据"。',
    });
    return;
  }

  const head = '<div class="rule-sect">月度花费 · ' + escapeHtml(String(data.subject || '广告花费')) + '</div>';

  if (data.empty === true) {
    box.innerHTML = head + emptyState('not-recorded', {
      subject: '广告报告',
      reason: data.emptyReason || null,
      next: '导入一份后台导出的搜索词报告后，这里会按月汇总花费、销售额与 ROAS。',
    });
    return;
  }

  const money = value => (value === null || value === undefined) ? '—' : value.toFixed(2);
  const rows = data.monthly.map(entry => '<tr>'
    + '<td>' + escapeHtml(String(entry.month)) + '</td>'
    + '<td>' + escapeHtml(money(entry.spend)) + '</td>'
    + '<td>' + escapeHtml(money(entry.sales)) + '</td>'
    + '<td>' + escapeHtml(String(entry.orders)) + '</td>'
    + '<td>' + (entry.roas === null
      ? '<span class="hint" style="padding:0" title="' + escapeHtml(String(entry.roasReason || '')) + '">—</span>'
      : escapeHtml(entry.roas.toFixed(2))) + '</td>'
    + '<td>' + escapeHtml(String(entry.keywords)) + '</td>'
    + '<td>' + (entry.overlappedKeys > 0
      ? '<span class="chip warn">' + escapeHtml(String(entry.overlappedKeys)) + ' 处重叠</span>'
      : '') + '</td>'
    + '</tr>').join('');

  const totals = '<div class="bar" style="flex-wrap:wrap;border-bottom:1px solid var(--line)">'
    + '<span class="chip">' + escapeHtml(String(data.totals.months)) + ' 个月</span>'
    + '<span class="chip">花费 ' + escapeHtml(money(data.totals.spend)) + '</span>'
    + '<span class="chip">销售额 ' + escapeHtml(money(data.totals.sales)) + '</span>'
    + '<span class="chip">订单 ' + escapeHtml(String(data.totals.orders)) + '</span>'
    + '</div>';

  /* 两件"不算数"的事也要说：读不出月份的行、同一期间被多份文件覆盖的量。
     它们不进上面的汇总，所以不能让它们静默消失。 */
  const caveats = [];
  if (Array.isArray(data.undated) && data.undated.length > 0) {
    caveats.push('有 ' + data.undated.length + ' 条广告数据读不出月份（缺 period / first_date / last_date），'
      + '没有计入任何月份，也没有被丢弃。');
  }
  if (data.duplicatedKeys > 0) {
    caveats.push('有 ' + data.duplicatedKeys + ' 个「关键词 × 期间」被多份文件覆盖，已取较大的那份而不是相加 —— '
      + '相加会让同一笔花费算两遍。');
  }

  box.innerHTML = head + totals
    + '<table><thead><tr><th>月份</th><th>花费</th><th>销售额</th><th>订单</th><th>ROAS</th>'
    + '<th>关键词</th><th>口径</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + (caveats.length === 0 ? '' : '<div class="hint">' + escapeHtml(caveats.join(' ')) + '</div>')
    + '<div class="hint">ROAS 显示「—」表示该月花费为 0，比值无意义（不是 0，也不是无穷）。</div>';
}

/* One report, read back. The server hands over the row it read; the page derives
   nothing — no status recomputation, no label table, no URL shape. */
function renderReportDetail() {
  const data = state.reports;
  const id = state.reportFocus || '';
  if (!data || id === '' || !Array.isArray(data.rows)) { $('rpdetail').innerHTML = ''; return; }
  const row = data.rows.find(entry => entry.id === id);
  if (row === undefined) {
    $('rpdetail').innerHTML = '<div class="hint">这一条不在当前筛选结果里 —— 清掉筛选再看。</div>';
    return;
  }
  const lines = [
    '<div class="rule-sect">' + escapeHtml(row.kindLabel || row.kind) + ' · ' + escapeHtml(row.title || '（无标题）') + '</div>',
    '<div class="hint" style="padding:0">id <code>' + escapeHtml(row.id) + '</code> · '
      + escapeHtml(shortTime(row.createdAt)) + ' · ' + escapeHtml(row.statusLabel || row.status)
      + ' · 范围 ' + escapeHtml(row.scopeLine || '—') + '</div>',
  ];
  if (row.archivedAt) {
    lines.push('<div class="hint" style="padding:0">已归档于 ' + escapeHtml(row.archivedAt)
      + ' · ' + escapeHtml(row.archiveReason || '没写原因') + ' · ' + escapeHtml(row.archivedBy || '没记是谁') + '</div>');
  }
  if (row.hasBody) {
    lines.push('<div class="hint" style="padding:0">正文在报告行里（生成类报告的唯一一份）。'
      + '<a href="' + escapeHtml(row.url) + '" target="_blank" rel="noreferrer">在新窗口读全文 ↗</a></div>');
  } else if (row.url) {
    lines.push('<div class="hint" style="padding:0"><a href="' + escapeHtml(row.url) + '" target="_blank" rel="noreferrer">打开这一轮的报告 ↗</a></div>');
  } else if (row.path) {
    lines.push('<div class="hint" style="padding:0">正文是磁盘上的文件：<code>' + escapeHtml(row.path) + '</code></div>');
  } else {
    lines.push('<div class="hint" style="padding:0">⚠️ 正文已经取不回（指针为空）。这一行仍然列出来，因为「报告存在过」不会因为它丢了就消失。</div>');
  }
  /* F14-10：详情面板的导出那一行 —— 与列表同一批按钮（同一个 reportExportBits），
     并把它为什么长这样说出来（服务端下发的 exports.note）。 */
  const exportBits = reportExportBits(row);
  if (exportBits !== '') {
    lines.push('<div class="hint" style="padding:0;display:flex;gap:6px;flex-wrap:wrap;align-items:center">'
      + '<span>导出：</span>' + exportBits + '</div>');
  }
  if (row.exports && row.exports.note) {
    lines.push('<div class="hint" style="padding:0">' + escapeHtml(row.exports.note) + '</div>');
  }
  lines.push('<div style="margin-top:6px"><input type="search" id="rpTags" placeholder="标签，逗号分隔" value="'
    + escapeHtml(Array.isArray(row.tags) ? row.tags.join(', ') : '') + '">'
    + ' <button id="rpTagsSave">保存标签</button>'
    + ' <button id="rpDetailClose">收起</button></div>');
  $('rpdetail').innerHTML = lines.join('');
  $('rpTagsSave').onclick = () => saveReportTags(row.id, $('rpTags').value);
  $('rpDetailClose').onclick = () => { state.reportFocus = ''; renderReportDetail(); };
}

/** The tail of a path — enough to recognise the file without a 90-char cell. */
function shortPath(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? String(path) : '…/' + parts.slice(-2).join('/');
}

/* ── the settings surface (B07) ───────────────────────────────────────── */

/* F12-04：§5 任务类型的显示文本。⚠️ **未声明就逐字画「未声明」**，不折算成任何一类 ——
   给缺失造一个像数据的替身是本仓铁律里最贵的那条。标签表由服务端下发
   （state.agent.taskTypeLabels，源头是 domain/agent/roles.js），页面**不写第二份** ——
   「一句事实活在两个文件里」是本仓招牌缺陷。
   「未声明」**不等于**任何一个中文标签：测试钉住这一点。 */
function agentTaskTypeText(taskType, labels) {
  if (taskType === null || taskType === undefined) return '未声明';
  const table = labels || {};
  return table[taskType] === undefined ? String(taskType) : table[taskType];
}

/* 模块 12 的任务画布（§9）。
 *
 * 画的是**留痕**：每次运行的目标与范围、四样快照、步骤图与耗时、产物、人工决策、
 * 日志与错误。这一版不画编排控件（没有「从这里重跑」按钮）—— 编排由会话侧的
 * DSH Agent 做，这一页负责让人看清它做了什么、卡在哪。一个只能看不能改的页面是
 * 诚实的第一版：能改但改了不生效才是假的。
 *
 * 停在 waiting_human 的运行，等什么写在运行头上（§11：必须说明等待什么）；门禁的
 * 批准/驳回按钮把裁决记下来 —— 那是这一版唯一能从页面发出的写。 */`
