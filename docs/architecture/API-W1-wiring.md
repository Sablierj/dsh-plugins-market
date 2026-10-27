# W1 接线批 · 接口契约（G2）

> **日期**：2026-10-03 ｜ **作者角色**：架构师 + 主理人 ｜ **状态**：已通过（G2）
> **关联需求编号**：F01-01 / F01-02 / F02-01 / F03-02 / F03-05 / F05-03 / F05-04 / F06-01 / §31
> **证据等级**：契约里引用的「现状」全部来自 `docs/requirements/RESEARCH-module-alignment-v2.0.md` §4.1，其中四条零调用方已由主理人独立 grep 复核（verified）。
> **批次**：W1 ｜ **分支**：`dsh-w1` ｜ **工作树**：`D:\deepseek-harness-h\workspace\wt-dsh-w1`
> **基线**：`HEAD 70120ef`，schema **v32**，TOOLS **67**，`node tests/run.mjs` = **767 passed / 0 failed**

## 0. 这一批是什么、不是什么

**是**：把已经建成、但没有生产方/消费方的机制**接上**。每条改动都是「让一个已存在的函数被真实调用」，或「让一个已算出的值被真实渲染」。

**不是**：不动表结构（**本批不新增任何迁移**）、不新增 `amzn_*` 工具、不做页面重设计。

## 1. 通用验收（每一条都适用）

| 项 | 判据 |
|---|---|
| 自检 | `node tests/run.mjs` 全绿，断言数 **≥ 767 且只增不减**（不允许删既有断言换绿） |
| 预检 | `node scripts/check.mjs` 报 `OK`，工具数仍是 **67** |
| 断言 | 每条改动**至少带一条断言**，且该断言在改动被回退时会变红（能证伪） |
| 迁移 | `src/store/schema.js` 的 `MIGRATIONS` **一行都不改** |
| 回归 | 既有 767 条断言一条不红 |

## 2. 逐条契约

### W1-1 · 快照登记接上生产方（F03-05 / F05-04 / F06-01）

**现状（verified）**：`registerSnapshot`（`src/store/snapshot.js:98`）在 `src/` 下**零调用方**，只有 `tests/s1b11-snapshot.mjs` 与 `tests/s1b19-retention.mjs` 调它。`snapshot_registry` 的行全部来自 v26 迁移的一次性回填。

**已有契约（不要改它）**：

```js
registerSnapshot(store, {
  objectType,   // 必须 ∈ SNAPSHOT_OBJECT_TYPES（src/domain/states.js:109）
  objectId,     // 非空
  refTable,     // 可空；给了 refTable 就必须给 refId
  refId,        // 指针式快照
  payload,      // 冻结式快照；refId 与 payload 至少要有一个
  version,      // 可空；不给则由 nextVersion() 递增（src/store/snapshot.js:79）
})
```

`SNAPSHOT_OBJECT_TYPES = ['listing','kw_master','competitor_set','rule_set','prompt_set','draft','context_package']`

**要接的调用点（每条都要新版本、不覆盖历史）**：

| # | 写入路径 | objectType | objectId | 指针/冻结 |
|---|---|---|---|---|
| a | 采集写入 listing 快照之后 | `listing` | `` `${asin}@${marketplace}` `` | `refTable:'asin_snapshot'`, `refId:<新快照 id>` |
| b | 关键词总库整层重建（`recomputeMaster`）之后 | `kw_master` | `<marketplace>` | **`payload` = 有界描述符（见 §2.1），不是整层正文** |
| c | 竞品组 upsert 之后 | `competitor_set` | `<setId>` | `payload` |
| d | 优化草案保存之后 | `draft` | `<draftId>` | `payload` |

**非目标**：**不建 `context_package`**。`src/store/snapshot.js:50` 的 `PENDING_SNAPSHOT_TYPES` 已明示它待 Agent 平面接入（Q8），本批保持原样。

**验收**：

1. 对同一对象连续写入两次 → `snapshot_registry` 出现**两行**、`version` 不同、两行都能按 id 解析出内容。
2. 页面「快照管理」默认视图能看到运行期新产生的版本（不再是只有迁移回填的那些）。
3. 断言必须能证伪：把任一调用点注释掉，至少一条断言变红。

### 2.1 修订（2026-10-03，主理人裁决）：`kw_master` 的快照不许冻结正文

**原契约写错了，这是主理人的错，不是实现方的错。** 原契约要求 `kw_master` 的 payload 冻结整层内容。实测（真实库 `data/amazon-ops.db`，US 站 **30 777** 行）：

| 方案 | 单次体积 |
|---|---|
| 冻结整层正文 | **49.16 MB** |
| gzip -9 后冻结 | 2.12 MB |
| **描述符 + 摘要** | **75 字节** |

而 `recomputeMaster` **每次导入合并都会跑**。库当前 68 MB，冻结正文等于几次合并就翻倍——**这个方案不能进主线**。

**裁决理由**：`kw_master` 是**衍生层**（`recomputeMaster` 可从 `kw_aba_fact` / `kw_ad_fact` / `kw_competitor_fact` 三张事实表整层重建，而事实表按模块 03 的留存策略长期保留）。冻结衍生层正文既昂贵又冗余——数据平面自己的原则就是「原始数据不可被衍生结果覆盖」，衍生层本来就不该被当成原始数据存一份。

**修订后的契约**：`masterSnapshotPayload(store, marketplace)` 返回**有界描述符**：

```js
{
  marketplace,
  count,        // 本层行数
  columns,      // 列数
  digest,       // sha256（逐行 update，不要先拼一个 49 MB 的大字符串）
  composedAt,   // nowIso()
  rebuild: { from: 'fact tables', via: 'recomputeMaster' },
}
```

**这条修订改了什么、没改什么**：

- **没改**：快照仍然「新版本追加、不覆盖历史」；仍然只在 `rows > 0 || removed > 0` 时登记；`objectId` 仍是 `<marketplace>`。
- **改了**：`kw_master` 版本的「可独立解析」口径，从**读回正文**改为**可重建 + 可校验**——用同样的事实集重跑 `recomputeMaster`，`digest` 必须相同。
- **已知边界（写进交接条，不假装满足）**：`kw_master` 的快照对比**不做字段级 diff**（没有正文可比），只比 `count` 与 `digest`。F03-05 的「快照对比返回字段级差异」这条验收**在 `kw_master` 这一类上不成立**，其余三类（listing 指针 / 竞品组 / 草案）不受影响、仍然冻结正文。

**新增断言要求**：

1. 同一事实集连续两次重建 → **`digest` 相同**（证明可重建）。
2. 事实集变化后重建 → **`digest` 不同**（证明摘要有意义）。
3. 大层下 payload **有界**：造一个大夹具（≥2 000 行）重建后，断言 `payload_json` 长度 < 64 KB。

### 2.2 补充修订（2026-10-03 同日，主理人验收时发现）

这两条是**断言先发现、再由人定位**的，记在这里因为它们都属于「设计错了而不是实现错了」。

**(1) `digest` 必须排除 `updated_at`。** 第一版把 `SELECT *` 的每一列都哈希进去，结果**同样的事实集重建两次得到不同摘要**（断言 W1-1b-2 直接变红，附了两个 sha256）。原因：`recomputeMaster` 每次都会重写 `updated_at`，于是摘要变成时间的函数，失去校验能力。

- **排除**：`updated_at`（每次重建都重写，是记账列不是内容）。
- **保留**：`first_seen_at` —— 它是**唯一不随事实变化**的列（`kw.js` 重建时把旧值读回来），所以它**是**内容。
- 判据：摘要必须**只在内容变化时**变化。这条要能证伪——`W1-1b-2` 就是它的证伪断言。

**(2) 删掉 `upsertAsin` 里冗余的批量冲突刷新。** `upsertFieldSource` 内部已经逐字段调 `refreshConflictsFor`（`store/field-source.js:146`，源码注释自称 *primary detection hook*），而 `refreshConflictsFor` 本身就是按 `fields` 逐个处理的（`store/conflict.js:211`），所以外层那次批量调用与之**完全等价**。

原实现里那句注释（「这一遍覆盖没有 `sourceId` 的调用方写的字段」）**不成立**：没有 `sourceId` 时那个列表是空的，这一遍根本不会跑。**注释与代码不符本身是本仓认定的缺陷**，所以删掉调用、删掉 `writtenFields`、删掉随之失效的 `refreshConflictsFor` import，并把「没有 sourceId 就没有来源行、也就没有冲突可报」这个**不变的行为**写进注释。

---

### W1-2 · 溯源七列接上生产方（F03-02 / F05-03）

**现状（verified）**：`upsertFieldSource`（`src/store/field-source.js:81`）在 `src/` 下**零调用方**。生产写入路径 `upsertAsin`（`src/store/queries.js:213-219`）只写 `value/confidence/updated_at`，**注释里明说它故意不写 `observed_at`**。后果：v24 加的七列永远是空的 → 质量驾驶舱的「时效」维度永不触发，血缘页只能显示「观测时间未记录」。

**已有契约（不要改它）**：

```js
upsertFieldSource(store, {
  asin, marketplace, field, sourceId,   // 必填；asin 必须 /^[A-Z0-9]{10}$/
  value, confidence,
  sourceType,     // ∈ ['collect','import','manual','derived']；不传则按 sourceId 推导
  observedAt,     // 观测时刻。**undefined 会写 NULL，这是有意的**（见源码 :133-135）
  ingestedAt,     // 不传默认 now
  rawValue, rawUnit, parserVersion, qualityState,
})
```

**要接的调用点**：`upsertAsin` 的写入路径（采集器与 `amzn_asin_upsert` 都走它）在写字段值时**同时**调 `upsertFieldSource`，带：

- `sourceType: 'collect'`（采集路径）／`'import'`（导入路径）／`'manual'`（人工）
- `observedAt`：采集路径**必须传**（它知道采集时刻）。这是本条的要点——源码注释说的「不知道什么时候不能覆盖知道」，采集路径属于「知道」。
- `rawValue` / `rawUnit` / `parserVersion`：能拿到就传，拿不到就留空（不要编造）。
- `qualityState`：按实际情况传，拿不到就留 `null`。

**验收**：

1. 采集写入后，`asin_field_source` 对应行的 `observed_at` **非空**，且 `source_type` 为 `'collect'`。
2. `fieldProvenance(store, {asin, marketplace})` 能返回带观测时间的来源列表。
3. 质量驾驶舱的时效维度对「观测时间在阈值外」的字段能产出问题（改动前永远产出不了）。
4. 断言可证伪：不调 `upsertFieldSource` 时至少一条断言变红。

---

### W1-3 · 归档工作空间真的只读（F02-01）

**现状（verified）**：`assertWorkspaceWritable`（`src/store/workspace.js:152`）在 `src/` 下**零调用方**——只在 `workspace.js:16` 的注释与 `src/web/routes.js:1866` 的注释里被提到。「归档后只读」目前只是一句文案。

**契约**：把它接到**所有配置类写入点**：`site_profile` / `shop` / `brand` / `product_line` / `setting` / `source` 的写路由（`routes.js` 的对应 `POST /api/*`）与写工具。

**验收**：

1. 归档某工作空间后，对该空间的上述六类对象发起写 → **结构化拒绝**（含错误码与原因，例如 `WORKSPACE_ARCHIVED`），且**不落库**。
2. 未归档空间不受影响（同一条断言要双向：归档的拒、未归档的过）。
3. 已归档空间的历史**仍可读**。

---

### W1-4 · `findImportByName` 的去留（判据：有意图 vs 无意图）

**现状（verified）**：`findImportByName`（`src/store/kw.js:46`）零调用方，**连测试都没调过**。

**契约**：先读它的注释与它和 `findImportByFingerprint`（`src/store/kw.js:42`）的关系，判定它属于哪一类，再动手：

- **有意图**（本仓的 `importDir` 就是这一类）→ **接上**，让它真的被调用；
- **无意图**（本仓的 `approval.floor` 就是这一类）→ **删掉**，并在交付说明里写清「删的理由」。

**不允许**：既不接也不删、留着当死代码。

**验收**：给出结论 + 理由 + 对应的代码改动；若判「接」，要有一条断言证明它被调用。

---

### W1-5 · `canSubmitDraft` 接到优化提交（F01-01 验收第 4 条）

**现状**：`canSubmitDraft`（`src/domain/optimize/context.js:41-68`）零调用方。

**契约**：接到优化草案的提交路径（`amzn_optimize_save` / `amzn_optimize_validate` 中的提交动作）。上下文变化后，旧草案的状态应标为「上下文已变化」且**提交被拒绝**。

**验收**：

1. 切换上下文（改站点/产品线等）后，对旧草案发起提交 → 被拒，错误信息含「上下文已变化」。
2. 上下文未变化时提交正常通过（双向断言）。
3. 与 F01-01 的验收口径一致：**不可静默沿用**。

---

### W1-6 · 健康卡的 `detailLink` 变成可点（F01-02）

**现状**：`src/domain/dashboard/health.js` 已经为六张卡算出了 `detailLink`，但**没有消费方**——`page.js` 的卡片模板不渲染它。对比：`todos` / `quick-actions` / `recent` 三者都有可点链接。

**契约**：`page.js` 的六卡模板消费 `detailLink`，点击跳到对应模块并带上筛选参数。

**验收**：

1. 六张卡每张都有可点链接（DOM 断言）。
2. 链接目标与 `health.js` 返回的 `detailLink` **逐字一致**（自动化断言）。
3. 单卡数据源抛错时，其余五卡的链接仍在。

---

### W1-7 · 审计漏斗补 worker 写入（§31）

**现状**：审计只有两个漏斗——`tools/index.js` 的 `instrument`（工具）与 `routes.js` 的 `pageWrite`（页面）。后台采集/关键词 worker 的写库**不留行**。

**契约**：后台 worker 的写库路径接入 `recordAudit`，至少覆盖 `asin` / `listing` / `kw_master` / `kw_import` 四类对象。

**约束**：**不记录密码 / Cookie / Token / 完整敏感 Prompt 变量**——沿用 `src/domain/audit/redact.js` 的脱敏，不要新写一套。

**验收**：

1. 跑一次采集/导入后，`audit_log` 新增行且含对象、动作、前后值。
2. 对审计查询的响应体做敏感词扫描，不含凭据明文。
3. 断言可证伪：去掉 worker 的埋点，至少一条断言变红。

---

### W1-8 · 过期声明修正（F01-05）

**现状**：`src/domain/dashboard/quick-actions.js` 的 `optimize-prepare`（生成优化准备包）标 `available:false`，理由写的是「阶段 1 不做模块 12，导航里没有这一项」。**而模块 12 已在 `253871e` 交付**（`MODULE_GROUPS` 有 `agent` 组、有渲染器、6 个工具），目标锚点已可达。更麻烦的是 `tests/s1b14-quick.mjs:321` **把这条过期现状钉死了**。

**契约**：二选一，并说明理由：

- 若模块 12 确实已能承接 → 改成可用，**同时改掉那条把过期现状钉死的断言**（改成断言真实行为）；
- 若仍有真实阻碍 → 把理由更新为**当前**的阻碍，不允许留一条已经不成立的旧理由。

**验收**：快捷动作六项的状态与理由都与当前代码事实一致；对应断言在理由过期时会变红。

## 3. 交付物

- 代码改动在 `dsh-w1` 分支；
- 每条改动带断言；
- 交接条（按 `docs/COORDINATION.md` §2.1 格式）写进 commit message；
- 本契约文件本身随分支提交。

## 4. 风险与回滚

| 风险 | 处置 |
|---|---|
| 接 `upsertFieldSource` 后写入量翻倍，可能拖慢采集 | 单 ASIN 字段数有限（核心字段 4 + 属性 43），先按需写；若实测慢，改为只写「有溯源信息」的字段并记入交接条 |
| 接 `registerSnapshot` 后 `snapshot_registry` 增长快 | 保留 `docs/COORDINATION.md` 与模块 03 的留存策略；本批不引入清理，增长量记入交接条 |
| 归档工作空间拒写可能挡住既有测试路径 | 双向断言：未归档必须仍能写 |
| 回滚 | 本批**无迁移**，回滚 = `git revert` 单个 commit，不需要数据回滚 |
