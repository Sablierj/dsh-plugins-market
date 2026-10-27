/**
/** One entry point for the panel's blocks, so a new block cannot be forgotten. */

/** One entry point for the panel's blocks, so a new block cannot be forgotten. */
/**
 * 页签「asin」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 <script> 作用域，拆的是文件不是作用域。
 */
export const asinScript = `function renderAsinPanel() {
  renderAsinPortfolio();
  renderAsinFilterOptions();
  renderTable();
  renderAsinColumnPicker();
  renderAsinViews();
  renderAsinUpdate();
  syncAsinDetail();
  /* B-05c 的三块：健康摘要 / 历史 diff / 批量导入。它们都在 #panel-asin 里，所以与
     上面几块共用同一个 renderer —— 分开重画只会让其中一块停在上一次的数据上。 */
  syncB05c();
}

/* 组合概览：这批 ASIN 的内容完整度分级与缺口。
   只说明**内容齐不齐**；健康度（43 属性覆盖 + 九道门）在 amzn_asin_health 里一条一算。
   数字为 0 的缺口也照画 —— 少一个 chip 会让人以为"没查"。 */
function renderAsinPortfolio() {
  const host = $('asinPortfolio');
  if (!host) return;
  const p = state.asinPortfolio;
  if (!p) { host.innerHTML = ''; return; }
  const grade = p.byGrade || {};
  const gaps = p.gapCounts || {};
  const rows = [
    { text: '共 ' + p.total + ' 条', tone: '' },
    { text: '归档 ' + (p.archived || 0), tone: '' },
    { text: '未归属产品线 ' + (p.noProductLine || 0), tone: p.noProductLine > 0 ? 'warn' : '' },
    { text: 'S ' + (grade.S || 0) + ' · A ' + (grade.A || 0) + ' · B ' + (grade.B || 0) + ' · C ' + (grade.C || 0), tone: '' },
    { text: '缺标题 ' + (gaps.title || 0), tone: gaps.title > 0 ? 'warn' : '' },
    { text: '五点不足 ' + (gaps.bullets || 0), tone: gaps.bullets > 0 ? 'warn' : '' },
    { text: '缺描述 ' + (gaps.description || 0), tone: gaps.description > 0 ? 'warn' : '' },
    { text: '无 A+ ' + (gaps.aplus || 0), tone: gaps.aplus > 0 ? 'warn' : '' },
  ];
  host.innerHTML = '<div class="asin-portfolio">'
    + rows.map(row => '<span class="chip ' + row.tone + '">' + escapeHtml(row.text) + '</span>').join('')
    + '</div>'
    /* 页头对偶句（设计 v3 §4.1 第三行）：与采集页头同一句，说清两个面板的分工。 */
    + '<div class="hint" style="padding:0">采集器管「采没采到」，ASIN 详情管「现在有什么」。</div>'
    + '<div id="asinUpdate"></div>';
}

/* T53：「更新数据」流程。ASIN 页只发起一次采集，不在这里展开结果 ——
   创建后显示 task id / 状态，并把读者送到采集中心看进度。
   采集是异步的：这里不把「已提交」写成「已更新」。 */
let asinUpdateState = { open: false, scheme: '', taskId: null, status: null, error: null };

function renderAsinUpdate() {
  const box = $('asinUpdate');
  if (box === null) return;
  const selection = Array.isArray(state.context.selection.asins) ? state.context.selection.asins : [];
  const target = selection.length === 0 ? null : selection[0];
  if (target === null) { box.innerHTML = ''; return; }

  const panel = state.collectPanel || {};
  /* 只列 active 的：draft / disabled 的方案服务端会以 SCHEME_NOT_SELECTABLE 拒收
     （domain/collect/preview.js 的 schemeOf），列出来就是给人一个点不动的选项。
     与 renderCollectForm 的过滤保持一致 —— 两个控件看着同一份能力。 */
  const schemes = Array.isArray(panel.schemes) ? panel.schemes.filter(scheme => scheme.status === 'active') : [];
  const schemeValueOf = scheme => String(scheme.id) + '|' + String(scheme.version);
  const coverageHint = schemeCoverageHint(schemes, sectionTotal());
  /* 「默认：全部 13 节」曾经是一句谎话：空 schemeId 服务端解析成 active[0]，
     实测那一份只覆盖 1 节。现在的默认项就是**真的会跑的那一份**，覆盖数照实印。 */
  const options = schemeOptionList(schemes, {
    total: sectionTotal(),
    valueOf: schemeValueOf,
    labelOf: scheme => String(scheme.name) + ' v' + String(scheme.version),
    selected: asinUpdateState.scheme,
  });

  let result = '';
  if (asinUpdateState.taskId !== null) {
    result = '<div class="hint" style="padding:0">任务 <code>' + escapeHtml(String(asinUpdateState.taskId)) + '</code>'
      + ' · 状态 ' + escapeHtml(String(asinUpdateState.status ?? '已提交')) + '</div>'
      + '<div class="bar" style="margin-top:4px"><button type="button" id="asinUpdateGo">去采集中心看进度</button></div>';
  } else if (asinUpdateState.error !== null) {
    result = '<div class="hint" style="padding:0;color:var(--warn)">' + escapeHtml(String(asinUpdateState.error)) + '</div>';
  }

  box.innerHTML = '<div class="bar" style="border-top:0">'
    + '<button type="button" id="asinUpdateToggle">' + (asinUpdateState.open ? '收起更新' : '更新数据') + '</button>'
    + '<span class="hint" style="padding:0">为 <code>' + escapeHtml(String(target.asin)) + '</code> 创建采集任务；'
    + '选方案决定采哪些节，采集是异步的。</span>'
    + '</div>'
    + (asinUpdateState.open
      ? '<div class="b05c-card"><div class="bar">'
        + '<select id="asinUpdateScheme">' + options + '</select>'
        + '<button type="button" id="asinUpdateSubmit">创建采集任务</button>'
        + '</div>'
        + (coverageHint === '' ? '' : '<div class="hint" style="padding:0">' + escapeHtml(coverageHint) + '</div>')
        + '<div id="asinUpdateResult">' + result + '</div></div>'
      : '');

  const toggle = $('asinUpdateToggle');
  if (toggle !== null) toggle.onclick = () => {
    asinUpdateState.open = !asinUpdateState.open;
    renderAsinUpdate();
  };
  const schemeSelect = $('asinUpdateScheme');
  if (schemeSelect !== null) schemeSelect.onchange = () => { asinUpdateState.scheme = schemeSelect.value; };
  const submit = $('asinUpdateSubmit');
  if (submit !== null) submit.onclick = async () => {
    const value = schemeSelect === null ? '' : String(schemeSelect.value);
    const parts = value === '' ? [] : value.split('|');
    const body = {
      marketplace: target.marketplace,
      targets: [{ asin: target.asin, marketplace: target.marketplace }],
    };
    if (parts.length === 2) {
      body.schemeId = parts[0];
      body.schemeVersion = Number(parts[1]);
    }
    try {
      const data = await api('collect-run', { method: 'POST', body: JSON.stringify(body) });
      asinUpdateState.taskId = data.taskId;
      asinUpdateState.status = data.status ?? null;
      asinUpdateState.error = null;
    } catch (error) {
      asinUpdateState.error = String(error.message || error);
    }
    renderAsinUpdate();
  };
  const go = $('asinUpdateGo');
  if (go !== null) go.onclick = () => {
    patchContext({ module: 'collect', filters: { ...(state.filters || {}), taskId: asinUpdateState.taskId } });
  };
}

/* ── FR-M2-05 ①②：ASIN 表的行内改归属（点格编辑 + 影响面前置）──────────────────
   两个字段：ownership（自有/竞品，住 asin_ownership 决策表）与
   product_line（住 asin.product_line_id，档案里还有第二份）。
   顺序是**先拉影响面、再让人落笔**：没有影响面的「改一下」等于闭眼按按钮。
   影响面由域层 domain/asin/impact.js 算（页面不重算），全零时它会给一句
   note（「没有任何影响：…」），这里必须把那一句印出来 —— 空白会被读成「没查」。 */
let asinInlineEdit = null;   /* { key, field, value, impact, error, busy } */

function asinInlineFieldLabel(field) {
  /* **列名只活在 domain/asin/table.js**（t63-cr-batch1 ② 守这条：页面里抄一份
     列名，两份迟早漂开）。页面拿到的是注入进来的 ASIN_COLUMNS，从这里取；
     取不到才退回字段 id —— 但绝不在这里写第二份中文列名。 */
  const catalog = typeof ASIN_COLUMNS === 'undefined' || ASIN_COLUMNS === null ? [] : ASIN_COLUMNS;
  const found = catalog.find(column => column.id === field);
  return found === undefined ? String(field) : String(found.label);
}

/** 影响面那一段。**空态不许留白**：域层给了 note 就印 note，没给才说没查到。 */
function asinInlineImpactHtml(impact) {
  if (impact === null || impact === undefined) {
    return '<div class="hint" style="padding:0">影响面：正在读…（没读到之前不让保存）</div>';
  }
  if (impact.ok !== true) {
    return '<div class="hint" style="padding:0;color:var(--warn)">影响面读失败：'
      + escapeHtml(String(impact.error ?? impact.code ?? '原因未知')) + '</div>';
  }
  const items = Array.isArray(impact.items) ? impact.items : [];
  const rows = items.map(item => '<li>' + escapeHtml(String(item.label)) + '：<strong>'
    + escapeHtml(String(item.count)) + '</strong>　<span class="hint" style="padding:0">'
    + escapeHtml(String(item.detail ?? '')) + '</span></li>').join('');
  const head = '<div class="hint" style="padding:0">影响面（共 ' + escapeHtml(String(impact.total)) + ' 处引用）：</div>'
    + '<ul style="margin:4px 0 4px 18px;padding:0">' + rows + '</ul>';
  /* 「全零」那一句是本节的全部意义，单独加粗印出来。 */
  const none = impact.none === true && typeof impact.note === 'string'
    ? '<div class="hint" style="padding:0"><strong>' + escapeHtml(impact.note) + '</strong></div>'
    : '';
  const same = impact.sameValue === true
    ? '<div class="hint" style="padding:0">这一格现在就是这个值 —— 保存不会改变任何东西。</div>'
    : '';
  return head + none + same;
}

function renderAsinInlineEdit() {
  const box = $('asinInlineEdit');
  if (box === null) return;
  if (asinInlineEdit === null) { box.innerHTML = ''; return; }
  const edit = asinInlineEdit;
  const parts = String(edit.key).split('|');
  const field = edit.field;
  const impact = edit.impact;
  const canSave = impact !== null && impact !== undefined && impact.ok === true && edit.busy !== true;
  /* 产品线这一格用输入框而不是下拉：可选值来自 product_line 表，而这张表可能是空的
     （空下拉会让人以为「产品线只有空」）。已知的线 id 写在提示里，照抄即可。 */
  const input = '<input id="asinEditValue" value="' + escapeHtml(edit.value) + '"'
    + ' placeholder="' + escapeHtml(field === 'ownership' ? 'self 或 competitor' : '产品线 id，例如 bench-cushion') + '">';
  box.innerHTML = '<div class="b05c-card" style="margin-top:8px">'
    + '<div class="bar" style="border-top:0"><strong>改「' + escapeHtml(asinInlineFieldLabel(field)) + '」</strong>'
    + '　<code>' + escapeHtml(parts[0]) + '</code> @ ' + escapeHtml(parts[1]) + '</div>'
    + '<div class="bar">' + input
    + '<button type="button" id="asinEditSave"' + (canSave ? '' : ' disabled') + '>保存</button>'
    /* 撤销是**显式按钮**（revoke: true），不是「把值清空再点保存」——
       少传一个参数与明确撤销长一样的话，一次手滑就是一次静默撤销。 */
    + '<button type="button" id="asinEditRevoke"' + (canSave ? '' : ' disabled') + '>撤销这次判断</button>'
    + '<button type="button" id="asinEditCancel">取消</button></div>'
    + (edit.error === null ? '' : '<div class="hint" style="padding:0;color:var(--warn)">' + escapeHtml(edit.error) + '</div>')
    + asinInlineImpactHtml(impact)
    + '</div>';
  const save = $('asinEditSave');
  if (save !== null) save.onclick = () => asinInlineSave(false);
  const revoke = $('asinEditRevoke');
  if (revoke !== null) revoke.onclick = () => asinInlineSave(true);
  const cancel = $('asinEditCancel');
  if (cancel !== null) cancel.onclick = () => { asinInlineEdit = null; renderAsinInlineEdit(); };
  const value = $('asinEditValue');
  if (value !== null) value.oninput = () => { if (asinInlineEdit !== null) asinInlineEdit.value = String(value.value); };
}

/** 点一格：**先读影响面**，读到之前保存按钮是 disabled。 */
function asinInlineBegin(key, field) {
  asinInlineEdit = { key: String(key), field: String(field), value: '', impact: null, error: null, busy: false };
  renderAsinInlineEdit();
  const parts = String(key).split('|');
  const query = 'asin-field-impact?asin=' + encodeURIComponent(parts[0])
    + '&marketplace=' + encodeURIComponent(parts[1])
    + '&field=' + encodeURIComponent(String(field));
  api(query).then(payload => {
    if (asinInlineEdit === null || asinInlineEdit.key !== String(key) || asinInlineEdit.field !== String(field)) return;
    asinInlineEdit.impact = payload;
    /* 预填当前值：「产品线」由域层带回 current；「归属」由影响面里的
       「现有归属边」推 —— 拿不到就留空，不猜一个『自有』。 */
    if (payload !== null && payload !== undefined && payload.ok === true) {
      if (payload.field === 'product_line' && payload.current !== null) asinInlineEdit.value = String(payload.current);
      if (payload.field === 'ownership') {
        const edges = (payload.items || []).find(item => item.key === 'liveSideEdges');
        const match = edges === undefined ? null : /自有|竞品/.exec(String(edges.detail ?? ''));
        if (match !== null) asinInlineEdit.value = match[0] === '自有' ? 'self' : 'competitor';
      }
      /* 预填进来的那个值就是这次编辑的**原值** —— 从这一刻起才谈得上「改过没改过」。
         不在这里立 baseline 的话，第一次打开就会被判脏（而用户一个字都没动）。 */
      unsavedBaselines['asin-inline'] = String(asinInlineEdit.value);
    }
    renderAsinInlineEdit();
  }).catch(error => {
    if (asinInlineEdit === null) return;
    asinInlineEdit.impact = { ok: false, error: String(error.message || error) };
    renderAsinInlineEdit();
  });
}

/** 保存：写路径只有一条 —— asin-ownership-set 路由。
   它调**同一个工具**（asinOwnershipSetTool → setAsinOwnership），落同一个
   ACTIONS.asinOwnershipSet。**不写 asin.product_line_id**：那一列是
   asin_ownership 的缓存，由 syncProductLineCache 从边刷出来，直接写会被下一次
   归属写入刷掉且不留痕（见 team/dev/derived-columns-2026-10-25.md）。 */
function asinInlineSave(revoke) {
  if (asinInlineEdit === null) return;
  const edit = asinInlineEdit;
  if (edit.impact === null || edit.impact.ok !== true) return;
  const revokeMode = revoke === true;
  if (!revokeMode && String(edit.value).trim() === '') {
    /* 「空着点保存」不许被当成撤销 —— 撤销是一个显式按钮（revoke: true）。 */
    edit.error = '值不能为空；要撤销这次判断请点「撤销这次判断」';
    renderAsinInlineEdit();
    return;
  }
  const parts = String(edit.key).split('|');
  edit.busy = true;
  edit.error = null;
  renderAsinInlineEdit();
  /* 返回这个 promise：unsavedSaveAndLeave 要等它真的写完才离开 ——
     不然「保存并离开」会变成「离开，顺便希望保存成功」。 */
  return api('asin-ownership-set', {
    method: 'POST',
    body: JSON.stringify({
      asin: parts[0],
      marketplace: parts[1],
      /* 归属列的对象类型是 side；产品线列就是 product_line。 */
      objectType: edit.field === 'ownership' ? 'side' : 'product_line',
      objectId: revokeMode ? null : String(edit.value).trim(),
      revoke: revokeMode,
      source: 'manual',
      reason: revokeMode ? '页面行内撤销归属判断' : '页面行内改归属（ASIN 表）',
      by: 'page',
    }),
  }).then(() => {
    asinInlineEdit = null;
    renderAsinInlineEdit();
    refresh();
  }).catch(error => {
    if (asinInlineEdit === null) return;
    asinInlineEdit.busy = false;
    asinInlineEdit.error = String(error.message || error);
    renderAsinInlineEdit();
  });
}

/** 表格里那两格的可点外壳。quality.js 的 renderTable 用它包住格子内容。 */
function asinEditableCell(key, field, inner) {
  return '<button type="button" class="asin-cell-edit" data-asin-edit="'
    + escapeHtml(String(key) + '|' + String(field)) + '" title="点一下改这一格（会先显示影响面）"'
    + ' style="font:inherit;color:inherit;background:none;border:0;border-bottom:1px dashed var(--line);'
    + 'padding:0;cursor:pointer;text-align:inherit">' + inner + '</button>';
}

/** 把 <td …>内容</td> 的内容换掉，标签与属性原样保留。
 *  用它而不是重写 renderAsinCell：格子的文字由域层画（它分得清「没有这一格」与
 *  「值是空」），页面在这里再判一次就是第二份判据。 */
function wrapCellContent(cellHtml, wrap) {
  const text = String(cellHtml);
  const open = text.indexOf('>');
  const close = text.lastIndexOf('</td>');
  if (open < 0 || close < 0 || close < open) return cellHtml;
  return text.slice(0, open + 1) + wrap(text.slice(open + 1, close)) + text.slice(close);
}

/* ── 未保存改动守卫（FR：改了一半切走 = 静默丢改动）─────────────────────────
   为什么不是 beforeunload：**页面内切页签、切模块、换选中的 ASIN 都不触发它**，
   而那三个才是这里真正的出口。所以这里是一台自己的小状态机。

   三条设计决定，每条都对应一种「看着做了、其实没做」：

   1. **脏 = 值与原值不同，不是「碰过输入框」**。点了输入框又点出来不该算改；
      改回原值也不该算改（否则用户被一个无意义的弹窗烦到，从此无脑点确认）。
      判据在 unsavedChanges() 里，逐字比对 baseline。
   2. **「放弃修改」必须把编辑框恢复成原值**，不是只关面板 —— 否则下次打开
      还是脏值，「放弃」是假的。
   3. **三个选择**（保存并离开 / 放弃修改 / 留下继续编辑）。只有「确认/取消」时，
      用户猜不出「取消」取消的是离开还是保存。

   各输入面用 unsavedRegister 登记：read() 读当前值、restore(v) 写回原值、
   save() 保存（没有草稿可存的输入面（提交型表单）给 null —— 那时「保存并离开」
   是 disabled 并说明原因，而不是假装能存）。 */
let unsavedSurfaces = [];
let unsavedBaselines = {};
let unsavedPending = null;

/** 登记一个输入面（重复登记按 key 覆盖，避免热重绘时越堆越多）。 */
function unsavedRegister(surface) {
  const existing = unsavedSurfaces.findIndex(entry => entry.key === surface.key);
  if (existing >= 0) unsavedSurfaces[existing] = surface;
  else unsavedSurfaces.push(surface);
  if (unsavedBaselines[surface.key] === undefined) unsavedBaselines[surface.key] = String(surface.read() ?? '');
  return surface.key;
}

/** **纯函数**：当前值与 baseline 不同的输入面。改回原值 → 不在列表里。 */
function unsavedChanges() {
  const changed = [];
  for (const surface of unsavedSurfaces) {
    let now = '';
    try {
      now = String(surface.read() ?? '');
    } catch {
      /* 读不到（面板已经不在 DOM 上）就按「没改」算：报一个不存在的改动
         比漏报更糟，因为它训练人去点确认。 */
      now = String(unsavedBaselines[surface.key] ?? '');
    }
    if (now !== String(unsavedBaselines[surface.key] ?? '')) changed.push({ key: surface.key, label: surface.label });
  }
  return changed;
}

/** 保存成功 / 显式取消之后调用：把当前值记成新的原值。 */
function unsavedMarkClean(keys) {
  const wanted = Array.isArray(keys) ? new Set(keys) : null;
  for (const surface of unsavedSurfaces) {
    if (wanted !== null && !wanted.has(surface.key)) continue;
    unsavedBaselines[surface.key] = String(surface.read() ?? '');
  }
  if (unsavedPending !== null && unsavedChanges().length === 0) unsavedPending = null;
  renderUnsavedGuard();
}

/** 文案：**说出改了哪几个字段**，不许只说「有未保存的更改」。 */
function unsavedCopy(changes) {
  const labels = changes.map(entry => entry.label).join('、');
  return '你改了 ' + changes.length + ' 个字段（' + labels + '），还没保存。';
}

/** 三个出口都走它：干净就直接执行，脏就先问。 */
function unsavedRequestLeave(what, run) {
  /* 每次问之前先同步一遍输入面：面板可能刚重绘过，登记表必须跟着 DOM 走。 */
  unsavedSyncSurfaces();
  const changes = unsavedChanges();
  if (changes.length === 0) {
    /* **返回 run 的返回值**：调用方（asinDetailSelect）本来会把「读取详情」的 promise
       交出去，丢掉它会让「等详情回来」的调用方永远等不到（B05W-② 就是这么红的）。 */
    return run();
  }
  unsavedPending = { what: String(what), run, changes };
  renderUnsavedGuard();
  return false;
}

/** 「放弃修改」：把每个输入面**恢复成原值**，然后执行离开。 */
function unsavedDiscardAndLeave() {
  const pending = unsavedPending;
  for (const surface of unsavedSurfaces) {
    const baseline = String(unsavedBaselines[surface.key] ?? '');
    if (String(surface.read() ?? '') === baseline) continue;
    if (typeof surface.restore === 'function') surface.restore(baseline);
  }
  unsavedPending = null;
  renderUnsavedGuard();
  if (pending !== null) pending.run();
}

/** 「保存并离开」：把有 save 的输入面各存一次，成功后记干净再离开。 */
function unsavedSaveAndLeave() {
  const pending = unsavedPending;
  if (pending === null) return;
  const dirtyKeys = new Set(pending.changes.map(entry => entry.key));
  const savable = unsavedSurfaces.filter(surface => dirtyKeys.has(surface.key) && typeof surface.save === 'function');
  if (savable.length === 0) return;
  Promise.all(savable.map(surface => Promise.resolve(surface.save())))
    .then(() => {
      unsavedMarkClean([...dirtyKeys]);
      /* 用**捕获的** pending：unsavedMarkClean 在变干净时会把 unsavedPending 清空，
         而「保存并离开」的语义是保存完**照样离开**。 */
      if (pending !== null) pending.run();
    })
    .catch(error => {
      if (unsavedPending === null) return;
      unsavedPending.error = String(error.message || error);
      renderUnsavedGuard();
    });
}

/** 「留下继续编辑」：什么都不动，只把对话框收起来。 */
function unsavedStay() {
  unsavedPending = null;
  renderUnsavedGuard();
}

function renderUnsavedGuard() {
  const box = $('unsavedGuard');
  if (box === null) return;
  if (unsavedPending === null) { box.innerHTML = ''; return; }
  const pending = unsavedPending;
  const dirtyKeys = new Set(pending.changes.map(entry => entry.key));
  const savable = unsavedSurfaces.some(surface => dirtyKeys.has(surface.key) && typeof surface.save === 'function');
  box.innerHTML = '<div class="b05c-card" style="margin-top:8px;border-color:var(--warn)">'
    + '<div class="bar" style="border-top:0"><strong>改动还没保存</strong>　'
    + '<span class="hint" style="padding:0">' + escapeHtml(pending.what) + '</span></div>'
    + '<div class="hint" style="padding:0">' + escapeHtml(unsavedCopy(pending.changes)) + '</div>'
    + (pending.error === undefined ? '' : '<div class="hint" style="padding:0;color:var(--warn)">保存失败：'
      + escapeHtml(pending.error) + '</div>')
    + '<div class="bar">'
    + '<button type="button" id="unsavedSave"' + (savable ? '' : ' disabled') + '>保存并离开</button>'
    + '<button type="button" id="unsavedDiscard">放弃修改</button>'
    + '<button type="button" id="unsavedStay">留下继续编辑</button></div>'
    + (savable ? '' : '<div class="hint" style="padding:0">这些输入没有草稿可存（提交才会写库），'
      + '所以只能「放弃修改」或「留下继续编辑」。</div>')
    + '</div>';
  const save = $('unsavedSave');
  if (save !== null) save.onclick = () => unsavedSaveAndLeave();
  const discard = $('unsavedDiscard');
  if (discard !== null) discard.onclick = () => unsavedDiscardAndLeave();
  const stay = $('unsavedStay');
  if (stay !== null) stay.onclick = () => unsavedStay();
}

/** 把页面上的输入面登记进来（每次重绘后调用；重复登记按 key 覆盖）。 */
function unsavedSyncSurfaces() {
  /* ① 行内改归属的编辑框（有草稿可存：保存走 asin-ownership-set）。 */
  unsavedRegister({
    key: 'asin-inline',
    label: asinInlineEdit === null ? '行内编辑' : asinInlineFieldLabel(asinInlineEdit.field),
    read: () => (asinInlineEdit === null ? String(unsavedBaselines['asin-inline'] ?? '') : String(asinInlineEdit.value)),
    restore: value => { if (asinInlineEdit !== null) { asinInlineEdit.value = value; renderAsinInlineEdit(); } },
    save: () => asinInlineSave(false),
  });
  /* ② 采集表单的三个目标框（提交型：没有草稿可存）。 */
  for (const [id, label] of [['collectTargets', '采集目标'], ['collectSelf', '自有 ASIN'], ['collectCompetitor', '竞品 ASIN']]) {
    unsavedRegister({
      key: id,
      label,
      read: () => ($(id) === null ? String(unsavedBaselines[id] ?? '') : String($(id).value)),
      restore: value => { if ($(id) !== null) $(id).value = value; },
      save: null,
    });
  }
  /* ③ 批量导入的文本框（提交型）。 */
  unsavedRegister({
    key: 'b05c-import',
    label: '批量导入的表格',
    read: () => {
      const area = document.querySelector === undefined ? null : document.querySelector('textarea[data-b05c-import-text]');
      return area === null || area === undefined ? String(unsavedBaselines['b05c-import'] ?? '') : String(area.value);
    },
    restore: value => {
      const area = document.querySelector === undefined ? null : document.querySelector('textarea[data-b05c-import-text]');
      if (area !== null && area !== undefined) area.value = value;
    },
    save: null,
  });
}


/** 筛选控件的候选值。**每次都按服务端的答案重画，并保住用户当前选中的那一项** ——
 *  只 innerHTML 重写会把选择框弹回第一项，而 filters 里还留着旧值：
 *  控件显示「全部站点」而查询按 US 过滤，是这类页面最难被发现的一种谎。 */
function renderAsinFilterOptions() {
  const options = state.asinFilterOptions;
  const line = $('asinLine');
  const brand = $('asinBrand');
  if (line === null || brand === null) return;
  const currentLine = String((state.filters || {}).productLineId ?? '');
  const currentBrand = String((state.filters || {}).brand ?? '');

  const lines = options === null || options === undefined ? null : options.productLines;
  line.innerHTML = '<option value="">全部产品线</option>'
    + (lines === null
      ? '<option value="">（这一次没取）</option>'
      : lines.map(entry => '<option value="' + escapeHtml(entry.id) + '">'
        + escapeHtml(entry.name) + '（' + escapeHtml(entry.id) + '，' + entry.asinCount + ' 个 ASIN）'
        + '</option>').join(''));
  line.value = currentLine;

  const brands = options === null || options === undefined ? null : options.brands;
  brand.innerHTML = '<option value="">全部品牌</option>'
    + (brands === null
      ? '<option value="">（这一次没取）</option>'
      : brands.map(name => '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>').join(''));
  /* 当前筛选的品牌不在候选里（比如它是从别的入口带进来的）时，**补一个选项**而不是
     把选择框弹回「全部品牌」：弹回去之后控件说的与你筛的不是同一件事。 */
  if (currentBrand !== '' && !(brands !== null && brands.includes(currentBrand))) {
    brand.innerHTML += '<option value="' + escapeHtml(currentBrand) + '">'
      + escapeHtml(currentBrand) + '（不在候选里）</option>';
  }
  brand.value = currentBrand;

  const order = $('order');
  const currentOrder = String((state.filters || {}).order ?? '');
  if (order !== null && currentOrder !== '') order.value = currentOrder;
  /* 归档三态也要回显，且**兜底是页面默认值 all**：兜成空串会让选择框跳到第一项
     （恰好也是「含已归档」）而 filters 里是空的 —— 显示与查询在这一点上一致纯属巧合，
     等数据层默认改了就不再一致。 */
  const archived = $('asinArchived');
  if (archived !== null) archived.value = String((state.filters || {}).archived ?? 'all');
  const market = $('marketplace');
  const currentMarket = String((state.filters || {}).marketplace ?? '');
  if (market !== null) market.value = currentMarket;
  const search = $('q');
  if (search !== null && document.activeElement !== search) search.value = String((state.filters || {}).q ?? '');
}

/** 选中项变了才读，没变就只重画。 */
function syncAsinDetail() {
  const selection = Array.isArray(state.context.selection.asins) ? state.context.selection.asins : [];
  const key = selection.length === 0
    ? null
    : asinDetailKey(selection[0].asin, selection[0].marketplace);

  /* 选中项没动过 → 什么都不做，**包括不把焦点拽回选中项**：从变体关系里手动跳过去的那个
     详情必须在每 3 秒一次的轮询之后还在，否则那个跳转只能活三秒。 */
  if (key === asinDetailSelectionKey) {
    renderAsinDetail();
    return;
  }
  asinDetailSelectionKey = key;
  asinDetailFocus = key;
  asinDetailPinned = false;
  asinDetailTab = null;
  asinDetailData = null;
  asinDetailError = null;
  renderAsinDetail();
  /* 空选中不读：查询串里没有 asin 时服务端会回 400，而那不是这一页该说的话。 */
  if (key !== null) loadAsinDetail(key);
}

/** 读一个 ASIN 的四页。查询串照本仓既有取数写法（采集面板的 13 节详情那一处在做同一件事）。 */
async function loadAsinDetail(key) {
  const target = String(key);
  const parts = asinDetailParts(target);
  asinDetailFocus = target;
  asinDetailData = null;
  asinDetailError = null;
  renderAsinDetail();
  try {
    const query = 'asin-detail?asin=' + encodeURIComponent(parts.asin)
      + '&marketplace=' + encodeURIComponent(parts.marketplace);
    const payload = await api(query);
    /* 回包与当前焦点对不上 = 这中间有人又点了别的行。丢掉它，而不是把上一个 ASIN 的
       数字画在这个 ASIN 的名字下面 —— 那是这一页最坏的一种错。 */
    if (asinDetailFocus !== target) return;
    asinDetailData = payload;
  } catch (error) {
    if (asinDetailFocus !== target) return;
    asinDetailError = error;
  }
  renderAsinDetail();
}

/** 点一行 .asin-row：把详情切到那一行指的 ASIN，并记住这是一次**手动**跳转。
 *  返回这次读取的 promise，好让调用方（浏览器里的 handler 与测试里的 handler）能等它。 */
function asinDetailSelect(key) {
  const target = String(key);
  /* 出口 ③：换选中的 ASIN（含关掉抽屉去看别的）—— 脏就先问。 */
  return unsavedRequestLeave('切换 ASIN', () => {
    asinDetailPinned = target !== asinDetailSelectionKey;
    asinDetailTab = null;
    return loadAsinDetail(target);
  });
}

/** 点一个已建的页签。未建的页签**没有** handler（它们画成 disabled）—— 一个点了没反应的
 *  按钮与一个不存在的页面长得一样，而这一页的规矩是「缺失要说出来」。 */
function asinDetailSelectTab(id) {
  const tab = String(id);
  if (!ASIN_TAB_ORDER.includes(tab)) return;
  /* 出口 ①：详情 9 个页签之间切换 —— 脏就先问（beforeunload 在这里根本不触发）。 */
  return unsavedRequestLeave('切换详情页签', () => {
    asinDetailTab = tab;
    renderAsinDetail();
  });
}

/** 「重试」：读失败之后唯一的出口。选中项没有变，所以这一页不会自己重读。 */
function asinDetailRetry() {
  if (asinDetailFocus === null) return;
  return loadAsinDetail(asinDetailFocus);
}

/** 「这一条现在是不是归档的」——详情头部那一枚芯片。
 *
 *  它画在四个 body **之外**，所以在任何一页上都看得见。这件事必须比「有没有数据」
 *  更早说清楚：一条归档的记录看起来正像「数据丢了」，而它其实是被**藏起来**的
 *  （下面四页仍然读得出，血缘一个字节没动）。
 *
 *  芯片读的是载荷的 archived 那一格 —— 服务端由 store/archive.js 的 isAsinArchived 读出来的
 *  那**一个**布尔，页面不自己从 archived_at 推：同一个判据的第二份实现会分叉，而分叉时
 *  页面只是安静地把一条已归档的记录说成在架上。
 *
 *  「在架上」也画出来（而不是什么都不画），因为「归档过又被恢复」与「从来没归档过」
 *  是两种不同的历史：只说「不是归档的」，恢复这件事就从页面上消失了。 */
function asinArchiveHead(data) {
  if (data === null || data === undefined) return '';
  /* 服务端少给这一格时说「没有这一格」，不说「没归档」—— 那是两件事，而后者会让
     一条归档的记录在页面上长得和正常记录一样。 */
  if (typeof data.archived !== 'boolean') {
    return '<span class="chip">归档状态：服务端没有给这一格</span>';
  }
  const overview = data.overview === null || data.overview === undefined ? {} : data.overview;
  const archive = overview.archive === null || overview.archive === undefined ? {} : overview.archive;
  if (data.archived === true) {
    return '<span class="chip warn">已归档（只读）</span>'
      + '<span class="hint" style="padding:0">' + asinText(archive.archivedAt) + ' · 理由 '
      + asinText(archive.archiveReason) + ' · 操作人 ' + asinText(archive.archivedBy)
      + ' —— 隐藏不是删除，下面四页仍然读得出</span>';
  }
  if (archive.everArchived === true) {
    const last = archive.lastEvent === null || archive.lastEvent === undefined ? null : archive.lastEvent;
    return '<span class="chip">在架上</span>'
      + '<span class="hint" style="padding:0">曾经归档过：事件 ' + asinText(archive.eventCount)
      + ' 条，最近一条 ' + asinText(last === null ? null : last.action)
      + '（' + asinText(last === null ? null : last.at) + '）</span>';
  }
  return '<span class="chip">在架上</span>';
}

function renderAsinDetail() {
  const box = $('asindetail');
  if (box === null) return;

  const selection = Array.isArray(state.context.selection.asins) ? state.context.selection.asins : [];
  const focus = asinDetailFocus === null ? null : asinDetailParts(asinDetailFocus);

  /* 空态要**说出来**。一个空容器比一句「还没选中」更糟：它看起来像「读过了、什么都没有」。 */
  if (focus === null) {
    box.innerHTML = '<div class="asin-note">还没选中 ASIN：在上面那张表里点一行，'
      + '这里就展开它的四页详情（' + escapeHtml(ASIN_TAB_ORDER.map(id => asinTabLabel(id)).join(' / ')) + '）。</div>';
    return;
  }

  const others = selection
    .filter(entry => asinDetailKey(entry.asin, entry.marketplace) !== asinDetailFocus);
  const jumpKeys = others.map(entry => asinDetailKey(entry.asin, entry.marketplace));
  const jump = others.map(entry => asinJumpRow(entry.asin, entry.marketplace, '也在选中里'));
  /* 手动跳走之后要有回路，但**只在它还没被画出来的时候**：焦点落在选中项里的另一个 ASIN 上时，
     「也在选中里」那一行本身就是回程，再画一行就是把同一件事说两遍（两行的目标还是同一个）。 */
  const backKey = asinDetailPinned === true && asinDetailSelectionKey !== null && asinDetailSelectionKey !== asinDetailFocus
    && !jumpKeys.includes(asinDetailSelectionKey)
    ? asinDetailParts(asinDetailSelectionKey)
    : null;
  const back = backKey === null ? [] : [asinJumpRow(backKey.asin, backKey.marketplace, '选中项里的第一个')];

  const jumps = jump.concat(back);
  const head = '<div class="asin-head">'
    + '<span>详情 <code>' + escapeHtml(focus.asin) + '</code> @ ' + escapeHtml(focus.marketplace) + '</span>'
    + asinArchiveHead(asinDetailData)
    + '<span class="hint" style="padding:0">'
    + (asinDetailPinned === true ? '手动点过来的（选中项没有变）' : '跟随选中项里的第一个')
    + '</span></div>'
    + (jumps.length === 0 ? '' : '<div class="asin-jumps">' + jumps.join('') + '</div>');

  if (asinDetailError !== null) {
    box.innerHTML = head + asinDetailRefusal(asinDetailError)
      + '<div class="asin-note"><button data-asin-retry="1">重试</button>'
      + '（选中项没变，所以这一页不会自己重读）</div>';
    wireAsinDetail();
    return;
  }

  if (asinDetailData === null) {
    box.innerHTML = head + '<div class="asin-note">正在读取 <code>' + escapeHtml(focus.asin)
      + '</code> 的详情。四页一起读：概览的比例就是另外三页算出来的事实，分两次读会让同一页上的两个数字来自两个算法。</div>';
    wireAsinDetail();
    return;
  }

  const active = ASIN_TAB_ORDER.includes(asinDetailTab) ? asinDetailTab : ASIN_TAB_ORDER[0];
  const tabs = '<div class="asin-tabs">'
    + ASIN_TAB_ORDER.map(id => '<button data-asin-tab="' + escapeHtml(id) + '"'
      + (id === active ? ' class="active" aria-current="true"' : '')
      + '>' + escapeHtml(asinTabLabel(id)) + '</button>').join('')
    + ASIN_PENDING_TABS.map(tab => '<button disabled title="还没建（' + escapeHtml(String(tab.feature))
      + '）">' + escapeHtml(String(tab.label)) + '</button>').join('')
    + '</div>';
  /* ASIN_PENDING_TABS 的用处就在这一行。F05-02 的九个标签页里还有五个是**没建的**：
     把它们藏起来（只画四个页签）读起来像「这个详情只有四页」，而它们是不存在的功能。
     补完一个就从那份常量里移出去 —— 名单里留着已经建好的页，与一个没人用的死常量是同一种谎。 */
  const pending = ASIN_PENDING_TABS.length === 0 ? '' : '<div class="asin-note">'
    + 'F05-02 的标签页一共 ' + asinText(ASIN_TAB_ORDER.length + ASIN_PENDING_TABS.length) + ' 个，这一页做了 '
    + asinText(ASIN_TAB_ORDER.length) + ' 个；另外 ' + asinText(ASIN_PENDING_TABS.length)
    + ' 个<strong>还没建</strong>（不是没有数据，是还没有这一页）：'
    + ASIN_PENDING_TABS.map(tab => escapeHtml(String(tab.label)) + '（' + escapeHtml(String(tab.feature)) + '）').join('、')
    + '。</div>';
  const bodies = ASIN_TAB_ORDER.map(id => '<div class="asin-body" data-asin-body="' + escapeHtml(id) + '"'
    + (id === active ? '' : ' hidden') + '>' + asinBody(id, asinDetailData) + '</div>').join('');

  box.innerHTML = head + tabs + pending + bodies;
  wireAsinDetail();
}

/** 每次画完都接一次线，**包括异步读回来之后那一次重画**：只在面板入口接线的做法会让
 *  「读回来之后才画出来的行」永远没有 handler，而那正是最需要点的那一行。 */
function wireAsinDetail() {
  const box = $('asindetail');
  if (box === null) return;
  for (const button of box.querySelectorAll('button[data-asin-tab]')) {
    button.onclick = () => asinDetailSelectTab(String(button.dataset.asinTab));
  }
  /* .asin-row —— CSS 说了它 cursor:pointer，这里逐行兑现。 */
  for (const line of box.querySelectorAll('div[data-asin]')) {
    line.onclick = () => asinDetailSelect(asinDetailKey(line.dataset.asin, line.dataset.marketplace));
  }
  for (const button of box.querySelectorAll('button[data-asin-retry]')) {
    button.onclick = () => asinDetailRetry();
  }
  /* 对偶互链（T63/CR-3）也在每次画完接线：13 节页签是异步读回来才画的。 */
  bindDualGoButtons(box);
}

/* ── B-05c：数据健康摘要（F05-07）/ 历史 diff（F05-04）/ 批量导入（F05-05）───────
 *
 * 三块都在 #asindetail **之外**：那四个页签是 F05-02 的契约，本批一个都不动。
 *
 * **页面只读载荷，不内联重算。** 服务端把每一项都算好了（变化类别、归因标签、state、
 * 分子分母、逐行的 create/update），页面连一个 if 都不为它们写。判据是双向的：把域层
 * 的一处判据改坏，工具侧与页面侧的断言必须同时变红 —— 页面自己兜一个 fallback 就会让
 * 页面那条永远绿，而那正是本仓已经在 keyword_ranked 与 sectionContentUnread 上
 * 付过两次代价的形状。（这一段里不许出现反引号：外层模板会在这里断开。）
 *
 * 词表（变化类别 / 归因 / 六项 id / 四态 / 「本仓没有来源」那句话）全部由服务端注入
 * （见上面那一段 const）。查不到就原样印 id，不编一个词。
 */

let b05cSelectionKey = null;   /* 最近一次跟随的选中项；用来判断选中项有没有动过 */
let b05cFocus = null;          /* 'asin|marketplace' —— 摘要与历史正在看的那个 ASIN */
let b05cHealth = null;         /* 最后一次 /api/asin-health 的载荷 */
let b05cHealthError = null;    /* 读失败的那一次；与「正在读」不是同一件事 */
let b05cHistory = null;        /* 最后一次 /api/asin-history 的载荷 */
let b05cHistoryError = null;
let b05cHistoryFrom = '';      /* 空 = 服务端的默认（最新两份） */
let b05cHistoryTo = '';
let b05cImport = null;         /* 最后一次预览 / 导入的载荷（拒绝时也画它带的计划） */
let b05cImportError = null;
let b05cImportBusy = false;

function b05cKey(asin, marketplace) {
  const market = marketplace === null || marketplace === undefined || marketplace === '' ? 'US' : marketplace;
  return String(asin) + '|' + String(market);
}

function b05cParts(key) {
  const parts = String(key).split('|');
  return { asin: parts[0], marketplace: parts.length > 1 && parts[1] !== '' ? parts[1] : 'US' };
}

/** 选中项变了才读，没变只重画（与 syncAsinDetail 同一条规矩，包括「不把焦点拽回来」）。 */
function syncB05c() {
  const selection = Array.isArray(state.context.selection.asins) ? state.context.selection.asins : [];
  const key = selection.length === 0 ? null : b05cKey(selection[0].asin, selection[0].marketplace);

  if (key !== b05cSelectionKey) {
    b05cSelectionKey = key;
    b05cFocus = key;
    b05cHealth = null;
    b05cHealthError = null;
    b05cHistory = null;
    b05cHistoryError = null;
    b05cHistoryFrom = '';
    b05cHistoryTo = '';
    renderAsinHealth();
    renderAsinHistory();
    renderAsinImportPanel();
    renderProductImport();
    /* 空选中不读：查询串里没有 asin 时服务端回 400，而那不是这一页该说的话。 */
    if (key !== null) {
      loadAsinHealth(key);
      loadAsinHistory(key);
    }
    if (!piBootstrapped) { piBootstrapped = true; renderProductImport(); }
    return;
  }
  /* 选中项没变也走这里：产品表导入与选中项无关，首屏必须画一次。 */
  if (!piBootstrapped) { piBootstrapped = true; renderProductImport(); }
  renderAsinHealth();
  renderAsinHistory();
  renderAsinImportPanel();
}

async function loadAsinHealth(key) {
  const target = String(key);
  const parts = b05cParts(target);
  b05cFocus = target;
  b05cHealth = null;
  b05cHealthError = null;
  renderAsinHealth();
  try {
    const payload = await api('asin-health?asin=' + encodeURIComponent(parts.asin)
      + '&marketplace=' + encodeURIComponent(parts.marketplace));
    /* 回包与当前焦点对不上 = 这中间有人又点了别的行。丢掉它，而不是把上一个 ASIN 的
       数字画在这个 ASIN 的名字下面。 */
    if (b05cFocus !== target) return;
    b05cHealth = payload;
  } catch (error) {
    if (b05cFocus !== target) return;
    b05cHealthError = error;
  }
  renderAsinHealth();
}

async function loadAsinHistory(key) {
  const target = String(key);
  const parts = b05cParts(target);
  b05cFocus = target;
  b05cHistory = null;
  b05cHistoryError = null;
  renderAsinHistory();
  try {
    const payload = await api('asin-history?asin=' + encodeURIComponent(parts.asin)
      + '&marketplace=' + encodeURIComponent(parts.marketplace)
      + (b05cHistoryFrom === '' ? '' : '&from=' + encodeURIComponent(b05cHistoryFrom))
      + (b05cHistoryTo === '' ? '' : '&to=' + encodeURIComponent(b05cHistoryTo)));
    if (b05cFocus !== target) return;
    b05cHistory = payload;
  } catch (error) {
    if (b05cFocus !== target) return;
    b05cHistoryError = error;
  }
  renderAsinHistory();
}

/** 一次读失败：错误码与服务端那句话照印。**不翻译** —— 错误码是页面与 agent 共用的
 *  那个闭集，改写成一句更顺耳的话就是同一条规则的第二份措辞。 */
function b05cRefusal(title, error, tail) {
  const body = error === null || error === undefined ? null : error.body;
  const source = body !== null && body !== undefined ? body : (error === null || error === undefined ? null : null);
  const code = source !== null && source.code ? String(source.code) : '读取失败';
  const message = source !== null && source.error ? String(source.error) : String((error && error.message) || error);
  const hint = source !== null && source.hint ? String(source.hint) : '';
  return '<div class="asin-problem"><strong>' + escapeHtml(title + '·' + code) + '</strong>：' + escapeHtml(message)
    + (hint === '' ? '' : '<br><span class="hint" style="padding:0">' + escapeHtml(hint) + '</span>')
    + (tail === null || tail === undefined ? '' : '<br>' + tail) + '</div>';
}

/* ── F05-07 数据健康摘要 ─────────────────────────────────────────────── */

function renderAsinHealth() {
  const box = $('asinhealth');
  if (box === null) return;
  const head = '<div class="b05c-head"><strong>数据健康摘要</strong>'
    + '<span class="hint" style="padding:0">F05-07 · 每一项都有分子/分母/口径/来源/扣分项</span>'
    + '<span style="flex:1 1 auto"></span>'
    + (b05cFocus === null ? '' : '<button type="button" data-b05c-retry="health">重试</button>')
    + '</div>';

  let body = '';
  if (b05cFocus === null) {
    /* 「没选中」与「选了但没有数据」不是一件事 —— 这句话必须说在前面。 */
    body = '<div class="asin-lack">先在 ASIN 表里点一行。健康摘要是按<b>一个 ASIN</b> 的：'
      + '43 属性完整率与优化前置只对一个商品有含义，与主页那六张工作空间级的卡不是同一件事。</div>';
  } else if (b05cHealthError !== null) {
    body = b05cRefusal('健康摘要', b05cHealthError, '空白的六项与「这一条 ASIN 什么都没有」不是一件事。');
  } else if (b05cHealth === null) {
    body = '<div class="asin-lack">正在读 …</div>';
  } else if (b05cHealth.ok !== true) {
    body = b05cRefusal('健康摘要', { body: b05cHealth });
  } else {
    body = asinHealthBody(b05cHealth);
  }
  box.innerHTML = head + '<div class="b05c-body">' + body + '</div>';
  wireB05c();
}

function asinHealthBody(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const parts = [];

  const cards = items.map(entry => {
    const stateClass = entry.state === 'no-source' ? ' nosource' : (entry.state === 'error' ? ' err' : '');
    /* 分母为空是「这一项是计数，不是比率」，不是「分母是 0」—— 页面照印一个数，
       不补分母。 */
    const ratio = entry.denominator === null || entry.denominator === undefined
      ? String(entry.numerator === null || entry.numerator === undefined ? '—' : entry.numerator)
      : String(entry.numerator === null || entry.numerator === undefined ? '—' : entry.numerator) + '/' + String(entry.denominator);
    const missing = Array.isArray(entry.missing) ? entry.missing : [];
    return '<div class="b05c-card' + stateClass + '">'
      + '<div class="t">' + escapeHtml(String(entry.label)) + ' <span class="b05c-chip">'
      + escapeHtml(asinLabeled(ASIN_HEALTH_STATE_LABELS, entry.state)) + '</span></div>'
      + '<div><strong>' + escapeHtml(ratio) + '</strong> ' + escapeHtml(String(entry.conclusion)) + '</div>'
      + (missing.length === 0 ? '' : '<div class="n">扣分项：' + escapeHtml(missing.slice(0, 10).map(item => String(item)).join('、'))
        + (missing.length > 10 ? ' 等 ' + missing.length + ' 项' : '') + '</div>')
      + '<div class="n">来源：' + escapeHtml(String(entry.source)) + '</div>'
      + '<div class="n">口径：' + escapeHtml(String(entry.basis)) + '</div>'
      + (entry.caveat === null || entry.caveat === undefined ? '' : '<div class="n">⚠ ' + escapeHtml(String(entry.caveat)) + '</div>')
      + (entry.note === null || entry.note === undefined ? '' : '<div class="n">⚠ ' + escapeHtml(String(entry.note)) + '</div>')
      + '</div>';
  }).join('');

  parts.push('<div class="b05c-note">顺序固定：' + ASIN_HEALTH_ITEM_IDS.map(id => escapeHtml(String(id))).join(' / ')
    + '。每一项的分母都在卡上，结论里为 0 的项要连着它自己的那两句注一起读。</div>');
  parts.push('<div class="b05c-grid">' + cards + '</div>');

  /* ★ 「本仓没有来源」的那几项**单独一块**，不画成 0 分、不画灰点、不留白。
     它们印的是服务端给的原话（ASIN_HEALTH_NO_SOURCE_TEXT），页面不替它换措辞。 */
  const unsourced = Array.isArray(data.unsourced) ? data.unsourced : [];
  parts.push('<h4>本仓没有来源的判据（' + unsourced.length + '）</h4>');
  if (unsourced.length === 0) {
    parts.push('<div class="b05c-note">服务端说这一版没有「本仓没有来源」的判据。</div>');
  } else {
    parts.push('<div class="b05c-note">下面每一条都印「' + escapeHtml(ASIN_HEALTH_NO_SOURCE_TEXT)
      + '」—— 它不是 0，也不是「没问题」，是这一版算不出来。</div>');
    parts.push('<div class="b05c-grid">' + unsourced.map(entry => '<div class="b05c-card nosource">'
      + '<div class="t">' + escapeHtml(String(entry.label))
      + ' <span class="b05c-chip">' + escapeHtml(asinLabeled(ASIN_HEALTH_STATE_LABELS, entry.state)) + '</span>'
      + ' <span class="b05c-chip">' + escapeHtml(String(entry.feature)) + '</span></div>'
      + '<div><strong>' + escapeHtml(String(entry.conclusion)) + '</strong></div>'
      + '<div class="n">' + escapeHtml(String(entry.reason)) + '</div>'
      + '</div>').join('') + '</div>');
  }

  parts.push('<div class="b05c-note">本摘要与主页那六张工作空间级的卡**并存、互不替代**：'
    + '那六张按站点收窄分母，这张按一个 ASIN。</div>');
  return parts.join('');
}

/* ── F05-04 历史快照与 diff ──────────────────────────────────────────── */

function renderAsinHistory() {
  const box = $('asinhistory');
  if (box === null) return;
  const head = '<div class="b05c-head"><strong>历史快照与 diff</strong>'
    + '<span class="hint" style="padding:0">F05-04 · 任选两个时间点比较</span>'
    + '<span style="flex:1 1 auto"></span>'
    + (b05cFocus === null ? '' : '<button type="button" data-b05c-retry="history">重试</button>')
    + '</div>';

  let body = '';
  if (b05cFocus === null) {
    body = '<div class="asin-lack">先在 ASIN 表里点一行。</div>';
  } else if (b05cHistoryError !== null) {
    body = b05cRefusal('历史 diff', b05cHistoryError, '空白的差异表与「两份快照逐项相同」不是一件事。');
  } else if (b05cHistory === null) {
    body = '<div class="asin-lack">正在读 …</div>';
  } else if (b05cHistory.ok !== true) {
    body = b05cRefusal('历史 diff', { body: b05cHistory });
  } else {
    body = asinHistoryBody(b05cHistory);
  }
  box.innerHTML = head + '<div class="b05c-body">' + body + '</div>';
  wireB05c();
}

function asinHistoryBody(data) {
  const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  if (snapshots.length === 0) {
    /* 0 份快照：连选择器都没有意义。服务端的句子照印，不换成「没有变化」。 */
    return '<div class="asin-lack">' + escapeHtml(String((data.notes || [])[0] || '这个 ASIN 还没有任何采集快照'))
      + '<br>先采一次，或者用 amzn_asin_upsert 带 rawSnapshot: true 写一份带原始读数的快照。</div>';
  }

  const options = slot => snapshots.map(snapshot => {
    const selected = (slot === 'from' ? b05cHistoryFrom : b05cHistoryTo) === String(snapshot.id) ? ' selected' : '';
    return '<option value="' + escapeHtml(String(snapshot.id)) + '"' + selected + '>'
      + escapeHtml(String(snapshot.id)) + ' · ' + escapeHtml(String(snapshot.collectedAt))
      + ' · ' + escapeHtml(String(snapshot.sourceId)) + ' · ' + escapeHtml(String(snapshot.fieldCount)) + ' 字段</option>';
  }).join('');

  const parts = [];
  parts.push('<div class="b05c-form">'
    + '<label class="hint" style="padding:0">起点 <select data-b05c-history-slot="from"><option value="">（上一版）</option>' + options('from') + '</select></label>'
    + '<label class="hint" style="padding:0">终点 <select data-b05c-history-slot="to"><option value="">（最新）</option>' + options('to') + '</select></label>'
    + '<button type="button" data-b05c-compare="1">比较</button>'
    + '<span class="hint" style="padding:0">共 ' + snapshots.length + ' 份'
    + (data.truncated === true ? '（只读了最近 ' + String(data.limit) + ' 份，全库 ' + String(data.total) + ' 份）' : '')
    + '</span></div>');

  const notes = Array.isArray(data.notes) ? data.notes : [];
  for (const note of notes) parts.push('<div class="b05c-note">⚠ ' + escapeHtml(String(note)) + '</div>');

  if (data.diff === null || data.diff === undefined) {
    parts.push('<div class="asin-lack">' + escapeHtml(String(notes[0] || '没有可比较的两个时间点'))
      + '<br>这与「两份快照逐项相同」不是一件事，所以这里不印「没有变化」。</div>');
    return parts.join('');
  }

  const diff = data.diff;
  const pair = data.pair || {};
  parts.push('<div class="b05c-note">比较 ' + escapeHtml(String((pair.from || {}).id)) + '@' + escapeHtml(String((pair.from || {}).collectedAt))
    + ' → ' + escapeHtml(String((pair.to || {}).id)) + '@' + escapeHtml(String((pair.to || {}).collectedAt))
    + '（' + escapeHtml(pair.selection === 'explicit' ? '按你选的' : '默认：最新两份') + '）</div>');

  const sourceChange = diff.sourceChange || {};
  /* 「来源变化」单独一行，与字段差异**分开**：它说的是采集器换了，不是内容变了。
     服务端那条 note 说清本仓没有来源的那一半（来源类型的历史），照印不换措辞。 */
  parts.push('<div class="b05c-note">来源变化：' + escapeHtml(String(sourceChange.label || '—'))
    + '<br><span class="hint" style="padding:0">⚠ ' + escapeHtml(String(sourceChange.note || '')) + '</span></div>');

  if (diff.empty === true) {
    /* 2 份以上、逐项相同 —— 这才是「没有变化」。 */
    parts.push('<div class="b05c-note ok">' + escapeHtml(String(diff.note || '这两份快照的字段逐项相同，没有变化')) + '</div>');
    return parts.join('');
  }

  const counts = diff.counts || {};
  parts.push('<div class="b05c-note">字段差异 <strong>' + escapeHtml(String(counts.total))
    + '</strong> 处（' + ASIN_CHANGE_KIND_ORDER.map(kind => escapeHtml(asinLabeled(ASIN_CHANGE_KIND_LABELS, kind))
      + ' ' + escapeHtml(String(counts[kind] === undefined ? 0 : counts[kind]))).join('　') + '）</div>');

  const rows = (Array.isArray(diff.changes) ? diff.changes : []).map(change => '<tr>'
    + '<td><code>' + escapeHtml(String(change.field)) + '</code></td>'
    + '<td>' + escapeHtml(asinLabeled(ASIN_CHANGE_KIND_LABELS, change.kind)) + '</td>'
    + '<td>' + asinText(change.before) + '</td>'
    + '<td>' + asinText(change.after) + '</td>'
    + '<td>' + escapeHtml(asinLabeled(ASIN_ATTRIBUTION_LABELS, change.attribution)) + '</td>'
    + '<td>' + (change.evidence === null || change.evidence === undefined ? '—' : '<code>' + escapeHtml(String(change.evidence)) + '</code>') + '</td>'
    + '</tr>').join('');
  parts.push('<table class="b05c-table"><thead><tr>'
    + '<th>字段</th><th>类别</th><th>前值</th><th>后值</th><th>归因</th><th>证据</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>');
  parts.push('<div class="b05c-note">类别与归因都是服务端从库里算出来的：类别看字段名与两边值的形状，'
    + '归因看 asin_field_source / publication_record / field_conflict 的证据，都不命中就是「'
    + escapeHtml(asinLabeled(ASIN_ATTRIBUTION_LABELS, 'unknown')) + '」。页面一个都不重算。</div>');
  return parts.join('');
}

/* ── F05-05 批量导入 ────────────────────────────────────────────────── */

/** 表壳只画一次：**用户输入的 textarea 不能被每 3 秒一次的轮询冲掉**，而结果区每次重画。 */
function renderAsinImportPanel() {
  const box = $('asinimport');
  if (box === null) return;
  if (box.querySelector('textarea[data-b05c-import-text]') === null) {
    box.innerHTML = '<div class="b05c-head"><strong>批量导入</strong>'
      + '<span class="hint" style="padding:0">F05-05 · 粘一份带表头的 CSV/TSV，先出计划再写</span></div>'
      + '<div class="b05c-form"><textarea data-b05c-import-text="1" '
      + 'placeholder="第一行是表头，例如：ASIN,标题,价格&#10;列的顺序随便，页面按表头文本认字段"></textarea>'
      + '<button type="button" data-b05c-import-preview="1">解析预览</button>'
      + '<button type="button" data-b05c-import-apply="1">确认导入</button>'
      + '<span class="hint" style="padding:0" data-b05c-import-hint="1"></span></div>'
      + '<div class="b05c-body" data-b05c-import-result="1"></div>';
  }
  const hint = box.querySelector('[data-b05c-import-hint]');
  if (hint !== null) {
    hint.textContent = b05cImportBusy
      ? '正在读 …'
      : '预览不写库、也不留审计行；「确认导入」才写。';
  }
  const result = box.querySelector('[data-b05c-import-result]');
  if (result !== null) result.innerHTML = asinImportBody();
  wireB05c();
}
function asinImportBody() {
  if (b05cImportError !== null) {
    return b05cRefusal('批量导入', b05cImportError, '计划没出来，库一行都没动。');
  }
  if (b05cImport === null) {
    return '<div class="asin-lack">还没有解析过任何内容。粘一段 CSV/TSV 再点「解析预览」——'
      + '预览会印出每一行会做什么、覆盖哪些格子的前值，以及那份回滚件。</div>';
  }

  const data = b05cImport;
  const parts = [];
  if (data.ok !== true) {
    parts.push('<div class="asin-problem"><strong>' + escapeHtml(String(data.code || '拒绝')) + '</strong>：'
      + escapeHtml(String(data.error || ''))
      + (data.hint ? '<br><span class="hint" style="padding:0">' + escapeHtml(String(data.hint)) + '</span>' : '')
      + '<br>上面这份预览就是被拒的那一批，库里一行都没动。</div>');
  }

  const format = data.format;
  if (format !== undefined && format !== null) {
    parts.push('<div class="b05c-note">格式：' + escapeHtml(asinLabeled(ASIN_IMPORT_DELIMITER_LABELS, format.delimiter))
      + '（' + escapeHtml(String(format.reason || '')) + '）</div>');
  }
  const mapping = data.mapping === null || data.mapping === undefined ? null : data.mapping;
  if (mapping !== null) {
    parts.push('<div class="b05c-note">映射：' + Object.keys(mapping).map(field => escapeHtml(field) + '←第' + String(mapping[field] + 1) + '列').join('　')
      + (Array.isArray(data.unmapped) && data.unmapped.length > 0
        ? '　<span class="hint" style="padding:0">认不出/重复：'
          + escapeHtml(data.unmapped.map(entry => entry.header + '（第' + (entry.index + 1) + '列）').join('、')) + '</span>'
        : '') + '</div>');
  }

  const summary = data.summary;
  if (summary !== undefined && summary !== null) {
    /* 影响预览：八个数字分开印，「会写几行」就是 create + update，页面上不自己加。 */
    parts.push('<div class="b05c-note">影响预览：' + String(summary.rows) + ' 行 —— 新增 ' + String(summary.create)
      + ' / 更新 ' + String(summary.update) + ' / 无变化 ' + String(summary.unchanged)
      + ' / 不合法 ' + String(summary.invalid) + ' / 重复 ' + String(summary.duplicate)
      + ' / 被顶掉 ' + String(summary.superseded)
      + '；会填 ' + String(summary.filledCells) + ' 格、覆盖 ' + String(summary.overwrittenCells) + ' 格'
      + '、落在多源冲突字段上 ' + String(summary.conflictCells) + ' 格</div>');
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (rows.length > 0) {
    parts.push('<table class="b05c-table"><thead><tr>'
      + '<th>行</th><th>ASIN</th><th>站点</th><th>动作</th><th>逐格（前→后）</th></tr></thead><tbody>'
      + rows.map(row => '<tr>'
        + '<td>' + escapeHtml(String(row.line)) + '</td>'
        + '<td><code>' + escapeHtml(String(row.asin)) + '</code></td>'
        + '<td>' + escapeHtml(String(row.marketplace)) + '</td>'
        + '<td>' + escapeHtml(String(row.action))
        + (row.invalidReason === null || row.invalidReason === undefined ? '' : '<div class="n">' + escapeHtml(String(row.invalidReason)) + '</div>')
        + '</td>'
        + '<td>' + (Array.isArray(row.cells) ? row.cells.filter(cell => cell.action !== 'absent').map(cell =>
          escapeHtml(String(cell.field)) + '=' + asinText(cell.before) + '→' + asinText(cell.after)
          + ' <span class="b05c-chip' + (cell.action === 'overwrite' ? ' warn' : '') + '">' + escapeHtml(String(cell.action)) + '</span>'
          + (cell.conflicts === null || cell.conflicts === undefined ? '' : ' <span class="b05c-chip warn">多源冲突</span>')).join('<br>') : '')
        + '</td></tr>').join('')
      + '</tbody></table>');
  }

  const report = data.qualityReport;
  if (report !== undefined && report !== null) {
    const blocking = Array.isArray(report.blocking) ? report.blocking : [];
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    parts.push('<h4>质量报告</h4>');
    if (blocking.length === 0 && warnings.length === 0) {
      parts.push('<div class="b05c-note ok">没有阻断项，也没有提示。</div>');
    }
    for (const entry of blocking) {
      parts.push('<div class="b05c-note err">✖ ' + escapeHtml(String(entry.code)) + '：' + escapeHtml(String(entry.message)) + '</div>');
    }
    for (const entry of warnings) {
      parts.push('<div class="b05c-note">⚠ ' + escapeHtml(String(entry.code)) + '：' + escapeHtml(String(entry.message)) + '</div>');
    }
  }

  const rollback = data.rollback;
  if (rollback !== undefined && rollback !== null && String(rollback.csv || '') !== '') {
    parts.push('<h4>回滚件（被覆盖格子的前值）</h4>');
    parts.push('<div class="b05c-note">' + escapeHtml(String(rollback.rows)) + ' 行、'
      + escapeHtml(String((rollback.fields || []).length)) + ' 个字段。' + escapeHtml(String(rollback.note || ''))
      + '<br>把下面这份再当输入导一次（onDuplicate 用 last、confirm 传 true）就是撤回。</div>');
    parts.push('<textarea readonly style="width:100%;min-height:60px;font:inherit;font-size:11px">'
      + escapeHtml(String(rollback.csv)) + '</textarea>');
  }
  return parts.join('');
}

/** 「解析预览」与「确认导入」只差一个 dryRun。两条都走同一个工具（服务端），
 *  所以计划与写库的编排只有一份实现。 */
async function b05cImportRun(dryRun) {
  const box = $('asinimport');
  if (box === null) return;
  const area = box.querySelector('textarea[data-b05c-import-text]');
  const text = area === null ? '' : String(area.value);
  b05cImportBusy = true;
  b05cImportError = null;
  b05cImport = null;
  renderAsinImportPanel();
  try {
    const payload = dryRun
      ? await api('asin-import-preview', { method: 'POST', body: JSON.stringify({ text, dryRun: true }) })
      /* 写那一条走 apiWithApproval：它的第二个参数是**请求体**（不是 fetch 选项），
         因为覆盖闸门开着时服务端回 409 + APPROVAL_REQUIRED —— 那是在**问你**，不是失败，
         而 apiWithApproval 会在确认之后用 {...body, confirm: true} 再发一次。
         传成 fetch 选项会把 body 套成 {"method":…,"body":…}，而那只会在服务端表现为
         一份解析不出来的 CSV（症状是 EMPTY_INPUT），不是这条代码的错。 */
      : await apiWithApproval('asin-import', { text, dryRun: false });
    b05cImport = payload;
  } catch (error) {
    /* 服务端的拒绝（重复行 / 不合法行 / 未确认的覆盖）**带着整份计划**，照画：
       「哪一行不对」就在这份载荷里，丢掉它等于让用户再提交一次。 */
    if (error !== null && error !== undefined && error.body !== null && error.body !== undefined) {
      b05cImport = error.body;
    } else {
      b05cImportError = error;
    }
  }
  b05cImportBusy = false;
  renderAsinImportPanel();
}

/** 每次画完都接一次线，**包括异步读回来之后那一次重画**（与 wireAsinDetail 同一条理由）。
 *  查询**限定在三个容器里**，不是全文档：全文档查 button[data-b05c-…]
 *  会把将来别人加的、同名 data 属性却属于别的面板的按钮也接上 handler —— 而那种错在页面上
 *  表现为「点了一个别的面板的按钮，导入面板动了」。（这一段里不许出现反引号。） */
function wireB05c() {
  for (const id of ['asinhealth', 'asinhistory', 'asinimport']) {
    const box = $(id);
    if (box === null) continue;
    for (const button of box.querySelectorAll('button[data-b05c-retry]')) {
      const which = String(button.dataset.b05cRetry);
      button.onclick = () => {
        if (b05cFocus === null) return undefined;
        return which === 'history' ? loadAsinHistory(b05cFocus) : loadAsinHealth(b05cFocus);
      };
    }
    for (const select of box.querySelectorAll('select[data-b05c-history-slot]')) {
      const slot = String(select.dataset.b05cHistorySlot);
      select.onchange = () => {
        if (slot === 'from') b05cHistoryFrom = String(select.value);
        else b05cHistoryTo = String(select.value);
      };
    }
    for (const button of box.querySelectorAll('button[data-b05c-compare]')) {
      button.onclick = () => (b05cFocus === null ? undefined : loadAsinHistory(b05cFocus));
    }
    for (const button of box.querySelectorAll('button[data-b05c-import-preview]')) {
      button.onclick = () => b05cImportRun(true);
    }
    for (const button of box.querySelectorAll('button[data-b05c-import-apply]')) {
      button.onclick = () => b05cImportRun(false);
    }
  }
}

/** 四个 body 的分派。注入的标签页清单与服务端的 ASIN_DETAIL_TABS 是同一份，所以这是一个
 *  **闭集**的分派 —— 出现第五个而这里没有实现时明说，不返回空串：空串读作「这一页没有数据」。 */
function asinBody(tab, data) {
  if (tab === 'overview') return asinOverviewBody(data);
  if (tab === 'fields') return asinFieldsBody(data);
  if (tab === 'sections') return asinSectionsBody(data);
  if (tab === 'variants') return asinVariantsBody(data);
  if (tab === 'keywords') return asinKeywordsBody(data);
  if (tab === 'reviews') return asinReviewsBody(data);
  if (tab === 'competitor') return asinCompetitorBody(data);
  if (tab === 'optimization') return asinOptimizationBody(data);
  if (tab === 'sources') return asinSourcesBody(data);
  return '<div class="asin-lack">这个标签页（' + escapeHtml(String(tab)) + '）在页面上还没有渲染器：'
    + '服务端的标签页清单里有它，页面不认识它 —— 这不是「没有数据」。</div>';
}

/* ── B-05d：后五个标签页（关键词与排名 / 评论问答 / 竞品对比 / 优化历史 / 来源与审计）──

   五个渲染器，一条共同纪律：**只印载荷里的字符串**。

   页面对这五页不做任何判断 —— 不看 rank 是不是 null、不看 accepted 是不是 1、
   不看 object_id 里有没有 @。每一个「状态」都由服务端的域层算好并随载荷下发
   （keywords 的三态来自 domain/keywords/competitor.js 的 classifyOurSide，竞品五桶来自
   classifyQuadrants，草案处置态来自 optimization.js 的 classifyDraftAcceptance，
   审计的 object_id 形状来自 provenance.js 的 classifyAuditObjectId）。
   页面重算一遍的代价不是「多写几行」，而是**同一条规则会有两份**：域层改坏之后，
   工具侧会红而页面侧照旧绿 —— 那正是 B-05c 在本仓踩过的那个形状。

   第二条纪律：**「本仓没有来源」不是空白**。每一页的 unsourced[] 都画成一个独立的块，
   连 reason 一起印。把它画成空表或 0 会读成「查过了、没有」，而它说的是「本仓结构上答不了」。

   第三条：**单元格带 data-b05d-cell**。页面上「这一格印的是什么」必须能被窄切片地读到 ——
   测试读那一格自己的文字，不读整份渲染。整份渲染里图例、说明、统计都会印同一个词，
   对整份渲染做 includes 断言是结构性永真（本仓 2026-10-13 的 includes 审计里 R8 就是这么红的）。

   NB: 这一段在页面脚本里，而页面脚本是外层模板字符串的一部分 —— 注释里不许出现反引号。
   每改一次跑：node scripts/check-page.mjs。 */

/** 「本仓没有来源」那几条。独立一块，连 reason 一起印 —— 不是空表，也不是 0。
 *
 *  conclusion 逐字来自载荷（服务端的 unsourced.js），页面一个字都不写：那句话在
 *  health 摘要、工具与这里必须完全一样，三处各写一遍就是三种说法。 */
function asinUnsourcedBlock(tab, what) {
  const entries = tab === null || tab === undefined || !Array.isArray(tab.unsourced) ? null : tab.unsourced;
  if (entries === null) {
    return '<div class="asin-lack">服务端没有给「' + escapeHtml(what) + '」的 unsourced 清单 —— '
      + '这不是「没有这一项」，是同一条数据在两条读路径上少了一截。</div>';
  }
  if (entries.length === 0) return '';
  const text = tab.noSourceText === null || tab.noSourceText === undefined
    ? '本仓没有来源'
    : String(tab.noSourceText);
  return '<div class="asin-unsourced">'
    + '<div class="asin-note"><strong>' + escapeHtml(text) + '</strong>（'
    + asinText(entries.length) + ' 项）—— 不是「没有数据」，是「本仓没有来源」：</div>'
    + entries.map(entry => '<div class="asin-unsourced-item" data-b05d-unsourced-id="'
      + escapeHtml(String(entry.id)) + '">'
      + '<div><strong>' + escapeHtml(String(entry.label)) + '</strong>'
      + '（' + escapeHtml(String(entry.feature)) + '）'
      + '<span data-b05d-cell="unsourced-conclusion">' + escapeHtml(String(entry.conclusion)) + '</span>'
      + '</div>'
      + '<div class="hint" style="padding:0">' + escapeHtml(String(entry.reason)) + '</div>'
      + '</div>').join('')
    + '</div>';
}

/** 载荷里那一块的 note 列表。它们不是装饰：「没读回来」与「库里没有」的差别就在这里。 */
function asinNoteList(tab) {
  const notes = tab === null || tab === undefined || !Array.isArray(tab.notes) ? [] : tab.notes;
  if (notes.length === 0) return '';
  return '<div class="asin-note">' + notes.map(note => 'ⓘ ' + escapeHtml(String(note))).join('<br>') + '</div>';
}

/** 一个「块里没有这一格」的说明。与 asinLack 分开：那一个说的是整块缺失。 */
function asinMissingBlock(what, tabName) {
  return asinLack(what) + '<div class="asin-note">（页签：' + escapeHtml(String(tabName)) + '）</div>';
}

/** 关键词与排名：一行一个「词 × 来源」，状态印服务端给的 stateLabel。 */
function asinKeywordsBody(data) {
  const tab = data.keywords === null || data.keywords === undefined ? null : data.keywords;
  if (tab === null) return asinMissingBlock('关键词与排名', 'keywords');

  const counts = tab.counts || {};
  const rows = Array.isArray(tab.rows) ? tab.rows : [];
  const head = '<div class="asin-note">单位：一行一个「关键词 × 来源」'
    + '（asin_keyword 的主键含 source_id，所以同一个词被两个来源测过就是两行）'
    + '。共 ' + asinText(counts.rows) + ' 行：有名次 ' + asinText(counts.ranked)
    + ' · 测过没找到 ' + asinText(counts.absent) + ' · 未测 ' + asinText(counts.untested)
    + '。来源 ' + asinText(tab.source) + '。</div>';

  if (rows.length === 0) {
    return head + '<div class="asin-note">这条 ASIN 在 asin_keyword 里一行都没有 —— '
      + '「从没采过关键词」与「采过、一个词都没排上」不是一件事。</div>'
      + asinUnsourcedBlock(tab, '关键词与排名') + asinNoteList(tab);
  }

  const body = '<table class="asin-table"><thead><tr>'
    + '<th>关键词</th><th>来源</th><th>状态</th><th>名次</th><th>页/深度</th>'
    + '<th>搜索量</th><th>档位</th><th>采集于</th></tr></thead><tbody>'
    + rows.map(row => '<tr>'
      + '<td>' + escapeHtml(String(row.keyword)) + '</td>'
      + '<td>' + escapeHtml(String(row.sourceId)) + '</td>'
      /* 这一格读的是服务端算好的 stateLabel，页面不看 row.rank。 */
      + '<td data-b05d-cell="keywords-state">' + escapeHtml(String(row.stateLabel)) + '</td>'
      + '<td>' + asinText(row.rank === null ? '—（没有名次）' : row.rank) + '</td>'
      + '<td>' + asinText(String(row.page === null ? '—' : row.page) + '/' + String(row.scanDepth === null ? '—' : row.scanDepth)) + '</td>'
      + '<td>' + asinText(row.searchVolume) + '</td>'
      + '<td>' + (row.master === null ? '总库里没有这个词' : 'tier ' + asinText(row.master.tier)) + '</td>'
      + '<td>' + asinText(row.collectedAt) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';

  const truncated = tab.totals && tab.totals.truncated === true
    ? '<div class="asin-note">库里共 ' + asinText(tab.totals.rows) + ' 行，这次只读回 '
      + asinText(tab.totals.read) + ' 行 —— 「没读回来」与「库里没有」不是一件事。</div>'
    : '';

  return head + body + truncated + asinUnsourcedBlock(tab, '关键词与排名') + asinNoteList(tab);
}

/** 评论问答：四格读数逐格说「有/没有」，Q&A 走 unsourced 块。 */
function asinReviewsBody(data) {
  const tab = data.reviews === null || data.reviews === undefined ? null : data.reviews;
  if (tab === null) return asinMissingBlock('评论问答', 'reviews');

  const section = tab.section;
  const head = '<div class="asin-note">这一页的读数是 13 节里 <code>reviews</code> 那一节的最新一行'
    + '（来源 ' + asinText(tab.source) + '）。'
    + (section === null
      ? '库里连这一节的行都没有。'
      : '状态 ' + asinText(section.statusLabel) + ' · 采集于 ' + asinText(section.collectedAt)
        + ' · 任务 ' + asinText(section.taskId) + ' · 方案版本 ' + asinText(section.schemeVersion) + '。')
    + '</div>';

  const state = '<div class="asin-note">这一页的状态：'
    + '<span data-b05d-cell="reviews-state">' + escapeHtml(String(tab.stateLabel)) + '</span>'
    + '（' + escapeHtml(String(tab.state)) + '）</div>';

  /* 四格逐格说。0 与「没有这一格」在页面上必须长得不一样：前者是测出来的 0，
     后者是这一格没有读数。所以这里印的是 present 布尔，不是值的真假。 */
  const cells = (Array.isArray(tab.fields) ? tab.fields : []).map(cell =>
    '<div>' + escapeHtml(String(cell.label)) + '：'
    + '<span data-b05d-cell="reviews-field">' + (cell.present ? '有读数' : '没有这一格') + '</span>'
    + (cell.present ? ' —— ' + asinText(cell.id === 'review_items'
      ? String(tab.itemCount) + ' 条样本'
      : cell.value) : '')
    + '</div>').join('');

  const totals = '<div class="asin-note">评论总数 '
    + '<span data-b05d-cell="reviews-total">'
    + (tab.totals.reviewsTotal === null ? '—（没有读数）' : escapeHtml(String(tab.totals.reviewsTotal)))
    + '</span> · 页面可见 '
    + (tab.totals.reviewsVisible === null ? '—（没有读数）' : asinText(tab.totals.reviewsVisible))
    + ' · 摘要 ' + asinText(tab.summary) + '</div>';

  const items = Array.isArray(tab.items) && tab.items.length > 0
    ? '<table class="asin-table"><thead><tr><th>#</th><th>评分</th><th>标题</th><th>正文</th></tr></thead><tbody>'
      + tab.items.map(item => '<tr>'
        + '<td>' + asinText(item.index) + '</td>'
        + '<td>' + asinText(item.rating) + '</td>'
        + '<td>' + asinText(item.title) + '</td>'
        + '<td>' + asinText(item.body) + '</td>'
        + '</tr>').join('')
      + '</tbody></table>'
    : '<div class="asin-note">读数里没有逐条评论样本 —— 「样本是空的」与「这一节没采到」是两件事，'
      + '后者看上面的状态。</div>';

  return head + state + totals + '<div class="asin-note">四格读数：</div>' + cells + items
    + reviewAnalysisBlock(tab)
    + asinUnsourcedBlock(tab, '评论问答') + asinNoteList(tab);
}

/* T70 评论分析区块（LLD §2.5；O-01 拍板）：四态分开，「没跑过」≠「跑了是 0 个痛点」。
   分布与标签各带口径（分布=当前家族行聚合；标签计数=去重评论条数）；标签 count<2
   只列计数不给结论句；覆盖率必印（低覆盖率=结论弱，不是「没有痛点」）；三元组随行。
   计数判读走 domain/ui/count-verdict.js 单点（这里不重判）。 */
function reviewAnalysisBlock(tab) {
  const a = tab.reviewAnalysis === null || tab.reviewAnalysis === undefined ? null : tab.reviewAnalysis;
  const head = '<div class="asin-note"><b>评论分析</b>（词典法）</div>';
  if (a === null || a.hasRun !== true) {
    return head + '<div class="asin-note" data-b05d-cell="t70-analysis-state">还没跑过分析 —— '
      + '「没跑过」不是「跑了是 0 个痛点」。跑一次评论分析后再来看。</div>';
  }
  const triple = '<div class="asin-note">三元组：来源 ' + asinText(a.triple.source)
    + ' · 时间 ' + asinText(a.triple.time) + ' · 样本 ' + asinText(a.triple.sample) + '</div>';
  if (a.insufficient === true) {
    return head + triple
      + '<div class="asin-note" data-b05d-cell="t70-analysis-state">样本不足以判读（'
      + asinText(a.sampleN) + ' < ' + asinText(5) + '）—— 不给 0 结论。</div>';
  }
  const dist = a.distribution || { stars: [], denominator: 0, unrated: 0 };
  const distRows = dist.stars.map(star => '<tr>'
    + '<td>' + asinText(star.star) + ' 星</td>'
    + '<td data-b05d-cell="t70-star-num">' + asinText(star.numerator) + '</td>'
    + '<td>' + asinText(dist.denominator) + '</td>'
    + '</tr>').join('');
  const distTable = '<table class="asin-table"><thead><tr><th>评分</th><th>分子</th><th>分母</th></tr></thead><tbody>'
    + distRows + '</tbody></table>'
    + '<div class="asin-note">未评分 ' + asinText(dist.unrated) + ' 条（不进 1-5 分母）。</div>';
  const labels = Array.isArray(a.labels) ? a.labels : [];
  const labelRows = labels.length === 0
    ? '<div class="asin-note" data-b05d-cell="t70-analysis-state">词表没命中任何标签 —— 覆盖率 0 不是「没有主题」，是词表没覆盖到。</div>'
    : '<table class="asin-table"><thead><tr><th>类别</th><th>标签</th><th>命中评论数</th><th>结论</th></tr></thead><tbody>'
      + labels.map(label => '<tr>'
        + '<td>' + asinText(label.category) + '</td>'
        + '<td>' + asinText(label.label) + '</td>'
        + '<td data-b05d-cell="t70-label-count">' + asinText(label.count) + '</td>'
        + '<td data-b05d-cell="t70-label-verdict">' + (label.conclusionAllowed ? '可判' : '只列计数不判（<2）') + '</td>'
        + '</tr>').join('')
      + '</tbody></table>';
  const coverage = '<div class="asin-note">覆盖率 <span data-b05d-cell="t70-coverage">'
    + asinText(a.matchedN) + '/' + asinText(a.sampleN) + '</span>（命中评论数/样本数；'
    + '覆盖率低=结论弱，不是「没有痛点」；四类不合成总分；'
    + '标签不互斥：各标签计数合计可以大于样本数）</div>';
  return head + triple + distTable + labelRows + coverage;
}

/** 竞品对比：组归属 + 五桶。桶名、象限标签、计数全部印载荷里的。 */
function asinCompetitorBody(data) {
  const tab = data.competitor === null || data.competitor === undefined ? null : data.competitor;
  if (tab === null) return asinMissingBlock('竞品对比', 'competitor');

  const membership = Array.isArray(tab.membership) ? tab.membership : [];
  const head = '<div class="asin-note">这条 ASIN 出现在 ' + asinText(tab.memberSetCount)
    + ' / ' + asinText(tab.setCount) + ' 个竞品组里（本站点）。'
    + (tab.peersSource === null ? '' : asinText(tab.peersSource) + '。')
    + '对端 ' + asinText(tab.peerCount) + ' 个。来源 ' + asinText(tab.source) + '。</div>';

  const sets = membership.length === 0
    ? '<div class="asin-note">本站点一个竞品组都没有 —— 缺的是竞品组本身，不是「没有竞品」。</div>'
    : '<table class="asin-table"><thead><tr><th>组</th><th>成员</th><th>含这条</th><th>备注</th><th>更新于</th></tr></thead><tbody>'
      + membership.map(set => '<tr>'
        + '<td>' + escapeHtml(String(set.name)) + '</td>'
        + '<td>' + asinText(set.memberCount) + '</td>'
        + '<td data-b05d-cell="competitor-contains">' + (set.containsThis ? '是' : '否') + '</td>'
        + '<td>' + asinText(set.note) + '</td>'
        + '<td>' + asinText(set.updatedAt) + '</td>'
        + '</tr>').join('')
      + '</tbody></table>';

  const note = tab.comparisonNote === null || tab.comparisonNote === undefined
    ? ''
    : '<div class="asin-note" data-b05d-cell="competitor-note">' + escapeHtml(String(tab.comparisonNote)) + '</div>';

  /* ── CR-1 竞品象限卡（设计 v3 §2，design-opt-v3-2026-10-23.md）──────────────
     页面不分桶、只印载荷：桶名（labels）、象限标签（quadrant_label）、计数（counts）
     全部来自 comparison 盒（classifyQuadrants 的产出）；动作语义是设计 §2.2 的固定
     文案，逐字照抄。两条口径红线在这里落地：
       ① 未测 ≠ 缺席 —— 「未测」格挂「没测过 ≠ 缺席」文字标记 + 虚线框（不靠颜色
          单独表意），候选词只从自有缺席桶出，未测桶绝不出现「候选」动作；
     （这段注释不写反引号：本文件整个是模板字面量，反引号会把字符串断开。）
     T68 起②升级为「测量期不一致不出判读」：comparison.periods 带来双侧测量期与
     判读闸门（域层 buildEvidenceView §20.3 的判据），槽里印真值；闸门关上时
     警告条出现、判读列逐行「不判读」、候选词行收起。载荷缺字段仍印「本处未记」。 */
  let comparison = '';
  if (tab.comparison === null || tab.comparison === undefined) {
    /* 四态之空（§2.4）：缺的是竞品组本身就说建组 —— 不留白，也**不画五桶 0**，
       0 是测出来的数，这里连测量都还没有。 */
    const noSet = Number(tab.memberSetCount ?? 0) === 0;
    comparison = '<div class="asin-note" data-b05d-cell="cr1-empty">'
      + (noSet
        ? '还没有竞品组 —— 缺的是竞品组本身，不是『没有竞品』。先在『竞品数据分析』建一个对比组，再来这里看象限。'
        : '对比组里没有对端成员，象限画不出来 —— 缺的不是『没有竞品』。')
      + '</div>'
      + (noSet
        ? '<div class="asin-note"><button type="button" data-cr1-goto="competitor">去『竞品数据分析』建组</button></div>'
        : '');
  } else {
    const box = tab.comparison;
    const order = Array.isArray(box.order) ? box.order : [];
    const counts = box.counts || {};
    const ACTIONS = {
      ownAdvantage: '守位词',
      contested: '盯排名',
      ourAbsent: '唯一出候选词的桶',
      brandOnly: '隔离，不作机会',
      unmeasured: '「要判读先测量」，不印「加入候选」',
    };
    const setNames = (Array.isArray(tab.membership) ? tab.membership : [])
      .filter(entry => entry.containsThis === true).map(entry => String(entry.name));
    /* T68：测量期槽接 comparison.periods（域层从证据读端接来的双侧 collected_at）。
       有则印真值（多观测日不压成一天，如实列出）；没有才印「本处未记」。 */
    const periodSlot = periods => {
      if (periods === null || periods === undefined) return '本处未记';
      if (periods.period !== null && periods.period !== undefined) return String(periods.period);
      if (Array.isArray(periods.dates) && periods.dates.length > 0) return periods.dates.join('、');
      return '本处未记';
    };
    const periods = box.periods ?? null;
    const oursText = periodSlot(periods === null ? null : periods.ours);
    const theirsText = periodSlot(periods === null ? null : periods.theirs);
    const judgementBlocked = periods !== null && periods.judgementBlocked === true;
    const cardHead = '<div class="asin-note"><b>竞品象限（关键词）</b> · 对比组 '
      + escapeHtml(setNames.join('、') === '' ? '（未记）' : setNames.join('、'))
      + ' · 成员 ' + asinText(tab.peerCount) + ' · 我方 ' + asinText(tab.asin)
      + ' · 两侧测量期：我方 <span data-b05d-cell="cr1-period-ours">' + escapeHtml(oursText) + '</span>'
      + ' / 对端 <span data-b05d-cell="cr1-period-theirs">' + escapeHtml(theirsText) + '</span>'
      + (oursText === '本处未记' && theirsText === '本处未记'
        ? ' —— 测量期没记，这一轮不出判读。'
        : '')
      + '</div>';
    /* T68：测量期警告条（§2.3-2）。触发判据只有两条，都出自域层（buildEvidenceView
       §20.3 的原话）：两侧周期不同 / 竞品侧自己跨多个观测日。两条各说各的话，不合并
       （混成一条就把「两侧不同」与「一侧自己不齐」说成了一件事）。闸门是域层给的
       判定，页面照印不判。 */
    const warningLine = judgementBlocked
      ? '<div class="asin-note" data-b05d-cell="cr1-period-warning">'
        + (periods.periodMismatch === true
          ? '两侧测量期不同（我方 ' + escapeHtml(oursText) + ' / 对端 ' + escapeHtml(theirsText)
            + '），这一轮不判读；请对同一期间重新测量后再比。'
          : '这一轮不判读。')
        + (periods.warning === null || periods.warning === undefined ? '' : ' ' + escapeHtml(String(periods.warning)))
        + '</div>'
      : '';
    /* 五桶计数条：5 张小卡 = 桶名 + 词数 + 动作语义。未测格另挂文字标记。 */
    const strip = '<div class="asin-note">' + order.map(bucket => {
      const dashed = bucket === 'unmeasured' ? ';border:1px dashed var(--line)' : '';
      return '<div data-cr1-bucket="' + escapeHtml(String(bucket)) + '"'
        + ' style="display:inline-block;padding:2px 8px;margin:2px' + dashed + '">'
        + '<span data-b05d-cell="cr1-bucket-label">' + escapeHtml(String(box.labels[bucket])) + '</span> '
        + '<span data-b05d-cell="cr1-bucket-count">' + asinText(counts[bucket]) + '</span> 词 · '
        + '<span data-b05d-cell="cr1-action">' + escapeHtml(String(ACTIONS[bucket] ?? '')) + '</span>'
        + ' <span data-b05d-cell="cr1-bucket-mark">' + (bucket === 'unmeasured' ? '没测过 ≠ 缺席' : '') + '</span>'
        + '</div>';
    }).join('') + '</div>';
    /* T-4b（自洽）：对端未测量的行数 > 0 时单独说一句。
       不改桶名、不改逐词象限格 —— 那两处被已评审的断言按字面钉住，碰一下就红。
       这里只把「这些词的对端没测过」说出来：否则左边把它们算进自有优势、
       右边在「对端命中」格印「该词无竞品数据」，同一行两句矛盾的话。
       归类本身要不要改是 T-4a（产品口径），不改之前先把话说全。 */
    const noDataTotal = Number(box?.noDataTotal ?? 0);
    const noDataNote = noDataTotal > 0
      ? '<div class="asin-note" data-b05d-cell="cr1-unmeasured-note">'
        + '本页 ' + asinText(noDataTotal) + ' 条词的对端未测量 —— '
        + '不是「他们没上榜」，是「没测过」。仍按现有归类显示，'
        + '归类口径待定（T-4a）。</div>'
      : '';
    /* 候选词只出自有缺席桶（§2.2）；逐词一个格，未测的词绝不会出现在这里。
       T68：判读闸门关上时**整个收起** —— 候选/机会就是结论，红线说「不出判读」。 */
    const candidates = Array.isArray(box.candidates) ? box.candidates : [];
    const candidateLine = (candidates.length === 0 || judgementBlocked)
      ? ''
      : '<div class="asin-note">候选词（只有自有缺席出候选）：'
        + candidates.map(entry => '<span data-b05d-cell="cr1-candidate-mark">'
          + escapeHtml(String(entry.keyword)) + '</span>').join('、') + '</div>';
    /* 逐桶折叠明细：自有缺席默认展开（唯一出候选的桶），其余折叠。 */
    const details = order.map(bucket => {
      const rows = Array.isArray(box.quadrants[bucket]) ? box.quadrants[bucket] : [];
      const body = rows.length === 0
        ? '<div class="asin-note">这一桶 0 条。</div>'
        : '<table class="asin-table"><thead><tr><th>关键词</th><th>象限</th><th>我方</th>'
          + '<th>扫描深度</th><th>对端最好</th><th>对端命中</th><th>量来源</th><th>判读</th></tr></thead><tbody>'
          + rows.map(row => '<tr>'
            + '<td>' + escapeHtml(String(row.keyword)) + '</td>'
            /* 象限标签来自 classifyQuadrants，页面不自己分桶。
               这一行的变量名钉死叫 row：b05d-W9 的「页面读域层算好的标签」清单
               按 'row.quadrant_label' 字面找读取点，改名会让那条断言变空检查。 */
            + '<td data-b05d-cell="competitor-quadrant">' + escapeHtml(String(row.quadrant_label)) + '</td>'
            + '<td>' + asinText(row.our_rank) + '</td>'
            /* 扫描深度槽（T68 接线后印真值）：「测了不在前 N」的 N；没记深度
               （= 未测口径）印「本处未记」，不是 0、不是空。 */
            + '<td data-b05d-cell="cr1-scan-depth">'
            + (row.our_scan_depth === null || row.our_scan_depth === undefined
              ? '本处未记'
              : escapeHtml(String(row.our_scan_depth)))
            + '</td>'
            + '<td data-b05d-cell="cr1-peer-best">' + asinText(row.competitor_best_rank) + '</td>'
            + '<td data-b05d-cell="cr1-peer-hit">' + (row.no_data === true
              ? '该词无竞品数据'
              : asinText(String(row.competitor_ranked_count) + '/' + String(row.competitor_total))) + '</td>'
            /* 量来源：origin 是载荷给的三值一空（measured/master/competitor_fact）。
               空 = 没有量 → 「本处未记」。中文化映射归 CR-5 单源词表，这里不自造。 */
            + '<td data-b05d-cell="cr1-volume">' + (row.origin === null || row.origin === undefined
              ? '本处未记'
              : asinText(row.origin)) + '</td>'
            /* 判读列（T68）：verdict 是域层 buildEvidenceView 的结论对象 ——
               两侧同期且都有测量才有；null（周期不同 / 竞品侧多观测日 / 一侧没测）
               就印「不判读」。页面不判，只印判据的裁决。 */
            + '<td data-b05d-cell="cr1-verdict">' + (row.verdict === null || row.verdict === undefined
              ? '不判读'
              : '判读：我方 ' + (row.verdict.our_rank === null || row.verdict.our_rank === undefined
                ? '—'
                : escapeHtml(String(row.verdict.our_rank)))
                + ' / 对端 ' + (row.verdict.competitor_best_rank === null || row.verdict.competitor_best_rank === undefined
                  ? '—'
                  : escapeHtml(String(row.verdict.competitor_best_rank)))) + '</td>'
            + '</tr>').join('')
          + '</tbody></table>';
      return '<details data-cr1-detail="' + escapeHtml(String(bucket)) + '"'
        + (bucket === 'ourAbsent' ? ' open' : '') + '>'
        + '<summary>' + escapeHtml(String(box.labels[bucket])) + '（' + asinText(rows.length) + ' 条）'
        + (box.truncated && box.truncated[bucket] === true
          ? '（只印前 ' + asinText(box.limit) + ' 条 —— 没印出来 ≠ 这一桶里没有）'
          : '')
        + '</summary>' + body + '</details>';
    }).join('');
    /* 口径注脚（§2.3-5，必备）：分类总数与输入词数当场对账。 */
    const foot = '<div class="asin-note" data-b05d-cell="cr1-foot">输入 ' + asinText(box.inputTotal)
      + ' 个词，分类 ' + asinText(box.classified) + ' 个'
      + (box.inputTotal === box.classified ? '（全划分）' : '（两者不等：分类漏词或重复计数）') + '。</div>';
    comparison = cardHead + warningLine + strip + noDataNote + candidateLine + details + foot;
  }

  return head + sets + note + comparison + asinUnsourcedBlock(tab, '竞品对比') + asinNoteList(tab);
}

/** 优化历史：逐轮 + 草案逐字段 + 发布记录。草案处置态印服务端的 acceptedLabel。 */
function asinOptimizationBody(data) {
  const tab = data.optimization === null || data.optimization === undefined ? null : data.optimization;
  if (tab === null) return asinMissingBlock('优化历史', 'optimization');

  const totals = tab.totals || {};
  const head = '<div class="asin-note">共 ' + asinText(tab.runCount) + ' 轮优化；草案 '
    + asinText(totals.drafts) + ' 条：已采纳 ' + asinText(totals.accepted) + ' / 未采纳 '
    + asinText(totals.declined) + ' / 待裁决 ' + asinText(totals.pending) + ' / 已作废 '
    + asinText(totals.voided) + ' / 已延后 ' + asinText(totals.deferred)
    + '。来源 ' + asinText(tab.source) + '。</div>';

  const runs = Array.isArray(tab.runs) ? tab.runs : [];
  const runBlocks = runs.length === 0
    ? '<div class="asin-note">这条 ASIN 一轮优化都没有 —— 「从没跑过优化」与「跑过、没有改动」不是一件事。</div>'
    /* NB: 这个回调参数**不能叫 run**。页面脚本外面那个「每个运行字段都在载荷里」的
       守卫会扫脚本文本，把以 run 加一个点开头的属性链当成 optimize 载荷的字段，
       而它会解析到 undefined（那个载荷里的运行对象是另一张表的事）—— 一个参数名
       就能让守卫报一个不存在的字段。命名成 runRow 是刻意的。（这段注释里也刻意
       不写那个字面量：守卫连注释一起扫。） */
    : runs.map(runRow => {
      const drafts = Array.isArray(runRow.drafts) ? runRow.drafts : [];
      return '<div class="asin-run" data-b05d-run="' + escapeHtml(String(runRow.id)) + '">'
        + '<div class="asin-note"><code>' + escapeHtml(String(runRow.id)) + '</code> '
        + escapeHtml(String(runRow.statusLabel)) + ' · ' + asinText(runRow.startedAt) + ' → ' + asinText(runRow.finishedAt)
        + ' · 草案 ' + asinText(runRow.draftCount) + ' 条（版本 ' + asinText(runRow.draftVersion) + '）'
        + ' · 报告 ' + (runRow.hasReport ? '有正文' : '没有正文')
        + ' · 规则版本 ' + asinText(runRow.rulesVersion) + '</div>'
        + (drafts.length === 0 ? '<div class="asin-note">这一轮没有任何草案字段。</div>'
          : '<table class="asin-table"><thead><tr><th>字段</th><th>前</th><th>后</th>'
            + '<th>处置</th><th>严重级</th></tr></thead><tbody>'
            + drafts.map(draft => '<tr>'
              + '<td>' + escapeHtml(String(draft.field)) + '</td>'
              + '<td>' + asinText(draft.before) + '</td>'
              + '<td>' + asinText(draft.after) + '</td>'
              /* 处置态：先作废/延后，再采纳 —— 判据在 domain，页面只印。 */
              + '<td data-b05d-cell="optimization-accepted">' + escapeHtml(String(draft.acceptedLabel)) + '</td>'
              + '<td>' + asinText(draft.severity) + '</td>'
              + '</tr>').join('')
            + '</tbody></table>')
        + '</div>';
    }).join('');

  const publications = Array.isArray(tab.publications) ? tab.publications : [];
  const pubBlock = publications.length === 0
    ? '<div class="asin-note">没有发布记录 —— 「没发布过」与「发布记录读不出来」不是一件事，'
      + '后者会让这一句变成假的。</div>'
    : '<div class="asin-note">发布记录 ' + asinText(tab.publicationCount) + ' 条：</div>'
      + '<table class="asin-table"><thead><tr><th>id</th><th>类型</th><th>发布</th><th>偏离</th>'
      + '<th>回滚任务</th><th>观测计划</th></tr></thead><tbody>'
      + publications.map(record => '<tr>'
        + '<td>' + escapeHtml(String(record.id).slice(0, 8)) + '</td>'
        + '<td>' + escapeHtml(String(record.kind)) + '</td>'
        + '<td>' + asinText(record.publishedAt) + '</td>'
        + '<td data-b05d-cell="optimization-deviated">'
        + (record.deviated ? '是（' + escapeHtml(String(record.deviationRule)) + '）' : '否') + '</td>'
        + '<td>' + asinText(record.rollbacks.length) + '</td>'
        + '<td>' + asinText(record.observationPlans.length) + '</td>'
        + '</tr>').join('')
      + '</tbody></table>';

  return head + runBlocks + pubBlock + asinUnsourcedBlock(tab, '优化历史') + asinNoteList(tab);
}

/** 来源与审计：逐字段来源 + 审计流水（三种 object_id 形状都读）。 */
function asinSourcesBody(data) {
  const tab = data.sources === null || data.sources === undefined ? null : data.sources;
  if (tab === null) return asinMissingBlock('来源与审计', 'sources');

  const counts = tab.fieldCounts || {};
  const head = '<div class="asin-note">字段来源 ' + asinText(counts.rows) + ' 行 / '
    + asinText(counts.fields) + ' 个字段：有观测时间 ' + asinText(counts.observed)
    + ' · 未记录观测时间 ' + asinText(counts.unobserved)
    + ' · 未知来源类型 ' + asinText(counts.unknownSourceType)
    + ' · 多源不同值 ' + asinText(counts.conflicted)
    + '。来源 ' + asinText(tab.source) + '。</div>';

  const byField = Array.isArray(tab.byField) ? tab.byField : [];
  const fieldBlock = byField.length === 0
    ? '<div class="asin-note">asin_field_source 里这条 ASIN 一行都没有 —— '
      + '那是「从没记过来源」，不是「来源是空的」。</div>'
    : '<table class="asin-table"><thead><tr><th>字段</th><th>来源数</th><th>不同值</th>'
      + '<th>冲突</th><th>来源（类型）</th><th>观测于</th><th>观测时间</th></tr></thead><tbody>'
      + byField.map(group => '<tr>'
        + '<td>' + escapeHtml(String(group.field)) + '</td>'
        + '<td>' + asinText(group.sourceCount) + '</td>'
        + '<td>' + asinText(group.distinctValues) + '</td>'
        + '<td data-b05d-cell="sources-conflicted">' + (group.conflicted ? '是' : '否') + '</td>'
        + '<td>' + group.sources.map(source => escapeHtml(String(source.sourceId))
          + '（' + escapeHtml(String(source.sourceTypeLabel)) + '）').join('、') + '</td>'
        + '<td>' + group.sources.map(source => asinText(source.observedAt)).join('、') + '</td>'
        /* 这一格印的是 domain 算好的 stateLabel：「未记录观测时间」与「观测于 0 点」
           是两件事，而一个空白单元格读起来像第三种。 */
        + '<td data-b05d-cell="sources-observed">'
        + group.sources.map(source => escapeHtml(String(source.stateLabel))).join('、') + '</td>'
        + '</tr>').join('')
      + '</tbody></table>';

  const audit = Array.isArray(tab.audit) ? tab.audit : [];
  const forms = Array.isArray(tab.auditObjectIdForms) ? tab.auditObjectIdForms : [];
  const formCounts = tab.auditFormCounts || {};
  const auditHead = '<div class="asin-note">审计流水 ' + asinText(tab.auditCount) + ' 行'
    + (tab.auditTruncated ? '（共 ' + asinText(tab.auditTotal) + ' 行，只印最新那些）' : '')
    + '。按 object_id 的形状：'
    + forms.map(form => escapeHtml(String(tab.auditObjectIdFormLabels[form])) + ' '
      + asinText(formCounts[form])).join(' · ')
    + ' —— 一条 object_id 只查一种形状会漏掉另一种，所以三种都查。</div>';

  const auditBlock = audit.length === 0
    ? '<div class="asin-note">这条 ASIN 一条审计行都没有。'
      + '审计从它上线那一刻起才生效，开发期的既有数据没有审计行 —— 那是事实，不是缺失。</div>'
    : '<table class="asin-table"><thead><tr><th>时间</th><th>动作</th><th>对象</th><th>形状</th>'
      + '<th>按哪种形状命中</th><th>路</th></tr></thead><tbody>'
      + audit.map(entry => '<tr>'
        + '<td>' + asinText(entry.at) + '</td>'
        + '<td>' + escapeHtml(String(entry.action)) + '</td>'
        + '<td>' + asinText(entry.objectId) + '</td>'
        + '<td data-b05d-cell="sources-form">' + escapeHtml(String(entry.objectIdFormLabel)) + '</td>'
        + '<td data-b05d-cell="sources-matched">' + escapeHtml(String(entry.matchedBy)) + '</td>'
        + '<td>' + escapeHtml(String(entry.route)) + '</td>'
        + '</tr>').join('')
      + '</tbody></table>';

  const rest = '<div class="asin-note">版本索引 ' + asinText(tab.snapshotCount) + ' 条'
    + ' · 采集方案版本 ' + asinText(tab.schemeVersionCount) + ' 条'
    + ' · 待裁决冲突 ' + asinText(tab.conflictCount) + ' 条'
    + ' · 归档事件 ' + asinText((tab.archiveEvents || []).length) + ' 条。</div>';

  return head + fieldBlock + auditHead + auditBlock + rest
    + asinUnsourcedBlock(tab, '来源与审计') + asinNoteList(tab);
}

/** 一个比例，**带分母与扣分项**。
 *
 *  服务端给的是 {value,total,percent,missing,basis} 五件套，页面照五件套印：一个 30% 与一个
 *  3/10 在页面上是两句不同的话。分母为 0 时 percent 是 null（0/0 不是一个比率），页面照 null
 *  说出来，不补一个 0 —— 补出来的那个 0 读起来是「一个都没采到」，而事实是「无从而谈」。 */
function asinRatio(item) {
  const percent = item.percent === null || item.percent === undefined
    ? '无百分比（0/0 不是一个比率）'
    : asinText(item.percent) + '%';
  const missing = Array.isArray(item.missing) ? item.missing : [];
  return '<div>' + asinText(item.label) + '：<strong>' + asinText(item.value) + '/' + asinText(item.total)
    + '</strong>（' + percent
    + (missing.length === 0 ? '' : '；扣分项 ' + escapeHtml(missing.join('、')))
    + '）<br><span class="hint" style="padding:0">分母的来历：' + asinText(item.basis) + '</span></div>';
}

/** 事实网格里的时间：ISO 串是给机器看的。转成本地「YYYY-MM-DD HH:mm」，
 *  转不了（不是日期）就原样返回 —— 不猜一个看起来像时间的字符串。 */
function asinWhen(value) {
  const text = String(value === null || value === undefined ? '' : value);
  if (text === '') return value;
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return value;
  const pad = number => (number < 10 ? '0' : '') + number;
  return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate())
    + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes());
}

/** 概览页：一张能扫的事实网格 + 一行读数芯片，其余收进折叠区。
 *
 *  改前这一页是八个小节连着印（关键事实 / 完整率 / 新鲜度 / 多源冲突 / 下游计数 /
 *  来源 / 另外三页的同一个数字 / 本批未计入）。1440×900 实测 1310 字、53 行、1187px
 *  高、0 张表 —— 点开一条 ASIN 想回答的是「这条是什么、缺什么、下一步点哪」，
 *  拿到的是一屏解释。
 *
 *  改法是**分层，不是删字**：第一层只留事实网格与五个读数，第二层把每一节的说明连
 *  分母来历一起放进 details，summary 上带该节自己的读数。收起不等于藏掉 —— 折叠区的
 *  文字仍在 DOM 里，完整率的分母、扣分项点名、来源 id 这些断言一条都没失效。 */
function asinOverviewBody(data) {
  const overview = data.overview === null || data.overview === undefined ? null : data.overview;
  if (overview === null) return asinLack('概览');

  const identity = overview.identity || {};
  const facts = [
    ['标题', identity.title],
    ['品牌', identity.brand],
    ['价格', identity.price === null || identity.price === undefined
      ? null
      : String(identity.price) + ' ' + String(identity.currency === null || identity.currency === undefined ? '' : identity.currency)],
    ['BSR', identity.bsr],
    ['类目', identity.category],
    ['评分', identity.rating],
    ['评论数', identity.reviews],
    ['产品线', identity.productLineId],
    ['主来源', identity.primarySourceId],
    ['首次见到', identity.firstSeenAt, 'when'],
    /* 「最后更新」单独看着会和列表页的「最近采集」打架：一个是字段被写过的时刻
       （含人工修正、导入），一个是最后一次抓取。名字写全，读的人才不会以为两处矛盾。 */
    ['字段写入时间', identity.updatedAt, 'when'],
    ['主图', identity.imageUrl],
  ];
  /* 一格一个字段，两列并排（宽屏四列）。用 div 网格而不是 table：全局的
     tbody tr 带 cursor:pointer，一张不能点的表长得像能点。
     title 里放原始值（ISO 串在悬停时仍然读得到），格子里放人读得懂的写法。 */
  const factGrid = '<div class="asin-facts">' + facts.map(pair => '<div class="k">'
    + escapeHtml(pair[0]) + '</div><div title="' + asinText(pair[1]) + '">'
    + asinText(pair[2] === 'when' ? asinWhen(pair[1]) : pair[1]) + '</div>').join('') + '</div>';

  /* #6：三处时间是三个动作，格式统一成本地时间；原始 UTC 都在 title 里。 */
  const timeNote = '<div class="hint" style="padding:0">采集 / 写入 / 观测是三个动作；原始 UTC 见 title。</div>';

  const archive = overview.archive || {};
  const archiveLine = archive.archived === true
    ? '已归档（<strong>隐藏，不是删除</strong>）：' + asinText(archive.archivedAt) + ' · 理由 ' + asinText(archive.archiveReason)
      + ' · 操作人 ' + asinText(archive.archivedBy) + '。下面四页仍然读得出，血缘一个字节没动。'
    : (archive.everArchived === true
      ? '现在在架上，但<strong>曾经</strong>归档过：事件 ' + asinText(archive.eventCount) + ' 条，最近一条 '
        + asinText(archive.lastEvent === null || archive.lastEvent === undefined ? null : archive.lastEvent.action)
        + '（' + asinText(archive.lastEvent === null || archive.lastEvent === undefined ? null : archive.lastEvent.at) + '）'
      : '从来没有归档过（归档事件 0 条 —— 那是「没归档过」，不是「读不出来」）');

  const completeness = overview.completeness || {};
  /* 逐 key 印，不写死三个：服务端多给一个比例时页面自动画出来，少给一个时这里也不假装有。 */
  const ratios = Object.keys(completeness).map(key => asinRatio(completeness[key])).join('');

  const freshness = overview.freshness || {};
  /* ADR-001 D9：口径来自服务端（overview.freshness.denominator / ...ExcludingManual），
     与 Listing 全字段页同一个算法：剔除 category / product_line_id 这两个人工维护字段。
     旧载荷没有这些键时回退到 total/unknown，页面不自己再数一遍。 */
  const freshnessTotal = freshness.denominator === null || freshness.denominator === undefined
    ? freshness.total : freshness.denominator;
  const freshnessUnknown = freshness.unknownExcludingManual === null || freshness.unknownExcludingManual === undefined
    ? freshness.unknown : freshness.unknownExcludingManual;
  const freshnessNoThreshold = freshness.noThresholdExcludingManual === null || freshness.noThresholdExcludingManual === undefined
    ? freshness.noThreshold : freshness.noThresholdExcludingManual;
  const freshnessNoObservation = freshness.noObservationTimeExcludingManual === null || freshness.noObservationTimeExcludingManual === undefined
    ? freshness.noObservationTime : freshness.noObservationTimeExcludingManual;
  const manualFreshnessNames = Array.isArray(freshness.manualFields) && freshness.manualFields.length > 0
    ? freshness.manualFields.map(entry => asinText(entry.label) + ' ' + asinText(entry.field)).join(' / ')
    : '类目 category / 产品线 product_line_id';
  const freshBlock = '<div>新鲜 <strong>' + asinText(freshness.value) + '/' + asinText(freshnessTotal)
    + '</strong> · 过期 ' + asinText(freshness.stale) + '/' + asinText(freshnessTotal)
    + ' · 判不了 ' + asinText(freshnessUnknown) + '/' + asinText(freshnessTotal) + '</div>'
    + '<div class="hint" style="padding:0">「判不了」里有两件事，分开数：没有阈值（没人定过这个字段多久算旧）'
    + asinText(freshnessNoThreshold) + ' 个；有值但没记观测时间 ' + asinText(freshnessNoObservation) + ' 个。'
    + '阈值的唯一来源是服务端的 7/30/90 天表，页面不自己算一档。'
    + '人工维护字段，不参与新鲜度分母：' + manualFreshnessNames + '。</div>';

  const conflicts = Array.isArray(overview.conflicts) ? overview.conflicts : [];
  const conflictLines = conflicts.length === 0
    ? '<div class="hint" style="padding:0">一条字段冲突行都没有（这是「没有冲突」，不是「没读」）。</div>'
    : '<div>' + asinText(overview.openConflicts) + '/' + asinText(conflicts.length) + ' 条还没裁决</div>'
      + conflicts.map(item => '<div>' + asinText(item.field) + '：' + asinText(item.status)
        + ' · 采用值 ' + asinText(item.adoptedValue) + ' · ' + asinText(item.openedAt) + ' 开的</div>').join('');

  const counts = overview.counts || {};
  const countOrder = [
    ['listing', 'Listing 行'], ['keywords', '关键词排名事实'], ['snapshots', '采集快照'],
    ['optimizationRuns', '优化运行'], ['publications', '发布记录'],
  ];
  const countLines = countOrder.map(pair => {
    const value = counts[pair[0]];
    return '<div>' + escapeHtml(pair[1]) + '：' + (value === null || value === undefined
      ? '<span class="hint" style="padding:0">读不出来（这张表不存在或读失败）—— 与 0 不是一件事</span>'
      : asinText(value)) + '</div>';
  }).join('');

  const sources = Array.isArray(overview.sources) ? overview.sources : [];
  const sourceLines = sources.length === 0
    ? '<div class="hint" style="padding:0">一行来源行都没有：只有主记录、没有溯源。这不是「读不出来」。</div>'
    : sources.map(item => '<div>' + asinText(item.sourceId) + '：说过 ' + asinText(item.fieldCount)
      + ' 个字段 · 最近 ' + asinText(item.lastAt) + '</div>').join('');

  const totals = (overview.sections || {}).totals || {};
  const sectionCoverage = (overview.sections || {}).coverage || {};
  const variants = overview.variants || {};
  /* 截断时「采过 3/13」是**前缀上的**答案，所以这一行必须把上限说出来 —— 只说 3/13
     会让读者以为剩下的 10 节真的没人看过。 */
  const cross = '<div>13 节：采过 <strong>' + asinText(totals.attempted) + '/' + asinText(totals.total) + '</strong>'
    + (sectionCoverage.truncated === true ? '（' + asinText(sectionCoverage.note) + '）' : '') + '</div>'
    + '<div>变体：角色 ' + asinText(variants.role) + ' · 矛盾 ' + asinText(variants.problemCount)
    + ' 条 · 关系不完整 ' + asinText(variants.incompleteCount) + ' 条 · 父体级批量优化'
    + (variants.parentLevelOptimizationAllowed === true ? '允许' : '禁止（关系不完整、有矛盾，或没有任何变体关系）') + '</div>';

  const deferred = Array.isArray(overview.deferred) ? overview.deferred : [];

  /* 第一层的五个读数。tone 只在**需要人动手**时上色（冲突没裁决、有过期）：
     把 0/13 也染成警告，会让一条刚入库、还没采过的 ASIN 看起来像坏了。 */
  const asNumber = value => (value === null || value === undefined || value === '' ? null : Number(value));
  const isFull = ratio => {
    const total = asNumber(ratio.total);
    return total !== null && total > 0 && asNumber(ratio.value) === total;
  };
  const chipOf = (text, tone) => '<span class="chip' + (tone === '' ? '' : ' ' + tone) + '">' + text + '</span>';
  const ratioChip = (label, ratio) => chipOf(escapeHtml(label) + ' ' + asinText(ratio.value) + '/'
    + asinText(ratio.total), isFull(ratio) ? 'ok' : '');
  const fieldsRatio = completeness.fields || {};
  const sectionsRatio = completeness.sections || {};
  const variantsRatio = completeness.variants || {};
  const openConflicts = asNumber(overview.openConflicts);
  const staleCount = asNumber(freshness.stale);
  const chips = '<div class="asin-chips">'
    + ratioChip('字段', fieldsRatio)
    + ratioChip('13 节', sectionsRatio)
    + ratioChip('变体', variantsRatio)
    + chipOf('冲突 ' + asinText(overview.openConflicts) + '/' + asinText(conflicts.length),
      openConflicts !== null && openConflicts > 0 ? 'warn' : '')
    + chipOf('过期 ' + asinText(freshness.stale) + '/' + asinText(freshnessTotal),
      staleCount !== null && staleCount > 0 ? 'warn' : '')
    + '</div>';

  /* 需要动手的事单独一行，只在条件成立时说话 —— 一条刚入库的 ASIN 与一条缺了一半的
     ASIN 在这一行上必须是两句不同的话。 */
  const actions = [];
  const sectionTotal = asNumber(sectionsRatio.total);
  const sectionValue = asNumber(sectionsRatio.value);
  if (sectionTotal !== null && sectionTotal > 0 && sectionValue === 0) {
    actions.push('13 节一节都还没采到 —— 「没采过」与「采了没抓到」不是一件事；要补，到「采集」面板对它发起一次。');
  }
  if (openConflicts !== null && openConflicts > 0) {
    actions.push('有 ' + openConflicts + ' 条字段冲突还没裁决：采用值可能不是你以为的那一个，展开「多源冲突」看是哪几个字段。');
  }
  const actionLine = actions.length === 0 ? ''
    : '<div class="asin-note">' + actions.map(text => '→ ' + escapeHtml(text)).join('<br>') + '</div>';

  const fold = (summary, body) => '<details class="asin-fold"><summary>' + summary + '</summary>'
    + '<div class="asin-fold-body">' + body + '</div></details>';
  const archiveSummary = archive.archived === true
    ? '已归档（只读）'
    : (archive.everArchived === true ? '在架上，曾经归档过' : '在架上，从没归档过');

  return chips + factGrid + timeNote + actionLine
    + fold('完整率与 13 节 —— 字段 ' + asinText(fieldsRatio.value) + '/' + asinText(fieldsRatio.total)
      + ' · 13 节 ' + asinText(sectionsRatio.value) + '/' + asinText(sectionsRatio.total)
      + ' · 变体 ' + asinText(variantsRatio.value) + '/' + asinText(variantsRatio.total),
      (ratios === '' ? asinLack('完整率') : ratios) + '<h3>另外三页的同一个数字</h3>' + cross)
    + fold('新鲜度 —— 新鲜 ' + asinText(freshness.value) + '/' + asinText(freshnessTotal)
      + ' · 过期 ' + asinText(freshness.stale) + '/' + asinText(freshnessTotal)
      + ' · 判不了 ' + asinText(freshnessUnknown) + '/' + asinText(freshnessTotal), freshBlock)
    + fold('多源冲突 —— ' + (conflicts.length === 0
      ? '0 条'
      : asinText(overview.openConflicts) + '/' + asinText(conflicts.length) + ' 条没裁决'), conflictLines)
    + fold('下游计数与来源 —— 关键词 ' + asinText(counts.keywords) + ' · 快照 ' + asinText(counts.snapshots)
      + ' · 来源 ' + asinText(sources.length) + ' 个', countLines + '<h3>来源</h3>' + sourceLines)
    + fold('归档 —— ' + escapeHtml(archiveSummary), '<div class="asin-note">' + archiveLine + '</div>')
    + (deferred.length === 0 ? '' : fold('本批未计入 ' + asinText(deferred.length)
      + ' 项（属于别的功能点，不是「都健康」）', deferred.map(item => '<div class="asin-lack">'
        + asinText(item.label) + '（' + asinText(item.feature) + '）：' + asinText(item.note) + '</div>').join('')));
}

/* ── T71 GEO 可引用性（FR-M4-15）─────────────────────────────────────────────

   四组事实卡：属性完整度 / Q&A 覆盖 / 对比维度可比性 / 事实一致性。
   页面只印载荷，不算任何判据；**不画总分、不画合计、不画评级**（PRD 铁律 4）。
   无来源组不画 0/0；组④只画 pending 槽「判据：待定（O-02）」。

   NB: 这段在页面脚本的模板字符串里，注释里不许出现反引号。 */

function asinGeoClip(value, max) {
  const text = String(value === null || value === undefined ? '' : value);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function asinGeoStateChip(group) {
  if (group === null || group === undefined) return '<span class="chip warn">没有这一组</span>';
  if (group.state === 'pending') return '<span class="chip">判据：待定（O-02）</span>';
  if (group.state === 'no-source') return '<span class="chip">' + asinText(group.conclusion || '本仓没有来源') + '</span>';
  if (group.state === 'error') return '<span class="chip warn">取不到判据</span>';
  if (group.state === 'empty') return '<span class="chip">从没记过</span>';
  return '<span class="chip ok">有读数</span>';
}

function asinGeoRatio(group) {
  if (group === null || group === undefined) return null;
  if (group.numerator === null || group.numerator === undefined
    || group.denominator === null || group.denominator === undefined) return null;
  return asinText(group.numerator) + '/' + asinText(group.denominator);
}

function asinGeoTime(value) {
  if (value === null || value === undefined || String(value).trim() === '') return '本处未记';
  return asinText(asinWhen(value));
}

function asinGeoSourceLine(group) {
  return '<div class="hint" style="padding:0" data-t71-geo-cell="source">来源：'
    + asinText(group === null || group === undefined ? '' : group.source) + '</div>'
    + '<div class="hint" style="padding:0" data-t71-geo-cell="observed-at">时间：'
    + asinGeoTime(group === null || group === undefined ? null : group.observedAt) + '</div>';
}

function asinGeoMissingGroup(id, label) {
  return '<div class="asin-lack" data-t71-geo-group="' + escapeHtml(String(id)) + '" data-t71-geo-state="missing">'
    + '服务端没有给「' + escapeHtml(String(label)) + '」这一组 —— 不是「这一组是 0」。</div>';
}

function asinGeoAttributeCard(group) {
  if (group === null || group === undefined) return asinGeoMissingGroup('attribute', '属性完整度');
  const ratio = asinGeoRatio(group);
  const missing = Array.isArray(group.missing) ? group.missing : [];
  const missingBlock = missing.length === 0 ? ''
    : '<details class="asin-fold"><summary>缺 ' + asinText(missing.length) + ' 项（展开看键名）</summary>'
      + '<div class="hint" style="padding:0" data-t71-geo-cell="missing-keys">' + asinText(missing.join('、')) + '</div></details>';
  const core = group.coreFields !== null && group.coreFields !== undefined
    ? group.coreFields
    : (Array.isArray(group.breakdown) ? group.breakdown.find(entry => entry.id === 'core-fields') : null);
  const coreLine = core === null || core === undefined ? ''
    : '<div data-t71-geo-cell="core-fields"><strong>核心字段完整率 ' + asinText(core.numerator) + '/'
      + asinText(core.denominator) + '</strong>'
      + (Array.isArray(core.missing) && core.missing.length > 0
        ? '（缺 ' + asinText(core.missing.join('、')) + '）' : '')
      + '</div>';
  const errorLine = group.state === 'error' && group.conclusion
    ? '<div class="asin-note err">' + asinText(group.conclusion) + '</div>' : '';
  return '<div class="asin-sub asin-geo-card" data-t71-geo-group="attribute" data-t71-geo-state="'
    + escapeHtml(String(group.state)) + '">'
    + '<div><strong>属性完整度</strong> ' + asinGeoStateChip(group) + '</div>'
    + (ratio === null ? '' : '<div data-t71-geo-cell="ratio"><strong>' + ratio + '</strong> '
      + asinText(group.unit || '项') + '</div>')
    + errorLine + missingBlock + coreLine
    + asinGeoSourceLine(group)
    + '</div>';
}

function asinGeoQaCard(group) {
  if (group === null || group === undefined) return asinGeoMissingGroup('qa', 'Q&A 覆盖');
  const anchors = Array.isArray(group.anchors) ? group.anchors : [];
  return '<div class="asin-sub asin-geo-card" data-t71-geo-group="qa" data-t71-geo-state="'
    + escapeHtml(String(group.state)) + '">'
    + '<div><strong>Q&amp;A 覆盖</strong> ' + asinGeoStateChip(group) + '</div>'
    + '<div data-t71-geo-cell="no-source">' + asinText(group.conclusion) + '</div>'
    + '<div class="hint" style="padding:0">理由：' + asinText(group.reason) + '</div>'
    + anchors.map(anchor => '<div class="hint" style="padding:0" data-t71-geo-anchor="'
      + escapeHtml(String(anchor.symbol)) + '">锚点：' + asinText(anchor.file) + '#'
      + asinText(anchor.symbol) + ' —— ' + asinText(anchor.fact) + '</div>').join('')
    + asinGeoSourceLine(group)
    + '</div>';
}

function asinGeoComparabilityCard(group) {
  if (group === null || group === undefined) return asinGeoMissingGroup('comparability', '对比维度可比性');
  const ratio = asinGeoRatio(group);
  const counts = group.counts || {};
  const countLine = (group.state === 'ok' || group.state === 'empty')
    ? '<div class="hint" style="padding:0" data-t71-geo-cell="counts">值相同 ' + asinText(counts.same)
      + ' / 值不同 ' + asinText(counts.different) + ' / 无值 ' + asinText(counts.noValue)
      + ' / 单位不一致 ' + asinText(counts.unitMismatch)
      + ' / 测量期不一致 ' + asinText(counts.periodMismatch)
      + ' / 测量期未记 ' + asinText(counts.periodUnknown) + '</div>'
    : '';
  const dims = Array.isArray(group.dimensions) ? group.dimensions : [];
  const rows = dims.map(entry => {
    const ours = entry.ours || {};
    const competitors = Array.isArray(entry.competitors) ? entry.competitors : [];
    const competitorText = competitors.map(cell => (cell.asin || '—') + '='
      + (cell.present ? cell.value : (cell.absence === 'never-written' ? '本处未记' : '无值'))).join('；');
    const ourText = ours.present ? ours.value : (ours.absence === 'never-written' ? '本处未记' : '无值');
    const reasonText = (entry.reasonCode ? '[' + entry.reasonCode + '] ' : '') + (entry.reason || '—');
    return '<tr data-t71-geo-dim="' + escapeHtml(String(entry.key)) + '" data-t71-geo-status="'
      + escapeHtml(String(entry.status)) + '" data-t71-geo-reason-code="'
      + escapeHtml(String(entry.reasonCode || '')) + '">'
      + '<td title="' + escapeHtml(String(entry.label)) + '">' + asinText(entry.label) + '</td>'
      + '<td title="' + escapeHtml(String(ourText)) + '">' + asinText(ourText) + '</td>'
      + '<td title="' + escapeHtml(competitorText) + '">' + asinText(asinGeoClip(competitorText, 28)) + '</td>'
      + '<td>' + asinText(entry.statusLabel) + '</td>'
      + '<td title="' + escapeHtml(reasonText) + '">'
      + asinText(asinGeoClip(reasonText, 30)) + '</td></tr>';
  }).join('');
  const table = dims.length === 0 ? ''
    : '<details class="asin-fold"><summary>逐维度（' + asinText(dims.length) + '）</summary>'
      + '<div style="overflow-x:auto"><table class="asin-src" style="table-layout:fixed;width:100%;min-width:640px">'
      + '<thead><tr><th style="width:16%">维度</th><th style="width:24%">我方</th><th style="width:28%">竞品</th>'
      + '<th style="width:12%">状态</th><th style="width:20%">原因</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div></details>';
  const noSourceLine = group.state === 'no-source'
    ? '<div class="hint" style="padding:0">' + asinText(group.conclusion) + '：' + asinText(group.reason) + '</div>'
    : '';
  return '<div class="asin-sub asin-geo-card" data-t71-geo-group="comparability" data-t71-geo-state="'
    + escapeHtml(String(group.state)) + '">'
    + '<div><strong>对比维度可比性</strong> ' + asinGeoStateChip(group) + '</div>'
    + (ratio === null ? '' : '<div data-t71-geo-cell="ratio"><strong>' + ratio + '</strong> '
      + asinText(group.unit || '个维度可比') + '</div>')
    + (group.state === 'ok' && group.conclusion ? '<div>' + asinText(group.conclusion) + '</div>' : '')
    + countLine + noSourceLine + table
    + asinGeoSourceLine(group)
    + '</div>';
}

function asinGeoConsistencyCard(group) {
  if (group === null || group === undefined) return asinGeoMissingGroup('consistency', '事实一致性');
  /* 过渡态：这一路没有拿到文案（buildGeoFacts 的旧调用方不传 copy）。
     判据本身已按 O-02 A 案实现在服务端，详情页走 readGeoFacts 会出 A/B 两组计数。 */
  if (group.state === 'pending') {
    return '<div class="asin-sub asin-geo-card" data-t71-geo-group="consistency" data-t71-geo-state="pending">'
      + '<div><strong>事实一致性</strong> ' + asinGeoStateChip(group) + '</div>'
      + '<div data-t71-geo-cell="pending">判据待 O-02 拍板</div>'
      + '<div class="hint" style="padding:0">这一路没有拿到 listing 文案：本组没有可比的声明，不画 0/0。'
      + '判据已按 O-02 A 案落地（A 组数值一致 + B 组声明有据两组独立计数），详情页读取时会出两组计数。</div>'
      + asinGeoSourceLine(group)
      + '</div>';
  }
  const a = group.consistencyA === null || group.consistencyA === undefined ? null : group.consistencyA;
  const b = group.consistencyB === null || group.consistencyB === undefined ? null : group.consistencyB;
  const ratio = asinGeoRatio(group);
  const ratioLine = ratio === null ? ''
    : '<div data-t71-geo-cell="ratio"><strong>' + ratio + '</strong> '
      + asinText(group.unit || '条可比事实') + '</div>';
  const aLine = a === null || group.state !== 'ok' ? ''
    : '<div class="hint" style="padding:0" data-t71-geo-cell="a-counts">A 组（数值一致）：可比事实 '
      + asinText(a.factCount) + ' 条 = 一致 ' + asinText(a.consistent) + ' / 冲突 ' + asinText(a.conflicted)
      + ' / 无法判定 ' + asinText(a.undecidable) + '（单源 ' + asinText(a.undecidableCodes.singleSource)
      + ' / 单位不一致 ' + asinText(a.undecidableCodes.unitMismatch)
      + ' / 解析歧义 ' + asinText(a.undecidableCodes.parseAmbiguous) + '）</div>';
  const bLine = b === null || b.declarationCount === null || b.declarationCount === undefined ? ''
    : '<div class="hint" style="padding:0" data-t71-geo-cell="b-counts">B 组（声明有据）：数值声明 '
      + asinText(b.declarationCount) + ' 条 = 可指 ' + asinText(b.pointable) + ' / 不可指 '
      + asinText(b.unpointable) + ' / 无法判定 ' + asinText(b.undecidable)
      + ' —— 可指不等于一致，值对不对看 A 组</div>';
  const uncoveredLine = group.uncoveredCount === null || group.uncoveredCount === undefined ? ''
    : '<div class="hint" style="padding:0" data-t71-geo-cell="uncovered">v1 未覆盖 '
      + asinText(group.uncoveredCount) + ' 条（不入任何分母）</div>';
  const stateLine = (group.state === 'error' || group.state === 'empty')
    ? '<div class="' + (group.state === 'error' ? 'asin-note err' : 'hint') + '"'
      + (group.state === 'error' ? '' : ' style="padding:0"') + '>' + asinText(group.conclusion)
      + '：' + asinText(group.reason) + '</div>'
    : '';
  const evidence = Array.isArray(group.evidence) ? group.evidence : [];
  const evidenceBlock = evidence.length === 0 ? ''
    : '<details class="asin-fold"><summary>证据 ' + asinText(evidence.length) + ' 条（展开看两处原文）</summary>'
      + evidence.map(entry => '<div class="hint" style="padding:0" data-t71-geo-evidence="'
        + escapeHtml(String(entry.evidenceType)) + '">' + asinText(entry.text) + '</div>').join('')
      + '</details>';
  const writtenLine = group.writtenAt === null || group.writtenAt === undefined
    ? '<div class="hint" style="padding:0" data-t71-geo-cell="written-at">文案写入时间：本处未记</div>'
    : '<div class="hint" style="padding:0" data-t71-geo-cell="written-at">文案写入时间：'
      + asinText(asinWhen(group.writtenAt)) + '（写入时间，不是观测时间）</div>';
  const noteLine = group.note === null || group.note === undefined ? ''
    : '<div class="hint" style="padding:0">' + asinText(group.note) + '</div>';
  return '<div class="asin-sub asin-geo-card" data-t71-geo-group="consistency" data-t71-geo-state="'
    + escapeHtml(String(group.state)) + '">'
    + '<div><strong>事实一致性</strong> ' + asinGeoStateChip(group) + '</div>'
    + ratioLine + aLine + bLine + uncoveredLine + stateLine + evidenceBlock + writtenLine + noteLine
    + asinGeoSourceLine(group)
    + '</div>';
}

/** GEO 区块：没跑过 / 读失败 / 四组。页面只做分派与转义。 */
function asinGeoBlock(data) {
  const geo = data === null || data === undefined ? null : data.geo;
  if (geo === undefined || geo === null) {
    return '<div class="asin-lack" data-t71-geo="missing">GEO 事实还没跑过：'
      + '不是「四组都是 0」，是这一块还没有读数。</div>';
  }
  if (geo.ok !== true) {
    return '<div class="asin-problem" data-t71-geo="error">GEO 事实没算出来：'
      + asinText(geo.error) + ' —— 不是「四组都是 0」；重试仍失败就查读路径。</div>';
  }
  const groups = Array.isArray(geo.groups) ? geo.groups : [];
  const byId = {};
  for (const group of groups) {
    if (group !== null && group !== undefined && group.id) byId[group.id] = group;
  }
  return '<div data-t71-geo="ready"><h3>GEO 可引用性（四组事实）</h3>'
    + '<div class="asin-note">四组各算各的分子/分母；页面没有合计行 —— 这不是省略，是禁止。</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:8px" data-t71-geo-grid="1">'
    + asinGeoAttributeCard(byId.attribute)
    + asinGeoQaCard(byId.qa)
    + asinGeoComparabilityCard(byId.comparability)
    + asinGeoConsistencyCard(byId.consistency)
    + '</div></div>';
}

/** Listing 全字段页：逐字段的七项（采用值 / 全部来源 / 观测时间 / 新鲜度 / 人工确认 / 上快照差异 / 下游）。 */
function asinFieldsBody(data) {
  const facts = data.fields === null || data.fields === undefined ? null : data.fields;
  if (facts === null) return asinLack('Listing 全字段');
  const summary = facts.summary || {};
  const snapshots = facts.snapshots || {};
  const entries = Array.isArray(facts.fields) ? facts.fields : [];
  const current = snapshots.current === null || snapshots.current === undefined
    ? '没有（一份都还没有）'
    : '#' + asinText(snapshots.current.id) + '（' + asinText(snapshots.current.collectedAt) + '）';
  const previous = snapshots.previous === null || snapshots.previous === undefined
    ? '没有' : '#' + asinText(snapshots.previous.id);
  /* ADR-001 D9：类目 / 产品线是人工维护字段，本仓故意没有给它们定新鲜度阈值。
     它们不参与新鲜度分母，但必须点名 —— 否则「判不了」会被读成「这批数据坏了」。 */
  const manualFreshnessFields = ['category', 'product_line_id'];
  const manualFields = entries.filter(entry => manualFreshnessFields.includes(entry.field));
  const manualCount = manualFields.length;
  const freshnessDenominator = Math.max(0, Number(summary.total || 0) - manualCount);
  const judgedUnknown = entries.filter(entry => entry.freshness === 'unknown'
    && !manualFreshnessFields.includes(entry.field)).length;
  const judgedNoThreshold = entries.filter(entry => entry.freshnessReason === 'no-threshold'
    && !manualFreshnessFields.includes(entry.field)).length;
  const judgedNoObservation = entries.filter(entry => entry.freshnessReason === 'no-observation-time'
    && !manualFreshnessFields.includes(entry.field)).length;
  const manualLine = manualCount === 0 ? ''
    : '（人工维护字段，不参与新鲜度分母：'
      + manualFields.map(entry => asinText(entry.label) + ' ' + asinText(entry.field)).join(' / ') + '）';
  const head = '<h3>Listing 全字段（' + asinText(summary.withValue) + '/' + asinText(summary.total)
    + ' 有值 · 缺 ' + asinText(summary.missing) + '）</h3>'
    + '<div class="hint" style="padding:0">新鲜 ' + asinText(summary.fresh) + '/' + asinText(freshnessDenominator)
    + ' · 过期 ' + asinText(summary.stale) + '/' + asinText(freshnessDenominator)
    + ' · 判不了 ' + asinText(judgedUnknown) + '/' + asinText(freshnessDenominator)
    + '（判不了里：无阈值 ' + asinText(judgedNoThreshold) + ' 个 / 有值但没记观测时间 ' + asinText(judgedNoObservation) + ' 个）'
    + manualLine
    + ' · 人工确认 ' + asinText(summary.manualConfirmed) + ' · 有来源 ' + asinText(summary.withAnySource)
    + ' · 从来没有采过 ' + asinText(summary.neverCollected) + ' · 页面没有此字段 ' + asinText(summary.notOnPage)
    + ' · 没有任何下游引用 ' + asinText(summary.withoutDownstream) + '</div>'
    + '<div class="hint" style="padding:0">快照：当前 ' + current + ' · 上一份 ' + previous
    + (snapshots.note === null || snapshots.note === undefined ? '' : ' · ' + asinText(snapshots.note)) + '</div>';
  return asinGeoBlock(data) + head + entries.map(entry => asinFieldBlock(entry)).join('');
}

/** 一个字段的全部说法。七项都在，一项都不省：这张表存在的理由就是回答「这个值凭什么」。 */
function asinFieldBlock(entry) {
  const chipClass = entry.lineageState === 'present' ? 'present' : 'absent';
  const bits = [];
  bits.push('采用值 ' + asinText(entry.adoptedValue)
    + ' · 来自 ' + asinText(entry.adoptedSourceId)
    + (entry.adoptedSourceType === null || entry.adoptedSourceType === undefined
      ? '' : '（' + asinText(entry.adoptedSourceType) + '）'));
  bits.push('新鲜度 ' + asinText(entry.freshness)
    + (entry.freshnessDays === null || entry.freshnessDays === undefined
      ? '（没有阈值：没人定过这个字段多久算旧）'
      : '（阈值 ' + asinText(entry.freshnessDays) + ' 天）')
    + ' · 观测于 ' + (entry.observedAt === null || entry.observedAt === undefined
      ? asinText(entry.observedAt)
      : '<span title="' + escapeHtml(String(entry.observedAt)) + '">' + asinText(asinWhen(entry.observedAt)) + '</span>')
    + (entry.ageDays === null || entry.ageDays === undefined ? '' : '（' + asinText(entry.ageDays) + ' 天前）'));
  if (entry.field === 'category' || entry.field === 'product_line_id') {
    bits.push('人工维护字段，不参与新鲜度分母');
  }
  if (entry.freshnessReason === 'no-observation-time') {
    bits.push('这里的「未知」不是「旧」：有人记过这个值，但没记它什么时候是真的。');
  }
  bits.push(entry.manualConfirmed === true
    ? '当前是人工值（人工来源 ' + asinText(entry.manualSourceId) + '，写于 ' + asinText(entry.manualAt) + '）'
    : (entry.hasManualSource === true
      ? '有人工来源行，但当前采用值不是它'
      : '没有人工来源行'));
  bits.push(entry.original === null || entry.original === undefined
    ? '被压在下面的原始读数：没有（这个字段没有采集/导入来源）'
    : '原始读数 ' + asinText(entry.original.value) + '（' + asinText(entry.original.sourceType) + '；'
      + (entry.original.unchanged === true ? '与采用值相同' : '已经被人工值压住，但仍然读得到') + '）');
  const diff = entry.diff === null || entry.diff === undefined ? null : entry.diff;
  if (diff === null) {
    bits.push('与上一快照的差异：服务端没有给这一块');
  } else if (diff.changed === true) {
    bits.push('与上一快照 #' + asinText(diff.previousSnapshotId) + ' 比：'
      + asinText(diff.before) + ' → ' + asinText(diff.after));
  } else {
    bits.push('与上一快照的差异：'
      + asinText(diff.reason === null || diff.reason === undefined ? '没有变化' : diff.reason));
  }

  const sources = Array.isArray(entry.sources) ? entry.sources : [];
  const sourceLines = sources.length === 0
    ? '<div class="hint" style="padding:0">一行来源行都没有 —— 这个字段没有任何来源说过话。</div>'
    : '<div class="asin-src">' + sources.map(source => asinText(source.sourceId)
      + (source.isManual === true ? '（人工来源）' : '')
      + '：' + asinText(source.value)
      + ' · 观测 ' + asinText(source.observedAt)
      + (source.qualityState === null || source.qualityState === undefined ? '' : ' · quality=' + asinText(source.qualityState))
      + (source.matchesAdopted === true ? ' · 与采用值相同' : ' · 与采用值不同')).join('<br>') + '</div>';

  const downstream = Array.isArray(entry.downstream) ? entry.downstream : [];
  const downLines = downstream.length === 0
    ? '<div class="hint" style="padding:0">没有任何下游在读这个字段 —— 空清单是一个有内容的答案，不是「没查」。</div>'
    : '<div>' + downstream.map(item => asinText(item.kind) + '：' + asinText(item.label)
      + (item.undecided === true ? '（还没裁决）' : '')).join('<br>') + '</div>';

  const conflict = entry.conflict === null || entry.conflict === undefined ? null : entry.conflict;
  const conflictLine = conflict === null
    ? '冲突行：没有'
    : '冲突行 ' + asinText(conflict.status) + '（' + asinText(conflict.openedAt) + ' 开，采用值 '
      + asinText(conflict.adoptedValue) + '）';

  return '<div class="asin-sub" data-asin-field="' + escapeHtml(entry.field) + '">'
    + '<div><strong>' + asinText(entry.label) + '</strong> <code>' + escapeHtml(entry.field) + '</code> '
    + '<span class="chip ' + chipClass + '">' + asinText(asinLabeled(LINEAGE_STATE_LABELS, entry.lineageState)) + '</span></div>'
    + bits.map(line => '<div>' + line + '</div>').join('')
    + sourceLines + downLines
    + '<div>' + conflictLine + '</div>'
    + '</div>';
}

/** 13 节页。节名与顺序来自服务端载荷（B-04 的 COLLECTION_SECTIONS），五态名与芯片来自
 *  注入的 SECTION_STATUS（collectSummaryText 与 sectionChip 用的就是它）—— 页面里没有
 *  第二份节词表，也没有第二份五态名。 */
function asinSectionsBody(data) {
  const view = data.sections === null || data.sections === undefined ? null : data.sections;
  if (view === null) return asinLack('13 节');
  const entries = Array.isArray(view.sections) ? view.sections : [];
  const totals = view.totals || {};
  const coverage = view.coverage || {};
  const unattempted = entries.filter(entry => entry.notCollected === true).length;
  const vocabulary = view.vocabulary || {};
  /* 读被 5000 行上限截断时，这张表里「未采集」的那些行有两个原因，而它们的动作相反：
     库里真的一行都没有，或者这一行在上限之外没被读出来。后者不许印成「未采集」——
     那是把「没读到」读成「没人采过」，据此去补采就是照着一个错的结论干活。 */
  const truncated = coverage.truncated === true;
  const head = '<h3>数据现状（13 节）（采过 ' + asinText(totals.attempted) + '/' + asinText(totals.total)
    + ' · 未采集 ' + asinText(unattempted) + ' 节）</h3>'
    + dualCopyBlock('asin')
    + '<div class="hint" style="padding:0">「未采集」不是「亚马逊没有」：五态是闭集，里面没有「我们根本没看过这一节」，'
    + '所以没有行的节在这里单说一句，而不是给它安一个 missing。五态计数以 <strong>节</strong> 为单位：'
    + '同一节在多个任务里各有一行时取最新那一行（「共 N 行节结果」单列，行数与节数不是一回事）——'
    + collectSummaryText(view.summary || {}) + ' · 共 ' + asinText(totals.rows) + ' 行节结果、'
    + asinText(totals.tasks) + ' 个任务。</div>'
    + (truncated === true
      ? '<div class="asin-problem"><strong>读被截断</strong>：' + asinText(coverage.note)
        + ' —— 下面标「' + SECTION_READ_TRUNCATED + '」的节就是这一种。</div>'
      : '');
  const rows = entries.map(entry => {
    /* 「看见了、却没读出来」与「页面只给了一部分」在五态里是同一个 partial（真机：
       variations 的 1/3 与 2/3 都印 partial）。五态不动 —— 动的是呈现：载荷上那个
       contentUnread（服务端从行上已有的 errors_json / child_tiles 算出来的一份判据）
       为真时，芯片旁多一枚标记，把「子体没读到」从「页面确实没有」里分开。 */
    const unreadMark = sectionContentUnreadMark(entry);
    const chip = entry.notCollected === true
      ? (entry.readTruncated === true
        ? '<span class="chip" style="color:var(--warn)">' + SECTION_READ_TRUNCATED + '</span>'
        : '<span class="chip">未采集</span>')
      : sectionChip(entry.status) + unreadMark;
    const counts = entry.notCollected === true
      ? (entry.readTruncated === true ? '不知道（读被截断，这一节的行没被读出来）'
        : '一个字段都没看过（声明清单 ' + asinText(entry.total) + ' 个）')
      : (entry.total === 0
        ? '无字段可计（这次的读数里一个键都没有）'
        : asinText(entry.collected) + '/' + asinText(entry.total));
    const meta = [];
    if (entry.collectedAt !== null && entry.collectedAt !== undefined) meta.push('采集于 ' + collectStamp(entry.collectedAt));
    if (entry.taskId !== null && entry.taskId !== undefined) {
      meta.push('任务 ' + escapeHtml(String(entry.taskId).slice(0, 8))
        + '（这一节一共出现在 ' + asinText(entry.taskCount) + ' 个任务里）');
    }
    if (entry.schemeVersion !== null && entry.schemeVersion !== undefined) meta.push('方案 v' + asinText(entry.schemeVersion));
    if (entry.snapshotRef !== null && entry.snapshotRef !== undefined) meta.push('快照 #' + asinText(entry.snapshotRef));
    if (entry.dynamic === true) meta.push('动态节（属性键由这一次读数决定）');
    const missing = Array.isArray(entry.missingFields) && entry.missingFields.length > 0
      ? '缺 ' + entry.missingFields.slice(0, 8).join(' ') : '';
    const errors = Array.isArray(entry.errors) && entry.errors.length > 0
      ? '错误：' + entry.errors.join(' / ') : '';
    const diff = entry.diff === null || entry.diff === undefined ? '' : collectDiffText(entry.diff);
    return '<div class="asin-sub" data-asin-section="' + escapeHtml(entry.section) + '">'
      + '<div><span class="ord">' + asinText(entry.order) + '</span> <strong>' + asinText(entry.label)
      + '</strong> <code>' + escapeHtml(entry.section) + '</code> ' + chip + ' ' + counts + '</div>'
      + (meta.length === 0 ? '' : '<div class="hint" style="padding:0">' + escapeHtml(meta.join(' · ')) + '</div>')
      + (missing === '' ? '' : '<div>' + escapeHtml(missing) + '</div>')
      + (errors === '' ? '' : '<div style="color:var(--warn)">' + escapeHtml(errors) + '</div>')
      + (diff === '' ? '' : '<div class="collect-diff">' + diff + '</div>')
      + '</div>';
  }).join('');
  const ids = Array.isArray(vocabulary.sectionIds) ? vocabulary.sectionIds : [];
  const receipt = ids.length === 0 ? '' : '<div class="hint" style="padding:0">上面每一行的节名与顺序都来自服务端'
    + '（B-04 的 COLLECTION_SECTIONS），页面里没有第二份节词表。这一页收到的节 id：'
    + escapeHtml(ids.join(' / ')) + '</div>';
  return head + rows + receipt;
}

/** 变体关系页里的一个子体：一行 .asin-row（点开看它的详情）+ 维度值 + 来源。 */
function asinVariantChildBlock(child, marketplace) {
  const dimensions = Array.isArray(child.dimensions) ? child.dimensions : [];
  const values = dimensions.length === 0
    ? '<div class="hint" style="padding:0">一个维度值都没有 —— 这不等于重复，只是还没采到维度。</div>'
    : '<div>' + dimensions.map(entry => asinText(entry.dimension) + '=' + escapeHtml((Array.isArray(entry.values) ? entry.values : []).join('/'))
      + (entry.contradicted === true ? ' <strong>（这个维度上来源不一致）</strong>' : '')).join(' · ') + '</div>';
  return '<div class="asin-sub" data-asin-child="' + escapeHtml(child.asin) + '">'
    + asinJumpRow(child.asin, marketplace, child.hasDimensions === true ? null : '（一个维度值都没有）')
    + values
    + '<div class="hint" style="padding:0">来源 ' + asinText(child.sourceId)
    + (child.evidence === null || child.evidence === undefined || child.evidence === ''
      ? '' : ' · 证据 ' + asinText(child.evidence))
    + (child.relationId === null || child.relationId === undefined ? '' : ' · 边 ' + asinText(child.relationId))
    + '</div></div>';
}

/** 变体事件历史（F05-06 的追溯面）——「谁在什么时候改了什么关系」。
 *
 *  **单独一块**，不并进上面的问题清单：一条 corrected 事件说的是「这条边被纠正过了」，
 *  而 problems 里的每一条都是「还没处理」。合成一块，处理完的边会永远挂着一个待办，
 *  人很快就会学会无视这一页。
 *
 *  三种状态分开画，这是本仓「没测到 ≠ 没有」的同一条纪律：**读不出来** /
 *  有关系但**一条事件都没有** / **根本没有关系**。第一种最危险 —— 把「没读到」
 *  画成「没人改过」，读者会据此认定这条边从来没人动过，而它可能被人改过十次。 */
function asinVariantEventsBlock(events) {
  if (events === null || events === undefined) return asinLack('变体事件');
  if (events.error !== null && events.error !== undefined) {
    /* data-asin-events-error 不是装饰：这一块读失败与「检测到的问题」都用 .asin-problem
       画，没有这个属性的话，「事件读不出来」与「有一条矛盾」在页面上是同一个东西。 */
    return '<h3>变体事件历史</h3><div class="asin-problem" data-asin-events-error="1"><strong>读不出来</strong>：'
      + asinText(events.error) + '<br>这一块读失败，但「读不出来」与「一条事件都没有」不是一件事：'
      + '前者是没人读到，后者是读到了、那条边确实没有事件。</div>';
  }
  const groups = Array.isArray(events.groups) ? events.groups : [];
  const head = '<h3>变体事件历史（' + asinText(events.relationCount) + ' 条边 · 共 ' + asinText(events.total)
    + ' 条事件；每条边最多印最近 ' + asinText(events.limit) + ' 条）</h3>'
    + (events.note === null || events.note === undefined ? '' : '<div class="asin-note">' + asinText(events.note) + '</div>')
    + '<div class="hint" style="padding:0">事件是历史，不参与上面的矛盾检测：一条 corrected 事件说的是'
    + '「这条边被纠正过」，不是「现在有矛盾」。</div>';
  const body = groups.map(group => {
    const rows = (Array.isArray(group.events) ? group.events : []).map(event => '<div>'
      + asinText(event.at) + ' · <strong>' + asinText(event.action) + '</strong>'
      + ' · by ' + asinText(event.by)
      + ' · 理由 ' + asinText(event.reason)
      + ' · 证据 ' + asinText(event.evidence) + '</div>').join('');
    return '<div class="asin-sub" data-asin-relation-events="' + escapeHtml(group.relationId) + '">'
      + '<div>' + asinText(group.parentAsin) + ' → ' + asinText(group.childAsin)
      + '（' + asinText(group.status) + '，' + asinText(group.count) + ' 条事件'
      + (group.truncated === true ? '，下面只列最近 ' + asinText(group.events.length) + ' 条' : '') + '）</div>'
      + (rows === '' ? '<div class="hint" style="padding:0">这条边一条事件都没有 —— 它不是通过 store 的写入口建的。</div>' : rows)
      + '</div>';
  }).join('');
  return head + body;
}

/** 变体关系页。矛盾的**原样**说出来（哪两条、矛盾在哪），不画一个红点了事 —— 一个红点只说明
 *  「有事」，而这一页的读者要的是「哪一条错了」。 */
function asinVariantsBody(data) {
  const view = data.variants === null || data.variants === undefined ? null : data.variants;
  if (view === null) return asinLack('变体关系');
  const counts = view.counts || {};
  const parents = Array.isArray(view.parents) ? view.parents : [];
  const children = Array.isArray(view.children) ? view.children : [];
  const problems = Array.isArray(view.problems) ? view.problems : [];
  const incomplete = Array.isArray(view.incomplete) ? view.incomplete : [];
  const corrected = Array.isArray(view.corrected) ? view.corrected : [];

  const head = '<h3>变体关系（角色 ' + asinText(view.role) + '）</h3>'
    + (view.note === null || view.note === undefined ? '' : '<div class="asin-note">' + asinText(view.note) + '</div>')
    /* 两个数各自带着自己的标签：counts.children 数的是**不同的子体 ASIN**，
       counts.familyRelations 数的是**关系条数**。一个子体挂两个父体时它们是 1 与 2，
       而矛盾已经由下面那段 parent-contradiction 单独报出 —— 计数不必替它再说一遍大话。
       （这一段在注入脚本的模板字符串里：不许出现反引号，那会提前结束整段脚本。） */
    + '<div class="hint" style="padding:0">有效关系 ' + asinText(counts.activeRelations) + '（这个 ASIN 的两侧）· 同族关系 '
    + asinText(counts.familyRelations) + ' 条 · 子体维度覆盖 <strong>' + asinText(counts.childrenWithDimensions) + '/'
    + asinText(counts.children) + '</strong>（分母是不同子体数，不是关系条数）· 被纠正的关系 ' + asinText(counts.correctedRelations)
    + ' 条 · 维度集合' + (counts.uniform === true ? '一致' : '不一致') + ' · 父体级批量优化：'
    + (view.parentLevelOptimizationAllowed === true ? '允许' : '禁止（关系不完整、有矛盾，或没有任何变体关系）') + '</div>'
    + '<div class="hint" style="padding:0">角色是服务端给的四个 id 之一（parent / child / both / unrelated），'
    + '页面照原样印，不另编一套中文 —— 工具 amzn_asin_detail 印的是同一个 id。</div>';

  const parentLines = parents.length === 0 ? '' : '<h3>父体（点一行看它的详情）</h3>'
    + parents.map(parent => asinJumpRow(parent.asin, view.marketplace,
      parent.disputed === true ? '有争议：这个子体还挂在别的父体下' : null)
      + (parent.relationId === null || parent.relationId === undefined
        ? '' : '<div class="hint" style="padding:0">边 ' + asinText(parent.relationId) + '</div>')).join('');

  /* 标题里的两个数分开写：上面那个是**不同的子体**，下面这段列表按**关系**一行一条
     （一个子体挂两个父体就会出现两次），所以它的行数等于关系条数而不是子体数。 */
  const childLines = children.length === 0 ? '' : '<h3>同族子体（' + asinText(counts.children) + ' 个不同 ASIN · '
    + asinText(counts.familyRelations) + ' 条关系，点一行看它的详情）</h3>'
    + children.map(child => asinVariantChildBlock(child, view.marketplace)).join('');

  const problemLines = problems.length === 0
    ? (children.length === 0 ? '' : '<div class="asin-note">没有检测到重复或矛盾，维度集合一致。</div>')
    : '<h3>检测到的问题（' + asinText(problems.length) + ' 条，服务端那句话原样印出来）</h3>'
      + problems.map(problem => '<div class="asin-problem"><strong>' + escapeHtml(problem.kind) + '</strong>：'
        + asinText(problem.message) + '</div>').join('');

  const incompleteLines = incomplete.length === 0 ? '' : '<h3>关系不完整（' + asinText(incomplete.length)
    + ' 条 —— 这不是矛盾，处置动作也不同：矛盾要人判定一条边，不完整要去补采）</h3>'
    + incomplete.map(item => '<div class="asin-lack"><strong>' + escapeHtml(item.kind) + '</strong>：'
      + asinText(item.message) + '</div>').join('');

  const correctedLines = corrected.length === 0 ? '' : '<h3>被纠正过的边（' + asinText(corrected.length)
    + ' 条 —— 它们<strong>不参与</strong>上面的检测，历史在这里）</h3>'
    + corrected.map(item => '<div>' + asinText(item.parentAsin) + ' → ' + asinText(item.childAsin)
      + ' · ' + asinText(item.correctedAt) + ' · 理由 ' + asinText(item.correctionReason) + '</div>').join('');

  /* 事件历史是**第四块**，排在被纠正过的边之后：这一页的顺序是「现在的状态 → 有什么问题
     → 哪里不完整 → 已经处理掉的历史」，时间线属于最后一段。
     这一块必须**画出来**（而不是留一个空串占位）：事件是这一页唯一说得清「谁在什么时候
     改了什么」的地方，而它读的是 view.events —— 服务端三种状态（读不出来 / 0 条事件 /
     没有关系）由 asinVariantEventsBlock 分开画，页面不在这里替它兜底。 */
  const eventBlock = asinVariantEventsBlock(view.events);

  return head + parentLines + childLines + problemLines + incompleteLines + correctedLines + eventBlock;
}

/* The ten collection task statuses and their labels are **not** written here: they
   are injected at the top of this script from domain/states.js
   (COLLECTION_TASK_STATUS_LABELS), with the chip class chosen by the page. A
   second hand-kept table in this spot was the drift the injection removes — and
   the drift would be silent, because a status the page does not know renders as
   its raw id, which reads as a data problem rather than a page problem. */

function statusChip(status) {
  /* hasOwnProperty, not a truthiness test. TASK_STATUS is an object literal, so
     TASK_STATUS['constructor'] is Object.prototype.constructor — a function,
     which destructures to [undefined, undefined] and renders the literal word
     "undefined" in the chip. This is reachable rather than theoretical: the
     status is whatever string the agent passed to amzn_optimize_save. */
  const known = Object.prototype.hasOwnProperty.call(TASK_STATUS, status) ? TASK_STATUS[status] : null;
  const [text, cls] = known || [status || '—', ''];
  return '<span class="chip ' + cls + '">' + escapeHtml(text) + '</span>';
}

/**
 * The 13-section state chip.
 *
 * Same shape as statusChip, different vocabulary — the two must not be merged:
 * partial exists in both and means different things (a task with some ASINs done
 * vs a section with some fields read), which is exactly the kind of collision that
 * makes a reader trust the wrong word.
 *
 * status is null for a section that was **never attempted** (notCollected):
 * that is not one of the five states and must not be printed as one. The caller
 * renders that case itself; here it degrades to the dim chip so a stray null can
 * never look like missing (which is a claim about the page: "Amazon has none").
 */
function sectionChip(status) {
  const known = Object.prototype.hasOwnProperty.call(SECTION_STATUS, status) ? SECTION_STATUS[status] : null;
  const [text, cls] = known || ['未采集', ''];
  return '<span class="chip ' + cls + '">' + escapeHtml(text) + '</span>';
}

/* 正在飞的状态：这些才有「取消」可言。终态（完成 / 已取消）上没有动作，
   partial / failed 的出路是重试（新建一条，retry_of 指回来），不是取消这条。 */
const CANCELABLE_TASK_STATUS = ['queued', 'checking_env', 'running', 'waiting_human', 'cooling_down'];

/* 任务表上的状态筛选。**不进 filters**：filters 是「我在看哪一批数据」，会跟着
   3 秒轮询与服务端来回；而这里筛的是已经拉回来的最近 15 条，换模块回来还想看的是
   「全部」。所以它是页面记忆，和 envTableOpen 同一类。
   六档把十种状态归成「要不要我动手」：未结束（要等或要取消）/ 失败（要看原因）/
   部分完成（写进去一半）/ 完成 / 已取消。 */
let taskStatusFilter = 'all';
const TASK_FILTERS = [
  ['all', '全部', null],
  ['open', '未结束', ['draft', 'queued', 'checking_env', 'running', 'waiting_human', 'cooling_down']],
  ['failed', '失败', ['failed']],
  ['partial', '部分完成', ['partial']],
  ['done', '完成', ['done']],
  ['cancelled', '已取消', ['cancelled']],
];

/* 两次点击的待确认状态放在**页面变量**里，不放在 DOM 上：任务表在采集进行中每 3 秒
   重绘一次，挂在按钮上的 dataset 会在用户按下第二次之前被重绘冲掉 ——
   那会让「确认」永远等不到，按钮看起来像是没反应。 */
let cancelArmed = null;

/* 取消动作的结果写在任务表正下方，不写进 collectEnvNote —— 那个提示长在采集表单
   下面，离这张表隔着一屏，写完看不见等于没写。 */
let taskNote = '';

/* 体检的十项明细默认收起（有未过项时强制展开，见 renderCollectEnv）。
   这个开关是页面记忆，不进服务端上下文：它是「我这一会儿想不想看」，
   不是「这台机器能不能采」，存进 filters 会让别人的页面也收起来。 */
let envTableOpen = false;

/* 「手动声明归属」那块折叠区开不开。同上：页面记忆。
   填过自有 / 竞品时**强制展开**（见 renderCollectForm 里的 ownOpen 计算）——
   把用户填过的值藏在收起的块里，比一开始就不给这个框更糟。 */
let ownOpen = false;

/* 「改限速」那块折叠区开不开。同一个理由：这是页面记忆，而且采集进行中每 3 秒
   重绘一次表单 —— 开合状态不记在页面变量里，正在改数值的人会被弹回收起。 */
let paceOpen = false;

function renderTasks() {
  /* T66（B2 同类）：tasks 未取是 null —— 用「|| 空数组」兜底会把「没取到」画成
     「还没有采集任务」。两态各说各的话：空数组 = 读到的真空（画空列表），
     null = 这一格没下发（画缺格空态）。 */
  const tasks = state.tasks === null || state.tasks === undefined ? null : state.tasks;
  const collection = state.collection || {};
  /* The task a 最近运行 link named. It is highlighted rather than filtered to:
     the panel's job is "what has been running", and hiding the rest would answer
     a different question than the one the panel is for. */
  const focus = String((state.filters || {}).taskId ?? '').trim();
  /* 页头对偶句（设计 v3 §4.1 第三行）：与 ASIN 页头同一句。 */
  const dualLine = '采集器管「采没采到」，ASIN 详情管「现在有什么」。';
  if (tasks === null) {
    $('collectHint').textContent = dualLine;
    $('tasks').innerHTML = emptyState('not-recorded', {
      subject: '任务',
      reason: '服务端没有给「任务」这一格 —— 这不是「没有采集任务」。',
      next: '点右上角「重新读取」；一直缺，就是载荷漏了这一格（不是库里没任务）。',
    });
    return;
  }
  /* 这行提示的主语是**采集进程**（collection.running 来自内存里的采集器），
     而下面那张表的主语是**库里的任务行**。两个主语不同，说同一句话就会打架：
     进程空闲时，表里仍可能有上次中断留下的「进行中」，此时只写「当前没有任务在跑」
     等于在否认用户正在看着的那一行。所以两句分开说，各自标明是谁的状态。 */
  const inFlight = tasks.filter(task => CANCELABLE_TASK_STATUS.indexOf(task.status) >= 0);
  const collectHeadLine = collection.running
    ? '采集进程正在跑 ' + String(collection.running).slice(0, 8) + '…' + (collection.queueDepth ? '，另有 ' + collection.queueDepth + ' 个排队' : '')
    : (inFlight.length > 0
      ? '采集进程当前空闲，但表里有 ' + inFlight.length + ' 条停在未结束状态（可能是上次中断留下的）—— 可以取消掉再重提。'
      : (tasks.length > 0 ? '采集进程当前空闲。' : ''));
  $('collectHint').textContent = collectHeadLine === '' ? dualLine : collectHeadLine + ' · ' + dualLine;

  if (tasks.length === 0) {
    $('tasks').innerHTML = emptyState('not-recorded', {
      subject: '采集任务',
      next: '在对话里说「采集这些 ASIN：B0…」，或去「采集器」页用那里的采集表单提交。（2026-10-25：原来指向的右侧栏 10-21 已拆掉，那句话指向一个不存在的按钮。）',
    });
    return;
  }

  /* 六档计数一次算完：chip 上带条数，一眼看得出「失败 3」而不是点进去才知道。 */
  const bucketOf = id => {
    const row = TASK_FILTERS.filter(entry => entry[0] === id)[0];
    return row === undefined ? null : row[2];
  };
  const countOf = statuses => (statuses === null
    ? tasks.length
    : tasks.filter(task => statuses.indexOf(task.status) >= 0).length);
  const taskChips = '<div class="taskfilter">' + TASK_FILTERS.map(entry =>
    '<button type="button" data-task-filter="' + escapeHtml(entry[0]) + '"'
    + (taskStatusFilter === entry[0] ? ' class="on"' : '')
    + '>' + escapeHtml(entry[1]) + ' <span class="n">' + countOf(entry[2]) + '</span></button>').join('') + '</div>';
  const activeStatuses = bucketOf(taskStatusFilter);
  const shown = activeStatuses === null ? tasks : tasks.filter(task => activeStatuses.indexOf(task.status) >= 0);

  const rows = shown.map(task => {
    const progress = task.progress || {};
    const done = progress.total ? (progress.done || 0) + '/' + progress.total : '—';
    /* P3-3：运行中也要看得出「还要多久」。服务端已经算好 remainingMinutes，
       算不出来时它给的是 null 加原因，这里就什么都不添 —— 不拿 0 分钟冒充「马上好」。 */
    const view = task.progressView || {};
    const eta = (view.remainingMinutes === null || view.remainingMinutes === undefined)
      ? ''
      : (view.remainingMinutes === 0 ? '即将完成' : '预计还剩约 ' + view.remainingMinutes + ' 分钟');
    /* 备注这一格只有一百多像素，超出就被省略号切掉，所以顺序按「切掉时先丢谁」排：
       ETA 在最前（运行中唯一影响决策的数），「正在 X」其次，提交时刻最后。
       改前是「提交于 14:36，预计还剩约 4 分钟」，实测在 874px 面板里剩下
       「提交于 14:36，预计还...」—— ETA 正好被切在省略号后面。 */
    const doing = progress.keyword ? '正在 ' + progress.keyword
      : (progress.asin ? '正在 ' + progress.asin : '');
    const noteParts = [];
    if (eta !== '') noteParts.push(eta);
    if (doing !== '') noteParts.push(doing);
    noteParts.push('提交于 ' + taskClock(task.submittedAt));
    const note = task.error || noteParts.join(' · ');
    const result = task.result || {};
    const written = task.kind === 'keyword' ? (result.scanned ?? '') : (result.written ?? '');
    const failedCount = task.kind === 'keyword' ? '' : (result.failed ?? '');
    /* 写入与失败原来各占一列，而「失败」列在 874px 的内容区里根本露不出来 ——
       用户看得见「写 2」，看不见「失败 3」。合成一格：有数才写，一个 0 都不印，
       免得两列空值把这张表撑成一片「—」。 */
    const outcome = [written === '' || written === null ? '' : '写 ' + written]
      .concat(failedCount === '' || failedCount === null || failedCount === 0 ? [] : ['失败 ' + failedCount])
      .filter(Boolean).join(' · ');
    const selected = focus !== '' && String(task.id) === focus;
    const canCancel = CANCELABLE_TASK_STATUS.indexOf(task.status) >= 0;
    const armed = canCancel && cancelArmed === String(task.id);
    const cancelButton = canCancel
      ? '<button type="button" data-cancel-task="' + escapeHtml(String(task.id)) + '"'
        + ' style="font:inherit;font-size:11px;padding:2px 8px;border:1px solid '
        + (armed ? 'var(--warn)' : 'var(--line)') + ';border-radius:5px;background:none;color:'
        + (armed ? 'var(--warn)' : 'var(--fg)') + ';cursor:pointer">'
        + (armed ? '确认？' : '取消') + '</button>'
      : '';
    /* 「重填」：失败 / 部分完成 / 已取消的 ASIN 任务，把原目标填回上方表单。
       **只填不提交** —— 本仓对失败任务的既有立场是「重试 = 提交一条新任务」，
       但按下去就自动开跑，等于把「刚失败就连着重跑」做成一个按钮，而 COOLING_DOWN
       那段注释点名要避免的正是这条路径。填回去、人看一眼、再点提交。 */
    const refillCount = Number(task.targetsCount ?? 0);
    const canRefill = task.kind === 'asin' && refillCount > 0
      && ['failed', 'partial', 'cancelled'].indexOf(task.status) >= 0;
    const refillButton = canRefill
      ? '<button type="button" data-refill-task="' + escapeHtml(String(task.id)) + '"'
        + ' data-refill-count="' + escapeHtml(String(refillCount)) + '"'
        + ' title="把这条任务的 ' + escapeHtml(String(refillCount)) + ' 个目标填回上方表单（不会自动提交）"'
        + ' style="font:inherit;font-size:11px;padding:2px 8px;border:1px solid var(--line);'
        + 'border-radius:5px;background:none;color:var(--fg);cursor:pointer">重填</button>'
      : '';
    return '<tr' + (selected ? ' class="sel"' : '') + '>'
      /* 只印前 8 位是有意的（完整 id 是 36 位 uuid，放进一列就没法看了），
         但完整 id 必须拿得到：title 给出全串，点一下复制 —— 出问题要拿它去查。 */
      + '<td><code data-task-id="' + escapeHtml(String(task.id)) + '" title="'
      + escapeHtml(String(task.id)) + '（点击复制完整 id）" style="cursor:copy">'
      + escapeHtml(String(task.id).slice(0, 8)) + '</code></td>'
      + '<td title="源：' + escapeHtml(String(task.source)) + '">' + (task.kind === 'keyword' ? '关键词' : 'ASIN') + '</td>'
      + '<td>' + statusChip(task.status) + '</td>'
      + '<td>' + escapeHtml(done) + '</td>'
      + '<td title="' + escapeHtml(task.error || note) + '">' + escapeHtml(note) + '</td>'
      + '<td>' + escapeHtml(outcome) + '</td>'
      /* 取消必须**自己占一格**。放进备注那一格的末尾是行不通的：th/td 是
         nowrap + overflow:hidden + text-overflow:ellipsis，备注的文字先把
         格子填满，按钮就被推到裁剪区外面 —— 实测 getBoundingClientRect 给出
         x=1110 而容器右边界是 1051，elementFromPoint 落在 <main> 上，点不着。
         一格一个动作，宽度由浏览器按内容分，按钮永远在表内。 */
      + '<td>' + cancelButton + refillButton + '</td>'
      + '</tr>';
  }).join('');

  /* A highlighted row that is not in the list would be indistinguishable from a
     highlight that silently failed, and the reader would go looking for a task
     that is in fact just older than the fifteen on screen. */
  const missed = focus !== '' && !tasks.some(task => String(task.id) === focus)
    ? '<div class="hint" style="color:var(--warn)">你点进来的那条任务 ' + escapeHtml(focus.slice(0, 8))
      + ' 不在最近 ' + tasks.length + ' 条里（它更早）。逐目标细节用 <code>amzn_collect_status</code> 查它。</div>'
    : '';

  /* 六列，按「窄的时候先牺牲谁」排：任务 / 类型 / 状态 / 进度 是判断当前发生了什么
     必需的，备注是唯一说得出原因的一格，结果只在跑完之后有意义。
     「源」不再单独占一列 —— 这张表长在采集表单右半边（约 530px），
     七列时最后两列会被挤出可视区，而取消按钮正好在备注那一格的右端，
     挤出去就等于取消按钮点不到（实测 elementFromPoint 落在容器外）。
     源没有丢：它在「类型」那一格的 title 里。 */
  $('tasks').innerHTML = taskChips
    + (shown.length === 0
      /* 筛空了要说是「筛出来的空」：与「一条任务都没有」长得一样，但下一句不同。 */
      ? '<div class="hint" style="padding:8px 0">最近 ' + asinText(tasks.length) + ' 条里没有「'
        + escapeHtml((TASK_FILTERS.filter(entry => entry[0] === taskStatusFilter)[0] || ['', '?'])[1])
        + '」的任务 —— 这是筛出来的空，不是没有任务。</div>'
      : '<table aria-label="采集任务"><thead><tr><th>任务</th><th>类型</th><th>状态</th><th>进度</th>'
        + '<th>备注</th><th>结果</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>')
    + missed
    + (taskNote === '' ? '' : '<div class="hint" style="padding:6px 0 0">' + escapeHtml(taskNote) + '</div>')
    + '<div class="hint">' + (shown.length === tasks.length
      ? '最近 ' + tasks.length + ' 个任务'
      : '显示 ' + shown.length + ' / 共 ' + tasks.length + ' 个任务')
    + ' · 逐目标细节在对话里问：'
    + '<code>amzn_collect_status</code>（两种任务都查它）</div>';

  /* 委派挂一次、每次重绘重新赋值（onclick 是覆盖不是累加，所以不会越挂越多）。
     挂在这里而不是逐行 addEventListener：行是每 3 秒重建的，逐行挂要在重绘前
     先摘掉，摘漏一次就多一份监听。 */
  const box = $('tasks');
  if (box !== null) {
    box.onclick = event => {
      const target = event.target;
      if (target === null || typeof target.closest !== 'function') return;
      /* 状态筛选的 chip。它只重画这张表，不 refresh() —— 数据没有变，
         变的只是「这一屏显示哪几行」，没必要为此打一次服务端。 */
      const filter = target.closest('button[data-task-filter]');
      if (filter !== null) {
        taskStatusFilter = String(filter.getAttribute('data-task-filter') || 'all');
        renderTasks();
        return;
      }
      const cancel = target.closest('button[data-cancel-task]');
      if (cancel !== null) {
        const id = String(cancel.getAttribute('data-cancel-task') || '');
        if (id !== '') cancelTask(id);
        return;
      }
      const refill = target.closest('button[data-refill-task]');
      if (refill !== null) {
        refillTaskIntoForm(refill);
        return;
      }
      const code = target.closest('code[data-task-id]');
      if (code !== null) copyTaskId(code);
    };
  }
}

/** 「重填」：把一条失败任务的原始目标填回发起表单，**不提交**。
 *
 *  目标不在 /api/state 里（200 条任务的目标会把它顶穿预算），点这一下才按 id 取 ——
 *  一次点击换一次请求。取回来之后照样只填不跑：本仓对失败任务的立场是
 *  「重试 = 提交一条新任务」，但一键重跑等于把「刚失败就连着重跑」做成一个按钮，
 *  而 COOLING_DOWN 那段注释点名要避免的正是这条路径。填回去、人看一眼、再点提交。 */
function refillTaskIntoForm(button) {
  const id = String(button.getAttribute('data-refill-task') || '');
  if (id === '') return;
  const count = Number(button.getAttribute('data-refill-count') || 0);
  button.disabled = true;
  api('collect-task-targets?taskId=' + encodeURIComponent(id)).then(result => {
    const rows = Array.isArray(result && result.targets) ? result.targets : [];
    const asins = rows.map(target => String(target.asin)).filter(asin => asin !== '');
    if (asins.length === 0) {
      collectFormNote = '这条任务没有留下可重填的目标（可能是一条关键词任务）—— 不能替你猜。';
      renderCollectForm();
      return;
    }
    const marketplace = String((rows[0] || {}).marketplace || '');
    const box = $('collectTargets');
    if (box === null) return;
    box.value = asins.join(', ');
    const site = $('collectMarketplace');
    if (site !== null && marketplace !== '') site.value = marketplace;
    collectFormNote = '已把 ' + asins.length + ' 个目标填回上方表单'
      + (count > asins.length ? '（原任务 ' + count + ' 个，只取回 ' + asins.length + ' 个）' : '')
      + (marketplace === '' ? '' : '，站点 ' + marketplace)
      + ' —— 确认后再点「提交采集」。';
    renderCollectForm();
    const drawn = $('collectTargets');
    if (drawn !== null && typeof drawn.focus === 'function') drawn.focus();
  }).catch(showPageError).then(() => { button.disabled = false; });
}

/** 复制一条任务的完整 id，并把「复制到了」写在原地 —— 不弹 toast：
    复制是这一下的全部目的，视线不该离开那一行。 */
function copyTaskId(code) {
  const full = String(code.getAttribute('data-task-id') || '');
  if (full === '') return;
  const done = () => {
    code.textContent = '已复制 ' + full.slice(0, 8);
    setTimeout(() => { code.textContent = full.slice(0, 8); }, 1200);
  };
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(full).then(done, () => fallbackCopy(full, done));
    return;
  }
  fallbackCopy(full, done);
}

/* 宿主页面不一定是安全上下文（http + 非 localhost、或者某些内嵌 webview 里
   navigator.clipboard 直接不存在），那时上面的分支根本进不去 —— 用老办法兜住，
   而不是让「点了没反应」。 */
function fallbackCopy(text, done) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
  document.body.removeChild(area);
  if (ok) done();
}

/**
 * 取消一条任务：点第一次是「上膛」，第二次才发。
 *
 * 不用 confirm()：那是个阻塞对话框，在采集轮询里会把 3 秒的重绘卡住，
 * 而且它拦的是整个窗口 —— 用户想看的行在旁边看不见。两次点击的代价一样低，
 * 但状态在页面上看得见（按钮变红、文案变「再点一次确认取消」）。
 *
 * 取消**不删已采到的节**：这是服务端 countSectionResults 的契约，
 * 返回里的 keptSections 就是那句「已采到的不白采」的数字，这里要把它说出来，
 * 否则用户会以为取消等于白跑。
 */
async function cancelTask(taskId) {
  if (cancelArmed !== taskId) {
    cancelArmed = taskId;
    renderTasks();
    return;
  }
  cancelArmed = null;
  if (collectBusy === true) return;
  collectBusy = true;
  try {
    const result = await api('collect-cancel', { method: 'POST', body: JSON.stringify({ taskId: taskId }) });
    const kept = Number(result && result.keptSections);
    taskNote = kept > 0
      ? '已取消 ' + taskId.slice(0, 8) + '，它已经采到的 ' + kept + ' 节保留着（取消不回滚已采到的数据）。'
      : '已取消 ' + taskId.slice(0, 8) + '。';
    await refresh();
  } catch (error) {
    showPageError(error);
  } finally {
    collectBusy = false;
  }
}

/* ── 模块 04：采集中心（F04-01…F04-07）─────────────────────────────────────────
   Four blocks over two data sources: the read-only slice state.collectPanel
   (contract §6.3) and GET /api/sections for the thirteen sections of **one**
   ASIN. The section detail is deliberately not in the state payload: the panel
   polls every three seconds, and thirteen sections times 200 ASINs would be the
   whole payload budget (contract §3: 120 KB).
   Writes go through the routes B-04b already built: collect-env-check /
   collect-preview / collect-run.

   NB: no backticks anywhere below — this whole file is one template string, and a
   backtick in it ends the string. No template placeholders either: they would be
   evaluated by the *outer* literal, not by the browser. */

/* Page memory, not server data: what the last render was about, and what the
   server last answered for it. These must survive a re-render (that is what they
   are for) and must never be posted back up. */
let collectFocus = null;          /* {taskId, asin, marketplace} */
let collectSections = null;       /* the last /api/sections payload */
let collectSectionsError = null;
let collectPreview = null;        /* the last collect-preview answer */
let collectPreviewError = null;
let collectFormNote = '';         /* the one-line result of the last form action */
let collectEnvNote = '';          /* the one-line result of the last health check */
let collectBusy = false;
/* Has the form been drawn at least once? The distinction is what lets the first
   render use the **defaults** (the entry's own selection) while every later render
   reads the boxes back off the screen. "Does the element exist" cannot tell the two
   apart: before the first draw the boxes do not exist, and after it they exist and
   hold the rendered text. */
let collectFormDrawn = false;
/* 第三子批后半新增的三条一次性提示 + 限速提示。它们与 collectEnvNote 同类：是**服务端
   刚说过的一句话**，不是页面自己算的结论。分开放而不是共用一条，因为方案卡与计划卡在
   同一屏上，共用一条会让「停用方案被拒」和「计划没启用」抢同一行字。 */
let collectSchemeNote = '';       /* 方案卡上最后一条结果或结构化拒绝 */
let collectPlanNote = '';         /* 计划卡上最后一条结果或结构化拒绝 */
let collectWaitingNote = '';      /* 待人工卡上最后一条处置结果或结构化拒绝 */
let collectPaceNote = '';         /* 限速控件上最后一条写入结果 */

/** ISO-8601 UTC to something a person reads, without pretending to localise it. */
function collectStamp(value) {
  const text = String(value ?? '');
  return text === '' ? '—' : text.replace('T', ' ').replace('Z', '').slice(0, 19);
}

/* ══ 页面纯函数区（F-1 任务时刻 / F-2 采集方案选项）══════════════════════════════
   这一段只放**纯函数**：不读 state、不碰 DOM、只依赖参数与注入的 escapeHtml / SECTION_NAME。
   tests/t76-task-clock.mjs 按下面这两个标记把整段切出来直接 eval —— 所以这里一旦塞进
   有副作用的东西，那条测试会先红。

   注意：本文件整段是一个模板字符串（export const asinScript），所以这一段注释里
   **不许出现反引号** —— 一个反引号就能把模板提前结束，症状是「页面脚本突然语法错」。
   引用代码名请直接写名字，不要用反引号包起来。 */

/** 任务备注里的时刻。
 *
 *  **为什么不能只印时分**：采集页的任务列表会横跨好几天，全印 06:37 读起来像同一天 ——
 *  而这一格是运营判断「上次什么时候采的、要不要重采」的唯一依据。
 *  所以：**今天的印 HH:MM，不是今天的印 MM-DD HH:MM**。
 *
 *  **为什么一个格式器算两件事**：「是不是今天」和「印几点几分」必须用**同一个时区**，
 *  否则跨零点的时区里会出现「印 23:40 但按本地已经算昨天」这种自相矛盾。
 *  这里两件事都走同一个 Intl.DateTimeFormat，所以结构上不可能一个按 UTC、一个按本地。
 *  时区默认取浏览器本地 —— 与 asinWhen（本地 getHours）、policy 页的
 *  toLocaleString 同一口径。
 *
 *  认不出形状就照印原文（不猜、不补 0）；空值印一个破折号。
 *  备注那一格在 874px 的面板里只剩一百多像素，完整值仍在 title 里。
 */
function taskClock(value, now, timeZone) {
  const text = String(value === null || value === undefined ? '' : value);
  if (text === '') return '—';
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return text;
  const shape = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  };
  let formatter;
  try {
    formatter = timeZone === null || timeZone === undefined
      ? new Intl.DateTimeFormat('en-US', shape)
      : new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: String(timeZone) }, shape));
  } catch (error) {
    /* 时区名不合法：退回本机时区。为一个拼错的时区把整个任务列表打崩，不划算。 */
    formatter = new Intl.DateTimeFormat('en-US', shape);
  }
  const partsOf = moment => {
    const bag = {};
    for (const part of formatter.formatToParts(moment)) bag[part.type] = part.value;
    return bag;
  };
  const parts = partsOf(at);
  const reference = now === null || now === undefined ? new Date() : new Date(now);
  const today = Number.isNaN(reference.getTime()) ? partsOf(new Date()) : partsOf(reference);
  const clock = parts.hour + ':' + parts.minute;
  const sameDay = parts.year === today.year && parts.month === today.month && parts.day === today.day;
  return sameDay ? clock : parts.month + '-' + parts.day + ' ' + clock;
}

/** 节的总数只从注入的节词表数出来 —— 页面不写死 13。 */
function sectionTotal() {
  return Object.keys(SECTION_NAME).length;
}

/** 这一份方案有没有覆盖全部节。 */
function schemeCoversAll(scheme, total) {
  const sections = scheme === null || scheme === undefined || !Array.isArray(scheme.sections)
    ? []
    : scheme.sections;
  return sections.length >= total;
}

/**
 * 采集方案下拉的选项（F-2）。
 *
 * **默认项必须说出实际会发生什么。** 服务端对空 schemeId 的解析是 active[0]
 * （domain/collect/preview.js 的 schemeOf），**不是**「全部 13 节」——
 * 所以在没有覆盖全节的方案时，把空 value 的选项写成「（全部 13 节）」是一句谎话：
 * 实测 2026-10-25，唯一可用方案 AM-1 E2E 最小验证方案 v2 只覆盖 1 节（bsr），
 * 而运营按默认提交会以为采了 13 节。
 *
 * 现在的做法是**把能力缺口显示出来，不用默认值盖住**：
 *   · 有覆盖全节的方案 → 那一份作为「（全部 13 节：名字 v2）」的选项，且**默认选中它**，
 *     提交时用的是它自己的 id（不再依赖服务端 active[0] 的巧合）；
 *   · 没有 → 保留一条 disabled 的「（全部 13 节）」把缺口写明，默认选中**真的会跑的那一份**，
 *     并在控件下面附一行覆盖提示（schemeCoverageHint）。
 */
function schemeOptionList(schemes, spec) {
  const list = Array.isArray(schemes) ? schemes : [];
  const total = spec.total;
  const valueOf = spec.valueOf;
  const labelOf = spec.labelOf;
  const selected = spec.selected === undefined || spec.selected === null ? '' : String(spec.selected);
  const covered = list.filter(scheme => schemeCoversAll(scheme, total));
  const fallback = covered.length > 0
    ? String(valueOf(covered[0]))
    : (list.length === 0 ? null : String(valueOf(list[0])));
  const anySelected = list.some(scheme => String(valueOf(scheme)) === selected);
  const parts = [];
  if (covered.length === 0) {
    parts.push('<option value="" disabled>（全部 ' + total + ' 节 —— 本仓还没有覆盖全节的方案）</option>');
  }
  for (const scheme of list) {
    const value = String(valueOf(scheme));
    const isCover = covered.length > 0 && value === fallback;
    const label = isCover
      ? '（全部 ' + total + ' 节：' + labelOf(scheme) + '）'
      : labelOf(scheme);
    const chosen = (anySelected && value === selected) || (!anySelected && value === fallback);
    parts.push('<option value="' + escapeHtml(value) + '"' + (chosen ? ' selected' : '') + '>'
      + escapeHtml(label) + '</option>');
  }
  return parts.join('');
}

/** 方案控件下面那行提示：**只在有话必须说的时候返回非空**。调用方负责 escapeHtml。 */
function schemeCoverageHint(schemes, total) {
  const list = Array.isArray(schemes) ? schemes : [];
  if (list.length === 0) return '库内还没有 active 方案 —— 这次提交不会带方案。';
  if (list.some(scheme => schemeCoversAll(scheme, total))) return '';
  const fallback = list[0];
  const count = fallback !== null && fallback !== undefined && Array.isArray(fallback.sections)
    ? fallback.sections.length
    : 0;
  return '本仓还没有覆盖全部 ' + total + ' 节的方案：默认会跑 ' + String(fallback.name)
    + ' v' + String(fallback.version) + '，覆盖 ' + count + '/' + total + ' 节。'
    + '要全节请先在采集方案里建一份覆盖 ' + total + ' 节的 active 方案。';
}

/* ── F-3：表格里「点行」与「勾选」是两个意图，决策单独放，DOM 只负责接线 ────────

   为什么要分成两个纯函数：这两个动作都会改 state.context.selection.asins，
   而下游（优化页的门槛、批量动作）只认这个多选集。把「下一次选中集是什么」写成
   纯函数，测试就能直接断言**替换**与**追加**的区别，不用把整张表渲染出来；
   renderTable 只负责把 handler 接上，不再自己算选中集。 */

/** 点行之后选中集应该是什么：**替换**成这一个。
 *
 *  为什么是替换而不是并存：下游只认多选集，并存会让「选中集」变成两个概念的混合体
 *  （「我要看的那一条」+「我要批量处理的那几条」），而任何一处读它的人都无法区分。
 *  替换之后「点行 = 看这一条」是完整的：详情跟着选中集走，选中集里就是这一条。
 *  keywords 是另一个维度，原样保住 —— 点一行 ASIN 不该顺手清掉关键词的选中。 */
function asinRowPickSelection(key, selection) {
  const parts = String(key).split('|');
  const keywords = selection !== null && selection !== undefined && Array.isArray(selection.keywords)
    ? selection.keywords
    : [];
  return { asins: [{ asin: parts[0], marketplace: parts[1] }], keywords };
}

/** 勾选框之后选中集应该是什么：加入 / 移出这一条，**其余一个都不动**（也不动详情）。 */
function asinPickSelection(key, selection) {
  const parts = String(key).split('|');
  const current = selection !== null && selection !== undefined && Array.isArray(selection.asins)
    ? selection.asins.slice()
    : [];
  const at = current.findIndex(entry => entry.asin === parts[0] && entry.marketplace === parts[1]);
  if (at >= 0) current.splice(at, 1);
  else current.push({ asin: parts[0], marketplace: parts[1] });
  const keywords = selection !== null && selection !== undefined && Array.isArray(selection.keywords)
    ? selection.keywords
    : [];
  return { asins: current, keywords };
}

/** 表格下面那行说明。**选中多于一条时必须提前说清「点行会替换」** ——
 *  否则用户以为自己是在加选，而他那 12 条会在他点下去的那一刻没了。 */
function asinPickHint(selectedCount) {
  const count = Number(selectedCount);
  const base = '勾选加入选中；点一行查看它的详情';
  if (!Number.isFinite(count) || count <= 1) return base;
  return base + '（点行会把选中的 ' + count + ' 条替换成那一条）';
}

/** 行首的勾选框。aria-label 里带 ASIN：读屏用户不用猜这一格选的是谁。 */
function asinPickBoxHtml(key, isSelected) {
  const asin = String(key).split('|')[0];
  return '<input type="checkbox" class="asin-pick" data-asin-pick="' + escapeHtml(String(key)) + '"'
    + (isSelected === true ? ' checked' : '') + ' aria-label="选择 ' + escapeHtml(asin) + '">';
}


/* ══ /页面纯函数区 ══ */


/**
 * 一次拒绝，按服务端说的原样印出来（契约 §6.1）。
 *
 * **错误码照印，不翻译**：它是页面与 agent 共用的那个闭集，把它改写成一句更顺耳的话
 * 就是同一条规则的第二份措辞 —— 两份会漂开，而漂开的时候两边都不报错。页面额外补的是
 * 错误码本身装不下的两样东西：服务端自己的那句话，以及它给出 「allowed」 时的允许集合
 * （「ACTION_NOT_ALLOWED」 / 「ILLEGAL_TRANSITION」）。没有允许集合，读者只知道「这次不行」，
 * 不知道「哪一次行」。
 *
 * 「error.body」 只有响应是 JSON 时才有（api() 把解析过的 body 挂上去）。网络层的失败没有
 * body，这时退回 Error.message —— 那也是最诚实的一句话。
 */
function collectRefusal(error) {
  const body = error === null || error === undefined ? null : error.body;
  const code = body !== null && body !== undefined && body.code ? String(body.code) : null;
  const message = body !== null && body !== undefined && body.error
    ? String(body.error)
    : String((error && error.message) || error);
  const allowed = body !== null && body !== undefined && Array.isArray(body.allowed) ? body.allowed : [];
  const hint = body !== null && body !== undefined && body.hint ? String(body.hint) : '';
  return '<div class="collect-refuse">'
    + '<strong>' + escapeHtml(code === null ? '请求被拒' : code) + '</strong>：' + escapeHtml(message)
    + (allowed.length === 0 ? '' : '<br>允许的动作：' + escapeHtml(allowed.join(' / ')))
    + (hint === '' ? '' : '<br><span class="hint" style="padding:0">' + escapeHtml(hint) + '</span>')
    + '</div>';
}

/** 成功的一行说明（与上面的拒绝分开画，因为两者不是同一件事，样式也不同）。 */
function collectNote(text) {
  return '<div class="hint" style="padding:0">' + escapeHtml(String(text)) + '</div>';
}

/** The site the form is pointed at: the control if it exists, else the filter. */
function collectMarketplace() {
  const select = $('collectMarketplace');
  if (select !== null && select !== undefined && String(select.value ?? '').trim() !== '') return String(select.value).trim();
  const fromFilter = String((state.filters || {}).marketplace ?? '').trim();
  if (fromFilter !== '' && fromFilter !== SCOPE_ALL) return fromFilter;
  const sites = (state.collectPanel && Array.isArray(state.collectPanel.sites)) ? state.collectPanel.sites : [];
  const first = sites.find(site => site !== null && site !== undefined && site.code !== undefined);
  return first === undefined ? 'US' : String(first.code);
}

/**
 * 「这个框里我看到了什么」—— 只回答识别结果，不替服务端判合法。
 *
 * 分隔符按运营真会敲的几种切开：英文/中文逗号、分号、换行、空格、顿号。
 * ASIN 的形状是 10 位字母数字 —— 这条规则**宽到能认错**（10 位品牌词也长得像），
 * 所以措辞是「像 ASIN 的」，不是「有效的」。真正的判定在服务端，这里多说的话
 * 就会在下一次规则改动后变成假话。
 */
function collectTargetCountText(raw) {
  const tokens = String(raw ?? '').split(/[,，;；、\\s]+/).filter(token => token !== '');
  if (tokens.length === 0) return '';
  const seen = new Set();
  let duplicated = 0;
  const likeAsin = [];
  const other = [];
  for (const token of tokens) {
    if (/^[A-Za-z0-9]{10}$/.test(token)) {
      const upper = token.toUpperCase();
      if (seen.has(upper)) { duplicated += 1; continue; }
      seen.add(upper);
      likeAsin.push(upper);
    } else if (other.length < 3) {
      other.push(token);
    }
  }
  const parts = ['识别到 ' + likeAsin.length + ' 个像 ASIN 的'];
  if (duplicated > 0) parts.push('去重掉 ' + duplicated + ' 个重复');
  if (likeAsin.length !== tokens.length) {
    const odd = tokens.length - likeAsin.length - duplicated;
    parts.push('另外 ' + odd + ' 段不像'
      + (other.length === 0 ? '' : '：' + other.join('、') + (odd > other.length ? ' …' : '')));
  }
  return parts.join(' · ');
}

/**
 * What the form should show.
 *
 * After the first draw the values are read back off the screen: the panel
 * re-renders on every poll (every three seconds while a run is in flight), and
 * rebuilding the boxes from the server payload alone would wipe a half-typed ASIN
 * list every three seconds. On the **first** draw the defaults apply, and the
 * default is the entry's own selection — that is F04-04's whole point: the external
 * entry already knows what it wants collected.
 */
function collectFormValues() {
  const read = (id) => {
    const element = $(id);
    if (element === null || element === undefined) return null;
    return String(element.value === undefined ? '' : element.value);
  };
  const targets = collectFormDrawn === true ? read('collectTargets') : null;
  if (targets !== null) {
    return {
      targets,
      self: read('collectSelf') ?? '',
      competitor: read('collectCompetitor') ?? '',
      marketplace: read('collectMarketplace') ?? '',
      schemeId: read('collectScheme') ?? '',
    };
  }
  const selection = (state.context && state.context.selection && Array.isArray(state.context.selection.asins))
    ? state.context.selection.asins
    : [];
  const prefill = (state.collectPanel || {}).prefill || null;
  return {
    /* The entry's ASINs go in the **neutral** box, not the self box. The self box
       is level 1 of the ownership chain — the level that decides on its own — and
       filling it in on the user's behalf would record "the person says this is
       ours" for every ASIN an observation card happened to hand over. */
    targets: selection.map(entry => String(entry.asin ?? '')).filter(asin => asin !== '').join(', '),
    self: '',
    competitor: '',
    marketplace: collectMarketplace(),
    /* A prefill may name a scheme; it is preselected only if it is still active. */
    schemeId: prefill !== null && prefill.changes !== undefined
      ? (prefill.changes.find(change => change.path === 'schemeId') || {}).to ?? ''
      : '',
  };
}

/** The chips table for the four environment states, injected (see the top). */function envStateChip(status) {
  const known = Object.prototype.hasOwnProperty.call(ENV_STATE, status) ? ENV_STATE[status] : null;
  const [text, cls] = known || [status || '—', ''];
  return '<span class="chip ' + cls + '">' + escapeHtml(text) + '</span>';
}

function riskLabel(risk) {
  const known = Object.prototype.hasOwnProperty.call(RISK_LEVEL, risk) ? RISK_LEVEL[risk] : null;
  return known === null ? String(risk ?? '—') : known;
}

/**
 * F04-01 / F04-02: the environment bar and the ten-item table.
 *
 * Six columns exactly as contract §7.2 lists them (状态 / 检查项 / 说明 / 是否可修 /
 * 修复动作 / 风险). Two things this must not do:
 *
 *   · render unknown as if it were a pass. 09-proxy is permanently unknown
 *     (adjudication §3) because this version does not go through a proxy; a green
 *     tick there would be a check that never ran, and the prototype's "18/20" is
 *     a measurement this repo cannot make. The item gets its own chip, no class,
 *     plus a sentence saying why.
 *   · offer a repair button on an item the server refuses to repair. The button
 *     is drawn from repairable, which is the server's own answer.
 */
function renderCollectEnv() {
  const box = $('collectEnv');
  if (box === null) return;
  const panel = state.collectPanel || {};
  const env = panel.env || null;
  const summary = env === null ? null : env.summary;
  const cooldown = (panel.risk || {}).cooldown || null;
  const marketplace = collectMarketplace();

  /* 这几样要放在 head 之前：下面那颗「收起/展开」按钮要看 checks.length 与 autoOpen，
     而 const 是 TDZ —— 放到 head 后面读会在**渲染时**抛
     「Cannot access 'checks' before initialization」，症状是整个采集面板一片空白
     （实测踩过：collectEnv 与 collectForm 同时为空，控制台只有一条 404）。 */
  const checks = env === null || !Array.isArray(env.checks) ? [] : env.checks;
  /* 有未过项、或者有可修项，就自动展开 —— 那时每一行都是要处理的东西。
     全部通过、也没有可修的东西时，它不需要每次都被读一遍，收成一行摘要。
     摘要里点名提醒项与查不了项 —— 收起不等于藏掉。 */
  const autoOpen = summary !== null && (Number(summary.fail) > 0 || Number(summary.repairable) > 0);
  const open = autoOpen || envTableOpen === true;
  const nonPass = checks.filter(check => check.status !== 'ok');
  const collapsedLine = open || checks.length === 0 ? '' : (() => {
    /* 用 label，不用 id：5-login 对运营不是一句话，登录态 才是。
       payload 里两个都在（routes 的 collectionPanel 已经 join 过 ENV_CHECK_META）。 */
    const warnList = nonPass.filter(check => check.status === 'warn').map(check => check.label ?? check.id);
    const unknownList = nonPass.filter(check => check.status !== 'warn' && check.status !== 'ok').map(check => check.label ?? check.id);
    const parts = [];
    if (warnList.length > 0) parts.push('提醒 ' + warnList.length + '：' + warnList.join(' / '));
    if (unknownList.length > 0) parts.push('查不了 ' + unknownList.length + '：' + unknownList.join(' / '));
    return '<div class="hint" style="padding:0">' + (parts.length === 0
      ? '十项全部通过，明细收起了。'
      : '十项里没有阻断项；' + escapeHtml(parts.join(' · '))) + '</div>';
  })();

  const head = [];
  if (summary === null) {
    head.push('<span class="chip">还没体检过</span>'
      + '<span class="hint" style="padding:0">体检回答「这台机器<strong>现在</strong>能不能采」；'
      + '任务失败时它指出该修哪一项，而不是让人猜。</span>');
  } else {
    head.push('<span class="chip ' + (summary.fail > 0 ? 'stop' : (summary.warn > 0 ? 'warn' : 'ok')) + '">'
      + '通过 ' + escapeHtml(String(summary.ok)) + ' / ' + escapeHtml(String(summary.total)) + '</span>');
    if (summary.fail > 0) head.push('<span class="chip stop">未过 ' + escapeHtml(String(summary.fail)) + '</span>');
    if (summary.warn > 0) head.push('<span class="chip warn">提醒 ' + escapeHtml(String(summary.warn)) + '</span>');
    if (summary.unknown > 0) head.push('<span class="chip">查不了 ' + escapeHtml(String(summary.unknown)) + '</span>');
    if (summary.repairable > 0) head.push('<span class="chip warn">' + escapeHtml(String(summary.repairable)) + ' 项可修</span>');
    head.push('<span class="hint" style="padding:0">' + escapeHtml(collectStamp(env.checkedAt))
      + ' · ' + escapeHtml(marketplace) + '</span>');
  }
  if (cooldown !== null && cooldown !== undefined && cooldown.active === true) {
    head.push('<span class="chip warn">站点冷却中，约 ' + escapeHtml(String(cooldown.minutesRemaining ?? '?')) + ' 分钟</span>');
  }
  head.push(checks.length === 0 || autoOpen
    ? ''
    : '<button id="collectEnvToggle" type="button" style="margin-left:auto">'
      + (open ? '收起明细' : '看十项明细') + '</button>')
  head.push('<button id="collectEnvRun"' + (checks.length === 0 || autoOpen ? ' style="margin-left:auto"' : '') + '>一键体检</button>');

  const body = checks.length === 0
    ? emptyState('not-recorded', {
      subject: '体检结果',
      next: '点右上角「一键体检」跑一次十项检查 —— 它读的是运行时、浏览器、专用 profile、CDP 端口、登录态、站点上下文、数据目录、采集方案、代理、站点冷却。',
    })
    : (!open ? '' : '<table aria-label="环境体检十项"><thead><tr><th>状态</th><th>检查项</th><th>说明</th><th>是否可修</th><th>修复动作</th><th>风险</th></tr></thead><tbody>'
      + checks.map(check => {
        const action = check.repairable === true
          ? '<button data-collect-repair="' + escapeHtml(check.id) + '">修复</button>'
          : '<span class="hint" style="padding:0">—</span>';
        return '<tr>'
          + '<td>' + envStateChip(check.status) + '</td>'
          + '<td><code>' + escapeHtml(check.id) + '</code> ' + escapeHtml(check.label || '') + '</td>'
          + '<td title="' + escapeHtml(check.detail || '') + '">' + escapeHtml(check.detail || '') + '</td>'
          + '<td>' + (check.repairable === true ? '可修' : '不可修') + '</td>'
          + '<td>' + action + '</td>'
          + '<td>' + escapeHtml(riskLabel(check.risk)) + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table>');

  /* The ninth item, named explicitly. Its status is unknown and its detail comes
     from the server; the page adds the sentence a reader needs ("this version does
     not go through a proxy") rather than a number it cannot measure. */
  const proxy = checks.find(check => check.id === '09-proxy');
  const proxyNote = proxy === undefined || proxy === null ? ''
    : '<div class="hint">第 9 项「代理」恒为<strong>查不了</strong>：<strong>本版采集不走代理</strong>'
      + '（本仓没有代理配置项）。所以这一格不会出现通过，也不会出现「18/20」这类读数 —— 那是原型里的数字，'
      + '本机没有东西可以量它。</div>';

  box.innerHTML = '<div class="bar">' + head.join('') + '</div>' + collapsedLine + body
    + (open ? proxyNote : '')
    + (collectEnvNote === '' ? '' : '<div class="hint" style="padding:0">' + escapeHtml(collectEnvNote) + '</div>')
    /* T53：质量汇总与体检同在一处，读者先看「机器能不能采」，再看「最近采得怎么样」。 */
    + '<div style="margin-top:8px">' + collectQualityHtml() + '</div>';

  /* NOT named after the optimize run slice: that panel's payload check walks every
     dotted chain rooted at the word "run" anywhere in this script — prose included —
     and resolves it against the run slice, so a local with that name turns an onclick
     assignment into a demand for a field the payload does not have. The comment at
     that check records the same trap. */
  const envRunButton = $('collectEnvRun');
  if (envRunButton !== null) {
    envRunButton.onclick = () => collectEnvCheck({ marketplace, repair: false });
  }
  const envToggle = $('collectEnvToggle');
  if (envToggle !== null) {
    envToggle.onclick = () => {
      envTableOpen = !open;
      renderCollectEnv();
    };
  }
  for (const button of box.querySelectorAll('button[data-collect-repair]')) {
    button.onclick = () => collectEnvCheck({ marketplace, repair: true, checks: [button.dataset.collectRepair] });
  }
}

/**
 * Run a health check (optionally repairing one item) and re-read state.
 *
 * apiWithApproval is the right door even for the repair: launch_browser on the
 * server answers 409 + APPROVAL_REQUIRED, and that is a question being relayed, not
 * a failure. The route and the tool call the same function, so the audit rows match.
 */
async function collectEnvCheck({ marketplace, repair, checks = null }) {
  if (collectBusy === true) return;
  collectBusy = true;
  try {
    const body = { marketplace, repair: repair === true };
    if (checks !== null) body.checks = checks;
    const result = await apiWithApproval('collect-env-check', body);
    collectEnvNote = repair === true ? '修复动作已执行，复查结果见上表。' : '体检完成。';
    if (Array.isArray(result.repairs) && result.repairs.length > 0) {
      collectEnvNote = result.repairs.map(entry => entry.id + '：' + (entry.ok === true ? '已修复' : '未修复（' + String(entry.code ?? '') + '）')).join('；');
    }
    await refresh();
  } catch (error) {
    showPageError(error);
  } finally {
    collectBusy = false;
  }
}

/** F04-04: the banner that says which entry handed this form over and what it defaulted. */
function collectBanner(prefill) {
  const sections = Array.isArray(prefill.defaultSections) ? prefill.defaultSections : [];
  const fields = Array.isArray(prefill.defaultFields) ? prefill.defaultFields : [];
  const changes = Array.isArray(prefill.changes) ? prefill.changes : [];
  const selection = (state.context && state.context.selection && Array.isArray(state.context.selection.asins))
    ? state.context.selection.asins.length : 0;
  const range = sections.length === 0
    ? '无（目标为空，或者这些节都还在新鲜窗口内）'
    : sections.length + ' 节：' + sections.join(' / ');
  return '<div class="collect-banner">'
    + '<strong>来自外部入口：' + escapeHtml(String(prefill.from ?? '未知')) + '</strong>'
    + '<div class="hint" style="padding:0">上下文 <code>' + escapeHtml(String(prefill.contextId)) + '</code>'
    + ' · 默认只采<strong>过期节</strong>（' + escapeHtml(range) + '）'
    + ' · 默认字段 ' + (fields.length === 0 ? '无' : escapeHtml(fields.join(' / ')))
    + ' · 新鲜窗口 ' + escapeHtml(String(prefill.freshnessDays)) + ' 天'
    + '</div>'
    + '<div class="hint" style="padding:0">入口带过来 ' + escapeHtml(String(selection)) + ' 个 ASIN（已放进下面的目标框）。'
    + (changes.length === 0
      ? '这一版横幅是<strong>只读</strong>的：你改了哪一项、相对默认改成了什么，提交时逐条记进这个任务的 prefill。'
      : '已记录 ' + escapeHtml(String(changes.length)) + ' 项改动：' + escapeHtml(changes.map(change => change.path).join(' / ')))
    + '</div></div>';
}

/** F04-03 / F04-04: the form on the left. */
function renderCollectForm() {
  const box = $('collectForm');
  if (box === null) return;
  const panel = state.collectPanel || {};
  const values = collectFormValues();
  const sites = Array.isArray(panel.sites) ? panel.sites : [];
  const schemes = Array.isArray(panel.schemes) ? panel.schemes.filter(scheme => scheme.status === 'active') : [];
  const prefill = panel.prefill || null;
  const marketplace = values.marketplace === '' ? collectMarketplace() : values.marketplace;
  const site = sites.find(entry => entry !== null && entry !== undefined && entry.code === marketplace) || null;
  const usage = state.collection === null || state.collection === undefined ? null : state.collection.todayUsage;

  const siteOptions = (sites.length === 0 ? [{ code: marketplace, label: marketplace, postalCode: null }] : sites)
    .map(entry => '<option value="' + escapeHtml(entry.code) + '"' + (entry.code === marketplace ? ' selected' : '') + '>'
      + escapeHtml(entry.code) + (entry.label === undefined || entry.label === null ? '' : ' · ' + escapeHtml(entry.label)) + '</option>')
    .join('');
  const schemeOptions = schemeOptionList(schemes, {
    total: sectionTotal(),
    valueOf: scheme => String(scheme.id),
    labelOf: scheme => String(scheme.name) + ' v' + String(scheme.version),
    selected: values.schemeId,
  });
  /* 「（全部 13 节）」曾经是默认项，而服务端对空 schemeId 的解析是 active[0] ——
     实测唯一可用方案只覆盖 1 节。现在默认项就是真的会跑的那一份，缺口另起一行说清。 */
  const schemeHint = schemeCoverageHint(schemes, sectionTotal());

  /* 填过就不收起来：把用户自己填的值藏进一个默认关闭的块里，比不给这个框更糟。 */
  const ownFilled = String(values.self ?? '').trim() !== '' || String(values.competitor ?? '').trim() !== '';
  const ownExpanded = ownOpen === true || ownFilled;

  box.innerHTML = '<div class="collect-card collect-form">'
    + '<h3>发起采集（F04-03 / F04-04）</h3>'
    + (prefill === null ? '' : collectBanner(prefill))
    /* 一个框，不是三个。
       改前这里并排三个输入框：「目标 ASIN（归属由优先链判定）」「自有 ASIN（写进这个框 =
       第 1 级，直接定案）」「竞品 ASIN（同上）」。那三句标签是**数据模型**的话，不是运营的
       话 —— 运营脑子里是「把这批 ASIN 采一下」，不是「它属于第几级」。1440×900 实测三个框
       占掉表单前三行，把站点 / 方案 / 限速全推到第二屏，而真正常用的只有第一个。
       现在：只留一个目标框，归属那两个收进「手动声明」折叠区（默认收起，填过就自动展开，
       不把已有的值藏起来）。服务端契约一个字段都没少 —— 两个 id 与它们的语义照旧。 */
    + '<label for="collectTargets">要采集的 ASIN</label>'
    + '<textarea id="collectTargets" placeholder="B0XXXXXXXXX, B0YYYYYYYYY（逗号、空格、换行都行）">' + escapeHtml(values.targets) + '</textarea>'
    + '<div class="hint" id="collectTargetCount" style="padding:0"></div>'
    + '<details class="collect-own" id="collectOwn"' + (ownExpanded ? ' open' : '') + '>'
    + '<summary>这几条里有的不是我的 / 是竞品？手动声明归属</summary>'
    + '<div class="hint" style="padding:0">不填也行：这批 ASIN 走中性口径，采完之后由归属链按规则判定。'
    + '在这里点名才是<strong>定案</strong> —— 点进来的条数不再被规则改。两个框都留空 = 一条都不声明。</div>'
    + '<label for="collectSelf">自有 ASIN（写进这个框 = 第 1 级，直接定案）</label>'
    + '<textarea id="collectSelf" placeholder="留空则不声明">' + escapeHtml(values.self) + '</textarea>'
    + '<label for="collectCompetitor">竞品 ASIN（同上）</label>'
    + '<textarea id="collectCompetitor" placeholder="留空则不声明">' + escapeHtml(values.competitor) + '</textarea>'
    + '</details>'
    + '<label for="collectMarketplace">站点</label>'
    + '<select id="collectMarketplace">' + siteOptions + '</select>'
    + '<label for="collectScheme">采集方案</label>'
    + '<select id="collectScheme">' + schemeOptions + '</select>'
    + (schemeHint === '' ? '' : '<div class="hint" style="padding:0">' + escapeHtml(schemeHint) + '</div>')
    + '<div class="hint" style="padding:0">生效邮编 '
    + escapeHtml(site === null || site.postalCode === null || site.postalCode === undefined ? '—' : String(site.postalCode))
    + '（在「设置 → 站点」里改）</div>'
    + collectPaceBlock(usage)
    + '<div class="bar" style="border-bottom:none;padding:0">'
    + '<button id="collectPreviewRun">跑预览</button>'
    + '<button id="collectDraft">存为草稿</button>'
    /* 主按钮放最右、且是全页唯一一个实心按钮：「提交采集」是这张表单的终点，
       改前三个按钮长得一样、提交夹在中间，第一次用的人要先读三个标签才敢按。 */
    + '<button id="collectSubmit" class="primary">提交采集</button>'
    + '</div>'
    + (collectFormNote === '' ? '' : '<div class="hint" style="padding:0">' + escapeHtml(collectFormNote) + '</div>')
    + collectPreviewBlock()
    + '</div>';

  const previewRun = $('collectPreviewRun');
  if (previewRun !== null) previewRun.onclick = () => collectRunPreview();
  const submit = $('collectSubmit');
  if (submit !== null) submit.onclick = () => collectSubmitForm({ draft: false });
  const draft = $('collectDraft');
  if (draft !== null) draft.onclick = () => collectSubmitForm({ draft: true });
  /* 目标框的「识别到几条」。运营粘进来的东西经常混着中文逗号、换行、全角空格，
     而提交时的解析在服务端 —— 页面不替它猜，只把**这一次看到了什么**说出来：
     几个像 ASIN 的、几个不像的。看不出来就直说「一个都不像」，而不是给个 0。 */
  const targetBox = $('collectTargets');
  const countBox = $('collectTargetCount');
  if (targetBox !== null && countBox !== null) {
    const draw = () => { countBox.textContent = collectTargetCountText(targetBox.value); };
    targetBox.oninput = draw;
    draw();
  }
  /* 折叠区的开合记在页面变量里：采集进行中每 3 秒重绘一次，<details> 的 open 属性
     不在 values 里，重绘就会把它弹回收起 —— 正在第二个框里打字的人会被折叠掉。 */
  const own = $('collectOwn');
  if (own !== null) own.ontoggle = () => { ownOpen = own.open === true; };
  const paceFold = $('collectPaceFold');
  if (paceFold !== null) paceFold.ontoggle = () => { paceOpen = paceFold.open === true; };
  for (const button of box.querySelectorAll('button[data-pace-save]')) {
    button.onclick = () => collectSavePacing(String(button.dataset.paceSave));
  }
  collectFormDrawn = true;
}

/**
 * 限速与每日上限的控件（契约 §3 「限速与每日上限由服务端在提交时强制」）。
 *
 * 上一子批这一格只印了读数（今日已用 X/Y）与「由服务端强制」这句话。读数是对的，但
 * 旁边没有改的入口：三项限速住在设置页那张十七行的表里，而人在**准备提交**的那一刻
 * 才第一次看见「今日已用 1198 / 1200」。所以这里补上入口，写的是**同一个键、同一条
 * 路由（setting-set）、同一道闸门**（工作空间写检查 + 审计），不新开一条写路径。
 *
 * 三条不是手写的：键、类型、下限、说明、生效时机全部取自**采集页自己的载荷**
 * （「collectPanel.pacingRows」，服务端从 「store/settings.js」 的那份声明里读出来的那几行；
 * 读设置切片是 B-04c-2 修掉的接线断点，见下面那段注释）。页面里写一份「哪三个键」就是
 * 第二份声明，而第二份漏掉一个键的症状是「设置页能改、这里看不见」—— 两边都不报错。
 *
 * 生效时机那一句同样来自声明（「effect」）。B-04c-2 之前这个字段在库里没有读者，页面上
 * 唯一的说法是「由服务端强制」，而「强制」回答不了「我现在改成 5 秒，正在跑的那个任务
 * 会不会变」—— 那正是 「effect」 这句话要答的。
 */
function collectPaceBlock(usage) {
  const panel = state.collectPanel || {};
  /* 控件读的那几行来自**采集页自己的载荷**（「collectPanel.pacingRows」，契约 §6.3
     主理人修订 2026-10-09）：「state.settings」是惰性切片，只在设置模块上才算，
     而这一格长在采集模块的发起表单里 —— 读设置切片里的 rows，症状是永远走
     「读不到设置行」，一个输入框都不画。行里的键/类型/下限/说明/生效时机仍然
     全部来自「store/settings.js」的那份声明，页面不写第二份。 */
  const rows = Array.isArray(panel.pacingRows) ? panel.pacingRows : [];
  /* 「服务端此刻生效」那半句读的是**采集页自己的载荷**（「collectPanel.pacing.resolved」，
     契约 §6.3 主理人修订 2026-10-09 第二次）。B-04c-2 之前读的是「state.settings.pacing」——
     那是惰性切片，只在设置模块上才算，于是采集模块上这一格永远印「服务端未就绪，读不到生效值」，
     而右边那三个数（来源「collection.todayUsage」）恰恰就是服务端给的：一句假话紧挨着一个真数字。
     切片补上之后这里**总是**带着 resolved，所以剩下的那一种 null 只意味着「这个值真的取不到」，
     措辞也就只说到那半句为止，不许扩成整体的「服务端未就绪」。 */
  const panelPacing = panel.pacing === null || panel.pacing === undefined ? {} : panel.pacing;
  const resolved = panelPacing.resolved === null || panelPacing.resolved === undefined ? null : panelPacing.resolved;
  const settings = state.settings === null || state.settings === undefined ? {} : state.settings;
  const pacing = settings.pacing === null || settings.pacing === undefined ? {} : settings.pacing;
  /* 今日用量优先取 「state.collection.todayUsage」（这一栏本来的来源，与页头的任务数同一个
     切片），设置切片里的同一对数只当兜底 —— 两个切片都来自 「collection.dailyUsage()」，
     读哪一个都对，但「读不到时退回另一个」能让设置切片未就绪时这一格仍然有数字。 */
  const usedFromSlice = pacing.used === null || pacing.used === undefined ? null : pacing.used;
  const limitFromSlice = pacing.limit === null || pacing.limit === undefined ? null : pacing.limit;
  const used = usage !== null && usage !== undefined && usage.used !== undefined ? usage.used : usedFromSlice;
  const limit = usage !== null && usage !== undefined && usage.limit !== undefined ? usage.limit : limitFromSlice;
  const remaining = usage !== null && usage !== undefined && usage.remaining !== undefined ? usage.remaining : pacing.remaining;

  /* 取不到时只说这半句：右边那三个用量数字就是服务端给的，「服务端未就绪」是把一句话的
     空缺说成了整体不可信 —— 而那正是这一格必须避免的读法（契约 §6.3 修订②）。 */
  const effective = resolved === null
    ? '<span class="hint" style="padding:0">生效值取不到</span>'
    : '每任务上限 <strong>' + escapeHtml(String(resolved.perTaskMax ?? '—')) + '</strong> 个'
      + ' · 任务间隔 <strong>' + escapeHtml(Array.isArray(resolved.taskGapMs) && resolved.taskGapMs.length === 2
        ? Math.round(resolved.taskGapMs[0] / 1000) + '–' + Math.round(resolved.taskGapMs[1] / 1000) + ' 秒' : '—') + '</strong>';
  const today = used === null || limit === null
    ? ''
    : ' · 今日已用 <strong>' + escapeHtml(String(used)) + ' / ' + escapeHtml(String(limit)) + '</strong>'
      + (remaining === null || remaining === undefined
        ? '' : '（剩 ' + escapeHtml(String(remaining)) + '）');

  if (rows.length === 0) {
    /* 读不到设置行时的样子必须与「没有限速」区分开：这里明说读不到，并指出去哪里改。 */
    return '<div class="collect-pace"><div>服务端此刻生效：' + effective + today + '</div>'
      + '<div class="hint" style="padding:0">读不到设置行（设置切片未就绪），所以这一格没有控件 —— '
      + '去「设置 → 采集与数据源」改 <code>pacing.*</code>。（读不到不等于没有上限。）</div></div>';
  }

  const controls = rows.map(row => {
    const key = String(row.key);
    const inputId = 'collectPace-' + key;
    const fallback = row.value === null || row.value === undefined ? '' : String(row.value);
    /* 已经画过一次之后，值从屏幕上读回来：面板在跑任务时每 3 秒重画一遍，把输入框按
       服务端的值重建会把你刚敲的数字擦掉 —— 与上面 ASIN 框同一个理由、同一道保护。 */
    const onScreen = collectFormDrawn === true ? $('collectPace-' + key) : null;
    const value = onScreen === null || onScreen === undefined ? fallback : String(onScreen.value === undefined ? '' : onScreen.value);
    return '<div class="head" style="margin-top:4px">'
      + '<label for="' + escapeHtml(inputId) + '"><code>' + escapeHtml(key) + '</code></label>'
      + '<input type="number" id="' + escapeHtml(inputId) + '" min="' + escapeHtml(String(row.min ?? 1)) + '" value="' + escapeHtml(value) + '">'
      + '<button data-pace-save="' + escapeHtml(key) + '">保存</button>'
      + (row.stored === true ? '<span class="chip ok">已设置</span>' : '<span class="chip">默认 ' + escapeHtml(fallback) + '</span>')
      + '<span class="k">' + escapeHtml(String(row.note ?? '')) + '</span>'
      + '<span class="k">生效：' + escapeHtml(String(row.effect ?? '服务端未声明生效时机')) + '</span>'
      + '</div>';
  }).join('');

  return '<div class="collect-pace">'
    + '<div>服务端此刻生效：' + effective + today + '</div>'
    /* 三个输入框默认收起：它们改的是「每次采集之间隔多久」，一天也未必改一次，
       而三行控件加三句说明在发起表单的最下面占了三百多像素 —— 实测 1440×900 下
       第一屏最后三分之一是它们。上面那行「此刻生效 + 今日已用」仍然露着，
       因为那才是提交前真正要看的一句。 */
    + '<details class="collect-fold" id="collectPaceFold"' + (paceOpen ? ' open' : '') + '><summary>改限速（每任务上限 / 任务间隔 / 每天上限）</summary>'
    + controls
    + '<div class="hint" style="padding:0">这三项与「设置 → 采集与数据源」是同一行设置，改这里就是改那里。'
    + '每天的上限在本地 00:00 归零；提交时超过上限会被拒绝，而不是排队。</div>'
    + '</details>'
    + (collectPaceNote === '' ? '' : collectPaceNote)
    + '</div>';
}

/**
 * 写一个限速值：与设置页**同一条路由、同一个门**，只是把拒绝留在控件旁边。
 *
 * 一处必须转换的地方：输入框给的是**字符串**，而 「setSetting」 对 int 键要求
 * 「typeof value === 'number'」。把 "45" 原样发上去，服务端会回
 * 「must be an integer (got \"45\")」—— 那句拒绝是对的，但它对着一格明明写着 45 的输入框
 * 说，读起来像页面坏了。所以这里转成数字再发；**下限不在这里判**（0 照样发上去，
 * 由服务端用它自己的那句「must be >= 1」回话）—— 页面替服务端判范围就是第二条规则。
 * 唯一的例外是非数字：那种值连「发了也一定被拒」都不是，它根本不是一个数，页面直接
 * 说明，不占用一次往返。
 */
async function collectSavePacing(key) {
  if (collectBusy === true) return;
  const box = $('collectPace-' + key);
  if (box === null || box === undefined) return;
  const raw = String(box.value === undefined ? '' : box.value).trim();
  const value = Number(raw);
  if (raw === '' || Number.isInteger(value) === false) {
    collectPaceNote = collectNote('没发出：' + key + ' 需要一个整数（当前是「' + raw + '」）。');
    renderCollectForm();
    return;
  }
  collectBusy = true;
  collectPaceNote = collectNote('写入中…');
  renderCollectForm();
  try {
    const result = await api('setting-set', { method: 'POST', body: JSON.stringify({ key, value }) });
    collectPaceNote = collectNote('已写入 ' + String(result.key ?? key) + ' = ' + String(result.value ?? value)
      + '（' + String((collectPaceRowsEffect(key) ?? '下次采集任务生效')) + '）');
    await refresh();
  } catch (error) {
    collectPaceNote = collectRefusal(error);
    await refresh();
  } finally {
    collectBusy = false;
    renderCollectForm();
  }
}

/** 某个键的「什么时候生效」，从采集页自己那份行里取；取不到就是 null（页面不编）。 */
function collectPaceRowsEffect(key) {
  const panel = state.collectPanel || {};
  const rows = Array.isArray(panel.pacingRows) ? panel.pacingRows : [];
  const row = rows.find(entry => entry !== null && entry !== undefined && String(entry.key) === String(key));
  return row === undefined || row.effect === null || row.effect === undefined ? null : String(row.effect);
}

/** What the form would send, from the four controls. */
function collectFormArgs() {
  const values = collectFormValues();
  const split = text => String(text ?? '').split(/[\s,;、]+/).map(value => value.trim()).filter(value => value !== '');
  const args = {
    marketplace: values.marketplace === '' ? collectMarketplace() : values.marketplace,
  };
  const targets = split(values.targets);
  if (targets.length > 0) args.asins = targets;
  const self = split(values.self);
  if (self.length > 0) args.selfAsins = self;
  const competitors = split(values.competitor);
  if (competitors.length > 0) args.competitorAsins = competitors;
  if (String(values.schemeId ?? '').trim() !== '') args.schemeId = String(values.schemeId).trim();
  /* F04-04: the run records which entry this form came from. Without this the
     banner would describe a prefill the task row never mentions. */
  const prefill = (state.collectPanel || {}).prefill || null;
  if (prefill !== null) args.sourceContextId = prefill.contextId;
  return args;
}

/** The six numbers contract §6.2.3 requires the preview to answer with. */
function collectPreviewBlock() {
  if (collectPreviewError !== null) {
    return '<div class="hint" style="color:var(--warn);padding:0">预览被拒：' + escapeHtml(collectPreviewError) + '</div>';
  }
  const preview = collectPreview;
  if (preview === null) return '';
  const valid = preview.validAsins || { total: 0, self: 0, competitor: 0 };
  const duplicates = Array.isArray(preview.duplicates) ? preview.duplicates : [];
  const unknown = Array.isArray(preview.unknownOwnership) ? preview.unknownOwnership : [];
  const requests = preview.estimatedRequests || {};
  const risk = preview.risk || {};
  const reuse = preview.reuse || {};
  const head = '<div class="collect-card"><h3>提交前预览</h3>';
  const line = (label, value) => '<div class="hint" style="padding:0">' + escapeHtml(label) + '：' + value + '</div>';
  return head
    + line('目标', escapeHtml(String(valid.total)) + ' 个（自有 ' + escapeHtml(String(valid.self))
      + ' · 竞品 ' + escapeHtml(String(valid.competitor)) + '）')
    + line('重复', duplicates.length === 0 ? '无' : escapeHtml(duplicates.map(entry => entry.asin || entry).join(' / ')))
    + line('待判定归属', unknown.length === 0
      ? '无'
      : escapeHtml(String(unknown.length)) + ' 个（'
        + escapeHtml(unknown.map(entry => entry.asin + ' → ' + String(entry.tier)).join('；'))
        + '）——<strong>都只当建议</strong>，要你确认才写库')
    + line('预计请求', escapeHtml(String(requests.requests ?? '—')) + ' 次 · 节 ' + escapeHtml(String(requests.sections ?? '—'))
      + ' · 需登录节 ' + escapeHtml(String(requests.loginRequiredSections ?? '—')))
    + line('风控风险', escapeHtml(String(risk.level ?? '—')) + (risk.reasons === undefined || !Array.isArray(risk.reasons) || risk.reasons.length === 0
      ? '' : '（' + escapeHtml(risk.reasons.join('；')) + '）'))
    + line('复用快照', reuse.skipped === true ? '未请求' : escapeHtml(String(reuse.count ?? 0)) + ' 个目标的快照仍在窗口内')
    + (Array.isArray(preview.notes) && preview.notes.length > 0
      ? '<div class="hint" style="padding:0">' + escapeHtml(preview.notes.join(' ')) + '</div>' : '')
    + '</div>';
}

async function collectRunPreview() {
  if (collectBusy === true) return;
  collectBusy = true;
  collectPreviewError = null;
  collectFormNote = '预览中…';
  renderCollectForm();
  try {
    collectPreview = await api('collect-preview', { method: 'POST', body: JSON.stringify(collectFormArgs()) });
  } catch (error) {
    collectPreview = null;
    collectPreviewError = String(error.message || error);
  } finally {
    collectBusy = false;
    collectFormNote = '';
    /* Re-render from memory only: the preview writes nothing, so a full refresh
       would just re-read the same state and, worse, wipe the form. */
    renderCollectForm();
  }
}

async function collectSubmitForm({ draft }) {
  if (collectBusy === true) return;
  collectBusy = true;
  collectFormNote = draft === true ? '存草稿中…' : '提交中…';
  collectPreviewError = null;
  renderCollectForm();
  try {
    const args = collectFormArgs();
    if (draft === true) args.draft = true;
    /* apiWithApproval: a batch of more than one target is gated by the approval
       policy, and its 409 is the person being asked whether they mean it. */
    const result = await apiWithApproval('collect-run', args);
    collectFormNote = draft === true
      ? '已存为草稿（' + String(result.taskId ?? '') + '），不会入队。'
      : '已提交 ' + String(result.taskId ?? '') + '，状态 ' + String(result.status ?? 'queued') + '。';
    collectPreview = null;
    await refresh();
  } catch (error) {
    collectFormNote = '';
    showPageError(error);
  } finally {
    collectBusy = false;
    renderCollectForm();
  }
}

/**
 * F04-06: the waiting_human card, **with its actions wired** (B-04c-2).
 *
 * The buttons come from the server's own 「actions[]」 (「waitingView」 →
 * 「actionsForTrigger」), never from a table here. That is what makes
 * 「ACTION_NOT_ALLOWED」 unreachable by construction: a trigger the server would
 * refuse does not produce a button, so the page cannot offer a click that only
 * comes back as a refusal.
 *
 * The one thing the page decides on its own is **which action carries a reason
 * box**: 「abandon」 (contract §6.2.6 — 「放弃本次」must say why). It is drawn as a
 * text box beside that one button rather than as a table of "which action needs
 * what": the requirement is stated once in the contract and enforced by the
 * server (「REASON_REQUIRED」), and the page's job is to make the field available,
 * not to be a second copy of the rule. Clicking 放弃 with an empty box is
 * therefore allowed to happen — and the refusal it comes back with is shown
 * verbatim, which is the honest version of a required field.
 */
function renderCollectWaiting() {
  const box = $('collectWaiting');
  if (box === null) return;
  const panel = state.collectPanel || {};
  const waiting = panel.waiting;
  const title = '<h3>等待人工处置（F04-06）</h3>';
  if (waiting === null || waiting === undefined) {
    box.innerHTML = '<div class="collect-card">' + title
      + '<div class="hint" style="padding:0">当前没有停在「待人工」的任务。任务卡在登录态、登录墙或计划窗口时，'
      + '会在这里给出触发原因、允许的处置与截止时刻。</div></div>';
    return;
  }
  const actions = Array.isArray(waiting.actions) ? waiting.actions : [];
  const selected = panel.selectedTask === null || panel.selectedTask === undefined ? null : panel.selectedTask;
  const taskId = selected === null ? String((state.filters || {}).taskId ?? '') : String(selected.taskId);

  const controls = actions.map(action => {
    const id = String(action.id);
    if (id === 'abandon') {
      return '<span style="display:inline-flex;gap:4px;align-items:center">'
        + '<input type="text" id="collectWaitReason" placeholder="放弃的原因（必填）">'
        + '<button data-collect-wait="' + escapeHtml(id) + '">' + escapeHtml(action.label) + '</button>'
        + '</span>';
    }
    return '<button data-collect-wait="' + escapeHtml(id) + '">' + escapeHtml(action.label) + '</button>';
  }).join(' ');

  /* 任务号印出来：一条 waiting 只属于一个任务，而「处置哪个」在这张卡上是唯一可能被
     搞错的事 —— 卡片跟着**选中**的任务走（collectPanel.waiting 的服务端来源），
     所以人是先点了任务行才看到它。 */
  box.innerHTML = '<div class="collect-card">' + title
    + '<div class="collect-wait">'
    + '<div>' + statusChip('waiting_human') + ' <strong>' + escapeHtml(collectTriggerLabel(waiting.trigger)) + '</strong>'
    + (taskId === '' ? '' : ' <span class="hint" style="padding:0">任务 <code>' + escapeHtml(taskId.slice(0, 8)) + '</code></span>')
    + '</div>'
    + '<div>' + escapeHtml(waiting.reason === null || waiting.reason === undefined ? '（服务端没有给原因）' : String(waiting.reason)) + '</div>'
    + '<div class="hint" style="padding:0">自 ' + escapeHtml(collectStamp(waiting.since)) + ' 起，'
      + escapeHtml(collectStamp(waiting.deadlineAt)) + ' 到期'
      + (waiting.minutesLeft === null || waiting.minutesLeft === undefined ? '' : '（还剩约 ' + escapeHtml(String(waiting.minutesLeft)) + ' 分钟）')
      + '。到期后自动取消，<strong>已采到的节保留</strong>。</div>'
    + (actions.length === 0
      ? '<div class="hint" style="padding:0">服务端没有为这个触发给出任何动作 —— 那就一个按钮都不画。</div>'
      : '<div class="bar" style="border-bottom:none;padding:0">' + controls + '</div>')
    + '<div class="hint" style="padding:0">每个动作都保留已采到的节；'
      + '「打开采集浏览器」只拉起窗口，<strong>不会替你输入任何凭据</strong>。</div>'
    + '</div>'
    + (collectWaitingNote === '' ? '' : collectWaitingNote)
    + '</div>';

  for (const button of box.querySelectorAll('button[data-collect-wait]')) {
    button.onclick = () => collectWaitingResolve(taskId, String(button.dataset.collectWait));
  }
}

/**
 * 处置一个待人工任务（F04-06，契约 §6.2.6）。
 *
 * **不做乐观更新**：拒绝时页面一个字段都不许先改 —— 「被拒时状态原样不动」是工具层的
 * 合同，页面若先把状态画成已继续，就会把一次没发生的处置说成发生了。所以这里只发请求、
 * 把服务端的话印出来、再 「refresh()」 读一次真实状态（读回来的样子就是证据）。
 *
 * 走 「apiWithApproval」：「open-browser」 会拉起浏览器，那条路可能返回
 * 409 + APPROVAL_REQUIRED，那是一个正在转达的问题，不是失败。
 */
async function collectWaitingResolve(taskId, action) {
  if (collectBusy === true) return;
  if (String(taskId) === '') {
    collectWaitingNote = collectNote('这条 waiting 没有可解析的任务号，处置没发出。');
    renderCollectWaiting();
    return;
  }
  collectBusy = true;
  collectWaitingNote = '';
  renderCollectWaiting();
  try {
    const body = { taskId: String(taskId), action: String(action) };
    const reasonBox = $('collectWaitReason');
    if (action === 'abandon' && reasonBox !== null && reasonBox !== undefined) {
      body.reason = String(reasonBox.value === undefined ? '' : reasonBox.value);
    }
    const result = await apiWithApproval('collect-waiting', body);
    collectWaitingNote = collectNote(String(result.note ?? '已处置')
      + '（状态 ' + String(result.status ?? '') + '，保留已采节 ' + String(result.keptSections ?? 0) + ' 行）');
    await refresh();
  } catch (error) {
    /* 被拒时**只有这句话**会变：任务状态、触发、允许的动作都还是服务端上一次给的。
       下面的 refresh() 仍然要跑 —— 拒绝也可能伴随别的变化（比如等待刚好超时被取消）。 */
    collectWaitingNote = collectRefusal(error);
    await refresh();
  } finally {
    collectBusy = false;
    renderCollectWaiting();
  }
}

/** The three waiting triggers in words (COLLECTION_WAITING_TRIGGERS ids stay on the wire). */
function collectTriggerLabel(trigger) {
  const known = Object.prototype.hasOwnProperty.call(WAITING_TRIGGER, trigger) ? WAITING_TRIGGER[trigger] : null;
  return known === null ? String(trigger ?? '未知触发') : known;
}

/* ── 模块 04：方案管理（F04-09）───────────────────────────────────────────────
   版本化资产。三件事决定这一段的形状：

   ① **一行 = 一个版本**（「(id, version)」 是主键），不是「一个方案」。把多版本收成一张卡
      会让「这个任务用的是哪一版」在页面上无迹可寻 —— 而那正是版本化的全部意义。
   ② **四态与两条动作都从闭集来**。状态词的键集是 「COLLECTION_SCHEME_STATUSES」（注入），
      每个状态下能点的按钮还要过一遍 domain 的迁移表（注入的 「SCHEME_EDGES」）：新加一条边
      只会让按钮**少**一个，不会让页面发出一次服务端必然拒绝的请求。
   ③ **可用性不在这里判定**。方案是否可用、能不能废弃、有没有任务在用，全是服务端说的
      （「SCHEME_VERIFY_FAILED」 / 「SCHEME_IN_USE」 / 「APPROVAL_REQUIRED」…），页面把结构化
      拒绝原样印出来。页面上先替服务端判一次，就是第二条规则。 */

const SCHEME_ACTIONS_BY_STATUS = {
  draft: [
    { action: 'verify', label: '验证并转为可用', to: 'active', destructive: false },
    { action: 'obsolete', label: '废弃', to: 'obsolete', destructive: true },
  ],
  active: [
    { action: 'disable', label: '停用', to: 'disabled', destructive: true },
    { action: 'obsolete', label: '废弃', to: 'obsolete', destructive: true },
  ],
  disabled: [
    { action: 'restore', label: '恢复可用', to: 'active', destructive: false },
    { action: 'obsolete', label: '废弃', to: 'obsolete', destructive: true },
  ],
  /* obsolete 是终态（迁移表里无出边）。这里写空数组不是「还没做」，是**照抄**那条规则：
     已废弃的方案不可复活，否则「已废弃」就没有意义。 */
  obsolete: [],
}

/** The scheme status chip, same shape as statusChip but its own vocabulary. */
function schemeChip(status) {
  const known = Object.prototype.hasOwnProperty.call(SCHEME_STATUS, status) ? SCHEME_STATUS[status] : null;
  const [text, cls] = known || [status || '—', ''];
  return '<span class="chip ' + cls + '">' + escapeHtml(text) + '</span>';
}

/** One version's coverage list: the thirteen section names, or the deliberate empty. */
function collectSchemeSections(sections) {
  const list = Array.isArray(sections) ? sections : [];
  if (list.length === 0) {
    return '<span class="hint" style="padding:0">空清单 —— <strong>什么都不采</strong>（这是合法选择，不是缺省）</span>';
  }
  const names = list.map(id => {
    const known = Object.prototype.hasOwnProperty.call(SECTION_NAME, id) ? SECTION_NAME[id] : null;
    return '<span title="' + escapeHtml(String(id)) + '">' + escapeHtml(known === null ? String(id) : known) + '</span>';
  });
  return names.join(' / ') + ' <span class="k">（13 节中的 ' + escapeHtml(String(list.length)) + ' 节）</span>';
}

/**
 * 走一次方案状态流转（F04-09，契约 §6.2.10），路由与工具同一个实现（「schemeTransition」）。
 *
 * 「confirm」 **由这次点击亲自给出**：契约把 「disable」 / 「obsolete」 定为破坏性，要求
 * 「confirm:true」 才动；一个标着「停用」的按钮被点，就是那个人给的确认 —— 这正是契约
 * 写的那条路（「确认要这么做就再调一次并带 confirm: true」）。reason 从卡片上的输入框读，
 * 空着不发：服务端会回 「REASON_REQUIRED」，而那句话比页面自己编一句更可信。
 */
async function collectSchemeTransition(scheme, action) {
  if (collectBusy === true) return;
  collectBusy = true;
  collectSchemeNote = '';
  renderCollectSchemes();
  try {
    const body = {
      op: 'transition',
      id: String(scheme.id),
      version: Number(scheme.version),
      action: String(action),
      confirm: true,
    };
    const reasonBox = $('collectSchemeReason');
    const reason = reasonBox === null || reasonBox === undefined ? '' : String(reasonBox.value === undefined ? '' : reasonBox.value).trim();
    if (reason !== '') body.reason = reason;
    const result = await api('collect-scheme', { method: 'POST', body: JSON.stringify(body) });
    const updated = result.scheme || {};
    collectSchemeNote = collectNote('方案 ' + String(updated.id ?? scheme.id) + ' v' + String(updated.version ?? scheme.version)
      + '：' + String(action) + ' → ' + String(updated.status ?? ''));
    await refresh();
  } catch (error) {
    collectSchemeNote = collectRefusal(error);
    await refresh();
  } finally {
    collectBusy = false;
    renderCollectSchemes();
  }
}

/**
 * F04-09: the scheme cards, one per **version**.
 *
 * Empty state says what a scheme is and how one comes to exist, because an empty box
 * reads as "this feature does not exist" — and here the reader has no other surface
 * that would tell them otherwise (there is no separate scheme page).
 */
function renderCollectSchemes() {
  const box = $('collectSchemes');
  if (box === null) return;
  const panel = state.collectPanel || {};
  const schemes = Array.isArray(panel.schemes) ? panel.schemes : [];

  if (schemes.length === 0) {
    box.innerHTML = emptyState('not-recorded', {
      subject: '采集方案',
      reason: '还没有任何采集方案。方案 = 一份可复用的清单：这次要采 13 节里的哪几节、'
        + '限定哪些站点、要不要登录。新建一份草稿后，它必须先验证并转为可用'
        + '（真跑一次体检 + 一个商品页探针），才能在发起采集时被选到。',
      next: '在对话里说「新建一个只采基础信息与五点的采集方案」，或让 agent 调 amzn_collect_scheme_save。',
    });
    return;
  }

  const edges = SCHEME_EDGES;
  const cards = schemes.map(scheme => {
    const status = String(scheme.status ?? '');
    const allowed = Array.isArray(edges[status]) ? edges[status] : [];
    const offered = (SCHEME_ACTIONS_BY_STATUS[status] ?? []).filter(entry => allowed.includes(entry.to));
    const needsReason = offered.some(entry => entry.destructive === true);
    const verified = scheme.verifiedAt === null || scheme.verifiedAt === undefined
      ? '<span class="hint" style="padding:0">从未验证（<strong>不等于验证失败</strong>）</span>'
      : escapeHtml(collectStamp(scheme.verifiedAt)) + (scheme.verifiedBy === null || scheme.verifiedBy === undefined
        ? '' : ' <span class="k">by ' + escapeHtml(String(scheme.verifiedBy)) + '</span>');
    const marketplaces = scheme.marketplaces === null || scheme.marketplaces === undefined
      ? '不限站点'
      : (Array.isArray(scheme.marketplaces) && scheme.marketplaces.length > 0
        ? scheme.marketplaces.join(' / ')
        : '<span class="hint" style="padding:0">限定为空集 —— 哪个站点都用不了</span>');
    const buttons = offered.map(entry => '<button data-scheme-action="' + escapeHtml(entry.action)
      + '" data-scheme-id="' + escapeHtml(String(scheme.id)) + '" data-scheme-version="' + escapeHtml(String(scheme.version))
      + '">' + escapeHtml(entry.label) + '</button>').join(' ');
    const reason = needsReason
      ? '<input type="text" id="collectSchemeReason" placeholder="停用/废弃的原因（必填）">'
      : '';
    return '<div class="collect-item" data-scheme="' + escapeHtml(String(scheme.id) + '@' + String(scheme.version)) + '">'
      + '<div class="head"><strong>' + escapeHtml(String(scheme.name)) + '</strong> '
      + '<code>' + escapeHtml(String(scheme.id)) + '</code> v' + escapeHtml(String(scheme.version))
      + ' ' + schemeChip(status) + '</div>'
      + '<div class="k">字段覆盖：' + collectSchemeSections(scheme.sections) + '</div>'
      + '<div class="k">站点：' + marketplaces
      + ' · 驱动：<code>' + escapeHtml(String(scheme.driver ?? '—')) + '</code>'
      + ' · 需登录：' + (scheme.requiresLogin === true ? '是' : '否')
      + ' · 风险：' + escapeHtml(riskLabel(scheme.riskLevel)) + '</div>'
      + '<div class="k">最近验证：' + verified + '</div>'
      + (offered.length === 0
        ? '<div class="hint" style="padding:0">这份版本没有可做的流转：' + escapeHtml(status)
          + ' 在状态机里' + (allowed.length === 0 ? '是终态。' : '的出口都不是这里画的动作。') + '</div>'
        : '<div class="bar" style="border-bottom:none;padding:0;flex-wrap:wrap">' + reason + buttons + '</div>')
      + '</div>';
  }).join('');

  box.innerHTML = '<div class="hint" style="padding:0">共 ' + escapeHtml(String(schemes.length))
    + ' 个版本（一行一个版本；同一方案改版会多一行，旧版本一字不动）。'
    + '<strong>验证并转为可用</strong>是唯一会让一份版本变成可用的动作：它真跑一次体检加一个商品页探针，'
    + '过了才写验证时间。</div>'
    + (collectSchemeNote === '' ? '' : collectSchemeNote)
    + cards;

  for (const button of box.querySelectorAll('button[data-scheme-action]')) {
    const scheme = {
      id: String(button.dataset.schemeId),
      version: Number(button.dataset.schemeVersion),
    };
    button.onclick = () => collectSchemeTransition(scheme, String(button.dataset.schemeAction));
  }
}

/* ── 模块 04：计划采集（F04-10）───────────────────────────────────────────────
   六项配置一项不少，而**窗口那一项要分开写**：库里存的是 「{from,to,tz}」（一天的时段），
   而「现在开没开」是读的那一刻算出来的（「nextWindow」）—— 契约明说不设 「next_run_at」
   列，因为没有调度器，一个只有人算得出来的列等于把算错的结果存进库。所以窗口那行印的是
   两件事：存的时段（配置），和读时判定的 openNow（读数，带判定时刻）。 */

/** 计划卡上的状态徽章：默认关闭是**默认**，不是错误，所以不上高亮。 */
function collectPlanEnabledChip(enabled) {
  return enabled === true ? '<span class="chip ok">已启用</span>' : '<span class="chip">默认关闭</span>';
}

/**
 * 只翻 「enabled」，不整行替换（F04-10）。
 *
 * 「setPlanEnabled」 是**另一个动作**，不是 「plan_save」 的一个参数：把一个开关走整行替换，
 * 调用方就得把其余每一项原样发回去，而「原样」来自页面上那份可能已经过期的表单 ——
 * 于是关一个计划会顺手把别人刚改的运行窗口改回去。路由的 「op」 就是这个区别的落点。
 */
async function collectPlanToggle(plan) {
  if (collectBusy === true) return;
  collectBusy = true;
  collectPlanNote = '';
  renderCollectPlans();
  try {
    const result = await apiWithApproval('collect-plan', {
      op: 'set-enabled',
      id: String(plan.id),
      enabled: plan.enabled !== true,
    });
    const updated = result.plan || {};
    collectPlanNote = collectNote('计划 ' + String(updated.name ?? plan.name) + '：'
      + (updated.enabled === true ? '已启用' : '已停用（默认关闭）'));
    await refresh();
  } catch (error) {
    collectPlanNote = collectRefusal(error);
    await refresh();
  } finally {
    collectBusy = false;
    renderCollectPlans();
  }
}

/**
 * F04-10: the plan cards, six settings each (运行窗口 / 频率 / 上限 / 失败策略 / 冷却 / 暂停条件).
 *
 * Two sentences this card owes the reader, because both are things the prototype's
 * silence would let them assume:
 *   · **没有调度器。** A plan does not run itself: the window is judged when
 *     somebody submits, and 「nextWindow」 is computed on every read (contract §2.2 —
 *     there is no 「next_run_at」 column). 「计划采集」 sounds like a cron job, and a
 *     card that does not say otherwise is a card that lies.
 *   · **停用不是删除。** Turning a plan off keeps every field; it only stops it
 *     from being selectable at submit time.
 */
/* P1-4 预估与实际的对账。
   为什么单独一张卡：estimateMinutes 的预估出现在上面的发起表单里，运营据此排期，
   而**从来没有人在核对它准不准**。这张卡把"当时说 4 分钟、实际跑了 40 分钟"摆出来。

   口径必须在卡上写明，否则读者会拿它当"采集器慢"的证据：
   · 实际耗时 = finished_at − submitted_at，是**墙钟**，含排队与站点冷却；
   · 预估只算页面读写。两者本来就不完全可比，所以卡上直接说出来。
   · 结论按**中位数**下（服务端算好），样本不足时会自带"不可信"提示。 */
function renderCollectAudit() {
  const box = $('collectAudit');
  if (box === null) return;
  const audit = (state.collectPanel || {}).estimateAudit || null;

  if (audit === null) {
    box.innerHTML = emptyState('not-recorded', {
      subject: '耗时对账数据',
      next: '采集页的载荷里没有 estimateAudit —— 交付时漏接了，这不是"还没有数据"。',
    });
    return;
  }

  if (audit.count === 0) {
    box.innerHTML = emptyState('not-recorded', {
      subject: '已完成的采集任务',
      next: '跑完一次采集之后，这里会显示预估与实际差多少 —— 现在没有可比的对象，所以谈不上准不准。',
    });
    return;
  }

  const pct = value => (value === null || value === undefined) ? '—' : (Math.round(value * 100) + '%');
  const ratio = value => (value === null || value === undefined) ? '—' : value.toFixed(2) + '×';

  const head = '<div class="hint" style="padding:0 0 6px">'
    + '实际耗时是墙钟时间（finished_at − submitted_at，含排队与站点冷却），预估只算页面读写 —— '
    + '两者本来就不完全可比，不要把它当成「采集器慢」的证据。</div>'
    + '<div class="bar" style="flex-wrap:wrap;border-bottom:1px solid var(--line)">'
    + '<span class="chip">可比 ' + audit.comparable + ' / ' + audit.count + ' 条</span>'
    + '<span class="chip ' + (audit.medianRatio !== null && audit.medianRatio > 1.25 ? 'warn' : (audit.medianRatio !== null && audit.medianRatio <= 1 ? 'ok' : '')) + '">'
    + '中位比值 ' + ratio(audit.medianRatio) + '</span>'
    + '<span class="chip">平均比值 ' + ratio(audit.meanRatio) + '</span>'
    + '<span class="chip">超预估 ' + pct(audit.overBudgetShare) + '</span>'
    + '</div>';

  const conclusion = '<div class="hint" style="padding:6px 0 0">' + escapeHtml(String(audit.conclusion)) + '</div>';

  /* 算不出来的那些，按原因归类计数 —— 不把它们并成一句"数据不足"。 */
  const reasons = Object.keys(audit.skipReasons || {});
  const skippedBlock = reasons.length === 0 ? '' : '<div class="hint" style="color:var(--dim)">'
    + '还有 ' + audit.skipped + ' 条算不出来：'
    + escapeHtml(reasons.map(key => audit.skipReasons[key] + ' 条 —— ' + key).join('；'))
    + '</div>';

  const comparable = (audit.rows || []).filter(row => row.reason === null);
  const table = comparable.length === 0 ? '' : '<table aria-label="预估与实际对照"><thead><tr>'
    + '<th>任务</th><th>目标</th><th>预估</th><th>实际</th><th>比值</th><th>相差</th></tr></thead><tbody>'
    + comparable.slice(0, 8).map(row => '<tr>'
      + '<td><code>' + escapeHtml(String(row.id || '').slice(0, 8)) + '</code></td>'
      + '<td>' + escapeHtml(String(row.targets)) + '</td>'
      + '<td>' + escapeHtml(String(row.estimatedMinutes)) + ' 分</td>'
      + '<td>' + escapeHtml(String(row.actualMinutes)) + ' 分</td>'
      + '<td>' + escapeHtml(ratio(row.ratio)) + '</td>'
      + '<td>' + (row.deltaMinutes > 0 ? '+' : '') + escapeHtml(String(row.deltaMinutes)) + ' 分</td>'
      + '</tr>').join('')
    + '</tbody></table>'
    + (comparable.length > 8 ? '<div class="hint">只列了前 8 条（共 ' + comparable.length + ' 条可比）。</div>' : '');

  box.innerHTML = head + conclusion + skippedBlock + table;
}

function renderCollectPlans() {
  const box = $('collectPlans');
  if (box === null) return;
  const panel = state.collectPanel || {};
  const plans = Array.isArray(panel.plans) ? panel.plans : [];

  if (plans.length === 0) {
    box.innerHTML = emptyState('not-recorded', {
      subject: '计划采集',
      reason: '还没有计划采集。计划 = 一组目标 + 六项配置（运行窗口 / 频率 / 上限 / 失败策略 / 冷却 / 暂停条件），'
        + '创建后默认关闭 —— 一个因为被建出来就开始跑的计划，是没人订阅过的订阅。',
      next: '在对话里说「把 ASIN 库里的这些目标做成每天 09:00–11:00 的计划」，或让 agent 调 amzn_collect_plan_save。',
    });
    return;
  }

  const cards = plans.map(plan => {
    const win = plan.window === null || plan.window === undefined ? null : plan.window;
    const next = plan.nextWindow === null || plan.nextWindow === undefined ? null : plan.nextWindow;
    /* 窗口那一行印**两件不同的事**：库里的时段（配置）与此刻的判定（读数）。把判定
       印成配置字段就是「窗口不入库」那条契约的反面 —— 读者会以为它是存下来的。 */
    const windowLine = win === null
      ? '<strong>不限</strong>（全天候可提交）'
      : escapeHtml(String(win.from)) + '–' + escapeHtml(String(win.to)) + '（' + escapeHtml(String(win.tz)) + '）'
        + (next === null
          ? ''
          : ' · 现在<strong>' + (next.openNow === true ? '开着' : '没开') + '</strong>'
            + ' <span class="k">（读时判定，不入库；判定于 ' + escapeHtml(String(next.localTime ?? '—'))
            + ' ' + escapeHtml(String(next.tz ?? '')) + '）</span>'
            + (next.tzUnknown === true ? ' <span class="hint" style="padding:0">时区名认不出来，按开着处理</span>' : ''));
    const interval = plan.intervalMinutes === null || plan.intervalMinutes === undefined
      ? '不重复（一次性）'
      : '每 ' + escapeHtml(String(plan.intervalMinutes)) + ' 分钟';
    const failure = Object.prototype.hasOwnProperty.call(PLAN_FAILURE, plan.failurePolicy)
      ? PLAN_FAILURE[plan.failurePolicy]
      : String(plan.failurePolicy ?? '—');
    const notify = Object.prototype.hasOwnProperty.call(PLAN_NOTIFY, plan.notify)
      ? PLAN_NOTIFY[plan.notify]
      : String(plan.notify ?? '—');
    const pause = plan.pauseCondition === null || plan.pauseCondition === undefined
      ? '无'
      : '<code>' + escapeHtml(JSON.stringify(plan.pauseCondition)) + '</code>';
    const scheme = plan.schemeId === null || plan.schemeId === undefined
      ? '未绑定（提交时选当前可用方案）'
      : escapeHtml(String(plan.schemeId)) + ' v' + escapeHtml(String(plan.schemeVersion ?? '?'));
    const targets = Array.isArray(plan.targets) ? plan.targets.length : 0;
    return '<div class="collect-item" data-plan="' + escapeHtml(String(plan.id)) + '">'
      + '<div class="head"><strong>' + escapeHtml(String(plan.name)) + '</strong> '
      + '<code>' + escapeHtml(String(plan.id)) + '</code> ' + collectPlanEnabledChip(plan.enabled)
      + ' <span class="chip">' + escapeHtml(plan.marketplace === null || plan.marketplace === undefined
        ? '所有站点' : String(plan.marketplace)) + '</span></div>'
      + '<div class="k">运行窗口：' + windowLine + '</div>'
      + '<div class="k">频率：' + interval
      + ' · 上限：' + escapeHtml(String(plan.maxObjects ?? '—')) + ' 个对象'
      + ' · 冷却：' + escapeHtml(String(plan.cooldownMinutes ?? '—')) + ' 分钟</div>'
      + '<div class="k">失败策略：' + escapeHtml(String(failure))
      + ' · 通知：' + escapeHtml(String(notify))
      + ' · 暂停条件：' + pause + '</div>'
      + '<div class="k">目标：' + escapeHtml(String(targets)) + ' 个 · 方案：' + scheme + '</div>'
      + '<div class="bar" style="border-bottom:none;padding:0">'
      + '<button data-plan-toggle="' + escapeHtml(String(plan.id)) + '">'
      + (plan.enabled === true ? '停用这个计划' : '启用这个计划') + '</button>'
      + '</div>'
      + '</div>';
  }).join('');

  box.innerHTML = '<div class="hint" style="padding:0">共 ' + escapeHtml(String(plans.length)) + ' 个计划。'
    + '<strong>本版没有调度器</strong>：计划不会自己跑，窗口在有人提交时判定，所以这里没有「下次运行时间」这一项'
    + '（它算不出来，也就没有存）。停用一个计划不会删掉它的任何配置。</div>'
    + (collectPlanNote === '' ? '' : collectPlanNote)
    + cards;

  for (const button of box.querySelectorAll('button[data-plan-toggle]')) {
    const plan = plans.find(entry => String(entry.id) === String(button.dataset.planToggle));
    if (plan === undefined) continue;
    button.onclick = () => collectPlanToggle(plan);
  }
}


/**
 * F04-07: the thirteen sections of one ASIN, on the right.
 *
 * Three states of this block, and they must not look alike:
 *   · no task selected  → say so, and say where to select one;
 *   · a task with no section rows → say that, and that it can be normal (a refused
 *     target writes nothing) rather than drawing an empty thirteen;
 *   · a task with rows  → the ASINs it recorded, and the sections of the clicked one.
 *
 * A section that was **never attempted** is not missing: missing is a claim
 * about the page ("Amazon has none"), and calling an unattempted section missing
 * is exactly the confusion this vocabulary exists to prevent. The server sends
 * status: null + notCollected: true for it, and it is drawn as 「未采集」.
 */
/* ── 「采集覆盖 vs 数据现状」对偶文案（设计 v3 §4.1 / T63 CR-3）────────────────
   R2-08：两处都叫「13 节」会被当成重复入口。对偶文案：采集器 = 任务视角（采没采到），
   ASIN 详情 = 数据视角（现在有什么）。文案**逐字**来自设计稿 §4.1 的表：
     采集器右栏 —— 标题「采集覆盖（13 节）」+ 副行 +「去 ASIN 详情看数据 →」；
     ASIN 13 节 —— note +「去采集器看任务 →」；页头各一句另见 collectHint /
     renderAsinPortfolio（那是 §4.1 第三行，不塞进这两块，一页不放两遍）。
   改词先改设计稿再回写。节名表保持单源（服务端 COLLECTION_SECTIONS /
   SECTION_STATUS），这里一个节名都不抄（§4.3 禁令 3）。
   互链只换模块（patchContext，与导航按钮同一机制）；不做「带 ASIN 深链到详情」——
   那要 selection 联动，本轮不做。 */
function dualCopyBlock(side) {
  if (side === 'collect') {
    /* 标题不在这块里 —— 采集右栏的列标题是 page.js 静态标记里的那个 h3，由
       renameCollectCardTitle 就地换字（见下），两处各留一个标题不会重复印。 */
    return '<div class="hint" style="padding:0">这是任务视角：哪些节采到、哪些失败、覆盖多少。数据值去 ASIN 详情看。</div>'
      + '<button type="button" data-dualgo="asin">去 ASIN 详情看数据 →</button>';
  }
  return '<div class="hint" style="padding:0">这里看当前数据与来源，不显示采集任务状态；任务覆盖去采集器看。</div>'
    + '<button type="button" data-dualgo="collect">去采集器看任务 →</button>';
}

/* 采集右栏的列标题在 page.js 的静态标记里（collectDetail 的前一个兄弟那个 h3，
   「13 节详情（F04-07）」）—— page.js 不在 T63 写域，这里按设计 §4.1 就地改名
   「采集覆盖（13 节）」。只认「前一个兄弟恰好是 H3」这一种形状，认不出就原样不动：
   不猜结构、不报错、不造第二个标题。page.js 写域放行后这一行应迁回标记里。 */
function renameCollectCardTitle(box) {
  const title = box.previousElementSibling;
  if (!title || title.tagName !== 'H3') return;
  title.textContent = '采集覆盖（13 节）';
}

function bindDualGoButtons(root) {
  for (const button of root.querySelectorAll('button[data-dualgo]')) {
    button.onclick = () => patchContext({ module: button.dataset.dualgo, filters: { ...state.filters } });
  }
}

function renderCollectDetail() {
  const box = $('collectDetail');
  if (box === null) return;
  renameCollectCardTitle(box);
  const panel = state.collectPanel || {};
  const selected = panel.selectedTask || null;

  if (selected === null) {
    box.innerHTML = dualCopyBlock('collect')
      + '<div class="hint" style="padding:0">在中间的任务列表里点一行，这里就展开它的逐 ASIN 进度；'
      + '再点一个 ASIN，展开那一个的 13 节。</div>';
    bindDualGoButtons(box);
    return;
  }

  const summaries = Array.isArray(selected.summaries) ? selected.summaries : [];
  const summariesCoverage = selected.summariesCoverage || {};
  const head = '<div class="hint" style="padding:0">任务 <code>' + escapeHtml(String(selected.taskId).slice(0, 8))
    + '</code> ' + statusChip(selected.status)
    + (selected.error === null || selected.error === undefined ? '' : ' <span class="hint" style="color:var(--warn)">' + escapeHtml(String(selected.error)) + '</span>')
    + '</div>';

  if (summaries.length === 0) {
    box.innerHTML = dualCopyBlock('collect') + head + emptyState('not-recorded', {
      subject: '这个任务的节结果',
      reason: '这个任务还没有写出任何节结果。原因有两种，长得不一样：'
        + '任务还没跑到这个 ASIN；或者它被拒收了（站点/语言/币种不符的页面不写库）。',
      next: '用 amzn_collect_status 看逐目标结果码，那里会区分「没跑到」与「被拒收」。',
    });
    bindDualGoButtons(box);
    return;
  }

  const asinRows = summaries.map(entry => {
    const summary = entry.summary || {};
    const focused = collectFocus !== null && collectFocus.asin === entry.asin && collectFocus.marketplace === entry.marketplace;
    return '<div class="collect-sect' + (focused ? ' sel' : '') + '" data-collect-asin="' + escapeHtml(entry.asin + '|' + entry.marketplace) + '">'
      + '<span class="ord">' + (focused ? '▾' : '▸') + '</span>'
      + '<span class="name"><code>' + escapeHtml(entry.asin) + '</code> ' + escapeHtml(entry.marketplace) + '</span>'
      + '<span class="counts">' + collectSummaryText(summary) + '</span>'
      + '</div>';
  }).join('');

  box.innerHTML = dualCopyBlock('collect') + head
    + (summariesCoverage.truncated === true
      /* 「记下了 N 个」是对**任务**说的，而被截断的读只能支持「前 5000 行里记下了 N 个」。
         不把上限说出来，落在上限之外的 ASIN 看起来就像这个任务从没采过它们。 */
      ? '<div class="asin-problem"><strong>读被截断</strong>：' + escapeHtml(String(summariesCoverage.note ?? ''))
        + ' —— 下面的 ASIN 列表可能不全，「不在列表里」不等于「没采过」。</div>'
      : '')
    + '<div class="hint" style="padding:0">这个任务记下了 ' + escapeHtml(String(summaries.length)) + ' 个 ASIN（点开看 13 节）</div>'
    + asinRows
    + renderCollectSections();
  bindDualGoButtons(box);
}

/** "已采 11 · 没有 0 · 部分 1 · 失败 0 · 拦截 1" — the five counts, named. */
function collectSummaryText(summary) {
  const parts = [];
  for (const state of ['collected', 'missing', 'partial', 'failed', 'blocked']) {
    const count = Number(summary[state] ?? 0);
    if (count === 0) continue;
    const label = Object.prototype.hasOwnProperty.call(SECTION_STATUS, state) ? SECTION_STATUS[state][0] : state;
    parts.push(label + ' ' + count);
  }
  return escapeHtml(parts.length === 0 ? '没有节结果' : parts.join(' · '));
}

/** The thirteen rows of the focused ASIN, or the reason there are none. */
function renderCollectSections() {
  if (collectFocus === null) return '';
  if (collectSectionsError !== null) {
    return '<div class="hint" style="color:var(--warn);padding:0">' + escapeHtml(collectSectionsError) + '</div>';
  }
  const payload = collectSections;
  if (payload === null) return '<div class="hint" style="padding:0">正在读 ' + escapeHtml(collectFocus.asin) + ' 的节…</div>';

  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  const summary = payload.summary || {};
  const unattempted = sections.filter(entry => entry.notCollected === true).length;
  const head = '<div class="hint" style="padding:0"><code>' + escapeHtml(String(payload.asin)) + '</code> @ '
    + escapeHtml(String(payload.marketplace)) + ' · ' + escapeHtml(collectSummaryText(summary))
    + (unattempted === 0 ? '' : ' · <strong>未采集 ' + escapeHtml(String(unattempted)) + ' 节</strong>（那不是「页面没有」）')
    + (payload.truncated === true ? ' · <span style="color:var(--warn)">有节因超过 64 KB 被截断</span>' : '')
    + (payload.hiddenSections === undefined || payload.hiddenSections === 0
      ? '' : ' · 另有 ' + escapeHtml(String(payload.hiddenSections)) + ' 节不在筛选里')
    + ' <button type="button" data-open-asin="'
    + escapeHtml(String(payload.asin) + '|' + String(payload.marketplace)) + '">打开 ASIN 详情</button>'
    + '</div>';

  const rows = sections.map(entry => {
    /* A section whose count is 0/0 is a dynamic one (attributes) that carried no keys
       at all — printing the fraction would read as "0 of 0 = complete", which is the
       exact misreading sectionValueCounts is written to prevent on the server. The
       page says it in words instead of inventing a number. */
    /* 与 ASIN 详情区同一条纪律：「子体没读到」与「页面只给了一部分」不能都只说 partial。
       判据只有一份（服务端 sectionContentUnread），随 B-04 的载荷带下来；页面读它，
       不自己从 errors_json / child_tiles 重算 —— 重算就是第二份实现，两边分歧时
       不会有任何断言红。 */
    const unreadMark = sectionContentUnreadMark(entry);
    const counts = entry.notCollected === true
      ? ''
      : (entry.total === 0
        ? '<span class="counts">无字段可计</span>'
        : '<span class="counts">' + escapeHtml(String(entry.collected)) + '/' + escapeHtml(String(entry.total))
          + (Array.isArray(entry.missingFields) && entry.missingFields.length > 0
            ? ' 缺 ' + escapeHtml(entry.missingFields.slice(0, 4).join(' ')) : '') + '</span>');
    const chip = entry.notCollected === true
      ? '<span class="chip">未采集</span>'
      : sectionChip(entry.status) + unreadMark;
    const diff = entry.diff === null || entry.diff === undefined ? '' : collectDiffText(entry.diff);
    /* T53：采集页只保留状态 / 失败原因 / 次数；完整内容与 raw 已移出。
       请求数与逐节耗时在本仓没有来源，写「未记录」而不是 0。 */
    const reason = Array.isArray(entry.errors) && entry.errors.length > 0
      ? '<span class="collect-diff">失败原因 '
        + escapeHtml(entry.errors.map(error => (typeof error === 'string' ? error
          : (error?.message ?? JSON.stringify(error)))).join('；')) + '</span>'
      : '';
    const attempts = entry.taskCount === undefined || entry.taskCount === null
      ? ''
      : '<span class="hint" style="padding:0">尝试 ' + escapeHtml(String(entry.taskCount)) + ' 次</span>';
    return '<div class="collect-sect" data-collect-section="' + escapeHtml(entry.section) + '">'
      + '<span class="ord">' + escapeHtml(String(entry.order)) + '</span>'
      + '<span class="name">' + escapeHtml(entry.label) + '<br><code>' + escapeHtml(entry.section) + '</code></span>'
      + '<span>' + chip + ' ' + counts + (diff === '' ? '' : '<br><span class="collect-diff">' + diff + '</span>') + '</span>'
      + '<span class="collect-sect-meta">' + attempts
      + '<span class="hint" style="padding:0">请求数 未记录 · 耗时 未记录</span></span>'
      + (reason === '' ? '' : '<span>' + reason + '</span>')
      + '</div>';
  }).join('');

  return head + rows;
}

/** "与快照 #1031 比：变 price；新增 —；消失 —". */
function collectDiffText(diff) {
  const list = values => (Array.isArray(values) && values.length > 0 ? values.join(' ') : '—');
  return '与快照 #' + escapeHtml(String(diff.previousSnapshotId ?? '?'))
    + ' 比：变 ' + escapeHtml(list(diff.changed))
    + '；新增 ' + escapeHtml(list(diff.added))
    + '；消失 ' + escapeHtml(list(diff.removed));
}

/**
 * T53: the expanded body/raw reader was removed from the collect page.
 *
 * The collect page is a status board: target ASIN, per-section status, failure
 * reason, attempts and the link to ASIN detail. Full parsed values and raw
 * readings live on the ASIN detail page; keeping a second reader here made the
 * page depend on collectOpenOne / collectRawCache that were declared in this
 * (asin) chunk — the boundary this task fixes.
 */

/** Click a task row: make it the selected task and drop the previous ASIN. */
function collectSelectTask(taskId) {
  const current = String((state.filters || {}).taskId ?? '');
  if (current === String(taskId)) return;
  collectFocus = null;
  collectSections = null;
  collectSectionsError = null;
  patchContext({ filters: { ...(state.filters || {}), taskId: String(taskId) } });
}

/** Click an ASIN: read its thirteen sections (one ASIN, never the whole task). */
async function collectSelectAsin(taskId, asin, marketplace) {
  collectFocus = { taskId: String(taskId), asin: String(asin), marketplace: String(marketplace) };
  collectSections = null;
  collectSectionsError = null;
  renderCollectDetail();
  try {
    const query = 'sections?taskId=' + encodeURIComponent(taskId) + '&asin=' + encodeURIComponent(asin)
      + '&marketplace=' + encodeURIComponent(marketplace);
    collectSections = await api(query);
  } catch (error) {
    collectSections = null;
    collectSectionsError = '读不到这个 ASIN 的节：' + String(error.message || error);
  }
  renderCollectDetail();
}

/* ── 产品表导入（赛狐）─────────────────────────────────────────────
   T53：ASIN 页不再承载产品档案导入。产品表（店铺 + 品牌 + 父 ASIN + ASIN）
   属于「店铺」页；这里只留一个明确的入口，避免两处入口各自解释一遍四段校验。 */
let piState = { dir: null, exists: null, files: [], preview: null, brand: '', note: '' };
let piBootstrapped = false;

function renderProductImport() {
  const box = $('prodimport');
  if (box === null) return;
  box.innerHTML = '<div class="b05c-card">'
    + '<strong>产品表导入已移到「店铺」页</strong>'
    + '<div class="hint" style="padding:0">这里只展示已入库的 ASIN；店铺 / 品牌 / 父 ASIN 的产品档案与导入预览在「店铺」页维护。'
    + '本页不再提供第二个入口，以免同一个四段校验有两份解释。</div>'
    + '<div class="bar" style="margin-top:6px"><button type="button" id="piGoShops">去店铺页导入</button></div>'
    + '</div>';
  const go = $('piGoShops');
  if (go !== null) go.onclick = () => patchContext({ module: 'shops' });
}


/** One entry point for the panel's blocks, so a new block cannot be forgotten. */`
