/**
 * 关键词的**产品线归属**（v69，F-5 的 B 半）。
 *
 * ## 为什么这张表存在
 *
 * `kw_master.product_line` / `product_line_matched` / `product_lines_json` 都是
 * `recomputeMaster` 对 facts 的**派生值**：每次导入整层重写，一个列都不放过。往那三列
 * 写人工值会在下一次导入**静默消失** —— 没有报错、没有提示，运营会以为系统丢了他们的
 * 工作（`tests/t77-keyword-bulk.mjs` ⑦ 号断言是这件事的实证）。这与 v33 把生命周期
 * 状态独立成 `keyword_lifecycle` 是同一个结构性理由，所以这里用同一套形状：
 * 当前值一张表（`keyword_product_line`）+ 追加事件一张表（`keyword_product_line_event`）。
 *
 * ## 一条口径，一个读口
 *
 * 生效值 = **人工值 > 派生值**，三档来源：
 *
 *   | 条件 | source | 页面写 |
 *   | --- | --- | --- |
 *   | 人工行且 `product_line_id` 非空 | `manual` | 「值 · 人工」+ by/reason/时间 |
 *   | 无人工行（或已撤销）且 `product_line_matched` 非空 | `derived` | 「值 · 自动」+ 命中信号 |
 *   | 无人工行（或已撤销）且 `product_line_matched` 为 NULL | `unclassified` | 「未分类（暂无信号）· 自动」 |
 *
 * **`unclassified` 不是「属于默认线」。** 派生侧的单一标签是分类器按
 * `PRODUCT_LINE_ORDER` 仲裁出来的，未分类的词只是「没有信号命中，于是落到默认线
 * bench-cushion」—— 把这两件事印成同一句话，正是这个 bug 最开始的样子。
 *
 * 这个判定**只能在这个文件的 `effectiveProductLine` 里**：页面、路由、工具三处都调它，
 * 任何一处自己写 `COALESCE(人工, 派生)` 就是第二份口径（t78 ⑩ 是源码级断言）。
 *
 * ## 批量：与生命周期共用同一套骨架
 *
 * 上限、坏项拒收、筛选词表（`queryMaster` 的词汇表）、选区进事件行、`dryRun` 与执行
 * 同函数 —— 全部与 `setKeywordLifecycleBatch` 共用实现（`normalizeBatchKeywords` /
 * `normalizeBatchFilter` / `batchSelectionEvidence`）。这里只写两件生命周期的批量没有的
 * 事：**产品线 id 必须存在**、**「已经在目标值」按人工值判断**（含撤销）。
 *
 * ## 迁移不回填
 *
 * 迁移只建表。今天 30,778 条词的归属全是分类器的推导结果，**没有人**做过这个决定；
 * 把推导盖章成人工会让「未分类」永久不可见、并且冻结分类器。需要「确认当前派生值」时
 * 走显式的人工动作（带 by + reason），不是迁移。
 */

import { randomUUID } from 'node:crypto'

import { keywordKey } from '../domain/keywords/key.js'
import { nowIso } from './db.js'
import { queryMaster } from './kw.js'
import {
  batchSelectionEvidence, normalizeBatchFilter, normalizeBatchKeywords,
} from './keyword-lifecycle.js'

/**
 * 一次批量最多改多少词。
 *
 * 数值与生命周期的 500 相同，但**含义不同**：那边是「一次流转」，这里是「一次归属裁决」。
 * 上限的执行只有一处（`normalizeBatchKeywords`），这里给数字是因为两个入口各有自己的
 * 公开常量（各自的工具描述里要写自己的上限）。
 */
export const KEYWORD_PRODUCT_LINE_BATCH_MAX = 500

/** 归属决定的来源闭集。第一期只有 `manual` —— 机器不该通过这个入口写归属。 */
export const KEYWORD_PRODUCT_LINE_SOURCES = ['manual']

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function marketOf(value) {
  const market = String(value ?? '').trim().toUpperCase()
  if (market === '') throw new Error('marketplace is required')
  return market
}

function keywordOf(value) {
  const keyword = keywordKey(value)
  if (keyword === '') throw new Error('keyword is required')
  return keyword
}

/**
 * 归属的**唯一读口**。
 *
 * 词不在总库里 → `null`（不是 `unclassified`：「这不是总库里的词」与「这个词没分类」
 * 是两件事）。调用方拿到 null 就该说「不在总库」，不要印一个空的产品线。
 *
 * @returns {null | { keyword: string, marketplace: string, value: string,
 *                    source: 'manual'|'derived'|'unclassified',
 *                    matched: string|null, productLines: string[],
 *                    manual: {productLineId: string, by: string|null, reason: string|null,
 *                             changedAt: string, evidence: object|null}|null,
 *                    revoked: boolean }}
 */
export function effectiveProductLine(store, { keyword, marketplace } = {}) {
  const key = keywordOf(keyword)
  const market = marketOf(marketplace)
  const master = store.get(
    `SELECT keyword, product_line, product_line_matched, product_lines_json
       FROM kw_master WHERE keyword = ? AND marketplace = ?`,
    [key, market],
  )
  if (master === undefined) return null

  /* 行读取走 `getProductLineDecision` —— 同一个读口，单条与按页批量不会各写一份 SELECT。 */
  const decision = getProductLineDecision(store, { keyword: key, marketplace: market })
  /* 判定只有 `resolveProductLine` 一处定义 —— 单条读口与按页批量读口都走它，
     否则「读一个词」与「读一页词」迟早给出两个答案。 */
  return { ...resolveProductLine(master, decision), marketplace: market }
}

/**
 * 一页词（100 行）的归属 —— 页面「产品线」列用。
 *
 * 与 `effectiveProductLine` 同一条口径，只是批量读：一条查人工行、一条查 master 行。
 * 不做成「每行调一次 effectiveProductLine」是因为那会是 100 次查询；口径本身仍然只有
 * `resolveProductLine` 这一处（见下面的内部函数），两个入口都走它。
 */
export function listEffectiveProductLines(store, { keywords = [], marketplace } = {}) {
  const market = marketOf(marketplace)
  const words = [...new Set((Array.isArray(keywords) ? keywords : []).map(entry => keywordKey(entry)).filter(entry => entry !== ''))]
  const out = new Map()
  if (words.length === 0) return out
  const placeholders = words.map(() => '?').join(', ')
  const masters = store.all(
    `SELECT keyword, product_line, product_line_matched, product_lines_json
       FROM kw_master WHERE marketplace = ? AND keyword IN (${placeholders})`,
    [market, ...words],
  )
  const decisions = new Map(store.all(
    `SELECT * FROM keyword_product_line WHERE marketplace = ? AND keyword IN (${placeholders})`,
    [market, ...words],
  ).map(row => [row.keyword, row]))
  for (const master of masters) {
    out.set(master.keyword, resolveProductLine(master, decisions.get(master.keyword)))
  }
  return out
}

/** 唯一的归属判定（`effectiveProductLine` 与 `listEffectiveProductLines` 共用）。
 *  `decision` 可以是 `null`（没人决定过）或一行（可能有值、也可能是撤销）。 */
function resolveProductLine(master, decision) {
  const productLines = parseJson(master.product_lines_json, [])
  const matched = master.product_line_matched ?? null
  const hasDecision = decision !== null && decision !== undefined
  const manualValue = hasDecision ? (decision.product_line_id ?? null) : null
  if (manualValue !== null) {
    return {
      keyword: master.keyword,
      value: manualValue,
      source: 'manual',
      matched,
      productLines,
      manual: {
        productLineId: manualValue,
        by: decision.changed_by ?? null,
        reason: decision.reason ?? null,
        changedAt: decision.changed_at,
        evidence: parseJson(decision.evidence_json, null),
      },
      revoked: false,
    }
  }
  return {
    keyword: master.keyword,
    value: master.product_line ?? null,
    source: matched === null ? 'unclassified' : 'derived',
    matched,
    productLines,
    manual: null,
    revoked: hasDecision,
  }
}

/**
 * 三档计数（页面的三格）。**同一个口径**，只是聚合：
 *
 *   - `manual`       人工行且值非空
 *   - `derived`      无人工行（或已撤销）且信号命中
 *   - `unclassified` 无人工行（或已撤销）且**没有**信号命中
 *   - `revoked`      人工撤销过的行数（它计入 derived / unclassified，单列出来是为了可查）
 *
 * `unclassified` 在迁移刚落表、还没人写过人工值时必须等于
 * `COUNT(kw_master.product_line_matched IS NULL)` —— 也就是页面原来那个 3,386。
 * 不等就是回填了（或口径写错了），t78 ② 钉这一条。
 */
export function productLineCounts(store, { marketplace } = {}) {
  const market = marketOf(marketplace)
  const row = store.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN p.product_line_id IS NOT NULL THEN 1 ELSE 0 END) AS manual,
            SUM(CASE WHEN p.product_line_id IS NULL AND m.product_line_matched IS NOT NULL THEN 1 ELSE 0 END) AS derived,
            SUM(CASE WHEN p.product_line_id IS NULL AND m.product_line_matched IS NULL THEN 1 ELSE 0 END) AS unclassified,
            SUM(CASE WHEN p.keyword IS NOT NULL AND p.product_line_id IS NULL THEN 1 ELSE 0 END) AS revoked
       FROM kw_master m
       LEFT JOIN keyword_product_line p
         ON p.keyword = m.keyword AND p.marketplace = m.marketplace
      WHERE m.marketplace = ?`,
    [market],
  )
  const num = value => Number(value ?? 0)
  return {
    marketplace: market,
    total: num(row?.total),
    manual: num(row?.manual),
    derived: num(row?.derived),
    unclassified: num(row?.unclassified),
    revoked: num(row?.revoked),
  }
}

/** 产品线下拉：id + 名字。页面不自己拼第二份清单。 */
export function productLineOptions(store, { limit = 200 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500)
  return store
    .all('SELECT id, name FROM product_line ORDER BY name COLLATE NOCASE ASC LIMIT ?', [cap])
    .map(row => ({ id: row.id, name: row.name }))
}

/** 一次归属裁决的元信息：编辑前它是什么。审计的 before 与事件的 from 都要它。 */
export function getProductLineDecision(store, { keyword, marketplace } = {}) {
  const row = store.get(
    'SELECT * FROM keyword_product_line WHERE keyword = ? AND marketplace = ?',
    [keywordOf(keyword), marketOf(marketplace)],
  )
  if (row === undefined) return null
  return {
    ...row,
    productLineId: row.product_line_id ?? null,
    evidence: parseJson(row.evidence_json, null),
  }
}

/** 这个词的归属历史，oldest first。`to_product_line_id` 为 null = 撤销。 */
export function keywordProductLineHistory(store, { keyword, marketplace } = {}) {
  return store.all(
    `SELECT * FROM keyword_product_line_event
      WHERE keyword = ? AND marketplace = ?
      ORDER BY at ASC, rowid ASC`,
    [keywordOf(keyword), marketOf(marketplace)],
  ).map(row => ({ ...row, evidence: parseJson(row.evidence_json, null) }))
}

/** 目标产品线必须真的存在 —— 写一个不存在的 id 会让归属查询返回空而不是报错。 */
function targetOf(store, to) {
  if (to === null) return null
  const id = String(to ?? '').trim()
  if (id === '') throw new Error('to is required — pass a product line id, or null to revoke the manual decision')
  const row = store.get('SELECT id, name FROM product_line WHERE id = ?', [id])
  if (row === undefined) {
    throw new Error(
      `no product line "${id}" — nothing was written. Known ids: `
      + store.all('SELECT id FROM product_line ORDER BY id').map(entry => entry.id).join(' / '),
    )
  }
  return row.id
}

function requiredText(value, what, why) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error(`${what} is required — ${why}`)
  return text
}

/** 一次归属变更的两条写，不加事务（调用方包）。 */
function writeDecision(store, { keyword, marketplace, from, to, reason, evidence, by }) {
  const at = nowIso()
  const eventId = randomUUID()
  store.run(
    `INSERT INTO keyword_product_line
       (keyword, marketplace, product_line_id, source, reason, evidence_json, changed_at, changed_by, created_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)
     ON CONFLICT(keyword, marketplace) DO UPDATE SET
       product_line_id = excluded.product_line_id,
       source = excluded.source,
       reason = excluded.reason,
       evidence_json = excluded.evidence_json,
       changed_at = excluded.changed_at,
       changed_by = excluded.changed_by`,
    [keyword, marketplace, to, reason ?? null, evidence === null ? null : JSON.stringify(evidence), at, by ?? null, at],
  )
  store.run(
    `INSERT INTO keyword_product_line_event
       (id, keyword, marketplace, from_product_line_id, to_product_line_id, source, reason, evidence_json, at, by)
     VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
    [eventId, keyword, marketplace, from, to, reason ?? null, evidence === null ? null : JSON.stringify(evidence), at, by ?? null],
  )
  return { keyword, marketplace, from, to, eventId, at }
}

/**
 * UUID：与 keyword-lifecycle.js 同一个做法（`node:crypto` 的 `randomUUID`），不引第三方。
 */

/**
 * 把最多 {@link KEYWORD_PRODUCT_LINE_BATCH_MAX} 个词的人工归属改成一条产品线（或撤销）。
 *
 * 与 `setKeywordLifecycleBatch` 同一套骨架：命名唯一选区、全量校验、一个事务写 N 条、
 * 选区进事件行、`dryRun` 只回计划。两处**不同**的地方，都是这张表的事：
 *
 *   1. `to` 是**产品线 id**（或 `null` = 撤销），未知 id 整批拒绝并列出已知 id；
 *   2. 「已经在目标值」按**当前人工值**判断：显式词表里有一个词的人工值已经等于 `to`
 *      → 整批拒绝（不是静默成功）；按筛选选时这些词被排除并计入 `alreadyAtTarget`。
 *
 * @returns {{ to: string|null, marketplace: string, dryRun: boolean,
 *             selection: object, applied: Array, wouldApply: Array, eventIds: string[],
 *             remaining: number }}
 */
export function setKeywordProductLineBatch(store, {
  keywords = null,
  filter = null,
  marketplace,
  to,
  reason = null,
  by = null,
  evidence = null,
  dryRun = false,
} = {}) {
  const market = marketOf(marketplace)
  if (to === undefined) {
    throw new Error('to is required — pass a product line id, or null to revoke the manual decision')
  }
  const target = targetOf(store, to)
  const decisionBy = requiredText(by, 'by', 'a product line assignment is a human decision, and an unattributed one is not one')
  const decisionReason = requiredText(reason, 'reason', 'a product line assignment has to say why, or it cannot be reviewed later')

  const hasKeywords = keywords !== null && keywords !== undefined
  const hasFilter = filter !== null && filter !== undefined
  if (hasKeywords === hasFilter) {
    throw new Error(
      'name exactly one selection: `keywords` (the words you ticked) or `filter` '
      + '(the current filter, resolved on the server) — both at once leaves it ambiguous '
      + 'which one was the decision',
    )
  }

  let selection
  if (hasKeywords) {
    const words = normalizeBatchKeywords(keywords, KEYWORD_PRODUCT_LINE_BATCH_MAX)
    selection = { kind: 'keywords', filter: null, words, matched: words.length, alreadyAtTarget: 0 }
  } else {
    const clean = normalizeBatchFilter(filter)
    const matched = Number(queryMaster(store, { ...clean, marketplace: market, limit: 1, offset: 0 }).total)
    const words = []
    let alreadyAtTarget = 0
    let offset = 0
    while (words.length < KEYWORD_PRODUCT_LINE_BATCH_MAX) {
      const page = queryMaster(store, { ...clean, marketplace: market, order: 'keyword', limit: 1000, offset })
      if (page.rows.length === 0) break
      const current = listEffectiveProductLines(store, {
        keywords: page.rows.map(row => row.keyword), marketplace: market,
      })
      for (const row of page.rows) {
        const entry = current.get(row.keyword)
        /* 「已经在目标值」= 人工值已经等于 to（撤销时 to 是 null，则「没有人工值」即为已达到）。 */
        const manualValue = entry === undefined || entry.manual === null ? null : entry.manual.productLineId
        if (manualValue === target) { alreadyAtTarget += 1; continue }
        words.push(row.keyword)
        if (words.length === KEYWORD_PRODUCT_LINE_BATCH_MAX) break
      }
      offset += page.rows.length
      if (offset >= page.total) break
    }
    if (matched === 0) {
      throw new Error(
        'nothing to change: this filter matches no word — the filter was '
        + JSON.stringify(clean) + ' (recorded here so a wrong filter is visible, not silent)',
      )
    }
    if (words.length === 0) {
      throw new Error(
        `nothing to change: all ${matched} word(s) this filter matches already have the target value — `
        + 'no assignment changed, so no history is written',
      )
    }
    selection = { kind: 'filter', filter: clean, words, matched, alreadyAtTarget }
  }

  const words = selection.words
  const present = new Set(store.all(
    `SELECT keyword FROM kw_master WHERE marketplace = ? AND keyword IN (${words.map(() => '?').join(', ')})`,
    [market, ...words],
  ).map(row => row.keyword))
  const missing = words.filter(word => !present.has(word))
  if (missing.length > 0) {
    throw new Error(`these keywords are not in the ${market} master library, so nothing was written: ${missing.join(', ')}`)
  }

  const current = new Map(store.all(
    `SELECT keyword, product_line_id FROM keyword_product_line
      WHERE marketplace = ? AND keyword IN (${words.map(() => '?').join(', ')})`,
    [market, ...words],
  ).map(row => [row.keyword, row.product_line_id ?? null]))

  const already = []
  for (const word of words) {
    if ((current.get(word) ?? null) === target) already.push(word)
  }
  if (already.length > 0) {
    throw new Error(
      target === null
        ? `these keywords have no manual decision to revoke, so nothing was written: ${already.join(', ')}`
        : `these keywords already have ${target} as their manual product line, so there is no change and nothing was written: ${already.join(', ')}`,
    )
  }

  const evidenceRow = batchSelectionEvidence(
    { ...selection, selected: words.length },
    { to: target, marketplace: market },
    evidence,
  )
  const plan = words.map(word => ({ keyword: word, from: current.get(word) ?? null }))
  const remaining = selection.kind === 'filter'
    ? Math.max(0, selection.matched - selection.alreadyAtTarget - words.length)
    : 0

  if (dryRun === true) {
    return {
      to: target,
      marketplace: market,
      dryRun: true,
      selection: { ...selection, selected: words.length },
      applied: [],
      wouldApply: plan,
      eventIds: [],
      remaining,
    }
  }

  const eventIds = store.tx(() => {
    const ids = []
    for (const entry of plan) {
      ids.push(writeDecision(store, {
        keyword: entry.keyword,
        marketplace: market,
        from: entry.from,
        to: target,
        reason: decisionReason,
        evidence: evidenceRow,
        by: decisionBy,
      }).eventId)
    }
    return ids
  })

  return {
    to: target,
    marketplace: market,
    dryRun: false,
    selection: { ...selection, selected: words.length },
    applied: plan,
    wouldApply: [],
    eventIds,
    remaining,
  }
}
