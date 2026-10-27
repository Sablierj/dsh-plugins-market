/**
 * 页签「settings」的客户端脚本片段（P1-1 从 page.js 原样切出）。
 *
 * 只搬不改：片段最终仍拼回同一个 `<script>` 作用域，拆的是文件不是作用域。
 */
export const settingsScript = `function renderSettings() {
  const data = state.settings;
  if (!data) {
    for (const id of ['setform', 'setmarkets', 'setsources', 'setlines', 'setfacts', 'setpace',
      'setworkspaces', 'setsites', 'setshops', 'setbrands', 'setownership', 'setcollect', 'setapprovals', 'setwizard']) {
      $(id).innerHTML = '';
    }
    return;
  }

  $('setHint').textContent = '改完立刻写库；采集参数在下一次采集任务生效，正在跑的任务不受影响';
  renderSetupWizard();

  /* What the collector will actually obey, read from the live service. */
  const p = data.pacing || {};
  const r = p.resolved;
  const chip = (label, value, cls) => '<span class="chip ' + (cls || '') + '">'
    + escapeHtml(label) + ' ' + escapeHtml(String(value)) + '</span>';
  $('setpace').innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line);flex-wrap:wrap">'
    + (r
      ? chip('每任务上限', r.perTaskMax ?? '—')
        + chip('任务间隔', r.taskGapMs ? Math.round(r.taskGapMs[0] / 1000) + '–' + Math.round(r.taskGapMs[1] / 1000) + 's' : '—')
        + chip('拟人化', r.humanize ? '开' : '关', r.humanize ? 'ok' : '')
      : '<span class="hint" style="padding:0">采集服务未就绪，读不到生效值</span>')
    + (p.limit === null || p.limit === undefined
      ? ''
      : chip('今日已采集', (p.used ?? 0) + ' / ' + p.limit, (p.remaining ?? 1) > 0 ? '' : 'warn'))
    + '</div>';

  /* ── S1-B02: 工作空间 ──────────────────────────────────────────────────────
     The workspace owns the configuration; the market facts are shared, because
     an ASIN and a keyword describe one marketplace rather than one shop. The
     block says which one is current, offers rename / archive / restore / default
     as single POSTs (one fact each, all reversible), and links the export.

     "归档" is not "删除": the row and its data stay, and the store refuses
     writes into it. There is no delete button because there is no delete — a
     workspace is the parent of every configuration row, so removing one either
     destroys history or orphans it, and that decision is retention's (S1-B19). */
  const workspace = data.workspace || { rows: [], currentId: null, current: null };
  $('setworkspaces').innerHTML = workspace.rows.length === 0
    ? emptyState('not-recorded', {
      subject: '工作空间',
      next: '在下面新建一个 —— 工作空间装的是配置（设置、产品线、数据源），不是市场事实。',
    })
    : '<table><thead><tr><th>工作空间</th><th>状态</th><th>说明</th><th>改</th><th></th></tr></thead><tbody>'
      + workspace.rows.map(entry => {
        const inputId = 'wsname-' + entry.id;
        return '<tr>'
          + '<td><code>' + escapeHtml(entry.id) + '</code></td>'
          + '<td>' + (entry.isDefault ? '<span class="chip ok">默认</span>' : '<span class="chip">普通</span>')
            + (entry.archived ? ' <span class="chip warn">已归档（只读）</span>' : '') + '</td>'
          + '<td>' + escapeHtml(entry.note || '—') + '</td>'
          + '<td><input id="' + escapeHtml(inputId) + '" type="text" value="' + escapeHtml(entry.name) + '">'
            + '<button data-wsrename="' + escapeHtml(entry.id) + '" data-wsinput="' + escapeHtml(inputId) + '">改名</button>'
            + (entry.archived
              ? '<button data-wsaction="restore" data-wsid="' + escapeHtml(entry.id) + '">恢复</button>'
              : '<button data-wsaction="archive" data-wsid="' + escapeHtml(entry.id) + '"'
                + (entry.isDefault ? ' disabled title="默认空间不能归档"' : '') + '>归档</button>')
            + (entry.isDefault || entry.archived
              ? ''
              : '<button data-wsaction="set_default" data-wsid="' + escapeHtml(entry.id) + '">设为默认</button>')
          + '</td>'
          + '<td>' + (entry.id === workspace.currentId ? '<span class="chip ok">当前</span>' : '')
            + '<a href="' + PAGE + '/api/workspace-export?workspaceId=' + encodeURIComponent(entry.id)
            + '" download title="导出这个工作空间的配置（不含凭据）">导出配置</a>'
          + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table>'
      + '<div class="hint">归档 = <strong>只读</strong>，不删：行还在，可以恢复。默认空间不能归档，归档的空间也不能当默认。'
      + '导出的配置<strong>不含凭据</strong> —— 只列有哪些凭据字段，不列值。</div>';

  for (const button of $('setworkspaces').querySelectorAll('button[data-wsrename]')) {
    button.onclick = () => {
      const input = $(button.dataset.wsinput);
      saveWorkspace({ action: 'rename', id: button.dataset.wsrename, name: input === null ? '' : input.value });
    };
  }
  for (const button of $('setworkspaces').querySelectorAll('button[data-wsaction]')) {
    button.onclick = () => saveWorkspace({ action: button.dataset.wsaction, id: button.dataset.wsid });
  }

  /* The editable preferences. A value that is still the default says so, because
     "45" and "45 because I chose 45" are different states and only one of them
     should survive a changed default.

     The approval toggles are **filtered out of this table** rather than listed in
     it. This table draws every boolean as a text box, and a text box cannot write
     a boolean — the value goes back as the string "false" and the store refuses
     it. The six approval keys get real switches in their own block below, drawn
     from the same payload, so nothing is hidden: it is the same rows, with the
     control that can actually write them. */
  const approvals = data.approvals || { hard: [], configurable: [] };
  const approvalKeys = new Set(approvals.configurable.map(item => item.key));
  $('setform').innerHTML = '<table><thead><tr><th>设置</th><th>值</th><th>来源</th>'
    + '<th>说明</th><th></th></tr></thead><tbody>'
    + data.rows.filter(row => !approvalKeys.has(row.key) && !row.key.startsWith('ui.')).map(row => {
      const control = SETTING_CONTROLS[row.kind] || SETTING_CONTROLS.string;
      return '<tr>'
        + '<td><code>' + escapeHtml(row.key) + '</code></td>'
        + '<td>' + control(row) + '</td>'
        + '<td>' + (row.stored
          ? '<span class="chip ok">已设置</span>'
          : '<span class="chip">默认</span>') + '</td>'
        + '<td title="' + escapeHtml(row.note || '') + '">' + escapeHtml(row.note || '—') + '</td>'
        + '<td><button data-setsave="' + escapeHtml(row.key) + '">保存</button></td>'
        + '</tr>';
    }).join('')
    + '</tbody></table>';

  for (const button of $('setform').querySelectorAll('button[data-setsave]')) {
    button.onclick = () => saveSetting(button.dataset.setsave);
  }
  /* A checkbox has no text to read and no Enter to catch: it saves its own
     state, as the boolean the store requires. Sending "true"/"false" as a
     string is the bug this control exists to not have. */
  for (const box of $('setform').querySelectorAll('input[data-setbool]')) {
    box.onchange = () => saveSetting(box.dataset.setbool, box.checked);
  }
  for (const input of $('setform').querySelectorAll('input[data-setkey]')) {
    input.onkeydown = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); saveSetting(input.dataset.setkey); }
    };
  }

  /* 审批策略（S1-B17）。
   *
   * 两块故意画得不一样，因为它们是两件不同的事：
   *
   * - 硬审批三项画成**陈述**，不是画成禁用的复选框。一个灰掉的勾选框在说「这里
   *   有一个开关，只是现在不让你拨」—— 而事实是**根本没有那个开关**：那三个键不
   *   在设置白名单里，所以 setSetting 连写都写不进去。画成一个关着的开关，就是在
   *   描述一个不存在的入口，读者会去找绕过它的办法。
   * - 可配置六项是真实开关，改动走已有的 setting-set 路由（它本来就在审计漏斗里）。
   *   cannotRelax 为 true 的项说明它出厂就是开的、只能收紧不能关 —— 今天六项都是
   *   false，所以这条今天不出现，但它在数据里，第一项 default:true 落地时就会显示。
   *   （这里曾经还提过一个 floor 字段：routes.js 送、没有一行代码读。按「payload 里
   *   每个字段都必须有读者」删了，页面要的就是 cannotRelax 这一个。）
   *
   * 这六项现在**全部接在动作上**（走 domain/approval/policy.js 的 approvalRefusal：
   * batchCollect / overwriteField / activateVersion / archive / acceptDraft / markPublished），
   * 打开就会真的拦。markPublished 曾经是最后一项没有动作的 —— 它对应的「标记发布」
   * （amzn_publication_record，§6 的发布登记）在模块 14 交付之后就有了，闸门接在那里。
   * 那一句「属模块 14，还没做」是过期说法，别写回来：一行注释读起来像现状，就有人按它做事。 */
  const toggle = (item) => '<tr>'
    + '<td><input type="checkbox" data-approval="' + escapeHtml(item.key) + '"'
      + (item.enabled ? ' checked' : '') + (item.cannotRelax ? ' disabled' : '') + '></td>'
    + '<td><strong>' + escapeHtml(item.label) + '</strong>'
      + (item.enabled ? ' <span class="chip run">已开启</span>' : ' <span class="chip">默认不额外确认</span>')
      + (item.cannotRelax ? ' <span class="chip warn">下限 true：只能收紧，不能关</span>' : '')
      + '</td>'
    + '<td><code>' + escapeHtml(item.key) + '</code></td>'
    + '<td>' + escapeHtml(item.note) + '</td>'
    + '</tr>';

  $('setapprovals').innerHTML = '<table><thead><tr><th>开</th><th>动作</th><th>键</th><th>说明</th></tr></thead><tbody>'
    + approvals.configurable.map(toggle).join('')
    + '</tbody></table>'
    + '<div class="rule-sect" style="border-top:1px solid var(--line)">硬审批（不可配置：没有键，所以没有能关掉它们的入口）</div>'
    + '<table><thead><tr><th>动作</th><th>为什么不能关</th></tr></thead><tbody>'
    + approvals.hard.map(item => '<tr>'
      + '<td><strong>' + escapeHtml(item.label) + '</strong></td>'
      + '<td>' + escapeHtml(item.why) + '</td>'
      + '</tr>').join('')
    + '</tbody></table>'
    + '<div class="hint">这三项<strong>没有 setting 键</strong>：<code>setSetting</code> 对它们的回答是 '
    + '<code>unknown setting</code>，和写错一个键名的回答完全一样。不是「有一个键但写入时拦住」，'
    + '而是根本没有那个键 —— 拦不住的入口不存在。审批项可以<strong>收紧</strong>（从默认的关改成开），'
    + '不能<strong>放宽</strong>到低于它出厂的值。</div>';

  for (const box of $('setapprovals').querySelectorAll('input[data-approval]')) {
    box.onchange = () => saveSetting(box.dataset.approval, box.checked);
  }

  /* One row per marketplace the collection layer knows — not only the ones with
     an override, or the page would list three sites and read as "these are all
     the sites there are". Sites with no postal code (AE) say so rather than
     showing an empty box that looks unset. */
  $('setmarkets').innerHTML = '<table><thead><tr><th>站点</th><th>生效邮编</th>'
    + '<th>站点默认</th><th>来源</th><th>改</th></tr></thead><tbody>'
    + data.marketplaces.map(entry => {
      const canEdit = entry.siteDefault !== null;
      return '<tr>'
        + '<td><code>' + escapeHtml(entry.code) + '</code></td>'
        + '<td>' + (entry.value === null
          ? '<span class="chip">无邮编</span>'
          : escapeHtml(String(entry.value))) + '</td>'
        + '<td>' + (entry.siteDefault === null ? '—' : escapeHtml(String(entry.siteDefault))) + '</td>'
        + '<td>' + (entry.stored
          ? '<span class="chip warn">已设置</span>'
          : '<span class="chip">站点默认</span>') + '</td>'
        + '<td>' + (canEdit
          ? '<input data-mktkey="' + escapeHtml(entry.key) + '" type="text" placeholder="'
            + escapeHtml(String(entry.siteDefault)) + '" value="'
            + escapeHtml(entry.stored ? String(entry.value ?? '') : '') + '">'
            + '<button data-mktsave="' + escapeHtml(entry.key) + '">保存</button>'
            + (entry.stored ? '<button data-mktclear="' + escapeHtml(entry.key) + '">恢复默认</button>' : '')
          : '<span class="opt-meta">该站点无邮编概念</span>') + '</td>'
        + '</tr>';
    }).join('')
    + '</tbody></table>';

  for (const button of $('setmarkets').querySelectorAll('button[data-mktsave]')) {
    button.onclick = () => saveSetting(button.dataset.mktsave, $('setmarkets').querySelector('input[data-mktkey="' + button.dataset.mktsave.replace(/"/g, '') + '"]').value);
  }
  for (const button of $('setmarkets').querySelectorAll('button[data-mktclear]')) {
    button.onclick = () => saveSetting(button.dataset.mktclear, null);
  }

  /* ── S1-B02: 站点档案 ──────────────────────────────────────────────────────
     The factual half — domain, language, currency, units, title cap, rule state
     — is a projection of the rule registry and is drawn read-only: offering to
     edit a title cap is offering to edit the answer to "is this title legal".

     The verification column is the one place the page must not blur two very
     different things. A row written by a person says who and when. A row written
     by the migration says 「来源：规则手册自述，非人工核验」 and is drawn with a
     warning chip — because the manual claiming its own update date is not Amazon
     confirming anything, and a page that drew them the same way would turn a
     self-report into evidence. */
  const sites = data.sites || [];
  $('setsites').innerHTML = sites.length === 0
    ? emptyState('not-recorded', {
      subject: '站点',
      reason: '没有可显示的站点。站点与标题上限属于**已核验的市场事实**，不在设置里；'
        + '它们由 domain/rules/marketplaces.js 声明，空的话说明那一层没加载。',
      allowMarkup: true,
    })
    : '<table><thead><tr><th>站点</th><th>口径</th><th>域名 / 语言 / 币种</th><th>标题上限</th>'
      + '<th>最近核验</th><th>备注 / 本地化偏好</th><th>改</th></tr></thead><tbody>'
      + sites.map(site => {
        const ruleChip = site.ruleState === 'authoritative'
          ? '<span class="chip ok">口径已核验</span>'
          : site.ruleState === 'provisional'
            ? '<span class="chip warn">未核验（套通用档）</span>'
            : '<span class="chip stop">不在站点表</span>';
        const verified = site.lastVerifiedAt === null
          ? '<span class="chip">从未核验</span>'
          : '<span class="chip' + (site.lastVerificationIsSeed ? ' warn' : ' ok') + '">'
            + escapeHtml(String(site.lastVerifiedAt).slice(0, 10)) + '</span>'
            + '<br><span class="opt-meta">'
            + (site.lastVerificationIsSeed
              ? '来源：规则手册自述，非人工核验'
              : '记录人：' + escapeHtml(String(site.lastVerifiedBy || '未记录')))
            + '</span>';
        const noteId = 'sitenote-' + site.code;
        return '<tr>'
          + '<td><code>' + escapeHtml(site.code) + '</code><br><span class="opt-meta">' + escapeHtml(site.label || '') + '</span></td>'
          + '<td>' + ruleChip
            + (site.needsReverify ? ' <span class="chip">需重新核验</span>' : '')
            + '<br><span class="opt-meta">' + escapeHtml(site.ruleSource || '无已核验的规则来源') + '</span></td>'
          + '<td><span class="opt-meta">' + escapeHtml(site.domain || '—') + '<br>'
            + escapeHtml(site.language || '—') + ' · ' + escapeHtml(site.currency || '—') + '</span></td>'
          + '<td>' + (site.titleMax === null || site.titleMax === undefined ? '—' : escapeHtml(String(site.titleMax)))
            + (site.ruleState === 'provisional'
              ? '<br><span class="opt-meta">通用档 ' + escapeHtml(String(site.globalTitleMax)) + '</span>'
              : '') + '</td>'
          + '<td>' + verified + '</td>'
          + '<td><input id="' + escapeHtml(noteId) + '" type="text" value="' + escapeHtml(site.note || '') + '" placeholder="备注（本地化偏好）">'
            + (site.localization === null || site.localization === undefined
              ? ''
              : '<br><span class="opt-meta">' + escapeHtml(JSON.stringify(site.localization)) + '</span>')
            + '</td>'
          + '<td><button data-sitenote="' + escapeHtml(noteId) + '" data-sitecode="' + escapeHtml(site.code) + '">保存备注</button>'
            + '<button data-siteverify="' + escapeHtml(site.code) + '">记录核验</button></td>'
          + '</tr>';
      }).join('')
      + '</tbody></table>'
      + '<div class="hint">核验是<strong>事件</strong>，只能追加，不能改 —— 一份能被覆盖的核验记录回答不了「上次是谁核的」。'
      + '本仓没有用户表，「记录核验」记的是<strong>你</strong>（<code>local</code>）；'
      + '权限层级是枚举占位，不是账号；迁移种入的两行不是人工核验，页面上单独标出来。</div>';

  for (const button of $('setsites').querySelectorAll('button[data-sitenote]')) {
    button.onclick = () => {
      const input = $(button.dataset.sitenote);
      saveSiteProfile({ marketplace: button.dataset.sitecode, note: input === null ? '' : input.value });
    };
  }
  for (const button of $('setsites').querySelectorAll('button[data-siteverify]')) {
    button.onclick = () => saveSiteVerification(button.dataset.siteverify);
  }

  /* ── S1-B03: 店铺与品牌 ────────────────────────────────────────────────────
     The own/competitor flag is the only place "ours or a competitor's" is
     answered, and it is an attribute of the **brand**: putting it on each ASIN
     would let two ASINs of one brand disagree, and then every comparison would
     have to pick one to believe. */
  const shops = data.shops || [];
  const brands = data.brands || [];
  $('setshops').innerHTML = '<table><thead><tr><th>店铺</th><th>站点</th><th>备注</th><th>改</th></tr></thead><tbody>'
    + shops.map(shop => {
      const nameId = 'shopname-' + shop.id;
      return '<tr>'
        + '<td><code>' + escapeHtml(shop.id) + '</code></td>'
        + '<td>' + (shop.marketplace === null
          ? '<span class="chip warn">未指定站点</span>'
          : escapeHtml(shop.marketplace)) + '</td>'
        + '<td><input id="' + escapeHtml(nameId) + '" type="text" value="' + escapeHtml(shop.name) + '" placeholder="店铺名">'
          + (shop.note ? '<br><span class="opt-meta">' + escapeHtml(shop.note) + '</span>' : '') + '</td>'
        + '<td><button data-shopsave="' + escapeHtml(shop.id) + '" data-shopinput="' + escapeHtml(nameId) + '">保存</button></td>'
        + '</tr>';
    }).join('')
    + '<tr><td><span class="opt-meta">新建</span></td>'
      + '<td><input id="shopnew-mkt" type="text" placeholder="站点，如 US"></td>'
      + '<td><input id="shopnew-name" type="text" placeholder="店铺名"></td>'
      + '<td><button id="shopcreate">新建店铺</button></td></tr>'
    + '</tbody></table>'
    + '<div class="hint">站点留空是<strong>一个真实状态</strong>（还在建），不默认成 US —— 默认值会变成一条没人做过的声明。</div>';

  $('setbrands').innerHTML = '<table><thead><tr><th>品牌</th><th>归属</th><th>别名</th><th>禁用写法</th><th>改</th></tr></thead><tbody>'
    + brands.map(brand => {
      const aliasId = 'brandalias-' + brand.id;
      return '<tr>'
        + '<td><code>' + escapeHtml(brand.name) + '</code><br><span class="opt-meta">' + escapeHtml(brand.id) + '</span></td>'
        + '<td>' + (brand.isOwn ? '<span class="chip ok">自有</span>' : '<span class="chip warn">竞品</span>') + '</td>'
        + '<td><input id="' + escapeHtml(aliasId) + '" type="text" value="' + escapeHtml(brand.aliases.join(', ')) + '" placeholder="别名，逗号分隔"></td>'
        + '<td><span class="opt-meta">' + escapeHtml(brand.forbidden.length === 0 ? '—' : brand.forbidden.join(', ')) + '</span></td>'
        + '<td><button data-brandsave="' + escapeHtml(brand.id) + '" data-brandinput="' + escapeHtml(aliasId) + '"'
          + ' data-brandown="' + (brand.isOwn ? '1' : '0') + '">保存别名</button>'
          + '<button data-brandflip="' + escapeHtml(brand.id) + '">改成' + (brand.isOwn ? '竞品' : '自有') + '</button></td>'
        + '</tr>';
    }).join('')
    + '<tr><td><input id="brandnew-name" type="text" placeholder="品牌名"></td>'
      + '<td><select id="brandnew-own"><option value="1">自有</option><option value="0">竞品</option></select></td>'
      + '<td><input id="brandnew-alias" type="text" placeholder="别名，逗号分隔"></td>'
      + '<td>—</td><td><button id="brandcreate">新建品牌</button></td></tr>'
    + '</tbody></table>';

  for (const button of $('setshops').querySelectorAll('button[data-shopsave]')) {
    button.onclick = () => {
      const input = $(button.dataset.shopinput);
      saveShop({ id: button.dataset.shopsave, name: input === null ? '' : input.value });
    };
  }
  if ($('shopcreate') !== null) {
    $('shopcreate').onclick = () => saveShop({ name: $('shopnew-name').value, marketplace: $('shopnew-mkt').value });
  }
  for (const button of $('setbrands').querySelectorAll('button[data-brandsave]')) {
    button.onclick = () => {
      const input = $(button.dataset.brandinput);
      saveBrand({
        id: button.dataset.brandsave,
        isOwn: button.dataset.brandown === '1',
        aliases: splitList(input === null ? '' : input.value),
      });
    };
  }
  for (const button of $('setbrands').querySelectorAll('button[data-brandflip]')) {
    const brand = brands.find(entry => entry.id === button.dataset.brandflip);
    button.onclick = () => saveBrand({ id: button.dataset.brandflip, isOwn: !brand.isOwn });
  }
  if ($('brandcreate') !== null) {
    $('brandcreate').onclick = () => saveBrand({
      name: $('brandnew-name').value,
      isOwn: $('brandnew-own').value === '1',
      aliases: splitList($('brandnew-alias').value),
    });
  }

  /* ── S1-B03: 归属 ──────────────────────────────────────────────────────────
     Ownership is asked about an object, so this section is about the **selected**
     ASINs and says so when there are none. The conflict case is drawn as a red
     row with both sides named, because "we wrote neither" is only honest if the
     reader can see why. */
  const ownership = data.ownership || [];
  $('setownership').innerHTML = ownership.length === 0
    ? '<div class="empty">没有选中的 ASIN。在 ASIN 页选中一行，这里会显示它的归属关系。</div>'
    : ownership.map(entry => {
      const decided = entry.decidedBy === 'manual'
        ? '<span class="chip ok">人工</span>'
        : entry.decidedBy === 'auto' ? '<span class="chip">自动判定</span>' : '<span class="chip warn">没有记录</span>';
      const side = entry.side === 'self'
        ? '<span class="chip ok">自有</span>'
        : entry.side === 'competitor' ? '<span class="chip warn">竞品</span>' : '<span class="chip">未判定</span>';
      const targets = entry.targets.length === 0
        ? '<span class="opt-meta">—</span>'
        : entry.targets.map(target => '<code>' + escapeHtml(target.objectType) + '</code> '
          + escapeHtml(target.objectId) + ' <span class="opt-meta">' + escapeHtml(target.source) + '</span>').join('<br>');
      const retracted = entry.retracted.length === 0
        ? ''
        : '<br><span class="opt-meta">已撤销 ' + entry.retracted.length + ' 条：'
          + escapeHtml(entry.retracted.map(row => row.objectType + '=' + row.objectId + '(' + row.source + ')').join(', '))
          + '</span>';
      return '<div style="padding:8px 14px;border-bottom:1px solid var(--line)">'
        + '<strong>' + escapeHtml(entry.asin) + ' ' + escapeHtml(entry.marketplace) + '</strong> '
        + side + ' ' + decided
        + '<div class="opt-meta" style="margin-top:4px">' + targets + retracted + '</div>'
        + (entry.conflict
          ? '<div class="viol"><div><span class="chip stop">冲突</span> ' + escapeHtml(entry.reason || '') + '</div></div>'
          : '')
        + '<div style="margin-top:6px">'
        + '<button data-own="self" data-ownasin="' + escapeHtml(entry.asin) + '" data-ownmkt="' + escapeHtml(entry.marketplace) + '">标为自有</button> '
        + '<button data-own="competitor" data-ownasin="' + escapeHtml(entry.asin) + '" data-ownmkt="' + escapeHtml(entry.marketplace) + '">标为竞品</button> '
        + '<button data-ownderive="1" data-ownasin="' + escapeHtml(entry.asin) + '" data-ownmkt="' + escapeHtml(entry.marketplace) + '">按判定写入</button>'
        + '</div></div>';
    }).join('');

  for (const button of $('setownership').querySelectorAll('button[data-own]')) {
    button.onclick = () => saveOwnership({
      asin: button.dataset.ownasin,
      marketplace: button.dataset.ownmkt,
      objectType: 'side',
      objectId: button.dataset.own,
      source: 'manual',
    });
  }
  for (const button of $('setownership').querySelectorAll('button[data-ownderive]')) {
    button.onclick = () => saveOwnership({
      action: 'auto',
      asin: button.dataset.ownasin,
      marketplace: button.dataset.ownmkt,
    });
  }

  /* ── S1-B05: 采集与数据源 ──────────────────────────────────────────────────
     Six facts the page could not state before, and one it must not: a credential
     value. The third-party block lists which credential fields exist and never
     what they hold — and a source with none reports "not configured" with an
     **empty** field list, because a blank key field reads as a credential that
     exists and happens to be empty.

     The login state is drawn as three states, and "未探测" is one of them: a
     green light nobody earned is worse than no light.
     NB: no backticks in this comment — it sits inside the script string. */
  const collect = data.collect || null;
  if (collect === null) {
    $('setcollect').innerHTML = '<div class="empty">采集设置未就绪。</div>';
  } else {
    const channel = collect.channel || {};
    const browser = collect.browser || {};
    const login = browser.login || { state: 'unknown', checkedAt: null, neverChecked: true };
    const loginChip = login.state === 'logged_in'
      ? '<span class="chip ok">已登录（上次采集通过了站点校验）</span>'
      : login.state === 'logged_out'
        ? '<span class="chip warn">未登录（上次采集被站点校验拒绝）</span>'
        : '<span class="chip">未探测</span>';
    const profile = browser.profile || { source: 'default' };
    const profileNote = profile.source === 'found'
      ? '<span class="chip ok">已找到</span>'
      : profile.source === 'missing'
        ? '<span class="chip warn">路径不存在</span>'
        : '<span class="chip">未指定（用插件默认位置）</span>';
    const profiles = browser.profiles || [];
    const thirdParty = collect.thirdParty || [];

    $('setcollect').innerHTML = '<table><thead><tr><th>项</th><th>值</th><th>状态</th></tr></thead><tbody>'
      + '<tr><td>采集通道</td><td><code>' + escapeHtml(String(channel.sourceId || '—')) + '</code>'
        + '<br><span class="opt-meta">CDP ' + escapeHtml(String(channel.host || '—')) + ':'
        + escapeHtml(String(channel.port === null || channel.port === undefined ? '—' : channel.port))
        + (channel.chromePath ? ' · ' + escapeHtml(String(channel.chromePath)) : '') + '</span></td>'
        + '<td>' + (channel.status === 'ready'
          ? '<span class="chip ok">就绪</span>'
          : '<span class="chip warn">' + escapeHtml(String(channel.status || '未知')) + '</span>')
        + (channel.statusNote ? '<br><span class="opt-meta">' + escapeHtml(String(channel.statusNote)) + '</span>' : '')
        + '</td></tr>'
      + '<tr><td>登录态</td><td>' + loginChip
        + '<br><span class="opt-meta">最后验证时间：'
        + escapeHtml(login.checkedAt === null ? '从未验证' : String(login.checkedAt)) + '</span></td>'
        + '<td>' + (login.neverChecked
          ? '<span class="opt-meta">还没跑过采集自检</span>'
          : '<span class="opt-meta">' + escapeHtml(String(login.detail || '')) + '</span>') + '</td></tr>'
      + '<tr><td>浏览器 profile</td><td><input id="collectProfile" type="text" value="'
        + escapeHtml(browser.profileDir === null || browser.profileDir === undefined ? '' : String(browser.profileDir))
        + '" placeholder="留空 = 插件默认位置" style="width:340px">'
        + '<button id="collectProfileSave">保存</button>'
        + '<br><span class="opt-meta">磁盘上发现 ' + profiles.length + ' 个 profile'
        + (profiles.length === 0 ? '' : '：' + escapeHtml(profiles.map(p => p.name).join(', '))) + '</span></td>'
        + '<td>' + profileNote + '</td></tr>'
      + '<tr><td>默认采集通道</td><td><input id="collectDefault" type="text" value="'
        + escapeHtml(String(collect.defaultSource || '')) + '" style="width:200px">'
        + '<button id="collectDefaultSave">保存</button></td>'
        + '<td><span class="opt-meta">提交任务没给 source 时用它</span></td></tr>'
      + '<tr><td>导入目录</td><td><input id="collectImport" type="text" value="'
        + escapeHtml(collect.importDir && collect.importDir.stored ? String(collect.importDir.stored) : '')
        + '" placeholder="' + escapeHtml(String((collect.importDir || {}).path || '')) + '" style="width:340px">'
        + '<button id="collectImportSave">保存</button></td>'
        + '<td>' + ((collect.importDir || {}).isDefault
          ? '<span class="chip">约定路径</span>'
          : '<span class="chip ok">已设置</span>') + '</td></tr>'
      + '</tbody></table>'
      + '<div class="hint">CDP 端口来自插件配置（<code>config.cdpPort</code>），<strong>不在这一页改</strong> —— '
      + '一个改了却不生效的输入框，比没有这个输入框更糟。登录态来自<strong>上一次采集自检</strong>：'
      + '通过站点校验（配送地址/语言/币种）就是登录成功的证据，被它拒绝就是没登录的证据，其余一律「未探测」。</div>'
      + '<div class="rule-sect" style="border-top:0">第三方源连接状态（只列有哪些凭据字段，不列值）</div>'
      + (thirdParty.length === 0
        ? emptyState('not-recorded', {
          subject: '第三方源记录',
          next: '卖家精灵 / 赛狐 / 西柚三个源都还没有接入 —— 它们要各自开通额度后才采得到数据。',
        })
        : '<table><thead><tr><th>源</th><th>类型</th><th>启用</th><th>凭据</th><th>字段</th></tr></thead><tbody>'
          + thirdParty.map(source => '<tr>'
            + '<td><code>' + escapeHtml(source.id) + '</code><br><span class="opt-meta">' + escapeHtml(source.name || '') + '</span></td>'
            + '<td>' + escapeHtml(source.kind || '') + '</td>'
            + '<td>' + (source.enabled ? '<span class="chip ok">启用</span>' : '<span class="chip">停用</span>') + '</td>'
            + '<td>' + (source.configKeys.length === 0
              ? '<span class="chip">未配置</span>'
              : source.configured ? '<span class="chip ok">已配置</span>' : '<span class="chip warn">不完整</span>') + '</td>'
            + '<td>' + (source.configKeys.length === 0
              ? '<span class="opt-meta">—</span>'
              : source.configKeys.map(key => '<code>' + escapeHtml(key) + '</code>').join(' ')) + '</td>'
            + '</tr>').join('')
          + '</tbody></table>');

    if ($('collectProfileSave') !== null) {
      $('collectProfileSave').onclick = () => saveSetting('browser.profileDir', $('collectProfile').value.trim() || null);
    }
    if ($('collectDefaultSave') !== null) {
      $('collectDefaultSave').onclick = () => saveSetting('collect.defaultSource', $('collectDefault').value.trim());
    }
    if ($('collectImportSave') !== null) {
      $('collectImportSave').onclick = () => saveSetting('collect.importDir', $('collectImport').value.trim() || null);
    }
  }

  /* Sources, redacted. configKeys names the credential fields; configured
     says whether they all hold something. A source that is enabled but unhealthy
     says so — "已启用" is a statement about the flag, not about whether it works. */
  $('setsources').innerHTML = data.sources.length === 0
    ? emptyState('not-recorded', {
      subject: '数据源记录',
      next: '数据源由插件声明后写进库，正常不会为空 —— 空的话说明迁移或初始化没跑完，别当成「还没有来源」。',
    })
    : '<table><thead><tr><th>源</th><th>类型</th><th>启用</th><th>凭据</th>'
      + '<th>健康</th><th>凭据字段</th></tr></thead><tbody>'
      + data.sources.map(source => {
        const health = (data.health || {})[source.id] || {};
        const ok = health.ok;
        return '<tr>'
          + '<td><code>' + escapeHtml(source.id) + '</code><br><span class="opt-meta">'
            + escapeHtml(source.name || '') + '</span></td>'
          + '<td>' + escapeHtml(source.kind || '') + '</td>'
          + '<td><input type="checkbox" data-srcid="' + escapeHtml(source.id) + '"'
            + (source.enabled ? ' checked' : '') + '></td>'
          + '<td>' + (source.configKeys.length === 0
            ? '<span class="chip">未配置</span>'
            : source.configured ? '<span class="chip ok">已配置</span>' : '<span class="chip warn">不完整</span>') + '</td>'
          + '<td title="' + escapeHtml(health.detail || '') + '">' + (ok === null || ok === undefined
            ? '<span class="chip">未探测</span>'
            /* T67（ui-terms-review §5）：健康列改定稿词 —— 「ok」英文裸奔、「异常」违反
               禁令 1（没说哪里错、怎么办）。title 保留 health.detail（哪里错了）。 */
            : ok ? '<span class="chip ok">正常</span>' : '<span class="chip warn">探测未过</span>') + '</td>'
          + '<td>' + (source.configKeys.length === 0
            ? '—'
            : source.configKeys.map(key => '<code>' + escapeHtml(key) + '</code>').join(' ')) + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table>'
      + '<div class="hint">凭据<strong>只写不读</strong>：这里显示的是字段名，值永远不出库、不出页面、不出日志。'
      + '写入请让 agent 调 <code>amzn_source_upsert</code>（例如「把卖家精灵的 secret-key 设成 …」）。'
      + '启用只代表「会尝试用它」，是否真的能用看「健康」列。</div>';

  for (const box of $('setsources').querySelectorAll('input[data-srcid]')) {
    box.onchange = () => saveSourceEnabled(box.dataset.srcid, box.checked);
  }

  /* Product lines. This section exists because product_line.signals_json could
     only be read and written from the conversation: the column decides which
     keywords land in a line, and until now nothing on the page showed it — so
     "why is this keyword in that line" had no answer the reader could see.

     The status is a named mode, not a count, because two of the four states need
     opposite fixes and a count would show them identically. */
  const lines = data.productLines || [];
  /* The four category names come from the module that owns them, embedded like
     MODULE_GROUPS is — a second hand-typed copy inside this template literal
     would be the copy that goes stale. */
  const categoryTotal = line => {
    if (!line.categories) return Array.isArray(line.signals) ? line.signals.length : 0;
    return SIGNAL_CATEGORIES.reduce((sum, key) => sum + ((line.categories[key] || []).length), 0);
  };
  const signalChip = line => {
    if (line.mode === 'empty') return '<span class="chip warn">已清空（不匹配任何词）</span>';
    /* Q-1 裁决（lead 2026-10-23）：broken 的代码语义是 signals:null —— **不分类任何词**；
       「按内置处理」是 builtin 模式的行为，两码事。文案照实写；将来若要做内置回落，
       那是显式功能，不许文案冒充。 */
    if (line.mode === 'broken') return '<span class="chip warn">格式不对（不匹配任何词）</span>';
    if (line.mode === 'custom') return '<span class="chip ok">已自定义 ' + categoryTotal(line) + ' 词</span>';
    return line.builtin === null
      ? '<span class="chip">无内置（不匹配任何词）</span>'
      : '<span class="chip">默认（内置 ' + line.builtin.length + ' 词）</span>';
  };
  const CATEGORY_LABEL = { core: '核心', exclude: '排除', scenario: '场景', material: '材质' };
  const CATEGORY_ATTR = { core: 'linekey', exclude: 'lineexclude', scenario: 'linescenario', material: 'linematerial' };
  $('setlines').innerHTML = (lines.length === 0
    ? emptyState('not-recorded', {
      subject: '产品线',
      next: '产品线是 ASIN 库的分组维度，下面新建一条之后，amzn_asin_upsert 才能用 product_line_id。',
    })
    : '<table><thead><tr><th>id</th><th>名称</th><th>版本</th><th>ASIN 数</th><th>信号词</th><th>改</th></tr></thead><tbody>'
      + lines.map(line => {
        const cats = line.categories || {};
        const field = (key) => {
          const placeholder = key === 'core'
            ? (line.builtin === null ? '（无内置词表）' : line.builtin.join(', '))
            : (key === 'exclude' ? '含这些词就不归这条线' : '');
          return '<label class="sigcell">' + CATEGORY_LABEL[key]
            + '<input data-' + CATEGORY_ATTR[key] + '="' + escapeHtml(line.id) + '" type="text" value="'
            + escapeHtml((cats[key] || []).join(', ')) + '" placeholder="' + escapeHtml(placeholder) + '"></label>';
        };
        return '<tr>'
          + '<td><code>' + escapeHtml(line.id) + '</code></td>'
          + '<td>' + escapeHtml(line.name) + '</td>'
          + '<td>v' + escapeHtml(String(line.version || 1)) + '</td>'
          + '<td>' + line.asinCount + '</td>'
          + '<td>' + signalChip(line) + '</td>'
          + '<td>' + SIGNAL_CATEGORIES.map(field).join('')
            + '<div class="sigbtns">'
            + '<button data-linesave="' + escapeHtml(line.id) + '">保存</button>'
            + '<button data-linepreview="' + escapeHtml(line.id) + '">预览影响</button>'
            + (line.mode === 'custom' || line.mode === 'empty'
              ? '<button data-linebuiltin="' + escapeHtml(line.id) + '">恢复默认</button>' : '')
            + (line.mode === 'builtin' || line.mode === 'custom'
              ? '<button data-lineempty="' + escapeHtml(line.id) + '">清空</button>' : '')
            + '</div>'
            + '<div class="opt-meta" id="linepreview-' + escapeHtml(line.id) + '"></div>'
          + '</td></tr>';
      }).join('')
      + '</tbody></table>')
    + '<div class="bar" style="border-bottom:0;padding-left:0;padding-right:0">'
    + '<input id="lineNewId" type="text" placeholder="新 id（如 outdoor-speakers）" style="width:210px">'
    + '<input id="lineNewName" type="text" placeholder="名称（如 户外音箱）" style="width:150px">'
    + '<input id="lineNewSignals" type="text" placeholder="核心词，逗号分隔" style="width:230px">'
    + '<button data-linenew="1">新建产品线</button>'
    + '</div>'
    + '<div class="hint">四类信号是<strong>一份数据</strong>：核心 / 场景 / 材质命中即归属，'
    + '<strong>排除</strong>命中则<strong>不</strong>归属。缺一个类 = 该类为空，<strong>不回落</strong>内置词表。'
    + '「留空并保存」会让这条线<strong>不匹配任何词</strong>；「恢复默认」= 回到代码里的内置词表 —— 两者相反，所以是两个按钮。'
    + '改信号会<strong>造一个新版本</strong>（旧版本仍可读）；分类在下一次<strong>总库重算</strong>时生效。'
    + '「预览影响」用与保存<strong>同一个函数</strong>算，所以预览的数字就是保存后的数字。</div>';

  for (const button of $('setlines').querySelectorAll('button[data-linesave]')) {
    button.onclick = () => {
      const id = button.dataset.linesave;
      saveProductLine(id, readLineCategories(id));
    };
  }
  for (const button of $('setlines').querySelectorAll('button[data-linepreview]')) {
    button.onclick = () => previewProductLine(button.dataset.linepreview);
  }
  for (const button of $('setlines').querySelectorAll('button[data-linebuiltin]')) {
    button.onclick = () => saveProductLine(button.dataset.linebuiltin, null);
  }
  for (const button of $('setlines').querySelectorAll('button[data-lineempty]')) {
    button.onclick = () => saveProductLine(button.dataset.lineempty, { core: [], exclude: [], scenario: [], material: [] });
  }
  for (const button of $('setlines').querySelectorAll('button[data-linenew]')) {
    button.onclick = () => {
      const id = $('lineNewId') ? $('lineNewId').value : '';
      const name = $('lineNewName') ? $('lineNewName').value : '';
      const core = $('lineNewSignals') ? $('lineNewSignals').value : '';
      saveProductLine(id, { core: splitList(core), exclude: [], scenario: [], material: [] }, { name });
    };
  }

  /* The verified market facts, read-only. editable: false is spelled out rather
     than implied by the absence of inputs, so a future reader sees the decision
     instead of guessing it was an oversight. */
  $('setfacts').innerHTML = '<table><thead><tr><th>站点</th><th>标题上限</th>'
    + '<th>核验来源</th><th>字符单位</th><th>可改</th></tr></thead><tbody>'
    + (data.facts || []).map(fact => '<tr>'
      + '<td><code>' + escapeHtml(fact.code) + '</code><br><span class="opt-meta">'
        + escapeHtml(fact.label || '') + '</span></td>'
      + '<td>' + (fact.titleMax === null || fact.titleMax === undefined ? '—' : escapeHtml(String(fact.titleMax))) + '</td>'
      + '<td>' + (fact.authoritative
        ? '<span class="chip ok">已核验</span>'
        : '<span class="chip warn">未核验（仅 Amazon 通用档）</span>') + '</td>'
      + '<td>' + (fact.units
        ? escapeHtml([fact.units.length, fact.units.weight, fact.units.temperature].filter(Boolean).join(' / '))
        : '—') + '</td>'
      + '<td><span class="chip">否</span></td>'
      + '</tr>').join('')
    + '</tbody></table>'
    + '<div class="hint">这些<strong>不是设置</strong>：它们是已核验的市场事实（<code>domain/rules/marketplaces.js</code>）。'
    + '能改它，就等于能改「这个标题合不合法」的答案 —— 所以只有 <code>amzn_setting_set</code> 拒绝它们、'
    + '这里也不提供输入框。标「未核验」的站点用的是 Amazon 通用档，别当成该站的确切规定。</div>';
}

/* One setting, one POST. The server validates by name and range, so a value the
   store refuses comes back as the store's own sentence — the page does not
   duplicate the rule and therefore cannot disagree with the tool. */
async function saveSetting(key, value) {
  let payload = value;
  if (payload === undefined) {
    /* A boolean reads its control's checked flag, not its value: the string
       "true" is not the boolean the store accepts, and that mismatch is the
       whole reason this branch exists. */
    const box = $('setform').querySelector('input[data-setbool="' + key + '"]');
    if (box) {
      payload = box.checked;
    } else {
      const input = $('setform').querySelector('input[data-setkey="' + key + '"]')
        || $('setmarkets').querySelector('input[data-mktkey="' + key + '"]');
      if (!input) return;
      payload = input.value;
    }
  }
  try {
    await api('setting-set', { method: 'POST', body: JSON.stringify({ key, value: payload }) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* One workspace, one POST. The action picks the lifecycle edge; the store is what
   decides whether it is legal (a default cannot be archived, an archived one
   cannot become default), and its refusal is shown verbatim. */
async function saveWorkspace(body) {
  try {
    /* Through the approval-aware POST: the archive edge is gated when this
       workspace has turned that on, and the other four are not. One call site
       rather than a branch here — the helper only special-cases 409, so every
       other action behaves exactly as before. */
    await apiWithApproval('workspace-save', body);
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* The site's editable half: a note (and, later, the localisation preferences).
   The factual half has no route at all, which is the structural way of saying
   "these are not yours to edit". */
async function saveSiteProfile(body) {
  try {
    await api('site-save', { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* Recording that a person checked this site's rules. The actor is not sent: the
   server records "local", and "system-seed" — the migration's value — is refused
   there, so the page cannot claim a self-report was a verification. */
async function saveSiteVerification(marketplace) {
  try {
    await api('site-verify', { method: 'POST', body: JSON.stringify({ marketplace }) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* One shop, one POST. An omitted marketplace stays omitted: a shop that has not
   been tied to a site yet is a real state, and defaulting it to US would put a
   claim in the row that nobody made. */
async function saveShop(body) {
  try {
    await api('shop-save', { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* One brand, one POST. Only the fields the form actually edited are sent, so the
   three-state contract (undefined keeps / null clears / [] empties) survives the
   round trip — sending every field every time would turn "I did not touch the
   aliases" into "set the aliases to what the page last saw". */
async function saveBrand(body) {
  try {
    await api('brand-save', { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* A manual ownership record. It does not delete the automatic one — the store
   keeps both and the manual tier wins, which is what makes an override
   reversible. A self/competitor contradiction comes back as a 409 with the
   reason; the page shows it rather than pretending the click worked. */
async function saveOwnership(body) {
  try {
    await api('ownership', { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* A comma-separated box into a list. Blanks are dropped rather than stored: an
   empty alias matches nothing and would sit in the list looking like a rule. */
function splitList(value) {
  return String(value || '').split(',').map(part => part.trim()).filter(part => part !== '');
}

/* Enabling / disabling a source from the page. A separate route from
   setting-set because it writes source, not setting — and the two have
   different rules about what a legal value is. */
async function saveSourceEnabled(id, enabled) {
  try {
    await api('source-save', { method: 'POST', body: JSON.stringify({ id, enabled }) });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* The signals box for one product line, found by walking the rows rather than by
   a CSS selector: a line id is user-supplied text and would have to be escaped
   for a selector, which is one more place to get quoting wrong for no gain. */
/* The four boxes for one line, as a four-category object.
   An empty box is an empty category — not "unchanged" — because the row's other
   two buttons ("恢复默认" / "清空") are how the reader says those two things, and
   a save that silently kept an old value would make the boxes lie about what is
   stored. */
function readLineCategories(id) {
  const read = key => {
    for (const input of $('setlines').querySelectorAll('input[data-' + key + ']')) {
      if (input.dataset[key] === id) return splitList(input.value);
    }
    return [];
  };
  return {
    core: read('linekey'),
    exclude: read('lineexclude'),
    scenario: read('linescenario'),
    material: read('linematerial'),
  };
}

/* One product line, one POST.

   The signals argument carries the states straight through — a four-category
   object to override, null to reset to the built-in — because they mean
   different things and the store is what acts on the difference. */
async function saveProductLine(id, signals, extra) {
  if (String(id === null || id === undefined ? '' : id).trim() === '') {
    showPageError(new Error('产品线 id 不能为空'));
    return;
  }
  try {
    await api('product-line-save', {
      method: 'POST',
      body: JSON.stringify({ id, signals, ...(extra || {}) }),
    });
  } catch (error) {
    showPageError(error);
  } finally {
    await refresh();
  }
}

/* The impact preview. A POST because the body carries the proposed signals, and
   a **read**: it writes nothing, which is why the version on screen must not
   move after pressing it. The number comes from the same classification the save
   runs, so the two cannot disagree. */
async function previewProductLine(id) {
  const box = $('linepreview-' + id);
  try {
    const data = await api('product-line-preview', {
      method: 'POST',
      body: JSON.stringify({ id, signals: readLineCategories(id) }),
    });
    if (box === null) return;
    const p = data.preview;
    box.textContent = '预览：覆盖 ' + p.keywords + ' 词 / ' + p.asins + ' ASIN'
      + '（原 ' + p.before.keywords + ' 词 / ' + p.before.asins + ' ASIN，'
      + '新增 ' + p.delta.added + '，移出 ' + p.delta.removed + '）—— 没有写库';
  } catch (error) {
    if (box !== null) box.textContent = '预览失败：' + (error && error.message ? error.message : String(error));
    else showPageError(error);
  }
}

/* ── 工作台首页 ──────────────────────────────────────────────────────────── */

/* The six health cards. Each one is drawn with its conclusion, its denominator
   and when it was last updated — a rate without a denominator is an opinion, and
   a number without a timestamp cannot be told from yesterday's.

   Three states are drawn differently on purpose: "normal" shows the rate,
   "empty" says 「暂无数据」 (which is not 0%), and "error" says the card could
   not be computed and why. A failed card is a card, not a hole: the other five
   are still true and the reader still has a page.

   NB: no backticks in this comment — it sits inside the script string. */`
