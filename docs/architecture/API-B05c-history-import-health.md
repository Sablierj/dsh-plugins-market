# B-05c 历史 diff · 批量导入 · 数据健康摘要 · 接口契约（G2）

> **日期**：2026-10-12 ｜ **作者角色**：架构师（由全栈开发代拟，G2 由主理人裁决）｜ **状态**：**草稿 → 待 G2**
> **关联需求编号**：F05-04（历史快照与 diff）、F05-05（批量导入）、F05-07（数据健康摘要）
> **关联需求文档**：`docs/requirements/RESEARCH-module-alignment-v2.0.md` §3.5 模块 05 的第 170 / 171 / 173 行
> **关联协同**：`docs/COORDINATION.md` §7.3「B-05 剩余」一行（:2473）、§7.5 第 4/5/6 条（迁移撞号纪律）
> **体例参照**：`docs/architecture/API-B13c-strategy-and-plan.md`、`API-B13d-validation-and-delivery.md`
> **基线（开工前实测）**：`main 53589a3`；`SCHEMA_VERSION` = **44**（`node scripts/check-migrations.mjs` → `{"count":44,"SCHEMA_VERSION":44,"dups":[],"continuous":true}`）；`TOOLS` = **130**；`node tests/run.mjs` = **1696 passed / 0 failed**
> **本批目标**：`SCHEMA_VERSION` **仍是 v44（本批不加迁移）**；`TOOLS` 130 → **133**（+3，其中两个只读、一个写）
> **证据等级**：本文每条「现状」都在本次作业中对着 `src/` 实测（`read` / `grep` / `node`），标 `verified`；引用需求文档的标 `documented`，**与需求文档不符的已逐条标 `stale` 并给出实测反证**。

---

## 0. 范围与非目标

### 0.1 这一批做什么

| 功能点 | 本批交付的深度 |
|---|---|
| F05-04 历史快照与 diff | **任意两次采集快照**之间比较（不再只有「与上一版」）：`GET /api/asin-history` + `amzn_asin_history`，同一个 builder；差异逐字段 `{field, before, after}`（复用 `domain/snapshot/diff.js` 的 `diffPayloads`，**不写第二份 diff**），每个字段带**由内容推出的变化类别**（文本 / 数值 / 图片A+ / 属性 / 变体 / 其他）与**由库内证据推出的归因标签**（人工修正 / 优化发布 / 来源冲突 / Amazon 页面 / 未知）；「来源变化」按快照行的 `source_id` 单独报一行，不与字段差异混在一张表里 |
| F05-05 批量导入 | **按表头映射**（不是按列位置）的 CSV/TSV 文本导入，八步走完：识别分隔符 → 识别表头 → 字段映射 → 逐行预览 → 冲突检查 → 影响预览（含覆盖前值）→ 确认 → 质量报告。`POST asin-import-preview`（只读，不落一行审计）+ `amzn_asin_import`（`dryRun` 时只读）/ `POST asin-import`（写）。**回滚件**：预览与结果都带一份「被覆盖单元格的前值 CSV」 |
| F05-07 数据健康摘要 | **按一个 ASIN**的六项摘要（核心字段完整率 / 43 属性完整率 / 新鲜度 / 多源冲突 / 规则风险 / 优化前置），每项带**分子 / 分母 / 口径 / 来源 / 扣分项明细**；**「本仓没有来源」的那几项单独点名**（见 §5.3），不画成 0 分、不画灰点、不留白 |

### 0.2 这一批明确不做（非目标）

1. **不加任何迁移。** 三个功能点全部读/写既有表（`asin` / `asin_snapshot` / `snapshot_registry` / `asin_field_source` / `field_conflict` / `dq_issue` / `listing` / `audit_log` / `publication_record`）。`SCHEMA_VERSION` 停在 **44**。理由见 §8：本仓已发生两次迁移撞号（v40 / v42），而不加迁移的收益是**撞号风险归零**。
2. **不建「导入历史」表。** 一次导入的留痕由 `audit_log`（一条 `asin_import.apply`）与工具返回值承担。要建表就是 v45 的新表，本批不做。
3. **不重做主页那六张健康卡。** `src/domain/dashboard/health.js` 的六卡是**工作空间级**（`scope` 收窄的是站点，不是 ASIN）；F05-07 要的摘要是**按单个 ASIN** 的（43 属性完整率与优化前置只对一条 ASIN 成立）。两者**并存、互不替代**，本批不动那六卡，也不把它们改成 per-ASIN。
4. **不重写模块 13 的判据。** 「优化前置是否满足」的判据是 `precheckFor`（`src/tools/optimize.js`，`amzn_optimize_precheck` 与页面的「开跑这一轮」按钮都走它）。本摘要**读它的产出**，不另算一遍。同理 43 属性完整率的判据是 `attributeCoverage`（`src/domain/rules/attributes.js`）。
5. **不做 F05-02 剩下的五个 Tab**（关键词与排名 / 评论问答 / 竞品对比 / 优化历史 / 来源与审计），也不动 `ASIN_DETAIL_TABS` 那四个已建页签的契约。本批的三块**作为 ASIN 面板里的独立区块**落在 `#asindetail` 之外（见 §7.1）。
6. **不做 F05-06 父子变体、F05-08 ASIN 归档**：本批只在 diff 与摘要里**读**变体关系事实，不改 `asin_variant` 的任何写路径。
7. **不碰** `src/sources/**`、`src/domain/collect/**`、`src/domain/optimize/**`、`src/domain/prompts/**`、`src/store/prompt.js`、`src/tools/prompt.js`、`src/domain/dashboard/**`、`src/domain/rules/**`。本批对 `src/domain/optimize/precheck.js` 与 `src/tools/optimize.js` 只**import**，一个字节都不改。
8. **不做真机采集**、**不 `git commit`**。

### 0.3 写作用域（与主理人任务书一致）

`src/domain/asin/**`、`src/tools/asin.js`、`src/tools/asin-*.js`、`src/web/page.js` 与 `src/web/routes.js` 的 **ASIN 区**、`src/store/queries.js`、`src/domain/audit/targets.js`、`index.js` 与 `src/tools/index.js` 的**工具注册**、`tests/**`、`docs/architecture/API-B05c-*.md`。

---

## 1. 现状复核（逐条 `verified`）

### 1.1 F05-04：今天有什么、缺什么

| 现状 | 证据 |
|---|---|
| ASIN 的采集历史是 `asin_snapshot`，一次采集一行 | `src/store/schema.js:417`（`CREATE TABLE asin_snapshot`）；索引 `idx_snapshot_lookup ON asin_snapshot(asin, marketplace, collected_at DESC)`（:506） |
| 写路径**已经**同时登记快照版本 | `src/store/queries.js:478` `upsertSnapshot` → :487 `registerSnapshot({objectType:'listing', objectId:'<ASIN>@<MKT>', refTable:'asin_snapshot', refId})` |
| 字段级 diff 只有一份实现 | `src/domain/snapshot/diff.js:73` `diffPayloads`；被 `src/store/snapshot.js:361` 与 `src/domain/asin/fields.js:336` 调用 |
| 页面今天只算「与上一版」 | `src/domain/asin/fields.js:327-344`（`LIMIT 2` 取最近两份，diff 成 `previousDiff`）；`src/web/page.js:4831-4836` 渲染 |
| 变体关系另有表 | `src/store/variant.js`（`getVariantRelation` / `listVariantRelations`） |

**⚠️ 对需求文档的三条订正（需 `documented` → `stale`）：**

1. 需求 §3.5 第 170 行说「`diffSnapshots` 只有定义与测试，全仓无生产调用方」——**成立**（`src/store/snapshot.js:351` 的 `diffSnapshots` 在 `src/` 下确无调用方，只有 `tests/s1b11-snapshot.mjs` 调）。本批**不**给它加调用方：ASIN 的两次快照是**指针式**（`payload_json` 为 NULL，正文在 `asin_snapshot`），`diffSnapshots` 会按 `comparable === false` 拒绝它们（`src/store/snapshot.js:356-360`）。本批读正文后调**底下那一个** `diffPayloads`。
2. 需求 §4.1（:417）说 `registerSnapshot` 在 `src/` 下**零调用方**——**已过期（`stale`）**。实测调用方有四处：`src/store/queries.js:487`、`src/store/queries.js:1328`、`src/store/kw.js:474`、`src/store/kw.js:915`、`src/store/prompt.js:807`。W1 接线批已经点亮了它。
3. 需求 §3.5 第 170 行说「`SNAPSHOT_OBJECT_TYPES` 不含 asin，ASIN 自身历史无登记式 diff」——**前半句成立、后半句不成立**。`src/domain/states.js` 的 `SNAPSHOT_OBJECT_TYPES` 确无 `'asin'`，但 ASIN 快照**已经**以 `object_type = 'listing'` + `object_id = '<ASIN>@<MKT>'` 登记（v26 回填写死 `schema.js:1736-1741`，运行期由 `queries.js:487` 追加）。所以「ASIN 自身的版本索引」存在；缺的是**从索引读到正文再 diff 的出口**。本批**不新增 `'asin'` 类型**：新增一个永远没有行的类型，正是本仓拒绝的「声明了却没有来源」。

### 1.2 F05-05：今天有什么、缺什么

| 现状 | 证据 |
|---|---|
| 能批量写，工具是 `amzn_asin_upsert` | `src/tools/asin.js:365`；逐行 `try/catch`，返回「新增 / 更新 / 失败」（:453-459） |
| 覆盖非空字段有二次确认闸门 | `src/tools/asin.js:342` `OVERWRITE_FIELDS` + `:420-426` `approvalRefusal(store,'overwriteField',…)` |
| 写库语义是 `COALESCE(excluded.x, asin.x)` | `src/store/queries.js:213-216` |
| 按表头映射的先例只在关键词域 | `src/domain/keywords/importers.js:70` `detectImportKind`；`src/tools/kw.js:46` 自述「按表头不按列位置」 |
| 页面无 `type=file` / `FileReader` | `grep` `src/web/page.js` 命中 0 |

**缺口**：八步里只有「确认」与写结果统计；无分隔符/表头识别、无字段映射、无写入前预览、无冲突检查、无影响预览、无质量报告、无回滚件、无导入路由、无导入测试。

### 1.3 F05-07：今天有什么、缺什么

| 现状 | 证据 |
|---|---|
| 主页六张健康卡（工作空间级） | `src/domain/dashboard/health.js:50` `CARD_IDS`、`:79` `card()`（`conclusion` / `numerator` / `denominator` / `updatedAt`）、`:323` `buildHealthCards` |
| 43 属性完整率的判据存在，且**已被生产调用** | `src/domain/rules/attributes.js:156` `attributeCoverage`；调用方 `src/domain/optimize/precheck.js:685`（第 8 道门 `attributes-sufficient`） |
| 43 属性的**数据源存在** | `listing.attributes_json`（`src/store/schema.js:589` `ALTER TABLE listing ADD COLUMN attributes_json TEXT`）；写入方 `src/store/queries.js:1110`（`upsertListing`），生产调用点 `src/tools/optimize.js:1636`（草案采纳落库） |
| 七维度问题清单与七维度词表 | `src/domain/data/quality-rules.js:46` `DIMENSIONS`、`:75` `QUALITY_RULES`、`:149` `scan` |
| per-ASIN 问题可按对象反查 | `dq_issue(object_type, object_id)` + 索引 `idx_dq_object`（`schema.js` 的 v28 段）；读口 `src/store/quality.js:152` `listIssues` |
| 多源冲突的两个面各有一处 | 裁决对象 `field_conflict`（`schema.js:1793`）；发现规则 `DQ-CONSIST-001`（`quality-rules.js:276`） |
| 优化前置有唯一实现 | `src/tools/optimize.js` `precheckFor`（`amzn_optimize_precheck` 与页面的「开跑这一轮」按钮共用）；底层 `src/domain/optimize/precheck.js:771` `evaluatePrecheck`（九道门，纯读） |

**⚠️ 对需求文档的两条订正（`documented` → `stale`）：**

1. 需求 §3.5 第 173 行说「43 属性完整率缺失：`attributeCoverage` 全仓无调用方」——**已过期**。实测调用方是 `src/domain/optimize/precheck.js:685`，且该门已被 `amzn_optimize_precheck` 与页面使用。缺的不是判据，而是**它在模块 05 的摘要里没有露面**。
2. 需求 §3.5 第 169 行说「（`upsertAsin`）不写 `observed_at`/`source_type`」「`manual` 来源无写入路径」——**已过期**。实测 `src/store/queries.js:247-262` 每次写字段来源时调 `upsertFieldSource({sourceType, observedAt})`；`src/store/field-source.js:91-96` 在调用方不说时**按 source 的 `kind` 推出** `source_type`。`upsertFieldSource` 的生产调用方有两处（`queries.js:247`、`src/store/asin.js:141`）。

**⚠️ 本批在复核中新发现的一处「注释与代码不符」（缺陷，按 §11 纪律登记，不在本批修）**

`src/domain/dashboard/health.js:183` 的注释写「`listing` has no `attributes_json` — the design's note predates the table」。**实测该列存在**（`schema.js:589`）。该文件的属主不是本批（§0.3），本批只登记、不改。

---

## 2. 数据模型变更

**无。** 本批不新增/修改表、列、索引，`MIGRATIONS` 数组不动，`SCHEMA_VERSION` 停在 **44**。

回滚口径因此是**零成本**的：任何时刻 `git revert` 本批的实现提交，库不需要任何降级动作（没有迁移被应用过）。

---

## 3. F05-04 历史快照与 diff

### 3.1 模块

`src/domain/asin/history.js`（新）。**一个 builder，两条门**（工具与页面路由），与 `src/domain/asin/detail.js` 同一条约定。

### 3.2 词表（各一份，页面与服务端共读）

```js
ASIN_CHANGE_KINDS = ['text', 'numeric', 'image', 'attribute', 'variant', 'other']
ASIN_CHANGE_KIND_LABELS = { text:'文本', numeric:'数值', image:'图片/A+', attribute:'属性', variant:'变体', other:'其他' }

ASIN_ATTRIBUTIONS = ['manual', 'publication', 'conflict', 'amazon_page', 'unknown']
ASIN_ATTRIBUTION_LABELS = { manual:'人工修正', publication:'优化发布', conflict:'来源冲突',
                            amazon_page:'Amazon 页面', unknown:'未知' }
```

### 3.3 入参

| 名字 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `asin` | string | ✅ | 10 位字母/数字 |
| `marketplace` | string | | 默认 `US`。同一个 ASIN 在不同站点是两条记录 |
| `from` | string | | **起点的快照 id 或 ISO 时间**。省略 = 「上一版」（较早的那一份） |
| `to` | string | | **终点的快照 id 或 ISO 时间**。省略 = 「最新一版」 |
| `limit` | number | | 历史列表条数，默认 100，上限 500 |

**时间 → 快照的解析规则（唯一，写死在一处）**：给 ISO 时间时，取**该时刻或之前最近的一份**快照（`collected_at <= t ORDER BY collected_at DESC, id DESC LIMIT 1`）。**解析不到就报错 `SNAPSHOT_NOT_FOUND`，不静默取最新**——「我指的是那个时间点」和「我随便挑了一份」在页面上长得一样，而它们不是一件事。

### 3.4 出参

```js
buildAsinHistory(store, {asin, marketplace, from, to, limit}) → {
  ok: true,
  asin, marketplace,
  snapshots: [{ id, sourceId, collectedAt, fieldCount, registryId, registryVersion }],
  total, limit, truncated,          // truncated = 历史比 limit 长（列表是截断的，diff 不受影响）
  pair: null | { from:{id,collectedAt,sourceId}, to:{id,collectedAt,sourceId},
                 selection: 'explicit' | 'previous' },
  diff: null | {
    changes: [{ field, before, after, kind, kindLabel, attribution, attributionLabel, evidence }],
    counts: { text, numeric, image, attribute, variant, other, total },
    sourceChange: { changed, before, after, label },   // label 是句子，见 §3.7
    empty: boolean,
    note: string | null
  },
  changedFieldCount, changedSnapshotCount,
  notes: [string]
}
```

`buildAsinHistory` 返回 `ok:true` 而 `diff:null` 是**正常态**：0 份或 1 份快照时没有可比较的两个时间点。这不是错误，也不报 500。

### 3.5 变化类别：由内容推出，一条判据

`classifyChange(field, before, after)`，**按下列顺序取第一条命中**（顺序就是判据，写在函数上方一次）：

1. `field.startsWith('attribute.')` → `attribute`
2. `field.startsWith('variant.')` 或 ∈ `VARIANT_FIELDS` → `variant`
3. `field` ∈ `IMAGE_FIELDS`（`image_url` / `image_alt` / `aplus` / `aplus_1..6` / `brand_story` / `video_script`）→ `image`
4. 两边都是数值（`typeof number`，或 trim 后匹配 `/^-?\d+(\.\d+)?$/` 的字符串）→ `numeric`
5. 两边都是字符串 → `text`
6. 其余（数组/对象/一边为 null 的结构性增删）→ `other`

⚠️ 第 4 条**不用 `Number()` 判**：`Number('') === 0` 会把空字符串判成数值，`Number('12abc')` 是 `NaN` 而 `NaN !== NaN`。用一条正则，判据只有一份。

**增删**不单列一类：`diffPayloads` 已经把缺席的一侧记成 `null`（`diff.js:82-86`），类别仍由上面的顺序推出，页面按「一边是 `null`」印「新增 / 移除」。这一点写进 `render` 与页面文案。

### 3.6 归因标签：由库内证据推出，一条判据

`attributeChange(store, {asin, marketplace, field, before, after, from, to})` → `{attribution, label, evidence}`，**按下列顺序取第一条命中**：

| # | 标签 | 判据（全部 `verified` 的表） | `evidence` |
|---|---|---|---|
| 1 | `manual` 人工修正 | `asin_field_source`：`(asin,marketplace,field)` 里有一行 `source_type = 'manual'` ∧ `updated_at ∈ (from.collectedAt, to.collectedAt]` ∧ 它的值等于 `after` | `source:manual@<updated_at>` |
| 2 | `publication` 优化发布 | `listPublications(store,{asin,marketplace})` 中 `publishedAt ∈ (from.collectedAt, to.collectedAt]` | `publication:<id>` |
| 3 | `conflict` 来源冲突 | `field_conflict`：`(asin,marketplace,field)` ∧ `opened_at ∈ (from.collectedAt, to.collectedAt]` | `conflict:<id>` |
| 4 | `amazon_page` Amazon 页面 | `asin_field_source`：`(asin,marketplace,field)` 里有一行 `source_id = to.sourceId` | `source:<source_id>` |
| 5 | `unknown` 未知 | 以上皆不命中 | `null` |

**⚠️ 实现期订正（草稿里第 1 条原本写的是读 `audit_log`）**：那一版**做不到**。实测 `pageWrite` 的 `after_json` 对 `asin-field-correct` 是 `readAsinField(...)` 的重读结果 `{adoptedValue, sources}` —— 它**不含字段名**（字段在描述符的入参里，没进审计行）。按审计行归因就只能是猜。改成读 `asin_field_source` 的 `manual` 来源行：`correctAsinField` 对工具与页面两条路都写这一行、且它自带字段名。**这不是为了绕开问题，而是它本来就是更直接的证据**（「有人改过这个字段」这件事的原始记录就是那一行）。

两条纪律：

- **「未知」是一个值，不是留白。** 归因不命中时必须印「未知」，页面不许画空单元格——空单元格读起来像「没有归因这一栏」。
- **判据是证据，不是自报。** 表里没有任何一列叫「归因」；五个标签全部由别的表的内容推出来，所以「重算一遍得同一个标签」是本功能的验收项（§11 断言 ⑥）。
- ⚠️ **规则 2 是「窗口内所有变化字段的共同原因」**：窗口里有一条发布记录时，每个变化字段都记「优化发布」。这比反过来强说「不知道」更接近事实，但读者要知道它是**窗口级**证据，不是逐字段证据。§11 断言 ⑥ 里有一条专门验「窗口外的发布不算」。

### 3.7 空态 / 无历史的四句话（互不相同的四件事）

| 情形 | `diff` | 文案（`diff.note` 或并列 `notes`） |
|---|---|---|
| 0 份快照 | `null` | `这个 ASIN 还没有任何采集快照 —— 「从没采过」与「采过但没变化」不是一件事` |
| 1 份快照 | `null` | `只有一份快照（<collectedAt>），两个时间点无从比较` |
| ≥2 份，字段逐项相同 | 非 `null`，`empty:true` | `这两份快照的字段逐项相同，没有变化` |
| ≥2 份，有变化 | 非 `null`，`empty:false` | `null` |

### 3.8 「来源变化」单独一行，且本仓缺的那一半要说清

`sourceChange.before / .after` 是两份快照行的 `source_id`（有记录的），`changed` 由它推出。

⚠️ **本仓没有来源的那一半**：`asin_field_source.source_type`（词表 `SOURCE_TYPES = ['collect','import','manual','derived']`，`src/store/field-source.js:35`）**没有历史**——表的主键是 `(asin, marketplace, field, source_id)`，同一来源再写一次是**原地覆盖**（`field-source.js` 的 upsert），没有任何列记录「这个字段的来源类型在两次快照之间变过」。所以本批**不报**「来源类型变化」，只报「采集来源变化」，并在返回值里明说：

> `sourceChange.note = '来源类型（collect/import/manual/derived）的变化本仓没有来源：asin_field_source 按 (asin,marketplace,field,source_id) 原地覆盖，不存历史。这里报的是快照行的采集来源（source_id）变化。'`

### 3.9 错误码

| code | HTTP | 触发 |
|---|---|---|
| `BAD_REQUEST` | 400 | `asin` 或 `marketplace` 为空 |
| `ASIN_NOT_FOUND` | 404 | `asin` 不在库内（`hint` 指 `amzn_asin_upsert`） |
| `SNAPSHOT_NOT_FOUND` | 404 | 给了 `from`/`to`，但这条 ASIN 里没有这一份（id 或时间都解析不到）；**报错而不是回退到最新** |
| `SNAPSHOT_PAIR_INVALID` | 400 | `from` 与 `to` 解析到**同一份**快照，或 `from` 比 `to` 更晚（`hint` 列出可选的两份 id） |

---

## 4. F05-05 批量导入

### 4.1 模块

`src/domain/asin/import.js`（新）。三条门共用：`amzn_asin_import`（工具）、`POST asin-import-preview`（只读）、`POST asin-import`（写）。

### 4.2 模块级常量

```js
ASIN_IMPORT_FIELDS = ['asin', ...ASIN_LISTING_FIELDS]   // 11 个，派生而不是另抄一份
```
`ASIN_LISTING_FIELDS` 的唯一来源是 `src/domain/asin/table.js:57`（`asin` 表可写的 10 列）。**不在这里再抄一遍列名。**

`ASIN_IMPORT_HEADER_ALIASES`：表头文本 → 字段 id。每字段一组中英别名（`asin`: `asin` / `ASIN` / `asin码` / `产品asin`；`title`: `title` / `标题` / `产品标题`；`price`: `price` / `价格` / `售价`；…）。匹配前**归一化**：去掉 BOM、trim、转小写、删掉空格/下划线/连字符/全角空格。

### 4.3 接受的格式

- **CSV**（`,`）、**TSV**（`\t`）、**分号 CSV**（`;`）。分隔符由**表头行**判定：取候选里在表头行出现次数最多且 ≥1 的那一个；并列时按 `,` → `\t` → `;` 的顺序取第一个（顺序写死，测验钉它）。一个都没出现 → `NO_DELIMITER`。
- **首行是表头，必须。** 没有表头就没有映射，报 `MISSING_HEADER`。
- **引号**：`"` 包裹的字段内的分隔符与换行都属于该字段（RFC4180 的最小实现，`""` 表示一个 `"`）。
- **不接受文件上传。** 页面用 `textarea` 粘文本；工具接 `text` 字符串。本仓没有 `type=file` / `FileReader` 的先例（`grep` 0 命中），本批也不引入——文件读取得由更外层的会话侧决定，工作台不该自己开文件句柄。

### 4.4 入参

| 名字 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | ✅ | CSV/TSV 正文（含表头行） |
| `marketplace` | string | | 表里没有「站点」列时的默认站点，默认 `US` |
| `sourceId` | string | | 写入时每条字段的来源标记。**省略时结果里给一条醒目告警**（与 `amzn_asin_upsert` 同口径） |
| `dryRun` | boolean | | `true` = 只出计划不写库。**默认 `true`**（fail-closed：不写就是默认，要写得明说） |
| `onInvalid` | enum `reject` \| `skip` | | 有非法行时怎么办。**默认 `reject`**（一行不写，点名非法行号） |
| `onDuplicate` | enum `reject` \| `last` | | 文件内同一 `(asin, marketplace)` 出现多次时怎么办。**默认 `reject`** |
| `confirm` | boolean | | 与 `amzn_asin_upsert` **同一个闸门**（`approval.overwriteField`）：会覆盖已有非空值时必须为 `true` |

### 4.5 八步的落点

| 步 | 落在哪 |
|---|---|
| ① 上传 | `text` 入参 / 页面 `textarea` |
| ② 识别表头 | `detectAsinImportFormat(text)` → `{delimiter, label, reason}`；`parseAsinImport(text)` → `{headers, rows, errors}` |
| ③ 字段映射 | `mapAsinImportHeaders(headers)` → `{mapping, unmapped, unknown, missingRequired}`；**按表头文本，不按列位置** |
| ④ 预览 | `buildAsinImportPlan(...)` 的 `rows[]`，逐行 `action` + 逐格 `before/after` |
| ⑤ 冲突检查 | `rows[].conflicts[]`：该 `(asin,mkt,field)` 的 `asin_field_source` 里有 ≥2 个不同值（与 `DQ-CONSIST-001` 同源的读，见 §4.7） |
| ⑥ 影响预览 | `summary`（新增/更新/不变/非法/重复/被覆盖格数）+ `rollback.csv`（被覆盖格子的前值） |
| ⑦ 确认 | `confirm` 过 `approvalRefusal(store,'overwriteField',…)`；`dryRun` 不需要 |
| ⑧ 质量报告 | `qualityReport`：`blocking[]` 与 `warnings[]`，每条带 `code` / `line` / `field` / `message` |

### 4.6 出参（计划）

```js
buildAsinImportPlan(store, {text, marketplace, sourceId, onInvalid, onDuplicate}) → {
  ok: true,
  format: { delimiter, label },
  headers: [...], mapping: {field: columnIndex}, unmapped: [{index, header}], unknown: [...],
  rows: [{
    line, asin, marketplace,
    action: 'create' | 'update' | 'unchanged' | 'invalid' | 'duplicate' | 'superseded',
    invalidReason: string | null,
    cells: [{ field, before, after, action: 'fill' | 'overwrite' | 'same' | 'absent' }],
    conflicts: [{ field, values: [...] }],
    problems: [{ code, field, message }]
  }],
  summary: { lines, rows, create, update, unchanged, invalid, duplicate, superseded,
             filledCells, overwrittenCells, conflictCells },
  qualityReport: { ok, blocking: [...], warnings: [...] },
  rollback: { csv, rows },      // 被覆盖格子的前值，可直接再导一次（§4.8）
  duplicatePolicy, invalidPolicy,
  writeCount                    // 会写库的行数（= create + update）
}
```

### 4.7 一条规则一份实现：冲突检查

「同字段多源不同值」的判据只有一份：`asin_field_source` 的 `(asin, marketplace, field)` 分组里 `COUNT(DISTINCT value) > 1` —— 与 `quality-rules.js:276` 的 `DQ-CONSIST-001` **同一个判据**。模块 05 不写第二条 SQL：折叠落在一个**导出的纯函数** `fieldConflictsOf(sourceRows)` 里，放在**新文件 `src/domain/asin/conflicts.js`**（不是放在 `import.js` —— 健康摘要也要折同一份来源行，两边都 import 它），`import.js` 与 `health.js` 都调它。`quality-rules.js` 的 SQL 不动（它不在本批写作用域内）。

**⚠️ 已知的重复点登记在此**：两条路径各自折叠一次（一条 SQL、一条 JS），本批用一条断言把「同一份来源行 → 同一个冲突集合」钉住（§11 断言 ⑪）。

**⚠️ 实现期实测到的一条事实（写进契约，因为它影响「两个面分开报」的读法）**：`upsertFieldSource` **本身就是冲突检测的钩子**（它调 `refreshConflictsFor`），所以「写进两个不同值」会**自动开出一条 `field_conflict`**：待裁决与多源不同值通常会同时出现。两个数字真正分得开的地方在**裁决之后** —— 分歧还在（来源行没变），待裁决已经归零。§11 断言 ⑫ 就造这个状态。

### 4.8 重复行 / 部分失败 / 回滚

- **重复行（同一个 `(asin, marketplace)` 在文件里出现两次）**：默认 `onDuplicate='reject'` → **整份拒绝**，报 `DUPLICATE_ROWS` 并点名行号，**每一个重复行**的 `action` 记 `duplicate`（`summary.duplicate` 是 2，而 `summary.writeCount` 是 **0** —— 一份都不写）。明说 `onDuplicate='last'` 时，只有**最后一行**胜出、前面的记 `superseded`。**为什么默认拒绝而不是「后者胜」**：一份导出的文件被追加了第二段修订时，「后者胜」在预览里与「前者胜」长得一模一样，而两种意图都存在。
- **非法行**：`onInvalid='reject'`（默认）整份拒绝、点名行号；`'skip'` 只写合法行，非法行在结果里带 `invalidReason`。两条路都有断言。
- **部分失败**：写库逐行 `try/catch`，失败的记 `failed:[{line, reason}]`，**不回滚已成功的行**。这是诚实的边界而不是遗漏：`upsertAsin` 本身是「一行一个事务」，把它包成整份事务会让一次 1 万行的导入在最后一行出错时全丢，而那正是运营最不能接受的。
- **回滚件**：`rollback.csv` 是**所有将被覆盖的格子的前值**（表头 = `asin,marketplace,<field>…`，只含被覆盖的字段）。**「回滚」= 把这份 CSV 再导一次**（`onDuplicate='last'`、`confirm:true`）。它写进计划里，所以人在按下导入之前就拿到了撤回的那张牌。
  ⚠️ **顺序是有意义的**：回滚件在「计划尚未执行」时就生成好了，所以撤回的正确用法是**先执行原计划、再导回滚件**；在原计划之前导它，出来的计划是「无变化」——那正是「撤回」与「什么都没发生」分不开的情形（§11 断言 ⑫ 就按这个顺序跑）。
  ⚠️ 说清它不是事务：`rollback.csv` **不恢复**「这一行原来没有值」的格子（`upsertAsin` 是 `COALESCE`，写不回空）。这一条作为已知限制写进工具返回与 §11 的非目标。

### 4.9 空格子 = 沉默，不是删除

CSV 里某一格是空的：**不写入**，`cells[].action = 'absent'`，并在质量报告里给一条 `warnings` 说「空格不写入」。理由写在契约里而不是靠读者猜：`upsertAsin` 的更新是 `COALESCE(excluded.x, asin.x)`（`src/store/queries.js:213-216`），**省略一个字段是沉默，不是删除**。导入器若把空格当删除，下载→改→上传这条最常用的路会把没动的字段全清空。

### 4.10 错误码

| code | HTTP | 触发 |
|---|---|---|
| `EMPTY_INPUT` | 400 | `text` 为空或只有空白 |
| `NO_DELIMITER` | 400 | 表头行里 `,` / `\t` / `;` 一个都没有 |
| `MISSING_HEADER` | 400 | 只有一行、且它不像表头（映射不中任何字段） |
| `MISSING_ASIN_COLUMN` | 400 | 表头里没有能映射到 `asin` 的列 |
| `UNKNOWN_SOURCE` | 400 | 给了 `sourceId` 但库里没有这个来源（**在计划阶段就拒**，不等到逐行失败） |
| `DUPLICATE_ROWS` | 409 | 文件内重复且 `onDuplicate='reject'`；带 `lines`，且 `summary.writeCount = 0` |
| `INVALID_ROWS` | 400 | 有非法行且 `onInvalid='reject'`；带 `lines` |
| `APPROVAL_REQUIRED` | 409 | 会覆盖已有非空值且 `confirm` 不为 `true`（与 `amzn_asin_upsert` **同一个 code、同一个开关**）。⚠️ `error` 是被拒绝那一批会覆盖哪些格子的**我们**的话，`reason` 是**审批策略自己**那句关于这个开关的话 —— 页面把 `reason` 转进确认框，替换它会让确认框描述的不是真正触发的那个开关 |
| `ASIN_IMPORT_READBACK_MISMATCH` | 500 | 写完之后读回对账不一致（`written` 仍然带上 —— 写已经发生） |

---

## 5. F05-07 数据健康摘要

### 5.1 模块与出参

`src/domain/asin/health.js`（新）。**按一个 ASIN 的摘要**，与主页的工作空间级六卡并存（§0.2 第 3 条）。

```js
ASIN_HEALTH_ITEM_IDS = ['core-fields','attributes-43','freshness','conflicts','rule-risk','optimization-readiness']
ASIN_HEALTH_STATES = ['ok','empty','no-source','error']
ASIN_HEALTH_STATE_LABELS = { ok:'正常', empty:'从没记过', 'no-source': ASIN_HEALTH_NO_SOURCE_TEXT, error:'取不到判据' }
ASIN_HEALTH_NO_SOURCE_TEXT = '本仓没有来源'

buildAsinHealthSummary(store, {asin, marketplace, fields, precheck}) → {
  ok: true, asin, marketplace, objectId, at,
  items: [{ id, label, feature, source, state, numerator, denominator, unit,
            conclusion, missing: [...], breakdown: [{label, value, note}], basis, note, caveat }],
  itemIds: [...ASIN_HEALTH_ITEM_IDS],
  unsourced: [{ id, label, feature, state: 'no-source', conclusion, reason }],   // §5.3
  verdict: 'ok' | 'attention' | 'blocked',                   // 只由 items 与 precheck 推出，不另存
  counts: { ok, empty, noSource, error, total, unsourced },
  verdictReason: string,
  noSourceText: ASIN_HEALTH_NO_SOURCE_TEXT,
}
```

**两个计数是两件事，不能合成一个**（实现期加的口径，写进契约）：

- `counts.total` / `counts.ok|empty|noSource|error` 是**六项 item** 的重算。`counts.noSource` 在本批**恒为 0**，而且这是有意的：六项**都有来源**，没有一项本身是 `no-source`。
- `counts.unsourced` 是 `unsourced[]` 的长度（本批 3）。
- `ASIN_HEALTH_STATES` 里的 `no-source` 因此是**有载的**：`unsourced[]` 的每一条都带 `state: 'no-source'`，页面从**同一张** `ASIN_HEALTH_STATE_LABELS` 取它的标签 —— 那个词不会变成「只声明、不用」。

**`ASIN_HEALTH_STATE_LABELS` 为什么在 domain 而不在页面**：`no-source` 的标签**就是**那句 `本仓没有来源`。两份写法就是同一件事的两种说法，而页面按纪律必须印服务端给的字，不能自己编。

**`fields` 与 `precheck` 都是调用方注入的**，与 `buildOverview` 要 `archived` 同一条纪律：

- `fields`：`buildFieldFacts(store, {asin, marketplace})` 的产出，**必填**。核心字段完整率与新鲜度**不在这里重算**（`fields.js` 已经算好，一页上同一个数字两个算法就是两个数字）。传 `undefined` 当场抛错。
- `precheck`：`precheckFor(store, {asin, marketplace, mode:'full'})` 的产出，**必填**。传 `undefined` 当场抛错；传 `null`（`precheckFor` 对未知 mode/scope 返回 `null`）时 `optimization-readiness` 这一项记 `state:'error'`，**不记 0**。

### 5.2 六项的判据与来源（逐项）

| # | id | 标签 | 判据 | 来源（唯一） | 分母 | `state` 何时为 `empty` |
|---|---|---|---|---|---|---|
| 1 | `core-fields` | 核心字段完整率 | `fields.summary.withValue / total` | `src/domain/asin/fields.js` 的 `buildFieldFacts`（`ASIN_FACT_FIELDS` 10 列，写白名单） | 10 | 恒有分母；ASIN 不在库时整份返回 `ok:false` |
| 2 | `attributes-43` | 43 属性完整率 | `attributeCoverage(...)` 的 `filledCount / target` | `precheck` 报告里 `attributes-sufficient` 这道门的 `counts.matched / counts.total`（判据函数是 `src/domain/rules/attributes.js:156`） | **固定 43** | `listing.attributes_json` 为空 → **`0/43`**，是一个**测出来的 0**，不是「暂无数据」 |
| 3 | `freshness` | 数据新鲜度 | `fields.summary.fresh / total`，并把 `unknown` 拆成 `noThreshold` 与 `noObservationTime` | `src/domain/data/freshness.js` 的 7/30/90 天表 | 10 | 恒有分母 |
| 4 | `conflicts` | 多源冲突 | **两个面分开报、不合成一个数**：① `field_conflict` 里 `status='open'` 的条数（裁决对象）② `DQ-CONSIST-001` 同判据现算的字段数（发现） | `src/store/conflict.js` + `src/store/field-source.js` 的 `listFieldSources` → `fieldConflictsOf`（§4.7 同一条实现） | 10（字段数） | 恒有分母；两者都是 0 = 测出来的 0 |
| 5 | `rule-risk` | 规则风险 | `listIssues(store, {objectType:'asin', objectId:'<ASIN>@<MKT>'})` 的 open 条数，按 `block/warn/info` 分档 | `src/store/quality.js:152`（`dq_issue`） | `issued` 无分母，`denominator` 记 `null` 并在 `breakdown` 里给三档计数 | 不适用（计数，不是比率）；**0 条要带 §5.3 的不可分辨声明** |
| 6 | `optimization-readiness` | 优化前置是否满足 | `precheck.verdict` + `precheck.counts.{pass,degrade,block}` | `precheckFor`（模块 13，`amzn_optimize_precheck` 与「开跑这一轮」按钮同一个入口） | 9（九道门） | 不适用 |

### 5.3 「本仓没有来源」的那几项 —— 原文

**⚠️ 先订正需求文档的暗示。** 任务书提到「F05-07 里的『优化前置是否满足』属未建模、本仓没有来源」。**本次对着 `src/` 实测的结论是「有来源」**，因此**不按「没有来源」写**，而是照实接上：

- **优化前置**：来源 = `precheckFor`（`src/tools/optimize.js`），底层 `evaluatePrecheck`（`src/domain/optimize/precheck.js:771`，九道门，纯读）。证据：`amzn_optimize_precheck` 工具存在并调它，页面的「开跑这一轮」按钮也调它（`src/web/routes.js:104` / `:4265`）。本摘要读它的产出，**不重算**。
- **43 属性完整率**：来源 = `listing.attributes_json`（列存在于 `schema.js:589`）+ `attributeCoverage`（`attributes.js:156`）；写入方 = 草案采纳（`tools/optimize.js:1636` → `upsertListing`）。**有列、有判据、有写入方**，所以这一项不是 `no-source`。

**真正「本仓没有来源」的是这三条**（它们以 `unsourced[]` 单独印出，**不画 0、不画灰点、不留白**）：

`unsourced[]` 条目的 `conclusion` **逐字**是 `ASIN_HEALTH_NO_SOURCE_TEXT`（值 = `本仓没有来源`），后接 `reason`：

1. **`rule-risk-scan-baseline` — 「规则风险扫过没有」本仓没有来源。**
   `reason`：`dq_issue` 只存**发现**，不存一次扫描本身 —— `runQualityScan`（`src/store/quality.js:123`）只对 `scan()` 的结果做 upsert，**不落任何「扫描发生过」的行**，也没有 `dq_scan` 表。所以「0 条问题」既可能是「扫过、干净」也可能是「从来没扫过」，本仓分不开。页面对 `rule-risk` 的 0 条**必须**并列印这句话，不许只画一个绿色的 `0`。
2. **`source-type-history` — 「来源类型（collect/import/manual/derived）的变化」本仓没有来源。**
   `reason`：`asin_field_source` 的主键是 `(asin, marketplace, field, source_id)`，同一来源再写是**原地覆盖**（`src/store/field-source.js:81`），没有任何列或表记录该字段的来源类型历史。所以 F05-04 的「来源变化」只报**采集来源（`source_id`）变化**（§3.8）。
3. **`attribute-snapshot-origin` — 「43 属性是从 Amazon 页面采集来的」本仓没有来源。**
   `reason`：`listing.attributes_json` 的**唯一生产写入方是草案采纳**（`src/tools/optimize.js:1636`，`origin='draft-applied'`）。采集侧没有任何路径把属性写进 `listing.attributes_json` 或 `asin_field_source` 的 `attribute.*`（`upsertAsin` 只写 `ASIN_LISTING_FIELDS` 那 10 列，`src/store/queries.js:207/238`）。所以摘要说「43 属性完整率」时，**不能**说这是从页面采到的属性；属性区在页面上另有一句说明。

> 三条都带 `feature` 字段指向 F05-07 / F05-04，好让读者知道「这是哪个功能点缺的那一块」。**「没有来源」与「没测到」是两句不同的话**：没测到 → `state:'empty'` 且 `conclusion` 印 `0/N`；没有来源 → `unsourced[]` 且 `conclusion` 印 `本仓没有来源`。

### 5.4 状态由内容推导 + 读回对账

`verdict` **不单独存**，只由 `items` 推出（`blocked` > `attention` > `ok`），所以「改了 item 忘了改 verdict」这个 bug 结构上不存在。抓得住的场景（§11 断言 ⑧）：把一个 item 的 `state` 改成 `no-source` → `counts.noSource` 变 1 → `verdict` 若还是 `ok` 则断言红。

**读回对账**：`amzn_asin_health` 与 `GET /api/asin-health` 的**每一项**都带 `source`（来源表的字面名字）与 `basis`（口径句子），且 `counts` 是 `items` 的**重算**（不是累加器）。断言直接对 `items.filter(...).length === counts.X`（§11 断言 ⑧）。

### 5.5 错误码

| code | HTTP | 触发 |
|---|---|---|
| `BAD_REQUEST` | 400 | `asin` 或 `marketplace` 为空 |
| `ASIN_NOT_FOUND` | 404 | 不在库内（`hint` 指 `amzn_asin_upsert`） |
| `HEALTH_FIELDS_REQUIRED` | 500 | 调用方没给 `fields`（编程错误，不是用户输入问题；与 `buildOverview` 缺 `archived` 同一条纪律） |
| `HEALTH_PRECHECK_REQUIRED` | 500 | 调用方没给 `precheck` |

---

## 6. 工具与注册

| 工具名 | 读/写 | 注册点（**两处都要**） |
|---|---|---|
| `amzn_asin_history` | 读 | `index.js` 的 `TOOLS` 数组 + `src/tools/index.js` 的 `TOOLS` |
| `amzn_asin_health` | 读 | 同上 |
| `amzn_asin_import` | **写**（`dryRun:true` 时只读） | 同上 |

`TOOLS` 130 → **133**。`tests/run.mjs` 的「逐名集合相等」守卫会抓漏注册。

### 6.1 本批落盘的文件（实现完成后回填，用于复查）

| 文件 | 新增/改 | 是什么 |
|---|---|---|
| `src/domain/asin/history.js` | 新 | F05-04：`classifyChange` / `attributeChange` / `listAsinSnapshots` / `buildAsinHistory` + 三张词表 |
| `src/domain/asin/import.js` | 新 | F05-05：解析 / 映射 / 计划 / 写入 / 回滚件 |
| `src/domain/asin/conflicts.js` | 新 | 两个功能点共用的「多源不同值」折叠（§4.7） |
| `src/domain/asin/health.js` | 新 | F05-07：六项摘要 + `unsourced[]` + 四态词表与标签 |
| `src/tools/asin-history.js` / `asin-health.js` / `asin-import.js` | 新 | 三个工具（读 / 读 / 写） |
| `src/tools/index.js`、`index.js` | 改 | 两处注册（§6） |
| `src/domain/audit/targets.js` | 改 | `ACTIONS.asinImport`、两条读工具登记为 `null`、导入的 `skip`、两条路由的描述符 |
| `src/web/routes.js` | 改 | 四条路由（§7.1） |
| `src/web/page.js` | 改 | 三块（§7.2）+ 注入的词表 |
| `tests/b05c-harness.mjs` | 新 | 三支测试共用的真 host + 页面 DOM stub |
| `tests/b05c-history.mjs` / `b05c-import.mjs` / `b05c-health.mjs` | 新 | 三支测试 |
| `tests/run.mjs` | 改 | 三支的接线 |
| ⚠️ `src/store/queries.js` / `schema.js` | **未改** | 本批不需要动 store —— 三个功能点都读/写既有表（§2） |

`src/domain/audit/targets.js`：

- `WRITE_TARGETS['amzn_asin_history'] = null`、`['amzn_asin_health'] = null`（显式登记「看过、不是写」，不是漏填）。
- `WRITE_TARGETS['amzn_asin_import'] = { action: ACTIONS.asinImport, objectType: 'asin', objectId: a => a?.records?.[0]?.asin ?? null, readBefore, impact, skip: a => a?.dryRun !== false }`。
  - `ACTIONS.asinImport = 'asin_import.apply'`。**与 `asin.upsert` 分开**：一次导入是「有人拿一份文件批量改了 N 条」，与「写了一条 ASIN」是不同的两件事，审计要回答的是「谁在什么时候用哪份文件覆盖了哪些字段」。多一个字符串比多一处歧义便宜。
  - `skip`：`dryRun` 默认 `true`，所以**一次预览一行审计都不落**——「一条关于没有发生的事的记录，比没有记录更糟」（`targets.js` 在 `amzn_asin_archive.preview` 上已经踩过同一个形状）。
  - `impact`：`{lines, create, update, invalid, overwrittenCells}` —— 审计行要知道「影响面有多大」，而不是把整份文件塞进去。
- `PAGE_WRITE_TARGETS['asin-import-preview'] = null`（POST，写 0 行，**且不许调 `pageWrite`** —— `tests/s1b12-audit.mjs:373-379` 会抓）。
- `PAGE_WRITE_TARGETS['asin-import'] = 与工具同一个 action / objectType / readBefore`（同一操作、同一个字符串）。

---

## 7. 路由与页面

### 7.1 路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/asin-history` | GET | `?asin=&marketplace=&from=&to=&limit=` → `buildAsinHistory` |
| `/api/asin-health` | GET | `?asin=&marketplace=` → `buildAsinHealthSummary`（服务端在这里调 `precheckFor` 与 `buildFieldFacts`） |
| `/api/asin-import-preview` | POST | 只出计划，写 0 行，调 `pageWrite` **不**可以（描述符 `null`） |
| `/api/asin-import` | POST | `dryRun !== false` 时只出计划；否则写库并记一条审计 |

### 7.2 页面（`#panel-asin` 内的三块，**在 `#asindetail` 之外**）

- `#asinhistory` — 历史快照列表（时间 / 来源 / 字段数）+ 两个快照选择 + 「比较」+ 差异表（字段 / 变化类别 / 前值 / 后值 / 归因 / 证据）。
- `#asinhealth` — 六项摘要（分子/分母/口径/来源/扣分项）+ `unsourced[]` 的**独立区块**（印 `本仓没有来源` 与 `reason`）。
- `#asinimport` — `textarea` + 「解析预览」 + 预览表（行号/动作/逐格前→后/冲突）+ 「确认导入」+ 质量报告 + 「下载回滚件」按钮。

**页面只读载荷，不内联重算**（本仓的第 4 条硬约束）：

- 三块的**词表**（`ASIN_CHANGE_KINDS` / `ASIN_ATTRIBUTION_LABELS` / `ASIN_HEALTH_ITEM_IDS` / `ASIN_HEALTH_STATES` / `ASIN_HEALTH_NO_SOURCE_TEXT`）由**服务端注入**（照 `page.js:1143-1145` 注入 `ASIN_TAB_ORDER` 的先例），页面不另写一份。
- 差异表**不做**任何类别/归因判断；预览表**不做**任何 `create/update/invalid` 判断；摘要**不做**任何分子分母计算。三处都只渲染服务端给的字符串。
- 验收判据（§11 断言 ⑩）：**把域层的判据改坏 → 工具侧与页面侧两条断言必须同时变红。**

---

## 8. 迁移与回滚

- **迁移：无。** `MIGRATIONS` 与 `SCHEMA_VERSION` 不动。开工前与每次合并后各跑一次 `node scripts/check-migrations.mjs`（§7.5 第 5 条），两次输出都必须与基线一致（`count 44` / `SCHEMA_VERSION 44` / `dups []`）。
- **为什么敢不加**：三个功能点全部读/写既有表；唯一「像要新表」的是导入历史，而它已被明确列为非目标（§0.2 第 2 条）。不加迁移 ⇒ **v45 撞号这一整类风险归零**（本仓已发生两次：v40、v42）。
- **回滚**：`git revert` 实现提交即可，**库不需要任何降级动作**。已导入的数据不会被回滚（那是运营的数据，不是本批的产物）；要撤回一次导入用 §4.8 的 `rollback.csv`。

---

## 9. 关键数字（写死，验收对照）

| 数字 | 值 | 怎么来的 |
|---|---|---|
| `SCHEMA_VERSION` | **44（不变）** | 本批不加迁移 |
| `TOOLS` | 130 → **133** | +3（`amzn_asin_history` / `amzn_asin_health` / `amzn_asin_import`） |
| `node tests/run.mjs` | **≥ 1696 passed / 0 failed** | 不删改既有断言；新增断言只加不减 |
| `node scripts/check.mjs` | `OK … ` 且 **N > 0** | 判绿必须看 `N`（§7.5 第 4 条）；worktree 上 profile 漂移是预期的 |
| `node scripts/check-page.mjs` | **3/3** | 动了 `page.js` 就必须跑 |
| 43 属性分母 | **43** | `REQUIRED_ATTRIBUTE_TARGET`（`attributes.js:42`） |
| 九道门分母 | **9** | `PRECHECK_GATE_IDS.length` |
| 核心字段分母 | **10** | `ASIN_FACT_FIELDS.length` |
| 新鲜度阈值 | **7 / 30 / 90 天** | `FRESHNESS_DAYS`（唯一来源） |
| 归因标签 | **5** | `ASIN_ATTRIBUTIONS.length` |
| 变化类别 | **6** | `ASIN_CHANGE_KINDS.length` |
| 导入字段 | **11** | `ASIN_IMPORT_FIELDS.length` = `asin` + 10 |

---

## 10. 非目标（再列一遍，防止被读成遗漏）

1. 不加迁移、不建导入历史表。
2. 不重做主页工作空间级的六张健康卡。
3. 不重写模块 13 的九道门判据、不重写 43 属性的判据。
4. 不做 F05-02 的其余五个 Tab、不做 F05-06 / F05-08。
5. 不引入文件上传（`type=file` / `FileReader`）；导入走**粘贴的文本**。
6. 导入**不引入整份事务**；不做「原子导入」的承诺。回滚靠 `rollback.csv` 再导一次，且**不能**恢复「原本为空」的格子。
7. 不写「来源类型变化」（本仓没有来源，§5.3 第 2 条）。
8. 不把 43 属性说成「从 Amazon 页面采集来的」（本仓没有来源，§5.3 第 3 条）。
9. 不碰 §0.3 之外的任何文件；不跑真机采集；不 `git commit`。

---

## 11. 验收与证伪计划（写完代码后逐条真跑）

| # | 断言 | 方向 |
|---|---|---|
| ① | 三份新增测试文件在 `tests/run.mjs` 里被调，且 `passed ≥ 1696`、`failed = 0` | 正 |
| ② | `TOOLS` 集合相等（`index.js` ↔ `src/tools/index.js` ↔ `WRITE_TARGETS` 的键） | 正 |
| ③ | 三个工具的 `output` 都是 `{schema, render}`，`render` 返回内容块数组；`execute` 不抛（可预期输入问题返回 `{ok:false, code}`） | 正 |
| ④ | **迁移探针**（开工 + 完工各一次）输出一致、`count = 44` | 正 |
| ⑤ | **F05-04 真证伪**：把 `classifyChange` 的一个分支改坏（数值→文本）→ 域层断言红；改回 → 绿 | 回退→变红→改回 |
| ⑥ | **归因可重算**：同一份库内容调两次 `attributeChange` 得同一标签；把 `audit_log` 里的 `field_correct` 行删掉 → 标签从「人工修正」变「Amazon 页面」或「未知」（内容变了，标签跟着变） | 正 + 回退 |
| ⑦ | **空态四句互不相同**：0 份 / 1 份 / 2 份无变化 / 2 份有变化，四种载荷的 `diff.note` 两两不相等，且 0 份与 1 份都**不**含「没有变化」 | 正 |
| ⑧ | **状态由内容推导**：把 `items` 里某一项改成 `no-source` → `counts.noSource === 1`；把 `verdict` 写成常量 `'ok'` → 断言红 | 回退→变红 |
| ⑨ | **没有数据 ≠ 数据是 0**：`dq_issue` 空表时 `rule-risk` 印「0 条」**并**印 `本仓没有来源` 的那句不可分辨声明；`attributes-43` 在 `attributes_json` 为空时印 `0/43`（**不**印「暂无数据」） | 正 |
| ⑩ | **一条规则一份实现**：把 `classifyChange` / `buildAsinImportPlan` 的 `action` 判据 / `buildAsinHealthSummary` 的 `state` 判据分别改坏 → **工具侧与页面侧两条断言同时红** | 回退→两侧变红 |
| ⑪ | **冲突判据一致**：同一份 `asin_field_source` 行集，`fieldConflictsOf` 的结果与 `DQ-CONSIST-001` 的分组判据一致 | 正 |
| ⑫ | **导入的 8 类行为**：按表头（含错列序）映射、引号内分隔符、`onDuplicate` 两态、`onInvalid` 两态、覆盖闸门 `APPROVAL_REQUIRED`、`dryRun` 不落审计、写后读回对账、`rollback.csv` 可再导一次 | 正 + 回退 |
| ⑬ | **夹具不派生自选择器**：页面断言用**服务端渲染出来的 HTML**（`renderWorkbenchPage`）+ `tests/html-dom.mjs` 的选择器引擎；改坏生产侧（少画一个 `<td>`）与改坏夹具 DOM 两个方向都会红 | 双向 |
| ⑭ | `node scripts/check.mjs` 的 `N > 0`；`node scripts/check-page.mjs` 3/3 | 正 |
| ⑮ | **孤儿守卫**：新增导出要么被生产调用，要么登记进 `UNWIRED` 并写清理由（`tests/b05-orphan-wiring.mjs` 的同一条纪律） | 正 |

---

## 12. 实现期实测到的事实与订正（写完代码后回填）

这一节记的是「契约写完到代码跑通」之间发现的东西。每一条都是实测，不是推断。

### 12.1 ⚠️ `domain/snapshot/diff.js` 的一个潜在缺陷（本批发现，不在本批写作用域内）

`diffPayloads({}, payload)` 会**多出一条 `field` 为空串的记录**：`flatten()` 把空对象当成一个叶子
（`diff.js:48-51` 的 `keys.length === 0` 分支），于是空的左侧贡献了一条路径名为 `''` 的记录。

- **为什么生产上没暴露**：真实调用两侧都是真 payload，空对象那一支不会走到。
- **本批怎么办**：`history.js` 用 `diffPayloads({}, payload)` 数快照的字段（为了「快照旁边的数与差异表用同一个 flatten」），按**名字**滤掉那一条（`EMPTY_PAYLOAD_PATH`），并写明这是绕开上游缺陷、不是第二条实现。**不改 `diff.js`**（不在写作用域，且会给别的调用方引入行为变化）。
- **怎么防止它变成永久补丁**：`tests/b05c-history.mjs` 有一条断言**钉住这个怪象存在**，并在消息里写清「哪一天 `diff.js` 修好了，请删掉 `history.js` 里的过滤，别改这条断言」。

### 12.2 ⚠️ 页面侧的一个真 bug（由本批的断言抓出来）

`apiWithApproval(path, body)` 的第二个参数是**请求体**（不是 fetch 选项）——
`page.js` 里它自己就是这么实现的（`api(path, { method: 'POST', body: JSON.stringify(body) })`）。
第一版写成了 `apiWithApproval('asin-import', { method: 'POST', body: JSON.stringify({...}) })`，
于是请求体被套成 `{"method":"POST","body":"{…csv…}"}`：服务端会把它读成一份解析不出来的 CSV，
症状是 `EMPTY_INPUT` —— **看起来像「用户粘错了」，其实是页面的调用形状错了**。
`tests/b05c-import.mjs` 的「页面用服务端载荷画预览」那一条把它抓了出来（它读的是页面真正发到
wire 上的请求体）。

### 12.3 `unsourced[]` 的条目带 `state: 'no-source'`

草稿把 `unsourced[]` 写成一个纯文本清单，那样 `ASIN_HEALTH_STATES` 里的 `no-source` 就成了
**只声明、不用**的词。实现时让每个条目带 `state: 'no-source'`，页面从**同一张**
`ASIN_HEALTH_STATE_LABELS` 取标签 —— 于是那个词是有载的，而且两个地方用的是同一份说法。

### 12.4 一条要记住的读法：`counts.noSource` 恒 0 是**对的**

`counts.noSource` 数的是**六项 item** 里状态为 `no-source` 的个数；本批六项都有来源，所以它是 0。
「本仓没有来源」的三条判据在 `unsourced[]` 里，它们的计数是 `counts.unsourced`。
把这两个数字合成一个，就会让「哪一项算不出来」与「这个摘要点了几处没有来源的判据」变成同一个数
——而它们回答的是两个问题。§11 断言 ⑨ 同时钉住 `counts.noSource === 0` 与 `counts.unsourced === 3`。
