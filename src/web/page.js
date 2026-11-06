/**
 * 页面：一个自包含的 HTML（无外链、无打包、无第三方 JS）。
 *
 * 五个页签按模块推进：M1 只让「连接」真正可用，其余四个写明自己在哪个模块里施工——
 * 一个还没做的页签写「施工中」比画一个假表格诚实，也省得用户以为数据丢了。
 */
export function renderPage({ pagePath = '/custom/sif-ops' } = {}) {
  const apiBase = pagePath + '/api'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SIF 数据台</title>
<style>
  :root{
    --bg:#0f1115; --panel:#161a21; --line:#262d38; --text:#e6e9ef; --muted:#8b95a5;
    --accent:#4cc2ff; --ok:#38d39f; --warn:#ffb454; --err:#ff6b6b;
  }
  @media (prefers-color-scheme: light){
    :root{ --bg:#f7f8fa; --panel:#ffffff; --line:#e3e7ee; --text:#1c2331; --muted:#66707f; --accent:#0b7fd1; }
  }
  *{ box-sizing:border-box }
  html,body{ margin:0; height:100% }
  body{
    background:var(--bg); color:var(--text);
    font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
    display:flex; flex-direction:column;
  }
  .bar{ display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel) }
  .brand{ font-weight:600; font-size:14px; letter-spacing:.2px }
  .brand small{ color:var(--muted); font-weight:400; margin-left:8px }
  .pill{ margin-left:auto; font-size:12px; padding:3px 10px; border-radius:999px; border:1px solid var(--line); color:var(--muted) }
  .pill.ok{ color:var(--ok); border-color:color-mix(in srgb, var(--ok) 40%, transparent) }
  .pill.warn{ color:var(--warn); border-color:color-mix(in srgb, var(--warn) 40%, transparent) }
  .tabs{ display:flex; gap:2px; padding:0 12px; border-bottom:1px solid var(--line); background:var(--panel); overflow:auto }
  .tabs button{
    appearance:none; background:none; border:0; border-bottom:2px solid transparent; color:var(--muted);
    padding:9px 12px; font:inherit; cursor:pointer; white-space:nowrap;
  }
  .tabs button.on{ color:var(--text); border-bottom-color:var(--accent) }
  main{ flex:1; overflow:auto; padding:18px }
  .panel{ display:none; max-width:860px }
  .panel.on{ display:block }
  h2{ font-size:13px; font-weight:600; margin:0 0 4px }
  .hint{ color:var(--muted); margin:0 0 16px; font-size:12px }
  .card{ background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:14px }
  .row{ display:flex; align-items:center; gap:10px; margin-bottom:10px }
  .row label{ width:112px; color:var(--muted); flex:none }
  input,select{
    flex:1; min-width:0; background:var(--bg); color:var(--text); border:1px solid var(--line);
    border-radius:7px; padding:7px 9px; font:inherit;
  }
  input:focus,select:focus{ outline:none; border-color:var(--accent) }
  .btns{ display:flex; gap:8px; flex-wrap:wrap; margin-top:4px }
  button.act{
    background:var(--accent); color:#04121c; border:0; border-radius:7px; padding:7px 14px;
    font:inherit; font-weight:600; cursor:pointer;
  }
  button.act.ghost{ background:transparent; color:var(--text); border:1px solid var(--line); font-weight:400 }
  button.act[disabled]{ opacity:.45; cursor:not-allowed }
  pre.out{
    background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px;
    font:12px/1.5 ui-monospace,Consolas,monospace; color:var(--muted); white-space:pre-wrap; margin:12px 0 0; min-height:22px;
  }
  .kv{ display:grid; grid-template-columns:150px 1fr; gap:6px 12px; font-size:12px }
  .kv div:nth-child(odd){ color:var(--muted) }
  .tag{ display:inline-block; font-size:11px; padding:1px 7px; border-radius:6px; border:1px solid var(--line); color:var(--muted) }
</style>
</head>
<body>
  <div class="bar">
    <div class="brand">SIF 数据台<small>mcp.sif.com · 本地 SQLite</small></div>
    <div class="pill" id="pill">读取中…</div>
  </div>

  <nav class="tabs" id="tabs">
    <button data-tab="conn" class="on">连接</button>
    <button data-tab="objects">对象</button>
    <button data-tab="sync">同步</button>
    <button data-tab="board">看板</button>
    <button data-tab="insight">洞察</button>
    <button data-tab="keywords">词库</button>
    <button data-tab="competition">竞品</button>
    <button data-tab="listing">优化</button>
  </nav>

  <main>
    <section class="panel on" data-panel="conn">
      <h2>连接 mcp.sif.com</h2>
      <p class="hint">密钥只写进本机 <code>data/config.json</code>（0600），不写进 profile 配置、不进 git。页面只回显尾 4 位。</p>

      <div class="card">
        <div class="row"><label>端点</label><input id="endpoint" placeholder="https://mcp.sif.com/mcp"></div>
        <div class="row"><label>鉴权方式</label>
          <select id="authMode"><option value="bearer">Bearer 密钥（推荐）</option><option value="oauth">OAuth 2.1（后续）</option></select>
        </div>
        <div class="row"><label>密钥</label><input id="secret" placeholder="sifmcp…（留空 = 不修改已存密钥）"></div>
        <div class="row"><label>日预算（点）</label><input id="dailyBudget" type="number" min="1" step="1"></div>
        <div class="btns">
          <button class="act" id="save">保存配置</button>
          <button class="act" id="test" title="0 点：initialize + tools/list + query_quota">测试连接</button>
          <button class="act ghost" id="clear">清空密钥</button>
        </div>
        <pre class="out" id="connOut">未操作</pre>
      </div>

      <div class="card">
        <h2>本机状态</h2>
        <div class="kv" id="statusKv"><div>—</div><div>读取中…</div></div>
      </div>
    </section>

    <section class="panel" data-panel="objects">
      <h2>对象：本地清单</h2>
      <p class="hint">加进来的 ASIN 才会被同步。数据按「ASIN × 周」入库，重抓覆盖不累加；最后同步 / 数据截止日单列，避免把 T-1 的数据当今天。</p>
      <div class="card">
        <div class="row"><label>ASIN</label><input id="objAsin" placeholder="B0XXXXXXXX" maxlength="10"></div>
        <div class="row"><label>归属</label>
          <select id="objLabel"><option value="mine">我的产品</option><option value="competitor">竞品</option></select>
        </div>
        <div class="row"><label>备注</label><input id="objNote" placeholder="可选，比如「主推」「待观察」"></div>
        <div class="btns"><button class="act" id="objAdd">添加 / 更新</button></div>
        <pre class="out" id="objOut">未操作</pre>
      </div>
      <div class="card"><div id="objList" class="kv"><div>—</div><div>读取中…</div></div></div>
    </section>

    <section class="panel" data-panel="sync">
      <h2>同步：花钱的入口</h2>
      <p class="hint">L1 = 流量趋势(2 点) + Listing 渠道结构(3 点) = <b>5 点/ASIN</b>。6 小时内抓过的直接复用，扣 0 点并标「复用」。超过日预算会拒绝执行。</p>
      <div class="card">
        <div class="row"><label>档位</label>
          <select id="syncLevel">
            <option value="L1">L1 日报 · 5 点/ASIN</option>
            <option value="L2">L2 周报 · 6 点/ASIN（关键词 + 广告结构 + 销量）</option>
          </select>
        </div>
        <div class="row"><label>本次预计</label><span id="syncPlan" style="flex:1;color:var(--muted)">—</span></div>
        <div class="btns">
          <button class="act" id="syncRun">跑一次</button>
          <button class="act" id="dailyRun">一键日更（同步 → 洞察 → 组合总览 → 深度报告）</button>
          <button class="act ghost" id="syncPlanRefresh">重新算预算</button>
        </div>
        <pre class="out" id="syncOut">未操作</pre>
        <div id="dailySteps" class="kv"></div>
      </div>
    </section>

    <section class="panel" data-panel="board">
      <h2>看板</h2>
      <p class="hint">全部读本地库，0 点。数据截止日不是今天——SIF 每天更新、滞后一天。</p>
      <div class="card" id="todoCard">读取中…</div>
      <div class="card" id="healthCard">读取中…</div>
      <div class="card" id="boardSummary" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">读取中…</div>
      <div id="boardList"></div>
    </section>

    <section class="panel" data-panel="insight">
      <h2>洞察与报告</h2>
      <p class="hint">结论由本地规则算出，每条带证据（哪几周、哪个词、差几位）。报告会存进库，并落一份 .md 文件。</p>
      <div class="card">
        <div class="btns" style="margin:0 0 10px">
          <select id="reportAsin" style="max-width:240px"></select>
          <button class="act" id="reportMake">生成报告</button>
          <button class="act" id="deepMake">生成深度总报告（HTML）</button>
          <button class="act ghost" id="insightRefresh">重算洞察</button>
        </div>
        <pre class="out" id="reportOut">未操作</pre>
      </div>
      <div class="card"><div id="insightList" class="kv">读取中…</div></div>
    </section>

    <section class="panel" data-panel="keywords">
      <h2>关键词总库</h2>
      <p class="hint">三种状态分开：<b>candidate</b> 挖来待定、<b>tracked</b> 正在追、<b>excluded</b> 已放弃。候选词不进报告。</p>

      <div class="card">
        <div class="row"><label>词根挖掘</label><input id="mineRoot" placeholder="例如 bench cushion"></div>
        <div class="btns">
          <button class="act" id="mineBtn">挖掘关系词（3 点）</button>
          <button class="act ghost" id="kwSyncBtn">拉 tracked 词数据（按批：10 词 1 点 + 20 词 2 点）</button>
          <button class="act ghost" id="exportKw">导出词库 CSV</button>
          <button class="act ghost" id="exportTraffic">导出流量 CSV</button>
        </div>
        <pre class="out" id="kwOut">未操作</pre>
      </div>

      <div class="card">
        <div class="row"><label>筛选</label>
          <select id="kwFilter">
            <option value="">全部</option>
            <option value="candidate">候选（candidate）</option>
            <option value="tracked">追踪中（tracked）</option>
            <option value="excluded">已放弃（excluded）</option>
          </select>
        </div>
        <div id="kwList" class="kv">读取中…</div>
      </div>
    </section>

    <section class="panel" data-panel="competition">
      <h2>竞品与市场格局</h2>
      <p class="hint">一个词 2 点：拿到 Top 竞品 ASIN + 价格，以及集中度 / 点击与转化的背离。判断的是「我挤不挤得进去」。</p>
      <div class="card">
        <div class="row"><label>关键词</label><input id="compKeyword" placeholder="例如 bench cushion"></div>
        <div class="btns"><button class="act" id="compBtn">分析（2 点）</button></div>
        <pre class="out" id="compOut">未操作</pre>
      </div>
      <div class="card"><div id="compList" class="kv">还没有结果</div></div>
    </section>

    <section class="panel" data-panel="listing">
      <h2>Listing 深度诊断</h2>
      <p class="hint">12 个维度：标题 / 亮点 / 五点 / 主副图 / A+ / 评论 / 变体 / GEO / 价格 / 属性 / 后台词 / 政策合规。没有数据来源的维度会明确标「无数据来源」，不当成通过。</p>
      <div class="card">
        <div class="btns" style="margin:0 0 10px">
          <button class="act" id="auditBtn">生成深度诊断 + 报告</button>
          <button class="act" id="draftBtn">生成改稿草稿 + 复测</button>
          <button class="act ghost" id="draftBtn2">第二轮改稿（收紧五点 + GEO）</button>
          <button class="act ghost" id="auditShow">看已有诊断</button>
        </div>
        <pre class="out" id="auditOut">未操作</pre>
      </div>
      <div class="card"><div id="auditList" class="kv">还没有诊断结果</div></div>

      <div class="card">
        <h2>素材补录（主图 / A+ / 差评主题）</h2>
        <p class="hint">这三项 SIF 不提供。补进来之后诊断会把它们从「无数据来源」变成真实判定；不补就一直是「没看过」，不是「没问题」。</p>
        <div class="row"><label>图片总数</label><input id="assetImages" type="number" min="0" placeholder="例如 7"></div>
        <div class="row"><label>主图白底</label>
          <select id="assetWhite"><option value="">未知</option><option value="1">是</option><option value="0">否</option></select>
        </div>
        <div class="row"><label>边长 ≥1000px</label>
          <select id="assetPx"><option value="">未知</option><option value="1">是</option><option value="0">否</option></select>
        </div>
        <div class="row"><label>有视频</label>
          <select id="assetVideo"><option value="">未知</option><option value="1">有</option><option value="0">无</option></select>
        </div>
        <div class="row"><label>有 A+</label>
          <select id="assetAplus"><option value="">未知</option><option value="1">有</option><option value="0">无</option></select>
        </div>
        <div class="row"><label>差评主题</label><input id="assetThemes" placeholder="用逗号分隔，例如 尺寸偏小,坐垫塌陷,掉色"></div>
        <div class="btns"><button class="act" id="assetSave">保存素材</button></div>
        <pre class="out" id="assetOut">未操作</pre>
      </div>
    </section>
  </main>

<script>
(function(){
  var API = ${JSON.stringify(apiBase)};
  var el = function(id){ return document.getElementById(id) };
  var out = el('connOut');

  function say(obj){ out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }
  function getJSON(path){
    return fetch(API + path, { cache:'no-store' }).then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function postJSON(path, body){
    return fetch(API + path, {
      method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body || {}),
    }).then(function(r){ return r.json().then(function(j){ return { ok:r.ok, body:j } }) });
  }

  // 页签
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function(btn){
    btn.addEventListener('click', function(){
      Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function(b){ b.classList.remove('on') });
      Array.prototype.forEach.call(document.querySelectorAll('.panel'), function(p){ p.classList.remove('on') });
      btn.classList.add('on');
      var panel = document.querySelector('[data-panel="' + btn.dataset.tab + '"]');
      if (panel) panel.classList.add('on');
    });
  });

  function renderStatus(s){
    var pill = el('pill');
    var configured = !!(s.config && s.config.hasSecret);
    pill.textContent = configured ? '已配置密钥' : '未配置密钥';
    pill.className = 'pill ' + (configured ? 'ok' : 'warn');

    var rows = [
      ['阶段', s.stage || ''],
      ['端点', s.config ? s.config.endpoint : ''],
      ['密钥', s.config && s.config.hasSecret ? ('已保存 ' + s.config.secretHint) : '未保存'],
      ['日预算', s.config ? (s.config.dailyBudget + ' 点') : ''],
      ['配置文件', s.config ? s.config.configPath : ''],
      ['数据库', s.dbFile + (s.dbExists ? '（已存在）' : '（尚未创建）')],
      ['MCP 连接', s.mcp && s.mcp.connected ? '已连接' : (s.mcp && s.mcp.note ? s.mcp.note : '未连接')],
    ];
    var kv = el('statusKv');
    kv.innerHTML = '';
    rows.forEach(function(pair){
      var k = document.createElement('div'); k.textContent = pair[0];
      var v = document.createElement('div'); v.textContent = pair[1] === undefined ? '' : String(pair[1]);
      kv.appendChild(k); kv.appendChild(v);
    });

    if (s.config){
      el('endpoint').value = s.config.endpoint || '';
      el('authMode').value = s.config.authMode || 'bearer';
      el('dailyBudget').value = s.config.dailyBudget || 60;
      el('secret').placeholder = s.config.hasSecret
        ? ('已保存 ' + s.config.secretHint + '（留空 = 不修改）')
        : 'sifmcp…';
    }
  }

  function refresh(){
    getJSON('/status').then(function(s){
      renderStatus(s);
      el('test').title = 'M2 阶段接入：会用 0 点的 initialize + tools/list + query_quota 验证';
    }).catch(function(e){
      el('pill').textContent = '读取失败';
      el('pill').className = 'pill warn';
      say('读取状态失败：' + e.message);
    });
  }

  el('save').addEventListener('click', function(){
    var body = {
      endpoint: el('endpoint').value.trim(),
      authMode: el('authMode').value,
      dailyBudget: Number(el('dailyBudget').value),
    };
    var secret = el('secret').value.trim();
    if (secret) body.secret = secret;
    postJSON('/config', body).then(function(res){
      if (!res.ok) { say('保存失败：' + (res.body && res.body.error || '未知错误')); return }
      el('secret').value = '';
      say('已保存：' + res.body.config.endpoint + '（密钥 ' + (res.body.config.hasSecret ? res.body.config.secretHint : '无') + '）');
      refresh();
    }).catch(function(e){ say('保存失败：' + e.message) });
  });

  el('clear').addEventListener('click', function(){
    postJSON('/config', { clearSecret: true }).then(function(res){
      say(res.ok ? '密钥已清空' : ('清空失败：' + (res.body && res.body.error)));
      refresh();
    }).catch(function(e){ say('清空失败：' + e.message) });
  });

  el('test').addEventListener('click', function(){
    el('test').disabled = true;
    say('测试中（0 点）：initialize → tools/list → query_quota …');
    postJSON('/test', {}).then(function(res){
      el('test').disabled = false;
      if (!res.ok) { say('连接失败：' + (res.body && res.body.error || '未知错误')); return }
      var b = res.body;
      var quota = b.quota && b.quota.remainingTotal;
      var info = b.serverInfo || {};
      var lines = [
        '✓ 连接成功（' + (b.elapsedMs || 0) + ' ms）',
        '服务: ' + (info.name || '?') + ' ' + (info.version || '') + (info.title ? ' · ' + info.title : ''),
        '工具: ' + b.toolCount + ' 个',
        '剩余点数: ' + (quota === undefined || quota === null ? '未知' : quota),
      ];
      if (b.quota && b.quota.scopes && b.quota.scopes.length) {
        var s = b.quota.scopes[0];
        lines.push('配额域: ' + s.scopeType + ' · ' + s.scopeId + ' · ' + s.usedCount + '/' + s.quotaLimit + ' 已用');
        if (s.periodStart) lines.push('计费周期: ' + s.periodStart + ' → ' + s.periodEnd);
      }
      if (b.tools && b.tools.length) lines.push('工具清单: ' + b.tools.slice(0, 8).join(', ') + (b.tools.length > 8 ? ' …' : ''));
      say(lines.join('\\n'));
      refresh();
    }).catch(function(e){ el('test').disabled = false; say('连接失败：' + e.message) });
  });

  // ── 对象清单 ────────────────────────────────────────────
  var objOut = el('objOut');
  function sayObj(t){ objOut.textContent = typeof t === 'string' ? t : JSON.stringify(t, null, 2) }

  function renderObjects(list){
    var box = el('objList');
    if (!list || !list.length){
      box.innerHTML = '<div>（还没有对象）</div><div>在上面加一个 ASIN 开始</div>';
      return;
    }
    var html = '';
    list.forEach(function(o){
      html += '<div style="grid-column:1 / span 2;border-top:1px solid var(--line);padding:8px 0">'
        + '<b>' + o.asin + '</b> '
        + '<span class="tag">' + (o.label === 'competitor' ? '竞品' : '我的') + '</span> '
        + (o.title ? '<span style="color:var(--muted)">' + String(o.title).slice(0, 48) + '</span>' : '')
        + '<div style="color:var(--muted);font-size:12px;margin-top:4px">'
        + '数据截止 ' + (o.last_data_date || '—')
        + ' · 最后同步 ' + (o.last_sync ? String(o.last_sync).slice(0, 19).replace('T', ' ') : '—')
        + ' · 流量行 ' + (o.traffic_rows || 0)
        + (o.price ? (' · $' + o.price) : '')
        + ' <button class="act ghost" style="padding:2px 8px;font-size:12px" data-del="' + o.asin + '">移除</button>'
        + '</div></div>';
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function(btn){
      btn.addEventListener('click', function(){
        postJSON('/objects/delete', { asin: btn.getAttribute('data-del') }).then(function(r){
          if (!r.ok) { sayObj('移除失败：' + (r.body && r.body.error)); return }
          renderObjects(r.body.objects || []);
          loadPlan();
        }).catch(function(e){ sayObj('移除失败：' + e.message) });
      });
    });
  }

  function loadObjects(){
    getJSON('/objects').then(function(r){ renderObjects(r.objects || []) })
      .catch(function(e){ sayObj('读取对象失败：' + e.message) });
  }

  el('objAdd').addEventListener('click', function(){
    var asin = el('objAsin').value.trim().toUpperCase();
    if (!asin) { sayObj('先填一个 ASIN'); return }
    postJSON('/objects', { asin: asin, label: el('objLabel').value, note: el('objNote').value.trim() }).then(function(res){
      if (!res.ok) { sayObj('添加失败：' + (res.body && res.body.error)); return }
      sayObj('已加入 ' + asin
        + (res.body.profile && res.body.profile.ok
            ? ('（画像 ' + (res.body.profile.cached ? '复用缓存 0 点' : (res.body.profile.cost + ' 点')) + (res.body.profile.title ? ' · ' + String(res.body.profile.title).slice(0, 40) : '') + '）')
            : '（画像没拉到：' + ((res.body.profile && res.body.profile.error) || '未知') + '）')
        + '，下一步去「同步」页跑 L1');
      el('objAsin').value = '';
      el('objNote').value = '';
      renderObjects(res.body.objects || []);
      loadPlan();
    }).catch(function(e){ sayObj('添加失败：' + e.message) });
  });

  // ── 同步 ────────────────────────────────────────────────
  var syncOut = el('syncOut');
  function saySync(t){ syncOut.textContent = typeof t === 'string' ? t : JSON.stringify(t, null, 2) }

  function loadPlan(){
    var level = el('syncLevel').value;
    getJSON('/sync/plan?level=' + encodeURIComponent(level)).then(function(r){
      var p = r.plan || {};
      var n = (p.asins || []).length;
      el('syncPlan').textContent = n + ' 个 ASIN × ' + p.costPerAsin + ' 点 = ' + p.cost + ' 点'
        + '（今日已花 ' + (p.todaySpent || 0) + ' / 预算 ' + p.budget + ' 点）'
        + (p.overBudget ? ' ⚠ 超预算，会被拒绝' : '');
    }).catch(function(e){ el('syncPlan').textContent = '预算读取失败：' + e.message });
  }

  el('syncPlanRefresh').addEventListener('click', loadPlan);

  el('syncRun').addEventListener('click', function(){
    el('syncRun').disabled = true;
    saySync('同步中…（每个 ASIN 先查缓存，命中则不扣点）');
    postJSON('/sync/run', { level: el('syncLevel').value }).then(function(res){
      el('syncRun').disabled = false;
      if (!res.ok) { saySync('同步失败：' + (res.body && res.body.error || '未知错误')); return }
      var b = res.body;
      var lines = [];
      (b.results || []).forEach(function(r){
        var detail = '';
        if (r.parts){
          var p = [];
          if (r.parts.keywords) p.push('词 ' + (r.parts.keywords.rows || 0));
          if (r.parts.ads) p.push('广告 ' + (r.parts.ads.total || 0) + ' 个 campaign');
          if (r.parts.sales) p.push('销量 ' + (r.parts.sales.months || 0) + ' 月');
          detail = ' · ' + p.join(' · ');
        }
        lines.push((r.ok ? '✓ ' : '✗ ') + r.asin
          + ' · ' + (r.cached ? '复用缓存 0 点' : (r.cost + ' 点'))
          + detail
          + (r.weeks ? (' · ' + r.weeks + ' 周') : '')
          + ' · 截止 ' + (r.dataDate || '—')
          + (r.error ? (' · ' + r.error) : ''));
      });
      lines.push('合计：' + b.totalCost + ' 点 / 入库 ' + b.totalRows + ' 行');
      saySync(lines.join('\\n'));
      loadPlan();
      loadObjects();
    }).catch(function(e){ el('syncRun').disabled = false; saySync('同步失败：' + e.message) });
  });

  // ── 看板 ────────────────────────────────────────────────
  function fmt(v, digits){ return (v === null || v === undefined) ? '—' : Number(v).toFixed(digits || 0) }
  function pctf(v){ return (v === null || v === undefined) ? '—' : (v*100).toFixed(1) + '%' }

  function spark(weeks){
    if (!weeks || !weeks.length) return '<div style="color:var(--muted);font-size:12px">还没有流量数据</div>';
    var W = 340, H = 88, P = 6;
    var max = 1;
    weeks.forEach(function(w){
      max = Math.max(max, w.total_score || 0, w.nf_score || 0, w.ad_score || 0);
    });
    function pts(key){
      return weeks.map(function(w, i){
        var x = P + (W - 2*P) * (weeks.length === 1 ? 0.5 : i / (weeks.length - 1));
        var y = H - P - (H - 2*P) * ((w[key] || 0) / max);
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="88" preserveAspectRatio="none" aria-label="流量走势">'
      + '<polyline fill="none" stroke="#4cc2ff" stroke-width="2" points="' + pts('nf_score') + '" />'
      + '<polyline fill="none" stroke="#ffb454" stroke-width="2" points="' + pts('ad_score') + '" />'
      + '</svg>'
      + '<div style="display:flex;gap:14px;color:var(--muted);font-size:11px;margin-top:2px">'
      + '<span>━ 自然</span><span style="color:#ffb454">━ 广告</span>'
      + '<span style="margin-left:auto">' + weeks.length + ' 周 · 峰值 ' + Math.round(max) + '</span></div>';
  }

  function renderBoard(d){
    var sum = el('boardSummary');
    var asins = d.asins || [];
    sum.innerHTML = '<b>' + asins.length + ' 个对象</b>'
      + '<span class="pill ' + (d.alerts.high ? 'warn' : 'ok') + '" style="margin-left:0">高危 ' + d.alerts.high + '</span>'
      + '<span class="pill" style="margin-left:0">中 ' + d.alerts.medium + '</span>'
      + '<span class="pill" style="margin-left:0">低 ' + d.alerts.low + '</span>'
      + '<span style="color:var(--muted);font-size:12px">数据截止 ' + ((asins[0] && asins[0].dataDate) || '—') + ' · 生成于 ' + (d.generatedAt || '').slice(11, 16) + '</span>';

    var box = el('boardList');
    if (!asins.length){ box.innerHTML = '<div class="card">还没有对象，先去「对象」页加 ASIN。</div>'; return }
    var html = '';
    asins.forEach(function(a){
      var latest = a.latest || {};
      html += '<div class="card">'
        + '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">'
        + '<b style="font-size:14px">' + a.asin + '</b>'
        + '<span class="tag">' + (a.label === 'competitor' ? '竞品' : '我的') + '</span>'
        + (a.price ? '<span style="color:var(--muted);font-size:12px">$' + a.price + '</span>' : '')
        + (a.star ? '<span style="color:var(--muted);font-size:12px">' + a.star + '★ / ' + (a.reviews || 0) + ' 评</span>' : '')
        + '<span style="margin-left:auto;color:var(--muted);font-size:12px">截止 ' + (a.dataDate || '—') + '</span>'
        + '</div>'
        + (a.title ? '<div style="color:var(--muted);font-size:12px;margin-bottom:8px">' + String(a.title).slice(0, 70) + '</div>' : '')
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:8px">'
        + '<div><div style="color:var(--muted);font-size:11px">最新周总流量</div><div style="font-size:16px">' + fmt(latest.total_score) + '</div></div>'
        + '<div><div style="color:var(--muted);font-size:11px">自然占比</div><div style="font-size:16px;color:#4cc2ff">' + pctf(latest.nf_ratio) + '</div></div>'
        + '<div><div style="color:var(--muted);font-size:11px">广告占比</div><div style="font-size:16px;color:#ffb454">' + pctf(latest.ad_ratio) + '</div></div>'
        + '<div><div style="color:var(--muted);font-size:11px">周环比</div><div style="font-size:16px">' + (latest.total_change_ratio === null || latest.total_change_ratio === undefined ? '—' : ((latest.total_change_ratio >= 0 ? '+' : '') + (latest.total_change_ratio*100).toFixed(1) + '%')) + '</div></div>'
        + '</div>'
        + spark(a.weeks)
        + '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">'
        + (a.insights || []).slice(0, 3).map(function(i){
            var color = i.severity === 'high' ? 'var(--err)' : (i.severity === 'medium' ? 'var(--warn)' : 'var(--muted)');
            return '<span class="tag" style="border-color:' + color + ';color:' + color + '">' + i.title.slice(0, 46) + '</span>';
          }).join('')
        + '</div>'
        + '<div style="margin-top:8px;color:var(--muted);font-size:12px">覆盖：流量 ' + a.coverage.trafficRows + ' 行 · 关键词 ' + a.coverage.keywordRows + ' 行 · 销量 ' + a.coverage.salesRows + ' 行'
        + ' <button class="act ghost" style="padding:2px 8px;font-size:12px" data-report="' + a.asin + '">生成报告</button></div>'
        + '</div>';
    });
    box.innerHTML = html;

    // 报告下拉同步
    var sel = el('reportAsin');
    sel.innerHTML = asins.map(function(a){ return '<option value="' + a.asin + '">' + a.asin + (a.label === 'competitor' ? '（竞品）' : '') + '</option>' }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('[data-report]'), function(btn){
      btn.addEventListener('click', function(){ makeReport(btn.getAttribute('data-report')) });
    });
  }

  function loadBoard(){
    getJSON('/dashboard').then(function(r){ renderBoard(r.dashboard) })
      .catch(function(e){ el('boardList').innerHTML = '<div class="card">看板读取失败：' + e.message + '</div>' });
  }

  // ── 洞察 / 报告 ──────────────────────────────────────────
  function renderInsights(list){
    var box = el('insightList');
    if (!list || !list.length){ box.innerHTML = '<div>（没有触发的规则）</div><div>同步一次 L1/L2 后会自动重算</div>'; return }
    box.innerHTML = list.map(function(i){
      var color = i.severity === 'high' ? 'var(--err)' : (i.severity === 'medium' ? 'var(--warn)' : 'var(--muted)');
      return '<div style="grid-column:1 / span 2;border-top:1px solid var(--line);padding:8px 0">'
        + '<span class="tag" style="border-color:' + color + ';color:' + color + '">' + i.severity + '</span> '
        + '<b>' + i.asin + '</b> · ' + i.title
        + (i.suggestion ? '<div style="color:var(--muted);font-size:12px;margin-top:3px">动作：' + i.suggestion + '</div>' : '')
        + '</div>';
    }).join('');
  }

  function loadInsights(){
    getJSON('/insights').then(function(r){ renderInsights(r.insights || []) })
      .catch(function(e){ el('insightList').innerHTML = '<div>洞察读取失败：' + e.message + '</div>' });
  }

  function makeReport(asin){
    var out = el('reportOut');
    out.textContent = '生成中…（读本地库，0 点）';
    postJSON('/report', { asin: asin || el('reportAsin').value }).then(function(res){
      if (!res.ok){ out.textContent = '生成失败：' + (res.body && res.body.error || '未知错误'); return }
      var r = res.body.report;
      out.textContent = '✓ 报告 #' + r.id + ' · ' + r.title + '\\n文件：' + r.file + '\\n\\n' + r.markdown.slice(0, 1200) + (r.markdown.length > 1200 ? '\\n\\n…（完整内容已写入文件与库）' : '');
      loadInsights();
    }).catch(function(e){ out.textContent = '生成失败：' + e.message });
  }

  el('reportMake').addEventListener('click', function(){ makeReport() });

  el('deepMake').addEventListener('click', function(){
    var out = el('reportOut');
    el('deepMake').disabled = true;
    out.textContent = '生成深度总报告（读本地库，0 点）…';
    postJSON('/report/deep', { asin: el('reportAsin').value }).then(function(res){
      el('deepMake').disabled = false;
      if (!res.ok){ out.textContent = '生成失败：' + (res.body && res.body.error || '未知错误'); return }
      var r = res.body.report;
      out.textContent = '✓ 深度总报告 #' + r.id + '\\nMarkdown：' + r.mdFile + '\\nHTML：' + r.htmlFile
        + '\\nListing 诊断分：' + r.score + ' · 改稿复测：' + r.draftDiff.scoreBefore + ' → ' + r.draftDiff.scoreAfter
        + '（' + (r.draftDiff.delta >= 0 ? '+' : '') + r.draftDiff.delta + '）'
        + '\\n\\nHTML 是自包含单文件（内联 CSS + SVG），可直接发客户或打印成 PDF。';
    }).catch(function(e){ el('deepMake').disabled = false; out.textContent = '生成失败：' + e.message });
  });
  el('insightRefresh').addEventListener('click', function(){ loadBoard(); loadInsights(); });

  // ── 词库 ────────────────────────────────────────────────
  var kwOut = el('kwOut');
  function sayKw(t){ kwOut.textContent = typeof t === 'string' ? t : JSON.stringify(t, null, 2) }

  function renderKeywords(list){
    var box = el('kwList');
    if (!list || !list.length){
      box.innerHTML = '<div>（词库是空的）</div><div>用上面的「词根挖掘」先挖一批候选词</div>';
      return;
    }
    var html = '';
    list.forEach(function(k){
      var pos = k.my_page ? ('第 ' + k.my_page + ' 页 ' + (k.my_pos || '') + ' 位') : (k.my_share ? '未进前 3 页' : '未覆盖');
      html += '<div style="grid-column:1 / span 2;border-top:1px solid var(--line);padding:7px 0">'
        + '<b>' + k.keyword + '</b> '
        + '<span class="tag">' + k.status + '</span>'
        + (k.aba_volume ? ' <span style="color:var(--muted);font-size:12px">周量 ' + Math.round(k.aba_volume).toLocaleString('en-US') + '</span>' : (k.volume_week ? ' <span style="color:var(--muted);font-size:12px">周量 ' + Math.round(k.volume_week) + '</span>' : ''))
        + (k.diagnosis ? ' <span class="tag">' + k.diagnosis + '</span>' : '')
        + (k.weeks_to_peak !== null && k.weeks_to_peak !== undefined ? ' <span style="color:var(--muted);font-size:12px">距旺季 ' + k.weeks_to_peak + ' 周</span>' : '')
        + '<div style="color:var(--muted);font-size:12px;margin-top:3px">'
        + '我的位置 ' + pos
        + (k.source ? ' · 来源 ' + k.source : '')
        + ' <button class="act ghost" style="padding:1px 7px;font-size:11px" data-kw="' + k.keyword + '" data-to="tracked">追踪</button>'
        + ' <button class="act ghost" style="padding:1px 7px;font-size:11px" data-kw="' + k.keyword + '" data-to="candidate">降候选</button>'
        + ' <button class="act ghost" style="padding:1px 7px;font-size:11px" data-kw="' + k.keyword + '" data-to="excluded">放弃</button>'
        + '</div></div>';
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-kw]'), function(btn){
      btn.addEventListener('click', function(){
        postJSON('/keywords/status', { keyword: btn.getAttribute('data-kw'), status: btn.getAttribute('data-to') }).then(function(r){
          if (!r.ok){ sayKw('改状态失败：' + (r.body && r.body.error)); return }
          renderKeywords(r.body.keywords || []);
        });
      });
    });
  }

  function loadKeywords(){
    var status = el('kwFilter').value;
    getJSON('/keywords' + (status ? ('?status=' + encodeURIComponent(status)) : '')).then(function(r){
      renderKeywords(r.keywords || []);
    }).catch(function(e){ el('kwList').innerHTML = '<div>词库读取失败：' + e.message + '</div>' });
  }

  el('kwFilter').addEventListener('change', loadKeywords);

  el('mineBtn').addEventListener('click', function(){
    var root = el('mineRoot').value.trim();
    if (!root){ sayKw('先填一个词根'); return }
    el('mineBtn').disabled = true;
    sayKw('挖掘中（3 点）…');
    postJSON('/keywords/mine', { root: root, pageSize: 100 }).then(function(r){
      el('mineBtn').disabled = false;
      if (!r.ok){ sayKw('挖掘失败：' + (r.body && r.body.error || '未知错误')); return }
      var b = r.body;
      sayKw('✓ 词根 ' + b.root + '：入库 ' + b.added + ' 个候选词'
        + (b.total ? ('（该词根共 ' + b.total + ' 个关系词）') : '')
        + ' · ' + (b.cached ? '复用缓存 0 点' : (b.cost + ' 点')));
      renderKeywords(b.library || []);
    }).catch(function(e){ el('mineBtn').disabled = false; sayKw('挖掘失败：' + e.message) });
  });

  el('kwSyncBtn').addEventListener('click', function(){
    el('kwSyncBtn').disabled = true;
    sayKw('拉取 tracked 词的 ABA + 需求诊断（3 点/词）…');
    postJSON('/keywords/sync', {}).then(function(r){
      el('kwSyncBtn').disabled = false;
      if (!r.ok){ sayKw('拉取失败：' + (r.body && r.body.error || '未知错误')); return }
      var b = r.body;
      sayKw('✓ ' + (b.keywords || []).length + ' 个词：ABA ' + b.abaRows + ' 行 / 需求 ' + b.demandRows + ' 行'
        + ' · ' + (b.cached ? '复用缓存 0 点' : (b.cost + ' 点'))
        + (b.errors && b.errors.length ? (' · 失败 ' + b.errors.join('; ')) : ''));
      renderKeywords(b.library || []);
      loadBoard();
    }).catch(function(e){ el('kwSyncBtn').disabled = false; sayKw('拉取失败：' + e.message) });
  });

  // ── 竞品 ────────────────────────────────────────────────
  el('compBtn').addEventListener('click', function(){
    var keyword = el('compKeyword').value.trim();
    if (!keyword){ el('compOut').textContent = '先填一个关键词'; return }
    el('compBtn').disabled = true;
    el('compOut').textContent = '分析中（2 点）…';
    postJSON('/competition', { keyword: keyword }).then(function(r){
      el('compBtn').disabled = false;
      if (!r.ok){ el('compOut').textContent = '分析失败：' + (r.body && r.body.error || '未知错误'); return }
      var b = r.body, s = b.structure || {};
      el('compOut').textContent = '✓ ' + b.keyword + ' · ' + (b.cached ? '复用缓存 0 点' : (b.cost + ' 点'))
        + '\\n覆盖 ' + (s.visibleAsinCount || '—') + ' 个 ASIN · 集中度 ' + (s.concentrationLevel || '—')
        + ' · 模式 ' + (s.competitionMode || '—')
        + '\\nTop3 点击 ' + pctf(s.top3ClickShare) + ' / Top3 转化 ' + pctf(s.top3ConversionShare)
        + (s.divergence ? (' · 背离 ' + s.divergence) : '')
        + (s.divergenceInsight ? ('\\n' + s.divergenceInsight) : '')
        + (s.leaderNote ? ('\\n' + s.leaderNote) : '');
      var rows = b.competitors || [];
      el('compList').innerHTML = rows.length
        ? ('<div style="grid-column:1 / span 2">' + rows.slice(0, 12).map(function(c){
            return '<div style="border-top:1px solid var(--line);padding:5px 0"><b>' + c.asin + '</b> <span style="color:var(--muted)">' + (c.price != null ? '$' + c.price : '—') + '</span></div>';
          }).join('') + '</div>')
        : '<div>（没有竞品数据）</div>';
    }).catch(function(e){ el('compBtn').disabled = false; el('compOut').textContent = '分析失败：' + e.message });
  });

  // ── 今日待办 + 数据健康 ─────────────────────────────────
  function renderActions(list){
    var box = el('todoCard');
    if (!list || !list.length){ box.textContent = '（没有待办）'; return }
    var html = '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px"><b>今日待办</b>'
      + '<span style="color:var(--muted);font-size:12px">按影响面排序，不是按时间</span></div>';
    list.slice(0, 5).forEach(function(a, i){
      var color = a.priority >= 6 ? 'var(--err)' : (a.priority >= 3 ? 'var(--warn)' : 'var(--muted)');
      html += '<div style="border-top:1px solid var(--line);padding:8px 0">'
        + '<span class="tag" style="border-color:' + color + ';color:' + color + '">' + (i + 1) + ' · ' + a.verb + '</span> '
        + '<b>' + a.title + '</b>'
        + (a.detail ? '<div style="color:var(--muted);font-size:12px;margin-top:3px">依据：' + a.detail + '</div>' : '')
        + (a.action ? '<div style="font-size:12px;margin-top:3px">动作：' + a.action + '</div>' : '')
        + '</div>';
    });
    box.innerHTML = html;
  }

  function loadActions(){
    getJSON('/actions').then(function(r){ renderActions(r.actions || []) })
      .catch(function(e){ el('todoCard').textContent = '待办读取失败：' + e.message });
  }

  function renderHealth(h){
    var box = el('healthCard');
    var cov = h.coverage || {};
    function chip(label, value){
      var pctv = Math.round((value || 0) * 100);
      var color = pctv >= 100 ? 'var(--ok)' : (pctv > 0 ? 'var(--warn)' : 'var(--err)');
      return '<span class="tag" style="border-color:' + color + ';color:' + color + '">' + label + ' ' + pctv + '%</span>';
    }
    var html = '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px"><b>数据健康</b>'
      + '<span style="color:var(--muted);font-size:12px">截止 ' + (h.latestData || '—') + ' · 滞后 ' + (h.ageDays === null ? '—' : h.ageDays) + ' 天</span></div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
      + chip('流量', cov.traffic) + chip('关键词', cov.keywords) + chip('销量', cov.sales) + chip('广告', cov.ads)
      + '</div>';
    if (h.gaps && h.gaps.length){
      html += '<div style="color:var(--muted);font-size:12px;margin-top:6px">待补：'
        + h.gaps.map(function(g){ return g.layer + '（' + g.fix + '）' }).join('；') + '</div>';
    } else {
      html += '<div style="color:var(--ok);font-size:12px;margin-top:6px">四层数据齐全，报告可以直接发。</div>';
    }
    box.innerHTML = html;
  }

  function loadHealth(){
    getJSON('/health').then(function(r){ renderHealth(r.health) })
      .catch(function(e){ el('healthCard').textContent = '健康检查失败：' + e.message });
    getJSON('/consistency').then(function(r){
      var c = r.consistency;
      if (!c) return;
      var color = c.mismatches ? 'var(--err)' : 'var(--ok)';
      var box = el('healthCard');
      var div = document.createElement('div');
      div.style.cssText = 'margin-top:6px;font-size:12px;color:' + color;
      div.textContent = '对账：' + c.verdict;
      box.appendChild(div);
    }).catch(function(){});
  }

  function exportCsv(kind){
    sayKw('导出中…');
    getJSON('/export?kind=' + encodeURIComponent(kind)).then(function(r){
      if (!r.ok){ sayKw('导出失败：' + (r.error || '未知错误')); return }
      sayKw('✓ 已导出 ' + r.rows + ' 行 → ' + r.file + '（带 BOM，Excel 直接打开）');
    }).catch(function(e){ sayKw('导出失败：' + e.message) });
  }

  el('exportKw').addEventListener('click', function(){ exportCsv('keywords') });
  el('exportTraffic').addEventListener('click', function(){ exportCsv('traffic') });

  // ── Listing 诊断 ────────────────────────────────────────
  var auditOut = el('auditOut');
  function sayAudit(t){ auditOut.textContent = typeof t === 'string' ? t : JSON.stringify(t, null, 2) }

  function renderAudit(a, reportId, file){
    var box = el('auditList');
    if (!a){ box.innerHTML = '<div>（没有诊断结果）</div>'; return }
    var color = a.score >= 80 ? 'var(--ok)' : (a.score >= 60 ? 'var(--warn)' : 'var(--err)');
    var html = '<div style="grid-column:1 / span 2;display:flex;gap:12px;align-items:baseline;margin-bottom:8px">'
      + '<span style="font-size:22px;font-weight:600;color:' + color + '">' + a.score + '</span>'
      + '<span style="color:var(--muted);font-size:12px">/100 · 高 ' + a.counts.high + ' · 中 ' + a.counts.medium + ' · 低 ' + a.counts.low + ' · 无来源 ' + a.counts.nodata + '</span>'
      + (reportId ? '<span style="margin-left:auto;color:var(--muted);font-size:12px">报告 #' + reportId + '</span>' : '')
      + '</div>';
    a.sections.forEach(function(s){
      var c = s.status === 'fail' ? 'var(--err)' : (s.status === 'warn' ? 'var(--warn)' : (s.status === 'nodata' ? 'var(--muted)' : 'var(--ok)'));
      var label = { ok:'通过', warn:'待优化', fail:'不合格', nodata:'无数据来源' }[s.status] || s.status;
      html += '<div style="grid-column:1 / span 2;border-top:1px solid var(--line);padding:6px 0">'
        + '<span class="tag" style="border-color:' + c + ';color:' + c + '">' + label + '</span> '
        + '<b>' + s.name + '</b>'
        + (s.findings && s.findings.length ? '<div style="color:var(--muted);font-size:12px;margin-top:2px">'
            + s.findings.slice(0,2).map(function(f){ return '[' + f.severity + '] ' + f.issue }).join('；') + '</div>' : '')
        + '</div>';
    });
    if (file) html += '<div style="grid-column:1 / span 2;color:var(--muted);font-size:12px;margin-top:6px">文件：' + file + '</div>';
    box.innerHTML = html;
  }

  el('auditBtn').addEventListener('click', function(){
    el('auditBtn').disabled = true;
    sayAudit('诊断中（读本地文案 + 词库 + 竞品价格，0 点）…');
    postJSON('/listing/audit', {}).then(function(res){
      el('auditBtn').disabled = false;
      if (!res.ok){ sayAudit('诊断失败：' + (res.body && res.body.error || '未知错误')); return }
      var b = res.body;
      sayAudit('✓ 诊断完成：' + b.audit.score + '/100 · 报告 #' + b.id + '\\n文件：' + b.file
        + '\\n\\n' + (b.markdown || '').slice(0, 900) + '\\n…（完整报告已写文件与库）');
      renderAudit(b.audit, b.id, b.file);
    }).catch(function(e){ el('auditBtn').disabled = false; sayAudit('诊断失败：' + e.message) });
  });

  el('auditShow').addEventListener('click', function(){
    getJSON('/listing/audit').then(function(r){
      if (!r.ok || !r.audit){ sayAudit('还没有诊断结果，先点「生成深度诊断」'); return }
      sayAudit('已有诊断 #' + r.audit.id + ' · 生成于 ' + String(r.audit.generated_at).slice(0,16).replace('T',' ') + ' · 分数 ' + r.audit.score);
    }).catch(function(e){ sayAudit('读取失败：' + e.message) });
  });

  el('draftBtn').addEventListener('click', function(){
    el('draftBtn').disabled = true;
    sayAudit('生成改稿草稿并复测（本地规则，0 点）…');
    postJSON('/listing/draft', {}).then(function(res){
      el('draftBtn').disabled = false;
      if (!res.ok){ sayAudit('生成失败：' + (res.body && res.body.error || '未知错误')); return }
      var b = res.body;
      var head = '✓ 草稿完成：# ' + b.id + ' · 复测 ' + b.diff.scoreBefore + ' → ' + b.diff.scoreAfter
        + '（' + (b.diff.delta >= 0 ? '+' : '') + b.diff.delta + '）\\n文件：' + b.file + '\\n\\n'
        + '【标题】' + b.draft.title + '\\n\\n【亮点】' + b.draft.itemHighlights + '\\n\\n【五点】\\n'
        + b.draft.bullets.map(function(t, i){ return (i+1) + '. ' + t.slice(0, 90) + (t.length > 90 ? '…' : '') }).join('\\n')
        + '\\n\\n【后台词】' + (b.draft.searchTerms || '（无需补充）')
        + '\\n\\n完整草稿见文件与库（含属性表、复测变化、人工必改项）';
      sayAudit(head);
      renderAudit(b.after, b.id, b.file);
    }).catch(function(e){ el('draftBtn').disabled = false; sayAudit('生成失败：' + e.message) });
  });

  // ── 素材补录 ────────────────────────────────────────────
  function loadAssets(){
    getJSON('/listing/assets').then(function(r){
      if (!r.ok) return;
      var a = r.assets || {};
      el('assetImages').value = a.imagesTotal == null ? '' : a.imagesTotal;
      el('assetWhite').value = a.hasWhiteBg == null ? '' : (a.hasWhiteBg ? '1' : '0');
      el('assetPx').value = a.minPxOk == null ? '' : (a.minPxOk ? '1' : '0');
      el('assetVideo').value = a.hasVideo == null ? '' : (a.hasVideo ? '1' : '0');
      el('assetAplus').value = a.aplus == null ? '' : (a.aplus ? '1' : '0');
      el('assetThemes').value = a.reviewThemes || '';
      if (r.amazonOps && r.amazonOps.found){
        el('assetOut').textContent = '提示：amazon-ops 已采到这个 ASIN 的 listing（' + (r.amazonOps.updatedAt || '') + '），诊断会优先用它的文案。';
      }
    }).catch(function(){});
  }

  el('assetSave').addEventListener('click', function(){
    var body = {};
    var images = el('assetImages').value.trim();
    if (images !== '') body.imagesTotal = Number(images);
    var white = el('assetWhite').value, px = el('assetPx').value;
    var video = el('assetVideo').value, aplus = el('assetAplus').value;
    if (white !== '') body.hasWhiteBg = white === '1';
    if (px !== '') body.minPxOk = px === '1';
    if (video !== '') body.hasVideo = video === '1';
    if (aplus !== '') body.aplus = aplus === '1';
    var themes = el('assetThemes').value.trim();
    if (themes) body.reviewThemes = themes;
    postJSON('/listing/assets', body).then(function(res){
      el('assetOut').textContent = res.ok
        ? '✓ 素材已保存；重新点「生成深度诊断」就能看到这三项的真实判定。'
        : ('保存失败：' + (res.body && res.body.error));
    }).catch(function(e){ el('assetOut').textContent = '保存失败：' + e.message });
  });

  el('dailyRun').addEventListener('click', function(){
    el('dailyRun').disabled = true;
    var box = el('dailySteps');
    box.innerHTML = '<div>步骤</div><div>运行中…</div>';
    saySync('一键日更：预算检查 → 同步 → 洞察重算 → 组合总览 → 深度报告');
    postJSON('/daily', { level: el('syncLevel').value, deepTop: 3 }).then(function(res){
      el('dailyRun').disabled = false;
      if (!res.ok){ saySync('失败：' + (res.body && res.body.error || '未知错误')); return }
      var b = res.body;
      var html = '';
      (b.steps || []).forEach(function(s, i){
        var c = s.status === 'ok' ? 'var(--ok)'
          : (s.status === 'failed' ? 'var(--err)' : (s.status === 'blocked' ? 'var(--warn)' : 'var(--muted)'));
        html += '<div><span class="tag" style="border-color:' + c + ';color:' + c + '">' + (i + 1) + ' · ' + s.status + '</span></div>'
             + '<div>' + s.name + '：' + s.detail + '</div>';
      });
      box.innerHTML = html;
      saySync('✓ 完成：扣 ' + (b.cost || 0) + ' 点 · 入库 ' + (b.rows || 0) + ' 行'
        + '\\n组合总览：' + (b.portfolio || '—')
        + ((b.deep && b.deep.length) ? ('\\n深度报告：' + b.deep.map(function(d){ return d.asin + (d.error ? '（失败）' : '') }).join('、')) : ''));
      loadBoard(); loadActions(); loadHealth();
    }).catch(function(e){ el('dailyRun').disabled = false; saySync('失败：' + e.message) });
  });

  el('draftBtn2').addEventListener('click', function(){
    el('draftBtn2').disabled = true;
    sayAudit('第二轮改稿中（收紧五点长度、补数字、加问句锚点）…');
    postJSON('/listing/draft', { round: 2 }).then(function(res){
      el('draftBtn2').disabled = false;
      if (!res.ok){ sayAudit('生成失败：' + (res.body && res.body.error || '未知错误')); return }
      var b = res.body;
      sayAudit('✓ 第二轮草稿 #' + b.id + ' · 复测 ' + b.diff.scoreBefore + ' → ' + b.diff.scoreAfter
        + '（' + (b.diff.delta >= 0 ? '+' : '') + b.diff.delta + '）\\n文件：' + b.file
        + '\\n\\n剩余未通过：' + (b.diff.changed.filter(function(c){ return c.to !== 'ok' }).map(function(c){ return c.name + '(' + c.to + ')' }).join('、') || '无'));
      renderAudit(b.after, b.id, b.file);
    }).catch(function(e){ el('draftBtn2').disabled = false; sayAudit('生成失败：' + e.message) });
  });

  loadObjects();
  loadPlan();
  loadBoard();
  loadInsights();
  loadKeywords();
  loadActions();
  loadHealth();
  loadAssets();

  refresh();
})();
</script>
</body>
</html>`
}
