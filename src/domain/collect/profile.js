/**
 * The collection side of the settings page: which browser profile the collector
 * drives, on which CDP port, whether that browser is logged in, and where files
 * are imported from.
 *
 * Four things the page has to be able to say, and one it must not:
 *
 *   - **Which profiles exist.** Chrome keeps them as `Default`, `Profile 1`, …
 *     under one user-data directory. The collector drives one of them; the
 *     others are where the user's own sessions live. Discovering them is a
 *     directory read, and a directory that is not there is **not an error** —
 *     Chrome may never have been run on this machine.
 *
 *   - **Which one is configured.** Compared case-insensitively, because Windows
 *     paths are, and a match that failed on case would report a working profile
 *     as missing.
 *
 *   - **Whether the browser is logged in.** This is the one that must not be
 *     guessed. A collection that passed the storefront check — address, locale
 *     and currency all verified against the target site — *is* evidence the
 *     session works, because setting the delivery address is the login-gated
 *     action. A collection rejected for a storefront mismatch is evidence it
 *     does not. Anything else is `unknown`, and the page says "未探测" rather
 *     than drawing a green light nobody earned.
 *
 *   - **Where imports come from.** A default directory plus whatever the user
 *     configured.
 *
 * Credentials are not here and are not read: this module never touches
 * `source.config_json`. The page shows *which* credential fields a source has
 * (`store/settings.js`'s redaction) and never a value.
 */

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getSetting } from '../../store/settings.js'

/** The three login states. `unknown` is a real answer, not a placeholder. */
export const LOGIN_STATES = ['logged_in', 'logged_out', 'unknown']

/**
 * Where Chrome keeps its profiles, per platform.
 *
 * Returned as a list rather than one path: Chrome, Chromium and Edge are all
 * things a user may have, and a machine can have more than one. A root that does
 * not exist simply contributes nothing.
 */
export function chromeProfileRoots({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      join(local, 'Google', 'Chrome', 'User Data'),
      join(local, 'Chromium', 'User Data'),
      join(local, 'Microsoft', 'Edge', 'User Data'),
    ]
  }
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    return [
      join(support, 'Google', 'Chrome'),
      join(support, 'Chromium'),
      join(support, 'Microsoft Edge'),
    ]
  }
  return [
    join(home, '.config', 'google-chrome'),
    join(home, '.config', 'chromium'),
    join(home, '.config', 'microsoft-edge'),
  ]
}

/**
 * The profiles that exist under the given roots.
 *
 * `readDir` and `stat` are injectable so the behaviour can be asserted without
 * depending on whether the machine running the tests has Chrome installed —
 * a test that only passes on a developer's laptop is not a test.
 *
 * A profile directory with no `Preferences` file is reported with a null
 * `lastUsedAt` rather than skipped: it exists, and hiding it would make the
 * picker offer fewer choices than the disk has.
 */
export function discoverProfiles({
  roots = chromeProfileRoots(),
  readDir = readdirSync,
  stat = statSync,
} = {}) {
  const out = []
  for (const root of roots) {
    let names
    try {
      names = readDir(root)
    } catch {
      /* The root does not exist — Chrome has never run here. Not an error, and
         definitely not something to report as one. */
      continue
    }
    for (const name of names) {
      if (name !== 'Default' && !/^Profile \d+$/.test(name)) continue
      const path = join(root, name)
      let lastUsedAt = null
      try {
        lastUsedAt = new Date(stat(join(path, 'Preferences')).mtime).toISOString()
      } catch {
        /* No Preferences file: the profile directory exists but was never
           opened. The path is still a valid answer to "which one". */
      }
      out.push({ name, path, root, lastUsedAt })
    }
  }
  return out
}

/**
 * The configured profile, against what is on disk.
 *
 * `source` says which of the three cases it is, because they need different
 * fixes: `default` (nothing configured — the collector uses its own location),
 * `found`, and `missing` (a path that points at nothing, which the collector
 * would fail on with a much worse message).
 */
export function profileView({ configured, discovered = [] } = {}) {
  const wanted = configured === null || configured === undefined ? '' : String(configured).trim()
  if (wanted === '') return { configured: null, matches: null, source: 'default' }
  const hit = discovered.find(profile => profile.path.toLowerCase() === wanted.toLowerCase())
  return { configured: wanted, matches: hit ?? null, source: hit === undefined ? 'missing' : 'found' }
}

/**
 * What the last health check said about the session, and when it said it.
 *
 * `checkedAt` is reported even when the state is `unknown`: "we have never
 * looked" and "we looked three days ago and could not tell" are different, and
 * only the timestamp distinguishes them.
 */
export function loginView({ health, checkedAt } = {}) {
  const parsed = typeof health === 'string' ? safeJson(health) : health
  const blob = parsed !== null && typeof parsed === 'object' ? parsed : null
  const reported = blob?.login
  const state = LOGIN_STATES.includes(reported) ? reported : 'unknown'
  return {
    state,
    checkedAt: checkedAt ?? null,
    detail: blob?.detail ?? null,
    /* True when nothing has ever been checked, so the page can say "未探测"
       instead of drawing a state that was never established. */
    neverChecked: checkedAt === null || checkedAt === undefined,
  }
}

/**
 * Where import files are read from by default.
 *
 * A convention rather than a discovery: the hub's own layout is the one thing
 * the plugin can name without guessing, and `collect.importDir` overrides it.
 */
export const DEFAULT_IMPORT_DIR = 'D:\\amazon-ops-hub\\03-knowledge\\keywords\\master\\source'

/**
 * The effective import directory, and whether it is the built-in default.
 *
 * `stored` is what the user set; `path` is what will actually be read. Reported
 * separately for the same reason the settings page separates them everywhere
 * else: "I chose this" and "this is the default" are different states, and
 * inferring one from the other would call a deliberate choice untouched.
 */
export function importView(stored) {
  const configured = stored === null || stored === undefined ? '' : String(stored).trim()
  return {
    path: configured === '' ? DEFAULT_IMPORT_DIR : configured,
    stored: configured === '' ? null : configured,
    isDefault: configured === '',
  }
}

/**
 * The one resolution both readers go through.
 *
 * `amzn_kw_import` (when no `path` is given) and the settings page's 导入目录 row
 * must agree on *which directory will actually be read*. They agree here and
 * nowhere else: the page used to compute the effective path for display while
 * the tool required a path outright, so the setting was an input box that
 * changed nothing — the display and the behaviour had drifted into two answers.
 * A second copy of `getSetting(...) ?? DEFAULT_IMPORT_DIR` anywhere is that same
 * bug waiting for its turn.
 *
 * The tool layer is allowed to call this because the resolution is *policy*
 * ("where does an import look by default"), not storage: the store stays the
 * only place that knows how a setting is persisted.
 */
export function resolveImportDir(store) {
  return importView(getSetting(store, 'collect.importDir'))
}

/**
 * The third-party sources, as the page's connection-status block.
 *
 * **`configKeys` and `hasSecret` only — never a value, not even a mask.** A
 * source with no credentials configured reports `configured: false` and an empty
 * `configKeys`, because an "empty key field" on screen reads as a credential
 * that exists and happens to be blank, which is a different claim.
 */
export function thirdPartyView(sources = []) {
  return sources
    .filter(source => source.kind !== 'browser')
    .map(source => ({
      id: source.id,
      kind: source.kind,
      name: source.name,
      enabled: source.enabled === true,
      status: source.status ?? null,
      configured: source.configKeys !== undefined && source.configKeys.length > 0,
      hasSecret: source.hasSecret === true,
      configKeys: Array.isArray(source.configKeys) ? [...source.configKeys] : [],
      lastHealth: source.lastHealth ?? null,
      checkedAt: source.checkedAt ?? null,
    }))
}

function safeJson(text) {
  if (text === null || text === undefined) return null
  if (typeof text === 'object') return text
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
