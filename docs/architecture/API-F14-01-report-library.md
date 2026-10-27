# F14-01 报告库（十类 → 八类补齐 / 三筛选 / 收藏·标签·归档 / 正文进搜索）· 接口契约（G2）

> **日期**：2026-10-19 ｜ **作者角色**：全栈开发（架构师缺位的部分由本契约显式声明，G2 由主理人裁决）｜ **状态**：**草稿 → 待 G2**
> **关联需求编号**：F14-01（报告库，P0，模块 14 · 报告中心）
> **关联需求文档**：`docs/requirements/RESEARCH-module-alignment-v2.0.md` 的 F14-01 那一行（`:436`）
> **关联协同**：`docs/COORDINATION.md` §7.3（变更说明）
> **体例参照**：`docs/architecture/API-F14-02-report-standard.md`（上一批）
> **基线（开工前实测）**：`main f9c8733`（worktree `wt-f14-01` / 分支 `f14-01`）；
> `node scripts/check-migrations.mjs` → `{"count":47,"SCHEMA_VERSION":47,"dups":[],"continuous":true,"last":"optimize-report-provenance"}`；
> `node scripts/check.mjs` → `OK amazon-ops (plugin: workbench) — 134 tool(s) registered`；
> `node tests/run.mjs` → **1920 passed / 0 failed**；`node scripts/check-page.mjs` → **3/3**；
> 孤儿守卫 `exported`/`unwired`/`越界`/`死条目` = 基线一致（`28/28/0/0`）。
> **本批目标**：schema **v48**；`TOOLS` **134 → 136**（新增两个写入方：`amzn_report_build` / `amzn_report_update`）；
> 断言 **1920 → 1962**（**+42，只增不减**）。
> **证据等级**：§1「八类逐类判定」每一条都是本次作业对着 `src/` 实测（`read`/`grep`/`node .probe-*.mjs`），标 `verified`；
> 引用需求文档/审计的标 `documented`；**本契约里没有 `unverified` 的结论。**

---

## 0. 范围与非目标

### 0.1 这一批做什么（审计点名的四件，逐件交付深度）

| 缺口（审计原文） | 本批交付 |
|---|---|
| ① 「十类报告只落 3 类：数据质量/采集/ASIN 健康/竞品差距/规则政策影响/Prompt·Agent 评估/发布后效果/运营汇总 八类无 kind、无写入方」 | `REPORT_KIND_TABLE` 从 3 条扩到 **11 条**（3 + 8，见 §1.0 的算术说明），每条带 `label / pointer / bodyIn / writer / source`；八类各有一个**生成器**（`src/domain/reports/build.js`）与**同一个写入方**（`amzn_report_build` + `POST /api/report-build`） |
| ② 「筛选缺 产品线 / 状态 / 创建者」 | `listReports` 新增 `productLine`（读 `scope_json`）、`status`（**重算**的三态）、`createdBy`，另加 `favorite` / `tag`；工具与页面同时接了五个 facet |
| ③ 「无 收藏 / 标签 / 归档」 | v48 加 `favorite` / `tags_json` / `archived_at` / `archived_by` / `archive_reason`；`amzn_report_update` + `POST /api/report-update` 两个写入方；归档**不隐藏**（逐行标「已归档」+ 三态筛选） |
| ④ 「全文搜索只查 title/ref_id/note，不含正文」 | 搜索同时读 `report.body`（生成类的正文）、`optimization_run.report_html`（join，不复制）、`tags_json`；每行返回 `matchedIn` 说明命中在哪一格；**没进索引的两类**（正文是磁盘文件）在结果里点名 |

### 0.2 这一批明确不做（非目标）

1. **不给索引类补第二份正文**。`optimization` 的正文仍在 `optimization_run.report_html`，`kw-report` / `kw-export` 的正文仍是磁盘上的文件。v18 的「索引不是副本」不变式对这三类**一个字节都没动**；v48 的 `body` 只承载那八类（§2.2 说清为什么那不是副本）。
2. **不加 `state` 列**。状态由内容**重算**（`reportStatus`），理由见 §5。
3. **不让生成动作挂在别的工具的副作用上**。不写进 `amzn_dq_scan` / 采集任务收尾的尾巴 —— 一份报告是一次冻结的快照（§4.0）。
4. **不评估任何东西**。Prompt·Agent 评估报告里**没有一个通过率、没有一个分数**：本插件没有评估器（`src/store/prompt.js:1124` 的原话），报告只登记「缺哪份记录」。
5. **不跑全库批量规则校验**。规则政策影响报告回答「规则库变了什么、哪些规则没有判定」，**不回答**「哪 12 条 listing 现在违规」—— 那个批量计算的落点本仓没有（§1.8）。
6. **不把磁盘上的 CSV/HTML 读进索引**。理由与代价写在 §8.3。
7. **不删任何列、不删任何表**；v48 只加七列 + 两个索引，回滚只删这七列与这两个索引。
8. **不回溯老行**。v48 之前的报告 `body / created_by / favorite / tags_json / archived_*` 全是 NULL/0，**不回填、不编造**（§2.2 逐列写清 NULL 的含义）。
9. **不动 F14-02 的四字段**。报告头信息、字段级置信度/风险、实际发布值、目录与证据跳转仍是上一批那一份（`API-F14-02-report-standard.md`）。

---

## 1. 八类逐类判定（★ 这一批最关键的一节）

### 1.0 先说两件容易搞错的事

**（a）「十类」这个数字与它自己的列举对不上。** 审计 :436 写「十类报告只落 3 类」，随后逐条列出 **八个**缺失类别 —— 3 + 8 = **11**。本批按**列举**实现 11 个 kind，并在代码注释里写明这处不一致（`src/store/reports.js` 的 `REPORT_KIND_TABLE` 文档注释）。为了让算式凑成 10 而砍掉一类，等于**改需求去迎合一篇文章**。

**（b）审计自己也标了「这八类是缺口还是有意分期，v2.0 文档 §28 内没有说明」**（`:451`）。所以这一节的结论是**本批自己判出来的**，依据是代码，不是文档。

### 1.1 四种「没有」的判据（这一节的词汇表）

| 判定 | 意思 | 本节的用法 |
|---|---|---|
| **有来源** | 表/列/写入方都在，运行期真的会产生内容 | 这一类**能生成真报告** |
| **部分有来源** | 主维度在，某个子维度没有落点 | 能生成，但子维度必须登记成缺口 |
| **本仓没有该来源**（`no-source`） | 没有表、没有列、没有写入方会产生它 | **不是「不做」**：它是一条可以立项的结论 |
| **本仓没有为它建模**（`not-modelled`） | 概念在需求里，落点从未建 | 与上一条不同的缺口形态 |
| **有来源，但还没有记录**（`not-recorded`） | 表在、行没了 | 跑一次那件事就会有 |
| **读到了，答案是 0**（`measured-zero`） | 一次真实的测量 | 0 就是结论 |

后四条**不许互相代替**：`src/domain/reports/gaps.js` 只接受这四个 kind，第五种写法当场抛错；每一份生成报告的附录逐条印出属于哪一种；`tests/f14-01-report-library.mjs` 的 ⑦b 逐类断言「印了哪几条、**不印**哪几条」。

### 1.2 逐类判定表（全部 `verified`，行号是本次实测）

| # | 类别（kind） | 判定 | 来源（确切位置） | 写入方 | 登记的缺口 |
|---|---|---|---|---|---|
| 1 | 优化报告 `optimization` | 有来源（**原有**） | `optimization_run.report_html`（`schema.js:379` v1 + `:586` v6 + 后续 `ALTER`） | `amzn_optimize_save` → `recordOptimizationReport` | — |
| 2 | 总库报告 `kw-report` | 有来源（**原有**） | 磁盘 HTML 文件（`path`） | `amzn_kw_report` / 管道导出 → `recordFileReport` | — |
| 3 | 总库 CSV `kw-export` | 有来源（**原有**） | 磁盘 CSV 文件（`path`） | `amzn_kw_export` / 管道导出 → `recordFileReport` | — |
| 4 | 数据质量报告 `data-quality` | **有来源** | `dq_issue` 表（v25 `schema.js:1621`）；`store/quality.js:152` `listIssues`、`:219` `issueStats`；写入方 `store/quality.js:71` `upsertIssue`（工具 `tools/quality.js:28` `amzn_dq_scan`） | `amzn_report_build` | `not-modelled`：**「扫过没有」这条基线**（`dq_issue` 只存发现、不存扫描本身；`runQualityScan` 不落「扫描发生过」的行，也没有 `dq_scan` 表）。**复用** `domain/asin/health.js:129-137` 那条 `ASIN_HEALTH_UNSOURCED` 的原文，不另写一份 |
| 5 | 采集报告 `collection` | **有来源** | `collection_task`（v1 `:379`，列在 v4 `:537` 与 v36 `:2438` 扩过）、`collection_task_event`、`collection_section_result`；`store/collection-task-event.js:110` `listTaskEvents`、`:121` `countTaskEvents` | `amzn_report_build` | **无**（附录印「没有登记任何读不到的东西」—— 那也是一条断言） |
| 6 | ASIN 健康报告 `asin-health` | **有来源** | `domain/asin/health.js:190` `buildAsinHealthSummary`（六项）＋ `domain/asin/fields.js#buildFieldFacts` ＋ 模块 13 的 `precheckFor`；读 `asin` / `asin_field_source` / `field_conflict` / `dq_issue` / `listing` | `amzn_report_build` | `no-source` × **3**，全部复用 `domain/asin/health.js:129-153` 的 `ASIN_HEALTH_UNSOURCED`：规则风险扫描基线 / 来源类型历史 / 「43 属性来自采集」 |
| 7 | 竞品差距报告 `competitor-gap` | **有来源（部分）** | `domain/asin/competitor.js:74` `buildAsinCompetitorView`（竞品组归属 + 对端 + 关键词侧五桶）；读 `competitor_set`（v16 `:1168`）/ `kw_competitor_fact` / `kw_master` | `amzn_report_build` | `no-source` × **2**，复用 `domain/asin/competitor.js:43` 与 `:47` 两条常量原文：F06-03 的**维度字段对比矩阵**（schema 无维度对比表）、F06-05 的**口碑主题**（无评论主题表） |
| 8 | 规则政策影响报告 `rule-policy-impact` | **有来源（部分）** | `rule` / `rule_set`（v10 `:896`）、`policy` / `policy_rule`（v11 `:955`）；`store/rules.js:191` `listVersions`、`:513` `diffVersions`、`:73` `activeVersion`、`:83` `loadActiveRoster`；`domain/rules/registry.js:129` `missingChecks`；`store/policy.js:517` `policyStats` | `amzn_report_build` | `not-modelled`：**按 listing 的受影响清单**。本仓有 72 条规则的判定函数与单条草案的校验器（`domain/optimize/validate.js`），但**没有**「拿当前规则库批量跑一遍全库 listing」的入口，也没有任何表存「某条 rule 在某条 ASIN 上的判定结果」。⚠️ 措辞必须带上「这不是本仓没有规则来源」 |
| 9 | Prompt·Agent 评估报告 `prompt-agent-eval` | **有来源（部分）** | `prompt_eval_set` / `prompt_eval_case`（v39 `:2815`）；`store/prompt.js:1182` `listEvalSets`；`domain/agent/metrics.js:154` `agentMetrics`（十项，算不出来的写明缺哪份记录）；`domain/prompts/eval-dimensions.js:71` `EVAL_DIMENSIONS`（九维，`kind ∈ same-name-elsewhere / concept-not-started / no-source`） | `amzn_report_build` | **九维里逐维登记**：`no-source` 2 条（人工采纳率、成本）、`not-modelled` 7 条（5 条 `concept-not-started` ＋ 2 条 `same-name-elsewhere`）。⚠️ **本插件没有评估器，没有任何通过率**（`store/prompt.js:1124` 与 `domain/prompts/eval-dimensions.js:193` 的原话） |
| 10 | 发布后效果报告 `post-publication` | **有来源** | `publication_record` / `observation_plan` / `observation_checkpoint`（v31 `:1976`、v32 `:2089`）；`store/observe.js:818` `listPublicationObservations`、`:791` `publicationObservation`；`domain/observe/metrics.js:102` `OBSERVATION_METRICS`（九指标＋三档 `availability`） | `amzn_report_build` | `no-source` × 2（`sessions-orders` 会话与订单、`returns-themes` 退货/差评主题）＋ `not-modelled` × 2（`ctr` / `cvr` **只有广告侧**）—— 全部来自 `OBSERVATION_METRICS` 自己的 `availability` 与 `note`，不另写一份 |
| 11 | 运营汇总报告 `ops-summary` | **有来源（部分）** | `domain/dashboard/health.js:331` `buildHealthCards`（六张卡）＋各模块 counts（`asin` / `kw_master` / `collection_task` / `optimization_run` / `publication_record` / `dq_issue` / `field_conflict` / `report`）＋ `kw_ad_fact`（导入的广告报告：`impressions/clicks/orders/spend/sales`，`store/kw.js:238` `upsertAdFacts`） | `amzn_report_build` | `no-source`：**全店营收/利润**（`kw_ad_fact.sales` 是广告归因、关键词粒度，不是结算数据）；`not-modelled`：**自然订单（非广告）**（无订单表、无会话表；`kw_aba_fact.total_purchases` 是关键词购买数，还原不了 listing 的自然单） |

### 1.3 「内容已存在、只差登记」的结论

审计的提示是「八类里哪些是内容已存在、只差登记成报告」。逐类实测结论：

- **内容已存在、只差渲染与登记（7 类）**：数据质量、采集、ASIN 健康、竞品差距、Prompt·Agent 评估、发布后效果、规则政策影响。每一类都调各自模块**既有的 builder**，一个字都不重算（§4.2 逐条列了调的是哪个函数）。
- **内容分散在多个模块、需要一个汇总（1 类）**：运营汇总。它是**派生**的，本契约明写它派生自哪几个模块、**不含**什么（营收/利润/结算），因为「汇总」最容易被读成「全店经营情况」。
- **本仓没有该来源（1 项）**：全店营收/利润 —— 这条**不是一个没做的功能**，它是一条结论：本仓任何一张表都不承载它。写进报告附录而不是「待办」。
- **本仓没有为它建模（3 项）**：规则风险的扫描基线、按 listing 的受影响清单、自然订单。三者都不是「没数据」，是**落点从未建**。

> ⚠️ **「没有数据来源」≠「不做」**：前一条是**关于本仓的事实**（可以立项、可以解释为什么报告里没有它），后一条是**关于排期的决定**。本批把前者写进报告附录与契约，把后者留给 PM 排期 —— 两者在文档里分得开。

---

## 2. 数据模型变更（schema v47 → v48）

### 2.0 版本号与追加纪律

- 开工前 `node scripts/check-migrations.mjs` → `{"count":47,"SCHEMA_VERSION":47,"dups":[],"continuous":true}`；**v48 是本批独占号**。
- 合并后**必须再跑一次**（v40/v42/v43-v45 三次撞号都证明「开工量一次」不够）。
- 本迁移**幂等**（七条 `ADD COLUMN` 与两条 `CREATE INDEX IF NOT EXISTS` 对已升到 48 的库不会重跑：执行器的跳过条件是 `step.version <= current`）。

### 2.1 加七列 + 两个索引（`report-library-facets`）

```sql
ALTER TABLE report ADD COLUMN body TEXT;
ALTER TABLE report ADD COLUMN archived_at TEXT;
ALTER TABLE report ADD COLUMN archived_by TEXT;
ALTER TABLE report ADD COLUMN archive_reason TEXT;
ALTER TABLE report ADD COLUMN created_by TEXT;
ALTER TABLE report ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report ADD COLUMN tags_json TEXT;

CREATE INDEX IF NOT EXISTS idx_report_favorite ON report(favorite, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_archived ON report(archived_at);
```

| 列 | 语义 | NULL / 默认 的含义 | 写入方 |
|---|---|---|---|
| `body` | **生成类报告的唯一正文**（Markdown，生成时刻冻结） | `NULL` = **这一类不把正文放在行里**（前三个索引类正常且正确），**不是**「没有正文」 | `amzn_report_build` / `POST /api/report-build` |
| `archived_at` | 归档时间戳 | `NULL` = 未归档（这是「没归档」这个**事实**，不是缺值） | `setReportArchived`（工具与页面两条入口） |
| `archived_by` | 谁归档的 | `NULL` = **没有记录**是谁（v48 之前没有归档能力），**不是**「本系统不支持」 | 同上 |
| `archive_reason` | 为什么归档 | 同上 | 同上 |
| `created_by` | 谁生成的 | `NULL` = **没有记录**（v48 之前的写入方不传这个字段） | 新写入方传 `amzn_report_build` / `page` |
| `favorite` | 收藏 | `0` = 没收藏（常量默认，不是 NULL） | `setReportFavorite` |
| `tags_json` | 标签数组的 JSON | `NULL` = **没人打过标签**；`[]` = **打过又清空了**。两者分开存，与 `product_line.signals_json`（v17）同一个选择 | `setReportTags` |

### 2.2 为什么 `body` 不是「第二份正文」

v18 `report` 的不变式是**索引，不是副本**（`schema.js:1253-1274` 的原话）。它对前三个 kind 成立，因为那三类的正文**在别处已经有唯一的一份**。

审计点名的另外八类没有这个前提：它们的内容散在各模块的表里，**从来没有被渲染成一份文档，也没有任何文件承载它**。所以这八类报告的正文**只可能**落在 `report.body` —— 它不是副本，它是这一份文档的**唯一载体**。

⚠️ 写清楚这一点是为了挡住一个具体的错：日后有人「顺手」把优化报告的 HTML 也抄进 `body`，那就真的造出了第二份正文，而两份会分歧、页面显示的那份会更旧。§0.2 第 1 条是这个约束的反面。

### 2.3 迁移与回滚

**升**：`openStore()` 照常跑到 `SCHEMA_VERSION`（48）。老库（v47）平滑升上去，七列对历史行填 NULL / 0。

**回滚（逐字，写进契约）**：

```sql
DROP INDEX IF EXISTS idx_report_favorite;
DROP INDEX IF EXISTS idx_report_archived;
ALTER TABLE report DROP COLUMN tags_json;
ALTER TABLE report DROP COLUMN favorite;
ALTER TABLE report DROP COLUMN created_by;
ALTER TABLE report DROP COLUMN archive_reason;
ALTER TABLE report DROP COLUMN archived_by;
ALTER TABLE report DROP COLUMN archived_at;
ALTER TABLE report DROP COLUMN body;
```

- ⚠️ **必须先 `DROP INDEX` 再 `DROP COLUMN`**：`idx_report_favorite` 引用 `favorite`、`idx_report_archived` 引用 `archived_at`。反序执行时 SQLite 会拒绝（本仓踩过这个坑）。**这条不是注释，是可证伪的**：`tests/f14-01-report-library.mjs` 的 ②c 真跑一次反序回滚，断言它**失败**且没有留下半截状态。
- **`DROP COLUMN` 需要 SQLite ≥ 3.35**。本机实测可执行（②b 在一份升到 48 的临时库上真跑这九句，断言七列消失、**报告行还在**、`kind`/`title`/`ref_id`/`path` 没被碰）。
- ⚠️ **回滚会丢数据**：八类生成报告的正文一并消失，且**不可恢复**（没有备份列）。所以只在「确认没有任何一份生成报告还需要留」时执行；判断依据是 `SELECT COUNT(*) FROM report WHERE body IS NOT NULL`。

---

## 3. 类别表：一处声明，五处读

### 3.1 出参形状

```js
// src/store/reports.js
export const REPORT_KIND_TABLE = [
  { id, label, pointer: 'ref'|'path'|'body', bodyIn: 'row'|'ref'|'file', writer, source },
  …11 条…
]
export const REPORT_KINDS = REPORT_KIND_TABLE.map(entry => entry.id)   // 派生，不是另写一份
export function reportKindSpec(kind)        // → 该条或 null
export function reportStatus(row)           // → 'ready' | 'unopenable' | 'archived'
export const REPORT_STATUSES = ['ready', 'unopenable', 'archived']
export const REPORT_STATUS_LABELS = { ready: '可取回', unopenable: '取不回', archived: '已归档' }
```

`pointer` 是**不变式的数据形式**：这一类靠哪一列才是可打开的。`bodyIn` 决定搜索能不能读它的正文（`row` 能、`ref` 能（join）、`file` 不能）。

### 3.2 五个读者（谁在读这张表）

| 读者 | 读什么 | 改坏表的后果 |
|---|---|---|
| `recordReport`（store） | `pointer` → 这一类必须带哪个指针 | 该类的写入形状变了 |
| `listReports` / `reportCounts`（store） | `label` / `count` / `writer` / `source`，以及**从 `pointer` 生成的 `openableSql()`** | chips 与状态分支一起变 |
| `src/tools/report.js` | `label`（渲染「类型」格）、`REPORT_KINDS`（入参校验） | 工具侧「类型」格变 / 拒收变 |
| `src/web/routes.js` | `kinds` 整张下发（含 `label`/`writer`/`source`/`count`） | 页面侧 chips 与下拉变 |
| `src/domain/search/index.js` | `bodyIn` → 哪些类的正文可搜 | 搜索的「没进索引」清单变 |

### 3.3 三条曾被违反的纪律（这一批修掉）

改之前同一套类别词表在**三处**各有一份：
- `src/store/reports.js:33` `REPORT_KINDS = ['optimization','kw-report','kw-export']`
- `src/tools/report.js:31` `KIND_LABELS = {…}` ＋ `:62` `const known = [...]`
- `src/web/page.js:4958` `REPORT_KIND_LABELS = {…}`

加第四类必然只改一处或两处，而失败模式是**静默**的（行里渲染出原始 id 而不是标签）。现在三份都没了：工具侧与页面侧只读 `REPORT_KIND_TABLE`，`page.js` 连下拉的 `<option>` 都由 payload 填充。

**验收判据（可证伪）**：`tests/f14-01-report-library.mjs` 的 ①d 扫 `src/tools/report.js` 与 `src/web/page.js` 的**代码行**，断言 11 个 `label` 一个都不出现，并断言两个旧表名（`KIND_LABELS` / `REPORT_KIND_LABELS`）不再存在；①e 断言工具侧渲染的「类型」格与路由下发的 `kinds[].label` **逐条等于表里的那一条**。§9 有「拿掉一条表项 ⇒ 两侧同时红」的原文。

---

## 4. 八类生成器

### 4.0 为什么是「一次生成」而不是「一次工具副作用」

一份报告是一次**冻结的快照**。挂在 `amzn_dq_scan` 的尾巴上意味着每扫一次库就悄悄多一行，而最新那行描述的是**一次没人选择发布的扫描**。所以写入方是单一入口：

- 工具：`amzn_report_build`；
- 页面：`POST /api/report-build`（同一个 `buildReport`）。

### 4.1 出参

```js
buildReport(store, { kind, asin, marketplace, productLine, now, precheckFor }) → {
  ok: true,
  kind, title, refKey, scope: { asin?, marketplace?, productLine? },
  body,          // Markdown，冻结
  reportId,      // `${kind}:${refKey}:${YYYY-MM-DD}` —— 见 4.3
  now,
} | { ok: false, code, error, hint? }
```

错误码（**不抛错**，与工具纪律一致）：

| code | 何时 | 提示里说什么 |
|---|---|---|
| `KIND_REQUIRED` | 没给 kind | 可用的八类 |
| `NOT_GENERATED` | 未知 kind，**或**前三个索引类 | 「正文在 `<source>`，由 `<writer>` 登记；这里再生成一份就是第二份正文」 |
| `SCOPE_REQUIRED` | `asin-health` / `competitor-gap` 缺 asin 或站点 | 这两类是「一条 ASIN」的报告 |
| `ASIN_NOT_FOUND` | 该 ASIN 不在库内 | 先 `amzn_asin_upsert`，或确认站点 |
| `DEPENDENCY_MISSING` | `asin-health` 没注入 `precheckFor` | 「否则会把『没人算过前置』静默读成『前置不满足』」 |

### 4.2 每一类调的是哪个既有 builder（不重算任何判据）

| kind | 调用的既有函数 | 本批新增的只有「渲染」 |
|---|---|---|
| `data-quality` | `store/quality.js` `issueStats` / `listIssues`；`domain/data/quality-rules.js` `DIMENSION_LABELS` | 表格骨架 + 附录 |
| `collection` | `collection_task` 三张表 + `store/collection-task-event.js` `countTaskEvents` | 同上 |
| `asin-health` | `domain/asin/health.js` `buildAsinHealthSummary`（`fields` 来自 `buildFieldFacts`，`precheck` 来自模块 13 的 `precheckFor`） | 逐项展开 + 附录 |
| `competitor-gap` | `domain/asin/competitor.js` `buildAsinCompetitorView` | 五桶表 + 示例行 + 附录 |
| `rule-policy-impact` | `store/rules.js` `listVersions`/`diffVersions`/`activeVersion`；`domain/rules/registry.js` `missingChecks`；`store/policy.js` `policyStats`；`SEED_ROSTER` | 三张表 + 附录 |
| `prompt-agent-eval` | `store/prompt.js` `listEvalSets`；`domain/agent/metrics.js` `agentMetrics`；`domain/prompts/eval-dimensions.js` `EVAL_DIMENSIONS` | 三张表 + 九维「缺哪份记录」 |
| `post-publication` | `store/observe.js` `listPublicationObservations`；`domain/observe/metrics.js` `OBSERVATION_METRICS` | 卡片表 + 指标可用性表 + 附录 |
| `ops-summary` | `domain/dashboard/health.js` `buildHealthCards`；各表 count；`kw_ad_fact` 汇总 | 三节 + 附录 |

### 4.3 幂等：同一天同一范围是「更新那一份」

id = `${kind}:${refKey}:${YYYY-MM-DD}`，`refKey` 是范围的稳定描述（`all` 或 `ASIN@SITE`）。与 `recordFileReport` 用路径派生 id 是同一个办法（文件名带日期）和同一个理由：**同一天重跑同一份导出不该让列表多一套**。换一天、换一个范围，是真正不同的一份快照，各占一行。

### 4.4 空态的四种「没有」

每一份生成报告都以 `## 附录、读不到的东西（四种「没有」分开写）` 结尾，按 `no-source` → `not-modelled` → `not-recorded` → `measured-zero` 的顺序分节，每节带一句「读者该做什么」。**空的时候也印**（「本报告没有登记任何读不到的东西」本身是一条断言）。

正文里的空态另有四处固定措辞，`gaps.js` 的 `ABSENCE_LABELS` 是唯一来源：

| 情形 | 报告印什么 |
|---|---|
| 库是空的、但这一类有写入方 | `有来源，但还没有记录` + 点名写入方（例：`amzn_collect_submit`） |
| 读到了，数量就是 0 | `读到了，答案是 0`（并说「0 就是结论」） |
| 子维度没有落点 | `本仓没有为它建模` |
| 子维度连表都没有 | `本仓没有该来源` |

---

## 5. 状态：由内容重算，不落列

```js
reportStatus(row) =
  row.archivedAt != null ? 'archived'
  : row.openable ? 'ready'
  : 'unopenable'
```

`openable` 由 `pointer` 决定：`ref` → `ref_id IS NOT NULL`；`path` → `path IS NOT NULL`；`body` → `body IS NOT NULL`。

**为什么不加 `state` 列**：三个状态有两个不同的权威（正文取不取回、归档时间戳在不在），压成一个字符串就是给同一件事造第二份口径 —— 而写入方自报、读者另算的形态，正是本仓刚删掉的那四处假话的病根。

**为什么不隐藏归档行**：2026-10-13 用户对 ASIN 归档的裁决是「保留现状（默认显示）+ 三态筛选」，理由写在 `domain/asin/table.js:292-295`：不带标记的一行看起来与正常记录完全一样，而「归档没生效」正是那个样子。报告沿用同一条口径。

**两个引擎，一条规则**：`listReports({status})` 用 SQL（`openableSql()` 从 `pointer` 生成）过滤，`hydrateReport` 用 JS 重算。两者必须同答 —— `tests/f14-01-report-library.mjs` 的 ③b **逐行对账**（五种行形状 × 三个状态），并断言三态之和 = 总行数。

---

## 6. 筛选

### 6.1 入参（`listReports`）

| 参数 | 谓词 | 说明 |
|---|---|---|
| `kind` | `kind = ?` | 未知 kind 由**调用方**按名拒收（store 不静默返回空） |
| `asin` | `json_extract(scope_json,'$.asin') = ?` | 大写折叠；`scope_json` 为 NULL 时不匹配也不报错 |
| `marketplace` | `json_extract(scope_json,'$.marketplace') = ?` | 同上 |
| `productLine` | `json_extract(scope_json,'$.productLine') = ?` | **新增**。NULL 不是通配符 |
| `status` | 见上表 | **新增**。`all`（默认）/ `ready` / `unopenable` / `archived`；未知值**抛错** |
| `createdBy` | `created_by = ?` | **新增**。精确匹配；NULL（未记录）自成一类，不冒充任何创建者 |
| `favorite` | `favorite = 1` | **新增**。`true` 才生效 |
| `tag` | `EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = ?)` | **新增**。精确匹配一个标签 |
| `since` | `created_at >= ?` | 原有 |

全部是 **AND**。返回值新增 `matched`（本条件命中数）—— 与 `total`（库内总数）分开，因为「库是空的」与「你的筛选没有结果」是两句话。

### 6.2 facet 值只给真实存在的

`reportCreators`（含 `unrecorded` 计数）、`reportProductLines`、`reportTags`：页面三个下拉的选项由这三处填充，所以一个下拉**不可能**提供库里没有的值。

---

## 7. 收藏 / 标签 / 归档

| 操作 | store | 工具 | 路由 | 语义 |
|---|---|---|---|---|
| 收藏 | `setReportFavorite(store, id, bool)` | `amzn_report_update {favorite}` | `POST /api/report-update {favorite}` | 返回**读回的行**，不是调用方要的值 |
| 标签 | `setReportTags(store, id, tags)` | `{tags: [...]}` | 同上 | trim + 去重 + 排序；`[]` 清空 ≠ `null` 没打过 |
| 归档 | `setReportArchived(store, id, bool, {by, reason})` | `{archived, archiveReason, by}` | 同上 | 恢复时**三列一起清空**（残留 `archived_at` 会永远读成已归档） |

三者都返回 `getReport(...)` 的结果；id 不存在返回 `null`，工具/路由转成「找不到报告」。

---

## 8. 全文搜索

### 8.1 三个正文位置，如实分开

| 位置 | 怎么读 | 可搜？ |
|---|---|---|
| `report.body` | 同表列 | ✅ 生成类八类 |
| `optimization_run.report_html` | `ref_id` join（**不复制**） | ✅ 优化报告 |
| 磁盘文件（`kw-report` / `kw-export`） | `path` | ❌ **没进索引** |

### 8.2 命中位置随行返回

每行带 `matchedIn: ['标题'|'引用'|'备注'|'正文'|'标签'|'正文（优化 HTML）']`。理由：「标题里命中了」与「正文里命中了」是两个不同的claim，读者应该看得见是哪一个。

### 8.3 为什么不把磁盘文件读进索引

一次搜索是每个按键一次。按 `path` 逐个 `readFileSync` 一份 CSV，代价随库增长而线性上升；截断读又会把「搜不到」与「没搜全」混成一句。所以选择**说出来**：`searchAll` 的返回多一个 `reportBodyNotSearched: [{id, label, reason}]`（从 `REPORT_KIND_TABLE.bodyIn === 'file'` 派生），页面据此不承诺「全文搜索」。**搜得更少却不说，才是那个错。**

---

## 9. 工具面与页面面

### 9.1 新增两个工具（两处注册表都加了）

```json
amzn_report_build { kind*, asin?, marketplace?, productLine?, dryRun?, reportId? }
amzn_report_update { id*, favorite?, tags?, archived?, archiveReason?, by? }
```

- `TOOLS`（`index.js`）与 `buildTools`（`src/tools/index.js`）**两处都加** —— 只注册一处会让工具存在但不可调用，且不报错。
- 两者在 `WRITE_TARGETS` 都有**非 null** 描述符（`report.build` / `report.update`，动作串进 `ACTIONS`）；`amzn_report_build` 有 `skip: a => a.dryRun === true`（dryRun 一行审计都不落）。
- 名字里没有 `publish|apply|push|deploy`（工作台那条发布边界守卫会拒绝）。

### 9.2 路由

| 路由 | 说明 |
|---|---|
| `POST /api/report-build` | 同一个 `buildReport` + `recordReport`（`createdBy: 'page'`）；返回 `{ok, report, body}` |
| `POST /api/report-update` | 三个开关，任一为空 → 400；id 不存在 → 404 |
| `GET /custom/amazon-ops/report/body/<id>` | 生成类报告的正文，`text/plain; charset=utf-8`。**不渲染成 HTML**：否则这条路由就成了任何 builder 内容的 HTML 注入点 |
| `GET /custom/amazon-ops/report/<runId>` | 原有，优化轮次的 `report_html`，**行为不变** |

两条新 POST 在 `PAGE_WRITE_TARGETS` 里都有描述符，且 `action`/`objectType` 与对应工具**逐字相同**（页面点一次与会话调一次在审计里必须是同一条）。

### 9.3 页面（`src/web/page.js`）

- 筛选条新增：状态、产品线、创建者、标签、只看收藏；类型下拉的 `<option>` 由 `data.kinds` 填充（**不再写死三类**）。
- 新增「生成报告」一排：类别下拉（`data.buildable`）+ ASIN/站点（仅健康与竞品差距需要）+ 按钮；结果行读回自服务端。
- 表格：状态格 = 重算的三态 chip + ★收藏 + `#标签`；操作格 = 打开 / 取不回 / 文件路径 + 收藏 + 归档按钮（事件委托在 `#rptable` 上，因为每 3 秒轮询会重绘行）。
- 单条详情：`#rpdetail`，含标签编辑与「在新窗口读全文」。
- 空态四种（§4.4），其中三种在本页出现：库空 → 两条路；这一类有写入方但 0 条 → 「这一类还没被生成过」；筛窄了 → 「放宽条件再试」。
- ⚠️ 动完 `page.js` 必须 `node scripts/check-page.mjs` **3/3**（本批踩过一次：新写的注释里带反引号，把模板字面量截断了 —— 见 §11.4）。

---

## 10. 关键数字（本次实测）

| 项 | 基线 | 本批 |
|---|---|---|
| schema | v47（`count 47 / dups [] / continuous true`） | **v48**（`{"count":48,"SCHEMA_VERSION":48,"dups":[],"continuous":true,"last":"report-library-facets"}`） |
| `node scripts/check.mjs` | 134 tool(s) | **136**（+`amzn_report_build` / +`amzn_report_update`） |
| `node tests/run.mjs` | **1920 passed / 0 failed** | **1962 passed / 0 failed**（**+42，只增不减**） |
| `node scripts/check-page.mjs` | 3/3 | **3/3** |
| 孤儿守卫 | `28/28/0/0` | `27/27/0/0`（**只缩不长**：`countTaskEvents` 接上线后从 `UNWIRED` 删掉） |
| 报告类别 | 3 | **11** |
| 生成类 | 0 | **8** |
| 筛选维度 | 4（kind/asin/marketplace/since） | **9**（+productLine/status/createdBy/favorite/tag） |
| 可搜正文位置 | 0 | **2**（`report.body`、`optimization_run.report_html`），另 2 类明确声明未进索引 |

---

## 11. 回滚与已知限制

### 11.1 回滚

1. **代码**：还原本批的九个文件（`store/schema.js`、`store/reports.js`、`domain/reports/*`、`tools/report.js`、`tools/index.js`、`index.js`、`web/routes.js`、`web/page.js`、`domain/search/index.js`、`domain/audit/targets.js`）。回到 v47 的样子：报告只剩三类，八类生成器不存在（已写进库的 `body` 行**不会自动消失**，要按 §2.3 清列）。
2. **数据**：§2.3 那九句（**先 DROP INDEX**）。
3. **不**回滚 `optimization_run.report_html`（v1 起）、`dq_issue`（v25）、`collection_*`（v36）、`prompt_eval_*`（v39）、`publication_record`（v31）—— 它们都是本批**读**的东西。

### 11.2 已知限制

1. **索引类报告没有正文可搜**（磁盘文件）。这是明示的边界，且搜索的返回里点名了那两类。
2. **`status` 只有三态**。没有 `draft`/`final` 之类的编辑生命周期 —— 本仓没有「报告编辑」这个动作，给它编一个状态就是编一个不存在的工作流。
3. **产品线读的是 `scope_json.productLine`**，不是从 `asin.product_line_id` 反推。写入方记录了什么就是什么；NULL 是「没有记录范围」，不是「没有产品线」。
4. **`created_by` 只有新写入方填**。v48 之前的行是 NULL，页面如实说「N 条报告没有记录是谁生成的」。
5. **`ops-summary` 是派生汇总，不含营收/利润/自然单**。见 §1.2 第 11 行。
6. **`rule-policy-impact` 不回答「哪条 listing 违规」**。批量校验的落点没有。
7. **`prompt-agent-eval` 没有任何通过率**。本插件没有评估器。
8. **`reportIdOf` 的日期戳取本机 UTC 日期**。跨时区的两个人对「今天」可能不一致 —— 这是 id 派生规则，不是数据问题；要精确控制就用显式 `reportId`。
   **订正（2026-10-20）**：这句话原来只说到「规则如此」，漏了它对**测试**的后果 ——
   `F14-01-⑧b` 的「换一天」写成字面量、而「同一天」走真实时钟，于是这条测试在
   **2026-10-20** 自己变红（代码零改动）。现在「今天」只有**一处**真实读数：
   `build.js` 的 `systemClock()`；`buildReport` 的 `now` 与 `amzn_report_build` 的
   `clock`（默认 `systemClock`）都是它的注入点，测试用固定 `clock` 驱动幂等断言。
   形状守卫在 `tests/clock-guard.mjs`（`tests/**` 里读真实时钟驱动日期断言即红）。
   生产语义未变：id 仍带日期戳、同一天同一范围仍更新那一行、换一天仍是新的一份。
9. **一次生成一份快照，不自动清理旧快照**。报告库会随时间增长；归档是当下唯一的手段（软标记，不删行）。

### 11.3 需要重点回归的范围

- 报告面板（`module=report` 的整个切片 + 三条路由）；
- 全局搜索的「报告」组（`searchAll` 的返回多了 `reportBodyNotSearched`）；
- 审计漏斗（两个新工具 + 两条新 POST 的 `WRITE_TARGETS` / `PAGE_WRITE_TARGETS`）；
- 孤儿守卫（新增 **22** 个导出，全部有生产调用方；删掉 1 条 `UNWIRED`，`28 → 27`）。

### 11.4 本批付过代价的一个坑（写下来给下一批）

改 `page.js` 时在**模板字面量里的注释**中写了三个反引号（想标注 `REPORT_KIND_TABLE` 与 `rpStatus`），`node --check` 报的是「Unexpected identifier」并指向一句中文注释。这正是 `scripts/check-page.mjs` 文件头写的第一类坑。教训与流程一致：**动 `page.js` 就立刻跑 `check-page.mjs`**，不要等全量测试。

---

## 12. 证据索引

| 断言 | 文件 | 说明 |
|---|---|---|
| 类别表只有一处 | `tests/f14-01-report-library.mjs` ①a–①e | 派生关系 + 源码扫（代码行）+ 两侧读回对账 |
| v48 与回滚 | ②a–②c | 七列两索引；真跑回滚；**反序回滚必须失败** |
| 状态重算与对账 | ③a–③c | 三态 + 逐行 SQL/JS 对账 + 未知值按名拒绝 |
| 三项新筛选 | ④a–④b | 各自收窄 + AND + NULL 不是通配符 |
| 收藏/标签/归档 | ⑤a–⑤c | 读回 + `[]` vs `null` + 恢复清三列 |
| 正文进搜索 | ⑥a–⑥c | 生成类 / join 优化 HTML / **文件类搜不到且被点名** |
| 四种「没有」 | ⑦a–⑦f | 八类全部可生成；逐类断言印哪几条、不印哪几条 |
| 写入方 | ⑧a–⑧d | 冻结读回 + 幂等 + dryRun 不写 + 三个开关 |
| 工具面空态 | ⑨a–⑨d | 两条路 / 这一类没生成过 / 单条读全文 |
| 页面侧 | ⑩a–⑩b | 控件 + 无写死 option + 切片自带表 |
| includes 自查 | ⑪a–⑪c | 切格 + 三个反面 + 裸词禁止针的假红 |

---

## 13. 证伪原文（回退 → 变红 → 改回 → 绿）

两处都真跑过全量，原文照贴。

### 13.1 拿掉 `REPORT_KIND_TABLE` 里的 `ops-summary` 一条 ⇒ 工具侧与页面侧**同时**变红

改动：删除 `src/store/reports.js` 中 `ops-summary` 那一项（其余不动）。

```
  FAIL F14-01-①a 11 个类别、id 唯一、顺序稳定，且三索引类仍在前三位
  FAIL F14-01-①b 八类生成类各自有一个 builder，三索引类一个都没有
  FAIL F14-01-①c 不变式按类别执行：三类各自只认自己的那个指针
  FAIL F14-01-①d 工具侧与页面侧**代码里**都没有类别标签的第二份副本（源码扫，不是读运行时）
  ok   F14-01-①e 两侧渲染出来的标签都等于表里的那一条（读回对账）
  ...
  FAIL F14-01-⑨c 单条读全文：id 命中则给正文；不存在的 id 按名拒绝
  FAIL F14-01-⑨d 三个新筛选在工具面也通：产品线 / 状态 / 创建者 / 标签 / 收藏
  FAIL F14-01-⑩b 路由下发的切片自带类别表、三态、facet 与可生成的八类
1948 passed, 12 failed
```

**工具侧**（`amzn_report_list` / `amzn_report_build` 的 kind 校验）原文：

```
  F14-01-⑨d 三个新筛选在工具面也通：产品线 / 状态 / 创建者 / 标签 / 收藏
    Error: unknown report kind "ops-summary" — known: optimization, kw-report, kw-export, data-quality,
    collection, asin-health, competitor-gap, rule-policy-impact, prompt-agent-eval, post-publication
```

**页面侧**（路由下发给页面 `data.kinds` 的那张切片）原文：

```
  F14-01-⑩b 路由下发的切片自带类别表、三态、facet 与可生成的八类
    Error: expected 11, got 10
```

改回那一行 ⇒ `1962 passed, 0 failed`。

⚠️ **注意 `①e` 在表被改坏时仍然是绿的 —— 那是设计如此**：工具与页面读同一张表，所以「两侧一致」不会因为表坏了而破裂；变红的是**每一侧自己的声明**（工具能生成 11 类、切片下发 11 条）。想让它红，得让其中一侧偷偷留一份自己的副本 —— 而那正是 `①d` 在扫的东西。

**这次证伪顺手抓到一个真 bug**：`buildOpsSummary` 里 `reportKindSpec('ops-summary').source` 在表项缺失时抛
`TypeError: Cannot read properties of null (reading 'source')`（原文见 ⑪b 的崩溃）。修法：`buildReport` 先判
`spec === null` 并按 `NOT_GENERATED` 干净拒绝 —— **表是两个方向的权威**：表里没有的 id 即使 `BUILDERS` 里有函数也不许生成，
因为那张表是工具、路由切片与搜索一起读的东西，一个不在表里的 kind 是一行谁也打不开的报告。

### 13.2 把 `not-modelled` 的措辞改成与 `no-source` 一样 ⇒ 四种「没有」的断言变红

改动：`src/domain/reports/gaps.js` 的 `ABSENCE_LABELS['not-modelled']` 由 `本仓没有为它建模` 改成 `本仓没有该来源`。

```
  F14-01-⑦b ★ 四种「没有」逐类分开：每一类印哪几条、**不印**哪几条
    Error: 数据质量报告没说「扫过没有」这条基线没建模
1959 passed, 1 failed
```

改回 ⇒ `1962 passed, 0 failed`。这条证伪的意义：**四种「没有」不是文档里的一句话，是七条断言**；
把两句合并成一个说法，逐类断言立刻红在**第一类**上。

### 13.3 反向的一条（证明断言不是「什么都没检查」）

`①d` 的扫描器自带一条反面：用改之前真实存在的形状
`const REPORT_KIND_LABELS = { optimization: '优化报告' }` 构造样本，断言扫描器**能**在里面找到 `优化报告`。
一个「剥注释剥过头」的扫描器会对任何输入都返回干净，那条反面就是防它的。
