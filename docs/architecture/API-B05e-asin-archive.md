# API — B-05e：ASIN 归档与恢复的**收口**（F05-08，P0）

> 状态：G2 契约。基线 `main = ba3b016`，schema **v45**，`node tests/run.mjs` = **1799 passed / 0 failed**。
> 本批独占 **v46**（本批只有这一个迁移）。
> 需求原文（F05-08）：**归档前影响预览、归档后隐藏/只读/禁写、恢复留审计、受限删除**。
>
> ★ 本契约的 §1 与 §5 是**实测**改过两处的产物：一次是审计的「整条缺失」不成立（§1），
> 一次是「数据层默认 hide」同时打破了两个读者已经落地的决定（§2.1）。两处都留了原文与理由。

---

## §1 现状核实（**实测**，不是照抄审计）

审计原文 `docs/requirements/RESEARCH-module-alignment-v2.0.md:234` 判 F05-08「**整条缺失**」，
并给了四条具体依据。**实测四条里三条为假、一条为真**：

| 审计的原话 | 实测 | 证据 |
|---|---|---|
| 「asin 表无 archived/status 列（schema.js:398-415）」 | ❌ **假** | `schema.js:2707-2709`（v37 `asin-datacenter`）`ALTER TABLE asin ADD COLUMN archived_at/archive_reason/archived_by`；`schema.js:2713-2725` 建 `asin_archive_event` + `idx_asin_archive_event` |
| 「routes.js 根本没有 asin 路由」 | ❌ **假** | `routes.js:2124`（原 2096）`asin-archive-impact`(GET)、`routes.js:2364`（原 2280）`asin-archive`(POST，调 `asinArchiveTool`)、`2111 asin-detail`、`2146 asin-history`、`2168 asin-health`、`2209/2229 asin-import*`、`2248 asin-field-correct`、`2269 asin-variant`、`2289 asin-variant-correct`，本批加 `asin-delete` |
| 「TOOLS 无归档工具」 | ❌ **假** | `src/tools/asin.js` 的 `amzn_asin_archive`（enum `preview\|archive\|restore`，带 `approvalRefusal(store,'archive',…)` 二次确认闸门） |
| 「WRITE_TARGETS 无 asin 归档项」 | ❌ **假** | `src/domain/audit/targets.js` 的 `asinArchive: 'asin.archive'`（+ `asinFieldCorrect` / `asinVariantUpsert` / `asinVariantCorrect` / `asinImport` / 本批加的 `asinDelete`） |
| 「缺归档后默认隐藏 + 只读 + 禁止新写入的强制」 | ⚠️ **半真** | 见 §2.1 与 §2.7：**显示并标记**是已经落地的决定；真正缺的是「归档集合列不出来」与「两条写口不拦」 |
| 「缺『仅限无引用…』的删除」 | ✅ **真** | 本批前 `ASIN_ARCHIVE_ACTIONS = ['archive','restore']`；全仓无 `deleteAsin`、无引用检查、无 `asin.delete` 审计动作 |
| 「缺归档前影响预览」 | ❌ **假** | `store/archive.js` 的 `archiveImpact`（活跃草案/进行中观测/所属竞品组 + 保持可读三项，且与写入事件行共用同一份） |
| 「缺恢复留审计」 | ❌ **假** | `store/archive.js` 的 `restoreAsin` 写 `action='restore'` 事件；`listArchiveEvents` 按 `at DESC, rowid DESC` |

### 半边已存在的确切位置（「B-05c 的 17 列表里已经有已归档芯片」的根部）

- **`domain/asin/table.js:295`**：`out.archived = source.archived_at !== null && …` —— 投影**已经带 `archived` 布尔**。
  `table.js:292-294` 的注释是**本批最关键的一条现状**：
  > 「归档标记**不是第 18 列**：它是 ASIN 那一格上的一个芯片，语义是「从默认列表隐藏」。
  > 带着它走，是因为列表**不隐藏**归档的行 —— 不带标记的一行看起来与正常记录完全一样，
  > 而「归档没生效」正是那个样子。」
- **`web/page.js`** 的 `renderAsinCell`（`case 'asin'`）：在 asin 格上印 `已归档` 芯片；
  注释同样写明「**这一张表不隐藏它们**」。
- **`tools/asin.js`** 的 `asinRowValue`（`case 'asin'`）：`row.archived === true ? \`${row.asin}（已归档）\` : row.asin`
  —— **会话侧同样逐行标记，不隐藏**。
- **`domain/asin/table.js`** 的 `projectAsinRow`：`archived` 来自服务端载荷，页面不内联重算。
- **`web/routes.js`** 的概览切片：`archivedAsinCount(store)` → 「全库已归档 N 个」；
  `page.js` 的 `archivedHint` 把 **N / 0 / 读不出来** 三态分开说。
- **`store/archive.js`** 的 `assertAsinWritable` 已被**两处**生产写入调用：
  `store/asin.js`（`correctAsinField`，人工修正字段）、`store/variant.js`（变体关系与变体维度）。

### 因此本批**真正的**缺口（三条，全部实测）

**G1 · 隐藏无处可达**：本批前 `queryAsins`（`store/queries.js`）**没有任何 `archived` 过滤**
（`Select-String queries.js -Pattern archived` = **0 命中**）。后果是一条**读回对账不可能**：
`archivedAsinCount` 会报「全库已归档 N 个」，但**没有任何一条查询能把这个集合列出来去核对 N**。
—— 这正是本仓那条「写入方自报、读者另算」的病：数字被声称，集合不可验证。
`amzn_asin_query` / `amzn_asin_export` 与页面 ASIN 表**都**读它。

**G2 · 禁写只盖了两条腿**：`assertAsinWritable` 只挡「人工修正字段」与「变体写入」。
`amzn_asin_upsert` 与 `amzn_asin_import`（经 `upsertAsin`）写一条**已归档**的 ASIN 时**不报错**。
本批把闸门加在**面向用户的工具与导入器**上（见 §5 非目标，说明为什么**不**加在 `upsertAsin` 里）。

**G3 · 受限删除整条不存在**：无 `deleteAsin`、无引用检查、`ASIN_ARCHIVE_ACTIONS` 无 `delete`、
`ACTIONS` 无 `asin.delete`。

### 参考集（**可复算，不是手抄**）

对**空库**（把 `openStore` 指到一个临时目录，让 46 步迁移全跑完）跑
`SELECT name FROM sqlite_master WHERE type='table'` + 每张表的 `PRAGMA table_info`，
取列名等于 `asin` 或以 `_asin` 结尾的那些（**实测输出**，本批基线）：
**20 of 74 tables carry an asin coordinate** —— `asin` / `asin_archive_event` / `asin_field_source` /
`asin_keyword` / `asin_ownership` / `asin_snapshot` / `asin_variant_dimension` /
`asin_variant_relation` / `collection_section_result` / `field_conflict` / `keyword_ownership` /
`keyword_ownership_event` / `keyword_ownership_suggestion` / `keyword_plan` /
`kw_competitor_fact` / `kw_master` / `kw_master_case_merge_archive` / `listing` /
`optimization_run` / `publication_record`。

★ **这一次枚举只能找到「列」这一种存储**，而库里还有两种**它找不到**的引用形态，所以候选集合
**不是**纯 schema 派生的，而是 `派生 ∪ 显式`，且**两个方向的完整性都要断言**
（`B05E-⑥` / `B05E-⑦`，实现是 `archive-refs.js` 的 `unclassifiedAsinCandidates` /
`missingAsinReferenceSources`）：
1. **列**（20 张，上面那份）；
2. **JSON 列表**：`competitor_set.asins_json`（`schema.js:1198`）、`collection_task.targets_json`
   （`schema.js:495`，写入方 `queries.js` 的 `insertCollectionTask`）、`collection_plan.targets_json`
   （`store/collection-plan.js`）；
3. **多态对象 id**：`dq_issue.object_type = 'asin'` 时 `object_id` 就是 ASIN（`schema.js:1662-1663`）。

---

## §2 入参 / 出参

### 2.1 `queryAsins(store, filters)` 新增一个入参（`store/queries.js`）

| 入参 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `filters.archived` | `'hide' \| 'only' \| 'all'` | **`'all'`** | `hide` = 只要在架的（`archived_at IS NULL`）；`only` = 只要已归档的；`all` = 不过滤 |

- **一个入参三个字面值，不是一个布尔**：一个 `includeArchived: boolean` 说不出「只要已归档的」，
  于是「看看归档了哪些」会退化成把整库拉回来再在前端挑，而归档的集合恰恰是拿来核对
  `archivedAsinCount` 的那一份。
- **认不出的值 `throw`**（`code = 'ASIN_ARCHIVED_FILTER'`），**不静默退回默认**：一个把 `'only'`
  读成默认值的过滤器会让「已归档 N 个」永远显示为空 —— 而空与「筛错了」在页面上长得一样。
- **`asin.archived_at` 读不出来时**（v37 之前/列被删过的库，`archivedAsinCount` 已经会返回 `null`）：
  **不加这个条件**，并且把 `archivedHidden` 与 `archivedTotal` 报成 **`null`**。
  此时 `only` 返回的是**全部行**而不是空集 —— 空集在这里读起来正好是「一条都没归档」，
  那是本仓最贵的那类假 0。

### ★ 默认为什么是 `all` 而不是 `hide`（**本契约实测改过一次**）

本批最初把默认定成 `hide`（「数据层的安全默认：新调用方不该把归档项当候选」），
实测结果：**同时打破了两处已经落地、都写明了理由的决定** ——
`domain/asin/table.js` 的 `projectAsinRow` 与 `tools/asin.js` 的 `asinRowValue`
（两处都逐行标记而不隐藏），并且**打破得很安静**：两边都还在工作，只是少了几行。
最终 8 条既有断言变红（`B05T-⑥` / `B05O-②d` 等），每一条都带着
「归档的行逐行标出来」这句注释。

⇒ 这个仓库对「归档后隐藏」的实现口径**已经决定过**了：隐藏的是「还能被拿去采集/优化的候选」
这个含义上的隐藏，不是「从库里看不见」。一个数据层默认值把两个读者一起翻转，
是一次**没人要求的产品行为改变**。所以默认留在 `all`，想隐藏的调用方**说出来**
（`archived: 'hide'`）。**口径已裁决（2026-10-13，用户）：保留 `all` + 三态筛选**，见 §7 第 1 条。

**出参新增三格**（读回对账用的，全部由内容算出）：

| 出参 | 含义 |
|---|---|
| `archived` | 这一次**实际生效**的模式（归一化后的字面值）|
| `archivedHidden` | 本次**被这一条规则挡掉的行数**（`hide` 下 = 命中的已归档总数；`only`/`all` 下 = **0，是事实**；那一列读不出来时 = `null`）|
| `archivedTotal` | **全库**已归档总数，与 `archivedAsinCount` **同一个函数**（那一列读不出来时也是 `null`）|

**读回对账恒等式**（测试里断言）：
```
total(archived:'all') === total(archived:'hide') + total(archived:'only')   // 同一组其它筛选下
archivedTotal === archivedAsinCount(store)                                  // 两个读者，一个数
archivedHidden === total(archived:'only')                                   // hide 挡掉的就是 only 集合
```
★ 这三条是「任何状态必须能由内容重算出来」的落地：`archivedTotal` 是**算的**，
不是把 `archivedAsinCount` 的答案抄一份。

### 2.2 两个工具（`src/tools/asin.js`）

**`amzn_asin_archive`**（既有，enum 不变）：`preview` / `archive` / `restore`。

**`amzn_asin_delete`**（本批新增，注册在 `index.js` 的 `TOOLS` 与 `src/tools/index.js` 的
`buildTools` **两处**）：

| action | 写库 | 前置条件 | 出参要点 |
|---|---|---|---|
| `delete_preview` | 否 | 无 | `references`（§2.4）、`deletable` |
| `delete` | 是 | **`confirm: true`（恒定）** + `reason` 非空 + 0 处引用 + 检查完整 | `changed` / `references` / `archiveEvents` |

★ **为什么删除不放进 `amzn_asin_archive` 的枚举里**（三条理由，每条独立成立）：
1. 归档与恢复是**同一个可逆标志的两个方向**（共用一条 action、共用一份前值，方向由 before/after
   的差异表达）；删除**不在那个轴上** —— 它没有反方向。axis 不同，工具就不同。
2. `s1b12` 的守卫按**字面量**校验描述符的 `action`（非字符串即 malformed），而两条 action 必须分开。
   让守卫放松到「能解析一个函数」是为了让一个设计选择过得去而削弱守卫 —— 方向反了。
3. 归档的确认是一个**可以关掉的设置**（`approval.archive`），删除的确认是一个**恒定的前置条件**。
   两种语义共用一个 `confirm` 字段，会让「这个 confirm 是什么意思」取决于另一个字段的值。

★ **`delete` 的确认不可关闭**：它**不读** `approval` 设置（那会需要一个 `approval.delete` 开关，
而「能被关掉的删除确认」是自相矛盾的），直接要求 `confirm === true`。
（`src/domain/approval/policy.js` 也不在本批的写作用域内 —— 这一点同时是设计与边界的约束。）

★ **`preview` 与 `delete_preview` 是两件事，不合并**：一个是「归档会挡住谁」（挡的是将来的写入），
一个是「删掉会带走谁」（带走的是已经存在的行）。合成一句「影响预览」会让用户在一个
只为归档准备的数字上点删除。

### 2.3 页面筛选（`src/web/page.js` + `routes.js`）

ASIN 筛选条新增一个**三态**控件 `#asinArchived`（`含已归档 | 只在架 | 仅已归档`），
写进 `state.filters.archived`，随 `patchContext` 走 `context.filters` →
`routes.js` 的 `/api/state` 读**同一份**规则。

- **`ASIN_PAGE_ARCHIVED = 'all'`（`routes.js`）是页面这一侧显式拥有的一格**。
  它今天与 `store/queries.js` 的 `ASIN_ARCHIVE_DEFAULT` 相同，而这个「相同」正是要防的东西：
  两个默认值一致时，靠「不传 archived」也能得到对的结果，于是**没有任何东西**保证它们继续一致。
- **「清除筛选」把 `archived` 设回 `all` 而不是删掉它**：删掉之后查询会落到数据层默认，
  于是一个清筛选的按钮会顺手把归档的行藏起来。
- 页面还新增 `id="asinArchivedScope"` 那一行：说出**本屏生效的口径**与挡掉的条数
  （四个分支各说各的一句，`null` 也算一句）。
- **筛选值认不出时**（一份保存视图可以带进任意 `filters_json`）：`/api/state` 仍然 **200**，
  退回页面默认口径继续出数，并把原话放进 `asinArchivedFilterError`，页面把它印出来。
  让一个可选字段读不出来把整个工作台打成白屏，是比「筛错了」严重得多的事故。

### 2.4 `asinReferenceReport(store, {asin, marketplace})`（新，`src/domain/asin/archive-refs.js`）

```js
{
  asin, marketplace,
  total,                    // 引用行数合计（只算 kind === 'reference'）
  deletable,                // total === 0 && gaps.length === 0
  references: [ { table, column, kind: 'reference', count, reason } ],
  record:     [ … ],        // asin 这一行本身（kind 'record'）
  cascade:    [ … ],        // 跟着删除一起走（kind 'own'）
  audit:      [ … ],        // 审计历史：不挡、也不删
  foreign:    [ … ],        // 别人的 ASIN：与这条记录无关
  gaps:       [ … ],        // 引用检查本身的洞（见下）
  unclassified: [ { table, column } ],   // 派生出来但没人分类 → 必须为空
}
```

**五种 kind，各自的行为**（一张表，一份实现）：

| kind | 表 | 挡删除？ | 删除时 |
|---|---|---|---|
| `record` | `asin` | 否 | 删掉（就是它） |
| `own` | `asin_field_source` | 否 | **跟着删** |
| `audit` | `asin_archive_event` | 否 | **留下**（删了就没有复盘材料了） |
| `foreign` | `kw_competitor_fact` / `kw_master` / `kw_master_case_merge_archive` | 否 | 不动 |
| `reference` | 其余 15 条列 + 3 条 JSON + 1 条多态 | **是** | 拒绝 |

★ **`asin_field_source` 必须是 `own` 而不是 `reference`** —— 这一条**实测**过：
`upsertAsin` 每写一个字段就记一条溯源，所以把它算成引用之后，一次 `amzn_asin_upsert`
之后的记录**必然**至少有一条，于是**受限删除永远删不掉任何东西**（功能整个失效，
而且失效得毫无提示）。它跟着删才是对的：留着的话，下一次导入同一坐标会撞上上一次的僵尸溯源行。

### 2.5 `deleteAsin(store, {asin, marketplace, reason, by, references})`（新，`store/archive.js`）

**三个前置条件**，各有各的错误码：

1. 坐标在库内 —— 否则 `ASIN_NOT_FOUND`。「删掉了一条不在库里的记录」是「以为做完了一件事」的典型形态。
2. `reason` 非空 —— 否则 `ASIN_DELETE_REASON_REQUIRED`。归档与恢复可以空着（可逆），删除不行：
   事后唯一的复盘材料就是这一格加事件行里那份报告。
3. **0 处引用** —— 否则 `ASIN_REFERENCED`，并把引用逐条列出来。
   这是「仅限导入错误」这个窄口径的落地方式：一条被采集过、被优化过、被发布过的记录
   **必然**有引用，于是它删不掉 —— 而它本来就该走归档（误售停用不得删除）。
4. **引用检查本身必须完整** —— 否则 `ASIN_REFERENCE_CHECK_INCOMPLETE`。见下。

★ **覆盖不全时拒绝删除**，理由与「有引用」分开说：`total === 0` 在检查有洞时只意味着
「在检查覆盖到的范围内没有引用」，那不是可以据以删除的结论。`referenceCheckGaps` 查两个方向：
派生出来但没人分类（新加了一张带 asin 列的表）、分类表里有而库里没有（改名了 ——
那条分类会**静默地永远数出 0 条**）。合成一句话会让下一个人以为去清掉引用就能删。

★ **一个事务**：写 `action='delete'` 的事件行 + 删 `cascade` 表里那些行 + 删 `asin` 行。
事件行**先写**（同一事务里顺序不影响原子性，但这段代码读起来就是它的语义：先记账，再动手）。
`impact_json` 存的是**删除前实测的引用报告** —— 事后想复盘「当时凭什么判定它没有引用」
就只剩这一份（与 `restoreAsin` 不写 impact 形成对照：恢复不挡任何人）。

### 2.6 错误码

| code | 触发 | 表面 | 谁转 |
|---|---|---|---|
| `ASIN_NOT_FOUND` | 坐标不在库内（archive / restore / delete / impact / references 五处同一句话） | 400 | 路由 / `{ok:false}` |
| `ASIN_ARCHIVED` | 对已归档的 ASIN 发起写入（`assertAsinWritable`） | 409 | 路由 / `{ok:false}` |
| `ASIN_REFERENCED` | `delete` 时引用报告非空 | **409** | 路由 / `{ok:false}` |
| `ASIN_REFERENCE_CHECK_INCOMPLETE` | 引用检查有洞（未分类的候选 / 失踪的分类项） | 400 | 路由 / `{ok:false}` |
| `ASIN_DELETE_REASON_REQUIRED` | `delete` 的 `reason` 为空 | 400 | 路由 / `{ok:false}` |
| `ASIN_ARCHIVED_FILTER` | `filters.archived` 不是三个字面值之一 | 400 | `throw`（store 层）/ 工具转返回值 |
| `APPROVAL_REQUIRED` | `archive` 没带 `confirm` 且该开关开着；或 `delete` 没带 `confirm`（**恒定**） | 409 | 路由 / `{ok:false}` |
| `PREVIEW_IS_A_GET` | 读动作（`preview` / `delete_preview`）从写路由进来 | 400 | 路由 |

### 2.7 `assertAsinWritable` 新增 `mustExist`（`store/archive.js`）

| 入参 | 默认 | 语义 |
|---|---|---|
| `mustExist` | `true` | 坐标不存在时：`true` → 抛「不在库里」（既有两个调用点的行为一字不改）；`false` → 放行（**新建**），但「存在且已归档」照旧抛 `ASIN_ARCHIVED` |

`false` 是给 `amzn_asin_upsert` / `amzn_asin_import` 用的：它们**能新建**，
而对一个还不存在的 ASIN 调它，「不在库里」不是错误、是正常的新建。

---

## §3 迁移与回滚

### 3.1 v46（本批唯一迁移）

```sql
-- B-05e / F05-08 收口。
--
-- ★ 本迁移**不加列、不加表**：归档需要的三列（archived_at / archive_reason /
--   archived_by）与事件表 asin_archive_event 由 v37（asin-datacenter）已经建好，
--   §1 的实测逐条列出了它们的位置。再加一遍只会得到两份真相。
--
-- ★ 本迁移只补一个索引，理由是「隐藏」这条规则第一次变得**可查**：
--   在 v46 之前 archived_at 只有 archivedAsinCount 一个读点（全表扫一次就完），
--   现在它同时是默认列表的过滤条件（queryAsins 的 archived='hide' 与 'only'
--   两个方向都要走这一列），而页面在采集进行中每 3 秒轮询一次 /api/state。
CREATE INDEX IF NOT EXISTS idx_asin_archived ON asin(archived_at);
```

**幂等性**：`CREATE INDEX IF NOT EXISTS` 可重复执行（与之前每一步同一条约定）。

**★ 副作用（实测）**：SQLite **拒绝 `ALTER TABLE … DROP COLUMN` 一个被索引引用的列**。
本仓有三处测试用 `DROP COLUMN archived_at` 来模拟「v37 之前的库 / 这一列被删过」
（`tests/b05-orphan-wiring.mjs` 的 B05O-② / ②b / ②d）。它们现在必须先
`DROP INDEX IF EXISTS idx_asin_archived`。
这**不是**为了让测试过得去：一个 v37 之前的库**两者都没有**（列与索引来自同一步迁移），
所以「列没了」那个形状本来就应该是「索引也没了」。三处都按这个形状改了，并写了理由。

### 3.2 回滚

```sql
-- v46 回滚 —— 回到 v45 的形状。
DROP INDEX IF EXISTS idx_asin_archived;
```

- 回滚**只删索引**，不动任何数据：`archived_at` 那三列与事件表都是 v37 的，回滚本批
  **不该**把它们删掉（删了就等于顺手回滚了 B-05a 已交付的功能）。
- 回滚**不丢数据**：索引里没有数据。
- 回滚后 `queryAsins` 的 `archived` 过滤**仍然可用**（只是退化成全表扫），
  所以「回滚索引」与「回滚功能」是两件事 —— 本批不提供「回滚功能」的迁移：
  归档功能的数据面是 v37 的，代码面回退代码即可。

### 3.3 迁移探针（开工前 + 落地后各跑一次）

```
node scripts/check-migrations.mjs
→ {"count":46,"SCHEMA_VERSION":46,"dups":[],"continuous":true,"last":"asin-archive-index","first":"initial-schema"}
→ 迁移表自洽 ✓
```

---

## §4 关键数字（本批生效的上限 / 阈值，唯一来源）

| 数字 | 值 | 唯一来源 | 为什么是这个值 |
|---|---|---|---|
| 归档筛选模式 | 3 | `ASIN_ARCHIVE_FILTERS`（`store/queries.js`） | `hide` / `only` / `all` |
| 数据层默认模式 | `all` | `ASIN_ARCHIVE_DEFAULT` | 见 §2.1 的实测理由（两个读者已决定「显示并标记」） |
| 页面默认模式 | `all` | `ASIN_PAGE_ARCHIVED`（`routes.js`） | 页面显式拥有这一格，不吃数据层默认 |
| 引用检查候选表 | 20（列）+ 3（JSON）+ 1（多态） | `archive-refs.js` 的 `ASIN_REFERENCE_SOURCES` / `ASIN_JSON_SOURCES` / `ASIN_OBJECT_ID_SOURCES` | 见 §1 参考集；派生 ∪ 显式 |
| 「跟着删」的表 | 1（`asin_field_source`） | `ASIN_REFERENCE_SOURCES` 里 `kind === 'own'` 的那些 | 表清单**从同一张分类表读**（`asinCascadeTables()`） |
| 事件行 `action` 值域 | `['archive','restore','delete']` | `ASIN_ARCHIVE_ACTIONS` | 三个方向 = 三件不同的事 |
| 删除的前置条件 | 4（存在 / 理由非空 / 0 引用 / 检查完整） | `deleteAsin` | 每个各有各的错误码 |
| 注册的工具总数 | 134 | `index.js` 的 `TOOLS` / `buildTools` | 本批 +1（`amzn_asin_delete`）；**不钉绝对数**，守卫是逐名集合相等 |
| `listArchiveEvents` 上限 | `1..500`，默认 `50` | `store/archive.js` | 既有，本批不动 |

---

## §5 非目标（明确不做，及理由）

1. **不在 `upsertAsin` 里加闸门**（`store/queries.js`）。它是八十几条路径 + 后台 worker
   共用的写口；在那里加闸门会让**采集 worker 自己**在归档的 ASIN 上失败，把一次用户动作
   变成一次后台任务的静默停摆。本批把闸门加在**面向用户的工具层**
   （`amzn_asin_upsert`）与**导入器**（`domain/asin/import.js` 的 `applyAsinImport`，
   逐行失败、其余行照常写入）。
   **后台 worker 与其它直连 `upsertAsin` 的调用点不受本批约束** —— 这一点写成
   **现状断言**（`B05E-④` 里真调一次直连路径，断言它现在**不**被挡），而不是含糊过去：
   将来有人在那里加闸门时，那条断言会变红并提醒「你改的是契约里划出去的那一条」。
2. **不把页面 ASIN 表的默认改成 `hide`**。理由在 §2.1 的实测那一段。本批提供三态筛选
   并让默认**显式可读**，把口径决定留给 PM（见 §7）。
3. **不给删除做批量**（一次一条）。批量删除是本仓反复出事的形态，且与
   「仅限导入错误」这个窄口径冲突。
4. **不做恢复的 `restored_at` 列**。理由已在 `store/archive.js` 写明：多一列就多一个
   「现在是不是归档的」的答案，而这是归档最不该出错的地方。本批沿用。
5. **不动 `src/domain/collect/**`、`src/domain/snapshot/**`、`src/domain/dashboard/**`、
   `src/store/keyword-ownership.js`、`src/domain/approval/policy.js`**（别的批次在改 / 不在作用域）。
6. **不碰 `queries.js` 的父体子查询**（`queries.js:387-390`，另一批次在做「父体列不再静默取第一个」）。
   本批在 `queries.js` 的全部改动就是一个过滤块 + 一个包含它的列探测，物理上不与该子查询同行。
7. **不加 `approval.delete` 开关**（见 §2.2 第 3 条）。删除的确认是恒定前置条件。

---

## §6 一条规则一份实现（验收判据）

| 规则 | 唯一实现 | 两条读路径 | 实测判据 |
|---|---|---|---|
| 「已归档的集合」 | `queryAsins` 的 `archived` | `amzn_asin_query`（会话侧）＋ `GET /api/state` 的 `asins`（页面侧） | 变异 `filter` → `B05E-③` / `③b` / `⑪` **同时**红 |
| 「这一行是不是归档的」 | `projectAsinRow` 的 `out.archived` | `amzn_asin_query` 的逐行标记 ＋ 页面 `renderAsinCell` 的芯片 | 变异 `projection` → **工具侧与页面侧同时红**（验收判据那一条） |
| 「什么引用了一条 ASIN」 | `asinReferenceReport` | `amzn_asin_delete(delete_preview)` ＋ `GET /api/asin-archive-impact` 的 `references` 格 | 变异 `reclassify` → `B05E-⑥` / `⑧` 红 |
| 「已归档的总数」 | `archivedAsinCount` | 概览切片 ＋ 列表的 `archivedTotal` | `B05E-③` 断言两者相等 |
| 「所属竞品组」 | `competitorSetsContaining` | `archiveImpact` ＋ 引用检查 | `B05E-②` 断言两条路径同数 |
| 「归档状态」 | `asin.archived_at` 单列 | 详情芯片 / 列表芯片 / `isAsinArchived` | `B05E-⑤` 断言布尔就是那一列非空 |

**页面只读载荷**：页面画 `archived` 芯片、画口径行，读的都是服务端给的格
（`row.archived` / `state.asinArchived` / `state.asinArchivedHidden`），
**不内联重算** `archived_at !== null`（`B05E-⑫` 在口径那一块里断言这个列名不出现）。

---

## §7 裁决记录（第 1 条**已裁决**，第 2 条仍未决）

1. ✅ **已裁决（2026-10-13，用户）：保留现状（默认 `all`）+ 提供三态筛选。**
   需求的字面是「归档后隐藏」，而 `domain/asin/table.js` / `tools/asin.js` 都已经落地
   「不隐藏、只打标记」并写明理由（把一条记录藏起来会让它看起来像数据丢了）。
   **裁决采纳实现侧的口径**：归档语义是「不再作为候选」，不是「从库里看不见」；
   藏掉会让一次**成功**的归档长得像数据丢了。
   需求文档的 F05-08 那一格已就地订正（`docs/requirements/RESEARCH-module-alignment-v2.0.md` 的 D5 行），
   `ASIN_ARCHIVE_DEFAULT` / `ASIN_PAGE_ARCHIVED` **维持 `all`**，不再需要改这两格。
2. **`delete` 该不该有一个可配置的确认开关？** 本批是恒定要求 `confirm: true`
   （理由见 §2.2）。若产品上希望它可配置，需要新增 `approval.delete` 并评估
   「一个能被关掉的删除确认」的产品含义。
