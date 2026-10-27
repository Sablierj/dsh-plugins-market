/**
 * dsh-plugin-amazon-ops — the Amazon operations workbench.
 *
 * One row in the profile serves the whole plugin: the model tools, the
 * workbench page, its JSON API, and the progress event stream. `config.plugin`
 * picks the plane, so a second row can be added later without touching this
 * file — the same pattern the user-console plugin uses.
 *
 * Loaded by absolute path from cordis.patch.yml. Plain ESM JavaScript with no
 * dependencies at all: storage is `node:sqlite`, which ships with Node, the CDP
 * client is built on Node's global `WebSocket`, and the page is a string. That
 * is what makes this installable by copying a directory.
 *
 * Boot safety matters more here than usual. A plugin that throws inside apply()
 * fails the WHOLE plugin tree, so the Host never starts listening and the user
 * loses a working service because of a plugin they were only trying out. Setup
 * failures are therefore caught and reported loudly, and the plugin degrades to
 * "registered nothing" instead of taking the deployment down with it.
 *
 * The browser is deliberately NOT started here. Launching a GUI window during
 * plugin load would make every profile startup spawn a browser whether or not
 * anything is collected; it happens on the first collection instead, and the
 * Chrome it starts then outlives the plugin so the profile and login survive.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createBrowserCollector } from './src/sources/browser/collector.js'
import { createBrowserGate, createGatedCollector } from './src/sources/browser/gate.js'
import { createCollectionService } from './src/sources/collection.js'
import { createKeywordService } from './src/sources/keyword.js'
import { createKeywordScheduler } from './src/sources/keyword-scheduler.js'
import { createSourceRegistry } from './src/sources/registry.js'
import { createWorkbench } from './src/state/workbench.js'
import { openStore } from './src/store/db.js'
import { KEEP_DAYS, purgeNotifications } from './src/store/notification.js'
import { scanDueObservations } from './src/store/observe.js'
import { seedRoleConfigs } from './src/store/agent-config.js'
import { registerTools } from './src/tools/index.js'
import { registerWeb } from './src/web/routes.js'

export const name = 'amazon-ops'

/**
 * Only `tools` is required. `webServer` is injected optionally inside apply(),
 * so the plugin still registers its tools in a profile that has no web server
 * (headless) instead of never loading at all.
 */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_PATH = '/custom/amazon-ops'

/**
 * Build the two services that drive the one browser, against ONE gate.
 *
 * Exported because the gate's whole value is that both services receive the
 * *same* instance. Collection and keyword scanning each keep a private queue,
 * but a private queue only orders its own tasks — two services sharing one
 * Chrome can still run a US collection and a DE scan at once, and the storefront
 * cookies are browser-level, so they would overwrite each other (see
 * `src/sources/browser/gate.js`). Wiring these to two separate gates looks
 * identical from the outside and fixes nothing, which is why a test asserts the
 * reference equality of `collection.gate` and `keywords.gate` rather than
 * anything about their shape.
 *
 * The gate is sunk to the collector's resource boundary: `collector` is wrapped
 * with `createGatedCollector` so `collect` / `withPage` / `doctor` are
 * serialised no matter who calls them. That is what closes the bypass the task
 * boundary missed — `amzn_keyword_discover` calls `collector.withPage` and
 * `amzn_collect_doctor` calls `collector.doctor`, neither through a service
 * queue. The wrapped collector is returned so `apply()` can hand the *same*
 * object to the registry and the tools; the wrapping is idempotent, so passing
 * an already-gated collector here is a no-op.
 */
export function createBrowserServices({ store, workbench, sources, collector, logger, pacing, gate, dataDir = null, chromePath = null } = {}) {
  const sharedGate = gate ?? createBrowserGate()
  const browserCollector = createGatedCollector(collector, sharedGate)
  /* The environment check and the repair actions need the collector (to probe the
     port, read the login verdict and read the storefront diagnostics) and the
     data directory (to judge and create the dedicated profile dir). They are
     passed in rather than re-derived: a second `join(dataDir, 'chrome-profile')`
     somewhere else is how the check and the launcher come to look at two
     directories. */
  const collection = createCollectionService({
    store, workbench, sources, logger, pacing, gate: sharedGate, collector: browserCollector, dataDir, chromePath,
  })
  // Keyword scans share the collector's browser, its task table and its queue —
  // and now the same cross-service gate — see src/sources/keyword.js.
  const keywords = createKeywordService({ store, workbench, collector: browserCollector, logger, pacing, gate: sharedGate })
  return { gate: sharedGate, collection, keywords, collector: browserCollector }
}

export function apply(ctx, config = {}) {
  const plane = config.plugin ?? 'workbench'
  if (plane !== 'workbench') {
    console.warn(`[amazon-ops] unknown config.plugin "${plane}"; nothing registered`)
    return
  }

  const dataDir = config.dataDir ? String(config.dataDir) : join(HERE, 'data')
  // 9333, not the CDP default 9222: that port belongs to the amazon-ops-hub
  // deployment on this machine, and attaching there would drive its browser.
  const cdpPort = Number(config.cdpPort ?? 9333)

  let store
  let workbench
  let collector
  let sources
  let collection
  let keywords
let scheduler = null
  try {
    store = openStore({ dataDir, logger: ctx.logger ?? console })
    /* 「保留 30 天」真正发生的地方。不放在 v29 迁移里：迁移只在升级那次跑一遍，
       那样的清理只能删掉升级当天已存在的行，之后列表会一直长。幂等，每次打开都跑
       没有副作用。失败不阻断启动——一个清不掉旧通知的浏览器不该打不开工作台。 */
    try {
      purgeNotifications(store, { keepDays: KEEP_DAYS })
    } catch (error) {
      ;(ctx.logger ?? console).warn?.(`[amazon-ops] notification purge skipped: ${error.message}`)
    }
    /* §15 §6 的「7/14/30 天观测到期」通知真正被算出来的地方。放在打开时跑，理由与
       上面的清理相同：它是一条**时间驱动**的规则，而插件没有常驻定时器，所以「打开
       工作台」就是它唯一的时机。幂等（去重键是节点 id），每次打开都跑没有副作用。
       在此之前 `upsertNotification` 只有测试在调 —— 通知面板在生产里一直是空的。
       失败同样不阻断启动：算不出到期不该让工作台打不开。 */
    try {
      const scan = scanDueObservations(store)
      if (scan.notified.length > 0) {
        ;(ctx.logger ?? console).info?.(`[amazon-ops] observation due scan: ${scan.notified.length} notification(s)`)
      }
    } catch (error) {
      ;(ctx.logger ?? console).warn?.(`[amazon-ops] observation due scan skipped: ${error.message}`)
    }
    /* F12-02：给每个角色播种 v1 配置（默认值 = 代码声明）。放在打开时跑，理由与上面的
       清理 / 到期扫描相同：它必须**每次启动**都成立，而迁移只在升级那次跑一遍。**幂等**
       —— 已经有版本的角色不覆盖，否则每次重启都会把人工发布的版本冲掉（本模块的死穴）。
       失败不阻断启动：读不到配置大不了 `latestRoleConfig` 返回 null，运行会回落到代码声明。 */
    try {
      const seeded = seedRoleConfigs(store)
      if (seeded.seeded > 0) {
        ;(ctx.logger ?? console).info?.(`[amazon-ops] role config seed: ${seeded.seeded} role(s) at v1`)
      }
    } catch (error) {
      ;(ctx.logger ?? console).warn?.(`[amazon-ops] role config seed skipped: ${error.message}`)
    }
    workbench = createWorkbench()
    collector = createBrowserCollector({
      store,
      workbench,
      logger: ctx.logger ?? console,
      host: config.cdpHost ?? '127.0.0.1',
      port: cdpPort,
      profileDir: config.profileDir ? String(config.profileDir) : join(dataDir, 'chrome-profile'),
      chromePath: config.chromePath,
      pacing: config.pacing,
    })
    // The gate is created here and the collector wrapped with it *before* the
    // registry and the tools are built, so every holder of the collector — the
    // collection service (via the registry), the keyword service, the discovery
    // tool and the doctor tool — shares the one lock at the resource boundary.
    // Wrapping here (not only inside createBrowserServices) is what covers the
    // two entry points that never pass through a service queue; the wrap is
    // idempotent so createBrowserServices re-applying it is a no-op.
    const gate = createBrowserGate()
    const browserCollector = createGatedCollector(collector, gate)
    sources = createSourceRegistry(store, { collector: browserCollector, pacing: config.pacing })
    // One browser, one gate: both services get the *same* lock so a collection
    // task and a keyword scan cannot run at once — see createBrowserServices.
    const browserServices = createBrowserServices({
      store,
      workbench,
      sources,
      collector: browserCollector,
      logger: ctx.logger ?? console,
      pacing: config.pacing,
      gate,
      dataDir,
      chromePath: config.chromePath,
    })
    collection = browserServices.collection
    keywords = browserServices.keywords
    // Tools get the gated collector: `amzn_keyword_discover` and
    // `amzn_collect_doctor` reach the browser through it directly.
    collector = browserCollector
    /* 排班计时器：每分钟真的检查一次"到点没有"，而不是等有人打开页面 */
    scheduler = createKeywordScheduler({ store, keywords, logger: ctx.logger ?? console })
    scheduler.start()
  } catch (error) {
    // Loud, but not fatal: the Host must still boot so the user can see why.
    console.error('[amazon-ops] DISABLED — setup failed, no tools or page registered')
    console.error(`[amazon-ops]   ${error.stack ?? error.message}`)
    console.error(`[amazon-ops]   data dir: ${dataDir}`)
    return
  }

  // Tasks left mid-flight by the last shutdown are reconciled before anything
  // can be submitted, so the first status check tells the truth. Each service
  // recovers only its own kind — see recoverStaleTasks.
  try {
    const recovered = collection.recover()
    if (recovered.interrupted.length > 0 || recovered.requeued.length > 0) {
      console.log(
        `[amazon-ops] collection recovery: ${recovered.interrupted.length} interrupted, `
        + `${recovered.requeued.length} re-queued`,
      )
    }
    /* 契约 §5.4 要的第二处调用：启动时扫一次「等待人工」的超时。页面轮询是常态，但一个
       停机三天的库再打开时，第一件事就该是让那些等过头的行到它们的归宿，而不是等页面
       轮询。`waiting_human` 的 `deadlineAt` 不重算，所以这一步只是把它们判到期。 */
    const swept = collection.scanWaitingTimeouts()
    if (swept.cancelled.length > 0 || swept.failed.length > 0) {
      console.log(
        `[amazon-ops] collection timeout sweep: ${swept.cancelled.length} cancelled, ${swept.failed.length} failed`,
      )
    }
  } catch (error) {
    console.warn(`[amazon-ops] collection recovery failed: ${error.message}`)
  }

  try {
    const recovered = keywords.recover()
    if (recovered.interrupted.length > 0 || recovered.requeued.length > 0) {
      console.log(
        `[amazon-ops] keyword recovery: ${recovered.interrupted.length} interrupted, `
        + `${recovered.requeued.length} re-queued`,
      )
    }
  } catch (error) {
    console.warn(`[amazon-ops] keyword recovery failed: ${error.message}`)
  }

  // `pagePath` is in the tool deps so a tool can hand back a link the user can
  // click (the report view). It is the same constant the routes register with,
  // so the link cannot point somewhere the page does not exist.
  const toolNames = registerTools(ctx, {
    store,
    workbench,
    sources,
    collection,
    collector,
    keywordService: keywords,
    keywordScheduler: scheduler,
    pagePath: PAGE_PATH,
    // The keyword-master tools write CSV exports and HTML reports somewhere;
    // putting them beside the database keeps the plugin's whole footprint in
    // one directory, which is what makes it installable by copying a folder.
    dataDir,
    /* 采集中心的体检与修复要看「配置的那一个」浏览器可执行文件与数据目录 —— 两处
       各自推断一次，就是体检与启动器看着两个不同目录的开始。 */
    chromePath: config.chromePath,
  })
  /* The channel the collector will actually drive, passed through so the
     settings page can show it. It is **reported**, not configured from the page:
     the port is an operator's plugin config, and a settings field that did not
     reach the launcher would be a number the collector ignored — which is worse
     than not offering it. */
  registerWeb(ctx, {
    store,
    workbench,
    sources,
    collection,
    collector,
    keywordService: keywords,
    keywordScheduler: scheduler,
    pagePath: PAGE_PATH,
    dataDir,
    chromePath: config.chromePath,
    browserChannel: { host: config.cdpHost ?? '127.0.0.1', port: cdpPort, chromePath: config.chromePath ?? null },
  })

  // Close the database and the CDP socket when the plugin's fiber is disposed,
  // so a profile reload does not leave a second connection behind. The browser
  // itself is left running on purpose: it holds the profile and login state.
  ctx.effect(() => () => {
    try {
      scheduler?.stop()
    } catch { /* 没启动过 */ }
    for (const service of [collection, keywords]) {
      try {
        service.stop()
      } catch {
        /* nothing running */
      }
    }
    try {
      collector.close()
    } catch {
      /* already closed */
    }
    try {
      store.close()
    } catch {
      /* already closed */
    }
  }, 'amazon-ops: store')

  console.log(`[amazon-ops] ${toolNames.length} tools: ${toolNames.join(', ')}`)
  console.log(`[amazon-ops] store: ${store.file}`)
  console.log(`[amazon-ops] browser channel: cdp ${config.cdpHost ?? '127.0.0.1'}:${cdpPort} (started on demand)`)
}

/** Exported for tests and for the pre-flight check to assert against. */
export const TOOLS = [
  'amzn_workbench_context',
  'amzn_workbench_focus',
  'amzn_source_list',
  // B07 — the write half. Credentials go in; only the field names come back.
  'amzn_source_upsert',
  'amzn_asin_query',
  'amzn_asin_get',
  'amzn_asin_upsert',
  /* 模块 05 第一子批：ASIN 数据中心的详情与数据层。五个名字，与 src/tools/index.js 的
     buildTools 逐条对应；**两处必须同时改**（漏一处的后果是工具存在、不可调用、且不报错）。
     读一写四：详情（F05-02 前四个标签页）/ 字段级人工修正（F05-03）/ 变体关系与维度
     （F05-06）/ 纠正一条错误关系（F05-06）/ 归档与恢复（F05-08）。 */
  'amzn_asin_detail',
  'amzn_asin_field_correct',
  'amzn_asin_ownership_set',
  'amzn_asin_variant_upsert',
  'amzn_asin_variant_correct',
  'amzn_asin_competitor',
  'amzn_asin_archive',
  /* B-05e / F05-08 —— 受限删除。与 `src/tools/index.js` 的 `asinDeleteTool(deps)` 逐条对应
     （**两处必须同时改**，漏一处的后果是工具存在、不可调用、且不报错）。
     它没有与归档合成一个工具，理由写在 `tools/asin.js` 的 `asinDeleteTool` 上：
     可逆的确认开关与不可逆的恒定确认不该共用同一个字段。 */
  'amzn_asin_delete',
  /* F05-01 的收尾：17 列的导出，以及保存视图的读 / 存 / 删。四个名字与
     src/tools/index.js 的 buildTools 逐条对应；**两处必须同时改**（漏一处的后果是
     工具存在、不可调用、且不报错）。 */
  'amzn_asin_export',
  'amzn_asin_view_list',
  'amzn_asin_view_save',
  'amzn_asin_view_delete',
  /* B-05c 的第二批：F05-04 历史 diff / F05-07 健康摘要 / F05-05 批量导入。三个名字与
     src/tools/index.js 的 buildTools 逐条对应；**两处必须同时改**（漏一处的后果是
     工具存在、不可调用、且不报错）。前两个只读；第三个默认 dryRun（预览不写库、
     也不落审计行），`dryRun: false` 才写。 */
  'amzn_asin_history',
  'amzn_asin_health',
  'amzn_product_import',
  'amzn_asin_attribute_status',
  'amzn_asin_attribute_set',
  'amzn_asin_import',
  'amzn_product_line_upsert',
  'amzn_shop_upsert',
  /* R-91（需求方指定）—— 字段模板。六个名字，与 `src/tools/field-template.js` 逐条对应；
     **两处必须同时改**（漏一处的后果是工具存在、不可调用、且不报错）。
     读一、写五：读当前模板 / 人手改一版 / AI 研究出提案 / 人工确认 / 回滚（另起一版）/ 两版对照。 */
  'amzn_field_template_get',
  'amzn_field_template_save',
  'amzn_field_template_propose',
  'amzn_field_template_confirm',
  'amzn_field_template_rollback',
  'amzn_field_template_diff',
  'amzn_review_ingest',
  'amzn_product_line_classify',
  'amzn_collect_submit',
  'amzn_collect_status',
  'amzn_collect_doctor',
  // 模块 04 第二子批 — 采集中心的工具面。十二个名字，与 src/tools/index.js 的 buildTools
  // 逐条对应；**两处必须同时改**（漏一处的后果是工具存在、不可调用、且不报错）。
  'amzn_collect_env_check',
  'amzn_collect_repair',
  'amzn_collect_preview',
  'amzn_collect_run',
  'amzn_collect_cancel',
  'amzn_collect_waiting_resolve',
  'amzn_collect_detail',
  'amzn_collect_scheme_list',
  'amzn_collect_scheme_save',
  'amzn_collect_scheme_transition',
  'amzn_collect_plan_list',
  'amzn_collect_plan_save',
  'amzn_keyword_query',
  'amzn_keyword_coverage',
  'amzn_keyword_import',
  'amzn_keyword_discover',
  'amzn_keyword_scan',
  'amzn_optimize_prepare',
  // F13-02（模块 13 第一子批）：九项前置门槛的只读入口。加在这里是必须的 ——
  // 只注册在 src/tools/index.js 而漏了这一处，工具存在但不可调用，而且不会报错。
  'amzn_optimize_precheck',
  'amzn_optimize_validate',
  'amzn_optimize_save',
  'amzn_optimize_report',
  // B-13b（模块 13 第二子批）：收件箱与证据包的两个只读入口。同样必须两处都写 ——
  // 只注册一处的话工具存在但不可调用，且不报错。
  'amzn_optimize_inbox',
  'amzn_optimize_evidence',
  'amzn_optimize_job',
  // B-13c（模块 13 第三子批）：策略阶段与位置计划核对的两个只读入口。同样必须两处
  // 都写 —— 只注册一处的话工具存在但不可调用，且不报错。
  'amzn_optimize_strategy',
  'amzn_optimize_plan_check',
  // B-13d（模块 13 第四子批）：校验体系的统一入口（只读）与 Agent 审阅的读/记入口。
  // 同样必须两处都写 —— 只注册一处的话工具存在但不可调用，且不报错。
  'amzn_optimize_validation',
  'amzn_optimize_review',
  // Step 5 — the keyword master library, built from imported export files
  'amzn_kw_import',
  'amzn_kw_source',
  'amzn_kw_merge',
  'amzn_kw_query',
  'amzn_kw_export',
  'amzn_kw_report',
  /* 排名观测历史：读浏览器扫描留下的一条条曲线，不是导入的事实。 */
  'amzn_kw_rank_history',
  'amzn_kw_scan_schedule',
  // Step 10 — the keyword pipeline (B05): the five stages as one recorded run.
  'amzn_kw_pipeline_run',
  'amzn_kw_pipeline_history',
  // Step 7 — the rule roster (B02). amzn_rule_import writes doc rows only (B02c).
  'amzn_rule_list',
  'amzn_rule_upsert',
  'amzn_rule_activate',
  'amzn_rule_diff',
  'amzn_rule_import',
  // Step 8 — the policy library (B03), upstream of the rule roster.
  'amzn_policy_list',
  'amzn_policy_import',
  'amzn_policy_link',
  // Step 9 — the prompt library (B04): the page's buttons and prepare's strategy.
  'amzn_prompt_list',
  'amzn_prompt_upsert',
  'amzn_prompt_preview',
  /* B-11.2b — 保存即冻结的两半。加在这里是**必须的**：只注册在 src/tools/index.js
     而漏了这一处，工具存在但不可调用，而且不会报错。 */
  'amzn_prompt_history',
  'amzn_prompt_rollback',
  /* B-11.3 / F11-05 — 提示词生命周期。四个工具，读一写三。`amzn_prompt_version_rollback`
     与上面的 `amzn_prompt_rollback` 是两件事：那个换正文，这个换活动版本。 */
  'amzn_prompt_lifecycle_get',
  'amzn_prompt_lifecycle_transition',
  'amzn_prompt_version_activate',
  'amzn_prompt_version_rollback',
  /* F11-09 — 引用追踪（只读反查）。加在这里同样是必须的，理由同上。 */
  'amzn_prompt_references',
  /* F11-07 — 固定评估集。三个：导入、看目录、看一套的全部样例。
     ⚠️ 加在这里是**必须的**：只注册在 src/tools/index.js 而漏了这一处，工具存在
     但不可调用，而且不会报错（本仓反复出现的两文件同步坑）。
     ⚠️ 并且**没有第四个**：本插件没有评估器，一个「跑评估」的工具只能产出编出来的
     通过率 —— 那是把缺失渲染成真实值。 */
  'amzn_prompt_eval_import',
  'amzn_prompt_eval_list',
  'amzn_prompt_eval_show',
  // Step 11 — competitor analysis and keyword research (B06). `research` reads
  // the same three tables and never collects; `competitor_analyze` reads
  // kw_competitor_fact and never collects either.
  'amzn_competitor_set_upsert',
  'amzn_competitor_analyze',
  /* B-06.1 — 模块06 F06-04 四象限（只读）。加在这里是**必须的**：只注册在
     src/tools/index.js 而漏了这一处，工具存在但不可调用，而且不会报错。 */
  'amzn_competitor_quadrants',
  'amzn_keyword_research',
  // Step 12 — the report registry and the settings surface (B07). The report
  // tool reads one table so it cannot miss half the reports; the setting tools
  // cannot write a verified market fact, only a preference.
  'amzn_report_list',
  // T4 — the round-to-round comparison the UI draft calls 「轮次对比」. Read-only,
  // and it reads the same resolved view the run panel does, so it cannot give a
  // second answer about one run.
  'amzn_report_diff',
  // F14-01 — 报告库。`_build` 是审计点名的「八类无写入方」里的那个写入方：把某个模块
  // 当下的表渲染成一份**冻结**的文档并登记（正文落在 `report.body`，因为那八类没有
  // 别的地方承载正文）。`_update` 只改一行上的收藏/标签/归档，不改正文。
  // ⚠️ 名字里没有 publish / apply / push / deploy：工作台那条发布边界守卫会拒绝它们，
  // 而这里发布的东西只在本地库里。
  'amzn_report_build',
  'amzn_report_update',
  'amzn_setting_list',
  'amzn_setting_set',
  // S1-B02 — the workspace lifecycle. Two registries, one list: this one is what
  // the pre-flight check asserts against, and `src/tools/index.js` is what the
  // host actually registers. A name in one and not the other is a tool the
  // contract check swears exists and no caller can reach.
  'amzn_workspace_upsert',
  // S1-B06 — the dashboard's six cards. Read-only, and the same builder the home
  // page calls, so the answer and the screen cannot be two different dashboards.
  'amzn_dashboard',
  // S1-B09 — the quality cockpit's scan. Idempotent by construction (an issue is
  // upserted by rule + object + field), and the same `runQualityScan` the data
  // quality page uses.
  'amzn_dq_scan',
  // S1-B10 — the conflict workbench's decision. The second and last tool of the
  // data-quality area: it records which value wins, and writes only the conflict
  // row, so adopting a value never deletes the sources that lost.
  'amzn_conflict_resolve',
  // S1-B12 — the audit log's read half. The log has one writer (the two funnels)
  // and no delete; without a reader, "every write is audited" is a claim about a
  // table nobody can see. Read-only.
  'amzn_audit_query',
  // 模块 12 — Agent 编排的十五个工具。这一版不接 LLM：开运行并冻结上下文包、
  // 逐步回报、存产物、记门禁裁决、**由人裁决草案**、按 id 查回来、读 §14 指标，
  // 以及 F12-02 的**角色配置版本化**（发布一版 / 清单 / 某一版）、F12-03 的补充数据请求，
  // 和 F12-06/F12-09 的中断恢复扫描。
  // 没有任何发布类工具（§15-8）。`amzn_agent_artifact_decide` 是草案离开 draft 的
  // 唯一入口 —— 存产物那个工具只能写 draft，否则 Agent 就能自己批自己的作业（§11 的
  // 草案级控制是人做的）。`amzn_agent_metrics` 只读：§14 十项里算得出来的给数字（带
  // 分母），算不出来的写明缺哪份记录。
  'amzn_agent_run_start',
  'amzn_agent_run_step',
  'amzn_agent_run_finish',
  'amzn_agent_run_list',
  // F12-09 — 扫一遍僵死的 `running` 运行并标成 blocked（原因类别 interrupted）。
  // ⚠️ **只标状态，绝不自动重跑**：本插件不驱动 Agent，所以「恢复」在这里只能是
  // 「把事实写下来、把决定权交回人 / 会话」。阈值由调用方给，插件不自己定。
  'amzn_agent_run_recover',
  'amzn_agent_artifact_save',
  'amzn_agent_gate_decide',
  'amzn_agent_artifact_decide',
  'amzn_agent_metrics',
  // F12-02 — 角色配置的版本化。发布叫 `_release` 而不是 `_publish`：工作台那条
  // publish|apply|push|deploy 命名守卫（§15 的发布边界）会拒绝后者。发布的是**本地库里
  // 的一版角色配置**：它会改变**之后新运行**下发的工具白名单与步骤上限，但一个字都不碰
  // 线上 listing，也不改任何一条已开的运行（运行冻结的是开始那一刻的那一版）。
  // 两个读工具：`_list` 看清单，`_show` 看某一版的完整内容。
  'amzn_agent_role_config_release',
  'amzn_agent_role_config_list',
  'amzn_agent_role_config_show',
  // F12-03 — 补充数据请求。开一条**记录**（插件不补数据，也不驱动 Agent）/ 列 / 结清。
  'amzn_agent_data_request',
  'amzn_agent_data_request_list',
  'amzn_agent_data_request_resolve',
  // 模块 14 §6/§7 — 发布记录与实验设计。登记运营在 Seller Central 实际做了什么、
  // 把它与批准草案逐字段比出差异、处置偏离、把变更声明成一个受控实验。
  // **没有发布工具**，也永远不会有（§15 的发布边界）—— 这四个工具里没有一个能
  // 改到线上，`publication_record` 记的是「已经发生的事」。
  'amzn_publication_record',
  'amzn_publication_list',
  'amzn_publication_baseline_decide',
  'amzn_observation_plan_save',
  // 模块 14 §8/§9 — 效果观测与回滚。观测节点物化、数据前置检查、结论、到期扫描、
  // 回滚交付包与闭环。同样没有一个能改到线上：`rollback_suggest` 只**生成清单**，
  // §9 的原话是「系统不提供一键回滚到线上」，闭环要靠人登记一条 kind=rollback 的
  // 发布记录。`observation_scan_due` 是通知表第一个真正的生产者。
  'amzn_observation_list',
  'amzn_observation_check',
  'amzn_observation_conclude',
  'amzn_observation_scan_due',
  'amzn_rollback_suggest',
  'amzn_rollback_list',
  // 模块 08 F08-07 — 关键词九态生命周期。状态独立于 kw_master（整层重建会抹掉加在
  // 那张表上的列），每一次流转追加一行永不修改的历史，且**没有删除路径**。五个工具
  // 里没有 `apply` / `publish` 这类名字：显式发布关联叫 `_batch`，因为工作台有一条
  // 守卫拒绝任何含 publish|apply|push|deploy 的工具名（§15 的发布边界）。
  'amzn_keyword_lifecycle_list',
  'amzn_keyword_lifecycle_history',
  'amzn_keyword_lifecycle_set',
  'amzn_keyword_lifecycle_batch',
  /* F-5（走查 2026-10-25）：3 万条只支持单条操作走不通。`_batch_set` 是 `_set` 的
     批量形态 —— 一次人的决定，all-or-nothing，一次最多 500 词。 */
  'amzn_keyword_lifecycle_batch_set',
  /* v69 — 产品线**归属**。`kw_master.product_line` 是派生值（每次导入重算会抹掉），人工
     归属住在 `keyword_product_line`；生效值 = 人工 > 派生，读口只有一个
     （`effectiveProductLine`）。两条：读一个词 / 批量裁决归属。 */
  'amzn_keyword_product_line_get',
  'amzn_keyword_product_line_batch_set',
  // 模块 08 F08-04 — 关键词所有权工作台。主人与冲突都是**推导**的（主人 = 唯一生效
  // 主张；≥2 条生效主张即冲突），库里不存冲突标志位；释放不删行；预览与执行是同一个
  // 函数 + dryRun 参数（两份实现迟早分叉）。批量工具叫 `_batch` 而不是 `_apply`，
  // 同样是那条 publish|apply|push|deploy 命名守卫。
  'amzn_keyword_ownership_list',
  'amzn_keyword_ownership_preview',
  'amzn_keyword_ownership_batch',
  'amzn_keyword_ownership_suggest',
  'amzn_keyword_ownership_resolve',
  // 模块 08 F08-05 — 位置计划持久层。计划是**分配决定**，与 kw_master.for_listing_json 的
  // **资格**不是一回事（资格说「可以」，计划说「就放这里」）。本模块是计划**唯一**的持久层
  // （§10 原话），13 只引用与冻结。`_propose` 只读不写；`_save` 在库层靠
  // keyword_plan_entry 的主键 (plan_id, keyword) 保证一词一主人，一位一用途由 states.js
  // 的位置词表保证。计划覆盖与实际覆盖**分开返回**，无文案时实际覆盖是 null 而不是 0
  // （§22.5「把计划覆盖当实际覆盖」）。
  'amzn_keyword_plan_list',
  'amzn_keyword_plan_get',
  'amzn_keyword_plan_propose',
  'amzn_keyword_plan_save',
  'amzn_keyword_plan_coverage',
  // 模块 08 F08-08 — 关键词详情（只读）。加在这里是**必须的**：只注册在
  // src/tools/index.js 而漏了这一处，工具存在但不可调用，而且不会报错。
  // 七个 §8.2 项一次读全；缺失分「未测量」与「本系统没有这个字段」两种说法，
  // 相关性属于后者 —— 不得由 CVR、搜索量、层级或 embedding 推导伪相关性。
  'amzn_keyword_detail',
]

/* reload marker: 2026-10-20T09:1x P1-1/P1-2 —— 改入口文件才会让 dsh-hmr 重载整个模块图 */
