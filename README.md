# 拼多多工作台（pdd-workbench）

功能一：把拼多多「待收货」订单导出并落进本机 SQLite —— 订单号、物流单号、商品与数量、商家店铺、收货人、手机号、收货地址。

**只采指定日期内的订单，日期以「下单时间」为准**：默认最近 2 天（含今天，例如今天 10-27 就取 10-26 00:00 ~ 10-27 23:59），可用 `days` / `from` / `to` 指定；有新订单再跑一次即可（已入库的自动跳过）。

## 数据落在哪

| 项 | 位置 |
|---|---|
| 数据库 | `C:\Users\<你>\.dsh-pdd-workbench\orders.db`（SQLite，可直接用任何客户端打开） |
| 配置 | `C:\Users\<你>\.dsh-pdd-workbench\config.json` |
| CSV 导出 | `C:\Users\<你>\.dsh-pdd-workbench\exports\` |
| 浏览器登录态 | `C:\Users\<你>\.dsh-pdd-workbench\chrome-profile\`（独立 profile，不动你日常 Chrome） |

表结构：

- `orders`：一单一行。`order_sn` 主键，含 `status_text / shop_name / receiver_name / receiver_phone / province+city+district+address / tracking_no / carrier / order_time / ship_time / goods_amount_cents / pay_amount_cents / item_count / item_qty / updated_at`
- `order_items`：一商品一行。`order_sn + goods_id + sku_id` 主键，含 `goods_name / spec / qty / unit_price_cents / thumb_url / link_url`
- `sync_runs`：每次同步的运行记录（看了多少单、新增多少、失败多少）

## 怎么用

工具：`pdd_workbench`

| action | 作用 |
|---|---|
| `status` | 浏览器是否连着、是否登录、库里多少单、上一轮跑到哪 |
| `login` | 拉起自动化浏览器并切到扫码登录（**二维码只能你自己扫**，插件不接触账号密码） |
| `export` | 后台同步。`tab=pending`（待发货）/ `shipped`（已发货）/ `both`（两个都跑）；默认 `days=2`，可用 `from`/`to` |
| `stats` | 总量、带物流号/带手机号的数量、最近一次运行 |
| `list` | 查明细（`tab` 三个标签、`days`/`from`/`to` 日期区间、`order=asc` 升序、`keyword` 搜索） |
| `exportXlsx` | 导出 Excel（带列宽；物流单号/手机号按**文本**写入，不再变成 1.58E+10） |
| `exportCsv` | 导出 CSV（UTF-8 BOM） |
| `openDir` | 打开导出目录（只允许导出目录，不能当任意路径执行器） |
| `importXianyu` | 导入闲鱼订单导出 xlsx（`path`） |
| `matchXianyu` | 闲鱼 ↔ 拼多多 / 1688 智能核对（手机号→姓名→地址→商品→时间） |
| `xianyuList` | 核对结果（含**标识**、置信度、依据、来源平台、另一候选） |
| `exportMatches` | 导出**核对明细** CSV：每条闲鱼单一行，含「标识 / 需要人工 / 置信度」列 |
| `audit` | **智能审核**：全库一致性体检（重复单号、悬空匹配、运单号被多单共用、日期不一致…） |
| `exportShipping` | 生成**闲鱼批量发货模板**：只输出「闲鱼待发货 + 来源已发货」的配对 |
| `import1688` | 导入 1688「导出当前条件」下载的 xlsx（`path`），入库 `platform=1688` |
| `import1688Latest` | 自动找最新的 1688 导出文件（插件下载目录 + 用户下载目录）并导入 |
| `sync1688` | 1688 全自动导出：开列表 → 导出当前条件 → 生成新报表 → 等报表成功 → 下载 → 入库 |
| `fetch1688Report` | 只取「还没入过库的最新报表」：下载 + 入库，幂等可反复调 |
| `preflight` | 采集前自检：浏览器/Python/目录/库/上次采集；`deep:true` 加查两平台登录态 |
| `checkLogin` | 真去检测 **拼多多 / 1688 是否已登录**，结果写缓存（10~30 秒） |
| `status` 里的 `platforms` | 面板用的登录态快照（读缓存，秒回），每个平台带 level/text/detail/guide |
| `carrierMap` | 快递映射表：`op=list/set/del`，`platform` 可 `1688`/`pdd`/`*` |
| `statusHistory` | 某单的状态/物流变化留痕 |
| `setMatch` | 人工指定某条闲鱼单用哪个来源订单（`xySn` + `orderSn`） |
| `openDataDir` | 打开数据目录（`orders.db` 所在处） |
| `order` | 单条订单详情（含商品行） |
| `config` | 改 `cdpUrl / chromePath / profileDir / recentDays / pythonPath / xianyuTemplate / pacing` |

## 防重复导入与状态变化

- **去重键**：`order_sn`（1688 是 19 位数字、拼多多是 `YYMMDD-15位`，不会串）。重复导入走 UPSERT，不新增行。
- **空值不覆盖**：再次导入时某个字段没读到（平台改版、导出缺列），用 `COALESCE` 保留旧值 —— 不会把已抓到的手机号/地址/运单号抹成空。
- **状态留痕**：同一单状态变了（待发货 → 待收货）或补上运单号，写一条 `order_status_history`，用 `action=statusHistory` 查。

## 智能审核的「标识」约定

每条核对结果都带一个标识，界面、工具返回、导出文件三处一致：

| 标识 | badge | 含义 | 需要人工 |
|---|---|---|---|
| 已匹配 | `auto` | 手机号对上且分数 ≥ 0.75，一对一分配 | 否 |
| 人工确认 | `manual` | 人指定的（`setMatch`），自动核对不再覆盖 | 否 |
| 待确认 | `review` | 有候选但证据不足（手机号对不上/分数接近/两平台都能对上） | **是** |
| 未匹配 | `none` | 没有可用候选 | **是** |

- 置信度按分数：≥0.9 高 / ≥0.75 中 / ≥0.5 低；
- **没有来源单号的「未匹配」不带分数**（那是被否掉的候选残留，显示出来会误导）；
- `audit` 会把这些再核一遍：重复单号、悬空匹配、运单号被多单共用、已发货缺运单号、闲鱼待发货没配上、下单日期与时间不一致、运单号格式可疑、人工匹配手机号不一致。

## 智能审核（audit）输出

```json
{ "ok": false, "summary": "2 个错误、5 个提醒",
  "counts": { "error": 2, "warn": 5, "info": 5 },
  "findings": [{ "severity": "error", "code": "dup_tracking",
                 "title": "运单号被多单共用",
                 "detail": "777456713020054 → 261024-544231975292406,261024-200634591612406",
                 "trackingNo": "777456713020054" }] }
```

`ok=false` 只代表「有 error 级问题」，不代表不能发货；每条 finding 都能落到具体单号上。

分级口径（宁少报错、不多报错）：同一个运单号被多单使用，**同一收件人**（姓名+手机号一致）记 `info`「合并发货」，只有**不同收件人**共用才记 `error`。

## 环境状态：两个平台「是否已登录、是否具备采集条件」

面板顶部常驻两个徽章：`拼多多 · 已登录` / `1688 · 已登录`，外加一个总结论（两个都 ready 才显示「具备采集条件」）。

| level | 显示 | 含义 | 面板动作 |
|---|---|---|---|
| `ready` | 已登录 | 订单页/列表页能读到数据 | — |
| `need-login` | 未登录 | 跳到登录页或 cookie 过期 | 「去登录拼多多 / 去登录1688」按钮 |
| `offline` | 浏览器未启动 | 调试端口连不上 | 「打开登录页」会顺带把浏览器拉起来 |
| `unknown` | 未检测 / 检测已过期 | 没查过，或结果超过 30 分钟 | 「检测登录」按钮 |

**为什么要缓存**：真检测要开两个页面（10~30 秒），面板每 5 秒轮询扛不住，所以 `checkLogin` 写 `~/.dsh-pdd-workbench/platform-state.json`（带 `checkedAt`），`status` 只读它。

**为什么不假装已登录**：从没检测过就是「未检测」，超过 30 分钟就是「检测已过期」，判不出来会把原因带出来（例如「页面没渲染完或改版」）——这比显示一个假的绿点有用。

## 快递映射表（模板名对不上时用）

- 表：`carrier_map(platform, source_name, target_name)`，预置 10 个常见快递（中通/圆通/申通/韵达/邮政/极兔/顺丰/德邦/京东/优速）× 两个平台。
- 用法：`action=carrierMap op=set platform=1688 sourceName=韵达 targetName=韵达快递`；`platform=*` 是通用兜底。
- 导出时先查表 → 再按模板「物流公司」表的简称兜底 → 还匹配不上就原样写出，并在返回里给 `unmappedCarriers` 提醒你补映射。

## 数据在哪（最容易找不到的东西）

- 库文件：`C:\Users\78452\.dsh-pdd-workbench\orders.db` —— 所有平台的订单都在这**一个**库里，用 `platform` 区分 `pdd` / `1688`
- 导出：`C:\Users\78452\.dsh-pdd-workbench\exports\`
- 面板顶部常驻一行「拼多多 N · 1688 M（最新 日期）」，旁边两个按钮：**打开数据目录**、**打开导出目录**
- 面板默认只显示「最近 2 天」，看历史点日期栏的「全部」

## 1688 接入（v0.4）

**事实**：1688 买家工作台 `work.1688.com/_path_=buyer2017Base/procurement/buyList` 自带「导出当前条件 / 导出所选订单」，导出的 xlsx 有 50 列，我们需要的字段全在里面：

`订单编号 / 订单创建时间 / 订单状态 / 收货人姓名 / 收货地址 / 联系手机 / 联系电话 / 货品标题 / 单价 / 数量 / 卖家公司名 / 物流公司 / 运单号`

所以 1688 侧**不逐单抓详情页**（62 单要开 62 个页面），只做一件事：解析导出文件入库。

1. 1688 工作台选好筛选（下单时间、状态），点「导出当前条件」下载 xlsx；
2. 面板「1688 导出文件」填完整路径 → 点「导入 1688」；
3. 状态归一：`等待卖家发货 → 待发货`、`等待买家确认收货 → 待收货`、`交易关闭 → 已关闭`；
4. 核对时两个平台的订单进同一个候选池，**手机号对上才算自动匹配**；两平台都对得上时进「待确认」并显示「另一候选」，可用 `setMatch` 人工指定。

### 1688 导出：现在能全自动，但受「报表队列」约束

新版订单页是 `air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html`（Quark Web Components），导出走「报表中心」：

1. 点 **导出当前条件**（不用勾选）→ 弹窗；
2. 点 **生成新报表**（必要时再点 **确认**）；
3. 报表进队列，状态 `导出中` → `导出成功` 才有 **下载**（1688 自己提示「可能要 5 分钟」，实测有一次排了约 20 分钟）；
4. 点 **下载** → 文件落到 `~/.dsh-pdd-workbench/downloads/1688/` → 解析入库。

自动化的两段：

- `sync1688`：把 1~2 步做完，并原地等 3（最多约 8 分钟）；等到了就下载 + 入库，等不到返回 `REPORT_PENDING`；
- `fetch1688Report`：**过一会儿再调**，它从报表中心挑「导出成功且台账里没有」的那一行，下载 + 入库；用 `~/.dsh-pdd-workbench/ali1688-reports.json` 记账，反复调不会重复导。

> 之前点不中「生成新报表」，是因为同一个按钮在页面上渲染了两份，一份 `rect` 为 0（隐藏副本）。现在按「面积最小的可见节点」点，就能点中；「下载」同理。

命令行方式（同一套模块，不走宿主也能跑）：

```bash
node tools/sync.mjs --tab shipped --days 2   # 已发货（待收货）最近两天
node tools/sync.mjs --tab pending --days 2   # 待发货最近两天
node tools/sync.mjs --from 2026-10-27 --to 2026-10-27   # 指定某一天
node tools/sync.mjs --days 30       # 往前补 30 天
node tools/sync.mjs --limit 20      # 只抓 20 单
node tools/sync.mjs --refresh       # 已入库的也重抓
node tools/sync.mjs --from-list .tmp/orders.json   # 复用已收集的名单
```

## 闲鱼订单对接（功能二）

1. `importXianyu` 导入闲鱼「所有订单」xlsx（表头按列名匹配，38 列都收）。
2. `matchXianyu` 配对：
   - **手机号**对上才允许自动匹配（+0.62）；两边都有手机号却不同 → 直接负分淘汰；
   - 姓名（+0.12）、地址（+0.12）、商品标题（+0.05）、下单时间先后（+0.10）做辅助分；
   - 一对一贪心，同分时按下单时间就近分配；分数 <0.35 记「未匹配」，其余记「待确认」。
3. `exportShipping` 以 `批量发货导入模板.xlsx` 为底，只写「闲鱼待发货 + 拼多多已发货」的行，快递公司按模板里的「物流公司」表做名称映射（中通快递/圆通速递/邮政快递包裹…）。

> 闲鱼导出里，**已发货/已退款/交易关闭**的订单 `收件人/收件号码/收货地址` 是打码的（`潘**`、`138****4558`），只有**待发货**是完整信息 —— 所以核对主要对「待发货」这一批有效，这也是我们真正要发货的那批。

## 数据从哪来（不碰私有接口）

1. 打开 `orders.html?type=3`（待收货），像人一样慢慢滚到底；页面自己请求的订单列表响应里拿到 `order_sn` 清单。
2. 逐单打开 `order.html?order_sn=…`，读页面**已经下发**的 `window.rawData.data`（收货人、完整手机号、地址、物流单号、商品行都在里面）。
3. 页面改版导致 `rawData` 缺失时，兜底读 DOM 的 `aria-label="收货人信息: …"`。

## 风控设计（"规避"= 不制造异常行为，不是破解）

- **独立浏览器 profile**：只登录一次，不碰你日常 Chrome 的 cookie 和指纹。
- **只读**：不点「确认收货」、不改地址、不下单；只读页面已经渲染的内容。
- **单线程真人节奏**：一单一次真实页面打开，间隔 1.5–3.8 秒，每 8–10 单插一次 6–10 秒长停顿；列表是慢滚不是瞬移。
- **不并发、不调私有接口、不绕验证码**：看到验证码就停，等人处理。
- **增量**：已入库的默认跳过；失败的单下次自动重试。

## 已知边界（照实说）

- 手机号来自订单详情页下发的完整号码；**如果拼多多以后只下发掩码**，就只能拿到 `158****1167` 这种，插件会同时保留 `receiver_phone_mask`，不会假装有完整号码。
- 地址取订单快照（下单时的收货地址），不是地址簿当前值。
- 平台页面改版会破坏解析：`src/pdd.js` 里的 `collectOrderList` / `normalizeOrderDetail` 是唯一需要改的地方。
- 待收货列表的懒加载在快速滚动下会被"饿死"，所以滚到底用的是「卡片数有没有再涨」判断，慢但不会漏页。

## 安装进 profile（已装到 desktop）

1. profile 的 `package.json` 里加依赖（`link:` 形式）**和** `dsh.profile.bundles`。
2. `node_modules/@local/dsh-plugin-pdd-workbench` 指向本目录（junction/symlink）。
3. **重启 DeepSeekRuntime**，工具 `pdd_workbench` 才会出现。

⚠️ 按 `docs/plugin-contract.md` 坑 5：在 profile 里跑 `pnpm install` 会把 junction 换成副本，
代码改了不生效。装完要重跑 harness 的 `scripts/link-user-plugins.ps1`（或手工重建 junction）。

## 目录

```
index.js          工具 + HTTP 面板 + 后台任务
src/cdp.js        极简 CDP 客户端
src/pdd.js        列表 / 详情 / 归一化
src/store.js      SQLite 表结构与读写
tools/            开发探针与命令行入口
test/             归一化与插件装配的单元测试
```
