/**
 * 页面响应的传输压缩。
 *
 * ## 为什么在这里做，而不是去做「切片下发」
 *
 * 页面一次要下发 745 KB（`renderWorkbenchPage()` 实测 744.6 KB）：外壳 + 15 个面板 +
 * 一整段客户端脚本。原计划 P1-2 走「按模块切片下发」，但那要改首屏 DOM ——
 * 客户端脚本现在拼在同一个 `<script>` 作用域里，改成按需加载得让 `renderMain()`
 * 等脚本到位，属于**改行为**，而出问题时最难分清是切错了还是改错了。
 *
 * 先量了一遍更便宜的方案（2026-10-20 实测，同一份 HTML）：
 *
 *   原始      744.6 KB   100%
 *   gzip -9   225.1 KB   30.2%   省 69.8%
 *   brotli    169.5 KB   22.8%   省 77.2%
 *
 * 两者往返都**逐字节可逆**。也就是说：不改一字节 DOM，就能把线上传输减到 23%，
 * 而且比原定的「↓≥60%」目标还多。所以先做这个；切片下发留给真要按需渲染的时候。
 *
 * ## 真机复测后的两条更正（2026-10-20，值得记）
 *
 * 1. **「页面一直裸发」这个说法不准确。** 按提交信息当初的写法是 `res.end(html)`
 *    没带 Content-Encoding —— 代码确实如此，但**宿主 webServer 自己会上 gzip**：
 *    真机 curl 实测 `Accept-Encoding: gzip` → `Content-Encoding: gzip`，748,292 B 收到 264,452 B。
 *    所以这条改动真正的增量是 **brotli**（169.5 KB vs gzip 的 264.5 KB，再省 36%），
 *    而不是「从无压缩到有压缩」。**结论要按实测改口，不能留着更好听的版本。**
 *
 * 2. **本文件的改动要重启 DSH 才生效，重载插件不够。**
 *    实测：`amazon-ops` 在 profile 里是**绝对路径 insert**，不是 profile 的依赖包，
 *    所以「改 cordis.patch.yml 触发重组合」不会重新 import 它的模块图；
 *    改入口 `index.js` 也没有让 HMR 重载它。真机证据是进程启动时间
 *    （2026-10-19 16:57）早于所有代码改动，且 br 请求拿到的仍是 748,292 B 原文。
 *    **验证方式**：`curl -sD - -H "Accept-Encoding: br" <页面>` 应出现
 *    `content-encoding: br` 且约 170 KB；没有这个头就是没生效。
 *
 * ## 为什么默认不上 brotli 最高档
 *
 * `BROTLI_PARAM_QUALITY: 11` 的收益（169.5 KB）相对 quality 5 只有几个百分点，
 * 但单次压缩耗时是数量级的差距 —— 这是**每次请求都要算**的动态内容，不是构建期产物。
 * 所以 gzip 用 level 6、brotli 用 quality 5：牺牲 2–3% 体积，换掉一个可以感知的延迟。
 *
 * ## 什么时候不压缩
 *
 * - 客户端没声明 `Accept-Encoding`（**测试替身就是这种**：现有断言拿到的仍是字符串，
 *   所以这条改动对既有的 1900+ 断言零影响）。
 * - 内容小于 `MIN_COMPRESS_BYTES`：压完可能更大，且小响应的 CPU 不值得。
 * - 客户端显式 `q=0` 拒绝某个编码。
 */

import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

/** 小于这个就不压：压缩头本身有成本，小响应压完常常更大。 */
export const MIN_COMPRESS_BYTES = 1024

/**
 * 从请求头里取 `Accept-Encoding`，**大小写不敏感**。
 *
 * 这条不是洁癖：Node 原生的 `req.headers` 是全部小写的，但宿主把哪一层对象递进来
 * 不由这个插件决定 —— 实测 DSH 的 webServer 递进来的就是 `Accept-Encoding`
 * （大驼峰）。按小写取会**静默拿不到**，于是 br 分支永远不执行，
 * 而「没生效」看起来和「客户端不支持」一模一样。这条是上线后真机测出来的。
 */
export function acceptEncodingOf(req) {
  const headers = req?.headers
  if (headers === null || headers === undefined) return undefined
  if (typeof headers.get === 'function') {
    const viaGet = headers.get('accept-encoding')
    if (viaGet !== null && viaGet !== undefined) return viaGet
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'accept-encoding') return value
  }
  return undefined
}

/**
 * 从 `Accept-Encoding` 里挑一个编码。
 *
 * 按 q-value 正确排序，而不是「先出现的赢」：`gzip;q=0.5, br;q=1` 必须选 br，
 * `br;q=0` 必须视为不支持 br。返回 `'br' | 'gzip' | null`。
 */
export function negotiateEncoding(acceptEncoding) {
  const header = String(acceptEncoding ?? '').trim()
  if (header === '') return null

  const quality = new Map()
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.split(';')
    const name = rawName.trim().toLowerCase()
    if (name === '') continue
    let q = 1
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)
      if (match) {
        const parsed = Number(match[1])
        q = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0
      }
    }
    quality.set(name, q)
  }

  const br = quality.get('br') ?? 0
  const gzip = quality.get('gzip') ?? 0
  // 通配符：`*` 表示「其它编码也都行」，但显式写出的编码优先
  const star = quality.get('*') ?? 0
  const brQ = quality.has('br') ? br : star
  const gzipQ = quality.has('gzip') ? gzip : star

  if (brQ > 0 && brQ >= gzipQ) return 'br'
  if (gzipQ > 0) return 'gzip'
  return null
}

/** 压一段文本。返回能直接交给 `res.end()` 的 Buffer。 */
export function compressBody(text, encoding) {
  const raw = Buffer.from(text, 'utf8')
  if (encoding === 'br') {
    return brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 5,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    })
  }
  if (encoding === 'gzip') return gzipSync(raw, { level: 6 })
  throw new Error(`unknown content encoding ${JSON.stringify(encoding)}`)
}

/**
 * 发一段 HTML，能压就压。**只在客户端声明支持时才压**，否则原样发字符串。
 *
 * `vary: accept-encoding` 是必须的：同一个 URL 对不同 `Accept-Encoding` 返回不同字节，
 * 少了这个头，中间的缓存会把压缩版发给不支持的客户端（或反过来）。
 */
export function sendHtml(req, res, html, headers = {}) {
  const encoding = negotiateEncoding(acceptEncodingOf(req))
  const tooSmall = Buffer.byteLength(html, 'utf8') < MIN_COMPRESS_BYTES

  if (encoding === null || tooSmall) {
    res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return { compressed: false, encoding: null }
  }

  const body = compressBody(html, encoding)
  res.writeHead(200, {
    ...headers,
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-encoding': encoding,
    'content-length': String(body.length),
    vary: 'accept-encoding',
  })
  res.end(body)
  return { compressed: true, encoding, bytes: body.length }
}
