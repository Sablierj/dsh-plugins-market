/**
 * 页签「内容流水线」（`pipeline`）的客户端脚本片段。
 *
 * 它是从 `src/web/page.js` 里**原样切出来的**，不是重写：页面脚本是模板字符串、
 * 没有模块系统，所有片段最终仍拼回同一个 `<script>` 作用域，所以片段之间
 * 照旧可以互相按名字调用 —— 拆的是**文件**，不是作用域。
 *
 * 切分纪律（P1-1）：
 *   - 只搬不改。任何行为改动另开一批，否则出问题分不清是拆错了还是改错了。
 *   - 片段必须**逐字**保留原文本（含 \` 与 \${ 的转义），拼回去要能对上原来的哈希。
 *   - 顺序由 page.js 的拼装处决定，不由文件名决定。
 */
export const pipelineScript = `/* The pipeline's run log. Two tables, and the split is the point: the top one is
   the most recent run stage by stage — which is what "why is this CSV different
   from last week's" is answered with — and the bottom one is the history, so a
   run that failed is visible next to the ones that worked. A history that showed
   only the successes would read as "it has always worked".
   The counts are per stage, and the last stage's count is CSV rows rather than
   words, so it is labelled as such rather than left to look like a word count. */
/* ── 关键词数据源的根目录 ─────────────────────────────────────────────────
   结构是固定的：根目录下 brand-terms / search-terms / sellerjingling / xiyou
   四个子目录，目录名决定解析器（文件名不参与）。这一块只做三件事：
   显示现在读的是哪个目录、让人换一个、把缺失的空目录补上。

   扫描不放进 state 轮询：它要把 37 个文件读一遍算 hash。缓存一次，
   动作之后再取一次。 */
let kwSourceDir = null;
let kwSourceBusy = false;
let kwSourceError = '';

function sourceDirCounts(scan) {
  const parts = [];
  parts.push(scan.counts.files + ' 个文件');
  parts.push('未导入 ' + scan.counts.new);
  parts.push('已导入 ' + scan.counts.imported);
  if (scan.counts.unrecognized > 0) parts.push('未识别 ' + scan.counts.unrecognized);
  return parts.join(' · ');
}

function renderSourceDirCard() {
  const host = $('plsourcedir');
  if (!host) return;

  if (kwSourceDir === null) {
    host.innerHTML = '<div class="panel"><h2>数据源目录</h2>'
      + '<div class="hint">正在扫描目录（要读每个文件算 hash，第一次慢一点）…</div></div>';
    return;
  }

  const scan = kwSourceDir;
  const lines = [];
  lines.push('<div class="panel"><h2>数据源目录</h2>');
  lines.push('<div class="bar sourcedir-path">'
    + '<input id="sdPath" type="text" value="' + escapeHtml(String(scan.root || '')) + '" '
    + 'placeholder="\\\\wsl$\\Ubuntu\\...\\keywords\\master\\source" style="flex:1;min-width:0">'
    + '<button id="sdSet" type="button">保存路径</button></div>');
  lines.push('<div class="bar sourcedir-actions">');
  lines.push('<button id="sdPick" type="button">选择目录</button>');
  lines.push('<button id="sdOpen" type="button">打开目录</button>');
  lines.push('<button id="sdRescan" type="button">重新扫描</button>');
  if (scan.ok === true && scan.missing && scan.missing.length > 0) {
    lines.push('<button id="sdMkdir" type="button">创建缺失的 ' + scan.missing.length + ' 个目录</button>');
  }
  if (scan.ok === true && scan.counts.new > 0) {
    lines.push('<button id="sdImport" type="button">导入全部未导入（' + scan.counts.new + '）</button>');
  }
  lines.push('<span class="hint" id="sdNote" style="padding:0">'
    + (scan.isDefault ? '默认路径 · 未修改' : '自定义路径') + '</span>');
  lines.push('</div>');

  if (scan.ok !== true) {
    /* 这不是「空态」，是**错误态**：目录读不到。所以用警告块而不是 emptyState ——
       四种空态说的是"没有数据"，这里说的是"根本没读到"。 */
    lines.push('<div class="hint" style="padding:14px;color:var(--warn)">❌ 目录不可达 —— 这**不是**「0 个文件」这个答案。<br>'
      + 'WSL 可能没启动，或者 kw.sourceDir 指向了一个不存在的目录。<br>'
      + '默认路径：<code>' + escapeHtml(String(scan.defaultRoot || '')) + '</code></div>');
  } else {
    lines.push('<div class="hint" style="padding:0 0 8px">✅ 目录可读 · ' + escapeHtml(sourceDirCounts(scan)) + '</div>');
    lines.push('<table><thead><tr><th>子目录</th><th>类型</th><th>文件</th><th>未导入</th>'
      + '<th>已导入</th><th>最近月份</th></tr></thead><tbody>');
    for (const dir of scan.dirs) {
      lines.push('<tr><td>' + escapeHtml(dir.dir) + (dir.optional ? ' <span class="hint">可选</span>' : '')
        + '</td><td>' + escapeHtml(dir.label) + '</td><td>' + dir.files + '</td><td>' + dir.new
        + '</td><td>' + dir.imported + '</td><td>' + escapeHtml(dir.latestMonth || '—') + '</td></tr>');
    }
    lines.push('</tbody></table>');
    if (scan.missing && scan.missing.length > 0) {
      lines.push('<div class="hint" style="padding:8px 0 0">⚠️ 缺 ' + scan.missing.length
        + ' 个必需子目录：' + escapeHtml(scan.missing.join('、'))
        + '。补齐是建空目录、不写文件 —— 这一步目前在对话里做（说「补齐缺失的目录」）。这里原来写「点某个按钮补齐」，那个按钮一直不存在，是又一处指向不存在控件的引用。</div>');
    }
  }
  if (kwSourceError !== '') {
    lines.push('<div class="hint" style="padding:8px 0 0;color:var(--warn)">' + escapeHtml(kwSourceError) + '</div>');
  }
  lines.push('</div>');
  host.innerHTML = lines.join('');

  const pick = $('sdPick');
  if (pick) pick.onclick = () => sourceDirAction('pick');
  const save = $('sdSet');
  if (save) save.onclick = () => sourceDirAction('set');
  const open = $('sdOpen');
  if (open) open.onclick = () => sourceDirAction('open');
  const rescan = $('sdRescan');
  if (rescan) rescan.onclick = () => sourceDirAction('rescan');
  const mkdir = $('sdMkdir');
  if (mkdir) mkdir.onclick = () => sourceDirAction('mkdir');
  const imp = $('sdImport');
  if (imp) imp.onclick = () => sourceDirAction('import');
}

async function sourceDirAction(kind) {
  if (kwSourceBusy) return;
  kwSourceBusy = true;
  kwSourceError = '';
  const note = $('sdNote');
  if (note) note.textContent = kind === 'pick' ? '等待在对话框里选择…' : '处理中…';
  try {
    if (kind === 'rescan') {
      const scan = await api('kw-source-dir');
      kwSourceDir = scan;
    } else if (kind === 'set') {
      const field = $('sdPath');
      const next = field ? String(field.value || '').trim() : '';
      const result = await api('kw-source-dir-set', { method: 'POST', body: JSON.stringify({ path: next }) });
      if (result && result.ok === true) {
        kwSourceDir = result.scan;
        kwSourceError = result.looksLikeSourceRoot === false
          ? '已保存，但这个目录下没有任何已知子目录 —— 它不像关键词数据源目录。'
          : '';
      } else {
        kwSourceError = '保存失败：' + String((result && result.error) || '未知原因');
      }
    } else if (kind === 'pick') {
      const result = await api('kw-source-dir-pick', { method: 'POST', body: '{}' });
      if (result && result.ok === true) {
        kwSourceDir = result.scan;
        /* 成功即清除：上一次的取消/超时提示不能留在新目录下面。 */
        kwSourceError = '';
      } else if (result && result.cancelled === true) {
        kwSourceError = '已取消选择，当前目录没有改变。';
      } else {
        const reason = String((result && result.error) || '未知原因');
        /* 选择框超时是一句解释，不是「选择目录失败」：180 秒是等待上限，不是扫描节流。
           服务端已经带了秒数（pickFolder 的 timeoutMs），页面不写死。 */
        kwSourceError = reason.includes('选择窗口已自动关闭') ? reason : '选择目录失败：' + reason;
      }
    } else if (kind === 'open') {
      const result = await api('kw-source-dir-open', { method: 'POST', body: '{}' });
      if (!result || result.ok !== true) kwSourceError = '打不开目录：' + String((result && result.error) || '未知原因');
    } else if (kind === 'import') {
      const pending = kwSourceDir && kwSourceDir.counts ? kwSourceDir.counts.new : 0;
      if (pending > 0 && !confirm('把 ' + pending + ' 个未导入的文件导入关键词总库？同字节的文件会自动跳过。')) {
        kwSourceBusy = false;
        renderSourceDirCard();
        return;
      }
      const result = await api('kw-source-dir-import', { method: 'POST', body: '{}' });
      if (result && result.ok === true) {
        kwSourceDir = result.scan;
        const s = result.summary || {};
        kwSourceError = '导入完成：找到 ' + (s.found || 0) + '，导入 ' + (s.imported || 0)
          + '，跳过 ' + (s.skipped || 0) + '，失败 ' + (s.failed || 0)
          + (result.masterRows === null || result.masterRows === undefined ? '' : '；主库重算后 ' + result.masterRows + ' 行');
      } else {
        kwSourceError = '导入失败：' + String((result && result.error) || '未知原因');
      }
    } else if (kind === 'mkdir') {
      const result = await api('kw-source-dir-mkdir', { method: 'POST', body: '{}' });
      if (result && result.ok === true) {
        kwSourceDir = result.scan;
        kwSourceError = (result.created && result.created.length > 0)
          ? '已创建：' + result.created.join('、')
          : '没有需要创建的目录。';
      } else {
        kwSourceError = '创建失败：' + String((result && result.error) || '未知原因');
      }
    }
  } catch (error) {
    kwSourceError = String(error && error.message ? error.message : error);
  } finally {
    kwSourceBusy = false;
    renderSourceDirCard();
  }
}

async function ensureSourceDir() {
  if (kwSourceDir !== null) return;
  try {
    kwSourceDir = await api('kw-source-dir');
  } catch (error) {
    kwSourceDir = { ok: false, root: '', defaultRoot: '', isDefault: true, dirs: [], files: [], missing: [], counts: { files: 0, new: 0, imported: 0, unrecognized: 0 } };
    kwSourceError = '扫描失败：' + String(error && error.message ? error.message : error);
  }
  renderSourceDirCard();
}

function renderPipeline() {
  renderSourceDirCard();
  ensureSourceDir();
  const pipeline = state.pipeline;
  if (!pipeline) { $('plstats').innerHTML = ''; $('pllatest').innerHTML = ''; $('plruns').innerHTML = ''; return; }

  if (pipeline.total === 0) {
    $('plstats').innerHTML = '';
    $('pllatest').innerHTML = '';
    $('plruns').innerHTML = emptyState('not-recorded', {
      subject: '关键词管道的运行记录',
      next: '在对话里说「跑一次关键词管道，US 站，先 dryRun 看看」，或用 amzn_kw_pipeline_run'
        + '（加 dryRun: true 只看每步进出数，不写文件）。',
    });
    return;
  }

  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + '">'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + '</span>';
  $('plstats').innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + chip('运行次数', pipeline.total)
    + chip('失败', pipeline.failed, pipeline.failed > 0 ? 'warn' : '')
    + chip('最后运行', pipeline.lastStartedAt === null ? '—' : String(pipeline.lastStartedAt).slice(0, 16).replace('T', ' '))
    + (pipeline.focusId ? '<button id="plClearFocus" style="margin-left:auto">看最近一次</button>' : '')
    + '</div>';

  /* One run's block, used for both the newest run and a focused one — two copies
     would let the focused view drift from the default one.

     The parameter is 'entry', not 'run', for the same reason the history loop
     below uses 'entry': this script also has an optimize run, and the page's own
     field-coverage check reads a second binding of the same name as the optimize
     one — so a pipeline-only field like productLine would be reported as a field
     the optimize payload fails to carry. */
  const runBlock = (entry, heading) => {
    const scope = entry.marketplace + (entry.productLine === null ? '' : ' / ' + entry.productLine);
    /* The id is shown short — the panel is a dashboard, not an index — but the
       full one rides along in the strong's title attribute so it can be read off
       without a round trip. A short id with no way to get the long one is a number
       the user cannot use. (No backticks in this comment: this whole file is one
       template literal, and a stray backtick terminates it — see plugin-contract
       section 8.1.) */
    return '<div class="bar" style="border-bottom:1px solid var(--line)">'
      + '<strong style="font-size:12px" title="' + escapeHtml(String(entry.runId)) + '">' + escapeHtml(heading) + ' '
      + escapeHtml(String(entry.runId).slice(0, 8)) + ' · ' + escapeHtml(scope) + '</strong>'
      + chip('进', entry.inputCount) + chip('出', entry.outputCount)
      + '</div>'
      + '<table><thead><tr><th>#</th><th>阶段</th><th>进</th><th>出</th><th>状态</th></tr></thead><tbody>'
      + (entry.stages || []).map(stage => '<tr>'
        + '<td>' + stage.seq + '</td>'
        + '<td>' + escapeHtml(stage.label) + '</td>'
        + '<td>' + stage.inputCount + '</td>'
        + '<td>' + stage.outputCount + '</td>'
        + '<td>' + (stage.status === 'failed' ? '<span class="chip warn">失败</span>' : '<span class="chip ok">完成</span>') + '</td>'
        + '</tr>').join('')
      + '</tbody></table>'
      + (entry.error ? '<div class="bar"><span class="hint">失败原因: ' + escapeHtml(entry.error) + '</span></div>' : '')
      + '<div class="bar"><span class="hint">最后一行的「出」是 CSV 行数（含否定词），不是词数 —— '
      + '前面的阶段数的是词。每一格的「进」等于上一格的「出」，这就是链式计数。</span></div>';
  };

  /* A run id can arrive from a 「最近运行」 link. It is expanded instead of the
     newest one, because a link that lands on another run's stage counts has moved
     the search rather than done it. */
  const focusId = pipeline.focusId ?? null;
  const focused = pipeline.focused ?? null;

  if (focusId !== null && focused === null) {
    /* The same situation the optimize panel names at page.js:1847, so it gets the
       same sentence: one meaning, one wording — a second phrasing would read as a
       second problem. */
    $('pllatest').innerHTML = '<div class="hint">你点进来的那一轮 ' + escapeHtml(String(focusId).slice(0, 8))
      + ' 已经不在了。下面是最新的历史。</div>';
  } else if (focusId === null && (pipeline.latest === null || pipeline.latest === undefined)) {
    $('pllatest').innerHTML = '';
  } else {
    $('pllatest').innerHTML = runBlock(
      focused === null ? pipeline.latest : focused,
      focusId === null ? '最近一次运行' : '你点进来的那一轮',
    );
  }

  if ($('plClearFocus') !== null) $('plClearFocus').onclick = () => dropFilter('runId');

  $('plruns').innerHTML = '<table><thead><tr><th>run</th><th>开始</th><th>站点</th><th>产品线</th>'
    + '<th>进</th><th>出</th><th>状态</th></tr></thead><tbody>'
    /* The loop variable is 'entry', not 'run': this script also has an optimize
       run, and a second binding of the same name makes the page's own
       field-coverage check unable to tell which object is being read. */
    + pipeline.runs.map(entry => '<tr' + (entry.runId === focusId ? ' class="sel"' : '') + '>'
      + '<td title="' + escapeHtml(String(entry.runId)) + '">' + escapeHtml(String(entry.runId).slice(0, 8)) + '</td>'
      + '<td>' + escapeHtml(String(entry.startedAt).slice(0, 16).replace('T', ' ')) + '</td>'
      + '<td>' + escapeHtml(entry.marketplace) + '</td>'
      + '<td>' + escapeHtml(entry.productLine === null ? '全部' : entry.productLine) + '</td>'
      + '<td>' + entry.inputCount + '</td>'
      + '<td>' + entry.outputCount + '</td>'
      + '<td>' + (entry.status === 'failed' ? '<span class="chip warn">失败</span>' : '完成') + '</td>'
      + '</tr>').join('')
    + '</tbody></table>'
    + '<div class="bar" style="border-top:1px solid var(--line)"><span class="hint">'
    + '这些数字是按当时的库与那些参数算出的；库变了，同样的参数会得到不同的数 —— 参数与口径可复现，字节不可复现。'
    + '</span></div>';
}`
