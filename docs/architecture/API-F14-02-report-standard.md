# F14-02 优化报告标准（§28.2 摘要四字段 / 字段级置信度与风险 / 实际发布值 / §28.4 目录与证据跳转）· 接口契约（G2）

> **日期**：2026-10-19 ｜ **作者角色**：全栈开发（架构师缺位的部分由本契约显式声明，G2 由主理人裁决）｜ **状态**：**草稿 → 待 G2**
> **关联需求编号**：F14-02（优化报告标准，P0，模块 14 · 报告中心）
> **关联需求文档**：`docs/requirements/RESEARCH-module-alignment-v2.0.md` 的 F14-02 那一行（:437）
> **关联协同**：`docs/COORDINATION.md` §7.3（变更说明）
> **体例参照**：`docs/architecture/API-B13d-validation-and-delivery.md`（上一批）
> **基线（开工前实测）**：`main a14d2ca`（worktree `wt-f14-02` / 分支 `f14-02`）；
> `node scripts/check-migrations.mjs` → `{"count":46,"SCHEMA_VERSION":46,"dups":[],"continuous":true}`；
> `node scripts/check.mjs` → `OK amazon-ops (plugin: workbench) — 134 tool(s) registered`；
> `node tests/run.mjs` → **1901 passed / 0 failed**；`node scripts/check-page.mjs` → **3/3**；
> 孤儿守卫 `exported`/`unwired`/`越界`/`死条目` = 基线一致（`28/28/0/0`）。
> **本批目标**：schema **v47**；`TOOLS` **134 → 134**（**不新增工具**，把四个字段补进已有的报告中）；
> 断言 **1901 → 1920**（**+19，只增不减**，且不钉绝对数字之外的数字）。
> **证据等级**：§1「现状」每条都是本次作业对着 `src/` 与真库实测（`read`/`grep`/`node tests/probe-f14-02.mjs`），标 `verified`；
> 引用需求文档的标 `documented`。**本契约里没有 `unverified` 的结论。**

---

## 0. 范围与非目标

### 0.1 这一批做什么（审计点名的四件，逐件交付深度）

| 缺口 | 本批交付 |
|---|---|
| ① 摘要缺 §28.2 的 **数据截止 / Prompt 版本 / Agent 流程 / 草案状态** | 报告顶部新增 `## 报告头信息` 一节，**四行显式字段**，每行 `字段 ｜ 值 ｜ 这一格是怎么来的`。四格的值全部由库里那几行重算，两种渲染念同一份 `model.provenance.rows`。缺的两个落点用 **v47 迁移**补（`optimization_run.prompt_version` / `.agent_run_id`） |
| ② 字段级缺 **置信度 / 风险** | 逐字段块里一行 `置信度 <高/中/低>：<全部理由> ｜ 风险 <高/中/低>：<全部理由>`。判据是一张**规则表**（`standards.js#assessField`），输入全来自这一轮已有的内容 |
| ③ 缺 **实际发布值**，且要与 `publication_record` 对上、与草案值可对比 | 逐字段：`**实际发布值**（登记 …，草案版本 vN）` + `与本轮草案一致 / ⚠️ 不同 / 本轮未覆盖` 三态。第十二节新增 `### 12.3 实际发布值（从发布登记读回来）`：登记条数、**登记时冻结**的 §6 偏离判定、逐字段对比表 |
| ④ HTML 无 **目录导航 / 证据跳转** | HTML 顶部 `<nav class="toc">`（条目 = `model.sections`，与正文章节标题、锚点同源）；每一节 `<h2 id="sN">`；每个字段 `<h4 id="field-<field>">`；第八节的违规/跳过行链到那个字段；每个字段链到它依据的**证据类** `#ev-<kind>`；末尾新增 `## 附录、证据包（本轮冻结的十类）` 作为跳转落点 |

### 0.2 这一批明确不做（非目标）

1. **不新增任何工具**。四个字段进的是**已有的报告**（`amzn_optimize_save` 产出的 `report_md` / `report_html`），`TOOLS` 保持 **134**。两处注册表（`index.js` 的 `TOOLS` + `src/tools/index.js` 的 `buildTools`）**一个字节都没动**。
2. **不改 `page.js`**。报告是静态文档，目录与跳转都在文档内部（自包含，离线可读）；工作台页面这半（报告详情的侧栏导航）不在本批。
3. **不为「数据截止」加列**。它由这一轮**冻结的证据包**（`optimization_evidence.source_at`，v40）算。加列 = 给同一件事造第二份口径，而且是写入方自报的那一份。
4. **不为「草案状态」加列**。它由 `optimization_draft.accepted` 三态 + `optimization_run.draft_version`（v31）重算。同上。
5. **不重算 §6 的偏离判定**。`publication_record.deviation_json` 是**登记时冻结**的权威；报告只读它。逐字段的「发布值 vs 本轮草案」是**另一件事**，措辞分开写（见 §5.3）。
6. **不做自动发布**、**不碰 Seller Central**（§15 的发布边界不变）。
7. **不改字段注册表**（`domain/rules/**`）、**不改模块 12 的 agent_run 结构与写入口**（只读 `getRun`）。
8. **不删任何列、不删任何表**；v47 只加两列，回滚只删那两列。
9. **不回溯老轮次**。v47 之前建的轮次 `prompt_version` / `agent_run_id` 一律 NULL —— **不回填、不编造**（回填等于伪造「当时用的是这一版」）。

---

## 1. 现状复核（逐条 `verified`）

**先说清三种「没有」**：本批四个字段里，**没有一个是「本系统不支持」**。它们的差别是：

| 种类 | 含义 | 本批的处置 |
|---|---|---|
| **没建模** | 库里/代码里根本没有这一样东西的落点 | 只有两处，且都补了（v47 两列） |
| **没有记录** | 落点在，但这一轮没写值（NULL） | 报告如实说「这一轮没有记录」，并说明它不是「不支持」 |
| **数据是 0** | 读到了，答案是 0/空 | 报告印 0 并说明它是 0（例：登记 0 条） |

### 1.1 四件缺口今天（v46）各自是什么状况

| 字段 | 今天的状况 | 判定 | 证据 |
|---|---|---|---|
| **数据截止** | 报告只印「生成时间」（`new Date()`）。库里的日期来源**都在**：`asin_snapshot.collected_at`、`listing.updated_at`、`optimization_draft.updated_at`、`optimization_evidence.source_at`（v40 十类证据包，每类带自己的观测时刻） | **没建模**（报告没算），**不是没有数据** | 基线 `a14d2ca:…/report.js`：`数据截止` 0 命中；尾部只印 `生成时间`（基线 :824 / :1222 两处渲染）；`domain/optimize/evidence.js:31-37` 写明十类各自的 `at` |
| **Prompt 版本** | `optimization_run` **16 列，没有 `prompt_version`**；但 `package_json.prompts` 每层都带 `version`，`prompt` 表从 v38 起就有 `version` 列与活动版本机制 | **没有显式落点**（数据其实在包里） | 探针（`node tests/probe-f14-02.mjs`）输出：`prompt_version: 不在`；`package_json.prompts 层版本: fixed@v1 / evidence@v1 / contract@v1`；`store/prompt.js:695-747`（`resolvePrompts` 返回每层 `version`）、`tools/optimize.js:818-823`（prepare 把它冻进包） |
| **Agent 流程** | `optimization_run` 没有 `agent_run_id`；有 `session_id`（调用方传才有）；模块 12 的 `agent_run` 表**存在**（role / task_type / status / steps） | **没有引用列**，**不是没有这个机制** | 探针：`agent_run_id: 不在`、`agent_run 表: 在`；`store/schema.js:1913-1928`（agent_run） |
| **草案状态** | `draft_version` 在（v31），`accepted` 三态在；报告在「一、结论」印了 采纳/未采纳/待定 **三个数**，但**没有**草案版本那一句，也没有把三态收成「草案状态」这一个字段 | **部分有**：三个数在，版本不在报告里 | `store/schema.js:1995`（v31 `draft_version`）、`store/queries.js:1506-1516`（`setDraftAccepted` 是唯一递增点）、基线 `report.js:409`（三个数） |
| **置信度 / 风险** | 报告 0 命中；库里有 `asin_field_source.confidence`（每字段证据置信度），报告不用它 | **没建模** | 探针：`report.js 里 confidence 出现次数: 0`；`store/schema.js:432`（`confidence REAL NOT NULL DEFAULT 1.0`） |
| **实际发布值** | `publication_record` 有 `published_json`；但 `report.js` 里 `publication` 只出现 **3 次**，全是「入参 / 转交给 `buildDelivery`」—— `buildDelivery` 只用它算「已登记的字段」勾选，**从来没有人把发布的值印出来**；`computeDeviation` 0 命中 | **没建模** | `git show a14d2ca:…/report.js` \| 匹配 `publication` → 3 处（:184 入参、:272 注释、:284 转交）；`computeDeviation` 0 处；`store/schema.js:1997-2046`（publication_record 24 列） |
| **目录 / 证据跳转** | 13 个 `<h2>` **没有 id**，整份 HTML **0 个 `href=`**；证据包（十类）在库里、在 `amzn_optimize_evidence` 里，**报告里一个字都没有** | **没建模** | 基线源码统计：`<h2>` = 13、`href=` = 0、`id="` = 0；`domain/optimize/evidence.js` 十类只被工具/页面读 |

### 1.2 需求原文（`documented`）

> 「摘要缺 §28.2 要求的 数据截止/Prompt 版本/Agent 流程/草案状态 四个显式字段（`optimization_run` 无 `prompt_version`/`agent_run_id` 列，schema.js:471-480）；字段级缺 置信度/风险，缺 实际发布值（report.js 全文无 publication 引用）；HTML 无目录导航与证据跳转（§28.4 报告详情）。」

本批按**实测**逐条对齐：`schema.js:471-480` 那一段现在是 16 列（v13/v25/v31/v41… 往后加过列），**确实没有那两列** —— 所以补 v47。

---

## 2. 数据模型变更（schema v46 → v47）

### 2.0 版本号与追加纪律

- 开工前 `node scripts/check-migrations.mjs` → `{"count":46,"SCHEMA_VERSION":46,"dups":[],"continuous":true}`；**v47 是本批独占号**。
- 合并后**必须再跑一次**（v40/v42/v43-v45 三次撞号都证明「开工量一次」不够）。
- 本迁移**幂等**（两条 `ADD COLUMN` 对已升到 47 的库不会重跑：执行器的跳过条件是 `step.version <= current`）。

### 2.1 加两列（`optimize-report-provenance`）

```sql
ALTER TABLE optimization_run ADD COLUMN prompt_version TEXT;
ALTER TABLE optimization_run ADD COLUMN agent_run_id TEXT;
```

| 列 | 语义 | NULL 的含义 | 写入方 |
|---|---|---|---|
| `prompt_version` | 这一轮**实际渲染**的 optimize 组装提示词各层版本，形如 `fixed@v1; evidence@v1; contract@v1`（层序来自 `PROMPT_LAYERS`，不重排） | **这一轮没有记录**（v47 之前建的轮次，或建轮次时提示词库里没有可用的组装提示词） | `amzn_optimize_prepare`（`promptVersionOf(writing)`，与冻进 `package_json.prompts` 的是同一份数据） |
| `agent_run_id` | 模块 12 `agent_run.id` —— 这一轮由哪次 Agent 运行发起 | **这一轮没有关联**（不是由某次 agent_run 发起，或 v47 之前建的行） | `amzn_optimize_prepare`（新入参 `agentRunId`，见 §8.1） |

**两列都不许事后改**：`updateOptimizationRun` 的 patch 面**故意不含这两列**（`src/store/queries.js` 有注释说明）——放进去就等于允许把老轮次的 Prompt 版本改成今天的，而这一列存在的唯一目的就是回答「**当时**用的是哪一版」。

**「索引 + 内容」的配法**（与 `rules_version` + `rules_json` 同一形状，本仓先例）：
- 列 = **索引**（一行能读出「是哪一版」）；
- `package_json.prompts` = **内容**（逐层正文，冻结时写入，之后不可改）；
- 报告以**包为准**，两者不一致时报告**说出不一致**（§3.3）。

### 2.2 迁移与回滚

**升**：`openStore()` 照常跑到 `SCHEMA_VERSION`（47）。老库（v46）平滑升上去，两列对历史行填 NULL。

**回滚（逐字，写进契约）**：

```sql
ALTER TABLE optimization_run DROP COLUMN agent_run_id;
ALTER TABLE optimization_run DROP COLUMN prompt_version;
```

- 两列**都没有索引**，也**没有被任何先前的迁移引用** —— 所以不需要「先 DROP INDEX」（本仓踩过那个坑：某列被先前的迁移加了索引，直接 DROP 会失败）。
- **`DROP COLUMN` 需要 SQLite ≥ 3.35**。本机实测可执行（见 §9 的 ①v47 回滚断言：在一份升到 47 的临时库上真跑这两句，断言两列消失、行还在、`draft_version` / `rules_json` 没被碰）。
- ⚠️ **回滚会丢数据**：两列里的记录一并消失，且**不可恢复**（没有备份列）。所以只在「确认没有任何一轮用过这两列」时执行 —— 判断依据是 `SELECT COUNT(*) FROM optimization_run WHERE prompt_version IS NOT NULL OR agent_run_id IS NOT NULL`。

---

## 3. 摘要四字段（§28.2）

### 3.1 出参（`buildReportModel(...).provenance`）

```js
provenance = {
  rows: [                     // 恰好四行，顺序固定（§28.2 的顺序）
    { id: 'data-cutoff',    label: '数据截止',   value: <ISO 或 '读不到'>,                 note: <为什么是这个答案> },
    { id: 'prompt-version', label: 'Prompt 版本', value: <'fixed@v1; …' 或 '未记录'>,     note },
    { id: 'agent-flow',     label: 'Agent 流程',  value: <'#id · 角色 · 类型 · 状态 · N 步' 或 '未关联' 或 '#id（运行行已不在）'>, note },
    { id: 'draft-state',    label: '草案状态',    value: <'版本 vN · X 个字段：采纳 a / 未采纳 r / 待定 p' 或 '本轮没有草案字段'>, note },
  ],
  cutoff: dataCutoffOf(...),  // 数据截止的完整判定（state / rows / newest / 逐类日期）
}
```

**渲染**：
- Markdown：`## 报告头信息` + 三列 `| 字段 | 值 | 这一格是怎么来的 |`；
- HTML：`<h2 id="s-provenance">` + `<tr id="pv-<id>"><td>标签</td><td class="pv">值</td><td>来源</td></tr>`。

**为什么标签与值分列**：`includes('数据截止')` 在一份带表格的文档里是**结构性永真**（标签永远在）。分成两格之后，断言可以先切出**那一格**再读（`tests/f14-02-report-standard.mjs` 的 `mdCell` / `htmlProvenanceCell`），值改坏了就红。

### 3.2 数据截止：来源只有一个

**来源** = 这一轮的**冻结证据包**（`optimization_evidence`，v40 的十类，每类 `source_at`）。

- 取十类里**最新**的一条时间（与 hub §28.2「数据截止日 = 各来源 MAX(data_end)」同口径）；
- 同时返回**逐类**的日期（附录里印表）——只印一个 MAX，读者就看不出哪一类老了；
- **不读今天的活数据**：那会让同一份报告的数据截止随新采集漂移，而它已经印在文件里了。

**三态（必须分开）**：

| `dataCutoffOf().state` | 含义 | 报告印什么 |
|---|---|---|
| `dated` | 十类里有带日期的 | 那个 ISO 时间 + 「取本轮证据包里最新的一条观测时间（<类名>）；十类里 k/N 类带日期」 |
| `undated` | 证据包**在**，但一类都没有日期 | `读不到` + 「本轮证据包在（N 类），但没有一类带观测时间 —— 这不是「截止时间是 0」」 |
| `no-pack` | 这一轮**还没有**证据包 | `读不到` + 「这一轮还没有证据包……不是「截止时间是空的」，是这一类观测还没有落点」 |

### 3.3 Prompt 版本：三种状态 + 一个不一致分支

| 情形 | 值 | 说明那一格 |
|---|---|---|
| 包里有层版本 | `layer@vN; …` | 列也有且相同 → 「逐层：固定策略层 v1 / …」；列里有但**不同** → 「列里记的是 X，与本轮包冻结的 Y **不一致** —— 包是内容，列是索引，以包为准」；列里没有 → 「列里没有记录（v47 之前建的轮次…），但本轮包里冻结了逐层版本」 |
| 包没有、列里有 | 列的值 | 「列里记着这个版本，但本轮包里没有提示词快照 —— 无法逐层核对」 |
| 两边都没有 | `未记录` | 「这一轮没有记录 Prompt 版本 —— **不是「本系统没有 Prompt 版本」**：提示词库的版本机制从 v38 起就在（`amzn_prompt_lifecycle_get` 读得到），缺的是这一轮建轮次时没带上它（v47 之前建的轮次全部如此）」 |

### 3.4 Agent 流程：三种状态

| 情形 | 值 |
|---|---|
| 有 `agent_run_id` 且行在 | `#<id> · <roleLabel> · <六类任务类型的中文标签 或 未声明> · <status> · <N> 步` |
| 有 `agent_run_id` 但行**不在** | `#<id>（运行行已不在）` + 「引用还在、内容没了，不是「没有运行」」 |
| 没有 `agent_run_id` | `未关联` + 「这一轮没有关联到某次 Agent 运行（会话 id … / 会话 id 也没记）—— **不是「本系统没有 Agent 流程」**：模块 12 的 `agent_run` 就是它的落点」 |

任务类型的中文标签**只有一处实现**（`domain/agent/roles.js:91` 的 `AGENT_TASK_TYPE_LABELS`）；未声明就是 `未声明`，**不折算**成任何一类。

### 3.5 草案状态：版本 + 三态计数

- 有草案行：`版本 vN · X 个字段：采纳 a / 未采纳 r / 待定 p`；
- `draft_version = 0`：`版本 0（**没有追踪过**，不是「第 0 版」）· …`（版本从 1 开始，只在采纳/驳回**真的改变**时递增）；
- 一行草案都没有：`本轮没有草案字段` + 「不是「草案是空的」：空草案是「有这个字段、文本为空」」。

---

## 4. 字段级置信度与风险（§28.2）

### 4.1 出参

`buildReportModel(...).rows[i]` 新增三样：

```js
row.confidence = { level: 'high'|'medium'|'low', label: '高'|'中'|'低', reasons: [string, …] }
row.risk       = { level: …, label: …, reasons: […] }
row.skippedRules = ['title.word.repeat', …]   // 本字段上「本站点没有执行」的规则 id
row.published  = { value, publicationId, publishedAt, draftVersion, agrees, inThisRound } | null
```

### 4.2 判据表（`src/domain/optimize/standards.js#assessField`）

**置信度**（「这份草案有多可信」= 证据与判定的覆盖程度，**不是**概率）：

| 命中条件 | 档 |
|---|---|
| 没有草案文本 / 没有可对比的原值（这一字段从未被观测）/ 有阻断违规 | **低** |
| 有规则在本站点**没有执行**（`validation.skipped` 命中本字段）/ 有警告 / 是事实字段（`needsConfirmation`）/ 没有写回路径 | **中** |
| 其余 | **高** |

**风险**（把它交出去的风险）：

| 命中条件 | 档 |
|---|---|
| 有阻断违规 / 超出上限（字节或字符，数来自 `measureDraft`） | **高** |
| 有警告 / 事实字段（填错影响整组链接）/ 没有写回路径（人工搬容易漏）/ 发布登记里的值与本轮草案不同 | **中** |
| 其余 | **低** |

**等级取所有命中里最低/最高的那一档，理由**全部**带上** —— 只印一条理由会让读者以为没有别的理由了。

### 4.3 渲染

Markdown 逐字段：`> **置信度 中**：<理由；理由>　｜　**风险 中**：<理由；理由>`
HTML 逐字段：`<p class="assess"><strong>置信度 中</strong>：… ｜ <strong>风险 中</strong>：…</p>`

### 4.4 已知边界（明示，不是遗漏）

- 置信度**不是**对「亚马逊会不会接受」的概率判断，它是**证据覆盖**的三档。措辞里不出现百分比。
- 风险**不**把「丢词」计入单字段：`coverageDelta.lost` 是**整份前置文案**（title+bullets+description）的事实，没有逐字段归属。给它编一个归属会造出第二个假来源 —— 丢词仍在「一、结论」下面整块列出（现状不变）。

---

## 5. 实际发布值（§28.2 第三件）

### 5.1 出参（`buildReportModel(...).activation`）

```js
activation = {
  count,                       // 这一轮登记了几条（kind='draft' 且 run_id 是本轮）
  latest,                      // 最近一条登记（整行）
  entries: [{ field, value, publicationId, publishedAt, draftVersion,
              inThisRound,     // 本轮草案里有没有这个字段
              draftAfter,      // 本轮草案的 after
              agrees }],       // true 一致 / false 不同 / null 本轮没覆盖（**三态**）
  byField: { <field>: entry },
  fields,
  deviation,                   // §6 的**冻结**判定（publication_record.deviation_json）
  deviated, deviationRule,     // 冻结的结论与规则（core-field / over-threshold）
  uncovered,                   // 发布里出现、批准草案没有覆盖的字段
}
```

同一字段被登记过多次时取**最新**那条（`publishedAt` 最大）：线上现在是什么，是最后一次登记说的。

### 5.2 逐字段渲染

- 真有这个字段的登记：`**实际发布值**（登记 \`pub-…\`，<时间>，草案版本 vN）` + 值 + 三态之一（一致 / ⚠️ 不同 / 本轮未覆盖）；
- **一条发布登记都没有**：第四节开头**说一次**「本轮**没有发布登记**，所以逐字段不印「实际发布值」—— 这不是「发布值是空的」，是还没有人登记过发布（§6）」，逐字段**不印空**；
- 有登记但**这个字段没在里面**：不印（那张逐字段表在 12.3 里，未覆盖的行写「本轮未覆盖」）。

### 5.3 12.3 的两个不同源，措辞必须分开

| 说的是什么 | 来源 | 措辞 |
|---|---|---|
| **§6 的偏离判定** | `publication_record.deviation_json` —— **登记时算出来并冻结** | 「§6 的偏离判定（**登记时冻结**，不随今天的草案重算）：偏离（改了核心字段）/ 未偏离，改动 k/N 个字段（xx%）」 |
| **逐字段的现时对比** | 发布值 vs 本轮草案的 `after` | 「与本轮草案一致 / ⚠️ 不同」 |

两条不同的理由：草案在登记之后**还会被人改**（改完再问「当时为什么说偏离」，答案就变了），所以冻结的那份是权威；而「线上现在是不是这一版」是另一个问题。混成一句会让读者以为它们是同一件事。

### 5.4 未覆盖字段

`uncovered`（发布里有、批准草案没有的字段）**记录并报告，但不计入偏离比值** —— 这是 v31 的**明示边界**，本批继续：12.3 里单列一行点名，逐字段表里写「本轮未覆盖」。

---

## 6. HTML 目录导航与证据跳转（§28.4）

### 6.1 章节表只有一处

`REPORT_SECTIONS`（`report.js`）= 唯一标题来源：Markdown 的 `## <title>`、HTML 的 `<h2 id="<id>">`、两边的目录条目都从它来。**加一节只改一张表**，不可能出现「正文有、目录没有」。

可选节的可见性由 `visibleSections(model)` **一处**判断（模型里 `model.sections`）：`s6`（有可粘贴字段）/ `s7`（有独立编辑器字段）/ `s10`（有事实台账）/ `s-evidence`（有证据包）。

### 6.2 锚点规范

| 锚点 | 落点 |
|---|---|
| `#s-provenance`, `#s1` … `#s13`, `#s12-3`, `#s-evidence` | 每一节（及 12.3） |
| `#field-<field>` | 逐字段块的 `<h4>`（例：`#field-title`、`#field-bullet_1`、`#field-attribute.material`） |
| `#ev-<kind>` | 附录里十类的每一行（例：`#ev-current_copy`） |

### 6.3 三类跳转

1. **目录 → 正文**：`<nav class="toc">` 的每个条目链到上面第一节的锚点；
2. **结论 → 字段**：第八节（合规校验）与 8.2（本站点不适用）里，**字段名**链到 `#field-<field>`；**伪字段不链**（`bullets` / `draft` 没有自己的锚点，链过去是死链接 —— 点了没反应比没有更坏）；
3. **字段 → 证据**：逐字段块末尾一行「依据的证据这一类：[当前文案](#ev-current_copy)、[关键词包与位置计划](#ev-keywords_plan)…」。哪几类依据字段的 `appliesTo`（证据包自己的 `all` / `copy` / `keywords` / `field`）推出来，**没有第二张表**。

### 6.4 附录：证据包（十类）

`## 附录、证据包（本轮冻结的十类）`：冻结时刻（含「补冻」标记）、十类的冻结/不存在/未建模计数、缺哪几类、逐类 `| 类 | 状态 | 观测时间 | 来源 | 条数 |`。

⚠️ 附录里**逐类保留三种「没有」**：`不存在`（absent，这个对象上没有可冻结的东西）/ `未建模`（not_modelled，本仓没有这一类的来源）/ `0 条`（读过了，答案是 0）。三者不许互相代替 —— 这是 v40 建立的纪律，本批只是把它印到报告里。

### 6.5 自包含约束

HTML 仍然**零外部资源**（无 CDN、无脚本）：跳转全是文档内锚点。已有的「HTML 报告不得引用外部资源」断言继续通过（`href="#…"` 不匹配 `^https?://`）。

---

## 7. 错误码

本批**不新增工具、不新增错误码**。两次入参变化的行为：

| 位置 | 入参 | 行为 |
|---|---|---|
| `amzn_optimize_prepare` | `agentRunId`（可选，string） | 原样存进 `optimization_run.agent_run_id`。**不校验存在性**（与 `sessionId` 同一条纪律：调用方可能先建轮次、后建运行）。行不在时报告说「运行行已不在」 |
| `amzn_optimize_save` | 无新增入参 | 渲染前读一次 `readEvidence(store, runId)` 与 `getRun(store, run_id)`；读不到就按 §3 的三态说，**不抛错** |

---

## 8. 工具面与页面面

### 8.1 `amzn_optimize_prepare`（改一个入参）

```json
{ "agentRunId": "string（可选）" }
```

- 写进 v47 的 `agent_run_id`；
- `prompt_version` 由 prepare 自己算（`promptVersionOf(writing)`），**不需要调用方给**；
- `dryRun: true` 时两者都不写（不建轮次就不该有身份）。

### 8.2 `amzn_optimize_save`（不改入参，改渲染时的读数）

- 渲染前：`readEvidence(store, runId)` → `buildReportModel({ evidence })`；
- 渲染前：`run.agent_run_id ? getRun(store, run.agent_run_id) : null` → `buildReportModel({ agentRun })`；
- 渲染后照旧冻结/核对证据包（顺序不变：`finished_at` 先写，才判得出「补冻」）。

### 8.3 两处注册表

`TOOLS`（`index.js`）与 `buildTools`（`src/tools/index.js`）**未改动** —— 本批不新增工具。`node scripts/check.mjs` 仍是 134。

---

## 9. 关键数字（本次实测）

| 项 | 基线 | 本批 |
|---|---|---|
| schema | v46（`count 46 / dups [] / continuous true`） | **v47**（`count 47 / dups [] / continuous true`） |
| `node scripts/check-migrations.mjs` | 自洽 | **自洽**（`{"count":47,"SCHEMA_VERSION":47,"dups":[],"continuous":true,"last":"optimize-report-provenance"}`） |
| `node scripts/check.mjs` | `134 tool(s) registered` | **134**（不增不减） |
| `node tests/run.mjs` | **1901 passed / 0 failed** | **1920 passed / 0 failed**（**+19，只增不减**） |
| `node scripts/check-page.mjs` | 3/3 | **3/3**（本批没动 `page.js`） |
| 摘要四字段 | 0 个 | **4 个**（`data-cutoff` / `prompt-version` / `agent-flow` / `draft-state`） |
| 字段级置信度/风险 | 0 | 每个字段一行（等级 + 全部理由） |
| 实际发布值 | 0 处渲染 | 逐字段 + 12.3 逐字段表 |
| HTML 锚点 | 0（13 个 `<h2>` 无 id、0 个 `href=`） | 目录条目 = 可见章节数；字段锚点 = 草案字段数；证据锚点 = 10 |
| 死链 | —（没有链接） | **0**（断言逐条：每个 `href="#x"` 都有 `id="x"`） |

---

## 10. 回滚与已知限制

### 10.1 回滚

1. **代码**：把本批的四个文件还原（`report.js` / `standards.js` / `tools/optimize.js` / `queries.js`）——报告回到 v46 的样子（没有四字段）。回滚后**已经写进库的 `report_md` / `report_html` 不会自动重写**（它们是静态文档），要重出报告才会变。
2. **数据**：§2.2 的两条 `DROP COLUMN`。
3. **不**回滚 `package_json.prompts`（v38 就有）与 `optimization_evidence`（v40 就有）。

### 10.2 已知限制

1. **v47 之前的老轮次没有 Prompt 版本 / Agent 流程**，报告会说「未记录 / 未关联」。这是有意的：回填等于伪造当时的事实。
2. **`agent_run_id` 不校验存在性**（与 `sessionId` 同一条纪律）。人为写错 id 不会报错，报告会显示「运行行已不在」——那是**如实**的，但调用方要自己保证 id 对。
3. **数据截止取 MAX**，所以一个「九类很旧、一类刚刚采过」的轮次，截止时间会显示成刚刚 —— 逐类那 10 行是给这个判断用的（这也是为什么附录要把十类全印出来）。
4. **`prompt_version` 是压缩身份串**（`layer@vN; …`），逐层正文在包里；两者不一致时报告以包为准并说出不一致，但**没有**一条自动对账去修那个列。
5. **逐字段的风险不含「丢词」**（见 §4.4）。
6. **页面（工作台报告详情侧栏）未做**：目录与跳转都在**文档内部**。页面侧的导航是另一件事，不在本批。
7. **`hasFactLedger` / `pasteable` / `surfaceRows` 从渲染内联搬进了模型** —— 这是顺带的去重（同一份过滤原先在 Markdown 与 HTML 各算一遍）。行为不变，但模型多三个字段。
