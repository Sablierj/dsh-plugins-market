/**
 * Making a storefront render as itself, and verifying that it did.
 *
 * Setting the host in the URL is not enough, and neither is setting cookies
 * blindly. Four things decide how Amazon renders a page, and on a machine
 * outside the target country all of them default to something wrong:
 *
 *   1. **The delivery location.** Amazon derives it from the request IP. On a
 *      network in China, `amazon.de` answers with "Deliver to China" and prices
 *      in **CNY** — verified live. Nothing about the URL hints at this.
 *   2. **The language cookie.** Amazon's interface language is `lc-<storefront>`,
 *      e.g. `lc-acbde` for amazon.de, and it **takes precedence over `lc-main`**.
 *      Verified live: with `lc-main=de_DE` set, the page still rendered `en-GB`
 *      because `lc-acbde=en_GB` was present and won.
 *   3. **`i18n-prefs`.** The currency. Setting it does work on its own.
 *   4. **`Accept-Language`.** Reinforces 2 and 3 for the first request.
 *
 * So this module does what a person would do: open the "Deliver to" dialog and
 * enter a **postal code** for the target country. Then it checks the result and
 * reports what it actually got.
 *
 * ## Why a postal code, and not the country dropdown
 *
 * The dialog has a country `<select>`, and picking the target country in it is
 * the obvious move. It does not work: **the list holds the countries you can
 * ship *to from* this storefront, so it excludes the storefront's own country.**
 * Measured on amazon.de — 242 options, `hasUS: true`, `hasDE: false`. You
 * cannot pick "Germany" on amazon.de because you are already there.
 *
 * A postal code, by contrast, works on every variant: Amazon resolves it to a
 * country and rewrites the delivery location itself. Verified live on a network
 * in China — `amazon.de` went from `Deliver to China` to `10115 Berlin`, in
 * German, priced in EUR. That is why every marketplace in `MARKETPLACES`
 * carries a postal code, and the dropdown is only set opportunistically.
 *
 * Why the location has to be driven through the UI at all: it is held
 * server-side against the session, so there is no cookie that can be forged for
 * it. The UI is the only lever. The *language*, by contrast, can be set — and
 * it is, using the cookie name read off the live page rather than a guess, so
 * this works on storefronts whose suffix we have never seen.
 *
 * Everything here is best-effort and reports honestly. A storefront that could
 * not be switched is a `problem` on the result, not a silent success.
 */

import { applyStorefront, evaluate, sleep } from '../cdp/client.js'
import { locationMatches } from './amazon.js'

/** Read what the page currently thinks it is. */
const READ_STATE = `
  (() => {
    const line2 = document.querySelector('#glow-ingress-line2')
    const line1 = document.querySelector('#glow-ingress-line1')
    const cookies = document.cookie ? document.cookie.split('; ') : []
    // The storefront's own language cookie, e.g. lc-acbde. \`lc-main\` is the
    // fallback and is deliberately excluded: it is the one that loses.
    const langCookie = cookies.find(c => /^lc-/.test(c) && c.indexOf('lc-main=') !== 0)
    return {
      url: location.href,
      location: line2 ? (line2.innerText || '').trim() : null,
      locationLabel: line1 ? (line1.innerText || '').trim() : null,
      lang: document.documentElement ? (document.documentElement.lang || '') : '',
      langCookieName: langCookie ? langCookie.split('=')[0] : null,
      langCookieValue: langCookie ? langCookie.split('=').slice(1).join('=') : null,
      title: document.title,
    }
  })()
`

/**
 * Open the "Deliver to" dialog and set the country and postal code.
 *
 * The dialog is a popover rather than a page, and its shape varies by
 * storefront: the German one shows a 242-entry country dropdown *and* a postal
 * field, others show only a postal field. Both were found on live pages.
 *
 * **The postal code is the lever that works on every variant.** Amazon resolves
 * it to a country and rewrites the delivery location itself, which is why each
 * marketplace in `MARKETPLACES` carries a representative postal code. The
 * country dropdown is set too when it is there, because that is the order a
 * person would do it in, but a missing or unpopulated dropdown is not a failure
 * — falling back to the postal code is the point.
 *
 * The dropdown is filled by an async request *after* the popover opens, so
 * reading it once gets the placeholder ("Auswählen") and looks like "this
 * country is not offered". It has to be polled.
 *
 * `stepScale` exists so the self-check can run this in milliseconds; in
 * production it is 1 and the pauses are what a person's clicks would take.
 */
const SET_LOCATION = `
  (async () => {
    const { country, postalCode, stepScale } = __ARGS__
    const scale = typeof stepScale === 'number' ? stepScale : 1
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms * scale))
    const steps = []

    const trigger = document.querySelector('#nav-global-location-popover-link')
      || document.querySelector('#glow-ingress-block')
    if (trigger === null || trigger === undefined) {
      return { ok: false, detail: '找不到「配送至」入口', steps }
    }
    trigger.click()
    steps.push('已点开配送地址弹窗')
    await wait(1500)

    // Poll for a *populated* country list. Present-but-empty means the request
    // has not landed yet, which is not the same as "not offered".
    let select = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = document.querySelector('#GLUXCountryList')
        || document.querySelector('select[name="glow-ingress-country"]')
      if (candidate !== null && candidate !== undefined
        && candidate.options !== undefined && candidate.options.length > 1) {
        select = candidate
        break
      }
      await wait(500)
    }

    let countrySet = false
    if (select === null) {
      steps.push('该站点的弹窗没有国家下拉，直接用邮编切换')
    } else {
      const option = Array.from(select.options).find((item) => item.value === country)
      if (option === undefined) {
        steps.push('国家列表里没有 ' + country + '（该清单只列「寄往其他国家」），改用邮编切换')
      } else {
        select.value = country
        select.dispatchEvent(new Event('change', { bubbles: true }))
        countrySet = true
        steps.push('已选择国家 ' + country + '（' + String(option.textContent || '').trim() + '）')
        await wait(800)
      }
    }

    let zipSet = false
    if (postalCode) {
      // Some flows hide the postal field behind a "Change" link until asked.
      let field = document.querySelector('#GLUXZipUpdateInput')
        || document.querySelector('input[name="zipCode"]')
      if (field === null || field === undefined) {
        const change = document.querySelector('#GLUXChangePostalCodeLink')
        if (change !== null && change !== undefined) {
          change.click()
          steps.push('已点开「Change」以显示邮编输入')
          await wait(800)
          field = document.querySelector('#GLUXZipUpdateInput')
            || document.querySelector('input[name="zipCode"]')
        }
      }
      if (field !== null && field !== undefined) {
        field.focus()
        field.value = postalCode
        field.dispatchEvent(new Event('input', { bubbles: true }))
        field.dispatchEvent(new Event('change', { bubbles: true }))
        zipSet = true
        steps.push('已填写邮编 ' + postalCode)
        await wait(500)
      } else {
        steps.push('未找到邮编输入框')
      }
    }

    const ok = countrySet || zipSet
    const detail = ok ? '已提交配送地址' : '国家与邮编都没能设置'

    const host = document.querySelector('#GLUXZipUpdate')
      || document.querySelector('input[aria-labelledby="GLUXZipUpdate-announce"]')
    if (host === null || host === undefined) {
      // Some storefronts need no confirmation and navigate on their own.
      steps.push('找不到确认按钮，可能已自动生效')
      return { ok, detail, steps }
    }

    // The confirm control is a span on some storefronts and a submit input on
    // others, so click whatever is actually inside it.
    const target = host.tagName === 'INPUT'
      ? host
      : (host.querySelector('input[type=submit]') || host)
    target.click()
    steps.push('已点击确认')
    await wait(3000)
    return { ok, detail, steps }
  })()
`

/**
 * Build the injected script that drives the "Deliver to" dialog.
 *
 * Exported so the self-check can run it against a stubbed DOM. A mistake in
 * this string does not fail a build — it fails inside a browser tab and reads
 * as "the address did not change", which is indistinguishable from Amazon
 * having changed their markup. `stepScale` collapses the pauses so the check
 * runs in milliseconds.
 */
export function buildSetLocationScript(storefront, { stepScale = 1 } = {}) {
  // A function replacer, not a string: `$` is special in a string replacement
  // and a postal code could contain one.
  const source = SET_LOCATION.replace('__ARGS__', () => JSON.stringify({
    country: storefront.country,
    postalCode: storefront.postalCode ?? null,
    stepScale,
  }))
  // Trimmed so the result is a self-contained expression. The template above is
  // indented for readability, and a leading newline turns `return <script>`
  // into `return;` — automatic semicolon insertion, and a silently undefined
  // result rather than a syntax error.
  return source.trim()
}

/**
 * Bring one tab to the state where it renders `storefront` correctly.
 *
 * Call it **after** the tab has loaded a page on the target domain: the
 * delivery location and the language cookie only exist once Amazon has served
 * a document.
 *
 * @returns {{ ok: boolean, actions: string[], problems: string[], state: object }}
 */
export async function ensureStorefront(connection, sessionId, storefront, { logger = console } = {}) {
  const actions = []
  const problems = []

  // The cheap levers first: currency, the fallback language cookie, and the
  // request header. These alone fix the currency, which is the one that
  // silently corrupts stored data.
  await applyStorefront(connection, sessionId, storefront)
  actions.push(`已套用 ${storefront.domain} 的币种偏好 ${storefront.currency} 与 Accept-Language`)

  let state = await waitForState(connection, sessionId)

  // The language cookie that actually wins is per-storefront, so its name is
  // read off the page rather than guessed. Correcting its value is what makes
  // the interface switch.
  if (state.langCookieName !== null && !languageMatches(state, storefront)) {
    await setCookie(connection, sessionId, {
      name: state.langCookieName,
      value: storefront.request,
      domain: storefront.cookieDomain,
    })
    actions.push(`已把 ${state.langCookieName} 从 ${state.langCookieValue} 改为 ${storefront.request}`)
    await reload(connection, sessionId)
    state = await readState(connection, sessionId)
  } else if (state.langCookieName === null) {
    // No per-storefront cookie yet. Nothing to correct, so the `language=`
    // query parameter and the Accept-Language header are what carry it; this is
    // recorded because it is the difference between "verified" and "hoped".
    actions.push('页面上还没有该站点的语言 cookie，先依赖 language 参数与请求头')
  }

  // The delivery location cannot be forged — it is held against the session
  // server-side — so this is the one part that has to go through the UI.
  if (!locationMatches(state.location, storefront)) {
    let result = null
    let navigated = false
    try {
      result = await evaluate(connection, sessionId, buildSetLocationScript(storefront), { timeoutMs: 40_000 })
    } catch (error) {
      // Clicking the confirm control submits a form, so the page can navigate
      // out from under the evaluation. Verified on amazon.com. That is the
      // dialog working rather than failing, so it is recorded and the verdict
      // comes from what the page says afterwards.
      navigated = true
      actions.push(`提交配送地址后页面跳转（${error.message}）`)
    }

    for (const step of result?.steps ?? []) actions.push(step)
    if (result !== null && result.ok !== true) {
      problems.push(`配送地址未能改为 ${storefront.country}: ${result.detail ?? '未知原因'}`)
    } else if (navigated) {
      // Mid-navigation already: a reload would interrupt it, so just let the
      // new document settle.
      await sleep(2_000)
    } else {
      await reload(connection, sessionId)
    }

    state = await readState(connection, sessionId)
    if (!locationMatches(state.location, storefront)) {
      problems.push(`配送地址仍显示 ${state.location ?? '（读不到）'}，期望 ${storefront.locationName}`
        + `${storefront.postalCode === null ? '' : `（邮编 ${storefront.postalCode}）`}`)
    }
  }

  if (!languageMatches(state, storefront)) {
    problems.push(`界面语言仍是 ${state.langCookieValue ?? state.lang ?? '（未报告）'}，期望 ${storefront.accept.join(' / ')}`)
  }

  if (problems.length > 0) {
    logger?.warn?.(`[amazon-ops] storefront ${storefront.code}: ${problems.join('；')}`)
  }
  return { ok: problems.length === 0, actions, problems, state }
}

/** What the tab reports about itself, for the snapshot and the doctor. */
export async function readState(connection, sessionId) {
  try {
    return await evaluate(connection, sessionId, READ_STATE, { timeoutMs: 15_000 })
  } catch (error) {
    return {
      url: null, location: null, locationLabel: null, lang: '', langCookieName: null,
      langCookieValue: null, title: '', error: error.message,
    }
  }
}

/**
 * Wait until the page reports where it ships.
 *
 * The delivery line is the signal that has to be waited for, and getting this
 * wrong is not cosmetic: "not reported" is deliberately treated as "not wrong",
 * so reading too early **skips the address switch entirely** and lets the wrong
 * storefront through. Measured on a live amazon.de home page — the language
 * cookie was already set while `#glow-ingress-line2` had not rendered yet, and
 * waiting on either signal returned on the cookie and left the switch undone.
 */
async function waitForState(connection, sessionId, { timeoutMs = 8_000, pollMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let state = await readState(connection, sessionId)
  while (Date.now() < deadline) {
    if (typeof state.location === 'string' && state.location !== '') return state
    await sleep(pollMs)
    state = await readState(connection, sessionId)
  }
  return state
}

/**
 * Does the interface language match?
 *
 * The cookie value wins, because it is what Amazon reads and what this module
 * sets; the DOM `lang` attribute is only a fallback. That ordering is the
 * lesson from a live probe: `documentElement.lang` answered `en-gb` on a German
 * storefront, so it is evidence rather than proof.
 */
function languageMatches(state, storefront) {
  const cookie = String(state.langCookieValue ?? '').trim().toLowerCase()
  if (cookie !== '') return storefront.accept.includes(cookie.split(/[-_]/)[0])
  const lang = String(state.lang ?? '').trim().toLowerCase()
  if (lang === '') return true // Not reported is not the same as wrong.
  return storefront.accept.includes(lang.split(/[-_]/)[0])
}

async function setCookie(connection, sessionId, { name, value, domain }) {
  await connection.send('Network.setCookie', { name, value, domain, path: '/', secure: true }, { sessionId })
}

/** Reload and wait for the document to settle; the location dialog navigates. */
async function reload(connection, sessionId) {
  try {
    await connection.send('Page.reload', {}, { sessionId, timeoutMs: 30_000 })
  } catch {
    // A reload that races a navigation the dialog already started is fine.
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await sleep(500)
    try {
      const ready = await evaluate(connection, sessionId, 'document.readyState', { timeoutMs: 5_000 })
      if (ready === 'complete') {
        // Give Amazon's own post-load location refresh a moment to land.
        await sleep(1_200)
        return
      }
    } catch {
      /* mid-navigation: the execution context is replaced */
    }
  }
}
