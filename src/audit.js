/**
 * 智能审核：给每条核对结果一个明确的「标识」，并对全库做一致性体检。
 *
 * 为什么单独一层：
 *  - 匹配器只回答「像不像同一个人下的单」，交付时要回答的是「这条能不能直接用」——
 *    两者不是一回事，所以这里把 decision 翻译成 label/badge/needsReview；
 *  - 数据准确性不能靠「看起来对」，要靠可复算的检查项（重复单号、悬空匹配、
 *    运单号被两单共用、日期对不上……），每项都能落到具体的单号上。
 */

/** 决策 → 人看的标识。needsReview=true 表示「要人点一下才能用」。 */
export function decorateMatch(match) {
  const decision = match && match.decision ? match.decision : 'unmatched'
  // 没有来源单号的「未匹配」不该带分数和平台——那是被否掉的候选残留，显示出来会误导
  const hasSource = Boolean(match && match.pdd_sn)
  const score = hasSource && Number.isFinite(match.score) ? match.score : null
  const confidence = score == null ? 'none' : score >= 0.9 ? 'high' : score >= 0.75 ? 'medium' : score >= 0.5 ? 'low' : 'none'
  const table = {
    auto: { label: '已匹配', badge: 'auto', needsReview: false, tone: 'ok' },
    manual: { label: '人工确认', badge: 'manual', needsReview: false, tone: 'brand' },
    candidate: { label: '待确认', badge: 'review', needsReview: true, tone: 'warn' },
    unmatched: { label: '未匹配', badge: 'none', needsReview: true, tone: 'err' },
    rejected: { label: '已排除', badge: 'none', needsReview: false, tone: 'idle' },
  }
  const meta = table[decision] || table.unmatched
  return {
    decision,
    ...meta,
    score,
    confidence,
    mark: `${meta.label}${score != null ? ` ${score.toFixed(2)}` : ''}`,
  }
}

const SEVERITY = { error: 3, warn: 2, info: 1 }

/**
 * 全库体检。返回 findings[]，每条都带 orderSn / 说明 / 怎么处理。
 * 只读：不改任何数据。
 */
export function runAudit(db, { limit = 500 } = {}) {
  const findings = []
  const push = (severity, code, title, detail, refs = {}) => {
    findings.push({ severity, code, title, detail, ...refs })
  }

  // 1) 同一订单号出现在两个平台（主键冲突本不该发生，发生了说明迁移有问题）
  const dupSn = db
    .prepare('SELECT order_sn, COUNT(*) c, GROUP_CONCAT(platform) platforms FROM orders GROUP BY order_sn HAVING c > 1 LIMIT 20')
    .all()
  for (const row of dupSn) push('error', 'dup_order_sn', '订单号重复', `${row.order_sn} 出现在 ${row.platforms}`, { orderSn: row.order_sn })

  // 2) 匹配指向不存在的来源订单（悬空匹配）
  const dangling = db
    .prepare(
      `SELECT m.xy_sn, m.pdd_sn FROM order_matches m
       LEFT JOIN orders o ON o.order_sn = m.pdd_sn
       WHERE m.pdd_sn <> '' AND o.order_sn IS NULL LIMIT ${Number(limit)}`,
    )
    .all()
  for (const row of dangling) push('error', 'dangling_match', '匹配指向不存在的订单', `闲鱼单 ${row.xy_sn} → ${row.pdd_sn}`, { xySn: row.xy_sn, orderSn: row.pdd_sn })

  // 3) 同一个运单号被两个来源订单使用。
  //    同一收件人（手机号/姓名一致）= 合并发货，是正常业务；不同收件人才是填错单号。
  const dupTracking = db
    .prepare(
      `SELECT tracking_no FROM orders WHERE tracking_no <> '' GROUP BY tracking_no HAVING COUNT(*) > 1 LIMIT 20`,
    )
    .all()
  for (const row of dupTracking) {
    const orders = db
      .prepare('SELECT order_sn, platform, receiver_name, receiver_phone, status_text FROM orders WHERE tracking_no = ?')
      .all(row.tracking_no)
    const receivers = new Set(orders.map((o) => `${o.receiver_name}|${o.receiver_phone}`))
    const sameReceiver = receivers.size === 1
    const sns = orders.map((o) => o.order_sn).join(',')
    if (sameReceiver) {
      push('info', 'shared_tracking', '同一收件人合并发货', `${row.tracking_no} → ${sns}（同一收件人，属正常）`, { trackingNo: row.tracking_no })
    } else {
      push('error', 'dup_tracking', '运单号被不同收件人共用', `${row.tracking_no} → ${sns}`, { trackingNo: row.tracking_no })
    }
  }

  // 4) 已匹配但来源还没发货（不能拿去发货）
  const notShipped = db
    .prepare(
      `SELECT m.xy_sn, m.pdd_sn, o.status_text FROM order_matches m
       JOIN orders o ON o.order_sn = m.pdd_sn
       JOIN xianyu_orders x ON x.xy_sn = m.xy_sn
       WHERE m.decision IN ('auto','manual') AND x.status = '待发货'
         AND o.status_text NOT LIKE '%待收货%' AND o.status_text NOT LIKE '%已签收%' LIMIT ${Number(limit)}`,
    )
    .all()
  for (const row of notShipped) {
    push('info', 'match_not_shipped', '已匹配但来源未发货', `闲鱼 ${row.xy_sn} ← ${row.pdd_sn}（${row.status_text}），先别导发货模板`, {
      xySn: row.xy_sn,
      orderSn: row.pdd_sn,
    })
  }

  // 5) 来源已发货但没运单号
  const noTracking = db
    .prepare(
      `SELECT order_sn, platform, status_text FROM orders
       WHERE (status_text LIKE '%待收货%' OR status_text LIKE '%已签收%') AND (tracking_no IS NULL OR tracking_no = '')
       LIMIT ${Number(limit)}`,
    )
    .all()
  for (const row of noTracking) push('warn', 'missing_tracking', '已发货但没运单号', `${row.platform} ${row.order_sn}（${row.status_text}）`, { orderSn: row.order_sn })

  // 6) 闲鱼待发货但没对上任何来源单（真正要人处理的）
  const unmatchedTodo = db
    .prepare(
      `SELECT x.xy_sn, x.receiver, x.item_title FROM xianyu_orders x
       LEFT JOIN order_matches m ON m.xy_sn = x.xy_sn
       WHERE x.status = '待发货' AND (m.xy_sn IS NULL OR m.decision = 'unmatched') LIMIT ${Number(limit)}`,
    )
    .all()
  for (const row of unmatchedTodo) push('warn', 'xianyu_unmatched', '闲鱼待发货未匹配', `${row.xy_sn}（${row.receiver || '—'}）`, { xySn: row.xy_sn })

  // 7) 来源单缺收货信息
  const missingReceiver = db
    .prepare(
      `SELECT order_sn, platform FROM orders
       WHERE (receiver_phone IS NULL OR receiver_phone = '' OR address IS NULL OR address = '') LIMIT ${Number(limit)}`,
    )
    .all()
  for (const row of missingReceiver) push('warn', 'missing_receiver', '缺收货人/地址', `${row.platform} ${row.order_sn}`, { orderSn: row.order_sn })

  // 8) 下单日期和下单时间对不上（order_date 是查询口径，错了会漏单）
  const badDate = db
    .prepare(
      `SELECT order_sn, order_date, order_time FROM orders
       WHERE order_time <> '' AND order_date <> substr(order_time, 1, 10) LIMIT ${Number(limit)}`,
    )
    .all()
  for (const row of badDate) push('error', 'date_mismatch', '下单日期与时间不一致', `${row.order_sn}: ${row.order_date} vs ${row.order_time}`, { orderSn: row.order_sn })

  // 9) 运单号格式可疑（含字母/空格/过短）
  const oddTracking = db
    .prepare(
      `SELECT order_sn, tracking_no FROM orders
       WHERE tracking_no <> '' AND (length(tracking_no) < 8 OR tracking_no GLOB '*[^0-9A-Za-z-]*') LIMIT ${Number(limit)}`,
    )
    .all()
  for (const row of oddTracking) push('warn', 'odd_tracking', '运单号格式可疑', `${row.order_sn}: ${row.tracking_no}`, { orderSn: row.order_sn })

  // 10) 人工指定的匹配，如果手机号与来源不一致，提示一下（可能是绑错了）
  const manualMismatch = db
    .prepare(
      `SELECT m.xy_sn, m.pdd_sn, x.phone AS xy_phone, o.receiver_phone AS src_phone
       FROM order_matches m
       JOIN xianyu_orders x ON x.xy_sn = m.xy_sn
       JOIN orders o ON o.order_sn = m.pdd_sn
       WHERE m.decision = 'manual' AND x.phone <> '' AND o.receiver_phone <> '' AND x.phone <> o.receiver_phone
       LIMIT ${Number(limit)}`,
    )
    .all()
  for (const row of manualMismatch) {
    push('info', 'manual_phone_diff', '人工匹配的手机号不一致', `闲鱼 ${row.xy_sn}(${row.xy_phone}) ← ${row.pdd_sn}(${row.src_phone})`, {
      xySn: row.xy_sn,
      orderSn: row.pdd_sn,
    })
  }

  findings.sort((a, b) => (SEVERITY[b.severity] || 0) - (SEVERITY[a.severity] || 0))
  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1
  return {
    ok: counts.error === 0,
    total: findings.length,
    counts,
    summary: counts.error
      ? `${counts.error} 个错误、${counts.warn} 个提醒`
      : counts.warn
        ? `无错误，${counts.warn} 个提醒`
        : '没有发现问题',
    findings,
  }
}
