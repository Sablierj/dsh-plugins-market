/**
 * 回归自检（0 点、不联网）：解析器 / 迁移 / 幂等 / 规则 / 报告 五组断言。
 *
 * 目的不是覆盖率，是**把「改坏了但页面看起来没坏」的那几处钉住**：
 * 自然位字符串解析、档位文本解析、迁移重复执行、同周重抓、规则阈值、报告必带口径行。
 *
 * 用法：node tools/selftest.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseBand } from '../src/sync/l2.js'
import { keywordSyncCost } from '../src/sync/keyword.js'
import { parseDataDate, parseRank, stripAsin } from '../src/sync/normalize.js'
import { openStore } from '../src/store/db.js'
import { replaceInsights, upsertTraffic } from '../src/store/queries.js'
import {
  latestMarketSnapshot, listKeywordLibrary, setKeywordStatus, upsertKeyword, upsertMarketSnapshot,
} from '../src/store/keywords.js'
import { computeInsights } from '../src/domain/insights.js'
import { buildActions } from '../src/domain/actions.js'
import { dataHealth } from '../src/domain/health.js'
import { auditListing } from '../src/domain/listing-audit.js'
import { renderPortfolio, summarizeForPortfolio } from '../src/domain/portfolio.js'
import { buildListingDraft, diffAudit, renderDraftReport } from '../src/domain/listing-draft.js'
import { buildDeepReport } from '../src/domain/deep-report.js'
import { checkConsistency } from '../src/domain/consistency.js'
import { buildDashboard } from '../src/domain/dashboard.js'
import { buildReport } from '../src/domain/report.js'
import { upsertObject } from '../src/store/queries.js'

let pass = 0
const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`)
  }
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`)

// ── 1. 解析器 ─────────────────────────────────────────────
eq('stripAsin 剥 markdown 链接', stripAsin('[B0XXXXXXXX](https://www.amazon.com/dp/B0XXXXXXXX)'), 'B0XXXXXXXX')
eq('stripAsin 纯 ASIN 原样', stripAsin('b0gv55q4jg'), 'B0XXXXXXXX')
eq('parseDataDate', parseDataDate('Data updated through 2026-11-04 (refreshes daily, 1-day delay)'), '2026-11-04')
eq('parseDataDate 无日期', parseDataDate('n/a'), null)
eq('parseRank p2,11/48', parseRank('p2,11/48'), { page: 2, pos: 11, total: 48 })
eq('parseRank null', parseRank(null), { page: null, pos: null, total: null })
eq('parseBand <50', parseBand('<50'), 0)
eq('parseBand 5,000+', parseBand('5,000+'), 5000)
eq('parseBand 1.2K+', parseBand('1.2K+'), 1200)
eq('parseBand null', parseBand(null), null)
// 关键词级数据按「调用次数」计费，不是按词数（实测 3 词 = 3 点）
eq('keywordSyncCost 3 词', keywordSyncCost(3), 3)
eq('keywordSyncCost 10 词', keywordSyncCost(10), 3)
eq('keywordSyncCost 20 词', keywordSyncCost(20), 4)
eq('keywordSyncCost 0 词', keywordSyncCost(0), 0)

// ── 2. 迁移 + 幂等 ────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'sif-ops-test-'))
const logger = { info: () => {}, warn: () => {} }
try {
  const store = openStore({ dataDir: dir, logger })
  check('迁移到 v5', store.version === 5, `version=${store.version}`)
  const tables = store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row => row.name)
  for (const required of ['sif_object', 'sif_traffic', 'sif_asin_keyword', 'sif_ad_summary', 'sif_insight', 'sif_report', 'sif_raw', 'sif_quota_log']) {
    check(`表存在 ${required}`, tables.includes(required))
  }
  // 同一周写两次 → 只有 1 行，值被覆盖
  const row = {
    marketplace: 'US', asin: 'B0XXXXXXXX1', periodType: 'week', periodStart: '2026-11-01',
    totalScore: 100, nfScore: 40, adScore: 60, nfRatio: 0.4, adRatio: 0.6, tool: 't', fetchedAt: '2026-11-05T00:00:00Z', dataDate: '2026-11-04',
  }
  upsertTraffic(store, row)
  upsertTraffic(store, { ...row, totalScore: 120, nfScore: 30, adScore: 90, nfRatio: 0.25, adRatio: 0.75 })
  const count = store.get("SELECT COUNT(*) AS n FROM sif_traffic WHERE asin='B0XXXXXXXX1'").n
  eq('同周重抓只留 1 行', count, 1)
  const saved = store.get("SELECT total_score, ad_ratio FROM sif_traffic WHERE asin='B0XXXXXXXX1'")
  eq('同周重抓覆盖为新值', [saved.total_score, saved.ad_ratio], [120, 0.75])

  // 再开一次同一个库：迁移不重复执行、数据还在
  store.close()
  const again = openStore({ dataDir: dir, logger })
  eq('重开库仍是 v5', again.version, 5)
  eq('重开库数据还在', again.get("SELECT COUNT(*) AS n FROM sif_traffic WHERE asin='B0XXXXXXXX1'").n, 1)

  // ── 3. 规则引擎 ────────────────────────────────────────
  again.run("DELETE FROM sif_traffic")
  const weeks = [
    ['2026-11-01', 480, 50, 430],
    ['2026-10-25', 930, 110, 820],
    ['2026-10-18', 960, 115, 845],
    ['2026-10-11', 95, 42, 53],
  ]
  for (const [period, total, nf, ad] of weeks) {
    upsertTraffic(again, {
      marketplace: 'US', asin: 'B0XXXXXXXX1', periodType: 'week', periodStart: period,
      totalScore: total, nfScore: nf, adScore: ad, nfRatio: nf / total, adRatio: ad / total,
      totalChangeRatio: period === '2026-11-01' ? -0.48 : null,
      tool: 't', fetchedAt: '2026-11-05T00:00:00Z', dataDate: '2026-11-04',
    })
  }
  const insights = computeInsights(again, { marketplace: 'US', asin: 'B0XXXXXXXX1' })
  const kinds = insights.map(item => item.kind)
  check('广告依赖被识别', kinds.includes('ad_dependency'), JSON.stringify(kinds))
  check('急跌被识别', kinds.includes('drop_ad_led') || kinds.includes('drop_real'), JSON.stringify(kinds))
  check('每条洞察都带证据', insights.every(item => item.evidence && Object.keys(item.evidence).length > 0))
  const stored = replaceInsights(again, { marketplace: 'US', asin: 'B0XXXXXXXX1', insights })
  eq('洞察落库条数一致', stored.length, insights.length)
  const again2 = replaceInsights(again, { marketplace: 'US', asin: 'B0XXXXXXXX1', insights })
  eq('重算不重复堆积 open 洞察', again2.length, insights.length)

  // ── 4. 看板 + 报告 ─────────────────────────────────────
  upsertObject(again, { marketplace: 'US', asin: 'B0XXXXXXXX1', label: 'mine' })
  const board = buildDashboard(again, { marketplace: 'US' })
  eq('看板对象数', board.objects, 1)
  check('看板带周序列', board.asins[0].weeks.length === 4, `weeks=${board.asins[0].weeks.length}`)
  const report = buildReport(board, { asin: 'B0XXXXXXXX1' })
  check('报告非空', !!report && report.markdown.length > 500, `chars=${report?.markdown?.length}`)
  check('报告带数据截止日', report.markdown.includes('数据截止'))
  check('报告带口径声明', report.markdown.includes('相对量'))
  check('报告列出未采集项', report.markdown.includes('未采集'))
  const missing = buildReport(board, { asin: 'B0XXXXXXXX' })
  eq('未知 ASIN 返回 null', missing, null)

  // ── 5. 词库 ────────────────────────────────────────────
  upsertKeyword(again, { marketplace: 'US', keyword: 'Bench Cushion', status: 'candidate', source: 'mining:bench', root: 'bench', volumeWeek: 11871 })
  const lib = listKeywordLibrary(again, { marketplace: 'US' })
  eq('词库入库 1 个', lib.length, 1)
  eq('关键词归一为小写', lib[0].keyword, 'bench cushion')
  eq('初始状态 candidate', lib[0].status, 'candidate')
  setKeywordStatus(again, { marketplace: 'US', keyword: 'bench cushion', status: 'tracked' })
  eq('可升级为 tracked', listKeywordLibrary(again, { marketplace: 'US' })[0].status, 'tracked')
  setKeywordStatus(again, { marketplace: 'US', keyword: 'bench cushion', status: 'excluded', note: '词品不匹配' })
  upsertKeyword(again, { marketplace: 'US', keyword: 'bench cushion', status: 'candidate', source: 'mining:again' })
  eq('excluded 不会被重新挖掘覆盖', listKeywordLibrary(again, { marketplace: 'US' })[0].status, 'excluded')
  check('状态筛选生效', listKeywordLibrary(again, { marketplace: 'US', status: 'tracked' }).length === 0)

  upsertMarketSnapshot(again, {
    marketplace: 'US', keyword: 'bench cushion', observedAt: '2026-11-05T00:00:00Z',
    visibleAsinCount: 397, concentrationLevel: 'low', competitionMode: 'mixed',
    top3ClickShare: 0.265, top3ConversionShare: 0.137, divergence: 'diverging',
  })
  const snap = latestMarketSnapshot(again, { marketplace: 'US', keyword: 'Bench Cushion' })
  eq('格局快照能按词读回（大小写不敏感）', snap && snap.concentration_level, 'low')
  eq('格局快照 Top3 转化', snap.top3_conversion_share, 0.137)

  // ── 7. Listing 深度诊断 ────────────────────────────────
  const poor = auditListing({
    asin: 'B0XXXXXXXX1',
    listing: {
      title: 'BEST SELLER Bench Cushion Free Shipping ' + 'x'.repeat(200),
      bullets: ['short one'],
      itemHighlights: '',
      description: '',
      searchTerms: '',
      attributes: [],
      price: 99,
      rating: 3.9,
      reviews: 12,
      variationNum: 6,
    },
    keywords: [{ keyword: 'bench cushion', traffic_share: 0.6 }],
    competitorPrices: [10, 12, 15],
  })
  check('诊断返回 12 个维度', poor.sections.length === 12, `n=${poor.sections.length}`)
  check('标题超长被抓', poor.issues.some(item => item.issue.includes('超过常见上限')))
  check('促销词被抓', poor.issues.some(item => item.issue.includes('促销')))
  check('全大写被抓', poor.issues.some(item => item.issue.includes('全大写')))
  check('价格高于竞品被抓', poor.issues.some(item => item.issue.includes('高于全部竞品')))
  check('缺五点被抓', poor.issues.some(item => item.issue.includes('五点')))
  check('无数据来源项被标 nodata', poor.sections.filter(section => section.status === 'nodata').length >= 2,
    JSON.stringify(poor.sections.filter(section => section.status === 'nodata').map(section => section.id)))
  check('分数被扣到 60 以下', poor.score < 60, `score=${poor.score}`)
  check('覆盖矩阵标出未覆盖词', poor.coverage[0].covered === true, JSON.stringify(poor.coverage[0]))

  const good = auditListing({
    asin: 'B0XXXXXXXX1',
    listing: {
      title: 'Bench Cushion, 70D Foam, 17x17 in, Beige Chenille Cover',
      bullets: ['Bench cushion fits 17x17 in seat', '70D foam keeps shape', 'Chenille cover is soft', 'Ties keep it in place', 'Spot clean only'],
      itemHighlights: '70D foam, 17x17 in, chenille, 4 in thick',
      description: 'Bench cushion for indoor benches.',
      searchTerms: 'bench pad',
      attributes: [{ code: 'Color', value: 'Beige' }, { code: 'Size', value: '17x17' }, { code: 'Material', value: 'Chenille' }],
      price: 12,
      rating: 4.6,
      reviews: 120,
      variationNum: 3,
    },
    keywords: [{ keyword: 'bench cushion', traffic_share: 0.5 }],
    competitorPrices: [10, 12, 15],
  })
  check('正常 listing 分数更高', good.score > poor.score, `${good.score} vs ${poor.score}`)
  check('正常 listing 没有高风险', good.counts.high === 0, `high=${good.counts.high}`)

  // ── 8. 改稿草稿 + 复测 ─────────────────────────────────
  const draftInput = {
    title: 'Bench Cushion',
    bullets: ['Seat pad for bench, 17x17 in, 4 in thick foam'],
    itemHighlights: '',
    description: '',
    searchTerms: '',
    attributes: [{ code: 'Color', value: 'Beige' }],
    price: 12, rating: 4.6, reviews: 120, variationNum: 3,
  }
  const draftKeywords = [
    { keyword: 'bench cushion', traffic_share: 0.6 },
    { keyword: 'custom bench cushion', traffic_share: 0.2 },
    { keyword: 'indoor bench cushions', traffic_share: 0.1 },
  ]
  const beforeAudit = auditListing({ asin: 'B0XXXXXXXX1', listing: draftInput, keywords: draftKeywords, competitorPrices: [10, 12, 15] })
  const { draft, notes } = buildListingDraft({ asin: 'B0XXXXXXXX1', listing: draftInput, keywords: draftKeywords, brand: 'ROFIEJOX' })
  const afterAudit = auditListing({ asin: 'B0XXXXXXXX1', listing: draft, keywords: draftKeywords, competitorPrices: [10, 12, 15] })
  const diff = diffAudit(beforeAudit, afterAudit)

  check('草稿标题 ≤200 字符', draft.title.length <= 200, `len=${draft.title.length}`)
  check('草稿标题含主力词', draft.title.toLowerCase().includes('bench cushion'))
  check('草稿标题无促销词', !/free shipping|best seller|sale/i.test(draft.title), draft.title)
  check('草稿亮点 ≤125 字符', draft.itemHighlights.length <= 125, `len=${draft.itemHighlights.length}`)
  check('草稿亮点带数字', /\d/.test(draft.itemHighlights), draft.itemHighlights)
  check('草稿五点 5 条且每条 ≤500', draft.bullets.length === 5 && draft.bullets.every(text => text.length <= 500),
    JSON.stringify(draft.bullets.map(text => text.length)))
  check('草稿属性补到 6 项', draft.attributes.length === 6, JSON.stringify(draft.attributes.map(item => item.code)))
  check('后台词 ≤250 字节', new TextEncoder().encode(draft.searchTerms).length <= 250)
  check('草稿五点覆盖主力词', draft.bullets.join(' ').toLowerCase().includes('bench cushion'))
  check('复测分数上升', diff.delta > 0, `${diff.scoreBefore} → ${diff.scoreAfter}`)
  check('复测后高风险减少或清零', afterAudit.counts.high <= beforeAudit.counts.high,
    `${beforeAudit.counts.high} → ${afterAudit.counts.high}`)
  check('草稿说明里有生成口径提示', notes.some(note => note.includes('字符')))
  const draftMd = renderDraftReport({ asin: 'B0XXXXXXXX1', draft, notes, diff, before: beforeAudit, after: afterAudit })
  check('草稿报告含复测分', draftMd.includes('复测'))
  check('草稿报告含后台搜索词', draftMd.includes('后台搜索词'))

  // ── 9. 深度总报告（md + 自包含 HTML）────────────────────
  const deep = buildDeepReport({
    asin: 'B0XXXXXXXX1',
    board: { asins: [{ asin: 'B0XXXXXXXX1', dataDate: '2026-11-04', title: 'Bench Cushion', price: 12, star: 4.6, reviews: 120, weeks: [
      { period_start: '2026-10-25', total_score: 900, nf_score: 300, ad_score: 600, nf_ratio: 0.33, ad_ratio: 0.67, total_change_ratio: -0.1 },
      { period_start: '2026-11-01', total_score: 600, nf_score: 150, ad_score: 450, nf_ratio: 0.25, ad_ratio: 0.75, total_change_ratio: -0.33 },
    ] }] },
    audit: afterAudit,
    draft: { draft, notes, diff, before: beforeAudit, after: afterAudit },
    actions: [{ verb: '补位', title: 'bench cushion 占 60% 但没进前 3 页', detail: '证据', action: '补词' }],
    health: { coverage: { traffic: 1, keywords: 1, sales: 1, ads: 1 }, gaps: [] },
    competition: { snapshot: { keyword: 'bench cushion', visible_asin_count: 397, concentration_level: 'low', top3_click_share: 0.26, top3_conversion_share: 0.13, divergence_insight: '点击集中、转化分散' } },
  })
  check('总报告 md 有 8 个一级章节', (deep.markdown.match(/^## /gm) ?? []).length === 8,
    String((deep.markdown.match(/^## /gm) ?? []).length))
  check('HTML 自包含：无 http(s) 外链', !/<(script|link)[^>]*https?:/i.test(deep.html), '有外链')
  check('HTML 含内联 SVG 图', deep.html.includes('<svg') && deep.html.includes('<polyline'))
  check('HTML 含 12 维诊断卡片', (deep.html.match(/class="card"/g) ?? []).length >= 12,
    String((deep.html.match(/class="card"/g) ?? []).length))
  check('HTML 标出无数据来源', deep.html.includes('无数据来源'))
  check('HTML 有打印样式', deep.html.includes('@media print'))
  check('md 含数据缺口章节', deep.markdown.includes('## 七、数据健康与无来源项'))

  // ── 10. 素材补录（主图 / A+ / 差评主题）──────────────────
  const noAssets = auditListing({ asin: 'B0XXXXXXXX1', listing: draftInput, keywords: draftKeywords, competitorPrices: [10, 12, 15] })
  check('无素材时图片/A+ 标 nodata',
    noAssets.sections.filter(section => ['images', 'aplus'].includes(section.id)).every(section => section.status === 'nodata'))
  const withAssets = auditListing({
    asin: 'B0XXXXXXXX1', listing: draftInput, keywords: draftKeywords, competitorPrices: [10, 12, 15],
    assets: { imagesTotal: 5, hasWhiteBg: false, minPxOk: true, hasVideo: false, aplus: false, reviewThemes: '尺寸偏小,坐垫塌陷', source: 'manual' },
  })
  const imgSection = withAssets.sections.find(section => section.id === 'images')
  const aplusSection = withAssets.sections.find(section => section.id === 'aplus')
  const reviewSection = withAssets.sections.find(section => section.id === 'reviews')
  check('补录后图片不再是 nodata', imgSection.status !== 'nodata', imgSection.status)
  check('图片不足 7 张被抓', imgSection.findings.some(finding => finding.issue.includes('张图')), JSON.stringify(imgSection.findings.map(f => f.issue)))
  check('主图非白底被抓', imgSection.findings.some(finding => finding.issue.includes('白底')))
  check('补录后 A+ 不再是 nodata 且判为不合格', aplusSection.status === 'fail', aplusSection.status)
  check('差评主题进入评论维度', reviewSection.findings.some(finding => finding.issue.includes('差评主题')), JSON.stringify(reviewSection.findings.map(f => f.issue)))
  check('补录后无来源项减少', withAssets.counts.nodata < noAssets.counts.nodata,
    `${noAssets.counts.nodata} → ${withAssets.counts.nodata}`)
  check('补录后分数更低（问题被暴露）', withAssets.score <= noAssets.score, `${noAssets.score} → ${withAssets.score}`)

  // ── 11. 组合视图 ───────────────────────────────────────
  const portfolio = renderPortfolio({
    marketplace: 'US',
    rows: [
      { asin: 'B0XXXXXXXX', title: 'Small Traffic Item', totalScore: 120, nfRatio: 0.5, score: 80, headline: '收预算：广告依赖', dataDate: '2026-11-04', priority: 3.2 },
      { asin: 'B0XXXXXXXX', title: 'Big Traffic Item', totalScore: 3000, nfRatio: 0.1, score: 40, headline: '补位：头词没进前 3 页', dataDate: '2026-11-04', priority: 12.5 },
    ],
  })
  check('组合视图按优先级降序（流量大的排前）', portfolio.rows[0].asin === 'B0XXXXXXXX', portfolio.rows[0].asin)
  check('组合视图含全部商品', portfolio.markdown.includes('B0XXXXXXXX') && portfolio.markdown.includes('B0XXXXXXXX'))
  check('组合视图有「先动这几个」', portfolio.markdown.includes('先动这几个'))
  const summary = summarizeForPortfolio({
    asin: 'B0XXXXXXXX',
    item: { latest: { total_score: 3000, nf_ratio: 0.1 }, dataDate: '2026-11-04', title: 'x' },
    audit: { score: 40, counts: { high: 2, medium: 1, low: 0 }, issues: [{ issue: '五点覆盖率 0' }] },
    actions: [{ verb: '补位', title: 'bench cushion 没进前 3 页', action: '补词' }],
  })
  check('摘要取第一条动作作为标题', summary.headline.includes('补位'), summary.headline)
  check('摘要优先级 > 0', summary.priority > 0, String(summary.priority))

  // ── 12. 第二轮改稿（收紧）────────────────────────────
  const round2 = buildListingDraft({
    asin: 'B0XXXXXXXX1', listing: draftInput, keywords: draftKeywords, brand: 'ROFIEJOR', tighten: true,
  })
  check('第二轮每条五点都带数字', round2.draft.bullets.every(text => /\d/.test(text)),
    JSON.stringify(round2.draft.bullets.map(text => /\d/.test(text))))
  check('第二轮五点不超过 470 字符', round2.draft.bullets.every(text => text.length <= 470),
    JSON.stringify(round2.draft.bullets.map(text => text.length)))
  check('第二轮含问句锚点（how/which/what）', /how|which|what/i.test(round2.draft.bullets.join(' ')))
  const round2Audit = auditListing({ asin: 'B0XXXXXXXX1', listing: round2.draft, keywords: draftKeywords, competitorPrices: [10, 12, 15] })
  check('第二轮复测不劣于第一轮', round2Audit.score >= afterAudit.score, `${afterAudit.score} → ${round2Audit.score}`)
  check('第二轮 GEO 通过', round2Audit.sections.find(section => section.id === 'geo').status === 'ok',
    round2Audit.sections.find(section => section.id === 'geo').status)

  // ── 13. 数据对账 ──────────────────────────────────────
  again.run(`DELETE FROM sif_raw`)
  again.run(`DELETE FROM sif_traffic`)
  upsertTraffic(again, {
    marketplace: 'US', asin: 'B0XXXXXXXX1', periodType: 'week', periodStart: '2026-10-25',
    totalScore: 900, nfScore: 300, adScore: 600, nfRatio: 0.33, adRatio: 0.67,
    tool: 'ops_get_asin_traffic_trend', fetchedAt: '2026-11-05T00:00:00Z', dataDate: '2026-11-04',
  })
  again.run(
    `INSERT INTO sif_raw (tool, params_json, params_hash, data_date, cost_points, ok, response_json, fetched_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    ['ops_get_asin_traffic_trend', JSON.stringify({ asin: 'B0XXXXXXXX1' }), 'h1', '2026-11-04', 2, 1,
      JSON.stringify({ dates: ['2026-10-25'], totalScore: [{ score: 900 }] }), '2026-11-05T00:00:00Z'])
  const sameCount = checkConsistency(again, { marketplace: 'US' })
  eq('对账：数量一致时 0 处不符', sameCount.mismatches, 0)
  check('对账结论说「对得上」', sameCount.verdict.includes('对得上'), sameCount.verdict)

  again.run(
    `INSERT INTO sif_raw (tool, params_json, params_hash, data_date, cost_points, ok, response_json, fetched_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    ['ops_get_asin_traffic_trend', JSON.stringify({ asin: 'B0XXXXXXXX1' }), 'h2', '2026-11-04', 2, 1,
      JSON.stringify({ dates: ['2026-10-25', '2026-11-01'], totalScore: [{ score: 900 }, { score: 800 }] }), '2026-11-05T01:00:00Z'])
  const drift = checkConsistency(again, { marketplace: 'US' })
  check('对账：raw 多一周时抓出不符', drift.mismatches >= 1, JSON.stringify(drift.checks))
  check('对账：结论报警', drift.verdict.includes('对不上'), drift.verdict)

  // 对账测试清空了流量表，这里把四repopulate回来，供后面的待办/健康断言使用
  again.run("DELETE FROM sif_traffic")
  again.run("DELETE FROM sif_raw")
  for (const [period, total, nf, ad] of weeks) {
    upsertTraffic(again, {
      marketplace: 'US', asin: 'B0XXXXXXXX1', periodType: 'week', periodStart: period,
      totalScore: total, nfScore: nf, adScore: ad, nfRatio: nf / total, adRatio: ad / total,
      totalChangeRatio: period === '2026-11-01' ? -0.48 : null,
      tool: 't', fetchedAt: '2026-11-05T00:00:00Z', dataDate: '2026-11-04',
    })
  }
  const actions = buildActions(again, { marketplace: 'US', asin: 'B0XXXXXXXX1' })
  check('待办非空', actions.length > 0, `n=${actions.length}`)
  check('待办按优先级降序', actions.every((item, i) => i === 0 || actions[i - 1].priority >= item.priority))
  check('每条待办都有动词与依据', actions.every(item => item.verb && item.detail))
  check('广告依赖进待办', actions.some(item => item.kind === 'cut_ad'))
  const health = dataHealth(again, { marketplace: 'US' })
  eq('健康检查能算出对象数', health.counts.objects, 1)
  check('健康检查给出覆盖率', health.coverage && typeof health.coverage.traffic === 'number')
  check('缺关键词层要点名到修法', health.gaps.some(gap => gap.layer === 'keywords' && gap.fix.includes('L2')),
    JSON.stringify(health.gaps))
  check('流量层已覆盖 100%', health.coverage.traffic === 1, `coverage=${health.coverage.traffic}`)

  again.close()
} finally {
  // Windows 上 SQLite 的 -wal/-shm 偶尔还没释放，清理失败不该淹没测试结论
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch (error) {
    console.warn(`（清理临时目录失败，忽略：${error.code}）`)
  }
}

// ── 汇总 ─────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`✓ selftest: ${pass} 项全部通过`)
} else {
  console.error(`✗ selftest: ${pass} 通过 / ${failures.length} 失败`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
