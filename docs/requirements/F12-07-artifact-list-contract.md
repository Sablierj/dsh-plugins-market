# F12-07 产物独立列表视图 —— 契约

> 批次：**B-12.11**（模块 12，WorkBuddy 属区）
> 依据：`docs/requirements/RESEARCH-module-alignment-v2.0.md:325`（F12-07 行）缺口栏第 4 句
> 基线：`wb-b127` @ `3441dcd`（代码 tip `a69158a`）；schema **v45**；工具数 **133**
> 分支：`wb-b127`（继续用同一 worktree）

---

## §0 这一批要解决什么，以及**不**解决什么

### §0.1 需求原文

`RESEARCH-module-alignment-v2.0.md:325`（F12-07）的缺口栏，逐字：

> 规格里的「输入快照」不在产物行上（agent_artifact 无 input 列，只能靠 step_seq 指到步骤的
> input_json）；「审批引用关系」只有一个 gate-decision 产物按 object_id 关联（run.js:111-120），
> 产物行没有指向审批的字段；产物状态只能在写入时给定，页面没有接受/驳回入口；
> **「产物列表」是运行详情里的内嵌表，没有独立列表视图。**

**四句话里，前三句已经过期，只有第四句仍然成立。** 逐句核对（全部实测）：

| 原文 | 现状 | 判据 |
|---|---|---|
| 「输入快照」不在产物行上 | **已解决，且是有意这样解决的** | B-12.10 加了「输入快照」**列**（`page.js:5419` `inputSnapshotCell`），值由 `step_seq` 水合。审计描述的 `agent_artifact` 无 `input` 列**依然属实**，但那不是缺口 —— 输入快照本来就在 `agent_step.input_json` 上，产物行不该存第二份 |
| 产物行没有指向审批的字段 | **有意不加** | `schema.js:1969-1972` 明说裁决复用 `agent_artifact`、靠 `object_id` 关联。给产物加一列指向审批 = 一句事实存两份 |
| 页面没有接受/驳回入口 | **已解决** | B-12.10 前已有：`page.js:5478` `decideCell`（`status === 'draft'` 才画按钮）+ POST `/api/agent-artifact`（`routes.js:1010`）+ 工具 `amzn_agent_artifact_decide`（`tools/agent.js:753`） |
| **「产物列表」没有独立列表视图** | **仍然成立 ← 本批的目标** | `artifactBlock`（`page.js:5456`）唯一调用点是 `page.js:5078`，在 `renderAgent()` 内、画进 `#agrun`（选中运行的详情块）。**跨运行入口：零** |

### §0.2 ⚠️ 本批最容易犯的错：把 `listArtifacts` 加回来

`src/store/agent.js:798-813` 逐字留着一段**禁令**（原文）：

> `/* F12-05 顺手裁决：这里原本有一个 `listArtifacts(store, runId)`，
>    整个函数体是 `return getRun(store, runId)?.artifacts ?? []`。
>    它**已删除**，理由是它不只是重复，而且是**有害**的重复：
>
>    - 库层每一个别的 `list*`（`listRuns`、`listArtifacts` 的邻居们）都自己跑一条 SQL。
>      `listArtifacts` 是唯一的例外 —— 它不查库，只是把 `getRun` 已经给出的字段再暴露一次。
>      消费方的既定写法就是 `getRun(...).artifacts`：`page.js:4111-4150` 读
>      `detail.artifacts` 读了四处，`getArtifact`（本文件 :328）与 :374 也都这么写。
>    - 那 `?? []` 兜底把「**没有这次运行**」与「**这次运行没有产物**」折叠成同一个答案。
>      调用方拿到 `[]` 无从分辨：运行不存在，还是运行存在但那一步真的一条产物都没有。
>      这正是本仓的招牌缺陷形状 —— **把缺失渲染成真实值**（「没读到 ≠ 确实没有」）。
>      要区分就得再查一次 `getRun`，那还不如一开始就用 `getRun`。
>
>    ⚠️ **不要再把它加回来。** 需要某次运行的产物就用 `getRun(store, id)?.artifacts ?? []` ——
>    在调用点写 `?? []` 时，你**看得见**自己在把 null 折叠成空数组；封进一个库函数里就看不见了。
>    `ARTIFACT_STATUSES` 保留：它有读者（校验产物状态的调用方），与这个只做转发的函数不同。 */`

**本批的新函数必须与那条被禁的函数在语义上不同**，否则就是绕过禁令。判据：

| | 被禁的 `listArtifacts(store, runId)` | 本批的 `listAllArtifacts(store, filters)` |
|---|---|---|
| 入参 | 一个 runId | **跨运行**筛选（type / status / objectType / runId / limit） |
| 是否查库 | **不查**，转发 `getRun().artifacts` | **自己跑 SQL**（与 `listRuns`/`listReports` 的邻居们同形） |
| 返回 | `[]`（把「没有」折叠掉） | `{ rows, total, limit }`，**`total` 不带 where** ⇒ 「库内共 N 条」可分辨 |
| 名字 | `listArtifacts` | **`listAllArtifacts`** —— 起名就避开被禁的那个 |

⚠️ **名字里必须有区分**。叫回 `listArtifacts` 会让下一个人以为禁令被撤销了。

### §0.3 实测：真库里产物表是 0 行

只读查 `data/amazon-ops.db`（`data/` 被 gitignore）：

```
agent_artifact  count(*)          → [{"n":0}]
agent_artifact  count(distinct run_id) → [{"n":0}]
agent_artifact  group by type,status   → []
对照：agent_run = 0 / report = 0 / competitor_set = 0 / prompt = 44
```

**这一条决定了本批的重心**：真机上打开这个视图，**必然进空态分支**。所以：

- 空态文案**不是可选项**，它是这条功能唯一会被真人看到的分支；
- 空态必须分开说清**两种零**，因为两种零对应的动作完全不同：

| 情形 | 判据 | 该说的话 |
|---|---|---|
| A：一次运行都没跑过 | `agent_run` = 0 | 「还没有跑过任何一次运行」+ 指路去会话里 `amzn_agent_run_start` |
| B：跑过但没有产物 | `agent_run` > 0 且产物筛选后为 0 | 「跑过 N 次运行，但这 N 次没有产出任何产物」—— 这是**插件/Agent 没产东西**，与 A 不是一件事 |
| C：筛没了 | 产物库 > 0 但当前筛选为 0 | 「这个筛选条件下没有」+ 「库内共 N 条」（照 `page.js:4954-4958`） |

---

## §1 交付 D1：`listAllArtifacts(store, filters)`

落点 `src/store/agent.js`（放在 `ARTIFACT_STATUSES` 附近，**不要**放回被禁函数原来的位置）。

形状**逐条照抄** `src/store/reports.js:202-229` 的 `listReports`：

```js
export function listAllArtifacts(store, { type = null, status = null, objectType = null,
                                          runId = null, limit = 100 } = {}) {
  const where = []
  const params = []
  if (type !== null && type !== '') { where.push('type = ?'); params.push(String(type)) }
  if (status !== null && status !== '') { where.push('status = ?'); params.push(String(status)) }
  if (objectType !== null && objectType !== '') { where.push('object_type = ?'); params.push(String(objectType)) }
  if (runId !== null && runId !== '') { where.push('run_id = ?'); params.push(String(runId)) }

  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500)
  const rows = store.all(
    `SELECT * FROM agent_artifact
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [...params, cap],
  )
  return {
    rows: rows.map(hydrateArtifact),
    /* ⚠️ 不带 where —— 这是「库内共 N 条」那句话的唯一来源，也是筛空与库空的判据。 */
    total: Number(store.get('SELECT COUNT(*) AS n FROM agent_artifact')?.n ?? 0),
    limit: cap,
  }
}
```

硬要求：
- **`total` 必须不带 `where`** —— 抄 `reports.js:226`。它同时是「库内共 N 条」的来源和 C 类空态的判据。
- 需要 `hydrateArtifact`（把 `body_json` 解出来）。**先查有没有现成的**：`getRun`（`:164`）与 `getArtifact`（`:708`）都在做行映射，**抽出来共用一个**，不要再写第三份。找不到就抽，别复制。
- `cap` 上限取 **500**（`listReports` 是 1000，产物行比报告重，取小一档）。

## §2 交付 D2：`agentState` 加 `artifacts` 切片

落点 `src/web/routes.js` 的 `agentState`（`:3988-4038`）。

- 照 `reportState`（`:3014-3051`）接 `filters.artifactType` / `filters.artifactStatus` / `filters.artifactObjectType`。
- 切片形状带四个键：`rows` / `total` / `limit` / `filters`（回填控件用）。
- **⚠️ 不能加新 HTTP 路由**。页面数据全走 `route === 'state'`（`routes.js:511`）一次下发；加 GET 路由是背离本仓形状。
- **⚠️ `agent_run` 的总数要一起下发**，空态 A/B 的分辨靠它。`listRuns` 返回的是 `{rows,total,limit}` 形状吗？**去量**，不是就取 `total`。
  注意：`listRuns` 的 `rows` 有 `limit 20`，别拿 `rows.length` 当总次数。

## §3 交付 D3：页面「产物」section

落点 `src/web/page.js` 模块 12 面板（`:1044-1059`）。

- 在 `#agrun` 与「角色」`rule-sect` 之间插一个 section：一条 `<div class="rule-sect">` 标题 + 筛选 bar + `#agartifacts` 容器。
- **⚠️ 不要动 `MODULE_GROUPS`**（`src/state/workbench.js:34`，模块 12 条目在 `:83-85`）。`workbench.js:77-82` 的注释明说「这一组现在只有一个模块，这是诚实的现状」；一个模块 id 同时是 `set()`/`buildState()` 的键，加 nav 条目要连带改 store 分片 —— **收益是零**（产物属于模块 12，不是新模块）。加**面板内 section** 是正解，先例：`page.js:1015-1017` 的 `#sect-observation`/`#sect-rollback`。
- 筛选控件照抄报告专区（`page.js:1019-1043`）：类型下拉 + 状态下拉 + 清除按钮。**不要**搜索框（产物没有可搜的文本字段）。
- 渲染函数照 `renderReports`（`:4931-4987`）：
  - 表格列建议：**时间 / 类型 / 对象 / 版本 / 状态 / 运行 / 输入快照 / 人工裁决**（复用 `inputSnapshotCell` `:5419` 与 `decideCell` `:5478` —— **别重写**，那两处是 B-12.10 刚做完的）。
  - 尾部一行「显示 N / total 条（已筛选）」，照 `:4984-4986`。
  - 空态照 `:4954-4958` 的写法，但**要三态**（§0.3 的表）。
- 筛选值走 `patchContext`，照 `:12288-12293`；回填照 `:4935-4938`。

## §4 交付 D4：这次运行的行要能定位过去

列表里每一行都属于**某一次运行**。运行列表在 `#agruns`（`:5078` 上游）。

- 每行给一个指向该运行的入口（至少显示完整 run id 可选中/复制），否则从产物列表点不动，等于又造了一个「有出口没闭环」。
- ⚠️ **`dsh://` 或任何「回到会话」的说法一律禁止**（本仓页面没有桥，B-12.10 已校准过三处）。要会话就照 `runCopyBlock`（`page.js:4962`）的写法：**复制 id 去问**。

## §5 硬约束（不许破）

1. **不许删或改写既有断言换绿灯**；断言只增不减；**不要钉绝对数字**（工具数、schema 版本号）。
2. **`page.js` 是单个模板字面量**（`:252` 到 `:11394`）—— **该区间内的注释里不许出现反引号**，会提前闭合模板（B-12.10 踩过）。反引号基线用 `grep -o '\`' src/web/page.js | wc -l` 量。
3. **不许用 PowerShell 的 `Set-Content`/`-replace` 改含中文的文件**（会加 BOM 破坏 UTF-8）。用 Edit 工具或 python `io.open(..., encoding='utf-8', newline='')`。
4. 提交信息用 `Write` 写文件 + `git commit -F`（中文提交信息别用 `-m`）。
5. **不动别的模块的区**：`src/sources/**`、`src/domain/collect/**`、`src/domain/asin/**`、`src/domain/optimize/**`、`src/tools/asin*.js`、`src/tools/b05-*`、`tests/b05-*`、`tests/b13b-*`、`src/domain/observe/**`。
6. **不加迁移**。表已有所需每一列（`type`/`status`/`object_type`/`object_id`/`run_id`/`created_at`/`version`/`parent_id`）。给 0 行表加索引/加列是无根据的改动 ⇒ **schema 停在 v45**。
7. **不加工具**。列表是纯读；接受/驳回已有 `amzn_agent_artifact_decide`。加第二条写路径会违反「页面与会话对同一条草案只能有一个答案」。

## §6 验收判据

可证伪的断言（写进 `tests/b12-11-artifact-list.mjs`），每条都要能被一个具体的错法弄红：

| # | 断言 | 怎么弄红 |
|---|---|---|
| ① | `listAllArtifacts` 的 `total` **不带 where** —— 造 2 条产物 + 用一个筛不到的条件查，`rows.length === 0` 而 `total === 2` | 把 `total` 改成带 where → 红 |
| ② | 跨运行筛选真能跨运行 —— 两个 run 各存产物，按 `runId` 筛出 1 条、不筛出 2 条 | 把 `runId` 条件删掉 → 红 |
| ③ | `type`/`status`/`objectType` 三个筛选各自生效（逐个单测） | 改成 no-op → 红 |
| ④ | **禁令没有被绕过**：`store/agent.js` 里**不存在**导出的 `listArtifacts`（只存在 `listAllArtifacts`） | 把被禁的名字加回来 → 红 |
| ⑤ | **空态三态可分辨**：从渲染产物里抠出文案，断言 `agent_run = 0` 与 `agent_run > 0 且产物 0` **两种情形给出不同的话** | 把两种零写成同一句 → 红 |
| ⑥ | 空态文案**不含**「跳转/回到会话/带回会话」反模式 | 加回去 → 红 |
| ⑦ | 渲染产物里的**数字**与直查库相等（B-12.10 立的规矩：从渲染产物抠数字与直查库比对） | — |
| ⑧ | 筛选控件回填：给了 `filters.artifactType`，渲染出的 `<select>` 里那一项是 selected | 不回填 → 红 |

⚠️ **⑤ 是本批最重要的一条**，因为真库是 0 行 —— 它是唯一会被真人看到的分支。**必须证明它可证伪**（真把两种零合成一句，看到红），不是只写个断言。

## §7 交付顺序

1. D1 `listAllArtifacts` + `hydrateArtifact` 抽取
2. D2 `agentState` 切片（含 `agent_run` 总数）
3. D3 页面 section + 渲染 + 三态空态
4. D4 行的运行入口
5. 测试 `tests/b12-11-artifact-list.mjs`（8 条）+ 注册进 `tests/run.mjs`
6. 全量（⚠️ 跑之前确认工作树干净；`run.mjs` 是写者，跑完别改仓库）
7. 门禁三连（`check-page` / `check-migrations` / Host 检查器 —— **Host 那行必须 `N > 0`**）
8. 交接条 `COORDINATION.md` §3.39
