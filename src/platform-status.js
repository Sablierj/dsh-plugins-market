/**
 * 平台环境状态：拼多多 / 1688 各自「是否已登录、是否具备采集条件」。
 *
 * 设计取舍：
 *  - 真去开页面查登录态要 10~30 秒，不能每 5 秒轮询都跑 → 检测结果写成本地缓存（带时间戳）；
 *  - 面板只读缓存（快），要刷新就点「检测登录」走一次真检测；
 *  - 缓存过期或从没检测过，就说「未检测」，绝不假装已登录。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const PLATFORMS = [
  { id: 'pdd', name: '拼多多', loginAction: 'login', entry: 'https://mobile.pinduoduo.com/orders.html' },
  { id: '1688', name: '1688', loginAction: 'login1688', entry: 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html' },
]

export const STALE_MINUTES = 30

export async function readState(file) {
  try {
    const text = await readFile(file, 'utf8')
    const data = JSON.parse(text)
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

export async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 1), 'utf8')
  return state
}

/**
 * 把「缓存里的一条 + 浏览器是否连着」翻译成面板能直接显示的状态。
 * 纯函数，方便单测。
 */
export function readiness(platform, entry, { connected = false, now = Date.now(), staleMinutes = STALE_MINUTES } = {}) {
  const base = { id: platform.id, name: platform.name, loginAction: platform.loginAction, login: null, level: 'unknown' }
  if (!connected) {
    return {
      ...base,
      level: 'offline',
      text: '浏览器未启动',
      detail: '采集浏览器没连上，先把浏览器拉起来',
      guide: { action: platform.loginAction, label: `打开${platform.name}登录` },
      ready: false,
    }
  }
  if (!entry || entry.login === undefined || entry.login === null) {
    return {
      ...base,
      level: 'unknown',
      text: '未检测',
      // 有检测记录就把原因带出来（「判不出来」多半是页面没渲染完/改版，这比只说未检测有用）
      detail: entry && entry.detail ? entry.detail : entry && entry.checkedAt ? `上次检测 ${entry.checkedAt}` : '还没检测过登录态',
      guide: { action: 'checkLogin', label: '检测登录' },
      ready: false,
    }
  }
  const age = entry.checkedAt ? (now - Date.parse(entry.checkedAt)) / 60000 : Infinity
  if (age > staleMinutes) {
    return {
      ...base,
      login: entry.login,
      level: 'unknown',
      text: '检测已过期',
      detail: `上次检测 ${entry.checkedAt}（${Math.round(age)} 分钟前）`,
      guide: { action: 'checkLogin', label: '重新检测' },
      ready: false,
    }
  }
  if (entry.login === true) {
    return {
      ...base,
      login: true,
      level: 'ready',
      text: '已登录',
      detail: entry.detail || '具备采集条件',
      guide: null,
      ready: true,
    }
  }
  return {
    ...base,
    login: false,
    level: 'need-login',
    text: '未登录',
    detail: entry.detail || '需要扫码登录后才能采集',
    guide: { action: platform.loginAction, label: `去登录${platform.name}` },
    ready: false,
  }
}

/** 汇总：全部平台都 ready 才算「具备采集条件」。 */
export function summarize(list) {
  const ready = list.filter((item) => item.ready).length
  const needLogin = list.filter((item) => item.level === 'need-login').length
  return {
    ready: ready === list.length && list.length > 0,
    readyCount: ready,
    total: list.length,
    needLogin,
    text:
      ready === list.length
        ? '两个平台都已登录，具备采集条件'
        : needLogin
          ? `${needLogin} 个平台未登录，先扫码`
          : '登录态未确认，点「检测登录」',
  }
}
