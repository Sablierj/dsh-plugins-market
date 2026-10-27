/**
 * Workbench state: the bridge between the page and the conversation.
 *
 * This is the piece that makes "select an ASIN on the page, then say 'optimise
 * this one' in the chat" work. It holds the current selection in process memory
 * — deliberately not in the database, because it is per-session UI state and
 * worthless after a restart — and it is read by the `amzn_workbench_context`
 * tool.
 *
 * It also carries an event log in the other direction. Because every tool this
 * plugin registers goes through the same module, the workbench is a natural
 * record of what the agent did, without reading DSH's session store.
 */

import { nowIso } from '../store/db.js'
import { contextIdFor, describeScope, normalizeScope, scopeEquals } from '../domain/context/scope.js'

/**
 * Modules the workbench can be showing, grouped by data-flow stage. Group
 * order is the sidebar order; module order inside a group is the tab order.
 *
 * The grouping is navigation only — a module id means exactly what it always
 * meant, so `MODULE_IDS` below and every `set()` / `buildState()` check keep
 * working unchanged.
 *
 * Phase 1 adds one group and moves nothing else. `foundation` carries the three
 * pages that are about the workspace itself rather than about one dataset
 * (01 工作台首页 / 02 设置中心 / 03 数据资产与质量), and `settings` moves into it
 * **keeping its id, its label and its sections** — a module id is a key in
 * `set()` and in `buildState()`, so re-typing one is a whole-store regression
 * wearing a navigation change's clothes. The four groups below it are byte for
 * byte what they were.
 */
export const MODULE_GROUPS = [
  { id: 'foundation', label: '工作空间与基础', modules: [
    { id: 'home', label: '工作台首页' },
    /* `settings` is the one module that hosts in-panel sections. `sections` lives
       on the **module**, not on the group, because that is what it actually
       describes: a jump target *inside* this panel (ARCHITECTURE §1.3 — "页内分区，
       不占导航位"). The B01 plan wrote it on the group; the two coincided while
       the settings module was alone in its own group, and putting it here keeps
       the meaning right now that the module shares a group with two others.

       These ids are **not** modules: they never reach `MODULES` (derived from
       `group.modules`), so `MODULE_IDS` does not contain them and
       `set({ module: 'sources' })` is still refused. That is the whole point of
       the two-tier split — a section is a scroll target, not a destination. */
    { id: 'settings', label: '站点与采集配置', sections: [
      { id: 'sources', label: '数据源管理' },
      { id: 'productlines', label: '产品线管理' },
    ] },
    { id: 'quality', label: '数据资产与质量' },
  ] },
  { id: 'data', label: '采集与数据', modules: [
    { id: 'collect', label: '采集器' },
    { id: 'asin', label: 'ASIN 数据管理' },
    { id: 'competitor', label: '竞品数据分析' },
  ] },
  { id: 'keywords', label: '关键词', modules: [
    // Two keyword tabs, and the labels have to keep them apart: `research` is
    // what the browser *measured* (our own rank, T1–T4), `kw` is what files
    // *told us* (search volume, ads, competitors, L1–L5). They share the
    // `keyword` table and nothing else.
    { id: 'kw', label: '关键词总库' },
    { id: 'research', label: '关键词调研' },
    { id: 'pipeline', label: '关键词管道' },
  ] },
  { id: 'compliance', label: '规则与政策', modules: [
    { id: 'rules', label: '规则获取' },
    { id: 'policy', label: '最新政策' },
  ] },
  { id: 'optimize', label: '优化与报告', modules: [
    { id: 'optimize', label: '优化队列' },
    { id: 'report', label: '报告专区' },
    { id: 'prompts', label: '优化提示词专区' },
  ] },
  /* 模块 12 单独成组，而不是塞进上面任何一组。
     一个模块进哪一组是**导航在说它是什么**：agent 编排不是数据、不是关键词、不是
     合规 —— 它在它们**之上**执行。把它放进「关键词」组，就等于声明「这是关键词
     的一个功能」，而它这一版编排的三个角色里有两个确实围着关键词转，第三个（管道
     维护）也围着关键词管道 —— 那反而更容易放错。所以给它一组，名字说明它的位置：
     执行与编排。这一组现在只有一个模块，这是诚实的现状，不是待补的空位。 */
  { id: 'agent', label: '执行与编排', modules: [
    { id: 'agent', label: 'Agent 编排' },
  ] },
]

/**
 * The flat list, derived from the groups so the two cannot drift: a module
 * moved between groups, or dropped from the nav, is dropped here too, and the
 * `MODULE_IDS` set below is built from this derived array rather than typed
 * out a second time.
 */
export const MODULES = MODULE_GROUPS.flatMap(group => group.modules)

/**
 * Page modules that are **not** part of the data-flow roster.
 *
 * P2 adds shop management as a 16th page. It is registered here (and in
 * `NAV_GROUPS`) instead of in `MODULE_GROUPS` so the six data-flow stages —
 * and the tests that pin that roster — keep meaning exactly what they say.
 * Everything routable is `MODULES + EXTRA_MODULES`; `MODULE_IDS` below is the
 * set `set({ module })` accepts, so `shops` is a real destination, not a
 * sidebar decoration.
 */
export const EXTRA_MODULES = [
  { id: 'shops', label: '店铺管理' },
]

/**
 * P1b 旧入口兼容表。旧 module id / 旧组 id 不删除，只在这里映射到仍存在的页面；
 * `keyword` 是唯一被改过名的历史 id（现已叫 `research`）。旧组 id 不是页面，
 * 但旧书签里出现过，所以映射到组内代表页而不是 404。
 */
export const LEGACY_MODULE_ALIASES = {
  keyword: 'research',
  foundation: 'home',
  data: 'asin',
  keywords: 'kw',
  compliance: 'rules',
  optimize: 'optimize',
  agent: 'agent',
}

/**
 * P1a navigation shell: the top-level groups the canonical standard names,
 * for the sidebar only.
 *
 * This is a **second view of the same roster**, not a second roster: every entry
 * is the very object from `MODULE_GROUPS` (or `EXTRA_MODULES`), looked up by id,
 * so a module's label and its in-panel `sections` cannot drift between the two.
 * `MODULE_GROUPS` itself stays byte for byte unchanged — it is the data-flow
 * grouping that `MODULES` / `MODULE_IDS` / `set({ module })` are built on, and
 * re-typing one of those ids is a whole-store regression wearing a navigation
 * change's clothes.
 *
 * `legacy` records the old group(s) whose modules this new group draws from.
 * P1a redirects nothing yet; the field exists so P1b can map an old group name
 * to its new home without inventing the mapping a second time.
 */
export const NAV_GROUPS = (() => {
  const byId = new Map([...MODULES, ...EXTRA_MODULES].map(module => [module.id, module]))
  const group = (id, label, legacy, ids) => ({
    id,
    label,
    legacy,
    modules: ids.map(moduleId => {
      const module = byId.get(moduleId)
      if (module === undefined) throw new Error(`NAV_GROUPS names unknown module "${moduleId}"`)
      return module
    }),
  })
  const groups = [
    group('overview', '总览', ['工作空间与基础'], ['home', 'quality']),
    /* P2 / ADR-004 D1：店铺是营业归属层，独立成组，不塞进「数据」。 */
    group('shops', '店铺', ['店铺'], ['shops']),
    group('data', '数据', ['采集与数据'], ['asin', 'collect', 'competitor']),
    group('keywords', '关键词', ['关键词'], ['kw', 'research', 'pipeline']),
    group('optimize', '优化', ['优化与报告'], ['optimize']),
    group('compliance', '合规', ['规则与政策'], ['rules', 'policy']),
    group('reports', '报告', ['优化与报告'], ['report']),
    group('automation', '自动化与设置', ['执行与编排', '工作空间与基础', '优化与报告'], ['agent', 'prompts', 'settings']),
  ]
  return groups
})()

/**
 * The nav shell must name every module exactly once: a module left out would
 * vanish from the sidebar while `set({ module })` still accepted it — a page
 * that exists and cannot be reached. Checked at import time, not at click time,
 * so a roster edit fails loudly on the next boot.
 */
function assertNavCoverage(groups) {
  const ids = groups.flatMap(entry => entry.modules.map(module => module.id))
  const expected = MODULES.length + EXTRA_MODULES.length
  if (ids.length !== expected || new Set(ids).size !== ids.length) {
    throw new Error('NAV_GROUPS must cover every module exactly once')
  }
}
assertNavCoverage(NAV_GROUPS)

/** Extra page modules must not collide with the data-flow roster. */
function assertExtraModules(modules) {
  const seen = new Set()
  for (const module of modules) {
    if (MODULES.some(entry => entry.id === module.id) || seen.has(module.id)) {
      throw new Error(`EXTRA_MODULES collides on module id "${module.id}"`)
    }
    seen.add(module.id)
  }
}
assertExtraModules(EXTRA_MODULES)

const MODULE_IDS = new Set([...MODULES, ...EXTRA_MODULES].map(module => module.id))
const MAX_EVENTS = 200
const MAX_KEYWORDS = 50
/**
 * Competitor sets are whole ASIN lists, not rows, so the cap is far below the
 * 50 the two row-shaped selections use. A scope naming more than twenty sets is
 * not a scope — it is the whole store with extra steps, and the numbers on the
 * cards above it would stop meaning anything.
 */
const MAX_COMPETITOR_SETS = 20

/**
 * Keywords are held as `{ keyword, marketplace }` — the same shape as the ASIN
 * selection — because the same word ranks differently per site, and a selection
 * that forgot its marketplace cannot be used to check coverage.
 *
 * This used to be `.map(String)`, which turned the page's objects into the
 * literal string `"[object Object]"`: the sidebar chip, the prompt text and
 * `amzn_workbench_context` all showed that instead of the word, and nothing
 * threw. A bare string is still accepted, because the focus tool takes strings;
 * `marketplace` stays null rather than being guessed as US.
 */
function normalizeKeywords(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const entry of list) {
    // An object with no `keyword` is skipped, not stringified — that is the
    // exact path that produced "[object Object]".
    const raw = entry !== null && typeof entry === 'object' ? entry.keyword : entry
    const keyword = String(raw ?? '').trim()
    if (keyword === '') continue
    const marketplace = entry !== null && typeof entry === 'object' && entry.marketplace
      ? String(entry.marketplace).trim().toUpperCase()
      : null
    const key = `${keyword.toLowerCase()}|${marketplace ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ keyword, marketplace })
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

/**
 * Competitor-set ids, normalised the same way the ASIN and keyword selections
 * are: trimmed, de-duplicated, capped. A bare id and `{id}` are both accepted
 * because the focus tool's callers write whichever is shorter.
 */
function normalizeCompetitorSets(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const entry of list) {
    const raw = entry !== null && typeof entry === 'object' ? entry.id : entry
    const id = String(raw ?? '').trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_COMPETITOR_SETS) break
  }
  return out
}

export function createWorkbench() {
  const state = {
    module: 'asin',
    /* The five-level context. It starts at "everything in the default
       workspace, on US", which is what the page showed before scopes existed —
       the change is that the bar now says so out loud instead of leaving the
       reader to assume it. */
    scope: normalizeScope({}),
    contextId: '',
    /* Bumped every time the scope actually changes. A draft records the
       contextId it was written under, and this counter is what the page uses to
       tell "the scope moved" from "the scope was re-sent unchanged" — the two
       look identical in a patch and mean different things. */
    scopeRevision: 0,
    selection: { asins: [], keywords: [], competitorSets: [] },
    filters: {},
    note: null,
    updatedAt: nowIso(),
  }
  state.contextId = contextIdFor(state.scope)

  /** Newest last. Capped, because this is a feed, not a log. */
  const events = []
  const subscribers = new Set()

  const snapshot = () => ({
    module: state.module,
    scope: { ...state.scope },
    contextId: state.contextId,
    scopeRevision: state.scopeRevision,
    /* The bar's text is computed here, on the server, and travels with the
       context. The page cannot import `describeScope` (its script is a template
       literal with no module system), and a second copy of the format written
       into that script is exactly the drift that would make the bar and
       `amzn_workbench_context` describe the same scope differently. */
    scopeText: describeScope(state.scope, {
      asins: state.selection.asins.length,
      competitorSets: state.selection.competitorSets.length,
    }),
    selection: {
      asins: state.selection.asins.map(entry => ({ ...entry })),
      keywords: state.selection.keywords.map(entry => ({ ...entry })),
      competitorSets: [...state.selection.competitorSets],
    },
    filters: { ...state.filters },
    note: state.note,
    updatedAt: state.updatedAt,
  })

  function emit(event) {
    events.push(event)
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    for (const subscriber of subscribers) {
      try {
        subscriber(event)
      } catch {
        // A dead SSE socket must not break the tool call that produced the event.
      }
    }
  }

  return {
    MODULES,

    get: snapshot,

    /** Merge a patch into the context. `selection` is replaced, not merged deep. */
    set(patch = {}, origin = 'page') {
      if (patch.module !== undefined) {
        const next = String(patch.module)
        if (!MODULE_IDS.has(next)) throw new Error(`unknown module "${next}"`)
        state.module = next
      }
      if (patch.scope !== undefined) {
        const next = normalizeScope(patch.scope)
        /* Only a *change* bumps the revision. Re-sending the scope the page
           already had (every `patchContext` carries the whole filter bag, so
           this happens on every click) must not invalidate a draft that is still
           perfectly valid — that would make the accept button flap. */
        if (!scopeEquals(next, state.scope)) state.scopeRevision += 1
        state.scope = next
        state.contextId = contextIdFor(next)
      }
      if (patch.selection !== undefined) {
        const asins = Array.isArray(patch.selection?.asins) ? patch.selection.asins : []
        state.selection = {
          asins: asins
            .filter(entry => entry && entry.asin)
            .map(entry => ({
              asin: String(entry.asin).trim().toUpperCase(),
              marketplace: String(entry.marketplace ?? 'US').trim().toUpperCase(),
            }))
            .slice(0, 50),
          keywords: normalizeKeywords(patch.selection?.keywords),
          /* Unlike the two row-shaped selections, an omitted `competitorSets`
             **keeps** the current value rather than clearing it. Every writer
             sends asins and keywords explicitly (the ASIN table rebuilds the
             whole selection object when you tick a row), so replacing them is
             unambiguous — but those same writers do not know about competitor
             sets, and clearing on omission would mean ticking an ASIN silently
             dropped the sets the user had scoped to. */
          competitorSets: patch.selection?.competitorSets === undefined
            ? state.selection.competitorSets
            : normalizeCompetitorSets(patch.selection.competitorSets),
        }
      }
      if (patch.filters !== undefined) {
        state.filters = patch.filters && typeof patch.filters === 'object' ? { ...patch.filters } : {}
      }
      if (patch.note !== undefined) state.note = patch.note === null ? null : String(patch.note)
      state.updatedAt = nowIso()

      emit({ at: state.updatedAt, kind: 'context', origin, payload: snapshot() })
      return snapshot()
    },

    /**
     * Record something the agent did. `origin` separates agent activity from the
     * user's own clicks so the feed can label them differently.
     */
    record(kind, payload, origin = 'agent') {
      const event = { at: nowIso(), kind, origin, payload }
      emit(event)
      return event
    },

    recent(limit = 30) {
      return events.slice(-clamp(limit, 1, MAX_EVENTS))
    },

    /** Subscribe to events; returns the unsubscribe function. */
    subscribe(handler) {
      subscribers.add(handler)
      return () => subscribers.delete(handler)
    },
  }
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(Math.trunc(n), min), max)
}
