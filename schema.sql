-- SIF 数据台 · 本地库 DDL（SQLite / node:sqlite）
-- 设计原则：
--   1) 一切时序表都是「对象 × 周期」的窄表，主键 = 幂等键，重抓覆盖不累加；
--   2) 分数字段一律带 _score 后缀，且不可跨站点直接比较；
--   3) 未知一律 NULL，绝不用 0 表示「没有数据」（0 和「没测到」是两件事）；
--   4) 原始 JSON 单独存 sif_raw，可重放、可复算、可追责。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 对象主档 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sif_asin (
  marketplace        TEXT NOT NULL,
  asin               TEXT NOT NULL,
  title              TEXT,
  brand              TEXT,
  price              REAL,
  currency           TEXT,
  star_rating        REAL,
  rating_num         INTEGER,
  bsr_rank           INTEGER,          -- 取 bsr_list 中主类目（第一个）的 rank
  bsr_category       TEXT,
  first_available_day TEXT,
  variation_num      INTEGER,
  color              TEXT,
  size               TEXT,
  weight_oz          REAL,
  package_dims_json  TEXT,
  feature_list_json  TEXT,
  item_highlights    TEXT,
  observed_at        TEXT NOT NULL,    -- 这次画像的抓取时刻（ISO）
  data_date          TEXT,             -- 数据截止日（data_notice 解析）
  PRIMARY KEY (marketplace, asin)
);

-- 画像快照：要回答「价格/评分/BSR/评论数怎么变的」，只能靠自己的历史
CREATE TABLE IF NOT EXISTS sif_asin_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace   TEXT NOT NULL,
  asin          TEXT NOT NULL,
  observed_at   TEXT NOT NULL,
  data_date     TEXT,
  price         REAL,
  star_rating   REAL,
  rating_num    INTEGER,
  bsr_rank      INTEGER,
  variation_num INTEGER,
  payload_json  TEXT NOT NULL,
  UNIQUE (marketplace, asin, observed_at)
);

-- ── 流量（运营结果域）───────────────────────────────────────
CREATE TABLE IF NOT EXISTS sif_traffic (
  marketplace    TEXT NOT NULL,
  asin           TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'listing',   -- listing=父体+子体聚合 / single
  period_type    TEXT NOT NULL CHECK (period_type IN ('day','week','month')),
  period_start   TEXT NOT NULL,                     -- 周期首日 YYYY-MM-DD
  total_score    REAL,
  nf_score       REAL,          -- 自然
  ad_score       REAL,          -- 广告合计
  sp_score       REAL,          -- SP 常规
  rec_sp_score   REAL,          -- SP 推荐
  sb_score       REAL,
  sbv_score      REAL,
  total_change   REAL,
  total_change_ratio REAL,
  nf_ratio       REAL,
  ad_ratio       REAL,
  price          REAL,          -- 仅 day 粒度有
  bsr_rank       INTEGER,       -- 仅 day 粒度有
  star_rating    REAL,
  review_num     INTEGER,
  is_complete    INTEGER,       -- 末点是否已跑完（1/0/NULL）
  tool           TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  data_date      TEXT,
  PRIMARY KEY (marketplace, asin, scope, period_type, period_start)
);
CREATE INDEX IF NOT EXISTS idx_sif_traffic_asin ON sif_traffic (marketplace, asin, period_start DESC);

-- Listing 渠道结构：渠道键是动态的，整体存 JSON，另把三个主干提成列便于比大小
CREATE TABLE IF NOT EXISTS sif_listing_overview (
  marketplace  TEXT NOT NULL,
  asin         TEXT NOT NULL,
  window_type  TEXT NOT NULL,        -- latelyDay / week / month
  window_value TEXT NOT NULL,        -- '7' / '2026-11-01' / ...
  total_score  REAL,
  nf_ratio     REAL,
  ad_ratio     REAL,
  payload_json TEXT NOT NULL,
  data_date    TEXT,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (marketplace, asin, window_type, window_value)
);

-- ── 销量 ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sif_sales_month (
  marketplace   TEXT NOT NULL,
  asin          TEXT NOT NULL,
  month         TEXT NOT NULL,       -- YYYY-MM
  bought        REAL,                -- 该月销量（整数序列里取到的值，可能为 NULL）
  bought_band   TEXT,                -- 前台档位文本，如 "<50" / "5,000+"
  bought_lower  REAL,                -- 档位下界（解析值，用于排序/筛选）
  is_parent     INTEGER,             -- 1=父体口径
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (marketplace, asin, month, is_parent)
);

-- ── 关键词 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sif_keyword (
  marketplace  TEXT NOT NULL,
  keyword      TEXT NOT NULL,
  translate    TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  PRIMARY KEY (marketplace, keyword)
);

-- ABA 周序列：1 点拿 320 周，是整套数据里性价比最高的一张
CREATE TABLE IF NOT EXISTS sif_keyword_aba (
  marketplace          TEXT NOT NULL,
  keyword              TEXT NOT NULL,
  week_start           TEXT NOT NULL,
  volume               REAL,
  rank                 INTEGER,
  top3_click_share     REAL,
  top3_conversion_share REAL,
  top3_asins_json      TEXT,
  fetched_at           TEXT NOT NULL,
  PRIMARY KEY (marketplace, keyword, week_start)
);
CREATE INDEX IF NOT EXISTS idx_sif_aba_kw ON sif_keyword_aba (marketplace, keyword, week_start DESC);

-- 需求诊断快照（按统计周落，同一周重抓覆盖）
CREATE TABLE IF NOT EXISTS sif_keyword_demand (
  marketplace        TEXT NOT NULL,
  keyword            TEXT NOT NULL,
  period_start       TEXT NOT NULL,   -- ctr_data_period
  search_volume      REAL,
  search_ctr_week    REAL,
  search_ctr_90d     REAL,
  clicks_week        REAL,
  clicks_90d         REAL,
  search_volume_90d  REAL,
  diagnosis          TEXT,            -- 中文标签：健康增长 / 结构性下滑叠加季节低谷 …
  momentum           TEXT,
  trend_direction    TEXT,
  yoy_change         REAL,
  annual_decay_rate  REAL,
  season_strength    TEXT,
  peak_month         INTEGER,
  trough_month       INTEGER,
  weeks_to_peak      INTEGER,
  weeks_to_trough    INTEGER,
  season_position    TEXT,
  vs_seasonal_baseline REAL,
  demand_type        TEXT,
  demand_confidence  TEXT,
  ad_strategy_hint   TEXT,
  interpretation     TEXT,
  action_hint        TEXT,
  fetched_at         TEXT NOT NULL,
  PRIMARY KEY (marketplace, keyword, period_start)
);

-- ASIN × 关键词：反查表，缺口判定都在这张表上算
CREATE TABLE IF NOT EXISTS sif_asin_keyword (
  marketplace        TEXT NOT NULL,
  asin               TEXT NOT NULL,
  keyword            TEXT NOT NULL,
  period_type        TEXT NOT NULL DEFAULT 'lately',  -- lately / week / month
  period_value       TEXT NOT NULL,                   -- '30' / '2026-11-01'
  traffic_share      REAL,
  contri_change      REAL,        -- 归因份额，不是增长率
  contri_severity    TEXT,
  organic_page       INTEGER,     -- 从 'p2,11/48' 解析：2
  organic_pos        INTEGER,     -- 11
  organic_total      INTEGER,     -- 48
  organic_rank_raw   TEXT,        -- 原样保留
  sp_rank            TEXT,
  sb_rank            TEXT,
  rank_evolution     TEXT,
  gap_severity       TEXT,
  keyword_health     TEXT,
  traffic_dependency TEXT,
  channel_coverage_json TEXT,
  keyword_tags_json  TEXT,
  fetched_at         TEXT NOT NULL,
  data_date          TEXT,
  PRIMARY KEY (marketplace, asin, keyword, period_type, period_value)
);
CREATE INDEX IF NOT EXISTS idx_sif_ak_asin ON sif_asin_keyword (marketplace, asin, traffic_share DESC);

-- ── 竞品与市场格局 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sif_competitor (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace   TEXT NOT NULL,
  keyword       TEXT NOT NULL,         -- 词或词根
  scope         TEXT NOT NULL,         -- competition / root_competitors / discover
  asin          TEXT NOT NULL,
  share         REAL,
  natural_share REAL,
  sp_share      REAL,
  price         REAL,
  reviews       INTEGER,
  posture       TEXT,
  payload_json  TEXT,
  observed_at   TEXT NOT NULL,
  data_date     TEXT,
  UNIQUE (marketplace, keyword, scope, asin, observed_at)
);

-- ── 广告三层 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sif_ad_campaign (
  marketplace   TEXT NOT NULL,
  asin          TEXT NOT NULL,
  campaign_id   TEXT NOT NULL,
  display_id    TEXT,
  campaign_type TEXT,                  -- SP / SB / SBV
  name          TEXT,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  PRIMARY KEY (marketplace, asin, campaign_id)
);

CREATE TABLE IF NOT EXISTS sif_ad_campaign_week (
  marketplace  TEXT NOT NULL,
  asin         TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  week_start   TEXT NOT NULL,
  score        REAL,
  share        REAL,
  exposure     REAL,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (marketplace, asin, campaign_id, week_start)
);

CREATE TABLE IF NOT EXISTS sif_ad_group (
  marketplace  TEXT NOT NULL,
  asin         TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  ad_group_id  TEXT NOT NULL,
  display_id   TEXT,
  variant_count INTEGER,
  keyword_count INTEGER,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  PRIMARY KEY (marketplace, asin, campaign_id, ad_group_id)
);

CREATE TABLE IF NOT EXISTS sif_ad_group_keyword (
  marketplace  TEXT NOT NULL,
  asin         TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  ad_group_id  TEXT NOT NULL,
  keyword      TEXT NOT NULL,
  week_start   TEXT NOT NULL,
  share        REAL,
  display_asins_json TEXT,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (marketplace, asin, campaign_id, ad_group_id, keyword, week_start)
);

-- ── 运维：同步记录 / 原始响应 / 配额 / 洞察 / 报告 ──────────
CREATE TABLE IF NOT EXISTS sif_sync_run (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  level        TEXT NOT NULL,          -- L1 / L2 / L3
  tool         TEXT NOT NULL,
  params_json  TEXT,
  params_hash  TEXT NOT NULL,
  objects_json TEXT,
  cost_points  REAL,                   -- 实际扣点（来自 _quota.costThisCall）
  rows_written INTEGER,
  status       TEXT NOT NULL,          -- running / ok / failed / skipped(cache)
  error        TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT
);

CREATE TABLE IF NOT EXISTS sif_raw (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool        TEXT NOT NULL,
  params_json TEXT,
  params_hash TEXT NOT NULL,
  data_date   TEXT,
  cost_points REAL,
  ok          INTEGER NOT NULL,
  response_json TEXT,
  fetched_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sif_raw_hash ON sif_raw (params_hash, fetched_at DESC);

CREATE TABLE IF NOT EXISTS sif_quota_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tool         TEXT,
  cost_this_call REAL,
  remaining    REAL,
  period_start TEXT,
  period_end   TEXT,
  recorded_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sif_insight (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL,
  asin        TEXT,
  keyword     TEXT,
  kind        TEXT NOT NULL,      -- gap / ad_dependency / structural_decline / paradox / season_window
  severity    TEXT NOT NULL,      -- high / medium / low
  title       TEXT NOT NULL,
  evidence_json TEXT NOT NULL,    -- 判定依据（哪个词、哪一周、差几位）
  suggestion  TEXT,
  computed_at TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open'   -- open / accepted / dismissed
);
CREATE INDEX IF NOT EXISTS idx_sif_insight ON sif_insight (marketplace, asin, state, severity);

CREATE TABLE IF NOT EXISTS sif_report (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL,
  asin        TEXT,
  kind        TEXT NOT NULL,      -- daily / weekly / ad_review / kw_research / market
  title       TEXT NOT NULL,
  markdown    TEXT NOT NULL,
  range_from  TEXT,
  range_to    TEXT,
  created_at  TEXT NOT NULL
);

-- ── 视图：把常用判定固化成 SQL，模型和页面用同一口径 ────────
CREATE VIEW IF NOT EXISTS v_traffic_last8w AS
SELECT marketplace, asin, period_start, total_score, nf_score, ad_score,
       nf_ratio, ad_ratio, total_change_ratio
FROM sif_traffic
WHERE period_type = 'week';

CREATE VIEW IF NOT EXISTS v_ad_dependency AS
SELECT marketplace, asin, period_start, ad_ratio, total_score
FROM sif_traffic
WHERE ad_ratio IS NOT NULL AND ad_ratio >= 0.6;

CREATE VIEW IF NOT EXISTS v_kw_gap AS
SELECT marketplace, asin, keyword, traffic_share, organic_page, organic_pos,
       organic_total, gap_severity, rank_evolution,
       (organic_total - organic_pos + 1) AS positions_left_in_page
FROM sif_asin_keyword
WHERE organic_page IS NOT NULL AND organic_page >= 2;   -- p2 及以后 = 没进首页

CREATE VIEW IF NOT EXISTS v_aba_latest AS
SELECT a.marketplace, a.keyword, a.week_start, a.volume, a.rank,
       a.top3_click_share, a.top3_conversion_share
FROM sif_keyword_aba a
JOIN (SELECT marketplace, keyword, MAX(week_start) AS w
      FROM sif_keyword_aba GROUP BY marketplace, keyword) m
  ON m.marketplace = a.marketplace AND m.keyword = a.keyword AND m.w = a.week_start;
