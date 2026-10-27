# B-13c 策略阶段与位置计划核对 · 接口契约（G2）

> **日期**：2026-10-12 ｜ **作者角色**：架构师（由全栈开发代拟，G2 由主理人裁决）｜ **状态**：**草稿 → 待 G2**
> **关联需求编号**：F13-05（策略阶段：先策略后文案 + 人工确认）、F13-06（位置计划核对：继承 08，不产生第二份口径）
> **关联需求文档**：`docs/requirements/RESEARCH-module-alignment-v2.0.md` §3.13 模块 13 的两行（:350、:351）
> **关联协同**：`docs/COORDINATION.md` §7.3「B-13 剩余」一行（:2474）
> **体例参照**：`docs/architecture/API-B13b-optimize-inbox.md`（本仓上一批）
> **基线（开工前实测）**：`main 1a04e30`，`SCHEMA_VERSION` = **41**（`node scripts/check-migrations.mjs` → `{"count":41,"SCHEMA_VERSION":41,"dups":[],"continuous":true}`），`TOOLS` = **122**，`node tests/run.mjs` = **1598 passed / 0 failed**
> **本批目标**：schema **v42**，`TOOLS` 122 → **124**（**+2**，两个只读工具）
> **证据等级**：本文「现状」一节每条都在本次作业中对着 `src/` 实测（`read`/`grep`/`node`），标 `verified`；引用需求文档的标 `documented`。

---

## 0. 范围与非目标

### 0.1 这一批做什么

| 功能点 | 本批交付的深度 |
|---|---|
| F13-05 策略阶段 | 按 run 生成的**九项策略卡**（目标用户 / 核心差异化 / 购买疑问 / 事实边界 / 关键词优先级与所有权 / 字段分工 / 保留内容 / 风险待确认 / 修改幅度），每项带**来源 / 判据 / 事实**三要素，且「本仓没有这一项」「这一轮没有输入」「读过了答案是 0」三句分开；**「人工确认后进入生成」的门禁**（未确认 → `amzn_optimize_validate` 的 persist 与 `amzn_optimize_save` 都拒，`STRATEGY_UNCONFIRMED`）；页面策略卡 + 确认按钮 |
| F13-06 位置计划核对 | 在 prepare 时**继承模块 08 的持久位置计划**（`keyword_plan` / `keyword_plan_entry`，schema v35）并把 `planId / lineageId / version` 记在轮次上；产出**本轮建议计划**（08 的位置词表，不是 13 自己的十二个埋词位置）；人工「采纳并写回 08 新版本」/「不采纳」；写回走 `savePlan`（08 的唯一持久层），写回后**读回对账** |

### 0.2 这一批明确不做（非目标）

1. **不新建第二个位置计划持久层**。位置计划的唯一持久层是模块 08 的 `keyword_plan`（`src/store/keyword-plan.js`）。本批**不新增**任何 `INSERT INTO keyword_plan` 的写入点：写回走 `savePlan`，与 `amzn_keyword_plan_save` 工具、页面「存一版」路由是**同一个函数**。
2. **不改模块 08 的位置词表**（`PLAN_POSITIONS` 八个，`src/domain/states.js:434`）。13 的十二个**埋词位置**（`EMBED_POSITIONS`）是另一个对象（可写文案的表面），本批用**一张声明式的映射表**把两者接上，映射表是唯一的一处；映射不到的 08 位置（`adsExact` / `adsPhrase` / `adsBroad` / `negatives`）**逐条报出来**，不静默丢弃。
3. **不做字段级决策四选**（F13-07）、**不做 F13-08 校验体系**、**不做 F13-09 交付边界**。
4. **不新建「目标用户」的数据源**。全库实测没有任何 persona / audience / 目标用户 的列、表或读取口 —— 本批**不发明**它，策略卡第 1 项逐字写「本仓没有这一项的结构化来源」（§4.1）。
5. **不引入调度器**，不加定时器；「人工确认」是人在页面上点一次。
6. **不删任何列、不删任何既有表**；`optimization_run` / `optimization_draft` / `keyword_plan` 的既有语义不变。
7. **不碰** `src/sources/**`、`src/domain/collect/**`、`src/domain/asin/**`、`src/domain/prompts/**`、`src/store/prompt.js`、`src/tools/prompt.js`。
8. **不做真机采集**。

---

## 1. 现状复核（逐条 `verified`）

### 1.1 F13-05 今天有什么、缺什么

| 现状 | 证据 |
|---|---|
| 三层 assemble 提示词（fixed / evidence / contract） | `src/domain/optimize/prompt-seed.js:165-209` |
| prepare 取用并写进 run.package | `src/tools/optimize.js:591-598`、`:653-658` |
| 页面「优化提示词专区」可编辑 | `src/web/page.js` 的 prompt 面板 |
| 空库时明确告警 | `optimize.js:703-704`（`writing.length === 0` 分支） |

**缺口**（与审计 :350 逐条对齐）：九项策略卡、人工确认门禁、页面策略卡。**实测确认**：全库 `grep` 无 `strategy` 的领域模块，`optimization_run` 无策略相关列。

### 1.2 F13-06 今天有什么、缺什么 —— 以及审计那句话的**订正**

| 现状 | 证据 |
|---|---|
| prepare 先于任何文案生成地建计划 | `optimize.js:566`（`buildGlobalPlan`） |
| 只存**计数** | `optimize.js:623`（`plan: { positions, plannedCells }`） |
| 位置权重表 | `src/domain/optimize/plan.js:65-90`（12 个） |
| 覆盖矩阵在面板 / 报告显示 | `src/domain/optimize/run-view.js:118-128` |

**订正（本批实测，`verified`）**：审计 :351 写的「模块 08 未建」「计划本身不落库」**对 F08-05 已经过期**。模块 08 的**应用层位置计划持久层已经存在**：

| 事实 | 证据 |
|---|---|
| 表 `keyword_plan` + `keyword_plan_entry`，schema **v35** | `src/store/schema.js:2362` 起；`PRIMARY KEY (plan_id, keyword_key)` |
| 唯一持久层，版本族 + 版本号 | `src/store/keyword-plan.js:414`（`savePlan`，`lineage_id` / `version`） |
| 位置词表八个，一位一用途 | `src/domain/states.js:422-434`（`PLAN_POSITION_PURPOSES` / `PLAN_POSITIONS`） |
| 五个工具（读四写一） | `src/tools/kw-plan.js`；`index.js:351-355` 与 `src/tools/index.js:351-355` 两处注册 |
| 页面已接线（总库面板「存一版」） | `src/web/routes.js:1691`（`POST keyword-plan` → `savePlan`）、`:3476-3491`（planSlice） |
| 13 与 08 的分工**已经写在代码里** | `src/store/keyword-plan.js:21-24`：「位置计划的唯一持久层在模块 08；13 只引用与冻结，不产生第二份口径。」 |

**所以「无法继承」这个结论不成立 —— 08 那一半今天存在。** 真正缺的是三件：
① 13 的 prepare **没有读** 08 的计划（连 `planId` 都没记）；
② 没有「本轮建议计划」的人工确认与写回 08 新版本；
③ 13 存的是**自己那份十二位置的计数**，与 08 的八位置计划没有对账，因此「不产生第二份口径」无法被证明。

**仍然不存在的**（本批照实说，不造）：08 的 `attributes` / `negatives` 两个位置在 13 的埋词位置里**没有对应物**（13 的 `attributes` 是可写字段位置，语义不同，见 §5.2）；广告三位置（`adsExact` / `adsPhrase` / `adsBroad`）在 listing 文案里**无法核对**（08 自己也是这么说的：`keyword-plan.js:155` `CHECKABLE_POSITIONS`）。

---

## 2. 数据模型变更（schema v41 → v42）

### 2.0 版本号与追加纪律

- `SCHEMA_VERSION` 由 `MIGRATIONS` 末项的 `version` 派生（`schema.js:3040`），无字面量；开工时实测为 **41**（探针原文见 §7），故本批用 **42**。
- **只在 `MIGRATIONS` 数组尾部追加一个 `version: 42` 的对象**，不改动、不重排 1–41。
- 迁移体全部是 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`（幂等），**不加列、不删列**。

### 2.1 新表 `optimization_strategy`（F13-05）

```sql
CREATE TABLE IF NOT EXISTS optimization_strategy (
  run_id       TEXT PRIMARY KEY REFERENCES optimization_run(id),
  built_json   TEXT NOT NULL,      -- prepare 建出来的九项（**永不改写**）
  items_json   TEXT NOT NULL,      -- 当前生效的九项（人工可改；未改时与 built_json 逐字相同）
  confirmed_at TEXT,               -- NULL = 未确认（不是「确认时间未知」）
  confirmed_by TEXT,               -- 'page' | 'agent' | …（署名；谁确认的）
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

**为什么没有 `status` 列**：`confirmed` / `unconfirmed` 由 `confirmed_at` 是否为空**重算**（`strategyGate`），`edited` 由 `items_json !== built_json` **重算**。写入方自报状态、读者另算，是本仓刚修过的反例（B-13b §2.1 同一条理由）。

**为什么 `built_json` 与 `items_json` 分开**：确认时可以改文字（人工确认不是橡皮图章），但「这一轮一开始给的是什么」必须还读得出来 —— 报告与审计问的是后一个问题。两者相等即未改，这个判断**从内容算得出来**。

### 2.2 新表 `optimization_plan_check`（F13-06）

```sql
CREATE TABLE IF NOT EXISTS optimization_plan_check (
  run_id          TEXT PRIMARY KEY REFERENCES optimization_run(id),
  plan_id         TEXT,            -- 继承自 08 的 keyword_plan.id；NULL = 当时**没有**计划
  lineage_id      TEXT,            -- 版本族
  version         INTEGER,         -- 继承到的那一版
  entries_json    TEXT NOT NULL DEFAULT '[]',  -- 本轮建议计划（**08 的位置词表**）
  uncovered_json  TEXT NOT NULL DEFAULT '[]',  -- 本轮有、计划没决定的词
  unmapped_json   TEXT NOT NULL DEFAULT '[]',  -- 08 的位置里没有 13 埋词对应物的
  accepted_at     TEXT,            -- NULL = 未采纳（不是「采纳时间未知」）
  declined_at     TEXT,            -- NULL = 未否决
  decided_by      TEXT,
  written_plan_id TEXT,            -- 写回 08 产生的新版本 id；NULL = 没有写回
  written_version INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

**没有 `status` 列**：`absent`（无行）/ `none`（有行、`plan_id IS NULL`）/ `inherited`（有行、有 `plan_id`）由行本身重算；`pending` / `accepted` / `declined` 由两个时刻戳重算；「已写回」由 `written_plan_id` 重算。

**`entries_json` 为什么不是「第二份计划」**：它是**一轮的提案快照**（08 的计划 ∩ 本轮关键词），权威仍在 `keyword_plan`。这一点由三件事保证，且都是机器可查的：① 本批没有任何一处直接 `INSERT INTO keyword_plan`（写回唯一走 `savePlan`）；② 行里记着**继承自哪一版**与**写回成哪一版**；③ 写回后**读回 `getPlan`** 与提交的内容逐条对账（§5.3）。

### 2.3 迁移与回滚

- **迁移**：`version: 42`，两条 `CREATE TABLE IF NOT EXISTS`。已有库平滑升上去：两张新表为空（= 这个库还没有策略卡与计划核对，页面必须说「没有」而不是「未确认」）。
- **回滚**（原文）：

```sql
DROP TABLE IF EXISTS optimization_plan_check;
DROP TABLE IF EXISTS optimization_strategy;
```

回滚**丢数据**：九项策略卡与计划核对记录会消失；`optimization_run` / `optimization_draft` / `optimization_evidence` / `keyword_plan` 都不受影响。回滚**不删** 08 写回产生的计划版本 —— 那些行属于模块 08，由 `keyword_plan` 自己的版本纪律管。
- **可重复执行**：两条都是 `IF NOT EXISTS`，幂等。

---

## 3. 三态词表（本批全批共用，防止「没有」被压成一个空值）

| 词 | 含义 | 机器可检查的形式 |
|---|---|---|
| `derived` | 有来源，读过了。**事实数可以是 0** —— 0 是发现 | `source` 非空 |
| `absent` | 这一类建模了，但**这一轮没有输入**（没有 listing / 包里没有关键词） | `facts.length === 0`，`note` 非空，`source` 非空 |
| `not_modelled` | **本仓没有这一项/这一类的来源** | `source === null && facts.length === 0`，`note` 非空 |

「读过了、答案是 0」（`derived` + 空事实）与「没有可读的东西」（`absent`）与「本仓没有」（`not_modelled`）**在列上就分得开**。

---

## 4. F13-05 策略阶段 · 接口

### 4.1 九项策略卡

唯一实现在 `src/domain/optimize/strategy.js`：

```js
STRATEGY_ITEMS: [ { id, label, question, why } × 9 ]
buildStrategy(store, ctx) -> [ { id, label, question, status, source, facts: [{name, value, at}], text, note } × 9 ]
strategyGate(row)         -> { open, state, code, reason }
readStrategy(store, runId)
writeStrategy(store, runId, items, { now })
confirmStrategy(store, { runId, items, by, now })
```

九项与各自的来源（**本批实测**）：

| # | id | 项 | 来源 | 这一轮可能是 |
|---|---|---|---|---|
| 1 | `audience` | 目标用户 | `MANUAL_FIELDS.target_audience` —— **声明了字段，不存值**（类目属性，按 PTD 在后台选） | 恒 `absent`（缺的是**值**不是概念），并写明「由人提供，之前必须标为待人工确认」 |
| 2 | `differentiation` | 核心差异化 | `buildFactLedger` 的事实行（尺寸 / 重量 / 属性）+ `currentLineVersion` + `brand` | `derived` / `absent`（对象不在库里） |
| 3 | `buyer_questions` | 购买疑问 | 本轮关键词里**问句形式**的词（`lexiconFor(marketplace).questionRe`）+ `qa` 埋词位 | `derived`（0 个问句词也是发现）；QA 通道**本仓没有**，逐字说明 |
| 4 | `fact_boundary` | 事实边界 | `needsConfirmation(field)` 的字段 + `MANUAL_FIELDS` + 事实台账冲突 | `derived` |
| 5 | `keyword_priority` | 关键词优先级与所有权 | `plan.allocation`（tier / owner / supporting）+ `titleCapacity` + 分配冲突 | `derived` / `absent`（本轮没有关键词） |
| 6 | `field_split` | 字段分工 | 模式作用域 `spec.fields` + `LINKAGE_GROUPS` + `POSITION_FIELDS` | `derived` |
| 7 | `preserve` | 保留内容 | **不在**本轮作用域内的字段 + 本轮无违规且无缺口的字段 | `derived`（没有当前文案时两列写「未知」而不是 0） |
| 8 | `risks` | 风险待确认 | `precheck` 里非 pass 的门 + 事实冲突 + 分配冲突 + `LLM_ONLY_CHECKS` | `derived`（可以是 0 条 —— 「这一轮没有待确认风险」是一句结论） |
| 9 | `magnitude` | 修改幅度 | 模式预算（`spec.budget.allowed / total / ratio`）+ `spec.generates` | `derived` |

**第 1 项的订正（实测）**：审计只写了「目标用户」这四个字，本批查证后发现本仓**确实声明**了这个字段
（`domain/rules/listing-fields.js:185` 的 `target_audience`，在 `MANUAL_FIELDS` 里，注释是「类目属性，
需按 PTD 选择」）。所以它不是 `not_modelled`（本仓没有这一项），而是 `absent`（建模了，但没有可读的
输入）—— **缺的是值，不是概念**。把这两个说成一句话，正是本仓反复付代价的那种压缩。

**每项都有 `source` 与 `facts`**（三要素的等价物：来源 / 事实 / 判据），`not_modelled` 的 `source` 为 `null`。

### 4.2 门禁：人工确认后进入生成

**门在哪**：本插件**不生成文案**（`src/tools/optimize.js:9-15` 的模块头）。所以「进入生成」在本仓唯一能被强制执行的落点是**草案进入这一轮的那一刻**：

| 动作 | 未确认时 |
|---|---|
| `amzn_optimize_validate`（`persist: true`） | 拒：`{ ok:false, code:'STRATEGY_UNCONFIRMED', gate:{…}, error, hint }` |
| `amzn_optimize_validate`（不 persist） | **放行** —— 校验是只读的，拦它只会让人不敢试 |
| `amzn_optimize_save` | 拒：同上。save 是出报告与（可选）改 listing 的那一步 |

**门禁的次序（实测踩出来的）**：策略门排在**幅度门（`OPTIMIZE_INCREMENTAL_OVER_BUDGET`）之前** ——
「能不能进这一轮」比「这一轮改多少」更靠前。`tests/b13-precheck.mjs` 里测幅度那一条因此先确认策略，
让拒绝来自幅度而不是门禁；断言本身一字未改。

**为什么拦这两处而不是拦 prepare**：拦 prepare 等于没有策略卡可确认；拦「生成」在本仓没有可拦的对象。这两处是草案真正**进入这一轮**的地方。

**`absent` 不放行也不拦错人**：本批之前建的轮次没有策略行 → `strategyGate` 返回 `open: true, state: 'absent'`，并且**明说**「这一轮没有策略卡（本批之前建的轮次），所以没有可确认的东西」—— 不谎报「已确认」。

**确认怎么写**：`confirmStrategy(store, { runId, items, by, now })` —— 页面 `POST /api/optimize-strategy-confirm` 用 `by: 'page'`。写完**读回那一行**、重算 `strategyGate`，与「按内容它应当是 confirmed」比对；不一致 → `STRATEGY_STATE_MISMATCH`，不谎报成功。

**幂等**：已确认再确认 → `unchanged: true`（不改时刻戳，除非 `items` 真的变了）。

### 4.3 工具 `amzn_optimize_strategy`（只读）

**入参**：`runId`（必填）。

**出参**（`ok: true` 时）

```
{
  ok: true,
  runId, asin, marketplace, status,
  present: boolean,                  // 有没有策略行（false = 本批之前建的轮次）
  confirmed: boolean, confirmedAt, confirmedBy,
  edited: boolean,                   // items_json !== built_json，由内容重算
  gate: { open, state, code, reason },
  counts: { items: 9, derived: n, absent: n, notModelled: n },
  items: [ { id, label, question, why, status, source, facts, text, note } ],
  empty: { kind, text } | null
}
```

### 4.4 错误码（F13-05）

| code | 触发 |
|---|---|
| `STRATEGY_NO_RUN` | `runId` 不存在 |
| `STRATEGY_UNCONFIRMED` | 未确认就想 persist / save |
| `STRATEGY_STATE_MISMATCH` | 确认后读回重算的状态与内容不符 |
| `STRATEGY_UNKNOWN_ITEM` | 确认时给了九项以外的 id |

---

## 5. F13-06 位置计划核对 · 接口

### 5.1 继承：读 08，不另算

唯一实现在 `src/domain/optimize/position-plan.js`：

```js
PLAN_POSITION_EMBED: { [08 的 position]: 13 的埋词位置 | null }   // 唯一的一处映射
inheritPlan(store, { asin, marketplace, keywords }) -> {
  status: 'inherited' | 'none',        // 'none' = 这个 ASIN 一份计划都没有（≠「计划里 0 个位置」）
  planId, lineageId, version, versionCount,
  entries,                             // 08 的位置词表；**只取本轮关键词命中的**
  uncovered,                           // 本轮有、计划没决定的词
  unmapped,                            // 08 的位置里没有 13 埋词对应物的（ads* / negatives）
  source, at, note
}
```

- 读的是 `listPlans` / `getPlan`（`src/store/keyword-plan.js`）—— **只读，prepare 不写 08 的任何一行**。
- 关键词匹配用 `keywordKey`（`src/domain/keywords/key.js`）的**同一个折叠尺**，与 `keyword_plan_entry` 的主键一致。
- `status: 'none'` 时 `entries` 是空数组**且** `note` 说明「这个 ASIN 还没有位置计划，用 amzn_keyword_plan_propose / _save 先建一份」—— 「没有计划」与「计划里 0 个位置」是两句不同的话。

### 5.2 映射表（不产生第二份口径的机制）

| 08 的位置 | 13 的埋词位置 | 说明 |
|---|---|---|
| `title` | `title` | 同名同义 |
| `bullets` | `bullets` | 同名同义 |
| `backend` | `search_terms` | 08 叫「后台搜索词」，13 叫 `search_terms` —— 同一个落点，两个词表各用各的拼法 |
| `attributes` | **`null`** | 08 的 `attributes` 是「这个词要不要进属性字段」（无资格规则、人工判断）；13 的 `attributes` 是一个**可写字段位置**。语义不同，**不接**，逐条报进 `unmapped` |
| `adsExact` / `adsPhrase` / `adsBroad` | **`null`** | 广告后台，listing 文案里无法核对（08 自己也是这么标的） |
| `negatives` | **`null`** | 后台否定词，同上 |

`unmapped` 逐条列出**位置 + 条数 + 理由**，不静默丢弃。

### 5.3 本轮建议计划 + 人工确认 + 写回

- **建议计划** = 继承到的 `entries`（08 的位置词表）+ 每条一个 `roundChange`：`unchanged` / `owner-moved`（08 的主人位置与本轮 `allocation` 的埋词主人对不上）/ `not-comparable`（08 的位置没有对应埋词位置）/ `plan-only`（计划里有、本轮包里没有这个词）。
  **不新增** 08 词表以外的位置，也不为本轮没决定的词编一个位置 —— 那些词进 `uncovered`。
- **两个 0 分开**：「本轮没有建议计划」（计划有内容，但这一轮一个词都没被它决定过）与
  「计划里有 0 个位置」（继承到的那一版本身就是空的）都会让 `entries.length` 是 0，
  所以继承到的那一版**有多少条**单独读出来（`inherited.entryCount`，从 `plan_id` 钉住的那一版
  重新 `getPlan` 读出 —— `keyword_plan` 是追加式、永不修改的，所以那是当时那一版的条数，
  不是「今天的样子」），并由领域层给出 `suggested.note` 说清是哪一种。读不到那一版时
  `entryCount` 是 `null`（= 读不到），不是 `0`。
- **确认**：
  - `accept` → `savePlan(store, { asin, marketplace, entries, source: 'agent', lineageId, createdBy })` —— **08 的唯一持久层**，写成一版**新版本**（旧版不动）。写完 `getPlan(newId)` **读回**，逐条核对：族相同、版本 = 继承版本 + 1、条目数与关键词集合一致；不一致 → `PLAN_CHECK_MISMATCH`，并且**如实报告已写入的那一版**（不谎报成功，也不假装没写）。
  - `decline` → 写 `declined_at`，**不写 08**。
- **幂等**：已采纳再采纳 → `unchanged: true`；已否决后采纳 → 允许（更晚的意图），但会**再追加一版**并如实报告版本号。
- **写回失败不吞**：`savePlan` 抛（重复词 / 位置不在词表 / 复现位没理由）→ 原样透传 `PLAN_CHECK_WRITE_REFUSED` + 08 的原话，`accepted_at` **不写**。

### 5.4 工具 `amzn_optimize_plan_check`（只读）

**入参**：`runId`（必填）。

**出参**（`ok: true` 时）

```
{
  ok: true,
  runId, asin, marketplace, status,
  present: boolean,                 // 有没有核对行（false = 本批之前建的轮次）
  inherited: { status, planId, lineageId, version, versionCount, source, at, note },
  suggested: { entries: [...], uncovered: [...], unmapped: [...] },
  decision: { state: 'pending'|'accepted'|'declined', acceptedAt, declinedAt, decidedBy },
  writtenBack: { planId, version } | null,
  counts: { suggested, uncovered, unmapped, moved, unchanged },
  empty: { kind, text } | null
}
```

### 5.5 错误码（F13-06）

| code | 触发 |
|---|---|
| `PLAN_CHECK_NO_RUN` | `runId` 不存在 |
| `PLAN_CHECK_NOT_INHERITED` | 这一轮没有可写回的继承计划（`plan_id IS NULL`）就想采纳 |
| `PLAN_CHECK_WRITE_REFUSED` | `savePlan` 拒绝（位置不在词表 / 重复词 / 复现位没理由） |
| `PLAN_CHECK_MISMATCH` | 写回后读回对账不符 |
| `PLAN_CHECK_STATE_MISMATCH` | 决策写完后读回重算的状态与内容不符 |

---

## 6. 关键数字

| 项 | 开工前（实测） | 本批后 |
|---|---|---|
| `SCHEMA_VERSION` | 41 | **42** |
| `TOOLS` | 122 | **124** |
| 策略卡项数 | 0 | **9** |
| 新表 | — | **2**（`optimization_strategy` / `optimization_plan_check`） |
| 页面写路由（optimize 区） | 5 | **7**（+策略确认 +计划决策） |
| 08 位置 → 13 埋词位置的映射 | 0 | **3 接上 / 5 逐条报 unmapped** |
| `node tests/run.mjs` | 1598 passed / 0 failed | **1638 passed / 0 failed**（只增不改；被门禁挡住的既有调用点补上确认步骤，**不删不改任何断言**；新增 38 条断言在 `tests/b13c-strategy-plan.mjs`） |
| `node scripts/check-page.mjs` | 3/3 | **3/3** |

### 6.1 载荷契约变化（会打到既有夹具）

`data.optimizations` 多两块：`strategy`（九项 + 门禁 + 确认状态）与 `planCheck`（继承 + 建议 + 决策 + 写回）。
**页面不再自己推任何一条状态**：`status` / `gate` / `state` / `edit` 全部由服务端算好，页面只做 `buckets` 式的成员测试与渲染。

---

## 7. 探针原文（开工前）

```
$ node scripts/check-migrations.mjs
{"count":41,"SCHEMA_VERSION":41,"dups":[],"continuous":true,"last":"agent-config-and-requests","first":"initial-schema"}
迁移表自洽 ✓
```

```
$ node tests/run.mjs   （末尾）
1598 passed, 0 failed
```

---

## 8. 非目标（再次，防止被读成承诺）

见 §0.2。特别是：**不建第二个位置计划持久层**、**不发明「目标用户」的数据源**、**不做字段级四选**、**不做真机采集**。

---

## 9. 破坏性验证（真跑，回退 → 变红 → 改回）

四次证伪都在本 worktree 上真跑，改回之后逐字节校验一致（SHA-256）：

| # | 改坏什么 | 变红的是哪几条 | 说明了什么 |
|---|---|---|---|
| ① | `strategy.js#strategyGate` 改成恒 `open/confirmed` | `b13c-gate ⑦ ⑧ ⑨ ⑮ ⑯`、**`b13c-page ㉛`（页面载荷 `gate.state`）**、`b13c-wiring ㊱` | **把域层改坏 → 工具侧与页面侧同时红**：页面没有第二条可以自己算出来的路 |
| ② | `PLAN_POSITION_EMBED.adsExact` 改成 `'title'`（凭空造一个映射） | `b13c-plan ㉑`、**`b13c-page ㉛`（`suggested.unmapped.length`）** | 同一张映射表，两侧同源 |
| ③ | `page.js` 的 `<div id="optstrategy">` 改成别的 id（**改坏夹具**） | `b13c-page ㉜`（负向对照 `#optStrategyNothingHere` 仍绿） | 夹具坏了只有夹具那条红，判据没有连带失效 |
| ④ | 在 `position-plan.js` 里塞一句 `INSERT INTO keyword_plan`（第二份口径） | `b13c-plan ㉔` | 「写回唯一走 08 的 `savePlan`」这条守卫有牙 |

改回之后：`node scratch/run-b13c.mjs` → `37 passed, 0 failed`；三个文件与备份 SHA-256 逐字节相同
（`strategy.js CF90E231D5254C10…`、`position-plan.js 6DB2DC951B78EDF8…`、`page.js EEF0CCF545480C1A…`）。

---

## 10. 本批的实测订正与遗留（给主理人裁决）

### 10.1 需求文档 §3.13 :351 有一句已经过期（`verified`）

审计原文：「没有 08 应用层位置计划的继承——**模块 08 未建**，quick-actions.js:76-82 明说所有权工作台阶段 1 没建。」

**前半句对 F08-05 是错的**：模块 08 的位置计划持久层 **schema v35 就已经建了**
（`keyword_plan` / `keyword_plan_entry`、`src/store/keyword-plan.js`、五个工具、
页面「存一版」路由）。`quick-actions.js:89-91` 说的是**所有权工作台（F08-04 的交互面）**
阶段 1 没建，与 F08-05 的持久层是两件事。本批按实测事实实施继承，**没有改需求文档** ——
订正留给 PM / 调研（那是他们的交付物）。

### 10.2 「哪一版算当前」沿用了页面的读法，它本身值得再看一眼（`unverified`）

`listPlans` 的 `ORDER BY marketplace, asin, lineage_id, version DESC` 意味着：**同一个
(ASIN, 站点) 有多个版本族时，`[0]` 是「版本族 id 字典序最小的那个族的最新版」，不是
「最近创建的那一版」**。本批**刻意沿用**它（`inheritPlan` 与工作台总库面板用同一条读取），
因为另立一个「哪一版最新」的判据就是本批要消灭的第二份口径。

后果要说清：**多版本族时「当前计划」是任意的**。今天不影响任何断言（每个夹具只有一个族），
但这是一个真实的、属于模块 08 的遗留问题 —— 修它应该在 08 那一侧（比如按 `created_at` 排），
并由 08 的测试钉住，而不是在 13 这里加一条不同的规则。

### 10.3 没有做的验证

- **没有起工作台服务做浏览器端到端**。页面这一侧的证据来自：① 真实路由 handler 的返回
  （`b13c-page ㉛` 走 `callRoute` 打 `/api/state` 与两条写路由）；② 服务端渲染出来的 HTML
  用 `tests/html-dom.mjs` 解析（`b13c-page ㉜`）。这与 B-13b 的先例一致，但**不是**视觉验收。
- **没有真机采集**（本批不涉及）。
