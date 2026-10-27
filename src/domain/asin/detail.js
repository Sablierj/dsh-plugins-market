/**
 * ASIN 详情（模块 05 F05-02）—— 一个 builder，两条门（工具与页面路由）。
 *
 * ## 为什么是一个 builder
 *
 * `amzn_asin_detail`（会话侧读）与 `GET /api/asin-detail`（页面读）返回同一个形状，
 * 因为它们调的是这个函数。两条路径各算一遍的下场是本仓已经见过的那种：
 * 工具说「3 个字段有冲突」、页面说「1 个」，而且两边都不报错。B-04 的
 * `buildSectionDetail` 是同一条约定的先例。
 *
 * ## 九个标签页，一个都不少，也一个都不多
 *
 * F05-02 是九个标签页。前四个由本模块自己的四个视图承担，后五个由五个专门的
 * builder 承担（`keywords` / `reviews` / `competitor` / `optimization` / `provenance`），
 * 它们的产出都放进**同一个**载荷。所以页面读一次 `/api/asin-detail` 就有九页 ——
 * 九个 Tab 各自开一条路由会让「同一页上的两个数字来自两个算法」重新变成可能，
 * 而那条纪律正是这个 builder 存在的理由。
 *
 * ## 一次全建，按需取用
 *
 * 九个视图都在这里建出来（它们互相引用同一批事实：概览的比例就是另外几个视图算的，
 * `reviews` 读的 `sections` 与 13 节那一页是**同一个对象**），所以「页面只取一个
 * 标签页」也不省下这里的查询。这是有意的取舍：一个 ASIN 的这九个视图加起来是几十次
 * 索引查询，而**同一页上的两个数字来自两个算法**是不可接受的。
 *
 * ## `pendingTabs` 现在是空的，而且这是有意的
 *
 * 它曾经点名列出「还没建的五个」。那五个建完了，名单就该是空的 —— 一个留着已建页的
 * 名单与一个没人用的死常量是同一种谎。它**不删**：页面那段 `length === 0 ? '' : …`
 * 是「以后再加第十个标签页时不会静默消失」的守卫，而守卫与一份空名单是两件事。
 */

import { buildFieldFacts } from './fields.js'
import { buildOverview } from './overview.js'
import { buildSectionView } from './sections.js'
import { buildVariantView } from './variants.js'
import { buildAsinKeywordView } from './keywords.js'
import { buildAsinReviewView } from './reviews.js'
import { buildAsinCompetitorView } from './competitor.js'
import { buildAsinOptimizationView } from './optimization.js'
import { buildAsinSourceView } from './provenance.js'
import { readGeoFacts } from '../geo/citability.js'
import { isAsinArchived, listArchiveEvents } from '../../store/archive.js'

/** F05-02 的九个标签页，顺序即页面的顺序。 */
export const ASIN_DETAIL_TABS = [
  'overview', 'fields', 'sections', 'variants',
  'keywords', 'reviews', 'competitor', 'optimization', 'sources',
]

/** 标签页的中文名。页面不另写一份（脚本里没法 import，所以由服务端注入）。 */
export const ASIN_DETAIL_TAB_LABELS = {
  overview: '概览',
  fields: 'Listing 全字段',
  sections: '13 节',
  variants: '变体关系',
  keywords: '关键词与排名',
  reviews: '评论问答',
  competitor: '竞品对比',
  optimization: '优化历史',
  sources: '来源与审计',
}

/**
 * 还没建的标签页。**现在是空的**：F05-02 的九个全部建好了。
 *
 * 它曾经有五条（`keywords` / `reviews` / `competitor` / `optimization` / `sources`），
 * 那五条每一条都带 `note` 说清「不是没有数据，是还没有这一页」。五页建完之后
 * 名单清空 —— 但导出与页面那段渲染都留着，因为它们是**守卫**：
 * 下一次有人加第十个标签页而忘了建渲染器时，页面会照旧印一句「还没建」，
 * 而不是画一个空表（空表读起来像「这个 ASIN 没有数据」）。
 */
export const ASIN_DETAIL_PENDING_TABS = []

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

export function buildAsinDetail({ store, asin, marketplace = 'US' } = {}) {
  const key = blankToNull(asin)
  if (key === null) return { ok: false, code: 'BAD_REQUEST', error: 'asin is required' }
  const market = blankToNull(marketplace)
  if (market === null) return { ok: false, code: 'BAD_REQUEST', error: 'marketplace is required' }

  const row = store.get('SELECT asin, marketplace FROM asin WHERE asin = ? AND marketplace = ?',
    [key.toUpperCase(), market.toUpperCase()])
  if (row === undefined) {
    return {
      ok: false,
      code: 'ASIN_NOT_FOUND',
      error: `${key.toUpperCase()} (${market.toUpperCase()}) 不在库内`,
      hint: '先用 amzn_asin_upsert 导入，或确认站点代码对不对 —— 同一个 ASIN 在不同站点是两条记录',
    }
  }

  const asinKey = row.asin
  const marketplaceKey = row.marketplace
  const fields = buildFieldFacts(store, { asin: asinKey, marketplace: marketplaceKey })
  const sections = buildSectionView(store, { asin: asinKey, marketplace: marketplaceKey })
  const variants = buildVariantView(store, { asin: asinKey, marketplace: marketplaceKey })
  const archiveEvents = listArchiveEvents(store, { asin: asinKey, marketplace: marketplaceKey, limit: 50 })

  /* ★ 「这个 ASIN 现在是不是归档的」只有一个定义：`store/archive.js` 的
     `isAsinArchived`。这里读一次，往下传（概览那一块用的是**同一个布尔**）。
     概览自己也能从它读的那一行算出 `row.archived_at !== null` —— 但那就是同一个判据的
     第二份实现，而两份会在某次改动之后分叉，分叉时的症状是**安静**的：页面照样画得出来，
     只是把一条已归档的记录说成「在架上」。所以那一份不写。 */
  const archived = isAsinArchived(store, { asin: asinKey, marketplace: marketplaceKey })
  const overview = buildOverview(store, {
    asin: asinKey, marketplace: marketplaceKey, fields, sections, variants, archiveEvents, archived,
  })

  /* 后五个标签页。两处**注入**而不是各自再读一遍：
     · `reviews` 要 `sections` —— 「哪一行是这一节的最新读数」只能有一个答案，而上面
       刚刚算过一次。第二次读 `collection_section_result` 就是第二个答案。
     · `provenance` 要 `archiveEvents` —— 「这条 ASIN 归档过没有」同理。
     注入的形状与 `buildOverview` 要 `archived`、`buildAsinHealthSummary` 要
     `fields` / `precheck` 是同一条纪律。 */
  const keywords = buildAsinKeywordView(store, { asin: asinKey, marketplace: marketplaceKey })
  const reviews = buildAsinReviewView(store, {
    asin: asinKey, marketplace: marketplaceKey, sections,
  })
  const competitor = buildAsinCompetitorView(store, { asin: asinKey, marketplace: marketplaceKey })
  const optimization = buildAsinOptimizationView(store, { asin: asinKey, marketplace: marketplaceKey })
  const sources = buildAsinSourceView(store, {
    asin: asinKey, marketplace: marketplaceKey, archiveEvents,
  })

  /* T71 / FR-M4-15：GEO 四组事实。`fields` 已经在本函数里算过一遍，注入进去，
     避免 readGeoFacts 再 buildFieldFacts 一次；竞品集由 readGeoFacts 自己从
     asin_competitor 解析（没有竞品组时组③是「没有竞品组」卡，不是 ASIN 详情失败）。
     这一块是**可选读数**：geo 失败不回滚九个页签，页面按错误态印「GEO 事实没算出来」。
     所以这里接住异常并转成 `geo.ok=false` —— 一个读数的失败不能让整条详情变成 500。 */
  let geo
  try {
    geo = readGeoFacts(store, {
      asin: asinKey, marketplace: marketplaceKey, fields,
    })
  } catch (error) {
    geo = { ok: false, code: error?.code ?? 'GEO_FAILED', error: error?.message ?? String(error) }
  }

  return {
    ok: true,
    asin: asinKey,
    marketplace: marketplaceKey,
    /* 顶层的这一个布尔与 `overview.archive.archived` 是**同一个值**（不是第二次读），
       存在的理由是页面头部：它画在九个 body 之外，所以不该依赖「概览那一块在不在」
       才能说清「这条记录是归档的」——而归档正是最不能让人误以为「数据丢了」的那一态。 */
    archived,
    tabs: [...ASIN_DETAIL_TABS],
    tabLabels: { ...ASIN_DETAIL_TAB_LABELS },
    pendingTabs: ASIN_DETAIL_PENDING_TABS.map(tab => ({ ...tab })),
    overview,
    fields,
    sections,
    variants,
    archiveEvents,
    keywords,
    reviews,
    competitor,
    optimization,
    sources,
    geo,
  }
}
