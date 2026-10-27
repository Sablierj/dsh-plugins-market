# F12-08「修改后接受」—— 契约

> 批次：**B-12.13**（模块 12，WorkBuddy 属区）
> 需求依据：`docs/amazon-ops-需求设计文档-v2.0.md:820`（在 workspace 的 `docs/` 下）
> 基线：`wb-b127` @ `aa1e7c7`；schema **v46**；工具 **134**；反引号 **48**
> 缺口出处：`docs/requirements/RESEARCH-module-alignment-v2.0.md:397`（F12-08 缺口栏）

---

## §0 为什么做这一条

需求原文（`amazon-ops-需求设计文档-v2.0.md:820`）逐字：

> | F12-08 | 人工控制 | 草案级（**接受/修改后接受/驳回**）/字段级/证据级/流程级/版本级五层控制；Agent 必须说明等待什么 | P0 |

代码自己承认它不存在 —— `src/store/agent.js` 的 `decideArtifact` 头注释逐字：

> 「草案级：接受 / 修改后接受 / 驳回」在代码里不存在，一次运行跑完门禁之后草案永远停在 `draft`。

（那句话的**后半已经过期**：接受/驳回由 `decideArtifact` + `amzn_agent_artifact_decide` + 页面按钮补上了。
**只有「修改后接受」还缺。**）

### §0.1 审计缺口栏里还有一句已过期，别被它误导

`RESEARCH-…v2.0.md:397` 的缺口栏写着「**页面只能对门禁裁决，不能对产物做草案级接受/驳回**」——
**这句已经过期**（B-12.10 之前就在：`artifactDecideCell` 画接受/驳回按钮 + POST `agent-artifact`）。
所以本批**不重做**接受/驳回，只补「修改后接受」。

### §0.2 字段级与证据级**不做**（本批明确不做）

| 缺口 | 为什么不做 |
|---|---|
| **字段级** | 产物 `body` 是**自由 JSON**，没有字段 schema。要做字段级控制就得给每种产物类型发明一份字段表 —— 而 `artifact-types.js` 明说约定类型是**清单不是闭集**（不在里面的 type 照样合法）。给开放词表配一份字段表 = 把开放渲染成闭集 |
| **证据级** | `src/domain/observe/metrics.js` 自陈指标不可算（缺记录）。没有证据可引用，做出来的「证据级控制」只能是空壳 |

⇒ 本批**只做「修改后接受」**，其余两条继续如实登记为缺口。

---

## §1 ⚠️ 最容易写错的地方：别让「裁决」变成「编辑」

`decideArtifact` 的 JSDoc 里有一条**字节级不变量**，测试钉着它：

> ## 草案的 `body_json` **一个字节都不动**
> 裁决不是编辑。被裁决的产物的正文保持原样，这是这条路径最容易写错的地方
> （顺手把新状态一起写进 `body_json` 会看起来更「完整」）。测试里有一条字节级
> 断言钉死它。

⇒ **不许**给 `decideArtifact` 加 `body` 参数让它「顺手改」。那会让那条不变量变成假话，
也会让「接受」与「改后接受」在库里不可区分。

**正确形状**：修改后接受是一个**独立的动作**，它做两件事、留两处痕：

1. 用 `saveArtifact` 建 **v+1**（`parentId` = 原草案，`status: 'draft'`，`body` = 人改后的），
   并 `supersedeParents: true` 把原草案标 `superseded`；
2. 裁决 **v+1**（走**同一份**裁决记录实现），记录里写 `amended: true` + `amendedFrom`。

这样库里能回答「这条被接受的正文是谁写的」——而纯接受做不到这一点。

---

## §2 交付 D1：`amendAndAcceptArtifact`（`src/store/agent.js`）

```js
export function amendAndAcceptArtifact(store, { artifactId, body, note = null, by } = {})
```

### §2.1 五条拒绝（每条都要说清「下一步是什么」，照 `decideArtifact` 的口径）

| 情形 | 话 |
|---|---|
| id 空 / 找不到 | 同 `decideArtifact` |
| `by` 空 | 同 `decideArtifact`（「一个没有署名的处置就是 §11 禁掉的『需要确认』」） |
| `status === 'superseded'` | 同 `decideArtifact`：点名**当前版本**（`currentVersion`） |
| `status === 'accepted' \|\| 'rejected'` | 同 `decideArtifact`：裁决是**追加式**的，第二次处置是一次新版本 |
| **`body === undefined`** | ⚠️ **本批新增，也是本批最重要的一条**：`{ok:false}`，话要说明「**没有改动就不叫修改后接受** —— 直接接受请用 `amzn_agent_artifact_decide`」。**否则「改后接受」会被用来记录一次根本没改的接受，那正是「给缺失造一个像数据的替身」** |

⚠️ **`body` 的判据是 `=== undefined`，不是 `=== null`**：`null` 是一个**合法的产物正文**
（`saveArtifact` 对 `body === null` 写 NULL）。所以：
- `undefined`（没传这个键）→ 拒绝（没改）
- `null` → **允许**（人把正文清空，这是一个真实的修改）
- `{}` / `{...}` → 允许

### §2.2 一个事务（`store.tx` 不可重入，见下）

`decideArtifact` 自己开了 `store.tx`。**`store.tx` 只发 `BEGIN`，不可重入** ——
所以 `amendAndAcceptArtifact` **不能**在事务里再调 `decideArtifact`。做法：

```js
/* 把「裁决 + 写裁决记录」抽成一个【假定事务已开】的内部函数，
   两份公开函数共用它 —— 裁决记录只有一份实现。 */
function decideInTx(store, row, { accept, note, by, amended = null }) { … }

export function decideArtifact(store, opts) {
  …五条拒绝…
  return store.tx(() => decideInTx(store, row, { accept: opts.accept, note: opts.note, by: decider }))
}

export function amendAndAcceptArtifact(store, opts) {
  …六条拒绝…
  return store.tx(() => {
    const revised = saveArtifact(store, {
      runId: row.run_id, stepSeq: row.step_seq, type: row.type,
      objectType: row.object_type, objectId: row.object_id,
      parentId: row.id, status: 'draft', body, supersedeParents: true,
    })
    return {
      ...decideInTx(store, { ...revisedRowShape }, { accept: true, note, by: decider,
        amended: { from: row.id, fromVersion: row.version } }),
      superseded: row.id,
    }
  })
}
```

⚠️ `decideInTx` 收的是**库行**（`snake_case`，`run_id`/`step_seq`…），不是 `hydrateArtifact`
的驼峰投影 —— `decideArtifact` 现在传的就是库行，别搞混。

⚠️ **`supersedeParents: true` 在这里是安全的**：被取代的是 `draft`。
`saveArtifact` 只在**父版是 `accepted`** 时抛错（「Agent 不能擦掉人的批准」）。
**不要把 `amendAndAccept` 用在已接受的产物上** —— 那一条已被 §2.1 的拒绝挡住。

### §2.3 裁决记录要多三个字段

`decideInTx` 写的那条 `artifact-decision` 的 `body` 现在是：

```js
{ artifactId, artifactType, accept, note, by, from }
```

改成：

```js
{ artifactId, artifactType, accept, note, by, from,
  /* 本批新增：这条裁决是不是「改后接受」，以及改的是哪一版。
     ⚠️ 纯接受写 `amended: false` —— 让读者不必靠「字段缺失」推断
     （本仓忌「把缺失渲染成真实值」，也忌让读者从缺失去猜）。 */
  amended: <boolean>,
  ...(amended === null ? {} : { amendedFrom: amended.from, amendedFromVersion: amended.fromVersion }),
}
```

⚠️ **老记录没有 `amended` 键**（本批之前写的）。读者必须把「没有这个键」读成 `false`，
并且**这条边界要写进注释** —— 因为「缺键」与「false」在库里看起来不同，但在语义上是同一件事。
（这是**有意的兼容**，不是遗漏；别把老记录当成「不知道」。）

### §2.4 返回

`{ artifact, decision, superseded }`：
- `artifact` = **新的、已接受的那一版**（`getArtifact`）
- `decision` = 裁决记录产物
- `superseded` = 被取代的旧草案 id（**必须返回** —— 调用方要能说出「v1 被 v2 取代了」）

---

## §3 交付 D2：工具加 `body` 参数（`src/tools/agent.js`）

`amzn_agent_artifact_decide` 加一个**可选** `body`（object）：

| 入参组合 | 行为 |
|---|---|
| 无 `body` + `accept` 布尔 | 走 `decideArtifact`（**行为完全不变**） |
| 有 `body` + `accept === true` | 走 `amendAndAcceptArtifact` |
| 有 `body` + `accept === false` | **`{ok:false}`**：「修改后驳回不在需求里（§11 只写了 接受 / 修改后接受 / 驳回）。改完再驳回请分两步：先改后接受，或直接驳回」 |
| 有 `body` + `accept` 缺失/非布尔 | 仍由 `accept` 那条判断拦住（**不要**用 `body` 的存在去推断 `accept`） |

**描述文本要改**：现在写着「The decided artifact's body is **not** modified: a decision is not an edit.」
—— 加了 `body` 之后这句要补一半：「不给 `body` 时正文不动；给了 `body` 就是**修改后接受**，
它建一个新版本再接受，旧版本被标 superseded」。

**输出文本**要能让人看出发生了什么：
- 纯接受：保持现在的说法（正文未改动）
- 改后接受：`产物裁决已记录: <type> v2 → accepted（<decisionId>）` + `已取代 v1（<oldId>）` + `正文已按修改写入新版本`

⚠️ **不加新工具**（TOOLS 仍 **134**）。加参数不改工具数。

---

## §4 交付 D3：路由透传 `body`（`src/web/routes.js`）

`agent-artifact` POST 把 `body?.body` **原样**传给工具（`body: body?.body`）。

⚠️ **不许洗**（照那段已有的注释：「`accept` is passed through **raw** on purpose」）：
`body?.body ?? null` 会把「**没传**」洗成「**传了 null**」—— 而这两者在 §2.1 里**行为相反**
（没传 = 拒绝；null = 允许，人清空了正文）。这正是本仓最忌的形状。

`by` 仍然固定 `'page'`（页面路径不读调用方给的署名）。

---

## §5 交付 D4：页面「改后接受」（`src/web/page.js`）

### §5.1 只在运行详情里，不进独立列表

`artifactDecideCell`（独立列表用的那个，B-12.11）**保持现状** —— 它对 `draft` 说
「待裁决（在运行详情里处置）」，**不画任何按钮**。理由：B-12.11 的断言钉着「列表里没有
`data-artifactdecide` 按钮」（「one answer per draft」）。

### §5.2 运行详情的三个按钮

`artifactBlock` 里那个内联的 `decideCell`（`draft` 分支）现在是两个按钮。加第三个：

```html
<button class="btn btn--ghost btn--sm" data-artifactamend="<id>">改后接受</button>
```

⚠️ **`data-artifactamend` 必须是独立的属性名**，不能复用 `data-artifactdecide` ——
否则现有的点击处理器会把「改后接受」当成一次普通接受（`data-accept` 缺失 → `=== '1'` 为 false
→ **静默驳回**）。这是本批最容易写出的一个假动作。

### §5.3 交互：预填正文 + 解析失败不上报

点「改后接受」→ 弹一个编辑区，**预填**当前正文的 `JSON.stringify(body, null, 2)`：

- 提交前 `JSON.parse`；解析失败 → **就地报错、不发请求**（不要把坏 JSON 发给服务端让它报一个
  看不懂的错）。
- 取消 → 什么都不做。
- ⚠️ **不要用 `prompt()`**（本仓没有这个先例，而且多行 JSON 在 `prompt` 里没法看）。
  用一个简单的 `<textarea>`（页面里已有 `showPageError` / `refresh` 可复用）。

### §5.4 显示

已接受且 `amended: true` 的行，裁决那一格要**说出来**是改后接受的（不是与纯接受长得一样）：

```
已接受 · <by> · <time> · 改后接受（取代 v1）
```

`amended` 缺失 = 纯接受（老记录），不显示「改后接受」。

---

## §6 硬约束

1. **不许删或改写既有断言换绿灯**；断言只增不减；不钉绝对数字。
2. **`page.js:252` 到 `:11394` 整段是一个模板字面量** —— 该区间**注释里不许出现反引号**。
   基线 `grep -o '\`' src/web/page.js | wc -l` = **48**。
3. **不许用 PowerShell 改含中文的文件**（BOM 会毁 UTF-8）。用 Edit 或 python
   `io.open(..., encoding='utf-8', newline='')`。
4. **不加迁移**（schema 停 **v46**）、**不加工具**（停 **134**）。
5. **不动别的模块的区**：`src/sources/**`、`src/domain/collect/**`、`src/domain/asin/**`、
   `src/domain/optimize/**`、`src/domain/observe/**`、`src/tools/asin*.js`、`src/tools/b05-*`、
   `tests/b05-*`、`tests/b13b-*`。
6. 提交信息用 `Write` 写文件 + `git commit -F`（中文别用 `-m`）。

---

## §7 验收判据（写进 `tests/b12-13-amend-accept.mjs`，每条都要能证伪）

| # | 断言 | 怎么弄红 |
|---|---|---|
| ① | 改后接受建 **v+1**、旧版变 `superseded`、新版 `accepted`，且新版 `body` **等于**人改的那份 | 让 `saveArtifact` 不传 `body` → 红 |
| ② | 裁决记录写 `amended: true` + `amendedFrom` = 旧 id + `amendedFromVersion` = 旧版本号 | 去掉 `amended` → 红 |
| ③ | **纯接受**的裁决记录写 `amended: false`（不是缺键） | 改成不写 → 红 |
| ④ | `body === undefined` **被拒绝**，且**库里一行都没多**（产物数不变、旧版仍是 draft） | 允许它 → 红 |
| ⑤ | `body === null` **被允许**（人清空正文是一个真实修改） | 把判据写成 `!body` → 红 |
| ⑥ | `body` + `accept:false` **被拒绝**，且库里一行都没多 | 放行 → 红 |
| ⑦ | 对 `accepted` / `rejected` 的产物改后接受**被拒绝**（追加式） | 放行 → 红 |
| ⑧ | 对 `superseded` 的产物改后接受**被拒绝**且**点名当前版本** | 只说「不能裁决」→ 红 |
| ⑨ | **事务**：让 `JSON.stringify` 在写 v+1 时抛错（传一个循环引用/`BigInt`）→ **旧版仍是 draft、产物数不变** | 把事务去掉 → 红 |
| ⑩ | 页面：`draft` 行有 `data-artifactamend`，**独立列表里没有**（列表仍只有「待裁决」文字） | 把按钮加到列表 → 红 |
| ⑪ | 页面：改后接受**不会**被当成普通接受（`data-artifactamend` 与 `data-artifactdecide` 是不同属性；点前者不发 `accept` 请求） | 复用属性名 → 红 |
| ⑫ | 渲染产物里「改后接受」这个词**只在** `amended: true` 的行出现 | 无条件显示 → 红 |

⚠️ **⑨ 是本批最容易做成假绿的一条**：要真的让 `saveArtifact` 在插入之后抛错，才能证明
「两处写入在同一个事务里」。做法：传一个 `JSON.stringify` 会抛的 `body`（循环引用），
它会**在 INSERT 之前**抛 —— 那只能证明「没写」，**证明不了回滚**。
要证明回滚，得让**第二处写入**抛：先让 v+1 插入成功、再让裁决那一步失败。
可行做法：临时把 `saveArtifact` 的返回值改坏（例如返回 `undefined`），看 `decideInTx` 抛错后
**v+1 是否还在**。⚠️ 如果做不到，**明说做不到**，不要用一个「本来就没写」的实验冒充回滚证据。

---

## §8 交付顺序

1. D1 `decideInTx` 抽取 + `amendAndAcceptArtifact`
2. D2 工具参数与输出
3. D3 路由透传
4. D4 页面第三个按钮 + 编辑区 + 显示
5. 测试 12 条 + 注册进 `tests/run.mjs`
6. 全量（⚠️ 跑之前工作树必须干净；`run.mjs` 是写者）
7. 门禁三连
8. 交接条 §3.40
