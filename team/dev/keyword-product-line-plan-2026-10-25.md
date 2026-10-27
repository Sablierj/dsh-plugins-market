# 方案：关键词的**产品线归属**决策层（v69）— F-5 的 B 半

状态：**方案 + SQL 草案，未落库**（`src/store/schema.js` 等 lead 批）。
作者：dev-12 · 2026-10-25 · 对应走查 `team/dev/operator-walkthrough-1-2026-10-25.md` F-5。

---

## 一、先回答 lead 的问题：关键词的产品线归属存在哪儿？

**存在，但存在的那三列没有一列是可写的。**

`kw_master` 上确实有产品线相关的列：

| 列 | 含义 | 谁写 |
| --- | --- | --- |
| `product_line` | 单一标签（多命中时按 `PRODUCT_LINE_ORDER` 优先级仲裁） | `recomputeMaster` → `composeMaster` |
| `product_line_matched` | 命中的信号词；**NULL = 没有信号命中** | 同上 |
| `product_lines_json` | 全部命中的产品线（多标签） | 同上 |

三列都是 `detectProductLine`（`src/domain/keywords/classify.js`）对
facts + `product_line.signals_json` 的**派生值**，由 `recomputeMaster`
（`src/store/kw.js` 的 `UPSERT_MASTER_SQL`）在**每一次导入**时整层重算，
`ON CONFLICT DO UPDATE SET <每一列> = excluded.<列>` —— 一个列都不放过，
唯一豁免的是 `first_seen_at`（它是历史，不是事实的函数）。

**这不是推断，是实证**（`tests/t77-keyword-bulk.mjs` ⑦ 号断言）：

```
把 kw_master.product_line 手工改成 'rocker-cushion' → 读回来是 'rocker-cushion'（看着生效了）
recomputeMaster(store)                             → 读回来又是派生值（手工值静默消失）
```

没有报错、没有提示、页面照常显示。**运营会以为系统丢了他们的工作。**
这与「生命周期状态不能放 kw_master」是同一个结构性理由（`keyword_lifecycle`
独立成表就是那次结论，v33），所以这一半也**不能硬造**。

其它可能的位置，逐个排掉：

- `keyword` 表（按 ASIN 关联的旧词表）**没有** product_line 列。
- 关键词侧**没有** `asin_ownership` 那样的决策表（那是 ASIN → 产品线/品牌/店铺/站点）。
- `product_line` 表是**产品线本身**（id / name / signals / workspace / version），不是「哪个词属于哪条线」。

**实库现状（2026-10-25，US，分母 30,778）：**

| product_line（派生） | 条数 |
| --- | --- |
| bench-cushion（默认线） | 17,978 |
| rocker-cushion | 10,426 |
| chair-cushion | 1,957 |
| flower-edge-cushion | 416 |
| jiuzhendian | 1 |

`product_line_matched IS NULL`（**页面「产品线未分类」那一格的真实口径**）= **3,386 条**。
也就是说 bench-cushion 的 17,978 里，有 3,386 条**不是**「被判成长凳垫」，
而是**「没有任何信号命中，于是落到了默认线」**。
这 3,386 正是本题要被人决定的那批词 —— 今天它们没有任何表达方式，
因为它们和「真的属于长凳垫」共用同一个显示值。

---

## 二、方案：决策层单独成表，与 `keyword_lifecycle` 同构

**核心决定：`kw_master.product_line` 的语义从此写死为「派生值」，不是「归属」。**
归属 = `hand ?? derived`，其中 `hand` 来自新表。谁也不许把派生值当决策依据读
（展示可以，且必须标「自动」，见第四节）。

### 2.1 两张表（v69，SQL 草案见第三节）

`keyword_product_line` —— **当前**的人的决定，一词一行：

- `keyword`, `marketplace`（主键，与 `keyword_lifecycle` 同口径：不同站点同拼写不是同一个业务词）
- `product_line_id`（可空：**NULL = 人工撤销了归属，回到派生值**。撤销是一件人的决定，
  需要行和事件来记住「有人撤过」，所以**不删行**）
- `source`（闭集，第一期只有 `manual`）
- `reason`, `evidence_json`, `changed_by`, `changed_at`, `created_at`

`keyword_product_line_event` —— **追加，永不修改、永不删除**：

- `from_product_line_id → to_product_line_id`（NULL 表示「无人工归属」）
- `source`, `reason`, `evidence_json`, `by`, `at`

与 `keyword_lifecycle_event` 同构，理由也是同一个：**「为什么这个词现在是这条线」
三个月后只能靠事件表回答**。

### 2.2 迁移**不回填**

迁移只建表，不写任何业务行。明确拒绝这个看起来贴心的做法：

```sql
-- ❌ 不要：INSERT INTO keyword_product_line SELECT keyword, marketplace, product_line, 'manual' …
```

它会把**今天分类器的输出**盖章成 30,778 条**人的决定**，而没有人做过这个决定。
三个后果，每一个都是本仓铁律的反面：

1. **伪造决定**：机器猜的归属被记成人工归属，以后再也分不出哪条是人定的。
2. **冻结分类器**：今天的 `product_line` 从此变成人工值，信号词以后改进也不会再生效。
3. **让「未分类」永久不可见**：3,386 条会被记成「已人工归属到 bench-cushion」，
   与「真的属于长凳垫」再也无法区分 —— 正是现在这个 bug 的加强版。

需要「把当前派生值确认为人工值」时，走**显式的人工动作**（页面/工具，带 by + reason），
不是迁移。

### 2.3 读口（一份实现）

新增 `src/store/keyword-product-line.js`，导出：

```
effectiveProductLine(store, { keyword, marketplace })
  → { value, source: 'manual' | 'derived' | 'unclassified',
      matched, productLines, manual: { by, reason, changedAt } | null }
```

判定（**只有这一处**，页面与工具都读它）：

| 条件 | value | source |
| --- | --- | --- |
| 有 manual 行且 `product_line_id` 非空 | `product_line_id` | `manual` |
| 无 manual 行（或已撤销）且 `product_line_matched` 非空 | `kw_master.product_line` | `derived` |
| 无 manual 行（或已撤销）且 `product_line_matched` 为 NULL | `kw_master.product_line`（默认线） | `unclassified` |

第四种「读不到」的情况单独说：词不在 `kw_master` → 返回 `null` 并说明，
**不返回 `unclassified`**（「这不是总库里的词」与「这个词没分类」是两件事）。

### 2.4 计数口径（必须同一处改）

`masterStats` 今天有 `productLineDefaulted = COUNT(product_line_matched IS NULL)`。
落表后这个数**含义变了**（它会把已人工归属的词也算进未分类），所以必须改：

- `productLineManual` = 有 manual 行的条数（新）
- `productLineDerived` = 无 manual 且 matched 非空（新）
- `productLineDefaulted` = 无 manual 且 matched 为 NULL（**重定义**，页面文案同步改）

页面上三格并排，**分母都是该站点的总库条数**。今天的 3,386 与迁移后的
`productLineDefaulted` 应当是同一个数（迁移不写行，所以不会变）——
这一点要作为验收：**迁移前后该数字必须相等**，不等就是回填了。

### 2.5 筛选

`queryMaster({ productLine })` 今天过滤 `m.product_line = ?`（派生）。
落表后必须按**生效值**过滤：`COALESCE(manual.product_line_id, m.product_line) = ?`
（`LEFT JOIN keyword_product_line`）。

代价要如实说：`COALESCE` 用不上 `idx_kw_master_mkt_line_vol_keyword`，
会退化成扫描 + 排序。US 30,778 行的现状下是可接受的（页面每次渲染已经在算
`masterStats` 的几个全表聚合），但**必须实测** `EXPLAIN QUERY PLAN` 并写进批次报告；
若实测不可接受，备选是「派生命中」与「人工命中」两段 UNION（各自可用索引），
以复杂度换索引 —— 到那时再定，不在方案里提前承诺。

### 2.6 工具与页面（落地那批）

- `amzn_keyword_product_line_batch_set`（与 A 的批量同形）：
  all-or-nothing、≤500、强制 `by`/`reason`、可按筛选选、`dryRun` 预览；
  `product_line_id` 必须在 `product_line` 表里（未知 id 整批拒并**列出**，
  因为写一个不存在的线会让归属查询返回空而不是报错）。
- 页面：总库大表「产品线」列 → `值 + 来源徽标`（人工 / 自动 / 未分类），
  `title` 里带 by/reason/time（人工）或「无信号命中，暂落默认线 bench-cushion」（未分类）。
  批量条放在生命周期条旁边，同一套「勾选 → 预览 → 确认」。
- 测试 `tests/t78-keyword-product-line.mjs`，与 t77 同形，至少包含：
  ① 设人工值 → `recomputeMaster` → 人工值还在（照 b08 ① 的做法，这是核心）；
  ② 未知 product_line_id 整批拒；③ 超 500 拒；④ 撤销后回到派生值且事件留痕；
  ⑤ 未分类词设人工值后 `source` 从 unclassified 变 manual；⑥ 迁移前后
  `productLineDefaulted` 相等（不填 = 不回填）。

---

## 三、v69 迁移 SQL 草案（请批）

落地时追加到 `src/store/schema.js` 的 `MIGRATIONS` 数组末尾（v68 之后），
`SCHEMA_VERSION` 自动跟着走（它由数组末项派生）。

```js
  /* ── v69：关键词的产品线**归属**决策层（F-5 的 B 半）─────────────────────────
     为什么要单独一张表：`kw_master.product_line` / `product_line_matched` /
     `product_lines_json` 都是 `recomputeMaster` 对 facts 的**派生值**，每次导入
     `ON CONFLICT DO UPDATE SET <每一列> = excluded.<列>` 整层重写 —— 往那三列写
     人工值会在下一次导入**静默消失**（`tests/t77-keyword-bulk.mjs` ⑦ 号断言是
     这个事实的实证）。这与 v33 把生命周期状态独立成 `keyword_lifecycle` 是同一个
     结构性理由，所以这里照同一套形状做：当前值一张表 + 追加事件一张表。

     口径（读端必须一起读，见 docs 方案 team/dev/keyword-product-line-plan-2026-10-25.md）：
       · 生效值 = 人工值（本表 product_line_id 非空）> 派生值（kw_master）；
       · product_line_id 为 NULL 且存在本表行 = **人工撤销了归属**，回到派生值 ——
         撤销是人的决定，所以不删行；
       · 本表没有行 = 没人决定过，不是「决定为默认线」。
     迁移**不回填**：只建表，不把今天的派生值盖章成人工决定。

     回滚：DROP TABLE keyword_product_line_event; DROP TABLE keyword_product_line;
     （两张新表纯新增，不动存量任何列；回滚只需删表，既有数据不受影响。） */
  {
    version: 69,
    name: 'keyword-product-line-decision',
    sql: `
CREATE TABLE keyword_product_line (
  keyword          TEXT NOT NULL,
  marketplace      TEXT NOT NULL,
  /* NULL = 人工撤销归属，回到派生值。不是「没读到」—— 没读到是本表没有行。 */
  product_line_id  TEXT REFERENCES product_line(id),
  source           TEXT NOT NULL,
  reason           TEXT,
  evidence_json    TEXT,
  changed_at       TEXT NOT NULL,
  changed_by       TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (keyword, marketplace)
);

CREATE TABLE keyword_product_line_event (
  id                    TEXT PRIMARY KEY,
  keyword               TEXT NOT NULL,
  marketplace           TEXT NOT NULL,
  /* NULL 表示「无人工归属」（首次设定时 from 为 NULL；撤销时 to 为 NULL）。 */
  from_product_line_id  TEXT,
  to_product_line_id    TEXT,
  source                TEXT NOT NULL,
  reason                TEXT,
  evidence_json         TEXT,
  at                    TEXT NOT NULL,
  by                    TEXT
);

/* 反查「这个词的归属历史」用主键即可；这条是给「最近谁改了什么」那一类读用的。 */
CREATE INDEX idx_kwpline_ev_at ON keyword_product_line_event (marketplace, at DESC);
CREATE INDEX idx_kwpline_line ON keyword_product_line (product_line_id);
`,
  },
```

点数（供 lead 快速核）：

- 新增 2 表 + 2 索引；**0 个 ALTER、0 个 UPDATE/INSERT、0 个 DROP**。
- 不改 `kw_master`、不改 `classify.js`、不改 `recomputeMaster`。
- 迁移本身不产生任何业务行 → 迁移前后 `productLineDefaulted`（3,386）必须相等。

---

## 四、显示口径（lead 明确要求：必须能看出人工还是自动）

| source | 页面显示 | 说明 |
| --- | --- | --- |
| `manual` | `长凳垫 · 人工` + `title` = 「by / reason / 时间」 | 人的决定，优先于派生 |
| `derived` | `摇椅垫 · 自动` + `title` = 「信号命中：rocker」 | 机器推导，可被信号变更改变 |
| `unclassified` | `未分类（暂无信号）· 自动` + `title` = 「暂落默认线 bench-cushion」 | **不是**「属于长凳垫」 |

**为什么必须标**：不标来源，就等于把人的决定和机器的猜测混成一个数 ——
运营看到一个「长凳垫」，无法知道这是谁定的、会不会被下一次导入改掉。

多命中的诚实表达：`product_lines_json` 有多条时，派生侧的单一标签本身就是一次
**仲裁**（按 `PRODUCT_LINE_ORDER` 优先级）。页面在 `title` 里列出全部命中，
人工值则**终结这个歧义**（这是这张表的第二个价值，不只是「改一个字段」）。

---

## 五、风险与待确认

1. **派生列的老用法**：`masterStats.byProductLine`、`kw_master.product_line` 的索引、
   报表里的产品线分组，现在都读派生值。落表后**只有「归属」类问题**改读生效值；
   「这个词被分类器判成了什么」仍读派生值 —— 两者不能混，混了就又回到今天这个 bug。
2. **性能**：筛选改 `COALESCE` 会失去索引（第 2.5 节），需实测后再定实现。
3. **撤销语义**：`product_line_id` 为 NULL 的行是「撤销」而不是「缺失」。任何读端
   若用 `WHERE product_line_id IS NOT NULL` 当「有行=有人工值」，必须同时看 `source`。
   方案里 `effectiveProductLine` 是唯一读口，就是为了不让每个调用方各写一遍这个判断。
4. **不在本方案内**：ASIN 侧的产品线归属（`asin_ownership` / `asin.product_line_id`）
   不动；`product_line.signals_json` 的编辑不动；不回填。

---

## 六、A（批量生命周期）与本方案的关系

A 已交付：`amzn_keyword_lifecycle_batch_set`（all-or-nothing、≤500、强制 by/reason、
可按筛选选、选区写进事件行）。B 落地时，`keyword-product-line.js` 直接复用同一套
校验骨架与「一个事务写 N 条事件」的形状，**不新造一套批量语义** ——
两处批量若各写一套，第一个分叉会出现在「同态」「上限」这类最不该分叉的地方。
