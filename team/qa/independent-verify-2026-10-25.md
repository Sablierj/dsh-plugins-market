# 独立复验报告 — amazon-ops（2026-10-25，verifier）

> 席位：独立复验席（teammate `verifier`），向 lead 汇报。
> 写域：本文件。**未修改任何 `src/**` 或 `tests/**`。**
> 本报告里所有标「实测」的数字都是我自己跑出来的；拿不到的写「未取得」并说明原因。

---

## 一、做了什么

### 1.1 复验时的树

| 项 | 值 |
|---|---|
| 仓库 | `C:\Users\win11\dsh-plugins\amazon-ops`（`dsh-plugins` 的子目录） |
| `git rev-parse HEAD`（第 1–2 次跑时） | `72d91c0fffb55fcaccdaa44b05acae02e54b9561`；工作区**不干净**（5 个文件 `M`） |
| `git rev-parse HEAD`（第 3 次跑，**签字的那一次**） | `173b36a34eead7ad38c405c97372743cc0ee8272`；工作区 **clean** |
| src+tests 文件数 | 444（SHA256 清单；跑前 05:44:55、跑后 05:48:4x 各一份） |
| 跑前 = 跑后的聚合指纹 | `e659913f2f95cbc98bfb7778863a4709d27b15f204cb73617261854c7f867b9d` |

**本报告有两段状态，必须分开读。** 第 1–2 次跑取自一棵**移动中**的树，数字无效；第 3 次跑在 lead 给出 frozen 信号之后，由跑前跑后两份逐字相同的 SHA256 清单证明是**静止树**，那一行才有效。§三、§四、§五 的代码结论读的都是 HEAD `173b36a`（§三 ①-b / ②-b 的数值在 `173b36a` 上**重新跑过一遍**，与写 §三 时在 `72d91c0` 上取的值逐字相同）。

### 1.2 我实际做的动作

1. 读代码（不改）：`src/domain/keywords/competitor.js`、`src/domain/reports/spend-monthly.js`、`src/domain/keywords/importers.js`、`src/domain/keywords/csv.js`、`src/domain/collect/env.js`、`src/domain/collect/blocked-page.js`、`src/sources/browser/collector.js`、`src/tools/collect-center.js`、`src/web/pages/report.js`、`src/web/routes.js`、`tests/wired-source.mjs`。
2. 纯函数探针（不写库、不联网）：4 组，覆盖 §三 的 ①②③ 与 env.js。
3. `tests/wired-source.mjs` 单独驱动（用它自己的 `{check, equal}` 契约）。
4. 全量 `node tests/run.mjs` 两次。
5. `node scripts/check-page.mjs` 一次。
6. src+tests 的 SHA256 清单（第 2 次跑前取的 `%TEMP%\manifest-run2-before.txt`，443 个文件）。**跑后的那一份没有取到**：第 2 次由 lead 指示中止，没有「跑后」这个时刻。所以「跑前跑后清单逐字相同」这条证明我这一轮**没有**拿到，这也是全量数字仍然不可信的直接原因之一。

### 1.3 我写过的临时文件（已删除）

| 路径 | 用途 | 状态 |
|---|---|---|
| `%TEMP%\probe-verifier.mjs` | §三 ①②③④ 的探针 | 已删 |
| `%TEMP%\probe-wired.mjs` | 第一次尝试驱动 wired-source（参数签不对，作废） | 已删 |
| `%TEMP%\probe-wired2.mjs` | §三 ⑤ 与那条红断言的重跑 | 已删 |
| `%TEMP%\probe-path.mjs` | §三 ①-b / ②-b：查两个「单测修复」在生产路径上触不触发 | 已删 |

运行日志留在 `%TEMP%\verifier-run-full.log`、`%TEMP%\verifier-run2.log`（在系统临时目录，不在仓内），SHA256 清单留在 `%TEMP%\manifest-*.txt`。仓内只新增本文件。

---

## 二、实测数字

### 2.1 全量 `node tests/run.mjs`

| 次 | 起止 | 汇总行（原样） | exit | 有效性 |
|---|---|---|---|---|
| 第 1 次 | 01:05:56 → 01:2x | `2473 passed, 1 failed` | 1 | **无效**：运行期间 `src/`、`tests/` 被改（§四 4.1） |
| 第 2 次 | 01:13:49 → 01:14:3x 中止 | 没有汇总行（中止前 732 条 `ok`） | — | **作废**（树未冻结） |
| **第 3 次（frozen）** | **05:45:0x → 05:48:4x** | **`2490 passed, 0 failed`** | **0** | **有效**：跑前跑后 SHA256 清单逐字相同（§2.4） |

**可信的全量数字：`2490 passed, 0 failed`，exit 0。** 成立条件三条，都在 §2.4 逐条验过：HEAD 固定 `173b36a`、工作区 clean、跑前跑后清单一致。日志里 `ok` 行数同为 **2490**，与汇总行自洽。

与上一批（`72d91c0` 的 `2474 passed, 0 failed`）比：总数 2474 → 2490，**+16**，与 lead 声称的「T71 组④ 定向 16 条」数目一致。

**之后 T-3 落地，我又跑了一轮：`2495 passed, 0 failed`（HEAD `4152d3f`，静止树同样可证）。那一轮的树、清单、T-3 的独立探针全在 §八。**

第 1 次那唯一一条失败，原文：

```
待接线名单里没有已经接好线的（名单必须自我清理）
  Error: 这些条目已经在生产代码里有调用方了，请从 UNWIRED 里删掉：
  src/domain/prompts/render.js  renderPromptTemplate
    at file:///C:/Users/win11/dsh-plugins/amazon-ops/tests/wired-source.mjs:553:13
```

这条失败是**运行中改树造成的竞态，不是代码缺陷**，证据见 §四 4.1。

### 2.2 那条失败在我手上被单独证伪了

拿当前工作区单独驱动 `runWiredSourceTests`（不跑全量）：

| 指标 | 实测值 |
|---|---|
| `UNWIRED.length` | **29** |
| `UNWIRED` 里有 `renderPromptTemplate` 吗 | **false** |
| 实测（扫 src）得到的零调用方条数 | **29** |
| 实测里含 `renderPromptTemplate` 吗 | **false** |
| 会被判成「已接好线却没删」的条目 | **`[]`（0 条）** |
| 该组 `check` 通过 / 失败 | **8 / 0** |

结论：在**自洽**的树上，这条断言过；第 1 次红了，是因为 `UNWIRED` 常量在进程启动时被 `import` 成了旧版（30 条，含该条目），而扫 src 发生在 20 分钟后、那时导出已被删。**同一个进程里两个时刻的两份事实被拿来对比。**

第 3 次（frozen）跑这一组时，`UNWIRED` 与实测都是 29 条、两边都不含 `renderPromptTemplate`，那一组计入 `2490` 里全绿。

### 2.3 `node scripts/check-page.mjs`

```
checking C:\Users\win11\dsh-plugins\amazon-ops\src\web\page.js
OK   ① outer node --check
OK   ③ template literal integrity — 2 template literal(s), 1 nested in ${…}
OK   ② inner node --check (.cjs) — 770716 chars, checked as a sloppy classic script

3/3 passed
[CHECK-PAGE EXIT=0]
```

实测 **3/3 passed，exit 0**。（第 3 次跑完再跑一遍，内层脚本 774027 chars，同样 `3/3 passed`。）

### 2.4 静止树的证明：跑前 / 跑后清单比对

lead 给的 frozen 四样，我逐样核过：

| lead 给的 | 我的核实结果 |
|---|---|
| `git HEAD = 173b36a34eead7ad38c405c97372743cc0ee8272` | ✅ `git rev-parse HEAD` 逐字相同 |
| `worktree = clean` | ✅ `git status --porcelain` 在跑前、跑后各取一次，都是空 |
| `manifest = team/qa/sha256-pre-freeze-2026-10-25.txt`（436 个文件） | ⚠️ **不在仓库里，实际在工作区根** `…\default-workspace\team\qa\`（§6.6）。找到后我核了它：**5/436 条对不上**，见下 |
| 聚合指纹 `f4f84ab5…5811` | ✅ **复现成功**：436 行数据行用 `\n` 连接后取 SHA256，正好等于这个值。拼接方式已确定 |

**但我核了那份清单的逐条哈希，它描述的不是被签署的这棵树**（把清单从工作区根找出来之后才知道）：

| 清单条数 | 与当前工作区逐字节相同 | 不同 | 不存在 |
|---|---|---|---|
| 436 | **431** | **5** | 0 |

5 条不同，且**不是行尾差异**（`CRLF→LF` 的各种变体逐一试过都不命中，是内容真的不同）：

| 文件 | 清单里的哈希 | 当前树（= `173b36a`）的哈希 |
|---|---|---|
| `src/domain/keywords/importers.js` | `3353701fee9a…` | `80b4ad3295aa…` |
| `src/domain/reports/spend-monthly.js` | `5b2ebd476d8a…` | `c91e292c2745…` |
| `src/store/kw.js` | `5c5e31e56b23…` | `a6b409cfdd79…` |
| `src/store/schema.js` | `5f86677d92ee…` | `f485660acfc1…` |
| `tests/run.mjs` | `d5132059dfa0…` | `fb488814cb49…` |

**结论**：那份「pre-freeze 清单」是在这 5 个文件到达当前内容**之前**取的——它的表头写着 `git HEAD: 173b36a` 与 `worktree: clean`，却与自己那 5 条哈希矛盾。**所以它不能当作签署树的基线证据**；能用的是下面这份与它无关的自取清单。流程教训：**基线清单必须与被签署的那个提交同时生成、并当场复核一遍逐条哈希**，否则它会成为一份看起来很权威、实际描述另一棵树的东西。

我自己的清单（`src/**` + `tests/**` 全量文件，SHA256）：

| | 文件数 | 聚合指纹 |
|---|---|---|
| 跑前 05:44:55 | 444 | `e659913f2f95cbc98bfb7778863a4709d27b15f204cb73617261854c7f867b9d` |
| 跑后 05:48:4x | 444 | `e659913f2f95cbc98bfb7778863a4709d27b15f204cb73617261854c7f867b9d` |
| 比对 | **`Compare-Object` 无差异，444 行逐字相同** | ✅ |

跑后复核：`HEAD` 仍是 `173b36a`，`git status --porcelain` 仍是空。**所以那次 `2490/0` 是在一棵被两份相同清单夹住的静止树上取的。**

**436 与 444 的差**：我按扩展名数了一遍，`src` 260 个 `.js` + `tests` 176 个 `.mjs` = **436**，另有 6 个 `.html`、1 个 `.xlsx`、1 个 `.json` = 8。**444 = 436 + 8**。所以 lead 那个 436 的口径是「只收 `.js`/`.mjs`」，与我这份清单的子集精确吻合——**数目对，但那 436 条里有 5 条的哈希描述的是一棵更早的树**（见上表）。

---

## 三、抽样审计逐条结果

四个被审计文件在 `72d91c0` 上取过值；其中两个在 `173b36a` 里又被改过（①-b 的回退与 ②-b 的文件头注记），所以**它们在签署树 `173b36a` 上重测过一遍**，数值与原文逐字相同（§1.1 末段）。`env.js` 与 `importers.js` 两个提交之间没有变化。

| 文件 | 最后修改提交 |
|---|---|
| `src/domain/keywords/competitor.js` | `173b36a` 2026-10-25（①-b 回退 + 9 行说明） |
| `src/domain/reports/spend-monthly.js` | `173b36a` 2026-10-25（②-b 的 T-3 注记） |
| `src/domain/keywords/importers.js` | `2b0737a` 2026-10-25 |
| `src/domain/collect/env.js` | `5f92f75` 2026-10-10（**本批之前**，见 §6.4） |

### ① 竞品象限 `classifyQuadrant` — **函数级修复是真的，但生产路径上不触发（见 ①-b，P1）**

实测（`node` 直接调用导出函数）：

| 输入 | 返回 |
|---|---|
| `{our_status:'ranked', competitor_ranked_count:null, competitor_best_rank:null}` | **`unmeasured`** |
| `{our_status:'ranked'}`（两键缺失） | `unmeasured` |
| `{our_status:'ranked', competitor_ranked_count:undefined, competitor_best_rank:undefined}` | `unmeasured` |
| `{our_status:'ranked', competitor_ranked_count:0, competitor_best_rank:null}` | `ownAdvantage` |
| `{our_status:'ranked', competitor_ranked_count:2, competitor_best_rank:5}` | `contested` |
| `{our_status:'ranked', competitor_ranked_count:null, competitor_best_rank:null, competitor_total:0}` | `unmeasured` |
| `classifyQuadrant(undefined)` | `unmeasured` |
| 整批 `[第1行, 第4行]` | `ownAdvantage:1, contested:0, ourAbsent:0, unmeasured:1, brandOnly:0`；`classified:2 == inputTotal:2`；`candidates:0` |

**你要的那个输入返回 `unmeasured`，不是 `ownAdvantage`。这条修复成立。** 且反向也对：`competitor_ranked_count:0`（真的测过、真的 0 个上榜）仍返回 `ownAdvantage` —— 修复没有把闸门修成「一律 unmeasured」。代码依据：`competitor.js:279-284` 先算 `measured` 布尔，`!measured` 直接落 `unmeasured`。

#### ①-b 但在生产路径上，这个修复**不触发**（P1）

`classifyQuadrant` 的输入行不是调用方手写的，是 `quadrantRows()`（`competitor.js:347`）造的。它把竞品侧的两个计数**强制成数字**：

```js
competitor_best_rank:    their?.bestRank     ?? null,        // :367  缺失 → null
competitor_ranked_count: Number(their?.rankedCount ?? 0),    // :368  缺失 → 0  ← 在这里被抹平
competitor_present_count: Number(their?.presentCount ?? 0),  // :369
```

于是「竞品侧这个词完全没有事实」（`their === undefined`）造出来的行里，`competitor_ranked_count` 是**数字 0**，不是 null。`classifyQuadrant` 的 `measured` 判据（`:279`）看到 0 就认为「测过」，`theyRank` 为 false，落到 **`ownAdvantage`**。

实测（真 `quadrantRows` + 真 `classifyQuadrant`，没有造假行）：

```
输入 sides = { ours:{'bench cushion':{rank:5,scanDepth:20}}, theirs:{}, peers:['B0PEER0001'] }

quadrantRows 产出 → {"keyword":"bench cushion","our_rank":5,"our_scan_depth":20,"our_status":"ranked",
                    "competitor_best_rank":null,"competitor_ranked_count":0,"competitor_present_count":0,
                    "competitor_total":1,"competitor_asins":[],"no_data":true}
competitor_ranked_count 的值与类型 → [0, "number"]
classifyQuadrant(这一行)          → "ownAdvantage"      ← 期望 unmeasured
classifyQuadrants 的 counts        → {"ownAdvantage":1,"contested":0,"ourAbsent":0,"unmeasured":0,"brandOnly":0}
候选词数                            → 0
对照：手工把 ranked_count 改成 null → "unmeasured"        ← 修复本身是好的
```

**「我们上榜、竞品这个词从没测过」仍然被判成「自有优势」。** 四个生产调用方全都喂 `quadrantRows`，没有一个在中间把该字段还原成 null：

| 调用方 | 行 |
|---|---|
| `src/domain/asin/competitor.js:135` | `quadrantRows(sides).map(row => ({...row, …}))` — 只覆盖扫描深度与周期字段，不动两个计数 |
| `src/domain/optimize/evidence.js:305` | `classifyQuadrants(quadrantRows(sides), …)` |
| `src/tools/competitor.js:344` | `const rows = quadrantRows(sides)` |
| `src/web/routes.js:5291` | `classifyQuadrants(quadrantRows(sides), …)` |

反面对照也做了：竞品侧**真的有事实**、`rankedCount: 0` 时，行里 `no_data: false`、同样 `competitor_ranked_count: 0`、同样判 `ownAdvantage`——这一次是对的。**问题正在于这两种情形在行上长得一模一样**：行里唯一能区分它们的 `no_data` 布尔（`:373`），`classifyQuadrant` 与 `classifyQuadrants` 都没有读。

这条不是「桶里多了一个词」那种轻微问题，它会让**同一行自己打自己**：`no_data` 的消费方是有的——`src/web/pages/asin.js:1222` 在「对端命中」那一格按 `row.no_data === true` 印「该词无竞品数据」，`src/tools/competitor.js:252` 也印一句「这几条竞品侧没有数据（no_data），不是「竞品排名 0」」。于是同一行左边是「自有优势」的桶标签，右边那一格写着「该词无竞品数据」。**页面自己承认没数据，桶却给了结论。**

所以定性是：**单元级修复成立，端到端不成立**。缺的一步是 `quadrantRows:368-369` 改成 `their === undefined ? null : Number(their.rankedCount ?? 0)`（或让 `classifyQuadrant` 读 `no_data`）。这条与 ②-b 是同一个缺陷类在「上一层」的复发。

### ② 月报 `spendReport` — **函数级修复是真的；生产数据里触发不了（见 ②-b，P1）；同一文件还有一处没修**

实测（单行 `spend: null`，`period:'2026-10'`）：

```json
{"month":"2026-10","spend":0,"sales":120.5,"orders":3,"clicks":10,"keywords":1,
 "roas":null,
 "roasReason":"该月 1 行没有花费数据 —— 花费显示 0 是「没数据」，不是「没花钱」",
 "missing":{"spend":1,"sales":0,"orders":0,"clicks":0},"overlappedKeys":0}
```

- `missing.spend` = **1** ✔
- `roasReason` 含「没有花费数据」✔
- `totals.missingRows` = `{"spend":1,...}` ✔（合计层也认账，不只月度层）
- 反向对照：`spend:'0'`（字面量 0）→ `missing.spend = 0`，`roasReason` = 「该月花费为 0，ROAS 无意义（不是 0，也不是无穷）」。**0 与缺失分得开** ✔

#### ②-b 但在生产数据上，`missing.spend` **永远触发不了**（P1）

`spendReport` 的 `missing.spend` 只在 `numericOrNull(entry.row?.spend) === null` 时 +1（`spend-monthly.js:129`）。问题是 `kw_ad_fact.spend` 这一列**永远不可能是 NULL**——写入方在落库前就把它抹成 0 了：

```js
// src/store/kw.js:294  （upsertAdFacts，kw_ad_fact 的唯一写入点）
num(fact.spend) ?? 0, num(fact.sales) ?? 0, …
```

实测（桩 store 捕获 `store.run` 的实参数组，`spend` 是 `params[7]`）：

```
输入三行 facts 的 spend = [null, 0, 7.5]
实际写入库的值        → [["bench cushion",0], ["rocker cushion",0], ["zero spend word",7.5]]
其中有没有 null        → false
```

上游还有第二道同样的抹平：广告报告导入器 `importers.js:418` `entry.spend += toNumber(cell(row, col.spend), { fallback: 0 }) ?? 0`——`entry.spend` 从 `0` 起（`:405`），只会累加数字，产出里没有 null 这个可能。

`kw_ad_fact` 的写入点全仓只有 `src/store/kw.js:279` 一处（`INSERT INTO kw_ad_fact` 的 grep 结果；`schema.js:714` 是建表）。

**后果**：`missing.spend` 在生产数据上恒为 0，`roasReason` 永远走「该月花费为 0，ROAS 无意义」那一支。用户拿到的月报仍然是**「花费 0」**，只是旁边多了一句更体面的解释；修复新增的「有 N 行没有花费数据」那句话，从现有导入路径**一次都不会出现**。

这不是说 ② 的改动是假的——它把 `monthly` 分支的口径修对了，单元级可证。但**「月报不再把缺花费算成 0 花费」这个对外说法，端到端不成立**：要成立必须同时改 `store/kw.js:294`（`num(fact.spend)` 保留 null，或 `num(fact.spend)` 不套 `?? 0`）与 `importers.js:418`（累加时区分「没有这一格」与「这一格是 0」）。这两处都在本次「修复」的写域之外。

**未修的那一处（本次新发现）：** `undated` 分支（`spend-monthly.js:101-108`）。

输入：

```json
{"keyword":"x","marketplace":"US","period":null,"first_date":null,"last_date":null,
 "spend":null,"sales":1,"orders":0,"clicks":0,"source_file":"a.xlsx"}
```

实测输出：

```json
{"keyword":"x","marketplace":"US","period":null,"spend":0,
 "reason":"period / first_date / last_date 都读不出年份与月份"}
```

`undated[0].spend === 0`，**没有任何缺失标记**。同一份 `spend:null` 在 `monthly` 分支会 `missing.spend += 1`，在 `undated` 分支被写成读数 0。这是同一个缺陷类的下一处，被「按月份聚合」那条路径挡住了视线。

影响面要说清，别夸大：`src/web/pages/report.js:274-277` 目前只用 `data.undated.length` 印一句「有 N 条读不出月份」，**不逐行渲染 `undated[].spend`**，所以用户在页面上暂时看不到那个 0。但 `/api/state` 的 `spendMonthly` 切片（`src/web/routes.js:3992`）原样带着这个对象，任何按行消费 `undated` 的调用方拿到的就是 0。定位：**载荷里的潜在谎言，尚未上屏。**

### ③ 导入搜索量 `importBrandTerms` — **修复是真的，三态分得开**

实测（一份 ABA 品牌视图 CSV，表头 `搜索查询,搜索查询分数,搜索查询数量`，三行量的格子分别是 空 / `0` / `500`）：

| 行 | `keyword` | `searchVolume` | JS 类型 |
|---|---|---|---|
| 1（空格子） | `bench cushion` | **`null`** | `object`（即 `null`） |
| 2（字面量 0） | `rocker cushion` | **`0`** | `number` |
| 3（500） | `zero vol word` | **`500`** | `number` |

`stats` = `{"rowsRead":3,"facts":3,"skipped":0,"headerRow":2}`。

**空量是 `null` 不是 0；字面量 0 仍是 0。** 代码依据：`importers.js:303` 调 `toNumber(cell(...))` 不传 `fallback`，而 `csv.js:64` 的默认 `fallback = null`；同一文件另外两处反查导入（`:561`、`:800`）本来就是 null。

下游不会把它变回 0：`src/domain/keywords/pipeline.js:280` 用 `COALESCE(excluded.search_volume, keyword.search_volume)` 写库，`src/store/keyword-detail.js` 的 `num()` 对 null 返回 null。**这条链路是通的。**

### ④ `env.js` 的 `repairRefusal` — **`?? 0` 只是口径退化；真正的问题是它下游那条永不重置的计数器（P0，见 §五）**

见 §五 独立一节。一句话：`?? 0` 本身是策略回退、不是渲染，**这一点 lead 说得对**；但往下追 `diagnostics.blocked` 的生命周期，会发现一个比 `?? 0` 严重的问题，报告见 §五。

### ⑤ `tests/wired-source.mjs` 的 `renderPromptTemplate` 条目 — **在 HEAD 上它是合规的**

先说结论，再给两个状态。

**HEAD（`72d91c0`）上这条存在，且「到期日 + 后续单号」两样都有。** 原文（`git show HEAD:amazon-ops/tests/wired-source.mjs`）：

```
L333: **到期日 2026-10-31，后续单号 T77**；到期仍未接，按技术债入账，不许留在名单里消失。 */
L334: { name: 'renderPromptTemplate', file: 'src/domain/prompts/render.js', kind: 'test-only',
        note: 'T73 严格渲染器；…本体只剩测试在调。到期 2026-10-31，后续单 T77：要么并进 WithReport，
        要么删掉——一条不许留' },
```

所以按「队列不是墓园」（每条要有到期日与后续单号）这条规矩，**HEAD 上它不违规**。

**工作区（未提交）上这条已经被处理掉了，方式是删除，不是我先前以为的「还挂着」。** 当前 `UNWIRED.length = 29`，`renderPromptTemplate` 既不在名单里、也不再从 `src/domain/prompts/render.js` 导出（导出被删，只留 `renderPromptWithReport`），`tests/t73-prompt-variables.mjs:38` 改用本地一行 shim。这条 T77 的处理方式与它自己 note 里写的两个出口（「要么并进 WithReport，要么删掉」）里的第二个一致。

**要提请注意的一点：** 这个处理在工作区里**未提交**。我实测的「29 条、8/0 通过」是未提交状态的结论；HEAD 上是「30 条、含该条目」。这两种状态各自自洽，但把 `git status` 里的 `M` 忽略掉会得到互相矛盾的读数——第 1 次全量的那条红就是这么来的。

---

## 四、与 lead 声称的不一致处

### 4.1 「2474 passed / 0 failed」——我观测到的是 `2473 passed / 1 failed`

| | lead 声称 | 我实测（第 1 次） |
|---|---|---|
| passed | 2474 | **2473** |
| failed | 0 | **1** |
| 合计 | 2474 | 2474 |

差 **1 条**，就是 `待接线名单里没有已经接好线的（名单必须自我清理）`。总条数两边一致（2474），所以这不是「多跑/少跑了一组」，而是同一条检查在两边结论不同。

**差异原因（可复核）：**

1. `tests/run.mjs` 在进程启动时 `import` 了 `tests/wired-source.mjs`，那一刻的 `UNWIRED` 常量有 30 条（含 `renderPromptTemplate`）。
2. 该检查的运行位置在套件很后面（`run.mjs:11406`），约 20 分钟后。它此时才扫 `src/**`，而 `src/domain/prompts/render.js` 已在 01:06:31 被改成不再导出 `renderPromptTemplate`。
3. 于是「名单里有、实测里没有」→ 被判成「已经接好线了却没从名单里删掉」。

文件 mtime 证据（这是我第 1 次 run 启动之后的时间戳）：

| 文件 | mtime | 相对我的启动（01:05:56） |
|---|---|---|
| `tests/t73-prompt-variables.mjs` | 01:05:54 | 早 2 秒 |
| `tests/wired-source.mjs` | 01:06:09 | **晚 13 秒** |
| `src/domain/prompts/render.js` | 01:06:31 | **晚 35 秒** |
| `src/domain/keywords/key.js` | 01:07:01 | 晚 65 秒（内容未变，git 不认） |
| `src/tools/optimize.js` | 01:07:00 | 晚 64 秒（内容未变，git 不认） |
| `src/domain/geo/citability.js` | 01:12:43 | **晚 6 分 47 秒** |
| `src/web/pages/asin.js` | （01:14 前） | 晚于启动 |

**对 lead 的 `2474/0`，我的判断：我复现不了它，也无法从任何一份我自己取到的读数里推出它。** 它与我第 1 次的差正是那条自检断言，而那条断言在自洽的树上会过（§2.2 已单独证过）。所以两种来源我分不开：取自一棵自洽的树，或取自我没看到的另一份代码。两边都不能作为「这批是绿的」的独立证据——一个是别人跑的（我不能复现），一个是我在动树上跑的（不成立）。

**补记（frozen 之后）**：lead 后续给的是 `2490/0`，我在冻结树上跑出来是 **`2490 passed, 0 failed`，逐字一致**（§2.1 第 3 行）。所以 4.1 这条不一致只存在于「01:0x 那两次」那个时间窗里，**不是长期分歧**；它记录的是一次**流程事故**（运行中改树），而不是一个**数字造假**。这两件事性质不同，我不把它们混在一起说。

### 4.2 抽样任务书里「现在有 `renderPromptTemplate` 一条」——对 HEAD 成立，对工作区不成立

见 §三 ⑤。任务书描述的是 HEAD 状态；工作区已经删掉该条目与对应导出，但**未提交**。

### 4.3 「三处缺失被写成 0 都修好了」——按月报看，`undated` 分支没动；按端到端看，① 与 ② 见 4.4

见 §三 ② 的「未修的那一处」：`undated` 分支仍把 `spend: null` 写成 `spend: 0`。这一条与 4.4 不是同一件事：这里是「同一文件少改了一个分支」，4.4 是「改对了的分支在生产数据上触发不了」。

### 4.4 「三处都修好了」——我先前也签了 ① 与 ②，现在收回端到端那一半

这一条是我**自己先签错、后来自己推翻**的，记在这里以免读者只看 §三 的表格。

第一轮抽样我只验了函数本身：`classifyQuadrant` 返回 `unmeasured`、`spendReport` 的 `missing.spend` 是 1。两个都对。但「函数对」不等于「修复生效」——这些函数的输入是别人造的：

| 说法 | 函数级 | 端到端 | 原因 |
|---|---|---|---|
| ① 竞品象限：未测不判 `ownAdvantage` | 成立 | **不成立** | `quadrantRows:368` 把「竞品侧没事实」写成数字 `0`，`classifyQuadrant` 的 `measured` 判据看到 0 就认为测过 → 仍判 `ownAdvantage` |
| ② 月报：缺花费不再被算成 0 花费 | 成立 | **不成立** | `store/kw.js:294` 的 `num(fact.spend) ?? 0` 让 `kw_ad_fact.spend` 永不为 NULL → `missing.spend` 恒为 0 |
| ③ 导入搜索量：缺失是 null 不是 0 | 成立 | **成立** | 下游 `pipeline.js:280` 用 `COALESCE` 保住 null，`keyword-detail.js` 的 `num()` 对 null 返回 null——这条链路我单独验过 |

**教训（对这批工作的直接指向）**：三处都是「把缺失写成 0」，也都修在了**读的那一端**，而 ① 和 ② 的 0 是在**写的那一端**就已经写进去了。只修读端，单元测试会绿（测试自己造 `null` 输入），生产数据里那个 `null` 根本不存在。

### 4.5 「`repairRefusal` 的 `blocked ?? 0` 判为误报」——lead 已当场撤回，我同意撤回；但理由与 lead 原来的不同

lead 最初的理由是「读不到浏览器状态时不拦是刻意的宽松，且主动要求绕过验证码那一路仍然拒绝」。分两半：

- **「主动要求绕过仍拒绝」这一半，实测成立**：`repairRefusal({action:'mkdir', args:{bypassCaptcha:true}, collector:null})` → `CAPTCHA_NOT_BYPASSABLE`；`args.captcha === true` 同样。它不依赖 `?? 0`，是独立条件。
- **「刻意宽松」这一半，代码里找不到依据**：`env.js:664-680` 那段文档注释写的是四条常设拒绝，验证码那条的定义是「上一次运行看到了机器人校验，或调用方要求我们绕过」；没有任何一处注释或断言说明「读不到就放行」是设计意图。同一个仓里 `blocked-page.js:128-146` 反而把这件事写得很清楚——`liveReading` 专门把 `'unreadable'`（没读到快照）与 `'absent'`（读了、不在）分成两个答案，并写明「「我们没法看」与「我们看了、它不在」是两句话」。**`?? 0` 恰好把这两句合并成一句。**

所以：判「违例」还是「误报」，取决于口径。我按仓内自己的口径（`blocked-page.js`）判，**`?? 0` 是口径退化**；但它的实际危害比 lead 说的、也比我最初想的都小，因为真正的问题是下面 §五 那条 P0，而 `?? 0` 只在 `collector` 为 null 或 `diagnostics()` 返回没有 `blocked` 的对象时才生效。

### 4.6 「t73e 生产路径那两条断言我删掉了」——按 git 看是**没有删过**

lead 的原话是「生产路径那两条断言我**删掉了**」。我核了 `72d91c0 → 173b36a` 的 `tests/t73e-missing-is-not-zero.mjs` diff：

```
+tests/t73e-missing-is-not-zero.mjs | 16 ++++++++++++++++
```

**只有新增 16 行注释，删除 0 行。** 那 16 行注释正好是解释「为什么这里不写生产路径断言、为什么回退、T-4 在哪」的那一段，并且注明了是我这轮抓到的。

所以能确认的事实是：**现在这个文件只有 6 条函数级断言（①–⑥），没有生产路径断言**——这一点 lead 说得对，我也独立验过（`Select-String 'check\('` 只有 6 条，内容都是喂构造行给函数）。不能确认的是「删掉了」这个动作：在 git 里那两条断言从来没被提交过，所以它们要么只存在于某个未提交的中间状态，要么根本没写。

**这不是造假，是措辞**：结论一样，但报告里必须写成「现在没有」，不能写成「删掉了」——因为后者暗示曾经有过一个可回滚的版本，而 git 里没有。

### 4.7 frozen 信号里的两样东西，我先在仓库里零命中，后来在工作区根找到了

lead 的 frozen 消息点名了 `team/qa/sha256-pre-freeze-2026-10-25.txt`（436 个文件 + 聚合指纹）与 `team/qa/fallback-zero-backlog-2026-10-25.md`（T-3 / T-4 的台账）。

我按**仓库根**找，两个都零命中，于是当时写成「不存在」。**这个结论是错的，已更正**：它们在**工作区根** `…\default-workspace\team\qa\` 下，不在 git 里。原因与更正见 §6.6。

更正之后我做了两件本该做的事，都不利：**（1）冻结清单的 436 条里有 5 条的哈希描述的是更早的树**（§2.4）；**（2）台账缺 T-3 / T-4 / `storefrontMiss` 三条**，且有一条「已修」写得过头（§6.6）。

---

## 五、`env.js` / `collector.js`：一条 P0（lead 要求写成独立一节）

### 5.1 症状

插件进程生命周期内，只要**采集被风控截停过一次**，此后该进程里**每一次** `amzn_collect_repair` 都会被 `CAPTCHA_NOT_BYPASSABLE` 拒掉——包括 `mkdir` 这种纯文件系统动作。拒绝文案是「目标页是验证码/反机器人页 / 不绕过验证码」，而此时那个页面很可能早已关闭。**修复功能在第一次遇到验证码之后永久失效，且给出的理由是错的。**

### 5.2 调用链（逐跳）

```
src/tools/collect-center.js:120
  await repairEnvironment({ ...context(deps), ...args, args })
    context(deps) → { collector: deps.collector ?? null, … }        collect-center.js
  ↓
src/domain/collect/env.js:749
  const refusal = repairRefusal({ action: chosen, args, collector, chromePath })
  ↓
src/domain/collect/env.js:706
  const blocked = collector?.diagnostics?.()?.blocked ?? 0
  ↓
src/domain/collect/env.js:707-714
  if (blocked > 0 || args?.bypassCaptcha === true || args?.captcha === true)
    return { ok:false, code:'CAPTCHA_NOT_BYPASSABLE', … }
```

拒绝发生在 `APPROVAL_REQUIRED`（`env.js:756`）之前，所以连「带上 `confirm:true` 重试 `launch_browser`」这条路也先被它挡掉。

### 5.3 `diagnostics.blocked` 的生命周期（静态证据）

`src/sources/browser/collector.js`：

| 位置 | 代码 | 性质 |
|---|---|---|
| `:117` | `at: null, ok: 0, selectorMiss: 0, blocked: 0, failed: 0, storefrontMiss: 0, storefrontAdjusted: 0,` | 对象字面量初始化，**每进程一次** |
| `:445` | `diagnostics.blocked += 1` | 每被截停一个目标 +1 |
| `:673-678` | `diagnostics.at / ok / selectorMiss / failed / storefrontAdjusted / missing` = 本轮值 | 每轮结束的复位块，**清单里没有 `blocked`** |
| `:933-939` | `diagnostics: () => ({ ...diagnostics, missing: [...], blockedPage: … })` | 读出去的就是那个累计值 |

**全文件对 `.blocked` 的写只有 `:445` 一处。** 用 `Select-String -Pattern '\.blocked\b'` 扫 `src/sources/browser/collector.js` 只命中一行（L445）。也就是说：**初始化一次，此后只增不减，永不重置。**

这与同一文件里另外四个字段的写法不一样：`written` / `failed` / `selectorMiss` / `storefrontAdjusted` 都是每轮的**局部变量**，跑完在 `:673-678` 一次性赋给 `diagnostics`。`blocked` 与 `storefrontMiss` 是仅有的两个直接挂在对象上累计的字段。

### 5.4 复现步骤（我实际跑的）

```js
const { repairRefusal } = await import('file:///C:/Users/win11/dsh-plugins/amazon-ops/src/domain/collect/env.js')

repairRefusal({ action: 'mkdir', collector: { diagnostics: () => ({ blocked: 1 }) } })
// → {"ok":false,"code":"CAPTCHA_NOT_BYPASSABLE","error":"目标页是验证码/反机器人页","hint":"不绕过验证码"}

repairRefusal({ action: 'mkdir', collector: { diagnostics: () => ({ blocked: 0 }) } })
// → null                                  // 放行

repairRefusal({ action: 'mkdir', collector: null })
// → null                                  // 放行（?? 0 生效）

repairRefusal({ action: 'mkdir', collector: { diagnostics: () => ({}) } })
// → null                                  // 「读不到」被当成 0
```

桩的形状与真实 `diagnostics()` 的返回一致（`:933` 展开同一份对象），所以这不是造了个假输入：**`blocked >= 1` 就是一个真实进程在被真拦过一次之后的真实返回值。**

**端到端复现（需要真浏览器，我没做，标「未取得」）**：启动插件 → 对一个必然触发风控的目标采一次（`diag.blocked` 变 1）→ 再调 `amzn_collect_repair {action:'mkdir', profileDir:'<任意>'}` → 预期被 `CAPTCHA_NOT_BYPASSABLE` 拒绝、目录没被创建。没做的原因：需要真实浏览器与真实风控页，且本席不主动触发站点风控。

### 5.5 改法（两条都要；lead 倾向前者，我认为后者不能省）

**(1) `blocked` 改成按轮次**（与现有 4 个字段同形，改动约 3 行）：

- `collect(request)` 里加一个本轮局部的 `let blocked = 0`
- `:445` 改成 `blocked += 1`
- `:673-678` 的复位块里加 `diagnostics.blocked = blocked`

**只做这一条不够**：重跑一轮之后 `blocked` 会归零，但这一轮里如果又被拦，下一条 `mkdir` 仍会被拒——而「这一轮被拦过」与「现在不能 mkdir」之间没有因果关系。

**(2) `repairRefusal` 里把「读不到」与「读数是 0」分开，并按动作分档：**

```js
const snapshot = typeof collector?.diagnostics === 'function' ? collector.diagnostics() : null
/* 三态：null = 读不到（不是 0）；number = 读到的累计值 */
const blocked = (snapshot === null || typeof snapshot.blocked !== 'number') ? null : snapshot.blocked
```

- `blocked !== null && blocked > 0`，或 `args.bypassCaptcha === true`，或 `args.captcha === true` → 保持现在的拒绝。
- `blocked === null` → **不要当 0**：
  - `mkdir` / `launch_browser` / `reconnect_port` 放行（这三个都不打开站点页面：`mkdirSync` 见 `:775`；`launch_browser` 只 `ensureBrowser`；`reconnect_port` 只 `collector.close()` + 探端口，见 `:793-806`）；
  - `set_context` 拒绝，文案改成「读不到上一次采集是否被拦，先不要动站点上下文」——因为它是**唯一会真的访问 Amazon 的修复动作**：`env.js:815-821` 里 `navigate(cdp, page.sessionId, 'https://' + storefront.domain + '/')` 然后 `ensureStorefront` 操作配送地址对话框。在风控状态未知时导航进站点，是这四个动作里唯一有代价的那个。

顺带：`.blocked` 该不该由 `repairEnvironment` 来判，本身也值得问一句——`mkdir` 的成败与站点风控无关，把风控闸门放在四个动作共用的入口上，等于用一个远端状态否决一个本地动作。

### 5.6 顺带发现的同形缺陷（静态证据，未实测）

`diagnostics.storefrontMiss` 有完全一样的形状：`:544` `diagnostics.storefrontMiss += 1`，复位块 `:673-678` 里同样没有它，**全仓只有这一处写**。而它被写进**本轮**结果：`collector.js:686` `storefrontMiss: diagnostics.storefrontMiss`。

后果：同一进程里第二次采集的 `result.storefrontMiss` 会带上第一次的数。这条我只做静态推断，**没有跑两轮采集去复现，实测值：未取得**。改法与 (1) 一样（本轮局部量 + 复位块赋值）。

---

## 六、结论：能不能签「这批是绿的」

### 6.1 原来挡着我的五条，现在两条解决、三条改了性质

| 原来的理由 | 现在 |
|---|---|
| ① 没有静止树上的全量数字 | **已解决**：`2490 passed, 0 failed`，exit 0，HEAD `173b36a`，工作区 clean，跑前跑后清单逐字相同（§2.4） |
| ⑤ T77 未提交、HEAD 与工作区互相矛盾 | **已解决**：T77 随 `173b36a` 提交进去。`src` 里 `renderPromptTemplate` 只剩 `render.js:170` 注释里的一个名字，导出已删；`UNWIRED` 里那条归零，`wired-source` 那组实测 8/0 |
| ② §五 的 P0 未修 | **性质变了**：它**不是本批引入的**（见 6.4），所以不该阻断「本批是否绿」；但它仍然是**未修的真缺陷**，进 6.5 清单 |
| ③ §三 ①-b / ②-b 两条 P1 | **性质变了**：lead 已回退 ①-b 并升级为 **T-4**、把 ②-b 记为 **T-3**，代码里有注释写明（见 6.2）。按 §6.3 原来的第 5 条约定，这属于「已知未修、进下一批次」，不阻断签字 |
| ④ §三 ② 的 `undated` 分支未修 | **仍然未修**，进 6.5 清单 |

### 6.2 我**不签**的那一句话

> 「三处『缺失被写成 0』都端到端修好了。」

| 项 | 函数级 | 端到端 | 现状 |
|---|---|---|---|
| ① 竞品象限 | 成立 | **不成立** | lead 已**回退**，升级为 **T-4 待拍板**（判定为产品口径变更而非 bug）；`competitor.js:368-376` 有 9 行注释说明为什么回退，并保留 `classifyQuadrant` 的 null 分支作防御 |
| ② 月报 | 成立 | **不成立** | 记为 **T-3**；`spend-monthly.js:37-41` 写死「这一列装不下 null」「只是**函数级正确**，不许当成「已经在线上生效」来讲」 |
| ③ 导入搜索量 | 成立 | **成立** | 三处里唯一端到端成立的 |
| ② 的 `undated` 分支 | — | **不成立**（`spend: 0`，无标记） | 遗留，未修 |

这一句我只覆盖它真正覆盖的部分：**③ 的端到端 + ①② 的函数级**。

### 6.3 我签的字（分项，不许合并引用）

| 项 | 签署 |
|---|---|
| 全量 `node tests/run.mjs` | **`2490 passed, 0 failed`，exit 0**，静止树可证（§2.4） |
| `node scripts/check-page.mjs` | **3/3 passed，exit 0** |
| ③ 导入搜索量「缺失 → `null`」 | **签，含端到端** |
| ① 竞品象限函数级（喂 null → `unmeasured`） | **签，仅函数级**；生产路径仍判 `ownAdvantage`，T-4 未决 |
| ② 月报函数级（`missing.spend=1` + 理由文案） | **签，仅函数级**；线上触发不了，T-3 未决 |
| ② `undated` 分支 | **不签**（仍是 `spend: 0`） |
| §五 的 P0（`diagnostics.blocked` 永不重置） | **未修**，见 6.5 |
| 「这批的测试树是绿的」 | **签**（第一轮 `173b36a` = `2490/0`；第二轮 `4152d3f` = `2495/0`，见 §八） |
| T-3（花费缺失端到端） | **签，范围见 §8.4**：只到「源单元格空 → 标记 → 月报计数」，**不含历史行、不含 T-2** |
| 「三处缺失被写成 0 都端到端修好了」 | **不签** |

### 6.4 P0 与本批的关系：它**不是本批引入的**

要说清楚，否则我签的「本批绿」会被这条 P0 无端拖住：`src/domain/collect/env.js` 最后一次提交是 `5f92f75`（**2026-10-10**），`collector.js` 的 `blocked` 计数器更早。**这条 P0 在本批之前就存在**，本批没碰它、也没让它变严重。同理 `undated` 分支是本批之前就有的写法（本批只动了 `monthly` 那一支的缺失计数）。

我把这条单列出来，是为了让签字可被反驳：**若有人认为 P0 该阻断本批，那是「本批验收范围要不要包含历史缺陷」的口径问题，不是我报的事实有问题。**

### 6.5 还没了的三件（按我建议的优先级）

1. **§五 P0**——进程内被拦过一次之后，修复功能永久失效且理由指错页面。影响可用性，建议先修。改法见 §5.5 两条，两条都要。
2. **`undated` 分支**（`spend: 0` 无标记）——载荷里的潜在谎言，尚未上屏。
3. **`storefrontMiss` 同形**（静态证据，未实测）——同进程第二次采集的 `result.storefrontMiss` 会带上第一次的数。

### 6.6 两个 `team/` 根（lead 已认，正在修）+ 台账覆盖面核查

**我先前写「全仓不存在」是错的，已更正。** 那份台账与冻结清单**存在**，只是在**另一个根**下：

| 根 | 路径 | 是否在 git 里 |
|---|---|---|
| 仓库根 | `amazon-ops\team\` | **在**（本报告、dev 的文档在这里） |
| 工作区根 | `…\default-workspace\team\` | **不在**（lead 的台账、决策、需求在这里） |

所以 `team/qa/` 在两个根下各有一半，而已提交的源码注释写的是相对路径 `team/qa/…`，只有一半能解析。lead 已认这是调度问题，处理方案是：把被引用的两份搬进仓库 `amazon-ops/team/qa/`、加 `team/README.md` 写死约定。

#### 我对台账（`fallback-zero-backlog-2026-10-25.md`，工作区根那份）的覆盖面核查

lead 要我核它是否覆盖 §6.2 里所有「已知未修」项。**结果是：缺三条，且有一条「已修」写得过头。**

| 我列的已知未修项 | 台账里有吗 | 说明 |
|---|---|---|
| §五 P0（`diagnostics.blocked` 永不重置） | ✅ 有，编号 **T-1** | 写得比我详细，还单独核了一遍 `collector.js:117/445/675-677`；已署名记我 |
| §三 ② 的 `undated` 分支 | ✅ 有，编号 **T-2** | 「我只修了 `monthly` 那一支，复验席抓到漏了这条」 |
| §三 ②-b 的 `kw_ad_fact.spend` 装不下 null | ❌ **缺 T-3** | `spend-monthly.js:41` 的注释写着「待修见 … T-3」，**台账里 T-3 出现 0 次** |
| §三 ①-b 的象限口径（对端未测该不该判优势） | ❌ **缺 T-4** | `competitor.js:375` 的注释写着「见 … T-4」，**台账里 T-4 出现 0 次** |
| §5.6 的 `storefrontMiss` 同形缺陷 | ❌ **缺** | 台账里 `storefrontMiss` 出现 0 次 |

**另有两条需要改的**：

1. **台账「一、已修」第 19–23 行写得过头。** 原文：`keywords/competitor.js` | `rankedCount/presentCount` 保留 `null`；`classifyQuadrant` 竞品侧未测 → `unmeasured`。
   实核：`competitor.js:110/114`（`buildCompetitorDiff` 那一支）确实保留 null，**但 `quadrantRows` 的 `:377/378` 不保留**（`Number(their?.rankedCount ?? 0)`）。台账没有区分这两个构造器，而 T-4 争议正好在 `quadrantRows` 那一支上。**「已修」这一行现在是半真的**，而它是「进下一 batch」台账的入口，半真的「已修」比漏记更危险。
2. **T-1 的改法只收了我说的一半。** 台账写的改法是「新增 `blockedThisRun`，每轮复位」（= 我 §5.5 的第 (1) 条），**没有第 (2) 条**（`snapshot === null || typeof snapshot.blocked !== 'number'` → 状态未知，不许当 0）。只做 (1) 的话，「读不到」仍然被当成「读数是 0」，而 `?? 0` 那个原始缺陷点还在。两条一起才闭合。

**我要求**：补 T-3 / T-4 / `storefrontMiss` 三条，修正「已修 19–23」那一行的措辞，把 T-1 改法补上第 (2) 条。属于 `team/**`，不破 frozen；我的写域只有本报告一个文件，所以我不代写。

---

## 七、对「回退 4 条已评审断言 vs 改产品口径」的独立意见

lead 问的是这个判断对不对。我的结论：**回退是对的，定性（产品口径变更、不是 bug 修复）也对。但 T-4 应当拆成两条，其中一条现在就能做，不必等拍板。**

### 7.1 为什么同意回退

1. **那 4 条是已评审的验收断言**，钉住的是「dog bed 有名次、对端无事实 → 自有优势」。这定义的是**「自有优势」这个词的意思**，不是实现细节。在一个「修缺失被写成 0」的批次里顺手改它，等于让这一批的绿色同时代表两件不相干的事：一是「三个采样点的缺失处理修好了」，二是「象限口径变了」。后者需要自己的评审、自己的影响面评估、自己的回归。混在一起，`2490/0` 这个信号就失真了——而这正是我这个席位存在的理由。
2. **影响面不是零**：所有「我们上榜、对端从没测过」的词都会从「自有优势」移到「未测」。这是用户可见的重分类，而且「自有优势」是最容易被拿去当决策依据的桶（它进候选、进优化目标）。风险与收益不成比例。
3. **回退避免的更坏的结果，是「写一条会绿的断言来庆祝半成品」。** lead 自己写了这句（`t73e` 的注释里），我完全同意，而且它比回退本身更重要：如果当时既改 `quadrantRows` 又改那 4 条断言，全量照样会是绿的，但没有任何人能说清**绿的是哪一件事**。

### 7.2 我不同意的部分：T-4 里混了两件事

「同一行左边写自有优势、右边写该词无竞品数据」——这是**自洽性缺陷**，不是语义选择。

- 语义选择是「这个桶该收哪种词」；
- 自洽性是「同一行不许说两句互相矛盾的话」。

后者在本仓有大量先例，而且都被当成缺陷修掉了：`blocked-page.js` 把 `'unreadable'` 与 `'absent'` 分成两句话、`spend-monthly` 把 0 与 null 分开、`t73g` 那批把「没采集」从「0 条」里拆出来。**「一行自打脸」和「桶收哪些词」不是一件事，把它们捆在一起等同一个拍板，会让能做的那半白等。**

建议拆：

| 拆分 | 内容 | 现在能不能做 |
|---|---|---|
| **T-4a（语义）** | 「对端未测量」的词该不该落 `unmeasured` | **不能**，等拍板。lead 的回退保住的就是这一条 |
| **T-4b（自洽）** | `no_data === true` 的行，桶标签与「对端命中」那一格必须说同一件事 | **能，且不需要改象限归属** |

T-4b 的最小做法（不动归属）：桶仍然是 `ownAdvantage`，但页面把桶内的 `no_data` 行单独标出来——例如桶标题写成「自有优势（其中 N 条对端未测量）」，或在该行挂一个「对端未测量」徽章，与右格那句「该词无竞品数据」对齐。这样两句话不再矛盾，而「这个桶收哪些词」的口径一个字没动。

> ⚠️ **本段后来被我自己推翻了一半**：改**桶标题**会撞 CR1-T1 里那条桶名的字面量断言。可行的做法是**新开一个格子**，见 **§8.5**。

### 7.2-b 我把那 4 条断言读了：只有 2 条是语义钉子

lead 说回退时「撞了 4 条已评审断言」。我逐条读了正文，**这 4 条的钉子性质不一样**：

| 断言 | 文件:行 | 钉的是什么 | 属哪个域 |
|---|---|---|---|
| **B05D-C1** | `tests/b05d-tabs.mjs:404-410` | 字面计数：`counts.ownAdvantage === 1`、`ourAbsent === 1`、`unmeasured === 1`、`contested === 0`、`brandOnly === 0`，注释写明「这三个数是这个夹具在**正确分类**下的唯一答案：dog bed 有名次、对端无事实 → 自有优势」 | **语义（字面量）** |
| **CR1-T1** | `tests/cr1-quadrant-card.mjs:127` | 字面串：`equal(counts.join('|'), '1|0|1|1|0')`，其中 `counts[0]` 就是「自有优势」那格 | **语义（字面量）** |
| **B05D-W4** | `tests/b05d-tabs.mjs:185-` | `printed === expected`，而 `expected = box.order.flatMap(bucket => box.quadrants[bucket].map(r => r.quadrant_label))`——**由载荷推出**，不是字面串；外加「一个 `ownAdvantage` 的行不许印成 `ownAbsent`」 | **自洽（页面 ↔ 载荷）** |
| **CR1-T3** | `tests/cr1-quadrant-card.mjs:180-182` | 逐行槽位文案：`'3|本处未记'`、`'不判读|不判读'`；顺序注脚写着「行序：自有优势→未测」 | **逐行文案（间接依赖行序）** |

**结论：真正因为「桶该收哪些词」而会红的只有 C1 与 CR1-T1 两条。** W4 本身就是一条**自洽**断言（页面必须印载荷给的标签），T3 钉的是逐行槽位文案与行序——它们在你那次尝试里也红了，但红的原因不是语义，而是**行序/文案跟着桶归属一起变了**。这意味着：**T-4b 若只改桶标签的措辞与徽章、不动归属，C1 与 CR1-T1 一条都不会被碰；另外两条属于可修的那一侧。**

这条独立意见的用处在这里：lead 当时的观察（4 条红）是对的，但「4 条都是已评审的语义断言」这个归纳**高估了语义钉子的数量**——真实是 2 条。T-4b 因此比看上去更容易落地。

### 7.3 一句话给决策

**回退是对的，不要推翻。T-4 拆成 a / b：a 等拍板，b 现在就能做，且不必碰那 4 条断言里关于归属的部分。**

---

## 八、第二轮复验：T-3（`e4d8bf6` + `4152d3f`）

第一轮签的是 `173b36a` 的 `2490/0`。之后 lead 加了 T-3（v67 迁移 + 5 条断言），报 `2495/0`——**那一版只有他一个人证过**，而 T-3 动的是**建库迁移**，每个用真库的测试都从那条路走。所以我又跑了一次。

### 8.1 树与数字

| 项 | 值 |
|---|---|
| `git rev-parse HEAD`（跑前 06:00:59 / 跑后 06:05:32） | `4152d3fca6d2a14236a61f92a8ee3d1f46171dde`（两端相同） |
| 工作区 | **clean**（跑前跑后各取一次） |
| 清单 | 445 文件，跑前 `31c251a8…dca`、跑后同值，**`Compare-Object` 无差异** |
| 全量 | **`2495 passed, 0 failed`，exit 0**（`ok` 行数同为 2495） |
| `check-page` | **3/3 passed，exit 0**（内层 774027 chars，与第一轮同值） |

**lead 说 HEAD 是 `e4d8bf6`，实际是 `4152d3f`。** 差异已查清：他在 `e4d8bf6` 之后为重新生成清单**又提交了一次**（`4152d3f` `chore`；`git show --stat` 显示**只动 `team/qa/sha256-pre-freeze-2026-10-25.txt` 一个文件，+9/−8**；`git diff --name-only e4d8bf6 4152d3f -- src tests` **零输出**）。所以代码树两者相同，我的 `2495/0` 对这两版都成立——但他报的 HEAD 值不准。

### 8.2 冻结清单：旧那份作废，新那份**完全核得住**

| | 数据行 | 逐条相符 | 不符 | 缺失 | 聚合指纹 |
|---|---|---|---|---|---|
| 旧（描述 `173b36a`） | 436 | 431 | **5** | 0 | `f4f84ab5…`（可复现，但描述的树不对） |
| **新（`4152d3f`）** | **437** | **437** | **0** | **0** | **`558327fc74797e05f557f26baa1591cf227811147b2ac4ac2c753747f5794dba`** ✅ 与声称一致 |

新清单的口径也**双向核过**：`src/**/*.js` + `tests/**/*.mjs` 实际 **437** 个、清单 **437** 个，**「实际有、清单没有」= 0，「清单有、实际没有」= 0**。这份可以直接当基线。

**我那半句推断是错的，已更正**：我说旧清单「取早了」。真实原因是 lead 用**相对路径写文件**——`[System.IO.File]::WriteAllText("team\qa\…")` 解析到进程 cwd 而不是 PowerShell location，于是写进了**工作区那份**，仓库那份一直是旧的；随后他又改了 T-3，两边彻底对不上。**这个解释能同时说明全部 5 条**，我的「取早了」只解释得了 3 条。

### 8.3 T-3 的独立复验（不看它那 4 条断言，自己造数据走链路）

`importAdReport` → fact → `spendReport`，三行输入：花费格子**空** / 花费 **10** / 花费字面量 **0**。

| 层 | 实测 |
|---|---|
| 导入层 | `bench cushion` → `{spend: 10, spendMissing: 1, adRows: 2}`；`rocker cushion` → `{spend: 0, spendMissing: 0}` |
| 月报层 | `missing: {spend: 1, sales: 0, orders: 0, clicks: 0}`、`totals.missingRows.spend = 1`、`roas: 2.5`（可算）、`roasReason: null` |
| 反向对照（整份完整） | `spendMissing: 0`、`missing.spend = 0`、`roasReason: null` —— **没有退化成「总是报缺失」** |
| T-2 复测 | `undated[0] = {spend: 0, reason: "…读不出年份与月份"}`，仍无缺失标记 → **T-2 仍未修** |

**结论：T-3 端到端成立。**「源单元格为空」与「花了 0 元」在库里不再是同一个值，这是 ②-b 那条 P1 的真正闭合；反向对照也在，说明它不是靠「一律标记」骗绿的。

**v67 是纯 ALTER**：`schema.js:4037-4038` 只有两条 `ALTER TABLE kw_ad_fact ADD COLUMN`，那一段里 `DROP / RENAME / CREATE TABLE / INSERT INTO` **零出现**——加列不重建表，与它注释里写的取舍一致。`_missing = 0` 的口径（「0 只表示没标记，不表示确定没缺；迁移前老行一律 0，要重导才准」）也写在迁移注释 `:4030-4032` 里，不是只在对话里讲。

### 8.4 T-3 这个签字的范围（不许扩大）

| 签 | 不签 |
|---|---|
| 「源单元格空 → 置标记 → 落库 → 月报据标记计数」这条链，端到端成立 | **历史数据**：迁移前写入的行一律 `_missing = 0`，这些行的月报仍然不会报缺失，**要重导才准** |
| v67 纯加列、不重建表、不动既有行 | **T-2**（`undated` 分支仍把 `spend: null` 写成 `spend: 0`） |
| `2495 passed / 0 failed` 在静止树 `4152d3f` 上可证 | 任何「T-3 修好之后月报数字就都准了」的说法 |

**⚠️ 本节签字有一个缺口，我在这里自己补上（详见 §9.2）**：我那一轮喂给 `spendReport` 的是**导入器直接产出的 fact 对象**，绕过了 `routes.js` 里那条 `SELECT`。而线上的月报是从 `store.all(SELECT …)` 读的——**SELECT 漏列就等于整条修复哑掉，而我的探针方法看不见它**。dev-10 随后抓到的正是这个：`routes.js` 的 `spendMonthly` 当时没有 `SELECT spend_missing / sales_missing`，`t73h` 用 `SELECT *` 所以绿。**这跟我两次抓 lead 的「函数级正确、生产路径不生效」是同一个错法，只是这次是我的探针犯的。** `7189b71` 已补上这两列；§9.2 是补列之后的复验。

### 8.5 对 §7.2 的自我更正：T-4b 别改桶标题（我原来那条会撞断言）

我 §7.2 建议「桶标题写成『自有优势（其中 N 条对端未测量）』」。**这条是错的**——**CR1-T1 除了字面计数，还字面钉死了桶名**：

```js
// tests/cr1-quadrant-card.mjs:124-125
equal(cellText(inner, 'cr1-bucket-label').join('|'),
      '自有优势|共同竞争|自有缺席|未测|仅品牌不相关', '五桶桶名与载荷标签不一致: ')
```

改桶标题就撞第一条。同理不能把文字加进 `competitor-quadrant` 那一格——W4 断的是 `printed === expected`，而 `expected` 是从载荷 `quadrant_label` 摊出来的。

**能落地的做法（新格子，不碰任何已钉字面量）**：

1. 载荷加一个派生计数，**不动分类**：`classifyQuadrants` 的返回里加 `noDataByBucket`（值 = `row.no_data === true` 的行数）。只加字段，C1 的 `counts` 与 `classified === inputTotal` 都不受影响。
2. 页面加**新的 cell id**（如 `cr1-unmeasured-note`），只在计数 > 0 时渲染，内容两句：「本页 N 条词的对端未测量」+「仍按自有优势归类，口径待定（T-4a）」。
3. `cr1-bucket-label` / `competitor-quadrant` / `cr1-peer-hit` 三处一个字节都不改。

这样一个字不用改已评审的断言，矛盾也消失了（右格说「该词无竞品数据」，页脚说「这类词本页有 N 条、归类口径待定」）。**未验证**的一点：`b06-quadrants` 有一条「证据覆盖渲染出的每一行」，我读的是它按 row 的 `data-keyword` 走、不按 cell id，所以新 cell 应当安全——这条我没有实测。

---

## 九、第三轮复验（`7189b71` + `e77c069`）

这一轮进的是 T-2、展示层第三态、`sections`/`detail` 的「未采集 vs 采到 0」、以及 T-3 的**线上读取补口**。lead 点名要我额外核三件。

### 9.1 树与数字

| 项 | 值 |
|---|---|
| `git rev-parse HEAD`（跑前 07:31:21 / 跑后 07:35:40） | `e77c069ed5a8faf286222bf68583b2588a5d832d`（两端相同） |
| 工作区 | **clean**（两端各取一次） |
| 清单 | **449 文件**，跑前 `f48f23ac…dec3`、跑后同值，`Compare-Object` 无差异 |
| 全量 | **`2526 passed, 0 failed`，exit 0**（`ok` 行数同为 2526，`FAIL` 行 0） |
| `check-page` | **3/3 passed，exit 0**（内层 774800 chars） |

**lead 那份清单我逐条核过，全部对上**：441 条数据行、**441/441 逐条相符、0 不符 0 缺失**、聚合 `64ac982374d976f46aa15fc9371e2039c6ec7a2d1e7969710ef780e006672db3` 与声称一致。口径 `src/**/*.js` + `tests/**/*.mjs`。

一处小标注（不影响结论）：清单表头写的是 `git HEAD: 7189b71`，而实际 HEAD 是 `e77c069`。已核 `git show --stat e77c069` = **只动这份清单一个文件（+26/−22）**，`git diff --name-only 7189b71 e77c069 -- src tests` **零输出**，所以代码树确实相同——lead 这次的说法（「代码树 = 7189b71，e77c069 只动清单」）是准确的。只是**表头与 `rev-parse` 会不一致**，将来有人拿两个值对会觉得矛盾，建议表头写两个（代码树 / 清单提交）。

### 9.2 要核的第一件：`routes.js` 那条 SELECT 补口 —— **通了**（SQL → 列键 → 月报）

我没读代码下结论，而是**把 `routes.js` 里那条 SELECT 的原文抽出来**跑：

| 步骤 | 结果 |
|---|---|
| 从 `routes.js` 抽出的 SQL 原文 | `SELECT keyword, marketplace, period, source_file, clicks, orders, spend, sales, spend_missing, sales_missing, first_date, last_date FROM kw_ad_fact` |
| 在内存库里按这条 SQL 跑（两行：`spend_missing=1` / `=0`） | 两行都带 `spend_missing` 与 `sales_missing` 两个键 |
| 把这两行喂 `spendReport(...)` | `monthly[0].missing.spend = 1`、`sales/orders/clicks` 都是 0 |

**结论：这一环补对了。**「有 `spend_missing=1` 的行 → 月桶 `missing.spend ≥ 1`」在 SQL 与报告层之间成立。

**范围要说清**：我验的是 **SQL 文本 + 列名 → `spendReport`**，**没有**起 HTTP 去驱动 `/api/state` 的处理器。剩下那一跳是 `spendMonthly: spendReport(store.all(/* 这条 SQL */), …)` —— 一行直传，我读过它，中间没有映射层。所以「处理器把行原样交给 spendReport」这一句是**读码**结论，不是跑出来的。

### 9.3 要核的第二件：`fillRate` 改 null 之后，还有三处在漏

lead 问的两种坏法（印 `NaN%`、`0 ≥ 0.6` 判不达标）都在，另外还多一处「给满分」：

| # | 位置 | 漏法 | 实测/复算 |
|---|---|---|---|
| 1 | `src/web/pages/policy.js:1315` | `Math.round((embed.fillRate \|\| 0) * 100)` → `fillRate` 为 null 时**印「埋词完成率 0%」并挂 `warn` chip** | `Math.round((null \|\| 0) * 100) = 0`；`0 >= 60 = false` → chip=warn |
| 2 | `src/domain/optimize/run-view.js:306-310` | `numeric()` 的 `delta: to.coverage[key] - from.coverage[key]` —— **null 被当 0 参与减法**，`undefined` 得 `NaN` | `null-5 = -5`、`5-null = 5`、`undefined-5 = NaN` |
| 3 | `src/store/keyword-plan.js:581` | `fillRate: checkableTotal === 0 ? 1 : …` → 没有可核对格时给 **1（100%）** | 与 `optimize/plan.js:784`（同情形给 `null`）**口径不一致** |

第 2 处的下游是 `src/tools/report.js:521-525`，那三行把这三种值直接变成文字：

```js
from: entry.key === 'fillRate' ? asPercent(entry.from) : asCount(entry.from),
delta: entry.key === 'fillRate' ? signed(entry.delta, v => `${(v * 100).toFixed(1)}pt`) : signed(entry.delta),
```

- `asPercent(null)` = `"0.0%"`（`Number(null) * 100` = 0）
- `asPercent(undefined)` = `"NaN%"`（`Number(undefined)` = NaN）
- `signed(NaN)` → `Number.isFinite(NaN)` 为假 → 返回 `'0'`

**所以「上一轮没有记录、这一轮 50%」会印成「0.0% → 50.0% (−50.0pt）」**，而「读不到」会印成 `NaN%` 或一个假的 `0`。

**可达性已证**：`run.coverage.fillRate`（`run-view.js:152`）= `plan.coverageMatrix.summary.fillRate`，而 `optimize/plan.js:784` 在 `totalPlanned === 0` 时给 `null`。所以 #1 是**上屏**的（优化页/策略页那一块），#2/#3 在工具与报告文本里。（`tools/kw-plan.js:323` 也把 `coverage.fillRate` 直接插进文案，null 时印字面 `null`——同一条链的显示端。）

### 9.4 要核的第三件：runner 契约 —— 这类不一致**不会崩在顶层**

我写了个括号配平的核对器（能处理多行签名、默认值、注释、方法简写），对 `tests/run.mjs` 里每个 `await runXxxTests({…})` 与对应文件的签名解构逐键比对：

| 项 | 结果 |
|---|---|
| 核到的容器式 runner | **113 个** |
| 机器报出的「调用点缺键」 | **4 条** |
| 人工逐条看后的假阳性 | **2 条**（都怪我：`async settingsSlice(module) {…}` 这种**方法简写**被我的取键器当成了键名；另一条是多行签名带默认值被我截断。两条的键**实际都传了**） |
| 真的缺键 | **2 条**：`runT71GeoTests`（`tests/t71-geo-citability.mjs:147`）与 `runT71ConsistencyTests`（`tests/t71-consistency.mjs:99`）签名里解构 `throws`，而 `run.mjs` 没传 |

这两个文件里 `throws(` 出现 **0 次**，所以**今天无害**。但要纠正你的说法：

- **「这类不一致会让整条套件崩在顶层」——这个形状不会。** 缺的键在函数体里就是 `undefined`；真调用它才会 `TypeError: throws is not a function`。若发生在 `check` 回调里，是**红一条**；只有在 `check` 之外调用才会崩。
- **「把 `deepEqual` 塞进去才崩」也推不出来。** 解构赋值会忽略多余键。当前 `t73j` 传 `{check, equal}` 对上签名 `{check, equal}`；`t73k` 传 4 个键对上 2 个键的签名，多传的两个被忽略——两种传法都不崩。**我没能复现那次崩，也无法从现在的代码推出它。**

所以这条流程教训要改成：**真正的风险不是「崩」，是「静默拿到 `undefined`」** —— 要么红一条被测出来，要么在 `if (throws)` 这类写法下**悄悄跳过一段检查**（那才是「绿得没有意义」）。核对器的价值在于把这类静默缺键一次列全，不在于防崩。

### 9.5 这一轮我签什么

| 项 | 签署 |
|---|---|
| `2526 passed / 0 failed` 在静止树 `e77c069` 上 | **签**（449 文件跑前跑后逐字相同） |
| `check-page` 3/3 | **签** |
| lead 那份 441 条冻结清单 | **签**（逐条 441/441 相符、指纹一致、口径双向零溢出） |
| **(a) `routes.js` SELECT 补口** | **签，范围限「SQL 文本 → 列键 → `spendReport`」**；HTTP 处理器那一跳是读码结论 |
| **(b) `fillRate` 已安全** | **不签**：三处漏网（`policy.js:1315` 上屏印 0%、`run-view.js` 的 delta 把 null 当 0、`keyword-plan.js:581` 给满分），下游 `tools/report.js` 会把「读不到」印成 `0.0%` 或 `NaN%` |
| **(c) runner 契约** | **契约目前成立**；两条 latent（t71 的 `throws`）建议补上或删解构——补更省事，因为删解构会让将来想用 `throws` 的人再踩一次 |

---

## 十、第四轮复验（`f3218f4` / `5eda567` / `4204e2b`）——**有一条红，且它每天必然红一分钟**

这一轮进的是 v68、`fillRate` 三处、`deriveStatus`。**我跑出来不是全绿。**

### 10.1 树与数字

| 项 | 值 |
|---|---|
| `git rev-parse HEAD`（跑前 07:58:08 / 跑后 08:03:36） | `4204e2b050faad9abe2b30182e6782b549cb27e6`（两端相同） |
| 工作区 | **clean**（两端各取一次） |
| 清单 | **451 文件**，跑前 `80e4ee77…c06f1`、跑后同值，`Compare-Object` 无差异 |
| 全量 | **`2536 passed, 1 failed`，exit 1** |
| `check-page` | **3/3 passed，exit 0**（内层 775292 chars） |
| lead 那份 443 条清单 | **443/443 逐条相符、0 不符 0 缺失**，聚合 `7b795fe9…3029` 与声称一致 ✅ |

**三个哈希都在流通，我逐一核过它们描述同一棵树**：`f3218f4`（代码提交）→ `5eda567`（dev-10 文档）→ `4204e2b`（清单 chore），`git diff --name-only` 对 `src`+`tests` **两次都是零输出**。清单表头写 `git HEAD: 5eda567`，实际 HEAD 是 `4204e2b`——三处值不同但代码树相同。**建议表头直接写生成那一刻的 `rev-parse`**，别再让第三个哈希进来。

### 10.2 那条红：`B04T-㉙`，**挂钟相关，每天 UTC 23:59 必然红**

```
B04T-㉙ plan_save / plan_list：默认关闭、窗口双向、九个拒绝码、窗口不入库
  Error: expected true, got false
  at tests/b04-collect-tools.mjs:1582
```

失败的是这一行（`:1582`）：

```js
const inside = await tool('amzn_collect_plan_save').execute({
  name: '窗口内', targets: [...], window: { from: '00:00', to: '23:59', tz: 'UTC' },
})
equal(byName['窗口内'].nextWindow.openNow, true)     // ← 这里
```

**根因**在 `src/domain/collect/window.js:66`：

```js
openNow: localTime >= from && localTime < to     // to 是**开区间**
```

所以 `00:00–23:59` 这个窗口**每天 UTC 23:59:00–23:59:59 必然关闭**。我调真函数逐分钟验过：

| 时刻（UTC） | `localTime` | `openNow` |
|---|---|---|
| 23:58:59 | 23:58 | **true** |
| **23:59:00** | 23:59 | **false** |
| **23:59:30** | 23:59 | **false** |
| **23:59:59** | 23:59 | **false** |
| 00:00:00 | 00:00 | **true** |

**我这次正好撞进去**：07:58:08（+08:00）起跑 = **23:58:08 UTC**，`b04-collect-tools` 在套件前段、约一分钟后执行 → 落在 23:59 那一分钟。**lead 跑的时刻不在这分钟里，所以他拿到 2537/0，我拿到 2536/1。同一棵树、451 文件清单跑前跑后逐字相同，两个不同的数。**

**这不是回归，也不是谁造假**；后果更麻烦：**`2537/0` 不可复现**——它是「某一分钟里的读数」，不是「这棵树的属性」。

**顺带一个更硬的边界问题**：`24:00` 被 `HH_MM`（`/^([01]\d|2[0-3]):[0-5]\d$/`）拒掉，实测 `windowState({from:'00:00', to:'24:00'})` 返回 **`null`**。**所以没有任何可表达的窗口是整天开着的**，最长覆盖 1439/1440 分钟。想要「全天」只能不给窗口（`null` = 不限），而操作者最自然的写法是 `00:00–23:59`——那一分钟就会被判成关闭。生产侧同样用它（`src/sources/collection.js:955`），所以这是**行为**问题，不只是测试问题。

**改法（缝已经在了）**：`planList({ store, args, now = new Date() })`（`scheme.js:343`）**本来就接受 `now`**。所以：
1. `openNow` 的断言改成注入固定时刻（走 `planList({..., now})` 或直接 `windowState(win, new Date(...))`）；
2. 工具那一层只断 `tz` / `from` / `to` 的透传，**不判断「现在开没开」**——那一格天然依赖挂钟，不该进工具层断言；
3. `to` 要不要含端点、`24:00` 要不要接受，是产品口径（会与跨午夜窗口判定一起变），**该单独拍板，不该在修测试时顺手改**。

**对报告的直接影响**：这一轮我不能签「全绿」。流程教训是——**任何全量数字都必须带时间戳**，否则「2537/0」与「2536/1」看起来像两个说法，其实是一次依赖挂钟的抽奖。

### 10.3 (a) `signed` / `asPercent` / `asCount` 改成印「未记录」——**没有回归**

| 函数 | 对 `0` | 对 `null` / `undefined` / `NaN` |
|---|---|---|
| `signed`（`tools/report.js:422`） | **`'0'`**（`:426` 显式 `if (n === 0) return '0'`） | `'未记录'` |
| `asCount`（`:429`） | **`'0'`**（`Number.isFinite(Number(0))` 为真） | `'未记录'` |
| `asPercent`（`:427`） | **`'0.0%'`** | `'未记录'` |

四个调用点（`:512`、`:525-526`、`:530-531`、`:533-534`）**全部是差分表格里的文字**，没有消费者解析它们，也没有纯计数场景把 0 读成缺失。**你担心的「纯计数 0 变成未记录」没有发生。**

一个小边界：`asCount('')` 会印 `'0'`（空串被 `Number` 成 0）；从 run view 过来的值是数字或 null，走不到这条，记在这里备查。

### 10.4 (b) `deriveStatus` 判 `partial`——**在四个词里是对的，但库里仍写着 0**

- **「没报数 → partial」是四个封闭状态里唯一诚实的**：`done` 会替通道宣称完整（它没说过）、`failed` 会宣称什么都没写（也没说过）、`cancelled` 是另一件事。加第五个 `unknown` 更准确，但那是改封闭词表 + 改所有消费者，**不该为这一处开**。
- **但有一处把它又塌了回去**：`src/sources/collection.js:608` 写库时走 `compactResult(result)`，而 `compactResult`（`:1156`）里是

```js
written: result.written ?? 0,        // ← 「没报数」在这里重新变成 0
```

**于是同一个任务行上：`status = 'partial'`（我们不知道），`result_json.written = 0`（它写了 0 条）。** 新加的区分在状态列成立，在被存下来的结果里又被抹平——读 `result_json.written` 的下游（页面汇总、导出、以后的分析）看到的就是「0 条」。**这是「缺失被写成 0」在这个文件里的下一条，而且在 T-1/T-2/T-3 之外。**

改法：`written: writtenKnown ? written : null`（`failed`、`selectorMiss` 同类同改），让库里那一列与新状态同口径。

### 10.5 (c) `muted` chip——**这个 class 不存在，但页面不会「没颜色」**

- `page.js:320-324` 只定义了 `.chip`、`.chip.ok`、`.chip.warn`、`.chip.run`、`.chip.stop`。**全仓没有 `.chip.muted`，也没有任何 `.muted` 规则。**
- `policy.js` 现在发 `class="chip ' + chip + '"`，`chip` 在 null 时取 `'muted'` → `class="chip muted"`。
- **基础 `.chip` 本身带 `color: var(--dim)` 和边框**（`:320`），所以 `chip muted` 退化成**默认的暗色 chip**——**能看见、有颜色、不是坏样式**。你说的「没有颜色的 chip」不会发生。
- 实际问题是：**这个 class 是空操作**。它现在「看着对」纯属基础样式恰好也暗；将来有人给 `.chip.muted` 加语义就会静默改变这一处。

改法：要么在 `page.js` 补 `.chip.muted { color:var(--dim); border-color:var(--line); opacity:.75 }`，要么把那个三元改成 `'chip'`（不带修饰类）。**别留一个没人定义的语义类。**

### 10.6 (d) v68 那三条 `/api/state` 判据——**真在跑**，但挂在名字不对的 check 下

- 三条断言在 `tests/run.mjs:10121-10140`，属于 `await checkAsync('the optimize panel receives every number it draws', …)`——**该 check 在 `:9937` 打开、`:10226` 关闭，是被 `await` 的，会执行**。不是死断言。
- **但它的名字是「the optimize panel receives every number it draws」，里面装的却是 keyword master 的 `rows_read_missing`。** 一旦这三条红了，报告行会顶着「优化面板」的名字，**把故障指到另一个子系统**。而且这一个 check 现在同时覆盖优化面板与关键词总库两件不相干的事，任何一边失败只产出一行红。
- 断言本身写得对：先断**键在不在**（`'rows_read_missing' in …`），再断**等于 0**（不是「≠1」——`undefined !== 1` 也成立，那样的断言等于没断），再断 `rows_read` 是数字。三层都是对的。
- `runT73m` / `runT73n` 都已接线：import 在 `:561`/`:563`，`await` 在 `:11576`/`:11578`。

改法：把这三条从「优化面板」那个 check 里拆出来，单独一个 `checkAsync('rows_read_missing reaches /api/state')`。**名字对不对，决定红的时候人往哪儿看。**

### 10.7 这一轮我签什么

| 项 | 签署 |
|---|---|
| 「这棵树 2537/0」 | **不签**——我跑出 `2536/1`，红的是 `B04T-㉙`，且已证明它每天 UTC 23:59 必然红一分钟（§10.2） |
| 树的静止性 | **签**：451 文件跑前跑后逐字相同，HEAD 两端 `4204e2b`，worktree 两端 clean |
| lead 那份 443 条清单 | **签**（443/443、指纹一致） |
| `check-page` 3/3 | **签** |
| (a) 三个格式化函数无回归 | **签** |
| (b) `deriveStatus` 的 `partial` 口径 | **签（口径对）**；**不签**「库里的结果也诚实」——`compactResult` 仍写 `written: 0` |
| (c) `muted` chip | **不签「样式正确」**——class 不存在，只是退化成了默认暗色 chip |
| (d) v68 三条判据 | **签「真在跑」**；**不签「故障可归因」**——挂在名字不对的 check 下 |

**这一轮我不签「全绿」，也不签「`|| 0` 台账全清」。** 后者我这轮没核（你说 5 / 11-12 / 13 / 24 都有归宿了），但 `compactResult` 的 `?? 0` 就说明**台账的口径漏了一个文件**：它是同一类「缺失写成 0」，不在你列的 25 条里。**「全清」这句话现在不成立**——建议把 `collection.js:1156` 的 `compactResult` 加进台账再宣布清空。

---

## 十一、第五轮复验（`2747c53` + `8f20116`）——**T-7 我证伪不掉；T-6 只修了一个面**

### 11.1 树与数字

| 项 | 值 |
|---|---|
| `git rev-parse HEAD`（跑前 08:17:37 / 跑后 08:22:11） | `8f201160f4201ad32d4aabfec5d3705d992b7c30`（两端相同） |
| `git status -- src tests` | **clean**（两端各取一次） |
| 清单 | **452 文件**，跑前 `9d040b4a…5c28`、跑后同值，`Compare-Object` 无差异 |
| 全量 | **`2542 passed, 0 failed`，exit 0**（`ok` 行数同为 2542） |
| `check-page` | **3/3 passed，exit 0**（内层 775292 chars） |
| lead 那份 444 条清单 | **444/444 逐条相符、0 不符 0 缺失**，聚合 `fbd327ec…813c` 与声称一致 ✅ |

**一件对签字很关键的事**：我这次跑在 **UTC 00:17**——**不在** 23:59 那个危险窗口里。所以 `2542/0` 这个数本身**不能**证明那条红已经消失；它是 §11.2 证出来的。

表头改成「生成这一刻的 `rev-parse`」后写的是 `2747c53`，实际 HEAD 是 `8f20116`。已核：`git show --stat 8f20116` = **只动这份清单（+12/−11）**，`git diff --name-only 2747c53 8f20116 -- src tests` **零输出**。表头对「生成那一刻」是准确的；**读的人要拿它比代码树、不要比 `HEAD`**。

### 11.2 T-7：反证扫描——**我找不到任何时刻能让那条断言红**

lead 要我「构造出任何一个时刻让它红，就算修得不够」。我构造不出来：

| 扫描 | 规模 | 判成关闭 |
|---|---|---|
| 域层 `isWindowOpen({00:00–24:00, tz})` | **8 个时区 × 4 天（含 NY 3/8、11/1 与 London 3/29 夏令时切换日）× 1440 分钟 = 46,080 次** | **0** |
| 工具层（真 `openStore` + 真 `planSave`/`planList`）逐分钟读 | **1,440 次** | **0** |

时区覆盖：`UTC`、`Asia/Shanghai`、`America/New_York`、`Europe/London`、`Pacific/Kiritimati`(UTC+14)、`Pacific/Midway`(UTC−11)、`Asia/Kathmandu`(+05:45)、`Australia/Lord_Howe`(+10:30/+11)。

| 关键检查 | 结果 |
|---|---|
| `00:00–24:00` @ 23:59:30 | **`openNow = true`** ✅ |
| `00:00–23:59` @ 23:59:30（旧写法） | **`openNow = false`** —— **右端仍是开区间，语义没被顺手改掉** ✅ |
| `{from:'24:00'}`（左端） | `windowState → null`；工具层 → **`WINDOW_INVALID`** ✅ |
| `{to:'25:00'}` | 工具层 → **`WINDOW_INVALID`** ✅ |
| 未知时区 `Not/AZone` | `tzUnknown: true, openNow: true`（没被这次改动弄成关闭）✅ |

`T73o` 那 5 条也核了：**无一处裸 `new Date()` / `Date.now()`**，全部注入固定时刻。

**为什么这个证明不受「只扫了 8 个时区」限制**：`localHHMM`（`window.js:35-51`）只产出 `HH:MM`，并把 ICU 可能的 `24` 归一到 `00`（`:46`）；而 `'HH:MM' < '24:00'` 对任何 `HH:MM` 恒真（定长、字典序=时序）。**结论与日期、时区、分钟都无关**，不依赖我扫了哪些区。「扫遍全部 IANA 区」这件事本身我没做，列为未取得。

### 11.3 「三处校验点」——第三处确实存在，我实测它已改

| 校验点 | 代码 | 接受 `24:00` |
|---|---|---|
| 域层 | `window.js:24`（`HH_MM_END`）/`:67` | ✅ |
| 存储层 | `store/collection-plan.js:39` /`:90` | ✅ |
| **工具层** | **`scheme.js:335`（`HH_MM_END`）/`:386`（`WINDOW_INVALID`）** | ✅ |

工具层实测（真 store、真 `planSave`）：

```
planSave({00:00, 24:00}) → ok:true,  nextWindow.openNow = true      @23:59:30
planSave({00:00, 23:59}) → ok:true,  nextWindow.openNow = false     @23:59:30
planSave({00:00, 25:00}) → WINDOW_INVALID
planSave({24:00, 24:00}) → WINDOW_INVALID
planList @23:59:30       → {整天: true, 旧写法: false}
```

**按你的要求写进流程教训**：`24:00` 这个语义在三个地方各判了一次，所以「改完域层、工具层仍拒」是**必然**结果——与 `routes.js` 漏 `SELECT` 同形：**改了主路径没改入口**。规矩应当是：**同一个语义有 N 个校验点时，改完必须逐个真跑一遍；`grep` 到几处不等于改到几处。**

### 11.4 T-6：`compactResult` 修了，**同一函数里还有 4 处 `?? 0`**

| 位置 | 落到哪一列 | 修了吗 |
|---|---|---|
| `collection.js:1169-1177` `compactResult` | `result_json` | ✅ `countOrNull`（6 个字段都换了） |
| **`:604`** `transition(..., { evidence: { written: result.written ?? 0 } })` | **`collection_task_event.evidence_json`（只追加历史）** | ❌ |
| `:609-616` 收尾 `progress_json` | `collection_task.progress_json` | ❌ |
| `:624` `workbench.record('collect:done')` | 工作台 feed | ❌ |
| `:531` progress 事件 | `progress_json` | ❌ |

`transition` → `appendTaskEvent` → `evidence_json`（`store/collection-task-event.js:104`），而这个文件开头写着「Evidence that can be edited is not evidence」——**它是只追加的历史**。

**所以现状是：`result_json.written = null`（我们不知道），同一行的历史事件里 `written = 0`（它写了 0 条）。** 状态列与历史列互相矛盾，而**历史是更难改的那一侧**（不能撤回）。

**「全清」这句话现在仍不成立**：上一轮漏的是 `compactResult` 本身，这一轮漏的是它的 4 个兄弟。要求：这 4 处用同一个 `countOrNull`。

### 11.5 (c) / (d) 复核

- **(c) `.chip.muted`**：已在 `page.js:328` 定义（`color:var(--dim); border-style:dashed; opacity:.85`），注释写明「基础 `.chip` 恰好也吃 `--dim`，原先看着对纯属巧合」。**签。**
- **(d) 前缀**：三条错误信息都带 `[kw-master rows_read]`（`:10132` / `:10134` / `:10136`）。**这个折中我接受，不坚持拆**——拆它要重造 store 与载荷，代价大于收益，而前缀已经解决了「指错子系统」这个实际问题。剩下的代价是：失败行仍顶着「the optimize panel receives every number it draws」的名字，**一行红同时代表两件不相干的事**，记在这里备查。

### 11.6 这一轮我签什么

| 项 | 签署 |
|---|---|
| **「这棵树是绿的」** | **签**：我跑出 `2542 passed / 0 failed`，452 文件跑前跑后逐字相同，HEAD 两端 `8f20116`，`src`/`tests` 两端 clean，`check-page` 3/3，清单 444/444 |
| **而且这次签字不依赖我什么时候跑** | **本轮与前几轮最重要的区别**：§11.2 把「23:59 那一分钟」从根上验掉了（46,080 + 1,440 次扫描、0 次关闭，且证明与时刻无关） |
| T-7 的修法 | **签**，含三处校验点逐个实测 |
| `T73o` 不依赖挂钟 | **签**（无裸 `new Date()`） |
| (c) `muted` chip | **签** |
| (d) v68 判据前缀 | **签**（接受折中；可读性代价已记） |
| **「`\|\| 0` 台账全清」** | **不签**：`collection.js` 还有 4 处 `?? 0`，其中 `:604` 写进**只追加历史** |

---

## 附：本报告里所有「未取得」的项与原因

| 项 | 原因 |
|---|---|
| ~~静止树上的全量 passed/failed~~ | **已取得**：`2490 passed, 0 failed`（§2.1 第 3 行 / §2.4）。此条从「未取得」移出 |
| ~~lead 的聚合指纹 `f4f84ab5…5811` 无法核对~~ | **已核对**：拼接方式 = 436 行数据行用 `\n` 连接后取 SHA256，**正好等于该指纹**。此条移出。但清单里 5 条哈希与签署树不符（§2.4），所以「指纹能复现」不等于「它描述的是这棵树」 |
| `storefrontMiss` 跨轮累计的实测复现 | 只做了静态推断（全仓仅 `:544` 一处写、复位块无它），未跑两轮真采集 |
| §五 P0 的端到端复现 | 需要真实浏览器与真实风控页，本席不主动触发站点风控；已给出等价的桩级复现（桩形状与 `diagnostics()` 返回一致） |
| §三 ①-b / ②-b 在本报告写就后是否仍成立 | **已复测**：在签字树 `173b36a` 上重跑，①-b 与 ②-b 的每个值都与原文逐字相同（不是沿用旧结论） |
| C1 / W4 / cr1-T1 / cr1-T3 那 4 条断言钉的是「桶归属」还是「那句文案」 | 我没有逐条读 `tests/b05d-*.mjs` 与 `tests/cr1-*.mjs` 的对应断言，所以 §7.2 的 T-4b 拆分建议只能到「需要先看清这一件事」为止 |
| §9.3 那三处 `fillRate` 漏网的**上屏实测** | 我做的是「按源码原表达式复算」（`Math.round((null‖0)*100)=0`、`asPercent(null)="0.0%"`、`signed(NaN)='0'`），**没有**起服务、渲染优化页去截那条 chip。三处的**可达性**是读码证的（`plan.js:784` → `run-view.js:152` → `policy.js:1315`），不是跑出来的 |
| §9.2 的 HTTP 那一跳 | 我验到「`routes.js` 里的 SQL 原文 → 列名 → `spendReport`」，**没有**驱动 `/api/state` 处理器；「处理器把 `store.all(...)` 原样交给 `spendReport`」是读码结论 |
| 还有没有**别的**挂钟相关断言 | 我只证伪了 `B04T-㉙` 这一条（§10.2），**没有**扫全量 2537 条去找其他依赖真实时钟、日期或时区的断言。这是一类需要单独普查的风险 |
| §10.4 的 `status='partial'` + `result_json.written=0`  coexist | 我读的是 `collection.js:608` 与 `:1156` 的代码路径，**没有**造一个「通道不报 `written`」的适配器真跑一次采集任务去读回那一行。要实测需要替换适配器，属下一轮可做项 |
| §10.5 的 `chip muted` 上屏观感 | 我读的是 CSS 与 `policy.js` 的拼接，**没有**起服务渲染那一块去截图确认「退化后的暗色 chip」长什么样 |
| 扫遍全部 IANA 时区 | §11.2 扫的是 8 个代表区（含 2 个夏令时切换日、UTC+14/−11、+05:45、+10:30）。机理上结论与时区无关（`HH:MM` 定长字典序），但「全部 IANA 区逐个跑」这件事没做 |
| `compactResult` 那 4 处 `?? 0` 的实测复现 | §11.4 是读码链（`collection.js:604` → `appendTaskEvent` → `evidence_json`）**加**已确认的写库路径，**没有**造一个「通道不报 `written`」的适配器真跑一次任务去读回 `evidence_json` |
| 全量 2542 条里还有没有别的挂钟依赖 | §11.2 只证伪了 T-7 这一条；**没有**普查整个套件对真实时钟/日期/时区的依赖 |
