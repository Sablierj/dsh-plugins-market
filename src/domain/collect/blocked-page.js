/**
 * The human-in-the-loop exit for a blocked page.
 *
 * ## The gap this file closes (measured on the real machine, twice)
 *
 * The operator's field knowledge is: "when Amazon serves the interception page,
 * click the button on it and carry on" — the button says `Continue shopping`.
 * The collector left that button nowhere to be clicked: after a block it ran
 * `closePage` in its `finally`, so the browser window ended up on `about:blank`
 * and the person had nothing to press. The verifier only got past the block by
 * opening the page again in the same profile **by hand**. That is a product gap,
 * not an operator mistake, and this module is the half of the fix that speaks to
 * the person.
 *
 * ## What this module may say — and what it must never do
 *
 * It produces **instructions for a person**. It does not retry, does not click,
 * does not fetch, does not clear the site cooldown, and has no code path that
 * could: every function here is pure, and the one in-page script is read-only —
 * `b14-blocked-page.mjs` asserts mechanically that its source contains no
 * `.click(` / `.submit(` / `dispatchEvent` at all.
 *
 * ## Two different facts, kept apart — and the third answer, which is neither
 *
 *   · "this run was stopped by a block, and here is the page it stopped on" —
 *     the task's own record, durable across a restart;
 *   · "that page is still open in the browser right now" — live process state,
 *     which a plugin reload or a browser restart takes away.
 *
 * Writing the second as if it were the first is how a person ends up hunting for
 * a button that is not there. So the caller passes both, and the text says which
 * one it has. The **third** case — this process's own diagnostics are empty, or
 * could not be read at all — is neither of the two, and it is the one this module
 * used to get wrong: "we cannot read it" was rendered as "that page is not in the
 * browser". Measured on the real machine (T-05, the round-4 blocked-page evidence
 * report, kept in `wt-dsh-e2e2\amazon-ops\scratch\e2e-round4\`): a process whose
 * diagnostics no longer held the page printed "那一页现在不在浏览器里", and 21
 * seconds later `/json/list` showed the very CDP target still there, still on the
 * interception page. The cause is structural — `dispose` closes the CDP socket
 * and stops the service, it does **not** close the tab (`index.js` dispose,
 * `collector.close()`).
 *
 * So an empty reading may only ever be reported as "this process cannot read it",
 * with the reason attached, and `liveReading()` below is what keeps the three
 * answers apart. Only a live probe of the browser's own target list can answer
 * "is it there"; a diagnostic snapshot cannot answer it in either direction.
 */

/**
 * The label Amazon's interception page carries (the operator's field report,
 * 2026-10-10). It is a **fallback**, not the answer: the label actually on the
 * page is read by `continueControlProbeScript` and reported when it is there.
 * A person who is told to look for a button that says something else is being
 * sent to guess, which is the whole failure mode this module exists to remove.
 */
export const CONTINUE_CONTROL_LABEL = 'Continue shopping'

/** The known wordings, English and Chinese, of the "yes, carry on" control. */
const KNOWN_LABEL = /continue shopping|keep shopping|continue to amazon|继续购物|继续浏览/i

/**
 * The read-only in-page probe: which control does the person have to click?
 *
 * It answers with the label **the page actually carries** (`{label, tag, source}`)
 * or with `null` when it cannot find one. `null` here means "not found on this
 * page", never "there is no such control" — the caller says so in words rather
 * than inventing a label.
 *
 * Order, and why: a control whose text is one of the known wordings wins (that is
 * the button the field report describes); failing that, any submit control inside
 * the CAPTCHA form, because on that layout the button is the form's own submit.
 * Nothing else is considered — a page-wide "first button" guess would point the
 * person at a nav link.
 *
 * It must stay an **expression** (`(() => …)()`): `evaluate()` hands the string
 * straight to `Runtime.evaluate`, and `buildScript`-style statements would need
 * the caller to wrap them.
 */
export function continueControlProbeScript() {
  return `(() => {
    const clean = (text) => String(text === null || text === undefined ? '' : text).replace(/\\s+/g, ' ').trim();
    const known = /continue shopping|keep shopping|continue to amazon|继续购物|继续浏览/i;
    const readLabel = (node) => clean(node.tagName.toLowerCase() === 'input' ? node.value : node.textContent);
    const controls = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]'));
    for (const node of controls) {
      const label = readLabel(node);
      if (label !== '' && known.test(label)) return { label: label, tag: node.tagName.toLowerCase(), source: 'known-label' };
    }
    const form = document.querySelector('form[action*="validateCaptcha"]');
    if (form !== null) {
      const inside = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]'));
      for (const node of inside) {
        const label = readLabel(node);
        if (label !== '') return { label: label, tag: node.tagName.toLowerCase(), source: 'form-control' };
      }
    }
    return null;
  })()`
}

/**
 * The kept blocked page in a `collector.diagnostics()` snapshot, if it is this one.
 *
 * Identity is the `targetId` when the record has one, and the **URL** is the
 * fallback for rows written before `pageTargetId` existed — the tool has passed
 * that URL since the field was introduced (`src/tools/collect.js`, `blockedExit`),
 * and a fallback the callee silently drops is the same "declared but not done"
 * shape this repository keeps finding: with a missing target id the reader would
 * answer "not in this process's diagnostics" about a page that is right there in
 * the snapshot.
 *
 * Either identity is matched **only when given**: a caller with neither is asking
 * "is there any kept page for this site", and a caller with one is asking "is
 * *this* page still the kept one".
 */
export function liveBlockedPage(snapshot, { targetId = null, url = null, marketplace = null } = {}) {
  const page = snapshot === null || snapshot === undefined ? null : snapshot.blockedPage
  if (page === null || page === undefined) return null
  if (targetId !== null && String(page.targetId ?? '') !== String(targetId)) return null
  if (targetId === null && url !== null && String(page.url ?? '') !== String(url)) return null
  if (marketplace !== null && page.marketplace !== null && page.marketplace !== undefined
    && String(page.marketplace).trim().toUpperCase() !== String(marketplace).trim().toUpperCase()) {
    return null
  }
  return page
}

/**
 * How the live question — "is that page still open?" — was answered.
 *
 * Three answers, and the third is the one that must never be read as a fact about
 * the browser:
 *
 *   · `'kept'` — a snapshot was read and it holds **this** page (target id, or the
 *     URL when the record has no target id, plus the site);
 *   · `'absent'` — a snapshot was read and it does **not** hold it. That is a fact
 *     about this process's memory, not about the browser: the record is dropped by
 *     a restart, and a restart does not close the tab (measured, see the file
 *     header). The page may well still be open — the exit says so in words;
 *   · `'unreadable'` — no snapshot was read at all (no collector injected, or
 *     `diagnostics()` gave nothing). "We could not look" and "we looked and it was
 *     not there" are different sentences.
 *
 * Only a live probe of the browser (`/json/list`-style target listing) can turn
 * either of the last two into "it is not there".
 *
 * @returns {{liveRead: 'kept'|'absent'|'unreadable', page: object|null}}
 */
export function liveReading(snapshot, { targetId = null, url = null, marketplace = null } = {}) {
  if (snapshot === null || snapshot === undefined) return { liveRead: 'unreadable', page: null }
  const page = liveBlockedPage(snapshot, { targetId, url, marketplace })
  return page === null ? { liveRead: 'absent', page: null } : { liveRead: 'kept', page }
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** The risk object of a task row — or of an already-parsed risk blob. */
function riskOf(task) {
  if (task === null || task === undefined) return null
  const raw = typeof task === 'string' ? task : (task.risk_json ?? task.risk ?? null)
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object') return { unreadable: false, value: raw }
  const text = String(raw).trim()
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return { unreadable: true, value: null }
    return { unreadable: false, value: parsed }
  } catch {
    return { unreadable: true, value: null }
  }
}

/**
 * The cooldown a blocked run left behind, read from the task's own `risk_json`
 * (contract §5.3-3 — the same record `siteCooldown` reads).
 *
 * Three answers, and they are not interchangeable:
 *
 *   · `null` — this task has **no** risk record: nothing was blocked, or the
 *     record was never written. "No record" is not "no cooldown";
 *   · `{unreadable: true, …}` — a record exists and cannot be parsed. Reporting
 *     that as `null` is the silent-failure shape this repository keeps finding;
 *   · a readable record — with `minutes` possibly `null` (the record exists but
 *     does not name a duration) and `expired` possibly `null` (no `until`, so
 *     the question cannot be answered from this record alone).
 */
export function installedCooldown(task = null, now = null) {
  const found = riskOf(task)
  if (found === null) return null
  if (found.unreadable === true) {
    return {
      unreadable: true, minutes: null, until: null, remainingMinutes: null, expired: null, reasons: [],
    }
  }
  const risk = found.value ?? {}
  const minutes = Number(risk.cooldownMinutes)
  const until = blankToNull(risk.cooldownUntil)
  const at = now === null || now === undefined ? Date.now() : new Date(now).getTime()
  const remainingMs = until === null || !Number.isFinite(at) ? null : new Date(until).getTime() - at
  return {
    unreadable: false,
    minutes: Number.isFinite(minutes) && minutes >= 0 ? Math.trunc(minutes) : null,
    until,
    remainingMinutes: remainingMs === null || !Number.isFinite(remainingMs) ? null : Math.ceil(remainingMs / 60_000),
    expired: remainingMs === null || !Number.isFinite(remainingMs) ? null : remainingMs <= 0,
    reasons: Array.isArray(risk.reasons) ? risk.reasons.map(String) : [],
  }
}

/**
 * The exit, as the lines a person reads.
 *
 * Every sentence has to carry one of three things: **what to do**, **why**, or
 * **which of the two facts above we actually have**. "采集失败，请重试" is banned
 * here on purpose — it asks the person to guess, and guessing against a bot check
 * is how an account gets flagged.
 *
 * @param {object} options
 * @param {string|null} options.marketplace    site the block happened on
 * @param {string|null} options.reason         the collector's own block reason
 * @param {object|null} options.page           durable record: {targetId, url, continueLabel}
 * @param {object|null} options.live           the same page, still open now (diagnostics)
 * @param {'kept'|'absent'|'unreadable'|null} options.liveRead
 *        how `live` was arrived at, from `liveReading()`. `null` — the caller did
 *        not say — is read as `'unreadable'`, never as `'absent'`: "we did not
 *        look" must not be upgraded into "we looked and it was not there", because
 *        the second is a claim about the browser that a diagnostic snapshot cannot
 *        support.
 * @param {object|null} options.installed      installedCooldown() result
 * @param {object|null} options.active         siteCooldown()'s live state
 * @param {string|null} options.label          the control label, when known
 * @param {number} options.defaultCooldownMinutes
 * @param {boolean} options.hasTask            false for a door with no task behind it
 *                                             (the doctor reads one page and writes
 *                                             nothing) — "no record" and "no task to
 *                                             have a record on" are different facts
 * @returns {{keptPage: boolean, url: string|null, targetId: string|null,
 *            label: string|null, action: string|null, lines: string[]}}
 */
export function blockedPageExit({
  marketplace = null, reason = null, page = null, live = null, liveRead = null,
  installed = null, active = null, label = null, defaultCooldownMinutes = 60, hasTask = true,
} = {}) {
  const site = blankToNull(marketplace) ?? '该站点'
  const target = live ?? page ?? null
  const url = blankToNull(target?.url)
  const targetId = blankToNull(target?.targetId)
  const control = blankToNull(label) ?? blankToNull(target?.continueLabel)
  const keptPage = live !== null && live !== undefined
  /* The reading of the live question. A page object means `'kept'`; otherwise the
     caller's own answer is used, and anything other than the two known words
     (including `null`) means "we could not read it". */
  const read = keptPage
    ? 'kept'
    : (liveRead === 'absent' || liveRead === 'unreadable' ? liveRead : 'unreadable')
  const lines = []

  lines.push('站点返回了拦截页（状态仍是 blocked）—— 采集器按设计停手了：不重试、不绕过、不伪装。')
  if (blankToNull(reason) !== null) lines.push(`拦截原因: ${blankToNull(reason)}`)

  /* ── where the button is ─────────────────────────────────────────────────── */
  const where = control === null
    ? `「${CONTINUE_CONTROL_LABEL}」（这一页上没读到按钮文案，按亚马逊的惯用文案找它）`
    : `「${control}」`
  if (keptPage === true) {
    lines.push(`那一页还开着${targetId === null ? '' : `：CDP target ${targetId}`}${url === null ? '' : `（${url}）`}。`)
    lines.push(`动作：切到采集专用 Chrome 窗口，在那一页上点 ${where}。点完这一页就恢复正常，不用重开浏览器、也不用重新登录。`)
  } else if (url !== null) {
    /* Not live in **this** process — which is a fact about the process, not about
       the browser. `dispose` closes the CDP socket and stops the service; it does
       not close the tab (measured, T-05: the target was still on `/json/list` 21 s
       after the process that recorded it lost the record). So the sentence may say
       "this process cannot read it" and must never say the page is gone. The two
       readings differ in **why** we cannot read it; neither is evidence about the
       tab, and both are followed by the sentence that says what would be. */
    const recorded = targetId === null
      ? '（这条任务没有记下 CDP target id，只能按 URL 认它）'
      : `（任务里记下的是 CDP target ${targetId}）`
    const why = read === 'absent'
      ? '本进程读不到那一页现在还在不在：这个进程的采集器诊断里没有留着它'
      : '本进程读不到那一页现在还在不在：这一轮根本没拿到采集器的诊断快照'
    lines.push(`${why}${recorded}。`)
    lines.push('诊断是内存态、只属于当前进程 —— 插件重启就丢了，而重启并不关页签，'
      + '所以「读不到」推不出「那一页被关掉了」。能证明它在不在的只有对浏览器实时探测一次 target 列表'
      + '（CDP 的 /json/list 那一类）。')
    lines.push(`动作：在采集专用 Chrome 窗口里打开 ${url}（已经开着的话就切到那一页），点 ${where}。`)
  } else {
    lines.push('没有读到那一页的地址，也没有记下它的 CDP target id —— 这次拦截的现场信息是缺的，不要凭猜去找一个页面。')
  }

  /* ── the cooldown, said out loud before the person hits it ─────────────────
     The person has just been told to click a button and then re-run. Re-running
     is exactly what the cooldown from this block refuses (COOLING_DOWN), so
     leaving it out is how the fix turns into "it still says no, I must have
     clicked wrong". One paragraph, always, whoever's job it is to say which
     flavour of "we know / we do not know" applies. */
  const known = installed !== null && installed !== undefined && installed.unreadable !== true
  if (installed === null || installed === undefined) {
    lines.push(hasTask === false
      ? '点完重跑前先看冷却：这次拦截没有任务记录可查（doctor 只读一页、不落库）—— 冷却会不会拦住下一次提交，以体检项 10-cooldown 的读数为准。'
      : '点完重跑前先看冷却：这条任务没有留下冷却记录 —— 冷却会不会拦住下一次提交，以体检项 10-cooldown 的读数为准。')
  } else if (installed.unreadable === true) {
    lines.push('点完重跑前先看冷却：这条任务的冷却记录（risk_json）读不出来 —— 读不到不等于没有，以体检项 10-cooldown 的读数为准。')
  } else if (installed.minutes === null && installed.until === null) {
    lines.push(`点完重跑前先看冷却：拦截给 ${site} 装过站点冷却，但记录里既没有时长也没有截止时间（没有记录时的默认是 ${defaultCooldownMinutes} 分钟）。`)
  } else if (installed.minutes === null) {
    lines.push(`点完重跑前先看冷却：拦截给 ${site} 装的站点冷却至 ${installed.until}，记录里没有时长。`)
  } else if (installed.until === null) {
    lines.push(`点完重跑前先看冷却：拦截给 ${site} 装了 ${installed.minutes} 分钟站点冷却，记录里没有截止时间。`)
  } else {
    lines.push(`点完重跑前先看冷却：拦截给 ${site} 装了 ${installed.minutes} 分钟站点冷却（至 ${installed.until}）。`)
  }

  /* Whether the cooldown is served is a **separate reading** from what this task
     installed: the caller passes `siteCooldown`'s live state when it has one, and
     "no reading at all" must not be mistaken for "not cooling" — that is how a
     refused re-run gets blamed on the person's click. */
  const activeKnown = active !== null && active !== undefined
  if (activeKnown && active.active === true) {
    lines.push(`现在冷却还在：至 ${active.until ?? '（读不到截止时间）'}`
      + `${active.minutesRemaining === null || active.minutesRemaining === undefined ? '' : `，还剩约 ${active.minutesRemaining} 分钟`}。`
      + '这期间提交会被拒，code COOLING_DOWN。')
    lines.push('等到它走完再重跑。这是有意的保护：刚被拦就连着重跑，是账号被更严风控盯上的典型路径，'
      + '所以本插件不会替你清掉冷却，也没有「立即重跑」这条路。')
  } else if (!known) {
    /* Nothing to add: the paragraph above already said which of "no record" and
       "unreadable record" this is, and inventing an expiry here would be a guess. */
  } else if (installed.expired === true) {
    lines.push('冷却已经过期了（上面那个截止时间已经过去），现在可以直接重跑。')
  } else if (installed.expired === null) {
    lines.push('这条记录里没有截止时间，算不出冷却过没过 —— 重跑前先用体检项 10-cooldown 看一次，别硬试。')
  } else if (activeKnown) {
    lines.push('任务里记的冷却按时间还没到期，但站点冷却的实时读数说它已经不在生效了 —— 两者不一致，以 10-cooldown 的实时读数为准。')
  } else {
    lines.push('按这条任务的记录，冷却还没到期（至上面那个时刻）：这期间提交会被拒，code COOLING_DOWN，'
      + '以体检项 10-cooldown 的实时读数为准。')
  }

  /* ── the next step, and it may only be the step **this** reading allows ────
     This line used to be one sentence for every state: 「点完按钮之后重新提交这次采集」.
     That is the sentence the cooldown paragraph right above it contradicts — when the
     block installed a cooldown that is still running, "submit again after clicking" is
     precisely the submission the paragraph says will be refused with COOLING_DOWN, and
     the same exit says 「没有『立即重跑』这条路」. A person who reads all of it and then
     does what the last line says gets a refusal, concludes they clicked wrong, and
     retries — which is the behaviour the cooldown exists to prevent. So the step is
     computed from the **same two readings** the paragraph was computed from, and
     "等" is made executable instead of implied: which clock it is (the task's own
     `risk_json`, whose fields the paragraph printed), what to do while it runs, and
     which tool resumes once it has passed. The vague words are replaced by the tool
     that actually exists — 「提交」 in this repository has a name.

     Kept: the one true half of the old sentence — the blocked run is over and will not
     resume by itself. Dropped: "重新提交", which names no door. */
  if (keptPage === true || url !== null) {
    if (activeKnown && active.active === true) {
      const until = blankToNull(active.until) ?? '上面那个时刻'
      const left = active.minutesRemaining === null || active.minutesRemaining === undefined
        ? '' : `，还剩约 ${active.minutesRemaining} 分钟`
      lines.push(`下一步：等到冷却走完（至 ${until}${left}）之后，用 amzn_collect_run 提交同样的目标。`)
      lines.push('这个时刻来自这条任务自己的记录（risk_json 的 cooldownMinutes / cooldownUntil），'
        + `在 ${until} 之前提交都会被拒（COOLING_DOWN）；想在冷却走完之前确认一次，`
        + '用 amzn_collect_env_check 的 10-cooldown 项读实时值。等的时候不用守着那一页 —— '
        + '被拦的那一次已经结束，不会自己接着跑。')
    } else if (activeKnown || (known && installed.expired === true)) {
      lines.push('下一步：冷却已经不在生效（见上面的读数），直接用 amzn_collect_run 提交同样的目标；'
        + '被拦的那一次已经结束，不会自己接着跑。')
    } else {
      lines.push('下一步：先用 amzn_collect_env_check 的 10-cooldown 项读一次实时冷却，确认它已经过了，'
        + '再用 amzn_collect_run 提交同样的目标；被拦的那一次已经结束，不会自己接着跑。')
    }
  }

  return {
    keptPage,
    url,
    targetId,
    label: control,
    action: keptPage === true ? `在还开着的那一页上点 ${where}` : (url === null ? null : `打开 ${url} 并点 ${where}`),
    lines,
  }
}
