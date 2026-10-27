/**
 * P3-5 空态的统一约定（页面端）。
 *
 * ## 为什么最后做的是"空态约定"而不是"表格组件"
 *
 * 原计划是统一列表组件。核过之后放弃了，理由写在下面，也写在提交信息里：
 *
 *   · 页面里有 **80 处手写 `<table>`**，各自还带着不同的列宽、勾选框、行点击。
 *     一次性重写是改行为，而当前会话**无法在运行中的 DSH 里验证结果**（重载要重启）。
 *     按交付铁律，这种"改完看不见"的大重构不做。
 *   · 更关键的是：**表格的分歧大多不是缺陷**。一个是给 agent 读的文本表
 *     （`tools/render.js` 的 `table()`），一个是给人看的 DOM 表，它们本来就该不同。
 *     把它们强行统一，只会让两边都变差。
 *
 * 但有一个**真实的、可量化的一致性缺口**值得修：68 处 `<div class="empty">` 的措辞
 * 各写各的，而且分成两种质量——
 *
 *   好的：`competitor.js:25` 用 `comp.reason`，把**服务端给的原因**原样显示；
 *   差的：`competitor.js:115` 写死「没有可分类的关键词。」，
 *         读的人分不出是"本来就没有关键词"还是"筛掉了"。
 *
 * 所以这里做的是**约定 + 助手**：把"四种没有"固定成四个 kind，谁写新的空态就用
 * `emptyState(kind, ...)`，至少保证**同一个意思在不同页签上是同一句话**，
 * 而且不会丢掉原因。
 *
 * ## 四种"没有"（与 `docs/architecture/four-state-inventory.md` 同一套）
 *
 *   `none`       读到了，答案是 0 —— 「一条都没有」
 *   `not-recorded` 还没记录过，可以补 —— 「还没有…」，要带下一步
 *   `no-source`  本仓没有这类来源 —— 「本仓没有…来源」，不能建议去补
 *   `filtered`   有数据但被筛选条件挡掉了 —— 要给出怎么放宽
 *
 * 把 `none` 与 `no-source` 混成一句「暂无数据」，正是这个仓反复拒绝的那件事。
 */

/** 四种空态的 id。写新空态时必须选一个，不许自己造第五种。 */
export const EMPTY_KINDS = ['none', 'not-recorded', 'no-source', 'filtered']

/**
 * 生成一个空态块。
 *
 * @param kind    `EMPTY_KINDS` 之一
 * @param subject 缺的是什么，例如「采集任务」「关键词」
 * @param next    下一步做什么（`not-recorded` / `filtered` 必填）；
 *                `no-source` 时**不许**给建议，因为没有来源可补
 * @param reason  服务端给的原因（有就原样显示，优先于拼出来的句子）
 */
export function emptyState(kind, { subject = '数据', next = null, reason = null, allowMarkup = false } = {}) {
  if (!EMPTY_KINDS.includes(kind)) {
    throw new Error(`未知的空态类型 ${JSON.stringify(kind)} —— 只能在 ${EMPTY_KINDS.join(' | ')} 里选`)
  }

  /* ⚠️ `allowMarkup` 是一个**出口**，不是一个默认。
   *
   * 默认必须转义 —— 空态文案里通常混着用户数据或库里的值（ASIN、关键词、错误信息），
   * 一条不转义的路径就是一个 XSS 口子，而且它藏在一个看起来最人畜无害的函数里。
   *
   * 但有一批既有的空态**本来就用 `<strong>` 断句**（例如「这是<strong>一个真实的结论</strong>」），
   * 一律转义会把它们改成平文，那是为了统一而降低可读性。所以开一个显式出口：
   * 调用方传 `allowMarkup: true` 就是在声明「这段文案是静态的，里面没有用户数据」。
   *
   * 判据（调用方自查，没有机器校验）：传进来的每一个插值都必须是**你自己写的字面量**
   * 或**已经 escapeHtml 过的值**。混进一个未转义的库值，这个口子就破了。
   */
  const allowMarkupFlag = allowMarkup === true

  /* 服务端给的原因优先：它是**观测到的那句话**，比这里拼的模板更接近事实。
     但即使有 reason，也仍然要带上 kind 的语义，否则页面无法区分四种"没有"。 */
  /* 中英相邻要留空格：「Agent 运行」直接拼会得到「还没有Agent 运行。」。
     只在首字符是 ASCII 字母或数字时补 —— 中文主语不需要，补了反而难看。 */
  const spacedSubject = /^[A-Za-z0-9]/.test(String(subject)) ? ` ${subject}` : String(subject)
  const hasReason = reason !== null && String(reason).trim() !== ''
  const head = hasReason
    ? String(reason).trim()
    : {
      none: `没有${spacedSubject}。`,
      'not-recorded': `还没有${spacedSubject}。`,
      'no-source': `本系统没有${spacedSubject}的来源 —— 这一类数据采不到，补也补不出来。`,
      filtered: `${spacedSubject}有，但当前的筛选条件一条都没留下。`,
    }[kind]

  const parts = [head]
  if (kind === 'no-source') {
    /* 明确**不**给下一步：建议"去补"一个本仓没有的来源，比不说更坏。 */
    parts.push('这不是"还没做"，是本仓不提供这个来源。')
  } else if (next !== null && String(next).trim() !== '') {
    parts.push(String(next).trim())
  } else if (kind !== 'none' && !hasReason) {
    /* not-recorded / filtered 却没说下一步：这本身是个缺陷，要说出来而不是静默省略。
       但**给了 reason 就不补这句**：reason 是一句完整的话（常常自己就写明了下一步），
       在后面再挂一句"（还没给下一步做什么）"会把一句完整的话说成一句残缺的话。 */
    parts.push(kind === 'filtered' ? '（放宽筛选条件就能看到）' : '（还没给下一步做什么）')
  }

  return {
    kind,
    text: parts.join(' '),
    /** 页面渲染用；`kind` 同时作为 `data-empty-kind` 落进 DOM，便于测与样式区分。 */
    html: `<div class="empty" data-empty-kind="${kind}">${allowMarkupFlag ? parts.join(' ') : escapeForHtml(parts.join(' '))}</div>`,
  }
}

/** 与页面里那个 `escapeHtml` 同语义。这里自带一份是因为本模块在服务端也要能用。 */
function escapeForHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
