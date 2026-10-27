# INCLUDES 专项审计 round 2 —— 19 条 `unverified` 候选逐条变异 + 49 条孤儿处置（amazon-ops）

- **日期**：2026-10-13
- **作者角色**：测试工程师（QA）
- **状态**：已完成（19 条全部定性；6 条假绿已修并逐条证伪；49 条孤儿逐条判定）
- **关联需求编号**：无独立需求号；本文件是 `docs/qa/INCLUDES-AUDIT-2026-10-13.md`（611 行，下称「round 1」）
  的**收口**：把它的附录 B（19 条读整份渲染的 `unverified` 候选）逐条变异，并处置 `tests/wired-source.mjs`
  的 49 条孤儿导出。
- **证据等级**：`verified`（全部结论都是本次在本工作树里跑出来的原始输出）；
  只有一条例外，单独标 `unverified`（候选 #19 的**前提**在 main 上不成立，见 §6）。
- **工作树**：`D:\deepseek-harness-h\workspace\wt-t3-qa`，分支 `t3-qa`，基于 main `d6cfc0c`
- **变更说明**：已写进 `docs/COORDINATION.md` §7.3 的 D5 行与孤儿那一段。

> ## ⚠️ 后续进展（round 3，2026-10-13，同日）—— 本文件关于「孤儿保留」的结论**已被超越**
>
> 本文件当时把 6 条 `no-caller` 标为「**禁改区，保留**」或「**口径假阳性，保留**」，
> 因为那一轮**别的批次正占着那些文件**。**round 3 已把它们全部结清**（`main = 1cdb9ad`）：
>
> - **删掉 4 条真死代码**（删前逐条 `git grep` 复核零生产调用方）：
>   `sections.js` 的 `sectionOrder` / `sectionFields`、`health.js` 的 `cardSpecs`、`pins.js` 的 `isFavorite`
> - **2 条假阳性改为「修检测器」**：`sectionShortLabel`（被 `.map(fn)` 当回调传）、
>   `CdpConnection`（被 `CdpConnection.open()` 当静态方法调）—— 它们**真的被调用**，
>   留在名单里等于让 `UNWIRED` 表说出「这条没接线」的假话。
>   `occurrences()` 从 1 种引用形状扩到 3 种，并加**控制样本** `headerIndex`
>   证明放宽口径**没有把真孤儿藏起来**。
> - 结果：`unwired` **34 → 28**，**`no-caller` 归零**，越界 0 / 死条目 0。
>
> **所以本文 §(b) 判定表里那 6 行的处置意见，今天已不成立**（它们是**当轮**的正确判断，不是错的）。
> 实现与证伪见 `tests/wired-source.mjs` 的文件头（三种引用形状 + 已知边界）与该文件里的「健全性⑤」断言。

---


## 0. 一句话结论

round 1 附录 B 那 19 条里，**13 条承重**（改坏就红，记录为「已复核、无问题」，一个字节没动）、
**6 条是假绿**（改坏仍绿），已全部改成「读那一行 / 那一格自己的文字」并加反面，**每条都做了真证伪**。

三件 round 1 没做到的事，本轮做了：

1. **逐条单独改坏**，不看总红数 —— 因为 round 1 已经证明「两条假绿可以互为掩护」（R3 与 R6 共用一条断言）。
2. **补上它自己写出的口径盲区**：把「嵌在 HTML 模板里的标签」纳入扫描。
   口径改完，候选标签从 **74 → 110**，`一键体检`（R7 漏掉的那一个）**被抓住了**（§5）。
3. **顺手查出两件更重的事**，都不在任务书里，但都是「静默」形态：
   - `tests/probe-routes.mjs` **在未改动的 main 上就跑不通**（候选 #19 的前提因此不成立）；
   - 全仓 **17 处 `checkAsync(...)` 没有 `await`**，分布在 6 个模块里，其中 **3 个模块的全部
     `checkAsync` 都是悬空的**（§7）。**这一条差点让我自己得出 6 条错误的结论** —— 见 §1.2。

`node tests/run.mjs`：**1794 passed / 0 failed**（与基线逐字相同，断言数不减）。
`amazon-ops/src/**` 与**本工作树的基点 `d6cfc0c` 逐字节相同** —— 我这一轮对 `src/**` 贡献了 **0 字节**（§9.3）。

---

## 1. 判据与工具（以及一次自我证伪）

### 1.1 判据

**「改坏之后这条断言还红不红」**，不是「像不像图例」，也不是「在不在候选表里」。
每条变异**单独施加、单独运行、单独还原** —— 绝不看「一次改一处之后总红数有没有变」，
因为那正是 round 1 记下的教训（R3 与 R6 互相掩盖）。

施加器（`.t3-mutate.mjs`，一次性，已删）先检查 `from` 片段在目标文件里**恰好出现 1 次**，
不是 1 次就拒绝施加 —— 不静默改错地方。19 条规格全部通过这条预检。

### 1.2 ⚠️ 一次自我证伪：子集运行器必须先**排空悬空 promise**

第一轮我用一个「只跑一个测试模块」的子集运行器（全量 165s，单模块 ~9s，本机同时有三名成员在跑全量）。
它给出的第一条结论是「U04 `没有变化` 改坏仍绿」。

**那条结论是错的，而且错在我的工具上。** 我把 U04 的注入串直接打进页面脚本、确认它落在
`<script>` 区间内（`needle inside the script region: true`），断言却仍然不红。追下去发现：

`tests/b05c-history.mjs` 里 **5 处 `checkAsync(...)` 都没有 `await`**。
`checkAsync` 的函数体在**第一个 `await` 之前**是同步跑的，之后挂起；模块 runner 立刻返回，
子集运行器立刻打印汇总 —— 于是**第一个 `await` 之后的断言一条都没跑**，
却被读成了「没红」。该模块自报 18 条，实际有 22 条：

```
（排空前）amazon-ops/tests/b05c-history.mjs :: runB05cHistoryTests  ->  18 passed, 0 failed
（排空后）amazon-ops/tests/b05c-history.mjs :: runB05cHistoryTests  ->  22 passed, 0 failed
（排空后 + U04 改坏）                                                  ->  21 passed, 1 failed
        FAIL 页面用域层产出的载荷画差异表，且不出现「没有变化」
```

**修法**：子集运行器在打印汇总前显式让出事件循环（20 × 25ms）。
**这条纪律值得单独记：一个子集运行器如果不排空悬空 promise，它会把「还没跑」读成「没红」，
从而批量生产假结论。** 全量 `run.mjs` 不受影响（后续模块的 await 顺带排空了），
所以 round 1 用全量得出的结论仍然成立。

### 1.3 运行方式

```powershell
# 全量（唯一的最终判据）
cd amazon-ops; node tests/run.mjs

# 单模块（判「这条断言红不红」的快速仪器；⚠️ 必须排空悬空 promise，见 §1.2）
node .t3-subset.mjs amazon-ops/tests/<module>.mjs

# 施加一条变异 / 还原
node .t3-mutate.mjs .t3-spec.json <ID>
git checkout -- amazon-ops/src
git diff --stat d6cfc0c -- amazon-ops/src     # 必须为空（⚠️ 别拿 main 比，main 会被别人推进，见 §9.3）
```

U13 / U14 / U15 的断言**内联在 `run.mjs` 里**（没有独立模块），所以那三条只能跑全量。

---

## 2. 19 条逐条结果

| # | 标签 | 断言（文件:行，本轮行号） | 接收者 | 改坏了哪一处（生产侧） | 改坏后 | 判定 | 处理 |
|---|---|---|---|---|---|---|---|
| U01 | `读不到设置行` | `b04-collect-page.mjs:1703` | `bare`（#collectForm） | `page.js` 那一句「读不到设置行（设置切片未就绪）」 | **1 failed** | **承重** | 不改 |
| U02 | `自有` | `b05-asin-table.mjs:1004` | `text`（工具输出） | `table.js` `ASIN_CELL_LABELS.ownership.self` | **3 failed** | **承重** | 不改 |
| U03 | `已完成` | `b05-asin-table.mjs:1005` | `text` | `table.js` `ASIN_CELL_LABELS.optimization.done` | **2 failed** | **承重** | 不改 |
| U04 | `没有变化` | `b05c-history.mjs:542`（否定型） | `html`（#asinhistory） | 往「字段差异」那一行塞进「（不是「没有变化」）」 | **1 failed** | **承重** | 不改 |
| U05 | `未知/未测` | `b06-quadrants.mjs:390` | `html`（evidenceHtml） | `page.js` `factLine` 的取值 `未知/未测 → 未知值` | 0 failed | **假绿** | **已修** §4.1 |
| U06 | `未测` | `b06-quadrants.mjs:555` | `text` | `competitor.js` `QUADRANTS.unmeasured` | **1 failed** | **承重** | 不改 |
| U07 | `已作废` | `b13b-inbox-evidence.mjs:512` | `html`（#optdrafts） | `page.js` `DRAFT_FILTER_LABELS.voided` | **1 failed** | **承重** | 不改 |
| U08 | `只能人判` | `b13d-validation-delivery.mjs:978` | `md` | `report.js` 8.3 那张表的表头格 | **1 failed** | **承重** | 不改 |
| U09 | `草案未采纳` | `b13d-validation-delivery.mjs:1012` | `md` | `delivery.js` `DELIVERY_STATUS_LABELS.not_accepted` | 0 failed | **假绿** | **已修** §4.2 |
| U10 | `草案未采纳` | `b13d-validation-delivery.mjs:1013` | `html`（OR 型） | `report.js` HTML 计数段里的「草案未采纳」 | 0 failed | **假绿** | **已修** §4.2 |
| U11 | `采集失败` | `b14-blocked-page.mjs:379`（否定型） | `text` | 往出口那一句塞进「（不是采集失败）」 | **1 failed** | **承重** | 不改 |
| U12 | `未接入` | `s1b14-quick.mjs:355`（否定型） | `html`（#homeactions） | 往有落点的动作卡里塞进 `<span>未接入</span>` | **1 failed** | **承重** | 不改 |
| U13 | `计算失败` | `run.mjs:3818` | `html`（#homecards） | `page.js` 卡片状态词 `计算失败 → 算不出来` | **1 failed**（全量 1793/1） | **承重** | 不改 |
| U14 | `质量驾驶舱` | `run.mjs:5119` | `html`（#qcockpit） | `page.js` `qualityCockpitHtml` 的标题 | **1 failed**（全量 1793/1） | **承重** | 不改 |
| U15 | `时效` | `run.mjs:5122` | `html`（#qcockpit） | `page.js` `labels[dimension] \|\| dimension` → `dimension` | 0 failed（全量 1794/0） | **假绿** | **已修** §4.3 |
| U16 | `关键词总库` | `kw-master.mjs:1288` | `text` | `kw.js` 表标题 `关键词总库 (...)` | **1 failed** | **承重** | 不改 |
| U17 | `库内` | `kw-master.mjs:1289` | `text` | `kw.js` 统计行 `库内 N 条 · ...` | **1 failed** | **承重** | 不改 |
| U18 | `层级` | `kw-master.mjs:1290` | `text` | `kw.js` `dist('层级', stats.bySvTier)` | 0 failed | **假绿** | **已修** §4.4 |
| U19 | `闸门` | `probe-routes.mjs:210` | `html`（报告路由） | `report.js` 闸门表自己的表头格 `闸门 → 门槛` | 0 failed（`probe ok`） | **假绿** | **已修** §4.5 + §6 |

**合计：13 条承重、6 条假绿。** 「进了候选表」≠「假绿」—— 13/19 是承重的，与 round 1 的
结论（S1/S4/S5 是候选却变红）方向一致。

---

## 3. 逐条证伪原文（挑关键几条，其余见 §2 的红数）

### 3.1 U02 `自有`（3 failed —— 一次改坏牵动三处，说明它真的在承重）

```
$ node .t3-mutate.mjs .t3-spec.json U02
applied U02: amazon-ops/src/domain/asin/table.js
  - "  ownership: { self: '自有', competitor: '竞品' },"
  + "  ownership: { self: '自家', competitor: '竞品' },"
$ node .t3-subset.mjs amazon-ops/tests/b05-asin-table.mjs
amazon-ops/tests/b05-asin-table.mjs :: runB05AsinTableTests  ->  26 passed, 3 failed
  FAIL B05T-①c 投影把三种空分开：没有来源 / 有来源但没有值 / 值是 0
  FAIL B05T-③c 有值的那几列真的印出了服务端的值（父体 / 归属 / 产品线 / 新鲜度 / 优化状态 / 最近采集）
  FAIL B05T-⑥ 会话侧（amzn_asin_query）印的是同一份 17 列与同一批措辞
```

### 3.2 U04 `没有变化`（否定型，改坏方向是「塞进被禁的词」）

```
$ node .t3-subset.mjs amazon-ops/tests/b05c-history.mjs      # 未改坏
  ->  22 passed, 0 failed
$ node .t3-mutate.mjs .t3-spec.json U04
applied U04: amazon-ops/src/web/page.js
  - "parts.push('<div class=\"b05c-note\">字段差异 <strong>'"
  + "parts.push('<div class=\"b05c-note\">字段差异（不是「没有变化」） <strong>'"
$ node .t3-subset.mjs amazon-ops/tests/b05c-history.mjs
  ->  21 passed, 1 failed
  FAIL 页面用域层产出的载荷画差异表，且不出现「没有变化」
```

### 3.3 U13 / U14（内联在 `run.mjs`，只能全量）

```
U13  target=FULL  1793 passed, 1 failed
      FAIL the home tab has a renderer now, and no placeholder note behind it
U14  target=FULL  1793 passed, 1 failed
      FAIL the cockpit tab draws inside the quality container, and only offers legal moves
```

### 3.4 U19 `闸门`（探针）

```
$ node .t3-mutate.mjs .t3-spec.json U19
applied U19: amazon-ops/src/domain/optimize/report.js
  - "  push(htmlTable(['闸门', '结果', '说明'], model.gates.gates.map(gate => ["
  + "  push(htmlTable(['门槛', '结果', '说明'], model.gates.gates.map(gate => ["
$ cd amazon-ops; node tests/probe-routes.mjs US
probe ok                      ← 改坏了表头，探针照样过 = 假绿
```

---

## 4. 6 条假绿的修法与证伪

六条都按同一条纪律改：**改的是读法（读哪一行 / 哪一格），不是判据**；
每条都**加反面**（该印 A 的那一格不许印 B）。**没有删掉任何一条 `check`**，断言数 1794 不变。

### 4.1 U05 `未知/未测` —— `tests/b06-quadrants.mjs` ⑤

**掩盖源**：`page.js:2316` 那句「有一侧没有测量数据，不给结论（**缺失显示为未知/未测**，不是 0）」
把四个字印进**任何一次**渲染。

**改成**：按标签取出**那一行自己的取值格**（`factLine` 画出来的 `<div class="hint" style="padding:0">标签: 值</div>`），
读它自己的文字；并加反面 —— 真有测量值的那一行必须印值本身。

```js
const factOf = label => {
  const found = new RegExp('<div class="hint" style="padding:0">' + label + ': ([^<]*)</div>').exec(html)
  return found === null ? undefined : found[1]
}
equal(factOf('排名'), '未知/未测', '我方那一行的取值格自己必须印「未知/未测」: ')
equal(factOf('观测周期'), '未知/未测', '我方观测周期那一行: ')
/* 反面：真有测量值的那一行不许被印成缺失 */
equal(factOf('竞品最好排名'), '4', '竞品那一行有自己的测量值，必须印值本身: ')
```

**证伪原文**：

```
（未改坏）b06-quadrants.mjs  ->  12 passed, 0 failed
$ node .t3-mutate.mjs .t3-spec.json U05
applied U05: amazon-ops/src/web/page.js
  - "  const shown = (value === null || value === undefined || value === '') ? '未知/未测' : String(value);"
  + "  const shown = (value === null || value === undefined || value === '') ? '未知值' : String(value);"
$ node .t3-subset.mjs amazon-ops/tests/b06-quadrants.mjs
  ->  11 passed, 1 failed
  FAIL ⑤ 缺失渲染成未知而不是 0
         我方那一行的取值格自己必须印「未知/未测」: expected "未知/未测", got "未知值"
```

### 4.2 U09 + U10 `草案未采纳` —— `tests/b13d-validation-delivery.mjs` ㉑

**掩盖源（两个，各遮一条）**：报告正文里「草案未采纳」有**两个出处** ——
这一段上面那行计数「草案未采纳（不要去改）1」（`report.js` 里**硬写**的词），
与清单里**行尾的状态词**（来自 `DELIVERY_STATUS_LABELS.not_accepted`）。
U09 改的是状态词表、U10 改的是 HTML 计数段，**各改一处，另一处把断言撑住**。
另外 U10 原来还是 `A || B` 结构（`去独立编辑器 || 草案未采纳`），本身就不承重。

**改成**：`md` 与 `html` 各读**两处自己** —— 行尾的状态词 / 行内状态胶囊，以及计数那一段自己的词与数字；
并加反面（已采纳的那一行必须印**另一个**词，且只允许一行带这个状态）。

```js
/* md：认行靠「这一行有自己的状态词」，读它自己 */
const aplusRow = mdLines.find(line => line.startsWith('- [') && line.includes('A+ 品牌故事模块')) ?? ''
equal(/`([^`]*)`$/.exec(aplusRow)?.[1], '草案未采纳', "the unaccepted row's own status word: ")
/* 反面：已采纳的那一行必须印另一个词 */
const readyRow = mdLines.find(line => line.startsWith('- [') && /`可复制粘贴`$/.test(line)) ?? ''
equal(readyRow !== '', true, 'the accepted row prints its own, different word: ')
equal(mdLines.filter(line => /`草案未采纳`$/.test(line)).length, 1, 'exactly one row carries that status: ')

/* html：认行靠「这一行有自己的状态胶囊」，不靠那个词 */
const liOf = text => html.split('<li>')
  .find(part => part.includes(text) && part.includes('<span class="pill">'))?.split('</li>')[0]
const pillOf = li => /<span class="pill">([^<]*)<\/span>/.exec(li ?? '')?.[1]
equal(pillOf(liOf('品牌故事模块')), '草案未采纳', "the unaccepted row's own pill in the HTML: ")
equal(pillOf(liOf('可复制粘贴')), '可复制粘贴', "the accepted row's own pill in the HTML: ")
/* 计数那一段自己也读一遍 */
const countsP = /<p>这一轮 <strong>(\d+)<\/strong> 条操作：([^<]*)<\/p>/.exec(html)
equal(String(countsP?.[2]).includes('草案未采纳（不要去改）1'), true, 'the HTML counts paragraph spells its own words: ')
```

> **一个踩到的坑（记下以免再犯）**：第一版我写的是
> `html.split('<li>').find(part => part.includes('品牌故事模块'))`，结果 `find` 命中了
> **草案正文里的 `<h4>A+ 品牌故事模块</h4>`**（它在清单之前），取到的段落里没有胶囊，
> 断言在**干净树**上就红了（`expected "草案未采纳", got undefined`）。
> 修法是把「这一行有自己的状态胶囊」也写进认行的条件 —— **认行不能靠被钉的那个词**，
> 这正是 round 1 在 R2 上用过的手法。

**证伪原文**：

```
（未改坏）b13d  ->  24 passed, 0 failed
$ node .t3-mutate.mjs .t3-spec.json U09      # delivery.js 状态词表
  - "  not_accepted: '草案未采纳',"  + "  not_accepted: '未采纳草案',"
  ->  23 passed, 1 failed
  FAIL b13d-delivery ㉑ 报告与面板读同一个 buildDelivery：改一处，两处一起变
         the unaccepted row's own status word: expected "草案未采纳", got "未采纳草案"

$ node .t3-mutate.mjs .t3-spec.json U10      # report.js HTML 计数段
  - "      + `草案未采纳（不要去改）${…} · 本轮没有生成 ${…} · `\n      + `必须人工填 ${…} · 已登记发布 ${…}</p>`)"
  + "      + `未采纳草案（不要去改）${…} · 本轮没有生成 ${…} · `\n      + `必须人工填 ${…} · 已登记发布 ${…}</p>`)"
  ->  23 passed, 1 failed
  FAIL b13d-delivery ㉑ 报告与面板读同一个 buildDelivery：改一处，两处一起变
         the HTML counts paragraph spells its own words: expected true, got false
```

### 4.3 U15 `时效` —— `run.mjs:5122`

**掩盖源**：`page.js:7628` 面板底部那句「**时效**阈值只读引用规则口径基线（7 / 30 / 90 天），
不新增档位，也不可配置。」把「时效」印进任何一次渲染。

**改成**：读**那一格胶囊自己的文字**（维度胶囊是 `chip(label, value)` 画出来的
`<span class="chip …">标签 计数</span>`）；反面 —— 服务端**没给**标签的那一维必须印机器名，
且给了标签的那一维**不许**印机器名。

```js
const chipText = label => {
  const found = new RegExp('<span class="chip[^"]*">' + label + ' (\\d+)</span>').exec(html)
  return found === null ? undefined : found[1]
}
equal(chipText('时效'), '1', 'the freshness chip prints the label the server sent, with its own count: ')
equal(chipText('有效'), '1', 'and so does the validity chip: ')
equal(chipText('completeness'), '0', 'a dimension with no server label falls back to its machine name: ')
equal(chipText('freshness'), undefined, 'freshness must not be drawn under its machine name when a label was sent: ')
```

**证伪原文**（改前 1794/0 → 改后 1793/1）：

```
$ node .t3-mutate.mjs .t3-spec.json U15
applied U15: amazon-ops/src/web/page.js
  - "      labels[dimension] || dimension,"
  + "      dimension,"
$ cd amazon-ops; node tests/run.mjs
1793 passed, 1 failed
  FAIL the cockpit tab draws inside the quality container, and only offers legal moves
```

### 4.4 U18 `层级` —— `tests/kw-master.mjs`

**掩盖源**：「层级」在这份输出里有**四个**出处 —— 统计分布那一行、表头那一格、图例那一行、
末尾提示那一行。改坏其中任一处，另外三处还印着它。

**改成**：**四处各读自己那一行**（用行首锚点，不用整份输出），并加反面（分布行与图例行是两行）。

```js
const tierDist = kwLines.find(line => /^层级: L\d=/.test(line)) ?? ''
equal(tierDist !== '', true, 'the stats block names the tier distribution on its own line: ')
const tierLegend = kwLines.find(line => /^层级: L1-/.test(line)) ?? ''
equal(tierLegend.includes('按搜索量分档'), true, 'the tier legend spells the ladder and what it means: ')
const kwHeader = kwLines.find(line => /关键词\s+站点\s+搜索量/.test(line)) ?? ''
equal(/搜索量\s+层级\s+优先级/.test(kwHeader), true, 'the table header carries the tier column itself: ')
const tierHint = kwLines.find(line => line.startsWith('提示: 这里的「层级」是搜索量分档')) ?? ''
equal(tierHint !== '', true, 'the hint line says which tool has the other vocabulary: ')
equal(tierDist !== tierLegend, true, 'the distribution line and the legend line are two different lines: ')
```

实测的四行原文（诊断时打出来的）：

```
[ 0] "库内 22 条 · 有搜索量 9 · 无搜索量 13"
[ 6] "层级: L5=14  L4=4  L3=3  L2=1"
[12] "关键词   站点  搜索量  层级  优先级  漏斗  曝光  订单  花费  CVR%  竞品最好  产品线  来源"
[20] "层级: L1-超级热词 < L2-热词 < L3-核心词 < L4-长尾词 < L5-长尾尾词（按搜索量分档，L5 含无搜索量的词）"
[22] "提示: 这里的「层级」是搜索量分档；浏览器扫出来的 T1–T4 分层在 amzn_keyword_query 里。"
```

**证伪原文**：

```
（未改坏）kw-master  ->  114 passed, 0 failed
$ node .t3-mutate.mjs .t3-spec.json U18
  - "          dist('层级', stats.bySvTier),"   + "          dist('档位', stats.bySvTier),"
  ->  113 passed, 1 failed
  FAIL amzn_kw_query renders a table and a stats block
         the stats block names the tier distribution on its own line: expected true, got false
```

### 4.5 U19 `闸门` —— `tests/probe-routes.mjs:210`

**掩盖源**：「闸门」在报告里有**三处** —— 8.1 的小节标题、表头那一格、下面那句 blockquote。

**改成**：先认 8.1 那一节，再读**它自己那张表的第一个表头格**；并加一句反面（那一句「闸门与规则是两件事」还在）。

```js
const gateSection = /<h3>8\.1 六道闸门<\/h3>[\s\S]{0,400}?<th>([^<]*)<\/th>/.exec(html)
if (gateSection === null) throw new Error('the report has no gate section heading + table')
if (gateSection[1] !== '闸门') {
  throw new Error(`the gate table's own header cell is ${JSON.stringify(gateSection[1])}, expected "闸门"`)
}
if (!html.includes('闸门与规则是两件事')) {
  throw new Error('the report no longer says the gate and the rules are two different things')
}
```

**证伪原文**：

```
$ node .t3-mutate.mjs .t3-spec.json U19 | Out-Null
$ cd amazon-ops; node tests/probe-routes.mjs US
Error: the gate table's own header cell is "门槛", expected "闸门"
EXIT=1
```

---

## 5. 口径盲区的补法（任务书点名的那一条）

### 5.1 round 1 给的解释不完整

round 1 §6.2c 写：「词表型」的定义是「长度 ≤ 6 且单独成串」，所以嵌在 HTML 模板里的标签
（`'<button id="collectEnvRun" …>一键体检</button>'`）不算词表型，R7 因此漏掉。

**这句话指出了一个真问题，但漏掉了更靠前的一层。** 我把口径按它说的改（去掉「恰好等于」这个形状），
`一键体检` **仍然**是 0 个出处 —— 因为还有第二层原因：

> **`src/web/page.js` 把整个页面脚本放在一个带 `${}` 的模板串里。**
> 按「模板串含 `${}` ⇒ 它是随数据变的文案」这条规则，**页面脚本里的全部字符串字面量
> 被一次性排除掉了**。而本仓大部分中文标签正是页面脚本印出来的。

所以旧口径对 `page.js` **整体失明**。这也解释了为什么附录 B 里那 19 条大多落在 `page.js` 上，
却是靠**别的文件**（工具、域层）里的同名出现才被选进候选表的。

### 5.2 补法（两条，都必须有）

1. **递归进模板体**：模板体里嵌的是真代码，它的字符串字面量要按真字面量算。
   不含 `${}` 的那些，就是不随数据变的出现。
2. **词表型改成「整串等于 **或** 是某个 HTML 文本节点」**：按 HTML 标签与尖括号切出文本节点再判「等于」。
   只按完整标签切还不够 —— 本仓真实的那一处是**片段**
   （`'style="margin-left:auto">一键体检</button>'`，不是 `'<button …>…</button>'`），
   所以要连单个 `>` 一起切。

判据本身不变，仍是**「这个词在不含 `${}` 的字面量里有 ≥2 个互不相同的出处」** ——
因为只出现在 1 个这样的字面量里时，把它改坏，标签就整份消失，断言必红；
出现在 ≥2 个里时，改坏任一处，另一处照样把它印出来，断言恒真。

### 5.3 实测对比（`node .t3-scope-scan.mjs`，一次性脚本已删，口径见 5.2）

```
含汉字的 includes 断言标签：586
旧口径候选标签（整串恰好等于 ∧ ≥2 个出处）：74
新口径候选标签（含 HTML 文本节点 ∧ ≥2 个出处）：110

新口径多抓到 36 个标签；**漏掉 0 个**（旧口径的命中全部保留）

  [样本] 一键体检   出处=2   旧口径=**漏掉**   新口径=命中     ← R7 漏掉的那一个，现在抓住了
  [样本] 闸门      出处=24  旧口径=命中        新口径=命中
  [样本] 未知/未测  出处=4   旧口径=命中        新口径=命中
  [样本] 草案未采纳  出处=2   旧口径=命中        新口径=命中
  [样本] 时效      出处=5   旧口径=命中        新口径=命中
  [样本] 层级      出处=21  旧口径=命中        新口径=命中
```

> ⚠️ **口径仍是筛子，不是清单。** 新口径把候选从 74 扩到 110（+49%），但它的作用仍然只是
> **把「可能被掩盖」的标签挑出来**；「是不是假绿」只有变异能回答 ——
> 本轮 19 条里 13 条承重就是反证。
> **另一条更硬的结论**：`page.js` 那种「整页脚本住在一个模板串里」的写法会让**任何**纯文本口径
> 对页面标签失明，所以**变异测试不能省**。

---

## 6. 独立发现一：`tests/probe-routes.mjs` 在未改动的 main 上就跑不通

### 6.1 现象

候选 #19 的断言在 `probe-routes.mjs:210`。我按纪律**先跑一遍未改动的探针**：

```
$ cd amazon-ops; node tests/probe-routes.mjs US
row in db: status=running report_md=null report_html=null
GET /report/dad590d0 -> 404 (662 chars)
未核验声明: 不适用（该站点有核验来源）
Error: the report has no gate section
    at tests/probe-routes.mjs:210:33
=== EXIT 1 ===
```

**它在 main 上就抛错**，而且因为它**不在 `run.mjs` 的用例集里**（不计入 1794），没有人发现。

### 6.2 根因（诊断到工具返回层）

探针第 119/122 行把工具返回 `String()` 之后打印，于是**拒因被吞成 `[object Object]`**。
我写了一次性诊断脚本（`.t3-probe-diag.mjs`，已删）把原始返回 JSON 化：

```
### optimize_validate :: object
{
  "ok": false,
  "code": "STRATEGY_UNCONFIRMED",
  "error": "第 e0b62710 轮的策略还没有人工确认 —— …去工作台「优化 → 策略阶段」看九项，或调 amzn_optimize_strategy 读一遍。"
}

### optimize_save :: object
{ "ok": false, "error": "run e0b62710… has no drafts — call amzn_optimize_validate with persist: true first" }
```

链条是：**探针写于 F13-05（策略确认门禁）之前** → `validate` 被 `STRATEGY_UNCONFIRMED` 拒 →
没有草案落库 → `save` 被「has no drafts」拒 → 这一轮永远停在 `status=running`、
`report_md = null` → `GET /report/<id>` 404 → 第 210 行读到的永远是那张 404 页。
**错误信息指向 210 行，而真正的原因在 89–122 行。**

### 6.3 修法（只改夹具，不动断言）

按主理人裁决，`tests/**` 是我的写作用域，所以修了，但**一个字都没动它的断言**：

1. 把「找 `/api` 路由 + `call()` 调用器」这一段**上移到工具驱动之前**（确认要走页面路由，
   而工具侧是只读的 —— `amzn_optimize_strategy` 的 description 明写
   「Read-only: confirmation happens in the workbench」）；
2. 在 `optimize_prepare` 与 `optimize_validate` 之间**补一步**
   `POST <api>/optimize-strategy-confirm {runId, by:'probe-routes'}`，并在非 200 时**明确抛错**
   （不静默）。

**结果**：

```
$ cd amazon-ops; node tests/probe-routes.mjs US
row in db: status=done report_md=18587 report_html=34688
GET /report/bf046099 -> 200 (34688 chars)
…
probe ok
=== EXIT 0 ===
```

### 6.4 遗留（我没有改，登记在此）

探针仍然把非字符串返回 `String()` 成 `[object Object]`（第 119/122 行）。
**这一次是拒因被吞，下一次可能又是别的。** 建议改成
`if (typeof x !== 'string') throw new Error(JSON.stringify(x))` ——
它是一句**新增**的守卫，不属于本轮授权范围（主理人要求「不要改它的断言」），所以留给出题人。

**候选 #19 的定性**：见 §2 与 §4.5 —— 夹具补全之后它是**可评估**的，而且评估结果是**假绿**（已修）。
在夹具补全**之前**，它的前提不成立，「改坏还红不红」这个判据用不上 —— 那一段历史如实记在这里。

---

## 7. 独立发现二：17 处 `checkAsync(...)` 没有 `await`（6 个模块）

### 7.1 实测（`node .t3-floaters.mjs`，一次性脚本已删）

```
有悬空 checkAsync 的模块：6
  b05c-history.mjs            checkAsync 共   5，await   0，悬空   5  行号 143,418,466,479,596
  b05c-health.mjs             checkAsync 共   4，await   0，悬空   4  行号 444,471,487,514
  b05c-import.mjs             checkAsync 共   4，await   0，悬空   4  行号 243,369,406,445
  b12-8-blocked-recovery.mjs  checkAsync 共  10，await   8，悬空   2  行号 251,368
  b04-collect-page.mjs        checkAsync 共  18，await  17，悬空   1  行号 1012
  b11-8-version-compare.mjs   checkAsync 共   4，await   3，悬空   1  行号 379

悬空 checkAsync 合计：17
```

三个模块（`b05c-history` / `b05c-health` / `b05c-import`）**全部** `checkAsync` 都是悬空的。

### 7.2 危害，以及为什么**全量**仍然安全

`checkAsync` 的断言在第一个 `await` 之后挂起，模块 runner 返回时它们还没跑。
`passed` / `failed` 是 `run.mjs` 的模块级计数器，所以：

- **全量安全**：后面还有很多模块在 `await`，事件循环被排空，悬空的那些**最终会记进 1794**。
  实测支持这一点：`b05c-history` 单跑排空前 18 条、排空后 22 条，而全量总数 1794 与
  「22 条都算进去」一致。所以 round 1 用全量得出的结论**不受影响**。
- **子集不安全**：没有后续模块排空 → 把「还没跑」读成「没红」。**我自己就栽在这里**（§1.2）。
- **仍然真实的两个风险**：
  1. **计数归错模块**：失败信息会挂在「当时正在 await 的那个模块」旁边，定位会跑偏；
  2. **尾部风险**：如果悬空的断言出现在**最后**几个模块里，进程可能在它跑完前就打印汇总并退出 ——
     那一条断言就等于不存在。本轮这 6 个模块都在中段，所以**当前没有实际损失**，
     但这是一个**靠运气**的性质。

### 7.3 建议（不改，登记）

把 17 处补上 `await`（纯机械改动）。改完之后模块自报条数会从 18/… 变成 22/…，
**总数不变**（1794），所以不会有断言数下降的问题。建议由开发批次连同 §8 的判定表一起做。

---

## 8. 49 条孤儿导出逐条判定

### 8.0 实测现状（与基线一致）

```
$ node .t3-orphans.mjs
exported=972  sourceFiles=191  testFiles=71
unwired=49  listed=49
越界(未登记)=0  死条目(已接线)=0
```

> ⚠️ 注：`wired-source.mjs` 的健全性断言②写的是「预期 800+（B-05 之后全源码 812）」，
> 而**实测已经是 972 个导出 / 191 个源码文件**（阈值 800 / 155 仍有余量）。
> 那两个数字是注释里的旧值，不影响判据；**记录在此，免得下一个人按 812 估删除空间**。

### 8.1 处置原则（本轮）

- **不改 `src/**`**（主理人裁决 A：QA 不改被测代码；且此刻另有三名成员在改
  `src/domain/collect/**`、`src/domain/snapshot/**`、`src/domain/dashboard/**`）。
- 因此本轮产出的是**逐条判定 + 证据 + 确切改动**，交给开发批次执行。
- `UNWIRED` 表本轮**只订正过期的理由，不删条目** → 孤儿仍 49、越界 0、死条目 0。

### 8.2 A 组 —— **假阳性，实际已接线**（2 条）：保留，不是死代码

| 导出 | 文件 | 证据（实测） | 判定 |
|---|---|---|---|
| `sectionShortLabel` | `src/domain/rules/listing-fields.js:311` | 被 `groupLabels` 以 **`.map(sectionShortLabel)`** 当回调引用（同文件 `:333`），名字后面**没有括号**，所以「后跟左括号」的口径数不到。`groupLabels` 生产调用 **2** 次 | **保留**（口径假阳性） |
| `CdpConnection` | `src/sources/cdp/client.js` | 被 `src/sources/browser/collector.js:99` 以 **`CdpConnection.open(wsUrl)`** 静态方法调用（名字后面是 `.`）。同文件 `sleep`(21)/`evaluate`(12)/`navigate`(8) 等 8 个导出都已接线 | **保留**（口径假阳性） |

### 8.3 B 组 —— **落在并发写者作用域内**（6 条）：保留 + 理由

这 6 条的文件此刻由另外两名成员在改。**本轮不动，也不下删除结论** ——
`collect/sections.js` 那三个尤其要看 B-04 的节写入器批次怎么收口。

| 导出 | 文件 | 实测 | 判定 |
|---|---|---|---|
| `sectionOrder` | `src/domain/collect/sections.js` | 全仓零调用（含测试）；同文件 `sectionValueCounts`(6)/`sectionContentUnread`(3)/`sectionLabel`(1) 都已接线 | 保留（禁改区） |
| `sectionFields` | 同上 | 同上 | 保留（禁改区） |
| `sectionStatusFromValue` | 同上 | 只被 `b04-collect-tools.mjs` 调用 | 保留（禁改区） |
| `cardSpecs` | `src/domain/dashboard/health.js:352` | 全仓零调用；同文件 `buildHealthCards`(2) 已接线。它自己的 doc 写「for a caller that wants to know what should be there」—— **目前没有这样的调用方** | 保留（禁改区） |
| `isFavorite` | `src/domain/dashboard/pins.js:119` | 全仓零调用；同文件 `readPins`(1)/`toggleFavorite`(1)/`pinView`(1)/`readList`(4) 都已接线 | 保留（禁改区） |
| `countTodos` | `src/domain/dashboard/todos.js:75` | 只被 `run.mjs` 调用；`src/web/routes.js:4060` 传的是 `buildTodos(store, scope)`，桶计数目前由页面从载荷里数 —— **这是「第二份实现」的形态，属于接线候选**，但页面/路由都不在本轮写作用域 | 保留（禁改区）+ 标接线候选 |

### 8.4 C 组 —— **真死代码，建议删除**（15 条，全部在禁改区之外）

判据：`kind === 'no-caller'`（**连测试都不调用**），且同文件/同层的**兄弟实现已经接线**
（说明这个模块是活的，只是这一个函数没人用）。每条给了确切位置与删除依据。

| # | 导出 | 文件:行 | 同文件已接线的兄弟（生产调用次数） | 建议 |
|---|---|---|---|---|
| C1 | `createDefaultSettings` | `src/domain/settings.js:67` | **整个文件零引用**（`src` 与 `tests` 都不 import 它；`SETTING_DEFAULTS`/`SETTING_PATTERNS`/`SETTING_KEYS` 同样无人引用） | **删这两个函数；若确认 `SETTING_*` 三个常量也无引用，整个文件可删** |
| C2 | `isKnownSettingKey` | `src/domain/settings.js:72` | 同上 | 同上 |
| C3 | `findHeaderRow` | `src/domain/keywords/csv.js:71` | `parseCsv`(3) / `toNumber`(34) / `toText`(18) / `stripBom`(1) | **删** |
| C4 | `toRecords` | `src/domain/keywords/csv.js:88` | 同上 | **删** |
| C5 | `isEmptySignals` | `src/domain/keywords/signals.js` | `readSignalCategories`(10) / `signalsJson`(2) / `positiveSignals`(2) / `builtinSignals`(1) / `excludeSignals`(1) / `matchesSignals`(1) | **删** |
| C6 | `needsBaselineChoice` | `src/domain/observe/deviation.js` | `computeDeviation`(1) / `buildApprovedSnapshot`(1) | **删** |
| C7 | `observableMetrics` | `src/domain/observe/metrics.js` | `checkObservationData`(2) / `snapshotMetrics`(1) | **删** |
| C8 | `groupBySection` | `src/domain/rules/listing-fields.js:221` | 已被 `groupLabels`(2) + `orderFields`(4) 取代；同文件另有 8 个导出已接线 | **删** |
| C9 | `planPositionPurpose` | `src/domain/states.js` | `canTransition`(3) / `canTransitionKeyword`(2) / `canTransitionCollectionTask`(2) / `canTransitionScheme`(2) / `isPlanPosition`(1) | **删** |
| C10 | `listTargets` | `src/sources/cdp/client.js` | `sleep`(21) / `evaluate`(12) / `probeVersion`(8) / `navigate`(8) / `applyStorefront`(6) / `openPage`(3) / `closePage`(3) / `humanize`(1) | **删** |
| C11 | `findExtractor` | `src/sources/pages/index.js` | 已被 `extractorForTarget`(3) 取代（`supportedFields`(3) 也已接线） | **删** |
| C12 | `marketFacts` | `src/store/settings.js` | `getSetting`(19) / `setSetting`(4) / `postalCodeFor`(4) / `listSettings`(3) / `declaredSettings`(1) / `deleteSetting`(1) / `settingsRowsFor`(1) / `pacingSettings`(1) / `redactSource`(1) / `listSourcesRedacted`(1) | **删** |
| C13 | `browserSettings` | `src/store/settings.js` | 同上 | **删** |
| C14 | `lastVerifiedAt` | `src/store/site.js` | `getSiteProfile`(3) / `listSiteProfiles`(3) / `isSeedVerification`(1) / `upsertSiteProfile`(1) / `recordSiteVerification`(1) / `listAllVerifications`(1) | **删** |
| C15 | `readLineSignals` | `src/domain/keywords/classify.js:139` | 它是 `readSignalCategories` 的**包装**，而生产侧 **8 处直接调内层**（`routes.js:880/3376`、`product-line.js:93/100/119`、`tools/product-line.js:55`、`impact.js:88`、`wizard.js:84`、`classify.js:105`）。同文件另有 15 个导出已接线 | **删**（或接线；删除更省，因为接线等于把内层调用改成包装调用，不增加能力） |

> ⚠️ **删除前请跑一次 `node tests/run.mjs`**：这 15 条都是 `no-caller`，
> 理论上没有测试依赖；但 `createDefaultSettings`/`isKnownSettingKey` 所在的**整个文件**
> 若有间接引用（再导出、动态 import），只有跑一遍才知道。
> 另外健全性断言②的阈值是 `exported.length >= 800`，当前 972，删 15 条仍有余量。

### 8.5 D 组 —— **`test-only`，生产路径未接**（26 条）：保留 + 逐条理由

| # | 导出 | 文件 | 生产侧实际走的路（实测） | 判定 |
|---|---|---|---|---|
| D1 | `datasetById` | `src/domain/catalog/datasets.js:478` | `src/store/catalog.js` 只消费 `DATASETS` **数组**（`catalog.js:29/51`）；单数据集视图没有生产入口 | 保留 |
| D2 | `datasetsForAsset` | `src/domain/catalog/datasets.js:484` | 同上；按资产类型过滤没有生产入口 | 保留 |
| D3 | `extractNgrams` | `src/domain/keywords/classify.js:351` | 生产的分词走 `extractModifiers`(1) | 保留 |
| D4 | `headerIndex` | `src/domain/keywords/xlsx.js:274` | 被 `importers.js:892` **再导出**，但再导出之后**没有任何调用点**；`importers.js` 自己有 `findColumn` | 保留（再导出是死链） |
| D5 | `isDraftPublishable` | `src/domain/optimize/validate.js:464` | 生产用 `isPublishable`（`listing-fields.js`，5 处） | 保留 |
| D6 | `lexiconNote` | `src/domain/rules/lexicon.js:318` | 只被 `run.mjs` 调；页面与工具都不读它 | 保留（**接线候选**：政策口径说明） |
| D7 | `orphanChecks` | `src/domain/rules/registry.js:152` | 生产用 `missingChecks` / `genericCheck` / `resolveCheck` | 保留 |
| D8 | `unavailableKinds` | `src/domain/search/index.js` | 同名的是别处的**对象属性名**，不是这个函数（round 1 已核实，本轮复验一致） | 保留 |
| D9 | `isTier` | `src/sources/keyword-tiers.js:55` | 只被 `run.mjs` 调；采集器走的是 `parseOrganicRank` 等另一条解析路径 | 保留 |
| D10 | `organicRank` | `src/sources/keyword-tiers.js:135` | 同上 | 保留 |
| D11 | `datasetView` | `src/store/catalog.js:72` | 页面读的是 `catalogView` | 保留 |
| D12 | `reopenConflict` | `src/store/conflict.js:352` | 「重开冲突」没有生产入口（页面只提供 resolve） | 保留 |
| D13 | `fieldProvenance` | `src/store/field-source.js:62` | 血缘页读的是 `traceField` | 保留 |
| D14 | `getMaster` | `src/store/kw.js:764` | 生产走 `queryMaster`；`src/store/keyword-detail.js:7` **专门写了一节「为什么不复用 getMaster」**（它返回的是聚合标量，会丢周期） | 保留（刻意不接） |
| D15 | `policiesForRule` | `src/store/policy.js:351` | 规则反查政策没有生产入口 | 保留 |
| D16 | `supersede` | `src/store/policy.js:487` | 取代走 `importPolicy` 的 `supersedes` 参数（**同一事务**），单独入口没有生产调用方 | 保留 |
| D17 | `policyChain` | `src/store/policy.js:502` | 链由 `listPolicies` 的 `supersedes` 反向映射给出（`supersedesMap`） | 保留 |
| D18 | `deleteReport` | `src/store/reports.js:240` | 报告删除没有生产入口（页面不提供删除） | 保留 |
| D19 | `listSiteVerifications` | `src/store/site.js:159` | 生产读 `listAllVerifications`(1) | 保留 |
| D20 | `diffSnapshots` | `src/store/snapshot.js:351` | ASIN 快照是**指针**（`payload_json` NULL），本函数**按名字拒绝**指针快照（`snapshot.js:356`）；生产读 `asin_snapshot.payload_json` 并调**同一个** `diffPayloads` | 保留（**理由已订正**，见 §8.6） |
| D21 | `listEnvChecks` | `src/store/collection-env.js:159` | 生产读 `latestEnvChecks`（`routes.js:4816`、`domain/audit/targets.js:564`） | 保留 |
| D22 | `envCheckSummary` | `src/store/collection-env.js:192` | 同上（汇总没有生产读者） | 保留 |
| D23 | `listSchemeVersions` | `src/store/collection-scheme.js:222` | 当前版本走 `currentSchemeVersion` | 保留 |
| D24 | `collectedSections` | `src/store/collection-section.js:396` | 已采节清单没有生产消费者 | 保留 |
| D25 | `listTaskEvents` | `src/store/collection-task-event.js:110` | §9 任务画布未建 | 保留 |
| D26 | `countTaskEvents` | `src/store/collection-task-event.js:121` | 同上 | 保留 |

### 8.6 本轮改动的 `UNWIRED` 条目（只订正过期理由，条目数不变）

**D20 `diffSnapshots`** —— 旧理由写「（**F05-04 的 listing diff 未建**）」，**已过期**：
F05-04 建了（`src/domain/asin/history.js`），而它**故意**不用这个函数，理由在
`history.js:10-15` 与 `snapshot.js:343-360`：ASIN 快照登记为指针，指针没有冻结的 body 可比，
凭空造一个空 diff 会被读成「没变化」，所以**按名字拒绝**；生产读 `asin_snapshot.payload_json`
并调**同一个** `diffPayloads`（「什么算变化」仍只有一份实现）。
理由已按实测重写，**条目保留**（它仍然是「两份**已冻结** payload 之间的 diff」这个 API，本仓只有测试在调）。

另外在文件头的口径说明里加了一段，指向本报告，说明「本轮只订正理由、不删条目」以及
21/28 的分类与建议去向。

---

## 9. 证据

### 9.1 全量（唯一的最终判据）

```
基线（main d6cfc0c，测试未改）：      1794 passed, 0 failed   （161.3s）
本轮（本工作树，测试已改）：          1794 passed, 0 failed
$ cd amazon-ops; node tests/run.mjs
  ok   D4 ⑤ the run detail offers a copy-to-ask control carrying the run id, and the page contains no fake deep link
1794 passed, 0 failed
(plugin root: D:\deepseek-harness-h\workspace\wt-t3-qa\amazon-ops)
CLEAN_EXIT=0
```

**断言数 1794 = 基线 1794**：六条修法都在**既有 `check` 块内**改读法，
**没有删掉任何一条 `check`**，所以条数不变（满足「≥ 1794 且只增不减」）。

### 9.2 迁移表自洽

```
$ node scripts/check-migrations.mjs
{"count":45,"SCHEMA_VERSION":45,"dups":[],"continuous":true,"last":"agent-run-task-type","first":"initial-schema"}
迁移表自洽 ✓   (EXIT 0)
```

### 9.3 `src/**`：我对它贡献了 **0 字节**

⚠️ **注意 `main` 在本轮期间前进了**（另有两名成员在提交），所以「与 `main` 逐字节相同」
这个写法**已经不成立、也不该成立** —— 正确的证据是**与我的基点 `d6cfc0c` 相同**，
且 `main` 那一侧的 `src` 增量**恰好等于另一个成员的提交**。

```
$ git diff --stat d6cfc0c -- amazon-ops/src
（空）                                  ← 我的工作树 src 与基点逐字节相同

$ git status --porcelain -- amazon-ops/src
（空）                                  ← 没有未提交的 src 改动

$ git diff --stat d6cfc0c main -- amazon-ops/src
 amazon-ops/src/domain/asin/history.js     | 25 ++++++++++---------------
 amazon-ops/src/domain/dashboard/health.js | 12 ++++++++++--
 amazon-ops/src/domain/snapshot/diff.js    | 20 +++++++++++++++-----

$ git diff --stat 4ba9041^ 4ba9041 -- amazon-ops/src
 amazon-ops/src/domain/asin/history.js     | 25 ++++++++++---------------
 amazon-ops/src/domain/dashboard/health.js | 12 ++++++++++--
 amazon-ops/src/domain/snapshot/diff.js    | 20 +++++++++++++++-----
                                            ← 与上一段**逐字相同**
```

即：`main` 现在停在 `c8d38e8`（`4ba9041` = T-1 修 D1「上游 `diffPayloads` 空 field 缺陷」
+ D2「dashboard 注释与代码不符」），那 3 个文件**全部是 T-1 的写作用域**，
与我的改动无关。**我这一轮一个字节都没碰 `src/**`。**

改动只在 `tests/**` 与 `docs/**`：

```
 M amazon-ops/docs/COORDINATION.md
 M amazon-ops/tests/b06-quadrants.mjs
 M amazon-ops/tests/b13d-validation-delivery.mjs
 M amazon-ops/tests/kw-master.mjs
 M amazon-ops/tests/probe-routes.mjs
 M amazon-ops/tests/run.mjs
 M amazon-ops/tests/wired-source.mjs
?? amazon-ops/docs/qa/INCLUDES-AUDIT-round2-2026-10-13.md
```

### 9.4 变异施加与还原

每条都是 `git checkout -- amazon-ops/src` → 施加 → 运行 → `git checkout -- amazon-ops/src`，
批处理脚本每轮结束打印 `src dirty after revert: 0`（实测每一批都是 0）。
19 条规格全部通过「`from` 在目标文件里恰好出现 1 次」的预检。

### 9.5 孤儿检查

```
$ node .t3-subset.mjs amazon-ops/tests/wired-source.mjs
  ->  7 passed, 0 failed
$ node .t3-orphans.mjs
exported=972  sourceFiles=191  testFiles=71
unwired=49  listed=49
越界(未登记)=0  死条目(已接线)=0
```

### 9.6 一次性产物

`.t3-*` 全部（脚本、日志、规格、诊断输出）在交回前删除，删前逐个核对了绝对路径。
本文件保留了可重跑的口径与全部命令。

### 9.7 复核命令（下一轮直接照跑）

```powershell
cd D:\deepseek-harness-h\workspace\wt-t3-qa
# 1) 全量
cd amazon-ops; node tests/run.mjs; cd ..
# 2) 施加一条变异（规格见 §9.8）
node .t3-mutate.mjs .t3-spec.json <ID>
# 3) 跑那条断言所在的模块（⚠️ 运行器必须排空悬空 promise，见 §1.2）
node .t3-subset.mjs amazon-ops/tests/<module>.mjs
# 4) 还原
git checkout -- amazon-ops/src
git diff --stat d6cfc0c -- amazon-ops/src      # 必须为空（⚠️ 不要拿 main 比：main 会被别人推进）
```

### 9.8 19 条变异规格（`from` / `to` 是**文件内容**，不经过命令行）

```json
[
 {"id":"U01","file":"amazon-ops/src/web/page.js",
  "from":"读不到设置行（设置切片未就绪），所以这一格没有控件 —— ","to":"读不到设置项（设置切片未就绪），所以这一格没有控件 —— "},
 {"id":"U02","file":"amazon-ops/src/domain/asin/table.js",
  "from":"  ownership: { self: '自有', competitor: '竞品' },","to":"  ownership: { self: '自家', competitor: '竞品' },"},
 {"id":"U03","file":"amazon-ops/src/domain/asin/table.js",
  "from":"  optimization: { running: '进行中', done: '已完成', failed: '失败', abandoned: '已放弃' },",
  "to":"  optimization: { running: '进行中', done: '已完工', failed: '失败', abandoned: '已放弃' },"},
 {"id":"U04","file":"amazon-ops/src/web/page.js",
  "from":"parts.push('<div class=\"b05c-note\">字段差异 <strong>'","to":"parts.push('<div class=\"b05c-note\">字段差异（不是「没有变化」） <strong>'"},
 {"id":"U05","file":"amazon-ops/src/web/page.js",
  "from":"  const shown = (value === null || value === undefined || value === '') ? '未知/未测' : String(value);",
  "to":"  const shown = (value === null || value === undefined || value === '') ? '未知值' : String(value);"},
 {"id":"U06","file":"amazon-ops/src/domain/keywords/competitor.js",
  "from":"  brandOnly: '仅品牌不相关',\n  unmeasured: '未测',","to":"  brandOnly: '仅品牌不相关',\n  unmeasured: '还没测',"},
 {"id":"U07","file":"amazon-ops/src/web/page.js",
  "from":"  voided: '已作废',\n  current: '当前上下文',","to":"  voided: '已废弃',\n  current: '当前上下文',"},
 {"id":"U08","file":"amazon-ops/src/domain/optimize/report.js",
  "from":"  push('| 检查项 | 依据 | 要问的问题 | 只能人判 |')","to":"  push('| 检查项 | 依据 | 要问的问题 | 须人判 |')"},
 {"id":"U09","file":"amazon-ops/src/domain/optimize/delivery.js",
  "from":"  not_accepted: '草案未采纳',","to":"  not_accepted: '未采纳草案',"},
 {"id":"U10","file":"amazon-ops/src/domain/optimize/report.js",
  "from":"      + `草案未采纳（不要去改）${delivery.counts.notAccepted} · 本轮没有生成 ${delivery.counts.noText} · `\n      + `必须人工填 ${delivery.counts.humanRequired} · 已登记发布 ${delivery.counts.registered}</p>`)",
  "to":"      + `未采纳草案（不要去改）${delivery.counts.notAccepted} · 本轮没有生成 ${delivery.counts.noText} · `\n      + `必须人工填 ${delivery.counts.humanRequired} · 已登记发布 ${delivery.counts.registered}</p>`)"},
 {"id":"U11","file":"amazon-ops/src/domain/collect/blocked-page.js",
  "from":"    lines.push(`那一页现在不在浏览器里${recorded}。`)","to":"    lines.push(`那一页现在不在浏览器里${recorded}（不是采集失败）。`)"},
 {"id":"U12","file":"amazon-ops/src/web/page.js",
  "from":"      : '<div class=\"action\" data-action=\"' + escapeHtml(action.id) + '\" data-link=\"' + escapeHtml(String(action.link)) + '\">' + body + '</div>';",
  "to":"      : '<div class=\"action\" data-action=\"' + escapeHtml(action.id) + '\" data-link=\"' + escapeHtml(String(action.link)) + '\">' + body + '<span>未接入</span></div>';"},
 {"id":"U13","file":"amazon-ops/src/web/page.js",
  "from":"        + (card.status === 'error' ? '计算失败' : card.status === 'empty' ? '暂无数据' : '正常') + '</span></div>'",
  "to":"        + (card.status === 'error' ? '算不出来' : card.status === 'empty' ? '暂无数据' : '正常') + '</span></div>'"},
 {"id":"U14","file":"amazon-ops/src/web/page.js",
  "from":"  const head = '<div class=\"rule-sect\" style=\"border-top:none\">质量驾驶舱（七维度问题清单）</div>'",
  "to":"  const head = '<div class=\"rule-sect\" style=\"border-top:none\">数据质量台（七维度问题清单）</div>'"},
 {"id":"U15","file":"amazon-ops/src/web/page.js",
  "from":"      labels[dimension] || dimension,","to":"      dimension,"},
 {"id":"U16","file":"amazon-ops/src/tools/kw.js",
  "from":"      lines.push(`关键词总库 (${result.rows.length}/${num(result.total)} 条，offset=${result.offset}):`)",
  "to":"      lines.push(`总库词表 (${result.rows.length}/${num(result.total)} 条，offset=${result.offset}):`)"},
 {"id":"U17","file":"amazon-ops/src/tools/kw.js",
  "from":"          `库内 ${num(stats.total)} 条 · 有搜索量 ${num(stats.withVolume)} · 无搜索量 ${num(stats.withoutVolume)}`,",
  "to":"          `库里 ${num(stats.total)} 条 · 有搜索量 ${num(stats.withVolume)} · 无搜索量 ${num(stats.withoutVolume)}`,"},
 {"id":"U18","file":"amazon-ops/src/tools/kw.js",
  "from":"          dist('层级', stats.bySvTier),","to":"          dist('档位', stats.bySvTier),"},
 {"id":"U19","file":"amazon-ops/src/domain/optimize/report.js",
  "from":"  push(htmlTable(['闸门', '结果', '说明'], model.gates.gates.map(gate => [",
  "to":"  push(htmlTable(['门槛', '结果', '说明'], model.gates.gates.map(gate => ["}
]
```

---

## 10. 不确定的地方 / 没做到的

1. **候选 #19 在夹具修好之前是 `unverified`。** 它的前提（这一轮能走到有报告的终态）在 main 上**不成立**，
   所以「改坏还红不红」这个判据**用不上** —— 那一段历史不是「安全」也不是「缺陷」。
   夹具修好之后它是**可评估**的，评估结果是**假绿**（已修，§4.5）。
2. **49 条孤儿只做了判定，没有执行。** 按主理人裁决 A，`src/**` 保持只读
   （QA 不改被测代码；且另有三名成员在改 `src/domain/collect/**`、`src/domain/snapshot/**`、
   `src/domain/dashboard/**`）。C 组那 15 条删除建议**没有跑过删除后的全量** ——
   删除前请跑一次 `node tests/run.mjs`（理由见 §8.4 的提示）。
3. **§7 那 17 处悬空 `checkAsync` 只登记，没有改。** 它们在当前排列下**没有造成实际损失**
   （后面还有很多模块排空事件循环），但这是**靠运气**的性质，不是靠设计。
   建议连同 §8 的判定表一起交开发批次。
4. **`probe-routes.mjs` 里「非字符串返回被 `String()` 成 `[object Object]`」没有修。**
   主理人要求「不要改它的断言」，而那句守卫属于新增，所以我留下了（§6.4）。
   **只要它还在，下一次探针失败还会指错地方。**
5. **新口径（§5）我只验证了它「能抓到已知的漏网标签」**，没有把 110 个候选标签逐条变异 ——
   那正是本轮的规模（19 条跑了 ~6 分钟），110 条不现实。所以新口径仍是**筛子**：
   它提高了召回，没有给出「谁承重」的答案。
6. **`wired-source.mjs` 健全性断言②里的「812 个导出」是旧值**（实测 972）。
   不影响判据（阈值 800 仍有余量），但**下一个人按 812 估删除空间会算错**。
7. **本轮没有跑真机采集，没有动 `data/amazon-ops.db`，没有改 schema 迁移，没有 `git commit`。**
