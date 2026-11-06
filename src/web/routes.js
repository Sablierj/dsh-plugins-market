/**
 * HTTP 面：一条 exact 路由给页面，一条 prefix 路由给 JSON API。
 *
 * 两条都得注册在 `ctx.inject(['webServer'], …)` 里面 —— 直接 `ctx.get('webServer')`
 * 可能在它的 fiber 还没 active 时读到 undefined，于是页面静默 404（这个坑 amazon-ops
 * 的注释里已经写死过一次，这里照抄结论，不重新踩）。
 *
 * prefix 路径**不能**以斜杠结尾：路由器按 `pathname === prefix || pathname.startsWith(prefix + '/')`
 * 匹配，结尾带斜杠会变成要求双斜杠，永远不触发。
 */
import { renderPage } from './page.js'

export function registerWeb(ctx, { service, pagePath, logger = console }) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: pagePath,
        handler(req, res) {
          sendHtml(res, renderPage({ pagePath }))
        },
      }),
    )

    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'prefix',
        path: pagePath + '/api',
        async handler(req, res) {
          const url = new URL(req.url, 'http://localhost')
          const route = url.pathname.slice((pagePath + '/api').length).replace(/^\/+/, '')

          try {
            if (route === 'status' && req.method === 'GET') {
              return sendJson(res, service.status())
            }

            if (route === 'config' && req.method === 'GET') {
              return sendJson(res, { ok: true, config: service.publicConfig() })
            }

            if (route === 'config' && req.method === 'POST') {
              const body = await readJson(req)
              const config = service.saveConfig(body ?? {})
              return sendJson(res, { ok: true, config })
            }

            // 连通性测试：0 点（initialize + tools/list + query_quota）。
            if (route === 'test' && req.method === 'POST') {
              const result = await service.testConnection()
              return sendJson(res, result)
            }

            // ── 对象（ASIN 清单）──────────────────────────────
            if (route === 'objects' && req.method === 'GET') {
              return sendJson(res, { ok: true, objects: service.objects() })
            }

            if (route === 'objects' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, ...(await service.addObject(body ?? {})) })
            }

            if (route === 'objects/delete' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, ...service.removeObject(body ?? {}) })
            }

            // ── 看板数据：读本地库，0 点 ──────────────────────
            if (route === 'traffic' && req.method === 'GET') {
              const asin = url.searchParams.get('asin') ?? ''
              const limit = Number(url.searchParams.get('limit') ?? 12)
              return sendJson(res, { ok: true, asin, rows: service.trafficSeries(asin, { limit }) })
            }

            // ── 同步：先报预算，再执行 ────────────────────────
            if (route === 'sync/plan' && req.method === 'GET') {
              const level = url.searchParams.get('level') ?? 'L1'
              const asins = (url.searchParams.get('asins') ?? '').split(',').map(value => value.trim()).filter(Boolean)
              const plan = service.planSync({ level, asins })
              return sendJson(res, { ok: true, plan })
            }

            if (route === 'sync/run' && req.method === 'POST') {
              const body = await readJson(req)
              const result = await service.sync({ level: body?.level ?? 'L1', asins: body?.asins ?? null })
              return sendJson(res, { ok: true, ...result })
            }

            // ── 看板 / 洞察（读本地，0 点）────────────────────
            if (route === 'dashboard' && req.method === 'GET') {
              return sendJson(res, { ok: true, dashboard: service.dashboard() })
            }

            if (route === 'insights' && req.method === 'GET') {
              const asin = url.searchParams.get('asin')
              return sendJson(res, { ok: true, insights: service.insights({ asin: asin || null }) })
            }

            // ── 报告 ──────────────────────────────────────────
            if (route === 'report' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, report: service.report({ asin: body?.asin }) })
            }

            if (route === 'report/deep' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, report: service.deepReport({ asin: body?.asin }) })
            }

            // ── 组合视图 / 一键日更 ───────────────────────────
            if (route === 'portfolio' && req.method === 'GET') {
              return sendJson(res, { ok: true, portfolio: service.portfolio() })
            }

            if (route === 'daily' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, ...(await service.daily({ level: body?.level ?? 'L1', deepTop: body?.deepTop ?? 3 })) })
            }

            if (route === 'reports' && req.method === 'GET') {
              const asin = url.searchParams.get('asin')
              return sendJson(res, { ok: true, reports: service.reports({ asin: asin || null }) })
            }

            if (route === 'report/body' && req.method === 'GET') {
              const id = Number(url.searchParams.get('id'))
              const row = service.reportBody(id)
              if (!row) return sendJson(res, { ok: false, error: `没有报告 #${id}` }, 404)
              return sendJson(res, { ok: true, report: row })
            }

            // ── 词库 / 挖掘 / 竞品 ────────────────────────────
            if (route === 'keywords' && req.method === 'GET') {
              const status = url.searchParams.get('status')
              const asin = url.searchParams.get('asin')
              return sendJson(res, { ok: true, keywords: service.keywordLibrary({ status: status || null, asin: asin || null }) })
            }

            if (route === 'keywords/mine' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, ...(await service.mine({ root: body?.root, pageSize: body?.pageSize })) })
            }

            if (route === 'keywords/plan' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, plan: service.planKeywords({ keywords: body?.keywords ?? [] }) })
            }

            if (route === 'keywords/sync' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, ...(await service.syncKeywords({ keywords: body?.keywords ?? null })) })
            }

            if (route === 'keywords/status' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, ...service.markKeyword({ keyword: body?.keyword, status: body?.status, note: body?.note }) })
            }

            if (route === 'competition' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, ...(await service.competition({ keyword: body?.keyword })) })
            }

            if (route === 'competition' && req.method === 'GET') {
              const keyword = url.searchParams.get('keyword') ?? ''
              return sendJson(res, { ok: true, ...service.marketView({ keyword }) })
            }

            // ── 今日待办 / 健康 / 导出 ────────────────────────
            if (route === 'actions' && req.method === 'GET') {
              const asin = url.searchParams.get('asin')
              return sendJson(res, { ok: true, ...service.actions({ asin: asin || null }) })
            }

            if (route === 'health' && req.method === 'GET') {
              return sendJson(res, { ok: true, health: service.health() })
            }

            if (route === 'consistency' && req.method === 'GET') {
              return sendJson(res, { ok: true, consistency: service.consistency() })
            }

            // ── Listing 深度诊断 ─────────────────────────────
            if (route === 'listing' && req.method === 'GET') {
              const asin = url.searchParams.get('asin')
              return sendJson(res, { ok: true, listing: service.listingRaw({ asin: asin || null }) })
            }

            if (route === 'listing/audit' && req.method === 'GET') {
              const asin = url.searchParams.get('asin')
              return sendJson(res, { ok: true, audit: service.latestListingAudit({ asin: asin || null }) })
            }

            if (route === 'listing/audit' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, ...service.listingAudit({ asin: body?.asin, listing: body?.listing ?? null }) })
            }

            if (route === 'listing/draft' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, ...service.listingDraft({ asin: body?.asin, round: body?.round ?? 1 }) })
            }

            if (route === 'listing/assets' && req.method === 'GET') {
              const asin = url.searchParams.get('asin')
              return sendJson(res, { ok: true, ...service.listingAssets({ asin: asin || null }) })
            }

            if (route === 'listing/assets' && req.method === 'POST') {
              const body = await readJson(req)
              return sendJson(res, { ok: true, ...service.saveListingAssets(body ?? {}) })
            }

            if (route === 'export' && req.method === 'GET') {
              const kind = url.searchParams.get('kind') ?? 'keywords'
              const asin = url.searchParams.get('asin')
              const result = service.exportCsv({ kind, asin })
              if (url.searchParams.get('download') === '1') {
                return sendCsv(res, result.csv, result.file.split(/[\\/]/).pop())
              }
              return sendJson(res, { ok: true, ...result, csv: undefined })
            }

            return sendJson(res, { ok: false, error: `no route "${route}" (${req.method})` }, 404)
          } catch (error) {
            logger.warn?.(`[sif-ops] api error ${route}: ${error.message}`)
            return sendJson(res, { ok: false, error: error.message }, 400)
          }
        },
      }),
    )

    logger.info?.(`[sif-ops] web: ${pagePath}`)
  })
}

function sendHtml(res, html) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendJson(res, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** CSV 直接下载：带 BOM，Excel 打开中文不乱码。 */
function sendCsv(res, csv, filename) {
  const body = Buffer.from('\ufeff' + csv, 'utf8')
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-length': String(body.length),
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
