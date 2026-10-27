/**
 * The setting tools: what the agent reads and writes on the settings page.
 *
 * Two tools rather than one, because they are two different risks. Reading is
 * safe and should happen freely — an agent that knows the pacer is set to 45s can
 * tell the user why a task will take a while. Writing changes how the machine
 * behaves on a real website, so `amzn_setting_set` is deliberately narrow: it
 * accepts one key at a time, validates it against the declared type, and returns
 * what it stored.
 *
 * **What this tool will not do** is the important part. It cannot write a title
 * length cap, a character unit, or an `authoritative` flag, because those are not
 * settings — they are verified market facts (`domain/rules/marketplaces.js`). A
 * key that is not declared is refused by name rather than stored, so a typo can
 * never sit in the table looking correct while the setting it meant stays at its
 * default.
 *
 * Secrets never travel through here. An API key belongs to the source that uses
 * it (`amzn_source_upsert` → `source.config_json`), and no tool returns one.
 */

import { scopeWorkspaceIdOf } from '../domain/context/scope.js'
import { workspaceWriteRefusal } from '../store/workspace.js'
import { table, text } from './render.js'

export function settingListTool({ store }) {
  return {
    name: 'amzn_setting_list',
    description:
      'Read the workbench settings: collection pacing (ASINs per task, interval, daily cap), the Chrome profile alias, and any '
      + 'per-marketplace postal-code overrides — each with its current value and whether it is the default or was set. '
      + 'Call it before telling the user what the pacer will do, and before changing a setting. '
      + 'Title-length caps and character units are NOT settings — they are verified market facts and are absent here on purpose.',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute() {
      const { listSettings } = await import('../store/settings.js')
      const rows = listSettings(store)

      const body = table(rows, [
        { label: '设置', value: row => row.key },
        { label: '值', value: row => JSON.stringify(row.value) },
        { label: '来源', value: row => (row.stored ? '已设置' : '默认') },
        { label: '说明', value: row => row.note ?? '—' },
      ])

      return [
        `设置 ${rows.length} 项:`,
        '',
        body,
        '',
        '注: 标题上限 / 字符单位 / 核验来源属于已核验的市场事实（domain/rules/marketplaces.js），不在设置里，也不可通过 amzn_setting_set 修改。',
      ].join('\n')
    },
  }
}

export function settingSetTool({ store, workbench }) {
  return {
    name: 'amzn_setting_set',
    description:
      'Change ONE workbench setting and report the stored value. Valid keys: pacing.maxAsinsPerTask, pacing.taskIntervalSec, '
      + 'pacing.dailyLimit (integers, >= 1), browser.headless (true/false), browser.profileDir (string or null), '
      + 'marketplace.<CODE>.postalCode (e.g. marketplace.US.postalCode), and the six approval toggles '
      + 'approval.batchCollect / approval.overwriteField / approval.activateVersion / approval.archive / '
      + 'approval.acceptDraft / approval.markPublished (true/false). '
      + 'The change takes effect on the NEXT collection task, not on one already running. '
      + 'Approval gates may be turned ON but never relaxed below the value they shipped with — the refusal says so by name. '
      + 'Refuses unknown keys and out-of-range values by name. It cannot change title caps or character units — those are verified market facts, not preferences. '
      + 'A setting that belongs to an archived workspace (or a session sitting in one) is refused with WORKSPACE_ARCHIVED and nothing changes. '
      + 'The hard approvals (autoPublish / deleteSnapshot / overwriteFact) have no key here and never will: they cannot be turned off, so there is nothing to set.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The setting key, e.g. pacing.taskIntervalSec.' },
        value: { description: 'The new value. Integers for pacing.*, a string otherwise.' },
        note: { type: 'string', description: 'Optional note recorded with the change.' },
      },
      required: ['key'],
    },
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const key = String(args?.key ?? '').trim()
      if (key === '') return { ok: false, error: 'key 为空', hint: '先调 amzn_setting_list 看有哪些键。' }
      if (args?.value === undefined) {
        return { ok: false, error: 'value 未提供', hint: '要写入的值放在 value 里；清空字符串类设置传空串或删键。' }
      }

      const { setSetting, getSetting } = await import('../store/settings.js')

      /* 归档即只读 (F02-01). `setSetting` writes ON CONFLICT(key) and never touches
         `workspace_id`, so the row keeps the space it already belongs to — read
         from the row, never assumed — and the scope bar's space is checked too,
         because a session parked in an archived workspace must not be able to
         change how the machine hits Amazon. Returned as a value rather than
         thrown: the tool contract is `{ok:false, code, error}`, and a throw here
         would come back as a failed turn instead of a refusal the caller can act
         on. Asked before the approval routing, so a refused write never reaches
         `setApproval` either. */
      const row = store.get('SELECT workspace_id FROM setting WHERE key = ?', [key])
      const refusal = workspaceWriteRefusal(store, row?.workspace_id, scopeWorkspaceIdOf(workbench))
      if (refusal !== null) {
        return {
          ...refusal,
          hint: '这个设置属于一个已归档的工作空间。先在工作空间页恢复它，或切到别的工作空间再写。',
        }
      }

      /* `getSetting` throws on an undeclared key, and that throw is the right
         answer *after* the write attempt — but doing it first turns a refusal
         into an unhandled exception instead of the `{ok:false}` the tool contract
         promises. So the read is deferred until the key is known to be settable;
         `setSetting` is the single authority on what counts as settable. */
      let before
      try {
        before = getSetting(store, key)
      } catch {
        before = undefined
      }

      let stored
      try {
        const { approvalFor, setApproval } = await import('../domain/approval/policy.js')
        const gate = approvalFor(key)
        if (gate !== null) {
          /* The same routing the page's `setting-set` does, for the same reason:
             the floor rule lives in `setApproval`, and a tool that wrote the key
             itself would be the one door the rule does not cover. The write is
             still `setSetting` underneath, so the audit action is unchanged. */
          const result = setApproval(store, gate.id, args.value)
          if (result.ok !== true) return { ok: false, code: result.code, error: result.error, hint: '审批项只能收紧，不能放宽。' }
          stored = result.value
        } else {
          /* Three arguments, because that is what `setSetting` takes. The note
             does not go here — it rides the call as the descriptor's `reason`
             and lands in `audit_log.reason`, which is where "why did this
             change" belongs. Passing it as a fourth argument looked like it was
             stored and was silently discarded. */
          stored = setSetting(store, key, args.value)
        }
      } catch (error) {
        return { ok: false, error: error.message, hint: '调 amzn_setting_list 确认键名与类型。' }
      }

      return [
        `已设置 ${key}`,
        `  ${JSON.stringify(before)} → ${JSON.stringify(stored)}`,
        args?.note ? `  备注: ${args.note}` : '',
        '',
        '下次采集任务生效；正在跑的任务不受影响。',
      ].filter(line => line !== '').join('\n')
    },
  }
}
