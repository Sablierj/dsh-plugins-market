/**
 * 店铺（shop）的工具层。
 *
 * ## 为什么这个工具是补出来的，而不是本来就有（R-10，2026-10-25 真实数据实测）
 *
 * 优化前置九门的**第 1 门「对象明确」**要求五个身份要素全部可解析，其中一个是**店铺**，
 * 而它的判据来源自己写着：「店铺 / 品牌 / 产品线来自 `asin_ownership` 的生效行」。
 *
 * 实测时想补这一格，撞到两件事：
 * 1. `shop` 表里只有一行，而且是**已归档的测试残留**；
 * 2. 想建一个 —— `index.js` 的 TOOLS 里**没有任何店铺工具**（0 命中），
 *    `routes.js` 里只有 `shop-save` / `shop-archive` / `shop-restore` 三个**页面**路由。
 *
 * **店铺只能从页面建，agent 建不了。** 而整个优化流程是 agent 驱动的，补数清单却写着
 * 「在设置页给这个 ASIN 记归属」—— 那条路 agent 走不了，于是第 1 门对 agent **永远降级**，
 * 无论它多努力。
 *
 * 这是 F-7 那条原则（「页面能做的事，工具就该能做」）的一处缺口，补上。
 *
 * ## store 层早就完备
 * `src/store/shop.js` 里 `upsertShop` / `archiveShop` / `restoreShop` / `listShops` 都在，
 * 也早被页面路由用着 —— **缺的只是工具层这一层壳**。所以这个文件只做三件事：
 * 参数校验、调 store、把结果说清楚（含四态：没有店铺 / 有但都归档了 / 有）。
 */

import {
  archiveShop,
  getShop,
  listShops,
  restoreShop,
  upsertShop,
  viewShop,
} from '../store/shop.js'
import { text, table } from './render.js'
/* 2026-10-25（R-83）：归档在别处是有门的 —— `amzn_asin_archive`、`amzn_workspace_upsert`
   与页面那几条归档路由都问 `approval.archive`，而店铺这里原来不问。
   同一类动作两种安全性，等于把门装在了人少走的那条路上。 */
import { approvalRefusal } from '../domain/approval/policy.js'

const ACTIONS = ['list', 'create', 'update', 'archive', 'restore']

export function shopTool({ store }) {
  return {
    name: 'amzn_shop_upsert',
    description:
      'Read, create, rename, archive or restore a shop (店铺). A shop is one of the five identity elements the '
      + 'optimization pre-flight requires (对象 / 站点 / 店铺 / 品牌 / 产品线); without a shop row the ASIN cannot '
      + 'record 店铺归属, and gate 1 stays degraded forever. This tool exists because that row was only creatable '
      + 'from the settings page — a page route cannot be called by an agent, so the pre-flight was un-completable '
      + 'from this side. Archiving hides a shop without deleting it; restore brings it back. Nothing is ever deleted.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'list (default) / create / update / archive / restore.',
          enum: ACTIONS,
        },
        id: { type: 'string', description: 'Shop id. Required for update / archive / restore; omit on create to get a generated one.' },
        name: { type: 'string', description: 'Display name. Required on create and update (a rename that keeps the same name is harmless).' },
        marketplace: { type: 'string', description: 'Site code, e.g. US / DE / JP. Omit to keep the current one on update.' },
        workspaceId: { type: 'string', description: 'Workspace the shop belongs to. Required to create; ignored on update (an id already says where it lives).' },
        note: { type: 'string', description: 'Free note.' },
        by: { type: 'string', description: 'Who is doing it — recorded on archive / restore.' },
        confirm: {
          type: 'boolean',
          description: '归档前的一次确认。当本工作空间开着「归档」二次确认时，不带这一项会被拒绝（APPROVAL_REQUIRED），'
            + '与 amzn_asin_archive / amzn_workspace_upsert 同一个门。',
        },
        includeArchived: { type: 'boolean', description: 'list only: include archived shops. Default false.' },
      },
    },
    async execute(args = {}) {
      const action = String(args.action ?? 'list').trim().toLowerCase()
      if (!ACTIONS.includes(action)) {
        return { ok: false, error: `unknown action "${action}"`, hint: `用其中之一: ${ACTIONS.join(' / ')}` }
      }

      if (action === 'list') {
        /* 四态在这里分开：没有 shop 行 / 有行但都归档了 / 有在用的行。
           「都归档了」和「一个都没有」在列表里长得很像，但下一步动作完全不同。 */
        /* `listShops` 的 SQL 是 `WHERE workspace_id = ?` —— 传 null 会拼成空串，
           一行都查不到，于是「这个工作区里没有」被印成了「一个店铺都没有」。
           我第一版就是这样，当场被自己的探针抓住（库里明明有一行已归档的）。
           **这是今天第 11 次同类：把「我没查到」印成「它不存在」。** */
        const workspaceId = String(args.workspaceId ?? '').trim() || 'ws-default'
        const active = listShops(store, workspaceId, { includeArchived: false })
        const all = listShops(store, workspaceId, { includeArchived: true })
        if (all.length === 0) {
          return {
            ok: true,
            action,
            shops: [],
            text: `工作区 ${workspaceId} 里一个店铺都没有。\n\n`
              + '**这不是「没有店铺数据」，是「这个工作区还没有建过」。**\n'
              + '优化前置第 1 门要求店铺归属，建一个之后就能把 ASIN 归进去：\n'
              + '  `amzn_shop_upsert { action: "create", name: "店铺名", marketplace: "US", workspaceId: "ws-default" }`',
          }
        }
        const lines = [
          `店铺 ${active.length} 个在用 / 共 ${all.length} 个（含归档）:`,
          '',
          table(all, [
            { label: 'id', value: row => row.id },
            { label: '名称', value: row => row.name },
            { label: '站点', value: row => row.marketplace ?? '—' },
            /* listShops 返回的是 `viewShop(row)`，**字段是 camelCase**：用 `archived_at` 会恒为 undefined，
               于是已归档的店铺会被印成「在用」（我第一版就是这样，被探针当场抓住）。
               这和 R-8 是同一型：store 映射之后名字变了，渲染层还在用蛇形。 */
            { label: '状态', value: row => (row.archivedAt ? '已归档' : '在用') },
            { label: '备注', value: row => row.note ?? '—' },
          ]),
        ]
        if (active.length === 0) {
          lines.push('', '⚠️ **没有在用的店铺**（上面那些都已归档）。归档是隐藏不是删除，`action: "restore"` 可以恢复。')
        }
        return { ok: true, action, shops: all, text: lines.join('\n') }
      }

      if (action === 'create' || action === 'update') {
        const id = String(args.id ?? '').trim()
        if (action === 'update' && id === '') {
          return { ok: false, error: 'update needs id', hint: '先用 action: "list" 看有哪些店铺' }
        }
        if (String(args.name ?? '').trim() === '') {
          return { ok: false, error: 'name is required', hint: '创建 / 改名都要给 name' }
        }
        try {
          const row = upsertShop(store, {
            id: id === '' ? undefined : id,
            name: args.name,
            marketplace: args.marketplace,
            workspaceId: args.workspaceId,
            note: args.note,
          })
          const view = viewShop(row)
          return {
            ok: true,
            action,
            shop: view,
            text: `${action === 'create' ? '已创建' : '已更新'}店铺 ${view.name}（id ${view.id}）\n`
              + `站点: ${view.marketplace ?? '（未填）'}\n\n`
              + '下一步：把 ASIN 归到这个店铺 ——\n'
              + '  `amzn_asin_ownership_set { asin, marketplace, objectType: "shop", objectId: "' + view.id + '", by, reason }`\n'
              + '（**不要**写 `asin` 表的缓存列：它是 `asin_ownership` 的镜像，下一次同步会按边重刷，\n'
              + '  而第 1 门读的是决策行。）',
          }
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }
      }

      /* archive / restore：两者都要一个真存在的 id —— 不存在的 id 报「没有这个」，
         而不是悄悄成功（「我删了」和「本来就没有」是两个答案）。 */
      const id = String(args.id ?? '').trim()
      if (id === '') return { ok: false, error: `${action} needs id` }
      const existing = getShop(store, id)
      if (existing === undefined) {
        return { ok: false, error: `no shop ${id}`, hint: '先用 action: "list" 看有哪些店铺' }
      }
      if (action === 'archive') {
        if (existing.archived_at) return { ok: true, action, alreadyArchived: true, shop: viewShop(existing), text: `店铺 ${existing.name} 早就是归档状态（${existing.archived_at}），这次没有改动。` }
        /* 与 `amzn_asin_archive` / `amzn_workspace_upsert` 同一道门（R-83）：
           归档在别处都问 `approval.archive`，店铺这里原来不问。 */
        const archiveRefusal = approvalRefusal(store, 'archive', args?.confirm,
          `归档店铺 ${existing.name}：归档是隐藏不是删除，按 id 仍然解析得出来，action: "restore" 可以恢复。`
          + '确认无误就再调一次并带 confirm: true。')
        if (archiveRefusal !== null) return archiveRefusal
        const row = archiveShop(store, id, args.by ?? null)
        return { ok: true, action, shop: viewShop(row), text: `已归档店铺 ${row.name}。归档是隐藏不是删除，按 id 仍然解析得出来；restore 可以恢复。` }
      }
      if (!existing.archived_at) return { ok: true, action, alreadyActive: true, shop: viewShop(existing), text: `店铺 ${existing.name} 本来就在用，这次没有改动。` }
      const row = restoreShop(store, id)
      return { ok: true, action, shop: viewShop(row), text: `已恢复店铺 ${row.name}。` }
    },
    /* 形状照 `product-line.js`：`output: { schema, render }`。
       我第一版写成扁平 `render:`，被主套件当场抓住
       （`amzn_shop_upsert has no output.render`）—— 这说明那条「每个工具都要有 output.render」
       的登记测试是真的在看，不是走过场。 */
    output: { schema: {}, render: (_args, result) => text(result?.text ?? JSON.stringify(result, null, 2)) },
  }
}
