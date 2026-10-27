/* 对抗性验证用探针 —— 只为读，不改任何 src 文件。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { openStore } from '../src/store/db.js'

const LOGGER = { info() {}, warn() {}, error() {}, log() {} }

export function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'amzn-probe-'))
  const tools = []
  const injections = []
  const effects = []
  const registrations = []
  const collectEffect = (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') effects.push(dispose)
    return () => {}
  }
  const announce = console.log
  console.log = () => {}
  try {
    apply(
      {
        logger: LOGGER,
        tools: { register(tool) { tools.push(tool); return () => {} } },
        inject(deps, fn) { injections.push({ deps, fn }); return () => {} },
        effect: collectEffect,
      },
      { plugin: 'workbench', dataDir: dir, logger: LOGGER },
    )
  } finally {
    console.log = announce
  }
  for (const { deps, fn } of injections) {
    if (!deps.includes('webServer')) continue
    fn({
      logger: LOGGER,
      effect: collectEffect,
      webServer: { register(route) { registrations.push(route); return () => {} } },
    })
  }
  const store = openStore({ dataDir: dir, logger: LOGGER })
  return {
    store,
    tools,
    api: registrations.find(route => route.path.endsWith('/api')),
    tool(name) {
      const found = tools.find(candidate => candidate.name === name)
      if (found === undefined) throw new Error(`no tool named ${name}`)
      return found
    },
    close() {
      store.close()
      for (const dispose of effects) { try { dispose() } catch { /* already disposed */ } }
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ }
    },
  }
}

export function draft(overrides = {}) {
  return {
    module: 'common',
    scenario: 'button',
    label: '生成五点描述',
    body: '给 {{scope}} 写五点描述。',
    ...overrides,
  }
}

export function callRoute(route, method, pathname, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = {
      method,
      url: pathname,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      setEncoding() { return this },
      on(event, fn) {
        if (payload !== null && event === 'data') fn(payload)
        if (event === 'end') fn()
        return this
      },
    }
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; return this },
      end(text) { resolve({ status: this.status, headers: this.headers, text }) },
    }
    void route.handler(req, res)
  })
}

export function frozenRows(store, id) {
  return store.all(
    'SELECT id, object_type, object_id, version, payload_json, ref_table, ref_id, note, archived_at, created_at'
    + ' FROM snapshot_registry WHERE object_type = ? AND object_id = ? ORDER BY version + 0',
    ['prompt', id],
  )
}
