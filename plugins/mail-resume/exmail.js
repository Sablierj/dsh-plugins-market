/**
 * 腾讯企业邮（旧版 webmail）页面驱动层。
 *
 * 事实基础（2026-10 在真实邮箱上验证过，不是猜的）：
 *  - 页面是 frame_html 套一堆 iframe：leftFrame（文件夹树）/ mainFrame（列表与读信）/
 *    actionFrame / toolbarFrame。同源，所以从顶层 document 能一路摸进去。
 *  - 列表行是 <tr>，行里第一个 <input name="mailid"> 带三个金字段：
 *      value   = mailid（去重键）
 *      totime  = 毫秒时间戳（比解析「昨天 22:00」可靠一万倍）
 *      fn / fa = 发件人名 / 发件地址
 *  - 行内没有 <a>、没有 onclick：点击靠事件委托，所以要点 <td class="l">（主题单元格）。
 *  - 读信页的附件是 /cgi-bin/download?mailid=…&filename=…（filename 是 GBK 百分号编码，
 *    而且**不能省**——只给 mailid 会返回一个 HTML 错误页）。
 *  - 读信页的 URL 无法用 fetch 直接拼出来（cgi exception），所以必须真的点开。
 *
 * 于是流程是：点行 → 等读信页 → 抓下载直链 → 页面内 fetch（同源带 Cookie）→ 返回 base64。
 */

/** 摊平 document + 所有同源 iframe；带文本归一化、哈希、框架识别。 */
const PRELUDE = `
const __mrDocs = (function () {
  const out = [];
  const walk = function (d) {
    out.push(d);
    let frames = [];
    try { frames = d.querySelectorAll('iframe,frame'); } catch (e) { frames = []; }
    for (let i = 0; i < frames.length; i += 1) {
      let cd = null;
      try { cd = frames[i].contentDocument; } catch (e) { cd = null; }
      if (cd && out.indexOf(cd) < 0) walk(cd);
    }
  };
  try { walk(document); } catch (e) { /* 顶层都拿不到就只能空手而归 */ }
  return out;
})();
const __mrTxt = function (el) {
  if (!el) return '';
  const raw = typeof el.innerText === 'string' && el.innerText ? el.innerText : (el.textContent || '');
  return String(raw).replace(/\\s+/g, ' ').trim();
};
const __mrHash = function (s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'k' + (h >>> 0).toString(36);
};
const __mrName = function (d) {
  let n = '';
  try { n = (d.defaultView && d.defaultView.name) || ''; } catch (e) { n = ''; }
  return n;
};
// 左侧文件夹树/工具栏框架：那里也有「boss直聘」这种文字，但它是导航不是邮件
const __mrIsChrome = function (d) {
  const n = __mrName(d);
  return n === 'leftFrame' || n === 'toolbarFrame' || n === 'actionFrame';
};
const __mrFind = function (selector) {
  for (let i = 0; i < __mrDocs.length; i += 1) {
    let hit = null;
    try { hit = __mrDocs[i].querySelector(selector); } catch (e) { hit = null; }
    if (hit) return hit;
  }
  return null;
};
`

const DATE_PATTERN =
  '(?:\\d{1,3}\\s*分钟前|\\d{1,3}\\s*小时前|昨天\\s*\\d{1,2}:\\d{2}|前天\\s*\\d{1,2}:\\d{2}|' +
  '今天\\s*\\d{1,2}:\\d{2}|\\d{1,2}月\\d{1,2}日|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}:\\d{2})'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 页面是否还在登录页。 */
export async function detectLogin(cdp) {
  return cdp.evaluate(
    `(() => {
      ${PRELUDE}
      const href = String(location.href || '');
      const text = __mrTxt(document.body).slice(0, 6000);
      const onLoginUrl = /\\/login/i.test(href);
      const hasLoginHint = /扫码登录|企业微信扫码|其他方式登录|账号登录/.test(text);
      const signedIn = /@[\\w.-]+\\.[a-z]{2,}/i.test(text) && /收信|收件箱|写信/.test(text);
      return {
        href: href,
        title: document.title,
        onLoginUrl: onLoginUrl,
        hasLoginHint: hasLoginHint,
        signedIn: signedIn,
        loggedIn: !onLoginUrl && (signedIn || !hasLoginHint),
      };
    })()`,
    { awaitPromise: true },
  )
}

/** 在左侧树里找某个文件夹的 mail_list 链接（个人文件夹要先展开才会出现）。 */
async function findFolderHref(cdp, name) {
  const needle = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return cdp.evaluate(
    `(() => {
      ${PRELUDE}
      const needle = '${needle}';
      const search = function (onlyLeft) {
        for (let i = 0; i < __mrDocs.length; i += 1) {
          const d = __mrDocs[i];
          if (onlyLeft && __mrName(d) !== 'leftFrame') continue;
          let as = [];
          try { as = d.querySelectorAll('a[href]'); } catch (e) { as = []; }
          for (let j = 0; j < as.length; j += 1) {
            const t = __mrTxt(as[j]);
            if (!t || t.indexOf(needle) < 0) continue;
            const href = as[j].getAttribute('href') || '';
            if (href.indexOf('mail_list') < 0) continue;
            return as[j].href || href;
          }
        }
        return '';
      };
      return search(true) || search(false);
    })()`,
    { awaitPromise: true },
  )
}

/** 让 mainFrame 导航到指定 URL（等它把列表渲染出来）。 */
async function navigateMainFrame(cdp, href) {
  const ok = await cdp.evaluate(
    `(() => {
      try {
        const frame = window.frames['mainFrame'];
        if (!frame) return false;
        frame.location.href = ${JSON.stringify(String(href))};
        return true;
      } catch (e) {
        return false;
      }
    })()`,
    { awaitPromise: true },
  )
  if (!ok) return false
  await sleep(1600)
  return true
}

/**
 * 从左侧树页面自己的数据里找个人文件夹 id。
 *
 * 实测：个人文件夹不在 DOM 里（树是折叠的、按需 AJAX 加载），但页面把整份清单放在
 * leftFrame.originUserFolders（id / name / unread）。用它拼 mail_list 链接，
 * 比研究怎么展开树可靠得多——不猜接口，用的是页面自己的数据和自己链接里的 sid。
 */
async function resolvePersonalFolderHref(cdp, name) {
  const needle = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return cdp.evaluate(
    `(() => {
      ${PRELUDE}
      const needle = '${needle}';
      let folders = [];
      let leftDoc = null;
      for (let i = 0; i < __mrDocs.length; i += 1) {
        if (__mrName(__mrDocs[i]) === 'leftFrame') { leftDoc = __mrDocs[i]; break; }
      }
      if (!leftDoc) return '';
      try {
        const win = leftDoc.defaultView;
        folders = JSON.parse(JSON.stringify((win && win.originUserFolders) || []));
      } catch (e) { folders = []; }
      if (!folders.length) return '';
      let hit = folders.find(function (f) { return String(f.name || '').trim() === needle; });
      if (!hit) hit = folders.find(function (f) { return String(f.name || '').indexOf(needle) >= 0; });
      if (!hit) return '';
      let tpl = '';
      try {
        const a = leftDoc.querySelector('a[href*="mail_list"]');
        tpl = a ? a.href : '';
      } catch (e) { tpl = ''; }
      if (!tpl) return '';
      try {
        const u = new URL(tpl, location.origin);
        u.searchParams.set('folderid', String(hit.id));
        u.searchParams.set('page', '0');
        u.searchParams.set('loc', 'folderlist,,,' + hit.id);
        ['stype', 'flag', 'fun', 's', 'topmails', 'need_folderlock'].forEach(function (k) {
          u.searchParams.delete(k);
        });
        return u.href;
      } catch (e) {
        return '';
      }
    })()`,
    { awaitPromise: true },
  )
}

/**
 * 进指定文件夹，并保证回到第 1 页。
 * 顺序：页面数据里算出的链接 → 左侧树锚点 → 点树上文字。
 * 链接里都是 page=0，天然是第 1 页。
 */
export async function openFolder(cdp, name) {
  let href = await resolvePersonalFolderHref(cdp, name)
  let listing = null
  if (href) {
    await navigateMainFrame(cdp, href)
    listing = await listMails(cdp, { attempts: 18, intervalMs: 600 })
    if (listing && listing.count) return { ok: true, href, listing }
  }

  // 退路 1：左侧树里已经有锚点（页面加载时恢复了展开状态）
  href = (await findFolderHref(cdp, name)) || ''
  if (href) {
    await navigateMainFrame(cdp, href)
    listing = await listMails(cdp, { attempts: 18, intervalMs: 600 })
    if (listing && listing.count) return { ok: true, href, listing }
  }

  // 退路 2：直接点左侧树上的文字
  const clicked = await clickByText(cdp, name, { preferFrame: 'leftFrame' })
  if (clicked) {
    await sleep(1500)
    listing = await listMails(cdp, { attempts: 15, intervalMs: 600 })
    if (listing && listing.count) return { ok: true, href: '', listing }
  }
  return { ok: false, href: href || '', listing: listing }
}

/** 点一个“自己这句话就是目标”的可点元素；可以指定优先在哪个框架里找。 */
export async function clickByText(cdp, text, { preferFrame = '' } = {}) {
  const needle = String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const prefer = String(preferFrame).replace(/'/g, "\\'")
  return cdp.evaluate(
    `(() => {
      ${PRELUDE}
      const needle = '${needle}';
      const prefer = '${prefer}';
      const clickable = 'a,button,li,span,div';
      const collect = function (onlyPreferred) {
        let best = null;
        for (let i = 0; i < __mrDocs.length; i += 1) {
          const d = __mrDocs[i];
          if (onlyPreferred && __mrName(d) !== prefer) continue;
          let nodes = [];
          try { nodes = d.querySelectorAll(clickable); } catch (e) { nodes = []; }
          for (let j = 0; j < nodes.length; j += 1) {
            const el = nodes[j];
            const own = __mrTxt(el);
            if (!own || own.length > needle.length + 24) continue;
            if (own.indexOf(needle) < 0) continue;
            if (!best || own.length < __mrTxt(best).length) best = el;
          }
        }
        return best;
      };
      const target = (prefer ? collect(true) : null) || collect(false);
      if (!target) return false;
      const clickableTarget = target.closest('a,button,li') || target;
      try {
        clickableTarget.scrollIntoView({ block: 'center' });
        clickableTarget.click();
        return true;
      } catch (e) {
        return false;
      }
    })()`,
    { awaitPromise: true },
  )
}

/**
 * 读当前列表页。返回结构化邮件行（mailid / totime / 发件人 / 主题 / 时间文本）。
 * 会自动等 mainFrame 出内容（最多 attempts × intervalMs），并跳过左侧框架。
 */
export async function listMails(cdp, { attempts = 20, intervalMs = 700 } = {}) {
  const script = `(() => {
    ${PRELUDE}
    const out = [];
    const seenRow = new Set();
    let header = '';
    for (let i = 0; i < __mrDocs.length; i += 1) {
      const d = __mrDocs[i];
      if (__mrIsChrome(d)) continue;
      let inputs = [];
      try { inputs = d.querySelectorAll('input[name="mailid"]'); } catch (e) { inputs = []; }
      for (let k = 0; k < inputs.length; k += 1) {
        const input = inputs[k];
        let tr = input.parentNode;
        while (tr && tr.tagName !== 'TR') tr = tr.parentNode;
        if (!tr || seenRow.has(tr)) continue;
        seenRow.add(tr);
        const mailId = input.getAttribute('value') || '';
        if (!mailId) continue;
        if (!header && d.body) header = __mrTxt(d.body).slice(0, 200);
        const key = 'm:' + mailId;
        try { tr.setAttribute('data-mr-key', key); } catch (e) { /* 不可写就算了 */ }
        const totime = Number(input.getAttribute('totime') || 0);
        out.push({
          key: key,
          mailId: mailId,
          totime: totime > 0 ? totime : null,
          sender: input.getAttribute('fn') || '',
          addr: input.getAttribute('fa') || '',
          unread: input.getAttribute('unread') === 'true',
          subject: __mrTxt(tr.querySelector('td.gt') || tr.querySelector('td.l') || tr).slice(0, 300),
          dateText: __mrTxt(tr.querySelector('td.dt') || '').slice(0, 40),
        });
      }
    }
    // 分页：还有没有「下一页」
    let hasNext = false;
    for (let i = 0; i < __mrDocs.length; i += 1) {
      const d = __mrDocs[i];
      if (__mrIsChrome(d)) continue;
      let nodes = [];
      try { nodes = d.querySelectorAll('a,button,span'); } catch (e) { nodes = []; }
      for (let j = 0; j < nodes.length; j += 1) {
        const t = __mrTxt(nodes[j]);
        if (t.indexOf('下一页') !== 0) continue;
        const cls = String(nodes[j].className || '') + String((nodes[j].parentNode && nodes[j].parentNode.className) || '');
        if (!/dis|gray|disable/i.test(cls)) hasNext = true;
      }
    }
    return { url: location.href, count: out.length, mails: out, hasNext: hasNext, header: header };
  })()`

  let last = { count: 0, mails: [], hasNext: false, header: '' }
  for (let i = 0; i < attempts; i += 1) {
    const rows = await cdp.evaluate(script, { awaitPromise: true })
    if (rows) {
      last = rows
      if (rows.count > 0) return rows
    }
    await sleep(intervalMs)
  }
  return last
}

/** 翻下一页（列表按时间倒序，翻到时间窗外就停）。 */
export async function nextPage(cdp) {
  const clicked = await cdp.evaluate(
    `(() => {
      ${PRELUDE}
      for (let i = 0; i < __mrDocs.length; i += 1) {
        const d = __mrDocs[i];
        if (__mrIsChrome(d)) continue;
        let nodes = [];
        try { nodes = d.querySelectorAll('a,button,span'); } catch (e) { nodes = []; }
        for (let j = 0; j < nodes.length; j += 1) {
          const el = nodes[j];
          const t = __mrTxt(el);
          if (t.indexOf('下一页') !== 0) continue;
          const cls = String(el.className || '') + String((el.parentNode && el.parentNode.className) || '');
          if (/dis|gray|disable/i.test(cls)) continue;
          try { (el.closest('a,button') || el).click(); return true; } catch (e) { return false; }
        }
      }
      return false;
    })()`,
    { awaitPromise: true },
  )
  if (!clicked) return false
  await sleep(1800)
  return true
}

/** 点开一封（按列表页打的 data-mr-key 定位；点主题单元格，靠事件委托生效）。 */
export async function openMail(cdp, key) {
  const safeKey = String(key).replace(/"/g, '')
  const clicked = await cdp.evaluate(
    `(() => {
      ${PRELUDE}
      const el = __mrFind('[data-mr-key="${safeKey}"]');
      if (!el) return false;
      const cell = el.querySelector('td.l') || el.querySelector('td.gt') || (el.tagName === 'TR' ? el : null);
      const target = cell || el;
      try {
        target.scrollIntoView({ block: 'center' });
        // 行内没有 <a>/onclick，靠事件委托；MouseEvent 比 .click() 更贴合真实行为
        const view = (target.ownerDocument && target.ownerDocument.defaultView) || window;
        target.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true, view: view }));
        target.click();
        return true;
      } catch (e) {
        return false;
      }
    })()`,
    { awaitPromise: true },
  )
  if (!clicked) return false

  // 读信页判据：出现 /cgi-bin/download 直链，或列表行消失且出现「发件人：」。
  // 不能用「回复/转发/返回」——列表工具栏里也有「转发」，会立刻误判。
  for (let i = 0; i < 25; i += 1) {
    const state = await cdp.evaluate(
      `(() => {
        ${PRELUDE}
        let listRows = 0;
        let hasDownload = false;
        let hasReadMarker = false;
        for (let i = 0; i < __mrDocs.length; i += 1) {
          const d = __mrDocs[i];
          if (__mrIsChrome(d)) continue;
          try { listRows += d.querySelectorAll('input[name="mailid"]').length; } catch (e) { /* 忽略 */ }
          let as = [];
          try { as = d.querySelectorAll('a[href]'); } catch (e) { as = []; }
          for (let j = 0; j < as.length; j += 1) {
            if (/cgi-bin\\/download/i.test(as[j].getAttribute('href') || '')) { hasDownload = true; break; }
          }
          if (!hasReadMarker && d.body) {
            const t = __mrTxt(d.body).slice(0, 1500);
            if (/发件人[:：]|收件人[:：]|时\\s*间[:：]/.test(t)) hasReadMarker = true;
          }
        }
        return { listRows: listRows, hasDownload: hasDownload, hasReadMarker: hasReadMarker };
      })()`,
      { awaitPromise: true },
    )
    if (state && state.hasDownload) return { opened: true, hasDownload: true }
    if (state && state.listRows === 0 && state.hasReadMarker) return { opened: true, hasDownload: false }
    await sleep(400)
  }
  return { opened: true, hasDownload: false }
}

/** 读信页里所有像附件的链接（优先 /cgi-bin/download 直链）。 */
export async function readAttachments(cdp) {
  const found = await cdp.evaluate(
    `(() => {
      ${PRELUDE}
      const out = [];
      const seen = {};
      for (let i = 0; i < __mrDocs.length; i += 1) {
        const d = __mrDocs[i];
        if (__mrIsChrome(d)) continue;
        let as = [];
        try { as = d.querySelectorAll('a[href]'); } catch (e) { as = []; }
        for (let j = 0; j < as.length; j += 1) {
          const a = as[j];
          const raw = a.getAttribute('href') || '';
          if (!raw || raw.indexOf('javascript:') === 0) continue;
          const isDownload = /cgi-bin\\/download/i.test(raw);
          const looksFile = /\\.pdf|\\.docx?|\\.zip|\\.rar|\\.txt|\\.jpg|\\.png/i.test(raw);
          const byText = /附件|简历|下载/.test(__mrTxt(a));
          if (!isDownload && !looksFile && !byText) continue;
          const abs = a.href || raw;
          if (seen[abs]) continue;
          seen[abs] = true;
          out.push({ href: abs, text: __mrTxt(a).slice(0, 120), isDownload: isDownload });
        }
      }
      return { href: location.href, count: out.length, items: out };
    })()`,
    { awaitPromise: true },
  )
  const result = found || { count: 0, items: [] }
  // 有 exmail 自己的下载直链就只认它：正文里的外链（BOSS 的跟踪链接）不是附件
  const downloads = (result.items || []).filter((item) => item.isDownload)
  if (downloads.length) return { href: result.href, count: downloads.length, items: downloads }
  return result
}

/** GBK 百分号编码的 filename 参数 → 可读文件名（在页面里解，浏览器自带 gb18030）。 */
function decodeNameExpression(hrefVar) {
  return `(function () {
    const raw = ${hrefVar};
    const m = raw.match(/[?&]filename=([^&]*)/);
    if (!m) return '';
    const pct = m[1].replace(/\\+/g, ' ');
    const bytes = [];
    for (let i = 0; i < pct.length; i += 1) {
      const ch = pct.charAt(i);
      if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(pct.substr(i + 1, 2))) {
        bytes.push(parseInt(pct.substr(i + 1, 2), 16));
        i += 2;
      } else {
        const code = pct.charCodeAt(i);
        if (code < 128) bytes.push(code);
      }
    }
    try {
      return new TextDecoder('gb18030').decode(new Uint8Array(bytes)).trim();
    } catch (e) {
      try { return decodeURIComponent(pct).trim(); } catch (e2) { return ''; }
    }
  })()`
}

/** 在页面里 fetch 附件（同源、带 Cookie、跟重定向），返回 base64 与文件名。 */
export async function fetchAttachment(cdp, href, { hintName = '' } = {}) {
  const safeHref = JSON.stringify(String(href))
  const safeHint = JSON.stringify(String(hintName || ''))
  const result = await cdp.evaluate(
    `(async () => {
      const href = ${safeHref};
      const hint = ${safeHint};
      let res;
      try {
        res = await fetch(href, { credentials: 'include' });
      } catch (e) {
        return { ok: false, error: 'fetch 失败：' + String((e && e.message) || e) };
      }
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, status: res.status };
      const disposition = res.headers.get('content-disposition') || '';
      const contentType = res.headers.get('content-type') || '';
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) return { ok: false, error: '附件内容为空' };
      // 拿回来的是一张 HTML 页说明参数不对（例如缺 filename），别当成简历存下来
      const head = String.fromCharCode.apply(null, bytes.subarray(0, 32));
      if (/^\\s*<!DOCTYPE|^\\s*<html|^<!--cgi/i.test(head)) {
        return { ok: false, error: '服务器返回的是网页不是文件（下载直链参数不对）', contentType: contentType };
      }
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      let base64 = '';
      try {
        base64 = btoa(bin);
      } catch (e) {
        return { ok: false, error: '附件编码失败（可能太大）：' + String((e && e.message) || e) };
      }
      let name = '';
      const star = disposition.match(/filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)/);
      if (star) { try { name = decodeURIComponent(star[1].trim()); } catch (e) { name = star[1].trim(); } }
      if (!name) {
        const plain = disposition.match(/filename\\s*=\\s*"?([^";]+)"?/);
        if (plain) { try { name = decodeURIComponent(plain[1].trim()); } catch (e) { name = plain[1].trim(); } }
      }
      if (!name) name = ${decodeNameExpression('href')};
      if (!name && hint) name = hint;
      return { ok: true, size: bytes.length, disposition: disposition, contentType: contentType, name: name, base64: base64 };
    })()`,
    { awaitPromise: true, timeoutMs: 120000 },
  )
  return result || { ok: false, error: '页面没有返回结果' }
}

/** 从读信页回到列表（点「返回」，不猜 URL）。 */
export async function backToList(cdp) {
  const ok = await clickByText(cdp, '返回', { preferFrame: 'mainFrame' })
  if (!ok) return false
  for (let i = 0; i < 20; i += 1) {
    const state = await cdp.evaluate(
      `(() => {
        ${PRELUDE}
        let rows = 0;
        for (let i = 0; i < __mrDocs.length; i += 1) {
          const d = __mrDocs[i];
          if (__mrIsChrome(d)) continue;
          try { rows += d.querySelectorAll('input[name="mailid"]').length; } catch (e) { /* 忽略 */ }
        }
        return { rows: rows };
      })()`,
      { awaitPromise: true },
    )
    if (state && state.rows > 0) return true
    await sleep(400)
  }
  return false
}

/** 把邮箱页面准备好：找到旧版 webmail、确认已登录，并打开指定文件夹。 */
export async function openMailbox(cdp, { mailUrl, folderName, lastMailHref } = {}) {
  const isOldUi = (url) => /exmail\.qq\.com\/cgi-bin\/frame/i.test(String(url || ''))
  let url = await cdp.currentUrl().catch(() => '')
  if (!isOldUi(url)) {
    // 旧版 webmail 只能从「登录后的重定向」进入：frame_html?sid=… 必须带 sid，
    // 直接开 exmail.qq.com 会被跳到 work.weixin.qq.com/mail 的新版客户端。
    const candidates = []
    if (lastMailHref && isOldUi(lastMailHref)) candidates.push(lastMailHref)
    if (mailUrl) candidates.push(mailUrl)
    for (const target of candidates) {
      await cdp.navigate(target).catch(() => {})
      await cdp.waitForReady(30000).catch(() => false)
      url = await cdp.currentUrl().catch(() => '')
      if (isOldUi(url)) break
    }
  }
  if (!isOldUi(url)) {
    const error = new Error('浏览器没有停在企业邮箱旧版 webmail 页面')
    error.code = 'NOT_OLD_UI'
    error.hint =
      '插件只认旧版 webmail（地址形如 exmail.qq.com/cgi-bin/frame_html?sid=…）。在这个浏览器窗口里重新登录一次企业邮箱，' +
      '登录后会自动落到旧版页面；登录态和地址都会被记住，之后一键下载不用再管'
    error.detail = { href: url }
    throw error
  }

  let state = await detectLogin(cdp)
  if (!state.loggedIn) {
    await sleep(1500)
    state = await detectLogin(cdp)
  }
  if (!state.loggedIn) {
    const error = new Error('企业邮箱未登录')
    error.code = 'NOT_LOGGED_IN'
    error.detail = state
    throw error
  }

  const folder = String(folderName || '').trim()
  if (!folder) {
    return { href: state.href, loggedIn: true, folderOpened: false, folder: '', rows: 0, header: '' }
  }

  // 每次进来都进一次目标文件夹：既是进文件夹，也是**回到第 1 页**
  // （上一轮翻到第 N 页时，页面会停在那儿）
  let listing = await listMails(cdp, { attempts: 2, intervalMs: 300 })
  if (!listing || listing.count === 0) {
    await backToList(cdp).catch(() => false)
  }
  let opened = await openFolder(cdp, folder)
  listing = opened.listing || (await listMails(cdp, { attempts: 10, intervalMs: 600 }))
  let header = (listing && listing.header) || ''

  // 硬校验：只认目标文件夹。左侧树没展开完时页面可能还在收件箱/首页，
  // 那种情况下绝不能让上层把它当成「boss直聘 的列表」去扫。
  if (!header.includes(folder)) {
    opened = await openFolder(cdp, folder)
    listing = opened.listing || listing
    header = (listing && listing.header) || ''
  }
  if (!header.includes(folder)) {
    const error = new Error(`没有进到「${folder}」文件夹`)
    error.code = 'FOLDER_NOT_OPENED'
    error.hint =
      `左侧树里的「${folder}」没有打开成功（当前列表：${header.slice(0, 40) || '未知'}）。` +
      '确认文件夹名写对了，或在那个浏览器里手动点开一次再重试'
    error.detail = { header }
    throw error
  }

  return {
    href: await cdp.currentUrl().catch(() => state.href),
    loggedIn: true,
    folderOpened: Boolean(listing && listing.count > 0),
    folder,
    folderHref: opened.href || '',
    rows: (listing && listing.count) || 0,
    header,
  }
}

/** 读 mainFrame 顶部的列表标题（含「共 N 封」「第几页」），用于自检。 */
export async function listHeader(cdp) {
  const info = await cdp.evaluate(
    `(() => {
      ${PRELUDE}
      for (let i = 0; i < __mrDocs.length; i += 1) {
        const d = __mrDocs[i];
        if (__mrName(d) !== 'mainFrame') continue;
        if (!d.body) continue;
        return __mrTxt(d.body).slice(0, 220);
      }
      return '';
    })()`,
    { awaitPromise: true },
  )
  return String(info || '')
}
