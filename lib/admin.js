/**
 * 面板用的同源管理路由。
 *
 * 和 agent 工具调的是同一批函数（service.js），不做第二套逻辑 ——
 * 面板点「停止」和工具 searxng_service{action:'stop'} 走的是同一条代码路径。
 *
 * 只接受回环来源：这些接口能操作本机 Docker，不该被局域网里别的东西调到。
 */

const PREFIX = '/dsh-searxng'

function respond(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error?.message || error)}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * @param {object} ctx           cordis context
 * @param {object} deps
 * @param {() => object} deps.getSettings
 * @param {(patch: object) => object} deps.applySettings 写入运行时配置并返回新的 effective settings
 * @param {() => Promise<object>} deps.snapshot
 * @param {(action: string, args?: object) => Promise<object>} deps.runAction
 * @param {(lines?: number) => Promise<object>} deps.logs
 */
export function registerAdminRoutes(ctx, deps) {
  const webServer = ctx.get('webServer')
  if (!webServer?.register) {
    ctx.logger?.warn?.('[web-search-searxng] webServer 不可用，面板路由未注册（工具仍可用）')
    return { registered: false }
  }

  const guard = (handler) => async (req, res) => {
    if (!isLoopback(req)) return respond(res, 403, { ok: false, error: 'loopback only' })
    try {
      await handler(req, res)
    } catch (error) {
      ctx.logger?.warn?.(`[web-search-searxng] admin route failed: ${String(error?.message || error)}`)
      respond(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  const routes = [
    {
      path: `${PREFIX}/status`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return respond(res, 405, { ok: false, error: 'GET only' })
        const settings = deps.getSettings()
        const snap = await deps.snapshot()
        respond(res, 200, { ok: true, ...snap, settings: settings })
      }),
    },
    {
      path: `${PREFIX}/action`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const action = String(body.action || '')
        if (!action) return respond(res, 400, { ok: false, error: 'action 必填' })
        const result = await deps.runAction(action, body)
        respond(res, 200, { ok: result.ok !== false, action, result })
      }),
    },
    {
      path: `${PREFIX}/config`,
      handler: guard(async (req, res) => {
        if (req.method === 'GET') {
          return respond(res, 200, { ok: true, settings: deps.getSettings() })
        }
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'GET/POST only' })
        const body = await readBody(req)
        const patch = body && typeof body.patch === 'object' ? body.patch : body
        const settings = deps.applySettings(patch || {})
        respond(res, 200, { ok: true, settings, note: '已保存，即时生效；端口 / 镜像 / 代理的改动可能需要重启容器。' })
      }),
    },
    {
      path: `${PREFIX}/logs`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return respond(res, 405, { ok: false, error: 'GET only' })
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const lines = Number(url.searchParams.get('lines') || 40)
        respond(res, 200, { ok: true, ...(await deps.logs(lines)) })
      }),
    },
  ]

  for (const route of routes) {
    ctx.effect(() => webServer.register({ kind: 'exact', path: route.path, handler: route.handler }))
  }
  ctx.logger?.info?.(`[web-search-searxng] 面板路由已注册：${routes.map((r) => r.path).join(', ')}`)
  return { registered: true, paths: routes.map((r) => r.path) }
}
