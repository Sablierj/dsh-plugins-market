# SIF 32 个工具 · 数据结构速查（2026-11-05 实测）

> 目的：写 importer 时不用回去翻文档。**加粗**的是入库锚点字段；`⚠️` 是实测踩到的坑。
> 全站共 32 个业务工具 + 3 个免费元工具；点数取自 `sif_catalog`（0 点）。

## 0. 三条全局事实

1. **所有业务返回带 `data_notice`**：`Data updated through 2026-11-04 (refreshes daily, 1-day delay)` —— 数据截止日**不是**今天，入库必须存这个日期，否则日报会拿昨天的数当今天。
2. **所有返回带 `_quota`**：`{tool, costThisCall, remainingTotal}` —— 每次调用就是一次配额记录，直接进 `sif_quota_log`。
3. **`returnFields` 可裁列**：点名顶层字段；列表支持 `parent[:N]` 截行 / `parent[].col` 裁列。⚠️ 裁了列就不带行内 `_formatted`；`latest_point_complete` 这类键在某些工具里点不到（实测 `ops_get_asin_traffic_trend` 返回 `_notice: returnFields 未生效项`）。

## 1. 系统（0 点）

| 工具 | 返回 | 用途 |
|---|---|---|
| `ping` | `{pong, timestamp, _quota}` | 连通性 |
| `sif_catalog` | `{title, categories[]}`，每个工具带 `cost` | 价目表 + 功能目录 |
| `query_quota` | `{scopes[], remainingTotal, periodStart/End}` | 余额与计费周期 |

## 2. ASIN 画像（`market_get_asin_profile`，2 点/ASIN）

返回 `list[]`，每项锚点：
**`asin` `title` `brand` `price` `star_rating` `rating_num` `bought_in_past_month` `first_available_day` `variation_num`** `color` `size` `weight` `weight_oz` `dimensions` `item_highlights` `feature_descriptions[]` `feature_list[]` **`bsr_list[]`（`{category_id, category_name, rank}`）** `package_dims_in{}` `package_weight_oz` `dimension_source`。
⚠️ `asin` 字段返回的是 markdown 链接 `[B0…](https://amazon.com/dp/B0…)`，**入库前要剥壳**。⚠️ 这是**当下快照**，没有历史——要「基本面变化史」只能靠我们每次抓取存 `sif_asin_snapshot`。

## 3. 流量（运营结果域）

### `ops_get_asin_traffic_trend`（2 点）
`dates[]` 与下列**平行数组按下标一一对应**：
| 数组 | 元素 | 含义 |
|---|---|---|
| `totalScore[]` / `nfScore[]` / `adScore[]` / `spScore[]` / `sbScore[]` / `sbvScore[]` | `{score, scoreRatio, scoreChange, scoreChangeRatio, contriChangeRatio}` | 每期流量分与变化 |
| `bsr[]` `buyboxPrice[]` `star[]` `review[]` `boughtInPastMonth[]` | 标量 | **仅 `granularity=day` 才有值**（week/month 返回空数组） |
| `trend_analysis` | `{overall_direction, recent_change, anomaly_weeks[]}` | 工具自带的粗判 |
| `latest_point_date` / `latest_point_complete` | 末点日期 / 是否跑完 | ⚠️ 末点可能是「今天但没跑完」，算环比要先排除 |

入参：`granularity=day|week|month`、`lastDays` 或 `lastMonths(3/6/12/24)` 或 `beginDate/endDate`、`listingSearch`（默认 true=父体+子体聚合）。
⚠️ **父体口径不能和明细工具求和互校**（明细不支持 listingSearch）。⚠️ `sbScore` 有 `null`（该期无 SB 流量），写库要保留 `NULL` 而不是 0。

### `ops_get_asin_traffic_trend_detail`（3 点）
`details[]`：**`keyword`** `score` `scoreRatio` `diffScore` `affectWholeRatio` `pchangeReason{nfInfo,spInfo,sbInfo…}` `extraData`；`total`、`pagination`。
⚠️ 只支持单 ASIN；`inFre=0` / `rankAvg` 缺失**不能**说「掉出前三页」，只能说「本期未出现在采集数据中」。

### `ops_get_listing_traffic_overview`（3 点）
嵌套三块：`overview{ad, nf}`、`ad{sp, recommend, sb, sbv…}`、`recommend{Customers frequently viewed, Picks from Amazon Influencers, Seen on social media, 4 stars and above}`；每个节点 `{name, wholeName, score, ratio}`；加 `total`。
⚠️ 渠道键**动态**，不能假设固定字段；某渠道缺席 = 无数据，不是 0。

### `ops_get_listing_traffic_structure`（3 点）
`chars{dims[], nfs[], sps[], recs[], sbs[], sbvs[], acs[], ers[], trs[]}` —— **平行数组按 `dims` 下标配对**；`ratio` 纵向占比、`dist` 横向占比，两者别混。

## 4. 销量

- `ops_get_asin_sales_trend`（1 点）：`boughtHistoryDates[]` + `chars[]{dims, boughtList[]{bought, ratio, boughtInPastMonthBest}}`；`boughtInPastMonth`/`pasinBoughtInPastMonth` 是**前台档位文本**（`"<50"`、`"5,000+"`），不是精确数，入库要原样存文本 + 另存解析出的下界。
- `ops_get_asin_sales_list`（1 点/ASIN）：`asins[]{asin, boughtInPastMonth, boughtHistory[], boughtHistoryDates[], …}`。

## 5. 反查关键词

### `market_get_asin_keyword_signals`（3 点）—— 最重要的表
`summary{total_keywords_in_period, top_keywords_analyzed}`、`primary_signals{declining[], gaining[], rank_gaps[]}`、`top_keywords[]`（每项：**`keyword` `traffic_share` `contri_change` `contri_severity` `organic_rank`（`"p2,11/48"` 字符串，页+位/总数） `sp_rank` `sb_rank` `rank_evolution` `gap_severity` `keyword_health` `traffic_dependency` `channel_coverage` `keyword_tags[]`**）、`pagination`。
⚠️ `contri_change` 是**归因份额**（该词占整个 ASIN 波动的比例），不是该词增长率。⚠️ `pagination.poolComplete=false` 时必须说「共 85 词，本次纳入 3 词」。

### `ops_get_listing_keyword_distribution`（2 点）
`asins[]{asin, total, natural, ad, sp, rec, brand, vedio, …}` —— 是**词数**，不是流量分。

### `market_get_asin_aba_footprint`（2 点）
`rank_distribution`、`total_keyword_count`、`total_covered_volume`、`keywords[]{keyword, rank, volume…}` —— 买家真实点击视角的 top3 卡位。

## 6. 关键词需求与竞争

### `market_get_keyword_history`（1 点）—— ABA 原始序列
每词：**`dates[]`（周，最早 2020-09，实测 320 点）`volumes[]` `ranks[]` `top3_click_shares[]` `top3_conversion_shares[]`** `latest{date, volume, rank, top3_asins[], top3_click_share, top3_conversion_share}` `data_points` `translateKeyword`。
⚠️ 平行数组，必须按下标配对；一次 1 点拿 6 年历史，性价比最高的表。

### `market_get_keyword_demand`（2 点）—— 需求诊断
`profiles[]`：`search_ctr_week` `search_ctr_90d` `clicks_week` `clicks_90d` `search_volume_90d` `ctr_data_period`、`demand_structure{primary_type, type_confidence, detected_signals[], competitive_dimension, ad_strategy_hint}`、`data_coverage{weeks, years, from, to}`、`current{search_volume, season_position, vs_seasonal_baseline}`、`trend{direction, yoy_change, annual_decay_rate, strength, momentum, recent_weeks[], recent_quarters[], annual_rate_evidence[], recent_yoy_evidence}`、`seasonality{strength, peak_months[], trough_months[], amplitude}`、**`diagnosis`（中文标签）** `interpretation` `weeks_to_peak` `weeks_to_trough` `action_hint`。
⚠️ `action_phase` 是内部标签不能外显，用 `action_hint`。

### `market_get_keyword_competition`（2 点）
`top_competitors[]`（`asin, share, natural_share, sp_share, brand_share, video_share, listed_at…`）、`concentration_profile`、`demand_snapshot`、`my_position`、`system_state`、`strategy_path`。

### `market_get_keyword_root_trend`（3 点）
`dates[]` `keyword_search_volumes[]` `ext_search_volumes[]` `keyword_ranks[]` `latest` —— 精确词 vs 词根总盘。

### `market_screen_keyword_opportunities`（3 点）
`keywords[]`（`keyword, search_volume(周), clicks_week, search_ctr_week, 竞争指标…`）+ `coverage_mode` + `not_indexed`。
⚠️ `search_volume` 是**单周**量，禁止 ×4 当年。

### `market_get_keyword_root_competitors`（2 点）
`competitors[]{asin, share, title, price, reviews, posture…}` + 集中度三判断。

### `market_discover_competitors`（3 点）
`landscape{price_bands[], review_tiers[], order_tiers[]}` + `competitors[]`（四维特征）。

### `market_assess_keyword_promotion`（1~4 点）
`assessments[]`：`verdict_bridge` `judgment` `recommendation` `supporting_signals{search_volume, break_even_cvr, cpa_fixed_exact, actual_acos_fixed_exact, profit_gap_fixed_exact…}` —— 出价区间与盈亏平衡。

## 7. 广告（ASIN → Campaign → Ad Group 三层）

| 工具 | 点数 | 返回锚点 |
|---|---|---|
| `ads_get_asin_ad_structure` | 2 | `ad_types[]{type, campaign_count}`、`total_campaign_count`、`structureScope` |
| `ads_get_asin_ad_traffic_trend` | 3 | 按 SP/SB/SBV 三维曝光时序 |
| `ads_get_asin_campaign_changes` | 3 | `campaign_changes[]`（新建 campaign 的事件流） |
| `ads_get_asin_campaign_contribution_overview` | 3 | `campaigns[]{campaignId, campaignDisplayId, campaignType, share/score…}` |
| `ads_get_campaign_structure` | 3 | `adGroups[]{adGroupId, …}`、`adGroupCount` |
| `ads_get_campaign_traffic_trend` | 5 | 单 campaign 全生命周期时序 + `events[]` |
| `ads_get_campaign_contribution_breakdown` | 3 | `items[]`（按 keyword 或 ad_group 拆） |
| `ads_get_ad_group_traffic_trend` | 3 | 单 ad group 时序 |
| `ads_get_ad_group_keyword_breakdown` | 3 | `keywords[]` + `displayAsins[]` |
| `ads_get_asin_ad_window_feature_profile` | 5 | `features{}` + `signals{}`（结构/集中度/节奏） |
| `ads_get_asin_ad_historical_feature_profile` | 5 | `evolution_summary.phases[]` |
| `ads_get_asin_ad_feature_profile` | 5 | ⚠️ **已废弃**，不要用 |

⚠️ 广告时间窗一律按**周**，`start_date` 必须是周日，`end_date = start+6`；当周数据 T+1 才有。

## 8. 场景工具

`analyze_traffic_anomaly`（10 点）：`judgment` `cause_summary` `reasoning_path[]` `evidence[]` `recommendation` `confidence_gaps[]` `culprit_demand_structure`。端到端归因，**不用于日常同步**。

## 9. 入库映射速查

| 来源 | 目标表 | 粒度 |
|---|---|---|
| `market_get_asin_profile` | `sif_asin` + `sif_asin_snapshot` | 每 ASIN 每次抓取 |
| `ops_get_asin_traffic_trend` | `sif_traffic` | ASIN × 周/日/月 |
| `ops_get_listing_traffic_overview` / `structure` | `sif_listing_overview`（JSON） | Listing × 窗口 |
| `ops_get_asin_sales_trend` | `sif_sales_month` | ASIN × 月 |
| `market_get_asin_keyword_signals` | `sif_asin_keyword` | ASIN × 词 × 窗口 |
| `market_get_keyword_history` | `sif_keyword_aba` | 词 × 周 |
| `market_get_keyword_demand` | `sif_keyword_demand` | 词 × 统计周 |
| `market_get_keyword_competition` / root_competitors | `sif_competitor` | 词 × 抓取时点 |
| `ads_get_asin_ad_structure` / campaign_* | `sif_ad_campaign*` | ASIN × campaign |
| 所有工具 | `sif_raw`（原始 JSON）+ `sif_quota_log` | 每次调用 |
