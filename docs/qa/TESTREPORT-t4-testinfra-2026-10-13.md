# T-4 测试基础设施两条「静默」缺陷：修复 + 证伪报告

- **日期**：2026-10-13
- **作者角色**：QA（测试工程师）
- **状态**：已通过（自测）；**未提交**（按任务要求 `不要 git commit`）
- **关联需求编号**：T-4（上游输入：T-3 的 `docs/qa/INCLUDES-AUDIT-round2-2026-10-13.md` §1.2 / §6 / §7）
- **证据等级**：除标注 `documented`（引用 T-3 的记录、本次未复测）者外，**全部 `verified`（本文所有输出均为本次实测原文）**
- **工作树**：`D:\deepseek-harness-h\workspace\wt-testinfra`（分支 `testinfra`，基线提交 `689cef1`）
- **写作用域**：`amazon-ops/tests/**`、`amazon-ops/docs/qa/**`。⚠️ `src/**` 本次零改动（见 §6）

---

## 0. 结论

| 缺陷 | 定级 | 修法 | 证伪（回退 → 变红 → 改回 → 绿） |
|---|---|---|---|
| **QF-1** 17 处 `checkAsync` 悬空（6 个模块） | P2（测试仪器失真；当前全量无实际损失，属**靠运气**） | 17 处补 `await`（纯机械）+ 静态守卫 `tests/t4-test-infra.mjs`（3 条断言）+ `run.mjs` 收尾**排空**（安全网） | 去掉任意一处 `await` → 守卫 ② 变红，且是**全仓唯一一条红**（`1812 passed, 1 failed`，exit 1） |
| **QF-2** `probe-routes.mjs` 把非字符串返回 `String()` 成 `[object Object]`，拒因被吞 | P2（探针把真实原因指向错误位置；`probe` 不在 `run.mjs` 用例集里，没人会发现） | 新增 `textOf()`，9 个取值点统一走它 | 让工具返回对象 → 报出**可读原文**（539 字，含 `STRATEGY_UNCONFIRMED` 与门禁状态）；改前同一场景只印 `[object Object]` |

- **断言数只增不减**：`1810 → 1813`（+3 = 守卫三条），没有一条断言被改松、被删、被改名。
- **`src/**` 零改动**：`git diff --stat 689cef1 -- amazon-ops/src` 为空。

---

## 1. 范围与非范围

**做**

1. 修 17 处悬空 `checkAsync`；加一条**能抓住复发**的守卫；加一条**收尾排空**的安全网。
2. 修 `probe-routes.mjs` 的非字符串 `String()` 吞拒因；加同一条守卫。
3. 两类缺陷各至少一次**真证伪**（回退 → 变红 → 改回 → 绿），贴原文。

**不做**

- 不改任何断言判据（只改**读法/时序**）；不加迁移；不动 schema；不 commit。
- 不动 `tests/wired-source.mjs`（另一并行批次正在改它的 `UNWIRED` 表）、`src/domain/asin/**`、
  `src/store/queries.js`、`src/store/keyword-ownership.js`、`src/domain/collect/**`、`src/web/page.js`。
- 不跑真机采集。`tests/wired-source.mjs` 本次**零改动**。

---

## 2. 环境与基线

```powershell
$ cd D:\deepseek-harness-h\workspace\wt-testinfra\amazon-ops
$ node scripts/check-migrations.mjs
{"count":45,"SCHEMA_VERSION":45,"dups":[],"continuous":true,"last":"agent-run-task-type","first":"initial-schema"}
迁移表自洽 ✓                                        # exit 0

$ node tests/run.mjs
1810 passed, 0 failed                               # 基线，exit 0
(plugin root: D:\deepseek-harness-h\workspace\wt-testinfra\amazon-ops)
```

- Node `v24.18.0`，Windows。
- ⚠️ **基线提交是 `689cef1`**。本次会话期间 `main` 分支被别的批次推进到了 `ad17a60`
  （`docs(amazon-ops): T-7 阻塞页「等」的台账段落…`）。因此 `git diff main -- …` 会掺进**别人的改动**
  （实测：拿 `main` 比会多出 `docs/COORDINATION.md` 的 51 行删除，那不是我的改动）。
  **一切差值以 `689cef1` 为基准**，这也是 T-3 §9.3 记下的同一条坑。

---

## 3. 缺陷 QF-1：17 处 `checkAsync` 悬空

### 3.1 现场（本次独立复现，与 T-3 §7.1 逐字对上）

一次性扫描器（已删）对 `tests/*.mjs` 逐文件扫描「调用了 `checkAsync` 却没有 `await`」：

```
b04-collect-page.mjs  悬空 1
    1012: checkAsync('B04P-⑭ 13 节详情的渲染：五态徽章 + 未采集 + 解析值 + 差异文案', ...
b05c-health.mjs  悬空 4
    444 / 471 / 487 / 514
b05c-history.mjs  悬空 5
    143 / 418 / 466 / 479 / 596
b05c-import.mjs  悬空 4
    243 / 369 / 406 / 445
b11-8-version-compare.mjs  悬空 1
    379
b12-8-blocked-recovery.mjs  悬空 2
    251 / 368

悬空 checkAsync 合计：17，分布在 6 个模块
```

`b05c-history` / `b05c-health` / `b05c-import` 三个模块的 `checkAsync` **全部**悬空。

**为什么这是缺陷**（T-3 §1.2 / §7.2，`documented`）：`checkAsync` 的函数体在第一个 `await`
之前同步跑、之后挂起；模块 runner 立刻返回。于是

1. **归错模块**：失败信息挂在「当时正在 await 的那个模块」旁边；
2. **尾部风险**：悬空断言若落在**最后几个模块**，进程可能先打印汇总再退出 ——
   **汇总说绿、那条断言一次都没跑**。T-3 自己就在子集运行器上因此得出了
   「U04 改坏仍绿」的**错误结论**（`b05c-history` 单跑：排空前 18 条、排空后 22 条）。

**当前全量为什么没损失（本次独立复核，`verified`）**：全量 `1810`（补 `await` 前）与 `1813`
（补 `await` 后）之差**恰好是 3 条新守卫** ⇒ 那 17 处补 `await` **没有改变总数**，即它们在
补 `await` 之前就已经全部被计入全量。这独立支持了 T-3「全量不受影响、但靠后续模块顺带排空」
的判断 —— **是运气，不是设计**。

### 3.2 修法 A：17 处补 `await`（纯机械，逐处）

改动形态**只有一种**：`  checkAsync(` → `  await checkAsync(`。行号不变（原地加 6 个字符）。

| # | 文件 | 行（改前 = 改后） |
|---|---|---|
| 1 | `tests/b05c-history.mjs` | 143 |
| 2 | `tests/b05c-history.mjs` | 418 |
| 3 | `tests/b05c-history.mjs` | 466 |
| 4 | `tests/b05c-history.mjs` | 479 |
| 5 | `tests/b05c-history.mjs` | 596 |
| 6 | `tests/b05c-health.mjs` | 444 |
| 7 | `tests/b05c-health.mjs` | 471 |
| 8 | `tests/b05c-health.mjs` | 487 |
| 9 | `tests/b05c-health.mjs` | 514 |
| 10 | `tests/b05c-import.mjs` | 243 |
| 11 | `tests/b05c-import.mjs` | 369 |
| 12 | `tests/b05c-import.mjs` | 406 |
| 13 | `tests/b05c-import.mjs` | 445 |
| 14 | `tests/b12-8-blocked-recovery.mjs` | 251 |
| 15 | `tests/b12-8-blocked-recovery.mjs` | 368 |
| 16 | `tests/b04-collect-page.mjs` | 1012 |
| 17 | `tests/b11-8-version-compare.mjs` | 379 |

可复现地数一遍：

```powershell
$ git diff 689cef1 -- amazon-ops/tests |
    Select-String -Pattern "^[+-]\s*(await )?checkAsync\("
# 17 条 "-  checkAsync(" 与 17 条 "+  await checkAsync("，一一对应，没有第三种改动
```

改后复扫：`悬空 checkAsync 合计：0，分布在 0 个模块`。

### 3.3 修法 B（守卫）：`tests/t4-test-infra.mjs`，三条断言

新增 Own file，`run.mjs` 末尾调用 `await runT4TestInfraTests({…})`。三条断言**各挡一件事**：

| # | 断言 | 它挡的是 |
|---|---|---|
| ① | 扫描器在**合成源码**上正好抓出那 1 条悬空调用（定义处 / `await` 过 / 注释里的名字都不许误报） | ② 变成**永真断言**（假绿） |
| ② | 全仓 `tests/*.mjs`（**含 `run.mjs`，只放过它自己的定义处**）零悬空调用；命中时**逐条点名 `文件:行 + 调用原文`** | **复发**：任何一处少写 `await` |
| ③ | `run.mjs` 里 `await drainInflightChecks()` 必须存在，且在**汇总之前**、**teardown 之前** | 有人把安全网（§3.4）摘掉/挪位 |

设计要点（都是踩过的坑）：

- 扫描器**不靠正则一把梭**：先找 `checkAsync(` 的每个位置，再回头看**紧邻的前面是不是 `await`**；
  `async function checkAsync(` 的定义处跳过。规则故意死板（`Promise.all([...])` 那一类写法会被误报）——
  本仓一处都没有，穷举比宽松更值，注释里写清了放宽时该做什么。
- 扫描**包含 `run.mjs` 自己**：它里面也有 `checkAsync` 调用点（以及定义处），
  只把 `run.mjs` 排除在外就等于留一个没人看的角落。
- 守卫文件自身也在扫描范围内，所以**本文件里不写带括号的那个名字**（拼字符串绕开），
  否则守卫会被自己抓住 —— 这条约束写在文件头。
- ① 是 ② 的证伪：没有 ①，② 「通过」可能只是因为扫描器什么都没扫到。② 另有一条
  `files.length < 60` 就报错的防呆（实际扫到 **75** 个模块）。

### 3.4 修法 C（安全网）：`run.mjs` 收尾排空

静态守卫挡不住所有形状（有人可能绕过它、或在 `run.mjs` 之外的运行器里跑模块）。所以
`run.mjs` 结构性补上一道：`checkAsync` 一被调用（同步段）就把自己的 promise 登记进
`inflightChecks`，落定后注销；**打印汇总之前、teardown 之前** `await drainInflightChecks()`。
返回值 `> 0`（5 秒内没落定）**算一条失败**——「还在跑」不是「没红」。

放在 `teardown` **之前**是必须的：悬空的断言可能还要读那个库、读临时目录。

> 分工：**② 是绊线（复发就报警，且点名到行），C 是安全网（漏过绊线也不许漏进汇总）。**
> 判一条断言红不红，仍然只看那条断言自己。

### 3.5 证伪 A：去掉一处 `await` → 必须变红（要求项）

把 `b05c-history.mjs:143` 的 `await` 去掉（只去掉这一个字符组），跑**全量**：

```
  ok   ① 扫描器在合成源码上正好抓出那一条悬空调用（② 不是永真的）
  FAIL ② 全仓没有悬空调用：tests/*.mjs 每一处都 await 过（含 run.mjs，定义处除外）
         1 处调用没有 await（悬空 = 没人等它，差一个 await 就会漏进汇总）:
      b05c-history.mjs:143  checkAsync('2 份有变化：empty:false、note:null，四种说法两两不同', async () => {
  ok   ③ run.mjs 在汇总之前排空在途断言，且在 teardown 之前

1812 passed, 1 failed

failures:
  ② 全仓没有悬空调用：tests/*.mjs 每一处都 await 过（含 run.mjs，定义处除外）
    Error: 1 处调用没有 await（悬空 = 没人等它，差一个 await 就会漏进汇总）:
      b05c-history.mjs:143  checkAsync('2 份有变化：empty:false、note:null，四种说法两两不同', async () => {
    at file:///D:/deepseek-harness-h/workspace/wt-testinfra/amazon-ops/tests/t4-test-infra.mjs:87:13
=== EXIT 1 ===
```

**读法**：`1812 passed, 1 failed` —— **全仓唯一一条红就是守卫本身**。
也就是说：没有这条守卫，去掉一个 `await` 在全量里**看不出来**（断言照样被后续模块顺带跑完、
照样计入），而这正是 T-3 §1.2 那个假结论的土壤。

改回后（`await` 补回），树与「已验绿」状态**逐字节相同**（§5 指纹），最终全量
`1813 passed, 0 failed`（exit 0）。

### 3.6 证伪 B：安全网真的挡得住「悬空落在最后」（要求项）

静态守卫挡不住「形状绕过」，所以必须单独证明 C 这一半。做法：在**最后一个模块**
`t2-lowlevel-cooldown.mjs` 末尾故意放一条**不 await**、会失败的断言，并**临时关掉静态守卫**
（隔离 C 这一半），跑两次全量：

```
B1（收尾排空 ON）：
  (tail-probe marker: 这条断言真的跑了)
  FAIL T-4 尾部探针：故意悬空 + 落在最后一个模块
1810 passed, 1 failed
=== EXIT 1 ===

B2（同一份夹具，只把 drainInflightChecks() 关掉）：
1810 passed, 0 failed
=== EXIT 0 ===        ← 「汇总说绿、那条断言一次都没跑」
```

- B1 里 marker 出现 **1** 次、`1 failed`、exit **1**：悬空断言**落在了最后**，仍然被跑、被计入。
- B2 里 marker 出现 **0** 次、`0 failed`、exit **0**：**同一个夹具，那条断言等于不存在。**
  这就是任务书说的「进程先打印汇总再退出」的现场复现 —— 排空是**承重**的。
- 两次跑用的是**同一份夹具**，唯一差别是 `drainInflightChecks()` 这一行，所以差值只能归给它。

### 3.7 扫描器覆盖 `run.mjs` 的内存级证伪（补充，`verified`）

全量跑一次要 ~3 分钟，所以在内存里对**真实的 `run.mjs` 文本**再证一次（只读磁盘，不写文件）：

```
run.mjs 现状：悬空 0 条；定义处被跳过 = true
run.mjs 在扫描清单里： true
扫描清单模块数： 75
① 往 run.mjs 插一条悬空调用 → [{"file":"run.mjs","line":11205,"text":"checkAsync('内存里的探针：故意不 await', async () => {})"}]
② b05c-history.mjs 现状：悬空 0 条
② 去掉那一处 await → [{"file":"b05c-history.mjs","line":143,"text":"checkAsync('2 份有变化：empty:false、note:null，四种说法两两不同', async () => {"}]
③ 合成源码 → [{"file":"synthetic","line":1,"text":"checkAsync('悬空', async () => {})"}]
```

③ 的输入有四种写法（悬空 / `await` 过 / 定义处 / 注释里提到），只抓出**悬空那一条** ——
证明 ② 不是永真断言，也证明它不会误伤定义处与注释。

---

## 4. 缺陷 QF-2：`probe-routes.mjs` 把非字符串返回 `String()` 成 `[object Object]`

### 4.1 改前（拒因被吞，错误指向完全错的地方）

T-3 已修好夹具（补 `optimize-strategy-confirm` 一步），但**断言与读法一字未动**，
`validate` / `save` 仍然被 `String()` 之后打印。把夹具那一步临时摘掉（这**正是**
T-3 §6.2 记录的现场：工具用对象拒绝），跑：

```powershell
$ node tests/probe-routes.mjs US
asin_upsert -> 写入完成: 新增 1，更新 0，失败 0
keyword_import -> 导入完成: 关键词 7 条，排名记录 0 条，失败 0 条（来源 manual）
optimize_prepare -> run 6e551165-…
optimize_validate -> [object Object]          ← 拒因没了
optimize_save -> [object Object]              ← 拒因没了
row in db: status=running report_md=null report_html=null
GET /report/6e551165 -> 404 (662 chars)
未核验声明: 不适用（该站点有核验来源）
Error: the report has no gate section heading + table
    at tests/probe-routes.mjs:253:33
=== EXIT 1 ===
```

链条与 T-3 §6.2 完全一致：工具在 **184 行**被 `STRATEGY_UNCONFIRMED` 拒 →
没有草案落库 → `save` 再被拒 → 这一轮永远 `status=running` → 报告路由 **404** →
最后在**第 253 行**报「报告里没有闸门一节」。**错误信息指向 253 行，真正的原因在 184 行。**

### 4.2 改后（拒因当场、可读、带原文）

同一条守卫 `textOf(result, what)`（新增函数）：

```js
function textOf(result, what) {
  if (typeof result !== 'string') {
    const kind = result === null ? 'null' : typeof result
    throw new Error(`${what} 返回的不是字符串（是 ${kind}），原文：${JSON.stringify(result) ?? String(result)}`)
  }
  return result
}
```

**同一份「工具返回对象」的场景**（经 `cmd` 原始字节重定向，避免 PowerShell 的 119 字宽折行）：

```
Error: amzn_optimize_validate 返回的不是字符串（是 object），原文：{"ok":false,"code":"STRATEGY_UNCONFIRMED","gate":{"open":false,"state":"unconfirmed","code":"STRATEGY_UNCONFIRMED","reason":"这一轮的九项策略卡还没有人工确认。先策略后文案：确认之后草案才能进入这一轮。去工作台「优化 → 策略阶段」看九项，或调 amzn_optimize_strategy 读一遍。"},"runId":"85aa7f75-255f-4972-af11-de55958016a9","error":"第 85aa7f75 轮的策略还没有人工确认 —— 这一轮的九项策略卡还没有人工确认。先策略后文案：确认之后草案才能进入这一轮。去工作台「优化 → 策略阶段」看九项，或调 amzn_optimize_strategy 读一遍。","hint":"先策略后文案：把九项策略卡（amzn_optimize_strategy）给用户看，让他在工作台「优化 → 策略阶段」确认之后再提交。只做检查不落库（去掉 persist）不会被拦。"}
    at textOf (file:///D:/…/tests/probe-routes.mjs:111:11)
    at file:///D:/…/tests/probe-routes.mjs:184:37
=== EXIT 1 ===
```

一眼能看到：**是哪一步**（`amzn_optimize_validate`）、**返回了什么类型**（object）、
**拒因码**（`STRATEGY_UNCONFIRMED`）、**门禁状态**（`gate.open:false / unconfirmed`）、
**人话原因**、**下一步动作**（去哪儿确认），以及**出错行就是 184 行**。

### 4.3 改动清单（10 个位置 / 11 处调用，全部走同一条规矩）

| 位置 | 改前 | 改后 |
|---|---|---|
| `amzn_asin_upsert` 打印 | `typeof x === 'string' ? … : JSON.stringify(x).slice(0,120)`（**只印不报**） | `textOf(x, …)` |
| `amzn_keyword_import` 打印 | 同上（**只印不报**） | `textOf(x, …)` |
| `amzn_optimize_prepare` | `if (typeof x !== 'string') throw` + 正则取 `runId` | `textOf(x, …)` + **`runId` 取不到时明确抛错**（新增守卫：以前带着 `null` 往下走，原因会被埋掉） |
| `optimize-strategy-confirm` 的状态与正文 | `String(confirmed.text)` | `textOf(confirmed.text, …)` |
| **`amzn_optimize_validate`** | **`String(validate)`**（吞拒因） | **`textOf(validate, …)`** |
| **`amzn_optimize_save`** | **`String(save)`**（吞拒因） | **`textOf(save, …)`** |
| `GET /state` → `JSON.parse` | `JSON.parse(stateResponse.text)`（对象会被隐式转成 `[object Object]` 再报一个 `Unexpected token o`） | `JSON.parse(textOf(…))` |
| 报告路由正文 | `reportResponse.text` 直接用 | `textOf(…)`（非字符串不该当成 HTML 去 `includes`） |
| `GET /state`（第二次） | `JSON.parse(….text)` | `JSON.parse(textOf(…))` |
| `amzn_publication_record` | `if (typeof x !== 'string') throw`（本来就用对） | 统一成 `textOf(x, …)`，**一条规矩**而不是两种写法 |

**没有改任何断言的判据**：报告路由那段（8.1 节 + 表头格 `闸门`）读法一字未动。

### 4.4 改回：`probe ok`

```powershell
$ node tests/probe-routes.mjs US
…
  rollbackTasks=0 anchor=null

probe ok
=== EXIT 0 ===
```

---

## 5. 证据清单（命令 + 返回码 + 末尾行）

| # | 命令 | 结果 | 日志（一次性，已删） |
|---|---|---|---|
| 1 | `node tests/run.mjs`（改动前基线） | `1810 passed, 0 failed`，exit 0 | `.qa-baseline.log` |
| 2 | `node scripts/check-migrations.mjs` | `dups:[]`、`迁移表自洽 ✓`，exit 0 | — |
| 3 | `node tests/run.mjs`（全部改完） | `1813 passed, 0 failed`，exit 0 | `run-final.log` |
| 4 | 证伪 A：去掉 `b05c-history:143` 的 `await` | `1812 passed, 1 failed`，exit 1，**唯一红是守卫 ②** | `run-falsifyA.log` |
| 5 | 证伪 B1：尾部悬空 + 排空 ON | `1810 passed, 1 failed`，exit 1，marker×1 | `run-falsifyB1.log` |
| 6 | 证伪 B2：尾部悬空 + 排空 OFF | `1810 passed, 0 failed`，exit 0，marker×0 | `run-falsifyB2.log` |
| 7 | 全部还原后 `node tests/run.mjs` | `1813 passed, 0 failed`，exit 0 | `run-restored-final.log` |
| 8 | 探针 改前 / 改后 / 还原 | exit 1（吞） / exit 1（可读） / `probe ok` exit 0 | `probe-before-fix.log`、`probe-after-fix.raw.log`、`probe-restored-final.log` |
| 9 | 内存级扫描器证伪 | 见 §3.7 | `unit-probe.log` |

**还原指纹**（证明「改回」是真还原，不是碰巧）：

```
state-final.patch          sha256 = BB21D6BD5B44860DF4B3AD4BC1A475054522373DABC78E8F47C2FC1DC54A0082
state-after-A.patch        sha256 = BB21D6BD5B44860DF4B3AD4BC1A475054522373DABC78E8F47C2FC1DC54A0082   ← 证伪 A 还原后
state-after-B.patch        sha256 = BB21D6BD5B44860DF4B3AD4BC1A475054522373DABC78E8F47C2FC1DC54A0082   ← 证伪 B 还原后
state-after-probe2.patch   sha256 = BB21D6BD5B44860DF4B3AD4BC1A475054522373DABC78E8F47C2FC1DC54A0082   ← 探针二次还原后
```

其中 `state-final.patch = git diff 689cef1 -- amazon-ops/tests`，即第 3 行那次 `1813/0` 的
**同一棵树**。另：`probe-routes.mjs` 还单独做过字节级比对
（`B196419BC70ECA98…` 与参考副本一致）。

### `git status`（交付时）

```
 M amazon-ops/tests/b04-collect-page.mjs
 M amazon-ops/tests/b05c-health.mjs
 M amazon-ops/tests/b05c-history.mjs
 M amazon-ops/tests/b05c-import.mjs
 M amazon-ops/tests/b11-8-version-compare.mjs
 M amazon-ops/tests/b12-8-blocked-recovery.mjs
 M amazon-ops/tests/probe-routes.mjs
 M amazon-ops/tests/run.mjs
?? amazon-ops/tests/t4-test-infra.mjs          ← 新增 Own file
```

`t2-lowlevel-cooldown.mjs` **不在列表里** —— 证伪 B 的临时夹具已删净。

---

## 6. `src/**` 是否为空 diff

```powershell
$ git diff --stat 689cef1 -- amazon-ops/src
（无输出）
$ git diff --stat testinfra -- amazon-ops/src      # 与自己的 HEAD 比，同样为空
（无输出）
```

本次**没有改过任何生产文件**：QF-2 的证伪用的是「工具本来就有的拒绝路径」
（`STRATEGY_UNCONFIRMED`），不是把生产侧改坏，所以连「改了再改回」都不需要。

---

## 7. 不确定的地方 / 明确未做

1. **`b05c-history` 单跑「18 → 22」没有复测**：那需要 T-3 的一次性子集运行器（已删），
   而「子集运行器」正是这条缺陷的仪器本身 —— 用一个不可靠的仪器去复核它自己的问题没有意义。
   我用的是**全量差值**（1810 → 1813 恰好等于 +3 条新守卫）来支持同一个结论，标 `verified`；
   T-3 那条 18/22 的具体数字标 `documented`。
2. **`main` 已从 `689cef1` 推进到 `ad17a60`**（别的批次）。本文所有差值以 `689cef1` 为基准；
   若主理人要拿 `main` 比，请先确认 `main` 上那 51 行 `docs/COORDINATION.md` 的变化不是本批的。
3. **守卫规则是「紧邻前面必须是 `await`」**，会误报 `Promise.all([checkAsync(...)])` 这类写法。
   本仓没有这种写法；真要写，先放宽规则并在 `t4-test-infra.mjs` 里写清为什么 —— 这是**有意的**取舍
   （穷举 > 宽松）。
4. **`tests/wired-source.mjs` 一字未动**（按并行批次的约定）。本次全量里它的断言照常跑过。
5. **未运行**：真机采集、浏览器端到端（本次缺陷不涉及页面行为）。
6. **未提交**：按任务要求不做 `git commit`。分支 `testinfra` 基于 `689cef1`，
   改动全部留在工作树里。

---

## 8. 复现手册

```powershell
$ cd D:\deepseek-harness-h\workspace\wt-testinfra\amazon-ops

# 全量（唯一的最终判据）
$ node tests/run.mjs                       # 期望：1813 passed, 0 failed，exit 0

# 探针
$ node tests/probe-routes.mjs US           # 期望：probe ok，exit 0

# 迁移表
$ node scripts/check-migrations.mjs        # 期望：dups:[]，迁移表自洽

# 守卫自己的证伪（任取一处 await 去掉 → 期望 1812 passed, 1 failed 且红的是 ②）
#   注意：改完必须改回，并确认树回到已验绿状态
$ git diff 689cef1 -- amazon-ops/src       # 期望：空
```
