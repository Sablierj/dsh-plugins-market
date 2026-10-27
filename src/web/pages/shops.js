/**
 * 页签「shops」的客户端脚本片段（P2 / ADR-004 D1）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 * 服务端下发 `state.shops`（店铺列表 + 选中店铺的产品/导入历史/品牌/父 ASIN），
 * 页面只画，不自己数产品、不猜采集状态。
 *
 * 边界（T26 §6）：不物理删店铺/品牌/产品/竞品；采集是异步的，提交只显示
 * 「已提交，后台执行」；导入继续走四段校验，缺一段进待补清单。
 */
export const shopsScript = `
/* ── 店铺管理（P2 / ADR-004）──────────────────────────────────────────── */

let shopsScan = null;
let shopsPreview = null;
let shopsBatch = null;
let shopsCollect = null;

function shopsTime(value) {
  return value === null || value === undefined || value === '' ? '—' : shortTime(value);
}

/* 可见状态的中文文案。data-* 与数据库值保持英文，只有人读的这一层翻译；
   未收录的值原样输出，不猜。 */
function shopLabel(value) {
  const labels = {
    active: '启用', archived: '已归档',
    'pending-shop': '待补店铺', 'pending-brand': '待补品牌', duplicate: '重复',
    added: '新增', unchanged: '已存在', rejected: '拒绝',
    queued: '已排队', checking_env: '检查环境', cooling_down: '冷却中',
    waiting_human: '等待人工', running: '运行中', done: '完成',
    partial: '部分完成', failed: '失败', submitted: '已提交',
    never: '从未采集', stale: '过期', fresh: '新鲜', collecting: '采集中', no_data: '无数据',
  };
  const text = String(value ?? '');
  return labels[text] !== undefined ? labels[text] : (text === '' ? '—' : text);
}

function shopMissingText(missing) {
  const labels = { shop: '缺店铺', brand: '缺品牌', marketplace: '缺站点' };
  const list = Array.isArray(missing) ? missing : [];
  return list.length === 0 ? '—' : list.map(item => labels[item] || String(item)).join(' / ');
}

function renderShops() {
  const data = state.shops;
  const box = $('shopsmain');
  if (box === null) return;
  if (data === null || data === undefined) {
    if ($('shopsHint') !== null) $('shopsHint').textContent = '店铺数据没有读出来';
    box.innerHTML = emptyState('not-recorded', { subject: '店铺数据', next: '点右上角「重新读取」。这不是「没有店铺」。' });
    return;
  }
  if ($('shopsHint') !== null) {
    /* 计数行的归档数（R2-03 / CR-T60-1）：服务端下发 archivedCount —— 与 rows 同一口径
       （同 workspace、同搜索词），但**不受「含已归档」勾选影响**，所以未勾选时也说得出
       「另有 X 家已归档」。字段缺失（老载荷）时退回「这一格没下发 ≠ 0」的诚实降级：
       缺字段不是 0。口径挂在 title 上（tooltip），勾不勾都看得到。 */
    const archivedCount = typeof data.archivedCount === 'number' ? data.archivedCount : null;
    const hint = $('shopsHint');
    hint.title = '口径：已归档数 = 当前搜索条件下 archived_at 非空的店铺数，「含已归档」勾不勾都算；'
      + '启用 / 已归档是店铺状态，与产品数、采集数无关。';
    hint.textContent = data.selected !== null
      ? '店铺：' + data.selected.name + (data.selected.archivedAt === null ? '' : '（已归档，只读）')
      : (archivedCount === null
        ? '共 ' + data.rows.length + ' 家启用店铺 · 已归档数这一格没下发（勾「含已归档」才看得到，未勾选时不等于 0）'
        : (data.includeArchived
          ? '共 ' + data.rows.length + ' 家店铺（启用 ' + (data.rows.length - archivedCount)
            + ' / 已归档 ' + archivedCount + '）'
          : '共 ' + data.rows.length + ' 家启用店铺 · 另有 ' + archivedCount + ' 家已归档（勾「含已归档」查看）'));
  }
  box.innerHTML = data.selected === null ? shopsListHtml(data) : shopsDetailHtml(data);
  bindShopControls(data);
}

/* ── 列表 ─────────────────────────────────────────────────────────────── */

/* 列表空态（R2-03 / CR-T60-1）：没勾「含已归档」时空的是**启用中的店**，不是库。
   四种情况四句话，不许折成一个「没有店铺」：
     有归档   → 「没有启用中的店铺（已归档 X 家）」—— 一眼看出不是从未建店；
     全空     → 真实的 0（启用 0 / 已归档 0），这才叫没建过店；
     字段缺失 → 不印数（老载荷没有 archivedCount，缺字段不是 0）；
     勾了含还空 → 整个库真的没有店。 */
function shopsEmptyListHtml(data) {
  const archivedCount = typeof data.archivedCount === 'number' ? data.archivedCount : null;
  if (data.includeArchived) {
    return emptyState('none', { subject: '店铺', next: '先建店，再从产品表导入这家店的产品。' });
  }
  if (archivedCount === null) {
    return emptyState('none', {
      subject: '启用中的店铺',
      next: '已归档的店不在这个数里 —— 勾选「含已归档」看它们（载荷没给 archivedCount，所以这里不是「已归档 0 家」）。',
    });
  }
  if (archivedCount > 0) {
    return emptyState('none', {
      subject: '启用中的店铺（已归档 ' + archivedCount + ' 家）',
      next: '已归档的店不在启用这个数里 —— 勾选「含已归档」看它们。',
    });
  }
  return emptyState('none', {
    subject: '店铺',
    next: '启用 0 / 已归档 0：这是真实的 0 —— 两种状态都空，就是还没建过店。先建店，再从产品表导入这家店的产品。',
  });
}

function shopsListHtml(data) {
  const rows = data.rows.map(shop => {
    const archived = shop.archivedAt !== null;
    return '<tr' + (archived ? ' style="opacity:.6"' : '') + ' data-shoprow="' + escapeHtml(shop.id) + '">'
      + '<td><code>' + escapeHtml(shop.name) + '</code><br><span class="opt-meta">' + escapeHtml(shop.id) + '</span></td>'
      + '<td>' + (shop.marketplace === null ? '<span class="chip warn">未指定站点</span>' : escapeHtml(shop.marketplace)) + '</td>'
      + '<td>' + shop.brandCount + ' <span class="opt-meta">来自产品</span></td>'
      + '<td>' + shop.brandRuleCount + ' <span class="opt-meta">来自规则</span></td>'
      + '<td>' + shop.productCount + '</td>'
      + '<td>' + shop.collectedCount + ' <span class="opt-meta">7 天内</span></td>'
      + '<td>' + shop.competitorCount + '</td>'
      + '<td>' + (shop.neverCount + shop.staleCount) + ' <span class="opt-meta">从未 ' + shop.neverCount + ' / 过期 ' + shop.staleCount + '</span></td>'
      + '<td>' + escapeHtml(shopsTime(shop.lastCollectedAt)) + '</td>'
      + '<td>' + (archived ? '<span class="chip warn">已归档</span>' : '<span class="chip ok">启用</span>') + '</td>'
      + '<td><button data-shopopen="' + escapeHtml(shop.id) + '">打开</button></td>'
      + '</tr>';
  }).join('');
  const searching = String((state.filters && state.filters.shopQ) || '').trim() !== '';
  const body = data.rows.length === 0
    ? '<tr><td colspan="11">' + (searching
      ? emptyState('filtered', { subject: '店铺', next: '清掉搜索词就能看到全部店铺。' })
      : shopsEmptyListHtml(data)) + '</td></tr>'
    : rows;
  return '<div class="bar">'
    + '<input id="shopSearch" type="search" placeholder="搜店铺名" value="' + escapeHtml(String((state.filters && state.filters.shopQ) || '')) + '">'
    + '<label class="hint" style="padding:0"><input id="shopArchived" type="checkbox"' + (data.includeArchived ? ' checked' : '') + '> 含已归档</label>'
    + '<button id="shopNew">新建店铺</button>'
    + '<span class="hint" id="shopListHint" style="padding:0"></span>'
    + '</div>'
    + '<div id="shopNewForm" hidden style="border:1px solid var(--line);border-radius:8px;padding:8px;margin:8px 0">'
    + '<div class="bar"><input id="shopNewName" type="text" placeholder="店铺名（必填）">'
    + '<input id="shopNewMarket" type="text" placeholder="站点，如 US（可空）">'
    + '<input id="shopNewNote" type="text" placeholder="备注（可空）">'
    + '<input id="shopNewBrand" type="text" placeholder="品牌名（可选，建店同时建品牌）">'
    + '<button id="shopNewSave">保存</button><button id="shopNewCancel">取消</button></div>'
    + '<div class="hint">品牌属于<strong>工作空间</strong>，不是这家店专属；这里只是创建/复用品牌并设为该店默认推荐规则。站点留空是一个真实状态，不默认 US。</div>'
    + '</div>'
    + '<div style="overflow-x:auto"><table><thead><tr><th>店铺</th><th>站点</th><th>品牌数·产品</th><th>品牌数·规则</th><th>产品数</th><th>已采集</th><th>竞品数</th><th>未采集</th><th>最近采集</th><th>状态</th><th>操作</th></tr></thead>'
    + '<tbody>' + body + '</tbody></table></div>'
    + '<div class="hint">「未采集」= 从未采集 + 快照超过 ' + data.freshnessDays + ' 天；「已采集」只数 7 天内。两组数分开列，不合并成一个 0。计数与最近采集由服务端现算，页面不重算。</div>';
}

/* ── 详情 ─────────────────────────────────────────────────────────────── */

function shopsDetailHtml(data) {
  const shop = data.selected;
  const readOnly = shop.archivedAt !== null;
  const head = '<div class="bar">'
    + '<button id="shopBack">← 全部店铺</button>'
    + '<strong>' + escapeHtml(shop.name) + '</strong>'
    + '<span class="chip">' + (shop.marketplace === null ? '未指定站点' : escapeHtml(shop.marketplace)) + '</span>'
    + (readOnly ? '<span class="chip warn">已归档 · 只读</span>' : '<span class="chip ok">启用</span>')
    + (readOnly
      ? '<button id="shopRestore">恢复</button>'
      : '<button id="shopEdit">编辑</button><button id="shopArchive">归档</button>')
    + '<span class="hint" id="shopDetailHint" style="padding:0"></span>'
    + '</div>'
    + (readOnly ? '' : '<div id="shopEditForm" hidden style="border:1px solid var(--line);border-radius:8px;padding:8px;margin:8px 0">'
      + '<div class="bar"><input id="shopEditName" type="text" value="' + escapeHtml(shop.name) + '" placeholder="店铺名">'
      + '<input id="shopEditMarket" type="text" value="' + escapeHtml(shop.marketplace ?? '') + '" placeholder="站点，如 US">'
      + '<input id="shopEditNote" type="text" value="' + escapeHtml(shop.note ?? '') + '" placeholder="备注">'
      + '<button id="shopEditSave">保存</button><button id="shopEditCancel">取消</button></div>'
      + '<div class="hint">品牌属于<strong>工作空间</strong>；改名不会改历史产品的品牌文本。</div></div>')
    + (shop.note === null ? '' : '<div class="hint" style="padding:0">' + escapeHtml(shop.note) + '</div>')
    + '<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip">产品 ' + shop.productCount + '</span>'
    + '<span class="chip">品牌 ' + shop.brandCount + '</span>'
    + '<span class="chip' + (shop.neverCount > 0 ? ' warn' : '') + '">从未采集 ' + shop.neverCount + '</span>'
    + '<span class="chip' + (shop.staleCount > 0 ? ' warn' : '') + '">过期 ' + shop.staleCount + '</span>'
    + '<span class="chip">竞品 ' + shop.competitorCount + '</span>'
    + '<span class="chip">最近采集 ' + escapeHtml(shopsTime(shop.lastCollectedAt)) + '</span>'
    + '</div>';

  if (readOnly) {
    return head + '<div class="hint">这家店已归档：产品、导入历史与竞品关系仍可读；新导入、自动采集与加竞品都被拒绝。恢复后恢复可写。</div>'
      + shopsProductsHtml(data) + shopsImportsHtml(data) + shopsCompetitorsHtml(data);
  }
  return head + shopsProductsHtml(data) + shopsImportHtml(data) + shopsCollectHtml(data) + shopsCompetitorsHtml(data);
}

function shopsProductsHtml(data) {
  const rows = (data.products || []).map(row => {
    const chip = row.collectState === 'never' ? '<span class="chip warn">从未采集</span>'
      : row.collectState === 'stale' ? '<span class="chip warn">过期</span>'
        : row.collectState === 'collecting' ? '<span class="chip">采集中</span>'
          : row.collectState === 'fresh' ? '<span class="chip ok">新鲜</span>'
            : '<span class="chip">无数据</span>';
    return '<tr>'
      + '<td><code>' + escapeHtml(row.asin) + '</code></td>'
      + '<td>' + escapeHtml(row.sku ?? '—') + '</td>'
      + '<td>' + escapeHtml(row.productName ?? '—') + '</td>'
      + '<td>' + escapeHtml(row.productLineName ?? '—') + '</td>'
      + '<td>' + escapeHtml(row.parentAsin) + '</td>'
      + '<td>' + escapeHtml(row.brand) + '</td>'
      + '<td>' + escapeHtml(row.marketplace) + '</td>'
      + '<td>' + chip + '</td>'
      + '<td>' + escapeHtml(shopsTime(row.lastCollectedAt)) + '</td>'
      + '<td><button data-shopcollectasin="' + escapeHtml(row.asin) + '" data-shopmarket="' + escapeHtml(row.marketplace) + '">采集这个</button>'
      + ' <button data-shopasin="' + escapeHtml(row.asin) + '" data-shopmarket="' + escapeHtml(row.marketplace) + '">看 ASIN 详情</button></td>'
      + '</tr>';
  }).join('');
  const filters = data.filters || {};
  const anyFilter = String(filters.shopBrand ?? '') !== '' || String(filters.shopLine ?? '') !== '' || String(filters.shopParent ?? '') !== '';
  const option = (value, label, selected) => '<option value="' + escapeHtml(value) + '"'
    + (String(selected) === String(value) ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  const brandOptions = (data.brandOptions || []).map(brand => option(brand, brand, filters.shopBrand)).join('');
  const lineOptions = (data.lineOptions || []).map(line => option(line.id, line.name, filters.shopLine)).join('');
  const parentOptions = (data.parents || []).map(parent => option(parent, parent, filters.shopParent)).join('');
  const shown = (data.products || []).length;
  const all = data.allProductCount ?? shown;
  return '<div class="rule-sect">产品（' + shown + (all !== shown ? ' / ' + all : '') + '）</div>'
    + '<div class="bar" style="flex-wrap:wrap">'
    + '<select id="shopBrandFilter"><option value="">全部品牌</option>' + brandOptions + '</select>'
    + '<select id="shopLineFilter"><option value="">全部产品线</option>' + lineOptions + '</select>'
    + '<select id="shopParentFilter"><option value="">全部父 ASIN</option>' + parentOptions + '</select>'
    + (anyFilter ? '<button id="shopFilterClear">清空筛选</button>' : '')
    + '<span class="hint" style="padding:0">SKU / 产品名 / 产品线来自产品表导入；未导入时显示「—」，不是 0。</span>'
    + '</div>'
    + '<div style="overflow-x:auto"><table><thead><tr><th>ASIN</th><th>SKU</th><th>产品名</th><th>产品线</th><th>父 ASIN</th><th>品牌</th><th>站点</th><th>采集状态</th><th>最近采集</th><th>操作</th></tr></thead><tbody>'
    + (rows === ''
      ? '<tr><td colspan="10">' + (anyFilter
        ? emptyState('filtered', { subject: '产品', next: '清掉品牌/产品线/父 ASIN 筛选就能看到全部产品。' })
        : emptyState('none', { subject: '产品', next: '去下面的「导入」分区导入这家店的产品。' })) + '</td></tr>'
      : rows)
    + '</tbody></table></div>'
    + '<div class="hint">「从未采集」与「过期」是两个不同的数；这里不把没采过写成 0 条。</div>';
}

function shopsImportHtml(data) {
  const files = shopsScan === null ? '' : ('<select id="shopFile">'
    + shopsScan.files.map(file => '<option value="' + escapeHtml(file.path) + '">' + escapeHtml(file.name) + '</option>').join('')
    + '</select>');
  const preview = shopsPreview === null ? '' : (() => {
    const plan = shopsPreview.plan;
    const counts = plan.counts;
    const pendingRows = plan.rows.filter(row => row.status !== 'ready').slice(0, 50).map(row => '<tr>'
      + '<td>' + row.line + '</td><td>' + escapeHtml(row.asin || '—') + '</td><td>' + escapeHtml(row.shopName || '—') + '</td>'
      + '<td>' + escapeHtml(shopLabel(row.status)) + '</td><td>' + escapeHtml(shopMissingText(row.missing)) + '</td></tr>').join('');
    return '<div class="bar" style="flex-wrap:wrap">'
      + '<span class="chip">总 ' + counts.total + '</span>'
      + '<span class="chip ok">可入库 ' + counts.ready + '</span>'
      + '<span class="chip">新增 ' + counts.create + '</span>'
      + '<span class="chip">更新 ' + counts.update + '</span>'
      + '<span class="chip warn">缺品牌 ' + counts.pendingBrand + '</span>'
      + '<span class="chip warn">缺店铺 ' + counts.pendingShop + '</span>'
      + '<span class="chip warn">重复 ' + counts.duplicate + '</span>'
      + '<span class="chip warn">站点未识别 ' + counts.unknownSite + '</span>'
      + '</div>'
      + '<button id="shopCommit"' + (counts.ready === 0 ? ' disabled' : '') + '>确认写入 ' + counts.ready + ' 条（新增 ' + counts.create + ' / 更新 ' + counts.update + '）</button>'
      + '<div style="overflow-x:auto"><table><thead><tr><th>行</th><th>ASIN</th><th>店铺</th><th>状态</th><th>原因</th></tr></thead><tbody>'
      + (pendingRows === '' ? '<tr><td colspan="5"><span class="hint">没有待补行</span></td></tr>' : pendingRows)
      + '</tbody></table></div>'
      + '<div class="hint">四段校验：店铺 + 品牌 + 父 ASIN + ASIN，缺一段就不入库。品牌属于工作空间，不是店铺专属。</div>';
  })();
  return '<div class="rule-sect">导入产品表（赛狐）</div>'
    + '<div class="bar"><button id="shopScan">扫描目录</button>' + files
    + '<input id="shopBrand" type="text" placeholder="这一批的品牌（必填）">'
    + '<button id="shopPreview">预览</button><span class="hint" id="shopImportHint" style="padding:0"></span></div>'
    + (shopsScan === null ? '' : '<div class="hint">目录：' + escapeHtml(shopsScan.dir) + ' · 文件 ' + shopsScan.files.length + ' 个</div>')
    + preview
    + shopsImportsHtml(data);
}

function shopsImportsHtml(data) {
  const rows = (data.imports || []).map(row => '<tr>'
    + '<td>' + escapeHtml(shopsTime(row.imported_at)) + '</td>'
    + '<td><code>' + escapeHtml(String(row.path).split(/[\\\\/]/).slice(-1)[0]) + '</code></td>'
    + '<td>' + row.rows_total + '</td><td>' + row.rows_written + '</td><td>' + row.rows_pending + '</td>'
    + '<td>' + escapeHtml(row.brand_batch || '—') + '</td></tr>').join('');
  return '<div class="rule-sect">导入历史</div>'
    + '<div style="overflow-x:auto"><table><thead><tr><th>时间</th><th>文件</th><th>总行</th><th>写入</th><th>待补</th><th>品牌</th></tr></thead><tbody>'
    + (rows === '' ? '<tr><td colspan="6"><span class="hint">这家店还没有导入批次。</span></td></tr>' : rows)
    + '</tbody></table></div>';
}

function shopsCollectHtml(data) {
  const products = data.products || [];
  const queue = products.filter(row => row.collectState === 'never' || row.collectState === 'stale');
  const fresh = products.filter(row => row.collectState === 'fresh').length;
  const collecting = products.filter(row => row.collectState === 'collecting').length;
  const preview = shopsCollect === null ? '' : ('<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip">有效 ASIN ' + shopsCollect.preview.valid + '</span>'
    + '<span class="chip">重复 ' + shopsCollect.preview.duplicates + '</span>'
    + '<span class="chip">无归属 ' + shopsCollect.preview.unsettled + '</span>'
    + '<span class="chip">页面请求 ' + shopsCollect.preview.requests + '</span>'
    + '<span class="chip">可复用快照 ' + shopsCollect.preview.fresh + '</span>'
    + '</div>'
    + '<div class="hint">' + escapeHtml(shopsCollect.preview.risk || '') + '</div>'
    + '<button id="shopCollectRun">提交采集（' + queue.length + ' 个）</button>');
  const result = shopsCollect !== null && shopsCollect.task !== null
    ? '<div class="hint">已提交，后台执行 · 已排队（task <code>' + escapeHtml(shopsCollect.task.id) + '</code>，状态 ' + escapeHtml(shopLabel(shopsCollect.task.status)) + '）</div>'
    : '';
  return '<div class="rule-sect">自动采集（未采集 / 过期）</div>'
    + '<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip warn">从未采集 ' + data.selected.neverCount + '</span>'
    + '<span class="chip warn">过期 ' + data.selected.staleCount + '</span>'
    + '<span class="chip ok">新鲜 ' + fresh + '</span>'
    + '<span class="chip">采集中 ' + collecting + '</span>'
    + '</div>'
    + '<button id="shopCollectPreview"' + (queue.length === 0 ? ' disabled' : '') + '>预览待采集（' + queue.length + ' 个）</button>'
    + preview + result
    + '<div class="hint">提交只代表<strong>任务已入队</strong>，不代表采集成功；状态以任务列表为准（done 才是完成，partial 会保留已采数据）。</div>';
}

function shopsCompetitorsHtml(data) {
  const parents = data.parents || [];
  const children = (data.products || []).filter(row => row.parentAsin !== row.asin);
  const parentOptions = parents.map(parent => '<option value="' + escapeHtml(parent) + '">' + escapeHtml(parent) + '</option>').join('');
  const childOptions = children.map(row => '<option value="' + escapeHtml(row.asin) + '">' + escapeHtml(row.asin + '（父 ' + row.parentAsin + '）') + '</option>').join('');
  const results = shopsBatch === null ? '' : ('<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip ok">新增 ' + shopsBatch.summary.added + '</span>'
    + '<span class="chip">已存在 ' + shopsBatch.summary.unchanged + '</span>'
    + '<span class="chip warn">拒绝 ' + shopsBatch.summary.rejected + '</span>'
    + '<span class="chip warn">批次内重复 ' + shopsBatch.summary.duplicate + '</span>'
    + '</div>'
    + '<div style="overflow-x:auto"><table><thead><tr><th>ASIN</th><th>结果</th><th>原因</th></tr></thead><tbody>'
    + shopsBatch.results.map(row => '<tr><td><code>' + escapeHtml(row.asin) + '</code></td><td>' + escapeHtml(shopLabel(row.status)) + '</td><td>' + escapeHtml(row.reason || '—') + '</td></tr>').join('')
    + '</tbody></table></div>');
  return '<div class="rule-sect">竞品（按父 ASIN 批量 / 单 ASIN）</div>'
    + '<div class="bar" style="flex-wrap:wrap">'
    + '<select id="shopParent">' + (parentOptions === '' ? '<option value="">（这家店还没有父 ASIN）</option>' : parentOptions) + '</select>'
    + '<select id="shopScope"><option value="family">按父 ASIN（family）</option><option value="child">单 ASIN（child）</option></select>'
    + '<select id="shopChild" hidden>' + (childOptions === '' ? '<option value="">（没有子 ASIN）</option>' : childOptions) + '</select>'
    + '</div>'
    + '<textarea id="shopCompetitors" rows="3" placeholder="一行一个竞品 ASIN，也接受逗号/空格分隔" style="width:100%"></textarea>'
    + '<div class="bar"><button id="shopAddCompetitors">添加竞品</button><span class="hint" id="shopCompetitorHint" style="padding:0"></span></div>'
    + results
    + '<div class="hint">一行一个竞品；重复是「已存在/未新增」，自竞品与自家产品会被拒绝并逐行说明。停用是 inactive，不删除。</div>';
}

/* ── 交互 ─────────────────────────────────────────────────────────────── */

function bindShopControls(data) {
  const openShop = (id) => patchContext({ module: 'shops', filters: { ...state.filters, shopId: id } });
  for (const row of $('shopsmain').querySelectorAll('tr[data-shoprow]')) {
    row.onclick = (event) => {
      if (event.target.closest('button') !== null) return;
      openShop(row.dataset.shoprow);
    };
  }
  for (const button of $('shopsmain').querySelectorAll('button[data-shopopen]')) {
    button.onclick = () => openShop(button.dataset.shopopen);
  }
  if ($('shopBack') !== null) $('shopBack').onclick = () => openShop('');
  if ($('shopSearch') !== null) {
    let shopSearchTimer = null;
    $('shopSearch').oninput = () => {
      if (shopSearchTimer !== null) clearTimeout(shopSearchTimer);
      shopSearchTimer = setTimeout(() => {
        patchContext({ module: 'shops', filters: { ...state.filters, shopQ: $('shopSearch').value } });
      }, 300);
    };
  }
  if ($('shopArchived') !== null) {
    $('shopArchived').onchange = () => patchContext({
      module: 'shops',
      filters: { ...state.filters, shopsArchived: $('shopArchived').checked ? '1' : '' },
    });
  }
  /* G3/G5：品牌 / 产品线 / 父 ASIN 筛选。三个下拉都写同一个 filters 对象，
     一次只改自己的键，其他键原样保留。 */
  for (const [id, key] of [['shopBrandFilter', 'shopBrand'], ['shopLineFilter', 'shopLine'], ['shopParentFilter', 'shopParent']]) {
    if ($(id) !== null) {
      $(id).onchange = () => patchContext({
        module: 'shops',
        filters: { ...state.filters, [key]: $(id).value },
      });
    }
  }
  if ($('shopFilterClear') !== null) {
    $('shopFilterClear').onclick = () => patchContext({
      module: 'shops',
      filters: { ...state.filters, shopBrand: '', shopLine: '', shopParent: '' },
    });
  }
  if ($('shopNew') !== null) $('shopNew').onclick = () => { $('shopNewForm').hidden = false; };
  if ($('shopNewCancel') !== null) $('shopNewCancel').onclick = () => { $('shopNewForm').hidden = true; };
  if ($('shopNewSave') !== null) $('shopNewSave').onclick = () => shopsSaveShop({
    name: $('shopNewName').value,
    marketplace: $('shopNewMarket').value,
    note: $('shopNewNote').value,
    brand: $('shopNewBrand').value,
  });
  if ($('shopArchive') !== null) $('shopArchive').onclick = () => {
    if (!window.confirm('归档这家店？产品、导入与竞品关系都会保留，但新导入/采集/加竞品会被拒绝；可在「含已归档」里恢复。')) return;
    shopsArchive(data.selected.id, 'archive');
  };
  if ($('shopRestore') !== null) $('shopRestore').onclick = () => shopsArchive(data.selected.id, 'restore');
  if ($('shopEdit') !== null) $('shopEdit').onclick = () => { $('shopEditForm').hidden = false; };
  if ($('shopEditCancel') !== null) $('shopEditCancel').onclick = () => { $('shopEditForm').hidden = true; };
  if ($('shopEditSave') !== null) $('shopEditSave').onclick = () => shopsSaveShop({
    id: data.selected.id,
    name: $('shopEditName').value,
    marketplace: $('shopEditMarket').value,
    note: $('shopEditNote').value,
  });
  if ($('shopScan') !== null) $('shopScan').onclick = () => shopsPost('product-import', { action: 'scan' }).then(reply => {
    shopsScan = reply;
    shopsPreview = null;
    renderShops();
  }).catch(showPageError);
  if ($('shopPreview') !== null) $('shopPreview').onclick = () => {
    const file = $('shopFile');
    const path = file === null ? '' : file.value;
    if (path === '') { $('shopImportHint').textContent = '先扫描目录选一份文件'; return; }
    shopsPost('product-import', {
      action: 'preview', path, shopId: data.selected.id, brand: $('shopBrand').value,
    }).then(reply => {
      shopsPreview = reply;
      renderShops();
    }).catch(showPageError);
  };
  if ($('shopCommit') !== null) $('shopCommit').onclick = () => {
    if (shopsPreview === null) return;
    if (!window.confirm('确认写入 ' + shopsPreview.plan.counts.ready + ' 条产品？更新已存在的归属不会新增行。')) return;
    shopsPost('product-import', {
      action: 'commit', path: shopsPreview.path, shopId: data.selected.id, brand: $('shopBrand').value,
    }).then(() => {
      shopsPreview = null;
      shopsScan = null;
      return refresh();
    }).catch(showPageError);
  };
  if ($('shopCollectPreview') !== null) $('shopCollectPreview').onclick = () => {
    const targets = (data.products || [])
      .filter(row => row.collectState === 'never' || row.collectState === 'stale')
      .map(row => ({ asin: row.asin, marketplace: row.marketplace, side: 'self' }));
    shopsPost('collect-preview', { targets, freshnessDays: data.freshnessDays }).then(reply => {
      shopsCollect = { preview: reply, task: null };
      renderShops();
    }).catch(showPageError);
  };
  if ($('shopCollectRun') !== null) $('shopCollectRun').onclick = () => {
    const targets = (data.products || [])
      .filter(row => row.collectState === 'never' || row.collectState === 'stale')
      .map(row => ({ asin: row.asin, marketplace: row.marketplace, side: 'self' }));
    shopsPost('collect-run', { targets, confirm: true, shopId: data.selected.id }).then(reply => {
      shopsCollect = { preview: shopsCollect === null ? {} : shopsCollect.preview, task: { id: reply.taskId ?? reply.task?.id ?? '—', status: reply.status ?? 'submitted' } };
      renderShops();
      return refresh();
    }).catch(showPageError);
  };
  for (const button of $('shopsmain').querySelectorAll('button[data-shopcollectasin]')) {
    button.onclick = () => shopsPost('collect-run', {
      targets: [{ asin: button.dataset.shopcollectasin, marketplace: button.dataset.shopmarket, side: 'self' }],
      confirm: true,
      shopId: data.selected.id,
    }).then(reply => {
      $('shopDetailHint').textContent = '已提交，后台执行 · 已排队（task ' + (reply.taskId ?? reply.task?.id ?? '—') + '）';
      return refresh();
    }).catch(showPageError);
  }
  for (const button of $('shopsmain').querySelectorAll('button[data-shopasin]')) {
    button.onclick = () => patchContext({
      module: 'asin',
      selection: { ...state.context.selection, asins: [{ asin: button.dataset.shopasin, marketplace: button.dataset.shopmarket }] },
      filters: { ...state.filters, shopId: data.selected.id },
    });
  }
  if ($('shopScope') !== null) {
    $('shopScope').onchange = () => { $('shopChild').hidden = $('shopScope').value !== 'child'; };
  }
  if ($('shopAddCompetitors') !== null) $('shopAddCompetitors').onclick = () => {
    const raw = String($('shopCompetitors').value || '').split(/[\\s,，]+/).map(part => part.trim()).filter(part => part !== '');
    if (raw.length === 0) { $('shopCompetitorHint').textContent = '先填竞品 ASIN'; return; }
    const scope = $('shopScope').value;
    shopsPost('competitor-batch-add', {
      marketplace: data.selected.marketplace || 'US',
      parentAsin: $('shopParent').value,
      scope,
      scopeAsin: scope === 'child' ? $('shopChild').value : '',
      competitors: raw,
      shopId: data.selected.id,
    }).then(reply => {
      shopsBatch = reply;
      renderShops();
    }).catch(showPageError);
  };
}

async function shopsPost(route, body) {
  return api(route, { method: 'POST', body: JSON.stringify(body) });
}

async function shopsSaveShop(body) {
  try {
    await api('shop-save', { method: 'POST', body: JSON.stringify(body) });
    if ($('shopNewForm') !== null) $('shopNewForm').hidden = true;
    if ($('shopEditForm') !== null) $('shopEditForm').hidden = true;
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

async function shopsArchive(id, action) {
  try {
    await api(action === 'archive' ? 'shop-archive' : 'shop-restore', {
      method: 'POST', body: JSON.stringify({ id, by: 'page' }),
    });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}
`;
