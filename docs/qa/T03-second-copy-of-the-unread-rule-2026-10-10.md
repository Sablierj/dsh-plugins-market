# T-03 的一处未完成：页面对「子体没读到」有**第二份判据**

> 状态：**待修（缺陷已定死，修法已定）**。作者：主理人，2026-10-10。
> 现场：`D:\deepseek-harness-h\workspace\wt-dsh-readtrap`（分支 `dsh-readtrap`，提交 `46ec480`，**未并入 main**）。

## 现状（实测）

T-03 的现场**已全绿**：`node tests/run.mjs` = **1511 passed / 0 failed**（主理人复跑确认）。
它新增的是：

- `src/domain/asin/sections.js`：`SECTION_CONTENT_UNREAD_LABEL = '没读到（不是页面没有）'`（:95）
  与 `sectionContentUnread(entry)`（:104）—— 纯函数，从**行上已有的信号**判「看见了却没读出来」：
  `errors_json` 带 `VARIATION_CHILDREN_UNREAD`，或 `parsed_value` 的 `child_tiles > 0` 且 `children: []`。
- `buildSectionView` 给每一行算好 `contentUnread`（:203），随载荷传下去。
- `src/tools/asin.js` 与 `src/web/page.js` 各自印同一枚标记。
- 两条断言：`B05P-③c`（工具侧）、`B05W-⑤c`（页面侧）。

## 一、发现过程（证伪只打红了一半）

主理人做 T-03 缺的那一步证伪：把 `sectionContentUnread` 改成**恒返 `false`**，跑全量：

```
FAIL B05P-③c 「没读到」判据从行上已有的信号重算：child_tiles>0 且 children:[] 才亮，工具印同一份措辞
1510 passed, 1 failed
```

**只有工具侧那条红了。页面侧 `B05W-⑤c` 保持绿。** 这不是断言坏了，是它**考的不是同一个东西**：

`src/web/page.js:1082` 的 `sectionContentUnreadMark(entry)`：
（**Node 行号**；这份文件是纯 LF，PowerShell 的 `Get-Content` 行号会偏，本会话已记过这个坑）

```js
function sectionContentUnreadMark(entry) {
  if (entry === null || typeof entry !== 'object' || entry.notCollected === true) return '';
  let unread = entry.contentUnread === true;      // ← 服务端算好的那一份
  if (unread !== true) {                          // ← 取不到就【自己重算一遍】
    const errors = Array.isArray(entry.errors) ? entry.errors : [];
    for (const error of errors) {
      if (error?.code === 'VARIATION_CHILDREN_UNREAD') { unread = true; break; }
    }
    if (unread !== true) {
      const parsed = entry.parsedValue;
      unread = Array.isArray(parsed?.children) && parsed.children.length === 0
        && Number.isFinite(parsed?.child_tiles) && parsed.child_tiles > 0;
    }
  }
  ...
}
```

把域层改坏 → `contentUnread` 变 `false` → 页面**回退到自己的第二份实现** → 而 `errors` 里那个信号还在
→ **页面照样印出标记 → 断言照样绿**。**两份实现分歧了，没有任何东西失败。**

## 二、这不是「多余的 fallback」，它有真实的第二个调用点

页面重算的**理由写在自己的注释里**（`page.js:1077-1081`）：

> ASIN 详情区用 `buildSectionView` 算好的 `contentUnread`；**采集面板的 13 节走 B-04 的载荷，
> 上面没有这个布尔**，就从行上已有的 signals 按同一份判据当场重算 —— 两边用的是同一份信号，
> 不是页面新造的第二份。

**所以真实情况是「一条规则、两份实现」**：域层一份（`sectionContentUnread`），页面一份（内联重写）。
注释说「两边用的是同一份信号」，这句**是真的**（信号确实同源）；
但**判据本身抄了两遍** —— 域层将来多认一个信号（例如新增一个错误码），
页面那一份**不会跟着变**，于是同一行在工具里被标记、在页面上不被标记，**而没有任何断言会红**。

**这正是本仓的签名缺陷形态**，而且与 `page.js:63` 自己写下的那条先例正面冲突：

> The wording does not live here: it is `COLLECTION_TASK_STATUS_LABELS`, merged in below.
> Keeping the two apart is the point of the injection —— **a state whose label the page guessed
> would show a different word from the one the tool prints for the same row, and nothing would fail.**

同一份文件、同一种风险，一处用「服务端注入」防住了，另一处**又抄了一遍**。

## 三、修法（按本仓自己的idiom，两个方案选一）

### 方案 A（推荐）：让采集面板的载荷也带 `contentUnread`，页面不再重算

1. 在 B-04 那条「采集面板 13 节」载荷的构建处，用 **`sectionContentUnread`**（同一份域层函数）
   给每一节算好 `contentUnread` 并落进载荷。
2. 把 `page.js` 的 `sectionContentUnreadMark` 收成**只读 `entry.contentUnread`**，删掉内联重算。
3. 于是「一条规则」真的只剩一份；把域层改坏 → **工具侧与页面侧两条断言同时变红**（可证伪）。

**收益**：`B05W-⑤c` 从「考页面能不能自己算」变成「考页面印的是不是服务端算的那一份」——
**这才是它声称在考的东西**。

### 方案 B：保留两份实现，但加一条**一致性断言**

加一条 meta 断言：对**同一组夹具行**，`sectionContentUnread(entry)` 与页面的第二份实现**必须同真同假**。
**收益**：分歧会红。**代价**：两份实现依然存在，需要靠断言盯着 —— 不如 A 干净。

## 四、验收（无论选哪个方案）

1. `node tests/run.mjs` 全绿，断言数 ≥ **1511**（**只增不减**，不钉绝对数字）。
2. **证伪必须打红两侧**：把 `sectionContentUnread` 改成恒返 `false` →
   **`B05P-③c` 与 `B05W-⑤c` 两条都变红** → 改回全绿。**真跑，贴原文。**
   （现状是只红一条 —— 这就是本文件存在的理由。）
3. `node scripts/check-page.mjs` 3/3（动 `page.js` 后必跑）。
4. **不改五态的语义**（`partial` 仍然是「采到一部分」）；改的是**呈现**。

## 五、为什么记在这里而不是直接改

现场已全绿（1511），**这份工作离「可并入」只差这一处**；
但「让页面不再有第二份判据」要动**采集面板的载荷构建**（`src/domain/collect/**`），
而那一片与 T-01（`src/sources/collection.js` + `src/store/queries.js`）在同一轮并行，
**我不在同一棵树上同时动两片**。所以：**先把缺陷定死并落盘，再按一次一个写者的纪律推进。**
