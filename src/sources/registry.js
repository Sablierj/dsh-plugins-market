/**
 * Data source adapters.
 *
 * Every source — the browser we drive ourselves, and the three third-party
 * platforms — sits behind one contract, so the layer above never learns which
 * kind it is talking to. That is what lets the API channels be added later
 * without touching a single tool or the page.
 *
 * The two kinds:
 *
 *   kind 'browser'  CDP against a real Chrome with a dedicated profile. This is
 *                   the only channel wired up today, because the three
 *                   platforms all want a separately purchased quota we do not
 *                   have. See `./browser/collector.js`.
 *   kind 'api'      HTTP or MCP. 卖家精灵's MCP endpoint is streamable-http, so
 *                   wiring it later is a client plus one normaliser, not 45
 *                   hand-written REST wrappers.
 *
 * A source's `status` is part of its contract with the agent: `ready` means
 * collect() works, `planned` means it exists but must not be used. Reporting
 * that honestly is the difference between an agent that asks the right source
 * and one that burns a turn discovering a source is not connected.
 *
 * `collectible: false` is the third distinction, and it is not the same as
 * `planned`: the `manual` source is fully usable, it just has no collector. It
 * exists so hand-entered values still carry a provenance label.
 */

import { describePacing, resolvePacing } from './pacing.js'
import { MARKETPLACES, supportedFields } from './pages/index.js'
import { listSources, setSourceHealth } from '../store/queries.js'

const HEALTH_TTL_MS = 30_000

/** Fields this plugin knows how to store. A source advertises the subset it can fill. */
export const KNOWN_FIELDS = [
  'title', 'brand', 'price', 'currency', 'bsr', 'category',
  'rating', 'reviews', 'image_url', 'keywords',
]

/**
 * @typedef {object} SourceAdapter
 * @property {string} id
 * @property {'browser'|'api'|'manual'} kind
 * @property {string} transport   human-readable: 'cdp' | 'http' | 'mcp' | 'none'
 * @property {string} status      'ready' | 'planned'
 * @property {string} statusNote  why it is not ready, in the agent's words
 * @property {() => object} capabilities
 * @property {() => Promise<{ok: boolean, detail?: string}>} healthCheck
 * @property {(request: object) => Promise<object>} collect
 */

/**
 * The browser adapter, thin on purpose: the work lives in the collector, and
 * this only describes it to the rest of the plugin.
 *
 * `healthCheck` is delegated rather than reimplemented because the honest
 * answer is not "is Chrome up" — it is "is Chrome up **and did the selectors
 * still match last time**". Only the collector knows the second half.
 */
function browserAdapter({ collector, pacing }) {
  return {
    id: 'browser-local',
    kind: 'browser',
    transport: 'cdp',
    status: 'ready',
    collectible: true,
    statusNote: 'CDP 驱动独立 profile 的本机 Chrome，采集亚马逊前台商品页',
    capabilities: () => ({
      fields: supportedFields(),
      requiresAuth: false,
      rateLimit: describePacing(pacing),
      notes: '亚马逊前台商品页无需登录。第三方平台网页端需要登录，登录态保存在独立 profile 里。'
        + '每个目标在采集前都会套用该站点的域名、界面语言（lc-main）与币种（i18n-prefs）并设置 Accept-Language，'
        + '采集后校验落地站点/语言/币种是否相符，不符的目标拒收不写库。'
        + '遇验证码/风控页即停止整个任务，不重试、不绕过。',
      marketplaces: Object.keys(MARKETPLACES),
      browser: { host: collector.host, port: collector.port, profile: collector.profileDir },
    }),
    healthCheck: () => collector.healthCheck(),
    collect: request => collector.collect(request),
  }
}

/**
 * Not a collector at all: the row exists so hand-entered and hand-corrected
 * values still carry a provenance label. `collectible: false` keeps it out of
 * the list of sources an agent may submit collection work to.
 */
function manualAdapter() {
  return {
    id: 'manual',
    kind: 'manual',
    transport: 'none',
    status: 'ready',
    collectible: false,
    statusNote: '不是采集通道；用于人工粘贴或修正的数据，让这些值也有来源标记',
    capabilities: () => ({
      fields: KNOWN_FIELDS,
      requiresAuth: false,
      notes: '人工录入，无自动采集',
    }),
    async healthCheck() {
      return { ok: true, detail: '人工通道，无需检查' }
    },
    async collect() {
      throw new Error('manual is not a collection channel; use amzn_asin_upsert to import values')
    },
  }
}

/**
 * A third-party channel that exists on paper and is not connected. It reports
 * itself as `planned` rather than failing at collect time, so the agent can
 * route around it.
 */
function plannedAdapter({ id, transport, statusNote, capabilities }) {
  return {
    id,
    kind: 'api',
    transport,
    status: 'planned',
    collectible: true,
    statusNote,
    capabilities: () => ({ requiresAuth: true, ...capabilities }),
    async healthCheck() {
      return { ok: false, detail: `未接入：${statusNote}` }
    },
    async collect() {
      throw new Error(`${id} is not connected yet: ${statusNote}`)
    },
  }
}

export function createSourceRegistry(store, options = {}) {
  const pacing = resolvePacing(options.pacing)

  const adapters = new Map([
    ['manual', manualAdapter()],
    ['sellersprite', plannedAdapter({
      id: 'sellersprite',
      transport: 'mcp',
      statusNote: '需在开放平台单独开额度并取得 secret-key',
      capabilities: {
        fields: ['title', 'brand', 'price', 'bsr', 'rating', 'reviews', 'keywords'],
        notes: 'MCP 45 个工具（asin_detail / traffic_keyword / keyword_order / aba_research_* / keyword_miner 等），streamable-http',
      },
    })],
    ['xiyou', plannedAdapter({
      id: 'xiyou',
      transport: 'http',
      statusNote: '按 ASIN 计费，未购买额度',
      capabilities: { fields: ['keywords'], notes: '西柚洞察 OpenAPI，关键词与 ASIN 数据' },
    })],
    ['saihu', plannedAdapter({
      id: 'saihu',
      transport: 'http',
      statusNote: '需联系客户经理开通',
      capabilities: { fields: ['price', 'bsr', 'reviews'], notes: '11 大业务板块 60+ 接口' },
    })],
  ])

  // Registered only when a collector was supplied, so a profile that cannot
  // drive a browser does not advertise a source that would fail on use.
  if (options.collector) {
    adapters.set('browser-local', browserAdapter({ collector: options.collector, pacing }))
  }

  return {
    pacing,

    /**
     * Every source with its adapter merged in. The database row carries
     * operator-set state (`enabled`); the adapter carries what it can do.
     */
    async list({ checkHealth = true } = {}) {
      const rows = listSources(store)
      const result = []
      for (const row of rows) {
        const adapter = adapters.get(row.id)
        const health = checkHealth && adapter ? await adapter.healthCheck() : undefined
        // Only persist a change. The page asks for this on every refresh, and a
        // write per poll would put needless churn on the store.
        if (health !== undefined && JSON.stringify(health) !== row.last_health) {
          setSourceHealth(store, row.id, health)
        }
        result.push({
          id: row.id,
          name: row.name,
          kind: adapter?.kind ?? row.kind,
          transport: adapter?.transport ?? 'unknown',
          enabled: row.enabled === 1,
          collectible: adapter?.collectible !== false,
          status: adapter?.status ?? 'unknown',
          statusNote: adapter?.statusNote ?? null,
          capabilities: adapter?.capabilities() ?? null,
          health: health ?? null,
          notes: row.notes ?? null,
        })
      }
      return result
    },

    get(id) {
      return adapters.get(String(id)) ?? null
    },

    /** Sources the agent may actually submit collection work to. */
    async usable() {
      return (await this.list({ checkHealth: false }))
        .filter(source => source.enabled && source.status === 'ready' && source.collectible)
    },
  }
}
