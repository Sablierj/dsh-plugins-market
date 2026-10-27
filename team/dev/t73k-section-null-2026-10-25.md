# T73k — 「没有这一节」不是「采到 0 个字段」（dev-11）

> **树标识**：`amazon-ops` @ git HEAD `d7c4037`（2026-10-25），**工作树有多支笔并行**
> （`keywords/competitor.js`、`collect/env.js`、`sources/browser/collector.js`、`tests/run.mjs`、
> `tests/b05d-tabs.mjs`、`tests/cr1-quadrant-card.mjs` 都是别人正在改的）。本报告只对下面四个文件负责
> （`tools/collect-center.js` 是**第二批** lead 授权后扩进来的，只动「字段」列那一行 + 一行注释）：
>
> | 文件 | SHA-256（前 16 位） |
> |---|---|
> | `src/domain/asin/sections.js` | `28db0ad08fbd49ea` |
> | `src/domain/collect/detail.js` | `d88cdae1fd6fb36a` |
> | `src/tools/collect-center.js` | `47f360f54f8990da` |
> | `tests/t73k-section-null.mjs`（新建） | `eca6467cf43c2ba6` |
>
> **口径**：定向 `node tests/t73k-section-null.mjs` = **10 checks / 243 断言，0 failed**（直接跑，
> 不经 run.mjs）；全量 `node tests/run.mjs` = **2526 passed / 0 failed**（本套件 10 条已含在内，
> 三次跑的经过与「先前那些红分别是谁的」在 §四.4）。
> **不把未执行写成通过**：第一次接上 run.mjs 时全量**崩在 `run.mjs` 顶层**（我的 runner 当时要了
> 宿主没传的 `deepEqual`/`checkAsync`），已改成只要 `{ check, equal }`；经过与原文在 §五.1。

---

## 〇、消费方盘点表（本单的重点，改代码之前做的）

方法：`grep -rn "sectionValueCounts\|collected" src/` 共 151 处，逐个读；凡是读 **13 节载荷里的
`collected` / `total`** 的都列进来（「同名不同物」的 `summary.collected` 是五态计数，另列）。

| # | 文件:行 | 它拿这个数做什么 | `collected` 变 `null` 会怎样 |
|---|---|---|---|
| 1 | `src/web/pages/asin.js:1990-1995` | ASIN 详情 → 「13 节」页，逐行印 `collected/total`；先判 `notCollected`，那一支印「一个字段都没看过（声明清单 N 个）」 | **不受影响**。读 `collected` 之前就分叉了，`notCollected` 支根本不碰分子 |
| 2 | `src/web/pages/asin.js:3869-3875` | 采集面板「13 节」（载荷来自 `buildSectionDetail`），同上；另有 `total === 0` 印「无字段可计」 | **不受影响**。同上；`total === 0` 那一支也在 `notCollected` 之后，且分母没动 |
| 3 | `src/tools/asin.js:747` | `amzn_asin_detail` 的「字段」列：`row.notCollected === true ? '—' : \`${collected}/${total}\`` | **不受影响**。有 `notCollected` 守卫，未采集印「—」 |
| 4 | `src/tools/collect-center.js:605` | `amzn_collect_detail` 的「字段」列：`` `${row.collected}/${row.total}` ``，**没有 `notCollected` 判断** | **显示错（实测）**：未采集的行会印 **`null/5`**。这一行**不在我的写域**，改法与实测见 §五.1 |
| 5 | `src/domain/asin/reviews.js:102-104` | 评论页判定 `ok/empty/never-collected/unreadable`：自己调 `sectionValueCounts(REVIEW_SECTION_ID, section.parsedValue)`，并有 `counts === null` 护栏（`:103`） | **不受影响**。读的不是 entry 的 `collected`，且自己算、自己有护栏 |
| 6 | `src/domain/collect/section-reading.js:180-181 / 216-217 / 335` | 写入端/审计端自洽检查（`collectedIsComplete` / `auditStoredSectionResult` / 逐节比对）：自己调 `sectionValueCounts`，两处 `counts === null` 护栏 | **不受影响**。同上，读的是行上的 `parsedValue` |
| 7 | `src/domain/asin/overview.js:81` | 概览的「13 节未采集清单」：`filter(entry => entry.notCollected === true)` | **不受影响**。只读 `notCollected` |
| 8 | `src/domain/asin/sections.js:200-202` | 五态计数（`summary`）：`for (entry of attempted) summary[entry.status] += 1` | **不受影响**。数的是 `status`，从不读 `entry.collected`（我在 ① 里钉住 `summary.total/collected` 未变） |
| 9 | `src/domain/asin/detail.js:101` | 把 `buildSectionView` 的载荷透传给详情页/工具 | **不受影响**。只透传 |
| 10 | `src/web/pages/collect.js:89-94,106` | `totals.collected / attempted` —— **五态计数**的「已采到」，不是逐节分子 | **不受影响**。同名字段，另一个东西 |
| 11 | `src/tools/asin.js:698-700`、`src/tools/collect-center.js:577/595` | 同上，`summary.collected` 五态计数 | **不受影响**。同上 |
| 12 | `src/web/page.js:167` | `collected: 'ok'` —— 状态→CSS 类映射的**键**，不是数 | **不受影响** |

**盘点的结论（决定了改法）**：
1. **没有任何消费方对 `collected` 做算术**——12 处里没有一处求和、求比率或拿它当分母（第 10/11 条那个比率用的是 `summary.collected`，另一个字段）。所以把分子改成 `null` **不会算错**，最坏是**印错**。
2. **两处页面渲染、一处工具早就用 `notCollected` 分叉了**（#1 #2 #3）——也就是说页面从来没有把未采集的节画成 `0/N`，回退的只有载荷本身与 `amzn_collect_detail` 的文本（#4）。
3. 因此**不需要改任何页面**（`src/web/pages/*` 一行不动），没有触发「必须改页面 → 停手报 lead」那条。
4. `#4` 是唯一受影响处，且**不在我的写域**——按纪律不碰，改法写进 §五.1，交 lead 派。

---

## 一、结论

1. **两个入口一起改，同一口径**：`src/domain/asin/sections.js`（对象视角，跨任务取最新一行）与 `src/domain/collect/detail.js`（任务视角）在没有节行时，`collected` 从 `0` 改成 **`null`**、`missingFields` 从 `[]` 改成 **`null`**；`total` 仍是**声明清单长度**。
2. **第二处兜底一起清**：`?? { collected: 0, total: definition.fields.length, missing: [] }` 删掉，改成**具名早退分支**——`collected: null` + `missingFields: null` + `countsUnavailable: true` + `total` 仍是清单长度。
3. **台账 24 的定位有一半是错的**（见 §二.2）：`sections.js:161` 那个 `??` 是**结构上不可达**的（`sectionValueCounts` 只对「id 不在 13 节词表里」返回 null，而两个入口的 id 都来自 `COLLECTION_SECTIONS`）。真正在页面上画成 `0/N` 的是它上面 `row === null` 那条早退分支（`sections.js:142` / `detail.js:96`）。两处一起改，台账的定位要在复验时更正。
4. **第二批（lead 授权后，同一单）两处消费方**：`tools/collect-center.js` 的「字段」列补 `notCollected || collected === null` 守卫（改前实测会印 `null/5`）；`missingFields` 改 `null`（盘点见 §五.2：**零调用方改动**，两处页面读者本来就 `Array.isArray` 守卫）。
5. **新建 `tests/t73k-section-null.mjs`**：**10 checks / 243 条断言**（静态调用点 40 = 36 `equal` + 4 `deepEqual`，循环展开到 243），**先红后绿**：第一批改之前 **4 failed / 4 passed**，全绿后为 **10 / 0**；`node tests/t73k-section-null.mjs` 可直接跑（自带最小 harness，含 `checkAsync`）。
6. **写域**：改 `src/domain/asin/sections.js`、`src/domain/collect/detail.js`、`src/tools/collect-center.js`（第二批授权，只「字段」列那一行 + 一行注释），新建 `tests/t73k-section-null.mjs`。**未触碰** `src/web/pages/**`、`src/sources/**`、`src/domain/keywords/**`、`src/store/schema.js`、`tests/run.mjs`、别人的测试。

## 二、缺陷形状

### 2.1 两处早退分支（真正上屏的那一处）

`detail.js`（改前，`:76-91`）：

```js
if (row === null || row === undefined) {
  return { ...base, status: null, notCollected: true,
    collected: 0,                       // ← 「没人打开过这一节」
    total: definition.fields.length,     // ← 后面还跟着一个真的分母
    … }
}
```

`sections.js`（改前，`:130-159`）同形。两条都带 `notCollected: true`，但**分子是 0**，于是：

| 载荷 | 页面/工具怎么画 | 真相 |
|---|---|---|
| `notCollected: true, collected: 0, total: 5` | 详情页/工具：`0/5`（页面那一支会画「一个字段都没看过」，但**载荷进任何日志、API 或第三方读者都是 `0/5`**） | 这一节**从没被采过** |
| `notCollected: false, collected: 0, total: 5` | `0/5` | 采过，解析值里**一个字段都没有** |

两行的数字一模一样，动作却相反：前者去**补采**，后者去**查选择器**。这就是本批反复在修的那一类错——**「没有读数」被写成了一个读数**。

### 2.2 第二处：`??` 兜底（台账 24 记的位置）

```js
const counts = sectionValueCounts(definition.id, row.parsedValue)
  ?? { collected: 0, total: definition.fields.length, missing: [] }
```

`sectionValueCounts`（`src/domain/collect/sections.js:204`）只在这一句返回 `null`：

```js
const section = SECTION_BY_ID[String(sectionId ?? '').trim()]
if (section === undefined) return null
```

而两个调用方的 `definition.id` 全部来自 `COLLECTION_SECTIONS.map(...)`，每一个 id 都在 `SECTION_BY_ID` 里（`SECTION_BY_ID = Object.fromEntries(COLLECTION_SECTIONS.map(...))`）。**所以这一行在今天的代码里不可达**——它不是页面上那个 `0/N` 的来源，它是「数不出来 ⇒ 0」这一类错误的第二个样本：一旦谁放宽了 id 的来源（比如以后允许自定义节、或从库里读 `section` 列反查定义），它当场变成一次假读数。

**两条一起改**，理由就是台账末尾那句：改一个不改一个比不改更坏。

## 三、改动

口径（两个文件逐字段相同）：

| 输入 | `notCollected` | `collected` | `total` | 附带 |
|---|---|---|---|---|
| 没有这一节的行 | `true` | **`null`** | 定义清单长度 | `missingFields: []`、`readTruncated`（截断时）照旧 |
| 有行 + 数不出来（不可达） | `false` | **`null`** | 定义清单长度 | `countsUnavailable: true` |
| 有行、字段全空 | `false` | **`0`**（真读数） | 定义清单长度 | `missingFields` = 整份清单 |
| 有行、部分有值 | `false` | `n` | 定义清单长度 | `missingFields` = 缺的那几个 |

### 3.1 `src/domain/collect/detail.js`

- `:96` 早退分支：`collected: 0` → **`collected: null`**；补 `missingFields: []`（这个分支从前没有这个键，与 `sections.js` 不对称；现在两边同形，⑥ 才能逐字段对比而不是「都当空数组」）。
- `:107-132` 新增具名早退：`counts === null` → `{ collected: null, total: 定义清单长度, missingFields: [], countsUnavailable: true }`，其余字段（status / statusLabel / collectedAt / schemeVersion / snapshotRef / errors / parsedValue / contentUnread）照旧从行上取，`contentUnread` 走的还是那**一个** `sectionContentUnread`，不是重算。
- `:70-82` 头部补一节 `## "No row" is not "0 of N" (T73k)`，写清为什么分子不能是 0、为什么分母不能拿掉。

### 3.2 `src/domain/asin/sections.js`

- `:142-148` 早退分支：`collected: 0` → **`collected: null`**（`total` 与 `missingFields` 不动）。
- `:166-198`：删掉 `?? { collected: 0, … }`，改成 `counts === null` 的**具名早退分支**；`taskCount` 的声明从 counts 之后提到之前（它不依赖 counts，纯移动），两种分支都带同一个 `taskCount`。
- `:22-41` 头部新增 `## 同一个理由：没有行的节也不带分子` 一段。

### 3.3 为什么没抽成一个共用函数

两个文件属于同一层（`domain/asin` 与 `domain/collect`），把规则放进 `domain/collect/sections.js` 才是「一份实现」的正解，但**那个文件不在我的写域内**（`src/domain/collect/sections.js`）。反向让 `asin/sections.js` 去 import `collect/detail.js` 会把 `store/queries` 拖进 ASIN 视图，层级就不对了。
所以本单的处置是：**两处字面量逐字段相同 + ⑥ 用两个真入口在三种输入上逐字段比对（13 节 × 3 情形 × 5 个字段）+ ⑦ 源码守门**。两边一旦漂移，⑥ 或 ⑦ 会红。**这是写域受限下的最优解，不是我认为的理想解**——理想解需要动 `domain/collect/sections.js`，交 lead 决定要不要另开一单。

## 四、测试

### 4.1 `tests/t73k-section-null.mjs`（新建）

- 导出 `async function runT73kSectionNullTests({ check, equal, deepEqual })`，与 `t73i` / `t73l` 同形；
- **可直接 `node tests/t73k-section-null.mjs`**：文件底部有 `directRun()` 守卫（`pathToFileURL(process.argv[1]).href === import.meta.url`），自带一个最小 harness（`check/equal/deepEqual` 计数 + 非零退出码），不经过 `tests/run.mjs`；
- 用**真库**（`openStore` 真迁移 + 真 `recordSectionResult` 写入），不是手工拼的假 row；夹具只有一处「给哪些节写行」，**没写出来的节就是本文件要分开的那一半**。

十条检查与「它能抓到什么」：

| 检查 | 抓的是什么 | 改之前 |
|---|---|---|
| ① 没有节行 | `collected === null`、`missingFields === null`、`total` 是清单长度、`notCollected === true`；**反面**：`summary.total/collected` 与 `totals.neverAttempted` 不许被这件事带偏 | **红**（得到 0） |
| ② 有行但字段全空 | `collected === 0` 是**真读数**，`status === 'missing'` | 绿（设计如此：它钉的是反方向） |
| ③ 有行且有值 | 1/5、`partial` | 绿 |
| ④ 分母 | 未采集的 `bullets` `total === 5`（不是 0）；**动态节 `attributes` 的 `total === 0` 是「清单本来就空」，不是缺陷**；13 节逐节 `total === 定义清单长度` | **红**（动态节分子是 0） |
| ⑤ 缺失名单 | 部分行 → `['bullet_2','bullet_4','bullet_5']`（顺序与定义一致）；全空行 → 整份清单（**有行才有名单**） | 绿 |
| ⑥ 两个入口同一口径 | 三种输入 × 13 节 × 5 个字段（`collected` / `total` / `notCollected` / `missingFields` / 「是不是 null」）逐字段比对，外加 `summary.total` | 绿（但只是「碰巧一样」——两边都在伪造 0；改成 null 之后它才是真正的口径钉） |
| ⑦ 源码守门（两个 domain 文件） | **剥掉注释后**不许出现 `collected: 0, total:` 与 `?? { collected: … }`；必须出现 `collected: null`；不许 `total: 0, missing` | **红**（命中 `sections.js` 的兜底字面量） |
| ⑧ 同一次读里两种 0 | 同一份载荷里 `never.collected === null`、`empty.collected === 0`、两者**不相等**、`notCollected` 不同、分母都在 | **红**（两个都是 0） |
| ⑨ 工具文本（行为级） | 真工具 `collectDetailTool({ store }).execute(...)` 返回的 `text`：全文不许出现 `null/`；有读数的节仍印 `4/11`（反面：别把整列改成「—」）；未采集那一行不许出现「数字/数字」；**反面控制**：没有守卫的写法必须印出 `null/`，否则这条断言是空的 | **红**（实测印 `null/5`） |
| ⑩ 源码守门（工具 + 页面守卫） | `tools/collect-center.js` 剥注释后必须有 `row.collected === null` 与 `row.notCollected === true`；`web/pages/asin.js` 的 `Array.isArray(entry.missingFields)` **至少 2 处**（`missingFields` 现在是 null，少一处就是 `null.length`） | **红**（工具那一列没有守卫） |

⑦ 有三个防止自己变成空断言的设计，写进断言里而不是注释里：
- **剥注释**（`codeOnly`，手写状态机而不是正则——这些文件里有正则字面量、反斜杠和中文注释，一条正则分不清 `//` 是注释还是除号），否则「解释历史」那句话会误伤；
- **剥注释自检两面**：`code.includes('T73k')` 不许为真（没剥掉）、`code.includes('countsUnavailable')` 必须为真（剥过头）；
- **反面控制**：把改之前那两行兜底**喂给同一套判据必须命中**，否则这条守门是空的；同时「注释里出现老写法」必须**不**命中。

⑨ 有自己的一条反面控制（否则「工具不返回 text」也会让它绿）：用同一个 `table()` helper 拼一遍**没有守卫**的列，断言它确实印得出 `null/`。

### 4.2 先红后绿（实测输出）

第一批改之前：

```
  ✗ T73k-① … 期望 null，实际 0
  ok T73k-②   ok T73k-③
  ✗ T73k-④ … 动态节没有读数时分子也不许是 0: 期望 null，实际 0
  ok T73k-⑤   ok T73k-⑥
  ✗ T73k-⑧ … 「从来没人打开过」又变成了一个数字: 期望 null，实际 0
  ✗ T73k-⑦ … domain/asin/sections.js 里又出现了伪造读数「collected: 0, total: …」
T73k: 4 passed / 4 failed
```

两批都做完之后：

```
  ok T73k-① … ⑩   （10 条全绿）
T73k: 10 passed / 0 failed
```

计数：`checks=10` / **运行时断言 243 条**（走宿主 `equal` 的 202 条 + 走 runner 自带 `deepEqual` 的 41 条）；静态调用点 39 个（36 `equal` + 3 `deepEqual`），⑥ 的 3×13×5 + 2 与 ④ 的 13 节循环把它们展开到 243。`deepEqual` 不走宿主是刻意的（见 §五.1：少传一个键会让整条套件崩）。

### 4.3 定向回归（这两处是谁的依赖）

`b05-asin-detail`（直接 import `buildSectionView`）、`b04-collect-tools`（`amzn_collect_detail` 的 13 节与拒绝码）、`b04-collect-page`（采集面板渲染）、`b05-asin-page`、`b04-variation-children`（`notCollected` + `contentUnread`）——全量跑里**没有一条红**。

### 4.4 全量 `node tests/run.mjs`：三次跑，最后一次 **2526 passed / 0 failed**

| 次 | 时点 | 结果 | 那几条红是什么 |
|---|---|---|---|
| 1 | 第一批改完 | **2502 / 3 failed** | 全是并行的 T-4a 竞品象限（`competitor.js` 把「对端无事实」从 `0` 改成 `null` → 桶归属从 `ownAdvantage` 变 `unmeasured`），3 条分别是 `B05D-W4`（期望「自有优势」得到「未测」）、`CR1-T1`（未测计数 1→2）、`CR1-T3`（两个桶的行序随桶位移动而变）。**lead 已确认是他那支笔没改完，并已修完 + 更新四条已评审断言。** |
| 2 | 第二批改完 + lead 接上 run.mjs | **2503 / 2 failed** | ① `T4-②` 全仓悬空调用扫描命中**我的**文件（我的本地 harness 写成了 `async checkAsync(...)` 简写方法，被当成没有 `await` 的调用）→ 我已改；② `T30-①` 子进程 exit 1，直接跑出来是 **`src/web/pages/kw.js:450` 的语法错**（未闭合模板串）——**另一支笔正在编辑 `web/pages/**`**，不在我的写域，十几分钟后再跑已自行恢复。 |
| 3 | 两处修完 + lead 的注册生效 | **2526 passed / 0 failed** | — （本套件 10 条已含在 2526 里） |

第 1 次那 3 条的证据链（当时写的，保留原样）：
1. 这三条断言看的都是**竞品象限的桶归属 / 未测计数 / 两个桶的行序**，没有一条读 13 节的 `collected`；
2. 工作树里 `src/domain/keywords/competitor.js` 正被另一支笔改成 T-4a（`git diff` 里写着「对端没有事实 = 未测量」：`their === undefined ? null : Number(...)`），而 `b05d-page.mjs`（W4 那条断言的宿主）**没有**随之修改——改源不改测，就是这三条红的形状；
3. 我这三个文件都不在那两个测试的 import 图里影响象限标签（`b05d-page.mjs` / `cr1-quadrant-card.mjs` 只通过 `buildAsinDetail` 拿到 `sections`，改的是 `collected`）。

**教训（写在这里给下一单）**：第 2 次那两条红，一条是我的、一条是别人的**半成品**。区别方法只有一条——**把红的那个文件单独跑一遍**：`T30-①` 一跑就吐出 `kw.js` 的 `SyntaxError`，而我的那条在源码扫描里精确点名了我自己的行号。不跑到这一层，「是不是我的」就只能靠猜。

## 五、第二批（lead 授权后）与仍要 lead 做的事

### 五.1 【已由 lead 接上】`tests/run.mjs` 注册 —— 但注册行暴露了一个必须修的形状

lead 已经接了（`run.mjs:559` import、`:11558` await），**我按他的注册行把 runner 改成只要 `{ check, equal }`**，理由是一次真实的红：

> 第一次接上后全量直接**崩在 `run.mjs` 顶层**（不是一条断言红）：
> ```
> FAIL T73k-⑤ … deepEqual is not a function
> FAIL T73k-⑥ … deepEqual is not a function
> TypeError: checkAsync is not a function
>     at runT73kSectionNullTests (tests/t73k-section-null.mjs:335)
>     at tests/run.mjs:11558
> ```
> 原因：`run.mjs` 里各注册行传的键**不一样**（有的只给 `{ check, equal }`），而我的第一版 runner 直接
> 解构 `deepEqual` / `checkAsync`。一个少传的键 → **整条套件被拉倒**，而错不在我的断言里。

修法（不是让 lead 去改注册行，而是让 runner 不依赖宿主多给东西）：
- **深比较自带**：`isDeepStrictEqual`（`node:util`，与 run.mjs 自己的 `deepEqual` 同语义），不再解构 `deepEqual`；
- **⑨ 的异步只在取数据**：先 `await tool.execute(...)` 拿到文本，再在同步 `check` 里断言 —— 不再需要 `checkAsync`。

于是 `runT73kSectionNullTests({ check, equal })` 与 `({ check, checkAsync, equal })` 都能跑（两种都实测 10/0）。
**lead 那两行不用再改**；如果以后要统一，按下面这段最省：

```js
/* T73k —— 13 节：「没有这一节」不是「采到 0 个字段」（两个入口同一口径 + 工具文本 + 源码守门）。 */
import { runT73kSectionNullTests } from './t73k-section-null.mjs'
```
```js
/* T73k —— 13 节：没有读数 ≠ 采到 0（10 checks / 243 断言）。 */
await runT73kSectionNullTests({ check, equal })
```

### 五.2 【已完成】**`missingFields: []` → `null`**：盘点表 + 改动

lead 的条件是「先盘点；会 `for...of` / `.length` 的先改调用方」。`grep -rn missingFields src/` = 21 处、`tests/` = 12 处，逐个读完，只挑**读 13 节载荷**的：

| # | 文件:行 | 读的是什么 / 怎么读 | 变 `null` 会怎样 |
|---|---|---|---|
| 1 | `src/web/pages/asin.js:2005-2006` | 13 节 entry（ASIN 详情）：`Array.isArray(entry.missingFields) && entry.missingFields.length > 0 ? '缺 ' + ….slice(0,8).join(' ') : ''` | **不受影响**：`Array.isArray(null)` 为假 → **短路**，`.length`/`.slice`/`.join` 一个都不执行 → 不崩、不印；屏幕上与 `[]` 一个字节都不差 |
| 2 | `src/web/pages/asin.js:3874-3875` | 同上（采集面板，`slice(0,4)`） | **不受影响**（同 #1） |
| 3 | `src/domain/asin/sections.js:162` / `:194` | **生产者**：no-row 与 `counts === null` 两支都写 `[]` | 已改 `null`（各带一行注） |
| 4 | `src/domain/collect/detail.js:102` / `:128` | **生产者**：同一件事的另一个入口 | 已改 `null`（各带一行注） |
| 5 | `sections.js:218` / `detail.js:145` | **生产者**：有行时写 `counts.missing` | **不动** —— 有读数才有名单 |
| 6 | `collector.js:715` → `sources/collection.js:1164` → `tools/collect.js:521-522` | **采集器结果**的 `missingFields`（**同名不同物**，另一条链路）：`?? []` 传递、`?.length > 0` + `.join(', ')` 消费 | **与本单无关，一个字节没动**。也提醒：别把这条链路和 13 节的同名字段混为一谈 |
| 7 | `src/sources/keyword.js:597/631/671` | 导入器内部 `Set` → 结果字段 | 无关 |
| 8 | `tests/b04-collect-tools.mjs:1302/1305` | `basic`、`images`（两条**都有行**）`deepEqual` | 不受影响 |
| 9 | `tests/b04-collect-page.mjs:633/646-649` | 手工页面夹具（有行的五态各一条）；**未采集那条夹具本来就没有这个键** | 不受影响 |
| 10 | `tests/t73k-section-null.mjs`（①⑤⑥） | 我自己的断言 | 已随之改成 `null` |

**结论：一处 `for...of` 都没有，一处未守卫的 `.length` 都没有 → 零调用方改动。**

`[] + missingUnavailable: true` 的替代方案**不采用**，两条理由：
1. 它要两个字段永远同步，而「两份要保持同步的写法」正是本仓反复出事的形状（`contentUnread` 当年就是两份实现、对上直到一方改了才红）；
2. 只读 `missingFields` 的读者（日志、`/api/*`、第三方）**仍然**会把 `[]` 读成「一个都不缺」—— 问题没解决，只是多了一个字段去解释它。

代价说清：将来谁写 `entry.missingFields.length` 而忘了 `Array.isArray`，**会抛**（不是静默印空）。这正是 ⑩ 钉住两处现有守卫的原因——守卫被删**测试先红**，而不是页面上 `null.length` 崩。

### 五.3 【已完成】`tools/collect-center.js` 的「字段」列守卫

只改那一行 + 一行注释，没有顺手重构：

```diff
+      /* T73k：没有读数不是一个读数 —— 未采集的节分子是 null 不是 0，直接拼会印成
+         `null/5`。与 `amzn_asin_detail` 同一个口径：那一列早就是 `notCollected ? '—'`。 */
-      { label: '字段', value: row => `${row.collected}/${row.total}` },
+      { label: '字段', value: row => (row.notCollected === true || row.collected === null ? '—' : `${row.collected}/${row.total}`) },
```

行为级证据：⑨ 走**真工具** `collectDetailTool({ store }).execute(...)`，断言 `text` 里没有 `null/`、有读数的节仍印 `4/11`、未采集那一行没有「数字/数字」，并用「无守卫写法必须印出 `null/`」做反面控制。

### 五.4 【要更正】台账 24 的定位

`team/qa/fallback-zero-backlog-2026-10-25.md:102` 把 24 记成「`asin/sections.js:161`：没有节行时伪造 `{collected:0,total:N}`」。盘点后：`:161` 的 `??` **结构上不可达**，真正的伪造在 `:142` 的 `row === null` 早退分支（`detail.js` 对应 `:96`）。这份台账的规矩是「原判不涂改、推翻处加更正」，请复验席在 24 下面加一行更正，否则下一个人会去修那条不可达的分支，以为修完了。

### 五.5 六条铁律对照（本单只用到 4 条）

| 铁律 | 本单怎么落 |
|---|---|
| 四态口径 | **没有读数 ≠ 读数是 0**：`collected` 与 `missingFields` 两处都从「默认值」改成 `null`，⑧ 直接钉「两种 0 不相等」 |
| 数字带分母来源时间 | 分母 `total` 一行没动（④）；`collectedAt` / `taskId` 照旧 |
| 未执行不许写成通过 | 本单就是这一条的实例：没采过的节从前写着「0/N」（看起来像采完了、没采到东西），现在写「没有读数」；`run.mjs` 没注册这件事也照实写在报告头 |
| 树标识 | 报告头**四个** SHA-256 + git HEAD；工作树有多支笔这件事写在最前面 |
| 禁黑盒总分 / 机器写路径不覆盖人工决定 | 本单不涉评分、不写库（三个文件都是读/呈现路径），故不适用——不是「已满足」 |
