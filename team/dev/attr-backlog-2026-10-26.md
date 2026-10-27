# 43 项必填属性 · 缺口清单（B0GV55Q4JG@US）

> 生成方式：`VACUUM INTO` 真库副本 → `attributeStatus()` → 对每个缺项在标题/描述里找痕迹。
> **这份文档只写证据，不写猜测值。** 属性是事实：猜一个写进去，就是一条看起来像真的假数据。

- 必填属性：17 / 43
- 空值：26 项 · 占位值：0 项
- 标题：Custom Bench Cushion, 75D High Density Foam, Indoor Outdoor Bench Seat Pad

| # | 属性 id | 名称 | 线索（来自本库文案/快照） | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `item_type` | 商品类型 | 命中：cushion / seat / pad | 文案里出现过这些词，但**文案不是事实来源** —— 需人工确认后写入 |
| 2 | `subject_matter` | 主题 | 本仓无证据 | 必须人工/后台给值 |
| 3 | `country_of_origin` | 原产国 | 本仓无证据 | 必须人工/后台给值 |
| 4 | `intended_use` | 预期用途 | 命中：indoor / outdoor / bench | 文案里出现过这些词，但**文案不是事实来源** —— 需人工确认后写入 |
| 5 | `specific_uses` | 具体用途 | 命中：bench / seat | 文案里出现过这些词，但**文案不是事实来源** —— 需人工确认后写入 |
| 6 | `target_audience` | 目标人群 | 本仓无证据 | 必须人工/后台给值 |
| 7 | `material` | 材质 | 命中：foam | 文案里出现过这些词，但**文案不是事实来源** —— 需人工确认后写入 |
| 8 | `material_composition` | 材质成分 | 本仓无证据 | 必须人工/后台给值 |
| 9 | `outer_material` | 外层材质 | 本仓无证据 | 必须人工/后台给值 |
| 10 | `inner_material` | 内层材质 | 命中：foam | 文案里出现过这些词，但**文案不是事实来源** —— 需人工确认后写入 |
| 11 | `product_dimensions` | 产品尺寸 | 本仓无证据 | 必须人工/后台给值 |
| 12 | `item_weight` | 商品重量 | 本仓无证据 | 必须人工/后台给值 |
| 13 | `number_of_pieces` | 件数 | 本仓无证据 | 必须人工/后台给值 |
| 14 | `room_type` | 适用房间 | 本仓无证据 | 必须人工/后台给值 |
| 15 | `seasons` | 适用季节 | 本仓无证据 | 必须人工/后台给值 |
| 16 | `occasion` | 适用场合 | 本仓无证据 | 必须人工/后台给值 |
| 17 | `surface_recommendation` | 适用表面 | 本仓无证据 | 必须人工/后台给值 |
| 18 | `assembly_required` | 是否需要组装 | 本仓无证据 | 必须人工/后台给值 |
| 19 | `installation_type` | 安装方式 | 本仓无证据 | 必须人工/后台给值 |
| 20 | `reversible` | 是否双面可用 | 本仓无证据 | 必须人工/后台给值 |
| 21 | `cushion_type` | 坐垫类型 | 本仓无证据 | 必须人工/后台给值 |
| 22 | `fabric_care` | 面料护理 | 本仓无证据 | 必须人工/后台给值 |
| 23 | `product_benefits` | 产品益处 | 本仓无证据 | 必须人工/后台给值 |
| 24 | `water_resistance_level` | 防水等级 | 本仓无证据 | 必须人工/后台给值 |
| 25 | `weather_resistant` | 耐候性 | 本仓无证据 | 必须人工/后台给值 |
| 26 | `warranty_description` | 保修说明 | 本仓无证据 | 必须人工/后台给值 |

## 怎么补

页面：优化 → 属性补齐（填 ASIN → 读取属性 → 逐项填 → 保存属性）

命令行：

```
amzn_asin_attribute_set { asin: "B0GV55Q4JG", marketplace: "US", values: { "country_of_origin": "China" } }
```

拒绝规则（与工具同一实现）：未知属性 id、空值、占位值（N/A / 待定 / 无 / -）一律不写库。
