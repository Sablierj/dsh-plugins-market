/**
 * `amzn_workspace_upsert` — create, rename, archive or promote a workspace.
 *
 * One tool rather than four, because the four are one object's lifecycle and a
 * model asked to "rename the shop workspace" should not have to pick a tool name
 * out of four before it can act. The `action` parameter says which edge of the
 * lifecycle is being taken.
 *
 * The tool **does not throw**. A tool that throws kills the whole turn, which is
 * the wrong outcome for "that name is already taken": the agent should get the
 * refusal back, with its machine code, and say something useful. The store's
 * errors carry `code` from `domain/states.js`, and it is passed through
 * unchanged so a caller can branch on `WORKSPACE_ARCHIVED` without reading prose.
 *
 * Writing goes through `store/workspace.js`, which is also what the page's
 * `POST /api/workspace-save` calls — so the page and the agent cannot come to
 * different conclusions about what a legal workspace name is.
 */

import { text } from './render.js'
/* S1-B17.1: the 归档 gate, on the archive edge only. */
import { approvalRefusal } from '../domain/approval/policy.js'
import {
  archiveWorkspace, createWorkspace, listWorkspaces, renameWorkspace, setDefaultWorkspace, view,
} from '../store/workspace.js'

const ACTIONS = ['create', 'rename', 'archive', 'restore', 'set_default']

export function workspaceUpsertTool({ store }) {
  return {
    name: 'amzn_workspace_upsert',
    description:
      'Create, rename, archive, restore or promote an Amazon workbench workspace. '
      + 'A workspace owns the configuration (settings, product lines, sources, site profiles), not the market facts: '
      + 'ASINs and keywords are shared, because they describe one marketplace rather than one shop. '
      + 'Archiving makes a workspace read-only — the rows stay and can be restored; nothing is deleted. '
      + 'The default workspace cannot be archived, and an archived one cannot become the default. '
      + 'Call this only when the user asks for it: creating a workspace is a decision about how they organise their work.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'Which lifecycle edge to take.' },
        id: { type: 'string', description: 'Workspace id. Required for rename / archive / restore / set_default. Omit on create to get a generated one.' },
        name: { type: 'string', description: 'The display name. Required on create and rename.' },
        note: { type: 'string', description: 'A short note, on create only.' },
        confirm: {
          type: 'boolean',
          description:
            'Set true to archive when this workspace has turned on the 归档 二次确认. Without it action "archive" is '
            + 'refused with code APPROVAL_REQUIRED and the workspace is untouched. create / rename / restore / '
            + 'set_default never need it.',
        },
      },
      required: ['action'],
    },
    output: { schema: {}, render: (_args, value) => text(value?.text ?? value?.error ?? value) },
    async execute(args) {
      const action = String(args?.action ?? '').trim()
      if (!ACTIONS.includes(action)) {
        return { ok: false, error: `action must be one of: ${ACTIONS.join(' | ')} (got ${JSON.stringify(args?.action)})` }
      }
      const id = String(args?.id ?? '').trim()

      /* 归档闸门只接在 archive 上。restore 是反方向的动作，把它一起拦下来，
         这个闸门的名字就从「归档」变成了「工作空间生命周期」—— 而名不副实的
         闸门，用户的第一反应是关掉它。 */
      if (action === 'archive') {
        const refusal = approvalRefusal(store, 'archive', args?.confirm,
          `要归档的工作空间：${id}。归档后它是只读的，列表里仍然在、也能恢复。确认无误就再调一次并带 confirm: true。`)
        if (refusal !== null) return refusal
      }

      try {
        let row
        if (action === 'create') {
          row = createWorkspace(store, { id: id === '' ? undefined : id, name: args?.name, note: args?.note })
        } else {
          if (id === '') return { ok: false, error: `id is required for action "${action}"` }
          if (action === 'rename') row = renameWorkspace(store, id, args?.name)
          else if (action === 'archive') row = archiveWorkspace(store, id, true)
          else if (action === 'restore') row = archiveWorkspace(store, id, false)
          else row = setDefaultWorkspace(store, id)
        }
        return {
          ok: true,
          action,
          workspace: view(row),
          text: `${verb(action)}：${row.name}（${row.id}）`
            + (row.is_default === 1 ? '，当前默认空间' : '')
            + (row.archived_at === null ? '' : '，已归档（只读）')
            + `。现有 ${listWorkspaces(store).length} 个工作空间。`,
        }
      } catch (error) {
        /* The store's refusals are the useful half of this tool: they name the
           key and the bound, or carry the machine code a caller branches on. */
        return {
          ok: false,
          action,
          error: error.message,
          ...(error.code === undefined ? {} : { code: error.code }),
          hint: 'Read the message: it names which workspace and which rule. Do not retry the same call unchanged.',
        }
      }
    },
  }
}

function verb(action) {
  if (action === 'create') return '已创建工作空间'
  if (action === 'rename') return '已改名'
  if (action === 'archive') return '已归档'
  if (action === 'restore') return '已恢复'
  return '已设为默认空间'
}
