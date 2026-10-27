# INCLUDES 专项审计 —— 「词表标签型假绿」（amazon-ops）

- **日期**：2026-10-13
- **作者角色**：测试工程师（QA）
- **状态**：已通过（R2–R6 五条收口；另发现并修掉 R7、R8 两条同机制假绿）
- **关联需求编号**：无独立需求号；本文件是 `docs/qa/ROUND-2026-10-10-findings.md` 之后、
  对 `tests/**` 里 `includes('…中文标签…')` 型断言的一次专项复核。
- **证据等级**：`verified`（全部结论都是本次在本工作树里跑出来的原始输出；
  未跑到的部分单独标 `unverified`，见 §7）
- **工作树**：`D:\deepseek-harness-h\workspace\wt-dsh-incaud2`，分支 `dsh-incaud2`，基于 main `5a7b296`

---

## 0. 一句话结论

`tests/**` 里有大量 `X.includes('中文标签')` 型断言。这类断言有一个反复出现的失效模式：
**被钉的那个中文词在同一份渲染里还有第二个出处**（说明行、图例、计数行、另一列的数据），
于是把词表改坏，断言照样为真 —— 全绿，但什么都没钉住。

本次用**变异测试**（改坏生产侧 → 跑全量 → 看有没有红）作判据，把 6 条已知变异里的 5 条
（R2–R6）修成承重，并在复核过程中**又抓到 2 条**（R7、R8），共修 7 条。
`node tests/run.mjs`：修前 **1793 passed / 0 failed** → 修后 **1794 passed / 0 failed**
（断言数只增不减，新增 b13d-page ⑯）。

判据是**红不红**，不是**像不像图例**，也不是**在不在候选表里**：

- 有 3 条静态候选（S1、S4、S5）变异后确实变红 → 「进了候选表」≠「假绿」；
- 有 1 条真假绿（R7「一键体检」）**根本不在**静态候选表里（§6.2c），是靠变异才抓到的；
- 有 1 条真假绿（R8「查不了」）在候选表里，但光看「它像不像被图例掩盖」判不出来 ——
  同一个标签、同一次变异，读一行的断言红、读整份面板的断言不红（§3.4）。

---

## 1. 静态筛选口径：怎么把总量缩到候选

### 1.1 总量

口径：`amazon-ops/tests/**/*.mjs` 里形如 `.includes('字面量')`、且**字符串字面量是唯一实参**的调用。

| 口径 | 条数 |
|---|---|
| 字面量含汉字（任意位置） | **746** |
| 字面量**以汉字开头**（断言锚点就是那句中文标签） | **692** |
| 上一条 + 允许拼接实参（`includes('报告 ' + n)`） | 702 |
| 上一条 + 计入 `.startsWith(` | 696 |

主理人实测的 **697** 落在 **692–702** 这个区间里：差的只是「是否计入拼接实参与
`.startsWith`」这一条口径边界。**这不影响候选集** —— 候选集不是按计数筛的（见 1.2），
任何一条口径都给出同一批候选。下文一律用 **692**（最严的那条）。

### 1.2 缩到候选：只留「词表型 + 文案型同现」的标签

R3–R6 的机制是同一个：

1. 生产侧有一处**词表型**出现 —— 某个字符串字面量**恰好等于**那个标签
   （`{ pass: '通过' }`、`(gate.pass ? '通过' : '未过')` 里的 value 位）；
2. 生产侧**另有**一处**文案型**出现 —— 某个**不含 `${}` 插值**的更长字面量**包含**这个标签
   （说明行 / 图例 / 计数行）；
3. 第 2 类出现**不随数据变**，所以它把标签印进**任何一次**渲染；
4. 于是只读整份输出的 `includes(标签)` 结构性永真。

筛选脚本口径（一次性脚本已按纪律删除，正文留口径以便重跑）：

```js
// 步 1：收集断言 —— 字面量是唯一实参、以汉字开头
const ASSERT_RE = /\.includes\(\s*(['"])((?:(?!\1)[^\\\r\n]|\\.)*)\1\s*\)/g

// 步 2：收集 src/** 里全部字符串字面量（单/双引号/模板串），标出是否含 ${}
//   词表型 = 长度 ≤ 6 且单独成串（exactMap）
//   文案型 = 长度 > 6 且不含 ${}（containMap）

// 步 3：候选 = 该标签同时命中 词表型 与 文案型
```

结果：**692 条 → 80 个标签 / 122 条候选断言**（明细见附录 A）。

### 1.3 候选不是结论：再按「接收者」分一次

静态口径只看 `src/**`，它**看不到**第二个条件 —— **那句说明文案是不是和断言读的是同一份渲染**。
所以它必然过报。把 122 条候选按断言的**接收者表达式**分两类：

| 类别 | 条数 | 说明 |
|---|---|---|
| 读**整份渲染**（`html` / `text` / `output` / `out.text` / `envHtml` …） | **26** | 说明文案可能就在里面 → 必须变异 |
| 读**窄切片**（某一行 / 某一格 / 某一段 / 表内 / 某数组元素） | **96** | 说明文案不在那个切片里 → 结构上不可能被它满足 |

这个「接收者决定红不红」不是推测，是**本次实测出来的对照**：
同一个标签（`查不了`）、同一次变异（`ENV_STATE_CHIPS.unknown` 改成「查不到」），
读一行的断言（`B04P-⑦`）变红、读整份面板的断言（`B04P-⑱`）不变红 —— 见 §3.4 的 R8。

---

## 2. 候选表

「被哪个词表行掩盖」= 那个把标签印进任何一次渲染的**第二个出处**。

| # | 断言（文件:行） | 它声称检查什么 | 被哪个词表行掩盖 | 破坏性验证结果 | 处理 |
|---|---|---|---|---|---|
| **R1** | `tests/run.mjs`（`kw-competitor` 段，⑨ 四象限） | 工具端到端给出四象限与证据 | ——（对照，非候选） | 改坏 → **1 failed** | 无需处理（已承重） |
| **R2** | `tests/kw-report.mjs:429-430` `output.includes('总库报告')` | 报告清单一次列出两种报告 | `src/tools/report.js:33` 的 value 被**同一行的标题列**（夹具 `title: '总库报告 US'`，`tests/kw-report.mjs:310`）印出 | 改坏 → **0 failed**（修前）／**1 failed**（修后） | **已修**：读该行第 2 格（类型格） |
| **R3** | `tests/b13-precheck.mjs:949` `html.includes('通过')` | 页面把判词画出来了 | `src/web/page.js:4156` 的计数行 `N 通过 / M 降级 / …` 也印「通过」 | 改坏 → **0 failed**／**1 failed** | **已修**：读每行第 3 格（结果格） |
| **R4** | **原本没有断言** | 闸门面板每一行的「通过 / 未过」 | 无掩盖 —— 整块面板的渲染文字**无人读** | 改坏 → **0 failed**／**1 failed** | **已修**：新增 `b13d-page ⑯` |
| **R5** | **原本没有断言** | 闸门面板横幅「N/M 通过」 | 同上 | 改坏 → **0 failed**／**1 failed** | **已修**：同上 |
| **R6** | `tests/b13-precheck.mjs:949`（与 R3 同一条） | 计数行 `N 通过 / M 降级 / K 阻断` | `src/web/page.js:4091` 的 `PRECHECK_VERDICT_TEXT` 徽章也印「通过」 | 改坏 → **0 failed**／**2 failed** | **已修**：读计数格自己的文字 |
| **R7** | `tests/b04-collect-page.mjs:895` `html.includes('一键体检')` | 没有体检结果时画空状态且有入口 | `src/web/page.js:10223` 那句「点右上角「**一键体检**」跑一次十项检查」 | 改坏 → **0 failed**／**1 failed** | **已修**（本轮新发现）：按 id 读按钮自己的文字 |
| **R8** | `tests/b04-collect-page.mjs:1334` `envHtml.includes('查不了')` | 真实切片喂进去后代理行说「查不了」 | `src/web/page.js:10246` 图例行「第 9 项「代理」恒为**查不了**」 | 改坏 → **1 failed**（只有 B04P-⑦ 红，本条绿）／**2 failed** | **已修**（本轮新发现）：读代理那一行 |
| C1 | `tests/b05c-history.mjs:444` `out.text.includes('本仓没有来源')` | 工具把来源说明那句印出来 | `src/domain/asin/history.js:76` 常量 | 改坏 → **3 failed** | 承重，无需处理 |
| C2 | `tests/b04-collect-page.mjs:1684` `bare.includes('读不到设置行')` | 声明读不到时说清读不到 | `src/web/routes.js` | 未单独变异（`unverified`） | 见 §6 / 附录 B |
| C3 | `tests/b05-asin-table.mjs:686` / `:955` / `:1004` / `:1005` | 表下面说明哪几列没有来源 / 两态各说各的 | `src/domain/asin/table.js` | 未单独变异（`unverified`） | 见 §6 / 附录 B |
| C4 | `tests/b06-quadrants.mjs:390` / `:555` | 四象限把「没测」画出来 | `src/domain/keywords/competitor.js` | 未单独变异（`unverified`） | 见 §6 / 附录 B |
| C5 | `tests/b13b-inbox-evidence.mjs:512`、`b14-blocked-page.mjs:379`、`s1b14-quick.mjs:355`、`run.mjs:3818/5119/5122` | 各页面的状态词（已作废 / 采集失败 / 未接入 / 计算失败 / 质量驾驶舱 / 时效） | 各自域层词表 | 未单独变异（`unverified`） | 见 §6 / 附录 B |
| C6 | `tests/kw-master.mjs:1288-1290`、`probe-routes.mjs:210` | 总库工具的表头与计数 / 报告里的闸门段 | `src/tools/kw-*.js` | 未单独变异（`unverified`） | 见 §6 / 附录 B |

**候选 ≠ 假绿**，三条反证（都在 §6 里）：S1（`会生成文案`）、S4（`九项全过`）、
S5（`本仓没有来源`）都是候选表里的标签，改坏之后**都变红了**。

---

## 3. R2–R6 逐条证伪原文

命令模板（每次都在工作树根跑，`<ID>` 取 R1…R6）：

```powershell
git checkout -- amazon-ops/src
node .mutate-incaud2.mjs .mutate-incaud2-spec.json <ID>   # 施加变异
cd amazon-ops; node tests/run.mjs                          # 跑全量
cd ..; git checkout -- amazon-ops/src                      # 还原
```

### 3.0 修前：五条全部「改坏 → 仍绿」

| 变异 | 改了哪一行 | 全量结果 |
|---|---|---|
| R2 | `src/tools/report.js:33` `'kw-report': '总库报告'` → `'总库报表'` | `1793 passed, 0 failed` |
| R3 | `src/web/page.js:4091` `{ pass: '通过', … }` → `{ pass: '合格', … }` | `1793 passed, 0 failed` |
| R4 | `src/web/page.js:3831` `(gate.pass ? '通过' : '未过')` → `(gate.pass ? '合格' : '未过')` | `1793 passed, 0 failed` |
| R5 | `src/web/page.js:3819` `gates.passed + '/' + gates.total + ' 通过'` → `… + ' 合格'` | `1793 passed, 0 failed` |
| R6 | `src/web/page.js:4156` `(counts.pass \|\| 0) + ' 通过 / '` → `… + ' 合格 / '` | `1793 passed, 0 failed` |

原文（`.mutate-incaud2-logs-full/R*.txt` 的末尾两行）：

```
R1: 1792 passed, 1 failed     ← 对照：被抓到
R2: 1793 passed, 0 failed     ← 没抓到
R3: 1793 passed, 0 failed     ← 没抓到
R4: 1793 passed, 0 failed     ← 没抓到
R5: 1793 passed, 0 failed     ← 没抓到
R6: 1793 passed, 0 failed     ← 没抓到
```

### 3.1 R2 —— 「断言在，但读法不承重」（掩盖源是**数据**，不是说明文案）

它属于哪一类：**读法不承重**。但掩盖源和 R3–R6 不同 —— 不是说明行，而是**夹具的标题**：
`tests/kw-report.mjs:310` 写的是 `title: '总库报告 US'`，标题那一格把「总库报告」印出来了。

**改成什么**：按「文件位置」那一节把报告 id 认出来（认行**不靠被钉的那个词**），
再读**那一行自己的第 2 格**；并加反面（类型格不许等于同一行的标题格）+ 三个词表值一起钉。

**证伪原文**（改后）：

```
$ node .mutate-incaud2.mjs .mutate-incaud2-spec.json R2
applied R2: amazon-ops/src/tools/report.js
  -  'kw-report': '总库报告',
  +  'kw-report': '总库报表',
$ cd amazon-ops; node tests/run.mjs
1793 passed, 1 failed
  FAIL the report tool is one call wide: it names both kinds and their files
         the library report row names its own kind: expected "总库报告", got "总库报表"
```

### 3.2 R3 + R6 —— 两条都属「读法不承重」，而且**互相掩盖**

R3 与 R6 共用同一条断言 `tests/b13-precheck.mjs:949` `equal(html.includes('通过'), true, …)`：

- 改坏 R3（词表常量）→ 结果格变「合格」，但**计数行**还印「通过」→ 绿；
- 改坏 R6（计数行）→ 计数行变「合格」，但**结果格**还印「通过」→ 绿。

**改成什么**：
- R6：从 `#optprecheck` 的 HTML 里取出**计数格自己那一格**的文字，
  与 `N 通过 / M 降级 / K 阻断（共 T 项）` 逐字比较（数字取自载荷，词是页面的）；
- R3：按 `gate.label` 找到**那一行**，读**第 3 格（结果格）**自己的文字，
  与 `{ pass: '通过', degrade: '降级', block: '阻断' }` 对照；并加反面
  （判成 `degrade`/`block` 的那一格不许印「通过」），在**阻断夹具**上再读一遍。

**证伪原文**（改后）：

```
$ node .mutate-incaud2.mjs .mutate-incaud2-spec.json R3
applied R3: amazon-ops/src/web/page.js
  - const PRECHECK_VERDICT_TEXT = { pass: '通过', degrade: '降级', block: '阻断' };
  + const PRECHECK_VERDICT_TEXT = { pass: '合格', degrade: '降级', block: '阻断' };
$ cd amazon-ops; node tests/run.mjs
1793 passed, 1 failed
  FAIL b13-page ③ 页面渲染：九项、判词、实测/分母、判据都能单独读到
         object 那一行的结果格: expected "通过", got "合格"
```

```
$ node .mutate-incaud2.mjs .mutate-incaud2-spec.json R6
applied R6: amazon-ops/src/web/page.js
  - + '<span class="chip">' + (counts.pass || 0) + ' 通过 / ' + (counts.degrade || 0) + ' 降级 / '
  + + '<span class="chip">' + (counts.pass || 0) + ' 合格 / ' + (counts.degrade || 0) + ' 降级 / '
$ cd amazon-ops; node tests/run.mjs
1792 passed, 2 failed
  FAIL b13-page ③ 页面渲染：九项、判词、实测/分母、判据都能单独读到
         the count line spells its own words and numbers: expected "8 通过 / 1 降级 / 0 阻断（共 9 项）", got "8 合格 / 1 降级 / 0 阻断（共 9 项）"
  FAIL b13-page ③ 页面渲染补数指引：缺什么 + 去哪里补（含工具名）
         the count line follows the blocking fixture: expected "7 通过 / 1 降级 / 1 阻断（共 9 项）", got "7 合格 / 1 降级 / 1 阻断（共 9 项）"
```

### 3.3 R4 + R5 —— 「根本没有断言」（**不是**读法问题）

`renderGatesPanel`（`src/web/page.js:3815`）画出来的两处中文标签 —— 横幅的
`N/M 通过`（:3819）与每一行的 `通过 / 未过`（:3831）—— **原先一条读渲染的断言都没有**。
`tests/b13d-validation-delivery.mjs` 的 ⑭ 只从**源码文本**上钉住
`renderValidation(data)` 被调用、`#optrules/#optgates/#optreview/#optdelivery` 四个容器存在、
以及页面不自己数闸门（`page.includes('.filter(gate => gate.pass).length') === false`）——
它钉不到**面板印成了什么**。

所以这两条不能靠「改读法」修，必须**补一条真读渲染的断言**。

**补的时候钉什么**：`renderGatesPanel` 是页面脚本里的函数，**服务端渲染不含它**，
所以既不能钉常量（钉 `PRECHECK_VERDICT_TEXT` 那种常量等于什么都没钉），
也不能只读 `renderWorkbenchPage` 的静态 HTML。做法是：把**路由真产出的载荷**
喂给页面自己的 `renderValidation`，再读它画进 `#optgates` 的 HTML。
新增断言 `b13d-page ⑯` 读三样东西：

1. 横幅**自己那一格**：`expected "3/6 通过"`（数字来自载荷 `gates.passed/total`，词是页面的）；
2. 每一行**判词格自己那一格**：`gate.pass ? '通过' : '未过'`；
3. 反面：`pass === false` 的那一行不许印「通过」；横幅那个词与逐行判词那个词必须是同一个。

**证伪原文**（改后）：

```
$ node .mutate-incaud2.mjs .mutate-incaud2-spec.json R4
applied R4: amazon-ops/src/web/page.js
  - + '<span class="chip ' + (gate.pass ? 'ok' : 'warn') + '">' + (gate.pass ? '通过' : '未过') + '</span>'
  + + '<span class="chip ' + (gate.pass ? 'ok' : 'warn') + '">' + (gate.pass ? '合格' : '未过') + '</span>'
$ cd amazon-ops; node tests/run.mjs
1793 passed, 1 failed
  FAIL b13d-page ⑯ 闸门面板的横幅与逐行判词各自承重（改坏词表就要红）
         keyword_allocation_unique 那一行的判词格: expected "通过", got "合格"
```

```
$ node .mutate-incaud2.mjs .mutate-incaud2-spec.json R5
applied R5: amazon-ops/src/web/page.js
  - + '<span class="chip ' + (gates.ok ? 'ok' : 'warn') + '">' + gates.passed + '/' + gates.total + ' 通过</span>'
  + + '<span class="chip ' + (gates.ok ? 'ok' : 'warn') + '">' + gates.passed + '/' + gates.total + ' 合格</span>'
$ cd amazon-ops; node tests/run.mjs
1793 passed, 1 failed
  FAIL b13d-page ⑯ 闸门面板的横幅与逐行判词各自承重（改坏词表就要红）
         the banner spells its own word: expected "3/6 通过", got "3/6 合格"
```

### 3.4 R7 + R8 —— 复核过程中新抓到的两条（同机制）

在 §6 抽「承重样本」时，有两条候选**没有**按预期变红，于是又定位到两条真假绿：

**R7**：`tests/b04-collect-page.mjs:895` `html.includes('一键体检')`。
空状态里「一键体检」出现**两次**：右上角那个按钮，与下面那句
「点右上角「一键体检」跑一次十项检查」（`src/web/page.js:10223`）。
改按钮文案 → 全量仍然 `1794 passed, 0 failed`。
**改成**：按 `id="collectEnvRun"` 认按钮、读它自己印出来的那个词。

**R8**：`tests/b04-collect-page.mjs:1334` `envHtml.includes('查不了')`。
面板下方有一句图例「第 9 项「代理」恒为**查不了**……」（`src/web/page.js:10246`），
它把这三个字印进任何一次渲染。
**改成**：读代理那一行自己的文字（与同批 B04P-⑦ 同一个读法）。

**证伪原文**（改后）：

```
$ node .mutate-incaud2.mjs .mutate-incaud2-samples.json S3      # 一键体检 → 体检一次
applied S3: amazon-ops/src/web/page.js
$ cd amazon-ops; node tests/run.mjs
1793 passed, 1 failed
  FAIL B04P-⑧ 没有体检结果时画空状态，而不是一张空表
         the empty state offers the run button: expected "一键体检", got "体检一次"
```

```
$ node .mutate-incaud2.mjs .mutate-incaud2-samples.json S2      # unknown: 查不了 → 查不到
applied S2: amazon-ops/src/web/page.js
$ cd amazon-ops; node tests/run.mjs
1792 passed, 2 failed
  FAIL B04P-⑦ 第 9 项代理恒 unknown：明示「本版不走代理」，不许绿勾、不许 0/20
         代理那一行没有说「查不了」: <tr><td><span class="chip ">查不到</span></td><td><code>09-proxy</code> 代理</td>…
  FAIL B04P-⑱ 路由真的发出页面读的每一个字段：env 带 label、sites 带生效邮编、prefill 由入口决定
         真实切片喂给渲染器之后，代理那一行没有说「查不了」: <tr><td><span class="chip ">查不到</span></td><td><code>09-proxy</code> 代理</td>…
```

**修前**这同一次变异只让 **1 条**红（B04P-⑦）—— 第 2 条（B04P-⑱）当时是绿的，
这就是「同一个标签、同一次变异，读一行的红、读整份面板的不红」的实测对照。

---

## 4. R1 作为「承重」的对照

R1 是唯一一条**修前就被抓到**的变异，用它证明判据是「红不红」，不是「像不像图例」：

```
$ node .mutate-incaud2.mjs .mutate-incaud2-spec.json R1
applied R1: amazon-ops/src/domain/keywords/competitor.js
  -   ownAdvantage: '自有优势',
  +   ownAdvantage: '自家优势',
$ cd amazon-ops; node tests/run.mjs
1792 passed, 1 failed
  FAIL ⑨ amzn_competitor_quadrants 注册、只读、端到端给出四象限与证据
```

修前 `1792 passed, 1 failed`、修后仍然 `1793 passed, 1 failed` ——
**修 R2–R6 没有把 R1 的承重弄丢**，也没有把它变成另一条断言的红。

---

## 5. 另抽的 5 条「承重」断言（改坏 → 变红）

抽样口径：跨层次（页面渲染 / 工具输出 / 域常量）、跨文件、且**不是**本次修的那几条。
每条都在全量里跑。

| # | 断言 | 改坏了什么 | 结果 |
|---|---|---|---|
| S1 | `tests/b13-precheck.mjs:977` `html.includes('会生成文案')` | `src/web/page.js` 模式徽章 `'会生成文案'` → `'会生成副本'` | **1 failed** |
| S2 | `tests/b04-collect-page.mjs:869` `row.includes('查不了')` | `src/web/page.js:164` `unknown: ['查不了','']` → `['查不到','']` | **2 failed**（本条 + R8 那条） |
| S3 | `tests/b04-collect-page.mjs:895` `html.includes('一键体检')` | `src/web/page.js:10219` 按钮文字 → `'体检一次'` | **1 failed**（修 R7 之后） |
| S4 | `tests/b13-precheck.mjs:1006` `html.includes('九项全过') === false`（**否定型**） | 往空态文案里**塞进**「九项全过。」 | **1 failed** |
| S5 | `tests/b05c-history.mjs:444` `out.text.includes('本仓没有来源')` | `src/domain/asin/history.js:76` 常量 → `本仓无来源` | **3 failed** |

原文（`.mutate-incaud2-logs-final/S*.txt`）：

```
S1: 1793 passed, 1 failed
  FAIL b13-page ③ 页面渲染四种模式的选择，专项带八个范围
         it says which modes generate: expected true, got false

S3: 1793 passed, 1 failed
  FAIL B04P-⑧ 没有体检结果时画空状态，而不是一张空表
         the empty state offers the run button: expected "一键体检", got "体检一次"

S4: 1793 passed, 1 failed
  FAIL b13-page ③ 空态说清为什么空：没选 ASIN 与 专项缺范围 是两种空
         it must not read as "all passed": expected false, got true

S5: 1791 passed, 3 failed
  FAIL 同源 / 换源两种说法不同，且都带上「来源类型没有来源」那句原话
         那句话没有说「本仓没有来源」
  FAIL 工具：有变化时印出类别与归因；0 份快照时印「没采过」而不是空表
         工具没把「来源类型没有来源」那句印出来
  FAIL 页面用域层产出的载荷画差异表，且不出现「没有变化」
         页面没印「来源类型没有来源」那句
```

S4 特别值得记：它是**否定型**断言（`=== false`），承重方向与前面几条相反 ——
它不是「改坏了就红」，而是「**多加**了被禁止的词就红」。否定型断言同样能承重，
前提是它读的接收者足够窄（这里读的是空态那一段的 HTML）。

---

## 6. 未验证到的部分，为什么可以放过

先把「放过的」和「没放过的」分清楚 —— **我不把「看着没问题」当理由**。

### 6.1 明确不放过、也明确标 `unverified` 的

静态口径给出 **122 条候选 / 80 个标签**。本次逐条变异的只有：

- R2、R3、R4、R5、R6、R7、R8（7 条，全部变红 → 已修）；
- S1、S2、S3、S4、S5（覆盖 5 个标签，全部变红 → 已证明承重）。

其余候选（附录 B 里那 **19 条**读整份渲染的）**没有逐条变异**，一律标 **`unverified`**，
不声称它们安全。（26 条读整份渲染的候选里，本次变异覆盖了 7 条：`优化报告`(R2)、
`通过`(R3/R6)、`查不了`(R8)、`本仓没有来源`×4(S5)；26 − 7 = 19。）

### 6.2 可以放过的部分，以及可复核的理由

**(a) 96 条读「窄切片」的候选：结构上不可能被说明文案满足。**

理由不是「看着像」，而是接收者本身把说明文案排除在外：读的是**某一行**
（`row`、`proxyRow`、`lastRow.inner`）、**某一格**（`liveChip.textContent`）、
**表内**（`table`，而说明文字按 `tests/b04-collect-page.mjs:878` 的注释就在表外）、
或**某个数组元素**（`history.notes[0]`）。这类断言里，说明文案根本不在被搜索的那个字符串里。

这条理由**可复核**，而且本次有实测对照：R8 修前，同一个标签 `查不了`、同一次变异，
`row.includes('查不了')`（B04P-⑦）变红，`envHtml.includes('查不了')`（B04P-⑱）不变红。
把 `envHtml` 换成 `row`，它就红了（R8 修后 S2 的两次红）。

**(b) 剩下 19 条读整份渲染的候选：不在本次收口范围，且已经有断言。**

- 收口范围是「**已被变异测试证明为假绿**」的条目（R2–R8）。这 19 条没有证据表明是假绿，
  也没有证据表明不是；按证据纪律，它们既不算缺陷也不算通过。
- 它们的风险等级低于 R4/R5：R4/R5 是「**根本没有断言**」（功能完全没人管），
  这 19 条是「**有断言，但可能不承重**」—— 后者不会让一个坏掉的词表悄悄上线，
  只会让它在词表被改坏时不被发现。
- 继续复核的成本已经降到最低：口径（§1.2 的伪代码）、变异施加器（`from`/`to` 规格文件）、
  子集运行器（`node .run-subset.mjs <模块名>`）都在本次跑通过；下一轮机械重跑即可。

**(c) 静态口径本身有一个已知盲区，而且本次被证实了。**

「词表型」的定义是「长度 ≤ 6 且单独成串」，所以**嵌在 HTML 模板里的标签**
（`'<button id="collectEnvRun" …>一键体检</button>'`）**不算词表型**，
R7 因此**不在**候选表里 —— 它是靠变异才抓到的。
同理 R8 之所以在候选表里，是因为 `unknown: ['查不了', '']` 恰好是个短字面量。

所以：**候选表是「某类假绿的筛子」，不是「全部假绿的清单」**。
任何「候选表已经覆盖全部风险」的说法都不成立 —— 这也是本次坚持用变异做判据的原因。

### 6.3 一句话

放过的部分只有两类：**（a）结构上不可能是假绿的 96 条**（理由可复核，且有实测对照），
**（b）不在收口范围、已标 `unverified` 的 19 条**（不声称安全，给出重跑口径）。
除此之外，本次修掉的 7 条都有「改坏 → 红」的原文。

---

## 7. 证据

### 7.1 全量结果

```
修前（main 5a7b296，测试未改）：      1793 passed, 0 failed
修后（本工作树，测试已改）：          1794 passed, 0 failed

$ cd amazon-ops; node tests/run.mjs
…
1794 passed, 0 failed

(plugin root: D:\deepseek-harness-h\workspace\wt-dsh-incaud2\amazon-ops)
```

断言数 **1794 ≥ 1793**：本轮**新增**一条用例（`b13d-page ⑯`，用来补 R4/R5 那两处
「根本没有断言」的缺口）；其余 5 处改动是把「读法不承重」的断言**改强**
（读那一格 / 那一行自己的文字）并**加反面**：

| 文件 | 位置 | 对应 |
|---|---|---|
| `tests/kw-report.mjs` | 报告清单那条用例内 | R2 |
| `tests/b13-precheck.mjs` | `b13-page ③ 页面渲染：九项…` | R3 + R6 |
| `tests/b13-precheck.mjs` | `b13-page ③ 页面渲染补数指引…` | R6 的阻断夹具反面 |
| `tests/b04-collect-page.mjs` | `B04P-⑧ 没有体检结果时画空状态…` | R7 |
| `tests/b04-collect-page.mjs` | `B04P-⑱ 路由真的发出页面读的每一个字段…` | R8 |

没有删用例、没有放宽判据。

### 7.2 `src/**` 与 main 逐字节相同

```
$ git status --porcelain -- amazon-ops/src
（空）

$ git diff --stat main -- amazon-ops/src
（空）
```

改动只在 `tests/**` 与 `docs/qa/**`：

```
 M amazon-ops/tests/b04-collect-page.mjs
 M amazon-ops/tests/b13-precheck.mjs
 M amazon-ops/tests/b13d-validation-delivery.mjs
 M amazon-ops/tests/kw-report.mjs
```

### 7.3 变异测试的施加与还原

每条变异的流程都是：`git checkout -- amazon-ops/src` → 施加 → 跑全量 → `git checkout -- amazon-ops/src`，
每轮结束后打印 `src dirty after revert: 0`。
变异规格是 JSON（`from` / `to` 是**文件内容**，不经过命令行 —— 本会话在命令行里传中文失败过多次），
施加器会先检查 `from` 片段在目标文件里**恰好出现一次**，不是一次就拒绝施加（不静默改错地方）。

一次性脚本按纪律已删除，规格原文抄在下面（`node .mutate-incaud2.mjs <specFile> <id>` 的输入）：

**R1–R6（`.mutate-incaud2-spec.json`）**

```json
[
 { "id": "R1", "file": "amazon-ops/src/domain/keywords/competitor.js",
   "from": "  ownAdvantage: '自有优势',", "to": "  ownAdvantage: '自家优势'," },
 { "id": "R2", "file": "amazon-ops/src/tools/report.js",
   "from": "  'kw-report': '总库报告',", "to": "  'kw-report': '总库报表'," },
 { "id": "R3", "file": "amazon-ops/src/web/page.js",
   "from": "const PRECHECK_VERDICT_TEXT = { pass: '通过', degrade: '降级', block: '阻断' };",
   "to":   "const PRECHECK_VERDICT_TEXT = { pass: '合格', degrade: '降级', block: '阻断' };" },
 { "id": "R4", "file": "amazon-ops/src/web/page.js",
   "from": "+ '<span class=\"chip ' + (gate.pass ? 'ok' : 'warn') + '\">' + (gate.pass ? '通过' : '未过') + '</span>'",
   "to":   "+ '<span class=\"chip ' + (gate.pass ? 'ok' : 'warn') + '\">' + (gate.pass ? '合格' : '未过') + '</span>'" },
 { "id": "R5", "file": "amazon-ops/src/web/page.js",
   "from": "+ '<span class=\"chip ' + (gates.ok ? 'ok' : 'warn') + '\">' + gates.passed + '/' + gates.total + ' 通过</span>'",
   "to":   "+ '<span class=\"chip ' + (gates.ok ? 'ok' : 'warn') + '\">' + gates.passed + '/' + gates.total + ' 合格</span>'" },
 { "id": "R6", "file": "amazon-ops/src/web/page.js",
   "from": "+ '<span class=\"chip\">' + (counts.pass || 0) + ' 通过 / ' + (counts.degrade || 0) + ' 降级 / '",
   "to":   "+ '<span class=\"chip\">' + (counts.pass || 0) + ' 合格 / ' + (counts.degrade || 0) + ' 降级 / '" }
]
```

**S1–S5（`.mutate-incaud2-samples.json`）**

```json
[
 { "id": "S1", "file": "amazon-ops/src/web/page.js",
   "from": "(current.generates ? '会生成文案' : '只检查不生成')",
   "to":   "(current.generates ? '会生成副本' : '只检查不生成')" },
 { "id": "S2", "file": "amazon-ops/src/web/page.js",
   "from": "  unknown: ['查不了', ''],", "to": "  unknown: ['查不到', '']," },
 { "id": "S3", "file": "amazon-ops/src/web/page.js",
   "from": "style=\"margin-left:auto\">一键体检</button>",
   "to":   "style=\"margin-left:auto\">体检一次</button>" },
 { "id": "S4", "file": "amazon-ops/src/web/page.js",
   "from": "why = '还没有选中 ASIN。在 ASIN 库里选一个产品，这里就显示它的九项门槛；'",
   "to":   "why = '九项全过。还没有选中 ASIN。在 ASIN 库里选一个产品，这里就显示它的九项门槛；'" },
 { "id": "S5", "file": "amazon-ops/src/domain/asin/history.js",
   "from": "  '来源类型（collect/import/manual/derived）的变化本仓没有来源：asin_field_source 按 '",
   "to":   "  '来源类型（collect/import/manual/derived）的变化本仓无来源：asin_field_source 按 '" }
]
```

### 7.4 一次性产物

`.scan-*` / `.mutate-*` / `.probe-*` / `.run-subset.mjs` / `.mutate-incaud2-logs-*/`
都在交回前删除（见 §7.5）。本文件保留了可重跑的口径与命令。

### 7.5 复核命令（下一轮直接照跑）

一次性脚本已删，下面是重建它们所需的全部信息 —— 每个都只有十几行：

**① 施加器**：读 JSON 规格 → 找 `<ID>` 那一条 → 检查 `from` 在目标文件里**恰好出现 1 次**
（不是 1 次就报错退出，不静默改错地方）→ `writeFileSync(file, text.split(from).join(to), 'utf8')`。

**② 子集运行器**：`import(pathToFileURL('amazon-ops/tests/<模块>.mjs'))`，取出 `run*Tests` 导出，
用 `run.mjs` 里那六个 harness 函数（`check / checkAsync / equal / deepEqual / throws / section`，
定义在 `tests/run.mjs:404-481`）的**同样语义**调用它。
注意：`kw-report.mjs` 需要 `run.mjs` 额外注入的 `settingsSlice` / `routeStore` / `postApi`，
子集运行器跑它会因缺注入而**假红** —— 它只适合 `b04-*` / `b05c-*` / `b13-*` / `b13d-*` 这类自包含模块。

```powershell
cd D:\deepseek-harness-h\workspace\wt-dsh-incaud2
# 1) 全量（唯一的判据来源）
cd amazon-ops; node tests/run.mjs; cd ..
# 2) 施加一条变异（<ID> = R1..R6 / S1..S5），规格见 §7.3
node .mutate-incaud2.mjs .mutate-incaud2-spec.json <ID>
# 3) 还原 —— 交回前 src/** 必须与 main 逐字节相同
git checkout -- amazon-ops/src
git diff --stat main -- amazon-ops/src      # 必须为空
```

---

## 附录 A —— 静态口径命中的 80 个标签（122 条候选）

由 `.scan-incaud2-cand2.json` 直接生成（括号里是命中该标签的候选断言条数）。

**命中 > 1 条的标签（25 个）**

`已归档`(8) · `本仓没有来源`(5) · `没有变化`(4) · `未读到`(4) · `读不出来`(3) ·
`数值`(3) · `锁定`(3) · `未就绪`(3) · `变体`(2) · `草案未采纳`(2) · `查不了`(2) ·
`风险数`(2) · `关键词总库`(2) · `默认关闭`(2) · `取代关系`(2) · `通过`(2) ·
`未设置`(2) · `未知/未测`(2) · `文本`(2) · `无法判断`(2) · `已作废`(2) · `闸门`(2) ·
`站点`(2) · `自有`(2) · `阻断`(2)

**命中 1 条的标签（55 个）**

`本次放行` · `变体事件` · `采集失败` · `层级` · `产品线` · `成本超限` · `冲突` ·
`冲突工作台` · `待裁决` · `待人工选择` · `店铺名` · `读不到设置行` · `改过` · `观测周期` ·
`集合` · `计算失败` · `继续这次运行` · `警告` · `可采集` · `库内` · `来源` · `理由` ·
`没有` · `目标用户` · `品牌名` · `清空` · `全部` · `全局审计` · `上下文` · `时效` ·
`视频` · `完成` · `未变` · `未测` · `未分配` · `未接入` · `未判定` · `未知模块` ·
`页面` · `已过期` · `已回滚` · `已排除` · `已偏离` · `已完成` · `已写入` · `优化报告` ·
`有值` · `运行` · `暂无数据` · `这一类没有` · `只能人判` · `质量驾驶舱` · `质量摘要` ·
`主人` · `状态`

（逐条的 `文件:行` 明细原本落在一次性文件 `.scan-incaud2-cand2.json` 里 —— 该文件按纪律已删除；
口径见 §1.2，重跑即可复现同一批 80 个标签 / 122 条断言。）

## 附录 B —— 读「整份渲染」的 26 条候选（只有这些才可能被说明文案满足）

（行号是**修前**的行号，即 main `5a7b296` 的测试文件。）

| 标签 | 断言 | 接收者 | 本次是否变异 |
|---|---|---|---|
| `优化报告` | `kw-report.mjs:429` | `output` | ✅ R2 |
| `通过` | `b13-precheck.mjs:949` | `html` | ✅ R3 / R6 |
| `查不了` | `b04-collect-page.mjs:1334` | `envHtml` | ✅ R8 |
| `本仓没有来源` | `b05c-history.mjs:444` | `out.text` | ✅ S5 |
| `本仓没有来源` | `b05c-history.mjs:544` | `html` | ✅ S5（同一次变异红 3 条） |
| `本仓没有来源` | `b05-asin-table.mjs:686` | `html` | ✅ S5（同一次变异红 3 条） |
| `本仓没有来源` | `b05-asin-table.mjs:955` | `markdown` | ✅ S5（同一次变异红 3 条） |
| `读不到设置行` | `b04-collect-page.mjs:1684` | `bare` | ❌ `unverified` |
| `自有` | `b05-asin-table.mjs:1004` | `text` | ❌ `unverified` |
| `已完成` | `b05-asin-table.mjs:1005` | `text` | ❌ `unverified` |
| `没有变化` | `b05c-history.mjs:542` | `html` | ❌ `unverified` |
| `未知/未测` | `b06-quadrants.mjs:390` | `html` | ❌ `unverified` |
| `未测` | `b06-quadrants.mjs:555` | `text` | ❌ `unverified` |
| `已作废` | `b13b-inbox-evidence.mjs:512` | `html` | ❌ `unverified` |
| `只能人判` | `b13d-validation-delivery.mjs:870` | `md` | ❌ `unverified` |
| `草案未采纳` | `b13d-validation-delivery.mjs:904` | `md` | ❌ `unverified` |
| `草案未采纳` | `b13d-validation-delivery.mjs:905` | `html` | ❌ `unverified` |
| `采集失败` | `b14-blocked-page.mjs:379` | `text` | ❌ `unverified` |
| `未接入` | `s1b14-quick.mjs:355` | `html` | ❌ `unverified` |
| `计算失败` | `run.mjs:3818` | `html` | ❌ `unverified` |
| `质量驾驶舱` | `run.mjs:5119` | `html` | ❌ `unverified` |
| `时效` | `run.mjs:5122` | `html` | ❌ `unverified` |
| `关键词总库` | `kw-master.mjs:1288` | `text` | ❌ `unverified` |
| `库内` | `kw-master.mjs:1289` | `text` | ❌ `unverified` |
| `层级` | `kw-master.mjs:1290` | `text` | ❌ `unverified` |
| `闸门` | `probe-routes.mjs:210` | `html` | ❌ `unverified` |

合计 **26** 条：本次变异覆盖 **7** 条，剩 **19** 条标 `unverified`。

> `probe-routes.mjs` 是探针脚本、不在 `run.mjs` 的用例集里，所以它那一条不产生红灯，
> 也不计入 1794 —— 单列出来是为了不把它混进「已验证」。
