/**
 * 迁移链。**只追加，不修改**：已经在用户机器上跑过的版本，改动它等于让两个库变成两种形状。
 * 新需求一律新增一条 { version: n+1, statements: [...] }。
 *
 * v1 = 建库（与 docs/02 的口径一致）；DDL 的说明版在仓库根的 schema.sql，
 * 这里冻结成字符串，是为了「旧库能一路升上来」而不依赖外部文件。
 */

const V1 = [
  `CREATE TABLE IF NOT EXISTS sif_object (
    marketplace TEXT NOT NULL,
    asin        TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT 'mine',   -- mine / competitor
    note        TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (marketplace, asin)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_asin (
    marketplace TEXT NOT NULL, asin TEXT NOT NULL,
    title TEXT, brand TEXT, price REAL, currency TEXT,
    star_rating REAL, rating_num INTEGER,
    bsr_rank INTEGER, bsr_category TEXT,
    first_available_day TEXT, variation_num INTEGER,
    color TEXT, size TEXT, weight_oz REAL,
    package_dims_json TEXT, feature_list_json TEXT, item_highlights TEXT,
    observed_at TEXT NOT NULL, data_date TEXT,
    PRIMARY KEY (marketplace, asin)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_asin_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketplace TEXT NOT NULL, asin TEXT NOT NULL,
    observed_at TEXT NOT NULL, data_date TEXT,
    price REAL, star_rating REAL, rating_num INTEGER, bsr_rank INTEGER, variation_num INTEGER,
    payload_json TEXT NOT NULL,
    UNIQUE (marketplace, asin, observed_at)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_traffic (
    marketplace TEXT NOT NULL, asin TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'listing',
    period_type TEXT NOT NULL CHECK (period_type IN ('day','week','month')),
    period_start TEXT NOT NULL,
    total_score REAL, nf_score REAL, ad_score REAL, sp_score REAL, rec_sp_score REAL,
    sb_score REAL, sbv_score REAL,
    total_change REAL, total_change_ratio REAL, nf_ratio REAL, ad_ratio REAL,
    price REAL, bsr_rank INTEGER, star_rating REAL, review_num INTEGER,
    is_complete INTEGER, tool TEXT NOT NULL, fetched_at TEXT NOT NULL, data_date TEXT,
    PRIMARY KEY (marketplace, asin, scope, period_type, period_start)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sif_traffic_asin ON sif_traffic (marketplace, asin, period_start DESC)`,

  `CREATE TABLE IF NOT EXISTS sif_listing_overview (
    marketplace TEXT NOT NULL, asin TEXT NOT NULL,
    window_type TEXT NOT NULL, window_value TEXT NOT NULL,
    total_score REAL, nf_ratio REAL, ad_ratio REAL,
    payload_json TEXT NOT NULL, data_date TEXT, fetched_at TEXT NOT NULL,
    PRIMARY KEY (marketplace, asin, window_type, window_value)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_sales_month (
    marketplace TEXT NOT NULL, asin TEXT NOT NULL, month TEXT NOT NULL,
    bought REAL, bought_band TEXT, bought_lower REAL, is_parent INTEGER,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (marketplace, asin, month, is_parent)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_keyword (
    marketplace TEXT NOT NULL, keyword TEXT NOT NULL,
    translate TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    PRIMARY KEY (marketplace, keyword)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_keyword_aba (
    marketplace TEXT NOT NULL, keyword TEXT NOT NULL, week_start TEXT NOT NULL,
    volume REAL, rank INTEGER, top3_click_share REAL, top3_conversion_share REAL,
    top3_asins_json TEXT, fetched_at TEXT NOT NULL,
    PRIMARY KEY (marketplace, keyword, week_start)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sif_aba_kw ON sif_keyword_aba (marketplace, keyword, week_start DESC)`,

  `CREATE TABLE IF NOT EXISTS sif_keyword_demand (
    marketplace TEXT NOT NULL, keyword TEXT NOT NULL, period_start TEXT NOT NULL,
    search_volume REAL, search_ctr_week REAL, search_ctr_90d REAL,
    clicks_week REAL, clicks_90d REAL, search_volume_90d REAL,
    diagnosis TEXT, momentum TEXT, trend_direction TEXT, yoy_change REAL, annual_decay_rate REAL,
    season_strength TEXT, peak_month INTEGER, trough_month INTEGER,
    weeks_to_peak INTEGER, weeks_to_trough INTEGER,
    season_position TEXT, vs_seasonal_baseline REAL,
    demand_type TEXT, demand_confidence TEXT, ad_strategy_hint TEXT,
    interpretation TEXT, action_hint TEXT, fetched_at TEXT NOT NULL,
    PRIMARY KEY (marketplace, keyword, period_start)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_asin_keyword (
    marketplace TEXT NOT NULL, asin TEXT NOT NULL, keyword TEXT NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'lately', period_value TEXT NOT NULL,
    traffic_share REAL, contri_change REAL, contri_severity TEXT,
    organic_page INTEGER, organic_pos INTEGER, organic_total INTEGER, organic_rank_raw TEXT,
    sp_rank TEXT, sb_rank TEXT, rank_evolution TEXT, gap_severity TEXT,
    keyword_health TEXT, traffic_dependency TEXT,
    channel_coverage_json TEXT, keyword_tags_json TEXT,
    fetched_at TEXT NOT NULL, data_date TEXT,
    PRIMARY KEY (marketplace, asin, keyword, period_type, period_value)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sif_ak_asin ON sif_asin_keyword (marketplace, asin, traffic_share DESC)`,

  `CREATE TABLE IF NOT EXISTS sif_competitor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketplace TEXT NOT NULL, keyword TEXT NOT NULL, scope TEXT NOT NULL, asin TEXT NOT NULL,
    share REAL, natural_share REAL, sp_share REAL, price REAL, reviews INTEGER, posture TEXT,
    payload_json TEXT, observed_at TEXT NOT NULL, data_date TEXT,
    UNIQUE (marketplace, keyword, scope, asin, observed_at)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_ad_campaign (
    marketplace TEXT NOT NULL, asin TEXT NOT NULL, campaign_id TEXT NOT NULL,
    display_id TEXT, campaign_type TEXT, name TEXT,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    PRIMARY KEY (marketplace, asin, campaign_id)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_ad_campaign_week (
    marketplace TEXT NOT NULL, asin TEXT NOT NULL, campaign_id TEXT NOT NULL, week_start TEXT NOT NULL,
    score REAL, share REAL, exposure REAL, fetched_at TEXT NOT NULL,
    PRIMARY KEY (marketplace, asin, campaign_id, week_start)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_ad_group (
    marketplace TEXT NOT NULL, asin TEXT NOT NULL, campaign_id TEXT NOT NULL, ad_group_id TEXT NOT NULL,
    display_id TEXT, variant_count INTEGER, keyword_count INTEGER,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    PRIMARY KEY (marketplace, asin, campaign_id, ad_group_id)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_ad_group_keyword (
    marketplace TEXT NOT NULL, asin TEXT NOT NULL, campaign_id TEXT NOT NULL, ad_group_id TEXT NOT NULL,
    keyword TEXT NOT NULL, week_start TEXT NOT NULL, share REAL, display_asins_json TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (marketplace, asin, campaign_id, ad_group_id, keyword, week_start)
  )`,

  `CREATE TABLE IF NOT EXISTS sif_sync_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL, tool TEXT NOT NULL, params_json TEXT, params_hash TEXT NOT NULL,
    objects_json TEXT, cost_points REAL, rows_written INTEGER,
    status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, ended_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sif_run ON sif_sync_run (started_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sif_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool TEXT NOT NULL, params_json TEXT, params_hash TEXT NOT NULL,
    data_date TEXT, cost_points REAL, ok INTEGER NOT NULL,
    response_json TEXT, fetched_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sif_raw_hash ON sif_raw (params_hash, fetched_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sif_quota_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool TEXT, cost_this_call REAL, remaining REAL,
    period_start TEXT, period_end TEXT, recorded_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sif_insight (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketplace TEXT NOT NULL, asin TEXT, keyword TEXT,
    kind TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL,
    evidence_json TEXT NOT NULL, suggestion TEXT, computed_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sif_insight ON sif_insight (marketplace, asin, state, severity)`,

  `CREATE TABLE IF NOT EXISTS sif_report (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketplace TEXT NOT NULL, asin TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
    markdown TEXT NOT NULL, range_from TEXT, range_to TEXT, created_at TEXT NOT NULL
  )`,

  // 视图：页面与模型共用同一口径
  `CREATE VIEW IF NOT EXISTS v_traffic_last8w AS
   SELECT marketplace, asin, period_start, total_score, nf_score, ad_score, nf_ratio, ad_ratio, total_change_ratio
   FROM sif_traffic WHERE period_type = 'week'`,
  `CREATE VIEW IF NOT EXISTS v_ad_dependency AS
   SELECT marketplace, asin, period_start, ad_ratio, total_score
   FROM sif_traffic WHERE ad_ratio IS NOT NULL AND ad_ratio >= 0.6`,
  `CREATE VIEW IF NOT EXISTS v_kw_gap AS
   SELECT marketplace, asin, keyword, traffic_share, organic_page, organic_pos, organic_total,
          gap_severity, rank_evolution, (organic_total - organic_pos + 1) AS positions_left_in_page
   FROM sif_asin_keyword WHERE organic_page IS NOT NULL AND organic_page >= 2`,
  `CREATE VIEW IF NOT EXISTS v_aba_latest AS
   SELECT a.marketplace, a.keyword, a.week_start, a.volume, a.rank, a.top3_click_share, a.top3_conversion_share
   FROM sif_keyword_aba a
   JOIN (SELECT marketplace, keyword, MAX(week_start) AS w FROM sif_keyword_aba GROUP BY marketplace, keyword) m
     ON m.marketplace = a.marketplace AND m.keyword = a.keyword AND m.w = a.week_start`,
]

export const SCHEMA_VERSION = 5

export const MIGRATIONS = [
  { version: 1, statements: V1 },
  // v2：广告结构只有「各类 campaign 数量」，没有 campaign id，所以单独一张摘要表；
  //     sif_ad_campaign 留给以后按 campaign 下钻（需要 campaignId）。
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS sif_ad_summary (
        marketplace TEXT NOT NULL, asin TEXT NOT NULL, observed_at TEXT NOT NULL,
        sp_count INTEGER, sb_count INTEGER, sbv_count INTEGER, total_count INTEGER,
        structure_scope TEXT, data_date TEXT,
        PRIMARY KEY (marketplace, asin, observed_at)
      )`,
    ],
  },
  // v3：关键词总库补字段（挖掘来的候选词 vs 正在追踪的词要分得开）+ 市场格局快照表。
  {
    version: 3,
    statements: [
      `ALTER TABLE sif_keyword ADD COLUMN status TEXT NOT NULL DEFAULT 'tracked'`,
      `ALTER TABLE sif_keyword ADD COLUMN source TEXT`,
      `ALTER TABLE sif_keyword ADD COLUMN root TEXT`,
      `ALTER TABLE sif_keyword ADD COLUMN volume_week REAL`,
      `ALTER TABLE sif_keyword ADD COLUMN clicks_week REAL`,
      `ALTER TABLE sif_keyword ADD COLUMN ctr_week REAL`,
      `ALTER TABLE sif_keyword ADD COLUMN note TEXT`,
      `CREATE TABLE IF NOT EXISTS sif_market_snapshot (
        marketplace TEXT NOT NULL, keyword TEXT NOT NULL, observed_at TEXT NOT NULL,
        visible_asin_count INTEGER, concentration_level TEXT, competition_mode TEXT,
        top3_click_share REAL, top3_conversion_share REAL,
        divergence TEXT, divergence_insight TEXT, leader_note TEXT,
        payload_json TEXT, data_date TEXT,
        PRIMARY KEY (marketplace, keyword, observed_at)
      )`,
    ],
  },
  // v4：Listing 深度诊断需要「文案内容」本身（标题/五点/亮点/属性/图片数），
  //     这些来自 market_get_asin_profile，所以挂在 sif_asin 上；诊断结论单独一张表留痕。
  {
    version: 4,
    statements: [
      // item_highlights 在 v1 就建好了，这里只补缺的列
      `ALTER TABLE sif_asin ADD COLUMN bullets_json TEXT`,
      `ALTER TABLE sif_asin ADD COLUMN images INTEGER`,
      `ALTER TABLE sif_asin ADD COLUMN aplus INTEGER`,
      `ALTER TABLE sif_asin ADD COLUMN description TEXT`,
      `ALTER TABLE sif_asin ADD COLUMN search_terms TEXT`,
      `CREATE TABLE IF NOT EXISTS sif_listing_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marketplace TEXT NOT NULL, asin TEXT NOT NULL, generated_at TEXT NOT NULL,
        score INTEGER, sections_json TEXT, markdown TEXT
      )`,
    ],
  },
  // v5：主图/A+/评论正文 SIF 不提供、amazon-ops 也还没采到，所以给一个「人工补录」的口子：
  //     录入后诊断会把这三项从「无数据来源」变成真实判定，而不是永远空着。
  {
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS sif_listing_asset (
        marketplace TEXT NOT NULL, asin TEXT NOT NULL,
        images_total INTEGER, has_white_bg INTEGER, min_px_ok INTEGER, has_video INTEGER,
        aplus INTEGER, review_themes TEXT, notes TEXT, source TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (marketplace, asin)
      )`,
    ],
  },
]
