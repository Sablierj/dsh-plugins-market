/**
 * 服务：整个插件唯一的「状态持有者」。
 *
 * M1 只做两件事：连接配置的读写（密钥落在 data/config.json，0600）与 status 汇总。
 * M2 起 MCP 客户端挂在这里，M3 起 store 挂在这里 —— 页面、工具、同步都拿同一个实例，
 * 绝不各自 new 一个（那样会开出第二条数据库连接、第二个 MCP 会话）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createMcpClient } from './mcp.js'
import { buildDashboard } from './domain/dashboard.js'
import { computeInsights } from './domain/insights.js'
import { buildActions } from './domain/actions.js'
import { dataHealth } from './domain/health.js'
import { auditListing } from './domain/listing-audit.js'
import { renderListingReport } from './domain/listing-report.js'
import { buildListingDraft, diffAudit, renderDraftReport } from './domain/listing-draft.js'
import { buildDeepReport } from './domain/deep-report.js'
import { renderPortfolio, summarizeForPortfolio } from './domain/portfolio.js'
import { checkConsistency } from './domain/consistency.js'
import { buildReport } from './domain/report.js'
import { openStore } from './store/db.js'
import {
  counts, deleteObject, getReport, listInsights, listObjects, listReports, replaceInsights, saveReport, spentToday, trafficSeries, upsertObject,
} from './store/queries.js'
import { runL1 } from './sync/l1.js'
import { runL2 } from './sync/l2.js'
import { fetchProfile } from './sync/profile.js'
import { nowIso } from './store/time.js'
import { fetchKeywordData } from './sync/keyword.js'
import { keywordSyncCost } from './sync/keyword.js'
import { mineKeywords } from './sync/mining.js'
import { fetchCompetition } from './sync/competition.js'
import { getAsset, removeAsset, upsertAsset } from './store/queries.js'
import { readAmazonOpsListing } from './sources/amazon-ops.js'
import {
  listKeywordLibrary, setKeywordStatus, latestMarketSnapshot, latestCompetitors,
} from './store/keywords.js'
import { planSync } from './sync/plan.js'

export const DEFAULT_ENDPOINT = 'https://mcp.sif.com/mcp'
export const DEFAULT_MARKETPLACE = 'US'

/** 只接受 http(s)，避免把密钥发到奇怪的 scheme 上。 */
function normalizeEndpoint(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return DEFAULT_ENDPOINT
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('端点不是合法 URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('端点只支持 http/https')
  return url.toString()
}

/** 页面永远看不到明文密钥，只看到尾巴 4 位。 */
export function maskSecret(secret) {
  const value = String(secret ?? '')
  if (value === '') return ''
  if (value.length <= 4) return '****'
  return '…' + value.slice(-4)
}

export function createService({ dataDir, logger = console, defaults = {} } = {}) {
  mkdirSync(dataDir, { recursive: true })

  const configPath = join(dataDir, 'config.json')
  const dbPath = join(dataDir, 'sif.db')

  const base = {
    endpoint: normalizeEndpoint(defaults.endpoint),
    authMode: 'bearer',
    secret: '',
    dailyBudget: Number(defaults.dailyBudget ?? 60),
    updatedAt: null,
  }

  function readConfig() {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
      return { ...base, ...parsed, endpoint: normalizeEndpoint(parsed.endpoint ?? base.endpoint) }
    } catch {
      return { ...base }
    }
  }

  let config = readConfig()

  function publicConfig() {
    return {
      endpoint: config.endpoint,
      authMode: config.authMode,
      dailyBudget: config.dailyBudget,
      hasSecret: config.secret !== '',
      secretHint: maskSecret(config.secret),
      updatedAt: config.updatedAt,
      configPath,
    }
  }

  /** 页面写配置：只接受白名单字段；密钥为空 = 不改（避免把已存的密钥清空）。 */
  function saveConfig(patch = {}) {
    const next = { ...config }
    if (patch.endpoint !== undefined) next.endpoint = normalizeEndpoint(patch.endpoint)
    if (patch.authMode !== undefined) {
      const mode = String(patch.authMode)
      if (mode !== 'bearer' && mode !== 'oauth') throw new Error('鉴权方式只支持 bearer / oauth')
      next.authMode = mode
    }
    if (patch.secret !== undefined && String(patch.secret).trim() !== '') next.secret = String(patch.secret).trim()
    if (patch.dailyBudget !== undefined) {
      const budget = Number(patch.dailyBudget)
      if (!Number.isFinite(budget) || budget <= 0) throw new Error('日预算必须是正数')
      next.dailyBudget = budget
    }
    if (patch.clearSecret === true) next.secret = ''
    next.updatedAt = new Date().toISOString()

    writeFileSync(configPath, JSON.stringify(next, null, 2), { mode: 0o600 })
    try {
      chmodSync(configPath, 0o600)
    } catch {
      /* Windows 上 chmod 基本是空转；写权限位只是尽力而为 */
    }
    config = next
    // 端点/密钥可能变了：丢掉旧客户端，下次请求用新凭证重建。
    dropClient()
    logger.info?.(`[sif-ops] config saved (secret ${next.secret === '' ? 'cleared' : 'set'})`)
    return publicConfig()
  }

  /** 进程内 MCP 客户端：改了端点或密钥就丢掉重建，避免拿着旧凭证发请求。 */
  let mcp = null

  function dropClient() {
    try {
      mcp?.close?.()
    } catch {
      /* 已断开 */
    }
    mcp = null
  }

  /** 只有真正要发请求时才建客户端；连不上的插件不该在启动时崩。 */
  function ensureClient() {
    if (config.secret === '') throw new Error('还没有保存密钥：先在「连接」页填一个 SIF 密钥')
    if (!mcp) mcp = createMcpClient({ endpoint: config.endpoint, secret: config.secret, logger })
    return mcp
  }

  /** 连通性测试：走 0 点的 initialize + tools/list + query_quota。 */
  async function testConnection() {
    return ensureClient().test()
  }

  // ── M3 存储：库是按需打开的，第一次真正要用时才建文件 ──────
  let store = null

  function ensureStore() {
    if (!store) store = openStore({ dataDir, logger })
    return store
  }

  function objects() {
    return listObjects(ensureStore(), DEFAULT_MARKETPLACE)
  }

  async function addObject({ asin, label, note } = {}) {
    const clean = String(asin ?? '').trim().toUpperCase()
    if (!/^[A-Z0-9]{10}$/.test(clean)) throw new Error('ASIN 必须是 10 位字母数字')
    const currentStore = ensureStore()
    upsertObject(currentStore, {
      marketplace: DEFAULT_MARKETPLACE,
      asin: clean,
      label: label === 'competitor' ? 'competitor' : 'mine',
      note: note ? String(note) : null,
    })
    // 顺手抓一次画像（2 点，6 小时内重复加同一个人是 0 点）。失败不阻断添加。
    let profile = null
    try {
      profile = await fetchProfile({
        client: ensureClient(),
        store: currentStore,
        marketplace: DEFAULT_MARKETPLACE,
        asin: clean,
        logger,
      })
    } catch (error) {
      logger.warn?.(`[sif-ops] 画像拉取跳过：${error.message}`)
      profile = { ok: false, error: error.message }
    }
    return { objects: objects(), profile }
  }

  function removeObject({ asin } = {}) {
    const clean = String(asin ?? '').trim().toUpperCase()
    const removed = deleteObject(ensureStore(), DEFAULT_MARKETPLACE, clean)
    return { removed, objects: objects() }
  }

  // ── M4 同步：预算闸 → 逐 ASIN 跑 → 记账 ──────────────────
  function buildPlan({ level = 'L1', asins = null } = {}) {
    const target = Array.isArray(asins) && asins.length ? asins : objects().map(object => object.asin)
    return planSync({ store: ensureStore(), level, asins: target, dailyBudget: config.dailyBudget })
  }

  async function sync({ level = 'L1', asins = null } = {}) {
    const currentStore = ensureStore()
    const client = ensureClient()
    const target = Array.isArray(asins) && asins.length ? asins : objects().map(object => object.asin)
    const plan = planSync({ store: currentStore, level, asins: target, dailyBudget: config.dailyBudget })
    if (plan.asins.length === 0) throw new Error('还没有对象：先在「对象」页加一个 ASIN')
    if (plan.overBudget) {
      throw new Error(`超出日预算：本次需 ${plan.cost} 点，今天已花 ${plan.todaySpent} 点，预算 ${plan.budget} 点`)
    }

    const results = []
    for (const asin of plan.asins) {
      results.push(level === 'L2'
        ? await runL2({ client, store: currentStore, marketplace: DEFAULT_MARKETPLACE, asin, logger })
        : await runL1({ client, store: currentStore, marketplace: DEFAULT_MARKETPLACE, asin, logger }))
    }
    const totalCost = results.reduce((sum, item) => sum + (item.cost ?? 0), 0)
    const totalRows = results.reduce((sum, item) => sum + (item.rows ?? 0), 0)
    // 同步完就重算洞察：页面上的结论必须比数据新，不能等人手动点。
    for (const asin of plan.asins) {
      replaceInsights(currentStore, {
        marketplace: DEFAULT_MARKETPLACE,
        asin,
        insights: computeInsights(currentStore, { marketplace: DEFAULT_MARKETPLACE, asin }),
      })
    }
    return { plan, results, totalCost, totalRows, objects: objects() }
  }

  // ── M5 看板 ──────────────────────────────────────────────
  function dashboard() {
    const currentStore = ensureStore()
    const board = buildDashboard(currentStore, { marketplace: DEFAULT_MARKETPLACE })
    for (const item of board.asins) {
      replaceInsights(currentStore, {
        marketplace: DEFAULT_MARKETPLACE,
        asin: item.asin,
        insights: item.insights,
      })
    }
    return board
  }

  function insights({ asin = null } = {}) {
    return listInsights(ensureStore(), { marketplace: DEFAULT_MARKETPLACE, asin })
  }

  // ── M7 报告 ──────────────────────────────────────────────
  function report({ asin } = {}) {
    const currentStore = ensureStore()
    const board = dashboard()
    const target = String(asin ?? '').toUpperCase()
    // 报告要「完整」：把词库（ABA/需求）和头词竞品格局一起带进去
    const keywordRows = keywordLibrary({ asin: target, limit: 50 })
    const head = currentStore.get(
      `SELECT keyword FROM sif_asin_keyword WHERE marketplace = ? AND asin = ?
       ORDER BY traffic_share DESC LIMIT 1`, [DEFAULT_MARKETPLACE, target])
    const competition = head
      ? {
          keyword: head.keyword,
          snapshot: latestMarketSnapshot(currentStore, { marketplace: DEFAULT_MARKETPLACE, keyword: head.keyword }),
          competitors: latestCompetitors(currentStore, { marketplace: DEFAULT_MARKETPLACE, keyword: head.keyword }),
        }
      : null
    const built = buildReport(board, {
      asin: target,
      keywordRows,
      competition,
      actions: buildActions(currentStore, { marketplace: DEFAULT_MARKETPLACE, asin: target }),
    })
    if (!built) throw new Error(`没有这个对象：${asin}（先在「对象」页加入）`)
    const saved = saveReport(currentStore, {
      marketplace: DEFAULT_MARKETPLACE,
      asin: built.asin,
      kind: 'asin-weekly',
      title: built.title,
      markdown: built.markdown,
      rangeFrom: built.rangeFrom,
      rangeTo: built.rangeTo,
    })
    // 同时落一份文件，方便直接发给运营/归档
    const dir = join(dataDir, 'reports')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${built.asin}-${new Date().toISOString().slice(0, 10)}.md`)
    writeFileSync(file, built.markdown, 'utf8')
    logger.info?.(`[sif-ops] report #${saved.id} → ${file}`)
    return { id: saved.id, file, ...built }
  }

  function reports({ asin = null, limit = 20 } = {}) {
    return listReports(ensureStore(), { marketplace: DEFAULT_MARKETPLACE, asin, limit })
  }

  // ── M8 关键词总库 / 挖掘 / 竞品 ─────────────────────────
  function keywordLibrary({ status = null, asin = null, limit = 200 } = {}) {
    return listKeywordLibrary(ensureStore(), {
      marketplace: DEFAULT_MARKETPLACE,
      status,
      asin: asin ?? objects()[0]?.asin ?? null,
      limit,
    })
  }

  /**
   * 关键词级数据（ABA + 需求）。
   * **按批计费，不是按词计费**：history 1 点 / 10 词，demand 2 点 / 20 词。
   * 实测 3 个词只扣 3 点（1 + 2），所以报价必须按调用次数算，否则预算是错的。
   */
  function planKeywords({ keywords = [] } = {}) {
    const list = [...new Set((keywords ?? []).map(word => String(word).trim().toLowerCase()).filter(Boolean))]
    const historyCalls = Math.ceil(list.length / 10)
    const demandCalls = Math.ceil(list.length / 20)
    const cost = keywordSyncCost(list.length)
    const spent = spentToday(ensureStore())
    return {
      keywords: list,
      cost,
      costModel: `history ${historyCalls} 次×1 点 + demand ${demandCalls} 次×2 点`,
      todaySpent: spent,
      budget: config.dailyBudget,
      overBudget: spent + cost > config.dailyBudget,
    }
  }

  async function syncKeywords({ keywords = null } = {}) {
    const currentStore = ensureStore()
    const client = ensureClient()
    const list = Array.isArray(keywords) && keywords.length
      ? keywords
      : keywordLibrary({ status: 'tracked', limit: 50 }).map(row => row.keyword)
    if (!list.length) throw new Error('词库里还没有 tracked 的词：先挖掘或手动加词')
    const plan = planKeywords({ keywords: list })
    if (plan.overBudget) throw new Error(`超出日预算：本次需 ${plan.cost} 点，今天已花 ${plan.todaySpent} 点`)
    const result = await fetchKeywordData({ client, store: currentStore, marketplace: DEFAULT_MARKETPLACE, keywords: list, logger })
    return { plan, ...result, library: keywordLibrary() }
  }

  /** 词根挖掘：3 点/次，候选词进库（candidate）。 */
  async function mine({ root, pageSize = 50 } = {}) {
    const currentStore = ensureStore()
    const result = await mineKeywords({
      client: ensureClient(), store: currentStore, marketplace: DEFAULT_MARKETPLACE,
      root, pageSize, logger,
    })
    return { ...result, library: keywordLibrary() }
  }

  /** 竞品与格局：2 点/词。 */
  async function competition({ keyword } = {}) {
    const currentStore = ensureStore()
    const result = await fetchCompetition({
      client: ensureClient(), store: currentStore, marketplace: DEFAULT_MARKETPLACE, keyword, logger,
    })
    return result
  }

  function markKeyword({ keyword, status, note = null } = {}) {
    const result = setKeywordStatus(ensureStore(), {
      marketplace: DEFAULT_MARKETPLACE, keyword, status, note,
    })
    return { ...result, library: keywordLibrary() }
  }

  function marketView({ keyword } = {}) {
    const currentStore = ensureStore()
    return {
      keyword: String(keyword ?? '').trim().toLowerCase(),
      snapshot: latestMarketSnapshot(currentStore, { marketplace: DEFAULT_MARKETPLACE, keyword }),
      competitors: latestCompetitors(currentStore, { marketplace: DEFAULT_MARKETPLACE, keyword }),
    }
  }

  // ── 今日待办 / 数据健康 / 导出 ───────────────────────────
  function actions({ asin = null } = {}) {
    const currentStore = ensureStore()
    const target = String(asin ?? objects()[0]?.asin ?? '').toUpperCase()
    if (!target) return { asin: null, actions: [] }
    return { asin: target, actions: buildActions(currentStore, { marketplace: DEFAULT_MARKETPLACE, asin: target }) }
  }

  function health() {
    return dataHealth(ensureStore(), { marketplace: DEFAULT_MARKETPLACE })
  }

  /** 数据对账：raw 与摊平表逐项比数量，专治「静默丢数」。 */
  function consistency() {
    return checkConsistency(ensureStore(), { marketplace: DEFAULT_MARKETPLACE })
  }

  // ── M12 Listing 深度诊断 ─────────────────────────────────
  function listingAudit({ asin, listing: override = null } = {}) {
    const context = listingContext(asin)
    const target = context.target
    const listing = override ?? context.listing
    const audit = auditListing({
      asin: target,
      listing,
      keywords: context.keywords,
      competitorPrices: context.prices,
      assets: context.assets,
    })
    const markdown = renderListingReport(audit, { asin: target })

    const saved = context.store.run(
      `INSERT INTO sif_listing_audit (marketplace, asin, generated_at, score, sections_json, markdown)
       VALUES (?,?,?,?,?,?)`,
      [DEFAULT_MARKETPLACE, target, audit.generatedAt, audit.score, JSON.stringify(audit.sections), markdown],
    )

    const dir = join(dataDir, 'reports')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${target}-listing-${new Date().toISOString().slice(0, 10)}.md`)
    writeFileSync(file, markdown, 'utf8')
    logger.info?.(`[sif-ops] listing audit ${target}: ${audit.score}/100 → ${file}`)

    return { id: Number(saved.lastInsertRowid), file, audit, markdown }
  }

  function latestListingAudit({ asin } = {}) {
    const target = String(asin ?? objects()[0]?.asin ?? '').toUpperCase()
    return ensureStore().get(
      `SELECT id, asin, generated_at, score, markdown FROM sif_listing_audit
       WHERE marketplace = ? AND asin = ? ORDER BY id DESC LIMIT 1`, [DEFAULT_MARKETPLACE, target]) ?? null
  }

  /** 诊断/改稿共用：把一个 ASIN 的文案、带量词、竞品价格一次取齐。 */
  function listingContext(asin) {
    const currentStore = ensureStore()
    const target = String(asin ?? objects()[0]?.asin ?? '').toUpperCase()
    const row = currentStore.get(
      'SELECT * FROM sif_asin WHERE marketplace = ? AND asin = ?', [DEFAULT_MARKETPLACE, target])
    if (!row) throw new Error(`没有 ${target} 的画像：先在「对象」页加它（会自动拉画像）`)

    // 文案优先取 amazon-ops 采集到的真 listing（有就用），否则用 SIF 画像里的字段
    const remote = readAmazonOpsListing({ asin: target, marketplace: DEFAULT_MARKETPLACE, logger })
    const remoteBullets = remote?.found
      ? (Array.isArray(remote.listing.bullets) ? remote.listing.bullets : []).map(item => (typeof item === 'string' ? item : item?.text ?? '')).filter(Boolean)
      : []
    const listing = remote?.found
      ? {
          title: remote.listing.title || row.title || '',
          bullets: remoteBullets,
          itemHighlights: remote.listing.itemHighlights || row.item_highlights || '',
          description: remote.listing.description || row.description || '',
          searchTerms: remote.listing.searchTerms || row.search_terms || '',
          attributes: (remote.listing.attributes?.length ? remote.listing.attributes : safeJson(row.feature_list_json, [])),
          size: row.size ?? '',
          color: row.color ?? '',
          price: row.price,
          rating: row.star_rating,
          reviews: row.rating_num,
          variationNum: row.variation_num,
          source: 'amazon-ops',
        }
      : {
          title: row.title ?? '',
          bullets: safeJson(row.bullets_json, []),
          itemHighlights: row.item_highlights ?? '',
          description: row.description ?? '',
          searchTerms: row.search_terms ?? '',
          attributes: safeJson(row.feature_list_json, []),
          size: row.size ?? '',
          color: row.color ?? '',
          price: row.price,
          rating: row.star_rating,
          reviews: row.rating_num,
          variationNum: row.variation_num,
          source: 'sif',
        }
    const assets = getAsset(currentStore, DEFAULT_MARKETPLACE, target)
    // 覆盖矩阵看「真正带量的词」，不是词库里量最大的无关候选词
    const own = currentStore.all(
      `SELECT keyword, traffic_share FROM sif_asin_keyword
       WHERE marketplace = ? AND asin = ? ORDER BY traffic_share DESC LIMIT 15`,
      [DEFAULT_MARKETPLACE, target])
    const keywords = own.length
      ? own.map(item => ({ keyword: item.keyword, traffic_share: item.traffic_share }))
      : keywordLibrary({ asin: target, limit: 15 }).map(item => ({
          keyword: item.keyword, traffic_share: item.my_share, aba_volume: item.aba_volume, volume_week: item.volume_week,
        }))
    const head = currentStore.get(
      `SELECT keyword FROM sif_asin_keyword WHERE marketplace = ? AND asin = ?
       ORDER BY traffic_share DESC LIMIT 1`, [DEFAULT_MARKETPLACE, target])
    const prices = head
      ? latestCompetitors(currentStore, { marketplace: DEFAULT_MARKETPLACE, keyword: head.keyword })
          .map(item => Number(item.price)).filter(value => Number.isFinite(value) && value > 0)
      : []
    return { store: currentStore, target, row, listing, keywords, prices, brand: row.brand ?? null, assets }
  }

  /** 素材补录：图片数 / 白底 / 像素 / 视频 / A+ / 差评主题。 */
  function saveListingAssets({ asin, reset = false, ...patch } = {}) {
    const target = String(asin ?? objects()[0]?.asin ?? '').toUpperCase()
    if (reset) {
      const removed = removeAsset(ensureStore(), DEFAULT_MARKETPLACE, target)
      logger.info?.(`[sif-ops] assets reset for ${target}`)
      return { asin: target, removed, assets: null }
    }
    const saved = upsertAsset(ensureStore(), {
      marketplace: DEFAULT_MARKETPLACE,
      asin: target,
      imagesTotal: patch.imagesTotal,
      hasWhiteBg: patch.hasWhiteBg,
      minPxOk: patch.minPxOk,
      hasVideo: patch.hasVideo,
      aplus: patch.aplus,
      reviewThemes: patch.reviewThemes,
      notes: patch.notes,
      source: 'manual',
    })
    logger.info?.(`[sif-ops] assets saved for ${target}`)
    return { asin: target, assets: saved }
  }

  function listingAssets({ asin } = {}) {
    const target = String(asin ?? objects()[0]?.asin ?? '').toUpperCase()
    const asset = getAsset(ensureStore(), DEFAULT_MARKETPLACE, target)
    const remote = readAmazonOpsListing({ asin: target, marketplace: DEFAULT_MARKETPLACE, logger })
    return { asin: target, assets: asset, amazonOps: remote }
  }

  /** 改稿草稿：诊断 → 生成英文文案 → 用同一套规则复测。round=2 会收紧五点与 GEO 锚点。 */
  function listingDraft({ asin, round = 1 } = {}) {
    const context = listingContext(asin)
    const before = auditListing({
      asin: context.target, listing: context.listing, keywords: context.keywords,
      competitorPrices: context.prices, assets: context.assets,
    })
    const { draft, notes } = buildListingDraft({
      asin: context.target, listing: context.listing, keywords: context.keywords,
      brand: context.brand, tighten: Number(round) >= 2,
    })
    const after = auditListing({
      asin: context.target, listing: draft, keywords: context.keywords,
      competitorPrices: context.prices, assets: context.assets,
    })
    const diff = diffAudit(before, after)
    const markdown = renderDraftReport({ asin: context.target, draft, notes, diff, before, after })

    const saved = context.store.run(
      `INSERT INTO sif_report (marketplace, asin, kind, title, markdown, range_from, range_to, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [DEFAULT_MARKETPLACE, context.target, 'listing-draft', `${context.target} 改稿草稿 ${new Date().toISOString().slice(0, 10)}`,
        markdown, null, null, nowIso()],
    )
    const dir = join(dataDir, 'reports')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${context.target}-draft-${new Date().toISOString().slice(0, 10)}.md`)
    writeFileSync(file, markdown, 'utf8')
    logger.info?.(`[sif-ops] draft ${context.target}: ${diff.scoreBefore} → ${diff.scoreAfter} → ${file}`)

    return { id: Number(saved.lastInsertRowid), file, draft, notes, diff, before, after, markdown, round: Number(round) >= 2 ? 2 : 1 }
  }

  /** 深度总报告：把前面所有分析合成一份 md + 一份自包含 html。 */
  function deepReport({ asin } = {}) {
    const context = listingContext(asin)
    const target = context.target
    const board = dashboard()
    const audit = auditListing({
      asin: target, listing: context.listing, keywords: context.keywords,
      competitorPrices: context.prices, assets: context.assets,
    })
    const { draft, notes } = buildListingDraft({
      asin: target, listing: context.listing, keywords: context.keywords, brand: context.brand,
    })
    const after = auditListing({
      asin: target, listing: draft, keywords: context.keywords,
      competitorPrices: context.prices, assets: context.assets,
    })
    const draftPkg = { draft, notes, diff: diffAudit(audit, after), before: audit, after }
    const actions = buildActions(context.store, { marketplace: DEFAULT_MARKETPLACE, asin: target })
    const health = dataHealth(context.store, { marketplace: DEFAULT_MARKETPLACE })
    const head = context.store.get(
      `SELECT keyword FROM sif_asin_keyword WHERE marketplace = ? AND asin = ? ORDER BY traffic_share DESC LIMIT 1`,
      [DEFAULT_MARKETPLACE, target])
    const competition = head
      ? {
          keyword: head.keyword,
          snapshot: latestMarketSnapshot(context.store, { marketplace: DEFAULT_MARKETPLACE, keyword: head.keyword }),
          competitors: latestCompetitors(context.store, { marketplace: DEFAULT_MARKETPLACE, keyword: head.keyword }),
        }
      : null

    const report = buildDeepReport({ asin: target, board, audit, draft: draftPkg, actions, health, competition })

    const dir = join(dataDir, 'reports')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    const mdFile = join(dir, `${target}-deep-${stamp}.md`)
    const htmlFile = join(dir, `${target}-deep-${stamp}.html`)
    writeFileSync(mdFile, report.markdown, 'utf8')
    writeFileSync(htmlFile, report.html, 'utf8')

    const saved = context.store.run(
      `INSERT INTO sif_report (marketplace, asin, kind, title, markdown, range_from, range_to, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [DEFAULT_MARKETPLACE, target, 'deep', `${target} 深度分析总报告 ${stamp}`, report.markdown, null, null, nowIso()],
    )
    logger.info?.(`[sif-ops] deep report ${target}: md ${report.markdown.length}B / html ${report.html.length}B`)
    return {
      id: Number(saved.lastInsertRowid),
      mdFile,
      htmlFile,
      markdown: report.markdown,
      html: report.html,
      score: audit.score,
      draftDiff: draftPkg.diff,
    }
  }

  /** 组合视图：一次看所有 ASIN，按「问题严重度 × 流量权重」排序。 */
  function portfolio() {
    const currentStore = ensureStore()
    const board = dashboard()
    const rows = []
    for (const item of board.asins) {
      try {
        const context = listingContext(item.asin)
        const audit = auditListing({
          asin: item.asin, listing: context.listing, keywords: context.keywords,
          competitorPrices: context.prices, assets: context.assets,
        })
        const actions = buildActions(currentStore, { marketplace: DEFAULT_MARKETPLACE, asin: item.asin })
        rows.push(summarizeForPortfolio({ asin: item.asin, item, audit, actions }))
      } catch (error) {
        // 单个品没有画像/文案不该让整张组合表挂掉
        rows.push({
          asin: item.asin, title: item.title ?? null, totalScore: item.latest?.total_score ?? null,
          nfRatio: item.latest?.nf_ratio ?? null, dataDate: item.dataDate ?? null, score: null,
          headline: `诊断不可用：${error.message}`, nextAction: '先补画像/文案', priority: 0,
        })
      }
    }
    const report = renderPortfolio({ marketplace: DEFAULT_MARKETPLACE, rows })
    const dir = join(dataDir, 'reports')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    const file = join(dir, `portfolio-${DEFAULT_MARKETPLACE}-${stamp}.md`)
    writeFileSync(file, report.markdown, 'utf8')
    const saved = currentStore.run(
      `INSERT INTO sif_report (marketplace, asin, kind, title, markdown, range_from, range_to, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [DEFAULT_MARKETPLACE, null, 'portfolio', `${DEFAULT_MARKETPLACE} 组合总览 ${stamp}`, report.markdown, null, null, nowIso()],
    )
    return { id: Number(saved.lastInsertRowid), file, markdown: report.markdown, rows: report.rows }
  }

  /**
   * 一键日更：预算检查 → 同步 → 洞察重算 → 组合总览 → 前 3 名深度报告。
   * 每一步都回状态，页面按步骤条渲染（可视化流程），失败停在该步并说明原因。
   */
  async function daily({ level = 'L1', deepTop = 3 } = {}) {
    const steps = []
    const list = objects()
    if (!list.length) throw new Error('还没有对象：先在「对象」页加 ASIN')
    const asins = list.map(item => item.asin)

    const plan = buildPlan({ level, asins })
    steps.push({
      name: '预算检查',
      status: plan.overBudget ? 'blocked' : 'ok',
      detail: `${plan.asins.length} 个 ASIN × ${plan.costPerAsin} 点 = ${plan.cost} 点`
        + `（今日已花 ${plan.todaySpent} / 预算 ${plan.budget}）`,
    })
    if (plan.overBudget) return { ok: false, steps, blocked: true }

    let syncResult = null
    try {
      syncResult = await sync({ level, asins })
      steps.push({
        name: `同步 ${level}`,
        status: 'ok',
        detail: `扣 ${syncResult.totalCost} 点 · 入库 ${syncResult.totalRows} 行`,
      })
    } catch (error) {
      steps.push({ name: `同步 ${level}`, status: 'failed', detail: error.message })
      return { ok: false, steps }
    }

    steps.push({ name: '洞察与待办', status: 'ok', detail: '已按最新数据重算（0 点）' })

    let portfolioResult = null
    try {
      portfolioResult = portfolio()
      steps.push({ name: '组合总览', status: 'ok', detail: `${portfolioResult.rows.length} 个商品 → ${portfolioResult.file}` })
    } catch (error) {
      steps.push({ name: '组合总览', status: 'failed', detail: error.message })
    }

    const top = (portfolioResult?.rows ?? []).slice(0, Math.max(0, deepTop))
    const deepFiles = []
    for (const row of top) {
      try {
        const deep = deepReport({ asin: row.asin })
        deepFiles.push({ asin: row.asin, html: deep.htmlFile, md: deep.mdFile })
      } catch (error) {
        deepFiles.push({ asin: row.asin, error: error.message })
      }
    }
    steps.push({
      name: '深度报告',
      status: deepFiles.some(item => item.error) ? 'partial' : 'ok',
      detail: deepFiles.length ? deepFiles.map(item => item.asin + (item.error ? '（失败）' : '')).join('、') : '无对象',
    })

    return { ok: true, level, steps, cost: syncResult?.totalCost ?? 0, rows: syncResult?.totalRows ?? 0, portfolio: portfolioResult?.file ?? null, deep: deepFiles }
  }

  function listingRaw({ asin } = {}) {    const target = String(asin ?? objects()[0]?.asin ?? '').toUpperCase()
    const row = ensureStore().get(
      'SELECT title, bullets_json, item_highlights, description, search_terms, feature_list_json, price, star_rating, rating_num, variation_num FROM sif_asin WHERE marketplace = ? AND asin = ?',
      [DEFAULT_MARKETPLACE, target])
    if (!row) return null
    return {
      asin: target,
      title: row.title,
      bullets: safeJson(row.bullets_json, []),
      itemHighlights: row.item_highlights,
      description: row.description,
      searchTerms: row.search_terms,
      attributes: safeJson(row.feature_list_json, []),
      price: row.price,
      rating: row.star_rating,
      reviews: row.rating_num,
      variationNum: row.variation_num,
    }
  }

  /** 导出 CSV：运营要拿去自己的表里做透视，所以给文件而不是页面截图。 */
  function exportCsv({ kind = 'keywords', asin = null } = {}) {
    const currentStore = ensureStore()
    const dir = join(dataDir, 'exports')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)

    let header
    let rows
    if (kind === 'keywords') {
      const list = keywordLibrary({ asin: asin ?? objects()[0]?.asin ?? null, limit: 500 })
      header = ['keyword', 'status', 'aba_volume', 'diagnosis', 'momentum', 'weeks_to_peak', 'my_share', 'my_page', 'my_pos', 'gap_severity', 'volume_week']
      rows = list.map(row => [
        row.keyword, row.status, row.aba_volume ?? '', row.diagnosis ?? '', row.momentum ?? '',
        row.weeks_to_peak ?? '', row.my_share ?? '', row.my_page ?? '', row.my_pos ?? '',
        row.gap_severity ?? '', row.volume_week ?? '',
      ])
    } else if (kind === 'traffic') {
      const target = String(asin ?? objects()[0]?.asin ?? '').toUpperCase()
      const list = currentStore.all(
        `SELECT period_start, total_score, nf_score, ad_score, nf_ratio, ad_ratio, total_change_ratio, data_date
         FROM sif_traffic WHERE marketplace = ? AND asin = ? AND period_type = 'week' ORDER BY period_start`,
        [DEFAULT_MARKETPLACE, target])
      header = ['asin', 'period_start', 'total_score', 'nf_score', 'ad_score', 'nf_ratio', 'ad_ratio', 'total_change_ratio', 'data_date']
      rows = list.map(row => [target, row.period_start, round(row.total_score), round(row.nf_score), round(row.ad_score),
        row.nf_ratio ?? '', row.ad_ratio ?? '', row.total_change_ratio ?? '', row.data_date ?? ''])
    } else if (kind === 'competitors') {
      const word = String(asin ?? '').trim().toLowerCase() // 这里 asin 参数当 keyword 用
      const list = latestCompetitors(currentStore, { marketplace: DEFAULT_MARKETPLACE, keyword: word })
      header = ['keyword', 'asin', 'price']
      rows = list.map(row => [word, row.asin, row.price ?? ''])
    } else {
      throw new Error(`未知导出类型：${kind}（支持 keywords / traffic / competitors）`)
    }

    const csv = [header.join(','), ...rows.map(row => row.map(cell => csvCell(cell)).join(','))].join('\n')
    const file = join(dir, `sif-${kind}-${stamp}.csv`)
    // Excel 打开中文要 BOM，这里补上（与之前 MCP 调试相反的用途：那是请求体，这是给人看的文件）
    writeFileSync(file, '\ufeff' + csv, 'utf8')
    logger.info?.(`[sif-ops] export ${kind}: ${rows.length} 行 → ${file}`)
    return { kind, file, rows: rows.length, csv }
  }

  function reportBody(id) {
    return getReport(ensureStore(), id)
  }

  function status() {
    const db = (() => {
      try {
        const currentStore = ensureStore()
        return { file: dbPath, version: currentStore.version, counts: counts(currentStore) }
      } catch (error) {
        return { file: dbPath, version: null, error: error.message }
      }
    })()
    return {
      ok: true,
      plugin: 'sif-ops',
      version: '0.1.0',
      stage: 'M1-M5/M7 可用（连接 · 对象 · L1/L2 同步 · 看板 · 洞察 · 报告）；L3 关键词/ABA、告警推送未接',
      marketplace: DEFAULT_MARKETPLACE,
      dataDir,
      dbFile: dbPath,
      dbExists: existsSync(dbPath),
      db,
      config: publicConfig(),
      mcp: mcp ? mcp.status() : { connected: false, note: '尚未测试连接' },
      objects: (() => {
        try {
          return objects().length
        } catch {
          return 0
        }
      })(),
    }
  }

  function close() {
    try {
      mcp?.close?.()
    } catch {
      /* 已断开 */
    }
    try {
      store?.close?.()
    } catch {
      /* 已关 */
    }
  }

  return {
    get dataDir() {
      return dataDir
    },
    get dbPath() {
      return dbPath
    },
    get configPath() {
      return configPath
    },
    /** 内部取密钥用；不对外暴露到页面 JSON。 */
    get secret() {
      return config.secret
    },
    get endpoint() {
      return config.endpoint
    },
    get config() {
      return { ...config }
    },
    publicConfig,
    saveConfig,
    ensureClient,
    ensureStore,
    testConnection,
    objects,
    addObject,
    removeObject,
    planSync: buildPlan,
    sync,
    dashboard,
    insights,
    report,
    reports,
    reportBody,
    keywordLibrary,
    planKeywords,
    syncKeywords,
    mine,
    competition,
    markKeyword,
    marketView,
    actions,
    health,
    consistency,
    exportCsv,
    listingAudit,
    latestListingAudit,
    listingRaw,
    listingDraft,
    deepReport,
    listingAssets,
    saveListingAssets,
    portfolio,
    daily,
    /** 页面看板用：某 ASIN 的周流量序列（读本地，0 点）。 */
    trafficSeries(asin, options) {
      return trafficSeries(ensureStore(), DEFAULT_MARKETPLACE, String(asin ?? '').toUpperCase(), options)
    },
    status,
    close,
  }
}


/** 导出 CSV 用：数字四舍五入，空值留空（不写 0）。 */
function round(value) {
  return value === null || value === undefined ? '' : Math.round(Number(value))
}

/** CSV 单元格：含逗号/引号/换行就加引号并转义。 */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}

/** JSON 列读回：坏数据不许让整页崩，退回 fallback。 */
function safeJson(text, fallback) {
  if (!text) return fallback
  try {
    const value = JSON.parse(text)
    return value ?? fallback
  } catch {
    return fallback
  }
}
