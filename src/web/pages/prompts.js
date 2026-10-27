/**
 * 页签「prompts」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const promptsScript = `function renderPromptEditor() {
  const data = state.prompts && state.prompts.editor;
  if (!data) { $('promptList').innerHTML = ''; $('promptForm').innerHTML = ''; return; }
  const stats = (state.prompts && state.prompts.stats) || { total: 0, sets: 0, button: 0, assemble: 0, disabled: 0 };
  const vars = data.variables || {};
  /* 证据勾选是编辑器瞬时态，不写库（LLD I-T73-3）。未初始化时全部不勾选。 */
  if (!state.evidenceSelection || typeof state.evidenceSelection !== 'object') state.evidenceSelection = {};
  $('promptHint').textContent = '预览变量 scope「' + (vars.scope || '') + '」· selectedKeywords「'
    + (vars.selectedKeywords || '') + '」· rulesVersion「' + (vars.rulesVersion || '') + '」';
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + '">'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + '</span>';
  $('promptstats').innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('套', stats.sets)
    + chip('按钮', stats.button)
    + chip('组装', stats.assemble)
    + chip('已停用', stats.disabled, stats.disabled > 0 ? 'warn' : '')
    + '</div>';

  const byModule = new Map();
  for (const row of data.rows) {
    if (!byModule.has(row.module)) byModule.set(row.module, []);
    byModule.get(row.module).push(row);
  }
  const order = [];
  for (const set of data.sets) {
    if (byModule.has(set.module) && !order.includes(set.module)) order.push(set.module);
  }
  for (const module of byModule.keys()) {
    if (!order.includes(module)) order.push(module);
  }

  $('promptList').innerHTML = order.map(module => {
    const set = data.sets.find(candidate => candidate.module === module);
    const head = '<div class="rule-sect" style="border-top:none;padding:6px 2px 2px">'
      + escapeHtml(module) + '　' + escapeHtml(set ? set.name : module) + '</div>';
    return head + byModule.get(module).map(row => promptRowHtml(row)).join('');
  }).join('');

  for (const el of $('promptList').querySelectorAll('.prompt-row')) {
    el.onclick = () => { state.selectedPromptId = el.dataset.prompt; renderPromptEditor(); };
  }
  renderPromptForm(data);
  renderPromptEval(data);
  renderPromptCompare(data);
}

/**
 * F11-07：固定评估集那一块。
 *
 * **只读**。页面不导入（导入是工具的事），所以这里没有任何按钮 —— 一个能点的
 * 按钮会暗示页面能写。它把「有几套、每套几条、每条期望什么」摆出来，让人拿着
 * 它去逐条对照提示词版本的输出。
 *
 * ⚠️ 这一块**不显示任何通过率**，因为库里的确没有这个数 —— 本插件没有评估器。
 * 一个「0 / 12 通过」会是本仓最忌讳的那种东西：把「没测过」渲染成一个测量值。
 * 所以这里的措辞始终是「期望」，不是「结果」。
 */
function renderPromptEval(data) {
  const host = $('promptEval');
  if (!host) return;
  const sets = (data && data.evalSets) || [];
  const head = '<div class="eval-sect">固定评估集（F11-07）'
    + '<span class="eval-note">只读 · 导入用 <code>amzn_prompt_eval_import</code> · '
    + '<strong>没有通过率</strong>：本插件没有评估器，这些是<strong>期望</strong>不是<strong>结果</strong></span></div>';
  if (sets.length === 0) {
    host.innerHTML = head
      + emptyState('not-recorded', {
        subject: '评估集',
        next: '提示词的 testing 一步要求「在固定评估集上跑」，所以先用 amzn_prompt_eval_import 导一套。',
      });
    return;
  }
  host.innerHTML = head + sets.map(set => {
    const cases = (set.cases || []);
    const meta = escapeHtml(set.version) + ' · ' + cases.length + ' 条'
      + (set.isEmpty ? '（空）' : '');
    const body = cases.length === 0
      ? '<div class="es-empty">这一套是<strong>空的</strong> —— 它存在，但没有样例。'
        + '空的评估集评审不了任何东西（这与「没有这一套」是两件事）。</div>'
      : cases.map(entry => '<div class="eval-case">'
        + '<span class="ec-id">' + escapeHtml(String(entry.caseIndex)) + '. ' + escapeHtml(entry.caseId) + '</span>'
        + '<span class="ec-cat">' + escapeHtml(entry.category) + '</span>'
        + '<div class="ec-line">输入: ' + escapeHtml(JSON.stringify(entry.input)) + '</div>'
        + '<div class="ec-exp">期望: ' + escapeHtml(entry.expected) + '</div>'
        + ((entry.expectRules && entry.expectRules.length > 0)
          ? '<div class="ec-line">必中规则: ' + escapeHtml(entry.expectRules.join(', ')) + '</div>'
          : '')
        + '</div>').join('');
    return '<div class="eval-set">'
      + '<div class="es-head"><span class="es-id">' + escapeHtml(set.id) + '</span>'
      + '<span>' + escapeHtml(set.title) + '</span>'
      + '<span class="es-meta">' + meta + '</span></div>'
      + body
      + '</div>';
  }).join('');
}

/* F11-08：把双版本对比那一块画到它的宿主容器里。数据是**当前选中行**的
   compare（两版正文材料）与编辑器的 compareDimensions（九维清单）——
   两者都由服务端下发，页面只负责摆位置。

   ⚠️ 没有选中行时**也要画**九维清单：九维是**代码常量**，与选了哪一行无关；
   把整块藏掉会让「九维全缺」这件事实在没选行时看不见。所以清单常驻，
   只有两版正文那一半依赖选中行。 */
function renderPromptCompare(data) {
  const host = $('promptCompare');
  if (!host) return;
  const dims = (data && data.compareDimensions) || null;
  /* 选中行的判据与 renderPromptForm 逐字一致：先按 state.selectedPromptId 找，
     找不到就退回第一行 —— 两处必须用**同一条**选择规则，否则上下两块会各显示一行。 */
  const rows = (data && data.rows) || [];
  const row = rows.find(candidate => candidate.id === state.selectedPromptId) || rows[0] || null;
  host.innerHTML = compareBlock({
    compareDimensions: dims,
    compare: row ? row.compare : null,
  });
}

/* F11-08 —— 双版本对比（**材料，不含评分**）。
   本块**只渲染服务端下发的材料**：哪九维、分几类、每类缺哪份记录，全部来自
   compareDimensions；两版正文来自 compare.current / compare.previous。
   页面**不自己取正文、不自己数维度、不算任何分** —— 与 metricsBlock / gapsBlock
   同一条单源规矩（page.js:4253-4275）。

   ⚠️ 三件事必须分开画，不能折叠（折叠了就是本仓最忌讳的「把缺失渲染成真实值」）：
     ① **服务端没下发**：画一句「没有下发这一格」，**不是**画空表让人以为「零缺失」；
     ② **body 是 null**：画「这一版没有冻结正文」，**不是**空白格（空白格读成「空正文」）；
     ③ **根本没有可比的那一版**（previous 是 null）：画「没有上一冻结版本」，
        **不是**把它当成一个空版本。三句话各不相同，因为它们是三种不同的「没有」。

   ⚠️ **本块没有任何按钮**：没有评估器可跑、没有结果可存。一个点了无事发生的按钮，
   比没有按钮更糟。 */
function compareBlock(data) {
  const label = '<div class="rule-sect">双版本对比（材料，不含评分 · F11-08）</div>';
  const dims = data && data.compareDimensions;
  if (!dims) {
    return label
      + '<div class="hint">服务端没有下发这一格 —— 与「九维都没有缺失」不是一件事。</div>';
  }
  const list = dims.dimensions || [];
  /* 九维清单表格：表头逐字对齐 metricsBlock 的既有措辞。 */
  const rows = list.map(dim => '<tr>'
    + '<td>' + escapeHtml(dim.label) + '<br><span class="opt-meta">'
    + escapeHtml(dim.id) + ' · ' + escapeHtml(dim.kind) + '</span></td>'
    + '<td>' + escapeHtml(dim.missing)
    + (dim.sameNameAt
      ? '<br><span class="opt-meta">同名物（不能挪用）：' + escapeHtml(dim.sameNameAt) + '</span>'
      : '')
    + '<br><span class="opt-meta">缺的那份记录：' + escapeHtml(dim.source) + '</span></td>'
    + '</tr>').join('');
  const table = '<table><thead><tr><th>维度</th><th>缺哪份记录（不是「未实现」）</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table>';

  /* 并排两版正文。数据来自服务端下发的 compare —— 页面不自己取。 */
  const compare = (data && data.compare) || null;
  let panels;
  if (!compare) {
    panels = '<div class="hint">服务端没有下发两版正文 —— 与「两版正文一样」不是一件事。</div>';
  } else {
    panels = '<div class="cards">'
      + versionCard(compare.current, 'current')
      + versionCard(compare.previous, 'previous')
      + '</div>';
  }
  return label
    + panels
    + evalInputsBlock(compare)
    + '<div class="hint">' + escapeHtml(dims.summary) + '</div>'
    + table;
}

/* F11-08 §2.4 —— 「同一输入喂两版」的**输入**那一半：**没有来源**。
   ⚠️ 这一块**不是**「样例为空」，也**不是**「查错了集合」，更**不是**「没有关联」——
   本数据模型里**根本没有「提示词 ↔ 评估集」这条关联**（理由见 routes.js 的
   evalInputs 注释：两个 id 空间不相交 + version 类型不同）。
   本仓「没有」的三分类里这是 **C 类 no-source**：没有这个来源。

   ⚠️ 措辞纪律（这三句都不能说，因为它们都预设了「关联」这个概念存在）：
     ·「这个提示词没有关联评估集」—— 预设了「关联」是可能有的；
     ·「评估集里没有样例」—— 预设了能查到集合、只是它空；
     ·「集合为空」—— 同上。
   只能说：**这条关联没有建立 / 没有这个来源**。

   ⚠️ 交付的是「输入」不是「结果」：两版输出没有载体，没有 LLM 就没有结果。
   ⚠️ **本块没有任何按钮** —— 没有可执行的评估动作。
   ⚠️ 本函数在页面那一个巨型模板字面量里，所以注释里**不能用反引号**（会提前结束字符串）。 */
function evalInputsBlock(compare) {
  const label = '<div class="rule-sect">评估样例输入（材料 · F11-08 §2.4）</div>'
  /* 服务端没下发这一格（compare 为 null）—— 与「没有这个来源」是两件事，分开说。 */
  if (!compare) {
    return label
      + '<div class="hint">服务端没有下发这一格 —— 与「这条关联没有来源」不是一件事。</div>'
  }
  /* ⚠️ 用 in 判「字段在不在」，不是判值真假 —— 与下发字段名同源。
     字段名是 evalInputs（**不是** inputs）：那个名字会让人以为里面是样例。 */
  const cell = ('evalInputs' in compare) ? compare.evalInputs : undefined
  if (cell === undefined) {
    return label
      + '<div class="hint">服务端没有下发这一格 —— 与「这条关联没有来源」不是一件事。</div>'
  }
  /* ⚠️ 承重判断：只要服务端把这一格填成**任何**非 available:false 的形状
     （非空数组、别的对象），这里就如实说「下发了内容但本块不认」而不是假装能画。
     本批这条关联不存在，谁往里填样例都是在编一个不存在的来源。 */
  if (cell === null || cell.available !== false) {
    return label
      + '<div class="hint">服务端下发了这一格，但它<strong>不是「没有来源」的登记</strong> —— '
      + '本块只认 available:false。这条关联在本数据模型里不存在，'
      + '任何样例都不是从它来的。</div>'
  }
  return label
    + '<div class="hint">提示词 ↔ 评估集的关联<strong>没有建立</strong>，所以「同一输入喂两版」'
    + '这句话里的<strong>输入</strong>这一半<strong>暂无来源</strong> —— 不是「样例为空」，'
    + '也不是「查错了集合」，是<strong>没有这个来源</strong>：数据模型里没有这条关联，'
    + '提示词的 <code>set_id</code> 与评估集的 id 不是同一套。'
    + '这批材料是<strong>输入</strong>、<strong>不是这两版跑出来的结果</strong> ——'
    + '两版输出没有载体，没有 LLM 就没有结果。</div>'
}

/* 一版正文的卡片。version 是 null 时说的是「没有**这一版**」，不是「这一版是空的」——
   两句话不同，所以走不同的分支，绝不把 null 折成空正文画一个空白格。 */
function versionCard(version, side) {
  const head = '<div class="cardhead">' + escapeHtml(side === 'current' ? '当前版本' : '上一冻结版本')
    + ' <span class="opt-meta">' + escapeHtml(side) + '</span></div>';
  if (!version) {
    /* 根本没有可比的那一版：没有冻结过，或这一行从未被保存过。 */
    return '<div class="card">' + head
      + '<div class="cardbody">没有上一冻结版本（本提示词还没有被保存覆盖过）</div></div>';
  }
  const meta = '<div class="opt-meta">版本 ' + escapeHtml(String(version.version)) + '</div>';
  if (version.bodyIsNull) {
    /* pointer 快照不发明正文 —— 如实画「没有冻结正文」，**不是**空白格。 */
    return '<div class="card">' + head + meta
      + '<div class="cardbody">这一版没有冻结正文（pointer 快照，未保存正文）</div></div>';
  }
  return '<div class="card">' + head + meta
    + '<div class="cardbody"><pre class="cmp-body">' + escapeHtml(String(version.body)) + '</pre></div></div>';
}

/* ISO 时间戳 → YYYY-MM-DD HH:MM:SS；不是这个形状就原样返回。与工具侧同一口径。 */
function historyTime(value) {
  const text = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 19).replace('T', ' ') : text;
}

/* 只有拿到**有限数字**才用它。字段缺失时 Number(undefined) 是 NaN，渲染成
   「冻结版本共 NaN 个」是一个像数据的替身，比留一个洞更危险。判有没有数据要判内容，
   不能只判参数是不是对象（B-08.3 的教训）。 */
function countOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* 生命周期（F11-05）。状态与**合法下一步**都来自 store 下发的 lifecycle —— 页面不
   自己抄一份边，抄一份就会和状态机漂开，而漂开的方向一定是「页面点了没用」或
   「页面能点、store 拒绝」。三件事分开说：现在是什么状态、离进生产还差哪道门、
   以及现在能做哪一步。
   「生命周期字段不存在」与「状态是 draft」也是两件事：前者是这一行没带数据（未加载），
   后者是**查过了**、谁都没说过它是什么。并成一句就是把「没查」渲染成「查了没有」。 */
function promptLifecycleHtml(selected) {
  const wrap = inner => '<div id="promptLifecycle">' + inner + '</div>';
  const head = '<div class="rule-sect">生命周期（F11-05）</div>';
  const life = selected && selected.lifecycle ? selected.lifecycle : null;
  if (!life) {
    return wrap(head + '<div class="hint">（这一行没有带生命周期数据）—— 未加载与'
      + '「还没有任何生命周期事件」是两回事，这里说的是前者。</div>');
  }
  const gate = selected.production && typeof selected.production === 'object' ? selected.production : null;
  const activeText = life.activeVersion === null ? '无' : ('v' + life.activeVersion);
  /* 措辞注意：B-11.1 的断言禁止表单里出现「当前 v」四个字（它会把行级编辑计数读成
     可看的版本历史），所以这里不用那个说法 —— 这是两个批次共用一条字符串的又一例。 */
  let html = head;
  html += '<div class="hint">生命周期挂在 v' + escapeHtml(String(life.version))
    + '（行上的编辑计数）· 状态 <strong>' + escapeHtml(String(life.status)) + '</strong>（' + escapeHtml(String(life.statusLabel)) + '）'
    + ' · 活动版本 ' + escapeHtml(activeText)
    + '。状态是<strong>按版本</strong>的：编辑会把这一行推进到下一版（draft），而生产用的仍是'
    + '活动版本的那一份正文 —— 保存一次正文不等于把它放进生产。</div>';
  if (gate !== null) {
    html += '<div class="hint">' + (gate.inProduction
      ? '在产：两道门都过了（<code>enabled</code> = 1，且有 active 版本）。'
      : '不在产：<strong>' + escapeHtml(gate.gates.join(' + ')) + '</strong>。'
        + escapeHtml(String(gate.reason || ''))) + '</div>';
  }
  const steps = Array.isArray(life.next) ? life.next : [];
  const stepButtons = steps.map(step => {
    /* active 那一步走自己的路由（prompt-version-activate），所以它的审计动作与
       工具 amzn_prompt_version_activate 是同一条；其余步骤走 prompt-lifecycle。 */
    const route = step.status === 'active' ? 'prompt-version-activate' : 'prompt-lifecycle';
    return '<button class="prompt-lifecycle-next" data-route="' + escapeHtml(route)
      + '" data-to="' + escapeHtml(String(step.status)) + '">走到 ' + escapeHtml(String(step.label)) + '</button>';
  }).join('');
  const rollbackTitle = life.status === 'active'
    ? '这一版是第一个活动版本，没有更早的活动版本可以退回'
    : '当前版不是 active —— 没有在生产里的东西可以退回';
  const rollbackButton = life.canRollback
    ? '<button class="prompt-active-rollback" data-route="prompt-version-rollback">退回上一活动版本 v'
      + escapeHtml(String(life.previousActiveVersion)) + '</button>'
    : '<button class="prompt-active-rollback" disabled title="' + escapeHtml(rollbackTitle)
      + '">退回上一活动版本</button>';
  html += '<div class="bar" style="border-top:none;border-bottom:none;padding:0">'
    + stepButtons + rollbackButton + '</div>';
  html += '<div class="hint">合法下一步来自状态机：' + (steps.length === 0
    ? '（终态，没有出口）'
    : steps.map(step => escapeHtml(String(step.status))).join(' / '))
    + '。没有 draft → active 这条边 —— 如果保存正文也能激活，「编辑」与「激活」又合成一件事了。'
    + '「退回上一活动版本」一个字都不改正文：那一版的正文当时就被冻着，只是不再是生产用的那一份。</div>';
  return wrap(html);
}

/* 生命周期的一次 POST，一个事实。route 由按钮带出来（激活走自己的路由，让它的
   审计动作与工具同一条），to 只有走一步时才带。与工具调的是同一个 store 函数，
   所以页面点不动的东西，工具也拒得了。 */
async function promptLifecyclePost(route, id, to) {
  const body = to === null || to === undefined ? { id: id } : { id: id, to: to };
  try {
    await api(route, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* 版本历史（保存即冻结）。每个冻结版本一行，按钮带 data-snapshot；点击由**容器
   委托**处理（见 renderPromptForm），所以新增一行就自动可点，不会漏处理器。
   三种「没有」要分开说：字段根本没下发（未加载）、字段是空数组（真的没有冻结版本）、
   有冻结版本但全被归档（有，只是默认不显示）。并成一句话就是把「没查」渲染成
   「查了，没有」—— 本仓反复吃过亏的形状。 */
function promptHistoryHtml(selected) {
  const head = '<div class="rule-sect">版本历史（保存即冻结）</div>';
  /* 字段**不存在**与字段是空数组是两件事：前者是这一行没带历史（未加载），后者是
     历史确实为空。 */
  const hasField = selected !== null && selected !== undefined
    && Object.prototype.hasOwnProperty.call(selected, 'history');
  if (!hasField) {
    return head + '<div class="hint">（这一行没有带历史数据）—— 未加载与「确实没有冻结版本」'
      + '是两回事，这里说的是前者。</div>';
  }
  const rows = Array.isArray(selected.history) ? selected.history : [];
  const meta = selected.historyMeta && typeof selected.historyMeta === 'object' ? selected.historyMeta : null;
  /* 真总数与归档数都来自路由下发的那一次 promptHistory —— 页面不自己再数一遍，
     所以页面与工具不可能各算各的。meta 缺席或字段不是有限数时退回行数（那是**下界**，
     不会假），不凭空造一个更大的数。 */
  const frozenTotal = countOr(meta ? meta.matchedAll : null, rows.length);
  const archived = countOr(meta ? meta.archived : null, 0);
  const matched = countOr(meta ? meta.matched : null, rows.length);
  if (rows.length === 0) {
    if (frozenTotal > 0) {
      /* 有冻结版本，但都被归档了：默认视图为空 ≠ 没有历史。 */
      return head + '<div class="hint">冻结版本共 ' + frozenTotal + ' 个，其中 ' + archived
        + ' 个已归档（默认不显示）—— 当前视图没有可显示的冻结版本，但它们都还在、都还能回滚。</div>';
    }
    return head + '<div class="hint">还没有冻结版本：这条提示词自本批起没有被编辑过。'
      + '本批（B-11.2b）之前的旧稿从未被捕获，读不到。</div>';
  }
  const items = rows.map((entry) => {
    const body = String(entry.body ?? '').replace(/\s+/g, ' ').slice(0, 90);
    return '<div class="prompt-version" data-snapshot="' + escapeHtml(entry.id) + '">'
      + '<span class="pv-ver">冻结 v' + escapeHtml(String(entry.version)) + '</span>'
      + '<span class="pv-time">' + escapeHtml(historyTime(entry.createdAt)) + '</span>'
      + '<button class="prompt-rollback" data-snapshot="' + escapeHtml(entry.id) + '">回滚到这版</button>'
      + '<div class="pv-body">' + escapeHtml(body) + '</div></div>';
  }).join('');
  /* 数量如实说：共多少（含归档）、其中多少已归档、显示了几行。截断提示只认
     matched > rows.length（非归档的未截断数 > 实际返回行数）—— 那才等价于「上限
     真的切掉了可见行」。用含归档的 frozenTotal 会把「被归档隐藏」误报成「被上限
     截断」，两种「少了」又合成一句，正是本批在修的形状。 */
  let countLine = '冻结版本共 ' + frozenTotal + ' 个';
  if (archived > 0) countLine += '（其中 ' + archived + ' 个已归档，默认不显示）';
  if (matched > rows.length) countLine += '，仅显示最近 ' + rows.length + ' 个';
  countLine += '。';
  return head + '<div class="prompt-history" id="promptHistory">' + items + '</div>'
    + '<div class="hint">' + countLine + '</div>'
    + '<div class="hint">回滚是一次<strong>新编辑</strong>：计数 +1，回滚前的正文也会被冻结，仍可读回。</div>';
}

/* One POST, one fact: "this prompt's body is now the frozen one". The route calls
   the same rollbackPrompt the tool does, so the editor cannot roll back to
   something the tool would refuse. */
async function rollbackPromptTo(id, snapshotId) {
  try {
    await api('prompt-rollback', { method: 'POST', body: JSON.stringify({ id, snapshotId }) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

function renderPromptForm(data) {
  const rows = data.rows;
  const selected = rows.find(row => row.id === state.selectedPromptId) || rows[0];
  if (!selected) {
    $('promptForm').innerHTML = emptyState('not-recorded', {
      subject: '提示词',
      next: '提示词库由插件随迁移写入内置的那一批 —— 空的话先确认迁移跑完了，再谈新增。',
    });
    return;
  }
  state.selectedPromptId = selected.id;

  const layers = selected.scenario === 'assemble'
    ? '<label>层<select id="promptLayer">'
      + ['fixed', 'evidence', 'contract'].map(layer => '<option value="' + layer + '"'
        + (layer === selected.layer ? ' selected' : '') + '>' + layerText(layer) + '</option>').join('')
      + '</select></label>'
    : '';

  /* 「有几个旧稿可回滚」由数据算出来，不是把「改过 N 次 = N 个版本」当成一句断言。
     新建那一次不冻结，所以冻结数比编辑计数少 1；本批之前的保存从未被捕获，只会更少。
     真总数取路由下发的那一次 promptHistory 的 matchedAll（含已归档 —— 归档的版本
     仍可回滚），页面与工具因此是同一个数。字段缺失时 countOr 退回行数，不造 NaN。 */
  const historyMeta = selected.historyMeta && typeof selected.historyMeta === 'object' ? selected.historyMeta : null;
  const rollbackable = countOr(historyMeta ? historyMeta.matchedAll : null,
    Array.isArray(selected.history) ? selected.history.length : 0);
  /* 列表里归档版本不画回滚按钮，所以 N 个数字只有 N−K 个入口；差额必须说出来，否则
     读者会以为页面上能点的就是全部。不改成 matched —— 那会让页面与工具的数字又分开。 */
  const archivedInForm = countOr(historyMeta ? historyMeta.archived : null, 0);

  $('promptForm').innerHTML = '<label>标题<input id="promptLabel" value="' + escapeHtml(selected.label) + '"></label>'
    + '<label>模块 / 场景<input value="'
    + escapeHtml(selected.module + ' · ' + (selected.scenario === 'assemble' ? '组装' : '按钮')) + '" readonly></label>'
    + layers
    + '<label>正文（{{name}} 占位；{{#name}}…{{/name}} 可选段，值为空时整段连同它自带的标点一起去掉）'
    + '<textarea id="promptBody" spellcheck="false">' + escapeHtml(selected.body) + '</textarea></label>'
    + promptEvidenceSidebarHtml(data)
    + promptVariableBagHtml(data, selected)
    + '<div class="hint">行级「改过 ' + escapeHtml(String(selected.version)) + ' 次」是<strong>编辑计数</strong>，不是版本历史；'
    + '每一次保存都会把<strong>被替换掉的正文冻结</strong>（自本批 B-11.2b 起）。'
    + '新建那一次没有旧稿可冻，所以冻结数比编辑计数少 1 —— 这条提示词现在有 ' + rollbackable + ' 个旧稿可回滚'
    + (archivedInForm > 0 ? '（其中 ' + archivedInForm + ' 个已归档，列表默认不显示，仍可回滚）' : '')
    + '。'
    + '<strong>本批之前保存过的旧稿没有被冻结，回不去。</strong></div>'
    + '<div class="bar" style="border-top:none;border-bottom:none;padding:0">'
    + '<button id="promptSave">保存</button>'
    + '<button id="promptPreview">预览</button>'
    + '<label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="promptEnabled"'
    + (selected.enabled ? ' checked' : '') + '> 启用</label>'
    + '<span class="hint" style="padding:0;margin-left:auto">改过 ' + selected.version + ' 次 · '
    + escapeHtml(selected.id.slice(0, 8)) + '</span>'
    + '</div>'
    + '<div class="prompt-preview" id="promptPreviewOut">' + escapeHtml(selected.preview || '') + '</div>'
    + promptLifecycleHtml(selected)
    + promptHistoryHtml(selected);
    + promptHistoryHtml(selected)
    + promptReferencesHtml(selected);

  $('promptSave').onclick = () => savePrompt(selected);
  $('promptPreview').onclick = () => previewPromptBody();
  wireEvidenceSidebar();
  /* 生命周期按钮同样用**容器事件委托**：走到哪一步是渲染时定的（合法下一步来自
     状态机），逐行 onclick 漏一个就是一个点不动的按钮。禁用态的按钮浏览器不会触发
     click，这里再挡一次是为了测试里的 DOM 与真浏览器行为一致。 */
  const lifecycleBox = $('promptLifecycle');
  if (lifecycleBox) {
    lifecycleBox.onclick = (event) => {
      const target = event ? event.target : null;
      if (!target || typeof target.closest !== 'function') return;
      let button = target.closest('.prompt-lifecycle-next');
      if (button === null || button === undefined) button = target.closest('.prompt-active-rollback');
      if (!button || !button.dataset || !button.dataset.route) return;
      if (button.disabled) return;
      const to = button.dataset.to === undefined ? null : button.dataset.to;
      promptLifecyclePost(button.dataset.route, selected.id, to);
    };
  }
  /* 回滚按钮用**容器事件委托**，不是逐行 onclick —— B-06.1 的 D1 缺陷正是「渲染出
     可点的行、却没有处理器」：逐行绑定时漏一行就是一行死按钮，委托则不可能漏。 */
  const historyBox = $('promptHistory');
  if (historyBox) {
    historyBox.onclick = (event) => {
      const target = event ? event.target : null;
      const button = target && typeof target.closest === 'function' ? target.closest('.prompt-rollback') : null;
      if (!button || !button.dataset || !button.dataset.snapshot) return;
      rollbackPromptTo(selected.id, button.dataset.snapshot);
    };
  }
}

/* ── T73 变量袋 / 证据侧栏 / 降级预览 ───────────────────────────────────── */

/* 七类的中文名只是界面标签；变量清单、类型、来源、缺失行为全部来自服务端下发的
   data.registry（promptVariableRows），页面不抄第二份变量定义。 */
const EVIDENCE_CLASS_LABELS = {
  asin: '① ASIN 现状',
  competitor: '② 竞品分析',
  review: '③ 评论分析',
  kw_master: '④ 关键词总库',
  kw_coverage: '⑤ 关键词分析',
  geo: '⑥ SEO·GEO',
  policy: '⑦ 最新政策',
};

function promptValueMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function evidenceSpecs(data, classId) {
  const registry = (data && data.registry) || [];
  return registry.filter(spec => spec.evidenceClass === classId);
}

/**
 * 一类证据的可用性。四态分开：
 *   available     —— 有值（values）
 *   no_source     —— 本仓没有来源（结构性缺失）
 *   not_generated —— 这一类本轮没有生成（读过/没跑过）
 *   read_error    —— reader 失败（不能画成空列表）
 *
 * 服务端目前还没有下发 data.evidence；这时如实落到 not_generated，并写明
 * 「服务端未下发」，不把七类画成空列表。
 */
function evidenceClassData(data, classId) {
  const specs = evidenceSpecs(data, classId);
  const values = {};
  let status = 'not_generated';
  let text = '这一类本轮没有生成（服务端未下发证据）';
  let source = specs.length > 0 ? String(specs[0].source || '') : '';
  let timeSource = specs.length > 0 ? String(specs[0].timeSource || '') : '';
  const appliesTo = [];
  for (const spec of specs) {
    for (const field of (spec.appliesTo || [])) {
      if (!appliesTo.includes(field)) appliesTo.push(field);
    }
  }

  /* 政策库正文是基线变量 policies，不是证据类；有值时把这一类标成可用。 */
  if (classId === 'policy' && data && data.variables && !promptValueMissing(data.variables.policies)) {
    status = 'available';
    values.policies = data.variables.policies;
    text = '可用：policies 有值（政策库正文）';
  }

  const raw = data && data.evidence ? data.evidence[classId] : null;
  if (raw && typeof raw === 'object') {
    if (raw.source !== undefined && raw.source !== null && String(raw.source).trim() !== '') source = String(raw.source);
    if (raw.timeSource !== undefined && raw.timeSource !== null && String(raw.timeSource).trim() !== '') timeSource = String(raw.timeSource);
    if (raw.status === 'available') {
      status = 'available';
      const rawValues = raw.values && typeof raw.values === 'object' ? raw.values : {};
      for (const name of Object.keys(rawValues)) values[name] = rawValues[name];
      const have = specs.filter(spec => Object.prototype.hasOwnProperty.call(values, spec.name)).length;
      text = '可用：' + have + '/' + specs.length + ' 个变量有值';
    } else if (raw.status === 'no_source') {
      status = 'no_source';
      text = '本仓没有来源' + (raw.reason ? '：' + String(raw.reason) : '');
    } else if (raw.status === 'read_error') {
      status = 'read_error';
      text = '读取失败' + (raw.reason ? '：' + String(raw.reason) : '');
    } else if (raw.status === 'empty' || raw.status === 'no_data') {
      status = 'not_generated';
      text = '这一类本轮没有生成' + (raw.reason ? '：' + String(raw.reason) : '（读过，0 条）');
    } else if (raw.status === 'not_generated') {
      status = 'not_generated';
      text = '这一类本轮没有生成' + (raw.reason ? '：' + String(raw.reason) : '');
    }
  }

  return { status, text, values, source, timeSource, appliesTo, specs };
}

function evidenceStatusChip(classData) {
  if (classData.status === 'available') return '<span class="chip ok">' + escapeHtml(classData.text) + '</span>';
  if (classData.status === 'no_source') return '<span class="chip warn">本仓没有来源</span>';
  if (classData.status === 'read_error') return '<span class="chip stop">读取失败</span>';
  return '<span class="chip">这一类本轮没有生成</span>';
}

function evidenceClassHtml(data, classId) {
  const classData = evidenceClassData(data, classId);
  const specs = classData.specs;
  const checked = state.evidenceSelection && state.evidenceSelection[classId] === true;
  const sourceText = classData.source === '' ? '本处未记' : classData.source;
  const timeText = classData.timeSource === '' ? '本处未记' : classData.timeSource;
  const fieldsText = classData.appliesTo.length === 0 ? '本处未记' : classData.appliesTo.join(' / ');
  return '<div class="rule-sect" style="border-top:1px solid var(--line)">'
    + '<label style="flex-direction:row;align-items:center;gap:8px">'
    + '<input type="checkbox" data-evidence-class="' + escapeHtml(classId) + '"'
    + ' data-evidence-bundle="evidence_' + escapeHtml(classId) + '"' + (checked ? ' checked' : '') + '>'
    + '<strong style="white-space:nowrap">' + escapeHtml(EVIDENCE_CLASS_LABELS[classId] || classId) + '</strong>'
    + '<span class="chip">' + specs.length + ' 个变量</span>'
    + evidenceStatusChip(classData)
    + '</label>'
    + '<div class="opt-meta">来源：' + escapeHtml(sourceText)
    + ' · 时间：' + escapeHtml(timeText)
    + ' · 适用字段：' + escapeHtml(fieldsText) + '</div>'
    + '<div class="hint">' + escapeHtml(classData.text) + '。未勾选 = not_selected（不在变量袋里），不是 no_data。</div>'
    + '</div>';
}

function promptEvidenceSidebarInner(data) {
  const classes = ['asin', 'competitor', 'review', 'kw_master', 'kw_coverage', 'geo', 'policy'];
  return '<div class="bar" style="border-bottom:none;flex-wrap:wrap">'
    + '<span class="chip">七类证据</span>'
    + '<span class="opt-meta">勾选后注入变量袋；未勾选 = not_selected，不是「没有数据」</span>'
    + '</div>'
    + classes.map(classId => evidenceClassHtml(data, classId)).join('');
}

function promptEvidenceSidebarHtml(data) {
  return '<div class="rule-sect">证据侧栏（七类，勾选进变量袋）</div>'
    + '<div id="promptEvidenceSidebar">' + promptEvidenceSidebarInner(data) + '</div>';
}

function variableBagStatus(spec, data) {
  if (spec.evidenceClass === 'baseline') {
    const value = data && data.variables ? data.variables[spec.name] : undefined;
    if (!promptValueMissing(value)) return '<span class="chip ok">已注入</span>';
    return '<span class="chip warn">未提供（缺 → ' + escapeHtml(spec.missingBehaviorKind || 'fail') + '）</span>';
  }
  const selected = state.evidenceSelection && state.evidenceSelection[spec.evidenceClass] === true;
  if (!selected) return '<span class="chip">未注入（未勾选）</span>';
  const classData = evidenceClassData(data, spec.evidenceClass);
  if (Object.prototype.hasOwnProperty.call(classData.values, spec.name)
    && !promptValueMissing(classData.values[spec.name])) {
    return '<span class="chip ok">已注入</span>';
  }
  if (classData.status === 'no_source') return '<span class="chip warn">本仓没有来源</span>';
  if (classData.status === 'read_error') return '<span class="chip stop">读取失败</span>';
  if (classData.status === 'not_generated') return '<span class="chip">这一类本轮没有生成</span>';
  return '<span class="chip warn">缺 → ' + escapeHtml(spec.missingBehaviorKind || 'placeholder') + '</span>';
}

function promptVariableBagInner(data) {
  const registry = (data && data.registry) || [];
  if (registry.length === 0) {
    return '<div class="hint">注册表为空 —— 页面不自己抄一份变量清单；服务端没下发 registry 时这一格只能如实说「没读到」。</div>';
  }
  const baseline = registry.filter(spec => spec.evidenceClass === 'baseline').length;
  /* Cards, not an eight-column table: the editor's right column is narrow, and a
     wide table cut off 来源/缺失行为/必填/适用字段 at 1366 px. A card keeps all
     seven contract fields readable without horizontal scrolling. */
  const rows = registry.map(spec => '<div class="rule-sect" data-variable="' + escapeHtml(spec.name) + '"'
    + ' style="border-top:1px solid var(--line)">'
    + '<div class="bar" style="border-bottom:none;flex-wrap:wrap">'
    + '<code>' + escapeHtml(spec.name) + '</code>'
    + '<span class="chip">类型：' + escapeHtml(spec.type || '') + '</span>'
    + '<span class="chip">' + (spec.required === true ? '必填' : '可选') + '</span>'
    + '<span class="opt-meta" style="margin-left:auto">状态：' + variableBagStatus(spec, data) + '</span>'
    + '</div>'
    + '<div><strong>中文含义：' + escapeHtml(spec.label || '') + '</strong> · ' + escapeHtml(spec.description || '') + '</div>'
    + '<div class="opt-meta">来源：' + escapeHtml(spec.source || '本处未记')
    + ' · 默认行为：' + escapeHtml(spec.defaultBehavior || '本处未记')
    + ' · 缺失行为：' + escapeHtml(spec.missingBehavior || '')
    + ' · 适用字段：' + escapeHtml((spec.appliesTo || []).join(' / ') || 'all')
    + '</div>'
    + '</div>').join('');
  return '<div class="bar" style="border-bottom:none;flex-wrap:wrap">'
    + '<span class="chip">共 ' + registry.length + ' 个变量</span>'
    + '<span class="chip">基线 ' + baseline + '</span>'
    + '<span class="chip">证据 ' + (registry.length - baseline) + '</span>'
    + '<span class="opt-meta">缺失行为三态：omit 整段消失 / placeholder 印固定文案 / fail 拒绝渲染</span>'
    + '</div>'
    + rows;
}

function promptVariableBagHtml(data, selected) {
  const missing = selected && selected.missing ? selected.missing : null;
  let warn = '';
  if (missing && missing.degraded === true) {
    const required = Array.isArray(missing.missingRequired) ? missing.missingRequired : [];
    warn = '<div class="hint" style="color:var(--warn)">⚠️ 必填变量缺失：'
      + escapeHtml(required.map(item => item.name + '（' + (item.source || '来源未登记') + '）').join('；'))
      + ' —— 这一段现在是空的，不是提示词选择了不说。</div>';
  } else if (missing && Array.isArray(missing.droppedOptional) && missing.droppedOptional.length > 0) {
    warn = '<div class="hint">可选段被整段移除：'
      + escapeHtml(missing.droppedOptional.map(item => item.name).join('、'))
      + '（设计内降级，不是缺失；给了值就会回来）。</div>';
  }
  return '<div class="rule-sect">变量（来源 / 必填 / 默认行为 / 缺失行为）· 变量袋（43 个变量：4 基线 + 39 证据）</div>'
    + warn
    + '<div id="promptVariableBag">' + promptVariableBagInner(data) + '</div>';
}

function wireEvidenceSidebar() {
  const form = $('promptForm');
  if (!form || typeof form.querySelectorAll !== 'function') return;
  const boxes = form.querySelectorAll('input[data-evidence-class]');
  for (const box of boxes) {
    box.onchange = () => {
      const classId = box.dataset ? box.dataset.evidenceClass : null;
      if (!classId) return;
      if (!state.evidenceSelection || typeof state.evidenceSelection !== 'object') state.evidenceSelection = {};
      state.evidenceSelection[classId] = box.checked === true;
      const data = state.prompts && state.prompts.editor;
      const host = document.getElementById('promptVariableBag');
      if (data && host) host.innerHTML = promptVariableBagInner(data);
    };
  }
}

/* 预览的变量袋 = 基线值 + 已勾选证据类里**真的有值**的变量。没勾选不注入；
   勾选了但没值也不伪造 —— 交给服务端按注册的缺失行为报 omit/placeholder/fail。 */
function buildPreviewVariables(data) {
  const bag = {};
  const baseline = (data && data.variables) || {};
  for (const name of Object.keys(baseline)) bag[name] = baseline[name];
  const registry = (data && data.registry) || [];
  for (const spec of registry) {
    if (spec.evidenceClass === 'baseline') continue;
    if (!state.evidenceSelection || state.evidenceSelection[spec.evidenceClass] !== true) continue;
    const classData = evidenceClassData(data, spec.evidenceClass);
    if (Object.prototype.hasOwnProperty.call(classData.values, spec.name)
      && !promptValueMissing(classData.values[spec.name])) {
      bag[spec.name] = classData.values[spec.name];
    }
  }
  return bag;
}

/* 预览结果必须带解释：哪些 fail、哪些 placeholder、哪些 omit、哪些截断。
   没有解释的纯文本会把「洞」读成「提示词选择了不说」。 */
function previewExplainHtml(result) {
  if (!result || typeof result !== 'object') return '';
  const blocks = [];
  const missing = Array.isArray(result.missingNamed) ? result.missingNamed
    : (Array.isArray(result.missing_required) ? result.missing_required : []);
  if (missing.length > 0) {
    blocks.push('<div class="hint" style="color:var(--stop)">拒绝渲染（fail）：'
      + missing.map(item => escapeHtml(item.name) + (item.source ? '（来源：' + escapeHtml(item.source) + '）' : '')).join('；')
      + '</div>');
  }
  const placeholders = Array.isArray(result.placeholders) ? result.placeholders : [];
  if (placeholders.length > 0) {
    blocks.push('<div class="hint" style="color:var(--warn)">降级为固定占位（placeholder）：'
      + placeholders.map(item => escapeHtml(item.name) + ' → ' + escapeHtml(item.text || '本处未记')).join('；')
      + '</div>');
  }
  const dropped = Array.isArray(result.droppedOptional) ? result.droppedOptional
    : (Array.isArray(result.dropped_optional) ? result.dropped_optional : []);
  if (dropped.length > 0) {
    blocks.push('<div class="hint">整段消失（omit）：'
      + dropped.map(item => escapeHtml(item.name)).join('、')
      + ' —— 设计内降级，不是缺失。</div>');
  }
  const pairs = Array.isArray(result.pairMissing) ? result.pairMissing : [];
  if (pairs.length > 0) {
    blocks.push('<div class="hint" style="color:var(--stop)">配对缺失（拒绝渲染）：'
      + pairs.map(item => escapeHtml(item.name) + '（被 ' + escapeHtml(item.requiredBy || '?') + ' 需要）').join('；')
      + '</div>');
  }
  const truncated = Array.isArray(result.truncated) ? result.truncated : [];
  if (truncated.length > 0) {
    blocks.push('<div class="hint" style="color:var(--warn)">已截断：'
      + truncated.map(item => escapeHtml(item.name) + '（原 ' + item.originalLength + ' → 上限 ' + item.maxLength + '）').join('；')
      + '</div>');
  }
  if (blocks.length === 0) {
    blocks.push('<div class="hint">没有降级：引用的变量都有值。</div>');
  }
  return blocks.join('');
}

/* F11-09 引用追踪 —— 「这条提示词被哪些运行用过？」
 *
 * ## 为什么是两个块，而不是一行「被 N 次运行使用」
 *
 * optimize run 的包里存了**活动版本的权威版本号**；agent run 只存了集合 id，它同行的
 * prompt_set.version 在本仓库从不更新。把两者加成一个数字，就是本仓反复付代价的
 * 「把缺失渲染成真实值」。所以页面出两个块，各自带**自己的证据等级**，且写明为什么不加。
 *
 * ## 与 promptHistoryHtml 同一条纪律
 *
 * 「字段不存在」（未加载）与「值为空」（确实没有引用）必须分开说 —— 前者是这一行没带
 * 引用数据，后者是查过了、结果是零。把两者画成同一句「没有引用」是在造替身。
 */
function promptReferencesHtml(selected) {
  const head = '<div class="rule-sect">引用追踪（被哪些运行用过）</div>';
  const hasField = selected !== null && selected !== undefined
    && Object.prototype.hasOwnProperty.call(selected, 'references');
  if (!hasField) {
    return head + '<div class="hint">（这一行没有带引用数据）—— 未加载与「确实没有运行用过它」'
      + '是两回事，这里说的是前者。</div>';
  }
  const refs = selected.references && typeof selected.references === 'object' ? selected.references : null;
  const byVersion = refs && Array.isArray(refs.byVersion) ? refs.byVersion : [];
  const bySetOnly = refs && Array.isArray(refs.bySetOnly) ? refs.bySetOnly : [];
  const scanned = refs && refs.scanned && typeof refs.scanned === 'object' ? refs.scanned : null;
  const complete = refs ? refs.scannedComplete === true : false;

  const versionRows = byVersion.map(entry => '<div class="prompt-version" data-run="' + escapeHtml(entry.runId) + '">'
    + '<span class="pv-ver">' + escapeHtml(entry.asin) + ' · ' + escapeHtml(entry.marketplace) + '</span>'
    + '<span class="pv-time">' + escapeHtml(entry.startedAt ? historyTime(entry.startedAt) : '—') + '</span>'
    + '<div class="pv-body">用 v' + escapeHtml(String(entry.version === null ? '—' : entry.version))
    + (entry.isCurrent === true ? '（仍是当前版）' : entry.version === null ? '（包里没写版本）' : '（已过期）')
    + ' · 层 ' + escapeHtml(entry.layer === null ? '—' : entry.layer)
    + ' · ' + escapeHtml(entry.status) + '</div></div>').join('');

  const setRows = bySetOnly.map(entry => '<div class="prompt-version" data-run="' + escapeHtml(entry.runId) + '">'
    + '<span class="pv-ver">' + escapeHtml(entry.role) + '</span>'
    + '<span class="pv-time">' + escapeHtml(entry.startedAt ? historyTime(entry.startedAt) : '—') + '</span>'
    + '<div class="pv-body">用的版本 <strong>未知</strong>'
    + '（它存的是 ' + escapeHtml(entry.storedSetVersion === null ? '—' : String(entry.storedSetVersion))
    + '，那是从不更新的集合版本） · ' + escapeHtml(entry.status) + '</div></div>').join('');

  let html = head;
  html += '<div class="hint">① 能定位到<strong>具体版本</strong>的运行：' + byVersion.length + ' 条。'
    + 'optimize run 的包定格了活动版本的权威版本号，所以能回答「报告用的是第几版」。</div>';
  html += byVersion.length === 0
    ? '<div class="hint">（没有 optimize run 的包里出现过这一条 —— 这不等于「没人用过它」，'
      + '只是没有运行的包记下了它。）</div>'
    : '<div class="prompt-history" id="promptRefsByVersion">' + versionRows + '</div>';

  html += '<div class="hint" style="margin-top:8px">② 只能定位到<strong>集合</strong>的运行：' + bySetOnly.length + ' 条。'
    + 'agent run 只记了取自哪个集合，所以这些是<strong>候选</strong>（这一次运行取自这个集合，'
    + '可能包含、也可能不包含这一条），不是匹配。</div>';
  html += bySetOnly.length === 0
    ? '<div class="hint">（没有 agent run 的快照里出现过这一条所属的集合。）</div>'
    : '<div class="prompt-history" id="promptRefsBySet">' + setRows + '</div>';

  /* 扫描范围必须说出来：「3 条」与「只扫了前 3 条」不能长得一样。 */
  const opt = scanned && scanned.optimize ? scanned.optimize : null;
  const ag = scanned && scanned.agent ? scanned.agent : null;
  if (opt !== null || ag !== null) {
    html += '<div class="hint">扫描范围：optimization_run 读了 ' + countOr(opt ? opt.read : null, 0)
      + ' 条（上限 ' + countOr(opt ? opt.limit : null, 0) + '，其中 ' + countOr(opt ? opt.carriedPrompts : null, 0)
      + ' 条包里带 prompts）；agent_run 读了 ' + countOr(ag ? ag.read : null, 0)
      + ' 条（上限 ' + countOr(ag ? ag.limit : null, 0) + '）。</div>';
    if (!complete) {
      html += '<div class="hint"><strong>⚠️ 扫描触到了上限</strong>：上面的条数是「读到的范围内」的条数，'
        + '可能还有更早的运行没被读到。</div>';
    }
  }
  html += '<div class="hint">两个块<strong>不能相加</strong>：① 是「这一条被用过」的证据，'
    + '② 是「这一次运行取自这个集合」的证据 —— 后者既不能确认也不能排除用过这一条。</div>';
  html += '<div class="hint">「版本被采纳的字段 + 30 天观测结论」的关联尚未建模，'
    + '所以这里只回答「被哪些运行用过」，不回答「用了之后效果如何」。</div>';
  return html;
}

/* One POST, one fact: "this prompt is now this". The route calls the same
   upsertPrompt the tool does, so the editor cannot save something the tool would
   refuse — the validation lives at the store, not in two places. */
async function savePrompt(selected) {  const layerInput = $('promptLayer');
  const body = {
    id: selected.id,
    module: selected.module,
    scenario: selected.scenario,
    layer: selected.scenario === 'assemble' && layerInput ? layerInput.value : null,
    label: $('promptLabel').value,
    body: $('promptBody').value,
    enabled: $('promptEnabled').checked,
  };
  try {
    await api('prompt-save', { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* The preview is the server's renderer, not a copy in the page — so a template
   that fails here fails at save time too, and a typo shows the error instead of a
   silently empty string. The missing report rides back on the same answer, so the
   page can say 「这一段现在是空的」 instead of showing a hole as if it were prose. */
function promptMissingWarning(report) {
  if (!report) return '';
  if (report.degraded) {
    const items = (report.missing_required || []).map(item => item.name + '（' + (item.source || '来源未登记') + '）');
    return '必填变量缺失：' + items.join('；') + ' —— 这一段现在是空的，不是提示词选择了不说。';
  }
  if ((report.dropped_optional || []).length > 0) {
    return '可选段被整段移除：' + report.dropped_optional.map(item => item.name).join('、')
      + '（设计内降级，不是缺失）。';
  }
  return '';
}

async function previewPromptBody() {
  const out = $('promptPreviewOut');
  if (!out) return;
  const data = state.prompts && state.prompts.editor;
  /* 变量袋扩集：基线 + 已勾选证据类里真的有值的变量。未勾选不注入；勾选但没值
     也不伪造，让服务端按注册的缺失行为报 omit/placeholder/fail。 */
  const variables = buildPreviewVariables(data);
  try {
    const result = await api('prompt-preview', {
      method: 'POST',
      body: JSON.stringify({ body: $('promptBody').value, variables }),
    });
    out.className = 'prompt-preview';
    out.innerHTML = previewExplainHtml(result) + escapeHtml(result.text);
  } catch (error) {
    out.className = 'prompt-preview err';
    out.textContent = (error && error.message) ? error.message : String(error);
  }
}

function connect() {
  const events = new EventSource(PAGE + '/events');
  /* Every prefix that means "something you are looking at has changed". The list
     is a prefix test rather than an equality test on the whole kind, so a new
     event inside an existing module (rule:publish, competitor:set) refreshes
     without a second edit here. A kind that is missing from this list fails
     silently — the panel just keeps showing the old answer — which is why the
     modules that write anything are all named.
     NB: no backticks in this comment — it sits inside the script string.
     The phase-1 prefixes (home / quality / notification / audit) are named
     ahead of the batches that emit them: a kind missing from this list fails
     silently, and the cheapest time to add one is while the list is open. */
  const REFRESH_PREFIXES = ['collect:', 'keyword:', 'optimize:', 'rule:', 'policy:', 'prompt:', 'pipeline:', 'competitor:', 'research:', 'setting:', 'source:', 'home:', 'quality:', 'notification:', 'audit:'];
  events.onmessage = (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    if (event.kind === 'context') { adoptContext(event.payload); render(); return; }
    if (event.kind === 'tool:done' || REFRESH_PREFIXES.some(prefix => event.kind.indexOf(prefix) === 0)) {
      refresh().catch(() => {});
    }
  };
  events.onerror = () => { /* EventSource reconnects on its own */ };
}

/* ── wiring ───────────────────────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

/* P3-5 空态约定（页面端）。四种"没有"固定成四个 kind：
     none         读到了，答案是 0
     not-recorded 还没记录过，可以补 —— 要给下一步
     no-source    本仓没有这类来源 —— 不能建议去补
     filtered     有数据但被筛掉了 —— 要说明怎么放宽
   把 none 与 no-source 混成一句「暂无数据」，正是这个仓反复拒绝的错。
   服务端那一份在 domain/ui/empty-state（同语义，客户端无模块系统，故复制一份）。 */
const EMPTY_KINDS = ['none', 'not-recorded', 'no-source', 'filtered'];
function emptyState(kind, options) {
  const opts = options || {};
  const subject = opts.subject || '数据';
  if (EMPTY_KINDS.indexOf(kind) === -1) {
    throw new Error('emptyState: 未知类型 ' + kind + '，只能选 ' + EMPTY_KINDS.join(' | '));
  }
  const reason = opts.reason === null || opts.reason === undefined ? '' : String(opts.reason).trim();
  /* 中英相邻留空格：「Agent 运行」直接拼会得到「还没有Agent 运行。」。
     只在首字符是 ASCII 字母或数字时补 —— 中文主语不需要。 */
  const spaced = /^[A-Za-z0-9]/.test(subject) ? ' ' + subject : subject;
  const head = reason !== ''
    ? reason
    : (kind === 'none' ? '没有' + spaced + '。'
      : kind === 'not-recorded' ? '还没有' + spaced + '。'
        : kind === 'no-source' ? '本系统没有' + spaced + '的来源 —— 这一类数据采不到，补也补不出来。'
          : spaced + '有，但当前的筛选条件一条都没留下。');
  const parts = [head];
  const next = opts.next === null || opts.next === undefined ? '' : String(opts.next).trim();
  if (kind === 'no-source') {
    parts.push('这不是"还没做"，是本仓不提供这个来源。');
  } else if (next !== '') {
    parts.push(next);
  } else if (kind !== 'none' && reason === '') {
    parts.push(kind === 'filtered' ? '（放宽筛选条件就能看到）' : '（还没给下一步做什么）');
  }
  /* allowMarkup：**出口而不是默认**。默认必须转义，因为空态文案常混着库里的值
     （ASIN / 关键词 / 错误信息），不转义就是一个藏在最人畜无害函数里的 XSS 口子。
     但有一批既有空态本来就用 strong 标签断句，一律转义会把它们改成平文。
     所以给一个显式出口：传 allowMarkup: true 就是声明「这段是静态文案，无用户数据」。
     （No backticks in this comment — this whole file is one template literal.） */
  const body = opts.allowMarkup === true ? parts.join(' ') : escapeHtml(parts.join(' '));
  return '<div class="empty" data-empty-kind="' + kind + '">' + body + '</div>';
}

/* 服务端下发的空切片 { kind, text }（domain 自己的词）→ 页面四态。
 *
 * 为什么要有这一层：domain 说的是 no-run / no-gates / not-modelled，
 * 页面说的是 none / not-recorded / no-source / filtered —— 两套词汇之间必须有一张
 * **显式**的表，而表放在 domain（domain/ui/empty-kind.js）。页面查表，不自己判断。
 *
 * 映射不上怎么办：**保持原文案，并标 data-slice-missing**。
 * 不兜底成 not-recorded —— 那会让「我们不认识这个 kind」看起来像「还没记录」，
 * 也就是把代码缺陷伪装成数据状态。标出来之后，漏映射在 DOM 上也是可见的。 */
function sliceEmpty(empty) {
  const text = empty && empty.text === undefined ? '' : String((empty || {}).text || '');
  if (text === '') return '';
  const domainKind = String((empty || {}).kind || '');
  const uiKind = DOMAIN_EMPTY_KIND_TO_UI[domainKind];
  if (uiKind === undefined) {
    return '<div class="empty" data-slice-missing="empty-kind:' + escapeHtml(domainKind) + '">'
      + escapeHtml(text) + '</div>';
  }
  return emptyState(uiKind, { reason: text });
}

/* ── P3-4 命令面板（Ctrl+K）───────────────────────────────────────────────
   数据在 state.commandPalette（载荷顶层，任何时候都有 21 条：15 模块 + 6 动作）。
   这里只做浮层与键盘；**跳转沿用 followTodo** —— 和待办、最近访问、搜索结果
   同一条导航，所以不存在"面板跳到一个导航里没有的地方"。

   为什么浮层用 JS 动态建、不写进 HTML：它会出现在**每一个**页签上，
   写进模板就要在 15 个面板之间再插一个节点，而它和任何面板都无关。
   样式在 page.js 的 <style> 里（.cmd-palette 一族）。

   刻意**不做**数据类命令：那要服务端查十类实体，不该被每 3 秒的轮询带上。
   首页那个搜索框本来就是干这件事的，这里不造第二个入口。
   （No backticks in this comment — this whole file is one template literal.） */
let cmdPaletteEl = null;
let cmdSelected = 0;
let cmdRows = [];

function cmdSource() {
  const data = state.commandPalette;
  return data && Array.isArray(data.commands) ? data.commands : [];
}

function cmdMark() {
  const box = document.getElementById('cmdList');
  if (box === null) return;
  const rows = box.querySelectorAll('.cmd-row');
  for (let i = 0; i < rows.length; i += 1) {
    if (i === cmdSelected) {
      rows[i].classList.add('sel');
      if (rows[i].scrollIntoView) rows[i].scrollIntoView({ block: 'nearest' });
    } else {
      rows[i].classList.remove('sel');
    }
  }
}

function cmdRender() {
  const box = document.getElementById('cmdList');
  if (box === null) return;
  const input = document.getElementById('cmdInput');
  const needle = input === null ? '' : String(input.value || '').trim().toLowerCase();
  const all = cmdSource();
  cmdRows = all.filter((command) => needle === ''
    || (String(command.label || '') + ' ' + String(command.detail || '') + ' ' + String(command.link || ''))
      .toLowerCase().indexOf(needle) !== -1);
  if (cmdSelected >= cmdRows.length) cmdSelected = Math.max(0, cmdRows.length - 1);

  if (cmdRows.length === 0) {
    box.innerHTML = '<div class="cmd-empty">' + escapeHtml(all.length === 0
      ? '命令数据还没到 —— 页面刚打开时会有一次加载；如果一直没有，说明载荷里缺 commandPalette。'
      : '没有匹配的模块或动作。数据类搜索在首页那个搜索框里（它要查十类实体）。') + '</div>';
  } else {
    const kindLabel = { module: '模块', action: '动作', data: '数据' };
    box.innerHTML = cmdRows.map((command, index) => '<div class="cmd-row'
      + (index === cmdSelected ? ' sel' : '') + '" data-cmd="' + index + '">'
      + '<span class="cmd-kind">' + escapeHtml(kindLabel[command.kind] || command.kind) + '</span>'
      + '<span class="cmd-label">' + escapeHtml(String(command.label || '')) + '</span>'
      + (command.detail ? '<span class="cmd-detail">' + escapeHtml(String(command.detail)) + '</span>' : '')
      + '</div>').join('');
    const rows = box.querySelectorAll('[data-cmd]');
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      row.onclick = () => cmdRun(Number(row.getAttribute('data-cmd')));
      row.onmouseenter = () => { cmdSelected = Number(row.getAttribute('data-cmd')); cmdMark(); };
    }
  }

  const count = document.getElementById('cmdCount');
  if (count !== null) {
    count.textContent = all.length === 0 ? '数据未到'
      : ('共 ' + all.length + ' 条' + (cmdRows.length === all.length ? '' : '，匹配 ' + cmdRows.length + ' 条'));
  }
}

function cmdClose() {
  if (cmdPaletteEl !== null) cmdPaletteEl.hidden = true;
}

function cmdRun(index) {
  const command = cmdRows[index];
  if (command === undefined) return;
  cmdClose();
  followTodo(command.link, {});
}

function cmdKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    cmdSelected = Math.min(cmdRows.length - 1, cmdSelected + 1);
    cmdMark();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    cmdSelected = Math.max(0, cmdSelected - 1);
    cmdMark();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    cmdRun(cmdSelected);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cmdClose();
  }
}

function cmdToggle() {
  if (cmdPaletteEl === null) {
    cmdPaletteEl = document.createElement('div');
    /* id 与 class 都要：class 给样式，id 给 getElementById —— 少了 id，元素明明在
       DOM 里却查不到，我的第一版就是这样，诊断时看到「找不到」还以为没创建。 */
    cmdPaletteEl.id = 'cmdPalette';
    cmdPaletteEl.className = 'cmd-palette';
    cmdPaletteEl.hidden = true;
    cmdPaletteEl.innerHTML = '<div class="cmd-box">'
      + '<input id="cmdInput" type="text" autocomplete="off" placeholder="跳到模块 / 执行动作…（Esc 关闭）">'
      + '<div class="cmd-list" id="cmdList"></div>'
      + '<div class="cmd-foot"><span id="cmdCount"></span>'
      + '<span>↑↓ 选择 · Enter 打开 · Esc 关闭 · Ctrl+K 再按一次收起</span></div>'
      + '</div>';
    document.body.appendChild(cmdPaletteEl);
    const input = document.getElementById('cmdInput');
    /* 元素级事件用**属性赋值**，全局事件用**裸 addEventListener** —— 这是本仓的既有约定
       （见 page.js 里 resize 那一行的写法）。测试替身的 document 只实现了裸的那个，
       document.addEventListener 不存在；用错会让整段脚本在替身里加载失败
       —— 实测一次挂掉 162 个断言。 */
    input.oninput = () => { cmdSelected = 0; cmdRender(); };
    input.onkeydown = cmdKeydown;
    /* 点浮层背景关闭，点内容不关 —— 与通知浮层同一套习惯 */
    cmdPaletteEl.onclick = (event) => {
      if (event.target === cmdPaletteEl) cmdClose();
    };
  }

  if (cmdPaletteEl.hidden === false) { cmdClose(); return; }
  cmdSelected = 0;
  const input = document.getElementById('cmdInput');
  if (input !== null) input.value = '';
  cmdPaletteEl.hidden = false;
  cmdRender();
  if (input !== null) input.focus();
}

/* Ctrl+K / Cmd+K 开关；Esc 在浮层打开时关掉它。
   event.key 统一转小写，所以 Ctrl+Shift+K 也能识别 —— 大写锁定或 shift 不会让它失灵。
   裸 addEventListener 是全局（window）级别，与本仓 page.js 的 resize 监听同一写法。 */
addEventListener('keydown', (event) => {
  const key = String(event.key || '').toLowerCase();
  if (key === 'k' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    cmdToggle();
    return;
  }
  if (key === 'escape' && cmdPaletteEl !== null && cmdPaletteEl.hidden === false) {
    event.preventDefault();
    cmdClose();
  }
});

/* 顶栏放一个可点的入口：纯键盘快捷键等于**没有入口**，第一次用的人不会知道它存在。
   挂载是**尽力而为**的：测试替身里的 header 不一定支持 appendChild，那里挂不上
   只影响"多一个按钮"，不该让整段脚本加载失败。 */
(function cmdMountHeaderButton() {
  const header = document.querySelector('header');
  if (header === null || typeof header.appendChild !== 'function') return;
  if (typeof document.createElement !== 'function') return;
  const button = document.createElement('button');
  button.id = 'cmdOpen';
  button.type = 'button';
  button.textContent = 'Ctrl+K';
  button.title = '命令面板：跳到模块 / 执行动作';
  button.style.cssText = 'font:inherit;font-size:12px;padding:4px 9px;border:1px solid var(--line);border-radius:6px;background:none;color:var(--dim);cursor:pointer';
  button.onclick = () => cmdToggle();
  header.appendChild(button);
})();

let timer;
$('q').oninput = (event) => {
  clearTimeout(timer);
  timer = setTimeout(() => patchContext({ filters: { ...state.filters, q: event.target.value } }), 250);
};
$('marketplace').onchange = (event) => patchContext({ filters: { ...state.filters, marketplace: event.target.value } });
$('order').onchange = (event) => patchContext({ filters: { ...state.filters, order: event.target.value } });

/* ── F05-01 的四个控件：产品线 / 品牌 / 清除筛选 / 列配置与视图 ──────────────────
   四个都写进 filters（而不是留在页面变量里）：筛选与列配置要活过一次 3 秒轮询，
   而轮询会把 state.filters 整个换掉。留在页面变量里的东西活不过那一次。 */
$('asinLine').onchange = (event) => patchContext({ filters: { ...state.filters, productLineId: event.target.value } });
$('asinBrand').onchange = (event) => patchContext({ filters: { ...state.filters, brand: event.target.value } });
/* 归档三态。写的是三个字面值之一，**永远不写空串** —— 空串在数据层会走默认 hide，
   而那正是这张表明确不要的口径（见 routes.js 的 ASIN_PAGE_ARCHIVED）。 */
$('asinArchived').onchange = (event) => patchContext({ filters: { ...state.filters, archived: event.target.value } });
/* 清除筛选清的是**这张表自己的四个键**，不是整个 filters 袋子：袋子里还装着
   别的面板的键（masterLine / policyStatus / runId…），一起清掉会让「清除筛选」
   顺手改掉一个你没在看的页面。
   archived **不删、改成 all**：删掉它之后查询会落到数据层的默认 hide，
   于是「清除筛选」会顺手把归档的行藏起来 —— 一个清筛选的按钮改掉了这一页的口径。 */
$('asinClearFilters').onclick = () => {
  const next = { ...state.filters, archived: 'all' };
  for (const key of ['marketplace', 'productLineId', 'brand', 'q', 'order', 'asinView']) delete next[key];
  patchContext({ filters: next });
};
$('asinColReset').onclick = () => patchContext({ filters: { ...state.filters, asinCols: ASIN_DEFAULT_COLUMNS.join(',') } });
$('asinViewPick').onchange = (event) => {
  /* 选中即加载：选择框里选一个视图却什么都不发生，是这一类控件最常见的假成功。
     空值（「未选择视图」）只清掉「当前是哪个视图」这个标记，不动筛选 ——
     它是「我不再用某个视图」的意思，不是「把筛选清空」。 */
  const name = String(event.target.value || '');
  if (name === '') patchContext({ filters: { ...state.filters, asinView: '' } });
  else loadAsinView(name);
};
$('asinViewLoad').onclick = () => {
  const name = String($('asinViewPick').value || '').trim() || String($('asinViewName').value || '').trim();
  if (name === '') return;
  loadAsinView(name);
};
$('asinViewSave').onclick = () => {
  const name = String($('asinViewName').value || '').trim() || String($('asinViewPick').value || '').trim();
  if (name === '') {
    $('asinViewsHint').innerHTML = '保存视图需要一个名字 —— 名字为空时选择框里会出现一行看不见的选项，而它确实可点。';
    return;
  }
  /* 存的是**输入**：这一屏的五个筛选键 + 当前可见列。不存结果 —— 结果会随库变旧，
     而一个「保存视图」看起来像一张报表、却不是当下的库。 */
  const filters = {};
  for (const key of ['marketplace', 'productLineId', 'brand', 'q', 'order']) {
    if (state.filters[key] !== undefined) filters[key] = state.filters[key];
  }
  api('asin-view-save', {
    method: 'POST',
    body: JSON.stringify({ name, filters, columns: asinVisibleColumns().map(column => column.id) }),
  }).then(data => {
    if (Array.isArray(data.views)) state.asinSavedViews = data.views;
    if (Array.isArray(data.droppedColumns) && data.droppedColumns.length > 0) {
      $('asinViewsHint').innerHTML = '⚠️ 认不出的列 id 没有存进去：'
        + escapeHtml(data.droppedColumns.join('、'));
    }
    return patchContext({ filters: { ...state.filters, asinView: name } });
  }).catch(error => {
    $('asinViewsHint').innerHTML = '保存视图失败：' + escapeHtml(String(error.body?.error ?? error.message));
  });
};
$('asinViewDelete').onclick = () => {
  const name = String($('asinViewPick').value || '').trim() || String($('asinViewName').value || '').trim();
  if (name === '') {
    $('asinViewsHint').innerHTML = '删除视图要先选中它 —— 名字为空时不知道要删哪一个。';
    return;
  }
  api('asin-view-delete', { method: 'POST', body: JSON.stringify({ name }) }).then(data => {
    if (Array.isArray(data.views)) state.asinSavedViews = data.views;
    const next = { ...state.filters };
    if (String(next.asinView || '') === name) delete next.asinView;
    return patchContext({ filters: next });
  }).catch(error => {
    /* 404（本来就没有这个视图）与保存失败是两句话：前者什么都没发生，
       后者可能写了一半。错误码由服务端给，页面照印不翻译。 */
    $('asinViewsHint').innerHTML = '删除视图：' + escapeHtml(String(error.body?.error ?? error.message));
  });
};
$('asinExportCsv').onclick = () => exportAsinCsv();
let kwTimer;
$('kwq').oninput = (event) => {
  clearTimeout(kwTimer);
  kwTimer = setTimeout(() => patchContext({ filters: { ...state.filters, q: event.target.value } }), 250);
};
$('kwtier').onchange = (event) => patchContext({ filters: { ...state.filters, tier: event.target.value } });
$('kworder').onchange = (event) => patchContext({ filters: { ...state.filters, order: event.target.value } });
/* The master library's controls write their own filter keys rather than reusing
   "order" / "tier": those belong to the other keyword tab, and sharing them
   would mean changing the sort here silently re-sorted a table you were not
   looking at. "q" IS shared, because "search the keywords" means the same thing
   in both places.
   NB: no backticks anywhere below — this whole page is one template literal,
   and a backtick in a comment ends the string. */
let kmlTimer;
$('kmlq').oninput = (event) => {
  clearTimeout(kmlTimer);
  kmlTimer = setTimeout(() => patchContext({ filters: { ...state.filters, q: event.target.value } }), 250);
};
$('kmlLine').onchange = (event) => patchContext({ filters: { ...state.filters, masterLine: event.target.value } });
$('kmlTier').onchange = (event) => patchContext({ filters: { ...state.filters, masterTier: event.target.value } });
$('kmlOrder').onchange = (event) => patchContext({ filters: { ...state.filters, masterOrder: event.target.value } });

/* 模块 08 F08-07：按状态筛。自己的 filter key（masterLifecycle），与其它面板的筛选
   互不干扰 —— 与上面三个同样的约定。 */
$('kmlLifecycle').onchange = (event) => patchContext({ filters: { ...state.filters, masterLifecycle: event.target.value } });

/* 「改生命周期」入口：写**只走路由**（路由再走工具，审计漏斗挂在工具上）。要改的是
   下面表里**点选的那一条** —— 没选中就说清楚，而不是猜一条或静默什么都不做。拒绝
   理由（含同态被拒）原样上屏。 */
$('kmlSetBtn').onclick = () => {
  const selected = (state.context.selection && state.context.selection.keywords) || [];
  const to = String($('kmlTo').value || '');
  const reasonEl = $('kmlReason');
  const reason = reasonEl === null ? '' : String(reasonEl.value || '').trim();
  if (selected.length !== 1) {
    showPageError(new Error('先在下面的表里点选一条关键词，再改它的生命周期。'));
    return;
  }
  if (to === '') {
    showPageError(new Error('先在「改生命周期 →」里选一个目标状态。'));
    return;
  }
  api('keyword-lifecycle', {
    method: 'POST',
    body: JSON.stringify({
      keyword: selected[0].keyword,
      marketplace: selected[0].marketplace,
      to: to,
      reason: reason,
      by: 'page',
    }),
  }).then(() => {
    clearPageError();
    return refresh();
  }).catch((error) => {
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  });
};

/* 模块 08 F08-04 的批量条：先预览（读，不写库），再确认（写，带 confirmed）。两个按钮
   各走一条路由，路由再走工具 —— 页面不直接调 store，否则审计漏斗被绕过。 */
$('kmlOwnPreviewBtn').onclick = () => { previewOwnershipBatch().catch((error) => showPageError(error)); };
$('kmlOwnConfirmBtn').onclick = () => confirmOwnershipBatch();

/* 模块 08 F08-05 的两个入口。「生成提案」把请求交给对话里的 Agent（提案是分析动作）；
   「保存为计划」走 keyword-plan 路由（路由再走 store 的 savePlan，审计漏斗与工具共用同一条
   action）。保存的是页面上**正在显示**的那份提案 —— 没有提案就明说，而不是猜一份或静默
   什么都不做。计划是分配决定，存下来的是**计划**，不是实际覆盖。 */
$('kmlPlanProposeBtn').onclick = () => {
  const asinEl = $('kmlPlanAsin');
  const asin = asinEl === null ? '' : String(asinEl.value || '').trim();
  usePrompt('为 ASIN ' + (asin || '(未填)') + ' 生成位置计划提案：每个词一个主人，一位一用途，先给我看，不要写库。');
};
$('kmlPlanSaveBtn').onclick = () => {
  const asinEl = $('kmlPlanAsin');
  const asin = asinEl === null ? '' : String(asinEl.value || '').trim();
  const nameEl = $('kmlPlanName');
  const name = nameEl === null ? '' : String(nameEl.value || '').trim();
  const entries = state.planProposal || [];
  if (asin === '') { showPageError(new Error('先填目标 ASIN，再保存计划。')); return; }
  if (entries.length === 0) { showPageError(new Error('页面上还没有提案可保存。先点「生成提案」。')); return; }
  api('keyword-plan', {
    method: 'POST',
    body: JSON.stringify({
      asin: asin,
      marketplace: state.planMarketplace || state.filters.marketplace || 'US',
      name: name,
      entries: entries,
      source: 'proposal',
      status: 'active',
      by: 'page',
    }),
  }).then(() => {
    clearPageError();
    return refresh();
  }).catch((error) => {
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  });
};

/* The rules panel's version selector. Its own filter key, like the master
   library's: switching versions must not disturb any other tab's sort. */
$('ruleVersion').onchange = (event) => patchContext({ filters: { ...state.filters, ruleVersion: event.target.value } });

/* The policy panel's two filters. Their own keys for the same reason: a bare
   status key would collide with nothing today, but a bare since key would be read
   as a filter by whichever panel looks for it next. */
$('policyStatus').onchange = (event) => patchContext({ filters: { ...state.filters, policyStatus: event.target.value } });
$('policySince').onchange = (event) => patchContext({ filters: { ...state.filters, policySince: event.target.value } });
$('policyClear').onclick = () => patchContext({ filters: { ...state.filters, policyStatus: '', policySince: '' } });

/* The research panel's seed box. Runs on click, not on input: a seed list is a
   question you get to finish typing, and every keystroke would re-run the
   library/competitor lookups under it. The server splits on comma and newline
   only — a space is a legal character inside a keyword ("speaker stand"), so
   treating it as a separator would silently tear that word in half. */
$('rsRun').onclick = () => patchContext({ filters: { ...state.filters, seeds: $('rsSeed').value } });
$('rsSeed').onkeydown = (event) => {
  if (event.key === 'Enter') { event.preventDefault(); patchContext({ filters: { ...state.filters, seeds: $('rsSeed').value } }); }
};

/* The competitor panel's two pickers. Both write their own filter keys: this
   panel's "which ASIN am I" is not the list's selection, and sharing the key
   would mean opening this tab yanked the row you had highlighted elsewhere.
   The set picker is rebuilt on every render, so its handler is bound here and
   reads the value back from the element rather than from a captured closure. */
$('compSet').onchange = (event) => patchContext({ filters: { ...state.filters, competitorSetId: event.target.value } });
$('compAsin').onchange = (event) => patchContext({ filters: { ...state.filters, competitorAsin: event.target.value } });

/* The report centre's four filters. Their own keys for the reason the other
   panels' are: "asin" would be read by the ASIN list and the optimize panel as a
   filter on *their* table, and a report filter silently narrowing the ASIN list
   is exactly the cross-talk the per-panel key prefix exists to prevent.
   The ASIN box commits on change rather than on each keystroke — the same reason
   the seed box does: a half-typed ASIN is a query nobody meant to run. */
$('rpKind').onchange = (event) => patchContext({ filters: { ...state.filters, reportKind: event.target.value } });
$('rpStatus').onchange = (event) => patchContext({ filters: { ...state.filters, reportStatus: event.target.value } });
$('rpMarket').onchange = (event) => patchContext({ filters: { ...state.filters, marketplace: event.target.value } });
$('rpSince').onchange = (event) => patchContext({ filters: { ...state.filters, reportSince: event.target.value } });
$('rpAsin').onchange = (event) => patchContext({ filters: { ...state.filters, reportAsin: event.target.value.trim().toUpperCase() } });
$('rpProductLine').onchange = (event) => patchContext({ filters: { ...state.filters, reportProductLine: event.target.value } });
$('rpCreatedBy').onchange = (event) => patchContext({ filters: { ...state.filters, reportCreatedBy: event.target.value } });
$('rpTag').onchange = (event) => patchContext({ filters: { ...state.filters, reportTag: event.target.value } });
$('rpFav').onchange = (event) => patchContext({
  filters: {
    ...state.filters,
    /* Cleared rather than set to false: the server treats "absent" and "false"
       the same, and leaving a false in the filter bag would make the cleared
       state look like a deliberate choice in the context payload. */
    reportFavorite: event.target.checked ? true : undefined,
  },
});
$('rpClear').onclick = () => patchContext({
  filters: {
    ...state.filters,
    reportKind: '', reportStatus: 'all', reportAsin: '', reportSince: '', marketplace: '',
    reportProductLine: '', reportCreatedBy: '', reportTag: '', reportFavorite: undefined,
  },
});
$('rpBuildKind').onchange = () => renderReports();

/* Generating one report. Same handler the tool uses (POST /api/report-build →
   domain/reports/build.js), and the row it returns is read back from the store —
   the page does not assemble a document of its own. */
$('rpBuild').onclick = async () => {
  const kind = $('rpBuildKind').value;
  if (kind === '') { $('rpBuildHint').textContent = '先选一类报告'; return; }
  const needsAsin = kind === 'asin-health' || kind === 'competitor-gap';
  const asin = $('rpBuildAsin').value.trim().toUpperCase();
  if (needsAsin && asin === '') { $('rpBuildHint').textContent = '这一类要填 ASIN'; return; }
  $('rpBuildHint').textContent = '生成中…';
  try {
    const reply = await apiWithApproval('report-build', {
      kind,
      asin: needsAsin ? asin : null,
      marketplace: needsAsin ? ($('rpBuildMarket').value || 'US') : null,
    });
    if (reply.ok !== true) { $('rpBuildHint').textContent = '没生成：' + (reply.error || '未知错误'); return; }
    $('rpBuildHint').textContent = '已登记 ' + reply.report.id + '（' + (reply.body || '').length + ' 字符）';
    state.reportFocus = reply.report.id;
    await refresh();
  } catch (error) {
    $('rpBuildHint').textContent = '没生成：' + error.message;
  }
};

/* 「复制路径」在列表 #rptable 与详情 #rpdetail 两处都会画（同一个
   reportExportBits），而这两个是兄弟节点 —— 只绑在 #rptable 上时，详情里的
   按钮点了没反应（arch 复核的 G3 block）。所以把复制抽成一个函数，两处都绑；
   T13 的规则按钮也走同一个事件委托约定。 */
async function handleReportCopy(event) {
  const copyPath = event.target.closest('[data-rp-copy]');
  if (copyPath === null) return false;
  event.preventDefault();
  const value = copyPath.getAttribute('data-rp-copy') || '';
  try {
    await navigator.clipboard.writeText(value);
    copyPath.textContent = '已复制';
    setTimeout(() => { copyPath.textContent = '复制路径'; }, 2000);
  } catch {
    /* 剪贴板被浏览器拒绝时不要把路径吞掉：选一个能读的地方给出来。 */
    window.prompt('复制失败，请手动复制路径：', value);
  }
  return true;
}

/* The two per-row writes. Delegated from the table because every row's buttons
   are re-drawn on each poll — a listener per button would be re-bound (and leak)
   three times a second. */
const reportRowClick = async (event) => {
  if (await handleReportCopy(event)) return;
  const row = event.target.closest('tr[data-report]');
  if (row === null) return;
  const id = row.getAttribute('data-report');
  const fav = event.target.closest('[data-rp-fav]');
  const arch = event.target.closest('[data-rp-arch]');
  if (fav !== null) {
    event.preventDefault();
    await reportWrite({ id, favorite: fav.getAttribute('data-rp-on') === '1' });
    return;
  }
  if (arch !== null) {
    event.preventDefault();
    await reportWrite({ id, archived: arch.getAttribute('data-rp-on') === '1', by: 'page' });
    return;
  }
  /* Clicking anywhere else in the row opens the detail block below the table. */
  state.reportFocus = id;
  renderReportDetail();
};
$('rptable').onclick = reportRowClick;
if ($('rpdetail') !== null) $('rpdetail').onclick = async (event) => { await handleReportCopy(event); };

async function reportWrite(payload) {
  try {
    const reply = await apiWithApproval('report-update', payload);
    if (reply.ok !== true) { window.alert('没改成：' + (reply.error || '未知错误')); return; }
    await refresh();
  } catch (error) {
    window.alert('没改成：' + error.message);
  }
}

async function saveReportTags(id, raw) {
  const tags = String(raw || '').split(',').map(part => part.trim()).filter(part => part !== '');
  await reportWrite({ id, tags });
}

/* Re-reading the settings page is a plain refresh. It exists as a button because
   the numbers here are the ones the collector obeys, and someone who has just
   finished a collection wants to re-read them without reloading the profile. */
$('setReload').onclick = () => refresh().catch(showPageError);

/* The two diff tables' sort selects are bound by diffSection itself, right after
   it writes the table: the select is created by that render, so there is no
   earlier moment at which it exists. Delegating from the container would work
   too, but every other control on this page binds where it is drawn, and one
   listener style is easier to keep honest than two. */

/* "Send the ticked candidates to the agent". Arch §4.6: a page button has
   exactly two outcomes — a POST of one fact, or a prompt. This panel writes
   nothing (a checkbox that silently did nothing would be worse than a sentence
   you can paste), so it is the prompt kind, and it reuses usePrompt rather than
   its own clipboard call so there is one definition of "handed to the agent".

   The prompt carries the words themselves, not "the ticked ones": the box is a
   plain textarea and the agent cannot see this page's checkboxes. */
$('rsImport').onclick = () => {
  const picked = [...$('rscands').querySelectorAll('input.kwchk:checked')].map(box => box.dataset.keyword);
  if (picked.length === 0) { $('rsHint').textContent = '先勾选要入库的关键词，再点这里。'; return; }
  const marketplace = state.research?.marketplace ?? state.filters.marketplace ?? 'US';
  $('rsHint').textContent = '已生成 prompt（' + picked.length + ' 个词，站点 ' + marketplace + '），已复制到剪贴板 —— 到对话里粘贴发送。';
  usePrompt('用 amzn_keyword_import 把下面这些关键词导入关键词库（站点 ' + marketplace + '）：'
    + picked.join('、'));
};

refresh().catch((error) => {
  $('table').innerHTML = '<div class="empty">加载失败: ' + escapeHtml(error.message) + '</div>';
});
connect();`
