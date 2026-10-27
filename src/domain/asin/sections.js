/**
 * 一个 ASIN 的 13 节（模块 05 F05-02 的第三个标签页）—— **复用** B-04 的那一套，
 * 不重建第二份节词表、也不重建第二套五态名。
 *
 * ## 复用的是什么，逐条说清
 *
 *   · 节的 id / 顺序 / 中文名 —— `domain/collect/sections.js` 的 `COLLECTION_SECTIONS`
 *     （`COLLECTION_SECTION_IDS` 是它派生的十三个 id）；
 *   · 五态与其中文标签 —— `domain/states.js` 的 `COLLECTION_SECTION_STATES` / `COLLECTION_SECTION_LABELS`，
 *     经 `store/collection-section.js` 的 `hydrate` 落到行上（`statusLabel` 就是它给的）；
 *   · 「采到几个 / 一共几个」—— `sectionValueCounts`（同一个函数算 B-04 的节详情）；
 *   · 五态词表与判据 —— `COLLECTION_SECTION_STATES`，但计数**不调 B-04 的
 *     `sectionSummary`**：那个函数数的是行，而它的任务视角里「一个任务 × 一个节」只有
 *     一行，所以那里数行就是数节；这里跨任务，一个被重试过的节有多行，直接调它就会
 *     把同一节数两遍。这里的计数**读上面那条收敛的结果**（每节最新一行）。
 *
 * 本文件**只**新增一件 B-04 没有的事：把**跨任务**的节结果收敛成「这个 ASIN 现在
 * 每一节的最新读数」。B-04 的详情是**任务视角**的（一个任务里这个 ASIN 的 13 节），
 * 而模块 05 的详情是**对象视角**的（这个 ASIN 现在是什么情况，不管它被采过几次）。
 * 两个视角都成立，所以这里不是「再建一套」，而是换一个轴去读同一张表。
 *
 * ## 「未采集」不是五态里的任何一个
 *
 * 五态是闭集，里面没有「我们根本没看过这一节」。所以没有行的节返回
 * `status: null` + `notCollected: true`，页面画「未采集」——
 * 与 B-04 的 `buildSectionDetail` 完全同一个口径。把它算成 `missing`
 * 就是把「没人打开过页面」说成「亚马逊没有这一段」。
 *
 * ## 同一个理由：没有行的节也不带分子
 *
 * `collected` 在「没有这一节的行」时是 **null**，不是 0（T73k）。0 是一个读数
 * ——「读过，一个字段都没有」——而没有行是「没有读数」。从前这里写 0，于是页面
 * 把两种情形画成同一个 `0/N`，而它们的动作相反（去补采 vs 去查选择器）。
 * `total` 照旧是**声明清单的长度**：拿掉分母比拿掉分子更容易骗人，`0/0` 会被
 * 读成「完整」。读者据 `notCollected` 决定怎么画，不据 `collected === 0` 猜。
 * 采集面板那个入口（`domain/collect/detail.js`）逐字段同一条口径，`t73k` 钉住两端。
 *
 * ## 分母
 *
 * **分母是 13 节**（`totals.total`，清单长度，不随采过几次变），而 `summary.total`
 * 与 `totals.attempted` 回答的是另一个问题：**有几节有读数**（每节只算一次）。
 * `totals.rows` 也单列出来，它是第三个问题：这个 ASIN 一共写了多少行节结果。
 *
 * 13 节 / 采过几节 / 采过几次 —— 三个数各有各的用处，谁都不许被当成另一个印：
 * 只印「已采到 3」会让人以为这个 ASIN 只有三节；只印行数会把一次重试当成多出来的一节。
 *
 * ## 读被截断时，「未采集」必须改口
 *
 * 这一页跨任务读，所以这个 ASIN 的行数**不随采过几次封顶**：一个 ASIN 被采过 400 次
 * 就是 5 200 行，超过 `SECTION_RESULT_MAX_ROWS`（5000）—— 上限之外的节根本没有被读出来，
 * 而它们在上面那张表里长得和「库里真的一行都没有」一模一样，都是「未采集」。
 * 那是本仓最忌讳的读法：把「没读到」读成「没人采过」，动作正好相反（补采 vs 排查）。
 * 所以 `coverage` 把这次读的 `read / total / limit / truncated / note` 带出去，
 * 被截断时每一行未采集的节上还带 `readTruncated: true`，页面与工具据它改口 ——
 * 而改口用的那句话只有一份：`SECTION_READ_TRUNCATED_LABEL`。
 */

import {
  COLLECTION_SECTIONS, SECTION_BY_ID, sectionContentUnread, sectionValueCounts,
} from '../collect/sections.js'
import { COLLECTION_SECTION_LABELS, COLLECTION_SECTION_STATES } from '../states.js'
import { listSectionResultsWithCoverage } from '../../store/collection-section.js'

/* Re-exported, **not** re-declared: these are the same two bindings the
   collection panel's payload (`domain/collect/detail.js`) is built from, so a
   reader that imports them from either path is holding the one rule. They moved
   to `domain/collect/sections.js` because that is the module both readers
   already depend on — see the note there for the two-implementations defect
   that moving them fixes. */
export { SECTION_CONTENT_UNREAD_LABEL, sectionContentUnread } from '../collect/sections.js'

/**
 * What a reader prints for a section row that has no reading **only because this
 * read hit the row cap** — as opposed to a section nothing was ever collected for.
 *
 * It lives here, next to the `readTruncated` flag that selects it, for the same
 * reason the coverage `note` lives next to the numbers it is made of: the page and
 * the tool both print this row, and two hand-kept spellings of one fact is how the
 * same data ends up described two different ways with nothing failing anywhere.
 *
 * The parenthetical is part of the label on purpose. On its own, "未读到" is read as
 * a synonym for "未采集" by anyone who has not seen the truncation banner, and the
 * two rows call for opposite actions — re-collect the section vs. go and find out
 * why the read stopped short.
 */
export const SECTION_READ_TRUNCATED_LABEL = '未读到（不是未采集）'

/* The "saw it and could not read it" marker — `SECTION_CONTENT_UNREAD_LABEL` and
   the `sectionContentUnread` rule that selects it — is **not declared here any
   more**; it is imported from `domain/collect/sections.js` and re-exported above.

   It used to live here, and that is how it grew a second implementation: this
   file's builder (`buildSectionView`) put the computed boolean on every entry,
   but the collection panel's builder (`domain/collect/detail.js`) did not, so
   `page.js` recomputed the rule inline for that one call site. Breaking the rule
   then turned the tool's assertion red and left the page's assertion green —
   the page had quietly fallen back to its own copy, and nothing failed.

   The parenthetical in the label is load-bearing: without it "没读到" is read as
   a synonym for `SECTION_READ_TRUNCATED_LABEL` above, and the two call for
   different actions (go fix the reader vs. go widen the read window). */

/** 「最新的那一行」按采集时间排，没有采集时间的排最后（它不是更新，只是不知道什么时候）。 */
function newerFirst(left, right) {
  const leftAt = String(left.collectedAt ?? '')
  const rightAt = String(right.collectedAt ?? '')
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1
  return String(right.taskId ?? '').localeCompare(String(left.taskId ?? ''))
}

export function buildSectionView(store, { asin, marketplace } = {}) {
  const key = String(asin ?? '').trim().toUpperCase()
  const market = String(marketplace ?? '').trim().toUpperCase()
  const read = listSectionResultsWithCoverage(store, { asin: key, marketplace: market })
  const rows = read.rows

  /* 同一节可以在多个任务里各有一行。取最新的一行作为「现在的读数」，并记下它属于哪个
     任务 —— 那个任务 id 是「这个值是哪一次采集得来的」唯一的答案。 */
  const bySection = new Map()
  for (const row of rows) {
    const found = bySection.get(row.section)
    if (found === undefined || newerFirst(row, found) < 0) bySection.set(row.section, row)
  }

  /* 被截断时，「这一节没有行」有两个原因，而它们要给相反的动作。别靠猜 —— 直接问库里
     有哪几节真的有行（只取 section 一列，13 节加上动态 attribute.* 至多数十行，而且走
     `idx_section_asin`）。于是 readTruncated 只对**确实存在、只是没被读出来**的节点亮；
     库里真的一行都没有的节照旧是「未采集」。不这么问的话，截断会让每一节都变得「不知道」，
     那又是把另一种「没测到」当成了「测到不知道」。 */
  const sectionsWithRows = read.truncated
    ? new Set(store.all(
      'SELECT DISTINCT section FROM collection_section_result WHERE asin = ? AND marketplace = ?',
      [key, market],
    ).map(row => row.section))
    : null

  const sections = COLLECTION_SECTIONS.map(definition => {
    const row = bySection.get(definition.id) ?? null
    if (row === null) {
      return {
        section: definition.id,
        label: definition.label,
        order: definition.order,
        status: null,
        statusLabel: null,
        notCollected: true,
        /* 「没有这一节的行」有两个原因：库里真的没有，或者这一节的行走到了 5000 行上限
           之外、根本没被读出来。后者不许被说成「未采集」——那是把「没读到」读成
           「没人采过」，动作正好相反（补采 vs 排查）。为真时读者必须改口。 */
        readTruncated: sectionsWithRows !== null && sectionsWithRows.has(definition.id),
        /* **没有节行不是「采到 0 个字段」**（T73k）。这里从前写 `collected: 0`，于是
           「库里没有这一节的行」在页面上画成 `0/N 已采` —— 与「打开过、一个字段都
           没读到」同一个读数，而这两件事的动作相反（去补采 vs 去查选择器）。
           没有读数就没有分子：`collected` 是 null，读者据 `notCollected` 决定怎么画，
           不据 `collected === 0` 猜。`0` 只留给「真的读过、解析值里一个字段都没有」。
           与采集面板的 `domain/collect/detail.js` 同一条口径。 */
        collected: null,
        /* 未采集的节的 total 是**声明清单的长度**，不是 0：动态节（attributes）的
           0/0 在页面上会被读成「0 个里采到 0 个 = 完整」，而这里说的其实是
           「一共这些字段，一个都还没看过」。页面按 notCollected 画「未采集」。 */
        total: definition.fields.length,
        /* 「没有读数」也没有缺失名单：`[]` 摆在一个从来没被看过的节旁边，等于说
           「一个都不缺」—— 那是 `collected: 0` 同一家族的第二处（T73k 第二批）。
           null 让「没算过」与「算过、一个都不缺」分开。两处页面读者都用
           `Array.isArray(...)` 守卫过，画面上与 `[]` 一个字节都不差；`t73k` 把那两处
           守卫也钉住了（守卫被删 → 测试先红，而不是页面上 `null.length` 崩）。 */
        missingFields: null,
        collectedAt: null,
        schemeVersion: null,
        snapshotRef: null,
        taskId: null,
        errors: [],
        parsedValue: null,
        /* 未采集的节永远不带「没读到」标记 —— 那不是「看见了读不出」，是「根本没看过」。 */
        contentUnread: false,
        diff: null,
        taskCount: 0,
      }
    }
    const taskCount = rows.filter(candidate => candidate.section === definition.id).length
    const counts = sectionValueCounts(definition.id, row.parsedValue)
    /* 同一件伪造读数的第二处：从前这里是 `?? { collected: 0, … }`，把「数不出来」
       变成「采到 0 / 共 N」。`sectionValueCounts` 只在这一节的 id 不在词表里时返回
       null，而这里的 id 全部来自 `COLLECTION_SECTIONS`，所以这条分支**结构上不可达**
       —— 不可达的谎话也是谎话：谁把 id 的来源放宽了，它当场就变成一次假读数。
       现在给 null 分子 + 具名原因 `countsUnavailable`，与 `domain/collect/detail.js`
       的同一个分支逐字段一致。 */
    if (counts === null) {
      return {
        section: definition.id,
        label: definition.label,
        order: definition.order,
        status: row.status,
        statusLabel: row.statusLabel ?? COLLECTION_SECTION_LABELS[row.status] ?? row.status,
        notCollected: false,
        readTruncated: false,
        collected: null,
        total: definition.fields.length,
        /* 这条分支连「这一节有几字段」都数不出来，当然也没有缺失名单 —— 见上面
           未采集分支的注：`[]` 会说「一个都不缺」。 */
        missingFields: null,
        countsUnavailable: true,
        collectedAt: row.collectedAt ?? null,
        schemeVersion: row.schemeVersion ?? null,
        snapshotRef: row.snapshotRef ?? null,
        taskId: row.taskId,
        errors: Array.isArray(row.errors) ? row.errors : [],
        parsedValue: row.parsedValue ?? null,
        contentUnread: sectionContentUnread({ notCollected: false, errors: row.errors, parsedValue: row.parsedValue }),
        diff: row.diff ?? null,
        taskCount,
        dynamic: SECTION_BY_ID[definition.id] !== undefined && SECTION_BY_ID[definition.id].dynamicPrefix !== undefined,
      }
    }
    return {
      section: definition.id,
      label: definition.label,
      order: definition.order,
      status: row.status,
      statusLabel: row.statusLabel ?? COLLECTION_SECTION_LABELS[row.status] ?? row.status,
      notCollected: false,
      readTruncated: false,
      collected: counts.collected,
      total: counts.total,
      missingFields: counts.missing,
      collectedAt: row.collectedAt ?? null,
      schemeVersion: row.schemeVersion ?? null,
      snapshotRef: row.snapshotRef ?? null,
      taskId: row.taskId,
      errors: Array.isArray(row.errors) ? row.errors : [],
      parsedValue: row.parsedValue ?? null,
      /* 「看见了、却没读出来」（子体一个都没解析出来，但页面上明明有色块）—— 判据只有
         一份（`domain/collect/sections.js` 的 `sectionContentUnread`），这里把它算好的
         布尔放进载荷；读者（页面、工具）**读这个字段**，不自己重算。五态不动：这只是
         呈现用的标记。采集面板的载荷（B-04）带的是同一个函数算出来的同一个字段。 */
      contentUnread: sectionContentUnread({ notCollected: false, errors: row.errors, parsedValue: row.parsedValue }),
      diff: row.diff ?? null,
      taskCount,
      /* 动态节（attribute.*）的 total 是「这次读数里出现的属性键数」，0 表示一个都没有。
         页面据此写「无字段可计」，不印 0/0。 */
      dynamic: SECTION_BY_ID[definition.id] !== undefined && SECTION_BY_ID[definition.id].dynamicPrefix !== undefined,
    }
  })

  /* The five state counts are computed from the thirteen rows this view draws —
     one row per section, latest reading wins — so the counts and the table can
     never disagree. Counting the underlying *rows* instead would count a retried
     section twice: the overview would say "failed 1" while the table below it
     shows no failed row at all, and each number would look correct on its own.
     Two denominators, both kept: `totals.total` is the 13-section list, and
     `summary.total` (= `totals.attempted`) is how many sections have a reading. */
  const attempted = sections.filter(entry => entry.notCollected !== true)
  const summary = { collected: 0, missing: 0, partial: 0, failed: 0, blocked: 0, total: attempted.length }
  for (const entry of attempted) summary[entry.status] += 1

  return {
    asin: key,
    marketplace: market,
    sections,
    /* 五态计数（每一节的最新一行）—— 词表与 B-04 同一份，但每节只数一次。 */
    summary,
    /* 分母：一共十三节，其中采过几节、从没采过几节。 */
    totals: {
      total: COLLECTION_SECTIONS.length,
      attempted: attempted.length,
      neverAttempted: sections.length - attempted.length,
      tasks: new Set(rows.map(row => row.taskId)).size,
      rows: rows.length,
    },
    /* 这次读的上限与它读到哪：跨任务的节行超过上限时，上面的 attempted / 未采集 都是
       **被截断后的**结论，读者必须把 note 说出来，不能照常印。 */
    coverage: {
      read: read.read,
      total: read.total,
      limit: read.limit,
      truncated: read.truncated,
      note: read.note,
    },
    vocabulary: {
      /* 页面不自己写第二份五态名：这里把 domain 的那一份带出去，页面直接画。
         服务端已经注入过一份到脚本里（B-04 那段），这里带出来是给工具与测试用的。 */
      states: [...COLLECTION_SECTION_STATES],
      labels: { ...COLLECTION_SECTION_LABELS },
      sectionIds: COLLECTION_SECTIONS.map(section => section.id),
    },
  }
}
