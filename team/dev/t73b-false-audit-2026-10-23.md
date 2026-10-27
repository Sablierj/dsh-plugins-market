# T73b 假审计修复 —— `pageWrite` 的 skip 与 5 个条件写描述符（dev-7）

> **树标识**：`amazon-ops` @ git HEAD `c11909b`，工作树有未提交改动（多支笔并行）。本报告定稿快照的 SHA-256 前 16 位：
>
> | 文件 | SHA-256（前 16 位） |
> |---|---|
> | `src/web/routes.js`（含 `pageWrite` 改动） | `4467987ff5ab8ad3` |
> | `src/domain/audit/targets.js`（含 5 个 skip） | `82fd933b3b5ac0b9` |
> | `src/domain/states.js`（T73 的 `review_analysis_run`，本批未再改） | `cec0e2e1c3e624ac` |
> | `tests/t73b-false-audit.mjs` | `633cc81b1926352a` |
>
> 口径：只跑定向 `node tests/t73b-false-audit.mjs` 与 `node tests/t73-audit-inventory.mjs`，**没有跑全量 `tests/run.mjs`**；不把未执行的套件写成通过。

## 一、结论

1. **修了 6 处**：`pageWrite` **1 处**（读 `target.skip?.(body, result)`，为真不落审计行）；`src/domain/audit/targets.js` **5 个描述符**补 `skip`（`amzn_optimize_validate` / `amzn_optimize_prepare` / `amzn_kw_import` / `amzn_product_line_upsert` / `amzn_rule_import`）。
2. **新建 `tests/t73b-false-audit.mjs`**：**8 条检查 / 28 个 `equal` 断言**（无 `deepEqual`），修复后 **8 checks, 0 failed**。
3. **先红后绿**：把 5 个描述符的 `skip` 在运行时删掉、把 `product-open-dir` 的 `skip` 置空（模拟旧行为，不动文件）后跑同一套测试 → **8 checks, 5 failed**（①②④⑤⑦ 红，③⑥⑧ 绿）；恢复后 **8 checks, 0 failed**。③⑥⑧ 绿是设计：它们是反面/正常写对照，旧行为下本来就该绿。
4. **T73 回归**：`node tests/t73-audit-inventory.mjs` 仍 **10 checks, 0 failed**；本批的 5 个 skip 与 `pageWrite` 改动没有动 `AUDIT_OBJECT_TYPES` / `WRITE_TARGETS` 的键集合。
5. **写域**：只改了 `src/web/routes.js`、`src/domain/audit/targets.js`，新建 `tests/t73b-false-audit.mjs`；**未触碰** `src/domain/prompts/**`、`src/web/pages/**`、`src/store/schema.js`、`tests/run.mjs`。

## 二、依据：两条假审计的形状

### 2.1 `pageWrite` 不读 `target.skip`

`src/web/routes.js` 的 `pageWrite`（改动前）只判 `result.ok === false`，然后直接 `recordAudit`：

```js
return (result) => {
  if (result !== undefined && result !== null && result.ok === false) return
  try { recordAudit(store, { action: target.action, … }) } catch { … }
}
```

`PAGE_WRITE_TARGETS['product-open-dir']` 的注释说「打开目录：不是数据库写入，不记审计」，并写了 `skip: () => true`；`routes.js` 的 `product-open-dir` 分支确实调用了 `done({ ok: true })`。于是**打开一个文件夹**会被记成一次 `product_dir.open` 写操作——这就是假账。工具漏斗是读 `skip` 的（`src/tools/index.js:553`），两个漏斗在这里不一致。

### 2.2 5 个工具的条件写没有 `skip`

| 工具 | 代码里真正的写入分支 | 没写时的返回值 | 缺 skip 的后果 |
|---|---|---|---|
| `amzn_optimize_validate` | `if (args?.persist === true)` 才落草案；里面 `run === null` 还提前返回「没有 runId，无法落库」 | 渲染文本（成功形状） | 每次试校验 / 无 runId 的 persist 都留一条 `optimization_draft.validate` |
| `amzn_optimize_prepare` | `if (args?.dryRun !== true)` 才建 run | 渲染文本（成功形状） | dryRun 留一条 `optimization_run.create` |
| `amzn_kw_import` | `dryRun: args?.dryRun === true` 传给 import 函数，true 时不写 | 渲染文本（成功形状） | dryRun 留一条 `kw_import.create` |
| `amzn_product_line_upsert` | `const dryRun = args?.dryRun === true`；`if (!dryRun ...)` 才写 | 渲染文本（成功形状） | dryRun 留一条 `product_line.update` |
| `amzn_rule_import` | `const dryRun = args?.dryRun !== false`（**默认 true**） | 渲染文本（成功形状） | 默认调用（预览）就留一条 `rule.import` |

**为什么这比「少记一条」更严重**：审计日志的全部价值是「读到一行 = 那件事发生过」。一条关于没发生的写的记录，会让读日志的人把「打开文件夹」当成「改过设置」、把「预览」当成「发布」——这是「记录说谎」，不是「记录不全」。六条铁律第 4 条「未执行不写成通过」正是这一条。

## 三、改动

### 3.1 `src/web/routes.js` — `pageWrite` 读 `skip`

在 `result.ok === false` 判断之后、`recordAudit` 之前加：

```js
let skipped = false
try {
  skipped = target.skip?.(body, result) === true
} catch (error) {
  workbench.record('audit:error', { route: `api:${route}`, error: `skip: ${error.message}` })
}
if (skipped) {
  workbench.record('audit:skip', { route: `api:${route}`, reason: 'skip' })
  return
}
```

三点口径：
- **参数是 `(body, result)`**：skip 可以依赖请求（`dryRun`）或这次路由实际返回的结果；现有 4 个页面 skip 只用 body，未来可以用 result。
- **skip 抛错不吞审计行**：写已经发生，skip 谓词自己坏了不能把行弄丢；错误进 `audit:error` 活动流，然后照常 `recordAudit`。
- **`audit:skip` 是活动流，不是审计行**：它和工具漏斗的 `audit:skip` 同一个做法，让「这次为什么没记」可见，而不是静默。

### 3.2 `src/domain/audit/targets.js` — 5 个 `skip`

| 工具 | 加的 `skip` | 依据（代码里已有的分支） |
|---|---|---|
| `amzn_optimize_validate` | `a => a?.persist !== true \|\| String(a?.runId ?? '').trim() === ''` | `tools/optimize.js`：`if (args?.persist === true)` 才落；里面 `run === null` 提前返回「无法落库」 |
| `amzn_optimize_prepare` | `a => a?.dryRun === true` | `tools/optimize.js`：`if (args?.dryRun !== true)` 才建 run |
| `amzn_kw_import` | `a => a?.dryRun === true` | `tools/kw.js`：`dryRun: args?.dryRun === true` 传给 import |
| `amzn_product_line_upsert` | `a => a?.dryRun === true` | `tools/product-line.js`：`if (!dryRun ...)` 才写 |
| `amzn_rule_import` | `a => a?.dryRun !== false` | `tools/rule.js`：`const dryRun = args?.dryRun !== false`，默认 true |

每个描述符都带一行注释说明「为什么这个参数下不写」，不是只写一个 `skip: () => true`。

### 3.3 `tests/t73b-false-audit.mjs`

8 条检查：
- ① `product-open-dir` 走真实路由：200 + 假 `explorer.exe` 被调用 1 次 + `product_dir.open` 审计行 0 条（`withFakeExplorer` 用 `syncBuiltinESMExports()` 让已导入的 `routes.js` 看到替身；不会真的弹资源管理器）。
- ② `amzn_optimize_validate`：`persist:false` 不落行；`persist:true` 但无 `runId`（返回「无法落库」）也不落行。
- ③ `amzn_optimize_validate`：`persist:true` 且有真 runId → 落 1 行，`object_id = runId`（反面控制）。
- ④ `amzn_kw_import`：`dryRun:true` → 0 行，返回文本含 `dryRun`。
- ⑤ `amzn_rule_import`：**省略 `dryRun`**（默认 true）→ 0 行，返回文本含「预览」。
- ⑥ `amzn_setting_set`：正常写 → 1 行，`before` / `after` 都在且不同（防止「全都不记账」）。
- ⑦ 5 个描述符的 `skip` 谓词逐条两边断言（true 情形 + false 情形），并断言 `product-open-dir.skip` 是函数且返回 true。
- ⑧ 页面漏斗的另一面：`setting-set` 走真实页面路由 → 200 且落 1 行，`before` / `after` 都在且不同（证明 `pageWrite` 不是被 skip 改成「全都不记」）。

## 四、验证

### 4.1 T73b 结果（先红后绿）

- **模拟旧行为**（运行时删除 5 个 `skip`、把 `product-open-dir.skip` 置 `undefined`，不改文件）：
  `8 checks, 5 failed` — ① `product-open-dir` 留行、② `validate persist:false` 留行、④ `kw_import dryRun` 留行、⑤ `rule_import` 预览留行、⑦ 描述符无 `skip`；③⑥⑧ 绿（它们本来就该在旧行为下绿，是反面/正常写对照）。
- **修复后**：`node tests/t73b-false-audit.mjs` → `8 checks, 0 failed`，exit 0。
- **断言数**：8 条检查 / **28 个 `equal` 断言**；另有若干非空/前置守卫（200 状态、explorer 调用次数、返回文本形状、before/after 非空且不同），防止「空集合恒绿」。

### 4.2 T73 回归

`node tests/t73-audit-inventory.mjs` → **10 checks, 0 failed**。本批没有改 `AUDIT_OBJECT_TYPES`、没有改 `WRITE_TARGETS` / `PAGE_WRITE_TARGETS` 的键集合，所以 142 工具 / 86 路由 / 0 漏登记 / 0 类型不被接受不变。

### 4.3 未执行 / 未覆盖（不写成通过）

- **没有跑全量 `tests/run.mjs`**；`s1b12-audit.mjs` 的「每个写路由调用 pageWrite / 只读路由不调用」静态守卫本轮**未执行**。我用 T73b 的 ① 与 ⑥ 分别覆盖了「skip 真时不记」与「正常写仍记」，但没有替 s1b12 宣称全绿。
- **没有跑真实页面点击**：① 是真实路由 handler + 假 `explorer.exe`，不是浏览器端到端；`product-open-dir` 的页面按钮链路需要 lead 在接线后点一次确认。
- **E1–E5 的 `skip` 行为**只对 `optimize_validate` / `kw_import` / `rule_import` 做了行为断言；`optimize_prepare` / `product_line_upsert` 只有 ⑦ 的描述符谓词断言，没有跑它们的 dryRun 行为。这是本轮测试的已知空白，不是「已验证」。

## 五、口径、风险与接线

### 5.1 哪些 skip 判据是「业务语义定的」，哪些是「代码已有约定」

**5 个全是代码已有约定，没有一条是我按业务语义新定的**：
- `amzn_optimize_validate` 的 `persist !== true` / 无 `runId`：`tools/optimize.js` 的 `if (args?.persist === true)` 与 `run === null` 提前返回。
- `amzn_optimize_prepare` 的 `dryRun === true`：`if (args?.dryRun !== true)` 才建 run。
- `amzn_kw_import` 的 `dryRun === true`：`tools/kw.js` 的 `dryRun: args?.dryRun === true`。
- `amzn_product_line_upsert` 的 `dryRun === true`：`if (!dryRun ...)` 才写。
- `amzn_rule_import` 的 `dryRun !== false`：`const dryRun = args?.dryRun !== false`，默认 true。

唯一算「判断」的是 `product-open-dir` 的 `skip: () => true`——但它在 `PAGE_WRITE_TARGETS` 里**早就存在**，本批只是让 `pageWrite` 执行它，不是新造一条规则。

### 5.2 风险

- **两个漏斗的 `skip` 签名不同**：工具是 `skip(args)`，页面是 `skip(body, result)`。这是有意的（页面有 result 可用），但未来写新的页面 skip 时要记得第二个参数；描述符按表分属两个漏斗，不会混用。
- **渲染文本的失败形状**：本批只修了「明确不写」的条件；如果某个工具在失败时返回一段渲染文本而不是 `{ok:false}`，漏斗仍可能记一条假审计。这是本批之外的更大问题，未在本轮处理，也未写成已修。
- **`amzn_optimize_validate` 的 `persist:true` + 无 `runId`**：我把这个分支也纳入 skip（工具只提示「无法落库」、一行不写）；如果 lead 认为这属于「业务语义」而不是代码约定，可以回退到只按 `persist !== true` 判，但那样会留下一条已知假审计。
- **`product-open-dir` 仍调用 `pageWrite`**：现在 `skip` 让它返回 no-op recorder，`done({ok:true})` 是空操作；没有删调用，避免改路由控制流。若以后 `skip` 被删，假审计会回来——T73b ① 会红。

### 5.3 给 lead 的接线（`tests/run.mjs` 由 lead 统一改）

```js
import { runT73bFalseAuditTests } from './t73b-false-audit.mjs'
// …
await runT73bFalseAuditTests({ check, checkAsync, equal, deepEqual, throws, section })
```

T73b 也可以独立跑：`node tests/t73b-false-audit.mjs`（已在本轮执行，exit 0）。

### 5.4 后续（按 lead 的优先顺序）

policy 路由的两点小改（`policy-candidate-confirm` 的 `objectId` 用 `policyId`；`policy-check-start` / `policy-candidate-reject` 的注释写明 objectId 是 run/candidate）**按 lead 指示先不做**，等本批假审计修完再回头。T73-AUDIT-2（`review-analysis-run` 的 `objectId` 用 `runId`）同理。
