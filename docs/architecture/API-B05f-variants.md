# API-B05f —— 父子变体（F05-06）接口契约

- **日期**：2026-10-13（§0/§1 为同日侦察；§2 起为同日收尾时补写，已落码）
- **作者角色**：全栈开发（Fullstack Engineer），Team 成员 `fullstack-variants`
- **状态**：**§0 + §1 侦察 + §2 起实现设计** —— 实现已落地，见 §2.0 的交付面
- **关联需求编号**：F05-06（P1，审计标「缺失」）；同批 F05-02 / F05-08
- **本轮证据等级**：全部为**本次实测**（`verified`），个别条目标注 `documented` / `unverified`，逐条标在行内

> ⚠️ **§1 的行号是 `5353d9c`（v45）那一刻的读数** —— 之后 main 到 `77cbb42`（v46），
> T-8 把状态判据收敛进 `src/store/variant-status.js`、T-6 又把判据抽成
> `detectVariantProblems`，两次都让行号整体位移。
> **引用 §1 时按函数名找，不要按行号找**；结论层面的过期条目已在 §2.1 逐条订正（原文不删）。

## 证据等级口径

| 等级 | 含义 |
|---|---|
| `verified` | 本次实测（跑了命令 / 读了源码 / 查了真库），带原始输出或文件:行号 |
| `documented` | 文档或注释里写着，本次未复验 |
| `stale` | 曾经为真、现在已失效 |
| `unverified` | 待确认，本次无法判定 |

---

## §0 范围与非目标（草稿）

### 0.1 需求原文（审计口径）

`docs/requirements/RESEARCH-module-alignment-v2.0.md:232`（本次实读，`verified`）：

> | `F05-06` | 父子变体（父体/子体、变体维度值、重复矛盾检测、父子层关键词所有权/优化/效果） | P1 | 缺失 | …src 全量搜 `variant|parent_asin|parentAsin|childAsin` 只命中英文单词 invariant，无变体模型… | 整条缺失：没有父体/子体关系表、没有变体维度值、没有重复与矛盾检测、没有父子层分别定义关键词所有权/优化/效果。 |

### 0.2 范围（初稿，待 T-5 后据实测收口）

F05-06 拆成四条可独立验收的线，**本轮的侦察结论显示四条线的起点完全不同**（见 §1）：

1. **关系与维度值**：父体/子体关系、变体维度值的**采集侧写入**（当前生产上无写入方，见 §1.1.3）。
2. **重复与矛盾检测**：四类问题（重复坐标 / 维度矛盾 / 父体矛盾 / 嵌套）+ 两类不完整（见 §1.3.1）——**检测器已存在**。
3. **父子层关键词所有权**：把「变体共用五点导致重复占位」从硬编码的「无法判断」变成可推导（见 §1.4）。
4. **父子层优化与效果**：`parentLevelOptimizationAllowed` 这道门已存在但只被**显示**，未被任何执行路径消费（见 §1.4.4）。

### 0.3 非目标（本轮即定，后续不改口径）

- **不做真机采集**（不在本轮，也不在实现轮；采集侧变更另立任务）。
- **不动** `src/domain/collect/**`、`src/domain/snapshot/**`、`src/domain/dashboard/**`。
- **不新增第三张变体表**：三张表（relation / dimension / relation_event）是 v37 已定的形状，除非实测证明它表达不了需求。
- **不自动替人裁决矛盾**：`parent-contradiction` / `dimension-contradiction` 只能报出来给人判（§1.3.1 的既有设计立场）。
- **不把「没有建模」与「没测到」合并**：本库真实状态是「模型已建、生产写入方为零」（§1.1.3），这两件事必须分开呈现。

---

## §1 现状核实

### 1.1 `asin_variant_relation` 表的真实现状

#### 1.1.1 表在不在 —— **在**（`verified`）

建表语句在 **迁移 v37 `asin-datacenter`**，`src/store/schema.js:2596`（`version: 37`）/ `:2597`（`name: 'asin-datacenter'`）/ `:2632-2647`（`CREATE TABLE IF NOT EXISTS asin_variant_relation`）。

`verified` 证据 —— 真库（`data/amazon-ops.db`，68.5 MB，最后写入 2026-10-13 11:47）只读打开，三张表**都真实存在**，列与 schema 完全一致：

```
asin_variant_relation:        {"exists":true,"count":0,"cols":["id","marketplace","parent_asin","child_asin","source_id","evidence","status","created_at","updated_at","corrected_at","correction_reason"]}
asin_variant_dimension:       {"exists":true,"count":0,"cols":["id","marketplace","parent_asin","child_asin","dimension","value","source_id","observed_at","ingested_at","updated_at"]}
asin_variant_relation_event:  {"exists":true,"count":0,"cols":["id","relation_id","action","reason","evidence","at","by"]}
asin:                         {"exists":true,"count":3,...}
```

迁移自洽检查（`node scripts/check-migrations.mjs`，`verified`）：
`{"count":45,"SCHEMA_VERSION":45,"dups":[],"continuous":true,"last":"agent-run-task-type","first":"initial-schema"}` → **main 当前 45，task-5 取 v46，我预留 v47 成立**。

#### 1.1.2 列 / 主键 / 唯一约束（`verified`，`src/store/schema.js`）

| 项 | 值 | 行号 |
|---|---|---|
| 列（11） | `id, marketplace, parent_asin, child_asin, source_id, evidence, status, created_at, updated_at, corrected_at, correction_reason` | `:2633-2644` |
| 主键 | `id TEXT PRIMARY KEY` | `:2633` |
| 唯一约束 | `UNIQUE (marketplace, parent_asin, child_asin)` —— 同一条边不存两行（幂等 upsert） | `:2645` |
| CHECK | `CHECK (parent_asin <> child_asin)` —— 自己不能是自己的父体 | `:2646` |
| 索引 | `idx_variant_relation_parent` / `idx_variant_relation_child`（都带 `status`） | `:2650-2651` |
| `status` 默认 | `DEFAULT 'active'` | `:2640` |

**姐妹表**（同迁移）：

- `asin_variant_dimension`，10 列，`UNIQUE (marketplace, parent_asin, child_asin, dimension, source_id)`（`:2656-2674`，唯一约束 `:2669`），并有**复合外键**指向 relation 的 UNIQUE（`:2672-2673`）—— 维度值必须挂在一条真存在的边上。
- `asin_variant_relation_event`，7 列，`relation_id` 外键指向 `asin_variant_relation(id)`（`:2682-2690`），只追加、永不改。

**设计立场**（`documented`，`schema.js:2613-2631`）：**重复与矛盾是库里必须存得进去的状态**，所以约束只建在「身份」上，不建在「一个子体只能有一个父体」上 —— 原文：*「一条把矛盾挡在库外的约束，等于把『检测』实现成了一个永远为空的列表」*。

#### 1.1.3 谁在**写**它 —— 只有两个人工工具，**采集侧零写入**（`verified`）

全仓搜 `upsertVariantRelation|upsertVariantDimension|correctVariantRelation` 的调用点，`src/` 下**只有**：

| 写入方 | 位置 | 说明 |
|---|---|---|
| store 写入口（定义） | `src/store/variant.js:179`（`upsertVariantRelation`）/ `:238`（`correctVariantRelation`）/ `:280`（`upsertVariantDimension`） | 唯一写入口，注释明说「这个模块是它们唯一的写入口与读入口」`store/variant.js:5` |
| 工具 `amzn_asin_variant_upsert` | `src/tools/asin.js:933`（关系）+ `:943`（维度） | 注册：`src/tools/index.js:138`、`index.js:311` |
| 工具 `amzn_asin_variant_correct` | `src/tools/asin.js:1000` | 注册：`src/tools/index.js:139`、`index.js:312` |
| 工作台路由 | `src/web/routes.js:2241`（`asin-variant` POST）/ `:2261`（`asin-variant-correct` POST） | 路由**不直接写库**，是转调上面两个工具（`:2244`、`:2264`） |

> ★ **关键结论（`verified`）**：`src/domain/collect/**` **零处** import `store/variant.js` —— 采集管线把 `variations` 节读成 `collection_section_result` 的 `parsed_value_json`（字段 `parent_asin` / `variation_dimensions` / `children` / `child_tiles`），**从不把它变成 `asin_variant_relation` 的行**。真库 `asin_variant_relation` = **0 行**、`collection_section_result` = **0 行**。
>
> ⇒ 本库现状**不是**「没有变体模型」，也**不是**「这个 ASIN 没有子体」，而是 **「模型已建、生产写入方为零」**。这三句话必须分开说（任务书验收标准第 3 条）。

#### 1.1.4 谁在**读**它（`verified`）

| 读者 | 位置 | 读什么 |
|---|---|---|
| 变体标签页 | `src/domain/asin/variants.js:53`（import）、`:104` `listVariantRelations`、`:129` `listVariantDimensions`、`:325` `listVariantEvents` | 整个 F05-06 的视图与检测 |
| 详情页聚合 | `src/domain/asin/detail.js:28`（import `buildVariantView`）、`:83`（调用）、`:32`/`:39`（Tab 名 `variants` = 「变体关系」） | 第 4 个 Tab |
| **B-05c 的 17 列表「父体」列** | `src/store/queries.js:387-390` | 见 §1.1.6 |
| 审计前值 | `src/domain/audit/targets.js:113`（import `getVariantRelation`）、`:344-348`（`readVariant`） | 审计「说的是哪一条边」，坐标由 `:342` `variantKey` 定义 |
| 工作台渲染 | `src/web/page.js:2756-2764`、`:9530`（`tab === 'variants'`）、`:9624-9631`、`:9864`、`:9876-9924` | 页面输出 |
| 工具渲染 | `src/tools/asin.js:642-672`（`amzn_asin_get` 的 variants 段）、`:689-699`（事件时间线） | 工具输出 |

#### 1.1.5 `status` 取值 / 判据定义在哪（`verified`）

- **取值只有两个**：`active`（这条边现在算数）、`corrected`（有人纠正过，行留着供追溯，**永不删除**）。
  定义：`src/store/variant.js:35` `export const VARIANT_RELATION_STATUSES = ['active', 'corrected']`；默认值 `schema.js:2640`；中文口径 `schema.js:2639`。
- **事件动作四个**：`created` / `updated` / `corrected` / `restored`，`src/store/variant.js:41` `VARIANT_EVENT_ACTIONS`。
- ⚠️ **`status ≠ corrected` 这个判据被写成了两种拼法**（`verified`）：
  - `src/store/queries.js:389` —— `r.status <> 'corrected'`
  - `src/domain/asin/variants.js:105` —— `relation.status === 'active'`

  今天两者等价（只有两个取值），但这是**同一条规则的两份实现**，取值集合一变就会漂移。实现轮要收敛成一处。

#### 1.1.6 B-05c 的 17 列表「父体」列怎么读它（`verified`）

- 列定义：`src/domain/asin/table.js:109` —— `{ id: 'parent', label: '父体', hasSource: true, source: 'asin_variant_relation.parent_asin' }`
- 取值：`src/domain/asin/table.js:264` —— `case 'parent': out.parent = blankToNull(source.parent_asin); break`
- SQL：`src/store/queries.js:387-390`

```sql
(SELECT r.parent_asin FROM asin_variant_relation r
  WHERE r.marketplace = a.marketplace AND r.child_asin = a.asin
    AND r.status <> 'corrected'
  ORDER BY r.parent_asin LIMIT 1) AS parent_asin,
```

> ★ **已知缺陷（`verified`，实现轮要处理）**：`ORDER BY r.parent_asin LIMIT 1` 在「一个子体挂在两个父体下」时**静默挑一个**（按字母序最小的那个）。而这正是检测器 `variants.js:192-210` 要报的 `parent-contradiction`。⇒ 列表页会给出一个**看起来很确定**的父体，把矛盾藏起来。这与本仓「缺失不许渲染成一个像值的东西」的纪律冲突，必须双向断言（列表页与变体页对同一行给出不同结论 = 缺陷）。

#### 1.1.7 真库实测：三张表 0 行（`verified`）

`data/amazon-ops.db` 只读实测：`asin_variant_relation` 0 行、`asin_variant_dimension` 0 行、`asin_variant_relation_event` 0 行；`asin` 3 行（`B0FMGXH38Q@DE`、`B0BRKPVZB4@US`、`B0GV55Q4JG@US`）；`collection_section_result` **0 行**。

⚠️ 注意 `B0BRKPVZB4@US` **就在库里**，而它正是真机夹具里那个带 12 个变体磁贴的 listing（§1.2）—— 即：**页面上明确有变体，库里一条关系都没有**。这是「页面有 / 库没有」这条区分在本库的真实例证。

---

### 1.2 现成的真实变体夹具（**先找现成的**，`verified`）

用脚本剥掉 HTML 注释后逐元素计数（`tests/fixtures/` 里**夹具自己的注释会提到选择器名**，不剥注释会得到假阳性 —— 我第一次就踩到了：注释里那句「no `data-defaultasin`」让正则命中，见 §1.5）。

| 夹具 | 真/合成 | `<li>` | `li[data-asin]` | `data-variant-asin` | 变体维度 | `#twister` | `#parentAsin` | `data-defaultasin` | `/dp/` 链接 |
|---|---|---|---|---|---|---|---|---|---|
| `amazon-dp-live-2026-10-10-inline-twister-tiles.html` | **真机捕获** | 15 | **12**（12 个互不相同） | 0 | 1 个（`color_name`） | 无 | 无 | **无** | 1 |
| `amazon-dp-synthetic-2026-10-10-variant-asin-renamed.html` | **合成**（把上一个的 `data-asin` 改名） | 15 | **0** | **12** | 1 个（`color_name`） | 无 | 无 | 无 | 0 |
| `amazon-dp-live-2026-10-09.html` | **真机捕获**（修好之前） | 12 | **0** | 0 | 1 个（`color_name`） | 无 | 无 | 无 | 0 |
| `amazon-dp-live-2026-10-09-swatch-links.html` | **合成** | 3 | 0 | 0 | 1 个（`color_name`） | 无 | 无 | **有** | 2 |

**各覆盖什么**：

- `…-inline-twister-tiles.html`（真机，2026-10-10）：覆盖「**内联 twister** 的色板行」——12 个 `li[data-asin]`、一个 `color_name` 维度行、12 个颜色值。还带两个 `a-state` 脚本：`asinsInCollapsedView`（12 个 ASIN）与 `sortedDimValuesForAllDims`（`color_name` = Black/Blue/Green/Deep Green/Grey/Navy/Orange/Pink/Purple/Red/Teal/White）。
  ⇒ **这是本仓唯一一份「真机 + 12 个子 ASIN + 1 个维度」的捕获**，是 F05-06 的首选夹具。
- `…-variant-asin-renamed.html`（合成）：**故意把 `data-asin` 改名为 `data-variant-asin`**，用来钉死「页面长大了、显式拼写表没跟上」时 `childTiles > 0` 而 `children: []` 的形态（`amazon.js:1599-1613` 的 `childSources` vs `tiles` 两个集合）。
  ⚠️ 它是**合成**的，任务书说「B-04/T-03 用过它」属实，但**它不能单独充当「真机捕获」的证据**；真机证据是上面那份。
- `…-2026-10-09.html`（真机）：**修好之前**的页面 —— 12 个 `li` 但 0 个 `data-asin`，即那次假阴性的现场。
- `…-swatch-links.html`（合成）：3 个 `li`、带 `data-defaultasin`。**全仓唯一带 `data-defaultasin` 的夹具，而它是合成的。**

**使用方**（`verified`）：`tests/b04-variation-children.mjs:66`（tiles）/ `:68`（renamed）；`tests/b04-collect-page.mjs:696`（renamed）；`tests/b04-section-fix.mjs:81`（swatch-links）。

> ★ **夹具缺口（`verified`，实现轮必须正面处理）**：**没有任何一份真机捕获里有父体 ASIN。** 页内读取器读父体的四条路（`src/sources/pages/amazon.js:1528-1544`）是 `data-defaultasin` → `data-dp-url-asin` → `#parentAsin` → `input[name="parentAsin"]`；前两者中只有 `data-defaultasin` 在本仓出现过，且**只在一份合成夹具里**。
> ⇒ **「从真机页面读出父体」这件事目前是 `unverified`**（不是「已证伪」，是「没证过」）。F05-06 若要求「父体由采集得到」，这条必须先补真机捕获或降级为「父体只能由人工/工具写入」。

**另一条已知陷阱**（`documented`，`src/sources/pages/amazon.js:767-784`）：色板里**含 listing 自己的 ASIN**（`B0BRKPVZB4`），读取器用 `target.asin`（我们**请求**的 ASIN，不是从 DOM 反读的）把它排除 —— 注释原文：*「keeping it would store 'this product is a variant of itself', inflate every child count by one」*。
⇒ 真机 12 个磁贴 → 对 `B0BRKPVZB4` 而言**子体是 11 个**。实现轮任何计数断言都要带这一条。

---

### 1.3 「重复与矛盾检测」现在有没有 —— **检测器已存在**（`verified`）

#### 1.3.1 已经有的（`src/domain/asin/variants.js`）

四类**问题**（`VARIANT_PROBLEM_KINDS`，`:68-73`）：

| 判据 | 位置 | 边界（不能误报的地方） |
|---|---|---|
| `duplicate-coordinate` 重复坐标 | `:234-261` | 同一父体下 2+ 个**不同**子体、维度坐标**完全相同且非空**；**空坐标不进分组**（`:246-247`）—— 「两个都没维度」是「不知道」，不是「重复」 |
| `dimension-contradiction` 维度矛盾 | `:212-232` | 同一 `(父体, 子体, 维度)` 上不同来源给出**两个不同的值**；判据在**值**上不在行数上（同值多来源不算） |
| `parent-contradiction` 父体矛盾 | `:192-210` | 同一子体同时挂在 2+ 个**生效**父体下；只报与本 ASIN 相关的（`:203`），全站列表属数据质量视图 |
| `nested-variation` 嵌套 | `:263-270` | 同一 ASIN 既是子体又是父体 |

两类**不完整**（不是矛盾，`VARIANT_INCOMPLETE_KINDS`，`:76`）：`missing-dimensions`（`:277-285`）、`inconsistent-dimensions`（`:286-298`）。

**已纠正的边不参与检测**（`:105`、`:106`）—— 设计立场 `:27-31`：*「把它算进『两个父体』，就永远没有人能纠正完一条错误关系」*。

**门禁**：`parentLevelOptimizationAllowed` = `distinctChildren.length > 0 && incomplete.length === 0 && problems.length === 0`（`:385`）。

**事件历史**单独一块（`:344-358`），且**三态分开**（`:308-312`）：`error` 非空 = 没读出来 / 有关系但 0 条事件 / 没有关系 —— 正是任务书要的「没读到 ≠ 没人改过」。

#### 1.3.2 `field_conflict` 表覆盖什么、缺什么（`verified`）

- 表：`src/store/schema.js:1793-1809`；列（真库实测）：`id, asin, marketplace, field, status, adopted_value, adopted_source_id, suggestion_json, opened_at, resolved_at, resolved_by, note`。
- **唯一写入口**：`src/store/conflict.js`（`:2` 注释「the one place a conflict row is written」；INSERT `:150`、resolve `:330`）。
- 读者：`src/domain/asin/fields.js:347`、`overview.js:137`、`history.js:220`、`health.js`（`:63` import `listConflicts`、`:225`、`:325`）、`queries.js:404-406`（17 列表的「风险数」列，口径 `status='open'`，见 `queries.js:311`）。
- **它覆盖的是「ASIN 字段级」冲突**（price / title / bsr …），键是 `(asin, marketplace, field)`。
- ★ **缺**：**它没有父子/变体概念** —— 没有 `parent_asin` / `child_asin` 列，也不引用 `asin_variant_relation`。变体矛盾**不会**进 `field_conflict`。
  schema 自己的注记（`:1789`、`:2253-2258`）明确把它与 `dq_issue`、`asin_ownership` 分开。
- 真库实测 **0 行**。

#### 1.3.3 `dq_issue` 覆盖什么、缺什么（`verified`）

- 表：`src/store/schema.js:1656-1678`（`CREATE TABLE dq_issue` `:1656`；唯一索引 `(rule_id, object_type, object_id, COALESCE(field,''))` `:1674`）。
- 列（真库实测）：`id, rule_id, dimension, severity, status, object_type, object_id, field, message, workspace_id, assignee, detected_at, updated_at, note`。
- **唯一写入口**：`src/store/quality.js:89-116`（`:2` 注释「the one place a `dq_issue` row is written」）。
- 规则花名册：`src/domain/data/quality-rules.js:76-92` —— `DQ-FRESH-001/002/003`、`DQ-COMPLETE-001`、`DQ-VALID-001`、`DQ-CONSIST-001`、`DQ-UNIQUE-001`、`DQ-TRACE-001`、`DQ-ACTION-001`（**共 9 条**）。
- ★ **缺**：**9 条规则里没有一条是关于变体的** —— 没有 `DQ-VARIANT-*`，没有以 `asin_variant_relation` 为对象的扫描。变体矛盾目前**只活在页面/工具的返回值里，从不落 `dq_issue`**。
- 真库实测 **0 行**。

#### 1.3.4 `domain/asin/conflicts.js` 覆盖什么、缺什么（`verified`）

- 文件共 **44 行**，只导出一个**纯函数**：`fieldConflictsOf(sourceRows)`（`:29-43`）—— 把 `asin_field_source` 的行折成 `field → [sourceId…]`，只保留「有一个以上不同值」的字段；相等性用 `JSON.stringify`（`:14-18`），`null` 值跳过（`:17-18`），返回 `Map` 不用对象（`:24-27`，防 `__proto__`）。
- 调用方：`src/domain/asin/health.js:65`（import）、`:326`（`contested = fieldConflictsOf(sourceRows)`）；`:331`/`:346-350` 把它与 `field_conflict` 分成两面报。
- 口径来源：`DQ-CONSIST-001`（`quality-rules.js:86`，实现在 `:272` 附近，直接读 `asin_field_source` 而非 `field_conflict`）。
- ★ **缺**：**它和变体一点关系都没有。** 名字叫 `conflicts.js` 容易误读成「变体矛盾检测器」，实际是 **ASIN 字段多源分歧**的折叠函数。真正的变体矛盾检测器是 `domain/asin/variants.js`（§1.3.1）。

#### 1.3.5 小结：检测面**已建**，缺的是「落库 + 规则 + 列表页一致性」

| 能力 | 现状 | 证据 |
|---|---|---|
| 四类变体矛盾的**检测逻辑** | **有** | `variants.js:190-270` |
| 检测结果**落库**（进 `dq_issue`） | **无** | 9 条规则无变体项，`quality-rules.js:76-92` |
| 列表页对「两个父体」的呈现 | **有缺陷**：`LIMIT 1` 静默挑一个 | `queries.js:387-390` |
| 检测逻辑的**夹具** | 有真机捕获（但**无父体**） | §1.2 |

---

### 1.4 「父子层关键词所有权」现在有没有 —— **没有**（`verified`）

#### 1.4.1 三张表的列（真库实测，逐列确认）

| 表 | 列 | 有层级概念吗 |
|---|---|---|
| `asin_keyword`（真库 **74 行**） | `asin, marketplace, keyword, source_id, rank, search_volume, collected_at, page, scan_depth, tier, tier_basis_json` | **没有** —— 只有单个 `asin`，无父体/族列 |
| `keyword_ownership`（真库 **0 行**） | `id, keyword, marketplace, asin, status, locked, claim_source, evidence_json, claimed_at, claimed_by, released_at, released_reason, created_at` | **没有** —— 只有单个 `asin` |
| `keyword_plan`（真库 **0 行**） | `id, asin, marketplace, name, note, lineage_id, version, status, source, created_at, created_by` | **没有** —— 只有单个 `asin` |

#### 1.4.2 ⚠️ `lineage_id` 是**版本族**，不是**变体族**（`verified`，命名陷阱）

`src/store/keyword-plan.js:409` 原文：*「`lineageId` names the family to add a version to; omit it to start a new one.」*
⇒ 它是「**同一个计划的新版本**」的族，**与父体/子体毫无关系**。全仓搜 `family` 只命中这一处（`verified`）。
任何把 `lineage_id` 当变体族的读法都是错的 —— 实现轮要在文档与代码注释里显式排除它。

#### 1.4.3 关键词所有权里**唯一**与变体有关的地方，是硬编码的「无法判断」（`verified`）

- `src/store/keyword-ownership.js:220-223`（注释）：*「『变体共用五点导致重复占位』 is deliberately **not** derived: the variant relationship table does not exist (audit §4.4, F05-06 missing).」*
- `src/store/keyword-ownership.js:243-245`：
  ```js
  export function conflictNotesFor() {
    return ['「变体共用五点导致重复占位」无法判断：变体关系表未建（F05-06 缺失），本系统不猜']
  }
  ```
- 呈现方：`src/tools/kw-ownership.js:69`（`HONESTY` 常量数组里的固定一句）、`:87`（`amzn_keyword_ownership_list` 的 tool description 里也写了同一句）。
- 实际能推导的冲突只有两条（`src/store/keyword-ownership.js:225-240`）：`:227-229` 双 ASIN 同时认领、`:230-238` 跨产品线误认领。

> ★ **这句话现在是假的**（`stale`）：`asin_variant_relation` **已经存在**（§1.1.1）。F05-06 要做的第 3 件事，正是把这条「无法判断」变成**可推导**（判据候选：同一变体族内多个子体的 listing 五点文本重复 → 关键词占位重复）。这条改完必须同步改上面 **4 处**文字（`keyword-ownership.js:220-223`、`:244`、`kw-ownership.js:69`、`:87`），否则注释会继续撒谎。

#### 1.4.4 父子层**优化与效果**：门禁有、执行方无（`verified`）

`parentLevelOptimizationAllowed`（`variants.js:385`）全仓消费点只有 **5 处，全是「显示」**：

| 位置 | 用途 |
|---|---|
| `src/domain/asin/overview.js:195` | 透传到 overview |
| `src/tools/asin.js:594` | 工具文字「父体级批量优化可以/被禁止」 |
| `src/tools/asin.js:671` | 工具文字「允许 / 禁止（关系不完整或有矛盾）」 |
| `src/web/page.js:9631`、`:9895` | 页面文字 |

断言在 `tests/b05-asin-detail.mjs:641`、`:685`、`:750`、`:1791`、`:1804`（**只断言这个布尔**，没有断言它真的拦住了任何执行）。
⇒ **没有任何优化执行路径读这个布尔**（`src/domain/optimize/**` 零处引用，`verified`）。「父子层优化」目前只是一句**提示**，不是一道**闸**。
「父子层**效果**」（父子分别看关键词排名/效果）在全仓**零处**。

---

### 1.5 审计那句「无变体模型」是否过期 —— **是，已过期**（`stale`）

审计原文（`docs/requirements/RESEARCH-module-alignment-v2.0.md:232`，本次实读）逐条对账：

| 审计原话 | 今天是否成立 | 反证 |
|---|---|---|
| 「`asin` 表无父体/SKU/变体列」 | **成立**（但无关紧要） | 父体不在 `asin` 表，在 `asin_variant_relation` —— 审计找错了地方 |
| 「src 全量搜 `variant\|parent_asin\|parentAsin\|childAsin` 只命中英文单词 invariant，**无变体模型**」 | ❌ **不成立** | `schema.js:2632` 建表；`src/store/variant.js` 整个模块（328 行）；`src/domain/asin/variants.js`（403 行） |
| 「MIGRATIONS（`schema.js:376-2177`）**无变体表**」 | ❌ **不成立** | 变体三表在迁移 **v37**，`schema.js:2596-2691`（已超出它引用的 2177 行范围 —— 审计的范围引用本身也过期了） |
| 「TOOLS 67 个（`index.js:259-365`、`src/tools/index.js:59-203`）**无变体工具**」 | ❌ **不成立** | `amzn_asin_variant_upsert` / `amzn_asin_variant_correct`，注册在 `index.js:311-312` + `src/tools/index.js:138-139` |
| 「`routes.js` **无变体路由**」 | ❌ **不成立** | `routes.js:2241`（`asin-variant`）、`:2261`（`asin-variant-correct`） |
| 「tests **无变体断言**」 | ❌ **不成立** | `tests/b05-asin-detail.mjs`（大量）、`b05-asin-page.mjs:375-387`、`b05-asin-table.mjs:131/546`、`b05-orphan-wiring.mjs:805-905` |
| 「没有重复与矛盾检测」 | ❌ **不成立** | `variants.js:190-298` 六类判据（§1.3.1） |
| 「`asin_keyword` 只按 asin+marketplace 记录，**没有父子层级概念**」 | ✅ **成立** | §1.4.1（这是审计里**唯一仍然准确**的一条） |
| 「没有父子层分别定义关键词所有权/优化/效果」 | ✅ **成立**（但「优化」有半道门） | §1.4.3 / §1.4.4 |

**过期根因**：审计（v2.0，早于 B-05c）跑在 **v37 之前**，而 B-05c 把变体三表作为 F05-06 的**数据层**先落地了（迁移注释 `schema.js:2599` 明写「模块 05 F05-06 / F05-08：ASIN 数据中心的**数据层**」）。

**过期传播面（`stale`，实现轮要一并修）** —— 三处**代码注释**至今仍在重复这句假话：
1. `src/store/keyword-ownership.js:220-223`
2. `src/store/keyword-ownership.js:243-245`（`conflictNotesFor` 的**返回值**，会印给用户看）
3. `src/tools/kw-ownership.js:69` 与 `:87`（工具描述，会进 Agent 的上下文）

> ⚠️ 第 2、3 处不只是注释：**它们是会输出给人和 Agent 的文字**。F05-06 不做完「父子层所有权」，至少也要先把这句改成诚实的三态（「本库没有这条关系」≠「亚马逊上这个 ASIN 没有子体」）。

**顺带一条同类教训（`verified`）**：本轮我第一次用正则数夹具元素时，`data-defaultasin` 命中为「有」—— 实际命中的是**夹具注释里那句「no `data-defaultasin`」**。剥掉 HTML 注释后才是真值（无）。这正是任务书第 6 条「`includes(标签)` 假绿」的同族问题：**同一份输出里有说明文字会把它印进任何一次渲染**。实现轮的每条计数断言都要问这一句。

---

## §2 接口契约

### 2.0 本批的交付面（一句话：**只加规则与投影，不加工具、不加表、不加页面**）

| 文件 | 改动 | 为什么是它 |
|---|---|---|
| `src/domain/asin/variants.js` | **判据抽出**为 `detectVariantProblems({active, dimensions, asin})`，支持**两个范围**（页面视角 / 站点视角）；`buildVariantView` 改成调它 | 判据必须只有一份，页面与扫描都从这一份来（§6） |
| `src/domain/data/quality-rules.js` | 花名册 **+6 条规则**；新增 `scanVariants()` + `variantFindings()`（**只做投影**） | 让矛盾第一次**进 `dq_issue`** |
| `tests/t6-variant-dq.mjs` | 新文件，9 条断言（①①b②③④⑤⑥⑦⑧） | 本批的承重断言，`run.mjs` 里 `await` 到底 |
| `tests/run.mjs` | 一行 import + 一行 `await runT6VariantDqTests(...)` | 一个没人调用的测试文件不进全量 |
| `tests/s1b09-quality.mjs` | **只改一句注释**（「九条规则」→「九条 + 六条，数九不再是判据」）；断言**一个字未动** | 见 §8：那条红是**实现**坏了，不是断言钉了旧行为 |
| `src/store/quality.js` | **未改**（净零） | 落库仍走既有的 `upsertIssue`；本批**不碰**写路径 |

**没有新增**：工具（仍是 134 个）、路由、`dq_issue` 的列、迁移（schema 仍 **v46**）、页面（`src/web/page.js` 一个字节没动）。

### 2.1 订正 §1 的过期条目（原结论被谁改掉了，只订正、不删原文）

| §1 原条目 | 现在的结论 | 谁改的 / 证据 |
|---|---|---|
| §1.1.5「`status ≠ corrected` 被写成两种拼法，实现轮要收敛成一处」 | **已收敛**：判据在 `src/store/variant-status.js`（JS 侧 `isActiveVariantRelation`、SQL 侧 `activeVariantRelationSql` 把状态**当参数绑定**）；`variants.js` 与 `queries.js` 都调它 | T-8（`verified`：`variants.js` 里已无 `status === 'active'` 字面量，读边走 `isActiveVariantRelation(relation)`） |
| §1.1.6「列表页 `ORDER BY parent_asin LIMIT 1` 静默挑一个父体」 | **已不再静默**：同一行多带 `parent_relation_count`（同一判据），投影成 `parent_contradicts`，值里写 `⚠多父体（本库有 N 个生效父体）` | T-8 D11（`verified`：`src/store/queries.js:493-499`）—— ⚠️ 但它**仍只印一个父体**，矛盾是「被标出来」，不是「被裁决掉」（§7） |
| §1.3.5 表「检测结果**落库**（进 `dq_issue`）：**无**」 | **本批做完** | 本文件 §3 / §4（`verified`：`node tests/run.mjs` 里 ②/③/⑤ 真跑） |
| §0.2 范围第 1 条「采集侧写入」 | **降级为非目标**（用户裁决 2026-10-13） | `docs/requirements/RESEARCH-module-alignment-v2.0.md` F05-06 格已订正 |
| 文首「迁移号 v47 是预留」 | **本批不需要迁移**（`dq_issue` 早已存在，唯一索引也在） | `verified`：`node scripts/check-migrations.mjs` → `{"count":46,"SCHEMA_VERSION":46,"dups":[],"continuous":true,"last":"asin-archive-index","first":"initial-schema"}` |

### 2.2 工具入参 / 出参 / 错误码

**本批不新增工具**，因此没有新的入参名、出参字段或错误码。受影响的只有**既有**出口的**内容**：

| 出口 | 契约（**未变**的部分） | 本批带来的**内容**变化 |
|---|---|---|
| `amzn_dq_scan({marketplace?})` | 入参 `marketplace`（省略 = 全站 `__all__`）、`workspaceId`；出参 `{ text, scope, summary:{scanned,created,updated,total}, stats, issues[] }`；`output.render` 返回 `[{type:'text',text}]` | `issues[]` 里**可能多出**六类变体行（规则号见 §3）；`summary.scanned` 相应变大 |
| `amzn_asin_get` / `amzn_asin_detail` 的 variants 段 | 出参字段未变（`problems` / `incomplete` / `counts` / `events` / `parentLevelOptimizationAllowed`） | `problems` 的**内容**在「站点范围」下多了（页面仍是单 ASIN 范围，见 §4.1） |
| 工作台 `/api/state` 的 `quality.cockpit.issues` | 行形状未变（七要素 + `field` 可空） | 同上：多出变体行 |

**错误码**：
- **无新增**。扫描失败仍是 `{ok:false, error, hint}`（`src/tools/quality.js:61-63`）。
- ⚠️ 一条**故意抛错**的路径：判据出了这里认不出的 `kind`（例如以后加了第五类矛盾而投影没跟上）时，`variantFindings` **抛 Error**，工具转成 `{ok:false, error:'未知的变体问题类型 "…" —— 判据加了新类型，这里的投影必须跟着加一条规则'}`。
  这是**有意的**：静默跳过会让那一类问题在页面上与「没有问题」长得一样。
  ⚠️ 已知瑕疵：工具那句通用 `hint`（「检查库是否可写，或换一个站点再试」）在**这种**失败上会误导 —— 见 §7 已知边界第 5 条。

---

## §3 数据模型：**本批零迁移**（v46 未动）

- `dq_issue` 表与它的唯一索引早已存在（`src/store/schema.js`：`CREATE TABLE dq_issue` + `UNIQUE (rule_id, object_type, object_id, COALESCE(field,''))`）。
  ⇒ **不需要** v47，也**不需要**回滚脚本：本批唯一的「数据变更」是**新的行**，它们由扫描写入、由既有 `setIssueStatus` 走状态机。
- `asin_variant_relation` / `_dimension` / `_event` 三张表**一个字节没动**（v37 的形状够用，见 §1.1.2）。
- **回滚**：代码回退即可；已经写进 `dq_issue` 的变体行**不会自己消失**（那正是 §4.4 的语义）。
  若确实要清掉，`DELETE FROM dq_issue WHERE rule_id IN ('DQ-UNIQUE-002','DQ-CONSIST-002','DQ-CONSIST-003','DQ-VALID-002','DQ-COMPLETE-002','DQ-COMPLETE-003')` —— 这是运维动作，**不是**本批的代码路径。
- 实测：`node scripts/check-migrations.mjs`（在 `amazon-ops/` 下跑）→
  `{"count":46,"SCHEMA_VERSION":46,"dups":[],"continuous":true,"last":"asin-archive-index","first":"initial-schema"}`

### 3.1 六条新规则（花名册，`src/domain/data/quality-rules.js` 的 `QUALITY_RULES`）

| 规则号 | dimension | severity | 对应判据 `kind` | 一行代表什么 |
|---|---|---|---|---|
| `DQ-UNIQUE-002` | `uniqueness` | `warn` | `duplicate-coordinate` | **一个父体 + 一个坐标**：该父体下有 2+ 个子体坐标完全相同 |
| `DQ-CONSIST-002` | `consistency` | `warn` | `dimension-contradiction` | **一条边上的一个维度**：不同来源给出两个值 |
| `DQ-CONSIST-003` | `consistency` | `warn` | `parent-contradiction` | **一个子体**：同时挂在 2+ 个生效父体下 |
| `DQ-VALID-002` | `validity` | `warn` | `nested-variation` | **一个 ASIN**：既是子体又是父体 |
| `DQ-COMPLETE-002` | `completeness` | `info` | `missing-dimensions` | **一个族（父体）**：有子体一个维度值都没采到 |
| `DQ-COMPLETE-003` | `completeness` | `info` | `inconsistent-dimensions` | **一个族（父体）**：子体带着 2+ 种维度组合 |

**编号为什么是 `-002`**：`DQ-<DIM>-001` 已经在用（`DQ-UNIQUE-001` 关键词重复、`DQ-CONSIST-001` 字段多源分歧、`DQ-VALID-001` 越界值、`DQ-COMPLETE-001` 必填缺失），所以变体项**顺延到 002**；`DQ-CONSIST` / `DQ-COMPLETE` 各用到 003。号与 `dimension` 一一对应，**行读出来就能自解释**（`DQ-CONSIST-*` 只可能是 `consistency`）。

**严重级的两档是处置动作，不是感觉**：
- 四类**矛盾** = `warn` —— 要**人**判哪一条边是对的（本仓不替人裁决，§0.3）；
- 两类**不完整** = `info` —— 只是「还没采到」，补采就能好；把它报成 `warn` 会让「补一次数据」与「判一条错关系」在收件箱里同权重。

### 3.2 `dq_issue` 行的坐标（投影口径，**唯一一处**在 `variantFindings`）

```
object_type = 'asin'
object_id   = '<ASIN>@<站点>'          ← 与另外九条规则同一个 objectKey()
field       = 见下（可空）
```

| kind | `object_id` 的 ASIN | `field` | 为什么这样切 |
|---|---|---|---|
| `duplicate-coordinate` | **父体** | `variant-coordinate:<坐标>` | 重复是「这一族的一个坐标」有问题，不是某一个子体有问题 |
| `dimension-contradiction` | **子体** | `variant-dimension:<父体>:<维度>` | 同一个子体在两个父体下的同一维度是**两件事**，父体必须进 `field` 才分得开（否则先写的被后写的覆盖，两处都看不出来） |
| `parent-contradiction` | **子体** | `null`（对象级） | 它是「这个子体的身份」有问题，与维度无关 |
| `nested-variation` | **嵌套的那个 ASIN** | `null` | 同上 |
| `missing-dimensions` | **族里的父体** | `null` | 判据是「这一族缺维度」，落点只能是族坐标 |
| `inconsistent-dimensions` | **族里的父体** | `null` | 同上 |

---

## §4 页面与工具的行为契约

### 4.1 两个范围，一个判据（`detectVariantProblems`）

| 调用方 | 入参 `asin` | 读到什么 | 为什么 |
|---|---|---|---|
| `buildVariantView`（页面第 4 个 Tab / `amzn_asin_get` / `amzn_asin_detail`） | **具体 ASIN** | 这个 ASIN 的那一族（它是子体时带上它的**全部**父体） | 这个 Tab 回答「我正看着的这一族有什么问题」 |
| `scanVariants`（数据质量扫描 → `dq_issue`） | `null` | 整站，按**父体**逐族 | 数据质量视图回答「整个站点哪里坏了」 |

两个范围**共用同一份判据**：把 `detectVariantProblems` 改坏，两侧同时红（§6 有实测）。
`dimensions` 参数收**数组或 thunk**：页面在一族都没有时不多发一次查询，扫描总是要读整站的维度值。

**跨站是坐标系的一部分**：`scanVariants` 按 `marketplace` 分组各算一次（同一个 ASIN 在 US 与 DE 是两个商品，schema 从 v1 起就这么定）。混成一批的话「US 的父体 + DE 的父体」会变成一个**不存在的**矛盾。断言 ⑥ 钉住这一点（同一个子体 US 两个父体、DE 一个 ⇒ 只有 US 报）。

### 4.2 页面侧（`/api/state` → `quality.cockpit.issues`）

- **行形状不变**：页面拿到的是 `listIssues()` 的同一批行（七要素齐全、`status:'open'`、`objectType:'asin'`）。
  ⇒ 页面**没有**为变体问题新增渲染分支：它画的是「一条 DQ 问题」，与另外九条规则同一个组件。
- **健康摘要按 `(object_type, object_id)` 反查**：所以 `object_id` 必须带 `@站点`，否则这一族的问题不会出现在对应 ASIN 的健康摘要里（断言 ②/④ 钉住投影的形状）。

### 4.3 工具侧（`amzn_dq_scan`）

- 正文里**逐条印出**规则号与对象坐标（`严重级 | 维度 | 规则 | 对象 | 说明 | 状态`），最多 50 行；超出时印「仅列前 50 条」。
- ⚠️ 因为 `issues` 是**整张表**（不是本轮新增），一次扫描后正文里可能出现**别轮**留下的变体行 —— 那不是「这一轮又发现了」，`summary.scanned` 才是这一轮的数。

### 4.4 扫描只**发现**，不**消除**（本批钉死的边界）

- `runQualityScan` 只 upsert：**一条被纠正的变体矛盾不会从 `dq_issue` 里消失**。
- `detected_at` 的语义是「**最近一次被扫到**」：仍然成立的问题每次扫描都会刷新它；不再成立的问题**停在**最后一次扫到的时刻，`status` 也**不被扫描改动**。
  ⇒ 「曾经发现过」与「现在还坏着」是两个读数，必须分开读：
  - **现状** = 现算（页面/工具里的 `buildVariantView`，被纠正的边不参与）；
  - **历史** = `dq_issue` 那一行（`detected_at` 是最后一次看见它的时间）。
- 断言 ③（仍然成立 ⇒ 刷新）与 ⑤（不再成立 ⇒ 不刷新、行还在、`id` 不变、`status` 不变）**成对**钉住这条边界；⑤ 里还有一枚**仍然成立的对照行**，用来排除「整轮扫描根本没写库」这个假解释。

### 4.5 「没有建模」/「数据是 0」/「没有数据」三件事分开（不许合并的契约）

| 说法 | 本库真相 | 谁能证明 |
|---|---|---|
| 「没有变体模型 / 表未建」 | **假的** | 三张表自 **v37** 就在（§1.1.1）；`check-migrations` 的 `continuous:true` |
| 「数据是 0 / 这个 ASIN 没有子体」 | **不是全部**：真机页面上有 12 个色板磁贴 | 夹具 `amazon-dp-live-2026-10-10-inline-twister-tiles.html`（断言 ① 剥注释后计数） |
| 「本库没有这条关系」 | **真的**（真库 `asin_variant_relation` **0 行**） | 本批**重跑的只读探针**（`verified`，2026-10-13）：`data/amazon-ops.db` 只读打开 → `asin_variant_relation:0` / `_dimension:0` / `_event:0` / `dq_issue:0` / `field_conflict:0` / `asin:3`，且 `B0BRKPVZB4@US` **就在那 3 行里**；断言 ⑧ 在空库上跑出空集（`verified`） |

⇒ 六条规则的输出**只能**被读成第三句：`asin_variant_relation` 一条生效边都没有时，`scanVariants` 返回**空列表**，那意味着「**本库没有记录**」，**不**意味着「亚马逊上这个 ASIN 没有子体」。
空集是**答案**，不是错误（断言 ⑧ 同时钉住「工具不失败」与「零行」）。

### 4.6 已知输出瑕疵（不假装没有）

- 变体行的 `message` 是**判据那边**生成的整句（含 ASIN 与维度值），没有为 `dq_issue` 再写一版措辞 —— 那会是同一件事的两份文案。
- 一条族级问题（`DQ-COMPLETE-002/003`）的 `object_id` 是**父体**：一个父体有两个子体都缺维度时**只有一行**（那是「这一族缺维度」），坏处是「哪几个子体」只在 `message` 里。

---

## §5 关键数字与非功能

| 项 | 数字 | 证据 |
|---|---|---|
| 断言数（全量） | main `77cbb42` = **1891**；本分支 = **1900** passed / 0 failed（**+9，只增不减**） | `node tests/run.mjs` 末尾行 |
| 新增规则 | **6** 条（4 矛盾 `warn` + 2 不完整 `info`） | `QUALITY_RULES` 9 → 15 |
| 迁移 | **0**（schema 仍 v46） | `check-migrations.mjs` |
| 扫描的查询次数 | 每个涉及的站点 **2 次**（边一次 + 维度一次），与边数无关；**没有 N+1** | `scanVariants` 把整站行一次性交给纯函数 |
| 幂等 | 每轮扫描**行数不变**；靠 UNIQUE 索引 + `field IS ?`（NULL 折叠成空） | 断言 ③（第二轮 `created === 0`）；既有 `s1b09` 的「重复扫描不涨表」 |
| 单次扫描的变体行上限 | **无上限**（每个真实问题一行），但工具正文只印前 50 行 | `src/tools/quality.js:82,90` |
| 性能 | 本批**没有**给「大库」优化：判据是纯 JS、按站读全量边。真库当前 0 行边；若将来边数上万，这里会是第一个要加范围参数的地方（`asin` 参数已经留好） | `unverified`（没有大库夹具，不编数字） |

---

## §6 一条规则一份实现（本仓反复付代价那件事）

**落点**：判据**只在** `src/domain/asin/variants.js` 的 `detectVariantProblems` 一处；两个调用点：

1. `buildVariantView`（页面 / 工具读出「这一族有什么问题」）；
2. `scanVariants`（数据质量扫描 → `dq_issue`）。

`quality-rules.js` 里**没有**第二个「两个父体算矛盾」的判断：`variantFindings` 只按 `kind` **投影**（认不出的 `kind` 直接抛，见 §2.2）。

**验收判据（不是「看着像」，是「改坏之后红不红」）**：

| 把域层改坏 | 期望 | 实测（`verified`，2026-10-13 收尾全量重跑） |
|---|---|---|
| `asins.length < 2` → `< 3`（重复坐标判据失效） | 落库侧（②）与工具侧+页面侧（④）**同时红** | **1894 passed / 6 failed**：②③④⑤ + 既有 `b05-asin-detail` ⑦、`b05-asin-page` ⑥（页面侧/工具侧的旧断言也一起红）；探针两侧读数：工具 `hasRule:false` / 页面 `rows:0` |
| 投影把 `objectId` 写成裸 ASIN（不带 `@站点`） | ②④⑤⑥ 红（per-ASIN 反查断链） | **1896 passed / 4 failed**：②④⑤⑥（`expected "B0T6CON001@US", got "B0T6CON001"`、`重复坐标那一行没有印出对象坐标`） |
| 站点不参与分组 | ⑥ 红（跨站假矛盾） | `unverified`（本批未重跑这一条变异） |
| 扫描在发现消失时删行 | ⑤ 与既有 `s1b09` 的幂等断言**同时红** | **1898 passed / 2 failed**（§8.1 原文） |

⚠️ **④ 的顺序掩盖**：④ 把工具侧与页面侧装进一条断言，工具侧先失败时页面侧那半**没机会开口**。本仓记过这个形状（「两条假绿可以互为掩护」）。补法是**探针**：把两侧读数分别打印（§8.2），证明页面侧不是被遮住、而是真的空了。

**接线守卫**：`detectVariantProblems` 是**新导出**，且**真的被生产调用**（上面两个调用点），所以**不需要**登记进 `tests/wired-source.mjs` 的 `UNWIRED`（那张表只许缩不许长，本批**没动**它）。

---

## §7 已知边界与非目标（**不许读成「没问题」**）

1. **F05-06 只做完了「落库」这一条线。** §0.2 的四条线里，第 1 条（采集侧写入）**被用户裁决为非目标**；第 3 条（父子层关键词所有权）与第 4 条（父子层优化/效果）**本批未做** —— `parentLevelOptimizationAllowed` 仍然只是一句**提示**，没有任何执行路径消费它（§1.4.4 的结论未变）。
2. **不替人裁决矛盾。** 六条规则只把矛盾**报出来**；纠正仍要人调 `amzn_asin_variant_correct`（或页面那个按钮）。扫描**不会**因为「同一条矛盾报了三天」就自己选一条边。
3. **列表页仍只印一个父体**（T-8 只是把矛盾**标出来**：`⚠多父体（本库有 N 个生效父体）`）。本批没有改那一列 —— 它属于 B-05c 的表格口径，改它要动另一批的断言。
4. **扫描不关闭老问题**（§4.4）。一条已经被纠正的矛盾会**一直**留在 `dq_issue` 里直到有人把它标成已解决。这是本仓的既有语义（另外九条规则同此），不是本批引入的。
5. **未知 `kind` 的错误 `hint` 会误导**：判据加了新类型而投影没跟上时，工具正文正确（错误信息点名「投影必须跟着加一条规则」），但那句通用 `hint`（「检查库是否可写，或换一个站点再试」）**指向错的排查方向**。修它要动 `src/tools/quality.js` 的公共提示语（另外九条规则共用），本批**没动**。
6. **本批没跑真机采集**，`B0BRKPVZB4` 的 12 个磁贴是**夹具**（2026-10-10 真机捕获）里的事实，不是本次重采的结果。
7. **本批不新增任何工具**，所以「用工具造变体边」仍要两步：`amzn_asin_upsert` 建 ASIN 行 + `amzn_asin_variant_upsert` 建边（断言夹具就是这么造的 —— 那是本仓**唯一**真实的关系来源）。

---

## §8 收尾时修掉的两条红（性质不同，处理也不同）

接手时全量是 **1835 passed / 2 failed**。两条红**同源**：工作树里留了一段**证伪用的临时补丁**（`runQualityScan` 里把这一轮没再发现的 `dq_issue` 行直接 `DELETE`）。但**两条红的性质不一样**，所以判定要分开写：

### 8.1 红①：`amzn_dq_scan runs the same scan, returns content blocks, and is idempotent`（`tests/s1b09-quality.mjs:339`）

- **性质：实现真的改坏了**（既有断言钉的是**必须成立的语义**，不是旧行为）。
- 判定证据：该断言做的是「全站扫一遍 → 记行数 → 再扫单站 → 行数必须**不变**」。带补丁时实测
  `a repeated tool scan grew the table: expected 9, got 5` —— 表**变小**了：单站扫描把 DE 的行删了。
  「重复扫描不改变行数」是 `dq_issue` 幂等性的定义（`src/store/quality.js` 文件头原文：
  *Re-scanning updates the message and the detection time; it never changes the row count.*），
  所以**不能**改断言迁就实现。
- 处理：**删掉补丁**，断言一个字未动。

### 8.2 红②：`⑤ 纠正那条边之后…`（`tests/t6-variant-dq.mjs` 的 ⑤，本批自己的新断言）

- **性质：实现与它自己的新断言互相不符** → 断言对，实现错。
- 判定证据：⑤ 要求「纠正之后那一行**仍在**、`detected_at` 不前进」，而补丁的行为是**删行**，实测
  `再扫一遍之后那一行不见了 —— 扫描删了行（它只该 upsert）`。
  ⑤ 与 ③（仍然成立 ⇒ **刷新** `detected_at`）是一对，两句话一起才构成「扫描只发现、不消除」。
- 处理：同样**删掉补丁**（③ 与 ⑤ 在新口径下**同时**绿）。

### 8.3 为什么这段补丁是「临时」而不是设计

它自己的注释写着「证伪补丁，跑完就撤」，但**没撤**。本仓的纪律是：证伪补丁必须**当轮撤掉**，
因为它一旦进了交付，就会让「一条被修好的问题」从清单里**消失** —— 那正是本仓最不接受的那类失败：
**看不出来它曾经坏过**。

### 8.4 另一处「不是红、但不该留」的东西

`s1b09-quality.mjs` 里那句「design names **nine** rules」在加完六条规则后已经**不成立**（现在是 15 条）。
它不在断言里（只是注释），但不改就会让下一个人按 9 去数。改法：**注释说清「数九不再是判据」**，
断言不动（`bands` 那三条 `7/30/90` 仍然成立，而且仍然该成立）。
