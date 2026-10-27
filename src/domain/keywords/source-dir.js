/**
 * 关键词数据源的根目录。
 *
 * ## 结构是**契约**，不是建议
 *
 * 根目录下固定这几个子目录，名字一字不差；**目录名决定解析器**，文件名不再参与
 * 类型判断。理由是实测出来的：卖家精灵真实导出叫 `ReverseASIN-US-B0GV55Q4JG-...xlsx`，
 * 文件名规则一条都不匹配，会退化成纯词表 —— 87 个词进去了，自然排名、广告排名、
 * 购买数、竞价区间全丢。把类型交给目录，改名就不会再丢数据。
 *
 * 以后新增数据 = 往对应子目录里丢文件，结构不动。
 *
 * ## 「没导入」和「识别不了」是两件事
 *
 * `status` 三态：
 *   - `new`          扫描到了，库里没有这份字节（可导）
 *   - `imported`     库里有同样字节（再导是 no-op）
 *   - `unrecognized` 目录和文件名都判不出类型 —— 不猜，等人指定或挪位置
 *
 * 目录不存在时返回 `exists:false` 且**不返回空文件列表** —— 「目录不可达」和
 * 「目录是空的」是两个完全不同的答案，混成一个会让 WSL 没启动看起来像没数据。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { fingerprintOf, findImportByFingerprint } from '../../store/kw.js'
import { getSetting } from '../../store/settings.js'
import { detectImportKind } from './importers.js'

/**
 * 默认根目录：WSL 里那套亚马逊运营系统的关键词数据源。
 * 两个写法都能访问，这里取 `\\wsl$` —— 旧版 Windows build 也认。
 */
export const DEFAULT_SOURCE_DIR =
  '\\\\wsl$\\Ubuntu\\home\\open\\.openclaw\\amazon-ops-hub\\03-knowledge\\keywords\\master\\source'

/** 固定的子目录 → 解析器。`optional: true` 的缺了不算结构问题。 */
export const SOURCE_SUBDIRS = [
  { dir: 'brand-terms', kind: 'brand_terms', label: 'ABA 搜索查询绩效', optional: false },
  { dir: 'search-terms', kind: 'ad_report', label: '广告搜索词报告', optional: false },
  { dir: 'sellerjingling', kind: 'competitor_sellersprite', label: '卖家精灵 ASIN 反查', optional: false },
  { dir: 'xiyou', kind: 'competitor_xiyou', label: '西柚 关键词反查', optional: false },
  { dir: 'manual', kind: 'keyword_list', label: '手工关键词清单', optional: true },
]

const ACCEPTED = /\.(xlsx|xls|csv|json)$/i

/** 超过这个大小就不在扫描时算 hash —— 扫描要快，导入时才读全文。 */
const HASH_LIMIT_BYTES = 40 * 1024 * 1024

/**
 * 当前生效的根目录：设置项优先，空则默认。
 *
 * 返回 `isDefault` 而不是只回一个字符串：界面上「默认」和「我改过」
 * 必须能分开，否则「恢复默认」这个按钮没有意义。
 */
export function sourceRoot(store) {
  const stored = String(getSetting(store, 'kw.sourceDir') ?? '').trim()
  return {
    root: stored === '' ? DEFAULT_SOURCE_DIR : stored,
    stored: stored === '' ? null : stored,
    isDefault: stored === '',
  }
}

/**
 * 从文件名里读月份。读不出来就是 null —— 不编一个「本月」。
 *
 * 认得的形状（都是这批文件的真实命名）：
 *   ROFIEJOX_..._Month_2026_03_31.csv   → 2026-03
 *   竞品关键词数据ASIN-US-B0DQP37YND(665)-20260328.xlsx → 2026-03
 *   关键词反查结果_US_B0CR3TMYVP_202606~202607.xlsx     → 2026-06
 *   深谷-us-sp-搜索词-20260101-20260415-1-....xlsx      → 2026-01
 */
export function monthOf(fileName) {
  const name = String(fileName ?? '')
  const underscore = /(20\d{2})[_-](0[1-9]|1[0-2])[_-](0[1-9]|[12]\d|3[01])/.exec(name)
  if (underscore !== null) return `${underscore[1]}-${underscore[2]}`
  const compact = /(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/.exec(name)
  if (compact !== null) return `${compact[1]}-${compact[2]}`
  const yearMonth = /(20\d{2})(0[1-9]|1[0-2])(?!\d)/.exec(name)
  if (yearMonth !== null) return `${yearMonth[1]}-${yearMonth[2]}`
  return null
}

/** 子目录名 → 类型；认不出返回 null（不做模糊匹配）。 */
export function kindForSubdir(dirName) {
  const hit = SOURCE_SUBDIRS.find(item => item.dir === String(dirName ?? '').toLowerCase())
  return hit === undefined ? null : hit.kind
}

/**
 * 类型家族：同一个数据源可能有两种落盘格式，**目录只能定到家族**。
 *
 * 实测：`sellerjingling/` 里既有 `竞品关键词数据ASIN-*.xlsx`（表格导出），
 * 也有 `B0XXXXXXXX_keywords_US_*.json`（API dump）—— 两者都是卖家精灵，
 * 但解析器不同。只按目录一刀切会把 JSON 当 xlsx 解，报 "not a zip archive"。
 *
 * 所以规则是：**目录定家族，文件名可以在家族内细化**。跨家族的细化一律不认
 * （那样"目录即类型"就退化成"文件名说了算"了）。
 */
const KIND_FAMILY = {
  brand_terms: 'brand_terms',
  ad_report: 'ad_report',
  competitor_sellersprite: 'sellersprite',
  competitor_sellersprite_json: 'sellersprite',
  competitor_xiyou: 'xiyou',
  keyword_list: 'generic',
}

/**
 * 一个文件的类型判定：**目录 → 家族内细化 → 文件名 → 认不出**。
 *
 * `via` 记的是结论从哪来，因为「按目录定的」和「按文件名猜的」可信度不同，
 * 界面上要能分开显示。
 */
export function kindForFile(root, filePath) {
  const relative = String(filePath).slice(String(root).length).replace(/^[\\/]+/, '')
  const segments = relative.split(/[\\/]+/)
  const byName = detectImportKind(basename(String(filePath)))

  if (segments.length >= 2) {
    const byDir = kindForSubdir(segments[0])
    if (byDir !== null) {
      /* 同家族里更具体的那个赢：目录说 sellersprite，文件名说 sellersprite_json
         → 用 json 的解析器。跨家族不认。 */
      if (byName.confident && KIND_FAMILY[byName.kind] === KIND_FAMILY[byDir]) {
        return { kind: byName.kind, via: 'dir+name', confident: true }
      }
      return { kind: byDir, via: 'dir', confident: true }
    }
  }
  if (byName.confident) return { kind: byName.kind, via: 'name', confident: true }
  return { kind: null, via: null, confident: false }
}

function listFiles(directory) {
  if (!existsSync(directory)) return []
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && ACCEPTED.test(entry.name))
      .map(entry => join(directory, entry.name))
  } catch {
    return []
  }
}

function describeFile(store, root, filePath) {
  const name = basename(filePath)
  const kind = kindForFile(root, filePath)
  let bytes = 0
  let mtime = null
  try {
    const info = statSync(filePath)
    bytes = info.size
    mtime = info.mtime.toISOString()
  } catch { /* 读不到就留空，不编一个时间 */ }

  let status = kind.kind === null ? 'unrecognized' : 'new'
  let importId = null
  let importedAt = null
  if (kind.kind !== null && bytes > 0 && bytes <= HASH_LIMIT_BYTES) {
    try {
      const fingerprint = fingerprintOf(readFileSync(filePath))
      const previous = findImportByFingerprint(store, fingerprint)
      if (previous !== undefined && previous !== null) {
        status = 'imported'
        importId = previous.id
        importedAt = previous.imported_at
      }
    } catch { /* 读不动就当没导过，导入时会再报一次真原因 */ }
  }

  return {
    name,
    path: filePath,
    bytes,
    mtime,
    month: monthOf(name),
    kind: kind.kind,
    kindVia: kind.via,
    status,
    importId,
    importedAt,
  }
}

/**
 * 扫描一个根目录。
 *
 * @param {object} store
 * @param {{root?: string}} options 不给 root 就用设置项 / 默认值
 */
export function scanSourceDir(store, { root = null } = {}) {
  const resolved = sourceRoot(store)
  const target = root === null ? resolved.root : String(root)

  if (!existsSync(target)) {
    return {
      ok: false,
      reason: 'not-found',
      root: target,
      isDefault: resolved.isDefault,
      stored: resolved.stored,
      defaultRoot: DEFAULT_SOURCE_DIR,
      exists: false,
      dirs: [],
      files: [],
      missing: [],
      counts: { files: 0, new: 0, imported: 0, unrecognized: 0 },
    }
  }

  const dirs = []
  const files = []
  const missing = []

  for (const spec of SOURCE_SUBDIRS) {
    const directory = join(target, spec.dir)
    const exists = existsSync(directory)
    if (!exists && spec.optional !== true) missing.push(spec.dir)
    const found = exists ? listFiles(directory) : []
    const described = found.map(filePath => describeFile(store, target, filePath))
    files.push(...described)
    dirs.push({
      dir: spec.dir,
      kind: spec.kind,
      label: spec.label,
      optional: spec.optional === true,
      exists,
      files: described.length,
      new: described.filter(file => file.status === 'new').length,
      imported: described.filter(file => file.status === 'imported').length,
      latestMonth: described.map(file => file.month).filter(Boolean).sort().at(-1) ?? null,
    })
  }

  /* 根目录下直接放的文件：类型只能靠文件名，认不出就标未识别，
     并提示挪进对应子目录 —— 而不是替它挑一个类型。 */
  for (const filePath of listFiles(target)) {
    files.push(describeFile(store, target, filePath))
  }

  const counts = {
    files: files.length,
    new: files.filter(file => file.status === 'new').length,
    imported: files.filter(file => file.status === 'imported').length,
    unrecognized: files.filter(file => file.status === 'unrecognized').length,
  }

  return {
    ok: true,
    root: target,
    isDefault: resolved.isDefault,
    stored: resolved.stored,
    defaultRoot: DEFAULT_SOURCE_DIR,
    exists: true,
    dirs,
    files,
    missing,
    counts,
  }
}

/**
 * 补齐缺失的子目录。只建**空目录**，不写任何文件。
 *
 * 不替用户判断根目录选得对不对：一个子目录都没有时这里照样建，但界面上
 * 会说「这不像关键词数据源目录」—— 建目录是可逆的，猜根目录不是。
 */
export function createMissingDirs(root) {
  const target = String(root ?? '')
  if (target === '' || !existsSync(target)) {
    return { ok: false, error: '根目录不存在，不能建子目录', created: [] }
  }
  const created = []
  for (const spec of SOURCE_SUBDIRS) {
    const directory = join(target, spec.dir)
    if (existsSync(directory)) continue
    try {
      mkdirSync(directory, { recursive: true })
      created.push(spec.dir)
    } catch { /* 单个失败不影响其它，调用方看 created 长度 */ }
  }
  return { ok: true, created }
}

/** 目录里有没有任何子目录（用来区分「选错了目录」和「结构还没建」）。 */
export function looksLikeSourceRoot(root) {
  if (!existsSync(String(root ?? ''))) return false
  return SOURCE_SUBDIRS.some(spec => existsSync(join(String(root), spec.dir)))
}
