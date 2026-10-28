/**
 * Host 侧：BOSS 招聘流水线（v2）
 *
 * 四层数据：
 *   jobs       —— 岗位目录，每个岗位有独立的筛选口径（criteria）、要点（highlights）与话术流程（flow）
 *   candidates —— 候选人台账，按 "<jobId>::<bossId>" 分岗位隔离
 *   counters   —— 每日打招呼/浏览计数，按 "<jobId>::<日期>" 记
 *   views      —— "看过但不招呼"去重登记，按 "姓名|公司" 记
 *
 * 纪律：
 *   - 判定以候选人自述为准推进，真伪留待人工核验
 *   - 本插件只做判断 / 记录 / 排序 / 给人看的话术，**不自动发送任何消息**
 *   - 所有读写 pipeline.json 都经过 withState()，load-mutate-save 串行，避免并发互相覆盖
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 必须包含 webServer，否则 ctx.webServer 是 undefined，面板路由会被静默跳过 */
export const inject = ['tools', 'systemPrompt', 'webServer']

const STORE_DIR = process.env.BOSS_RECRUIT_STORE_DIR || join(homedir(), '.dsh-boss-recruit')
const STORE_FILE = join(STORE_DIR, 'pipeline.json')
const API_PATH = '/boss-recruit/api'
const STATE_VERSION = 3

const EDU_RANK = [
  ['博士', 6], ['硕士', 5], ['本科', 4], ['大专', 3], ['高职', 3],
  ['高中', 2], ['中专', 2], ['中技', 2], ['不限', 0],
]

/** 阶段枚举（v2 新增 pending 待定） */
const STAGES = [
  'new', 'greeted', 'inbound', 'qualified', 'resume_requested',
  'resume_received', 'interview_pending', 'interview_available',
  'interview_scheduled', 'pending', 'rejected', 'stale',
]

// v2.26.0｜沟通页独有的阶段：只有 reply 模式 + 有效 chatScope 才能推进。
// 为什么加这道硬门禁：recruit 模式下 upsert 这些阶段以前是能过的，于是「在推荐页顺手把
// 沟通页的状态也推了」变成了一条绕过 mode / chatScope 的捷径，两道护栏形同虚设。
// 现在绕过它 = 状态推不上去，和 markGreet 的 screen 闸门同一个思路。
const CHAT_ONLY_STAGES = [
  'resume_requested', 'resume_received',
  'interview_pending', 'interview_available', 'interview_scheduled',
]

const STAGE_LABEL = {
  new: '新来信待处理',
  greeted: '已打招呼',
  inbound: '已回话',
  qualified: '初筛通过',
  resume_requested: '已索简历',
  resume_received: '已收简历',
  interview_pending: '待约面',
  interview_available: '候选人给了时间',
  interview_scheduled: '已约面',
  pending: '待定',
  rejected: '已淘汰',
  stale: '超期未回复',
}

const NEXT_STEP = {
  new: '先评估履历（学历/毕业年限/工作年限/项目匹配）再决定是否招呼',
  greeted: '等回复；若自述满足口径 → 置 qualified 并发「要附件简历」',
  inbound: '候选人已回话：先看简历 → 评估 → 匹配就发「要附件简历」',
  qualified: '发「要附件简历」话术',
  resume_requested: '等候选人发附件简历',
  resume_received: '发「简历回执 + 问可面试日期」话术',
  interview_pending: '已问面试日期，等候选人答复；若已知时间可直接用 interview 动作定档',
  interview_available: '用 interview 动作定档（时间/地点/方式），会渲染好邀约话术，发出后即 interview_scheduled',
  interview_scheduled: '已约面：到点跟进；候选人要改期就用 interview 动作改时间',
  pending: '待定：期望薪资超上限，不淘汰，等人工/HR 决策',
  rejected: '不再回复',
  stale: '超时未回复，停止跟进',
}

/** 淘汰原因分类 */
const REJECT_REASON_LABEL = {
  city: '城市',
  edu: '学历',
  year: '年限',
  direction: '方向',
  salary: '薪资',
  freshgrad: '应届',
  other: '其他',
}

const MODE_LABEL = {
  recruit: '招聘模式（只浏览+打招呼）',
  reply: '回话模式（只处理回话）',
  all: '混合模式（招聘 + 回话都做）',
}

// ---------------------------------------------------------------------------
// v2.1 新增：派生评分字段（techFit 项目技术要求匹配度 / value 性价比）
// 等级表与默认词表只定义在这里一份，通过 API 的 definitions 暴露给 Client 渲染
// ---------------------------------------------------------------------------

/** 工程深度关键词默认值（岗位 criteria.techDepthKeywords 可编辑，匹配时大小写不敏感） */
const TECH_DEPTH_KEYWORDS_DEFAULT = [
  '性能优化', 'DrawCall', 'GPU Instancing', '对象池', '内存优化', 'GC', 'Profiler', 'FrameDebugger',
  'AssetBundle', 'Addressables', '热更', 'HybridCLR', 'xlua', 'tolua', '红点', 'UI框架', 'MVC', 'MVVM',
  '状态机', '战斗系统', '技能系统', '帧同步', '联机', 'Shader', 'LOD', '遮挡剔除', '寻路', 'AStar',
  'Timeline', '图集', '多平台适配',
]

/** techFit 等级表（85-100 S / 70-84 A / 55-69 B / 40-54 C / 0-39 D） */
const TECH_FIT_GRADES = [
  { grade: 'S', label: '极匹配', min: 85, max: 100 },
  { grade: 'A', label: '高度匹配', min: 70, max: 84 },
  { grade: 'B', label: '基本匹配', min: 55, max: 69 },
  { grade: 'C', label: '部分匹配', min: 40, max: 54 },
  { grade: 'D', label: '弱匹配', min: 0, max: 39 },
]

/** value 等级表；NA = 不可评估（面议 / 未写薪资 / 预算缺失） */
const VALUE_GRADES = [
  { grade: 'S', label: '极高性价比', min: 85, max: 100 },
  { grade: 'A', label: '高性价比', min: 70, max: 84 },
  { grade: 'B', label: '中上', min: 55, max: 69 },
  { grade: 'C', label: '一般', min: 40, max: 54 },
  { grade: 'D', label: '偏低', min: 0, max: 39 },
  { grade: 'NA', label: '不可评估', min: null, max: null },
]

/** techFit 四维权重（合计 100） */
const TECH_FIT_WEIGHTS = { must: 40, plus: 20, project: 20, depth: 20 }

/** 转数值或 null（绝不让 NaN / undefined 进入 JSON） */
function numOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 保留 1 位小数（只用于展示与 breakdown，不参与最终取整） */
function round1(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0
}

/** 保留 2 位小数（成本比 / 预算中值） */
function round2(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

/** 按分数取等级元信息：分数为 null / 非数字 → NA / 不可评估 */
function gradeMetaOf(table, score) {
  const n = numOrNull(score)
  if (n == null) return { grade: 'NA', label: '不可评估' }
  const row = table.find((t) => t.min != null && n >= t.min && n <= t.max)
  return row || table[table.length - 1]
}

/** 岗位默认话术流程（v2：由 templates 对象改为有序数组，便于前端逐行编辑） */
function defaultFlow() {
  return [
    {
      key: 'greet',
      name: '打招呼',
      enabled: true,
      template:
        '您好，请问您毕业于哪一年，什么专业？是否学信网可查？' +
        '本岗位为{jobTitle}，要求{eduMin}及以上学历、毕业{gradYearMin}年及以上、学信网可查，' +
        '{city}，薪资{salary}，若符合且有兴趣咱们可进一步沟通！',
    },
    { key: 'askResume', name: '索取简历', enabled: true, template: '您好，可以发我一份您的详细简历附件吗？' },
    {
      key: 'ackResume',
      name: '简历回执',
      enabled: true,
      template: '您好，很高兴能收到您的简历，这边简历初审通过后会尽快安排面试的，请问您方便面试的日期是哪天呢？',
    },
    { key: 'askInterview', name: '约面试', enabled: true, template: '您好，简历已通过初审，想和您约个面试时间，请问您哪天方便？' },
    {
      key: 'interviewInvite',
      name: '邀约面试',
      enabled: true,
      template:
        '{name}您好，简历已通过初审，面试安排如下：\n' +
        '时间：{time}\n' +
        '地点：{location}{address}\n' +
        '方式：{mode}\n' +
        '联系人：{contact} {phone}\n' +
        '{link}\n' +
        '{extra}\n\n' +
        '麻烦您回复确认一下，如果需要调整时间请提前告诉我，谢谢！',
    },
    { key: 'clarify', name: '追问澄清', enabled: true, template: '请问下您的学历是否满足要求，学信网是否可查？' },
    { key: 'reject', name: '不合适', enabled: false, template: '' },
  ]
}

/** v1/v2 老模板字段 → v2 flow key 的映射 */
const LEGACY_TEMPLATE_KEY = {
  greet: 'greeting',
  askResume: 'askResume',
  ackResume: 'ackResume',
  clarify: 'clarify',
}

// v2.7.0｜拟人化操作参数（防风控）。不是装饰：这些值直接决定每次落点、停顿、浏览与分叉。
// 2026-10-21 web 端被限制 24h，根因就是这些参数全是「常量」——同一像素、等间隔、零浏览、无分叉。
const HUMANIZE_DEFAULT = {
  clickOffsetPx: 15,            // 落点在控件中心 ±N px 内随机，禁止每次打同一像素
  preMoveCount: 2,              // 点击前先做 1~N 次预移动，产生 mousemove 轨迹
  preMoveDelayMs: [120, 420],   // 预移动之间的随机停顿
  actionPauseMs: [600, 1800],   // 连续动作（点击 / 滚动 / 切换）之间的随机停顿
  hoverDwellMs: [300, 1200],    // 鼠标在目标上的停留时间（触发 mouseover / mouseenter）
  scrollBeforeClick: 0.35,      // 点击前先滚动一下的概率
  browseDwellSec: [20, 40],
  // v2.14.0：看在线简历时逐步下滑（readPlan 用）
  resumeScroll: { times: 3, minAmount: 2, maxAmount: 4, minPauseMs: 800, maxPauseMs: 2000 },     // 点开在线简历后的阅读停留
  skipRate: 0.15,               // 「看了但不打招呼」的比例，制造行为分叉
  wanderRate: 0.1,              // 每 N 条招呼后切去沟通页再切回来的概率
  typeCharDelayMs: [60, 160],   // 打字逐字延迟；不要整段粘贴
  verifyCooldownMin: 30,        // 遇到 passport 验证码后的强制冷却分钟数
  dailyHardCap: 40,             // 单账号单日硬上限（80 是理论额度，不是安全量）
}

function humanizeOf(criteria) {
  const out = Object.assign({}, HUMANIZE_DEFAULT)
  const h = criteria && criteria.humanize
  if (h && typeof h === 'object') {
    for (const k of Object.keys(HUMANIZE_DEFAULT)) {
      if (h[k] !== undefined && h[k] !== null) out[k] = h[k]
    }
  }
  return out
}

// v2.8.0｜回话边界（Reply Guard）：限制 Agent 在「沟通」页乱说话。
// 不是提示词建议，是可执行的黑名单：发出去之前先过 checkReply，命中就改口。
const REPLY_GUARD_DEFAULT = {
  enabled: false,   // v2.9.0：回话判断以提示词为主，关键词兜底默认关闭
  maxChars: 80,
  forbid: [
    // 1) 不能自己约面试、不能给面试时间
    '面试时间', '约面试', '面试日期', '哪天方便', '什么时候方便', '安排面试', '面试安排',
    // 2) 不能跟候选人提预算 / 评价对方薪资 / 说难听话
    '预算', '期望太', '薪资差距', '给不到', '太高了', '不合适', '暂时不考虑',
    // 3) 不能承诺具体答复时间，也不能替 HR / 面试官答应事情
    '明天回复', '今天回复', '稍后回复', '尽快回复', '尽快给你答复', '我跟HR', '我跟面试官', '我协调',
    // 4) 不能给保证性承诺
    '保证', '一定能', '肯定能', '包过', '百分百',
    // 5) 不要主动索要私人联系方式（平台内沟通即可）
    '加微信', '加个微信', '微信号', '手机号多少', '留个电话',
    // 6) 不谈派驻 / 外派的具体周期
    '派驻周期', '外派多久', '驻场多久', '项目周期多久',
  ],
  softWarn: [
    '工资', '薪水', '加班', '出差', '转正', '试用期', '五险一金',
  ],
}

function replyGuardOf(criteria) {
  const out = Object.assign({}, REPLY_GUARD_DEFAULT)
  const g = criteria && criteria.replyGuard
  if (g && typeof g === 'object') {
    for (const k of ['enabled', 'maxChars', 'forbid', 'softWarn']) {
      if (g[k] !== undefined && g[k] !== null) out[k] = g[k]
    }
  }
  out.forbid = Array.isArray(out.forbid) ? out.forbid.map((s) => String(s)).filter(Boolean) : []
  out.softWarn = Array.isArray(out.softWarn) ? out.softWarn.map((s) => String(s)).filter(Boolean) : []
  return out
}

// v2.9.0｜回话规则：**以提示词为主**，直接注入 system prompt，由 AI 按规则自己判断。
// v2.8.x 的 replyGuard 关键词黑名单降级为「可选兜底」，默认关闭。
const REPLY_RULES_DEFAULT = [
  '你是招聘方，只能按「当前阶段对应的话术」回复候选人，不要自由发挥。',
  '',
  '## 一、绝对不要做的事',
  '1. 不要主动约面试、不要给面试时间或地点、不要问「哪天方便」——除非台账里这个人已被人工置为面试阶段。',
  '2. 不要跟候选人谈预算、不要评价对方薪资、不要说「期望太高 / 给不到 / 暂时不合适」——超预算的内部记待定，对候选人只发标准回执。',
  '3. 不要承诺具体答复时间（明天回复 / 尽快答复 / 稍后回复），也不要替 HR 或面试官答应任何事。',
  '4. 不要做保证性承诺（保证 / 一定能 / 百分百 / 包过）。',
  '5. 不要主动索要微信、手机号，平台内沟通即可。',
  '6. 不要谈派驻 / 外派的具体周期。被问到就说「长期稳定的项目，客户方一直有需求，正常按年走」，不承诺时长。',
  '',
  '## 二、回复怎么写',
  '7. 先判断对方在哪一步：初次回复 / 自述符合口径 / 交了简历 / 给了可面试时间 / 说了不合适的话，然后**只发那一步对应的模板**，不叠加、不额外补充。',
  '8. 拿不准、模板覆盖不到的情况：**不回复**，把情况写进台账备注，交给人工决定。宁可少回一句，不要多说一句。',
  '9. 不闲聊、不介绍公司业务、不解释筛选标准、不评价候选人。',
  '10. 单条不超过 {replyMaxChars} 字，语气礼貌克制。',
  '',
  '## 三、特殊情况',
  '11. 候选人明确说「外包 / 外派不考虑」：不回复、不劝说，直接记淘汰。',
  '12. 候选人问薪资细节：不报具体数字，只重复岗位口径里的薪资区间。',
].join('\n')

// v2.10.0｜两条硬闸门：①不看在线简历不许打招呼 ②沟通页不先选岗位不许回话
function findScreen(state, jobId, bossId, includeConsumed) {
  const list = Array.isArray(state.screens) ? state.screens : []
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i]
    if (!s || s.jobId !== jobId || s.bossId !== bossId) continue
    if (!s.consumedAt || includeConsumed) return s
  }
  // v2.13：screens 数组丢过（重启后曾出现），用 screenIndex 兜底，避免已看过的人被判成「没看过」
  const idx = state.screenIndex && state.screenIndex[bossId]
  if (idx && idx.jobId === jobId) {
    if (!idx.consumedAt || includeConsumed) return idx
  }
  return null
}

/** 打招呼前置校验：返回错误字符串，或 null 表示通过；通过时消费掉该 screen */
function requireScreenForGreet(state, jobId, args) {
  const bossId = args.bossId || (args.name ? `${args.name}|${args.company || '-'}` : '')
  if (!bossId) {
    return '必须带 name + company（或 bossId）：不指名就无法证明这个人你看过在线简历'
  }
  const sc = findScreen(state, jobId, bossId, true)
  if (!sc) {
    return `没有 ${bossId} 的 screen 记录。正确顺序：在推荐页点开他的卡片 → 看在线简历的项目经验 → ` +
      `调 screen(name, company, resumeRead=true, projects="从简历里读到的项目原文", score, decision="greet") → 再打招呼`
  }
  if (sc.decision !== 'greet') {
    return `screen 里这个人的 decision 是「${sc.decision}」，不是 greet，不允许打招呼`
  }
  if (sc.consumedAt) return null   // 已经消费过 = 这条招呼确实打过了，补记台账要放行
  const need = sc.dwellMinSec || 20
  const have = (Date.now() - new Date(sc.at).getTime()) / 1000
  if (have < need) {
    return `刚登记简历只过了 ${Math.round(have)} 秒，至少要看满 ${need} 秒再打招呼`
  }
  sc.consumedAt = nowISO()
  return null
}

/** 沟通页岗位作用域：返回错误字符串，或 null 表示通过 */
function requireChatScope(state, job, jobId) {
  const sc = state.chatScope
  if (!sc || !sc.at) {
    return `还没声明沟通页的岗位筛选。先去「沟通」页把左上角职位下拉选成「${job.criteria.jobTitle || job.name}」，` +
      `再调 chatScope(jobId=${jobId}, pageJobLabel="页面上显示的职位名")，然后才回话`
  }
  if (sc.jobId !== jobId) {
    return `chatScope 记录的是另一个岗位（${sc.jobId}），当前岗位是 ${jobId}：先切岗位筛选，再 chatScope`
  }
  const maxAge = (job.criteria.chatScopeTtlMin || 120) * 60 * 1000
  if (Date.now() - new Date(sc.at).getTime() > maxAge) {
    return 'chatScope 已过期，重新确认一遍沟通页的岗位筛选再 chatScope'
  }
  return null
}

/**
 * v2.26.0｜沟通阶段的模式闸门：返回错误字符串，或 null 表示通过。
 * recruit（招聘模式）下不允许把候选人推进到沟通页独有的阶段——
 * 那些阶段只能在「沟通」页产生，用推荐页的操作去推它，等于伪造了一个没发生的对话。
 */
function requireReplyModeForStage(state, jobId, stage) {
  if (!CHAT_ONLY_STAGES.includes(stage)) return null
  const mode = (state.jobModes && state.jobModes[jobId]) || state.mode || 'recruit'
  if (mode === 'recruit') {
    return `「${STAGE_LABEL[stage] || stage}」只能在沟通页产生，当前是招聘模式（recruit）。` +
      `先 mode(mode="reply") 去「沟通」页处理，再 upsert stage=${stage}；` +
      `在推荐页顺手推这个阶段会被拒——它不是一次打招呼能到的状态`
  }
  return null
}

/**
 * v2.26.0｜沟通阶段的台账合并闸门：既要 reply 模式，也要有效 chatScope。
 * 只查 chatScope 不查 mode 会漏掉「人还在推荐页、作用域恰好没过期」这种混合态。
 */
function requireChatContext(state, job, jobId, stage) {
  const modeErr = requireReplyModeForStage(state, jobId, stage)
  if (modeErr) return modeErr
  return requireChatScope(state, job, jobId)
}

// v2.11.0｜工作流程：每一步就是一个「动作」。面板可增删改排序，渲染进 system prompt 作为唯一执行顺序。
const WORKFLOW_DEFAULT = {
  recruit: [
    { key: 'scope', action: '确认岗位筛选', text: '推荐页右上角职位筛选必须是本岗位，不是就先切换' },
    { key: 'scroll', action: '把列表滚到底', text: '底部出现「没有更多了」才算看完，否则会漏人' },
    { key: 'open', action: '点开卡片 → 在线简历', text: '点卡片中部进入在线简历，不是只看摘要' },
    { key: 'read', action: '读项目经验（像人一样往下滑）', text: '点开简历后先调 readPlan 拿滑动序列，照它逐步往下滑 2-3 次（每次 2-4 行、每次停 0.8-2 秒）；即使一屏放得下也必须滑，滑完再判定。总停留至少 {screenMinReadSec} 秒' },
    { key: 'screen', action: 'screen 登记', text: 'resumeRead=true，projects 写简历原文（≥20字），decision=greet/skip/reject' },
    { key: 'judge', action: '综合评估', text: '学历 / 毕业年限 / 工作年限 / 城市 / 方向 + 技术匹配分，任一硬项不符就不打' },
    { key: 'greet', action: '点「打招呼」', text: '仅 decision=greet 的人；先调 clickPlan(x,y) 拿拟人点击序列再执行，不要直接点控件中心' },
    { key: 'mark', action: 'markGreet 1', text: '打完立刻记，禁止事后批量补记' },
    { key: 'pace', action: '回 pace 查间隔', text: '按返回的 nextAction 决定下一步，不要连发' },
  ],
  reply: [
    { key: 'scope', action: '确认岗位筛选', text: '沟通页左上角职位下拉选成本岗位，否则会张冠李戴' },
    { key: 'chatScope', action: 'chatScope 声明作用域', text: 'pageJobLabel 填页面上显示的职位名，对不上会被拒' },
    { key: 'sweep', action: '扫会话列表', text: '看预览判断最后一句谁说的：以[已读]/[送达]开头=我发的' },
    { key: 'open', action: '打开会话读上下文', text: '只读不点，先弄清对方说到哪一步' },
    { key: 'judge', action: '按回话规则判断', text: '该不该回、回哪一步的模板；拿不准就不回，记备注交人工' },
    { key: 'reply', action: '逐字输入并发送', text: '单条 ≤{replyMaxChars} 字，禁止整段粘贴' },
    { key: 'log', action: 'log 记录要点', text: '毕业年份/学信网/工作年限/期望薪资/可面试时间/项目匹配点' },
    { key: 'stage', action: '更新 stage', text: '按固定动作推进，不跳步' },
  ],
}

function workflowOf(criteria) {
  const out = { recruit: [], reply: [] }
  const w = criteria && criteria.workflow
  for (const k of ['recruit', 'reply']) {
    const arr = w && Array.isArray(w[k]) && w[k].length ? w[k] : WORKFLOW_DEFAULT[k]
    out[k] = arr
      .filter((s) => s && (s.action || s.text))
      .map((s, i) => ({
        key: String(s.key || `step${i + 1}`),
        action: String(s.action || `步骤${i + 1}`),
        text: String(s.text || ''),
      }))
  }
  return out
}

function defaultCriteria() {
  return {
    // v2.3：默认值只放中立占位——真实岗位口径由用户在自己本地的台账里维护，
    // 代码进公开仓库，不携带任何具体客户 / 项目 / 城市 / 薪资信息
    jobTitle: '<岗位标题>',
    city: '',
    cityWhitelist: [],
    salaryMinK: 0,
    salaryMaxK: 0,
    expectSalaryMinCapK: 15,
    eduMin: '大专',
    gradYearMin: 3,
    workYearMin: 3,
    xuexinRequired: true,
    mustSkills: ['Unity', 'C#'],
    plusSkills: ['性能优化', 'Shader'],
    rejectSkills: ['Cocos', 'Lua脚本', 'UE4', 'UE5'],
    projectKeywords: [
      'Unity', 'U3D', '客户端开发', '游戏开发', '手游', '小游戏',
      '帧同步', 'Shader', '性能优化',
    ],
    // v2.1 新增：工程深度证据词表，参与 techFit 的「工程深度证据」维度
    techDepthKeywords: [...TECH_DEPTH_KEYWORDS_DEFAULT],
    // v2.3 新增：方向加分词（原先写死在代码里的业务方向词表，改为岗位口径字段）
    // 命中即计入加分 hits，并参与 starWorthy（⭐优先回捞）判断；默认 [] = 不做方向加分
    starTokens: [],
    requireProjectKeyword: true,
    dealbreakers: ['应届/未毕业', '学历低于大专'],
    greetQuotaPerDay: 80,
    roundGreetSize: 15,
    staleDays: 7,
    // ---- 以下为节奏/防风控参数（沿用 v1，便于 pace / markGreet 继续工作）----
    salary: '',
    roundRestMinSec: 600,
    roundRestMaxSec: 1800,
    greetMinGapSec: 300,
    greetMaxGapSec: 720,
    browseBeforeGreetMin: 1,
    browseBeforeGreetMax: 3,
    browseDwellMinSec: 15,
    browseDwellMaxSec: 60,
    humanize: HUMANIZE_DEFAULT,
    replyGuard: REPLY_GUARD_DEFAULT,
    replyRules: REPLY_RULES_DEFAULT,
    chatScopeTtlMin: 120,
    screenMinReadSec: 20,
    workflow: WORKFLOW_DEFAULT,
  }
}

function defaultJob(id, name) {
  const jobId = id || 'default-job'
  return {
    id: jobId,
    name: name || '未命名岗位',
    active: true,
    createdAt: new Date().toISOString(),
    // 该岗位的候选人序号计数器，每登记一个新候选人 +1
    seqCounter: 0,
    criteria: defaultCriteria(),
    highlights: [],
    flow: defaultFlow(),
  }
}

function defaultState() {
  const job = defaultJob()
  return {
    version: STATE_VERSION,
    activeJobId: job.id,
    // recruit=只浏览+打招呼；reply=只处理回话；all=混合
    mode: 'recruit',
    jobs: { [job.id]: job },
    // v2.2：每个岗位各自记住上次用的模式，切岗位时恢复（state.mode 恒等于当前岗位的模式）
    jobModes: { [job.id]: 'recruit' },
    candidates: {},
    counters: {},
    views: {},
    blacklist: [],
    screens: [],
    screenIndex: {},
    chatScope: null,
    flowContext: null,
    inbox: {},
  }
}

/** 去重键：姓名 + 公司。两者一起才能稳定区分同名的人。 */
function dedupKeyOf(name, company) {
  const n = String(name || '').trim()
  const c = String(company || '').trim()
  if (!n) return ''
  return `${n}|${c || '-'}`
}

// v2.4 精简输出：记账只需知道"落哪一档、下一步做什么"，不必回吐整份档案。
// 全量对象留给 verbose=true 或 list/get，避免每次 upsert 烧 2-3K tokens。
function compactResult(cand, opts) {
  const o = opts || {}
  const stage = cand.stage || 'new'
  const out = {
    ok: true,
    seq: cand.seq,
    name: cand.name,
    stage,
    stageLabel: STAGE_LABEL[stage] || stage,
    status7: status7Of(cand).status7,
    status7Label: status7Of(cand).status7Label,
  }
  if (NEXT_STEP[stage]) out.next = NEXT_STEP[stage]
  if (stage === 'rejected' && cand.rejectReason) {
    out.rejectReason = cand.rejectReason
    if (REJECT_REASON_LABEL[cand.rejectReason]) {
      out.rejectLabel = REJECT_REASON_LABEL[cand.rejectReason]
    }
  }
  if (cand.techFitGrade) out.fit = cand.techFitGrade
  if (cand.valueGrade) out.value = cand.valueGrade
  if (o.gaps && o.gaps.length) out.gaps = o.gaps
  if (o.suggest) out.suggest = o.suggest
  if (typeof o.logCount === 'number') out.logs = o.logCount
  return out
}
// v2.15.0：给列表加一条「人员状态」轴——按招聘真实进度说话，而不是内部 stage 名
const STATUS7_LABEL = {
  newGreet: '新招呼',
  qualified: '初步沟通信息满足',
  unqualified: '初步沟通不满足',
  resumeAsked: '已要简历',
  resumeGiven: '已给简历',
  interviewTodo: '待约面',
  interviewDone: '已约面',
  hold: '待定/搁置',
}
function status7Of(cand) {
  if (!cand) return { status7: 'newGreet', status7Label: STATUS7_LABEL.newGreet }
  const forced = cand.status7
  const stage = cand.stage || 'new'
  const map = {
    new: 'newGreet',
    greeted: 'newGreet',
    inbound: 'newGreet',
    qualified: 'qualified',
    rejected: 'unqualified',
    resume_requested: 'resumeAsked',
    resume_received: 'resumeGiven',
    interview_pending: 'interviewTodo',
    interview_available: 'interviewTodo',
    interview_scheduled: 'interviewDone',
    pending: 'hold',
    stale: 'hold',
  }
  const status7 = forced && STATUS7_LABEL[forced] ? forced : (map[stage] || 'newGreet')
  return { status7, status7Label: STATUS7_LABEL[status7] || status7 }
}

// v2.18.0 去重规则（阿周定）：有手机号 → 按手机号；没手机号 → 姓名 + 最近两家公司
// v2.21.1：公司名归一化——去掉括号内容与常见后缀，避免「中粮海优（北京）」与「中粮我买网」
// 这种平台/简历不一致被当成两个人（2026-10-26 徐万通、仇先生各重复一条）。
function normCompany(x) {
  return String(x || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, "")
    .replace(/(有限责任公司|有限公司|股份公司|分公司|集团|公司)$/g, "")
    .toLowerCase()
}
// v2.22.0：把 ISO 时间统一显示成「YYYY-MM-DD HH:mm」（本地时区）
function fmtTime(v) {
  const s = String(v || "").trim()
  if (!s) return ""
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return s
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function dedupeKeysOf(cand) {
  const out = []
  const phone = String(cand.phone || "").replace(/\D/g, "")
  if (phone.length >= 7) out.push(`tel:${phone}`)
  const name = String(cand.name || "").trim()
  if (name) {
    const cos = [cand.company, cand.company2].map((x) => String(x || "").trim()).filter(Boolean)
    const seen = new Set()
    for (const co of cos) {
      const nco = normCompany(co)
      if (!nco || seen.has(nco)) continue
      seen.add(nco)
      out.push(`nc:${name}|${nco}`)
    }
  }
  return out
}
function findDuplicate(state, jobId, cand) {
  const mine = dedupeKeysOf(cand)
  if (!mine.length) return null
  // v2.18.1：命中多条时不要撞上"空白重复行"——优先选有沟通记录的那条，
  // 其次选最早入库的，避免把资料并进一个后建的空壳记录。
  const hits = []
  for (const [k, other] of Object.entries(state.candidates || {})) {
    if (!other || other.jobId !== jobId) continue
    if (other.bossId === cand.bossId) continue
    const theirs = dedupeKeysOf(other)
    if (theirs.some((x) => mine.includes(x))) hits.push({ key: k, cand: other })
  }
  if (!hits.length) return null
  if (hits.length === 1) return hits[0]
  hits.sort((a, b) => {
    const la = (a.cand.dialogLog || []).length
    const lb = (b.cand.dialogLog || []).length
    if (la !== lb) return lb - la
    const fa = a.cand.firstSeenAt || '9'
    const fb = b.cand.firstSeenAt || '9'
    return fa < fb ? -1 : fa > fb ? 1 : 0
  })
  return hits[0]
}

function candKey(jobId, bossId) {
  return `${jobId}::${bossId}`
}

function nowISO() {
  return new Date().toISOString()
}

function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 给人看的时间：本地时区 YYYY-MM-DD HH:mm */
function fmtLocal(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  )
}

function eduRank(label) {
  const t = String(label || '')
  for (const [name, rank] of EDU_RANK) {
    if (t.includes(name)) return rank
  }
  return 0
}

/** 解析期望薪资文本为 { minK, maxK }，例如 "15-20K" → {15,20}；"面议" → {null,null} */
function parseSalaryK(text) {
  const t = String(text || '')
  const range = t.match(/(\d+(?:\.\d+)?)\s*[kK]?\s*[-~到至]\s*(\d+(?:\.\d+)?)/)
  if (range) return { minK: Number(range[1]), maxK: Number(range[2]) }
  const single = t.match(/(\d+(?:\.\d+)?)\s*[kK千]/)
  if (single) return { minK: Number(single[1]), maxK: Number(single[1]) }
  return { minK: null, maxK: null }
}

/** 从旧备注里推断淘汰原因（仅用于给 v2 老数据补 rejectReason；判不准就返回空串） */
function inferRejectReason(note) {
  const t = String(note || '')
  if (!t) return ''
  if (/应届|未毕业/.test(t) && /淘汰|不满足|不符/.test(t)) return 'freshgrad'
  if (/学历/.test(t) && /不达标|低于|不满足|门槛|仅|为高中/.test(t)) return 'edu'
  if (/期望城市|非本地|城市不符|期望城市不符/.test(t)) return 'city'
  if (/毕业年限|工作年限|年限不足|毕业满|工作满/.test(t)) return 'year'
  if (/Cocos|UE4|UE5|Lua脚本/.test(t) && /方向|不匹配|非\s*Unity|以.{0,6}为主/.test(t)) return 'direction'
  if (/薪资|期望.{0,6}K/.test(t) && /高于|低于|超|不予/.test(t)) return 'salary'
  return ''
}

// ---------------------------------------------------------------------------
// 迁移：v1（单岗位、z 裸键）/ v2（多岗位、templates 对象）→ v3（flow + highlights + 评分字段）
// 只补新字段默认值，绝不改写既有候选人业务数据
// ---------------------------------------------------------------------------

function migrateJob(id, raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const def = defaultJob(id, src.name)
  const srcC = src.criteria && typeof src.criteria === 'object' ? src.criteria : {}
  const criteria = { ...def.criteria, ...srcC }

  // 旧字段：salary 字符串 → salaryMinK / salaryMaxK
  if (criteria.salaryMinK == null || criteria.salaryMaxK == null) {
    const parsed = parseSalaryK(srcC.salary)
    if (criteria.salaryMinK == null && parsed.minK != null) criteria.salaryMinK = parsed.minK
    if (criteria.salaryMaxK == null && parsed.maxK != null) criteria.salaryMaxK = parsed.maxK
  }
  // 旧字段：needXuexinSelfReport → xuexinRequired
  if (srcC.xuexinRequired == null && srcC.needXuexinSelfReport != null) {
    criteria.xuexinRequired = Boolean(srcC.needXuexinSelfReport)
  }
  // v2.2：只补「不是数组」的情况。显式写空数组 [] 表示该岗位不限城市（新建空白岗位会这样），
  // 不再强行塞回任何具体城市，否则新建岗位会莫名其妙按某城市卡人。
  // v2.3：回落默认值也从「写死一个城市」改成 []（不限城市），代码里不再出现具体城市。
  if (!Array.isArray(criteria.cityWhitelist)) {
    criteria.cityWhitelist = Array.isArray(srcC.cityWhitelist) && srcC.cityWhitelist.length
      ? srcC.cityWhitelist
      : []
  }
  for (const key of ['plusSkills', 'rejectSkills', 'projectKeywords', 'mustSkills', 'dealbreakers', 'techDepthKeywords', 'starTokens']) {
    if (!Array.isArray(criteria[key])) criteria[key] = [...def.criteria[key]]
  }
  if (criteria.expectSalaryMinCapK == null) criteria.expectSalaryMinCapK = def.criteria.expectSalaryMinCapK
  // 节奏参数若为 0 / 缺失，用默认值（与 v2 运行时 `|| 默认值` 的语义完全一致）
  const pacingDefaults = {
    greetMinGapSec: 300, greetMaxGapSec: 720,
    browseBeforeGreetMin: 1, browseBeforeGreetMax: 3,
    roundRestMinSec: 600, roundRestMaxSec: 1800,
    browseDwellMinSec: 15, browseDwellMaxSec: 60,
  }
  for (const [k, v] of Object.entries(pacingDefaults)) {
    if (!criteria[k]) criteria[k] = v
  }
  criteria.humanize = humanizeOf(criteria)
  criteria.replyGuard = replyGuardOf(criteria)
  if (typeof criteria.replyRules !== 'string') criteria.replyRules = REPLY_RULES_DEFAULT
  criteria.workflow = workflowOf(criteria)
  criteria.salary = `${criteria.salaryMinK}-${criteria.salaryMaxK}K`

  // 话术：优先用 v3 的 flow 数组；否则用 v2 的 templates 对象平移
  let flow
  if (Array.isArray(src.flow) && src.flow.length > 0) {
    flow = src.flow.map((step, i) => ({
      key: String(step.key || `step${i + 1}`),
      name: String(step.name || step.key || `步骤${i + 1}`),
      enabled: step.enabled !== false,
      template: String(step.template || ''),
    }))
    // 补齐默认流程里缺失的步骤，避免老数据少了某些环节
    for (const base of defaultFlow()) {
      if (!flow.some((s) => s.key === base.key)) flow.push({ ...base })
    }
  } else {
    const legacy = src.templates && typeof src.templates === 'object' ? src.templates : {}
    flow = defaultFlow().map((step) => {
      const lk = LEGACY_TEMPLATE_KEY[step.key]
      const tpl = lk && legacy[lk] != null ? String(legacy[lk]) : step.template
      return { ...step, template: tpl }
    })
  }

  const highlights = Array.isArray(src.highlights) && src.highlights.length
    ? src.highlights.map(String)
    : [...def.highlights]

  return {
    id,
    name: String(src.name || def.name),
    active: src.active !== false,
    createdAt: src.createdAt || new Date().toISOString(),
    seqCounter: Number(src.seqCounter) || 0,
    criteria,
    highlights,
    flow,
  }
}

function migrateCandidate(raw, jobId, bossId) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const salary = parseSalaryK(c.expectSalary != null ? c.expectSalary : c.expectedSalary)
  const stage = STAGES.includes(c.stage) ? c.stage : 'new'
  const repliedStage = [
    'inbound', 'qualified', 'resume_requested', 'resume_received',
    'interview_pending', 'interview_available', 'interview_scheduled',
  ]
  const interviewStage = ['interview_available', 'interview_scheduled']
  const updatedAt = c.updatedAt || c.firstSeenAt || ''
  return {
    jobId,
    bossId,
    seq: Number(c.seq) || 0,
    name: String(c.name || ''),
    company: String(c.company || ''),
    edu: String(c.edu || ''),
    gradYear: c.gradYear == null ? null : Number(c.gradYear),
    xuexinSelf: c.xuexinSelf || '未说',
    xuexinVerify: c.xuexinVerify || 'pending',
    workYears: c.workYears == null ? null : Number(c.workYears),
    expectSalary: String(c.expectSalary != null ? c.expectSalary : c.expectedSalary || ''),
    expectSalaryMinK: c.expectSalaryMinK != null ? Number(c.expectSalaryMinK) : salary.minK,
    expectCity: String(c.expectCity || ''),
    expectPosition: String(c.expectPosition || ''),
    // v2.20.1：以下字段之前只存在于内存，落盘时被白名单丢掉，重启即丢
    phone: String(c.phone || ''),
    email: String(c.email || ''),
    school: String(c.school || ''),
    company2: String(c.company2 || ''),
    interviewTime: String(c.interviewTime || ''),
    interviewWindow: String(c.interviewWindow || ''),
    interviewLocation: String(c.interviewLocation || ''),
    interviewMode: String(c.interviewMode || ''),
    interviewContact: String(c.interviewContact || ''),
    interviewPhone: String(c.interviewPhone || ''),
    status7: String(c.status7 || ''),
    // v2.23.0：看过即入账的两个字段
    lastViewAt: String(c.lastViewAt || ''),
    viewCount: Number.isFinite(Number(c.viewCount)) ? Number(c.viewCount) : 0,
    sourceTab: String(c.sourceTab || ''),
    preview: String(c.preview || ''),
    noReply: Boolean(c.noReply),
    screenedAt: String(c.screenedAt || ''),
    screenProjects: String(c.screenProjects || ''),
    screenDecision: String(c.screenDecision || ''),
    lease: c.lease && typeof c.lease === 'object' ? {
      by: String(c.lease.by || ''),
      until: Number(c.lease.until) || 0,
      at: String(c.lease.at || ''),
    } : null,
    interview: c.interview && typeof c.interview === 'object' ? { ...c.interview } : {},
    skills: Array.isArray(c.skills) ? c.skills.map(String) : [],
    project: String(c.project || ''),
    note: String(c.note || ''),
    keyInfo: String(c.keyInfo || ''),
    stage,
    starred: Boolean(c.starred),
    rejectReason: String(
      c.rejectReason || (stage === 'rejected' ? inferRejectReason(c.note || '') : ''),
    ),
    matchGaps: Array.isArray(c.matchGaps) ? c.matchGaps.map(String) : [],
    matchHits: Array.isArray(c.matchHits) ? c.matchHits.map(String) : [],
    // ---- v2.1 派生评分字段（老数据为 null，由 migrate() 后面的补算环节填上）----
    techFitScore: numOrNull(c.techFitScore),
    techFitGrade: String(c.techFitGrade || ''),
    techFitHits: Array.isArray(c.techFitHits) ? c.techFitHits.map(String) : [],
    techFitGaps: Array.isArray(c.techFitGaps) ? c.techFitGaps.map(String) : [],
    valueScore: numOrNull(c.valueScore),
    valueGrade: String(c.valueGrade || ''),
    valueCostRatio: numOrNull(c.valueCostRatio),
    valueBudgetMidK: numOrNull(c.valueBudgetMidK),
    dialogLog: Array.isArray(c.dialogLog)
      ? c.dialogLog.map((e) => ({
        at: String((e && e.at) || ''),
        dir: e && e.dir === 'out' ? 'out' : 'in',
        text: String((e && e.text) || ''),
        summary: String((e && e.summary) || ''),
      }))
      : [],
    firstSeenAt: c.firstSeenAt || updatedAt,
    greetedAt: c.greetedAt || '',
    repliedAt: c.repliedAt || (repliedStage.includes(stage) ? updatedAt : ''),
    resumeAt: c.resumeAt || '',
    interviewAt: c.interviewAt || (interviewStage.includes(stage) ? updatedAt : ''),
    updatedAt,
  }
}

function migrate(parsed) {
  const base = defaultState()
  if (!parsed || typeof parsed !== 'object') return base

  // ---- 岗位 ----
  let jobs = {}
  if (parsed.jobs && typeof parsed.jobs === 'object' && Object.keys(parsed.jobs).length > 0) {
    for (const [id, raw] of Object.entries(parsed.jobs)) jobs[id] = migrateJob(id, raw)
  } else {
    // v1：criteria / templates 放在顶层
    const job = migrateJob('default-job', {
      id: 'default-job',
      name: '未命名岗位',
      criteria: parsed.criteria,
      templates: parsed.templates,
    })
    jobs[job.id] = job
  }

  const activeJobId = jobs[parsed.activeJobId] ? parsed.activeJobId : Object.keys(jobs)[0]

  // ---- 候选人 ----
  const candidates = {}
  for (const [key, raw] of Object.entries(parsed.candidates || {})) {
    const c = raw && typeof raw === 'object' ? raw : {}
    let jobId = c.jobId
    let bossId = c.bossId
    if (!jobId && key.includes('::')) jobId = key.split('::')[0]
    if (!bossId && key.includes('::')) bossId = key.split('::').slice(1).join('::')
    if (!bossId) bossId = key
    // 只有 v1 那种完全没有岗位归属的老数据才补当前岗位；
    // 岗位已被删除的「孤儿候选人」保留原 jobId（不并入当前岗位，避免串岗污染统计）
    if (!jobId) jobId = activeJobId
    candidates[candKey(jobId, bossId)] = migrateCandidate(c, jobId, bossId)
  }

  // ---- 序号回填 / seqCounter 校正（只补空的，不重排已有序号）----
  for (const [jobId, job] of Object.entries(jobs)) {
    const own = Object.values(candidates).filter((x) => x.jobId === jobId)
    const maxSeq = own.reduce((m, x) => Math.max(m, Number(x.seq) || 0), 0)
    job.seqCounter = Math.max(Number(job.seqCounter) || 0, maxSeq)
    const missing = own
      .filter((x) => !x.seq)
      .sort((a, b) => String(a.firstSeenAt || '').localeCompare(String(b.firstSeenAt || '')))
    for (const cand of missing) {
      job.seqCounter += 1
      cand.seq = job.seqCounter
    }
  }

  // ---- 计数 ----
  const counters = {}
  for (const [key, value] of Object.entries(parsed.counters || {})) {
    counters[key] = { greets: 0, browses: 0, ...(value || {}) }
  }

  // ---- 去重登记 ----
  const views = {}
  for (const [key, value] of Object.entries(parsed.views || {})) views[key] = value

  // ---- 给历史数据补算匹配分析（只写新字段 matchHits / matchGaps，不动业务字段）----
  for (const cand of Object.values(candidates)) {
    const hasAnalysis = (cand.matchHits && cand.matchHits.length) || (cand.matchGaps && cand.matchGaps.length)
    if (hasAnalysis) continue
    const job = jobs[cand.jobId]
    if (!job) continue
    const result = evaluate(cand, job.criteria)
    cand.matchHits = result.hits
    cand.matchGaps = result.gaps
  }

  // ---- v2.1：老数据补算派生评分（techFit* / value*）。只写派生字段，业务字段一律不动 ----
  for (const cand of Object.values(candidates)) {
    if (numOrNull(cand.techFitScore) != null) continue
    const job = jobs[cand.jobId]
    if (!job) continue
    const techFit = techFitOf(cand, job.criteria)
    const value = valueOf(techFit.score, cand, job.criteria)
    cand.techFitScore = techFit.score
    cand.techFitGrade = techFit.grade
    cand.techFitHits = techFit.hits
    cand.techFitGaps = techFit.gaps
    cand.valueScore = value.score
    cand.valueGrade = value.grade
    cand.valueCostRatio = value.costRatio
    cand.valueBudgetMidK = value.budgetMidK
  }

  // ---- v2.2：每岗位模式（老数据没有 jobModes → 全岗位沿用全局 mode）----
  const globalMode = ['recruit', 'reply', 'all'].includes(parsed.mode) ? parsed.mode : 'recruit'
  const parsedModes = parsed.jobModes && typeof parsed.jobModes === 'object' ? parsed.jobModes : {}
  const jobModes = {}
  for (const id of Object.keys(jobs)) {
    const m = parsedModes[id]
    jobModes[id] = ['recruit', 'reply', 'all'].includes(m) ? m : globalMode
  }
  const activeMode = jobModes[activeJobId] || globalMode

  return {
    ...base,
    version: STATE_VERSION,
    activeJobId,
    mode: activeMode,
    jobModes,
    jobs,
    candidates,
    counters,
    views,
    screens: Array.isArray(parsed.screens) ? parsed.screens : [],
    screenIndex: parsed.screenIndex && typeof parsed.screenIndex === 'object' ? parsed.screenIndex : {},
    chatScope: parsed.chatScope && typeof parsed.chatScope === 'object' ? parsed.chatScope : null,
    flowContext: parsed.flowContext && typeof parsed.flowContext === 'object' ? parsed.flowContext : null,
    inbox: parsed.inbox && typeof parsed.inbox === 'object' ? parsed.inbox : {},
    blacklist: Array.isArray(parsed.blacklist) ? parsed.blacklist : [],
  }
}

// ---------------------------------------------------------------------------
// 状态读写：load-mutate-save 串行保护
// ---------------------------------------------------------------------------

let stateCache = null
/** 给 systemPrompt 用的同步快照（每次 save 后刷新） */
let snapshot = defaultState()
let lockChain = Promise.resolve()

async function readDisk() {
  let text
  try {
    text = await readFile(STORE_FILE, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultState()
    throw error
  }
  return migrate(JSON.parse(text))
}

async function ensureState() {
  if (stateCache) return stateCache
  stateCache = await readDisk()
  snapshot = stateCache
  return stateCache
}

async function writeDisk(state) {
  await mkdir(STORE_DIR, { recursive: true })
  const tmp = STORE_FILE + '.tmp'
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, STORE_FILE)
  snapshot = state
}

/**
 * 串行执行一次「读 → 改 → 写」。
 * 并发调用会排队，避免两个写操作互相覆盖。
 */
function withState(fn, options) {
  const persist = !options || options.persist !== false
  const run = lockChain.then(async () => {
    const state = await ensureState()
    const result = await fn(state)
    if (persist) await writeDisk(state)
    return result
  })
  // 失败也要放行后面的排队任务
  lockChain = run.then(() => undefined, () => undefined)
  return run
}

/** 只读访问（GET / 工具读路径）：不写盘，但会补齐计数器结构 */
function readState(fn) {
  const run = lockChain.then(async () => {
    const state = await ensureState()
    return fn(state)
  })
  lockChain = run.then(() => undefined, () => undefined)
  return run
}

// ---------------------------------------------------------------------------
// 岗位 / 计数器
// ---------------------------------------------------------------------------

function resolveJob(state, jobId) {
  const id = jobId || state.activeJobId
  const job = state.jobs[id]
  if (!job) return { job: null, id }
  return { job, id }
}

/** 读计数（不创建）——供 GET 面板使用 */
function counterPeek(state, jobId, date) {
  return state.counters[`${jobId}::${date}`] || null
}

/** 取计数（缺则创建）——供写操作使用 */
function counterFor(state, jobId, date) {
  const key = `${jobId}::${date}`
  if (!state.counters[key]) {
    state.counters[key] = {
      greets: 0,
      browses: 0,
      roundGreets: 0,
      roundsCompleted: 0,
      lastGreetAt: null,
      lastBrowseAt: null,
      restUntil: null,
    }
  }
  const counter = state.counters[key]
  if (counter.greets == null) counter.greets = 0
  if (counter.browses == null) counter.browses = 0
  if (counter.roundGreets == null) counter.roundGreets = 0
  if (counter.roundsCompleted == null) counter.roundsCompleted = 0
  if (counter.restUntil === undefined) counter.restUntil = null
  return counter
}

function flowMap(job) {
  const map = {}
  for (const step of job.flow || []) map[step.key] = step
  return map
}

/** 话术模板变量填充 */
function fill(template, job) {
  const c = job.criteria || {}
  const salary = c.salary || `${c.salaryMinK}-${c.salaryMaxK}K`
  const highlights = (job.highlights || []).join('、')
  return String(template || '')
    .replace(/\{jobTitle\}/g, c.jobTitle || '')
    .replace(/\{city\}/g, c.city || '')
    .replace(/\{salary\}/g, salary)
    .replace(/\{eduMin\}/g, c.eduMin || '')
    .replace(/\{gradYearMin\}/g, String(c.gradYearMin == null ? '' : c.gradYearMin))
    .replace(/\{workYearMin\}/g, String(c.workYearMin == null ? '' : c.workYearMin))
    .replace(/\{highlights\}/g, highlights)
}

// ---------------------------------------------------------------------------
// v2.5 面试参数（岗位默认 → 候选人覆盖）
// 设计：job.interview 存一套默认值；candidate.interview 只存"要改的"，
// 空值一律继承岗位默认。这样批量改岗位参数时，没单独设置的人自动跟随。
// ---------------------------------------------------------------------------
const INTERVIEW_MODE_LABEL = {
  onsite: '现场面试',
  phone: '电话面试',
  video: '视频面试',
}

const INTERVIEW_FIELDS = ['time', 'window', 'location', 'address', 'mode', 'contact', 'phone', 'link', 'extra', 'note']

/** 岗位级面试默认值（缺什么补什么，保证字段齐全） */
function interviewDefaults(job) {
  const iv = (job && job.interview) || {}
  const dur = Number(iv.durationMin)
  return {
    location: String(iv.location || ''),
    address: String(iv.address || ''),
    mode: INTERVIEW_MODE_LABEL[iv.mode] ? iv.mode : 'onsite',
    contact: String(iv.contact || ''),
    phone: String(iv.phone || ''),
    link: String(iv.link || ''),
    extra: String(iv.extra || ''),
    durationMin: dur > 0 ? dur : 60,
  }
}

/** 合并：候选人非空字段覆盖岗位默认 */
function resolveInterview(job, cand) {
  const d = interviewDefaults(job)
  const iv = (cand && cand.interview) || {}
  const pick = (k) => {
    const v = iv[k]
    return v === undefined || v === null || v === '' ? d[k] : v
  }
  return {
    time: String(iv.time || ''),
    window: String(iv.window || ''),
    location: String(pick('location') || ''),
    address: String(pick('address') || ''),
    mode: String(pick('mode') || ''),
    contact: String(pick('contact') || ''),
    phone: String(pick('phone') || ''),
    link: String(pick('link') || ''),
    extra: String(pick('extra') || ''),
    note: String(iv.note || ''),
    durationMin: d.durationMin,
  }
}

/** 渲染「邀约面试」话术；空变量所在的行会被整行去掉，不留空壳 */
function renderInvite(job, cand) {
  const step = flowMap(job).interviewInvite
  if (!step || step.enabled === false || !step.template) return ''
  const iv = resolveInterview(job, cand)
  const c = (job && job.criteria) || {}
  const vars = {
    name: (cand && cand.name) || '',
    jobTitle: c.jobTitle || '',
    city: c.city || '',
    time: iv.time,
    window: iv.window,
    location: iv.location,
    address: iv.address,
    mode: INTERVIEW_MODE_LABEL[iv.mode] || iv.mode,
    contact: iv.contact,
    phone: iv.phone,
    link: iv.link,
    extra: iv.extra,
    durationMin: String(iv.durationMin),
  }
  let out = String(step.template)
  Object.keys(vars).forEach((k) => {
    out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k] == null ? '' : vars[k]))
  })
  // 清掉只剩空括号的片段，以及「标签：」后面什么都没跟的行
  out = out.replace(/（\s*）/g, '').replace(/\(\s*\)/g, '')
  const kept = out.split('\n').filter((line) => {
    if (!line.trim()) return true
    const m = line.match(/^[^：:]{1,12}[：:]\s*(.*)$/)
    if (m && !m[1].trim()) return false
    return true
  })
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 取某一步话术（已填充）；该步被禁用则返回 null */
function templateOf(job, key) {
  const step = flowMap(job)[key]
  if (!step || step.enabled === false || !step.template) return null
  return fill(step.template, job)
}

/** 信息不全时需要追一句：学历没登记，或学信网没答复。 */
function clarifyState(candidate) {
  const missingEdu = !candidate.edu
  const missingXuexin = !candidate.xuexinSelf || candidate.xuexinSelf === '未说'
  return { needed: Boolean(missingEdu || missingXuexin), missingEdu, missingXuexin }
}

// ---------------------------------------------------------------------------
// v2.1 派生评分：techFit（项目技术要求匹配度）/ value（性价比）
// 纪律：确定性纯函数——同一个人 + 同一份口径，永远算出同一个分；不含任何 LLM 判断。
// 解释项（hits / gaps）全部由命中/缺失的词直接生成。
// ---------------------------------------------------------------------------

/**
 * 项目经历技术要求匹配度。
 * haystack = skills[] + project(或 projectBrief) + note，统一小写后做子串匹配（中文天然按子串走）。
 * 四维：必备技能 40 / 加分技能 20 / 项目关键词 20 / 工程深度证据 20（每条 4 分，上限 20）
 */
function techFitOf(candidate, criteria) {
  const cand = candidate && typeof candidate === 'object' ? candidate : {}
  const c = criteria && typeof criteria === 'object' ? criteria : {}
  const skills = Array.isArray(cand.skills) ? cand.skills.map(String) : []
  const projectText = String(cand.project || cand.projectBrief || '')
  const noteText = String(cand.note || '')
  const haystack = [skills.join(' '), projectText, noteText].join(' ').toLowerCase()

  const pick = (list) => (Array.isArray(list) ? list.map((s) => String(s || '').trim()).filter(Boolean) : [])
  const has = (word) => {
    const w = String(word || '').trim().toLowerCase()
    return w !== '' && haystack.includes(w)
  }

  const mustAll = pick(c.mustSkills)
  const plusAll = pick(c.plusSkills)
  const projAll = pick(c.projectKeywords)
  const depthAll = Array.isArray(c.techDepthKeywords) ? pick(c.techDepthKeywords) : [...TECH_DEPTH_KEYWORDS_DEFAULT]

  const mustHit = mustAll.filter(has)
  const plusHit = plusAll.filter(has)
  const projHit = projAll.filter(has)
  const depthHit = depthAll.filter(has)

  // ---- 四维得分 ----
  const mustPts = mustAll.length ? (mustHit.length / mustAll.length) * TECH_FIT_WEIGHTS.must : 0
  const plusPts = plusAll.length ? (plusHit.length / plusAll.length) * TECH_FIT_WEIGHTS.plus : 0
  const projPts = projHit.length >= 4 ? 20 : projHit.length === 3 ? 16 : projHit.length === 2 ? 12 : projHit.length === 1 ? 6 : 0
  const depthPts = Math.min(TECH_FIT_WEIGHTS.depth, depthHit.length * 4)
  const score = Math.max(0, Math.min(100, Math.round(mustPts + plusPts + projPts + depthPts)))

  // ---- 解释项：命中（hits）/ 缺口（gaps），全部由词直接生成 ----
  const hits = []
  const gaps = []
  if (mustAll.length) {
    if (mustHit.length) {
      hits.push(`必备技能 ${mustHit.length}/${mustAll.length}：${mustHit.join('、')}（+${round1(mustPts)}）`)
    }
    const mustMiss = mustAll.filter((s) => !has(s))
    if (mustMiss.length) gaps.push(`缺少必备技能：${mustMiss.join('、')}`)
  } else {
    gaps.push('岗位未配置必备技能（该维度记 0 分）')
  }
  if (plusAll.length && plusHit.length) {
    hits.push(`加分技能 ${plusHit.length}/${plusAll.length}：${plusHit.join('、')}（+${round1(plusPts)}）`)
  }
  if (plusAll.length && plusHit.length === 0) {
    gaps.push(`未见加分技能：${plusAll.slice(0, 10).join('、')}`)
  }
  if (projHit.length) {
    hits.push(`项目关键词命中 ${projHit.length} 项：${projHit.slice(0, 8).join('、')}（+${projPts}）`)
  } else {
    gaps.push('项目关键词未命中')
  }
  if (depthHit.length) {
    hits.push(`工程深度证据 ${depthHit.length} 条：${depthHit.slice(0, 10).join('、')}（+${depthPts}）`)
  } else {
    gaps.push('未见工程深度关键词（性能优化 / 对象池 / 热更 / DrawCall 等）')
  }

  const meta = gradeMetaOf(TECH_FIT_GRADES, score)
  return {
    score,
    grade: meta.grade,
    gradeLabel: meta.label,
    hits,
    gaps,
    // 分维明细（只用于人工核对，不参与等级判定）
    breakdown: {
      mustSkills: round1(mustPts),
      plusSkills: round1(plusPts),
      projectKeywords: projPts,
      techDepth: depthPts,
    },
    matched: {
      mustSkills: mustHit,
      plusSkills: plusHit,
      projectKeywords: projHit,
      techDepthKeywords: depthHit,
    },
  }
}

/**
 * 性价比：techFit 分 ÷ 成本比 × 0.8，夹在 0-100。
 * costRatio = 期望下限 / 预算中值（criteria.salaryMinK+salaryMaxK 的中值；两者未配置时兜底 15）
 * 期望下限缺失 / 为 0 / 无法解析（面议）→ score=null、grade='NA'（绝不写 0，避免被当成"极低性价比"）
 */
function valueOf(techFitScore, candidate, criteria) {
  const cand = candidate && typeof candidate === 'object' ? candidate : {}
  const c = criteria && typeof criteria === 'object' ? criteria : {}
  const sm = numOrNull(c.salaryMinK)
  const sx = numOrNull(c.salaryMaxK)
  let budgetMidK = null
  if (sm != null && sx != null) budgetMidK = (sm + sx) / 2
  else if (sm != null) budgetMidK = sm
  else if (sx != null) budgetMidK = sx
  else budgetMidK = 15

  const rawMin = numOrNull(cand.expectSalaryMinK)
  const expectMinK = rawMin != null && rawMin > 0
    ? rawMin
    : numOrNull(parseSalaryK(cand.expectSalary).minK)

  const na = {
    score: null,
    grade: 'NA',
    gradeLabel: '不可评估',
    costRatio: null,
    budgetMidK: round2(budgetMidK),
    expectSalaryMinK: expectMinK != null && expectMinK > 0 ? expectMinK : null,
  }
  if (expectMinK == null || !(expectMinK > 0)) return na
  if (budgetMidK == null || !(budgetMidK > 0)) return na

  const costRatio = expectMinK / budgetMidK
  if (!(costRatio > 0)) return na

  const base = numOrNull(techFitScore)
  if (base == null) return na

  const score = Math.max(0, Math.min(100, Math.round((base / costRatio) * 0.8)))
  const meta = gradeMetaOf(VALUE_GRADES, score)
  return {
    score,
    grade: meta.grade,
    gradeLabel: meta.label,
    costRatio: round2(costRatio),
    budgetMidK: round2(budgetMidK),
    expectSalaryMinK: expectMinK,
  }
}

// ---------------------------------------------------------------------------
// 判定（evaluate）
// ---------------------------------------------------------------------------

/**
 * v2.3：方向加分词改为岗位口径字段 criteria.starTokens（默认 []）。
 * 代码里不再写死任何业务方向词；为空时该维度不产生命中，也不报错。
 * 返回小写词表（匹配时对 haystack 做小写包含判断）。
 */
function starTokensOf(criteria) {
  const list = criteria && Array.isArray(criteria.starTokens) ? criteria.starTokens : []
  return list
    .map((t) => String(t == null ? '' : t).trim().toLowerCase())
    .filter(Boolean)
}

/** 性能优化相关关键词 */
const PERF_TOKENS = ['性能优化', 'profiler', 'drawcall', 'gc优化', '内存优化', '帧率', '优化']

/**
 * 按岗位口径逐条判定。
 * 返回 { ok, gaps, hits, projectMatched, salaryNote, starWorthy, suggestStage, rejectReason, flags }
 *   ok=false  → 硬淘汰（suggestStage=rejected）
 *   待定      → 唯一条件：期望薪资下限 > expectSalaryMinCapK（suggestStage=pending，不算淘汰）
 *   其余      → 初筛通过（suggestStage=qualified）
 */
function evaluate(candidate, criteria) {
  const c = criteria || {}
  const gaps = []
  const hits = []
  const flags = {
    eduBad: false,
    gradBad: false,
    workBad: false,
    cityBad: false,
    directionBad: false,
    projectBad: false,
    freshgrad: false,
    xuexinMissing: false,
  }

  const curYear = new Date().getFullYear()
  const gradYear = Number(candidate.gradYear) || 0
  const workYears = Number(candidate.workYears) || 0

  // ---- 硬条件 1：学历 ----
  const eduOk = eduRank(candidate.edu) >= eduRank(c.eduMin)
  if (!eduOk) {
    flags.eduBad = true
    gaps.push(`学历不达标（${candidate.edu || '未填'}，要求 ${c.eduMin} 及以上）`)
  }

  // ---- 硬条件 2：毕业年限（按最高学历毕业年份算）----
  let gradEnough = true
  if (!gradYear) {
    flags.gradBad = true
    gradEnough = false
    gaps.push('未登记毕业年份')
  } else if (curYear - gradYear < Number(c.gradYearMin || 0)) {
    flags.gradBad = true
    gradEnough = false
    gaps.push(`毕业年限不足（${gradYear} 届，要求毕业满 ${c.gradYearMin} 年）`)
  }

  // ---- 硬条件 3：工作年限 ----
  const workEnough = workYears >= Number(c.workYearMin || 0)
  if (!workEnough) {
    flags.workBad = true
    gaps.push(`工作年限不足（${workYears} 年，要求 ${c.workYearMin} 年及以上）`)
  }

  // ---- 硬条件 4：期望城市 ----
  const expectCity = String(candidate.expectCity || '').trim()
  // v2.2：显式空数组 = 该岗位不限城市；字段缺失（不是数组）同样按「不限城市」处理
  // v2.3：不再回落到任何具体城市
  const whitelistRaw = Array.isArray(c.cityWhitelist) ? c.cityWhitelist.map((w) => String(w)).filter(Boolean) : null
  const whitelist = whitelistRaw === null ? [] : whitelistRaw
  const cityExplicit = expectCity !== '' && !/^(不限|面议|都可以|均可|异地均可)$/.test(expectCity)
  const cityOk = !cityExplicit || whitelist.length === 0 || whitelist.some((w) => expectCity.includes(String(w)))
  if (!cityOk) {
    flags.cityBad = true
    gaps.push(`期望城市不符（${expectCity}，招聘地 ${whitelist.join(' / ')}）`)
  }

  // ---- 技能方向 ----
  const hay = `${(candidate.skills || []).join(' ')} ${candidate.project || ''} ${candidate.expectPosition || ''}`.toLowerCase()
  const hitMust = (c.mustSkills || []).filter((s) => hay.includes(String(s).toLowerCase()))
  const hitPlus = (c.plusSkills || []).filter((s) => hay.includes(String(s).toLowerCase()))
  const rejectHits = (c.rejectSkills || []).filter((s) => hay.includes(String(s).toLowerCase()))
  const hasMustEvidence = hitMust.length > 0

  // ---- 硬条件 5：期望职位是 rejectSkills 里的方向，且简历无 mustSkills 证据 ----
  if (rejectHits.length > 0 && !hasMustEvidence) {
    flags.directionBad = true
    gaps.push(`技术方向不符（${rejectHits.join(' / ')}），且未见 ${(c.mustSkills || []).join(' / ')} 证据`)
  }

  // ---- 硬条件 6：应届 / 未毕业 ----
  const freshgrad =
    workYears <= 0 ||
    (!gradYear ? false : curYear - gradYear < 1 && workYears < 1)
  if (freshgrad) {
    flags.freshgrad = true
    gaps.push('应届/未毕业（工作经历不足 1 年）')
  }

  // ---- 硬条件 7：项目关键词 ----
  const projText = `${candidate.project || ''} ${candidate.company || ''}`.toLowerCase()
  const hitProject = (c.projectKeywords || []).filter((s) => projText.includes(String(s).toLowerCase()))
  const projectMatched = hitProject.length > 0
  if (c.requireProjectKeyword && !projectMatched) {
    flags.projectBad = true
    gaps.push(`过往项目经历未见匹配项（岗位要求命中其一：${(c.projectKeywords || []).slice(0, 6).join('、') || '口径未配置 projectKeywords'}）`)
  }

  // ---- 加分（只记 hit，不参与 ok 判定）----
  if (hasMustEvidence) hits.push(`必备技能命中：${hitMust.join('、')}`)
  if (hitPlus.length) hits.push(`加分技能命中：${hitPlus.join('、')}`)
  // v2.3：方向加分词来自口径 criteria.starTokens；未配置（[]）→ 不产生命中
  const starHits = starTokensOf(c).filter((t) => hay.includes(t))
  if (starHits.length) hits.push(`方向加分词命中：${starHits.join('、')}`)
  const perfHits = PERF_TOKENS.filter((t) => hay.includes(t))
  if (perfHits.length) hits.push('性能优化相关经验')
  if (projectMatched) hits.push(`项目关键词命中 ${hitProject.length} 项：${hitProject.slice(0, 6).join('、')}`)

  // ---- 学信网自述（提示，不作硬淘汰）----
  if (c.xuexinRequired && candidate.xuexinSelf !== '可查') {
    flags.xuexinMissing = true
    gaps.push(`学信网自述未确认（${candidate.xuexinSelf || '未答复'}）`)
  }

  // ---- 期望薪资 ----
  const expectMinK = candidate.expectSalaryMinK == null
    ? parseSalaryK(candidate.expectSalary).minK
    : Number(candidate.expectSalaryMinK)
  const capK = Number(c.expectSalaryMinCapK == null ? 15 : c.expectSalaryMinCapK)
  const overCap = expectMinK != null && !Number.isNaN(expectMinK) && expectMinK > capK
  let salaryNote = null
  if (expectMinK != null && !Number.isNaN(expectMinK)) {
    const band = `${c.salaryMinK}-${c.salaryMaxK}K`
    if (overCap) {
      salaryNote = `期望薪资下限 ${expectMinK}K 高于待定线 ${capK}K（岗位区间 ${band}）→ 待定，待人工决策`
    } else if (Number(c.salaryMaxK) && expectMinK > Number(c.salaryMaxK)) {
      salaryNote = `期望薪资下限 ${expectMinK}K 高于岗位上限 ${c.salaryMaxK}K（岗位区间 ${band}）`
    } else {
      salaryNote = `期望薪资下限 ${expectMinK}K 在岗位区间内（${band}）`
    }
  }

  // ---- 待定：仅此一种情况 ----
  const ok = gaps.length === 0
  const suggestStage = !ok ? 'rejected' : overCap ? 'pending' : 'qualified'

  // ---- 淘汰原因分类（优先级：应届 > 学历 > 城市 > 年限 > 方向 > 其他）----
  let rejectReason = ''
  if (!ok) {
    if (flags.freshgrad) rejectReason = 'freshgrad'
    else if (flags.eduBad) rejectReason = 'edu'
    else if (flags.cityBad) rejectReason = 'city'
    else if (flags.gradBad || flags.workBad) rejectReason = 'year'
    else if (flags.directionBad) rejectReason = 'direction'
    else rejectReason = 'other'
  }

  // ---- ⭐ 优先回捞：命中口径里的「方向加分词」但被城市或年限淘汰（starTokens 为空则永不触发）----
  const droppedByCityOrYear =
    flags.cityBad || flags.gradBad || flags.workBad || flags.freshgrad
  const starWorthy = Boolean(starHits.length > 0 && droppedByCityOrYear && gaps.length > 0)

  // ---- v2.1 派生评分（确定性纯函数：同输入必得同分）----
  const techFit = techFitOf(candidate, c)
  const value = valueOf(techFit.score, candidate, c)

  return {
    ok,
    gaps,
    hits,
    projectMatched,
    salaryNote,
    starWorthy,
    suggestStage,
    rejectReason,
    flags,
    techFit,
    value,
    expectSalaryMinK: expectMinK == null || Number.isNaN(expectMinK) ? null : expectMinK,
    expectSalaryMinCapK: capK,
    note: '判定依据为候选人自述，真伪待人工核验',
  }
}

// ---------------------------------------------------------------------------
// 展示 / 统计
// ---------------------------------------------------------------------------

function jsonText(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** 工具返回值必须是无损 JSON：undefined / NaN / Infinity 都会被清理掉 */
function sanitize(value) {
  if (value === undefined) return { ok: true }
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => {
        if (typeof v === 'number' && !Number.isFinite(v)) return null
        return v === undefined ? null : v
      }),
    )
  } catch {
    return { ok: false, error: '结果序列化失败' }
  }
}

function decorate(candidate) {
  const stage = candidate.stage || 'new'
  const dialogLog = Array.isArray(candidate.dialogLog) ? candidate.dialogLog : []
  const last = dialogLog.length ? dialogLog[dialogLog.length - 1] : null
  // 淘汰原因只在"已淘汰"时才展示，避免给已推进的人贴上淘汰标签
  const rejectReason = stage === 'rejected' ? candidate.rejectReason || '' : ''
  // v2.1 派生评分：等级由分数现算，避免存档里的等级和分数打架
  const techFitScore = numOrNull(candidate.techFitScore)
  const techFitMeta = gradeMetaOf(TECH_FIT_GRADES, techFitScore)
  const valueScore = numOrNull(candidate.valueScore)
  const valueMeta = gradeMetaOf(VALUE_GRADES, valueScore)
  return {
    jobId: candidate.jobId || '',
    bossId: candidate.bossId || '',
    interviewAt: candidate.interviewAt || '',
    // v2.6.1 面试参数原样返回（空值由前端与 job.interview 默认合并）
    interview: (() => {
      const iv = (candidate.interview && typeof candidate.interview === 'object') ? candidate.interview : {}
      return {
        time: String(iv.time || ''),
        window: String(iv.window || ''),
        location: String(iv.location || ''),
        address: String(iv.address || ''),
        mode: String(iv.mode || ''),
        contact: String(iv.contact || ''),
        phone: String(iv.phone || ''),
        link: String(iv.link || ''),
        extra: String(iv.extra || ''),
        note: String(iv.note || ''),
      }
    })(),
    key: candKey(candidate.jobId || '', candidate.bossId || ''),
    seq: Number(candidate.seq) || 0,
    name: candidate.name || '',
    company: candidate.company || '',
    edu: candidate.edu || '',
    gradYear: candidate.gradYear == null ? null : Number(candidate.gradYear),
    xuexinSelf: candidate.xuexinSelf || '未说',
    xuexinVerify: candidate.xuexinVerify || 'pending',
    workYears: candidate.workYears == null ? null : Number(candidate.workYears),
    expectSalary: candidate.expectSalary || '',
    expectSalaryMinK: candidate.expectSalaryMinK == null ? null : Number(candidate.expectSalaryMinK),
    expectCity: candidate.expectCity || '',
    expectPosition: candidate.expectPosition || '',
    school: candidate.school || '',
    phone: candidate.phone || '',
    company2: candidate.company2 || '',
    interviewTime: candidate.interviewTime || '',
    interviewLocation: candidate.interviewLocation || '',
    interviewMode: candidate.interviewMode || '',
    interviewContact: candidate.interviewContact || '',
    interviewPhone: candidate.interviewPhone || '',
    ...(() => {
      const log = Array.isArray(candidate.dialogLog) ? candidate.dialogLog : []
      const last = log.length ? log[log.length - 1] : null
      const lastAt = last && last.at ? String(last.at).replace("T", " ").slice(0, 16) : ""
      return {
        msgCount: log.length,
        lastSpeaker: last ? (last.dir === "out" ? "我" : "对方") : "",
        lastTalkAt: lastAt,
        lastTalkText: last ? String(last.text || last.summary || "").slice(0, 60) : "",
      }
    })(),
    email: candidate.email || '',
    skills: Array.isArray(candidate.skills) ? candidate.skills : [],
    projectBrief: String(candidate.project || '').slice(0, 160),
    stage,
    stageLabel: STAGE_LABEL[stage] || stage,
    status7: status7Of(candidate).status7,
    status7Label: status7Of(candidate).status7Label,
    nextStep: NEXT_STEP[stage] || '',
    starred: Boolean(candidate.starred),
    rejectReason,
    rejectReasonLabel: REJECT_REASON_LABEL[rejectReason] || '',
    matchHits: Array.isArray(candidate.matchHits) ? candidate.matchHits : [],
    matchGaps: Array.isArray(candidate.matchGaps) ? candidate.matchGaps : [],
    matchScore: (candidate.matchHits || []).length,
    // ---- v2.1 派生评分字段 ----
    techFitScore: techFitScore == null ? null : Math.round(techFitScore),
    techFitGrade: techFitMeta.grade,
    techFitGradeLabel: techFitMeta.label,
    techFitHits: Array.isArray(candidate.techFitHits) ? candidate.techFitHits : [],
    techFitGaps: Array.isArray(candidate.techFitGaps) ? candidate.techFitGaps : [],
    valueScore: valueScore == null ? null : Math.round(valueScore),
    valueGrade: valueMeta.grade,
    valueGradeLabel: valueMeta.label,
    valueCostRatio: numOrNull(candidate.valueCostRatio),
    valueBudgetMidK: numOrNull(candidate.valueBudgetMidK),
    note: candidate.note || '',
    keyInfo: candidate.keyInfo || '',
    needsClarify: clarifyState(candidate).needed,
    dialogCount: dialogLog.length,
    dialogLog: dialogLog.map((e) => ({
      at: e.at || '',
      atLocal: fmtLocal(e.at),
      dir: e.dir === 'out' ? 'out' : 'in',
      text: e.text || '',
      summary: e.summary || '',
    })),
    lastDialog: last ? last.summary || last.text || '' : '',
    sourceTab: candidate.sourceTab || '',
    preview: candidate.preview || '',
    noReply: Boolean(candidate.noReply),
    screenedAt: candidate.screenedAt || '',
    lease: candidate.lease || null,
    lastViewAt: candidate.lastViewAt || '',
    viewCount: Number(candidate.viewCount) || 0,
    firstSeenAt: candidate.firstSeenAt || '',
    firstSeenAtLocal: fmtLocal(candidate.firstSeenAt),
    greetedAt: candidate.greetedAt || '',
    repliedAt: candidate.repliedAt || '',
    resumeAt: candidate.resumeAt || '',
    interviewAt: candidate.interviewAt || '',
    updatedAt: candidate.updatedAt || '',
    updatedAtLocal: fmtLocal(candidate.updatedAt),
  }
}

/** 漏斗 + 淘汰原因分布。jobId='all' 表示跨岗位汇总（仅 filterJob=all 时使用） */
function statsOf(state, jobId) {
  const all = jobId === 'all'
    ? Object.values(state.candidates)
    : Object.values(state.candidates).filter((x) => x.jobId === jobId)
  const total = all.length
  const greeted = all.filter((x) => x.greetedAt).length
  const replied = all.filter((x) => x.repliedAt).length
  const resume = all.filter((x) => x.resumeAt || ['resume_received', 'interview_pending', 'interview_available', 'interview_scheduled'].includes(x.stage)).length
  const interview = all.filter((x) => x.interviewAt || ['interview_available', 'interview_scheduled'].includes(x.stage)).length
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)

  // 淘汰原因分布：只统计 stage=rejected 的人，口径干净（不把"差点淘汰"的算进去）
  const rejects = { city: 0, edu: 0, year: 0, direction: 0, salary: 0, freshgrad: 0, other: 0 }
  for (const x of all) {
    if (x.stage !== 'rejected') continue
    const key = REJECT_REASON_LABEL[x.rejectReason] ? x.rejectReason : 'other'
    rejects[key] += 1
  }

  const byStage = {}
  for (const s of STAGES) byStage[s] = 0
  for (const x of all) byStage[x.stage] = (byStage[x.stage] || 0) + 1

  // ---- v2.1 派生评分汇总（平均匹配度 / 平均性价比 / 性价比等级分布）----
  const tfScores = all.map((x) => numOrNull(x.techFitScore)).filter((n) => n != null)
  const vScores = all.map((x) => numOrNull(x.valueScore)).filter((n) => n != null)
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null)
  const valueGrades = { S: 0, A: 0, B: 0, C: 0, D: 0, NA: 0 }
  for (const x of all) {
    const g = numOrNull(x.valueScore) == null ? 'NA' : gradeMetaOf(VALUE_GRADES, x.valueScore).grade
    valueGrades[g] = (valueGrades[g] || 0) + 1
  }
  const techFitGrades = { S: 0, A: 0, B: 0, C: 0, D: 0, NA: 0 }
  for (const x of all) {
    const g = numOrNull(x.techFitScore) == null ? 'NA' : gradeMetaOf(TECH_FIT_GRADES, x.techFitScore).grade
    techFitGrades[g] = (techFitGrades[g] || 0) + 1
  }

  return {
    total,
    funnel: { inbound: total, greeted, replied, resume, interview },
    rates: {
      greetRate: rate(greeted, total),
      replyRate: rate(replied, greeted),
      resumeRate: rate(resume, replied),
      interviewRate: rate(interview, resume),
    },
    rejects,
    rejectTotal: Object.values(rejects).reduce((a, b) => a + b, 0),
    byStage,
    starred: all.filter((x) => x.starred).length,
    scores: {
      avgTechFit: avg(tfScores),
      avgValue: avg(vScores),
      techFitScored: tfScores.length,
      valueScored: vScores.length,
      valueGrades,
      techFitGrades,
    },
    definitions: {
      inbound: '台账总人数（来信 + 主动触达）',
      greeted: '有 greetedAt 的人数（已打招呼）',
      replied: '有 repliedAt / 已回话的人数',
      resume: '已收简历（resumeAt 或 stage 到简历及之后）',
      interview: '已给面试时间或已约面',
    },
  }
}

function jobList(state) {
  return Object.values(state.jobs).map((job) => ({
    id: job.id,
    name: job.name,
    jobTitle: job.criteria.jobTitle,
    city: job.criteria.city,
    salary: job.criteria.salary,
    active: job.id === state.activeJobId,
    // v2.2：该岗位上次用的模式
    mode: state.jobModes && state.jobModes[job.id] ? state.jobModes[job.id] : state.mode,
    candidateCount: Object.values(state.candidates).filter((c) => c.jobId === job.id).length,
  }))
}

/** 岗位 id → 模式 的映射（给工具返回 / 面板用） */
function jobModesOf(state) {
  const out = {}
  for (const id of Object.keys(state.jobs)) {
    out[id] = state.jobModes && state.jobModes[id] ? state.jobModes[id] : state.mode
  }
  return out
}

function jobPublic(job, activeJobId) {
  return {
    id: job.id,
    name: job.name,
    active: job.id === activeJobId,
    createdAt: job.createdAt || '',
    criteria: job.criteria,
    highlights: job.highlights || [],
    flow: job.flow || [],
    interview: interviewDefaults(job),
  }
}

// ---------------------------------------------------------------------------
// v2.2 新增：岗位新建 / 删除（面板「＋ 新建岗位」与工具 createJob / deleteJob 共用同一套逻辑）
// 纪律：新建必须补齐完整 criteria / highlights / flow，字段一个不能少，
// 否则 evaluate / techFit 会因为缺字段算出 NaN 或崩掉。
// ---------------------------------------------------------------------------

/** 中文 → 拼音小表：只覆盖岗位名称里常见的字，查不到的字直接丢掉，保证 id 稳定可读 */
const SLUG_PINYIN = {
  深: 'shen', 圳: 'zhen', 广: 'guang', 州: 'zhou', 北: 'bei', 京: 'jing', 上: 'shang', 海: 'hai',
  杭: 'hang', 成: 'cheng', 都: 'du', 南: 'nan', 山: 'shan', 区: 'qu', 客: 'ke', 户: 'hu', 端: 'duan',
  开: 'kai', 发: 'fa', 工: 'gong', 程: 'cheng', 师: 'shi', 游: 'you', 戏: 'xi', 服: 'fu', 务: 'wu',
  测: 'ce', 试: 'shi', 主: 'zhu', 前: 'qian', 后: 'hou', 数: 'shu', 据: 'ju', 算: 'suan', 法: 'fa',
  平: 'ping', 台: 'tai', 运: 'yun', 维: 'wei', 产: 'chan', 品: 'pin', 经: 'jing', 理: 'li', 总: 'zong',
  监: 'jian', 组: 'zu', 长: 'zhang', 高: 'gao', 级: 'ji', 中: 'zhong', 初: 'chu', 实: 'shi', 习: 'xi',
  兼: 'jian', 职: 'zhi', 全: 'quan', 栈: 'zhan', 技: 'ji', 术: 'shu', 研: 'yan', 究: 'jiu', 员: 'yuan',
  项: 'xiang', 目: 'mu', 视: 'shi', 觉: 'jue', 图: 'tu', 形: 'xing', 学: 'xue', 智: 'zhi', 能: 'neng',
  体: 'ti', 感: 'gan', 交: 'jiao', 互: 'hu', 引: 'yin', 擎: 'qing', 招: 'zhao', 聘: 'pin', 岗: 'gang',
  位: 'wei', 新: 'xin', 媒: 'mei', 营: 'ying', 销: 'xiao', 售: 'shou', 施: 'shi', 场: 'chang',
}

/** 岗位名 → slug id，如「Unity客户端开发（广州）」→ unity-ke-hu-duan-kai-fa-guang-zhou */
function slugifyJobId(name) {
  const text = String(name || '')
  let out = ''
  for (const ch of text) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      out += ch.toLowerCase()
      continue
    }
    const p = SLUG_PINYIN[ch]
    if (p) out += `-${p}`
    else out += '-'
  }
  let slug = out.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) slug = 'job'
  return slug.slice(0, 48).replace(/-+$/, '') || 'job'
}

/** 同 slug 已存在时追加 -2 / -3 …，保证 id 唯一 */
function uniqueJobId(state, base) {
  let id = base
  let n = 2
  while (state.jobs[id]) {
    id = `${base}-${n}`
    n += 1
    if (n > 999) break
  }
  return id
}

/** 数组字段统一深拷贝，避免两个岗位共享同一个数组引用 */
const JOB_ARRAY_KEYS = ['cityWhitelist', 'mustSkills', 'plusSkills', 'rejectSkills', 'projectKeywords', 'techDepthKeywords', 'dealbreakers', 'starTokens']
/** 数值字段：空值一律回落到默认值，绝不让 NaN 进 store */
const JOB_NUMBER_KEYS = [
  'salaryMinK', 'salaryMaxK', 'expectSalaryMinCapK', 'gradYearMin', 'workYearMin',
  'greetQuotaPerDay', 'roundGreetSize', 'staleDays',
  'roundRestMinSec', 'roundRestMaxSec', 'greetMinGapSec', 'greetMaxGapSec',
  'browseBeforeGreetMin', 'browseBeforeGreetMax', 'browseDwellMinSec', 'browseDwellMaxSec',
]

/**
 * 生成一份「一个字段都不少」的岗位口径。
 * base 为 null 表示空白默认模板；否则从 base 复制（数组深拷贝）。
 */
function buildJobCriteria(base, name) {
  const def = defaultCriteria()
  const src = base && typeof base === 'object' ? base : null
  const criteria = { ...def, ...(src || {}) }
  for (const key of JOB_ARRAY_KEYS) {
    const v = src ? src[key] : null
    criteria[key] = Array.isArray(v) ? v.map(String) : [...def[key]]
  }
  for (const key of JOB_NUMBER_KEYS) {
    const v = criteria[key]
    const n = v == null || v === '' ? NaN : Number(v)
    criteria[key] = Number.isFinite(n) ? n : def[key]
  }
  criteria.xuexinRequired = criteria.xuexinRequired !== false
  criteria.requireProjectKeyword = criteria.requireProjectKeyword !== false
  // 新岗位的岗位名称一律用用户填的名字（话术里的 {jobTitle} 才会跟着变）
  criteria.jobTitle = String(name || criteria.jobTitle || '').trim()
  // 空白模板：城市留空、不按城市卡人（cityWhitelist=[] 在 evaluate 里表示不限城市）
  if (!src) {
    criteria.city = ''
    criteria.cityWhitelist = []
  }
  criteria.salary = `${criteria.salaryMinK}-${criteria.salaryMaxK}K`
  return criteria
}

/** 带占位符的默认话术（新岗位直接可用，模板变量由 fill() 填充） */
function defaultFlowCopy(baseFlow) {
  const src = Array.isArray(baseFlow) && baseFlow.length ? baseFlow : defaultFlow()
  const flow = src.map((step, i) => ({
    key: String(step.key || `step${i + 1}`),
    name: String(step.name || step.key || `步骤${i + 1}`),
    enabled: step.enabled !== false,
    template: String(step.template || ''),
  }))
  for (const step of defaultFlow()) {
    if (!flow.some((s) => s.key === step.key)) flow.push({ ...step })
  }
  return flow
}

/**
 * 新建岗位（写 state，不落盘）。调用方负责 withState。
 * mode: 'copy' = 从当前岗位复制口径/要点/话术；'blank' = 空白默认模板
 */
function createJobInState(state, opts) {
  const rawName = String((opts && opts.name) || '').trim()
  if (!rawName) return { ok: false, error: '缺少岗位名称' }
  const dup = Object.values(state.jobs).find((j) => String(j.name || '').trim() === rawName)
  if (dup) return { ok: false, error: `岗位名称已存在：${rawName}（id: ${dup.id}）` }

  const copy = opts.mode !== 'blank'
  const source = copy
    ? state.jobs[opts.copyFromJobId && state.jobs[opts.copyFromJobId] ? opts.copyFromJobId : state.activeJobId] || null
    : null

  const id = uniqueJobId(state, slugifyJobId(rawName))
  const criteria = buildJobCriteria(source ? source.criteria : null, rawName)
  const highlights = copy && source && Array.isArray(source.highlights) && source.highlights.length
    ? source.highlights.map(String)
    : [`${rawName}`, `薪资 ${criteria.salaryMinK}-${criteria.salaryMaxK}K`]
  const flow = defaultFlowCopy(copy && source ? source.flow : null)

  const job = {
    id,
    name: rawName,
    active: true,
    createdAt: nowISO(),
    seqCounter: 0,
    criteria,
    highlights,
    flow,
  }
  state.jobs[id] = job
  // 新岗位继承当前岗位的模式，并自动切过去
  state.jobModes[id] = ['recruit', 'reply', 'all'].includes(state.mode) ? state.mode : 'recruit'
  state.activeJobId = id
  state.mode = state.jobModes[id]

  return {
    ok: true,
    created: true,
    jobId: id,
    job: jobPublic(job, state.activeJobId),
    template: copy ? 'copy' : 'blank',
    copiedFrom: source ? source.id : null,
    activeJobId: state.activeJobId,
    mode: state.mode,
    jobModes: jobModesOf(state),
    jobs: jobList(state),
  }
}

/**
 * 删除岗位定义（不动候选人数据）。调用方负责 withState。
 * 硬规则：禁止删除最后一个岗位，否则 activeJobId 悬空、面板直接空白。
 */
function deleteJobInState(state, jobId) {
  if (!jobId) return { ok: false, error: '缺少 jobId' }
  if (!state.jobs[jobId]) return { ok: false, error: `岗位不存在：${jobId}` }
  if (Object.keys(state.jobs).length <= 1) {
    return {
      ok: false,
      error: '不能删除最后一个岗位（删掉后当前岗位会悬空，面板与工具都没岗位可用）。请先新建一个岗位，再删这一个。',
      onlyJob: true,
      jobId,
    }
  }
  const orphan = Object.values(state.candidates).filter((c) => c.jobId === jobId).length
  const name = state.jobs[jobId].name
  delete state.jobs[jobId]
  if (state.jobModes) delete state.jobModes[jobId]
  if (state.activeJobId === jobId) {
    state.activeJobId = Object.keys(state.jobs)[0]
    state.mode = state.jobModes[state.activeJobId] || state.mode
  }
  return {
    ok: true,
    deleted: jobId,
    deletedName: name,
    activeJobId: state.activeJobId,
    mode: state.mode,
    jobModes: jobModesOf(state),
    orphanCandidates: orphan,
    warning: orphan > 0
      ? `该岗位下 ${orphan} 条候选人记录保留在台账里，但不再归属任何岗位（不再显示、不再计入统计）`
      : '该岗位下没有候选人记录',
    jobs: jobList(state),
  }
}

// ---------------------------------------------------------------------------
// 系统提示词：SOP
// ---------------------------------------------------------------------------

// ===========================================================================
// v2.6 SOP 数据化：从代码里搬进 state，可查看 / 可修改 / 可沉淀
// 设计原则：
//   1. section 是"可编辑的最小单元"，body 支持 {变量} 占位，渲染时按岗位数据替换
//   2. lessons 是沉淀下来的教训，按 hits 排序注入，P0 级必须遵守
//   3. pending 是"自动捕获但尚未确认"的观察 —— 不直接改规则，避免自我污染
// ===========================================================================

const SOP_MAX_CHARS = 9000

function defaultSop() {
  return {
    version: 1,
    sections: [
      {
        id: 'modes',
        title: '三种模式（分开跑，不要混着做）',
        builtin: true,
        body: [
          '- **招聘模式 recruit**：只进「推荐牛人」→ 看卡片 → 评估 → 逐个打招呼。**不进「沟通」**。',
          '- **回话模式 reply**：只进「沟通」→ 逐条读回复 → 评估 → 按话术推进。**不进「推荐牛人」**。',
          '- **混合 all**：两边都做，但一轮只做一种，做完再切。',
          '- 切换用 recruit_pipeline 的 `mode` 动作。混着做既慢又更容易触发风控。',
        ].join('\n'),
      },
      {
        id: 'discipline',
        title: '硬性纪律（重要）',
        builtin: true,
        body: [
          '- 本插件**不发送任何消息**，所有招呼/回话必须由 Agent 用真实鼠标点击发出。',
          '- 插件只负责：判断（evaluate）、记录（upsert/log）、排序筛选（list/next）、给人看的话术（flow）。',
        ].join('\n'),
      },
      {
        id: 'efficiency',
        title: '效率纪律（省 token 全靠这几条）',
        builtin: true,
        body: [
          '- **先把列表滚到底**（底部出现「没有更多了」），再用 `sweep` 把整份名单一次性交给插件核对；只看首屏就下结论必漏人。',
          '  `sweep batch=[{name,preview}] hitEnd=true` 直接回 missing / waitingMe / waitingThem / terminal。',
          '  preview 取会话列表的预览文本：以 `[已读]`/`[送达]` 开头 = 最后一句是我发的；纯文本 = 对方说的、轮到我。',
          '  漏传 hitEnd 或传 false，会返回 warning：本轮不得视为完成，必须继续下滚。',
          '- **记账要批**：一轮里处理完的人用 `action=batch, batch=[{...},{...}]` 一次写，不要一人一次调用。',
          '- **默认输出已精简**：upsert/reject/star 只回 seq/name/stage/next/gaps。要全量档案才加 `verbose=true`。',
          '- **别重复看**：sweep 报 waitingThem 的不用点开；terminal 的直接跳过。',
        ].join('\n'),
      },
      {
        id: 'dedupe',
        title: '去重（不重复查看、不重复招呼）',
        builtin: true,
        body: [
          '- 去重键 = **姓名 + 公司**，用 `check` 动作查。同名不同公司算不同人。',
          '- 已招呼过 → **跳过，绝不重复打招呼**；看过但没打招呼 → 跳过不重复看。',
          '- 看过但决定不打的，用 `view` 记一句原因，下次直接跳过。',
        ].join('\n'),
      },
      {
        id: 'criteria',
        title: '硬性口径（以候选人自述为准判定，真伪后续人工核验）',
        builtin: true,
        body: [
          '- 学历 {eduMin} 及以上；毕业满 {gradYearMin} 年；工作满 {workYearMin} 年；应届/未毕业直接淘汰',
          '- 期望城市需在：{cityWhitelist}（明确写了别的城市才算不符）',
          '- 学信网可查：候选人自述「可查」即视为通过，核验状态保持 pending，由人工后续核查',
          '- 学历只认**学信网（CHSI）**；民教网查不到 = 不符合要求',
          '- 必备技能：{mustSkills}；方向排除：{rejectSkills}（且无必备技能证据才淘汰）',
          '- 项目经历需命中以下关键词之一：{projectKeywords}',
          '- **待定 pending 唯一条件**：期望薪资下限 > {expectSalaryMinCapK}K。其他一切照旧硬淘汰。',
          '- 加分（不参与淘汰）：{plusSkills}、性能优化、方向加分词：{starTokens}',
        ].join('\n'),
      },
      {
        id: 'star',
        title: '⭐ 优先回捞',
        builtin: true,
        body: [
          '- 命中岗位口径里的「方向加分词」（{starTokens}）但被城市或年限淘汰的，evaluate 会给 starWorthy=true。',
          '- 这类不要直接放弃：置 starred 并写清回捞理由，供人工决策。',
        ].join('\n'),
      },
      {
        id: 'judge',
        title: '判定流程',
        builtin: true,
        body: [
          '- 先用 `evaluate`（或 `upsert` 返回里的 evaluation）拿 gaps / hits / suggestStage / rejectReason。',
          '- `suggestStage` 就是该写的 stage：rejected=淘汰、pending=待定、qualified=初筛通过。',
          '- 有 gaps 但技术方向极匹配 → 不要拒绝，先 `star` 打星并记录，等人工决定。',
        ].join('\n'),
      },
      {
        id: 'archive',
        title: '沟通要点必须存档',
        builtin: true,
        body: [
          '- 每次读到候选人回复，用 `log` 动作写入一条要点（dir=in）。',
          '- 要点必须包含：毕业年份/专业、学信网、工作年限、期望薪资、可面试时间、项目匹配点。',
        ].join('\n'),
      },
      {
        id: 'steps',
        title: '固定动作（顺序不可颠倒）',
        builtin: true,
        body: [
          '1. 首次接触只发 greet，**不要一上来就要简历**。',
          '2. 候选人回复且自述满足口径 → 置 stage=qualified，再发 askResume。',
          '3. 收到附件简历 → 置 stage=resume_received，发 ackResume。',
          '4. 候选人给出可面试时间 → 置 interview_available（或 interview_pending），只记录不再回复，交 HR 定档。',
          '5. HR 定档后用 `interview` 动作写入面试参数（time/location/interviewMode/contact/phone...），插件渲染好邀约话术，Agent 复制发出；有 time 则自动变 interview_scheduled。',
          '   岗位级默认值用 `config key=interview` 配置，候选人只存覆盖项，没设置的一律继承岗位默认。',
          '6. 回复里没说学历或没说学信网 → 允许追问一句 clarify；说全了就不要再追问。',
          '7. 其他任何回复：不回复，不改状态。',
        ].join('\n'),
      },
      {
        id: 'rhythm',
        title: '打招呼节奏（防风控）',
        builtin: true,
        body: [
          '- 每天额度 {greetQuotaPerDay} 条是**目标**，当天要打满；每轮 {roundGreetSize} 条左右停一下。',
          '- **不要刻意等待**：正常地逐个浏览、点开在线简历看、评估、打招呼。',
          '- **逐个操作**：禁止批量打招呼、禁止走接口或脚本直发。',
          '- 计数器（pace / markGreet / markBrowse）只用来记进度，不要为了凑数字空转。',
        ].join('\n'),
      },
      {
        id: 'humanize',
        title: '拟人化操作规范（风控看的是行为分布，不是点击真假）',
        builtin: true,
        body: [
          '平台**看不到**你是不是程序点的——系统级鼠标是真事件（isTrusted=true），读无障碍树也不产生页面事件。',
          '它评的是**行为分布**：坐标方差、间隔方差、鼠标轨迹、停留时长、行为分叉、验证码后的反应。',
          '这几项以前全踩了，所以被判成机器。以下每条都是硬要求，不是建议：',
          '',
          '1. **落点随机**：点击坐标 = 控件中心 ±{clickOffsetPx}px 随机，禁止连续多条打同一像素。',
          '2. **先动再点**：点击前先做 1~{preMoveCount} 次预移动（间隔 {preMoveDelayMs}ms），制造 mousemove 轨迹；到位后停 {hoverDwellMs}ms 再按下。**具体坐标与停顿一律走 `clickPlan(x,y)` 取，不要自己点控件中心。**',
          '3. **动作间停顿**：任意两个动作（点卡/滚动/点击/切页）之间停 {actionPauseMs}ms，不连发。',
          '4. **先浏览再打招呼**：每条招呼前必须点开 1 份在线简历，读 {browseDwellSec} 秒——这本来就是质量要求。',
          '5. **制造分叉**：约 {skipRate} 比例的卡片看一眼就走、不打招呼；每若干条以 {wanderRate} 概率切去「沟通」页再切回。',
          '6. **打字逐字**：回复话术逐字输入（{typeCharDelayMs}ms/字），禁止整段粘贴后一次回车。',
          '7. **验证码即止损**：看到 passport/verify.html 立刻停 {verifyCooldownMin} 分钟以上；恢复后节奏减半。绝不在解完验证码 10 分钟内恢复原速——这是被判机器的头号证据。',
          '8. **单日硬上限 {dailyHardCap} 条**：额度是理论值不是安全值，别按额度跑。',
          '9. **操作顺序不可倒**：开卡 → 读摘要 → 点进在线简历 → 判定 → 回卡片点打招呼 → 立刻 markGreet 1 → 回 pace 查间隔。',
          '',
          '以上参数存在岗位口径 humanize 字段里，可 config key=humanize 调整；pace 每次原样返回。',
        ].join('\n'),
      },
      {
        id: 'replyGuard',
        title: '回话边界（限制乱说话，可改）',
        builtin: true,
        body: [
          '**发每条回话之前先跑一次 `checkReply`（text=你要发的话）**：pass=true 才允许点发送；pass=false 一律改口。',
          '这不是建议，是硬闸门——违规词命中或超长都会被拦下。',
          '',
          '**绝对不能出现的内容：**',
          '1. **约面试 / 给面试时间 / 问哪天方便** —— 只有人手动把候选人置为面试阶段后才可约，其余一律不约。',
          '2. **提预算、评价对方薪资、「期望太高」「给不到」「暂时不合适」** —— 超预算就内部记待定，对候选人只发标准回执。',
          '3. **承诺具体答复时间**（明天回复 / 尽快答复 / 稍后回复），也不要替 HR 或面试官答应事情。',
          '4. **保证性承诺**（保证 / 一定能 / 百分百 / 包过）。',
          '5. **主动索要微信 / 手机号** —— 平台内沟通即可。',
          '6. **谈派驻 / 外派的具体周期** —— 只说「长期稳定的项目、客户方一直有需求、正常按年走」。',
          '7. **发散**：不闲聊、不介绍公司业务、不解释筛选标准、不评价候选人。只发当前阶段对应的话术模板。',
          '',
          '**长度**：单条不超过 {replyMaxChars} 字。',
          '**默认动作**：拿不准就先不发，把情况记进台账等人工。宁可少回一句，不要多说一句。',
          '**候选人明确说外包 / 外派不考虑**：不回复、不劝说，直接记淘汰。',
          '',
          '边界词表存在岗位口径 `replyGuard.forbid` / `replyGuard.softWarn` 里，可 `config key=replyGuard value={...}` 整体替换，也可改本节文字。',
        ].join('\n'),
      },
      {
        id: 'screenGate',
        title: '打招呼前置：必须先看在线简历（硬闸门）',
        builtin: true,
        body: [
          '推荐页**只看卡片摘要不许打招呼**。卡片上的「优势」是自述摘要，项目到底做过什么，必须点开在线简历看。',
          '',
          '固定顺序（顺序不可倒）：',
          '1. 点开卡片 → 进入在线简历，读工作经历 / 项目经验（这一步至少 {screenMinReadSec} 秒）。',
          '2. 调 `screen(name, company, resumeRead=true, projects=「从简历里读到的项目原文」, score, decision)`。',
          '   - `resumeRead` 必须为 true，否则被拒。',
          '   - `projects` 至少 20 字，写简历里的真实内容——这是「真看过」的凭据，也是事后抽查的依据。',
          '   - `decision` 三选一：greet / skip / reject。',
          '3. 判定满足要求 → 回卡片点「打招呼」→ **立刻** `markGreet 1 name=… company=…`。',
          '',
          '**闸门**：`markGreet` 和 `upsert stage=greeted` 都会校验「有没有这个人的 screen 记录、decision 是不是 greet、',
          '距登记是否满 {screenMinReadSec} 秒」。任一不满足直接报错、不计数。也就是说**不看简历就打招呼，账根本记不上**。',
        ].join('\n'),
      },
      {
        id: 'chatScope',
        title: '回话前置：必须先按岗位筛选沟通页（硬闸门）',
        builtin: true,
        body: [
          '「沟通」页里可能混着多个岗位的候选人，**不先选岗位就回话必然张冠李戴**。',
          '',
          '固定顺序：',
          '1. 进「沟通」页 → 左上角职位下拉选成本岗位（当前应为 **{jobTitle}**）。',
          '2. 调 `chatScope(pageJobLabel=「页面上显示的职位名」)` 声明作用域。',
          '   - 页面标签与当前岗位对不上 → 直接报错，要求先切筛选。',
          '   - 默认 {chatScopeTtlMin} 分钟后过期，需要重新确认。',
          '3. 之后每一条 `log`（回话记录）都必须在这个作用域内，否则被拒。',
          '',
          '一句话：**先筛岗位、再 chatScope、再回话**；换岗位就重新 chatScope。',
        ].join('\n'),
      },
    ],
    lessons: [],
    pending: [],
    updatedAt: nowISO(),
  }
}

/** 老台账没有 sop 字段 → 补齐；结构残缺 → 用默认值兜底 */
function ensureSop(state) {
  const def = defaultSop()
  if (!state.sop || typeof state.sop !== 'object') {
    state.sop = def
    return state.sop
  }
  const sop = state.sop
  if (!Array.isArray(sop.sections) || !sop.sections.length) sop.sections = def.sections
  if (!Array.isArray(sop.lessons)) sop.lessons = []
  if (!Array.isArray(sop.pending)) sop.pending = []
  // 内置节缺失（升级后新增的节）自动补回
  def.sections.forEach((d) => {
    if (!sop.sections.some((s) => s.id === d.id)) sop.sections.push(d)
  })
  if (!sop.updatedAt) sop.updatedAt = nowISO()
  return sop
}

/** 把 {变量} 替换成岗位数据；未知变量原样保留，方便定位 */
function sopSubstitute(text, vars) {
  return String(text == null ? '' : text).replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] == null ? '' : vars[k]) : m,
  )
}
function sopText(state) {
  const { job } = resolveJob(state)
  if (!job) return '## 招聘流水线\n当前没有可用岗位，请先用 recruit_pipeline 的 job 动作创建岗位。'
  const sop = ensureSop(state)
  const c = job.criteria || {}
  const flow = flowMap(job)
  const modeText = MODE_LABEL[state.mode] || MODE_LABEL.recruit
  const starList = Array.isArray(c.starTokens) ? c.starTokens.map((t) => String(t)).filter(Boolean) : []
  const tpl = (key) => {
    const step = flow[key]
    if (!step || step.enabled === false || !step.template) return null
    return fill(step.template, job)
  }

  const hz = humanizeOf(c)
  const rangeText = (v) => (Array.isArray(v) ? v.join('-') : String(v == null ? '' : v))
  const pctText = (v) => `${Math.round(Number(v || 0) * 100)}%`

  // 所有 {变量} 的数据源；改口径后这里自动跟着变，不用改 SOP 文本
  const vars = {
    jobTitle: c.jobTitle || '',
    jobName: job.name || '',
    city: c.city || '',
    salary: c.salary || `${c.salaryMinK}-${c.salaryMaxK}K`,
    salaryMinK: c.salaryMinK,
    salaryMaxK: c.salaryMaxK,
    eduMin: c.eduMin || '',
    gradYearMin: c.gradYearMin == null ? '' : c.gradYearMin,
    workYearMin: c.workYearMin == null ? '' : c.workYearMin,
    cityWhitelist: (c.cityWhitelist || []).join(' / '),
    mustSkills: (c.mustSkills || []).join(' / '),
    rejectSkills: (c.rejectSkills || []).join(' / '),
    projectKeywords: (c.projectKeywords || []).join(' / '),
    plusSkills: (c.plusSkills || []).join(' / '),
    expectSalaryMinCapK: c.expectSalaryMinCapK,
    starTokens: starList.length ? starList.join(' / ') : '（当前岗位未配置方向加分词）',
    greetQuotaPerDay: c.greetQuotaPerDay,
    roundGreetSize: c.roundGreetSize,
    clickOffsetPx: hz.clickOffsetPx,
    preMoveCount: hz.preMoveCount,
    preMoveDelayMs: rangeText(hz.preMoveDelayMs),
    actionPauseMs: rangeText(hz.actionPauseMs),
    hoverDwellMs: rangeText(hz.hoverDwellMs),
    browseDwellSec: rangeText(hz.browseDwellSec),
    typeCharDelayMs: rangeText(hz.typeCharDelayMs),
    skipRate: pctText(hz.skipRate),
    wanderRate: pctText(hz.wanderRate),
    verifyCooldownMin: hz.verifyCooldownMin,
    dailyHardCap: hz.dailyHardCap,
    replyMaxChars: (job.criteria.replyGuard || {}).maxChars || 80,
    screenMinReadSec: c.screenMinReadSec == null ? 20 : c.screenMinReadSec,
    chatScopeTtlMin: c.chatScopeTtlMin == null ? 120 : c.chatScopeTtlMin,
  }

  const out = []
  out.push(`## 招聘流水线｜${job.name}`)
  out.push(`岗位：${vars.jobTitle}｜${vars.city}｜${c.salaryMinK}-${c.salaryMaxK}K`)
  out.push('**当前上下文 = 岗位 × 模式**：下面所有 list / next / stats / export / upsert / log 都只作用于当前岗位，绝不串岗。')
  out.push('换岗位用 `selectJob`（会同时恢复该岗位上次用的模式）；换模式用 `mode`（可带 jobId 只改该岗位）。')
  out.push('新建岗位用 `createJob`；删除用 `deleteJob`（候选人记录保留，禁止删最后一个岗位）。')
  out.push(`当前工作模式：**${modeText}**`)
  out.push('')

  // v2.9.0：回话规则直接进提示词（AI 按规则判断），不再是关键词硬拦
  // v2.11.0：工作流程（动作序列）进提示词，顺序即执行顺序
  const wf = workflowOf(c)
  const wfVars = { screenMinReadSec: c.screenMinReadSec == null ? 20 : c.screenMinReadSec, replyMaxChars: (c.replyGuard || {}).maxChars || 80 }
  const wfLabel = { recruit: '招聘流程（推荐页）', reply: '回话流程（沟通页）' }
  for (const mode of ['recruit', 'reply']) {
    const steps = wf[mode] || []
    if (!steps.length) continue
    out.push(`### 工作流程·${wfLabel[mode]}（按顺序执行，不可跳步）`)
    steps.forEach((s, i) => {
      const desc = sopSubstitute(s.text, wfVars)
      out.push(`${i + 1}. **${s.action}**${desc ? `：${desc}` : ''}`)
    })
    out.push('')
  }
  const replyRules = typeof c.replyRules === 'string' ? c.replyRules.trim() : REPLY_RULES_DEFAULT
  if (replyRules) {
    out.push('### 回话规则（在「沟通」页发任何消息前必须遵守）')
    out.push(sopSubstitute(replyRules, { replyMaxChars: (c.replyGuard || {}).maxChars || 80 }))
    out.push('')
  }

  // ---- 可编辑的 SOP 各节：section.body 里写 {变量} 即可引用岗位数据 ----
  sop.sections.forEach((sec) => {
    if (sec.disabled === true) return
    out.push(`### ${sec.title}`)
    out.push(sopSubstitute(sec.body, vars))
    out.push('')
  })

  // ---- 沉淀的教训：自动注入，按命中次数排序（越靠前越常被引用） ----
  const lessons = (Array.isArray(sop.lessons) ? sop.lessons : []).slice()
  if (lessons.length) {
    lessons.sort((a, b) => (b.hits || 0) - (a.hits || 0))
    out.push('### 📌 沉淀的教训（从实战总结，必须遵守）')
    lessons.slice(0, 20).forEach((l) => {
      out.push(`- ${String(l.text || '')}`)
    })
    out.push('')
  }

  // ---- 待审观察：只报数量，不占正文 ----
  const pending = Array.isArray(sop.pending) ? sop.pending : []
  if (pending.length) {
    out.push(`### 🔍 有 ${pending.length} 条待沉淀观察`)
    out.push('用 `sop op=pending` 查看；有价值的用 `sop op=accept id=...` 固化为教训，没价值的 `sop op=drop id=...` 丢掉。')
    out.push('')
  }

  // ---- 话术 ----
  out.push('### 话术（当前岗位 flow，Agent 照着发，必须真人点击发送）')
  const oneLine = (s) => {
    const flat = String(s || '').replace(/\s*\n+\s*/g, ' ⏎ ')
    return flat.length > 160 ? flat.slice(0, 160) + '…' : flat
  }
  const scriptKeys = [
    ['greet', '打招呼'],
    ['askResume', '索取简历'],
    ['ackResume', '简历回执'],
    ['askInterview', '约面试'],
    ['interviewInvite', '邀约面试'],
    ['clarify', '追问澄清'],
  ]
  scriptKeys.forEach(([k, label]) => {
    const v = tpl(k)
    if (!v) return
    // interviewInvite 含候选人级变量，SOP 里只是模板示意，必须提醒不要照抄花括号
    const note = k === 'interviewInvite'
      ? '（模板：{name}{time}{location}{mode}{contact} 等由 interview 动作按候选人填充，**不要照抄花括号**；直接用 interview 返回的 inviteText）'
      : ''
    out.push(`- ${k}（${label}）${note}：${oneLine(v)}`)
  })

  let text = out.join('\n')
  if (text.length > SOP_MAX_CHARS) {
    text += `\n\n> ⚠️ SOP 已 ${text.length} 字，超过预算 ${SOP_MAX_CHARS}。用 \`sop op=list\` 看各节字数，精简冗余能省下每次注入的 token。`
  }
  return text
}
// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

const SORT_KEYS = [
  'seq', 'updatedAt', 'firstSeenAt', 'greetedAt', 'gradYear',
  'workYears', 'expectSalaryMinK', 'starred', 'stage', 'matchScore',
  'techFitScore', 'valueScore',
]

function sortValue(cand, key) {
  switch (key) {
    case 'seq': return Number(cand.seq) || 0
    case 'updatedAt': return String(cand.updatedAt || '')
    case 'firstSeenAt': return String(cand.firstSeenAt || '')
    case 'greetedAt': return String(cand.greetedAt || '')
    case 'gradYear': return Number(cand.gradYear) || 0
    case 'workYears': return Number(cand.workYears) || 0
    case 'expectSalaryMinK':
      return cand.expectSalaryMinK == null ? -1 : Number(cand.expectSalaryMinK)
    case 'starred': return cand.starred ? 1 : 0
    case 'stage': return STAGES.indexOf(cand.stage)
    case 'matchScore': return (cand.matchHits || []).length
    // NA（面议/无薪资）排最后（升序时排最前），用 -1 兜底，绝不让 null 参与减法
    case 'techFitScore': return numOrNull(cand.techFitScore) == null ? -1 : Number(cand.techFitScore)
    case 'valueScore': return numOrNull(cand.valueScore) == null ? -1 : Number(cand.valueScore)
    default: return String(cand.updatedAt || '')
  }
}

function sortCands(list, key, order) {
  const k = SORT_KEYS.includes(key) ? key : 'seq'
  const dir = order === 'desc' ? -1 : 1
  return [...list].sort((a, b) => {
    const av = sortValue(a, k)
    const bv = sortValue(b, k)
    if (typeof av === 'number' && typeof bv === 'number') {
      // 序号默认正序更符合直觉，其余数值键同样按 order 走
      return (av - bv) * dir
    }
    return String(av).localeCompare(String(bv)) * dir
  })
}

function csvCell(value) {
  const text = value == null ? '' : String(value)
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function exportRows(rows, criteria) {
  return rows.map((r) => ({
    '序号': r.seq || '',
    '姓名': r.name,
    '公司': r.company,
    '上一家公司': r.company2 || '',
    '学历': r.edu,
    '毕业年份': r.gradYear == null ? '' : r.gradYear,
    '毕业学校': r.school || '',
    '期望城市': r.expectCity,
    '期望职位': r.expectPosition || '',
    '工作年限': r.workYears == null ? '' : r.workYears,
    '期望薪资': r.expectSalary,
    '期望薪资下限K': r.expectSalaryMinK == null ? '' : r.expectSalaryMinK,
    '手机号': r.phone || '',
    '邮箱': r.email || '',
    '学信网自述': r.xuexinSelf,
    '核验': r.xuexinVerify,
    '状态': r.stageLabel,
    '人员状态': r.status7Label || '',
    '淘汰原因': r.rejectReasonLabel,
    '匹配要点': (r.matchHits || []).join('；'),
    '匹配缺口': (r.matchGaps || []).join('；'),
    // v2.1 新增四列
    '匹配度分': r.techFitScore == null ? '' : r.techFitScore,
    '匹配度等级': r.techFitGrade || '',
    '性价比分': r.valueScore == null ? '' : r.valueScore,
    '性价比等级': r.valueGrade || '',
    // v2.2：跨岗位导出（filterJob=all）时用行自带的岗位名，单岗位导出仍用口径里的标题
    '岗位': r.jobName || criteria.jobTitle || '',
    '岗位ID': r.jobId || '',
    // v2.27.0：沟通维度（原先只有 msgCount，缺少对话条数与最后一条内容）
    '消息条数': r.msgCount == null ? '' : r.msgCount,
    '对话条数': r.dialogCount == null ? '' : r.dialogCount,
    '最后发言': r.lastSpeaker || '',
    '最后沟通时间': fmtTime(r.lastTalkAt),
    '最近对话内容': String(r.lastTalkText || '').slice(0, 200),
    '最近沟通要点': String(r.keyInfo || '').slice(0, 300),
    // v2.27.0：项目与技能（原先只在面板里看得到，导不出来）
    '项目摘要': String(r.projectBrief || '').slice(0, 500),
    '技能标签': (r.skills || []).join('；'),
    '打星': r.starred ? '⭐' : '',
    // 时间线
    '首次登记': r.firstSeenAtLocal,
    '打招呼时间': fmtTime(r.greetedAt),
    '回话时间': fmtTime(r.repliedAt),
    '收简历时间': fmtTime(r.resumeAt),
    '更新时间': r.updatedAtLocal,
    // v2.27.0：面试信息（原先只导了时间/地点/方式/联系人/电话，缺链接与备注）
    '面试时间': r.interviewTime || '',
    '面试地点': r.interviewLocation || '',
    '面试方式': r.interviewMode || '',
    '面试联系人': r.interviewContact || '',
    '面试电话': r.interviewPhone || '',
    '面试链接': (r.interview && r.interview.link) || '',
    '面试备注': (r.interview && r.interview.note) || '',
    // v2.3：备注列追加在最后（CSV 与 markdown 都带备注）
    '备注': r.note == null ? '' : String(r.note),
  }))
}

/** 推荐下一条该发的话（只看 stage 与信息完整度，不发消息） */
function suggestFor(job, candidate) {
  const stage = candidate.stage
  const clarify = clarifyState(candidate)
  const usableClarify = clarify.needed &&
    ['inbound', 'qualified', 'resume_requested', 'resume_received', 'greeted'].includes(stage)
  if (usableClarify) {
    const text = templateOf(job, 'clarify')
    if (text) return { key: 'clarify', text }
  }
  const table = {
    new: 'greet',
    greeted: 'askResume',
    inbound: 'askResume',
    qualified: 'askResume',
    resume_requested: 'askResume',
    resume_received: 'ackResume',
    interview_pending: 'askInterview',
    interview_available: 'askInterview',
  }
  const key = table[stage]
  if (!key) return { key: '', text: '' }
  const text = templateOf(job, key)
  return { key: text ? key : '', text: text || '' }
}


const FLOW_DEFINITIONS = {
  recommend: {
    title: '推荐牛人',
    mode: 'recruit',
    steps: ['确认岗位筛选', '列表预览初筛并记录看过', '打开在线简历逐步下滑阅读', 'screen 记录项目证据', '核对节奏后点击打招呼', 'completeGreet 一次性记招呼与台账', '继续下一位'],
    allowedActions: ['flow', 'pace', 'view', 'screen', 'evaluate', 'completeGreet', 'observe'],
    forbidden: ['搜索人才库', '热搜联系 Ta', '沟通页回话', '付费工具栏'],
  },
  newGreet: {
    title: '新招呼·未读',
    mode: 'reply',
    steps: ['沟通页确认岗位并 chatScope', 'observe 记录当前未读名单', '预览能判定的批量记录，信息不足才打开在线简历', 'screen 后只回当前阶段第一句', 'log 更新同一人的记录'],
    allowedActions: ['flow', 'chatScope', 'observe', 'view', 'screen', 'evaluate', 'batch', 'log', 'reject'],
    forbidden: ['给所有人都要简历', '已读会话重复回复', '推荐牛人打招呼', '搜索人才库', '热搜联系 Ta'],
  },
  chatting: {
    title: '沟通中·未读',
    mode: 'reply',
    steps: ['沟通页确认岗位并 chatScope', 'observe 只看候选人最后发言的未读会话', '按附件/硬项信息/礼貌收尾/明确拒绝分类', '必要时回当前阶段模板', 'log 更新阶段；无新信息则 noReply 不再重开'],
    allowedActions: ['flow', 'chatScope', 'observe', 'view', 'screen', 'log', 'upsert', 'reject'],
    forbidden: ['催促没有新消息的人', '重复回客气话', '主动给面试时间', '承诺答复时间', '索要微信手机号'],
  },
  resume: {
    title: '已获取简历',
    mode: 'reply',
    steps: ['确认简历已实际接收', '读取附件并补齐联系方式/学历证据', '核对平台与简历冲突', '资料齐全后等待人工面试安排'],
    allowedActions: ['flow', 'observe', 'upsert', 'log', 'evaluate'],
    forbidden: ['未看到附件就标已收简历', '替 HR 定面试', '把缺失字段当作 0 或不符合'],
  },
  interview: {
    title: '邀约面试',
    mode: 'reply',
    steps: ['检查简历与沟通已完成', '人工确认时间/地点/方式/联系人', 'interview dryRun 预览邀约', '真实点击发送后登记状态'],
    allowedActions: ['flow', 'interview', 'log'],
    forbidden: ['缺时间或联系人就称已约面', '未确认就发送面试邀约', '替候选人承诺出席'],
  },
}

function configuredFlow(criteria, track) {
  const workflows = criteria && criteria.workflows
  const custom = workflows && Array.isArray(workflows[track]) ? workflows[track] : null
  if (!custom || !custom.length) return null
  return custom.map((step, i) => typeof step === 'string'
    ? step
    : String((step && (step.action || step.text || step.name)) || `步骤 ${i + 1}`))
}

function flowOutput(state, jobId, requested) {
  const job = state.jobs[jobId]
  if (!job) return { ok: false, error: '岗位不存在' }
  const context = state.flowContext && state.flowContext.jobId === jobId ? state.flowContext : null
  const track = requested || (context && context.track) || (state.mode === 'reply' ? 'chatting' : 'recommend')
  const def = FLOW_DEFINITIONS[track]
  if (!def) return { ok: false, error: 'track 只支持 recommend / newGreet / chatting / resume / interview' }
  if (state.mode === 'recruit' && track !== 'recommend') {
    return { ok: false, error: '当前是招聘模式，只能走推荐牛人；要先 mode(reply) 再处理沟通子流程' }
  }
  if (state.mode === 'reply' && track === 'recommend') {
    return { ok: false, error: '当前是回话模式，不能进推荐牛人打招呼；要先 mode(recruit)' }
  }
  if (track === 'interview' && state.mode !== 'reply') {
    return { ok: false, error: '邀约面试属于回话流程；先 mode(reply)' }
  }
  return {
    ok: true,
    jobId,
    track,
    title: def.title,
    mode: state.mode,
    steps: configuredFlow(job.criteria, track) || def.steps,
    allowedActions: def.allowedActions,
    configurable: 'config key=workflows value={...} 可调整各子流程步骤文案与顺序；动作层安全校验不可配置关闭。',
    forbidden: def.forbidden,
    safety: '真实鼠标键盘逐步操作；不绕过验证码/登录/付费；预览只做初筛，完整简历证据由 screen 保存；任何节奏或作用域校验失败都停止发送。',
  }
}

function greetPaceError(state, jobId, today, nowMs) {
  const job = state.jobs[jobId]
  const c = job.criteria
  const count = counterFor(state, jobId, today)
  const hz = humanizeOf(c)
  const quota = Math.min(Number(c.greetQuotaPerDay) || 0, Number(hz.dailyHardCap) || Number.MAX_SAFE_INTEGER)
  if (count.greets >= quota) return `今日已达到安全上限 ${quota} 条，停止打招呼`
  if (count.restUntil && new Date(count.restUntil).getTime() > nowMs) {
    return `本轮休息中，到 ${new Date(count.restUntil).toLocaleTimeString()} 后再继续`
  }
  if (count.roundGreets >= (c.roundGreetSize || 15)) return '本轮已打满，先回 pace 进入休息，不要连续发'
  const elapsed = count.lastGreetAt ? (nowMs - new Date(count.lastGreetAt).getTime()) / 1000 : Infinity
  const minGap = c.greetMinGapSec == null ? 300 : Number(c.greetMinGapSec)
  if (elapsed < minGap) return `距上一条仅 ${Math.round(elapsed)} 秒，还需等 ${Math.ceil(minGap - elapsed)} 秒；可继续阅读下一份简历`
  return null
}

async function runAction(args) {
  const action = String(args.action || '')
  const today = todayKey()

  // ============ v2.4 batch：一次记多人，省掉 N 次往返 ============
  if (action === 'batch') {
    let items = args.batch
    if (typeof items === 'string') {
      try { items = JSON.parse(items) } catch (e) { return { ok: false, error: 'batch 不是合法 JSON' } }
    }
    if (!Array.isArray(items) || !items.length) {
      return { ok: false, error: 'batch 需要非空数组 [{name, company, ...}]' }
    }
    const results = []
    for (const it of items) {
      if (!it || typeof it !== 'object') continue
      const one = Object.assign({}, args, it)
      one.action = it.action || 'upsert'
      delete one.batch
      try {
        results.push(await runAction(one))
      } catch (e) {
        results.push({ ok: false, name: it.name || '?', error: String((e && e.message) || e) })
      }
    }
    const failed = results.filter((r) => !r.ok).length
    const greetedInBatch = results.filter((r) => r && r.ok && r.stage === 'greeted').length
    const out = { ok: failed === 0, count: results.length, failed, results }
    if (greetedInBatch > 1) {
      out.pacingViolation =
        `一次写入了 ${greetedInBatch} 条 greeted，等于把「打完再补记」合法化。` +
        `打招呼必须一条一条来：每打一条立刻 markGreet 1，中间穿插浏览在线简历。` +
        `本条只是告警，数据已落库；但下一轮起必须拆成单条调用，否则会复现 2026-10-21 的风控封锁。`
    }
    return out
  }

  // ======================= 岗位管理 =======================
  if (action === 'jobs') {
    return readState((state) => ({
      ok: true,
      activeJobId: state.activeJobId,
      mode: state.mode,
      jobModes: jobModesOf(state),
      jobs: jobList(state),
    }))
  }

  if (action === 'selectJob') {
    if (!args.jobId) return { ok: false, error: '缺少 jobId' }
    return withState((state) => {
      if (!state.jobs[args.jobId]) return { ok: false, error: `岗位不存在：${args.jobId}` }
      state.activeJobId = args.jobId
      // v2.2：切岗位时恢复该岗位上次用的模式（岗位 × 模式 一起切换）
      state.mode = state.jobModes[args.jobId] || state.mode
      const job = state.jobs[args.jobId]
      return {
        ok: true,
        activeJobId: state.activeJobId,
        mode: state.mode,
        jobModes: jobModesOf(state),
        jobId: job.id,
        job: job.name,
        jobTitle: job.criteria.jobTitle,
        candidateCount: Object.values(state.candidates).filter((c) => c.jobId === job.id).length,
        stats: statsOf(state, job.id),
        jobs: jobList(state),
      }
    })
  }

  // v2.2：新建岗位（面板「＋ 新建岗位」走同一个实现）
  if (action === 'createJob') {
    return withState((state) => createJobInState(state, {
      name: args.jobName || args.name || args.jobTitle,
      mode: args.template || args.jobTemplate || 'copy',
      copyFromJobId: args.copyFromJobId || args.jobId,
    }))
  }

  // v2.2：删除岗位（只删岗位定义，不动候选人）
  if (action === 'deleteJob') {
    return withState((state) => deleteJobInState(state, args.jobId))
  }

  if (action === 'job') {
    const op = args.jobOp || (args.job || args.criteria ? 'update' : 'show')

    if (op === 'show') {
      return readState((state) => {
        const { job, id } = resolveJob(state, args.jobId)
        if (!job) return { ok: false, error: `岗位不存在：${args.jobId || state.activeJobId}` }
        return { ok: true, jobId: id, job: jobPublic(job, state.activeJobId), jobs: jobList(state) }
      })
    }

    if (op === 'delete') {
      if (!args.jobId) return { ok: false, error: '缺少 jobId' }
      // 复用 v2.2 的删除实现：禁止删最后一个岗位、只删定义不动候选人
      return withState((state) => deleteJobInState(state, args.jobId))
    }

    // create / update
    return withState((state) => {
      const incoming = args.job && typeof args.job === 'object' ? args.job : {}
      const id = String(incoming.id || args.jobId || '').trim()
      if (!id) return { ok: false, error: '岗位定义缺少 id' }
      if (op === 'create' && state.jobs[id]) return { ok: false, error: `岗位已存在：${id}` }
      const base = state.jobs[id] || defaultJob(id, incoming.name || args.name || args.jobTitle)
      const criteria = {
        ...base.criteria,
        ...(incoming.criteria || {}),
      }
      if (args.criteria && typeof args.criteria === 'object') Object.assign(criteria, args.criteria)
      if (args.key && args.value !== undefined) criteria[args.key] = args.value
      if (args.jobTitle) criteria.jobTitle = args.jobTitle
      criteria.salary = `${criteria.salaryMinK}-${criteria.salaryMaxK}K`

      const flowIn = incoming.flow || args.flow
      let flow = base.flow
      if (Array.isArray(flowIn) && flowIn.length) {
        flow = flowIn.map((step, i) => ({
          key: String(step.key || `step${i + 1}`),
          name: String(step.name || step.key || `步骤${i + 1}`),
          enabled: step.enabled !== false,
          template: String(step.template || ''),
        }))
        for (const def of defaultFlow()) {
          if (!flow.some((s) => s.key === def.key)) flow.push({ ...def })
        }
      }
      const highlightsIn = incoming.highlights || args.highlights
      const highlights = Array.isArray(highlightsIn) && highlightsIn.length
        ? highlightsIn.map(String)
        : base.highlights

      state.jobs[id] = {
        id,
        name: String(incoming.name || args.name || base.name),
        active: incoming.active !== undefined ? incoming.active !== false : base.active,
        createdAt: base.createdAt || nowISO(),
        seqCounter: Number(base.seqCounter) || 0,
        criteria,
        highlights,
        flow,
      }
      if (!state.activeJobId) state.activeJobId = id
      return {
        ok: true,
        jobOp: op,
        jobId: id,
        job: jobPublic(state.jobs[id], state.activeJobId),
        jobs: jobList(state),
      }
    })
  }

  // ======================= 全局动作 =======================
  if (action === 'mode') {
    const target = String(args.mode || args.value || args.summary || '').trim()
    return withState((state) => {
      // v2.2：mode 支持 jobId —— 只改该岗位自己的模式，不动别的岗位
      const targetJobId = args.jobId && state.jobs[args.jobId] ? args.jobId : state.activeJobId
      if (!target) {
        return {
          ok: true,
          jobId: targetJobId,
          mode: state.jobModes[targetJobId] || state.mode,
          jobModes: jobModesOf(state),
          modes: MODE_LABEL,
        }
      }
      if (!['recruit', 'reply', 'all'].includes(target)) {
        return { ok: false, error: 'mode 只能是 recruit / reply / all' }
      }
      state.jobModes[targetJobId] = target
      // 当前岗位的模式就是 state.mode（老接口/提示词只看 state.mode）
      if (targetJobId === state.activeJobId) state.mode = target
      return {
        ok: true,
        jobId: targetJobId,
        mode: target,
        jobModes: jobModesOf(state),
        hint:
          target === 'recruit'
            ? '招聘模式：只进「推荐牛人」看卡片、评估、逐个打招呼；不要进「沟通」回复'
            : target === 'reply'
              ? '回话模式：只进「沟通」处理回话；不要进「推荐牛人」打招呼'
              : '混合模式：招聘和回话都要做，但一轮只做一种，做完再切',
      }
    })
  }

  // v2.26.0｜audit：自查本轮有没有绕过护栏。
  // 存在的意义是「可观测」——绕过 mode / chatScope / log 时台账不会报错，
  // 只有事后对账才看得出来，所以给一个随时能跑的检查。
  if (action === 'audit') {
    return withState((state) => {
      // 注意：这里不能引用下面的 jobId —— 它在「候选人相关」段才初始化
      const { job, id: auditJobId } = resolveJob(state, args.jobId)
      const mode = (state.jobModes && state.jobModes[auditJobId]) || state.mode || 'recruit'
      const sc = state.chatScope
      const issues = []
      const now = Date.now()

      // ① 模式 vs 台账：recruit 模式下不该有沟通阶段的新记录
      const cands = Object.values(state.candidates).filter((c) => c.jobId === auditJobId)
      const chatStage = cands.filter((c) => CHAT_ONLY_STAGES.includes(c.stage))
      if (mode === 'recruit' && chatStage.length > 0) {
        issues.push({
          code: 'MODE_MISMATCH',
          severity: 'warn',
          message: `当前 recruit 模式，但台账里有 ${chatStage.length} 人处于沟通阶段（resume_* / interview_*）。` +
            `这些阶段按 v2.26.0 只能在 reply 模式 + chatScope 下产生；若是本版本之前写的，属于历史遗留。`,
          sample: chatStage.slice(0, 5).map((c) => `${c.name}(${STAGE_LABEL[c.stage] || c.stage})`),
        })
      }

      // ② chatScope 是否声明/过期
      if (!sc || !sc.at) {
        issues.push({
          code: 'NO_CHAT_SCOPE',
          severity: 'info',
          message: '尚未声明 chatScope。要处理「沟通」页就必须先 chatScope(pageJobLabel=页面上显示的职位名)。',
        })
      } else {
        const maxAge = (job && job.criteria.chatScopeTtlMin ? job.criteria.chatScopeTtlMin : 120) * 60 * 1000
        const ageMin = Math.round((now - new Date(sc.at).getTime()) / 60000)
        if (now - new Date(sc.at).getTime() > maxAge) {
          issues.push({
            code: 'CHAT_SCOPE_EXPIRED',
            severity: 'warn',
            message: `chatScope 已过期（${ageMin} 分钟前声明，TTL ${Math.round(maxAge / 60000)} 分钟），需要重新确认岗位筛选再 chatScope。`,
          })
        } else if (sc.jobId !== auditJobId) {
          issues.push({
            code: 'CHAT_SCOPE_JOB_MISMATCH',
            severity: 'warn',
            message: `chatScope 记录的是另一个岗位（${sc.jobId}），当前岗位是 ${auditJobId}。`,
          })
        }
      }

      // ③ log 覆盖率：沟通阶段但一条对话都没记
      // 注意 dialogCount 是「读取时由 dialogLog.length 派生」的字段，不落盘；
      // 这里读的是原始 state，必须自己算长度，否则永远是 0（v2.26.0 首版就是这个 bug）
      const noDialog = chatStage.filter((c) => !((c.dialogLog || []).length))
      if (noDialog.length > 0) {
        issues.push({
          code: 'LOG_MISSING',
          severity: 'warn',
          message: `${noDialog.length} 人处于沟通阶段但 dialogCount=0（没用 log 记过对话）。` +
            `沟通要点必须用 log 存档（毕业年份/学信网/工作年限/期望薪资/可面试时间/项目匹配点），写在 note 里不算。`,
          sample: noDialog.slice(0, 5).map((c) => c.name),
        })
      }

      // ④ 重复记录：同岗位同名多条
      const byName = new Map()
      for (const c of cands) {
        const k = String(c.name || '').trim()
        if (!k) continue
        if (!byName.has(k)) byName.set(k, [])
        byName.get(k).push(c)
      }
      const dups = [...byName.entries()].filter(([, arr]) => arr.length > 1)
      if (dups.length > 0) {
        issues.push({
          code: 'DUPLICATE_ROWS',
          severity: 'warn',
          message: `${dups.length} 个姓名在同岗位下有多条记录。interview / upsert 会先命中第一条，容易推错状态。`,
          sample: dups.slice(0, 5).map(([n, arr]) => `${n}×${arr.length}`),
        })
      }

      const ok = issues.filter((i) => i.severity === 'warn').length === 0
      return {
        ok: true,
        jobId: auditJobId,
        mode,
        chatScope: sc ? { label: sc.label, jobId: sc.jobId, at: sc.at } : null,
        counts: { candidates: cands.length, chatStage: chatStage.length, noDialog: noDialog.length, duplicates: dups.length },
        issues,
        verdict: ok ? '未发现护栏绕过迹象' : '发现需要处理的问题，见 issues',
      }
    })
  }

  // ======================= 候选人相关 =======================
  // 解析岗位（后面的动作默认作用于当前岗位）
  const resolved = await readState((state) => {
    const { job, id } = resolveJob(state, args.jobId)
    return { jobId: id, exists: Boolean(job), name: job ? job.name : '' }
  })
  if (!resolved.exists) {
    return { ok: false, error: `岗位不存在：${args.jobId || args.jobId || '(当前岗位)'}` }
  }
  const jobId = resolved.jobId

  // ============ v2.5 interview：配置面试参数（单个 / 指定多人 / 按筛选批量）============
  // 只写"要改的"字段；没写的继承岗位默认（见 interviewDefaults / resolveInterview）
  if (action === 'interview') {
    let targets = []
    if (Array.isArray(args.names) && args.names.length) {
      targets = args.names.map((s) => String(s).trim()).filter(Boolean)
    } else if (args.name) {
      targets = [String(args.name).trim()]
    }
    const useFilter = !targets.length && (args.filterStage || args.filterCity || args.filterEdu)
    if (!targets.length && !useFilter) {
      return { ok: false, error: 'interview 需要 name（单个）/ names（多人）/ filterStage 等筛选条件之一' }
    }
    const pMap = {
      time: args.time,
      window: args.window,
      location: args.location,
      address: args.address,
      mode: args.interviewMode,
      contact: args.contact,
      phone: args.phone,
      link: args.link,
      extra: args.extra,
      note: args.note,
    }
    const patch = {}
    Object.keys(pMap).forEach((k) => {
      const v = pMap[k]
      if (v !== undefined && v !== null && String(v).trim() !== '') patch[k] = String(v).trim()
    })
    if (patch.mode && !INTERVIEW_MODE_LABEL[patch.mode]) {
      return { ok: false, error: `interviewMode 只能是 ${Object.keys(INTERVIEW_MODE_LABEL).join(' / ')}` }
    }
    if (!Object.keys(patch).length) {
      return {
        ok: false,
        error: '没有要设置的面试参数（可传 time/window/location/address/interviewMode/contact/phone/link/extra/note）',
      }
    }
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const all = Object.keys(state.candidates)
        .map((k) => state.candidates[k])
        .filter((c) => c && c.jobId === jobId)
      let pool
      if (useFilter) {
        pool = all
        if (args.filterStage) pool = pool.filter((c) => c.stage === args.filterStage)
        if (args.filterCity) pool = pool.filter((c) => String(c.expectCity || '').indexOf(String(args.filterCity)) >= 0)
        if (args.filterEdu) pool = pool.filter((c) => String(c.edu || '') === String(args.filterEdu))
      } else {
        pool = all.filter((c) => targets.indexOf(c.name) >= 0)
      }
      if (!pool.length) return { ok: false, error: '没有匹配的候选人（检查 name / names 或筛选条件）' }
      const dryRun = args.dryRun === true
      const at = nowISO()
      const results = pool.map((cand) => {
        const base = cand.interview && typeof cand.interview === 'object' ? cand.interview : {}
        const probe = Object.assign({}, cand, { interview: Object.assign({}, base, patch) })
        const iv = resolveInterview(job, probe)
        const nextStage = patch.time
          ? 'interview_scheduled'
          : (['interview_scheduled', 'interview_available', 'interview_pending'].indexOf(cand.stage) >= 0
            ? cand.stage
            : 'interview_pending')
        const missing = []
        if (!['resume_received', 'interview_pending', 'interview_available', 'interview_scheduled'].includes(cand.stage) || !cand.resumeAt) {
          missing.push('尚未实际接收简历')
        }
        if (nextStage === 'interview_scheduled') {
          if (!iv.time) missing.push('具体面试时间')
          if (!iv.location && iv.mode !== 'video' && iv.mode !== 'phone') missing.push('面试地点')
          if (!iv.contact) missing.push('面试联系人')
          if (iv.mode === 'video' && !iv.link) missing.push('视频面试链接')
        }
        if (missing.length) {
          return { seq: cand.seq, name: cand.name, ok: false, error: `不能进入面试阶段：${missing.join('、')}；先补齐或人工确认` }
        }
        const finalStage = dryRun ? (cand.stage || 'new') : nextStage
        const item = {
          seq: cand.seq,
          name: cand.name,
          stage: finalStage,
          stageLabel: STAGE_LABEL[finalStage] || finalStage,
          time: iv.time,
          modeLabel: INTERVIEW_MODE_LABEL[iv.mode] || iv.mode,
          location: iv.location,
        }
        if (args.render !== false) item.inviteText = renderInvite(job, probe)
        if (!dryRun) {
          if (!cand.interview || typeof cand.interview !== 'object') cand.interview = {}
          Object.keys(patch).forEach((k) => {
            cand.interview[k] = patch[k]
          })
          cand.interview.scheduledAt = at
          if (patch.time) cand.interviewAt = at
          cand.stage = nextStage
          cand.updatedAt = at
        }
        return item
      })
      const out = { ok: true, jobId, count: results.length, defaults: interviewDefaults(job), results }
      const failures = results.filter((item) => item.ok === false)
      if (failures.length) {
        return { ok: false, jobId, count: results.length, failures, error: failures.map((item) => `${item.name}：${item.error}`).join('；') }
      }
      if (dryRun) out.dryRun = true
      return out
    })
  }


  // ============ v2.6 sop：查看 / 修改 / 沉淀（SOP 存在 state 里，不再是硬编码）============
  if (action === 'sop') {
    const op = String(args.op || 'show')
    return withState((state) => {
      const sop = ensureSop(state)
      const at = nowISO()

      if (op === 'show' || op === 'list') {
        const out = {
          ok: true,
          version: sop.version || 1,
          updatedAt: sop.updatedAt,
          sections: sop.sections.map((s) => ({
            id: s.id,
            title: s.title,
            chars: String(s.body || '').length,
            builtin: Boolean(s.builtin),
            disabled: Boolean(s.disabled),
          })),
          lessonCount: sop.lessons.length,
          pendingCount: sop.pending.length,
          lessons: sop.lessons.map((l) => ({ id: l.id, text: l.text, hits: l.hits || 0, at: l.at, source: l.source })),
          pending: sop.pending.map((x) => ({ id: x.id, at: x.at, kind: x.kind, text: x.text })),
          maxChars: SOP_MAX_CHARS,
        }
        if (op === 'show') {
          const rendered = sopText(state)
          out.chars = rendered.length
          out.text = rendered
        }
        return out
      }

      if (op === 'get') {
        const sec = sop.sections.find((s) => s.id === args.id)
        if (!sec) return { ok: false, error: `没有这一节：${args.id}（先 op=list 看 id）` }
        return { ok: true, id: sec.id, title: sec.title, body: sec.body, builtin: Boolean(sec.builtin) }
      }

      if (op === 'set') {
        if (!args.id) return { ok: false, error: 'set 需要 id' }
        if (args.text === undefined || args.text === null) return { ok: false, error: 'set 需要 text' }
        const sec = sop.sections.find((s) => s.id === args.id)
        if (!sec) return { ok: false, error: `没有这一节：${args.id}（先 op=list 看 id）` }
        sec.body = String(args.text)
        sec.updatedAt = at
        sop.updatedAt = at
        return { ok: true, id: sec.id, title: sec.title, chars: sec.body.length }
      }

      if (op === 'add') {
        const title = String(args.title || '').trim()
        if (!title) return { ok: false, error: 'add 需要 title' }
        const id = String(args.id || 'custom-' + Date.now().toString(36)).trim()
        if (sop.sections.some((s) => s.id === id)) return { ok: false, error: `id 已存在：${id}` }
        sop.sections.push({ id, title, body: String(args.text || ''), builtin: false, createdAt: at, updatedAt: at })
        sop.updatedAt = at
        return { ok: true, id, title }
      }

      if (op === 'remove') {
        const i = sop.sections.findIndex((s) => s.id === args.id)
        if (i < 0) return { ok: false, error: `没有这一节：${args.id}` }
        const removed = sop.sections.splice(i, 1)[0]
        sop.updatedAt = at
        return { ok: true, removed: removed.id, title: removed.title }
      }

      if (op === 'reset') {
        const def = defaultSop()
        if (args.id) {
          const d = def.sections.find((s) => s.id === args.id)
          if (!d) return { ok: false, error: `内置节里没有：${args.id}` }
          const i = sop.sections.findIndex((s) => s.id === args.id)
          if (i >= 0) sop.sections[i] = d
          else sop.sections.push(d)
          sop.updatedAt = at
          return { ok: true, reset: args.id }
        }
        state.sop = def
        return { ok: true, reset: 'all' }
      }

      if (op === 'learn') {
        const text = String(args.text || '').trim()
        if (!text) return { ok: false, error: 'learn 需要 text：一句话教训，越具体越有用' }
        const dup = sop.lessons.find((l) => l.text === text)
        if (dup) {
          dup.hits = (dup.hits || 0) + 1
          dup.lastHitAt = at
          return { ok: true, id: dup.id, hits: dup.hits, deduped: true }
        }
        const item = { id: 'L' + Date.now().toString(36), text, at, hits: 0, source: String(args.source || 'manual') }
        sop.lessons.push(item)
        sop.updatedAt = at
        return { ok: true, id: item.id, total: sop.lessons.length }
      }

      if (op === 'lessons') {
        return {
          ok: true,
          count: sop.lessons.length,
          lessons: sop.lessons.map((l) => ({ id: l.id, text: l.text, hits: l.hits || 0, at: l.at, source: l.source })),
        }
      }

      if (op === 'unlearn') {
        const i = sop.lessons.findIndex((l) => l.id === args.id)
        if (i < 0) return { ok: false, error: `没有这条教训：${args.id}` }
        sop.lessons.splice(i, 1)
        sop.updatedAt = at
        return { ok: true, removed: args.id }
      }

      if (op === 'pending') {
        return {
          ok: true,
          count: sop.pending.length,
          pending: sop.pending.map((x) => ({ id: x.id, at: x.at, kind: x.kind, text: x.text })),
        }
      }

      if (op === 'accept') {
        const i = sop.pending.findIndex((x) => x.id === args.id)
        if (i < 0) return { ok: false, error: `没有这条待审：${args.id}` }
        const p = sop.pending.splice(i, 1)[0]
        const text = String(args.text || p.text || '').trim()
        const dup = sop.lessons.find((l) => l.text === text)
        if (dup) {
          dup.hits = (dup.hits || 0) + 1
          dup.lastHitAt = at
          sop.updatedAt = at
          return { ok: true, lessonId: dup.id, deduped: true }
        }
        const item = { id: 'L' + Date.now().toString(36), text, at, hits: 0, source: 'auto' }
        sop.lessons.push(item)
        sop.updatedAt = at
        return { ok: true, lessonId: item.id, total: sop.lessons.length }
      }

      if (op === 'drop') {
        const i = sop.pending.findIndex((x) => x.id === args.id)
        if (i < 0) return { ok: false, error: `没有这条待审：${args.id}` }
        sop.pending.splice(i, 1)
        sop.updatedAt = at
        return { ok: true, dropped: args.id }
      }

      return {
        ok: false,
        error: `未知 op：${op}（可用 show/list/get/set/add/remove/reset/learn/lessons/unlearn/pending/accept/drop）`,
      }
    })
  }
  // ============ v2.4 sweep：拿界面采集的名单反查台账 ============
  // 一次调用直接回答：谁没入账 / 谁轮到我回 / 我发了等对方 / 已终结
  if (action === 'sweep') {
    let rows = args.batch
    if (typeof rows === 'string') {
      try { rows = JSON.parse(rows) } catch (e) { return { ok: false, error: 'batch 不是合法 JSON' } }
    }
    if (!Array.isArray(rows) || !rows.length) {
      return { ok: false, error: 'sweep 需要 batch=[{name,preview}]（从界面采集的会话列表）' }
    }
    return readState((state) => {
      const TERMINAL = ['rejected', 'stale', 'hired']
      const best = new Map()
      Object.keys(state.candidates).forEach((k) => {
        const c = state.candidates[k]
        if (!c || c.jobId !== jobId) return
        const cur = best.get(c.name)
        if (!cur || (c.seq || 0) > (cur.seq || 0)) best.set(c.name, c)
      })
      const missing = []
      const waitingMe = []
      let waitingThem = 0
      let terminal = 0
      rows.forEach((r) => {
        const name = String((r && r.name) || '').trim()
        if (!name) return
        const preview = String((r && r.preview) || '').trim()
        const c = best.get(name)
        if (!c) { missing.push(name); return }
        if (TERMINAL.includes(c.stage)) { terminal += 1; return }
        if (/^\[(已读|送达)\]/.test(preview)) { waitingThem += 1; return }
        const item = { name, seq: c.seq, stage: c.stage }
        if (preview) item.say = preview.slice(0, 30)
        waitingMe.push(item)
      })
      const out = {
        ok: true,
        jobId,
        scanned: rows.length,
        hitEnd: args.hitEnd !== false,
        missing,
        waitingMe,
        waitingThem,
        terminal,
      }
      if (args.hitEnd === false) {
        out.warning = '未确认滚到底：本轮不得视为完成，必须继续下滚直到出现「没有更多了」'
      }
      return out
    })
  }


  if (action === 'check') {
    const key = dedupKeyOf(args.name, args.company)
    if (!key) return { ok: false, error: '缺少姓名' }
    return readState((state) => {
      const seenView = state.views[key] || null
      const cand = Object.values(state.candidates).find(
        (x) => x.jobId === jobId && dedupKeyOf(x.name, x.company) === key,
      )
      const greeted = Boolean(cand && cand.greetedAt)
      return {
        ok: true,
        dedupKey: key,
        viewed: Boolean(seenView || cand),
        greeted,
        stage: cand ? cand.stage : null,
        stageLabel: cand ? STAGE_LABEL[cand.stage] || cand.stage : null,
        verdict: seenView ? seenView.verdict : null,
        advice: greeted
          ? '已招呼过 → 跳过，不要重复打招呼'
          : cand
            ? `已在台账（${STAGE_LABEL[cand.stage] || cand.stage}）→ 不重复查看`
            : seenView
              ? `看过了（${seenView.verdict}）→ 跳过`
              : '没看过 → 可以评估',
      }
    })
  }

  // v2.23.0：看过即入账——只要看过这个人，就必须在台账里有一行，
  // 之后用 screen / upsert / log 在这同一行上增量补信息（学历、年限、联系方式、沟通记录）。
  if (action === 'view') {
    const key = dedupKeyOf(args.name, args.company)
    if (!key) return { ok: false, error: '缺少姓名' }
    return withState((state) => {
      const verdict = String(args.note || args.value || args.summary || '已查看')
      state.views = state.views || {}
      state.views[key] = {
        name: args.name || '',
        company: args.company || '',
        jobId,
        verdict,
        at: nowISO(),
      }
      const { job } = resolveJob(state, jobId)
      const bossId = args.bossId || `${String(args.name || '').trim()}|${String(args.company || '-').trim()}`
      state.candidates = state.candidates || {}
      const ckey = candKey(jobId, bossId)
      let cand = state.candidates[ckey]
      let created = false
      if (!cand) {
        job.seqCounter = (Number(job.seqCounter) || 0) + 1
        cand = migrateCandidate({
          name: args.name || '',
          company: args.company || '',
          stage: 'new',
          note: '',
          firstSeenAt: nowISO(),
        }, jobId, bossId)
        cand.seq = job.seqCounter
        state.candidates[ckey] = cand
        created = true
      }
      cand.lastViewAt = nowISO()
      cand.viewCount = (Number(cand.viewCount) || 0) + 1
      if (args.sourceTab !== undefined) cand.sourceTab = String(args.sourceTab || '')
      if (args.preview !== undefined) cand.preview = String(args.preview || '').slice(0, 300)
      const tag = `看过：${verdict}`
      if (!String(cand.note || '').includes(verdict)) {
        cand.note = [String(cand.note || '').trim(), tag].filter(Boolean).join('；')
      }
      cand.updatedAt = nowISO()
      return {
        ok: true,
        dedupKey: key,
        totalViews: Object.keys(state.views).length,
        bossId,
        seq: cand.seq,
        created,
        stage: cand.stage,
        note: cand.note,
      }
    })
  }

  if (action === 'stats') {
    return readState((state) => {
      // v2.2：默认只统计当前岗位；仅 filterJob=all 时跨岗位汇总
      const scopeAll = args.filterJob === 'all'
      const targetJob = scopeAll ? 'all' : (args.filterJob && args.filterJob !== 'all' ? args.filterJob : jobId)
      const job = scopeAll ? null : state.jobs[targetJob] || null
      const stats = statsOf(state, targetJob)
      return {
        ok: true,
        jobId: targetJob,
        job: scopeAll ? '全部岗位' : (job ? job.name : ''),
        scope: scopeAll ? 'all' : 'job',
        ...stats,
        quota: {
          target: job ? job.criteria.greetQuotaPerDay : 0,
          done: scopeAll ? 0 : ((counterPeek(state, targetJob, today) || {}).greets || 0),
        },
      }
    })
  }

  if (action === 'pace') {
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const c = job.criteria
      const todayCount = counterFor(state, jobId, today)
      const now = Date.now()
      const dailyDone = todayCount.greets
      const dailyTarget = c.greetQuotaPerDay
      const roundTarget = c.roundGreetSize || 15
      const browseTarget = c.browseBeforeGreetMin || 1
      const browseDone = todayCount.browses

      const progress = {
        daily: { done: dailyDone, target: dailyTarget, remain: Math.max(0, dailyTarget - dailyDone) },
        round: {
          done: todayCount.roundGreets,
          target: roundTarget,
          remain: Math.max(0, roundTarget - todayCount.roundGreets),
          index: todayCount.roundsCompleted + 1,
        },
        browse: { done: browseDone, target: browseTarget, remain: Math.max(0, browseTarget - browseDone) },
        roundsCompleted: todayCount.roundsCompleted,
        restUntil: todayCount.restUntil,
      }

      const restLeft = todayCount.restUntil
        ? Math.ceil((new Date(todayCount.restUntil).getTime() - now) / 1000)
        : 0
      const elapsed = todayCount.lastGreetAt
        ? (now - new Date(todayCount.lastGreetAt).getTime()) / 1000
        : Infinity

      let step
      let waitSec = 0

      if (state.mode === 'reply') {
        step = '「回话模式」：只进「沟通」处理回话；每条发之前先 checkReply 过边界，不要进推荐牛人打招呼'
      } else if (restLeft > 0) {
        step = `第 ${todayCount.roundsCompleted} 轮已结束，休息中（防风控）`
        waitSec = restLeft
      } else if (todayCount.restUntil && restLeft <= 0) {
        todayCount.restUntil = null
        step = `休息结束，可以开始第 ${todayCount.roundsCompleted + 1} 轮`
      } else if (dailyDone >= dailyTarget) {
        step = '今日额度已打满，收工，明天再跑'
      } else if (todayCount.roundGreets >= roundTarget) {
        const span = Math.max(0, (c.roundRestMaxSec || 1800) - (c.roundRestMinSec || 600))
        const rest = (c.roundRestMinSec || 600) + Math.round(Math.random() * span)
        todayCount.roundGreets = 0
        todayCount.roundsCompleted += 1
        todayCount.restUntil = new Date(now + rest * 1000).toISOString()
        step = `本轮 ${roundTarget} 条已打满，休息 ${Math.round(rest / 60)} 分钟后开下一轮`
        waitSec = rest
        progress.round.done = 0
        progress.round.remain = roundTarget
        progress.roundsCompleted = todayCount.roundsCompleted
        progress.restUntil = todayCount.restUntil
      } else if (browseDone < browseTarget) {
        step = `先浏览牛人卡片再打招呼（本轮还差 ${browseTarget - browseDone} 张）`
        waitSec = c.browseDwellMinSec || 15
      } else if (elapsed < (c.greetMinGapSec == null ? 300 : Number(c.greetMinGapSec))) {
        step = '还没到点，继续浏览别的简历'
        waitSec = Math.ceil((c.greetMinGapSec == null ? 300 : Number(c.greetMinGapSec)) - elapsed)
      } else {
        step = '可以发下一条招呼了'
      }

      return {
        ok: true,
        mode: state.mode,
        jobId,
        job: job.name,
        date: today,
        quota: dailyTarget,
        greeted: dailyDone,
        remaining: progress.daily.remain,
        browses: browseDone,
        lastGreetAt: todayCount.lastGreetAt,
        progress,
        step,
        waitSec,
        humanize: humanizeOf(c),
        gap: { minSec: c.greetMinGapSec || 300, maxSec: c.greetMaxGapSec || 720 },
        dwell: { minSec: c.browseDwellMinSec || 15, maxSec: c.browseDwellMaxSec || 60 },
        nextAction:
          waitSec > 0
            ? `先不动，等 ${waitSec} 秒（期间可以点开 1 张卡的在线简历看，但不要发招呼）`
            : '可发这一条：点开 1 张卡在线简历读完 → 判定匹配 → 点「打招呼」（落点随机偏移 ±15px，不要总打同一像素）→ 立刻 markGreet 1 → 回 pace 查下一次间隔',
        hint: waitSec > 0 ? `等待 ${waitSec} 秒（约 ${Math.max(1, Math.round(waitSec / 60))} 分钟）后再动手` : '立即执行',
      }
    })
  }

  if (action === 'completeGreet') {
    const bossId = args.bossId || (args.name ? `${args.name}|${args.company || '-'}` : '')
    if (!bossId) return { ok: false, error: 'completeGreet 需要 name + company（或 bossId）' }
    return withState((state) => {
      if (state.mode === 'reply') return { ok: false, error: '回话模式不记录打招呼；先 mode(recruit)' }
      const paceError = greetPaceError(state, jobId, today, Date.now())
      if (paceError) return { ok: false, error: paceError }
      const gate = requireScreenForGreet(state, jobId, { ...args, bossId })
      if (gate) return { ok: false, error: gate }
      const key = candKey(jobId, bossId)
      const prev = state.candidates[key] || {}
      const at = nowISO()
      if (prev.greetedAt) {
        return { ok: true, jobId, seq: prev.seq || null, bossId, stage: 'greeted', greetedAt: prev.greetedAt, duplicate: true, persisted: true }
      }
      const cand = {
        ...prev,
        jobId,
        bossId,
        name: args.name ?? prev.name ?? '',
        company: args.company ?? prev.company ?? '',
        stage: 'greeted',
        greetedAt: prev.greetedAt || at,
        updatedAt: at,
      }
      state.candidates[key] = cand
      const count = counterFor(state, jobId, today)
      count.greets += 1
      count.roundGreets += 1
      count.lastGreetAt = at
      count.browses = 0
      const c = state.jobs[jobId].criteria
      const span = Math.max(0, (c.greetMaxGapSec || 720) - (c.greetMinGapSec == null ? 300 : Number(c.greetMinGapSec)))
      const nextWaitSec = (c.greetMinGapSec == null ? 300 : Number(c.greetMinGapSec)) + Math.round(Math.random() * span)
      const viewKey = dedupKeyOf(cand.name, cand.company)
      if (viewKey) state.views[viewKey] = { name: cand.name, company: cand.company, jobId, verdict: '已招呼', at }
      return { ok: true, jobId, seq: cand.seq || null, bossId, stage: 'greeted', greeted: count.greets, nextWaitSec, persisted: true }
    })
  }

  if (action === 'markGreet') {
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const c = job.criteria
      const todayCount = counterFor(state, jobId, today)
      const requested = Math.floor(Number(args.count) || 1)
      if (requested > 1) {
        return {
          ok: false,
          error:
            `markGreet 一次只能记 1 条（收到 ${requested}）。必须打完一条立刻 markGreet 1，不允许事后批量补记。` +
            `2026-10-21 web 端被限制 24h 的直接原因就是一口气打完 8 条再补记，pace 的间隔与浏览闸门全部失效。` +
            `正确顺序：pace → 点开 1 张在线简历 + markBrowse 1 → 打 1 条 → markGreet 1 → pace。`,
        }
      }
      const times = 1
      if (state.mode === 'reply') return { ok: false, error: '回话模式不记录打招呼；先 mode(recruit)' }
      const paceError = greetPaceError(state, jobId, today, Date.now())
      if (paceError) return { ok: false, error: paceError }
      // v2.10.0：必须先有 screen（看过在线简历）才能记招呼
      const greetGate = requireScreenForGreet(state, jobId, args)
      if (greetGate) return { ok: false, error: greetGate }
      const gapBefore = todayCount.lastGreetAt
        ? (Date.now() - new Date(todayCount.lastGreetAt).getTime()) / 1000
        : Infinity
      const minGap = c.greetMinGapSec == null ? 300 : Number(c.greetMinGapSec)
      const tooFast = gapBefore < minGap
      const span = Math.max(0, (c.greetMaxGapSec || 720) - minGap)
      const nextWaitSec = minGap + Math.round(Math.random() * span)
      todayCount.greets += times
      todayCount.roundGreets += times
      todayCount.lastGreetAt = nowISO()
      todayCount.browses = 0
      const roundTarget = c.roundGreetSize || 15
      const result = {
        ok: true,
        jobId,
        date: today,
        greeted: todayCount.greets,
        remaining: Math.max(0, c.greetQuotaPerDay - todayCount.greets),
        nextWaitSec,
        progress: {
          daily: { done: todayCount.greets, target: c.greetQuotaPerDay },
          round: {
            done: todayCount.roundGreets,
            target: roundTarget,
            remain: Math.max(0, roundTarget - todayCount.roundGreets),
            index: todayCount.roundsCompleted + 1,
          },
        },
      }
      if (tooFast) {
        result.pacingWarning =
          `节奏过快：距上一条仅 ${Math.round(gapBefore)} 秒，低于 ${minGap} 秒下限，接下来必须补更长的间隔`
      }
      return result
    })
  }

  if (action === 'markBrowse') {
    return withState((state) => {
      const todayCount = counterFor(state, jobId, today)
      todayCount.browses += Math.max(1, Math.floor(Number(args.count) || 1))
      todayCount.lastBrowseAt = nowISO()
      return { ok: true, jobId, date: today, browses: todayCount.browses }
    })
  }

  if (action === 'seen') {
    if (!args.bossId) return { ok: false, error: '缺少 bossId' }
    return readState((state) => {
      const hit = state.candidates[candKey(jobId, args.bossId)]
      return {
        ok: true,
        jobId,
        seen: Boolean(hit),
        stage: hit ? hit.stage : null,
        candidate: hit ? decorate(hit) : null,
      }
    })
  }

  if (action === 'evaluate') {
    return readState((state) => {
      const { job } = resolveJob(state, jobId)
      const key = args.bossId || args.name
      const stored = key ? state.candidates[candKey(jobId, key)] : null
      const probe = {
        ...(stored || {}),
        ...(args.name ? { name: args.name } : {}),
        ...(args.edu !== undefined ? { edu: args.edu } : {}),
        ...(args.gradYear !== undefined ? { gradYear: args.gradYear } : {}),
        ...(args.workYears !== undefined ? { workYears: args.workYears } : {}),
        ...(args.xuexinSelf !== undefined ? { xuexinSelf: args.xuexinSelf } : {}),
        ...(args.skills !== undefined ? { skills: args.skills } : {}),
        ...(args.project !== undefined ? { project: args.project } : {}),
        ...(args.expectSalary !== undefined ? { expectSalary: args.expectSalary } : {}),
        ...(args.expectCity !== undefined ? { expectCity: args.expectCity } : {}),
        ...(args.expectPosition !== undefined ? { expectPosition: args.expectPosition } : {}),
      }
      if (args.expectSalary !== undefined && args.expectSalaryMinK === undefined) {
        probe.expectSalaryMinK = parseSalaryK(args.expectSalary).minK
      }
      if (args.expectSalaryMinK !== undefined) probe.expectSalaryMinK = args.expectSalaryMinK
      const result = evaluate(probe, job.criteria)
      const suggest = suggestFor(job, { ...probe, stage: result.suggestStage })
      return {
        ok: true,
        jobId,
        basedOn: stored ? '台账现有数据 + 传入覆盖' : '仅传入数据',
        ...result,
        suggestText: suggest.text,
      }
    })
  }

  if (action === 'upsert') {
    const bossId = args.bossId || (args.name ? `${args.name}|${args.company || '-'}` : '')
    if (!bossId) return { ok: false, error: '缺少 bossId 或 name' }
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      // v2.10.0：直接写 greeted 也必须先有 screen
      if (args.stage === 'greeted') {
        const g = requireScreenForGreet(state, jobId, { ...args, bossId })
        if (g) return { ok: false, error: g }
      }
      // v2.26.0：沟通页独有的阶段（resume_* / interview_*）必须先切 reply 模式 + 声明 chatScope。
      // 这道门禁的作用不是「多一步」，是让「在推荐页顺手把沟通页状态推了」这条捷径消失。
      if (args.stage) {
        const ctxErr = requireChatContext(state, job, jobId, args.stage)
        if (ctxErr) return { ok: false, error: ctxErr }
      }
      const c = job.criteria
      if (args.stage === 'greeted' && !state.candidates[candKey(jobId, bossId)]) {
        if (state.mode === 'reply') return { ok: false, error: '回话模式不记录打招呼；先 mode(recruit)' }
        const paceError = greetPaceError(state, jobId, today, Date.now())
        if (paceError) return { ok: false, error: paceError }
      }
      let key = candKey(jobId, bossId)
      // v2.18.0：同一岗位内按「手机号 / 姓名+最近两家公司」判重，命中就并到老记录，不再新建
      if (args.force !== true) {
        const dup = findDuplicate(state, jobId, {
          bossId,
          name: args.name,
          company: args.company,
          company2: args.company2,
          phone: args.phone,
        })
        if (dup) key = dup.key
      }
      const prev = state.candidates[key] || {}
      const now = nowISO()
      const expectSalary = args.expectSalary ?? prev.expectSalary ?? ''
      const parsedSalary = parseSalaryK(expectSalary)
      const next = {
        ...prev,
        jobId,
        bossId,
        name: args.name ?? prev.name ?? '',
        edu: args.edu ?? prev.edu ?? '',
        gradYear: args.gradYear ?? prev.gradYear ?? null,
        xuexinSelf: args.xuexinSelf ?? prev.xuexinSelf ?? '未说',
        xuexinVerify: args.xuexinVerify ?? prev.xuexinVerify ?? 'pending',
        workYears: args.workYears ?? prev.workYears ?? null,
        company: args.company ?? prev.company ?? '',
        skills: args.skills ?? prev.skills ?? [],
        project: args.project ?? prev.project ?? '',
        expectSalary,
        expectSalaryMinK: args.expectSalaryMinK ?? prev.expectSalaryMinK ?? parsedSalary.minK,
        expectCity: args.expectCity ?? prev.expectCity ?? '',
        expectPosition: args.expectPosition ?? prev.expectPosition ?? '',
        phone: args.phone ?? prev.phone ?? '',
        company2: args.company2 ?? prev.company2 ?? '',
        // v2.19.0：面试信息落表（导出直接可用）
        interviewTime: args.interviewTime ?? prev.interviewTime ?? '',
        interviewWindow: args.interviewWindow ?? prev.interviewWindow ?? '',
        interviewLocation: args.interviewLocation ?? prev.interviewLocation ?? '',
        interviewMode: args.interviewMode ?? prev.interviewMode ?? '',
        interviewContact: args.interviewContact ?? prev.interviewContact ?? '',
        interviewPhone: args.interviewPhone ?? prev.interviewPhone ?? '',
        email: args.email ?? prev.email ?? '',
        school: args.school ?? prev.school ?? '',
        stage: args.stage ?? prev.stage ?? 'new',
        starred: args.starred ?? prev.starred ?? false,
        rejectReason: args.rejectReason ?? prev.rejectReason ?? '',
        matchGaps: prev.matchGaps || [],
        matchHits: prev.matchHits || [],
        note: args.note ?? prev.note ?? '',
        keyInfo: prev.keyInfo || '',
        dialogLog: prev.dialogLog || [],
        firstSeenAt: prev.firstSeenAt || now,
        greetedAt: prev.greetedAt || '',
        repliedAt: prev.repliedAt || '',
        resumeAt: prev.resumeAt || '',
        interviewAt: prev.interviewAt || '',
        updatedAt: now,
      }
      // 序号：首次登记时分配，之后固定不变
      if (!next.seq) {
        job.seqCounter = (Number(job.seqCounter) || 0) + 1
        next.seq = job.seqCounter
      }
      if (next.stage === 'greeted' && !next.greetedAt) next.greetedAt = now
      if (['inbound', 'qualified', 'resume_requested', 'resume_received', 'interview_pending', 'interview_available', 'interview_scheduled'].includes(next.stage) && !next.repliedAt) {
        next.repliedAt = now
      }
      if (args.noReply !== undefined) next.noReply = Boolean(args.noReply)
      if (['resume_received', 'interview_pending', 'interview_available', 'interview_scheduled'].includes(next.stage) && !next.resumeAt) {
        next.resumeAt = now
      }
      if (['interview_available', 'interview_scheduled'].includes(next.stage) && !next.interviewAt) {
        next.interviewAt = now
      }

      const evaluation = evaluate(next, c)
      next.matchGaps = evaluation.gaps
      next.matchHits = evaluation.hits
      // v2.1：派生评分随 upsert 一并落库（整数或 null，绝不写 NaN/undefined）
      next.techFitScore = evaluation.techFit.score
      next.techFitGrade = evaluation.techFit.grade
      next.techFitHits = evaluation.techFit.hits
      next.techFitGaps = evaluation.techFit.gaps
      next.valueScore = evaluation.value.score
      next.valueGrade = evaluation.value.grade
      next.valueCostRatio = evaluation.value.costRatio
      next.valueBudgetMidK = evaluation.value.budgetMidK
      if (evaluation.suggestStage === 'rejected' && evaluation.rejectReason && !next.rejectReason) {
        next.rejectReason = evaluation.rejectReason
      }
      if (evaluation.starWorthy && !next.starred) next.starred = true

      state.candidates[key] = next
      // 同步去重登记，下次看到同一个人直接跳过
      const viewKey = dedupKeyOf(next.name, next.company)
      if (viewKey) {
        state.views[viewKey] = {
          name: next.name,
          company: next.company,
          jobId,
          verdict: next.greetedAt ? '已招呼' : `台账:${next.stage}`,
          at: now,
        }
      }

      const suggest = suggestFor(job, next)
      const clarify = clarifyState(next)
      // v2.4 默认只回精简结果；要全量档案用 verbose=true
      if (!args.verbose) {
        const brief = compactResult(next, { gaps: evaluation.gaps, suggest: suggest.text || '' })
        if (suggest.key) brief.suggestKey = suggest.key
        if (clarify.needed) {
          brief.needsClarify = true
          brief.clarifyText = templateOf(job, 'clarify') || ''
        }
        return brief
      }
      return {
        ok: true,
        jobId,
        candidate: decorate(next),
        evaluation,
        suggestStage: evaluation.suggestStage,
        suggestKey: suggest.key,
        suggest: suggest.text || null,
        needsClarify: clarify.needed,
        clarifyText: clarify.needed ? templateOf(job, 'clarify') : null,
      }
    })
  }

  if (action === 'log') {
    const bossId = args.bossId || (args.name ? `${args.name}|${args.company || '-'}` : '')
    if (!bossId) return { ok: false, error: '缺少 bossId' }
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      // v2.10.0：回话前必须先声明沟通页的岗位作用域
      const scopeErr = requireChatScope(state, job, jobId)
      if (scopeErr) return { ok: false, error: scopeErr }
      const key = candKey(jobId, bossId)
      const cand = state.candidates[key]
      if (!cand) return { ok: false, error: `当前岗位台账里没有 ${bossId}，先 upsert` }
      const at = nowISO()
      const dir = args.dir === 'out' ? 'out' : 'in'
      // v2.16.0：要回话（dir=out）之前，必须点开过这个人的在线简历并 screen 登记过
      if (dir === 'out' && args.force !== true) {
        const sc = findScreen(state, jobId, bossId, true)
        if (!sc) {
          return {
            ok: false,
            error: `还没看过 ${args.name || bossId} 的在线简历，不能直接回话。先在沟通页点他的「在线简历」，按 readPlan 逐步往下滑看完，再调 screen(name, company, resumeRead=true, projects="简历原文", decision="greet")，然后才回。`,
          }
        }
      }
      const entry = {
        at,
        dir,
        text: String(args.text || '').trim(),
        summary: String(args.summary || '').trim(),
      }
      cand.dialogLog = cand.dialogLog || []
      cand.dialogLog.push(entry)
      if (entry.summary) cand.keyInfo = entry.summary
      if (dir === 'in' && !cand.repliedAt) cand.repliedAt = at
      cand.updatedAt = at
      if (args.stage) {
        cand.stage = args.stage
        if (args.stage === 'greeted' && !cand.greetedAt) cand.greetedAt = at
        if (['resume_received', 'interview_pending', 'interview_available', 'interview_scheduled'].includes(args.stage) && !cand.resumeAt) cand.resumeAt = at
        if (['interview_available', 'interview_scheduled'].includes(args.stage) && !cand.interviewAt) cand.interviewAt = at
      }
      const evaluation = evaluate(cand, job.criteria)
      cand.matchGaps = evaluation.gaps
      cand.matchHits = evaluation.hits
      // v2.1：派生评分同步刷新（纯函数，重算不会漂移）
      cand.techFitScore = evaluation.techFit.score
      cand.techFitGrade = evaluation.techFit.grade
      cand.techFitHits = evaluation.techFit.hits
      cand.techFitGaps = evaluation.techFit.gaps
      cand.valueScore = evaluation.value.score
      cand.valueGrade = evaluation.value.grade
      cand.valueCostRatio = evaluation.value.costRatio
      cand.valueBudgetMidK = evaluation.value.budgetMidK
      const suggest = suggestFor(job, cand)
      // v2.4 默认只回精简结果；要全量档案用 verbose=true
      if (!args.verbose) {
        return compactResult(cand, {
          gaps: evaluation.gaps,
          suggest: suggest.text || '',
          logCount: cand.dialogLog.length,
        })
      }
      return {
        ok: true,
        jobId,
        candidate: decorate(cand),
        logCount: cand.dialogLog.length,
        evaluation,
        suggestStage: evaluation.suggestStage,
        suggest: suggest.text || null,
      }
    })
  }

  if (action === 'star') {
    const bossId = args.bossId || (args.name ? `${args.name}|${args.company || '-'}` : '')
    if (!bossId) return { ok: false, error: '缺少 bossId' }
    return withState((state) => {
      const key = candKey(jobId, bossId)
      const cand = state.candidates[key]
      if (!cand) return { ok: false, error: `当前岗位台账里没有 ${bossId}` }
      cand.starred = args.starred !== undefined ? Boolean(args.starred) : !cand.starred
      cand.updatedAt = nowISO()
      const reason = String(args.note || args.summary || '').trim()
      if (reason) cand.note = cand.note ? `${cand.note}\n⭐${reason}` : `⭐${reason}`
      if (!args.verbose) {
        const r = compactResult(cand)
        r.starred = cand.starred
        return r
      }
      return { ok: true, jobId, starred: cand.starred, candidate: decorate(cand) }
    })
  }

  if (action === 'reject') {
    const bossId = args.bossId || (args.name ? `${args.name}|${args.company || '-'}` : '')
    if (!bossId) return { ok: false, error: '缺少 bossId' }
    const reason = String(args.rejectReason || '').trim()
    if (reason && !Object.keys(REJECT_REASON_LABEL).includes(reason)) {
      return { ok: false, error: `rejectReason 只能是 ${Object.keys(REJECT_REASON_LABEL).join(' / ')}` }
    }
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const key = candKey(jobId, bossId)
      const cand = state.candidates[key]
      if (!cand) return { ok: false, error: `当前岗位台账里没有 ${bossId}` }
      cand.stage = 'rejected'
      cand.rejectReason = reason || 'other'
      cand.updatedAt = nowISO()
      const note = String(args.note || args.summary || '').trim()
      if (note) cand.note = cand.note ? `${cand.note}\n淘汰：${note}` : `淘汰：${note}`
      // v2.6 自动沉淀钩子：归为「其他」淘汰 = 现有口径没覆盖这类情况，先记待审观察（不直接改规则）
      if (cand.rejectReason === 'other') {
        try {
          const sop = ensureSop(state)
          const obs = `${cand.name}（${cand.company || '-'}）按「其他」原因淘汰：${note || '未写具体原因'} —— 可能说明口径缺了一类情况。`
          if (!sop.pending.some((x) => x.text === obs)) {
            sop.pending.push({ id: 'P' + Date.now().toString(36), at: nowISO(), kind: 'reject_other', text: obs })
          }
        } catch (e) {
          // 沉淀失败不能影响淘汰本身
        }
      }
      if (!args.verbose) return compactResult(cand)
      return {
        ok: true,
        jobId,
        stage: cand.stage,
        rejectReason: cand.rejectReason,
        rejectReasonLabel: REJECT_REASON_LABEL[cand.rejectReason],
        candidate: decorate(cand),
        job: job.name,
      }
    })
  }

  if (action === 'list') {
    return readState((state) => {
      // v2.2：不传 jobId / filterJob 时，严格只返回当前岗位的人，绝不混其他岗位
      const scopeAll = args.filterJob === 'all'
      const targetJob = scopeAll
        ? 'all'
        : (args.filterJob && args.filterJob !== 'all' ? args.filterJob : jobId)
      const job = scopeAll ? null : state.jobs[targetJob] || null
      let items = Object.values(state.candidates)
        .filter((x) => (scopeAll ? true : x.jobId === targetJob))
      if (args.filterStage) items = items.filter((x) => x.stage === args.filterStage)
      if (args.filterSalaryMaxK != null) {
        items = items.filter((x) => x.expectSalaryMinK == null || Number(x.expectSalaryMinK) <= Number(args.filterSalaryMaxK))
      }
      if (args.filterEdu) items = items.filter((x) => String(x.edu || '').includes(String(args.filterEdu)))
      if (args.filterCity) items = items.filter((x) => String(x.expectCity || '').includes(String(args.filterCity)))
      if (args.filterXuexin) items = items.filter((x) => (args.filterXuexin === '待核验' ? x.xuexinVerify === 'pending' : x.xuexinSelf === args.filterXuexin))
      // v2.1：匹配度下限 / 性价比等级筛选（NA 单独成档）
      if (args.filterTechFitMin != null && args.filterTechFitMin !== '') {
        const min = Number(args.filterTechFitMin)
        if (Number.isFinite(min)) {
          items = items.filter((x) => numOrNull(x.techFitScore) != null && Number(x.techFitScore) >= min)
        }
      }
      if (args.filterValueGrade) {
        const want = String(args.filterValueGrade).toUpperCase()
        items = items.filter((x) => {
          const g = numOrNull(x.valueScore) == null ? 'NA' : gradeMetaOf(VALUE_GRADES, x.valueScore).grade
          return g === want
        })
      }
      if (args.q) {
        const q = String(args.q).toLowerCase()
        items = items.filter((x) =>
          `${x.name} ${x.company} ${(x.skills || []).join(' ')} ${x.note} ${x.keyInfo}`.toLowerCase().includes(q))
      }
      items = sortCands(items, args.sort || 'seq', args.order || 'asc')
      const stats = statsOf(state, targetJob)
      return {
        ok: true,
        jobId: targetJob,
        job: scopeAll ? '全部岗位' : (job ? job.name : ''),
        scope: scopeAll ? 'all' : 'job',
        total: items.length,
        byStage: stats.byStage,
        starred: stats.starred,
        // filterJob=all 时每行多带 jobName，面板据此多渲染一列「岗位」
        items: items.map((x) => ({
          ...decorate(x),
          jobName: (state.jobs[x.jobId] || {}).name || '',
        })),
      }
    })
  }

  if (action === 'next') {
    return withState((state) => {
      // v2.2：默认只看当前岗位；filterJob=all 时才跨岗位排队
      const scopeAll = args.filterJob === 'all'
      const targetJob = scopeAll
        ? 'all'
        : (args.filterJob && args.filterJob !== 'all' ? args.filterJob : jobId)
      const job = scopeAll ? null : state.jobs[targetJob] || null
      const c = (job && job.criteria) || {}
      const todayCount = scopeAll ? null : counterFor(state, targetJob, today)
      const queue = []
      for (const cand of Object.values(state.candidates)) {
        if (!scopeAll && cand.jobId !== targetJob) continue
        // 岗位已被删除的孤儿候选人不排队（没有口径可判）
        const candJob = state.jobs[cand.jobId]
        if (!candJob) continue
        const step = NEXT_STEP[cand.stage]
        if (!step) continue
        if (['interview_available', 'interview_scheduled', 'rejected', 'stale'].includes(cand.stage)) continue
        const evalResult = evaluate(cand, candJob.criteria)
        const suggest = suggestFor(candJob, cand)
        queue.push({
          ...decorate(cand),
          jobName: candJob.name,
          nextStep: step,
          needsClarify: clarifyState(cand).needed,
          suggestKey: suggest.key,
          suggest: suggest.text || null,
          suggestStage: evalResult.suggestStage,
        })
      }
      queue.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))
      return {
        ok: true,
        jobId: targetJob,
        job: scopeAll ? '全部岗位' : (job ? job.name : ''),
        scope: scopeAll ? 'all' : 'job',
        quota: {
          target: c.greetQuotaPerDay || 0,
          done: todayCount ? todayCount.greets : 0,
          remaining: scopeAll ? 0 : Math.max(0, (c.greetQuotaPerDay || 0) - (todayCount ? todayCount.greets : 0)),
        },
        queue,
      }
    })
  }

  if (action === 'export') {
    return readState((state) => {
      // v2.2：默认只导出当前岗位；filterJob=all 才导出全部
      const scopeAll = args.filterJob === 'all'
      const targetJob = scopeAll
        ? 'all'
        : (args.filterJob && args.filterJob !== 'all' ? args.filterJob : jobId)
      const job = scopeAll ? null : state.jobs[targetJob] || null
      const rows = sortCands(
        Object.values(state.candidates).filter((x) => (scopeAll ? true : x.jobId === targetJob)),
        'seq',
        'asc',
      ).map((x) => ({
        ...decorate(x),
        jobName: (state.jobs[x.jobId] || {}).name || '',
        // v2.27.0：人员状态（7 级）改由这里注入，exportRows 直接读字段，
        // 不再在 export 里二次追加 —— 原先那样会产生「收简历时间」「备注」两列同名的重复列
        status7Label: status7Of(x).status7Label,
      }))
      const format = args.format === 'csv' ? 'csv' : 'markdown'
      const table = exportRows(rows, (job && job.criteria) || {})
      if (format === 'csv') {
        const header = Object.keys(table[0] || { '序号': '' })
        const lines = [header.map(csvCell).join(',')]
        for (const row of table) lines.push(header.map((k) => csvCell(row[k])).join(','))
        return { ok: true, jobId: targetJob, format, count: rows.length, csv: '\ufeff' + lines.join('\n'), note: 'CSV 已带 UTF-8 BOM，Excel/飞书直接双击打开不会乱码' }
      }
      // v2.3：表头末尾追加「备注」，与 CSV 列序保持一致
      const header = '| 序号 | 姓名 | 公司 | 学历 | 毕业年 | 城市 | 年限 | 期望薪资 | 学信网(自述) | 核验 | 状态 | 淘汰原因 | 匹配度分 | 匹配度等级 | 性价比分 | 性价比等级 | 匹配要点 | 更新时间 | 备注 |'
      const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
      const body = rows.map((r) =>
        `| ${r.seq || '-'} | ${r.name || '-'} | ${r.company || '-'} | ${r.edu || '-'} | ${r.gradYear || '-'} | ` +
        `${r.expectCity || '-'} | ${r.workYears == null ? '-' : r.workYears} | ${r.expectSalary || '-'} | ` +
        `${r.xuexinSelf || '-'} | ${r.xuexinVerify || '-'} | ${r.stageLabel} | ${r.rejectReasonLabel || '-'} | ` +
        `${r.techFitScore == null ? '-' : r.techFitScore} | ${r.techFitGrade || '-'} | ` +
        `${r.valueScore == null ? '-' : r.valueScore} | ${r.valueGrade || '-'} | ` +
        `${(r.matchHits || []).join('；') || '-'} | ${r.updatedAtLocal || '-'} | ` +
        `${String(r.note || '').replace(/\|/g, '\\|').replace(/\n/g, ' ') || '-'} |`,
      ).join('\n')
      return {
        ok: true,
        jobId: targetJob,
        format,
        count: rows.length,
        markdown: [`# ${(job && job.criteria.jobTitle) || '全部岗位'} 候选人台账`, '', header, sep, body].join('\n'),
      }
    })
  }

  // v2.8.0：回话发出前的边界校验（只判断，不发消息）
  if (action === 'checkReply') {
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const g = replyGuardOf(job.criteria)
      const text = String(args.text == null ? '' : args.text)
      if (!text.trim()) return { ok: false, error: 'checkReply 需要 text' }
      if (g.enabled === false) {
        return {
          ok: true,
          jobId,
          enabled: false,
          pass: true,
          length: text.length,
          violations: [],
          softWarnings: [],
          advice: '关键词兜底未启用：回话是否越界由提示词里的「回话规则」判断，AI 自己把握。',
        }
      }
      const violations = []
      for (const w of g.forbid) {
        if (w && text.indexOf(w) >= 0) violations.push({ word: w, kind: 'forbid' })
      }
      const softWarnings = []
      for (const w of g.softWarn) {
        if (w && text.indexOf(w) >= 0) softWarnings.push({ word: w, kind: 'soft' })
      }
      const tooLong = text.length > (g.maxChars || 80)
      const pass = violations.length === 0 && !tooLong
      return {
        ok: true,
        jobId,
        enabled: true,
        pass,
        length: text.length,
        maxChars: g.maxChars || 80,
        tooLong,
        violations,
        softWarnings,
        advice: pass
          ? '没有踩边界，可以发'
          : '不能发。去掉触碰边界的说法，只留话术模板里的内容；需要新说法先问人。',
      }
    })
  }

  // v2.10.0：登记「已点开在线简历并读完项目经验」——打招呼的前置条件
  if (action === 'screen') {
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const bossId = args.bossId || (args.name ? `${args.name}|${args.company || '-'}` : '')
      if (!bossId) return { ok: false, error: 'screen 需要 name + company（或 bossId）' }
      if (args.resumeRead !== true) {
        return {
          ok: false,
          error: '不允许只看卡片摘要就打分：先在推荐页点开卡片进入在线简历，看完项目经验再来 screen（resumeRead=true）',
        }
      }
      const projects = String(args.projects || '').trim()
      if (projects.length < 20) {
        return {
          ok: false,
          error: `projects 只有 ${projects.length} 字，太短。把在线简历里读到的项目/职责原文写进来（≥20 字），这是「真看过」的凭据` ,
        }
      }
      const hz = humanizeOf(job.criteria)
      const dwell = (hz.browseDwellSec && hz.browseDwellSec[0]) || 20
      state.screens = Array.isArray(state.screens) ? state.screens : []
      const rec = {
        at: nowISO(),
        jobId,
        bossId,
        name: String(args.name || ''),
        company: String(args.company || ''),
        resumeRead: true,
        projects,
        score: args.score == null || args.score === '' ? null : Number(args.score),
        decision: ['greet', 'skip', 'reject'].includes(args.decision) ? args.decision : 'skip',
        note: String(args.note || ''),
        dwellMinSec: Number(job.criteria.screenMinReadSec) || dwell,
      }
      state.screens.push(rec)
      if (state.screens.length > 800) state.screens = state.screens.slice(-800)
      state.screenIndex = state.screenIndex || {}
      state.screenIndex[bossId] = rec
      const candidateKey = candKey(jobId, bossId)
      const existing = state.candidates[candidateKey] || {}
      const now = nowISO()
      const merged = {
        ...existing,
        jobId,
        bossId,
        name: existing.name || rec.name,
        company: existing.company || rec.company,
        stage: existing.stage || 'new',
        screenedAt: rec.at,
        screenProjects: rec.projects,
        screenDecision: rec.decision,
        updatedAt: now,
      }
      if (!merged.seq) {
        job.seqCounter = (Number(job.seqCounter) || 0) + 1
        merged.seq = job.seqCounter
      }
      state.candidates[candidateKey] = merged
      return {
        ok: true,
        jobId,
        screen: rec,
        next:
          rec.decision === 'greet'
            ? `等满 ${rec.dwellMinSec} 秒后打招呼，打完立刻 markGreet name=${rec.name} company=${rec.company}`
            : `decision=${rec.decision}：按台账记录处理，不要打招呼`,
      }
    })
  }

  // v2.10.0：声明沟通页当前选中的岗位（回话前置条件）
  if (action === 'chatScope') {
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const label = String(args.pageJobLabel || '').trim()
      if (!label) return { ok: false, error: 'chatScope 需要 pageJobLabel：沟通页左上角职位下拉里显示的那个名字' }
      // BOSS 线上职位名和插件里的 jobTitle 常常不同（线上只写「测试工程师」，
      // jobTitle 却带着「（AI / 视频 / 智能体方向）」这种括注）。任一对得上即通过，
      // 否则只能靠子串侥幸命中，线上改个名就直接拒绝。
      const norm = (s) => String(s || '').replace(/[（）()【】\s]/g, '')
      const wantLabels = [job.criteria.jobTitle, job.name].filter(Boolean).map(norm).filter(Boolean)
      const wantText = String(job.criteria.jobTitle || job.name || '')
      const a = norm(label)
      const hit = a && wantLabels.some((b) => a.indexOf(b) >= 0 || b.indexOf(a) >= 0)
      if (!hit) {
        return {
          ok: false,
          error: `沟通页选的是「${label}」，与当前岗位「${wantText}」（${job.name}）不一致。先切岗位筛选，别张冠李戴`,
        }
      }
      state.chatScope = { jobId, label, at: nowISO() }
      return { ok: true, jobId, chatScope: state.chatScope, next: '作用域已确认，可以逐条回话了' }
    })
  }

  // v2.20.0：按沟通页 tab 的真实流转语义，直接给出「这一屏该处理谁、下一步做什么」
  if (action === 'nextInbox') {
    return readState((state) => {
      const { job } = resolveJob(state, jobId)
      const tab = String(args.tab || "newGreet").trim()
      const all = Object.values(state.candidates || {}).filter((c) => c.jobId === jobId)
      const lastDir = (c) => {
        const l = Array.isArray(c.dialogLog) ? c.dialogLog : []
        return l.length ? (l[l.length - 1].dir || "") : ""
      }
      const rows = []
      if (tab === "newGreet") {
        for (const c of all) if ((c.stage === 'new' || c.stage === 'inbound') && (!c.sourceTab || c.sourceTab === 'newGreet')) {
          rows.push({ name: c.name, company: c.company || '', stage: c.stage, status7Label: status7Of(c).status7Label,
            action: 'open_and_screen', why: '还没看过在线简历——先点开、逐步下滑看完，再 screen 登记' })
        }
      } else if (tab === "chatting") {
        for (const c of all) if (['greeted','qualified','resume_requested'].includes(c.stage) && !c.noReply) {
          const d = lastDir(c)
          rows.push({ name: c.name, company: c.company || '', stage: c.stage, status7Label: status7Of(c).status7Label,
            lastSpeaker: d === 'out' ? '我' : d === 'in' ? '对方' : '未知',
            action: d === 'in' ? 'reply' : 'wait',
            why: d === 'in' ? '他最后说话，轮到我回' : d === 'out' ? '我最后说话，等他回，不用动' : '没有对话记录' })
        }
      } else if (tab === "resume") {
        for (const c of all) if (c.stage === 'resume_received') {
          const gap = !c.phone || !c.email || !c.school
          rows.push({ name: c.name, company: c.company || '', stage: c.stage, status7Label: status7Of(c).status7Label,
            action: gap ? 'fill_contact' : 'none',
            why: gap ? '简历已收，但台账缺手机/邮箱/学校——打开附件第1页补齐' : '资料齐全，等人工定面试时间' })
        }
      } else {
        return { ok: false, error: `未知 tab: ${tab}`, valid: ["newGreet", "chatting", "resume"] }
      }
      const nowMs = Date.now()
      const free = rows.filter((r) => {
        const c = all.find((x) => x.name === r.name && (x.company || "") === (r.company || ""))
        const l = c && c.lease
        return !(l && l.until > nowMs)
      })
      const leasedOut = rows.length - free.length
      rows.length = 0
      rows.push(...free)
      const rank = { reply: 0, open_and_screen: 1, fill_contact: 2, none: 9, wait: 9 }
      rows.sort((a, b) => (rank[a.action] ?? 5) - (rank[b.action] ?? 5))
      const need = rows.filter((r) => r.action !== "wait" && r.action !== "none").length
      return {
        ok: true,
        jobId,
        job: job.name,
        tab,
        total: rows.length,
        needAction: need,
        leasedOut,
        queue: rows.slice(0, Math.max(1, Math.min(100, Number(args.limit) || 30))),
        returned: Math.min(rows.length, Math.max(1, Math.min(100, Number(args.limit) || 30))),
        hint: tab === "newGreet"
          ? '新招呼＝主动来信但我们还没看过的人。先用列表预览把明显不符的（应届/1-2年/跨行/外地）批量 reject 掉，只对剩下的点开在线简历。'
          : tab === "chatting"
            ? '沟通中＝我已发过消息的人。只看 action=reply 的（他最后说话）；action=wait 的一律不点开，省时间。'
            : '已获取简历＝已点同意接收的人。优先补 fill_contact 的（缺联系方式），其余等人工定档。',
      }
    })
  }

  if (action === 'observe') {
    const tab = String(args.tab || '').trim()
    if (!['newGreet', 'chatting', 'resume', 'recommend'].includes(tab)) {
      return { ok: false, error: 'observe 需要 tab=newGreet / chatting / resume / recommend' }
    }
    if (!Array.isArray(args.batch)) return { ok: false, error: 'observe 需要 batch=[{name,company,preview,unread,lastSpeaker}]，只记录当前页面事实' }
    if (args.hitEnd === false) return { ok: false, error: '还没确认列表滚到底，不能当作本轮完整队列；继续下滑后再 observe' }
    return withState((state) => {
      if (tab !== 'recommend' && state.mode !== 'reply') return { ok: false, error: '沟通子流程需要先 mode(reply)' }
      if (tab === 'recommend' && state.mode !== 'recruit') return { ok: false, error: '推荐牛人需要先 mode(recruit)' }
      const seenAt = nowISO()
      const items = args.batch.map((r) => ({
        name: String((r && r.name) || '').trim(),
        company: String((r && r.company) || '').trim(),
        preview: String((r && r.preview) || '').slice(0, 300),
        unread: r && r.unread !== false,
        lastSpeaker: r && ['me', 'them', 'unknown'].includes(r.lastSpeaker) ? r.lastSpeaker : 'unknown',
      })).filter((r) => r.name)
      state.inbox[tab] = { jobId, seenAt, items }
      state.flowContext = { jobId, track: tab, at: seenAt }
      const counts = { total: items.length, unread: items.filter((r) => r.unread).length, them: items.filter((r) => r.lastSpeaker === 'them').length }
      return { ok: true, jobId, tab, seenAt, counts, next: tab === 'chatting' ? '只处理候选人最后发言且有新信息的会话；附件要看到后再接收' : tab === 'newGreet' ? '先按预览批量判定，信息不足才打开在线简历' : '按当前子流程处理，不把预览当完整简历' }
    })
  }

  if (action === 'flow') {
    const requested = String(args.track || '').trim()
    return withState((state) => {
      const out = flowOutput(state, jobId, requested)
      if (!out.ok) return out
      if (requested) state.flowContext = { jobId, track: requested, at: nowISO() }
      return out
    })
  }

  if (action === 'backup-export') {
    return readState((state) => ({ ok: true, backup: makeBackup(state) }))
  }

  if (action === 'backup-import') {
    return withState((state) => importBackup(state, args.backup, args.replace === true))
  }

  // v2.22.0：按 stage 批量补字段（用于把历史「已收简历」的接收时间补齐）
  if (action === 'backfill') {
    const stage = String(args.stage || '').trim()
    const field = String(args.field || 'resumeAt').trim()
    const value = args.value == null ? "" : String(args.value)
    if (!stage) return { ok: false, error: 'backfill 需要 stage' }
    if (!['resumeAt', 'interviewAt', 'greetedAt'].includes(field)) {
      return { ok: false, error: `backfill 只支持 resumeAt / interviewAt / greetedAt，收到 ${field}` }
    }
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const keys = Object.keys(state.candidates || {}).filter((k) => state.candidates[k] && state.candidates[k].jobId === jobId)
      const touched = []
      for (const k of keys) {
        const c = state.candidates[k]
        if (!c || c.stage !== stage) continue
        c[field] = value
        touched.push({ seq: c.seq, name: c.name })
      }
      return { ok: true, jobId, stage, field, value, count: touched.length, touched }
    })
  }

  // v2.21.0：多角色（招聘员/新招呼员/沟通中员/邀约员）共用一套台账时的租约，
  // 防止两个成员同时点同一个人。只有一台浏览器、一个鼠标，必须靠租约串行。
  if (action === 'claim') {
    const op = String(args.op || 'take')
    const by = String(args.by || "").trim()

    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const bossId = args.bossId || (args.name ? `${args.name}|${args.company || "-"}` : "")
      if (!bossId) return { ok: false, error: "claim 需要 bossId 或 name" }
      const key = candKey(jobId, bossId)
      const c = state.candidates[key]
      if (!c) return { ok: false, error: `台账里没有 ${bossId}，先 upsert` }
      const now = Date.now()
      const lease = c.lease && c.lease.until ? c.lease : null
      const active = lease && lease.until > now
      if (op === 'release') {
        c.lease = null
        return { ok: true, bossId, released: true }
      }
      if (op === 'status') {
        return { ok: true, bossId, available: !active, lease }
      }
      if (op === 'take') {
        if (active && lease.by !== by) {
          return { ok: false, error: `已被 ${lease.by} 占用到 ${new Date(lease.until).toLocaleTimeString()}`, lease }
        }
        const ttlMin = Math.max(1, Math.min(120, Number(args.ttlMin) || 15))
        c.lease = { by: by || "unknown", until: now + ttlMin * 60000, at: nowISO() }
        return { ok: true, bossId, name: c.name, claimedBy: c.lease.by, ttlMin, until: new Date(c.lease.until).toLocaleString() }
      }
      return { ok: false, error: "op 只支持 take / release / status" }
    })
  }

  // v2.14.0：看在线简历时的「逐步下滑」序列——即使一屏放得下也要滑，完全不动是最明显的机器特征
  if (action === 'readPlan') {
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const hz = humanizeOf(job.criteria)
      const cfg = hz.resumeScroll || {}
      const rnd = (a, b) => Math.round(a + Math.random() * (b - a))
      const times = Math.max(1, Math.min(6, Math.round(Number(args.times) || cfg.times || 3)))
      const minAmt = cfg.minAmount || 2
      const maxAmt = cfg.maxAmount || 4
      const minPause = cfg.minPauseMs || 800
      const maxPause = cfg.maxPauseMs || 2000
      const steps = []
      for (let i = 0; i < times; i++) {
        steps.push({ type: 'scroll', direction: 'down', amount: rnd(minAmt, maxAmt), note: `第 ${i + 1}/${times} 次往下滑一段` })
        steps.push({ type: 'wait', durationMs: rnd(minPause, maxPause), note: '停一下读这一段' })
      }
      steps.push({ type: 'scroll', direction: 'up', amount: 12, note: '看完回滚到顶部，再判定/再点打招呼' })
      return {
        ok: true,
        jobId,
        times,
        steps,
        usage: '打开在线简历后照 steps 顺序执行：scroll 到简历正文中部→wait→重复。滑完再判定、再 clickPlan 点招呼。',
        humanize: hz,
      }
    })
  }

  // v2.14.0：声明当前在沟通页哪个 tab，插件据此给出「这一屏该怎么处理」
  if (action === 'chatTabs') {
    const TAB_GUIDE = {
      all: { label: '全部', does: '混合视图，判断谁该回最费神；只用来扫一眼总量', order: 9 },
      newGreet: { label: '新招呼', does: '求职者主动打招呼、我们还没看过、也没回过的人。我们一旦发消息或点招呼，他就流转到「沟通中」', order: 1 },
      chatting: { label: '沟通中', does: '我们已发过消息/点过招呼的人（还没到收简历阶段）。他回消息或发附件但我们没看/没点同意接收，也都留在这里', order: 2 },
      resume: { label: '已获取简历', does: '候选人发了附件且我们已点「同意」接收的人——这些才算真的拿到简历', order: 3 },
      interview: { label: '已约面', does: '已进面试流程——除非改期，否则不用碰', order: 8 },
      phone: { label: '已交换电话', does: '拿到联系方式的人，交给人工跟进', order: 7 },
      wechat: { label: '已交换微信', does: '拿到微信的人，交给人工跟进', order: 7 },
      favorited: { label: '收藏', does: '人工标过的人，优先级由人工决定', order: 6 },
    }
    const tab = String(args.tab || "").trim()
    const order = Object.entries(TAB_GUIDE)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([k, v], i) => ({ seq: i + 1, tab: k, label: v.label, does: v.does }))
    if (!tab) return { ok: true, jobId, browseOrder: order, tip: '建议顺序：新招呼 → 沟通中 → 已获取简历；已约面/已换电话/已换微信不用逐条点开' }
    const hit = TAB_GUIDE[tab]
    if (!hit) return { ok: false, error: `未知 tab: ${tab}`, valid: Object.keys(TAB_GUIDE) }
    return { ok: true, jobId, tab, ...hit, browseOrder: order }
  }

  // v2.12.0：生成「拟人点击计划」—— 给定控件坐标，返回带随机偏移、预移动、停留、后置停顿的动作序列
  if (action === 'clickPlan') {
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      const hz = humanizeOf(job.criteria)
      const x = Number(args.x)
      const y = Number(args.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: 'clickPlan 需要 x / y（当前截图的像素坐标）' }
      }
      const rnd = (a, b) => Math.round(a + Math.random() * (b - a))
      const pair = (v, dflt) => (Array.isArray(v) && v.length >= 2 ? [Number(v[0]), Number(v[1])] : dflt)
      const off = Math.max(0, Number(hz.clickOffsetPx) || 0)
      const tx = x + rnd(-off, off)
      const ty = y + rnd(-off, off)
      const pm = pair(hz.preMoveDelayMs, [120, 420])
      const hv = pair(hz.hoverDwellMs, [300, 1200])
      const ap = pair(hz.actionPauseMs, [600, 1800])
      const n = Math.max(0, Math.min(4, Number(hz.preMoveCount) || 0))
      if (n > 0 && Math.random() < Number(hz.scrollBeforeClick || 0)) {
        // 以配置的概率先滚一下，制造额外的行为分叉
      }
      const steps = []
      for (let i = 0; i < n; i++) {
        steps.push({
          type: 'mouse_move',
          to: [x + rnd(-70, 70), y + rnd(-70, 70)],
          waitMs: rnd(pm[0], pm[1]),
        })
      }
      steps.push({ type: 'mouse_move', to: [tx, ty], waitMs: rnd(hv[0], hv[1]) })
      steps.push({ type: 'left_click', at: [tx, ty] })
      if (Math.random() < Number(hz.scrollBeforeClick || 0)) {
        steps.unshift({ type: 'scroll', note: '按配置概率先滚一下再点（制造分叉）', waitMs: rnd(ap[0], ap[1]) })
      }
      return {
        ok: true,
        jobId,
        from: [x, y],
        target: [tx, ty],
        offsetPx: [tx - x, ty - y],
        steps,
        postPauseMs: rnd(ap[0], ap[1]),
        usage: '按 steps 顺序执行：每次 mouse_move 后等 waitMs，再执行 left_click；点完停 postPauseMs 再做下一个动作。不要直接点控件中心。',
        humanize: hz,
      }
    })
  }

  if (action === 'config') {
    return withState((state) => {
      const { job } = resolveJob(state, jobId)
      if (!args.key) {
        return { ok: true, jobId, criteria: job.criteria, highlights: job.highlights, flow: job.flow }
      }
      if (args.key === 'interview') {
        let v = args.value
        if (typeof v === 'string') {
          try { v = JSON.parse(v) } catch (e) { return { ok: false, error: 'interview 需要一个 JSON 对象' } }
        }
        if (!v || typeof v !== 'object') return { ok: false, error: 'interview 需要一个对象' }
        job.interview = Object.assign(interviewDefaults(job), v)
        return { ok: true, jobId, interview: job.interview }
      }
      if (['greetMinGapSec', 'greetMaxGapSec', 'greetQuotaPerDay', 'roundGreetSize'].includes(args.key)) {
        const value = Number(args.value)
        if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return { ok: false, error: `${args.key} 必须是非负整数` }
        const next = { ...job.criteria, [args.key]: value }
        if (next.greetMinGapSec > next.greetMaxGapSec) return { ok: false, error: 'greetMinGapSec 不能大于 greetMaxGapSec' }
        const cap = Number((humanizeOf(next) || {}).dailyHardCap) || 0
        if (args.key === 'greetQuotaPerDay' && cap && value > cap) return { ok: false, error: `每日额度不能超过 humanize.dailyHardCap=${cap}` }
        job.criteria[args.key] = value
        return { ok: true, jobId, [args.key]: value, gap: { minSec: next.greetMinGapSec, maxSec: next.greetMaxGapSec } }
      }
      if (args.key && String(args.key).indexOf('interview.') === 0) {
        const f = String(args.key).slice('interview.'.length)
        const allowed = ['location', 'address', 'mode', 'contact', 'phone', 'link', 'extra', 'durationMin']
        if (allowed.indexOf(f) < 0) {
          return { ok: false, error: `interview.${f} 不支持，可用：${allowed.join(' / ')}` }
        }
        const cur = interviewDefaults(job)
        cur[f] = f === 'durationMin' ? (Number(args.value) > 0 ? Number(args.value) : 60) : String(args.value == null ? '' : args.value)
        job.interview = cur
        return { ok: true, jobId, interview: job.interview }
      }
      if (args.key === 'workflows') {
        const value = args.value && typeof args.value === 'object' ? args.value : null
        if (!value) return { ok: false, error: 'workflows 需要对象，例如 { chatting: [步骤一, 步骤二] }' }
        const workflows = { ...(job.criteria.workflows || {}) }
        for (const [track, steps] of Object.entries(value)) {
          if (!FLOW_DEFINITIONS[track]) return { ok: false, error: `未知子流程：${track}` }
          if (!Array.isArray(steps) || !steps.length) return { ok: false, error: `${track} 的步骤不能为空` }
          workflows[track] = steps.map((step) => String(step))
        }
        job.criteria.workflows = workflows
        return { ok: true, jobId, workflows }
      }
      if (args.key === 'highlights') {
        job.highlights = Array.isArray(args.value) ? args.value.map(String) : String(args.value || '').split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
      } else if (args.key === 'techDepthKeywords') {
        // v2.1：工程深度词表可编辑；数组或「、/,/换行」分隔的字符串都收
        const list = Array.isArray(args.value)
          ? args.value.map(String)
          : String(args.value == null ? '' : args.value).split(/[、,，\n]/)
        job.criteria.techDepthKeywords = list.map((s) => s.trim()).filter(Boolean)
      } else if (args.key === 'starTokens') {
        // v2.3：方向加分词可编辑；数组或「、/,/换行」分隔的字符串都收；传空 = 关闭方向加分
        const list = Array.isArray(args.value)
          ? args.value.map(String)
          : String(args.value == null ? '' : args.value).split(/[、,，\n]/)
        job.criteria.starTokens = list.map((s) => s.trim()).filter(Boolean)
      } else if (flowMap(job)[args.key]) {
        flowMap(job)[args.key].template = String(args.value == null ? '' : args.value)
      } else if (args.key in job.criteria) {
        job.criteria[args.key] = args.value
        if (args.key === 'salaryMinK' || args.key === 'salaryMaxK') {
          job.criteria.salary = `${job.criteria.salaryMinK}-${job.criteria.salaryMaxK}K`
        }
      } else {
        return { ok: false, error: `未知字段：${args.key}（可以是 criteria 字段、flow 的 key，或 highlights）` }
      }
      return { ok: true, jobId, criteria: job.criteria, highlights: job.highlights, flow: job.flow }
    })
  }

  return { ok: false, error: `未知 action: ${action}` }
}

// ---------------------------------------------------------------------------
// HTTP：面板读台账（GET）与写操作（POST）
// ---------------------------------------------------------------------------

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(sanitize(payload))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** GET：面板需要的全部数据 */
function buildPanelPayload(state) {
  const today = todayKey()
  const jobs = jobList(state)
  const jobModes = jobModesOf(state)
  const perJob = {}
  for (const job of Object.values(state.jobs)) {
    const counter = counterPeek(state, job.id, today) || { greets: 0, browses: 0 }
    const quotaTarget = job.criteria.greetQuotaPerDay
    perJob[job.id] = {
      // v2.2：该岗位自己记住的模式
      mode: jobModes[job.id] || state.mode,
      quota: {
        target: quotaTarget,
        done: counter.greets || 0,
        remaining: Math.max(0, quotaTarget - (counter.greets || 0)),
        browses: counter.browses || 0,
        lastGreetAt: counter.lastGreetAt || null,
      },
      progress: {
        daily: { done: counter.greets || 0, target: quotaTarget },
        round: {
          done: counter.roundGreets || 0,
          target: job.criteria.roundGreetSize || 15,
          index: (counter.roundsCompleted || 0) + 1,
        },
        browse: {
          done: counter.browses || 0,
          target: job.criteria.browseBeforeGreetMin || 1,
        },
        roundsCompleted: counter.roundsCompleted || 0,
        restUntil: counter.restUntil || null,
      },
      criteria: job.criteria,
      highlights: job.highlights || [],
      flow: job.flow || [],
      stats: statsOf(state, job.id),
    }
  }
  const candidates = sortCands(Object.values(state.candidates), 'seq', 'asc').map((x) => ({
    ...decorate(x),
    // v2.2：每行带上岗位名，filterJob=all 时表格多一列「岗位」
    jobName: (state.jobs[x.jobId] || {}).name || '',
  }))
  return {
    ok: true,
    version: state.version,
    mode: state.mode,
    modes: MODE_LABEL,
    activeJobId: state.activeJobId,
    jobModes,
    jobs: Object.values(state.jobs).map((job) => jobPublic(job, state.activeJobId)),
    jobList: jobs,
    perJob,
    stageLabel: STAGE_LABEL,
    stageOrder: STAGES,
    nextStep: NEXT_STEP,
    rejectReasons: REJECT_REASON_LABEL,
    // v2.1：派生评分的等级表与默认词表，供 Client 渲染（前后端共用同一份定义）
    definitions: {
      techFitGrades: TECH_FIT_GRADES,
      valueGrades: VALUE_GRADES,
      techDepthKeywords: TECH_DEPTH_KEYWORDS_DEFAULT,
      techFitWeights: TECH_FIT_WEIGHTS,
      techFitFormula: '必备技能40 + 加分技能20 + 项目关键词20 + 工程深度20',
      valueFormula: 'valueScore = clamp(round(techFitScore / costRatio * 0.8), 0, 100)；costRatio = 期望下限 / 预算中值',
    },
    total: candidates.length,
    candidates,
  }
}


const BACKUP_FORMAT = 'boss-recruit-backup'
const BACKUP_VERSION = 1

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function backupSummary(state) {
  return {
    jobs: Object.keys(state.jobs || {}).length,
    candidates: Object.keys(state.candidates || {}).length,
    dialogs: Object.values(state.candidates || {}).reduce((n, c) => n + (Array.isArray(c.dialogLog) ? c.dialogLog.length : 0), 0),
    screens: Array.isArray(state.screens) ? state.screens.length : 0,
    counters: Object.keys(state.counters || {}).length,
    views: Object.keys(state.views || {}).length,
  }
}

function makeBackup(state) {
  // Deep-copy so the download cannot mutate the in-memory ledger.
  const data = cloneJson(state)
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: nowISO(),
    includes: ['jobs', 'candidates', 'dialogLog', 'screens', 'screenIndex', 'counters', 'views', 'chatScope', 'flowContext', 'inbox', 'sop', 'blacklist'],
    summary: backupSummary(data),
    state: data,
  }
}

function validateBackup(value) {
  if (!value || value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION) {
    return '不是本插件的备份包：需要 format=boss-recruit-backup 且 version=1'
  }
  if (!value.state || typeof value.state !== 'object' || Array.isArray(value.state)) return '备份包缺少 state'
  const s = value.state
  if (!s.jobs || typeof s.jobs !== 'object' || Array.isArray(s.jobs)) return '备份包 jobs 结构无效'
  if (!s.candidates || typeof s.candidates !== 'object' || Array.isArray(s.candidates)) return '备份包 candidates 结构无效'
  for (const [id, job] of Object.entries(s.jobs)) {
    if (!job || typeof job !== 'object' || job.id !== id) return `岗位 ${id} 结构无效`
  }
  for (const [key, c] of Object.entries(s.candidates)) {
    if (!c || typeof c !== 'object' || !c.jobId || !c.bossId) return `候选人 ${key} 缺少岗位或身份`
    if (candKey(c.jobId, c.bossId) !== key) return `候选人 ${key} 的 key 与身份不一致`
    if (c.dialogLog !== undefined && !Array.isArray(c.dialogLog)) return `候选人 ${key} 的沟通记录不是数组`
  }
  return null
}

function mergeDialogLogs(a, b) {
  const out = []
  const seen = new Set()
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!item || typeof item !== 'object') continue
    const key = JSON.stringify([item.at || '', item.dir || '', item.text || '', item.summary || ''])
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cloneJson(item))
  }
  out.sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')))
  return out
}

function mergeScreenLists(a, b) {
  const out = []
  const seen = new Set()
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!item || typeof item !== 'object') continue
    const key = JSON.stringify([item.jobId || '', item.bossId || '', item.at || '', item.projects || ''])
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cloneJson(item))
  }
  out.sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')))
  return out
}

function earlier(a, b) {
  const left = String(a || '')
  const right = String(b || '')
  if (!left) return right
  if (!right) return left
  return left <= right ? left : right
}

function mergeBackupStates(current, incoming, replace) {
  // 两个分支必须返回同一形状 { state, stats }：调用方统一读 merged.state。
  // 早期在 replace 分支直接返回 cloneJson(incoming)，调用方读 merged.state 得到 undefined，
  // migrate() 回退成空默认状态 —— 表现为「导入返回 ok 但台账被清空」。
  if (replace) return { state: cloneJson(incoming), stats: null }
  const out = cloneJson(current)
  out.jobs = { ...cloneJson(incoming.jobs), ...out.jobs }
  out.jobModes = { ...cloneJson(incoming.jobModes || {}), ...out.jobModes }
  out.candidates = { ...out.candidates }
  const stats = { added: 0, updated: 0, unchanged: 0 }
  for (const [key, source] of Object.entries(incoming.candidates || {})) {
    const existing = out.candidates[key]
    if (!existing) {
      out.candidates[key] = cloneJson(source)
      stats.added += 1
      continue
    }
    const merged = { ...cloneJson(source), ...cloneJson(existing) }
    // Empty values from an older/partial machine must not erase real data.
    for (const field of ['phone', 'email', 'school', 'company2', 'project', 'screenProjects', 'preview', 'sourceTab']) {
      if (!existing[field] && source[field]) merged[field] = cloneJson(source[field])
    }
    merged.dialogLog = mergeDialogLogs(source.dialogLog, existing.dialogLog)
    for (const field of ['firstSeenAt', 'greetedAt', 'repliedAt', 'resumeAt']) {
      merged[field] = earlier(source[field], existing[field])
    }
    merged.updatedAt = [source.updatedAt || '', existing.updatedAt || ''].sort().pop()
    // Only fill unknown identity/screening evidence from the other machine.
    if (!existing.screenedAt && source.screenedAt) {
      merged.screenedAt = source.screenedAt
      merged.screenDecision = source.screenDecision
    }
    out.candidates[key] = merged
    stats.updated += 1
    if (JSON.stringify(existing) === JSON.stringify(merged)) stats.unchanged += 1
  }
  out.counters = { ...cloneJson(incoming.counters || {}), ...out.counters }
  out.views = { ...cloneJson(incoming.views || {}), ...out.views }
  out.screens = mergeScreenLists(incoming.screens, out.screens)
  out.screenIndex = { ...cloneJson(incoming.screenIndex || {}), ...out.screenIndex }
  out.inbox = { ...cloneJson(incoming.inbox || {}), ...out.inbox }
  out.blacklist = [...new Set([...(out.blacklist || []), ...(incoming.blacklist || [])])]
  // Current machine's active job and current chat scope are not silently switched.
  out.activeJobId = current.activeJobId
  out.chatScope = current.chatScope || incoming.chatScope || null
  out.flowContext = current.flowContext || incoming.flowContext || null
  if (current.sop && incoming.sop) {
    const local = cloneJson(current.sop)
    const remote = cloneJson(incoming.sop)
    local.sections = local.sections || []
    local.lessons = local.lessons || []
    local.pending = local.pending || []
    const sectionIds = new Set(local.sections.map((s) => s.id))
    for (const section of remote.sections || []) {
      if (!sectionIds.has(section.id)) local.sections.push(section)
    }
    const lessonKeys = new Set(local.lessons.map((l) => l.id || l.text))
    for (const lesson of remote.lessons || []) {
      if (!lessonKeys.has(lesson.id || lesson.text)) local.lessons.push(lesson)
    }
    const pendingKeys = new Set(local.pending.map((p) => p.id || p.text))
    for (const pending of remote.pending || []) {
      if (!pendingKeys.has(pending.id || pending.text)) local.pending.push(pending)
    }
    local.updatedAt = [local.updatedAt || '', remote.updatedAt || ''].sort().pop()
    out.sop = local
  } else {
    out.sop = current.sop || incoming.sop
  }
  return { state: out, stats }
}

/**
 * 兼容「面板数据」形态的导入。
 * GET /boss-recruit/api（不带 action）返回的是展示层数据：jobs / candidates 是数组，
 * 没有 format / state 外壳。历史上这个响应很容易被当成「完整备份」保存下来，
 * 再导入就会被 validateBackup 直接拒绝（提示一闪而过，看起来像"没反应"）。
 * 这里把它转成合法备份包，而不是让用户对着一个能解析的 JSON 干瞪眼。
 */
function normalizeBackupInput(doc) {
  if (!doc || typeof doc !== 'object') return doc
  if (doc.format === BACKUP_FORMAT && doc.state && typeof doc.state === 'object') return doc
  const jobsArr = Array.isArray(doc.jobs) ? doc.jobs : null
  const candsArr = Array.isArray(doc.candidates) ? doc.candidates : null
  if (!jobsArr || !candsArr) return doc
  const jobs = {}
  for (const j of jobsArr) {
    if (j && typeof j === 'object' && j.id) jobs[j.id] = j
  }
  const candidates = {}
  for (const c of candsArr) {
    if (!c || typeof c !== 'object' || !c.jobId || !c.bossId) continue
    candidates[candKey(c.jobId, c.bossId)] = c
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: nowISO(),
    convertedFrom: 'panel-payload',
    summary: { jobs: Object.keys(jobs).length, candidates: Object.keys(candidates).length },
    state: {
      version: STATE_VERSION,
      activeJobId: doc.activeJobId,
      mode: doc.mode,
      jobs,
      jobModes: doc.jobModes || {},
      candidates,
      counters: {},
      views: {},
      blacklist: [],
      screens: [],
      screenIndex: {},
      chatScope: null,
      flowContext: null,
      inbox: {},
    },
  }
}

async function importBackup(state, doc, replace) {
  const normalized = normalizeBackupInput(doc)
  const invalid = validateBackup(normalized)
  if (invalid) return { ok: false, error: invalid }
  const before = cloneJson(state)
  const backupFile = join(STORE_DIR, `backups/before-import-${Date.now()}.json`)
  await mkdir(join(STORE_DIR, 'backups'), { recursive: true })
  await writeFile(backupFile, JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: nowISO(), state: before }, null, 2), 'utf8')
  const merged = mergeBackupStates(before, normalized.state, replace)
  for (const key of Object.keys(state)) delete state[key]
  Object.assign(state, migrate(merged.state))
  return {
    ok: true,
    mode: replace ? 'replace' : 'merge',
    backupFile,
    before: backupSummary(before),
    after: backupSummary(state),
    ...(replace ? { stats: null } : { stats: merged.stats }),
    ...(normalized.convertedFrom ? { convertedFrom: normalized.convertedFrom, convertedNote: '输入是面板数据（jobs/candidates 数组），已自动转成备份包再导入' } : {}),
    note: replace ? '已先备份本机台账，再按备份包替换' : '已先备份本机台账，再按 key 合并；重复沟通记录不重复，本机当前岗位与沟通作用域不切换',
  }
}

async function handleApi(req, res) {
  try {
    if (req.method === 'GET' && String(req.url || '').includes('action=backup-export')) {
      const doc = await readState((state) => makeBackup(state))
      const body = JSON.stringify(doc, null, 2)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="boss-recruit-backup.json"',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      const action = String(body.action || '')
      let result
      if (action === 'backup-export') {
        result = await readState((state) => ({ ok: true, backup: makeBackup(state) }))
        sendJson(res, 200, result)
        return
      }
      if (action === 'backup-import') {
        result = await withState((state) => importBackup(state, body.backup, body.replace === true))
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (action === 'selectJob') {
        result = await withState((state) => {
          if (!state.jobs[body.jobId]) return { ok: false, error: `岗位不存在：${body.jobId}` }
          state.activeJobId = body.jobId
          // v2.2：恢复该岗位自己的模式
          state.mode = state.jobModes[body.jobId] || state.mode
          const job = state.jobs[body.jobId]
          return {
            ok: true,
            activeJobId: state.activeJobId,
            jobId: job.id,
            job: job.name,
            mode: state.mode,
            jobModes: jobModesOf(state),
            stats: statsOf(state, job.id),
          }
        })
      } else if (action === 'mode') {
        result = await withState((state) => {
          if (!['recruit', 'reply', 'all'].includes(body.mode)) {
            return { ok: false, error: 'mode 只能是 recruit / reply / all' }
          }
          const targetJobId = body.jobId && state.jobs[body.jobId] ? body.jobId : state.activeJobId
          state.jobModes[targetJobId] = body.mode
          if (targetJobId === state.activeJobId) state.mode = body.mode
          return { ok: true, jobId: targetJobId, mode: body.mode, jobModes: jobModesOf(state) }
        })
      } else if (action === 'createJob') {
        // v2.2：面板「＋ 新建岗位」——复制当前岗位要求 或 空白默认模板
        result = await withState((state) => createJobInState(state, {
          name: body.name,
          mode: body.template === 'blank' ? 'blank' : 'copy',
          copyFromJobId: body.copyFromJobId || body.fromJobId,
        }))
      } else if (action === 'deleteJob') {
        result = await withState((state) => deleteJobInState(state, body.jobId))
      } else if (action === 'star') {
        result = await withState((state) => {
          const key = candKey(body.jobId || state.activeJobId, body.bossId || '')
          const cand = state.candidates[key]
          if (!cand) return { ok: false, error: `台账里没有 ${body.bossId}` }
          cand.starred = body.starred === undefined ? !cand.starred : Boolean(body.starred)
          cand.updatedAt = nowISO()
          return { ok: true, starred: cand.starred, key }
        })
      } else if (action === 'saveJob') {
        result = await withState((state) => {
          const jobId = body.jobId || state.activeJobId
          const job = state.jobs[jobId]
          if (!job) return { ok: false, error: `岗位不存在：${jobId}` }
          if (body.name !== undefined) job.name = String(body.name)
          if (body.criteria && typeof body.criteria === 'object') {
            for (const [k, v] of Object.entries(body.criteria)) job.criteria[k] = v
            for (const k of ['salaryMinK', 'salaryMaxK', 'expectSalaryMinCapK', 'gradYearMin', 'workYearMin', 'greetQuotaPerDay', 'roundGreetSize', 'staleDays']) {
              if (job.criteria[k] != null && job.criteria[k] !== '') job.criteria[k] = Number(job.criteria[k])
            }
            job.criteria.salary = `${job.criteria.salaryMinK}-${job.criteria.salaryMaxK}K`
          }
          if (Array.isArray(body.highlights)) job.highlights = body.highlights.map(String).filter((s) => s.trim() !== '')
          if (Array.isArray(body.flow)) {
            job.flow = body.flow.map((step, i) => ({
              key: String(step.key || `step${i + 1}`),
              name: String(step.name || step.key || `步骤${i + 1}`),
              enabled: step.enabled !== false,
              template: String(step.template || ''),
            }))
          }
          return { ok: true, jobId, job: jobPublic(job, state.activeJobId) }
        })
      } else if (action === 'upsert') {
        // v2.6.1 面板改状态 / 备注 / 字段：复用 runAction 的 upsert
        result = await runAction({
          action: 'upsert',
          jobId: body.jobId,
          bossId: body.bossId,
          name: body.name,
          company: body.company,
          stage: body.stage,
          note: body.note,
          edu: body.edu,
          gradYear: body.gradYear,
          workYears: body.workYears,
          expectSalary: body.expectSalary,
          expectCity: body.expectCity,
          expectPosition: body.expectPosition,
          skills: body.skills,
          project: body.project,
          xuexinSelf: body.xuexinSelf,
          keyInfo: body.keyInfo,
          starred: body.starred,
          verbose: false,
        })
      } else if (action === 'log') {
        result = await runAction({
          action: 'log',
          jobId: body.jobId,
          bossId: body.bossId,
          dir: body.dir,
          text: body.text,
          summary: body.summary,
        })
      } else if (action === 'reject') {
        result = await runAction({
          action: 'reject',
          jobId: body.jobId,
          bossId: body.bossId,
          rejectReason: body.rejectReason,
          note: body.note,
        })
      } else if (action === 'interview') {
        // v2.6.1 面板按行/批量设置面试参数：复用 runAction 的 interview
        result = await runAction({
          action: 'interview',
          jobId: body.jobId,
          name: body.name,
          names: body.names,
          time: body.time,
          window: body.window,
          location: body.location,
          address: body.address,
          interviewMode: body.interviewMode,
          contact: body.contact,
          phone: body.phone,
          link: body.link,
          extra: body.extra,
          note: body.note,
          render: body.render === false ? false : true,
        })
      } else if (action === 'interviewDefaults') {
        // 岗位级面试默认值（地点/方式/联系人等）
        result = await runAction({ action: 'config', jobId: body.jobId, key: 'interview', value: body.value || {} })
      } else if (action === 'sop') {
        // v2.6.1 面板的 SOP 查看/编辑：直接复用 runAction 的 sop 实现
        result = await runAction({
          action: 'sop',
          op: body.op || 'list',
          id: body.id,
          text: body.text,
          title: body.title,
          source: body.source,
          jobId: body.jobId,
        })
      } else {
        result = { ok: false, error: `未知 POST action: ${action}` }
      }
      sendJson(res, result && result.ok === false ? 400 : 200, result)
      return
    }

    const payload = await readState((state) => buildPanelPayload(state))
    sendJson(res, 200, payload)
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx) {
  // 启动即加载并落盘迁移（v1/v2 → v3）
  withState(async () => null).catch(() => {})

  // ---- 提示词段 ----
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'boss-recruit-sop',
      order: 60,
      text: () => sopText(snapshot),
    }),
  )

  // ---- 工具 ----
  ctx.effect(() =>
    ctx.tools.register({
      name: 'recruit_pipeline',
      description:
        '招聘流水线台账（多岗位）。判定：evaluate；记录：upsert/log/reject/star；查询：list/next/stats/seen/check/export；' +
        '节奏：pace/markGreet/markBrowse；岗位：jobs/selectJob/job/createJob/deleteJob/config；模式：mode。' +
        '当前上下文 = 岗位 × 模式，二者共同决定此刻在干什么。' +
        'list/next/stats/export 默认只作用于当前岗位（用 filterJob=all 才跨岗位）。' +
        '插件本身不发送任何消息，招呼必须由 Agent 通过真实鼠标点击发出。' +
        '效率：扫列表先滚到底再用 sweep 一次核对；记账用 batch 批量写；upsert 默认只回精简结果（要全量加 verbose）。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'pace', 'upsert', 'batch', 'sweep', 'interview', 'sop', 'list', 'next', 'seen', 'export', 'config',
              'markGreet', 'markBrowse', 'log', 'checkReply', 'screen', 'chatScope', 'clickPlan', 'readPlan', 'chatTabs', 'nextInbox', 'claim', 'backfill', 'flow', 'observe', 'completeGreet', 'backup-export', 'backup-import', 'jobs', 'selectJob', 'job',
              'createJob', 'deleteJob', 'mode', 'check', 'view', 'star', 'reject', 'stats', 'evaluate', 'audit',
            ],
            description:
              'jobs=列出岗位；selectJob=切换岗位（并恢复该岗位上次的模式）；job=查看/创建/更新/删除岗位（配 jobOp）；' +
              'createJob=新建岗位（名称 + template=copy|blank，自动补全口径并切过去）；deleteJob=删除岗位（保留候选人，禁止删最后一个）；' +
              'mode=切换工作模式（recruit/reply/all，可带 jobId 只改该岗位）；check=按姓名+公司查是否看过/招呼过；view=登记"看过但不招呼"；' +
              'evaluate=只判定不写库（返回 gaps/hits/suggestStage/rejectReason/starWorthy）；' +
              'upsert=写/更新候选人（默认只回精简结果 seq/name/stage/next/gaps，要全量档案加 verbose=true）；' +
              'batch=一次写多人，batch=[{name,company,edu,gradYear,workYears,expectSalary,stage,...}]，每条可用 action 指定 upsert/reject，缺省 upsert；' +
              'interview=配置面试参数（选择器 name 单个 / names 多人 / filterStage 批量，参数 time/window/location/address/interviewMode/contact/phone/link/extra），有 time 则 stage 自动转 interview_scheduled，并渲染邀约话术返回；' +
              'sop=招聘 SOP 的查看与改进：无 op=看全文；op=list 看目录；op=set/add/remove/reset 改；op=learn 沉淀教训；op=pending/accept/drop 处理自动捕获的待审观察；' +
              'sweep=拿界面采集的会话名单 batch=[{name,preview}] 反查台账，一次返回 missing（未入账）/waitingMe（轮到我回）/waitingThem（我发了等对方）/terminal（已终结），hitEnd=false 时警告本轮不得收工；' +
              'log=追加对话记录；reject=淘汰并记原因；star=打/取消⭐；' +
              'list=查台账（支持过滤与排序）；next=待办队列；stats=漏斗与淘汰分布；seen=是否已登记；' +
              'export=导出（csv/markdown）；config=改当前岗位口径/话术；markGreet/markBrowse=记计数；pace=节奏与下一步；' +
              'checkReply=回话发出前过边界（text=你要发的话，pass!==true 就不许发）；' +
              'clickPlan=给控件坐标生成拟人点击动作序列（随机偏移/预移动/停留/后置停顿），照着执行；readPlan=生成「看在线简历逐步往下滑」的动作序列（打开简历后先调它）；chatTabs=声明当前在沟通页哪个 tab 并给出这一屏的处理方式与推荐浏览顺序；nextInbox=按 tab 的真实流转语义，从台账算出「这一屏该处理谁、下一步做什么」，不该动的直接标 wait 省时间；claim=多角色协作租约（take/release/status）；flow=查看/选择当前子流程的固定步骤和允许动作；observe=登记当前页面名单与未读事实（不代替简历阅读）；completeGreet=一次完成节奏校验、招呼计数和台账更新；backfill=按 stage 批量补 resumeAt/interviewAt/greetedAt',
          },
          track: { type: 'string', enum: ['recommend', 'newGreet', 'chatting', 'resume', 'interview'], description: 'flow 用：选择本轮唯一子流程' },
          tab: { type: 'string', enum: ['recommend', 'newGreet', 'chatting', 'resume'], description: 'observe 用：当前页面/子流程' },
          unread: { type: 'boolean', description: 'observe batch 每项：是否为未读会话' },
          lastSpeaker: { type: 'string', enum: ['me', 'them', 'unknown'], description: 'observe batch 每项：最后发言方' },
          sourceTab: { type: 'string', description: 'view 用：候选人在哪个页面看到，区分推荐页浏览与新招呼未读' },
          preview: { type: 'string', description: 'view 用：页面预览原文，不能代替完整简历' },
          noReply: { type: 'boolean', description: 'upsert 用：礼貌收尾或无新信息时设 true，后续 nextInbox 不再重复提醒' },
          backup: { type: 'object', description: 'backup-import 用：A 机器通过 backup-export 得到的完整备份包；含岗位/候选人/沟通/凭据/计数/流程配置' },
          replace: { type: 'boolean', description: 'backup-import 用：true=先自动备份本机再替换；false（默认）=安全合并，推荐' },
          limit: { type: 'number', description: 'nextInbox 返回队列上限，默认 30，最大 100' },
          names: { type: 'array', items: { type: 'string' }, description: 'interview 用：批量指定候选人姓名（与 name / filterStage 三选一）' },
          time: { type: 'string', description: 'interview 用：具体面试时间，如 2026-10-23 14:30' },
          window: { type: 'string', description: 'interview 用：候选人给的原始时间窗口，如「周三周四都可以」' },
          location: { type: 'string', description: 'interview 用：面试地点名称（省略则继承岗位默认）' },
          address: { type: 'string', description: 'interview 用：详细地址（省略则继承岗位默认）' },
          interviewMode: { type: 'string', enum: ['onsite', 'phone', 'video'], description: 'interview 用：面试方式 onsite现场/phone电话/video视频（注意不是 mode，mode 是工作模式）' },
          contact: { type: 'string', description: 'interview 用：面试联系人' },
          phone: { type: 'string', description: 'interview 用：联系电话' },
          link: { type: 'string', description: 'interview 用：视频面试链接（interviewMode=video 时用）' },
          extra: { type: 'string', description: 'interview 用：附加说明（需带什么、提前几分钟到等）' },
          render: { type: 'boolean', description: 'interview 用：是否渲染邀约话术，默认 true' },
          dryRun: { type: 'boolean', description: 'interview 用：只预览每个候选人会收到的话术，不写库、不改 stage。确认无误再正式设置' },
          verbose: { type: 'boolean', description: 'upsert/reject/star 默认只回精简结果以省 token；置 true 才返回完整档案（含 evaluation/techFit/value）。单纯要看某人详情优先用 list 过滤' },
          hitEnd: { type: 'boolean', description: 'sweep 专用：是否已确认列表滚到底（出现「没有更多了」）。传 false 会返回 warning，表示本轮不得视为完成' },
          batch: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'batch/sweep 的输入数组。batch 每条是候选人字段（name 必填，其余同 upsert）；sweep 每条是 {name, preview}，preview 为会话列表预览文本，以 [已读]/[送达] 开头表示最后一句是我发的' },
          jobId: { type: 'string', description: '岗位 id；省略则用当前岗位（mode 动作里表示只改该岗位的模式）' },
          jobName: { type: 'string', description: 'createJob 时的岗位名称（必填）' },
          template: {
            type: 'string',
            enum: ['copy', 'blank'],
            description: 'createJob 的模板：copy=从当前岗位复制要求，blank=空白默认模板',
          },
          copyFromJobId: { type: 'string', description: 'createJob 时从哪个岗位复制（省略=当前岗位）' },
          jobOp: {
            type: 'string',
            enum: ['show', 'create', 'update', 'delete'],
            description: 'job 动作的子操作：show=查看（默认）、create=新建（复制默认模板）、update=改 name/criteria/highlights/flow、delete=删除',
          },
          job: {
            type: 'object',
            description: 'job 动作的岗位定义，形如 {id,name,criteria:{...},highlights:[...],flow:[...]}',
            additionalProperties: true,
          },
          criteria: { type: 'object', description: 'job/create|update 时的口径字段集合', additionalProperties: true },
          highlights: { type: 'array', items: { type: 'string' }, description: '岗位要点列表（可用 {highlights} 注入话术）' },
          flow: { type: 'array', description: '话术流程 [{key,name,enabled,template}]', additionalProperties: true },
          bossId: { type: 'string', description: 'BOSS 账号唯一标识；省略时用 姓名|公司' },
          name: { type: 'string', description: '候选人姓名' },
          edu: { type: 'string', description: '学历，如 大专 / 本科' },
          gradYear: { type: 'number', description: '毕业年份，如 2019' },
          xuexinSelf: {
            type: 'string',
            enum: ['可查', '不可查', '未说'],
            description: '候选人自述的学信网可查情况',
          },
          xuexinVerify: {
            type: 'string',
            enum: ['pending', 'verified', 'failed'],
            description: '人工核验状态，默认 pending',
          },
          workYears: { type: 'number', description: '工作年限' },
          company: { type: 'string', description: '当前/最近公司' },
          skills: { type: 'array', items: { type: 'string' }, description: '技能标签' },
          project: { type: 'string', description: '项目经历摘要（用于项目匹配判断）' },
          expectedSalary: { type: 'string', description: '期望薪资文本，如 "15-20K"、"面议"' },
          expectSalary: { type: 'string', description: 'expectSalary 的别名' },
          expectSalaryMinK: { type: 'number', description: '期望薪资下限（K）；省略时从期望薪资文本解析' },
          expectCity: { type: 'string', description: '期望城市，如 北京' },
          expectPosition: { type: 'string', description: '期望职位方向，如 Unity客户端 / Cocos' },
        phone: { type: 'string', description: '手机号（候选人自述或附件简历上看到的）；有手机号时按手机号去重' },
        company2: { type: 'string', description: '上一家公司名称（去重键用「姓名+最近两家公司」）' },
        interviewTime: { type: 'string', description: '面试时间（候选人给出的具体时间）' },
        interviewWindow: { type: 'string', description: '候选人给的时间窗口，如「周三周四都可以」' },
        interviewLocation: { type: 'string', description: '面试地点' },
        interviewMode: { type: 'string', description: '面试方式：现场/电话/视频' },
        interviewContact: { type: 'string', description: '面试联系人' },
        interviewPhone: { type: 'string', description: '面试联系电话' },
        email: { type: 'string', description: '邮箱（收简历用，或候选人自述）' },
        school: { type: 'string', description: '毕业学校（最高学历院校全称）' },
          jobTitle: { type: 'string', description: '岗位名称（job 动作用）' },
          stage: { type: 'string', enum: STAGES, description: '候选人阶段（含 pending 待定）' },
          starred: { type: 'boolean', description: 'star 动作：true 打星 / false 取消；省略则切换' },
          rejectReason: {
            type: 'string',
            enum: ['city', 'edu', 'year', 'direction', 'salary', 'freshgrad', 'other'],
            description: 'reject 动作的淘汰原因分类',
          },
          note: { type: 'string', description: '备注' },
          summary: { type: 'string', description: 'log 动作的沟通要点总结' },
          text: { type: 'string', description: 'log 动作的原始文本；sop 动作里是节正文（set/add）或教训内容（learn/accept）' },
          op: { type: 'string', description: 'sop 动作的子操作：show（默认，看全文）/list（看目录与各节字数）/get/set/add/remove/reset/learn/lessons/unlearn/pending/accept/drop' },
          id: { type: 'string', description: 'sop 动作的节 id 或教训/待审 id；set/remove/reset/unlearn/accept/drop 需要它' },
          title: { type: 'string', description: 'sop add 时新节的标题' },
          source: { type: 'string', description: 'sop learn 的来源标记（可选，如 manual / 某次事故名）' },
          dir: { type: 'string', enum: ['in', 'out'], description: 'log 动作的方向：in=候选人说 / out=我们发' },
          count: { type: 'number', description: 'markGreet / markBrowse 时补记的次数（默认 1）' },
          mode: { type: 'string', enum: ['recruit', 'reply', 'all'], description: 'mode 动作的目标模式（每个岗位各记一份，配 jobId 只改该岗位）' },
          filterStage: { type: 'string', description: 'list 时按阶段过滤（含 pending）' },
          filterJob: { type: 'string', description: 'list/next/stats/export 时按岗位过滤；传 all 表示全部岗位（跨岗位汇总，不传则严格只算当前岗位）' },
          filterSalaryMaxK: { type: 'number', description: 'list 时筛选 expectSalaryMinK ≤ 该值' },
          filterEdu: { type: 'string', description: 'list 时按学历过滤' },
          filterCity: { type: 'string', description: 'list 时按期望城市过滤' },
          filterXuexin: { type: 'string', description: 'list 时按学信网自述过滤（可查/不可查/未说/待核验）' },
          filterTechFitMin: { type: 'number', description: 'list 时筛选技术匹配度 techFitScore ≥ 该值' },
          filterValueGrade: {
            type: 'string',
            enum: ['S', 'A', 'B', 'C', 'D', 'NA'],
            description: 'list 时按性价比等级过滤（NA=面议/无薪资，不可评估）',
          },
          q: { type: 'string', description: 'list 关键词搜索（匹配 name/company/skills/note）' },
          sort: {
            type: 'string',
            enum: SORT_KEYS,
            description: 'list 排序字段',
          },
          order: { type: 'string', enum: ['asc', 'desc'], description: 'list 排序方向' },
          format: { type: 'string', enum: ['csv', 'markdown'], description: 'export 格式' },
          key: { type: 'string', description: 'config 时的字段名（criteria 字段如 starTokens / flow 的 key / highlights）' },
          value: { description: 'config 时的新值（任意 JSON）' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render(_args, value) {
          return jsonText(value)
        },
      },
      async execute(args) {
        try {
          return sanitize(await runAction(args))
        } catch (error) {
          return { ok: false, error: String((error && error.message) || error) }
        }
      },
    }),
  )

  // ---- HTTP：面板读写 ----
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: API_PATH,
      async handler(req, res) {
        await handleApi(req, res)
      },
    }),
  )
}
