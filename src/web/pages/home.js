/**
 * 页签「home」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const homeScript = `function renderHome() {
  const data = state.home;
  if (!data) {
    if ($('homedigest') !== null) $('homedigest').innerHTML = '';
    $('homecards').innerHTML = '';
    if ($('homeguide') !== null) $('homeguide').innerHTML = '';
    if ($('homesearch') !== null) $('homesearch').innerHTML = '';
    if ($('homepins') !== null) $('homepins').innerHTML = '';
    if ($('homeactions') !== null) $('homeactions').innerHTML = '';
    if ($('homeHint') !== null) $('homeHint').textContent = '';
    if ($('homerecent') !== null) $('homerecent').innerHTML = '';
    if ($('pinsSummary') !== null) $('pinsSummary').textContent = '收藏与最近访问';
    if ($('recentSummary') !== null) $('recentSummary').textContent = '最近运行与产物';
    return;
  }
  const cards = data.cards || [];
  const ok = cards.filter(card => card.status === 'ok').length;
  const empty = cards.filter(card => card.status === 'empty').length;
  const broken = cards.filter(card => card.status === 'error').length;
  const attention = cards.filter(card => card.status === 'attention').length;
  if ($('homeHint') !== null) {
    $('homeHint').textContent = '六张卡：' + ok + ' 张有数' + (attention > 0 ? '（其中 ' + attention + ' 张要注意）' : '') + '，' + empty + ' 张暂无数据'
      + (broken > 0 ? '，' + broken + ' 张计算失败（其余不受影响）' : '')
      + ' · 作用域：' + (state.context && state.context.scopeText ? state.context.scopeText : '—')
      + ' · 在架口径（已归档 ASIN 不计入分母）';
  }

  /* 跳步的后果写在它咬人的地方：六张卡一张都没数、而引导还有步骤没做完时，
     这块自己说清是哪一步没做。只画一个「暂无数据」的话，「跳过了一步」和
     「真的没有数据」会写成同一句话，而这两件事要做的下一件事不一样。
     句子和「什么时候显示」都在 domain 里算好（emptyCardsNote），页面只负责印。 */
  const guideNote = data.cardsNote || null;

  /* T75 ①：一句话摘要。目标容器是页首的 homedigest（page.js 里就在搜索框之上、
     待办之前）—— **摘要属于页首，不属于卡片区**：卡片区是数据，摘要是指挥部。
     数字全部来自载荷（digest.total / digest.shown / digest.cardsNote），页面
     一个数都不算 —— 页面一算，「今天有 3 件事」和下面待办区的条数就会各说一句。 */
  if ($('homedigest') !== null) $('homedigest').innerHTML = renderDigest(data.digest);

  $('homecards').innerHTML = (guideNote === null
    ? ''
    : '<div class="hint" id="homeCardsCause" style="color:var(--warn)">' + escapeHtml(guideNote) + '</div>')
    + '<div class="cards">' + cards.map(card => {
    const cls = card.status === 'error' ? 'stop' : card.status === 'attention' ? 'warn' : card.status === 'empty' ? '' : 'ok';
    const ratio = card.denominator === null || card.denominator === undefined
      ? ''
      : '<span class="opt-meta">' + card.numerator + ' / ' + card.denominator + '</span>';
    const foot = [
      card.threshold === null || card.threshold === undefined ? '' : '阈值 ' + card.threshold,
      card.updatedAt === null || card.updatedAt === undefined ? '更新时间未记录' : '更新于 ' + String(card.updatedAt).slice(0, 16).replace('T', ' '),
    ].filter(part => part !== '').join(' · ');
    /* 每张卡都带上它自己那一页的入口。「detailLink」是 health.js 算好的（这张卡说的是
       哪个模块的事，链接就指哪里），页面**只消费、不推导**：在这里再推一次就是第二份
       真相，而两份真相的对不上是这张卡最容易出的错。
       跟着走的筛选参数是这张卡**分母所用的作用域**（站点）：卡上写「3/10 个 ASIN 在
       US」，跳过去看的却是全站，同一个卡片会变成另一个数字 —— 读者只能得出卡片在
       说谎的结论。作用域是「全部站点」时不带参数：「__all__」是作用域自己的词，不是
       一个站点代码，传过去会被当成一个叫「__all__」的站去查。
       出错的那张卡**也带链接**：它算不出来，但它仍然是「关于某个模块」的一张卡；
       一张卡失败不能让另外五张的入口跟着消失（§32 单模块失败不拖垮）。 */
    const detail = card.detailLink === null || card.detailLink === undefined ? null : String(card.detailLink);
    const filters = detail === null ? null : cardScopeFilters();
    return '<div class="card"'
      + (detail === null
        ? ''
        : ' data-link="' + escapeHtml(detail) + '" data-filters="' + escapeHtml(JSON.stringify(filters)) + '"')
      + '>'
      + '<div class="cardhead"><span>' + escapeHtml(card.label) + '</span>'
        + '<span class="chip ' + cls + '">'
        + (card.status === 'error' ? '计算失败' : card.status === 'attention' ? '注意' : card.status === 'empty' ? '暂无数据' : '正常') + '</span></div>'
      + '<div class="cardbody">' + escapeHtml(String(card.conclusion)) + '</div>'
      /* P2-2：趋势那句由服务端的 describeTrend 算好（唯一一份措辞），这里只显示。
         没有趋势文案时什么都不画 —— 不画「→ 持平」来代替「不知道」。 */
      + (() => {
        const t = (Array.isArray(data.trendTexts) ? data.trendTexts : []).find(row => row.id === card.id);
        if (!t || !t.text) return '';
        const cls2 = t.direction === 'up' ? 'ok' : (t.direction === 'down' ? 'warn' : '');
        /* 一行只留「趋势：不知道」或「趋势：↑ 3 → 5（…）」这种可扫的结论；那串
           「为什么不知道」的推理放 title。它是给第一次读的人的解释，不是每天扫
           六个卡片的人要看的东西 —— 实测这一格在 275px 宽的卡里占 96px，
           六张卡加起来比整个待办区还高。 */
        return '<div class="opt-meta' + (cls2 ? ' ' + cls2 : '') + '" title="'
          + escapeHtml(String(t.text)) + '">' + escapeHtml(String(t.text).split(' —— ')[0]) + '</div>';
      })()
      + '<div class="cardfoot" title="来源：' + escapeHtml(String(card.source || '')) + '">' + ratio
      + '<span class="opt-meta">' + escapeHtml(foot) + '</span></div>'
      + (card.status === 'error'
        ? '<div class="opt-meta" style="color:var(--stop)">' + escapeHtml(String(card.error || '')) + '</div>'
        : '')
      + (detail === null ? '' : '<div class="cardgo">打开 ' + escapeHtml(moduleLabelOf(detail)) + ' →</div>')
      + '</div>';
  }).join('') + '</div>';

  /* 点整张卡跳过去，参数是卡自己的作用域。走的还是待办与最近运行那一条导航
     （followTodo 解析 '#module#anchor' 并把 filters 并进同一只袋子），所以这里没有
     第二套跳转机制。 */
  for (const tile of $('homecards').querySelectorAll('.card[data-link]')) {
    tile.onclick = () => {
      let filters = {};
      try { filters = JSON.parse(tile.dataset.filters || '{}'); } catch { filters = {}; }
      followTodo(tile.dataset.link, filters);
    };
  }
  /* 摘要里的每一条也是入口，走同一条导航（摘要在 homedigest）。 */
  if ($('homedigest') !== null) {
    for (const row of $('homedigest').querySelectorAll('.digest-item[data-link]')) {
      row.onclick = () => {
        let filters = {};
        try { filters = JSON.parse(row.dataset.filters || '{}'); } catch { filters = {}; }
        followTodo(row.dataset.link, filters);
      };
    }
  }

  if ($('homeReload') !== null) $('homeReload').onclick = () => { refresh().catch(() => {}); };
  renderSearch();
  renderPins();
  renderGuide();
  renderQuickActions();
  renderTodos();
  renderRecent();
}

/* 'open #asin →' 里的 #asin 是模块 id，不是给人看的词。导航注册表里有标签，
   就印标签；查不到（比如以后加的模块还没注册）才退回 id —— 那时至少还是真的。 */
function moduleLabelOf(link) {
  const module = String(link || '').replace(/^#/, '').split('#')[0];
  const group = GROUPS.filter(candidate => candidate.modules.some(entry => entry.id === module))[0];
  const entry = group ? group.modules.filter(candidate => candidate.id === module)[0] : null;
  return entry ? String(entry.label) : module;
}

/* 卡片链接带的作用域参数。

   只带**站点**：卡片的分母就是按它缩小的（health.js 的 marketClause），而 filters 里
   别的键（limit / order / q）说的是「用户自己在看什么」，一张卡没有资格覆盖它们。
   「__all__」不往下传 —— 它是作用域表示「每个站点」的那个词，不是站点代码；当过滤器用
   会去查一个叫「__all__」的站点，结果是零行，而那正是「全部站点」的反面。 */
function cardScopeFilters() {
  const scope = (state.context && state.context.scope) || {};
  const marketplace = String(scope.marketplace || '').trim();
  if (marketplace === '' || marketplace === SCOPE_ALL) return {};
  return { marketplace };
}

/* 首次使用引导 — 三步，状态来自事实。
 *
 * 三步都画，且状态三分（已完成 / 当前 / 未开始）：只显示「1 / 3」会说出走了多远，
 * 说不出当前是哪一步。可以跳步 —— 没做完的每一步都带一个「去做」的链接，直接跳到
 * 那一步所在的模块；跳步的后果写在页脚和健康卡自己的空态里，不是写在别处让人猜。
 *
 * 收起是一次真实写入（setting 键），走已有的 setting-set 路由：它本来就是一次
 * 设置写入，审计里记的也是同一条 setting.set，不需要第二套写入口。
 *
/* 收藏与最近访问（F01-09）。

   两条列表分开画，因为它们是两个问题：收藏是「我说这个重要」，最近访问是
   「我最近看过什么」。合并成一条会丢掉信息 —— 取消收藏不该删掉一次真的发生过的
   访问。

   每一行带着 module 和 id（服务端给），所以「回到那里」不需要页面再猜；这也是它
   能被一键回跳的原因。星标切换走 pin-toggle，回跳本身走 recent-push 记一笔。

   NB: no backticks in this comment — it sits inside the script string. */
function renderPins() {
  const box = $('homepins');
  if (box === null) return;
  const pins = state.home ? state.home.pins : null;
  if (!pins) {
    box.innerHTML = '';
    return;
  }

  const row = (entry, starred) => '<div class="notifrow">'
    + '<span class="chip">' + escapeHtml(entry.module) + '</span>'
    + '<span style="flex:1">' + escapeHtml(entry.label)
    + '<div class="notifmeta">' + escapeHtml(entry.id) + '</div></span>'
    + '<button data-pingoto="' + escapeHtml(entry.module + '|' + entry.id) + '">回到这里</button>'
    + '<button data-pinstar="' + escapeHtml(entry.module + '|' + entry.id) + '"'
    + ' title="' + (starred ? '取消收藏' : '收藏') + '">' + (starred ? '★' : '☆') + '</button>'
    + '</div>';

  const favourites = Array.isArray(pins.favorites) ? pins.favorites : [];
  const recent = Array.isArray(pins.recent) ? pins.recent : [];
  const marked = new Set(Array.isArray(pins.recentFavourited) ? pins.recentFavourited : []);

  /* 折叠标题上说出条数：收起之后仍然知道里面有多少东西，不用点开才知道。 */
  if ($('pinsSummary') !== null) {
    $('pinsSummary').textContent = '收藏与最近访问 —— 收藏 ' + favourites.length
      + ' · 最近访问 ' + recent.length;
  }

  if (favourites.length === 0 && recent.length === 0) {
    box.innerHTML = '<div class="hint">还没有收藏，也没有访问记录。从搜索或其它列表里点进一个对象，'
      + '它就会出现在这里；星标一下才会留下。</div>';
    return;
  }

  box.innerHTML = (favourites.length === 0
    ? '<div class="hint">还没有收藏。下面这些是最近访问。</div>'
    : '<div class="rule-sect">收藏（' + favourites.length + '）</div>'
      + favourites.map(entry => row(entry, true)).join(''))
    + (recent.length === 0
      ? ''
      : '<div class="rule-sect">最近访问（最新 ' + String(pins.maxRecent) + ' 条，按对象去重）</div>'
        + recent.map(entry => row(entry, marked.has(entry.module + ':' + entry.id))).join(''));

  for (const button of box.querySelectorAll('[data-pingoto]')) {
    button.onclick = () => {
      const parts = String(button.dataset.pingoto).split('|');
      goToPin(parts[0], parts.slice(1).join('|'));
    };
  }
  for (const button of box.querySelectorAll('[data-pinstar]')) {
    button.onclick = () => {
      const parts = String(button.dataset.pinstar).split('|');
      const module = parts[0];
      const id = parts.slice(1).join('|');
      api('pin-toggle', { method: 'POST', body: JSON.stringify({ module, id, label: id }) })
        .then(refresh)
        .catch(showPageError);
    };
  }
}

/* 回到收藏/最近访问里的那一条：切模块，并且**记一笔访问** —— 走这条路本身也是
   一次访问，不记的话「最近访问」会停在用户最后一次从别处点进来的时刻。 */
function goToPin(module, id) {
  if (!module || !id) return;
  patchContext({ module, filters: { ...state.filters } });
  api('recent-push', { method: 'POST', body: JSON.stringify({ module, id, label: id }) })
    .catch(() => {});
}

/* 通知中心（F01-07）。铃在顶栏，面板是一层浮层 —— 不是第 15 个模块（见 CSS 注释：
   模块列表是导航，未读数是每一页都要能看见的一个数）。

   面板开合走 filters.notificationsOpen，与别的面板同一个道理：要活过一次 state
   重读，而且「开着」这件事只有一处存。

   「查看」跳的是 link，不是 objectId：link 是**产通知的人**给的落点，他才知道该去哪
   （schema 里没有 marketplace，页面手上也没有库，在这里按 objectId 拼一个精确锚点
   只能靠猜）。objectId 仍然显示在行里，因为读者要知道这条讲的是谁。 */
function renderNotifications() {
  const bell = $('notifbell');
  const box = $('notifpanel');
  if (bell === null || box === null) return;

  const data = state.notifications;
  const open = String((state.filters || {}).notificationsOpen || '') === '1';
  const unread = data && typeof data.unread === 'number' ? data.unread : 0;

  /* 未读为 0 时不写「0」：一个永远显示 0 的徽标会训练人忽略它。 */
  const label = $('notifcount');
  if (label !== null) label.textContent = unread === 0 ? '' : String(unread);
  bell.className = unread > 0 ? 'has-unread' : '';
  bell.setAttribute('aria-expanded', open ? 'true' : 'false');
  bell.onclick = () => {
    const next = { ...state.filters };
    if (open) delete next.notificationsOpen;
    else next.notificationsOpen = '1';
    patchContext({ filters: next });
  };

  if (!open) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;

  if (!data) {
    box.innerHTML = '<div class="hint">通知还没就绪。</div>';
    return;
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const kinds = Array.isArray(data.counts) ? data.counts : [];
  const activeKind = String((data.filters || {}).kind || '');

  const chips = kinds.map(entry =>
    '<button class="qtab" data-notifkind="' + escapeHtml(entry.kind) + '" aria-selected="'
    + (entry.kind === activeKind ? 'true' : 'false') + '">'
    + escapeHtml(entry.kind) + ' ' + String(entry.total)
    + (entry.unread > 0 ? '（未读 ' + String(entry.unread) + '）' : '')
    + '</button>').join('');

  const list = rows.map(row =>
    '<div class="notifrow' + (row.unread ? ' unread' : '') + '">'
    + '<span class="chip' + (row.severity === 'block' ? ' stop' : (row.severity === 'warn' ? ' warn' : '')) + '">'
    + escapeHtml(String(row.severity || row.kind)) + '</span>'
    + '<span style="flex:1">' + escapeHtml(String(row.title))
    + (row.count > 1 ? ' <span class="notifmeta">×' + String(row.count) + '</span>' : '')
    + (row.body ? '<div class="notifmeta">' + escapeHtml(String(row.body)) + '</div>' : '')
    + (row.objectId ? '<div class="notifmeta">对象：' + escapeHtml(String(row.objectId)) + '</div>' : '')
    + '</span>'
    + '<span class="notifmeta">' + escapeHtml(shortTime(row.createdAt)) + '</span>'
    + (row.unread ? '<button data-notifread="' + escapeHtml(row.id) + '">已读</button>' : '')
    + (row.link ? '<button data-notifgo="' + escapeHtml(row.id) + '">查看</button>' : '')
    + '</div>').join('');

  const clears = kinds.map(entry =>
    '<button class="qtab" data-notifclear="' + escapeHtml(entry.kind) + '">清理「'
    + escapeHtml(entry.kind) + '」</button>').join('');

  box.innerHTML = '<div class="bar"><strong style="font-size:12px">通知</strong>'
    + '<span class="notifmeta">保留 ' + String(data.keepDays) + ' 天 · 未读 ' + String(data.unread) + '</span>'
    + '<button id="notifReadAll" style="margin-left:auto">全部已读</button></div>'
    + (kinds.length === 0 ? '' : '<div class="qtabs">' + chips + '</div>')
    + (rows.length === 0
      /* 这是「读到了、这一类确实是 0」，不是「功能没开」—— 用 none 而不是 not-recorded：
         not-recorded 说的是「还没记录过，可以去产生」，而这里的意思恰恰是「已经查过，没有」。 */
      ? emptyState('none', {
        subject: '这一类通知',
        reason: '这一类现在没有通知。不是「通知功能没开」—— 是这一类确实没有。',
      })
      : list)
    + (clears === '' ? '' : '<div class="qtabs" style="padding-top:8px">' + clears + '</div>');

  if ($('notifReadAll') !== null) $('notifReadAll').onclick = () => postNotification('notification-read-all', {});
  for (const button of box.querySelectorAll('[data-notifread]')) {
    button.onclick = () => postNotification('notification-read', { id: button.dataset.notifread });
  }
  for (const button of box.querySelectorAll('[data-notifclear]')) {
    button.onclick = () => postNotification('notification-clear', { kind: button.dataset.notifclear });
  }
  for (const button of box.querySelectorAll('[data-notifkind]')) {
    button.onclick = () => {
      const next = { ...state.filters, notificationsOpen: '1' };
      if (button.dataset.notifkind === activeKind) delete next.notificationKind;
      else next.notificationKind = button.dataset.notifkind;
      patchContext({ filters: next });
    };
  }
  for (const button of box.querySelectorAll('[data-notifgo]')) {
    button.onclick = () => {
      const row = rows.find(entry => entry.id === button.dataset.notifgo);
      if (row === undefined) return;
      const hash = String(row.link || '');
      const patch = {};
      /* link 形如 '#quality' 或 '#pipeline#inbox' —— 取第一段做模块，其余留给
         anchor 机制（S1-B13.1 已把 scrollToSection 接到 filters.anchor 上）。 */
      if (hash.startsWith('#')) {
        const parts = hash.slice(1).split('#');
        if (parts[0] !== '') patch.module = parts[0];
        if (parts.length > 1 && parts[1] !== '') {
          patch.filters = { ...state.filters, anchor: parts[1] };
        }
      }
      patchContext(patch);
    };
  }
}

async function postNotification(route, body) {
  try {
    await api(route, { method: 'POST', body: JSON.stringify(body) });
    await refresh();
  } catch (error) {
    showPageError(error);
  }
}

/* 全局搜索 — 一个框，一次查十类（F01-06）。

   每一行由服务端带上它该去的模块、要并进上下文的选择、以及要并进 filters 的键，
   所以这里不复制任何「哪类去哪」的映射：页面脚本没有模块系统，在这里再写一份就是
   两份会漂的真相，而漂的那天会把一条关键词结果送进 ASIN 面板。

   SKU 明说查不到，并说清为什么（上架时人工指定、采集不到、库里没有这一列）。
   「没搜到」和「我们从来不查这个」是两句话，留白会让人以为是前一句。

   NB: no backticks in this comment — it sits inside the script string. */
function renderSearch() {
  const box = $('homesearch');
  if (box === null) return;
  /* Truthiness, not a null check: a payload built before this batch has no
     search key at all, and undefined is not the same value as the null the
     server sends for "nothing typed". Checking only for null let the
     missing-slice case through to data.groups, which is how a page that works
     on the server it was written against breaks on an older one.
     NB: no backticks in this comment — it sits inside the script string. */
  const data = state.home && state.home.search ? state.home.search : null;
  const input = $('globalsearch');

  if (input !== null) {
    const wanted = String((state.filters || {}).searchQuery || '');
    /* Do not fight the user's cursor: only overwrite the box when the query
       changed underneath them (a re-read, a back button). */
    if (document.activeElement !== input && input.value !== wanted) input.value = wanted;
    input.onkeydown = event => { if (event.key === 'Enter') runGlobalSearch(); };
  }
  if ($('globalsearchGo') !== null) $('globalsearchGo').onclick = () => runGlobalSearch();

  if (data === null) {
    box.innerHTML = '<div class="hint">输入后回车：一次查十类实体，结果按类型分组，每行带站点与状态。'
      + '点一行会把它选进全局上下文，并跳到它所在的模块。</div>';
    return;
  }

  const rows = [];
  const blocks = data.groups.filter(group => group.rows.length > 0).map(group => {
    const body = group.rows.map(row => {
      const index = rows.push(row) - 1;
      return '<tr data-searchrow="' + index + '">'
        + '<td><code>' + escapeHtml(String(row.title || '')) + '</code></td>'
        + '<td>' + escapeHtml(String(row.subtitle || '')) + '</td>'
        + '<td>' + escapeHtml(String(row.site || '—')) + '</td>'
        + '<td>' + escapeHtml(String(row.status || '')) + '</td>'
        + '<td>' + (row.select ? '可选中' : '<span class="opt-meta">仅跳转</span>') + '</td>'
        + '</tr>';
    }).join('');
    return '<div class="rule-sect">' + escapeHtml(group.label) + '（' + group.rows.length + '）</div>'
      + '<table><thead><tr><th>名称</th><th>说明</th><th>站点</th><th>状态</th><th></th></tr></thead>'
      + '<tbody>' + body + '</tbody></table>';
  }).join('');

  const head = '<div class="hint">「' + escapeHtml(data.query) + '」在 ' + String(data.searchedKinds)
    + ' 类里找到 ' + String(data.total) + ' 条，分布在 ' + String(data.matchedKinds) + ' 类。</div>';

  /* Three different kinds of nothing, said three different ways. A blank space
     would read as the first one whichever it is. */
  const none = data.groups.filter(group => group.available && group.failed === null && group.rows.length === 0);
  const broke = data.groups.filter(group => group.failed !== null);
  const blind = data.groups.filter(group => !group.available);

  let foot = '';
  if (data.total === 0) {
    foot += emptyState('filtered', {
      subject: '这十类能检索的字段',
      reason: '这类都没有匹配。不是「库里是空的」—— 是这十类能检索的字段里都没有这段文字。',
      next: '换一个词，或者先在库里确认这些实体确实存在。',
    });
  } else if (none.length > 0) {
    foot += '<div class="hint">这几类没有匹配：' + escapeHtml(none.map(group => group.label).join(' / ')) + '。</div>';
  }
  if (broke.length > 0) {
    foot += '<div class="hint" style="color:var(--warn)">这几类查不动（不是没有匹配）：'
      + escapeHtml(broke.map(group => group.label + '：' + group.failed).join('；')) + '</div>';
  }
  if (blind.length > 0) {
    foot += '<div class="hint">查不到的：'
      + escapeHtml(blind.map(group => group.label + '（' + group.reason + '）').join('；')) + '</div>';
  }

  box.innerHTML = head + blocks + foot;

  for (const tr of box.querySelectorAll('tr[data-searchrow]')) {
    const row = rows[Number(tr.dataset.searchrow)];
    if (row === undefined) continue;
    tr.onclick = () => goToSearchResult(row);
  }
}

function runGlobalSearch() {
  const input = $('globalsearch');
  const value = input === null ? '' : String(input.value || '').trim();
  patchContext({ filters: { ...state.filters, searchQuery: value } });
}

/* 点一条结果：选进全局上下文，并跳到它所在的模块。

   搜索词本身**不留在 filters 里** —— 它是找东西的工具，不是范围。留着它会让离开
   搜索之后每次 state 轮询都重跑十类扫描，而且下次回到首页看到的是上次的结果，像
   是刚搜过。 */
function goToSearchResult(row) {
  const patch = {};
  if (row.module) patch.module = row.module;
  const next = { ...state.filters };
  delete next.searchQuery;
  if (row.filters) Object.assign(next, row.filters);
  patch.filters = next;
  if (row.select) patch.selection = mergeSearchSelection(row.select);
  /* 从搜索结果点进去也是一次访问。记在**这里**而不是在 renderSearch 里，因为
     「点进一个对象」这件事发生在跳转动作上，和它从哪个列表跳的无关。 */
  if (row.module && row.id) {
    api('recent-push', {
      method: 'POST',
      body: JSON.stringify({ module: row.module, id: row.id, label: row.title || row.id }),
    }).catch(() => {});
  }
  patchContext(patch);
}

/* 选中是**并进**已有选择，不是替换：搜到一条 ASIN 就把用户之前选的清掉，等于用
   搜索框偷偷改了作用域。上限与 workbench 侧一致（50 / 50 / 20）。 */
function mergeSearchSelection(choice) {
  const current = state.context && state.context.selection ? state.context.selection : {};
  const asins = Array.isArray(current.asins) ? current.asins.map(entry => ({ ...entry })) : [];
  const keywords = Array.isArray(current.keywords) ? current.keywords.map(entry => ({ ...entry })) : [];
  const sets = Array.isArray(current.competitorSets) ? current.competitorSets.slice() : [];

  if (choice.kind === 'asin') {
    if (!asins.some(entry => entry.asin === choice.asin && entry.marketplace === choice.marketplace)) {
      asins.unshift({ asin: choice.asin, marketplace: choice.marketplace });
    }
  } else if (choice.kind === 'keyword') {
    if (!keywords.some(entry => entry.keyword === choice.keyword && entry.marketplace === choice.marketplace)) {
      keywords.unshift({ keyword: choice.keyword, marketplace: choice.marketplace });
    }
  } else if (choice.kind === 'competitor_set') {
    if (sets.indexOf(choice.id) === -1) sets.unshift(choice.id);
  }
  return { asins: asins.slice(0, 50), keywords: keywords.slice(0, 50), competitorSets: sets.slice(0, 20) };
}

/*
 * 收起后这一块整个不画 —— 没有标题、没有空壳，因为「引导已经收起了」不是一条内容。 */
function renderGuide() {
  const guide = state.home ? state.home.onboarding : null;
  if (!guide || guide.dismissed === true) {
    if ($('homeguide') !== null) $('homeguide').innerHTML = '';
    return;
  }

  const current = guide.steps.filter(step => step.state === 'current')[0] || null;
  const badge = guide.complete
    ? '<span class="chip ok">三步都完成</span>'
    : '<span class="chip">第 ' + (guide.steps.indexOf(current) + 1) + ' 步进行中</span>';

  const rows = guide.steps.map((step, index) => {
    const cls = step.state === 'done' ? 'ok' : (step.state === 'current' ? 'run' : '');
    const node = step.state === 'done' ? '✓' : String(index + 1);
    const go = step.done || step.module === null
      ? ''
      : '<button class="actgo" data-gostep="' + escapeHtml(step.module) + '">去做</button>';
    return '<div class="gstep" data-step="' + escapeHtml(step.id) + '">'
      + '<span class="chip ' + cls + '">' + node + '</span>'
      + '<span class="gname">' + escapeHtml(step.label) + '</span>'
      + '<span class="opt-meta">' + escapeHtml(step.state === 'done' ? step.fact : '还差：' + step.fact) + '</span>'
      + go
      + '</div>';
  }).join('');

  /* 跳步的后果写在按钮旁边，因为那正是要按下它的地方。 */
  const footer = guide.complete
    ? '<span class="hint">三步都做完了。收起后不再出现。</span>'
    : '<span class="hint">跳步后果：六张卡会继续显示空态，空态里会写明是因为缺了哪一步。</span>';
  const button = '<button id="guideDismiss" style="margin-left:auto">'
    + (guide.complete ? '收起引导' : '跳过引导') + '</button>';

  $('homeguide').innerHTML = '<div class="card" id="guideCard">'
    + '<div class="cardhead"><span>首次使用引导</span>' + badge + '</div>'
    + '<div class="stepper">' + rows + '</div>'
    + '<div class="bar" style="border-top:1px solid var(--line)">' + footer + button + '</div>'
    + '</div>';

  for (const tile of $('homeguide').querySelectorAll('button[data-gostep]')) {
    tile.onclick = () => patchContext({ module: tile.dataset.gostep, filters: { ...state.filters } });
  }
  if ($('guideDismiss') !== null) $('guideDismiss').onclick = () => dismissGuide();
}

/* 收起引导：写 setting 键。写的是**时间**而不是 true —— 「收起了」和「哪天收起的」
   存的代价一样，而一个月后只有后者还读得出来。 */
function dismissGuide() {
  saveSetting(DISMISS_SETTING_KEY, new Date().toISOString()).catch(() => {});
}

/* 快捷动作 — 六个入口，每个都写明落到哪。
 *
 * 落地目标文案**从 target 里算出来**（describeActionTarget），和点击用的是同一个
 * 对象：文案写「去设置」而跳转写 #keywords 这种漂移，只有两处各写一遍才会发生。
 * 所以这里没有第二份目的地的文字 —— 模块名从导航注册表（GROUPS）取，模块不存在时
 * 才用 target 自带的 moduleLabel（没有注册表可查，只能自带）。
 *
 * 未接入的动作不画成可点的：一个点了会去别处的入口，比一个说清自己没地方的入口更糟。 */
function renderQuickActions() {
  const actions = state.home && Array.isArray(state.home.actions) ? state.home.actions : [];
  if ($('homeactions') === null) return;
  if (actions.length === 0) {
    $('homeactions').innerHTML = '<div class="empty" data-slice-missing="quick-actions">快捷动作没有声明 —— 这是接线问题，不是「没有可做的事」。</div>';
    return;
  }

  $('homeactions').innerHTML = '<div class="actionrow">' + actions.map(action => {
    const body = '<div class="acthead"><strong>' + escapeHtml(action.label) + '</strong>'
      + (action.available === false
        ? '<span class="chip">' + escapeHtml(String(action.unavailableText)) + '</span>'
        : '')
      + '</div>'
      + '<div class="actgoal">落地：' + escapeHtml(describeActionTarget(action.target)) + '</div>'
      + (action.effect === null || action.effect === undefined
        ? ''
        : '<div class="acteffect">' + escapeHtml(String(action.effect)) + '</div>')
      + (action.note === null || action.note === undefined
        ? ''
        : '<div class="actnote">' + escapeHtml(String(action.note)) + '</div>');
    return action.available === false
      ? '<div class="action action--off" data-action="' + escapeHtml(action.id) + '">' + body + '</div>'
      : '<div class="action" data-action="' + escapeHtml(action.id) + '" data-link="' + escapeHtml(String(action.link)) + '">' + body + '</div>';
  }).join('') + '</div>';

  for (const tile of $('homeactions').querySelectorAll('.action[data-link]')) {
    tile.onclick = () => followTodo(tile.dataset.link, {});
  }
}

/* Where a quick action lands, in words — derived from the same target object the
   click uses. The module name comes from the nav registry so a rename there
   renames here; moduleLabel is only for a target naming a module the nav does
   not have (nothing to look up). anchorLabel is printed only when there is an
   anchor, so the two halves cannot get out of step with the link. */
function describeActionTarget(target) {
  if (!target) return '（没有声明落点）';
  const group = GROUPS.filter(candidate => candidate.modules.some(entry => entry.id === target.module))[0];
  const module = group ? group.modules.filter(entry => entry.id === target.module)[0] : null;
  const name = module ? module.label : (target.moduleLabel || String(target.module));
  if (!target.anchor) return name;
  return name + ' · ' + (target.anchorLabel || String(target.anchor));
}

/* The four todo buckets.
 *
 * All four are always drawn, and an empty one says 「暂无」. A bucket that hid
 * itself would be indistinguishable from a feature that does not exist — the
 * reader cannot tell "nothing is blocking" from "blocking was never built".
 *
 * Each row is a link, and the link carries the filter: a todo that says "3 drafts
 * need a decision" and then drops the reader on an unfiltered page has moved the
 * work rather than done it.
 *
 * NB: no backticks in this comment — it sits inside the script string. */
const TODO_BUCKET_LABELS = [
  ['blocking', '阻断', '不解决就跑不下去'],
  ['needs_human', '待人工', '只有人能决定'],
  ['should_handle', '应处理', '该做，但不拦路'],
  ['optimization', '可优化', '机会，不是问题'],
];

function renderTodos() {
  const data = state.home;
  if (!data || $('hometodos') === null) return;
  const todos = data.todos || {};
  $('hometodos').innerHTML = TODO_BUCKET_LABELS.map(([bucket, label, meaning]) => {
    const items = todos[bucket] || [];
    /* 空的档不再占两行（标题 + 一块「暂无」），把「暂无」并进标题那一行：
       四档仍然**都画出来**（少画一档读起来像没有这个功能），但空档不该和有事
       的那一档一样高 —— 首页第一屏要留给真正要做的事。 */
    const body = items.length === 0
      ? ''
      : items.map(item => {
        const count = item.aggregateCount > 1
          ? '<span class="chip">' + item.aggregateCount + ' 条</span>'
          : '';
        return '<div class="todo" data-link="' + escapeHtml(item.link) + '" data-filters="'
          + escapeHtml(JSON.stringify(item.filters || {})) + '">'
          + '<div class="todohead"><span>' + escapeHtml(item.reason) + '</span>' + count + '</div>'
          + '<div class="opt-meta">' + escapeHtml(item.suggestedAction) + '</div>'
          /* T75 ②：两列（已等多久 / 下一步）。**没有「负责人」这一列** —— 本仓阶段 1
             没有用户表，四类待办的来源表里根本没有 owner/assignee 字段（全库只有
             dq_issue.assignee 一处，与待办无关）。一列永远印「未记录」不是信息，是噪音，
             而且读起来像「这条没人管」；真相是「这个系统还没有这个概念」。
             所以这一列不画，改在表下用一句话说清（见 TODO_OWNER_NOTE）。 */
          + '<div class="todo-cols">'
          + '<span data-cell="waited">已等多久：' + escapeHtml(item.waitedLabel || '') + '</span>'
          + '<span data-cell="next">下一步：' + escapeHtml(item.nextStepLabel || '') + ' →</span>'
          + '</div>'
          + '<div class="opt-meta">' + escapeHtml(item.responsibleModule) + ' · ' + escapeHtml(item.objectType + ':' + item.objectId)
          + (item.sample && item.sample.length > 0 ? ' · 例：' + escapeHtml(item.sample.join(', ')) : '') + '</div>'
          + '</div>';
      }).join('');
    return '<div class="todobucket"><div class="rule-sect" style="border-top:0;padding-left:0">'
      + escapeHtml(label) + ' <span class="opt-meta">' + escapeHtml(meaning) + '</span>'
      + (items.length === 0
        ? ' <span class="opt-meta">· ' + escapeHtml(EMPTY_BUCKET_TEXT) + '</span>'
        : ' <span class="n">' + items.length + '</span>') + '</div>'
      + body + '</div>';
  }).join('') + todoOwnerNoteHtml() + renderDecisions(data.decisions);

  for (const row of $('hometodos').querySelectorAll('.todo[data-link]')) {
    row.onclick = () => {
      let filters = {};
      try { filters = JSON.parse(row.dataset.filters || '{}'); } catch { filters = {}; }
      followTodo(row.dataset.link, filters);
    };
  }
  for (const row of $('hometodos').querySelectorAll('.decision[data-link]')) {
    row.onclick = () => {
      let filters = {};
      try { filters = JSON.parse(row.dataset.filters || '{}'); } catch { filters = {}; }
      followTodo(row.dataset.link, filters);
    };
  }
}

/* T75 ① — 一句话摘要。
 *
 * 零待办时印载荷给的 emptyText，**不隐藏整块**，也不为了显得有用去凑一条：一块
 * 消失了的摘要和一块说「今天没有需要你处理的事」的摘要是两句话，后者才是真的。
 * 数字一个都不在页面里算（total / shown / more / cardsNote 全来自 domain）。
 *
 * NB: no backticks in this comment — it sits inside the script string. */
const DIGEST_ORDINALS = ['①', '②', '③'];

function renderDigest(digest) {
  if (!digest) return '';
  const head = digest.empty === true
    ? escapeHtml(String(digest.emptyText || ''))
    : '今天有 ' + escapeHtml(String(digest.total)) + ' 件事要做';
  const items = (digest.shown || []).map((item, index) => '<span class="digest-item" data-link="'
    + escapeHtml(item.link) + '" data-filters="' + escapeHtml(JSON.stringify(item.filters || {})) + '">'
    + escapeHtml(DIGEST_ORDINALS[index] || (String(index + 1) + '.')) + ' ' + escapeHtml(String(item.text)) + '</span>').join(' ');
  const more = digest.more > 0
    ? '<span class="opt-meta">其余 ' + escapeHtml(String(digest.more)) + ' 件见下面「待办」。</span>'
    : '';
  return '<div class="digest" data-digest="1"><strong>' + head + '</strong>'
    + (items === '' ? '' : '：' + items + '。') + more
    + ' <span class="opt-meta" data-cell="cards">' + escapeHtml(String(digest.cardsNote || '')) + '</span></div>';
}

/* T75 ② — 为什么待办表里没有「负责人」那一列。
 *
 * 本仓阶段 1 没有用户表；四类待办的来源表（rule_set / shop / optimization_draft /
 * asin_snapshot）没有任何 owner/assignee 列（全库只有 dq_issue.assignee 一处，与待办
 * 无关）。所以这一列**不画**，改用这一行说清：
 *   · 留一列永远「未记录」读起来像「这条没人管」；
 *   · 真相是「这个系统还没有这个概念」。
 * 说清楚比留个空列诚实 —— 但**必须说出来**，否则「没有这一列」会被读成「没有这回事」。
 *
 * NB: no backticks in this comment — it sits inside the script string. */
function todoOwnerNoteHtml() {
  return '<div class="hint" style="padding:0" data-cell="owner-note">'
    + '本仓阶段 1 没有用户表，待办没有「负责人」字段 —— 这一列不显示，不是所有人都没写。</div>';
}

/* T75 ③ — 待决策（四类合并）。
 *
 * 这是**汇总入口**：每一行带着去那一页的链接与筛选参数（data-link / data-filters），
 * 走的是页面唯一那条导航（followTodo）。四类各自的处置界面早就存在，这里不重做。
 * 四类全空时仍然画这一块并印 emptyText —— 隐藏一块空表读起来像「这个功能没有」。
 *
 * NB: no backticks in this comment — it sits inside the script string. */
function renderDecisions(decisions) {
  if (!decisions) return '';
  const head = '<div class="rule-sect" style="border-top:1px solid var(--line)" data-sect="decisions">'
    + '待决策（四类合并：' + (decisions.categories || []).map(kind => escapeHtml(String(kind.label))).join(' / ')
    + '。点一行进真正处理它的那一页）</div>';
  const rows = decisions.rows || [];
  if (rows.length === 0) {
    return head + '<div class="empty" style="padding:8px 0" data-cell="decisions-empty">'
      + escapeHtml(String(decisions.emptyText || '')) + '</div>';
  }
  return head + rows.map(row => '<div class="decision" data-decision="' + escapeHtml(String(row.decisionKind))
    + '" data-link="' + escapeHtml(row.link) + '" data-filters="' + escapeHtml(JSON.stringify(row.filters || {})) + '">'
    + '<span data-cell="kind">' + escapeHtml(String(row.decisionLabel)) + '</span>'
    + '<span data-cell="object">' + escapeHtml(String(row.text)) + '</span>'
    + '<span data-cell="waited">' + escapeHtml(String(row.waitedLabel || '')) + '</span>'
    + '<span data-cell="go">去决策 →</span>'
    /* 这一行的处置入口**不在页面上**时，把话说清（补数今天只能在工具里结清）。
       少了这句，读者会在这页上找按钮，找不到就以为功能坏了。 */
    + (row.resolveHint ? '<div class="opt-meta">' + escapeHtml(String(row.resolveHint)) + '</div>' : '')
    + '</div>').join('');
}

/* 最近运行与产物 —— the five kinds of thing the workbench produces.
 *
 * All five are always drawn, and the two empty states are deliberately different
 * sentences: 「暂无」 is a kind whose table exists and has no rows (running the
 * thing produces data), 「未接入」 is a kind with no table at all (nothing you do
 * today produces a row). Both sentences come from the payload, so the page
 * cannot drift from the domain's meaning of "empty" — and a kind that is not
 * drawn at all would read as a feature that does not exist.
 *
 * Each row is a link carrying its object id, so the reader lands on the run they
 * clicked instead of on the module's front page.
 *
 * NB: no backticks in this comment — it sits inside the script string. */
const RECENT_STATUS = {
  /* A report's status is not a task status: it is whether the body is still
     reachable, the same fact the report panel prints as 「取不回」. Every other
     kind's status goes through statusChip — the one task vocabulary the collect
     and optimize tables already share. */
  openable: ['可取回', 'ok'],
  unreachable: ['取不回', 'warn'],
};

function recentStatusChip(item) {
  /* Array.isArray rather than a truthiness test: a status read off the wire can
     be any string, and RECENT_STATUS['constructor'] is a function, not a pair. */
  const known = RECENT_STATUS[item.status];
  if (Array.isArray(known)) return '<span class="chip ' + known[1] + '">' + escapeHtml(known[0]) + '</span>';
  return statusChip(item.status);
}

function renderRecent() {
  const data = state.home;
  if (!data || $('homerecent') === null) return;
  const kinds = data.recent || [];
  /* 折叠标题带上五类各自的条数。首页这一块原来铺开 706px，是整页最长的一段；
     收起之后标题仍然回答「最近有没有跑过东西」。 */
  if ($('recentSummary') !== null) {
    $('recentSummary').textContent = '最近运行与产物 —— ' + (kinds.length === 0
      ? '五类都没读到'
      : kinds.map(kind => String(kind.label) + ' ' + ((kind.rows || []).length)).join(' · '));
  }
  $('homerecent').innerHTML = kinds.map(kind => {
    const rows = kind.rows || [];
    const body = rows.length === 0
      ? '<div class="empty" style="padding:8px 0">' + escapeHtml(kind.note || '') + '</div>'
      : rows.map(item => {
        const at = shortTime(item.at);
        const meta = (at === '' ? '时间未记录' : at) + ' · ' + item.objectType + ':' + item.objectId;
        return '<div class="recent" data-link="' + escapeHtml(item.link) + '"'
          + ' data-filters="' + escapeHtml(JSON.stringify(item.filters || {})) + '"'
          + ' data-object-type="' + escapeHtml(item.objectType) + '"'
          + ' data-object-id="' + escapeHtml(item.objectId) + '">'
          + '<div class="todohead"><span>' + escapeHtml(item.title) + '</span>' + recentStatusChip(item) + '</div>'
          + '<div class="opt-meta">' + escapeHtml(meta) + '</div>'
          + '</div>';
      }).join('');
    /* The count reads "showing N of M" only when there is an M worth naming —
       a bare N on a kind that has exactly N rows says nothing. */
    const count = rows.length === 0
      ? ''
      : ' <span class="n">' + rows.length + (kind.total > rows.length ? ' / ' + kind.total : '') + '</span>';
    return '<div class="recentkind"><div class="rule-sect" style="border-top:0;padding-left:0">'
      + escapeHtml(kind.label) + count + '</div>' + body + '</div>';
  }).join('');

  for (const row of $('homerecent').querySelectorAll('.recent[data-link]')) {
    row.onclick = () => {
      let filters = {};
      try { filters = JSON.parse(row.dataset.filters || '{}'); } catch { filters = {}; }
      followTodo(row.dataset.link, filters);
    };
  }
}

/* Follow a link: '#<module>#<anchor>', plus the filters to apply on arrival.
   One mechanism for both the todo buckets and the 最近运行 block: the filters
   ride in the page's existing filter bag, so the panel that opens is the one
   the row was about — no second navigation mechanism. */
function followTodo(link, filters) {
  const parts = String(link || '').replace(/^#/, '').split('#');
  const module = parts[0] || 'asin';
  const anchor = parts[1] || null;
  /* F13-01：从 01 的待办进收件箱时，除了行里带的 draftStatus，还要按**当前上下文**收窄。
     模块 01 的待办行只带 draftStatus（todos.js 的 optimizationItems），而「N 条草案等着
     决定」问的是当前上下文里的 N 条 —— 别的上下文里的草案在这台工作台上根本提交不了
     （amzn_optimize_save 会拒，见 domain/optimize/context.js）。
     这一下加在**入口**而不是产出行的那一侧：那份文件不在本批的写作用域里。
     它不是隐式的 —— 筛选条上写明「只看「当前上下文」」并能一键关掉。
     （No backticks in this comment — this whole file is one template literal.） */
  const arrived = { ...filters };
  if (module === 'optimize' && anchor === 'inbox'
    && arrived.draftStatus !== undefined && arrived.draftContext === undefined) {
    arrived.draftContext = 'current';
  }
  patchContext({ module, filters: { ...state.filters, ...arrived, ...(anchor === null ? {} : { anchor }) } });
}

/* Drop one filter, which is not the same as setting it to empty: the panels read
   these keys with nullish coalescing and with or, and an empty string is neither
   nullish nor a usable id — a cleared runId set to "" would look for a run whose
   id is the empty string. Removing the key is the only way to mean "no filter".
   (No backticks in this comment — this whole file is one template literal.) */
function dropFilter(name) {
  const next = { ...state.filters };
  delete next[name];
  patchContext({ filters: next });
}

/* ── 数据资产与质量（S1-B08） ─────────────────────────────────────────────── */

/* The four views behind four in-panel tabs. The tab lives in the page's filter
   bag (filters.qualityTab) exactly like the report centre's kind: it survives a
   state re-read, it is one fact in one place, and nothing about switching views
   needs a second navigation mechanism.

   The ids come from the payload (the domain's list); the labels are UI copy and
   live here. The suite asserts the two lists agree in both directions — a fifth
   view added to the domain would otherwise be silently unreachable.

   NB: no backticks in this comment — it sits inside the script string. */
const QUALITY_TAB_LABELS = [
  ['catalog', '数据目录'],
  ['cockpit', '质量驾驶舱'],
  ['lineage', '字段血缘'],
  ['conflicts', '冲突工作台'],
  ['snapshot', '快照管理'],
  ['audit', '全局审计'],
];
`
