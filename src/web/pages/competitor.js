/**
 * 页签「competitor」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const competitorScript = `function renderCompetitor() {
  const comp = state.competitor;
  const clear = () => {
    for (const id of ['compreverse', 'compcards', 'comptheirs', 'compours', 'compquadrants', 'compevidence', 'compsets']) $(id).innerHTML = '';
  };
  if (!comp) { clear(); return; }

  /* The set picker is rebuilt on every render, so the current choice has to come
     from the server's answer rather than from the select's own state. */
  $('compSet').innerHTML = comp.sets.length === 0
    ? '<option value="">（还没有竞品组）</option>'
    : comp.sets.map(set => '<option value="' + escapeHtml(set.id) + '"'
      + (set.id === comp.selectedSetId ? ' selected' : '') + '>'
      + escapeHtml(set.name) + '（' + escapeHtml(set.marketplace) + ' · ' + set.asins.length + ' 个）</option>').join('');
  $('compAsin').value = comp.asin || '';
  $('compHint').textContent = comp.diff === null ? '' : (comp.peers || []).length + ' 个竞品 · ' + comp.marketplace;

  if (comp.diff === null) {
    $('compcards').innerHTML = '';
    $('comptheirs').innerHTML = emptyState('not-recorded', {
      subject: '可比较的数据',
      reason: comp.reason || '没有可比较的数据。',
      next: '先选一组竞品（或建一个竞品集），再看差异。',
    });
    $('compours').innerHTML = '';
    $('compquadrants').innerHTML = '';
    $('compevidence').innerHTML = '';
    renderCompetitorReverse(comp);
    renderCompetitorSets(comp);
  renderCompetitorDiscover(comp);
  renderCompetitorRelations(comp);
    return;
  }

  const diff = comp.diff;
  $('compcards').innerHTML = '<div class="split2">'
    + '<div><div class="hint" style="padding:0">竞品有我们没有</div>'
    + '<div class="n">' + diff.counts.theirsOnly + '</div>'
    + '<div class="hint" style="padding:0">测过且确实没排名 ' + diff.counts.absent
    + ' · 从没测过 ' + diff.counts.untested + '</div></div>'
    + '<div><div class="hint" style="padding:0">我们有竞品没有</div>'
    + '<div class="n">' + diff.counts.oursOnly + '</div>'
    + '<div class="hint" style="padding:0">两侧都有排名 ' + diff.counts.ranked + '</div></div>'
    + '</div>';

  /* "We never measured it" and "we measured it and we are not there" produce the
     same-looking list and are not the same finding. The count card above says how
     many of each, and this line says what to do about the first kind. */
  $('comptheirs').innerHTML = diffSection({
    title: '竞品有我们没有（可行动）',
    rows: diff.theirsOnly,
    orderId: 'compTheirsOrder',
    order: diff.theirsOrder,
    truncated: diff.truncated.theirsOnly,
    total: diff.counts.theirsOnly,
    note: diff.counts.untested > 0
      ? '其中 ' + diff.counts.untested + ' 条是「我们从没测过」，不是「测过但没有排名」——先跑一次覆盖扫描才算结论。'
      : '',
  });
  $('compours').innerHTML = diffSection({
    title: '我们有竞品没有',
    rows: diff.oursOnly,
    orderId: 'compOursOrder',
    order: diff.oursOrder,
    truncated: diff.truncated.oursOnly,
    total: diff.counts.oursOnly,
    note: '这几条竞品侧没有数据（不是「竞品排名 0」），竞品排名一列留空。',
  });

  if (comp.excludedSelf) {
    $('compHint').textContent += ' · 已剔除我们自己的 ASIN';
  }
  renderCompetitorQuadrants(comp);
  /* 行是 innerHTML 写进去的字符串，所以点击用事件委托绑在容器上 —— 逐个给 <tr>
     绑 handler 会在下一次重渲染后全部失效，那正是 data-keyword 声明了却没人读的
     成因。委托一次，重渲染多少次都还在。 */
  bindEvidenceClicks();
  renderCompetitorEvidence();
  renderCompetitorReverse(comp);
  renderCompetitorSets(comp);
  renderCompetitorDiscover(comp);
  renderCompetitorRelations(comp);
}

/* F06-04 四象限：五桶计数 + 可点击的行。未测单列一桶，绝不与自有缺席合并。 */
const QUADRANT_KEYS = ['ownAdvantage', 'contested', 'ourAbsent', 'unmeasured', 'brandOnly'];
const QUADRANT_LABELS = {
  ownAdvantage: '自有优势', contested: '共同竞争', ourAbsent: '自有缺席',
  unmeasured: '未测', brandOnly: '仅品牌不相关',
};

function renderCompetitorQuadrants(comp) {
  const q = comp.quadrants;
  if (!q) { $('compquadrants').innerHTML = ''; return; }
  const head = '<div class="rule-sect">F06-04 关键词差距四象限（合计 ' + q.inputTotal + ' 条，分入 ' + q.classified + ' 条）</div>'
    + '<div class="bar" style="border-top:1px solid var(--line);flex-wrap:wrap">'
    + QUADRANT_KEYS.map(key => '<span class="hint" style="padding:0">'
      + QUADRANT_LABELS[key] + ' ' + (q.counts[key] || 0) + '</span>').join(' ')
    + '</div>';
  const rows = [];
  const notes = [];
  for (const key of QUADRANT_KEYS) {
    /* 服务端已按唯一一处上限（QUADRANT_PAGE_SIZE）截过桶 —— 这里**不再截一次**。
       页面自己再截一次，就会让「渲染出的行」与「服务端备了证据的行」分家。 */
    const bucket = q.quadrants[key] || [];
    for (const row of bucket) {
      rows.push('<tr data-keyword="' + escapeHtml(row.keyword) + '">'
        + '<td>' + escapeHtml(QUADRANT_LABELS[key]) + '</td>'
        + '<td title="' + escapeHtml(row.keyword) + '">' + escapeHtml(row.keyword) + '</td>'
        + '<td>' + numOrDash(row.search_volume) + '</td>'
        + '<td>' + numOrDash(row.our_rank) + '</td>'
        + '<td>' + numOrDash(row.competitor_best_rank) + '</td>'
        + '</tr>');
    }
    if (q.truncated && q.truncated[key]) {
      notes.push(QUADRANT_LABELS[key] + '只显示前 ' + bucket.length + ' 条，共 ' + (q.counts[key] || 0) + ' 条');
    }
  }
  const table = rows.length === 0
    ? emptyState('filtered', { subject: '关键词', next: '四个象限（我们的优势 / 争夺中 / 我们缺席 / 竞品品牌词）在这里都是空的 —— 先确认上面选了竞品组，或换一组再看。' })
    : '<table><thead><tr><th>象限</th><th>关键词</th><th>搜索量</th><th>我们排名</th>'
      + '<th>竞品最好排名</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  const truncatedNote = notes.length === 0 ? '' : '<div class="hint">' + escapeHtml(notes.join('；')) + '</div>';
  $('compquadrants').innerHTML = head + truncatedNote + table
    + '<div class="hint">「未测」与「自有缺席」是两件事：未测是我们从没测过，'
    + '不是「测过、没有排名」。命中竞品品牌的词进「仅品牌不相关」隔离区，'
    + '不作为机会，也不能写进自有 Listing。点击任意一行看两侧的原始数据与观测时间。</div>';
}

/* 差距行 / 象限行的点击：打开该关键词的证据视图。 */
function bindEvidenceClicks() {
  for (const containerId of ['comptheirs', 'compours', 'compquadrants']) {
    const container = $(containerId);
    if (!container) continue;
    container.onclick = (event) => {
      const target = event ? event.target : null;
      const row = target && typeof target.closest === 'function' ? target.closest('[data-keyword]') : null;
      if (!row || !row.dataset || !row.dataset.keyword) return;
      state.competitorEvidence = row.dataset.keyword;
      renderCompetitorEvidence();
    };
  }
}

/** 缺失写成「未知/未测」，永不写 0 —— 0 是一个测量值，缺失不是。 */
function factLine(label, value) {
  const shown = (value === null || value === undefined || value === '') ? '未知/未测' : String(value);
  return '<div class="hint" style="padding:0">' + escapeHtml(label) + ': ' + escapeHtml(shown) + '</div>';
}

function evidenceHtml(view) {
  const our = view.our || {};
  const their = view.their || {};
  const ourFacts = our.facts || {};
  const theirFacts = their.facts || {};
  const parts = ['<div class="rule-sect">差距证据: ' + escapeHtml(view.keyword)
    + '（站点 ' + escapeHtml(view.marketplace || '—') + '）</div>'];
  parts.push('<div class="split2">');
  parts.push('<div><div class="hint" style="padding:0"><strong>我方</strong></div>'
    + factLine('观测周期', our.period)
    + factLine('来源', our.source)
    + factLine('排名', ourFacts.rank)
    + factLine('搜索量', ourFacts.search_volume) + '</div>');
  parts.push('<div><div class="hint" style="padding:0"><strong>竞品侧</strong></div>'
    + factLine('观测周期', their.period)
    + factLine('来源', their.source)
    + factLine('竞品最好排名', theirFacts.best_rank)
    + factLine('有排名的竞品', their.measured ? (theirFacts.ranked_count + '/' + theirFacts.present_count) : null)
    + factLine('搜索量', theirFacts.monthly_volume === null || theirFacts.monthly_volume === undefined
      ? theirFacts.weekly_searches : theirFacts.monthly_volume)
    + '</div>');
  parts.push('</div>');
  if (view.periodMismatch) {
    /* §20.3：不用不同周期的两侧直接对比。这里**不给**任何结论数字。 */
    parts.push('<div class="hint" style="color:var(--warn)">⚠️ 两侧观测周期不同（我方 '
      + escapeHtml(String(our.period)) + ' / 竞品 ' + escapeHtml(String(their.period))
      + '），按 §20.3 不做直接对比，本次不给结论。</div>');
  } else if (view.theirPeriodsMixed) {
    /* 竞品侧自己跨了多个观测日：MAX(collected_at) 不是一个「竞品周期」，
       拿它去对我方一个日期仍然违反 §20.3。这一支与上面那一支是不同的事实。 */
    parts.push('<div class="hint" style="color:var(--warn)">⚠️ 竞品侧有 '
      + escapeHtml(String((view.their.periods || []).length)) + ' 个观测日（'
      + escapeHtml((view.their.periods || []).join('、'))
      + '），竞品周期不是一个日期 —— 按 §20.3 不给结论。</div>');
  } else if (view.comparable) {
    parts.push('<div class="hint">两侧周期一致且都有测量，可以对比。</div>');
  } else {
    parts.push('<div class="hint">有一侧没有测量数据，不给结论（缺失显示为未知/未测，不是 0）。</div>');
  }
  return parts.join('');
}

function renderCompetitorEvidence() {
  const box = $('compevidence');
  if (!box) return;
  const comp = state.competitor;
  const keyword = state.competitorEvidence;
  if (!comp || !keyword) { box.innerHTML = ''; return; }
  const view = (comp.evidence || {})[keyword];
  if (!view) {
    box.innerHTML = emptyState('not-recorded', {
      subject: '这条词的证据',
      next: '证据来自竞品排名与库内测量的对比 —— 先让这个词至少有一边被测量过。',
    });
    return;
  }
  box.innerHTML = evidenceHtml(view);
}

function diffSection({ title, rows, orderId, order, truncated, total, note }) {
  const head = '<div class="bar" style="border-top:1px solid var(--line)">'
    + '<strong style="font-size:12px">' + escapeHtml(title) + ' ' + total + '</strong>'
    + diffOrderSelect(orderId, order)
    + '<span class="hint" style="padding:0;margin-left:auto">'
    + (truncated ? '只显示前 ' + rows.length + ' 条（按当前排序取前 ' + rows.length + '）' : '')
    + '</span></div>';
  /* The sort select is created by this call, so its handler is bound by this
     call: renderCompetitor re-runs on every refresh and would otherwise leave
     the new element with no handler — a dropdown that visibly changes and
     changes nothing. The empty branch returns before the select exists, which
     is why the binding sits below it. */
  /* 「（无）」是 P3-1 明令禁止的那种说法：它把「读到 0 条」「本仓没有这个来源」
     「这一页没显示」三件事压成同一个词。这里能拿到的信息只有 total（服务端这一节
     的总条数）和 note（调用方对这一节的说明），所以只按这两样分：
       · total > 0 而 rows 为空 —— **不是没有数据**，是这一页一条都没显示（分页/排序），
         这句话必须说出来，否则它看起来和「库里没有」一模一样；
       · total === 0 —— 有 note 就用 note（它写的是「为什么这一节是空的」，例如
         「这几条竞品侧没有数据（不是『竞品排名 0』）」），没 note 就老实说「这一节 0 条」，
         不替服务端断言是「没有来源」还是「答案是 0」—— 那是 domain 才能回答的。
     空态文案**不写在表格里**：表格不存在时也必须有话说。
     注意：本注释在模板字符串里，不能出现反引号。 */
  if (rows.length === 0) {
    /* 三种零，按能拿到的信息分开说（页面替 domain 断言「有没有来源」是不许的）：
       · total > 0 → 这一页没显示（filtered）
       · total === 0 且有 note → 用 note（domain 说的「为什么空」）
       · total === 0 且无 note → 老实说 0 条，并指回上方结论行 */
    const paged = typeof total === 'number' && total > 0;
    return head + emptyState(paged ? 'filtered' : 'none', {
      subject: '这一节',
      reason: paged
        ? '这一节共 ' + total + ' 条，但这一页一条都没显示 —— 不是「没有数据」。'
        : (note === '' || note === undefined || note === null
          ? '这一节 0 条。是「读到了、答案是 0」还是「本仓没有这个来源」，见上方结论行。'
          : String(note)),
    });
  }
  const html = head
    + '<table><thead><tr><th>关键词</th><th>搜索量</th><th>竞品最好排名</th>'
    + '<th>竞品有排名</th><th>我们排名</th><th>搜索量来源</th></tr></thead><tbody>'
    + rows.map(row => '<tr data-keyword="' + escapeHtml(row.keyword) + '" data-marketplace="' + escapeHtml(comp0Marketplace()) + '">'
      + '<td title="' + escapeHtml(row.keyword) + '">' + escapeHtml(row.keyword) + '</td>'
      + '<td>' + numOrDash(row.search_volume) + '</td>'
      /* Empty, not 0. A competitor best rank of 0 reads as "ranked first". */
      + '<td>' + numOrDash(row.competitor_best_rank) + '</td>'
      + '<td>' + row.competitor_ranked_count + '/' + row.competitor_total + '</td>'
      + '<td>' + numOrDash(row.our_rank) + '</td>'
      + '<td>' + escapeHtml(row.origin || '—') + '</td>'
      + '</tr>').join('')
    + '</tbody></table>'
    + (note === '' ? '' : '<div class="hint">' + escapeHtml(note) + '</div>');
  bindDiffOrder(orderId);
  return html;
}

/** Bind a diff table's sort select, which diffSection has just written. */
function bindDiffOrder(orderId) {
  const select = $(orderId);
  if (!select) return;
  const filterKey = orderId === 'compTheirsOrder' ? 'competitorTheirsOrder' : 'competitorOursOrder';
  select.onchange = (event) => patchContext({ filters: { ...state.filters, [filterKey]: event.target.value } });
}

/** The marketplace the diff is about, for the row click that adds to selection. */
function comp0Marketplace() {
  return state.competitor?.marketplace ?? state.filters.marketplace ?? 'US';
}

function renderCompetitorSets(comp) {
  const rows = comp.sets.map(set => '<tr>'
    + '<td>' + escapeHtml(set.name) + '</td>'
    + '<td>' + escapeHtml(set.marketplace) + '</td>'
    + '<td>' + set.asins.length + '</td>'
    + '<td title="' + escapeHtml(set.asins.join(', ')) + '">' + escapeHtml(set.asins.join(', ')) + '</td>'
    + '<td><button data-compset="' + escapeHtml(set.id) + '">编辑</button></td>'
    + '</tr>').join('');
  $('compsets').innerHTML = '<div class="rule-sect">竞品组（按站点保存；同名允许，不会互相覆盖）</div>'
    + '<table><thead><tr><th>名称</th><th>站点</th><th>数量</th><th>ASIN</th><th></th></tr></thead>'
    + '<tbody>' + (rows === '' ? '<tr><td colspan="5" class="hint">还没有竞品组</td></tr>' : rows) + '</tbody></table>'
    + '<div class="bar" style="border-top:1px solid var(--line);flex-wrap:wrap">'
    + '<input id="compNewName" placeholder="新竞品组名称" style="flex:0 0 160px">'
    + '<input id="compNewMarket" placeholder="站点，如 US" style="flex:0 0 90px" value="' + escapeHtml(comp.marketplace || 'US') + '">'
    + '<input id="compNewAsins" placeholder="竞品 ASIN，逗号分隔" style="flex:1;min-width:180px">'
    + '<button id="compNewSave">新建</button>'
    + '</div>'
    + '<div class="hint">新建/编辑走 <code>POST /api/competitor-set</code>（单事实、可逆），'
    + '和工具 <code>amzn_competitor_set_upsert</code> 调的是同一个 store 函数。'
    + 'ASIN 会统一成大写、去重、排序后入库，所以同一份列表重复保存是幂等的；'
    + '无效 ASIN 直接报错而不是悄悄丢掉 —— 被丢掉的竞品就是没参与比较，而输出里不会有任何提示。</div>';

  for (const button of $('compsets').querySelectorAll('button[data-compset]')) {
    button.onclick = () => {
      const set = comp.sets.find(item => item.id === button.dataset.compset);
      if (!set) return;
      $('compNewName').value = set.name;
      $('compNewMarket').value = set.marketplace;
      $('compNewAsins').value = set.asins.join(', ');
      $('compNewSave').dataset.id = set.id;
      $('compNewSave').textContent = '保存修改';
    };
  }
  $('compNewSave').onclick = async () => {
    /* The backslash is doubled for the same reason as the signals split below:
       this script is emitted from a template literal, so a single backslash-s
       reaches the browser as a plain "s" and the character class silently
       becomes [comma, s] — splitting an ASIN in half wherever it contains an
       "s", and not splitting on spaces at all. It read as correct for as long as
       nobody pasted a lowercase ASIN with an "s" in it. */
    const asins = $('compNewAsins').value.split(/[,\\s]+/).map(s => s.trim()).filter(Boolean);
    try {
      const body = { name: $('compNewName').value, marketplace: $('compNewMarket').value, asins };
      if ($('compNewSave').dataset.id) body.id = $('compNewSave').dataset.id;
      const data = await api('competitor-set', { method: 'POST', body: JSON.stringify(body) });
      $('compNewName').value = ''; $('compNewAsins').value = '';
      delete $('compNewSave').dataset.id; $('compNewSave').textContent = '新建';
      await patchContext({ filters: { ...state.filters, competitorSetId: data.set.id } });
    } catch (error) {
      showPageError(error);
    }
  };
}

/** A number, or an em dash. Never a 0 the row did not have. */
function numOrDash(value) {
  return value === null || value === undefined ? '—' : String(value);
}

/* ── 按关键词反查竞品（只读）────────────────────────────────────────
   只查库里已有的 kw_competitor_fact：输入关键词 → 每个词下已有的竞品 ASIN 与名次。
   不发起采集、不发起搜索、不写库。要真实扫描是另一个动作（amzn_keyword_scan），
   页面上只给 prompt 入口，并写明「需另行确认采集配额」。

   输入值走 filters（competitorReverseKeywords / competitorReverseMarketplace），
   所以刷新后结果还在，而不是渲染一次就散。 */
function parseReverseKeywords(value) {
  const all = String(value === null || value === undefined ? '' : value)
    .split(/[,\\n]/)
    .map(word => word.trim())
    .filter(word => word !== '');
  if (all.length > 5) showToast('最多查 5 个词，已忽略第 6 个及以后');
  return all.slice(0, 5);
}

/** 竞品关系状态 → 人话。null 是「不在关系里」，不是「查不到」。 */
function competitorRelationLabel(status) {
  if (status === 'active') return '已在竞品关系';
  if (status === 'suggested') return '只是候选（未采纳）';
  if (status === 'inactive') return '已停用';
  return '不在竞品关系';
}

function renderCompetitorReverse(comp) {
  const box = $('compreverse');
  if (box === null) return;
  const r = comp && comp.reverse ? comp.reverse : null;
  const keywords = r && Array.isArray(r.keywords) ? r.keywords : [];
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  const noFact = r && Array.isArray(r.noFactKeywords) ? r.noFactKeywords : [];
  const market = (r && r.marketplace) || (comp && comp.marketplace)
    || (state.filters && state.filters.marketplace) || 'US';

  const head = '<div class="b05c-head"><strong>按关键词反查竞品</strong>'
    + '<span class="hint" style="padding:0">只读：只查库里已有的 <code>kw_competitor_fact</code>'
    + '（卖家精灵 / 西柚导入）与自动发现结果，<strong>本入口不发起新采集/搜索</strong>。</span></div>';
  const form = '<div class="bar" style="border-top:1px solid var(--line);flex-wrap:wrap">'
    + '<input id="compRevKeywords" placeholder="关键词（最多 5 个，逗号分隔）" style="flex:1;min-width:220px" value="'
    + escapeHtml(keywords.join(', ')) + '">'
    + '<input id="compRevMarket" placeholder="站点，如 US" style="flex:0 0 90px" value="' + escapeHtml(market) + '">'
    + '<button id="compRevGo" type="button">查库内反查</button>'
    + '<button id="compRevPrompt" type="button">让 Agent 扫描这些词</button>'
    + '<span class="hint" style="padding:0">扫描会发起真实搜索采集，<strong>需另行确认采集配额</strong>；'
    + '这个按钮只复制 prompt，不自己跑。</span>'
    + '</div>';

  let body = '';
  if (keywords.length === 0) {
    body = '<div class="hint" style="padding:7px 14px">输入关键词，查库内已经导入的反查事实。'
      + '没导入过就是还没有数据 —— 那不是 0，是本仓没有可反查的竞品事实。</div>';
  } else if (rows.length === 0) {
    const missing = noFact.length > 0 ? noFact : keywords;
    body = '<div style="padding:7px 14px">' + emptyState('none', {
      reason: '本仓没有可反查的竞品事实：' + missing.join('、') + ' 在 kw_competitor_fact 里没有行。',
      next: '先导入卖家精灵 / 西柚的反查表，再用「自动发现竞品」挑候选；或让 Agent 扫描这些词（需另行确认采集配额）。',
    }) + '</div>';
  } else {
    const distinct = new Set(rows.map(row => row.asin)).size;
    const totalRows = r && r.totalRows !== null && r.totalRows !== undefined && Number.isFinite(Number(r.totalRows))
      ? Number(r.totalRows) : rows.length;
    let summary = '库内反查：' + keywords.length + ' 个词、' + totalRows + ' 行事实、可见范围内去重后 '
      + distinct + ' 个竞品 ASIN。观测时间来自 kw_competitor_fact.collected_at；空值表示这条事实没有记录时间。';
    if (totalRows > rows.length) {
      summary += ' 页面只显示前 ' + rows.length + ' 行（按名次排序）；这不是全部 ' + totalRows + ' 行。';
    }
    if (noFact.length > 0) {
      summary += ' 其中 ' + noFact.join('、') + ' 在库里没有事实 —— 这几个词只能靠导入或扫描。';
    }
    body = '<div class="hint" style="padding:7px 14px">' + escapeHtml(summary) + '</div>'
      + '<table class="asin-table"><thead><tr><th>关键词</th><th>名次</th><th>竞品 ASIN</th>'
      + '<th>月搜索量</th><th>观测时间</th><th>竞品关系</th></tr></thead><tbody>'
      + rows.map(row => '<tr>'
        + '<td title="' + escapeHtml(row.keyword) + '">' + escapeHtml(row.keyword) + '</td>'
        + '<td>' + (row.rank === null || row.rank === undefined
          ? (row.noRank ? '未进榜' : '没给名次')
          : escapeHtml(String(row.rank))) + '</td>'
        + '<td>' + escapeHtml(row.asin) + '</td>'
        + '<td>' + (row.monthlyVolume === null || row.monthlyVolume === undefined
          ? '—' : escapeHtml(String(row.monthlyVolume))) + '</td>'
        + '<td>' + (row.collectedAt ? escapeHtml(String(row.collectedAt).slice(0, 10)) : '没有记录时间') + '</td>'
        + '<td>' + escapeHtml(competitorRelationLabel(row.relation)) + '</td>'
        + '</tr>').join('')
      + '</tbody></table>'
      + '<div class="hint">这张表只画库里有的字段：ASIN、名次、搜索量、观测时间。'
      + '标题 / 价格 / 评分不在 <code>kw_competitor_fact</code> 里 —— 不画空列冒充 0。</div>';
  }

  box.innerHTML = head + form + body;

  const go = $('compRevGo');
  if (go !== null) {
    go.onclick = () => {
      const words = parseReverseKeywords($('compRevKeywords').value);
      if (words.length === 0) { showToast('先输入至少一个关键词'); return; }
      const site = String($('compRevMarket').value || '').trim().toUpperCase() || 'US';
      patchContext({ filters: { ...state.filters, competitorReverseKeywords: words.join(','), competitorReverseMarketplace: site } });
    };
  }
  const scan = $('compRevPrompt');
  if (scan !== null) {
    scan.onclick = () => {
      const words = parseReverseKeywords($('compRevKeywords').value);
      if (words.length === 0) { showToast('先输入至少一个关键词'); return; }
      const site = String($('compRevMarket').value || '').trim().toUpperCase() || 'US';
      usePrompt('请扫描这些关键词并记录竞品自然位（站点 ' + site + '）：' + words.join('、')
        + '。注意：这会发起真实搜索采集，需另行确认采集配额后，再调用 amzn_keyword_scan，最多 3 页。');
    };
  }
}

/* ── research: seeds → candidates, plus the measured-coverage section ───── */
/* ── 自动发现竞品 ─────────────────────────────────────────────────
   数据是服务器算好的预览（comp.discover），这里只渲染与提交。
   写库要人点：写成候选（suggested）→ 采纳（active）。 */
function renderCompetitorDiscover(comp) {
  const box = $('compdiscover');
  if (box === null) return;
  const d = comp && comp.discover ? comp.discover : null;
  if (d === null || d.error) { box.innerHTML = ''; return; }
  const rows = Array.isArray(d.candidates) ? d.candidates : [];
  const head = '<div class="b05c-head"><strong>自动发现竞品</strong>'
    + '<span class="hint" style="padding:0">从库里已有的反查数据挑候选，不发请求。'
    + '写成候选后要逐条采纳才算竞品 —— 机器猜的不进「我的竞品」。</span></div>';
  if (rows.length === 0) {
    box.innerHTML = head + '<div class="asin-lack">没有候选：这些词在反查数据里没有竞品排名。'
      + '先导入卖家精灵 / 西柚的反查表（管道 → 数据源目录）。</div>';
    return;
  }
  const table = '<table class="asin-table"><thead><tr>'
    + '<th><input type="checkbox" id="compDiscAll"></th><th>竞品 ASIN</th>'
    + '<th>出现在几个词</th><th>最好名次</th><th>依据</th></tr></thead><tbody>'
    + rows.map(row => '<tr>'
      + '<td><input type="checkbox" class="comp-disc" data-asin="' + escapeHtml(row.competitorAsin) + '"></td>'
      + '<td>' + escapeHtml(row.competitorAsin) + '</td>'
      + '<td>' + escapeHtml(String(row.appearances)) + '</td>'
      + '<td>' + escapeHtml(String(row.bestRank)) + '</td>'
      + '<td style="font-size:11px">' + escapeHtml(row.evidence || '') + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';
  const bar = '<div class="bar" style="margin-top:6px">'
    + '<button id="compDiscWrite" type="button">写成候选（suggested）</button>'
    + '<button id="compDiscAdopt" type="button">采纳选中</button>'
    + '<span class="hint" style="padding:0" id="compDiscHint"></span></div>';
  box.innerHTML = head + table + bar;

  const picked = () => Array.from(document.querySelectorAll('.comp-disc'))
    .filter(el => el.checked).map(el => el.dataset.asin);
  const hint = $('compDiscHint');
  const all = $('compDiscAll');
  if (all !== null) {
    all.onclick = () => {
      for (const el of document.querySelectorAll('.comp-disc')) el.checked = all.checked;
    };
  }
  const post = async (action, competitors) => {
    try {
      const data = await api('competitor-discover', {
        method: 'POST',
        body: JSON.stringify({ asin: comp.asin, marketplace: comp.marketplace, action, competitors }),
      });
      hint.textContent = action === 'adopt'
        ? '已采纳 ' + (data.adopted || []).length + ' 个'
        : '已写成候选 ' + (data.written || []).length + ' 个（还没算竞品，采纳后才算）';
      await refresh();
    } catch (error) {
      showPageError(error);
    }
  };
  const writeBtn = $('compDiscWrite');
  const adoptBtn = $('compDiscAdopt');
  if (writeBtn !== null) writeBtn.onclick = () => post('suggest', []);
  if (adoptBtn !== null) adoptBtn.onclick = () => {
    const chosen = picked();
    if (chosen.length === 0) { hint.textContent = '先勾选要采纳的竞品'; return; }
    post('adopt', chosen);
  };
}

/* ── 竞品关系总表 ─────────────────────────────────────────────────
   三种状态都列：已采纳 / 候选 / 已停用。
   只列 active 的话，「候选没采纳」和「已停用」都会变成「不存在」。 */
function renderCompetitorRelations(comp) {
  const box = $('comprelations');
  if (box === null) return;
  const rows = comp && Array.isArray(comp.relations) ? comp.relations : [];
  const head = '<div class="b05c-head"><strong>竞品关系</strong>'
    + '<span class="hint" style="padding:0">一行一个竞品。候选（suggested）还没算竞品，采纳后才进「我的竞品」；'
    + '停用是标记，记录还在 —— 「它上次排第几」是历史。</span></div>';
  if (rows.length === 0) {
    box.innerHTML = head + '<div class="asin-lack">还没有记录任何竞品关系。'
      + '上面「自动发现」或手动添加之后，会出现在这里。</div>';
    return;
  }
  const label = { active: '已采纳', suggested: '候选', inactive: '已停用' };
  const body = '<table class="asin-table"><thead><tr>'
    + '<th>父 ASIN</th><th>竞品 ASIN</th><th>范围</th><th>状态</th><th>来源</th>'
    + '<th>记录排名</th><th>加入时间</th><th></th></tr></thead><tbody>'
    + rows.map(row => '<tr>'
      + '<td>' + escapeHtml(row.parent_asin) + '</td>'
      + '<td>' + escapeHtml(row.competitor_asin) + '</td>'
      + '<td>' + escapeHtml(row.scope === 'child' ? ('子 ' + (row.scope_asin || '')) : '整个产品') + '</td>'
      + '<td>' + escapeHtml(label[row.status] || row.status) + '</td>'
      + '<td>' + escapeHtml(row.source || '—') + '</td>'
      + '<td>' + escapeHtml(row.rank_seen === null || row.rank_seen === undefined ? '—' : String(row.rank_seen)) + '</td>'
      + '<td>' + escapeHtml(String(row.created_at || '').slice(0, 10)) + '</td>'
      + '<td>' + (row.status === 'inactive'
        ? ''
        : '<button type="button" class="comp-retire" data-parent="' + escapeHtml(row.parent_asin)
          + '" data-asin="' + escapeHtml(row.competitor_asin) + '">停用</button>')
      + '</td></tr>').join('')
    + '</tbody></table>';
  box.innerHTML = head + body;

  for (const btn of document.querySelectorAll('.comp-retire')) {
    btn.onclick = async () => {
      try {
        await api('competitor-retire', {
          method: 'POST',
          body: JSON.stringify({
            marketplace: comp.marketplace,
            parentAsin: btn.dataset.parent,
            competitorAsin: btn.dataset.asin,
            reason: '页面停用',
          }),
        });
        await refresh();
      } catch (error) {
        showPageError(error);
      }
    };
  }
}

`
