# B-05d ASIN 详情后五个 Tab · 接口契约（G2）

> **日期**：2026-10-13 ｜ **作者角色**：全栈开发（由本人代拟，G2 由主理人裁决）｜ **状态**：**草稿 → 待 G2**
> **关联需求编号**：F05-02（ASIN 详情 9 Tab）
> **关联需求文档**：`docs/requirements/RESEARCH-module-alignment-v2.0.md` §3.5 模块 05 的第 168 行（F05-02 缺口：后五个 Tab 一个都没有）
> **体例参照**：`docs/architecture/API-B05c-history-import-health.md`（最近一份）
> **基线（开工前实测）**：worktree `wt-dsh-b05d` / 分支 `dsh-b05d`，基于 `main d6cfc0c`；
> `node scripts/check-migrations.mjs` → `{"count":45,"SCHEMA_VERSION":45,"dups":[],"continuous":true,"last":"agent-run-task-type","first":"initial-schema"}`；
> `SCHEMA_VERSION` = **45**；`TOOLS` = **133**；`node tests/run.mjs` = **1794 passed / 0 failed**
> **本批目标**：`SCHEMA_VERSION` **仍是 v45（本批不加迁移）**；`TOOLS` **仍是 133（本批不加工具）**；
> `ASIN_DETAIL_TABS` 4 → **9**，`ASIN_DETAIL_PENDING_TABS` 5 → **0**
> **证据等级**：本文每条「现状」都在本次作业中对着 `src/` 实测（`read` / `grep` / `node`），标 `verified`；
> 引用需求文档的标 `documented`，**与需求文档不符的已逐条标 `stale` 并给出实测反证**。
>
> ### ⚠️ 收尾订正（2026-10-13，接手者实测）：上面那组基线是**开工前**的，合并 main 后变了
>
> 收尾时按主理人要求先 `git merge main`（**快进**到 `5353d9c`，含 t5-archive 的迁移
> **v46 `asin-archive-index`**），于是**环境基线变了，而本批的两条「不变」没变**：
>
> | 量 | 开工基线（上文） | 合并 main 后的基线（**收尾实测**） | 本批动了吗 |
> |---|---|---|---|
> | `check-migrations` | `count 45` | `{"count":46,"SCHEMA_VERSION":46,"dups":[],"continuous":true,"last":"asin-archive-index","first":"initial-schema"}` | **没动** —— 本批不加迁移（§9） |
> | `SCHEMA_VERSION` | 45 | **46**（来自 t5-archive，不是本批） | **没动** |
> | `TOOLS` | 133 | **134**（来自 t5-archive，不是本批；`scripts/check.mjs` 实测 134 个 `amzn_*`） | **没动** —— 本批不加工具 |
> | `node tests/run.mjs` | 1794 passed / 0 failed | **1870 passed / 0 failed**（合并 main + 本批，收尾实测） | 本批新增断言（`main` 单独一跑是 1828，主理人口径，本次未复测） |
>
> 所以下文 §9 / §10 / §11 里凡是写「45」的地方，**读作「合并 main 后的基线 46」**：
> 结论（**不加迁移、v46 撞号这一类风险归零**）不变，换的只是数字。

---

## 0. 范围与非目标

### 0.1 这一批做什么

| Tab（页面名） | 数据源 | 本批交付的深度 |
|---|---|---|
| `keywords` 关键词与排名 | `asin_keyword` + `keyword`（**已有**） | 按 ASIN 的逐词读数：排名 / 页码 / 扫描深度 / 档位 / 搜索量 / 观测时间 / 来源；三态由内容推出（`ranked` 有名次 / `absent` 测过但没找到 / `unranked` 有行但没名次）；**「排名历史」明说本仓没有来源**（§3.5） |
| `reviews` 评论问答 | `collection_section_result` 的 `reviews` 节（**已有**） | 评论读数：总数 / 可见数 / 摘要 / 逐条样本 / 观测时间 / 任务 / 采集状态；**Q&A 明说本仓没有来源**（`qa_1..8` 有字段声明、没有采集节、优化器自己标 `notModelled`，§4.4） |
| `competitor` 竞品对比 | `competitor_set` + `kw_competitor_fact` + `asin_keyword`（**已有**） | ① 这条 ASIN 出现在哪些竞品组里（含 `note` 与成员数）② 复用 `readCompetitorSides → quadrantRows → classifyQuadrants` 的**同一个**五桶分类；**「按维度字段的对比矩阵」与「口碑主题」明说本仓没有来源**（F06-03 / F06-05 未建，§5.4） |
| `optimization` 优化历史 | `optimization_run` + `optimization_draft` + `publication_record` + `rollback_task` + `observation_plan`（**已有**） | 逐轮运行（状态 / 起止 / 草案数 / 草案版本 / 报告是否有正文）+ 每轮草案逐字段 before→after + 采纳三态 + 发布记录（含偏离）+ 回滚任务 + 观测计划；**「草案的采纳时间与操作人」明说本仓没有来源**（§6.4） |
| `sources` 来源与审计 | `asin_field_source` + `audit_log` + `snapshot_registry` + `collection_section_result.scheme_version` + `field_conflict` + `asin_archive_event`（**已有**） | ① 逐字段来源行（来源 / 来源类型 / 值 / 置信度 / 观测时间 / 更新时间）② 该 ASIN 的审计流水（**两种 `object_id` 形状都读**）③ 版本索引 ④ 每条读数用了哪一版采集方案 ⑤ 待裁决冲突 ⑥ 归档事件；**「哪些批量导入动过这条 ASIN」明说本仓没有来源**（`asin.import` 的 `object_id` 是 null，§7.5） |

### 0.2 这一批明确不做（非目标）

1. **不加任何迁移。** 五个 Tab 全部**读**既有表（`asin_keyword` / `keyword` / `collection_section_result` / `competitor_set` / `kw_competitor_fact` / `optimization_run` / `optimization_draft` / `publication_record` / `rollback_task` / `observation_plan` / `asin_field_source` / `audit_log` / `snapshot_registry` / `field_conflict` / `asin_archive_event`）。`SCHEMA_VERSION` 停在 **45**。理由见 §9：本仓已发生两次迁移撞号（v40 / v42），而不加迁移的收益是**撞号风险归零**。
2. **不加任何工具、不加任何路由。** 五个 Tab 全部挂在既有的 `buildAsinDetail` → `amzn_asin_detail` + `GET /api/asin-detail` 这一对门上（§2.1）。`TOOLS` 停在 **133**。`amzn_asin_detail` 的 `tab` 枚举由 `[...ASIN_DETAIL_TABS, 'all']` 派生，所以它自动从 5 个合法值变成 10 个 —— **不是**新工具。
3. **不写任何东西。** 五个 Tab 一个字节都不写库、不落审计（`amzn_asin_detail` 在 `WRITE_TARGETS` 里已经是 `null`，本批**不动** `targets.js`）。所以 `docs/architecture/API-B05c-*.md` §6 里那张表不受影响。
4. **不建「排名历史」表、不建「维度对比矩阵」表、不建「口碑主题」表、不建 Q&A 采集节、不建导入溯源列。** 这五样是本批**点名说清「本仓没有来源」**的对象（§3.5 / §4.4 / §5.4 / §6.4 / §7.5），不是被漏掉的实现。
5. **不改 `src/domain/observe/**`。** 本批在复核中发现 `domain/observe/metrics.js:107` 的 `history: 'append-only'` 对 `asin_keyword` **不成立**（§3.6），只登记、不修（不在写作用域）。
6. **不碰** `src/sources/**`、`src/domain/collect/**`、`src/domain/optimize/**`、`src/domain/prompts/**`、`src/store/prompt.js`、`src/tools/prompt.js`、`src/domain/dashboard/**`、`src/domain/rules/**`、`src/domain/keywords/**`（**只 import** `competitor.js` 的分类器与 `readCompetitorSides`，一个字节都不改）。
7. **不做 F05-06 父子变体、F05-08 ASIN 归档。** 归档事件只在 `sources` Tab 里**读**（`listArchiveEvents`，`detail.js` 已经在读同一个调用）。
8. **不做真机采集**、**不 `git commit`**。

### 0.3 写作用域（与主理人任务书一致）

`src/domain/asin/**`、`src/tools/asin.js`、`src/web/page.js` 与 `src/web/routes.js` 的 **ASIN 区**、
`src/store/queries.js`、`src/store/schema.js`（本批不动）、`src/domain/audit/targets.js`（本批不动）、
`index.js` 与 `src/tools/index.js` 的**工具注册**（本批不动）、`tests/**`、`docs/architecture/API-B05d-*.md`。

---

## 1. 现状复核（逐条 `verified`）

### 1.1 需求文档 §3.5 第 168 行说的「9 个 Tab 一个都没有」——**已过期（`stale`）**

需求文档写的是 `panel-asin 仅含 #table 与 #coverage`、`全页无 asindetail/drawer`。**实测（`d6cfc0c`）已经不是这样**：

| 现状 | 证据 |
|---|---|
| `#asindetail` 容器、`.asin-*` CSS、三个注入常量都在 | `src/web/page.js:773`、`:602-628`、`:1190-1192` |
| 详情区客户端那一半已接线（fetch + 页签 + 重画） | `src/web/page.js:8664-9037`（`loadAsinDetail` / `renderAsinDetail` / `wireAsinDetail` / `asinBody`） |
| 服务端一个 builder、两条门 | `src/domain/asin/detail.js:62` `buildAsinDetail`；门是 `src/tools/asin.js:511` `amzn_asin_detail` 与 `src/web/routes.js:2083` `GET /api/asin-detail` |
| **四个** Tab 已建 | `src/domain/asin/detail.js:32` `ASIN_DETAIL_TABS = ['overview','fields','sections','variants']` |
| **五个** Tab 被点名为「还没建」 | `src/domain/asin/detail.js:48-54` `ASIN_DETAIL_PENDING_TABS`（`keywords` / `reviews` / `competitor` / `optimization` / `sources`） |
| 页面把未建的五个画成 `disabled` 并印一句「不是没有数据，是还没有这一页」 | `src/web/page.js:9003-9014` |

**所以本批的起点不是「9 个 Tab 一个都没有」，而是「4 个已建 + 5 个已点名未建」。**
本批把那五个做完，并把 `ASIN_DETAIL_PENDING_TABS` 清空（§2.2）。

### 1.2 后五个 Tab 各自的数据源：**逐个实测「有 / 没有」**

| Tab | 数据源 | 结论 | 证据 |
|---|---|---|---|
| `keywords` | `asin_keyword`（v2 建表，v6 扩 `page`/`scan_depth`/`tier`/`tier_basis_json`） | **有** | `src/store/schema.js:448`（建表）、`:560-563`（扩列）、`:576`（`idx_asin_keyword_rank`）；写路径 `src/store/queries.js:556` `upsertAsinKeyword`，生产调用方 `src/sources/keyword.js:320`（采集）与 `src/tools/keyword.js:252` |
| `keywords` 的**排名历史** | —— | **没有** | `asin_keyword` 主键是 `(asin, marketplace, keyword, source_id)`，`upsertAsinKeyword` 的 `ON CONFLICT … DO UPDATE SET rank = excluded.rank`（`queries.js:572-579`）**原地覆盖**。实测：同一 `(asin, keyword, source)` 观测两次 → **1 行**，只留最新名次（§3.6 有原文） |
| `reviews` 的评论 | `collection_section_result` 的 `section='reviews'` 读数 | **有** | 节定义 `src/domain/collect/sections.js:92-97`（`reviews_total` / `reviews_visible` / `review_summary` / `review_items`）；表 `src/store/schema.js:2527`；写路径 `src/sources/browser/collector.js:200/219` `recordSectionResult`；读路径 `src/store/collection-section.js:282` `listSectionResultsWithCoverage`（`src/domain/asin/sections.js:105` 已在用） |
| `reviews` 的 **Q&A** | `qa_1..8` | **没有** | 字段声明在 `src/domain/rules/listing-fields.js:152-159`（`section: 'qa'`、`amazonPath: 'customer_questions_and_answers'`、`kind: 'pair'`），但 **13 个采集节里没有 `qa`**（`src/domain/collect/sections.js:53-105` 逐条读过）；优化器自己标 `notModelled('qa')`（`src/domain/optimize/evidence.js:418`，note 取自 `NOT_MODELLED_NOTES`） |
| `competitor` 的组归属 | `competitor_set` | **有** | `src/store/schema.js:1194`（`asins_json` + `marketplace` + `note`）；读路径 `src/store/kw.js` 的 `listCompetitorSets` / `getCompetitorSet`（`src/web/routes.js:53` 已在用） |
| `competitor` 的逐词对比 | `kw_competitor_fact` + `asin_keyword` | **有** | 表 `schema.js:718`；两侧读取 `src/store/kw.js:970` `readCompetitorSides`；分类器 `src/domain/keywords/competitor.js:270/290/339`；品牌隔离 `src/store/keyword-ownership.js:430` `competitorBrandHits` |
| `competitor` 的**维度对比矩阵** | —— | **没有** | 47 张表里没有维度对比表（`schema.js` 的 `CREATE TABLE` 全清单，本次实读）；`src/domain/keywords/competitor.js` 只做关键词侧 |
| `competitor` 的**口碑主题** | —— | **没有** | 表清单无 `review` / `theme` 表（同上）；`kw_competitor_fact` 只存排名与搜索量（`schema.js:718-748`） |
| `optimization` 的运行与草案 | `optimization_run` / `optimization_draft` | **有** | 表 `schema.js:471/482`（`report_html` 见 `:601`、`rationale`/`keywords_json`/`severity`/`updated_at` 见 `:606-609`、`context_id` 见 `:1310`、`voided_at`/`deferred_at` 见 `:2896-2897`）；读路径 `src/store/queries.js:1237` `listOptimizationRuns`、`:1338` `listOptimizationDrafts` |
| `optimization` 的发布与回滚 | `publication_record` / `rollback_task` / `observation_plan` | **有** | 表 `schema.js:1997` / `:2157`；读路径 `src/store/observe.js:374` `listPublications`、`:1341` `listRollbackTasks`、`:456` `listObservationPlans` |
| `optimization` 的**草案采纳时间与操作人** | —— | **没有** | `optimization_draft` 只有 `accepted INTEGER`（`schema.js:489`）+ `updated_at`（`:609`），**没有** `accepted_at` / `accepted_by` 列；全仓 grep `accepted_at` 只命中 `optimization_plan_check`（`:3095`，B-13c/d 的另一张表，与草案采纳不是同一件事） |
| `sources` 的逐字段来源 | `asin_field_source` | **有** | 表 `schema.js:426`（v24 扩列 `source_type`/`observed_at` 见 `:1606-1612`）；读路径 `src/store/field-source.js:48` `listFieldSources`（`ORDER BY observed_at DESC NULLS LAST`） |
| `sources` 的审计流水 | `audit_log` | **有（两种 `object_id` 形状）** | 表 `schema.js:1838`；读路径 `src/store/audit.js:148` `listAudit`；`object_id` 形状见 §7.2 |
| `sources` 的版本索引 / 采集方案版本 | `snapshot_registry` / `collection_section_result.scheme_version` | **有** | `schema.js:1706`、`:2540`；读路径 `src/store/snapshot.js:257` `listSnapshots` |
| `sources` 的**「哪些批量导入动过这条 ASIN」** | —— | **没有** | `amzn_asin_import` 的 `objectId: () => null`（`src/domain/audit/targets.js:743`，理由写在 `:740-742`：一次导入动的是 N 行）；`impact` 里也只有 `characters` / `sourceId` / `onInvalid` / `onDuplicate`（`:748-755`）——**没有 ASIN**。所以按对象反查不到它，按内容也反查不到 |

### 1.3 页面侧已有的渲染器与注入（本批要接的地方）

| 现状 | 证据 |
|---|---|
| `asinBody(tab, data)` 是**闭集**分派，未实现的 Tab 明说不返回空串 | `src/web/page.js:9526-9533` |
| 词表由服务端注入（脚本里没法 import） | `src/web/page.js:1190-1192`（`ASIN_TAB_ORDER` / `ASIN_TAB_LABELS` / `ASIN_PENDING_TABS`） |
| `ASIN_TAB_ORDER` 与 `ASIN_DETAIL_TABS` 是同一份 | `page.js:1190` 用 `embed([...ASIN_DETAIL_TABS])` |
| 未建的 Tab 画成 `disabled`，并印「不是没有数据，是还没有这一页」 | `page.js:9003-9014` |

---

## 2. 模块与注册

### 2.1 一个 builder、两条门（沿用 `detail.js` 的既有约定）

**不新增工具、不新增路由。** 五个 Tab 的 builder 全部由 `buildAsinDetail` 调用，
结果放进同一个载荷的五个新键：

```
buildAsinDetail({store, asin, marketplace}) → {
  …既有的 ok/asin/marketplace/archived/tabs/tabLabels/pendingTabs/overview/fields/sections/variants/archiveEvents,
  keywords,        // §3
  reviews,         // §4
  competitor,      // §5
  optimization,    // §6
  sources,         // §7
}
```

`amzn_asin_detail`（`src/tools/asin.js:511`）与 `GET /api/asin-detail`（`src/web/routes.js:2083`）
读的是**同一个** `buildAsinDetail`，所以五个 Tab 在两处天然一致 —— 这正是本批不需要新门的原因。
`amzn_asin_detail` 的 `tab` 枚举由 `[...ASIN_DETAIL_TABS, 'all']` 派生（`src/tools/asin.js:509`），
所以它会自动变成 10 个合法值（9 个 Tab + `all`），**不需要手改枚举**。

### 2.2 `ASIN_DETAIL_PENDING_TABS` 清空，并把「已建/未建」的判据留给守卫

- `ASIN_DETAIL_TABS` → **九个**（`overview` / `fields` / `sections` / `variants` / `keywords` / `reviews` / `competitor` / `optimization` / `sources`）。
- `ASIN_DETAIL_TABS` 是 `F05-02` 的**全量**；`ASIN_DETAIL_TAB_LABELS` 九条齐全。
- `ASIN_DETAIL_PENDING_TABS` → **`[]`**，并保留该导出与页面那段 `length === 0 ? '' : …` 的渲染：
  它是「以后再加第十个 Tab 时不会静默消失」的那道**守卫**，而不是一份「声明了却没有来源」的名单。
  本批加一条断言钉住 `pendingTabs.length === 0` **且**页面不再印「还没建」那句，
  另加一条钉住 `asinBody` 对**未知** Tab 仍然明说（守卫本身不能因为清空而消失）。
- 页面不再画 `disabled` 页签：九个页签全部可点（断言钉 `disabled === 0`）。

### 2.3 本批落盘的文件

| 文件 | 新增/改 | 是什么 |
|---|---|---|
| `src/domain/asin/unsourced.js` | 新 | 「本仓没有来源」的**唯一**文案与条目工厂（§8.1） |
| `src/domain/asin/keywords.js` | 新 | §3 关键词与排名 |
| `src/domain/asin/reviews.js` | 新 | §4 评论问答 |
| `src/domain/asin/competitor.js` | 新 | §5 竞品对比（**只 import** `domain/keywords/competitor.js`，不抄分类器） |
| `src/domain/asin/optimization.js` | 新 | §6 优化历史 |
| `src/domain/asin/provenance.js` | 新 | §7 来源与审计 |
| `src/domain/asin/detail.js` | 改 | 九个 Tab、清空 pending、调五个新 builder |
| `src/domain/asin/health.js` | 改 | `ASIN_HEALTH_NO_SOURCE_TEXT` 改为 import 自 `unsourced.js`（同一句文案只有一份） |
| `src/tools/asin.js` | 改 | `amzn_asin_detail` 的 description 与 `renderAsinDetailText` 五块 |
| `src/web/page.js` | 改 | `asinBody` 分派 + 五个 body 渲染器 + 注入新词表 |
| `src/web/routes.js` | **未改** | `/api/asin-detail` 原样返回整个载荷（§2.1） |
| `src/store/queries.js` / `schema.js` / `targets.js` | **未改** | 五个 Tab 全读既有表；`amzn_asin_detail` 已是只读（`targets.js:584`） |
| `tests/b05d-tabs.mjs` / `b05d-page.mjs` / `b05d-honesty.mjs` | 新 | 三支测试（域层 / 页面 / 诚实性） |
| `tests/b05-asin-detail.mjs` / `b05-asin-page.mjs` / `tests/run.mjs` | 改 | 把「4 个 Tab + 5 个未建」的**过期断言**改成九个 Tab（§11.4 逐条列出） |

---

## 3. `keywords` 关键词与排名

### 3.1 模块与入参

`src/domain/asin/keywords.js`（新）。**一个 builder**：`buildAsinKeywordView(store, {asin, marketplace, limit})`。

| 名字 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `asin` | string | ✅ | 10 位字母/数字 |
| `marketplace` | string | ✅ | 站点；同一个 ASIN 在不同站点是两条记录 |
| `limit` | number | | 逐词行数上限，默认 **200**，上限 **1000**（`clamp`） |

### 3.2 出参

```js
buildAsinKeywordView(store, {asin, marketplace, limit}) → {
  ok: true, asin, marketplace, source: 'asin_keyword + keyword',
  rows: [{ keyword, rank, page, scanDepth, tier, tierBasis, searchVolume, collectedAt, sourceId,
           state, stateLabel, master: { tier, searchVolume, difficulty } | null }],
  counts: { rows, ranked, absent, unranked, sources, withMaster },
  totals: { rows, limit, truncated },      // truncated = 库里比 limit 多（列表被截断）
  states: [...ASIN_KEYWORD_STATES],
  stateLabels: {...ASIN_KEYWORD_STATE_LABELS},
  unsourced: [...],                        // §3.5
  noSourceText: ASIN_NO_SOURCE_TEXT,
  notes: [...]
}
```

### 3.3 三态**由内容推出**（判据**委派**给既有实现，不写第二份）

```js
ASIN_KEYWORD_STATES = ['ranked', 'absent', 'untested']
ASIN_KEYWORD_STATE_LABELS = { ranked: '有名次', absent: '测过、没找到', untested: '未测（没有扫描深度）' }
```

| `state` | 判据 |
|---|---|
| `ranked` | `classifyOurSide` 判为 `ranked`（`rank` 有值） |
| `absent` | `classifyOurSide` 判为 `absent`（`rank` 空 ∧ **`scan_depth` 有值**） |
| `untested` | 以上皆不命中（`rank` 空 ∧ `scan_depth` 空） |

⚠️ **⚠️ 实现期订正（草稿里第 2/3 条的判据原本写的是 `collected_at`）**：那一版是**错的**，
而且是本仓最贵的那一类错 —— 同一条规则的第二份实现。`domain/keywords/competitor.js` 的
`classifyOurSide` 已经回答了同一个问题（它的注释原话：「a null rank with no `scan_depth`
cannot support the claim 'we are absent'」），判据是 **`scan_depth`**。按 `collected_at` 判的
第一版在真实一行上就与竞品页分叉了：一行「有采集时间、没有扫描深度」的词，关键词页说
「测过、没找到」，竞品页说「未测」——**同一页上的两个词说同一件事的两个答案，而且两边都不报错**。
所以现在 `classifyKeywordState` **只**做一次转调（`scanDepth ?? scan_depth` 的命名兼容），
三态的**名字**也改成 `classifyOurSide` 已经在用的那三个，好让两个页签不可能把同一个词说成两样。

**计数是 `rows` 的重算**，不是累加器：`counts.ranked = rows.filter(r => r.state === 'ranked').length`，
`counts.rows = rows.length`，且 `ranked + absent + untested === rows`。

### 3.4 「一条规则一份实现」

`state` / `stateLabel` 在 domain 算出，**页面只印 `row.stateLabel`**。
页面里不出现 `scanDepth ===` 这类**状态判据**（§11.3 的 `!includes` 断言钉它）；
页面把 `rank === null` 印成「—（没有名次）」属于**呈现**（「没有数据 ≠ 数据是 0」要求的动作），
不是状态判断，所以不在禁列里。

### 3.5 「本仓没有来源」：排名历史

`unsourced` 里一条，`feature: 'F05-02'`：

- `id: 'keyword-rank-history'`、`label: '关键词排名的历史变化'`、`conclusion: ASIN_NO_SOURCE_TEXT`（值 = `本仓没有来源`）
- `reason`：
  `asin_keyword 的主键是 (asin, marketplace, keyword, source_id)，upsertAsinKeyword 对同一个来源是原地覆盖（rank = excluded.rank，src/store/queries.js:572-579），没有任何列或表记录「这个词的名次在两次观测之间怎么变」。所以这里报的是**当前**名次，不是趋势；跨来源的多行仍然各自保留（那是「同一时刻不同来源的读数」，不是历史）。`

⚠️ **区分**：「没测到」（这一行都没有）与「没有来源」（有行、但表结构不存历史）是两句不同的话。
前者是 `state: 'absent'` 或 `rows` 里根本没有这个词，后者是 `unsourced[]` 里的一条。

### 3.6 ⚠️ 复核中发现的一处「注释与代码不符」（缺陷，**不在本批写作用域**，只登记）

`src/domain/observe/metrics.js:107` 给 `organic-rank` 标的 `history: 'append-only'`，
注释（`:92-93`）写「每观测一次追加一行（asin_keyword、kw_ad_fact）」。**实测不成立**：

```
$ node .tmp-probe-b05d-rankhistory.mjs
{
  "seededSources": ["browser-local","sellersprite","xiyou","saihu","manual"],
  "rowCount": 1,
  "rows": [ { "keyword": "first observation", "rank": 40, "collected_at": "2026-02-01T00:00:00.000Z" } ],
  "metricsClaim": "history: append-only (domain/observe/metrics.js:107)"
}
```

两次观测（`rank` 12 @ 2026-01-01、`rank` 40 @ 2026-02-01）之后只剩 **1 行**，名次是 40。
`asin_keyword` 对同一个 `(asin, marketplace, keyword, source_id)` 是**只保留当前值**，
所以 `observe` 的基线窗口在这个指标上读不到过去的值。
**本批不改**（`src/domain/observe/**` 不在写作用域）：按本仓纪律登记在此，
并把它作为 `keywords` Tab 「排名历史没有来源」的**同一个事实**的另一处证据。

---

## 4. `reviews` 评论问答

### 4.1 模块与入参

`src/domain/asin/reviews.js`（新）。**一个 builder**：
`buildAsinReviewView(store, {asin, marketplace, sections})`。

`section` 读数**注入**，与 `buildAsinHealthSummary` 要 `fields` / `precheck` 同一条纪律：

- `sections`：`buildSectionView(store, {asin, marketplace})` 的产出，**必填**。
  `buildAsinDetail` 已经为 `sections` Tab 建过一次，**本 Tab 复用同一个对象**，
  不第二次读 `collection_section_result`、不第二次算「哪一行是最新的」。
  传 `undefined` 当场抛错（编程错误，不是用户输入问题）。

### 4.2 出参

```js
buildAsinReviewView(store, {asin, marketplace, sections}) → {
  ok: true, asin, marketplace,
  source: 'collection_section_result#reviews',
  state, stateLabel,                  // §4.3
  section: { id:'reviews', label:'评论', order:11, status, statusLabel,
             collectedAt, taskId, schemeVersion, snapshotRef, contentUnread, errors } | null,
  totals: { reviewsTotal, reviewsVisible },     // 页面没有时是 null，不是 0
  summary: string | null,
  items: [{ index, rating, title, body, author, at, verified }],   // 逐条样本，上限 REVIEW_ITEM_LIMIT = 50
  itemCount, itemsTruncated,
  fields: [{ id, label, present, value }],      // 四格读数逐格给，缺的那格明说
  states: [...ASIN_REVIEW_STATES],
  stateLabels: {...ASIN_REVIEW_STATE_LABELS},
  unsourced: [...],                   // §4.4
  noSourceText: ASIN_NO_SOURCE_TEXT,
  notes: [...]
}
```

### 4.3 状态**由内容推出**（四态，不是三态）

```js
ASIN_REVIEW_STATES = ['ok', 'empty', 'never-collected', 'unreadable']
ASIN_REVIEW_STATE_LABELS = {
  ok: '有评论读数',
  empty: '采到了、评论这一节是空的',
  'never-collected': '从没采过评论这一节',
  unreadable: '试过、这一节没读出来',
}
```

| `state` | 判据（顺序即判据） |
|---|---|
| `never-collected` | `sections` 里 `reviews` 那一节 `notCollected === true`（或 `sections` 里没有 `reviews`） |
| `unreadable` | 那一节的 `status` ∈ `{'failed','blocked'}`（**试过、没读出来**） |
| `empty` | 那一节采到了，但四格读数**一格有值都没有** |
| `ok` | 以上皆不命中（四格里至少一格有值） |

⚠️ **实现期订正（草稿里是三态）**：草稿把「试过、没读出来」并进了 `empty`，那会让
「页面没有评论」与「读取器挂了」印同一句话，而两者的动作相反（查商品 vs 修读路径）。
所以加了第四态 `unreadable`，判据取自 B-04 的五态词表里那两个「没读出来」的状态
（`failed` / `blocked`），不是新造的。四态的**标签两两不等**是断言（§11 断言 ⑦）。

⚠️ 这四态互不相同：`never-collected` 是「没测过」（动作 = 去采），`empty` 是「测了、页面没有评论」
（动作 = 查为什么），`ok` 是「有读数」。**合并前两者正是本仓最忌讳的读法。**

⚠️ `empty` 与 `totals.reviewsTotal === 0` **不是一回事**：一个 0 条评论的商品
`reviewsTotal` 是**测出来的 0**，属于 `ok`；`empty` 是「读数里连 0 都没有」。

### 4.4 「本仓没有来源」：Q&A

`unsourced` 里一条，`feature: 'F05-02'`：

- `id: 'qa-pairs'`、`label: '买家问答（Q&A）'`、`conclusion: ASIN_NO_SOURCE_TEXT`
- `reason`：
  `Q&A 有字段声明（qa_1..qa_8，src/domain/rules/listing-fields.js:152-159，amazonPath customer_questions_and_answers），但 13 个采集节里没有一节读它（src/domain/collect/sections.js:53-105 只有 basic/bullets/images/variations/attributes/description/aplus/video/seo_meta/bsr/reviews/page_signals/related_competitors），优化器自己也把它标成 notModelled（src/domain/optimize/evidence.js:418）。所以「有字段」不等于「有来源」：本仓没有任何一条路径把 Q&A 写进库。`

⚠️ **「没有建模」与「没测到」必须分开**：Q&A 是**没有建模**（没有采集节、优化器显式
`notModelled`），不是「采了但这次没采到」。所以它进 `unsourced[]`，不进 `state: 'empty'`。

---

## 5. `competitor` 竞品对比

### 5.1 模块与入参

`src/domain/asin/competitor.js`（新）。**一个 builder**：
`buildAsinCompetitorView(store, {asin, marketplace, limit})`。

| 名字 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `asin` | string | ✅ | |
| `marketplace` | string | ✅ | 竞品组是分站点的（`competitor_set.marketplace`） |
| `limit` | number | | 每象限行数上限，默认 **`QUADRANT_PAGE_SIZE`**（40，**唯一上限**，import 自 `domain/keywords/competitor.js`） |

### 5.2 出参

```js
buildAsinCompetitorView(store, {asin, marketplace, limit}) → {
  ok: true, asin, marketplace,
  source: 'competitor_set + readCompetitorSides + classifyQuadrants',
  membership: [{ id, name, note, memberCount, updatedAt, containsThis, peers: [...], peersMissing: [...] }],
  memberSets: number,          // 含有这条 ASIN 的组数
  peers: [...],                // 这些组的成员并集，去掉自己
  peersSource: string,         // 「成员并集来自哪几个组」
  comparison: null | {
    quadrants: { ownAdvantage: [...], contested: [...], ourAbsent: [...], unmeasured: [...], brandOnly: [...] },
    counts: {...}, order: [...QUADRANT_ORDER], labels: {...QUADRANTS},
    inputTotal, classified, candidates: [...], isolated: [...],
    limit, truncated: bool,
  },
  comparisonNote: string | null,   // 没有竞品组 / 没有对端事实时的四句不同的话（§5.3）
  unsourced: [...],                // §5.4
  noSourceText: ASIN_NO_SOURCE_TEXT,
  notes: [...]
}
```

### 5.3 「一条规则一份实现」：五桶分类**不抄第二份**

- 组归属的 SQL 只有一份：`listCompetitorSets`（`src/store/kw.js`）。
- 两侧事实的读取只有一份：`readCompetitorSides`（`src/store/kw.js:970`）。
- 分类只有一份：`quadrantRows` + `classifyQuadrants` + `QUADRANTS` + `QUADRANT_ORDER`
  （`src/domain/keywords/competitor.js`）。本批**只 import，一个字节不改**。
- 品牌隔离只有一份：`competitorBrandHits`（`src/store/keyword-ownership.js:430`）。

**`comparison: null` 是正常态**，且有**四句互不相同**的 `comparisonNote`：

| 情形 | `comparison` | `comparisonNote` |
|---|---|---|
| 这条 ASIN 不在任何竞品组里 | `null` | `这条 ASIN 不在任何竞品组里 —— 没有对端，就无从对比（不是「对比结果是空」）` |
| 在组里，但所有组的成员都只有它自己 | `null` | `这些竞品组里只有它自己 —— 没有对端` |
| 有对端，但对端一条 `kw_competitor_fact` 都没有 | 非 `null` | `对端没有任何关键词事实（kw_competitor_fact 里没有这些 ASIN 的行）—— 这是「没测到」，不是「它们没有词」` |
| 有对端且有事实 | 非 `null` | `null` |

### 5.4 「本仓没有来源」：维度对比矩阵与口碑主题

`unsourced` 里两条，`feature: 'F05-02'`：

1. `id: 'dimension-matrix'`、`label: '按维度字段的对比矩阵'`、`conclusion: ASIN_NO_SOURCE_TEXT`
   `reason`：`F06-03 的对比矩阵（行=维度字段、列=自有+竞品）本仓没有来源：schema 里没有维度对比表，
   domain/keywords/competitor.js 只做关键词侧。这里能给的对比是**关键词侧**的五桶分类，不是字段矩阵。`
2. `id: 'review-topics'`、`label: '口碑主题'`、`conclusion: ASIN_NO_SOURCE_TEXT`
   `reason`：`F06-05 的口碑主题本仓没有来源：表清单里没有评论主题表（optimization_review 是优化审阅的
   裁决记录，不是口碑主题；asin_variant_dimension 是变体维度，也不是），
   kw_competitor_fact 只存排名与搜索量（src/store/schema.js:718-748）。
   所以这里没有任何可引用的评论样本与时间窗。`

⚠️ **实现期订正**：草稿的 reason 写的是「表清单里没有 review / theme 表」，而这条**不准确**：
`optimization_review` 与 `asin_variant_dimension` 都含那两个子串。断言若按子串搜，就会在这两张
**别的**表上红，然后被人改成搜别的东西、从此不再守着任何事。所以 reason 改成点名这两张表，
断言改成 `tables.some(name => /^(review|theme)/i.test(name)) === false` **加上**两条
「那两张表确实在，且不是这两件事」的正向断言（§11 断言 ⑧ 的 H9）。

---

## 6. `optimization` 优化历史

### 6.1 模块与入参

`src/domain/asin/optimization.js`（新）。**一个 builder**：
`buildAsinOptimizationView(store, {asin, marketplace, limit})`。

| 名字 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | number | | 运行数上限，默认 **20**，上限 **200**（与 `listOptimizationRuns` 自己的 `clamp(…,1,200)` 同口径） |

### 6.2 出参

```js
buildAsinOptimizationView(store, {asin, marketplace, limit}) → {
  ok: true, asin, marketplace,
  source: 'optimization_run + optimization_draft + publication_record + rollback_task + observation_plan',
  runs: [{ id, status, statusLabel, startedAt, finishedAt, draftCount, draftVersion,
           rulesVersion, hasReport, sessionId,
           drafts: [{ id, field, before, after, accepted, acceptedLabel, severity, rationale,
                      keywords, violations, voidedAt, deferredAt, updatedAt }],
           draftsTruncated }],
  runCount, runsTruncated,
  totals: { runs, drafts, accepted, declined, pending, voided, deferred },
  publications: [{ id, kind, publishedAt, runId, draftVersion, deviated, deviationRule,
                   baselineChoice, approvedFields, publishedFields, uncoveredFields,
                   rollbacks: [{ id, status, createdAt, closedAt }],
                   observationPlans: [{ id, status, metricCount, windowStart, windowEnd }] }],
  publicationCount,
  statuses: [...ASIN_RUN_STATUSES], statusLabels: {...},
  acceptanceStates: [...ASIN_ACCEPTANCE_STATES], acceptanceLabels: {...},
  unsourced: [...],                  // §6.4
  noSourceText: ASIN_NO_SOURCE_TEXT,
  notes: [...]
}
```

### 6.3 两个「由内容推出」的状态

```js
ASIN_ACCEPTANCE_STATES = ['accepted', 'declined', 'pending', 'voided', 'deferred']
ASIN_ACCEPTANCE_LABELS = { accepted:'已采纳', declined:'未采纳', pending:'待裁决',
                           voided:'已作废', deferred:'已延后' }
```

`accepted` 是 `optimization_draft` 的**三态整数**（`1` / `0` / `null`），本批再叠上
`voided_at` / `deferred_at` 两个新列，判据**顺序即判据**：

| `acceptedLabel` | 判据 |
|---|---|
| `voided` | `voided_at` 非空 |
| `deferred` | `deferred_at` 非空 |
| `accepted` | `accepted === 1` |
| `declined` | `accepted === 0` |
| `pending` | `accepted === null`（**没裁决过**，不是「裁决成未知」） |

⚠️ `voided` / `deferred` 排在 `accepted` 之前：一条先被采纳、后被作废的草案，
它的**当前**处置是「已作废」；把 `accepted === 1` 印成「已采纳」会让读者去采纳一条已经作废的改动。

**计数是 `runs[].drafts` 的重算**（`totals.accepted = drafts.filter(…).length`），不是累加器。

### 6.4 「本仓没有来源」：草案的采纳时间与操作人

`unsourced` 里一条，`feature: 'F05-02'`：

- `id: 'draft-acceptance-audit'`、`label: '草案被采纳的时间与操作人'`、`conclusion: ASIN_NO_SOURCE_TEXT`
- `reason`：
  `optimization_draft 只有 accepted INTEGER 一列（src/store/schema.js:489）与 updated_at（:609），没有 accepted_at / accepted_by。updated_at 是「最后一次写这一行」，它也会被 voided_at / deferred_at 的写入推走，所以从这一行读不出「谁在什么时候采纳了它」。全仓 grep accepted_at 只命中 optimization_plan_check（:3095，B-13c/d 的另一张表）。`

---

## 7. `sources` 来源与审计

### 7.1 模块与入参

`src/domain/asin/provenance.js`（新）。**一个 builder**：
`buildAsinSourceView(store, {asin, marketplace, auditLimit, snapshotLimit})`。

| 名字 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `auditLimit` | number | | 审计行数上限，默认 **50**，上限 **500**（`listAudit` 自己上限 1000） |
| `snapshotLimit` | number | | 版本索引条数上限，默认 **50** |

### 7.2 ⚠️ 审计的 `object_id` 有**两种**形状（实测），本批两种都读

| 写动作 | `object_type` | `object_id` | 证据 |
|---|---|---|---|
| `amzn_asin_upsert`（`asin.upsert`） | `asin` | **裸 ASIN**（`<ASIN>`） | `src/domain/audit/targets.js:661-664` |
| `amzn_asin_field_correct`（`asin.field_correct`） | `asin` | `<ASIN>@<MKT>` | `:679-682` |
| `amzn_asin_archive`（`asin.archive`） | `asin` | `<ASIN>@<MKT>` | `:701-704` |
| 页面 `asin-field-correct` / `asin-archive` | `asin` | `<ASIN>@<MKT>` | `:2023` / `:2044` |
| `amzn_asin_variant_upsert` / `_correct` | `asin_variant` | `<PARENT>-><CHILD>@<MKT>` | `:342`、`:686-700` |
| `amzn_asin_import`（`asin.import`） | `asin` | **`null`** | `:737-743` |
| `amzn_asin_view_save` / `_delete` | `asin_view` | 视图名 | `:724-734` |

所以「这条 ASIN 的审计流水」= **三条查询的并集**（不是一条 `object_id = ?`）：

1. `object_type = 'asin'` ∧ `object_id IN ('<ASIN>', '<ASIN>@<MKT>')`
2. `object_type = 'asin_variant'` ∧ (`object_id LIKE '<ASIN>->%'` ∨ `object_id LIKE '%-><ASIN>@%'`) —— 这条 ASIN 是父体或子体的变体写入
3. `object_type = 'asin_view'` ∧ 视图名里的 `asins_json` 含这条 ASIN —— **本批不做**（视图与 ASIN 的关联要读 `asin_saved_view` 的 JSON，属于 F05-01 的契约），登记为**已知边界**写进 `notes`

每条审计行带 `objectIdForm`（`'bare'` / `'qualified'` / `'variant'` / `'null'`）与 `matchedBy`，
**由内容推出**，页面只印 —— 页面不许自己判 `object_id.includes('@')`。

### 7.3 出参

```js
buildAsinSourceView(store, {asin, marketplace, auditLimit, snapshotLimit}) → {
  ok: true, asin, marketplace,
  source: 'asin_field_source + audit_log + snapshot_registry + collection_section_result + field_conflict + asin_archive_event',
  fieldSources: [{ field, sourceId, sourceType, sourceTypeLabel, value, confidence, observedAt, updatedAt,
                   state, stateLabel }],
  fieldCount, sourceCount,
  byField: [{ field, sources: [...], distinctValues, conflicted }],
  audit: [{ id, at, actor, actorKind, action, actionLabel, objectType, objectId, objectIdForm, matchedBy,
            route, reason, impact }],
  auditCount, auditTruncated,
  snapshots: [{ id, objectType, objectId, version, refTable, refId, createdAt, createdBy, archivedAt, note }],
  snapshotCount,
  schemeVersions: [{ section, schemeVersion, collectedAt, taskId }],
  conflicts: [{ id, field, status, adoptedValue, adoptedSourceId, openedAt, resolvedAt, resolvedBy, note }],
  archiveEvents: [...],             // 复用 detail.js 已读的那一份
  sourceTypes: [...SOURCE_TYPES], sourceTypeLabels: {...},
  auditObjectIdForms: [...ASIN_AUDIT_ID_FORMS], auditObjectIdFormLabels: {...},
  unsourced: [...],                 // §7.5
  noSourceText: ASIN_NO_SOURCE_TEXT,
  notes: [...]
}
```

### 7.4 「一条规则一份实现」

- 字段来源的读取只有一份：`listFieldSources`（`src/store/field-source.js:48`）。
- 「同字段多源不同值」的折叠只有一份：`fieldConflictsOf`（`src/domain/asin/conflicts.js`，B-05c 已建）。
  本 Tab **import 它**，不写第二条分组判据。
- 审计的读取只有一份：`listAudit`（`src/store/audit.js:148`）。
- 版本索引的读取只有一份：`listSnapshots`（`src/store/snapshot.js:257`）。
- `sourceTypeLabel` / `objectIdForm` / `stateLabel` 在 domain 算出，**页面只印**。

### 7.5 「本仓没有来源」：哪些批量导入动过这条 ASIN

`unsourced` 里一条，`feature: 'F05-02'`：

- `id: 'import-attribution'`、`label: '哪些批量导入动过这条 ASIN'`、`conclusion: ASIN_NO_SOURCE_TEXT`
- `reason`：
  `一次批量导入的审计行 object_id 是 null（src/domain/audit/targets.js:743，理由在 :740-742：一次导入动的是 N 行），impact 里只有 characters / sourceId / onInvalid / onDuplicate（:748-755），没有 ASIN。所以按对象反查不到它，按内容也反查不到它 —— 「这条 ASIN 的某个字段是被哪一次导入覆盖的」在本仓没有来源。要能回答它得给 asin.import 的 impact 加一份 ASIN 清单（或给字段来源行记导入批次），那是迁移与新表，不在本批。`

---

## 8. 词表与「本仓没有来源」的唯一文案

### 8.1 `src/domain/asin/unsourced.js`（新）

```js
export const ASIN_NO_SOURCE_TEXT = '本仓没有来源'

/** 一条「本仓没有来源」。`conclusion` **逐字**是上面那句，`reason` 说清为什么。 */
export function unsourced({ id, label, feature, reason }) {
  return { id, label, feature, state: 'no-source', conclusion: ASIN_NO_SOURCE_TEXT, reason }
}
```

- `health.js` 的 `ASIN_HEALTH_NO_SOURCE_TEXT` 改为 `export const ASIN_HEALTH_NO_SOURCE_TEXT = ASIN_NO_SOURCE_TEXT`
  —— **导出名不变**（既有断言与页面注入都还用那个名字），但**字面量只有一份**。
- 五个 Tab 的 `noSourceText` 都是 `ASIN_NO_SOURCE_TEXT`，页面从载荷里读，不自己写这句话。

### 8.1b `src/domain/asin/limits.js`（新，实现期加的）

`clampLimit(value, fallback, max)` —— 五个 Tab 共用的那**一处**数值钳制。草稿的文件清单里
没有它，实现期发现五个 builder 各写一遍 `Math.min(Math.max(...))` 就是五处会把硬上限写错的地方，
而且**0 / null / '' / NaN** 这四种「没给」的写法必须行为一致，否则「上限悄悄变成 1」这一类错
会在某一个 Tab 上单独出现。它同时钉住本仓既有的约定：**`0` 也是「没给」**（`queries.js` 的
`filters.limit ?? 30`、`store/audit.js` 的 `Number(...) || 100`、`listRollbackTasks` 的
`Number(limit) || 50` 都是这个行为）。负数**不**落默认值，钳到 1 —— 一个负数不是「没给」，
是一个坏数字。这两条都是**写明了的决定**，不是巧合，断言逐条钉（§11 断言 ⑨ 的 L1）。

### 8.2 词表清单（各一份，页面与服务端共读）

| 词表 | 在哪 | 页面怎么拿 |
|---|---|---|
| `ASIN_KEYWORD_STATES` / `_LABELS` | `domain/asin/keywords.js` | 载荷 `states` / `stateLabels` |
| `ASIN_REVIEW_STATES` / `_LABELS` | `domain/asin/reviews.js` | 载荷 `states` / `stateLabels` |
| `QUADRANTS` / `QUADRANT_ORDER` | `domain/keywords/competitor.js`（**已有**） | 载荷 `comparison.labels` / `.order` |
| `ASIN_RUN_STATUSES` / `_LABELS` | `domain/asin/optimization.js` | 载荷 `statuses` / `statusLabels` |
| `ASIN_ACCEPTANCE_STATES` / `_LABELS` | `domain/asin/optimization.js` | 载荷 `acceptanceStates` / `acceptanceLabels` |
| `SOURCE_TYPES` | `store/field-source.js`（**已有**） | 载荷 `sourceTypes` / `sourceTypeLabels` |
| `ASIN_AUDIT_ID_FORMS` / `_LABELS` | `domain/asin/provenance.js` | 载荷 `auditObjectIdForms` / `auditObjectIdFormLabels` |
| `ASIN_NO_SOURCE_TEXT` | `domain/asin/unsourced.js` | 载荷 `noSourceText` |

⚠️ `ASIN_RUN_STATUSES` 不是本批发明的：它是 `optimization_run.status` 的闭集，
**从 `src/store/queries.js` 的 `assertRunStatus` 派生**（本批 import 那个判据，不抄一份）。

---

## 9. 迁移与回滚

- **迁移：无。** `MIGRATIONS` 与 `SCHEMA_VERSION` **本批**不动（开工基线 45；合并 main 后
  基线是 **46**，来自 t5-archive 的 `asin-archive-index`，**不是本批加的** —— 见文首订正）。
  开工前与每次合并后各跑一次 `node scripts/check-migrations.mjs`，输出必须与**当时的**基线一致；
  收尾实测：`count 46` / `SCHEMA_VERSION 46` / `dups []` / `continuous true` / `last asin-archive-index`。
- **为什么敢不加**：五个 Tab 全部读既有表（§0.2 第 1 条）。唯一「像要新表」的四样
  （排名历史、维度矩阵、口碑主题、Q&A 采集节）**已经被明确列为非目标并点名说清没有来源**（§0.2 第 4 条）。
  不加迁移 ⇒ **v46 撞号这一整类风险归零**（本仓已发生两次：v40、v42）。
- **回滚**：`git revert` 本批的实现提交即可，**库不需要任何降级动作**（没有迁移被应用过，
  也没有一行数据被本批写过 —— 五个 Tab 全是只读）。

---

## 10. 关键数字（写死，验收对照）

| 数字 | 值 | 怎么来的 |
|---|---|---|
| `SCHEMA_VERSION` | **45（不变）** | 本批不加迁移 |
| `TOOLS` | **133（不变）** | 本批不加工具；`amzn_asin_detail` 的枚举由 `ASIN_DETAIL_TABS` 派生 |
| `ASIN_DETAIL_TABS.length` | 4 → **9** | §2.2 |
| `ASIN_DETAIL_PENDING_TABS.length` | 5 → **0** | §2.2 |
| `amzn_asin_detail.tab` 枚举 | 5 → **10** | `[...ASIN_DETAIL_TABS, 'all']` |
| `node tests/run.mjs` | 1794 → **1836 passed / 0 failed** | 不删改既有断言换绿灯；新增断言只加不减（+42） |
| `node scripts/check.mjs` | `OK … ` 且 **N > 0** | 判绿必须看 `N`；worktree 上 profile 漂移是预期的 |
| `node scripts/check-page.mjs` | **3/3** | 动了 `page.js` 就必须跑 |
| 关键词逐词行上限 | **200**（硬上限 1000） | `ASIN_KEYWORD_ROW_LIMIT` / `_MAX` |
| 关键词三态 | **3** | `ASIN_KEYWORD_STATES.length`（`ranked` / `absent` / `untested`） |
| 评论四格读数 | **4** | `reviews` 节的 `fields.length` |
| 逐条评论样本上限 | **50** | `REVIEW_ITEM_LIMIT` |
| 评论四态 | **4** | `ASIN_REVIEW_STATES.length`（`ok` / `empty` / `never-collected` / `unreadable`） |
| 竞品五桶 | **5** | `QUADRANT_ORDER.length`（`domain/keywords/competitor.js`，**已有**） |
| 每象限行数上限 | **40** | `QUADRANT_PAGE_SIZE`（**已有**，唯一上限） |
| 优化运行上限 | **20**（硬上限 200） | `ASIN_RUN_ROW_LIMIT` / `_MAX` |
| 草案处置态 | **5** | `ASIN_ACCEPTANCE_STATES.length` |
| 审计行上限 | **50**（硬上限 500） | `ASIN_AUDIT_ROW_LIMIT` / `_MAX` |
| 审计 `object_id` 形状 | **4**（3 种可命中 + 1 种够不到） | `ASIN_AUDIT_ID_FORMS.length` |
| 「本仓没有来源」的条目 | **6** | §10.1 |

### 10.1 ⚠️ 订正：「本仓没有来源」是 **6** 条，不是 5

按 Tab 数容易数成 5，实际是 6：`keywords` 1 条（排名历史）、`reviews` 1 条（Q&A）、
`competitor` **2 条**（维度矩阵、口碑主题）、`optimization` 1 条（草案采纳留痕）、
`sources` 1 条（导入溯源）。断言钉的是 **6**，并且钉「每条都带 `id` / `label` / `feature` / `reason`
且 `conclusion` 逐字等于 `ASIN_NO_SOURCE_TEXT`」，**不钉**具体是哪几个 id（那会变成第二份名单）。

---

## 11. 验收与证伪计划（写完代码后逐条真跑）

| # | 断言 | 方向 |
|---|---|---|
| ① | 三份新增测试文件在 `tests/run.mjs` 里被调，且 `passed ≥ 1794`、`failed = 0` | 正 |
| ② | `ASIN_DETAIL_TABS` 九项、`ASIN_DETAIL_TAB_LABELS` 九条、`pendingTabs.length === 0`；`amzn_asin_detail.tab` 枚举 = `[...ASIN_DETAIL_TABS, 'all']` | 正 |
| ③ | `buildAsinDetail` 的九个键都非 `undefined`，且工具九条切片都能取到 | 正 |
| ④ | **迁移探针**（开工 + 完工各一次）输出一致、`count = 45` | 正 |
| ⑤ | **每个 Tab 各一条真证伪**：改坏该 Tab 的判据 → 域层断言红；改回 → 绿。六条见 §11.1 | 回退→变红→改回 |
| ⑥ | **状态由内容推导 + 读回对账**：`counts` 逐项等于 `rows` 的重算；`totals` 逐项等于 `drafts` 的重算；把某一个 item 改成 `no-source` → 计数跟着变（§11.2） | 正 + 回退 |
| ⑦ | **「没有数据」≠「数据是 0」**：`reviews` 在 `attributes`-式空读数时印「采到了、但是空的」，`reviewsTotal === 0` 印「0」；`keywords` 的 `absent` 与「这一行都没有」分开（§11.2） | 正 |
| ⑧ | **「没有来源」≠「没测到」**：6 条 `unsourced[]` 的 `conclusion` 逐字是 `本仓没有来源`，且**不**出现在 `rows` / `states` 里 | 正 |
| ⑨ | **一条规则一份实现**：把五个 Tab 的判据分别改坏 → **工具侧与页面侧两条断言同时红**（§11.3） | 回退→两侧变红 |
| ⑩ | **夹具不派生自选择器**：页面断言用 `renderWorkbenchPage` 的服务端渲染 HTML + `tests/b05c-harness.mjs` 的选择器引擎；改坏生产侧（少画一个 `data-*`）与改坏夹具 DOM 两个方向都会红 | 双向 |
| ⑪ | `node scripts/check.mjs` 的 `N > 0`；`node scripts/check-page.mjs` 3/3 | 正 |
| ⑫ | **孤儿守卫**：新增导出要么被生产调用，要么登记进 `UNWIRED` 并写清理由 | 正 |
| ⑬ | **审计零写入**：跑完五个 Tab 的读路径，`audit_log` 行数不变（`amzn_asin_detail` 是只读） | 正 |

### 11.1 五个 Tab 各自的证伪点（每个至少一次：改坏 → 红 → 改回）

**六个变异，逐条跑，一次只改一处**（本仓 includes 审计的 R3/R6 教训：两条假绿可以互为掩护，
所以不能只看「一次改一处之后总红数有没有变」）。全部由 `.tmp-b05d-falsify.mjs` 自动跑：
每个变异都断言**指定的**断言变红、跑完把文件还原并**逐字节校验**（sha256 前 12 位），
「from」字符串匹配不到恰好一次就中止 —— 绝不出现「改坏了但没测到东西」。

| # | Tab | 改坏什么 | 必须变红的两条 |
|---|---|---|---|
| 1 | `keywords` | `classifyKeywordState` 换成一份手写的第二实现（`rank` 空一律 `absent`） | `B05D-K2`（域层：委派矩阵 + `hamster bed` 必须是 `untested`）／`B05D-W2`（页面：那一格必须是「未测（没有扫描深度）」） |
| 2 | `reviews` | 「从没采过」被并进「采到了、空的」 | `B05D-R1`（域层四态）／`B05D-H1`（页面：「从没采过评论这一节」那句话消失） |
| 3 | `competitor` | 绕过 `classifyQuadrants` 的输入，把每个词都按「自有缺席」分类 | `B05D-C1`（域层：字面桶计数）／`B05D-W4`（页面：`dog bed` 那一格必须是「自有优势」） |
| 4 | `optimization` | 处置态判据把「已作废」挪到「已采纳」之后 | `B05D-O2`（域层：先采纳后作废 → 已作废）／`B05D-W5`（页面：那一格必须是「已作废」） |
| 5 | `sources` | 变体边坐标只读 snake_case（hydrate 后是 camelCase，于是永远匹配不上） | `B05D-S2`（域层：三种形状各命中一条）／`B05D-W6`（页面：`variant` 形状没印出来） |
| 6 | 全局 | `ASIN_NO_SOURCE_TEXT` 那句唯一文案被改坏 | `B05D-N1`（域层：六条逐字相等）／`B05D-H5`（页面：六条都印那一句） |

⚠️ **变异 5 是「真 bug 的复现」**：实现期第一版 `variantKey` 真的读的 `parent_asin`，
而 `listVariantRelations` 返回的是 `hydrateRelation` 之后的 camelCase 行 —— 症状是**不抛错**，
只是「这条 ASIN 的变体写入」静默消失，而它与「这条 ASIN 没有变体写入」长得一模一样。
断言 `B05D-S2` 就是抓它的那条。

⚠️ **每条都要有「读那一格自己的文字」的页面侧断言**（窄切片），
所以页面侧的期望值是**字面量**（`'自有优势'` / `'已作废'` / `'未测（没有扫描深度）'`），
不是「与载荷一致」—— 后者在域层被改坏时两边一起变，页面侧永远绿。

### 11.2 读回对账（每条都有名字，名字就是测试里那一条）

| 断言名 | 对账什么 |
|---|---|
| `B05D-K1 counts 是 rows 的重算（不是累加器），三态之和等于行数` | `counts.{rows,ranked,absent,untested}` 逐项等于 `rows.filter(...).length`，且三态之和等于行数 |
| `B05D-R1 评论四态互不相同：从没采过 / 读不出来 / 采到了但空 / 有读数` | 四态的 `stateLabel` 两两不等；`never-collected` 与 `empty` 不是同一句；`reviews_total=0` 属于 `ok` |
| `B05D-C1 counts 是 quadrants 的重算，classified === inputTotal（全划分）` | `counts` 逐桶等于桶长；**字面桶计数** 1/1/1/0/0；`classified === inputTotal` |
| `B05D-O1 totals 是 drafts 的重算（不是累加器）` | 五个处置态逐项等于草案的 `filter(...).length`，五态之和等于草案数 |
| `B05D-S1 byField 是 fieldSources 的重算；「未记录观测时间」不是「观测于 0 点」` | `byField[].sources.length` 之和等于 `fieldSources.length`；`distinctValues` / `conflicted` 与 `fieldConflictsOf` 一致 |
| `B05D-S2 三种可命中的 object_id 形状都读得到，matchedBy 由行推出` | `auditCount === 3`；`matchedBy` 与 `objectIdForm` 由行推出；`auditFormCounts` 是重算 |
| `B05D-W7 ⚠️ 整份渲染里同一个词印了不止一处 —— 所以标签断言必须读窄切片` | 整份渲染里 `本仓没有来源` 出现次数**大于**结构洞条数（块头也印），所以对整份渲染做 `includes` 是结构性永真的；窄切片逐格读 |

### 11.3 「把域层改坏 → 工具侧与页面侧同时红」的落点

| Tab | 域层判据 | 工具侧断言 | 页面侧断言 |
|---|---|---|---|
| `keywords` | `state` / `stateLabel` | 工具返回的 `rows[].stateLabel` | 页面渲染里那**一格**的文字（读窄切片，不读整份渲染） |
| `reviews` | `state` / `stateLabel` | 同上 | 同上 |
| `competitor` | `quadrant_label` | `comparison.quadrants[].quadrant_label` | 页面那**一格** `data-b05d-cell="competitor-quadrant"` 的文字（**字面量**期望，不是「与载荷一致」） |
| `optimization` | `acceptedLabel` | `drafts[].acceptedLabel` | 页面那**一格** `data-b05d-cell="optimization-accepted"` 的文字 |
| `sources` | `objectIdForm` / `matchedBy` | `audit[].matchedBy` | 页面那一行 `data-b05d-cell="sources-matched"` 的文字 |

⚠️ **页面侧期望值必须是字面量**（`'自有优势'` / `'已作废'` / `'未测（没有扫描深度）'`），
**不能**是「等于载荷里的那个字段」：后者在域层被改坏时两边一起变，页面侧永远绿 ——
那正是「域层改坏、只有工具侧红」这个缺陷的形状。§11.1 的六个变异逐个验的就是这一点。

### 11.4 ⚠️ 被改的**既有**断言（逐条列出，理由都是「事实变了」而不是「换绿灯」）

`b05-asin-detail.mjs` / `b05-asin-page.mjs` 里有若干条钉的是「4 个 Tab + 5 个未建」这个**当时的事实**。
本批把那五个做完，这些断言**必须**改 —— 不改它们就与代码不符（本仓按缺陷处理）。
逐条列出、附改前改后，并保证**总数只增不减**（**实现期实测的完整清单见 §13.5**，
比下表多一条：`b05c-harness.mjs` 的 `BLOCK_MARKERS.import` 结束标记也必须跟着移，
否则 B-05c 的 import 块会静默吞掉 B-05d 的代码）：

| 文件:行 | 改前 | 改后 | 为什么 |
|---|---|---|---|
| `b05-asin-detail.mjs:1825` | `deepEqual(ASIN_DETAIL_TABS, ['overview','fields','sections','variants'])` | `deepEqual(ASIN_DETAIL_TABS, [九个])` | 五个 Tab 已建 |
| `:1828` | `equal(ASIN_DETAIL_PENDING_TABS.length, 5)` | `equal(ASIN_DETAIL_PENDING_TABS.length, 0)` + 一条「九个都建了」的 `deepEqual` | 同上 |
| `:1836` | 枚举 = 4 + `all` | 枚举 = 9 + `all` | 派生，自动 |
| `b05-asin-page.mjs:484/613/631` | 「4 个 body / 4 个按钮 / 5 个 disabled」 | 「9 个 body / 9 个按钮 / **0** 个 disabled」 | 同上 |
| `b05-asin-page.mjs:1069` | 注入的 `ASIN_PENDING_TABS` = 5 条 | 注入的是 `[]`，且页面**不再**印「还没建」那句 | 同上 |
| `b05-asin-page.mjs:1180` | 路由返回键含 `pendingTabs` | 键集合再加 `keywords/reviews/competitor/optimization/sources` | 载荷多了五个键 |

**新增断言数必须 ≥ 被改动的断言数**，且 `run.mjs` 的 `passed` 只增不减。

### 11.5 ⚠️ `includes(标签)` 自查（逐条，按 `docs/qa/INCLUDES-AUDIT-2026-10-13.md` 的口径）

本批新写的每一条 `includes(<标签>)` 断言都要先回答两个问题，答案写进测试注释：

1. **同一份输出里有没有另一行（图例 / 说明 / 统计 / 空态文案）会把这个标签印进任何一次渲染？**
   有 ⇒ 该断言结构性永真，必须改成**读那一行/那一格自己的文字**，并**加反面**。
2. **读的是整份渲染还是窄切片？** 读整份渲染（`html.includes(...)`）比读窄切片危险得多。

本批的落点：

- 页面断言一律**读窄切片**：`data-asin-body="keywords"` 里那一格自己的文字，
  或 `data-b05d-cell="<field>"` 那一格，**不读** `htmlOf(page,'asindetail')` 整份。
- 每条标签断言都配**反面**：例如「`absent` 那一格不许印 `有名次`」。
- 词表标签（`有名次` / `已采纳` / `本仓没有来源`）都会在**图例或说明行**里出现，
  所以**不许**对整份渲染断言 `includes('有名次')`。§11.3 的页面侧断言全部按窄切片写。

---

## 12. 非目标（再列一遍，防止被读成遗漏）

1. 不加迁移、不建排名历史表、不建维度对比表、不建口碑主题表、不建 Q&A 采集节、不给导入审计加 ASIN 列。
2. 不加工具、不加路由（`TOOLS` 停在 133）。
3. 不写库、不落审计（五个 Tab 全是只读）。
4. 不改 `src/domain/observe/**`（只登记 §3.6 的缺陷）。
5. 不改 `src/domain/keywords/**`（只 import 分类器）。
6. 不做 F05-06 / F05-08。
7. 不把「本仓没有来源」画成 0 / 灰点 / 留白（§8.1 的唯一文案 + `unsourced[]` 独立区块）。
8. 不碰 §0.3 之外的任何文件；不跑真机采集；不 `git commit`。

---

## 13. 实现期实测到的事实与订正（写完代码后回填）

这一节记的是「契约写完到代码跑通」之间发现的东西。每一条都是实测，不是推断。

### 13.1 契约被订正的三处（都已回填到上面的正文）

| # | 草稿写的 | 实测之后 | 为什么 |
|---|---|---|---|
| 1 | 关键词三态 = `ranked` / `absent` / `unranked`，判据用 `collected_at` | `ranked` / `absent` / `untested`，判据**委派** `classifyOurSide`（用 `scan_depth`） | 第一版是同一问题的第二份实现，且在真实一行上与竞品页**分叉**（§3.3）。委派之后两个页签不可能把同一个词说成两样 |
| 2 | 评论三态 | 评论**四**态（多一个 `unreadable`） | 「页面没有评论」与「读取器挂了」印同一句话，而动作相反（§4.3） |
| 3 | 竞品 `review-topics` 的 reason 写「没有 review / theme 表」 | 改成点名 `optimization_review` / `asin_variant_dimension` | 那两句话**不准确**，按子串搜的断言会在两张**别的**表上红（§5.4） |

### 13.2 实现期发现的真 bug（由本批自己的断言抓出来）

1. **`variantKey` 读错了行的形状**（`src/domain/asin/provenance.js`）：
   `listVariantRelations` 返回 `hydrateRelation` 之后的 **camelCase** 行（`parentAsin`），
   第一版读 `relation.parent_asin` → `undefined` → 查询键变成 `->@US` → **不抛错、只是匹配不到**。
   症状：「这条 ASIN 的变体写入」静默消失，而它与「这条 ASIN 没有变体写入」长得一模一样。
   抓它的是 `B05D-S2`（`auditCount === 3`，实测 2）。**§11.1 变异 5 就是它的复现。**
2. **`listRollbackTasks` 返回 `{rows, limit}`，不是数组**（`src/domain/asin/optimization.js`）：
   它的邻居 `listObservationPlans` 返回数组，两个读者在同一个文件里对返回形状不一致。
   第一版当成数组用 → `rollbacks.map is not a function`（由既有断言 `B05F-⑥` 抓出来）。
3. **`page.js` 的注释里出现 `run.` 会打红一个无关的守卫**：
   `run.mjs` 的「页面读到的每个字段都在载荷里」守卫**连注释一起扫**，把注释里的
   `run.` + 词读成一个 optimize 载荷字段。第一次是回调参数名 `run`（改成 `runRow`），
   第二次是注释里写 `run.x`（改成不写那个字面量）。守卫自己的注释已经警告过这个形状。
4. **`page.js` 的注释里出现反引号会截断外层模板**：B-05d 的注释里写了 `` `run` ``，
   `node --check` 报的是毫不相干的行。`check-page.mjs` 的 ② 一步抓它（它先跑外层 `--check`）。

### 13.3 实现期发现的一处**既有**缺陷（不在本批写作用域，只登记）

`src/domain/observe/metrics.js:107` 给 `organic-rank` 标的 `history: 'append-only'`
**不成立**：`asin_keyword` 对同一个 `(asin, marketplace, keyword, source_id)` 是原地覆盖，
两次观测之后只剩 1 行（§3.6 有探针原文）。所以 `observe` 的基线窗口在这个指标上读不到过去的值。
**本批不改**（`src/domain/observe/**` 不在写作用域），按本仓纪律登记，
并把它作为关键词页「排名历史没有来源」那条的**同一事实**的另一处证据。

### 13.4 测试侧的一处订正（不是放宽，是纠正一条**恒假**的断言）

第一版在 `B05D-C1` 里写了「`counts.ownAdvantage !== counts.unmeasured` 说明两个桶没被合并」。
那个夹具里三个桶各 1，所以 `1 !== 1` 恒假 —— 它是一条**恒假**的断言（与恒真同样没用）。
删掉它，改成**字面桶计数**（1/1/1/0/0）加**页面侧的字面标签**（`dog bed` 必须印「自有优势」、
`hamster bed` 必须印「未测」）。桶名由标签钉住，计数由数字钉住，两者都不靠自洽。

### 13.5 既有断言被改动的清单（理由都是「事实变了」）

| 文件 | 断言 | 改前 → 改后 |
|---|---|---|
| `b05-asin-detail.mjs` | `B05P-⑥` | 「4 个已建 + 5 个点名未建」→「9 个全部已建、pending 清空」，并新增：9 个 id 不重复、后 5 页各自能取到且带 `source`/`unsourced`/`noSourceText`、文本说「全部已建」且不再含「未建」、未知页签仍被拒且列出后 5 个 |
| `b05-asin-detail.mjs` | `B05P-⑦` | 注入的 `ASIN_PENDING_TABS` 从 5 条 → `[]`（多一条 `deepEqual(..., [])`） |
| `b05-asin-page.mjs` | `B05W-③` | 补一条 `disabled === 0`，并把「点第三个」改成**逐个点九个**（每一页都必须自己那一个可见） |
| `b05-asin-page.mjs` | `B05W-⑦` | 「五个未建页签被点名」→「名单清空后不再印那句、但那段渲染仍是守卫（源级）」+ 九页都有名字 |
| `b05-asin-page.mjs` | `B05W-⑨` | 真实回包的键从 7 个 → 12 个（多出后五个页签） |
| `b05c-harness.mjs` | `BLOCK_MARKERS.import` 的结束标记 | `function asinBody(` → `/* ── B-05d：后五个标签页`（否则 B-05c 的 import 块会**静默吞掉** B-05d 的代码，那几条 `!includes` 断言就不再检查它们写的时候那段文本） |

**断言数只增不减**：`1794 → 1836`（+42），一条既有断言都没有删。
