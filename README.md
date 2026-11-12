# sif-ops · SIF 数据台（设计中，未实现）

把 SIF MCP 的 32 个工具变成「一次取数、长期可查、能出结论」的本地运营台。
**当前状态：方案 + 库结构已定并跑通验证；插件代码尚未开写。**

## 文档

| 文件 | 内容 |
|---|---|
| [01-插件设计方案](docs/01-插件设计方案.md) | 为什么独立插件、侧边栏与页面结构、配置页三条硬规则、模型工具面、同步编排、验收标准 |
| [02-数据存放方案](docs/02-数据存放方案.md) | 四层数据流、幂等主键、两个时间轴、粒度与保留、点数预算、口径陷阱、与 amazon-ops 的只读桥接 |
| [03-SIF工具数据结构速查](docs/03-SIF工具数据结构速查.md) | 32 个工具的返回结构与坑（实测） |
| [04-运营运用方案](docs/04-运营运用方案.md) | 四角色分工、日/周/月节拍、判定阈值表、B0GK5ZDJK9 实战、报告模板、不该用 MCP 的场景 |
| [07-官方手册模块拆解](docs/07-官方手册模块拆解.md) | SIF 官方五份手册的模块拆解、四条共通方法论、与现有能力的映射与缺口 |
| [08-两条业务线整体设计方案](docs/08-两条业务线整体设计方案.md) | 存量优化 + 新品调研两条业务线：族谱展开、竞品集确认、CDP 全字段采集、逐字段对照报告、政策校验、复测闭环、分期验收 |
| [09-详细设计与原型说明](docs/09-详细设计与原型说明.md) | 页面/字段/状态机/接口/数据表/测试；官方手册映射、来源与分析策略、ASIN 全字段与主/父/子体管理 |
| [可交互页面原型](docs/sif-ops-prototype.html) | ASIN 管理、族谱、竞品、词库、采集、对照报告、复测、来源策略、新品调研；全部为演示数据 |
| [10-设计原型验证记录](docs/10-设计原型验证记录.md) | 原型交互实测、截图与明确不覆盖的真实业务验收范围 |
| [schema.sql](schema.sql) | 19 张表 + 4 个视图的可执行 DDL |
| [tools/schema-smoke.mjs](tools/schema-smoke.mjs) | 冒烟脚本：建库 → 灌真实样本 → 跑 4 个业务问题 |

## 已验证（2026-11-05）

```
node tools/schema-smoke.mjs
→ 19 表 + 4 视图建表通过；PRAGMA integrity_check = ok
→ 同周重抓：裸 INSERT 被主键拒绝（10 行不变），UPSERT 后仍 10 行、值更新
→ v_traffic_last8w / v_ad_dependency / v_kw_gap / v_aba_latest 各给出正确结果
```

## 下一步（待拍板后开写）

1. `package.json` + `cordis.patch.yml` + `lib/client.js`（侧边栏 + iframe 面板）
2. `src/mcp.js`（Bearer · streamable-http · 会话复用 · 6 小时缓存）
3. `src/web/*`（5 页签，连接页先做）
4. `src/sync/*`（L1/L2 importer，先跑通 `ops_get_asin_traffic_trend`）
5. 装进 desktop profile → 用 B0GK5ZDJK9 验收：L1 跑一次 5 点、看板出曲线
