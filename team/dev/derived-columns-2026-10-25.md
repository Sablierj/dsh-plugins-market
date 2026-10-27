# 派生列扫描：**看起来可写、其实是缓存**的列（2026-10-25）

- 提出：dev-10 · 触发：同一天同一个陷阱在两个模块各出现一次
  - `kw_master.product_line` 由 `recomputeMaster` 重算（dev-12 抓到）
  - `asin.product_line_id` 由 `syncProductLineCache` 从 `asin_ownership` 刷出（本单抓到）
- 扫描方式：遍历 `src/**/*.js`，找**函数名以 `sync|recompute|derive|refresh|rebuild|recalc|backfill|ensure` 开头**、
  且函数体内含 `UPDATE <表> SET` 的位置；再逐个判「这一列是不是事实，还是别的表的投影」。
- 一句话结论：**判据不是「这列在不在 `asin` 表上」，而是「有没有一个你看不见的函数会重写它」。**

---

## 一、真·派生列（有重算函数会覆盖它 —— 不许当事实列写）

| 列 | 谁重算它 | 重算时机 | **写它的正确入口** | 现状 |
|---|---|---|---|---|
| `asin.product_line_id` | `syncProductLineCache`（`store/ownership.js:212`） | **每一次** `upsertOwnership` / `retractOwnership` 之后（`store/ownership.js:137`、`185`），包括自动派生落库 | `upsertOwnership({ objectType: 'product_line', objectId })`；页面/工具统一走 `setAsinOwnership`（FR-M2-05 在建） | ⚠️ **有违规写法，正在修**：页面曾用 `asin-field-correct` 写这一列（写的是缓存）；`upsertAsin({product_line_id})` 同样是在写缓存（B 方案只保证它留痕，不保证它不被刷掉） |
| `asin_keyword.tier`、`asin_keyword.tier_basis_json` | `recomputeTiersForAsin`（`sources/keyword.js:450`） | 该 ASIN 的排名/覆盖变化后按 ASIN 重算 | **不要直写**：写 `asin_keyword.rank` / 覆盖事实，tier 由重算得出 | ✅ 无违规（`amzn_keyword_import` 的 tier 也是「由 rank+覆盖派生」，工具描述里写明了不接受手设） |
| `keyword.tier`、`keyword.updated_at` | 同上（`sources/keyword.js:463`） | 同上 | 同上 | ✅ 无违规 |
| `kw_master.*`（含 `product_line`、`search_volume`、`tier`…） | `recomputeMaster`（dev-12 **未提交**的 `src/store/keyword-product-line.js`） | 每次 `amzn_kw_merge` / 归属批量写入之后 | `setKeywordProductLine…`（dev-12 的 store 函数）／`amzn_kw_merge`；**不直写 `kw_master`** | ⚠️ dev-12 已抓到并修（它那一单的口径） |
| `observation_checkpoint.status` / `blocked_reason` / `missing_json` | `ensureCheckpoints`（`store/observe.js:678`、`711`） | 每次 `observation_plan_save` / `check` 时物化 | `amzn_observation_plan_save` / `amzn_observation_check` | ✅ 无违规 |
| `policy_check_runs.status` | `recomputeRunStatus`（`store/policy-candidate.js:283`、`298`） | 每次判定写完之后 | `amzn_policy_*` 的判定流程 | ✅ 无违规 |

## 二、看着像派生、其实不是（**别误判，否则会把状态机当缓存绕开**）

| 列 | 写它的函数 | 为什么不是缓存 |
|---|---|---|
| `collection_task.status` | `recoverStaleTasks`（`store/queries.js:1243`） | 它只动**卡住**的行（`running` 超时 → `blocked`），是一次巡检而不是重算；正常状态迁移仍在 `updateCollectionTask` |
| `rule_set.is_active` | `activateVersion` / `publishFrom`（`store/rules.js:210`、`288`） | 「同时只有一个生效版本」是**不变式**，函数在同一次事务里把别的置 0 —— 那是状态机，不是派生 |
| `product_line.version` / `signals_json` | `setLineSignalsVersioned`（`store/product-line.js:111`） | 版本号由写入方递增，是**写时计算**，不会被别人重算 |
| `optimization_run.draft_version` | `bumpDraftVersion`（`store/queries.js:1659`） | 同上：单调递增，只有保存草案那条路径动它 |
| `field_conflict.status/adopted_value` | `upsertConflict` / `resolveConflict` / `reopenConflict` | 决策表，三个函数就是它的状态机（FR-M2-05 的 B 方案正是在这台机器上跑的） |

## 三、结论：**可写列白名单**

页面 / 工具可以直接写的，只有这两类：

1. **事实列**（采集来的、人工可修正的）：
   `asin.title` `brand` `price` `currency` `bsr` `category` `rating` `reviews` `image_url`
   → 走 `correctAsinField`（人工）或 `upsertAsin`（采集/导入，会留痕）。
2. **决策表自己的列**：
   `asin_ownership.*`（边）、`field_conflict.*`（裁决）、`keyword_ownership.*`（认领）
   → **各走各的状态机函数**，不写 SQL。

**不在白名单里的（写了就是写缓存，早晚被刷掉）：**
`asin.product_line_id` · `asin_keyword.tier*` · `keyword.tier` · `kw_master.*` · `observation_checkpoint.status`
· `policy_check_runs.status` · `rule_set.*`（除非经状态机）

## 四、给下一次「行内改某格」的检查单（三条，按顺序问）

1. **这一列有没有一个 `sync*/recompute*/derive*` 函数会重写它？** 有 → 它是缓存，别写它，去写它的源。
2. **它的源是哪个入口？** 源在别的表（如 `asin_ownership`）就要走那张表的 store 函数，并且**页面与工具必须同一个函数**（否则审计与语义各一份）。
3. **写完会不会被下一次无关写入刷掉？** 会 → 加一条守门断言：**写完 → 触发一次那个 sync → 值不许变**（t78 ⑬ 就是这一条的形状）。
