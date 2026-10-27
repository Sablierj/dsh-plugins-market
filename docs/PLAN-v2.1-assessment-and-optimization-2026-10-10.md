# 总览与下一步 · 评估与优化（2026-10-10）

> 权威来源：`docs/requirements/RESEARCH-module-alignment-v2.0.md`（14 模块 × v2.0，126 条逐条对表）、
> `docs/COORDINATION.md` §3.x 交接条与 §7 台账、`docs/qa/*` 真机报告。
> 本文件只记**当前的实际状态**与**下一步**，不重复各批的详细结论。

## 1. main 现状

```
main = 10f8052 ｜ schema v39 ｜ TOOLS 113 ｜ 1509 passed / 0 failed ｜ 已推送（私有 GitHub）
孤儿检查：50 孤儿 / 50 例外 / 越界 0 / 死条目 0（完美平衡）
```

**代码规模**：src/domain 86 文件 1244 KB ｜ src/store 39 文件 836 KB ｜ src/tools 27 文件 629 KB ｜
src/sources 13 文件 293 KB ｜ src/web 2 文件 781 KB ｜ tests 58 文件 2587 KB。

## 2. 已交付（14 模块 × 8 批）

| 模块 | 已 land 的内容 | 状态 |
|---|---|---|
| **01** 工作台首页 | W1 接线批（F01-02 六卡 + F01-04 最近运行 + F01-05 快捷动作 + F01-07 通知中心 + F01-08 引导 + F01-09 最近访问） | 6/9 完成 |
| **02** 店铺站点品牌产品线 | B-11.1 变量注册表 + B-11.2b 冻结/回滚 + B-11.3 生命周期（schema v38） | 完成 |
| **03** 数据资产 | B-04.1 采集链（九态 + 重启恢复 + 断点不重复写入） + B-04.2 外部预填 + B-04.3 13 节写入方 | 完成 |
| **04** 采集中心 | B-04 采集中心（五子批，schema v36） + 真机跑通（条件：点拦截页 + 邮编） | 完成（真机 verified） |
| **05** ASIN 详情 | B-05a（详情四 Tab + 字段级事实 + 变体 + 归档，schema v37）+ B-05 页面那半（fetch + 四 body + handler + ASIN_PENDING_TABS 消费）+ B-05fix（13 节五态计数口径）+ **round 4 终点判据通过** | 完成（真机 verified） |
| **06** 竞品情报 | B-06.1 关键词差距四象限 + B-08.4 关键词详情视图 | 完成 |
| **07** 关键词调研 | B-08.1/2/3（F08-07 九态 + F08-04 所有权工作台 + F08-05 位置计划持久层） | 完成 |
| **08** 关键词总库 | B-08 前三子批 + B-08.5 覆盖矩阵（按数据现实推迟） | 完成 |
| **09** 关键词数据管道 | B-08.6 D1–D5 来源库（v37） + B-08.7 批次撤销 | 完成 |
| **10** 规则政策 SEO GEO | B-13.1 前置检查九项门槛 + B-13.2 优化模式四种 | 完成 |
| **11** 提示词资产 | B-11.1/2b/3（生命周期 v38） + B-11.7 固定评估集（v39） + B-11.9 引用追踪（含「聚焦驱动假绿 + 一条断言在保护缺陷」的发现） | 完成 |
| **12** Agent 编排 | B-12.1（三处「声明了却没做」兑现）+ B-12.2（§14 指标诚实子集）+ **B-12.5「缺半」诚实收口**（F12-05 编排模式 + 裁决翻转金丝雀断言） | 完成 |
| **13** Listing 优化 | B-13a（F13-02 九项门槛 + F13-04 四种优化模式） | 完成 |
| **14** 报告实验观测回滚 | B-14.1 发布记录 + B-14.2 偏离处置 + B-14.3 观测前置 + B-14.4 效果观测 + B-14.5 实验设计 + B-14.6 决策回滚 | 完成 |

**全部 14 模块已 land。** 但审计里 126 条里有 **21 条 missing** 与 **88 条 partial**（§4 缺口聚类），
许多**已完成**的只是「**出口存在，闭环没走完**」。

## 3. 三种「看起来能点但没接线」形态的存量（本仓第一大缺口形态）

| 形态 | 定义 | 存量 |
|---|---|---|
| **A. 页面上看起来能点但没有 handler** | CSS 给了 `cursor:pointer`，但 `onclick` 不存在 | 由 B-05 页面那半修了大半；`wb-f1109` 把「没有 handler 的 .asin-row」抓出来过一次 |
| **B. 生产零调用方的 store 导出** | 建好了函数/表/路由，没有任何生产方写/消费方读 | **50 条已登记**（`tests/wired-source.mjs` 的 `UNWIRED`）；孤儿检查自清理断言逼着它只减不增 |
| **C. 测试自己喂的数据** | 桩按选择器造页，夹具从被测对象派生 | B-04 sect-fix 把 `maximalPage()` 换成 `tests/html-dom.mjs` + `tests/fixtures/` 真实页面样本；`wb-f1109` 发现「聚焦驱动比全量宽松 → 绿是假的」 |

## 4. 未完成任务清单（权威来源：审计 §5 + §7.3 + 孤儿清单 + 本轮发现）

### 4.1 真机 / 端到端（跨批次欠账）

| # | 事项 | 状态 | 依据 |
|---|---|---|---|
| 1 | **冷 profile / 拦截页能否跑通** | **未验** | round 4 是 0 次拦截；`collector.js:finally closePage` 关闭被拦页 → 人没有可点的按钮。**需你决定：要不要造拦截页（杀 Chrome / 换冷 profile = 破坏性操作需确认）** |
| 2 | **拦截页的人工通过路径** | **已做**（`dsh-blockpath`） | 采集器被拦时不再关那一页，三个门说同一句话；「换网络或稍后再试」已删 |
| 3 | **真机四判据的复验** | **已通过**（round 4） | `variations` 子体 `children = 11`；四重独立验证 |

### 4.2 代码 / 机制（自己欠的账）

| # | 事项 | 状态 | 归属 |
|---|---|---|---|
| 4 | **重启绕过冷却**（真机已证：冷却还剩 52 分钟时重启 → 0.002 秒后开跑） | **未修** | DSH（全栈） |
| 5 | **冷却分钟数差 6 个数量级**（已修 `1469ae3`，**但缺断言**） | 修复已并入，**缺断言** | DSH（主理人自己欠的） |
| 6 | **删三个薄封装**（`listSectionResults`/`sectionSummary`/`taskAsinSummaries`，生产零调用方） | **已删**（`4def06b`） | ✅ |
| 7 | **13 节读表陷阱**：`1/3` 与 `2/3` 都印 `partial`，表格上分不出「没读到」与「读到一部分」 | **未修** | DSH（UI/UX） |
| 8 | **`03-profile` 体检项报的是配置口径**（报的 profile 目录可能从未被创建，因 `launcher.js:70-73` 遇端口有人就收养） | **未修** | DSH（全栈） |

### 4.3 各模块剩余（审计 §5）

| 批次 | 剩余 | 归属 |
|---|---|---|
| B-05 剩余 | 后五个 Tab（关键词与排名 / 评论问答 / 竞品对比 / 优化历史 / 来源与审计）、F05-01 大表 17 列 + 保存视图 + 导出、F05-04 历史 diff、F05-05 批量导入、F05-07 健康摘要、F05-06/F05-08 完整交互 | DSH |
| B-13 剩余 | F13-01 草案收件箱、F13-03 证据包（十类快照）、F13-05 策略阶段、F13-06 位置计划核对、F13-08 校验体系、F13-09 交付边界 | DSH |
| B-11 剩余 | F11-08 双版本对比评估（需固定输入快照） | WorkBuddy |
| B-06 剩余 | F06-02/03/05/06/07 —— **按数据现实推迟**（需评论文本通道；F06-05 尤其） | WorkBuddy（deferred） |
| B-12 剩余 | F12-02 配置面（十要素缺五）+ F12-03 上下文包（十要素缺五）+ F12-06 任务画布（blocked 出口 / 恢复 / 每步 Agent / 工具调用两栏）+ F12-09 失败与恢复（可重试标记 / 中断恢复 / 取消保留产物） | WorkBuddy |

### 4.4 孤儿清单（50 条待接线，按模块）

| 模块 | 条数 | 典型 |
|---|---|---|
| B-04（采集） | 6 | `listEnvChecks` / `envCheckSummary` / `listSchemeVersions` / `collectedSections` / `listTaskEvents` / `countTaskEvents` |
| unknown | 31 | `sectionOrder` / `sectionFields` / `sectionStatusFromValue` / `datasetById` / `datasetsForAsset` / `cardSpecs` / `isFavorite` / `countTodos` / `readLineSignals` / `extractNgrams` / `findHeaderRow` / `toRecords` / `isEmptySignals` / `headerIndex` / `needsBaselineChoice` / `observableMetrics` / `isDraftPublishable` / `lexiconNote` / `groupBySection` / `needsConfirmation` / `sectionShortLabel` / `orphanChecks` / `unavailableKinds` / `createDefaultSettings` / `isKnownSettingKey` / `planPositionPurpose` / `listTargets` / `CdpConnection` / `isTier` / `organicRank` / `findExtractor` / `listArtifacts`（已删）… |
| 模块 02（站点） | 4 | `marketFacts` / `browserSettings` / `lastVerifiedAt` / `listSiteVerifications` |
| 模块 03（数据资产） | 4 | `datasetView` / `reopenConflict` / `fieldProvenance` / `diffSnapshots` |
| 模块 08（关键词） | 1 | `getMaster` |
| 模块 10（规则政策） | 3 | `policiesForRule` / `supersede` / `policyChain` |
| 模块 14（报告） | 1 | `deleteReport` |

**治理规则**：每并入一批，就把它负责的 `UNWIRED` 条目消掉（接线或删除）。例外清单只减不增。

## 5. 新版本的设计优化建议（基于本轮完成评估）

### 5.1 防「看起来能点但没接线」的系统性手段（B 类缺口）

**现状**：`tests/wired-source.mjs` 只扫 `store` 导出。它抓到的是「**函数零生产调用方**」，但抓不到「**页面上看起来能点但没有 handler**」（A 类）。

**建议**：把 `wired-source.mjs` 扩成两层：

1. **扫 `src/web/page.js` 的静态标记**：找出所有带 `cursor:pointer` / `class="*-row"` / `onclick` 的字符串，
   再对它们各自查「同一文件里有没有真的 handler 注册」。
   （B-05 页面那半已经把这一类修了大半；`wb-f1109` 发现过一条新的——「`.asin-row` 有 pointer 无 handler」。）
2. **扫 `src/web/routes.js` 的注册**：找出所有 `POST /api/...` 但**没有 `PANEL_RENDERERS` 消费**的路由。
   （B-04 的 8 条路由与 12 个工具都有页面消费；后续批次要继续这个约束。）

**收益**：把「**功能存在、接线那一头没接**」从「靠人一个个找」变成「**可回归的数字**」，
和 `wired-source.mjs` 一样，**带一条自清理断言**（已接好的不能再留在名单里）。

### 5.2 防「测试自我确认」的系统性手段（C 类缺口）

**现状**：B-04 sect-fix 把 `maximalPage()`（照选择器造桩）换成了 `tests/html-dom.mjs` + `tests/fixtures/`。
但 `wb-f1109` 发现另一类：**「聚焦驱动比全量宽松 → 绿是假的」**（`check` 配 `async` 回调在聚焦里连判 FAIL 的机会都没有）。

**建议**：

1. **`tests/run.mjs` 加一条运行器规则**：任何 `check(...)` 里**不允许直接配 `async` 回调**，
   必须用 `checkAsync(...)`。**运行器在收集阶段就拒绝 `check` + `async` 的组合**（不是等它红）。
   `wb-f1109` 实测：聚焦一路绿、全量一跑就红（`run.mjs:325`）。
2. **夹具来源分层**：把 `tests/fixtures/` 的夹具分成**真机捕获**（`amazon-dp-live-*.html`）与
   **合成**（`amazon-blocked-synthetic-*.html`），并在文件头写明「这不是真机证据」。
   B-04 sect-fix 已经这么做了；**后续任何读页面的断言都必须用这两类，不许再造按选择器索引的桩**。

### 5.3 防「没有数据 ≠ 数据是 0」的系统性手段（本仓最常复现的缺陷）

**现状**：这一轮反复出现：
- `variations` 判 `missing`（＝「亚马逊确实没有」），而页面有 48 个色块。
- `listSectionResults` 的 `MAX_ROWS=5000` 无截断信号 → 超量时页面读成「未采集」（「没测到」读成「没采集」）。
- `counts.children` 数「边」而标签写「子体」。
- `deriveStatus` 新规则「`sectionsWritten===0` 而 ASIN 成功 → partial」**连测试都没有**（恰好没被触发的保险 = 不存在）。

**建议**：把这四条判据写成**仓库级的不变量**（不只是断言，而是模式）：

1. **`missing` 只在「页面确实没有那一节」时写**；「选择器没认出来」必须写成 `failed`（带明确信号）。
2. **任何「读被截断」都必须带 `truncated` 标记与 `read`/`total`/`limit` 三个数**，
   页面必须把它说出来（`SECTION_READ_TRUNCATED_LABEL` 已经立了这个先例）。
3. **任何「计数」都必须有分母与扣分项**；任何「自报状态」必须由内容推导，
   并配一条**读回对账**的断言（`auditStoredSectionResult` 已经立了这个先例）。
4. **「恰好没被触发的保险」必须有一条断言**（`deriveStatus` 的 `sectionsWritten===0` 规则已经补了断言）。

### 5.4 防「钉绝对数字」的系统性手段（断言稳定性）

**现状**：本仓为此付过三次代价（连续三个批次各红一次全量，85/86/87）。
最近两次是两边**各自**修了同一个题型的一半。

**建议**：`tests/run.mjs` 的「两处注册面集合相等」已经改成了**逐名集合相等**（比计数更强、永不过期）。
**所有未来的工具数 / 迁移号断言都照这个模式**：钉**不变量**，不钉**绝对数字**。

## 6. 未完成任务分配（按角色与写作用域）

> 写作用域不重叠；同一时刻只有一个真机写者（真机验证期间冻结 `src/` 写入）。

### 6.1 立即做（本批）

| 编号 | 任务 | 角色 | 写作用域 | 验收 |
|---|---|---|---|---|
| **T-01** | **重启绕过冷却**：`recoverStaleTasks` 放回 `queued` 之后、开跑前**复查冷却**；冷却未过就留在 `queued`（或回 `cooling_down`）并记事件；不许把「冷却中」静默变成「已入队但永不开跑」 | 全栈 | `src/sources/collection.js`、`src/domain/collect/env.js`、`tests/**` | `node tests/run.mjs` 全绿 ≥ **1509**；证伪：回退 → 变红 → 改回（贴原文） |
| **T-02** | **补冷却分钟数断言**：`now=null` 时体检项 10 不再产生 1970 起算的数（`siteCooldown(store,'US',null)` 应 ≈ 正确值，不是 29860069） | 全栈 | `tests/**`（找 `b04-collect-foundation.mjs` 或 `b04-section-writer.mjs` 的合适位置） | 回退 `1469ae3` 的修法 → 断言变红 → 改回全绿 |
| **T-03** | **13 节读表陷阱**：`1/3` 与 `2/3` 都印 `partial` 时分不出「没读到」与「读到一部分」——给节表加一列**读回对账信号**（`child_tiles` / `errors_json` 里已有的 `VARIATION_CHILDREN_UNREAD` 等），让「没读到子体」在表格里**看得到** | UI 设计师 + UX | `src/web/page.js`（ASIN 详情区 13 节表）、`src/domain/asin/sections.js` | 同一张表里能区分「维度读到、子体没读到」与「页面确实没有」；不改五态判据（那是域层的事） |
| **T-04** | **`03-profile` 体检项报实际口径**：当 `launcher.js:70-73` 收养（端口已有人）时，体检报「实际在用的 profile」（从进程命令行取 `--user-data-dir`），而不是 `config.profileDir`（可能是从未被创建的空目录） | 全栈 | `src/domain/collect/env.js`（`03-profile` 项）、`tests/**` | 收养时报实际在用的 profile；新建时报配置的；**两处身份显示（`browser_status.profile` 与 `03-profile`）都报事实口径** |
| **T-05** | **真机复验拦截页（条件①）**：造一次拦截（换冷 profile 或杀 Chrome），验证「点 Continue shopping 之后能继续采集」——**这是唯一没验过的一段** | 验证工程师 | `wt-dsh-e2e2\amazon-ops\scratch\e2e-round4\`（只读+写 scratch）+ **需用户确认**（破坏性操作） | 冷 profile 下「点按钮 → 拦截页消失 → 采集继续」是否成立；**如实报** |

### 6.2 WorkBuddy（WorkBuddy 自己认领，主理人只裁决）

| 编号 | 任务 | 依据 |
|---|---|---|
| **W-01** | **B-11 剩余 · F11-08 双版本对比评估**（需固定输入快照）——§7.3 说这是 B-11 剩余里唯一剩下的；`wb-f1109` 已做了 F11-09，§3.30 也订正了「引用追踪不是 W-C」 | 审计 §5.4 B-11 剩余 |
| **W-02** | **B-12 剩余 · F12-02/03/06/09**（配置面十要素缺五 / 上下文包十要素缺五 / 任务画布 blocked 出口与恢复 / 失败与恢复） | 审计 §5.4 B-12 剩余 |
| **W-03** | **B-06 剩余 · F06-02/03/05/06/07**（按数据现实推迟，需评论文本通道）——触发条件已写明：B-04 真的采到竞品 ASIN | 审计 §5.4 B-06 剩余 |

### 6.3 孤儿清单消减（主理人按批消，每批接线或删除）

| 优先级 | 模块 | 条数 | 典型处理 |
|---|---|---|---|
| 高 | B-04（采集） | 6 | `listEnvChecks`/`envCheckSummary`（体检项页面消费）、`collectedSections`（§5.5-4 断点恢复） |
| 中 | 模块 03（数据资产） | 4 | `datasetView`/`reopenConflict`/`fieldProvenance`/`diffSnapshots` |
| 中 | unknown | 31 | 逐个判「接线还是删除」（死代码候选删，有消费方的接） |
| 低 | 模块 02 / 08 / 10 / 14 | 9 | `marketFacts`/`browserSettings`/`getMaster`/`policiesForRule`/`deleteReport` 等 |

## 7. 我现在要你确认的（只有一个）

**T-05（真机复验拦截页）需要破坏性操作**：
- 要么**杀掉当前的采集 Chrome**（PID 22816，9333 上的 scratch profile），让它重新起一次冷 profile；
- 要么**换一个新的冷 profile**（`--user-data-dir` 换一个全新目录），让它起一次全新的浏览器。

**两种都是破坏性操作，需你点头**（我默认**不动**用户日常 Chrome，只动采集专用 Chrome）。
你要选哪种？还是**暂时不验**（`unverified` 保留）？

## 8. 本批的门禁（照抄 §7.5）

G2 契约（入参/出参/错误码 + 迁移与回滚 + 数字）→ 实现 → `node tests/run.mjs` 全绿且
**断言只增不减**（≥ **1509**）→ `node scripts/check.mjs` 报 OK → **含页面的批次必须做真机验收** →
主理人独立复核（真跑命令、真看返回）→ 并入 main → **push**。

**本仓最强的三条经验，给每一批自查**：
1. **不要钉绝对数字**（`SCHEMA_VERSION === 39`、`TOOLS.length === 113`）。钉**不变量**。
2. **「功能存在、接线的那一头没接」是第一大缺口形态** —— 页面上**看起来能点**但没有 handler 的东西，比一块空白更糟。
3. **「没有数据」与「数据是 0」必须分开**；**「没有建模」与「没测到」必须分开**。
   把缺失渲染成一个看起来像值的东西，是本仓最常复现的缺陷。
