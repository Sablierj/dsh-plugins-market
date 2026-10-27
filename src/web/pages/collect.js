/**
 * 页签「collect」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const collectScript = `function renderCollect() {
  renderCollectEnv();
  renderCollectForm();
  renderCollectWaiting();
  /* The task list is the module's original body and stays one: it is the short
     answer to "what has run", and the thirteen sections are the long one. */
  renderTasks();
  /* 页尾两区（B-04c-2）：方案与计划管的是「以后怎么采」，不是这一次的结果，所以画在
     三栏之外。它们**不是惰性的**：两张表在服务端都是全量（方案按 200 行上限、计划更小），
     而它们在页面上没有折叠开关 —— 一个折叠着但已经取回来的切片，比多几百字节更值得。 */
  renderCollectSchemes();
  renderCollectPlans();
  /* P1-4：预估与实际的对账。放在页尾，因为它是**回顾性**的 ——
     不参与"这一次怎么采"的决定，但它是"上次那个预估能不能信"的唯一答案。 */
  renderCollectAudit();
  /* Row clicks are wired by index, not by a data attribute: the row markup carries
     a highlight class the recent-runs assertions match on literally, and adding an
     attribute there would change markup they pin. The order here is the order
     renderTasks drew, because both come from the same array. */
  const tasks = state.tasks || [];
  const rows = $('tasks').querySelectorAll('tbody tr');
  rows.forEach((row, index) => {
    const task = tasks[index];
    if (task === undefined) return;
    row.onclick = () => collectSelectTask(task.id);
  });
  renderCollectDetail();
  const asinRows = $('collectDetail').querySelectorAll('[data-collect-asin]');
  asinRows.forEach(row => {
    row.onclick = () => {
      const parts = String(row.dataset.collectAsin || '').split('|');
      const selected = (state.collectPanel || {}).selectedTask || null;
      const taskId = selected === null ? String((state.filters || {}).taskId ?? '') : String(selected.taskId);
      if (parts.length !== 2 || taskId === '') return;
      collectSelectAsin(taskId, parts[0], parts[1]);
    };
  });
  /* T53：采集页只保留「状态 / 失败原因 / 次数」，不再展开完整内容或 raw。
     唯一的下钻是 ASIN 详情，所以这里只绑那一扇门。 */
  for (const button of $('collectDetail').querySelectorAll('[data-open-asin]')) {
    button.onclick = (event) => {
      event.stopPropagation();
      const parts = String(button.dataset.openAsin || '').split('|');
      if (parts.length !== 2) return;
      patchContext({ module: 'asin', selection: { asins: [{ asin: parts[0], marketplace: parts[1] }] } });
    };
  }
}

/**
 * 采集质量汇总（T53）。
 *
 * 只从现有 state 派生，不新增服务端切片：任务成功率来自 state.tasks 的状态与
 * 目标数，节覆盖/blocked/failed 来自选中任务的逐 ASIN 摘要，耗时来自
 * progressView.elapsedMinutes。**请求数没有来源**——本仓没有逐任务请求计数，
 * 所以写「未记录」并给出可核对的目标数，不拿一个 0 冒充分母。
 */
function collectQualityHtml() {
  /* T66（B2 同类）：任务没取到（null）时汇总**算不出来** —— 用空数组兜底会把它算成
     「合计 0 个目标 / 0%」，那是把「没取到」画成「读到 0」。空数组才是读到的真空。 */
  if (state.tasks === null || state.tasks === undefined) {
    return '<div class="collect-card" style="margin-top:8px" aria-label="采集质量汇总">'
      + '<h3>采集质量汇总</h3>'
      + emptyState('not-recorded', {
        subject: '任务',
        reason: '服务端没有给「任务」这一格 —— 汇总算不出来，这不是「合计 0 个」。',
        next: '点右上角「重新读取」；一直缺，就是载荷漏了这一格。',
      })
      + '</div>';
  }
  const tasks = state.tasks;
  const terminal = tasks.filter(task => ['done', 'partial', 'failed', 'cancelled'].includes(String(task.status)));
  const done = terminal.filter(task => String(task.status) === 'done').length;
  const successRate = terminal.length === 0 ? null : Math.round((done / terminal.length) * 100);
  const targetSum = tasks.reduce((sum, task) => sum + Number(task.targetsCount ?? 0), 0);
  const durations = tasks
    .map(task => (task.progressView || {}).elapsedMinutes)
    .filter(value => typeof value === 'number' && Number.isFinite(value));
  const elapsed = durations.reduce((sum, value) => sum + value, 0);

  const panel = state.collectPanel || {};
  const selected = panel.selectedTask || null;
  const summaries = selected !== null && Array.isArray(selected.summaries) ? selected.summaries : [];
  const totals = { collected: 0, missing: 0, partial: 0, failed: 0, blocked: 0 };
  for (const entry of summaries) {
    for (const key of Object.keys(totals)) totals[key] += Number((entry.summary || {})[key] ?? 0);
  }
  const attempted = totals.collected + totals.missing + totals.partial + totals.failed + totals.blocked;
  const coverage = attempted === 0 ? null : Math.round((totals.collected / attempted) * 100);

  const row = (label, value, note) => '<div class="collect-quality-row">'
    + '<span class="q-label">' + escapeHtml(label) + '</span>'
    + '<span class="q-value">' + escapeHtml(value) + '</span>'
    + '<span class="hint" style="padding:0">' + escapeHtml(note) + '</span></div>';

  return '<div class="collect-card" style="margin-top:8px" aria-label="采集质量汇总">'
    + '<h3>采集质量汇总</h3>'
    + '<div class="collect-quality">'
    + row('任务成功率', successRate === null ? '—' : successRate + '%', 'done / 已结束（' + done + '/' + terminal.length + '）')
    + row('节覆盖率', coverage === null ? '—' : coverage + '%',
      selected === null ? '选中任务后可见' : '已采到 / 有结果的节（' + totals.collected + '/' + attempted + '）')
    + row('blocked / failed', totals.blocked + ' / ' + totals.failed,
      selected === null ? '选中任务后可见' : '选中任务的节结果合计')
    + row('请求数', '未记录', '本仓没有逐任务请求计数；目标 ASIN 合计 ' + targetSum + ' 个')
    + row('耗时', durations.length === 0 ? '未记录' : elapsed + ' 分钟',
      durations.length === 0 ? '没有带 elapsedMinutes 的任务' : durations.length + ' 个任务有耗时')
    + '</div></div>';
}

/* ── 优化提示词专区 ───────────────────────────────────────────────────── */

/* The editor: the list is every set and its rows, the form edits the selected
   one. The page writes one fact at a time ("this prompt is now this") and then
   re-reads state, so nothing here has to merge a partial edit — the same rule
   the rule toggle and the policy link follow. The preview is a POST to the
   server rather than a renderer in the page, for the reason above. */

function layerText(layer) {
  if (layer === 'fixed') return '固定策略';
  if (layer === 'evidence') return '证据';
  if (layer === 'contract') return '输出契约';
  return '—';
}

function promptRowHtml(row) {
  const selected = row.id === state.selectedPromptId ? ' sel' : '';
  const missing = row.missing || { degraded: false, missingRequired: [], droppedOptional: [] };
  /* 「改过 N 次」而不是「vN」：prompt.version 是编辑计数，正文保存时原地覆盖，
     旧稿读不到 —— 写成 vN 会让读者以为有 v1/v2 可看。 */
  const meta = (row.scenario === 'assemble' ? '组装 · ' + layerText(row.layer) : '按钮')
    + ' · 改过 ' + row.version + ' 次' + (row.enabled ? '' : ' · 停用');
  const flag = missing.degraded
    ? '<span class="chip warn">缺必填</span>'
    : (missing.droppedOptional.length > 0 ? '<span class="chip">含可选段</span>' : '');
  return '<div class="prompt-row' + selected + '" data-prompt="' + escapeHtml(row.id) + '">'
    + '<span class="plabel">' + escapeHtml(row.label) + '</span>'
    + flag
    + '<span class="pmeta">' + escapeHtml(meta) + '</span></div>';
}

/* §5 / §12.2：变量要能说明来源、必填性和缺失行为。表格由服务端下发的注册表驱动，
   页面不自己抄一份变量清单（抄一份就是第二个会漂的真相）。 */
function promptVariablesHtml(data, selected) {
  const registry = (data && data.registry) || [];
  const missing = (selected && selected.missing)
    || { degraded: false, missingRequired: [], droppedOptional: [] };
  const missingNames = new Set(missing.missingRequired.map(item => item.name));
  const rows = registry.map(spec => '<tr>'
    + '<td><code>' + escapeHtml(spec.name) + '</code></td>'
    + '<td>' + (missingNames.has(spec.name)
      ? '<span class="chip warn">缺失</span>'
      : '<span class="chip">' + (spec.required ? '必填' : '可选') + '</span>') + '</td>'
    + '<td>' + escapeHtml(spec.description || '') + '</td>'
    + '<td>' + escapeHtml(spec.source || '') + '</td>'
    + '<td>' + escapeHtml(String(spec.maxLength)) + (spec.sensitive ? ' · 敏感' : '') + '</td>'
    + '<td>' + escapeHtml(spec.defaultBehavior || '') + '</td>'
    + '<td>' + escapeHtml(spec.missingBehavior || '') + '</td>'
    + '</tr>').join('');
  let warn = '';
  if (missing.degraded) {
    warn = '<div class="hint" style="color:var(--warn)">⚠️ 必填变量缺失：'
      + escapeHtml(missing.missingRequired.map(item => item.name).join('、'))
      + ' —— 这一段现在是空的，不是提示词选择了不说。</div>';
  } else if (missing.droppedOptional.length > 0) {
    warn = '<div class="hint">可选段被整段移除：'
      + escapeHtml(missing.droppedOptional.map(item => item.name).join('、'))
      + '（设计内降级，不是缺失；给了值就会回来）。</div>';
  }
  return '<div class="rule-sect">变量（来源 / 必填 / 默认行为 / 缺失行为）</div>' + warn
    + '<table><thead><tr><th>变量</th><th>必填</th><th>业务解释</th><th>来源</th><th>上限</th>'
    + '<th>默认行为</th><th>缺失行为</th></tr></thead>'
    + '<tbody>' + (rows === '' ? '<tr><td colspan="7" class="hint">（注册表为空）</td></tr>' : rows)
    + '</tbody></table>';
}
`
