/**
 * 页签「policy」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const policyScript = `function renderPolicy() {
  const data = state.policy;
  if (!data) { $('policytable').innerHTML = ''; return; }

  /* The controls mirror the filters the server applied, so the select does not
     claim a filter the payload ignored. */
  $('policyStatus').value = (data.filters && data.filters.status) || '';
  $('policySince').value = (data.filters && data.filters.since) || '';

  const s = data.stats;
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + '">'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + '</span>';
  $('policyHint').textContent = data.sinceExcluded > 0
    ? '另有 ' + data.sinceExcluded + ' 条生效日期未识别，无法判断是否命中，未计入'
    : '';
  $('policystats').innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('共', s.total)
    + chip('生效中', s.active, 'ok')
    + chip('已被取代', s.superseded)
    + chip('已挂规则', s.linked)
    + chip('严重度未判定', s.unjudged, s.unjudged > 0 ? 'warn' : '')
    + chip('生效日期未识别', s.unknownEffective, s.unknownEffective > 0 ? 'warn' : '')
    + '</div>';

  renderPolicyCandidates(data);

  if (data.rows.length === 0) {
    /* 两种零分开：库里有政策但被「未识别生效日期」的筛选排掉了，与库真的空，
       下一步完全不同 —— 前者去放宽筛选，后者先去导一条。 */
    const excludedByFilter = data.total === 0 && data.sinceExcluded > 0;
    $('policytable').innerHTML = excludedByFilter
      ? emptyState('filtered', {
        subject: '政策',
        reason: '当前筛选把未识别生效日期的政策排除了 —— 库里有这类政策，但它们的日期读不出来，按 since 筛时一条都不剩。',
        next: '去掉日期筛选，或者先给那些政策补上生效日期。',
      })
      : emptyState('not-recorded', {
        subject: '政策',
        next: '在对话里把一段政策粘贴给 agent，例如「把这段亚马逊政策解析入库：…」，它会调 amzn_policy_import。',
      });
    $('policydetail').innerHTML = '';
    return;
  }

  $('policytable').innerHTML = '<table><thead><tr><th>状态</th><th>生效</th><th>站点</th>'
    + '<th>严重度</th><th>标题</th><th>来源</th><th>取代</th><th>影响规则</th></tr></thead><tbody>'
    + data.rows.map(row => '<tr data-policy="' + escapeHtml(row.id) + '">'
      + '<td>' + policyStatusChip(row.status) + '</td>'
      + '<td>' + (row.effectiveFrom ? escapeHtml(row.effectiveFrom) : '<span class="chip">未判定</span>') + '</td>'
      + '<td>' + (row.marketplace ? escapeHtml(row.marketplace) : '<span class="chip">未判定</span>') + '</td>'
      + '<td>' + severityChip(row.severityHint, row.severityRaw) + '</td>'
      + '<td title="' + escapeHtml(row.title) + '">' + escapeHtml(row.title) + '</td>'
      + '<td>' + escapeHtml(row.sourceName || row.sourceId) + '</td>'
      + '<td>' + supersedeCell(row) + '</td>'
      + '<td>' + (row.rules.length === 0 ? '' : row.rules.length) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';

  for (const tr of $('policytable').querySelectorAll('tbody tr')) {
    tr.onclick = () => { state.selectedPolicyId = tr.dataset.policy; renderPolicyDetail(data); };
  }
  renderPolicyDetail(data);
}

/* The selected policy, its affected fields, and the rule links. A policy that is
   in the list but no longer selected (after a filter change) falls back to the
   first row rather than drawing an empty detail under a full table. */
function renderPolicyDetail(data) {
  const rows = data.rows;
  const selected = rows.find(row => row.id === state.selectedPolicyId) || rows[0];
  if (!selected) { $('policydetail').innerHTML = ''; return; }
  state.selectedPolicyId = selected.id;

  const linked = new Set(selected.rules);
  const candidates = (data.rules || []).filter(rule => !linked.has(rule.id));

  const chips = selected.rules.length === 0
    ? '<span class="opt-meta">还没有关联任何规则 —— 选一条规则点「关联」。</span>'
    : selected.rules.map(id => '<span class="chip ok">' + escapeHtml(id)
      + ' <button data-unlink="' + escapeHtml(id) + '" title="解除关联" style="border:none;background:none;color:inherit;cursor:pointer">×</button>'
      + '</span>').join(' ');

  const options = candidates.map(rule => '<option value="' + escapeHtml(rule.id) + '">'
    + escapeHtml(rule.id) + ' · ' + escapeHtml(rule.title) + '</option>').join('');

  const fields = (selected.fields || []).length > 0
    ? selected.fields.map(field => '<span class="chip">' + escapeHtml(field) + '</span>').join(' ')
    : '<span class="opt-meta">（未声明影响字段）</span>';

  $('policydetail').innerHTML = '<div class="bar" style="border-top:1px solid var(--line)">'
    + '<strong style="font-size:12px">' + escapeHtml(selected.title) + '</strong>'
    + policyStatusChip(selected.status)
    + severityChip(selected.severityHint, selected.severityRaw)
    + (selected.url ? '<a href="' + escapeHtml(selected.url) + '" target="_blank" rel="noreferrer">原文 ↗</a>' : '')
    + '<span class="opt-meta" style="margin-left:auto">来源 ' + escapeHtml(selected.sourceName || selected.sourceId)
    + (selected.sourceKind ? '（' + escapeHtml(selected.sourceKind) + '）' : '') + '</span>'
    + '</div>'
    + '<div class="rule-sect">生效 ' + escapeHtml(selected.effectiveFrom || '未判定')
    + ' · 失效 ' + escapeHtml(selected.effectiveTo || '未判定')
    + ' · 发布 ' + escapeHtml(selected.publishedAt || '未判定')
    + ' · 入库 ' + escapeHtml(shortTime(selected.importedAt))
    + (selected.supersededBy ? ' · 已被 ' + escapeHtml(String(selected.supersededBy).slice(0, 8)) + ' 取代' : '')
    + ((selected.supersedes && selected.supersedes.length > 0)
      ? ' · 取代了 ' + escapeHtml(selected.supersedes.map(id => String(id).slice(0, 8)).join('、'))
      : '')
    + '</div>'
    + '<div class="rule-sect">影响字段: ' + fields + '</div>'
    + '<div class="rule-sect">受政策影响的规则（点 × 解除，或用下面这条下拉框再关联一条）</div>'
    + '<div class="bar" style="border-top:1px solid var(--line);border-bottom:none">' + chips + '</div>'
    + '<div class="bar" style="border-bottom:none">'
    + '<select id="policyRuleAdd">' + (options === '' ? '<option value="">（全部规则都已关联）</option>' : options) + '</select>'
    + '<button id="policyRuleLink"' + (options === '' ? ' disabled' : '') + '>关联</button>'
    + '<span class="hint" style="padding:0">单事实、可逆：这一次 POST 把「这条政策的规则集」写成你看到的样子。</span>'
    + '</div>'
    + (selected.body ? '<div class="policy-body">' + escapeHtml(selected.body) + '</div>' : '');

  for (const button of $('policydetail').querySelectorAll('button[data-unlink]')) {
    button.onclick = (event) => {
      event.stopPropagation();
      linkPolicy(selected.id, selected.rules.filter(id => id !== button.dataset.unlink));
    };
  }
  const add = $('policyRuleLink');
  if (add) {
    add.onclick = () => {
      const select = $('policyRuleAdd');
      if (!select || select.value === '') return;
      linkPolicy(selected.id, [...selected.rules, select.value]);
    };
  }
}

/* The page's own POST, straight to /api/policy-link — the same store function
   amzn_policy_link calls, so the two paths cannot disagree about what linked means. */
async function linkPolicy(policyId, ruleIds) {
  try {
    await api('policy-link', { method: 'POST', body: JSON.stringify({ policyId, ruleIds }) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* ── 检查最新政策（T72 四步链路）────────────────────────────────────────── */

/* The mount point is created here rather than added to page.js: this slice owns
   the candidate area and page.js is a shared file. A missing slice must not read
   as "no new policy" — the caller renders that state explicitly below. */
function policyCandidateMount() {
  let box = $('policycandidates');
  if (box) return box;
  const stats = $('policystats');
  if (!stats || !stats.parentNode) return null;
  box = document.createElement('div');
  box.id = 'policycandidates';
  stats.parentNode.insertBefore(box, stats.nextSibling);
  return box;
}

function policyCandidateStatusChip(status) {
  if (status === 'candidate') return '<span class="chip warn">待确认</span>';
  if (status === 'confirmed') return '<span class="chip ok">已确认入库</span>';
  if (status === 'rejected') return '<span class="chip">已驳回</span>';
  return '<span class="chip">' + escapeHtml(String(status || '未记')) + '</span>';
}

function policyRunStatusChip(status) {
  if (status === 'pending_confirm') return '<span class="chip warn">待确认</span>';
  if (status === 'confirmed') return '<span class="chip ok">已确认</span>';
  if (status === 'rejected') return '<span class="chip">已驳回</span>';
  if (status === 'failed') return '<span class="chip stop">失败</span>';
  if (status === 'running') return '<span class="chip">检索中</span>';
  return '<span class="chip">' + escapeHtml(String(status || '未记')) + '</span>';
}

/* Machine-readable differences only. The note under each block says what the
   comparison is (verbatim excerpt + dates), so a reader does not mistake it for
   a semantic judgement this version does not make. */
function policyCandidateDiffHtml(diff) {
  const differences = (diff && diff.differences) || [];
  const notes = (diff && diff.notes) || [];
  let html = '';
  if (differences.length > 0) {
    html += '<div class="rule-sect">机器可读差异 ' + differences.length + ' 条（逐条原文比对，不是语义判断）</div>';
    html += differences.map(item => '<div><span class="chip warn">' + escapeHtml(item.kind || 'diff') + '</span>'
      + '<span>' + escapeHtml(item.message || '') + '</span></div>').join('');
  } else {
    html += '<div class="opt-meta">没有机器可读差异。</div>';
  }
  if (notes.length > 0) {
    html += '<div class="opt-meta">' + notes.map(item => escapeHtml(item.message || item.kind || '')).join('；') + '</div>';
  }
  return html;
}

function policyCandidateRowHtml(row, data) {
  const title = row.sourceUrl
    ? '<a href="' + escapeHtml(row.sourceUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(row.sourceTitle) + '</a>'
    : escapeHtml(row.sourceTitle);
  let actions = '';
  if (row.status === 'candidate') {
    const rules = (data.rules || []).map(rule => '<option value="' + escapeHtml(rule.id) + '">'
      + escapeHtml(rule.id) + '</option>').join('');
    actions = '<div class="bar" style="border-bottom:none;flex-wrap:wrap">'
      + '<select id="policyCandidateRule-' + escapeHtml(row.id) + '" multiple size="3"'
      + ' title="可选：确认入库时同时挂规则（Ctrl 多选）">' + rules + '</select>'
      + '<button data-policy-confirm="' + escapeHtml(row.id) + '">确认入库</button>'
      + '<button data-policy-reject="' + escapeHtml(row.id) + '">驳回</button>'
      + '</div>';
  } else if (row.status === 'confirmed') {
    actions = '<div class="opt-meta">已确认入库 → policy ' + escapeHtml(String(row.policyId || '（未记）'))
      + ' · 确认人 ' + escapeHtml(row.confirmedBy || '（未记）')
      + ' · ' + escapeHtml(shortTime(row.confirmedAt))
      + (row.decisionReason ? ' · 理由 ' + escapeHtml(row.decisionReason) : '')
      + '</div>';
  } else if (row.confirmedBy === 'system') {
    /* LINK_FAILED 的中间态：policy 行已回滚，但候选必须以「系统失败」可见，
       不能长得像一次人工驳回。 */
    actions = '<div class="opt-meta"><span class="chip stop">系统失败（不是人工驳回）</span> '
      + escapeHtml(shortTime(row.confirmedAt))
      + ' · ' + escapeHtml(row.decisionReason || '（未记）') + '</div>';
  } else {
    actions = '<div class="opt-meta">已驳回 · 驳回人 ' + escapeHtml(row.confirmedBy || '（未记）')
      + ' · ' + escapeHtml(shortTime(row.confirmedAt))
      + ' · 理由 ' + escapeHtml(row.decisionReason || '（未记）') + '</div>';
  }
  return '<div class="rule-sect" style="border-top:1px solid var(--line)">'
    + '<div class="bar" style="border-bottom:none;flex-wrap:wrap">'
    + '<strong style="font-size:12px">' + title + '</strong>'
    + policyCandidateStatusChip(row.status)
    + '<span class="opt-meta" style="margin-left:auto">检索于 ' + escapeHtml(shortTime(row.retrievedAt))
    + ' · query「' + escapeHtml(row.query) + '」</span>'
    + '</div>'
    + (row.sourceUrl
      ? '<div class="opt-meta">' + escapeHtml(row.sourceUrl) + '</div>'
      : '<div class="opt-meta">（来源链接未记）</div>')
    + '<div class="policy-body">' + escapeHtml(row.snippet || '（这条结果没有原文片段 —— 片段为空不是「没有内容」，是搜索源没给）') + '</div>'
    + policyCandidateDiffHtml(row.diff)
    + actions
    + '</div>';
}

function renderPolicyCandidates(data) {
  const box = policyCandidateMount();
  if (!box) return;
  const candidates = data.candidates;
  if (candidates === undefined || candidates === null) {
    /* A missing slice is not "no new policy" — say which of the two it is. */
    box.innerHTML = '<div class="rule-sect">检查最新政策（四步链路）</div>'
      + '<div class="hint">候选区这一格没有数据 —— 不是「没有新政策」，是「这一格没读到」。'
      + '服务端这次没有下发 candidates（S2-T72 路由待接）。</div>';
    return;
  }

  /* Named policyRun, not run: the optimize page's field-extractor scans the
     whole script for run.<field> and would read these as fields of the optimize
     run payload (which has no observedAt). The name collision is the bug, not a
     missing payload field. */
  const policyRun = candidates.latestRun;
  const rows = candidates.rows || [];
  const counts = candidates.counts || { total: 0, candidate: 0, confirmed: 0, rejected: 0 };
  const defaultQuery = candidates.defaultQuery || 'Amazon seller central policy update';

  let html = '<div class="bar" style="border-top:1px solid var(--line);flex-wrap:wrap">'
    + '<strong style="font-size:12px">检查最新政策</strong>'
    + '<input id="policyCheckQuery" style="min-width:260px" value="' + escapeHtml(defaultQuery) + '" title="检索用的 query">'
    + '<input id="policyCandidateBy" style="width:120px" value="page" title="操作人（自述标签，不是账号）">'
    + '<button id="policyCheckStart">检索最新政策</button>'
    + '<span class="opt-meta" id="policyCheckBusy"></span>'
    + '</div>'
    + '<div class="hint">摘要是搜索结果的原文片段，不是本插件生成的总结。'
    + '检索到的只是候选证据：不点「确认入库」，一条也不会进政策库。</div>';

  if (policyRun === null) {
    html += '<div class="rule-sect">还没检索过最新政策 —— 点「检索最新政策」开始。</div>';
    box.innerHTML = html;
    wirePolicyCandidateControls(box);
    return;
  }

  const durationText = policyRun.durationMs === null || policyRun.durationMs === undefined
    ? '耗时未记'
    : '耗时 ' + (Number(policyRun.durationMs) / 1000).toFixed(1) + ' 秒';
  const baseMeta = '检索于 ' + escapeHtml(shortTime(policyRun.observedAt))
    + ' · query「' + escapeHtml(policyRun.query) + '」';

  if (policyRun.status === 'failed') {
    /* 失败态不印「返回 N 条源」：失败就是没有源，不能把「0 条」说得像一次成功的检索。 */
    html += '<div class="rule-sect">' + baseMeta + ' · 状态 失败</div>'
      + '<div class="rule-sect"><span class="chip stop">检索失败</span> '
      + escapeHtml(policyRun.error || '（没有记录原因）') + '</div>'
      + '<div class="hint">检索失败 ≠ 没有新政策：这次没查到，不代表不存在。修好通道后重试会开一次新的 run。</div>';
    box.innerHTML = html;
    wirePolicyCandidateControls(box);
    return;
  }

  if (policyRun.status === 'running') {
    /* 「还在跑」不是「跑完了没有结果」：running + 0 行绝不能落到下面的 0 条文案。 */
    const startedAt = Date.parse(policyRun.observedAt || '');
    const waitedSec = Number.isFinite(startedAt) ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null;
    html += '<div class="rule-sect">' + baseMeta + ' · 状态 检索中</div>'
      + '<div class="rule-sect"><span class="chip warn">检索中</span> '
      + (waitedSec === null ? '已等待时长未记' : '已等待 ' + waitedSec + ' 秒')
      + ' —— 真实通道通常 10–20 秒，最长等 45 秒。结果还没回来，不是「没有结果」。</div>';
    box.innerHTML = html;
    wirePolicyCandidateControls(box);
    return;
  }

  html += '<div class="rule-sect">' + baseMeta
    + ' · 返回 ' + Number(policyRun.sourceCount || 0) + ' 条源'
    + ' · 候选 ' + Number(counts.total || 0) + ' 条'
    + ' · 差异 ' + Number(policyRun.diffCount || 0) + ' 条'
    + ' · ' + escapeHtml(durationText)
    + '</div>';

  html += '<div class="bar" style="border-bottom:none">'
    + '<span class="chip">待确认 ' + counts.candidate + '/' + counts.total + '</span>'
    + '<span class="chip ok">已确认 ' + counts.confirmed + '/' + counts.total + '</span>'
    + '<span class="chip">已驳回 ' + counts.rejected + '/' + counts.total + '</span>'
    + '</div>';

  if (rows.length === 0) {
    html += policyRun.sourceCount === 0
      ? '<div class="rule-sect">检索完成，返回 0 条结果 —— 这不等于「没有新政策」，也不等于检索失败。</div>'
      : '<div class="rule-sect">返回 ' + Number(policyRun.sourceCount || 0)
        + ' 条源，但没有一条能成为候选（缺标题或重复的被跳过）。</div>';
  } else {
    html += rows.map(row => policyCandidateRowHtml(row, data)).join('');
  }

  /* 每次运行留痕可查（PRD AC②）：最近 5 次 run 的时刻/状态/源数/差异数/确认人。
     只画一次 run 的候选是不够的 —— 新一轮开始后，上一轮确认过什么就看不见了。 */
  const history = candidates.recentRuns || [];
  if (history.length > 1) {
    html += '<div class="rule-sect">运行历史（最近 ' + history.length + ' 次）</div>'
      + '<table><thead><tr><th>时刻</th><th>状态</th><th>query</th><th>源</th><th>差异</th><th>确认人</th></tr></thead><tbody>'
      + history.map(item => '<tr>'
        + '<td>' + escapeHtml(shortTime(item.observedAt)) + '</td>'
        + '<td>' + policyRunStatusChip(item.status) + '</td>'
        + '<td title="' + escapeHtml(item.query) + '">' + escapeHtml(item.query) + '</td>'
        + '<td>' + Number(item.sourceCount || 0) + '</td>'
        + '<td>' + Number(item.diffCount || 0) + '</td>'
        + '<td>' + escapeHtml(item.confirmedBy || '（未记）') + '</td>'
        + '</tr>').join('')
      + '</tbody></table>';
  }

  box.innerHTML = html;
  wirePolicyCandidateControls(box);
}

function wirePolicyCandidateControls(box) {
  const start = document.getElementById('policyCheckStart');
  if (start) start.onclick = () => postPolicyCheckStart();
  for (const button of box.querySelectorAll('button[data-policy-confirm]')) {
    button.onclick = () => postPolicyCandidateConfirm(button.dataset.policyConfirm);
  }
  for (const button of box.querySelectorAll('button[data-policy-reject]')) {
    button.onclick = () => postPolicyCandidateReject(button.dataset.policyReject);
  }
}

function policyCandidateByValue() {
  const input = document.getElementById('policyCandidateBy');
  const value = input ? String(input.value || '').trim() : '';
  return value === '' ? 'page' : value;
}

async function postPolicyCheckStart() {
  const input = document.getElementById('policyCheckQuery');
  const query = input ? String(input.value || '').trim() : '';
  if (query === '') {
    showPageError(new Error('检索 query 不能为空'));
    return;
  }
  const button = document.getElementById('policyCheckStart');
  const busy = document.getElementById('policyCheckBusy');
  if (button && button.disabled) return;
  /* Real SearXNG takes 10–20 s (cold: ~20 s). A button that looks unchanged for
     20 s reads as a dead page, so say what is happening and disable re-clicks. */
  if (button) {
    button.disabled = true;
    button.textContent = '检索中…';
  }
  if (busy) busy.textContent = '检索中（实测约 10–20 秒，最长等 45 秒），请勿重复点击';
  const scope = (state.context && state.context.scope) || {};
  try {
    await api('policy-check-start', {
      method: 'POST',
      body: JSON.stringify({ query: query, marketplace: scope.marketplace || null, limit: 8 }),
    });
  } catch (error) {
    showPageError(error);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '检索最新政策';
    }
    if (busy) busy.textContent = '';
    await refresh();
  }
}

async function postPolicyCandidateConfirm(candidateId) {
  const select = document.getElementById('policyCandidateRule-' + candidateId);
  const ruleIds = [];
  if (select) {
    for (const option of select.options) {
      if (option.selected) ruleIds.push(option.value);
    }
  }
  try {
    await api('policy-candidate-confirm', {
      method: 'POST',
      body: JSON.stringify({ candidateId: candidateId, ruleIds: ruleIds, by: policyCandidateByValue(), reason: '' }),
    });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

async function postPolicyCandidateReject(candidateId) {
  const asked = typeof window !== 'undefined' && typeof window.prompt === 'function'
    ? window.prompt('驳回理由（必填，会留痕）：')
    : '';
  const reason = asked === null || asked === undefined ? '' : String(asked).trim();
  if (reason === '') {
    showPageError(new Error('驳回必须填理由'));
    return;
  }
  try {
    await api('policy-candidate-reject', {
      method: 'POST',
      body: JSON.stringify({ candidateId: candidateId, reason: reason, by: policyCandidateByValue() }),
    });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* ── 优化队列 ─────────────────────────────────────────────────────────── */

/* 阻断 and 警告 are not two shades of the same thing. A block is something
   Amazon rejects or de-indexes; a warn is copy that is legal but weaker. They
   are chipped differently and the footer says so, because a panel that renders
   both in amber teaches the reader to treat "4 警告" as a reason not to ship. */
function violationChips(counts) {
  const block = counts?.block ?? 0;
  const warn = counts?.warn ?? 0;
  if (block === 0 && warn === 0) return '<span class="chip ok">无违规</span>';
  return (block > 0 ? '<span class="chip stop">阻断 ' + block + '</span>' : '')
    + (warn > 0 ? '<span class="chip warn">警告 ' + warn + '</span>' : '');
}

function shortTime(value) {
  if (!value) return '';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return String(value);
  return at.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/* The unit is part of the reading, not a detail: 249 is bytes for the backend
   field and characters for everything else, and 249 bytes of Chinese is about
   a third of 249 characters. A bar that said just "249" would invite exactly
   the mistake the budget exists to prevent. */
function budgetBar(budget) {
  const cls = budget.over ? ' over' : budget.under ? ' under' : '';
  const unit = budget.unit === 'bytes' ? ' 字节' : ' 字符';
  const note = budget.over
    ? '超 ' + (budget.used - budget.max) + unit
    : budget.under ? '少于 ' + budget.min : '剩 ' + budget.remaining;
  return '<span class="opt-meta" style="margin-left:auto">' + budget.used + '/' + budget.max + unit + ' · ' + note + '</span>'
    + '<span class="budget"><span class="fill' + cls + '" style="width:' + Math.round(budget.ratio * 100) + '%"></span></span>';
}

function violationLine(violation) {
  const blocking = violation.severity === 'block';
  return '<div>'
    + '<span class="chip ' + (blocking ? 'stop' : 'warn') + '">' + (blocking ? '阻断' : '警告') + '</span>'
    + '<code>' + escapeHtml(violation.ruleId ?? '') + '</code>'
    + '<span>' + escapeHtml((violation.messages || []).join('；')) + '</span>'
    + (violation.source ? '<span class="opt-meta">' + escapeHtml(violation.source) + '</span>' : '')
    + '</div>';
}

function draftCard(draft, budget) {
  const violations = draft.violations || [];
  const block = violations.filter(violation => violation.severity === 'block').length;
  /* 分组来自服务端（group / groupLabel 两个字段），页面不自己从 accepted 推一遍 ——
     那正是「先取服务端算好的、取不到就自己重算一遍」那个已修过的形状。
     accepted 仍然画，因为「人做过什么决定」与「这一行现在在哪个分组」是两件事：
     作废过的草案 accepted 可能还是 1，而它在「已作废」组里。 */
  const decision = draft.groupLabel
    ? '<span class="chip ' + (INBOX_GROUP_CHIPS[draft.group] || '') + '">' + escapeHtml(String(draft.groupLabel)) + '</span>'
    : '<span class="chip">分组未给出</span>';
  const blank = '<span class="opt-meta">（空）</span>';
  const focused = String((state.filters || {}).focusField ?? '').trim() === String(draft.field || '');
  return '<div class="opt' + (focused ? ' sel' : '') + '" id="draft-' + escapeHtml(String(draft.field || '')) + '">'
    + '<div class="opt-head">'
    + '<span class="opt-field">' + escapeHtml(draft.label) + '</span>'
    + decision
    + violationChips({ block, warn: violations.length - block })
    + (budget ? budgetBar(budget) : '')
    + '</div>'
    + '<div class="diff">'
    + '<div><h4>优化前</h4><p>' + (draft.before ? escapeHtml(draft.before) : blank) + '</p></div>'
    + '<div class="after"><h4>优化后</h4><p>' + (draft.after ? escapeHtml(draft.after) : blank) + '</p></div>'
    + '</div>'
    + (draft.rationale ? '<div class="hint" style="padding:9px 0 0">' + escapeHtml(draft.rationale) + '</div>' : '')
    + (violations.length === 0 ? '' : '<div class="viol">' + violations.map(violationLine).join('') + '</div>')
    + '</div>';
}

/* ── F13-01 收件箱的六列与行尾动作 ────────────────────────────────────────────

   每一格都读服务端算好的字段。页面**不判分组、不算阻断数、不推上下文状态** ——
   那些判据只有一份，在 domain/optimize/inbox.js 里，amzn_optimize_inbox 读的也是它。
   所以「页面说待审批、工具说已作废」不可能发生。

   行尾四个动作，各是各的：
     继续审阅            只改页面的筛选袋（内存），不落库、不进审计 —— 所以它不是一个写路由；
     基于此草案重新优化   真的建一轮新运行（optimize-draft-reoptimize）；
     作废 / 恢复         同一列的两个方向，按当前分组只画**一个** ——
                         已经作废的行画「恢复」，别的画「作废」。画两个会让人以为两个都能点，
                         而其中一个必然什么也不做；
     稍后 / 取消稍后     同上。

   NB: no backticks in this comment — this whole file is one template literal. */

const INBOX_ACTION_ROUTES = {
  void: 'optimize-draft-void',
  restore: 'optimize-draft-restore',
  defer: 'optimize-draft-defer',
  resume: 'optimize-draft-resume',
  reoptimize: 'optimize-draft-reoptimize',
};

const INBOX_GROUP_CHIPS = {
  pending: 'warn', approval: 'ok', revision: '', deferred: 'warn', voided: 'stop',
};

function inboxButton(action, label, draft) {
  return '<button data-inbox-action="' + escapeHtml(action) + '"'
    + ' data-run-id="' + escapeHtml(String(draft.runId || '')) + '"'
    + ' data-field="' + escapeHtml(String(draft.field || '')) + '">' + escapeHtml(label) + '</button>';
}

function inboxRowHtml(draft) {
  const confirmations = Array.isArray(draft.confirmations) ? draft.confirmations : [];
  const context = draft.contextState === 'ok'
    ? '<span class="chip ok">上下文匹配</span>'
    : (draft.contextState === 'unknown'
      ? '<span class="chip stop">没有上下文</span>'
      : '<span class="chip stop">上下文已变化</span>');
  const stateAction = draft.group === 'voided'
    ? inboxButton('restore', '恢复', draft)
    : inboxButton('void', '作废', draft);
  const deferAction = draft.group === 'voided'
    ? ''
    : (draft.group === 'deferred' ? inboxButton('resume', '取消稍后', draft) : inboxButton('defer', '稍后', draft));
  /* 生成时间的口径写在 title 里：它是**这一轮开始**的时刻（草案本身没有生成时间列），
     而最后改写时刻与它不是一回事 —— 一个被重写过三次的草案，生成时间仍然只有那一个。 */
  const generatedTitle = '来源 ' + String(draft.generatedAtSource || '未给出')
    + (draft.updatedAt ? '；最后改写 ' + String(draft.updatedAt) : '');
  return '<tr data-draft-field="' + escapeHtml(String(draft.field || '')) + '">'
    + '<td><span class="chip ' + (INBOX_GROUP_CHIPS[draft.group] || '') + '">'
    + escapeHtml(String(draft.groupLabel || draft.group || '—')) + '</span></td>'
    + '<td>' + escapeHtml(String(draft.label || draft.field || '—')) + '</td>'
    + '<td>' + escapeHtml(String(draft.asin || '—')) + '</td>'
    + '<td>' + escapeHtml(String(draft.marketplace || '—')) + '</td>'
    + '<td title="' + escapeHtml(generatedTitle) + '">' + escapeHtml(shortTime(draft.generatedAt)) + '</td>'
    + '<td>' + violationChips({ block: draft.blocked || 0, warn: draft.warnings || 0 }) + '</td>'
    + '<td>' + (confirmations.length === 0
      ? '<span class="opt-meta">—</span>'
      : '<span class="chip warn">' + confirmations.length + ' 项</span>'
        + '<div class="opt-meta">' + confirmations.map(item => escapeHtml(String(item.text))).join('<br>') + '</div>') + '</td>'
    + '<td>' + escapeHtml(String(draft.approvalLabel || '—')) + '</td>'
    + '<td>' + context
    + '<div style="padding-top:4px">'
    + '<button data-review-field="' + escapeHtml(String(draft.field || '')) + '">继续审阅</button>'
    + inboxButton('reoptimize', '基于此草案重新优化', draft)
    + stateAction + deferAction
    + '</div></td>'
    + '</tr>';
}

/* 「看全部」清掉**两个**维度。只清一个会留下另一半仍然生效，而按钮上写着「看全部」——
   一个名字与实际不符的控件，比没有它更糟。 */
function clearInboxFilter() {
  const next = { ...state.filters };
  delete next.draftStatus;
  delete next.draftContext;
  patchContext({ filters: next });
}

/* 继续审阅：只改筛选袋。选中这一轮、清掉筛选、把焦点放到那一张字段卡上。 */
function reviewDraft(field) {
  patchContext({
    filters: { ...state.filters, anchor: 'inbox', focusField: String(field || '') },
  });
}

async function postInboxAction(action, runId, field) {
  const route = INBOX_ACTION_ROUTES[action];
  if (route === undefined) {
    showPageError(new Error('unknown inbox action ' + String(action)));
    return;
  }
  try {
    await api(route, { method: 'POST', body: JSON.stringify({ runId, field }) });
    await refresh();
  } catch (error) {
    showPageError(error);
  }
}

/* ── F13-03 证据包（十类） ────────────────────────────────────────────────────

   三种「没有」在表上分开画，因为它们要做的事不一样：
     ✅ 已冻结       有证据，来源 / 时间 / 适用字段 / 条数都能读到；
     ⛔ 这一类没有    来源在，这个对象上没有行（不是「0 条」）；
     ⛔ 本仓没有这一类 本仓没有这个来源（评论主题样本、QA）—— 不是「这次没有」。
   条数那一格因此可以是 0（读过了，答案是 0），也可以是「—」（数不出来）。

   NB: no backticks in this comment — this whole file is one template literal. */

const EVIDENCE_STATUS_LABELS = {
  frozen: ['已冻结', 'ok'],
  absent: ['这一类没有', 'stop'],
  not_modelled: ['本仓没有这一类', 'stop'],
};

function renderEvidence(data) {
  const box = $('optevidence');
  if (box === null) return;
  if (!data || !data.run) { box.innerHTML = ''; return; }

  const evidence = data.evidence || null;
  const parts = ['<div class="rule-sect">证据包（十类）</div>'];
  if (evidence === null) {
    /* 这是**缺片**，不是「四种没有」里的任何一种：服务端没给这一格，页面就不猜。
       所以它带的是 data-slice-missing 而不是 data-empty-kind —— 后者是给「数据没有」
       用的，贴上去等于说"这一类数据是空的"，而事实是"这一格没送到"。
       两套标记让机器也能分开：页坏了 vs 数据没有。 */
    parts.push('<div class="empty" data-slice-missing="evidence">'
      + '服务端这一次没有给出证据包切片 —— 十类的来源与冻结状态都由它读，所以这里不猜。'
      + '</div>');
    box.innerHTML = parts.join('');
    return;
  }
  if (evidence.ok !== true) {
    parts.push('<div class="empty">' + escapeHtml(String(evidence.error || '证据包读不出来')) + '</div>');
    box.innerHTML = parts.join('');
    return;
  }

  parts.push('<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip ok">已冻结 ' + evidence.counts.frozen + '</span>'
    + '<span class="chip stop">这一类没有 ' + evidence.counts.absent + '</span>'
    + '<span class="chip stop">本仓没有这一类 ' + evidence.counts.notModelled + '</span>'
    + '<span class="opt-meta">冻结于 ' + escapeHtml(shortTime(evidence.frozenAt)) + '</span>'
    + (evidence.lateFreeze ? '<span class="chip warn">收尾时补冻（不是这一轮开始时冻的）</span>' : '')
    + '</div>');
  if (evidence.missing.length > 0) {
    parts.push('<div class="hint"><span class="chip stop">缺行</span>证据包里缺 ' + evidence.missing.length
      + ' 类的行：' + escapeHtml(evidence.missing.join('、')) + ' —— 缺行不等于「这一类没有」。</div>');
  }
  if (evidence.empty !== null) {
    parts.push(sliceEmpty(evidence.empty));
    box.innerHTML = parts.join('');
    return;
  }

  parts.push('<table><thead><tr><th>证据类</th><th>状态</th><th>来源</th><th>时间</th>'
    + '<th>适用字段</th><th>条数</th><th>说明</th></tr></thead><tbody>'
    + evidence.rows.map(row => {
      const known = EVIDENCE_STATUS_LABELS[row.status] || [String(row.status), ''];
      return '<tr>'
        + '<td>' + escapeHtml(String(row.label)) + '</td>'
        + '<td><span class="chip ' + known[1] + '">' + escapeHtml(known[0]) + '</span></td>'
        + '<td>' + escapeHtml(row.source === null ? '（本仓没有这一类证据的来源）' : String(row.source)) + '</td>'
        + '<td>' + escapeHtml(row.at === null ? '无日期' : shortTime(row.at)) + '</td>'
        + '<td>' + escapeHtml(row.fields.length === 0 ? '整轮 / 不落在某个字段上' : row.fields.join('、')) + '</td>'
        + '<td>' + (row.count === null ? '—' : String(row.count)) + '</td>'
        + '<td>' + escapeHtml(String(row.note || '')) + '</td>'
        + '</tr>';
    }).join('')
    + '</tbody></table>');
  box.innerHTML = parts.join('');
}

/* ── F13-05 / F13-06：策略阶段与位置计划核对 ──────────────────────────────────

   两块都**一分数都不算**。九项的 status / source / facts 与门禁的 open / state 来自
   readStrategy（它内部调 strategyGate，与 amzn_optimize_strategy 同一个函数）；
   继承 / 建议 / 决策 / 写回来自 readPlanCheck（与 amzn_optimize_plan_check 同一个）。
   所以「把域层改坏 → 工具侧与页面侧两条断言同时变红」是结构上成立的：页面没有第二条
   可以自己算出来的路。

   三种「没有」在版面上也必须长得不一样：
     没选一轮（data.run 为 null）/ 这一轮没有策略卡（present:false）/ 有策略卡但没人确认。
   压成一个灰框会让「本批之前建的轮次」读成「策略已经确认过」。

   NB: no backticks in this comment — this whole file is one template literal. */

const STRATEGY_STATUS_LABELS = {
  derived: ['有来源', 'ok'],
  absent: ['这一轮没有输入', 'warn'],
  not_modelled: ['本仓没有这一项', 'stop'],
};

function strategyFactsHtml(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return '';
  return '<table><thead><tr><th>事实 / 判据</th><th>值</th><th>时间</th><th>说明</th></tr></thead><tbody>'
    + facts.map(row => '<tr>'
      + '<td>' + escapeHtml(String(row.name || '')) + '</td>'
      + '<td>' + escapeHtml(String(row.value === null || row.value === undefined ? '—' : row.value)) + '</td>'
      + '<td>' + escapeHtml(row.at === null || row.at === undefined ? '—' : shortTime(row.at)) + '</td>'
      + '<td>' + escapeHtml(String(row.note || '')) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';
}

function renderStrategy(data) {
  const box = $('optstrategy');
  if (box === null) return;
  if (!data || !data.run) { box.innerHTML = ''; return; }

  const strategy = data.strategy || null;
  const parts = ['<div class="rule-sect">策略阶段（九项策略卡）</div>'];
  if (strategy === null) {
    parts.push('<div class="hint">服务端这一次没有给出策略切片 —— 九项的判据与门禁都由它算，所以这里不猜。</div>');
    box.innerHTML = parts.join('');
    return;
  }
  if (strategy.ok !== true) {
    parts.push('<div class="empty">' + escapeHtml(String(strategy.error || '策略卡读不出来')) + '</div>');
    box.innerHTML = parts.join('');
    return;
  }

  const gate = strategy.gate || { open: true, state: 'absent', reason: '' };
  parts.push('<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip ' + (gate.open ? (gate.state === 'confirmed' ? 'ok' : 'warn') : 'stop') + '">'
    + escapeHtml(gate.state === 'confirmed' ? '策略已确认' : (gate.state === 'absent' ? '没有策略卡' : '策略未确认'))
    + '</span>'
    + '<span class="opt-meta">有来源 ' + strategy.counts.derived + ' · 这一轮没有输入 '
    + strategy.counts.absent + ' · 本仓没有 ' + strategy.counts.notModelled + '（共 ' + strategy.counts.items + ' 项）</span>'
    + (strategy.present === true && strategy.confirmed === true
      ? '<span class="opt-meta">确认于 ' + escapeHtml(shortTime(strategy.confirmedAt))
        + '（' + escapeHtml(String(strategy.confirmedBy || '未署名')) + '）'
        + (strategy.edited === true ? ' · 人工改过文字' : ' · 按构建原样确认') + '</span>'
      : '')
    + '</div>');
  parts.push('<div class="hint">' + escapeHtml(gate.reason) + '</div>');

  if (strategy.present !== true) {
    parts.push(strategy.empty ? sliceEmpty(strategy.empty)
      : emptyState('not-recorded', { subject: '策略卡', next: '这一轮先生成草案，再回到这里确认策略。' }));
    box.innerHTML = parts.join('');
    return;
  }

  parts.push('<div class="hint">确认之后草案才能进入这一轮（<code>amzn_optimize_validate</code> 带 persist、'
    + '<code>amzn_optimize_save</code> 都会被拒）。确认时可以改文字 —— 人工确认不是橡皮图章；'
    + '改过之后「构建时给的是什么」仍然读得出来。</div>');
  for (const entry of strategy.items) {
    const known = STRATEGY_STATUS_LABELS[entry.status] || [String(entry.status), ''];
    parts.push('<div style="padding:8px 0;border-top:1px solid var(--line)">'
      + '<div class="bar" style="flex-wrap:wrap">'
      + '<strong style="font-size:12px">' + escapeHtml(entry.label) + '</strong>'
      + '<span class="chip ' + known[1] + '">' + escapeHtml(known[0]) + '</span>'
      + '<span class="opt-meta">' + escapeHtml(entry.question) + '</span>'
      + '</div>'
      + '<textarea id="optStrategy_' + escapeHtml(entry.id) + '" rows="3" style="width:100%">'
      + escapeHtml(entry.text) + '</textarea>'
      + strategyFactsHtml(entry.facts)
      + '<div class="hint">来源：' + escapeHtml(entry.source === null ? '（本仓没有这一项的来源）' : String(entry.source)) + '</div>'
      + (entry.note ? '<div class="hint">说明：' + escapeHtml(String(entry.note)) + '</div>' : '')
      + '</div>');
  }
  parts.push('<div class="bar"><button id="optStrategyConfirm">'
    + (strategy.confirmed === true ? '重新确认这九项' : '确认策略，进入生成')
    + '</button><span class="hint" style="padding:0">改过的文字会存进这一轮；构建时的那一份不动。</span></div>');
  box.innerHTML = parts.join('');

  const button = $('optStrategyConfirm');
  if (button !== null) button.onclick = () => postStrategyConfirm(strategy);
}

async function postStrategyConfirm(strategy) {
  const items = (strategy.items || []).map((entry) => {
    const field = $('optStrategy_' + entry.id);
    return { id: entry.id, text: field === null ? entry.text : String(field.value || '') };
  });
  try {
    await api('optimize-strategy-confirm', {
      method: 'POST',
      body: JSON.stringify({ runId: strategy.runId, items, by: 'page' }),
    });
    clearPageError();
    await refresh();
  } catch (error) {
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  }
}

function renderPlanCheck(data) {
  const box = $('optplancheck');
  if (box === null) return;
  if (!data || !data.run) { box.innerHTML = ''; return; }

  const check = data.planCheck || null;
  const parts = ['<div class="rule-sect">位置计划核对（继承模块 08）</div>'];
  if (check === null) {
    parts.push('<div class="hint">服务端这一次没有给出计划核对切片 —— 继承、建议与决策都由它读，所以这里不猜。</div>');
    box.innerHTML = parts.join('');
    return;
  }
  if (check.ok !== true) {
    parts.push('<div class="empty">' + escapeHtml(String(check.error || '位置计划核对读不出来')) + '</div>');
    box.innerHTML = parts.join('');
    return;
  }
  if (check.present !== true) {
    parts.push(check.empty ? sliceEmpty(check.empty)
      : emptyState('not-recorded', { subject: '位置计划核对记录', next: '位置计划来自模块 08；这一轮还没核对过。' }));
    box.innerHTML = parts.join('');
    return;
  }

  const inherited = check.inherited || {};
  const decision = check.decision || { state: 'pending' };
  const decisionLabels = {
    pending: ['还没有人裁决', 'warn'],
    accepted: ['已采纳并写回 08', 'ok'],
    declined: ['已否决（没有写回 08）', ''],
  };
  const known = decisionLabels[decision.state] || [String(decision.state), ''];

  parts.push('<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip ' + (inherited.status === 'inherited' ? 'ok' : 'stop') + '">'
    + escapeHtml(inherited.status === 'inherited'
      ? '继承 ' + String(inherited.planId) + ' v' + String(inherited.version)
        + '（那一版共 ' + (inherited.entryCount === null || inherited.entryCount === undefined
          ? '读不到条数' : String(inherited.entryCount) + ' 条') + '）'
      : '没有可继承的计划') + '</span>'
    + '<span class="chip ' + known[1] + '">' + escapeHtml(known[0]) + '</span>'
    + (check.writtenBack
      ? '<span class="opt-meta">写回 ' + escapeHtml(String(check.writtenBack.planId))
        + ' v' + escapeHtml(String(check.writtenBack.version)) + '</span>'
      : '')
    + '<span class="opt-meta">建议 ' + check.counts.suggested + ' 条 · 一致 ' + check.counts.unchanged
    + ' · 主人位置不同 ' + check.counts.moved + ' · 计划没决定过的词 ' + check.counts.uncovered
    + ' · 无对应埋词位置 ' + check.counts.unmapped + '</span>'
    + '</div>');
  if (inherited.note) parts.push('<div class="hint">' + escapeHtml(String(inherited.note)) + '</div>');
  parts.push('<div class="hint">位置计划的唯一持久层是模块 08（<code>keyword_plan</code>）。'
    + '这一轮只继承与冻结，不产生第二份口径；采纳时写回 08 的<strong>新版本</strong>，'
    + '走的是 08 的 <code>savePlan</code>（与 <code>amzn_keyword_plan_save</code> 同一个函数）。</div>');

  if (check.suggested.entries.length === 0) {
    /* 两个不同的 0 都要说得出是哪一种：领域层给的那一句优先，页面不自己编。 */
    parts.push('<div class="hint">' + escapeHtml(check.suggested.note
      || '这一轮的关键词里没有一个被计划决定过 —— 建议计划是 0 条，不是「计划不存在」。') + '</div>');
  } else {
    parts.push('<table><thead><tr><th>关键词</th><th>计划主人</th><th>对应埋词位置</th>'
      + '<th>本轮分配</th><th>变化</th></tr></thead><tbody>'
      + check.suggested.entries.map(row => '<tr>'
        + '<td>' + escapeHtml(String(row.keyword)) + '</td>'
        + '<td>' + escapeHtml(String(row.ownerPositionLabel)) + '</td>'
        + '<td>' + escapeHtml(row.embedPosition === null ? '（无对应物）' : String(row.embedPosition)) + '</td>'
        + '<td>' + escapeHtml(row.roundOwner === null ? '—' : String(row.roundOwner)) + '</td>'
        + '<td>' + escapeHtml(PLAN_ROUND_CHANGE_LABELS[row.roundChange] || String(row.roundChange)) + '</td>'
        + '</tr>').join('')
      + '</tbody></table>');
  }
  if (check.suggested.uncovered.length > 0) {
    parts.push('<div class="hint"><span class="chip warn">计划没决定过</span> '
      + escapeHtml(check.suggested.uncovered.join('、'))
      + '　—— 它们不进建议计划：为一个词编一个位置就是产生第二份口径。要加，去 08 里加。</div>');
  }
  for (const item of check.suggested.unmapped) {
    parts.push('<div class="hint"><span class="chip warn">无对应埋词位置</span> '
      + escapeHtml(String(item.label) + '（' + String(item.position) + '）× ' + String(item.count) + '：' + String(item.reason)) + '</div>');
  }
  parts.push('<div class="bar">'
    + '<button id="optPlanAccept"' + (inherited.status === 'inherited' ? '' : ' disabled') + '>采纳并写回 08 新版本</button>'
    + '<button id="optPlanDecline">不采纳</button>'
    + '<span class="hint" style="padding:0">采纳会在 08 的同一个版本族里追加一版；旧版一个字都不动。</span></div>');
  box.innerHTML = parts.join('');

  const accept = $('optPlanAccept');
  if (accept !== null) accept.onclick = () => postPlanDecide(check.runId, 'accept');
  const decline = $('optPlanDecline');
  if (decline !== null) decline.onclick = () => postPlanDecide(check.runId, 'decline');
}

const PLAN_ROUND_CHANGE_LABELS = {
  unchanged: '一致',
  'owner-moved': '主人位置不同',
  'not-comparable': '比不了（08 的位置没有对应埋词位置）',
  'plan-only': '本轮包里没有这个词',
};

async function postPlanDecide(runId, decision) {
  try {
    await api('optimize-plan-decide', {
      method: 'POST',
      body: JSON.stringify({ runId, decision, by: 'page' }),
    });
    clearPageError();
    await refresh();
  } catch (error) {
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  }
}

/* ── the three blocks below the run header ────────────────────────────────────
   All three answer questions the panel could not answer before, and all three are
   the same kind of question: *which rules was this judged against, and did anyone
   verify them for this site*. Showing one site's limits for every site is how a
   reader concludes the numbers are universal. */

/** The site profile the run was judged against, and whether it is verified. */
function siteBlock(run) {
  if (!run.profile) return '';
  const limits = run.limits || {};
  const facts = [
    '标题 ' + (limits.titleMax ?? '—') + ' 字符',
    '亮点 ' + (limits.itemHighlightsMax ?? '—') + ' 字符',
    '后台 ' + (limits.backendMaxBytes ?? '—') + ' 字节',
    '单位 ' + ((run.profile.units && run.profile.units.length) || '—'),
  ].map(text => '<span class="opt-meta">' + escapeHtml(text) + '</span>').join(' ');
  const provisional = run.provisional
    ? '<div class="hint"><span class="chip warn">站点规则未核验</span> ' + escapeHtml(run.provisional.text) + '</div>'
    : '';
  return '<div class="hint">站点档案 <strong>' + escapeHtml(run.profile.label || run.profile.code || '')
    + '</strong> ' + facts + '</div>' + provisional;
}

/**
 * F13-08 —— 校验体系的三块面板：规则校验 / 闸门判定 / Agent 审阅。
 *
 * 这三块以前散在三处：规则命中只有 violationChips 两个数字（逐条违规只出现在每个
 * 字段的卡片里）、闸门画在 optrun 那一条里（没有 sect- 落点，锚点跳不进去）、
 * Agent 审阅连载荷都没有。现在每块一个面板、一个落点。
 *
 * **页面一条判据都不算。** 三块的每一行都来自 state.optimizations.validation,
 * 那是服务端 readValidationSystem 的产出，而工具 amzn_optimize_validation 读的是
 * **同一个函数**。所以「把域层改坏 → 工具侧与页面侧两条断言必须同时红」是结构上
 * 成立的：页面没有第二条可以自己算出来的路。
 *
 * 三个不同的「没有」在版面上也分开：没选一轮（不画）/ 这一轮没有草案
 * （rules.empty）/ 这一轮没人审过（review.present 为假，14 项全是 pending）。
 * 压成一个灰框会让「没人审过」读成「审过都没问题」。
 *
 * NB: no backticks in this comment — this whole file is one template literal. */

const VALIDATION_PANEL_IDS = ['optrules', 'optgates', 'optreview'];

const REVIEW_STATE_CHIPS = {
  pending: ['没有结论', 'warn'],
  pass: ['通过', 'ok'],
  fail: ['不通过', 'stop'],
  unclear: ['判不了', 'warn'],
};

function renderValidation(data) {
  const rulesBox = $('optrules');
  const gatesBox = $('optgates');
  const reviewBox = $('optreview');
  if (rulesBox === null || gatesBox === null || reviewBox === null) return;
  if (!data || !data.run) {
    rulesBox.innerHTML = '';
    gatesBox.innerHTML = '';
    reviewBox.innerHTML = '';
    return;
  }
  const validation = data.validation || null;
  /* 服务端这一次没有给这一格 —— 判据全在它那边，所以这里不猜，也不自己重算。 */
  if (validation === null || validation.ok !== true) {
    const hint = '<div class="hint">服务端这一次没有给出校验体系切片'
      + (validation !== null && validation.error ? '：' + escapeHtml(String(validation.error)) : '')
      + ' —— 三块的判据都由它算，所以这里不猜。</div>';
    rulesBox.innerHTML = hint;
    gatesBox.innerHTML = '';
    reviewBox.innerHTML = '';
    return;
  }

  renderRulesPanel(rulesBox, validation);
  renderGatesPanel(gatesBox, validation);
  renderReviewPanel(reviewBox, validation, data.run);
}

function renderRulesPanel(box, validation) {
  const rules = validation.rules;
  const parts = ['<div class="rule-sect">规则校验（合法不合法）</div>'];
  parts.push('<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip ' + (rules.counts.block === 0 ? 'ok' : 'stop') + '">阻断 ' + rules.counts.block + '</span>'
    + '<span class="chip ' + (rules.counts.warn === 0 ? '' : 'warn') + '">警告 ' + rules.counts.warn + '</span>'
    + '<span class="opt-meta">共 ' + rules.rows.length + ' 行'
    + (rules.duplicates > 0 ? '（去重后 ' + rules.distinct + ' 条 —— 聚合字段的规则记在它覆盖的每个字段上）' : '')
    + '</span>'
    + '</div>');
  if (rules.uncounted > 0) {
    parts.push('<div class="hint"><span class="chip warn">口径</span> 其中 ' + rules.uncounted
      + ' 行的严重度不是 block/warn —— 它们<strong>不计入</strong>上面那两个数字。</div>');
  }
  /* 两个数字不由同一段代码得出就必须比对。不一致要说出来，不能让读者在同一屏上看到
     两个「阻断 3」与「阻断 5」而不报错。 */
  if (rules.drift) {
    parts.push('<div class="hint"><span class="chip stop">口径不一致</span> 这里数出来 '
      + rules.counts.block + ' / ' + rules.counts.warn + '，收件箱与表头用的那个数字是 '
      + rules.persisted.block + ' / ' + rules.persisted.warn + ' —— 投影与源不同步。</div>');
  }
  if (rules.empty !== null) {
    parts.push(sliceEmpty(rules.empty));
    box.innerHTML = parts.join('');
    return;
  }
  if (rules.rows.length === 0) {
    parts.push('<div class="hint">机检 0 命中 —— 这一轮有草案，规则一条都没触发。'
      + '这不是「这一轮没有可判的东西」。</div>');
    box.innerHTML = parts.join('');
    return;
  }
  const shown = rules.rows.slice(0, 60);
  parts.push('<table><thead><tr><th>字段</th><th>规则</th><th>严重度</th><th>依据</th><th>说明</th></tr></thead><tbody>'
    + shown.map(row => '<tr>'
      + '<td>' + escapeHtml(String(row.fieldLabel || row.field)) + '</td>'
      + '<td><code>' + escapeHtml(String(row.ruleId)) + '</code></td>'
      + '<td>' + escapeHtml(String(row.severity)) + '</td>'
      + '<td>' + escapeHtml(String(row.source || '—')) + '</td>'
      + '<td>' + escapeHtml(String((row.messages || []).join('；'))) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>');
  if (rules.rows.length > shown.length) {
    parts.push('<div class="hint">只画了前 ' + shown.length + ' 行，共 ' + rules.rows.length + ' 行。</div>');
  }
  box.innerHTML = parts.join('');
}

/**
 * 闸门面板。
 *
 * 每道闸门带 what（判什么）与 source（依据哪份文档）：审计说这半已经实现了，
 * 但页面上原本只有 label / pass / detail —— 一个没有判据的闸门行，读者只能猜它为什么
 * 没过。数字来自 state.optimizations.validation.gates，与轮次表头那个 chip 同一次计算
 * （服务端把 run view 传给了 readValidationSystem），所以两个数字不会不一样。
 */
function renderGatesPanel(box, validation) {
  const gates = validation.gates;
  const parts = ['<div class="rule-sect">闸门判定（做完了没有）</div>'];
  parts.push('<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip ' + (gates.ok ? 'ok' : 'warn') + '">' + gates.passed + '/' + gates.total + ' 通过</span>'
    + '<span class="opt-meta">规则回答「这样合法吗」，闸门回答「这样算做完了吗」——'
    + '一份完全合法的文案可以只写了 11 个章节里的 4 个。</span>'
    + '</div>');
  if (gates.empty !== null) {
    parts.push(sliceEmpty(gates.empty));
    box.innerHTML = parts.join('');
    return;
  }
  for (const gate of gates.rows) {
    parts.push('<div style="padding:6px 0;border-top:1px solid var(--line)">'
      + '<div class="bar" style="flex-wrap:wrap">'
      + '<span class="chip ' + (gate.pass ? 'ok' : 'warn') + '">' + (gate.pass ? '通过' : '未过') + '</span>'
      + '<strong style="font-size:12px">' + escapeHtml(String(gate.label)) + '</strong>'
      + '<span class="opt-meta"><code>' + escapeHtml(String(gate.id)) + '</code></span>'
      + '</div>'
      + '<div class="hint">' + escapeHtml(String(gate.detail || '')) + '</div>'
      + (gate.what === null ? '' : '<div class="hint">判据：' + escapeHtml(String(gate.what)) + '</div>')
      + (gate.source === null ? '' : '<div class="hint">依据：' + escapeHtml(String(gate.source)) + '</div>')
      + '</div>');
  }
  box.innerHTML = parts.join('');
}

/**
 * Agent 审阅面板（14 项）。
 *
 * 每一项的三值结论与逐字段的那几条都来自载荷；页面只做 review.items 的渲染与
 * 一个「记结论」的表单。下拉里的词表（三项结论、五种证据 kind）也来自载荷 ——
 * 在页面里再写一份「三值是哪三个」，会在加值的时候静默变成旧词表。
 */
function renderReviewPanel(box, validation, run) {
  const review = validation.review;
  const parts = ['<div class="rule-sect">Agent 审阅（14 项：机检判不了的那些）</div>'];
  if (review === null || review === undefined || review.ok !== true) {
    parts.push('<div class="hint">服务端这一次没有给出审阅切片'
      + (review !== null && review !== undefined && review.error ? '：' + escapeHtml(String(review.error)) : '')
      + ' —— 结论与状态都由它算，所以这里不猜。</div>');
    box.innerHTML = parts.join('');
    return;
  }

  parts.push('<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip ' + (review.counts.pending === 0 ? 'ok' : 'warn') + '">'
    + (review.counts.items - review.counts.pending) + '/' + review.counts.items + ' 项有结论</span>'
    + '<span class="opt-meta">通过 ' + review.counts.pass + ' · 不通过 ' + review.counts.fail
    + ' · 判不了 ' + review.counts.unclear + ' · 没有结论 ' + review.counts.pending + '</span>'
    + '</div>');
  parts.push('<div class="hint">' + escapeHtml(review.empty === null
    ? '结论逐项写、可以逐字段写，每条必须引用证据（规则 id / 这一轮的字段 / 一类证据 / 事实 / 人看过什么）——'
      + '引用解不开会被拒。状态由行重算：不通过优先于判不了，判不了优先于通过，而没有行就是「没有结论」。'
    : review.empty.text) + '</div>');

  const groupOrder = [];
  for (const item of review.items) {
    const key = String(item.groupLabel || item.group || '');
    if (groupOrder.indexOf(key) < 0) groupOrder.push(key);
  }
  for (const group of groupOrder) {
    parts.push('<div class="opt-meta" style="margin-top:8px"><strong>' + escapeHtml(group) + '</strong></div>');
    for (const item of review.items) {
      if (String(item.groupLabel || item.group || '') !== group) continue;
      const chip = REVIEW_STATE_CHIPS[item.state] || [String(item.state), ''];
      parts.push('<div style="padding:6px 0;border-top:1px solid var(--line)">'
        + '<div class="bar" style="flex-wrap:wrap">'
        + '<span class="chip ' + chip[1] + '">' + escapeHtml(chip[0]) + '</span>'
        + '<strong style="font-size:12px">' + escapeHtml(String(item.label)) + '</strong>'
        + '<span class="opt-meta"><code>' + escapeHtml(String(item.id)) + '</code></span>'
        + (item.needsHuman ? '<span class="chip warn">只能人判</span>' : '')
        + '</div>'
        + '<div class="hint">' + escapeHtml(String(item.ask)) + '</div>'
        + '<div class="hint">依据：' + escapeHtml(String(item.source)) + '</div>');
      for (const row of item.rows) {
        parts.push('<div class="hint">· <strong>' + escapeHtml(String(row.fieldLabel)) + '</strong>：'
          + escapeHtml(String(row.conclusion))
          + (row.note === null ? '' : ' —— ' + escapeHtml(String(row.note)))
          + '　证据 ' + escapeHtml((row.evidence || []).map(ref => String(ref.kind) + ':' + String(ref.ref)).join('、'))
          + '　（' + escapeHtml(shortTime(row.reviewedAt)) + (row.reviewedBy === null ? '' : ' / ' + escapeHtml(String(row.reviewedBy))) + '）'
          + '</div>');
      }
      parts.push('</div>');
    }
  }

  const drift = review.rosterDrift || { missing: [], duplicate: [], unlabelled: [] };
  if ((drift.missing || []).length > 0 || (drift.duplicate || []).length > 0 || (drift.unlabelled || []).length > 0) {
    parts.push('<div class="hint"><span class="chip stop">清单与上游不同步</span> '
      + '缺 ' + escapeHtml((drift.missing || []).join('、') || '无')
      + '；重复 ' + escapeHtml((drift.duplicate || []).join('、') || '无')
      + '；无标签 ' + escapeHtml((drift.unlabelled || []).join('、') || '无') + '</div>');
  }

  /* ── 记一条结论 ────────────────────────────────────────────────────────────
     字段下拉里是这一轮真的有的字段（run.drafts），所以「审一个这一轮没有的字段」
     在界面上就发不出去 —— 服务端也会拒（REVIEW_UNKNOWN_FIELD），两道都在。 */
  const fieldOptions = ['<option value="">（整份草稿）</option>']
    .concat((run.drafts || []).map(draft => '<option value="' + escapeHtml(String(draft.field)) + '">'
      + escapeHtml(String(draft.label || draft.field)) + '</option>'));
  const itemOptions = review.items.map(item => '<option value="' + escapeHtml(String(item.id)) + '">'
    + escapeHtml(String(item.label)) + '（' + escapeHtml(String(item.id)) + '）</option>');
  const conclusionOptions = (review.conclusions || []).map(value => '<option value="' + escapeHtml(String(value)) + '">'
    + escapeHtml(String(value)) + '</option>');
  parts.push('<div class="bar" style="flex-wrap:wrap;border-top:1px solid var(--line);padding-top:8px">'
    + '<strong style="font-size:12px">记一条结论</strong>'
    + '<select id="optReviewItem">' + itemOptions.join('') + '</select>'
    + '<select id="optReviewField">' + fieldOptions.join('') + '</select>'
    + '<select id="optReviewConclusion">' + conclusionOptions.join('') + '</select>'
    + '<button id="optReviewSubmit">记录结论</button>'
    + '</div>'
    + '<div class="hint">证据（JSON 数组，至少一条；kind 是 '
    + escapeHtml((review.evidenceKinds || []).join(' / '))
    + ' —— rule 与 draft 会被解开核对）：</div>'
    + '<textarea id="optReviewEvidence" rows="2" style="width:100%"'
    + ' placeholder="[{&quot;kind&quot;:&quot;draft&quot;,&quot;ref&quot;:&quot;title&quot;}]"></textarea>'
    + '<textarea id="optReviewNote" rows="2" style="width:100%" placeholder="一句话：判的是什么（选 unclear 时必填）"></textarea>');
  box.innerHTML = parts.join('');

  const submit = $('optReviewSubmit');
  if (submit !== null) submit.onclick = () => postReviewRecord();
}

async function postReviewRecord() {
  const value = (id) => { const el = $(id); return el === null ? '' : String(el.value || '').trim(); };
  const raw = value('optReviewEvidence');
  let evidence = [];
  if (raw !== '') {
    try {
      evidence = JSON.parse(raw);
    } catch (error) {
      showPageError(new Error('证据不是合法 JSON：' + error.message));
      return;
    }
  }
  const runId = state.optimizations && state.optimizations.run ? state.optimizations.run.id : null;
  try {
    await api('optimize-review-record', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        itemId: value('optReviewItem'),
        field: value('optReviewField'),
        conclusion: value('optReviewConclusion'),
        note: value('optReviewNote') || null,
        evidence,
        by: 'page',
      }),
    });
    clearPageError();
    await refresh();
  } catch (error) {
    const hint = error && error.body ? error.body.hint : null;
    showPageError(new Error((error && error.message ? error.message : String(error)) + (hint ? '　' + hint : '')));
  }
}

/**
 * F13-09 —— 交付边界：可复制字段 / 操作清单 / 三种「没有」/ 发布登记跳转。
 *
 * 一条判据都不算：每一条操作的 status 与三个 boundary 计数都来自
 * state.optimizations.delivery（服务端 buildDelivery）。它读的是**发布登记的内容**
 * 去重算「哪一条已经做过」，所以「面板说没做、发布记录说做了」在结构上不可能。
 *
 * 跳转走的是页面已有的那一套：followTodo 解析 '#module#anchor' 并把 filters 并进
 * 同一只袋子，scrollToSection 落到 sect-publication —— 不新造第二套跳转机制。
 */
function renderDelivery(data) {
  const box = $('optdelivery');
  if (box === null) return;
  if (!data || !data.run) { box.innerHTML = ''; return; }

  const delivery = data.delivery || null;
  const parts = ['<div class="rule-sect">交付边界（谁给什么，去哪儿做）</div>'];
  if (delivery === null || delivery.ok !== true) {
    parts.push('<div class="hint">服务端这一次没有给出交付边界切片'
      + (delivery !== null && delivery.error ? '：' + escapeHtml(String(delivery.error)) : '')
      + ' —— 清单与三种「没有」都由它算，所以这里不猜。</div>');
    box.innerHTML = parts.join('');
    return;
  }

  parts.push('<div class="bar" style="flex-wrap:wrap">'
    + '<span class="chip ' + (delivery.counts.operations === 0 ? 'warn' : '') + '">' + delivery.counts.operations + ' 条操作</span>'
    + '<span class="chip ' + (delivery.counts.ready === 0 ? '' : 'ok') + '">可复制粘贴 ' + delivery.counts.ready + '</span>'
    + '<span class="opt-meta">独立编辑器 ' + delivery.counts.editor + ' · 草案未采纳 ' + delivery.counts.notAccepted
    + ' · 本轮没有生成 ' + delivery.counts.noText + ' · 必须人工填 ' + delivery.counts.humanRequired
    + ' · 已登记发布 ' + delivery.counts.registered + '</span>'
    + '</div>');
  parts.push('<div class="hint">'
    + '<strong>插件给的</strong> ' + delivery.boundary.plugin.count + ' 个字段'
    + '（其中属性 ' + delivery.boundary.plugin.attributes.drafted + '/' + delivery.boundary.plugin.attributes.target + '）'
    + '　·　<strong>插件不提供</strong> ' + delivery.boundary.humanOnly.count + ' 个'
    + '　·　<strong>插件会说、这一轮没有生成</strong> ' + delivery.boundary.notGenerated.count + ' 个'
    + '。后两项<strong>不是一件事</strong>：前者是本仓没有来源，后者是这一轮没有输入或没有写。'
    + '</div>');
  if ((delivery.unmappedSurfaces || []).length > 0) {
    parts.push('<div class="hint"><span class="chip stop">落点缺失</span> 有 '
      + delivery.unmappedSurfaces.length + ' 个 section 没有登记交付落点（'
      + escapeHtml(delivery.unmappedSurfaces.join('、')) + '）—— 注册表变了而落点表没跟上。</div>');
  }

  const registration = delivery.registration;
  parts.push('<div class="bar" style="flex-wrap:wrap">'
    + '<button id="optDeliveryJump">去登记这一轮的发布</button>'
    + '<span class="hint" style="padding:0">跳到发布记录，表单预填运行 id 与草案版本 '
    + (registration.draftVersionKnown ? 'v' + escapeHtml(String(registration.draftVersion)) : '（读不到 —— 与「版本是 0」不是一件事）')
    + '。已登记 ' + registration.registered.count + ' 个字段'
    + (registration.registered.count === 0 ? '（一条都还没有登记过）' : '（最近 ' + escapeHtml(String(registration.registered.latestAt)) + '）')
    + '。</span></div>');
  parts.push('<div class="hint"><span class="chip warn">接受草案 ≠ 已发布</span> '
    + escapeHtml(registration.hint) + '</div>');

  if (delivery.empty !== null) {
    parts.push(sliceEmpty(delivery.empty));
  } else {
    parts.push('<table><thead><tr><th>落点</th><th>字段</th><th>状态</th><th>做什么</th></tr></thead><tbody>'
      + delivery.operations.map(operation => '<tr>'
        + '<td>' + escapeHtml(String(operation.surfaceLabel)) + '</td>'
        + '<td>' + escapeHtml(String(operation.fieldLabel)) + '</td>'
        + '<td>' + escapeHtml(String(operation.statusLabel)) + '</td>'
        + '<td>' + escapeHtml(String(operation.action)) + '</td>'
        + '</tr>').join('')
      + '</tbody></table>');
  }
  box.innerHTML = parts.join('');

  const jump = $('optDeliveryJump');
  if (jump !== null) {
    jump.onclick = () => followTodo('#optimize#' + registration.anchor, { runId: registration.runId });
  }
}

/* 优化那一侧的 gateBlock 已删：F13-08 把它做成了 #optgates 面板，读的是同一份
   validation.gates（服务端 readValidationSystem 的产出）。留着它就是一个没人调用的
   第二渲染点，而本仓对「同一件事两处渲染」的代价已经付过。 */

/** How much of the embedding plan the drafts actually delivered.
 *
 *  The local is named embed, not coverage: the keyword panel already uses
 *  coverage for state.coverage, which is a different object with a different
 *  shape. Two meanings for one name in one file is how a reader — and a static
 *  check — ends up looking at the wrong one. */
function coverageBlock(run) {
  const embed = run.coverage;
  if (!embed) return '';
  /* 没有可判的分母时 fillRate 是 null（optimize/plan.js 在 totalPlanned === 0 时给 null）。
     原来写 (embed.fillRate || 0)：null 被当 0 → 上屏印「埋词完成率 0%」并挂 warn chip，
     等于把「这一轮根本没计划」说成「一个都没填」。现在三态：有值印值、null 印「不判读」、不给危险 chip。
     注意：本文件的内容位于模板字符串内部，注释里不能出现反引号，否则会把模板字符串截断。 */
  const rawRate = embed.fillRate;
  const percent = rawRate === null || rawRate === undefined ? null : Math.round(rawRate * 100);
  const chip = percent === null ? 'muted' : (percent >= 60 ? 'ok' : 'warn');
  const rateText = percent === null ? '埋词完成率 不判读（没有计划落点）' : '埋词完成率 ' + percent + '%';
  const conflicts = (run.allocationViolations || []).length > 0
    ? '<div class="hint">' + run.allocationViolations.map(v => '<span class="chip warn">分配冲突</span> ' + escapeHtml(v.detail)).join('<br>') + '</div>'
    : '';
  return '<div class="hint"><span class="chip ' + chip + '">' + rateText + '</span> '
    + '计划 ' + embed.plannedCells + ' 处 / 命中 ' + embed.reachedCells + ' 处'
    + '　·　写入位置 ' + embed.written + '/' + embed.positions + ' 个'
    + '　·　平均每词 ' + embed.averagePlaces + ' 处（计划 ' + embed.averagePlanned + ' 处）'
    + (embed.keywordsUnderfilled > 0 ? '　·　' + embed.keywordsUnderfilled + ' 个词没埋够' : '')
    + '</div>' + conflicts;
}

/* ── F13-02 / F13-04：九项前置门槛与四种优化模式 ──────────────────────────────

   这一块**一分数都不算**。判词、实测值、分母、缺什么、去哪里补，全部读
   state.optimizations.precheck —— 它要么是这一轮开始时冻结下来的那份判定
   （precheckSource === 'frozen'），要么是服务端按当前筛选现算的一次（'live'）。
   两条路都出自 precheckFor，也就是 amzn_optimize_precheck 与 amzn_optimize_prepare
   用的那一个函数。所以这里没有「新鲜度」「阈值」这类判断，只有一个渲染循环；页面上
   任何一个数字都能在会话里调同一个工具复现出来。

   三种判词分开画，不折成一个「能不能优化」：阻断（block）与降级（degrade）之后要做
   的事不一样 —— 一个必须先补数再重跑，一个只是把建议标低置信度。把九项压成一个
   布尔值，读者就分不出「价格过期 20 天」和「没有品牌归属」这两种完全不同的工作。

   NB: no backticks in this comment — this whole file is one template string. */

const PRECHECK_VERDICT_TEXT = { pass: '通过', degrade: '降级', block: '阻断' };
const PRECHECK_VERDICT_CHIP = { pass: 'ok', degrade: 'warn', block: 'stop' };
const PRECHECK_SOURCE_TEXT = { frozen: '这一轮开始时冻结的判定', live: '按当前筛选现算的判定' };

function precheckVerdictChip(verdict) {
  const label = PRECHECK_VERDICT_TEXT[verdict] || String(verdict || '—');
  return '<span class="chip ' + (PRECHECK_VERDICT_CHIP[verdict] || '') + '">' + escapeHtml(label) + '</span>';
}

/* The mode picker. The four modes and the eight scopes come from the payload
   (data.modes / data.targetedScopes), not from a list written out here: a
   hard-coded copy would keep offering 全量 after the module grew a fifth mode, and
   the reader would have no way to tell the page was stale. */
function precheckModeBar(data, modes, mode, scopes) {
  const current = modes.filter(entry => entry.id === mode)[0] || null;
  const parts = [];
  parts.push('<div class="bar" style="flex-wrap:wrap">');
  parts.push('<label class="hint" style="padding:0" for="optMode">模式</label>');
  parts.push('<select id="optMode">' + modes.map(entry => '<option value="' + escapeHtml(entry.id) + '"'
    + (entry.id === mode ? ' selected' : '') + '>' + escapeHtml(entry.label) + '</option>').join('') + '</select>');
  if (current !== null && current.pickScope === true) {
    parts.push('<select id="optScope"><option value="">选一个专项…</option>' + scopes.map(scope =>
      '<option value="' + escapeHtml(scope.id) + '"' + (scope.id === data.scope ? ' selected' : '') + '>'
      + escapeHtml(scope.label) + '（' + scope.fieldCount + ' 个字段）</option>').join('') + '</select>');
  }
  if (current !== null) {
    parts.push('<span class="chip ' + (current.generates ? 'run' : 'stop') + '">'
      + (current.generates ? '会生成文案' : '只检查不生成') + '</span>');
  }
  parts.push('</div>');
  if (current !== null) {
    parts.push('<div class="hint">' + escapeHtml(current.tagline)
      + (current.budget ? '　本轮上限 ' + current.budget.allowed + ' 个字段（'
        + Math.round(current.budget.ratio * 100) + '% × ' + current.budget.total + '）。' : '')
      + '</div>');
  }
  return parts.join('');
}

/* Why there is no report — three different empties, said differently. A page that
   drew one grey box for all three would let 「选了专项但没选范围」 read as 「九项
   全过」, which is the one answer this feature must never imply. */
function precheckMissingState(data, mode) {
  const asin = String((state.filters || {}).asin || '').trim();
  /* 三支里两支是**引导**（还没选，不是数据缺），一支是**缺陷**（服务端没产出判定）。
     引导可以套四态；缺陷不套 —— 缺陷不是「四种没有」里的任何一种，
     给它贴一个 kind 就等于用假话替代真话。所以第三支保持手写。 */
  if (mode === 'targeted' && !data.scope) {
    return emptyState('not-recorded', {
      subject: '专项判定',
      reason: '「专项」要先选一个专项范围（标题 / 五点 / 后台词 / …）。选之前没有可判的对象 —— '
        + '这不是「九项全过」，也不是「全量」。',
      next: '先在上面的模式里选一个专项范围。',
    });
  }
  if (asin === '') {
    return emptyState('not-recorded', {
      subject: '九项门槛',
      next: '还没有选中 ASIN。在 ASIN 库里选一个产品，这里就显示它的九项门槛；'
        + '每一门的判据、实测值与分母都能单独读到。',
    });
  }
  return '<div class="empty">'
    + '服务端这一次没有产出判定（来源：' + escapeHtml(String(data.precheckSource || '未给出')) + '）。'
    + '占位不说「通过」—— 「没有判定」与「判定通过」是两件事。'
    + '</div>';
}

function precheckReportBlock(report, source) {
  const gates = Array.isArray(report.gates) ? report.gates : [];
  const counts = report.counts || {};
  const parts = [];

  parts.push('<div class="bar" style="flex-wrap:wrap">'
    + precheckVerdictChip(report.verdict)
    + '<span class="chip">' + (counts.pass || 0) + ' 通过 / ' + (counts.degrade || 0) + ' 降级 / '
    + (counts.block || 0) + ' 阻断（共 ' + (counts.total || gates.length) + ' 项）</span>'
    + '<span class="hint" style="padding:0">' + escapeHtml(PRECHECK_SOURCE_TEXT[source] || String(source || '来源未给出')) + '</span>'
    + '<span class="opt-meta">判定 ' + escapeHtml(shortTime(report.at)) + '</span>'
    + '</div>');

  if (report.blocked === true) {
    parts.push('<div class="hint"><span class="chip stop">阻断</span> 有阻断项：这一轮<strong>不生成、不写入</strong>。'
      + '先按下面的补数清单补齐，再重跑。审核模式（只检查不生成）仍然可以只做检查。</div>');
  }

  parts.push('<table><thead><tr><th>#</th><th>门槛</th><th>结果</th><th>实测 / 分母</th><th>判据</th></tr></thead><tbody>'
    + gates.map(gate => '<tr>'
      + '<td>' + escapeHtml(String(gate.index)) + '</td>'
      + '<td>' + escapeHtml(gate.label) + '</td>'
      + '<td>' + precheckVerdictChip(gate.verdict) + '</td>'
      + '<td>' + escapeHtml(precheckCountText(gate.counts)) + '</td>'
      + '<td>' + escapeHtml(gate.criterion) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>');

  /* 逐项的实测值与「缺什么 / 去哪里补」。表格只装得下结论，而这一批的验收标准是
     「不满足输出补数清单或降级说明，不能悄悄猜」—— 所以清单必须画出来，且每一条都
     带模块与工具名，读者才知道去哪儿动手。 */
  for (const gate of gates) {
    const lines = [];
    const measured = Array.isArray(gate.measured) ? gate.measured : [];
    const missing = Array.isArray(gate.missing) ? gate.missing : [];
    const remedy = Array.isArray(gate.remedy) ? gate.remedy : [];
    lines.push('<div style="padding:6px 0"><strong>' + escapeHtml(String(gate.index) + '. ' + gate.label) + '</strong> '
      + precheckVerdictChip(gate.verdict) + '</div>');
    lines.push('<div class="hint">判据：' + escapeHtml(gate.criterion) + '</div>');
    if (measured.length > 0) {
      lines.push('<div class="hint">实测（分母 ' + escapeHtml(precheckCountText(gate.counts)) + '）：'
        + measured.map(entry => escapeHtml(entry.name + '：' + entry.value)
          + (entry.at ? '（观测 ' + escapeHtml(shortTime(entry.at)) + '）' : '')).join('　·　') + '</div>');
    }
    if (missing.length > 0) {
      lines.push('<div class="hint">缺什么：' + missing.map(text => escapeHtml(text)).join('；') + '</div>');
      if (remedy.length > 0) {
        lines.push('<div class="hint">去哪里补：' + remedy.map(fix => escapeHtml(fix.moduleLabel + '：' + fix.action)
          + (fix.tool ? '（' + escapeHtml(fix.tool) + '）' : '')).join('；') + '</div>');
      }
    }
    for (const note of (Array.isArray(gate.degradeNotes) ? gate.degradeNotes : [])) {
      lines.push('<div class="hint">降级说明：' + escapeHtml(note) + '</div>');
    }
    parts.push(lines.join(''));
  }

  parts.push('<div class="hint">这一块<strong>不自己判</strong>：每一门的结论都来自服务端同一份报告，'
    + '与 <code>amzn_optimize_precheck</code> 的返回逐字同源。要在会话里核对，调它一次即可。</div>');
  return parts.join('');
}

/* "matched / total label" — 分母 is spelled out, because a bare "2" cannot say
   whether it is 2 of 4 core fields or 2 findings. */
function precheckCountText(counts) {
  const value = counts || {};
  return (value.matched ?? 0) + ' / ' + (value.total ?? 0) + ' ' + (value.label ?? '');
}

function renderPrecheck(data) {
  const box = $('optprecheck');
  if (box === null) return;
  if (!data) { box.innerHTML = ''; return; }

  const modes = Array.isArray(data.modes) ? data.modes : [];
  const scopes = Array.isArray(data.targetedScopes) ? data.targetedScopes : [];
  const mode = String(data.mode || '');
  const parts = [];

  parts.push('<div class="rule-sect">优化前置门槛（九项）与模式</div>');
  parts.push(precheckModeBar(data, modes, mode, scopes));
  parts.push(data.precheck ? precheckReportBlock(data.precheck, data.precheckSource)
    : precheckMissingState(data, mode));
  box.innerHTML = parts.join('');

  /* 选择即请求：换模式 / 换专项都走服务端重算，页面不拿本地状态自己推一份判定 ——
     那样页面就会在「服务端说阻断」时显示「通过」，而两者都不会报错。 */
  const modeSelect = $('optMode');
  if (modeSelect !== null) {
    modeSelect.value = mode;
    modeSelect.onchange = () => {
      const next = String(modeSelect.value || '');
      patchContext({
        filters: {
          ...(state.filters || {}),
          optimizeMode: next,
          /* 换回非专项时把范围清成 null：留着一个旧 scope，服务端会继续按「专项」
             解析，而页面顶部写着「全量」—— 同一个面板上两个模式同时生效。 */
          optimizeScope: next === 'targeted' ? ((state.filters || {}).optimizeScope ?? null) : null,
        },
      });
    };
  }
  const scopeSelect = $('optScope');
  if (scopeSelect !== null) {
    scopeSelect.value = String(data.scope || '');
    scopeSelect.onchange = () => {
      const next = String(scopeSelect.value || '');
      patchContext({
        filters: { ...(state.filters || {}), optimizeMode: 'targeted', optimizeScope: next === '' ? null : next },
      });
    };
  }
}
`
