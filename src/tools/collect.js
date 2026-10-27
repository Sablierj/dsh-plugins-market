/**
 * Collection tools.
 *
 * `submit` and `status` are two tools rather than one blocking call, and that
 * is the whole design of this file: collection takes minutes, the agent should
 * not spend the turn waiting, and the task row is what survives in between.
 *
 * `doctor` is the third one and it exists because of a specific failure mode.
 * When Amazon changes its DOM, a scraper does not crash — it returns nulls. The
 * library fills with empty rows, the page looks fine, and nobody knows why.
 * `doctor` loads one real page and reports which selector matched each field, so
 * the answer to "why is the title empty" is one call away instead of an
 * afternoon. It writes nothing.
 */

import { num, table, text, truncate } from './render.js'
/* T56: submit now delegates to `submitCollectionTask`, which owns the batch
   approval gate (and preview/env/plan/cap). Keeping a second copy here would be
   the two-safety-paths bug this task removes. */
/* The exit a person reads after a block: one text builder, three doors (this
   tool, the doctor below, and the `10-cooldown` environment item). */
import {
  blockedPageExit, installedCooldown, liveReading,
} from '../domain/collect/blocked-page.js'
import { siteCooldown } from '../domain/collect/env.js'
import { getCollectionTask } from '../store/queries.js'

const STATUS_LABEL = {
  queued: '排队中',
  running: '进行中',
  done: '完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  ok: '成功',
  blocked: '风控拦截',
  notfound: '页面不存在',
  'selector-miss': '选择器未命中',
  'wrong-storefront': '站点不符已拒收',
  error: '出错',
}

const label = (status) => STATUS_LABEL[status] ?? status ?? '—'

export function collectSubmitTool({ collection, sources, store }) {
  return {
    name: 'amzn_collect_submit',
    description:
      'Submit a collection task and return immediately with a task id. The work runs in the background; '
      + 'poll it with amzn_collect_status. '
      + 'Call amzn_source_list first if you are not sure which source to use. '
      + 'This drives a real Chrome against the live sites and writes to the library, so confirm the target list '
      + 'with the user before submitting when the ASINs came from a guess rather than from data they gave you. '
      + 'Every target is switched to its own storefront first — interface language and currency by cookie, and the '
      + 'delivery address by clicking through Amazon\'s own dialog — so a task mixing marketplaces gets each one right. '
      + 'Keep batches small: the default cap is 50 ASINs per task, and pacing means a batch takes minutes, not seconds.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source id to collect from. Default browser-local.' },
        targets: {
          type: 'array',
          description: 'What to collect.',
          items: {
            type: 'object',
            properties: {
              asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
              marketplace: { type: 'string', description: 'Marketplace code, e.g. US / DE / JP. Default US.' },
            },
            required: ['asin'],
          },
        },
        asins: {
          type: 'array',
          description: 'Shorthand: a plain list of ASINs, all using `marketplace`. Use instead of `targets`.',
          items: { type: 'string' },
        },
        marketplace: { type: 'string', description: 'Marketplace for the `asins` shorthand. Default US.' },
        /* 与 `amzn_collect_preview` 的「自有 / 竞品」两栏同名同义 —— 两个入口必须认
           同一组形状，否则照着预览提交会失败（2026-10-25 实测 R-2）。 */
        selfAsins: {
          type: 'array',
          description: 'Shorthand: our own ASINs (side=self). Same field name and meaning as amzn_collect_preview.',
          items: { type: 'string' },
        },
        competitorAsins: {
          type: 'array',
          description: 'Shorthand: competitor ASINs (side=competitor). Same field name and meaning as amzn_collect_preview.',
          items: { type: 'string' },
        },
        fields: {
          type: 'array',
          description: 'Only collect these fields. Omit for every field the source can provide.',
          items: { type: 'string' },
        },
        perTaskMax: { type: 'number', description: 'Raise the per-task cap for this submission. Default 50.' },
        humanize: { type: 'boolean', description: 'Dispatch mouse movement and scrolling. Default true.' },
        strictStorefront: {
          type: 'boolean',
          description:
            'Default true. Refuse to store a target whose page came back on a different storefront, in a different '
            + 'language, or priced in a different currency. Set false only when you have looked at why it is failing '
            + 'and want the data anyway — the mismatches are still recorded in the snapshot.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Set true to confirm a BATCH (more than one target) when this workspace has turned on the 批量采集 '
            + '二次确认. Without it a batch is refused with code APPROVAL_REQUIRED and nothing is submitted. '
            + 'A single target never needs it.',
        },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const targets = buildTargets(args)

      /* T56：这个入口不再直接 `collection.submit`。两个提交入口两套安全保证是
         一个真实缺口：submit 只看冷却，不看 preview/ownership/env/plan-window/
         cap。这里统一走 `submitCollectionTask`（与 amzn_collect_run 同一个函数），
         失败按它给出的 code / error / hint 原样返回，不静默提交。 */
      if (typeof collection?.submitCollectionTask !== 'function') {
        return {
          ok: false,
          code: 'COLLECT_RUN_REQUIRED',
          error: '这个 profile 没有注册 collect_run 的安全前置（submitCollectionTask），拒绝直接提交。',
          hint: '用 amzn_collect_run 提交；它会在建任务前做 ownership / 环境 / 计划窗口 / 配额检查。',
        }
      }
      const submitted = await collection.submitCollectionTask({
        ...args,
        source: String(args?.source ?? 'browser-local'),
        targets,
        fields: Array.isArray(args?.fields) ? args.fields : null,
      })
      if (submitted.ok !== true) {
        /* submitCollectionTask 的冷却拒绝带 risk（cooldownUntil），但不带
           `cooling[]`；工具面统一成 cooling 数组，人能看到是哪个站点、到几点。 */
        const cooling = Array.isArray(submitted.cooling)
          ? submitted.cooling
          : (submitted.code === 'COOLING_DOWN'
            ? [{
              marketplace: submitted.preview?.marketplace ?? targets[0]?.marketplace ?? null,
              until: submitted.risk?.cooldownUntil ?? null,
              minutes: submitted.risk?.cooldownMinutes ?? null,
            }]
            : null)
        return {
          ...submitted,
          cooling,
          text: [
            '提交失败：' + String(submitted.error ?? submitted.code ?? '未知原因'),
            submitted.hint ? '提示：' + submitted.hint : '',
            submitted.taskId ? '任务: ' + submitted.taskId + '（可查状态或修复后重试）' : '',
          ].filter(Boolean).join('\n'),
        }
      }

      const marketplaces = [...new Set(submitted.targets.map(target => target.marketplace))]
      const available = await sources.list({ checkHealth: false })
      const source = available.find(item => item.id === submitted.source)

      return [
        `采集任务已提交: ${submitted.taskId}`,
        `状态: ${label(submitted.status)}    源: ${submitted.source}（${source?.transport ?? '?'}）`,
        `目标: ${submitted.total} 个 ASIN（站点 ${marketplaces.join(', ')}）`,
        `预计: 约 ${submitted.estimatedMinutes} 分钟（含拟人化节奏，不是卡住了）`,
        '',
        '采集在后台进行，本次调用立即返回。',
        `查进度: amzn_collect_status(taskId="${submitted.taskId}")`,
        source?.id === 'browser-local'
          ? '说明: 首次采集会自动拉起采集专用 Chrome（独立 profile，不与日常浏览器共用）。'
          : '',
        '说明: 每个目标都会先切到该站点的域名、界面语言与币种，并点开「配送至」弹窗把配送国家改成目标站点'
        + '（配送地址存在亚马逊服务端，只能走界面；改不动时会在结果里说明，不会假装成功），再校验落地站点/语言/币种；'
        + '不符的目标会被拒收并记入结果，不会写进库。',
        marketplaces.length > 1
          ? `提示: 本次混了 ${marketplaces.length} 个站点（${marketplaces.join(', ')}），每个目标各自切换，首次切换会慢几秒。`
          : '',
        '注意: 遇到验证码或风控页会立刻停止整个任务，不会重试或绕过。',
      ].filter(Boolean).join('\n')
    },
  }
}

export function collectStatusTool({ collection, store = null, collector = null }) {
  return {
    name: 'amzn_collect_status',
    description:
      'Check a collection task: status, progress, and the per-target outcome. '
      + 'Pass a taskId from amzn_collect_submit, or omit it to list recent tasks and find out whether anything is running. '
      + 'Use it after submitting, and whenever the user asks whether the collection finished.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id from amzn_collect_submit. Omit to list recent tasks.' },
        limit: { type: 'number', description: 'How many recent tasks to list when taskId is omitted. Default 10.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const taskId = args?.taskId === undefined || args?.taskId === null || args?.taskId === ''
        ? null
        : String(args.taskId)

      if (taskId === null) return renderTaskList(collection.list(Number(args?.limit ?? 10)))

      const found = collection.status(taskId)
      if (found.ok === false) return found
      return renderTaskDetail(found, { store, collector })
    },
  }
}

export function collectDoctorTool({ collector, store = null }) {
  return {
    name: 'amzn_collect_doctor',
    description:
      'Load one real Amazon page and report how it parsed, without writing anything to the library. '
      + 'Use it when collection returns empty fields, when a task reports "选择器未命中", or when targets are '
      + 'rejected for being on the wrong storefront. '
      +         'It names the selector that matched each field and the ones that did not — which is how you tell "Amazon changed '
        + 'their page" apart from "this product genuinely has no BSR" — and it reports the storefront context it applied, '
        + 'the adjustments it had to make (including the delivery address, which is clicked through Amazon\'s own dialog), '
        + 'and whether the page that came back matched it on site, language, and currency. '
      + 'Also confirms whether the page came back as a bot check or a 404.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'ASIN to probe. Any valid ASIN works; a product with a BSR is more informative.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        fields: { type: 'array', description: 'Restrict the report to these fields.', items: { type: 'string' } },
      },
      required: ['asin'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      if (!collector) return { ok: false, error: 'no browser collector is registered in this profile' }

      const report = await collector.doctor({
        asin: args?.asin,
        marketplace: args?.marketplace ?? 'US',
        fields: args?.fields,
      })

      const lines = [
        `选择器自检: ${String(args?.asin ?? '').toUpperCase()}/${String(args?.marketplace ?? 'US').toUpperCase()}`,
        `请求: ${report.requestedUrl ?? report.url}`,
      ]
      if (report.error !== undefined) {
        lines.push(`结果: 无法完成 — ${report.error}`)
        lines.push('', '这一步没有写库。修好浏览器或网络后重试。')
        return lines.join('\n')
      }

      lines.push(`落地: ${report.url}${report.redirected ? '  （发生了重定向）' : ''}`)
      lines.push(`页面标题: ${report.pageTitle ?? '—'}`)

      // The storefront block comes before the field report on purpose: if the
      // page is the wrong marketplace or the wrong language, everything below it
      // is describing the wrong page.
      const storefront = report.storefront
      if (storefront !== undefined && storefront !== null) {
        const session = report.storefrontSession
        lines.push('')
        lines.push(`站点上下文: ${storefront.domain}（${storefront.code}）`)
        lines.push(`  目标界面语言: ${storefront.request}    Accept-Language: ${storefront.header}`)
        lines.push(`  目标币种: ${storefront.currency}    目标配送国家: ${storefront.country}`
          + `${storefront.postalCode ? ` ${storefront.postalCode}` : ''}`)
        lines.push(`  页面实际渲染语言: ${report.lang || '（页面未报告）'}`
          + `    语言 cookie: ${report.langCookie ?? '（无）'}`)
        lines.push(`  页面配送地址: ${report.deliveryLocation ?? '（读不到）'}`)

        if (session !== undefined && session !== null) {
          for (const action of session.actions) lines.push(`  · ${action}`)
          for (const problem of session.problems) lines.push(`  ⚠ ${problem}`)
        }

        const check = report.storefrontCheck
        if (check !== undefined && check !== null) {
          lines.push(check.ok
            ? '  校验: 通过（站点 / 语言 / 币种没有阻断项）'
            : `  校验未通过:\n${check.blocking.map(problem => `    - [${problem.code}] ${problem.detail}`).join('\n')}`)
          // Reported separately because these do not stop a write. The DOM
          // language attribute and the delivery location are both evidence
          // rather than proof — see verifyStorefront for why.
          const advisory = check.problems.filter(problem => problem.severity === 'advisory')
          if (advisory.length > 0) {
            lines.push('  提示（不阻断写入，但值得看一眼）:')
            for (const problem of advisory) lines.push(`    - [${problem.code}] ${problem.detail}`)
          }
        }
      }

      lines.push(`状态: ${label(report.status)}${report.reason ? ` — ${report.reason}` : ''}`)
      lines.push(`页面内等待: ${report.waitedMs ?? '—'} ms`)

      if (report.status === 'blocked') {
        lines.push('', '这是风控页，不是选择器问题。')
        /* The doctor's own tab is closed by the doctor (that is its contract: it
           writes and leaves nothing behind), so what it can hand over is the URL
           — which is the path the real-machine verification used by hand. The
           sentence says that explicitly instead of asking the person to guess. */
        lines.push(...blockedExit({
          reason: report.reason,
          url: report.url ?? report.requestedUrl ?? null,
          label: report.continueLabel ?? null,
          marketplace: String(args?.marketplace ?? 'US').toUpperCase(),
          store,
          collector,
          /* The doctor reads one page and writes nothing, so there is no task row
             behind it: "no cooldown record" and "no task to have one on" are
             different sentences, and the exit says which one applies. */
          hasTask: false,
        }).lines)
        return lines.join('\n')
      }
      if (report.status === 'notfound') {
        lines.push('', '该 ASIN 在这个站点没有商品页。核对 ASIN 与站点是否匹配。')
        return lines.join('\n')
      }

      const matched = report.matched ?? {}
      const entries = Object.keys(matched)
      lines.push('', `选择器命中 (${entries.filter(field => matched[field]).length}/${entries.length}):`)
      lines.push(table(entries.map(field => ({ field, selector: matched[field] })), [
        { label: '字段', value: row => row.field },
        { label: '命中选择器', value: row => row.selector ?? '（全部未命中）' },
      ]))

      const missing = report.missing ?? []
      if (missing.length > 0) {
        lines.push('', `未命中字段: ${missing.join(', ')}`)
        lines.push('可能是该商品确实没有这个字段（例如没有 BSR 的新品），也可能是亚马逊改了结构。'
          + '换一个已知有 BSR 的老品再跑一次就能区分。')
      }

      const parsed = report.fields ?? {}
      const keys = Object.keys(parsed)
      lines.push('', `解析结果 (${keys.length} 个字段):`)
      lines.push(keys.length === 0
        ? '  （空）'
        : table(keys.map(key => ({ key, value: parsed[key] })), [
          { label: '字段', value: row => row.key },
          { label: '值', value: row => truncate(row.value, 70) },
        ]))

      lines.push('', '本次自检没有写入数据库。')
      return lines.join('\n')
    },
  }
}

/* ─────────────────────────────── rendering ─────────────────────────────── */

/**
 * The exit a person reads after a site block — the tool half of the fix.
 *
 * Why it is a function here rather than a sentence in each tool: the two doors
 * (`amzn_collect_status` for a task, `amzn_collect_doctor` for a one-page probe)
 * have to give the **same** instructions, because a person who follows the
 * doctor's advice and then reads the status output must not be told a second,
 * different story. The wording lives in `domain/collect/blocked-page.js`; this
 * function only gathers the facts it needs.
 *
 * The facts are gathered from wherever they actually live, and they are not the
 * same fact:
 *
 *   · the task's own result — its blocked entry carries the target id, the URL and
 *     the control's label (`pageTargetId` / `url` / `continueLabel`), which
 *     survives a restart;
 *   · the running collector's diagnostics — whether **this process** can still see
 *     that page. What a restart takes away is the diagnostic, not the page: the
 *     tab outlives the CDP socket (`dispose` closes the socket, not the tab), so
 *     an empty reading is reported as "cannot read it", never as "it is gone";
 *   · the task's `risk_json` — the cooldown this block installed, and how much of
 *     it is left, which is what the next submission will be refused by.
 */
function blockedExit({
  task = null, result = null, store = null, collector = null,
  reason = null, url = null, label = null, marketplace = null, hasTask = true,
}) {
  const entry = (Array.isArray(result?.results) ? result.results : [])
    .find(row => row !== null && row !== undefined && row.status === 'blocked') ?? null
  const site = marketplace ?? entry?.marketplace ?? task?.targets?.[0]?.marketplace ?? null

  const pageUrl = entry?.url ?? url ?? null
  const targetId = entry?.pageTargetId ?? null
  const control = entry?.continueLabel ?? label ?? null

  /* Live state, matched to **this** page: the target id when the task recorded
     one, the URL as the fallback for rows written before that field existed.
     `liveReading` also answers **why** there is no live page — "this process's
     diagnostics do not hold it" and "no diagnostics were read at all" are two
     different sentences, and neither of them says the tab is gone. See the file
     header of `domain/collect/blocked-page.js` for the measurement behind that. */
  const snapshot = collector === null || collector === undefined ? null : (collector.diagnostics?.() ?? null)
  const reading = liveReading(snapshot, {
    targetId, url: targetId === null ? pageUrl : null, marketplace: site,
  })

  const row = store === null || task === null ? null : (getCollectionTask(store, String(task.id)) ?? null)
  const active = store === null || site === null ? null : siteCooldown(store, site)

  return blockedPageExit({
    marketplace: site,
    reason: reason ?? result?.stopReason ?? null,
    page: targetId === null && pageUrl === null ? null : { targetId, url: pageUrl, continueLabel: control },
    live: reading.page,
    liveRead: reading.liveRead,
    installed: installedCooldown(row),
    active,
    label: control ?? reading.page?.continueLabel ?? null,
    hasTask,
  })
}

function renderTaskList(listed) {
  if (listed.tasks.length === 0) {
    return [
      '还没有任何采集任务。',
      '用 amzn_collect_submit 提交一个，例如 targets=[{asin:"B0XXXXXXXX", marketplace:"US"}]。',
    ].join('\n')
  }

  /* 这一行的主语是**采集器**（内存里的 runner），下面那张表的主语是**库里的行**。
     两个主语不同，用一句话说就会打架：采集器空闲时，表里仍可能有上次中断留下的
     「进行中」，此时只写「当前没有任务在跑」等于否认用户正看着的那一行。
     所以两句分开说，各自标明是谁的状态（与页面那次修复同一个判据）。 */
  const unfinishedRows = listed.tasks.filter(row => row.status === 'running' || row.status === 'queued')
  const lines = [
    listed.running === null
      ? (unfinishedRows.length === 0
        ? `当前没有任务在跑${listed.queue.length > 0 ? `，队列里还有 ${listed.queue.length} 个` : ''}。`
        : `采集器当前空闲，但表里有 ${unfinishedRows.length} 条未结束的行（可能是上次中断留下的）`
          + `${listed.queue.length > 0 ? `，队列里还有 ${listed.queue.length} 个` : ''}`
          + ' —— 采集器空闲 ≠ 表里没有进行中的行。')
      : `当前正在跑: ${listed.running}${listed.queue.length > 0 ? `，队列里还有 ${listed.queue.length} 个` : ''}`,
    '',
    `最近 ${listed.tasks.length} 个任务:`,
    table(listed.tasks, [
      { label: 'task id', value: row => truncate(row.id, 12) },
      { label: '源', value: row => row.source },
      { label: '状态', value: row => label(row.status) },
      { label: '进度', value: row => (row.progress ? `${row.progress.done ?? 0}/${row.progress.total ?? '?'}` : '—') },
      { label: '写入', value: row => num(row.result?.written ?? '') },
      { label: '失败', value: row => num(row.result?.failed ?? '') },
      { label: '提交', value: row => row.submittedAt },
    ]),
  ]

  const unfinished = listed.tasks.find(row => row.status === 'running' || row.status === 'queued')
  if (unfinished !== undefined) {
    lines.push('', `用 amzn_collect_status(taskId="${unfinished.id}") 看这一个的细节。`)
  }
  return lines.join('\n')
}

function renderTaskDetail(found, { store = null, collector = null } = {}) {
  const task = found.task
  const lines = [
    `任务 ${task.id}`,
    `状态: ${label(task.status)}${found.running ? '（正在跑）' : ''}${found.queueDepth > 0 ? `，队列里还有 ${found.queueDepth} 个` : ''}`,
    `源: ${task.source}`,
  ]

  if (task.progress) {
    const phase = task.progress.phase === 'finished' ? '已结束' : task.progress.phase
    lines.push(
      `进度: ${task.progress.done ?? 0}/${task.progress.total ?? task.targets.length}  (${phase}`
      + `${task.progress.asin ? `，当前 ${task.progress.asin}/${task.progress.marketplace ?? ''}` : ''})`,
    )
  }

  lines.push(`提交: ${task.submittedAt}    完成: ${task.finishedAt ?? '—'}`)
  /* 同一个 `fields` 列，两种任务装的是两种东西：
       ASIN 任务 —— 「这次只采这几个字段」的清单（数组）
       关键词扫描 —— 「扫描选项」（{"pages":1,"asins":[...],"strictStorefront":true}，对象）
     2026-10-20 的走查里，查关键词任务就是在这里崩的：`task.fields.join is not a function`，
     而 amzn_keyword_scan 的返回里明写着「用 amzn_collect_status 查」。 */
  if (Array.isArray(task.fields) && task.fields.length > 0) {
    lines.push(`限定字段: ${task.fields.join(', ')}`)
  } else if (task.kind === 'keyword' && task.fields !== null && task.fields !== undefined && typeof task.fields === 'object') {
    const options = task.fields
    const bits = []
    if (options.pages !== undefined) bits.push(`每个词扫 ${options.pages} 页`)
    if (Array.isArray(options.asins) && options.asins.length > 0) bits.push(`目标 ASIN ${options.asins.join('、')}`)
    if (options.strictStorefront === true) bits.push('站点严格校验')
    if (bits.length > 0) lines.push(`扫描设置: ${bits.join(' · ')}`)
  }

  const result = task.result
  if (result !== null && result !== undefined) {
    if (task.kind === 'keyword') {
      /* 关键词扫描的计数器与采集**不是一回事**：它没有「写入/失败」，只有
         「这个词有没有排进前 N 页」。原来这里照采集的口径印「写入 0 / 失败 0」，
         运营读完会以为跑了个寂寞 —— 而实际测量全部进库了（见走查报告 P1-5）。 */
      const rows = Array.isArray(result.results) ? result.results : []
      const ranked = rows.filter(row => Array.isArray(row.found) && row.found.length > 0).length
      const scanned = Number.isFinite(result.scanned) ? result.scanned : rows.length
      lines.push(
        `扫描: ${scanned} 个词    有排名: ${ranked}    无排名: ${Math.max(0, scanned - ranked)}`
        + `${result.blocked ? `    被拦: ${result.blocked}` : ''}`
        + `${result.durationMs ? `    耗时: ${Math.round(result.durationMs / 1000)} 秒` : ''}`,
      )
      if (scanned > 0 && ranked === 0) {
        lines.push('全部无排名也是结论：这些词在扫过的页数里都没出现这个 ASIN —— '
          + '「测过、没排上」与「没测过」在覆盖工具里分开记，不要当成同一个。')
      }
    } else {
      lines.push(
        `写入: ${result.written ?? 0}    失败: ${result.failed ?? 0}`
        + `${result.selectorMiss ? `    选择器未命中: ${result.selectorMiss}` : ''}`
        + `${result.storefrontMiss ? `    站点不符已拒收: ${result.storefrontMiss}` : ''}`
        + `${result.durationMs ? `    耗时: ${Math.round(result.durationMs / 1000)} 秒` : ''}`,
      )
    }
    /* 关键词任务里这个值是**布尔**（整批套了一次站点上下文），不是计数 ——
       直接 > 0 会印出「其中 true 个目标」（2026-10-21 真机所见）。 */
    const adjustedCount = typeof result.storefrontAdjusted === 'boolean'
      ? (result.storefrontAdjusted ? 1 : 0)
      : Number(result.storefrontAdjusted ?? 0)
    if (adjustedCount > 0) {
      lines.push(task.kind === 'keyword'
        ? '扫描前已套用该站点的配送地址/界面语言（站点切换本身，属正常）'
        : `其中 ${adjustedCount} 个目标在采集前调整了配送地址/界面语言`
          + '（这是站点切换本身，属正常；任务里混了多个站点时几乎一定会有）')
    }
    if (result.storefrontMiss > 0) {
      lines.push('被拒收的目标没有写入数据库 —— 站点/语言/币种不符的数据看起来正常，但会污染后续所有报告。'
        + '用 amzn_collect_doctor 看是卡在哪一项。')
    }
    if (result.missingFields?.length > 0) {
      lines.push(`部分字段未采到: ${result.missingFields.join(', ')}`
        + '（用 amzn_collect_doctor 复查是商品没有该字段还是选择器失效）')
    }
    if (result.stopped === 'blocked') {
      /* **Not** "采集失败，请重试". The person has an action, and the collector
         left the page for them to take it on; asking them to try again without
         saying what to click (and without saying that the cooldown will refuse
         them for the next hour) is how a fixable block turns into a support
         thread. See `domain/collect/blocked-page.js`. */
      lines.push('')
      lines.push(...blockedExit({
        task, result, store, collector, reason: result.stopReason ?? null,
      }).lines)
    }
    if (result.stopped === 'no-browser') {
      lines.push('', `采集浏览器没起来: ${result.error ?? ''}`)
    }
  }

  if (task.error !== null) lines.push(`错误: ${task.error}`)

  const outcomes = result?.results ?? []
  if (outcomes.length > 0) {
    lines.push('', `逐目标结果 (${outcomes.length}):`)
    /* 关键词扫描的每一行是 {keyword, depth, pagesScanned, found[], problems[]} ——
       它没有 asin / status / fields。以前照采集的列渲染，于是 8 行全是空白
       （2026-10-21 真机看到的就是这个）。按 kind 分支。 */
    if (task.kind === 'keyword') {
      lines.push(table(outcomes, [
        { label: '关键词', value: row => truncate(row.keyword ?? '', 38) },
        { label: '扫了', value: row => `${row.pagesScanned ?? 0} 页 / 深度 ${row.depth ?? '—'}` },
        { label: '排名', value: row => (Array.isArray(row.found) && row.found.length > 0
          ? row.found.map(hit => `第${hit.page ?? '?'}页#${hit.rank ?? '?'}`).join('、')
          : '未进前列') },
        { label: '问题', value: row => (Array.isArray(row.problems) && row.problems.length > 0
          ? truncate(String(row.problems[0]), 30)
          : '') },
      ]))
    } else {
      lines.push(table(outcomes, [
        { label: 'ASIN', value: row => row.asin },
        { label: '站点', value: row => row.marketplace },
        { label: '结果', value: row => label(row.status) },
        { label: '字段', value: row => (row.fields ? row.fields.length : '') },
        { label: '备注', value: row => truncate(row.reason ?? (row.missing?.length ? `缺 ${row.missing.join('/')}` : ''), 46) },
      ]))
    }
  } else if (task.status === 'queued') {
    lines.push('', `还没开始，队列里有 ${found.queueDepth} 个任务在它前面。`)
  }

  if (task.status === 'running' || task.status === 'queued') {
    lines.push('', '过一会儿再查一次即可；提交后本次对话不必等待。')
  }
  if (task.status === 'partial') {
    lines.push('', '部分完成：已写入的数据是可用的，没采到的目标需要单独再提交一次。')
  }
  return lines.join('\n')
}

/* ─────────────────────────────── arguments ─────────────────────────────── */

/**
 * Accept either `targets` or the `asins` shorthand.
 *
 * The shorthand exists because the common request is "these ten ASINs on US",
 * and making the agent expand that into ten objects is a token tax on every
 * single call. Both forms end up in the same shape.
 */
function buildTargets(args) {
  /* 2026-10-25 真实数据实测抓到的缺陷（R-2）：`amzn_collect_preview` 接受
     `selfAsins` / `competitorAsins`（自有 / 竞品两栏），而 submit 只认 `targets` / `asins`。
     同一批目标，两个入口不认一样的形状 —— 照着 preview 的形状提交会报
     「no targets」，而报错只提 targets/asins，不提 preview 已经接受的那两个，
     于是人只能靠猜把参数改对。

     现在两边认同一组形状。`side` 原样带过去（preview 用它算「自有 N / 竞品 M」，
     采集结果也用它分栏）；三个参数**可以同时给**，按 self → competitor → targets → asins
     的顺序合并并去重（同一个 ASIN 出现两次时以先出现的 side 为准）。 */
  const out = []
  const seen = new Set()
  const push = (asin, marketplace, side) => {
    const key = `${String(asin ?? '').trim().toUpperCase()}@${String(marketplace ?? 'US').toUpperCase()}`
    if (String(asin ?? '').trim() === '' || seen.has(key)) return
    seen.add(key)
    out.push({ asin, marketplace, ...(side ? { side } : {}) })
  }
  const market = args?.marketplace ?? 'US'
  for (const [key, side] of [['selfAsins', 'self'], ['competitorAsins', 'competitor']]) {
    const list = args?.[key]
    if (Array.isArray(list)) for (const asin of list) push(asin, market, side)
  }
  if (Array.isArray(args?.targets)) {
    for (const entry of args.targets) push(entry?.asin, entry?.marketplace ?? market, entry?.side ?? null)
  }
  if (Array.isArray(args?.asins)) for (const asin of args.asins) push(asin, market, null)
  if (out.length > 0) return out
  throw new Error(
    'no targets: pass targets=[{asin, marketplace}] / asins=["B0…"] / selfAsins+competitorAsins '
    + '(same shapes amzn_collect_preview accepts)',
  )
}
