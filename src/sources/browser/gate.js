/**
 * The browser gate — one browser, one task at a time, across services.
 *
 * Collection and keyword scanning each already keep a private queue, and each
 * of their header comments states the same invariant: "one task at a time, or
 * two scrapers interleave in the same tab". That invariant holds *inside* one
 * service and fails *between* them, because the two services are independent
 * objects that happen to share one collector. Submitting an ASIN collection and
 * then a keyword scan runs both `drain()` loops concurrently against one Chrome.
 *
 * Why that is a data bug and not just a slower run: storefront switching
 * (`applyStorefront` in `sources/cdp/client.js`) writes the site's currency and
 * language with `Network.setCookie`. Cookies live in the browser-level jar, not
 * per tab. So while one task flips the profile to DE, the other task's US page
 * can be rendered with EUR/German — and the landing check either rejects it as
 * `wrong-storefront` (a pile of confusing failures) or, in the window between
 * the cookie write and the read, stores a plausible-looking wrong row. Two
 * concurrent scrapers are also a stronger bot signal.
 *
 * ## The lock belongs to the resource, not the task
 *
 * The first version of this fix wrapped each *task* in `gate.run` — collection's
 * `runTask` wrapped `adapter.collect`, keyword's wrapped `collector.withPage`.
 * That is the wrong altitude. A task-boundary lock is a lock the caller has to
 * remember to take, and two entry points forgot:
 *
 *   - `discoverKeywords` (`sources/keyword.js`) calls `collector.withPage`
 *     directly from the `amzn_keyword_discover` tool — a synchronous tool call
 *     that never goes through either service's queue.
 *   - `collector.doctor` (the `amzn_collect_doctor` tool) opens a page and calls
 *     `applyStorefront` — the very cookie write the whole gate exists to protect
 *     — with no lock at all.
 *
 * Measured with a counting stub, the task-boundary lock still let two browser
 * actions overlap (`max concurrency = 2`). So the gate is sunk to the **resource
 * boundary** instead: `createGatedCollector` wraps the collector's three browser
 * entry points — `collect()`, `withPage()`, `doctor()` — so *every* path to the
 * one Chrome is serialised, whether or not the caller remembered the queue.
 * `index.js` wraps the collector once and hands the same wrapped object to the
 * registry, to both services and to the tools.
 *
 * ## Why the gate must be reentrant
 *
 * Once the collector is gated, the task-boundary locks become *nested* calls:
 * collection's `gate.run(() => adapter.collect())` reaches `collector.collect`,
 * which is itself `gate.run(...)`. A plain FIFO chain would deadlock — the inner
 * `run` waits on the tail the outer `run` is still holding, and the promise
 * never settles (measured: it hangs forever). So the gate is **reentrant**: it
 * records, with `AsyncLocalStorage`, whether the *current async context* already
 * holds this gate, and if so runs the callback immediately instead of queueing.
 * Nesting is then free, and the invariant "at most one top-level browser action
 * at a time" is preserved because a reentrant call is by definition inside one.
 *
 * ## Why a promise chain rather than a mutex flag
 *
 * A boolean "busy" flag plus a waiter list is easy to get wrong on the failure
 * path: an `fn` that rejects has to wake the next waiter, and a missed wake-up
 * blocks the queue forever. Chaining onto the previous task's *settled* promise
 * makes the release automatic and impossible to forget — there is no `finally`
 * that can be skipped. The only subtlety is that the tail must swallow
 * rejections (otherwise one failure poisons every later `run`) while the
 * caller's promise must still reject with the original error. That is the one
 * line worth reading twice below.
 *
 * No timers, no third-party dependency (`node:async_hooks` ships with Node), no
 * scheduling cleverness: first come, first served, which is the same order the
 * single-service queues already use.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The collector methods that touch the shared browser (page, cookie jar, socket)
 * and therefore have to be serialised. `healthCheck` is deliberately absent: it
 * only probes the CDP version endpoint and reads in-process diagnostics, so it
 * touches no page and cannot pollute a storefront.
 */
const GATED_METHODS = ['collect', 'withPage', 'doctor']

/**
 * Marker recording which gate a collector has already been wrapped with, so
 * `createGatedCollector` is idempotent. A `Symbol` cannot collide with a real
 * collector property, and it is non-enumerable so it never shows up in a spread
 * or a `for…in`.
 */
const GATED_BY = Symbol('amazon-ops.browserGate')

/**
 * Create a serialising, reentrant gate. Every top-level `run(fn)` waits for the
 * previous one to settle, so at most one `fn` is in flight at any instant; a
 * `run` made from inside a `fn` that already holds the gate runs immediately.
 *
 * @returns {{ run: <T>(fn: () => T | Promise<T>) => Promise<T> }}
 */
export function createBrowserGate() {
  /**
   * The tail of the chain: a promise that is *always fulfilled*, whatever the
   * last task did. `run` appends to it, so the next caller never sees a
   * rejection from a previous task — a failed task releases the lock instead of
   * deadlocking the queue.
   */
  let tail = Promise.resolve()

  /**
   * The current async context's gate, if it already holds one. `run` sets this
   * to `gate` for the duration of a queued callback, so a nested `run` can see
   * that it is already inside and skip the queue. It is set *inside* the queued
   * callback — never in the caller's context — which is what keeps two
   * independent top-level calls from being mistaken for a nested pair.
   */
  const holding = new AsyncLocalStorage()

  const gate = {
    /**
     * Run `fn` once every earlier top-level call has finished, or immediately if
     * this async context already holds the gate.
     *
     * The returned promise settles exactly as `fn()` would: same value on
     * success, same error on failure. The rejection is *also* observed by the
     * chain's tail (which ignores it), so it never becomes an unhandled
     * rejection and never blocks a later call.
     *
     * @template T
     * @param {() => T | Promise<T>} fn
     * @returns {Promise<T>}
     */
    run(fn) {
      if (typeof fn !== 'function') {
        return Promise.reject(new TypeError('browser gate run() expects a function'))
      }

      // Reentrant fast path: this context already holds the gate (it is inside a
      // queued `fn`), so queueing again would wait on ourselves forever.
      // `Promise.resolve().then` keeps a synchronous throw inside `fn` from
      // escaping `run`, which must never throw synchronously.
      if (holding.getStore() === gate) {
        return Promise.resolve().then(() => fn())
      }

      // Wait for the previous top-level task to settle, then run this one under
      // the "this context holds the gate" marker. A synchronous throw inside
      // `fn` becomes a rejection here, which is what the caller expects.
      const result = tail.then(() => holding.run(gate, () => fn()))
      // The tail observes the outcome and discards it, so a rejection releases
      // the lock. `result` is returned untouched and still rejects.
      tail = result.then(() => undefined, () => undefined)
      return result
    },
  }

  return gate
}

/**
 * A gate that does not serialise: `run(fn)` calls `fn` straight away.
 *
 * Used as the default for a service constructed on its own (the existing unit
 * tests build one service at a time and never contend for a browser), so that
 * the absence of a shared gate is explicit rather than a missing lock. In the
 * real plugin `index.js` always passes the one shared gate.
 *
 * @returns {{ run: <T>(fn: () => T | Promise<T>) => Promise<T> }}
 */
export function createPassThroughGate() {
  return {
    run(fn) {
      if (typeof fn !== 'function') {
        return Promise.reject(new TypeError('browser gate run() expects a function'))
      }
      return Promise.resolve().then(() => fn())
    },
  }
}

/**
 * Wrap a collector so its browser entry points run through `gate`.
 *
 * This is where the lock actually lives: any caller that reaches `collect`,
 * `withPage` or `doctor` — a service's queue, the discovery tool, the doctor
 * tool, or code not written yet — is serialised against every other caller,
 * without having to know the gate exists. The wrapper delegates everything else
 * (`id`, `host`, `healthCheck`, `close`, `diagnostics`, `connected`, …) to the
 * collector untouched, because those neither open a page nor touch a cookie.
 *
 * Idempotent per gate: wrapping an already-gated collector with the *same* gate
 * returns it unchanged, so `index.js` can pre-wrap for the registry and still
 * pass the result through `createBrowserServices` without nesting the wrapper.
 *
 * @param {object} collector
 * @param {{ run: (fn: () => any) => Promise<any> }} gate
 * @returns {object} the collector, with its browser entry points gated
 */
export function createGatedCollector(collector, gate) {
  if (collector === null || collector === undefined) return collector
  if (gate === null || gate === undefined) return collector
  // Already wrapped with this gate — return it as-is rather than stacking.
  if (collector[GATED_BY] === gate) return collector

  // Prototype-delegated rather than a spread, so getters (`connected`) and any
  // future property survive without being snapshotted.
  const wrapped = Object.create(collector)
  for (const name of GATED_METHODS) {
    const method = collector[name]
    if (typeof method !== 'function') continue
    wrapped[name] = (...args) => gate.run(() => method.apply(collector, args))
  }
  Object.defineProperty(wrapped, GATED_BY, { value: gate, enumerable: false })
  return wrapped
}
