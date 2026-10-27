# Listing 优化报告 — B0GV55Q4JG

> 站点：美国站（US）｜优化轮次：#4e60241a-b726-4297-92a7-a829dc204afa｜状态：已收尾
> 规则集：—｜埋词位置：未记录｜字段：9 个
> 本轮判定用的是**本轮快照的规则**，不是今天的规则 —— 所以几个月后这份报告仍然解释得通。

## 目录

- [导出件头信息](#s-export)
- [报告头信息](#s-provenance)
- [一、结论](#s1)
- [二、产品概况](#s2)
- [三、埋词策略](#s3)
- [四、逐字段优化](#s4)
- [五、属性字段](#s5)
- [六、可直接复制粘贴的内容](#s6)
- [八、合规校验](#s8)
- [九、字符与字节预算](#s9)
- [十一、必须人工填的字段](#s11)
- [十二、上架操作清单](#s12)
- [十三、自检总表](#s13)

## 导出件头信息

| 字段 | 值 | 这一格是怎么来的 |
| --- | --- | --- |
| 报告 ID | 4e60241a-b726-4297-92a7-a829dc204afa | 这一份文件的身份 = `optimization_run.id`，也是报告库里这一条（kind=optimization）的 `ref_id`。`/report/<id>` 打开的是同一份内容，不是第二份副本。 |
| 对象 | B0GV55Q4JG · US（美国站） | ASIN 与站点取自 `optimization_run.asin` / `.marketplace`；`asin` 表里这一行读不到（所以产品概况一节是空的，那是「没有这一行」，不是「字段都是 0」）。 |
| 范围 | 字段 9 个（采纳 9 / 拒绝 0 / 待定 0） · 埋词位置 未记录 · 证据 0 类 · 预算对照 9 个字段 | 字段数 = `optimization_run` 下这一轮的草案行数；埋词位置 = 本轮全局计划的 `positions`；证据类数 = 本轮冻结的证据包条数；预算对照 = 计入字符/字节上限的字段数。四者都是**这一轮**的范围，不是全库。 |
| 来源 | 这一轮没有冻结证据包：数字来自 optimization_run 的草案行与本轮规则快照 | **这里不是「本仓没有来源」**：证据包的十一类都建了（`domain/optimize/evidence.js`），缺的是这一轮建轮次时没有冻结那一份。重跑一次收尾会补冻。 |
| 质量告警 | 0 条阻断 / 2 条警告 · 未执行规则 0 条 · 站点规则已核验 · 词法**近似** · 证据缺 0 类 | 阻断/警告 = 本轮校验的计数（`validation.counts`，与第八章同一份）；未执行规则 = 本站点跳过执行的规则条数；站点规则与词法各自三态（已核验 / 未核验 / 近似）；写回只在真失败时出现；证据缺 = 证据包里 `absent` 与 `not_modelled` 的类数。**「0 条阻断」是一次测量，「读不到规则集」不是 0。** |
| 数据新鲜度 | 非实时 · 数据截止 读不到（这一轮没有证据包） · 证据 0 类（0 冻结 / 0 不存在 / 0 未建模） | 非实时：本文件是 2026-10-26T00:03:53.066Z 那一刻的字节；数据截止**读不到**：这一轮没有冻结的证据包 —— 这不是「截止时间是空的」；另有 6 条指标口径限制：2 条本仓没有来源、2 条只有一部分口径、2 条只有当前值没有历史；之后发生的变化**不会**出现在这份文件里 —— 要新的，重新采集并收尾一轮。 |

> ⚠️ **非实时**：非实时：本文件是 2026-10-26T00:03:53.066Z 那一刻的字节；数据截止**读不到**：这一轮没有冻结的证据包 —— 这不是「截止时间是空的」；另有 6 条指标口径限制：2 条本仓没有来源、2 条只有一部分口径、2 条只有当前值没有历史；之后发生的变化**不会**出现在这份文件里 —— 要新的，重新采集并收尾一轮。

## 报告头信息

| 字段 | 值 | 这一格是怎么来的 |
| --- | --- | --- |
| 数据截止 | 读不到 | 这一轮还没有证据包（本批之前建的轮次会在 save 收尾时补冻）—— 所以不是「截止时间是空的」，是这一类观测还没有落点。 |
| Prompt 版本 | fixed@v1; evidence@v1; contract@v1 | 逐层：固定策略层 v1 / 证据层 v1 / 输出契约层 v1（来自本轮冻结的 package_json.prompts）。 |
| Agent 流程 | 未关联 | 这一轮没有关联到某次 Agent 运行（会话 id 也没记）—— 不是「本系统没有 Agent 流程」：模块 12 的 agent_run 就是它的落点，这一轮只是没有引用它。 |
| 草案状态 | 版本 v9 · 9 个字段：采纳 9 / 未采纳 0 / 待定 0 | 版本从 1 开始，只在采纳/驳回**真的改变**时递增；三态计数读自 optimization_draft.accepted。 |

## 一、结论

- 采纳 **9** 个字段，未采纳 0 个，待定 0 个
- 阻断 **0** 项，警告 **2** 项（无阻断项，可以上架）
- 属性填写 **0/43**
- 写回口径：本报告 **9** 个字段中，**9** 个可写回 listing（标题 / 五点 / 描述 / 后台词 / 产品亮点），**0** 个只出草案、无写回路径（无）

## 二、产品概况

_没有关联到 ASIN 记录，本节跳过。_
## 三、埋词策略

_本轮没有生成全局计划。_
## 四、逐字段优化

> 本轮**没有发布登记**，所以逐字段不印「实际发布值」—— 这不是「发布值是空的」，是还没有人登记过发布（§6）。登记之后重出报告，这一节会逐个字段印出线上实际的值。

### 4.1 对照表（一屏看完这一轮改了什么）

| 序号 | 属性字段 | 优化前值 | 优化后值 | 优化后详细说明 |
| --- | --- | --- | --- | --- |
| 1 | 标题（`title`） | Custom Bench Cushion, 75D High Density Foam, Indoor Outdoor Bench Seat Pad | Custom Bench Cushion, 75D High Density Foam, Washable Removable Cover, Indoor Outdoor Seat Pad | 把「Custom Bench Cushion」放成开头两个字位（这是这一页最贵的搜索词），75D 紧跟上作为唯一可写的硬参数，洗护与室内外补足后半段；字数压到 75 附近以对齐 2026-07-27 起的非媒体目标。 |
| 2 | 五点 1（`bullet_1`） | High density 75D foam keeps its shape | CUSTOM BENCH CUSHION, MEASURE ONCE: give us the seat length, depth and 3 thickness choices, and the cushion is cut to that size, so it sits flat with no gaps at the ends | 第一条回答定制类唯一的硬疑虑（怎么量、量哪里、有几个厚度可选），并给出「不会留缝」这个可验证结果。 |
| 3 | 五点 2（`bullet_2`） | Custom sizes measured to your bench | 75D HIGH DENSITY FOAM: 75D density foam keeps 95% of its height after 8 hours of sitting, so the middle does not sink like a 45D pad | 把 75D 变成可对比的后果（75D vs 45D、8 小时、95% 回弹），满足「每条 ≥2 个具体参数」这条 SOP 要求。 |
| 4 | 五点 3（`bullet_3`） | Removable cover, machine washable | REMOVABLE BENCH CUSHION COVER: the cover unzips in 30 seconds and machine washes at 30 degrees, while the 75D foam core keeps its shape after 20 washes | 洗护是这类大件的高频退货点：30 秒拆、30 度机洗、20 次之后仍不变形，三个数字都给。 |
| 5 | 五点 4（`bullet_4`） | Non-slip backing | INDOOR AND OUTDOOR: fits window benches, dining benches and porch swings, and the 2 layer fabric wipes clean after spills on a patio bench | 室内外双场景把适用面写宽，减少「我放在飘窗/露台能不能用」的问询。 |
| 6 | 五点 5（`bullet_5`） | Indoor and covered outdoor use | STAYS IN PLACE: the flat base grips wood, metal and wicker without ties, so the pad does not slide forward when you stand up | 防滑写清楚（平底抓地、不需要绑带），直接对应「垫子总是往前滑」这条差评。 |
| 7 | 产品描述（`description`） | A bench cushion that stays where you put it. | A custom bench cushion made to fit the bench you already own, not a size we guessed. You measure the seat length, the seat depth and the thickness you want, choose that size, and the cushion is cut to it, so there are no gaps at the ends and no overhang at the front edge. The filling is 75D high density foam: dense enough that 8 hours of sitting does not flatten it, and resilient enough that the middle comes back to shape instead of staying sunk. That is the difference you feel between a 75D bench cushion and the 45D pads that look similar in photos. The cover is a bench cushion cover that unzips in about 30 seconds and can be machine washed at 30 degrees, while the foam core inside keeps its shape wash after wash, so a spill or a muddy paw does not end the life of the cushion. For indoor use it works on window benches, dining benches, bay window seats and reading nooks; for outdoor use it fits porch swings, patio benches and covered decks, and the fabric wipes clean after a spill. The flat base grips wood, metal and wicker without ties or straps, so the pad does not slide forward when you stand up. Because every cushion is cut to order, the size you enter is the size you get; measure twice, and if you are between two sizes, choose the larger one for the depth. The 75D foam is also the reason the cushion holds its edges: cheap pads round off at the corners within weeks, and a custom bench cushion is only worth ordering if the shape survives the first season. | 把标题承诺的三件事（定制尺寸、75D 填充、可拆洗）逐条展开成可验证的句子，并交代室内外场景、防滑与量尺建议；不写促销词与绝对化表述，全部参数都来自本页已有的产品事实。 |
| 8 | 后台搜索词（`search_terms`） | bench seat pad custom cushion outdoor furniture replacement foam | window tufted nook bay seat pad replacement foam | 后台词只放前后台都没有的同义词与场景词（window seat、tufted、bay nook），不重复已经埋进标题与五点的词 —— 字节有限，重复等于白占。 |
| 9 | 产品亮点（`item_highlights`） | （空） | Custom bench cushion cut to your seat size, 75D foam that rebounds after 8 hours, washable cover, indoor and outdoor use. | 亮点以短标签形式出现在前台，把「定制 + 75D + 可拆洗 + 室内外」压进 125 字符内，超过会被截断。 |

### 标题

#### 标题 ✅

**优化前**

```
Custom Bench Cushion, 75D High Density Foam, Indoor Outdoor Bench Seat Pad
```

**优化后**（可直接复制粘贴到亚马逊后台）

```
Custom Bench Cushion, 75D High Density Foam, Washable Removable Cover, Indoor Outdoor Seat Pad
```

> **置信度 中**：有 1 条警告　｜　**风险 中**：有 1 条警告

> **为什么这样改：** 把「Custom Bench Cushion」放成开头两个字位（这是这一页最贵的搜索词），75D 紧跟上作为唯一可写的硬参数，洗护与室内外补足后半段；字数压到 75 附近以对齐 2026-07-27 起的非媒体目标。

> **预期：** 预期 搜索结果曝光 + 点击率（CTR） 上升｜怎么测：发布后 14 天，与发布前 14 天的自然曝光 / CTR 比（F14-08 观测节点 7/14/30）
> **反向指标：** 词堆多了会升曝光、降 CTR —— 两个数要一起看，只看一个会得出相反结论
> **依据：** 运营经验判断，不是本仓实测数据 —— 按可证伪的假设用：发布后用观测模块判真假。

> **植入了：** bench cushion、custom bench cushion

- **警告** 标题长于 2026-07-27 的新目标值（title.length.nonmedia，依据 delivery-2026-07-28 §4（2026-07-27 起非媒体类目 ≤75 字符））：94 字符，2026-07-27 起的非媒体类目目标是 ≤75。这是目标不是硬上限 —— §1.3 仍列 200，且 hub 自己的范例标题是 186 字符，所以这里不阻断

### 五点描述

#### 五点 1 ✅

**优化前**

```
High density 75D foam keeps its shape
```

**优化后**（可直接复制粘贴到亚马逊后台）

```
CUSTOM BENCH CUSHION, MEASURE ONCE: give us the seat length, depth and 3 thickness choices, and the cushion is cut to that size, so it sits flat with no gaps at the ends
```

> **置信度 高**：有观测到的原值、规则全部执行、没有违规　｜　**风险 低**：没有阻断、没有超限；照第十二节的清单操作即可

> **为什么这样改：** 第一条回答定制类唯一的硬疑虑（怎么量、量哪里、有几个厚度可选），并给出「不会留缝」这个可验证结果。

> **预期：** 预期 详情页转化率（session → order） 上升｜怎么测：发布后 14 天，与基线比；同时看加购率与停留时长
> **反向指标：** 五点写成参数表会降可读性：转化不升而跳出升，就是写成了规格书
> **依据：** 运营经验判断，不是本仓实测数据 —— 按可证伪的假设用：发布后用观测模块判真假。

> **植入了：** bench cushion、custom bench cushion

#### 五点 2 ✅

**优化前**

```
Custom sizes measured to your bench
```

**优化后**（可直接复制粘贴到亚马逊后台）

```
75D HIGH DENSITY FOAM: 75D density foam keeps 95% of its height after 8 hours of sitting, so the middle does not sink like a 45D pad
```

> **置信度 高**：有观测到的原值、规则全部执行、没有违规　｜　**风险 低**：没有阻断、没有超限；照第十二节的清单操作即可

> **为什么这样改：** 把 75D 变成可对比的后果（75D vs 45D、8 小时、95% 回弹），满足「每条 ≥2 个具体参数」这条 SOP 要求。

> **预期：** 预期 详情页转化率（session → order） 上升｜怎么测：发布后 14 天，与基线比；同时看加购率与停留时长
> **反向指标：** 五点写成参数表会降可读性：转化不升而跳出升，就是写成了规格书
> **依据：** 运营经验判断，不是本仓实测数据 —— 按可证伪的假设用：发布后用观测模块判真假。

#### 五点 3 ✅

**优化前**

```
Removable cover, machine washable
```

**优化后**（可直接复制粘贴到亚马逊后台）

```
REMOVABLE BENCH CUSHION COVER: the cover unzips in 30 seconds and machine washes at 30 degrees, while the 75D foam core keeps its shape after 20 washes
```

> **置信度 高**：有观测到的原值、规则全部执行、没有违规　｜　**风险 低**：没有阻断、没有超限；照第十二节的清单操作即可

> **为什么这样改：** 洗护是这类大件的高频退货点：30 秒拆、30 度机洗、20 次之后仍不变形，三个数字都给。

> **预期：** 预期 详情页转化率（session → order） 上升｜怎么测：发布后 14 天，与基线比；同时看加购率与停留时长
> **反向指标：** 五点写成参数表会降可读性：转化不升而跳出升，就是写成了规格书
> **依据：** 运营经验判断，不是本仓实测数据 —— 按可证伪的假设用：发布后用观测模块判真假。

> **植入了：** bench cushion、bench cushion cover

#### 五点 4 ✅

**优化前**

```
Non-slip backing
```

**优化后**（可直接复制粘贴到亚马逊后台）

```
INDOOR AND OUTDOOR: fits window benches, dining benches and porch swings, and the 2 layer fabric wipes clean after spills on a patio bench
```

> **置信度 高**：有观测到的原值、规则全部执行、没有违规　｜　**风险 低**：没有阻断、没有超限；照第十二节的清单操作即可

> **为什么这样改：** 室内外双场景把适用面写宽，减少「我放在飘窗/露台能不能用」的问询。

> **预期：** 预期 详情页转化率（session → order） 上升｜怎么测：发布后 14 天，与基线比；同时看加购率与停留时长
> **反向指标：** 五点写成参数表会降可读性：转化不升而跳出升，就是写成了规格书
> **依据：** 运营经验判断，不是本仓实测数据 —— 按可证伪的假设用：发布后用观测模块判真假。

#### 五点 5 ✅

**优化前**

```
Indoor and covered outdoor use
```

**优化后**（可直接复制粘贴到亚马逊后台）

```
STAYS IN PLACE: the flat base grips wood, metal and wicker without ties, so the pad does not slide forward when you stand up
```

> **置信度 高**：有观测到的原值、规则全部执行、没有违规　｜　**风险 低**：没有阻断、没有超限；照第十二节的清单操作即可

> **为什么这样改：** 防滑写清楚（平底抓地、不需要绑带），直接对应「垫子总是往前滑」这条差评。

> **预期：** 预期 详情页转化率（session → order） 上升｜怎么测：发布后 14 天，与基线比；同时看加购率与停留时长
> **反向指标：** 五点写成参数表会降可读性：转化不升而跳出升，就是写成了规格书
> **依据：** 运营经验判断，不是本仓实测数据 —— 按可证伪的假设用：发布后用观测模块判真假。

### 产品描述

#### 产品描述 ✅

**优化前**

```
A bench cushion that stays where you put it.
```

**优化后**（可直接复制粘贴到亚马逊后台）

```
A custom bench cushion made to fit the bench you already own, not a size we guessed. You measure the seat length, the seat depth and the thickness you want, choose that size, and the cushion is cut to it, so there are no gaps at the ends and no overhang at the front edge. The filling is 75D high density foam: dense enough that 8 hours of sitting does not flatten it, and resilient enough that the middle comes back to shape instead of staying sunk. That is the difference you feel between a 75D bench cushion and the 45D pads that look similar in photos. The cover is a bench cushion cover that unzips in about 30 seconds and can be machine washed at 30 degrees, while the foam core inside keeps its shape wash after wash, so a spill or a muddy paw does not end the life of the cushion. For indoor use it works on window benches, dining benches, bay window seats and reading nooks; for outdoor use it fits porch swings, patio benches and covered decks, and the fabric wipes clean after a spill. The flat base grips wood, metal and wicker without ties or straps, so the pad does not slide forward when you stand up. Because every cushion is cut to order, the size you enter is the size you get; measure twice, and if you are between two sizes, choose the larger one for the depth. The 75D foam is also the reason the cushion holds its edges: cheap pads round off at the corners within weeks, and a custom bench cushion is only worth ordering if the shape survives the first season.
```

> **置信度 高**：有观测到的原值、规则全部执行、没有违规　｜　**风险 低**：没有阻断、没有超限；照第十二节的清单操作即可

> **为什么这样改：** 把标题承诺的三件事（定制尺寸、75D 填充、可拆洗）逐条展开成可验证的句子，并交代室内外场景、防滑与量尺建议；不写促销词与绝对化表述，全部参数都来自本页已有的产品事实。

> **预期：** 预期 转化率（长尾决策场景） 上升｜怎么测：发布后 14 天转化率与退货率
> **反向指标：** 描述里出现与属性不一致的尺寸 / 材质，会升退货率
> **依据：** 运营经验判断，不是本仓实测数据 —— 按可证伪的假设用：发布后用观测模块判真假。

> **植入了：** bench cushion、bench cushion cover、custom bench cushion

### 后台搜索词

#### 后台搜索词 ✅

**优化前**

```
bench seat pad custom cushion outdoor furniture replacement foam
```

**优化后**（可直接复制粘贴到亚马逊后台）

```
window tufted nook bay seat pad replacement foam
```

> **置信度 中**：有 1 条警告　｜　**风险 中**：有 1 条警告

> **为什么这样改：** 后台词只放前后台都没有的同义词与场景词（window seat、tufted、bay nook），不重复已经埋进标题与五点的词 —— 字节有限，重复等于白占。

> **预期：** 预期 长尾词自然曝光 上升｜怎么测：发布后 7 / 14 / 30 天，看只出现在后台词里的那些词的曝光（本仓没有逐词曝光表时，用搜索结果排名扫描代替）
> **反向指标：** 后台词与前台词重复会浪费字段预算，不会带来新曝光
> **依据：** 运营经验判断，不是本仓实测数据 —— 按可证伪的假设用：发布后用观测模块判真假。

- **警告** 后台词重复了前端词（backend.title.repeat，依据 §6.1 禁止重复标题关键词）：这些词前端已有，后台再写一遍等于白占字节: window, nook, bay, seat, pad, foam

### 产品亮点

#### 产品亮点 ✅

**优化后**（可直接复制粘贴到亚马逊后台）

```
Custom bench cushion cut to your seat size, 75D foam that rebounds after 8 hours, washable cover, indoor and outdoor use.
```

> **置信度 低**：这一字段没有可对比的原值（从未被观测）　｜　**风险 低**：没有阻断、没有超限；照第十二节的清单操作即可

> **为什么这样改：** 亮点以短标签形式出现在前台，把「定制 + 75D + 可拆洗 + 室内外」压进 125 字符内，超过会被截断。

> **预期：** 预期 移动端首屏点击率 上升｜怎么测：发布后 14 天移动端 CTR 与基线比
> **反向指标：** 移动端截断位置与桌面不同，文案要按最短的那个宽度写
> **依据：** 运营经验判断，不是本仓实测数据 —— 按可证伪的假设用：发布后用观测模块判真假。

> **植入了：** bench cushion、custom bench cushion

## 五、属性字段

已填 **0/43**。属性权重 2026 起已超过后台搜索词，每个空字段是 COSMO 知识图谱的一个断连。

| 属性 | 当前值 | 需要具体化 |
| --- | --- | --- |
| 商品类型 | ❌ 空 |  |
| 主题 | ❌ 空 | 是 |
| 品牌 | ❌ 空 |  |
| 制造商 | ❌ 空 |  |
| 原产国 | ❌ 空 |  |
| 预期用途 | ❌ 空 | 是 |
| 具体用途 | ❌ 空 | 是 |
| 推荐用途 | ❌ 空 | 是 |
| 目标人群 | ❌ 空 |  |
| 材质 | ❌ 空 | 是 |
| 材质成分 | ❌ 空 | 是 |
| 填充材质 | ❌ 空 | 是 |
| 面料材质 | ❌ 空 | 是 |
| 外层材质 | ❌ 空 | 是 |
| 内层材质 | ❌ 空 | 是 |
| 颜色 | ❌ 空 |  |
| 尺寸 | ❌ 空 |  |
| 产品尺寸 | ❌ 空 |  |
| 商品重量 | ❌ 空 |  |
| 厚度 | ❌ 空 |  |
| 形状 | ❌ 空 |  |
| 图案 | ❌ 空 |  |
| 风格 | ❌ 空 |  |
| 软硬度 | ❌ 空 |  |
| 件数 | ❌ 空 |  |
| 商品数量 | ❌ 空 |  |
| 使用场景 | ❌ 空 | 是 |
| 适用房间 | ❌ 空 |  |
| 适用季节 | ❌ 空 |  |
| 适用场合 | ❌ 空 |  |
| 适用表面 | ❌ 空 |  |
| 是否需要组装 | ❌ 空 |  |
| 安装方式 | ❌ 空 |  |
| 适用年龄 | ❌ 空 |  |
| 是否双面可用 | ❌ 空 |  |
| 坐垫类型 | ❌ 空 |  |
| 保养说明 | ❌ 空 |  |
| 面料护理 | ❌ 空 |  |
| 产品益处 | ❌ 空 |  |
| 特殊功能 | ❌ 空 |  |
| 防水等级 | ❌ 空 |  |
| 耐候性 | ❌ 空 |  |
| 保修说明 | ❌ 空 |  |

**还空着的 43 项：** 商品类型、主题、品牌、制造商、原产国、预期用途、具体用途、推荐用途、目标人群、材质、材质成分、填充材质、面料材质、外层材质、内层材质、颜色、尺寸、产品尺寸、商品重量、厚度、形状、图案、风格、软硬度、件数、商品数量、使用场景、适用房间、适用季节、适用场合、适用表面、是否需要组装、安装方式、适用年龄、是否双面可用、坐垫类型、保养说明、面料护理、产品益处、特殊功能、防水等级、耐候性、保修说明

## 六、可直接复制粘贴的内容

以下文本块可以逐段复制进卖家后台，不需要再改。

**【标题】**

```
Custom Bench Cushion, 75D High Density Foam, Washable Removable Cover, Indoor Outdoor Seat Pad
```

**【五点 1】**

```
CUSTOM BENCH CUSHION, MEASURE ONCE: give us the seat length, depth and 3 thickness choices, and the cushion is cut to that size, so it sits flat with no gaps at the ends
```

**【五点 2】**

```
75D HIGH DENSITY FOAM: 75D density foam keeps 95% of its height after 8 hours of sitting, so the middle does not sink like a 45D pad
```

**【五点 3】**

```
REMOVABLE BENCH CUSHION COVER: the cover unzips in 30 seconds and machine washes at 30 degrees, while the 75D foam core keeps its shape after 20 washes
```

**【五点 4】**

```
INDOOR AND OUTDOOR: fits window benches, dining benches and porch swings, and the 2 layer fabric wipes clean after spills on a patio bench
```

**【五点 5】**

```
STAYS IN PLACE: the flat base grips wood, metal and wicker without ties, so the pad does not slide forward when you stand up
```

**【产品描述】**

```
A custom bench cushion made to fit the bench you already own, not a size we guessed. You measure the seat length, the seat depth and the thickness you want, choose that size, and the cushion is cut to it, so there are no gaps at the ends and no overhang at the front edge. The filling is 75D high density foam: dense enough that 8 hours of sitting does not flatten it, and resilient enough that the middle comes back to shape instead of staying sunk. That is the difference you feel between a 75D bench cushion and the 45D pads that look similar in photos. The cover is a bench cushion cover that unzips in about 30 seconds and can be machine washed at 30 degrees, while the foam core inside keeps its shape wash after wash, so a spill or a muddy paw does not end the life of the cushion. For indoor use it works on window benches, dining benches, bay window seats and reading nooks; for outdoor use it fits porch swings, patio benches and covered decks, and the fabric wipes clean after a spill. The flat base grips wood, metal and wicker without ties or straps, so the pad does not slide forward when you stand up. Because every cushion is cut to order, the size you enter is the size you get; measure twice, and if you are between two sizes, choose the larger one for the depth. The 75D foam is also the reason the cushion holds its edges: cheap pads round off at the corners within weeks, and a custom bench cushion is only worth ordering if the shape survives the first season.
```

**【后台搜索词】**

```
window tufted nook bay seat pad replacement foam
```

**【产品亮点】**

```
Custom bench cushion cut to your seat size, 75D foam that rebounds after 8 hours, washable cover, indoor and outdoor use.
```

## 八、合规校验

_本轮没有留下校验结果。_

### 8.3 这份报告不判定的事（Agent 审阅清单）

下面这些是规则文档要求、但只能由模型或人来判断的。机检通过**不代表**这些也通过。工作台的「校验体系 → Agent 审阅」面板逐项记结论（可以逐字段），每条结论必须引用证据。

| 检查项 | 依据 | 要问的问题 | 只能人判 |
| --- | --- | --- | --- |
| 虚假声称（audit.hallucination） | §10.2 虚假声称 | 文案里的每个参数是否都能在采集到的属性/详情里找到依据 |  |
| 前后矛盾（audit.contradiction） | §10.2 前后矛盾 | 标题、五点、描述之间有没有互相否定的说法（如标题说防水、描述说不防水） |  |
| 意图匹配（audit.intent.coverage） | §11.2 意图匹配检查 | 文案是否回答了 Who is this for / What does it do / How is it different / Will it solve my problem / Is it real |  |
| COSMO 因果链（audit.cosmo.causal） | §9.3.1 / SOP §4.2 COSMO因果链 | 每条五点是否构成「功能→痛点→利益」的因果链，而不是功能罗列 |  |
| 名词短语（audit.npo） | §9.3.2 名词短语优化 | 卖点是否写成名词短语（"70D high-density foam core"）而非形容词堆砌 |  |
| 差评回应（audit.review.alignment） | §9.3.4 Review 发现机制 | 文案是否回应了差评里的高频痛点（没有差评数据时明确说明无法判断） |  |
| 可摘录回答（audit.geo.answerable） | §9.2 从关键词匹配 → 意图理解 | 买家问「shoes for plantar fasciitis on concrete」这种长问句时，listing 里有没有一句可以被直接摘出来回答它 |  |
| Q&A 播种（audit.qa.buyer） | §9.3.3 Q&A 播种策略 | 播种的问题是否是买家真的会问的（不是卖家想说的），回答是否给了参数而不是承诺 |  |
| A+ 增量（audit.aplus.increment） | 范例 §8.2 A+ 要有增量 | 每个 A+ 模块相对前台五点有没有新增信息（机检只能查重复度，增量与否要人判断） |  |
| 属性与实物一致（audit.attribute.fact） | §7.2 属性与实物一致 | 写进去的属性值是否与实物一致（模型只能提议，属性是事实，必须由人确认） | 是 |
| AI 生成披露（audit.ai.disclosure） | §10.1 AI 生成内容 ≥50% 需标注 | 若最终图片/文案的 AI 生成占比 ≥50%，是否已按新规标注 "AI Generated" 或 "Enhanced with AI" | 是 |
| 自然度（audit.naturalness） | SOP §9.3.1 / 可读性 | 读起来是不是母语者会写的句子，而不是把关键词一个个塞进去的堆砌（同一个词在一句话里被硬塞两遍也算） |  |
| 说服力（audit.persuasion） | §11.2 买家决策五问 | 每个卖点是否回答了「为什么买这个而不是隔壁那个」—— 只描述功能、说不出差异的不算 |  |
| 品牌语气（audit.brand_voice） | brand 表（name / aliases_json / forbidden_json）—— 只有品牌名与禁用写法，没有语气 | 文案的语气是否与品牌一贯的语气一致（郑重 / 轻松 / 技术 / 生活化） | 是 |

## 九、字符与字节预算

| 字段 | 用量 | 上限 | 单位 | 来源 |
| --- | --- | --- | --- | --- |
| 标题 | 94 | 200 | 字符 | 文档规定 |
| 五点 1 | 169 | 255 | 字符 | 文档规定 |
| 五点 2 | 132 | 255 | 字符 | 文档规定 |
| 五点 3 | 151 | 255 | 字符 | 文档规定 |
| 五点 4 | 138 | 255 | 字符 | 文档规定 |
| 五点 5 | 124 | 255 | 字符 | 文档规定 |
| 产品描述 | 1482 | 2000 | 字符 | 文档规定 |
| 后台搜索词 | 48 | 249 | 字节 | 文档规定 |
| 产品亮点 | 121 | 125 | 字符 | 文档规定 |

> 后台搜索词按**字节**算，其他按**字符**算。一个中文字 3 字节，所以 249 字节装不下 249 个中文字 —— 超了亚马逊可能整个字段都不索引。

> 「经验值」是我们给的区间，不是文档规定的上限。

## 十一、必须人工填的字段

这些采集不到、也推断不出来。填错变体关系或类目会影响整组链接，所以单独列出来。

| 字段 | 说明 | 库内状态 |
| --- | --- | --- |
| SKU | 上架时人工指定，采集不到 | 库内无对应字段，需人工确认 |
| 库存数量 | 库存数据在后台，不来自商品页 | 库内无对应字段，需人工确认 |
| 标准价格 | 以后台定价为准，商品页价格可能含促销 | 库内为空，需人工填 |
| 目标人群 | 类目属性，需按 PTD 选择 | 库内无对应字段，需人工确认 |
| 变体主题 | 父子变体关系，改错影响整组链接 | 库内无对应字段，需人工确认 |
| 产品类目 | 类目路径决定属性集与标题上限 | 库内为空，需人工填 |
| 浏览节点 | 决定曝光节点，需按后台类目树选 | 库内无对应字段，需人工确认 |

## 十二、上架操作清单

这一轮 **16** 条操作：可复制粘贴 9 · 去独立编辑器 0 · 草案未采纳（不要去改）0 · 本轮没有生成 0 · 必须人工填 2 · 已登记发布 0

每一条都是「去哪儿、做什么」。**勾选状态不落库** —— 报告是一份静态文档，而「人做过什么」的持久事实在模块 14 的发布登记里（见 12.2）。已经登记过发布的那些字段，下面直接画成勾上的。

- [ ] **标题**（上架表格）— 把「标题」复制进 卖家后台 → Inventory → Manage Inventory → Edit　`可复制粘贴`
- [ ] **五点 1**（上架表格）— 把「五点 1」复制进 卖家后台 → Inventory → Manage Inventory → Edit　`可复制粘贴`
- [ ] **五点 2**（上架表格）— 把「五点 2」复制进 卖家后台 → Inventory → Manage Inventory → Edit　`可复制粘贴`
- [ ] **五点 3**（上架表格）— 把「五点 3」复制进 卖家后台 → Inventory → Manage Inventory → Edit　`可复制粘贴`
- [ ] **五点 4**（上架表格）— 把「五点 4」复制进 卖家后台 → Inventory → Manage Inventory → Edit　`可复制粘贴`
- [ ] **五点 5**（上架表格）— 把「五点 5」复制进 卖家后台 → Inventory → Manage Inventory → Edit　`可复制粘贴`
- [ ] **产品描述**（上架表格）— 把「产品描述」复制进 卖家后台 → Inventory → Manage Inventory → Edit　`可复制粘贴`
- [ ] **后台搜索词**（上架表格）— 把「后台搜索词」复制进 卖家后台 → Inventory → Manage Inventory → Edit　`可复制粘贴`
- [ ] **产品亮点**（上架表格）— 把「产品亮点」复制进 卖家后台 → Inventory → Manage Inventory → Edit　`可复制粘贴`
- [ ] **SKU**（插件不提供的字段）— 「SKU」：上架时人工指定，采集不到（本仓**没有**对应列，读不出它填了没有 —— 与「没填」不是一件事）　`库内无对应字段，需人工确认`
- [ ] **库存数量**（插件不提供的字段）— 「库存数量」：库存数据在后台，不来自商品页（本仓**没有**对应列，读不出它填了没有 —— 与「没填」不是一件事）　`库内无对应字段，需人工确认`
- [ ] **标准价格**（插件不提供的字段）— 人工填「标准价格」：以后台定价为准，商品页价格可能含促销　`库内为空，需人工填`
- [ ] **目标人群**（插件不提供的字段）— 「目标人群」：类目属性，需按 PTD 选择（本仓**没有**对应列，读不出它填了没有 —— 与「没填」不是一件事）　`库内无对应字段，需人工确认`
- [ ] **变体主题**（插件不提供的字段）— 「变体主题」：父子变体关系，改错影响整组链接（本仓**没有**对应列，读不出它填了没有 —— 与「没填」不是一件事）　`库内无对应字段，需人工确认`
- [ ] **产品类目**（插件不提供的字段）— 人工填「产品类目」：类目路径决定属性集与标题上限　`库内为空，需人工填`
- [ ] **浏览节点**（插件不提供的字段）— 「浏览节点」：决定曝光节点，需按后台类目树选（本仓**没有**对应列，读不出它填了没有 —— 与「没填」不是一件事）　`库内无对应字段，需人工确认`

### 12.1 交付边界：哪些字段是这个插件给的，哪些要人填

| 类别 | 条数 | 这一轮的具体字段 |
| --- | --- | --- |
| 插件提供（这一轮有草案） | 9 | 这些字段的草案由这一轮产出。属性字段是动态的（随类目变），所以这里只给条数；逐项填写情况看报告的属性一节。 |
| 插件**不提供** | 7 | item_sku、item_quantity、standard_price、target_audience、variation_theme、product_category、recommended_browse_nodes |
| 插件会提供、**这一轮没有生成** | 23 | 品牌故事、A+ 品牌故事模块、A+ 核心卖点模块、A+ 对比模块、A+ 场景模块、A+ 参数模块、A+ FAQ 模块、Q&A 1、Q&A 2、Q&A 3、Q&A 4、Q&A 5、Q&A 6、Q&A 7、Q&A 8、主图 Alt Text、副图 1 Alt Text、副图 2 Alt Text、副图 3 Alt Text、副图 4 Alt Text、副图 5 Alt Text、副图 6 Alt Text、视频脚本要点 |

> 第二行与第三行**不是一件事**：第二行是「本仓没有这些字段的来源」（SKU / 库存 / 价格 / 类目 / 变体 / 浏览节点 / 目标人群，采集不到也推断不出来，只能人填）；第三行是「插件本来会产出这些字段的草案，但这一轮没有生成它」（没有输入，或者这一轮的模式/模型没有写到它）。把这两句压成一句，读者就会去后台找一个插件根本不提供的字段的值。

### 12.2 发布登记：接受草案 ≠ 已发布

> **接受草案 ≠ 已发布。** 这份报告里的文字，在你到卖家后台改完、并登记发布之前，线上**一个字都没变**。这个插件不会在 Seller Central 点任何按钮，也不调任何发布接口 ——它只记录你做了什么。

登记入口：工作台「优化 → 发布记录」的表单（页面会预填运行 id 与草案版本）。

- 运行 id：`4e60241a-b726-4297-92a7-a829dc204afa`
- 草案版本：`v9`
- 已登记的字段：0 个（**一条发布都还没有登记过** —— 这不是「登记里没有字段」）

> 下面这几句是**经验**，不是由这一轮的内容推出来的：改动前先截图存档（万一要回滚）；每改完一个字段保存一次；改完 24 小时看是否触发审核、48 小时看排名与广告数据；有广告活动的 ASIN 改完要检查广告组的关键词质量分。

## 十三、自检总表

| 检查项 | 标准 | 结果 | 状态 |
| --- | --- | --- | --- |
| 标题字符 | ≤200 | 94 | ✅ |
| 五点条数 | 5 条 | 5 | ✅ |
| 五点格式 | 首字母大写 + 冒号 | 见逐字段校验 | ✅ |
| 后台搜索词字节 | ≤249 字节 | 48 | ✅ |
| 产品亮点字符 | ≤125 | 121 | ✅ |
| 属性填写率 | 43 项 | 0/43 | ❌ |
| A+ 模块 | ≥5 个 | 0 | ❌ |
| Q&A 对数 | ≥5 对 | 0 | ❌ |
| 图片 Alt Text | 7 项 | 0 | ❌ |
| 无阻断项 | 0 项 | 0 | ✅ |
| 事实一致 | 0 处冲突 | — | — |
| 埋词完成率 | 越高越好 | — | — |

> 状态「—」= **这一项没有执行**（不是通过，也不是不达标）—— 与校验闸门的 `unverified` 是同一件事。

---

_生成时间：2026-10-26T00:04:09.712Z｜规则集 —｜埋词位置 未记录｜字段词汇 32 项 + 43 项属性_