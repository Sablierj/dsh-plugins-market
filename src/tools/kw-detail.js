/**
 * 模块 08 F08-08 —— 关键词详情工具（只读）。
 *
 * `amzn_keyword_detail` 把一个关键词的七个 §8.2 项一次读全，交给会话侧的 Agent：
 * 多源事实时间线 / 自有与竞品排名 / 所有权与位置 / 数据质量 / 历史使用与效果 /
 * 原始变体与合并记录 / 相关性。
 *
 * ## 它只读，而且必须把「没有」说清楚
 *
 * 这个工具一行都不写（`WRITE_TARGETS` 里是 `null`）。它最要紧的职责不是把有的
 * 东西列出来，而是**不把缺失渲染成真实值**：一个空列表读起来像「查过、没有」，
 * 一个 0 读起来像一个测量值。所以文本里两个词是分开的 ——
 * `未测量`（字段在、这个词没有行）与 `本系统没有这个字段`（概念根本没建模）。
 * 相关性 / 逐词实际落点 / 逐词效果属于后者；工具**不会**由 CVR、搜索量、层级或
 * embedding 距离推导一个伪相关性出来。
 */

import { table, text, truncate } from './render.js'
import { ABSENCE_NOT_MODELLED, ABSENCE_UNMEASURED, readKeywordDetail } from '../store/keyword-detail.js'

/** 值缺失时的统一写法 —— 永不写 0。 */
function show(value) {
  return value === null || value === undefined || value === '' ? ABSENCE_UNMEASURED : String(value)
}

function competitorRankLines(rank) {
  const lines = [
    `竞品最好排名: ${show(rank.competitor.bestRank)}`
      + (rank.competitor.bestAsin ? `（${rank.competitor.bestAsin}）` : ''),
    `有排名 / 缺席的竞品: ${rank.competitor.rankedCount} / ${rank.competitor.absentCount}`,
  ]
  if (rank.competitor.ranked.length > 0) {
    lines.push('排名明细: ' + rank.competitor.ranked.map(entry => `${entry.asin} #${show(entry.rank)}`).join(' · '))
  }
  if (rank.own.needAsin) {
    lines.push(`自有排名: ${rank.own.absence.text} —— ${rank.own.absence.why}`)
  } else if (!rank.own.measured) {
    lines.push(`自有排名: ${ABSENCE_UNMEASURED} —— ${rank.own.absence.why}`)
  } else {
    lines.push(`自有排名（${rank.own.asin}）: ${show(rank.own.rank)}`)
  }
  return lines
}

export function keywordDetailTool({ store }) {
  return {
    name: 'amzn_keyword_detail',
    description:
      'Read one keyword\'s full detail (module 08 F08-08): the multi-source fact timeline (ABA / ads / '
      + 'competitor, raw rows, raw units), own vs competitor rank, ownership and plan position, data-quality '
      + 'issues, the lifecycle/ownership history, and any pre-fold variant record. **Read-only — it writes '
      + 'nothing.** Absences are named, never shown as a value: `未测量` means the field exists but this keyword '
      + 'has no row; `本系统没有这个字段` means the concept is not modelled at all. Relevance (相关性) is in the '
      + 'second group — there is no relevance column, vocabulary or threshold in this system, and this tool will '
      + '**not** derive a pseudo-relevance from CVR, search volume, tier or an embedding. Own rank is ASIN-scoped '
      + '(asin_keyword.rank); with no `asin` it reads 「需选定 ASIN」, never 0.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The keyword to open. Folded (trim + case + inner whitespace) before lookup.' },
        marketplace: { type: 'string', description: 'Marketplace code, e.g. US.' },
        asin: { type: 'string', description: 'Our ASIN, to read our own rank for this word. Omit to get 「需选定 ASIN」.' },
      },
      required: ['keyword', 'marketplace'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      try {
        const detail = readKeywordDetail(store, {
          keyword: args?.keyword,
          marketplace: args?.marketplace,
          asin: args?.asin ?? null,
        })
        const { timeline } = detail
        const lines = [
          `关键词详情: ${detail.keyword}（站点 ${detail.marketplace}）`,
          detail.master === null
            ? `总库里没有这一行（这个词只存在于事实表或从未导入）。`
            : `总库: 搜索量 ${show(detail.master.searchVolume)} · 层级 ${show(detail.master.svTier)}`
              + ` · 漏斗 ${show(detail.master.funnel)} · 产品线 ${show(detail.master.productLine)}`,
          '',
          `**多源事实时间线**（原始行、原始单位，不做换算）：`
            + `ABA ${timeline.counts.aba} 行 · 广告 ${timeline.counts.ad} 行 · 竞品 ${timeline.counts.competitor} 行`,
        ]
        if (timeline.counts.aba > 0) {
          lines.push('', 'ABA:', table(timeline.aba.slice(0, 20), [
            { label: '周期', value: row => row.period },
            { label: '搜索量', value: row => show(row.searchVolume) },
            { label: '总分', value: row => show(row.score) },
            { label: 'CVR%', value: row => show(row.cvrPct) },
            { label: '来源', value: row => truncate(row.sourceFile, 28) },
            { label: '导入时间', value: row => truncate(row.importedAt, 24) },
          ]))
        } else {
          lines.push(`ABA: ${ABSENCE_UNMEASURED}（这个词没有任何 kw_aba_fact 行）`)
        }
        if (timeline.counts.ad > 0) {
          lines.push('', '广告（逐周期逐文件）:', table(timeline.ad.slice(0, 20), [
            { label: '周期', value: row => row.period },
            { label: '曝光', value: row => show(row.impressions) },
            { label: '点击', value: row => show(row.clicks) },
            { label: '订单', value: row => show(row.orders) },
            { label: '花费', value: row => show(row.spend) },
            { label: '来源', value: row => truncate(row.sourceFile, 28) },
          ]))
        } else {
          lines.push(`广告: ${ABSENCE_UNMEASURED}（这个词没有任何 kw_ad_fact 行）`)
        }
        if (timeline.counts.competitor > 0) {
          lines.push('', '竞品:', table(timeline.competitor.slice(0, 20), [
            { label: 'ASIN', value: row => row.asin },
            { label: '来源', value: row => row.sourceId },
            { label: '自然排名', value: row => show(row.organicRank) },
            { label: '广告排名', value: row => show(row.adRank) },
            /* 2026-10-25（R-70）：这一格原来叫「月搜索量」，而它装的**不是这个 ASIN 的搜索量**，
               是**这个词**在该份反查批次里的月搜索量（`kw_competitor_fact.monthly_volume`）。
               实测 `bench cushion`（US）7 行竞品事实：
                 B09696LTCL / B0DQP37YND / B0DS422ZMW / B0DS49VC81 / B0DS5QSCDQ  → 69463（同一批 20260328）
                 B0F1K82ZYK / B0GV55Q4JG（我们自己）                              → 76017（另一批 20260601）
               于是同一列里出现 69463 与 76017 —— **那是两个来源批次对同一个词的两种说法**，
               而不是「我们的搜索量比竞品高」。读者按行比较这一列会得出相反的结论。

               所以：① 列名点明是「词」的量；② 表下把出现的取值列出来，让「同词不同批次」这件事看得见。 */
            { label: '词月搜索量', value: row => show(row.monthlyVolume) },
            /* 2026-10-25（R-52）：这一格原来在 `collectedAt` 为空时印 `ABSENCE_UNMEASURED`（即「未测量」）。
               而「未测量」在这份输出末尾的定义是：**「字段存在且被建模，只是这个词没有对应的行」**。
               实测那一行：
                 B0DS49VC81  sellersprite  4  12  69463  **未测量**

               —— **这一行是存在的**（有自然排名 4、广告排名 12、月搜索量 69463），
               只是 `collected_at` 没记。所以印「未测量」是**用它自己的定义去否定它自己**。

               而同一张表最后一行 `B0GV55Q4JG` 的自然排名确实写了「未测量」（它的 rank 真的没有行）——
               **同一个词在同一列里出现在两种情况下，读者无法区分。**

               改法：这一格空的时候印「无观测时间」——
               它说的是「有数据，但没记下是什么时候测的」，与「没有这一行」是两件事。 */
            { label: '观测时间', value: row => truncate(row.collectedAt ?? '无观测时间', 24) },
          ]))
          /* 2026-10-25（R-70）续：把「同词不同批次给出不同的月搜索量」摆出来。
             这一列是**词**的量，按来源批次取值 —— 跨行比较它没有意义。
             有几种取值就列几种（按出现顺序去重），只有一种时不啰嗦。 */
          const volumes = [...new Set(timeline.competitor
            .map(row => row.monthlyVolume)
            .filter(v => v !== null && v !== undefined))]
          if (volumes.length > 1) {
            lines.push('', `⚠️ 上面这 ${timeline.competitor.length} 行的「词月搜索量」出现了 ${volumes.length} 种取值：`
              + `${volumes.map(v => Number(v).toLocaleString('en-US')).join(' / ')} —— `
              + '**这是两个来源批次对同一个词的两种说法，不是「谁的搜索量更高」；这一列不能跨行比较。**')
          }
        } else {
          lines.push(`竞品: ${ABSENCE_UNMEASURED}（这个词没有任何 kw_competitor_fact 行）`)
        }

        lines.push('', '**自有与竞品排名**', ...competitorRankLines(detail.rank))

        lines.push('', '**所有权与位置**')
        if (detail.ownership === null) {
          lines.push('所有权: 没有任何主张（未分配）。')
        } else if (detail.ownership.conflicted) {
          lines.push(`所有权: 冲突 ×${detail.ownership.conflictCount}（${detail.ownership.conflictReasons.join('；')}）`)
        } else {
          lines.push(`所有权: 主人 ${show(detail.ownership.owner)}（${detail.ownership.claimCount} 条生效主张）`)
        }
        if (detail.plans.length === 0) {
          lines.push('位置计划: 没有任何计划包含这个词。')
        } else {
          lines.push('位置计划（**计划**位置，不是实际落点）:', table(detail.plans, [
            { label: '计划', value: row => truncate(row.planId, 12) },
            { label: 'ASIN', value: row => row.asin },
            { label: 'v', value: row => String(row.version) },
            { label: '状态', value: row => row.statusLabel },
            { label: '主人位置', value: row => row.ownerPosition },
          ]))
        }

        lines.push('', '**数据质量**')
        if (detail.quality.issues.length === 0) {
          lines.push(`没有关键词级问题。注意：${detail.quality.note}`)
        } else {
          lines.push(table(detail.quality.issues, [
            { label: '规则', value: row => row.ruleId },
            { label: '严重级', value: row => row.severity },
            { label: '状态', value: row => row.status },
            { label: '问题', value: row => truncate(row.message, 50) },
          ]))
        }

        lines.push('', '**历史使用和效果**')
        if (detail.history.lifecycle.current !== null) {
          const current = detail.history.lifecycle.current
          lines.push(`当前生命周期: ${current.status} ${current.label}`
            + `${current.reason ? `（${current.reason}）` : ''} · ${current.changedAt}`)
        } else {
          lines.push('当前生命周期: 未设置（没人决定过，不是 candidate）。')
        }
        if (detail.history.lifecycle.events.length > 0) {
          lines.push('生命周期流转:', table(detail.history.lifecycle.events, [
            { label: '从', value: row => row.fromStatus ?? '（首次）' },
            { label: '到', value: row => `${row.toStatus} ${row.toLabel}` },
            { label: '来源', value: row => row.source },
            { label: '发布关联', value: row => row.publicationId ?? '—' },
            { label: '时间', value: row => truncate(row.at, 24) },
          ]))
        } else {
          lines.push(`生命周期流转: ${ABSENCE_UNMEASURED}。`)
        }
        if (detail.history.ownershipEvents.length > 0) {
          lines.push('所有权事件:', table(detail.history.ownershipEvents, [
            { label: '动作', value: row => row.action },
            { label: 'ASIN', value: row => row.asin ?? '—' },
            { label: '时间', value: row => truncate(row.at, 24) },
          ]))
        } else {
          lines.push(`所有权事件: ${ABSENCE_UNMEASURED}。`)
        }

        lines.push('', '**原始变体与合并记录**')
        if (detail.variants.merged) {
          lines.push(table(detail.variants.rows, [
            { label: '拼写', value: row => row.keyword },
            { label: '并入', value: row => row.mergedInto ?? '—' },
            { label: '归档时间', value: row => truncate(row.archivedAt ?? '', 24) },
          ]))
        }
        lines.push(detail.variants.note)

        lines.push('', '**缺失说明（两种「没有」不是一回事）**')
        lines.push(`- \`${ABSENCE_UNMEASURED}\`：字段存在且被建模，只是这个词没有对应的行。`)
        lines.push(`- \`${ABSENCE_NOT_MODELLED}\`：概念根本没有被建模。`)
        lines.push(`- 相关性: ${ABSENCE_NOT_MODELLED} —— ${detail.notModelled.relevance.why}`)
        lines.push(`- 逐词实际落点: ${ABSENCE_NOT_MODELLED} —— ${detail.notModelled.actualUsage.why}`)
        lines.push(`- 逐词效果: ${ABSENCE_NOT_MODELLED} —— ${detail.notModelled.effect.why}`)

        return { ok: true, detail, text: lines.join('\n') }
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          hint: 'keyword 与 marketplace 必填；asin 可选，不传则自有排名读「需选定 ASIN」。这个工具不写库。',
        }
      }
    },
  }
}
