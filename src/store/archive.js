/**
 * ASIN 归档与恢复（模块 05 F05-08）—— 状态在 `asin` 的三列上，历史在
 * `asin_archive_event` 里。
 *
 * ## 为什么归档不是删除
 *
 * 误售停用商品不得删除（模块设计 §3.8 原话），一律走归档：行留着、历史留着、
 * 草案与报告只读可查，只是从默认列表里消失、且不再接受新的写入。删除只留给
 * 「导入错误且没有任何下游引用」的记录，而且那一半本批**没有实现** —— 一个没有
 * 引用检查的删除入口，比没有删除入口危险得多。
 *
 * ## 三列是当前状态，事件表是历史
 *
 * 恢复把 `archived_at/archive_reason/archived_by` 清成 NULL（默认列表读的就是
 * `archived_at`），而「什么时候归档的、为什么、谁恢复的」全部留在事件表里。
 * 若给恢复加一个 `restored_at` 列，那么「现在是不是归档的」就要再读一列才能回答，
 * 而任何一个读错的地方都会让一条已归档的记录重新出现在默认列表里 —— 而这正是
 * 归档这件事最不该出错的地方。
 *
 * ## 影响预览为什么在这里算
 *
 * 「活跃草案 N 份 / 进行中观测 M 个 / 所属竞品组 K 个」是归档**之前**要给人看的
 * 数字，它同时也会被写进事件行：归档之后那些对象可能已经不存在了，事后想复盘
 * 「当时的判断依据」就只剩这一份记录。预览与执行调**同一个函数**，所以预览说的数字
 * 与写进事件行的数字不可能不一致（两份实现迟早分叉，然后「预览说 2 份、实际拦了 3 份」）。
 */

import { randomUUID } from 'node:crypto'

import { nowIso } from './db.js'
import { OBSERVATION_STATUSES } from '../domain/observe/observation.js'
import { asinCascadeTables, asinReferenceReport, competitorSetsContaining } from '../domain/asin/archive-refs.js'

/**
 * 三个方向，三个字面值。一个布尔 flag 回答不了「谁把它藏起来/放回来/删掉了」。
 *
 * `delete` 与前两个不是一类：archive 与 restore 是可逆的两次状态改变，
 * delete 是本仓**唯一不可恢复**的动作，所以它独立一个值、独立一个确认开关、
 * 独立一条审计动作（`asin.delete`）。
 */
export const ASIN_ARCHIVE_ACTIONS = ['archive', 'restore', 'delete']

/**
 * 「进行中的观测」用的状态集。
 *
 * 终态三值是**从 domain/observe 的闭集里减出来的**，不是手抄的一份：闭集里新增一个
 * 状态时，它默认落进「进行中」（预览多报一个 > 少报一个），而 `concluded/terminated/
 * retired` 三个永远不在里面。这里没有 import 那个模块自己的终态常量，因为它没有导出；
 * 少导出一个常量不该变成一次沉默的少报，所以方向选的是「默认算进行中」。
 */
const OBSERVATION_TERMINAL = ['concluded', 'terminated', 'retired']
export const OPEN_OBSERVATION_STATUSES = OBSERVATION_STATUSES.filter(status => !OBSERVATION_TERMINAL.includes(status))

function asinOf(value) {
  const asin = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`asin "${value}" is not a 10-character ASIN`)
  return asin
}

function marketplaceOf(value) {
  const marketplace = String(value ?? '').trim().toUpperCase()
  if (marketplace === '') throw new Error('marketplace is required')
  return marketplace
}

function blankToNull(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/** The raw `asin` row, or `undefined`. Read through the same key every other writer uses. */
export function getAsinRow(store, asin, marketplace) {
  return store.get('SELECT * FROM asin WHERE asin = ? AND marketplace = ?', [asinOf(asin), marketplaceOf(marketplace)])
}

/** 归档状态是**一个列**的回答：`archived_at` 非空 = 现在被归档。 */
export function isAsinArchived(store, { asin, marketplace } = {}) {
  const row = getAsinRow(store, asin, marketplace)
  return row !== undefined && row.archived_at !== null && row.archived_at !== undefined
}

/**
 * 归档会影响什么 —— 归档前要给人看的数字，也是写进事件行的那一份。
 *
 * 分两组，因为这个区分本身就是信息：**会被挡住的**（活跃草案 / 进行中观测 /
 * 所属竞品组）与**保持只读可查的**（历史快照 / 关键词覆盖 / 发布记录）。只报前一组
 * 会让人以为归档要带走历史，只报后一组会让「影响预览」这个名字没有内容。
 */
export function archiveImpact(store, { asin, marketplace } = {}) {
  const key = asinOf(asin)
  const market = marketplaceOf(marketplace)

  /* ★ 「不在库内」不是「影响面是 0」。预览一条不存在的 ASIN 会返回四个 0，而那与
     「这条 ASIN 存在、什么都没挂着」在页面上长得一模一样 —— 一个不存在的对象被报成
     「影响为 0」，正是本仓一直在拒绝的那件事（缺失被渲染成一个像值的东西）。
     归档与恢复本来就要求这个坐标存在（archiveAsin / restoreAsin 抛同一句话），
     所以这里也抛：路由把它转成 400，工具把它转成 {ok:false}。 */
  if (getAsinRow(store, key, market) === undefined) {
    const error = new Error(`no ASIN ${key}@${market} in the library —— 影响预览不回答「不存在的对象影响面是 0」`)
    error.code = 'ASIN_NOT_FOUND'
    throw error
  }

  /* 活跃草案 = 还没被人裁决过的草案（`accepted IS NULL`）。已采纳/已否决的草案是
     历史的一部分，不构成「归档会挡住谁正在做的事」。 */
  const drafts = Number(store.get(
    `SELECT COUNT(*) AS n FROM optimization_draft d
       JOIN optimization_run r ON r.id = d.run_id
      WHERE r.asin = ? AND r.marketplace = ? AND d.accepted IS NULL`,
    [key, market],
  )?.n ?? 0)
  const runs = Number(store.get(
    'SELECT COUNT(*) AS n FROM optimization_run WHERE asin = ? AND marketplace = ?',
    [key, market],
  )?.n ?? 0)

  /* 进行中的观测是**两跳**的：检查点 → 发布记录 → ASIN。检查点自己没有 asin 列，
     从检查点推 ASIN 只能靠发布记录。 */
  const observationPlaceholders = OPEN_OBSERVATION_STATUSES.map(() => '?').join(',')
  const observations = OBSERVATION_STATUSES.length === 0 || OPEN_OBSERVATION_STATUSES.length === 0
    ? 0
    : Number(store.get(
      `SELECT COUNT(*) AS n FROM observation_checkpoint c
         JOIN publication_record p ON p.id = c.publication_id
        WHERE p.asin = ? AND p.marketplace = ? AND c.status IN (${observationPlaceholders})`,
      [key, market, ...OPEN_OBSERVATION_STATUSES],
    )?.n ?? 0)

  /* 竞品组的成员关系读 `domain/asin/archive-refs.js` 的 `competitorSetsContaining` ——
     **唯一一处**「这个 ASIN 属不属于这个竞品组」的实现。受限删除的引用检查读同一份，
     所以「归档预览说它在 2 个竞品组里」与「删除检查说它在 2 个竞品组里」不可能是两个数
     （两份实现迟早分叉，然后用户按一份的数做决定、被另一份拦住）。 */
  const competitorSets = competitorSetsContaining(store, { asin: key, marketplace: market })

  const snapshots = Number(store.get(
    'SELECT COUNT(*) AS n FROM asin_snapshot WHERE asin = ? AND marketplace = ?', [key, market],
  )?.n ?? 0)
  const keywords = Number(store.get(
    'SELECT COUNT(*) AS n FROM asin_keyword WHERE asin = ? AND marketplace = ?', [key, market],
  )?.n ?? 0)
  const publications = Number(store.get(
    'SELECT COUNT(*) AS n FROM publication_record WHERE asin = ? AND marketplace = ?', [key, market],
  )?.n ?? 0)

  return {
    asin: key,
    marketplace: market,
    /* 会被挡住的 */
    drafts,
    runs,
    observations,
    competitorSets,
    competitorSetCount: competitorSets.length,
    /* 保持只读可查的 */
    snapshots,
    keywords,
    publications,
    blocked: [
      { id: 'drafts', label: '活跃优化草案', count: drafts, effect: '不可新建、不可继续' },
      { id: 'observations', label: '进行中观测', count: observations, effect: '不可新建观测节点' },
      { id: 'competitorSets', label: '所属竞品组', count: competitorSets.length, effect: '成员关系不变，分析仍可读' },
    ],
    readable: [
      { id: 'snapshots', label: '历史快照', count: snapshots },
      { id: 'keywords', label: '关键词覆盖', count: keywords },
      { id: 'publications', label: '发布记录', count: publications },
    ],
  }
}

/**
 * 归档一条 ASIN。
 *
 * 幂等：已经归档的行再归档一次返回 `{changed: false}`，**不动**原时间戳 ——
 * 那个时间戳记的是「什么时候被藏起来的」，重盖一次就是撒谎（与
 * `archiveSnapshot` 同一条规矩）。事件行只在真的改变时追加。
 *
 * 不存在的行**抛错**，而不是安静地写一条事件：归档一条不在库里的 ASIN，
 * 是「以为做完了一件事」的典型形态。
 */
export function archiveAsin(store, { asin, marketplace, reason = null, by = null, impact = null } = {}) {
  const key = asinOf(asin)
  const market = marketplaceOf(marketplace)
  const row = getAsinRow(store, key, market)
  if (row === undefined) throw new Error(`no ASIN ${key}@${market} in the library`)

  if (row.archived_at !== null && row.archived_at !== undefined) {
    return { changed: false, before: row, after: row, impact: null }
  }

  /* 预览与执行共用一份影响面：调用方不给就先算一遍，写进事件行的是**这一份**。 */
  const face = impact ?? archiveImpact(store, { asin: key, marketplace: market })
  const at = nowIso()
  store.tx(() => {
    store.run(
      'UPDATE asin SET archived_at = ?, archive_reason = ?, archived_by = ? WHERE asin = ? AND marketplace = ?',
      [at, blankToNull(reason), blankToNull(by), key, market],
    )
    store.run(
      `INSERT INTO asin_archive_event (id, asin, marketplace, action, reason, impact_json, at, by)
       VALUES (?, ?, ?, 'archive', ?, ?, ?, ?)`,
      [`asin-archive-${randomUUID()}`, key, market, blankToNull(reason), JSON.stringify(face), at, blankToNull(by)],
    )
  })
  return { changed: true, before: row, after: getAsinRow(store, key, market), impact: face }
}

/**
 * 恢复：回到 active，并清掉三个归档列。
 *
 * 「重新进入数据新鲜度检查」不需要在这里做任何事 —— 新鲜度是**算出来的**
 * （`domain/data/freshness.js` 读 `observed_at`），不是一个被恢复动作翻回来的标志位。
 * 一个需要「恢复时重置」的新鲜度状态，就是一份会过期的第二真相。
 */
export function restoreAsin(store, { asin, marketplace, reason = null, by = null } = {}) {
  const key = asinOf(asin)
  const market = marketplaceOf(marketplace)
  const row = getAsinRow(store, key, market)
  if (row === undefined) throw new Error(`no ASIN ${key}@${market} in the library`)
  if (row.archived_at === null || row.archived_at === undefined) {
    return { changed: false, before: row, after: row }
  }

  const at = nowIso()
  store.tx(() => {
    store.run(
      'UPDATE asin SET archived_at = NULL, archive_reason = NULL, archived_by = NULL WHERE asin = ? AND marketplace = ?',
      [key, market],
    )
    /* 恢复不写 impact：归档的影响面是「拦住了谁」，恢复不拦任何人，把归档时的那份
       数字抄一遍会让人以为恢复也影响那 N 份草案。 */
    store.run(
      `INSERT INTO asin_archive_event (id, asin, marketplace, action, reason, impact_json, at, by)
       VALUES (?, ?, ?, 'restore', ?, NULL, ?, ?)`,
      [`asin-archive-${randomUUID()}`, key, market, blankToNull(reason), at, blankToNull(by)],
    )
  })
  return { changed: true, before: row, after: getAsinRow(store, key, market) }
}

/** 一条 ASIN 的归档/恢复历史，最新在前。
 *
 * ★ 并列时按 `rowid DESC`：`at` 是毫秒精度，而「归档」与「恢复」可以是同一个
 * 毫秒里的两次点击。只按 `at DESC` 排，同一毫秒的两条事件顺序就由 SQLite 的
 * 返回顺序决定 —— 「最新的一条是恢复」这句话会时真时假。 */
export function listArchiveEvents(store, { asin, marketplace, limit = 50 } = {}) {
  const clauses = []
  const params = []
  if (blankToNull(asin) !== null) { clauses.push('asin = ?'); params.push(asinOf(asin)) }
  if (blankToNull(marketplace) !== null) { clauses.push('marketplace = ?'); params.push(marketplaceOf(marketplace)) }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  const bound = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), 500)
  return store
    .all(`SELECT * FROM asin_archive_event${where} ORDER BY at DESC, rowid DESC LIMIT ?`, [...params, bound])
    .map(row => ({
      id: row.id,
      asin: row.asin,
      marketplace: row.marketplace,
      action: row.action,
      reason: row.reason ?? null,
      impact: parseJson(row.impact_json, null),
      at: row.at,
      by: row.by ?? null,
    }))
}

/**
 * 全库有多少条已归档 —— **全库口径**，与任何一次筛选无关。
 *
 * ★ 读不出来时返回 **null**，不是 0。这是本仓反复付过代价的那一件事：
 * 「0 条已归档」与「这个数读不出来」在页面上必须是两句不同的话。而它现在的失败
 * 形态是**静默**的 —— 一个 0 读起来就是「一条都没归档」，没人会去查。
 * `archived_at` 是 v37 才加的列，所以「库没升到位 / 这一列被删过」是一个真实
 * 可能的失败，不是假想的。
 *
 * 吞掉异常是**有意的**：这个数只用来画一行摘要，为它让整个 ASIN 面板 500 是
 * 本末倒置（与 `domain/asin/overview.js` 的 countSafe 同一条规矩）。但吞掉之后
 * 必须留下一个「不知道」的返回值，否则就是把一次失败伪装成一个值。
 */
export function archivedAsinCount(store) {
  try {
    return Number(store.get('SELECT COUNT(*) AS n FROM asin WHERE archived_at IS NOT NULL')?.n ?? 0)
  } catch {
    return null
  }
}

/**
 * 归档即只读，在**写入处**拦，不由页面藏按钮（与 workspace 那条规则同一条）。
 *
 * 抛错而不是返回一个布尔：调用方（工具、路由、store）都要么停下来、要么把它当成
 * 一次拒绝来回报，而「返回 false 然后继续写」是这段代码唯一危险的用法。
 *
 * ## `mustExist` —— 为什么「写一条已归档的」与「新建一条」必须分开
 *
 * 这个函数原先只被「这条记录一定已经存在」的写点调用（字段修正、变体关系），所以
 * 一条不在库里的坐标**也**抛错是对的：那是调用方搞错了。但 `amzn_asin_upsert` /
 * `amzn_asin_import` 是**能新建**的写口 —— 对一个还不存在的 ASIN 调它，
 * 「不在库里」不是错误、是**正常的新建**。所以 `mustExist: false` 时：
 *
 *   · 坐标不存在 → 放行（新建一条，没有归档状态可违反）；
 *   · 坐标存在且已归档 → 仍然抛 `ASIN_ARCHIVED`。
 *
 * 默认 `true`：既有两个调用点的行为一个字节都不改（它们本来就该要求存在）。
 */
export function assertAsinWritable(store, { asin, marketplace, action = 'write', mustExist = true } = {}) {
  const key = asinOf(asin)
  const market = marketplaceOf(marketplace)
  const row = getAsinRow(store, key, market)
  if (row === undefined) {
    if (mustExist) throw new Error(`no ASIN ${key}@${market} in the library`)
    return null
  }
  if (row.archived_at !== null && row.archived_at !== undefined) {
    const error = new Error(
      `${key}@${market} 已归档（${row.archived_at}），${action} 被拒绝 —— 归档的 ASIN 是只读的，先恢复再改`,
    )
    error.code = 'ASIN_ARCHIVED'
    throw error
  }
  return row
}

/**
 * 受限删除 —— 本仓**唯一不可恢复**的动作，所以入口比其余写口窄得多。
 *
 * ## 三个条件，缺一个就拒绝
 *
 * 1. **坐标必须在库内**（不在 → `ASIN_NOT_FOUND`）。「删掉了一条不在库里的记录」是
 *    「以为做完了一件事」的典型形态（与 `archiveAsin` 同一条理由）。
 * 2. **理由非空**（空 → `ASIN_DELETE_REASON_REQUIRED`）。归档与恢复可以用理由为空蒙过去
 *    （它们可逆），删除不行：事后唯一的复盘材料就是这一格。
 * 3. **一条引用都没有**（有 → `ASIN_REFERENCED`，并把引用逐条列出来）。
 *    这是「仅限导入错误」这个窄口径的落地方式：一条被采集过、被优化过、被发布过的记录
 *    **必然**有引用，于是它删不掉 —— 而它本来就该走归档（误售停用不得删除）。
 *    引用检查是 `domain/asin/archive-refs.js`，**一份**实现。
 *
 * ## 为什么 `references` 是一个入参
 *
 * 与 `archiveAsin` 的 `impact` 同一条约定：预览与执行调**同一份**结果。
 * 调用方先跑 `delete_preview` 给人看、再带同一份进来执行，于是「预览说 0 处引用、
 * 执行却被拦住」不可能发生。
 *
 * ## 事件行与删除在同一个事务里，且事件行**先写**
 *
 * `asin_archive_event` 没有指向 `asin` 的外键，所以那条 `delete` 事件是这行记录
 * 唯一剩下的痕迹，`impact_json` 存的就是删除前**实测**的那份引用报告。
 * 顺序上先写事件再删行：这不是原子性的要求（同一事务），而是这段代码读起来
 * 就是它的语义 —— 先记账，再动手。
 */
export function deleteAsin(store, { asin, marketplace, reason = null, by = null, references = null } = {}) {
  const key = asinOf(asin)
  const market = marketplaceOf(marketplace)
  const row = getAsinRow(store, key, market)
  if (row === undefined) {
    const error = new Error(`no ASIN ${key}@${market} in the library`)
    error.code = 'ASIN_NOT_FOUND'
    throw error
  }

  const why = blankToNull(reason)
  if (why === null) {
    const error = new Error(
      `删除 ${key}@${market} 必须给出理由 —— 删除是本仓唯一不可恢复的动作，空理由不是可选项`,
    )
    error.code = 'ASIN_DELETE_REASON_REQUIRED'
    throw error
  }

  const report = references ?? asinReferenceReport(store, { asin: key, marketplace: market })
  /* ★ 覆盖不全时**先**拒绝，而且理由与「有引用」分开说：`total === 0` 在检查有洞时
     只意味着「在检查覆盖到的范围内没有引用」，那不是可以据以删除的结论。
     把它与「真的有引用」合成一句话，会让下一个人以为去清掉引用就能删。 */
  if (report.gaps.length > 0) {
    const error = new Error(
      `引用检查本身不完整，拒绝删除 ${key}@${market}：${report.gaps.join('；')}。`
      + '检查覆盖不全时「0 处引用」不是结论 —— 一次错删不可恢复',
    )
    error.code = 'ASIN_REFERENCE_CHECK_INCOMPLETE'
    error.gaps = report.gaps
    throw error
  }
  if (report.total > 0) {
    const listed = report.references.map(item => `${item.table}.${item.column} ${item.count} 行`).join('、')
    const error = new Error(
      `${key}@${market} 还有 ${report.total} 处引用（${listed}），不能删除 —— `
      + '受限删除只用于「导入错误且没有任何下游引用」的记录；误售停用的记录应当归档（归档可恢复，删除不可恢复）',
    )
    error.code = 'ASIN_REFERENCED'
    error.references = report.references
    throw error
  }

  const at = nowIso()
  store.tx(() => {
    store.run(
      `INSERT INTO asin_archive_event (id, asin, marketplace, action, reason, impact_json, at, by)
       VALUES (?, ?, ?, 'delete', ?, ?, ?, ?)`,
      [`asin-archive-${randomUUID()}`, key, market, why, JSON.stringify(report), at, blankToNull(by)],
    )
    /* 记录**自身**的状态（`kind === 'own'`：目前是 `asin_field_source` 的字段级溯源）
       跟着一起删。留着才是错的：下一次导入同一个坐标会撞上上一次的僵尸溯源行，
       而「这条字段的来源是谁」会答出一个已经不存在的写口。
       表清单从 `archive-refs.js` 的**同一张分类表**读（`asinCascadeTables`），
       不在这里再写一份 —— 两份清单分叉的形态就是「分类说该删、代码忘了删」。
       审计行（`asin_archive_event`）**不在**这张清单里，它要留下来。 */
    for (const { table, column } of asinCascadeTables()) {
      store.run(`DELETE FROM "${table}" WHERE UPPER("${column}") = ? AND marketplace = ?`, [key, market])
    }
    store.run('DELETE FROM asin WHERE asin = ? AND marketplace = ?', [key, market])
  })
  /* `after: null` —— 行没了。不是「读出来是 null 所以当空处理」：这里必须是一个
     显式的「没有 after」，否则调用方会把它当成一条还在的记录。 */
  return { changed: true, before: row, after: null, references: report }
}
