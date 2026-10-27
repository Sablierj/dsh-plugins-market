/**
 * 页签「rules」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const rulesScript = `/* 当前选中的缺口筛选：null / 'missing' / 'docs'。
   放在函数外，因为每次刷新都会重画整页 —— 放在 renderRules 里面会被下一次轮询清掉，
   读者点开的筛选会自己弹回去。 */
let rulesGapFilter = null;

/* ── 用户文案词表（单源 / CR-4）──────────────────────────────────────────
   设计稿 design-opt-v3 §5：用户文案说中文，技术 id 不消失 —— 挪进 title。这张
   表是**页面层的一份**：rules（kind / 出处里的 §）与 agent（运行状态、步骤状态、
   步骤名）都读它，不各页各译一套。角色名**不在这张表里** —— 角色的中文名由服务端
   随 data.roles 下发（domain/agent/roles.js 的 label），页面引用它，不抄第二份。
   ⚠️ 真正的单源应该在服务端（像 ASIN_TAB_LABELS 那样注入）；page.js 的注入通道
   本轮不许动（T61 写域），迁移建议见 team/dev/t60-design-p1-2026-10-23.md。
   ⚠️ 查不到的值原样输出，不猜（与 shopLabel 同一条规矩）。
   ⚠️ 译名已由设计席逐条复核定稿（team/design/ui-terms-review-2026-10-23.md：31 条
   25 过 6 改，改词已按其 §6 落在本表）；再改词先改那份定稿再回写。 */
const UI_TERMS = {
  headers: { kind: '类型' },
  kind: { code: '代码', doc: '文档', lexicon: '词表', threshold: '阈值' },
  runStatus: {
    draft: '草稿', ready: '就绪', running: '进行中', waiting_human: '待人工',
    blocked: '已阻塞', completed: '已完成', failed: '失败', cancelled: '已取消',
    abandoned: '已放弃',
  },
  stepStatus: { pending: '待执行', running: '进行中', passed: '已通过', failed: '失败', skipped: '已跳过' },
  /* 补充数据请求的三态（amzn_agent_data_request）。定稿词把「仍缺」烙进词面
     （ui-terms-review §3 铁律）：open 与 declined 都是**缺口仍在**（没到 / 不给），
     只有 fulfilled 才关缺口 —— 只看词面把三态读成流程状态就是口径事故。
     显示处还必须同屏带一句 note（「缺口未补时结论只能『无法判断』」），那句在
     agent.js 的 requestBlock，不在词表里。 */
  requestStatus: { open: '待补（仍缺）', fulfilled: '已补', declined: '不补（仍缺）' },
  steps: {
    'read-pipeline-run': '读管道运行', 'interpret-quality': '解读质量', 'emit-trusted-scope': '输出可信域',
    'read-master': '读词库', 'compare-competitor': '对比竞品', 'propose-package': '提出词包',
    'read-history': '读管道历史', 'propose-rerun': '提出重跑建议', 'check-cadence': '检查周期',
    'check-env': '检查环境', 'preview-scope': '预览范围', 'propose-plan': '提出计划',
    'read-own-coverage': '读自有覆盖', 'compare-quadrants': '对比象限', 'emit-opportunities': '输出机会词',
    'read-coverage': '读覆盖', 'emit-plan-draft': '输出计划草案',
    'read-strategy': '读策略', 'draft-fields': '起草字段', 'validate-draft': '校验草案',
    'read-rules': '读规则', 'check-draft': '检查草案', 'emit-verdict': '输出判定',
    'read-publication': '读发布记录', 'pull-metrics': '读取指标', 'emit-report': '输出报告',
  },
};

function uiTerm(table, value) {
  const key = String(value ?? '');
  const map = UI_TERMS[table] || {};
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : (key === '' ? '—' : key);
}

/* 出处里的「§1.2」印成「第 1.2 节」，原文进 title —— 排版字符不进正文（§5.1）。
   没有 § 的出处原样返回；正则刻意不用反斜杠转义（切片是模板字面量，反斜杠会被
   外层先吃掉一层，check-page ② 抓的正是这种事故）。 */
function ruleSourceText(source) {
  return String(source ?? '').replace(/§[ ]*([0-9]+(?:[.-][0-9]+)*)/g, '第 $1 节');
}

function ruleSourceCell(source) {
  const raw = String(source ?? '');
  if (raw === '') return '';
  return '<span title="' + escapeHtml('出处原文：' + raw) + '">' + escapeHtml(ruleSourceText(raw)) + '</span>';
}

function renderRules() {
  const rules = state.rules;
  if (!rules) { $('ruletable').innerHTML = ''; return; }

  /* The version selector is the only control that changes what the table shows.
     Switching it is a filter change, so it goes through context like every other
     control — the server rebuilds the roster for the chosen version. */
  const select = $('ruleVersion');
  if (rules.versions.length === 0) {
    select.innerHTML = '<option value="">' + escapeHtml(rules.version) + '（代码种子）</option>';
  } else {
    select.innerHTML = rules.versions.map(version =>
      '<option value="' + escapeHtml(version.version) + '"' + (version.version === rules.version ? ' selected' : '') + '>'
      + escapeHtml(version.version) + (version.isActive ? '（生效中）' : '') + ' · ' + version.enabledCount + '/' + version.ruleCount
      + '</option>').join('');
  }

  const s = rules.stats;
  /* title 是技术 id 的去处（CR-4 §5.1）：chip 上印中文，kind 的原值挂在悬停里。 */
  const chip = (label, value, cls, title) => '<span class="chip ' + (cls || '') + '"'
    + (title === undefined ? '' : ' title="' + escapeHtml(title) + '"') + '>'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + '</span>';
  /* 缺口 chip 是筛选按钮，不是读数：点击切换「只看这张缺口表」，再次点击取消。
     aria-pressed 是状态本身，样式从它来（见 page.js 的 button.chip 规则），
     不靠一个只在某次渲染里存在的 class。 */
  const gapChip = (key, label, value, cls, title) => '<button type="button" class="chip '
    + (cls || '') + '" data-rule-gap="' + key + '" aria-pressed="'
    + (rulesGapFilter === key ? 'true' : 'false') + '" title="' + escapeHtml(title) + '">'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + ' ›</button>';
  $('rulestats').innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('共', s.total)
    + chip('阻断', s.block, 'stop')
    + chip('警告', s.warn, 'warn')
    + chip(uiTerm('kind', 'code'), s.code, 'ok', 'kind=code')
    + chip(uiTerm('kind', 'doc'), s.doc, s.doc > 0 ? 'ok' : '', 'kind=doc')
    + chip(uiTerm('kind', 'lexicon'), s.lexicon, '', 'kind=lexicon')
    + chip(uiTerm('kind', 'threshold'), s.threshold, '', 'kind=threshold')
    + gapChip('missing', '有判定无文档', rules.rulesWithoutDoc.length,
      rules.rulesWithoutDoc.length > 0 ? 'stop' : '',
      '这些代码（kind=code）规则照常参与校验，但 source 指向的不是手册小节；点一下只看这张缺口表')
    + gapChip('docs', '有文档无判定', rules.docsWithoutCheck.length,
      rules.docsWithoutCheck.length > 0 ? 'warn' : '',
      '这些手册小节没有 code 规则引用；多数是说明文，不是缺陷')
    + '<button type="button" id="ruleGapClear" style="display:' + (rulesGapFilter === null ? 'none' : '')
    + '">清除筛选</button>'
    + (rules.fromCode ? chip('来自代码种子', '（库里还没有 roster）', 'warn') : '')
    + '</div>';

  for (const button of $('rulestats').querySelectorAll('button[data-rule-gap]')) {
    button.onclick = () => {
      rulesGapFilter = rulesGapFilter === button.dataset.ruleGap ? null : button.dataset.ruleGap;
      renderRules();
      const target = $(rulesGapFilter === 'docs' ? 'ruledocs' : 'rulemissing');
      if (rulesGapFilter !== null && target !== null && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start' });
      }
    };
  }
  const gapClear = $('ruleGapClear');
  if (gapClear !== null) {
    gapClear.onclick = () => { rulesGapFilter = null; renderRules(); };
  }

  const cell = value => (value === null || value === undefined || value === '' ? '' : escapeHtml(String(value)));
  const sev = value => (value === 'block'
    ? '<span class="chip stop">阻断</span>'
    : '<span class="chip warn">警告</span>');
  /* code = 判定在代码里；doc = 只有正文与出处，不参与 validate。 The two are drawn
     differently on purpose: after an import the table fills with 43 doc rows, and
     a reader who cannot tell them apart would take "导入了手册" for "规则就绪".
     值的中文名来自 UI_TERMS（CR-4）；kind 的原值挂 title，未收录的值原样显示。 */
  const kindCell = kind => {
    const raw = String(kind ?? '');
    return (raw === 'doc'
      ? '<span class="chip" title="kind=' + escapeHtml(raw) + '">' + escapeHtml(uiTerm('kind', raw)) + ' · 只有正文</span>'
      : '<span class="chip ok" title="kind=' + escapeHtml(raw) + '">' + escapeHtml(uiTerm('kind', raw)) + ' · 判定在代码</span>');
  };
  $('ruletable').innerHTML = '<table><thead><tr>'
    + '<th style="width:44px">启用</th><th>rule_id</th><th>适用</th><th>严重度</th><th>标题</th><th>出处</th><th title="kind">类型</th><th>受政策</th></tr></thead><tbody>'
    + rules.rows.map(row => '<tr>'
      + '<td><input class="chk" type="checkbox" data-rule="' + escapeHtml(row.id) + '"' + (row.enabled ? ' checked' : '') + '></td>'
      + '<td><code>' + escapeHtml(row.id) + '</code></td>'
      + '<td>' + cell((row.appliesTo || []).join(',')) + '</td>'
      + '<td>' + sev(row.severity) + '</td>'
      + '<td title="' + escapeHtml(row.title) + '">' + escapeHtml(row.title) + '</td>'
      + '<td>' + ruleSourceCell(row.source) + '</td>'
      + '<td>' + kindCell(row.kind) + '</td>'
      + '<td>' + policyCells(row.policies) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';

  /* One POST per toggle, straight to /api/rule-toggle. The server publishes a new
     version, so the version number in the stats bar changes on the next refresh —
     which is the visible proof the switch reached the store. */
  for (const box of $('ruletable').querySelectorAll('input[data-rule]')) {
    box.onchange = async () => {
      box.disabled = true;
      try {
        await api('rule-toggle', {
          method: 'POST',
          body: JSON.stringify({ ruleId: box.dataset.rule, enabled: box.checked }),
        });
      } catch (error) {
        showPageError(error);
      } finally {
        box.disabled = false;
        await refresh();
      }
    };
  }

  renderRuleMissing(rules);
  renderRuleDocs(rules);
  renderRuleImpl(rules);

  const version = rules.version;
  $('ruleImport').onclick = () => usePrompt('把规则手册导入成新版本：先 dryRun 给我看新增、变更、移除的差异，不要直接写库。');
  $('ruleDiff').onclick = () => usePrompt('对比规则版本 ' + version + ' 和它的上一个版本，列出新增、移除、改了哪些字段。');
  $('ruleActivate').onclick = () => usePrompt('把规则版本 ' + version + ' 设为生效版本，并确认版本链没断。');

  applyRulesGapFilter();
}

/* 缺口筛选的显隐。只动 DOM 的 display，不动数据 —— 两张缺口表仍然由
   renderRuleMissing / renderRuleDocs 按真实数据画。「ruleimpl」（有规则无判定）
   刻意**不**受筛选影响：它是 validate 会阻断的那一类，不能被一个筛选藏起来。 */
function applyRulesGapFilter() {
  const active = rulesGapFilter;
  const showMissing = active === null || active === 'missing';
  const showDocs = active === null || active === 'docs';
  const table = $('ruletable');
  if (table !== null) table.style.display = active === null ? '' : 'none';
  const missing = $('rulemissing');
  if (missing !== null) missing.style.display = showMissing ? '' : 'none';
  const docs = $('ruledocs');
  if (docs !== null) docs.style.display = showDocs ? '' : 'none';
  const missingTitle = $('rulemissingtitle');
  if (missingTitle !== null) missingTitle.style.display = showMissing ? '' : 'none';
  const docsTitle = $('ruledocstitle');
  if (docsTitle !== null) docsTitle.style.display = showDocs ? '' : 'none';
  const impl = $('ruleimpl');
  if (impl !== null) impl.style.display = '';
  const clear = $('ruleGapClear');
  if (clear !== null) clear.style.display = active === null ? 'none' : '';
  for (const button of $('rulestats').querySelectorAll('button[data-rule-gap]')) {
    const on = button.dataset.ruleGap === active;
    if (typeof button.setAttribute === 'function') button.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (button.classList && typeof button.classList.toggle === 'function') button.classList.toggle('active', on);
  }
}

/* 有判定无文档: a kind=code rule whose source cites no section of the manual.
   It still runs — validate judges it — but the manual does not carry it, so the
   citation a reader would go looking for is not there. */
function renderRuleMissing(rules) {
  const missing = rules.rulesWithoutDoc;
  /* 读不到手册与「0 条缺口」是两件事。以前这一段先判 length===0，手册读不到时
     会印「无」—— 把「算不出来」说成「一条都没有」，正是本仓禁止的那种 0。 */
  if (rules.manualError) {
    $('rulemissing').innerHTML = '<div class="hint" style="border-left:3px solid var(--warn)">'
      + '读不到手册（' + escapeHtml(rules.manualError) + '），两个缺口都算不出来 —— <strong>这不是 0</strong>。</div>';
    return;
  }
  if (missing.length === 0) {
    $('rulemissing').innerHTML = '<div class="hint" style="color:var(--ok)">'
      + '有判定无文档：0 —— ' + escapeHtml(String(rules.stats.code)) + ' 条代码规则（kind=code）都能在手册里找到出处。</div>';
    return;
  }
  $('rulemissing').innerHTML = '<div class="hint" style="border-left:3px solid var(--stop);color:var(--stop)">'
    + '这 ' + missing.length + ' 条规则照常参与校验，缺的是手册里的那一节 —— 不是判定坏了。'
    + '（多来自 SOP / 引擎规格 / 交付说明 / 代码资产；这里报的是「手册里找不到出处」，不是「判定缺失」。）</div>'
    + '<div class="b05c-head"><strong>有判定无文档（' + missing.length + '）</strong>'
    + '<button type="button" data-copy-all="' + escapeHtml(missing.map(row => row.id).join(','))
    + '">复制全部 id</button></div>'
    + '<table><thead><tr><th>rule_id</th><th>适用</th><th>标题</th><th>出处</th><th title="kind">类型</th><th>动作</th></tr></thead><tbody>'
    + missing.map(row => '<tr>'
      + '<td><code>' + escapeHtml(row.id) + '</code></td>'
      + '<td>' + escapeHtml((row.appliesTo || []).join(',')) + '</td>'
      + '<td>' + escapeHtml(row.title) + '</td>'
      + '<td>' + ruleSourceCell(row.source) + '</td>'
      + '<td><span class="chip stop" title="kind=code">' + escapeHtml(uiTerm('kind', 'code')) + ' · 手册无出处</span></td>'
      + '<td><button type="button" data-copy-rule="' + escapeHtml(row.id) + '">复制 rule_id</button> '
      + '<button type="button" data-draft-rule="' + escapeHtml(row.id) + '">请 Agent 起草</button></td>'
      + '</tr>').join('')
    + '</tbody></table>'
    + '<div class="hint">「请 Agent 起草」只复制一段 prompt，不会直接写库；起草内容先给你看。</div>';
  bindRuleGapActions('rulemissing');
}

/* 有文档无判定: a manual section no code rule answers to. Not a defect — most of
   the manual is prose — but the reason an import must not be sold as readiness. */
function renderRuleDocs(rules) {
  const docs = rules.docsWithoutCheck;
  if (rules.manualError) {
    $('ruledocs').innerHTML = '<div class="hint" style="border-left:3px solid var(--warn)">'
      + '读不到手册（' + escapeHtml(rules.manualError) + '），两个缺口都算不出来 —— <strong>这不是 0</strong>。</div>';
    return;
  }
  if (docs.length === 0) {
    $('ruledocs').innerHTML = '<div class="hint">'
      + '有文档无判定：0 —— 手册每个小节都有 code 规则引用。</div>';
    return;
  }
  $('ruledocs').innerHTML = '<div class="hint" style="border-left:3px solid var(--warn)">'
    + '这 ' + docs.length + ' 个小节是说明文，不是可判定的规则；导入手册 ≠ 规则就绪。'
    + '（它们是公式 / 建议 / 算法 / 指标 / 清单，本来就不参与 validate。）</div>'
    + '<div class="b05c-head"><strong>有文档无判定（' + docs.length + '）</strong>'
    + '<button type="button" data-copy-all="' + escapeHtml(docs.map(row => row.id).join(','))
    + '">复制全部 id</button></div>'
    + '<table><thead><tr><th>doc id</th><th>小节标题</th><th>动作</th></tr></thead><tbody>'
    + docs.map(row => '<tr><td><code>' + escapeHtml(row.id) + '</code></td>'
      + '<td>' + escapeHtml(row.title || '') + '</td>'
      + '<td><button type="button" data-copy-doc="' + escapeHtml(row.id) + '">复制 doc id</button> '
      + '<button type="button" data-assess-doc="' + escapeHtml(row.id) + '">请 Agent 评估能否落成判定</button></td></tr>').join('')
    + '</tbody></table>';
  bindRuleGapActions('ruledocs');
}

/* 行内动作：复制 id 走剪贴板；「请 Agent 起草 / 评估」只复制一段 prompt。
   两者都不写库 —— 起草内容先给人看，这是 §11 的那条纪律。 */
function copyRuleText(text, button) {
  const value = String(text === null || text === undefined ? '' : text);
  if (value === '') { showToast('没有可复制的 id'); return; }
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    showToast('这台机器不允许写剪贴板，请手动复制：' + value.slice(0, 60));
    return;
  }
  navigator.clipboard.writeText(value).then(
    () => {
      const old = button.textContent;
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = old; }, 1500);
    },
    () => showToast('剪贴板被拒（需要安全上下文），请手动复制：' + value.slice(0, 60)),
  );
}

function bindRuleGapActions(containerId) {
  const box = $(containerId);
  if (box === null) return;
  for (const button of box.querySelectorAll('button[data-copy-rule]')) {
    button.onclick = () => copyRuleText(button.dataset.copyRule, button);
  }
  for (const button of box.querySelectorAll('button[data-copy-doc]')) {
    button.onclick = () => copyRuleText(button.dataset.copyDoc, button);
  }
  for (const button of box.querySelectorAll('button[data-copy-all]')) {
    button.onclick = () => copyRuleText(String(button.dataset.copyAll || '').split(',').join('\\n'), button);
  }
  for (const button of box.querySelectorAll('button[data-draft-rule]')) {
    button.onclick = () => usePrompt('请为规则 ' + button.dataset.draftRule
      + ' 在手册里起草一节，说明判定条件、适用字段、阻断/警告级别与出处；先给我看，不要直接写库。');
  }
  for (const button of box.querySelectorAll('button[data-assess-doc]')) {
    button.onclick = () => usePrompt('请评估手册小节 ' + button.dataset.assessDoc
      + ' 能否落成一条可判定规则：说明判定条件、适用字段、阻断/警告级别与出处；先给我看，不要直接写库。');
  }
}

/* 有规则无判定: the roster says a row is a kind=code rule and CHECKS has no
   function for it — the data and the code have diverged. validate reports it as
   rule-check-missing and blocks (fail-closed); this is the one place that
   decision shows as a red bar instead of a line in a report, so it must not be
   hidden. Drawn only when non-empty — an empty section would just be noise. */
function renderRuleImpl(rules) {
  const impl = rules.implMissing || [];
  if (impl.length === 0) { $('ruleimpl').innerHTML = ''; return; }
  $('ruleimpl').innerHTML = '<div class="rule-sect" style="color:var(--stop)">有规则无判定（roster 说是 code 规则，<code>CHECKS</code> 里却没有实现）</div>'
    + '<div class="hint" style="border-left:3px solid var(--stop);color:var(--stop)">'
    + '⚠️ 判定缺失必须显式报，不许当通过：下面 ' + impl.length
    + ' 条 <code>kind=code</code> 规则在 <code>CHECKS</code> 里找不到判定，<code>validate</code> 会报 '
    + '<code>rule-check-missing</code> 并阻断 —— 补上实现，或改成 <code>kind=doc</code> / 停用它们。</div>'
    + '<table><thead><tr><th>rule_id</th><th>适用</th><th>标题</th><th>出处</th><th title="kind">类型</th></tr></thead><tbody>'
    + impl.map(row => '<tr>'
      + '<td><code>' + escapeHtml(row.id) + '</code></td>'
      + '<td>' + escapeHtml((row.appliesTo || []).join(',')) + '</td>'
      + '<td>' + escapeHtml(row.title) + '</td>'
      + '<td>' + ruleSourceCell(row.source) + '</td>'
      + '<td><span class="chip stop" title="kind=code">' + escapeHtml(uiTerm('kind', 'code')) + ' · 无判定</span></td>'
      + '</tr>').join('')
    + '</tbody></table>';
}

/* ── 最新政策 ─────────────────────────────────────────────────────────── */

/* Policy is the input and a rule is the product, so this panel is the rule panel's
   upstream: what arrived, when it takes effect, and which rules it moved.

   The severity chip is drawn from severity_hint and says 「未判定」 when the policy
   never stated one. Drawing a default there would be inventing a conclusion — the
   whole point of keeping the column nullable. */
const POLICY_STATUS = {
  active: ['生效中', 'ok'],
  superseded: ['已被取代', ''],
  expired: ['已过期', 'warn'],
};

function policyStatusChip(status) {
  const entry = POLICY_STATUS[status] || [status || '—', ''];
  return '<span class="chip ' + entry[1] + '">' + escapeHtml(entry[0]) + '</span>';
}

/* 高 / 中 / 低 come from the policy's own words; NULL is 「未判定」, never a guess.
   The wording the level was read from is drawn next to it: a bare 「高」 reads as
   Amazon's own classification, and it is our reading of a phrase. */
function severityChip(hint, raw) {
  let level = '';
  let cls = '';
  if (hint === 'high') { level = '高'; cls = 'stop'; }
  else if (hint === 'medium') { level = '中'; cls = 'warn'; }
  else if (hint === 'low') { level = '低'; }
  if (level === '') return '<span class="chip">未判定</span>';
  const phrase = raw === null || raw === undefined ? '' : String(raw).trim();
  if (phrase === '') return '<span class="chip ' + cls + '">' + level + '</span>';
  const shown = phrase.length > 16 ? phrase.slice(0, 15) + '…' : phrase;
  return '<span class="chip ' + cls + '" title="原文：' + escapeHtml(phrase) + '">' + level
    + '<span style="opacity:.72">（原文：「' + escapeHtml(shown) + '」）</span></span>';
}

/* The rules tab's 「受政策 X 影响」 cell. X is the policy title, truncated — a bare
   id would be a citation nobody can read. */
function policyCells(list) {
  if (!list || list.length === 0) return '';
  return list.map(policy => {
    const title = policy.title && policy.title.length > 16 ? policy.title.slice(0, 15) + '…' : (policy.title || policy.id);
    return '<span class="chip ' + (policy.status === 'active' ? 'warn' : '') + '" title="'
      + escapeHtml(policy.title || policy.id) + '">受政策 ' + escapeHtml(title) + ' 影响</span>';
  }).join(' ');
}

/* 「取代了谁 / 被谁取代」. The stored link only points one way — superseded_by says
   who replaced this policy — so the reverse (who this policy replaced) comes from
   the server's supersedes list. Both are drawn: a chain a reader can walk one way
   only is half a chain, and the page has a 「已被取代」 filter that would otherwise
   show a replacement with no visible predecessor. */
function supersedeCell(row) {
  const parts = [];
  if (row.supersededBy) {
    parts.push('<span class="chip" title="被 ' + escapeHtml(String(row.supersededBy))
      + ' 取代">被取代</span>');
  }
  const replaced = row.supersedes || [];
  if (replaced.length > 0) {
    parts.push('<span class="chip warn" title="取代了 ' + escapeHtml(replaced.join(', '))
      + '">取代了 ' + replaced.length + ' 条</span>');
  }
  return parts.join(' ');
}
`
