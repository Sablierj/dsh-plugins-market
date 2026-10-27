# T73j — 「没取到」画成「0」的收尾批（dev-10）

- 日期：2026-10-25 · 写者：dev-10（研发席） · 基线树：**P 2499/0**（commit `d7c4037`）
- 台账依据：`team/qa/fallback-zero-backlog-2026-10-25.md` —— **T-2**（§三）+ **「其余（低优先）」** 的
  5 号（`optimize/report.js` 埋词完成率）与 13 号（`keywords/pipeline.js` `rowsRead`）
- 写域：`src/domain/reports/spend-monthly.js` · `src/domain/optimize/report.js` ·
  `src/domain/keywords/pipeline.js` · 新建 `tests/t73j-fallback-batch.mjs`
  —— **`tests/run.mjs` 一个字节没碰**（接线原文见 §五.3，按章程由 lead 统一接）
- 五段式：一 结论 / 二 缺陷形状 / 三 改动 / 四 测试 / 五 未做·要 lead 拍

---

## 〇、先把两件不体面的事写在前面

### 0.1 一次自己造成的事故与恢复（必须留痕）

改 `report.js` 的第 4 个 patch 时我用了一次 **pwsh 的文本往返**
（`Get-Content -Raw` → `String.Replace` → `Set-Content -Encoding utf8`）想一次替换 4 处页脚。
这条路径在这台机器上把整份文件读成了非 UTF-8、写回时**双重编码**，`report.js` 当场变成
`push(` 后面跟着「> 瑙勫垯闆嗭細…」这样的乱码（且丢了一个反引号，属**不可逆**变换）。

恢复办法（没用 `git checkout --`，章程禁）：
`cmd /c "git show HEAD:amazon-ops/src/domain/optimize/report.js > %TEMP%\report.orig.js"` 拿到
HEAD 的原始字节（115,747 B / 1953 行，`read` 工具复核中文完好）→ `cmd /c copy /y` 覆回 →
**用 `edit` 工具把改动一条一条重放（12 次 edit）**。

教训（也是给后面的人）：**文本替换只走 `edit`/`write` 工具**，不走 shell 的编解码往返；
需要「整文件还原」时用 `git show` + `cmd` 重定向（字节级），不要经 PowerShell 的文本管道。

当前磁盘上的文件是重放之后的版本，`node tests/t73j-fallback-batch.mjs` 全绿，
`tests/f14-10-report-export.mjs` / `f14-02` / `b13d` 定向回归也全绿（§4.4），可判定乱码没有残留。

### 0.2 `git status` 的现状（交接用）

lead 在 `e719864`（树 P 2505/0）已经把本次**大部分**改动提交进去了
（`spend-monthly.js` / `pipeline.js` / `report.js` / `t73j` 都在那个 commit 里）。
之后我又做了两处小改（`report.js` 的 `excelFillRate` 提到 `conclusions` 之前算一次、
`t73j` 文件头措辞），所以现在 `git status` 里这两份仍为 `M` —— **请与下一棵树一起提交**。

---

## 一、结论

**改了 7 处代码（3 个文件）+ 1 个新测试文件；定向 11 checks / 83 断言全绿；先红后绿有据。**

| # | 位置 | 病 | 改法 | 来源 |
|---|---|---|---|---|
| 1 | `spend-monthly.js` `undated` 分支 | 无日期行的 `spend` 是聚合值（缺数据=0），当读数交出去 | `spend: null` + `spendMissing: true/false` | **台账 T-2** |
| 2 | `optimize/report.js` 自检「埋词完成率」 | 完成率缺失 → `ok:false` → 印 ❌（未测被读成不达标） | 第三态 `unverified:true`，`result` 印「—」 | **台账 5 号** |
| 3 | `keywords/pipeline.js` `rowsRead` | `?? 0` → 读不出行数时记「读了 0 行」 | `rowsReadOf()` → `null`（领域层往返都是 null） | **台账 13 号** |
| 4 | `optimize/report.js` 自检「事实一致」 | `conflicts?.length ?? 0` + `=== 0` → 没台账时印「0 处冲突 ✅」 | 同 2 的第三态 | **我自己判断的（同形兄弟）** |
| 5 | `optimize/report.js` `fillRate` 另三处读者 | 只修自检表 → 结论一节（MD/HTML）、Excel 结论表印 `NaN%` | 统一走 `planFillRate()`，缺失说「未记录」 | **我自己判断的（同源）** |
| 6 | `optimize/report.js` 「埋词位置 N 个」×5 | 没有计划时印「0 个」 | 统一走 `planPositionText()`，缺失说「未记录」 | **我自己判断的（同形）** |
| 7 | `spend-monthly.js` 坏输入 | `[null]` 会被算成「1 条数据缺 period」 | 非对象元素跳过；`emptyReason` 用「真数据行数」 | **我自己判断的（⑧ 坏输入）** |

**没用全量对账**（按指令只跑定向）：本单的数字一律只对 `t73j` 与 7 个直接依赖套件的定向结果，
**不报树号**，也不与 2499/2505 相减。全量数字请以 lead 重跑的那棵树为准。

---

## 二、缺陷形状

### 2.1 T-2 — `undated` 分支（台账 §三）

修前（`spend-monthly.js`，无日期行）：

```js
undated.push({ keyword, marketplace, period, spend: entry.spend, reason: '…读不出月份' })
```

`entry.spend` 是**聚合用**的值：`numericOrNull` 判空之后 `=== null ? 0 : …`，为的是让「多份文件
覆盖取最大值」有一个可比较的数。把它当展示值，`/api/state → spendMonthly.undated[i].spend` 就会说
「这条读不出月份，而且花了 0 元」—— 后半句是编的。**月桶早就带 `missing{}` 计数了，`undated` 漏了。**

修后：

```js
const spendReading = numericOrNull(row?.spend)
const spendMissing = spendReading === null || Number(row?.spend_missing) === 1
undated.push({ …, spend: spendMissing ? null : spendReading, spendMissing, reason: '…' + (spendMissing ? '；这一行也没有花费读数（spend 缺失，不是 0）' : '') })
```

**两个判据都看**，与月桶 `missing.spend` 完全一致：
`=== null` 兜住合成输入与 v67 之前的老形态；`spend_missing === 1` 兜住 v67 之后「源单元格为空、
列存默认 0」——那一行在库里**长得和「真的花了 0 元」一模一样**，只能靠标记分开（T-3 的口径）。

**形状选择：`spendMissing: boolean`，不用 `missing: {}`。**
理由：本文件里 `missing` 已经专指「月桶上逐字段的**行数**」（`bucket.missing.spend = 3`）。
同一个键在行上变成单行布尔标记，下游会把 `bucket.missing.spend`（计数）与 `row.missing.spend`
（标记）读成同一种东西 —— **同名不同义比没名字更容易误导**。取一个不同的名字，"这是几条"与
"这一条缺不缺"就永远不会被混淆。

**消费方核实（改形状的前提）**：

| 消费方 | 读的是什么 | 结论 |
|---|---|---|
| `src/web/pages/report.js:274-277` | `data.undated.length` | 只读长度 → 形状变化不上屏 |
| `src/web/routes.js:3992` | `spendMonthly: spendReport(...)` 原样下发 | 多一个布尔、少一个假 0；无解构、无白名单 |
| `tests/spend-report.mjs` ④ | `report.undated[0].spend === 99`（有真值那行） | 保持 99，绿 |

### 2.2 台账 5 号 — 埋词完成率（`optimize/report.js`）

```js
{ item: '埋词完成率', …, result: model.plan?.coverageMatrix ? `${Math.round(fillRate * 100)}%` : '—',
  ok: (model.plan?.coverageMatrix?.summary?.fillRate ?? 0) >= 0.6 }
```

两层病：

1. **`?? 0` → `ok:false`**：读不到完成率时状态印 ❌。「未测」被读成「不达标」——与
   `validate.js` 三道闸门（T73d 修的）**同一个病**，所以用**同一个字段名**：
   `{ ok:false, unverified:true, result:'—' }`。
2. **`result` 那半边不判空**：`model.plan?.coverageMatrix` 在、`summary.fillRate` 不在（老快照）时，
   `Math.round(undefined * 100)` → **`NaN%`**，既不是 0 也不是「未测」。测试 ④c 专门钉这一条。

三态渲染只有一处判定（`checkState`），三种渲染各自翻译成自己的记号：
Markdown/HTML → 「—」（HTML 用现成的 `.pill`，不新增 CSS），Excel → 「未测」。
自检表下面补一句图例：`状态「—」= 这一项没有执行（不是通过，也不是不达标）`。

### 2.3 台账 13 号 — `rowsRead`

`rowsRead: parsed.stats?.rowsRead ?? 0`，`recordImport` 收下之后写 `kw_import.rows_read`。
「解析器没报行数」于是被记成「读了 0 行」，而 0 行读起来是「这份文件是空的」
（空文件那条路径在 `importDirectory` 里另有明确拒绝：`文件是空的（0 字节）`）。
改成 `rowsReadOf(stats)` → 数或 `null`，**导入入参与返回值两处同一个入口**。

⚠️ **本项只修到领域层为止**，存储层过不去（`rows_read INTEGER NOT NULL DEFAULT 0` +
`recordImport` 落库前 `Number(...)`）——残余见 §五.1，我没有越界去改 `store/`。

### 2.4 第二处同形兜底：核的结果（台账第 4 项要求）

**核过：同形/同源 4 组、共 10 个落点，全部改了；另 5 处形状相近，逐条判为不是同形。**

| 位置 | 形状 | 判 |
|---|---|---|
| `report.js` 自检「事实一致」 | `plan?.factLedger?.conflicts?.length ?? 0` + `=== 0` | **同形，改了**（§三.2 第 5 条） |
| `report.js` 结论一节 ×2（MD/HTML） | `Math.round(summary.fillRate * 100)` | **同源，改了**（同一个值读四遍，只修一处另外三处印 `NaN%`） |
| `report.js` `buildExportHeader` ③范围 | `Array.isArray(model.plan?.positions) ? … : 0` | **同形，改了**（测试 ⑧ 抓到的第 5 处，我最初漏了） |
| `report.js` 页眉/页脚 ×4 | `model.plan?.positions?.length ?? 0` | **同形，改了**（收成 `planPositionText`） |
| `report.js` `counts = validation?.counts ? … : { block:0, warn:0 }` | 不是同形 | **没改**，见 §五.5（它答的是另一个问题，且 `?? 0` 之外还有第二来源） |
| `report.js` `${Math.round((deviation.ratio ?? 0) * 100)}%` ×2 | 不是同形 | **没改**：同一句话里已经把分子分母都印出来了（`改动 N/M 个字段`），读者可当场复算 |
| `spend-monthly.js` `(filesByKey.get(key)?.size ?? 0) > 1` | 不是同形 | **没改**：Map 是同一个函数前 20 行自己建的，0 走不到；且只用于 `> 1` 比较，不上屏 |
| `spend-monthly.js` `totals.missingRows` 的 `(entry.missing?.x ?? 0)` ×4 | 不是同形 | **没改**：`entry` 是本函数现构造的对象，四个键一定在；这里 `?? 0` 只可能掩盖构造 bug，不会把外部读数说成 0 |
| `pipeline.js` `countMasterRows` 的 `?.n ?? 0` | 不是同形 | **没改**：`COUNT(*)` 有表必返回一行，走不到；真走得到说明库坏了，那时 0 与任何数同样错 |

---

## 三、改动（逐处）

### 3.1 `src/domain/reports/spend-monthly.js`（4 处）

1. **文件头**：加一节「`undated` 分支同口径（T-2）」——写清为什么 `entry.spend` 不能当读数、
   为什么标记叫 `spendMissing` 而不是 `missing{}`、消费方核实结论。
2. **`undated` 分支**：`numericOrNull` + `spendMissing` + `reason` 追加缺失说明（见 §2.1）。
3. **循环头**：非对象元素（`null` / 数字 / 字符串）跳过，并维护 `considered`（真数据行数）。
   理由：`[null]` 会被算成「1 条广告数据读不出月份」，那是**给坏输入编一个发现**。
4. **`emptyReason`**：`considered === 0` 时单独一句话（「传进来 N 个元素，没有一个是数据行 ——
   这不是『还没有导入』，是调用方给错了输入」），与「导入了但归不了月」**分开说**。

### 3.2 `src/domain/optimize/report.js`（9 处 + 4 个新助手）

新助手（都在 `selfCheck` 附近，模块级）：

```js
function readingOrNull(value)          // 一个读数：有数就是数，没数就是 null
function planFillRate(model)           // fillRate 的唯一读取入口（4 个读者共用）
function planPositionCount(model)      // 埋词位置数，没有计划 → null
const planPositionText = (model) => …  // 「N 个」/「未记录」，5 处页眉页脚共用
function checkState(check)             // 三态判定只在这一处
const checkMark / checkLabel           // 三态 → 记号 / 说法
```

1. `buildExportHeader` ③范围：`埋词位置 ${planPositionText(model)}`（去掉 `: 0` 兜底）。
2. Markdown 页眉 `> 规则集：…｜埋词位置：…`：同上。
3. Markdown 结论一节「完成率」：`planFillRate` + 缺失印「未记录」。
4. Markdown 自检表：`checkMark(check)` + 表下加一句图例。
5. `selfCheck`：`事实一致` / `埋词完成率` 两行改三态（`ok:false, unverified:true, result:'—'`）。
6. HTML 结论一节「完成率」：同 3（两句渲染不许对同一格说两句话）。
7. HTML 自检表：三态 + `<blockquote>` 图例。
8. HTML 页眉 `<p class="meta">`：`planPositionText`。
9. Excel：结论表「埋词完成率」缺失印「读不到（…不是 0%）」；自检总表用 `checkLabel`（「未测」）。
10. 两处页脚（MD `_生成时间…_` / HTML `<hr><p class="meta">`）：`planPositionText`。

### 3.3 `src/domain/keywords/pipeline.js`（3 处）

1. `recordImport({ rowsRead: rowsReadOf(parsed.stats) })`。
2. 返回值新增 `rowsRead: rowsReadOf(parsed.stats)`（工具/页面要印「未记录」时读这一格，不必反解 `stats`）。
3. 新增导出 `rowsReadOf(stats)` + 一段说明为什么不是「空就兜 0」，**并写明它现在还过不了存储层**
   （免得下一个人以为已经修完了）。

### 3.4 为什么没抽一个跨文件共用函数

三处的判据一样（`null` = 没取到），但**语义不同**：一个是「这一行有没有花费读数」，
一个是「这一轮有没有跑这项检查」，一个是「解析器报了几行」。抽成 `nullOrZero()` 那种东西，
下一个调用方会以为「缺失即 null」是这个仓的**通用**约定 —— 而 `kw_ad_fact.spend` 恰恰是
「列装不下 null、只能另立标记」（T-3）的反例。各文件留自己的一行判空 + 一句为什么，比一个
看起来通用的工具更不容易被误用。

---

## 四、测试

### 4.1 `tests/t73j-fallback-batch.mjs`（新建，11 checks / **83 断言**）

导出 `runT73jFallbackBatchTests({ check, equal })`；带 `process.argv[1]` 直接 `node` 跑的守卫
（自带 `makeHarness`），所以**不进套件也能单独跑**。

| # | 断言的内容 | 断言数 |
|---|---|---|
| ① | `undated` 无花费读数 → `spend === null` 且 `spendMissing === true`（**不是 0**） | 3 |
| ①b | 老行形态（`spend:0` + `spend_missing:1`）→ 仍判缺失、`spend` 为 null（列默认值不回读成读数） | 2 |
| ② | 反面：有真值的 `undated` 行照抄（99 / 真 0 / 12.5），且归月的行不受影响 | 7 |
| ③ | 反面：完成率 0.75 → 结果 `75%`、状态 ✅（不许把这一行修成一律未测） | 2 |
| ④ | 完成率缺失 → 结果 `—`、状态 `—`；源码里是 `ok:false + unverified:true`；**反面** 0.3 → `30%` / ❌ | 5 |
| ④b | 同形兄弟：没有台账 → `—`/`—` + 源码三态；反面：0 冲突 → `0` / ✅ | 5 |
| ④c | `fillRate` 是坏值（`'nope'`）→ 走未测，且整份 Markdown 里**没有 `NaN`** | 3 |
| ⑤ | `rowsRead` 四种「读不到」（undefined / `{}` / null / `'N/A'` / `''`）都是 `null` | 6 |
| ⑥ | `rowsRead` 有值是数字（12 / `'12'` / **真 0 保持 0**）+ **真链路** `importFile` 返回值与库内一致 | 7 |
| ⑦ | 源码级守门：三文件里对应 `?? 0` 一个不剩 + 正向标记（`planFillRate(` / `spendMissing` / `rowsReadOf(` …）都在 | 11 |
| ⑧ | 坏输入 fail-closed：8 种坏 `rows` 不崩不编数、垃圾 spend → 缺失、无 plan 的模型三行都说未测且不印 `NaN`、页脚不再说「0 个」 | 32 |

### 4.2 先红后绿（实测输出，修前跑红）

修之前 `node tests/t73j-fallback-batch.mjs`：

```
  FAIL T73j-① …缺失被写成了读数（0 是一句「这条花了 0 元」）: expected null, got 0
  FAIL T73j-①b …带缺失标记的行没被认出来: expected true, got undefined
  FAIL T73j-② …有值却标了缺失: expected false, got undefined
  ok   T73j-③ 完成率高 → 自检「埋词完成率」照常 ✅（反面…）      ← 反面断言本该绿
  FAIL T73j-④ …读不到完成率却编了一个数: expected "—", got "NaN%"
  FAIL T73j-④b …没有事实台账却印了「0 处冲突」: expected "—", got "0"
  FAIL T73j-④c …坏值被算成了 NaN 并印到报告里: expected false, got true
  FAIL T73j-⑤ …pipeline 没有导出 rowsReadOf: expected "function", got "undefined"
  FAIL T73j-⑥ rowsReadOf is not a function
  FAIL T73j-⑦ …undated 又把聚合值当读数交出去了: expected false, got true
  FAIL T73j-⑧ …坏输入 [null] 编出了 undated 行: expected 0, got 1

T73j: 11 checks, 10 failed
```

**10/11 红，唯一的绿是 ③（反面）** —— 这正是要的形状：先红说明断言真的抓到了缺陷，
反面一开始就绿说明它不是靠「一律判红」蒙对的。

> ⑤⑥ 用的是 `import * as pipelineModule`，不是具名 import：`rowsReadOf` 是本次新加的导出，
> 具名 import 一个不存在的名字会在**模块链接期**就抛，整套断言一条都跑不到 —— 那样的「红」
> 只证明文件语法变了，证明不了缺陷。这条选择写在测试文件头。

修之后：

```
T73j: 11 checks, 0 failed      （checks=11  assertions=83  failed=0）
```

### 4.3 源码级守门（⑦）的口径

三个文件里，对应的 **`?? 0` 一个都不许再出现**（外加正向标记必须在，防止「把整行删掉」也算绿）：

```
spend-monthly.js:  spend: entry.spend 不许有 / numericOrNull(row?.spend) 必须在 / spend: spendMissing ? null 必须在
report.js:         fillRate ?? 0 · conflicts?.length ?? 0 · positions?.length ?? 0 都不许有
                   planFillRate( · planPositionText( 必须在
pipeline.js:       rowsRead ?? 0 不许有 / export function rowsReadOf( 必须在
```

**口径：守门读源码原文，不剥注释。** 所以被扫的那三个文件里，注释不把旧写法原样抄一遍
（写成「以前缺失时按 0 参与比较」）。不剥注释是刻意的，两个理由：

1. 本仓现成的 `wired-source.mjs::stripComments` 在 `report.js` 上**会卡住**：`esc()` 里
   `.replace(/"/g, '&quot;')` 的正则字面量含一个双引号字符，状态机会把它当成字符串开头，
   之后整份文件的注释都不再被剥（实测：剥完仍留着旧写法）。**这是 `wired-source` 自己的
   已知边界被触发的一次实例**——它把注释当代码数引用，理论上能把孤儿导出数成「已接线」。
   本单一并报给 lead（§五.6），但没有越界去改那份文件。
2. **注释原样抄一遍旧代码，守门就会自己失效** —— 谁在注释里写清历史，谁就把绿灯关掉了。
   与其让守门逼着人不许解释历史，不如把口径写死。

### 4.4 定向回归（不是全量）

驱动方式：一个临时脚本（工作区外）按 `run.mjs` 的同名 harness 形状
（`check / checkAsync / equal / deepEqual / throws(fn, what)` / `section`）逐个 `await` 各套件的
`runXxxTests`。**跑的是各套件自己的断言，没有抄写、没有裁剪。**

| 套件 | 为什么和本单有关 | checks / 断言 | 结果 |
|---|---|---|---|
| `tests/t73j-fallback-batch.mjs` | 本单 | 11 / 83 | 0 挂 |
| `tests/spend-report.mjs` | `spendReport` 的 8 条口径（含 undated 那条） | 8 / 25 | 0 挂 |
| `tests/t73e-missing-is-not-zero.mjs` | 月报 `missing` 计数 | 6 / 16 | 0 挂 |
| `tests/t73h-adfact-missing.mjs` | T-3 端到端（库 → 月报） | 5 / 19 | 0 挂 |
| `tests/kw-pipeline.mjs` | `importFile` / 目录导入 / orchestration | 20 / 131 | 0 挂 |
| `tests/f14-02-report-standard.mjs` | 报告模型与两种渲染 | 19 / 99 | 0 挂 |
| `tests/b13d-validation-delivery.mjs` | 报告 ↔ 交付边界 | 24 / 301 | 0 挂 |
| `tests/f14-10-report-export.mjs` | 三种渲染 + Excel 写盘 | 25 / — | **⑧a / ⑧b 两条挂**，原因见下 |
| `tests/wired-source.mjs` | 架构守门：新导出 `rowsReadOf` 必须真接线 | 8 / — | 0 挂（不算孤儿） |

合计 **118 checks：116 passed / 2 failed**，两条都在 `f14-10` ⑧a/⑧b：它们要 `run.mjs` 提供的
`loadPageScript` / `renderedPage` 页面夹具（`if (renderedPage === null || loadPageScript === null) throw`），
我的定向驱动没有这两样，报错是 `loadPageScript is not a function` —— **夹具缺失，不是回归**；
这两条测的是 `pages/report.js` 的导出按钮与本单改的三个文件无关。

**全量没跑**（按指令）。`tests/run.mjs` 的接线原文见 §五.3，接上之后全量应比基线 **+11 checks / +83 断言**。

---

## 五、未做 / 要 lead 拍

### 五.1 【必须跟一手】`rows_read` 装不下「没记到」—— 13 号只修到领域层

`kw_import.rows_read` 是 `INTEGER NOT NULL DEFAULT 0`（`src/store/schema.js:868`），且
`recordImport` 落库前把「没有值」也转成 0（`src/store/kw.js:128` 的 `Number(record.rowsRead ?? 0)`）。
所以我在 `pipeline.js` 给的 `null`，到库里仍是 0，页面（`routes.js:4954`）与工具
（`tools/kw.js:317` 的「行」那一列）还是显示 0。

两条路，都要动 `src/store/**`（**不在我的写域**），请 lead 派单：

- **A（推荐，T-3 同法）**：加 `rows_read_missing INTEGER NOT NULL DEFAULT 0`（迁移 v68，纯 ALTER），
  导入时「解析器没报行数」置 1；显示侧 `rows_read_missing = 1` 时印「未记录」。端到端成立，
  代价是一条迁移 + 两处显示。
- **B（不改表）**：只能让显示侧去 `stats_json` 里找 `rowsRead` 在不在 —— 把一个字段的真相
  拆到两个列里，下一个人一定会读错。**我不推荐。**

在 A 落地之前，**这一格仍然是 0**，请不要把 13 号记成「端到端已修」。

### 五.2 【必须跟一手，而且比 T-2 更严重】T-3 的缺失标记在生产读路径上根本读不到

做 T-2 核消费方时发现：`/api/state` 的月度花费只用了这一条 SQL（`src/web/routes.js:3993-3997`）：

```sql
SELECT keyword, marketplace, period, source_file, clicks, orders, spend, sales,
       first_date, last_date
  FROM kw_ad_fact
```

**没有 `spend_missing` / `sales_missing`。** 于是 `spendReport` 里
`Number(row?.spend_missing) === 1` 恒为假（`undefined` → NaN），而 `numericOrNull(spend)` 在
`NOT NULL` 列上恒为数字 —— **月桶的 `missing.spend` 与「该月 N 行没有花费数据」那句 ROAS 理由，
在页面上永远不会响**。T-3 的写入端、`t73h` 的端到端断言都对（它用 `SELECT *`），
断在**读路径的列清单**上。

patch（一行，`src/web/**` 不在我的写域）：

```diff
-        `SELECT keyword, marketplace, period, source_file, clicks, orders, spend, sales,
-                first_date, last_date
+        `SELECT keyword, marketplace, period, source_file, clicks, orders, spend, sales,
+                spend_missing, sales_missing, first_date, last_date
            FROM kw_ad_fact`,
```

建议随 §五.1 一起做，并补一条「走 `/api/state` 真切片」的断言（现在 `t73h` 是函数级 + `SELECT *`，
所以它绿、线上不生效）。**这一条我认为是本轮最值得跟的一手。**

### 五.3 【要 lead 做】`tests/run.mjs` 接线（4 行，我没权限）

import（放在 `t73l` 那一条之后，第 555 行附近）：

```js
/* T73j —— 「没取到」画成「0」的收尾批：T-2 undated 花费 / 完成率第三态 / rowsRead 缺失。 */
import { runT73jFallbackBatchTests } from './t73j-fallback-batch.mjs'
```

await（放在 `runT73lRepairRefusalTests` 那条之后，第 11550 行附近）：

```js
/* T73j —— T-2 + 台账 5/13 + 同形兄弟：没取到 ≠ 0（11 checks / 83 断言）。 */
await runT73jFallbackBatchTests({ check, equal })
```

harness 只要 `{ check, equal }`（与 `t73h`/`t73i` 同形）。

### 五.4 【要拍板】`plan.js:781` 的 `fillRate: totalPlanned === 0 ? 1`

`buildCoverageMatrix` 在「一个落点都没计划」时返回 **1（100%）**。于是「这一轮没计划埋词」
在自检表里读作「完成率 100% ✅」—— 0/0 被填成了一个满分。

- 本单**没改**：`plan.js` 不在写域；且这是**已评审的契约**（`tests/run.mjs` 里对
  `coverageMatrix.summary` 有字面断言），改它属口径变更，不是缺陷修复。
- 我做的只是**不再把「读不到」混进去**（缺键 → 未测）；「有计划但零落点」仍然显示 100%。
  要么改成 `null` + 未测，要么在图上注明「无计划落点」，请拍。

### 五.5 【报告瑕疵】自检「无阻断项」那一行的 0 是**重算**来的

`buildReportModel`：`counts = validation?.counts ? {...} : { block:0, warn:0 }`，没有 `validation`
时再拿每条草案里已存的 `violations_json` 重算。所以「无阻断项 0 ✅」里的 0 **不是** `?? 0` 兜底，
它答的是「已存的草案里有没有阻断」。但它**不等于**「校验跑过且干净」——
`validate.js` 的合规闸门在同样输入下会诚实地报 `unverified`。

要改它得给模型加一个 `validationRan` 之类的字段（跨函数契约），本单没做，也没有把它算进
「同形兜底」——形状不同、来源不同，混在一起改会把这条真正的问题改糊。列为下一单候选。

### 五.6 【仓库基础设施】`stripComments` 在含引号的正则字面量上会失步

`tests/wired-source.mjs::stripComments` 的状态机只认四种状态（代码 / 行注释 / 块注释 / 字符串），
不认识**正则字面量**。`report.js` 的 `esc()` 里有 `.replace(/"/g, '&quot;')` → 被当成字符串开头，
此后整份文件的注释不再被剥。

- 对 `wired-source` 的影响：`sourceText` 是剥注释后的文本；注释里的 `foo(` 会被算成一次引用，
  **理论上能把一个孤儿导出数成「已接线」**。当前 8 条断言全绿（没有实际翻转），但这是
  一把悬着的刀。
- 对我这一单的影响：所以 ⑦ 改成读原文、注释不许写出旧字面（§4.3）。
- 建议：给 `stripComments` 加正则字面量状态（或用 `node --experimental-strip-types` 之外的办法
  不要手写词法），并把「含引号的正则」作为一条回归样例加进它的健全性断言里。
  文件不在我的写域。

### 五.7 六条铁律对照

| 铁律 | 本单怎么落的 |
|---|---|
| **四态口径**（没取到 ≠ 没有） | `undated.spend`：`null` + `spendMissing`；自检行：`unverified:true` + 「—」；`rowsRead`：`null`。「读到了，答案是 0」仍然分别是 `0` / ✅❌ / `0` —— 三条都配了反面断言（②③④b⑥） |
| **数字带分母来源时间** | 自检行仍印 `75%`（分子分母在结论一节：`实际落在 3 处 / 计划 4 处`）；`missingRows`/`missing{}` 是行数不是比例；Excel 结论表保留「出处」列（`plan.coverageMatrix.summary.fillRate`） |
| **禁黑盒总分** | 没有新增任何总分；自检总表逐项列，三态不做加权；`unverified` 明确不进通过率 |
| **未执行不许写成通过** | 本单的主轴。`ok:false` + `unverified:true` 保证未判定**永远**不进 ✅；反过来真读数（0.3 / 0）不许被洗成「未测」（④ 的反面、④b 的反面） |
| **树标识** | 全文数字只标「定向」，**不报树号、不与 2499/2505 相减**；基线树写在标题行（`d7c4037` = P 2499/0），全量以 lead 那棵树为准 |
| **机器写路径不覆盖人工决定** | 本单三处都不写库、不碰 `listing` / 草案 / 发布登记：`spendReport` 是纯读、`selfCheck` 是纯渲染、`importFile` 的 `rowsRead` 只写进「这一份文件读了行数」那一格。**没有**任何机器值覆盖人工修正的路径 |
