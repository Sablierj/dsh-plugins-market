/**
 * The competitor tools: a named set of ASINs, and "us vs them" on keywords.
 *
 * Two tools, and the split between them is the split between a noun and a
 * question:
 *
 *   amzn_competitor_set_upsert   define *who* we are comparing against
 *   amzn_competitor_analyze      ask what that comparison says
 *
 * ## Where the reading stops and the judgement starts
 *
 * `readCompetitorSides` (store) fetches rows and nothing else. `buildCompetitorDiff`
 * (domain) decides which list a word belongs in. This file does neither — it
 * resolves arguments, calls the two, and renders. The reason for the three-way
 * split is that the interesting cases are all classification, and classification
 * tested through a database is a test that spends most of its time on SQLite.
 *
 * ## Why the diff has to keep "absent" and "untested" apart
 *
 * The headline list is "words the competitor holds and we do not". That sentence
 * covers two very different situations: we measured the word and we are not in
 * the results (a finding — act on it), and we never measured the word (not a
 * finding at all). The lists look identical. Reporting the second as the first
 * invents a problem, and it is the exact failure mode the library's coverage
 * rules exist to prevent (`keywordCoverage` makes the same distinction). So
 * every row carries `our_status` and the counts keep them separate.
 *
 * ## Why competitor data is read and never collected
 *
 * `kw_competitor_fact` is filled by the existing importer (卖家精灵 / 西柚 exports).
 * Nothing here opens a browser. A tool called "analyze" that quietly started a
 * scrape would be a side effect the user cannot see and did not ask for —
 * §7 of the architecture rules that out, and `amzn_keyword_research` follows the
 * same rule for its `competitor` source.
 */

import { buildCompetitorDiff, buildEvidenceView, classifyQuadrants, quadrantRows, QUADRANT_ORDER, QUADRANTS } from '../domain/keywords/competitor.js'
import {
  getCompetitorSet,
  listCompetitorSets,
  normalizeAsinList,
  readCompetitorSides,
  upsertCompetitorSet,
} from '../store/kw.js'
import { readCompetitorEvidence } from '../store/competitor-evidence.js'
import { competitorBrandHits } from '../store/keyword-ownership.js'
import { num, table, text, truncate } from './render.js'

/* ──────────────────────────── the named set ──────────────────────────── */

export function competitorSetUpsertTool({ store }) {
  return {
    name: 'amzn_competitor_set_upsert',
    description:
      'Create or update a named group of competitor ASINs — the "who are we comparing against" half of a competitor '
      + 'analysis. Call it once per set and reuse the id with amzn_competitor_analyze. '
      + 'ASINs are upper-cased, de-duplicated and sorted before they are stored, so the same list always produces the '
      + 'same stored value and re-saving a set is a no-op rather than a new revision. '
      + 'An invalid ASIN is rejected outright rather than skipped: a silently dropped competitor is one that is not '
      + 'being compared, and nothing in the output would say so. '
      + 'Duplicate set names are allowed on purpose — two product lines can legitimately track the same name — so this '
      + 'never overwrites a set you did not name. '
      + 'Omit id to create a new set. This writes to the database.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Existing set id to update. Omit to create a new set.' },
        name: { type: 'string', description: 'Human-readable name, e.g. "US 派对音箱 Top3".' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US. Required.' },
        asins: {
          type: 'array',
          items: { type: 'string' },
          description: 'Competitor ASINs. Must be 10 letters/digits each. Our own ASIN is allowed here and is excluded at analysis time.',
        },
        note: { type: 'string', description: 'Optional free note.' },
      },
      required: ['name', 'marketplace', 'asins'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const saved = upsertCompetitorSet(store, {
        id: args?.id,
        name: args?.name,
        marketplace: args?.marketplace,
        asins: args?.asins,
        note: args?.note,
      })

      const lines = [
        `${args?.id === undefined || args?.id === null || String(args.id).trim() === '' ? '新建' : '更新'}竞品组「${saved.name}」（站点 ${saved.marketplace}）`,
        `id: ${saved.id}`,
        `ASIN ${saved.asins.length} 个: ${saved.asins.join(', ')}`,
        '',
        '下一步: 用 amzn_competitor_analyze 传 competitorSetId 或 competitors[] 跑差集。',
      ]
      return lines.join('\n')
    },
  }
}

/* ──────────────────────────── the analysis ──────────────────────────── */

export function competitorAnalyzeTool({ store, workbench }) {
  return {
    name: 'amzn_competitor_analyze',
    description:
      'Compare our ASIN against competitor ASINs on keywords, from data already in the library. '
      + 'Returns two lists: words the competitors hold and we do not (the actionable one), and words we hold and they '
      + 'do not. '
      + 'Give either competitorSetId (a saved set) or competitors[] (a one-off list); they are combined if both are given. '
      + 'Our own ASIN is dropped from the competitor list if it appears there — comparing an ASIN against itself would '
      + 'report every word we hold as "theirs too", silently. '
      + 'This reads kw_competitor_fact, asin_keyword and kw_master only. It does NOT collect anything: if there is no '
      + 'competitor data for a word, the row says so (`no_data`) rather than reporting 0. '
      + 'A word we never measured is reported as `untested`, not as absent — "not measured" and "measured and missing" '
      + 'are different findings and the counts keep them apart.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Our ASIN (10 letters/digits).' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US. Required.' },
        competitorSetId: { type: 'string', description: 'A saved set from amzn_competitor_set_upsert.' },
        competitors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Competitor ASINs for a one-off comparison. Combined with competitorSetId when both are given.',
        },
        limit: { type: 'number', description: 'Maximum rows per list. Default 500, capped at 5000.' },
      },
      required: ['asin', 'marketplace'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const asin = String(args?.asin ?? '').trim().toUpperCase()
      const marketplace = String(args?.marketplace ?? '').trim().toUpperCase()

      /* Resolve the competitor list from both sources before reading, so a bad
         set id fails with "no such set" rather than silently analysing nothing. */
      const competitors = []
      let setName = null
      const setId = args?.competitorSetId === undefined || args?.competitorSetId === null
        ? ''
        : String(args.competitorSetId).trim()

      if (setId !== '') {
        const set = getCompetitorSet(store, setId)
        if (set === null) {
          const available = listCompetitorSets(store, { limit: 20 })
          return {
            ok: false,
            error: `找不到竞品组 "${setId}"`,
            hint: available.length === 0
              ? '库里还没有任何竞品组，先用 amzn_competitor_set_upsert 建一个。'
              : `现有竞品组: ${available.map(s => `${s.name}(${s.id.slice(0, 8)}…)`).join('、')}`,
          }
        }
        setName = set.name
        competitors.push(...set.asins)
        if (set.marketplace !== marketplace) {
          return {
            ok: false,
            error: `竞品组「${set.name}」的站点是 ${set.marketplace}，与请求的 ${marketplace} 不一致`,
            hint: '竞品组按站点保存，跨站点比较没有意义。改用该站点的组，或直接传 competitors[]。',
          }
        }
      }
      if (Array.isArray(args?.competitors)) competitors.push(...args.competitors)

      const requested = normalizeAsinList(competitors)
      if (requested.length === 0) {
        return {
          ok: false,
          error: '没有竞品 ASIN',
          hint: '传 competitorSetId，或直接传 competitors[]。',
        }
      }

      const sides = readCompetitorSides(store, { asin, marketplace, competitors: requested })
      const diff = buildCompetitorDiff(sides, { limit: args?.limit ?? 500 })

      workbench?.record('competitor:analyze', {
        asin: sides.asin,
        marketplace: sides.marketplace,
        competitors: sides.peers.length,
        theirsOnly: diff.counts.theirsOnly,
        oursOnly: diff.counts.oursOnly,
      }, 'plugin')

      return renderDiff({ sides, diff, setName, requested })
    },
  }
}

/* ──────────────────────────── rendering ──────────────────────────── */

const COLUMNS = [
  { label: '关键词', value: row => truncate(row.keyword, 34) },
  { label: '搜索量', value: row => num(row.search_volume) },
  { label: '竞品最好排名', value: row => num(row.competitor_best_rank) },
  { label: '竞品有排名', value: row => `${row.competitor_ranked_count}/${row.competitor_total}` },
  { label: '我们排名', value: row => num(row.our_rank) },
  { label: '搜索量来源', value: row => row.origin ?? '无' },
]

function renderDiff({ sides, diff, setName, requested }) {
  const lines = [
    `我们 ${sides.asin}（${sides.marketplace}） vs 竞品 ${sides.peers.length} 个`,
    setName === null ? `竞品: ${sides.peers.join(', ')}` : `竞品组「${setName}」: ${sides.peers.join(', ')}`,
  ]

  if (sides.excludedSelf) {
    // Said out loud, because the alternative is a silently inflated "theirs too".
    lines.push(`（注意：我们自己的 ASIN 也在传入列表里，已从竞品侧剔除；原列表 ${requested.length} 个）`)
  }

  lines.push(
    '',
    `竞品有我们没有: ${diff.counts.theirsOnly} 条（其中我们测过且确实没有排名 ${diff.counts.absent} 条，我们从没测过 ${diff.counts.untested} 条）`,
    `我们有竞品没有: ${diff.counts.oursOnly} 条`,
    `两侧都有排名: ${diff.counts.ranked} 条`,
    `数据范围: 竞品词 ${diff.coverage.competitorKeywords} 个 / 我们的词 ${diff.coverage.ourKeywords} 个`,
  )

  if (sides.peers.length === 0) {
    lines.push('', '⚠️ 竞品侧为空，没有任何可比较的数据。')
    return lines.join('\n')
  }

  lines.push('', `── 竞品有我们没有（${diff.theirsOnly.length} 条）──`)
  if (diff.theirsOnly.length === 0) {
    lines.push('（无）')
  } else {
    lines.push(table(diff.theirsOnly, COLUMNS))
    const untested = diff.theirsOnly.filter(row => row.our_status === 'untested')
    if (untested.length > 0) {
      // The distinction the whole module exists for, stated in the output.
      lines.push(
        '',
        `⚠️ 其中 ${untested.length} 条是「我们从没测过」，不是「我们测过但没有排名」。`,
        '   要变成真结论，先对这几个词跑一次 amzn_keyword_scan。',
      )
    }
    const noVolume = diff.theirsOnly.filter(row => row.no_data === true).length
    if (noVolume > 0) lines.push(`⚠️ 其中 ${noVolume} 条两侧都没有搜索量数据，搜索量为空而不是 0。`)
  }

  lines.push('', `── 我们有竞品没有（${diff.oursOnly.length} 条）──`)
  if (diff.oursOnly.length === 0) {
    lines.push('（无）')
  } else {
    lines.push(table(diff.oursOnly, COLUMNS))
    lines.push('', '这几条竞品侧没有数据（no_data），不是「竞品排名 0」——竞品排名为空的列已留空。')
  }

  lines.push(
    '',
    '说明: 竞品数据来自库里已导入的 kw_competitor_fact（卖家精灵 / 西柚导出），本次分析没有采集任何新数据。',
  )
  return lines.join('\n')
}

/* ──────────────────────── F06-04 四象限 + 证据 ──────────────────────── */

/**
 * Resolve the competitor list from `competitorSetId` and `competitors[]`.
 *
 * Returns `{ error }` rather than throwing: a bad set id is an answer the caller
 * needs ("no such set"), not a crash. Same resolution as `amzn_competitor_analyze`
 * — a second, divergent rule for "which competitors" is how two tools come to
 * compare against different lists for the same request.
 */
function resolvePeers(store, args, marketplace) {
  const competitors = []
  let setName = null
  const setId = args?.competitorSetId === undefined || args?.competitorSetId === null
    ? ''
    : String(args.competitorSetId).trim()
  if (setId !== '') {
    const set = getCompetitorSet(store, setId)
    if (set === null) {
      const available = listCompetitorSets(store, { limit: 20 })
      return {
        error: `找不到竞品组 "${setId}"`,
        hint: available.length === 0
          ? '库里还没有任何竞品组，先用 amzn_competitor_set_upsert 建一个。'
          : `现有竞品组: ${available.map(s => `${s.name}(${s.id.slice(0, 8)}…)`).join('、')}`,
      }
    }
    setName = set.name
    competitors.push(...set.asins)
    if (set.marketplace !== marketplace) {
      return {
        error: `竞品组「${set.name}」的站点是 ${set.marketplace}，与请求的 ${marketplace} 不一致`,
        hint: '竞品组按站点保存，跨站点比较没有意义。改用该站点的组，或直接传 competitors[]。',
      }
    }
  }
  if (Array.isArray(args?.competitors)) competitors.push(...args.competitors)
  const requested = normalizeAsinList(competitors)
  if (requested.length === 0) {
    return { error: '没有竞品 ASIN', hint: '传 competitorSetId，或直接传 competitors[]。' }
  }
  return { requested, setName }
}

export function competitorQuadrantsTool({ store }) {
  return {
    name: 'amzn_competitor_quadrants',
    description:
      'Classify every keyword we and a competitor set both touch into exactly one of the F06-04 quadrants: '
      + 'ownAdvantage (we rank, they do not), contested (both rank), ourAbsent (we measured and are absent), '
      + 'brandOnly (the word contains a competitor brand — isolated, never an opportunity) and unmeasured '
      + '(we hold no measurement). '
      + 'unmeasured is deliberately its own bucket: "we never measured it" is not "we are absent", and only '
      + 'ourAbsent produces candidates. '
      + 'Pass keyword to also get the raw evidence for that one word — both sides, each with its own period and '
      + 'source. When the two periods differ the evidence carries a warning and NO verdict, because §20.3 forbids '
      + 'comparing two sides measured over different periods. '
      + 'Missing data is reported as null, never 0. This reads only; it collects nothing.',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Our ASIN (10 letters/digits).' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US. Required.' },
        competitorSetId: { type: 'string', description: 'A saved set from amzn_competitor_set_upsert.' },
        competitors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Competitor ASINs for a one-off comparison. Combined with competitorSetId when both are given.',
        },
        keyword: { type: 'string', description: 'Optional: also return the raw evidence for this one keyword.' },
        limit: { type: 'number', description: 'Maximum rows shown per quadrant. Default 200, capped at 2000.' },
      },
      required: ['asin', 'marketplace'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const asin = String(args?.asin ?? '').trim().toUpperCase()
      const marketplace = String(args?.marketplace ?? '').trim().toUpperCase()
      const resolved = resolvePeers(store, args, marketplace)
      if (resolved.error !== undefined) return { ok: false, error: resolved.error, hint: resolved.hint }

      const sides = readCompetitorSides(store, { asin, marketplace, competitors: resolved.requested })
      const rows = quadrantRows(sides)
      /* 品牌识别复用 `competitorBrandHits` —— 词汇表只有一份（brand where is_own = 0）。
         在这里写第二个匹配器，两份词表就会各说各话。 */
      const result = classifyQuadrants(rows, {
        marketplace,
        brandHitsFor: keyword => competitorBrandHits(store, keyword),
      })

      const keyword = String(args?.keyword ?? '').trim()
      const lines = renderQuadrants({ sides, result, setName: resolved.setName, limit: args?.limit ?? 200 })
      if (keyword !== '') {
        const evidence = readCompetitorEvidence(store, {
          asin: sides.asin, marketplace: sides.marketplace, peers: sides.peers, keywords: [keyword],
        })
        const raw = evidence.get(keyword) ?? { our: null, their: null }
        const view = buildEvidenceView({ keyword, marketplace: sides.marketplace, our: raw.our, their: raw.their })
        lines.push('', ...renderEvidenceLines(view))
      }
      return lines.join('\n')
    },
  }
}

function renderQuadrants({ sides, result, setName, limit }) {
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 200), 1), 2000)
  const lines = [
    `我们 ${sides.asin}（${sides.marketplace}） vs 竞品 ${sides.peers.length} 个`,
    setName === null ? `竞品: ${sides.peers.join(', ')}` : `竞品组「${setName}」: ${sides.peers.join(', ')}`,
    '',
    `关键词合计 ${result.inputTotal} 条，分入 ${result.classified} 条（应相等）：`,
  ]
  for (const key of QUADRANT_ORDER) {
    lines.push(`  ${QUADRANTS[key]}(${key}): ${result.counts[key]}`)
  }
  lines.push(
    '',
    `候选（仅「我们测过、确实缺席」）：${result.candidates.length} 条`,
    `隔离区（命中竞品品牌，不得写进自有 Listing）：${result.isolated.length} 条`,
  )

  const rowColumns = [
    { label: '关键词', value: row => truncate(row.keyword, 34) },
    { label: '搜索量', value: row => num(row.search_volume) },
    { label: '我们排名', value: row => num(row.our_rank) },
    { label: '竞品最好排名', value: row => num(row.competitor_best_rank) },
    { label: '我们的状态', value: row => row.our_status },
  ]

  for (const key of QUADRANT_ORDER) {
    const rows = result.quadrants[key]
    if (rows.length === 0) continue
    lines.push('', `── ${QUADRANTS[key]}（${key}，${rows.length} 条）──`)
    if (key === 'brandOnly') {
      lines.push('这些词命中竞品品牌，已隔离：它们**不能**作为机会，也不能出现在自有 Listing 里（§20.6）。')
    }
    if (key === 'unmeasured') {
      lines.push('这些词我们**从没测过** —— 不是「测过但没有排名」。要变成真结论，先跑一次覆盖扫描。')
    }
    lines.push(table(rows.slice(0, cap), rowColumns))
    if (rows.length > cap) lines.push(`（只显示前 ${cap} 条，共 ${rows.length} 条）`)
  }

  lines.push(
    '',
    '说明: 竞品数据来自库里已导入的 kw_competitor_fact，本次分析没有采集任何新数据。',
    '加 keyword 参数可查看某条词两侧的原始数据与观测时间。',
  )
  return lines
}

/** 「未知」而不是 0：缺失是缺失，0 是一个测量值。 */
function unknown(value) {
  return value === null || value === undefined || value === '' ? '未知/未测' : String(value)
}

function sideLines(side, fallbackPeriodNote) {
  const facts = side.facts ?? {}
  const lines = [
    `  观测周期: ${unknown(side.period)}${fallbackPeriodNote}`,
    `  来源: ${unknown(side.source)}`,
  ]
  if (!side.measured) {
    lines.push('  状态: 无测量数据（未知/未测，不是 0）')
    return lines
  }
  lines.push(`  排名: ${unknown(facts.rank)}`)
  lines.push(`  搜索量: ${unknown(facts.search_volume)}`)
  return lines
}

function renderEvidenceLines(view) {
  const lines = [`── 证据: ${view.keyword}（站点 ${view.marketplace}）──`]
  lines.push('我方:')
  lines.push(...sideLines(view.our, ''))
  lines.push('竞品侧:')
  lines.push(`  观测周期: ${unknown(view.their.period)}（kw_competitor_fact.collected_at，可为空）`)
  lines.push(`  来源: ${unknown(view.their.source)}`)
  if (!view.their.measured) {
    lines.push('  状态: 无测量数据（未知/未测，不是 0）')
  } else {
    lines.push(`  竞品最好排名: ${unknown(view.their.facts.best_rank)}`)
    lines.push(`  有排名的竞品: ${unknown(view.their.facts.ranked_count)}/${view.their.facts.present_count}`)
    lines.push(`  搜索量: ${unknown(view.their.facts.monthly_volume ?? view.their.facts.weekly_searches)}`)
  }
  /* 竞品侧自己跨了多个观测日：与「两侧不同」是不同的事实，分开说，并点名日期。 */
  if (view.theirPeriodsMixed) {
    lines.push(`  竞品侧观测日: ${(view.their.periods ?? []).join('、')}`)
  }
  if (view.warning !== null) lines.push('', `⚠️ ${view.warning}`)
  if (view.verdict !== null) {
    lines.push('', '结论: 两侧周期一致且都有测量，可以对比。')
  } else if (view.warning === null) {
    lines.push('', '不给结论。')
  }
  return lines
}
