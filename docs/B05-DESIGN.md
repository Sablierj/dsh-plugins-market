# B05 增量设计：关键词管道闭环 + 总库→优化接缝（v14）

> 对象：`docs/ARCHITECTURE.md` §6 的 **B05 那一行**（第 869–877 行）与 **§12.2 时序图**（第 1148–1167 行）。
> 基线：HEAD = `dc3bd42`，schema 已到 **v13**，工具 **36** 个，断言 **376** 条全绿。
> 本文只做设计，**不动 `src/**`**。章节号沿用 ARCHITECTURE.md，所有「见 §x」仍然成立。

---

## 0. 一句话结论（先看这个，否则会做多）

**五个阶段的逻辑已经全部存在，B05 不要重写它们。**

| 阶段 | 已存在的实现（现状） | B05 要做什么 |
|---|---|---|
| 筛选 | `queryMaster(store, filters)` — `src/store/kw.js:579` | 已经能筛，**不重写** |
| 分层 | `classify.js` 的 `classifySvTier` / `classifyFunnel` / `classifyPriority` / `opportunityFor` / `classifyOwnStatus` | 已是纯函数，**不重写** |
| 分派 | `buildKeywordAllocation({keywords, listing, fields, embedding, marketplace})` — `src/domain/optimize/plan.js:321` | **不重写** |
| 落位 | `buildEmbeddingPlan` / `backendCandidates` — `src/domain/optimize/embedding.js:82 / :216` | **不重写** |
| 出表 | `amzn_kw_export` → `buildActiveSets` / `fitBackend` / `buildNegatives` / `toCsv` — `src/tools/kw.js:395`、`src/domain/keywords/export.js` | **不重写** |

**B05 真正要建的三件事：**

1. **编排** —— 一个把五步串起来、逐步记 input/output 的函数（现在五步是五个孤立入口，没人把它们当一次"运行"）；
2. **留痕** —— v14 的 `kw_pipeline_run` / `kw_pipeline_stage`，让「这次跑过什么、每步进出多少、参数是什么」**可回看**；
3. **接缝** —— `amzn_optimize_prepare` 加 `includeMaster`，让 `kw_master`（当前约 31805 行实测数据）的词进得了优化数据包，且**不冒充实测排名**。

> 这条结论直接决定工作量：B05 是**编排 + 留痕 + 接缝**，不是「实现管道」。

---

## 1. 现状核对：§6 B05 那一行还成不成立

> 方法：`git log --oneline -30` + 读真实代码。**不照文档里那张状态表往下推。**

| 文档断言（§6 B05 第 873–875 行） | 真实情况 | 判定 |
|---|---|---|
| 改 `src/domain/keywords/pipeline.js`（抽命名阶段 + 落 `kw_pipeline_run`） | 该文件**存在**，但它是**导入管道**：`file → facts → rollup` 四步（read / parse / write / rollup），服务于 `amzn_kw_import`。与「优化管道」五阶段**不是一回事** | ❌ **错**。往里塞会让一个文件承担两种管道。→ 新建 `src/domain/keywords/optimize-pipeline.js` |
| 改 `src/tools/optimize.js`（`keywordSetFor` 加 `includeMaster`，每词带 `origin`） | `keywordSetFor(store, asin, marketplace, limit)` 签名**确认**（`src/tools/optimize.js:88`），返回 `{ coverage, keywords }`；`keywords = [...measured, ...untested]`。**没有 `includeMaster`、没有 `origin` 字段** | ✅ 成立，且确实没做 |
| 新文件 `src/store/pipeline.js` | **不存在**（store 下只有 `db/kw/policy/prompt/queries/rules/schema`） | ✅ 成立 |
| 新文件 `src/tools/pipeline.js`（或并入 `kw.js`） | 建议**并入 `src/tools/kw.js`**：那里已有 6 个 `amzn_kw_*` 工具（587 行）。再开 `tools/pipeline.js` 会让 kw 类工具分裂两处 | ⚠️ 取「并入」那一支 |
| 改 `src/web/page.js`（`renderPipeline` + `kw` 页内分区） | `renderPipeline` **不存在**；`kw` 已在 `RICH_PANELS`（`page.js:35`），即有手写面板 | ✅ 成立 |

**另外两条我单独验过的断言：**

- **「`amzn_optimize_prepare` 现在读 `keyword`/`asin_keyword`，不读 `kw_master`」（ARCHITECTURE 第 596 行）→ 仍然成立。**
  证据：`keywordCoverage`（`src/store/queries.js:454`）只查 `asin_keyword LEFT JOIN keyword`；在 `src/tools/optimize.js` 里 grep `kw_master` / `includeMaster` / `origin` **零命中**（唯一命中是第 773 行 `origin: 'draft-applied'`，那是 listing 写回，与关键词无关）。B04 只动提示词，没碰这里。
- **`src/store/kw.js` 确实已存在**（v9 那批：事实表 + `kw_master` 汇总表），导出 `queryMaster` / `masterStats` / `normalizeKeyword` 等。

---

## 2. 核对中发现的文档错误（请带回 ARCHITECTURE.md）

这四条**文档写过就是权威**，错了会一路带到 B06/B07。

| # | 位置 | 文档写的 | 真实 | 建议修法 |
|---|---|---|---|---|
| **E1** | §13 文件清单 · `src/domain/keywords/pipeline.js` | 「B05 · **待改**（抽命名阶段 + 落 `kw_pipeline_run`）」 | 同名文件已被**导入管道**占用 | 改为「⬜ **新建** `src/domain/keywords/optimize-pipeline.js`（B05）；`keywords/pipeline.js` **不动**（它是导入管道）」 |
| **E2** | §6 B04 · 做什么 | 「`PROMPT_SETS`（**7 套**）迁入库」 | 实际 **12 套**：`collect / asin / competitor / research / kw / pipeline / rules / policy / optimize / prompts / report / settings` | 改成 12 套。B04 已按 12 套落地，文档写 7 会让后来者以为漏了 5 套 |
| **E3** | §13「状态」列 | 大量 ⬜ 待建/待改 | B01–B04 已全部落地；`store/rules.js`、`domain/rules/registry.js`、`store/policy.js`、`domain/policy/parse.js`、`tools/policy.js`、`store/prompt.js`、`domain/optimize/prompt.js`、`domain/optimize/prompt-seed.js` 均已在库 | 状态列整体刷新（已知会） |
| **E4** | —— | —— | **关键词大小写「写侧敏感、读侧不敏感」的不对称（新发现）**：三张表（`keyword` / `asin_keyword` / `kw_master`）的**写**路径都用 `normalizeKeyword()` = **trim + 折叠空白，保留大小写**（`src/store/kw.js:731`、`queries.js:294 / :344`）；而 `src/tools/optimize.js:147 / :149` 的 `keywords` 入参过滤**两侧都 `.toLowerCase()`**，是全项目**唯一**一处大小写不敏感的比较 | 不是 B05 引入的。B05 的合流必须先定死同一性判定（见 §4.1 的 **决定 D1**）。**写侧统一留给 B05.1 根治档**，B05 不动写路径 |

**E4 的具体后果**：写键大小写敏感 ⇒ 同一个词的不同大小写形式在库里是**两行**（`ON CONFLICT(keyword, marketplace)` 拦不住）；`keywordCoverage` 的 `LEFT JOIN k.keyword = ak.keyword`（`src/store/queries.js:462`，SQLite 默认 `BINARY` 排序）**join 不上** ⇒ `library_tier` 为 `null`，且两行各自进 `rows`。B05 打开 `includeMaster` 后，`asin_keyword` 的 `Wireless Mouse` 与 `kw_master` 的 `wireless mouse` 会被当成**两个词**都进包，「同词以 `measured` 为准」在这两行之间**不生效**。

> **⚠️ 更正（本条首版写错了）**：首版说「`optimize.js:147` 会导致静默为空」——**不对**。147 建 `wanted` 集合时 lower、149 过滤时也对 `row.keyword.toLowerCase()`，**两侧都 lower**，所以传 `BlueTooth Speaker`、库里存 `Bluetooth Speaker` **是能匹配上的**。它真正的性质是「**全项目唯一一处大小写不敏感的比较**」，是**不一致性信号**，不是错误本身。ARCHITECTURE §7.1 已按更正后的版本写。

---

## 3. v14 迁移（只追加，绝不改 v1–v13）

> 纪律（ARCHITECTURE §3.1）：**编号是计划值，`src/store/schema.js` 的 `MIGRATIONS` 才是权威**；追加时一律加到当前最大版本之后，本节同步后移后续编号。落地后请同步 §3.1「已落地版本」表（v13 = `prompt-library` · B04 · `dc3bd42`）。

### 3.1 DDL

```sql
-- v14
CREATE TABLE kw_pipeline_run (
  id            TEXT PRIMARY KEY,        -- uuid
  marketplace   TEXT NOT NULL,
  product_line  TEXT,                   -- NULL = 该站点全部产品线
  params_json   TEXT NOT NULL,          -- 本次运行的入参快照（filters + limit + purpose），可复现的凭据
  trigger       TEXT NOT NULL,          -- 'tool' | 'page'
  input_count   INTEGER NOT NULL,       -- 进筛选的词数
  output_count  INTEGER NOT NULL,       -- 出表写出的行数（CSV 行数合计；仅写内存不出文件时 = 末阶段 output_count）
  status        TEXT NOT NULL,          -- 'done' | 'failed'
  error         TEXT,                   -- status='failed' 时的消息，**不吞**
  result_json   TEXT,                   -- 产物摘要：{ files: [{path, rows}], sets: {...} }
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX idx_kwprun_mkt ON kw_pipeline_run(marketplace, started_at DESC);

CREATE TABLE kw_pipeline_stage (
  id           TEXT PRIMARY KEY,        -- uuid
  run_id       TEXT NOT NULL REFERENCES kw_pipeline_run(id),
  seq          INTEGER NOT NULL,        -- 1..5
  stage        TEXT NOT NULL,           -- 'filter' | 'tier' | 'assign' | 'place' | 'export'
  input_count  INTEGER NOT NULL,
  output_count INTEGER NOT NULL,
  params_json  TEXT,                    -- 该阶段自己的参数（如 export 的 purpose）
  result_json  TEXT,                    -- 该阶段产物摘要
  status       TEXT NOT NULL,           -- 'done' | 'failed'
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  UNIQUE (run_id, seq)
);
CREATE INDEX idx_kwpstage_run ON kw_pipeline_stage(run_id, seq);
```

### 3.2 为什么是「run + stage」两张表，不是 §3.6 原来那一张

ARCHITECTURE §3.6 原设计把 `stage` 直接放在 `kw_pipeline_run` 行上（`kw_pipeline_run(stage, input_count, output_count, …)`）。那会让**一次运行变成 5 行**，而 `marketplace` / `params_json` / `started_at` 这些**运行级**字段在 5 行里重复 5 遍 —— 同一事实存多处，迟早不一致。

拆成两张：运行级字段只在 `kw_pipeline_run` 一行，逐步数据只在 `kw_pipeline_stage`。**这是对 §3.6 的增量修正，请一并同步回 ARCHITECTURE §3.6。**

### 3.3 记什么才算「可回看 / 可复现」

| 问题 | 记录 | 落在哪 |
|---|---|---|
| 这次跑了什么参数？ | `params_json`（filters + limit + purpose 全量快照） | run |
| 每步进出多少？ | 逐步 `input_count` / `output_count` | stage |
| 产物在哪？ | `result_json.files = [{path, rows}]` | run |
| 失败在哪一步？ | `stage.status='failed'` + run.`error` | stage + run |
| 三周后重跑，结果一样吗？ | **不保证字节一致**——库会变（新导入会改 `kw_master`）。可复现的是**参数与口径**，不是字节重放 | —— |

> **纪律：不谎报可复现。** 页面/工具输出里要说「按当时的库与这些参数算出」，**不要**说「结果可完全重现」。

### 3.4 不变式（加在 store，不在调用方）

按约束「不变式加在资源边界（store）而不是调用者的任务边界」，`src/store/pipeline.js` 的写函数必须自己保证：

1. **链式计数**：`stage[n].output_count === stage[n+1].input_count`（`n = 1..4`，即 filter→tier→assign→place→export）。例外：末阶段 `export` 的 `output_count` 是 **CSV 行数**（不是词数），所以 run 级 `output_count` 单独记。
2. **原子写**：run + 全部 stage 在**一个 `store.tx()` 里**写；不允许出现「有 run 无 stage」或「stage 缺一步」。
3. **失败也要留痕**：某阶段抛错 → 已完成的 stage 照写、出错的 stage 写 `status='failed'`、run 写 `status='failed' + error`，**然后才向上抛**。**静默丢掉一次失败的运行 = 谎报。**

---

## 4. `includeMaster` 之后「合流」的确切语义

### 4.1 同一个词怎么判定（可执行，不留成「以 measured 为准」）

**B05 里同时存在两把尺子，不能混用，也不能"顺手统一"。** `normalizeKeyword` 直接复用 `src/store/kw.js:731`（`String(value ?? '').replace(/\s+/g, ' ').trim()` = 折叠空白 + 去首尾，**不改大小写**）。

| 尺子 | 定义 | 大小写 | 用在哪 | B05 动不动 |
|---|---|---|---|---|
| **写入键** | `(normalizeKeyword(keyword), marketplace.toUpperCase())` | **敏感** | `upsertKeyword`（`queries.js:294`）、`upsertAsinKeyword`（`queries.js:344`）、`upsertMaster`（`kw.js:521` 的 `ON CONFLICT(keyword, marketplace)`）、`getMaster`（`kw.js:639`） | **不动** |
| **合流键** | `(normalizeKeyword(keyword).toLowerCase(), marketplace.toUpperCase())` | **不敏感** | B05 的合流去重（§4.2）、`optimize.js:147/149` 的 `keywords` 入参过滤（现状已是两侧 lower） | **B05 就用这把** |

三条必须写死的判定：

1. **空格**：连续空白折叠成一个，首尾去掉（两把尺子都先过 `normalizeKeyword`）。
2. **站点**：`marketplace` 必须相等（均 `toUpperCase`）。**不同站点 = 不同词，不合流**——美国站的词不该顶掉日本站的同名词。
3. **合流去重后保留哪条的展示形式**：保留 **`measured`** 那条的原样（`asin_keyword.keyword` 的原文），不要改用 `kw_master` 的写法。合流键只用来**判定同一**，不用来**改写展示**。

### 决定 D1（明确采纳的不对称，不是疏漏）

> **写侧大小写敏感、读侧（合流/过滤）大小写不敏感 —— 这是决定，不是漏项。B05 只做读侧，写侧留给 B05.1 根治档。**

**为什么读侧必须 lower（而不是沿用写键）**：写键敏感 ⇒ 库里可能同时存在 `Wireless Mouse`（`asin_keyword`）和 `wireless mouse`（`kw_master`）。合流键若也敏感，这两行就是**两个词**，都会进数据包，「同词以 `measured` 为准」失效——那是**静默重复**。

**为什么 lower 是安全的（不会反过来漏词）**：合流键的等价关系是写入键等价关系的**加粗**（case-sensitive 相等 ⇒ case-insensitive 必然相等）。所以「按写键本来能对上的」**一个都不会漏**；lower 只会**多**并掉大小写变体，不会少并。**反方向**（把合流键改成大小写敏感）才会漏词——这正是本条要挡的事。

**为什么写侧这次不动**：统一写侧要改 3 个 upsert + 新增一步回填 migration（三表 `lower()` + 删重复）+ 决定展示原文怎么留，且会改变已发布数据的语义。这超出 B05 的「编排 + 留痕 + 接缝」范围。见 ARCHITECTURE **§7.1-E4 根治档**（B05.1）。

**给 B06/B07 的话（别来"顺手统一"）**：这个不对称**已知且已采纳**。B06 若也要做读侧合流/去重，**沿用同一把合流键**（lower），不要改成大小写敏感，也不要顺手去改写入键。真要统一，走 B05.1 根治档，一次性做完并同步 §3.1「已落地版本」表。

> **实现要求**：合流键与入参过滤键**必须收进同一个 helper**（建议在 `src/store/kw.js` 的 `normalizeKeyword` 旁加 `mergeKey(keyword, marketplace)`，`optimize.js` 与 `optimize-pipeline.js` 都调它），让两侧不可能各自漂移。**这是唯一允许对 `optimize.js:147/149` 做的改动**——见 T05。

### 4.2 合流规则（按序执行）

```
measured = keywordCoverage(...) 的 rows        // 有 rank/scan_depth，本 ASIN 真测过
untested = keywordCoverage(...) 的 untested    // 老 keyword 表里有、本 ASIN 没测过
master   = queryMaster({marketplace, order:'opportunity', limit})   // 仅当 includeMaster=true

1  先把 measured 全部放进结果，origin='measured'
2  再把 untested 里「key 不在 measured」的放进去，origin='untested'   ← 现状就有，保留
3  若 includeMaster：把 master 里「key 既不在 measured、也不在 untested」的放进去，origin='master'
4  origin='master' / 'untested' 的词：rank / page / scan_depth 一律 **null**（从没测过）
5  origin='measured' 的词：**不得**被 master 的同名词覆盖任何字段
```

**三条硬规则：**

- **`measured` 优先** = `measured` 的字段**逐字段胜出**，不是「整条覆盖」也不是「后来者覆盖」。
- **`master` 只补缺席** = 只在 key 不存在时插入，**永不修改已存在的条目**。
- **上文的 `key` 一律指 §4.1 的「合流键」**（`normalizeKeyword(keyword).toLowerCase()` + `marketplace.toUpperCase()`），**不是**写入键。因此 `asin_keyword` 的 `Wireless Mouse` 与 `kw_master` 的 `wireless mouse` 判为**同一词**：只保留 `measured` 那条、展示形式取 `measured` 的原文，`master` 那条**丢弃**（不进包、不改写字段）。
- **总库词绝不冒充实测排名** = `origin` 非 `measured` 的词，`rank` 必须是 `null`；`package_json` 里 `rank: null` 的语义是「没测过」，**不是「排名 0」**（同「null 是不知道，不是 0」）。

### 4.3 派生值必须带来源（照 B03 的 `severity_hint` + `severity_raw` 配对）

`kw_master` 的 `search_volume` 进数据包时，**必须同时带上 `search_volume_source`**（`kw_master` 本来就有这一列）。页面/报告要显示成「搜索量 1200（来源：ABA）」，**不能只显示 1200** —— 否则「我们的判断」会被读成「亚马逊的口径」。

同理，`origin` 本身就是来源标记：数据包里**每个词都要有 `origin`**，不允许有没有 `origin` 的词（store 层写 `package_json` 时断言）。

---

## 5. 五个阶段：哪些已有、哪些新建

| # | 阶段 | 现状 | 输入类型 | 输出类型 | B05 动作 |
|---|---|---|---|---|---|
| 1 | **筛选** filter | ✅ `queryMaster(store, filters)` | `filters` 对象 | `MasterRow[]`（hydrated） | **直接用**。参数透传 `params_json` |
| 2 | **分层** tier | ✅ `classify.js` 纯函数（`classifySvTier` 等），且 `recomputeMaster` 时已算过 | `MasterRow[]` | 同一批 row（带上 `sv_tier` / `funnel` / `priority` / `opportunity`） | **只做统计**（各 tier 计数），**不重算** |
| 3 | **分派** assign | ✅ `buildKeywordAllocation({keywords, listing, fields, embedding, marketplace})` | 词表 + listing 字段 | 分配结果（词 → 坑位） | **新建调用点**（现在只有 `prepare` 内部调） |
| 4 | **落位** place | ✅ `buildEmbeddingPlan` / `backendCandidates` | 分配结果 | 每字段该写什么词 | **新建调用点** |
| 5 | **出表** export | ✅ `amzn_kw_export` → `buildActiveSets` / `fitBackend` / `buildNegatives` / `toCsv` | 词表 | CSV 文件 + 行数 | **抽成可独立调用的函数**（现在逻辑埋在 tool 的 `execute` 里，见 T03） |

**要新建的只有编排器**（`src/domain/keywords/optimize-pipeline.js`），它做的事是：按序调上面 5 个已有函数、逐步记 `input_count`/`output_count`、把结果交给 store 落库。

> **注意**：第 5 阶段现在**没有可独立调用的入口**——`buildActiveSets` 等是纯函数（可直接调），但「写到哪个目录、文件名怎么起、CSV 怎么落盘」这段逻辑埋在 `kwExportTool.execute` 里（`src/tools/kw.js:415` 之后）。**T03 要把它抽出来**（`src/domain/keywords/export.js` 加 `writeActiveSets(...)`），让 `amzn_kw_export` 和编排器**两条路径调同一个函数** —— 否则又是「同一个事实两处实现」。

---

## 6. 新工具（2 个）

工具名进程内全局唯一；现有 36 个（`grep -rhoP "name: 'amzn_[a-z_]+'" src/tools/ | sort -u | wc -l`），加这 2 个 → **38**。`amzn_kw_pipeline_*` 与现有 6 个 `amzn_kw_*` 不冲突。

输出一律 `{ schema: {}, render: (_args, value) => text(value) }`（与现有工具一致）。

### 6.1 `amzn_kw_pipeline_run`

```js
parameters: {
  type: 'object',
  properties: {
    marketplace:  { type: 'string',  description: '站点代码，默认 US。' },
    productLine:  { type: 'string',  description: '产品线 id；省略 = 该站点全部。' },
    minVolume:    { type: 'number',  description: '只保留搜索量 >= 此值的词。' },
    svTier:       { type: 'string',  description: 'A|B|C|D，见 classify.js SV_TIERS。' },
    opportunity:  { type: 'string',  description: 'high|medium|low。' },
    limit:        { type: 'number',  description: '进入管道的词数上限，默认 2000。' },
    purpose:      { type: 'string',  description: 'all|title|bullets|backend|ads|negatives，默认 all。' },
    outDir:       { type: 'string',  description: 'CSV 输出目录；默认 <plugin data>/exports。' },
    dryRun:       { type: 'boolean', description: '跑完五步但**不写文件、不落 run 行**，只回每步进出数。默认 false。' },
  },
}
```

返回（`render` 成文本）：

```js
{
  ok: true,
  runId,                       // dryRun 时为 null
  marketplace, productLine,
  stages: [                    // 固定 5 项，顺序 = filter/tier/assign/place/export
    { seq, stage, inputCount, outputCount, status }
  ],
  totals: { inputCount, outputCount },
  files: [{ path, rows }],     // 出表产物
  message,                     // 人话摘要，含「另有 N 条因 <原因> 未进入」这类如实说明
}
```

> `dryRun` 必须**真的不落库**：它是「先看一眼再决定」的路径，落了库就等于「预览也算跑过一次」。

### 6.2 `amzn_kw_pipeline_history`

```js
parameters: {
  type: 'object',
  properties: {
    marketplace: { type: 'string' },
    limit:       { type: 'number', description: '返回条数，默认 10。' },
    runId:       { type: 'string', description: '只看这一次运行（含逐步明细）。' },
  },
}
```

返回：最近若干次运行的 `{runId, startedAt, marketplace, productLine, status, inputCount, outputCount}`；带 `runId` 时额外回 `stages[]` 与 `paramsJson`。

---

## 7. 任务列表（有序 · 带依赖 · 粒度到函数）

| # | 任务 | 文件 · 函数 | 依赖 | 规模 |
|---|---|---|---|---|
| **T01** | v14 迁移 | `src/store/schema.js` — 在 `MIGRATIONS` 末追加 `version: 14, name: 'kw-pipeline'`（**只追加，不动 v1–v13**） | — | ~40 行 |
| **T02** | store 层 | **新建** `src/store/pipeline.js` — `recordRun(store, {run, stages})`（单 tx 原子写）、`listRuns(store, filters)`、`getRun(store, id)`、`assertChain(stages)`（链式计数不变式，**在 store 内**断言，不让调用方负责） | T01 | ~120 行 |
| **T03** | 抽出出表函数 | `src/domain/keywords/export.js` — 新增 `writeActiveSets({rows, outDir, purpose})`；`src/tools/kw.js` — `kwExportTool.execute` 改为调它（**行为不变**，现有断言必须仍绿） | — | ~60 行 + 改 ~30 行 |
| **T04** | 编排器 | **新建** `src/domain/keywords/optimize-pipeline.js` — `runPipeline(store, params)`：按序调 `queryMaster` → 统计 tier → `buildKeywordAllocation` → `buildEmbeddingPlan`/`backendCandidates` → `writeActiveSets`，逐步收集 `input/output`，最后调 `recordRun` | T02, T03 | ~180 行 |
| **T05** | 合流接缝 | `src/tools/optimize.js` — `keywordSetFor(store, asin, marketplace, limit, {includeMaster})` 加第 5 参；`optimizePrepareTool` 的 `parameters` 加 `includeMaster`（boolean，默认 **false**）；`package_json` 每词加 `origin` + `search_volume_source`；合流键与入参过滤键收进同一个 helper `mergeKey()`（见 §4.1 决定 D1） | — | ~55 行 |
| **T06** | 两个工具 | `src/tools/kw.js` — 新增 `kwPipelineRunTool({store, dataDir})`、`kwPipelineHistoryTool({store})`（**并入 kw.js，不新建 tools/pipeline.js**） | T04 | ~150 行 |
| **T07** | 注册 | `src/tools/index.js` — `buildTools` 里加 `kwPipelineRunTool(deps)`、`kwPipelineHistoryTool(deps)`；`index.js` — `TOOLS` 数组加 `'amzn_kw_pipeline_run'`、`'amzn_kw_pipeline_history'`（**两处都要加，漏一处 = 工具不可用且不报错**） | T06 | ~6 行 |
| **T08** | 页面 | `src/web/page.js` — 新增 `renderPipeline()`（画最近运行 + 每步进出数），加进 `RICH_PANELS` 与 `PANEL_RENDERERS`；`src/web/routes.js` — `buildState` 的 kw 切片加 `pipeline` 字段（调 `listRuns`） | T02 | ~90 行 + ~20 行 |
| **T09** | 测试 | `tests/` — 新增 `kw-pipeline.mjs`（合流 + 链式计数 + dryRun 不落库 + 失败留痕），并入 `tests/run.mjs` | T02–T07 | ~150 行 |

**并行建议**：T01→T02 与 T03 可并行；T05 与 T01–T04 完全独立，可并行；T06 必须等 T04；T07 等 T06；T08 等 T02。

> ### ⚠️ T05 的禁区：`src/tools/optimize.js:147 / :149` 不许改成大小写敏感
>
> 现状是**两侧都 `.toLowerCase()`**：
>
> ```js
> // :147 建集合
> new Set(args.keywords.map(item => String(item).replace(/\s+/g, ' ').trim().toLowerCase()))
> // :149 过滤
> all.filter(row => wanted.has(row.keyword.toLowerCase()))
> ```
>
> **不要用 `normalizeKeyword` 替换这里的 `.toLowerCase()`。** `normalizeKeyword` 是 trim + 折叠空白、**保留大小写**；换上去等于把一处大小写不敏感的匹配改成大小写敏感 —— 库里存 `Wireless Mouse`、调用方传 `wireless mouse` 就从「能匹配」变成**静默丢词**，比现状更糟。
>
> **只允许做一件事**：把两侧的归一化收进**同一个 helper**（`mergeKey()`，见 §4.1），让过滤键与合流键同构、不可能各自漂移。理由一句话：**过滤键必须与合流键同构，而合流键是 lower 的**。
>
> 改完之后，两侧仍然都必须是 lower。验收见 §8 第 9 条。

---

## 8. 验收标准（可证伪；数字一律带出处）

> 遵守 ARCHITECTURE §16：**出现数字就必须同时给出这个数字的来由**，不写裸数。

1. **【保留原文这条，它已经够好】** 一个只存在于 `kw_master`、不在 `asin_keyword` 也不在 `keyword` 里的词：`includeMaster=true` 时**出现在数据包**且 `origin='master'`，`false` 时**不出现**。判据 = 造一个三词库（一个只在 measured、一个只在 master、一个两路都有），逐词断言 `origin`。
2. **`master` 不改写 `measured`**：同一个词两路都有时，数据包的 `rank` / `tier` / `scan_depth` 与**不加 `includeMaster` 时**逐字段相等。判据 = 同一 ASIN 跑两次（`false` / `true`），只对共有词做字段比对。
3. **`origin` 非 `measured` 的词 `rank` 必为 `null`**：断言「不存在 `origin !== 'measured' && rank !== null` 的词」。判据 = 遍历数据包，命中即失败。
4. **每个词都有 `origin`**：断言「数据包里 `origin` 为空/undefined 的词数 = 0」。判据 = 计数为 0（不是「看起来都有」）。
5. **链式计数**：一次成功运行后，`kw_pipeline_stage` 恰好 5 行，且 `stage[n].output_count === stage[n+1].input_count`（`n=1..4`）。判据 = 5 行（= 五个阶段，见 §5 表）与 4 条等式。
6. **`dryRun` 不落库**：`dryRun=true` 跑完后 `SELECT COUNT(*) FROM kw_pipeline_run` 与跑前**相等**。判据 = 前后计数相等。
7. **失败留痕**：让第 3 阶段抛错（注入一个坏 listing）→ `kw_pipeline_run.status='failed'`、`error` 非空、且**已完成的 2 个 stage 有行**、出错的 stage `status='failed'`。判据 = 2 行 done + 1 行 failed + run.status='failed'。
8. **导出路径单一**：`amzn_kw_export` 与 `amzn_kw_pipeline_run` 对同一批词产出的 CSV **逐字节相同**。判据 = 快照比对（照 B04 的 `tests/make-prompt-snapshot.mjs` 那个做法）。
9. **入参过滤大小写不敏感 —— 回归护栏**（不是修 bug）：库里存 `Bluetooth Speaker`，`prepare({ keywords: ['BlueTooth Speaker'] })` 的数据包**包含**该词（大小写不一致的输入仍能匹配到库里的词）。
   **⚠️ 这条现在就是绿的，它存在的意义是挡住将来的回归，不是发现当下的缺陷** —— 现状 `:147`/`:149` 两侧都 lower，本来就匹配得上（见 §2-E4 的更正）。
   **判据（必须可证伪）**：**抽掉任意一侧的 `.toLowerCase()`，第 9 条断言必须变红**。做法：补一条**变异测试**（temporary mutation）—— 分别把 `:147` 的 lower 去掉、把 `:149` 的 lower 去掉，两次都应导致断言失败；恢复后再跑一次应为绿。三次结果写进测试输出。
   **不许写成「断言非空 / 断言包含」就完事** —— 那和 B04 那次「按 id 预览只判非空」是同一类东西：**永远不会失败的断言会被算进覆盖率，比没有断言更糟。**
10. **工具可发现**：跑完 T07 后，`index.js` 的 `TOOLS` 与 `src/tools/index.js` 的 `buildTools` **两处**都含这两个新名。判据 = 静态断言（照 B02a 给 `validateDraft` 加的那条护栏）。

**工具数**：36 → **38**（36 = 当前去重计数，见 §6；38 = 36 + 本批 2 个）。**断言数**：376 → 预计 +15 条左右（**这是估算，不是判据**；判据 = 上表 10 条全绿且 `node tests/run.mjs` 退出码 0）。

---

## 9. 约束与已知坑

- **零第三方依赖**；SQLite 走内置 `node:sqlite`。
- **迁移只追加**：v14 追加到 `MIGRATIONS` 末尾，**绝不回改 v1–v13**（B03 的 v12 就是先例：改已发布的步骤会让已升到该版本的库永远拿不到新列且不报错）。
- **`src/web/page.js` 是一个大模板字符串**（第 38 行 `` return `<!doctype html> `` … 第 1695 行 `` </html>` ``）：
  - **反引号只能出现在 `${ … }` 内的 JS 表达式里**（现有第 291 行就是这么做的，合法）；
  - **不能**出现在 HTML 文案、注释、正则字面量里 —— 那才是会 SyntaxError 拉垮整个 host 的写法。工程师踩过两次。
- **派生值必须带来源**：`search_volume` 带 `search_volume_source`；`origin` 每个词都要有。
- **不变式加在 store**（`src/store/pipeline.js`）而不是工具里。
- **两把尺子不许混用**：写入键（大小写敏感）与合流键（lower）各有各的用途，见 §4.1 决定 D1。合流键与入参过滤键必须**同一个 helper**（`mergeKey()`），**且两侧都保持 lower** —— 改成大小写敏感 = 静默丢词。
- **工具注册两处**：`index.js` 的 `TOOLS` + `src/tools/index.js` 的 `buildTools`，漏一处 = 工具存在但不可调用，且不报错。
- **不谎报**：管道输出要说清「按当时的库与这些参数算出」；`rank: null` 是「没测过」，不是 0。

---

## 10. 落地后需回写 ARCHITECTURE.md 的位置

1. **§3.1** —— 「已落地版本」表加 v14；计划表若再有追加则同步后移（v15 起）。
2. **§3.6** —— `kw_pipeline_run` 改成「run + stage 两张表」（见 §3.2）；SQL 注释 `-- v14`。
3. **§6 B05** —— 「改哪些文件」改成真实清单（`optimize-pipeline.js` 新建、`pipeline.js` 不动、工具并入 `kw.js`）；补 §8 的 10 条验收。
4. **§12.2** —— 时序图补 `includeMaster` 分支与 `origin` 标记（现有图已画对主干，只需补「未命中时如实报」那条）。
5. **§13** —— 状态列整体刷新（E3）；`pipeline.js` 那行改成新建（E1）。
6. **§6 B04** —— 「7 套」改 **13 module（12 业务 + 1 `common`）/ 44 行（`button` 41 + `assemble` 3）**（E2）。已回写。
7. **§7.1（新增）** —— E4 的逐处核对表 + 两档工单。**合流键一律用 lower 那把**，与本文 §4.1 决定 D1 一致；ARCHITECTURE §7.1 的「最小档」即本文 T05。
