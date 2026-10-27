# F12-05 编排模式 —— 契约先行（2026-10-10）

> **本文写实现之前**。任务书 §4/§5 的验收第一条就是「契约先行（入参/出参/错误码 +
> 迁移与回滚 + 数字）」。本文件是那一份契约；实现与测试都按它写，**不是**实现完再补。

## 0. 这一批**不做什么**，先把话说清楚

需求 §F12-05 列了**四种**编排模式：

| 模式 | 本批 | 为什么 |
|---|---|---|
| **顺序**（sequential） | ✅ **做** | 角色已经在 `roles.js` 声明了 `steps: [...]` 数组，是**已有声明缺读者**。可以在**不引入 LLM**的情况下真正强制 |
| **审阅循环**（review loop，超限转人工） | ✅ **做** | 同上：上限是一个**数字**，超限转 `waiting_human` 是**状态机已支持**的迁移。不需要 LLM |
| **条件分支**（branch） | ❌ **不做** | 分支条件是「评分 < 3.8」「站点非 authoritative」——**评分从哪来**？本插件没有 LLM 通道，`scores` 无产生者。**做了就是把缺失渲染成真实值** |
| **并行**（parallel + 合并检查） | ❌ **不做** | 真正的并行要求「多个子步骤同时 running 且各自可中断/可恢复」，而 `agent_step` 是 `UNIQUE(run_id, seq)` upsert、**同一 seq 只能有一行**，且没有取消/恢复出口。改成「允许跳号」只是把串行伪装成并行 |

**这不是缩水，是分界**：本批交付的两种模式**都能被真证伪**（把强制去掉必须变红）；
不做的两种，做了**无法验证**——而本仓刚为「1132 条绿断言掩盖假阴性」付过代价。

⚠️ **给下一个读者的判据**：如果你要补「条件分支」，先回答
**「分支条件里那个数字是谁算的、他在哪张表里」**。答不上来就不要做。

---

## 1. 编排队列（`orchestration`）的入参

新增纯函数模块 `src/domain/agent/orchestration.js`（**不碰表、不碰 store**）。

```js
/**
 * @param {{ role: string, steps: string[] }} role   角色的步骤契约（来自 AGENT_ROLES）
 * @param {{ seq: number, step: string, status: string }[]} recorded  已记录的步骤
 * @param {{ reviewLimit?: number }} options
 * @returns {{
 *   mode: 'sequential' | 'review-loop',
 *   expected: string[],          // 契约声明的步骤名，按顺序
 *   done: string[],              // 已 passed 的
 *   next: string | null,         // 下一个该做的；全部做完则 null
 *   outOfContract: string[],     // 记录里**不在** expected 中的步骤名（按 seq 排）
 *   misordered: boolean,         // 是否出现过「先做了后面的步骤」
 *   reviewCount: number,         // 「审阅」动作已发生的次数
 *   reviewLimit: number,
 *   verdict: 'ok' | 'done' | 'out-of-contract' | 'out-of-order' | 'review-exhausted',
 *   reason: string               // 一句话，**必须说清是哪一条判据**（不是「状态不对」）
 * }}
 */
export function planNextStep(role, recorded, options = {}) { … }
```

### 判据（逐条，测试要逐条钉）

| verdict | 触发条件 | 下一步该做什么 |
|---|---|---|
| `done` | `expected` 里每一条都 `passed` | 收尾（`amzn_agent_run_finish`） |
| `out-of-order` | 出现一个 `passed` 的步骤，而它**前面**还有没 passed 的契约步骤 | 先补前面那条 |
| `out-of-contract` | 记录里的步骤名**不等于** `expected` 中任何一条 | 名字写错了，或该角色不负责这一步 |
| `review-exhausted` | 审阅次数 `>= reviewLimit` | **转人工**（`waiting_human`），不再自动重试 |
| `ok` | 以上都不是 | 做 `next` 那一条 |

**优先级**（有先后，测试要证明）：
`out-of-contract` **先于** `out-of-order` —— 名字都不在契约里时，
「顺序对不对」这个问题**无意义**，不能报一个自己都算不出来的判词。

### 数字（不许含糊）

- `reviewLimit` 默认 **3**。它是「同一契约步骤被重复 `running` 的上限」，**不是**「总步骤数上限」。
- `reviewCount` 的口径：**同一 `step` 名出现次数 − 1**（第一次不算重试）。
  ⚠️ 这与 `agent_step` 的 `UNIQUE(run_id, seq)` 有关：同一个 `seq` 反复 upsert **不增加行数**，
  所以 `reviewCount` **只能从「不同 seq 上出现同名 step」算**，或从传入的 `recorded` 数组算。
  **本函数是纯函数，只从 `recorded` 算** —— 这一点必须在测试里钉住，
  否则下一个人会以为它读库。

---

## 2. 工具出口

**不新增工具**（避免与 `wb-b113` 的 4 个新工具在同一处 `TOOLS` 上撞车）。
改为把判词**接进已有的两个写工具**：

- `amzn_agent_run_step`：写入前用 `planNextStep` 算判词；
  - `out-of-contract` → **拒绝**，`{ok:false, error, hint}`，错误里**点名**那个步骤名与契约允许的名字
  - `out-of-order` → **拒绝**，错误里点名「该先做的是 X」
  - `ok` / `done` → 正常写入
- `amzn_agent_run_finish`：`verdict !== 'done'` 时**警告但仍可收尾**（收尾是人的决定），
  输出里必须写出「还有哪几条契约步骤没 passed」。

⚠️ **必须是 `{ok:false, error, hint}`**：判词只回一句话会被审计漏斗与遥测同时记成成功
（见 `COORDINATION.md` §3.25 与 `src/tools/index.js:428` / `:400`）。

## 3. 迁移与回滚

**本批不新增表、不新增列、不改 schema** —— `verdict` 是**算出来的**，不是存下来的。

理由（这一条要写进代码注释）：判词是**运行状态的函数**，存下来就会有两个来源，
而本仓「两个常量活在不同文件」已经付过代价（B-06.1）。**算得出来的不要存。**

→ 因此**无迁移、无回滚**。这也让本批**不被 `wb-b113` 的 v38 阻塞**。

## 4. 页面

agent 页签的运行详情里，在每个运行下面加一行**下一步**（复用下发的判词，**不重算**）：
`下一步：interpret-quality（第 2/3 步）` / `⚠️ 契约外步骤：xxx` / `⚠️ 审阅已达上限 3，转人工`。

**不新开页签**（页面文件是热文件，且任务书说 agent 区）。

---

## 5. 验收（与任务书 §4 逐条对应）

1. **契约先行** ← 本文件。
2. **实现** ← `orchestration.js` + 两个工具的接入 + 页面一行。
3. **全量绿且断言只增不减** ← 新测试 `tests/f1205-orchestration.mjs`，**不改任何既有断言**。
4. **五态/缺失分开说** ← `verdict` 有 5 个值，且 `reason` 必须点名判据；
   **「没有步骤记录」不得渲染成「已完成」** —— 这是本批最像缺陷的写法，要有独立断言。
5. **至少一次真证伪** ← 把 `out-of-contract` 的拒绝去掉 → 必须变红 → 改回，**贴原文**。
