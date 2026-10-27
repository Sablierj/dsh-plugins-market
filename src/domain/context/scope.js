/**
 * The five-level workbench context, and the identity derived from it.
 *
 * The page has always had a *selection* (which ASINs are ticked). It has never
 * had a **scope**: which workspace, which site, which shop, which brand, which
 * product line the user is looking at. That gap is why every panel quietly
 * assumed "everything in the database" — a number on the ASIN tab meant the
 * whole store, and switching site did not narrow it.
 *
 * Five levels, and only one of them is required:
 *
 *   workspace > marketplace > shop > brand > product line
 *
 * `marketplace` is **required** because a marketplace is part of every product
 * key in this store (see `store/schema.js`) — an absent site would not be a
 * wider scope, it would be an unanswerable question. The other four may be
 * `SCOPE_ALL`, which is a value, not an absence: `null` would mean "nobody has
 * chosen yet", and a scope bar that cannot tell "all shops" from "no shop
 * chosen" is a scope bar that lies about what the numbers below it cover.
 *
 * ## `contextId` — why a hash and not a counter
 *
 * The same scope has to produce the same id **in a different process**, because
 * a draft saved yesterday must be comparable with the scope selected today. A
 * counter or a timestamp would both be "stable" within one run and meaningless
 * across a restart. So the id is a digest of the *canonical* scope, which makes
 * it reproducible from the scope alone, with nothing to persist and no ordering
 * to get wrong.
 */

import { createHash } from 'node:crypto'

import { DEFAULT_MARKETPLACE } from '../rules/marketplaces.js'

/** The five levels, in the order they narrow. Used by the page and the tools. */
export const SCOPE_LEVELS = ['workspace', 'marketplace', 'shop', 'brand', 'productLine']

/** The explicit "everything at this level" value. Not `null` — see the header. */
export const SCOPE_ALL = '__all__'

/**
 * The workspace every existing row belongs to. v20 seeds exactly this one row,
 * and the migration's backfill points at it, so the constant is stated here
 * rather than spelled out at each call site.
 */
export const DEFAULT_WORKSPACE_ID = 'ws-default'

/** Trim and stringify, or `''` for anything absent. */
function norm(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/**
 * An optional level: a real id, or `SCOPE_ALL` when nothing was chosen.
 *
 * An empty string is `SCOPE_ALL`, not an id — a shop whose id is the empty
 * string does not exist, and treating one as a shop would put an unreachable
 * value into `context_id`.
 */
function normLevel(value) {
  const trimmed = norm(value)
  return trimmed === '' ? SCOPE_ALL : trimmed
}

/**
 * Canonicalise a scope.
 *
 * Every reader goes through this, so `{marketplace:'us'}` and
 * `{marketplace:' US '}` are one scope rather than two that produce different
 * ids and therefore two different "contexts" for the same screen.
 *
 * An absent marketplace becomes `DEFAULT_MARKETPLACE`, matching what the rest
 * of the plugin already does with a missing site (the ASIN selection, the
 * collection targets). It is a stated default, not a guess: `profileFor` makes
 * the same choice for an unknown code.
 */
/**
 * A marketplace code, canonicalised.
 *
 * `SCOPE_ALL` is a **sentinel, not a site code**, and upper-casing it would turn
 * `__all__` into `__ALL__` — after which every `=== SCOPE_ALL` comparison in the
 * plugin fails silently and a scope that meant "every site" filters for a site
 * named `__ALL__`, which matches nothing. That is exactly the kind of failure
 * this module exists to prevent, so the sentinel is checked before the fold.
 */
function canonicalMarketplace(value) {
  if (value === '') return DEFAULT_MARKETPLACE
  return value.toLowerCase() === SCOPE_ALL ? SCOPE_ALL : value.toUpperCase()
}

export function normalizeScope(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    workspaceId: norm(source.workspaceId) || DEFAULT_WORKSPACE_ID,
    marketplace: canonicalMarketplace(norm(source.marketplace)),
    shopId: normLevel(source.shopId),
    brandId: normLevel(source.brandId),
    productLineId: normLevel(source.productLineId),
  }
}

/**
 * The workspace the scope bar is showing, read off a workbench.
 *
 * This is the **second** id every configuration gate needs, and the reason every
 * call site passes two: a write has two real targets. One is the workspace the
 * row *lands in*, resolved the way that row's own writer resolves it; the other
 * is the workspace the caller is *looking at* — a page's scope bar, an agent
 * session's workbench. "Archived means read-only" has to hold for the second as
 * well, or a session parked in an archived workspace could still edit the
 * default one's settings and the archive would be a label rather than a rule.
 *
 * A caller with no workbench — a tool built without one — answers `undefined`,
 * which `assertWorkspaceWritable` reads as the default workspace. An absent
 * dimension is deliberately **not** a wildcard; it is the space a writer that
 * never learned the dimension puts its row in.
 */
export function scopeWorkspaceIdOf(workbench) {
  const state = typeof workbench?.get === 'function' ? workbench.get() : undefined
  return state?.scope?.workspaceId
}

/**
 * The stable id of a scope: the first 16 hex characters of the sha256 of its
 * canonical JSON.
 *
 * 64 bits is enough for this — the value is compared for equality within one
 * installation, never used as a secret, and a collision would need two scopes
 * that a person typed deliberately. The full digest would be 64 characters of
 * noise in every tool result and every audit row.
 */
export function contextIdFor(scope) {
  const canonical = JSON.stringify(normalizeScope(scope))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** Whether two scopes are the same scope, after canonicalisation. */
export function scopeEquals(a, b) {
  return JSON.stringify(normalizeScope(a)) === JSON.stringify(normalizeScope(b))
}

/** `SCOPE_ALL` reads as a word, an id reads as itself. */
function label(level) {
  return level === SCOPE_ALL ? '全部' : level
}

/**
 * One line describing a scope, for the page's bar and for the tool that tells
 * the agent what the user is looking at.
 *
 * **Both readers call this one function**, which is the point: the page saying
 * `US / ROFIEJX / bench-cushion —— 已选 3 ASIN · 1 竞品组` while the agent is told
 * something slightly different is exactly the drift that makes a user stop
 * trusting the bar.
 *
 * The brand level is printed only when it is narrower than "全部". The design's
 * format names market / shop / product line, and a fourth segment that always
 * said `全部` would be noise on every line; a brand that *is* chosen, on the
 * other hand, changes what the numbers cover, so dropping it would be a lie of
 * omission.
 *
 * `extras` carries the selection counts. When it is omitted the base form is
 * returned, which is what a caller with no selection to describe wants.
 */
export function describeScope(scope, extras) {
  const s = normalizeScope(scope)
  const parts = [label(s.marketplace), label(s.shopId)]
  if (s.brandId !== SCOPE_ALL) parts.push(label(s.brandId))
  parts.push(label(s.productLineId))
  let text = parts.join(' / ')
  if (extras !== undefined && extras !== null) {
    const asins = Number.isFinite(Number(extras.asins)) ? Math.trunc(Number(extras.asins)) : 0
    const sets = Number.isFinite(Number(extras.competitorSets)) ? Math.trunc(Number(extras.competitorSets)) : 0
    /* 分隔符是「 —— 」而不是又一个「 / 」：这两个数是**选中**的数量，不是作用域里有多少条。
       接在「站点 / 店铺 / 产品线」后面用同一种分隔符，读者会把它读成第四级作用域 ——
       实测就是这么读错的：ASIN 页表里有 14 行，而这一格写着「0 ASIN」（一个都没选），
       看起来像「这个库是空的」。把话说全：已选 N。 */
    text += ` —— 已选 ${asins} ASIN · ${sets} 竞品组`
  }
  return text
}
