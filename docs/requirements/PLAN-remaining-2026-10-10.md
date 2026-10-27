# 剩余任务与分工 · 全局整理（2026-10-10）

> 权威来源：`docs/requirements/RESEARCH-module-alignment-v2.0.md` §5 的批次表（14 模块 × v2.0，126 条）、
> `docs/COORDINATION.md` §7 台账与 §3.12–§3.22 交接条、`docs/qa/E2E-13-sections-2026-10-09.md` 真机报告、
> 以及 WorkBuddy 新建的**孤儿检查** `tests/wired-source.mjs`（在 `wb-b124`）。
>
> 本文只记**当前实际状态**与**分工**，不重复各批的详细结论。

## 1. main 现状

```
main = b87033b ｜ schema v37 ｜ TOOLS 105 ｜ 1140 passed / 0 failed ｜ 已推送（私有 GitHub）
```

**已 landed**：W1 接线批 ｜ B-04 采集中心（五子批）｜ B-05a + B-05 页面那半 ｜ B-05fix 13 节计数口径 ｜
B-06.1 ｜ B-08.1/2/3/4 ｜ B-11.1 / B-11.2b + 对抗验收修复 ｜ B-12.1/2 ｜ B-13a 九项门槛 + 四模式 ｜
13 节生产写入方 ｜ 真机四处判据缺陷的修复 ｜ 7 条「钉绝对数字」的断言改成不变量。

## 2. 未并入的分支

| 分支 | 提交 | 内容 | 状态 |
|---|---|---|---|
| `dsh-axisfix` @ `c9dcd93` | 1 | 变体计数改数「不同子体」+ `listSectionResults` 截断信号 + §3.6 订正 | **合并进行中**（1136/0） |
| **`wb-b124`** @ `1aebdf5` | 4 | **「建好了但没接上」的仓库级检查** `tests/wired-source.mjs`（405 行）+ 30 个 domain/sources 孤儿 + **抓到 B-05 的三个孤儿** | 待并入 |
| **`wb-b113`** @ `154acdf` | 8 | **B-11.3 生命周期**（F11-05 的接线半边）：`domain/prompts/lifecycle.js`、`store/prompt.js` +519、**schema v38**、`tools/prompt.js` +282、页面 +92、路由 +68、`tests/b11-3-lifecycle.mjs` 818 行 | 待并入（报 1126/0，基于旧 main） |
| `merge-check-wb` / `merge-check-wb2` | — | WorkBuddy 自己的合并验证树 | **可弃**（已被 main 吸收） |
| `s1b09` @ `5f027a8` | — | 10-01 的旧分支 | **可弃或确认**（远早于本阶段） |

**迁移号**：main = v37，`wb-b113` = **v38** → **不撞**（sectfix/axisfix 都没动 schema）。

## 3. 未完成的任务清单（按来源）

### 3.1 审计 §5 批次表里还没做的

| 批次 | 剩余 | 归属建议 |
|---|---|---|
| **B-11.3** | **已在 `wb-b113` 做完**，只差并入 | WorkBuddy |
| B-11 剩余 | F11-07 固定评估集、F11-08 引用追踪 | WorkBuddy |
| B-12 剩余 | F12-05 + F12-02/03/06/09 的缺半 | WorkBuddy |
| B-06 剩余 | F06-02/03/05/06/07 —— **按数据现实推迟**（需评论文本通道） | WorkBuddy（deferred） |
| B-05 剩余 | 后五个 Tab（关键词与排名 / 评论问答 / 竞品对比 / 优化历史 / 来源与审计）、F05-01 大表 17 列 + 保存视图 + 导出、F05-04 历史 diff、F05-05 批量导入、F05-07 健康摘要、F05-06/08 完整交互 | DSH |
| B-13 剩余 | F13-01 收件箱、F13-03 证据包、F13-05 策略阶段、F13-06 位置计划核对、F13-08 校验体系、F13-09 交付边界 | DSH |

### 3.2 真机验证查出的（`docs/qa/E2E-13-sections-2026-10-09.md`）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 四处判据缺陷（`variations` / `return_policy` / `<script>` 污染 / `deriveStatus` 无测试） | **已修**（`dsh-sectfix`，已进 main） |
| 2 | **真机复验**：看 `variations` 是否从 `missing` 变成那 48 个色块 | **待做（本阶段唯一的终点判据）** |
| 3 | 两处内容污染（`availability` / `badges`）是否真干净 | 待真机复验 |
| 4 | `deriveStatus` 新规则的真机行为 | 待真机复验 |

### 3.3 孤儿检查查出的（`wb-b124` 的 `UNWIRED` 例外清单，55 条全带理由）

**54 个孤儿全部在例外清单里 → main 通过该检查。** 其中 **3 条是 B-05 建的、被明确标为「待裁决」**：

| 导出 | 位置 | WorkBuddy 的备注 | **主理人裁决** |
|---|---|---|---|
| `isAsinArchived` | `store/archive.js` | 只被测试调用 —— 生产路径未接 | **接线**：归档状态是 ASIN 详情该显示的（F05-08），页面上「已归档」这一态现在没有依据 |
| `archivedAsinCount` | `store/archive.js` | **全仓零调用（含测试）** —— 死代码候选 | **裁决：接线或删除二选一，本阶段先做「接线」**：概览给一个「已归档 N 个」，否则删掉 |
| `listVariantEvents` | `store/variant.js` | 只被测试调用 —— 生产路径未接 | **接线**：变体页应显示变体事件历史（F05-06） |

**另外两条已知未接的**（作者自陈，不是新发现）：
- `collectedSections`（`store/collection-section.js`）—— **test-only**，正是 **§5.5-4「恢复时不重采已 collected 的节」**。**现在节表里有行了，这条才第一次能实现。**
- `findExtractor`（`sources/pages/index.js`）—— no-caller。

**待裁决的一条口径**：55 条例外是「**有理由的允许**」还是「**技术债清单**」？
建议**按后者治理**：每并入一批就把它负责的条目消掉（接线或删除），例外清单只减不增；
**新增条目必须带 `note` 说明理由**（现有 55 条已全部带 note，这个规矩已经立住了）。

### 3.4 跨批次欠账（§7.4）

1. **13 节的整体 `verified`** —— 需 §3.2 的真机复验。**在那之前，13 节只能记「写入方 verified、判据已修（代码侧 verified）、真机复验待做」。**
2. **暖 profile / 已登录态能否过拦截页** —— `unverified`（用主线 profile 会写主线，需授权）。
3. **采集的另外两处已证缺陷**（`env.js` 冷却分钟数错 6 个数量级、`submit()` 绕过冷却）—— 已记账未修。

## 4. 分工（写作用域不重叠）

### WorkBuddy 负责

| 任务 | 写作用域 |
|---|---|
| 并入 `wb-b124`（孤儿检查） | `tests/wired-source.mjs`、`tests/run.mjs`、`docs/COORDINATION.md` |
| 并入 `wb-b113`（B-11.3） | `src/domain/prompts/**`、`src/store/prompt.js`、`src/store/schema.js`（v38）、`src/tools/prompt.js`、`src/web/{page,routes}.js` 的提示词区 |
| F11-07 / F11-08 | 同上提示词区 |
| F12-05 + B-12 缺半 | `src/domain/agent/**`、`src/store/agent.js`、agent 区 |
| B-06 剩余 | **deferred**，等评论文本通道 |

### DSH 负责

| 任务 | 写作用域 |
|---|---|
| 并入 `dsh-axisfix` | （进行中） |
| **B-05 的三个孤儿接线**（`isAsinArchived` / `archivedAsinCount` / `listVariantEvents`） | `src/domain/asin/**`、`src/store/{archive,variant}.js` 的调用方、`src/web/page.js` 的 ASIN 详情区 |
| **§5.5-4 恢复时不重采已 collected 的节**（`collectedSections` 接线） | `src/sources/collection.js`、`src/store/collection-section.js` |
| B-05 剩余（五个 Tab、F05-01 大表、F05-04/05/07/08） | ASIN 详情区 |
| B-13 剩余（F13-01/03/05/06/08/09） | `src/domain/optimize/**` |

### 两边都要做、但**必须串行**的

- **真机复验**（§3.2 第 2 条）：**同一时刻只能有一个真机写者**。
  上一轮的教训：两个任务挤一个 worktree，验证者「验的是一棵被并发改过的树」。
  **约定：真机验证期间冻结 `src/` 写入**，并在报告里用文件哈希标明「验的是哪棵树」。

### 共享文件的撞车点（合并时按并集处理）

`tests/run.mjs`（两边都注册测试文件）、`docs/COORDINATION.md`（不同小节）、
`src/web/page.js` 与 `src/web/routes.js`（**不同区**：提示词区 vs ASIN 详情区 —— 位置不重叠但同文件）。

## 5. 逐项执行顺序（本阶段）

1. **并入 `dsh-axisfix`**（进行中，1136/0）
2. **并入 `wb-b124`**（孤儿检查）—— 先把**度量**立起来，后面的接线才有回归网
3. **裁决并执行 B-05 的三个孤儿接线**（DSH）—— 由 2 的清单驱动，做完就从 `UNWIRED` 里消掉
4. **`collectedSections` 接线**（§5.5-4，DSH）
5. **并入 `wb-b113`**（B-11.3，v38）—— 注意它是基于旧 main，需按并集处理
6. **真机复验**（§3.2）—— **本阶段唯一的终点判据**；验完 13 节才能整体记 `verified`
7. F11-07/08（WorkBuddy）、B-05 剩余（DSH）按余力推进

## 6. 一条纪律（这一路反复付代价换来的）

> **每并入一批，就把它负责的 `UNWIRED` 条目消掉（接线或删除）。例外清单只减不增。**

理由：`wb-b124` 的意义不是「发现 54 个孤儿」，而是**把「建好了但没接上」变成了一个可回归的数字**。
数字一旦存在，就必须**只能变小**——否则它会像「钉绝对数字」那类断言一样，变成一个大家绕着走的摆设。
