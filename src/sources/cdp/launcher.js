/**
 * Finding and starting the browser we drive.
 *
 * Two rules shape this file, both from DESIGN.md §4.2:
 *
 *   1. **A dedicated profile.** The collection browser gets its own
 *      `--user-data-dir` under the plugin's data directory. Sharing the user's
 *      everyday profile would mix a logged-in personal session with automated
 *      traffic, and the login state we want to keep is the collection one.
 *
 *   2. **A dedicated port.** 9222 is taken by the amazon-ops-hub deployment on
 *      this machine, so attaching there would drive someone else's browser. The
 *      default is 9333 and the two never meet.
 *
 * A real Chrome window, not headless. Headless is the single easiest thing for
 * a site to notice, and the visible window is also where the user logs into the
 * third-party platforms once.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { probeVersion, sleep } from './client.js'

/** Where Chrome usually lives. First hit wins; Edge is a working fallback. */
const BROWSER_CANDIDATES = [
  process.env.AMZN_OPS_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

export function findBrowser(explicitPath) {
  const candidates = explicitPath ? [String(explicitPath), ...BROWSER_CANDIDATES] : BROWSER_CANDIDATES
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* an unreadable path is just a miss */
    }
  }
  return null
}

/**
 * Start the collection browser and wait for its debugging port to answer.
 *
 * Idempotent by design: if something is already listening on the port, that
 * browser is adopted instead of a second one being launched. Relaunching is the
 * normal case after a reboot, so it must be boring.
 *
 * @returns {{ launched: boolean, version: object, exePath: string|null }}
 */
export async function ensureBrowser({
  host = '127.0.0.1',
  port = 9333,
  profileDir,
  exePath,
  windowSize = '1440,900',
  startupTimeoutMs = 30_000,
  logger = console,
} = {}) {
  const existing = await probeVersion(host, port)
  if (existing !== null) {
    return { launched: false, version: existing, exePath: null }
  }

  const resolved = findBrowser(exePath)
  if (resolved === null) {
    throw new Error(
      'no Chrome or Edge executable found. Set AMZN_OPS_CHROME_PATH, or pass chromePath in the plugin config.',
    )
  }
  if (!profileDir) throw new Error('profileDir is required to launch the collection browser')

  mkdirSync(profileDir, { recursive: true })

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    // Keeps a first-run wizard or a "make Chrome your default?" bubble from
    // stealing the window the user is about to log in through.
    '--no-first-run',
    '--no-default-browser-check',
    // Background throttling would freeze a tab we are waiting on when the
    // window is not focused, which is exactly how it will usually be.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    // Stops the browser from volunteering `navigator.webdriver === true`. This
    // removes the most obvious automation tell and nothing more — it is not a
    // disguise, and §4.2 says so plainly.
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US',
    `--window-size=${windowSize}`,
    'about:blank',
  ]

  logger?.info?.(`[amazon-ops] launching ${resolved} on port ${port} (profile ${profileDir})`)
  const child = spawn(resolved, args, {
    detached: true,
    stdio: 'ignore',
    // A visible window on purpose: the user needs it to log in, and headless
    // is the easiest thing for a site to spot.
    windowsHide: false,
  })
  child.on('error', (error) => {
    logger?.warn?.(`[amazon-ops] browser launch error: ${error.message}`)
  })
  // Detached so the browser outlives a plugin reload: the profile lock and the
  // login state are worth keeping between tasks.
  child.unref()

  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    await sleep(400)
    const version = await probeVersion(host, port)
    if (version !== null) return { launched: true, version, exePath: resolved }
  }

  throw new Error(
    `launched ${resolved} but port ${port} never answered within ${startupTimeoutMs}ms. `
    + 'If the browser window is showing a first-run dialog, dismiss it and retry. '
    + `Profile: ${profileDir}`,
  )
}
