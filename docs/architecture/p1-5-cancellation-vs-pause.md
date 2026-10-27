# P1-5 长任务可中断：核实结论

> **结论：`取消`已经完整存在并实测通过；`暂停/继续`在当前架构下不成立，
> 我没有做假按钮。下面写清为什么，以及真要做得多大代价。**

## 1. 取消（cancelled）—— 已存在，实测通过

不是"写在文档里"，是真跑出来的（2026-10-20，脚本 `probe-cancel.mjs`）：

```
取消 queued 任务 → {"ok":true,"status":"cancelled",
                    "note":"已取消（任务处于 queued，未在运行）",
                    "keptSections":0,
                    "text":"任务 …：已取消\n保留已采节 0 行（取消前 0 行，一行都没删）。"}
库里的状态 = cancelled

取消 done 任务 → {"ok":false,"code":"NOT_CANCELLABLE",
                  "error":"task … is done, nothing to cancel","status":"done"}
那条的状态仍然是 = done
```

实现是完整的，四个要素都在：

| 要素 | 位置 |
|---|---|
| `AbortController` 真的能中断在途请求 | `sources/collection.js:583` `signal: controller.signal` |
| 状态机守卫（不是谁都能取消） | `canTransitionCollectionTask(status, 'cancelled')`，终态拒收码 `NOT_CANCELLABLE` |
| **保留已采数据** | 返回值带 `keptSections` / `keptSnapshots`，文案明说"一行都没删" |
| 队列中被取消的任务不会启动 | `collection.js:328`「A task cancelled while queued has already been marked; skip it」 |

入口：工具 `amzn_collect_cancel`、路由层（`NOT_CANCELLABLE` → HTTP 409）。

## 2. 暂停 / 继续 —— 为什么不做

### 架构上的硬事实

采集任务的执行体是一次**整块的 await**：

```js
const result = await browserGate.run(() => adapter.collect({ targets, fields, options }))
```

`targets` 一次性交给浏览器适配器，**中间没有任何逐目标的持久化断点**。
「暂停」要成立，必须能在两个目标之间挂起、把"做到第几个"落盘、下次从那里接着做。
现在这三个条件一个都不满足：

1. 适配器内部循环不暴露进度回调；
2. 进度只在 `progress_json` 里粗粒度更新（`done/total`），不构成可恢复的游标；
3. 没有 `paused` 这个任务状态 —— `COLLECTION_TASK_STATUSES` 里没有它
   （`paused` 只存在于**关键词生命周期**的状态机，是另一回事）。

### 真要做，代价是什么

把一个 `await` 批处理改成可恢复状态机：

- 浏览器适配器要支持「从第 N 个目标开始」——意味着拆开 `adapter.collect`，
  并把每步的上下文（当前 tab、滚动位置、已读节）都变成可序列化状态，或者接受
  **每次续跑重开页面**（那"暂停"就退化成"取消后重建"）；
- 任务行要加游标列（迁移），状态机要加 `paused` 及其合法迁移边；
- `browserGate` 的语义要改（它现在是"一整个任务占用一个浏览器"，
  暂停的任务要不要放开 gate 给别人用？放开就意味着暂停期间别人能开浏览器，
  续跑时可能排在被后面）；
- 冷却/等待窗口与暂停的交互（一个"暂停了 3 天"的任务，冷却早过期，续跑该不该重新体检）。

**这不是加个按钮，是改执行模型。** 在没有明确需求说"必须要暂停"之前做，
就是为一个没被验证的需求重构最危险的那块代码。

### 如果我判断错了

如果有人确实需要「稍后再采集」，现在有两条已经能用的路，效果接近且成本为零：

1. **取消 + 重新提交** —— 取消保留已采数据，重新提交会走「复用新鲜快照」逻辑
   （`reused_snapshots_json`），不会白跑；
2. **采集计划**（`collection_plan`）—— 有运行窗口、频率、失败策略，
   本来就是为"定时跑"设计的。

## 3. 所以 P1-5 的交付是什么

- **取消**：不需要我做什么，它已经是对的。我做的是**核实并在真机上验证**，
  而不是照任务清单再实现一遍（那会变成重复劳动）。
- **暂停/继续**：**明确不做**，理由如上。如果需求方要，我会先按上面那段代价清单
  给出一个分阶段方案（先做"取消+重提"的体验优化，再看是否值得改执行模型），
  而不是先写代码。

## 4. 顺带发现的两件事（值得单独提）

1. **`paused` 这个词在本仓指两个完全不同的东西**：关键词生命周期里的「暂停」状态
   （`domain/states.js`），和没人实现的「任务暂停」。搜索 `paused` 时容易看错对象 ——
   我第一次就以为任务状态机里有 `paused`。
2. `reused_snapshots_json` 这个列存在，说明「复用新鲜快照、不重复采集」本来就是设计内的事，
   所以"取消后重提"的代价比想象中小。
