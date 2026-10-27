# amazon-ops 完成度矩阵（自动生成）

> **本文件的数字由 `node scripts/report-completion.mjs` 生成，不要手改。**
> 手改会在下次生成时被覆盖；代码变了而本文件没重跑，
> `node scripts/report-completion.mjs --check` 会红 —— 这条校验已接进仓库根的
> `node scripts/check.mjs`（degraded 档），所以「文档过期」是机器能发现的失败。
>
> **本文件不含生成时间。** 时间戳会让 `--check` 永远红；「新不新」由 `--check`
> 回答，不由一行日期回答。

这份文件回答一个问题：**这个插件现在做到哪一步，还差什么。**
上一版是一份早期调研清单，里面的版本、工具数、页签数都停在当时的规模，
与现在差了一个数量级。那种文档比没有文档更坏 —— 它让人照着过期的数字
判断「还剩多少没做」。所以这里每个数字都从代码里读；读不到就写「读不到」，
不拿一个假的零去填。

## 1. 当前实测基线

| 维度 | 数值 | 从哪读 |
|---|---|---|
| 迁移版本 `SCHEMA_VERSION` | **59** | `src/store/schema.js` |
| 迁移条数 `MIGRATIONS.length` | **59** | `src/store/schema.js` |
| 版本自洽（条数 = 版本号、无重号） | ✅ 成立 | 不变量 |
| 表 | **82** | 跑完迁移的空库，数 `sqlite_master` |
| 索引 | **118** | 同上 |
| 迁移里的 `CREATE TABLE` 语句 | **82** | `src/store/schema.js`（已剥注释） |
| 迁移里的 `CREATE INDEX` 语句（含 UNIQUE） | **118** | 同上 |
| 两种数法是否一致（语句 = 实际表） | ✅ 一致 | 不变量 |
| 页签分组 | **6** | `src/state/workbench.js` 的 `MODULE_GROUPS` |
| 叶子页签 | **15** | 同上（各组 `modules` 之和） |
| 工具总数 | **142** | `src/tools/*.js` 的 `name: 'amzn_*'` |
| 工具模块文件 | **31** / 32 | 同上（`index.js` 是注册表，不计） |
| 测试套件 | **117** | `tests/run.mjs` 的 import |

## 2. 页签树（含页面完成度）

“渲染器”一列读的是 `src/web/page.js` 的 `PANEL_RENDERERS`：有，说明这个页签点开
是一块真页面；没有，说明它只是一行占位说明。

### 工作空间与基础（`foundation`）

| 页签 | id | 渲染器 | 页内分区 |
|---|---|---|---|
| 工作台首页 | `home` | ✅ | — |
| 站点与采集配置 | `settings` | ✅ | `sources`（数据源管理） / `productlines`（产品线管理） |
| 数据资产与质量 | `quality` | ✅ | — |

### 采集与数据（`data`）

| 页签 | id | 渲染器 | 页内分区 |
|---|---|---|---|
| 采集器 | `collect` | ✅ | — |
| ASIN 数据管理 | `asin` | ✅ | — |
| 竞品数据分析 | `competitor` | ✅ | — |

### 关键词（`keywords`）

| 页签 | id | 渲染器 | 页内分区 |
|---|---|---|---|
| 关键词总库 | `kw` | ✅ | — |
| 关键词调研 | `research` | ✅ | — |
| 关键词管道 | `pipeline` | ✅ | — |

### 规则与政策（`compliance`）

| 页签 | id | 渲染器 | 页内分区 |
|---|---|---|---|
| 规则获取 | `rules` | ✅ | — |
| 最新政策 | `policy` | ✅ | — |

### 优化与报告（`optimize`）

| 页签 | id | 渲染器 | 页内分区 |
|---|---|---|---|
| 优化队列 | `optimize` | ✅ | — |
| 报告专区 | `report` | ✅ | — |
| 优化提示词专区 | `prompts` | ✅ | — |

### 执行与编排（`agent`）

| 页签 | id | 渲染器 | 页内分区 |
|---|---|---|---|
| Agent 编排 | `agent` | ✅ | — |

## 3. 差距清单（从代码读，不是手写）

这一节是这份文档真正的用途：**哪些东西声明了但还没接上。**
每一条都是一个可复核的集合差，不是印象。

| 检查 | 结果 | 差集 |
|---|---|---|
| 页签都有渲染器 | ✅ 全有 | — |
| 页签没有占位说明（`PANEL_NOTES`） | ✅ 一个都没有 | — |
| 工具定义都注册了（`index.js` 的 `registerTools`） | ✅ 一致 | — |
| 工具注册无重复 | ✅ 无 | — |
| 套件导入了都调用了 | ✅ 一致 | — |
| 数据源适配器已接（`planned` 就是没接） | ⚠️ 3 个未接 | `saihu` `sellersprite` `xiyou` |
| 原始调研的需求都能落到一个现存页签 | ✅ 全部能 | — |

> 最后一行只证明「需求有地方放」，**不证明需求被满足了**。页签存在 ≠ 行为对。
> 数据源那一行的 `planned` 是代码里的静态声明；它现在到底能不能用，是运行时事实，
> 要用 `amzn_source_list` 看，本脚本不猜。

## 4. 原始调研的 11 项需求现在落在哪

| 用户需求 | 页签 | 页面渲染器 |
|---|---|---|
| 亚马逊采集器 | `collect`（采集器） | ✅ |
| ASIN 数据管理器 | `asin`（ASIN 数据管理） | ✅ |
| 竞品数据分析 | `competitor`（竞品数据分析） | ✅ |
| 关键词总库 | `kw`（关键词总库） | ✅ |
| 关键词调研 | `research`（关键词调研） | ✅ |
| 关键词管道 | `pipeline`（关键词管道） | ✅ |
| 最新政策 | `policy`（最新政策） | ✅ |
| 规则获取 | `rules`（规则获取） | ✅ |
| 生成报告 | `report`（报告专区） | ✅ |
| 优化报告专区 | `optimize`（优化队列） | ✅ |
| 优化提示词专区 | `prompts`（优化提示词专区） | ✅ |

这张表是**需求 → 页签的定位表**，不是验收表。它回答「这件事现在在哪」，
不回答「做完了没有」—— 后者要看第 6 节的套件和第 7 节的边界。

## 5. 工具分布（按模块文件）

| 模块文件 | 工具数 | 工具 |
|---|---|---|
| `src/tools/agent.js` | 15 | `amzn_agent_artifact_decide` `amzn_agent_artifact_save` `amzn_agent_data_request` `amzn_agent_data_request_list` `amzn_agent_data_request_resolve` `amzn_agent_gate_decide` `amzn_agent_metrics` `amzn_agent_role_config_list` `amzn_agent_role_config_release` `amzn_agent_role_config_show` `amzn_agent_run_finish` `amzn_agent_run_list` `amzn_agent_run_recover` `amzn_agent_run_start` `amzn_agent_run_step` |
| `src/tools/prompt.js` | 13 | `amzn_prompt_eval_import` `amzn_prompt_eval_list` `amzn_prompt_eval_show` `amzn_prompt_history` `amzn_prompt_lifecycle_get` `amzn_prompt_lifecycle_transition` `amzn_prompt_list` `amzn_prompt_preview` `amzn_prompt_references` `amzn_prompt_rollback` `amzn_prompt_upsert` `amzn_prompt_version_activate` `amzn_prompt_version_rollback` |
| `src/tools/collect-center.js` | 12 | `amzn_collect_cancel` `amzn_collect_detail` `amzn_collect_env_check` `amzn_collect_plan_list` `amzn_collect_plan_save` `amzn_collect_preview` `amzn_collect_repair` `amzn_collect_run` `amzn_collect_scheme_list` `amzn_collect_scheme_save` `amzn_collect_scheme_transition` `amzn_collect_waiting_resolve` |
| `src/tools/asin.js` | 11 | `amzn_asin_archive` `amzn_asin_competitor` `amzn_asin_delete` `amzn_asin_detail` `amzn_asin_export` `amzn_asin_field_correct` `amzn_asin_get` `amzn_asin_query` `amzn_asin_upsert` `amzn_asin_variant_correct` `amzn_asin_variant_upsert` |
| `src/tools/optimize.js` | 11 | `amzn_optimize_evidence` `amzn_optimize_inbox` `amzn_optimize_plan_check` `amzn_optimize_precheck` `amzn_optimize_prepare` `amzn_optimize_report` `amzn_optimize_review` `amzn_optimize_save` `amzn_optimize_strategy` `amzn_optimize_validate` `amzn_optimize_validation` |
| `src/tools/kw.js` | 10 | `amzn_kw_export` `amzn_kw_import` `amzn_kw_merge` `amzn_kw_pipeline_history` `amzn_kw_pipeline_run` `amzn_kw_query` `amzn_kw_rank_history` `amzn_kw_report` `amzn_kw_scan_schedule` `amzn_kw_source` |
| `src/tools/observe.js` | 10 | `amzn_observation_check` `amzn_observation_conclude` `amzn_observation_list` `amzn_observation_plan_save` `amzn_observation_scan_due` `amzn_publication_baseline_decide` `amzn_publication_list` `amzn_publication_record` `amzn_rollback_list` `amzn_rollback_suggest` |
| `src/tools/keyword.js` | 6 | `amzn_keyword_coverage` `amzn_keyword_discover` `amzn_keyword_import` `amzn_keyword_query` `amzn_keyword_research` `amzn_keyword_scan` |
| `src/tools/kw-ownership.js` | 5 | `amzn_keyword_ownership_batch` `amzn_keyword_ownership_list` `amzn_keyword_ownership_preview` `amzn_keyword_ownership_resolve` `amzn_keyword_ownership_suggest` |
| `src/tools/kw-plan.js` | 5 | `amzn_keyword_plan_coverage` `amzn_keyword_plan_get` `amzn_keyword_plan_list` `amzn_keyword_plan_propose` `amzn_keyword_plan_save` |
| `src/tools/rule.js` | 5 | `amzn_rule_activate` `amzn_rule_diff` `amzn_rule_import` `amzn_rule_list` `amzn_rule_upsert` |
| `src/tools/kw-lifecycle.js` | 4 | `amzn_keyword_lifecycle_batch` `amzn_keyword_lifecycle_history` `amzn_keyword_lifecycle_list` `amzn_keyword_lifecycle_set` |
| `src/tools/report.js` | 4 | `amzn_report_build` `amzn_report_diff` `amzn_report_list` `amzn_report_update` |
| `src/tools/asin-view.js` | 3 | `amzn_asin_view_delete` `amzn_asin_view_list` `amzn_asin_view_save` |
| `src/tools/collect.js` | 3 | `amzn_collect_doctor` `amzn_collect_status` `amzn_collect_submit` |
| `src/tools/competitor.js` | 3 | `amzn_competitor_analyze` `amzn_competitor_quadrants` `amzn_competitor_set_upsert` |
| `src/tools/policy.js` | 3 | `amzn_policy_import` `amzn_policy_link` `amzn_policy_list` |
| `src/tools/context.js` | 2 | `amzn_workbench_context` `amzn_workbench_focus` |
| `src/tools/product-line.js` | 2 | `amzn_product_line_classify` `amzn_product_line_upsert` |
| `src/tools/quality.js` | 2 | `amzn_conflict_resolve` `amzn_dq_scan` |
| `src/tools/setting.js` | 2 | `amzn_setting_list` `amzn_setting_set` |
| `src/tools/source.js` | 2 | `amzn_source_list` `amzn_source_upsert` |
| `src/tools/asin-health.js` | 1 | `amzn_asin_health` |
| `src/tools/asin-history.js` | 1 | `amzn_asin_history` |
| `src/tools/asin-import.js` | 1 | `amzn_asin_import` |
| `src/tools/audit.js` | 1 | `amzn_audit_query` |
| `src/tools/dashboard.js` | 1 | `amzn_dashboard` |
| `src/tools/kw-detail.js` | 1 | `amzn_keyword_detail` |
| `src/tools/optimize-job.js` | 1 | `amzn_optimize_job` |
| `src/tools/product-import.js` | 1 | `amzn_product_import` |
| `src/tools/workspace.js` | 1 | `amzn_workspace_upsert` |

## 6. 测试套件

注册在 `tests/run.mjs`，共 **117** 个套件文件，**117** 个套件函数被 `await` 调用。

- `tests/activation-impact.mjs`
- `tests/agent-identity.mjs`
- `tests/asin-competitor.mjs`
- `tests/asin-csv-export.mjs`
- `tests/asin-portfolio.mjs`
- `tests/attribute-labels.mjs`
- `tests/attribute-projection.mjs`
- `tests/audit-mirror.mjs`
- `tests/b04-collect-foundation.mjs`
- `tests/b04-collect-page.mjs`
- `tests/b04-collect-tools.mjs`
- `tests/b04-section-fix.mjs`
- `tests/b04-section-writer.mjs`
- `tests/b04-variation-children.mjs`
- `tests/b05-asin-detail.mjs`
- `tests/b05-asin-page.mjs`
- `tests/b05-asin-table.mjs`
- `tests/b05-orphan-wiring.mjs`
- `tests/b05c-health.mjs`
- `tests/b05c-history.mjs`
- `tests/b05c-import.mjs`
- `tests/b05d-honesty.mjs`
- `tests/b05d-page.mjs`
- `tests/b05d-tabs.mjs`
- `tests/b05e-asin-archive.mjs`
- `tests/b06-quadrants.mjs`
- `tests/b08-detail.mjs`
- `tests/b08-lifecycle.mjs`
- `tests/b08-ownership.mjs`
- `tests/b08-plan.mjs`
- `tests/b11-2b-prompt-freeze.mjs`
- `tests/b11-3-lifecycle.mjs`
- `tests/b11-7-eval-set.mjs`
- `tests/b11-8-version-compare.mjs`
- `tests/b11-9-references.mjs`
- `tests/b11-variables.mjs`
- `tests/b12-10-closeout.mjs`
- `tests/b12-11-artifact-list.mjs`
- `tests/b12-13-amend-accept.mjs`
- `tests/b12-2-agent-metrics.mjs`
- `tests/b12-6-role-config.mjs`
- `tests/b12-7-context-package.mjs`
- `tests/b12-8-blocked-recovery.mjs`
- `tests/b12-9-task-type.mjs`
- `tests/b12-artifact-decision.mjs`
- `tests/b13-precheck.mjs`
- `tests/b13b-inbox-evidence.mjs`
- `tests/b13c-strategy-plan.mjs`
- `tests/b13d-validation-delivery.mjs`
- `tests/b14-blocked-page.mjs`
- `tests/cancel-audit.mjs`
- `tests/claim-atomicity.mjs`
- `tests/claim-overlap.mjs`
- `tests/clock-guard.mjs`
- `tests/collect-progress.mjs`
- `tests/command-palette.mjs`
- `tests/dashboard-trends.mjs`
- `tests/db-backup.mjs`
- `tests/empty-kind-map.mjs`
- `tests/empty-state-ratchet.mjs`
- `tests/empty-state.mjs`
- `tests/estimate-audit.mjs`
- `tests/evidence-policies.mjs`
- `tests/f1205-orchestration.mjs`
- `tests/f14-01-report-library.mjs`
- `tests/f14-02-report-standard.mjs`
- `tests/f14-10-report-export.mjs`
- `tests/kw-ad-daily.mjs`
- `tests/kw-competitor.mjs`
- `tests/kw-key.mjs`
- `tests/kw-library-bridge.mjs`
- `tests/kw-master.mjs`
- `tests/kw-overlap.mjs`
- `tests/kw-pipeline.mjs`
- `tests/kw-rank-observation.mjs`
- `tests/kw-report.mjs`
- `tests/kw-scan-schedule.mjs`
- `tests/kw-source-dir.mjs`
- `tests/kw-trend-placement.mjs`
- `tests/m12-agent.mjs`
- `tests/m14-observation.mjs`
- `tests/m14-page.mjs`
- `tests/m14-publication.mjs`
- `tests/optimize-expectation.mjs`
- `tests/optimize-job.mjs`
- `tests/payload-readers.mjs`
- `tests/policy-drift.mjs`
- `tests/product-import.mjs`
- `tests/product-line-classify.mjs`
- `tests/query-plan.mjs`
- `tests/s1b09-quality.mjs`
- `tests/s1b10-conflict.mjs`
- `tests/s1b11-snapshot.mjs`
- `tests/s1b12-audit.mjs`
- `tests/s1b13-recent.mjs`
- `tests/s1b14-quick.mjs`
- `tests/s1b15-search.mjs`
- `tests/s1b16-notification.mjs`
- `tests/s1b17-1-gates.mjs`
- `tests/s1b17-approval.mjs`
- `tests/s1b18-setup.mjs`
- `tests/s1b19-retention.mjs`
- `tests/s1b20-pins.mjs`
- `tests/slice-alarm.mjs`
- `tests/spend-report.mjs`
- `tests/t1-closeout.mjs`
- `tests/t2-lowlevel-cooldown.mjs`
- `tests/t4-test-infra.mjs`
- `tests/t6-variant-dq.mjs`
- `tests/t8-honest.mjs`
- `tests/t9-expired-flags.mjs`
- `tests/w1-final.mjs`
- `tests/w1-wiring.mjs`
- `tests/w1-writes.mjs`
- `tests/web-compression.mjs`
- `tests/web-page-structure.mjs`
- `tests/wired-source.mjs`

## 7. 这份矩阵证明不了什么

- 它证明的是**规模与接线**，不是**行为**：142 个工具都注册了，
  不等于每一个都被真机跑过；页面有渲染器，不等于每个按钮都对。
- 表数/索引数来自「跑一遍迁移的空库」，不是线上库；线上库可能还停在旧版本。
- 它不判断内容质量（文案好坏、规则是否最新、数据是否够用）。
- 要证明行为，看 `node tests/run.mjs` 的实测数字与 `docs/qa/` 下的真机报告。

<!-- 生成结束：以上内容全部由 scripts/report-completion.mjs 生成。 -->
