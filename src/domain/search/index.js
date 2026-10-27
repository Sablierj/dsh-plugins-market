/**
 * Global search (F01-06) — one box, and everything the workbench knows about.
 *
 * ## Why the kinds are declared rather than discovered
 *
 * The requirement names ten kinds (ASIN / SKU / 品牌 / 关键词 / 竞品组 / 规则 /
 * 政策 / 提示词 / 任务号 / 报告). The list is written out here, once, and every
 * entry is answered for — either by a `search` function or by `available: false`
 * with a reason. That is the same contract `WRITE_TARGETS` uses for tools and
 * `RECENT_KINDS` uses for the 最近运行 block: a thing that is not searched has to
 * say so, because "we looked and found nothing" and "we never look at that" are
 * different answers and a blank section gives the first one.
 *
 * ## Matching
 *
 * `instr(lower(column), lower(?))`, not `LIKE`. A search box is where a user
 * types `%` and `_` for real — a part number like `A_1234` — and in `LIKE` those
 * are wildcards, so the query silently means something else and returns rows the
 * user did not ask for. `instr` has no metacharacters, which makes the escaping
 * question disappear instead of being answered carefully.
 *
 * ## A broken kind costs one kind
 *
 * Each kind runs in its own try/catch, the same way each health card does. A
 * table that is missing or mid-migration should not take the other nine kinds
 * down with it, and the failure is reported (`failed`) rather than rendered as
 * an empty group — an empty group claims there is no match.
 */

/* F14-01 — 报告类别与标签的唯一来源在 store 里。搜索侧读它，是为了能**说出**哪些
   类别有正文可搜、哪些没有，而不是把「搜了」说得比实际更满。 */
import { REPORT_KIND_TABLE, reportKindSpec } from '../../store/reports.js'

/** How many rows each kind contributes before the page has to scroll. */
const DEFAULT_LIMIT = 8

/**
 * The ten kinds, in the order the results are read.
 *
 * `module` is where a result lives, and it must be a real module id — clicking a
 * result navigates, so an invented id would be refused by `workbench.set`.
 * `select` on a row names what to add to the global context selection; a row
 * without it navigates but selects nothing (a rule is not a thing you scope to).
 */
export const SEARCH_KINDS = [
  {
    id: 'asin',
    label: 'ASIN',
    module: 'asin',
    search(store, term, limit) {
      return store.all(
        `SELECT asin, marketplace, title, brand FROM asin
          WHERE instr(lower(asin), lower(?)) > 0
             OR instr(lower(COALESCE(title, '')), lower(?)) > 0
             OR instr(lower(COALESCE(brand, '')), lower(?)) > 0
          ORDER BY updated_at DESC LIMIT ?`,
        [term, term, term, limit],
      ).map(row => ({
        id: `${row.asin}@${row.marketplace}`,
        title: row.asin,
        subtitle: row.title ?? '（无标题）',
        site: row.marketplace,
        status: row.brand ?? '未标品牌',
        select: { kind: 'asin', asin: row.asin, marketplace: row.marketplace },
      }))
    },
  },
  {
    id: 'sku',
    label: 'SKU',
    /* Not "no rows" — no column. `asin` has never had a SKU, and
       `domain/rules/listing-fields.js` already carries the reason for that in
       its own words: 「上架时人工指定，采集不到」. Searching for one would be
       searching a field this plugin cannot populate from Amazon. */
    available: false,
    reason: 'SKU 是上架时人工指定的，采集不到，库里没有这一列（见 domain/rules/listing-fields.js）',
  },
  {
    id: 'brand',
    label: '品牌',
    module: 'settings',
    search(store, term, limit) {
      return store.all(
        `SELECT id, name, aliases_json, is_own FROM brand
          WHERE instr(lower(name), lower(?)) > 0
             OR instr(lower(COALESCE(aliases_json, '')), lower(?)) > 0
          ORDER BY name LIMIT ?`,
        [term, term, limit],
      ).map(row => ({
        id: row.id,
        title: row.name,
        subtitle: row.aliases_json === null ? '（无别名）' : `别名：${row.aliases_json}`,
        site: '—',
        status: row.is_own === 1 ? '自有' : '竞品',
        select: null,
      }))
    },
  },
  {
    id: 'keyword',
    label: '关键词',
    module: 'kw',
    search(store, term, limit) {
      /* 2026-10-25（R-21，由 T94 的守门抓出来）：原来直接读 `keyword.search_volume`，
         而**那一列 16 行全是 NULL**（`kw_master` 里 13/16 都有量）。
         所以「搜索框按搜索量从高到低排」这条排序**从来没有生效过** ——
         `ORDER BY NULL DESC` 等价于不排序，返回的是库的自然顺序。
         读者不会发现，因为结果看起来「有顺序」，只是那个顺序没意义。

         取值以 `kw_master` 为准，`keyword` 只提供「这个词在不在」和历史 tier。 */
      return store.all(
        `SELECT k.keyword AS keyword, k.marketplace AS marketplace, k.tier AS tier,
                COALESCE(m.search_volume, k.search_volume) AS search_volume
           FROM keyword k
           LEFT JOIN kw_master m
                  ON m.keyword = k.keyword AND m.marketplace = k.marketplace
          WHERE instr(lower(k.keyword), lower(?)) > 0
          ORDER BY COALESCE(m.search_volume, k.search_volume) DESC NULLS LAST LIMIT ?`,
        [term, limit],
      ).map(row => ({
        id: `${row.keyword}@${row.marketplace}`,
        title: row.keyword,
        subtitle: row.search_volume === null ? '（无搜索量）' : `搜索量 ${row.search_volume}`,
        site: row.marketplace,
        status: row.tier ?? '未分层',
        select: { kind: 'keyword', keyword: row.keyword, marketplace: row.marketplace },
      }))
    },
  },
  {
    id: 'competitor_set',
    label: '竞品组',
    module: 'competitor',
    search(store, term, limit) {
      return store.all(
        `SELECT id, name, marketplace, asins_json FROM competitor_set
          WHERE instr(lower(name), lower(?)) > 0
          ORDER BY updated_at DESC LIMIT ?`,
        [term, limit],
      ).map(row => ({
        id: row.id,
        title: row.name,
        subtitle: `${countAsins(row.asins_json)} 个 ASIN`,
        site: row.marketplace,
        status: '竞品组',
        select: { kind: 'competitor_set', id: row.id },
      }))
    },
  },
  {
    id: 'rule',
    label: '规则',
    module: 'rules',
    /* The active roster is what a listing is actually judged by; a rule from a
       retired version is a historical row, not something to click through to. */
    search(store, term, limit) {
      const active = store.get('SELECT version FROM rule_set WHERE is_active = 1')
      if (active === undefined) return []
      return store.all(
        `SELECT rule_id, title, severity FROM rule
          WHERE rule_set_version = ? AND deleted_at IS NULL
            AND (instr(lower(rule_id), lower(?)) > 0 OR instr(lower(title), lower(?)) > 0)
          ORDER BY rule_id LIMIT ?`,
        [active.version, term, term, limit],
      ).map(row => ({
        id: `${row.rule_id}@${active.version}`,
        title: row.rule_id,
        subtitle: row.title,
        site: '—',
        status: row.severity,
        select: null,
      }))
    },
  },
  {
    id: 'policy',
    label: '政策',
    module: 'policy',
    search(store, term, limit) {
      return store.all(
        `SELECT id, title, marketplace, severity_hint, status FROM policy
          WHERE deleted_at IS NULL
            AND (instr(lower(title), lower(?)) > 0 OR instr(lower(COALESCE(body_md, '')), lower(?)) > 0)
          ORDER BY COALESCE(published_at, effective_from) DESC NULLS LAST LIMIT ?`,
        [term, term, limit],
      ).map(row => ({
        id: row.id,
        title: row.title,
        subtitle: row.status === 'active' ? '已生效' : row.status,
        site: row.marketplace ?? '全部站点',
        status: row.severity_hint ?? '未标严重级',
        select: null,
      }))
    },
  },
  {
    id: 'prompt',
    label: '提示词',
    module: 'prompts',
    search(store, term, limit) {
      return store.all(
        `SELECT id, label, scenario, layer, version, enabled FROM prompt
          WHERE instr(lower(label), lower(?)) > 0
             OR instr(lower(COALESCE(body, '')), lower(?)) > 0
          ORDER BY sort_order, label LIMIT ?`,
        [term, term, limit],
      ).map(row => ({
        id: row.id,
        title: row.label,
        subtitle: row.scenario,
        site: row.layer ?? '—',
        status: row.enabled === 1 ? `启用中 v${row.version}` : `已停用 v${row.version}`,
        select: null,
      }))
    },
  },
  {
    id: 'task',
    label: '任务号',
    module: 'collect',
    /* Both things that have a task id: a collection run and a keyword-pipeline
       run. They are one kind here because a user pasting an id does not know
       which table it came from — the row's `status` says which it turned out to
       be. The collection id also rides into `filters.taskId`, which the 采集
       panel reads (S1-B13.1), so the click lands on the row. */
    search(store, term, limit) {
      const jobs = store.all(
        `SELECT id, status, submitted_at FROM collection_task
          WHERE instr(lower(id), lower(?)) > 0
          ORDER BY submitted_at DESC LIMIT ?`,
        [term, limit],
      ).map(row => ({
        id: row.id,
        title: row.id,
        subtitle: `采集任务 · ${shortTime(row.submitted_at)}`,
        site: '—',
        status: row.status,
        filters: { taskId: row.id },
        select: null,
      }))
      const runs = store.all(
        `SELECT id, status, marketplace, started_at FROM kw_pipeline_run
          WHERE instr(lower(id), lower(?)) > 0
          ORDER BY started_at DESC LIMIT ?`,
        [term, limit],
      ).map(row => ({
        id: row.id,
        title: row.id,
        subtitle: `关键词管道 · ${shortTime(row.started_at)}`,
        site: row.marketplace,
        status: row.status,
        filters: { runId: row.id },
        select: null,
      }))
      return [...jobs, ...runs].slice(0, limit)
    },
  },
  {
    id: 'report',
    label: '报告',
    module: 'report',
    /**
     * F14-01 — 正文进搜索。
     *
     * Before this batch the report group searched `title` / `ref_id` / `note` only,
     * so a word that appears in a report's *content* found nothing — and a miss
     * reads as "there is no such report", which is the wrong answer rather than a
     * missing one. Three body locations now, and the query has to be honest about
     * all three because they are genuinely different:
     *
     *   - `report.body` — a **generated** report's own document (the eight kinds).
     *   - `optimization_run.report_html` — the optimization run's HTML, joined on
     *     `ref_id`. **Not copied into the index** (§3.6): the run is the one body.
     *   - a file on disk (`kw-report` / `kw-export`) — **not** searched, because
     *     reading every CSV on every keystroke is a cost this box cannot pay, and
     *     pretending to have searched it would be worse. `bodyNotSearched` below
     *     names those two kinds so the page can say so instead of implying a
     *     complete full-text search.
     *
     * `matchedIn` rides on each row: a hit in the body is a different claim from a
     * hit in the title, and the reader should be able to see which one they got.
     */
    search(store, term, limit) {
      const rows = store.all(
        `SELECT r.id, r.kind, r.title, r.ref_id, r.note, r.created_at,
                r.body, r.tags_json,
                (SELECT instr(lower(COALESCE(o.report_html, '')), lower(?))
                   FROM optimization_run o
                  WHERE o.id = r.ref_id) AS html_hit
           FROM report r
          WHERE instr(lower(COALESCE(r.title, '')), lower(?)) > 0
             OR instr(lower(COALESCE(r.ref_id, '')), lower(?)) > 0
             OR instr(lower(COALESCE(r.note, '')), lower(?)) > 0
             OR instr(lower(COALESCE(r.body, '')), lower(?)) > 0
             OR instr(lower(COALESCE(r.tags_json, '')), lower(?)) > 0
             OR EXISTS (SELECT 1 FROM optimization_run o
                         WHERE o.id = r.ref_id
                           AND instr(lower(COALESCE(o.report_html, '')), lower(?)) > 0)
          ORDER BY r.created_at DESC LIMIT ?`,
        [term, term, term, term, term, term, term, limit],
      )
      const needle = String(term).toLowerCase()
      return rows.map(row => {
        /* Which fields matched. Computed from the row that was read, not from a
           second query: a second query could disagree with the row being shown. */
        const matchedIn = []
        if (String(row.title ?? '').toLowerCase().includes(needle)) matchedIn.push('标题')
        if (String(row.ref_id ?? '').toLowerCase().includes(needle)) matchedIn.push('引用')
        if (String(row.note ?? '').toLowerCase().includes(needle)) matchedIn.push('备注')
        if (String(row.body ?? '').toLowerCase().includes(needle)) matchedIn.push('正文')
        if (String(row.tags_json ?? '').toLowerCase().includes(needle)) matchedIn.push('标签')
        if (Number(row.html_hit ?? 0) > 0) matchedIn.push('正文（优化 HTML）')
        const label = reportKindSpec(row.kind)?.label ?? row.kind
        return {
          id: row.id,
          title: row.title ?? row.id,
          subtitle: `${label} · ${shortTime(row.created_at)}`
            + (matchedIn.length > 0 ? ` · 命中 ${matchedIn.join('/')}` : ''),
          site: row.ref_id ?? '—',
          status: row.kind,
          matchedIn,
          select: null,
        }
      })
    },
  },
]

/**
 * The report kinds whose body is **not** in the store, so the search group can say
 * which ones it did not read instead of implying a complete full-text search.
 *
 * Derived from `REPORT_KIND_TABLE`'s `bodyIn` — one table, so a new kind cannot
 * quietly become "searched" in the prose while nothing reads it.
 */
export const REPORT_BODY_NOT_SEARCHED = REPORT_KIND_TABLE
  .filter(entry => entry.bodyIn === 'file')
  .map(entry => ({ id: entry.id, label: entry.label, reason: `正文是磁盘上的文件（${entry.source}），没有进索引` }))

/** `[{asin}]` → `n`. A malformed blob counts as zero rather than throwing. */
function countAsins(json) {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

/** `2026-10-01T02:00:00Z` → `2026-10-01 02:00`. A date nobody can read is noise. */
function shortTime(value) {
  const text = String(value ?? '')
  return text === '' ? '（无时间）' : text.slice(0, 16).replace('T', ' ')
}

/**
 * Run every kind and group the results.
 *
 * **Every declared kind is returned, including the ones with no rows.** The page
 * draws only the groups that matched, but it needs the counts to say how much was
 * searched — 「10 类里 3 类有结果」 and 「什么都没找到」 are different sentences,
 * and a `groups` array that omitted the misses could not tell them apart.
 */
export function searchAll(store, rawQuery, { limit = DEFAULT_LIMIT } = {}) {
  const query = String(rawQuery ?? '').trim()

  const groups = SEARCH_KINDS.map(kind => ({
    id: kind.id,
    label: kind.label,
    module: kind.module ?? null,
    available: kind.available !== false,
    reason: kind.reason ?? null,
    failed: null,
    rows: [],
  }))
  const byId = new Map(groups.map(group => [group.id, group]))
  const searched = SEARCH_KINDS.filter(kind => kind.available !== false)

  if (query !== '') {
    for (const kind of searched) {
      const group = byId.get(kind.id)
      try {
        /* `module`, `select` and `filters` ride on the row rather than being
           looked up by the click handler: the page's script has no module system
           (it is a template literal), so a second copy of the kind→module map
           written there is exactly the drift that would send a 关键词 result to
           the ASIN panel. The server decides where a row goes; the page obeys. */
        group.rows = kind.search(store, query, limit).map(row => ({
          ...row,
          group: kind.id,
          module: kind.module ?? null,
        }))
      } catch (error) {
        /* One table that is missing or mid-migration costs its own kind. It is
           recorded as a failure, not as an empty group — an empty group is a
           claim that nothing matched. */
        group.failed = error.message
      }
    }
  }

  const matched = groups.filter(group => group.rows.length > 0)
  return {
    query,
    groups,
    /* The page's three sentences, computed here so the page does not re-derive
       them (and so the test can assert the numbers the page prints). */
    matchedKinds: matched.length,
    searchedKinds: searched.length,
    unavailableKinds: groups.filter(group => !group.available).length,
    failedKinds: groups.filter(group => group.failed !== null).length,
    /* F14-01 — 「报告这一组读到了哪些正文、哪两类没有」跟着结果一起给，这样页面不必
       自己拼一句「全文搜索」的承诺。`file` 的两类（总库报告/CSV）正文在磁盘上，没进
       索引：说出来比搜得更少却不说要好。 */
    reportBodyNotSearched: REPORT_BODY_NOT_SEARCHED,
    total: matched.reduce((sum, group) => sum + group.rows.length, 0),
  }
}

/** The kinds that cannot be searched, so a caller can say which and why. */
export function unavailableKinds() {
  return SEARCH_KINDS
    .filter(kind => kind.available === false)
    .map(kind => ({ id: kind.id, label: kind.label, reason: kind.reason }))
}
