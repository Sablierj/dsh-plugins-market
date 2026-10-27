# T73 审计对象类型 / 写分类盘点（dev-7）

> **树标识**：`amazon-ops` @ git HEAD `c11909b`，工作树有未提交改动（多支笔并行）。本报告定稿快照的 SHA-256 前 16 位：
>
> | 文件 | SHA-256（前 16 位） |
> |---|---|
> | `src/domain/states.js`（含本次改动） | `cec0e2e1c3e624ac` |
> | `src/domain/audit/targets.js` | `e22b24b317fe68a9` |
> | `src/web/routes.js` | `84f33c1a8b992206` |
> | `index.js` | `cee1023a239b869d` |
>
> 扫描时间：**2026-10-23T22:48+08:00**（UTC 14:48）；**22:56 与 23:03 两次复扫四个文件哈希均未变**（同一快照），并在此快照上重跑了 T73。本报告只对这份快照负责；树在扫描期间变过一次，见 §三 的「时间线」。
>
> 口径：只跑了定向测试 `node tests/t73-audit-inventory.mjs`，**没有跑全量 `tests/run.mjs`**；本报告不报树号，也不把未执行的套件写成通过。

## 一、结论

1. **`review_analysis_run` 是真对象，已加入 `AUDIT_OBJECT_TYPES`（只加这一个）**。它不是路由为了省事造的名字：`review_analysis_runs` 有自己的 `id`（`ra-…`）与 `created_at`，`review_annotations.run_id` 是指向它的外键，读回也以「最近一次 run」为单位。依据见 §二。
2. **改动只有两处**：`src/domain/states.js` 的 `AUDIT_OBJECT_TYPES` 末尾加 `'review_analysis_run'`（+7 行，含注释）；新建 `tests/t73-audit-inventory.mjs`。**未触碰** `src/web/routes.js`、`src/domain/prompts/**`、`src/web/pages/**`、`src/store/schema.js`、`tests/run.mjs`。
3. **盘点（定稿快照）**：工具 **142/142** 已登记（写 77、只读 65、漏登记 **0**、类型不被接受 **0**）；POST 路由 **86/86** 已登记（写 73、只读 13、漏登记 **0**、类型不被接受 **0**）。修复前有 **1** 条类型不被接受：`review-analysis-run → review_analysis_run`。
4. **T73 先红后绿**：首版 **9 条检查 / 3 条红**（②⑥⑨）；修正两处悬空 `await` 后仍 9 条；按 lead 要求新增字面一致性断言 ⑩ 后为 **10 条检查 / 0 条红**，共 **21 个 `equal`/`deepEqual` 断言**（另有 10 个非空/前置守卫）。
5. **时间线必须说清**：任务书列的 4 条新 POST 路由里，`policy-check-start` / `policy-candidate-confirm` / `policy-candidate-reject` 在我 **22:37** 的第一次扫描时确实不在 `PAGE_WRITE_TARGETS` 里（漏登记 3 条）；**22:39:19** 另一支笔把这三条补进了 `targets.js`，所以本报告定稿快照的漏登记是 **0**。`review-analysis-run` 在 22:37 时已经登记，问题只是它的 `objectType` 不被白名单接受。详见 §三 的「时间线」与 §四 的工单。

## 二、判定：`review_analysis_run` 该不该成为审计对象类型

### 2.1 规则（来自代码注释，不是我的偏好）

- `src/domain/states.js` 对 `AUDIT_OBJECT_TYPES` 的规则：**单数表名**，让 `audit_log.object_type` 与它描述的表「只差一个词」，而不是两套需要映射的词汇。
- `src/store/audit.js:169-171`：`recordAudit` 在写入前检查 `AUDIT_OBJECT_TYPES.includes(objectType)`，不在就 **throw**。
- 两个漏斗（`src/tools/index.js` 的 `instrument`、`src/web/routes.js` 的 `pageWrite`）都把这个 throw 收成一条 `audit:error` 活动流条目；**业务写照常提交，审计行一行都没有**。这就是「每次写操作记录」看起来满足、实际为假的那种形状。

### 2.2 证据：它是真对象

| # | 事实 | 证据 |
|---|---|---|
| 1 | 表有独立主键与时间戳 | `src/store/schema.js` v64：`review_analysis_runs (id TEXT PRIMARY KEY, parent_asin, marketplace, asin, method, method_version, lexicon_hash, insufficient_run_n, insufficient_label_n, sample_n, matched_n, created_at TEXT NOT NULL)` |
| 2 | 子表以它为外键 | `review_annotations.run_id TEXT NOT NULL … FOREIGN KEY (run_id) REFERENCES review_analysis_runs(id)`，唯一键 `(run_id, review_key, category, label)` |
| 3 | 一次分析写 1 行 run + N 行标注 | `src/store/review-analysis.js:18-73`：`insertRun` + `insertAnnotations`（单事务、幂等） |
| 4 | run id 由这次调用铸造并返回 | `src/domain/asin/review-analysis-run.js:23-34`：`ra-<ISO>-<random>`；返回 `{ runId, sampleN, matchedN, coverage, … }` |
| 5 | 读回以 run 为单位 | `readLatestRun(store, {parentAsin, marketplace})` 按 `created_at DESC` 取最新一条；`readReviewAnalysis` 返回 `runId / methodVersion / lexiconHash / sampleN / matchedN / coverage`；没有 run → `hasRun:false`，不编空分布 |
| 6 | 审计要回答的正是 run 级问题 | 「谁在什么时候跑了这次分析、用哪一版词典法、样本多大、命中多少」——这些字段都在 run 行上，不在 `asin` 行上 |

### 2.3 反方意见（为什么不用既有类型）

- **用 `asin`**：错。写的是 `review_analysis_runs` + `review_annotations`，不是 `asin` 行；`objectId` 只能写 ASIN，无法回答「哪一次 run」，还会让审计行说「这个 ASIN 被改了」——而 ASIN 行其实没变。
- **用 `report`**：错。`report` 是报告库的行；这次分析不写 `report`。
- **不登记、继续让它 `audit:error`**：错。模块 12 已经踩过一模一样的坑（`states.js` 的注释原话：六个写路径全部静默地没被审计，而「每次写操作记录」看起来是满足的）。
- **用 `kw_pipeline_run` / `collection_task` 之类**：错。它们各自是别的表；跨表借类型会让 `object_type` 与表名不再「只差一个词」。

**结论**：加 `'review_analysis_run'`，并在注释里写明依据（已做）。`review_analysis_run` 是 `review_analysis_runs` 的单数，与 `agent_run` / `publication_record` / `kw_pipeline_run` 同一条命名规则。

## 三、盘点：POST 路由 / 工具 → 写分类

### 3.1 口径

- **工具侧**：`src/domain/audit/targets.js` 的 `WRITE_TARGETS`，键集合必须等于 `index.js` 的 `TOOLS`（142 个）。`null` = 看过并判定「不是数据库写」；非 null = 写描述符（`action` / `objectType` / `objectId` / `readBefore`）。
- **路由侧**：同文件的 `PAGE_WRITE_TARGETS`，键集合必须等于 `routes.js` 里 `route === '<name>' && req.method === 'POST'` 的字面量（86 条）。
- **三态**：`已正确登记` / `漏登记` / `登记了但类型不被接受`。判断「类型不被接受」的标准是 `objectType` 是否在 `AUDIT_OBJECT_TYPES` 里（这是 `recordAudit` 实际会拒的那条线）。
- **写哪张表**：按 `objectType`（单数表名）映射。对 `review_analysis_run`、`policy`、`optimization_run`、`agent_run` 这类「objectType 是主对象、实际还写子表」的，备注里写明子表。
- **只读但确实写库的 5 条路由**：`notification-read` / `notification-read-all` / `notification-clear`（写 `notification`）、`pin-toggle` / `recent-push`（写 `setting` 的 JSON 键）。它们被**设计性地**登记为 `null`（界面状态，不是业务写）；表里「写不写库」标 `是*`，三态仍是「已正确登记（只读）」。
- **`product-open-dir`**：描述符非 null（`setting` / `product_dir.open`），但 `skip: () => true` 表示它不写库；它被算进「写 73」只是因为它有描述符，实际不写。`pageWrite` 不读 `skip`，会记假审计——见 §四 的额外发现。

### 3.2 汇总（分母 / 来源 / 时间）

| 面 | 总数（分母） | 已正确登记·写 | 已正确登记·只读 | 漏登记 | 类型不被接受 |
|---|---:|---:|---:|---:|---:|
| 工具（`WRITE_TARGETS`） | 142 | 77 | 65 | **0** | **0** |
| POST 路由（`PAGE_WRITE_TARGETS`） | 86 | 73 | 13 | **0** | **0** |

来源：`index.js` 的 `TOOLS`、`src/web/routes.js` 的 POST 字面量、`src/domain/audit/targets.js` 的两张表、`src/domain/states.js` 的 `AUDIT_OBJECT_TYPES`；时间 2026-10-23T22:48+08:00；文件哈希见文首。**「0 漏登记」是扫描了 142/86 个对象后的 0，不是没扫。**

口径补充：表里的「写」是**非 null 描述符**的计数，不等于「每次调用都写库」——工具侧有 dryRun / persist / skip 条件（见 §4.2 E1–E5），路由侧 `product-open-dir` 的 skip 恒真（见 E6）。真正的「这次调用有没有写」由参数决定，审计行该不该落也由同一个条件决定；本表只回答「有没有登记、类型对不对」。

### 3.3 时间线（为什么任务书说 4 条、我这里说 0 条）

| 时间 | 事件 | 证据 |
|---|---|---|
| 22:37 第一次扫描 | `PAGE_WRITE_TARGETS` 83 键 / 86 路由；漏登记 **3** 条：`policy-check-start`、`policy-candidate-confirm`、`policy-candidate-reject`；`review-analysis-run` 已登记但 `objectType=review_analysis_run` 不在白名单 | 本次会话的扫描输出（工具计数 86/83，missing 3，offenders 1） |
| 22:39:19 | `src/domain/audit/targets.js` 被另一支笔修改：补入上述 3 条 policy 路由（`objectType: 'policy'`），并新增 `ACTIONS.policyCheckStart / policyCandidateConfirm / policyCandidateReject` 与 `getCandidate` 导入 | 文件 mtime `2026-10-23T22:39:19.7184700+08:00`；`git diff -- src/domain/audit/targets.js` 显示 +61 行 |
| 22:48 定稿扫描（dev-7 已加类型后） | `PAGE_WRITE_TARGETS` 86 键 / 86 路由；漏登记 **0**；类型不被接受 **0** | 本报告 §3.2；T73 的 ③④⑥⑨ 全绿 |

**这不是我把 3 条漏登记算成已登记**：是树在我两次扫描之间被别人改了。任务书里 `review-analysis-run` 被列进「新 POST 路由没登记」，但 22:37 时它已经在 `PAGE_WRITE_TARGETS` 里（`src/domain/audit/targets.js:1681-1686`）；它的问题是类型，不是漏登记。

### 3.4 完整盘点表

> 表注：`写不写库` 的「是」= 有写描述符且会走写路径；「否」= `null`（只读 / 内存 / 纯渲染）；「是*」= 确实写库但设计上不进业务审计。`白名单` 的 `✓` = objectType 在 `AUDIT_OBJECT_TYPES` 里，`—` = 只读无 objectType，`✗` = 不在。`三态` 只按任务书的三态判定；`product-open-dir` 的 skip 问题、以及 5 个工具的 dryRun/persist 缺 skip 问题，不改变三态，另列在 §四 的「额外发现」。

### 工具（142 个）

| 名称 | 类型 | 写不写库 | 写哪张表 | 分类表 | objectType | 白名单 | 三态 | 备注 |
|---|---|---|---|---|---|---|---|---|
| `amzn_agent_artifact_decide` | 工具 | 是 | agent_artifact | WRITE_TARGETS | agent_artifact | ✓ | 已正确登记 |  |
| `amzn_agent_artifact_save` | 工具 | 是 | agent_artifact | WRITE_TARGETS | agent_artifact | ✓ | 已正确登记 |  |
| `amzn_agent_data_request` | 工具 | 是 | agent_data_request | WRITE_TARGETS | agent_data_request | ✓ | 已正确登记 |  |
| `amzn_agent_data_request_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_agent_data_request_resolve` | 工具 | 是 | agent_data_request | WRITE_TARGETS | agent_data_request | ✓ | 已正确登记 |  |
| `amzn_agent_gate_decide` | 工具 | 是 | agent_gate | WRITE_TARGETS | agent_gate | ✓ | 已正确登记 |  |
| `amzn_agent_metrics` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_agent_role_config_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_agent_role_config_release` | 工具 | 是 | agent_role_config | WRITE_TARGETS | agent_role_config | ✓ | 已正确登记 |  |
| `amzn_agent_role_config_show` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_agent_run_finish` | 工具 | 是 | agent_run（step 另写 agent_step） | WRITE_TARGETS | agent_run | ✓ | 已正确登记 |  |
| `amzn_agent_run_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_agent_run_recover` | 工具 | 是 | agent_run（step 另写 agent_step） | WRITE_TARGETS | agent_run | ✓ | 已正确登记 |  |
| `amzn_agent_run_start` | 工具 | 是 | agent_run（step 另写 agent_step） | WRITE_TARGETS | agent_run | ✓ | 已正确登记 |  |
| `amzn_agent_run_step` | 工具 | 是 | agent_run（step 另写 agent_step） | WRITE_TARGETS | agent_run | ✓ | 已正确登记 |  |
| `amzn_asin_archive` | 工具 | 是 | asin | WRITE_TARGETS | asin | ✓ | 已正确登记 | preview 不写（skip 已登记） |
| `amzn_asin_competitor` | 工具 | 是 | asin_competitor | WRITE_TARGETS | asin_competitor | ✓ | 已正确登记 | list/reverse/discover 预览不写（skip 已登记） |
| `amzn_asin_delete` | 工具 | 是 | asin | WRITE_TARGETS | asin | ✓ | 已正确登记 | delete_preview 不写（skip 已登记） |
| `amzn_asin_detail` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_asin_export` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） | 返回文本，不落盘 |
| `amzn_asin_field_correct` | 工具 | 是 | asin | WRITE_TARGETS | asin | ✓ | 已正确登记 |  |
| `amzn_asin_get` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_asin_health` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_asin_history` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_asin_import` | 工具 | 是 | asin | WRITE_TARGETS | asin | ✓ | 已正确登记 | dryRun!==false 才写（skip 已登记） |
| `amzn_asin_query` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_asin_upsert` | 工具 | 是 | asin | WRITE_TARGETS | asin | ✓ | 已正确登记 |  |
| `amzn_asin_variant_correct` | 工具 | 是 | asin_variant | WRITE_TARGETS | asin_variant | ✓ | 已正确登记 |  |
| `amzn_asin_variant_upsert` | 工具 | 是 | asin_variant | WRITE_TARGETS | asin_variant | ✓ | 已正确登记 |  |
| `amzn_asin_view_delete` | 工具 | 是 | asin_saved_view | WRITE_TARGETS | asin_saved_view | ✓ | 已正确登记 |  |
| `amzn_asin_view_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_asin_view_save` | 工具 | 是 | asin_saved_view | WRITE_TARGETS | asin_saved_view | ✓ | 已正确登记 |  |
| `amzn_audit_query` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_collect_cancel` | 工具 | 是 | collection_task | WRITE_TARGETS | collection_task | ✓ | 已正确登记 |  |
| `amzn_collect_detail` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_collect_doctor` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_collect_env_check` | 工具 | 是 | collection_env_check | WRITE_TARGETS | collection_env_check | ✓ | 已正确登记 |  |
| `amzn_collect_plan_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_collect_plan_save` | 工具 | 是 | collection_plan | WRITE_TARGETS | collection_plan | ✓ | 已正确登记 |  |
| `amzn_collect_preview` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_collect_repair` | 工具 | 是 | collection_env_check | WRITE_TARGETS | collection_env_check | ✓ | 已正确登记 | launch_browser 未确认时不写（skip 已登记） |
| `amzn_collect_run` | 工具 | 是 | collection_task | WRITE_TARGETS | collection_task | ✓ | 已正确登记 |  |
| `amzn_collect_scheme_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_collect_scheme_save` | 工具 | 是 | collection_scheme | WRITE_TARGETS | collection_scheme | ✓ | 已正确登记 |  |
| `amzn_collect_scheme_transition` | 工具 | 是 | collection_scheme | WRITE_TARGETS | collection_scheme | ✓ | 已正确登记 |  |
| `amzn_collect_status` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_collect_submit` | 工具 | 是 | collection_task | WRITE_TARGETS | collection_task | ✓ | 已正确登记 |  |
| `amzn_collect_waiting_resolve` | 工具 | 是 | collection_task | WRITE_TARGETS | collection_task | ✓ | 已正确登记 |  |
| `amzn_competitor_analyze` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_competitor_quadrants` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_competitor_set_upsert` | 工具 | 是 | competitor_set | WRITE_TARGETS | competitor_set | ✓ | 已正确登记 |  |
| `amzn_conflict_resolve` | 工具 | 是 | field_conflict | WRITE_TARGETS | field_conflict | ✓ | 已正确登记 |  |
| `amzn_dashboard` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_dq_scan` | 工具 | 是 | dq_issue | WRITE_TARGETS | dq_issue | ✓ | 已正确登记 |  |
| `amzn_keyword_coverage` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_detail` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_discover` | 工具 | 是 | kw_master（导入另写事实表） | WRITE_TARGETS | kw_master | ✓ | 已正确登记 | dryRun=true 不写（skip 已登记） |
| `amzn_keyword_import` | 工具 | 是 | kw_master（导入另写事实表） | WRITE_TARGETS | kw_master | ✓ | 已正确登记 |  |
| `amzn_keyword_lifecycle_batch` | 工具 | 是 | keyword_lifecycle | WRITE_TARGETS | keyword_lifecycle | ✓ | 已正确登记 |  |
| `amzn_keyword_lifecycle_history` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_lifecycle_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_lifecycle_set` | 工具 | 是 | keyword_lifecycle | WRITE_TARGETS | keyword_lifecycle | ✓ | 已正确登记 |  |
| `amzn_keyword_ownership_batch` | 工具 | 是 | keyword_ownership | WRITE_TARGETS | keyword_ownership | ✓ | 已正确登记 |  |
| `amzn_keyword_ownership_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_ownership_preview` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_ownership_resolve` | 工具 | 是 | keyword_ownership | WRITE_TARGETS | keyword_ownership | ✓ | 已正确登记 |  |
| `amzn_keyword_ownership_suggest` | 工具 | 是 | keyword_ownership_suggestion | WRITE_TARGETS | keyword_ownership_suggestion | ✓ | 已正确登记 |  |
| `amzn_keyword_plan_coverage` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_plan_get` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_plan_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_plan_propose` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_plan_save` | 工具 | 是 | keyword_plan | WRITE_TARGETS | keyword_plan | ✓ | 已正确登记 |  |
| `amzn_keyword_query` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_research` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_keyword_scan` | 工具 | 是 | collection_task | WRITE_TARGETS | collection_task | ✓ | 已正确登记 |  |
| `amzn_kw_export` | 工具 | 是 | report | WRITE_TARGETS | report | ✓ | 已正确登记 |  |
| `amzn_kw_import` | 工具 | 是 | kw_import | WRITE_TARGETS | kw_import | ✓ | 已正确登记 | dryRun=true 不写；描述符无 skip（见额外发现） |
| `amzn_kw_merge` | 工具 | 是 | kw_master（导入另写事实表） | WRITE_TARGETS | kw_master | ✓ | 已正确登记 |  |
| `amzn_kw_pipeline_history` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_kw_pipeline_run` | 工具 | 是 | kw_pipeline_run | WRITE_TARGETS | kw_pipeline_run | ✓ | 已正确登记 | dryRun=true 不写（skip 已登记） |
| `amzn_kw_query` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_kw_rank_history` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_kw_report` | 工具 | 是 | report | WRITE_TARGETS | report | ✓ | 已正确登记 |  |
| `amzn_kw_scan_schedule` | 工具 | 是 | kw_scan_schedule | WRITE_TARGETS | kw_scan_schedule | ✓ | 已正确登记 | list 不写（skip 已登记） |
| `amzn_kw_source` | 工具 | 是 | kw_import | WRITE_TARGETS | kw_import | ✓ | 已正确登记 |  |
| `amzn_observation_check` | 工具 | 是 | publication_record | WRITE_TARGETS | publication_record | ✓ | 已正确登记 |  |
| `amzn_observation_conclude` | 工具 | 是 | observation_checkpoint | WRITE_TARGETS | observation_checkpoint | ✓ | 已正确登记 |  |
| `amzn_observation_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_observation_plan_save` | 工具 | 是 | observation_plan | WRITE_TARGETS | observation_plan | ✓ | 已正确登记 |  |
| `amzn_observation_scan_due` | 工具 | 是 | notification | WRITE_TARGETS | notification | ✓ | 已正确登记 |  |
| `amzn_optimize_evidence` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_optimize_inbox` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_optimize_job` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_optimize_plan_check` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_optimize_precheck` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_optimize_prepare` | 工具 | 是 | optimization_run（审阅另写 optimization_review） | WRITE_TARGETS | optimization_run | ✓ | 已正确登记 | dryRun=true 不建 run；描述符无 skip（见额外发现） |
| `amzn_optimize_report` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_optimize_review` | 工具 | 是 | optimization_run（审阅另写 optimization_review） | WRITE_TARGETS | optimization_run | ✓ | 已正确登记 | 无 conclusions 不写（skip 已登记） |
| `amzn_optimize_save` | 工具 | 是 | optimization_draft | WRITE_TARGETS | optimization_draft | ✓ | 已正确登记 |  |
| `amzn_optimize_strategy` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_optimize_validate` | 工具 | 是 | optimization_draft | WRITE_TARGETS | optimization_draft | ✓ | 已正确登记 | 仅 persist=true 时写；描述符无 skip（见额外发现） |
| `amzn_optimize_validation` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_policy_import` | 工具 | 是 | policy | WRITE_TARGETS | policy | ✓ | 已正确登记 |  |
| `amzn_policy_link` | 工具 | 是 | policy | WRITE_TARGETS | policy | ✓ | 已正确登记 |  |
| `amzn_policy_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_product_import` | 工具 | 是 | product_profile | WRITE_TARGETS | product_profile | ✓ | 已正确登记 | 仅 commit 写（skip 已登记） |
| `amzn_product_line_classify` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_product_line_upsert` | 工具 | 是 | product_line | WRITE_TARGETS | product_line | ✓ | 已正确登记 | dryRun=true 不写；描述符无 skip（见额外发现） |
| `amzn_prompt_eval_import` | 工具 | 是 | prompt_eval_set | WRITE_TARGETS | prompt_eval_set | ✓ | 已正确登记 |  |
| `amzn_prompt_eval_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_prompt_eval_show` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_prompt_history` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_prompt_lifecycle_get` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_prompt_lifecycle_transition` | 工具 | 是 | prompt | WRITE_TARGETS | prompt | ✓ | 已正确登记 |  |
| `amzn_prompt_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_prompt_preview` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_prompt_references` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_prompt_rollback` | 工具 | 是 | prompt | WRITE_TARGETS | prompt | ✓ | 已正确登记 |  |
| `amzn_prompt_upsert` | 工具 | 是 | prompt | WRITE_TARGETS | prompt | ✓ | 已正确登记 |  |
| `amzn_prompt_version_activate` | 工具 | 是 | prompt | WRITE_TARGETS | prompt | ✓ | 已正确登记 |  |
| `amzn_prompt_version_rollback` | 工具 | 是 | prompt | WRITE_TARGETS | prompt | ✓ | 已正确登记 |  |
| `amzn_publication_baseline_decide` | 工具 | 是 | publication_record | WRITE_TARGETS | publication_record | ✓ | 已正确登记 |  |
| `amzn_publication_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_publication_record` | 工具 | 是 | publication_record | WRITE_TARGETS | publication_record | ✓ | 已正确登记 |  |
| `amzn_report_build` | 工具 | 是 | report | WRITE_TARGETS | report | ✓ | 已正确登记 | dryRun=true 不写（skip 已登记） |
| `amzn_report_diff` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_report_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_report_update` | 工具 | 是 | report | WRITE_TARGETS | report | ✓ | 已正确登记 |  |
| `amzn_rollback_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_rollback_suggest` | 工具 | 是 | rollback_task | WRITE_TARGETS | rollback_task | ✓ | 已正确登记 |  |
| `amzn_rule_activate` | 工具 | 是 | rule_set | WRITE_TARGETS | rule_set | ✓ | 已正确登记 |  |
| `amzn_rule_diff` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_rule_import` | 工具 | 是 | rule | WRITE_TARGETS | rule | ✓ | 已正确登记 | dryRun 默认 true；描述符无 skip（见额外发现） |
| `amzn_rule_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_rule_upsert` | 工具 | 是 | rule | WRITE_TARGETS | rule | ✓ | 已正确登记 |  |
| `amzn_setting_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_setting_set` | 工具 | 是 | setting | WRITE_TARGETS | setting | ✓ | 已正确登记 |  |
| `amzn_source_list` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） |  |
| `amzn_source_upsert` | 工具 | 是 | source | WRITE_TARGETS | source | ✓ | 已正确登记 |  |
| `amzn_workbench_context` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） | 内存 UI 状态 |
| `amzn_workbench_focus` | 工具 | 否 | — | WRITE_TARGETS | — | — | 已正确登记（只读） | 内存 UI 状态 |
| `amzn_workspace_upsert` | 工具 | 是 | workspace | WRITE_TARGETS | workspace | ✓ | 已正确登记 |  |

### POST 路由（86 条）

| 名称 | 类型 | 写不写库 | 写哪张表 | 分类表 | objectType | 白名单 | 三态 | 备注 |
|---|---|---|---|---|---|---|---|---|
| `agent-artifact` | POST 路由 | 是 | agent_artifact | PAGE_WRITE_TARGETS | agent_artifact | ✓ | 已正确登记 |  |
| `agent-gate` | POST 路由 | 是 | agent_gate | PAGE_WRITE_TARGETS | agent_gate | ✓ | 已正确登记 |  |
| `agent-run` | POST 路由 | 是 | agent_run（step 另写 agent_step） | PAGE_WRITE_TARGETS | agent_run | ✓ | 已正确登记 |  |
| `agent-run-supersede` | POST 路由 | 是 | agent_run（step 另写 agent_step） | PAGE_WRITE_TARGETS | agent_run | ✓ | 已正确登记 |  |
| `asin-archive` | POST 路由 | 是 | asin | PAGE_WRITE_TARGETS | asin | ✓ | 已正确登记 |  |
| `asin-delete` | POST 路由 | 是 | asin | PAGE_WRITE_TARGETS | asin | ✓ | 已正确登记 |  |
| `asin-field-correct` | POST 路由 | 是 | asin | PAGE_WRITE_TARGETS | asin | ✓ | 已正确登记 |  |
| `asin-import` | POST 路由 | 是 | asin | PAGE_WRITE_TARGETS | asin | ✓ | 已正确登记 |  |
| `asin-import-preview` | POST 路由 | 否 | — | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 只出计划，不落库 |
| `asin-variant` | POST 路由 | 是 | asin_variant | PAGE_WRITE_TARGETS | asin_variant | ✓ | 已正确登记 |  |
| `asin-variant-correct` | POST 路由 | 是 | asin_variant | PAGE_WRITE_TARGETS | asin_variant | ✓ | 已正确登记 |  |
| `asin-view-delete` | POST 路由 | 是 | asin_saved_view | PAGE_WRITE_TARGETS | asin_saved_view | ✓ | 已正确登记 |  |
| `asin-view-save` | POST 路由 | 是 | asin_saved_view | PAGE_WRITE_TARGETS | asin_saved_view | ✓ | 已正确登记 |  |
| `baseline-choice` | POST 路由 | 是 | publication_record | PAGE_WRITE_TARGETS | publication_record | ✓ | 已正确登记 |  |
| `brand-save` | POST 路由 | 是 | brand | PAGE_WRITE_TARGETS | brand | ✓ | 已正确登记 |  |
| `collect-cancel` | POST 路由 | 是 | collection_task | PAGE_WRITE_TARGETS | collection_task | ✓ | 已正确登记 |  |
| `collect-env-check` | POST 路由 | 是 | collection_env_check | PAGE_WRITE_TARGETS | collection_env_check | ✓ | 已正确登记 |  |
| `collect-plan` | POST 路由 | 是 | collection_plan | PAGE_WRITE_TARGETS | collection_plan | ✓ | 已正确登记 |  |
| `collect-preview` | POST 路由 | 否 | — | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 只算影响，不落库 |
| `collect-run` | POST 路由 | 是 | collection_task | PAGE_WRITE_TARGETS | collection_task | ✓ | 已正确登记 |  |
| `collect-scheme` | POST 路由 | 是 | collection_scheme | PAGE_WRITE_TARGETS | collection_scheme | ✓ | 已正确登记 |  |
| `collect-waiting` | POST 路由 | 是 | collection_task | PAGE_WRITE_TARGETS | collection_task | ✓ | 已正确登记 |  |
| `competitor-batch-add` | POST 路由 | 是 | asin_competitor | PAGE_WRITE_TARGETS | asin_competitor | ✓ | 已正确登记 |  |
| `competitor-discover` | POST 路由 | 是 | asin_competitor | PAGE_WRITE_TARGETS | asin_competitor | ✓ | 已正确登记 |  |
| `competitor-retire` | POST 路由 | 是 | asin_competitor | PAGE_WRITE_TARGETS | asin_competitor | ✓ | 已正确登记 |  |
| `competitor-set` | POST 路由 | 是 | competitor_set | PAGE_WRITE_TARGETS | competitor_set | ✓ | 已正确登记 |  |
| `conflict-resolve` | POST 路由 | 是 | field_conflict | PAGE_WRITE_TARGETS | field_conflict | ✓ | 已正确登记 |  |
| `context` | POST 路由 | 否 | — | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 内存 UI 状态 |
| `dq-issue` | POST 路由 | 是 | dq_issue | PAGE_WRITE_TARGETS | dq_issue | ✓ | 已正确登记 |  |
| `keyword-lifecycle` | POST 路由 | 是 | keyword_lifecycle | PAGE_WRITE_TARGETS | keyword_lifecycle | ✓ | 已正确登记 |  |
| `keyword-ownership` | POST 路由 | 是 | keyword_ownership | PAGE_WRITE_TARGETS | keyword_ownership | ✓ | 已正确登记 |  |
| `keyword-ownership-preview` | POST 路由 | 否 | — | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | dryRun，不落库 |
| `keyword-ownership-resolve` | POST 路由 | 是 | keyword_ownership | PAGE_WRITE_TARGETS | keyword_ownership | ✓ | 已正确登记 |  |
| `keyword-plan` | POST 路由 | 是 | keyword_plan | PAGE_WRITE_TARGETS | keyword_plan | ✓ | 已正确登记 |  |
| `kw-source` | POST 路由 | 是 | kw_import | PAGE_WRITE_TARGETS | kw_import | ✓ | 已正确登记 |  |
| `kw-source-dir-import` | POST 路由 | 是 | kw_import | PAGE_WRITE_TARGETS | kw_import | ✓ | 已正确登记 |  |
| `kw-source-dir-mkdir` | POST 路由 | 否 | — | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 只建磁盘目录 |
| `kw-source-dir-open` | POST 路由 | 否 | — | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 只开资源管理器 |
| `kw-source-dir-pick` | POST 路由 | 是 | setting | PAGE_WRITE_TARGETS | setting | ✓ | 已正确登记 |  |
| `kw-source-dir-set` | POST 路由 | 是 | setting | PAGE_WRITE_TARGETS | setting | ✓ | 已正确登记 |  |
| `notification-clear` | POST 路由 | 是* | notification | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 写 notification（清理），设计上不进业务审计 |
| `notification-read` | POST 路由 | 是* | notification | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 写 notification（已读标志），设计上不进业务审计 |
| `notification-read-all` | POST 路由 | 是* | notification | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 写 notification（全部已读），设计上不进业务审计 |
| `observation-conclude` | POST 路由 | 是 | observation_checkpoint | PAGE_WRITE_TARGETS | observation_checkpoint | ✓ | 已正确登记 |  |
| `optimize-draft-defer` | POST 路由 | 是 | optimization_draft | PAGE_WRITE_TARGETS | optimization_draft | ✓ | 已正确登记 |  |
| `optimize-draft-reoptimize` | POST 路由 | 是 | optimization_run（审阅另写 optimization_review） | PAGE_WRITE_TARGETS | optimization_run | ✓ | 已正确登记 |  |
| `optimize-draft-restore` | POST 路由 | 是 | optimization_draft | PAGE_WRITE_TARGETS | optimization_draft | ✓ | 已正确登记 |  |
| `optimize-draft-resume` | POST 路由 | 是 | optimization_draft | PAGE_WRITE_TARGETS | optimization_draft | ✓ | 已正确登记 |  |
| `optimize-draft-void` | POST 路由 | 是 | optimization_draft | PAGE_WRITE_TARGETS | optimization_draft | ✓ | 已正确登记 |  |
| `optimize-plan-decide` | POST 路由 | 是 | optimization_run（审阅另写 optimization_review） | PAGE_WRITE_TARGETS | optimization_run | ✓ | 已正确登记 |  |
| `optimize-review-record` | POST 路由 | 是 | optimization_run（审阅另写 optimization_review） | PAGE_WRITE_TARGETS | optimization_run | ✓ | 已正确登记 |  |
| `optimize-strategy-confirm` | POST 路由 | 是 | optimization_run（审阅另写 optimization_review） | PAGE_WRITE_TARGETS | optimization_run | ✓ | 已正确登记 |  |
| `ownership` | POST 路由 | 是 | asin_ownership | PAGE_WRITE_TARGETS | asin_ownership | ✓ | 已正确登记 |  |
| `pin-toggle` | POST 路由 | 是* | setting | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 写 setting 的 JSON 键，设计上不进业务审计 |
| `policy-candidate-confirm` | POST 路由 | 是 | policy + policy_candidates + policy_check_runs | PAGE_WRITE_TARGETS | policy | ✓ | 已正确登记 | objectType=policy；confirm 确实写 policy 行（见 §3.6） |
| `policy-candidate-reject` | POST 路由 | 是 | policy_candidates + policy_check_runs | PAGE_WRITE_TARGETS | policy | ✓ | 已正确登记 | objectType 写 policy，但不写 policy 行（见 §3.6 / T73-AUDIT-3） |
| `policy-check-start` | POST 路由 | 是 | policy_check_runs + policy_candidates | PAGE_WRITE_TARGETS | policy | ✓ | 已正确登记 | objectType 写 policy，但不写 policy 行（见 §3.6 / T73-AUDIT-3） |
| `policy-link` | POST 路由 | 是 | policy | PAGE_WRITE_TARGETS | policy | ✓ | 已正确登记 |  |
| `product-import` | POST 路由 | 是 | product_profile | PAGE_WRITE_TARGETS | product_profile | ✓ | 已正确登记 |  |
| `product-line-preview` | POST 路由 | 否 | — | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 只算影响，不落库 |
| `product-line-save` | POST 路由 | 是 | product_line | PAGE_WRITE_TARGETS | product_line | ✓ | 已正确登记 |  |
| `product-open-dir` | POST 路由 | 否* | —（只开资源管理器） | PAGE_WRITE_TARGETS | setting | ✓ | 已正确登记（skip 恒真） | 不写库；描述符 skip 恒真，但 pageWrite 不读 skip → 会记一条假审计（见额外发现） |
| `prompt-lifecycle` | POST 路由 | 是 | prompt | PAGE_WRITE_TARGETS | prompt | ✓ | 已正确登记 |  |
| `prompt-preview` | POST 路由 | 否 | — | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 只渲染，不落库 |
| `prompt-rollback` | POST 路由 | 是 | prompt | PAGE_WRITE_TARGETS | prompt | ✓ | 已正确登记 |  |
| `prompt-save` | POST 路由 | 是 | prompt | PAGE_WRITE_TARGETS | prompt | ✓ | 已正确登记 |  |
| `prompt-version-activate` | POST 路由 | 是 | prompt | PAGE_WRITE_TARGETS | prompt | ✓ | 已正确登记 |  |
| `prompt-version-rollback` | POST 路由 | 是 | prompt | PAGE_WRITE_TARGETS | prompt | ✓ | 已正确登记 |  |
| `publication-record` | POST 路由 | 是 | publication_record | PAGE_WRITE_TARGETS | publication_record | ✓ | 已正确登记 |  |
| `recent-push` | POST 路由 | 是* | setting | PAGE_WRITE_TARGETS | — | — | 已正确登记（只读） | 写 setting 的 JSON 键，设计上不进业务审计 |
| `report-build` | POST 路由 | 是 | report | PAGE_WRITE_TARGETS | report | ✓ | 已正确登记 |  |
| `report-update` | POST 路由 | 是 | report | PAGE_WRITE_TARGETS | report | ✓ | 已正确登记 |  |
| `review-analysis-run` | POST 路由 | 是 | review_analysis_runs + review_annotations | PAGE_WRITE_TARGETS | review_analysis_run | ✓ | 已正确登记 | 写 run 行 + 标注行；objectId=asin |
| `rollback-suggest` | POST 路由 | 是 | rollback_task | PAGE_WRITE_TARGETS | rollback_task | ✓ | 已正确登记 |  |
| `rule-toggle` | POST 路由 | 是 | rule | PAGE_WRITE_TARGETS | rule | ✓ | 已正确登记 |  |
| `setting-set` | POST 路由 | 是 | setting | PAGE_WRITE_TARGETS | setting | ✓ | 已正确登记 |  |
| `shop-archive` | POST 路由 | 是 | shop | PAGE_WRITE_TARGETS | shop | ✓ | 已正确登记 |  |
| `shop-restore` | POST 路由 | 是 | shop | PAGE_WRITE_TARGETS | shop | ✓ | 已正确登记 |  |
| `shop-save` | POST 路由 | 是 | shop | PAGE_WRITE_TARGETS | shop | ✓ | 已正确登记 |  |
| `site-save` | POST 路由 | 是 | site_profile | PAGE_WRITE_TARGETS | site_profile | ✓ | 已正确登记 |  |
| `site-verify` | POST 路由 | 是 | site_verification | PAGE_WRITE_TARGETS | site_verification | ✓ | 已正确登记 |  |
| `snapshot-archive` | POST 路由 | 是 | snapshot | PAGE_WRITE_TARGETS | snapshot | ✓ | 已正确登记 |  |
| `snapshot-delete` | POST 路由 | 是 | snapshot | PAGE_WRITE_TARGETS | snapshot | ✓ | 已正确登记 |  |
| `snapshot-restore` | POST 路由 | 是 | snapshot | PAGE_WRITE_TARGETS | snapshot | ✓ | 已正确登记 |  |
| `source-save` | POST 路由 | 是 | source | PAGE_WRITE_TARGETS | source | ✓ | 已正确登记 |  |
| `workspace-save` | POST 路由 | 是 | workspace | PAGE_WRITE_TARGETS | workspace | ✓ | 已正确登记 |  |


### 3.5 漏登记 / 类型不被接受逐条点名（定稿快照）

- **漏登记：无**。142 个工具、86 条 POST 路由全部有分类条目；`extra` 也为 0（没有「表里有、代码里没有」的死描述符）。
- **类型不被接受：1 条（修复前）**——`review-analysis-run → review_analysis_run`。修复后 0 条。
- **历史漏登记（22:37，已被另一支笔在 22:39 补上）**：`policy-check-start`、`policy-candidate-confirm`、`policy-candidate-reject`。定稿快照不再点名它们为漏登记；但它们的 `objectType` 语义问题见 §3.6 与 §四 T73-AUDIT-3。

### 3.6 对 dev-3 写分类做法的核对（lead 要求）

#### (1) 三条 policy 路由用 `objectType: 'policy'`：可接受，但 objectId 要写清

**事实（代码级）**：

| 路由 | 实际写哪张表 | 是否写 `policy` 行 |
|---|---|---|
| `policy-check-start` | `policy_check_runs`（create + finish）、`policy_candidates`（insert） | **否** |
| `policy-candidate-confirm` | `policy`（`importPolicy`）、`policy_candidates`（UPDATE）、`policy_check_runs`（recompute）、可选 `policy_rule` 链接 | **是** |
| `policy-candidate-reject` | `policy_candidates`（UPDATE）、`policy_check_runs`（recompute） | **否** |

**我的复核结论：`policy-candidate-confirm` 用 `policy` 是对的；`policy-check-start` / `policy-candidate-reject` 用 `policy` 是「业务对象口径」下的可接受折中，不是「表名口径」下的正确。** 我接受 lead 的折中——用 `policy`，不造 `policy_candidate`——理由：
1. 候选（`policy_candidates`）是**证据/中间态**，不是独立业务对象；它的终点是「政策入库」或「政策驳回」，业务问题始终是「这条政策怎么被处理的」。
2. 造 `policy_candidate` 会把中间态升成审计对象类型，导致 `AUDIT_OBJECT_TYPES` 里出现一个只活在政策链里的类型，别的模块无法复用；这与「单数表名、业务对象」的词汇规则冲突。
3. 本批的授权边界是「只加 `review_analysis_run`」；`policy` 是既有类型，不扩白名单，符合边界。

**但必须承认**：`policy-check-start` / `policy-candidate-reject` 不写 `policy` 行，严格按 `AUDIT_OBJECT_TYPES` 的「单数表名」注释，`policy` 并不描述它们写的表。**这不是红项，但 objectId 必须写清**（见下）；如果未来要求 object_type 与表名一一对应，才需要加 `policy_check_run` / `policy_candidate`——本批不做。

**按审计回溯的实际需要，具体三点（前两点必须修，第三点是未来口径；都不是红项）**：
- `policy-candidate-confirm` 的 `objectId` 现在是 `candidateId`，不是落地的 `policyId`。审计行 `object_type='policy'` + `object_id=<candidateId>` 在 `policy` 表里**查不到**；建议改成 `objectId: (_b, r) => r?.policyId ?? b?.candidateId ?? null`（`r.policyId` 是 confirm 返回的）。这是「审计行指向的对象要能被同一个 object_type 的表查到」的最低要求。
- `policy-check-start` 的 `objectId` 是 `runId`、`policy-candidate-reject` 的是 `candidateId`，都不是 `policy.id`。如果保留 `policy` 类型，必须在 descriptor 注释里写明「objectId 的表归属是 run/candidate，不是 policy」，否则按 `(object_type, object_id)` 查 `policy` 会查空。
- 如果 lead 要求严格「object_type 与表名一一对应」，那就应该加 `policy_check_run` / `policy_candidate` 两个类型；但本批不做，且这会与「候选只是中间态」的判断冲突。**我的结论：按 lead 的口径 `policy` 可接受，不改类型；只修 objectId/注释。**

#### (2) `review_analysis_run` 字面一致性：逐字相同，且没有第二套白名单

- **字面**：dev-3 的 `PAGE_WRITE_TARGETS['review-analysis-run'].objectType` 是 `'review_analysis_run'`（下划线）；我在 `states.js` 加的是 `'review_analysis_run'`，**逐字相同**（`git diff` 行：`+  'review_analysis_run',`）。
- **断言钉死**：T73 ⑩ 用三条 `equal` 钉死：`target.objectType === 'review_analysis_run'`、`target.objectType.includes('-') === false`、`AUDIT_OBJECT_TYPES.includes(target.objectType) === true`。⑥ 另外对全部 86 条 POST 路由做同样的白名单检查。
- **dev-3 说「跑全量时这条已经绿了」——查证结果**：
  - 全仓 `AUDIT_OBJECT_TYPES` 的引用只有：`src/domain/states.js:294`（唯一定义）、`src/store/audit.js:41`（直接 import）、`src/web/routes.js:228`（直接 import）。**没有第二个白名单、别名或 monkey-patch。**
  - `git diff -- src/domain/states.js` 只有我这一处 **+7 行**；`git show HEAD:amazon-ops/src/domain/states.js` 没有 `review_analysis_run`。
  - 我的编辑 mtime 是 **2026-10-23T22:45:09**。
  - 因此：若 dev-3 的全量跑在 **22:45:09 之前**，这条**不可能绿**（`recordAudit` 会抛，s1b12 的 objectType 断言会红）；若在 **之后**，绿是因为我的改动已经在工作树里，不是另一套机制。**结论：不是断言被别的东西满足，是时间窗重叠。** 如果 dev-3 能给出他跑全量的时间戳，可以进一步对齐；我这边没有找到任何「别的东西」能满足它。
  - lead 的 `2418 passed / 2 failed` 全量快照里，2 条失败是我的两处悬空 `await`（已修），不是这条类型断言；这条在快照里已经是绿的，原因同上——我的 `states.js` 改动已在工作树里。

## 四、给 dev-3 的工单

### 4.1 工单（红项 + 复核项）

| 工单 | 对象 | 事实 | 处置 |
|---|---|---|---|
| **T73-AUDIT-1** | `review-analysis-run → review_analysis_run` | `recordAudit` 拒收该类型；`pageWrite` 把它吞成 `audit:error`，页面照常显示分析结果、审计一行没有 | **已由 dev-7 闭环**：`src/domain/states.js` 加 `'review_analysis_run'`。dev-3 **不需要**改 `routes.js`。 |
| **T73-AUDIT-2** | `review-analysis-run` 的 `objectId` | 描述符写 `objectId: b => String(b?.asin …)`（`targets.js:1684`），但对象是 **run**，route 的 `done(result)` 里带 `result.runId` | **建议 dev-3 复核**（`targets.js` 是写分类表，不是 `routes.js`）：改成 `objectId: (_b, r) => r?.runId ?? null`；否则同一 ASIN 的多次分析共用一个 `object_id`，「哪一次」只能从 `after` 里猜。非红项。 |
| **T73-AUDIT-3** | 三条 policy 路由的 `objectType: 'policy'` 与 `objectId` | 三条都登记成 `policy`；`policy-candidate-confirm` 确实写 `policy` 行，`policy-check-start` / `policy-candidate-reject` 不写 `policy` 行（只写 run/candidate） | **复核结论：接受 lead 的口径，用 `policy`，不造 `policy_candidate`**（理由见 §3.6）。**只修两点**：① `policy-candidate-confirm` 的 `objectId` 改成 `r?.policyId ?? b?.candidateId`，否则 `(object_type='policy', object_id=<candidateId>)` 在 `policy` 表查不到；② `policy-check-start` / `policy-candidate-reject` 的 descriptor 注释写明 objectId 的表归属（run/candidate）。非红项。 |

### 4.2 额外发现：写分类已登记，但 `skip` 与真实写入不一致（「未执行不写成通过」）

这些不在任务书的三态表里（它们的类型都在白名单里），但会让审计里出现**关于没有发生的写的记录**。按六条铁律第 4 条（未执行不写成通过）单列。

| # | 对象 | 事实 | 影响 |
|---|---|---|---|
| E1 | `amzn_optimize_validate` | `persist !== true` 时只读（`src/tools/optimize.js:1264` 起），描述符 `targets.js:930-938` **没有 `skip`** | 每次「试着校验一下」都会留一条 `optimization_draft.validate` 假审计 |
| E2 | `amzn_optimize_prepare` | `dryRun: true` 不建 run（`src/tools/optimize.js:820`），描述符 `targets.js:920-929` **没有 `skip`** | dryRun 会留一条 `optimization_run.create` 假审计 |
| E3 | `amzn_kw_import` | `dryRun: true` 只解析不写（`src/tools/kw.js:84`），描述符 `targets.js:973-979` **没有 `skip`** | 预览会留一条 `kw_import.create` 假审计 |
| E4 | `amzn_product_line_upsert` | `dryRun: true` 只算影响不写（`src/tools/product-line.js:120-175`），描述符 `targets.js:810-816` **没有 `skip`** | 预览会留一条 `product_line.update` 假审计 |
| E5 | `amzn_rule_import` | `dryRun` **默认 true**（`src/tools/rule.js:338`），描述符 `targets.js:1031-1037` **没有 `skip`** | 默认调用（预览）就会留一条 `rule.import` 假审计 |
| E6 | `product-open-dir`（路由） | 描述符 `targets.js:1852-1858` 有 `skip: () => true`，但 `pageWrite`（`routes.js:470-500`）**从不读 `target.skip`**；工具漏斗是读的（`src/tools/index.js:553`） | 每次打开目录都会记一条 `product_dir.open` 假审计；两个漏斗在这里不一致 |

**建议修法**（按优先级）：
1. `pageWrite` 加 `if (typeof target.skip === 'function' && target.skip(body) === true) return () => {}`，与工具漏斗对齐（`routes.js`，dev-3 的笔）。
2. 给 E1–E5 的描述符补 `skip`：`a => a?.persist !== true`、`a => a?.dryRun === true`、`a => a?.dryRun === true`、`a => a?.dryRun === true`、`a => a?.dryRun !== false`。
3. `product-open-dir` 若不想改 `pageWrite`，可把它改成 `null` 并去掉 `done({ok:true})` 调用（但 `skip` 字段已经存在，改漏斗更一致）。

## 五、验证与风险

### 5.1 T73 结果（先红后绿）

- **悬空 `await` 修正（lead 全量快照抓到的 2 条）**：首版 `tests/t73-audit-inventory.mjs` 的两处 `checkAsync`（①、②）没有 `await`。lead 的全量快照 `2418 passed / 2 failed` 两处都指向它们。已加 `await`；`grep -n "checkAsync(" tests/t73-audit-inventory.mjs` 逐行输出如下，两行都以 `await checkAsync(` 开头：

  ```text
  179:await checkAsync('① every AUDIT_OBJECT_TYPES entry is accepted by audit_log (one probe row per type)', async () => {
  207:await checkAsync('② review_analysis_run is accepted, and names a real table with an independent id', async () => {
  ```

- **重跑条数（按 lead 的口径如实写）**：原报 **9 条**，修正 `await` 后重跑仍是 **9 条**（`9 checks, 0 failed`），18 个 `equal`/`deepEqual` 断言不变——**原报 9 条含 2 条悬空调用，修正后 9 条全部生效**。说明：standalone harness 的 `state.checks` 在调用时自增，所以数字没有变成 N+2；但按 `tests/run.mjs` 的 `checkAsync` 语义，只有 `await` 之后才算结算，现在两处才真正结算。**另按 lead 要求新增 ⑩（字面一致性断言）后，总数为 10 条检查 / 21 个相等断言**（新增 3 个 `equal`）。
- **修复前**（首版，两处 `checkAsync` 未 `await`；`AUDIT_OBJECT_TYPES` 还是 53 条）：`node tests/t73-audit-inventory.mjs` → **9 checks, 3 failed**。红的是：
  - ② `review_analysis_run is accepted…` → `audit_log.objectType "review_analysis_run" is not one of AUDIT_OBJECT_TYPES`
  - ⑥ `every POST route declared objectType is in AUDIT_OBJECT_TYPES` → `review-analysis-run → review_analysis_run`
  - ⑨ `AUDIT_OBJECT_TYPES only grows…` → `review_analysis_run is not in the whitelist: expected true, got false`
- **修复后**：`node tests/t73-audit-inventory.mjs` → **10 checks, 0 failed**，exit 0。
- **断言数**：10 条检查；`equal` 7 处 + `deepEqual` 14 处 = **21 个相等断言**；另有 10 个非空/前置守卫（空白名单、少于 100 个工具、少于 50 条路由、无 objectType 声明等），防止「空集合恒绿」。
- **③/④ 的说明**：定稿快照上 ③④ 是绿的，因为 22:39 另一支笔已补 3 条 policy 路由。为了证明 ③ 不是恒真，⑤ 用合成数据断言：漏登记的工具/路由、多余的描述符都会被点名；同时 22:37 的原始扫描确实报过 3 条漏登记（见 §3.3）。
- **⑥ 的覆盖**：除了 86 条 POST 路由，⑦ 还把 142 个工具的 `objectType` 全查了一遍（77 个写描述符，全部在 54 条白名单内）。
- **⑨ 的基线**：运行时优先读 `git show HEAD:amazon-ops/src/domain/states.js`；无 git 时用文件内的冻结常量（HEAD `c11909b` 的 53 条）。断言「HEAD 的每条都还在今天这版里」+ 数量不减少；不是「相等」，所以合法新增不会红。

### 5.2 未执行 / 未覆盖（不写成通过）

- **没有跑全量 `tests/run.mjs`**（任务书要求只跑定向测试），所以 `s1b12-audit.mjs` 的完整 ⑧⑨（无 DELETE、唯一 INSERT）等断言本轮**未执行**，不能报「全绿」。
- **没有跑真实页面 POST**：T73 用 `recordAudit` 直接种行，证明 `audit_log` 接受类型；页面路由的 `pageWrite` 行为是静态读代码 + 描述符比对，不是端到端点击。`review-analysis-run` 的实际页面链路需要 lead 在接线后跑一次（会写 `review_analysis_runs` + `review_annotations`）。
- **`policy` 的语义**（T73-AUDIT-3）已按 lead 的口径复核：**接受 `policy`，不新增 `policy_check_run` / `policy_candidate`**；机器只保证「类型在名单里」，`objectId` 的可查性另列 T73-AUDIT-3，未在本轮改成行为断言。
- **E1–E6 的假审计**未在 T73 里做行为断言（需要构造 dryRun/persist 的 store 夹具）；本轮只做静态读代码与描述符比对，已在 §4.2 单列，未写成「已修复」。

### 5.3 风险

- **树在动**：`targets.js` / `routes.js` 都有大量未提交改动，本报告的数字只对文首哈希的快照成立。若 lead 在我之后又改了这两张表，请以 T73 的实时结果为准（它每次运行都会重新解析 `index.js` / `routes.js`）。
- **`review_analysis_run` 的 `objectId`**：当前描述符用 `asin`，不是 `runId`；类型修好后审计行能落，但「哪一次 run」的可查性弱。建议 dev-3 按 T73-AUDIT-2 改。
- **`pageWrite` 的 skip**：E6 是一个独立的漏斗 bug，不修的话 `product-open-dir` 会持续产生假审计；它不影响本批审计三条红项的验收，但会影响「审计里没有关于没发生的写的记录」这条口径。

### 5.4 给 lead 的接线（`tests/run.mjs` 由 lead 统一改）

```js
import { runT73AuditInventoryTests } from './t73-audit-inventory.mjs'
// …
await runT73AuditInventoryTests({ check, checkAsync, equal, deepEqual, throws, section })
```

T73 也可以独立跑：`node tests/t73-audit-inventory.mjs`（已在本轮执行，exit 0）。
