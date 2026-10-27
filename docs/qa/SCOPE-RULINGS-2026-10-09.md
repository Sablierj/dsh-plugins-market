# 写作用域裁决与追加要求（主理人，2026-10-09）

> 背景：子代理不可用 `send_message` 寻址，所以主理人的裁决只能落成文件。
> 本文件记录**已下发的裁决**与**尚未送达的追加要求**，供整合方/下一位接上。

## 批次 `dsh-axisfix`（worktree `wt-dsh-axisfix`，分支 `dsh-axisfix`，基于 main `5337c7e`）

### 已批准：写作用域从 3 个文件扩到 5 个

作者开工时提问：任务书写的范围（`src/domain/asin/**`、`src/store/collection-section.js`、`docs/COORDINATION.md`）
**装不下它的交付物**，并给出实测调用点。主理人独立核实后**批准扩权**：

| 允许写 | 用途 |
|---|---|
| `src/domain/asin/**` | ① 口径本体（`overview.js` 的 label/分母/missing） |
| `src/store/collection-section.js` | ② `listSectionResults` 的截断信号 |
| **`src/web/page.js`** | ① 面板文案、② 读者把截断说出来 |
| **`src/tools/asin.js`** | ① 工具输出（`:398` 就是印「子体 X/Y 有维度」的那一行） |
| `tests/**` | ② 要能**真的**造成截断 |
| `docs/COORDINATION.md` §3.6 | ③ 文档订正 |

**批准理由**：不改 page.js/工具，① 的「面板文案」与 ② 的「读者必须把它说出来」就交不了 ——
**那等于把缺陷留在原地、只改了一个没人看的数据结构**，正是本仓反复付代价的那个形态。

**主理人已独立核实**（不是采信作者）：`page.js:7491` 与 `tools/asin.js:398` 确实在印那个数。

### ⚠️ 尚未送达的追加要求（作者清单里漏了这一处）

**`src/web/page.js:7504`** 那行是 `同族子体（children.length 个）` ——
**它直接数了边、绕过了 `counts`**。

> **只改 `counts` 不改这里，页面上会同时存在两个互相矛盾的数字**（一个是修好的、一个是旧的）。

**① 的验收应包含这一处**：改完后，页面上**不该有任何一处**再直接数 `children.length` 当「子体数」。
若那处本意就是「关系条数」，则按裁决改标签写「关系」，并与单列的那个数保持一致。

**给整合方的动作**：合并 `dsh-axisfix` 前，先 grep `page.js` 与 `tools/asin.js` 里的
`children.length` / `childrenWithDimensions`，**逐处确认它数的是「子体」还是「关系」**；
若有遗漏，要么退回给作者，要么作为一个新任务单立起来。**不要让它带着两个矛盾的数字进 main。**

## 两条裁决的原文（供实施与复核对照）

### ① 变体计数：数「不同的子体」，不是「边」

**问题**（实测）：一个子体挂两个父体 → `children=2`、`childrenWithDimensions=2`，
而 **distinct child asins = 1**，面板印「子体 2/2 有维度」。

**裁决**：改成数**不同的子体 ASIN**。理由不是命名习惯，而是**它会让一个数字说大话**：
真实只有 1 个子体，页面说 2。`problems` 已经单独报出那条 `parent-contradiction`，
所以这个计数**不该再替它虚增**。
- 若「关系条数」本身也有用：**单列一个数、标签写「关系」** —— 两个问题、两个数。
- **分母**（`childrenWithDimensions`）也要跟着改，否则会出现「**2/1 有维度**」这种自相矛盾的印法。
- 本批**只改口径，不改矛盾检测本身**。

### ② `listSectionResults` 的静默截断：加截断信号

**问题**：`MAX_ROWS = 5000`、无截断信号。超限时会有节被丢掉 → 页面读成「未采集」，
即 **把「没测到」读成「没采集」**。

**裁决**：加截断信号（读到的行数 + 是否截断 + 实际总数），**并且所有读者必须能说出来**
「只读到前 5000 行」这类话 —— **不许在截断时给出一个看起来正常、实际错误的结论**。
- ⚠️ **测试必须真的造成截断**（上限可注入，或刚好超限的夹具）。
  **只断言 `truncated:false` 等于什么都没证。**

### ③ §3.6 文档订正

§3.6 说预检在 worktree 里**必然**报 link 漂移 `FAIL`。**近三批实测都不是这样**：
worktree 与主线工作树都只有 INFO 行、整条 exit 0（§3.20 / §3.21 均记）。
**把那句改成「视入口而定」并指向 §3.20/§3.21 的实测。只改这一处。**

## 与 `dsh-sectfix` 批次的撞车点（两处，各自分支，合并取并集）

| 文件 | axisfix | sectfix |
|---|---|---|
| `tests/run.mjs` | 注册新测试文件 | 同左（`b04-section-writer.mjs`） |
| `docs/COORDINATION.md` | §3.6 | §3.21 |

**其余文件集不相交**：sectfix 只碰 `src/sources/**`，axisfix 只碰 `src/domain/asin/**`、
`src/store/collection-section.js`、`src/web/page.js`、`src/tools/asin.js`。
**两边都不得越界。**

## 一个流程教训（主理人自己犯的）

子代理**不可用 `send_message` 寻址**（报 `active teammate "<id>" not found`）。
所以：**任务书必须一次写全，事后无法追加要求**。
本轮追加的 `page.js:7504` 因此只能落成这份文件 —— 若任务书当初把
「页面上不许再有别处直接数 `children.length`」写进去，就不需要这一趟。
