# 查询计划基线（P1-3）

> 目的：留下「哪些查询走了索引、哪些不走、为什么不走」的**实测**记录。
> 方法：不手写 SQL，而是用 `store.all/get/run` 包装器**追踪真实调用**产生的语句，
> 再在有数据的库（4000 行 + `ANALYZE`）上跑 `EXPLAIN QUERY PLAN`。

## 为什么不能手写 SQL、也不能断言"不许 SCAN"

1. **手写 SQL 会与实现漂开。** 我第一版手写 `WHERE status = ?`，而真实实现是
   `ORDER BY CASE severity WHEN 'block' THEN 0 …`；planner 因此多排一次序，
   我差点据此得出「`dq_issue` 缺索引」的错误结论 —— 而实际上它的问题在**排序键是表达式**。
2. **空表时 SQLite 一定选全表扫描。** 那是对的。所以「计划里出现 SCAN」本身不是缺陷，
   在空库上断言它就是在制造假红。

## 实测结果（v49 之后）

| 查询 | 计划 | 判断 |
|---|---|---|
| `listNotifications`（`ORDER BY created_at DESC`） | `SCAN notification USING INDEX idx_notif_created` | ✅ **本次修复**：v49 之前是 `SCAN notification` + `TEMP B-TREE FOR ORDER BY` |
| `queryAsins` | `SCAN a USING INDEX idx_asin_updated` + 相关子查询走 `idx_asin_keyword_rank` | ✅ 正常 |
| `listAudit`（`ORDER BY at DESC, id DESC`） | `SCAN audit_log USING INDEX idx_audit_at` + `TEMP B-TREE FOR LAST TERM` | 可接受：两列排序，索引只覆盖第一列 |
| `listIssues`（`ORDER BY CASE severity …`） | `SCAN dq_issue` + `TEMP B-TREE FOR ORDER BY` | **已知，不修**（见下） |
| `listIssues` 按对象过滤 | `SEARCH dq_issue USING INDEX idx_dq_object` + `TEMP B-TREE` | 过滤命中索引；排序仍是上面那条原因 |

## 已知不修的一项，及理由

`dq_issue` 的 `ORDER BY CASE severity WHEN 'block' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END`
——**排序键是表达式**，任何普通索引都用不上。三条出路：

1. 加**表达式索引**（`CREATE INDEX … ON dq_issue(CASE severity …)`）——SQLite 支持，
   但等于把一段业务规则冻进索引定义，改 severity 权重时容易忘；
2. 存一个 `severity_rank` 列并建复合索引 —— 需要一次迁移 + 回填；
3. 改查询语义（先按 status 过滤再排序）—— 会改变页面默认展示顺序。

三条都超出「补索引」的范围，属于**改行为**。当前 `dq_issue` 的量级（数据质量问题是
人工处理的几十到几百条）下，全表扫描 + 排序实测不构成问题。**记录在此，等量级真的上来再动。**

## 回归断言（`tests/query-plan.mjs`）

| # | 断言 | 防的是什么 |
|---|---|---|
| ① | 真实读路径执行过的每条 SQL 都能在真实 schema 上 `prepare` | 列名/表名漂移 —— 这类错误今天只会在第一次真调用时炸 |
| ② | `listNotifications` 必须走 `idx_notif_created`，且不再需要 `TEMP B-TREE` | 索引被删、或查询被改而不自知 |
| ③ | **反例**：删掉索引 → 同一查询必须退化成全表扫描 | 证明 ② 真在测东西；没有这条，② 可能是空检查 |
| ④ | `listIssues` 的排序键仍是 `CASE` 表达式，且仍需要临时 B 树 | 哪天有人真把它优化掉了，这条会红 —— 提醒同步更新本文件 |

第 ③ 条是本套断言里最值钱的一条：**没有反例的正向断言，无法区分"测到了"和"没测到"**。
