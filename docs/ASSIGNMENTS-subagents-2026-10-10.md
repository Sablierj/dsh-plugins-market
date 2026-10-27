# 未完成任务分配 · 子智能体任务书（2026-10-10）

> 配套：`docs/PLAN-v2.1-assessment-and-optimization-2026-10-10.md`（总览与优化建议）、
> `docs/COORDINATION.md` §7.5 的门禁与三条经验。
> 每条任务书的「背景与环境事实」都是这台机器上的真值，先读再动手。

---

## 任务 T-01：修「重启绕过冷却」（真实保护漏洞）

## 任务 <T-01>：修「重启绕过冷却」——recoverStaleTasks 放回 queued 之后、开跑前复查冷却
- 角色：全栈开发（Fullstack）
- 阶段/门禁：P4 开发实现 → P5 测试与验收 → G3 发布门禁
- 背景与环境事实：
  - 仓库：`D:\deepseek-harness-h\workspace\dsh-plugins\amazon-ops\`
  - 当前 main：`10f8052`（schema v39、TOOLS 113、`node tests/run.mjs` = 1509 passed / 0 failed）
  - 缺陷原文（真机事件流，`collection_task_event`）：冷却**还剩 52 分钟**时
    `cooling_down → queued`（理由「服务重启，冷却状态重新入队」）→ **0.002 秒后 `queued → running`**。
    成因：`recoverStaleTasks` 把 `cooling_down` 放回 `queued`，而 `drain()` / `runTask()` **不复查冷却**。
    作者注释说意图是「别重新计时」，**实现效果却是「直接开跑」** —— 注释与代码不符，本仓按缺陷处理。
  - **工作树**：自己建 `D:\deepseek-harness-h\workspace\wt-dsh-cooldown`（分支 `dsh-cooldown`，基于 main `10f8052`）。
  - **不要碰**：主线 `dsh-plugins`、`wt-dsh-e2e2`、`wt-dsh-blockpath`、`wt-dsh-*`、`wt-wb-*`。
- 目标：`recoverStaleTasks` 放回 `queued` 之后、**真正开跑之前复查冷却**；
  冷却未过就**留在 `queued`（或回到 `cooling_down`）并记一条事件说明为什么没开跑**。
- 范围：`src/sources/collection.js`、`src/domain/collect/env.js`、`tests/**`。
- 非目标：
  - 不改 `src/sources/pages/amazon.js`（另一条活动正在改）
  - 不改 `src/domain/asin/**`、`src/domain/prompts/**`、`src/tools/prompt.js`（别的会话的区）
  - **不自动清冷却**（冷却是有意的保护；要不要给清除入口是产品决定，这次不做）
  - **不跑真机采集**（真机复验刚跑完 round 4，且同一时刻只能有一个真机写者）
- 已知事实：
  - `src/sources/collection.js` 的 `recoverStaleTasks`、`drain()`、`runTask()` 是缺陷落点。
  - `src/domain/collect/env.js:355-356` 已修过「`now=null` 覆盖默认值」（`1469ae3`），**那个修复没有断言覆盖**（T-02 要补）。
  - 另有一条 `unverified`：验证者说「那次 requeue 后 0.69 秒的 `running` 窗口里**有没有真发出一次 Amazon 请求，
    无法证实也无法排除**」。**你的修复要能让这类问题以后可判定**（开跑前的那次复查在事件里留下依据）。
- 交付物：
  - `src/sources/collection.js` 的复查逻辑 + 事件记录
  - 测试断言（见「验收标准」）
  - 回报：结论 + 证据 + 置信度
- 验收标准：
  1. `node tests/run.mjs` 全绿，断言数 ≥ **1509**（**断言只增不减**，不许钉绝对数字）。
  2. **真证伪**：把复查冷却回退 → 相关断言**变红** → 改回全绿。**真跑**，把原文贴回来。
  3. 冷却未过时，重启后的任务**不会开跑**；事件里有依据（`recoverStaleTasks` 之后有一条「冷却未过，未开跑」）。
  4. `node scripts/check.mjs` 报 `OK amazon-ops (plugin: workbench) — 113 tool(s) registered`（**不许新增工具**）。
  5. **不静默**：冷却中不可静默变成「已入队但永不开跑」；状态与事件必须说得出来。
- 权限与禁止项：
  - 只写 `src/sources/collection.js`、`src/domain/collect/env.js`、`tests/**`
  - **不要用 PowerShell 的 `Set-Content`/`-replace` 改含中文的文件**（本会话已有人因此加过 BOM）
  - **不要用 PowerShell 写提交信息**（`-Encoding UTF8` 会加 BOM）
  - **不要 git commit**（交回后由主理人复核并入）
  - 零第三方依赖。一次性产物删掉。
- 回报格式：
  ```
  ## 结论 <做完了 / 卡在哪>
  ## 改了什么 <复查冷却加在哪一步（贴关键几行）；冷却未过时的状态与事件原文；怎么让那个 0.69 秒窗口以后可判定>
  ## 证伪原文 <回退 X → 断言 Y 变红；原文摘录>
  ## 证据 <run.mjs 末尾行；check.mjs 关键行；git status>
  ## 不确定的地方
  ```

---

## 任务 T-02：补「冷却分钟数」断言（主理人自己欠的账）

## 任务 <T-02>：补冷却分钟数断言 —— `now=null` 时体检项 10 不再产生 1970 起算的数
- 角色：全栈开发（Fullstack）
- 阶段/门禁：P4 开发实现 → P5 测试与验收
- 背景与环境事实：
  - 缺陷（真机实测）：体检项 10 `10-cooldown` 打印「约 **29860089** 分钟」（≈57 年）。
  - 成因（真函数零写库复现，已验证）：
    `siteCooldown(store, 'US')` → 30 ✅ / `siteCooldown(store, 'US', null)` → **29860069** ❌ /
    `siteCooldown(store, 'US', new Date())` → 30 ✅。
    `checkCooldown` 把可能为 `null` 的 `now` **显式传给** `siteCooldown`，**覆盖了它自己的
    `now = new Date()` 默认值** → `new Date(null).getTime() === 0` → 从 1970 起算。
  - **已修**（`1469ae3`，已并入 main）：`now` 为空时不传这个参数。**但那个修复没有断言覆盖**——
    按本仓「每处改动都要有一条回退就变红的断言」，它不合格。
- 目标：补一条**可证伪**的断言，把「`now=null` 不再产生 1970 起算的数」钉住。
- 范围：只改 `tests/**`（找 `b04-collect-foundation.mjs` / `b04-collect-tools.mjs` / `b04-section-writer.mjs`
  的合适位置；不要动 `src/`）。
- 非目标：不改 `src/`；不跑真机采集。
- 验收标准：
  1. 断言在真跑里存在（`node tests/run.mjs` 全绿，断言数 ≥ **1509**）。
  2. **证伪**：把 `src/domain/collect/env.js:355-356` 的修法回退（恢复显式传 `now`）→ **这条断言变红** → 改回全绿。**贴原文。**
  3. 断言里**不能钉绝对数字**（不写「恰好 30 分钟」，写「不是 29860089 这种 1970 起算的数」，
    用不变量 / 合理范围）。
- 回报格式：
  ```
  ## 结论 <做完了 / 卡在哪>
  ## 断言在哪 <文件与行；断言原文>
  ## 证伪原文 <回退 → 红；原文摘录>
  ## 证据 <run.mjs 末尾行>
  ```

---

## 任务 T-03：修「13 节读表陷阱」（UI/UX）

## 任务 <T-03>：13 节读表陷阱 —— `1/3` 与 `2/3` 都印 `partial` 时分不出「没读到」与「读到一部分」
- 角色：UI 设计师（UI Designer）+ 用户体验师（UX Designer）
- 阶段/门禁：P2 体验与界面设计 → P4 开发实现 → P5 测试与验收 → G3 发布门禁
- 背景与环境事实：
  - 当前 13 节页（ASIN 详情的「13 节」Tab）：五态是 `collected` / `missing` / `partial` / `failed` / `blocked`。
  - 真机实测（round 4）：`variations` 的 `parsed_value_json` 是
    `{"parent_asin":null,"variation_dimensions":["color_name"],"children":[11 个],"child_tiles":12}`，
    五态是 `partial`（2/3，因为 `parent_asin` 本来就没有）。
  - 而 round 3 的失效形态是 `{"parent_asin":null,"variation_dimensions":["color_name"],"children":[],"child_tiles":12}`，
    五态也是 `partial`（1/3，因为子体一个都没读到）。
  - **同一张表里，`1/3` 与 `2/3` 都印 `partial`，用户分不出「子体没读到」与「页面确实没有」。**
    区分信号只在 `errors_json`（`VARIATION_CHILDREN_UNREAD`）与 `child_tiles`（12 vs 0）里。
- 目标：让「没读到」与「确实没有」**在节表里看得到**。
- 范围：`src/web/page.js`（ASIN 详情区 13 节表）、`src/domain/asin/sections.js`（`buildSectionView` 的 payload 形状）、`tests/**`。
- 非目标：
  - **不改五态判据**（`sectionRecordStatus` / `buildSectionRecords` 是域层，已由 B-04 sect-writer 定型）
  - 不改 `src/sources/**`
  - 不动 `src/domain/optimize/**`、`src/domain/prompts/**`
- 验收标准：
  1. 同一张 13 节表里，「维度读到、子体一个都没读到」与「页面确实没有子体」**在视觉上能区分**
     （例如：后者在节名旁或计数旁带一个明确的「没读到」标记，且标记的来源是 `errors_json`/`child_tiles` 里已有的信号，
     **不是**新造一份）。
  2. **不改五态的语义**（`partial` 仍然是「采到一部分」）；改的是**呈现**。
  3. **不改任何既有断言**；新增断言证明「`child_tiles>0` 且 `children:[]` 的行被标出来了」。
  4. `node scripts/check-page.mjs` 3/3（改 page.js 后必跑）。
- 回报格式：
  ```
  ## 结论 <做完了 / 卡在哪>
  ## 改了什么 <页面哪一行/哪一列；信号从哪来（贴关键几行）>
  ## 两种状态怎么区分的 <贴页面原文或截图描述>
  ## 证据 <run.mjs 末尾行；check-page N/3；证伪原文>
  ## 不确定的地方
  ```

---

## 任务 T-04：`03-profile` 体检项报实际口径（配置 vs 事实）

## 任务 <T-04>：`03-profile` 体检项报「实际在用的 profile」，不是「配置里的 profileDir」
- 角色：全栈开发（Fullstack）
- 阶段/门禁：P4 开发实现 → P5 测试与验收
- 背景与环境事实：
  - 真机实测（round 4）：插件体检 `03-profile` 报「`…\e2e-round4\chrome-profile` 目录还不存在」，
    而**那个目录从未被创建**——因为 `launcher.js:70-73` 遇到端口已有人就**收养**现成的浏览器，
    此时 `config.profileDir` 是**无效配置**。
  - `browser_status.profile` 也报主线路径，也是配置口径（round 3 已记）。
- 目标：体检报**实际在用的 profile**（从进程命令行取 `--user-data-dir`），不是 `config.profileDir`。
- 范围：`src/domain/collect/env.js`（`03-profile` 项）、`tests/**`。
- 非目标：
  - 不改 `launcher.js` 的收养逻辑（那是另一个决定）
  - 不动 `browser_status` 的报法（那是 DSH 宿主的事，不在本插件）
- 验收标准：
  1. 收养时（端口已有人），`03-profile` 报**实际在用的 profile**（从进程命令行读 `--user-data-dir`）。
  2. 新建时（自己拉起的），报配置的 `profileDir`。
  3. **两处身份显示**（`browser_status.profile` 与 `03-profile`）都报**事实口径**。
  4. `node tests/run.mjs` 全绿 ≥ **1509**；证伪：回退 → 变红 → 改回。
- 回报格式：
  ```
  ## 结论 <做完了 / 卡在哪>
  ## 改了什么 <03-profile 怎么取实际 profile（贴关键几行）>
  ## 两种情况 <收养时 vs 新建时，体检各报什么>
  ## 证据 <run.mjs 末尾行；证伪原文>
  ## 不确定的地方
  ```

---

## 任务 T-05：真机复验拦截页（条件①）——**需用户确认破坏性操作**

## 任务 <T-05>：真机复验「点拦截页按钮 → 采集继续」（冷 profile / 杀 Chrome，**需用户确认**）
- 角色：验证工程师（QA Engineer）
- 阶段/门禁：P5 测试与验收（真机端到端）
- 背景与环境事实：
  - round 3：真机遇到拦截页（`form[action*=validateCaptcha]`），**点「Continue shopping」** → 落到 `https://www.amazon.com/`。
    但采集器 `finally` 里 `closePage`（`collector.js:530-532`）**把被拦的页关掉了** —— 人没有可点的按钮，
    验证者是自己在同 profile 重开页才点到的（那是 round 3 的做法）。
  - round 4：**0 次遇到拦截页**，所以「点几下」无答案；「冷 profile 下这条路能否跑通」仍 `unverified`。
  - **现在的代码（`dsh-blockpath`）**：被拦时**不再关那一页**，并把 CDP target id / URL / 按钮文案记进 `diagnostics().blockedPage`，
    三个门给同一段话（「那一页还开着，点 Continue shopping」）。
  - **这是唯一没验过的一段**：「点按钮之后采集真的能继续」。
- 目标：在**冷 profile**（全新目录）或**杀掉当前采集 Chrome**（PID 22816）之后，验证「点 Continue shopping → 拦截页消失 → 采集继续」。
- 范围：`D:\deepseek-harness-h\workspace\wt-dsh-e2e2\amazon-ops\scratch\e2e-round4\`（**只读**前三场 + **写** round4 的续篇）。
- 非目标：
  - **不改任何 `src/`**（本批禁跑真机）
  - **不写测试**（这是真机验证，不是写断言）
  - **不碰用户常驻服务**（`127.0.0.1:19387`）、**不重启任何东西**、
    **不动用户真实数据库与主线 profile**（`dsh-plugins\amazon-ops\data\`）
  - **不运行 `link-user-plugins.ps1`**
- ⚠️ **破坏性操作需用户确认**：
  - **方案 A（推荐）**：杀掉当前采集 Chrome（PID 22816，9333 上的 scratch profile），让它重新起一次冷 profile。
    **风险**：杀掉当前浏览器窗口；profile 是 scratch 的，可删可重建。
  - **方案 B**：换一个新的冷 profile（`--user-data-dir` 换一个全新目录），让它起一次全新的浏览器。
    **风险**：新建一个 Chrome 实例与 profile 目录；对现有浏览器无影响。
  - **方案 C**：**暂不验**，保留 `unverified`。
- 验收标准：
  1. 冷 profile 下，「点 Continue shopping → 拦截页消失 → 采集继续」**成立**（`collection_section_result` 真的有行落库）。
  2. 记录**点了几下**（1 下 / 2 下 / 更多）。
  3. 报告**新建**到 `scratch\e2e-round4\EVIDENCE-2026-10-10-round4-blocked.md`（**不要覆盖前三场**）。
  4. 合规核对：主线 DB sha256 前后一致、主线 profile mtime 未变、未碰 19387、未重启服务。
- 回报格式：
  ```
  ## 结论 <跑通了 / 采不到 / 卡在哪>
  ## 用了哪个方案 <A 杀 Chrome / B 冷 profile / C 未验>
  ## 拦截页与点击 <出现几次、点了几下、点后落到了什么页（贴原文/截图路径）>
  ## 采集结果 <13 节落库行数、五态分布、result_json 原文>
  ## 结论分级表 <verified/unverified/documented/stale>
  ## 挡住的是什么
  ## 合规核对
  ## 不确定的地方
  ```

---

## WorkBuddy 的三条（WorkBuddy 自己认领，主理人只裁决）

> 这三条写在 `docs/COORDINATION.md` 的认领表里，WorkBuddy 按它的节奏做。
> 主理人只做裁决（验收标准、门禁、合并复核）。

| 编号 | 任务 | 依据 |
|---|---|---|
| **W-01** | **B-11 剩余 · F11-08 双版本对比评估**（需固定输入快照） | 审计 §5.4：B-11 剩余里唯一剩下的（F11-09 已并入、F11-07 已并入 v39）；§3.30 也订正了「引用追踪不是 W-C」 |
| **W-02** | **B-12 剩余 · F12-02/03/06/09**（配置面十要素缺五 / 上下文包十要素缺五 / 任务画布 blocked 出口与恢复 / 失败与恢复） | 审计 §5.4：B-12 剩余 |
| **W-03** | **B-06 剩余 · F06-02/03/05/06/07**（按数据现实推迟，需评论文本通道） | 审计 §5.4：触发条件已写明——B-04 真的采到竞品 ASIN 之前不做 |

## 孤儿清单消减（主理人按批消，每批接线或删除）

`tests/wired-source.mjs` 的 `UNWIRED` 现有 **50 条**，按模块分：

| 优先级 | 模块 | 条数 | 典型处理 |
|---|---|---|---|
| 高 | B-04（采集） | 6 | `listEnvChecks` / `envCheckSummary`（体检项页面消费）、`collectedSections`（§5.5-4 断点恢复） |
| 中 | 模块 03（数据资产） | 4 | `datasetView` / `reopenConflict` / `fieldProvenance` / `diffSnapshots` |
| 中 | unknown | 31 | 逐个判「接线还是删除」（死代码候选删，有消费方的接） |
| 低 | 模块 02 / 08 / 10 / 14 | 9 | `marketFacts` / `browserSettings` / `getMaster` / `policiesForRule` / `deleteReport` 等 |

**治理规则**：每并入一批，就把它负责的 `UNWIRED` 条目消掉（接线或删除）。例外清单只减不增。
**孤儿检查自带自清理断言**（已接好的不能再留在名单里）——所以它是**可回归的数字**，不是摆设。
