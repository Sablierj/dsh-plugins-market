/**
 * 页签「optimize」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const optimizeScript = `/* ── 1366 底栏（R2-02 / T60-4）────────────────────────────────────────────
   1366×768 下这一页的主操作（预检 / 策略 / 草案校验 / 发布登记）在首屏之外，
   R2-02 的处方是「固定/粘性底栏，或首屏放主按钮」。这里做成**粘底定位栏**：
   它自己就是 sticky 元素（bottom:0，挂在 panel 末尾，包含块是整个 panel），
   滚动经过这一页时一直贴在视口底边，一键跳到各主操作所在的分区（sect-* 是
   page.js 的跳转目标约定）。样式全部内联 —— page.js 的 CSS 归 T61 写域，本轮不动。
   ⚠️ 不复制任何提交按钮：主操作按钮与各自表单的处理函数绑在一起，复制一份就是
   两份绑定、两处会漂。这一栏只做**定位**，不做第二条提交路径。
   ⚠️ 壳（含 id=optActionBar 与它的样式）是**随脚本下发的 HTML**，JS 只填内容和
   绑事件 —— 全量套件里那条「脚本伸手要的 id 必须在标记里」的守卫看的是整份下发
   文档里的 id 字面量，壳写进 HTML 它才算数；先造一个元素再按 id 找，等于伸手要一个
   标记里没有的元素（上一版就是这么红的，红得对）。
   ⚠️ 这一页的注释里不许出现「run.某词」形态的字样（文件名也算）：payload 守卫把
   整段脚本（注释也算）扫一遍，会当成「页面读了 run 的那个字段」去 payload 里查。 */
function optimizeActionBar() {
  const panel = $('panel-optimize');
  if (panel === null) return;
  if ($('optActionBar') === null) {
    panel.insertAdjacentHTML('beforeend', '<div id="optActionBar" style="position:sticky;bottom:0;z-index:3;'
      + 'background:var(--panel);border-top:1px solid var(--line);padding:8px 14px;display:flex;gap:8px;'
      + 'flex-wrap:wrap;align-items:center"></div>');
  }
  const bar = $('optActionBar');
  const jump = (section, label) => '<button type="button" data-optjump="' + section + '"'
    + ' style="padding:4px 10px">' + escapeHtml(label) + '</button>';
  bar.innerHTML = '<strong style="font-size:12px">主操作定位</strong>'
    + jump('sect-precheck', '预检（九项）')
    + jump('sect-strategy', '策略')
    + jump('sect-inbox', '草案与校验')
    + jump('sect-delivery', '交付')
    + jump('sect-publication', '发布登记')
    + '<span class="hint" style="padding:0">1366 宽时主操作在首屏之外（R2-02）；这排按钮一键到各分区。'
    + '提交按钮仍在各自的表单里，这里不做第二条提交路径。</span>';
  for (const button of bar.querySelectorAll('button[data-optjump]')) {
    button.onclick = () => {
      const target = $(button.dataset.optjump);
      if (target !== null && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
    };
  }
}

/* F-4：优化页自带 ASIN 选择 —— PRD 的 G-2「进入主流程点击 ≤5」。
   从前选 ASIN 必须去 ASIN 库点一行再回来（+2 点击、两次页面跳转）；这一块把它变成
   0 次跳转：选完就地出九项预检（服务端按 filters.asin 重算，页面只画）。
   它与**全局选中集**是同一个：选中的 ASIN 写进 selection.asins，别的页面看到的
   「当前 ASIN」也是它 —— 两个地方各有一个「当前 ASIN」是本仓最贵的一类错。
   ⚠️ 这一页的注释里不许出现「run.某词」形态的字样（payload 守卫会扫整段脚本）。 */
function optimizeAsinPicker() {
  const panel = $('panel-optimize');
  if (panel === null) return;
  if ($('optAsinPickBox') === null) {
    panel.insertAdjacentHTML('afterbegin',
      '<div id="optAsinPickBox" style="padding:8px 14px;border-bottom:1px solid var(--line)"></div>');
  }
  const box = $('optAsinPickBox');
  if (box === null) return;
  /* 候选挂在 state.optimizations.asinOptions 上，不另开顶层 state 键：页面读的每个
     state 字段都必须有赋值，而赋值那一列在 page.js 的 refresh 里 —— 不在本单写域。
     （注意：那条守卫连注释一起扫，所以这句里**不能**出现「state 点某个字母」的字样，
     否则它会把注释里的示范当成一个真的读取 —— 实测红过一次。）
     挂在已赋值的 optimizations 下，守卫的口径不变。 */
  const read = state.optimizations ? state.optimizations.asinOptions : null;
  const current = String((state.filters || {}).asin || '').trim();

  /* 没下发（非优化模块 / 老载荷）—— 说「没取到」，不画一个空下拉。 */
  if (read === null || read === undefined) {
    box.innerHTML = '<span class="hint" style="padding:0">ASIN 候选这一次没有下发 —— '
      + '「没取到」不是「库里没有」，重新读取一次再看。</span>';
    return;
  }
  const rows = Array.isArray(read.rows) ? read.rows : [];
  if (rows.length === 0) {
    /* 空库不是空下拉：一个没有选项的下拉读起来像坏了，而真相是「还没有东西可选」。 */
    box.innerHTML = '<div class="bar"><strong style="font-size:12px">选一个 ASIN 来优化</strong>'
      + '<span class="hint" style="padding:0">库里还没有 ASIN —— 先去「采集器」采一个，或到「ASIN 数据管理」导入。</span>'
      + '<button type="button" data-optgo="collect" style="margin-left:auto">去采集器 →</button></div>';
    const go = box.querySelector('button[data-optgo]');
    if (go !== null) go.onclick = () => patchContext({ module: 'collect' });
    return;
  }

  const options = rows.map(row => '<option value="' + escapeHtml(row.asin) + '@' + escapeHtml(row.marketplace) + '"'
    + (row.asin === current ? ' selected' : '') + '>'
    + escapeHtml(row.asin) + ' · ' + escapeHtml(row.marketplace)
    + (row.title ? ' · ' + escapeHtml(String(row.title).slice(0, 40)) : '')
    + '</option>').join('');
  const truncated = read.total > rows.length
    ? '<span class="opt-meta">下拉里只有前 ' + rows.length + ' 条（库里共 ' + read.total
      + ' 条）—— 要用别的先去 ASIN 库筛选，这里不静默截断。</span>'
    : '';
  box.innerHTML = '<div class="bar"><strong style="font-size:12px">选一个 ASIN 来优化</strong>'
    + '<select id="optAsinPick" style="min-width:300px"><option value="">（选一个 ASIN）</option>'
    + options + '</select>'
    + '<span class="hint" style="padding:0">选完这里直接出九项预检，不用去 ASIN 库来回跑。'
    + '这个选择与全局上下文是同一个 —— 别的页面看到的「当前 ASIN」也是它。</span>'
    + truncated + '</div>';

  const select = $('optAsinPick');
  if (select !== null) select.onchange = () => pickOptimizeAsin(String(select.value || ''));
}

/* 选中一个 ASIN：写筛选（服务端据此重算九项预检）+ 写全局选中集（同一件事只留一个答案）。 */
function pickOptimizeAsin(value) {
  const raw = String(value || '');
  if (raw === '') return;
  const cut = raw.lastIndexOf('@');
  const asin = cut === -1 ? raw : raw.slice(0, cut);
  const marketplace = cut === -1 ? String((state.filters || {}).marketplace || '') : raw.slice(cut + 1);
  if (asin === '') return;
  const nextFilters = { ...(state.filters || {}), asin };
  if (marketplace !== '') nextFilters.marketplace = marketplace;
  patchContext({
    /* 与 ASIN 库点一行是同一个形状（见 collect.js 的同一条调用）：全局只有一份「当前 ASIN」。 */
    selection: { asins: [{ asin, marketplace: marketplace === '' ? null : marketplace }] },
    filters: nextFilters,
  });
}

/* F-7 第一块：开跑的结果。它是**页面自己的**一次交互状态（不是服务端事实），所以住在
   脚本里而不是载荷里；刷新整页时它会被重新画，但不清空 —— 刚点完就看不见结果，
   就等于「点了没反应」。 */
let optimizeStartState = null;

/* 开跑按钮：能不能点，由**九门预检的同一个判定**决定（服务端算出来的 blocked 那个布尔），
   页面不自己再算一遍 —— 两套判定会出现「按钮能点、后端拒绝」。
   阻断时不靠「点了才报错」：按钮 disabled，并把**哪几门**阻断写在旁边。 */
function optimizeRunBox(data) {
  const host = $('sect-precheck');
  if (host === null) return;
  if ($('optRunBox') === null) {
    host.insertAdjacentHTML('beforeend', '<div id="optRunBox" style="padding:0 0 10px 0"></div>');
  }
  const box = $('optRunBox');
  if (box === null) return;

  const asin = String((state.filters || {}).asin || '').trim();
  const report = data ? (data.precheck ?? null) : null;
  const blocked = report !== null && report !== undefined && report.blocked === true;
  const blocking = blocked
    ? (Array.isArray(report.gates) ? report.gates : []).filter(gate => gate.verdict === 'block')
    : [];

  const parts = [];
  parts.push('<div class="bar" style="flex-wrap:wrap">');

  if (asin === '') {
    /* 没选 ASIN：说清下一步，不画一个 disabled 了却不解释为什么的按钮。 */
    parts.push('<button type="button" data-optstart="1" disabled>开跑这一轮</button>');
    parts.push('<span class="hint" style="padding:0">先在上面「选一个 ASIN 来优化」—— 选完这里才有一轮的九项判定。</span>');
  } else if (report === null || report === undefined) {
    /* 选了但还没有判定：开跑前的九门必须先看到，所以这里也不让点。 */
    parts.push('<button type="button" data-optstart="1" disabled>开跑这一轮</button>');
    parts.push('<span class="hint" style="padding:0">这一轮的九项预检还没出来 —— 开跑前必须先看到判定，'
      + '否则「跑起来了才发现少东西」。等一下或重新读取。</span>');
  } else if (blocked) {
    parts.push('<button type="button" data-optstart="1" disabled>开跑这一轮（被阻断）</button>');
    parts.push('<span class="chip stop">阻断 ' + blocking.length + ' 门</span>');
    parts.push('<span class="hint" style="padding:0">下面这 '
      + (blocking.length === 0 ? '几门' : blocking.length + ' 门') + ' 挡住了，补齐再开跑：</span>');
    parts.push('<ul class="opt-meta" style="margin:2px 0 0 16px;padding:0">'
      + blocking.map(gate => '<li>' + escapeHtml(String(gate.label || gate.id || '（未命名的门槛）'))
        + (gate.criterion ? ' —— ' + escapeHtml(String(gate.criterion)) : '') + '</li>').join('')
      + '</ul>');
  } else {
    parts.push('<button type="button" class="primary" data-optstart="1">开跑这一轮</button>');
    parts.push('<span class="hint" style="padding:0">九项都过了（'
      + escapeHtml(String((report.counts && report.counts.pass) || 0)) + ' 通过 / '
      + escapeHtml(String((report.counts && report.counts.degrade) || 0)) + ' 降级 / '
      + escapeHtml(String((report.counts && report.counts.block) || 0)) + ' 阻断）。'
      + '开跑后这一轮会出现在下面的轮次表里，策略确认在「策略」分区。</span>');
  }

  /* 上一次开跑的结果 —— 成功要有轮次 id 与状态，失败要有原因。 */
  if (optimizeStartState !== null) {
    const mark = optimizeStartState.phase;
    if (mark === 'running') {
      parts.push('<span class="chip warn" data-optstart-state="running">正在建这一轮…</span>');
    } else if (mark === 'ok') {
      parts.push('<span class="chip ok" data-optstart-state="ok">已开跑 · 轮次 '
        + escapeHtml(String(optimizeStartState.runId ?? '（没读到 id）')) + ' · '
        + escapeHtml(String(optimizeStartState.status ?? '状态未给出')) + '</span>');
    } else if (mark === 'failed') {
      parts.push('<span class="chip stop" data-optstart-state="failed">开跑失败：'
        + escapeHtml(String(optimizeStartState.error ?? '原因未给出')) + '</span>');
    }
  }
  parts.push('</div>');
  box.innerHTML = parts.join('');

  /* 用 querySelectorAll 取按钮（仓里通行写法）：host 侧的测试桩也只提供这一个面，
     querySelector 只有真实 DOM 有 —— 页面不该依赖桩没有的那一半。 */
  const buttons = box.querySelectorAll('button[data-optstart]');
  const button = buttons.length > 0 ? buttons[0] : null;
  if (button !== null && button.disabled !== true) {
    button.onclick = () => startOptimizeRun();
  }
}

/* 点「开跑」：POST 到 optimize-prepare。路由调的是同一个工具，所以这里**不做**任何
   参数校验 —— 页面只负责把当前筛选（ASIN / 站点 / 模式 / 专项）交上去。 */
function startOptimizeRun() {
  const filters = state.filters || {};
  const asin = String(filters.asin || '').trim();
  if (asin === '') return;
  const data = state.optimizations || {};
  const body = { asin, marketplace: String(filters.marketplace || 'US').trim().toUpperCase() };
  if (data.mode) body.mode = data.mode;
  if (data.scope) body.scope = data.scope;
  optimizeStartState = { phase: 'running' };
  renderOptimizations();
  api('optimize-prepare', { method: 'POST', body: JSON.stringify(body) })
    .then(payload => {
      optimizeStartState = payload && payload.ok === true
        ? { phase: 'ok', runId: payload.runId, status: payload.status }
        : { phase: 'failed', error: (payload && payload.error) || '服务端没有给出原因' };
      renderOptimizations();
      /* 成功了才重新读一遍：新的轮次要出现在轮次表里，而不是只出现在这一行状态上。
         refresh 是页面自己的异步读取，它失败不该反过来把「已开跑」变成「失败」。 */
      if (optimizeStartState.phase === 'ok') {
        try { Promise.resolve(refresh()).catch(() => {}); } catch { /* 读取失败与开跑结果无关 */ }
      }
    })
    .catch(error => {
      optimizeStartState = { phase: 'failed', error: error.message || String(error) };
      renderOptimizations();
    });
}

let ftWired = false;
/* 待确认的提案版本号 —— 由 renderFieldTemplate 填，确认按钮读它。 */
let ftProposedVersion = 0;

function renderOptimizations() {
  /* R-91：字段模板那四颗按钮的接线只做一次（幂等由 bind 前的 renderFieldTemplate 刷新承担）。 */
  /* 用脚本作用域的变量而不是 window：页面脚本也会在 node 的测试沙箱里被 eval，window 在那里不存在。 */
  if (!ftWired) { ftWired = true; wireFieldTemplate(); }
  const data = state.optimizations;
  const runs = data ? data.rows : [];
  const run = data ? data.run : null;

  /* F-4：选择入口挂在所有 return 之前 —— 「一场都还没跑过」正是最需要它的时刻
     （选完才可能跑第一场）。 */
  optimizeAsinPicker();

  /* 模块 14 §6-§9 的三块先画：它们不依赖优化轮次 —— 一条手工登记（kind=manual）
     可以没有任何 run，却仍然要在这里看得见。后面几处 return 都在这行之后。 */
  renderPublicationClosure(data);
  /* F13-02 / F13-04 的前置门槛与模式选择也要在那些 return 之前画：一场还没有开过
     任何轮次的 ASIN，正是最需要看「九项差哪几项」的时候。放在 return 之后，它会
     只在「已经跑过一轮」时才出现 —— 而那正好是最不需要它的时刻。 */
  renderPrecheck(data);
  /* F-7：开跑按钮紧贴九项预检（它读的就是那九门的判定），同样挂在所有 return 之前 ——
     「一场都还没跑过」正是要开第一场的时刻。 */
  optimizeRunBox(data);
  /* 底栏挂在所有 return 之前：空态 / 未选轮次时它同样该在 —— 那正是「主操作找
     不到」最容易发生的场景。 */
  optimizeActionBar();

  if (runs.length === 0) {
    $('optHint').textContent = '';
    $('optruns').innerHTML = emptyState('not-recorded', {
      subject: '优化轮次',
      /* F-7：开跑已经有页面入口（预检下面的「开跑这一轮」按钮，走 optimize-prepare
         路由、调的是同一个工具）。文案明写**事实状态**：有按钮就说有按钮 ——
         不许留下一个既不说「靠对话」、也不给按钮的悬空状态。 */
      next: '先在上面「选一个 ASIN 来优化」—— 选完这里就出九项预检。开跑这一步现在有页面按钮：'
        + '九门都过了就点预检下面的「开跑这一轮」，这一轮随后出现在下面的轮次表里。'
        + '不用去 ASIN 库来回跑，也不再只能在对话里说。',
    });
    $('optrun').innerHTML = '';
    $('optdrafts').innerHTML = '';
    if ($('optstrategy') !== null) $('optstrategy').innerHTML = '';
    if ($('optplancheck') !== null) $('optplancheck').innerHTML = '';
    for (const id of VALIDATION_PANEL_IDS) if ($(id) !== null) $(id).innerHTML = '';
    if ($('optdelivery') !== null) $('optdelivery').innerHTML = '';
    return;
  }

  $('optHint').textContent = '共 ' + data.total + ' 轮，显示最近 ' + runs.length + ' 轮 · 报告在 save 时生成，只校验过的轮次没有报告';

  $('optruns').innerHTML = '<table><thead><tr><th>轮次</th><th>ASIN</th><th>站点</th>'
    + '<th>状态</th><th>字段</th><th>校验</th><th>开始</th></tr></thead><tbody>'
    + runs.map(row => '<tr data-run="' + escapeHtml(row.id) + '" class="' + (run !== null && row.id === run.id ? 'sel' : '') + '">'
      + '<td><code>' + escapeHtml(String(row.id).slice(0, 8)) + '</code></td>'
      + '<td>' + escapeHtml(row.asin || '—') + '</td>'
      + '<td>' + escapeHtml(row.marketplace || '—') + '</td>'
      + '<td>' + statusChip(row.status) + '</td>'
      + '<td>' + (row.draftCount || '') + '</td>'
      + '<td>' + (run !== null && row.id === run.id ? violationChips(run.counts) : '') + '</td>'
      + '<td>' + escapeHtml(shortTime(row.startedAt)) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';

  for (const tr of $('optruns').querySelectorAll('tbody tr')) {
    tr.onclick = () => patchContext({ filters: { ...state.filters, runId: tr.dataset.run } });
  }

  /* A runId filter survives in the context after the run is gone. Saying so is
     better than drawing the empty panel, which would claim there are no runs. */
  if (run === null) {
    $('optrun').innerHTML = '<div class="hint">选中的那一轮已经不在了。点上面任意一轮换过去。</div>';
    $('optdrafts').innerHTML = '';
    if ($('optstrategy') !== null) $('optstrategy').innerHTML = '';
    if ($('optplancheck') !== null) $('optplancheck').innerHTML = '';
    for (const id of VALIDATION_PANEL_IDS) if ($(id) !== null) $(id).innerHTML = '';
    if ($('optdelivery') !== null) $('optdelivery').innerHTML = '';
    return;
  }

  $('optrun').innerHTML = '<div class="bar">'
    + '<strong style="font-size:12px">' + escapeHtml(run.asin || '—') + ' ' + escapeHtml(run.marketplace || '') + '</strong>'
    + statusChip(run.status)
    + violationChips(run.counts)
    + (run.gates ? '<span class="chip ' + (run.gates.ok ? 'ok' : 'warn') + '">闸门 ' + run.gates.passed + '/' + run.gates.total + '</span>' : '')
    + '<span class="opt-meta">规则 ' + escapeHtml(run.rulesVersion || '—') + '</span>'
    + '<span style="margin-left:auto">'
    + (run.hasReport && data.reportUrl
      ? '<a href="' + escapeHtml(data.reportUrl) + '" target="_blank" rel="noreferrer">打开报告 ↗</a>'
      : '<span class="opt-meta">还没有报告（save 后生成）</span>')
    + '</span></div>'
    + (run.summary ? '<div class="hint">' + escapeHtml(run.summary) + '</div>' : '')
    + siteBlock(run)
    + coverageBlock(run);

  renderEvidence(data);
  /* F13-05 / F13-06：策略卡与位置计划核对。两块都在「选中的那一轮」这一层上，
     与证据包同款 —— 没有轮次时它们各自画自己的「没选一轮」。 */
  renderStrategy(data);
  renderPlanCheck(data);
  /* F13-08 / F13-09：校验体系三块面板与交付边界。同样是「选中的那一轮」这一层。
     闸门面板接手了以前画在这里的 gateBlock —— 同一份判据不再有两个渲染点。 */
  renderValidation(data);
  renderDelivery(data);

  if (run.drafts.length === 0) {
    if ($('optinbox') !== null) $('optinbox').innerHTML = '';
    $('optdrafts').innerHTML = emptyState('not-recorded', {
      subject: '被校验过的字段',
      next: '这一轮先生成草案，再跑一次 amzn_optimize_validate —— 没校验过的字段没有违规清单可看。',
    });
    return;
  }

  /* ── F13-01 草案收件箱 ──────────────────────────────────────────────────────
     A 待办 row says "3 条草案等着决定" and carries the filter that means exactly
     that. Without honouring it here the link lands on the run with every draft —
     including the ones already decided — so the reader counts to three by hand.
     The bar is not decoration: the filter rides in the page's shared filter bag,
     so it survives a nav click, and a reader who did not ask for it needs to see
     it is on and be able to turn it off.

     两个维度分开：draftStatus 是五态分组（+ 老链接里的 orphan），draftContext
     是上下文（当前 / 已变化 / 没有）。两个都用同一个 buckets，所以判据只有一份。

     页面**一条状态都不判**：group / buckets / 六个列全部来自服务端。这里只做
     buckets.includes(id) 的成员测试与画。

     NB: no backticks in this comment — this whole file is one template literal. */
  const inbox = data.inbox || null;
  const rawStatus = String((state.filters || {}).draftStatus ?? '').trim();
  const rawContext = String((state.filters || {}).draftContext ?? '').trim();
  /* An unrecognised value means "show everything", not "show nothing". */
  const statusFilter = DRAFT_FILTER_LABELS[rawStatus] === undefined ? '' : rawStatus;
  const contextFilter = DRAFT_FILTER_LABELS[rawContext] === undefined ? '' : rawContext;
  const allDrafts = run.drafts;
  const drafts = allDrafts.filter(draft =>
    draftInBucket(draft, statusFilter) && draftInBucket(draft, contextFilter));
  const budgets = new Map((run.budgets || []).map(row => [row.field, row]));

  if ($('optinbox') !== null) {
    $('optinbox').innerHTML = inbox === null
      ? '<div class="hint">服务端这一次没有给出收件箱切片 —— 分组与筛选都由它算，所以这里不猜。</div>'
      : '<div class="bar" style="flex-wrap:wrap">'
        + inbox.groups.map(group => '<span class="chip' + (group.id === statusFilter ? ' run' : '') + '">'
          + escapeHtml(group.label) + ' ' + group.count + '</span>').join('')
        + '<span class="opt-meta">共 ' + inbox.counts.total + ' 条草案'
        + (inbox.context.available ? '　·　当前上下文 ' + escapeHtml(String(inbox.context.currentId)) : '　·　工作台没有当前上下文')
        + '</span></div>';
  }

  const activeLabels = [statusFilter, contextFilter]
    .filter(value => value !== '')
    .map(value => DRAFT_FILTER_LABELS[value]);
  const bar = activeLabels.length === 0
    ? ''
    : '<div class="bar"><span class="hint">只看「' + escapeHtml(activeLabels.join('」+「'))
      + '」：' + drafts.length + ' / ' + run.drafts.length + ' 条</span>'
      + '<button id="optClearDraftFilter" style="margin-left:auto">看全部</button></div>';

  if (drafts.length === 0) {
    /* 三种空必须长得不一样：分组筛空了 / 上下文筛空了 / 上下文这一项根本没得比。
       最后一种来自服务端的 inbox.empty，因为它才是那个知道有没有当前上下文的人。 */
    const serverSays = inbox !== null && inbox.empty !== null && inbox.empty.kind === 'no-current-context';
    $('optdrafts').innerHTML = bar + (serverSays
      ? sliceEmpty(inbox.empty)
      /* 不是「没有草案」，是「有草案但都在别的分组/别的上下文」—— 那是 filtered，
         不是 not-recorded。原文案自己就写明了这一点。 */
      : emptyState('filtered', {
        subject: '「' + activeLabels.join('」+「') + '」的草案',
        reason: '这一轮没有「' + activeLabels.join('」+「') + '」的草案（' + run.drafts.length + ' 条都在别的分组或别的上下文里）。',
      }));
    if ($('optClearDraftFilter') !== null) $('optClearDraftFilter').onclick = () => clearInboxFilter();
    return;
  }

  $('optdrafts').innerHTML = bar
    + '<table><thead><tr><th>分组</th><th>字段</th><th>对象</th><th>站点</th><th>生成时间</th>'
    + '<th>阻断 / 警告</th><th>待确认项</th><th>审批状态</th><th>行尾</th></tr></thead><tbody>'
    + drafts.map(draft => inboxRowHtml(draft)).join('')
    + '</tbody></table>'
    + '<div class="hint">「阻断」是 Amazon 会拒收或降权的项，「警告」只是偏弱、不影响上架 —— 警告不是不发它的理由。'
    + '这一页只画机检的规则，另有只能由模型判断的检查项（臆造参数、标题与描述互相矛盾等）单列在报告里。</div>'
    + '<div class="rule-sect">逐字段明细</div>'
    + drafts.map(draft => draftCard(draft, budgets.get(draft.field) ?? null)).join('');
  if ($('optClearDraftFilter') !== null) $('optClearDraftFilter').onclick = () => clearInboxFilter();
  for (const button of $('optdrafts').querySelectorAll('button[data-inbox-action]')) {
    button.onclick = () => postInboxAction(button.dataset.inboxAction, button.dataset.runId, button.dataset.field);
  }
  for (const button of $('optdrafts').querySelectorAll('button[data-review-field]')) {
    button.onclick = () => reviewDraft(button.dataset.reviewField);
  }
}

/* ── 模块 14 §6-§9：发布 → 观测 → 下结论 → 回滚 ──────────────────────────────
   三块渲染，全部由 state.optimizations 里的发布切片驱动。空态必须说明「为什么空」：
   「没有观测计划」「观测被偏离未处置挡住」「选中的记录已经不在了」是三种不同的空，
   长得不能一样。

   NB: no backticks in this comment — this whole file is one template string. */

const PUBLICATION_KIND_LABELS = { draft: '草案发布', manual: '手工登记', rollback: '回滚' };
const BASELINE_CHOICE_LABELS = { reobserve: '重新观测这一版', mispublish: '按错发处理' };
const OBSERVATION_STATE_LABELS = {
  waiting_human: '待人工处置（偏离草案）',
  pending: '等待观测节点',
  ready: '可下结论',
  blocked: '数据不足',
  concluded: '已结论',
  terminated: '已回滚终止',
};
const CHECKPOINT_STATE_LABELS = {
  pending: '等待到期',
  ready: '可下结论',
  blocked: '数据不足',
  concluded: '已结论',
  terminated: '已回滚终止',
  retired: '已退出观测窗口',
};

/* 通知链接 '#optimize#observation:<publicationId>' 的 id 段。落点由 scrollToSection
   处理；这里用它判断页面是不是从一条通知跳进来的。解析不出来就返回 null —— 页面
   照常渲染（服务端已经退化成「选中最新一条」），不崩。 */
function observationAnchorId() {
  const match = /^observation:(.+)$/.exec(String((state.filters || {}).anchor ?? '').trim());
  return match === null ? null : (match[1].trim() || null);
}

function renderPublicationClosure(data) {
  const publications = data && Array.isArray(data.publications) ? data.publications : [];
  /* 不是 null 也可能是 undefined：一条老 payload / 别处手搓的切片（s1b13 的草稿
     过滤测试就是）没有这个键。两种都归一成 null，否则展开块会去读
     publication.kind 然后炸掉 —— 一个缺字段不该让整块渲染失败。 */
  const publication = data && data.publication ? data.publication : null;
  if (!data) {
    for (const id of ['optpublications', 'optobservation', 'optrollback']) {
      if ($(id) !== null) $(id).innerHTML = '';
    }
    return;
  }
  renderPublicationList(data, publications);
  renderObservationPanel(data, publication);
  renderRollbackPanel(data, publication);
}

function renderPublicationList(data, publications) {
  const box = $('optpublications');
  if (box === null) return;
  const parts = [];

  const anchorId = observationAnchorId();
  if (anchorId !== null) {
    parts.push('<div class="hint">从通知跳转：选中的是发布记录 <code>' + escapeHtml(anchorId) + '</code> 的观测。</div>');
  }

  if (publications.length === 0) {
    parts.push(emptyState('not-recorded', {
      subject: '发布记录',
      reason: '还没有发布记录。这不代表没改过，只代表改了之后还没人登记。',
      next: '运营在 Seller Central 改完之后，用下面的「登记发布」记一笔；'
        + '没有发布记录时，任何报告都不显示「已上线」。',
    }));
  } else {
    const rate = data.publicationRate;
    if (rate) {
      const ratio = rate.ratio === null || rate.ratio === undefined
        ? '—（无分母）' : Math.round(rate.ratio * 100) + '%';
      parts.push('<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
        + '<span class="chip">发布率 ' + escapeHtml(ratio) + '</span>'
        + '<span class="hint" style="padding:0">' + escapeHtml(String(rate.note || '')) + '</span></div>');
      parts.push('<div class="hint">手工登记<strong>不计入发布率</strong>，也不计算草案差异 ——'
        + '这是规定，不是算漏了。'
        + (rate.manualExcluded > 0 ? '当前已排除 ' + rate.manualExcluded + ' 条。' : '') + '</div>');
    }
    const selectedId = data.selectedPublicationId;
    parts.push('<table><thead><tr><th>时间</th><th>ASIN</th><th>站点</th><th>类型</th>'
      + '<th>草案版本</th><th>偏离</th><th>处置</th><th>观测</th></tr></thead><tbody>'
      + publications.map(row => '<tr data-pub="' + escapeHtml(row.id) + '" class="'
        + (row.id === selectedId ? 'sel' : '') + '">'
        + '<td>' + escapeHtml(shortTime(row.publishedAt)) + '</td>'
        + '<td>' + escapeHtml(row.asin || '—') + '</td>'
        + '<td>' + escapeHtml(row.marketplace || '—') + '</td>'
        + '<td>' + escapeHtml(PUBLICATION_KIND_LABELS[row.kind] || String(row.kind || '—')) + '</td>'
        + '<td>' + (row.draftVersion === null || row.draftVersion === undefined ? '—' : 'v' + row.draftVersion) + '</td>'
        + '<td>' + (row.kind === 'manual' ? '不计算' : (row.deviated ? '已偏离' : '一致')) + '</td>'
        + '<td>' + escapeHtml(row.baselineChoice === null || row.baselineChoice === undefined
          ? ((row.deviated && row.kind !== 'manual') ? '待处置' : '—')
          : (BASELINE_CHOICE_LABELS[row.baselineChoice] || row.baselineChoice)) + '</td>'
        + '<td>' + escapeHtml(OBSERVATION_STATE_LABELS[row.observationState] || String(row.observationState || '—')) + '</td>'
        + '</tr>').join('')
      + '</tbody></table>');
  }

  if (data.publicationGone) {
    parts.push('<div class="hint">选中的发布记录 <code>' + escapeHtml(String(data.selectedPublicationId))
      + '</code> 已经不在了。点上面任意一条换过去。</div>');
  }

  parts.push(publicationForm(data));
  box.innerHTML = parts.join('');

  for (const tr of box.querySelectorAll('tbody tr[data-pub]')) {
    tr.onclick = () => {
      /* 换选一条发布 = 一个更晚的意图，所以顺手把通知锚点丢掉：留着它会让服务端
         继续按锚点选，点谁都不动。 */
      const next = { ...state.filters, publicationId: tr.dataset.pub };
      delete next.anchor;
      patchContext({ filters: next });
    };
  }
  const save = $('pubSave');
  if (save !== null) save.onclick = () => postPublicationForm();
}

/* F13-09 —— 交付边界那条跳转落在这里。
   预填值全部来自服务端 data.publicationPrefill（它从**那一轮的 run 行**读回来）：
   链接里只有 runId，草案版本绝不写进 URL —— amzn_publication_record 要求
   「草案版本必须等于该运行的当前 draft_version」，钉在链接里的版本号会在草案又改过
   之后变成一次注定被拒的登记，而用户会以为是插件坏了。
   prefill.found 为假（那一轮已经不在了）与 prefill 为 null（这一屏不是从跳转来的）
   是两件事：前者要说出来，后者不必说话。 */
function publicationForm(data) {
  const current = data.publication;
  const prefill = data.publicationPrefill === null || data.publicationPrefill === undefined
    ? null
    : data.publicationPrefill;
  const usable = prefill !== null && prefill.found === true ? prefill : null;
  const asin = usable !== null ? usable.asin : (current ? current.asin : '');
  const marketplace = usable !== null
    ? usable.marketplace
    : (current ? current.marketplace : String((state.filters || {}).marketplace || 'US'));
  const runId = usable !== null ? String(usable.runId) : '';
  const draftVersion = usable !== null && usable.draftVersionKnown ? String(usable.draftVersion) : '';
  const published = usable !== null && (usable.fields || []).length > 0
    ? JSON.stringify(Object.fromEntries(usable.fields.map(entry => [entry.field, entry.value])), null, 2)
    : '';
  const note = usable !== null ? usable.note : '';
  return '<div class="bar" style="border-top:1px solid var(--line);flex-wrap:wrap;padding-top:8px">'
    + '<strong style="font-size:12px">登记一次发布</strong>'
    + '<select id="pubKind">'
    + '<option value="draft"' + (usable !== null ? ' selected' : '') + '>草案发布（关联运行）</option>'
    + '<option value="manual">手工登记（不计算差异、不进发布率）</option>'
    + '<option value="rollback">回滚（须指出回滚哪一条）</option>'
    + '</select>'
    + '<input id="pubAsin" type="search" placeholder="ASIN" value="' + escapeHtml(asin) + '">'
    + '<input id="pubMarketplace" type="search" placeholder="站点，如 US" value="' + escapeHtml(marketplace) + '">'
    + '<input id="pubRunId" type="search" placeholder="运行 id（draft 必填）" value="' + escapeHtml(runId) + '">'
    + '<input id="pubDraftVersion" type="number" min="1" placeholder="草案版本（draft 必填）" value="' + escapeHtml(draftVersion) + '">'
    + '<input id="pubRollbackOf" type="search" placeholder="回滚哪条发布 id（rollback 必填）">'
    + '<input id="pubNote" type="search" placeholder="备注（为什么）">'
    + '<button id="pubSave">登记发布</button></div>'
    + (prefill !== null && prefill.found === false
      ? '<div class="hint"><span class="chip warn">跳转目标不在了</span> ' + escapeHtml(String(prefill.note)) + '</div>'
      : '')
    + (usable !== null && usable.draftVersionKnown !== true
      ? '<div class="hint"><span class="chip warn">草案版本读不到</span> '
        + '这一轮的草案版本读不出来（与「版本是 0」不是一件事）—— 登记会被拒，请先确认这一轮的状态。</div>'
      : '')
    + '<div class="hint">实际发布值（JSON，字段名 → 值，例如 {&quot;title&quot;: &quot;新的标题&quot;}）——'
    + '必须是你<strong>真的改了</strong>的那些字段；登记不是「已上线」的证明。'
    + (note === '' ? '' : '<br>' + escapeHtml(String(note))) + '</div>'
    + '<textarea id="pubPublished" rows="6" style="width:100%"'
    + ' placeholder="{&quot;title&quot;: &quot;新的标题&quot;}">' + escapeHtml(published) + '</textarea>';
}

function postPublicationForm() {
  const value = (id) => { const el = $(id); return el === null ? '' : String(el.value || '').trim(); };
  const body = {
    asin: value('pubAsin'),
    marketplace: value('pubMarketplace'),
    kind: value('pubKind') || 'draft',
    runId: value('pubRunId') || null,
    draftVersion: null,
    published: {},
    rollbackOf: value('pubRollbackOf') || null,
    note: value('pubNote') || null,
  };
  const version = value('pubDraftVersion');
  if (version !== '') body.draftVersion = Number(version);
  const raw = value('pubPublished');
  if (raw !== '') {
    try {
      body.published = JSON.parse(raw);
    } catch (error) {
      showPageError(new Error('实际发布值不是合法 JSON：' + error.message));
      return;
    }
  }
  postClosureWrite('publication-record', body);
}

/* 四条闭环写路径共用的提交：POST，然后把服务端的答复读回来再 refresh。拒绝不是
   静默 —— 工具的 error 与 hint 原样上屏。 */
/* R-91（需求方指定）：字段模板那四颗按钮。
   状态行说三件事：现在第几版 / 几个字段 / 有没有待人确认的提案。
   「更新字段模板」这一点**不编字段** —— 它请 AI 会话去搜，产出由 field_template_propose 写回来。 */
/* R-93（需求方：可编辑 / 可增加 / 可删减）：
   字段模板的**逐行编辑表**。三个约束决定了写法：
   1. 整段住在一个模板字符串里 —— 不能出现反引号，也不能出现「美元加大括号」插值；
   2. 页面脚本会在 Node 测试里被 eval —— 不能碰 window；
   3. 不引第三方库 —— 全部 document.createElement 现搭。 */
function ftCell(row, value, type) {
  const cell = document.createElement('td');
  const input = document.createElement('input');
  input.type = type === 'check' ? 'checkbox' : 'text';
  if (type === 'check') input.checked = value === true;
  else input.value = value === undefined || value === null ? '' : String(value);
  input.style.width = '100%';
  cell.appendChild(input);
  row.appendChild(cell);
  return input;
}

function buildFieldEditor(items) {
  const wrap = document.createElement('div');
  const table = document.createElement('table');
  table.className = 'tbl';
  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  const heads = ['序号', '字段 id', '名称', '类型(copy/attribute)', '章节', '必填', '操作'];
  heads.forEach(function (text) {
    const th = document.createElement('th');
    th.textContent = text;
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  const rows = [];

  /* 上移/下移：字段顺序就是模板的顺序（报告里那张对照表的行序），
     而「改顺序」不该逼人删了再重加 —— 那会把这一行的名称/章节一起丢掉。
     做法是把 entry 在 rows 里换位，然后把节点按新顺序重新 append（appendChild 会移动已有节点）。 */
  function renumber() {
    rows.forEach(function (entry, position) {
      if (entry.no) entry.no.textContent = String(position + 1);
    });
  }
  function moveBy(entry, delta) {
    const from = rows.indexOf(entry);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= rows.length) return;
    rows.splice(from, 1);
    rows.splice(to, 0, entry);
    rows.forEach(function (item) { tbody.appendChild(item.tr) });
    renumber();
  }

  function addRow(item, index) {
    const tr = document.createElement('tr');
    const no = document.createElement('td');
    no.textContent = String(index + 1);
    tr.appendChild(no);
    const entry = {
      id: ftCell(tr, item.id, 'text'),
      label: ftCell(tr, item.label, 'text'),
      kind: ftCell(tr, item.kind, 'text'),
      section: ftCell(tr, item.section, 'text'),
      required: ftCell(tr, item.required === true, 'check'),
      removed: false,
      no: no,
      tr: tr,
    };
    const opTd = document.createElement('td');
    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '↑';
    up.title = '上移一位';
    up.addEventListener('click', function () { moveBy(entry, -1) });
    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '↓';
    down.title = '下移一位';
    down.addEventListener('click', function () { moveBy(entry, 1) });
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '删';
    del.addEventListener('click', function () {
      entry.removed = true;
      tr.style.display = 'none';
    });
    opTd.appendChild(up);
    opTd.appendChild(down);
    opTd.appendChild(del);
    tr.appendChild(opTd);
    tbody.appendChild(tr);
    rows.push(entry);
    return entry;
  }

  (items || []).forEach(function (item, index) { addRow(item, index) });

  /* 新增一行：留空给用户填，点「添加」才进表 —— 直接把空行塞进表里会让人以为模板已经多了一个空字段。 */
  const addBar = document.createElement('div');
  addBar.className = 'ft-add';
  const addHint = document.createElement('span');
  addHint.textContent = '新增字段：';
  const addId = document.createElement('input');
  addId.placeholder = '字段 id，例如 title 或 attribute.color';
  const addLabel = document.createElement('input');
  addLabel.placeholder = '名称';
  const addKind = document.createElement('input');
  addKind.placeholder = '类型 copy/attribute';
  const addSection = document.createElement('input');
  addSection.placeholder = '章节';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = '添加';
  addBtn.addEventListener('click', function () {
    const idText = String(addId.value || '').trim();
    if (idText === '') { addId.focus(); return }
    addRow({
      id: idText,
      label: String(addLabel.value || '').trim() || idText,
      kind: String(addKind.value || '').trim() || 'attribute',
      section: String(addSection.value || '').trim() || '其他',
      required: false,
    }, rows.length);
    addId.value = '';
    addLabel.value = '';
    addKind.value = '';
    addSection.value = '';
  });
  [addHint, addId, addLabel, addKind, addSection, addBtn].forEach(function (node) { addBar.appendChild(node) });

  /* 保存按钮和它的状态行来自**下发文档**（#optftSave / #optftSaveStatus），不是这里现建的 ——
     T86-⑧ 守的正是这一点：文案让用户点「保存为新版本」，文档里就得有这个控件。
     每次重画都换一个克隆节点，否则监听会越绑越多（点一次保存提交好几次）。 */
  let save = $('optftSave');
  const saveStatus = $('optftSaveStatus');
  /* 状态行不一定在（旧的下发文档）—— 缺了就不写，别让保存本身因为「没地方显示」而失败。 */
  const say = (text) => { if (saveStatus) saveStatus.textContent = text };
  if (save && save.parentNode) {
    const fresh = save.cloneNode(true);
    save.parentNode.replaceChild(fresh, save);
    save = fresh;
  }
  if (save) save.addEventListener('click', async function () {
    const next = [];
    rows.forEach(function (entry) {
      if (entry.removed) return;
      const idText = String(entry.id.value || '').trim();
      if (idText === '') return;
      next.push({
        id: idText,
        label: String(entry.label.value || '').trim() || idText,
        kind: String(entry.kind.value || '').trim() || 'attribute',
        section: String(entry.section.value || '').trim() || '其他',
        required: entry.required.checked === true,
      });
    });
    if (next.length === 0) { say('至少要留一个字段'); return }
    save.disabled = true;
    say('保存中…');
    try {
      const res = await api('field-template-save', {
        method: 'POST',
        body: JSON.stringify({ items: next, note: '页面逐行编辑' }),
      });
      say((res && (res.text || res.error)) || '已保存');
      await renderFieldTemplate();
    } catch (error) {
      say('保存失败：' + String(error && error.message ? error.message : error));
    } finally {
      save.disabled = false;
    }
  });

  wrap.appendChild(table);
  wrap.appendChild(addBar);
  return wrap;
}

async function renderFieldTemplate() {
  const status = $('optftStatus');
  const body = $('optftBody');
  if (!status || !body) return;
  let data = null;
  try {
    const res = await api('field-template');
    data = res && res.ok === false ? null : res;
  } catch (error) {
    status.textContent = '读不到模板：' + String(error && error.message ? error.message : error);
    return;
  }
  if (data === null || !data.active) {
    status.textContent = '模板还没有生效版本';
    body.textContent = '先在对话里跑一次 amzn_field_template_get，它会从属性登记表种出第一版。';
    return;
  }
  const active = data.active;
  ftProposedVersion = data.proposed === null ? 0 : Number(data.proposed.version);
  /* 这一整段住在一个模板字符串里（optimizeScript），所以下面不能出现反引号、
     也不能出现「美元加大括号」那种插值写法 —— 2026-10-26 我第一次写成模板字符串，
     node --check 立刻报语法错；连注释里写了那种写法也会炸。全部改成字符串相加。 */
  status.textContent = '当前 v' + active.version + ' · ' + active.fields + ' 个字段（必填 ' + active.required + '）'
    + (data.proposed === null
      ? ' · 没有待确认的提案'
      : ' · 提案 v' + data.proposed.version + ' 待确认（' + (data.proposed.diff || '与现役相同') + '）');
  /* R-93：状态行说版本，下面这张表就是**可编辑的字段列表**（读接口 R-93 起返回 items）。 */
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = data.proposed === null
    ? '下面是现役模板的 ' + active.fields + ' 个字段：可以改名称/章节/必填，可以用 ↑↓ 调顺序，可以删行，也可以在底部新增字段；改完点「保存为新版本」—— 旧版保留，可随时回滚。'
    : '提案 v' + data.proposed.version + ' 待确认（' + (data.proposed.diff || '与现役相同') + '）；下面显示的是现役 v' + active.version + '，确认提案之前也能继续逐行编辑。';
  body.textContent = '';
  body.appendChild(hint);
  body.appendChild(buildFieldEditor(active.items || []));
}

/* R-95：属性补齐。表里**只列还缺的那几项** —— 已填的不重复占位置；
   要看全量用 amzn_asin_attribute_status。提交走 asin-attribute-save，
   与工具是同一对函数（页面不内联重算，两套规矩是这类模块最容易长出来的病）。 */
let attrRows = [];

async function renderAttributeFill() {
  const status = $('optattrStatus');
  const body = $('optattrBody');
  const input = $('optattrAsin');
  if (!status || !body) return;
  const asin = input === null ? '' : String(input.value || '').trim().toUpperCase();
  const marketInput = $('optattrMarket');
  const market = marketInput === null || String(marketInput.value || '').trim() === '' ? 'US' : String(marketInput.value).trim().toUpperCase();
  if (asin === '') {
    status.textContent = '先填一个 ASIN，再点「读取属性」';
    body.textContent = '';
    return;
  }
  status.textContent = '读取中…';
  let data = null;
  try {
    data = await api('asin-attributes?asin=' + encodeURIComponent(asin) + '&marketplace=' + encodeURIComponent(market));
  } catch (error) {
    status.textContent = '读不到：' + String(error && error.message ? error.message : error);
    return;
  }
  if (!data || data.ok === false) {
    status.textContent = (data && (data.error || data.hint)) || '读不到这个 ASIN 的属性';
    body.textContent = '';
    return;
  }
  const coverage = data.coverage;
  status.textContent = asin + '@' + market + '：必填属性 ' + coverage.filledCount + ' / ' + coverage.target
    + '（空 ' + coverage.empty.length + ' · 占位 ' + coverage.placeholder.length + '）';
  body.textContent = '';
  attrRows = [];
  if (data.missing.length === 0) {
    body.textContent = '43 项都已有非占位值 —— 这道门不会再降级。';
    return;
  }
  const tbl = document.createElement('table');
  tbl.className = 'tbl';
  const head = document.createElement('tr');
  ['#', '属性 id', '名称', '状态', '值'].forEach(function (text) {
    const th = document.createElement('th');
    th.textContent = text;
    head.appendChild(th);
  });
  tbl.appendChild(head);
  data.missing.forEach(function (row, index) {
    const tr = document.createElement('tr');
    const cells = [
      String(index + 1),
      row.id,
      row.label === null || row.label === undefined ? '（登记表里没有这个名字）' : row.label,
      row.kind,
    ];
    cells.forEach(function (text) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    const valueTd = document.createElement('td');
    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.placeholder = '填值；N/A 与「待定」不算填';
    valueInput.style.width = '100%';
    valueTd.appendChild(valueInput);
    tr.appendChild(valueTd);
    tbl.appendChild(tr);
    attrRows.push({ id: row.id, input: valueInput });
  });
  body.appendChild(tbl);
}

async function saveAttributeFill() {
  const saveStatus = $('optattrSaveStatus');
  const input = $('optattrAsin');
  const asin = input === null ? '' : String(input.value || '').trim().toUpperCase();
  const marketInput = $('optattrMarket');
  const market = marketInput === null || String(marketInput.value || '').trim() === '' ? 'US' : String(marketInput.value).trim().toUpperCase();
  if (asin === '') { if (saveStatus) saveStatus.textContent = '先填 ASIN'; return }
  const values = {};
  let count = 0;
  attrRows.forEach(function (row) {
    const text = String(row.input.value || '').trim();
    if (text === '') return;
    values[row.id] = text;
    count += 1;
  });
  if (count === 0) { if (saveStatus) saveStatus.textContent = '一个值都没填 —— 没有要保存的东西'; return }
  if (saveStatus) saveStatus.textContent = '保存中…';
  try {
    const res = await api('asin-attribute-save', {
      method: 'POST',
      body: JSON.stringify({ asin: asin, marketplace: market, values: values, by: 'page' }),
    });
    if (saveStatus) {
      saveStatus.textContent = res && res.ok === true
        ? '已保存 ' + (res.written || []).length + ' 项 · 现在 ' + res.coverage.filledCount + ' / ' + res.coverage.target
        : ((res && (res.error || res.hint)) || '服务端没有说清楚结果');
    }
    await renderAttributeFill();
  } catch (error) {
    if (saveStatus) saveStatus.textContent = '保存失败：' + String(error && error.message ? error.message : error);
  }
}

function wireAttributeFill() {
  attrRows = [];
  const load = $('optattrLoad');
  if (load) load.addEventListener('click', function () { renderAttributeFill() });
  const save = $('optattrSave');
  if (save) save.addEventListener('click', function () { saveAttributeFill() });
}

function wireFieldTemplate() {
  const bind = (id, route, payload) => {
    const button = $(id);
    if (!button) return;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const res = await api(route, { method: 'POST', body: JSON.stringify(payload()) });
        const status = $('optftStatus');
        if (status) status.textContent = (res && (res.text || res.error)) || '已提交';
        await renderFieldTemplate();
        await renderOptimizations();
      } catch (error) {
        const status = $('optftStatus');
        if (status) status.textContent = '失败：' + String(error && error.message ? error.message : error);
      } finally {
        button.disabled = false;
      }
    });
  };
  bind('optftResearch', 'field-template-research', () => ({}));
  bind('optftConfirm', 'field-template-confirm', () => ({ version: ftProposedVersion }));
  bind('optftRollback', 'field-template-rollback', () => ({}));
  const reload = $('optftReload');
  if (reload) reload.addEventListener('click', () => renderFieldTemplate());
  wireAttributeFill();
  renderFieldTemplate();
}
async function postClosureWrite(route, body) {
  try {
    await api(route, { method: 'POST', body: JSON.stringify(body) });
    clearPageError();
    await refresh();
  } catch (error) {
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  }
}

function renderObservationPanel(data, publication) {
  const box = $('optobservation');
  if (box === null) return;
  if (publication === null) {
    /* 两种零分开：记录被别处取代（gone）与还没选（guidance）。
       前者的下一步是「重新读取」，后者是「先登记一条」。 */
    box.innerHTML = data.publicationGone
      ? emptyState('none', {
        subject: '这条发布记录的观测',
        reason: '选中的那条发布记录已经不在了，没有可展开的观测。',
        next: '点「重新读取」，或从列表里重新选一条。',
      })
      : emptyState('not-recorded', {
        subject: '发布记录的观测',
        next: '上面还没有选中任何发布记录。先登记一条，观测才有起点。',
      });
    return;
  }
  box.innerHTML = deviationBlock(publication) + planBlock(publication)
    + observationCards(data, publication, publication.observation);
  for (const button of box.querySelectorAll('[data-conclude]')) {
    button.onclick = () => postClosureWrite('observation-conclude', {
      checkpointId: button.dataset.conclude,
      conclusion: button.dataset.conclusion,
      by: 'page',
    });
  }
  for (const button of box.querySelectorAll('[data-baseline]')) {
    button.onclick = () => {
      const noteEl = $('baselineNote');
      const note = noteEl === null ? '' : String(noteEl.value || '').trim();
      postClosureWrite('baseline-choice', {
        publicationId: (state.optimizations && state.optimizations.selectedPublicationId) || null,
        choice: button.dataset.baseline,
        note: note === '' ? null : note,
      });
    };
  }
}

function deviationBlock(publication) {
  const lines = ['<div class="bar" style="flex-wrap:wrap"><strong style="font-size:12px">偏离检查</strong>'];
  if (publication.kind === 'manual') {
    lines.push('<span class="hint" style="padding:0">手工登记不计算草案差异，也不参与发布率。</span></div>');
    return lines.join('');
  }
  lines.push(publication.deviated
    ? '<span class="chip warn">已偏离批准草案（' + escapeHtml(String(publication.deviationRule || '')) + '）</span>'
    : '<span class="chip ok">与批准草案一致</span>');
  lines.push('</div>');
  if (publication.deviated) {
    if (publication.baselineChoice === null || publication.baselineChoice === undefined) {
      lines.push('<div class="hint">这条发布偏离了批准草案，<strong>必须由人处置之后观测才会开始</strong>：'
        + '处置前该 ASIN 的观测卡片是 waiting_human，节点拒绝物化（观测起点还可能被「重新观测」推到现在）。</div>');
      lines.push('<div class="bar">'
        + '<button data-baseline="reobserve">' + escapeHtml(BASELINE_CHOICE_LABELS.reobserve) + '</button>'
        + '<button data-baseline="mispublish">' + escapeHtml(BASELINE_CHOICE_LABELS.mispublish) + '</button>'
        + '<input id="baselineNote" type="search" placeholder="处置备注（为什么）">'
        + '</div>');
    } else {
      lines.push('<div class="hint">处置：<strong>'
        + escapeHtml(BASELINE_CHOICE_LABELS[publication.baselineChoice] || publication.baselineChoice)
        + '</strong>（' + escapeHtml(shortTime(publication.baselineDecidedAt)) + '）。'
        + '第一次处置就是当时发生的事，不能改选。</div>');
    }
  }
  return lines.join('');
}

function planBlock(publication) {
  const plans = Array.isArray(publication.plans) ? publication.plans : [];
  const lines = ['<div class="bar" style="flex-wrap:wrap"><strong style="font-size:12px">观测计划</strong>'];
  if (plans.length === 0) {
    lines.push('<span class="hint" style="padding:0">还没有声明 —— 按默认窗口 7/14/30 天展开。</span></div>');
    lines.push('<div class="hint">观测计划要求先声明假设、基线、窗口与回滚条件，再用 amzn_observation_plan_save 登记。'
      + '没有声明不代表没有观测，只代表这次改动没有可对照的假设。</div>');
    return lines.join('');
  }
  const superseded = plans.filter(plan => plan.status !== 'active').length;
  lines.push('<span class="hint" style="padding:0">' + (plans.length - superseded) + ' 份生效'
    + (superseded > 0 ? '，' + superseded + ' 份已作废（留痕）' : '') + '</span></div>');
  for (const plan of plans) {
    lines.push('<div class="hint">[' + (plan.status === 'active' ? '当前' : '已作废') + '] '
      + '窗口 ' + (Array.isArray(plan.windowDays) ? plan.windowDays.join('/') : '—') + ' 天　·　'
      + '变更 ' + ((plan.changed || []).length) + ' / 不变 ' + ((plan.unchanged || []).length)
      + (plan.hypothesis ? '　·　假设：' + escapeHtml(plan.hypothesis) : '')
      + (plan.success && plan.success.length ? '　·　成功指标：' + escapeHtml(plan.success.join('、')) : '')
      + (plan.fail && plan.fail.length ? '　·　失败指标：' + escapeHtml(plan.fail.join('、')) : '')
      + (plan.status !== 'active' && plan.supersededReason ? '　·　作废原因：' + escapeHtml(plan.supersededReason) : '')
      + '</div>');
  }
  return lines.join('');
}

function observationCards(data, publication, observation) {
  const lines = ['<div class="bar" style="flex-wrap:wrap"><strong style="font-size:12px">观测节点</strong>'];
  if (observation === null) { lines.push('</div>'); return lines.join(''); }
  lines.push('<span class="chip">'
    + escapeHtml(OBSERVATION_STATE_LABELS[observation.state] || String(observation.state || '')) + '</span>');
  if (observation.window) {
    lines.push('<span class="opt-meta">窗口 ' + escapeHtml(String(observation.window.windowStart))
      + ' → ' + escapeHtml(String(observation.window.windowEnd)) + '</span>');
  }
  lines.push('</div>');
  if (observation.blockedBy === 'waiting_human') {
    lines.push('<div class="hint">观测还没开始：'
      + escapeHtml(String(observation.blockedReason || '偏离未处置')) + '</div>');
  }
  if (observation.blockedBy === 'terminated') {
    lines.push('<div class="hint">观测已终止：'
      + escapeHtml(String(observation.blockedReason || '已被回滚终止')) + '</div>');
  }
  if (observation.state === 'waiting_human') {
    lines.push('<div class="hint">下面是按观测起点算出的节点排期，处置之后才会物化 —— '
      + '现在它们还没有落库。</div>');
  }
  const checkpoints = Array.isArray(observation.checkpoints) ? observation.checkpoints : [];
  if (checkpoints.length === 0) {
    lines.push(emptyState('not-recorded', {
      subject: '这条发布的观测节点',
      next: '观测节点由观测计划按窗口生成 —— 先给这条发布建一份观测计划，节点才会出现。',
    }));
    return lines.join('');
  }
  lines.push(checkpoints.map(node => checkpointCard(data, node)).join(''));
  lines.push('<div class="hint">相关变化不自动归因于 Listing 修改：卡片说的是「窗口内发生了什么」，'
    + '不是「因为改了标题」。</div>');
  return lines.join('');
}

function checkpointCard(data, node) {
  const lines = ['<div class="bar" style="flex-wrap:wrap;border-top:1px solid var(--line)">'
    + '<strong style="font-size:12px">第 ' + node.day + ' 天</strong>'
    + '<span class="chip">' + escapeHtml(CHECKPOINT_STATE_LABELS[node.status] || String(node.status || '')) + '</span>'
    + '<span class="opt-meta">到期 ' + escapeHtml(shortTime(node.dueAt)) + '</span>'
    + (node.materialised === false ? '<span class="opt-meta">未物化</span>' : '')
    + '</div>'];
  if (node.status === 'blocked') {
    lines.push('<div class="hint">窗口内一类数据都没有 —— 这不是「没有变化」，是还没有人看过。'
      + '缺的是：' + escapeHtml(missingList(node.missing)) + '。</div>');
    if (node.blockedReason) lines.push('<div class="hint">' + escapeHtml(String(node.blockedReason)) + '</div>');
  }
  if (node.status === 'concluded') {
    lines.push('<div class="hint">结论：<strong>' + escapeHtml(String(node.conclusionLabel || node.conclusion))
      + '</strong>（' + escapeHtml(shortTime(node.concludedAt))
      + (node.concludedBy ? ' · ' + escapeHtml(String(node.concludedBy)) : '') + '）</div>');
    lines.push(frozenMetrics(node));
    lines.push('<div class="hint">以上读数是<strong>下结论那一刻冻结</strong>的，不是现在重算的 ——'
      + '事后数据再变，这里也不会跟着动。</div>');
    if (node.conclusionTerminated) {
      lines.push('<div class="hint">这条结论<strong>保留</strong>，但整条观测已被回滚终止。</div>');
    }
    if (node.conclusionNote) lines.push('<div class="hint">备注：' + escapeHtml(String(node.conclusionNote)) + '</div>');
  }
  if (node.status === 'retired') {
    lines.push('<div class="hint">已退出观测窗口 —— 这是观测计划改了窗口之后退休的节点，'
      + '<strong>不是</strong>被回滚终止。'
      + (node.retiredReason ? '（' + escapeHtml(String(node.retiredReason)) + '）' : '') + '</div>');
  }
  if (node.status === 'terminated') {
    lines.push('<div class="hint">已被回滚终止'
      + (node.terminatedReason ? '：' + escapeHtml(String(node.terminatedReason)) : '') + '</div>');
  }
  if (node.status === 'pending') {
    lines.push('<div class="hint">还没到期，不能下结论。要提前撤回，走回滚流程，不是这里。</div>');
  }
  const options = Array.isArray(node.availableConclusions) ? node.availableConclusions : [];
  if (options.length > 0) {
    const labels = data.conclusionLabels || {};
    lines.push('<div class="bar">' + options.map(value =>
      '<button data-conclude="' + escapeHtml(node.id) + '" data-conclusion="' + escapeHtml(value) + '">'
      + escapeHtml(labels[value] || value) + '</button>').join('') + '</div>');
  }
  return lines.join('');
}

function missingList(missing) {
  const items = Array.isArray(missing) ? missing : [];
  if (items.length === 0) return '（清单为空）';
  return items.map(item => {
    if (typeof item === 'string') return item;
    const label = item.label || item.metric || '未知指标';
    return item.available === false ? label + '（本插件没有采集通道）' : label;
  }).join('、');
}

function frozenMetrics(node) {
  const snapshot = node.metrics;
  if (snapshot === null || snapshot === undefined) return '<div class="hint">没有冻结的读数。</div>';
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  if (items.length === 0) return '<div class="hint">冻结时一类指标都没取到。</div>';
  return '<div class="hint" style="display:flex;flex-direction:column;gap:2px">' + items.map(item =>
    '<span>' + escapeHtml(String(item.label)) + ' = ' + escapeHtml(String(item.value)) + ' '
    + escapeHtml(String(item.unit || '')) + ' · 样本 ' + escapeHtml(String(item.sample))
    + ' · 来源 ' + escapeHtml(String(item.source || ''))
    + (item.change === null || item.change === undefined ? '' : ' · 变化 ' + escapeHtml(String(item.change)))
    + (item.scopeCaveat ? '<br>⚠ ' + escapeHtml(String(item.scopeCaveat)) : '') + '</span>').join('') + '</div>';
}

function renderRollbackPanel(data, publication) {
  const box = $('optrollback');
  if (box === null) return;
  const parts = [];
  if (publication === null) {
    parts.push('<div class="empty">先在上面选中一条发布记录 —— 回滚针对具体的一版发布。</div>');
  } else {
    const readiness = publication.rollback;
    parts.push('<div class="bar" style="flex-wrap:wrap"><strong style="font-size:12px">回滚就绪度</strong>'
      + '<span class="chip ' + (readiness && readiness.ready ? 'warn' : '') + '">'
      + (readiness && readiness.ready ? '满足回滚条件' : '未满足') + '</span></div>');
    parts.push('<div class="hint">'
      + escapeHtml(readiness && readiness.reason ? readiness.reason : '没有可判断的观测节点。') + '</div>');
    parts.push('<div class="hint">回滚流程里的「30 天无改善」是<strong>系统主动提醒</strong>的条件，不是人工生成交付包的门槛 ——'
      + '断货、合规问题可以提前撤回，这里不拦。</div>');
    parts.push('<div class="bar"><button id="rollbackSuggest">生成回滚交付包</button>'
      + '<input id="rollbackReason" type="search" placeholder="回滚原因（为什么）"></div>');
  }
  const tasks = data && Array.isArray(data.rollbackTasks) ? data.rollbackTasks : [];
  if (tasks.length === 0) {
    parts.push(emptyState('not-recorded', {
      subject: '回滚任务',
      next: '回滚包由 amzn_rollback_suggest 生成，针对具体一版的发布记录 —— 没有发布记录就没有可回滚的对象。',
    }));
  } else {
    parts.push('<table><thead><tr><th>任务</th><th>被回滚</th><th>目标</th><th>状态</th><th>stale</th></tr></thead><tbody>'
      + tasks.map(task => '<tr>'
        + '<td><code>' + escapeHtml(String(task.id).slice(0, 14)) + '</code></td>'
        + '<td><code>' + escapeHtml(String(task.fromPublicationId || task.publicationId || '—').slice(0, 14)) + '</code></td>'
        + '<td><code>' + escapeHtml(String(task.toPublicationId || '—').slice(0, 14)) + '</code></td>'
        + '<td>' + escapeHtml(String(task.statusLabel || task.status)) + '</td>'
        + '<td>' + (task.stale ? '<span class="chip stop">⚠ stale</span>' : '') + '</td>'
        + '</tr>').join('')
      + '</tbody></table>');
    for (const task of tasks) {
      if (task.stale && task.staleReason) {
        parts.push('<div class="hint">⚠ ' + escapeHtml(String(task.staleReason)) + '</div>');
      }
    }
  }
  box.innerHTML = parts.join('');
  const button = $('rollbackSuggest');
  if (button !== null) {
    button.onclick = () => {
      const reasonEl = $('rollbackReason');
      const reason = reasonEl === null ? '' : String(reasonEl.value || '').trim();
      postClosureWrite('rollback-suggest', {
        publicationId: (state.optimizations && state.optimizations.selectedPublicationId) || null,
        reason: reason === '' ? null : reason,
      });
    };
  }
}

/* The filter values the inbox can carry, named in the reader's own words.
 *
 * UI copy, so it lives here — but the **ids** come from the payload
 * (data.inbox.groupIds and the context states), and the suite asserts the two
 * lists agree in both directions: a sixth group added to the domain would
 * otherwise be silently unreachable from this bar. That is the same rule the
 * quality tabs follow.
 *
 * orphan is a spelling saved into links before B-13b (the old bar had exactly
 * two filters and this was one of them). It resolves to the same predicate as
 * draftContext=orphan — one judgement, two spellings, not two judgements.
 *
 * An unrecognised value shows everything rather than nothing: a filter nobody
 * understands must not look like an empty list, which is the same silent-empty
 * shape the rest of this page refuses.
 *
 * NB: no backticks in this comment — this whole file is one template literal. */
const DRAFT_FILTER_LABELS = {
  pending: '未定',
  approval: '待审批',
  revision: '驳回待修订',
  deferred: '稍后',
  voided: '已作废',
  current: '当前上下文',
  changed: '上下文已变化',
  orphan: '没有上下文',
};

/* Does one draft belong under one filter value? **The payload answers, not this
   file.** buckets is computed server-side by domain/optimize/inbox.js, which is
   also what amzn_optimize_inbox answers with — so the panel and the tool cannot
   disagree about which group a draft is in. The page does a membership test and
   nothing more; there is no second derivation here to drift. */
function draftInBucket(draft, filter) {
  return filter === '' || (Array.isArray(draft.buckets) ? draft.buckets : []).includes(filter);
}

/* ── the report centre (B07 / F14-01) ─────────────────────────────────── */

/* The report centre. Every report this workbench has produced, in one table,
   filterable by kind / status / ASIN / site / product line / creator / tag /
   favourite / date.

   Four decisions worth stating because they are what the panel is for:

   - A report whose body is no longer reachable is **listed, not hidden**, marked
     「取不回」. Dropping it would make the history read as complete, and the one
     question this page exists to answer is "did this ASIN get optimized, and
     when" — an answer that omits a lost report is wrong.
   - An **archived** report is likewise listed and marked 「已归档」 (2026-10-13
     ruling on ASIN archive, applied here for the same reason: a row that vanished
     on its own looks exactly like a bug). The status select is how you look at
     only the archived ones.
   - A file report gets a path to copy, not a link. There is no in-page viewer
     for a CSV, and a link that 404s is worse than a path the user can paste.
   - **No kind label table lives here.** Every label is read from the server's
     payload, which reads it from REPORT_KIND_TABLE in store/reports.js. This file
     used to carry a third copy of the three labels; adding a kind would have
     missed it, and the failure mode is silent (the row renders its raw id where a
     label belongs).

   The controls mirror the server's own filters (data.filters), so a select
   never claims a filter the payload ignored. */`
