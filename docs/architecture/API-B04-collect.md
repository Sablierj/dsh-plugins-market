# B-04 采集中心 · 接口契约（G2）

> **日期**：2026-10-04（主理人重编号与裁决） ｜ **作者角色**：架构师 ｜ **状态**：**G2 有条件通过** —— 见 `G2-B04-adjudication.md`
> **关联需求编号**：F04-01 / F04-02 / F04-03 / F04-04 / F04-05 / F04-06 / F04-07 / F04-08 / F04-09 / F04-10
> **关联需求文档**：`amazon-ops-需求设计文档-v2.0.md` §18（453–497 行）；`amazon-ops-模块设计-v1.0/04-采集中心.md`（202 行，§3 是 13 节的唯一定义）
> **证据等级**：本文「现状」一节的每一条都在本次作业中对着 `src/` 实测过（只读 `read`/`Select-String`/`node -e`），标 `verified`；引用需求文档与协同协议的标 `documented`。
> **批次**：B-04 ｜ **分支**：`dsh-b04`（proposed，见 `docs/COORDINATION.md:125`）｜ 主线工作树 `D:\deepseek-harness-h\workspace\dsh-plugins\amazon-ops`
> **基线（2026-10-04 主理人在开工前实测）**：`HEAD b2f0074`，`SCHEMA_VERSION` = **35**，`TOOLS` = **81**，`node tests/run.mjs` = 833 passed / 0 failed
> **本批目标版本（2026-10-04 重编号）**：schema **v36**，`TOOLS` 81 → **93**（**+12**，见 §6.2 的数字更正）

---

## 0. 范围与非目标

### 0.1 这一批做什么

| 功能点 | 本批交付的深度 |
|---|---|
| F04-01 环境体检 | 十项检测全部落地为**数据**（`collection_env_check` 一行一项），体检是独立动作 `amzn_collect_env_check`，被打过体检的任务冻结一份结果 |
| F04-02 环境修复 | 可修的四类动作变成**显式、可单独调用、可被拒绝的动作**（建目录 / 启动浏览器 / 重连端口 / 重设站点上下文）；不可修的四条禁令写成硬拒绝 |
| F04-03 发起采集 | 提交前**预览**独立成一个只读动作 `amzn_collect_preview`（六项）；新工具 `amzn_collect_run` 承担「先体检 → 再入队」的编排 |
| F04-04 外部入口预填 | 生产方（01/03/05/14 的 context_id）已有；本批补**消费方**：预填表、来源横幅、修改留痕 |
| F04-05 任务状态机 | 状态集从 6 个扩到 10 个；新增 `checking_env` / `cooling_down` / `waiting_human` / `draft` 四态与合法迁移表；`deriveStatus` 保留并加压 |
| F04-06 waiting_human 处置 | 三触发落地、原因与动作可读、30 分钟超时转 `cancelled` 且**保留已采节**、两个按钮各接一条路由 |
| F04-07 13 节采集详情 | 13 节词表 + 节级状态 + 节级明细落库（新表 `collection_section_result`），页面按 ASIN 展开 |
| F04-08 自有/竞品识别 | 五级优先链在**采集提交路径**上真正生效，冲突与人工覆盖留原因与版本 |
| F04-09 采集方案管理 | 方案成为版本化资产（草稿/可用/停用/已废弃），被任务引用时**冻结版本号** |
| F04-10 计划采集 | 计划定义落库、默认关闭、窗口判定返回 `cooling_down` 或等待人工放行；**不做调度器** |

### 0.2 这一批明确不做（非目标）

1. **不做真实浏览器端到端采集验收**。本批的验收全部走桩 collector 与桩 sources；真实 Chrome 上跑一次 13 节采集属于 P5 的「需真实浏览器」项，G2 不承诺。
2. **不做调度器后台常驻**。插件没有常驻定时器（`index.js:108-125` 的两处 `try` 就是这条约束的证据：时间驱动的规则只在「打开工作台」时跑）。计划采集因此是**窗口判定函数**，不是 cron：判定发生在提交/入队那一刻，返回 `cooling_down` 或触发 `waiting_human`。
3. **不做模块 05 的 9 Tab**。13 节明细表是给 F05-02 用的**前置数据**，本批只到「服务端发得出、页面按 ASIN 展得开」，不做 ASIN 详情抽屉。
4. **不改 `deriveStatus` 对既有六态的输出语义**（见 §5.5，`done` 不改名）。
5. **不引入任何第三方依赖**，不换存储，不换路由形态。
6. **不删任何列、不删任何既有表**。
7. **不自动登录、不强杀进程、不绕验证码、不静默下载浏览器**（F04-02 的四条禁令，落成硬拒绝，见 §6.5）。

---

## 1. 现状复核（逐条 `verified`）

判「有没有实现」只看权威注册表。以下每条都是本次实测，**修正并细化了审计结论**（`docs/requirements/RESEARCH-module-alignment-v2.0.md:140,150,447,473`，`documented`）。

### 1.1 注册表口径（这批只承认这六处）

| 权威注册表 | 位置 | 现状 |
|---|---|---|
| `TOOLS` | `index.js:258-374` | 71 项；采集相关只有 3 个：`amzn_collect_submit` / `amzn_collect_status` / `amzn_collect_doctor`（`:268-270`） |
| `buildTools` | `src/tools/index.js:65`，采集三行在 `:83-86` | 与 `TOOLS` **逐名一致**（`registerTools` 返回 `definitions.map(d => d.name)`，`:61`） |
| `MODULE_GROUPS` | `src/state/workbench.js:34-86` | `collect` 模块存在（`:55`，label「采集器」），**无 `sections`**（只有 `settings` 有，`:48-51`） |
| `MIGRATIONS` | `src/store/schema.js:376-2245` | 最大 `version: 33`（`:2177`）；**无任何采集方案/计划/节明细表** |
| `routes.js` 路由名 | `src/web/routes.js:305-1247`（35 个 `route === '…'`） | **无一条采集路由**。采集面板的写操作在页面上无入口 |
| `PANEL_RENDERERS` | `src/web/page.js:855-870` | `collect: renderTasks`（`:858`），实现于 `:5497-5552` |

### 1.2 我复核后**修正**审计结论的两处

**(1) `collection_task` 的既有状态词表比审计写的更窄，且页面有一张更大的别名表。**
数据库里实际会出现的只有 6 个：`queued` / `running` / `done` / `partial` / `failed` / `cancelled`（`src/sources/collection.js:508-516` 的 `deriveStatus` 产出 `done|partial|failed|cancelled`，`:217,:264` 产出 `queued|running`）。但 `page.js:5477-5484` 的 `TASK_STATUS` 只有这 6 个，而 `collection.js:21-34` 的 `STATUS_LABEL` 有 12 个键（多出来的是逐目标结果码 `ok/blocked/notfound/selector-miss/wrong-storefront/error`，不是任务态）。**结论**：任务态是一套词表，逐目标结果码是另一套，不得混用；本批只扩任务态。

**(2) 「采集面板只有一张扁平任务表」之外，还有一截已经建好但没用的能力。**
`buildState` 已经发 `collection` 切片（`routes.js:1525`，由 `collectionSummary` 组装，`:2828-2835`：只有 `running/queue/queueDepth`）与 `tasks`（`:1526`），页面只消费 `running` / `queueDepth` / 任务行（`page.js:5499-5552`）。`collection.cancel()` 存在（`collection.js:385-408`）但**无任何调用方**——这是 W1 那种「建成未接线」的同款，本批给它接上路由。

### 1.3 十个功能点逐条现状

| 功能点 | 现状 | 证据 | 判定 |
|---|---|---|---|
| F04-01 环境体检 | 十项只覆盖约 5 项，且**散在三处、无统一结构**：①运行时/浏览器/端口/profile 的碎片在 `healthCheck`（`src/sources/browser/collector.js:457-518`，判 `probeVersion` + 上次采集的选择器/站点命中统计）；②目录可写、导入目录在 `src/domain/collect/profile.js:193-203`（`resolveImportDir`）与 `src/domain/setup/wizard.js:73-100`（`sitesWithoutPostalCode` / `linesWithoutCore`）；③站点匹配在 `src/sources/pages/index.js` 的 `verifyStorefront`（由 `collector.js:396-401` 应用）。**「方案版本」「代理」「冷却状态」三项在仓库里没有对应实现**（`KNOWN_FIELDS` 里没有代理，`registry.js:36-39`） | `verified` | **部分** |
| F04-02 环境修复 | 修复动作**没有独立入口**：建目录/拉起浏览器只在 `submit` 的后台路径里隐式发生（`collection.js:296-305` 调 `adapter.collect`，最终到 `collector.js:90-112` 的 `connect()`） | `verified` | **部分** |
| F04-03 发起采集 | `amzn_collect_submit`（`src/tools/collect.js:38-145`）已有：`targets`/`asins`/`marketplace`/`fields`/`perTaskMax`/`humanize`/`strictStorefront`/`confirm`；**没有站点邮编、没有自有/竞品分框、没有方案、没有复用快照**；**没有提交前预览**（六项一项都没有） | `verified` | **部分** |
| F04-04 外部入口预填 | 生产方存在（`workbench.get()` 的 `context` 带 `filters`/`selection`，`src/state/workbench.js` 的 `MODULE_IDS` 校验；`routes.js:308-312` 的 `POST /api/context`）；**消费方为空**——采集面板 `#panel-collect` 只有 `#collectHint` + `#tasks`（`page.js:378-381`） | `verified` | **部分（消费方缺失）** |
| F04-05 任务状态机 | 只有 6 态（见 §1.2(1)）；缺 `draft`/`checking_env`/`waiting_human`/`cooling_down`。风控即停**已实现**（`collection.js:512`，`stopped==='blocked'` → 有写入则 `partial` 否则 `failed`；`collector.js` 命中风控页即停整个任务）。断点恢复**已实现一半**（`recoverStaleTasks`，`src/store/queries.js:699-717`：`running`→`failed`，`queued` 重新入队；`collection.js:128-142` 的 `recover()`），但**「不重复写入已完成节」没有载体**（没有节级记录，无法知道哪节已完成） | `verified` | **部分** |
| F04-06 waiting_human 处置 | **整块没有**。`waiting_human` 不在任何状态集里；没有原因字段、没有超时转 `cancelled` 的代码、没有两条处置动作 | `verified` | **缺失** |
| F04-07 13 节采集详情 | **整块没有**。仓库里唯一的「节」词表是 `src/domain/rules/listing-fields.js:51-63` 的 `SECTIONS`（**11 节**，优化字段词表，`tests/run.mjs` 有 `eleven sections` 断言）；采集侧只登记 10 个扁平字段（`src/sources/registry.js:36-39` 的 `KNOWN_FIELDS`）。**这两个都不是 13 节基线**，本批不许复用它们充当 13 节 | `verified` | **缺失** |
| F04-08 自有/竞品识别 | 只有**两级**：`asin_ownership`（`schema.js:1488-1502`）的 `source ∈ {auto, manual}`，`effectiveRows` 实现「manual 压 auto」（`src/domain/ownership/resolve.js:54-57`）。**五级优先链没有实现**；`resolveOwnership` 已存在但**在采集路径上零调用方** | `verified` | **部分** |
| F04-09 采集方案管理 | **整块没有**。没有表、没有工具、没有面板区 | `verified` | **缺失** |
| F04-10 计划采集 | **整块没有**。没有表、没有工具、没有窗口判定 | `verified` | **缺失** |

**计数（本批开始前）**：0 implemented / 6 partial / 4 missing。与审计结论一致。

---

## 2. 数据模型变更（schema v35 → v36）

### 2.0 版本号与追加纪律

- `SCHEMA_VERSION` **由数组末项的 `version` 派生**（`schema.js:2248`），不在任何地方写死字面量。`tests/run.mjs:1921`、`:4444`、`:5345`、`:7239` 断言的是 `PRAGMA user_version == SCHEMA_VERSION`，`:4452` 还有一条 `SCHEMA_VERSION < 24` 的下限守卫——**没有任何断言写死 33**，所以升到 36 不需要改这四条。
- **本批只允许在 `MIGRATIONS` 数组尾部追加一个新对象**（`version: 36`），**不改动、不重排 1–35 的任何一条**。理由：`MIGRATIONS` 是单一数组（`docs/COORDINATION.md:26`），也是两个会话的硬串行点。
- **重编号记录（2026-10-04，主理人）**：契约原写「v33 → v34」。此后 WorkBuddy 侧连续落了三个批次，把号一路推走：B-08.1 占 **v33**（`4dbb48e`）、B-08.2 占 **v34**（`c17c282`）、B-08.3 占 **v35**（`e4011d6` + `29848aa`），三者均已并入 main（`b2f0074`）。因此 **B-04 改用 `version: 36`，契约内容一字不改**——这正是 `docs/COORDINATION.md` §3.3 第 3 条「后合的一方改成 main 当前最大值 + 1」的执行结果。**不要把这里的 36 当成可以预先假定的常量**：开工时以 `SCHEMA_VERSION` 的实测值为准，若又被占用则再 +1。
- 迁移函数体必须是**幂等安全的追加式 SQL**：`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN`（SQLite 的 `ADD COLUMN` 不带 `IF NOT EXISTS`，所以只允许在**只跑一次**的迁移里出现，见 §2.6 的回滚约定）。

### 2.1 新增表 `collection_scheme`（采集方案，F04-09）

版本化资产。**同名方案的多版本是不同主键行**，「当前版本」由 `collection_scheme_version` 指定。

| 列 | 类型 | 空值语义 | 说明 |
|---|---|---|---|
| `id` | TEXT | NOT NULL | 主键。`scheme-<8 位随机>` |
| `name` | TEXT | NOT NULL | 方案名（人读） |
| `version` | INTEGER | NOT NULL | 版本号，从 1 递增；**同一 `id` 下唯一** |
| `status` | TEXT | NOT NULL | `draft` \| `active` \| `disabled` \| `obsolete`（四态，见 §5.6）；默认 `draft` |
| `driver` | TEXT | NOT NULL DEFAULT `'browser-local'` | 驱动方式，值域 = `source.id` |
| `marketplaces_json` | TEXT | NULL = **不限站点** | 支持站点数组，如 `["US","DE"]` |
| `sections_json` | TEXT | **NOT NULL** | 字段覆盖清单 = 13 节 id 的子集；空数组是「什么都不采」，是合法值，**不是 NULL** |
| `requires_login` | INTEGER | NOT NULL DEFAULT 0 | 0/1 |
| `risk_level` | TEXT | NULL = 未评 | `low` \| `medium` \| `high` |
| `default_pacing_json` | TEXT | NULL = 用全局设置 | `{taskIntervalSec, maxAsinsPerTask, dailyLimit}` |
| `verified_at` | TEXT | NULL = **从未验证**（不等于「验证失败」） | ISO-8601 UTC |
| `verified_by` | TEXT | NULL | 操作者 |
| `note` | TEXT | NULL | — |
| `created_at` / `updated_at` | TEXT | NOT NULL | ISO-8601 UTC |

- **主键**：`PRIMARY KEY (id, version)`（复合）。
- **唯一约束**：`UNIQUE (id, version)` 已由主键覆盖；**不再加第二把唯一索引**（同 `product_line_version` 的做法，`schema.js:1544-1547`）。
- **索引**：`CREATE INDEX idx_scheme_status ON collection_scheme(status, updated_at DESC)`（页面按状态筛选）。
- **不做的**：不做 `is_current` 列。当前版由任务引用决定，不由方案自己宣布（否则一次「设为当前」会静默改变历史任务引用的解释）。

### 2.2 新增表 `collection_plan`（计划采集，F04-10）

| 列 | 类型 | 空值语义 | 说明 |
|---|---|---|---|
| `id` | TEXT | NOT NULL | 主键，`plan-<8 位随机>` |
| `name` | TEXT | NOT NULL | 计划名 |
| `enabled` | INTEGER | NOT NULL DEFAULT **0** | **默认关闭**（§4.7 原话）；0/1 |
| `marketplace` | TEXT | NULL = 所有站点 | 单一站点。**不做站点数组**——窗口与冷却都是站点级，多站点会让「这个计划的窗口」无定义 |
| `targets_json` | TEXT | NOT NULL | ASIN 集，`[{asin, marketplace, side}]`，与 `collection_task.targets_json` 同形 |
| `scheme_id` / `scheme_version` | TEXT / INTEGER | NULL = 提交时选当前可用方案 | 计划绑定方案版本；**绑定后不随方案改版漂移** |
| `window_json` | TEXT | NULL = 全天候 | `{from:"HH:MM", to:"HH:MM", tz:"Asia/Shanghai"}` |
| `interval_minutes` | INTEGER | NULL = 不重复 | 频率；NULL 表示一次性 |
| `max_objects` | INTEGER | NOT NULL DEFAULT 50 | 最大对象数（>0） |
| `failure_policy` | TEXT | NOT NULL DEFAULT `'stop'` | `stop` \| `continue` \| `retry_once` |
| `cooldown_minutes` | INTEGER | NOT NULL DEFAULT 60 | 冷却期 |
| `notify` | TEXT | NOT NULL DEFAULT `'none'` | `none` \| `on_failure` \| `always` |
| `pause_condition_json` | TEXT | NULL = 无暂停条件 | `{onRiskEvents: n, onFailureRate: 0.5}` |
| `created_at` / `updated_at` | TEXT | NOT NULL | — |

- **主键**：`id`。**唯一约束**：`UNIQUE (name)`（计划名是人的把手，重名会让「暂停哪个」不可回答）。
- **索引**：`idx_plan_enabled ON collection_plan(enabled, marketplace)`。
- **明确不做**：不做 `next_run_at` 列。没有调度器就没有可信的「下次运行时间」；写一个只有人算得出来的列等于把计算错误存进库。

### 2.3 `collection_task` 的列变更（追加，全部可空）

| 新列 | 类型 | 空值语义 | 服务于 |
|---|---|---|---|
| `side_split_json` | TEXT | NULL = 老任务/未分框 | `{self:[asin…], competitor:[asin…], unknown:[asin…]}`；F04-03 分框、F04-08 归属链的落点 |
| `ownership_evidence_json` | TEXT | NULL = 未判 | 每个 ASIN 的归属来源与优先级层级：`[{asin, marketplace, side, decidedBy, tier, evidence}]` |
| `scheme_id` / `scheme_version` | TEXT / INTEGER | NULL = 未指定方案 | **冻结**提交时的方案版本（不跟随方案改版） |
| `plan_id` | TEXT | NULL = 非计划触发 | `REFERENCES collection_plan(id)`；手动提交永远 NULL |
| `prefill_json` | TEXT | NULL = 非预填 | `{contextId, from, prefilledAt, changes:[{path, from, to, at, by}]}`；F04-04 的留痕 |
| `env_check_json` | TEXT | NULL = 没体检过 | 体检结果摘要（十项的 `status/level` 数组），**明细在 `collection_env_check` 表** |
| `env_checked_at` | TEXT | NULL = 没体检过 | 体检时刻 |
| `waiting_json` | TEXT | NULL = 不在等待人工 | `{trigger, reason, actions:[…], since, deadlineAt}`；F04-06 |
| `resolved_at` | TEXT | NULL = 未结束 | 进入终态的时刻 |
| `risk_json` | TEXT | NULL = 未评估 | `{level, reasons:[…]}`，预览与体检共用同一计算 |
| `reused_snapshots_json` | TEXT | NULL = 未复用 | `[{asin, marketplace, snapshotId, collectedAt}]`；复用即验收第 7 条的「可重现」 |
| `retry_of` | TEXT | NULL = 首跑 | 重试生成新记录时的源 taskId（§4.5「重试从失败点开始并生成新的尝试记录」） |
| `attempt` | INTEGER | NOT NULL DEFAULT 1 | 第几次尝试 |

- **索引**：`idx_task_plan ON collection_task(plan_id, submitted_at DESC)`；`idx_task_waiting ON collection_task(status, updated_at)`（超时扫描要按 `updated_at` 走）。既有 `idx_collection_status`（`schema.js:508`）与 `idx_task_kind`（`:577`）不动。
- **`TASK_COLUMNS` 必须同步扩列**（`src/store/queries.js:649-655`）：它是一个**白名单**，不在表里的键会被静默忽略（`:661` 的 `patch[key] === undefined` 判定）。这是本批最容易漏的一处静默失败：列加了、`updateCollectionTask` 不认，页面永远读到 NULL，不报错。**`idx_task_waiting` 也因此必须由 `updateCollectionTask` 维护 `updated_at`（已会自动写，`:667-668`）。**

### 2.4 新增表 `collection_env_check`（体检明细，F04-01）

| 列 | 类型 | 空值语义 | 说明 |
|---|---|---|---|
| `id` | TEXT | NOT NULL | 主键 |
| `task_id` | TEXT | NULL = **独立体检**（不属于任何任务） | `REFERENCES collection_task(id)` |
| `check_id` | TEXT | NOT NULL | 十项之一，见 §4.2 |
| `status` | TEXT | NOT NULL | `ok` \| `warn` \| `fail` \| `unknown` |
| `detail` | TEXT | NULL = 无说明 | 人读说明 |
| `repairable` | INTEGER | NOT NULL DEFAULT 0 | 0/1 |
| `repair_action` | TEXT | NULL = 不可修 | `mkdir` \| `launch_browser` \| `reconnect_port` \| `set_context` 之一 |
| `risk` | TEXT | NOT NULL DEFAULT `'low'` | `low` \| `medium` \| `high` |
| `checked_at` | TEXT | NOT NULL | — |

- **主键**：`id`。**唯一约束**：`UNIQUE (task_id, check_id, checked_at)`（同一任务同一项可重查，重查留两行）。
- **索引**：`idx_envcheck_task ON collection_env_check(task_id, check_id)`。
- **注意**：`task_id` 为 NULL 的行表示「独立的体检」，`UNIQUE` 里的 NULL 在 SQLite 中不参与唯一性比较，所以独立体检可以有多轮——这是**有意的**，不是漏洞。

### 2.5 新增表 `collection_section_result`（13 节明细，F04-07）

| 列 | 类型 | 空值语义 | 说明 |
|---|---|---|---|
| `id` | TEXT | NOT NULL | 主键，`<taskId>:<asin>:<marketplace>:<section>`（见下） |
| `task_id` | TEXT | NOT NULL | `REFERENCES collection_task(id)` |
| `asin` | TEXT | NOT NULL | `/^[A-Z0-9]{10}$/` |
| `marketplace` | TEXT | NOT NULL | 站点码 |
| `section` | TEXT | NOT NULL | 13 节 id 之一（§4.1） |
| `status` | TEXT | NOT NULL | `collected` \| `missing` \| `partial` \| `failed` \| `blocked` |
| `raw_value_json` | TEXT | NULL = 没采到 | 原始值（**不许被解析覆盖**） |
| `parsed_value_json` | TEXT | NULL = 无解析结果 | 解析后的结构化值 |
| `page_region` | TEXT | NULL = 未记录 | 页面来源区域（选择器命中的容器） |
| `selector_hits_json` | TEXT | NULL = 未记录 | `{field: selector}`，来自 `amzn_collect_doctor` 的同款命中表 |
| `errors_json` | TEXT | NULL = 无错 | `[{code, detail}]` |
| `collected_at` | TEXT | NULL = 没采到 | ISO-8601 UTC |
| `scheme_version` | INTEGER | NULL = 未指定方案 | 冻结的节级方案版本 |
| `snapshot_ref` | TEXT | NULL = 无快照 | `asin_snapshot.id`（`schema.js:417-424`，INTEGER，按文本存以统一形状） |
| `diff_json` | TEXT | NULL = 无上一快照可比 | `{previousSnapshotId, changed:[field], added:[field], removed:[field]}` |

- **主键**：`id`（文本复合键）。
- **唯一约束**：`UNIQUE (task_id, asin, marketplace, section)`。这条是**断点恢复的载体**（§5.5-4）：恢复时按它判断「这一节已有 `collected` 行 → 不再重采」。
- **索引**：`idx_section_task ON collection_section_result(task_id, asin, status)`；`idx_section_asin ON collection_section_result(asin, marketplace, collected_at DESC)`（模块 05 的 9 Tab 与快照 diff 要靠它）。
- **为什么用文本复合 `id` 而不是 `AUTOINCREMENT`**：这一行的身份是**内容坐标**（哪次任务的哪个 ASIN 的哪一节），不是序号。用自增 id 会让「同一坐标写两次」变成两行而没有任何约束拒绝——正是 `UNIQUE` 要防的那件事。

### 2.6 新增表 `collection_task_event`（任务流转历史，追加式）

对应 `keyword_lifecycle_event`（`schema.js:2226-2243`）已经验证过的模式：状态是人工/机器决定，历史只追加。

| 列 | 类型 | 空值语义 | 说明 |
|---|---|---|---|
| `id` | TEXT | NOT NULL | 主键 |
| `task_id` | TEXT | NOT NULL | `REFERENCES collection_task(id)` |
| `from_status` | TEXT | **NULL = 此前没有状态**（首次） | 写成某个初始态会伪造一段从未发生的历史 |
| `to_status` | TEXT | NOT NULL | 见 §5.1 |
| `reason` | TEXT | NULL | 为什么转（人填或机器给） |
| `source` | TEXT | NOT NULL | `plugin` \| `page` \| `plan` \| `human` \| `timeout` |
| `evidence_json` | TEXT | NULL | 体检失败项 / 风控页 URL / 归属证据 |
| `at` | TEXT | NOT NULL | — |
| `by` | TEXT | NULL | 操作者 |

- **索引**：`idx_task_event ON collection_task_event(task_id, at)`。
- **禁用 DELETE**：这张表和 `keyword_lifecycle_event` 一样，**没有删除路径**。

### 2.7 迁移写法（追加式，`schema.js` 末尾，`version: 34`）

```js
  {
    /* 合并注意：本迁移号是 34，但另一个批次（模块 08 F08-04）可能也在写 34。
       合并时按 main 当前的最大版本**重编号**即可，内容不用动。 */
    version: 34,
    name: 'collection-center',
    sql: `
-- ── 采集方案（F04-09）：版本化资产，同名方案多版本是不同主键行 ────────────────
CREATE TABLE IF NOT EXISTS collection_scheme (
  id                   TEXT NOT NULL,
  name                 TEXT NOT NULL,
  version              INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft',
  driver               TEXT NOT NULL DEFAULT 'browser-local',
  marketplaces_json    TEXT,
  sections_json        TEXT NOT NULL,
  requires_login       INTEGER NOT NULL DEFAULT 0,
  risk_level           TEXT,
  default_pacing_json  TEXT,
  verified_at          TEXT,
  verified_by          TEXT,
  note                 TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS idx_scheme_status ON collection_scheme(status, updated_at DESC);

-- ── 计划采集（F04-10）：默认关闭；没有 next_run_at 列（没有调度器） ──────────
CREATE TABLE IF NOT EXISTS collection_plan (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 0,
  marketplace           TEXT,
  targets_json          TEXT NOT NULL,
  scheme_id             TEXT,
  scheme_version        INTEGER,
  window_json           TEXT,
  interval_minutes      INTEGER,
  max_objects           INTEGER NOT NULL DEFAULT 50,
  failure_policy        TEXT NOT NULL DEFAULT 'stop',
  cooldown_minutes      INTEGER NOT NULL DEFAULT 60,
  notify                TEXT NOT NULL DEFAULT 'none',
  pause_condition_json  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (name)
);
CREATE INDEX IF NOT EXISTS idx_plan_enabled ON collection_plan(enabled, marketplace);

-- ── 体检明细（F04-01）：一行一项，十项 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_env_check (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES collection_task(id),
  check_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  detail        TEXT,
  repairable    INTEGER NOT NULL DEFAULT 0,
  repair_action TEXT,
  risk          TEXT NOT NULL DEFAULT 'low',
  checked_at    TEXT NOT NULL,
  UNIQUE (task_id, check_id, checked_at)
);
CREATE INDEX IF NOT EXISTS idx_envcheck_task ON collection_env_check(task_id, check_id);

-- ── 13 节明细（F04-07）：UNIQUE 是断点恢复的载体 ──────────────────────────────
CREATE TABLE IF NOT EXISTS collection_section_result (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES collection_task(id),
  asin              TEXT NOT NULL,
  marketplace       TEXT NOT NULL,
  section           TEXT NOT NULL,
  status            TEXT NOT NULL,
  raw_value_json    TEXT,
  parsed_value_json TEXT,
  page_region       TEXT,
  selector_hits_json TEXT,
  errors_json       TEXT,
  collected_at      TEXT,
  scheme_version    INTEGER,
  snapshot_ref      TEXT,
  diff_json         TEXT,
  UNIQUE (task_id, asin, marketplace, section)
);
CREATE INDEX IF NOT EXISTS idx_section_task ON collection_section_result(task_id, asin, status);
CREATE INDEX IF NOT EXISTS idx_section_asin ON collection_section_result(asin, marketplace, collected_at DESC);

-- ── 任务流转历史：只追加，永不更新、永不删除 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_task_event (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES collection_task(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  reason        TEXT,
  source        TEXT NOT NULL,
  evidence_json TEXT,
  at            TEXT NOT NULL,
  by            TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_event ON collection_task_event(task_id, at);

-- ── collection_task 追加列：全部可空，老行不回填（NULL 就是「没用过这个功能」） ──
ALTER TABLE collection_task ADD COLUMN side_split_json TEXT;
ALTER TABLE collection_task ADD COLUMN ownership_evidence_json TEXT;
ALTER TABLE collection_task ADD COLUMN scheme_id TEXT;
ALTER TABLE collection_task ADD COLUMN scheme_version INTEGER;
ALTER TABLE collection_task ADD COLUMN plan_id TEXT REFERENCES collection_plan(id);
ALTER TABLE collection_task ADD COLUMN prefill_json TEXT;
ALTER TABLE collection_task ADD COLUMN env_check_json TEXT;
ALTER TABLE collection_task ADD COLUMN env_checked_at TEXT;
ALTER TABLE collection_task ADD COLUMN waiting_json TEXT;
ALTER TABLE collection_task ADD COLUMN resolved_at TEXT;
ALTER TABLE collection_task ADD COLUMN risk_json TEXT;
ALTER TABLE collection_task ADD COLUMN reused_snapshots_json TEXT;
ALTER TABLE collection_task ADD COLUMN retry_of TEXT;
ALTER TABLE collection_task ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_task_plan    ON collection_task(plan_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_waiting ON collection_task(status, updated_at);
`,
  },
```

**老数据怎么处理**：**不动**。14 个新列全部可空，语义是「这个功能没用过」；既有 71 个工具写入的任务行在页面上的呈现与今天**逐像素一致**（`statusChip` 的表没变，见 §5.5-5）。唯一例外是 `attempt`：`NOT NULL DEFAULT 1`，SQLite 的 `ADD COLUMN` 会把既有行填成 1，这是**正确**的（每个老任务确实都是第 1 次尝试）。

### 2.8 回滚

| 对象 | 回滚方式 | 可逆性 |
|---|---|---|
| `MIGRATIONS` 数组项 | `git revert` 那一个 commit | **可逆** |
| 四张新表 | `DROP TABLE collection_scheme; DROP TABLE collection_plan; DROP TABLE collection_env_check; DROP TABLE collection_section_result; DROP TABLE collection_task_event;` | 语句可逆，**数据不可逆**（表里的行永久丢失） |
| 14 个新列 | `ALTER TABLE collection_task DROP COLUMN <col>;` 逐列删（SQLite 3.35+ 支持；本机 Node 的 `node:sqlite` 内置 SQLite 版本 ≥ 3.45，**待确认**具体版本，见 §9 开放问题 O1） | 有条件可逆：失败则退化为「重建表 + 拷列」路线 |
| 老库升级到 v34 后回到旧代码 | 旧代码不认识新列/新表，`PRAGMA user_version` 会高于代码期望 → **必须同时回滚数据库文件**。**先备份 `data/amazon-ops.db`**（`index.js:92` 给出的默认 dataDir） | **不可逆**：这是本批最硬的回滚边界 |

**架构师的处置建议**：迁移执行前由 Fullstack 复制一份 `data/amazon-ops.db` 到 `data/amazon-ops.db.bak-v33`（本批交付物之一），并在交接条里写清备份路径。不写备份就等于把「升级失败」变成「数据没了」。

---

## 3. 非功能要求（必须有数字）

| 项 | 数字 | 理由 |
|---|---|---|
| 单次体检耗时上限 | **3 000 ms**；超时项记 `status='unknown'` 并继续下一项 | 体检不能比采集还慢；`healthCheck` 里的 `probeVersion` 是唯一的网络/进程探测 |
| 体检十项的执行顺序 | 固定顺序（§4.2 编号 01→10），**不并行** | 端口与浏览器的探测互相影响（拉起浏览器会改端口状态） |
| 单任务 13 节明细写入上限 | **200 ASIN × 13 节 = 2 600 行** | 与 `compactResult` 的 `results.slice(0, 200)`（`collection.js:532`）同口径，避免两处上限不一致 |
| `raw_value_json` 单节上限 | **64 KB**（超出截断并写 `errors_json` 标记 `TRUNCATED`） | 描述/A+ 正文可能很大；无限入库会让 68 MB 的库翻倍（W1 修订已有前例，`API-W1-wiring.md:63-100`） |
| waiting_human 超时 | **30 分钟**（1 800 s），从 `waiting_json.since` 起算 | §4.5 原话 |
| 冷却期默认 | **60 分钟**（`collection_plan.cooldown_minutes` 默认值） | 与「站点级冷却」一致，可由计划覆盖 |
| 提交前预览耗时上限 | **500 ms**（纯计算 + 一次库读；**不许打开浏览器**） | 预览是表单上的即时反馈，不是采集 |
| 计划窗口判定耗时上限 | **10 ms**（纯时间比较） | 它是提交路径上的同步判定 |
| 每次 `GET /api/state` 新增载荷 | **≤ 120 KB**（13 节明细**不随 state 全量下发**，只下发当前选中任务的单个 ASIN） | `page.js` 每 3 秒轮询（`routes.js:1335` 注释），全量下发会让轮询变重 |
| 数据保留期 | 13 节明细**不单独设保留期**，随 `collection_task` 一起；任务与结果表不自动清理 | 采集是审计对象（§1 验收第 6 条「可重现」），不能过期 |
| 并发 | 采集任务**仍是 1（`collection.js:12-15` 的一任务一浏览器）**；计划采集不引入并发 | 共享一个 Chrome 与一套登录态 |

---

## 4. 13 节的定义（F04-07）

### 4.1 唯一定义来源与词表

**定义来源**：`docs/amazon-ops-模块设计-v1.0/04-采集中心.md:19-35`（§3「13 节字段基线」，编号 1–13）。这是**唯一**把 13 节逐条编号的文档，本批以它为准。

> ⚠️ 三份材料对 13 节的说法不一致，必须先定口径再写代码：
> - `amazon-ops-需求设计文档-v2.0.md:480` 的列表**合并了** A+ 与视频（写「A+/视频」），另列出「页面信号」「关联竞品」「SEO 元信息」，**没有**原型里的「价格」与「后台词」。
> - 原型 `prototype/04-collect.html:179-191` 的 13 个标签是另一套（标题/五点/描述/价格/图片/A+/属性/变体/BSR/评分/后台词/QA/评论），**原型之间才凑得出 13**。
> - `src/domain/rules/listing-fields.js:51-63` 的 `SECTIONS` 是 **11 节**，那是**优化字段词表**，`tests/run.mjs` 有 `eleven sections` 断言钉住它——**本批不得改它、不得复用它当采集节**。
>
> 冲突时以 `模块设计-v1.0/04-采集中心.md` §3 为准；原型标签与它的对应关系见 §4.3 的映射表。

| # | `section` id | 节名 | 字段清单（`raw`/`parsed` 的键） |
|---|---|---|---|
| 1 | `basic` | 基础信息 | `asin` `url` `title` `brand` `price` `currency` `availability` `rating` `reviews_count` `selected_color` `selected_size` |
| 2 | `bullets` | 五点 | `bullet_1`…`bullet_5`（5 项） |
| 3 | `images` | 主图与副图 | `main_image` `image_count` `images[]` |
| 4 | `variations` | 变体结构 | `parent_asin` `variation_dimensions[]` `children[]` |
| 5 | `attributes` | 产品规格与属性 | `attribute.*`（动态，前缀口径沿用 `listing-fields.js:68` 的 `ATTRIBUTE_FIELD_PREFIX`） |
| 6 | `description` | 产品描述 | `description` `item_highlights[]` |
| 7 | `aplus` | A+ 模块及文案/图片链接 | `modules[]`（`{index, type, text, images[]}`） |
| 8 | `video` | 视频 | `videos[]`（`{position, url, thumbnail}`） |
| 9 | `seo_meta` | SEO 元信息 | `page_title` `meta_description` `canonical_url` `search_terms` |
| 10 | `bsr` | BSR、类目与子类排名 | `bsr` `category` `subcategory_ranks[]` |
| 11 | `reviews` | 评论 | `reviews_total` `reviews_visible` `review_summary` `review_items[]`（页面上限 20 条，超出记 `errors_json` 的 `CAPPED`） |
| 12 | `page_signals` | 徽章、库存/退货风险等页面信号 | `badges[]` `availability` `return_policy` `risk_signals[]` |
| 13 | `related_competitors` | 页面发现的关联竞品 | `related_asins[]`（原样，**不写入归属**；归属走 §6.4 的链） |

**词表落点**：`src/domain/collect/sections.js`（新文件）导出 `COLLECTION_SECTIONS`（13 项，每项 `{id, label, order, fields}`）与 `COLLECTION_SECTION_IDS`、`SECTION_BY_ID`；`src/domain/states.js` 导出 `COLLECTION_SECTION_STATES`。**节 id 一律英文小写下划线，标签一律中文**——与 `listing-fields.js:51-63` 同款。

### 4.2 节状态枚举

`COLLECTION_SECTION_STATES = ['collected', 'missing', 'partial', 'failed', 'blocked']`（`04-采集中心.md:35` 原文五态，一字不改）。

| 状态 | 含义（判据，代码里必须可判） |
|---|---|
| `collected` | 本节字段清单里的字段**全部**解析到非空值 |
| `missing` | 页面渲染完成，但本节**所有**字段都没有出现 → 「亚马逊确实没有」 |
| `partial` | 部分字段有值、部分没有（`collected_fields / total_fields < 1`） |
| `failed` | 本次尝试**没能判定**（选择器未命中、页面未渲染、超时）→ 「我们没测出来」，**不等于 missing** |
| `blocked` | 本节被风控/登录墙截停，请求未完成 |

> **`missing` 与 `failed` 必须分开**：这正是 `04-采集中心.md:5` 「采了什么、没采到什么、为什么」的落点，也是 §18.7 的「未采集/页面没有/采集失败三者分开」。把它们合并会让「没采到」被读成「不存在」，从而污染优化决策。

### 4.3 原型标签 → 节 id 的映射（页面用，供 UI/UX 对照）

| 原型标签（`04-collect.html`） | 节 id |
|---|---|
| 标题 / 价格 / 评分 | `basic`（同节的三个字段，页面上拆开显示） |
| 五点 | `bullets` |
| 描述 | `description` |
| 图片 | `images` |
| A+ | `aplus` |
| 属性 | `attributes` |
| 变体 | `variations` |
| BSR | `bsr` |
| 后台词 | `seo_meta`（原型的「后台词」即 `search_terms`） |
| QA | **无独立节** → 记入 `description` 的 `item_highlights` 与 `reviews` 的 `review_items`（Q&A 原型中存在，模块设计 §3 的 13 节里没有；**这是差异，不是遗漏**，见 §9 开放问题 O2） |
| 评论 | `reviews` |
| （原型未显示） | `video` / `page_signals` / `related_competitors` —— 原型徽章区只画了 13 个，缺口三节 |

**处置**：页面按 §4.1 的 13 节渲染，**不照抄原型徽章串**。原型与文档的这处不一致上报 PM 裁决（§9 O2），本批按文档实现。

### 4.4 节级接口（服务端发什么）

`amzn_collect_detail` 与 `GET /api/sections?taskId=…&asin=…&marketplace=…` 返回同一形状（**同一 builder，两条路径不能给两个答案**）：

```json
{
  "ok": true,
  "taskId": "…", "asin": "B0GSFPTD2H", "marketplace": "US",
  "summary": { "collected": 11, "missing": 0, "partial": 1, "failed": 0, "blocked": 1, "total": 13 },
  "sections": [
    { "section": "basic", "label": "基础信息", "order": 1, "status": "collected",
      "collected": 11, "total": 11, "collectedAt": "2026-10-03T13:20:11.000Z",
      "schemeVersion": 3, "snapshotRef": "1042",
      "diff": { "previousSnapshotId": 1031, "changed": ["price"], "added": [], "removed": [] } }
  ],
  "truncated": false
}
```

---

## 5. 任务状态机（F04-05 / F04-06）

### 5.1 状态集（10 态）

`COLLECTION_TASK_STATES = ['draft','queued','checking_env','running','waiting_human','cooling_down','partial','done','failed','cancelled']`

| 状态 | 本批 | 说明 |
|---|---|---|
| `queued` / `running` | 既有 | `collection.js:217` / `:264` |
| `done` / `partial` / `failed` / `cancelled` | 既有 | `deriveStatus`（`collection.js:508-516`）与 `cancel()`（`:385-408`） |
| `draft` | **新增** | 表单存为草稿，未提交。**只在 `collection_task` 里，不入队**（`queue` 只收 `queued`） |
| `checking_env` | **新增** | 已提交、体检进行中/未过。**体检不过的任务停在 `checking_env` 直至超时转 `failed`**，或由人重试体检 |
| `waiting_human` | **新增** | 三类触发之一命中（§5.4） |
| `cooling_down` | **新增** | 站点冷却期内，或计划窗口外（等待放行时另转 `waiting_human`） |

**`completed` 的处理（这是一条决定，不是遗漏）**：§4.5 与原型写的是 `completed`，代码与库里是 `done`（`collection.js:515`，页面 `page.js:5480` 的 `TASK_STATUS` 键）。**本批保留 `done`**，理由：改名需要一次全表 `UPDATE`（`done` → `completed`），那是一次**不可逆的数据改动**，且会让 777 条既有断言中的依赖 `'done'` 的断言全部变红。页面上把 `done` 显示为「完成」（已是现状）。**里程碑名保留原型口径，落库值保留代码口径**，两侧在契约里显式对齐。

### 5.2 合法迁移表（`COLLECTION_TASK_TRANSITIONS`，落 `src/domain/states.js`）

```js
export const COLLECTION_TASK_TRANSITIONS = {
  draft:         ['queued', 'cancelled'],
  queued:        ['checking_env', 'cancelled'],
  checking_env:  ['running', 'waiting_human', 'cooling_down', 'failed', 'cancelled'],
  running:       ['waiting_human', 'cooling_down', 'partial', 'done', 'failed', 'cancelled'],
  waiting_human: ['running', 'cancelled'],
  cooling_down:  ['queued', 'waiting_human', 'cancelled'],
  partial:       ['queued'],   // 重试：新任务，retry_of 指向本任务
  done:          [],
  failed:        ['queued'],   // 同上
  cancelled:     [],
}
```

- `done` / `cancelled` 是**终态**（空数组）。`partial` / `failed` 允许通过**新建一个任务**重试，但那不是本任务的状态迁移，所以只在注释里说明。
- 每一次迁移**必须同时追加一行 `collection_task_event`**（§2.6），`from_status` 首次为 NULL。

### 5.3 `deriveStatus` 与四态怎么共存

`deriveStatus(result, total)`（`collection.js:508-516`）**保留、不重写**，它的职责收窄为：**`running` 如何落地到 `partial|done|failed|cancelled`**。新增的四态在它**之前**发生：

```
submit → queued ──(drain 取出)──→ checking_env ──(体检过)──→ running ──deriveStatus──→ done|partial|failed|cancelled
                                       │                        │
                                       ├→ cooling_down ──(冷却结束)──→ queued
                                       └→ waiting_human ──(人工/超时)──→ running|cancelled
```

具体改动点（**契约级，不是建议**）：

1. **`runTask` 的第一段**（`collection.js:261` 之前）插入体检：调同一个体检函数，写 `collection_env_check` 与 `env_check_json`；`status='checking_env'` 先写库。
2. **体检不过**：按严重度分派——`fail` 且可修 → 尝试修复一次；仍不过 → `failed`（`error` 写体检失败项）。`warn` → 继续（不阻断）。
3. **风控即停**：`deriveStatus` 的分支保持原样（`stopped==='blocked'`）。**新增**一条：只要本次任务里出现过 `blocked` 节，`cooling_down` 记录**站点级冷却**（写 `risk_json`），下一次同站点提交前置判定返回 `cooling_down` 而非 `queued`。
4. **`cooling_down` 的落地**：`submit()`（`collection.js:149`）在 `insertCollectionTask` 之前加一次冷却判定；命中则**仍建任务行**（状态 `cooling_down`），但**不 push 进 `queue`**——建行是为了让用户看得见「我提交了，在等冷却」，不排队是为了不违反冷却。
5. **`draft`**：`amzn_collect_save_draft` 走 `insertCollectionTask({status:'draft'})`，**不入队**。`drain()` 已有守卫：`task.status !== 'queued'` 就跳过（`collection.js:231`）——**这条既有守卫恰好让 `draft` 安全，不要删它**。

### 5.4 `waiting_human` 三触发（F04-06）

`waiting_json.trigger ∈ { 'profile-logged-out', 'login-wall', 'plan-window' }`，与 `04-采集中心.md:112` 三类一一对应：

| trigger | 何时写 | `reason` | `actions[]` |
|---|---|---|---|
| `profile-logged-out` | 体检第 05 项（登录态）为 `fail` 或 `unknown`，且体检停在 `checking_env` | 「专用 profile 未登录 <站点>，需要在本机浏览器完成登录」 | `[{id:'open-browser', label:'打开采集浏览器'},{id:'recheck', label:'已登录，重试体检'}]` |
| `login-wall` | 采集中命中登录墙/验证码，且用户选择「人工处理后继续」 | 「<节 id> 触发登录墙/验证码，自动重试已暂停」 | `[{id:'resume', label:'已处理，继续采集'},{id:'abandon', label:'放弃本次（保留已采节）'}]` |
| `plan-window` | `plan_id` 非空且当前时刻在 `window_json` 之外 | 「计划 <name> 的运行窗口 <from>–<to>（<tz>）未到」 | `[{id:'force-resume', label:'本次放行'},{id:'abandon', label:'放弃本次'}]` |

**同时命中时的优先级（2026-10-07 补充，原契约只写了三触发、没写先后）**：站点冷却与计划窗口在**同一次提交**上同时命中时，**先判计划窗口**——任务停在 `waiting_human`（`trigger='plan-window'`），**不是** `cooling_down`。

- 理由不是「哪条规则更严重」，而是**两个态的出口不同**：`cooling_down` 在冷却到期后**自动**回到 `queued`（§5.5 的恢复表），而关着的窗口只能由人来解除（`force-resume` / `abandon`）。先判冷却就是把任务交给一条自动出口，冷却一结束它立刻又撞上关着的窗口——人只看到「冷却中」，永远看不到真正不让它跑的那条规则。
- 落地位置：`submitCollectionTask`（`src/sources/collection.js`）中窗口判定在冷却判定**之前**，两条分支各自写 `waiting_json` / `risk_json`，互不覆盖。
- 本补充**不改**上表三触发各自的 `reason` 与 `actions[]`，只规定两者的先后；冷却单独命中时仍是 `cooling_down`（§5.3-4 不变）。

**超时**：`waiting_json.deadlineAt = since + 1800s`。超时扫描是一个**幂等的纯函数** `CollectionService.scanWaitingTimeouts(now)`，在**两处**被调用：① `GET /api/state` 的 `buildState`（页面轮询天然是心跳，`routes.js:1525`）；② `index.js` 的启动恢复段（与 `scanDueObservations` 同址，`index.js:118-125`）。**不做定时器**（§0.2-2）。超时后写 `status='cancelled'`、`error='等待人工 30 分钟无操作，自动取消（已采数据保留）'`，**不删任何 `collection_section_result` 行**。

### 5.5 断点恢复（与既有 `recover()` 共存）

现状：`recoverStaleTasks`（`queries.js:699-717`）只认 `running` → `failed` + `queued` 重入队。

本批**扩条件、不改既有分支语义**：

```sql
-- 由调用方传入的 in-flight 集合扩到四态
SELECT id FROM collection_task
 WHERE status IN ('running','checking_env','cooling_down','waiting_human')
   AND COALESCE(kind,'asin') = ?
```

| 重启前的状态 | 恢复处置 | 理由 |
|---|---|---|
| `running` | → `failed`（`error` 保留为 `服务重启，任务中断`）**且不重采已 `collected` 的节** | 与今天一致；新增的「不重复写入」靠 `collection_section_result` 的 `UNIQUE` + 恢复时先查已完成节 |
| `queued` | 重新入队（今天的行为，不变） | `queries.js:713-716` |
| `checking_env` | → `failed`（体检没有进程在跑了） | 新分支 |
| `cooling_down` | → `queued`（冷却是有时限的状态，重启不是它的理由） | 新分支 |
| `waiting_human` | **保持原状**，`deadlineAt` 不重算（`since` 存的是库里的时刻） | 重启不该让人工等待重新计时；30 分钟从用户第一次看到它算起 |

**「不重复写入已完成节」的判据（可测）**：恢复一个 `running` 任务后，对其重新入队/重试，`collection_section_result` 中 `status='collected'` 的行的 `collected_at` **不变**，且 `collection_task_event` 多一行 `source='plugin'` 的 `failed`。

---

## 6. 接口契约

### 6.1 通用约定

- **工具 `output` 一律 `{ schema: {}, render: (args, value) => text(value) }`**（`src/tools/collect.js:95` 已是此形）。`{type:'json'}` 会抛 `UNSUPPORTED_SCHEMA` 并拖垮整棵插件树（`docs/plugin-contract.md:112-119`）。
- **工具不抛错**：可预期的输入问题一律 `return { ok: false, code, error }`；`instrument`（`src/tools/index.js:59`）只在真异常时兜底。
- **错误码格式**：`SCREAMING_SNAKE`，附 `error` 人读串与 `hint`（可空）。本批**沿用既有** `APPROVAL_REQUIRED`（`src/domain/approval/policy.js:280`）。
- **注册两处**：每个新工具必须在 `src/tools/index.js` 的 `buildTools`（`:65`）与 `index.js` 的 `TOOLS`（`:258`）**同时登记**。`tests/run.mjs:9090` 断言 `routeTools.length === TOOLS.length`，`:9106` 断言 `routeTools.length === 71` —— **那个字面量 71 必须改成 82**，这是本批唯一一处需要改字面量的既有断言。
- **路由**：前缀 `/custom/amazon-ops/api`（`routes.js:186` 由 `pagePath` 派生，**不以斜杠结尾**，`plugin-contract.md:73-83`）。新路由名接在 `routes.js:305-1247` 的 `if (route === '…')` 链上，写操作必须 `pageWrite(...)` 包审计（`:320` 起的既有写法）。
- **工具名禁用词**：工作台有一条守卫拒绝含 `publish|apply|push|deploy` 的工具名（`index.js:366-369` 的注释）。本批 11 个名字均不含。

### 6.2 新增工具（**12 个**：81 → 93）

> **数字更正（2026-10-04，主理人）**：本节原标题写「11 个：71 → 82」，与正文不符。按小节逐条数：
> 6.2.1 `env_check`、6.2.2 `repair`、6.2.3 `preview`、6.2.4 `run`、6.2.5 `cancel`、6.2.6 `waiting_resolve`、
> 6.2.7 `detail`、6.2.8 `scheme_list`、6.2.9 `scheme_save`、6.2.10 `scheme_transition`、6.2.11 **两个**
> （`plan_list` + `plan_save`）——**12 个新工具**。`amzn_collect_submit` 是既有的，不计数。
> 相对当时的 main（81）即 **81 → 93**。**这是 G2 的三项未通过项之一，必须以此处为准。**

#### 6.2.1 `amzn_collect_env_check` — 环境体检（F04-01）

```js
parameters: { type: 'object', properties: {
  taskId: { type: 'string' },          // 有：结果挂到这个任务；无：独立体检
  marketplace: { type: 'string' },     // 默认 US；决定「站点匹配」「登录态」两项校哪个站
  repair: { type: 'boolean' },         // 默认 false。true 时对可修项执行修复动作
  checks: { type: 'array', items: { type: 'string' } },  // 只跑这几项（§4.2 的 check_id）
} }
```

**出参**（`render` 的人读版照 `amzn_collect_doctor`（`collect.js:207-294`）的分块风格）：

```json
{ "ok": true, "checkedAt": "2026-10-03T13:41:02.000Z", "marketplace": "US",
  "summary": { "ok": 7, "warn": 2, "fail": 1, "unknown": 0, "repairable": 2 },
  "checks": [ { "id": "01-runtime", "label": "运行时", "status": "ok",
                "detail": "Node v24.18.0", "repairable": false, "repairAction": null, "risk": "low" } ],
  "repairs": [ { "id": "03-profile", "action": "mkdir", "ok": true, "detail": "已创建 …\\data\\chrome-profile" } ] }
```

**十项 `check_id`（固定顺序，就是 §4.1 的十项）**：

| # | `check_id` | 判据来源（现状） | `repairable` + `repairAction` |
|---|---|---|---|
| 01 | `01-runtime` | `process.version` | false |
| 02 | `02-browser` | `findBrowser(chromePath)`（`collector.js` 内） + `probeVersion(host, port)`（`:458`） | **true** `launch_browser`（不静默下载：找不到可执行文件时**只报错**） |
| 03 | `03-profile` | `discoverProfiles`/`profileView`（`src/domain/collect/profile.js:85,124`） | **true** `mkdir` |
| 04 | `04-port` | `probeVersion(host, port)` 返回 `null` 即未连通（`collector.js:458-468`） | **true** `reconnect_port` |
| 05 | `05-login` | `healthCheck().login`（`collector.js:457-518`，`logged_in`/`logged_out`/`unknown`） | false（**禁令：不自动输入密码**） |
| 06 | `06-storefront` | `verifyStorefront` 的最近结果（`collector.js:396-401`） | **true** `set_context` |
| 07 | `07-datadir` | 对 `dataDir` 与 `resolveImportDir(store)`（`profile.js:193-203`）做一次 `access(W_OK)` | **true** `mkdir` |
| 08 | `08-scheme` | `collection_scheme` 里 `status='active'` 的方案数与 `verified_at` | false（**禁令：不静默改方案版本**） |
| 09 | `09-proxy` | **仓库里没有代理实现**（`registry.js:36-39` 无代理字段） | false；`status='unknown'`，`detail='未配置代理（本版采集不走代理）'` |
| 10 | `10-cooldown` | `collection_task` 里同站点最近一次 `blocked` 的时间 + `collection_plan.cooldown_minutes` | false（冷却不可被体检强行解除） |

**错误码**：`TASK_NOT_FOUND`（404 语义，给 `taskId` 但查不到）、`UNKNOWN_CHECK_ID`、`MARKETPLACE_UNKNOWN`。
**边界值**：`checks` 为空数组 = 跑十项（**不解释成「一项都不跑」**）；`repair=true` 时不可修项**照常报告但不尝试**。

#### 6.2.2 `amzn_collect_repair` — 环境修复（F04-02）

```js
parameters: { type: 'object', properties: {
  action: { type: 'string', enum: ['mkdir', 'launch_browser', 'reconnect_port', 'set_context'] },
  marketplace: { type: 'string' },   // set_context 用
  postalCode: { type: 'string' },    // set_context 用
  profileDir: { type: 'string' },    // mkdir 用，默认 dataDir/chrome-profile
  confirm: { type: 'boolean' },      // 见下
} , required: ['action'] }
```

**出参**：`{ ok, action, changed: [{ what, from, to }], detail, checkedAfter }`（修复后**重跑受影响的体检项**，不让调用方自己再查一遍）。

**四条硬拒绝**（F04-02 的禁令，写成 `code`，不是文案）：

| 情况 | `code` | 行为 |
|---|---|---|
| 找不到 Chrome/Edge 可执行文件 | `BROWSER_NOT_INSTALLED` | **拒绝**，`hint='请先自行安装浏览器；本插件不会静默下载'` |
| 需要账号密码才能继续 | `CREDENTIALS_REQUIRED` | **拒绝**，`hint='请在本机浏览器窗口手动登录'` |
| 有非采集用途的浏览器进程要清理 | `PROCESS_KILL_REFUSED` | **拒绝**，`hint='不杀未知浏览器进程'` |
| 目标是验证码/反机器人页 | `CAPTCHA_NOT_BYPASSABLE` | **拒绝**，`hint='不绕过验证码'` |

`launch_browser` 在服务端启动一个 GUI 窗口，所以 **`confirm` 默认为 false，且 `confirm!==true` 时返回 `APPROVAL_REQUIRED` 而非执行**——沿用既有的二次确认机制（`collect.js:99-106` 的 `approvalRefusal` 同款），但**不注册新的审批开关**（本批不写 `setting`，避免扩面）。

**错误码**：以上的四个 + `UNKNOWN_ACTION` + `REPAIR_FAILED`（动作执行了但复查仍不过，附 `checkedAfter`）。

#### 6.2.3 `amzn_collect_preview` — 提交前预览（F04-03）

**只读，绝不打开浏览器**（§3 耗时上限）。

```js
parameters: { type: 'object', properties: {
  source: { type: 'string' },
  targets: { type: 'array', items: { type: 'object', properties: {
    asin: { type: 'string' }, marketplace: { type: 'string' }, side: { type: 'string', enum: ['self','competitor'] } } } },
  asins: { type: 'array', items: { type: 'string' } },
  selfAsins: { type: 'array', items: { type: 'string' } },        // 分框入口
  competitorAsins: { type: 'array', items: { type: 'string' } },  // 分框入口
  marketplace: { type: 'string' }, postalCode: { type: 'string' },
  schemeId: { type: 'string' }, schemeVersion: { type: 'number' },
  fields: { type: 'array', items: { type: 'string' } },
  reuseFreshSnapshots: { type: 'boolean' },   // 默认 true
  freshnessDays: { type: 'number' },          // 默认 7（规则口径基线：价格/BSR/评分/标题 ≤7 天）
} }
```

**出参 = 六项预览（§4.4 的六项，逐项对应）**：

```json
{ "ok": true,
  "validAsins": { "total": 7, "self": 4, "competitor": 3 },
  "duplicates": [ { "asin": "B0…", "marketplace": "US", "occurrences": 2 } ],
  "unknownOwnership": [ { "asin": "B0…", "marketplace": "US", "tier": "unknown", "suggestion": null } ],
  "estimatedRequests": { "asins": 7, "sections": 13, "total": 91, "loginRequiredSections": 2 },
  "risk": { "level": "medium", "reasons": ["含评论节", "该站点 24h 内有 1 次 429"] },
  "reuse": { "count": 3, "asins": [ { "asin": "B0…", "marketplace": "US", "snapshotId": 1042,
                                      "collectedAt": "2026-10-01T…", "ageDays": 2.4 } ] },
  "scheme": { "id": "scheme-full13", "version": 3, "name": "全量 13 节", "status": "active",
              "verifiedAt": "2026-09-30T07:44:00.000Z" } }
```

- `estimatedRequests` 的计算口径**必须与 `estimateMinutes`（`collection.js:541-545`）共用一份计数**，否则「91 个请求」与「约 X 分钟」会各说各话。
- 「需要登录的字段」这一项（§4.4）落在 `loginRequiredSections`：由方案 `requires_login` 与节的 `requires_login` 推导。**待确认**：13 节里哪些节需要登录，需求文档未列（§9 O3）；本批按「`aplus` 与 `reviews` 之外都可匿名取」的保守假设实现，并在 `render` 里标注「按当前假设」。

**错误码**：`INVALID_ASIN`（附全部非法项）、`SOURCE_UNKNOWN`、`SOURCE_NOT_COLLECTIBLE`（`registry.js:90-97` 的 `manual` 源）、`SCHEME_NOT_SELECTABLE`（方案是 `draft`/`disabled`/`obsolete`，`04-采集中心.md:177`）、`SCHEME_VERSION_UNKNOWN`、`FIELDS_UNSUPPORTED`（`collection.js:489-501` 的同一条规则）。

#### 6.2.4 `amzn_collect_run` — 发起采集（F04-03 的编排）

与 `amzn_collect_submit` **并存**（submit 是既有的、被 777 条断言钉住的最低层入口，不删不改签名）。

```js
parameters: { type: 'object', properties: {
  // 与 preview 同形：source / targets / asins / selfAsins / competitorAsins /
  // marketplace / postalCode / schemeId / schemeVersion / fields /
  // reuseFreshSnapshots / freshnessDays
  perTaskMax: { type: 'number' }, humanize: { type: 'boolean' }, strictStorefront: { type: 'boolean' },
  sourceContextId: { type: 'string' },   // F04-04：从哪个外部入口进来（决定横幅与默认字段范围）
  draft: { type: 'boolean' },            // true = 存为 draft，不入队
  confirm: { type: 'boolean' },          // 批量闸门（沿用 batchCollect）
}, required: [] }
```

**行为链（顺序是契约的一部分）**：

1. **归属解析**（§6.4 的五级链）→ 写 `side_split_json` + `ownership_evidence_json`。
2. **体检**：等价于 `amzn_collect_env_check({ marketplace })`；有 `fail` 项 → 任务落 `checking_env`，返回 `ok:false, code:'ENV_CHECK_FAILED'`，**不入队**。
3. **冷却/窗口判定** → `cooling_down`（不入队）或 `waiting_human`（`plan-window` 触发）。
4. **批量闸门**：`targets.length > 1` 且未带 `confirm` → `APPROVAL_REQUIRED`（`collect.js:99-106` 同款，**闸门在提交前**）。
5. **建任务行**（`insertCollectionTask`，带全部新列）→ 入队 → 返回。

**出参**：`amzn_collect_submit` 的既有出参加：`{ taskId, status, sideSplit, envSummary, risk, reuse, preview }`。

**错误码**：§6.2.3 全部 + `ENV_CHECK_FAILED` + `COOLING_DOWN` + `DAILY_LIMIT_REACHED`（`collection.js:176-181`）+ `TOO_MANY_TARGETS`（`:185-190`）+ `APPROVAL_REQUIRED`。

#### 6.2.5 `amzn_collect_cancel` — 取消（F04-05 的取消语义）

```js
parameters: { type:'object', properties:{ taskId:{type:'string'}, reason:{type:'string'} }, required:['taskId'] }
```

**出参**：`{ ok, taskId, status:'cancelled', keptSections: 27, note }`——**必须回报保留下来的节数**，因为「取消只停后续动作，保留已采数据」（§4.5）是这条的验收点，不回报就无法证明。
**接的既有函数**：`collection.cancel(taskId)`（`collection.js:385-408`，**目前零调用方**，见 §1.2(2)）。
**错误码**：`TASK_NOT_FOUND`、`NOT_CANCELLABLE`（已是终态，附当前状态）。

#### 6.2.6 `amzn_collect_waiting_resolve` — waiting_human 处置（F04-06）

```js
parameters: { type:'object', properties:{
  taskId:{type:'string'},
  action:{type:'string', enum:['resume','recheck','open-browser','force-resume','abandon']},
  reason:{type:'string'},   // abandon 必填（F04-06 的「放弃本次」要留原因）
}, required:['taskId','action'] }
```

| `action` | 允许的 `trigger` | 效果 |
|---|---|---|
| `resume` | `login-wall` | → `running`，从**第一个未完成节**继续（断点） |
| `recheck` | `profile-logged-out` | 重跑第 05 项体检 → 过则 `running`，不过则留在 `waiting_human` |
| `open-browser` | `profile-logged-out` | 拉起采集浏览器窗口（**只拉起，不输入任何凭据**） |
| `force-resume` | `plan-window` | → `running`（本次放行，不改计划） |
| `abandon` | 任意 | → `cancelled`，保留已采节 |

**出参**：`{ ok, taskId, status, keptSections, keptSnapshots, note }`。
**错误码**：`TASK_NOT_FOUND`、`NOT_WAITING`（任务不在 `waiting_human`）、`ACTION_NOT_ALLOWED`（action 与该 trigger 不匹配，附允许集合）、`REASON_REQUIRED`、`WAITING_EXPIRED`（已超时转 cancelled）。

#### 6.2.7 `amzn_collect_detail` — 13 节采集详情（F04-07）

```js
parameters: { type:'object', properties:{
  taskId:{type:'string'},
  asin:{type:'string'}, marketplace:{type:'string'},
  sections:{type:'array', items:{type:'string'}},   // 只这几节
  includeRaw:{type:'boolean'},   // 默认 false（正文可能很大，见 §3 的 64 KB 上限）
  includeDiff:{type:'boolean'},  // 默认 true
}, required:['taskId'] }
```

- `asin` 省略 = **返回该任务每个 ASIN 的 `summary` 而不含节明细**（列表视图），避免一次吐出 2 600 行。
- 出参形状见 §4.4。
- **错误码**：`TASK_NOT_FOUND`、`ASIN_NOT_IN_TASK`、`SECTION_UNKNOWN`、`NOT_COLLECTED`（任务还没产出任何节行）。

#### 6.2.8 `amzn_collect_scheme_list` — 方案列表（F04-09）

```js
parameters: { type:'object', properties:{ status:{type:'string'}, schemeId:{type:'string'}, includeVersions:{type:'boolean'} } }
```
**出参**：`{ ok, schemes:[{ id, name, version, status, driver, marketplaces, sections, requiresLogin, riskLevel, verifiedAt, verifiedBy, usage:{ taskCount, lastUsedAt } }] }`。
`usage` 是判断「能不能废弃」的依据（被任务引用过的方案不能删，只能废弃）。

#### 6.2.9 `amzn_collect_scheme_save` — 新建/改草案（F04-09）

```js
parameters: { type:'object', properties:{
  id:{type:'string'},            // 省略 = 新建，version 从 1 起
  name:{type:'string'},
  baseVersion:{type:'number'},   // 改版：基于哪一版 → 新版本号 = max+1，旧版一字不动
  sections:{type:'array', items:{type:'string'}},
  marketplaces:{type:'array', items:{type:'string'}},
  requiresLogin:{type:'boolean'}, riskLevel:{type:'string'},
  defaultPacing:{type:'object'}, note:{type:'string'},
}, required:['name'] }
```
**出错码**：`SCHEME_NOT_FOUND`、`SCHEME_IMMUTABLE`（改的不是 `draft`——既不是草稿就不能原地改，**这是版本化资产的判据**）、`NAME_REQUIRED`、`SECTION_UNKNOWN`、`MARKETPLACE_UNKNOWN`。

#### 6.2.10 `amzn_collect_scheme_transition` — 状态流转（F04-09）

```js
parameters: { type:'object', properties:{
  id:{type:'string'}, version:{type:'number'},
  action:{type:'string', enum:['verify','activate','disable','obsolete','restore']},
  reason:{type:'string'}, confirm:{type:'boolean'},
}, required:['id','version','action'] }
```
- `verify` = 「验证并转为可用」：**真的调一次体检 + 对一个样本 ASIN 的采集探针**，过了才 `draft → active` 并写 `verified_at/verified_by`；不过返回 `SCHEME_VERIFY_FAILED`（附失败项）。**这是唯一会让方案变更 `active` 的路径。**
- `disable` / `obsolete` 是**破坏性**的（新任务不能再选它，见 `04-采集中心.md:177`），因此 `confirm!==true` → `APPROVAL_REQUIRED`；`reason` 必填。
- 状态迁移表：

```js
export const COLLECTION_SCHEME_TRANSITIONS = {
  draft:    ['active', 'obsolete'],
  active:   ['disabled', 'obsolete'],
  disabled: ['active', 'obsolete', 'draft'],   // 改版要走 baseVersion，不是原地改
  obsolete: [],
}
```
`obsolete` 是**终态**（`restore` 只对 `disabled` 有效；`obsolete` 方案不可复活，否则「已废弃」就没有意义）。

**错误码**：`SCHEME_NOT_FOUND`、`ILLEGAL_TRANSITION`（附允许集合）、`SCHEME_VERIFY_FAILED`、`REASON_REQUIRED`、`APPROVAL_REQUIRED`、`SCHEME_IN_USE`（`obsolete` 时若有 `queued`/`running` 任务引用它）。

#### 6.2.11 `amzn_collect_plan_list` / `amzn_collect_plan_save` — 计划采集（F04-10）

```js
// plan_list
parameters: { type:'object', properties:{ enabled:{type:'boolean'}, marketplace:{type:'string'} } }
// plan_save
parameters: { type:'object', properties:{
  id:{type:'string'}, name:{type:'string'},
  enabled:{type:'boolean'},          // 默认 false（默认关闭）
  marketplace:{type:'string'}, targets:{type:'array'},
  schemeId:{type:'string'}, schemeVersion:{type:'number'},
  window:{type:'object'}, intervalMinutes:{type:'number'},
  maxObjects:{type:'number'}, failurePolicy:{type:'string'},
  cooldownMinutes:{type:'number'}, notify:{type:'string'},
  pauseCondition:{type:'object'},
}, required:['name'] }
```
**出参**：`plan_list` 每行带 `nextWindow: { from, to, tz, openNow }`（**每次读时算**，不入库——§2.2 的「不做 `next_run_at`」）；`plan_save` 返回落库后的整行。

**错误码**：`PLAN_NOT_FOUND`、`NAME_REQUIRED`、`DUPLICATE_NAME`、`WINDOW_INVALID`（`from >= to` 或格式错）、`INTERVAL_INVALID`（`< 1`）、`FAILURE_POLICY_UNKNOWN`、`NOTIFY_UNKNOWN`、`SCHEME_NOT_SELECTABLE`、`TARGETS_EMPTY`。

> **工具总数核对（逐名清点，以这里为准）**：本批新增 **12** 个工具 —— `amzn_collect_env_check`、`amzn_collect_repair`、`amzn_collect_preview`、`amzn_collect_run`、`amzn_collect_cancel`、`amzn_collect_waiting_resolve`、`amzn_collect_detail`、`amzn_collect_scheme_list`、`amzn_collect_scheme_save`、`amzn_collect_scheme_transition`、`amzn_collect_plan_list`、`amzn_collect_plan_save`。
> 因此 **`TOOLS` 71 → 83**，`tests/run.mjs:9106` 的字面量改 **83**。§0 标题里的「+11」与 §11 的对应条目已按此更正。

### 6.3 新增 `POST /api/*` 路由（7 条）

全部挂在 `pagePath + '/api'` 下，写法照 `routes.js:318-347` 的既有模式（`readJson` → `pageWrite(name, body)` 包审计 → 调**与工具同一个函数** → `done(...)` → `sendJson`）。**页面与工具必须调同一个实现**，这是本仓既有的防漂移纪律（`routes.js:336,352,374` 的注释）。

| 路由 | 方法 | 请求体 | 响应 | 与哪个工具共用实现 |
|---|---|---|---|---|
| `collect-preview` | POST | 同 `amzn_collect_preview` 入参 | 同其出参 | `previewCollection()` |
| `collect-run` | POST | 同 `amzn_collect_run` 入参 | 同其出参 | `submitCollectionTask()` |
| `collect-cancel` | POST | `{taskId, reason?}` | 同 `amzn_collect_cancel` | `collection.cancel` |
| `collect-env-check` | POST | `{taskId?, marketplace, repair?}` | 同 `amzn_collect_env_check` | `runEnvCheck()` |
| `collect-waiting` | POST | `{taskId, action, reason?}` | 同 `amzn_collect_waiting_resolve` | `resolveWaiting()` |
| `collect-scheme` | POST | `{op:'save'\|'transition', …}` | 同 `scheme_save` / `scheme_transition` | 同上 |
| `collect-plan` | POST | `{op:'save', …}` 或 `{op:'set-enabled', id, enabled}` | 同 `plan_save` / `setPlanEnabled` | 同上 |

> ⚠️ **主理人修订（2026-10-09，推翻本节原措辞「启用/停用是同一个 `save`」）**
>
> 原文（本节与 §6.2.11）写「启用/停用是同一个 `save`（`enabled`）」。**那是缺陷**：
> `planSave` 是**整行替换**（缺 `name`/`targets` 直接拒、没给的列写 null），所以拿它翻转
> 一个布尔，会**顺手把别人刚改的运行窗口写回去**。而窗口是被另一个读路径消费的
> （`nextWindow`，契约 §2.2 明说不设 `next_run_at`、每次读时算）——**被静默改回去之后
> 没有任何信号**，正是本仓最忌讳的那类失败。
>
> 实测事故链（B-04c-2 报告）：页面发 `{op:'set-enabled'}` → `routes.js` 只认 `op==='save'`
> → **恒 400 `unknown op`**，按钮永远只回一句拒绝、`enabled` 一位不变；而
> `store/collection-plan.js` 的 `setPlanEnabled(store,id,enabled)`（语义正是「只翻 enabled」）
> **生产代码零调用点** —— 又是一个「建成但没接线」。
>
> **决定：加 `op:'set-enabled'`，用窄更新，不做整行替换。** 要求：
> ① `enabled` 必须是布尔（`typeof !== 'boolean'` → 结构化拒绝，不许 `!!`）；
> ② 未知 `id` → 结构化拒绝且**一行都不写**；
> ③ **未知 `op` 仍然 400**（这句是这条路由的兜底，不许删）；
> ④ 审计行的 `object_id` 必须等于被翻转的 plan id（**不是 null**）；
> ⑤ 跨接口断言必须包含「**同一行的 `window`/`interval`/`maxObjects` 一字未变**」——
>    没有最后半句，这条修订就与「整行替换」没有区别。

**只读切片**（不新增路由，挂在既有 `GET /api/state` 上，`routes.js:1525-1526`）：

```js
collection: collectionSummary(collection),        // 扩展：+ waitingCount, coolingCount, todayUsage
tasks: collection.list(15).tasks,                 // 不变（见下）
collectPanel: {                                   // 新增
  env: lastEnvCheck(store),                       // 十项摘要（或 null）
  schemes: listSchemes(store),                    // 方案卡片
  plans: listPlans(store),                        // 计划卡片
  risk: lastRisk(store),                          // 站点级风控/冷却
  pacingRows: settingsRowsFor('pacing.'),         // 见下（限速控件的那三行）
  pacing: { resolved: pickPacing(collection.pacing()) },   // 见下（「此刻生效」那半句）
  selectedTask: taskIdFromFilters ? detailSummary(store, taskId) : null,   // 只给 summary，不给节明细
},
```

> ⚠️ **主理人修订（2026-10-09）：限速控件必须自带它读的那三行，不许去开整份设置切片**
>
> 实测（B-04c-2 报告）：`routes.js:1869` 的 `settings` 是**惰性切片**，只在
> `context.module === 'settings'` 时算。而限速控件就长在**采集**模块的发起表单里，
> 于是 `module=collect` 时 `state.settings === null` ⇒ 那一格永远走「读不到设置行」
> 分支，**一个输入框、一个保存按钮都不画**。
>
> ```
> module=collect   | settings = null   | pacing rows = n/a
> module=settings  | settings = object | pacing rows = 3
> ```
>
> 这与计划开关是**同一类失败**：功能建成了，接线的那一头没接。
>
> **决定：选 B —— 在 `collectPanel` 里加 `pacingRows`，不动 `settings` 切片的惰性条件。**
> 理由与本文件 120KB 那一条**是同一条**：我们刚因为「没人读的数据在 3 秒轮询里被反复搬运」
> 砍掉了 437 KB 的 `targets`/`results`；转头为了三个输入框把**整份设置切片**
> （站点/工作区/店铺/品牌/事实…）塞进采集页的 state，是不自洽的。
> `collectPanel` 本来就是采集页的专属载荷，`env`/`schemes`/`plans`/`risk` 都在里面。
>
> 实现要求：
> ① **按声明取，不按硬写的键名取**：`pacingRows` 必须是「声明里 `pacing.` 前缀的那些行」，
>    不许写死三个键 —— 否则将来声明里加第四个键，控件会静默不出现（**第二份清单**，本仓的老毛病）。
> ② **单一来源**：行里的键/类型/下限/说明/`effect` 全部来自 `store/settings.js` 的那份声明，
>    页面与路由都不许再写一份。这与本文件 §7.3 的状态词表注入是同一条纪律。
> ③ **`settings` 模块那一份不动**，并要有一条断言证明它**没被改坏**。
> ④ 跨接口断言：`module=collect` 的 `/api/state` **真的带着那几行**，且页面**真的画出**对应数量的控件。
> ⑤ 真正的失败态（声明本身读不到）仍要说话：**「读不到不等于没有上限」** —— 不许静默画成一个空表。

> ⚠️ **主理人修订（2026-10-09 第二次）：`resolved` 只加这一个字段，`used/limit/remaining` 不许重复给**
>
> 实测（B-04c-2 报告）：限速块那句「服务端此刻生效：每任务上限 X · 任务间隔 Y」读的是
> `state.settings.pacing.resolved` —— 而 `settings` 正是我上一条**裁决不动**的那个惰性切片，
> 采集模块下它是 `null`。于是那一格渲染成
>
> ```
> 服务端此刻生效：<span class="hint">服务端未就绪，读不到生效值</span> · 今日已用 0 / 1200（剩 1200）
> ```
>
> **「服务端未就绪」是一句假话**（服务端就绪，只是这个切片不在这个模块的载荷里），
> 而右边又印着**真实的**用量数字 —— 一句假话紧挨着一个真数字，读者无法分辨哪个可信。
>
> **决定：`collectPanel.pacing = { resolved }`，只加 `resolved` 这一个。**
> `used / limit / remaining` **不加**：它们在采集模块上**本来就已经渲染正确**
> （来源是 `collection.todayUsage`）。再加一份就是**同一个数字的第二来源** ——
> 与本节前面两条裁决是同一条纪律（第二份词表 / 第二份清单 / 第二份数字，都是漂移的起点）。
> `resolved` 用 `pickPacing(collection.pacing())`，**与采集服务自己用的是同一个函数**，
> 不新写一份「怎么算生效值」。
>
> 实现要求：
> ① **两种「没有」要分开**：修好之后采集模块上切片**总是**有 `resolved`，
>    所以此时 `null` 的含义是「值真的取不到」，说「读不到」才是诚实的；
>    而「切片没被发过来」这一态在采集模块上**不该再出现**（真出现了就是接线又断了）。
> ② **不许让一句假话紧挨着一个真数字**：`resolved` 取不到时，那半句要说得窄
>    （「生效值取不到」），不许说成整体的「服务端未就绪」—— 右边那三个数就是服务端给的。
> ③ 断言要三条：跨接口证明 `module=collect` 的 `/api/state` **真的带着** `resolved`
>    且等于 `pickPacing(collection.pacing())`；页面**渲染出真实数字**而不是那句提示；
>    `settings` 模块那一份**未被改坏**。
> ④ 不新增任何工具、不改路由表其余部分。
>
> **另两条已确认（回答 B-04c-2 的提问）**：
> - `settingsRowsFor` 在 `listSettings()` 之上做**前缀过滤**（读整张 setting 表约 20 行）
>   而不是写一条专用 SQL —— **保持这样**。20 行不值一提，而专用 SQL 会把「哪些键属于
>   pacing」变成**第二份清单**，那正是本条要防的。
> - §8-46 的 120 KB 断言量的是**响应体字节数**（`Buffer.byteLength(text,'utf8')`），
>   不含 HTTP 头/分块开销；契约原话是「响应」。**此口径记录在此**，
>   以免以后有人拿不同口径的数字互相比。

> ⚠️ **主理人修订（2026-10-09）：`tasks` 切片必须投影，不能再整份 `hydrate()`**
>
> 实测（`node .b04budget.mjs`，200 目标/任务）：

| 场景 | 库规模 | `/api/state` 总量 |
|---|---|---|
| A 200 任务 × 20 目标 | 200 任务 | 56 465 B（55.1 KB） |
| B + 选中任务（无节行） | 200 任务 | 56 563 B（55.2 KB） |
| C + 选中任务已记 200×13 节 | 200 任务 | 89 962 B（87.9 KB） |
| **D 最近 15 条任务都在 200 目标上限** | **200 任务（字面场景）** | **478 823 B（467.6 KB）＝预算 3.9 倍** |

>
> D **不是构造出来的边角**：它就在 §8-46「200 个任务的库」这句的字面场景里
> （契约自己允许每任务 200 目标）。超标的 437 KB 几乎全在 `tasks` 一项，而
> `renderTasks`（`page.js:6180-6203`）**不读 `targets`、不读 `result.results`** ——
> 那是「算出来没人消费」的镜像：没人读的数据在 3 秒轮询的端点上被反复搬运。
>
> **决定**：`routes.js` 的 tasks 切片投影成 `renderTasks` 真正读到的字段
> （`id/kind/source/status/submittedAt/finishedAt/error/progress/result.{written,failed,scanned}`），
> 丢掉 `targets` 与 `result.results`。**多留一个字段都是新的死载荷。**
> 动形状前必须先扫清 `state.tasks` 的其它消费方（页面其它块 / `tests/` / `amzn_*` 工具 /
> agent 描述符）；若有人真在用 `targets`，就保留一个投影子集而不是整块砍掉。
> **断言要两条**：字面场景（C）≤ 120 KB **与** D 场景 ≤ 120 KB ——
> 只钉前者就是用一个宽松取值掩盖一个超标取值。

**`GET /api/sections`（第 8 条只读路由，用 `GET` 是因为它纯读且参数多）**：

| 路由 | 方法 | 查询串 | 响应 |
|---|---|---|---|
| `sections` | GET | `taskId&asin&marketplace&sections=basic,bullets&includeRaw=0` | §4.4 的形状 |

**错误码（全部路由共用）**：`BAD_REQUEST`（缺必填）、`NOT_FOUND`（对象不存在 → HTTP 404）、`CONFLICT`（状态不允许，如 `NOT_WAITING`）、`LOCKED`（迁移未跑完，见 §8-1）。HTTP 状态码：成功一律 200；参数错 400；对象不存在 404；状态不允许 409。

### 6.4 自有/竞品识别的五级优先链（F04-08）

`04-采集中心.md:132-142` 的五级，落 `src/domain/ownership/priority.js`（新文件），**在采集提交路径上被调用**（今天 `resolveOwnership` 在采集路径零调用方，见 §1.3 的 F04-08 行）：

```js
export const OWNERSHIP_TIERS = ['user-input', 'confirmed-relation', 'brand-mapping', 'signal-suggestion', 'unknown']
```

| 优先级 | `tier` | 判据（数据来源） | 现有载体 |
|---|---|---|---|
| 1 | `user-input` | 用户在 `selfAsins` / `competitorAsins` 分框里明确输入 | 入参本身 |
| 2 | `confirmed-relation` | `asin_ownership` 中 `source='manual'` 且 `object_type='side'` 且 `retracted_at IS NULL` 的已确认关系 | `schema.js:1488-1502` |
| 3 | `brand-mapping` | ASIN 的 `brand` 命中 `brand` 表的映射（`schema.js:1474`），且该品牌属于某产品线的自有品牌 | `src/store/product-line.js` + `brand` 表 |
| 4 | `signal-suggestion` | 产品线信号建议：`classifyOwnership`（`src/domain/ownership/resolve.js:101`）按标题/信号词给出的 `auto` 判定 | 已有 |
| 5 | `unknown` | 以上都不命中 | — |

**关键约束（写成断言要求）**：

1. **第一次命中的层级就是结论，不再向下继续**——低层级不许推翻高层级。**这是「五级优先链」与「`effectiveRows` 的 manual 压 auto 两段式」的区别**：`resolveOwnership`（`:67-99`）今天只做「manual 层 / auto 层」两段，本批要在它**外面**套一条三层以上的链，且**不改 `resolveOwnership` 本身的语义**（777 条断言里有依赖它的）。
2. **自动判断只是建议**：第 3、4 级的结论必须写进 `ownership_evidence_json` 的 `suggestion` 字段，`side` 只有第 1、2 级能直接定案；3、4 级的结果在 `unknownOwnership` 里同时给出 `suggestion`，**由人在预览里确认后才写 `asin_ownership`（`source='manual'`）**。
3. **人工覆盖留原因与版本**：覆盖时写 `asin_ownership` 的 `manual` 行（`evidence_json` 带 `reason`），并**不删** `auto` 行（`resolve.js:28` 的既有语义：可撤销、可回退）。版本口径沿用 `product_line_version`（`schema.js:1544`）同款：**追加行，不改旧行**。
4. **一次错误标题识别不能永久污染归属**：第 4 级的 `auto` 行必须在 `evidence_json` 里记**命中词与当时的标题快照**，使人能复核；`retracted_at` 置位即可撤销（已有列）。

---

## 7. 页面结构（对照原型 `04-collect.html`）

### 7.1 挂载点与渲染器

- `PANEL_RENDERERS.collect`（`page.js:858`）由 `renderTasks` **换成 `renderCollect`**（新函数），`renderTasks` **保留**为内部的任务列表切片函数（它已被 777 条断言之外的页面行为依赖，且 `#tasks` 是 `routes.js`/页面既有约定的挂载点）。`RICH_PANELS`（`page.js:50`）已含 `collect`，不用改。
- `#panel-collect` 的现有骨架（`page.js:378-381`）扩为：

```html
<div class="panel" id="panel-collect" hidden>
  <div id="collectEnv"></div>        <!-- 环境状态条 + 十项体检表（原型 74-93 行） -->
  <div class="bar"><span class="hint" id="collectHint" style="padding:0"></span></div>  <!-- 保留 -->
  <div id="collectForm"></div>       <!-- 左：发起表单 + 预填横幅 + 提交前预览（原型 98-139 行） -->
  <div id="collectWaiting"></div>    <!-- 中：waiting_human 处置卡（原型 156-168 行） -->
  <div id="tasks"></div>             <!-- 中：任务列表（保留，原型 141-155 行） -->
  <div id="collectDetail"></div>     <!-- 右：13 节详情 + 快照差异（原型 172-209 行） -->
  <div id="collectSchemes"></div>    <!-- 页尾：采集方案管理（原型 213-243 行） -->
  <div id="collectPlans"></div>      <!-- 页尾：计划采集（原型未画，见下） -->
</div>
```

### 7.2 逐区落地

| 原型区 | 原型行 | 服务端字段 | `page.js` 渲染器 | 交互 → 路由 |
|---|---|---|---|---|
| 环境状态条 + 「去验证」 | 74-78 | `collectPanel.env.summary` + `risk` | `renderCollectEnv` | 「去设置」是既有跳转，不改 |
| 一键体检表（6 列：状态/检查项/说明/是否可修/修复动作/风险） | 80-93 | `collectPanel.env.checks[]`（十项） | `renderCollectEnv` | 「修复」按钮 → `POST collect-env-check {repair:true}` |
| 来源横幅 | 102-104 | `state.context.filters.collectContextId` → `collectPanel.prefill` | `renderCollectForm` | 无动作（只读）；**修改留痕**由 `collect-run` 的 `prefill_json.changes` 落 |
| 站点/邮编 | 106-108 | `collectPanel.sites`（复用 `settingsState` 的站点块，`routes.js:1935`） | `renderCollectForm` | 值随表单提交，不即时保存 |
| 自有 / 竞品分框 | 109-121 | `collectPanel.preview.validAsins` + `unknownOwnership` | `renderCollectForm` | 「跑预览」→ `POST collect-preview`（**不自动触发**，避免每敲一个键一次请求） |
| 方案下拉 + 限速下拉 | 122-125 | `collectPanel.schemes`（只列 `active`） | `renderCollectForm` | — |
| 提交前预览 4 项（原型只画 4，契约要 6） | 127-133 | `preview.validAsins` / `duplicates` / `estimatedRequests` / `risk` / `unknownOwnership` / `reuse` | `renderCollectForm` | — |
| 「存为草稿」/「提交采集」 | 134-137 | — | `renderCollectForm` | `POST collect-run {draft:true}` / `{confirm}` |
| 任务列表（含 9 种状态徽章） | 141-155 | `state.tasks`（15 条） | `renderTasks`（保留） | 点行 → `patchContext({filters:{taskId}})`（**已有行为**，`page.js:5503`） |
| waiting_human 处理卡 | 156-168 | `collectPanel.waiting` | `renderCollectWaiting` | 「已处理继续」→ `POST collect-waiting {action:'resume'}`；「放弃本次」→ `{action:'abandon', reason}` |
| 13 节详情（按 ASIN 展开，节级徽章 + 图例） | 172-209 | `GET /api/sections` 或 `collectPanel.selectedTask`（summary） | `renderCollectDetail` | 点 ASIN → 拉该 ASIN 的节明细；「重试该节」→ `POST collect-run`（单 ASIN + 单节，形成新任务，`retry_of` 指向本任务） |
| 方案管理（3 张卡：版本/覆盖清单/最近验证/状态） | 213-243 | `collectPanel.schemes` | `renderCollectSchemes` | 「编辑草稿」→ `collect-scheme {op:'save'}`；「验证并转为可用」→ `{op:'transition', action:'verify'}`；停用/废弃 → `{op:'transition', action:'disable'\|'obsolete', confirm:true}` |
| **计划采集**（原型未画） | — | `collectPanel.plans` | `renderCollectPlans` | 保存 → `collect-plan {op:'save'}`；启用/停用是同一个 `save`（`enabled`） |

### 7.3 状态徽章与文案（页面 → 服务端字段的对照）

- ⚠️ **主理人修订（2026-10-07，推翻本节原措辞）**：原文写「`TASK_STATUS`（`page.js:5477-5484`）**扩到 10 态**」——**那会造出第二份状态词表**，正是本仓反复出现的漂移（`domain/states.js` 里已经有 `COLLECTION_TASK_STATUS_LABELS`）。**实际做法是注入**：服务端在 `page.js` 模块作用域用 domain 的闭集组装，页面脚本里只留
  `const TASK_STATUS = ${embed(TASK_STATUS_CHIPS)};`（另四张同款：`SECTION_STATUS` / `ENV_STATE` / `RISK_LEVEL` / `WAITING_TRIGGER`，键集分别取自 `COLLECTION_SECTION_STATES` / `COLLECTION_ENV_CHECK_STATES` / `COLLECTION_RISK_LEVELS` / `COLLECTION_WAITING_TRIGGERS`）。
  理由与 `describeScope` / `SCOPE_ALL` 完全一致：页面脚本是模板字符串、没有模块系统，**所以只能由服务端注入**；手写第二份就是漂移。
  十条映射（现在住在 domain 的标签表里，页面不再手写）：
  `draft: ['草稿','']`、`queued: ['排队','']`、`checking_env: ['体检中','run']`、`running: ['进行中','run']`、`waiting_human: ['待人工','warn']`、`cooling_down: ['冷却中','warn']`、`done: ['完成','ok']`、`partial: ['部分完成','warn']`、`failed: ['失败','warn']`、`cancelled: ['已取消','']`。
- **节状态徽章**用同一套 `.chip.ok/.warn/.run/.stop`（`page.js:76-80`），映射：`collected→ok`、`missing→''`、`partial→warn`、`failed→warn`、`blocked→stop`。**不新增 CSS 类**（原型里的 `badge--st-*` / `badge--lc-*` 是原型自己样式表中的类，`page.js` 里**一个都没有**——实测 `Select-String` 在 `page.js` 对这 8 个类名零命中）。这条必须写进 UI 契约，否则页面会画出没有样式的裸 span。
- **`statusChip` 必须继续用 `hasOwnProperty`**（`page.js:5487-5491` 的既有防御）：状态字符串来自数据库，扩表后仍是对象字面量，`'constructor'` 陷阱依旧存在。

---

## 8. 验收标准（每条可测、可复现，标注验证方式）

验证方式缩写：**A** = 自动化测试（`node tests/run.mjs` 或新增 `tests/b04-collect.mjs`）；**M** = 手工（起临时实例、浏览器看页面）；**R** = 需真实浏览器（本批不承诺，列在 P5）。

| # | 功能点 | 验收标准（可测） | 方式 |
|---|---|---|---|
| 1 | F04-01 | `amzn_collect_env_check` 返回的 `checks` 数组**恰好 10 项**，`id` 集合等于 §4.2 的十项，且 `summary.ok+warn+fail+unknown == 10` | A |
| 2 | F04-01 | 桩 collector 返回「Chrome 未启动」时，`04-port` 与 `05-login` 两项为 `fail`/`unknown`，其余八项仍返回（**不因一项失败短路**） | A |
| 3 | F04-02 | `amzn_collect_repair` 对四条禁令各返回对应 `code`，且**没有任何写库副作用**（`collection_task`/`collection_scheme` 行数不变） | A |
| 4 | F04-02 | `repair:{action:'mkdir'}` 在目录不存在时创建目录并返回 `checkedAfter['07-datadir'].status==='ok'`；目录已存在时**幂等**（第二次调用不报错、mtime 不变） | A |
| 5 | F04-03 | `amzn_collect_preview` 返回**六个键**（`validAsins`/`duplicates`/`unknownOwnership`/`estimatedRequests`/`risk`/`reuse`），一个不缺；且**不启动浏览器**（桩 collector 的 `withPage` 调用计数为 0） | A |
| 6 | F04-03 | 预览的 `validAsins.total` 与随后 `collect-run` 实际入队的 `task.targets.length` **相等**（除重复项外） | A |
| 7 | F04-03 | 输入含 1 个非法 ASIN（9 位）时返回 `INVALID_ASIN`，且**一个目标都不入队**（任务表行数不变） | A |
| 8 | F04-04 | 带 `sourceContextId` 提交后，`collection_task.prefill_json.contextId` 等于该值，且 `filters` 的预填值在 `changes` 里有留痕（改一项 → 恰好多一条 change） | A |
| 9 | F04-04 | 外部入口预填的默认字段范围是「仅过期字段」：预填未改时 `fields` 等于过期节集合（与 `freshnessDays` 一致） | A |
| 10 | F04-05 | `COLLECTION_TASK_STATES` 长度 **10**，且 `draft`/`checking_env`/`waiting_human`/`cooling_down` 在其中 | A |
| 11 | F04-05 | 非法迁移被拒：对 `done` 任务调取消 → `NOT_CANCELLABLE`；把 `draft` 直接改 `running` → 无路径（`COLLECTION_TASK_TRANSITIONS` 断言） | A |
| 12 | F04-05 | 每次状态变化都追加一行 `collection_task_event`，首次 `from_status IS NULL`；连续三次迁移后事件行数 = 3 | A |
| 13 | F04-05 | **风控即停**：桩 collector 在第二个节返回 `blocked` 后，后续节不再被请求（调用计数停止），任务态为 `partial`（有写入）或 `failed`（无写入），且**没有快照被写成产品** | A |
| 14 | F04-05 | **断点恢复**：`running` 任务被重启恢复为 `failed` 后重新入队，其 `collection_section_result` 中 `status='collected'` 的行的 `collected_at` **逐行不变**（不重采） | A |
| 15 | F04-05 | `draft` 任务不掉进 `drain()`（守卫 `collection.js:231` 仍在）：存草稿后 `collection.list().running === null` 且队列长度 0 | A |
| 16 | F04-06 | 三触发各自的 `waiting_json.trigger` 与 `actions[]` 与 §5.4 表逐项一致 | A |
| 17 | F04-06 | 超时：把 `waiting_json.since` 改成 31 分钟前，调一次 `GET /api/state` → 任务变 `cancelled`，`collection_section_result` 行数**不变**，`error` 含「30 分钟」 | A |
| 18 | F04-06 | `action` 与 `trigger` 不匹配（如对 `plan-window` 调 `resume`）→ `ACTION_NOT_ALLOWED`，响应里列出允许集合 | A |
| 19 | F04-07 | `COLLECTION_SECTIONS` 长度**恰好 13**，`id` 集合等于 §4.1 表；且 `listing-fields.js` 的 `SECTIONS` 仍是 **11**（**证明没有复用它**） | A |
| 20 | F04-07 | 节级状态五态齐全：造一个每态各一节的任务 → `summary` = `{collected:1, missing:1, partial:1, failed:1, blocked:1}` | A |
| 21 | F04-07 | `missing` 与 `failed` 可区分：桩返回「页面渲染完成但本节无任何字段」→ `missing`；桩返回「选择器未命中」→ `failed` | A |
| 22 | F04-07 | 同一 `(taskId, asin, marketplace, section)` 写两次 → `UNIQUE` 约束拒绝（或 upsert 后仍只有 1 行） | A |
| 23 | F04-07 | `raw_value_json` 超 64 KB → 截断且 `errors_json` 含 `TRUNCATED`；`raw_value_json` **不等于** `parsed_value_json`（原始值不被解析覆盖） | A |
| 24 | F04-07 | 页面：任务列表点一行 → 右侧出现 13 个节徽章，`summary` 文案与工具返回逐字一致 | M |
| 25 | F04-08 | 五级链：构造同时命中 1–4 级的输入 → `decidedBy` 是最高命中的那一级，低层级不出现在结论里 | A |
| 26 | F04-08 | 第 3/4 级只产出 `suggestion`，**不自动写** `asin_ownership`（工具返回后该表行数不变） | A |
| 27 | F04-08 | 人工覆盖后 `asin_ownership` 有 `manual` 行、`auto` 行**仍在**（`retracted_at IS NULL`），撤销 manual 后回落到 auto | A |
| 28 | F04-09 | 方案是新版本而非原地改：对 `v3` 调 `scheme_save {baseVersion:3}` → 出现 `v4`，`v3` 行**逐列不变** | A |
| 29 | F04-09 | 非 `draft` 的方案调 `scheme_save` → `SCHEME_IMMUTABLE` | A |
| 30 | F04-09 | `verify` 失败（桩体检不通过）→ 仍是 `draft`，`verified_at` 为 NULL；成功 → `active` 且 `verified_at` 非空 | A |
| 31 | F04-09 | `disable`/`obsolete` 无 `confirm` → `APPROVAL_REQUIRED`；`obsolete` 是终态（再调 `restore` → `ILLEGAL_TRANSITION`） | A |
| 32 | F04-09 | `obsolete` 时若有 `queued` 任务引用该版本 → `SCHEME_IN_USE` | A |
| 33 | F04-10 | `plan_save` 不带 `enabled` → 落库 `enabled = 0`（默认关闭） | A |
| 34 | F04-10 | `plan_list` 的 `nextWindow.openNow` 在窗口内为 true、窗口外为 false（同一时间点注入同一 `now` 做双向断言） | A |
| 35 | F04-10 | 启用计划后手工触发提交，在窗口外 → 任务态 `waiting_human`、`trigger='plan-window'`，且 **`plan_id` 非空** | A |
| 36 | F04-10 | `collection_plan` **没有** `next_run_at` 列（`PRAGMA table_info` 断言） | A |
| 37 | 迁移 | `SCHEMA_VERSION === 34`；新库 `PRAGMA user_version === 34`；从 v33 老库升级后同样 34（沿用 `tests/run.mjs:1921,4444` 的既有姿势） | A |
| 38 | 迁移 | 五张新表存在且列名与 §2 逐列一致（`PRAGMA table_info` 断言）；`collection_task` 新增 **14** 列 | A |
| 39 | 迁移 | 老库（v33、有既有任务行）升级后：既有任务行 `attempt = 1`，14 个新列中除 `attempt` 外**全部为 NULL**；既有任务在页面上的状态标签与升级前一致 | A |
| 40 | 迁移 | **旧数据不被改写**：升级前后 `collection_task` 既有行的 `id/status/submitted_at/result_json` 逐行相等 | A |
| 41 | 注册表 | `TOOLS.length === buildTools().length === 83`，且 `tests/run.mjs` 里 `routeTools.length` 的字面量已同步为 83 | A |
| 42 | 注册表 | 12 个新工具名**均不含** `publish|apply|push|deploy`（沿用 `index.js:366-369` 的守卫口径） | A |
| 43 | 路由 | 8 条新路由都能在裸 host 桩上注册并被调用（沿用 `tests/run.mjs:9089` 的 `routeTools` 桩法） | A |
| 44 | 路由 | 7 条 `POST` 路由**每条都产生一行 `audit_log`**（`pageWrite` 包过），且响应体不含任何凭据明文 | A |
| 45 | 页面 | 采集面板的六个新挂载点都非空渲染（`M`：截图 `#panel-collect`）；空库时每个挂载点显示空状态文案而不是空白 | M |
| 46 | 页面 | `GET /api/state` 的响应在 200 个任务的库上 **≤ 120 KB**（§3 上限），且 `collectPanel.selectedTask` 不含节明细 | A |
| 47 | 回归 | 既有 777 条断言**一条不红**；断言总数只增不减 | A |
| 48 | 端到端 | 真实 Chrome 上对一个真实 ASIN 跑一次 13 节采集，逐节状态可读、风控页不被写成产品 | **R（P5，本批不承诺）** |

---

## 9. 开放问题（`unverified`，不许在实现里赌）

| # | 问题 | 现在知道什么 | 谁在跟 / 何时 |
|---|---|---|---|
| **O1** | `node:sqlite` 内置的 SQLite 版本是否 ≥ 3.35（决定 `ALTER TABLE … DROP COLUMN` 能不能用） | 本机 Node 版本**未实测**；`schema.js` 全文没有用过 `DROP COLUMN`，所以没有先例可依 | Fullstack 在写迁移前跑 `SELECT sqlite_version()` 确认；若 < 3.35，回滚改走「重建表」路线（§2.8 已给） |
| **O2** | 13 节口径三份材料不一致（`04-采集中心.md` §3 的 13 项 vs 需求文档 §18.3 的合并写法 vs 原型徽章） | 本批按 `04-采集中心.md:19-35` 实现；原型里的「QA」节在文档 13 节里**没有位置** | **上报 PM 裁决**（G2 门禁项）；本批实现不变更，等裁决 |
| **O3** | 「需要登录的字段」是哪几节 | 需求文档 §4.4 列了这项预览，但没给节级清单；`collection_scheme.requires_login` 是方案级不是节级 | 本批按保守假设（`aplus`/`reviews` 需登录）+ 页面标注；Ops 复核后修订 |
| **O4** | 代理池（§4.1 第 9 项）在本仓**没有实现**，是从原型「代理池 18/20」来的 | `registry.js:36-39` 无代理字段；`collector.js` 无代理设置 | 本批 `09-proxy` 恒为 `unknown` + 明示「本版不走代理」；**要不要做代理是另一个决定，不进本批** |
| **O5** | 「质检节/QA 节」在原型的 `partial 47/63` 是什么口径 | 原型 `04-collect.html:193` 提到「QA 节 partial：47/63 条」，13 节里没有这一节 | 与 O2 合并裁决 |
| **O6** | 真实浏览器的 13 节可采性（哪些节在前台页面真的拿得到） | `KNOWN_FIELDS`（`registry.js:36-39`）只有 10 个扁平字段，说明现有采集器**只覆盖 basic 的一部分** | R 项，P5；本批只保证「拿不到时状态诚实」（`missing` vs `failed`） |
| **O7** | 站点级冷却的时长来源（`risk_json` 里写多少分钟） | `pacingSettings`（`src/store/settings.js`）今日无冷却字段 | 本批用 `collection_plan.cooldown_minutes` 默认 60；**要不要加全局 `pacing.cooldownMinutes` 设置项，交给 Ops/PM** |

---

## 10. 风险与回滚

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| 1 | **迁移不可逆点**：v33 → v34 后，旧代码读新库（`user_version = 34`）会怎样 | 旧代码不认识新列/新表；`PRAGMA user_version` 高于期望 → 最坏是静默忽略新列（不报错），最坏中的最坏是后续迁移假设从 33 开始而**重复跑 34** | ①迁移前**备份 `data/amazon-ops.db`**；②34 的 SQL 全部 `IF NOT EXISTS`，重复跑**不报错**（幂等），但 `ALTER TABLE ADD COLUMN` 重复跑会报 `duplicate column name` —— **这是本批唯一的幂等缺口**，接受它并写进交接条；③回滚必须连库一起回滚 |
| 2 | **采集器端到端未实测** | 13 节里可能有多节在真实页面上永远拿不到；`missing`/`failed` 的判据可能在真机上给出错误答案 | 本批只做「拿不到时诚实」，不承诺真机覆盖；48 号验收标 **R**，进 P5；`amzn_collect_doctor`（既有）是排查入口，节级 `selector_hits_json` 复用它的同款命中表 |
| 3 | **与 WorkBuddy 侧模块 08/06 的 schema 版本号顺序** | B-08.1 落了 v33（`4dbb48e`）；B-08.2（F08-04 所有权工作台）下一步可能也占 34 → **两个批次同号** | 按 `docs/COORDINATION.md:111` 的既定纪律：**版本号不重排，后合的一方改成 `main 当前最大 + 1`**，内容一字不改。本批先在 `MIGRATIONS` 尾部留一行合并警告（照 `schema.js:2175-2176` 的写法）。**`SCHEMA_VERSION` 的断言用的是属性不是字面量，所以重编号不需要改断言**（已实测：`run.mjs:1921,4444,5345,7239` 全是 `SCHEMA_VERSION`） |
| 4 | **`tests/run.mjs:9106` 的 `equal(routeTools.length, 71)` 是硬字面量** | 工具数变 83 但断言没改 → 777 条全绿里第一条红，且报错信息只说明「数字不对」，容易误判成注册漏了 | 契约里点名这一行必须改（§6.1）；**这是本批唯一需要改字面量的既有断言** |
| 5 | `TASK_COLUMNS`（`queries.js:649-655`）漏列 | 新列写了但更新不进去，**静默失败**：页面永远空 | 列白名单与 §2.3 的表**逐列对齐**写成一条断言（验收 38 覆盖列存在，另需一条断言「patch 每一列都能落库」） |
| 6 | `waiting_human` 超时靠 `GET /api/state` 触发 | 没人打开工作台就永不超时（没有常驻定时器） | **这是设计选择，不是缺陷**，写进交接条：超时语义是「下次有人看的时候到期即取消」，`since` 存的是真实时刻，所以取消时刻可以晚于 `deadlineAt` |
| 7 | 13 节明细让库变大 | 200 ASIN × 13 节 × 每节最多 64 KB >> 当前 68 MB 的库 | ①同节去重（`UNIQUE`）；②`includeRaw` 默认 false；③单节 64 KB 上限；④若实测增长过快，改为「只对 `partial`/`failed`/`blocked` 保留 raw」并记入交接条 |
| 8 | 页面新增 6 个挂载点、`page.js` 是 30 万字符单文件 | 一次改动面很大，容易漏渲染 | 每个挂载点必须有**空状态文案**（验收 45）；渲染器一律走 `PANEL_RENDERERS`，不写 `else renderX()` 兜底（`plugin-contract.md:236` 的既有教训） |
| 9 | 方案 `verify` 会真的打开浏览器并采一次 | 可能触发风控 | ①`verify` 只采 **1 个 ASIN × 最小节集**（默认 `basic`）；②走同一个 gate（`collection.js:296`）与同一套 pacing；③`confirm` 必填 |
| 10 | 回滚方式 | — | **代码**：`git revert` 单 commit。**数据**：四张新表 `DROP`（数据丢失，不可逆）+ 备份库还原。**老数据**：14 个新列 `DROP COLUMN`（O1 待确认）或重建表 |

---

## 11. 契约变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-10-03 | 首版 | 覆盖 F04-01…F04-10；schema v34；新增 5 张表、14 列、12 个工具、8 条路由 |
| 2026-10-03 | 工具数笔误修正 | §0 标题与 §6.2 小标题原写「+11」，逐项清点后是 **12 个**（§6.2 结尾已给清单）。以 **TOOLS 71 → 83** 为准，`tests/run.mjs:9106` 的字面量改 **83** |
| 2026-10-03 | `done` vs `completed` | 保留落库值 `done`，页面标签「完成」；**不做全表改名**（不可逆且会让既有断言集体变红）。§5.1 已写明这是决定不是遗漏 |

---

## 12. G2 设计门禁自检（逐条）

| G2 清单项（`product-team-process` §2） | 本契约的落点 | 结论 |
|---|---|---|
| 每条需求有对应流程 | §5 状态机（F04-05/06）、§6.4 五级链（F04-08）、§4.2 节状态（F04-07）、§2.2 窗口判定（F04-10） | ✅ |
| 每条需求有线框 | §7 逐区对照原型 `04-collect.html`（含「计划采集」原型未画，已标明） | ✅（一处原型缺口已标注） |
| 每个接口有契约（入参/出参/错误码） | §6.2 十二个工具 + §6.3 八条路由 + §4.4 节级形状，逐条给了 required 与错误码 | ✅ |
| 数据变更带迁移与回滚 | §2.7 追加式 SQL + §2.8 回滚表 + 老数据处理（不动） | ✅ |
| 非功能要求有数字 | §3 十项数字（耗时/上限/超时/并发/保留期/载荷） | ✅ |
| 不可逆决定各有一份 ADR | **⚠️ 缺**：本批有三条不可逆或难逆的决定需要独立 ADR，本契约只给了「可逆性 + 回头代价」摘要 | ❌ **未通过**，见下 |

**G2 未通过项（如实记录，不粉饰）**：

1. **缺 3 份 ADR**（架构师下一动作）。每条一个文件，序号接着现有 `ADR-*.md` 取最大 +1。**已实测**：`wt-dsh-w1\amazon-ops\docs\architecture\` 下只有 `API-W1-wiring.md`，主工作树的 `amazon-ops\` **没有 `docs\architecture\` 目录**，`D:\deepseek-harness-h\workspace\` 下 glob `ADR-*.md` 为零命中 → **本仓目前没有任何 ADR，序号从 `0001` 起**（`verified`）。
   - `ADR-00xx-collection-scheme-versioning`：方案做成版本化资产（追加行、不原地改）——不可逆点：一旦任务引用冻结版本号，方案就不再有「当前值」这个可改的语义。
   - `ADR-00xx-collection-section-baseline`：13 节以 `04-采集中心.md` §3 为准，**不复用** `listing-fields.js` 的 11 节——不可逆点：节 id 一旦落库，后续改口径就是一次数据迁移（对应 O2）。
   - `ADR-00xx-collection-human-in-the-loop-timeout`：`waiting_human` 的 30 分钟超时**不由定时器驱动**，而由「打开工作台」驱动——不可逆点：无（**可逆**），但它是「本批不做调度器」这条非目标的唯一凭据，必须有据可查。
2. **O2 / O3 / O4 需要 PM 或 Ops 裁决**才能消掉「待确认」。门禁不放水：这三条不裁决，F04-07 的节清单与 F04-03 的预览第 5 项就是**按假设实现**的。
3. **第 48 条验收（真实浏览器端到端）本批不承诺**，已在非目标 §0.2-1 写明，不计入 G2 通过条件。

**架构师给主理人的裁决请求**：①裁决 O2 的 13 节口径；②授权我用 3 份 ADR 收口上表 1 的三条决定；③确认 B-04 的 v34 号在合并窗口内的重编号纪律（§10-3）。
