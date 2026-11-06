/**
 * dsh-plugin-sif-ops — host 半。
 *
 * 只做三件事：建服务 → 注册工具 → 注册页面。真正的取数/入库/分析在 src/ 下，
 * 这样「模块」是按能力切的，不是按文件切的（M1 骨架 / M2 连接 / M3 存储 / M4 同步 / M5 看板）。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createService } from './src/service.js'
import { registerTools } from './src/tools.js'
import { registerWeb } from './src/web/routes.js'

export const name = 'sif-ops'

/** 页面与工具都要，webServer 在 registerWeb 内部按需注入（无 web 的 profile 也能加载工具）。 */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))

/** 侧边栏 iframe 指向的路径；与 lib/client.js 里的 PAGE_PATH 必须一致。 */
export const PAGE_PATH = '/custom/sif-ops'

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const dataDir = config.dataDir ? String(config.dataDir) : join(HERE, 'data')

  const service = createService({
    dataDir,
    logger,
    defaults: {
      endpoint: config.endpoint,
      dailyBudget: config.dailyBudget,
    },
  })

  const toolNames = registerTools(ctx, { service })
  registerWeb(ctx, { service, pagePath: PAGE_PATH, logger })

  // 插件被卸载/重载时收尾，避免留下第二个数据库连接。
  ctx.effect(() => () => service.close(), 'sif-ops: service')

  logger.info?.(`[sif-ops] tools: ${toolNames.join(', ')}`)
  logger.info?.(`[sif-ops] page: ${PAGE_PATH}  data: ${dataDir}`)
}
