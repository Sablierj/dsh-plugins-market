/**
 * 页签「quality」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 <script> 作用域，拆的是文件不是作用域。
 */
export const qualityScript = `function renderQuality() {
  const data = state.quality;
  if (!data) {
    for (const id of ['qtabs', 'qcatalog', 'qcockpit', 'qlineage', 'qsnapshot', 'qconflicts', 'qaudit', 'qpending']) {
      if ($(id) !== null) $(id).innerHTML = '';
    }
    return;
  }

  /* 第二份默认值：服务端总会下发 tab，这里只是兜底。兜底值必须与 routes 的默认一致，
     否则两处一旦漂开，页面高亮一个 tab、内容画另一个。 */
  const tab = data.tab || 'cockpit';
  $('qtabs').innerHTML = QUALITY_TAB_LABELS.map(([id, label]) => {
    const pending = data.pendingTabs ? data.pendingTabs[id] : null;
    return '<button class="qtab" role="tab" aria-selected="' + (id === tab ? 'true' : 'false')
      + '" data-qtab="' + escapeHtml(id) + '">' + escapeHtml(label)
      + (pending ? ' <span class="opt-meta">' + escapeHtml(pending) + '</span>' : '')
      + '</button>';
  }).join('');

  /* Each view is drawn only when it is the active one, and the other boxes are
     emptied rather than left holding the previous tab's markup: a stale table
     under an active tab is a number the reader will believe. */
  $('qcatalog').innerHTML = tab === 'catalog' ? qualityCatalogHtml(data.catalog) : '';
  $('qlineage').innerHTML = tab === 'lineage' ? qualityLineageHtml(data.lineage) : '';
  /* The cockpit is the second view that wires controls (filters and the status
     buttons), so it draws into its box and is wired immediately after — the same
     split as the snapshot view, one line up. */
  $('qcockpit').innerHTML = tab === 'cockpit' ? qualityCockpitHtml(data.cockpit) : '';
  if (tab === 'cockpit') wireQualityCockpit();
  /* The snapshot view is the one view that owns its own inner markup (it has
     controls to wire), so it draws into its box rather than being interpolated
     into a string. Its slice is a sibling of the quality slice, not a field of
     it. */
  $('qsnapshot').innerHTML = '';
  if (tab === 'snapshot') renderSnapshots($('qsnapshot'));
  /* The conflict workbench is a second view that owns its own inner markup (its
     rows carry buttons), so it draws into its box the same way the snapshot view
     does — never into panel-quality, which belongs to the tab container. */
  $('qconflicts').innerHTML = '';
  if (tab === 'conflicts') renderConflicts($('qconflicts'));
  /* The audit view is the sixth tab, and it owns its own inner markup (it has
     filters to wire), so it draws into its box the same way the snapshot and
     conflict views do — never into panel-quality, which belongs to the tab
     container. */
  $('qaudit').innerHTML = '';
  if (tab === 'audit') renderAudit($('qaudit'));
  /* "Not built yet" is read off the payload, not off a list written here.
     The page is one template literal with no build step, so a list of built
     views kept in it is a promise nothing updates: the moment a view ships,
     the page goes on claiming it is missing until somebody remembers to edit
     this file. The payload's pendingTabs is the server's answer to "which tab
     has nothing behind it", and it is empty today because all six are built —
     which is why this box draws nothing, not because the mechanism was
     removed. */
  const pendingFor = (data.pendingTabs || {})[tab];
  $('qpending').innerHTML = pendingFor
    ? '<div class="empty" data-slice-missing="pending-tab">这个视图还没建（' + escapeHtml(String(pendingFor))
      + '）。<strong>不是「没有问题」</strong>：空表会说一件它不知道的事，所以这里什么都不画，只说清楚缺什么。</div>'
    : '';

  for (const button of $('qtabs').querySelectorAll('.qtab[data-qtab]')) {
    button.onclick = () => patchContext({ filters: { ...state.filters, qualityTab: button.dataset.qtab } });
  }
}

/* The catalogue, three levels deep: asset type, dataset, field. Every dataset
   prints all nine declared attributes — a card that showed only the row count
   would be a number with no grain, and "412 rows" means one thing per ASIN and
   another per collection run.

   A row count of null is drawn as an em dash and labelled, never as 0: "this
   table cannot be read" and "this table is empty" are different, and the second
   is the one that looks like a data problem.

   NB: no backticks in this comment either. */
function qualityCatalogHtml(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    return '<div class="empty" data-slice-missing="catalog">目录里没有任何资产类型 —— 这是页面出了问题，不是库里没有数据。</div>';
  }
  return catalog.map(asset => {
    const body = (asset.datasets || []).length === 0
      ? '<div class="empty" style="padding:8px 0">这个资产类型下还没有数据集</div>'
      : (asset.datasets || []).map(dataset => {
        const ns = dataset.nullSemantics || {};
        const rowCount = dataset.rowCount === null || dataset.rowCount === undefined
          ? '<span class="chip warn" title="表读不出来">行数 —</span>'
          : '<span class="chip">' + dataset.rowCount + ' ' + escapeHtml(String(dataset.unit || '行')) + '</span>';
        const fresh = dataset.freshnessClass === null || dataset.freshnessClass === undefined
          ? '<span class="chip" title="没有源给它定阈值">无阈值</span>'
          : '<span class="chip">' + dataset.freshnessClass + ' 天</span>';
        return '<div class="qdataset" data-dataset="' + escapeHtml(dataset.id) + '">'
          + '<div class="cardhead"><span>' + escapeHtml(dataset.label)
            + '</span><span class="opt-meta">' + escapeHtml(String(dataset.table || '')) + '</span></div>'
          + '<div class="qfacts">' + rowCount + fresh
            + '<span class="chip">主键 ' + escapeHtml((dataset.primaryKey || []).join(' + ')) + '</span>'
            + '<span class="chip">责任 ' + escapeHtml(String(dataset.ownerRole || '')) + '</span>'
            + '<span class="chip">来源 ' + escapeHtml((dataset.sources || []).join(' / ')) + '</span>'
            + '<span class="chip">下游 ' + escapeHtml((dataset.downstream || []).join(' / ')) + '</span></div>'
          + '<div class="opt-meta">空值含义 <strong>' + escapeHtml(String(ns.state || '')) + '</strong>：'
            + escapeHtml(String(ns.note || '')) + '</div>'
          + '<div class="opt-meta">粒度 ' + escapeHtml(String(dataset.grain || '')) + '</div>'
          + '<div class="qfacts">' + (dataset.fields || []).map(field => {
            const own = ns.fields && Object.prototype.hasOwnProperty.call(ns.fields, field)
              ? ns.fields[field]
              : null;
            return '<span class="qfield"'
              + (own === null ? '' : ' title="这个字段自己的空值含义：' + escapeHtml(own) + '"')
              + '>' + escapeHtml(field) + (own === null ? '' : ' · ' + escapeHtml(own)) + '</span>';
          }).join('') + '</div>'
          + '</div>';
      }).join('');
    return '<div class="qasset"><div class="rule-sect" style="border-top:0;padding-left:0">'
      + escapeHtml(asset.label) + ' <span class="opt-meta">' + escapeHtml(String(asset.id)) + '</span></div>'
      + body + '</div>';
  }).join('');
}

/* The four words for the four lineage states, **shared by the two views that print them**:
   the quality panel's field-lineage chain (模块 03) and the ASIN detail's field facts
   (模块 05). The ids come from domain/data/lineage.js; the words are the page's, so they
   live here — but a second copy would drift, and the drift would be silent: one view would
   say 「从未采集」 while the other said something else about the same row.

   NB: no backticks in this comment either. */
const LINEAGE_STATE_LABELS = {
  present: '有值可追',
  never_collected: '从未采集',
  not_on_page: '页面没有此字段',
  failed: '源报了，解析失败',
};

/* One selected ASIN's seven traced fields.

   The four-hop chain is drawn as written by the domain — the page does not
   re-derive a state or invent a hop. "We have a value and no snapshot" and "we
   have a snapshot and no value" are the two problems this view exists to tell
   apart, so the chain shows where it stopped, in order, rather than a single
   line from the value to the source.

   NB: no backticks in this comment either. */
function qualityLineageHtml(lineage) {
  if (lineage === null || lineage === undefined) {
    return '<div class="empty">先在上面选一个 ASIN —— 没有选中的商品时，这个视图不画七条空链：'
      + '七条「未采集」会说成「这个商品的来源全都不明」，而事实是我们还没看哪个商品。</div>';
  }
  return '<div class="qasset"><div class="rule-sect" style="border-top:0;padding-left:0">'
    + escapeHtml(lineage.asin) + ' <span class="opt-meta">' + escapeHtml(lineage.marketplace) + '</span></div>'
    + (lineage.fields || []).map(field => {
      const state = String(field.state);
      const cls = state === 'present' ? 'present' : 'absent';
      const hops = (field.hops || []).map(hop => {
        const at = hop.at === null || hop.at === undefined ? '时间未记录' : String(hop.at).slice(0, 19).replace('T', ' ');
        const detail = hop.kind === 'value'
          ? (hop.detail === null || hop.detail === undefined ? '值未记录' : String(hop.detail))
          : (hop.kind === 'field_source'
            ? '来源 ' + String(hop.ref)
              + (hop.observedAt === null ? ' · 观测时间未记录' : ' · 观测于 ' + String(hop.observedAt).slice(0, 19).replace('T', ' '))
              + (hop.detail && hop.detail.sourceType ? ' · ' + String(hop.detail.sourceType) : '')
              + (hop.detail && hop.detail.rawValue ? ' · 原始 ' + String(hop.detail.rawValue) : '')
            : String(hop.ref));
        return '<div class="qhop ' + cls + '">' + hop.step + '. ' + escapeHtml(hop.label)
          + ' <span class="opt-meta">' + escapeHtml(at) + '</span><br>'
          + escapeHtml(detail) + '</div>';
      }).join('');
      return '<div class="qdataset" data-field="' + escapeHtml(field.field) + '">'
        + '<div class="cardhead"><span>' + escapeHtml(field.field) + '</span>'
        + '<span class="chip ' + cls + '">' + escapeHtml(LINEAGE_STATE_LABELS[state] || state) + '</span></div>'
        + hops + '</div>';
    }).join('') + '</div>';
}

/* ── the quality cockpit (S1-B09, 模块 03 数据资产与质量) ──────────────────── */

/* The cockpit, one of the six tabs of the quality panel. It draws into the box
   its caller hands it (qcockpit) rather than replacing the panel, for the same
   reason the snapshot view does: the panel belongs to the tab container, and a
   view that owned it would take the other five tabs down with it.

   Two things this view refuses to do, both of which would look plausible:

     1. It does not own a second copy of the state machine. The legal moves come
        from the payload (the domain's DQ_ISSUE_TRANSITIONS), so a status change
        the store would refuse is never offered as a button. A dropdown of all
        five statuses would let the user walk into the refusal instead.
     2. It does not draw an empty table for "not built" or "not scanned". An
        empty table reads as "there are no problems", which is a claim about the
        data; "we have not looked" is a different sentence and is written out.

   Labels live here, the ids live in the domain — the same split as
   QUALITY_TAB_LABELS and TODO_BUCKET_LABELS.

   NB: no backticks anywhere in this block — the whole file is one template
   literal, and a backtick in a comment ends it. */
const QUALITY_STATUS_LABELS = {
  open: '待处理',
  acknowledged: '已确认',
  fixing: '修复中',
  resolved: '已解决',
  accepted_risk: '接受风险',
};

const QUALITY_SEVERITY_LABELS = { block: '阻断', warn: '警告', info: '提示' };

function qualityCockpitHtml(cockpit) {
  if (cockpit === null || cockpit === undefined) {
    return '<div class="empty">质量驾驶舱未就绪（模块切换中）。</div>';
  }
  const issues = cockpit.issues || [];
  const stats = cockpit.stats || {};
  const labels = cockpit.dimensionLabels || {};
  const transitions = cockpit.transitions || {};
  const filters = cockpit.filters || {};
  const bySeverity = stats.bySeverity || {};
  const byDimension = stats.byDimension || {};

  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + '">'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + '</span>';

  /* The counts bar names every severity and every dimension, including the ones
     at zero, so an empty band says "0 of that kind" instead of looking forgotten.
     Severity is the consequence, dimension is the kind — both are shown because
     "what is wrong" and "how bad" are the two questions the list is read for. */
  const head = '<div class="rule-sect" style="border-top:none">质量驾驶舱（七维度问题清单）</div>'
    + '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('库内共', stats.total ?? 0)
    + (cockpit.severities || []).map(level => chip(
      QUALITY_SEVERITY_LABELS[level] || level,
      bySeverity[level] ?? 0,
      level === 'info' ? '' : 'warn',
    )).join('')
    + '</div>'
    + '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + (cockpit.dimensions || []).map(dimension => chip(
      labels[dimension] || dimension,
      byDimension[dimension] ?? 0,
    )).join('')
    + '</div>';

  const option = (value, label, current) => '<option value="' + escapeHtml(value) + '"'
    + (value === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';

  const controls = '<div class="bar">'
    + '<select id="dqStatus"><option value="">全部状态</option>'
    + (cockpit.statuses || []).map(status => option(status, QUALITY_STATUS_LABELS[status] || status, filters.status)).join('')
    + '</select>'
    + '<select id="dqSeverity"><option value="">全部严重级</option>'
    + (cockpit.severities || []).map(level => option(level, QUALITY_SEVERITY_LABELS[level] || level, filters.severity)).join('')
    + '</select>'
    + '<select id="dqDimension"><option value="">全部维度</option>'
    + (cockpit.dimensions || []).map(dimension => option(dimension, labels[dimension] || dimension, filters.dimension)).join('')
    + '</select>'
    + '</div>';

  const rowHtml = issue => {
    const level = QUALITY_SEVERITY_LABELS[issue.severity] || issue.severity;
    const status = QUALITY_STATUS_LABELS[issue.status] || issue.status;
    const dimension = labels[issue.dimension] || issue.dimension;
    /* Only the edges the machine has. A terminal state offers none, and says so
       rather than drawing a disabled control the reader would wait on. */
    const nexts = transitions[issue.status] || [];
    const actions = nexts.length === 0
      ? '<span class="chip">终态</span>'
      : nexts.map(to => '<button data-dqmove="' + escapeHtml(issue.id) + '" data-dqto="' + escapeHtml(to)
        + '">' + escapeHtml(QUALITY_STATUS_LABELS[to] || to) + '</button>').join(' ');
    return '<tr>'
      + '<td><span class="chip ' + (issue.severity === 'info' ? '' : 'warn') + '">' + escapeHtml(level) + '</span></td>'
      + '<td>' + escapeHtml(dimension) + '</td>'
      + '<td><code>' + escapeHtml(issue.ruleId) + '</code></td>'
      + '<td title="' + escapeHtml(issue.objectId) + '">' + escapeHtml(issue.objectType + ':' + shortId(issue.objectId))
      + (issue.field === null || issue.field === undefined ? '' : '#' + escapeHtml(issue.field)) + '</td>'
      + '<td>' + escapeHtml(issue.message) + '</td>'
      + '<td><span class="chip">' + escapeHtml(status) + '</span></td>'
      + '<td>' + actions + '</td>'
      + '</tr>';
  };

  let body;
  if (issues.length === 0) {
    const narrowed = Boolean(filters.status || filters.severity || filters.dimension);
    /* allowMarkup：静态文案，保留「还没扫过 ≠ 数据干净」那处强调。 */
    body = narrowed
      ? emptyState('filtered', {
        subject: '质量问题',
        reason: '这个筛选条件下没有问题。库内共 ' + (stats.total ?? 0)
          + ' 条 —— 放宽条件再试，不要把它读成「数据没问题」。',
      })
      : emptyState('not-recorded', {
        subject: '质量问题',
        reason: '库内还没有质量问题。它由扫描产生（amzn_dq_scan，或采集之后的那一次）—— '
          + '<strong>「还没扫过」不是「数据干净」</strong>，这两件事在这里分开说。',
        allowMarkup: true,
      });
  } else {
    body = '<div id="dqtable"><table><thead><tr><th>严重级</th><th>维度</th><th>规则</th>'
      + '<th>对象</th><th>说明</th><th>状态</th><th>流转</th></tr></thead><tbody>'
      + issues.map(rowHtml).join('')
      + '</tbody></table></div>';
  }

  return head + controls + body
    + '<div class="hint">七个维度是<strong>分类</strong>（为什么坏），严重级是<strong>后果</strong>（有多坏）：'
    + '同一条「价格缺失」是<strong>完整</strong>维度、严重级可能只是<strong>警告</strong>，两件事不能合成一列。<br>'
    + '状态只能沿状态机允许的边移动（待处理 → 已确认 → 修复中 → 已解决 / 接受风险），'
    + '按钮就是那几条边；非法迁移由服务端拒绝，页面上根本不提供。<br>'
    + '过期的 <code>DQ-FRESH-*</code> 与<strong>优化前置检查</strong>用同一张时效表（7 / 30 / 90 天）：本页只产出问题，不在这里阻断；'
    + '阻断发生在 <code>amzn_optimize_precheck</code> 的九项门槛里，那一侧按同一张表自己判，不读这里的行。<br>'
    + '时效阈值只读引用规则口径基线（7 / 30 / 90 天），不新增档位，也不可配置。</div>';
}

/* The controls are wired after the markup exists, the same way the snapshot
   view does it: a pure builder returns a string, and the handlers are attached
   to the elements that string just created. */
function wireQualityCockpit() {
  const box = $('qcockpit');
  if (box === null) return;
  const setFilter = (id, key) => {
    const control = $(id);
    if (control === null) return;
    control.onchange = event => patchContext({ filters: { ...state.filters, [key]: event.target.value } });
  };
  setFilter('dqStatus', 'dqStatus');
  setFilter('dqSeverity', 'dqSeverity');
  setFilter('dqDimension', 'dqDimension');
  for (const button of box.querySelectorAll('button[data-dqmove]')) {
    button.onclick = () => moveDqIssue(button.dataset.dqmove, button.dataset.dqto);
  }
}

/* Moving one issue along the state machine. The reply is not patched into the
   table by hand: the list is re-read, so the row, the counts bar and the store
   cannot disagree about how many issues are in which state. */
async function moveDqIssue(id, to) {
  try {
    await api('dq-issue', { method: 'POST', body: JSON.stringify({ id, to }) });
    await refresh();
  } catch (error) {
    showPageError(error);
  }
}

/* ── the snapshot registry (B11, 模块 03 数据资产与质量) ───────────────────── */

/* The snapshot view — one of the six tabs of the quality panel, drawn into the
   box its caller hands it (qsnapshot) rather than replacing the panel: the
   panel is the tab container's, and a view that owned it would take the other
   five tabs down with it.

   It carries the whole job the batch exists for: list every versioned object,
   show a FIELD-LEVEL diff against the previous version (never a "有变化"
   one-liner), hide archived versions by default while keeping them resolvable by
   id, and say out loud that the context package is not wired up yet rather than
   hiding the category.

   The tab vocabulary and the per-type counts come from the server
   (state.snapshots), so this script does not own a second list of object types
   — a type added server-side shows up here without editing the page. */
function renderSnapshots(panel) {
  if (panel === null || panel === undefined) return;
  const data = state.snapshots;
  if (!data) { panel.innerHTML = '<div class="empty">快照清单未就绪（模块切换中）。</div>'; return; }

  const counts = data.counts || {};
  const activeType = data.filters.type || '';
  /* The referrer map comes from the retention slice (S1-B19): id -> {referenced,
     referrers}. It is the reason the delete button can be disabled here instead
     of failing after the click. Absent (the slice is null) the view simply does
     not annotate — the store still refuses a referenced delete, this is only the
     page declining to offer a button it knows will not work. */
  const retention = state.retention || null;
  const refById = (retention && retention.byId) ? retention.byId : {};
  const refFor = id => refById[id] || { referenced: false, referrers: [] };
  const refNames = referrers => referrers.map(r => r.label + ' ' + r.id).join('、');
  /* The type labels come from the server vocabulary, so the page never owns a
     second copy of which types exist or what they are called. */
  const labelFor = Object.fromEntries(data.objectTypes.map(type => [type.id, type.label]));
  /* Which types are actually wired comes from the server vocabulary, not a
     sentence typed here: adding a type to SNAPSHOT_OBJECT_TYPES must move this
     count and this list with it. The old hard-coded 「其余六类（…）」 went stale the
     moment B-11.2b added the prompt type — it was seven. */
  const wiredTypes = data.objectTypes.filter(type => !type.pending);
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + '">'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + '</span>';

  const options = data.objectTypes.map(type =>
    '<option value="' + escapeHtml(type.id) + '"' + (type.id === activeType ? ' selected' : '') + '>'
    + escapeHtml(type.label) + (type.pending ? '（本版不登记行）' : '')
    + '</option>').join('');

  /* The counts bar names every type, including the one with zero rows, so an
     empty tab says "0 of that kind" instead of looking forgotten. */
  const stats = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('库内共', counts.total ?? 0)
    + data.objectTypes.map(type => chip(
      type.label,
      type.pending ? '不登记' : (counts[type.id] ?? 0),
      type.pending ? 'warn' : (counts[type.id] ? 'ok' : ''),
    )).join('')
    + '</div>';

  /* 待登记类别的说明来自**服务端 payload**（objectTypes[].pendingReason），不是在这里
     再写一句 —— 一句事实活在两个文件里就是漂移的开始。没有待登记类别时这段整体不出现。 */
  const pendingTypes = data.objectTypes.filter(type => type.pending);
  const pendingLine = pendingTypes.length === 0 ? ''
    : '<div class="hint">本版<b>不登记行</b>的类别：'
      + pendingTypes.map(type => escapeHtml(type.label) + '（<code>' + escapeHtml(type.id) + '</code>）'
        + (type.pendingReason ? '：' + escapeHtml(type.pendingReason) : '（没有写理由）')).join('；')
      + '。其余 ' + wiredTypes.length + ' 类（'
      + wiredTypes.map(type => escapeHtml(type.label)).join(' / ') + '）已可用。</div>';

  /* The retention coverage, written from the slice rather than claimed: how many
     visible versions something still points at, and which object types have no
     referrer at all. A reader who assumes every type is guarded learns otherwise
     here instead of from a delete that quietly worked. */
  const summary = (retention && retention.summary) ? retention.summary : null;
  const retentionLine = summary
    ? '<div class="hint">留存检查：可见 ' + escapeHtml(String(summary.active)) + ' 条，其中 <b>'
      + escapeHtml(String(summary.referenced)) + '</b> 条被引用（删除会被拒绝，并列出引用者），<b>'
      + escapeHtml(String(summary.deletable)) + '</b> 条可删，'
      + escapeHtml(String(summary.deleted)) + ' 条已隐藏。<br>'
      + '登记了引用者的类型：' + (summary.referencedTypes.length > 0
        ? escapeHtml(summary.referencedTypes.join(' / ')) : '（无）')
      + '；其余 ' + escapeHtml(String(summary.unreferencedTypes.length))
      + ' 类暂无引用者 —— 对它们删除一律放行，这不是「都检查过了」。</div>'
    : '';

  panel.innerHTML =
    '<div class="rule-sect" style="border-top:none">快照登记（版本化对象的统一索引）</div>'
    + '<div class="bar">'
    + '<select id="snapType"><option value="">全部类型</option>' + options + '</select>'
    + '<input type="search" id="snapObjectId" placeholder="按对象 id 筛，如 B0XXXXXXX / 2026.4">'
    + '<label class="hint" style="padding:0"><input type="checkbox" id="snapArchived"' + (data.filters.includeArchived ? ' checked' : '') + '> 含已归档</label>'
    + '<span class="hint" id="snapHint" style="padding:0"></span>'
    + '</div>'
    + stats
    + '<div id="snaptable"></div>'
    + retentionLine
    /* The one honest line the acceptance criterion asks for: a declared type this
       version registers no row for says why. The why comes from the server payload
       (objectTypes[].pendingReason, sourced from SNAPSHOT_PENDING_REASONS), not
       from a sentence typed here — one fact living in two files is the drift this
       project keeps recording. */
    + pendingLine
    + '<div class="hint">'
    + '快照是<strong>索引，不是副本</strong>：正文仍在其原表（<code>ref_table</code>/<code>ref_id</code> 指针），'
    + '只有可变对象（竞品组、总库）另冻一份副本。<br>'
    + '<strong>归档</strong>只把版本从默认视图隐藏，不删任何东西 —— 按 id 仍可解析，历史引用不断；'
    + '<strong>删除</strong>同样是隐藏（同一个 <code>archived_at</code>），但先查引用：'
    + '还有东西指着这一版时它<strong>拒绝并列出引用者</strong>，这时可以改点「归档」，或先解除引用。</div>';

  $('snapType').onchange = event => patchContext({ filters: { ...state.filters, snapshotType: event.target.value } });
  $('snapObjectId').onchange = event => patchContext({ filters: { ...state.filters, snapshotObjectId: event.target.value } });
  $('snapArchived').onchange = event => patchContext({ filters: { ...state.filters, snapshotArchived: event.target.checked ? 'true' : '' } });

  const filtered = data.rows.length !== data.total;
  if (data.rows.length === 0) {
    $('snaptable').innerHTML = data.total === 0
      ? emptyState('not-recorded', {
        subject: '快照',
        next: '跑一次采集（产生 Listing 快照）或一次优化（登记草案）之后，这里才会有东西。',
      })
      : emptyState('filtered', {
        subject: '快照',
        reason: '这个筛选条件下没有快照。放宽条件再试 —— 不要把它读成「库里没有快照」：库内共 '
          + data.total + ' 条。',
      });
    return;
  }

  const rowHtml = row => {
    const label = labelFor[row.objectType] || row.objectType;
    const readable = row.readable
      ? (row.payload !== null ? '<span class="chip ok">副本</span>' : '<span class="chip ok">指针</span>')
      : '<span class="chip warn">取不回</span>';

    /* The compare block. A pointer snapshot has no frozen body, and a first
       version has nothing before it — both are said, not shown as an empty diff
       that would read as "identical". */
    let compare;
    if (row.previousId === null) compare = '<span class="hint" style="padding:0">首版</span>';
    else if (row.changes === null) compare = '<span class="chip warn">指针式，无可比正文</span>';
    else if (row.changes.length === 0) compare = '<span class="chip">与上一版一致</span>';
    else compare = '<details class="diff"><summary>' + row.changes.length + ' 处字段差异</summary>'
      + '<table><thead><tr><th>字段</th><th>上一版</th><th>本版</th></tr></thead><tbody>'
      + row.changes.map(c => '<tr><td><code>' + escapeHtml(c.field) + '</code></td>'
        + '<td>' + showDiffValue(c.before) + '</td>'
        + '<td>' + showDiffValue(c.after) + '</td></tr>').join('')
      + '</tbody></table></details>';

    /* Delete and archive set the same flag on the row; the difference is that
       delete asks the reference graph first. So a referenced row still offers
       archive (which only hides the version) but its delete button is disabled
       with the referrers named in the title — not a button that fails on click.
       The row's own referrer chip says the same thing without a hover. */
    const ref = refFor(row.id);
    const refChip = ref.referenced
      ? '<span class="chip warn" title="' + escapeHtml(refNames(ref.referrers)) + '">被引用 '
        + escapeHtml(String(ref.referrers.length)) + '</span> '
      : '';
    const deleteBtn = ref.referenced
      ? '<button data-snapdelete="' + escapeHtml(row.id) + '" disabled title="'
        + escapeHtml('被引用，不能删除：' + refNames(ref.referrers)) + '">删除</button>'
      : '<button data-snapdelete="' + escapeHtml(row.id) + '">删除</button>';
    const actions = row.archived
      ? refChip + '<span class="chip warn">已归档</span> '
        + '<button data-snaprestore="' + escapeHtml(row.id) + '">恢复</button>'
      : refChip + '<button data-snaparchive="' + escapeHtml(row.id) + '">归档</button> ' + deleteBtn;

    return '<tr' + (row.archived ? ' style="opacity:.6"' : '') + '>'
      + '<td>' + escapeHtml(shortTime(row.createdAt)) + '</td>'
      + '<td>' + escapeHtml(label) + '</td>'
      + '<td title="' + escapeHtml(row.objectId) + '"><code>' + escapeHtml(shortId(row.objectId)) + '</code></td>'
      + '<td>v' + escapeHtml(String(row.version ?? '—')) + '</td>'
      + '<td>' + readable + '</td>'
      + '<td>' + compare + '</td>'
      + '<td>' + actions + '</td>'
      + '</tr>';
  };

  $('snaptable').innerHTML = '<table><thead><tr><th>登记时间</th><th>类型</th><th>对象</th>'
    + '<th>版本</th><th>正文</th><th>与上一版对比</th><th>操作</th></tr></thead><tbody>'
    + data.rows.map(rowHtml).join('')
    + '</tbody></table>'
    + '<div class="hint">显示 ' + data.rows.length + ' / ' + data.total + ' 条'
    + (filtered ? '（已筛选）' : '') + '</div>';

  for (const button of $('snaptable').querySelectorAll('button[data-snaparchive]')) {
    button.onclick = () => archiveSnapshotVersion(button.dataset.snaparchive);
  }
  for (const button of $('snaptable').querySelectorAll('button[data-snapdelete]')) {
    if (button.disabled) continue;
    button.onclick = () => deleteSnapshotVersion(button.dataset.snapdelete);
  }
  for (const button of $('snaptable').querySelectorAll('button[data-snaprestore]')) {
    button.onclick = () => restoreSnapshotVersion(button.dataset.snaprestore);
  }
}

/** One cell of a diff. Null means the field was added / removed, said so. */
function showDiffValue(value) {
  if (value === null || value === undefined) return '<span class="chip">（无）</span>';
  if (typeof value === 'string') return escapeHtml(value.length > 60 ? value.slice(0, 60) + '…' : value);
  return '<code>' + escapeHtml(JSON.stringify(value)) + '</code>';
}

/** An object id that stays one line in the table. */
function shortId(id) {
  const text = String(id);
  return text.length <= 22 ? text : text.slice(0, 21) + '…';
}

/* Archiving hides a version from the default view; it does not delete it, so the
   reply says whether anything changed and the list is re-read rather than
   patched by hand. */
async function archiveSnapshotVersion(id) {
  try {
    await apiWithApproval('snapshot-archive', { id });
    await refresh();
  } catch (error) {
    showPageError(error);
  }
}

/* Reference-checked soft delete. It writes the same flag as archive, but the
   store asks the reference graph first and refuses when something points at the
   version — the refusal carries the referrers, and the api helper turns the
   server sentence into the banner verbatim, so the page cannot say something
   different from the store about why the delete failed. */
async function deleteSnapshotVersion(id) {
  try {
    await api('snapshot-delete', { method: 'POST', body: JSON.stringify({ id }) });
    await refresh();
  } catch (error) {
    showPageError(error);
  }
}

/* Bring a hidden version back into the default view. The body was never touched,
   so there is nothing to reconstruct — the reply says whether anything changed
   and the list is re-read rather than patched by hand. */
async function restoreSnapshotVersion(id) {
  try {
    await api('snapshot-restore', { method: 'POST', body: JSON.stringify({ id }) });
    await refresh();
  } catch (error) {
    showPageError(error);
  }
}

/* ── the conflict workbench (B10, 模块 03 数据资产与质量) ─────────────────── */

/* The conflict view — the fifth tab of the quality panel, drawn into the box its
   caller hands it (qconflicts) rather than replacing the panel: the panel
   belongs to the tab container, and a view that owned it would take the other
   five tabs down with it.

   Its whole job is the batch's one sentence: a conflict is never silently
   overwritten. So every competing value is shown with its source id and the
   time it was observed, side by side, and adopting one is a button that records
   a decision. There is no button that closes a conflict without a decision —
   「保留未决」 exists because leaving it open is a legitimate outcome.

   The rows come from state.conflicts, the slice the server builds with
   conflictView(); the page owns no second copy of the statuses or their labels.

   NB: no backticks in this comment either. */
function renderConflicts(panel) {
  if (panel === null || panel === undefined) return;
  const data = state.conflicts;
  if (!data) { panel.innerHTML = '<div class="empty">冲突工作台未就绪（模块切换中）。</div>'; return; }

  const counts = data.counts || {};
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + '">'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + '</span>';

  panel.innerHTML =
    '<div class="rule-sect" style="border-top:none">冲突工作台（同字段多源不同值的裁决）</div>'
    + '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('待裁决', counts.open ?? 0, counts.open ? 'warn' : '')
    + chip('已裁决', counts.resolved ?? 0)
    + chip('接受风险', counts.accepted_risk ?? 0)
    + chip('共', counts.total ?? 0)
    + '<span class="hint" id="conflictNote" style="padding:0"></span>'
    + '</div>'
    + '<div id="conflicttable"></div>'
    + '<div class="hint">采纳一个值只是<strong>把决定记在来源旁边</strong>：落选的那几条来源'
    + '<strong>一条都不会被删</strong>，采纳记录里留着它的来源 id。<br>'
    + '重新采到同一个字段时，若出现<strong>新的、不同于已采纳值</strong>的取值，冲突会被<strong>重新打开</strong>；'
    + '只是又采到已采纳的那个值，不会把已裁决的冲突吵醒。</div>';

  if (data.rows.length === 0) {
    /* An empty workbench is a real finding here, and it has to be told apart from
       the tab not existing. So it says both what it means and what it does not.
       allowMarkup：这段是静态文案（没有任何库里的值插进来），保留粗体断句。 */
    const noConflictAtAll = counts.total === 0;
    $('conflicttable').innerHTML = noConflictAtAll
      ? emptyState('none', {
        subject: '冲突',
        reason: '当前没有冲突。这是<strong>一个真实的结论</strong>，不是「视图还没建」：'
          + '同字段的多条来源取值一致时不产生冲突；本版也只对<strong>本批之后的新写入</strong>做检测 —— '
          + '历史里的多源差异不会被自动翻出来当成冲突，因为它们的成因各不相同，自动判定会造出假冲突。',
        allowMarkup: true,
      })
      : emptyState('filtered', {
        subject: '冲突',
        reason: '这个筛选条件下没有冲突。放宽条件再试 —— 不要把它读成「库里没有冲突」：库内共 '
          + counts.total + ' 条。',
      });
    return;
  }

  const valueCell = (entry, row) => {
    const hasValue = entry.value !== null && entry.value !== undefined;
    const value = hasValue ? '<code>' + escapeHtml(entry.value) + '</code>' : '<span class="chip">（无值）</span>';
    const source = entry.sourceId === null || entry.sourceId === undefined ? '来源未知' : escapeHtml(entry.sourceId);
    const observed = entry.observedAt === null || entry.observedAt === undefined
      ? '<span class="chip warn" title="没有观测时间；未记录时间不算新鲜">未记录时间</span>'
      : escapeHtml(shortTime(entry.observedAt));
    /* A value may only be adopted when there is one to adopt: the resolve route
       refuses an empty value, so a null row gets no button rather than a button
       that always fails. */
    const adopt = row.status === 'open' && hasValue
      ? '<button data-conflictresolve="' + escapeHtml(row.id) + '"'
        + ' data-conflictvalue="' + escapeHtml(entry.value) + '"'
        + ' data-conflictsource="' + escapeHtml(entry.sourceId === null || entry.sourceId === undefined ? '' : entry.sourceId) + '"'
        + '>采用此值</button>'
      : '';
    return '<div class="qvalue">' + value
      + ' <span class="opt-meta">' + source + '</span>'
      + ' <span class="opt-meta">' + observed + '</span> '
      + adopt + '</div>';
  };

  const suggestionCell = row => {
    const s = row.suggestion;
    if (s === null || s === undefined) return '<span class="hint" style="padding:0">没有建议</span>';
    const pick = entry => entry === null || entry === undefined
      ? '<span class="chip">—</span>'
      : '<code>' + escapeHtml(entry.value === null || entry.value === undefined ? '（无值）' : entry.value) + '</code>'
        + ' <span class="opt-meta">' + escapeHtml(entry.sourceId || '') + '</span>';
    return '<div class="qsuggest">'
      + '<div><strong>按置信度</strong>：' + pick(s.byPriority) + '</div>'
      + '<div class="hint" style="padding:0">' + escapeHtml(s.byPriority ? s.byPriority.reason : '') + '</div>'
      + '<div><strong>按新鲜度</strong>：' + pick(s.byFreshness) + '</div>'
      + '<div class="hint" style="padding:0">' + escapeHtml(s.byFreshness ? s.byFreshness.reason : '') + '</div>'
      + '<div class="hint" style="padding:0"><em>' + escapeHtml(s.note || '') + '</em></div>'
      + '</div>';
  };

  const rowHtml = row => {
    const label = row.statusLabel || row.status;
    const status = row.status === 'open'
      ? '<span class="chip warn">' + escapeHtml(label) + '</span>'
      : '<span class="chip ok">' + escapeHtml(label) + '</span>';
    const adopted = row.adoptedValue === null || row.adoptedValue === undefined
      ? '<span class="hint" style="padding:0">尚未采纳</span>'
      : '<code>' + escapeHtml(row.adoptedValue) + '</code>'
        + (row.adoptedSourceId ? ' <span class="opt-meta">' + escapeHtml(row.adoptedSourceId) + '</span>' : '')
        + (row.resolvedAt ? '<div class="hint" style="padding:0">' + escapeHtml(shortTime(row.resolvedAt)) + '</div>' : '');
    const hold = row.status === 'open'
      ? '<button data-conflicthold="' + escapeHtml(row.id) + '" title="保持待裁决，不写任何东西">保留未决</button>'
      : '';
    return '<tr>'
      + '<td><code>' + escapeHtml(row.field) + '</code></td>'
      + '<td title="' + escapeHtml(row.asin + '@' + row.marketplace) + '">' + escapeHtml(row.asin)
        + ' <span class="opt-meta">' + escapeHtml(row.marketplace) + '</span></td>'
      + '<td>' + (row.values || []).map(entry => valueCell(entry, row)).join('') + '</td>'
      + '<td>' + suggestionCell(row) + '</td>'
      + '<td>' + status + '</td>'
      + '<td>' + adopted + '</td>'
      + '<td>' + hold + '</td>'
      + '</tr>';
  };

  $('conflicttable').innerHTML = '<table><thead><tr><th>字段</th><th>对象</th>'
    + '<th>竞争取值（来源 / 观测时间）</th><th>建议</th><th>状态</th><th>已采纳</th><th>操作</th></tr></thead><tbody>'
    + data.rows.map(rowHtml).join('')
    + '</tbody></table>';

  for (const button of $('conflicttable').querySelectorAll('button[data-conflictresolve]')) {
    button.onclick = () => resolveFieldConflict(
      button.dataset.conflictresolve, button.dataset.conflictvalue, button.dataset.conflictsource);
  }
  /* 保留未决 writes nothing on purpose: leaving a conflict open is a legitimate
     outcome, and a button that closed it without a decision would be the exact
     silent overwrite this batch exists to prevent. It only says so. */
  for (const button of $('conflicttable').querySelectorAll('button[data-conflicthold]')) {
    button.onclick = () => {
      const note = $('conflictNote');
      if (note) note.textContent = '已保留未决（' + button.dataset.conflicthold + '）：不写任何东西，冲突保持待裁决。';
    };
  }
}

/* Adopting a value posts the decision and re-reads the slice: the reply knows
   the new status and counts, and the page must not guess them. The POST body
   carries the value and the source it came from, so the record names where the
   adopted value came from. */
async function resolveFieldConflict(id, value, sourceId) {
  try {
    await api('conflict-resolve', {
      method: 'POST',
      body: JSON.stringify({
        id,
        adoptedValue: value,
        adoptedSourceId: sourceId === '' ? null : sourceId,
      }),
    });
    await refresh();
  } catch (error) {
    showPageError(error);
  }
}

/* ── the audit log (S1-B12, 模块 03 数据资产与质量) ───────────────────────── */

/* The sixth and last tab of the quality panel, drawn into the box its caller
   hands it (qaudit) rather than replacing the panel — the panel belongs to the
   tab container, and a view that owned it would take the other five tabs down
   with it.

   The whole point of the log is the pair of values, so this view refuses the
   one shortcut that would make it useless: it never prints "有变化". Every row
   shows the fields that actually moved, with the old value and the new one,
   because a row that says "changed" answers the question it exists to answer
   with a shrug. Two objects are compared key by key; anything else is written
   as a plain before → after.

   It also does not invent a history. The log has no backfill and no delete, so
   an empty table means "nothing was written since the log was introduced" and
   the empty state says exactly that rather than letting a reader conclude the
   store has never been touched.

   The rows come from state.audit, the slice the server builds with listAudit();
   the page owns no second copy of the object-type vocabulary.

   NB: no backticks anywhere in this block — the whole file is one template
   literal, and a backtick in a comment ends it. */
const AUDIT_ACTOR_LABELS = { agent: 'Agent', page: '页面', system: '系统' };

function renderAudit(panel) {
  if (panel === null || panel === undefined) return;
  const data = state.audit;
  if (!data) { panel.innerHTML = '<div class="empty">审计日志未就绪（模块切换中）。</div>'; return; }

  const stats = data.stats || {};
  const byActor = stats.byActorKind || {};
  const filters = data.filters || {};
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + '">'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + '</span>';

  const option = (value, label, current) => '<option value="' + escapeHtml(value) + '"'
    + (value === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';

  /* Every object type the domain knows is offered, not only the ones with rows:
     a filter that could only select what is already on screen could never be
     used to go looking for something that is not. */
  const typeOptions = (data.objectTypes || [])
    .map(type => option(type, type, filters.objectType)).join('');

  panel.innerHTML =
    '<div class="rule-sect" style="border-top:none">全局审计（每一次写的前值 → 后值）</div>'
    + '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('库内共', stats.total ?? 0)
    + chip('Agent', byActor.agent ?? 0)
    + chip('页面', byActor.page ?? 0)
    + (byActor.system ? chip('系统', byActor.system) : '')
    + '</div>'
    + '<div class="bar">'
    + '<input type="search" id="auditAction" placeholder="按动作筛，如 setting.set" value="' + escapeHtml(filters.action) + '">'
    + '<select id="auditObjectType"><option value="">全部对象类型</option>' + typeOptions + '</select>'
    + '<input type="search" id="auditObjectId" placeholder="按对象 id 筛，如 pacing.taskIntervalSec" value="' + escapeHtml(filters.objectId) + '">'
    + '<select id="auditActorKind"><option value="">全部来源</option>'
    + (data.actorKinds || []).map(kind => option(kind, AUDIT_ACTOR_LABELS[kind] || kind, filters.actorKind)).join('')
    + '</select>'
    + '</div>'
    + '<div id="audittable"></div>'
    + '<div class="hint">「变更」是<strong>字段级</strong>的前值 → 后值：一个只写「有变化」的审计行回答不了任何问题，'
    + '所以这里把移动过的字段逐个列出来。<br>'
    + '凭据在<strong>写入时</strong>就被掩码（字段名保留、值换成掩码），所以这里看到的永远是掩码，不是原值。<br>'
    + '日志只记<strong>成功的写</strong>：失败或被状态机拒绝的调用不留行 —— 记一条没发生的写是审计唯一不能撒的谎。<br>'
    + '它<strong>不回填</strong>上线之前的历史，也<strong>没有删除入口</strong>：一条能删掉的审计行，它的缺席说明不了任何事。</div>';

  if (data.rows.length === 0) {
    /* allowMarkup：静态文案（插进去的只有数字），保留粗体断句。 */
    $('audittable').innerHTML = stats.total === 0
      ? emptyState('not-recorded', {
        subject: '审计日志行',
        reason: '日志是空的。它<strong>不回填</strong>历史 —— 只有日志上线之后发生的写才会有行，'
          + '所以「空」是「这段时间没有写」，不是「从来没人写过」。',
        allowMarkup: true,
      })
      : emptyState('filtered', {
        subject: '审计日志行',
        reason: '这个筛选条件下没有行。放宽条件再试 —— 不要把它读成「这个对象没被改过」：库内共 '
          + (stats.total ?? 0) + ' 条。',
      });
  } else {
    $('audittable').innerHTML = '<table><thead><tr><th>时间</th><th>动作</th><th>对象</th>'
      + '<th>变更（前值 → 后值）</th><th>谁</th><th>入口</th></tr></thead><tbody>'
      + data.rows.map(auditRowHtml).join('')
      + '</tbody></table>';
  }

  const setFilter = (id, key, read) => {
    const control = $(id);
    if (control === null) return;
    control.onchange = event => patchContext({ filters: { ...state.filters, [key]: read(event.target) } });
  };
  setFilter('auditAction', 'auditAction', target => target.value);
  setFilter('auditObjectType', 'auditObjectType', target => target.value);
  setFilter('auditObjectId', 'auditObjectId', target => target.value);
  setFilter('auditActorKind', 'auditActorKind', target => target.value);
}

function auditRowHtml(row) {
  const object = row.objectId === null || row.objectId === undefined
    ? escapeHtml(row.objectType)
    : escapeHtml(row.objectType) + ' <span class="opt-meta">' + escapeHtml(row.objectId) + '</span>';
  const actor = AUDIT_ACTOR_LABELS[row.actorKind] || row.actorKind;
  return '<tr>'
    + '<td>' + escapeHtml(shortTime(row.at)) + '</td>'
    + '<td><code>' + escapeHtml(row.action) + '</code></td>'
    + '<td>' + object + '</td>'
    + '<td>' + auditChangeHtml(row.before, row.after) + '</td>'
    + '<td><span class="chip">' + escapeHtml(actor) + '</span></td>'
    + '<td><span class="opt-meta">' + escapeHtml(row.route) + '</span></td>'
    + '</tr>';
}

/* The field-level change. Two objects are compared key by key and only the keys
   whose value moved are named; everything else is a plain before → after. A
   null is a value here, not a gap: "there was no before" is exactly what a
   create row means, and the page says 「新建」 rather than drawing an empty
   cell. */
function auditChangeHtml(before, after) {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const moved = keys.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (moved.length === 0) return '<span class="hint" style="padding:0">值未变</span>';
    return moved.map(key => '<div class="qfield">' + escapeHtml(key) + ': '
      + '<code>' + escapeHtml(briefAuditValue(before[key])) + '</code> → '
      + '<code>' + escapeHtml(briefAuditValue(after[key])) + '</code></div>').join('');
  }
  if (before === null && after !== null) {
    return '<div>新建: <code>' + escapeHtml(briefAuditValue(after)) + '</code></div>';
  }
  if (before !== null && after === null) {
    return '<div>清空（原 <code>' + escapeHtml(briefAuditValue(before)) + '</code>）</div>';
  }
  return '<div><code>' + escapeHtml(briefAuditValue(before)) + '</code> → <code>'
    + escapeHtml(briefAuditValue(after)) + '</code></div>';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function briefAuditValue(value) {
  if (value === undefined) return '—';
  if (value === null) return '空';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 60 ? text.slice(0, 59) + '…' : text;
}

function renderStatus() {
  const chips = [];
  const ready = (state.sources || []).filter(s => s.status === 'ready');
  const healthy = ready.filter(s => s.health && s.health.ok);
  /* 两个数分开写：总库有多少词 vs 正在监控多少词。
     只写「16 词」会把 30,778 行的总库藏起来 —— 那是运营最该知道的家底。 */
  chips.push({
    text: '库: ' + (state.status ? state.status.asin + ' ASIN / ' + (state.status.keywordMaster ?? state.status.keyword) + ' 词' : '—')
      + (state.status && state.status.keywordMaster !== state.status.keyword
        ? '（监控 ' + state.status.keyword + '）' : ''),
  });
  chips.push({
    text: '采集器 ' + (healthy.length > 0 ? healthy[0].id + ' 在线' : '未就绪'),
    cls: healthy.length > 0 ? 'ok' : 'warn',
  });
  const collection = state.collection;
  if (collection && collection.running) {
    chips.push({ text: '采集进行中' + (collection.queueDepth ? ' +' + collection.queueDepth + ' 排队' : ''), cls: 'run' });
  }
  // Keyword scans share the task table, so they are picked out by kind rather
  // than by a second progress channel.
  const keywordRunning = (state.tasks || []).filter(t => t.kind === 'keyword' && (t.status === 'running' || t.status === 'queued'));
  if (keywordRunning.length > 0) {
    const progress = keywordRunning[0].progress;
    chips.push({
      text: '关键词扫描 ' + (progress ? (progress.done || 0) + '/' + (progress.total || 0) : '') + ' 词',
      cls: 'run',
    });
  }
  const planned = (state.sources || []).filter(s => s.status === 'planned').length;
  if (planned > 0) chips.push({ text: planned + ' 个第三方源未接入', cls: 'warn' });
  /* 模块 08 F08-04：页头的所有权冲突徽标（原型第 61 行）。读的是服务端
     keywordOwnershipStats —— 与工作台表同一份推导，所以徽标与表格不会对「这个词算不算
     冲突」给出两个答案。0 起时不画：一个恒在的「0 起冲突」会被读成一种状态。 */
  const ownership = state.ownershipStats;
  if (ownership && ownership.conflicted > 0) {
    chips.push({ text: ownership.conflicted + ' 起所有权冲突', cls: 'warn' });
  }
  $('status').innerHTML = chips
    .map(c => '<span class="chip ' + (c.cls || '') + '">' + escapeHtml(c.text) + '</span>')
    .join('');
}

/* The sidebar is two levels: a group heading, then the modules inside it. The
   heading is a fold switch — clicking it collapses the group — and the state
   is a per-group boolean in memory, never written to the database, for the same
   reason the rest of the page state is not: it is worthless after a restart.
   Counts are kept only for the modules that actually carry one; a missing count
   is blank, not zero, because zero would be a claim about the data. */
function renderNav() {
  const counts = state.status || {};
  const folded = state.foldedGroups || {};
  $('nav').innerHTML = GROUPS.map(group => {
    const open = folded[group.id] !== true;
    const head = '<div class="navgroup" data-group="' + group.id + '">'
      + '<span class="chev">' + (open ? '▾' : '▸') + '</span>'
      + escapeHtml(group.label)
      + ' <span class="n">' + group.modules.length + '</span>'
      + '</div>';
    if (!open) return head;
    return head + group.modules.map(m => {
      const n = m.id === 'asin' ? counts.asin : m.id === 'research' ? counts.keyword : m.id === 'collect' ? counts.collectionTask : m.id === 'optimize' ? counts.optimizationRun : '';
      return '<button data-module="' + m.id + '" class="' + (state.context.module === m.id ? 'active' : '') + '">'
        + escapeHtml(m.label)
        + (n === '' || n === undefined ? '' : '<span class="count">' + n + '</span>')
        + '</button>' + sectionRows(m);
    }).join('');
  }).join('');
  for (const button of $('nav').querySelectorAll('button[data-module]')) {
    /* 出口 ②：切模块。未保存改动守卫在这里拦（beforeunload 管不到页面内跳转）。 */
    button.onclick = () => unsavedRequestLeave('切换模块：' + String(button.dataset.module ?? ''),
      () => patchContext({ module: button.dataset.module }));
  }
  for (const button of $('nav').querySelectorAll('button[data-section]')) {
    button.onclick = () => {
      /* Forget where we last jumped, so clicking the same row a second time
         still jumps. The value does not change, but the intent is new — and
         without this, a reader who scrolled away could not get back by
         re-clicking. */
      lastSection = null;
      patchContext({
        module: 'settings',
        filters: { ...state.filters, settingsSection: button.dataset.section },
      });
    };
  }
  for (const head of $('nav').querySelectorAll('.navgroup')) {
    head.onclick = () => {
      const next = { ...(state.foldedGroups || {}) };
      next[head.dataset.group] = !(next[head.dataset.group] === true);
      state.foldedGroups = next;
      renderNav();
    };
  }
}

/* The in-panel section rows for one module. Rendered indented under that
   module's button, and only for the module that actually declares them, so the
   nav never offers a jump target for a panel that has no such section. */
function sectionRows(module) {
  const sections = module.sections;
  if (!Array.isArray(sections) || sections.length === 0) return '';
  const current = state.filters.settingsSection ?? null;
  return sections.map(section => '<button data-section="' + escapeHtml(section.id) + '" class="nav-sub'
    + (state.context.module === module.id && current === section.id ? ' active' : '') + '">'
    + escapeHtml(section.label) + '</button>').join('');
}

/* Jump to the in-panel target a nav click or a link asked for — once.

   The "once" is the whole reason this is not just a scrollIntoView at the end of
   renderSettings: the panel re-renders on every refresh, so an unconditional
   scroll would drag the reader back to the top of the target on every poll and
   they could never read past it. Remembering the last target makes the jump an
   event rather than a property of the render.

   Two names for one idea, and they are the same mechanism: the settings panel's
   section (from a nav sub-row) and the anchor a 待办 / 最近运行 link carries in
   its '#module#anchor' link. Both resolve to an element id the panel gave
   itself, and an anchor wins when both are present — it came from a click on a
   specific row, which is the more recent intent. */
function scrollToSection() {
  const anchor = String(state.filters?.anchor ?? '').trim();
  const settingsSection = String(state.filters?.settingsSection ?? '').trim();
  /* The "once" is keyed on the raw anchor, so two notifications naming two different
     publications each get their jump even though they land on the same block. */
  const key = anchor !== '' ? anchor : settingsSection;
  if (key === '') return;
  if (key === lastSection) return;
  lastSection = key;
  /* 冒号前的部分才是落点区块。两个带参数的锚点约定：
       · 模块 14 的通知 '#optimize#observation:<publicationId>'（冒号后是**选中哪一条**发布）；
       · F13-09 交付边界的跳转 '#optimize#publication:draft:<runId>'（冒号后是**哪一轮**，
         因为要去建的那条登记记录还不存在，它只能指向轮次）。
     不归一化的话，拿 'sect-observation:<id>' 这个 id 去找元素永远找不到 ——
     一个承诺了却落不到地方的链接，正是这个项目反复拒绝的形态。
     只有「小写字母与短横线组成的词 + 冒号」才截断，光秃秃的 'inbox' / 'draft-title'
     这类锚点不受影响。 */
  const section = anchor !== '' ? anchor.replace(/^([a-z][a-z-]*):.*$/, '$1') : settingsSection;
  const target = $('sect-' + section);
  if (target !== null && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'start' });
  }
  /* F13-01 行尾「继续审阅」的落点：那一张字段卡。锚点只管区块（sect-inbox），
     卡片在区块**里面**，所以要单独跳一次 —— 否则读者落在收件箱顶部，还得自己找那一行。
     它有自己的 once 键：两次审阅两个不同的字段各跳一次，而同一个字段重复渲染不会反复跳。 */
  const focus = String(state.filters?.focusField ?? '').trim();
  if (focus !== '' && focus !== lastFocusedField) {
    const card = $('draft-' + focus);
    if (card !== null && typeof card.scrollIntoView === 'function') {
      lastFocusedField = focus;
      card.scrollIntoView({ block: 'center' });
    }
  }
}

/** 「全库已归档 N 个」——**读不出来**与**0 个**在这里分开说。
 *
 *  state.archivedAsins 是 null 时有两种来源：这一次读不出来，或者当前模块不是 asin
 *  （那一格服务端没取）。这一行只在 ASIN 面板画，所以撞不到第二种；而两者都**不是** 0：
 *  一个补出来的 0 读起来就是「一条都没归档」，正好把一次读失败藏起来。
 *
 *  数字后面那句「列表里带标记的就是它们」是必要的：一个总数如果不指出是哪几行，
 *  读者知道有 3 条被藏起来了却找不到是哪 3 条。 */
function archivedHint(count) {
  if (count === undefined) {
    return '已归档：服务端没有给这一格 —— 与「0 个」不是一件事';
  }
  if (count === null) {
    return '已归档：读不出来（这一列读失败或库没升到位）—— 与「0 个」不是一件事';
  }
  return '已归档 ' + String(count) + ' 个（全库口径，不随上面的筛选变；下面带「已归档」标记的就是它们）';
}

/**
 * 这一屏的归档**口径**：它挡掉了多少条。
 *
 * 与 archivedHint（全库 N 个）分成两句话，因为它们是**两个不同的数**：N 是**库**的事实、
 * 不随筛选变；这一句说的是**这一次查询**挡掉了多少。hide 口径下两者必须相等（都指
 * 「已归档的全部」）—— 而这件事只有把两个数都画出来，才有人能核对。
 * 这正是本仓那条「写入方自报 + 读者另算」的对照面：概念上本该相等的两个数字，
 * 只要有一个不在页面上，分叉就没有症状。
 *
 * 四个分支各说各的一句话（null 也算一句），因为**口径本身**是用户要能读到的：
 * 一个静默生效的筛选，与一个没生效的筛选，在只看到行的情况下长得一样。
 */
function archivedScopeHint() {
  const mode = state.asinArchived;
  if (mode === undefined || mode === null) {
    return '归档口径：服务端没有给这一格 —— 与「含已归档」不是一件事';
  }
  if (mode === 'only') return '归档口径：仅已归档 —— 这一屏全部是已归档的记录';
  if (mode !== 'hide') return '归档口径：含已归档 —— 本屏不隐藏任何已归档的记录';
  const hidden = state.asinArchivedHidden;
  if (hidden === undefined || hidden === null) {
    return '归档口径：只在架 —— 隐藏了多少条读不出来（与「隐藏了 0 条」不是一件事）';
  }
  if (hidden === 0) return '归档口径：只在架 —— 这一屏没有隐藏任何已归档的记录';
  /* 说清「怎么把它们调出来」：一个总数如果不指出下一步，读者知道有 N 条被藏起来了，
     却只能靠猜。这句话里的「归档」是上面那个三态控件。 */
  return '归档口径：只在架 —— 隐藏了 ' + String(hidden) + ' 条已归档的记录'
    + '（把上面的「归档」选成「仅已归档」就能看到它们）';
}

/**
 * 上下文里的归档筛选值不合法时，页面必须**说出来**。
 *
 * routes.js 的 asinListingForPage 在这种情况下用页面默认口径继续出数（一次抛错
 * 会让整个 /api/state 白屏），并把原话放进载荷。默认口径出数但不说，就等于
 * 「筛的是别的口径」被渲染成「筛的就是这个口径」—— 本仓最贵的那一类错。
 */
function archivedFilterErrorHint() {
  const message = state.asinArchivedFilterError;
  if (message === undefined || message === null) return null;
  return '⚠️ 上下文里的归档筛选值不合法，这一屏按「含已归档」出的数：' + String(message);
}

/* ── 模块 05 F05-01：17 列的 ASIN 大表 ────────────────────────────────────────

   三条约定，每条都对应下面一个决定：

   1. **一列一格，取值只从服务端载荷上读。** renderAsinCell 的 switch 是
      「哪一列画什么」在页面上的唯一实现，而它读的 row 上的键全部来自服务端
      （queryAsins → projectAsinRow）。页面**不内联重算**任何一列 ——
      包括「完整率」「新鲜度」这种看起来很好算的：算第二遍就会与工具印的漂开，
      而漂开时两边都不报错（本仓在 keyword_ranked 上真出过这一种）。
      验收判据：把域层的列投影改坏，工具侧与页面侧的断言必须**同时**变红。

   2. **三种空是三句话。** 没有来源的列（hasSource 为 false）印「本仓没有来源」，
      有来源但这一行没有值印「—」，测出来是 0 就印 0。合并任意两者，都会把
      「我们没建这一列」读成「这一列是 0」，或者反过来。

   3. **列顺序按目录。** 表头、单元格、导出的列顺序都来自注入的 ASIN_COLUMNS ——
      让顺序随一次勾选变化，就会让「第 5 列是什么」失去意义，而这张表的用途
      正是横向比一行。

   NB: 这一段在页面脚本里，而页面脚本是外层模板字符串的一部分 —— 注释里不许出现
   反引号（会截断外层模板，而 node --check 报的是毫不相干的行）。每改一次跑：
   node scripts/check-page.mjs。 */

/** 这一屏当前显示哪几列。state.filters.asinCols 是服务端那一份的镜像。 */
function asinVisibleColumns() {
  const raw = (state.filters || {}).asinCols;
  const wanted = new Set(String(raw === null || raw === undefined ? '' : raw)
    .split(',').map(value => value.trim()).filter(value => value !== ''));
  if (wanted.size === 0) return ASIN_COLUMNS.slice();
  const ids = new Set(ASIN_COLUMNS.map(column => column.id));
  const picked = ASIN_COLUMNS.filter(column => wanted.has(column.id));
  /* 一个 id 都认不出时回落到全部列，与 resolveAsinColumns 同一条规矩：
     一张没有列的表看起来像「这个库是空的」。 */
  if (picked.length === 0 && [...wanted].some(id => !ids.has(id))) return ASIN_COLUMNS.slice();
  return picked.length === 0 ? ASIN_COLUMNS.slice() : picked;
}

/** 一列的目录项，认不出时给一个**看得见**的替身（而不是 undefined，那会画出空格子）。 */
function asinColumnById(id) {
  return ASIN_COLUMNS.find(column => column.id === id)
    ?? { id: String(id), label: String(id) + '（认不出的列）', hasSource: false, note: '这一列的 id 不在目录里' };
}

/** 一个值在页面上的说法。中文表由服务端注入（ASIN_CELL_LABELS），页面不写第二份。 */
function asinDisplayValue(column, value) {
  if (value === null || value === undefined) return '—';
  const labels = ASIN_CELL_LABELS[column.id];
  if (labels !== null && labels !== undefined && Object.prototype.hasOwnProperty.call(labels, String(value))) {
    return labels[String(value)];
  }
  return String(value);
}

/* #16：列表里的数字要能一眼读量级。BSR 千分位；价格按 marketplace 的币种加符号，
   未知币种只写代码、不硬编码美元（没有 currency 就只写数字，不猜 $）。 */
const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', KRW: '₩', INR: '₹',
  CAD: 'CA$', AUD: 'A$', MXN: 'MX$', BRL: 'R$', SGD: 'S$', AED: 'AED ',
  SAR: 'SAR ', SEK: 'SEK ', PLN: 'PLN ', TRY: 'TRY ',
};
function asinIntegerText(value) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return Math.round(number).toLocaleString('en-US');
}
function asinPriceText(value, currency) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  const code = String(currency === null || currency === undefined ? '' : currency).trim().toUpperCase();
  const amount = number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (code === '') return amount;
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol === undefined ? amount + ' ' + code : symbol + amount;
}

/** 一个单元格。**唯一一处决定「哪一列画什么」的地方** —— 每一支都只读服务端给的键。 */
/* 把一格钉在左边。用字符串前缀插入而不是给每个渲染分支都加参数：
   renderAsinCell 有 17 个分支，每支各返回自己的 <td>，逐个加参数就是 17 处
   可能漏改的地方，而漏掉的那一列会**悄悄地**不冻结（看起来只是「滚动时有点怪」）。
   选中行的底色要跟着走：tr.sel 的背景画在 tr 上，td 一旦有了自己的背景就会盖住它，
   所以选中行这里用同一个 color-mix 但以 --panel 为底，保证不透明（透明的话
   横向滚动时右边那些列的字会从这一格里透出来）。 */
function asinStickyCell(html, isSelected, zIndex) {
  if (typeof html !== 'string') return html;
  const tag = html.slice(0, 3);
  if (tag !== '<td' && tag !== '<th') return html;
  const background = isSelected === true
    ? 'color-mix(in srgb, var(--accent) 16%, var(--panel))'
    : 'var(--panel)';
  return tag + ' style="position:sticky;left:0;z-index:' + String(zIndex ?? 1)
    + ';background:' + background + '"' + html.slice(3);
}

function renderAsinCell(column, row) {
  switch (column.id) {
    case 'asin':
      return '<td><code>' + escapeHtml(row.asin) + '</code>'
        /* 归档的行逐行标出来。归档的语义是「从默认列表隐藏」，而这一张表**不隐藏**它们 ——
           所以不带标记的一行看起来和一条正常记录完全一样，那正是「归档没生效」的样子。 */
        + (row.archived ? ' <span class="chip warn">已归档</span>' : '')
        + '</td>';
    case 'marketplace': return '<td>' + escapeHtml(row.marketplace) + '</td>';
    case 'brand': return '<td>' + escapeHtml(row.brand || '') + '</td>';
    case 'title':
      return '<td title="' + escapeHtml(row.title || '') + '">' + escapeHtml(row.title || '') + '</td>';
    case 'price': return '<td>' + escapeHtml(asinPriceText(row.price, row.currency)) + '</td>';
    case 'bsr': return '<td>' + escapeHtml(asinIntegerText(row.bsr)) + '</td>';
    case 'parent':
      /* 父体那一格：值来自投影（一个子体挂两个生效父体时，值里已经带了标记，
         见 domain/asin/table.js）。这里**不再自己拼措辞**，只把「几个父体、算不算矛盾」
         放进 data 属性，好让测试与视觉验收能按属性断言 —— 而不是去数那句提示文本
         （本仓栽过：includes(标签) 会因为同一份输出里的图例让断言假绿）。 */
      return '<td' + ' data-ownparent="' + escapeHtml(String(row.parent == null ? '' : row.parent)) + '"'
        + ' data-parentcontradicts="' + (row.parent_contradicts === true ? '1' : '0') + '"'
        + ' data-parentcount="' + escapeHtml(String(row.parent_relation_count == null ? '' : row.parent_relation_count)) + '">'
        + escapeHtml(asinDisplayValue(column, row.parent)) + '</td>';
    case 'sku': return '<td>' + escapeHtml(asinDisplayValue(column, row.sku)) + '</td>';
    case 'ownership': return '<td>' + escapeHtml(asinDisplayValue(column, row.ownership)) + '</td>';
    case 'product_line':
      /* id 与名字都印。只有 id 时人认不出这是哪条线；只有名字时与工具、筛选框对不上。
         有 id 没名字（那条线被删了）是第三种情况，明说。 */
      return '<td>' + (row.product_line === null || row.product_line === undefined
        ? '—'
        : escapeHtml(row.product_line_name === null || row.product_line_name === undefined
          ? row.product_line + '（名字读不到）'
          : row.product_line_name + '（' + row.product_line + '）')) + '</td>';
    case 'rating': return '<td>' + escapeHtml(asinDisplayValue(column, row.rating)) + '</td>';
    case 'reviews': return '<td>' + escapeHtml(asinDisplayValue(column, row.reviews)) + '</td>';
    case 'completeness': return '<td>' + escapeHtml(asinDisplayValue(column, row.completeness)) + '</td>';
    case 'freshness': return '<td>' + escapeHtml(asinDisplayValue(column, row.freshness)) + '</td>';
    case 'last_collected':
      return '<td' + (row.last_collected_raw ? ' title="' + escapeHtml(String(row.last_collected_raw)) + '"' : '') + '>'
        + escapeHtml(asinDisplayValue(column, row.last_collected)) + '</td>';
    case 'optimization': return '<td>' + escapeHtml(asinDisplayValue(column, row.optimization)) + '</td>';
    case 'risk': return '<td>' + escapeHtml(asinDisplayValue(column, row.risk)) + '</td>';
    default:
      return '<td>' + escapeHtml(asinDisplayValue(column, row[column.id])) + '</td>';
  }
}

/** 表头。没有来源的列在**表头**上就带 title 与一个记号 —— 让读者在读到那一列之前
 *  就知道它是「本仓没建」，而不是读了 37 行同一句话才发现。 */
/** 数字列右对齐。判据来自目录里的 numeric 标记，不是页面里再列一遍哪几列是数字。 */
function asinNumericCell(html, column) {
  if (column === null || column === undefined || column.numeric !== true) return html;
  if (typeof html !== 'string' || html.slice(0, 3) !== '<td') return html;
  return '<td class="num"' + html.slice(3);
}

function renderAsinHeadCell(column) {
  const note = column.note === null || column.note === undefined ? '' : String(column.note);
  const sortable = typeof column.order === 'string' && column.order !== '';
  const title = sortable ? note + '（点击按此列排序）' : note;
  const mark = column.hasSource === false ? ' <span class="hint" style="padding:0">（无来源）</span>' : '';
  const classes = [];
  if (column.numeric === true) classes.push('num');
  if (sortable) classes.push('sortable');
  const current = String((state.filters || {}).order ?? '');
  return '<th'
    + (classes.length === 0 ? '' : ' class="' + classes.join(' ') + '"')
    + (sortable ? ' data-asin-sort="' + escapeHtml(String(column.order)) + '"'
      + ' aria-sort="' + (current === String(column.order) ? 'ascending' : 'none') + '"' : '')
    + ' title="' + escapeHtml(title) + '">'
    + escapeHtml(column.label) + mark + '</th>';
}

/** 这一屏有没有筛选在生效。空态的两句话由它决定（见 renderTable）。 */
function asinFiltersActive() {
  const filters = state.filters || {};
  /* 归档这一格的「没在筛」是 all，不是空串 —— 别的四个键用空串表示「全部」，
     这一个用三态字面值。把它混进下面那个空串判据里，会让页面在**默认**（含已归档）下
     就说「当前筛选下一条都没有」：一个没说出口的筛选被当成了筛过的。 */
  if (String(filters.archived ?? 'all') !== 'all') return true;
  return ['marketplace', 'productLineId', 'brand', 'q'].some(key => {
    const value = filters[key];
    return value !== null && value !== undefined && String(value).trim() !== '';
  });
}

function renderTable() {
  /* state.asins rides the lazy-slice contract like the other panels' data: null
     when this module's rows were not fetched (only the ASIN panel reads them, and
     the panel is only drawn after a state read for this module). Guarded here so
     the difference between "not fetched" and "no ASINs" can never become a crash
     in a renderer that ran one tick ahead of its data.
     No backticks in this comment — this whole script is one template literal,
     and a backtick here would end it and break the page at parse time. */
  if (state.asins === null || state.asins.length === 0) {
    /* 「筛选后一行都没有」与「库里一条都没有」是两句话，而归档的总数在这里也要出现：
       一次筛选把已归档的行全挡在外面时，这一页说「还没有 ASIN」会让人以为库是空的。
       加了组合筛选之后第一句变得更必要：一个筛出 0 行的控件看起来与一个空库一模一样，
       而两者的下一步动作完全不同（改筛选 vs 先导入）。 */
    const head = state.asins === null
      ? 'ASIN 列表：服务端没有给这一格 —— 与「一条都没有」不是一件事。'
      : (asinFiltersActive()
        ? '当前筛选下一条都没有。<br>清掉上面的筛选，或者确认你筛的站点 / 产品线 / 品牌里确实有 ASIN。'
        : '还没有 ASIN。<br>在对话里让 agent 导入，例如：<code>把这些 ASIN 导入库：B0…</code>，或先做一次采集。');
    /* 三句话里只有第一句是**缺片**（服务端没给 asins 这一格），另外两句是
       「筛没了」与「库里没有」—— 所以标记只加在第一句上。 */
    const asinsMissing = state.asins === null;
    $('table').innerHTML = '<div class="empty"' + (asinsMissing ? ' data-slice-missing="asins"' : '') + '>' + head + '</div>'
      + '<div class="hint">' + archivedHint(state.archivedAsins) + '</div>'
      /* B-05e：口径与「筛选值不合法」各占自己的一行（不是并进上面那句里）。
         空态恰恰是最需要说出**口径**的地方 —— 一个「仅已归档」的口径下面一条都没有，
         与「库里一条都没有」在这一屏长得一样，而下一步动作完全不同。 */
      + '<div class="hint" id="asinArchivedScope">' + archivedScopeHint() + '</div>'
      + (archivedFilterErrorHint() === null
        ? ''
        : '<div class="hint" id="asinArchivedFilterError">' + archivedFilterErrorHint() + '</div>');
    return;
  }
  const columns = asinVisibleColumns();
  const selected = new Set(state.context.selection.asins.map(a => a.asin + '|' + a.marketplace));
  const rows = state.asins.map(row => {
    const key = row.asin + '|' + row.marketplace;
    const isSel = selected.has(key);
    /* 第一列冻结。这张表 17 列共 1347px、内容区 874px（1440×900 实测），
       横向滚到右边之后原来认不出这是哪一行 —— 而这一页的操作对象正是「行」。
       冻在第一**个可见**列上，不是冻在 asin 列上：用户把 asin 勾掉之后，
       第一个可见的仍然是识别这一行的那个（用户自己挑的），照冻。 */
    const cells = columns.map((column, index) => {
      const html = asinNumericCell(renderAsinCell(column, row), column);
      /* FR-M2-05 ①：这两格可点改（先看影响面、再落笔）。写入走 asin-field-correct
         路由 → correctAsinField → PAGE_WRITE_TARGETS 那条审计，与工具同一个 action。
         只给**格子内容**加一层可点的壳，不重写 renderAsinCell：格子的文字由域层画
         （它分得清「没有这一格」与「值是空」），页面不该在这里再判一次。 */
      const editable = column.id === 'ownership' || column.id === 'product_line'
        ? wrapCellContent(html, content => asinEditableCell(key, column.id, content))
        : html;
      if (index !== 0) return editable;
      /* F-3：勾选框放进**冻住的那一格**里，而不是单开一列。
         单开一列会让上面那段「横向滚到右边认不出这是哪一行」的老问题回来，
         或者要算两段 sticky 偏移；放在首格内既冻住了，也不用动 CSS。
         它是**唯一**的加选/移出入口：点行不再改多选集（见下面 handler）。 */
      const mark = asinPickBoxHtml(key, isSel);
      const tagEnd = editable.indexOf('>');
      return asinStickyCell(editable.slice(0, tagEnd + 1) + mark + editable.slice(tagEnd + 1), isSel);
    }).join('');
    return '<tr data-key="' + escapeHtml(key) + '" class="' + (isSel ? 'sel' : '') + '">'
      + cells
      + '</tr>';
  }).join('');
  const head = columns.map((column, index) => {
    const html = renderAsinHeadCell(column);
    if (index !== 0) return html;
    /* 表头首格加一个「选」字：勾选框不是数据列，但读者得知道这一格是干什么的。 */
    const tagEnd = html.indexOf('>');
    const label = '<span class="hint" style="padding:0">选</span>';
    return asinStickyCell(html.slice(0, tagEnd + 1) + label + html.slice(tagEnd + 1), false, 2);
  }).join('');
  const without = columns.filter(column => column.hasSource === false);
  /* T66：总数没取到时不拼「x / null 条」也不补 0 —— 0 是一个读数，null 是没下发。 */
  const totalLine = state.total === null || state.total === undefined
    ? state.asins.length + ' 条（总数这一格没下发，不知道占全库多少）'
    : state.asins.length + ' / ' + state.total + ' 条';
  $('table').innerHTML = '<table aria-label="ASIN 列表"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>'
    /* 「本仓没有来源」在表下面再说一遍：表里某一列每一行都印着同一句话，
       容易被读成这一列全是那个值。说清它是**列**的性质，不是这一批行的性质。 */
    + (without.length === 0 ? '' : '<div class="hint">上面 ' + without.length + ' 列**本仓没有来源**'
      + '（不是这一行没有值）：' + without.map(column => escapeHtml(column.label)).join('、')
      + ' —— 鼠标停在表头上能看到每一列为什么没有来源。</div>')
    + '<div class="hint">' + totalLine + ' · '
    /* F-3：两种点击是**两个意图**，所以文案必须分别说清；选中多于一条时
       asinPickHint 会提前警告「点行会替换」—— 否则用户以为自己是在加选。 */
    + escapeHtml(asinPickHint(selected.size)) + ' · '
    + columns.length + ' / ' + ASIN_COLUMNS.length + ' 列 · '
    + archivedHint(state.archivedAsins)
    /* 详情长在这张表**下面**，13 行时实测在视口外 996px 处 —— 点完一行，
       屏幕上唯一的变化是右栏「当前选中」多了个 id，看起来像没打开任何东西。
       所以给一个显式的入口；**仍然不自动滚**：点行现在是「看这一条」，
       连着看几条时自动滚会把正要点的下一行推走。 */
    + (selected.size === 0
      ? ''
      : ' · <button type="button" id="asinJumpDetail" style="font:inherit;font-size:11px;'
        + 'padding:1px 8px;border:1px solid var(--line);border-radius:999px;'
        + 'background:none;color:var(--accent);cursor:pointer">看这 ' + selected.size + ' 条的详情 ↓</button>')
    + '</div>'
    /* 口径单独一行、带自己的 id：两个数字（全库 N 与「本屏隐藏 M」）在 hide 口径下
       必须相等，而相等这件事要有地方能读、能核对。 */
    + '<div class="hint" id="asinArchivedScope">' + archivedScopeHint() + '</div>'
    + (archivedFilterErrorHint() === null
      ? ''
      : '<div class="hint" id="asinArchivedFilterError">' + archivedFilterErrorHint() + '</div>')
    /* FR-M2-05 ①②：行内改归属的面板（点格之后出现在表下面）。挂在这里而不是页面上，
       因为它是**这张表**的一部分：换页 / 换筛选把表重画时它跟着一起消失，
       不会留下一个指向已不存在的行的编辑框。 */
    + '<div id="asinInlineEdit"></div>'
    /* 未保存改动守卫的对话框。与上面同一处挂载、同一个理由。 */
    + '<div id="unsavedGuard"></div>';

  for (const row of $('table').querySelectorAll('tbody tr')) {
    /* F-3：**点行 = 看这一条**。选中集被**替换**成这一个（不是追加、也不是移出），
       详情跟着选中集走，于是「点一行」这件事在屏幕上有了明确的结果。
       决策在 asinRowPickSelection（纯函数，测试直接断言替换语义）。 */
    row.onclick = () => {
      /* 出口 ③（表这一侧）：点行会把选中集替换成这一条 —— 脏就先问。 */
      unsavedRequestLeave('切换选中的 ASIN',
        () => patchContext({ selection: asinRowPickSelection(row.dataset.key, state.context.selection) }));
    };
  }
  /* F-3：**勾选框 = 只改多选集**。它是唯一的加选/移出入口，
     而且不许展开或改写详情（所以这里 stopPropagation，别让点击落成「点行」）。 */
  for (const box of $('table').querySelectorAll('input[data-asin-pick]')) {
    box.onclick = event => {
      if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      patchContext({ selection: asinPickSelection(box.dataset.asinPick, state.context.selection) });
    };
  }
  /* FR-M2-05 ①：归属 / 产品线两格的可点外壳。**拦冒泡** —— 否则点格子会先被
     行 handler 当成「点行」（把选中集替换掉），改归属变成了顺带清空选中。
     面板本身由 asinInlineBegin 画在 #asinInlineEdit 里（见下面那行挂载）。 */
  for (const button of $('table').querySelectorAll('button[data-asin-edit]')) {
    button.onclick = event => {
      if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      const raw = String(button.dataset.asinEdit ?? '');
      const at = raw.lastIndexOf('|');
      if (at <= 0) return;
      asinInlineBegin(raw.slice(0, at), raw.slice(at + 1));
    };
  }
  /* 未保存改动守卫：#table 的 innerHTML 每次重画都会被换掉，而「脏」是跨重绘的
     状态 —— 所以**每次重画之后**要把编辑面板与守卫对话框画回来，否则 3 秒一次的
     轮询会把用户正在编辑的框清掉（那本身就是一次静默丢改动）。 */
  unsavedSyncSurfaces();
  renderAsinInlineEdit();
  renderUnsavedGuard();
  /* 点表头排序。走的是筛选条上那个「排序方式」的同一个键（filters.order），
     不是第二套排序 —— 两个入口改同一件事，选中的值会一起变。
     只给目录里声明了 order 的列接线：一列点下去没反应的「可排序表头」比不可点的更糟。 */
  for (const head of $('table').querySelectorAll('th[data-asin-sort]')) {
    head.onclick = () => patchContext({
      filters: { ...state.filters, order: String(head.dataset.asinSort) },
    });
  }
  const jump = $('asinJumpDetail');
  if (jump !== null) {
    jump.onclick = () => {
      const detail = $('asindetail');
      if (detail === null) return;
      /* 不能用 scrollIntoView({'block':'start'})：页头是 sticky 的，滚到「元素顶在
         视口顶」之后那一条会被页头压住 —— 实测详情页签停在 y=42，而页头高 56px，
         头两个页签正好被盖。所以自己算目标位置，留出页头的高度。 */
      const header = document.querySelector('header');
      const offset = (header === null ? 0 : header.offsetHeight) + 8;
      const top = detail.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: top, behavior: 'smooth' });
    };
  }
}

/* ── 列配置 / 保存视图 / 导出（F05-01 的另外三件）──────────────────────────────
   三件都读写 state.filters（列配置）或走一条写路由（视图），没有一件把状态
   留在页面变量里 —— 留下来的东西活不过 3 秒一次的状态轮询，而「保存了却没生效」
   正是这类界面最容易被误判成成功的地方。 */

/** 「只看关键列」用的那 8 列 —— 运营每天扫的那几个判断位。
 *
 *  为什么不是把默认值改成 8 列：F05-01 要的就是那张 17 列的大表，把默认藏起来
 *  等于没做。所以默认仍然是 17 列，另给一个一键入口。依据是实测：1440×900 下
 *  内容区 874px、17 列共 1347px，横向溢出 473px，而**评分与评论数正好落在溢出区里** ——
 *  这两个是选品判断最常用的两个数，却被排在内部分模型字段（父体 / SKU / 归属）后面。
 *
 *  清单**不写在这一页**：页面脚本里出现列 id 字面量会被 B05T-⑦a 判违规（列清单
 *  只许服务端注入一份）。标记在 domain/asin/table.js 的 key: true 上，
 *  这里只做筛选。 */

/** 列选择器：一列一个复选框，勾掉的列不画，但**顺序永远按目录**。 */
function renderAsinColumnPicker() {
  const visible = new Set(asinVisibleColumns().map(column => column.id));
  const box = $('asinColPicker');
  if (box === null) return;
  const keyIds = ASIN_COLUMNS.filter(column => column.key === true).map(column => column.id);
  const allIds = ASIN_COLUMNS.map(column => column.id);
  const presetButton = (mode, label) =>
    '<button type="button" data-asin-cols-preset="' + mode + '"'
    + ' style="font:inherit;font-size:11px;padding:2px 9px;border:1px solid var(--line);'
    + 'border-radius:999px;background:none;color:var(--fg);cursor:pointer">' + label + '</button>';
  box.innerHTML = '<span style="display:inline-flex;gap:6px;margin-right:10px">'
    + presetButton('key', '只看关键 ' + keyIds.length + ' 列')
    + presetButton('all', '全部 ' + allIds.length + ' 列')
    + '</span>'
    + ASIN_COLUMNS.map(column =>
      '<label class="chk" title="' + escapeHtml(String(column.note ?? '')) + '">'
      + '<input type="checkbox" data-asin-col="' + escapeHtml(column.id) + '"'
      + (visible.has(column.id) ? ' checked' : '') + '> '
      + escapeHtml(column.label)
      + (column.hasSource === false ? '（无来源）' : '')
      + '</label>').join(' ');

  /* 两个预设都**写死 id 清单**而不是写空串。空串在服务端是「用默认」，
     而默认随目录走 —— 用户点「全部 17 列」之后目录加了第 18 列，
     他要的到底是「全部」还是「我当时看到的那 17 个」就成了两件事。
     这里按字面兑现标签上的数字。 */
  for (const button of box.querySelectorAll('button[data-asin-cols-preset]')) {
    button.onclick = () => {
      const ids = button.getAttribute('data-asin-cols-preset') === 'key' ? keyIds : allIds;
      if (ids.length === 0) return;
      patchContext({ filters: { ...state.filters, asinCols: ids.join(',') } });
    };
  }
  for (const input of box.querySelectorAll('input[data-asin-col]')) {
    input.onchange = () => {
      const next = ASIN_COLUMNS
        .filter(candidate => {
          const node = box.querySelector('input[data-asin-col="' + candidate.id + '"]');
          return node === null ? visible.has(candidate.id) : node.checked === true;
        })
        .map(candidate => candidate.id);
      /* 一列都不勾时**不写空**：空字符串在服务端会被读成「用默认」，于是用户
         取消最后一列之后整张表突然变成 17 列 —— 一个不像任何一次点击结果的画面。 */
      if (next.length === 0) {
        $('asinColSummary').innerHTML = '至少留一列（这一列是必看的：' + escapeHtml(column0Label()) + '）';
        renderAsinColumnPicker();
        return;
      }
      patchContext({ filters: { ...state.filters, asinCols: next.join(',') } });
    };
  }
  const summary = $('asinColSummary');
  if (summary !== null) {
    summary.innerHTML = visible.size + ' / ' + ASIN_COLUMNS.length + ' 列'
      + (visible.size === ASIN_COLUMNS.length ? '（全部）' : '');
  }
}

/** 提示语里点名的第一列。**从目录读**，不写死一个 id —— 目录改了这里跟着改。 */
function column0Label() {
  return ASIN_COLUMNS.length === 0 ? '（目录为空）' : ASIN_COLUMNS[0].label;
}

/** 保存视图的选择框 + 一句「这个视图在看什么」。 */
function renderAsinViews() {
  const views = state.asinSavedViews;
  const pick = $('asinViewPick');
  if (pick === null) return;
  const current = String((state.filters || {}).asinView ?? '');
  if (views === null || views === undefined) {
    /* 「没取」与「取了但空」是两句话。合成一句的话，一个不是 ASIN 模块的响应
       会让选择框看起来像「你一个视图都没存过」。 */
    pick.innerHTML = '<option value="">（视图：这一次没取）</option>';
    pick.value = '';
  } else {
    pick.innerHTML = '<option value="">（未选择视图）</option>'
      + views.map(view => '<option value="' + escapeHtml(view.name) + '">'
        + escapeHtml(view.name) + (view.broken ? ' ⚠️' : '') + '</option>').join('');
    pick.value = views.some(view => view.name === current) ? current : '';
  }

  const hint = $('asinViewsHint');
  if (hint === null) return;
  if (views === null || views === undefined) {
    hint.innerHTML = '保存视图：这一次没取（不是「一个都没存」）。';
    return;
  }
  const broken = views.filter(view => view.broken === true);
  hint.innerHTML = views.length === 0
    ? '还没有保存视图。列配置与筛选调好之后，起个名字点「保存」—— 视图存的是**筛选与列**，不是这一次的结果。'
    : '已存 ' + views.length + ' 个视图：' + views.map(view => escapeHtml(view.name)
      + '（' + view.columns.length + ' 列）').join('、')
      + (broken.length === 0 ? '' : ' ⚠️ ' + broken.length + ' 个视图的配置读不出来：'
        + broken.map(view => escapeHtml(view.name) + '：' + escapeHtml(String(view.brokenReason))).join('；'));
}

/** 加载一个视图 = 把它存的筛选与列配置**交回** filters，查询照常发生。 */
function loadAsinView(name) {
  const views = Array.isArray(state.asinSavedViews) ? state.asinSavedViews : [];
  const view = views.find(entry => entry.name === name);
  if (view === undefined) return;
  /* 先清掉这五个键再合并：一个视图没存 brand，而上一屏的 brand 还留在
     filters 里，加载出来的就是「这个视图 + 上一次的筛选」—— 一个谁都没要过的组合。 */
  const base = { ...state.filters };
  for (const key of ['marketplace', 'productLineId', 'brand', 'q', 'order']) delete base[key];
  patchContext({
    filters: {
      ...base,
      ...view.filters,
      asinCols: view.columns.join(','),
      asinView: view.name,
    },
  });
}

/** 一个文件名的安全版本。名字里有路径分隔符时，浏览器会把它当成目录。 */
function asinExportFileName() {
  const now = new Date();
  const stamp = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0') + '-' + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0');
  return 'asin-table-' + stamp + '.csv';
}

/**
 * 导出当前这一屏。
 *
 * CSV 的序列化**不在这里**：它来自服务端注入的同一个函数（asinTableCsv，
 * 见 domain/asin/table.js 的文件头）。页面只负责把它交给浏览器 ——
 * 在页面里再写一份 CSV 拼装，就是让「工具导出的文件」与「页面下载的文件」
 * 有两条转义规则，而它们漂开时两边都不报错。
 */
function exportAsinCsv() {
  const rows = Array.isArray(state.asins) ? state.asins : [];
  if (rows.length === 0) return;
  const columns = asinVisibleColumns();
  const csv = asinTableCsv(columns, rows);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = asinExportFileName();
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/* ── 模块 05：ASIN 详情区（F05-02 的前四个标签页）—— 客户端那一半 ────────────────

   服务端那一半是完整的（domain/asin/detail.js + GET /api/asin-detail），而这一半**原本
   并不存在**：容器 #asindetail、.asin-* 的 CSS 与三个注入常量都在，却没有一处 fetch、
   没有一行 handler。那不是「少做了一半」，是本仓最忌讳的那一类 —— **看起来能用**：
   一个带 cursor:pointer 的空容器比一块空白更糟，因为它把「没接线」伪装成「可以点」。

   四条约定，每条都对应下面一个决定：

   1. **按选中项读一次，不随 state 轮询下发**（见 #asindetail 上方那条注释）：一个 ASIN
      的四页加起来是全部字段来源、下游引用与十三行节结果，跟着 3 秒一次的轮询走会把载荷
      预算吃光，而面板没开着的时候没有读者。读回来的载荷放在这一段自己的变量里，**不进
      state** —— state 是服务端切片的镜面，往里塞界面状态只会让每次轮询都带一份没人看的字段。
   2. **每个比例都印分母**：服务端给的是 {value,total,percent,missing,basis} 五件套，页面照
      五件套印「值/分母」，不压成一个百分数。只印百分数的话，第 11 个字段出现时「3/10」
      会安静地变成「2.7/10」，谁也看不出来。
   3. **词表不抄第二份**：标签页的中文名来自注入的 ASIN_TAB_LABELS；13 节的节名与顺序来自
      服务端载荷（它出自 B-04 的 COLLECTION_SECTIONS）；五态名与状态芯片来自注入的
      SECTION_STATUS（collectSummaryText / sectionChip 用的就是它）。变体角色
      （parent / child / both / unrelated）照**原样**印出这四个 id，不在这里编一套中文 ——
      工具 amzn_asin_detail 印的就是这四个 id，页面另编一套就是让同一个词有两套说法。
   4. **缺失要说出来**：未建的五个标签页（ASIN_PENDING_TABS）、未采集的节、没有任何下游
      引用的字段、0/0 的比率、读不出来的表，各自都有一句话，不靠留白表示。

   NB: 这一段在页面脚本里，而页面脚本是外层模板字符串的一部分 ——
   注释里不许出现反引号（会截断外层模板，而 node --check 报的是毫不相干的行）；
   字符串里需要换行时用 <br>，不要用反斜杠转义（外层模板会先把它解释成真换行，
   而 Node 侧完全看不见）。每改一次跑：node scripts/check-page.mjs。 */
let asinDetailFocus = null;         /* 「asin|marketplace」—— 详情区正在看的那个 ASIN */
let asinDetailSelectionKey = null;  /* 最近一次跟随的选中项；用来判断选中项有没有动过 */
let asinDetailPinned = false;       /* 焦点是手动点过来的（选中项没有变） */
let asinDetailTab = null;           /* null = 还没点过页签，用 ASIN_TAB_ORDER 的第一个 */
let asinDetailData = null;          /* 最后一次 /api/asin-detail 的载荷 */
let asinDetailError = null;         /* 读失败的那一次；与「正在读」不是同一件事 */

/** 一个 ASIN 在这套页面里的身份：同一个 ASIN 在两个站点是两条记录，所以键必须带站点。 */
function asinDetailKey(asin, marketplace) {
  return String(asin) + '|' + String(marketplace);
}

function asinDetailParts(key) {
  const parts = String(key).split('|');
  return { asin: parts[0], marketplace: parts.length > 1 ? parts[1] : '' };
}

/** 在一张注入表里查一个词。hasOwnProperty 而不是直接取值：这些表是对象字面量，直接取
 *  'constructor' 会拿到 Object.prototype 上的函数，然后把它印进页面 —— statusChip 上
 *  那条注释是同一个理由。查不到就把 id 原样印出来，不编一个词。 */
function asinLabeled(table, id) {
  return Object.prototype.hasOwnProperty.call(table, id) ? String(table[id]) : String(id);
}

/** 标签页的中文名。表由服务端注入（ASIN_TAB_LABELS），页面里没有第二份。 */
function asinTabLabel(id) {
  return asinLabeled(ASIN_TAB_LABELS, id);
}

/** **一行指向另一个 ASIN 的行** —— 类名就是 CSS 里那个 .asin-row。
 *
 *  .asin-row { cursor:pointer; } 是一句承诺：「这一行点得动」。兑现的地方是 wireAsinDetail ——
 *  每一个 div[data-asin] 都在那里拿到 onclick，点下去就把详情切到那个 ASIN（再读一次
 *  GET /api/asin-detail）。两处画它：详情头部的「也在选中里」，以及变体关系页里的父体/子体。
 *
 *  data-asin / data-marketplace 两个属性是必需的，不是装饰：没有它们，handler 不知道要读
 *  哪一个 ASIN，就只能靠 innerHTML 猜。 */
function asinJumpRow(asin, marketplace, note) {
  return '<div class="asin-row" data-asin="' + escapeHtml(asin) + '" data-marketplace="' + escapeHtml(marketplace) + '">'
    + '<code>' + escapeHtml(asin) + '</code> @ ' + escapeHtml(marketplace)
    + (note === null || note === undefined || note === ''
      ? '' : ' <span class="hint" style="padding:0">' + escapeHtml(note) + '</span>')
    + '</div>';
}

/** 一个值印在页面上的一行。null / undefined 是「没有值」，空串是「有一个空串」，两者不同；
 *  0 是「测出来是 0」，与上面两者都不同 —— 合并它们正是这类页面最常见的谎。 */
function asinValueText(value) {
  if (value === null || value === undefined) return '—（没有值）';
  if (typeof value === 'string') return value.trim() === '' ? '—（空字符串）' : value;
  if (typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch (error) {
      return String(value);
    }
  }
  return String(value);
}

/** 值 + 转义，一次说完，免得每处都写成 escapeHtml(asinValueText(x)) 而漏掉一半。 */
function asinText(value) {
  return escapeHtml(asinValueText(value));
}

/** 「这一块读不出来」的说法。必须与「这一块什么都没有」分开：同一条数据在工具与路由
 *  两条路径上少了一截时，页面印出来的不能是一个安静的空页面。 */
function asinLack(what) {
  return '<div class="asin-lack">服务端没有给「' + escapeHtml(what) + '」这一块 —— '
    + '这不是「这个 ASIN 什么都没有」，是同一条数据在两条读路径上少了一截。</div>';
}

/** 一次读失败：错误码与服务端那句话照印，不翻译。错误码是页面与 agent 共用的那个闭集，
 *  把 ASIN_NOT_FOUND 改写成一句更顺耳的话就是同一条规则的第二份措辞 —— 两份会漂开，
 *  而漂开的时候两边都不报错。页面另外补一句：空的这一页与「什么都没有」不是一件事。 */
function asinDetailRefusal(error) {
  const body = error === null || error === undefined ? null : error.body;
  const code = body !== null && body !== undefined && body.code ? String(body.code) : null;
  const message = body !== null && body !== undefined && body.error
    ? String(body.error)
    : String((error && error.message) || error);
  const hint = body !== null && body !== undefined && body.hint ? String(body.hint) : '';
  return '<div class="asin-problem"><strong>' + escapeHtml(code === null ? '读取失败' : code) + '</strong>：'
    + escapeHtml(message)
    + (hint === '' ? '' : '<br><span class="hint" style="padding:0">' + escapeHtml(hint) + '</span>')
    + '<br>这一页是空的，但「读失败」与「这个 ASIN 什么都没有」是两件事。</div>';
}

/** 模块 05 的面板入口：库表 + 详情区。两者都在 #panel-asin 里，所以共用
 *  PANEL_RENDERERS.asin 这一个 renderer —— 详情区不是第二个页签，它是这张表的下一半。
 *
 *  F05-01 的四块（表 / 筛选控件 / 列配置 / 保存视图）都在这里重画：它们都跟着
 *  同一次 state 读走，所以分开重画只会让其中一块停在上一次的数据上。 */`
