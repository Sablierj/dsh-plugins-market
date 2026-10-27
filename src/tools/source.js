/**
 * Source tools.
 *
 * `amzn_source_list` is the tool that stops the agent from guessing. Each source
 * reports what fields it can fill and whether it is usable right now, so the
 * agent can route a request to a source that can actually answer it — and, just
 * as importantly, tell the user "that needs 卖家精灵, which isn't connected"
 * instead of silently returning nothing.
 *
 * `amzn_source_upsert` is the write half: turning a source on, or handing it the
 * credential it needs. It exists because before it, enabling a source meant
 * editing the database by hand — and the one thing this tool is careful about is
 * that a credential goes **in**, and never comes back **out**.
 */

import { scopeWorkspaceIdOf } from '../domain/context/scope.js'
import { workspaceWriteRefusal } from '../store/workspace.js'
import { table, text } from './render.js'

export function sourceListTool({ sources }) {
  return {
    name: 'amzn_source_list',
    description:
      'List every data source this workbench can collect from, what each one can provide, and whether it is usable now. '
      + 'Call it before submitting collection work, and whenever the user asks where a number came from or why some data is missing. '
      + 'Sources with status "planned" exist but are NOT connected — do not submit work to them; say so instead.',
    parameters: {
      type: 'object',
      properties: {
        checkHealth: { type: 'boolean', description: 'Probe each source before reporting. Default true.' },
      },
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const list = await sources.list({ checkHealth: args?.checkHealth !== false })

      const rows = table(list, [
        { label: 'id', value: source => source.id },
        { label: '类型', value: source => source.kind },
        { label: '传输', value: source => source.transport },
        { label: '状态', value: source => (source.status === 'ready' ? '可用' : '未接入') },
        { label: '健康', value: source => (source.health?.ok ? 'ok' : '—') },
        { label: '名称', value: source => source.name },
      ])

      const details = []
      for (const source of list) {
        const fields = source.capabilities?.fields ?? []
        const browser = source.capabilities?.browser
        details.push([
          `- ${source.id} (${source.kind}/${source.transport})`,
          `  字段: ${fields.length > 0 ? fields.join(', ') : '—'}`,
          source.capabilities?.rateLimit ? `  限速: ${source.capabilities.rateLimit}` : '',
          browser ? `  浏览器: ${browser.host}:${browser.port}，profile ${browser.profile}` : '',
          source.capabilities?.notes ? `  能力说明: ${source.capabilities.notes}` : '',
          source.statusNote ? `  说明: ${source.statusNote}` : '',
          source.health?.detail ? `  健康: ${source.health.detail}` : '',
        ].filter(Boolean).join('\n'))
      }

      return [
        `数据源 (${list.length}):`,
        rows,
        '',
        details.join('\n'),
        '',
        list.some(source => source.status === 'planned')
          ? '注意: 标记为未接入的源当前不可用。需要它们的字段时，如实告诉用户需要先开通额度，不要假装采集过。'
          : '',
      ].filter(Boolean).join('\n')
    },
  }
}

export function sourceUpsertTool({ store, workbench }) {
  return {
    name: 'amzn_source_upsert',
    description:
      'Enable, disable or configure a data source: its display name, its enabled flag, and its credential fields (written into '
      + 'config_json). Use it to turn on a source the user has just paid for, or to correct a name. '
      + 'Credentials go IN and never come back OUT — the result reports only which fields are set, never their values, and no page '
      + 'or log ever prints them. Turning a source on does NOT mean it works: it only means the workbench will try it. '
      + 'Call amzn_source_list afterwards to see the real health. '
      + 'A source that belongs to an archived workspace (or a session sitting in one) is refused with '
      + 'WORKSPACE_ARCHIVED and nothing changes — archive means read-only.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Source id, e.g. sellersprite. Must already exist.' },
        name: { type: 'string', description: 'Display name. Omit to keep the current one.' },
        enabled: { type: 'boolean', description: 'Turn the source on (true) or off (false). Omit to leave it unchanged.' },
        config: {
          type: 'object',
          description: 'Credential fields to set, e.g. { "apiKey": "…" }. Merged into config_json; a key set to null removes it.',
        },
        notes: { type: 'string', description: 'Free-text note shown next to the source.' },
      },
      required: ['id'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    execute(args) {
      const id = String(args?.id ?? '').trim()
      if (id === '') return { ok: false, error: 'id 为空', hint: '先调 amzn_source_list 看有哪些源。' }

      const before = store.get('SELECT * FROM source WHERE id = ?', [id])
      if (before === null || before === undefined) {
        return { ok: false, error: `没有这个数据源 "${id}"`, hint: '数据源是固定的，不能新建。用 amzn_source_list 看合法 id。' }
      }

      /* 归档即只读 (F02-01). The UPDATE below never writes `workspace_id`, so the
         row keeps the space it already belongs to — read from the row, not
         assumed. The scope bar's space is checked as well, for the same reason
         the page checks two: a session parked in an archived workspace must not
         be able to hand the default one a credential.
         A **value**, not a throw: a thrown error is turned into a failed turn by
         the tool wrapper, and this is a refusal the caller can act on. */
      const refusal = workspaceWriteRefusal(store, before.workspace_id, scopeWorkspaceIdOf(workbench))
      if (refusal !== null) {
        return {
          ...refusal,
          hint: '这个数据源属于一个已归档的工作空间。先在工作空间页恢复它，或切到别的工作空间再写。',
        }
      }

      const sets = []
      const params = []
      const put = (column, value) => { sets.push(`${column} = ?`); params.push(value) }

      if (args?.name !== undefined) {
        const name = String(args.name).trim()
        if (name === '') return { ok: false, error: 'name 不能为空', hint: '要清空名字请省略该参数。' }
        put('name', name)
      }
      if (args?.enabled !== undefined) put('enabled', args.enabled === true ? 1 : 0)
      if (args?.notes !== undefined) put('notes', args.notes === null ? null : String(args.notes))

      let removed = []
      if (args?.config !== undefined && args.config !== null) {
        if (typeof args.config !== 'object' || Array.isArray(args.config)) {
          return { ok: false, error: 'config 必须是对象', hint: '例如 { "apiKey": "…" }。' }
        }
        let current = {}
        try {
          current = before.config_json ? JSON.parse(before.config_json) : {}
        } catch {
          current = {}
        }
        for (const [key, value] of Object.entries(args.config)) {
          if (value === null) { delete current[key]; removed.push(key); continue }
          current[key] = String(value)
        }
        put('config_json', Object.keys(current).length === 0 ? null : JSON.stringify(current))
      }

      if (sets.length === 0) {
        return { ok: false, error: '没有任何要改的字段', hint: '至少给 name / enabled / config / notes 之一。' }
      }

      params.push(id)
      store.run(`UPDATE source SET ${sets.join(', ')} WHERE id = ?`, params)

      const after = store.get('SELECT * FROM source WHERE id = ?', [id])
      /* Redacted on the way out, always. The result is read by an agent that will
         quote it into a conversation, so a credential that passes through here has
         been published. */
      let configKeys = []
      try {
        configKeys = Object.keys(after.config_json ? JSON.parse(after.config_json) : {})
      } catch {
        configKeys = []
      }

      return [
        `数据源 ${id} 已更新`,
        `  名称: ${after.name}`,
        `  启用: ${after.enabled === 1 ? '是' : '否'}${before.enabled !== after.enabled ? `（原 ${before.enabled === 1 ? '是' : '否'}）` : ''}`,
        `  凭据字段: ${configKeys.length > 0 ? configKeys.join(', ') : '（无）'}${removed.length > 0 ? `　已移除: ${removed.join(', ')}` : ''}`,
        '',
        '凭据已写入，值不会回显（页面、日志、本结果都不含明文）。',
        after.enabled === 1
          ? '已启用只代表「会尝试用它」，不代表它可用 —— 调 amzn_source_list 看真实健康。'
          : '已停用，采集不会再走这个源。',
      ].join('\n')
    },
  }
}
