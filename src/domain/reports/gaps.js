/**
 * 「没有」的四种说法 —— 报告库（F14-01）的诚实词汇表。
 *
 * ## 为什么这是一个模块，而不是四句内联的字符串
 *
 * 审计给 F14-01 的核心提醒是：八类报告里，**「没有数据来源」和「不做」是两件事**。
 * 而这一批要写的八份文档，每一份的空白处都可能落在四种完全不同的情形里：
 *
 * | kind | 意思 | 读者该做什么 |
 * |---|---|---|
 * | `no-source` | **本仓没有该数据来源** —— 没有表、没有列、没有写入方 | 别在这找，去别的系统或先立项 |
 * | `not-modelled` | **本仓没有为它建模** —— 概念在需求里，落点从未建 | 这是缺口，可开下一批 |
 * | `not-recorded` | **有来源，但这一份记录还没有** —— 表在、行没了 | 跑一次那件事就会有 |
 * | `measured-zero` | **读到了，答案是 0** —— 这是一次测量 | 0 就是结论，不要当成缺数据 |
 *
 * 四者的区别是**本仓付过代价**才换来的：把「没测过」画成 0、把「没建模」写成「没有数据」、
 * 把「本批没做」写成「本系统不支持」，这三种错误在本仓的历史里都出现过（HISTORY 见
 * `tests/wired-source.mjs` 的名单与 `docs/qa/INCLUDES-AUDIT-round2-2026-10-13.md`）。
 *
 * 所以四句话各有一个**唯一的拼写**，且 `gap()` 只接受这四个 kind 之一 —— 第五种说法
 * 写进来会当场抛错，而不是悄悄变成一句读起来差不多的中文。
 */

/**
 * The four kinds, in the order a reader should read them.
 *
 * **Not exported on purpose.** The four sentences reach a reader only through a
 * rendered report, so the assertion that pins them is an assertion about the
 * report's text (`tests/f14-01-report-library.mjs`). An exported constant here
 * would let a test compare a constant with itself and call that evidence.
 */
const ABSENCE_KINDS = ['no-source', 'not-modelled', 'not-recorded', 'measured-zero']

/** The one spelling of each. Printed by every report, read by the tests. */
const ABSENCE_LABELS = {
  'no-source': '本仓没有该来源',
  'not-modelled': '本仓没有为它建模',
  'not-recorded': '有来源，但还没有记录',
  'measured-zero': '读到了，答案是 0',
}

/**
 * What a reader should do about each. Not decoration: 「去补数据」 与 「这条路走不通」
 * 是两个完全相反的动作，而一句「暂无数据」会把前者按在后者身上。
 */
const ABSENCE_ACTIONS = {
  'no-source': '本仓没有任何表、列或写入方会产生它 —— 不要在这条路上补数据。',
  'not-modelled': '需求点名了它，落点从未建；这是一个可以开批次的缺口。',
  'not-recorded': '来源在，只是这一次还没有记录 —— 跑一次对应的动作就会有。',
  'measured-zero': '这是一次真实的测量结果，0 就是结论，不要读成「缺数据」。',
}

/**
 * One absence, named.
 *
 * `feature` is the requirement point it belongs to, so a reader can tell whether
 * the hole closes with more work here (`F14-01`) or belongs to another module.
 */
export function gap({ kind, id, label, feature, reason }) {
  const k = String(kind ?? '').trim()
  if (!ABSENCE_KINDS.includes(k)) {
    throw new Error(`unknown absence kind "${k}" — known: ${ABSENCE_KINDS.join(', ')}`)
  }
  return {
    kind: k,
    id: String(id),
    label: String(label),
    feature: String(feature),
    conclusion: ABSENCE_LABELS[k],
    action: ABSENCE_ACTIONS[k],
    reason: String(reason),
  }
}

/**
 * The block every generated report ends with.
 *
 * **Printed even when empty** — 「本报告没有登记任何读不到的东西」 is itself a claim,
 * and a report that silently omits the section cannot be told from one that never
 * looked. The `gaps.length === 0` branch says which claim it is.
 */
export function renderGaps(gaps) {
  const lines = ['', '## 附录、读不到的东西（四种「没有」分开写）']
  if (gaps.length === 0) {
    lines.push('')
    lines.push('本报告**没有登记任何读不到的东西** —— 上面每一格都来自库里的一次真实读取。'
      + '这不是「本仓不缺东西」，是「这一份报告要的几样都取到了」。')
    return lines
  }
  for (const kind of ABSENCE_KINDS) {
    const bucket = gaps.filter(entry => entry.kind === kind)
    if (bucket.length === 0) continue
    lines.push('')
    lines.push(`### ${ABSENCE_LABELS[kind]}（${bucket.length}）`)
    lines.push(`> ${ABSENCE_ACTIONS[kind]}`)
    for (const entry of bucket) {
      lines.push('')
      lines.push(`- **${entry.label}**（${entry.feature}）`)
      lines.push(`  ${entry.reason}`)
    }
  }
  return lines
}

/**
 * How one **declared observation metric** maps onto the four kinds.
 *
 * This used to be two inline `filter` + `map` calls in `domain/reports/build.js`
 * (F14-04's 发布后效果 report). When F14-10's export header needed the same
 * mapping, the alternative to this function was a second copy of the same three
 * conditions in a second file — and the two would drift the first time
 * `domain/observe/metrics.js` gained a fourth availability. So the rule moved
 * here, next to the vocabulary it writes into, and both callers read it.
 *
 * The mapping, and why each arrow is that arrow:
 *
 *   - `availability: 'no'`      → **`no-source`**. There is no table, no column
 *     and no writer for it in this repo. `metric.why` says which of those is
 *     missing (that sentence is the evidence, not decoration).
 *   - `availability: 'partial'` → **`not-modelled`**. The measurement exists but
 *     only over one slice (click-through and conversion are ad-side only). What
 *     was never modelled is the full-listing version, so calling it `no-source`
 *     would send a reader looking for a data feed that already exists.
 *   - `history: 'current-only'` → **`not-modelled`**. One value, no series: the
 *     history exists in `asin_snapshot.payload_json` and no parser reads it, so
 *     `change` is always `null`. `measured-zero` would be a lie in the opposite
 *     direction — it would say "we measured, the answer is 0".
 *
 * `measured-zero` never comes out of here: a metric declaration cannot know
 * whether the last read found 0 rows. That answer belongs to the read.
 *
 * Returns a **list**: a metric may carry two different limitations at once, and
 * returning only the first would silently drop the second. `include` narrows it
 * to one axis for a caller that only cares about one (`build.js` prints the
 * availability notes, not the history ones — its report is about cards, and a
 * metric's change column is not on them).
 */
export function metricAbsences(metric, { feature = 'F14-07', include = ['availability', 'history'] } = {}) {
  const source = metric ?? {}
  const axes = Array.isArray(include) ? include : []
  const out = []
  if (axes.includes('availability') && source.availability === 'no') {
    out.push(gap({
      kind: 'no-source',
      id: String(source.id ?? ''),
      label: `指标「${source.label ?? source.id}」`,
      feature,
      reason: String(source.why ?? source.note ?? ''),
    }))
  } else if (axes.includes('availability') && source.availability === 'partial') {
    out.push(gap({
      kind: 'not-modelled',
      id: `${source.id}-partial`,
      label: `指标「${source.label ?? source.id}」的完整口径`,
      feature,
      reason: `${String(source.note ?? '')} 这里只能给出被覆盖的那一部分，不是整条 listing 的口径。`,
    }))
  }
  if (axes.includes('history') && source.history === 'current-only') {
    out.push(gap({
      kind: 'not-modelled',
      id: `${source.id}-history`,
      label: `指标「${source.label ?? source.id}」的历史序列`,
      feature,
      reason: `${String(source.note ?? '')} 本版没有解析历史序列，所以变化列恒为空 —— 那是「算不出来」，不是「变化是 0」。`,
    }))
  }
  return out
}

/**
 * A Markdown table, or the sentence that says why there is none.
 *
 * `rows.length === 0` gets `empty` — and the caller has to write it, because
 * 「这张表是空的」 has four different meanings and this helper cannot know which.
 */
export function markdownTable(rows, columns, empty = '（本表没有行）') {
  if (!Array.isArray(rows) || rows.length === 0) return [empty]
  const header = `| ${columns.map(column => column.label).join(' | ')} |`
  const divider = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows.map(row => `| ${columns.map(column => {
    const raw = column.value(row)
    const text = raw === null || raw === undefined || raw === '' ? '—' : String(raw)
    /* A pipe inside a cell would split it into two columns. */
    return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  }).join(' | ')} |`)
  return [header, divider, ...body]
}
