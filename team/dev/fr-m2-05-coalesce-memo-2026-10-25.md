# FR-M2-05 开工前：`COALESCE` 吞掉人工决定 —— 最小复现与三个缺陷

- 日期：2026-10-25 · dev-10 · 基线 `2e18d17`
- 复现脚本（可跑）：**`node team/dev/fr-m2-05-coalesce-repro.mjs`**（临时库，跑完自删，不碰真库）
- 结论一句话：**人工决定被静默覆盖，而且留下的痕迹是"与事实相反"的那种** —— 下面三条都要进 FR-M2-05 的范围。

---

## 一、复现（实测输出，不是推断）

```
① 采集落库      adopted = "line-a" · 来源 = [browser-local="line-a"(collect)] · 冲突行 = 无
② 人工改完      adopted = "line-b" · 来源 = [browser-local="line-a"(collect), manual="line-b"(manual)]
   注意：此时系统**自己开了一条冲突行**（人工值 vs 采集值）：
   status=open · adopted_value=null · 建议来源=manual("line-b")

③ 再 upsert 一次（product_line_id: line-a）
   adopted = "line-a"    ← 人工值 line-b 从采用值里消失了
   来源    = [browser-local="line-a"(collect), manual="line-b"(manual)]
   ★ 人工值被吞              = true
   ★ audit_log 增量          = 0        ← 这次覆盖没有审计痕迹
   ★ 冲突行还在，且**仍显示待裁决**：
       status = open · adopted_value = null · resolved_at = null
       建议仍是 byPriority = manual("line-b")
       ← 页面上会同时看到「采用值 line-a」与「建议 line-b · 待裁决」

④ 反面控制      人工再改回 line-b，然后 upsert **不带** product_line_id → adopted = "line-b"
```

（② 那条冲突行不是谁手动开的：`correctAsinField` → `upsertFieldSource` → `refreshConflictsFor`
（`src/store/field-source.js:143-146`）**在写来源行的同一处**顺手检测。这一点很重要，
它说明"冲突"这件事本来就有机器化的痕迹通道 —— 缺的不是通道，是**覆盖时走不走那条通道**。）

调用的写法与生产一致：`upsertAsin(store, record)`，来源在 `record.sourceId`（`src/tools/asin.js:543` 就这么传）。
人工通道用的是仓里唯一那条：`correctAsinField`（`src/store/asin.js:82`）。

---

## 二、三个缺陷（按严重度）

### 2.1 覆盖本身：`upsertAsin` 的 COALESCE 会无条件吃掉已有值

`src/store/queries.js:227`：

```js
ON CONFLICT(asin, marketplace) DO UPDATE SET
  ${ASIN_FIELDS.map(field => `${field} = COALESCE(excluded.${field}, asin.${field})`).join(',\n  ')},
```

`product_line_id` 在 `ASIN_LISTING_FIELDS` 里（`src/domain/asin/table.js:57-60`），所以它走这同一条 COALESCE：
**只要这次 upsert 带了这一格，库里的人工值就被换掉**，不看有没有 manual 来源、不看冲突有没有裁决。

覆盖面比 FR-M2-05 更大：这不是「产品线」一列的事，是**全部 10 个事实字段**的共同行为
（title / brand / price / currency / bsr / category / rating / reviews / image_url / product_line_id）。

### 2.2 更糟的一条：痕迹留下了，但**与事实相反**

`② 人工改完` 那一刻，`correctAsinField` → `upsertFieldSource` → `refreshConflictsFor`
（`src/store/field-source.js:146`）**已经开了一条冲突行**。`③` 之后它的全貌是：

```
status          = open            ← 覆盖之后仍然"待裁决"
adopted_value   = null            ← 从来没被裁决过
suggestion_json = { byPriority: { value: "line-b", sourceId: "manual", reason: "…manual 在优先级里最高" },
                    byFreshness: { value: "line-a", sourceId: "browser-local", … },
                    note: "两条建议不一致：按置信度指向 line-b（manual），按新鲜度指向 line-a（browser-local）—— 这正是需要人来裁决的原因" }
```

而 `adopted 现在 = "line-a"`。

也就是说页面上会同时出现：**采用值 = line-a**、**系统建议 = line-b**、**状态 = 待裁决**。
读起来是「还没人决定」，而事实是「有人决定了，被一次采集静默推翻」。
**这比完全没痕更坏** —— 它把"已经被推翻的人工决定"显示成"还没做的决定"。

### 2.3 审计：0 行

`audit_log` 在 ③ 前后**增量为 0**。`upsertAsin` 不在审计通道里（`domain/audit/targets.js` 的
`PAGE_WRITE_TARGETS` / `WRITE_TARGETS` 都只覆盖页面与工具的动作），所以「谁把这条改回去了」查不到。
FR-M2-05 的第 ③ 件要求「页面写和工具写落同一种审计行」—— 那么**覆盖也是写**，也该有一行。

---

## 三、我的建议：本单做 B，C 单独报你拍

| 方案 | 做什么 | 满足 FR-M2-05？ | 风险 |
|---|---|---|---|
| **A 只页面层挡** | 行内改走 `correctAsinField` + 审计行；不碰 `upsertAsin` | ❌ 挡不住 ③：agent 调 `amzn_asin_upsert`、分类器应用路径照样吞 | 最低 |
| **B 覆盖前留痕**（**建议本单做**） | 在 `upsertAsin` 里，覆盖前读一次该字段的 live manual 来源；值不同 → `recordAudit` 一条（before / after / 被覆盖的 manual 值 / sourceId），并保持 `field_conflict` 的语义一致（覆盖后把该冲突标成「人工值已被覆盖」或重开，别停在"待裁决"） | ✅ 第 ③ 件（留痕）成立；**不动覆盖语义** | 低：一次 per-field 读 + 一条审计 |
| **C 让步于人工值** | 有 live manual 来源时 `COALESCE` 不让步：保留 `asin.<field>`，采集值只更新来源行 | ✅ 最强 | **高**：改的是「采集以最新为准」这条既有期待，影响全部 10 个字段与所有写入路径 —— 这是产品决定，不该我拍 |

**为什么 A 不够**：FR-M2-05 的原文要求「每次改动留审计」，而 ③ 这次覆盖**也是一次改动**。
只在页面层守，等于承认「页面守规矩、别的路径不守」—— 那正是本批一直在杀的那种形状。

**为什么 C 不该顺手做**：它会让「重采一次把价格更新过来」变成「人工改过的价格从此不再更新」。
这对 `price` / `bsr` 是对的还是错的，得产品说了算；我不在你批之前动它。

---

## 四、FR-M2-05 的实现形状（B 成立时我打算这么写，你批了再动）

1. **点格编辑**：ASIN 表的「自有/竞品归属」「产品线归属」两列可点 → 就地出小编辑框；
2. **影响面前置**：点开编辑框时先拉一次影响面，且**空也要说「没有」**：
   - 归属列：`asin_ownership` 的 live 边数、被哪些竞品组/关键词所有权引用（反查 `asin_competitor`、`keyword_ownership`）；
   - 产品线列：`product_profile` 是否另有一份、`field_conflict` 有没有 open 行、有没有在跑的优化轮次（`optimization_run.status = 'running'`）；
3. **审计**：两类列都走 `correctAsinField`（人工通道）+ `recordAudit`（`domain/audit/targets.js` 加一条页面写目标）；
   归属列另有 `asin_ownership` 的撤销语义（`retracted_at`），**不删行**；
4. **测试** `tests/t78-asin-inline-ownership.mjs` ≥8 条（你列的六条 + 我加的两条）：
   点格改成功 / 影响面非空 / **无影响也说「没有」** / 审计行落库 / 非法值拒绝 / 取消不改 /
   源码守门（页面与工具同一 store 函数）/ **「人工改完，再 upsert 一次，人工值还在或至少留下了一条审计」**（这条就是 §一 的复现）。

---

## 五、请你拍的三件

1. **B 还是 C**（我建议 B 进本单，C 单独立项）；
2. 若选 B：**审计动作名**用什么（我倾向 `asin.field.manual-overridden`，与现有 `asin.upsert` / `setting.set` 的命名一致）；
3. 若选 C：`price` / `bsr` 这类**强时效**字段要不要豁免（「人工改过的价格也不许采集更新」大概不是你想要的）。
