/**
 * The workbench page, as one self-contained HTML document.
 *
 * No build chain, no framework, no client bundle: the plugin serves this string
 * and the browser does the rest. That is the Tier 1 trade-off — the page cannot
 * appear in the console's own sidebar, but it costs nothing to ship and it can
 * be rewritten without touching DSH.
 *
 * The page's job is narrow on purpose. It answers "what do we have" and "what is
 * selected", and it turns an intention into a prompt. It does not try to be a
 * form for every operation: the agent does the work, so a button only has to say
 * which objects and which goal.
 */

import { EXTRA_MODULES, LEGACY_MODULE_ALIASES, MODULE_GROUPS, NAV_GROUPS } from '../state/workbench.js'
/* The four signal categories, embedded into the page below. Imported rather than
   re-typed: this script has no module system, and a second hand-kept list of the
   four names inside the template literal is exactly the copy that goes stale. */
import { SIGNAL_CATEGORIES } from '../domain/keywords/signals.js'
import { EMPTY_BUCKET_TEXT } from '../domain/dashboard/todos.js'
/* S1-B14: the setting the 首次使用引导 collapses into. Imported rather than
   typed into the script a second time — the page writes it and the store
   validates it, and two spellings of one key is a write that throws at runtime
   with nothing in the source to show why. */
import { DISMISS_SETTING_KEY } from '../domain/dashboard/onboarding.js'
/* S1-B18: the setup wizard's step order, embedded below. The module numbers its
   message with it and the page numbers its list with it — one list, so a step
   inserted in the middle cannot renumber one and not the other. */
import { SETUP_STEP_IDS } from '../domain/setup/wizard.js'
import { TODO_BUCKETS } from '../domain/states.js'
/* domain 的 empty.kind → 页面四态的映射表。import 进来只为**注入**（页面脚本是
   模板字面量、没有模块系统），页面自己不写第二份。见下方 DOMAIN_EMPTY_KIND_TO_UI。 */
import { DOMAIN_EMPTY_KIND_TO_UI } from '../domain/ui/empty-kind.js'
/* The scope's own word for "every site", embedded below. The health cards carry
   their scope as a filter, and passing `__all__` on to a module would look up a
   site by that name and find nothing — so the sentinel is compared, not guessed
   at, and it comes from the module that defines it rather than from a second
   spelling inside the template literal. */
import { SCOPE_ALL } from '../domain/context/scope.js'
/* 模块 04：采集任务的十态与 13 节的五态。**两份词表都从 domain 进来**，与 SCOPE_ALL /
   SIGNAL_CATEGORIES 同一个理由 —— 页面脚本是模板字符串，没有模块系统，所以只能由服务端
   注入；而在脚本里手写第二份十态表，就是让「库里是 waiting_human、页面写待人工」这类
   漂移有机会存在，且两边都不报错。中文标签归 domain，chip 的样式类归页面（下一层）。 */
import {
  COLLECTION_ENV_CHECK_STATES, COLLECTION_PLAN_FAILURE_POLICIES, COLLECTION_PLAN_NOTIFY, COLLECTION_RISK_LEVELS,
  COLLECTION_SCHEME_STATUSES, COLLECTION_SCHEME_STATUS_LABELS, COLLECTION_SCHEME_TRANSITIONS,
  COLLECTION_SECTION_LABELS, COLLECTION_SECTION_STATES,
  COLLECTION_TASK_STATES, COLLECTION_TASK_STATUS_LABELS, COLLECTION_WAITING_TRIGGERS,
} from '../domain/states.js'
/* 模块 04 第三子批后半（F04-09 / F04-10）：方案的「字段覆盖」列印的是 13 个节的**中文名**，
   那是 `domain/collect/sections.js` 的词表（节 id 与节名一一对应）—— 页面里再写一份
   「basic → 基础信息」的表，就是让「库里是 basic、页面写基础信息」这类的漂移有机会存在。
   与 TASK_STATUS 同一个理由：脚本是模板字符串，没有模块系统，只能服务端注入。 */
import { COLLECTION_SECTIONS, SECTION_CONTENT_UNREAD_LABEL } from '../domain/collect/sections.js'
/* 模块 05：详情抽屉的四个标签页与**另外五个还没建的**。两份都从 domain 进来，理由与
   上面两份词表一样 —— 页面脚本是模板字符串，没有模块系统，手写一份就会与 serving 端
   漂开；而「还有五个标签页没建」这件事必须在页面上说出来，不能画成四个空页。 */
import {
  ASIN_DETAIL_PENDING_TABS, ASIN_DETAIL_TABS, ASIN_DETAIL_TAB_LABELS,
} from '../domain/asin/detail.js'
/* 模块 05 收尾：读被行数上限截断时，那一行没有读数的节该印什么 —— 措辞归
   `domain/asin/sections.js`（它拥有 readTruncated 的语义），工具侧印的是同一份常量。
   页面脚本是模板字符串、没有模块系统，所以与 SECTION_STATUS / ASIN_TAB_LABELS 同一个
   办法：服务端注入。在这里手写第二份「未读到」，就是让工具说「未读到（不是未采集）」、
   页面说「未读到」，两边都不报错而同一行数据被描述成两件事。
   注：`SECTION_CONTENT_UNREAD_LABEL` 与它同源，但已随判据搬到
   `domain/collect/sections.js`（见上面那条 import）—— 那份措辞是**两个载荷**共用的。 */
import { SECTION_READ_TRUNCATED_LABEL } from '../domain/asin/sections.js'
/* B-05c：三块的词表与那句「本仓没有来源」的措辞，同样由服务端注入（下面的
   ASIN_CHANGE_KINDS / ASIN_ATTRIBUTION_LABELS / ASIN_HEALTH_ITEM_IDS /
   ASIN_HEALTH_STATES / ASIN_HEALTH_NO_SOURCE_TEXT）。页面**只渲染服务端给的字符串**：
   它不判断变化类别、不判断归因、不判断 state、不算分子分母。改坏域层时工具侧与页面侧
   必须同时变红 —— 页面自己兜一个 fallback 就会让页面那条断言永远绿。 */
import {
  ASIN_ATTRIBUTION_LABELS, ASIN_CHANGE_KIND_LABELS, ASIN_CHANGE_KINDS,
} from '../domain/asin/history.js'
import {
  ASIN_HEALTH_ITEM_IDS, ASIN_HEALTH_NO_SOURCE_TEXT, ASIN_HEALTH_STATE_LABELS, ASIN_HEALTH_STATES,
} from '../domain/asin/health.js'
import { ASIN_IMPORT_DELIMITER_LABELS } from '../domain/asin/import.js'
/* 模块 05 F05-01 —— ASIN 大表的 17 列。列目录、列名、有没有来源、需要翻译的那几张
   中文表，全部由服务端注入（下面的 ASIN_COLUMNS / ASIN_CELL_LABELS / ASIN_DEFAULT_COLUMNS）。
   页面脚本是模板字符串、没有模块系统，所以在脚本里手写第二份列清单就会与工具印的漂开 ——
   而漂开时的症状是那一格永远空着，两边都不报错。这与 SECTION_STATUS / ASIN_TAB_LABELS
   是同一个办法。 */
/* 模块 05 的 CSV 序列化器：**导入是为了注入**，不是为了在服务端调用。
   客户端（pages/asin.js 的 exportAsinCsv）需要它，而 ESM 名字进不了模板字面量的
   作用域 —— 所以下面在脚本里用 toString() 把这几份实现整段搬进去。
   ⚠️ 在此之前这里只有一句 import，浏览器那边没有任何定义：点「导出 CSV」是
   ReferenceError，而这条路径没有任何测试，所以它坏了很久没人发现。 */
import {
  ASIN_CELL_LABELS, ASIN_COLUMNS, ASIN_DEFAULT_COLUMNS,
  ASIN_MISSING_TEXT, ASIN_NO_SOURCE_TEXT,
  asinCellText, asinTableCsv, csvCell,
} from '../domain/asin/table.js'
/* P1-1：页签脚本片段。拼接顺序 = 原来的物理顺序，见 docs/architecture/page-split-map.md。
   `pipelineScript` 由 `pages/kw.js` 自己 import —— pipeline 是先抽出去的试点，它的
   占位符物理上落在 kw 块的跨度内，所以那个引用跟着块一起搬走了，这里不再需要。 */
import { kwScript } from './pages/kw.js'
import { competitorScript } from './pages/competitor.js'
import { researchScript } from './pages/research.js'
import { rulesScript } from './pages/rules.js'
import { policyScript } from './pages/policy.js'
import { optimizeScript } from './pages/optimize.js'
import { reportScript } from './pages/report.js'
import { agentScript } from './pages/agent.js'
import { settingsScript } from './pages/settings.js'
import { homeScript } from './pages/home.js'
import { qualityScript } from './pages/quality.js'
import { asinScript } from './pages/asin.js'
import { collectScript } from './pages/collect.js'
import { promptsScript } from './pages/prompts.js'
import { shopsScript } from './pages/shops.js'

/** Serialise state for embedding: `<` is escaped so it cannot close the script tag. */
function embed(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * The chip class per collection task status — a **rendering** decision, and the
 * only half of the table that lives in this file.
 *
 * The wording does not live here: it is `COLLECTION_TASK_STATUS_LABELS`, merged in
 * below. Keeping the two apart is the point of the injection — a state whose label
 * the page guessed would show a different word from the one the tool prints for the
 * same row, and nothing would fail.
 *
 * A status missing from the class table renders with no highlight rather than
 * throwing: the store validates statuses against the same closed set, so a missing
 * entry is a page bug, and a plain chip is a better failure than a blank panel.
 */
const COLLECTION_TASK_CHIP_CLASS = {
  draft: '',
  queued: '',
  checking_env: 'run',
  running: 'run',
  waiting_human: 'warn',
  cooling_down: 'warn',
  partial: 'warn',
  done: 'ok',
  failed: 'warn',
  cancelled: '',
}

/**
 * status → [中文标签, chip 类], built from the domain's states and labels.
 *
 * One table, two sources: the words from `domain/states.js`, the classes from just
 * above. The script below embeds this and never re-lists a status.
 */
const TASK_STATUS_CHIPS = Object.fromEntries(COLLECTION_TASK_STATES.map(state => [
  state,
  [COLLECTION_TASK_STATUS_LABELS[state], COLLECTION_TASK_CHIP_CLASS[state] ?? ''],
]))

/**
 * The 13 sections' five states, same arrangement (contract §4.2 / §7.3).
 *
 * `missing` and an unattempted section both carry no chip class, on purpose: the
 * contract's mapping gives `missing` the plain chip, and the page must not invent a
 * class for it (`page.js` has no `badge--st-*` rules — the prototype's classes were
 * its own). The two are told apart by their **words** ("页面没有" vs "未采集"),
 * which is where the distinction belongs.
 */
const COLLECTION_SECTION_CHIP_CLASS = {
  collected: 'ok',
  missing: '',
  partial: 'warn',
  failed: 'warn',
  blocked: 'stop',
}

const SECTION_STATUS_CHIPS = Object.fromEntries(COLLECTION_SECTION_STATES.map(state => [
  state,
  [COLLECTION_SECTION_LABELS[state], COLLECTION_SECTION_CHIP_CLASS[state] ?? ''],
]))

/**
 * The four environment-check states, the three risk levels and the three waiting
 * triggers, in words.
 *
 * The **keys** come from the domain's own closed sets, so a state added there
 * appears here whether or not anyone remembered to add a word for it. What the
 * test pins is the key set: that is what turns "the page forgot a new state" from
 * a blank chip into a red assertion. The words are the page's own — the domain
 * declares the states, not their Chinese labels (unlike the task statuses, which
 * do have labels in `states.js` and are taken from there).
 */
const ENV_STATE_CHIPS = {
  ok: ['通过', 'ok'],
  warn: ['提醒', 'warn'],
  fail: ['未过', 'stop'],
  unknown: ['查不了', ''],
}

const RISK_LEVEL_LABELS = { low: '低', medium: '中', high: '高' }

const WAITING_TRIGGER_LABELS = {
  'profile-logged-out': '专用 profile 未登录',
  'login-wall': '撞上登录墙/验证码',
  'plan-window': '计划运行窗口未到',
}

const ENV_STATES = Object.fromEntries(COLLECTION_ENV_CHECK_STATES.map(state => [
  state,
  ENV_STATE_CHIPS[state] ?? [state, ''],
]))

const RISK_LEVELS_TABLE = Object.fromEntries(COLLECTION_RISK_LEVELS.map(level => [
  level,
  RISK_LEVEL_LABELS[level] ?? level,
]))

const WAITING_TRIGGERS_TABLE = Object.fromEntries(COLLECTION_WAITING_TRIGGERS.map(trigger => [
  trigger,
  WAITING_TRIGGER_LABELS[trigger] ?? trigger,
]))

/**
 * 采集方案的四态（F04-09），键集取自 `COLLECTION_SCHEME_STATUSES`，标签取自
 * `COLLECTION_SCHEME_STATUS_LABELS`（domain 里已有中文标签，页面不另写一份）。
 *
 * chip 类归页面 —— 与 TASK_STATUS_CHIPS 同款的分工：`obsolete` 拿空类而不是 `stop`，
 * 因为「已废弃」是一个**终态事实**，不是一次报错；给它红色会让一屏废弃方案看起来像
 * 一屏故障。真正需要招人眼的 `disabled`（停用：还能恢复，但它现在不能被选）用 `warn`。
 */
const COLLECTION_SCHEME_CHIP_CLASS = {
  draft: '',
  active: 'ok',
  disabled: 'warn',
  obsolete: '',
}

const SCHEME_STATUS_CHIPS = Object.fromEntries(COLLECTION_SCHEME_STATUSES.map(status => [
  status,
  [COLLECTION_SCHEME_STATUS_LABELS[status] ?? status, COLLECTION_SCHEME_CHIP_CLASS[status] ?? ''],
]))

/**
 * 13 节的 id → 中文名，方案卡的「字段覆盖」列要用（F04-09）。
 *
 * 与 SECTION_STATUS_CHIPS 分开：那一张是**节状态**的五态（已采到 / 页面没有…），
 * 这一张是**节本身**的十三个名字。两张表都从同一个 domain 文件来，但回答的是两个问题；
 * 合并成一张会让「basic」和「collected」看起来是同一类东西。
 */
const SECTION_NAMES = Object.fromEntries(COLLECTION_SECTIONS.map(section => [section.id, section.label]))

/**
 * 计划的失败策略与通知口径（F04-10）。**键集**取自 domain 的闭集，中文词是页面自己的
 * —— 与 ENV_STATE_CHIPS / RISK_LEVEL_LABELS 同样的分工（domain 声明有哪些值，不声明
 * 它们的中文）。键集取自闭集这件事本身才是断言的对象：新增一个策略而页面没词，
 * 会渲染成它的英文 id 而不是消失。
 */
const PLAN_FAILURE_LABELS = { stop: '停止', continue: '继续', retry_once: '重试一次' }
const PLAN_NOTIFY_LABELS = { none: '不通知', on_failure: '仅失败时', always: '每次都通知' }

const PLAN_FAILURE_TABLE = Object.fromEntries(COLLECTION_PLAN_FAILURE_POLICIES.map(policy => [
  policy,
  PLAN_FAILURE_LABELS[policy] ?? policy,
]))

const PLAN_NOTIFY_TABLE = Object.fromEntries(COLLECTION_PLAN_NOTIFY.map(notify => [
  notify,
  PLAN_NOTIFY_LABELS[notify] ?? notify,
]))

/**
 * 方案状态机（`COLLECTION_SCHEME_TRANSITIONS`，契约 §6.2.10）整张注入。
 *
 * 注入整张表而不是一张「哪个状态能点哪个按钮」的表：页面据此**过滤**自己要画的按钮，
 * 于是「domain 里加了一条边、页面还没画」会表现为少一个按钮（可见），而不是一次必然被
 * 服务端拒的请求（要等到有人点了才知道）。obsolete 的空数组也一并注入 —— 那正是
 * 「终态」这条规则的载体。
 */
const SCHEME_EDGES = COLLECTION_SCHEME_TRANSITIONS

/**
 * Modules whose panel carries real controls. Every other module the nav
 * declares gets a bare panel generated below.
 *
 * The reason this is a list and not "just write the panels we have": a
 * module with no panel of its own used to fall through to the ASIN table, so
 * clicking 优化队列 showed a live-looking table of the wrong data. Generating a
 * panel per declared module makes that impossible to forget.
 *
 * `optimize` is listed because its panel is written by hand further down: the
 * generator used to run for it too, producing a second, empty `panel-optimize`
 * — a duplicate id that rendered as an extra blank panel under the real one.
 */
const RICH_PANELS = ['home', 'quality', 'asin', 'collect', 'research', 'competitor', 'kw', 'pipeline', 'optimize', 'report', 'rules', 'policy', 'prompts', 'settings', 'agent', 'shops']

export function renderWorkbenchPage({ pagePath, initialState }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Amazon 运营工作台</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --panel:#ffffff; --line:#dfe3e8; --fg:#1c1f24; --dim:#6b7280; --accent:#2f6feb; --on-accent:#ffffff; --ok:#1a7f4b; --warn:#b45309; --stop:#c0392b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --panel:#171a20; --line:#2a2f38; --fg:#e6e8eb; --dim:#8a8f98; --accent:#5b9dff; --on-accent:#0b1220; --ok:#3fb950; --warn:#d29922; --stop:#f85149; }
  }
  * { box-sizing: border-box; }
  /* 键盘焦点要看得见。浏览器默认的 outline 在浅色底上很淡，而这个仓的每一个
     可点元素都自己画了 border —— 没有这一条时，Tab 到按钮上几乎看不出焦点在哪。 */
  :focus-visible { outline:2px solid color-mix(in srgb, var(--accent) 65%, transparent); outline-offset:2px; }
  body { margin:0; font:13px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; align-items:center; gap:14px; padding:12px 18px; background:var(--panel); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:2; }
  .brand { font-weight:600; font-size:15px; }
  .chips { display:flex; gap:8px; flex-wrap:wrap; margin-left:auto; }
  /* The scope bar. One line, server-rendered text (state.context.scopeText), so
     what the user reads here and what amzn_workbench_context tells the agent are
     the same string. It is a readout, not a control: the selector needs the
     shop / brand / product-line tables that land with S1-B02..B04, and a control
     that silently does nothing would be worse than a line that plainly states
     the scope. */
  .scope { font-size:12px; color:var(--dim); border:1px solid var(--line); border-radius:999px; padding:2px 10px; max-width:44ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip { font-size:12px; padding:2px 9px; border:1px solid var(--line); border-radius:999px; color:var(--dim); white-space:nowrap; }
  .chip.ok { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .chip.warn { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 40%, var(--line)); }
  .chip.run { color:var(--accent); border-color:color-mix(in srgb, var(--accent) 45%, var(--line)); }
  .chip.stop { color:var(--stop); border-color:color-mix(in srgb, var(--stop) 45%, var(--line)); }
  /* 「不判读」chip：既不是 ok、也不是 warn —— 没有分母，不该给绿也不该报警。
     基础 .chip 本来也吃 var(--dim)，所以它先前「看着还行」纯属巧合；显式写一条是为了
     让这个 class 不再是空操作（复验席 2026-10-25 §10 指出全仓原本没有任何 .muted）。 */
  .chip.muted { color:var(--dim); border-style:dashed; opacity:.85; }
  /* 缺口 chip 是**筛选按钮**，不是读数：必须有 hover / active 两态。active 用实心
     强调色，而不是只换文字颜色 —— 只换颜色的话，看不出来「现在正筛着」。
     只在 rules 页用 button.chip，顶栏的读数 chip 仍是 span。 */
  button.chip { min-height:0; padding:2px 9px; background:transparent; cursor:pointer; }
  button.chip:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
  button.chip[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); color:var(--on-accent); }
  button.chip[aria-pressed="true"]:hover:not(:disabled) { color:var(--on-accent); }
  /* 通知铃住在顶栏，**不是第 15 个模块**：MODULE_GROUPS 是导航，而「有多少事
     等着」是每一页都要能看见的一个数字，不是要跳过去的一个地方。
     计数为 0 时不加高亮，也不写「0 条」—— 一个永远显示 0 的徽标会训练人忽略它。 */
  #notifbell { font:inherit; font-size:12px; padding:3px 10px; border:1px solid var(--line); border-radius:999px; background:none; color:var(--dim); cursor:pointer; white-space:nowrap; }
  #notifbell.has-unread { color:var(--accent); border-color:color-mix(in srgb, var(--accent) 45%, var(--line)); }
  #notifpanel { position:absolute; right:18px; top:56px; width:min(560px, calc(100vw - 36px)); max-height:70vh; overflow:auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; z-index:30; box-shadow:0 8px 24px rgba(0,0,0,.14); }
  .notifrow { border-top:1px solid var(--line); padding:7px 0; display:flex; gap:8px; align-items:baseline; }
  .notifrow.unread { font-weight:600; }
  .notifmeta { font-size:11px; color:var(--dim); }
  /* 2026-10-21：右栏（当前选中 / 丢给 agent / agent 动态）整块拆掉。
     需求方的原话是「在对话里说即可，这个完全没啥作用」—— 它把一个一次性动作
     （复制 prompt）做成了每页常驻，1024 宽时占掉 330px，内容区只剩 460px。
     删掉后内容区拿回整行；「说 ASIN」这件事交给对话。 */
  main { display:grid; grid-template-columns:170px minmax(0,1fr); gap:14px; padding:14px 18px 28px; align-items:start; }
  /* 跳到内容：键盘用户实测要按 21 次 Tab 才到得了表单（13 个导航按钮 + 页头控件）。
     平时不可见，聚焦时才出现在左上角 —— 不用 display:none / visibility:hidden，
     那两样会让它无法被聚焦，等于没做。 */
  .skip-link { position:absolute; left:-9999px; top:0; z-index:60; padding:7px 12px;
    background:var(--panel); border:1px solid var(--accent); border-radius:0 0 8px 0;
    color:var(--accent); font-size:12px; text-decoration:none; }
  .skip-link:focus { left:0; }
  #content:focus { outline:none; }
  /* The nav sticks while the page scrolls. Its offset is a measured variable,
     not a constant: the header's height is not fixed (the status chips wrap on
     narrow windows), so a hardcoded top would leave a gap or slide under the
     header. setHeaderH() in the script below measures it. The nav deliberately
     carries no z-index of its own - the header's z-index 2 wins and the nav
     slides under it while scrolling, which is the wanted stacking. */
  nav { display:flex; flex-direction:column; gap:2px; position:sticky; top:calc(var(--hdr-h, 52px) + 14px); }
  nav button { text-align:left; padding:7px 10px; border:1px solid transparent; border-radius:7px; background:none; color:var(--fg); font:inherit; cursor:pointer; }
  nav button:hover { background:var(--panel); border-color:var(--line); }
  nav button.active { background:var(--accent); border-color:var(--accent); color:#fff; }
  nav .count { float:right; color:var(--dim); font-size:12px; }
  nav button.active .count { color:color-mix(in srgb, var(--on-accent) 78%, transparent); }
  /* Group heading: 11px dim caps, a rule filling the rest of the row, and a
     chevron that says whether the group is open. Clicking it folds the group —
     state lives in memory only, like every other bit of page state. */
  nav .navgroup { display:flex; align-items:center; gap:6px; margin:12px 0 3px; padding:0 10px; font-size:11px; font-weight:600; color:var(--dim); letter-spacing:.05em; cursor:pointer; user-select:none; }
  nav .navgroup:first-child { margin-top:2px; }
  nav .navgroup .chev { font-size:10px; width:9px; }
  nav .navgroup .n { color:var(--dim); font-weight:400; }
  nav .navgroup::after { content:""; flex:1; height:1px; background:var(--line); }
  /* In-panel section rows. Indented under their module button and lighter than
     it: they are jumps inside a panel, not destinations, so an active section
     must not look like an active module (which is a solid accent block). */
  nav .nav-sub { padding:4px 10px 4px 26px; font-size:12px; color:var(--dim); }
  nav .nav-sub:hover { color:var(--fg); }
  nav .nav-sub.active { background:none; border-color:transparent; color:var(--accent); font-weight:600; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; }
  .panel + .panel { margin-top:14px; }
  .panel h2 { font-size:12px; font-weight:600; color:var(--fg); margin:0; padding:10px 14px; border-bottom:1px solid var(--line); text-transform:none; }
  .bar { display:flex; gap:8px; padding:10px 14px; border-bottom:1px solid var(--line); flex-wrap:wrap; align-items:center; }
  input, select, textarea { font:inherit; color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:5px 9px; }
  /* 全局按钮基线。**改前一个 button 规则都没有** —— 所有按钮都是浏览器原生样式
     （不同机器上灰底、不同圆角、不同高度），而这一页的按钮密度很高：一次采集要走
     「预览 → 提交」，一张表里还有保存/取消。原生按钮在 12px 的界面里显得又大又糙，
     而且和输入框（5px 9px 内边距、6px 圆角）不是一套。
     这里只定基线：高度、圆角、边框、悬停、按下。主按钮用 .primary（一屏最多一个）。 */
  button { font:inherit; font-size:12px; line-height:1; padding:5px 11px; min-height:27px;
    border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--fg);
    cursor:pointer; transition:background .12s ease, border-color .12s ease, color .12s ease; }
  button:hover:not(:disabled) { border-color:color-mix(in srgb, var(--accent) 45%, var(--line)); color:var(--accent); }
  button:active:not(:disabled) { background:color-mix(in srgb, var(--accent) 8%, var(--panel)); }
  button:disabled { opacity:.55; cursor:default; }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent); }
  button.primary:hover:not(:disabled) { background:color-mix(in srgb, var(--accent) 86%, #000); color:var(--on-accent); }
  button.danger:hover:not(:disabled) { border-color:var(--stop); color:var(--stop); }
  /* 导航激活项是实心强调色块。全局 button:hover 与 nav button.active 同特异性
     （都是 0,2,1），而按钮规则写在后面 —— 鼠标停在激活项上时文字会被改成强调色，
     于是蓝底蓝字、标签消失。这条用更高的特异性把它按回白字。 */
  nav button.active, nav button.active:hover:not(:disabled) { background:var(--accent); border-color:var(--accent); color:var(--on-accent); }
  nav button.active .count { color:#dce8ff; }
  input[type=search] { flex:1; min-width:150px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:260px; }
  th { font-weight:600; font-size:12px; color:var(--dim); }
  /* 表头的吸顶试过，又撤掉了：.panel > div:has(> table) 是横向滚动容器，
     sticky 的最近祖先就是它 —— 它自己不在纵向滚，页头照样跟着页面滚走。要真吸顶
     得给它一个 max-height 变成纵向滚动区，那是另一种交互（表内滚动条），不值得
     为 14 行的表换。数字仍然用等宽数位：一列全是 89.99 / 1200 / 63421 时，
     比例字体会让小数点对不齐。 */
  td { font-variant-numeric:tabular-nums; }
  /* 数字列右对齐：价格 / BSR / 评分 / 评论数 / 完整率 / 风险数 一列里全是数字，
     左对齐时 8.5 与 63421 的数位起点一样、终点参差，扫一眼比不出大小。
     表头跟着右对齐，否则「价格」二字浮在数字列的左边、看起来像另一列。 */
  th.num, td.num { text-align:right; }
  /* 可排序表头：光标 + 悬停变色 + 当前排序列的小箭头。没有这一条，用户不会知道
     表头能点 —— 而一个没人发现的入口等于没做。 */
  th.sortable { cursor:pointer; }
  th.sortable:hover { color:var(--accent); }
  th.sortable[aria-sort="ascending"] { color:var(--accent); }
  th.sortable[aria-sort="ascending"]::after { content:' ↑'; }
  tbody tr { cursor:pointer; }
  tbody tr:hover { background:color-mix(in srgb, var(--accent) 8%, transparent); }
  tbody tr.sel { background:color-mix(in srgb, var(--accent) 16%, transparent); }
  .empty { padding:22px 14px; color:var(--dim); }
  /* ASIN 组合概览那排 chip：横向铺开、可换行，数字多但不抢正文的注意力。 */
  .asin-portfolio { display:flex; flex-wrap:wrap; gap:6px; padding:0 0 10px; }
  /* 关键词数据源目录卡：路径要能一眼读出来（可能很长），所以单独一行、等宽、可换行。 */
  .sourcedir-path { font-family:ui-monospace, Consolas, monospace; font-size:12px; color:var(--fg);
    padding:6px 14px; word-break:break-all; user-select:all; }
  .sourcedir-actions { padding:0 14px 8px; }
  /* 复制之类的动作原来靠右侧栏那句 aria-live 状态播报；右栏拆掉之后改成一个
     临时提示条 —— 动作必须留下痕迹，否则"复制成功"与"剪贴板被拒"长得一样。 */
  .toaststack { position:fixed; left:50%; bottom:84px; transform:translateX(-50%); z-index:80;
    display:flex; flex-direction:column; gap:6px; align-items:center; pointer-events:none; }
  .toast { max-width:min(720px, calc(100vw - 40px)); padding:9px 14px; border-radius:8px;
    background:var(--panel); border:1px solid var(--accent); color:var(--fg); font-size:12px;
    box-shadow:0 6px 24px rgba(0,0,0,.25); opacity:0; transition:opacity .15s; }
  .toast.on { opacity:1; }
  textarea { width:calc(100% - 28px); margin:0 14px 12px; height:76px; resize:vertical; font-family:ui-monospace, Consolas, monospace; font-size:12px; }
  .hint { padding:9px 14px; color:var(--dim); font-size:12px; }
  /* A failed action says why, in the middle column, instead of leaving the last
     panel up as if nothing happened or blanking the column entirely. */
  .page-error { margin:0 0 12px; padding:9px 14px; border:1px solid color-mix(in srgb, var(--stop) 45%, var(--line)); border-radius:9px; background:color-mix(in srgb, var(--stop) 8%, transparent); color:var(--stop); font-size:12px; }
  code { font-family:ui-monospace, Consolas, monospace; background:color-mix(in srgb, var(--accent) 10%, transparent); padding:1px 5px; border-radius:4px; }
  a { color:var(--accent); }
  .opt { padding:12px 14px; border-bottom:1px solid var(--line); }
  .opt-head { display:flex; gap:7px; align-items:center; flex-wrap:wrap; margin-bottom:9px; }
  .opt-field { font-weight:600; font-size:12px; }
  /* 真机实测补的（2026-10-20）：.opt-meta 原来只有颜色和字号，而它承载的是**长中文说明**
     （agent 面板里一条实测 1435px 宽）。中文没有空格，浏览器不会在词中断行，于是它把整页
     撑宽 —— 914px 视口下横向溢出 131~597px，右侧内容被切掉。
     overflow-wrap:anywhere 让长串可以在任意字符处折行；min-width:0 修的是
     flex/grid 子项默认 min-width:auto 不肯收缩的老问题（不修这条，折行规则可能不生效）。
     注意：本注释在模板字符串内部，**不能用反引号**标记属性名 —— 会提前结束模板。 */
  .opt-meta { color:var(--dim); font-size:12px; overflow-wrap:anywhere; min-width:0; }
  .diff { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .diff > div { border:1px solid var(--line); border-radius:8px; padding:8px 10px; min-width:0; }
  .diff > div.after { border-color:color-mix(in srgb, var(--ok) 35%, var(--line)); }
  .diff h4 { margin:0 0 6px; font-size:11px; font-weight:600; color:var(--dim); }
  .diff p { margin:0; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .budget { display:block; flex-basis:100%; height:5px; border-radius:3px; overflow:hidden; background:color-mix(in srgb, var(--fg) 13%, transparent); }
  .budget .fill { display:block; height:100%; background:var(--ok); }
  .budget .fill.under { background:var(--dim); }
  .budget .fill.over { background:var(--stop); }
  .viol { margin-top:8px; display:flex; flex-direction:column; gap:5px; }
  .viol > div { display:flex; gap:6px; align-items:baseline; flex-wrap:wrap; font-size:12px; }
  .viol code { font-size:11px; }
  /* The rules panel's own controls. Scoped to #panel-rules so a future panel's
     .bar buttons are not styled by surprise. */
  #panel-rules .bar button { font:inherit; font-size:12px; padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; }
  #panel-rules .bar button:hover { border-color:var(--accent); color:var(--accent); }
  #panel-rules .chk { cursor:pointer; }
  /* F05-01 的 ASIN 面板控件。与上面四个面板同一条规矩：样式**限定在 #panel-asin 里**，
     免得将来某个面板的 .bar 按钮被这里的一条规则意外改掉。列选择器的复选框是
     .chk（与规则面板同款），所以它也跟着有了 cursor。 */
  #panel-asin .bar button { font:inherit; font-size:12px; padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; }
  #panel-asin .bar button:hover { border-color:var(--accent); color:var(--accent); }
  #panel-asin .chk { cursor:pointer; }
  /* 列选择器是一行可换行的复选框：17 列横排会把 .bar 撑出屏幕。 */
  #asinColPicker { display:inline-flex; flex-wrap:wrap; gap:2px 10px; vertical-align:middle; }
  #asinColPicker label { white-space:nowrap; }
  .rule-sect { padding:10px 14px; color:var(--fg); font-size:12px; font-weight:600; border-top:1px solid var(--line); background:color-mix(in srgb, var(--bg) 55%, var(--panel)); }
  /* The policy panel's controls, scoped to #panel-policy for the same reason the
     rule panel's are scoped: a future panel's .bar buttons must not be styled by
     surprise. */
  #panel-policy .bar button { font:inherit; font-size:12px; padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; }
  #panel-policy .bar button:hover:not([disabled]) { border-color:var(--accent); color:var(--accent); }
  #panel-policy .bar button[disabled] { opacity:.5; cursor:default; }
  .policy-body { padding:10px 14px; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; max-height:220px; overflow:auto; border-top:1px solid var(--line); color:var(--dim); }
  /* The prompt editor. Two columns when there is room for them, stacked when
     there is not — the list is long and the form is tall, so side by side is the
     only layout that shows both at once. Scoped to #panel-prompts for the same
     reason the rule and policy panels are scoped: a future panel's .bar buttons
     must not be styled by surprise. */
  #panel-prompts .bar button { font:inherit; font-size:12px; padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; }
  #panel-prompts .bar button:hover:not([disabled]) { border-color:var(--accent); color:var(--accent); }
  #panel-prompts .bar button[disabled] { opacity:.5; cursor:default; }
  .prompt-editor { display:grid; grid-template-columns:minmax(0,1fr); }
  .prompt-list { padding:8px 12px; display:flex; flex-direction:column; gap:6px; max-height:560px; overflow:auto; border-bottom:1px solid var(--line); }
  .prompt-row { display:flex; gap:8px; align-items:baseline; padding:6px 9px; border:1px solid var(--line); border-radius:7px; cursor:pointer; }
  .prompt-row:hover { border-color:var(--accent); }
  .prompt-row.sel { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 10%, transparent); }
  .prompt-row .plabel { font-size:12px; font-weight:600; }
  .prompt-row .pmeta { color:var(--dim); font-size:11px; margin-left:auto; white-space:nowrap; }
  .prompt-form { padding:10px 14px; display:flex; flex-direction:column; gap:9px; min-width:0; }
  .prompt-form label { font-size:12px; color:var(--dim); display:flex; flex-direction:column; gap:4px; }
  .prompt-form input, .prompt-form select { width:100%; }
  .prompt-form textarea { margin:0; width:100%; height:200px; }
  .prompt-preview { padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); font-family:ui-monospace, Consolas, monospace; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; max-height:180px; overflow:auto; }
  .prompt-preview.err { border-color:color-mix(in srgb, var(--stop) 45%, var(--line)); color:var(--stop); }
  /* 版本历史（B-11.2b）：每行一个冻结版本 + 一个回滚按钮。 */
  .prompt-version { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; padding:6px 9px; border:1px solid var(--line); border-radius:7px; margin-top:6px; }
  .prompt-version .pv-ver { font-size:12px; font-weight:600; }
  .prompt-version .pv-time { color:var(--dim); font-size:11px; }
  .prompt-version .prompt-rollback { font:inherit; font-size:11px; padding:3px 9px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; margin-left:auto; }
  .prompt-version .prompt-rollback:hover { border-color:var(--accent); color:var(--accent); }
  .prompt-version .pv-body { flex-basis:100%; color:var(--dim); font-family:ui-monospace, Consolas, monospace; font-size:11px; white-space:pre-wrap; overflow-wrap:anywhere; }
  /* B-11.3 / F11-05：生命周期的一步一个按钮，外加「退回上一活动版本」。样式与上面
     回滚按钮同款，但它们是两种不同的按钮，所以是两条规则而不是复用一条类名。 */
  .prompt-lifecycle-next, .prompt-active-rollback { font:inherit; font-size:11px; padding:3px 9px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; margin-right:6px; }
  .prompt-lifecycle-next:hover, .prompt-active-rollback:hover { border-color:var(--accent); color:var(--accent); }
  .prompt-lifecycle-next:disabled, .prompt-active-rollback:disabled { opacity:.45; cursor:not-allowed; }
  /* F11-07：固定评估集。它是**只读**的一块 —— 导入走工具，页面只展示，
     所以这里没有任何 button 样式（一个能点的按钮会暗示页面能写，而页面不写）。 */
  #promptEval { padding:0 14px 10px; border-top:1px solid var(--line); }
  .eval-sect { display:flex; flex-wrap:wrap; gap:6px; align-items:baseline; padding:10px 0 6px; font-size:12px; font-weight:600; }
  .eval-sect .eval-note { font-weight:400; color:var(--dim); font-size:11px; }
  .eval-set { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:7px; }
  .eval-set .es-head { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; font-size:12px; }
  .eval-set .es-id { font-weight:600; }
  .eval-set .es-meta { color:var(--dim); font-size:11px; margin-left:auto; }
  .eval-set .es-empty { color:var(--warn, #b8860b); font-size:11px; margin-top:5px; }
  .eval-case { padding:6px 0 0 4px; border-top:1px dashed var(--line); margin-top:6px; font-size:11px; }
  .eval-case .ec-id { font-weight:600; }
  .eval-case .ec-cat { color:var(--dim); margin-left:6px; }
  .eval-case .ec-line { color:var(--dim); font-family:ui-monospace, Consolas, monospace; white-space:pre-wrap; overflow-wrap:anywhere; margin-top:3px; }
  .eval-case .ec-exp { color:var(--fg); margin-top:3px; }
  @media (min-width:1280px) {
    .prompt-editor { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
    .prompt-list { border-bottom:none; border-right:1px solid var(--line); }
  }
  /* The competitor panel's controls, scoped to #panel-competitor for the same
     reason the rule / policy / prompt panels are scoped: a future panel's .bar
     buttons must not be styled by surprise. */
  #panel-competitor .bar button, #panel-research .bar button { font:inherit; font-size:12px; padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; }
  #panel-competitor .bar button:hover, #panel-research .bar button:hover { border-color:var(--accent); color:var(--accent); }
  /* The ONLY two-column row on the competitor panel. The two diff lists below it
     are stacked and full width: at 1280 a 50/50 split leaves about 330px per
     side, and a keyword like "patio furniture cushions" is truncated in both —
     the column that matters most would be the one unable to show its own data.
     Each list also has its own sort, which a shared row cannot express. */
  .split2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:12px 14px; }
  .split2 > div { border:1px solid var(--line); border-radius:8px; padding:10px 12px; min-width:0; }
  .split2 .n { font-size:22px; font-weight:600; line-height:1.3; }
  @media (max-width:900px) { .split2 { grid-template-columns:1fr; } }
  #panel-research .kwchk, #panel-competitor .kwchk { cursor:pointer; }
  /* The report centre's controls, scoped to #panel-report for the same reason
     the rule / policy / prompt / competitor panels are scoped: a future panel's
     .bar buttons must not be styled by surprise. */
  #panel-report .bar button { font:inherit; font-size:12px; padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; }
  #panel-report .bar button:hover { border-color:var(--accent); color:var(--accent); }
  /* The settings surface. Its own inputs and buttons are scoped here so the
     form's controls do not inherit another panel's sizing. The table inputs are
     deliberately narrow: every value on this page is a short scalar, and a
     full-width box invites pasting a paragraph into a postal code. */
  #panel-settings .bar button { font:inherit; font-size:12px; padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; }
  #panel-settings .bar button:hover { border-color:var(--accent); color:var(--accent); }
  #panel-settings table input[type=text], #panel-settings table input[type=number] { width:130px; }
  #panel-settings table input[type=text]::placeholder { color:var(--dim); }
  #panel-settings table button { font:inherit; font-size:11px; margin-left:6px; padding:3px 9px; border:1px solid var(--line); border-radius:5px; background:none; color:var(--fg); cursor:pointer; }
  #panel-settings table button:hover { border-color:var(--accent); color:var(--accent); }
  #panel-settings td { white-space:nowrap; }
  /* One product line's four signal boxes. Stacked rather than in a row: the row
     already carries five columns, and four inputs side by side would squeeze the
     placeholders — which are the built-in word list, the one thing a reader needs
     to see when the box is empty. */
  .sigcell { display:block; font-size:11px; color:var(--dim); margin-bottom:2px; }
  .sigcell input { width:190px; margin-left:6px; }
  .sigbtns { display:flex; gap:6px; margin-top:4px; flex-wrap:wrap; }
  /* The home dashboard's six cards. A responsive grid rather than a fixed three
     columns: the cards carry a sentence each, and a narrow window would clip
     them. */
  .cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:10px; padding:12px 14px; }
  /* 首页第二层：收藏 / 快捷动作 / 最近运行各一个 fold。第一层只留「待办 + 六张卡」——
     首页原来 2749px，最近运行一块就 706px。summary 上带自己的条数，收起不等于藏掉。 */
  .home-fold { border-top:1px solid var(--line); }
  .home-fold > summary { cursor:pointer; color:var(--dim); padding:11px 14px; font-size:12px; list-style:none; }
  .home-fold > summary::-webkit-details-marker { display:none; }
  .home-fold > summary::before { content:'▸ '; }
  .home-fold[open] > summary::before { content:'▾ '; }
  .home-fold > summary:hover { color:var(--accent); }
  .home-fold[open] > summary { color:var(--fg); }
  .card { border:1px solid var(--line); border-radius:9px; padding:10px 12px; display:flex; flex-direction:column; gap:5px; min-width:0;
    transition:border-color .15s ease, box-shadow .15s ease; }
  /* 能点的卡要有「能点」的样子：改前六张卡和一张不能点的说明卡长得一模一样，
     只有鼠标移上去才从光标箭头里猜出来。阴影只加在带 data-link 的卡上 ——
     给不能点的卡加阴影，是把「看起来可点」变成一句谎。 */
  .card[data-link] { cursor:pointer; }
  .card[data-link]:hover { border-color:color-mix(in srgb, var(--accent) 40%, var(--line)); box-shadow:0 4px 14px rgba(16,24,40,.10); }
  /* A card is a link now (W1-6), so it has to look like one: the same pointer and
     hover the 待办 / 最近运行 rows use, plus one visible word. A whole-card click
     with no affordance is a click nobody knows is available. */
  .card[data-link] { cursor:pointer; }
  .card[data-link]:hover { border-color:var(--accent); }
  .cardgo { font-size:11px; color:var(--accent); }
  .cardhead { display:flex; align-items:center; justify-content:space-between; gap:8px; font-weight:600; font-size:12px; }
  .cardbody { font-size:13px; }
  .cardfoot { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
  /* The four todo buckets. All four are always drawn — a bucket that hid itself
     would be indistinguishable from a feature that does not exist. The 最近运行
     block below them is the same shape of list, so it reuses the card styling
     rather than growing a second one that will drift from it. */
  .todobucket, .recentkind { padding:0 14px; }
  .todo, .recent { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin:6px 0; cursor:pointer; display:flex; flex-direction:column; gap:3px; }
  .todo:hover, .recent:hover { border-color:var(--accent); }
  .todohead { display:flex; align-items:baseline; justify-content:space-between; gap:8px; font-size:12px; font-weight:600; }
  /* 首次使用引导. The stepper is a column, not a horizontal bar: each step
     carries the fact that completes it, and a bar would have to drop the fact
     to fit — the fact is the part that tells the reader what to do. */
  #homeguide { padding:12px 14px 0; }
  .stepper { display:flex; flex-direction:column; gap:4px; }
  .gstep { display:flex; align-items:center; gap:8px; font-size:12px; min-width:0; }
  .gname { font-weight:600; flex:none; }
  .actgo { font:inherit; font-size:11px; padding:2px 10px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--accent); cursor:pointer; margin-left:auto; }
  /* 快捷动作. Each tile is one click target carrying its own landing caption,
     so the caption cannot be separated from the thing it describes. */
  .actionrow { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:10px; padding:12px 14px; }
  .action { border:1px solid var(--line); border-radius:9px; padding:9px 11px; cursor:pointer; display:flex; flex-direction:column; gap:4px; min-width:0; }
  .action:hover { border-color:var(--accent); }
  .action--off { cursor:default; opacity:.72; }
  .action--off:hover { border-color:var(--line); }
  .acthead { display:flex; align-items:baseline; justify-content:space-between; gap:8px; font-size:12px; }
  .actgoal { font-size:12px; color:var(--accent); }
  .acteffect { font-size:12px; }
  .actnote { font-size:11px; color:var(--dim); }
  /* 首次设置向导. The stepper is a column for the same reason the guide's is:
     each step carries its required fields, and a horizontal bar would have to
     drop them to fit — the fields are the part that says what to do. */
  #setwizard { padding:12px 14px 0; }
  .setup-todo { margin:6px 0 0; padding-left:20px; font-size:12px; }
  .setup-todo li { margin-bottom:5px; }
  /* The quality module's four in-panel tabs, and the catalogue's three levels.
     The active tab is marked with aria-selected as well as by colour, so the
     state is readable to something that cannot see the colour. */
  .qtabs { display:flex; gap:6px; padding:10px 14px 0; flex-wrap:wrap; }
  .qtab { font:inherit; font-size:12px; padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--dim); cursor:pointer; }
  .qtab:hover { border-color:var(--accent); color:var(--accent); }
  .qtab[aria-selected="true"] { color:var(--accent); border-color:var(--accent); }
  .qasset { padding:0 14px; }
  .qdataset { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin:6px 0; display:flex; flex-direction:column; gap:4px; }
  .qfacts { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .qfield { font-size:12px; padding:1px 7px; border:1px solid var(--line); border-radius:5px; color:var(--dim); }
  .qhop { border-left:2px solid var(--line); padding:3px 0 3px 10px; margin-left:6px; font-size:12px; }
  .qhop.present { border-left-color:var(--ok); }
  .qhop.absent { border-left-color:var(--warn); }
  /* 模块 04 采集中心。三栏（发起 / 任务与进度 / 13 节详情）写在一个面板里，因为这三块
     回答的是同一个问题（"这一趟采到什么"）的三个面：分开成三个页签会让「左边填完、右边
     看结果」变成来回切换。窄窗口下折叠成一栏 —— 侧栏本身已经占掉 330px，硬撑三栏会把
     每一栏压到读不了。 */
  .collect-grid { display:grid; grid-template-columns:minmax(240px,300px) minmax(0,1fr) minmax(280px,360px); gap:12px; padding:12px 14px; align-items:start; }
  /* Measured, not guessed: the workbench's own layout already takes 170px (nav) and
     330px (aside) out of the window, so at a 1426px viewport this grid gave the task
     table a **113px** column — the eight-column table was unusable. Below this width
     the panel folds to two columns and the 13-section detail takes the full width
     underneath; above it the three columns are the contract's 左/中/右. */
  @media (max-width:1560px) {
    .collect-grid { grid-template-columns:minmax(220px,280px) minmax(0,1fr); }
    .collect-grid > .collect-col:last-child { grid-column:1 / -1; }
  }
  /* 1200 以下采集面板退回单栏。
     2026-10-21：右栏拆掉之后 page 网格只剩 170px 导航 + 内容，内容区比之前宽 330px，
     所以这里的折叠点没有跟着动 —— 它调的是采集面板自己的三栏，不是页面网格。 */
  @media (max-width:1200px) {
    /* 采集面板退回单栏：两栏时任务表只剩约 490px，实测七列装不下，
       最后一列的取消按钮被裁在右边界外（点不着）。单栏后任务表拿满宽度。 */
    .collect-grid { grid-template-columns:minmax(0,1fr); }
    .collect-grid > .collect-col:last-child { grid-column:auto; }
  }
  .collect-col { display:flex; flex-direction:column; gap:8px; min-width:0; }
  /* A narrow column must scroll its table, never clip it: a column of ellipses reads
     as "the data is missing" rather than "the column is narrow". */
  .collect-col > .collect-card { border:1px solid var(--line); border-radius:8px; padding:9px 11px; overflow-x:auto; }
  /* The task table is eight columns wide and lives in the panel's middle column, which
     the page's own layout caps at roughly 500px. The global rule (max-width:260px per
     cell) makes it overflow there — measured on a 1426px viewport — so inside the
     collect panel the cells are allowed to shrink and ellipsize instead. */
  #panel-collect #tasks th, #panel-collect #tasks td { max-width:150px; }
  /* 任务表的状态筛选 chips。跑过几十次之后这张表会很长，而「只看失败的」是
     最常用的一个动作 —— 放在表面比让人翻下拉更直接。胶囊形、带条数，
     选中的一档用强调色；条数为 0 的也画，免得用户以为没有这一档。 */
  .taskfilter { display:flex; gap:6px; flex-wrap:wrap; padding:0 0 8px; }
  .taskfilter button { min-height:22px; padding:3px 9px; border-radius:999px; font-size:11px; color:var(--dim); }
  .taskfilter button .n { color:var(--dim); }
  .taskfilter button.on { background:color-mix(in srgb, var(--accent) 14%, var(--panel)); border-color:var(--accent); color:var(--accent); }
  .taskfilter button.on .n { color:var(--accent); }
  /* 真机实测补的一条（2026-10-20）：这些容器把 <table> 直接写进 innerHTML，而它们的
     祖先**没有一个是可横向滚动的**（往上找 overflow-x:auto|scroll 找不到），
     于是在 914px 文档宽度下整页被撑宽 —— 窄窗口里右侧内容被切掉。
     与上面 .collect-col > .collect-card 同一条原则：窄容器里的宽表**要能滚，不要被裁**。
     只加样式、不动结构，所以渲染输出逐字节不变。 */
  #agruns, #ruletable, #rulemissing { overflow-x:auto; }
  /* 同一类问题的通用兜底：面板里任何「直接装着 table、却没有自己 id」的 div。
     settings 的站点表就是这样（1065px 宽，无容器），它的父级没有 id 可挂。
     用 :has() 精确到「含有 table 的 div」，不会波及普通文本块。 */
  .panel > div:has(> table) { overflow-x:auto; max-width:100%; }
  /* promptForm 不被上面那条命中：它在 .prompt-editor 里，不是 .panel 的直接子级。
     它的表格 7 列 1294px，实测把页面撑出 597px。同一条原则，只是层级更深。 */
  .prompt-form { overflow-x:auto; max-width:100%; }
  .collect-card h3 { font-size:12px; font-weight:600; color:var(--dim); margin:0 0 6px; }
  .collect-form { display:flex; flex-direction:column; gap:6px; }
  .collect-form textarea { min-height:56px; resize:vertical; }
  .collect-form label { font-size:12px; color:var(--dim); }
  /* 预填横幅：说清「谁带过来的、默认采什么、改了什么」。它是只读的 —— 一个能改值的
     横幅等于一个没人同意的默认值。 */
  .collect-banner { border:1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius:8px; padding:8px 10px; font-size:12px; }
  .collect-sect { display:flex; gap:8px; align-items:baseline; padding:5px 0; border-top:1px solid var(--line); cursor:pointer; }
  .collect-sect:first-child { border-top:none; }
  .collect-sect .ord { color:var(--dim); font-size:11px; width:18px; }
  .collect-sect .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .collect-sect .counts { font-size:11px; color:var(--dim); }
  .collect-raw { max-height:220px; overflow:auto; font-size:11px; white-space:pre-wrap; word-break:break-all; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
  .collect-diff { font-size:11px; color:var(--dim); }
  .collect-wait { border:1px solid color-mix(in srgb, var(--warn) 45%, var(--line)); border-radius:8px; padding:8px 10px; font-size:12px; }
  /* 页尾两区（方案管理 / 计划采集）。**故意不复用 .collect-col**：那是三栏网格的列，
     数量被 B04P-① 的「三栏」断言钉住；页尾是另一条 auto-fit 网格，列数随宽度变，
     两件事分开写，改一处不会动到另一处的断言。 */
  .collect-tail { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:12px; padding:0 14px 14px; align-items:start; }
  .collect-tail > .collect-card { border:1px solid var(--line); border-radius:8px; padding:9px 11px; overflow-x:auto; }
  .collect-item { border-top:1px solid var(--line); padding:7px 0 4px; }
  .collect-item:first-of-type { border-top:none; }
  .collect-item .head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  .collect-item .k { color:var(--dim); font-size:11px; }
  .collect-refuse { border:1px solid color-mix(in srgb, var(--stop) 45%, var(--line)); border-radius:8px; padding:7px 9px; font-size:12px; }
  .collect-pace { border:1px solid var(--line); border-radius:8px; padding:7px 9px; font-size:12px; }
  .collect-pace input[type=number] { width:78px; }
  /* 计划/方案卡片里的按钮排一行；它们比原生按钮小一号，因为一张卡上有两三个。 */
  .collect-item button { font-size:12px; padding:1px 8px; }
  .collect-item input[type=text] { width:min(220px, 100%); }
  /* 模块 05：ASIN 详情区。作用域全部挂在 #asindetail 里面（.asin-* 只在这个区块出现），
     理由与其它面板一样：不动别处的按钮样式。标签页用 .qtab 那种样式，但独立命名 ——
     质量面板的 .qtab 有 aria-selected 的语义，这里的是普通按钮。 */
  #asindetail { border-top:1px solid var(--line); margin-top:10px; }
  .asin-head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; padding:9px 14px 0; font-size:12px; }
  .asin-tabs { display:flex; gap:6px; flex-wrap:wrap; padding:8px 14px; border-bottom:1px solid var(--line); }
  .asin-tabs button { font:inherit; font-size:12px; padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--dim); cursor:pointer; }
  .asin-tabs button:hover { border-color:var(--accent); color:var(--accent); }
  .asin-tabs button.active { color:var(--accent); border-color:var(--accent); }
  .asin-tabs button[disabled] { opacity:.5; cursor:default; }
  .asin-body { padding:0 14px 14px; }
  .asin-body h3 { font-size:12px; color:var(--dim); margin:12px 0 4px; font-weight:600; }
  .asin-row { cursor:pointer; }
  .asin-row:hover { color:var(--accent); }
  .asin-jumps { padding:2px 14px 6px; }
  .asin-sub { border-left:2px solid var(--line); margin:4px 0 8px 6px; padding:4px 0 6px 12px; font-size:12px; }
  /* 概览的第一层 = 五个读数 + 一张事实网格；第二层（完整率 / 新鲜度 / 冲突 / 计数 /
     来源 / 归档）收进 .asin-fold。收起时 summary 自己带读数，所以收起不等于藏掉。
     网格用 div 不用 table：全局 tbody tr 带 cursor:pointer，不能点的表长得像能点。 */
  .asin-chips { display:flex; gap:6px; flex-wrap:wrap; margin:10px 0 6px; }
  .asin-facts { display:grid; grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr); column-gap:12px; margin:0 0 10px; font-size:12px; }
  .asin-facts > div { padding:4px 0; border-bottom:1px solid color-mix(in srgb, var(--line) 60%, transparent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .asin-facts > .k { color:var(--dim); }
  .asin-fold { margin:5px 0; font-size:12px; }
  .asin-fold > summary, .collect-fold > summary { cursor:pointer; color:var(--dim); padding:4px 0; list-style:none; }
  .asin-fold > summary::-webkit-details-marker, .collect-fold > summary::-webkit-details-marker { display:none; }
  .asin-fold > summary::before, .collect-fold > summary::before { content:'▸ '; }
  .asin-fold[open] > summary::before, .collect-fold[open] > summary::before { content:'▾ '; }
  .asin-fold > summary:hover, .collect-fold > summary:hover { color:var(--accent); }
  .asin-fold[open] > summary, .collect-fold[open] > summary { color:var(--fg); }
  .collect-fold { margin-top:6px; font-size:12px; }
  .asin-fold-body { padding:2px 0 4px 12px; border-left:2px solid var(--line); }
  @media (max-width:1200px) { .asin-facts { grid-template-columns:auto minmax(0,1fr); } }
  .asin-src { width:100%; font-size:11px; }
  .asin-form { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:6px; }
  .asin-form input { width:min(260px, 100%); }
  .asin-form button { font:inherit; font-size:12px; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; }
  .asin-note { padding:6px 14px; font-size:12px; }
  .asin-note.err { color:var(--warn); }
  .asin-note.ok { color:var(--ok); }
  .asin-problem { border:1px solid color-mix(in srgb, var(--warn) 45%, var(--line)); border-radius:8px; padding:6px 9px; margin:6px 0; font-size:12px; }
  .asin-lack { border:1px solid var(--line); border-radius:8px; padding:6px 9px; margin:6px 0; font-size:12px; color:var(--dim); }
  /* B-05c：ASIN 面板里的三块（数据健康摘要 / 历史 diff / 批量导入）。三块都在
     #asindetail **之外** —— 那是 F05-02 四个已建页签的容器，本批不动它的契约。
     类名用 .b05c- 前缀，理由与 .asin-* 一样：不动别处同名的样式。 */
  #asinhealth, #asinhistory, #asinimport { border-top:1px solid var(--line); margin-top:10px; }
  .b05c-head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; padding:9px 14px 0; font-size:12px; }
  .b05c-body { padding:4px 14px 14px; }
  .b05c-body h4 { font-size:12px; color:var(--dim); margin:12px 0 4px; font-weight:600; }
  .b05c-note { font-size:12px; padding:2px 0; }
  .b05c-note.err { color:var(--warn); }
  .b05c-note.ok { color:var(--ok); }
  .b05c-grid { display:grid; gap:8px; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); }
  .b05c-card { border:1px solid var(--line); border-radius:8px; padding:7px 9px; font-size:12px; }
  /* 「本仓没有来源」的卡片用虚线边：它既不是错（不用 warn 色），也不是结论（不能与
     有数字的卡长得一样）。 */
  .b05c-card.nosource { border-style:dashed; color:var(--dim); }
  .b05c-card.err { border-color:color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .b05c-card .t { font-weight:600; }
  .b05c-card .n { color:var(--dim); font-size:11px; }
  .b05c-table { width:100%; border-collapse:collapse; font-size:12px; }
  .b05c-table th, .b05c-table td { text-align:left; padding:3px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  .b05c-table th { color:var(--dim); font-weight:600; }
  .b05c-form { display:flex; gap:6px; flex-wrap:wrap; align-items:center; padding:0 14px 6px; }
  .b05c-form textarea { width:100%; min-height:110px; font:inherit; font-size:12px; }
  .b05c-form button { font:inherit; font-size:12px; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:none; color:var(--fg); cursor:pointer; }
  .b05c-chip { border:1px solid currentColor; border-radius:999px; padding:0 6px; font-size:11px; color:var(--dim); }
  .b05c-chip.ok { color:var(--ok); }
  .b05c-chip.warn { color:var(--warn); }
  /* ── P3-4 命令面板（Ctrl+K）────────────────────────────────────────────
     浮层本身用 JS 动态创建（不写进 HTML，省得在 15 个面板之间再插一个节点），
     样式在这里。z-index 取 60 —— 高于通知浮层（30）与吸顶 header（2），
     因为它是一个**模态**：打开时它必须压在所有东西上面。 */
  .cmd-palette { position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:60; display:flex; align-items:flex-start; justify-content:center; padding-top:12vh; }
  .cmd-palette[hidden] { display:none; }
  .cmd-box { width:min(680px, 92vw); background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:0 18px 48px rgba(0,0,0,.28); overflow:hidden; }
  .cmd-box input { width:100%; box-sizing:border-box; font:inherit; font-size:14px; padding:12px 14px; border:0; border-bottom:1px solid var(--line); background:none; color:var(--fg); outline:none; }
  .cmd-list { max-height:52vh; overflow:auto; }
  .cmd-row { display:flex; align-items:center; gap:10px; padding:9px 14px; cursor:pointer; border-bottom:1px solid var(--line); }
  .cmd-row:last-child { border-bottom:0; }
  .cmd-row.sel { background:rgba(120,140,255,.16); }
  .cmd-row .cmd-kind { flex:0 0 auto; font-size:11px; color:var(--dim); border:1px solid var(--line); border-radius:999px; padding:0 7px; }
  .cmd-row .cmd-label { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cmd-row .cmd-detail { flex:0 0 auto; max-width:40%; font-size:11px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cmd-foot { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 14px; border-top:1px solid var(--line); font-size:11px; color:var(--dim); }
  .cmd-empty { padding:16px 14px; color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<a class="skip-link" href="#content">跳到内容</a>
<header>
  <div class="brand">Amazon 运营工作台</div>
  <div class="scope" id="scope"></div>
  <div class="chips" id="status"><span class="chip">连接中…</span></div>
  <button id="notifbell" aria-expanded="false">通知 <span id="notifcount">0</span></button>
  <div id="notifpanel" hidden></div>
</header>
<main>
  <nav id="nav" aria-label="模块导航"></nav>
  <div id="content" tabindex="-1">
    <div class="page-error" id="pageError" role="alert" hidden></div>
    <div class="panel" id="panel-home" hidden>
      <div class="bar">
        <span class="hint" id="homeHint" style="padding:0"></span>
        <button id="homeReload" style="margin-left:auto">重新读取</button>
      </div>
      <div id="homedigest"></div>
      <div class="bar">
        <span class="hint" style="padding:0">全局搜索</span>
        <input id="globalsearch" type="search" style="flex:1;margin:0 8px"
          placeholder="ASIN / 品牌 / 关键词 / 竞品组 / 规则 / 政策 / 提示词 / 任务号 / 报告" />
        <button id="globalsearchGo" class="primary">搜索</button>
      </div>
      <div id="homesearch"></div>
      <div class="rule-sect" style="border-top:1px solid var(--line)">待办（四档：阻断 / 待人工 / 应处理 / 可优化。同类合并成一条，带数量）</div>
      <div id="hometodos"></div>
      <div class="rule-sect" style="border-top:1px solid var(--line)">六张健康卡（结论 + 分母 + 更新时间；点一张进它说的那个模块）</div>
      <div id="homecards"></div>
      <div id="homeguide"></div>
      <details class="home-fold"><summary><span id="pinsSummary">收藏与最近访问</span></summary>
        <div id="homepins"></div></details>
      <details class="home-fold"><summary>快捷动作（六个入口，每个写明落到哪个模块）</summary>
        <div id="homeactions"></div></details>
      <details class="home-fold"><summary><span id="recentSummary">最近运行与产物</span></summary>
        <div class="hint" style="padding:0 14px"><strong>这一块是全部站点的，不跟着上面的作用域走</strong> ——
        上面的健康卡和待办按当前站点算，最近运行不按：按站点筛会让刚跑完的一轮因为当前选的是别的站点而消失，
        而空态仍写「暂无」，那是在说「没有」，不是「这个范围里没有」。</div>
        <div id="homerecent"></div>
        <div class="hint">每张卡都带<strong>结论 + 分母 + 更新时间</strong>：没有分母的数字是意见，没有更新时间的数字看不出是不是昨天的。
        没有数据时写「暂无数据」而不是 <code>0</code> —— 「还没测过」和「测出来是 0」是两件事。阈值只读引用规则口径基线（7 / 30 / 90 天），不可配置。<br>
        最近运行里五类<strong>一直并列</strong>，空的那类也画出来：<strong>「暂无」是这一类有表但还没有数据</strong>（去跑一次就会有），
        <strong>「未接入」是这一类还没有表</strong>（今天做什么都不会有数据）—— 两句话不同，是因为要你做的事不同。</div>
      </details>
    </div>
    <div class="panel" id="panel-quality" hidden>
      <div class="qtabs" id="qtabs"></div>
      <div id="qcatalog"></div>
      <div id="qlineage"></div>
      <div id="qcockpit"></div>
      <div id="qsnapshot"></div>
      <div id="qconflicts"></div>
      <div id="qaudit"></div>
      <div id="qpending"></div>
      <div class="hint">六个视图，本版全部已接：<strong>数据目录</strong>（资产类型 / 数据集 / 字段三级）、
      <strong>质量驾驶舱</strong>（七维度问题清单，状态只能沿状态机移动）、<strong>字段血缘</strong>（随选中的 ASIN 走）、
      <strong>冲突工作台</strong>（同字段多源不同值的裁决）、<strong>快照管理</strong>（版本化对象的统一索引）、
      <strong>全局审计</strong>（每一次写的前值 → 后值）。<br>
      冲突工作台里，采纳一个值只是<strong>把决定记在来源旁边</strong>，不会删掉任何一条来源 —— 冲突永远不会被静默覆盖。<br>
      全局审计里，一条只写「有变化」的行回答不了任何问题，所以每一行都给出<strong>字段级的前值 → 后值</strong>；
      凭据在写入时就被掩码（字段名保留、值换成掩码），日志<strong>不回填</strong>上线之前的历史，也<strong>没有删除入口</strong>。<br>
      每个数据集都写明<strong>粒度 / 主键 / 单位 / 空值含义 / 来源 / 行数 / 责任角色 / 时效档 / 下游</strong>。
      其中「空值含义」区分 <code>missing</code>（看过、确实没有）/ <code>unknown</code>（没人记录）/ <code>failed</code>（拿到了但解析失败）——
      把三者合成一个「空」，正是解析失败变成「这个商品没有价格」并且一直没被查出来的原因。<br>
      行数为 <code>—</code> 表示<strong>这张表读不出来</strong>（不是 0 行）：0 行是「表在、里面没数据」，两者要分开看。</div>
    </div>
    <div class="panel" id="panel-asin">
      <!-- ASIN 组合概览：先回答"这批 ASIN 里哪些该补、缺什么"，再让人翻表。
           学的是 WSL 那套运营系统 AsinList.vue 顶部那排统计。
           它只说明**内容齐不齐**；健康度（43 属性覆盖 + 九道门）在 amzn_asin_health。 -->
      <div id="asinPortfolio"></div>
      <div class="bar">
        <input type="search" id="q" placeholder="搜索 ASIN / 标题 / 品牌">
        <select id="marketplace" aria-label="站点筛选">
          <option value="">全部站点</option>
          <option>US</option><option>DE</option><option>JP</option>
          <option>UK</option><option>CA</option><option>FR</option>
        </select>
        <!-- F05-01：产品线与品牌也是筛选，而它们到今天只是**工具参数**
             （amzn_asin_query 的 productLineId / brand）—— 页面上没有控件能用它们。
             候选值由服务端给（asinFilterOptions）：产品线带名字与 ASIN 数，
             品牌是全库去重值，不是从这一屏的行里收集的。 -->
        <select id="asinLine" aria-label="产品线筛选">
          <option value="">全部产品线</option>
        </select>
        <select id="asinBrand" aria-label="品牌筛选">
          <option value="">全部品牌</option>
        </select>
        <!-- B-05e / F05-08：归档三态。**第一项（含已归档）就是页面这一侧显式的默认值**，
             与 domain/asin/table.js 的 projectAsinRow 那条注释是同一件事：这一张表不隐藏
             归档的行，只给它们打芯片（把一条记录藏起来会让它看起来像数据丢了）。
             会话侧的 amzn_asin_query 同样是「显示并逐行标（已归档）」—— 三处一个口径。
             这一格仍然**显式**给出去（routes.js 的 ASIN_PAGE_ARCHIVED），不吃数据层默认：
             两个默认值一致时靠「不传参数」也能得到对的结果，于是没有东西保证它们继续一致。
             三态而不是一个复选框：一个「含已归档」勾选框说不出「只要已归档」，
             而「归档了哪些」正是全库计数旁边那个数需要能列出来的集合。 -->
        <select id="asinArchived" aria-label="归档范围">
          <option value="all">含已归档</option>
          <option value="hide">只在架</option>
          <option value="only">仅已归档</option>
        </select>
        <select id="order" aria-label="排序方式">
          <option value="updated">按更新时间</option>
          <option value="bsr">按 BSR</option>
          <option value="reviews">按评论数</option>
          <option value="asin">按 ASIN</option>
        </select>
        <!-- 组合筛选的「现在是哪一组」：一组筛完还要能一键清掉。
             清空不是「把控件设回默认」—— 那会留下 masterLine 这类别的面板的键，
             而它们在这张表上没有任何效果。 -->
        <button type="button" id="asinClearFilters">清除筛选</button>
      </div>
      <!-- 列配置与保存视图。两个都是 F05-01 明确要的，而且它们**必须写进 filters**：
           列配置（filters.asinCols）与视图（名字 + 筛选 + 列）活过一次 3 秒轮询的方式
           就是把它们放进工作台上下文，而不是留在页面变量里。 -->
      <div class="bar" id="asinCols">
        <label class="hint" style="padding:0">列：
          <span id="asinColPicker"></span>
        </label>
        <button type="button" id="asinColReset">恢复默认列</button>
        <span class="hint" style="padding:0" id="asinColSummary"></span>
      </div>
      <!-- 视图与导出自成一行（原来和 17 个列复选框挤在同一条 bar 里，1440 宽下换行成
           三排、按钮和复选框混在一起，分不清哪些控件是一组的）。 -->
      <div class="bar" id="asinViews" style="border-top:0">
        <select id="asinViewPick" aria-label="保存视图">
          <option value="">（未选择视图）</option>
        </select>
        <input type="search" id="asinViewName" placeholder="视图名" size="14">
        <button type="button" id="asinViewLoad">加载</button>
        <button type="button" id="asinViewSave">保存</button>
        <button type="button" id="asinViewDelete">删除</button>
        <span style="flex:1 1 auto"></span>
        <button type="button" id="asinExportCsv">导出 CSV</button>
      </div>
      <div class="hint" style="padding:0 14px 8px" id="asinViewsHint"></div>
      <div id="table"></div>
      <!-- 详情区（模块 05 F05-02 的前四个标签页）。数据**不随 state 轮询下发**：一个 ASIN
           的四页加起来是全部字段来源、下游引用与十三行节结果，跟着每 3 秒一次的轮询走会把
           §3 的载荷预算吃光，而面板没开着的时候没有读者。按选中项读一次
           GET /api/asin-detail —— 与采集面板的 13 节详情同一条约定。 -->
      <div id="asindetail"></div>
      <!-- B-05c：三块。健康摘要与历史 diff 跟着**选中项**走（GET /api/asin-health、
           /api/asin-history，按需读一次，不随 3 秒轮询下发）；批量导入跟文件走、与选中项
           无关（POST asin-import-preview 只出计划，POST asin-import 才写）。
           三块的载荷都由服务端算好，页面**只读不重算** —— 它不判断变化类别、不判断归因、
           不判断 create/update、不算分子分母。 -->
      <div id="asinhealth"></div>
      <div id="asinhistory"></div>
      <!-- 产品表导入（赛狐）：扫目录 → 推荐品牌 → 预览 → 确认入库。
         配置表语义：四段缺一段不入库，进待补清单。 -->
    <div id="prodimport"></div>
    <div id="asinimport"></div>
    </div>
    <div class="panel" id="panel-collect" hidden>
      <!-- 顶部环境状态条 + 十项体检表（F04-01/F04-02）。它在三栏之外：环境不通时，
           表单与任务列表都还看得见，但没人该去点「提交」。 -->
      <div id="collectEnv"></div>
      <div class="bar"><span class="hint" id="collectHint" style="padding:0" aria-live="polite"></span></div>
      <div class="collect-grid">
        <div class="collect-col">
          <div id="collectForm"></div>
          <div id="collectWaiting"></div>
        </div>
        <div class="collect-col">
          <div class="collect-card">
            <h3>任务与进度</h3>
            <div id="tasks"></div>
          </div>
        </div>
        <div class="collect-col">
          <div class="collect-card">
            <h3>13 节详情（F04-07）</h3>
            <div id="collectDetail"></div>
          </div>
        </div>
      </div>
      <!-- 页尾两区（契约 §7.1）：三栏之外，因为它们管的是**下一次/以后每次**采集
           （方案、计划），不是这一次的结果。上一子批刻意没挂这两个 div —— 挂一个永远
           空的挂载点，等于在页面上声明一块不存在的功能；这一子批把它们连同空状态一起补上。 -->
      <div class="collect-tail">
        <div class="collect-card">
          <h3>采集方案（F04-09，版本化资产）</h3>
          <div id="collectSchemes"></div>
        </div>
        <div class="collect-card">
          <h3>计划采集（F04-10，默认关闭）</h3>
          <div id="collectPlans"></div>
        </div>
        <div class="collect-card">
          <h3>预估与实际（P1-4）</h3>
          <div id="collectAudit"></div>
        </div>
      </div>
    </div>
    <div class="panel" id="panel-research" hidden>
      <div class="bar">
        <input type="search" id="rsSeed" placeholder="种子词，逗号分隔，如：bluetooth speaker, party speaker">
        <button id="rsRun">查候选</button>
        <button id="rsImport">扩词入库</button>
        <span class="hint" id="rsHint" style="padding:0"></span>
      </div>
      <div id="rsstats"></div>
      <div id="rscands"></div>
      <div class="rule-sect">实测覆盖（我们这个 ASIN 测过什么、缺什么）</div>
      <div class="bar">
        <input type="search" id="kwq" placeholder="搜索关键词">
        <select id="kwtier">
          <option value="">全部分层</option>
          <option value="T1">T1 守位</option>
          <option value="T2">T2 冲刺</option>
          <option value="T3">T3 抢占</option>
          <option value="T4">T4 观察</option>
        </select>
        <select id="kworder">
          <option value="tier">按分层</option>
          <option value="coverage">按覆盖</option>
          <option value="keyword">按字母</option>
          <option value="updated">按更新时间</option>
        </select>
      </div>
      <div id="coverage"></div>
      <div id="kwtable"></div>
    </div>
    <div class="panel" id="panel-competitor" hidden>
      <div class="bar">
        <select id="compSet"></select>
        <input type="search" id="compAsin" placeholder="我们的 ASIN（默认取列表选中）">
        <span class="hint" id="compHint" style="padding:0"></span>
      </div>
      <!-- 按关键词反查竞品：只读库内已有的 kw_competitor_fact，不发起采集/搜索。
           卡片放在竞品组之前，因为「先搜一个词看看谁在前」是运营最常用的入口。 -->
      <div id="compreverse"></div>
      <div id="compcards"></div>
      <!-- The opportunity list. The id is the landing point the 快捷动作
           「评估竞品缺口」 names as "#competitor#opps" — a link that names a
           place has to have a place to land on. -->
      <div id="sect-opps"><div id="comptheirs"></div></div>
      <div id="compours"></div>
      <!-- F06-04 四象限。行带 data-keyword，点击打开下面的证据视图。 -->
      <div id="compquadrants"></div>
      <!-- 「每个差距可点击查看原始数据和时间」（§20.7）。这一块由 renderCompetitorEvidence
           写；声明的容器必须真的有人写，否则就是一个「说了没人做」的空壳。 -->
      <div id="compevidence"></div>
      <div id="compsets"></div>
      <!-- 自动发现竞品：服务器算好的预览 + 两个按钮（写成候选 / 采纳选中）。
           容器的存在是承诺：没人写它就是空壳，所以 competitor.js 里必须有 renderCompetitorDiscover。 -->
      <div id="compdiscover"></div>
      <!-- 竞品关系总表：一行一个竞品，三种状态都列。 -->
      <div id="comprelations"></div>
      <div class="hint">竞品数据<strong>只从库里已有的 <code>kw_competitor_fact</code> 读</strong>（卖家精灵 / 西柚导出），
      本次分析不采集任何新数据。<br>
      「竞品有我们没有」排在第一位：它是可行动的那一份。竞品最好排名为空表示<strong>该词没有竞品排名</strong>，不是 0 ——
      0 会被读成「排第一」。</div>
    </div>
    <div class="panel" id="panel-kw" hidden>
      <div class="bar">
        <input type="search" id="kmlq" placeholder="搜索关键词">
        <select id="kmlLine">
          <option value="">全部产品线</option>
        </select>
        <select id="kmlTier">
          <option value="">全部层级</option>
          <option value="L1">L1 超级热词</option>
          <option value="L2">L2 热词</option>
          <option value="L3">L3 核心词</option>
          <option value="L4">L4 长尾词</option>
          <option value="L5">L5 长尾尾词</option>
        </select>
        <select id="kmlOrder">
          <option value="volume">按搜索量</option>
          <option value="spend">按广告花费</option>
          <option value="orders">按订单</option>
          <option value="competitors">按竞品覆盖</option>
          <option value="opportunity">按机会</option>
          <option value="keyword">按字母</option>
          <option value="updated">按更新时间</option>
        </select>
        <!-- 模块 08 F08-07：按生命周期状态筛。九态选项由 renderMaster 从服务端的词表
             填进来（与产品线下拉同一套做法），页面里不重写第二份词表。 -->
        <select id="kmlLifecycle">
          <option value="">全部状态</option>
        </select>
      </div>
      <div id="kmlstats"></div>
      <!-- 模块 08 F08-07：生命周期。sect- 前缀是跳转目标约定。计数画进
           kmlLifecycleCounts，「改生命周期」的入口就在这一块里 —— 一个存在但没人写的
           div 就是承诺了能力然后把它丢掉，所以 renderMasterLifecycle 真的会写它。 -->
      <div id="sect-lifecycle">
        <div id="kmlLifecycleCounts"></div>
        <div class="bar">
          <select id="kmlTo">
            <option value="">改生命周期 →</option>
          </select>
          <input type="search" id="kmlReason" placeholder="理由（可选；排除/归档建议填）">
          <button id="kmlSetBtn">改生命周期</button>
          <span class="hint">先在下面的表里点选一条词；未设置是没人决定过，不是 candidate。</span>
        </div>
      </div>
      <!-- 模块 08 F08-04：所有权工作台。sect- 前缀是跳转目标约定。计数画进
           kmlOwnershipCounts，批量条 + 影响预览 + 二次确认 + 工作台表都在这一块里 ——
           一个存在但没人写的 div 就是承诺了能力然后把它丢掉，所以 renderMasterOwnership
           真的会写它们。批量是「先预览、再确认」两步：预览走 keyword-ownership-preview
           （不写库），确认走 keyword-ownership（带 confirmed）。 -->
      <div id="sect-ownership">
        <div id="kmlOwnershipCounts"></div>
        <div class="bar">
          <select id="kmlOwnAction">
            <option value="assign">批量分配给（唯一主人）</option>
            <option value="claim">批量认领（可产生冲突）</option>
            <option value="release">释放所有权</option>
            <option value="lock">锁定</option>
            <option value="unlock">解锁</option>
          </select>
          <input type="search" id="kmlOwnAsin" placeholder="目标 ASIN（分配/认领时必填）">
          <input type="search" id="kmlOwnReason" placeholder="理由（可选）">
          <button id="kmlOwnPreviewBtn">预览影响</button>
          <button id="kmlOwnConfirmBtn" hidden>确认执行（二次确认）</button>
          <span class="hint">先在下面的工作台表里勾选词。预览与执行是同一个函数，数字一定一致；影响活跃优化运行时必须二次确认。</span>
        </div>
        <div id="kmlOwnershipPreview"></div>
        <div id="kmlOwnershipTable"></div>
      </div>
      <!-- 模块 08 F08-05：位置计划持久层。sect- 前缀是跳转目标约定。计划是**分配决定**
           （哪个词归哪个位置），与 kw_master.for_listing_json 的**资格**不是一回事；本模块
           是计划唯一的持久层（§10）。计数画进 kmlPlanCounts，提案画进 kmlPlanProposal，
           当前计划表画进 kmlPlanTable，覆盖画进 kmlPlanCoverage —— 一个存在但没人写的 div
           就是承诺了能力然后把它丢掉，所以 renderMasterPlan 真的会写它们。计划覆盖与实际
           覆盖**分开显示**：没有 listing 文案时实际覆盖显示「无法计算（null）」，不是 0。 -->
      <div id="sect-plan">
        <div id="kmlPlanCounts"></div>
        <div class="bar">
          <input type="search" id="kmlPlanAsin" placeholder="目标 ASIN（生成/保存计划用）">
          <input type="search" id="kmlPlanName" placeholder="计划名称（可选）">
          <button id="kmlPlanProposeBtn">生成提案</button>
          <button id="kmlPlanSaveBtn">保存为计划</button>
          <span class="hint">提案只读不写库；保存时同一个词只能有一个主人，一位一用途。</span>
        </div>
        <div id="kmlPlanProposal"></div>
        <div id="kmlPlanTable"></div>
        <div id="kmlPlanCoverage"></div>
      </div>
      <div id="kmltable"></div>
      <!-- 模块 08 F08-08：关键词详情。sect- 前缀是跳转目标约定。点总库大表的一行
           （容器事件委托挂在 kmltable 上）把选中的 (关键词, 站点) 写进 context，刷新后
           renderKeywordDetail 把 state.master.detail 画进 kmldetail —— 一个存在但没人写的
           div 就是承诺了能力然后把它丢掉。缺失分「未测量」与「本系统没有这个字段」两种
           说法，词表由服务端随视图带出（absenceVocabulary / notModelled），页面不重写。 -->
      <div id="sect-detail"><div id="kmldetail"></div></div>
      <div id="kmlsources"></div>
    </div>
    <div class="panel" id="panel-pipeline" hidden>
      <div id="plsourcedir"></div>
      <div id="plstats"></div>
      <div id="pllatest"></div>
      <div id="plruns"></div>
    </div>
    <div class="panel" id="panel-optimize" hidden>
      <div class="bar"><span class="hint" id="optHint" style="padding:0"></span></div>
      <!-- R-91（需求方指定）：字段模板。四颗按钮对应四条页面写路径。
           「更新字段模板」**只发起研究、不假装搜过网** —— 它写一版 proposed 请求，
           AI 会话把真正的提案写回来，人再点「确认提案」才生效。 -->
      <div id="sect-fieldtemplate" style="margin:8px 0 12px">
        <div class="bar">
          <strong style="font-size:12px">字段模板</strong>
          <span class="hint" id="optftStatus" style="padding:0"></span>
        </div>
        <div class="bar">
          <button id="optftResearch" type="button">更新字段模板</button>
          <button id="optftConfirm" type="button">确认提案</button>
          <button id="optftRollback" type="button">回滚上一版</button>
          <button id="optftReload" type="button">刷新</button>
        </div>
        <div id="optftBody" class="hint" style="padding:0"></div>
        <!-- R-93：逐行编辑之后的落盘按钮。它必须出现在**下发文档**里（不能只由脚本现建），
             否则 T86-⑧ 会红：文案里让用户点「保存为新版本」，文档里却找不到这个控件。 -->
        <div class="bar">
          <button id="optftSave" type="button">保存为新版本</button>
          <span class="hint" id="optftSaveStatus" style="padding:0"></span>
        </div>
      </div>
      <!-- R-95：属性补齐。43 项必填属性里，采集只能补页面规格表列出的那几项，
           其余只能人工 —— 在这之前页面上根本没有填的地方，于是「43 属性」这道门每轮都降级。 -->
      <div id="sect-attrfill" style="margin:8px 0 12px">
        <div class="bar">
          <strong style="font-size:12px">属性补齐（43 项必填）</strong>
          <input id="optattrAsin" type="text" placeholder="ASIN，例如 B0GV55Q4JG" style="width:150px" />
          <input id="optattrMarket" type="text" value="US" title="站点" style="width:56px" />
          <button id="optattrLoad" type="button">读取属性</button>
          <span class="hint" id="optattrStatus" style="padding:0"></span>
        </div>
        <div id="optattrBody" class="hint" style="padding:0"></div>
        <div class="bar">
          <button id="optattrSave" type="button">保存属性</button>
          <span class="hint" id="optattrSaveStatus" style="padding:0"></span>
        </div>
      </div>
      <!-- F13-02 / F13-04：九项前置门槛与四种优化模式。这一块**一分数都不算** ——
           它读服务端那份由 precheckFor 产出的报告（这一轮冻结的，或按当前筛选现算的），
           页面只负责画。渲染在 renderOptimizations 里，且在「没有轮次」的提前返回之前。
           sect- 前缀是跳转目标约定：首页快捷动作「检查数据可用性」落的 anchor 是
           precheck，落到这一块（一个 anchor 只在有这样的区块时才允许写）。 -->
      <div id="sect-precheck"><div id="optprecheck"></div></div>
      <!-- F13-05：策略阶段（九项策略卡 + 「人工确认后进入生成」的门禁）。这一块
           **一分数都不算** —— 九项的 status / source / facts 与门禁的 open / state
           全部来自服务端 readStrategy（它内部调 strategyGate，与工具侧同一个函数）。
           它画在 optruns 之前：先策略后文案，在**版面顺序**上也成立。 -->
      <div id="sect-strategy"><div id="optstrategy"></div></div>
      <div id="optruns"></div>
      <div id="optrun"></div>
      <!-- F13-08：校验体系三块 —— 规则校验 / 闸门判定 / Agent 审阅。每块一个面板、
           一个 sect- 落点（锚点跳得进去），三块读的是服务端 readValidationSystem 的
           同一个产出（state.optimizations.validation），页面**一条判据都不算**。
           以前闸门画在 optrun 那一条里、规则只有两个 chip 数字、审阅连载荷都没有。 -->
      <div id="sect-rules"><div id="optrules"></div></div>
      <div id="sect-gates"><div id="optgates"></div></div>
      <div id="sect-review"><div id="optreview"></div></div>
      <!-- F13-06：位置计划核对（继承模块 08 的哪一版 / 本轮建议 / 决策与写回）。
           建议计划用 08 的八个位置，映射不到的逐条报出；页面只画。 -->
      <div id="sect-plancheck"><div id="optplancheck"></div></div>
      <!-- The drafts inbox. The id is the jump target the 待办 and 最近运行 links
           name as "#optimize#inbox" — a link that names a place has to have a
           place to land on.
           F13-01：optinbox 是五态分组条（待人工选择 / 待审批 / 驳回待修订 / 稍后 /
           已作废），optdrafts 是筛选后的表 + 逐字段明细。分组与筛选判据全在服务端
           （domain/optimize/inbox.js），页面只画。 -->
      <div id="sect-inbox"><div id="optinbox"></div><div id="optdrafts"></div></div>
      <!-- F13-03：十类证据包（只读冻结表）。缺的那一类要明说是「不存在」还是
           「本仓没有」，所以这一块永远画十行。 -->
      <div id="sect-evidence"><div id="optevidence"></div></div>
      <!-- F13-09：交付边界 —— 可复制字段 / 操作清单 / 「插件给的 vs 要人填的」三态，
           以及**发布登记跳转**（交付 → 模块 14 发布登记，链接带 runId，草案版本由服务端
           从 run 行读回来）。跳转复用待办那一套 followTodo，不新造第二套跳转机制。 -->
      <div id="sect-delivery"><div id="optdelivery"></div></div>
      <!-- 模块 14 §6：发布记录（列表 + 登记入口）。sect- 前缀是跳转目标约定。 -->
      <div id="sect-publication"><div id="optpublications"></div></div>
      <!-- 模块 14 §7/§8：观测。sect-observation 是通知锚点
           "#optimize#observation:<publicationId>" 的落点 —— 通知里的链接必须真的
           落到一个地方，否则点进去是死路。 -->
      <div id="sect-observation"><div id="optobservation"></div></div>
      <!-- 模块 14 §9：回滚。 -->
      <div id="sect-rollback"><div id="optrollback"></div></div>
    </div>
    <div class="panel" id="panel-report" hidden>
      <div class="bar">
        <!-- 类型下拉的选项由服务端下发（data.kinds = REPORT_KIND_TABLE）：
             这一页以前自己写死三个 option，加上服务端与工具侧的两份，同一个类别表
             有三处副本，加第四类必然漏掉两处。现在一处：store/reports.js。 -->
        <select id="rpKind"><option value="">全部类型</option></select>
        <select id="rpStatus">
          <option value="all">全部状态</option>
          <option value="ready">可取回</option>
          <option value="unopenable">取不回</option>
          <option value="archived">已归档</option>
        </select>
        <input type="search" id="rpAsin" placeholder="按 ASIN 筛，如 B0BRKPVZB4">
        <select id="rpMarket">
          <option value="">全部站点</option>
          <option>US</option><option>DE</option><option>JP</option>
          <option>UK</option><option>CA</option><option>FR</option>
        </select>
        <select id="rpProductLine"><option value="">全部产品线</option></select>
        <select id="rpCreatedBy"><option value="">全部创建者</option></select>
        <select id="rpTag"><option value="">全部标签</option></select>
        <label class="hint" style="padding:0"><input type="checkbox" id="rpFav"> 只看收藏</label>
        <input type="date" id="rpSince" title="只看这个日期之后生成的报告">
        <button id="rpClear">清除筛选</button>
      </div>
      <div class="bar">
        <span class="hint" style="padding:0">生成报告：</span>
        <select id="rpBuildKind"></select>
        <input type="search" id="rpBuildAsin" placeholder="ASIN（健康 / 竞品差距要填）">
        <select id="rpBuildMarket">
          <option value="">站点（同上）</option>
          <option>US</option><option>DE</option><option>JP</option>
          <option>UK</option><option>CA</option><option>FR</option>
        </select>
        <button id="rpBuild">生成并登记</button>
        <span class="hint" id="rpBuildHint" style="padding:0"></span>
      </div>
      <div id="rpstats"></div>
      <div id="rptable"></div>
      <!-- P2-4 月度花费。它统计的是**广告花费**，不是采集成本（采集走本地浏览器不花钱），
           所以标题就写着"广告花费"，避免读者把它当成采集开销。 -->
      <div id="rpspend"></div>
      <div id="rpdetail"></div>
      <div class="hint">报告在<strong>产生它的那一步</strong>登记，两条路：<br>
      ① <strong>索引类</strong>（前三类）由产生它的那一步写 —— <code>amzn_optimize_save</code> 与关键词总库出表；<br>
      ② <strong>生成类</strong>（其余八类：数据质量 / 采集 / ASIN 健康 / 竞品差距 / 规则政策影响 / Prompt·Agent 评估 / 发布后效果 / 运营汇总）由上面那排按钮（或 <code>amzn_report_build</code>）<strong>在你要它的那一刻</strong>生成并冻结。<br>
      这一页是<strong>索引</strong>：优化轮次的报告正文在 <code>optimization_run.report_html</code>，生成类报告的正文在报告行自己身上（那八类没有别的地方承载它），总库那边的报告与 CSV 是磁盘上的文件。<br>
      「取不回」表示正文已经不在了（run 被删、文件被移走）。它仍会列出来 —— 藏掉它会让历史看起来是完整的；「已归档」也一样，归档不是删除。</div>
    </div>
    <div class="panel" id="panel-agent" hidden>
      <div class="bar"><span class="hint" id="agHint" style="padding:0"></span>
        <button id="agReload" style="margin-left:auto">重新读取</button></div>
      <div id="agruns"></div>
      <div id="agrun"></div>
      <!-- F12-08 修改后接受：编辑区。**只在运行详情里**（独立列表不画写入口，
           见 artifactDecideCell 的注释）。空的时候是空字符串，不占位。 -->
      <div id="agamend"></div>
      <!-- F12-07：产物的**独立列表视图**。在此之前，产物表唯一画在 #agrun 里
           （选中那一次运行的详情块），跨运行的入口是零 —— 「产物列表只有内嵌表」。
           这是一个**面板内 section**，不是第五个模块：产物属于模块 12，给它加一个
           模块 id 就要连带改 store 分片，收益是零（先例：sect-observation/sect-rollback）。
           筛选 bar 照报告专区，但**没有搜索框** —— 产物没有可搜的文本字段。 -->
      <div class="rule-sect">产物（跨运行；这是一个独立列表视图，不是某次运行的内嵌表）</div>
      <div class="bar">
        <select id="agArtType"><option value="">全部类型</option></select>
        <!-- F12-07 修正：状态选项**由服务端下发的标签合成**（renderAgentArtifacts），
             这里不留第二份中文 —— 一份状态中文名曾经活在这个下拉与状态列（共 5 处）
             各一处，改一处就漂一处。先例：任务类型的中文名下发（taskTypeLabels）。 -->
        <select id="agArtStatus"><option value="">全部状态</option></select>
        <button id="agArtClear">清除筛选</button>
      </div>
      <div id="agartifacts"></div>
      <div class="rule-sect">角色（本版只有三个可用，其余写明缺什么）</div>
      <div id="agroles"></div>
      <div class="rule-sect">指标（§14：只给算得出来的数字，算不出来的写明缺哪份记录）</div>
      <div id="agmetrics"></div>
      <div id="aggaps"></div>
      <div class="hint">这一版交付的是<strong>编排骨架 + 留痕 + 门禁</strong>，不是 LLM 调用：分析、生成与编排
      由 DSH Agent 在会话侧完成，插件负责确定性查询、校验与本地写入。运行 id 在会话里和这一页是同一个 ——
      对话里说 <code>amzn_agent_run_start</code>，这里就会出现那一行。<br>
      一次运行的上下文包（对象范围 / 数据快照 / 规则快照 / Prompt 快照）在开始时<strong>拷贝冻结</strong>：
      运行中升级规则或 Prompt 不会改变它，新运行才拿得到新版本。</div>
    </div>
    <div class="panel" id="panel-settings" hidden>
      <div class="bar">
        <span class="hint" id="setHint" style="padding:0"></span>
        <button id="setReload" style="margin-left:auto">重新读取</button>
      </div>
      <div class="rule-sect">首次设置向导（三步：工作空间+站点 → 店铺+品牌 → 产品线。每步只需<strong>必填项</strong>通过即标记「可采集」，其余可稍后完善、不阻断）</div>
      <div id="setwizard"></div>
      <div class="rule-sect">工作空间（配置属于它：限速、产品线、数据源、站点档案。ASIN 与关键词是市场事实，跨空间共用）</div>
      <div id="setworkspaces"></div>
      <div id="setpace"></div>
      <div class="rule-sect">采集参数（下次采集任务生效）</div>
      <div id="setform"></div>
      <div class="rule-sect">站点邮编（覆盖采集站点自带的邮编；留空即恢复站点默认）</div>
      <div id="setmarkets"></div>
      <div class="rule-sect">站点档案（域名 / 语言 / 币种 / 单位 / 标题上限来自规则口径，<strong>只读</strong>；这里只改本地化偏好，并记录核验事件）</div>
      <div id="setsites"></div>
      <div class="rule-sect">店铺与品牌（品牌决定「这是谁的」；<code>自有 / 竞品</code> 是品牌的属性，不是某个 ASIN 的）</div>
      <div id="setshops"></div>
      <div id="setbrands"></div>
      <div class="rule-sect">选中 ASIN 的归属（关系记录：<code>auto</code> 是判定、<code>manual</code> 是人工覆盖；覆盖不删原记录）</div>
      <div id="setownership"></div>
      <div class="rule-sect">采集与数据源（浏览器 profile / CDP 端口 / 登录态 / 默认通道 / 导入目录 / 第三方连接状态）</div>
      <div id="setcollect"></div>
      <div class="rule-sect" id="sect-sources">数据源管理（凭据只写不读：密钥写入后不再回显，本页、日志、工具结果都不含明文）</div>
      <div id="setsources"></div>
      <div class="rule-sect" id="sect-productlines">产品线管理（产品线是 ASIN 库的分组维度；信号词决定一个关键词归到哪条线）</div>
      <div id="setlines"></div>
      <div class="rule-sect" id="sect-approvals">审批策略（六项可开可关的二次确认：其中五项已经接在各自的动作上，打开就会真的拦；「标记发布」那一项到这里为止没有可接的动作，只是登记。另有三项硬审批 —— 它们不是一个可以关的开关，而是一条陈述：本插件里没有能关掉它们的键）</div>
      <div id="setapprovals"></div>
      <div class="rule-sect">已核验的市场事实（<strong>只读</strong>）</div>
      <div id="setfacts"></div>
      <div class="hint">这四块的界线是本页存在的原因：<strong>偏好</strong>可改（采集限速、邮编、浏览器账号、审批开关），
      <strong>已核验的市场事实</strong>不可改（标题上限、字符单位、核验来源）—— 能改它，就等于能改「这个标题合不合法」的答案。
      <strong>密钥</strong>属于使用它的那个数据源，写在 <code>source.config_json</code>，任何页面与工具都不会把它读出来。
      <strong>硬审批</strong>连键都没有：不是「有一个键但写入时拦」，而是根本没有那个键，所以没有绕过的入口。</div>
    </div>
    <div class="panel" id="panel-rules" hidden>
      <div class="bar">
        <select id="ruleVersion"></select>
        <button id="ruleImport">导入规则手册</button>
        <button id="ruleDiff">版本对比</button>
        <button id="ruleActivate">启用此版本</button>
      </div>
      <div id="rulestats"></div>
      <div class="hint"><b>第一版：72 条全部是 code</b>（判定在 <code>registry.js</code> 的 <code>CHECKS</code> 里按 <code>rule_id</code> 索引）。<code>lexicon</code> / <code>threshold</code> 是留给用户自己加规则的能力，现有 72 条一条都不是这类。</div>
      <div id="ruletable"></div>
      <div class="rule-sect" id="rulemissingtitle">有判定无文档（<code>kind=code</code> 规则的 source 在手册里找不到出处）</div>
      <div id="rulemissing"></div>
      <div class="rule-sect" id="ruledocstitle">有文档无判定（手册小节没有任何 code 规则引用它）</div>
      <div id="ruledocs"></div>
      <div id="ruleimpl"></div>
      <div class="hint">单条勾选直接写库（<code>POST /api/rule-toggle</code>）：单事实、可逆，不弹窗、不等 agent。启用或停用会造一个新版本 —— 规则行不可变，老报告的解释链不断。</div>
    </div>
    <div class="panel" id="panel-policy" hidden>
      <div class="bar">
        <select id="policyStatus">
          <option value="">全部状态</option>
          <option value="active">生效中</option>
          <option value="superseded">已被取代</option>
          <option value="expired">已过期</option>
        </select>
        <input type="date" id="policySince" title="只看这个日期之后生效的政策">
        <button id="policyClear">清除筛选</button>
        <span class="hint" id="policyHint" style="padding:0"></span>
      </div>
      <div id="policystats"></div>
      <div id="policycandidates"></div>
      <div id="policytable"></div>
      <div id="policydetail"></div>
      <div class="hint">政策是<strong>输入</strong>、规则是<strong>产物</strong>：同一条件管道，政策在上游。政策以 <code>人工粘贴 / 文件导入</code> 为主；「检查最新政策」通过 SearXNG 检索公开结果，只落<strong>候选证据</strong>，人工确认后才入库 —— 搜索失败会如实标失败，不会当成「没有新政策」。解析不出的字段一律留 <code>NULL</code> 并显示「未判定」，不编结论。</div>
    </div>
    <div class="panel" id="panel-prompts" hidden>
      <div class="bar">
        <span class="hint" id="promptHint" style="padding:0"></span>
      </div>
      <div id="promptstats"></div>
      <div class="prompt-editor">
        <div class="prompt-list" id="promptList"></div>
        <div class="prompt-form" id="promptForm"></div>
      </div>
      <div id="promptEval"></div>
      <div id="promptCompare"></div>
      <div class="hint">提示词是<strong>数据</strong>：按钮（<code>button</code>）给用户点，组装提示词（<code>assemble</code>）是 <code>amzn_optimize_prepare</code> 交给 agent 的写作策略，分固定策略 / 证据 / 输出契约三层。改完保存，下一次刷新页面（按钮）或下一次 <code>prepare</code>（组装）就生效。变量只能用 <code>scope</code> / <code>selectedKeywords</code> / <code>rulesVersion</code>，别的名字会被拒 —— 渲染成空比报错更难查。</div>
    </div>
    <div class="panel" id="panel-shops" hidden>
      <div class="bar">
        <span class="hint" id="shopsHint" style="padding:0"></span>
        <button id="shopsReload" style="margin-left:auto">重新读取</button>
      </div>
      <div id="shopsmain"></div>
    </div>
${MODULE_GROUPS.flatMap(group => group.modules).concat(EXTRA_MODULES).filter(m => !RICH_PANELS.includes(m.id)).map(m => `    <div class="panel" id="panel-${m.id}" hidden></div>`).join('\n')}
    <div class="panel" id="panel-unknown" hidden></div>
  </div>
</main>
<script>
const INITIAL = ${embed(initialState)};
const PAGE = ${embed(pagePath)};

/* P1a：侧边栏渲染 7 组 NAV_GROUPS；MODULE_GROUPS 仍是模块注册表（panel、
   MODULES/MODULE_IDS、set({module}) 都由它派生），两者共用同一批模块对象。 */
const GROUPS = ${embed(NAV_GROUPS)};
/* P1b：旧 module/组 id 的兼容表。客户端没有模块系统，所以服务端把同一张表
   注入进来；不要在页面里再手写一份。 */
const LEGACY_MODULE_ALIASES = ${embed(LEGACY_MODULE_ALIASES)};
/* 与 workbench.js 的 resolveDeepLink 同一口径的客户端版本：只认 module/hash/
   tab/drawer，不做别的。 */
function resolveDeepLinkClient(search, hash, moduleIds) {
  const params = new URLSearchParams(String(search || '').replace(/^\\?/, ''));
  const hashes = String(hash || '').replace(/^#/, '').trim();
  const raw = params.get('module') ?? (hashes === '' ? '' : hashes);
  const wanted = String(raw || '').trim();
  const resolved = LEGACY_MODULE_ALIASES[wanted] ?? wanted;
  const module = moduleIds.includes(resolved) ? resolved : null;
  const filters = {};
  const tab = params.get('tab');
  const drawer = params.get('drawer');
  if (tab !== null && String(tab).trim() !== '') filters.tab = String(tab).trim();
  if (drawer !== null && String(drawer).trim() !== '') filters.drawer = String(drawer).trim();
  return { module, filters };
}
const SIGNAL_CATEGORIES = ${embed(SIGNAL_CATEGORIES)};
const TODO_BUCKETS = ${embed(TODO_BUCKETS)};
const EMPTY_BUCKET_TEXT = ${embed(EMPTY_BUCKET_TEXT)};
const DISMISS_SETTING_KEY = ${embed(DISMISS_SETTING_KEY)};
const SETUP_STEP_IDS = ${embed(SETUP_STEP_IDS)};
const SCOPE_ALL = ${embed(SCOPE_ALL)};
/* 模块 04 的两份词表：采集任务十态与 13 节五态。**由服务端注入**（上方的
   TASK_STATUS_CHIPS / SECTION_STATUS_CHIPS 从 domain/states.js 组装）—— 脚本里不再有
   第二份。TASK_STATUS 仍是对象字面量，所以下面 statusChip 的 hasOwnProperty 防御照旧成立。 */
const TASK_STATUS = ${embed(TASK_STATUS_CHIPS)};
const SECTION_STATUS = ${embed(SECTION_STATUS_CHIPS)};
const ENV_STATE = ${embed(ENV_STATES)};
const RISK_LEVEL = ${embed(RISK_LEVELS_TABLE)};
const WAITING_TRIGGER = ${embed(WAITING_TRIGGERS_TABLE)};
/* 第三子批后半（F04-09 / F04-10）的四张小表，同样是注入而不是手写：
   方案四态（含中文标签）、13 节的 id→节名、失败策略、通知口径。 */
const SCHEME_STATUS = ${embed(SCHEME_STATUS_CHIPS)};
const SECTION_NAME = ${embed(SECTION_NAMES)};
const PLAN_FAILURE = ${embed(PLAN_FAILURE_TABLE)};
const PLAN_NOTIFY = ${embed(PLAN_NOTIFY_TABLE)};
/* domain 的 empty.kind → 页面四态的映射表，同样注入而不是在页面里再写一份。
   理由与上面几张表一样：两份就会漂，而漂开时的症状是「某一类空态永远显示成另一种」，
   两边都不报错。表由 domain 拥有（domain/ui/empty-kind.js），漏映射有测试会红。 */
const DOMAIN_EMPTY_KIND_TO_UI = ${embed(DOMAIN_EMPTY_KIND_TO_UI)};
/* 模块 05 的 CSV 导出：把 domain/asin/table.js 里的**那一份**实现整个搬进浏览器。
   ⚠️ 这是修一个**既有缺陷**：exportAsinCsv() 一直调 asinTableCsv(columns, rows)，
   而它在此之前只是 page.js 顶部的 ESM 导入 —— ESM 名字进不了模板字面量的作用域，
   所以点「导出 CSV」一直是 ReferenceError，只是没人测过那条路径。

   注入而不是在页面里重写：CSV 的转义规则（引号 / 逗号 / 换行 / UTF-8 BOM）与工具侧
   amzn_asin_export 必须是同一份。写第二份迟早「工具导出的文件」与「页面下载的文件」
   两条规则漂开，而漂开时两边都不报错 —— 那正是本仓招牌缺陷的形状。

   函数源码里的反引号不需要转义：插进来的是一段**值**，模板的词法扫描已经结束，
   不会回头再扫它。（只在这里写一次说明，省得下一个人以为这里漏了转义。） */
const ASIN_NO_SOURCE_TEXT = ${embed(ASIN_NO_SOURCE_TEXT)};
const ASIN_MISSING_TEXT = ${embed(ASIN_MISSING_TEXT)};
${csvCell.toString()}
${asinCellText.toString()}
const asinTableCsv = ${asinTableCsv.toString()};
/* 方案状态机整张（含 obsolete 的空出口）—— 页面的按钮由它过滤，不由页面自己声明合法性。 */
const SCHEME_EDGES = ${embed(SCHEME_EDGES)};
/* 模块 05：ASIN 详情四个标签页的顺序与中文名，以及**还没建的五个**（含它们属于哪个
   功能点）。注入而不是手写 —— 与上面两张词表同一个理由。 */
const ASIN_TAB_ORDER = ${embed([...ASIN_DETAIL_TABS])};
const ASIN_TAB_LABELS = ${embed(ASIN_DETAIL_TAB_LABELS)};
const ASIN_PENDING_TABS = ${embed(ASIN_DETAIL_PENDING_TABS.map(tab => ({ id: tab.id, label: tab.label, feature: tab.feature })))};
/* B-05c：F05-04 的变化类别与归因标签、F05-07 的六项 id 与四态、F05-05 的分隔符名，
   以及那句「本仓没有来源」。全部注入 —— 页面里没有第二份。 */
const ASIN_CHANGE_KIND_ORDER = ${embed([...ASIN_CHANGE_KINDS])};
const ASIN_CHANGE_KIND_LABELS = ${embed(ASIN_CHANGE_KIND_LABELS)};
const ASIN_ATTRIBUTION_LABELS = ${embed(ASIN_ATTRIBUTION_LABELS)};
const ASIN_HEALTH_ITEM_IDS = ${embed([...ASIN_HEALTH_ITEM_IDS])};
const ASIN_HEALTH_STATES = ${embed([...ASIN_HEALTH_STATES])};
const ASIN_HEALTH_STATE_LABELS = ${embed(ASIN_HEALTH_STATE_LABELS)};
const ASIN_HEALTH_NO_SOURCE_TEXT = ${embed(ASIN_HEALTH_NO_SOURCE_TEXT)};
const ASIN_IMPORT_DELIMITER_LABELS = ${embed(ASIN_IMPORT_DELIMITER_LABELS)};
/* F05-01：ASIN 大表的 17 列目录（id / 列名 / 有没有来源 / 没有来源时的解释）、
   需要翻译的那几张中文表、以及默认可见列。**注入而不是在脚本里手写** —— 与上面三张
   ASIN 详情词表同一个理由：脚本是模板字符串、没有模块系统，写第二份就会与工具印的
   漂开，而漂开时的症状是那一格永远空着（本仓在 keyword_ranked 上真出过这一种）。 */
const ASIN_COLUMNS = ${embed(ASIN_COLUMNS.map(column => ({
    id: column.id, label: column.label, hasSource: column.hasSource !== false, note: column.note,
    /* 「关键列」标记也要一起注入：页面的「只看关键 N 列」预设靠它筛，
       而列清单只许有服务端这一份（B05T-⑦a 会搜页面脚本里的列 id 字面量）。
       漏掉这个字段时预设会筛出 0 列，看起来像「点了没反应」。 */
    key: column.key === true,
    /* 「这是一列数字」。右对齐 + 等宽数位，一列 89.99 / 1200 / 63421 才看得出大小。
       同样是目录里的一个字段，不在页面里按列 id 写第二份清单。 */
    numeric: column.numeric === true,
    /* 「点这一列表头能按它排序」：值是 filters.order 的那个词（asin / bsr / reviews / updated）。
       与上面两条同一个理由 —— 哪几列可排也是目录的属性，不在页面里写第二份。 */
    order: column.order === undefined ? null : column.order,
  })))};
const ASIN_CELL_LABELS = ${embed(ASIN_CELL_LABELS)};
const ASIN_DEFAULT_COLUMNS = ${embed(ASIN_DEFAULT_COLUMNS)};
/* 截断那一行的措辞：与工具印的同一份，服务端注入，脚本里不写第二遍。 */
const SECTION_READ_TRUNCATED = ${embed(SECTION_READ_TRUNCATED_LABEL)};
/* 「看见了、却没读出来」那一行的措辞（真机：variations 读到维度行、12 个色块一个子 ASIN
    都没解析出来，却仍印 partial）—— 与工具印的同一份，同样是注入而不是手写。 */
const SECTION_CONTENT_UNREAD = ${embed(SECTION_CONTENT_UNREAD_LABEL)};
/** 「没读到」的布尔从哪里来：**只从载荷上读** —— entry.contentUnread，由服务端用
    domain/collect/sections.js 的 sectionContentUnread 算好，两个载荷都带它
    （ASIN 详情区走 buildSectionView，采集面板的 13 节走 B-04 的 sectionEntry）。

    这里**不许**再写第二份判据。曾经写过：那一段从行上已有的 signals（errors_json 的
    VARIATION_CHILDREN_UNREAD / parsed_value 的 child_tiles>0 且 children:[]）当场重算，
    理由是「采集面板的载荷上没有这个布尔」。信号确实同源，但**判据抄了两遍** —— 把域层的
    sectionContentUnread 改坏，页面就回退到自己的那一份、照样印标记，于是工具侧的断言
    红了、页面侧的断言保持绿，而两份实现已经分歧、没有任何东西失败。这与本文件 :63 那条
    先例是同一个坑（"a state whose label the page guessed would show a different word
    from the one the tool prints for the same row, and nothing would fail"）：
    **服务端算，页面只画**。

    字段缺失（老载荷、别的调用方）一律当作「不亮」：undefined 不是 true，页面不替
    服务端猜，也不把「没测过」读成「测过是假的」。 */
function sectionContentUnreadMark(entry) {
  if (entry === null || typeof entry !== 'object') return '';
  if (entry.contentUnread !== true) return '';
  return ' <span class="chip" style="color:var(--warn)" data-content-unread="1">' + SECTION_CONTENT_UNREAD + '</span>';
}
/* T61：asins 初始是 null（还没取过），不是 []（取了、是 0 条）—— 未取 ≠ 读到 0。
   refresh 失败或还没跑时若画「还没有 ASIN」，就是把「没取到」当「没有」（R6 四态
   口径违反）。renderTable 的 null 分支画「服务端没有给这一格」，两态各说各的话。
   T66：total 与 tasks 同规 —— 0 / [] 是「读到的真值」，「没取到」只能是 null。 */
const state = { context: INITIAL.context, asins: null, total: null, tasks: null, collection: null, collectPanel: null, commandPalette: null, filters: { ...INITIAL.context.filters }, foldedGroups: {}, policy: null, selectedPolicyId: null, competitor: null, research: null, prompts: null, selectedPromptId: null, reports: null, reportFocus: '', settings: null, shops: null, asinArchived: null, asinArchivedHidden: null, asinArchivedTotal: null, asinArchivedFilterError: null };
/* Which in-panel section we last jumped to. Deliberately outside the state
   object: it is not server data and must never be sent back up, but it has to
   survive a re-render, which is exactly what it is for. See scrollToSection(). */
let lastSection = null;
/* F13-01：「继续审阅」跳过的最后一个字段卡。与 lastSection 同类 —— 内存里的界面状态，
   不写库、不上报，但要跨一次重渲染活下来，否则每次渲染都会再跳一次。 */
let lastFocusedField = null;

/* 模块 08 F08-04：已预览、等待二次确认的那次批量操作。它是**内存里的界面状态**
   （和 lastSection 同类，不写库）：预览算出影响面，确认按钮才真的写。确认前必须
   先预览 —— 一个能写出操作者没看过的东西的按钮，正是这两步流程要防的东西。 */
let pendingOwnership = null;
const $ = (id) => document.getElementById(id);
let pollTimer;

/* The sticky nav hangs off the header's real height, and the header is not a
   fixed height: the status chips wrap on narrow windows. So the offset is a
   measured CSS variable, re-measured when the window changes shape. */
const setHeaderH = () => {
  const header = document.querySelector('header');
  if (header) document.documentElement.style.setProperty('--hdr-h', header.offsetHeight + 'px');
};
addEventListener('resize', setHeaderH);
setHeaderH();

/* ── data ─────────────────────────────────────────────────────────────── */

async function api(path, options) {
  const response = await fetch(PAGE + '/api/' + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (!response.ok) {
    /* The server's own message ("unknown module \"keyword\"") is the useful part;
       the status line alone would say "400 Bad Request" and nothing more. */
    let detail = '';
    let body = null;
    try {
      body = await response.json();
      if (body && body.error) detail = ': ' + body.error;
    } catch { /* not JSON — the status line is all we have */ }
    const error = new Error(response.status + ' ' + response.statusText + detail);
    /* The parsed body rides along so a caller can branch on the code. Sniffing the
       message text for "409" would break the first time somebody reworded a
       sentence, and the approval gate needs a branch here: its 409 is a question
       being relayed, not a failure being reported. */
    if (body !== null && typeof body === 'object') {
      error.code = body.code ?? null;
      error.body = body;
    }
    throw error;
  }
  return response.json();
}

/* A POST that may hit an approval gate.
 *
 * 409 + APPROVAL_REQUIRED is not a failed write, it is the server asking the
 * person in front of the screen whether they mean it — this workspace has turned
 * on 归档 二次确认. So the question is relayed and, only on an explicit yes, the
 * same call is repeated with confirm: true. A declined confirmation throws, the
 * object is left untouched, and the banner says why.
 *
 * window is guarded because this script is also compiled outside a browser (the
 * test harness runs it against a DOM stub). With no confirm available the refusal
 * is surfaced as-is, which is the honest fallback: the page cannot manufacture a
 * confirmation that no person gave. */
async function apiWithApproval(path, body) {
  try {
    return await api(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    if (error.code !== 'APPROVAL_REQUIRED') throw error;
    /* The confirm text is escaped twice on purpose: this file is one template
       literal, so a lone \n here would be consumed by it and the emitted script
       would contain a real newline inside a string literal. */
    const asked = typeof window !== 'undefined' && typeof window.confirm === 'function'
      && window.confirm(String(error.body.reason || '') + '\\n\\n确认继续？');
    if (asked !== true) throw error;
    return await api(path, { method: 'POST', body: JSON.stringify({ ...body, confirm: true }) });
  }
}

/* state.filters mirrors the server's copy and is refreshed on every read.
   It used to be seeded once at mount and never updated, so the second control
   you touched rebuilt the filter bag from that stale seed and dropped the
   first one — pick a tier, then type a search, and the tier silently went
   away. The controls each send "everything I know plus my one change", so
   the seed has to stay current. */
function adoptContext(context) {
  state.context = context;
  state.filters = { ...(context.filters ?? {}) };
}

async function refresh() {
  const data = await api('state');
  /* 非 ok 的响应**一个已有切片都不许覆盖**（T61）。坏法有三种：HTTP 非 2xx
     （api() 会抛，本来就走不到赋值）、HTTP 200 但正文 ok:false、正文里没有 context。
     后两种若走到赋值区，data.xxx 的 undefined 会被逐格写进 state —— 面板集体画成
     「还没有数据」，而库里明明有。所以这里先判正文：坏响应只进错误横幅，
     旧切片原样留着 —— 宁可显示上一次的旧数据，也不把「读取失败」画成「没有数据」。
     （这段注释不写反引号：外层是模板字面量，反引号会在这里把字符串断开。） */
  if (data === null || typeof data !== 'object' || data.ok === false
    || data.context === null || data.context === undefined) {
    showPageError(new Error('状态读取失败：'
      + (data !== null && typeof data === 'object' && data.error ? String(data.error) : '响应里没有 ok/context')
      + '（页面保留上一次的数据）'));
    return;
  }
  /* A successful read means whatever failed before has cleared. */
  clearPageError();
  adoptContext(data.context);
  state.asins = data.asins;
  state.total = data.total;
  /* 全库已归档的条数（F05-08）。**不加兜底默认值**：这一格有三种值，而它们说的是三件事 ——
     一个数字是「读到了」，null 是「这一次读不出来」，undefined 是「服务端根本没给这一格」。
     兜成一个 0 就把后两种合成「一条都没归档」，那正是本仓最贵的那一类静默失败。 */
  state.archivedAsins = data.archivedAsins;
  /* B-05e 的读回对账四格。与 archivedAsins **同一条约定：一个兜底默认值都不加** ——
     null 是「这一次没取」，0 是「取了、就是 0 条」。asinArchivedHidden 尤其不能兜
     成 0：它在 only / all 下真的是 0（事实），在「服务端没给这一格」时是 null（不知道），
     而这两句话在页面上必须是两句。 */
  state.asinArchived = data.asinArchived;
  state.asinArchivedHidden = data.asinArchivedHidden;
  state.asinArchivedTotal = data.asinArchivedTotal;
  state.asinArchivedFilterError = data.asinArchivedFilterError;
  /* F05-01：17 列的列目录 / 生效列 / 认不出的列 id / 保存视图 / 筛选候选值。
     **同样不加兜底默认值**：null 是「这一次没取」（不是 ASIN 模块），空数组是
     「取了、里面没有」。兜成空数组会让一个不是 ASIN 模块的响应把选择框画成
     「你一个视图都没存过」—— 一句关于用户的断言，而服务端根本没说过。
     NB: 这一段的注释里不许出现反引号（外层模板会在这里断开）。 */
  state.asinColumns = data.asinColumns;
  state.asinVisibleColumns = data.asinVisibleColumns;
  state.asinUnknownColumns = data.asinUnknownColumns;
  state.asinSavedViews = data.asinSavedViews;
  state.asinFilterOptions = data.asinFilterOptions;
  state.status = data.status;
  state.sources = data.sources;
  /* T66：缺这一格时留 null（未取），不折成 [] —— [] 是「读到的空」。 */
  state.tasks = data.tasks ?? null;
  state.collection = data.collection || null;
  /* 采集面板的只读切片（契约 §6.3）。**必须赋值**：renderCollect 读的每一个切片字段
     都得有人给它写值，否则会退化成「空库」的样子 —— 页面看起来一切正常，只是没有任何
     数据，而这正是本仓反复出现的一类静默失败。
     （这段注释刻意不写成「state 点字段名」的形态：套件里那条源级断言会把注释里出现的
     这种形态当成一次读取，然后报「读了但没人赋值」。） */
  state.collectPanel = data.collectPanel || null;
  state.optimizations = data.optimizations || null;
  state.keywords = data.keywords || null;
  state.coverage = data.coverage || null;
  state.master = data.master || null;
  state.pipeline = data.pipeline || null;
  state.rules = data.rules || null;
  state.policy = data.policy || null;
  state.reports = data.reports || null;
  state.snapshots = data.snapshots || null;
  /* The retention slice (S1-B19) rides beside the snapshot slice: the snapshot
     view needs it to say which rows something still points at. Left unassigned
     it would read as "nothing is referenced" on every poll, and the delete button
     would look available on a row the store will refuse — the exact "button that
     always fails" this assignment exists to prevent. */
  state.retention = data.retention || null;
  state.conflicts = (data.quality && data.quality.conflicts) || null;
  /* The audit slice rides inside the quality payload like the conflict one, and
     is lifted to its own field for the same reason: the view reads it on its
     own, and a slice buried two levels down is one nobody notices went missing.
     Left unassigned it would read as "the log is empty" on every poll — the
     exact failure this assignment exists to prevent. */
  state.audit = (data.quality && data.quality.audit) || null;
  /* 通知是顶层切片，不属于任何模块 —— 铃在每一页上。 */
  state.notifications = data.notifications || null;
  state.settings = data.settings || null;
  state.shops = data.shops || null;
  /* 模块 12 的任务画布：跟着模块的惰性切片，只有看着它的时候才有值。 */
  state.agent = data.agent || null;
  /* P3-4 命令面板数据：顶层切片，与 tasks 同级 —— 站在任何页签上都会到。 */
  state.commandPalette = data.commandPalette || null;
  state.home = data.home || null;
  state.quality = data.quality || null;
  state.competitor = data.competitor || null;
  state.research = data.research || null;
  /* ASIN 组合概览：内容完整度分级与缺口。只在 asin 模块有值（其余模块是 null）。 */
  state.asinPortfolio = data.asinPortfolio || null;
  state.prompts = data.prompts || null;
  /* 模块 08 F08-04：页头冲突徽标的读数。顶层切片，不属于任何模块 —— 徽标在顶栏，
     每一页都要显示。左值未赋值会让它读成「没有冲突」，正是这次赋值要防的那件事。 */
  state.ownershipStats = data.ownershipStats || null;
  render();
  schedulePoll();
}

/* A running collection changes without anyone clicking, so the page polls while
   there is work in flight and stops as soon as there is not. The SSE feed also
   carries collect: events; this is the belt to that braces. */
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = state.collection && (state.collection.running || state.collection.queueDepth > 0);
  if (busy) pollTimer = setTimeout(() => refresh().catch(() => {}), 3000);
}

/* Failures have to land somewhere visible. A rejected click used to become an
   unhandled promise rejection: the panel kept showing the old module and nothing
   said why. This banner is the somewhere. */
function showPageError(error) {
  const box = $('pageError');
  if (!box) return;
  box.textContent = '操作失败：' + ((error && error.message) ? error.message : String(error));
  box.hidden = false;
}

function clearPageError() {
  const box = $('pageError');
  if (!box) return;
  box.hidden = true;
  box.textContent = '';
}

async function patchContext(patch) {
  try {
    const data = await api('context', { method: 'POST', body: JSON.stringify(patch) });
    adoptContext(data.context);
    /* A filter or module change alters what the server returns, so re-read
       instead of re-rendering the old payload — otherwise switching to 优化队列
       would draw the empty panel the previous fetch left behind. */
    await refresh();
  } catch (error) {
    /* Not an unhandled rejection: say what failed and keep the previous panel. */
    showPageError(error);
  }
}

/* ── rendering ────────────────────────────────────────────────────────── */

function render() {
  renderStatus();
  renderScopeBar();
  renderNotifications();
  renderNav();
  renderMain();
}

/* P1b：URL 深链兼容（旧 module id / 旧组 id / ?tab= / ?drawer=）。
   只应用一次；认不出的 module 保持当前页面，不 404、不白屏。服务端页面入口
   不解析 query，所以适配放在客户端这一层，routes.js 不动。 */
let deepLinkApplied = false;
function applyDeepLink() {
  if (deepLinkApplied) return;
  deepLinkApplied = true;
  const link = resolveDeepLinkClient(location.search, location.hash, GROUPS.flatMap(group => group.modules).map(module => module.id));
  const hasFilters = Object.keys(link.filters).length > 0;
  if (link.module === null && !hasFilters) return;
  const filters = { ...state.filters, ...link.filters };
  if (link.module === null) { patchContext({ filters }).catch(showPageError); return; }
  if (link.module === state.context.module && !hasFilters) return;
  patchContext({ module: link.module, filters }).catch(showPageError);
}
if (typeof window !== 'undefined' && typeof document !== 'undefined'
  && typeof window.addEventListener === 'function') {
  if (document.readyState === 'complete') setTimeout(applyDeepLink, 300);
  else window.addEventListener('load', () => setTimeout(applyDeepLink, 300));
}

/* The scope bar above. The text arrives in state.context.scopeText, computed
   server-side by describeScope — the same function amzn_workbench_context
   renders — because this script has no module system to import it with, and a
   second copy of the format written out here is exactly the drift that would
   make the bar and the agent describe one scope two ways.

   The title attribute carries the same words plus what the format does not
   spell out: the five levels, in order. A tooltip is where a reader looks when
   the abbreviated line is not enough.
   NB: no backticks in this comment — it sits inside the script string. */
function renderScopeBar() {
  const box = $('scope');
  if (box === null) return;
  const text = (state.context && state.context.scopeText) ? state.context.scopeText : '上下文未就绪';
  box.textContent = text;
  box.title = '当前上下文：workspace / 站点 / 店铺 / 品牌 / 产品线，以及选中数量 — ' + text;
}

/* The middle column has three views and they are switched, not all rendered:
   the collection task list has no use for the ASIN filter bar, and the keyword
   library is a different table over a different table. */
/* Every module the nav declares has to be in one of these two maps. A module in
   neither renders the ASIN table, which is how the keyword tab looked alive
   while showing the wrong data; a module in neither also leaves its panel
   visible, so it fails loudly rather than silently. */
const PANEL_RENDERERS = {
  home: renderHome,
  quality: renderQuality,
  /* 模块 04：采集面板现在是四块（环境条 / 发起表单 / 任务列表 / 13 节详情）。
     renderTasks **保留**为内部的任务列表切片函数 —— 它已被页面行为依赖，#tasks
     也是 routes.js 与页面既有的挂载点约定（契约 §7.1）。 */
  collect: renderCollect,
  asin: renderAsinPanel,
  research: renderResearch,
  competitor: renderCompetitor,
  kw: renderMaster,
  pipeline: renderPipeline,
  optimize: renderOptimizations,
  report: renderReports,
  rules: renderRules,
  policy: renderPolicy,
  prompts: renderPromptEditor,
  settings: renderSettings,
  shops: renderShops,
  agent: renderAgent,
};

/* Modules that are declared in the nav but have nothing behind them yet, plus
   the ones whose renderer only covers part of the job. Each note says what
   exists now, what is missing, and what the page will do once it is built —
   an empty panel reads as "no data", which is a different and much more
   worrying claim.

   competitor and research were removed in B06: it gave both a renderer that
   covers the whole job, and a note left behind here would be dead code that
   still claims the module is unimplemented. (renderMain prefers the renderer, so
   the stale note would never have shown — which is exactly why leaving it would
   be worse than deleting it.)

   report and settings were removed in B07, for the same reason: the report
   centre and the settings surface both have a real renderer now.

   home was removed in B06 and quality in B08. quality's six views are all built
   now (catalog / cockpit / lineage / conflicts / snapshot / audit) and they are
   drawn *inside* the panel as sub-tabs, so QUALITY_PENDING is an empty object
   and the quality module never needed a module-level note. That leaves this map
   **empty**, which is the correct state and not a leftover: it is not a list of
   things that exist, it is the fail-loud path for the next nav tab added before
   its page. A module with neither a renderer nor a note renders as "未知模块",
   and an empty panel that reads as "no data" is the failure this map prevents.

   The invariant is asserted both ways in the suite: a module with a renderer may
   not have a note, and a module with neither may not be a nav module.

   NB: no backticks in this comment either — it lives inside the page's one big
   template literal, and a backtick here ends the string. */
const PANEL_NOTES = {
};

function renderMain() {
  const module = state.context.module;
  const panel = $('panel-' + module);
  /* An id with no panel is not a module this page knows — a tab left open across
     the keyword -> research rename, or a POST from an older client. Returning
     early here used to leave the middle column blank, which reads as "no data"
     and is exactly the silent failure this page must not have. Show a panel that
     says so instead. Hide by panel, not by module list, so a module that belongs
     to nothing still hides every panel rather than stacking them all. */
  const target = panel === null ? 'panel-unknown' : 'panel-' + module;
  for (const other of document.querySelectorAll('.panel[id^="panel-"]')) {
    other.hidden = other.id !== target;
  }
  if (panel === null) {
    $('panel-unknown').innerHTML = '<div class="empty">未知模块 '
      + escapeHtml(String(module)) + '：工作台里没有这个页签，请从左侧导航重新选一个。</div>';
    return;
  }
  const render = PANEL_RENDERERS[module];
  if (render) {
    render();
    /* After the render, never before: the target the nav or a link points at is
       part of the panel, so there is nothing to scroll to until it exists. Called
       for every module rather than only for settings — a 待办 link carries an
       anchor into whichever panel it names, and the lookup simply finds nothing
       when the current panel has no such target. */
    scrollToSection();
    return;
  }
  panel.innerHTML = '<div class="empty">'
    + escapeHtml(PANEL_NOTES[module] ?? '未知模块 ' + module)
    + '</div>';
}

/* Coverage for one selected ASIN, above the library table. Shown only when
   exactly one is selected, because a summary that averaged two products would
   describe neither. */
function renderCoverage() {
  const coverage = state.coverage;
  if (!coverage) { $('coverage').innerHTML = ''; return; }
  const s = coverage.summary;
  const parts = [
    ['有排名', s.ranked, 'ok'],
    ['已测无排名', s.gaps, s.gaps > 0 ? 'warn' : ''],
    ['未测', s.unscanned, ''],
    ['库内未测过本 ASIN', s.untested, ''],
  ];
  $('coverage').innerHTML = '<div class="bar" style="border-bottom:1px solid var(--line)">'
    + '<strong style="font-size:12px">' + escapeHtml(coverage.asin) + ' ' + escapeHtml(coverage.marketplace) + '</strong>'
    + parts.map(([label, value, cls]) => '<span class="chip ' + cls + '">' + escapeHtml(label) + ' ' + value + '</span>').join('')
    + '</div>';
}

function renderKeywords() {
  renderCoverage();
  const library = state.keywords;
  if (!library || library.rows.length === 0) {
    $('kwtable').innerHTML = '<div class="empty">关键词库还是空的。<br>在对话里让 agent 建库，例如：'
      + '<code>用 bluetooth speaker 做种子词扩词</code>，或<code>导入这份关键词表：…</code></div>';
    return;
  }

  const rows = library.rows.map(row => {
    const tier = row.tier
      ? '<span class="chip ' + (row.tier === 'T1' ? 'ok' : row.tier === 'T3' ? 'warn' : '') + '">'
        + escapeHtml(row.tier) + '</span>'
      : '<span style="color:var(--dim)">未测</span>';
    return '<tr data-keyword="' + escapeHtml(row.keyword) + '" data-marketplace="' + escapeHtml(row.marketplace) + '">'
      + '<td title="' + escapeHtml(row.keyword) + '">' + escapeHtml(row.keyword) + '</td>'
      + '<td>' + escapeHtml(row.marketplace) + '</td>'
      + '<td>' + tier + '</td>'
      + '<td>' + (row.ranked === 0 ? '' : row.ranked) + '</td>'
      + '<td>' + (row.missing === 0 ? '' : row.missing) + '</td>'
      + '<td>' + (row.unscanned === 0 ? '' : row.unscanned) + '</td>'
      + '<td>' + (row.search_volume === null ? '' : row.search_volume) + '</td>'
      + '</tr>';
  }).join('');

  $('kwtable').innerHTML = '<table><thead><tr><th>关键词</th><th>站点</th><th>分层</th>'
    + '<th>有排名</th><th>已测无排名</th><th>未测</th><th>搜索量</th></tr></thead><tbody>'
    + rows + '</tbody></table>'
    + '<div class="bar" style="border-top:1px solid var(--line)">'
    + '<span class="hint">共 ' + library.total + ' 条，显示 ' + library.rows.length + ' 条。'
    + '分层: T1 守位 / T2 冲刺 / T3 抢占 / T4 观察；「未测」是没量过，不是没排名。</span></div>';

  for (const tr of $('kwtable').querySelectorAll('tbody tr')) {
    tr.onclick = () => patchContext({
      selection: {
        ...state.context.selection,
        keywords: [{ keyword: tr.dataset.keyword, marketplace: tr.dataset.marketplace }],
      },
    });
  }
}

/* ── 关键词总库（导入数据）───────────────────────────────────────────── */

/* Deliberately a different panel from 关键词库, and the split is not cosmetic:
   that one shows what the browser measured about *our* ASINs, this one shows
   what exported files said about the *words*. The first section is the coverage
   statement, printed before any table, because a number without its coverage is
   how "31,805 keywords" gets read as "31,805 keywords with volumes" when 18,110
   of them have none. */
${kwScript}
${competitorScript}
${researchScript}
${rulesScript}
${policyScript}
${optimizeScript}
${reportScript}
${agentScript}
${settingsScript}
${homeScript}
${qualityScript}
${asinScript}
${collectScript}
${promptsScript}
${shopsScript}
</script>
</body>
</html>`
}
