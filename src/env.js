/**
 * 采集前的环境自检：浏览器、登录态、下载目录、Python、数据目录、上次采集时间。
 *
 * 为什么单独做：真出事时（端口没开、cookie 过期、python 路径变）报错都发生在
 * 采集跑到一半，用户看到的是「没数据」。先把能查的都查一遍，缺什么直接说。
 */

import { existsSync, mkdirSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { probe } from './cdp.js'

const execFileAsync = promisify(execFile)

const ok = (id, name, detail) => ({ id, name, status: 'ok', detail })
const warn = (id, name, detail, fix) => ({ id, name, status: 'warn', detail, fix })
const fail = (id, name, detail, fix) => ({ id, name, status: 'fail', detail, fix })

/** 目录可写检查（写一个临时文件再删）。 */
function dirWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function preflight(config, { dbStats, dbPath, dataDir, exportDir, downloadDir } = {}) {
  const checks = []

  // 1) 调试端口
  const p = await probe(config.cdpUrl).catch(() => ({ ok: false }))
  if (p.ok) checks.push(ok('cdp', '采集浏览器', `${p.browser || 'Chrome'} @ ${config.cdpUrl}`))
  else checks.push(fail('cdp', '采集浏览器', `连不上 ${config.cdpUrl}`, '调 action=login 或 login1688 拉起浏览器'))

  // 2) Python（xlsx 读写全靠它）
  let pyOk = false
  let pyDetail = ''
  try {
    const { stdout } = await execFileAsync(config.pythonPath, ['-c', 'import openpyxl,sys;print(sys.version.split()[0])'], { windowsHide: true, timeout: 15000 })
    pyOk = true
    pyDetail = `Python ${stdout.trim()} + openpyxl`
  } catch (error) {
    pyDetail = String(error && error.message ? error.message : error).slice(0, 120)
  }
  checks.push(pyOk ? ok('python', 'Python / openpyxl', pyDetail) : fail('python', 'Python / openpyxl', pyDetail, '在 config 里改 pythonPath'))

  // 3) 目录
  const dirs = [
    ['dataDir', '数据目录', dataDir],
    ['exportDir', '导出目录', exportDir],
    ['downloadDir', '下载目录（1688 导出落点）', downloadDir],
  ]
  for (const [id, name, dir] of dirs) {
    if (!dir) continue
    checks.push(dirWritable(dir) ? ok(id, name, dir) : fail(id, name, `${dir} 不可写`, '检查磁盘/权限'))
  }

  // 4) 库
  if (dbStats) {
    const by = (dbStats.byPlatform || []).map((row) => `${row.platform} ${row.c}`).join(' · ') || '空库'
    checks.push(ok('db', '本地库', `${dbPath}（${dbStats.total} 单：${by}）`))
  }

  // 5) 上次采集
  if (dbStats && dbStats.lastRun) {
    const run = dbStats.lastRun
    const when = run.finished_at || run.started_at || ''
    const stale = when ? (Date.now() - Date.parse(when)) / 3600000 : null
    const detail = `${run.scope || ''} ${run.status || ''} ${when}`
    checks.push(stale != null && stale > 24 ? warn('lastRun', '上次采集', `${detail}（超过 24 小时）`, '跑一次 export / sync1688') : ok('lastRun', '上次采集', detail))
  } else {
    checks.push(warn('lastRun', '上次采集', '还没有采集记录', '先跑一次 export'))
  }

  // 6) 汇总
  const failed = checks.filter((c) => c.status === 'fail')
  const warned = checks.filter((c) => c.status === 'warn')
  return {
    ok: failed.length === 0,
    ready: failed.length === 0,
    summary: failed.length ? `${failed.length} 项不满足` : warned.length ? `可用（${warned.length} 项提醒）` : '全部就绪',
    checks,
  }
}

/** 平台登录态：需要浏览器，单独查（可选）。 */
export async function loginChecks(config, { connect, pdd, ali1688 }) {
  const checks = []
  let page = null
  try {
    page = await connect(config.cdpUrl, { match: (u) => u.includes('pinduoduo.com') || u.includes('1688.com'), pickExisting: true, newTabUrl: 'about:blank' })
  } catch (error) {
    return [fail('login', '平台登录', `拿不到浏览器页面：${String(error.message || error).slice(0, 80)}`, '先调 action=login / login1688')]
  }
  try {
    await page.navigate(pdd.ORDERS_URL)
    await page.waitForReady(30000).catch(() => {})
    const pddLogin = await pdd.isLoggedIn(page).catch(() => null)
    checks.push(pddLogin === true ? ok('login.pdd', '拼多多登录', '已登录') : fail('login.pdd', '拼多多登录', '未登录或判不出来', '调 action=login 扫码'))

    await page.navigate(ali1688.BUYER_ORDERS_URL)
    await page.waitForReady(30000).catch(() => {})
    await new Promise((r) => setTimeout(r, 2500))
    const counts = await ali1688.readCounts(page).catch(() => ({}))
    const ali = await ali1688.detectLogin(page).catch(() => ({ login: null, reason: '检测失败' }))
    const hasList = Object.keys(counts).length > 0
    checks.push(
      ali.login === true || hasList
        ? ok('login.1688', '1688 登录', hasList ? `已登录（待发货 ${counts['待发货'] ?? '—'} / 待收货 ${counts['待收货'] ?? '—'}）` : '已登录')
        : fail('login.1688', '1688 登录', ali.reason || '未登录', '调 action=login1688 扫码'),
    )
  } finally {
    page.close()
  }
  return checks
}

/**
 * 两个平台的登录态检测（一次打开浏览器，两个站各看一次），结果写进状态缓存。
 * 返回 { pdd: {...}, '1688': {...}, checkedAt }。
 */
export async function checkPlatforms(config, { connect, pdd, ali1688, writeState, stateFile }) {
  const checkedAt = new Date().toISOString()
  const state = {}
  let page = null
  try {
    page = await connect(config.cdpUrl, {
      match: (u) => u.includes('pinduoduo.com') || u.includes('1688.com'),
      pickExisting: true,
      newTabUrl: 'about:blank',
    })
  } catch (error) {
    const reason = `拿不到浏览器页面：${String((error && error.message) || error).slice(0, 80)}`
    return {
      pdd: { login: null, detail: reason, checkedAt },
      '1688': { login: null, detail: reason, checkedAt },
      checkedAt,
      error: reason,
    }
  }
  // 停在 1688 的 Quark 页面时，Page.navigate 偶尔回 Invalid parameters → 退回 location.assign
  const go = async (url) => {
    try {
      await page.navigate(url)
    } catch {
      await page.evaluate(`location.assign(${JSON.stringify(url)})`).catch(() => {})
    }
    await page.waitForReady(30000).catch(() => {})
  }
  try {
    // 拼多多
    try {
      await go(pdd.ORDERS_URL)
      const login = await pdd.isLoggedIn(page).catch(() => null)
      state.pdd = {
        login: login === true ? true : login === false ? false : null,
        detail: login === true ? '已登录（订单页可读）' : login === false ? '未登录或登录已过期' : '判不出来（页面没渲染完或改版）',
        checkedAt,
      }
    } catch (error) {
      state.pdd = { login: null, detail: `检测失败：${String((error && error.message) || error).slice(0, 60)}`, checkedAt }
    }

    // 1688
    try {
      await go(ali1688.ORDER_LIST_URL('waitbuyerreceive', 100))
      await new Promise((r) => setTimeout(r, 2500))
      const counts = await ali1688.readCounts(page).catch(() => ({}))
      const hasList = Object.keys(counts).length > 0
      const ali = await ali1688.detectLogin(page).catch(() => ({ login: null, reason: '检测失败' }))
      state['1688'] = {
        login: ali.login === true || hasList ? true : ali.login === false ? false : null,
        detail: hasList
          ? `已登录（待发货 ${counts['待发货'] ?? '—'} / 待收货 ${counts['待收货'] ?? '—'}）`
          : ali.reason || '判不出来',
        checkedAt,
      }
    } catch (error) {
      state['1688'] = { login: null, detail: `检测失败：${String((error && error.message) || error).slice(0, 60)}`, checkedAt }
    }
  } finally {
    page.close()
  }
  state.checkedAt = checkedAt
  if (writeState && stateFile) await writeState(stateFile, state).catch(() => {})
  return state
}
