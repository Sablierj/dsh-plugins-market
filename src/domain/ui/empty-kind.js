/**
 * domain 的 `empty.kind` → 页面四态的**显式映射表**。
 *
 * ## 为什么需要它
 *
 * domain 里的空切片长这样：`empty: { kind: 'no-run-view', text: '…' }`。
 * 那个 `kind` 是**domain 自己的词**（`no-run` / `no-gates` / `not-modelled` …），
 * 与页面的四态（`none` / `not-recorded` / `no-source` / `filtered`）是两套词汇。
 *
 * 页面拿到 domain 的文本时，不能自己"看着像"就贴一个四态 kind —— 那是页面替 domain
 * 下判断，正是这套四态反复在治的病（「还没跑过」被写成「答案是 0」之类的压缩）。
 * 所以映射写成一张**表**，由 domain 拥有：改了 domain 的 kind 就得改这里，
 * 而 `tests/empty-kind-map.mjs` 会在漏映射时变红。
 *
 * ## 为什么未映射返回 null 而不是兜底
 *
 * 兜底成 `not-recorded` 会让「我们不认识这个 kind」看起来像「还没记录」——
 * 那是把**代码缺陷**伪装成**数据状态**。返回 null，调用方就保持原样的文本渲染，
 * 于是漏映射是**看得见的**（有测试），而不是被一句谎话盖住。
 *
 * ## 一句话记住
 *
 * `measured-zero` 与 `no-match` 是最容易被写错的两种：
 *   measured-zero —— 量过了，结果是 0（`none`），不是"还没量"（`not-recorded`）
 *   no-match      —— 有数据但这条筛掉了（`filtered`），不是"库里没有"
 *
 * ## 只有表，没有查表函数
 *
 * 页面脚本是**一个模板字面量**，没有模块系统，所以页面拿到的是这张表被**注入**的副本
 * （page.js 里 `const DOMAIN_EMPTY_KIND_TO_UI = ${embed(...)}`），由页面的 sliceEmpty()
 * 直接查。如果在 domain 再导出一个查表函数，那个函数**没有任何生产调用方** ——
 * `tests/wired-source.mjs` 会把它点出来（它确实点出来了），而一个只被测试用的导出
 * 就是死代码。
 */

/** domain kind → 页面四态。没列在这里的一律视为未映射。 */export const DOMAIN_EMPTY_KIND_TO_UI = {
  /* 「量过了，答案是 0」 */
  'measured-zero': 'none',

  /* 「有数据，但当前筛选一条都没留下」 */
  'no-match': 'filtered',

  /* 「本仓没有这一类来源」 */
  'not-modelled': 'no-source',

  /* 其余都是「这一轮/这一次还没产出」—— 不是数据缺，是动作还没发生 */
  'no-run': 'not-recorded',
  'no-run-view': 'not-recorded',
  'no-strategy': 'not-recorded',
  'no-plan-check': 'not-recorded',
  'no-gates': 'not-recorded',
  'no-review': 'not-recorded',
  'no-evidence': 'not-recorded',
  'no-drafts': 'not-recorded',
  'concept-not-started': 'not-recorded',
  'no-current-context': 'not-recorded',
  'not-recorded': 'not-recorded',
}
