# F14-10 报告导出（Excel 写出器 / 导出件头信息 / 「非实时」自证 / 页面导出按钮）· 接口契约（G2）

> **日期**：2026-10-19 ｜ **作者角色**：全栈开发（接手收尾。起点是上一执行者在 `wt-f14-10` 留下的 12 处改动，G2 由主理人裁决）｜ **状态**：**草稿 → 待 G2**
> **关联需求编号**：F14-10（报告导出，P1，模块 14 · 报告中心）
> **关联需求文档**：`docs/requirements/RESEARCH-module-alignment-v2.0.md` 的 F14-10 那一行
> **关联协同**：`docs/COORDINATION.md` §7.3（变更说明）
> **体例参照**：`docs/architecture/API-F14-01-report-library.md`、`API-F14-02-report-standard.md`
> **基线（开工前实测，`git merge main` 之后）**：`main c0dfe01`（worktree `wt-f14-10` / 分支 `f14-10`，
> 基点 `5fc8418` 已旧，先 `git stash -u` → `git merge main`（快进）→ `git stash pop`，**零冲突**）
> - `node scripts/check-migrations.mjs` → `{"count":49,"SCHEMA_VERSION":49,"dups":[],"continuous":true,"last":"optimize-report-xlsx"}`
> - `node scripts/check.mjs` → `OK amazon-ops (plugin: workbench) — 136 tool(s) registered`；`every local plugin can be applied`
> - `node scripts/check-page.mjs` → **3/3**
> - `node tests/run.mjs` → **2002 passed / 2 failed**（接手时的真实状态，两条红见 §8）
> **本批目标**：schema **v50**（**改号**：本批原写 v49，重基到 `e805742` 后与远端已落地的 v49
> `notification-created-at-index` **撞号**，改号为 **v50**，`name` 仍是 `optimize-report-xlsx`；
> 见 §9 与 §0.3）；`TOOLS` **136 → 136**（不新增工具）；
> 断言 **2002 → 2027**（**+25，只增不减**，`tests/f14-10-report-export.mjs` 的 25 条）。
>
> **⚠️ 重基与改号（2026-10-19 晚，第二次进 `wt-f14-10`）**：上面那组基线是对**旧基点 `c0dfe01`** 说的。
> 主理人随后要求重基到 **`e805742`**（= `origin/main`，实测 `2103 passed / 0 failed`、schema v49），做完之后两件事实变了：
> **① 迁移号撞车** —— 远端已有 v49（`notification-created-at-index`，**已在真库跑过**），本批的迁移改号为 **v50**；
> **② 页面被拆分** —— 远端把 `page.js` 拆成 `src/web/pages/*.js`，本批的 `reportExportBits` 因此落在
> **`src/web/pages/report.js`**（不再是 `page.js`），语义不变、仍是列表与详情共用的同一个函数。
> 冲突逐处处理见 §0.3；重基后的实测：`run.mjs` **2128 passed / 0 failed**（2103 + 25）、
> 探针 `{"count":50,"SCHEMA_VERSION":50,"dups":[],"continuous":true,"last":"optimize-report-xlsx"}`、
> `check-page.mjs` **3/3**、`check.mjs` **136 tool(s)** + `every local plugin can be applied`。
> **证据等级**：代码与行为结论一律 `verified`（本次实测：`node tests/run.mjs` / `check-page.mjs` /
> `check-migrations.mjs` / `check.mjs` / 第三方解析器 openpyxl 3.1.5 读回）；
> 引用需求文档的标 `documented`；**本契约里没有 `unverified` 的结论**。

---

## 0. 范围与非目标

### 0.1 这一批做什么（审计点名的四条缺口，逐条交付）

| 缺口（审计原文） | 本批交付 |
|---|---|
| ① **无 Excel 导出** —— `xlsx.js` 只有读（`readWorkbook` / `readFirstSheet`），全仓无写出器 | 新模块 `src/domain/sheets/xlsx-write.js`：**零依赖**（只用 `node:zlib`）的 OOXML 写出器；`renderExcel(model)` 是同一份模型的**第三种渲染**，与 Markdown / HTML 在 `amzn_optimize_save` 的**同一次 update** 里落库（v50 新列 `optimization_run.report_xlsx`；改号前写作 v49）；导出端点**只发字节**，不重新渲染 |
| ② **导出件头部缺 报告 ID / 对象 / 范围 / 来源 / 质量告警** | `model.exportHeader` 六行（第六行是「数据新鲜度」），每行 `{id, label, value, note}`；三种渲染各念同一份，Markdown 是表格（`\| 字段 \| 值 \| 这一格是怎么来的 \|`）、HTML 是带 `id="eh-<row.id>"` 的 `<td class="pv">`、Excel 是「报告头」表的行 |
| ③ **全仓 grep「非实时」0 命中** | `src/domain/optimize/freshness.js#buildFreshness`：`realtime: false` + `label: '非实时'` + 由**五类从库里算出来的量**拼成的 `statement`（§4）。句子不是写死的：换生成时刻，句子跟着变（§13 证伪 3） |
| ④ **报告专区页无导出按钮** | `routes.js#reportState` 每行下发 `exports: { note, formats: [...] }` + `exportable`（数字），页面 `reportExportBits(row)` 只渲染不推导；可用档画 `download` 链接、不可用档画带 `title=理由` 的 chip |

### 0.2 这一批明确不做（非目标）

1. **不给生成类报告（八类）加 HTML / Excel 导出**。它们的正文是自由 Markdown：转 HTML 会引入**第二个渲染器**（与「一条规则一份实现」直接冲突），摊进表格会丢掉「它是一篇文章」这件事。理由随每一档下发（`exportPlan` 的 `reason`），不是留空。
2. **不给文件类报告（`kw-report` / `kw-export`）做导出**。磁盘上那个文件**本身就是导出件**，再生成一份就是第二份副本，先过时的那一份没人知道。
3. **不在导出时重新渲染**。`exportArtifact` 只读列、只发字节。重新渲染会产出「关于今天、却声称描述三个月前那一轮」的文件 —— 那正是 `standards.js#dataCutoffOf` 与 F14-02 在防的事。
4. **不引第三方库**。写出器只用 `node:zlib`（`deflateRawSync` / `crc32`）。装一个 xlsx 库会破坏「拷一个目录就能装」这条性质，只为发六张文本表。
5. **不写公式、共享字符串、数字格式、合并单元格、图片**。一个导出件不需要它们；少一种写法就少一处 Excel 的兼容面。
6. **不加共享的导出历史表、不做「导出过一次」的登记**。导出发的是**已经存在的字节**，不是一次新的生成；给它建账只会多一份可能与 `report` 行不一致的副本。
7. **不改 F14-01 的四态词汇**。`no-source` / `not-modelled` / `not-recorded` / `measured-zero` 原样复用，第五种当场抛错（§11）。
8. **不动 `report` 表的结构**。v50 只给 `optimization_run` 加一列 BLOB，回滚只删这一列（§9）。

### 0.3 重基与改号（2026-10-19 晚，第二次进工作树）

主理人裁决：把这批成果重基到 **`e805742`**（= `origin/main`，实测 `2103 passed / 0 failed`、schema v49），
路径 `git stash push -u` → `git merge --ff-only main`（`f14-10` 是 main 的祖先，**快进**、无 merge commit）→ `git stash pop`。

| 冲突文件 | 远端做了什么 | 本批做了什么 | 怎么解的 |
|---|---|---|---|
| `src/store/schema.js` | 新增 **v49** `notification-created-at-index`（**已在真库跑过**） | 新增 **v49** `optimize-report-xlsx` | **远端为准**（v49 段一字未动），本批那条**改号成 v50**，`name` 不变；两段都在，顺序 49 → 50 |
| `src/web/page.js` | 把 `page.js` 拆成 `src/web/pages/*.js`（`page.js` −11730 行） | 加 `reportExportBits` + 三处调用点 | 取**远端整份** `page.js`；本批那段**原样搬进 `src/web/pages/report.js`**（报告面板的新家），语义不变 |
| `tests/run.mjs` | 新增 14 个套件的挂载块 | 挂 `runF1410ReportExportTests` | 两块都在：本批接在 `runSpendReportTests(...)` 之后、排空之前，`await` 到底 |
| `docs/COORDINATION.md` | 363 行新条目 | 本批的 §7.3 条目 | **自动合并**，无冲突（本批条目追加在文件里原有的最后一条之后） |
| `src/web/routes.js` | 89 行改动（压缩 / 通知 / 页面拆分等） | 导出路由 + `reportState` 的 exports | **自动合并**，无冲突；合并后核对过：`export/` 分支仍在报告正文分支**之前**，`pointer === 'ref'` 的判定没被回退 |

**没有语义冲突**：远端这 51 个提交里没有一处与「报告导出」的判定重合 —— 页面拆分是**搬家**（同一个
`<script>` 作用域，拆文件不拆作用域），不是第二个实现。所以不存在「两份实现该谁收口」的问题。

**改号带出的连带改动**（都是文本，不是行为）：`src/domain/reports/export.js`（文件头 + 缺 Excel 的理由句）、
`src/tools/optimize.js`（一行注释）、`tests/f14-10-report-export.mjs`（⑥b / ⑦b 的针改到 v50，并各加一条**反面**
「理由里不许再出现 v49」）、本契约与 `docs/COORDINATION.md`。

**重基后新增的红**：**没有**。远端这 51 个提交新加的守卫（`check-client-scripts.mjs`、`page-split-map.md`、
`four-state-inventory.md`、`page-source.mjs`、`empty-state-ratchet.mjs`、`clock-guard.mjs`、载荷字段读者守卫等）
一条都没抓到本批 —— 唯一的「新红」是**改号自己带来的**：⑥b / ⑦b 里的 v49 针在改号后变成断言一个不存在的版本号，
所以跟着改针并补反面（不是改远端断言、也不是放宽自己的断言）。

---

## 1. Excel 写出器（`src/domain/sheets/xlsx-write.js`）

### 1.1 为什么手写（而不是「最小可用就够」的托词）

本插件安装方式是**拷一个目录**：没有构建步骤、没有 `package.json` 依赖，`node:sqlite` 是它唯一倚重的非平凡内置模块。为了发六张文本表引一个 xlsx 库，会让**每一个用户**都背上这个依赖。写出器 341 行（含注释），只 import `node:zlib`。

### 1.2 发出什么（逐条）

| 部件 | 内容 |
|---|---|
| `[Content_Types].xml` | `workbook` / `styles` / 每张表各一条 `Override` |
| `_rels/.rels` | 指向 `xl/workbook.xml` 的唯一关系 |
| `xl/workbook.xml` | 表名清单（`sheetId` 从 1 递增，`r:id="rIdN"`） |
| `xl/_rels/workbook.xml.rels` | 每张表一条 + `styles.xml` 一条 |
| `xl/styles.xml` | 两个字体（常规 / 加粗）、两个 `cellXfs`（常规 / 加粗） |
| `xl/worksheets/sheetN.xml` | `sheetViews`（`ySplit=1` 冻结首行）、`cols`（列宽）、`sheetData` |

单元格三种：`inlineStr`（文本，`xml:space="preserve"`）、数字（`<v>`，`Number.isFinite` 把关）、布尔（`t="b"`）。每个格带**显式 A1 引用**（`columnName(index)`），所以空行被跳过时行号不塌（`tests/f14-10-report-export.mjs` ①c 断言 XML 里那一行仍是 `r="8"`）。

### 1.3 确定性（一条容易被忽略的可测性质）

zip 的时间戳写死成 DOS 纪元（1980-01-01），不是 `Date.now()`。所以**同样的行产出逐字节相同的文件** —— 这才能断言「库里的字节 == 现在渲染同一份模型的字节」，而不是断言「有一些字节」。①b 两条：同输入两遍相等；换一行内容字节必须变（反面，防止「相等」是因为压根没写内容）。

### 1.4 拒绝面（六种，各自点名）

| 拒绝的情况 | 抛出的信息里必须出现 |
|---|---|
| 空 workbook | `at least one sheet` |
| 表名超过 31 字符 | `31` |
| 表名含 Excel 禁止字符（`[ ] : * ? / \`）或首尾单引号 | `Excel forbids` |
| 表名重复（**大小写不敏感**：`Sheet1` 与 `sheet1` 同存会让文件打不开） | `duplicate` |
| 非有限数字（`NaN` / `Infinity`） | `non-finite` |
| 单元格超过 32 767 字符 | `32767` |

**为什么必须抛**：失败模式里最坏的是静默那一种 —— 一格悄悄变空白，读的人以为「本来就没有数据」。对照：`readWorkbook` 在入口处拒绝的是镜像的同一件事。①d 另带两条**反面**：31 个字符的表名、零行的空表都**不该**被拒。

### 1.5 实测证据（`verified`）

- **本仓自洽**：①a 逐条目自己 inflate 一遍，比对 CRC32 与两个长度；七个部件名逐字相等。
- **本仓读回**：①c 用 `domain/keywords/xlsx.js#readWorkbook` 读回自己写的字节，中文/引号/`<>&`/数字/布尔/空格子/空行之后的行逐格对账。
- **第三方实现读回**（本次作业单独跑，脚本不进仓）：把 `writeXlsx` 的字节落成 `.xlsx`，用 **openpyxl 3.1.5** 打开 —— zip 的 `testzip()` 为 `None`、七个部件齐全、`sheetnames` 与中文逐字节相等（`utf8-bytes-equal: True`）、`max_row/max_col = 9/3`、数字是数字（`42`）、布尔是布尔（`True`）、空格子是 `None`、表头 `font.bold=True`、`freeze_panes=A2`、列宽 `[18, 60, 90]`。**没有任何 mismatch。**

---

## 2. 一份模型三种字节（★ 本批的结构性主张）

### 2.1 链条

```
buildReportModel({...})  →  model（唯一模型，字段只在这里算）
        ├── renderMarkdown(model)  → 字符串 → optimization_run.report_md
        ├── renderHtml(model)      → 字符串 → optimization_run.report_html
        └── renderExcel(model)     → 字节   → optimization_run.report_xlsx   （v50；改号前写作 v49）
                                          ↓
                         store/queries.js#updateOptimizationRun（**一次** update 写三列）
```

三个渲染器**都不读 store、都不读时钟、都不重新算一个模型已有的数**。`renderExcel` 的九张表（`报告头 / 报告出处 / 数据新鲜度 / 结论 / 逐字段 / 属性字段 / 人工字段 / 自检总表 / 证据包`）逐格来自 `model.exportHeader.rows` / `model.provenance.rows` / `model.freshness` / `model.counts` / `model.rows` / `model.attributeRows` / `model.manualFields` / `selfCheck(model)` / `model.evidencePack`。

### 2.2 验收判据：改坏模型 ⇒ 三种导出**各有一条断言同时变红**

`tests/f14-10-report-export.mjs` ②a 对**三处不同性质**的字段各做一次变异（计数 `model.counts.block`、导出件头信息里的一行 `model.exportHeader.rows[0].value`、新鲜度那一句 `model.freshness.statement`），每次都要求三份渲染同时变红（`red,red,red`），再改回去要求三份同时回绿。改回那半是必须的：没有它，「变红」可能只是文本里本来就有那个串（②a 因此还先断言「改坏之前三份里都没有这个探针」）。

### 2.3 Excel 表与模型的逐行对账

②b 断言九个表名、`逐字段` 表的行数 = `model.rows.length + 1`、表头前五格逐字相等，并**逐行**比对 `Excel 第 N 行第一格 == model.rows[N-1].field`。这是「Excel 不是另写一遍」的可测形式。

---

## 3. 导出件头信息（六行，全部在模型里）

`buildExportHeader(model)` 产出 `model.exportHeader = { rows, realtime: false, label }`。**六行而不是五行**：第六行是审计第 3 条的落点。

| # | `id` | `label` | `value` 从哪来 | `note`（出处，读者可对账） |
|---|---|---|---|---|
| 1 | `report-id` | 报告 ID | `run.id`（= 报告库那一行的 `ref_id`） | 三个地址指同一份字节，所以只有一个 id |
| 2 | `report-object` | 对象 | `run.asin` / `run.marketplace`（与 `asin` 表那一行核对） | ASIN/站点出自哪两列；读不到 `asin` 行时说明「产品概况是空的 ≠ 字段都是 0」 |
| 3 | `report-scope` | 范围 | 字段数 = 草案行数、采纳/拒绝/待定三计数、埋词位置数、证据类数、预算对照字段数 | 四者都是**这一轮**的范围，不是全库 |
| 4 | `report-source` | 来源 | 冻结证据包逐类的 `source`（去重） | 没有证据包时说「这一轮没有冻结」并**明确不是**「本仓没有来源」 |
| 5 | `report-quality` | 质量告警 | `validation.counts`（与第八章同一份）、未执行规则数、站点规则三态、词法三态、写回失败（仅真失败）、证据缺类数 | 「0 条阻断」是一次测量，「读不到规则集」不是 0 |
| 6 | `data-freshness` | 数据新鲜度 | `freshness.headline`（值）+ `freshness.statement`（出处那一格） | 由 §4 的五类量拼出来 |

③b 把每一行的值**从库里重算一遍再比**：报告 ID = `run.id`、对象含 ASIN 与站点、范围里的字段数等于 `SELECT COUNT(*) FROM optimization_draft WHERE run_id = ?`、质量告警里的阻断/警告等于 `model.counts`、没有证据包时来源那一行说「没有冻结证据包」且**不**说「本仓没有来源」。
③c 是反面：`run = {}`（没有 `finished_at`/`started_at`）时 `generatedAt === null`、`lag === null`、句子里出现「没有记录生成时刻」、**不**出现「本文件是…那一刻的字节」。

---

## 4. 「非实时」怎么**由内容推出来**（★ 审计第 3 条）

`buildFreshness({ run, evidence, cutoff })` 不接 `store`，只认已经读出来的行。输出不是一句话，而是一组量 + 由这些量拼出的句子。

| 量 | 从哪一列/哪一表算 | 读者拿它做什么 |
|---|---|---|
| `generatedAt` | `optimization_run.finished_at`，退 `started_at`，都没有则 `null` | 「这份文件是哪一刻的字节」 |
| `cutoff.state/value/label` | `standards.js#dataCutoffOf(evidence)` —— 冻结证据包里**最新的一条观测时间** | 「里面的数据最晚到哪一刻」；`state ∈ dated / undated / none` |
| `lag` | `generatedAt - cutoff`（毫秒 → 「早/晚 N 天 / 不到 1 天（N 小时）」） | 「差多久」是一个**能被重算的数**，不是形容词；一边缺就是 `null`，**不是 0** |
| `evidence.rows[]` | 证据包十类各 `{status, at, source, count, absence}` | 哪几类 `frozen`（冻结）、`absent`（不存在）、`not_modelled`（未建模） |
| `counts` | 上面两项的逐类计数 + `metrics*` | 头部与 Excel「数据新鲜度」表里的每个数字 |
| `metrics.rows[]` | `domain/observe/metrics.js#OBSERVATION_METRICS` 九类 × `availability` / `history`，四态结论由 `gaps.js#metricAbsences` 给 | **哪些指标本身没有历史**（见下） |
| `absences[]` | 证据的洞 + 指标口径限制，合并成一张缺口清单 | 逐条 `{kind, conclusion, action, reason}` |

**审计点名的那三类限制，逐条落地**（④b 逐 id 断言，且计数与 `OBSERVATION_METRICS` 的登记对得上，不是手写的数字）：

| 限制 | 指标 | 判据 |
|---|---|---|
| **只有当前值，没有历史** | `bsr`（BSR）、`rating-reviews`（评分评论） | `history: 'current-only'` → 四态 `not-modelled`（历史序列没建）。**不是** `no-source`：来源就是 `asin` 表 |
| **只有广告侧口径** | `ctr`、`cvr` | `availability: 'partial'` → 四态 `not-modelled`（整条 listing 的口径没建） |
| **本仓没有该来源** | `sessions-orders`（会话订单）、`returns-themes`（退货主题） | `availability: 'no'` → 四态 `no-source` |

`statement` 由五段拼出来（生成时刻 / 数据截止 / 差值 / 证据的洞 / 指标口径限制），最后一句固定是「之后发生的变化**不会**出现在这份文件里 —— 要新的，重新采集并收尾一轮」。**三种渲染都念同一份**：Markdown 是表格那一格 + 一个 `> ⚠️` 引用块，HTML 是 `id="eh-data-freshness"` 那一行 + `<div class="warn-box">`，Excel 是「报告头」表的末行 + 「数据新鲜度」表首行（`非实时 | 非实时 —— 这一份文件不是实时数据 | …`）。④c 三个渲染各自**切一块**再读，并带反面（改 `statement`，三处一起变）。

---

## 5. 导出路由契约

### 5.1 URL 与动词

```
GET  <pagePath>/report/export/<reportId>/<format>        format ∈ { md, html, xlsx }
```

前缀路由 `<pagePath>/report` 的第四种分支（前三种：内联 HTML 视图、`body/<id>` 生成类正文、无尾路径）。`<reportId>` 是**报告库那一行的主键**，不是 `optimization_run.id`（两者对优化报告恰好相等，但契约按 `report.id` 说话）。

### 5.2 响应

| 情形 | 状态码 | 头 | 体 |
|---|---|---|---|
| 有这一份字节 | **200** | `content-type`（见下）、`content-disposition: attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`、`content-length`、`cache-control: no-store` | 字节：优化报告取 `optimization_run.report_{md,html,xlsx}`；生成类取 `report.body` |
| 格式不认识 | **400** | `text/plain; charset=utf-8` | 「没有这种导出格式 "pdf" —— 只有：md / html / xlsx」+ `EXPORT_UNKNOWN_FORMAT` |
| 报告库里没有这个 id | **404** | 同上 | 两种可能分开说：id 抄错了 / 这一条被删了（归档不删行） |
| 报告行在、指向的 run 没了 | **410** | 同上 | 「引用还在、内容没了」，并说明这不是「导出坏了」 |
| 行在、run 在、这一份字节没有 | **404** | 同上 | `EXPORT_UNAVAILABLE` + 逐档理由（缺 Excel 时点名 **v50**） |

`content-type` 按格式：`text/markdown; charset=utf-8` / `text/html; charset=utf-8` / `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`。
`content-disposition` 带**两个**文件名：ASCII 的是老客户端的存盘名（`amazon-ops-<kind>-<date>-<shortid>.<ext>`），`filename*` 的是浏览器显示的那个（拼上报告标题）。只给 ASCII 会让同一目录下六份文件同名；只给 UTF-8 会被一些客户端丢掉。

**为什么是 `attachment` 而不是内联**：内联那个视图是「一页你读的 HTML」；导出是「一个你存下来、转发、用 Excel 打开的文件」。浏览器只认这一条头。

### 5.3 失败为什么都带正文

空 404 会被读成「路由写错了」。所以每个非 200 响应都带一句**这一条的前因后果** + 一个机器可读的 `code`（页面/脚本按 code 分支，人按句子理解）。⑦b 逐条断言 400 / 404 / 410 / 404 四种，并带反面：同一轮的 Markdown 仍然 200（「没有 Excel」≠「整条导不出来」）。

---

## 6. 「三份字节在不在」的判据（一处判据，两个读法）

### 6.1 唯一判据

`src/domain/reports/export.js#availabilityOf(source)` → `{ md, html, xlsx }`：

- 文本两列：`!blank(value)`（`String(v).trim() === ''` 为「没有」）
- BLOB 列：`hasBytes(value)`（`null` 或长度 0 为「没有」）

### 6.2 两个读法（一个判据）

| 读者 | 入口 | 为什么不能逐行 |
|---|---|---|
| 单条导出 | `exportArtifact({row, run, body, format})` → 内部 `availabilityOf(run)` | — |
| 报告列表 | `src/store/queries.js#optimizationArtifactMap(store, ids)` → 一条 `IN (...)`，三列用 `CASE … substr(col,1,1)` **折成一个字符**再喂给**同一个** `availabilityOf` | 列表一页最多 100 行、页面 3 秒轮询一次；逐行 `getOptimizationRun` 是 `SELECT *`，100 行 = 每 3 秒把最多 100 份工作簿搬进内存 |

SQL 那三个 `CASE` 只负责「要不要把内容交给它」：`trim(col, 空白字符集) <> ''` 是 `blank()` 的 SQL 面，`length(blob) > 0` 是 `hasBytes()` 的 SQL 面。**两份拼写能同时存在，是因为一个在 JS、一个在 SQL**；它们行为一致这件事**由测试对账**（⑥a：`null / 空串 / 纯空白 / 有内容 / 零长 blob / 非零 blob` 六种取值，批量读与单条读逐条 `deepEqual`），不是靠注释声明。

### 6.3 `pointer` 是声明的，不是推出来的

`REPORT_KIND_TABLE` 的每条都写着 `pointer: 'ref' | 'path' | 'body'`。`hydrateReport` 把它**原样搬到行上**（`row.pointer`），于是：

- `routes.js` 说 `row.pointer === 'ref'`，不再写 `row.kind === 'optimization'`；
- `export.js#pointerOf(row)` 读 `row.pointer`，只在拿到**裸行**（未 hydrate）时才退回 `hasBody/path` 推断。

这是 §8 那条红（`B05T-⑦b`）的修法：一个事实（「哪一类的正文住在哪一列」）一个拼写处。

---

## 7. 页面（报告专区）

- `reportState` 每行多两格：`exports: { note, formats: [{id,label,ext,type,kind,url,available,reason}] }`、`exportable: <可用档数>`。
- 页面 `reportExportBits(row)`（**一个函数，列表与详情两处调用**）：`available` 画 `<a download data-rp-export="<id>" href=<url> title="下载 <label>（<type>）">导出 <label></a>`；`available === false` 仍画出来，带 `title=<reason>` 的 chip（`<label> 取不到`）。**不可用的也画**：画成点不动的灰块，读者只知道「不行」，不知道「为什么不行、要做什么才行」。
- 页面**不拼 URL、不猜有没有**（⑧a 切出函数体读：里面没有 `report/export`，有 `row.exports` 与 `format.reason`；并数调用点 = 3：1 处定义 + 2 处调用）。
- ⑧b 把**真切片**喂给**真页面脚本**：列表里出现三档 `href`、取不到那一档的理由出现在 HTML 里、详情面板（`state.reportFocus` + 重画）也有一条导出行。

---

## 8. 接手时那两条红：是什么性质、怎么修的

主理人实测（探针 v49）在接手现场给出三条红。第一条（`F14-01-⑧b` 日期炸弹）**不是实现的问题**：main 上 `0890218` + `840ccf0` 已加 `systemClock` 注入点与 `tests/clock-guard.mjs`；`git merge main` 之后它自动消失（本批实测确认）。真正要修的是下面两条。

### 8.1 `FAIL every named import under src/ is actually used`（`src/web/routes.js: availabilityOf`）

**性质**：**真红**，而且是一条设计缺陷的症状 —— `availabilityOf` 被 import 了却没用，因为 `reportState` 自己写了一遍「这三列在不在」（`report_md IS NOT NULL AS has_md` …）。同时它和 `availabilityOf` 的判据**并不等价**：`IS NOT NULL` 认为空串「在」，`blank()` 认为空串「不在」。两条判据迟早给出两个答案。

**修法**：判据收口到一处（§6.2）。`routes.js` 不再 import `availabilityOf`（由 `store/queries.js#optimizationArtifactMap` 使用它），`reportState` 调那一个入口。于是那条断言不再因为它红 —— 并且「列表说能导、点下去 404」这种不一致不可能再从两套判据里长出来（⑥a 对账）。

### 8.2 `FAIL B05T-⑦b 列清单在服务端只有一份字面量`

**性质**：**真红**，但报错信息（「出现了 7 个列 id 字面量 —— 像是抄了一份目录」）描述的是**形状**而不是根因。实际被数到的是 5 个 `'optimization'`（报告**类型 id**）+ 2 个 `'ownership'`（ASIN 列 id，来自 main 的既有代码）。也就是说：这条守卫生效了 —— 同一份「类型 → 正文住在哪一列」的事实在本文件里被**拼写了五次**，而那正是「一条规则一份实现」被破的形状。

**修法**（不改那条断言，按纪律）：把这个事实挪回它的声明处 —— `REPORT_KIND_TABLE.pointer` —— 由 `hydrateReport` 搬到行上（§6.3）。`routes.js` 里 5 处 `kind === 'optimization'` 全部变成 `pointer === 'ref'`，`export.js` 里 2 处同类也一起收口。改完 `routes.js` 的 literals 归零，断言转绿。**证伪**：把其中 4 处改回 `kind === 'optimization'` ⇒ 该条立刻红（§13 证伪 6）。

### 8.3 本次接手**另外发现并修掉**的一个真缺陷（前手未跑通的路径）

`exportPlan` / `exportArtifact` 判「这一类有没有 Markdown」时读 `row.body`。但 `getReport` 返回的是 **hydrated 行** —— 它只说 `hasBody`（是否存在），**不搬正文**（`store/reports.js#hydrateReport`）。后果：**每一个生成类报告的「导出 Markdown」按钮都被判成取不到**，而正文就在库里；导出路由即使被点开，`String(row.body)` 也是 `"undefined"`。

修法：`exportPlan` 用 `row.hasBody`；`exportArtifact` 收一个 `body` 参数（由 `routes.js` 用 `getReportBody(store, row.id)` 取一次交进来 —— 不在导出模块里再写一遍 `SELECT body`）。证据：⑦d（计划说「有」+ 路由 200 且逐字相同；反面：同一条报告的 html/xlsx 各自 404 并带 code）。**证伪**：把 `row?.hasBody === true` 改回 `!blank(row?.body)` ⇒ ⑥b 与 ⑦d 同时红（§13 证伪 5）。

---

## 9. 迁移与回滚（**v50**；改号前写作 v49）

```sql
-- 前进（schema.js 的 MIGRATIONS，version: 50，name: 'optimize-report-xlsx'）
ALTER TABLE optimization_run ADD COLUMN report_xlsx BLOB;

-- 回滚
ALTER TABLE optimization_run DROP COLUMN report_xlsx;
```

- **⚠️ 号段为什么是 50 而不是 49**：本批第一次落地时写的是 v49，当时 `main` 停在 v48（「没撞号」）。重基到 `e805742` 后，远端这 51 个提交里已经有 **v49 `notification-created-at-index`，而且它在真库里跑过了** —— 同一个号被两处使用（本仓第 3 次付这个代价：v40、v42）。处理：**远端那段一个字没动**（改它就是改历史），本批那段改号为 **v50**，`name` 保持 `optimize-report-xlsx`。撞号探针的证伪原文见 §13。
- **为什么存而不是导出时现算**：`buildReportModel` 的输入里有一半是**那一刻**才算得出来的（草案行、校验计数、位置计划、证据包）。收尾之后再算一遍就是「拿今天的规则和今天的 listing 重新解释三个月前的一轮」。
- **为什么是 BLOB 而不是落盘文件**：`report_md` / `report_html` 已经是这一行的两列，第三列放在一起，「同一刻的三份字节」才是**一行**的事；落盘会多出一个会消失的路径（`report` 表里 `kw-report` 那种「取不回」的空态就是这么来的）。
- **为什么可空**：v50 之前收尾的轮次没有这一列。`NULL` = **这一轮没有 Excel 导出件**，不是「Excel 是空的」—— 导出端点、页面、工具三处都这么说（⑤ 与 ⑦b）。
- **可重复执行**：`check-migrations.mjs` 报 `continuous: true`、`dups: []`、`count === SCHEMA_VERSION === 50`。回滚会**丢数据**（已收尾轮次的 Excel 一键消失，MD/HTML 不受影响），只在确认没有任何一份 Excel 还需要留时执行。
- **已有库升级**：v49 → v50 只加一列，无回填、无 rewrite；`tests/run.mjs` 的迁移回放机制照常覆盖。
  ⚠️ **唯一的窄口**：如果有哪个库已经跑过本批**改号前**的 v49（f14-10 的 `report_xlsx`），它的 `user_version` 也是 49 而列已在 —— v50 会以「duplicate column」失败。这种库只能先从备份重建；本批没有在真库上跑过改号前的 v49（见 §0.3「未做的」）。

---

## 10. 工具面（不新增工具）

`TOOLS` 仍是 **136**。`amzn_optimize_report` 的 `format` 多一个取值：

| `format` | 行为 |
|---|---|
| `md`（默认） | 正文 Markdown |
| `html` / `both` | 内联 HTML 视图地址（`<pagePath>/report/<runId>`）+ 可选正文 |
| `xlsx`（也接受 `excel`） | **只给地址**：`<pagePath>/report/export/<reportId>/xlsx`。工具结果是文本，工作簿的 base64 不是人能打开的东西（⑨a 断言返回里没有 `base64`） |

地址由 `reportForRun(store, runId)` 决定的**那一条报告行**给出（与导出路由同一条查询）；这一轮还没进报告库（没跑过 `amzn_optimize_save`）时说「还没有进报告库」并**不编地址**（⑨a 反面：返回里不出现 `/report/export/`）。

`amzn_optimize_save` 的收尾输出多一行「Excel 已存库（N 字节；与上面两份同一份模型、同一刻）」—— 说的是**字节大小**，不是「生成了」。

---

## 11. 四态词汇（复用，不新造）

| 情形 | kind | 在本批里出现在哪 |
|---|---|---|
| 没有表、没有列、没有写入方 | `no-source` | 指标 `sessions-orders` / `returns-themes` |
| 概念在需求里，落点从未建 | `not-modelled` | 指标 `ctr` / `cvr` 的完整口径；`bsr` / `rating-reviews` 的**历史序列**；证据包里 `status: 'not_modelled'` 的类 |
| 表在、这一份记录没有 | `not-recorded` | 证据包里 `status: 'absent'` 的类 |
| 读到了，答案是 0 | `measured-zero` | 证据包里 `status: 'frozen' && count === 0` 的类 |

**`measured-zero` 不进缺口清单**（`absence.hole === false`）：「读到了，答案是 0」是一次发现，不是缺口；把它列进缺口会让「0 就是结论」被读成「缺数据」（⑤b 断言 `holes` 里没有它，且三态的结论句互不相同）。

---

## 12. 断言与证据（本批实测）

| 项 | 接手时 | 交付时 |
|---|---|---|
| `node tests/run.mjs` | 2002 passed / **2 failed** | **2027 passed / 0 failed** → 重基后 **2128 / 0**（= main `e805742` 的 2103 + 本批 25） |
| 其中 F14-10 | 0 条（测试不存在） | **25 条**（`tests/f14-10-report-export.mjs`，10 节） |
| `node scripts/check-migrations.mjs` | `count 49 / dups [] / continuous true` | `{"count":50,"SCHEMA_VERSION":50,"dups":[],"continuous":true,"last":"optimize-report-xlsx"}`（**重基后从 v49 改号成 v50**） |
| `node scripts/check-page.mjs` | 3/3 | **3/3**（重基后仍 3/3；页面脚本已拆到 `src/web/pages/`，探针查的是合成后的 `page.js`） |
| `node scripts/check.mjs` | 136 tools，都注册得出去 | **136 tools**（未增未减）+ `every local plugin can be applied` |
| schema | v49 | **v50**（重基后发现 v49 被远端的 `notification-created-at-index` 占用，改号到 v50；远端那条**没动**） |

25 条断言的分布：① Excel 写出器 4 ｜ ② 一份模型三种字节 2 ｜ ③ 导出件头信息 3 ｜ ④「非实时」自证 3 ｜ ⑤ 四态 2 ｜ ⑥ availability 两读法对账 2 ｜ ⑦ 导出路由 4 ｜ ⑧ 页面按钮 2 ｜ ⑨ 工具面 1 ｜ ⑩ includes 自查 2。

---

## 13. 证伪原文（每条：回退 → 红 → 改回 → 绿）

1. **Excel 写出器**：`return new Uint8Array(zip(entries))` → `return new Uint8Array(Buffer.from('FALSIFY: 假装写出来了，其实不是 zip'))`
   ⇒ `2020 passed, 7 failed`（`FAIL F14-10-①a` / `①b` / `①c` / `②a` / `②b` / `④c` / `⑦a`）。改回 ⇒ `2027 / 0`。
2. **一份模型三种字节**：`renderMarkdown` 里那一格从 `cell(row.value)` 改成 `cell(row.id === 'report-id' ? '自拼的ID' : row.value)`
   ⇒ `2026 passed, 1 failed`（`FAIL F14-10-②a` —— 只有 Markdown 不再念模型，所以「三条同时红」不成立）。改回 ⇒ `2027 / 0`。
3. **「非实时」由内容推出**：`statement: `${REALTIME_LABEL}：${clauses.join('；')}。`` → `statement: `${REALTIME_LABEL}：这一份文件不是实时数据。``
   ⇒ `2023 passed, 4 failed`（`FAIL F14-10-③c` / `④a` / `⑤b` / `⑩b`）。改回 ⇒ `2027 / 0`。
4. **availability 判据**：`md: !blank(run?.report_md)` → `md: true`
   ⇒ `2026 passed, 1 failed`（`FAIL F14-10-⑥a` —— 六种刁钻取值里 `null` 那条当场不一致）。改回 ⇒ `2027 / 0`。
5. **§8.3 那个真缺陷**：`make(FORMAT_BY_ID.md, row?.hasBody === true, …)` → `make(FORMAT_BY_ID.md, !blank(row?.body), …)`
   ⇒ `2025 passed, 2 failed`（`FAIL F14-10-⑥b` / `⑦d`）。改回 ⇒ `2027 / 0`。
6. **`B05T-⑦b` 那条红**：把 `routes.js` 里 4 处 `row.pointer === 'ref'` 改回 `row.kind === 'optimization'`
   ⇒ `2026 passed, 1 failed`（`FAIL B05T-⑦b 列清单在服务端只有一份字面量…`）。改回 ⇒ `2027 / 0`，且 `ok every named import under src/ is actually used`。
7. **页面导出按钮**：删掉列表侧 `const exports = reportExportBits(row); if (exports !== '') bits.push(exports);`
   ⇒ `2025 passed, 2 failed`（`FAIL F14-10-⑧a` / `⑧b`）。改回 ⇒ `2027 / 0`，`check-page.mjs` **3/3**。
8. **迁移号撞车（重基后新增的那一条）**：把本批迁移的 `version: 50` 改回 **49**（与远端的 v49 同号）
   ⇒ 探针**原文**：
   ```
   {"count":50,"SCHEMA_VERSION":49,"dups":[49],"continuous":false,"last":"optimize-report-xlsx","first":"initial-schema"}
   迁移表已经撞了：  · 重复版本号: 49  · 条数 50 !== SCHEMA_VERSION 49  · 版本号不是 1..N 连续升序   （exit 1）
   ```
   改回 50 ⇒ `{"count":50,"SCHEMA_VERSION":50,"dups":[],"continuous":true,...}` + `迁移表自洽 ✓`（exit 0）。
   ⚠️ 这条证伪只在**探针**上做了一次（没有在真库上跑撞号版迁移）—— 真库上撞号的后果是
   「两条同号迁移只有数组里靠前那条会跑」，`src/store/db.js` 的跳过条件是 `step.version <= current`。
9. **版本号写错就红（改号带出的守卫）**：`export.js` 里那句理由从 `v50` 改回 `v49`（其余不动）
   ⇒ `2126 passed, 2 failed`（`FAIL F14-10-⑥b` / `⑦b`），报错原文：
   ```
   FAIL F14-10-⑥b exportPlan 对三类报告给出三种不同的答案，理由随行下发
   理由里还留着旧号 v49: 这一轮**没有 Excel 导出件**：它是在 v49 之前收尾的（…）expected false, got true
   FAIL F14-10-⑦b 四种失败各说各的：未知格式 400、没有这一条 404、正文指丢了 410、取不到 404
   说明里还留着旧号 v49: Excel 导出件取不到：这一轮**没有 Excel 导出件**：它是在 v49 之前收尾的（…）
   ```
   改回 `v50` ⇒ `2128 passed, 0 failed`。
   （另一侧 —— 把 `v50` 写成别的数 —— 由正向针 `includes('v50') === true` 兜住；那一侧**没有单独跑过**，
   本表只记跑过的那一侧，不假装两侧都验过。）

---

## 14. 未做 / 已知限制（别当成做完）

1. **未提交**：本批按纪律**不 `git commit`、不 push**，成果留在 `wt-f14-10` 工作树（重基后：分支 `f14-10` 在
   `e805742`，**11 处修改中的 10 处 + 5 处新增** —— `page.js` 那一处因远端拆分改为 `src/web/pages/report.js`）。
   进入工作树的路径是 `git stash push -u` + `git merge --ff-only main` + `git stash pop`，**stash 条目仍留在
   `git stash list`（`stash@{0}: On f14-10: f14-10-wip`）** —— 那是重基前的现场备份，确认无误后再 `git stash drop`。
2. **未跑真机采集**：没有采集、没有写真实库、没有重启服务。所有验证都在 `mkdtemp` 临时库上。
3. **Excel 的富格式不做**：无公式、无合并、无数字格式、无图表。导出件是「能筛能排序的文本表」。
4. **生成类报告只有 Markdown 一档**（§0.2 第 1 条）。要 HTML/Excel 请用优化报告那一类；理由随档下发。
5. **文件类报告没有导出**（§0.2 第 2 条）。
6. **`optimizationArtifactMap` 的 SQL 面与 `availabilityOf` 的 JS 面是两份拼写**（§6.2）。行为一致由 ⑥a 的取值矩阵对账兜住，不是在结构上只有一份 —— 这一条如实写出，不假装是一份。
7. **导出没有访问控制**：与本插件其余路由一致（本机单用户工作台），不做鉴权、不做限速。
8. **`report_xlsx` 的体积没有上限策略**：一次收尾写一份，不做清理（与 `report_md`/`report_html` 同一现状；报告库的清理归 F14-01 的已知限制）。
