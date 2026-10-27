/**
 * Keyword tools — the master library, coverage, discovery and scanning.
 *
 * The split mirrors the collection tools deliberately: **discovery and scanning
 * write, and one of them takes minutes**, so it is submitted rather than
 * awaited. `amzn_keyword_scan` returns a task id immediately and the same
 * `amzn_collect_status` reads it, because a keyword scan and an ASIN collection
 * are the same shape of job (see `insertCollectionTask`).
 *
 * The two read tools answer different questions and are not interchangeable:
 *
 *   - `amzn_keyword_query`  — "what is in the library", library-first.
 *   - `amzn_keyword_coverage` — "what does *this ASIN* have and lack",
 *     ASIN-first, and it is the one that separates a real gap (measured, absent)
 *     from a word that was simply never measured. That distinction is the whole
 *     reason the tool exists: reporting an unmeasured word as a gap invents a
 *     problem and sends the user off to fix something that was never broken.
 */

import { keywordCoverage, queryKeywords, upsertAsinKeyword, upsertKeyword } from '../store/queries.js'
import { readLibraryMembership, readResearchCompetitor, readResearchLibrary } from '../store/kw.js'
import { buildResearchCandidates, collectCandidateKeywords, RESEARCH_BUCKETS } from '../domain/keywords/research.js'
import { DISCOVERY_SEED_MAX, discoverKeywords, recomputeTiersForAsin, SCAN_KEYWORD_MAX } from '../sources/keyword.js'
import { RESULTS_PER_PAGE, TIER_LABELS, TIER_MEANING, TIERS } from '../sources/keyword-tiers.js'
import { num, table, text, truncate } from './render.js'

/** `T1 守位` — the label is what makes a tier mean something to a reader. */
function tierLabel(tier) {
  if (tier === null || tier === undefined || tier === '') return '—'
  return `${tier} ${TIER_LABELS[tier] ?? ''}`.trim()
}

export function keywordQueryTool({ store }) {
  return {
    name: 'amzn_keyword_query',
    description:
      'Query the **ASIN keyword associations** — the legacy `keyword` table (16 rows in the current library), '
      + 'one row per (keyword, marketplace) with how many of our ASINs rank for it, how many were measured and missing, '
      + 'and how many were never measured. This is **not** the master library: for the imported master library '
      + '(kw_master, currently ~30,778 rows) use amzn_kw_query, or the facade action amzn_keyword.query. '
      + 'Tiers: T1 守位 (ranks on page 1) / T2 冲刺 (ranks below page 1) / T3 抢占 (no rank but the listing '
      + 'already says it) / T4 观察 (no rank and the listing is silent). '
      + 'Use it to see the per-ASIN association table, and to check whether a word is already associated with an ASIN '
      + 'before adding it. For one ASIN\'s own coverage use amzn_keyword_coverage instead.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US / DE. Omit for all.' },
        q: { type: 'string', description: 'Substring match over the keyword itself.' },
        tier: { type: 'string', description: 'T1 | T2 | T3 | T4' },
        untiered: { type: 'boolean', description: 'Only keywords that have never been measured for any ASIN.' },
        minVolume: { type: 'number', description: 'Only keywords with search_volume >= this. Needs a third-party source; the browser channel cannot supply volume.' },
        order: { type: 'string', description: 'updated (default) | tier | keyword | volume | coverage' },
        limit: { type: 'number', description: 'Rows to return. Default 50, max 500.' },
        offset: { type: 'number', description: 'Rows to skip, for paging. Default 0.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const result = queryKeywords(store, args ?? {})
      if (result.rows.length === 0) {
        return [
          `没有匹配的 ASIN 关键词关联（legacy keyword 表内共 ${result.total} 条符合条件的记录）。`,
          '这张表是 ASIN 关键词关联，不是关键词总库；总库请用 amzn_kw_query（kw_master）。',
          '关联为空时两条路：用 amzn_keyword_discover 从种子词自动扩词，或用 amzn_keyword_import 导入已有词表。',
        ].join('\n')
      }

      return [
        `ASIN 关键词关联 (legacy keyword，${result.rows.length}/${result.total} 条，offset=${result.offset}):`,
        table(result.rows, [
          { label: '关键词', value: row => truncate(row.keyword, 34) },
          { label: '站点', value: row => row.marketplace },
          { label: '分层', value: row => tierLabel(row.tier) },
          { label: '有排名', value: row => (row.ranked === 0 ? '' : row.ranked) },
          { label: '已测无排名', value: row => (row.missing === 0 ? '' : row.missing) },
          { label: '未测', value: row => (row.unscanned === 0 ? '' : row.unscanned) },
          { label: '搜索量', value: row => num(row.search_volume) },
          { label: '来源', value: row => row.source_id ?? '' },
        ]),
        '',
        '分层说明: ' + TIERS.map(tier => `${tier} ${TIER_LABELS[tier]} = ${TIER_MEANING[tier]}`).join('；'),
      ].join('\n')
    },
  }
}

export function keywordCoverageTool({ store }) {
  return {
    name: 'amzn_keyword_coverage',
    description:
      'For one ASIN: which keywords it covers, which it is measured-and-missing for, which are in the library but '
      + 'were never measured for it, and what to work on next. '
      + 'Read the three lists carefully — "gaps" are measured facts, "untested" is not a gap, and reporting the '
      + 'second as the first would send the user to fix something that was never broken. '
      + 'Each row carries the scan depth behind it, so "no rank" can be read as "not in the first N results".',
    parameters: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN, 10 characters.' },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        limit: { type: 'number', description: 'Rows per list. Default 200.' },
      },
      required: ['asin'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const asin = String(args?.asin ?? '').trim().toUpperCase()
      const marketplace = String(args?.marketplace ?? 'US').trim().toUpperCase()
      const result = keywordCoverage(store, asin, marketplace, { limit: args?.limit })

      if (result.rows.length === 0 && result.untested.length === 0) {
        return [
          `${asin} (${marketplace}) 还没有任何关键词数据。`,
          '先用 amzn_keyword_discover 建词库，再用 amzn_keyword_scan 测这个 ASIN 的覆盖情况。',
        ].join('\n')
      }

      const { summary } = result
      const lines = [
        `${asin} · ${marketplace} 关键词覆盖`,
        `已测 ${summary.measured} 条：有排名 ${summary.ranked}，已测无排名 ${summary.gaps}，未测 ${summary.unscanned}`,
        `分层: ${TIERS.map(tier => `${tier} ${TIER_LABELS[tier]} ${summary.byTier[tier]}`).join('   ')}`,
        `库内还有 ${summary.untested} 条词没有测过这个 ASIN`,
      ]

      if (summary.measured === 0 && summary.untested > 0) {
        lines.push('', '⚠️ 一条都没测过。上面的分层全部为 0 —— 这是"没测"，不是"没排名"。')
      }

      const ranked = result.rows.filter(row => row.rank !== null)
      if (ranked.length > 0) {
        lines.push('', `有排名 (${ranked.length}):`)
        lines.push(table(ranked.slice(0, 25), [
          { label: '关键词', value: row => truncate(row.keyword, 34) },
          { label: '排名', value: row => row.rank },
          { label: '页', value: row => row.page ?? '' },
          { label: '分层', value: row => tierLabel(row.tier) },
        ]))
      }

      if (result.gaps.length > 0) {
        lines.push('', `已测无排名（缺口，${result.gaps.length}）:`)
        lines.push(table(result.gaps.slice(0, 25), [
          { label: '关键词', value: row => truncate(row.keyword, 34) },
          { label: '扫描深度', value: row => row.scan_depth },
          { label: '分层', value: row => tierLabel(row.tier) },
          { label: '测于', value: row => String(row.collected_at ?? '').slice(0, 16) },
        ]))
      }

      if (result.untested.length > 0) {
        lines.push('', `库内有、但这个 ASIN 没测过（${result.untested.length}，不是缺口）:`)
        lines.push(result.untested.slice(0, 15).map(row => `- ${row.keyword}`).join('\n'))
      }

      if (result.suggested.length > 0) {
        lines.push('', `建议先做 (${result.suggested.length}):`)
        lines.push(table(result.suggested.slice(0, 20), [
          { label: '关键词', value: row => truncate(row.keyword, 34) },
          { label: '分层', value: row => tierLabel(row.tier) },
          { label: '为什么', value: row => truncate(row.reason, 40) },
        ]))
      }

      return lines.join('\n')
    },
  }
}

export function keywordImportTool({ store }) {
  return {
    name: 'amzn_keyword_import',
    description:
      'Import keywords into the master library, and optionally record per-ASIN rankings for them. '
      + 'This is the path for a keyword list pasted by the user, and later for a third-party source (卖家精灵 / 西柚 / 赛狐) '
      + 'once its quota is bought. '
      + 'Per-ASIN tiers are always derived from rank + listing coverage, never supplied — a hand-set tier would be '
      + 'overwritten by the next scan, and a tier nobody can reproduce is worse than no tier. '
      + 'This writes to the database: confirm the rows with the user first when they came from a guess rather than from data.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Source id, e.g. manual or sellersprite. Required for provenance.' },
        marketplace: { type: 'string', description: 'Default marketplace for rows that do not set one. Default US.' },
        keywords: {
          type: 'array',
          description: 'Keywords to add to the library.',
          items: {
            type: 'object',
            properties: {
              keyword: { type: 'string' },
              marketplace: { type: 'string' },
              searchVolume: { type: 'number', description: 'Only a third-party source can supply this.' },
              difficulty: { type: 'number' },
              tags: { type: 'array', items: { type: 'string' } },
              note: { type: 'string' },
            },
            required: ['keyword'],
          },
        },
        measurements: {
          type: 'array',
          description: 'Rankings to record for specific ASINs. rank: null means "measured and not found".',
          items: {
            type: 'object',
            properties: {
              asin: { type: 'string' },
              keyword: { type: 'string' },
              marketplace: { type: 'string' },
              rank: { type: 'number', description: 'Organic position. Omit or null for "measured, not found".' },
              page: { type: 'number' },
              scanDepth: { type: 'number', description: 'How many results were looked at. Required for a null rank to mean anything.' },
              searchVolume: { type: 'number' },
            },
            required: ['asin', 'keyword'],
          },
        },
      },
      required: ['keywords'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const sourceId = String(args?.sourceId ?? 'manual').trim()
      const defaultMarketplace = String(args?.marketplace ?? 'US').trim().toUpperCase()
      const keywords = Array.isArray(args?.keywords) ? args.keywords : []
      const measurements = Array.isArray(args?.measurements) ? args.measurements : []
      if (keywords.length === 0) return { ok: false, error: 'keywords is empty' }

      const failed = []
      let added = 0
      const touched = new Set()

      for (const row of keywords) {
        try {
          upsertKeyword(store, {
            keyword: row?.keyword,
            marketplace: row?.marketplace ?? defaultMarketplace,
            sourceId,
            searchVolume: row?.searchVolume,
            difficulty: row?.difficulty,
            tags: row?.tags,
            note: row?.note,
          })
          added += 1
        } catch (error) {
          failed.push(`${row?.keyword ?? '(no keyword)'}: ${error.message}`)
        }
      }

      let measured = 0
      for (const row of measurements) {
        const marketplace = String(row?.marketplace ?? defaultMarketplace).trim().toUpperCase()
        try {
          upsertAsinKeyword(store, {
            asin: row?.asin,
            marketplace,
            keyword: row?.keyword,
            sourceId,
            rank: row?.rank ?? null,
            page: row?.page ?? null,
            scanDepth: row?.scanDepth ?? null,
            searchVolume: row?.searchVolume,
          })
          measured += 1
          touched.add(`${String(row?.asin).trim().toUpperCase()}|${marketplace}`)
        } catch (error) {
          failed.push(`${row?.asin ?? '?'}/${row?.keyword ?? '?'}: ${error.message}`)
        }
      }

      // Tiers for whatever we just recorded, so the imported rows are not
      // invisible to every tier-ordered view.
      const retiered = []
      for (const key of touched) {
        const [asin, marketplace] = key.split('|')
        retiered.push({ asin, ...recomputeTiersForAsin(store, asin, marketplace) })
      }

      const lines = [
        `导入完成: 关键词 ${added} 条，排名记录 ${measured} 条，失败 ${failed.length} 条（来源 ${sourceId}）`,
        retiered.length > 0
          ? `重算分层: ${retiered.map(entry => `${entry.asin} ${entry.updated}/${entry.keywords}`).join('，')}`
          : '',
        failed.length > 0 ? `失败:\n${failed.map(line => `- ${line}`).join('\n')}` : '',
        '提示: 没有 scanDepth 的 rank=null 无法区分"没扫到"和"没测过"，覆盖度工具会把它算作未测。',
      ].filter(Boolean)

      return lines.join('\n')
    },
  }
}

export function keywordDiscoverTool({ store, collector, workbench }) {
  return {
    name: 'amzn_keyword_discover',
    description:
      'Expand seed words into keywords and add them to the master library, by typing each seed into Amazon\'s real '
      + 'search box and reading the suggestions it returns. '
      + 'This drives a real browser against one storefront, so the suggestions come back in that storefront\'s language — '
      + 'which is why it types instead of calling the completion endpoint (a wrong marketplace id there would return '
      + 'another storefront\'s suggestions silently). '
      + `At most ${DISCOVERY_SEED_MAX} seeds per call, and it takes seconds per seed. `
      + 'Set dryRun to see what it would add without writing. '
      + 'This writes to the database unless dryRun is set.',
    parameters: {
      type: 'object',
      properties: {
        seeds: {
          type: 'array',
          items: { type: 'string' },
          description: `Seed words, e.g. the core terms of a product line. Max ${DISCOVERY_SEED_MAX}.`,
        },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        limit: { type: 'number', description: 'Suggestions to keep per seed. Default 11.' },
        dryRun: { type: 'boolean', description: 'Report the keywords without writing them. Default false.' },
      },
      required: ['seeds'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      if (collector === undefined || collector === null) {
        return { ok: false, error: '没有可用的浏览器采集器，无法自动扩词。用 amzn_keyword_import 手工导入词表。' }
      }
      const seeds = Array.isArray(args?.seeds) ? args.seeds : []
      const marketplace = String(args?.marketplace ?? 'US').trim().toUpperCase()
      const dryRun = args?.dryRun === true

      const result = await discoverKeywordsForTool({ collector, marketplace, seeds, limit: args?.limit, workbench })

      const lines = [
        `种子 ${result.seeds.length} 个 → 关键词 ${result.keywords.length} 条（站点 ${marketplace}，${result.storefront.domain}）`,
        `耗时 ${(result.durationMs / 1000).toFixed(1)} 秒${dryRun ? '，dryRun 未写库' : ''}`,
      ]

      if (result.storefrontActions.length > 0) {
        lines.push('', '站点切换:', ...result.storefrontActions.map(action => `- ${action}`))
      }
      if (result.storefrontProblems.length > 0) {
        lines.push('', '站点问题:', ...result.storefrontProblems.map(problem => `- ${problem.code}: ${problem.detail}`))
      }

      for (const entry of result.perSeed) {
        lines.push('', `「${entry.seed}」 → ${entry.keywords.length} 条（候选 ${entry.candidateCount}，过滤掉 ${entry.rejected.length} 个组件行）`)
        if (entry.keywords.length > 0) lines.push(`  ${entry.keywords.join(' | ')}`)
        if (entry.rejected.length > 0) lines.push(`  过滤掉: ${entry.rejected.slice(0, 8).join(' | ')}`)
        for (const problem of entry.problems) lines.push(`  ⚠️ ${problem.code}: ${problem.detail}`)
      }

      if (dryRun) {
        lines.push('', 'dryRun：以上关键词未写库。去掉 dryRun 再调用即可写入。')
        return lines.join('\n')
      }

      let written = 0
      const failed = []
      for (const entry of result.keywords) {
        try {
          upsertKeyword(store, { keyword: entry.keyword, marketplace, sourceId: 'browser-local' })
          written += 1
        } catch (error) {
          failed.push(`${entry.keyword}: ${error.message}`)
        }
      }

      lines.push('', `写库: ${written} 条${failed.length > 0 ? `，失败 ${failed.length}` : ''}`)
      lines.push('下一步: 用 amzn_keyword_scan 测这些词在目标 ASIN 上的覆盖与排名。')
      return lines.join('\n')
    },
  }
}

/**
 * Seeds → one ranked candidate list, from three sources that measure three
 * different things.
 *
 * This is the tool the research page calls. It exists because research used to
 * live in the conversation: you typed seeds at the agent, the agent ran
 * `amzn_keyword_discover`, and the answer scrolled away. The page needs the same
 * answer in a shape it can render and tick, so the merge lives in
 * `domain/keywords/research.js` and this is the adapter.
 *
 * ## It never writes to the library
 *
 * Candidates are candidates. Nothing here adds a keyword; the user ticks the
 * ones they want and `amzn_keyword_import` writes them (ARCHITECTURE §4.6 fixes
 * that split — the page's "勾选入库" button generates an import prompt). A
 * research call that silently grew the library would make the checkbox
 * decorative.
 *
 * ## `dryRun` means "do not collect", not "do not write"
 *
 * The name is inherited from the tool list, and in every other tool it means
 * "report without writing". Here there is nothing to write, so the useful
 * reading is the other expensive thing this call does: driving a real browser,
 * which costs seconds per seed. `dryRun: true` answers from the library and the
 * competitor facts alone. Because that is not what `dryRun` means elsewhere, the
 * parameter description says so in full rather than relying on the convention.
 */
export function keywordResearchTool({ store, collector, workbench }) {
  return {
    name: 'amzn_keyword_research',
    description:
      'Turn seed words into a ranked list of candidate keywords to consider adding to the library, merging three sources: '
      + 'Amazon search suggestions (a real browser, one storefront), words already in our library, and words a competitor '
      + 'ranks for. '
      + 'Candidates come back in three buckets, which is the actual answer: "gap" (not in our library and a competitor '
      + 'ranks for it — act on it), "fresh" (not in our library, no competitor rank), and "known" (already in our library). '
      + 'This tool is READ-ONLY: it does not add anything to the library. Tick the candidates you want and pass them to '
      + 'amzn_keyword_import. '
      + 'The competitor source reads kw_competitor_fact only and never collects — if there is no competitor data, the '
      + 'candidate says so instead of reporting 0. '
      + 'dryRun: true skips the browser entirely and answers from the library and competitor facts, which is fast and is '
      + 'the way to see what is already known before spending seconds per seed. '
      + `At most ${DISCOVERY_SEED_MAX} seeds per call.`,
    parameters: {
      type: 'object',
      properties: {
        seeds: {
          type: 'array',
          items: { type: 'string' },
          description: `Seed words, e.g. the core terms of a product line. Max ${DISCOVERY_SEED_MAX}.`,
        },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        limit: { type: 'number', description: 'Maximum candidates returned. Default 200, capped at 2000.' },
        dryRun: {
          type: 'boolean',
          description: 'Skip the browser and answer from the library and competitor facts only. Default false. '
            + 'This does NOT control writing — the tool never writes.',
        },
      },
      required: ['seeds'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const seeds = [...new Set(
        (Array.isArray(args?.seeds) ? args.seeds : []).map(seed => String(seed ?? '').trim()).filter(seed => seed !== ''),
      )]
      if (seeds.length === 0) return { ok: false, error: 'seeds 为空', hint: '至少给一个种子词。' }
      /* The cap is the browser's, and it is one rule rather than a conditional
         one: allowing 30 seeds in dryRun and 8 otherwise would mean the same
         call succeeds or fails depending on a flag that is documented as being
         about speed. Reported, not silently sliced — `discoverKeywords` throws
         for the same reason. */
      if (seeds.length > DISCOVERY_SEED_MAX) {
        return {
          ok: false,
          error: `种子太多: ${seeds.length} > ${DISCOVERY_SEED_MAX}`,
          hint: `一次最多 ${DISCOVERY_SEED_MAX} 个种子，拆成几次调用。`,
        }
      }

      const marketplace = String(args?.marketplace ?? 'US').trim().toUpperCase()
      const dryRun = args?.dryRun === true
      const cap = Math.min(Math.max(Math.trunc(Number(args?.limit ?? 200)) || 200, 1), 2000)

      const notes = []
      let suggest = []

      if (dryRun) {
        notes.push(`dryRun: 未驱动浏览器，只查库内与竞品事实。`)
      } else if (collector === undefined || collector === null) {
        notes.push('⚠️ 没有可用的浏览器采集器，本次没有取搜索建议，只查了库内与竞品事实。')
      } else {
        const discovery = await discoverKeywordsForTool({
          collector, marketplace, seeds, limit: undefined, workbench,
        })
        suggest = (discovery.perSeed ?? []).flatMap(entry =>
          (entry.keywords ?? []).map(keyword => ({ seed: entry.seed, keyword })))
        notes.push(
          `搜索建议: ${suggest.length} 条（站点 ${marketplace}，${discovery.storefront.domain}，耗时 ${(discovery.durationMs / 1000).toFixed(1)} 秒）`,
        )
        for (const problem of discovery.storefrontProblems ?? []) {
          notes.push(`⚠️ 站点问题 ${problem.code}: ${problem.detail}`)
        }
        for (const entry of discovery.perSeed ?? []) {
          for (const problem of entry.problems ?? []) {
            notes.push(`⚠️ 「${entry.seed}」 ${problem.code}: ${problem.detail}`)
          }
        }
      }

      /* One read per seed, per source, so every row is tagged with the seed that
         matched it. A batch read would be one query instead of sixteen, but it
         could not say which pattern matched, and the tool reports per-seed
         results ("this seed found nothing") that would then be wrong. Sixteen
         queries against local SQLite is not a cost worth a wrong answer. */
      const library = seeds.flatMap(seed =>
        readResearchLibrary(store, { marketplace, seed, limit: cap * 2 }))
      const competitor = seeds.flatMap(seed =>
        readResearchCompetitor(store, { marketplace, seed, limit: cap * 2 }))

      /* Membership is an exact lookup over every keyword the three sources
         produced — not over the seed substrings. A candidate that arrived from
         the dropdown is normally not a substring match for its own seed, so
         deriving `in_library` from the library *source* would call a word we
         already track `fresh` and offer it for re-import. */
      const merged = { seeds, marketplace, suggest, library, competitor }
      const inLibrary = readLibraryMembership(store, {
        marketplace,
        keywords: collectCandidateKeywords(merged),
      })

      const research = buildResearchCandidates({ ...merged, inLibrary }, { limit: cap })

      workbench?.record('research:candidates', {
        seeds: seeds.length,
        marketplace,
        dryRun,
        total: research.counts.total,
        gap: research.counts.gap,
      }, 'plugin')

      return renderResearch({ research, notes, dryRun })
    },
  }
}

/* ──────────────────────────── research rendering ──────────────────────────── */

const RESEARCH_COLUMNS = [
  { label: '关键词', value: row => truncate(row.keyword, 38) },
  { label: '分档', value: row => row.bucket },
  { label: '来源', value: row => row.sources.join('+') },
  { label: '搜索量', value: row => num(row.search_volume) },
  { label: '竞品排名', value: row => num(row.competitor_best_rank) },
  { label: '库内', value: row => (row.in_library ? (row.library_tier ?? '是') : '') },
]

const BUCKET_TITLES = {
  gap: '竞品有、我们库里没有（可行动）',
  fresh: '扩词候选（库里没有，也没有竞品排名）',
  known: '库里已有（无需导入）',
}

function renderResearch({ research, notes, dryRun }) {
  const lines = [
    `种子 ${research.seeds.length} 个（${research.marketplace}）: ${research.seeds.join(', ')}`,
    `候选 ${research.counts.total} 条`
    + `（可行动 ${research.counts.gap} / 扩词 ${research.counts.fresh} / 库里已有 ${research.counts.known}）`,
    `输入行数: 搜索建议 ${research.inputRows.suggest}、库内 ${research.inputRows.library}、竞品 ${research.inputRows.competitor}`,
  ]
  if (notes.length > 0) lines.push('', ...notes)

  if (research.barrenSeeds.length > 0) {
    // A seed that produced nothing is a result. Without this line a user who
    // typed a seed and saw it missing from the list cannot tell "no suggestions
    // for that word" from "the button is broken".
    lines.push(
      '',
      `⚠️ 这些种子没有产生任何候选: ${research.barrenSeeds.join('、')}`,
      '   （该词可能确实没有搜索建议，也不在库内、没有竞品数据；换个更宽泛的种子再试。）',
    )
  }

  for (const bucket of RESEARCH_BUCKETS) {
    const rows = research.candidates.filter(row => row.bucket === bucket)
    lines.push('', `── ${BUCKET_TITLES[bucket]}：${research.counts[bucket]} 条 ──`)
    /* 2026-10-25（R-59）：原来这里直接印「（无）」，而表头那一行会写
         `候选 206 条（可行动 190 / 扩词 0 / 库里已有 16）`
       实测（limit 20 与 limit 100 两次都一样）：
         ── 库里已有（无需导入）：16 条 ──
         （无）

       —— **`counts.known` 与 `candidates` 里 bucket='known' 的行数不是同一个数**：
       前者是「库内有多少个词」，后者是「其中有几条进入了候选」。
       两个数并排，读者只能得出「16 条却一条都没列出来」。

       这里不改两个数的口径（它们各自有意义），而是**当这一档为空时把差说清** ——
       空一行「（无）」是读者最没法处理的输出，因为它不解释为什么。 */
    if (rows.length === 0) {
      lines.push(research.counts[bucket] > 0
        ? `（无）—— 这一档的 ${research.counts[bucket]} 条不单独列出：它们要么是他档的重复，要么只是「库内有这个词」这个事实本身。`
        : '（无）')
      continue
    }
    lines.push(table(rows, RESEARCH_COLUMNS))
    for (const row of rows.slice(0, 3)) lines.push(`  ${row.keyword} — ${row.reason}`)
  }

  const noVolume = research.candidates.filter(row => row.no_volume).length
  if (noVolume > 0) {
    lines.push('', `⚠️ ${noVolume} 条候选没有任何来源的搜索量，搜索量为空而不是 0。`)
  }
  if (research.truncated) {
    lines.push(`⚠️ 候选超过上限，只显示了前 ${research.candidates.length} 条（共 ${research.counts.total} 条）。`)
  }

  if (dryRun) lines.push('', '本次为 dryRun：没有驱动浏览器。')
  lines.push('', '下一步: 勾选要的词 → amzn_keyword_import 入库。本工具不会自己写库。')

  return lines.join('\n')
}

export function keywordScanTool({ keywordService, store }) {
  return {
    name: 'amzn_keyword_scan',
    description:
      'Submit a keyword coverage scan: walk the real search result pages for each keyword and record where our ASINs '
      + 'rank organically. Returns a task id immediately — the scan takes minutes, so do not wait; call '
      + 'amzn_collect_status with the task id later. '
      + 'Only organic placements are recorded (Amazon\'s paid blocks are a different component type), and a page that '
      + 'did not render results produces no verdict at all, because "no results" and "not ranking" must not be confused. '
      + 'By default it measures every ASIN we track on the marketplace.',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: `Keywords to scan. Max ${SCAN_KEYWORD_MAX}.`,
        },
        marketplace: { type: 'string', description: 'Marketplace code. Default US.' },
        asins: {
          type: 'array',
          items: { type: 'string' },
          description: 'ASINs to look for. Omit to measure every ASIN tracked on this marketplace.',
        },
        pages: { type: 'number', description: 'Result pages per keyword, 1–20. Default 1. Each page holds 16 results, so pages=3 means "top 48".' },
        strictStorefront: { type: 'boolean', description: 'Refuse to store a verdict from a page whose storefront does not match. Default true.' },
      },
      required: ['keywords'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      if (keywordService === undefined || keywordService === null) {
        return { ok: false, error: '关键词扫描服务未启用（需要浏览器采集器）。' }
      }
      const submitted = keywordService.submit({
        marketplace: args?.marketplace ?? 'US',
        keywords: args?.keywords,
        asins: args?.asins ?? null,
        pages: args?.pages ?? 1,
        options: { strictStorefront: args?.strictStorefront !== false },
      })

      const inLibrary = store.get(
        `SELECT COUNT(*) AS n FROM keyword WHERE marketplace = ? AND keyword IN (${submitted.keywords.map(() => '?').join(',')})`,
        [submitted.marketplace, ...submitted.keywords],
      )?.n ?? 0

      return [
        `关键词覆盖扫描已提交: task ${submitted.taskId}`,
        `站点 ${submitted.marketplace}，关键词 ${submitted.keywords.length} 条（其中 ${inLibrary} 条已在词库），测量 ASIN ${submitted.asins.length} 个，每个词扫 ${submitted.pages} 页（前 ${submitted.pages * RESULTS_PER_PAGE} 条自然结果）`,
        `预计 ${submitted.estimatedMinutes} 分钟。**不要等** —— 用 amzn_collect_status 查 ${submitted.taskId}。`,
        submitted.keywords.length > 0 ? `关键词: ${submitted.keywords.slice(0, 12).join(' | ')}${submitted.keywords.length > 12 ? ` … 共 ${submitted.keywords.length}` : ''}` : '',
      ].filter(Boolean).join('\n')
    },
  }
}

/**
 * Discovery, with the browser mechanics left in `sources/keyword.js`.
 *
 * That module owns how a seed becomes suggestions; deciding what to do with the
 * result is a tool's job. Keeping the split means the mechanics can be tested
 * without a store, and this stays a thin adapter.
 */
async function discoverKeywordsForTool({ collector, marketplace, seeds, limit, workbench }) {
  return discoverKeywords({
    collector,
    marketplace,
    seeds,
    limit: limit ?? undefined,
    onProgress: event => workbench?.record('keyword:discover', event, 'plugin'),
  })
}
