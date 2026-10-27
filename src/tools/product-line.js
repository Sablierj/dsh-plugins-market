/**
 * Product-line tool — the write path for the `product_line` table, and the
 * preview that has to agree with it.
 *
 * `asin.product_line_id` is a foreign key, `queryAsins` and the page's
 * `whereClause` both filter by it, and `amzn_asin_upsert` accepts it — but
 * nothing ever wrote a `product_line` row, so the whole dimension was a dead
 * end: passing a `product_line_id` threw "no product lines exist yet", and the
 * "filter by product line" control could only ever return an empty result.
 *
 * This tool is deliberately the same shape as `amzn_asin_upsert` — a `records`
 * array of objects, one row per object, with per-record failures collected
 * rather than aborting the batch — so there is one write convention to learn.
 *
 * ## `dryRun` is the same call, not a second implementation
 *
 * `dryRun: true` answers "what would change" without writing, and it does it by
 * calling the same `classifyWithSignals` the save path calls. That is the whole
 * point: a preview computed by a second piece of code would agree on the day it
 * was written and drift on the first day somebody fixed one of them, and the
 * symptom would be a preview that says 214 followed by a save that says 209.
 *
 * ## Signals are four categories now
 *
 * `core` / `exclude` / `scenario` / `material`. A bare array is still accepted
 * and read as `core`, because every pre-v23 store and every existing caller
 * speaks that shape, and refusing it would make a working caller look like a
 * bug.
 */

import { listProductLines, upsertProductLine } from '../store/queries.js'
import { listLineVersions } from '../store/product-line.js'
import { scopeWorkspaceIdOf } from '../domain/context/scope.js'
import { previewSignalImpact } from '../domain/keywords/impact.js'
import { readSignalCategories, SIGNAL_CATEGORIES, matchesSignals } from '../domain/keywords/signals.js'
import { PRODUCT_LINE_ORDER } from '../domain/keywords/classify.js'
import { workspaceWriteRefusal } from '../store/workspace.js'
/* 2026-10-25（R-84）：见 execute 里那段注释 —— 这道门在设置里的原文点名了「产品线版本」。 */
import { approvalRefusal } from '../domain/approval/policy.js'
import { table, text, truncate } from './render.js'

/** A short label per category, for the one-line summary of a line's signals. */
const CATEGORY_LABEL = { core: '核心', exclude: '排除', scenario: '场景', material: '材质' }

/**
 * The signals column, as a line a human can act on.
 *
 * The four states are spelled out rather than collapsed to a count, because
 * "0 词（已清空）" and "默认（内置 N 词）" lead to opposite fixes: the first means
 * the line matches nothing and probably wants the constant back, the second
 * means it is working and should be left alone.
 *
 * Which state a row is in is decided by `readSignalCategories`, not here — the
 * settings page renders the same four states, and two independent readings of
 * "is this NULL or empty" is exactly the drift this avoids.
 */
function describeSignals(row) {
  const { mode, signals, builtin } = readSignalCategories(row.signals_json, row.id)
  if (mode === 'broken') return '—（格式异常）'
  if (mode === 'empty') return '0 词（四类皆空，不匹配任何词）'
  if (mode === 'builtin') {
    return builtin === null ? '—（无内置，不匹配任何词）' : `默认（内置 ${builtin.length} 词）`
  }
  const parts = SIGNAL_CATEGORIES
    .filter(category => signals[category].length > 0)
    .map(category => `${CATEGORY_LABEL[category]} ${signals[category].length}`)
  const total = SIGNAL_CATEGORIES.reduce((sum, category) => sum + signals[category].length, 0)
  return `${total} 词（${parts.join(' / ')}）: ${truncate(signals.core.join(', '), 30)}`
}

export function productLineUpsertTool({ store, workbench }) {
  return {
    name: 'amzn_product_line_upsert',
    description:
      'Create, update or preview product lines, and list them. A product line is the grouping the ASIN library '
      + 'filters by: amzn_asin_upsert accepts a product_line_id that must already exist here, and amzn_asin_query '
      + 'can filter on it. Omit records to only list what exists. '
      + 'signals has four categories — core (the words that are this line), exclude (words that rule a keyword out), '
      + 'scenario and material. Detection is a substring test against the lowercased keyword, so pass lowercase '
      + 'phrases. Omitting a category means it is empty, NOT that it falls back to the built-in list. Leaving signals '
      + 'out entirely keeps what is stored (so a rename does not wipe it); passing null resets the line to the '
      + 'built-in list; passing an empty object makes the line match nothing. '
      + 'Set dryRun to see how many keywords and ASINs the change would move, without writing — it runs the same '
      + 'classification the save runs, so the numbers cannot disagree. '
      + 'Saving signals publishes a new version; the old versions stay readable. '
      + 'If any record lands in an archived workspace the whole call is refused with WORKSPACE_ARCHIVED and '
      + 'nothing is written — archive means read-only, and a half-written batch would say otherwise.',
    parameters: {
      type: 'object',
      properties: {
        records: {
          type: 'array',
          description: 'Product lines to write (or, with dryRun, to preview). Omit to only list the existing ones.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id used as the foreign key, e.g. "outdoor-speakers".' },
              name: { type: 'string', description: 'Display name, e.g. 户外音箱. Required unless the line already exists.' },
              note: { type: 'string', description: 'Optional note.' },
              signals: {
                type: 'object',
                description: 'Four categories of lowercase substring signals. Omit to keep what is stored, null to reset to the built-in list.',
                properties: {
                  core: { type: 'array', items: { type: 'string' }, description: 'The words that are this line.' },
                  exclude: { type: 'array', items: { type: 'string' }, description: 'Words that rule a keyword out of this line.' },
                  scenario: { type: 'array', items: { type: 'string' }, description: 'Where it is used.' },
                  material: { type: 'array', items: { type: 'string' }, description: 'What it is made of.' },
                },
              },
            },
            required: ['id'],
          },
        },
        dryRun: { type: 'boolean', description: 'Preview the impact and write nothing. Default false.' },
        confirm: {
          type: 'boolean',
          description: '保存 signals 会发布并启用的产品线版本。当本工作空间开着「激活版本」二次确认时，'
            + '不带这一项会被拒绝（APPROVAL_REQUIRED）—— 与 amzn_rule_upsert / amzn_rule_activate 同一个门。',
        },
        limit: { type: 'number', description: 'When listing: how many rows. Default 100.' },
        historyFor: { type: 'string', description: 'Also list the version history of this product line id.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const records = Array.isArray(args?.records) ? args.records : []
      const dryRun = args?.dryRun === true
      const lines = []

      if (dryRun) {
        /* Preview only: nothing is written, and the assertion that the version
           does not move is what keeps this honest. */
        for (const record of records) {
          const id = String(record?.id ?? '').trim()
          if (id === '') {
            lines.push('- (no id): id is required for a preview')
            continue
          }
          try {
            const impact = previewSignalImpact(store, { productLineId: id, signals: record.signals })
            lines.push(`预览 ${id}: 覆盖 ${impact.keywords} 词 / ${impact.asins} ASIN`
              + `（原 ${impact.before.keywords} 词 / ${impact.before.asins} ASIN，`
              + `新增 ${impact.delta.added} 词，移出 ${impact.delta.removed} 词）`)
            if (impact.added.length > 0) lines.push(`  新增示例: ${truncate(impact.added.join(', '), 60)}`)
            if (impact.removed.length > 0) lines.push(`  移出示例: ${truncate(impact.removed.join(', '), 60)}`)
            lines.push('  （预览没有写库；确认后再调用一次，去掉 dryRun）')
          } catch (error) {
            lines.push(`预览 ${id} 失败: ${error.message}`)
          }
        }
        if (records.length > 0) lines.push('')
      }

      /* 2026-10-25（R-84）：设置中心那道门的原文是「激活规则集 / **产品线版本**前是否额外确认」。
         `amzn_rule_upsert` 与 `amzn_rule_activate` 都问这道门，而这里不问 ——
         保存 signals 会发布新版本并且分类器按最新版走，等价于把它激活。
         dryRun 不写库，所以不占门；没有 records 的调用（只 list）也不占。 */
      if (!dryRun && records.length > 0) {
        const ids = records.map(record => String(record?.id ?? '').trim()).filter(id => id !== '')
        const activationRefusal = approvalRefusal(store, 'activateVersion', args?.confirm,
          `保存 signals 会发布并启用新的产品线版本（旧版本仍可读）：${ids.join(', ') || '(没有 id)'}。`
          + '确认无误就再调一次并带 confirm: true。')
        if (activationRefusal !== null) return activationRefusal
      }

      const created = []
      const updated = []
      const failed = []
      /* 归档即只读 (F02-01), asked **before the first write** and answered for
         the whole call rather than per record. Where a record lands is read the
         way `upsertProductLine` decides it: that function neither inserts nor
         updates `workspace_id`, so an existing line keeps its space and a new one
         is inserted with NULL, which v20 defines as the default.
         All-or-nothing because the alternative is worse than a lost partial
         batch: writing four of five records and then answering `ok:false` would
         report a state that is not true, and the archived space would be
         half-obeyed. Dry runs write nothing and are not gated — inspecting an
         archived line is still reading. */
      if (!dryRun && records.length > 0) {
        const scopeId = scopeWorkspaceIdOf(workbench)
        for (const record of records) {
          const id = String(record?.id ?? '').trim()
          const existing = id === '' ? undefined : store.get('SELECT workspace_id FROM product_line WHERE id = ?', [id])
          const refusal = workspaceWriteRefusal(store, existing?.workspace_id, scopeId)
          if (refusal !== null) {
            return {
              ...refusal,
              records: records.map(entry => String(entry?.id ?? '')).filter(entryId => entryId !== ''),
              hint: '这些产品线里有的落在一个已归档的工作空间。先恢复它，或把写入指向别的工作空间。',
            }
          }
        }
      }
      if (!dryRun) {
        for (const record of records) {
          try {
            const result = upsertProductLine(store, record)
            const label = `${result.id} (v${result.version}`
              + (result.impact === null || result.impact === undefined
                ? ''
                : `，覆盖 ${result.impact.keywords} 词 / ${result.impact.asins} ASIN`)
              + ')'
            ;(result.created ? created : updated).push(label)
          } catch (error) {
            failed.push(`${record?.id ?? '(no id)'}: ${error.message}`)
          }
        }
      }

      const listed = listProductLines(store, { limit: args?.limit ?? 100 })

      if (records.length > 0 && !dryRun) {
        lines.push(`产品线写入: 新增 ${created.length}，更新 ${updated.length}，失败 ${failed.length}`)
        if (created.length > 0) lines.push(`新增: ${created.join(', ')}`)
        if (updated.length > 0) lines.push(`更新: ${updated.join(', ')}`)
        if (failed.length > 0) lines.push(`失败:\n${failed.map(line => `- ${line}`).join('\n')}`)
        lines.push('')
      }

      if (listed.rows.length === 0) {
        lines.push('还没有任何产品线。传 records 建一条，之后 amzn_asin_upsert 才能用 product_line_id。')
      } else {
        lines.push(`产品线 (${listed.rows.length}/${listed.total}):`)
        lines.push(table(listed.rows, [
          { label: 'id', value: row => row.id },
          { label: '名称', value: row => row.name },
          { label: '版本', value: row => row.version ?? 1 },
          { label: 'ASIN 数', value: row => row.asin_count },
          { label: '信号词', value: row => describeSignals(row) },
          { label: '备注', value: row => truncate(row.note, 30) },
        ]))
      }

      if (args?.historyFor !== undefined) {
        const id = String(args.historyFor).trim()
        const versions = id === '' ? [] : listLineVersions(store, id, { limit: 20 })
        lines.push('')
        lines.push(`${id} 的版本历史 (${versions.length}):`)
        if (versions.length === 0) {
          lines.push('(暂无)')
        } else {
          lines.push(table(versions, [
            { label: '版本', value: row => row.version },
            { label: '名称', value: row => row.name },
            { label: '信号词', value: row => truncate(String(row.signals_json ?? ''), 44) },
            { label: '改动人', value: row => row.changed_by ?? '—' },
            { label: '时间', value: row => row.created_at },
          ]))
        }
      }

      return lines.join('\n')
    },
  }
}

/**
 * 给 ASIN 判产品线 —— **只读**。
 *
 * ## 为什么需要它
 *
 * `asin.product_line_id` 一直只能人手填：`amzn_asin_upsert` 收这个字段，但没人告诉操作者
 * 该填哪条线。采集回来的 ASIN 标题里明明写着 "Bench Cushion"，归属却长期是空 ——
 * 于是产品线这个维度在筛选、报告、优化前置检查里全都不起作用（前置检查门 1 就因为
 * "没有产品线归属记录"降级）。
 *
 * ## 判据只有一条：标题对每条线的 signals 做匹配
 *
 * 复用 `matchesSignals`（先排除、再正向），与产品线 signals 预览、导入器**同一个函数** ——
 * 不另写一套，否则"预览说 214、保存说 209"的老毛病会在第三处重演。
 *
 * 标题缺失就是**判不了**，不是"默认线"。`DEFAULT_PRODUCT_LINE` 在关键词那边是兜底，
 * 在这里用它会把"没读到标题"伪装成"已归类"，所以不兜底。
 *
 * ## 多线命中时不替人决定
 *
 * 命中两条线就照 `PRODUCT_LINE_ORDER` 取优先的那条，但**同时把全部命中列出来**，
 * 并标 `多线命中`。一条标题同时像两条线，是产品定位本身含糊，不是分类器该拍的板。
 */
export function productLineClassifyTool({ store }) {
  return {
    name: 'amzn_product_line_classify',
    description:
      'Classify ASINs into product lines by matching each title against every line\'s signals, '
      + 'and report what it would assign. Read-only: it writes nothing — the apply path is '
      + 'amzn_asin_upsert with product_line_id. Omit asin to scan the library. '
      + 'By default only ASINs with no product line are scanned (includeAssigned:true also re-checks '
      + 'the assigned ones and reports disagreements). '
      + 'A line whose signals were never configured (signals_json NULL) uses the built-in list — '
      + 'the same list the keyword classifier uses, so the two cannot disagree. '
      + 'Multi-line hits are reported with every match, not silently collapsed to one: '
      + 'a title that looks like two lines is an ambiguous product, not a classification result.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Site code, e.g. US. Omit for all sites.' },
        asin: { type: 'string', description: 'Only this ASIN.' },
        includeAssigned: {
          type: 'boolean',
          description: 'Also scan ASINs that already have a product line (default false).',
        },
        limit: { type: 'number', description: 'Max ASINs to report. Default 50.' },
      },
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args = {}) {
      const marketplace = String(args.marketplace ?? '').trim().toUpperCase()
      const onlyAsin = String(args.asin ?? '').trim().toUpperCase()
      const includeAssigned = args.includeAssigned === true
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 50

      const lines = store.all('SELECT id, name, signals_json FROM product_line ORDER BY id')
      if (lines.length === 0) {
        return '还没有任何产品线，无法归类。\n'
          + '先用 amzn_product_line_upsert 建线（id + name + signals），再回来跑这一条。'
      }

      const rules = lines.map(line => ({
        id: line.id,
        name: line.name,
        signals: readSignalCategories(line.signals_json, line.id).signals,
      }))

      const where = []
      const params = []
      if (marketplace !== '') { where.push('marketplace = ?'); params.push(marketplace) }
      if (onlyAsin !== '') { where.push('asin = ?'); params.push(onlyAsin) }
      if (!includeAssigned) where.push("(product_line_id IS NULL OR product_line_id = '')")
      const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
      const rows = store.all(
        `SELECT asin, marketplace, title, product_line_id FROM asin${clause} ORDER BY asin LIMIT ?`,
        [...params, limit],
      )
        /* 2026-10-25（R-36 的第四块）：**竞品被分进了我们的产品线。**
           实测：`B0DQP37YND`（Summsun 的坐垫，`side = competitor`）因为标题里有
           bench cushion 相关词，被分进 `bench-cushion` —— 于是 `asin.product_line_id` 也有值。
           产品线是「这条 ASIN 属于哪条业务线」的判断，竞品被分进来之后，
           **所有按产品线过滤的地方（关键词、报告、位置计划）都会把它当成自己的**。

           这一层此前没有 `side` 可读（第 71 轮才把 4 条补进 `asin_ownership`）。
           现在按它排除竞品。**判据取「不等于 competitor」而不是「等于 self」** ——
           没有 side 记录的 ASIN 照原样分类（与 `isOurs` 同一个方向：缺失时不缩小范围）。 */
        .filter(row => {
          const side = store.get(
            "SELECT object_id FROM asin_ownership WHERE asin = ? AND marketplace = ? AND object_type = 'side' AND retracted_at IS NULL",
            [row.asin, row.marketplace],
          )
          return side?.object_id !== 'competitor'
        })

      if (rows.length === 0) {
        return onlyAsin !== '' || marketplace !== ''
          ? '这个范围里没有需要归类的 ASIN（已有归属的都算过了；要重算已归属的，传 includeAssigned:true）。'
          : '库里没有需要归类的 ASIN —— 要么都已有归属，要么还没采集。'
      }

      const results = []
      for (const row of rows) {
        const title = String(row.title ?? '').trim()
        if (title === '') {
          results.push({ row, status: 'no-title', hits: [], proposed: null })
          continue
        }
        const lower = title.toLowerCase()
        const hits = []
        for (const rule of rules) {
          /* 用 `matchesSignals` 定"是不是这条线"（它负责 exclude 语义），
             再单独找**在标题里出现得最靠前**的那个正向词作为判定依据。
             两件事分开：前者是归属，后者是排序。 */
          if (!matchesSignals(title, rule.signals)) continue
          const positives = [...rule.signals.core, ...rule.signals.scenario, ...rule.signals.material]
          let best = null
          for (const word of positives) {
            if (word === '') continue
            const at = lower.indexOf(word)
            if (at < 0) continue
            if (best === null || at < best.at || (at === best.at && word.length > best.word.length)) {
              best = { word, at }
            }
          }
          hits.push({ line: rule.id, name: rule.name, fired: best === null ? null : best.word, at: best === null ? 9999 : best.at })
        }
        if (hits.length === 0) {
          results.push({ row, status: 'no-match', hits, proposed: null })
          continue
        }
        /* 判定顺序：**标题里出现得越靠前越优先**，同位置时词更长者优先，最后才回落到
           产品线优先序。理由是亚马逊标题的写法是"产品类型在前、修饰与材质在后"：
           标题 "Custom Size Bench Cushion, 75D High Density Foam" 里 bench 在第 12 位、
           high density foam 在 30 位之后 —— 靠前那个才是产品是什么。
           固定优先序在这类重叠信号上会判错（实测就把长凳垫判成椅垫）。 */
        hits.sort((a, b) => (a.at - b.at)
          || ((b.fired ?? '').length - (a.fired ?? '').length)
          || (PRODUCT_LINE_ORDER.indexOf(a.line) - PRODUCT_LINE_ORDER.indexOf(b.line)))
        const proposed = hits[0].line
        results.push({
          row,
          status: hits.length > 1 ? 'ambiguous' : 'matched',
          hits,
          proposed,
        })
      }

      const linesOut = []
      const matchedCount = results.filter(item => item.proposed !== null).length
      linesOut.push(`产品线归类 · ${marketplace === '' ? '全部站点' : marketplace} · 只读，未写库`)
      linesOut.push(`扫描 ${results.length} 个 ASIN（${includeAssigned ? '含已归属' : '仅未归属'}）`
        + `　可归类 ${matchedCount}　判不了 ${results.length - matchedCount}`)
      linesOut.push('')

      const tableRows = results.map(item => ({
        asin: item.row.asin,
        marketplace: item.row.marketplace,
        current: item.row.product_line_id ?? '',
        proposed: item.proposed ?? '',
        fired: item.hits.map(hit => hit.fired ?? hit.line).join('、'),
        note: item.status === 'no-title'
          ? '没有标题，判不了'
          : (item.status === 'no-match' ? '没有一条线的信号词命中' : (item.status === 'ambiguous' ? '多线命中' : '')),
        alternatives: item.hits.length > 1 ? item.hits.map(hit => hit.line).join('、') : '',
      }))
      linesOut.push(table(tableRows, [
        { label: 'ASIN', value: row => row.asin },
        { label: '站点', value: row => row.marketplace },
        { label: '现有', value: row => row.current === '' ? '—' : row.current },
        { label: '建议', value: row => row.proposed === '' ? '—' : row.proposed },
        { label: '命中词', value: row => truncate(row.fired, 24) },
        { label: '备注', value: row => row.note },
        { label: '备选线', value: row => truncate(row.alternatives, 26) },
      ]))

      const ambiguous = results.filter(item => item.status === 'ambiguous')
      if (ambiguous.length > 0) {
        linesOut.push('')
        linesOut.push(`⚠️ ${ambiguous.length} 个 ASIN 同时命中多条线（已按"标题里出现最靠前的信号词"取一条，但请人确认）：`)
        for (const item of ambiguous.slice(0, 5)) {
          linesOut.push(`   ${item.row.asin}: ${item.hits.map(hit => `${hit.line}（${hit.fired}）`).join(' vs ')}`)
        }
      }

      const noTitle = results.filter(item => item.status === 'no-title')
      if (noTitle.length > 0) {
        linesOut.push('')
        linesOut.push(`⚠️ ${noTitle.length} 个 ASIN 没有标题，判不了 —— 先采集再来（标题没有就不猜）。`)
      }

      linesOut.push('')
      /* 2026-10-25 真实数据实测（R-9，P1）：这里原来写「要把建议落库：amzn_asin_upsert 传
         records[].product_line_id」——**那条路是写缓存，不是写决策**。
         `asin.product_line_id` 是 `asin_ownership` 的缓存，`syncProductLineCache` 会按边重刷；
         而优化前置第 1 门读的是 `asin_ownership` 的生效行。
         实测：照这句提示写了两个 ASIN 之后，`asin.product_line_id` 有值、`asin_ownership` **0 行**，
         门槛一格没动，而且那两格随时会被下一次同步刷回 null。
         **工具的输出教人写缓存，等于教人做一件看起来成功、其实没生效的事。** */
      linesOut.push('这一条不写库。要把建议落库请走**决策表**：`amzn_asin_ownership_set`')
      linesOut.push('  { asin, marketplace, objectType: "product_line", objectId: "<产品线 id>", by, reason }')
      linesOut.push('**不要**用 `amzn_asin_upsert` 的 `product_line_id` 来落这个建议 ——')
      linesOut.push('  `asin.product_line_id` 是 `asin_ownership` 的**缓存**，会被下一次同步按边重刷；')
      linesOut.push('  优化前置第 1 门读的是 `asin_ownership` 的生效行，写缓存它看不到。')
      return linesOut.join('\n')
    },
  }
}
