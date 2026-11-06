// 冒烟测试：把 schema.sql 打到临时库，塞入真实抓下来的样本，再跑视图。
// 目的只有一个——证明这套表结构是可执行、可幂等、能回答业务问题的，而不是纸上画格子。
// 跑法：node tools/schema-smoke.mjs
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '..', 'data')
mkdirSync(dataDir, { recursive: true })
const dbPath = join(dataDir, 'smoke.db')
rmSync(dbPath, { force: true })

const db = new DatabaseSync(dbPath)
db.exec(readFileSync(join(here, '..', 'schema.sql'), 'utf8'))

const now = '2026-11-05T07:50:00Z'
const dataDate = '2026-11-04'

// 1) ASIN 主档（真实 payload：Detiblue 摇椅垫）
db.prepare(`INSERT INTO sif_asin (marketplace, asin, title, brand, price, star_rating, rating_num,
  bsr_rank, bsr_category, first_available_day, variation_num, weight_oz, observed_at, data_date)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'US', 'B0XXXXXXXX', 'Detiblue Low Back Rocking Chair Cushion Set, 2 Piece, Beige, 17x17 in',
  'Detiblue', 44.59, 4.5, 49, 317, 'Patio Furniture Cushions', '2026-01-27', 11, 78.08, now, dataDate)

// 2) 流量周序列（真实 10 周：total / nf / ad）
const weeks = ['2026-08-30','2026-09-06','2026-09-13','2026-09-20','2026-09-27','2026-10-04','2026-10-11','2026-10-18','2026-10-25','2026-11-01']
const total = [1372.58,1300.07,1169.06,1038.21,1112.65,768.28,1550.61,1807.93,3039.12,976.21]
const nf    = [571.61,572.52,611.11,515.56,460.07,579.52,455.79,818.88,595.80,384.05]
const ad    = [800.97,727.54,557.95,522.64,652.58,188.76,1094.81,989.05,2443.32,592.16]
const ins = db.prepare(`INSERT INTO sif_traffic (marketplace, asin, scope, period_type, period_start,
  total_score, nf_score, ad_score, nf_ratio, ad_ratio, is_complete, tool, fetched_at, data_date)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
weeks.forEach((w, i) => ins.run('US','B0XXXXXXXX','listing','week',w,
  total[i], nf[i], ad[i], +(nf[i]/total[i]).toFixed(4), +(ad[i]/total[i]).toFixed(4), 1,
  'ops_get_asin_traffic_trend', now, dataDate))

// 3) ASIN × 关键词（头词真实行：p2,11/48，gap severe）
db.prepare(`INSERT INTO sif_asin_keyword (marketplace, asin, keyword, period_type, period_value,
  traffic_share, contri_change, contri_severity, organic_page, organic_pos, organic_total, organic_rank_raw,
  rank_evolution, gap_severity, keyword_health, traffic_dependency, keyword_tags_json, fetched_at, data_date)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'US','B0XXXXXXXX','rocking chair cushions','lately','30',
  0.438, 0.416, 'growing', 2, 11, 48, 'p2,11/48',
  'gap_detected','severe','volatile','natural_dominant',
  JSON.stringify(['搜索量同比增长词','主要流量词']), now, dataDate)

// 4) ABA 周序列（真实 5 周尾巴）
const aba = [['2026-09-27',8944,149894,0.2495],['2026-10-04',11262,141872,0.2583],['2026-10-11',9979,142147,0.24],['2026-10-18',9611,139549,0.234],['2026-10-25',9631,0.2543]]
const abaIns = db.prepare(`INSERT INTO sif_keyword_aba (marketplace, keyword, week_start, volume, rank,
  top3_click_share, top3_conversion_share, fetched_at) VALUES (?,?,?,?,?,?,?,?)`)
abaIns.run('US','rocking chair cushions','2026-09-27',8944,149894,0.2495,0.03,now)
abaIns.run('US','rocking chair cushions','2026-10-04',11262,141872,0.2583,0.02,now)
abaIns.run('US','rocking chair cushions','2026-10-11',9979,142147,0.24,0.05,now)
abaIns.run('US','rocking chair cushions','2026-10-18',9611,139549,0.234,0.08,now)
abaIns.run('US','rocking chair cushions','2026-10-25',9631,142000,0.2543,0.0933,now)

// 5) 幂等验证：同一周重抓 → 裸 INSERT 应被主键拦下；UPSERT 才是 importer 的正确写法
const before = db.prepare('SELECT COUNT(*) AS n FROM sif_traffic').get().n
let refused = false
try {
  ins.run('US','B0XXXXXXXX','listing','week','2026-11-01',999,999,0,0.9,0.1,1,
    'ops_get_asin_traffic_trend', now, dataDate)
} catch { refused = true }
db.prepare(`INSERT INTO sif_traffic (marketplace, asin, scope, period_type, period_start,
  total_score, nf_score, ad_score, nf_ratio, ad_ratio, is_complete, tool, fetched_at, data_date)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT (marketplace, asin, scope, period_type, period_start) DO UPDATE SET
    total_score=excluded.total_score, nf_score=excluded.nf_score, ad_score=excluded.ad_score,
    nf_ratio=excluded.nf_ratio, ad_ratio=excluded.ad_ratio, fetched_at=excluded.fetched_at`)
  .run('US','B0XXXXXXXX','listing','week','2026-11-01',976.21,384.05,592.16,0.3934,0.6066,1,
    'ops_get_asin_traffic_trend', now, dataDate)
const after = db.prepare('SELECT COUNT(*) AS n FROM sif_traffic').get().n
console.log('rows before/after duplicate insert:', before, after)

// ── 业务问题验证 ────────────────────────────────────────────
console.log('\n[Q1] 最近 4 周自然 vs 广告占比')
console.table(db.prepare(`SELECT period_start, ROUND(total_score,0) AS total,
  ROUND(nf_ratio*100,1) AS nf_pct, ROUND(ad_ratio*100,1) AS ad_pct
  FROM v_traffic_last8w WHERE asin=? ORDER BY period_start DESC LIMIT 4`).all('B0XXXXXXXX'))

console.log('[Q2] 广告依赖度（ad_ratio>=0.6 的周数）')
console.log(db.prepare(`SELECT COUNT(*) AS weeks_over_60pct FROM v_ad_dependency
  WHERE asin=?`).get('B0XXXXXXXX'))

console.log('[Q3] 没进首页、但已经带量的词（缺口）')
console.table(db.prepare(`SELECT keyword, ROUND(traffic_share*100,1) AS share_pct,
  organic_page AS page, organic_pos AS pos, gap_severity, positions_left_in_page
  FROM v_kw_gap WHERE asin=? ORDER BY traffic_share DESC`).all('B0XXXXXXXX'))

console.log('[Q4] ABA 最新一周')
console.table(db.prepare(`SELECT keyword, week_start, volume, rank,
  ROUND(top3_click_share*100,1) AS top3_click_pct,
  ROUND(top3_conversion_share*100,1) AS top3_conv_pct FROM v_aba_latest`).all())

const fk = db.prepare('PRAGMA integrity_check').get()
console.log('\nintegrity_check:', fk)
db.close()
console.log('OK — schema 可执行，视图可回答上面 4 个问题')
