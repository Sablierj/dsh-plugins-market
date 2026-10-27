/**
 * 字段模板的工具面（R-91）。
 *
 * 一条主线：**「实际优化时有哪些字段」由一个可编辑、有版本、可回滚的模板决定**，
 * 而不是散落在代码常量里。工具面分五步，正好对应需求方说的那个按钮流程：
 *
 * ```
 * get      读当前模板（顺带告诉你哪些字段这一轮已经有草稿）
 * propose  把「AI 研究会话」的产出写成一版提案（status=proposed，不动当前生效版）
 * confirm  人工确认 —— 提案变成生效版本，旧的自动 superseded
 * save     人手直接改（增/删/改/调顺序）也能出一版新的
 * rollback 反悔 —— 另起一版抄回上一版，保留痕迹
 * ```
 */

import { ATTRIBUTES } from '../domain/rules/attributes.js'
import {
  ITEM_KINDS, TEMPLATE_ID, confirmTemplateVersion, ensureTemplate, diffTemplateItems,
  getTemplate, getTemplateVersion, listTemplateVersions, rollbackTemplate, saveTemplateVersion,
} from '../store/field-template.js'
import { table, text } from './render.js'

/** listing 正文那几格 —— 与报告渲染用的是同一份字段名。 */
export const COPY_FIELDS = [
  { id: 'title', label: '标题', section: 'title', required: true, limit: '200 字符（2026 目标 ≤75）' },
  { id: 'item_highlights', label: '产品亮点', section: 'highlights', required: true, limit: '125 字符' },
  { id: 'bullet_1', label: '五点 1', section: 'bullets', required: true, limit: '255 字符' },
  { id: 'bullet_2', label: '五点 2', section: 'bullets', required: true, limit: '255 字符' },
  { id: 'bullet_3', label: '五点 3', section: 'bullets', required: true, limit: '255 字符' },
  { id: 'bullet_4', label: '五点 4', section: 'bullets', required: true, limit: '255 字符' },
  { id: 'bullet_5', label: '五点 5', section: 'bullets', required: true, limit: '255 字符' },
  { id: 'description', label: '产品描述', section: 'description', required: true, limit: '2000 字符（建议 ≥1000）' },
  { id: 'search_terms', label: '后台搜索词', section: 'backend', required: true, limit: '249 字节' },
  { id: 'aplus', label: 'A+ 内容', section: 'aplus', required: false, limit: '6 个模块' },
  { id: 'brand_story', label: '品牌故事', section: 'brand', required: false, limit: null },
  { id: 'qa', label: 'Q&A 播种', section: 'qa', required: false, limit: '8 组' },
  { id: 'image_alt', label: '图片 Alt 文本', section: 'images', required: false, limit: null },
  { id: 'video_script', label: '视频脚本', section: 'video', required: false, limit: null },
]

const prepare = (store) => ensureTemplate(store, { attributes: ATTRIBUTES, copyFields: COPY_FIELDS })

/* `render.js` 的 `table(rows, columns)` 是 **先数据后列**，且列是 `{ label, value(row) }` ——
   2026-10-26 我第一次写反了（`table(headers, rows)`），第一次跑就报 `column.value is not a function`。 */
function itemsTable(items, drafted = null) {
  return table(
    items.map((item, index) => ({ item, index })),
    [
      { label: '#', value: row => row.index + 1 },
      { label: '字段', value: row => row.item.label },
      { label: 'id', value: row => row.item.id },
      { label: '类型', value: row => (row.item.kind === 'copy' ? '正文' : '属性') },
      { label: '要求', value: row => (row.item.required ? '必填' : '选填') },
      {
        label: '本轮草稿',
        value: row => (drafted === null ? '—' : (drafted.has(row.item.id) ? '有草稿' : '（本轮没有草稿）')),
      },
    ],
  )
}

export function fieldTemplateGetTool({ store }) {
  return {
    name: 'amzn_field_template_get',
    description:
      'Read the listing field template — the editable, versioned list of every field an optimization round must cover '
      + '(listing copy fields + all 52 category attributes, 43 of them required). '
      + 'Returns the active version, its items in order, and — when you pass a runId — which items already have a draft '
      + 'this round. First call seeds the template from the read-only registries (ATTRIBUTES + listing fields), so the '
      + 'answer is never empty. This reads only.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Optional: mark which template fields already have a draft in this run.' },
        version: { type: 'number', description: 'Read one specific version instead of the active one.' },
        history: { type: 'boolean', description: 'Also list every version (newest first).' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      prepare(store)
      const active = getTemplateVersion(store, { status: 'active' })
      const wanted = args?.version === undefined || args?.version === null
        ? active
        : getTemplateVersion(store, { version: Number(args.version) })
      if (wanted === null) {
        return `模板 ${TEMPLATE_ID} 没有第 ${args?.version} 版。`
      }
      const meta = getTemplate(store, TEMPLATE_ID)
      const drafted = args?.runId === undefined || args?.runId === null
        ? null
        : new Set(store.all('SELECT field FROM optimization_draft WHERE run_id = ?', [String(args.runId)]).map(row => row.field))
      const required = wanted.items.filter(item => item.required).length
      const copy = wanted.items.filter(item => item.kind === 'copy').length
      const lines = [
        `字段模板 · ${meta?.name ?? TEMPLATE_ID} · 当前生效 v${active?.version ?? '—'}`
        + (wanted.version === active?.version ? '' : `（这一份是 v${wanted.version}）`),
        `共 ${wanted.items.length} 个字段：正文 ${copy} 个 + 属性 ${wanted.items.length - copy} 个 · 其中必填 ${required} 个`,
        '',
        itemsTable(wanted.items, drafted),
      ]
      if (drafted !== null) {
        const missing = wanted.items.filter(item => !drafted.has(item.id))
        lines.push('')
        lines.push(`本轮已有草稿 ${wanted.items.length - missing.length} / ${wanted.items.length} 个字段；`
          + `缺 ${missing.length} 个 —— 报告会把它们逐行印出来（「本轮没有草稿」），不会因为没写就不出现。`)
      }
      if (args?.history === true) {
        const versions = listTemplateVersions(store, TEMPLATE_ID)
        lines.push('')
        lines.push('版本历史（新→旧）:')
        lines.push(table(
          versions.map(entry => ({ entry })),
          [
            { label: '版本', value: row => `v${row.entry.version}` },
            { label: '状态', value: row => row.entry.status },
            { label: '字段数', value: row => row.entry.items.length },
            {
              label: '建立',
              value: (row) => {
                const stamp = String(row.entry.createdAt).slice(0, 16).replace('T', ' ')
                return row.entry.createdBy === null ? stamp : `${stamp} · ${row.entry.createdBy}`
              },
            },
            {
              label: '确认',
              value: row => (row.entry.confirmedAt === null ? '—' : String(row.entry.confirmedAt).slice(0, 16).replace('T', ' ')),
            },
            {
              label: '说明',
              value: row => row.entry.note ?? (row.entry.diff === null ? '' : row.entry.diff.summary),
            },
          ],
        ))
      }
      lines.push('')
      lines.push('这条模板就是「实际优化时的字段清单」：报告逐行印它，缺草稿的行也印出来（写「本轮没有草稿」）。')
      return lines.join('\n')
    },
  }
}

export function fieldTemplateSaveTool({ store }) {
  return {
    name: 'amzn_field_template_save',
    description:
      'Save a NEW version of the field template from an edited field list: add fields, remove fields, change a label / '
      + 'required flag / section, or reorder. Versions are append-only — the previous version is kept and shown in '
      + '`history`; roll back with amzn_field_template_rollback (which also appends, so the rollback itself is recorded). '
      + 'This writes to the database: confirm the field list with the user before calling it.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'The complete new field list, in order. Each: { id, label, kind: copy|attribute, section, required, limit, note }.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              kind: { type: 'string', description: `${ITEM_KINDS.join(' | ')}` },
              section: { type: 'string' },
              required: { type: 'boolean' },
              limit: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['id', 'label', 'kind'],
          },
        },
        by: { type: 'string', description: 'Who made this version.' },
        note: { type: 'string', description: 'Why this version exists.' },
      },
      required: ['items'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      prepare(store)
      const items = Array.isArray(args?.items) ? args.items : []
      if (items.length === 0) {
        return { ok: false, error: '模板至少要有一个字段', hint: '先用 amzn_field_template_get 拿到当前清单，改完再整份提交。' }
      }
      let result
      try {
        result = saveTemplateVersion(store, { items, status: 'active', by: args?.by ?? null, note: args?.note ?? null })
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
      const lines = [
        `字段模板已出新版 v${result.version.version}（前一版 v${result.previous?.version ?? '—'} 保留，状态 superseded）`,
        `字段 ${result.version.items.length} 个 · 必填 ${result.version.items.filter(item => item.required).length} 个`,
        result.diff === null ? '这是第一版，没有可对照的上一版。' : `与上一版的差异: ${result.diff.summary}`,
      ]
      if (result.diff !== null) {
        if (result.diff.added.length > 0) lines.push(`  新增: ${result.diff.added.map(entry => entry.id).join(', ')}`)
        if (result.diff.removed.length > 0) lines.push(`  删除: ${result.diff.removed.map(entry => entry.id).join(', ')}`)
        if (result.diff.changed.length > 0) lines.push(`  修改: ${result.diff.changed.map(entry => `${entry.id}(${entry.fields.join('/')})`).join(', ')}`)
        if (result.diff.reordered) lines.push('  顺序也变了')
      }
      lines.push('')
      lines.push('要回滚到上一版: amzn_field_template_rollback（它会另起一版，回滚这件事本身留痕）。')
      return lines.join('\n')
    },
  }
}

export function fieldTemplateProposeTool({ store }) {
  return {
    name: 'amzn_field_template_propose',
    description:
      'Write a PROPOSED new version of the field template from an AI research session — this is the backend of the '
      + '「更新字段模板」 button. The proposal is stored as status=proposed and does NOT change the active template: a '
      + 'person confirms it with amzn_field_template_confirm. `research` records what was searched and what was found, so '
      + '「这一版是怎么来的」 stays answerable; `diff` against the active version is computed and stored with it. '
      + 'This writes to the database.',
    parameters: {
      type: 'object',
      properties: {
        items: { type: 'array', description: 'The proposed complete field list, in order.', items: { type: 'object' } },
        research: {
          type: 'object',
          description: 'What produced this proposal: { query, sources[], summary, checkedAt }.',
        },
        by: { type: 'string', description: 'Which agent / person produced it.' },
        note: { type: 'string' },
      },
      required: ['items'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      prepare(store)
      const items = Array.isArray(args?.items) ? args.items : []
      if (items.length === 0) return { ok: false, error: '提案至少要有字段', hint: '先用 amzn_field_template_get 读当前清单。' }
      let result
      try {
        result = saveTemplateVersion(store, {
          items,
          status: 'proposed',
          by: args?.by ?? null,
          note: args?.note ?? 'AI 研究会话产出，等人确认',
          research: args?.research ?? null,
        })
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
      const diff = result.diff
      const lines = [
        `已写入提案 v${result.version.version}（status=proposed）—— **当前生效的仍是 v${result.previous?.version ?? '—'}**，没有人确认之前不变。`,
        `字段 ${result.version.items.length} 个（现役 ${result.previous?.items.length ?? 0} 个）`,
        diff === null ? '没有可对照的现役版本。' : `与现役版本的差异: ${diff.summary}`,
      ]
      if (diff !== null) {
        if (diff.added.length > 0) lines.push(`  建议新增: ${diff.added.map(entry => `${entry.label}(${entry.id})`).join(', ')}`)
        if (diff.removed.length > 0) lines.push(`  建议删除: ${diff.removed.map(entry => `${entry.label}(${entry.id})`).join(', ')}`)
        if (diff.changed.length > 0) lines.push(`  建议修改: ${diff.changed.map(entry => `${entry.id} → ${entry.fields.join('/')}`).join(', ')}`)
      }
      if (result.version.research !== null) {
        const research = result.version.research
        lines.push('')
        lines.push(`研究来源: ${research.query ?? '（没写检索词）'}`)
        if (Array.isArray(research.sources) && research.sources.length > 0) {
          lines.push(`参考 ${research.sources.length} 条: ${research.sources.slice(0, 3).join(' · ')}${research.sources.length > 3 ? ' …' : ''}`)
        }
        if (research.summary) lines.push(`汇总: ${String(research.summary).slice(0, 400)}`)
      }
      lines.push('')
      lines.push('确认使用新模板: amzn_field_template_confirm（旧版自动 superseded，随时可 rollback）。')
      return lines.join('\n')
    },
  }
}

export function fieldTemplateConfirmTool({ store }) {
  return {
    name: 'amzn_field_template_confirm',
    description:
      'Human confirmation of a proposed field-template version: it becomes the active template and the previously active '
      + 'one becomes superseded (kept, not deleted). A proposed version that nobody confirms never takes effect. '
      + 'This writes to the database: the confirmation is the human act, so pass `by`.',
    parameters: {
      type: 'object',
      properties: {
        version: { type: 'number', description: 'Which proposed version to confirm.' },
        by: { type: 'string', description: 'Who confirmed it.' },
        note: { type: 'string' },
      },
      required: ['version'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      prepare(store)
      if (args?.version === undefined || args?.version === null) {
        return { ok: false, error: '要确认哪一版？', hint: '先用 amzn_field_template_get 看 history，proposed 那一行就是待确认的。' }
      }
      try {
        const row = confirmTemplateVersion(store, { version: Number(args.version), by: args?.by ?? null, note: args?.note ?? null })
        return [
          `模板 v${row.version} 已确认生效（字段 ${row.items.length} 个）`,
          `确认人 ${row.confirmedBy ?? '（没记）'} · ${String(row.confirmedAt ?? '').slice(0, 16).replace('T', ' ')}`,
          '旧版本仍可读（status=superseded）；要回到它用 amzn_field_template_rollback。',
        ].join('\n')
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    },
  }
}

export function fieldTemplateRollbackTool({ store }) {
  return {
    name: 'amzn_field_template_rollback',
    description:
      'Roll the field template back to an earlier version. This APPENDS a new version carrying the earlier field list — it '
      + 'does not edit history, so 「谁在什么时候回滚过」 stays answerable. Defaults to the version before the current '
      + 'active one; pass `to` to pick a specific one. This writes to the database.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'number', description: 'Version to restore. Omit for the one right before the active version.' },
        by: { type: 'string' },
        note: { type: 'string' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      prepare(store)
      try {
        const result = rollbackTemplate(store, {
          by: args?.by ?? null,
          note: args?.note ?? null,
          to: args?.to === undefined || args?.to === null ? null : Number(args.to),
        })
        return [
          `已回滚：v${result.rolledBackFrom} → 内容取自 v${result.rolledBackTo}，另起一版 v${result.version.version}`,
          `字段 ${result.version.items.length} 个`,
          '回滚本身是一版新记录 —— 「谁在什么时候回滚过」不会丢。',
        ].join('\n')
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    },
  }
}

/* 2026-10-26：这里原来还有一个 `templateFieldsForRun`（给报告用的便利函数），
   但 optimize 那边最终是自己 few 行读的（`templateItemsForReport`），于是它没有生产调用方 ——
   `tests/wired-source.mjs` 当场抓住了这件事（「导出但没有调用方」）。**删掉，不留待接线名单里的一条。** */

export function fieldTemplateDiffTool({ store }) {
  return {
    name: 'amzn_field_template_diff',
    description:
      'Compare two field-template versions (added / removed / changed / reordered), or compare the active version against '
      + 'the proposed one. Read-only: use it before confirming a proposal.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'number', description: 'Base version. Omit for the active one.' },
        to: { type: 'number', description: 'Target version. Omit for the newest proposed one.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      prepare(store)
      const from = args?.from === undefined || args?.from === null
        ? getTemplateVersion(store, { status: 'active' })
        : getTemplateVersion(store, { version: Number(args.from) })
      const to = args?.to === undefined || args?.to === null
        ? getTemplateVersion(store, { status: 'proposed' })
        : getTemplateVersion(store, { version: Number(args.to) })
      if (from === null || to === null) {
        return `没有可对照的两版（基版 ${from === null ? '缺' : `v${from.version}`} / 目标版 ${to === null ? '缺' : `v${to.version}`}）。`
      }
      const diff = diffTemplateItems(from.items, to.items)
      const lines = [
        `模板差异 v${from.version}（${from.status}） → v${to.version}（${to.status}）: ${diff.summary}`,
        `字段数 ${diff.counts.before} → ${diff.counts.after}`,
      ]
      if (diff.added.length > 0) lines.push(`新增: ${diff.added.map(entry => `${entry.label}(${entry.id})`).join(', ')}`)
      if (diff.removed.length > 0) lines.push(`删除: ${diff.removed.map(entry => `${entry.label}(${entry.id})`).join(', ')}`)
      for (const entry of diff.changed) lines.push(`修改 ${entry.id}: ${entry.fields.join('/')}`)
      if (diff.reordered) lines.push('顺序变了（位置会改变「先写哪一格」的优先级）')
      return lines.join('\n')
    },
  }
}
