# v68 `rows_read_missing` + 台账 13 号端到端 —— **预案**（dev-10）

> **状态更新（2026-10-25，落码后补）**：lead 已拍板「做、写域给全、`run.mjs` 他接」，本预案**已按原样落实**。
> 落码结果、先红后绿、定向回归、以及那 3 行 `/api/state` 断言该断什么，见
> `team/dev/v68-rows-read-2026-10-25.md`。本文件保留为**决策记录与预研证据**（含 §六 的 stripComments 复现），
> 不再逐条更新；两处不一致时以交付报告为准。

- 日期：2026-10-25 · 状态：**预案已落实**（本文件不再更新，见上面的交付报告）
- 参考树：`e77c069`（冻结清单第 3 版）→ 功能树 `7189b71`（P 2526/0）。**本文所有行号按 `e77c069` 现场核对过**，
  写代码前请再跑一次 §5.4 的号段探针（号可能被别人先拿走）。
- 上游：本单是 `team/dev/t73j-fallback-batch-2026-10-25.md` §五.1 的收口；
  `rows_read` 的领域层已由 t73j 改成 `null`，**现在库里仍写 0** —— 同一个导入有两份答案，这是本单要消掉的东西。

---

## 〇、先给结论，含一条你可能不爱听但我必须说的

**我同意 v68，而且同意照 T-3 的同一套办法（加列、不重建表）。** 但有一个前提必须写在你决策之前：

> **今天这条 `rows_read_missing = 1` 的分支，在真实路径上不可达。**

实测（只读，`parseSourceFile` 直接喂输入，未写库）：

| 输入 | 结果 |
|---|---|
| 只有表头的词表 CSV（`keyword\n`） | **抛** `关键词列表里没有可用的行` |
| 只有表头的 ABA（`搜索词,搜索频率排名\n`） | **抛** `找不到必需列 搜索查询` |
| 只有表头的卖家精灵反查 | **抛** `卖家精灵反查文件里没有关键词行` |
| 只有表头的西柚 / 空 JSON | **抛** `找不到必需列 自然排名` / `JSON 里没有可用的关键词` |
| 六个 parser 的 `stats` | **全部**带 `rowsRead`（`importers.js:328/504/607/685/777/827`） |

也就是说：`rows_read = 0`（真的 0 行）**和** `rows_read_missing = 1`（没报行数）**今天都出不来**；
每个空文件都在 parser 层就被拒了，不会走到 `recordImport`。

**所以这一单的收益不是「修一个正在发生的错数」，而是两件契约上的事：**

1. **消掉一份导入的两个答案**：`importFile(...)` 现在返回 `rowsRead: null`，而同一份导入在库里是 `0`。
   两个界面各说一句，谁也不知道哪句算数 —— 这正是 t73j 引入的（我修了返回值、没修列）。
2. **把「没记到」这件事变成结构上说得出口的**：`rows_read` 是 `NOT NULL DEFAULT 0`，
   它今天**没有能力**表达「没记到」。下一个 parser 忘了写 `stats`（这是最容易被忘的一行），
   系统就会安静地记「这份文件 0 行」——那正是台账 13 号要防的形状。

**如果你要的是「修一个线上正在错的数」，那我建议这一单不做**（迁移成本换不来一个真实的错数）；
**如果你要的是「13 号彻底收口、以后不会退回去」，那就做** —— 纯 ALTER，风险为零，且和 T-3 是同一套话术，
后面的人不用学两套。我按后者准备。

---

## 一、列名与语义

### 1.1 列名：`rows_read_missing`

照 T-3 的 `spend_missing` / `sales_missing`，**一个命名家族，不新造词**。读过 T-3 注释的人不用再看这里。

被否掉的两个候选（写出来，是为了别人不必再想一遍）：

| 候选 | 否决理由 |
|---|---|
| `rows_read_reported`（正向） | 与 `spend_missing` 的方向相反，读端要写 `if (!reported)` —— 同一个库里两种极性，早晚有人写反 |
| 复用 `stats_json`（读 `$.rowsRead` 在不在） | ① 一次事实两个来源（`rows_read` 与 JSON blob 各说一句）；② 依赖 JSON1 扩展；③ `stats_json` 是**传输件**，不是契约 —— 它今天恰好装着，明天改个字段名就没人保证了 |

### 1.2 语义（照抄 T-3，一字不改，只在主语上换成「行数」）

- `1` = 这一份导入**没有报行数**（parser 没有给 `stats.rowsRead`）；
- `0` = **没有记到缺失** —— **不等于数据完整**。迁移（v68）之前写入的老行一律 0，
  所以 0 只能读成「没标记」，不能读成「确定没缺」。

⚠️ 与 T-3 完全同构的那个陷阱，必须写在迁移注释里（否则六个月后一定有人把 0 读成「数据没问题」）。

### 1.3 迁移 SQL（纯 ALTER，可整段抄）

放在 `MIGRATIONS` 数组末尾（`schema.js:4041` 的 `]` 之前），`version: 68`：

```js
  /* ── v68：导入记录的「行数没记到」标记（台账 13 号）──
     `kw_import.rows_read` 是 `INTEGER NOT NULL DEFAULT 0` —— **这一列装不下「没记到」**。
     于是「这份文件读了几行」在没人报过的时候被写成了 0，而 0 读起来是「这份文件一行都没有」。
     （实测：六个 parser 全都报 `stats.rowsRead`，所以今天这个 0 只可能是「没记到」，
     不是「真的 0 行」；空文件在 parser 层就被拒了，走不到这里。）

     为什么**不**把 rows_read 放宽成可空：SQLite 放宽 NOT NULL 要重建表，而本仓的既有取舍是
     「不重建表、不删列」（v8 / v60 的注释）——为一行统计口径重建导入记录表，不划算。
     **加一列记缺失**是纯 ALTER，风险为零。这与 v67 对 kw_ad_fact 的处理是同一个办法。

     口径（必须和读端一起读）：
       · 1 = 这一份导入**没有报行数**（parser 没给 stats.rowsRead）；
       · 0 = 没有记到缺失 —— **不等于行数准确**。迁移前写入的老行一律 0，
         所以 0 只能读成「没标记」，不能读成「确定读了这么多行」。
     回滚：ALTER TABLE kw_import DROP COLUMN rows_read_missing;（SQLite ≥ 3.35 才有 DROP COLUMN；
           本项目的 node:sqlite 够新，但即便如此也建议留着这一列 —— 它不影响任何既有查询。） */
  {
    version: 68,
    name: 'kw-import-rows-read-missing-t13',
    sql: `
ALTER TABLE kw_import ADD COLUMN rows_read_missing INTEGER NOT NULL DEFAULT 0;
`,
  },
```

命名对齐既有风格：v67 叫 `ad-fact-missing-flags-t3`，本单叫 `kw-import-rows-read-missing-t13`
（`t13` = 台账 13 号，与 `t3` 同构；搜索 `t13` 能直接找到台账条目）。

---

## 二、完整改动清单（7 个文件，逐处 before → after）

> 顺序即建议的落码顺序：**先迁移（能跑）→ 再写端 → 再读端 → 最后展示端**。
> 每做完一段都能单独跑一次定向，不用等全绿才敢往下走。

### 2.1 `src/store/schema.js`

| # | 行 | 改成什么 |
|---|---|---|
| S1 | `4041`（`MIGRATIONS` 数组末尾 `]` 之前） | 插入 §1.3 那一段（含注释） |
| S2 | `856-876` 的 `CREATE TABLE kw_import` | **不动**。那个 `CREATE TABLE` 是 v1 的原文，改了会让「新库 = 迁移副本」的对账（`tests/run.mjs` 有 schema 对账断言）失配 —— 新库靠迁移链拿到这一列，和 `kw_ad_fact.spend_missing` 一样 |

`.length === SCHEMA_VERSION` 这条不变量（`b04-collect-foundation.mjs:176`、`b06-quadrants.mjs:516`、
`b08-detail/-lifecycle/-ownership/-plan`、`b11-2b`、`b11-variables`、`kw-key.mjs:512`、
`v61-indexes.mjs:38` 等多处）会自动成立：**1..68 仍然连续**（见 §5.3 的探针）。
其余关于版本号的断言都是「**至少到 vN**」的下限式（`SCHEMA_VERSION < 48` 这类），加一版只会更绿。

### 2.2 `src/store/kw.js` —— `recordImport`（写端，**最关键的一处**）

现状（`101-138`）：

```js
    `INSERT INTO kw_import
       (id, kind, source_id, file_path, file_name, bytes, fingerprint, marketplace, period,
        granularity, layout, rows_read, facts_written, status, included, problems_json,
        stats_json, note, imported_at, date_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       rows_read = excluded.rows_read,
       facts_written = excluded.facts_written,
       ...
     [
       ...
       Number(record.rowsRead ?? 0),
       Number(record.factsWritten ?? 0),
       ...
```

改成：

```js
    `INSERT INTO kw_import
       (id, kind, source_id, file_path, file_name, bytes, fingerprint, marketplace, period,
        granularity, layout, rows_read, rows_read_missing, facts_written, status, included, problems_json,
        stats_json, note, imported_at, date_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)   ← 21 个
     ON CONFLICT(id) DO UPDATE SET
       rows_read = excluded.rows_read,
       rows_read_missing = excluded.rows_read_missing,                          ← 新增
       facts_written = excluded.facts_written,
       ...
     [
       ...
       /* 列本身是 NOT NULL：没记到的时候它只能放 0，**真相由标记说**。
          这不是「0 是个可以接受的缺省」，而是「列装不下 null，所以另立一列记缺失」——
          与 v67 对 kw_ad_fact.spend 的处理同一个办法。 */
       record.rowsRead === null || record.rowsRead === undefined ? 0 : Number(record.rowsRead),
       record.rowsRead === null || record.rowsRead === undefined ? 1 : 0,       ← 新增，紧跟在上面
       Number(record.factsWritten ?? 0),
       ...
```

**三条必须一起改，少一条就静默错位/静默不回写：**
1. 列清单加一列；
2. `VALUES` 的 `?` 从 **20 个变 21 个**（数量对不上，node:sqlite 会抛 —— 这是好的失败，别用 try 包住它）；
3. `ON CONFLICT ... DO UPDATE` 也要 `rows_read_missing = excluded.rows_read_missing`，
   否则「同一份文件重导之后 parser 变了」时标志位是旧的（同字节重导是 no-op 之外的唯一路径：
   `force: true`）。

### 2.3 `src/store/kw.js` —— `masterStats.imports`（读端，**上一轮栽过的那个坑**）

现状（`1003-1008`）：

```js
    imports: store.all(
      `SELECT id, kind, file_name, marketplace, period, granularity, rows_read, facts_written,
              status, included, imported_at
         FROM kw_import ${where('1 = 1')} ORDER BY imported_at DESC LIMIT 50`,
      params,
    ),
```

改成：`rows_read, rows_read_missing, facts_written,`

> 这就是 `routes.js` 那次 `spend_missing` 哑掉的同一种写法：**显式列清单**。
> 全仓 `kw_import` 的读取里，只有这一条是显式列清单（其余三条是 `SELECT *`，见 §3.1），
> 所以**只有它会忘**。

### 2.4 `src/domain/keywords/pipeline.js` —— 文档要改（否则注释变成谎话）

`406-412` 现在写着：

```js
 * ## 为什么承认它现在还过不了存储层
 *
 * `kw_import.rows_read` 是 `INTEGER NOT NULL DEFAULT 0`（`store/schema.js`），
 * 且 `recordImport` 落库前会把「没有值」也转成数字 0（`store/kw.js`）——
 * 这里给的 `null` 到了那一层仍会被写成 0。本函数**只保证领域层不再编造这个数**
 * （返回值与导入记录入参都是 null）；要让页面/工具真的印「未记录」，得改那两层，
 * 不在本批写域内。把这句话写在这里，是为了下一个读代码的人不会以为已经修完了。
```

改成：

```js
 * ## 存储层怎么接住这个 null（v68）
 *
 * `kw_import.rows_read` 是 `INTEGER NOT NULL DEFAULT 0` —— 列装不下 null，所以缺的是**另一列**：
 * `rows_read_missing`（v68）。`recordImport` 收到 `null` 会写 `rows_read = 0` + `rows_read_missing = 1`，
 * 读端据此印「未记录」。**返回值和库里的值现在是同一个答案**（这条 2026-10-25 之前不成立：
 * 返回值是 null、库里是 0，同一份导入两句话）。
 *
 * ⚠️ `rows_read_missing = 0` 只意味着「没记到缺失」，不等于行数准确：v68 之前的老行一律 0。
```

`433-445` 的 `importDescriptor`（审计行）也要改：
`rowsRead: row.rows_read,` → `rowsRead: row.rows_read_missing === 1 ? null : row.rows_read,`
（审计行里的 `rowsRead` 与工具/页面同一个口径；旧审计行没有这一列，`undefined === 1` 为假 → 保留原数，不前向污染。）

### 2.5 `src/web/routes.js` —— `/api/state` 切片透传

`4953-4962` 的 map 里加一行（`rows_read:` 之后）：

```js
      rows_read_missing: row.rows_read_missing,
```

不透过这一行，页面拿不到标记，只能看到 0 —— 和 `spend_missing` 那次一模一样的哑法。

### 2.6 `src/web/pages/research.js` —— 来源表「行」列

现状 `107`：`'<td>' + row.rows_read + '</td>'`
改成：`'<td>' + (row.rows_read_missing === 1 ? '未记录' : row.rows_read) + '</td>'`

### 2.7 `src/domain/keywords/export.js` —— 总库报告里的「行」列

现状 `315`：`+ `<td class="n">${num(row.rows_read)}</td>``
改成：`+ `<td class="n">${row.rows_read_missing === 1 ? '未记录' : num(row.rows_read)}</td>``

### 2.8 `src/tools/kw.js` —— `amzn_kw_source list` 的「行」列

现状 `317`：`{ label: '行', value: row => num(row.rows_read) },`
改成：`{ label: '行', value: row => (row.rows_read_missing === 1 ? '未记录' : num(row.rows_read)) },`

> 这一处的数据来自 `listImports`（`SELECT *`，§3.1），**列会自动到**；
> 只改渲染。与 §2.3 的 `masterStats` 是两条不同的取数路径，**两条都要管**。

### 2.9 不需要改的地方（也列出来，免得有人"顺手"改）

- `src/store/kw.js:60/64/74`（`findImportByFingerprint` / `getImport` / `listImports`）—— 都是 `SELECT *`，
  新列自动带出。**不要**为了"统一"把它们改成显式列清单 —— 那会正是下一次哑掉的地方。
- `src/store/kw.js:144/174`（`excludedFiles` / `findOverlaps`）—— 只读 `file_path` / `file_name`。
- `src/domain/dashboard/onboarding.js:87`、`src/store/agent.js:44`、`src/domain/audit/targets.js`、
  `src/domain/states.js:298`、`src/domain/agent/roles.js:187/231` —— 只用到表名或 `COUNT(*)`。
- `src/domain/prompts/variables.js`（43 个变量）—— 一个都不渲染 import 表（已 grep 确认），不用动。

---

## 三、消费方盘点（谁读 `rows_read`、改后会不会印错/算错）

### 3.1 全部读取点（7 处，一条不漏）

| # | 位置 | 读法 | 取数路径 | 改后 |
|---|---|---|---|---|
| 1 | `store/kw.js:1003-1008` `masterStats.imports` | 显式列清单 ⚠️ | → `/api/state`、总库报告 | **要加列**（§2.3） |
| 2 | `store/kw.js:74` `listImports` | `SELECT *` ✅ | → `amzn_kw_source list` | 自动带出 |
| 3 | `store/kw.js:64` `getImport` | `SELECT *` ✅ | `recordImport` 返回值、`setImportIncluded` 返回值 | 自动带出 |
| 4 | `store/kw.js:60` `findImportByFingerprint` | `SELECT *` ✅ | 判重、`importDescriptor(previous)` | 自动带出 |
| 5 | `web/routes.js:4959` | 透传 `rows_read` ⚠️ | 页面 | **要加 `rows_read_missing`**（§2.5） |
| 6 | `pages/research.js:107` | 直接拼 `row.rows_read` ⚠️ | 屏幕 | **要改文案**（§2.6） |
| 7 | `domain/keywords/export.js:315` | `num(row.rows_read)` ⚠️ | 导出 HTML | **要改文案**（§2.7） |
| 8 | `tools/kw.js:317` | `num(row.rows_read)` ⚠️ | 对话 | **要改文案**（§2.8） |
| 9 | `domain/keywords/pipeline.js:443` `importDescriptor` | 审计行 `after.rowsRead` ⚠️ | 审计日志 | **要改口径**（§2.4） |

### 3.2 改后会印错的（4 处，都是「0 被读成真的 0 行」）

`pages/research.js` 来源表 / `export.js` 总库报告 / `tools/kw.js` 的「行」列 / 审计行的 `rowsRead`。
四处都是**印**，不是算。改法统一：`missing === 1` → 「未记录」（审计行 → `null`）。

### 3.3 会**算**错的：目前**没有**（这是好消息，也是本单便宜的原因）

全仓 `rows_read` **不参与任何求和/比率/排序/阈值**（已逐处确认：只有 4 个展示点 + 1 个审计点）。
所以本单**不会**出现「月报合计被 0 拉低」那类连锁效应（T-3 的 `spend` 会，`rows_read` 不会）。

唯一需要留意的是**排序**：`masterStats.imports` 按 `imported_at DESC` 排，与行数无关。✅

### 3.4 老数据（迁移前）会怎样

| 老行的 `rows_read` | 迁移后 `rows_read_missing` | 屏幕上 |
|---|---|---|
| 12 | 0（列默认） | `12` ✅ 与迁移前一致 |
| 0 | 0 | `0` —— 与迁移前一致，但**它到底是"真 0 行"还是"当年没记到"，谁也说不准**（这些行早于 v68，且当时那个 `?? 0` 一直生效）→ 这一点只能靠注释说清，不能靠机器分开。**不要**为了好看把老行的 0 回填成 1（那是把一个猜测写成事实） |

---

## 四、测试计划 `tests/t73m-rows-read-missing.mjs`

导出 `runT73mRowsReadMissingTests({ check, equal })`，**全同步断言**（`check` 不接受 Promise），
自带直接 `node` 跑的守卫（照 t73j 的形状）。

> 为什么能全同步：三条要读的东西（`recordImport` / `masterStats` / `listImports` / `renderMasterReport`）
> 都是同步函数，`openStore` 也是。唯一异步的是工具的 `execute`（`tools/kw.js:296` 是 `async`），
> 所以**工具的渲染不在这里断**，而是断在它读的那个 store 函数（`listImports`）+ §4 ⑤(b) 的源码守门。
> 若你要真的工具输出，接线时多传一个 `checkAsync`，我再补一条（`t73h` 那种写法）。

前置：`mkdtempSync` 一个临时 dataDir + `openStore`；每个 check 自建 store（互不污染，照 t73h）。

| # | 断言什么 | 修前为什么红 |
|---|---|---|
| **①** | **有行数 → 正常**：真链路 `importFile(store, { filePath: 两行词表 CSV })` → `result.rowsRead === 2`；`kw_import` 行 `rows_read = 2` 且 **`rows_read_missing = 0`**；`masterStats(store).imports[0]` 同样两值 | 修前 `masterStats.imports[0]` **没有** `rows_read_missing` 这个键（`undefined`）→ 红 |
| **②** | **没行数 → `1` 且印「未记录」**：`recordImport(store, { …, rowsRead: null })` → 库里 `rows_read = 0` **且** `rows_read_missing = 1`；然后**两条取数路径**各断言一次：<br>· `masterStats(store).imports[0]`（→ 页面与总库报告都走它）；<br>· `listImports(store)[0]`（→ `amzn_kw_source list` 走它，`SELECT *` 那条）；<br>· `renderMasterReport({ stats }).html` 的「行」格里是 **「未记录」**（同步渲染，直接断 HTML 字符串） | 修前：库里没有这一列 → 红；两处取数都拿不到标记、渲染印 `0` → 红 |
| **③** | **真 0 行 ≠ 没记到（本条是核心）**：`recordImport(store, { …, rowsRead: 0 })` → `rows_read = 0` **且 `rows_read_missing = 0`**，展示端印 **`0`**（不是「未记录」）<br>⚠️ **这条不能拿真文件造**：实测只有表头的词表/Aba/卖家精灵/西柚/空 JSON **全部在 parser 层抛**（§〇），所以「真 0 行」在生产里来自 store 层的 `rowsRead: 0`，测试就在 store 层造，并在注释里写明这是**契约测试**而不是「模拟一个不存在的文件」 | 修前：没有 `rows_read_missing`，两个 0 分不开 → 这条和 ② 会**互相矛盾地都绿**（同一列的两个含义），这正是缺陷 |
| **④** | **迁移本身**：`new DatabaseSync(tmp)` → `replayTo(db, 67)`（照 `b04-collect-foundation.mjs:116`）→ 手插一行老 `kw_import`（`rows_read = 7`）→ `openStore` 打开 → `user_version = 68`；老行 `rows_read` **仍是 7**、`rows_read_missing = 0`；`PRAGMA table_info(kw_import)` 里新列 `notnull = 1` 且 `dflt_value = '0'`。再断言一句语义：用这条老行跑 `masterStats` 印 **`7`**（不是「未记录」） | 修前：`SCHEMA_VERSION = 67`，打开后不会升到 68、列不存在 → 红 |
| **⑤** | **端到端，不许 `SELECT *` 蒙混**：<br>(a) `masterStats(store).imports[0]` 必须**有** `rows_read_missing` 键（直接锁住 §2.3 那条显式列清单）；<br>(b) 源码级守门：`src/store/kw.js` 里那条 `masterStats` 的 SELECT 必须含 `rows_read_missing`（正则 `rows_read,\s*rows_read_missing`），且 `src/web/routes.js` 的 import 切片必须含 `rows_read_missing`；<br>(c) 【可选，lead 接线】`run.mjs:10116` 那一段真 `/api/state` 加 **3 行**：`equal(kwPayload.master.imports[0].rows_read_missing, 0, '…')` | 修前 (a)(b) 都红 |
| **⑥** | **坏输入 / 幂等**：`recordImport` 同一 `id` 连写两次（先 `rowsRead: null` 再 `rowsRead: 5`）→ 最终 `rows_read = 5` **且标记回 0**（`ON CONFLICT` 那一行没改就会红 —— 这正是 §2.2 第 3 条的守门）；`rowsRead: undefined` → 也记 1 | 修前：没有标记列 → 红；**改了一半**（漏 `ON CONFLICT`）→ 这条专抓 |

**先红后绿**：①②③④⑤⑥ 在 `src/**` 未改前全部红（`rows_read_missing` 不存在），
其中 ③ 的红格外重要——它证明「两个 0」真的分不开，而不是我口头说分不开。

### 4.1 定向回归（落码后必跑，不是全量）

`tests/kw-master.mjs`（`amzn_kw_source` / `renderMasterReport` / `masterStats` 都在这里）、
`tests/kw-pipeline.mjs`、`tests/t73h-adfact-missing.mjs`（同一个迁移家族的邻居）、
`tests/b04-collect-foundation.mjs`（迁移连续性 ①-⑥）、`tests/db-backup.mjs`（`SCHEMA_VERSION - 1` 那条）、
`tests/wired-source.mjs`（新导出/新引用不制造孤儿）、`tests/t73j-fallback-batch.mjs`（`rowsReadOf` 的口径）。

### 4.2 `tests/run.mjs` 接线（4 行，按章程由 lead 做）

```js
/* T73m —— 13 号收口：`rows_read_missing`（v68）+ 三处展示印「未记录」。 */
import { runT73mRowsReadMissingTests } from './t73m-rows-read-missing.mjs'
```

```js
/* T73m —— 13 号端到端：迁移 → 写端 → 读端 SELECT → 展示。 */
await runT73mRowsReadMissingTests({ check, equal })
```

插在 t73l（现在叫 t73j）那两条之后即可；`t73m` 这个字母目前**没人用**（t73j/k/l 分别是 T-2 批、dev-11 两单）。

---

## 五、风险与「纯 ALTER」的确认

### 5.1 逐条确认：不重建表、不删列、不动既有数据

| 检查项 | 结论 |
|---|---|
| 是否 `CREATE TABLE ... AS SELECT` / `DROP TABLE` | **没有**。v68 只有一条 `ALTER TABLE … ADD COLUMN` |
| 是否删列 / 改列类型 / 改可空性 | **没有**。`rows_read` 一个字节不动，老值原样保留 |
| `ADD COLUMN ... NOT NULL DEFAULT 0` 合法吗 | **合法**：SQLite 允许 `NOT NULL` + **常量** DEFAULT 的 `ADD COLUMN`（既有行按 DEFAULT 填）。v67 已用同一句法对 `kw_ad_fact` 做过两次（`schema.js:4037-4038`） |
| 会不会锁表/耗时 | 单表 `ALTER ... ADD COLUMN` 是 O(1) 元数据操作（SQLite 不重写行） |
| 迁移失败会怎样 | `db.js:139-161`：**每步一个事务**，失败 `ROLLBACK` 并抛 `migration 68 … failed`；且升级前先整份备份（`current > 0 && current < SCHEMA_VERSION` → `backupStoreFile`）→ 最坏情况是库停在 67，可把备份拷回 |
| 号段冲突 | `SCHEMA_VERSION = 67`、`MIGRATIONS.length = 67`、1..67 连续、无重号（现场探针，见 §5.4） |
| 新库与老库对账 | 新库靠迁移链拿到该列；`CREATE TABLE kw_import`（v1 原文）**不改** —— 改它会让「新库 CREATE 出的表」与「迁移出的表」出现列序差异，而本仓有 schema 对账断言 |

### 5.2 本仓既有的取舍（原文引用，三处）

`schema.js:662-663`（v8，最早把这条规矩写下来的地方）：

> — 加一列 origin 把来源记下来（值：draft-applied 写回写入 / snapshot 来自采集快照
> / manual 人工录入），报告据此给「优化前」标上可区分的来源。纯 additive：
> **不重建表，不删列（SQLite 删列要重建，那会破坏既有数据）。**

`schema.js:1348-1350`（v60，同一个理由用它拒绝了改主键）：

> 为什么 ALTER 加列而不是重建表：SQLite 改主键要 CREATE TABLE … AS SELECT 重建，
> 而重建会毁既有数据（v8 的 origin 注释已记）。setting 的主键仍然是 key，
> workspace_id 只是维度列。

`schema.js:4025-4027`（v67，本单的直接模板）：

> 为什么**不**把 spend 放宽成可空：SQLite 放宽 NOT NULL 要重建表，而本仓的既有取舍是
> 「不重建表、不删列」（见 v8 / v60 附近注释）——为一个统计口径重建事实表、
> 承担既有数据风险，不划算。**加一列记缺失**是纯 ALTER，风险为零。

先例：`kw_import` 这张表**已经被 ALTER 过**（v58 `schema.js:3691`：`ALTER TABLE kw_import ADD COLUMN date_source TEXT;`）
—— 对它 ADD COLUMN 不是新做法。

### 5.3 迁移连续性探针（落码前跑一次，落码后再跑一次）

```bash
node --input-type=module -e "
const { MIGRATIONS, SCHEMA_VERSION } = await import('./src/store/schema.js')
const versions = MIGRATIONS.map(m => m.version)
const missing = []
for (let v = 1; v <= SCHEMA_VERSION; v += 1) if (!versions.includes(v)) missing.push(v)
console.log(SCHEMA_VERSION, MIGRATIONS.length, '缺号:', missing, '重号:', versions.length - new Set(versions).size)
"
```

现在是 `67 67 缺号: [] 重号: 0`；改完应是 `68 68 缺号: [] 重号: 0`。

> ⚠️ **别拿 `tests/t52-product-profile.mjs:22` 当回归证据**：它写着 `equal(SCHEMA_VERSION, 62, …)`，
> 是一个**钉死绝对版本号**的游离脚本（不在 `run.mjs` 里，从 v63 起就已经是红的）。
> 本单既不改它、也不靠它；只是提醒：全仓搜 `SCHEMA_VERSION` 时会看到它，别被它误导成「本单弄红的」。

### 5.4 号段占用（**写代码前必做**，防撞号）

在我写这份预案的时点 `68` 是空号。但冻结树里 dev-11 也动过 `asin/sections.js`（t73k），
若他也要迁移，两人可能同时拿 68。**开写第一件事**是 `grep "version: 68" src/store/schema.js`，
有就顺延 69（迁移号只增不改，顺延不影响任何断言，`.length === SCHEMA_VERSION` 仍然成立）。

### 5.5 写域申请（**这一条要你明确批**）

上一批我的写域是「三个文件」，且 `src/store/schema.js` 在**绝对不许碰**的名单里。本单需要：

| 文件 | 为什么必须 |
|---|---|
| `src/store/schema.js` | v68 迁移 |
| `src/store/kw.js` | 写端 `recordImport` + 读端 `masterStats` |
| `src/domain/keywords/pipeline.js` | `rowsReadOf` 文档 + `importDescriptor` 口径 |
| `src/web/routes.js` | `/api/state` 透传 |
| `src/web/pages/research.js` | 「行」列文案 |
| `src/domain/keywords/export.js` | 总库报告「行」列文案 |
| `src/tools/kw.js` | `amzn_kw_source list` 的「行」列 |
| `tests/t73m-rows-read-missing.mjs` | 新建 |
| `team/dev/v68-rows-read-2026-10-25.md` | 交付报告 |

`tests/run.mjs` 仍归你（§4.2 的 4 行）。

> 如果 `src/web/**` 你想留给别人，我可以只交「prepared slice」：把 §2.5-2.8 四处文案的
> patch 写到报告里、测试改成只断 `masterStats` + 工具两处，页面/报告那两格留空。
> **但我不建议**——那样正好是你上一轮最怕的「函数级正确、线上不生效」。

---

## 六、`wired-source.stripComments` 失步：最小复现与修法

### 6.1 最小复现（3 行，实测）

```js
import { stripComments } from './tests/wired-source.mjs'
stripComments('const re = /"/g\n/* 注释 ?? 0 */\nconst y = 1')
// 期望：注释被剥掉 —— 实际：原样返回，注释还在
```

实测四种触发字符（`quotes-probe`）：

| 正则里的字符 | 注释被剥？ |
|---|---|
| `/"/g` | **否** |
| `/'/g` | **否** |
| ``/`/g`` | **否** |
| `/abc/g`（对照，无引号） | 是 |
| `'"'`（对照，真字符串） | 是 |

**机理**：状态机只有四种状态（code / line / block / single/double/template），**不认识正则字面量**。
`report.js` 的 `esc()` 里有 `.replace(/"/g, '&quot;')` —— `"` 被当成字符串开头，
从此整份文件"在字符串里"，**后面所有注释都不再被剥**（实测：`report.js` 剥完仍含
第 1349 行那段 JSDoc 的「第三态」两个字）。全仓 442 个 `.js/.mjs` 里，**61 个**受影响
（`run.mjs` 少剥 40 KB、`web/page.js` 少剥 13 KB —— 也就是这些文件的注释全被当成代码）。

### 6.2 影响面（这是「为什么必须修」的定量回答）

`analyzeWiring` 用剥注释后的文本数引用（`occurrences`），所以注释里出现的 `name(` 会被算成一次调用
→ **一个孤儿导出可以被注释"救活"**（`no-caller` → 不算孤儿），architecture 守门的结论就假了。

我复刻了 `analyzeWiring`（strip 可注入，其余逐字照抄）跑了两遍：

| 指标 | 现在（bug 版） | 修后（V2） |
|---|---|---|
| 导出总数 | 1189 | 1189 |
| 孤儿数 | 29 | 29 |
| 只在 bug 版里是孤儿 | — | **0** |
| 只在修后版里是孤儿 | **0** | — |
| 名单与实测不一致 | 0 | 0 |
| `kind` 分类不一致 | 0 | 0 |

**结论：修它是行为中性的（今天一棵树上零翻转）** —— 所以它**不会**连带红一片，
可以单独一单、先修先绿；同时这也说明今天没有孤儿正被注释掩护，
**但它随时会**（只要有人在一个孤儿旁边的注释里写下 `foo(` 四个字符）。

### 6.3 修法（候选，附已实测的原型）

在状态机里加第五种状态 `regex`，靠**前一个有意义 token** 判断 `/` 是正则还是除法：

```js
/* / 后面能开始正则的上下文（表达式位置）—— 这是标准启发式，不是解析器。 */
const REGEX_PRECEDER_CHARS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
  '+', '-', '*', '%', '<', '>', '~', '^'])
const REGEX_PRECEDER_WORDS = new Set(['return', 'typeof', 'instanceof', 'case', 'in', 'of', 'do',
  'else', 'yield', 'await', 'new', 'delete', 'void', 'throw'])

function startsRegex(out) {
  const { char, word } = prevTokenInfo(out)        // 向前跳过空白，取最后一个 token
  if (word !== '') return REGEX_PRECEDER_WORDS.has(word)
  return REGEX_PRECEDER_CHARS.has(char)
}

/* mode === 'code' 且 c === '/' 且 startsRegex(out) → mode = 'regex' */
/* mode === 'regex'：'\\' 跳过下一个字符；'[' 进字符类、']' 出；字符类外的 '/' 结束正则 */
```

原型实测（`%TEMP%/strip-probe.mjs`，**没进仓库**）：

- 三种引号复现全部修好；两条对照仍正确；`report.js` 剥完**不再含**那段 JSDoc；
- 所有 442 个文件剥完**行数守恒**（没有吞掉整段代码）；
- §6.2 的孤儿集合零翻转 → 现有 8 条 `wired-source` 断言不会因此变红。

**已知边界（必须写进注释，不能假装没有）**：`if (x) /re/.test(s)` 这种「`)` 之后跟正则」的写法，
启发式会判成除法（`)` 不在集合里）。误判的代价是那一段按「代码」继续扫 —— 只有在正则体内
含引号/反引号时才会再次失步。本仓实测没有这种写法；如果将来出现，正确的修法是把状态机换成
真词法器（或者引 `acorn` —— 但本仓零依赖，所以**只在必要时**）。

**测试随行（3 条，进 `wired-source.mjs` 的健全性段落）**：
① `/"/g` 复现 → 修前红；② 修后 `report.js` 剥完不含 `/** 第三态` 这类注释标记；
③ 「`)` 之后跟正则」的已知边界**显式钉成当前行为**（写成一条会红的断言，比写在注释里强）——
或者干脆不钉，只在注释里声明。我建议钉：本仓的规矩是"边界要可证伪"。

---

## 七、我要你拍的三件事

1. **做不做 v68**：§〇 说清了「收益是契约不是错数」。你说做我就做；说「不值一次迁移」，
   我就把这单改成「把 `importFile` 的返回值也退回 0」——但那等于**故意让两份答案继续不一致**，
   我更希望做 v68。
2. **写域**（§5.5）：尤其 `src/store/schema.js` 上一批是禁碰，需要你明确放行；
   `src/web/**` 两处文案要不要一起给我。
3. **`run.mjs:10116` 那 3 行**（真 `/api/state` 的 `rows_read_missing`）要不要加进本单 —— 加，就是
   「线上真切片」级证据；不加，端到端到 `masterStats` 为止（已经不弱，但还是函数级）。

另：第 6 节（stripComments）我建议**单独一单**、排在 v68 之前或之后都行 ——
它跟 v68 没有耦合，改的是 `tests/wired-source.mjs` 一个文件，行为中性（§6.2），先修先绿。
