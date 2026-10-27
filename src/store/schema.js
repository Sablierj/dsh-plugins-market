/**
 * Schema for the amazon-ops plugin store.
 *
 * Migrations are ordered and applied by `PRAGMA user_version`, so a store that
 * is already at version N only ever runs the steps above N. Every migration is
 * additive: never edit a shipped step, append a new one.
 *
 * Design notes that matter for the shape of these tables:
 *
 *   - `marketplace` is part of every product key. The same ASIN on US and DE is
 *     a different product with a different title, price, and rank, so `asin`
 *     alone is never a valid key.
 *   - `asin` holds the *current effective* value; `asin_snapshot` keeps every
 *     collection result verbatim so multi-source disagreement and trends stay
 *     answerable. `asin_field_source` answers "who told us this field", which is
 *     the question that comes up the moment a second source is wired in.
 *   - `asin_keyword.rank IS NULL` means "measured, not found" — but only because
 *     `scan_depth` sits next to it. A null rank on its own is ambiguous: "not in
 *     the first 320 results" and "nobody ever looked" are different facts, and
 *     only the first one is a gap. Step 3 added the column that tells them
 *     apart, and `keywordCoverage` reports them as separate lists.
 *   - `collection_task` is a real row, not an in-memory job. Collection takes
 *     minutes, the agent is told to come back later, and a service restart must
 *     not lose the record of what was asked for — `progress_json` is throttled
 *     (about once a second) because it is written while the task runs.
 *   - The workbench's UI state (selection, filters, open module) is deliberately
 *     NOT here. It is process memory, because it is per-session and worthless
 *     after a restart.
 */

import { RULES_SOURCE, RULES_VERSION, SEED_ROSTER } from '../domain/rules/listing-rules.js'
import { RULE_MANUAL_UPDATED_ON } from '../domain/rules/marketplaces.js'
import { promptSeedRows, promptSeedSets, PROMPT_SEED_VERSION } from '../domain/optimize/prompt-seed.js'

/**
 * The seed rule set's identity, and the generator for its INSERT statements.
 *
 * The 72 rows are generated from `SEED_ROSTER` (which is `RULES` minus the
 * functions) rather than typed into this file. Two hand-written copies of the
 * same 72 rows is exactly the failure this step removes: change one, forget the
 * other, and the store disagrees with the code with nobody able to tell which is
 * current. Here there is one source, and this is a projection of it.
 *
 * The seed runs *inside* the v10 migration, so a store at v10 always has its
 * roster — the alternative (seed lazily at startup) leaves a window where a
 * v10 store is empty and every reader has to remember the fallback.
 */
const SEED_PUBLISHED_AT = '2026-09-24T00:00:00.000Z'
const SEED_EFFECTIVE_FROM = '2026-09-24'
const SEED_SET_NAME = 'Amazon listing 机检规则（代码种子）'

/** A SQLite literal, or NULL. Numbers stay unquoted; quotes in text are doubled. */
function sqlString(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

/** The v10 seed: one `rule_set` row plus one `rule` row per seeded rule. */
function ruleSeedSql() {
  const statements = []
  statements.push(
    'INSERT INTO rule_set (version, name, source, effective_from, published_at, is_active, note) VALUES ('
    + [
      RULES_VERSION,
      SEED_SET_NAME,
      RULES_SOURCE,
      SEED_EFFECTIVE_FROM,
      SEED_PUBLISHED_AT,
      1,
      `B02 首批种入：${SEED_ROSTER.length} 条机检规则，kind 全部为 code`,
    ].map(sqlString).join(', ')
    + ');',
  )
  SEED_ROSTER.forEach((rule, index) => {
    statements.push(
      'INSERT INTO rule (rule_set_version, rule_id, kind, applies_to_json, scope, severity, title, body_md, source, params_json, sort_order, enabled, deleted_at, updated_at) VALUES ('
      + [
        RULES_VERSION,
        rule.id,
        'code',
        JSON.stringify(rule.appliesTo),
        rule.scope,
        rule.severity,
        rule.title,
        null,
        rule.source,
        null,
        index,
        1,
        null,
        SEED_PUBLISHED_AT,
      ].map(sqlString).join(', ')
      + ');',
    )
  })
  return statements.join('\n')
}

/**
 * The v13 seed: one `prompt_set` row per module plus one `prompt` row per prompt.
 *
 * Generated from `promptSeedSets()` / `promptSeedRows()` rather than typed here,
 * the same way v10 is generated from `SEED_ROSTER`. The ids are deterministic
 * uuids (see prompt-seed.js), so the seed is reproducible and the migration's
 * own output can be asserted against a fixture.
 */
function promptSeedSql() {
  const statements = []
  for (const set of promptSeedSets()) {
    statements.push(
      'INSERT INTO prompt_set (id, module, name, version, note) VALUES ('
      + [set.id, set.module, set.name, set.version, set.note].map(sqlString).join(', ')
      + ');',
    )
  }
  for (const row of promptSeedRows()) {
    statements.push(
      'INSERT INTO prompt (id, set_id, scenario, layer, label, body, variables_json, version, sort_order, enabled, deleted_at, updated_at) VALUES ('
      + [
        row.id,
        row.set_id,
        row.scenario,
        row.layer,
        row.label,
        row.body,
        row.variables_json,
        1,
        row.sort_order,
        1,
        null,
        SEED_PUBLISHED_AT,
      ].map(sqlString).join(', ')
      + ');',
    )
  }
  return statements.join('\n')
}

/* ═══════════════ v15 — the keyword case fold (B05.1) ═══════════════ */

/**
 * Column policy for v15's case-merge of `kw_master`. Written out literally.
 *
 * **Not derived from `MASTER_COLUMNS`, and that is the point.** A migration is
 * frozen once published (§3.1); deriving the list would mean that adding a column
 * to `MASTER_COLUMNS` next year silently changes what v15 does to any database
 * that has not been migrated yet. `tests/kw-key.mjs` asserts this list covers
 * exactly the columns `kw_master` has at v14, so a new column fails a test — the
 * signal to write a *new* migration — instead of quietly escaping the merge.
 *
 * The classes, and why "the survivor's value" is not enough for all of them:
 *
 *   - `survivor` — the row with the later `updated_at`, falling back to the other
 *     row where that value is null. For the ad counters this is deliberate: the
 *     real collisions were two imports whose date ranges overlapped, so *summing*
 *     would double-count. The later import wins; the other row only fills gaps.
 *   - `or` — a boolean flag is a fact about the word, not about one import. If
 *     either row says we have ABA data, we have it. Taking one row's `0` would
 *     erase knowledge the other row holds.
 *   - `nonEmpty` — JSON lists. The later import came from a report format that
 *     left some lists as `[]` while the earlier one had filled them: in the real
 *     data `ad_asins_json` was `["B0FLJQHV2X"]` on one row and `[]` on the other.
 *     An empty list is not a correction of a populated one, so prefer whichever
 *     is non-empty.
 *   - `min` / `max` — `first_seen_at` is history, so keep the earliest sighting;
 *     `updated_at` is the latest touch of the merged row.
 *   - `derived` — a count that is exactly the length of a list column, and so has
 *     to be recomputed rather than copied whenever that list is rescued. Otherwise
 *     the merge writes a row whose list and count disagree — which the first run
 *     against the real store did: it rescued `ad_asins_json` to `["B0FLJQHV2X"]`
 *     while leaving `asin_count` at the winner's `0`.
 *
 *     Only `asin_count` is in here. `competitor_ranked_count` looks similar but is
 *     not: `composeMaster` slices `competitor_ranked_json` to 20 while the count
 *     keeps the full length, so the count is not the list's length and the winner's
 *     value is the honest one. `competitor_absent_count` has no list column at all.
 */
const V15_KW_MASTER_MERGE = {
  survivor: [
    'word_id', 'product_line', 'product_line_matched',
    'search_volume', 'search_volume_source', 'search_volume_period', 'weekly_searches', 'aba_score',
    'impressions', 'clicks', 'orders', 'spend', 'sales', 'ad_rows', 'ad_files',
    'ctr_pct', 'cvr_pct', 'cvr_source', 'acos_pct', 'roas', 'cpc',
    'brand_impressions', 'brand_impression_pct', 'brand_clicks', 'brand_click_pct',
    'brand_purchases', 'brand_conv_pct', 'total_impressions', 'total_clicks', 'total_purchases',
    'own_status', 'funnel', 'sv_tier', 'sv_tier_label', 'priority', 'opportunity',
    'competitor_best_rank', 'competitor_best_asin', 'competitor_ranked_count', 'competitor_absent_count',
    'competitor_top_traffic_share', 'competitor_cpc', 'competitor_difficulty',
    'listed_volume', 'listed_difficulty',
  ],
  or: ['has_aba', 'has_ad', 'has_competitor', 'listed', 'sv_tier_known'],
  nonEmpty: [
    'product_lines_json', 'sources_json', 'ad_periods_json', 'ad_match_types_json', 'ad_asins_json',
    'modifiers_json', 'competitor_asins_json', 'competitor_tags_json', 'competitor_sources_json',
    'competitor_ranked_json', 'for_listing_json',
  ],
  min: ['first_seen_at'],
  max: ['updated_at'],
  /** column → the list column whose length it is. */
  derived: { asin_count: 'ad_asins_json' },
}

/** The columns the merge reads off the absorbed row, in a stable order. */
const V15_MERGE_COLUMNS = [
  ...V15_KW_MASTER_MERGE.survivor,
  ...V15_KW_MASTER_MERGE.or,
  ...V15_KW_MASTER_MERGE.nonEmpty,
  ...V15_KW_MASTER_MERGE.min,
  ...V15_KW_MASTER_MERGE.max,
]

/** Every `kw_master` column this policy accounts for. Asserted against the real
 *  v14 schema by `tests/kw-key.mjs`. */
export const V15_SPEC_COLUMNS = [...V15_MERGE_COLUMNS, ...Object.keys(V15_KW_MASTER_MERGE.derived)]

/**
 * v51 之后新增的 `kw_master` 列。
 *
 * **不能**把它们塞进 `V15_KW_MASTER_MERGE`：那份策略会生成 v15 迁移的 SQL，
 * 而 v15 那个年代 `kw_master` 还没有这些列 —— 一改，历史迁移在全新库上直接报
 * `no such column`（这一批真踩了一次，全量套件当场红）。
 *
 * 它们由 `recomputeMaster` 直接写入，不参与 v15 那次「大小写合并」的取舍规则。
 */
export const V51_ADDED_KW_MASTER_COLUMNS = ['role', 'role_basis_json']

/** v52 之后新增的列：趋势与落位处方。同样不能进 v15 的合并策略（那是冻结的历史）。 */
export const V52_ADDED_KW_MASTER_COLUMNS = ['trend_json', 'placement_json']

/** v53：落位槽位提成真实列（为了走索引）。 */
export const V53_ADDED_KW_MASTER_COLUMNS = ['placement_slot']

/* A copy-paste slip in the list above would show up as a column merged by two
   different rules, which is a silent behaviour change. Catch it at load. */
{
  const seen = new Set()
  for (const column of V15_MERGE_COLUMNS) {
    if (seen.has(column)) throw new Error(`v15 merge policy lists ${column} twice`)
    seen.add(column)
  }
}

/** Every table that carries a `keyword` column and therefore has to end up folded. */
const V15_FOLD_TABLES = ['keyword', 'asin_keyword', 'kw_aba_fact', 'kw_ad_fact', 'kw_competitor_fact']

/** The folded spelling of a column, as SQLite computes it. */
const lower = column => `lower(${column})`

/**
 * The v15 SQL. Generated rather than hand-written because the merge is 64
 * column expressions, and 64 hand-written `SET` clauses is 64 chances to write
 * one of them the wrong way round — with the failure mode being data loss rather
 * than an error. The generator is short and the policy above is the spec.
 */
function v15Sql() {
  const self = column => `kw_master.${column}`
  const absorbed = column => `(SELECT o.${column} FROM _kwm_other o
        WHERE o.winner_keyword = kw_master.keyword
          AND o.winner_marketplace = kw_master.marketplace)`

  /* The non-empty rule, named because `asin_count` has to reuse it verbatim —
     SQLite evaluates every SET expression against the pre-update row, so the
     count cannot read the list the same statement is about to write. */
  const preferNonEmpty = column =>
    `CASE WHEN ${self(column)} IS NULL OR ${self(column)} IN ('', '[]', '{}', 'null')\n`
    + `           THEN COALESCE(${absorbed(column)}, ${self(column)}) ELSE ${self(column)} END`

  const assignments = [
    ...V15_KW_MASTER_MERGE.survivor.map(c =>
      `${c} = COALESCE(${self(c)}, ${absorbed(c)})`),
    ...V15_KW_MASTER_MERGE.or.map(c =>
      `${c} = MAX(COALESCE(${self(c)}, 0), COALESCE(${absorbed(c)}, 0))`),
    ...V15_KW_MASTER_MERGE.nonEmpty.map(c => `${c} = ${preferNonEmpty(c)}`),
    ...V15_KW_MASTER_MERGE.min.map(c =>
      `${c} = COALESCE(MIN(${self(c)}, ${absorbed(c)}), ${self(c)})`),
    ...V15_KW_MASTER_MERGE.max.map(c =>
      `${c} = COALESCE(MAX(${self(c)}, ${absorbed(c)}), ${self(c)})`),
    ...Object.entries(V15_KW_MASTER_MERGE.derived).map(([count, list]) =>
      `${count} = COALESCE(json_array_length(${preferNonEmpty(list)}), 0)`),
  ]

  const otherColumns = V15_MERGE_COLUMNS.map(c => `o.${c} AS ${c}`).join(',\n           ')
  const foldUpdates = V15_FOLD_TABLES
    .map(t => `UPDATE ${t} SET keyword = ${lower('keyword')} WHERE keyword <> ${lower('keyword')};`)
    .join('\n')

  return `
-- ── 关键词的大小写折叠：写侧统一到小写规范形 ────────────────────────────────
-- 到 v14 为止，写库键保留大小写，而 wordId 是 sha256(lower(keyword))。于是
-- B002VNJF8W 与 b002vnjf8w 是两行、却共享一个 word_id —— 表自己已经认为它们是
-- 同一个词，却仍然存成两行。真实库里有 1028 对这样的行，而且没有一对是"无害
-- 重复"：两行各自带着不同的广告数字和不同的 ad_asins_json，每一对都是一个词的
-- 两份半截记录。来源是导入器只折了一半：分组用小写键，落库却存原始拼写。
--
-- 折叠让既有的 SQL 连接自动变正确。keywordCoverage 与 queryMaster 用 = 比较
-- keyword（SQLite 默认 BINARY，大小写敏感），这些比较一处都不改 —— 两侧都存
-- 折叠形之后它们就是对的。这是存储规则，而不是到处打 COLLATE NOCASE 补丁。
--
-- ⚠️ lower() 只折叠 ASCII。JS 的 toLowerCase() 能折叠更多（Ä→ä）。实测本库
-- 每一个 keyword 上两者都一致（含 2868 个非 ASCII 词，都是无大小写的 CJK 与
-- 符号），所以这里安全；但若将来存进带大小写的非 ASCII 字母，SQL 侧会漏折，
-- 需要一条新的迁移来收尾。
--
-- 归档表是这一步的安全网：被合并的组里**每一行**（赢家与输家）都原样留一份，
-- 所以合并可以只靠归档表反推回去，不需要依赖备份。这不是"顺手加的"，1028 对
-- 里没有一对是纯重复，删哪一行都会丢真实数据，一个不可逆的字段级合并必须有
-- 回退路径。

-- 1. 归档表：结构与 kw_master 一致，附加两列说明去向。
--    用 CREATE TABLE AS SELECT 复制结构，而不是手抄 66 列。
CREATE TABLE kw_master_case_merge_archive AS SELECT * FROM kw_master WHERE 0;
ALTER TABLE kw_master_case_merge_archive ADD COLUMN archived_at TEXT NOT NULL DEFAULT '';
ALTER TABLE kw_master_case_merge_archive ADD COLUMN merged_into TEXT NOT NULL DEFAULT '';

-- 2. 分组：按 (marketplace, lower(keyword)) 聚合，取 updated_at 最晚的那行为赢家。
--    平局按 keyword 降序 —— 小写排在大写之后，所以平局时偏好已经是小写的那行，
--    并且结果是确定的（不依赖扫描顺序）。
CREATE TEMP TABLE _kwm_group AS
SELECT marketplace, lk, keyword, rn, n FROM (
  SELECT marketplace,
         ${lower('keyword')} AS lk,
         keyword,
         ROW_NUMBER() OVER (PARTITION BY marketplace, ${lower('keyword')}
                                ORDER BY updated_at DESC, keyword DESC) AS rn,
         COUNT(*)     OVER (PARTITION BY marketplace, ${lower('keyword')}) AS n
    FROM kw_master
) WHERE n > 1;

-- 3. 归档组内所有行（赢家也留，这样归档表就是完整的"合并前"快照）。
INSERT INTO kw_master_case_merge_archive
SELECT k.*,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       (SELECT g.keyword FROM _kwm_group g
         WHERE g.marketplace = k.marketplace AND g.lk = ${lower('k.keyword')} AND g.rn = 1)
  FROM kw_master k
 WHERE EXISTS (SELECT 1 FROM _kwm_group g
                WHERE g.marketplace = k.marketplace AND g.lk = ${lower('k.keyword')});

-- 4. 被吸收行的快照。
--    先落成临时表，而不是在 UPDATE 里写相关子查询：UPDATE 逐行推进时同表的
--    子查询可能读到本次已改过的行。快照让合并读的是一个冻结的"对方"版本，
--    这个隐患就不存在了。
CREATE TEMP TABLE _kwm_other AS
SELECT winner_marketplace, winner_keyword, ${V15_MERGE_COLUMNS.join(', ')}
  FROM (
    SELECT g.marketplace AS winner_marketplace,
           g.keyword     AS winner_keyword,
           ${otherColumns},
           ROW_NUMBER() OVER (PARTITION BY g.marketplace, g.lk
                                  ORDER BY o.updated_at DESC, o.keyword DESC) AS rn
      FROM _kwm_group g
      JOIN kw_master o
        ON o.marketplace = g.marketplace AND ${lower('o.keyword')} = g.lk
       AND o.keyword <> g.keyword
     WHERE g.rn = 1
  ) WHERE rn = 1;

-- 5. 字段级合并，写进赢家。
UPDATE kw_master SET
${assignments.join(',\n')}
 WHERE EXISTS (SELECT 1 FROM _kwm_other o
                WHERE o.winner_keyword = kw_master.keyword
                  AND o.winner_marketplace = kw_master.marketplace);

-- 6. 删掉被吸收的行，然后折叠。顺序不能反：先折叠会撞唯一索引。
--    ⚠️ 相关条件必须落到"这一行"（marketplace + keyword 是主键），不能只到
--    (marketplace, lower(keyword))。后者会让赢家行也匹配到同组那条 rn > 1 的
--    记录，于是整组一起被删 —— 实测正是如此：31805 行少了 2056 而不是 1028。
DELETE FROM kw_master
 WHERE EXISTS (SELECT 1 FROM _kwm_group g
                WHERE g.marketplace = kw_master.marketplace
                  AND g.keyword = kw_master.keyword
                  AND g.rn > 1);

-- 7. 折叠 keyword。kw_master 的冲突已经在上面解掉，这一步只会碰到没有冲突的行。
UPDATE kw_master SET keyword = ${lower('keyword')} WHERE keyword <> ${lower('keyword')};

-- 8. 其余五张表只做折叠。实测它们没有大小写变体（keyword 90 行 / asin_keyword
--    74 / kw_aba_fact 19500 / kw_ad_fact 38056 / kw_competitor_fact 4723，碰撞
--    均为 0），所以这里不需要合并逻辑。
--    ⚠️ 若某个库在这五张表里存在大小写变体，这里会以 UNIQUE 约束失败而中止，
--    报错会点名表与列（如 "UNIQUE constraint failed: keyword.keyword,
--    keyword.marketplace"），整个迁移回滚、不会半途而废。**不要去粉饰它** ——
--    那说明该库有设计没有预料到的重复，按 kw_master 那样把合并策略想清楚再写。
${foldUpdates}

DROP TABLE IF EXISTS _kwm_group;
DROP TABLE IF EXISTS _kwm_other;
`
}

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
CREATE TABLE source (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  config_json   TEXT,
  notes         TEXT,
  last_health   TEXT,
  checked_at    TEXT
);

CREATE TABLE product_line (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  note  TEXT
);

CREATE TABLE asin (
  asin              TEXT NOT NULL,
  marketplace       TEXT NOT NULL,
  title             TEXT,
  brand             TEXT,
  price             REAL,
  currency          TEXT,
  bsr               INTEGER,
  category          TEXT,
  rating            REAL,
  reviews           INTEGER,
  image_url         TEXT,
  product_line_id   TEXT REFERENCES product_line(id),
  primary_source_id TEXT REFERENCES source(id),
  first_seen_at     TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (asin, marketplace)
);

CREATE TABLE asin_snapshot (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  asin         TEXT NOT NULL,
  marketplace  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE asin_field_source (
  asin        TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  field       TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  value       TEXT,
  confidence  REAL NOT NULL DEFAULT 1.0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (asin, marketplace, field, source_id)
);

CREATE TABLE keyword (
  keyword       TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  tier          TEXT,
  search_volume INTEGER,
  difficulty    REAL,
  source_id     TEXT REFERENCES source(id),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (keyword, marketplace)
);

CREATE TABLE asin_keyword (
  asin          TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  keyword       TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  rank          INTEGER,
  search_volume INTEGER,
  collected_at  TEXT NOT NULL,
  PRIMARY KEY (asin, marketplace, keyword, source_id)
);

CREATE TABLE listing (
  asin         TEXT NOT NULL,
  marketplace  TEXT NOT NULL,
  title        TEXT,
  bullets_json TEXT,
  description  TEXT,
  a_plus       TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (asin, marketplace)
);

CREATE TABLE optimization_run (
  id          TEXT PRIMARY KEY,
  asin        TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  status      TEXT NOT NULL,
  session_id  TEXT,
  report_md   TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE optimization_draft (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES optimization_run(id),
  field           TEXT NOT NULL,
  before          TEXT,
  after           TEXT,
  violations_json TEXT,
  accepted        INTEGER
);

CREATE TABLE collection_task (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES source(id),
  targets_json TEXT NOT NULL,
  fields_json  TEXT,
  status       TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  finished_at  TEXT,
  error        TEXT,
  result_json  TEXT
);

CREATE INDEX idx_asin_product_line ON asin(product_line_id);
CREATE INDEX idx_asin_updated      ON asin(updated_at DESC);
CREATE INDEX idx_snapshot_lookup   ON asin_snapshot(asin, marketplace, collected_at DESC);
CREATE INDEX idx_asin_keyword_kw   ON asin_keyword(keyword, marketplace);
CREATE INDEX idx_collection_status ON collection_task(status, submitted_at DESC);
CREATE INDEX idx_run_asin          ON optimization_run(asin, marketplace, started_at DESC);
`,
  },
  {
    version: 2,
    name: 'seed-sources',
    sql: `
INSERT OR IGNORE INTO source (id, kind, name, enabled, notes) VALUES
  ('browser-local', 'browser', '本机 Chrome（自有账号）', 1,
   'CDP 驱动本机 Chrome，独立 profile 保存登录态。当前唯一可用的采集通道。'),
  ('sellersprite', 'api', '卖家精灵 SellerSprite', 0,
   '官方开放平台 + MCP 服务（45 个工具，streamable-http）。需单独开额度，未接入。'),
  ('xiyou', 'api', '西柚 XYDATA', 0,
   'platform.xydc.com/openapi，关键词与 ASIN 数据，按 ASIN 计费。未接入。'),
  ('saihu', 'api', '赛狐 SaiHu', 0,
   '11 大业务板块 60+ 接口，需联系客户经理开通。未接入。');
`,
  },
  {
    version: 3,
    name: 'seed-manual-source',
    sql: `
INSERT OR IGNORE INTO source (id, kind, name, enabled, notes) VALUES
  ('manual', 'manual', '人工导入 / 校正', 1,
   '不是采集通道：用于人工粘贴或修正的数据，让这些值也有来源标记。');
`,
  },
  {
    version: 4,
    name: 'collection-task-progress',
    sql: `
ALTER TABLE collection_task ADD COLUMN progress_json TEXT;
ALTER TABLE collection_task ADD COLUMN updated_at TEXT;
`,
  },
  {
    version: 5,
    name: 'keyword-library',
    sql: `
-- ── keyword: 库级字段 ────────────────────────────────────────────────────
-- tier 列已存在，但第 3 步之后它的含义被收紧了：它是**库级汇总** —— 这个
-- 关键词在我们**任一** ASIN 上拿到的最好分层。针对单个 ASIN 的分层在
-- asin_keyword.tier 上，因为"这个词值不值得做"离不开"对哪个 ASIN 做"。
ALTER TABLE keyword ADD COLUMN first_seen_at TEXT;
ALTER TABLE keyword ADD COLUMN tier_basis_json TEXT;
ALTER TABLE keyword ADD COLUMN tags_json TEXT;
ALTER TABLE keyword ADD COLUMN note TEXT;

-- ── asin_keyword: 让 rank 能解释自己 ─────────────────────────────────────
-- rank IS NULL 表示"在扫描深度内没出现"，但 NULL 单独看是歧义的：没扫到
-- 第 3 页和这个词真没排名是两件事。scan_depth 把这件事记下来。
ALTER TABLE asin_keyword ADD COLUMN page INTEGER;
ALTER TABLE asin_keyword ADD COLUMN scan_depth INTEGER;
ALTER TABLE asin_keyword ADD COLUMN tier TEXT;
ALTER TABLE asin_keyword ADD COLUMN tier_basis_json TEXT;

-- ── 任务表加 kind ────────────────────────────────────────────────────────
-- 关键词覆盖扫描和 ASIN 采集是同一个生命周期：提交后不阻塞、落库、可恢复。
-- 共用一张表意味着 amzn_collect_status 能查两种任务，agent 只需要记一套姿势。
ALTER TABLE collection_task ADD COLUMN kind TEXT;
UPDATE collection_task SET kind = 'asin' WHERE kind IS NULL;

-- 已有的关键词行补一个首次出现时间，否则老数据在这一列上是 NULL。
UPDATE keyword SET first_seen_at = updated_at WHERE first_seen_at IS NULL;

CREATE INDEX idx_keyword_tier      ON keyword(marketplace, tier);
CREATE INDEX idx_keyword_updated   ON keyword(updated_at DESC);
CREATE INDEX idx_asin_keyword_rank ON asin_keyword(asin, marketplace, rank);
CREATE INDEX idx_task_kind         ON collection_task(kind, submitted_at DESC);
`,
  },
  {
    version: 6,
    name: 'optimization-runs',
    sql: `
-- ── listing: 补齐优化要用但采集拿不到的字段 ───────────────────────────────
-- 后台搜索词和属性字段是**卖家后台独有**的，页面上永远看不到，所以浏览器
-- 通道采不到它们。它们只能由人粘贴或由优化流程写入 —— 但不存下来，
-- 优化就永远在"看不见自己要改的东西"的状态下进行。
ALTER TABLE listing ADD COLUMN search_terms TEXT;
ALTER TABLE listing ADD COLUMN attributes_json TEXT;
ALTER TABLE listing ADD COLUMN source_id TEXT;

-- ── optimization_run: 让一份报告能解释自己 ────────────────────────────────
-- rules_json 是**规则快照**。合规规则会变，而三个月后有人问"当时为什么说
-- 这个标题违规"，答案必须在报告里，不能靠"去翻那时的规则文件"。
-- package_json 同理：agent 当时看到的是什么数据，必须留证。
ALTER TABLE optimization_run ADD COLUMN rules_version TEXT;
ALTER TABLE optimization_run ADD COLUMN rules_json TEXT;
ALTER TABLE optimization_run ADD COLUMN package_json TEXT;
ALTER TABLE optimization_run ADD COLUMN summary TEXT;
ALTER TABLE optimization_run ADD COLUMN error TEXT;
ALTER TABLE optimization_run ADD COLUMN report_html TEXT;

-- ── optimization_draft: 草稿要能自己解释自己 ──────────────────────────────
-- rationale 是 SOP 强制的"优化说明"（改了什么、依据哪条规则、植入了哪些词）。
-- 没有它，报告就只是两段文字的并排，读者无法判断该不该采纳。
ALTER TABLE optimization_draft ADD COLUMN rationale TEXT;
ALTER TABLE optimization_draft ADD COLUMN keywords_json TEXT;
ALTER TABLE optimization_draft ADD COLUMN severity TEXT;
ALTER TABLE optimization_draft ADD COLUMN updated_at TEXT;

-- 一个 run 的一个字段只能有一行草稿。重复校验同一个字段时应该覆盖旧结论，
-- 而不是并排两份互相矛盾的违规清单 —— 那时读者无法判断哪份是对的。
-- 老库里可能有重复（这张表在第 4 步之前没人写过），先按 id 保留最新一条。
DELETE FROM optimization_draft
 WHERE id NOT IN (SELECT MAX(id) FROM optimization_draft GROUP BY run_id, field);
CREATE UNIQUE INDEX idx_draft_run_field ON optimization_draft(run_id, field);

CREATE INDEX idx_run_status ON optimization_run(status, started_at DESC);
CREATE INDEX idx_run_asin2  ON optimization_run(asin, marketplace, started_at DESC);
`,
  },
  {
    version: 7,
    name: 'item-highlights',
    sql: `
-- ── listing: Item Highlights 从"附属字段"升为独立字段 ─────────────────────
-- 2026-07-27 起 Amazon 把 Item Highlights 做成了一等字段（125 字符），并且
-- 与标题组成**强制联动组**：标题里承诺的东西，亮点里必须对得上。
-- 在这之前它藏在别处、没有自己的位置，于是"优化前后对比"对这一项永远是空的
-- —— 报告看起来做了对比，实际上什么都没比。给它一列，对比才有对象。
ALTER TABLE listing ADD COLUMN item_highlights TEXT;
`,
  },
  {
    version: 8,
    name: 'listing-origin',
    sql: `
-- ── listing: 区分「线上事实」与「插件草稿」 ────────────────────────────────
-- listing 表唯一的写入方是优化流程的写回（applyListing），所以它存的是**本插件
-- 自己的草稿**，不是卖家后台里的真实文案。listingBefore() 只区分了"来自哪张表"，
-- 没有区分"是线上事实还是插件草稿"：一旦写回跑过一次，下一轮的「优化前」就变成
-- 了插件自己的上一版草稿 —— 报告在跟自己的影子对比，却说得像在跟线上对比。
--
-- 加一列 origin 把来源记下来（值：draft-applied 写回写入 / snapshot 来自采集快照
-- / manual 人工录入），报告据此给「优化前」标上可区分的来源。纯 additive：
-- 不重建表，不删列（SQLite 删列要重建，那会破坏既有数据）。
--
-- 同时说明 listing.a_plus 这一列（v1 起就在，至今**没有写入方**，只有一个读取方
-- keyword-tiers.js:listingText）：A+ 属于 publishable=false 的字段，注册表里明确
-- 没有写回路径，且它是一整列 TEXT、装不下注册表里的 6 个 A+ 模块。所以**保留为
-- 预留字段**，不为它硬造一条写回路径 —— 把"没有写回路径"写成"写了"才是真正的谎。
ALTER TABLE listing ADD COLUMN origin TEXT;
`,
  },
  {
    version: 9,
    name: 'keyword-master-library',
    sql: `
-- ── 关键词总库：事实表 + 汇总表 ────────────────────────────────────────────
-- 第 3 步的 keyword / asin_keyword 是**浏览器测出来的**东西：一个词在我们
-- 自己 ASIN 上的排名与覆盖。这一步补上另一半 —— 从**别人导出的文件**里来的
-- 数据：ABA 品牌分析、广告搜索词报告、卖家精灵/西柚竞品反查。
--
-- 为什么不是「一张大表」：hub 的 keyword_master.db 是一张宽表，每导入一个
-- 文件就**累加**进去（00_import_ad_xlsx.py 的 merge_and_update）。同一个文件
-- 导两次，曝光量就翻倍，而两次导入看起来都成功了。这里改成事实表按
-- (关键词, 站点, 周期, 文件) 存，汇总表是事实表的**函数** —— 重算幂等，
-- 重复导入覆盖同一行而不是再加一次。
--
-- 三个事实表分别对应三类源，因为它们的主键本来就不同：
--   ABA      一个词一个周期一行（月/季报）
--   广告     一个词一个周期**一个文件**一行（聚合表与 SP/SB 原始表周期会重叠）
--   竞品     一个词一个**竞品 ASIN** 一个来源一行

CREATE TABLE kw_aba_fact (
  keyword              TEXT NOT NULL,
  marketplace          TEXT NOT NULL,
  period               TEXT NOT NULL,
  report_date          TEXT,
  score                INTEGER,
  search_volume        INTEGER,
  total_impressions    INTEGER,
  brand_impressions    INTEGER,
  brand_impression_pct REAL,
  total_clicks         INTEGER,
  brand_clicks         INTEGER,
  brand_click_pct      REAL,
  total_purchases      INTEGER,
  brand_purchases      INTEGER,
  brand_conv_pct       REAL,
  cvr_pct              REAL,
  source_file          TEXT NOT NULL,
  imported_at          TEXT NOT NULL,
  PRIMARY KEY (keyword, marketplace, period)
);

CREATE TABLE kw_ad_fact (
  keyword          TEXT NOT NULL,
  marketplace      TEXT NOT NULL,
  period           TEXT NOT NULL,
  source_file      TEXT NOT NULL,
  impressions      INTEGER NOT NULL DEFAULT 0,
  clicks           INTEGER NOT NULL DEFAULT 0,
  orders           INTEGER NOT NULL DEFAULT 0,
  spend            REAL    NOT NULL DEFAULT 0,
  sales            REAL    NOT NULL DEFAULT 0,
  ad_rows          INTEGER NOT NULL DEFAULT 0,
  asins_json       TEXT,
  match_types_json TEXT,
  campaigns_json   TEXT,
  ad_types_json    TEXT,
  first_date       TEXT,
  last_date        TEXT,
  imported_at      TEXT NOT NULL,
  PRIMARY KEY (keyword, marketplace, period, source_file)
);

CREATE TABLE kw_competitor_fact (
  keyword            TEXT NOT NULL,
  marketplace        TEXT NOT NULL,
  asin               TEXT NOT NULL,
  source_id          TEXT NOT NULL,
  organic_rank       INTEGER,
  organic_page       INTEGER,
  organic_no_rank    INTEGER NOT NULL DEFAULT 0,
  ad_rank            INTEGER,
  keyword_types_json TEXT,
  traffic_share      REAL,
  weekly_impressions REAL,
  weekly_searches    REAL,
  monthly_volume     INTEGER,
  purchases          INTEGER,
  purchase_rate_pct  REAL,
  spr                INTEGER,
  aba_rank           INTEGER,
  title_density      INTEGER,
  products           INTEGER,
  cpc                REAL,
  bid_low            REAL,
  bid_high           REAL,
  difficulty         REAL,
  difficulty_band    TEXT,
  top_asins          TEXT,
  collected_at       TEXT,
  source_file        TEXT NOT NULL,
  imported_at        TEXT NOT NULL,
  PRIMARY KEY (keyword, marketplace, asin, source_id)
);

-- ── 汇总表 ────────────────────────────────────────────────────────────────
-- 每一列都是事实表的函数，没有任何一列是「上次跑剩下」的。重算即覆盖。
--
-- 单位写在列名里（cvr_pct / ctr_pct / acos_pct / brand_click_pct）：hub 的
-- 单列 cvr 在 ABA 路径下是百分数、在广告路径下是小数，却和同一个阈值比较。
-- 加后缀让这类错误写不出来。
CREATE TABLE kw_master (
  keyword            TEXT NOT NULL,
  marketplace        TEXT NOT NULL,
  word_id            TEXT NOT NULL,
  product_line       TEXT,
  product_line_matched TEXT,
  product_lines_json TEXT,
  sources_json       TEXT,
  has_aba            INTEGER NOT NULL DEFAULT 0,
  has_ad             INTEGER NOT NULL DEFAULT 0,
  has_competitor     INTEGER NOT NULL DEFAULT 0,
  listed             INTEGER NOT NULL DEFAULT 0,

  search_volume      INTEGER,
  search_volume_source TEXT,
  search_volume_period TEXT,
  weekly_searches    REAL,
  aba_score          INTEGER,

  impressions        INTEGER NOT NULL DEFAULT 0,
  clicks             INTEGER NOT NULL DEFAULT 0,
  orders             INTEGER NOT NULL DEFAULT 0,
  spend              REAL    NOT NULL DEFAULT 0,
  sales              REAL    NOT NULL DEFAULT 0,
  ad_rows            INTEGER NOT NULL DEFAULT 0,
  ad_files           INTEGER NOT NULL DEFAULT 0,
  ad_periods_json    TEXT,
  ad_match_types_json TEXT,
  ad_asins_json      TEXT,
  asin_count         INTEGER NOT NULL DEFAULT 0,

  ctr_pct            REAL,
  cvr_pct            REAL,
  cvr_source         TEXT,
  acos_pct           REAL,
  roas               REAL,
  cpc                REAL,

  brand_impressions  INTEGER,
  brand_impression_pct REAL,
  brand_clicks       INTEGER,
  brand_click_pct    REAL,
  brand_purchases    INTEGER,
  brand_conv_pct     REAL,
  total_impressions  INTEGER,
  total_clicks       INTEGER,
  total_purchases    INTEGER,
  own_status         TEXT,

  funnel             TEXT,
  sv_tier            TEXT,
  sv_tier_label      TEXT,
  sv_tier_known      INTEGER NOT NULL DEFAULT 0,
  modifiers_json     TEXT,
  priority           TEXT,
  opportunity        TEXT,

  competitor_best_rank   INTEGER,
  competitor_best_asin   TEXT,
  competitor_ranked_count INTEGER NOT NULL DEFAULT 0,
  competitor_absent_count INTEGER NOT NULL DEFAULT 0,
  competitor_asins_json  TEXT,
  competitor_tags_json   TEXT,
  competitor_top_traffic_share REAL,
  competitor_cpc         REAL,
  competitor_difficulty  REAL,
  competitor_sources_json TEXT,
  competitor_ranked_json TEXT,

  listed_volume      INTEGER,
  listed_difficulty  REAL,
  for_listing_json   TEXT,

  first_seen_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (keyword, marketplace)
);

-- ── 导入登记 ──────────────────────────────────────────────────────────────
-- 每个导入过的文件一行，带指纹（大小+内容哈希）。重复导入同一个文件是
-- **空操作**，而不是「再加一次」。included 是给周期重叠用的：SP 原始表的
-- 周期（20260101-20260415）会盖住聚合表的（20260401-20260416），两张表都
-- 算就会重复计数。默认全算，但重叠会被报出来，并且可以按文件排除。
CREATE TABLE kw_import (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  fingerprint   TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  period        TEXT NOT NULL,
  granularity   TEXT,
  layout        TEXT,
  rows_read     INTEGER NOT NULL DEFAULT 0,
  facts_written INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  included      INTEGER NOT NULL DEFAULT 1,
  problems_json TEXT,
  stats_json    TEXT,
  note          TEXT,
  imported_at   TEXT NOT NULL
);

CREATE INDEX idx_kw_aba_lookup   ON kw_aba_fact(marketplace, keyword);
CREATE INDEX idx_kw_ad_lookup    ON kw_ad_fact(marketplace, keyword);
CREATE INDEX idx_kw_ad_file      ON kw_ad_fact(source_file);
CREATE INDEX idx_kw_comp_lookup  ON kw_competitor_fact(marketplace, keyword);
CREATE INDEX idx_kw_comp_asin    ON kw_competitor_fact(asin, marketplace);
CREATE INDEX idx_kw_master_line  ON kw_master(marketplace, product_line);
CREATE INDEX idx_kw_master_tier  ON kw_master(marketplace, sv_tier);
CREATE INDEX idx_kw_master_prio  ON kw_master(marketplace, priority);
CREATE INDEX idx_kw_master_funnel ON kw_master(marketplace, funnel);
CREATE INDEX idx_kw_master_vol   ON kw_master(marketplace, search_volume DESC);
CREATE INDEX idx_kw_master_upd   ON kw_master(updated_at DESC);
CREATE INDEX idx_kw_import_time  ON kw_import(imported_at DESC);
CREATE INDEX idx_kw_import_fp    ON kw_import(fingerprint);

-- ── keyword：记住这个词是从哪个文件进来的 ────────────────────────────────
-- 汇总表里有一类词只有 keyword 一行、没有任何事实（纯词表导入的词，或
-- 浏览器扩词得到的词）。如果 keyword 不记来源，「排除这份文件」对这些词
-- 就完全没有作用 —— 按钮点了，数字不动，看起来像坏了。
--
-- 可空：浏览器扩词和手工加的词没有来源文件，它们是**常驻词库**的一部分，
-- 不该被任何一个导入文件的排除动作带走。
ALTER TABLE keyword ADD COLUMN source_file TEXT;
CREATE INDEX idx_keyword_source_file ON keyword(source_file);

-- 产品线：hub 的那 5 条，作为默认。已存在的行不动（INSERT OR IGNORE），
-- 用户自己的产品线不会被覆盖。
INSERT OR IGNORE INTO product_line (id, name, note) VALUES
  ('bench-cushion', '长凳垫', '默认产品线：任何信号词都没命中的词归到这里'),
  ('rocker-cushion', '摇椅垫', '摇椅/摇椅垫/婴儿房摇椅'),
  ('chair-cushion', '椅垫', '办公椅/餐椅/吧台凳坐垫'),
  ('jiuzhendian', '九针垫', '敷贴类（伤口/痘痘/水胶体）'),
  ('flower-edge-cushion', '花边垫', '花边/刺绣/荷叶边装饰垫');
`,
  },
  {
    version: 10,
    name: 'listing-rules-roster',
    sql: `
-- ── 规则：从代码常量到数据 ────────────────────────────────────────────────
-- 到 v9 为止，72 条机检规则是 listing-rules.js 里的一个数组。要改一条规则
-- 就得改代码、重装插件 —— 而用户想做的只是「亚马逊更新了规则，我点一下让它
-- 生效」。这一步把规则拆成两半：
--
--   判定（check 函数）留在代码里，因为 72 条里大量读 options.marketplace /
--   lexiconFor() / attributeCoverage()，这些不是字符串能表达的。存进库的是
--   roster：有哪些规则、严重度多少、出处是什么、正文是什么 —— 这些是数据。
--
-- rule 行不可变：编辑一条规则 = 复制当前 roster 成新版本再改。所以主键是
-- (rule_set_version, rule_id) 而不是 rule_id —— 一个三月的 run 指向它当时的
-- 版本，那条链必须永远能解析回来，哪怕规则后来改了十次。
--
-- kind 四种取值：code（判定在 registry.CHECKS 里）/ lexicon / threshold（用户
-- 自加的、参数化通用判定）/ doc（只有正文出处，无判定）。v10 种入的 72 条
-- 全部是 code，lexicon/threshold 计数为 0 —— 只有用户自加规则时才产生行。

CREATE TABLE rule_set (
  version        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  source         TEXT NOT NULL,
  effective_from TEXT,
  published_at   TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 0,
  note           TEXT
);

CREATE TABLE rule (
  rule_set_version TEXT NOT NULL REFERENCES rule_set(version),
  rule_id          TEXT NOT NULL,
  kind             TEXT NOT NULL,
  applies_to_json  TEXT,
  scope            TEXT,
  severity         TEXT NOT NULL,
  title            TEXT NOT NULL,
  body_md          TEXT,
  source           TEXT,
  params_json      TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  deleted_at       TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (rule_set_version, rule_id)
);
CREATE INDEX idx_rule_active ON rule(rule_set_version, enabled, sort_order);

-- 老 run 仍能解释：加一列指向版本，但 rules_json 仍是权威快照（见架构 §3.4）。
-- 这一列只是索引；快照是拷贝，不是外键，改规则不会动到老 run 一个字。
ALTER TABLE optimization_run ADD COLUMN rule_set_version TEXT;

-- ── 种入 ──────────────────────────────────────────────────────────────────
-- 由 SEED_ROSTER 生成（schema.js 顶部的 ruleSeedSql），不是手抄 72 行。
${ruleSeedSql()}
`,
  },
  {
    version: 11,
    name: 'policy-library',
    sql: `
-- ── 政策：输入是政策，产物是规则 ────────────────────────────────────────────
-- B03 是用户第 8 项需求「最新政策」的字面意思，也是「规则获取」的上游：政策是
-- 输入、规则是产物，同一条管道。这一版只做三件事 —— 政策进得来、看得见、和规则
-- 挂得上钩 —— 不做抓取。
--
-- 数据源以人工粘贴 / 文件导入为主，这是**有意的**：公告页有风控，抓失败会被误读
-- 成「没有新政策」，而那是这个模块最坏的失败（静默的空）。kind='url' 从第一天就
-- 留着，将来开抓取只是多一个 kind，不用改表。

CREATE TABLE policy_source (
  id    TEXT PRIMARY KEY,
  kind  TEXT NOT NULL,
  name  TEXT NOT NULL,
  url   TEXT,
  note  TEXT
);

INSERT OR IGNORE INTO policy_source (id, kind, name, url, note) VALUES
  ('amazon-seller-central', 'url', 'Amazon Seller Central 公告',
   'https://sellercentral.amazon.com/',
   '公告页有风控，本插件故意不做抓取 —— kind=url 只是留位，将来开抓取很便宜。'),
  ('manual-paste', 'manual', '人工粘贴', NULL,
   '政策以人工粘贴为主：粘贴原文 → 解析 → 入库，不依赖任何网络通道。'),
  ('hub-doc', 'file', 'Hub 文档', NULL,
   '从 amazon-ops-hub 的文档目录导入政策原文（文件导入，同样不抓取）。');

-- published_at 与 effective_from **分开两列**：发布与生效常差几周，合一列就再也
-- 查不出「这个月生效了哪些」—— 而「这个月生效了哪些」正是这个模块存在的理由。
-- severity_hint 可空：政策没明说就留 NULL，页面显示「未判定」，不编结论。
-- superseded_by 自引用：A 取代 B 时 B 的 status 变 superseded，链可追。
--
-- fields_json 是**政策级**的「影响哪些字段」，不在任务给的列清单里。加它是因为
-- amzn_policy_link 收了 fields[] 参数：必须给输入一个不丢它的家。挂在 policy_rule
-- 上会把同一份字段清单复制到每一条关联规则上，而且政策可以只影响字段、不挂任何
-- 规则（一条「图片必须 1600px」的政策没有任何规则可挂）。宁可多一列，也不要静默
-- 丢掉调用者给的输入。
CREATE TABLE policy (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES policy_source(id),
  marketplace    TEXT,
  title          TEXT NOT NULL,
  body_md        TEXT NOT NULL,
  url            TEXT,
  published_at   TEXT,
  effective_from TEXT,
  effective_to   TEXT,
  severity_hint  TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  superseded_by  TEXT REFERENCES policy(id),
  fields_json    TEXT,
  deleted_at     TEXT,
  imported_at    TEXT NOT NULL
);

CREATE INDEX idx_policy_eff ON policy(status, effective_from DESC);

-- 政策 → 规则：多对多。rule_id 是**规则 id 字符串**、不带版本 —— 政策影响的是
-- 「这条规则」，不是「这条规则的 2026.4 那一版」。note 记为什么这么挂。
CREATE TABLE policy_rule (
  policy_id TEXT NOT NULL REFERENCES policy(id),
  rule_id   TEXT NOT NULL,
  note      TEXT,
  PRIMARY KEY (policy_id, rule_id)
);
CREATE INDEX idx_policy_rule_rule ON policy_rule(rule_id);
`,
  },
  {
    version: 12,
    name: 'policy-severity-origin',
    sql: `
-- ── 严重度提示：归一化值必须带原词 ────────────────────────────────────────
-- v11 把政策用词归一到 high/medium/low（横向可比，有用），但**原词丢了**。于是页面
-- 上「严重度：高」读起来像亚马逊自己的分类，其实是我们从「必须立即整改」这类措辞推
-- 出来的 —— 派生值冒充事实。这和关键词总库里 search_volume_source 必须记口径来源是
-- 同一个道理。
--
-- 所以：归一化值仍然是 chip 的取值来源（severity_hint 不动），另外**单独存原词**，
-- 而且必须是**可查询的一列**，不是塞进某个不结构化的 note 里就算了。只有当原词也在
-- 库里时，severity_hint 才真的是「a hint, not a judgement」。
--
-- 可空，且与 severity_hint 同生同灭：政策没明说时两列都是 NULL，页面显示「未判定」。
ALTER TABLE policy ADD COLUMN severity_raw TEXT;
`,
  },
  {
    version: 13,
    name: 'prompt-library',
    sql: `
-- ── 提示词：从页面常量到库里的数据 ─────────────────────────────────────────
-- 到 v12 为止，页面按钮的提示词是 page.js 里的一个常量（PROMPT_SETS），要改一
-- 句文案就得改代码、重装插件。而「优化组装提示词」—— amzn_optimize_prepare 交给
-- agent 的写作策略 —— 根本不存在：它只活在模型的脑子里。这一步把两者都变成数据。
--
-- 两张表而不是一张：prompt_set 是**一个模块的一套提示词**（哪个模块、叫什么、
-- 哪一代），prompt 是**一行提示词**。scenario 是 prompt 的列，不是 set 的 ——
-- 一个模块的 button 和 assemble 属于同一套，打开一处就能看全这个模块发出去的
-- 东西。
--
-- scenario 两种取值，语义完全不同：
--   button   —— 页面右下角的按钮，点了生成一段 prompt 复制给 agent。
--   assemble —— amzn_optimize_prepare 的写作策略，分三层：
--               fixed（固定策略）/ evidence（证据从哪来）/ contract（交回来什么形状）。
--               分层不是装饰：三层因为不同的原因、以不同的频率变化。
--
-- variables_json 是**从 body 解析出来的**，不是手填的：手填的变量表就是那份会
-- 过期的第二份拷贝。渲染器只会替换 {{name}} 和丢弃整段 {{#name}}…{{/name}}，
-- 不会增删任何标点，所以可选的句子要自带标点（种子里的 。 写在花括号里面）。
--
-- version 是 INTEGER 而 set.version 是 TEXT，这是有意的：prompt.version 是这一行
-- 被改过几次（每次保存 +1），set.version 是人读的一代标签。两者不是同一种东西，
-- 所以不是同一种类型。

CREATE TABLE prompt_set (
  id      TEXT PRIMARY KEY,
  module  TEXT NOT NULL,
  name    TEXT NOT NULL,
  version TEXT NOT NULL,
  note    TEXT
);

CREATE TABLE prompt (
  id             TEXT PRIMARY KEY,
  set_id         TEXT NOT NULL REFERENCES prompt_set(id),
  scenario       TEXT NOT NULL,
  layer          TEXT,
  label          TEXT NOT NULL,
  body           TEXT NOT NULL,
  variables_json TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  deleted_at     TEXT,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_prompt_set    ON prompt(set_id, scenario, sort_order);
CREATE INDEX idx_prompt_module ON prompt(enabled, deleted_at);

-- ── 种入 ──────────────────────────────────────────────────────────────────
-- 由 promptSeedSets() / promptSeedRows() 生成（schema.js 顶部的 promptSeedSql），
-- 不是手抄 44 行。种子里 button 部分逐字来自 pre-B04 的 PROMPT_SETS —— 这一点由
-- tests/prompt-snapshot.json 逐字节核对，不是声称。
-- 种子代标签：${PROMPT_SEED_VERSION}
${promptSeedSql()}
`,
  },
  {
    version: 14,
    name: 'kw-pipeline',
    sql: `
-- ── 关键词管道：把五个阶段记成一次可回看的运行 ──────────────────────────────
-- 到 v13 为止，关键词的五个阶段（筛选 / 分层 / 分派 / 落位 / 出表）是五个孤立
-- 入口：amzn_kw_export 一次出表，amzn_optimize_prepare 自己调分派与落位，没有
-- 人把它们当成一次「运行」。于是「这次跑了什么参数、每步进出多少、产物在哪」
-- 事后无从查起 —— 而一个说不清自己跑过什么的管道，结果就不可复核。
--
-- 两张表而不是一张：运行级字段（marketplace / params_json / started_at）属于
-- 这一次运行，逐步数据（seq / stage / input_count / output_count）属于这一步。
-- 塞进一张表会让一次运行变成 5 行，运行级字段重复 5 遍 —— 同一事实存多处，
-- 迟早不一致。
--
-- params_json 是入参快照，不是「可复现」的承诺：三周后重跑，库里的 kw_master
-- 已经变了，字节不会一样。可复现的是参数与口径，这一点在工具输出里如实说，
-- 不要在页面上写成「结果可完全重现」。
--
-- status='failed' 时 error 必须非空，且已完成的 stage 照写 —— 静默丢掉一次
-- 失败的运行，等于谎报。

CREATE TABLE kw_pipeline_run (
  id            TEXT PRIMARY KEY,
  marketplace   TEXT NOT NULL,
  product_line  TEXT,
  params_json   TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  input_count   INTEGER NOT NULL,
  output_count  INTEGER NOT NULL,
  status        TEXT NOT NULL,
  error         TEXT,
  result_json   TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE INDEX idx_kwprun_mkt ON kw_pipeline_run(marketplace, started_at DESC);

CREATE TABLE kw_pipeline_stage (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES kw_pipeline_run(id),
  seq          INTEGER NOT NULL,
  stage        TEXT NOT NULL,
  input_count  INTEGER NOT NULL,
  output_count INTEGER NOT NULL,
  params_json  TEXT,
  result_json  TEXT,
  status       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  UNIQUE (run_id, seq)
);

CREATE INDEX idx_kwpstage_run ON kw_pipeline_stage(run_id, seq);
`,
  },
  {
    version: 15,
    name: 'keyword-case-fold',
    sql: v15Sql(),
  },
  {
    version: 16,
    name: 'competitor-sets',
    sql: `
-- ── 竞品组：把「我们要跟谁比」变成一条可复用的记录 ──────────────────────────
-- 到 v15 为止，竞品数据已经能进库（kw_competitor_fact，14 个 ASIN / 4723 行），
-- 但「跟谁比」这件事只活在对话里：每次分析都要把 ASIN 重新念一遍，念错了没人
-- 发现，上一次比的是谁也无从查起。这一步把那份名单落成数据。
--
-- 一张表，不是两张。竞品组的成员不单独建表，存 asins_json —— 理由不是省事，
-- 是**访问形状**：这个集合只被整体读、整体写（读出全部成员，然后去
-- kw_competitor_fact 里按 asin IN (...) 查），从来不需要按单个成员 join 回来。
-- 为一种不存在的查询建一张关联表，换来的是每次读写都要维护两处一致。
-- 如果将来真出现「按成员反查有哪些组」的需求，那是一条新迁移，不是现在猜。
--
-- asins_json 里的成员在写入时统一成大写、去重、排序（见 store/kw.js 的
-- normalizeAsinList）。这不是洁癖：同一份名单写两次必须得到**同一个字符串**，
-- 否则「这个组改过没有」就没法回答，页面上的保存按钮会永远显示有未保存的改动。
--
-- name 上**不加唯一约束**。同一个站点允许两个组重名，看起来是纵容，但反过来
-- 更糟：重命名撞到已有名字会变成一次保存失败，而失败的原因（"这个名字被占了"）
-- 要在页面上解释半天。用 id 认组，名字只是给人看的标签 —— 重名是用户的自由，
-- 不是数据的错误。
--
-- marketplace 是组的属性，不是成员的：一个组只在一个站点上有意义，因为
-- kw_competitor_fact 的排名本来就是分站点的，跨站点的「竞品」不存在。

CREATE TABLE competitor_set (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  asins_json  TEXT NOT NULL,
  note        TEXT,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_compset_mkt ON competitor_set(marketplace, updated_at DESC);
`,
  },
  {
    version: 17,
    name: 'settings-and-signals',
    sql: `
-- ── 配置面：设置键值 + 产品线信号词 ────────────────────────────────────────
-- 两件不同的事放在一个版本里，理由只有一个：它们都是「让用户能改现在写死在
-- 代码里的东西」，而这一次交付里改的是同一张设置页。分开成两个版本会让页面
-- 先看到一半的配置面，那比一个版本稍大更糟。
--
-- setting 是**键值表，不是宽表**。三个键各一行，将来加一个键就是加一行，
-- 不需要迁移。宽表（一行、每列一个设置）看起来更"类型安全"，但每加一个设置
-- 都要 ALTER TABLE，而设置天然是稀疏的、会长出来的——那正是宽表最差的形状。
--
-- 键名在 §3.6 定稿，且**带命名空间**（pacing.* / browser.* / marketplace.<CODE>.*）。
-- 点号不是装饰：marketplace.US.postalCode 与 marketplace.DE.postalCode 是两条
-- 不同的设置，前缀让「一个站点的全部设置」可以按 LIKE 'marketplace.US.%' 取到，
-- 也让「这是哪个域的东西」在值里看不出来时仍然看得见。
--
-- value_json 存 JSON 而不是 TEXT：设置的值有整数、有字符串，还有将来的数组。
-- 全存成 TEXT 会让读回来的 '45' 到底是数字还是字符串变成猜谜，而猜错的后果
-- 是限速参数以字符串形式进了采集器。JSON 让类型活到打开它的那一刻。
--
-- **这里只放用户偏好。** 标题上限 / 单位 / 核验来源（marketplaces.js 的
-- GLOBAL_LIMITS / authoritative）**不进这张表**：它们是已核验的市场事实，不是
-- 偏好，让用户能改它们等于让他改「这个标题合法吗」的答案（§7 #3）。

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note       TEXT
);

-- 产品线的信号词从 classify.js 的代码常量搬进库，让用户能在页面上加/改产品线。
-- classify.js 的 PRODUCT_LINE_SIGNALS 保留为**种子与回落**：有 signals_json 用库，
-- 为空则用常量。这样没跑过 v17 的老库与跑过的新库行为一致，且默认 5 条产品线
-- 不用手工重录——回落不是兼容层的妥协，是让「还没配」和「配成了空」长得不一样。
--
-- NULL 与 '{}' 在这里同样必须分开，理由同 snapshotOf 的 null vs []：
-- NULL = 没配过，回落常量；'{}' = 配过、故意清空，就该什么都不命中。
ALTER TABLE product_line ADD COLUMN signals_json TEXT;
`,
  },
  {
    version: 18,
    name: 'report-registry',
    sql: `
-- ── 报告登记：让「报告专区」列得出所有报告 ────────────────────────────────
-- 优化报告其实一直在库里（optimization_run.report_html），总库报告与 CSV 则是
-- 落盘的文件。两边**都不缺数据**，缺的是「把它们列成一张清单」的索引：
-- 报告专区要么只能列出优化 run，要么得去扫文件系统。前者漏一半，后者把
-- 「有哪些报告」押在「文件还在不在」上。
--
-- 所以这张表是**索引，不是第二份正文**：
--   · 优化报告：ref_id 指向 optimization_run.id，正文留在原地（不复制）。
--   · 总库报告/CSV：正文是 path 指向的文件，这里只登记。
-- ref_id 与 path **至少有一个非空**，但不能都空——一条两头都不指的报告是
-- 一条列不出、也打不开的记录。这条不变式加在 store 层（src/store/reports.js），
-- 不加 CHECK：迁移里写 CHECK 会让将来的合法形状被旧约束挡住，而这类判定
-- 本来就该跟写入逻辑在一起。
--
-- kind 有意不做外键：'optimization' 是优化 run，另外两个是关键词侧产物，
-- 三者没有共同的父表。这跟 kw_import.kind 是同一个选择。
--
-- scope_json 存 {asin, marketplace, runId, stage, …} —— 筛选（按 ASIN / 站点 /
-- 时间）要用的维度放这里，而不是各自的列。理由：报告的"范围"随类型不同而
-- 不同（优化报告有 asin，CSV 有 product_line），把它摊成列会让每种新报告都
-- 要改表；JSON 让范围是可扩展的，而按 ASIN 筛这个唯一高频查询用
-- json_extract(scope_json, '$.asin') 就够。

CREATE TABLE report (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  scope_json  TEXT,
  path        TEXT,
  ref_id      TEXT,
  title       TEXT,
  created_at  TEXT NOT NULL,
  note        TEXT
);

CREATE INDEX idx_report_kind ON report(kind, created_at DESC);
`,
  },
  {
    version: 19,
    name: 'context-identity',
    sql: `
-- ── 上下文身份：让「这份草案是在哪个上下文里生成的」可回答 ──────────────────────
-- 到 v18 为止，草案知道自己属于哪一轮优化（run_id），却不知道那一轮是在哪个
-- 上下文里跑的。用户选中 US 的某条产品线、agent 生成一版草案、用户随后把站点切
-- 到 DE，再点「采用」—— 那一版是按美国的规则和上限写的，产物却会被当成德国站的
-- 结论。这不是草案写错了，是草案**忘了**它属于哪里。
--
-- 所以这里只加一列：草案生成时所在上下文的 id（src/domain/context/scope.js 的
-- contextIdFor 对规范化 scope 取的摘要）。它是**身份**，不是外键：阶段 1 没有
-- 上下文包表（Q8），而把 context_id 指向一张不存在的表只会让读取路径多一层判断。
--
-- 历史行留 NULL，**不回填**。给一条旧草案编一个 context_id 就是伪造「它当时是在
-- 这个上下文里生成的」这个事实——而这一列存在的唯一目的就是回答这个问题。
-- 读取路径把 NULL 当「上下文未知」，与当前上下文不匹配，因此**不可提交**
-- （fail-closed，见 src/domain/optimize/context.js）。
--
-- 页面接线留模块 13；这里落的是机制：列在、写入路径能记、提交前能问。
ALTER TABLE optimization_draft ADD COLUMN context_id TEXT;

CREATE INDEX idx_draft_context ON optimization_draft(context_id);
`,
  },
  {
    version: 20,
    name: 'workspace-foundation',
    sql: `
-- ── 工作空间：把「这份配置属于哪里」变成一个对象 ──────────────────────────────
-- 到 v19 为止，这个库里所有配置都是**全局唯一**的：一份限速、一份产品线、一份
-- 数据源。这在一个人、一个店的时候没问题，但它把「默认」写死成了「唯一」——
-- 加第二个店的时候，没有任何地方能回答「这条产品线属于哪个店」。
--
-- 所以这一步做两件事：把工作空间落成一张表，并给**配置类表**加上 workspace_id。
--
-- 为什么只给配置类表加（Q6）：业务事实（asin / keyword / collection_task）跨
-- 空间不可分，因为它们本来就描述同一个市场里的同一批对象；给它们加维度只是让
-- 每个查询多一个恒真的条件。配置是另一回事 —— 「我的店用哪些产品线、怎么限速」
-- 本来就该分空间。这条界线是刻意的，团队化时再另开迁移，不在现在猜。
--
-- 为什么 ALTER 加列而不是重建表：SQLite 改主键要 CREATE TABLE … AS SELECT 重建，
-- 而重建会毁既有数据（v8 的 origin 注释已记）。setting 的主键仍然是 key，
-- workspace_id 只是维度列。
--
-- 为什么现在不加 (workspace_id, key) 唯一索引：setSetting 用的是 ON CONFLICT(key)，
-- 再加一个 (workspace_id, key) 唯一索引会让「冲突目标」有两种解释。阶段 1 是单
-- 空间，key 唯一已经足够；多空间时另开一条迁移处理。
--
-- 默认空间在同一版本里种入，紧接着的回填就挂在它上面 —— 这是**有据的回填**
-- （值刚刚被写下），不是猜。至多一个默认空间用部分唯一索引变成结构约束，
-- 不靠代码自觉。

CREATE TABLE workspace (
  id          TEXT PRIMARY KEY,          -- 默认空间固定为 'ws-default'
  name        TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,                      -- 非空 = 归档（只读）
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 部分唯一索引：is_default = 1 的行至多一行。把它做成结构约束而不是一次检查，
-- 是因为「两个默认空间」这种状态一旦存在，后面每处读取都要自己决定听谁的。
CREATE UNIQUE INDEX idx_ws_default ON workspace(is_default) WHERE is_default = 1;

INSERT INTO workspace (id, name, is_default, archived_at, note, created_at, updated_at)
VALUES ('ws-default', '默认空间', 1, NULL,
        'v20 迁移种入：单工作空间场景的默认空间',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE setting      ADD COLUMN workspace_id TEXT;
ALTER TABLE product_line ADD COLUMN workspace_id TEXT;
ALTER TABLE source       ADD COLUMN workspace_id TEXT;

UPDATE setting      SET workspace_id = 'ws-default' WHERE workspace_id IS NULL;
UPDATE product_line SET workspace_id = 'ws-default' WHERE workspace_id IS NULL;
UPDATE source       SET workspace_id = 'ws-default' WHERE workspace_id IS NULL;

CREATE INDEX idx_setting_ws ON setting(workspace_id, key);
CREATE INDEX idx_pline_ws   ON product_line(workspace_id);
CREATE INDEX idx_source_ws  ON source(workspace_id);
`,
  },
  {
    version: 21,
    name: 'site-profile',
    sql: `
-- ── 站点档案：只读的那半不进库，可写的那半与核验事件进库 ──────────────────────
-- 一个站点的「事实」（域名、语言、币种、计量单位、标题上限、口径三态）全部来自
-- marketplaces.js，它是代码里唯一已核验的那份。把它们抄进库就是制造第二份会漂移
-- 的事实 —— 改一处忘一处，页面与报告各说各话，而且没人能判断哪份是对的。
--
-- 所以 site_profile 只存**偏好**（本地化写法之类的选择）与备注。事实是投影。
--
-- site_verification 是另一件事：它是**事件**，不是状态。「谁在何时、凭哪条证据
-- 核验了这个站点的规则口径」必须可追加、不可改 —— 一份能被覆盖的核验记录不是
-- 记录。阶段 1 没有用户表（Q4），所以这里的 verified_by 是权限层级枚举的占位，
-- 以及一个特殊值 'system-seed'。
--
-- 种入 US / CA 两行，理由与日期出处：marketplaces.js 的权威口径说规则手册
-- 「适用：北美站（美国/加拿大）」，而手册 §1.3 自述 updated 2026-05-25。
-- 这是**有据的**（手册头注释即此日期），不是编造。但它是手册的自述，不是人工
-- 核验，更不是 Amazon 的核验 —— verified_by = 'system-seed' 就是这条界线，
-- 页面必须据此把它与人工核验在视觉上分开，并注明来源。把 system-seed 显示成
-- Amazon 官方核验是这一步最坏的失败方式。

CREATE TABLE site_profile (
  workspace_id      TEXT NOT NULL,
  marketplace       TEXT NOT NULL,
  localization_json TEXT,               -- 本地化偏好（尺寸写法/颜色标准名等）
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (workspace_id, marketplace)
);

CREATE TABLE site_verification (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  verified_at   TEXT NOT NULL,          -- ISO-8601；日期部分即「最近验证日期」
  verified_by   TEXT NOT NULL,          -- 权限层级枚举；'system-seed' = 迁移种入
  evidence_url  TEXT,
  evidence_note TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_siteverify ON site_verification(workspace_id, marketplace, verified_at DESC);

INSERT INTO site_verification (id, workspace_id, marketplace, verified_at, verified_by, evidence_url, evidence_note, created_at)
VALUES ('sv-us-seed', 'ws-default', 'US', '${RULE_MANUAL_UPDATED_ON}T00:00:00.000Z', 'system-seed', NULL,
        'amazon-listing-comprehensive-rules-2026.md v3.0 §1.3 (updated ${RULE_MANUAL_UPDATED_ON})（适用：北美站）',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO site_verification (id, workspace_id, marketplace, verified_at, verified_by, evidence_url, evidence_note, created_at)
VALUES ('sv-ca-seed', 'ws-default', 'CA', '${RULE_MANUAL_UPDATED_ON}T00:00:00.000Z', 'system-seed', NULL,
        'amazon-listing-comprehensive-rules-2026.md v3.0 §1.3 (updated ${RULE_MANUAL_UPDATED_ON})（适用：北美站）',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`,
  },
  {
    version: 22,
    name: 'shop-brand-ownership',
    sql: `
-- ── 店铺、品牌与 ASIN 归属：把「这是谁的」变成一条有来源的记录 ────────────────
-- 到 v21 为止，一个 ASIN 属于哪条产品线只有一个字段（asin.product_line_id），
-- 它同时承担三种互相矛盾的职责：当前生效值、判定依据、以及历史。结果是每次
-- 重新判定都覆盖上一次，「为什么它在这条线上」和「它以前在哪条线上」一起消失。
--
-- 这一步把它拆开：
--   · asin.product_line_id **保留**为「当前生效值」的缓存（不删、不改造）——
--     查询它的人很多，而它现在有了一个明确的来源：归属关系。
--   · asin_ownership 是**关系记录**，不是永久标签（Q7）。一条归属有来源
--     （auto 判定 / manual 人工）、有置信度、有判定依据，也可以被撤销 —— 撤销
--     是 retracted_at 置位，不是删行。删掉一条「我们曾经认为它属于这里」的记录，
--     就等于删掉那次判断的证据。
--
-- shop 与 brand 放在同一个版本里，理由与 v17 相同：它们是同一张页面上一起编辑
-- 的同一类对象（「我的店卖哪些品牌」），分两次发布只会让页面先看到一半。
--
-- brand.is_own 是自有/竞品的唯一判定：品牌是「我们的」还是「竞品的」，这个属性
-- 属于品牌，不属于某一次比较。把它放在 ASIN 上会让同一个品牌的两个 ASIN 各说
-- 各话。
--
-- asin_ownership 上**不加 workspace_id**：归属说的是「这个市场里的这个 ASIN 是
-- 谁的」，与哪个工作空间在看它无关；加了维度就要为每条查询多一个恒真条件（同 Q6）。
--
-- 回填**有据**：既有 asin.product_line_id 非空的行，本来就是「当前生效的归属」，
-- 所以投影成 source='auto' 的归属行 —— 这不是猜，是把它已经表达的事实写清楚。

CREATE TABLE shop (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  marketplace  TEXT,                    -- 默认站点；NULL = 未指定
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_shop_ws ON shop(workspace_id, marketplace);

CREATE TABLE brand (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  name           TEXT NOT NULL,         -- 规范写法
  aliases_json   TEXT,                  -- 别名（命中即归属）
  forbidden_json TEXT,                  -- 禁用写法（合规检查用）
  is_own         INTEGER NOT NULL DEFAULT 1,   -- 1 自有品牌 / 0 竞品品牌
  note           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_brand_ws ON brand(workspace_id, is_own);

CREATE TABLE asin_ownership (
  id            TEXT PRIMARY KEY,
  asin          TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  object_type   TEXT NOT NULL,          -- 'product_line' | 'brand' | 'shop' | 'side'
  object_id     TEXT NOT NULL,          -- 目标对象 id；object_type='side' 时取 'self' | 'competitor'
  source        TEXT NOT NULL,          -- 'auto' | 'manual'
  confidence    REAL,                   -- auto 的置信度；manual 为 NULL
  evidence_json TEXT,                   -- auto 的判定依据（命中的信号词/别名）
  created_at    TEXT NOT NULL,
  retracted_at  TEXT,                   -- 人工撤销置位；**不删行**
  UNIQUE (asin, marketplace, object_type, object_id, source)
);

CREATE INDEX idx_ownership_asin ON asin_ownership(asin, marketplace, object_type);

INSERT INTO asin_ownership (id, asin, marketplace, object_type, object_id, source, confidence, evidence_json, created_at, retracted_at)
SELECT 'own-' || asin || '-' || marketplace, asin, marketplace, 'product_line', product_line_id, 'auto', NULL, NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
  FROM asin
 WHERE product_line_id IS NOT NULL;
`,
  },
  {
    version: 23,
    name: 'product-line-config-v2',
    sql: `
-- ── 产品线信号：一份数据、四类、带版本 ────────────────────────────────────────
-- 到 v22 为止，一条产品线的信号是一个扁平数组。那个数组同时在干四件事，而且
-- 不说自己在干哪件：它就是这条线的词、它排除的词、它的使用场景、它的材质。
-- 用户改它的时候分不清自己改的是哪一类，分类器也分不清。
--
-- 所以拆成四类：core / exclude / scenario / material。**一份数据**，不是四张表 ——
-- 四类是一个对象的四个字段，拆表会让「读一条线的全部信号」变成一次 join。
--
-- 回填**保真**：旧的扁平数组整体进 core（语义相同：它本来就是核心品类词）。
-- 用 SQLite 的 JSON 函数逐行重写，所以词条集合在回填前后逐词相等 —— 这是回填
-- 唯一可接受的结果，丢一个词就等于悄悄改了分类结果。解析不了的行**原样不动**
-- （broken），迁移不替它猜。
--
-- 第二步是版本化。产品线是**版本化配置对象**：改信号 = 造新版本，不原地改。
-- 理由与规则集相同 —— 历史运行引用了当时的配置，原地改会让「那次跑的时候这条线
-- 是怎么配的」永远无法回答。所以：
--   · product_line.signals_json 仍是**当前生效值**（查询它的人很多）。
--   · product_line_version 是追加式的版本行，旧行永不动。
--   · product_line.version 是当前版本号，默认 1（既有行本来就是第一版）。
--
-- 为每条既有产品线造一个 version = 1 的快照行。signals_json 为 NULL 的行写
-- JSON 的 null（列是 NOT NULL，而 'null' 是「没配过」的忠实快照）—— 它**不等于**
-- '{}'，后者是「配过、故意清空」，两者不能混。
--
-- 缺失的类键 = 该类为空，**不回落**。{'core':['bench']} 没有 scenario 词，
-- 不是「继承内置的 scenario 词」；继承会让「我只想删掉一类词」变成不可能。

ALTER TABLE product_line ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE product_line_version (
  id              TEXT PRIMARY KEY,
  product_line_id TEXT NOT NULL REFERENCES product_line(id),
  version         INTEGER NOT NULL,
  name            TEXT,
  signals_json    TEXT NOT NULL,
  note            TEXT,
  changed_by      TEXT,                 -- 权限层级枚举
  created_at      TEXT NOT NULL,
  UNIQUE (product_line_id, version)
);

CREATE INDEX idx_plinever ON product_line_version(product_line_id, version DESC);

-- 1) 扁平数组 → {core: [...]}
UPDATE product_line
   SET signals_json = json_object('core', json(signals_json))
 WHERE signals_json IS NOT NULL
   AND json_valid(signals_json) = 1
   AND json_type(signals_json) = 'array';

-- 2) 旧扁平对象 {include: [...]} → 四类（缺的类补空数组）。
--    这一步只碰对象：数组已经被上一条改写成对象，而它是「已经规范过」的形态。
UPDATE product_line
   SET signals_json = json_object(
         'core',     json(COALESCE(json_extract(signals_json, '$.core'), json_extract(signals_json, '$.include'), '[]')),
         'exclude',  json(COALESCE(json_extract(signals_json, '$.exclude'), '[]')),
         'scenario', json(COALESCE(json_extract(signals_json, '$.scenario'), '[]')),
         'material', json(COALESCE(json_extract(signals_json, '$.material'), '[]')))
 WHERE signals_json IS NOT NULL
   AND json_valid(signals_json) = 1
   AND json_type(signals_json) = 'object';

-- 3) 每条既有产品线一个 version = 1 的快照。
INSERT INTO product_line_version (id, product_line_id, version, name, signals_json, note, changed_by, created_at)
SELECT 'plv-' || p.id || '-v1', p.id, 1, p.name, COALESCE(p.signals_json, 'null'), p.note, 'system-seed',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM product_line p;
`,
  },
  {
    version: 24,
    name: 'source-provenance',
    sql: `
-- ── 事实的溯源：每条值要能回答「来自哪里、采于何时、原始值是什么」 ──────────────
-- asin_field_source 从 v1 起就记「哪个源说了这个字段」，但它只记到 source_id 与
-- 一个被归一化过的 value。于是三个问题答不出来：这个值是什么时候**观测**到的、
-- 原始形态是什么（1,299.99 还是 1.299,99）、以及它是采集来的还是导入来的。
-- 价格解析一旦出错，库里的数字看起来和正确的一模一样，而溯源是唯一能查出来的
-- 地方。
--
-- **只追加列，不动既有列、不改主键、不覆盖任何 value。** 已有列的含义一个都没变。
--
-- 回填**只写已知的**：
--   · ingested_at = updated_at。对老行，入库时间与最后更新时间语义重合（这张表
--     一次采集 upsert 一行），这是**已知**信息，不是猜。
--   · observed_at 留 NULL。老行的采集时间无法从这张表本身得知——**不发明时间戳**
--     （§8.3「不能解析时为 unknown，不回填今天」）。页面显示「未记录」。
--   · source_type = 'collect'。v24 之前这张表只有浏览器采集在写。
--   · quality_state 留 NULL：状态由 S1-B09 的扫描算，迁移不替它下结论。
--   · raw_value / raw_unit / parser_version 留 NULL：老行没有原始形态可回填。

ALTER TABLE asin_field_source ADD COLUMN source_type    TEXT;
ALTER TABLE asin_field_source ADD COLUMN observed_at    TEXT;
ALTER TABLE asin_field_source ADD COLUMN ingested_at    TEXT;
ALTER TABLE asin_field_source ADD COLUMN raw_value      TEXT;
ALTER TABLE asin_field_source ADD COLUMN raw_unit       TEXT;
ALTER TABLE asin_field_source ADD COLUMN parser_version TEXT;
ALTER TABLE asin_field_source ADD COLUMN quality_state  TEXT;

UPDATE asin_field_source SET ingested_at = updated_at WHERE ingested_at IS NULL;
UPDATE asin_field_source SET source_type = 'collect'  WHERE source_type IS NULL;

CREATE INDEX idx_fieldsrc_prov ON asin_field_source(asin, marketplace, field, observed_at DESC);
`,
  },
  {
    version: 25,
    name: 'dq-issues',
    sql: `
-- ── 质量问题：一张有状态机的待办清单，不是一张扫描日志 ──────────────────────
-- 到 v24 为止，「数据有没有问题」这件事只活在一次对话里：扫描报出的问题看完就没了，
-- 「这条已经确认过了」「这条决定接受风险」无处可记，下一次扫描从零开始。于是同一个
-- 问题会被反复当成新问题报出来，而「已经处理过了」这句话没有任何地方能查。
--
-- 这张表就是那份可跟踪的清单。它同时是两个东西的对立面：
--   · 不是「一张扫描日志」——日志每扫一次加一批行，问题会被重复计数。这里同一
--     条问题只有一行（见下面的唯一索引），反复扫描是 upsert，不是追加。
--   · 不是「一个草稿标签」——状态只能沿四条边移动（open → acknowledged → fixing
--     → resolved / accepted_risk，见 domain/states.js 的 DQ_ISSUE_TRANSITIONS），
--     提交一次非法迁移会被拒（store/quality.js 的 setIssueStatus 返回
--     DQ_ILLEGAL_TRANSITION），而不是把列改成一个谁也解释不了的值。
--
-- 七个维度（完整 / 有效 / 一致 / 时效 / 唯一 / 可追溯 / 可行动）是**分类**，不是七个
-- 布尔：dimension 的取值来自 src/domain/data/quality-rules.js 的 DIMENSIONS，页面
-- 按它分组，规则按它归档。它
-- 不是 severity —— 同一条「价格缺失」是 completeness，严重级可能只是 warn；分类与
-- 后果是两件事，混在一列会让「按维度看覆盖率」和「按严重级排优先级」互相打架。
--
-- 每行的六要素：severity / object_type / object_id / field / rule_id / message，
-- 加 status 共七列必备。field 可空 —— 空表示这是「对象级」问题（整个 ASIN 缺价格），
-- 非空表示「字段级」（这条 ASIN 的 price 这一列）。两者不是同一条问题，所以它进了
-- 唯一键。
--
-- ⚠️ 唯一键不能用普通的 UNIQUE(rule_id, object_type, object_id, field)：SQLite
-- 认为两个 NULL 互不相同（NULL != NULL），于是所有 field 为空的对象级问题永远
-- 不会互相冲突 —— 重扫会一直堆行，「行数不变」这条验收会静默失效。所以用**表达式
-- 唯一索引**，把 NULL 折叠成空串再比较，才是真正的一行一问题。
--
-- detected_at 是「最近一次被扫到」，不是「第一次被扫到」：这张表没有 first_seen 列，
-- 因为它要回答的是「现在还坏着吗」，而不是「它坏了多久」（后者由 object 自己的时间
-- 回答）。updated_at 是最后一次写这一行的时刻。时间列一律 ISO-8601 UTC 字符串。
CREATE TABLE dq_issue (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT NOT NULL,           -- DQ-<DIM>-<NNN>，如 DQ-FRESH-001
  dimension    TEXT NOT NULL,           -- 七维度之一（src/domain/data/quality-rules.js）
  severity     TEXT NOT NULL,           -- block | warn | info
  status       TEXT NOT NULL,           -- open|acknowledged|fixing|resolved|accepted_risk
  object_type  TEXT NOT NULL,           -- asin | keyword | listing | dataset | ...
  object_id    TEXT NOT NULL,
  field        TEXT,                    -- 字段级问题时非空；对象级问题为空
  message      TEXT NOT NULL,
  workspace_id TEXT,                    -- 阶段 1 单空间：写 'ws-default'
  assignee     TEXT,                    -- 权限层级枚举（Q4）；阶段 1 无用户表
  detected_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  note         TEXT
);

-- 一行一问题（NULL 安全的自然键）。见上：普通 UNIQUE 在 field 为空时形同虚设。
CREATE UNIQUE INDEX idx_dq_key ON dq_issue(rule_id, object_type, object_id, COALESCE(field, ''));

-- 页面按「状态 + 严重级 + 最近发现」排序取列表；按对象反查走另一条。
CREATE INDEX idx_dq_status ON dq_issue(status, severity, detected_at DESC);
CREATE INDEX idx_dq_object ON dq_issue(object_type, object_id);
`,
  },
  {
    version: 26,
    name: 'snapshot-registry',
    sql: `
-- ── 版本化对象的统一索引：一个版本一旦被某次运行引用，就永久可解析 ────────────
-- 在它之前，「这个版本」散落在四张互不相干的表里（asin_snapshot 的采集结果、
-- rule_set 的规则版本、prompt_set 的提示词集、optimization_draft 的草案），
-- 没有任何一个地方能回答「某个对象有哪些版本、当时那个版本长什么样」。
--
-- 这张表沿用 report 表的纪律（src/store/reports.js，§3.6）：**登记索引，不复制
-- 正文**。ref_table/ref_id 指向正文所在的那一行；只有**可变对象**（竞品组、
-- 关键词总库）才冻一份 payload_json，因为它的正文会被就地覆盖，指针会漂移
-- （§0 决策 #8）。
--
-- 一个不变量：一行必须**至少能读到一处** —— 要么 ref_id 指针，要么 payload。
-- 两者都空的行能被列出却永远打不开，正是本项目一直拒绝的静默空值形状；它在
-- 写入边界（registerSnapshot）校验，而不是写成 CHECK 冻死这条会变的规则。
--
-- 新数据追加新版本，不覆盖历史：UNIQUE(object_type, object_id, version) 让
-- 「同一对象同一版本」只能有一行；写第二版时版本号自增或由调用方显式给出，
-- 显式给出的版本若已存在则被拒绝，而不是静默合并。
--
-- context_package 保留在枚举里但**零行**（Q8）：Agent 平面未接入，页面显式
-- 显示「待 Agent 平面接入」，不空建表。

CREATE TABLE snapshot_registry (
  id           TEXT PRIMARY KEY,
  object_type  TEXT NOT NULL,           -- listing|kw_master|competitor_set|rule_set|prompt_set|draft|context_package
  object_id    TEXT NOT NULL,           -- 被快照对象的 id / version
  version      TEXT,                    -- 版本标签（可空）
  ref_table    TEXT,                    -- 正文所在表；指针式快照非空
  ref_id       TEXT,                    -- 正文所在行；指针式快照非空
  payload_json TEXT,                    -- 冻结副本；**可变对象**（竞品组/总库）用这个
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  archived_at  TEXT,                    -- 非空 = 默认视图隐藏；按 id 仍可解析
  note         TEXT,
  UNIQUE (object_type, object_id, version)
);
CREATE INDEX idx_snap_obj ON snapshot_registry(object_type, object_id, created_at DESC);

-- 回填：既有可登记产物 → 指针式快照。判据只有一条 —— **有据可查的既有行才登记**，
-- 时间戳也必须来自行本身（§8.3「不能解析为 unknown，不回填今天」）。
--   · asin_snapshot：每次采集一行，created_at 取行的 collected_at，version 取行 id。
--   · rule_set：一个版本一行，created_at 取 published_at，version 取版本号。
--   · competitor_set：**可变对象**，除指针外另冻一份 payload 副本（§0 决策 #8）；
--     created_at 取行的 updated_at。
--   · optimization_draft：草案本身无时间列，取它所属 run 的 started_at（有据可查的
--     最近证据）；run 已不在的草案（外键悬空）不登记 —— 没有可查的时间就不发明。
--   · prompt_set：集合本身无时间列，取它的子行 prompt.updated_at 的最早值作为登记
--     时间；没有任何子行的集合不登记（同上，不发明时间戳）。
-- 结构化字段一律 JSON 化（json_object），保证 payload_json 是合法 JSON。

INSERT INTO snapshot_registry
  (id, object_type, object_id, version, ref_table, ref_id, payload_json, created_at, created_by, archived_at, note)
SELECT 'snap:asin_snapshot:' || s.id,
       'listing', s.asin || '@' || s.marketplace, CAST(s.id AS TEXT),
       'asin_snapshot', CAST(s.id AS TEXT), NULL,
       s.collected_at, 'system', NULL,
       'v25 回填：既有采集快照（指针式）'
FROM asin_snapshot s;

INSERT INTO snapshot_registry
  (id, object_type, object_id, version, ref_table, ref_id, payload_json, created_at, created_by, archived_at, note)
SELECT 'snap:rule_set:' || r.version,
       'rule_set', r.version, r.version,
       'rule_set', r.version, NULL,
       r.published_at, 'system', NULL,
       'v25 回填：既有规则集版本（指针式）'
FROM rule_set r;

INSERT INTO snapshot_registry
  (id, object_type, object_id, version, ref_table, ref_id, payload_json, created_at, created_by, archived_at, note)
SELECT 'snap:competitor_set:' || c.id,
       'competitor_set', c.id, '1',
       'competitor_set', c.id,
       json_object('name', c.name, 'marketplace', c.marketplace, 'asins', json(c.asins_json), 'note', c.note),
       c.updated_at, 'system', NULL,
       'v25 回填：竞品组是可变对象，冻一份副本（§0 决策 #8）'
FROM competitor_set c;

INSERT INTO snapshot_registry
  (id, object_type, object_id, version, ref_table, ref_id, payload_json, created_at, created_by, archived_at, note)
SELECT 'snap:optimization_draft:' || d.id,
       'draft', CAST(d.id AS TEXT), '1',
       'optimization_draft', CAST(d.id AS TEXT), NULL,
       run.started_at, 'system', NULL,
       'v25 回填：既有优化草案（指针式，登记时间取所属 run 的 started_at）'
FROM optimization_draft d
JOIN optimization_run run ON run.id = d.run_id;

INSERT INTO snapshot_registry
  (id, object_type, object_id, version, ref_table, ref_id, payload_json, created_at, created_by, archived_at, note)
SELECT 'snap:prompt_set:' || p.id,
       'prompt_set', p.id, p.version,
       'prompt_set', p.id, NULL,
       MIN(pr.updated_at), 'system', NULL,
       'v25 回填：既有提示词集（指针式，登记时间取子行最早写入时间）'
FROM prompt_set p
JOIN prompt pr ON pr.set_id = p.id
GROUP BY p.id, p.version;
`,
  },
  {
    version: 27,
    name: 'field-conflicts',
    sql: `
-- 同字段多源不同值的裁决对象。
-- 与 dq_issue 不是同一张表：一条冲突可以产生一条 DQ-CONSIST-001 问题，
-- 但「问题」是发现，「冲突」是待裁决的对象，两者的状态机不同。
-- UNIQUE(asin, marketplace, field)：一个字段一条冲突；新证据到来是「重开」它，
-- 而不是新建一行 —— 否则同一个字段会在页面上出现两次，且旧裁决无处安放。
CREATE TABLE field_conflict (
  id                TEXT PRIMARY KEY,
  asin              TEXT NOT NULL,
  marketplace       TEXT NOT NULL,
  field             TEXT NOT NULL,
  status            TEXT NOT NULL,
  adopted_value     TEXT,
  adopted_source_id TEXT,
  suggestion_json   TEXT,
  opened_at         TEXT NOT NULL,
  resolved_at       TEXT,
  resolved_by       TEXT,
  note              TEXT,
  UNIQUE (asin, marketplace, field)
);
CREATE INDEX idx_conflict_status ON field_conflict(status, opened_at DESC);
CREATE INDEX idx_conflict_object ON field_conflict(asin, marketplace);
`,
  },
  {
    version: 28,
    name: 'audit-log',
    sql: `
-- 全局审计：每一次写操作一行，带前值/后值。
--
-- 为什么是独立一版、而且能晚落：审计是**横切**能力，拦截点在两个漏斗里
-- （工具注册的包装器与页面写路由），不在逐表补记。所以它只追加一张表、
-- 不碰任何既有表；发布时它在，此后每一条写路径都过漏斗。
--
-- **不回填**：补记 = 伪造历史。审计从本批起生效，开发期的既有数据没有
-- 审计行，这是事实，不是缺失。
--
-- **无删除入口**：本表没有对应的 DELETE 语句、store 函数、路由或工具。
-- 一条可以删掉的审计不是审计。
--
-- 为什么前值/后值存 JSON 文本而不是各自的列：审计记的是「这个对象当时
-- 长什么样」，而对象的形状按表而异。列会随表漂移，JSON 不会。两列都在
-- 写入边界脱敏（before_json / after_json / impact_json 三个值都过
-- redactAuditValue），所以凭据不会以明文落进这张表。
--
-- actor 阶段 1 恒为 'local'（没有用户表）；actor_kind 区分 'page' | 'agent'
-- | 'system' —— 「谁按的」和「哪个平面按的」是两个问题。
--
-- route 形如 'tool:<工具名>' | 'api:<路由名>'，是「这次写从哪条路进来」的
-- 唯一痕迹；没有它，同一次改动的工具路径与页面路径就无法区分。
CREATE TABLE audit_log (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  actor_kind    TEXT NOT NULL,
  action        TEXT NOT NULL,
  object_type   TEXT NOT NULL,
  object_id     TEXT,
  workspace_id  TEXT,
  before_json   TEXT,
  after_json    TEXT,
  reason        TEXT,
  source_run_id TEXT,
  approval_id   TEXT,
  impact_json   TEXT,
  route         TEXT NOT NULL
);
CREATE INDEX idx_audit_at    ON audit_log(at DESC);
CREATE INDEX idx_audit_obj   ON audit_log(object_type, object_id, at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_kind, at DESC);
`,
  },
  {
    version: 29,
    name: 'notification-center',
    sql: `
-- 通知中心（F01-07）。
--
-- dedupe_key 上的**唯一索引就是去重本身**：同一个事件重复触发只留一行，
-- count 累加、并把 read_at 复位为 NULL。用唯一索引而不是「先查再插」，
-- 是因为前者在并发下也成立，后者在两次触发挨得近时会插出两行。
--
-- read_at IS NULL = 未读，不用布尔的 is_read：多一列时间戳几乎不花成本，
-- 而「已读」和「什么时候读的」只有后者能在以后回答。
CREATE TABLE notification (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  severity    TEXT,
  object_type TEXT,
  object_id   TEXT,
  link        TEXT,
  count       INTEGER NOT NULL DEFAULT 1,
  read_at     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_notif_dedupe ON notification(dedupe_key);
CREATE INDEX idx_notif_read ON notification(read_at, created_at DESC);
`,
    /* No backfill, and the 30-day purge is deliberately **not** here: a
       migration runs once, at upgrade, so it could only ever clear the rows that
       existed on the day of the upgrade. The purge belongs on every open. */
  },
  {
    version: 30,
    name: 'agent-orchestration',
    sql: `
-- ── 模块 12：Agent 编排的留痕骨架 ────────────────────────────────────────────
-- 这一版不接 LLM：交付的是**编排骨架 + 留痕 + 门禁**。真实的生成由 DSH Agent
-- 在会话侧完成，插件负责确定性查询、校验与本地写入（§13 的分工）。所以三张表
-- 记的是「谁带着什么上下文、跑了哪些步、产出了什么、卡在哪个门禁上」。
--
-- 留痕**复用 kw_pipeline_run / kw_pipeline_stage 的双表模式**（§17-2 明写要求），
-- 不另发明状态机：一次运行一行，每一步一行，UNIQUE(run_id, seq) 让「步骤不重复」
-- 由结构保证，而不是靠写入方记得先查。
--
-- 上下文包四样（§17-3）**在 run_start 时拷贝进来**，不是引用：§15-5 的验收是
-- 「运行中升级规则/Prompt 不改变该运行」，引用做不到这一点 —— 升级后回读会变。
-- 参考快照在本仓已有先例（optimization_run.rules_json 同样是拷贝）。
--
-- role 不做外键：角色表在代码里（domain/agent/roles.js），不是库里的行。把它落库
-- 就要一条迁移去同步代码里的角色，而那种「代码与库两份声明」正是本仓一直在避免的。
CREATE TABLE agent_run (
  id                   TEXT PRIMARY KEY,
  role                 TEXT NOT NULL,
  goal                 TEXT,
  scope_json           TEXT NOT NULL,          -- 对象范围：站点 / 产品线 / ASIN
  data_snapshot_json   TEXT,                   -- kw_master 版本 + 导入批次号
  rules_snapshot_json  TEXT,                   -- 规则口径快照（拷贝）
  prompts_snapshot_json TEXT,                  -- Prompt 快照（拷贝）
  status               TEXT NOT NULL,          -- draft/ready/running/waiting_human/blocked/completed/failed/cancelled
  waiting_reason       TEXT,                   -- §11：必须说明在等什么，不只是「需要确认」
  blocked_reason       TEXT,
  trigger              TEXT NOT NULL,
  error                TEXT,
  started_at           TEXT NOT NULL,
  finished_at          TEXT
);

CREATE INDEX idx_agent_run_recent ON agent_run(started_at DESC);
CREATE INDEX idx_agent_run_role   ON agent_run(role, started_at DESC);

CREATE TABLE agent_step (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_run(id),
  seq         INTEGER NOT NULL,
  step        TEXT NOT NULL,
  status      TEXT NOT NULL,                   -- pending/running/passed/failed/skipped
  input_json  TEXT,
  output_json TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (run_id, seq)
);

-- ── 产物：Agent 的输出不是聊天气泡，是版本化对象（§10）──────────────────────
-- parent_id 指向上一个版本，所以「这个词包改了三版」是一条链而不是三行孤立的行。
-- status 的四态里 superseded 是链上的旧版本：它还在，还能被旧报告引用（§15-7
-- 的另一面：历史不能被后来的版本改写）。
CREATE TABLE agent_artifact (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_run(id),
  step_seq    INTEGER,
  type        TEXT NOT NULL,
  object_type TEXT,
  object_id   TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  parent_id   TEXT REFERENCES agent_artifact(id),
  status      TEXT NOT NULL,                   -- draft/accepted/rejected/superseded
  body_json   TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_agent_artifact_run ON agent_artifact(run_id, created_at);
-- 一个对象的一条链：按 (object_type, object_id) 取最新版本时不必扫全表。
CREATE INDEX idx_agent_artifact_obj ON agent_artifact(object_type, object_id, version DESC);

-- ── 人工门禁的裁决（§17-4 首批两个）──────────────────────────────────────────
-- 裁决记成一个产物：它同样是「一次运行产出的、可被引用的东西」，而且复用
-- agent_artifact 意味着门禁的批准也有版本与父链，不需要第四张表。
-- gate 的取值域在 domain/agent/gates.js 里（代码是声明，库是事实）。
`,
  },
  {
    version: 31,
    name: 'publication-and-observation',
    sql: `
-- ── 模块 14 §6：发布记录 —— 让「改了 listing 之后发生了什么」有个地方落 ────────
-- 到 v30 为止，这个系统能告诉你「该改什么」，然后就没有然后了：运营在 Seller
-- Central 里手工改完，**没有任何东西记得这件事发生过**。报告只能说「建议改成
-- 这样」，说不了「已经改成这样了、改完第 3 天排名动了」。
--
-- §6 的验收是「没有发布记录时，报告不得显示『已上线』」。要满足它，就必须先有
-- 一个**只能由人来写**的发布事实 —— 本插件不自动发布（§15 的发布边界），所以
-- 这一行永远来自「运营改完了，回来登记」。

-- ① 草案版本。§6 的原话是「发布记录必须引用 optimization_run_id **与草案版本**」，
--    而 optimization_draft 只有逐字段的 accepted 三态，没有任何版本概念。
--    版本从 **1** 开始，所以 SQLite 在 ALTER 时给历史行填的 DEFAULT 0 含义明确：
--    「没追踪过」。**不回填** —— 给一条旧 run 编一个草案版本，就是伪造
--    「当时批准的是这一版」，而这一列存在的唯一目的就是回答这个问题。
--    身份与内容分开，与本仓既有做法一致：optimization_run 的 rules_version
--    （身份）+ rules_json（内容）也是这么配的。
ALTER TABLE optimization_run ADD COLUMN draft_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE publication_record (
  id                   TEXT PRIMARY KEY,
  asin                 TEXT NOT NULL,
  marketplace          TEXT NOT NULL,

  /* draft   = 关联一次优化运行（§6 的正常路径）
     manual  = 手工登记：没有 run、**不计算草案差异、不参与发布率统计**（§6 原话）
     rollback= §9 的回滚登记，必须指出它在回滚哪一条发布记录 */
  kind                 TEXT NOT NULL,
  run_id               TEXT REFERENCES optimization_run(id),
  draft_version        INTEGER,
  rollback_of          TEXT REFERENCES publication_record(id),

  /* approved_json 存的是**完整的目标 listing**（这次运行考虑过的每个字段都有一项：
     采纳的用 after，没采纳的用 before），不是「模型改过的那些字段」的 delta。
     这个选择是这张表最容易写错、也最难被发现的地方：若只存 delta，运营把整段
     listing 粘进后台时，所有没被改动的字段都会落进「发布里出现了、草案没覆盖」，
     于是**每一次正确的发布都会亮「已偏离批准草案」**，而人会很快学会无视它。
     §6 的阈值必须不随「运营粘贴了多少」而移动。 */
  approved_json        TEXT,
  /* published_json 是运营在 SC 里**实际**填进去的值。空对象没有意义：一条什么都没
     发布的记录无法驱动任何后续判断。 */
  published_json       TEXT NOT NULL,
  /* 差异在**登记时算出来并冻结**。不实时重算，因为重算要读「当前草案」——而草案
     在登记之后还会被人改（改完再问「当时为什么说偏离」，答案就变了）。 */
  deviation_json       TEXT,
  deviated             INTEGER NOT NULL DEFAULT 0,
  deviation_rule       TEXT,               -- core-field | over-threshold | NULL
  /* 发布里出现、但批准草案没有覆盖的字段。**记录并报告，但不计入差异比值** ——
     拿不到线上副本时无法区分「运营粘了一个本次没动的字段」和「运营自己编了个值」，
     把它计入会让每一次整段粘贴都判偏离。这是 v1 的**明示边界**，不是遗漏：
     它在结果里有一席之地，所以读的人知道它存在。 */
  uncovered_json       TEXT,
  /* §6 的偏离处置：deviated 的记录必须由人二选一 ——
     reobserve = 以实际发布值为新基线重新观测（原观测计划作废并留痕）
     mispublish= 标记为误发布，进入 §9 的回滚建议流程
     未选择前该 ASIN 的观测卡片是 waiting_human（卡片属 §8，本批只提供事实）。 */
  baseline_choice      TEXT,
  baseline_decided_at  TEXT,

  operator             TEXT,
  note                 TEXT,
  evidence_ref         TEXT,
  published_at         TEXT NOT NULL,
  /* §6 单列「观测起点」，§9 说「观测窗口自该记录重新计时」—— 所以它是一个可以
     与 published_at 不同的时刻（偏离处置里重新观测会把它推到现在）。 */
  observation_start_at TEXT NOT NULL,
  rollback_protected   INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL
);

CREATE INDEX idx_publication_asin ON publication_record(asin, marketplace, published_at DESC);
CREATE INDEX idx_publication_run  ON publication_record(run_id);

-- ── 模块 14 §7：实验设计 —— 每次存量优化是一个受控变更 ────────────────────────
-- §7 要的不是一张「变更清单」，是一份**变更前的声明**：假设是什么、基线是哪一段、
-- 哪些字段动哪些不动、成功与失败各看什么指标、观察多久、有哪些干扰因素、
-- 什么条件下回滚。没有这份声明，观测期的结论就是事后叙事 —— 想怎么说都行。
CREATE TABLE observation_plan (
  id                  TEXT PRIMARY KEY,
  publication_id      TEXT NOT NULL REFERENCES publication_record(id),
  hypothesis          TEXT,
  baseline_start      TEXT,
  baseline_end        TEXT,
  changed_json        TEXT,
  unchanged_json      TEXT,
  success_json        TEXT,
  fail_json           TEXT,
  /* §8 的默认节点是发布后 7/14/30 天，但「观察窗口」是 §7 的设计项，所以这里存
     计划自己的节点（'7,14,30'），默认值在代码里给。§8 据此生成观测卡片。 */
  window_days         TEXT NOT NULL,
  confounders         TEXT,
  rollback_conditions TEXT,
  /* §7：「单轮原则上修改 ≤30%，五点每次 1–2 条；若全量重写，必须标为重建而非小
     实验。」这一列就是「标为重建」的落点，而 30% 那条规则在 domain/observe/plan.js
     里 fail-closed —— 改超了又不肯标重建的声明会被拒收。 */
  rebuild             INTEGER NOT NULL DEFAULT 0,
  /* superseded 是 §6 偏离处置「原观测计划作废并留痕」的落点：作废的计划**还在**，
     只是不再是当前那份。删掉它就等于抹掉「当时是这么计划的」。 */
  status              TEXT NOT NULL DEFAULT 'active',
  superseded_reason   TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_observation_plan_pub ON observation_plan(publication_id, created_at DESC);

-- 这一版不建 observation_checkpoint / rollback_task：§8 的观测卡片与 §9 的回滚
-- 交付包是下一批。先让「发布这件事」有个事实来源，再谈从它出发能算什么 ——
-- 反过来先造观测卡片，卡片就没有可观测的起点。
`,
  },
  {
    version: 32,
    name: 'observation-and-rollback',
    sql: `
-- ── 模块 14 §8：观测节点的终止事实落在发布记录上 ──────────────────────────────
-- 「这次发布的观测已被回滚终止」是**发布记录**的性质，不是某个节点的性质：一条发布
-- 记录可能一个节点都还没物化就被回滚了（刚发布就撤回），此时没有任何节点行可以承载
-- 这个事实。把它记在节点上，读的人就得从「有没有节点行」去推断 —— 而「没有节点」
-- 与「节点被删了」长得一样。所以记在这里，终止时无论有没有节点都写。
ALTER TABLE publication_record ADD COLUMN observation_terminated_at TEXT;
ALTER TABLE publication_record ADD COLUMN observation_terminated_reason TEXT;

-- ── 模块 14 §8：观测节点 —— 让「改完第 7 天怎么样」有一个可回答的位置 ──────────
-- §6 记下了「发布了什么」，但发布本身不是结论。§8 要的是到点去看一眼，而它有一条
-- 硬约束：**不允许把空数据渲染成「无变化」结论**。所以这张表的核心不是 metrics，
-- 是 missing_json 与 blocked_reason —— 一个没有数据的观测点必须**说出来**，
-- 而不是安静地长成一行「持平」。
-- UNIQUE (publication_id, day) 让「同一个节点只有一行」由**结构**保证，而不是靠
-- 刷新逻辑记得先查一次。§8 的节点是发布后 7/14/30 天，但窗口本身是 §7 的设计项
-- （observation_plan.window_days），这里只落它物化出来的节点。
--
-- 状态由 domain/observe/observation.js 判定，这里只负责存。六个取值：
--   pending    还没到点
--   ready      到点了、有数据，等人下结论
--   blocked    到点了、**数据不足**，missing_json 是补数清单（§8 的前置检查）
--   concluded  人已经给了结论
--   terminated 这次发布的观测被回滚终止（§9），结论**保留**并标注
--   retired    §7 的观测窗口变了（window_days 是设计项），这个节点不在新窗口里 ——
--              **不是**回滚。与 terminated 合并会让改一次窗口就把整个 ASIN 显示成
--              「已回滚终止」。
-- §6 的 waiting_human（偏离草案未处置）**不在这里存**：它是发布记录的性质，派生
-- 出来即可，存一份就会有第二份会过期的真相。
CREATE TABLE observation_checkpoint (
  id              TEXT PRIMARY KEY,
  publication_id  TEXT NOT NULL REFERENCES publication_record(id),
  day             INTEGER NOT NULL,
  due_at          TEXT NOT NULL,
  status          TEXT NOT NULL,
  blocked_reason  TEXT,
  missing_json    TEXT,              -- 补数清单：每一项带「去哪补、补什么」
  metrics_json    TEXT,              -- 已取到的指标：绝对值 / 变化 / 样本量 / 来源 / 周期
  conclusion      TEXT,              -- keep | watch | revise | rollback | insufficient
  conclusion_note TEXT,
  concluded_at    TEXT,
  concluded_by    TEXT,
  terminated_at   TEXT,
  terminated_reason TEXT,
  retired_at      TEXT,
  retired_reason  TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (publication_id, day)
);

CREATE INDEX idx_observation_due ON observation_checkpoint(status, due_at);
CREATE INDEX idx_observation_pub ON observation_checkpoint(publication_id, day);

-- ── 模块 14 §9：回滚交付包 ────────────────────────────────────────────────────
-- §9 明确「系统不提供『一键回滚到线上』」：生成交付包之后状态是「回滚待发布」，
-- 直到运营按清单在 Seller Central 改回**并且**回到 §6 登记一条 type=rollback 的
-- 发布记录，这次回滚才闭环。所以这张表记的是**一次进行中的回滚**，不是一次动作。
--
-- from_publication_id 是生成时「线上的那一版」，to_publication_id 是回滚目标
-- （上一次实际发布记录全字段）。两者都存 id 而不是值：交付包按这两条记录**重算**，
-- 于是它永远等于「那两条记录之间的差异」，而不是一份生成之后就开始腐烂的快照。
-- package_json 另存生成当时的那一份，只为留痕。
--
-- 于是「已回滚终止」有了一个可判定的条件：若在任务进行中又出现了更新的发布记录，
-- from_publication_id 就不再是线上那一版 —— 此时**不能**照旧回滚（那会丢掉新做的工作），
-- 视图报 stale 而不是默默执行。这是本表唯一的不变式，判定在 store/observe.js。
CREATE TABLE rollback_task (
  id                       TEXT PRIMARY KEY,
  publication_id           TEXT NOT NULL REFERENCES publication_record(id),
  from_publication_id      TEXT REFERENCES publication_record(id),
  to_publication_id        TEXT REFERENCES publication_record(id),
  status                   TEXT NOT NULL,   -- pending_publish | closed | cancelled
  package_json             TEXT,
  reason                   TEXT,
  created_at               TEXT NOT NULL,
  closed_at                TEXT,
  closed_by_publication_id TEXT REFERENCES publication_record(id)
);

CREATE INDEX idx_rollback_task_status ON rollback_task(status, created_at DESC);
CREATE INDEX idx_rollback_task_pub    ON rollback_task(publication_id);
`,
  },
  {
    /* 合并注意：本迁移号是 33，但另一个批次（模块 04）可能也在写 33。合并时按 main
       当前的最大版本**重编号**即可，内容不用动 —— 这两张表与模块 04 的改动无关。 */
    version: 33,
    name: 'keyword-lifecycle',
    sql: `
-- ── 模块 08 F08-07：关键词的九态生命周期 ─────────────────────────────────────
--
-- ## 为什么这张表**必须**独立于 kw_master（本批最重要的一条）
--
-- 生命周期状态不能加在 kw_master 上。recomputeMaster（src/store/kw.js）是**整层
-- 重建**：它先把整张 kw_master 删空、再重新插入每一行，因为那张表是**事实的函数**
-- （ABA/广告/竞品导出的纯函数）。代码里只显式保住了一列历史 —— first_seen_at，
-- 注释原话是「the one column that is *not* a function of the facts」。也就是说，任何
-- 新加在 kw_master 上的列，都会在下一次导入触发重算时被**静默抹掉**，而重算本身
-- 不报错、不留痕。生命周期是**人工决定**，不是事实的函数，它必须活过重建 —— 所以它
-- 独立成表，主键 (keyword, marketplace)：这个项目的既定口径是「不同站点同拼写不是
-- 同一个业务词」，与 kw_master 的主键口径一致。
--
-- 测试 tests/b08-lifecycle.mjs 的 ① 号断言真的调一次 recomputeMaster 再看状态，
-- 就是为了把这条钉死：把状态放进 kw_master 的实现会在那条断言上当场失败。
CREATE TABLE keyword_lifecycle (
  keyword       TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  status        TEXT NOT NULL,          -- 九态之一，词表在 domain/states.js
  reason        TEXT,                   -- 为什么改（人填；观察结论联动时也记这里）
  source        TEXT NOT NULL,          -- manual | publication | observation
  evidence_json TEXT,                   -- 结构化证据（如发布记录字段、观测结论）
  changed_at    TEXT NOT NULL,
  changed_by    TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (keyword, marketplace)
);

-- 页面要按状态计数与筛选，所以按 (站点, 状态) 建索引，而不是只按主键。
CREATE INDEX idx_keyword_lifecycle_status ON keyword_lifecycle(marketplace, status);

-- ── 流转历史：只追加，永不更新、永不删除 ─────────────────────────────────────
--
-- 验收要求「所有权冲突清晰可处理并留历史」。每一次流转追加一行。from_status 首次
-- 为 NULL —— 那是「此前没有状态」，不是「从某个状态来」；把首次写成某个初始态会
-- 伪造一段从未发生的历史。
--
-- publication_id 可空，用于关联一次发布（F08-07 的「assigned→used 由发布记录自动
-- 置位」在本批实现为**显式声明的关联**：调用方必须给出「这次发布用了这几个词」，
-- 系统记下来。真正的自动前置是 F08-05 位置计划持久层，本批不做）。REFERENCES 让
-- 一个不存在的发布 id 在库层就被拒，与 store 层的显式校验互为双保险。
--
-- 「不支持删除」在本批是一条**被实现的约束**，不是「因为没入口所以删不掉」：
--   · 这张表没有 DELETE 语句，事件只追加；
--   · 九态里 excluded 与 archived **不是终态**（能回 active），所以「删掉一个词」
--     在模型里根本没有位置 —— 产品线变更后它可以回来。见 domain/states.js。
CREATE TABLE keyword_lifecycle_event (
  id             TEXT PRIMARY KEY,
  keyword        TEXT NOT NULL,
  marketplace    TEXT NOT NULL,
  from_status    TEXT,                  -- 首次为 NULL
  to_status      TEXT NOT NULL,
  reason         TEXT,
  source         TEXT NOT NULL,
  evidence_json  TEXT,
  publication_id TEXT REFERENCES publication_record(id),
  at             TEXT NOT NULL,
  by             TEXT
);

-- 历史按 (keyword, marketplace, at) 查：一条词的时间线是最常见的读法。
CREATE INDEX idx_keyword_lifecycle_event ON keyword_lifecycle_event(keyword, marketplace, at);
CREATE INDEX idx_keyword_lifecycle_event_pub ON keyword_lifecycle_event(publication_id);
`,
  },
  {
    /* 合并注意：本迁移号是 34，但另一个批次（模块 04）可能也在写 34。合并时按 main
       当前的最大版本**重编号**即可，内容不用动 —— 这三张表与模块 04 的改动无关。 */
    version: 34,
    name: 'keyword-ownership',
    sql: `
-- ── 模块 08 F08-04：关键词所有权 ─────────────────────────────────────────────
--
-- ## 这不是 asin_ownership，也不是 field_conflict
--
-- 本仓里已经有两个名字里带 ownership / conflict 的对象，它们**都不是**关键词所有权：
--   · asin_ownership（v23）—— ASIN 归属（ASIN → product_line / brand / shop / side），
--     说的是「这个 ASIN 是谁的」，与关键词无关；
--   · field_conflict（v27）—— ASIN **字段级**冲突（price / title / bsr …），
--     说的是「几个来源对同一字段的读数不一致」。
-- 关键词所有权在此之前完全不存在。命名接近不等于同一个对象 —— 审计报告 §4.5 点名过
-- 「两个数都是 14 就以为对齐了」这种数数法掩盖过缺口，所以这里把边界写在表头上。
--
-- ## 主张是事实，主人与冲突都是**推导**
--
-- 这张表存的是「某个 ASIN 认领某个词」的**主张**（claim）。主键口径
-- (keyword, marketplace, asin)：不同站点同拼写不是同一个业务词，与 kw_master /
-- keyword_lifecycle 一致。
--
-- 「当前主人」**不是一个字段**，而是推导出来的：主人 = 该词下唯一那条**生效**
-- （status = 'claimed'）的主张。「冲突」**也不是一个字段**：同一词下 ≥2 条生效主张
-- 就是冲突。**故意不存冲突标志位** —— 存了就会与事实漂移：释放了一条主张之后，
-- 那个标志位要么得有人记得改，要么就永久说谎。
--
-- ## 释放不删行
--
-- 照 asin_ownership.retracted_at 的先例（那里的注释原话是「人工撤销置位；**不删行**」），
-- 释放用 released_at + released_reason 置位，行本身保留。重新认领就是把同一行 upsert
-- 回 'claimed' 并清空 released_at / released_reason —— 一放一收的完整轨迹在事件表里。
--
-- locked：锁定后不许释放 / 转移，除非显式解锁（语义在 store/keyword-ownership.js）。
CREATE TABLE keyword_ownership (
  id              TEXT PRIMARY KEY,
  keyword         TEXT NOT NULL,
  marketplace     TEXT NOT NULL,
  asin            TEXT NOT NULL,
  status          TEXT NOT NULL,          -- claimed | released，词表在 domain/states.js
  locked          INTEGER NOT NULL DEFAULT 0,
  claim_source    TEXT NOT NULL,          -- manual | agent | auto
  evidence_json   TEXT,                   -- 结构化证据（自由结构，原型里是 SQP 点击份额 / run id / 快照号）
  claimed_at      TEXT NOT NULL,
  claimed_by      TEXT,
  released_at     TEXT,                   -- 释放置位；**不删行**
  released_reason TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (keyword, marketplace, asin)
);

-- 工作台按 (站点, 生效状态) 分组算主人与冲突，所以按这个顺序建索引，而不是只按主键。
CREATE INDEX idx_keyword_ownership_lookup ON keyword_ownership(marketplace, status, keyword);
-- 「这个 ASIN 名下有哪些词」是牵连面的读法。
CREATE INDEX idx_keyword_ownership_asin ON keyword_ownership(asin, marketplace);

-- ── Agent 建议：原型「建议（Agent 回写）」那一列 ─────────────────────────────
--
-- 一个词一条建议（UNIQUE (keyword, marketplace)）：建议是「当前的最佳判断」，
-- 不是一份建议历史 —— 历史在事件表里（action = 'suggest' / 'adopt'）。
--
-- **采纳后不删建议行**，只写 adopted_at / adopted_asin。建议本身是证据：审计要能回答
-- 「当时建议的是什么、谁在什么时候采纳了它」。删掉它，「采纳」就只剩一条没有依据的
-- 主张。
CREATE TABLE keyword_ownership_suggestion (
  id             TEXT PRIMARY KEY,
  keyword        TEXT NOT NULL,
  marketplace    TEXT NOT NULL,
  suggested_asin TEXT NOT NULL,
  reason         TEXT,
  evidence_json  TEXT,
  suggested_at   TEXT NOT NULL,
  suggested_by   TEXT,
  adopted_at     TEXT,                    -- 人工裁决：采纳时间；NULL = 还没被采纳
  adopted_asin   TEXT,
  UNIQUE (keyword, marketplace)
);

-- ── 历史：只追加，永不更新、永不删除（验收 §22.7「留历史」）────────────────────
--
-- 分配 / 释放 / 锁定 / 解锁 / 建议 / 采纳，每一次都追加一行。这是「所有权冲突清晰可
-- 处理并留历史」里「留历史」那一半的实现 —— 少了它，释放就是一次静默的翻状态。
--
-- confirmed / impact_json 是**「把操作者确认了什么记进历史」**：批量操作影响到活跃优化
-- 运行时，执行前必须显式二次确认（见 store/keyword-ownership.js），这里把「他当时看到
-- 并确认的是哪几个运行」原样记下来。审计要回答的正是这个，而不是一句「已确认」。
--
-- 「位置计划已变化」这类标记**不写** —— 那是原型的示意，不是本批能诚实产出的东西。
-- ⚠️ 理由在 2026-10-13（T-8）订正过一次：位置计划的**表**从 schema v35（迁移 keyword-plan，
--    需求 F08-05）起就在（见下面那一段迁移注释），本批不写标记的原因是**本库还没有
--    存过任何一版计划**（没有可比对的计划，就没有「变化」可言），不是「表不存在」。
--    一句话的两种说法在这里差别很大：前者是「没有数据」，后者是「没建模」。
--    ⚠️ 这段注释在一个模板字符串里：不许出现反引号（plugin-contract §8.1）。
CREATE TABLE keyword_ownership_event (
  id            TEXT PRIMARY KEY,
  keyword       TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  asin          TEXT,
  action        TEXT NOT NULL,            -- claim | release | lock | unlock | suggest | adopt
  from_status   TEXT,
  to_status     TEXT,
  reason        TEXT,
  source        TEXT NOT NULL,
  evidence_json TEXT,
  confirmed     INTEGER NOT NULL DEFAULT 0,
  impact_json   TEXT,
  at            TEXT NOT NULL,
  by            TEXT
);

-- 一条词的时间线是最常见的读法。
CREATE INDEX idx_keyword_ownership_event ON keyword_ownership_event(keyword, marketplace, at);
CREATE INDEX idx_keyword_ownership_event_asin ON keyword_ownership_event(asin);
`,
  },
  {
    /* 合并注意：本迁移号是 35，但另一个批次（模块 04 / 13）可能也在写 35。合并时按
       main 当前的最大版本**重编号**即可，内容不用动 —— 这两张表与它们的改动无关。 */
    version: 35,
    name: 'keyword-plan',
    sql: `
-- ── 模块 08 F08-05：位置计划持久层 ───────────────────────────────────────────
--
-- ## 这不是 for_listing_json，也不是所有权 / 生命周期
--
-- 本仓里已经有三样东西与「词放在哪」沾边，它们**都不是**位置计划：
--   · kw_master.for_listing_json（v? 起）—— **资格**：这个词**允许**放进哪些位置
--     （title sv≥10000 & tier≤3、bullets sv≥1000 & tier≤4、adsExact …、backend 恒真）。
--     资格 ≠ 分配。资格说「可以」，计划说「就放这里」。
--   · keyword_ownership（v34）—— 哪个 ASIN 认领了这个词，与位置无关；
--   · keyword_lifecycle（v33）—— 这个词走到哪一步了，与位置无关。
-- 把资格当计划（或反之）正是审计报告 §4.5 点名的「两个数都是 14 就以为对齐了」。
--
-- ## 唯一持久层在模块 08（需求 §10 原话）
--
-- 需求 §10：「**位置计划的唯一持久层在模块 08**；13 只引用与冻结，不产生第二份口径。」
-- 所以 domain/optimize/plan.js 里那份**模型**（buildKeywordAllocation / buildCoverageMatrix）
-- 仍然是每次优化运行**当场算、不落库**的推导；本模块才是那份计划**唯一**的落点。
-- 13 要用的计划，从这里读，不自己再存一份。
--
-- ## 一词一主人，在库层是**结构约束**，而且判定用的是**折叠键**
--
-- keyword_plan_entry 的主键是 (plan_id, keyword_key)。也就是说，**同一个计划里同一个词
-- 出现两次，在 SQLite 层就是不可能的** —— 不是「代码里记得查重」，而是「忘了查重也
-- 插不进去」。一次静默的 last-wins 会让「一词一主人」变成一句谎：计划里两条主人，
-- 读的人挑哪条都对。savePlan 另外在代码层显式拒绝重复并抛错（给出可读的理由），
-- 但**结构约束才是兜底的那一层**：代码可以被绕过，主键不能。
--
-- ★ 主键建在 keyword_key（折叠键）上，不是原始 keyword 上。本仓的既定口径是
--   「关键词身份是折叠的」—— domain/keywords/key.js 的 keywordKey（trim + 折叠
--   内部空白 + 大小写折叠），v15 迁移用它把整个库折叠过一遍。若主键建在原始串上，
--   'Bench  Cushion' 与 'bench cushion' 会**并存成两行主人**，而它们在别处是同一个
--   词 —— 主键会与库的口径自相矛盾，且「忘了查重也插不进去」这句话对变体不成立。
--   keyword 保留原始拼写用于展示，判定一律走 keyword_key。
CREATE TABLE keyword_plan (
  id          TEXT PRIMARY KEY,
  asin        TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  name        TEXT,
  note        TEXT,
  lineage_id  TEXT NOT NULL,          -- 版本族根；改一次计划 = 同一 lineage 里 +1 版
  version     INTEGER NOT NULL,
  status      TEXT NOT NULL,          -- draft | active | archived，词表在 domain/states.js
  source      TEXT NOT NULL,          -- manual | agent | proposal
  created_at  TEXT NOT NULL,
  created_by  TEXT,
  UNIQUE (lineage_id, version)
);

-- 「这个 ASIN 在这个站点有哪些版本的计划」是唯一的读法（页面 / 工具都这么查）。
CREATE INDEX idx_keyword_plan_lookup ON keyword_plan(marketplace, asin, lineage_id, version DESC);

CREATE TABLE keyword_plan_entry (
  plan_id         TEXT NOT NULL REFERENCES keyword_plan(id),
  keyword         TEXT NOT NULL,      -- 展示用：存下来的原始拼写
  keyword_key     TEXT NOT NULL,      -- 折叠键：一词一主人的判定用这个（keywordKey）
  owner_position  TEXT NOT NULL,
  tier            TEXT,
  search_volume   INTEGER,
  support_json    TEXT,               -- [{position, reason, probe?}]
  created_at      TEXT NOT NULL,
  PRIMARY KEY (plan_id, keyword_key)  -- ★ 一词一主人，建在折叠键上（见文件头）
);

-- 读一个计划的全部条目，以及「某个位置上有哪些词」的统计，都按 plan_id 走。
CREATE INDEX idx_keyword_plan_entry_plan ON keyword_plan_entry(plan_id, owner_position);
`,
  },
  {
    /* 合并注意：本迁移号是 36，但另一个批次（模块 13 / 模块 06）可能也在写 36。合并时按
       main 当前的最大版本**重编号**即可，内容不用动 —— 这五张表与 14 个列与它们无关。 */
    version: 36,
    name: 'collection-center',
    sql: `
-- ── 模块 04 F04-01…F04-10：采集中心的地基 ─────────────────────────────────────
--
-- 本迁移只做**存储层**：五张新表 + collection_task 的 14 个可空新列。这一批不加工具、
-- 不加路由、不改页面（那些走同一个契约的后续子批），所以这里没有回填、没有 UPDATE、
-- 没有 DELETE —— 老行一个字都不动。
--
-- 为什么新列全部可空：它们的语义是「这个功能没用过」，而不是「用过了、值是空的」。
-- 既有 81 个工具写入的任务行升级后在页面上的呈现与升级前逐像素一致（页面读不到值
-- 就是 NULL，不是假值）。唯一例外是 attempt（NOT NULL DEFAULT 1）：每个老任务确实
-- 都是第 1 次尝试，SQLite 在 ADD COLUMN 时把既有行填成 1 是**正确答案**，不是回填。

-- ── 采集方案（F04-09）：版本化资产，同名方案的多版本是不同主键行 ────────────────
--
-- 主键是 (id, version)，所以「同一方案的同一个版本」在结构上不可能存在两行 —— 这正是
-- 「被任务引用时冻结版本号」要的前提：引用 (id, version) 就一定指向同一份内容。
-- 这里**故意不设 is_current 列**：当前版由任务引用决定，不由方案自己宣布。加一列
-- is_current 会让一次「设为当前」静默改变历史任务引用的解释。
CREATE TABLE IF NOT EXISTS collection_scheme (
  id                   TEXT NOT NULL,
  name                 TEXT NOT NULL,
  version              INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft',
  driver               TEXT NOT NULL DEFAULT 'browser-local',
  marketplaces_json    TEXT,
  sections_json        TEXT NOT NULL,
  requires_login       INTEGER NOT NULL DEFAULT 0,
  risk_level           TEXT,
  default_pacing_json  TEXT,
  verified_at          TEXT,
  verified_by          TEXT,
  note                 TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS idx_scheme_status ON collection_scheme(status, updated_at DESC);

-- ── 计划采集（F04-10）：默认关闭；没有 next_run_at 列（没有调度器）─────────────
--
-- 本插件没有常驻定时器（时间驱动的规则只在打开工作台时跑），所以「下次运行时间」没有
-- 可信的计算方。写一个只有人算得出来的列，等于把计算错误存进库。
-- 计划名是人的把手：重名会让「暂停哪一个计划」不可回答，因此 UNIQUE(name)。
CREATE TABLE IF NOT EXISTS collection_plan (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 0,
  marketplace           TEXT,
  targets_json          TEXT NOT NULL,
  scheme_id             TEXT,
  scheme_version        INTEGER,
  window_json           TEXT,
  interval_minutes      INTEGER,
  max_objects           INTEGER NOT NULL DEFAULT 50,
  failure_policy        TEXT NOT NULL DEFAULT 'stop',
  cooldown_minutes      INTEGER NOT NULL DEFAULT 60,
  notify                TEXT NOT NULL DEFAULT 'none',
  pause_condition_json  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (name)
);
CREATE INDEX IF NOT EXISTS idx_plan_enabled ON collection_plan(enabled, marketplace);

-- ── 体检明细（F04-01）：一行一项，十项 ────────────────────────────────────────
--
-- task_id 可空，且 NULL 在 SQLite 的 UNIQUE 里不参与比较 —— 所以「独立体检」（不属于
-- 任何任务）可以有多轮，而「挂在一个任务上的同一项」在同一个 checked_at 上只有一行。
-- 这是有意的：独立体检没有任务可归属，把它硬塞进某个任务会伪造一次归属。
CREATE TABLE IF NOT EXISTS collection_env_check (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES collection_task(id),
  check_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  detail        TEXT,
  repairable    INTEGER NOT NULL DEFAULT 0,
  repair_action TEXT,
  risk          TEXT NOT NULL DEFAULT 'low',
  checked_at    TEXT NOT NULL,
  UNIQUE (task_id, check_id, checked_at)
);
CREATE INDEX IF NOT EXISTS idx_envcheck_task ON collection_env_check(task_id, check_id);

-- ── 13 节明细（F04-07）：UNIQUE 是断点恢复的载体 ──────────────────────────────
--
-- 主键用**文本复合坐标**（taskId:asin:marketplace:section）而不是自增序号：这一行的身份
-- 是内容坐标，不是序号。自增 id 会让「同一坐标写两次」安静地变成两行，而 UNIQUE
-- (task_id, asin, marketplace, section) 就是防这件事的 —— 恢复时按它判断
-- 「这一节已经有 collected 行 → 不再重采」。
-- raw_value_json 与 parsed_value_json 分开两列：解析后的结构化值不许覆盖原始读数，
-- 否则「页面上的原文是什么」在第一次解析之后就再也回答不了。
CREATE TABLE IF NOT EXISTS collection_section_result (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES collection_task(id),
  asin               TEXT NOT NULL,
  marketplace        TEXT NOT NULL,
  section            TEXT NOT NULL,
  status             TEXT NOT NULL,
  raw_value_json     TEXT,
  parsed_value_json  TEXT,
  page_region        TEXT,
  selector_hits_json TEXT,
  errors_json        TEXT,
  collected_at       TEXT,
  scheme_version     INTEGER,
  snapshot_ref       TEXT,
  diff_json          TEXT,
  UNIQUE (task_id, asin, marketplace, section)
);
CREATE INDEX IF NOT EXISTS idx_section_task ON collection_section_result(task_id, asin, status);
CREATE INDEX IF NOT EXISTS idx_section_asin ON collection_section_result(asin, marketplace, collected_at DESC);

-- ── 任务流转历史：只追加，永不更新、永不删除 ──────────────────────────────────
--
-- 与 keyword_lifecycle_event 同一个模式：状态是决定，历史只追加。from_status 首次为
-- NULL —— 那是「此前没有状态」，把它写成某个初始态会伪造一段从未发生的历史。
CREATE TABLE IF NOT EXISTS collection_task_event (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES collection_task(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  reason        TEXT,
  source        TEXT NOT NULL,
  evidence_json TEXT,
  at            TEXT NOT NULL,
  by            TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_event ON collection_task_event(task_id, at);

-- ── collection_task 追加列：全部可空，老行不回填（NULL 就是「没用过这个功能」）──
--
-- ★ 这 14 条 ALTER 是**本仓唯一的非幂等语句**：SQLite 的 ADD COLUMN 没有 IF NOT
--   EXISTS，重复执行会以 duplicate column name 失败。它们只允许出现在这个只跑一次
--   的迁移里；整段迁移以 user_version 为准，跑过就不再跑（db.js 的 migrate）。
-- ★ collection_plan 必须先建，plan_id 的 REFERENCES 才有目标。
ALTER TABLE collection_task ADD COLUMN side_split_json TEXT;
ALTER TABLE collection_task ADD COLUMN ownership_evidence_json TEXT;
ALTER TABLE collection_task ADD COLUMN scheme_id TEXT;
ALTER TABLE collection_task ADD COLUMN scheme_version INTEGER;
ALTER TABLE collection_task ADD COLUMN plan_id TEXT REFERENCES collection_plan(id);
ALTER TABLE collection_task ADD COLUMN prefill_json TEXT;
ALTER TABLE collection_task ADD COLUMN env_check_json TEXT;
ALTER TABLE collection_task ADD COLUMN env_checked_at TEXT;
ALTER TABLE collection_task ADD COLUMN waiting_json TEXT;
ALTER TABLE collection_task ADD COLUMN resolved_at TEXT;
ALTER TABLE collection_task ADD COLUMN risk_json TEXT;
ALTER TABLE collection_task ADD COLUMN reused_snapshots_json TEXT;
ALTER TABLE collection_task ADD COLUMN retry_of TEXT;
ALTER TABLE collection_task ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;

-- 超时扫描按 (status, updated_at) 走，所以 idx_task_waiting 的键顺序不能反：
-- 先按状态缩小（waiting_human 的行很少），再按 updated_at 判到期。
CREATE INDEX IF NOT EXISTS idx_task_plan    ON collection_task(plan_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_waiting ON collection_task(status, updated_at);
`,
  },
  {
    /* 合并注意：本批开工时 main 的最大版本是 36，所以这一条是 37。并入时若 main 已经
       推高，按 main 当前最大值**重编号**即可，内容不用动 —— 这四张表与三个列与采集
       中心、关键词、优化三块谁都不碰。（与 v36 的那条注记同一个约定。） */
    version: 37,
    name: 'asin-datacenter',
    sql: `
-- ── 模块 05 F05-06 / F05-08：ASIN 数据中心的**数据层** ─────────────────────────
--
-- 本迁移只做存储层：四张新表 + asin 的三个新列。这一批不加回填、不加 UPDATE、
-- 不加 DELETE —— 老行一个字都不动（三个新列全可空，NULL 就是「从来没有归档过」）。
--
-- ## 变体关系为什么是**三张表**而不是一张
--
-- 三个问题长得像但不是一件事，合成一张就要用一个可空的维度列去表达「这条边还没有
-- 维度」，而那正是本仓反复拒绝的形态（缺失被渲染成一个像值的东西）：
--
--   · asin_variant_relation        —— 哪些**边**（父→子）被声称过，现在还算不算数；
--   · asin_variant_dimension       —— 每条边上每个**维度**（颜色/尺码）是什么值，谁说的；
--   · asin_variant_relation_event  —— 边被新建 / 纠正 / 恢复的**历史**，只追加、永不改。
--
-- ## ★ 两种「矛盾」必须存得进去，否则检测器永远测不到
--
-- 设计文档 §3.6 要「检测重复或矛盾变体」，而**重复**与**矛盾**都是库里的实际状态，
-- 不是库该拒绝的输入：
--
--   · 重复：同一个父体下两个子体，维度值一模一样（同一个商品被挂了两遍）；
--   · 矛盾：同一个子体同时挂在**两个不同父体**下；或者同一个子体在**同一维度**上
--     被两个来源给出了两个值。
--
-- 所以约束只建在两处**身份**上，不建在「一个子体只能有一个父体」上 ——
-- 一条把矛盾挡在库外的约束，等于把「检测」实现成了一个永远为空的列表：
--
--   UNIQUE (marketplace, parent_asin, child_asin)  —— 同一条边不存两行（幂等 upsert）
--   UNIQUE (marketplace, parent_asin, child_asin, dimension, source_id)
--                                                  —— 同一来源对同一维度只给一个值
--
-- 而 CHECK (parent_asin <> child_asin) 管的是另一件事：**自己不能是自己的父体**。
-- 那是结构上的不可能，不是一条待人纠正的矛盾 —— 两者混在一起，页面就得把「数据错了」
-- 与「有人写了个环」画成同一个样子。
CREATE TABLE IF NOT EXISTS asin_variant_relation (
  id                TEXT PRIMARY KEY,
  marketplace       TEXT NOT NULL,
  parent_asin       TEXT NOT NULL,
  child_asin        TEXT NOT NULL,
  source_id         TEXT,
  evidence          TEXT,
  /* active = 这条边现在算数；corrected = 有人纠正过，行留着供追溯（永不删除）。 */
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  corrected_at      TEXT,
  correction_reason TEXT,
  UNIQUE (marketplace, parent_asin, child_asin),
  CHECK (parent_asin <> child_asin)
);
-- 「这个父体下有哪些子体」「这个子体挂在哪些父体下」是两次不同的查询，各建一条索引；
-- status 跟着走，因为两条查询都只关心生效的边。
CREATE INDEX IF NOT EXISTS idx_variant_relation_parent ON asin_variant_relation(marketplace, parent_asin, status);
CREATE INDEX IF NOT EXISTS idx_variant_relation_child  ON asin_variant_relation(marketplace, child_asin, status);

-- 维度值的**来源**进主键：同一个来源重写同一个维度是覆盖（upsert），两个来源给出两个值
-- 是两条行 —— 后者不是脏数据，正是要报出来的那件事。source_id NOT NULL：一个没有来源的
-- 维度值是一条没人能追溯的读数（与 asin_field_source 同一条纪律）。
CREATE TABLE IF NOT EXISTS asin_variant_dimension (
  id           TEXT PRIMARY KEY,
  marketplace  TEXT NOT NULL,
  parent_asin  TEXT NOT NULL,
  child_asin   TEXT NOT NULL,
  dimension    TEXT NOT NULL,
  value        TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  /* 观察时间与入库时间分开，理由同 asin_field_source：一个没有观察时间的值必须读作
     「没人记过它什么时候是真的」，而不是被默认成刚刚。 */
  observed_at  TEXT,
  ingested_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (marketplace, parent_asin, child_asin, dimension, source_id),
  /* 维度值必须挂在一条**真的存在**的边上：否则「这个子体属于那个父体」这句话在两张表里
     可以给出两个答案。复合外键指向上面那条 UNIQUE。 */
  FOREIGN KEY (marketplace, parent_asin, child_asin)
    REFERENCES asin_variant_relation(marketplace, parent_asin, child_asin)
);
-- 重复检测要按 (父体, 维度, 值) 分组找同一坐标上的多个子体，所以键按父体+维度排。
CREATE INDEX IF NOT EXISTS idx_variant_dimension_parent ON asin_variant_dimension(marketplace, parent_asin, dimension);
CREATE INDEX IF NOT EXISTS idx_variant_dimension_child  ON asin_variant_dimension(marketplace, child_asin, dimension);

-- 关系的历史：只追加。与 collection_task_event / keyword_lifecycle_event 同一个模式 ——
-- 状态是决定，历史只追加；「错误关系可纠正且留历史」（模块设计 §7.4）靠的就是这张表，
-- 而不是靠 asin_variant_relation.correction_reason 那一列（那一列只说最后一条）。
CREATE TABLE IF NOT EXISTS asin_variant_relation_event (
  id           TEXT PRIMARY KEY,
  relation_id  TEXT NOT NULL REFERENCES asin_variant_relation(id),
  action       TEXT NOT NULL,
  reason       TEXT,
  evidence     TEXT,
  at           TEXT NOT NULL,
  by           TEXT
);
CREATE INDEX IF NOT EXISTS idx_variant_event ON asin_variant_relation_event(relation_id, at);

-- ── F05-08 ASIN 归档：三列当前状态 + 一张事件表 ────────────────────────────────
--
-- ★ 三个列是**当前状态**，事件表是**历史**，两者分工不能合并：
--   归档时写 archived_at/reason/by；恢复时把这三列清成 NULL（列表的「默认隐藏」
--   读的就是 archived_at），而「它曾经被归档过、什么时候、为什么、谁恢复的」
--   全部留在 asin_archive_event 里。若把恢复也做成「改一个 restored_at 列」，
--   那么「现在是不是归档的」就要再读一列才能回答，而任何一个读错的地方都会让
--   一条归档记录重新出现在默认列表里。
--
-- ★ 这三条 ALTER 是本迁移里**唯一的非幂等语句**（SQLite 的 ADD COLUMN 没有
--   IF NOT EXISTS，重跑会以 duplicate column name 失败）。它们只允许出现在这个
--   只跑一次的迁移里；整段迁移以 user_version 为准，跑过就不再跑（db.js 的 migrate）。
--   全可空、不回填：NULL 是「这条 ASIN 从来没有被归档过」，不是「归档过、现在没归档」——
--   后者由 asin_archive_event 里的一对 archive/restore 行表达。
ALTER TABLE asin ADD COLUMN archived_at TEXT;
ALTER TABLE asin ADD COLUMN archive_reason TEXT;
ALTER TABLE asin ADD COLUMN archived_by TEXT;

-- 「带影响预览的归档」与「恢复」是两次不同的决定，所以 action 是两个字面值而不是一个布尔：
-- 审计要回答的是「谁在什么时候把它藏起来/放回来」，一个 flag 回答不了方向。
CREATE TABLE IF NOT EXISTS asin_archive_event (
  id           TEXT PRIMARY KEY,
  asin         TEXT NOT NULL,
  marketplace  TEXT NOT NULL,
  action       TEXT NOT NULL,
  reason       TEXT,
  /* 归档前的影响预览（活跃草案 / 进行中观测 / 所属竞品组）在这里留一份：归档之后
     那些对象可能已经不在了，事后想复盘「当时影响面有多大」就只剩这一份记录。 */
  impact_json  TEXT,
  at           TEXT NOT NULL,
  by           TEXT
);
CREATE INDEX IF NOT EXISTS idx_asin_archive_event ON asin_archive_event(asin, marketplace, at);
`,
  },
  {
    version: 38,
    name: 'prompt-lifecycle',
    sql: `
-- ── 模块 11 F11-05：提示词生命周期（版本级）的事件表 ────────────────────────────
--
-- ## 为什么是一张**只追加**的事件表，而不是 prompt 上的一列 status
--
-- 生命周期的状态是**按版本**的，不是按行的：一条提示词的 v3 可以已经 active，而
-- 它的 v4（刚编辑出来）还是 draft。prompt 表只有一行，prompt.version 是**编辑计数**
-- （B-11.2b），所以「这一行的 status」这句话根本表达不了 v3 与 v4 各有各的状态。
-- 事件表按 (prompt_id, version) 记，正是为了让两个版本各自成立。
--
-- ## 为什么只追加、永不 UPDATE
--
-- 与 snapshot_registry / artifact-decision 同一条纪律：**新数据追加一条，不覆盖
-- 旧的**。一个 (prompt_id, version) 的**当前**状态 = 它最新的一条事件；「它是怎么
-- 走到今天的」= 它全部的事件。用一列 status 覆盖着写，就只剩最后一句判词，
-- 「这一版什么时候被谁退回评审」这个问题的答案会被下一次写入抹掉。
--
-- ## 事件表里没有「当前状态」列，是有意的
--
-- 加一列 current 会造出第二个真相来源：事件表说一套、current 列说另一套，两者不
-- 一致时没有任何东西能判定谁对。当前状态由「最新一条事件」**推导**，唯一。
--
-- ## ★ 为什么回填，以及回填的是什么（这一段是本迁移最需要解释的部分）
--
-- 本批之前**没有门**：一条 enabled = 1 的提示词就是生产在用的提示词。本批引入
-- 「status 必须是 active」这道门之后，如果什么都不做，库里每一条既有提示词都会
-- 落到 draft（「谁都没说过它是什么」的默认），**生产会静默地一条都用不上** ——
-- 而它们昨天还在用。
--
-- 两条路：① 让「没有事件」默认等于 active；② 给既有的每一条**显式**补一条事件。
-- 选 ②。① 等于把「沉默」当成「许可」，那么将来任何一个忘了记事件的新写入方
-- （本批之后新增的保存路径、导入路径……）都会**静默地**把一条提示词放进生产，
-- 而没有任何一行数据说明为什么。② 让「为什么它是 active」这件事在库里查得到。
--
-- 回填记录的是一个**既成事实**，不是一次激活：这些版本在 v38 之前就在生产里，
-- 那时没有状态机也没有门。所以 status = active（它们当时确实在被使用），
-- by = NULL（没有人按过「激活」，不能编一个操作者），note 逐字说明它是什么。
-- 回填**不**写 review / testing 事件：那些步骤从来没有发生过，补上就是伪造历史。
--
-- 只回填「一条事件都没有」的提示词（NOT EXISTS）；迁移本身也只跑一次
-- （db.js 以 user_version 为准）。
CREATE TABLE IF NOT EXISTS prompt_lifecycle_event (
  id        TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL,
  /* 编辑计数 —— 与 snapshot_registry 里 prompt 快照的 version 同一套编号，所以
     「这一版的状态」与「这一版的正文」指向同一个版本号。 */
  version   INTEGER NOT NULL,
  status    TEXT NOT NULL,
  at        TEXT NOT NULL,
  by        TEXT,
  note      TEXT
);
/* 读法只有两种：「这一版最新的一条」与「这一条提示词的全部事件」。索引按
   (prompt_id, version, at, id) 建，两种读法都能先按 prompt_id 收窄；最终排序的
   最后一个键是 rowid（插入顺序），不是 id —— at 会撞（同一毫秒内的两条），
   用随机 UUID 当兜底键会让「最新一条」变成掷硬币。 */
CREATE INDEX IF NOT EXISTS idx_prompt_lifecycle_event
  ON prompt_lifecycle_event(prompt_id, version, at, id);

INSERT INTO prompt_lifecycle_event (id, prompt_id, version, status, at, by, note)
SELECT 'lifecycle-v38-' || p.id,
       p.id,
       p.version,
       'active',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       NULL,
       'v38 引入生命周期门之前的既成事实：这一版当时就在生产里（那时 enabled = 1 就是生产）。这不是一次激活，也没有经过 review / testing —— 本批之前没有这两个步骤。'
  FROM prompt p
 WHERE NOT EXISTS (SELECT 1 FROM prompt_lifecycle_event e WHERE e.prompt_id = p.id);
`,
  },
  {
    /* F11-07 固定评估集（模块 11）。本批开工时 main 的最大版本是 38，所以这一条是 39。
       并入时若 main 已经推高，按 main 当前最大值**重编号**即可，内容不用动 ——
       这两张表与别的模块谁都不碰（与 v36/v37 的注记同一个约定）。

       ⚠️ **本迁移只建表，不插数据。** 评估集是**业务内容**（和提示词一样），
       不该由 schema 迁移种下去 —— 种下去就与文档里的清单变成两份、两个来源，
       而本仓刚为「两个常量活在不同文件」付过代价（B-06.1）。
       内容由 `amzn_prompt_eval_import` 写入。 */
    version: 39,
    name: 'prompt-eval-set',
    sql: `
-- ── 模块 11 F11-07：固定评估集 ────────────────────────────────────────────────
--
-- 权威要求（RESEARCH §3.11 F11-07）：八类覆盖样例（正常 ASIN / 数据缺失 / 多源冲突 /
-- 高风险表述 / 非英语站点 / 超长字段 / 竞品品牌词 / 无足够证据）+ 口径陷阱样例
-- （百倍混算 / 列错位 / * 行 / 月季粒度），每条的期望行为是「指出问题或拒绝下结论」。
--
-- 关键设计：**样例是内容，评估结果是事实，两者分开存。**
--   本批交付的是「评估集本身 + 能读它」。**本批不跑评估**（本插件没有 LLM 通道），
--   所以这里**没有结果表** —— 「期望行为」是声明的，不是跑出来的。
--   把期望与结果混在一张表里，会让「还没跑过」读成「跑过了」，那正是本仓最忌讳的
--   「把缺失渲染成真实值」。将来真有评估器了，结果表是**另一次迁移**。

-- 评估集：一个具名集合，带版本。版本是内容的一部分（原型 11-prompts.html:154 说的是
-- 「固定评估集 · v2.3 vs v2.4」），所以版本进主键 —— 同一 collection 的两次修订
-- 是两条不同的行，不是覆盖。
CREATE TABLE IF NOT EXISTS prompt_eval_set (
  id          TEXT NOT NULL,
  version     TEXT NOT NULL,
  title       TEXT NOT NULL,
  /* 这个集合测哪一类。**故意不设 CHECK 闭集**：将来加一类不该要一次迁移；
     而「这个 category 还没被登记」正是要在视图里点名的事，不是要拦住的事。 */
  category    TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

-- 集合里的一条样例。
CREATE TABLE IF NOT EXISTS prompt_eval_case (
  id          TEXT NOT NULL,
  set_id      TEXT NOT NULL,
  set_version TEXT NOT NULL,
  /* 集合内的展示顺序。**不叫 seq** —— 那个词在本仓已经被 agent_step 的
     「第几步」占用，这里要的是「列表里的第几条」，用词分开省得读的人猜。 */
  case_index  INTEGER NOT NULL,
  category    TEXT NOT NULL,
  /* 输入快照：原样存 JSON 文本。**不许从选择器或当前数据派生** ——
     任务书 §7 的教训：夹具从被测对象派生，就永远不可能与被测对象不一致，
     于是选择器与真页漂移时全绿也看不见（B-04 的 variations 假阴性）。
     评估集的输入是**人写死的**，所以它与被评估的代码不存在派生关系。 */
  input_json  TEXT NOT NULL,
  /* 期望行为：一句话说明「看到这个输入应当指出什么问题 / 拒绝下什么结论」。
     非空是硬要求（见工具里的拒绝路径）—— 一条没有期望行为的样例不是评估样例，
     只是一个输入。 */
  expected    TEXT NOT NULL,
  /* 期望**至少命中**的规则名（JSON 数组）。空数组 = 这条样例不检查规则命中，
     是「不检查」，不是「检查了没命中」—— 两者在视图里分开说。 */
  expect_rules_json TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (set_id, set_version, case_index),
  /* 样例必须挂在一条**真的存在**的集合版本上，理由同 asin_variant_dimension 的复合外键：
     否则「这个样例属于哪个集合」在两处可以给出两个答案。 */
  FOREIGN KEY (set_id, set_version) REFERENCES prompt_eval_set(id, version)
);
-- 「列出某个集合版本的样例，按集合内顺序」是唯一的主查询。
CREATE INDEX IF NOT EXISTS idx_prompt_eval_case_set
  ON prompt_eval_case(set_id, set_version, case_index);
-- 「哪些集合还没有样例」要按 set 反查，也建一条。
CREATE INDEX IF NOT EXISTS idx_prompt_eval_case_category
  ON prompt_eval_case(set_id, set_version, category);
`,
  },
  {
    version: 40,
    name: 'optimize-inbox-and-evidence',
    sql: `
-- ── B-13b / F13-01：草案收件箱的五态，靠内容重算，不靠写入方自报 ──────────────
--
-- accepted 是三态（1 / 0 / NULL），而收件箱要分五组。加一个自报的 status 列是
-- 最容易想到的错解 —— 那正是本仓刚修过的反例：写入方写一个词、读者按别的规则另算
-- 一遍，两者之间没有任何一致性检查，于是「页面说待审批、工具说已作废」可以同时成立
-- 且都不报错。
--
-- 所以五态**全部由内容重算**（src/domain/optimize/inbox.js#draftInboxGroup）：
--   voided_at 非空 → 已作废；deferred_at 非空 → 稍后；accepted=1 → 待审批；
--   accepted=0 → 驳回待修订；其余 → 待人工选择。
-- 这两列只承载「人做过的、accepted 表达不了的两件事」，各自的空值语义都是
-- 「没做过」而不是「做过但时间未知」。
--
-- 不加 voided_by / deferred_by：署名归 audit_log（recordAudit 已经记 actorKind 与
-- reason）。再加一列没人读的署名，就是给「谁做的」造第二份口径。
ALTER TABLE optimization_draft ADD COLUMN voided_at TEXT;
ALTER TABLE optimization_draft ADD COLUMN deferred_at TEXT;

-- ── B-13b / F13-03：证据包的只读冻结表（十类，一类一行）──────────────────────
--
-- 在它之前，证据只有四类、且散在别处：当前文案 / 关键词包与位置计划计数 /
-- 规则快照 / Prompt 快照分别躺在 optimization_run.package_json 与 rules_json 里，
-- 而「listing 历史 / 评论主题样本 / QA / 竞品机会 / 产品线事实与品牌语气 /
-- 质量缺失项」这六类根本没有落点。更要紧的是：那四类没有「来源 / 时间 / 适用字段」
-- 三要素，也没有任何东西能在收尾之后拒绝改写 —— 报告说「当时是这样的」，
-- 而「当时」既没有日期也没有出处。
--
-- status 三值，**「没有数据」与「数据是 0」在列上就分开**：
--   frozen       这一类有证据，payload_json 是冻结副本
--   absent       这一类建模了，但这一轮没有行（表在、这次没有）
--   not_modelled 本仓没有这一类的来源（例：评论主题、QA —— 全库没有表也没有读取口）
-- count 在 not_modelled 时是 NULL 而不是 0：COUNT(*) 给 0 是「查过、没有」，
-- 而这里要表达的是「没查过，因为没得查」。
--
-- UNIQUE (run_id, kind) 就是「只读冻结表」的实现：一类一行；重冻同内容幂等，
-- 重冻**不同**内容被拒（src/domain/optimize/evidence.js#freezeEvidence），
-- 不留半冻状态。
--
-- source_at 为 NULL 表示**无日期**，绝不回填今天 —— 与 v26 回填纪律同一条
-- （见 snapshot-registry 那段：不能解析为 unknown 就不发明时间戳）。
CREATE TABLE IF NOT EXISTS optimization_evidence (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES optimization_run(id),
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  source       TEXT,
  source_at    TEXT,
  fields_json  TEXT NOT NULL DEFAULT '[]',
  count        INTEGER,
  payload_json TEXT,
  note         TEXT,
  frozen_at    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (run_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON optimization_evidence(run_id, kind);
  `,
  },
  {
  /* 模块 12 剩余四功能点（F12-02 / F12-03 / F12-06 / F12-09）的**共用基础设施**。
       四批共享同一层表与列，分四次迁移会在合并时和 DSH 抢四个版本号，所以**一次建齐**，
       但**逻辑随各批提交** —— 本批（F12-02）只用 `agent_role_config` 与 `agent_run` 的两列，
       其余的表与列先建好、**本批不写也不读**（F12-03/06/09 各自接上读者）。

       ⚠️ 本迁移**不插任何角色配置数据**。角色的默认配置由 `store/agent-config.js` 的
       `seedRoleConfigs` 播种（插件启动时跑，幂等），不放进迁移 —— 迁移只在升级那次跑一遍，
       而配置要能在**每一次启动**保证存在；这与通知清理 / 观测到期扫描放在 apply() 里
       是同一条判断（见 index.js）。

       ⚠️ 新列一律**可空、无默认值**：既有 `agent_run` / `agent_step` 行在加列前就存在，
       带 `NOT NULL` 且无默认值的 ADD COLUMN 对它们会直接失败。 */

    version: 41,
    name: 'agent-config-and-requests',
    sql: `
-- ── 表 1：角色配置版本（F12-02）──────────────────────────────────────────────
--
-- ## 为什么是**按版本追加**的表，而不是角色行上的一列 config
--
-- 角色的声明会演进，而一次运行必须能说出它跑在**哪一版**角色定义上（§15-1 的
-- 「每次运行可复现…版本」在角色这一层的展开）。一列 config 覆盖着写，就只剩最后一句
-- 判词：一个上个月开的运行回读同一行会拿到新的声明，于是「它当时跑在哪一版」这个问题
-- 的答案被下一次写入抹掉 —— 与 snapshot_registry / prompt_lifecycle_event 同一条纪律。
--
-- ## 追加式：发布新版只 INSERT，**永不 UPDATE 旧行**
--
-- UNIQUE (role, version) 让「同一角色同一版本只有一行」由结构保证；「当前版本」由
-- MAX(version) **推导**（唯一），不另设一列 current —— 那会造出第二个真相来源。
-- 回滚不是覆盖，是**再追加一个新版本**（内容等于旧版），所以历史始终完整。
CREATE TABLE IF NOT EXISTS agent_role_config (
  id          TEXT PRIMARY KEY,        -- UUID；或可读的 <role>@v<n>（本批用 UUID）
  role        TEXT NOT NULL,           -- 角色 key（AGENT_ROLES 里的 id；不做外键，见 roles.js 文件头）
  version     INTEGER NOT NULL,        -- 从 1 递增
  config_json TEXT NOT NULL,           -- 该版本的**完整**角色声明
  note        TEXT,                    -- 为什么发布这一版（人不写就为 null）
  created_at  TEXT NOT NULL,
  UNIQUE (role, version)
);
-- 唯一的主查询是「这个角色当前（最新）的一版」，所以索引按 (role, version DESC)。
CREATE INDEX IF NOT EXISTS idx_agent_role_config_latest
  ON agent_role_config(role, version DESC);

-- ── 表 2：补充数据请求（F12-03 用，**本批只建表**）──────────────────────────
--
-- 需求 §4 明说「需要新数据时发起补充数据请求」。这张表就是那件事的载体。
-- ⚠️ 本批（F12-02）**不写也不读**它 —— 逻辑由 F12-03 提交。建在这里是为了四批共用
-- 同一次迁移，不是本批的功能。
--
-- status 故意**不设 CHECK 闭集**：将来加一种处置不该要一次迁移；而「这个 status 还没被
-- 登记」是要在视图里点名的事，不是要拦住的事（与 prompt_eval_set.category 同一条判断）。
CREATE TABLE IF NOT EXISTS agent_data_request (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_run(id),
  what        TEXT NOT NULL,           -- 要什么
  why         TEXT,                    -- 为什么需要
  status      TEXT NOT NULL,           -- open / fulfilled / declined（放开字符串，不设 CHECK）
  opened_at   TEXT NOT NULL,
  resolved_at TEXT,                    -- 未结清时为 null（不是空串）
  resolution  TEXT                     -- 怎么结清的（谁补的 / 为什么拒绝）
);
CREATE INDEX IF NOT EXISTS idx_agent_data_request_run
  ON agent_data_request(run_id, opened_at);

-- ── agent_run 加 6 列 ──────────────────────────────────────────────────────
-- 前两列（F12-02，本批使用）：运行开始时冻结的角色配置版本与完整声明，形状与既有的
-- rules_snapshot_json / prompts_snapshot_json **同一个**（拷贝，不是引用）—— 升级角色配置
-- 不改变已有运行。
ALTER TABLE agent_run ADD COLUMN role_config_version INTEGER;
ALTER TABLE agent_run ADD COLUMN role_config_json TEXT;
-- 后两列（F12-03，**本批只建**）：人工约束与输出格式。⚠️ 输出格式是**约定**，不是校验 ——
-- 插件没有产物格式校验器（契约 §6）。逻辑由 F12-03 提交。
ALTER TABLE agent_run ADD COLUMN human_constraint TEXT;
ALTER TABLE agent_run ADD COLUMN output_format TEXT;
-- 第 5 列（F12-09）：一次新运行指向它所取代的旧运行（上下文变了就**新建**
-- 运行、不改旧的 —— domain/agent/run.js 的终止态没有出边，重开旧运行会推翻状态机）。
ALTER TABLE agent_run ADD COLUMN supersedes_run_id TEXT;
-- 第 6 列（F12-06）：blocked 的**原因**。⚠️ 它是**封闭词表**（domain/agent/run.js 的
-- BLOCKED_KINDS），不是自由文本：§9 要求**按原因**给出口动作，而从 blocked_reason 的
-- 自由文本里猜原因，就是给缺失造一个像数据的替身。可空 —— blocked_reason 与它**同时**
-- 必填，但那条规则在 setRunStatus 里（不是在 schema 上），因为「必填」是业务判据而不是
-- 表结构。⚠️ 本列与 role_config_json / human_constraint 不同：它**不是**上下文包的一部分
-- （不在 startRun 写，而是运行走不动时才写），所以 snapshot.js 的「七个不可变项」不含它。
ALTER TABLE agent_run ADD COLUMN blocked_kind TEXT;

-- ── agent_step 加 3 列（F12-06 / F12-09）──────────────────────────────────────
-- 每步的 Agent / 工具两栏（§9 的任务画布逐字要这两栏），以及「这一步是否可重试」
-- （§12「工具失败：记录参数摘要、错误类型、是否可重试」）。
-- ⚠️ retryable 是**三态**：NULL = 没记（调用方没给、且这一步没有失败），
-- 0 = 明确不可重试，1 = 可重试。**NULL 与 0 不是一件事** —— 折成一个会让
-- 「这一步没失败过，所以没这个问题」与「这一步失败过且不可重试」长得一样。
-- 缺省推导的规则在 recordStep（按该运行**冻结的**角色配置的 onFailure 推）。
ALTER TABLE agent_step ADD COLUMN agent_role TEXT;
ALTER TABLE agent_step ADD COLUMN tool_name TEXT;
ALTER TABLE agent_step ADD COLUMN retryable INTEGER;
`,
  },
  {
    version: 42,
    name: 'optimize-strategy-and-plan-check',
    sql: `
-- ── B-13c / F13-05：策略阶段。九项策略卡 + 「人工确认后进入生成」的门禁 ──────────
--
-- 在它之前，「策略」只有一份静态的写作策略提示词（prompt 库里的三层 assemble），
-- 它讲的是**怎么写**，不回答这一轮的九件事（目标用户 / 核心差异化 / 购买疑问 /
-- 事实边界 / 关键词优先级与所有权 / 字段分工 / 保留内容 / 风险待确认 / 修改幅度）。
-- 更要紧的是：prepare 把策略连同数据包直接交给 Agent，**没有任何确认步骤** ——
-- 「先策略后文案」在流程上无处落地。
--
-- ⚠️ 表里**没有 status 列**。confirmed / unconfirmed 由 confirmed_at 是否为空重算
-- （domain/optimize/strategy.js#strategyGate），edited 由 items_json !== built_json
-- 重算。写入方自报状态、读者按别的规则另算、两者之间没有一致性检查 —— 这正是本仓
-- 刚修过的反例（见 v40 那一段与 domain/optimize/inbox.js 的文件头）。
--
-- built_json 与 items_json 分开，是因为人工确认**不是橡皮图章**：确认时可以改文字。
-- 但「这一轮一开始给的是什么」必须还读得出来（报告与审计问的是后一个问题），
-- 所以构建的那一份永不改写，两者相等即未改 —— 这个判断从内容算得出来。
--
-- confirmed_at 为 NULL 表示**没确认**，不是「确认时间未知」。
CREATE TABLE IF NOT EXISTS optimization_strategy (
  run_id       TEXT PRIMARY KEY REFERENCES optimization_run(id),
  built_json   TEXT NOT NULL,
  items_json   TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_by TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ── B-13c / F13-06：位置计划核对。继承模块 08，不产生第二份口径 ────────────────
--
-- 位置计划的**唯一持久层**是模块 08 的 keyword_plan / keyword_plan_entry
-- （schema v35，src/store/keyword-plan.js）。13 只引用与冻结。这张表存的是
-- **一轮的核对记录**：继承自哪一版、本轮建议什么、人怎么裁决、写回成哪一版。
--
-- ⚠️ 本批没有任何一处直接 INSERT INTO keyword_plan —— 写回唯一走 savePlan，
-- 与 amzn_keyword_plan_save 工具、页面「存一版」路由是同一个函数。这是
-- 「不产生第二份口径」的机制，不是一句承诺。
--
-- 没有 status 列：absent（无行）/ none（有行、plan_id IS NULL）/ inherited（有
-- plan_id）由行本身重算；pending / accepted / declined 由两个时刻戳重算；
-- 「已写回」由 written_plan_id 重算。
--
-- plan_id 为 NULL 表示**这个 ASIN 当时一份计划都没有**，与「计划里有 0 个位置」
-- 是两句不同的话 —— 后者是 plan_id 非空而 entries_json 为 '[]'。
--
-- accepted_at / declined_at 为 NULL 表示**没做过**那件事，不是「时间未知」。
CREATE TABLE IF NOT EXISTS optimization_plan_check (
  run_id          TEXT PRIMARY KEY REFERENCES optimization_run(id),
  plan_id         TEXT,
  lineage_id      TEXT,
  version         INTEGER,
  entries_json    TEXT NOT NULL DEFAULT '[]',
  uncovered_json  TEXT NOT NULL DEFAULT '[]',
  unmapped_json   TEXT NOT NULL DEFAULT '[]',
  accepted_at     TEXT,
  declined_at     TEXT,
  decided_by      TEXT,
  written_plan_id TEXT,
  written_version INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_check_written
  ON optimization_plan_check(written_plan_id);
  `,
  },
  {
    /* ⚠️ 版本号是 **43** —— 它在合并时**让过一次号**（本批作者原先写的是 42）。
       §3.34 记着一次真实的硬冲突：两个会话各自新增了 `version: 40`，而执行器的跳过
       条件是 `step.version <= current` —— 并列两条 40 时**只有数组里靠前的那一条会跑**，
       另一条永远不执行，它建的表在运行时不存在，而 `git merge` 是成功的。
       本批开工时探针报的是 `{"count":41,"SCHEMA_VERSION":41}`，所以当时 42 是下一个空号 ——
       **但「开工时跑一次探针」不够**：B-13c 在**本批干活期间**也拿了 42
       （`optimize-strategy-and-plan-check`），合并时两条并列，真库已经落在 42 上
       （那是 B-13c 的迁移，已应用 ⇒ 永远不能改号），所以让号的是本条：42 → 43。
       ⇒ **§3.34 的教训要再进一步**：避开冲突不能靠猜对方用什么号，
         而「开工那一刻探一次」也不够 —— **对方会在你干活期间继续落迁移**。
         唯一的判据是【**合并后立刻再跑一次探针**】，那才是真相。
       加迁移前先跑 `node scripts/check-migrations.mjs`，**每次合并后再跑一次**。 */
    version: 43,
    name: 'asin-saved-view',
    sql: `
-- ── ASIN 保存视图（模块 05 F05-01）──────────────────────────────────────────
--
-- ## 为什么是表，而不是塞进工作台上下文
--
-- 一次「保存视图」要活过重启、活过换人看：它是一句**被存下来的意图**
-- （「按这个筛选、看这几列」）。工作台上下文在内存里，刷新即重建
-- （见 src/state/workbench.js 的文件头），所以存在那里等于「保存」这个词是假的 ——
-- 关掉页面就没了，而且没有任何东西会报错。用户会以为存过，下次打开发现没有，
-- 然后不再用它。
--
-- ## 存的是**筛选 + 列配置**，不是查询结果
--
-- 只存输入：filters_json 是那一组筛选（marketplace / productLineId / brand / q / order
-- 的键值），columns_json 是可见列的 id 数组。存结果的话，这一行会随着库里的数据
-- 变旧，而一个「保存视图」看起来像一张报表、读起来像一张报表、却不是当下的库 ——
-- 这正是本仓最忌讳的那类假数据。加载视图 = 把这两样还给 filters，查询照常发生。
--
-- ## workspace_id 上**要**有它，且带默认
--
-- 与 asin_ownership（v23）的判断相反，理由是两者回答的问题不同：归属说的是
-- 「这个市场里的这个 ASIN 是谁的」，与谁在看无关；而一个保存视图是**某个空间里
-- 某个人**看库的方式，两个空间对同一批 ASIN 关心不同的切面是正常的。
-- 默认 'ws-default' 而不是可空：阶段 1 是单空间（v20 的默认），可空会让「没写空间」
-- 与「默认空间」在查询里长得一样，而 WHERE workspace_id = ? 永远匹配不到 NULL。
--
-- ## 主键是 (workspace_id, name)，不是自增 id
--
-- 「保存视图」的语义是**按名字覆盖**：同一个人再存一次同名视图，期望是更新它，
-- 不是多出一条同名的。用自增 id 做键就需要一条 UNIQUE(workspace_id, name) 去补，
-- 而两条约束说同一件事就是两个真相。主键直接是 (workspace_id, name)：
-- 重名 = 更新（ON CONFLICT DO UPDATE），改名 = 删旧建新，两条都由结构保证。
CREATE TABLE IF NOT EXISTS asin_saved_view (
  workspace_id  TEXT NOT NULL DEFAULT 'ws-default',
  name          TEXT NOT NULL,          -- 视图名（同一个空间内唯一）
  filters_json  TEXT NOT NULL,          -- 那一组筛选的键值（JSON 对象）
  columns_json  TEXT NOT NULL,          -- 可见列 id 的数组（JSON array）
  note          TEXT,                   -- 这个视图在看什么（人写；不写为 null）
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, name)
);
-- 唯一的列表查询是「这个空间里的全部视图，最近改的在前」。
CREATE INDEX IF NOT EXISTS idx_asin_saved_view_recent
  ON asin_saved_view(workspace_id, updated_at DESC);
`,
  },
  {
    /* ⚠️ 版本号是 **44**。开工前 `node scripts/check-migrations.mjs` 报
       `{"count":43,"SCHEMA_VERSION":43}`，所以 44 是当时的空号 —— 但这个结论只有
       「合并后立刻再跑一次探针」才算数（v40 与 v42 两次撞号的教训都在 §3.34；
       对方会在你干活期间继续落迁移）。本批只有这一条迁移，全幂等、不加列。 */
    version: 44,
    name: 'optimization-review',
    sql: `
-- ── Agent 审阅结论（模块 13 F13-08）─────────────────────────────────────────
--
-- ## 为什么必须落库
--
-- 审计说得直白：Agent 审阅那半「只有一张静态清单，结论不落库、不逐字段」。
-- 一张印在报告里的清单不是审阅，是**待办**：它答不出「这一项谁看过、什么时候、
-- 拿了什么当依据、结论是什么」。而没有那四个问题的答案，下一轮就会有人
-- 重新判一遍，或者更糟 —— 直接假设上一轮判过了。
--
-- ## 为什么主键含 field
--
-- 「不逐字段」是审计点名的另一半。一句话概括整份草稿（field = ''）与
-- 「标题这一项没通过」（field = 'title'）是两条不同的结论：前者是总评，
-- 后者才是能让人去改的那一条。压成一行，后者就永远答不出来。
-- field = '' 本身也是一个位置（整份草稿），不是「没填」。
--
-- ## 为什么没有 state 列
--
-- pending / pass / fail / unclear 全部**由行重算**（review.js 的
-- reviewItemState）：一个写入方自报、读者另算的状态列，正是本仓刚修过的那个反例
-- （optimization_draft 的五态、optimization_strategy 的 confirmed、plan_check 的
-- 决策都按同一条理由处理）。行在不在、结论是什么，本身就是状态。
--
-- ## 为什么 evidence_json 是 { kind, ref } 的数组而不是一段文字
--
-- 「结论引用证据」是审计说的那个缺的**载体**。一段自由文字无法被证伪：
-- 谁也不能检查它引用的规则是否存在、引用的字段这一轮到底有没有。
-- { kind, ref } 可以 —— recordReview 会逐条把 rule / draft / evidence 解一遍，
-- 解不开就拒（REVIEW_EVIDENCE_UNRESOLVED）。这是「有依据」与「声称有依据」的区别。
CREATE TABLE IF NOT EXISTS optimization_review (
  run_id        TEXT NOT NULL REFERENCES optimization_run(id),
  item_id       TEXT NOT NULL,               -- REVIEW_ITEMS 的 id（14 项之一）
  field         TEXT NOT NULL DEFAULT '',    -- '' = 整份草稿；否则是逐字段的那一条
  conclusion    TEXT NOT NULL,               -- pass | fail | unclear（三值，不是布尔）
  note          TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',  -- [{ kind, ref }]
  reviewed_at   TEXT NOT NULL,
  reviewed_by   TEXT,                        -- 'agent' | 'page' | …
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (run_id, item_id, field)
);
-- 唯一的列表查询是「这一轮的全部审阅结论，按项与字段排」。
CREATE INDEX IF NOT EXISTS idx_review_run ON optimization_review(run_id, item_id);
`,
  },
  {
    /* ⚠️ 这条迁移**改过两次号**：原登记 v43 → 顺延 **v44**（main 的 B-05 `asin-saved-view`
       占了 v43）→ 再顺延 **v45**（main 的 B-13d `optimization-review` 在 2026-10-12 又占了
       v44）。**每次动的都是我这一侧**：main 那两条都已并入、可能在别人的库上跑过
       （改它 = 让跑过它的库重跑一遍 DDL）。若两条并列同一个号，执行器的
       `if (step.version <= current) continue` 会让**靠前那条跑、我这条永不执行** ——
       库照常打开、`task_type` 列永远不存在、工具全部静默地报「未声明」。
       判据：跨归属公共资源只能靠「开工时量一次 + **合并前再量一次**」——
       第二次就是这次（`git merge-tree` 只读预演查出预演树里有两条 `version: 44`）。 */
    version: 45,
    name: 'agent-run-task-type',
    sql: `
-- ── F12-04 缺半：§5 的六类任务类型（单步问答 / 分析 / 生成 / 校验 / 流程 / 维护）──
--
-- 在此之前 agent_run 一个类型列都没有，六类任务类型在代码里没有任何落点
-- （另一半「状态机」是完整的：AGENT_RUN_STATUSES + RUN_EDGES）。
-- 词表在 src/domain/agent/roles.js#AGENT_TASK_TYPES，中文标签同一处。
--
-- ⚠️ 可空、**无默认值**。老运行就是「未声明」—— 给它一个默认类型等于给缺失
-- 造一个像数据的替身（本仓铁律里最贵的那条）。迁移**不播种**：结构与内容分开。
-- 由此「六类 + 未声明」是**七个状态**，页面与工具都必须把 NULL 画成「未声明」，
-- 不得折算成任何一类。
ALTER TABLE agent_run ADD COLUMN task_type TEXT;
`,
  },
  {
    /* B-05e / F05-08 收口。**本迁移不加列、不加表** —— 归档需要的三列与事件表是 v37
       （`asin-datacenter`）建的，再加一遍只会得到两份真相。它只补一个索引，理由是
       「隐藏」这条规则在本批第一次变得**可查**：v46 之前 `archived_at` 只有
       `archivedAsinCount` 一个读点（全表扫一次也就完了），现在它同时是默认列表的
       过滤条件 —— `queryAsins` 的 `archived='hide'` 与 `'only'` 两个方向都要走这一列，
       而页面在采集进行中每 3 秒轮询一次 `/api/state`。

       回滚：`DROP INDEX IF EXISTS idx_asin_archived;` —— 只删索引、不动数据。
       `archived_at` 那三列与 `asin_archive_event` 都是 v37 的，回滚本批**不该**碰它们
       （删了就等于顺手回滚了 B-05a 已交付的功能）。 */
    version: 46,
    name: 'asin-archive-index',
    sql: `
CREATE INDEX IF NOT EXISTS idx_asin_archived ON asin(archived_at);
`,
  },
  {
    /* ⚠️ 版本号是 **47**。开工前 `node scripts/check-migrations.mjs` 报
       `{"count":46,"SCHEMA_VERSION":46,"dups":[]}`，所以 47 是当时的空号；
       合并后要**再跑一次**（v40/v42/v43-v45 三次撞号的历史都证明「开工量一次」不够）。

       ── F14-02 §28.2：报告摘要的四个显式字段，其中两个需要落点 ─────────────────

       审计 `RESEARCH-module-alignment-v2.0.md` 的 F14-02 那一行写着：「摘要缺 §28.2
       要求的 数据截止 / Prompt 版本 / Agent 流程 / 草案状态 四个显式字段
       （optimization_run 无 prompt_version/agent_run_id 列）」。四件里两件**不是缺
       数据**，是缺**落点**：

         · **Prompt 版本**：`resolvePrompts` 从 v38 起就把「渲染的是哪一版」返回出来，
           prepare 也已经把每层的 `{layer,label,version,text}` 冻进 `package_json.prompts`。
           所以「这一轮用了哪一版提示词」这个事实**今天就在库里** —— 但它在包的 JSON
           里，只有会解析包的人答得出，而报告是给人看的。列是**索引**，包是**内容**，
           与 `rules_version`（索引）配 `rules_json`（内容）同一个配法。
         · **Agent 流程**：模块 12 的 `agent_run`（v3 起）就是「这一轮是哪次 Agent 运行
           在做」的落点，有 role / task_type / status / steps。缺的只是从轮次指向它的
           **一条外键式引用**。
         · 数据截止与草案状态**不加列**：前者由这一轮冻结的**证据包**（
           `optimization_evidence.source_at`，v40）算，后者由
           `optimization_draft.accepted` 三态 + `draft_version`（v31）重算。给它们各加
           一个列就是给同一件事造第二份口径 —— 而写入方自报、读者另算的形态，正是
           本仓刚删掉的那四处假话的病根。

       ⚠️ **两列都可空、无默认值**。NULL 的含义是「**这一轮没有记录**」，不是
       「本系统没有这一样东西」：
         · `prompt_version IS NULL`：这一轮建轮次时没有可用的 optimize 组装提示词，
           或这是 v47 之前建的轮次（老行不回溯、不编造）。
         · `agent_run_id IS NULL`：这一轮不是由某次 agent_run 发起的（可以直接调工具），
           或这就是 v47 之前建的行。
       两种情况都**不许**在报告里说成「不支持」—— 那是本仓最贵的一条铁律。

       回滚（见契约 API-F14-02 §5，两列都没有索引、也没有被别的迁移引用）：
         ALTER TABLE optimization_run DROP COLUMN agent_run_id;
         ALTER TABLE optimization_run DROP COLUMN prompt_version;
       回滚会丢数据（记录本身没了），所以它只在「确认没有任何一轮用过这两列」时执行。 */
    version: 47,
    name: 'optimize-report-provenance',
    sql: `
ALTER TABLE optimization_run ADD COLUMN prompt_version TEXT;
ALTER TABLE optimization_run ADD COLUMN agent_run_id TEXT;
`,
  },
  {
    /* ⚠️ 版本号是 **48**。开工前 `node scripts/check-migrations.mjs` 报的是
       `{"count":47,"SCHEMA_VERSION":47,"dups":[],"continuous":true,"last":"optimize-report-provenance"}`，
       所以 48 是当时的空号；合并后要**再跑一次**（v40/v42/v43-v45 三次撞号的历史都证明
       「开工量一次」不够）。

       ── F14-01：报告库（模块 14 · 报告中心）──────────────────────────────────

       审计 `RESEARCH-module-alignment-v2.0.md:436` 给 F14-01 点了四件事。这一版只做
       前三件里**必须动表**的那部分，第四件（正文进全文搜索）靠的是 `body` 这一列。

       ## 为什么要有 `body`：不是第二份正文，是**唯一的一份**

       v18 的 `report` 是**索引，不是副本**（见 `:1253-1274` 那段注释）：优化报告的正文在
       `optimization_run.report_html`，总库报告/CSV 的正文是 `path` 指的文件。这条不变式
       对那三类成立，因为它们的正文**在别处已经有唯一的一份**。

       审计点名的另外八类没有这个前提：数据质量、采集、ASIN 健康、竞品差距、规则政策影响、
       Prompt·Agent 评估、发布后效果、运营汇总 —— 它们的内容今天**散在各模块的表里，
       从来没有被渲染成一份文档，也没有任何文件承载它**。所以这些报告的正文**只可能**
       落在这里；`body` 不是副本，它是这一份文档的**唯一载体**，生成时刻冻结。

       ⚠️ 写清楚了才不会有人日后「顺手」把优化报告的 HTML 也抄进 `body` —— 那才会造出
       第二份正文，而两份正文会分歧，页面显示的那份会更旧。

       ## 为什么状态**不加列**

       「状态」有三个正交的来源：正文还在不在（`openable`，由 `path`/`ref_id`/`body` 重算）、
       归档没归档（`archived_at`）、以及将来可能有的别的维度。把它们压成一个 `state`
       字符串，就是给同一件事造第二份口径，而写入方自报、读者另算的形态，正是本仓刚
       删掉的那四处假话的病根。所以只落 `archived_at` 这一个**事实**，`ready` /
       `unopenable` / `archived` 三态由 `reportStatus()` **重算**。

       ## 为什么归档不隐藏（与 F05-08 同一条裁决）

       用户 2026-10-13 对 ASIN 归档的裁决是「保留现状（默认显示）+ 三态筛选
       `all`/`hide`/`only`」，理由写在 `domain/asin/table.js:292-295`：不带标记的一行
       看起来与正常记录完全一样，而「归档没生效」正是那个样子。报告沿用同一条口径：
       `archived_at IS NULL` 为默认，`status=archived` 才只看归档的。

       ⚠️ 五列都可空或有常量默认，**老行不回溯、不编造**：
         · `body IS NULL` 对前三种 kind 是**正常且正确**的（正文在别处），不是「没有正文」；
         · `created_by IS NULL` 是「**没有记录**是谁生成的」（v48 之前的写入方不传），
           **不是**「本系统不支持创建者」；
         · `favorite` 默认 0 是「没收藏」这个事实，不是 NULL；
         · `tags_json IS NULL` 是「没打过标签」，与 `'[]'`（打过又清空）分开存，同
           `product_line.signals_json` 的 NULL/[] 之分（v17 那条注释）。

       回滚（见契约 API-F14-01 §2.3）：
         DROP INDEX IF EXISTS idx_report_favorite;
         DROP INDEX IF EXISTS idx_report_archived;
         ALTER TABLE report DROP COLUMN tags_json;
         ALTER TABLE report DROP COLUMN favorite;
         ALTER TABLE report DROP COLUMN created_by;
         ALTER TABLE report DROP COLUMN archive_reason;
         ALTER TABLE report DROP COLUMN archived_by;
         ALTER TABLE report DROP COLUMN archived_at;
         ALTER TABLE report DROP COLUMN body;
       ⚠️ **先 DROP INDEX 再 DROP COLUMN** —— `idx_report_favorite` 引用 `favorite`、
       `idx_report_archived` 引用 `archived_at`，顺序反了 SQLite 会拒（本仓踩过）。
       回滚会丢数据：八类生成报告的正文一并消失，所以只在「确认没有任何一份生成报告
       还需要留」时执行。 */
    version: 48,
    name: 'report-library-facets',
    sql: `
ALTER TABLE report ADD COLUMN body TEXT;
ALTER TABLE report ADD COLUMN archived_at TEXT;
ALTER TABLE report ADD COLUMN archived_by TEXT;
ALTER TABLE report ADD COLUMN archive_reason TEXT;
ALTER TABLE report ADD COLUMN created_by TEXT;
ALTER TABLE report ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report ADD COLUMN tags_json TEXT;

CREATE INDEX IF NOT EXISTS idx_report_favorite ON report(favorite, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_archived ON report(archived_at);
`,
  },
  {
    /* P1-3 的产物：把真实 SQL（从 store 追踪来的，不是手抄）在 4000 行 + ANALYZE 上跑
       EXPLAIN QUERY PLAN，发现 `listNotifications` 的 `ORDER BY created_at DESC`
       用不上索引 —— 现有 `idx_notif_read(read_at, created_at)` 的前缀是 read_at，
       「全部通知」这个查询不带 read_at 条件，前缀不成立，于是退化成
       全表扫描 + 临时 B 树排序。

       只加索引、不动数据；回滚 = DROP INDEX idx_notif_created。

       没有一并改 `dq_issue`：它的排序键是 `ORDER BY CASE severity WHEN … END`，
       是**表达式**，任何普通索引都用不上。要修得改查询或上表达式索引，
       属于改行为，不在「补索引」这一批里 —— 那件事记在
       docs/architecture/query-plan-baseline.md。 */
    version: 49,
    name: 'notification-created-at-index',
    sql: `
CREATE INDEX IF NOT EXISTS idx_notif_created ON notification(created_at DESC);
`,
  },
  {
    /* F14-10 —— 报告导出：Excel 与 Markdown / HTML 并存，由**同一份模型**在同一时刻
       渲染出来。
       为什么要存而不是导出时现算：`buildReportModel` 的输入里有一半是**那一刻**才算得
       出来的东西（草案行、校验计数、位置计划、证据包）。收尾之后再算一遍就是「拿今天的
       规则和今天的 listing 重新解释三个月前的一轮」，那正是 F14-02 的 `dataCutoffOf`
       在防的事。所以三份渲染一起落库，导出端点只**发字节**，不重新渲染。

       为什么是 BLOB 而不是落盘文件：`report_md` / `report_html` 已经是这一行的两列，
       第三列放在一起，「同一刻的三份字节」才是一行的事；落盘会多出一个可能消失的路径
       （`report` 表里 `kw-report`/`kw-export` 那种「取不回」的空态就是这么来的）。

       为什么可空：v50 之前收尾的轮次没有这一列。空 = **这一轮没有 Excel 导出件**，
       不是「Excel 是空的」—— 导出端点会这么说，页面也会（见 API-F14-10 §4）。

       ⚠️ 号段（2026-10-19 重基时改）：本迁移原写成 **v49**，与远端先落地的
       v49 `notification-created-at-index` 撞号（本仓第三次付这个代价：v40、v42）。
       重基到 `e805742` 后改号为 **v50**，v49 那段**一个字没动** —— 它在真库里已经
       跑过了，改它就是改历史。

       回滚（见契约 API-F14-10 §5）：
         ALTER TABLE optimization_run DROP COLUMN report_xlsx;
       ⚠️ 回滚会丢数据：已收尾轮次的 Excel 导出件一并消失（Markdown / HTML 不受影响）。
       重跑一次 `amzn_optimize_save` 会重新生成 —— 但那是在**今天**的输入上重新渲染，
       不是找回原来那份字节。只在「确认没有任何一份 Excel 还需要留」时执行。 */
    version: 50,
    name: 'optimize-report-xlsx',
    sql: `
ALTER TABLE optimization_run ADD COLUMN report_xlsx BLOB;
`,
  },
  {
    /* 关键词的**角色** —— 这个词在说"本产品是什么"，还是在说别的东西。
       为什么现在才加：2026-05 Alexa for Shopping 之后，亚马逊的排序从"关键词密度"
       变成"证据一致性"；把 `patio furniture set`（167 万搜索量）这类泛词写进标题，
       等于主动稀释主身份。加之前实测：够格进标题的 219 个词里，43%（95 个）
       **既不含 bench 也不含 cushion**。

       两列：`role` 是四态值（identity / partial / offline / unknown），
       `role_basis_json` 记判定依据（命中了哪些身份词、缺了哪些、产品线是谁），
       让人三个月后还能回答"当时凭什么这么判"。

       回滚：ALTER TABLE kw_master DROP COLUMN role; 再 DROP COLUMN role_basis_json; */
    version: 51,
    name: 'kw-master-role',
    sql: `
ALTER TABLE kw_master ADD COLUMN role TEXT;
ALTER TABLE kw_master ADD COLUMN role_basis_json TEXT;
CREATE INDEX IF NOT EXISTS idx_kw_master_role ON kw_master(marketplace, role);
`,
  },
  {
    /* 两组决策字段 —— 逐月累积之后，词库要从"快照"变成"能直接喂 listing"。

       ① `trend_json`：ABA 事实表已有 7 个周期（其中 2,596 个词 ≥2 期、1,696 个 ≥3 期），
          但主表只留最新一期 —— 趋势算得出来，却从来没算过。这里存环比、均值与涨跌结论。
       ② `placement_json`：`for_listing_json` 只回答"能不能写"，不回答"写哪、第几档"。
          这里存落位处方（标题 / 五点 / 后台 + 顺位档 + 形态），草稿可以直接照着写。

       两者都是**派生值**：事实表变了就重算，不需要人工维护。
       回滚：ALTER TABLE kw_master DROP COLUMN trend_json; 再 DROP COLUMN placement_json; */
    version: 52,
    name: 'kw-master-trend-placement',
    sql: `
ALTER TABLE kw_master ADD COLUMN trend_json TEXT;
ALTER TABLE kw_master ADD COLUMN placement_json TEXT;
`,
  },
  {
    /* 落位槽位提成**真实列**并加索引。
       为什么：`json_extract(placement_json,'$.slot')` 只能全表扫 —— 实测 37ms，
       在 10 万行时就是 120ms 起，而且用不上索引。这一列是枚举值（title/bullets/
       backend/null），提出来的代价很小，换来的是"筛标题候选"能走索引。

       回滚：DROP INDEX idx_kw_master_placement; ALTER TABLE kw_master DROP COLUMN placement_slot; */
    version: 53,
    name: 'kw-master-placement-slot',
    sql: `
ALTER TABLE kw_master ADD COLUMN placement_slot TEXT;
CREATE INDEX IF NOT EXISTS idx_kw_master_placement ON kw_master(marketplace, placement_slot);
`,
  },
  {
    /* 排名观测历史 —— 只追加，不覆盖。

       为什么必须新开一张表：`asin_keyword` 的主键是 (asin, marketplace, keyword,
       source_id)，写入是 ON CONFLICT DO UPDATE。也就是说**一周后重扫，上周的名次
       就被覆盖掉了** —— 那张表只能回答「现在第几」，回答不了「变了多少」。
       要做周度监控，历史必须落在另一张只追加的表里。

       两个字段不能省：
       · `scan_depth` —— 不记扫描深度，「没找到」到底是第 200 名还是第 48 名之外，
         就说不清。
       · `found` —— 「扫了、没进榜」与「压根没扫」是两件事，都写 rank = NULL 会把它们
         混成一个。

       `ad_rank / ad_page` 先留空：当前扫描只读自然位，广告位还没采。
       空是「没采」，不是「没有广告排名」—— 查询侧必须照这个说法回报。

       UNIQUE 用 observed_on（天）而不是精确时刻：同一天重扫是幂等更新，
       一天之内扫两次不会产生两条曲线点。

       回滚：DROP TABLE kw_rank_observation; */
    version: 54,
    name: 'kw-rank-observation',
    sql: `
CREATE TABLE kw_rank_observation (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword      TEXT NOT NULL,
  marketplace  TEXT NOT NULL,
  asin         TEXT NOT NULL,
  observed_on  TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  organic_rank INTEGER,
  organic_page INTEGER,
  ad_rank      INTEGER,
  ad_page      INTEGER,
  scan_depth   INTEGER NOT NULL,
  found        INTEGER NOT NULL,
  source       TEXT,
  task_id      TEXT,
  UNIQUE (keyword, marketplace, asin, observed_on)
);
CREATE INDEX IF NOT EXISTS idx_kw_rank_obs_series ON kw_rank_observation (asin, marketplace, keyword, observed_on DESC);
CREATE INDEX IF NOT EXISTS idx_kw_rank_obs_day ON kw_rank_observation (observed_on DESC);
`,
  },
  {
    /* 扫描排班 —— 让「每周日 12:00」「每天 09:00」这类周期真的会自己跑。

       为什么排班要存在库里而不是配置文件：一张表能同时回答「下次什么时候跑」
       （`next_run_at`，由计时器算好写回）和「上次什么时候跑的」（`last_run_at`）——
       配置项做不到后者，而运营第一个问题就是「上次跑成功了吗」。

       `at_time` 用 'HH:MM' 存本地时间，**不存时区**：插件跑在谁的机器上就是谁的本地时间，
       存一个时区字段只会让「每周日 12 点」变成一句需要解释的话。

       `keywords_json` 为空表示「用监控清单」（`keyword` 表的词），不是「没有词」；
       `asins_json` 为空表示「这个站点所有在跟踪的 ASIN」。两种空都必须能区分于 []。

       回滚：DROP TABLE kw_scan_schedule; */
    version: 55,
    name: 'kw-scan-schedule',
    sql: `
CREATE TABLE kw_scan_schedule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  cadence       TEXT NOT NULL,
  at_time       TEXT NOT NULL,
  weekdays_json TEXT,
  keywords_json TEXT,
  asins_json    TEXT,
  pages         INTEGER NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   TEXT,
  last_task_id  TEXT,
  next_run_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kw_scan_schedule_due ON kw_scan_schedule (enabled, next_run_at);
`,
  },
  {
    /* 排名**分析表** —— 明细按天、汇总按词+ASIN，两层分开。

       为什么要有它：`kw_rank_observation` 是明细（一天一行，只追加），
       回答「上周第几、这周第几」要在一堆行上跑窗口函数。词一多、周数一长，
       每次看板都扫一遍全表。
       这张表把「这个词这个 ASIN 现在怎么样」压成**一行**：
       最近名次、上一次名次、变化、最好名次、连续未进榜次数、均值、结论。
       看板与列表读它，一次主键查询；明细表只留给曲线和复盘。

       代价是写的时候多一次小更新（只重算受影响的那一个 (词, ASIN)），
       与读的收益相比可以忽略 —— 每天/每周只写几十行。

       主键 (asin, marketplace, keyword)：与明细的 (…, observed_on) 相比少了日期维度。

       回滚：DROP TABLE kw_rank_analysis; */
    version: 56,
    name: 'kw-rank-analysis',
    sql: `
CREATE TABLE kw_rank_analysis (
  asin          TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  keyword       TEXT NOT NULL,
  latest_on     TEXT,
  latest_rank   INTEGER,
  latest_found  INTEGER NOT NULL DEFAULT 0,
  prev_on       TEXT,
  prev_rank     INTEGER,
  delta         INTEGER,
  verdict       TEXT NOT NULL,
  best_rank     INTEGER,
  best_on       TEXT,
  observed_days INTEGER NOT NULL DEFAULT 0,
  ranked_days   INTEGER NOT NULL DEFAULT 0,
  missing_streak INTEGER NOT NULL DEFAULT 0,
  avg_rank_4    INTEGER,
  scan_depth    INTEGER,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (asin, marketplace, keyword)
);
CREATE INDEX IF NOT EXISTS idx_kw_rank_analysis_board ON kw_rank_analysis (marketplace, verdict, latest_rank);
`,
  },
  {
    /* ASIN 竞品关系 —— 一行一个竞品，**不用逗号串**。

       为什么不把竞品塞进一个字段（现有 competitor_set.asins_json 就是那样）：
       · 反向查不了（"谁是 B0XXX 的竞品"只能 LIKE 全表扫）
       · 带不了属性（排名、来源、状态、最后见到的时间）
       · 更新要读出-拼接-写回，两个并发写入互相覆盖
       要在页面上显示成一行逗号串，在查询里用 GROUP_CONCAT 生成（**不建数据库视图**：
       迁移里建视图会破坏 tests/kw-key.mjs 的 v14 回滚解析器，全量套件会崩在迁移 37 上）；
       存储用关系表，展示用查询，两边都不将就。

       `scope` 的两个值：
       · family —— 挂在整个产品上（父子共享），默认
       · child  —— 某个子 ASIN 的特殊竞品（例如某颜色卖点不同），scope_asin 指定是哪个
       查询时 child 覆盖 family，不强迫所有人接受"一个父只能有一组竞品"。

       竞品**存单向**（我方视角）：我把他当竞品，不代表他把我当竞品。
       反查走 idx_asin_comp_reverse。

       回滚：DROP VIEW v_asin_family_competitor; DROP TABLE asin_competitor; */
    version: 57,
    name: 'asin-competitor',
    sql: `
CREATE TABLE asin_competitor (
  marketplace     TEXT NOT NULL,
  parent_asin     TEXT NOT NULL,
  competitor_asin TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'family',
  scope_asin      TEXT NOT NULL DEFAULT '',
  source          TEXT,
  rank_seen       INTEGER,
  status          TEXT NOT NULL DEFAULT 'active',
  last_seen_at    TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (marketplace, parent_asin, competitor_asin, scope, scope_asin)
);
CREATE INDEX IF NOT EXISTS idx_asin_comp_lookup ON asin_competitor (marketplace, parent_asin, status);
CREATE INDEX IF NOT EXISTS idx_asin_comp_reverse ON asin_competitor (marketplace, competitor_asin, status);
`,
  },
  {
    /* 广告事实下沉到**天** —— 只有行内带日期的文件才进得来。

       背景：SP/SB 的搜索词导出逐行带「日期」，我们一直把它压成 first_date/last_date；
       「数据聚合-ASIN-搜索词」那张表**根本没有日期列**，只有文件名里的 202603。
       这两类必须分开：
         · 行内有日期 → kw_ad_daily（可以算周环比、逐日诊断）
         · 只有文件名 → 继续留在 kw_ad_fact 的 period 上，并标 period source

       **文件名日期不可信**：`深谷-us-sp-搜索词-20260314-20160412-…` 里的 2016 是手滑
       （应为 2026）。按文件名解析会静静算出一批 2016 年的数据，所以这里只存原样字符串。

       回滚：DROP TABLE kw_ad_daily; （kw_import.date_source 留 NULL 即可） */
    version: 58,
    name: 'kw-ad-daily',
    sql: `
ALTER TABLE kw_import ADD COLUMN date_source TEXT;
CREATE TABLE kw_ad_daily (
  keyword     TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  ad_date     TEXT NOT NULL,
  ad_type     TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  orders      INTEGER NOT NULL DEFAULT 0,
  spend       REAL NOT NULL DEFAULT 0,
  sales       REAL NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (keyword, marketplace, ad_date, ad_type, source_file)
);
CREATE INDEX IF NOT EXISTS idx_kw_ad_daily_series ON kw_ad_daily (keyword, marketplace, ad_date DESC);
CREATE INDEX IF NOT EXISTS idx_kw_ad_daily_day ON kw_ad_daily (ad_date DESC);
`,
  },
  /* ── v59：产品归属配置（店铺 + 品牌 + 父 + ASIN）────────────────────────

     事实层与配置层分开：
       `asin`(asin, marketplace)            市场事实 —— 采集/导入写的
       `product_profile`                    营业归属 —— 这家店、这个品牌、这个父体

     键：UNIQUE(shop_id, brand, parent_asin, asin)，**不是物理主键**。
     品牌在这份表里最可能被改（本次导入 315 行全空，全靠规则推 + 人工纠），
     做成物理主键的话「改品牌」= 删一行插一行；做成唯一约束就是一条 UPDATE，
     而且重复导入命中约束 → 更新，不会插第二条。

     品牌必填、父 ASIN 必填：配不全的行**不入库**，进待补清单。
     这是「配置表」和「事实表」的区别 —— 事实可以残缺，配置不行。

     `shop_brand_rule`：品牌从标题推的规则。深谷的 `ROFIEJOX` 是 prefix 规则；
     `Adirondack` 是品类词不是品牌，故意不建规则让它落进待补。

     回滚：DROP TABLE product_profile; DROP TABLE shop_brand_rule; DROP TABLE product_import; */
  {
    version: 59,
    name: 'product-profile',
    sql: `
CREATE TABLE product_profile (
  id            TEXT PRIMARY KEY,
  shop_id       TEXT NOT NULL REFERENCES shop(id),
  brand         TEXT NOT NULL,
  parent_asin   TEXT NOT NULL,
  asin          TEXT NOT NULL,
  marketplace   TEXT NOT NULL,
  source_id     TEXT,
  source_file   TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (shop_id, brand, parent_asin, asin)
);
CREATE INDEX idx_product_profile_asin ON product_profile (asin, marketplace);
CREATE INDEX idx_product_profile_shop ON product_profile (shop_id);

CREATE TABLE shop_brand_rule (
  id         TEXT PRIMARY KEY,
  shop_id    TEXT NOT NULL REFERENCES shop(id),
  brand      TEXT NOT NULL,
  match_type TEXT NOT NULL,
  pattern    TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 100,
  is_default INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_shop_brand_rule_shop ON shop_brand_rule (shop_id, priority);


CREATE TABLE product_import (
  id             TEXT PRIMARY KEY,
  fingerprint    TEXT NOT NULL UNIQUE,
  path           TEXT NOT NULL,
  marketplace    TEXT,
  rows_total     INTEGER NOT NULL DEFAULT 0,
  rows_written   INTEGER NOT NULL DEFAULT 0,
  rows_pending   INTEGER NOT NULL DEFAULT 0,
  brand_batch    TEXT NOT NULL DEFAULT '',
  brand_unknown  INTEGER NOT NULL DEFAULT 0,
  imported_at    TEXT NOT NULL
);
`,
  },
  /* ── v60：店铺/品牌归档边界（ADR-004 D2）──────────────────────────────────
     只加两列（归档时间 + 操作人）与两条索引，不改任何既有列、不合并表。
     归档是只读软状态：`product_profile.shop_id` 有 FK，物理删店会破坏归属，
     所以店铺/品牌只归档，不删除。两列都为 NULL = 在架。

     回滚：SQLite 3.35+ 支持 DROP COLUMN，但本项目按「回滚 = 恢复上一版代码 +
     保留数据」处理；列留着不影响旧代码（旧代码不读这两列）。 */
  {
    version: 60,
    name: 'shop-brand-archive',
    sql: `
ALTER TABLE shop ADD COLUMN archived_at TEXT;
ALTER TABLE shop ADD COLUMN archived_by TEXT;
ALTER TABLE brand ADD COLUMN archived_at TEXT;
ALTER TABLE brand ADD COLUMN archived_by TEXT;
CREATE INDEX IF NOT EXISTS idx_shop_ws_archived ON shop (workspace_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_brand_ws_archived ON brand (workspace_id, archived_at);
`,
  },
  /* ── v61：kw_master Batch A 查询索引（T25 / T32）────────────────────────────
     只加 8 个复合索引，不改查询语义、不改表结构、不加 FTS/生成列（Batch B 暂缓）。
     设计依据：`team/architecture/amazon-ops-db-optimization-2026-10-22.md` §5
     「批次 A」A1–A5 + A8；实测见 `team/architecture/sql/v60_candidate_ddl.sql`。

     每一条都是 `IF NOT EXISTS`，所以重复执行是空操作；旧索引保留一个版本，
     本迁移不 DROP 任何对象。回滚：DROP 以下 8 个索引即可，数据与旧索引不动。 */
  {
    version: 61,
    name: 'kw-master-batch-a-indexes',
    sql: `
-- A1 默认 volume 排序（marketplace + search_volume DESC + keyword）
CREATE INDEX IF NOT EXISTS idx_kw_master_mkt_vol_keyword
  ON kw_master(marketplace, search_volume DESC, keyword);

-- A2 product_line + volume（替代当前只有 product_line 的索引形状）
CREATE INDEX IF NOT EXISTS idx_kw_master_mkt_line_vol_keyword
  ON kw_master(marketplace, product_line, search_volume DESC, keyword);

-- A3 全市场按 keyword（导出/回查）
CREATE INDEX IF NOT EXISTS idx_kw_master_mkt_keyword
  ON kw_master(marketplace, keyword);

-- A4 updated 排序（旧 idx_kw_master_upd 没有 marketplace 前缀）
CREATE INDEX IF NOT EXISTS idx_kw_master_mkt_updated_keyword
  ON kw_master(marketplace, updated_at DESC, keyword);

-- A5 opportunity 筛选 + volume 排序
CREATE INDEX IF NOT EXISTS idx_kw_master_mkt_opp_vol_keyword
  ON kw_master(marketplace, opportunity, search_volume DESC, keyword);

-- A8 spend / orders / competitors 三种排序
CREATE INDEX IF NOT EXISTS idx_kw_master_mkt_spend_keyword
  ON kw_master(marketplace, spend DESC, keyword);
CREATE INDEX IF NOT EXISTS idx_kw_master_mkt_orders_keyword
  ON kw_master(marketplace, orders DESC, keyword);
CREATE INDEX IF NOT EXISTS idx_kw_master_mkt_competitors_keyword
  ON kw_master(marketplace, competitor_ranked_count DESC, keyword);
`,
  },
  /* ── v62：产品档案补 SKU / 产品名 / 产品线（T52）────────────────────────────
     只做 ADD COLUMN，非破坏：旧库升级后旧列与旧数据原样保留，新列为 NULL。
     产品线存 id（与 `product_line` 表对齐），名字由 product_line.name 读出；
     尚未配置的产品线由导入时 `INSERT OR IGNORE` 建一条（name = 表里的原文）。
     回滚：SQLite 3.35+ 可 DROP COLUMN；本项目按「恢复上一版代码 + 保留数据」处理。 */
  {
    version: 62,
    name: 'product-profile-sku-name-line',
    sql: `
ALTER TABLE product_profile ADD COLUMN sku TEXT;
ALTER TABLE product_profile ADD COLUMN product_name TEXT;
ALTER TABLE product_profile ADD COLUMN product_line_id TEXT;
CREATE INDEX IF NOT EXISTS idx_product_profile_line ON product_profile (product_line_id);
CREATE INDEX IF NOT EXISTS idx_product_profile_sku ON product_profile (sku);
`,
  },
  /* ── v63：reviews / review_bindings（S2-T69，DB v1.1 §4 方案 A + LLD §1.4）──
     家族内一行一评：UNIQUE/PK(dedupe_key, parent_asin, marketplace)；父/子双绑定
     （parent_asin/child_asin 均 NOT NULL，铁律 2/R7）；跨子体补绑定走 review_bindings
     （3NF 方案 A），reviews 主行永不复制（R1/R2/R3）。
     created_at 由 observed_at 兼任（DB §4.5 时间列注）；updated_at 记最近补绑定。
     collect_state：collected/partial/failed/blocked（铁律 3：partial 不是 blocked）。
     回滚：DROP TABLE 两表即可（新表纯新增，不动存量；数据是评论积累，回滚前先备份）。 */
  {
    version: 63,
    name: 'reviews-model-t69',
    sql: `
CREATE TABLE reviews (
  dedupe_key        TEXT NOT NULL,
  review_id         TEXT,
  parent_asin       TEXT NOT NULL,
  child_asin        TEXT NOT NULL,
  marketplace       TEXT NOT NULL,
  author            TEXT,
  review_date       TEXT,
  rating            INTEGER,
  title             TEXT,
  body              TEXT,
  verified          INTEGER,
  variant_note      TEXT,
  source_task_id    TEXT NOT NULL,
  source_snapshot_id TEXT,
  observed_at       TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  n_over_n          TEXT,
  collect_state     TEXT NOT NULL,
  PRIMARY KEY (dedupe_key, parent_asin, marketplace)
);
CREATE TABLE review_bindings (
  review_dedupe_key TEXT NOT NULL,
  parent_asin       TEXT NOT NULL,
  marketplace       TEXT NOT NULL,
  child_asin        TEXT NOT NULL,
  variant_note      TEXT,
  bound_at          TEXT NOT NULL,
  bound_by_task     TEXT,
  PRIMARY KEY (review_dedupe_key, parent_asin, marketplace, child_asin),
  FOREIGN KEY (review_dedupe_key, parent_asin, marketplace)
    REFERENCES reviews(dedupe_key, parent_asin, marketplace)
);
CREATE INDEX IF NOT EXISTS idx_review_family ON reviews (parent_asin, marketplace);
CREATE INDEX IF NOT EXISTS idx_review_child ON reviews (child_asin, marketplace);
CREATE INDEX IF NOT EXISTS idx_review_dedupe ON reviews (dedupe_key, marketplace);
`,
  },
  /* ── v64：review_analysis_runs / review_annotations（S2-T70，LLD §2.4 + O-01 拍板）──
     凭据 team/decisions/O-01-review-analysis-method-2026-10-23.md：C 案词典法 v1，
     阈值 5/2，计数按去重评论条数（COUNT(DISTINCT review_key)），覆盖率必印。
     四类穷举 CHECK（topic/pain/objection/scene）；唯一键 (run_id, review_key, category,
     label) 保证「同一 run 同一评论同一标签只有一行」（重跑不翻倍）。
     DB §4.8 边界：分析结果**另表**，reviews 表不建「主题」列。
     method/method_version/lexicon_hash 版本化：改词表=新版本，旧标注不重算（O-01 §二.2）。
     asin 列 = run 的入口子体（LLD 未写死，按开工单取 NOT NULL，报告记）。
     H9 锚（b05d-honesty 双向断言）要求：两表存在 ⟺ review-topics 的 unsourced 洞已撤。
     回滚：DROP TABLE 两表即可（纯新增，不动存量）。 */
  {
    version: 64,
    name: 'review-analysis-t70',
    sql: `
CREATE TABLE review_analysis_runs (
  id                  TEXT PRIMARY KEY,
  parent_asin         TEXT NOT NULL,
  marketplace         TEXT NOT NULL,
  asin                TEXT NOT NULL,
  method              TEXT NOT NULL,
  method_version      TEXT NOT NULL,
  lexicon_hash        TEXT NOT NULL,
  insufficient_run_n  INTEGER NOT NULL,
  insufficient_label_n INTEGER NOT NULL,
  sample_n            INTEGER NOT NULL,
  matched_n           INTEGER NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_analysis_runs_scope
  ON review_analysis_runs (parent_asin, marketplace, created_at DESC);
CREATE TABLE review_annotations (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  review_key      TEXT NOT NULL,
  parent_asin     TEXT NOT NULL,
  marketplace     TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('topic', 'pain', 'objection', 'scene')),
  label           TEXT NOT NULL,
  matched_terms   TEXT NOT NULL,
  method_version  TEXT NOT NULL,
  UNIQUE (run_id, review_key, category, label),
  FOREIGN KEY (run_id) REFERENCES review_analysis_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_review_annotations_rcl ON review_annotations (run_id, category, label);
CREATE INDEX IF NOT EXISTS idx_review_annotations_key ON review_annotations (review_key);
`,
  },
  /* ── v65：政策按钮四步链路（S2-T72，PRD FR-M8-08 / R-4 / 决策 D-c；LLD §4.4）──
     两张表，两种事实：
       · policy_check_runs —— 每次按钮触发的运行留痕（时刻/状态/源数/差异数/确认人/理由）。
         失败是 status='failed' + error，不是「0 条候选」；0 条结果是 pending_confirm +
         source_count=0，两者分开（四态口径：「搜不到」≠「不存在」）。
       · policy_candidates —— 检索证据，不是政策。status 只有 candidate/confirmed/rejected；
         只有人工确认才会写 policy 行（确认路径复用 amzn_policy_import 的 parse+import，
         挂规则复用 amzn_policy_link 的 linkPolicyToRules，不另造第二条入库路）。
     候选行保存来源标题/URL/snippet/检索时间/query/机器可读差异 diff_json，确认人/时间。
     policy_source 加一行 web-search：检索来的政策 provenance 是「搜索通道」，不是人工粘贴。
     这是 v11「三个来源」之后**有意增加**的第四个：检索来源与人工粘贴必须区分。
     回滚：DROP TABLE policy_candidates → policy_check_runs；再 DELETE policy_source WHERE id='web-search'。
     纯新增，不动存量表。 */
  {
    version: 65,
    name: 'policy-check-t72',
    sql: `
CREATE TABLE policy_check_runs (
  id             TEXT PRIMARY KEY,
  query          TEXT NOT NULL,
  marketplace    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('running', 'pending_confirm', 'confirmed', 'rejected', 'failed')),
  error_code     TEXT,
  error          TEXT,
  source_count   INTEGER NOT NULL DEFAULT 0,
  diff_count     INTEGER NOT NULL DEFAULT 0,
  sources_json   TEXT,
  confirmed_by   TEXT,
  confirm_reason TEXT,
  observed_at    TEXT NOT NULL,
  decided_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_policy_check_runs_observed
  ON policy_check_runs (observed_at DESC);

CREATE TABLE policy_candidates (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES policy_check_runs(id),
  source_url   TEXT,
  source_title TEXT NOT NULL,
  snippet      TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  query        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'rejected')),
  policy_id    TEXT REFERENCES policy(id),
  confirmed_by TEXT,
  confirmed_at TEXT,
  decision_reason TEXT,
  diff_json    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_candidates_run ON policy_candidates (run_id, status);
CREATE INDEX IF NOT EXISTS idx_policy_candidates_status ON policy_candidates (status);

INSERT OR IGNORE INTO policy_source (id, kind, name, url, note) VALUES
  ('web-search', 'search', 'SearXNG 政策检索', NULL,
   'S2-T72 检索通道：候选来自 SearXNG 搜索结果的标题/链接/原文片段，人工确认后才写入政策库；来源 URL 记在 policy.url 与候选行上。');
`,
  },
  /* ── v66：政策检索耗时（S2-T72 P0 修复）──
     lead 实测：SearXNG 冷查询 20362 ms、热查询 10042 ms，而旧超时只有 10s ——
     「一按就超时」。除了把超时调到 45s，还必须把**每次实际耗时**记在 run 行上：
     没有耗时的失败记录，下一次只能猜「是通道挂了还是超时配短了」。
     ALTER 是纯新增列，不动 v65 两表；旧 run 的 duration_ms 为 NULL（未记，不是 0）。 */
  {
    version: 66,
    name: 'policy-check-duration-t72',
    sql: `
ALTER TABLE policy_check_runs ADD COLUMN duration_ms INTEGER;
`,
  },
  /* ── v67：广告事实的「缺失」标记（T-3 设计修复）──
     `kw_ad_fact.spend/sales` 是 `REAL NOT NULL DEFAULT 0` —— **这一列装不下「没有数据」**。
     于是「源表里这一行的花费单元格是空的」和「确实花了 0 元」在库里是同一个值，
     月报的「有 N 行没有花费数据」永远不触发（函数级正确、线上不生效）。

     为什么**不**把 spend 放宽成可空：SQLite 放宽 NOT NULL 要重建表，而本仓的既有取舍是
     「不重建表、不删列」（见 v8 / v60 附近注释）——为一个统计口径重建事实表、
     承担既有数据风险，不划算。**加一列记缺失**是纯 ALTER，风险为零。

     口径（必须和读端一起读）：
       · 1 = 这一行**至少有一个源单元格是空的**；
       · 0 = 没有记到缺失 —— **不等于数据完整**。迁移前写入的老行一律 0，
         所以 0 只能读成「没标记」，不能读成「确定没缺」。 */
  {
    version: 67,
    name: 'ad-fact-missing-flags-t3',
    sql: `
ALTER TABLE kw_ad_fact ADD COLUMN spend_missing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kw_ad_fact ADD COLUMN sales_missing INTEGER NOT NULL DEFAULT 0;
`,
  },
  /* ── v68：导入记录的「行数没记到」标记（台账 13 号）──
     `kw_import.rows_read` 是 `INTEGER NOT NULL DEFAULT 0` —— **这一列装不下「没记到」**。
     于是「这份文件读了几行」在**没人报过**的时候被写成了 0，而 0 读起来是
     「这份文件一行都没有」。领域层（`keywords/pipeline.js` 的 `rowsReadOf`）已经把
     「没取到」表达成 `null` 了，但 `recordImport` 落库前只能把它转成数字 ——
     同一份导入于是有两个答案（返回值 null、库里 0）。

     为什么**不**把 rows_read 放宽成可空：SQLite 放宽 NOT NULL 要重建表，而本仓的既有取舍是
     「不重建表、不删列」（见 v8 / v60 附近注释）——为一行统计口径重建导入记录表、
     承担既有数据风险，不划算。**加一列记缺失**是纯 ALTER，风险为零。
     这与 v67 对 `kw_ad_fact.spend/sales` 是同一个办法（同一套话术，不另学一套）。

     口径（必须和读端一起读）：
       · 1 = 这一份导入**没有报行数**（parser 没给 `stats.rowsRead`）；
       · 0 = 没有记到缺失 —— **不等于行数准确**。迁移前写入的老行一律 0，
         所以 0 只能读成「没标记」，不能读成「确定读了这么多行」。

     ⚠️ 「真的读了 0 行」与「没记到」是两件事，而**前者今天出不来**：六个 parser 面对空输入
     全部抛（空词表 / 只有表头的 ABA / 空 JSON …），走不到 `recordImport`。所以这一对取值的
     价值在**契约**（下一个忘了写 `stats` 的 parser 不再被安静地记成 0 行），不在今天的数据。
     `tests/t73m-rows-read-missing.mjs` 把这两条都标成「契约而非生产路径」。

     回滚：ALTER TABLE kw_import DROP COLUMN rows_read_missing;（SQLite ≥ 3.35 才有 DROP COLUMN；
     更省事的做法是留着这一列 —— 它不影响任何既有查询。） */
  {
    version: 68,
    name: 'kw-import-rows-read-missing-t13',
    sql: `
ALTER TABLE kw_import ADD COLUMN rows_read_missing INTEGER NOT NULL DEFAULT 0;
`,
  },
  /* ── v69：关键词的产品线**归属**决策层（F-5 的 B 半）────────────────────────────
     为什么要单独一张表：`kw_master.product_line` / `product_line_matched` /
     `product_lines_json` 都是 `recomputeMaster` 对 facts 的**派生值**，每次导入
     `ON CONFLICT DO UPDATE SET <每一列> = excluded.<列>` 整层重写 —— 往那三列写人工值
     会在下一次导入**静默消失**（`tests/t77-keyword-bulk.mjs` ⑦ 号断言是这个事实的实证：
     手工改 `product_line`，`recomputeMaster` 一跑就没了，没有报错、没有提示）。
     这与 v33 把生命周期状态独立成 `keyword_lifecycle` 是同一个结构性理由，所以这里照
     同一套形状做：当前值一张表 + 追加事件一张表。

     口径（读端必须一起读，见方案 team/dev/keyword-product-line-plan-2026-10-25.md）：
       · 生效值 = 人工值（本表 `product_line_id` 非空）> 派生值（`kw_master`）；
       · `product_line_id` 为 NULL 且本表有行 = **人工撤销了归属**，回到派生值 ——
         撤销是人的决定，所以不删行（事件表里那次撤销也有 from → NULL 一行）；
       · 本表没有行 = 没人决定过，**不是**「决定为默认线」。
     唯一读口是 `store/keyword-product-line.js` 的 `effectiveProductLine` —— 页面、路由、
     工具三处都只能调它，任何一处自己写 `COALESCE(人工, 派生)` 都算第二份口径
     （t78 ⑩ 是源码级断言）。

     迁移**不回填**：只建表，不把今天的派生值盖章成人工决定。验收判据：迁移前后
     `productLineDefaulted`（= 无人工且无信号命中的条数）都必须等于 3,386 —— 不等就是回填了。

     回滚：DROP TABLE keyword_product_line_event; DROP TABLE keyword_product_line;
     （两张新表纯新增，不动存量任何列；回滚只删表，既有数据不受影响。） */
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
  /* v70（2026-10-26，R-91 需求方指定）—— **字段模板**。
     需求原话：报告字段要全量（43 个以上）、模板可编辑可增删、给一个「更新字段模板」按钮
     触发 AI 搜索与汇总分析、与现有模板对照、人工确认后换新模板，**历史模板保留最近一版以便回滚**，
     并且模板字段就是实际优化时的字段清单。

     两张表，理由：
     - `field_template` 只有身份（一个模板 id 一行），改它不影响任何历史；
     - `field_template_version` **一行一版，永不改**（与 rule_set / product_line_version 同一个做法）：
       这样「这一轮优化用的是哪版模板」将来能被报告引用得住，回滚也是**另起一版**而不是改旧的。

     `status` 三值：`proposed`（AI 研究产出、等人确认）/ `active`（当前生效）/ `superseded`（被新版本取代）。
     **同一时刻最多一个 active** —— 由 store 层保证（写新版时把旧的置 superseded），不靠调用方自觉。

     回滚：`DROP TABLE field_template_version; DROP TABLE field_template;`
     （两张新表纯新增，不动存量任何列。） */
  {
    version: 70,
    name: 'field-template',
    sql: `
CREATE TABLE field_template (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  note        TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE field_template_version (
  template_id   TEXT NOT NULL REFERENCES field_template(id),
  version       INTEGER NOT NULL,
  status        TEXT NOT NULL,
  /* 字段清单：一行的 id / label / kind(copy|attribute) / section / required / 上限。 */
  items_json    TEXT NOT NULL,
  /* 与上一版的差异（增/删/改/顺序），落库而不是现算 —— 报告要引用「当时对照的是什么」。 */
  diff_json     TEXT,
  /* 这一版是怎么来的：谁研究的、搜了什么、汇总成什么。人工手改的版本这里是 NULL。 */
  research_json TEXT,
  note          TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  confirmed_by  TEXT,
  confirmed_at  TEXT,
  PRIMARY KEY (template_id, version)
);

/* 「当前生效的那一版」是最频繁的一次读。 */
CREATE INDEX idx_field_tpl_status ON field_template_version (template_id, status);
`,
  },
]

/** The version the newest migration brings the store to. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
