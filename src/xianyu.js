/**
 * 闲鱼订单：导入、与拼多多订单配对、生成批量发货行。
 *
 * 配对原则（可解释、可人工复核）：
 *  1) 手机号是最硬的键（闲鱼待发货单里是完整号码；已发货/关闭的会被打码）；
 *  2) 姓名、地址、商品标题做辅助分；
 *  3) 时间只做「拼多多下单不应早于闲鱼下单」的约束（同一个人可能复购，光看时间会配错）；
 *  4) 一个拼多多订单只能配一个闲鱼订单（一对一，按分数从高到低贪心）。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const PY_TOOL = join(HERE, '..', 'scripts', 'xlsx_tool.py')

/** 手机号归一化：去掉分机号、非数字，取前 11 位；含 * 的视为掩码，返回空串。 */
export function normalizePhone(value) {
  const text = String(value || '')
  if (text.includes('*')) return ''
  const digits = text.replace(/\D/g, '')
  return digits.length >= 11 ? digits.slice(0, 11) : ''
}

/** 姓名归一化：去掉称谓后缀，便于「刘女士」和「刘」这种对上。 */
export function normalizeName(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/(先生|女士|小姐|同学|老师)$/u, '')
}

/** 地址相似度：看区县/街道/门牌这些片段有没有对上。 */
export function addressScore(a, b) {
  const left = String(a || '').replace(/\s+/g, '')
  const right = String(b || '').replace(/\s+/g, '')
  if (!left || !right) return 0
  const tokens = [left.slice(0, 6), left.slice(-12), right.slice(-12)].filter((token) => token && token.length >= 4)
  let hits = 0
  for (const token of tokens) if (left.includes(token) || right.includes(token)) hits++
  return Math.min(1, hits / 2)
}

/** 商品标题相似度：按 2 字切片算重合率。 */
export function titleScore(a, b) {
  const left = String(a || '').replace(/[\s\p{P}]/gu, '')
  const right = String(b || '').replace(/[\s\p{P}]/gu, '')
  if (left.length < 4 || right.length < 4) return 0
  const grams = new Set()
  for (let i = 0; i < left.length - 1; i++) grams.add(left.slice(i, i + 2))
  let hits = 0
  let total = 0
  for (let i = 0; i < right.length - 1; i++) {
    total++
    if (grams.has(right.slice(i, i + 2))) hits++
  }
  return total ? hits / total : 0
}

export function parseXianyuRecords(records) {
  return records
    .map((row) => {
      const xySn = String(row['订单编号'] || '').trim()
      if (!xySn) return null
      const phoneRaw = String(row['收件号码'] || '').trim()
      return {
        xySn,
        status: String(row['订单状态'] || '').trim(),
        shop: String(row['店铺名称'] || '').trim(),
        buyer: String(row['买家昵称'] || row['闲鱼昵称'] || '').trim(),
        itemTitle: String(row['商品标题'] || '').trim(),
        spec: String(row['规格'] || '').trim(),
        qty: Number(row['数量'] || 0) || 0,
        amountCents: Math.round(Number(row['实收金额'] || 0) * 100) || null,
        orderTime: String(row['下单时间'] || '').trim(),
        payTime: String(row['付款时间'] || '').trim(),
        shipTime: String(row['发货时间'] || '').trim(),
        receiver: String(row['收件人'] || '').trim(),
        phone: normalizePhone(phoneRaw),
        phoneMasked: phoneRaw.includes('*') ? phoneRaw : '',
        address: String(row['收货地址'] || '').trim(),
        express: String(row['发货物流'] || '').trim(),
        tracking: String(row['发货单号'] || '').trim(),
        raw: row,
      }
    })
    .filter(Boolean)
}

function hoursBetween(a, b) {
  const left = Date.parse(String(a || '').replace(' ', 'T'))
  const right = Date.parse(String(b || '').replace(' ', 'T'))
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null
  return (right - left) / 3600000
}

/**
 * 给一条闲鱼订单找最合适的拼多多订单。
 * pddOrders: 库里所有拼多多订单（含 item 标题数组时更好）。
 */
export function bestMatch(xianyu, pddOrders) {
  const scored = []
  const xyPhone = normalizePhone(xianyu.phone)
  for (const pdd of pddOrders) {
    let score = 0
    const reasons = []
    const phone = normalizePhone(pdd.receiver_phone)
    const phoneMatched = Boolean(xyPhone && phone && xyPhone === phone)
    if (phoneMatched) {
      score += 0.62
      reasons.push('手机号')
    } else if (xyPhone && phone) {
      // 两边都有完整手机号却不一样：这是很强的反证，别让地址/商品把它抬上去
      score -= 0.6
    }
    if (normalizeName(xianyu.receiver) && normalizeName(xianyu.receiver) === normalizeName(pdd.receiver_name)) {
      score += 0.12
      reasons.push('姓名')
    }
    const addr = addressScore(xianyu.address, pdd.address)
    if (addr > 0) {
      score += 0.12 * addr
      if (addr >= 0.5) reasons.push('地址')
    }
    const title = titleScore(xianyu.itemTitle, pdd.goods_name || '')
    if (title > 0.25) {
      score += 0.05 * Math.min(1, title)
      reasons.push('商品')
    }
    const gap = hoursBetween(xianyu.orderTime, pdd.order_time)
    if (gap != null) {
      if (gap < -6) score -= 0.2 // 拼多多下单明显早于闲鱼下单，多半不是同一单
      else if (gap <= 72) {
        score += 0.1
        reasons.push('时间')
      } else if (gap <= 24 * 7) score += 0.03
    }
    if (score > 0) scored.push({ pdd, score, reasons, phoneMatched, gap: gap == null ? 9999 : Math.abs(gap) })
  }
  // 同分时优先「下单时间更接近」的那个，避免同手机号多单时乱配
  scored.sort((a, b) => b.score - a.score || a.gap - b.gap)
  return scored
}

/** 把库里的 xianyu_orders 行（snake_case）转成配对用的结构。 */
export function fromDbRow(row) {
  return {
    ...row,
    xySn: row.xySn || row.xy_sn,
    itemTitle: row.itemTitle || row.item_title || '',
    orderTime: row.orderTime || row.order_time || '',
    phone: row.phone || '',
    receiver: row.receiver || '',
    address: row.address || '',
  }
}

/** 跑一遍全量配对：一对一贪心，分数 >= 0.75 记 auto，0.5~0.75 记 candidate。 */
export function runMatch(xianyuOrders, pddOrders, existing = new Map()) {
  xianyuOrders = xianyuOrders.map(fromDbRow)
  const candidates = []
  for (const xy of xianyuOrders) {
    if (existing.get(xy.xySn)?.decision === 'manual') continue
    const ranked = bestMatch(xy, pddOrders)
    if (!ranked.length) continue
    candidates.push({ xy, best: ranked[0], runnerUp: ranked[1] || null })
  }
  candidates.sort((a, b) => b.best.score - a.best.score)

  const usedPdd = new Set()
  const results = []
  for (const item of candidates) {
    const { xy, best, runnerUp } = item
    let picked = best
    if (usedPdd.has(best.pdd.order_sn)) {
      picked = null
      // 换个没被占用的次优
      const ranked = bestMatch(xy, pddOrders).filter((row) => !usedPdd.has(row.pdd.order_sn))
      picked = ranked[0] || null
    }
    if (!picked) {
      results.push({ xySn: xy.xySn, pddSn: '', score: 0, method: 'none', decision: 'unmatched', note: '没有可用的拼多多订单' })
      continue
    }
    usedPdd.add(picked.pdd.order_sn)
    // 另一个平台的最佳候选（用来在面板上「改用它」）
    const altRow = bestMatch(xy, pddOrders).find(
      (row) => (row.pdd.platform || 'pdd') !== (picked.pdd.platform || 'pdd') && row.score >= 0.35,
    )
    // 两个平台都能对上手机号 → 交付时不能替用户拍板，进待确认
    const crossPlatformAmbiguous = Boolean(altRow && altRow.phoneMatched)
    const auto = picked.phoneMatched && picked.score >= 0.75 && !crossPlatformAmbiguous
    const tooWeak = picked.score < 0.35
    if (tooWeak) {
      results.push({ xySn: xy.xySn, pddSn: '', score: Number(picked.score.toFixed(2)), method: 'none', decision: 'unmatched', note: '证据不足', sourcePlatform: picked.pdd.platform || 'pdd' })
      continue
    }
    results.push({
      xySn: xy.xySn,
      pddSn: picked.pdd.order_sn,
      score: Number(picked.score.toFixed(2)),
      method: picked.reasons.join('+') || 'score',
      decision: auto ? 'auto' : 'candidate',
      note: crossPlatformAmbiguous
        ? `两个平台都能对上（另一候选 ${altRow.pdd.platform === '1688' ? '1688' : '拼多多'} ${altRow.pdd.order_sn}），请确认用哪个`
        : auto
          ? ''
          : picked.phoneMatched
            ? '分数接近，建议人工确认'
            : '手机号对不上，仅地址/商品相似',
      sourcePlatform: picked.pdd.platform || 'pdd',
      altSn: altRow ? altRow.pdd.order_sn : '',
      altPlatform: altRow ? altRow.pdd.platform || 'pdd' : '',
      scoreAlt: altRow ? Number(altRow.score.toFixed(2)) : null,
    })
  }
  return results
}

/** 调 Python 读 xlsx → 记录数组。 */
export async function readXlsxRecords(pythonPath, file, workDir) {
  const out = join(workDir, `xy-${Date.now()}.json`)
  await execFileAsync(pythonPath, [PY_TOOL, 'read-orders', file, out], { windowsHide: true })
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(out, 'utf8')
  await (await import('node:fs/promises')).unlink(out).catch(() => {})
  return JSON.parse(text)
}
