/**
 * `amzn_product_import` — 产品表导入（赛狐），模块 05 的自有 ASIN 归属配置。
 *
 * 三个动作，一条主线：
 *   scan     列目录里的表格文件（不解析、不写库）
 *   preview  读一份表 → 推荐品牌 → 出计划（**只读**）
 *   commit   把计划里可入库的行写进 product_profile（一次事务）
 *
 * 品牌是**整批一个**：需求方原话「导入的这一批都是这个品牌」。
 * `preview` 会把推荐品牌算出来（默认值），人确认后传给 `commit`。
 *
 * 配置表语义：四段（店铺/品牌/父/ASIN）缺一段就**不入库**，进待补清单。
 * 工具不做「先写进去再补」——那会让配置表变成又一张事实表。
 */

import { readFileSync } from 'node:fs'

import {
  buildProductPlan, commitProductPlan, fingerprintOf, listProfiles,
  readProductRows, recommendBrand, resolveProductDir, scanProductDir,
} from '../domain/asin/product-import.js'
import { table, text } from './render.js'

/** 计划里每一行的一句话状态。 */
function statusText(row) {
  if (row.status === 'ready') return '可入库'
  if (row.status === 'duplicate') return `重复（与第 ${row.duplicateOf} 行同四元组）`
  if (row.status === 'pending-brand') return '待补品牌'
  if (row.status === 'pending-shop') return `待补店铺（表里写「${row.shop}」，shop 表里没有）`
  return row.status
}

function planText(plan, { path, recommend }) {
  const lines = []
  lines.push(`文件：${path}`)
  lines.push(`共 ${plan.counts.total} 行 · 可入库 ${plan.counts.ready}`
    + ` · 待补品牌 ${plan.counts.pendingBrand} · 待补店铺 ${plan.counts.pendingShop}`
    + ` · 重复 ${plan.counts.duplicate}`)
  lines.push(`本批品牌：${plan.brand === '' ? '（空 —— 一行也写不进去）' : plan.brand}`
    + (recommend === null ? '' : `（推荐 ${recommend.brand}，规则命中 ${recommend.hits}/${recommend.considered}）`))
  const bad = plan.rows.filter(row => row.status !== 'ready').slice(0, 20)
  if (bad.length > 0) {
    lines.push('')
    lines.push('进不了库的行（前 20）：')
    lines.push(table(bad, [
      { label: '行号', value: row => row.line },
      { label: 'ASIN', value: row => row.asin },
      { label: '店铺', value: row => row.shop },
      { label: '状态', value: row => statusText(row) },
    ]))
  }
  if (plan.counts.ready > 0) {
    lines.push('')
    lines.push('前 5 行示例：')
    lines.push(table(plan.rows.filter(row => row.status === 'ready').slice(0, 5), [
      { label: '店铺', value: row => row.shopName },
      { label: '品牌', value: row => row.brand },
      { label: '父 ASIN', value: row => row.parentAsin },
      { label: 'ASIN', value: row => row.asin },
      { label: '站点', value: row => row.marketplace ?? '—' },
    ]))
  }
  return lines.join('\n')
}

export function productImportTool({ store, dataDir }) {
  return {
  name: 'amzn_product_import',
  description: '产品表导入（赛狐）：扫描目录里的 .xlsx → 推荐品牌 → 预览计划 → 确认入库。'
    + '写的是 product_profile（店铺 + 品牌 + 父 ASIN + ASIN 四元组唯一）；'
    + '四段缺一段的行不入库，进待补清单。品牌整批一个。',
  /* 字段名必须是 `parameters` —— 本仓每个工具都用它，DSH 的注册表只读这一个键。
     写成 `inputSchema` 时 `parameters` 是 undefined，**整张工具表**在转成模型 schema 时
     当场抛 `parameters must be lossless JSON before schema projection`，症状是这台机器上
     每一个会话的每一轮都立刻失败（不只是这个工具不能用）。 */
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['scan', 'preview', 'commit', 'list', 'upsert'], description: 'Default preview. upsert writes ONE row directly, no spreadsheet needed.' },
        asin: { type: 'string', description: 'upsert: the ASIN (10 chars).' },
        shopId: { type: 'string', description: 'upsert: shop id (from amzn_shop_upsert).' },
        brand: { type: 'string', description: 'upsert: brand name.' },
        parentAsin: { type: 'string', description: 'upsert: parent ASIN. Omit for a single-ASIN product — it will be self-referenced and flagged parentSelf.' },
        marketplace: { type: 'string', description: 'upsert: site code, e.g. US.' },
        productLineId: { type: 'string', description: 'upsert: product line id.' },
        sku: { type: 'string', description: 'upsert: optional SKU.' },
        productName: { type: 'string', description: 'upsert: optional product name.' },
        note: { type: 'string', description: 'upsert: optional note.' },
      path: { type: 'string', description: '表格的绝对路径。省略则用目录里最新的那份。' },
      shopId: { type: 'string', description: '只用这个店铺的品牌规则（可选）。' },
      brand: { type: 'string', description: '这一批用的品牌。preview 可省略（自动推荐），commit 必须给。' },
      limit: { type: 'number', description: 'list：返回条数，默认 50。' },
    },
  },
  /* execute 只收 args：store / dataDir 由工厂闭包带进来（见 buildTools 的 `deps`）。
     写成 `execute({ store, args })` 会把**调用参数**当成依赖容器，args 永远是 undefined。 */
  async execute(args = {}) {
    const action = args?.action ?? 'preview'
    const resolved = resolveProductDir(store, { dataDir: dataDir ?? process.cwd() })

    if (action === 'upsert') {
      /* R-12：给 product_profile 一条不依赖 xlsx 的直写路径。它原来是「只能靠导入赛狐表格」
         才写得进去的，于是店铺归属那一格虽然修活了（R-11 加了兜底），agent 依然走不到。 */
      const written = upsertProductProfile(store, {
        asin: args?.asin,
        marketplace: args?.marketplace ?? 'US',
        shopId: args?.shopId,
        brand: args?.brand,
        parentAsin: args?.parentAsin,
        productLineId: args?.productLineId,
        sku: args?.sku,
        productName: args?.productName,
        note: args?.note,
      })
      if (written.ok !== true) {
        return { ok: false, error: written.error, hint: '四条归属都要给全：asin / shopId / brand / marketplace' }
      }
      const row = written.row
      const lines = [
        `已写入产品四元组：${row.asin}（${row.marketplace}）`,
        `  店铺 ${row.shop_id}`,
        `  品牌 ${row.brand}`,
        `  父 ASIN ${row.parent_asin}`,
        `  产品线 ${row.product_line_id ?? '（未填）'}`,
      ]
      if (written.parentSelf) {
        lines.push('', '⚠️ 没有给 parentAsin，所以写了**自指**（父 = 自己）。',
          '表的 parent_asin 是 NOT NULL，单 ASIN 商品在库里存不下「我没有父」这个事实 ——',
          '这里是自指，**不是真的有一个叫它自己名字的父**。要表达真实变体家族，请传 parentAsin。')
      }
      lines.push('', '这一行现在是优化前置第 1 门「店铺」的依据（precheck 读 product_profile.shop_id）。')
      return { ok: true, action, productProfile: row, parentSelf: written.parentSelf === true, text: lines.join('\n') }
    }

    if (action === 'scan') {
      const scanned = scanProductDir(resolved.dir)
      if (!scanned.exists) {
        return { ok: false, text: `目录不存在：${resolved.dir}\n（默认目录 ${resolved.defaultDir}；可在设置里改 asin.sourceDir）` }
      }
      if (scanned.files.length === 0) {
        return { ok: true, text: `目录里没有 .xlsx：${scanned.dir}` }
      }
      return {
        ok: true,
        ...scanned,
        text: `目录：${scanned.dir}\n` + table(scanned.files, [
          { label: '文件', value: file => file.name },
          { label: '大小', value: file => `${Math.round(file.size / 1024)} KB` },
          { label: '修改时间', value: file => String(file.mtime ?? '').slice(0, 19) },
        ]),
      }
    }

    if (action === 'list') {
      const rows = listProfiles(store, { limit: args?.limit ?? 50 })
      if (rows.length === 0) return { ok: true, text: '还没有任何产品归属记录。' }
      /* 2026-10-25（R-24）：`parent_asin` 是 NOT NULL，单 ASIN 商品只能**自指**
         （`parent_asin = asin`）—— 库里存不下「我没有父」。
         `upsertProductProfile` 会返回 `parentSelf` 标记，**但那个标记只在写入时产生，
         读的时候从来没人看**（全仓 grep 只有三处，两处在写、一处是参数说明）。
         于是任何读这张表的人看到 `parent_asin = B0XXX`，都无从知道
         那是「自己就是父」还是「它其实没有父」。**一个产生了却没人消费的标记，等于没产生。**

         这里在读取侧把它算出来并**用文字说出来**，让「单 ASIN」和「真父子」在屏幕上分得开。
         没有改 schema：改 NOT NULL 要重建表，风险远大于收益；
         这一列本来就是「这一条记录的父」，自指 + 文字说明足以表达，缺的只是**读的时候说出来**。 */
      const shown = rows.map(row => ({
        ...row,
        parentSelf: row.parent_asin === row.asin,
        parentLabel: row.parent_asin === row.asin ? '（无父 · 单 ASIN）' : row.parent_asin,
      }))
      return {
        ok: true,
        rows: shown,
        text: table(shown, [
          { label: '店铺', value: row => row.shop_id },
          { label: '品牌', value: row => row.brand },
          { label: '父 ASIN', value: row => row.parentLabel },
          { label: 'ASIN', value: row => row.asin },
          { label: '站点', value: row => row.marketplace },
        ])
          + (shown.some(row => row.parentSelf)
            ? '\n\n注：「（无父 · 单 ASIN）」表示这一条商品自己没有父 —— 库里 `parent_asin` 是 NOT NULL，'
              + '所以它存的是**自指**（`parent_asin = asin`）。这里写出来，是因为那一列本身看不出这层区别。'
            : ''),
      }
    }

    /* preview / commit 都要先拿到文件。 */
    let path = args?.path ?? null
    if (path === null || path === '') {
      const scanned = scanProductDir(resolved.dir)
      if (!scanned.exists) return { ok: false, text: `目录不存在：${resolved.dir}` }
      if (scanned.files.length === 0) return { ok: false, text: `目录里没有 .xlsx：${scanned.dir}` }
      path = scanned.files[0].path
    }

    let buffer
    try {
      buffer = readFileSync(path)
    } catch (error) {
      return { ok: false, text: `读不了文件：${path}\n${error.message}` }
    }
    let parsed
    try {
      parsed = readProductRows(buffer)
    } catch (error) {
      return { ok: false, text: `解析失败：${error.message}` }
    }

    const recommend = recommendBrand(store, parsed.rows)
    const brand = String(args?.brand ?? '').trim() || (action === 'commit' ? '' : recommend.brand)
    if (action === 'commit' && brand === '') {
      return { ok: false, text: 'commit 需要明确给 brand —— 品牌是配置表的一部分，不能由工具替你决定。' }
    }

    /* T39 F4：工具路径也要按店铺过滤 —— 参数声明了就必须生效，否则
       「只导入这家店」会在 API 侧悄悄变成全库。 */
    const plan = buildProductPlan(store, { rows: parsed.rows, brand, shopId: args?.shopId ?? null })

    if (action === 'preview') {
      return { ok: true, plan, recommend, text: planText(plan, { path, recommend }) }
    }

    const result = commitProductPlan(store, { plan, path, fingerprint: fingerprintOf(buffer) })
    return {
      ok: true,
      ...result,
      text: `已写入 ${result.written} 条产品归属（品牌 ${result.brand}），`
        + `待补 ${result.pending} 条。\n`
        + `父子关系已同步到 asin_variant_relation。\n`
        + `重复导入同一份文件是更新，不会插第二条（四元组唯一）。`,
    }
  },
  output: {
    schema: {},
    render: (_args, value) => text(value?.text ?? ''),
  },
  }
}
