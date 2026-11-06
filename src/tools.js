/**
 * 模型侧工具。原则：**花钱的只有一个（sif_sync），其余全读本地。**
 * 这样同一份数据被分析十遍也只扣一次点，且结论与页面看到的是同一份。
 */

export function registerTools(ctx, { service }) {
  const definitions = [
    statusTool({ service }),
    dashboardTool({ service }),
    trafficTool({ service }),
    syncTool({ service }),
    reportTool({ service }),
    keywordsTool({ service }),
    mineTool({ service }),
    competitionTool({ service }),
    actionsTool({ service }),
    healthTool({ service }),
    listingAuditTool({ service }),
  ]
  for (const definition of definitions) ctx.tools.register(definition)
  return definitions.map(definition => definition.name)
}

const jsonRender = (_args, value) => ({ type: 'text', text: JSON.stringify(value, null, 2) })

function statusTool({ service }) {
  return {
    name: 'sif_status',
    description:
      'Read the SIF workbench state: whether mcp.sif.com is configured, where the local SQLite sits, row counts per table, '
      + 'and how many ASINs are tracked. Zero MCP points — call this first.',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: jsonRender },
    async execute() {
      return service.status()
    },
  }
}

function dashboardTool({ service }) {
  return {
    name: 'sif_dashboard',
    description:
      'Read the local SIF dashboard: for every tracked ASIN, the weekly traffic series (total / natural / ad), the latest '
      + 'natural-vs-ad split, top keywords with organic page/position, ad campaign counts, monthly sales, and the rule-engine '
      + 'insights with their evidence. Reads the local SQLite only — 0 MCP points, no network.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Optional: narrow to one ASIN.' },
      },
    },
    output: { schema: {}, render: jsonRender },
    async execute(args) {
      const board = service.dashboard()
      const asin = String(args?.asin ?? '').trim().toUpperCase()
      if (asin) board.asins = board.asins.filter(item => item.asin === asin)
      return board
    },
  }
}

function trafficTool({ service }) {
  return {
    name: 'sif_query_traffic',
    description:
      'Read one ASIN\'s weekly traffic rows from the local SQLite (period_start, total/natural/ad score, natural ratio, '
      + 'week-over-week change, data_date). 0 MCP points. Use it instead of re-calling ops_get_asin_traffic_trend.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'ASIN, 10 chars.' },
        limit: { type: 'number', description: 'How many weeks back. Default 12.' },
      },
      required: ['asin'],
    },
    output: { schema: {}, render: jsonRender },
    async execute(args) {
      const asin = String(args?.asin ?? '').trim().toUpperCase()
      if (!asin) throw new Error('asin is required')
      const limit = Number(args?.limit ?? 12)
      return { asin, rows: service.trafficSeries(asin, { limit: Number.isFinite(limit) ? limit : 12 }) }
    },
  }
}

function syncTool({ service }) {
  return {
    name: 'sif_sync',
    description:
      'Fetch fresh SIF data into the local SQLite. L1 = 5 points/ASIN (traffic trend + listing channel split), '
      + 'L2 = 6 points/ASIN (keyword signals + ad structure + monthly sales). Set dryRun to see the point cost first. '
      + 'Cached within 6 hours costs 0. Refuses when the daily budget would be exceeded.',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['L1', 'L2'], description: 'L1 daily or L2 weekly.' },
        asins: { type: 'array', items: { type: 'string' }, description: 'Omit to sync every tracked ASIN.' },
        dryRun: { type: 'boolean', description: 'Only report the plan and cost, do not call SIF.' },
      },
    },
    output: { schema: {}, render: jsonRender },
    async execute(args) {
      const level = args?.level === 'L2' ? 'L2' : 'L1'
      const asins = Array.isArray(args?.asins) ? args.asins : null
      if (args?.dryRun) return { plan: service.planSync({ level, asins }) }
      return service.sync({ level, asins })
    },
  }
}

function reportTool({ service }) {
  return {
    name: 'sif_report',
    description:
      'Generate a markdown operations report for one ASIN from the local data (traffic table, keyword gaps, ABA demand, '
      + 'competitor layout, ad structure, sales, rule-engine actions, and an explicit list of what is still uncontracted). '
      + 'Stores it in the library and writes a .md file. 0 MCP points.',
    parameters: {
      type: 'object',
      properties: { asin: { type: 'string', description: 'ASIN, 10 chars.' } },
      required: ['asin'],
    },
    output: { schema: {}, render: jsonRender },
    async execute(args) {
      return service.report({ asin: args?.asin })
    },
  }
}

function keywordsTool({ service }) {
  return {
    name: 'sif_keywords',
    description:
      'Read the local keyword library: one row per keyword with its ABA latest volume, demand diagnosis/momentum, weeks to '
      + 'peak, and — for the given ASIN — your own share / organic page / position. status=candidate are mined but untracked. '
      + 'Reads the local SQLite only: 0 MCP points.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'candidate / tracked / excluded. Omit for all.' },
        asin: { type: 'string', description: 'Whose position to join. Omit for the first tracked ASIN.' },
        limit: { type: 'number', description: 'Rows. Default 200.' },
      },
    },
    output: { schema: {}, render: jsonRender },
    async execute(args) {
      return {
        keywords: service.keywordLibrary({
          status: args?.status ?? null,
          asin: args?.asin ?? null,
          limit: Number(args?.limit ?? 200),
        }),
      }
    },
  }
}

function mineTool({ service }) {
  return {
    name: 'sif_mine',
    description:
      'Mine a keyword root into the library: calls market_screen_keyword_opportunities (3 points) and stores every related '
      + 'keyword as status=candidate with its weekly volume / clicks / CTR. Candidate rows do not enter reports until promoted.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Keyword root, e.g. "bench cushion".' },
        pageSize: { type: 'number', description: 'How many related keywords to pull. Default 50.' },
      },
      required: ['root'],
    },
    output: { schema: {}, render: jsonRender },
    async execute(args) {
      return service.mine({ root: args?.root, pageSize: Number(args?.pageSize ?? 50) })
    },
  }
}

function competitionTool({ service }) {
  return {
    name: 'sif_competition',
    description:
      'Analyse one keyword\'s competitive layout: calls market_get_keyword_competition (2 points) and stores the top competitor '
      + 'ASINs (asin + price) plus the concentration snapshot (top3 click/conversion share, click-vs-conversion divergence, '
      + 'leader notes). Read it back any time with 0 points via sif_keywords / the 竞品 tab.',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: 'The keyword to analyse.' } },
      required: ['keyword'],
    },
    output: { schema: {}, render: jsonRender },
    async execute(args) {
      return service.competition({ keyword: args?.keyword })
    },
  }
}

function actionsTool({ service }) {
  return {
    name: 'sif_actions',
    description:
      'The "what do I do today" list: one row per action with a verb (冲位/收预算/查广告/铺词/观望), the evidence behind it '
      + '(traffic share, page/position, distance to peak) and the suggested next step. Sorted by impact, not by time. '
      + 'Reads the local SQLite: 0 MCP points.',
    parameters: {
      type: 'object',
      properties: { asin: { type: 'string', description: 'Omit for the first tracked ASIN.' } },
    },
    output: { schema: {}, render: jsonRender },
    async execute(args) {
      return service.actions({ asin: args?.asin ?? null })
    },
  }
}

function healthTool({ service }) {
  return {
    name: 'sif_health',
    description:
      'Data health for the workbench: per-layer row counts and coverage (traffic / keywords / sales / ads), the latest data date '
      + 'and its age, and the concrete gaps naming which tab fills them. Call it before trusting a report. 0 MCP points.',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: jsonRender },
    async execute() {
      return service.health()
    },
  }
}

function listingAuditTool({ service }) {
  return {
    name: 'sif_listing_audit',
    description:
      'Deep Listing audit across 12 dimensions (title / item highlights / bullets / images / A+ / reviews / variations / GEO '
      + 'answerability / price band / attributes / backend search terms / policy compliance) against common Amazon US limits, '
      + 'plus a keyword coverage matrix built from the local library. Dimensions with no data source are reported as '
      + '"无数据来源" — never as passing. Writes a markdown report. 0 MCP points.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'ASIN to audit. Omit for the first tracked ASIN.' },
        listing: {
          type: 'object',
          description: 'Optional override: { title, bullets[], itemHighlights, description, searchTerms, attributes[], price, rating, reviews, variationNum }.',
        },
      },
    },
    output: { schema: {}, render: jsonRender },
    async execute(args) {
      return service.listingAudit({ asin: args?.asin, listing: args?.listing ?? null })
    },
  }
}
