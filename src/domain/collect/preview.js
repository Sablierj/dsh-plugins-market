/**
 * The pre-submission preview (module 04 F04-03; contract §6.2.3, §4.4).
 *
 * ## Read-only, and 500 ms, and no browser
 *
 * This is the form's instant feedback, not a collection. It does one store read
 * for the reuse check and one for the site's recent blocks, and it touches no
 * browser at all — a preview that quietly launched Chrome would turn filling in
 * a form into a scraped request. There is no `await` in the main path for the
 * same reason: nothing here can be waiting on a machine that is not there.
 *
 * ## The six answers, and why they are exactly six
 *
 * §4.4's six: valid counts, duplicates, unresolved ownership, the request
 * estimate, the risk, and what can be reused. They are computed **here and only
 * here** — `amzn_collect_run` calls this same function before it writes, so the
 * numbers a person approved are the numbers the run acts on. A second
 * implementation behind the submit button is how a preview becomes decoration.
 *
 * ## Two refusals that would otherwise be discovered late
 *
 * The source and the requested fields are checked here with the **same**
 * functions the submission path uses (`domain/collect/targets.js`), because
 * "this channel cannot provide `keywords`" is a fact the form can know before
 * anything is written, and finding it out afterwards costs a task row that can
 * never succeed.
 */

import { COLLECTION_SECTIONS, LOGIN_REQUIRED_SECTIONS, loginRequiredSectionCount } from './sections.js'
import {
  estimateRequests, fieldSelectionProblem, isValidAsin, normalizeTargets, targetsFromArgs,
} from './targets.js'
import { siteCooldown } from './env.js'
import { resolveOwnershipTier, ownershipEvidenceOf, sideSplitOf, unresolvedOf } from '../ownership/priority.js'
import { listSchemes, getSchemeVersion, currentSchemeVersion } from '../../store/collection-scheme.js'
import { getSetting } from '../../store/settings.js'

/** Contract §6.2.3 default: reuse a snapshot younger than this many days. */
export const PREVIEW_FRESHNESS_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1_000

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function safeParse(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback
  try {
    const value = JSON.parse(text)
    return value === null || value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/** `reuseFreshSnapshots` defaults to **true**, and `false` means false. */
function reuseWanted(args) {
  return args?.reuseFreshSnapshots === undefined || args?.reuseFreshSnapshots === null
    ? true
    : args.reuseFreshSnapshots !== false
}

function freshnessDaysOf(args) {
  const value = Number(args?.freshnessDays)
  return Number.isFinite(value) && value >= 0 ? value : PREVIEW_FRESHNESS_DAYS
}

/** Repeated coordinates in the raw input, with how many times each appeared. */
function duplicatesOf(rawTargets) {
  const counts = new Map()
  for (const target of rawTargets) {
    if (!isValidAsin(target.asin)) continue
    const key = `${target.asin}|${target.marketplace}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, occurrences]) => occurrences > 1)
    .map(([key, occurrences]) => {
      const [asin, marketplace] = key.split('|')
      return { asin, marketplace, occurrences }
    })
}

/** The newest snapshot per target, when it is young enough to reuse. */
function reuseOf(store, targets, { days, now }) {
  const asins = []
  for (const target of targets) {
    const row = store.get(
      `SELECT id, collected_at FROM asin_snapshot
        WHERE asin = ? AND marketplace = ?
        ORDER BY collected_at DESC, id DESC LIMIT 1`,
      [target.asin, target.marketplace],
    )
    if (row === undefined) continue
    const collectedAt = row.collected_at
    const ageDays = (new Date(now).getTime() - new Date(collectedAt).getTime()) / DAY_MS
    if (!Number.isFinite(ageDays) || ageDays > days) continue
    asins.push({
      asin: target.asin,
      marketplace: target.marketplace,
      snapshotId: row.id,
      collectedAt,
      ageDays: Math.round(ageDays * 10) / 10,
    })
  }
  return { count: asins.length, asins }
}

/** How many tasks for this marketplace were blocked in the last 24 hours. */
function recentBlocks(store, marketplace, now) {
  const since = new Date(new Date(now).getTime() - DAY_MS).toISOString()
  const rows = store.all(
    `SELECT targets_json, risk_json, submitted_at FROM collection_task
      WHERE risk_json IS NOT NULL AND submitted_at >= ?
      ORDER BY submitted_at DESC LIMIT 100`,
    [since],
  )
  return rows.filter(row => {
    const targets = safeParse(row.targets_json, [])
    return Array.isArray(targets)
      && targets.some(target => String(target?.marketplace ?? 'US').trim().toUpperCase() === marketplace)
  }).length
}

/**
 * The risk line, with its reasons.
 *
 * Every contribution carries the sentence that produced it, because "medium" on
 * its own is a colour: the operator needs to know it is medium *because* the
 * site was blocked twice today, and that is what lets them decide to wait.
 */
function riskOf({ store, marketplace, sections, targets, now }) {
  const reasons = []
  let level = 'low'
  const raise = (next, reason) => {
    reasons.push(reason)
    const rank = { low: 0, medium: 1, high: 2 }
    if (rank[next] > rank[level]) level = next
  }

  const cooldown = siteCooldown(store, marketplace, now)
  if (cooldown.active) raise('high', `该站点处于冷却中（至 ${cooldown.until}）`)

  const blocks = recentBlocks(store, marketplace, now)
  if (blocks > 0) raise(blocks > 1 ? 'high' : 'medium', `该站点 24h 内有 ${blocks} 次风控拦截`)

  const loginSections = sections.filter(section => LOGIN_REQUIRED_SECTIONS.includes(section))
  if (loginSections.length > 0) {
    raise('medium', `含需要登录态的节：${loginSections.join(' / ')}（未登录时会记 blocked）`)
  }

  const marketplaces = [...new Set(targets.map(target => target.marketplace))]
  if (marketplaces.length > 1) raise('medium', `本次混了 ${marketplaces.length} 个站点，每个目标都要切站点`)

  if (targets.length > 10) raise('medium', `单次目标 ${targets.length} 个，采集会持续较久`)

  return { level, reasons }
}

/** Which scheme version the run would freeze. */
function schemeOf(store, { schemeId, schemeVersion }) {
  const id = blankToNull(schemeId)
  if (id === null) {
    const active = listSchemes(store, { status: 'active' })
    return active.length === 0 ? null : active[0]
  }
  const version = schemeVersion === undefined || schemeVersion === null ? null : Math.trunc(Number(schemeVersion))
  const row = version === null ? currentSchemeVersion(store, id) : getSchemeVersion(store, id, version)
  if (row === null) {
    return {
      error: {
        ok: false,
        code: 'SCHEME_VERSION_UNKNOWN',
        error: `collection_scheme ${id}${version === null ? '' : ` v${version}`} does not exist`,
        hint: '用 amzn_collect_scheme_list 看有哪些版本',
      },
    }
  }
  if (row.status !== 'active') {
    return {
      error: {
        ok: false,
        code: 'SCHEME_NOT_SELECTABLE',
        status: row.status,
        error: `方案 ${id} v${row.version} 是 ${row.status}，不能选（只有 active 能选）`,
        hint: '先 verify 转 active，或选另一份',
      },
    }
  }
  return row
}

/**
 * Everything the form and the submit button need to agree on.
 *
 * Returns `{ok:false, code, …}` for a refusal rather than throwing: this runs
 * inside a tool and a route, and both would rather hand back a code than fail
 * the turn (contract §6.1).
 */
export function previewCollection({ store, sources, args = {}, now = new Date() } = {}) {
  const rawTargets = targetsFromArgs(args)
  const invalid = rawTargets.filter(target => !isValidAsin(target.asin))
  if (invalid.length > 0) {
    return {
      ok: false,
      code: 'INVALID_ASIN',
      error: `invalid ASIN(s): ${invalid.map(target => `"${target.asin}"`).join(', ')}`,
      hint: 'ASIN 是 10 位字母数字；改完再来一次，一个都不入队',
      invalid: invalid.map(target => ({ asin: target.asin, marketplace: target.marketplace })),
    }
  }
  const targets = normalizeTargets(rawTargets)

  const chosen = blankToNull(args.source) ?? String(getSetting(store, 'collect.defaultSource') ?? 'browser-local')
  const adapter = sources?.get?.(chosen) ?? null
  if (adapter === null) {
    return {
      ok: false,
      code: 'SOURCE_UNKNOWN',
      error: `unknown source "${chosen}"`,
      hint: `用 amzn_source_list 看有哪些通道`,
    }
  }
  if (adapter.collectible === false) {
    return {
      ok: false,
      code: 'SOURCE_NOT_COLLECTIBLE',
      error: `source "${chosen}" 不是采集通道：${adapter.statusNote ?? ''}`,
      hint: '换一个采集通道（如 browser-local）',
    }
  }
  if (adapter.status !== 'ready') {
    return {
      ok: false,
      code: 'SOURCE_NOT_COLLECTIBLE',
      status: adapter.status,
      error: `source "${chosen}" 还没接通：${adapter.statusNote ?? ''}`,
      hint: '换一个已接通的通道',
    }
  }

  const supported = adapter.capabilities?.().fields ?? []
  const fields = fieldSelectionProblem(args.fields, supported, { sourceId: chosen })
  if (fields.code !== null) {
    return { ok: false, code: fields.code, error: fields.error, hint: `该通道可采字段：${supported.join(', ')}` }
  }

  const scheme = schemeOf(store, { schemeId: args.schemeId, schemeVersion: args.schemeVersion })
  if (scheme !== null && scheme.error !== undefined) return scheme.error

  /* The sections this run would ask for: the scheme's list when there is one,
     otherwise all thirteen. A scheme with an empty section list is a deliberate
     "collect nothing" and is honoured — the preview says `sections: 0` rather
     than quietly substituting the default. */
  const sections = scheme === null ? COLLECTION_SECTIONS.map(section => section.id) : scheme.sections

  const resolutions = targets.map(target => resolveOwnershipTier(store, {
    asin: target.asin,
    marketplace: target.marketplace,
    declaredSide: target.side,
  }))
  const sideSplit = sideSplitOf(resolutions)

  const marketplace = blankToNull(args.marketplace) === null
    ? (targets[0]?.marketplace ?? 'US')
    : String(args.marketplace).trim().toUpperCase()

  const reuse = reuseWanted(args)
    ? reuseOf(store, targets, { days: freshnessDaysOf(args), now })
    : { count: 0, asins: [], skipped: true }

  return {
    ok: true,
    source: chosen,
    marketplace,
    targets,
    validAsins: { total: targets.length, self: sideSplit.self.length, competitor: sideSplit.competitor.length },
    duplicates: duplicatesOf(rawTargets),
    unknownOwnership: unresolvedOf(resolutions),
    ownershipEvidence: ownershipEvidenceOf(resolutions),
    sideSplit,
    estimatedRequests: {
      ...estimateRequests(targets.length, { sections }),
      loginRequiredSections: loginRequiredSectionCount(sections),
    },
    risk: riskOf({ store, marketplace, sections, targets, now }),
    reuse,
    scheme: scheme === null ? null : {
      id: scheme.id,
      version: scheme.version,
      name: scheme.name,
      status: scheme.status,
      verifiedAt: scheme.verifiedAt,
    },
    sections,
    fields: fields.wanted,
    /* Declared assumptions, so the page can print them instead of the reader
       mistaking them for measured facts. */
    notes: [
      `需要登录的节按当前假设统计：${LOGIN_REQUIRED_SECTIONS.join(' / ')}（需求未给节级清单，见契约 §9-O3）`,
    ],
  }
}
