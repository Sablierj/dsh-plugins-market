/**
 * 页签「agent」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const agentScript = `function renderAgent() {
  const data = state.agent;
  if (!data) {
    if ($('agruns') !== null) $('agruns').innerHTML = '';
    if ($('agrun') !== null) $('agrun').innerHTML = '';
    if ($('agroles') !== null) $('agroles').innerHTML = '';
    if ($('agmetrics') !== null) $('agmetrics').innerHTML = '';
    if ($('aggaps') !== null) $('aggaps').innerHTML = '';
    return;
  }
  const listed = data.runs || { rows: [], total: 0 };
  const selected = (data.runs.rows || []).filter(entry => entry.id === data.selectedRunId)[0]
    || (data.runs.rows || [])[0] || null;

  if ($('agHint') !== null) {
    $('agHint').textContent = '共 ' + listed.total + ' 次运行，显示最近 ' + listed.rows.length + ' 次'
      + ' · 可用角色 ' + (data.roles || []).filter(role => role.available).length + '/' + (data.roles || []).length;
  }

  $('agruns').innerHTML = '<table><thead><tr><th>运行</th><th>角色</th><th>类型</th><th>状态</th><th>步</th>'
    + '<th>产物</th><th>开始</th></tr></thead><tbody>'
    + listed.rows.map(entry => '<tr data-runid="' + escapeHtml(entry.id) + '" class="'
      + (selected !== null && entry.id === selected.id ? 'sel' : '') + '">'
      + '<td><code title="' + escapeHtml(entry.id) + '">' + escapeHtml(String(entry.id).slice(0, 14)) + '</code></td>'
      + '<td>' + escapeHtml(entry.roleLabel) + '</td>'
      + '<td>' + escapeHtml(agentTaskTypeText(entry.taskType, data.taskTypeLabels)) + '</td>'
      + '<td>' + agentStatusChip(entry.status, 'runStatus') + '</td>'
      + '<td>' + entry.stepCount + '</td>'
      + '<td>' + entry.artifactCount + '</td>'
      + '<td>' + escapeHtml(shortTime(entry.startedAt)) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>'
    + (listed.rows.length === 0
      ? emptyState('not-recorded', {
        subject: 'Agent 运行',
        next: '在对话里说「让数据管家看一遍这次的导入」，或直接调 amzn_agent_run_start。',
      })
      : '');
  for (const row of $('agruns').querySelectorAll('tr[data-runid]')) {
    row.onclick = () => patchContext({ module: 'agent', filters: { ...state.filters, agentRunId: row.dataset.runid } });
  }

  if (selected === null) {
    $('agrun').innerHTML = '';
  } else {
    const detail = data.selected || null;
    $('agrun').innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
      + '<strong style="font-size:12px">' + escapeHtml(selected.roleLabel) + ' · '
      + escapeHtml(selected.goal || '（没有写目标）') + '</strong>'
      + '<span class="hint" style="margin:0 8px">类型: '
      + escapeHtml(agentTaskTypeText(selected.taskType, data.taskTypeLabels)) + '</span>'
      + agentStatusChip(selected.status, 'runStatus')
      + '</div>'
      + (selected.waitingReason ? '<div class="hint" style="color:var(--warn)">在等：' + escapeHtml(selected.waitingReason) + '</div>' : '')
      + (selected.blockedReason ? '<div class="hint" style="color:var(--stop)">卡住：' + escapeHtml(selected.blockedReason) + '</div>'
        + blockedExits(selected, data.blockedKinds) : '')
      + (detail === null
        ? '<div class="hint">点上面任意一次运行看步骤与产物。</div>'
        /* ⚠️ 顺序有约束：snapshotBlock(detail) 与 nextStepBlock(detail) **必须相邻** ——
           F12-05 的接线守卫钉的正是这两个调用挨在一起（它走函数名，不是 grep 一句文案）。
           F12-06 的运行入口**加在它们之后**，不要插进中间。 */
        : snapshotBlock(detail)
          + nextStepBlock(detail) + runActions(detail) + retryBudgetBlock(detail)
          + stepBlock(detail) + artifactBlock(detail, data.artifactTypes, data.artifactStatusLabels)
          + gateBlock(detail) + requestBlock(data.dataRequests) + runCopyBlock(detail));
  }

  $('agroles').innerHTML = '<table><thead><tr><th>角色</th><th>职责</th><th>步骤契约</th><th>门禁</th></tr></thead><tbody>'
    + (data.roles || []).map(role => '<tr>'
      + '<td><strong>' + escapeHtml(role.label) + '</strong>'
      + (role.available ? ' <span class="chip ok">本版可用</span>' : ' <span class="chip">未接入</span>')
      + '<br><span class="opt-meta">' + escapeHtml(role.id) + '</span></td>'
      + '<td>' + escapeHtml(role.duty)
      + (role.available ? '' : '<br><span class="opt-meta">缺：' + escapeHtml(role.why || '') + '</span>') + '</td>'
      + '<td>' + (role.steps.length === 0 ? '—'
        : role.steps.map(step => '<span class="opt-meta">' + agentStepName(step) + '</span>').join(' → ')) + '</td>'
      + '<td>' + (role.gates.length === 0 ? '—'
        : role.gates.map(gate => '<span class="chip warn">' + escapeHtml(gate) + '</span>').join(' ')) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';

  for (const button of $('agrun').querySelectorAll('button[data-gate]')) {
    button.onclick = () => decideGate(button.dataset.gaterun, button.dataset.gate, button.dataset.approve === '1');
  }
  /* 两个出口按钮各接一次 patchContext —— 与导航按钮（renderNav）同一件机制，只是多带
     一个页内分区：去来源模块落到 settings 面板的 sect-sources。按钮上不写任何写动作。 */
  for (const button of $('agrun').querySelectorAll('button[data-blockedexit]')) {
    button.onclick = () => {
      const section = button.dataset.blockedsection;
      lastSection = null;
      patchContext({
        module: button.dataset.blockedexit,
        filters: section === undefined
          ? { ...state.filters }
          : { ...state.filters, settingsSection: section },
      });
    };
  }
  /* F12-06 / F12-09：运行入口（取消 / 修复后继续 / 取代重开）。与上面两个出口按钮同一件
     机制，只是多带一个动作名。
     ⚠️ 那个带 data-blockedretry 的按钮**不绑**：它有 disabled、点不动，绑一个永远不
     触发的处理函数，正是本仓「注释比代码强」那一类（一句「这里处理重试」而实际永不执行）。
     它的存在是为了让人**知道**有这个动作（§9 逐字要求它显示且禁用），不是为了被点。 */
  for (const button of $('agrun').querySelectorAll('button[data-runaction]')) {
    button.onclick = () => runAction(button.dataset.runaction, button.dataset.runid);
  }
  /* F12-10：页面→会话的「复制去问 agent」。与 usePrompt 的先例同一条路 —— 按钮不调工具，
     只把一段 prompt 放进 promptBox 并复制（本 harness 没有页面→会话的载荷通道）。 */
  for (const button of $('agrun').querySelectorAll('button[data-copyrun]')) {
    button.onclick = () => usePrompt(button.dataset.prompt);
  }
  $('agmetrics').innerHTML = metricsBlock(data.metrics);
  if ($('aggaps') !== null) $('aggaps').innerHTML = gapsBlock(data.gaps);
  renderAgentArtifacts(data);
  bindArtifactDecideClicks();
}

/* 运行状态到 chip 类的映射。状态词表在 domain/agent/roles.js，这里是它到颜色的
   一份投影 —— 值本身不在这里重写。 */
const AGENT_RUN_CHIPS = {
  draft: '', ready: '', running: 'run', waiting_human: 'warn', blocked: 'stop',
  completed: 'ok', failed: 'stop', cancelled: '',
};

/* ── 状态 / 步骤名 / 角色名的中文显示（CR-4 §5，词表见 rules.js 的 UI_TERMS）──
   文字来自页面层那一份单源词表；颜色来自上面 AGENT_RUN_CHIPS / AGENT_STEP_CHIPS
   两张投影；原值一律挂 title —— 技术 id 不从界面上消失。
   **不走** asin.js 的 statusChip：那张表是采集任务状态词表（服务端注入的
   COLLECTION_TASK_STATUS_LABELS），两套状态的词不能混 —— partial 在两处是两个
   意思，混用正是把任务状态当运行状态读的那种坑。
   ⚠️ 形参不叫那个被守卫扫的词（见上面 blockedExits 注释）。 */
function agentStatusChip(status, table) {
  const raw = String(status ?? '');
  const chips = table === 'stepStatus' ? AGENT_STEP_CHIPS : AGENT_RUN_CHIPS;
  const cls = Object.prototype.hasOwnProperty.call(chips, raw) ? chips[raw] : '';
  return '<span class="chip ' + cls + '" title="status=' + escapeHtml(raw) + '">'
    + escapeHtml(uiTerm(table, raw)) + '</span>';
}

/* 步骤名：中文显示名 + 英文 id 挂 title（§5.3）。词表查不到就原样显示 id，不猜。 */
function agentStepName(step) {
  const raw = String(step ?? '');
  return '<span title="步骤 id：' + escapeHtml(raw) + '">' + escapeHtml(uiTerm('steps', raw)) + '</span>';
}

/* 角色名：中文名用**服务端**那份（data.roles，源头 domain/agent/roles.js 的 label），
   页面不抄第二份；这一格以前直接印 collect-coordinator 这类技术 id。 */
function agentRoleName(roleId) {
  const raw = String(roleId ?? '');
  const roles = (state.agent || {}).roles || [];
  const hit = roles.filter(role => role.id === raw)[0];
  const label = hit === undefined || hit.label === undefined || hit.label === '' ? raw : hit.label;
  return '<span title="角色 id：' + escapeHtml(raw) + '">' + escapeHtml(label) + '</span>';
}

/* blocked 的出口动作（§9）—— **按原因分派**，不再是一对固定按钮（B-12.5 那两个
   不看原因、不管卡在什么上都是同样两个，那正是 F12-06 要消灭的东西）。
 *
 * 出口动作表**不在这一页**：它随 agent state 下发（routes.js 的 blockedKinds，源头是
 * domain/agent 里 BLOCKED_KINDS 那一处）。页面只照着画 —— 与 F12-03 的产物类型清单
 * 同一条规矩（一句事实活在两个文件里就会漂）。
 *
 * ⚠️ 这一页里**不许**出现那个会被守卫误读的路径字符串：有个守卫把整段脚本（**注释也算**）
 * 扫一遍，把「run 加一个点再加一个词」当成「页面读了 run 的这个字段」，再去 optimize 的
 * payload 里查。写一句文件路径就会让它报「页面画了 run 的某字段，而 payload 里是 undefined」。
 * 同理，本函数的形参**不叫** run —— 那个名字在这一页已经被 optimize 面板的 payload 占了。
 *
 * ⚠️ **三种「没有出口」是三句不同的话**（exitGap 字段）：
 *   - requirement-silent —— 需求没给这一类出口（规则不可用 / 采集风控）；
 *   - not-implementable —— 需求给了，但本插件做不到（权限那一类没有权限模型）；
 *   - not-reachable —— 出口做得到，但这一类**不可达**（成本那一类没有来源）。
 * 折成一句「没有出口」会把三种不同的下一件事混成一件。
 * ⚠️ reachable 不是 true 时**不画按钮** —— 一个永远点不着的按钮比没有按钮更糟。
 *
 * 「修复后重试」是**禁用**的（§9 逐字），旁边那条「我已修复，继续」才是能用的人工确认
 * 路径 —— 本插件检测不到「修好了没有」（契约 §6.2），所以由人断言，且必须说清修了什么。 */
function blockedExits(blockedRun, blockedKinds) {
  const kinds = Array.isArray(blockedKinds) ? blockedKinds : [];
  const definition = kinds.filter(kind => kind.id === blockedRun.blockedKind)[0];
  const head = '<div class="rule-sect">出口（按 blocked 原因分派 —— §9）</div>';
  let reasonLine;
  if (definition === undefined) {
    reasonLine = '<div class="hint">这条运行没有记 blocked 原因类别（v40 之前写的行），'
      + '所以给不出按原因分派的出口 —— 这里不猜一个。</div>';
  } else if (definition.exit !== null && definition.exit !== undefined && definition.reachable === true) {
    const exit = definition.exit;
    let control;
    if (exit.type === 'navigate') {
      control = '<button type="button" class="btn btn--ghost btn--sm" data-blockedexit="'
        + escapeHtml(exit.module) + '"'
        + (exit.section === undefined ? '' : ' data-blockedsection="' + escapeHtml(exit.section) + '"')
        + '>' + escapeHtml(exit.label) + '</button>';
    } else if (exit.type === 'act') {
      control = '<button type="button" class="btn btn--sm" data-runaction="' + escapeHtml(exit.action) + '"'
        + ' data-runid="' + escapeHtml(blockedRun.id) + '">' + escapeHtml(exit.label) + '</button>';
    } else {
      /* explain 那一类 —— 纯说明，不做任何事。本批词表里没有一条用它。 */
      control = '<span class="opt-meta">（' + escapeHtml(exit.label) + '）</span>';
    }
    reasonLine = '<div class="hint"><strong>' + escapeHtml(definition.label) + '</strong>：' + control + '</div>'
      + '<div class="opt-meta">' + escapeHtml(definition.exitNote || '') + '</div>';
  } else {
    const why = definition.exitGap === 'not-reachable'
      ? '出口本身做得到，但这一类**不可达** —— 所以没有按钮'
      : definition.exitGap === 'not-implementable'
        ? '需求给了出口，但本插件做不到 —— 所以没有按钮'
        : '需求没有给这一类出口 —— 所以没有按钮';
    reasonLine = '<div class="hint"><strong>' + escapeHtml(definition.label) + '</strong>：'
      + escapeHtml(why) + '</div>'
      + '<div class="opt-meta">' + escapeHtml(definition.exitNote || '') + '</div>';
  }
  return head + reasonLine
    + '<div class="bar" style="flex-wrap:wrap;gap:6px;margin-top:4px">'
    + '<button type="button" class="btn btn--ghost btn--sm" disabled data-blockedretry="1"'
    + ' title="§9：blocked 状态下「重试」改为「修复后重试」，**修复完成前禁用**。'
    + '本插件检测不到「修好了没有」，所以这个按钮永远点不动 —— 它在那里是为了让人知道有这个动作，不是为了被点。">修复后重试</button>'
    + '<button type="button" class="btn btn--sm" data-runaction="retry" data-runid="' + escapeHtml(blockedRun.id) + '"'
    + ' title="人工确认「我已经修好了」，然后继续这次运行。必须带一条理由说明修了什么 —— '
    + '本插件检测不到修复完成，所以由人断言（一条没有理由的确认与「需要确认」是同一种话）。">我已修复，继续</button>'
    + '<button type="button" class="btn btn--ghost btn--sm" data-runaction="cancel" data-runid="' + escapeHtml(blockedRun.id) + '"'
    + ' title="取消这次运行。已生成的产物**全部保留**并标为未完成（§12）—— 本仓库没有删除产物的路径。">取消这次运行</button>'
    + '</div>';
}

/* 运行入口（§9 的「恢复 / 重试 / 取消」）。
 *
 * ⚠️ **重试一个终止态运行只能新建一次运行**：RUN_EDGES 里 failed / completed /
 * cancelled 都是终止态、没有出边（见 domain/agent 的运行状态机），所以「重开」= 新建 +
 * supersedes_run_id 指向它。就地重开一个终止态会推翻 §6 的状态机。
 * blocked 的入口在 blockedExits 里画（那里的语义不同：它要「**修复后**重试」）。 */
function runActions(detail) {
  const buttons = [];
  if (['draft', 'ready', 'running', 'waiting_human'].indexOf(detail.status) >= 0) {
    buttons.push('<button type="button" class="btn btn--ghost btn--sm" data-runaction="cancel"'
      + ' data-runid="' + escapeHtml(detail.id) + '"'
      + ' title="取消这次运行。已生成的产物**全部保留**并标为未完成（§12）—— 本仓库没有删除产物的路径。">取消这次运行</button>');
  }
  if (['completed', 'failed', 'cancelled'].indexOf(detail.status) >= 0) {
    buttons.push('<button type="button" class="btn btn--ghost btn--sm" data-runaction="supersede"'
      + ' data-runid="' + escapeHtml(detail.id) + '"'
      + ' title="§12：上下文变化时**新建**一次运行，不修改旧的。终止态没有出边，所以「重试」只能是新建'
      + '（人工约束与输出格式沿用这次运行）。">重开一次运行（取代它）</button>');
  }
  if (buttons.length === 0) return '';
  return '<div class="bar" style="flex-wrap:wrap;gap:6px;margin-top:4px">' + buttons.join('') + '</div>';
}

/* F12-09「多次失败停止自动重试」（§12）。判词在**服务端**算好随运行下发
   （retryBudget，阈值来自 domain 的 MAX_AUTO_RETRIES）—— 页面不自己数、也不写一个
   数字。没到阈值时**不画**：一个「还没到上限」的提示只会是噪音。
   ⚠️ 它不改任何状态：本插件不驱动 Agent，这句话的含义是「别再等它自己好了」。 */
function retryBudgetBlock(detail) {
  const budget = detail.retryBudget;
  if (budget === null || budget === undefined || budget.exhausted !== true) return '';
  return '<div class="hint" style="color:var(--warn)"><strong>⚠️ 已失败 ' + budget.failedSteps
    + ' 步（阈值 ' + budget.limit + '）</strong>：按 §12 不再指望自动重试，请人工决定 —— '
    + '改参数重跑、缩小范围、还是放弃这次运行。'
    + '（本插件不驱动 Agent：它不会自动重试任何一步，这一行是给人看的判词。）</div>';
}

function snapshotBlock(detail) {
  return '<div class="hint">对象范围：站点 ' + escapeHtml((detail.scope.marketplaces || ['（不限）']).join('/'))
    + ' · 产品线 ' + escapeHtml((detail.scope.productLines || ['（不限）']).join('/'))
    + ' · ASIN ' + escapeHtml(String((detail.scope.asins || []).length)) + ' 个<br>'
    + '数据快照：' + escapeHtml(detail.dataSnapshot?.importBatchId || '（还没有导入批次）')
    + ' · kw_master ' + escapeHtml(String(detail.dataSnapshot?.kwMasterRows ?? 0)) + ' 行'
    + ' · 规则 ' + escapeHtml(String(detail.rulesSnapshot?.version ?? '—'))
    + '（' + escapeHtml(String(detail.rulesSnapshot?.count ?? 0)) + ' 条）'
    + ' · Prompt ' + escapeHtml(String(detail.promptsSnapshot?.count ?? 0)) + ' 个集合'
    /* F12-02 的第五样：角色配置的版本。画出来是因为它**真的被冻结**了 —— 一句「这几样
       都是拷贝的」如果不把角色配置列进去，读者就无从知道运行读的是哪一版角色定义。
       数量词故意不写死（原来是「这四样」）：本批之后是五样，F12-03 还会再加。 */
    + ' · 角色配置 ' + escapeHtml(detail.roleConfigVersion === null || detail.roleConfigVersion === undefined
      ? '（没有配置版本）' : 'v' + String(detail.roleConfigVersion))
    /* F12-03 的两样。⚠️ 「没给」与「给了个空的」分开说：库里只有 null（没给）——
       空串在写入时就被拒了（见 store/agent.js 的 optionalText），所以这里不会有「他给了空串」
       这一种，只有「没给」。（本注释里没有反引号 —— 它活在页面那个大模板字面量里。） */
    + ' · 人工约束 ' + escapeHtml(detail.humanConstraint || '（没给）')
    + ' · 输出格式 ' + escapeHtml(detail.outputFormat || '（没约定）')
    /* F12-09：取代关系。**不是**上下文包的一部分（它不在 startRun 写，是开运行时的
       一个入参），所以它排在「这些是开始时拷贝的」那句**之外** —— 混进去会让「拷贝了
       七样」多出一样并不属于它的东西。 */
    + (detail.supersedesRunId === null || detail.supersedesRunId === undefined
      ? ''
      : '<br>取代: <code>' + escapeHtml(detail.supersedesRunId) + '</code>'
        + '（§12：上下文变化时**新建**运行、不改旧的 —— 旧运行一个字节都没动）')
    + '<br>'
    + '<strong>这些是开始时拷贝的</strong>：运行中升级规则 / Prompt / 角色配置都不改变它们。</div>';
}

function stepBlock(detail) {
  if (detail.steps.length === 0) return '<div class="hint">这次运行还没有回报任何步骤。</div>';
  /* F12-06：§9 的任务画布逐字要「每步负责 Agent」与「工具调用」两栏。
     ⚠️ 两栏为 null 时画「（没记）」，**不拿运行的角色填上** —— 一次运行在将来可以是
     多角色的，而「这一步是运行的角色做的」在本版是对的、在那一刻就变成编的。
     给缺失造一个像数据的替身，比留一个洞更危险。
     F12-09：「可重试」是三态 —— null（没记，这一步没失败过，所以这个问题还没出现）
     画破折号，false 画「不可重试」——**两者不是一件事**，折成一个会让「没失败过」与
     「失败过且不可重试」长得一样。 */
  return '<table><thead><tr><th>#</th><th>步骤</th><th>负责 Agent</th><th>工具调用</th>'
    + '<th>状态</th><th>可重试</th><th>错误</th><th>耗时</th></tr></thead><tbody>'
    + detail.steps.map(step => '<tr>'
      + '<td>' + step.seq + '</td>'
      + '<td>' + agentStepName(step.step) + '</td>'
      + '<td>' + (step.agentRole === null || step.agentRole === undefined
        ? '<span class="opt-meta">（没记）</span>' : agentRoleName(step.agentRole)) + '</td>'
      + '<td>' + (step.toolName === null || step.toolName === undefined
        ? '<span class="opt-meta">（没记）</span>' : escapeHtml(step.toolName)) + '</td>'
      + '<td>' + agentStatusChip(step.status, 'stepStatus') + '</td>'
      + '<td>' + (step.retryable === null || step.retryable === undefined
        ? '<span class="opt-meta">—</span>'
        : (step.retryable
          ? '<span class="chip ok">可重试</span>'
          : '<span class="chip stop">不可重试</span>')) + '</td>'
      + '<td>' + escapeHtml(step.error || '') + '</td>'
      + '<td>' + escapeHtml(elapsed(step.startedAt, step.finishedAt)) + '</td>'
      + '</tr>').join('') + '</tbody></table>';
}

/* F12-05：运行详情里的「下一步」一行。
   判词由**服务端**算好随运行下发（domain/agent/orchestration.js 的 planNextStep），
   页面只画不重算 —— 与 §14 指标同一条单源规矩。

   ⚠️ 「还没有步骤记录」不得渲染成「已完成」：recorded 为空时 planNextStep 的 verdict
   是 ok（first step pending），不是 done —— done 要求契约每一条都 passed。这里对
   verdict 逐一给话，缺一个分支都会把「没做」画成「做完了」。 */
const AGENT_VERDICT_LABEL = {
  ok: '下一步',
  done: '已完成',
  'out-of-contract': '⚠️ 契约外步骤',
  'out-of-order': '⚠️ 顺序不对',
  'review-exhausted': '⚠️ 审阅已达上限',
};

function nextStepBlock(detail) {
  const plan = detail.orchestration;
  if (!plan) return '';
  const label = AGENT_VERDICT_LABEL[plan.verdict] === undefined ? plan.verdict : AGENT_VERDICT_LABEL[plan.verdict];
  const total = plan.expected.length;
  let body;
  if (plan.verdict === 'done') {
    body = '全部 ' + total + ' 条契约步骤已通过';
  } else if (plan.verdict === 'out-of-contract') {
    body = '契约外步骤：' + plan.outOfContract.map(item => agentStepName(item)).join('、')
      + '（契约允许：' + plan.expected.map(item => agentStepName(item)).join(' → ') + '）';
  } else if (plan.verdict === 'out-of-order') {
    body = '该先做的是 ' + (plan.next === null ? '（无）' : agentStepName(plan.next));
  } else if (plan.verdict === 'review-exhausted') {
    body = '审阅已达上限 ' + plan.reviewLimit + '，转人工';
  } else {
    body = (plan.next === null ? '（无）' : agentStepName(plan.next))
      + '（第 ' + (plan.done.length + 1) + '/' + total + ' 步）';
  }
  /* F12-05：编排模式。**只增不改** —— 上面那几支判词的文案一个字都不动。
     ⚠️ 页面**不重算** planNextStep（tests/f1205-orchestration.mjs 有一条守卫钉住这一点），
     模式与 reviewCount 都用服务端算好的 plan。标签表由服务端下发
     （state.agent.planModeLabels，源头是 domain/agent/orchestration.js），页面不写第二份。 */
  const modeLabels = (state.agent || {}).planModeLabels || {};
  const modeText = modeLabels[plan.mode] === undefined ? String(plan.mode) : modeLabels[plan.mode];
  const modeNote = '<span class="hint" style="margin-left:8px">编排模式: ' + escapeHtml(modeText)
    + (plan.mode === 'review-loop' ? '（同一步骤已被重复 ' + plan.reviewCount + ' 次）' : '') + '</span>';
  return '<div class="hint"><strong>' + label + '：</strong>' + body + modeNote + '</div>';
}

const AGENT_STEP_CHIPS = { pending: 'queued', running: 'running', passed: 'done', failed: 'failed', skipped: 'cancelled' };

function elapsed(from, to) {
  if (!from || !to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? ms + 'ms' : Math.round(ms / 1000) + 's';
}

/* F12-03 的补充数据请求。**三种「没有」分开画**，因为它们是三件要做的下一件事不同的事：
   ① 这一格没下发（老 state / 没选运行）；② 这次运行没有请求（全库有，都在别的运行上）；
   ③ 全库一条都没有。折成一句「没有请求」就是把「缺失」渲染成「真实值」——
   本仓最贵的那类缺陷。 */
function requestBlock(dataRequests) {
  const head = '<div class="rule-sect">补充数据请求（本插件**不补数据** —— 这是给会话 / 人看的记录）</div>'
    /* 口径 note（ui-terms-review §3 铁律，需求方点名）：凡印 requestStatus 的地方
       同屏配这句 —— 缺口没关上时结论只能「无法判断」，「没取到」不许读成「没有」。
       词表只管词（rules.js 的 UI_TERMS），这句是显示层的义务。 */
    + '<div class="hint" style="padding:0">口径：缺口未补时，相关结论只能「无法判断」—— 没取到 ≠ 没有。'
    + '「待补（仍缺）」与「不补（仍缺）」都是缺口仍在（没到 / 不给），只有「已补」才关缺口。</div>';
  if (dataRequests === null || dataRequests === undefined) {
    return head + '<div class="hint">没有下发这一格（老 state，或还没选运行）—— '
      + '这与「这次运行没有请求」不是一件事。</div>';
  }
  const rows = dataRequests.rows || [];
  const total = dataRequests.total;
  if (rows.length === 0) {
    const why = (typeof total === 'number' && total === 0)
      ? '全库还没有任何补充数据请求（0 条）。'
      : '这次运行没有请求；全库共 ' + escapeHtml(String(total)) + ' 条，都在别的运行上。';
    return head + '<div class="hint">' + why + '</div>';
  }
  return head
    + '<table><thead><tr><th>要什么</th><th>为什么</th><th>状态</th><th>怎么结的</th><th>开于</th></tr></thead><tbody>'
    + rows.map(row => '<tr>'
      + '<td>' + escapeHtml(row.what) + '</td>'
      + '<td>' + escapeHtml(row.why || '—') + '</td>'
      + '<td><span title="status=' + escapeHtml(String(row.status)) + '">'
      + escapeHtml(uiTerm('requestStatus', row.status)) + '</span></td>'
      + '<td>' + escapeHtml(row.resolution || '—') + '</td>'
      + '<td>' + escapeHtml(shortTime(row.openedAt)) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>';
}

/* F12-10 的「页面→会话」半边（B-12.10 / D4）。
   ⚠️ 本 harness 里**没有**页面→会话的载荷通道：唯一深链是一个自定义桌面协议链接
   （只把窗口提到前台，精确匹配，不解析载荷、不注入会话）；插件页是系统浏览器标签页，页内没有
   postMessage / window.parent 桥。所以**做不了真跳转** —— 任何「点一下就回到会话」的
   链接都是假的。这里复用本仓既定的「回传」先例 usePrompt（往 promptBox 塞一段 prompt
   并复制，由**人**粘贴进对话），文案因此**不暗示跳转**，它是「复制这段去问 agent」。
   （本注释刻意不写出那个协议串：它在这个大模板字面量里，会被原样发到页面 —— 而页面
   不许出现它。断言②正是查这个。） */
function runCopyBlock(detail) {
  const prompt = '这次运行 id 是 ' + detail.id + '，用 amzn_agent_run_list 可以取回它。';
  /* ⚠️ 标题原来写「把这次运行**带回**会话」—— 那擦边了本批自己的规矩（文案不得暗示跳转）：
     断言禁的是「跳转 / 回到会话」两个字面，而「带回会话」恰好躲过。改成不自称跳转的写法。
     ⚠️ 措辞也是**校准过的**：本插件页没有桥、插件也没有面向那条通道的 API，所以这里只能
     复制一段话；**但不能说「本 harness 没有这条通道」** —— 验收者查出 harness 自己有一条
     同源的会话 prompt 通道（sessionController.prompt / remote.mux），只是本插件没接、
     也没端到端验证过。把「我没接」写成「世上没有」是假说法。 */
  return '<div class="rule-sect">复制这次运行 id 去问 agent</div>'
    + '<div class="hint">本插件页**没有**通到会话的桥，插件也没有面向那条通道的 API，'
    + '所以这里给的是「复制一段话去问 agent」，不是一个会跳转的链接。'
    + '（harness 另有一条同源的会话 prompt 通道，但本插件没接它，也未端到端验证过。）</div>'
    + '<button type="button" class="btn btn--ghost btn--sm" data-copyrun="' + escapeHtml(detail.id) + '"'
    + ' data-prompt="' + escapeHtml(prompt) + '">'
    + '复制：这次运行 id 是 ' + escapeHtml(detail.id) + '</button>';
}

/* F12-07 的「输入快照」（B-12.10 / D3）。agent_artifact **没有** input 列 —— 产物靠
   step_seq 指到那一步的 input_json（已由 getRun 水合成 detail.steps[].input），所以
   这里走**只读路径**：按 stepSeq 去 detail.steps 里找那一步，渲染它的 input。
   **四种「没有」分开说**（本仓的 null-vs-empty 规矩；前三种是契约点名的三态）：
     ① stepSeq 为 null → 「没有关联步骤」（不是「输入为空」）；
     ② 有关联步骤但该步 input 为 null → 「这一步没有记输入」；
     ③ 关联的 stepSeq 在 detail.steps 里找不到那一步 → 单独说，不与 ①② 混；
     ④ input 存在 → 折叠渲染（产物 body 与 step input 都可能是大对象，不铺进单元格）。 */
function inputSnapshotCell(artifact, detail) {
  const seq = artifact.stepSeq;
  if (seq === null || seq === undefined) {
    return '<span class="opt-meta">没有关联步骤</span>';
  }
  const step = (detail.steps || []).filter(entry => entry.seq === seq)[0];
  if (step === undefined) {
    return '<span class="opt-meta">关联的步骤不在这次运行的记录里</span>';
  }
  if (step.input === null || step.input === undefined) {
    return '<span class="opt-meta">这一步没有记输入</span>';
  }
  return '<details><summary>' + escapeHtml(inputDigest(step.input)) + '</summary>'
    + '<pre style="white-space:pre-wrap;margin:4px 0 0;max-width:320px">'
    + escapeHtml(inputText(step.input)) + '</pre></details>';
}

/* 一行摘要：对象给键名（最多四个 + 省略号），数组给项数，标量给截断后的值。 */
function inputDigest(value) {
  if (Array.isArray(value)) return '输入：[' + value.length + ' 项]';
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    return '输入：{' + keys.slice(0, 4).join(', ') + (keys.length > 4 ? ', …' : '') + '}';
  }
  /* ⚠️ 空字符串必须**看得出来是空字符串**：把「输入：」接一个空串再拼上去，渲染出来就是
     「输入：」，读起来像「缺失」—— 而这个值是**存在的**（有，且为空）。那是本仓
     「缺失 vs 空」规矩的反向犯规（把「有，且为空」渲染成「没有」），所以它显式写出来。 */
  if (value === '') return '输入：""（空字符串）';
  const text = String(value);
  return '输入：' + (text.length > 48 ? text.slice(0, 48) + '…' : text);
}

/* 折叠区里的正文：缩进 JSON。input 来自 JSON.parse，所以 stringify 一定成功。 */
function inputText(value) {
  return JSON.stringify(value, null, 2);
}

/* F12-07 —— 产物的**独立列表视图**（跨运行）。在此之前产物表只画在选中运行的详情块里，
   所以「这些东西都去哪了」在页面上没有读者。

   空态必须**三态**，因为三种零的下一步完全不同（契约 §0.3）：
     A 一次运行都没跑过（runTotal === 0）→ 去会话里跑一次；
     B 跑过但一条产物都没有（runTotal > 0 且 total === 0）→ **Agent 侧没产东西**，
       这与 A 不是一件事：运行是跑过的，缺的是产出；
     C 筛没了（total > 0 而 rows 为空）→ 放宽筛选，并说出「库内共 N 条」。
   ⚠️ 把 A 与 B 合成一句是这一批最容易犯的错，也是本函数里最要紧的一处 —— 真库是
   agent_run = 0，所以这是这条功能唯一会被真人看到的分支。 */
function renderAgentArtifacts(data) {
  const slice = data.artifacts || null;
  const box = $('agartifacts');
  if (box === null) return;
  if (slice === null) { box.innerHTML = ''; return; }

  /* 回填控件（照 renderReports）：值来自**服务端实际采用**的 filters，所以控件不会
     声称一个 payload 忽略了的筛选。类型下拉每次都重建 —— 选项由服务端下发的约定类型
     清单 + 当前筛选值合成，页面不自己写一份类型名。 */
  const typeSelect = $('agArtType');
  if (typeSelect !== null) {
    const conventions = (data.artifactTypes && data.artifactTypes.types) || [];
    const current = slice.filters.type || '';
    const options = [''].concat(conventions.map(entry => entry.type));
    /* 当前筛选值不在约定清单里也要画出来（type 是一列自由字符串，不是闭集）；
       丢掉它会让控件显示「全部类型」而列表其实被筛过了。 */
    if (current !== '' && options.indexOf(current) < 0) options.push(current);
    typeSelect.innerHTML = options.map(value => {
      const entry = conventions.filter(item => item.type === value)[0];
      const label = value === '' ? '全部类型' : (entry ? entry.label : value);
      return '<option value="' + escapeHtml(value) + '"'
        + (value === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');
  }
  /* ⚠️ 标签表提到 if **外面**：状态列与人工裁决列都要用它，而它们不在这个 if 里。
     曾经把它声明在 if 内，于是那两个格子报 labels is not defined —— 页面整块渲染抛错，
     全量报 11 条红。node --check 看不出来（那是运行时 ReferenceError），
     只有真渲染的测试能抓到。 */
  const labels = data.artifactStatusLabels || {};
  const statusSelect = $('agArtStatus');
  if (statusSelect !== null) {
    /* ⚠️ 选项**每次重建**，标签来自服务端下发的 artifactStatusLabels（单一来源在
       domain/agent/roles.js）。页面此前在这里硬编码了四个中文 —— 那是「一句话活在两个
       文件里」，而且它已经漂了：状态列走的是另一条死映射，四个状态里三个显示英文。
       值 = 词表的 id，文字 = 标签；没有标签的 id 原样显示 id（宁可露出英文，也不猜）。
       「全部状态」是控件自己的出口，值为空串 —— 与 agArtType 的「全部类型」对称。 */
    const ids = (data.artifactStatusIds || []);
    statusSelect.innerHTML = ['<option value="">全部状态</option>']
      .concat(ids.map(id => '<option value="' + escapeHtml(id) + '">'
        + escapeHtml(labels[id] === undefined ? id : labels[id]) + '</option>'))
      .join('');
    statusSelect.value = slice.filters.status || '';
  }

  const filtered = slice.rows.length !== slice.total;
  const runTotal = Number(data.runTotal || 0);

  if (slice.rows.length === 0) {
    /* 三句话，逐态一句。⚠️ 判据是 runTotal（agent_run 的总数）与 slice.total
       （agent_artifact 的总数，**不带 where**）—— 不是 rows.length。
       三种零的 kind 不同：A 还没跑过 / B 跑过但没产出 / C 筛没了。 */
    if (slice.total > 0) {
      /* C 筛没了。 */
      box.innerHTML = emptyState('filtered', {
        subject: '产物',
        reason: '这个筛选条件下没有产物。放宽条件再试 —— 不要把它读成「库里没有产物」：库内共 '
          + slice.total + ' 条。',
      });
    } else if (runTotal > 0) {
      /* B 跑过但没有产物。 */
      box.innerHTML = emptyState('none', {
        subject: '产物',
        reason: '跑过 ' + runTotal + ' 次运行，但这 ' + runTotal + ' 次没有产出任何产物。'
          + '这与「一次都没跑过」不是一回事：运行是跑过的，缺的是产出 —— '
          + 'Agent 侧没有调 amzn_agent_artifact_save。',
      });
    } else {
      /* A 一次运行都没跑过。⚠️ 这句话必须自己说出「一次都没跑过」—— 光说「还没有产物」
         会让 A 与 B 读成同一件事（B 是跑过、但没产出）。 */
      box.innerHTML = emptyState('not-recorded', {
        subject: '产物',
        reason: '还没有跑过任何一次运行，所以也没有产物。',
        next: '在对话里说「用 amzn_agent_run_start 开一次运行」，产物才会出现在这里。',
      });
    }
    return;
  }

  /* 裁决记录按**被裁决产物的 id** 索引 —— 与运行详情块同一份推导（裁决是追加式的，
     所以一条草案最多被裁决一次）。 */
  const decisions = {};
  for (const entry of slice.rows) {
    if (entry.type === 'artifact-decision' && entry.objectId) decisions[entry.objectId] = entry;
  }

  box.innerHTML = '<table><thead><tr><th>时间</th><th>类型</th><th>对象</th><th>版本</th>'
    + '<th>状态</th><th>运行</th><th>输入快照</th><th>人工裁决</th></tr></thead><tbody>'
    + slice.rows.map(artifact => '<tr>'
      + '<td>' + escapeHtml(shortTime(artifact.createdAt)) + '</td>'
      + '<td>' + escapeHtml(artifact.type) + '</td>'
      + '<td>' + escapeHtml(artifact.objectType || '—')
        + (artifact.objectId ? ' · ' + escapeHtml(String(artifact.objectId)) : '') + '</td>'
      + '<td>v' + artifact.version + (artifact.parentId ? ' <span class="opt-meta">接前版</span>' : '') + '</td>'
      + '<td>' + artifactStatusCell(artifact, TASK_STATUS_ARTIFACT, data.artifactStatusLabels) + '</td>'
      + '<td>' + artifactRunCell(artifact) + '</td>'
      + '<td>' + artifactInputCell(artifact) + '</td>'
      + '<td>' + artifactDecideCell(artifact, decisions, labels) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>'
    + '<div class="hint">显示 ' + slice.rows.length + ' / ' + slice.total + ' 条'
    + (filtered ? '（已筛选）' : '')
    + ' · 产物跨运行列出；「运行」那一格是它属于哪一次运行 —— 复制那个 id 去会话里问。</div>';
}

/* 跨运行列表里那一行的「运行」入口（D4）。**不是一个跳转** —— 本插件页没有通到会话的
   桥，所以给的是**完整 run id**（可选中、可复制），与运行详情块的「复制去问 agent」
   同一条路子。⚠️ 措辞不许暗示跳转或回到会话（那是本仓校准过三次的反模式，而且这一页的
   渲染产物被「不出现假深链」那条断言整份扫过）。
   ⚠️ 这个函数名同样**不许**出现在页面里（本仓有一个守卫会把它读成「页面深链」）。 */
function artifactRunCell(artifact) {
  const id = artifact.runId;
  if (!id) return '<span class="opt-meta">—</span>';
  return '<code title="' + escapeHtml(id) + '">' + escapeHtml(id) + '</code>';
}

/* 产物行的「输入快照」。跨运行列表**不带 steps**，所以它没有资格下详情块那种结论 ——
   详情块手里有 detail.steps，能真的分辨「这一步在不在记录里」（inputSnapshotCell，上面
   四态）。这里只有产物行，listAllArtifacts 只查 agent_artifact，**没有**那一步的
   input_json。所以本函数**只说实话**：说清 stepSeq 指到哪一步，并指出正文在别处
   （打开这次运行才看得到），**不声称那一步存在**。

   ⚠️ 三种「没有」必须两两不同 —— 读者据此决定下一步动作，三者不同：
     · stepSeq 为 null → 这条产物**没有关联步骤**（也没有输入可指），是产物自己的形状问题；
     · stepSeq 有值 → 它**指到**第 N 步，但正文不在这里，得打开那次运行；
   ⚠️ 关键约束（B-12.12 验收查出）：**不许把「指到第 N 步」写成「第 N 步存在」**。
   saveArtifact **不校验** stepSeq 指向真实步骤（工具只暴露 stepSeq: {type:'number'}），
   所以库里可以有**悬空** step_seq。旧写法「第 9 步的输入（打开这次运行看正文）」对悬空的
   第 9 步与真实存在的第 1 步说**同一句话**，等于**替库里断言「第 9 步存在」** —— 那是本仓
   最贵的那类错（把缺失渲染成真实值 + 文案替库断言）。详情块能分辨是因为它查得到 steps；
   列表查不到，就不能替库说那句话。 */
function artifactInputCell(artifact) {
  const seq = artifact.stepSeq;
  if (seq === null || seq === undefined) {
    return '<span class="opt-meta">这条产物没有关联步骤</span>';
  }
  /* 只陈述「指到第 N 步」与「正文在别处」两个事实，不对「那一步在不在记录里」表态。
     措辞刻意用「指到」而不是「是」：指到 ≠ 存在。 */
  return '<span class="opt-meta">这条产物指到第 ' + escapeHtml(String(seq))
    + ' 步；那一步的输入正文要打开这次运行才看得到（列表本身没有步骤记录，'
    + '无法判断这一步在不在）</span>';
}

/* 人工裁决那一格。与运行详情块里的画法同形，但**处置入口只留在运行详情块**：
   独立列表是一个**读**视图（契约 §5-7：不加第二条写路径）。在这里画按钮会给
   「页面与会话对同一条草案只能有一个答案」多开一个入口，所以这里只画状态与署名。 */
function artifactDecideCell(artifact, decisions, labels) {
  if (artifact.type === 'artifact-decision') return '<span class="opt-meta">（裁决记录本身）</span>';
  if (artifact.status === 'draft') return '<span class="opt-meta">待裁决（在运行详情里处置）</span>';
  const decision = decisions[artifact.id];
  if (decision === undefined) return '<span class="opt-meta">—</span>';
  const body = decision.body || {};
  /* ⚠️ 文字取**服务端下发**的那份（artifactStatusLabels），不在这里再写一遍。
     B-12.12 只改了「状态」列，把这一格留成了硬编码 —— 于是同一个中文名又活了两个地方
     （状态列说「已接受」，这里也写「已接受」，改一处就漂一处）。**同一批的漏网。** */
  const word = (labels || {})[artifact.status];
  return '<span class="chip ' + (artifact.status === 'accepted' ? 'ok' : 'stop') + '">'
    + escapeHtml(word === undefined ? String(artifact.status) : word) + '</span>'
    + '<br><span class="opt-meta">' + escapeHtml(String(body.by || '（没有署名）')) + ' · '
    + escapeHtml(shortTime(decision.createdAt))
    + (body.note ? ' · ' + escapeHtml(String(body.note)) : '') + (body.amended === true ? ' · 改后接受（取代 v' + escapeHtml(String(body.amendedFromVersion)) + '）' : '') + '</span>';
}

function artifactBlock(detail, artifactTypes, artifactStatusLabels) {
  /* F12-03：先画「被命名的约定产物类型」这一行。**有名字 ≠ 会产出** —— 所以每个名字都要
     说清这次有没有、以及「没有」是插件**不强制**（不是漏了、也不是工具坏了）。
     清单由服务端下发（页面**不写第二份类型名**：一句事实活在两个文件里就会漂）。 */
  const conventions = (artifactTypes && artifactTypes.types) || [];
  const conventionsLine = conventions.length === 0
    ? ''
    : '<div class="hint">约定产物类型（本插件**命名**的那一小把，不是闭集）：'
      + conventions.map(entry => {
        const found = detail.artifacts.filter(artifact => artifact.type === entry.type);
        return escapeHtml(entry.label) + '：'
          + (found.length > 0 ? '有 ' + found.length + ' 份' : '没有（插件不强制产出）');
      }).join(' · ') + '</div>';
  if (detail.artifacts.length === 0) {
    return conventionsLine + '<div class="hint">还没有产物。产物不是聊天气泡，是版本化对象。</div>';
  }
  /* 裁决记录按**被裁决产物的 id** 索引：artifact-decision 产物的 objectId 就是那条草案
     的 id，正文里有谁 / 为什么 / 何时。裁决是追加式的，所以一条草案最多被裁决一次。 */
  const decisions = {};
  for (const entry of detail.artifacts) {
    if (entry.type === 'artifact-decision' && entry.objectId) decisions[entry.objectId] = entry;
  }
  const decideCell = artifact => {
    if (artifact.type === 'artifact-decision') return '<span class="opt-meta">（裁决记录本身）</span>';
    if (artifact.status === 'draft') {
      /* 三个按钮 = §11 的草案级三选。⚠️「改后接受」用**独立的属性名**
         「data-artifactamend」，绝不复用「data-artifactdecide」—— 复用会让现有的点击
         处理器把它当成一次普通接受，而「data-accept」缺失会被判成 false，
         于是「改后接受」会**静默变成一次驳回**。 */
      return '<button class="btn btn--ghost btn--sm" data-artifactdecide="' + escapeHtml(artifact.id) + '" data-accept="1">接受</button>'
        + '<button class="btn btn--ghost btn--sm" data-artifactamend="' + escapeHtml(artifact.id) + '">改后接受</button>'
        + '<button class="btn btn--ghost btn--sm" data-artifactdecide="' + escapeHtml(artifact.id) + '" data-accept="0">驳回</button>';
    }
    const decision = decisions[artifact.id];
    if (decision === undefined) return '<span class="opt-meta">—</span>';
    const body = decision.body || {};
    const word = (artifactStatusLabels || {})[artifact.status];
    return '<span class="chip ' + (artifact.status === 'accepted' ? 'ok' : 'stop') + '">'
      + escapeHtml(word === undefined ? String(artifact.status) : word) + '</span>'
      + '<br><span class="opt-meta">' + escapeHtml(String(body.by || '（没有署名）')) + ' · '
      + escapeHtml(shortTime(decision.createdAt))
      + (body.note ? ' · ' + escapeHtml(String(body.note)) : '') + (body.amended === true ? ' · 改后接受（取代 v' + escapeHtml(String(body.amendedFromVersion)) + '）' : '') + '</span>';
  };
  return conventionsLine
    + '<div class="rule-sect">产物（v 号是版本；旧版本标 已取代，仍然解析得出来）</div>'
    + '<table><thead><tr><th>类型</th><th>对象</th><th>版本</th><th>状态</th><th>步</th><th>输入快照</th><th>人工裁决</th></tr></thead><tbody>'
    + detail.artifacts.map(artifact => '<tr>'
      + '<td>' + escapeHtml(artifact.type) + '</td>'
      + '<td>' + escapeHtml(artifact.objectType || '—')
        + (artifact.objectId ? ' · ' + escapeHtml(String(artifact.objectId)) : '') + '</td>'
      + '<td>v' + artifact.version + (artifact.parentId ? ' <span class="opt-meta">接前版</span>' : '') + '</td>'
      + '<td>' + artifactStatusCell(artifact, TASK_STATUS_ARTIFACT, artifactStatusLabels) + '</td>'
      + '<td>' + (artifact.stepSeq === null || artifact.stepSeq === undefined ? '—' : artifact.stepSeq) + '</td>'
      + '<td>' + inputSnapshotCell(artifact, detail) + '</td>'
      + '<td>' + decideCell(artifact) + '</td>'
      + '</tr>').join('') + '</tbody></table>';
}

/* 产物状态 → chip 的**颜色类**。文字不在这里 —— 中文标签由服务端下发
   （artifactStatusLabels，源头 domain/agent/roles.js），页面只决定哪个状态配哪种色。
   这与 AGENT_RUN_CHIPS / AGENT_STEP_CHIPS 同款分工：值（文字）不重写，只投影颜色。
   ⚠️ 曾经的写法是一个 statusChip 调用，里面的三元两个分支**逐字相同**
   （TASK_STATUS_ARTIFACT[x] === undefined ? x : x），于是这张表一次都没被查过，
   accepted / rejected / superseded 原样印成英文（draft 只是碰巧撞上采集任务的 draft
   才显示成中文）。那份「死映射」的语义其实是**颜色**，被错写成了文字映射。 */
const TASK_STATUS_ARTIFACT = { draft: 'queued', accepted: 'done', rejected: 'failed', superseded: 'cancelled' };

/* 产物状态那一格：文字取**下发的中文标签**，颜色取上面那张表的 chip 类。
   ⚠️ 单源：标签只活在一处（artifactStatusLabels）。独立列表与运行详情块**共用**这一个
   函数 —— 同一份数据在两处必须显示同一个词，此前两处各写一份、且都走了那条死三元，
   于是同一行产物在列表里和在详情里都印英文。 */
function artifactStatusCell(artifact, chipClasses, labels) {
  const table = labels || {};
  const text = table[artifact.status] === undefined ? String(artifact.status) : table[artifact.status];
  const cls = (chipClasses || {})[artifact.status];
  return '<span class="chip ' + (cls === undefined ? '' : cls) + '">' + escapeHtml(text) + '</span>';
}

function gateBlock(detail) {
  if (!Array.isArray(detail.gates) || detail.gates.length === 0) return '';
  const decisions = detail.artifacts.filter(artifact => artifact.type === 'gate-decision');
  const rows = detail.gates.map(gate => {
    const decided = decisions.filter(entry => entry.objectId === gate.id)[0];
    return '<tr>'
      + '<td>' + escapeHtml(gate.label) + '<br><span class="opt-meta">' + escapeHtml(gate.id) + '</span></td>'
      + '<td>' + (decided === undefined
        ? '<span class="chip warn">未裁决</span>'
        : '<span class="chip ' + (decided.status === 'accepted' ? 'ok' : 'stop') + '">'
          + (decided.status === 'accepted' ? '已批准' : '已驳回') + '</span>'
          + '<br><span class="opt-meta">' + escapeHtml(String(decided.body?.note || '（没有理由）')) + '</span>') + '</td>'
      + '<td><button data-gate="' + escapeHtml(gate.id) + '" data-gaterun="' + escapeHtml(detail.id)
        + '" data-approve="1">批准</button>'
      + '<button data-gate="' + escapeHtml(gate.id) + '" data-gaterun="' + escapeHtml(detail.id)
        + '" data-approve="0">驳回</button></td>'
      + '</tr>';
  }).join('');
  return '<div class="rule-sect">人工门禁（本版只有这两个；其余只读分析免审批）</div>'
    + '<table><thead><tr><th>门禁</th><th>裁决</th><th>改</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

/* §14 指标。页面**不拥有**这份清单：哪几项算得出来、算不出来的缺哪份记录，全部由
   服务端 domain/agent/metrics.js 给出（与 B-12.1 的 pendingReason 同一条单源规矩 ——
   一句事实只活在一处，页面不自己算百分比、不自己列指标）。
   这里只做两件事：把算得出来的数字连**分母**一起画出来（一个没有分母的百分比在样本
   只有一两次时会撒谎），把算不出来的逐条点名「缺的那份记录」。分母为 0 时服务端给的
   display 是一句「还没有可计算的数字」，页面**不补** 0 / 0% —— 那正是把缺失画成真实值。 */
function metricsBlock(metrics) {
  if (!metrics) return '';
  const computed = metrics.computed || [];
  const unavailable = metrics.unavailable || [];
  const cards = computed.map(metric => '<div class="card">'
    + '<div class="cardhead">' + escapeHtml(metric.label)
    + ' <span class="opt-meta">' + escapeHtml(metric.id) + '</span></div>'
    + '<div class="cardbody">' + escapeHtml(metric.display) + '</div>'
    /* 分母只在真有数可算时才画：分母 0 时画 0 / 0 会让读者以为算过。 */
    + (metric.value === null ? ''
      : '<div class="opt-meta">' + escapeHtml(String(metric.numerator)) + ' / '
        + escapeHtml(String(metric.denominator)) + '</div>')
    + '<div class="opt-meta">' + escapeHtml(metric.note) + '</div></div>').join('');
  const missing = unavailable.map(metric => '<tr>'
    + '<td>' + escapeHtml(metric.label) + '<br><span class="opt-meta">' + escapeHtml(metric.id) + '</span></td>'
    + '<td>' + escapeHtml(metric.why) + '<br><span class="opt-meta">缺：' + escapeHtml(metric.missing) + '</span></td>'
    + '</tr>').join('');
  return '<div class="rule-sect">指标（§14：算得出来 ' + computed.length + ' 项，缺记录 '
    + unavailable.length + ' 项）</div>'
    + '<div class="cards">' + cards + '</div>'
    + (unavailable.length === 0 ? ''
      : '<table><thead><tr><th>指标</th><th>缺哪份记录（不是「未实现」）</th></tr></thead><tbody>'
        + missing + '</tbody></table>');
}

/* §0 那九个「无数据来源」的要素。**页面只渲染，不自己数** —— 总述与条数都来自
   服务端下发的 gaps（domain/agent/gap.js），页面里再写一遍就是第二份会漂的副本。
   与 metricsBlock 同一条规矩：写「缺哪份记录」，不写「未实现」，也**不填任何数字** ——
   成本那两条是「没有这个来源」，把它画成 0 就是本仓最贵的那个缺陷形状。
   data.gaps 可能没下发（老 state）：那时画一句「没下发」，**不是**画空表让人以为没有缺失。 */
function gapsBlock(gaps) {
  if (!gaps) {
    return '<div class="rule-sect">缺失登记（F12-02 / F12-03 / F12-06 / F12-09）</div>'
      + '<div class="hint">服务端没有下发这一格 —— 与「没有缺失」不是一件事。</div>';
  }
  const elements = gaps.elements || [];
  const rows = elements.map(element => '<tr>'
    + '<td>' + escapeHtml(element.label) + '<br><span class="opt-meta">'
    + escapeHtml(element.id) + ' · ' + escapeHtml(element.requirement) + '</span></td>'
    + '<td>' + escapeHtml(element.missing) + '<br><span class="opt-meta">有来源的相邻事实：'
    + escapeHtml(element.source) + '</span></td>'
    + '</tr>').join('');
  return '<div class="rule-sect">缺失登记（' + escapeHtml(String(gaps.count)) + ' 项，'
    + '每一行是「缺哪份记录」，不是「值是多少」）</div>'
    + '<div class="hint">' + escapeHtml(gaps.summary) + '</div>'
    + '<table><thead><tr><th>要素</th><th>缺哪份记录（不是「未实现」）</th></tr></thead><tbody>'
    + rows + '</tbody></table>';
}

/* 门禁裁决走已有的 setting-set 之外的**新路由** agent-gate：它是一次真实的写入，
   所以在 PAGE_WRITE_TARGETS 里有描述符。批准之后运行会从 waiting_human 回到
   running —— 那是服务端判断的，页面只是发起。 */
async function decideGate(runId, gate, approve) {
  try {
    await api('agent-gate', { method: 'POST', body: JSON.stringify({ runId, gate, approve }) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* F12-06 / F12-09 的三个运行入口。**页面只发起**：判断全在服务端（agent-run 路由 →
   amzn_agent_run_finish 的同一个判断；agent-run-supersede 路由 → startRun 的同一个
   判断）。页面不在这里重写「这条运行能不能取消 / 能不能继续」。
 *
 * ⚠️ 「我已修复，继续」要一条理由（window.prompt 收，与 :1174 用 window.confirm
 * 同一条路子）。理由为空时**不发请求** —— 服务端也会拒（reason is required），而
 * 「发一次注定被拒的请求」会让用户以为点过了。用户按取消（null）也什么都不发。
 *
 * supersede 走另一条路由：它是**新建**一次运行，不是移动状态。 */
async function runAction(action, runId) {
  const route = action === 'supersede' ? 'agent-run-supersede' : 'agent-run';
  const body = action === 'supersede' ? { runId } : { runId, action };
  if (action === 'retry') {
    const ask = typeof window !== 'undefined' && typeof window.prompt === 'function'
      ? window.prompt('说明你修好了什么（§9 的「修复后重试」必须带一条理由）：') : null;
    if (ask === null) return;
    if (String(ask).trim() === '') {
      showPageError(new Error('没有填理由 —— 修复后重试必须说清修了什么，'
        + '否则它与「需要确认」是同一种话（§11）。'));
      return;
    }
    body.reason = String(ask);
  }
  try {
    await api(route, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* 草案产物的接受 / 驳回：**容器事件委托**，挂在 agrun 上（与总库大表的
   bindKeywordDetailClicks 同一模式 —— 每次重渲染只换 innerHTML，委托不会失效）。
   裁决走 agent-artifact 路由，服务端用**同一个** amzn_agent_artifact_decide 判断；
   页面只发起，不在这里重写「这条草案能不能裁决」。 */
function bindArtifactDecideClicks() {
  const container = $('agrun');
  if (!container) return;
  container.onclick = (event) => {
    const target = event ? event.target : null;
    /* 「改后接受」必须**先判**。它是独立的属性，不是 decide 的变体 ——
       先判 decide 会让这个按钮永远匹配不到，点击变成「什么都没发生」
       （一个看起来能点、实际没接线的按钮，比一块空白更糟）。 */
    const amend = target && typeof target.closest === 'function' ? target.closest('[data-artifactamend]') : null;
    if (amend && amend.dataset && amend.dataset.artifactamend) {
      openAmendEditor(amend.dataset.artifactamend);
      return;
    }
    const button = target && typeof target.closest === 'function' ? target.closest('[data-artifactdecide]') : null;
    if (!button || !button.dataset || !button.dataset.artifactdecide) return;
    decideArtifact(button.dataset.artifactdecide, button.dataset.accept === '1');
  };
}

/* 「修改后接受」的编辑区（F12-08 草案级三选的第三个）。
   ⚠️ 四件事必须做对，每一件都对应一条断言：
   1. **预填当前正文** —— 空着开始会让人以为要从零写一份，而不是改一份；
   2. **提交前就地 JSON.parse** —— 把坏 JSON 发给服务端，用户只会拿到一句看不懂的错；
   3. **没改动就不提交** —— 与库层 body === undefined 那条拒绝同一条规矩：
      没有改动就不叫「修改后接受」。页面是这条规矩的第二个入口，不能比库层松；
   4. **取消真的取消** —— 不发请求。 */
function openAmendEditor(artifactId) {
  const box = $('agamend');
  if (box === null) return;
  const detail = state.agent && state.agent.selected ? state.agent.selected : null;
  const artifact = detail === null || detail === undefined
    ? undefined
    : (detail.artifacts || []).find(entry => entry.id === artifactId);
  if (artifact === undefined) {
    box.innerHTML = '<div class="hint" style="color:var(--stop)">找不到这条产物（可能刚被别的动作取代）。'
      + '点「重新读取」后再试。</div>';
    return;
  }
  const current = artifact.body === undefined ? null : artifact.body;
  const nextVersion = Number(artifact.version) + 1;
  box.innerHTML = '<div class="rule-sect">改后接受：' + escapeHtml(String(artifact.type))
    + ' v' + escapeHtml(String(artifact.version)) + ' → 存成 v' + escapeHtml(String(nextVersion))
    + ' 并接受它，v' + escapeHtml(String(artifact.version)) + ' 标为已取代</div>'
    + '<textarea id="agamendBox" rows="10" style="width:100%;font-family:ui-monospace,Consolas,monospace;font-size:12px"></textarea>'
    + '<div class="bar"><span class="hint" id="agamendHint" style="padding:0">正文是 JSON。'
    + '「没有正文」写成 null，「正文被清空」也写成 null —— 两者在库里都是 NULL，'
    + '所以这里不假装能区分它们。</span>'
    + '<button id="agamendCancel">取消</button>'
    + '<button id="agamendSubmit">保存并接受</button></div>';
  const textarea = $('agamendBox');
  const hint = $('agamendHint');
  textarea.value = JSON.stringify(current, null, 2);
  $('agamendCancel').onclick = () => { box.innerHTML = ''; };
  $('agamendSubmit').onclick = async () => {
    let parsed;
    try {
      parsed = JSON.parse(textarea.value);
    } catch (error) {
      hint.textContent = '正文不是合法 JSON，没有提交：' + error.message;
      hint.style.color = 'var(--stop)';
      return;
    }
    if (JSON.stringify(parsed) === JSON.stringify(current)) {
      hint.textContent = '正文没有改动 —— 没有改动就不叫「修改后接受」。直接点「接受」即可。';
      hint.style.color = 'var(--stop)';
      return;
    }
    await amendArtifact(artifactId, parsed);
  };
}

async function amendArtifact(artifactId, body) {
  try {
    await api('agent-artifact', { method: 'POST', body: JSON.stringify({ artifactId, accept: true, body }) });
  } catch (error) {
    showPageError(error);
  } finally {
    const box = $('agamend');
    if (box !== null) box.innerHTML = '';
    await refresh();
  }
}

async function decideArtifact(artifactId, accept) {
  try {
    await api('agent-artifact', { method: 'POST', body: JSON.stringify({ artifactId, accept }) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* 首次设置向导（S1-B18）。
 *
 * 三步都画出来，做完的也画 —— 一个会随着你干活而变短的清单，分不清「做完了」和
 * 「消失了」。每步下面列出必填项（没过的标红并写明去哪改）和可稍后完善项。
 *
 * 判定全部来自服务端读库的结果（data.setup）：页面不做任何「这一步算不算过」的
 * 判断，也不存任何进度。少一项必填时，页面上给的是**缺哪一步的哪个字段**，
 * 不是一句「还没配好」—— 让用户猜是哪一项，最省事的猜法就是放弃这个向导。 */
function renderSetupWizard() {
  const setup = state.settings ? state.settings.setup : null;
  if ($('setwizard') === null) return;
  if (!setup) { $('setwizard').innerHTML = ''; return; }

  const badge = setup.ready
    ? '<span class="chip ok">' + escapeHtml(setup.state) + '</span>'
    : '<span class="chip warn">还差 ' + setup.missing.length + ' 项必填</span>';

  const stepper = setup.steps.map((step, index) => {
    const node = step.done ? '✓' : String(index + 1);
    const cls = step.done ? 'ok' : 'run';
    const required = step.required.map(field => '<span class="chip ' + (field.met ? 'ok' : 'stop') + '">'
      + escapeHtml(field.label) + (field.met ? '' : ' 未过') + '</span>'
      + (field.met || !field.detail ? '' : '<span class="opt-meta">' + escapeHtml(field.detail) + '</span>'))
      .join(' ');
    const optional = step.optional.map(field => '<span class="opt-meta">' + escapeHtml(field.label) + '</span>').join(' · ');
    return '<div class="gstep" data-setupstep="' + escapeHtml(step.id) + '">'
      + '<span class="chip ' + cls + '">' + node + '</span>'
      + '<span class="gname">' + escapeHtml(step.label) + '</span>'
      + '<span class="opt-meta">必填：</span>' + required
      + (optional === '' ? '' : '<br><span class="opt-meta">可稍后完善：' + optional + '</span>')
      + '</div>';
  }).join('');

  /* 缺什么，以及去哪补。where 是每条必填项自带的路线 —— 一条没有补法的必填项
     就是一个死胡同，而向导正是那个卡住人的东西。 */
  const todo = setup.ready
    ? '<div class="hint">三步的必填项都过了：<strong>可采集</strong>。标着「可稍后完善」的项随时在下面各块补，不影响采集。</div>'
    : '<div class="hint" style="color:var(--warn)">' + escapeHtml(setup.message) + '</div>'
      + '<ol class="setup-todo">' + setup.missing.map(field => '<li>'
        + '<strong>第 ' + (SETUP_STEP_IDS.indexOf(field.stepId) + 1) + ' 步 · '
        + escapeHtml(field.fieldLabel) + '</strong>'
        + (field.detail === null || field.detail === undefined ? '' : '（' + escapeHtml(field.detail) + '）')
        + '<br><span class="opt-meta">' + escapeHtml(field.where) + '</span>'
        + '</li>').join('') + '</ol>';

  $('setwizard').innerHTML = '<div class="card">'
    + '<div class="cardhead"><span>首次设置向导</span>' + badge + '</div>'
    + '<div class="stepper">' + stepper + '</div>'
    + '<div class="bar" style="border-top:1px solid var(--line)">' + todo + '</div>'
    + '</div>';
}

/* Which control a declared setting gets.
 *
 * There used to be a local table here mapping key to type, and it was wrong in
 * a way nothing could see: it drew every boolean as a text box, so
 * browser.headless sent the string "false", the store refused it, and the one
 * setting the page exists to change could not be changed from the page. The
 * type now comes from the server's own declaration (row.kind), so a new key
 * cannot be mis-drawn by forgetting to add it to a second table — there is no
 * second table.
 *
 * NB: no backticks in this comment — it sits inside the script string, and one
 * backtick ends the whole page. This cost us once already. */
const SETTING_CONTROLS = {
  number: row => '<input type="number" min="' + (row.min ?? 1) + '" data-setkey="' + escapeHtml(row.key) + '"'
    + ' value="' + escapeHtml(row.value === null || row.value === undefined ? '' : String(row.value)) + '">',
  bool: row => '<input type="checkbox" data-setbool="' + escapeHtml(row.key) + '"'
    + (row.value === true ? ' checked' : '') + '>',
  string: row => '<input type="text" data-setkey="' + escapeHtml(row.key) + '"'
    + ' value="' + escapeHtml(row.value === null || row.value === undefined ? '' : String(row.value)) + '">',
};

/* The settings surface.

   Drawn from data.settings, and the shape of that payload is what enforces the
   module's rule: rows are editable, facts are not, and sources carry field
   *names* only. Nothing here ever receives a secret, so nothing here can print
   one — the redaction is upstream, in redactSource, not a display convention
   this page has to remember. */
`;
