# `stripComments` 修法 —— **可落笔版**（dev-10）

- 日期：2026-10-25 · 状态：**只写方案，一个文件没动**（等 lead 的「验完」信号）
- 参考树：`8f20116`（冻结清单第 5 版）。**本文行号按它现场核对过**
- 写域（获批）：`tests/wired-source.mjs`（一个文件）。**不改任何 `src/**`**
- 上游：`team/dev/t73j-fallback-batch-2026-10-25.md` §五.6 与 `v68-rows-read-plan-2026-10-25.md` §六

> **一句话**：把 `stripComments` 整个替换成带「正则字面量」态的版本；**三个改动点**
> （① 三个辅助函数 ② 整个函数体 ③ import 加 4 个符号 + `tmpdir`），外加两条断言。
> 全部数字都用**修后副本 + 真 `analyzeWiring`** 跑过，不是估算。

---

## 〇、落笔清单（改哪三处、加哪两条）

| # | 位置（`tests/wired-source.mjs`） | 改什么 |
|---|---|---|
| 1 | `133` 的 import 行 | `node:fs` 加 `mkdirSync, mkdtempSync, rmSync, writeFileSync`；新增 `import { tmpdir } from 'node:os'` |
| 2 | `151` 的 `stripComments` **整个函数**（`151-181`） | 换成 §二.2 的版本；函数前插 §二.1 的三个辅助函数 |
| 3 | `532` 之后（健全性⑤ 与「主断言」之间） | 插入两条断言：**健全性⑥**（最小复现）、**健全性⑦**（注释里的提及不算调用，人造语料） |

**不动**：`analyzeWiring`、`occurrences`、`EXPORT_PATTERNS`、`UNWIRED`（29 条一条不改）、现有的 8 条断言一字不改。

---

## 一、最小复现（3 行）—— 先红后绿的证据

```js
import { stripComments } from './tests/wired-source.mjs'
const src = 'const re = /"/g\n/* 注释 ?? 0 */\nconst y = 1'
stripComments(src)
```

| | 实测输出 | 注释被剥？ |
|---|---|---|
| **修前** | `"const re = /\"/g\n/* 注释 ?? 0 */\nconst y = 1"` | **否** ❌ |
| **修后** | `"const re = /\"/g\n\nconst y = 1"` | **是** ✅ |

机理一行：`/"/g` 里的 `"` 让状态机进了 `double` 态，此后它只在遇到下一个 `"` 时才回到代码态 ——
**整份文件剩下的注释都不再被剥**。three quotes 三种引号都触发（`/"/g`、`/'/g`、`` /`/g ``），
`/abc/g`（无引号）与真字符串不触发（实测，见 §三）。

**改动前先跑这条**：它在旧实现下必须红。这是本单唯一的「红证据」入口 ——
其余数字（72 个文件、29 个孤儿）都是**不变量**，红不出来。

---

## 二、修法

### 2.1 三个辅助函数（插在 `stripComments` 之前）

```js
/* ── stripComments 的第五态：正则字面量 ───────────────────────────────────────
   状态机原来只认 code / line / block / single / double / template，**不认识正则字面量**。
   于是 /"/g 里那个双引号会把状态机推进「字符串」，此后整份文件都在字符串里，
   后面所有注释都不再被剥（实测：src/domain/optimize/report.js 第 74 行 esc() 里的
   `.replace(/"/g, '&quot;')` 就是触发点，该文件 1349 行往后那段 JSDoc 至今没被剥）。

   判据是**前一个有意义 token**：表达式位置上出现的 / 才是正则开头，其余是除法。
   这是标准启发式（不是词法器）。已知边界写在 stripComments 的注释里，不假装没有。 */
const REGEX_PRECEDER_CHARS = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
])
const REGEX_PRECEDER_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await',
  'new', 'delete', 'void', 'throw',
])

/** 向前跳过空白，取最后一个 token：标点返回 char，标识符/关键字返回 word。 */
function prevTokenInfo(out) {
  let i = out.length - 1
  while (i >= 0 && /\s/.test(out[i])) i -= 1
  if (i < 0) return { char: '', word: '' }
  const char = out[i]
  if (!/[A-Za-z0-9_$]/.test(char)) return { char, word: '' }
  let j = i
  while (j >= 0 && /[A-Za-z0-9_$]/.test(out[j])) j -= 1
  return { char, word: out.slice(j + 1, i + 1) }
}

/** 这个 / 是正则开头还是除法？ */
function startsRegex(out) {
  const { char, word } = prevTokenInfo(out)
  if (word !== '') return REGEX_PRECEDER_WORDS.has(word)
  return REGEX_PRECEDER_CHARS.has(char)
}
```

### 2.2 整个函数替换（`151-181` 换成下面这段）

```js
export function stripComments(text) {
  let out = ''
  let mode = 'code'
  /* regex 态里是否处在字符类 [...] 中（字符类里的 / 不是正则结尾）。 */
  let inClass = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    const d = text[i + 1]
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 1; continue }
      if (c === '/' && d === '*') { mode = 'block'; i += 1; continue }
      /* **正则字面量**：只有表达式位置上的 / 才是正则开头（否则是除法）。
         少了这一支，一个含引号的正则会把状态机推进字符串，整份文件从此不再剥注释。 */
      if (c === '/' && startsRegex(out)) { mode = 'regex'; inClass = false; out += c; continue }
      if (c === "'" || c === '"' || c === '`') mode = c === '`' ? 'template' : (c === "'" ? 'single' : 'double')
      out += c
      continue
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c }
      continue
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 1; continue }
      if (c === '\n') out += '\n'
      continue
    }
    /* 正则字面量：转义整体跳过；[ / ] 进/出字符类；字符类外的 / 收尾。 */
    if (mode === 'regex') {
      if (c === '\\') { out += c + (d ?? ''); i += 1; continue }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && inClass === false) mode = 'code'
      out += c
      continue
    }
    /* 字符串 / 模板：转义要整体跳过，否则反斜杠转义的引号会提前收尾。 */
    if (c === '\\') { out += c + (d ?? ''); i += 1; continue }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) {
      mode = 'code'
    }
    out += c
  }
  return out
}
```

> 原文里 `151-181` 的那段说明性注释（「必须单趟扫描」「分两趟是不健全的」「写这段说明时我自己也踩了同一类坑」）
> **整段保留**，只在末尾补一句「第五态 + 已知边界」（见 §六）。别删 —— 那段是本仓用事故换来的。

### 2.3 为什么必须**整函数替换**，不许打行级补丁（实测踩到）

我第一版用的是 4 处 `String.replace` 行级补丁（插辅助函数 / 加 `inClass` / 在 code 态插一支 / 在 block 态后插一支）。
结果是：**3 处打上了，第 4 处静默没匹配** → 副本里 `mode = 'regex'` 存在（标记检查全过），但**没有 regex 态的处理器**，
于是进了 regex 就再也出不来 —— 复现仍然红。表面「补丁已打」，实际没生效。

**教训**：这个函数有六个态、每个态的出口都靠 `continue`，行级补丁的锚点极其脆；
整函数替换 + 替换后**跑那条复现**，是唯一能自证「改对了」的做法。
落笔时请照做：替换完先跑 §一 那三行。

---

## 三、为什么真字符串里的 `//` 不会被误判成注释（6 条反面控制，全部实测）

修复只在**新增的 `regex` 态**里做判断，**没有动**字符串 / 模板的识别 —— 所以原来的正确行为必须一条不少。
下面 6 条在修后版本上逐条实测：

| 场景 | 输入 | 修后输出 | 判 |
|---|---|---|---|
| 单引号串里的 `//` | `const url = 'https://example.com//path'` | 原样保留 `https://example.com//path` | ✅ 不剥 |
| 模板串里的 `//` 与 `/* */` | ``const t = `a // b /* c */ d` `` | 原样保留 | ✅ 不剥 |
| 正则里的 `//` | `const re = /https?:\/\//` | 原样保留（`\/` 转义先被跳过，字符类外的 `/` 才收尾） | ✅ 不剥 |
| 正则里的引号 | `const re = /['"]/g` | 原样保留，**且它后面的注释照剥** | ✅ 修好了且没牵连 |
| 除法不是正则 | `const x = a / b / c` | 原样保留（前一个 token 是标识符 → 判除法） | ✅ 不进 regex 态 |
| 正则之后紧跟真注释 | `const re = /"/g /* 要剥 */` | 正则保留、注释剥掉 | ✅ 两者都对 |

机制上为什么不会误判 **字符串**：字符串/模板走的是**自己那几条分支**（`single` / `double` / `template`），
`regex` 分支只在 `mode === 'code'` 且 `c === '/'` 且 `startsWith` 判据成立时才进入；
一旦进入，`/` 就是收尾符、`'`/`"` 只是普通字符 —— 两条路互不重叠，所以「字符串里的 `//`」这条**结构上**走不到注释分支。

**这些全部要变成断言**（§五 的 ⑥ 一起打包），不能只写在报告里。

---

## 四、`29 = 29` 是**修后**算的 —— 用真 `analyzeWiring`，同一 root

你问的那句很关键，我分成两部分答：

### 4.1 上一轮给你的「29 = 29」是怎么算的

**用我的复刻版算的**（`strip` 可注入的 `analyzeWiring` 仿写），不是真函数 —— 这一点我当时没写清楚，
现在纠正：**那一版不能当证据**，因为它复刻的 `walk` / `rel` / 过滤逻辑都是我抄的。

### 4.2 这一次：**修后副本 + 仓库真 `analyzeWiring`**，同一 root，两个方向都比

做法：把 `tests/wired-source.mjs` 复制到 `%TEMP%`，**只替换 `stripComments` 一个函数**，
然后 `import { analyzeWiring, UNWIRED, occurrences }` 自两边、用同一个 `root = 仓库根` 各跑一遍：

| 指标 | 修前（仓库现在的实现） | 修后（副本） |
|---|---|---|
| 导出总数 | 1189 | 1189 |
| 孤儿数 | **29** | **29** |
| 修后**消失**的孤儿 | — | **0** |
| 修后**新增**的孤儿 | **0** | — |
| `kind` 变化 | **0** | — |
| `testCallers` 变化 | **0** | — |
| 实测孤儿不在 `UNWIRED` 名单 | 0 | 0 |
| 名单里但实测不是孤儿 | 0 | 0 |
| 名单 `kind` 与实测不一致 | 0 | 0 |

**结论：零翻转，而且是修后算的。** `UNWIRED` 那 29 条**一条都不用动**。

### 4.3 「多剥掉的那些字节」里到底藏着什么（你问的第二半）

先纠一个数：我之前给你的「61 个文件 / `run.mjs` 少剥 40KB」是**旧树 + 只扫 src+tests + 2 字节阈值**的口径，
偏小。按现在这棵树（445 个 `.js/.mjs`，无阈值）**全量重测**：

| 范围 | 文件数 | 剥完文本**有变化** | 少掉的字节 | 行数不守恒的文件 |
|---|---|---|---|---|
| `src/**` + `index.js` | 261 | **19** | 53,609 | **0** |
| `tests/**` | 184 | **53** | 134,720 | **0** |
| 合计 | 445 | **72** | **188,329（≈184 KB）** | **0** |

**真正关键的问题**是：「这些多剥掉的字节里，有没有哪一处原本在给孤儿『续命』？」——逐条查了：

> 全部 1189 个导出 × 261 个源文件，找出「修前被判为引用、修后不再被引用」的 hit：**只有 5 条**，
> 即只有 5 个（名字 × 文件）是靠注释在续命。

| 名字 | 文件 | 少掉的 hit | 修前是孤儿？ | 修后是孤儿？ |
|---|---|---|---|---|
| `siteCooldown` | `src/domain/collect/env.js` | 3 | 否 | **否** |
| `num` | `src/domain/keywords/export.js` | 1 | 否 | **否** |
| `cell` | `src/domain/keywords/xlsx.js` | 1 | 否 | **否** |
| `asinTableCsv` | `src/web/page.js` | 1 | 否 | **否** |
| `hydrate` | `src/web/routes.js` | 3 | 否 | **否** |

五个名字在修前修后**都仍然是「已接线」**（它们另有真实调用点），所以**没有一个会翻成孤儿** ——
这与 §4.2 的「新增孤儿 0」互为印证（一个是集合层面，一个是逐 hit 层面）。

**所以：修完没有冒出新违例。** 如果冒出，按你说的我不顺手修，报给你 —— 但这次确实没有。

### 4.4 「没把真代码吃掉」的机械检验（这条比数字更重要）

对**剥完文本有变化的 72 个文件**，把修后版本写出去、逐个 `node --check`：

```
checked=72 failed=0
```

也就是说：剥掉的确实只是注释（和注释里的引号边界），**没有一个文件被剥出语法错误**。
外加：445 个文件**行数全部守恒**（`split('\n').length` 一致），说明没有整段被吞。

顺带一条自查的自我纠正：我曾看到「剥完仍含『待接线名单』」，以为机器又卡了 ——
查下来那是 `check('待接线名单里没有已经接好线的…')` 这个**字符串字面量**（本来就该保留），
真正的注释正文（`死条目，自清理断言当场要求划掉它`）已经剥干净。**字符串被保留是正确行为，不是漏剥。**

---

## 五、断言怎么写（进 `tests/wired-source.mjs`，插在 `532` 之后）

### 5.1 先说清：你要的「29 = 29 + kind 零不一致」**已经存在**，但它的盲区正是本缺陷

`536` / `548` / `559` 三条主断言合起来就是**集合相等**（不钉字面 29）：

- 「每一个零调用方导出都在名单里」→ 实测 ⊆ 名单
- 「名单里没有已经接好线的」→ 名单 ⊆ 实测
- 「分类与实测一致」→ 逐条 `equal(entry.kind, live.kind)`

**但它们只比对「实测 vs 名单」，从不检查「剥离得对不对」** —— 修前它们也是全绿的（本轮实测 8/8 绿，
而剥离是坏的）。所以它们**不能**兼任「行为中性」的守卫。

### 5.2 因此新增两条**正向对照**（都同步、都自带清理、都不钉绝对数字）

**健全性⑥ —— 最小复现变成断言（这条修前必红）**

```js
  check('健全性⑥：含引号的正则之后，注释仍必须被剥（正则字面量不是字符串）', () => {
    /* 本缺陷的最小复现：`/"/g` 里的引号把状态机推进字符串，此后整份文件的注释都不再被剥。
       **这一条在修之前会红** —— 它是唯一能红出来的证据，别让它变成永远绿的装饰。 */
    const sample = 'const re = /"/g\n/* 注释里提到的 foo( 不算引用 */\nconst y = 1'
    const stripped = stripComments(sample)
    if (stripped.includes('注释里提到')) throw new Error('含引号的正则之后的注释没被剥 —— 状态机又被推进了字符串')
    if (!stripped.includes('const y = 1')) throw new Error('真代码被吞了')
    if (!stripped.includes('const re = /"/g')) throw new Error('正则本身被改坏了（它必须原样留着）')
  })
```

**健全性⑦ —— 注释里的提及不算调用（人造语料，证明「剥离不影响架构结论」）**

```js
  check('健全性⑦：注释里提到的名字不算被调用 —— 剥离不许改变孤儿判定', () => {
    /* 人造语料，两行代码就够：
         src/a.js  真定义 loneOne
         src/b.js  先来一条含引号的正则（⑥ 的触发器），再在**注释**里提到 loneOne(
      修前：注释活下来 → loneOne 被当成「有引用」，孤儿数 0（假绿）
      修后：注释被剥 → loneOne 是孤儿，孤儿数 1
       所以这条断言的作用是「钉住剥离的语义」，不是「钉住仓库当前的 29」。 */
    const root = mkdtempSync(join(tmpdir(), 'amzn-wiring-corpus-'))
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'index.js'), 'export const x = 1\n')
      writeFileSync(join(root, 'src', 'a.js'), 'export function loneOne() {\n  return 1\n}\n')
      writeFileSync(join(root, 'src', 'b.js'),
        'const re = /"/g\n/* 这里解释为什么不再用 loneOne( 了 —— 注释不是调用 */\nconst y = re.test(q)\n')
      const corpus = analyzeWiring(root)
      equal(corpus.unwired.map(row => row.name).join(','), 'loneOne',
        '注释里的提及被当成了调用（剥离不健全）: ')
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 文件锁 */ }
    }
  })
```

实测这两条的判别力：
- ⑥ 修前红（`注释里提到` 仍在）、修后绿；
- ⑦ 修前 `loneOne` **不是孤儿**（孤儿数 0）→ 断言红；修后是孤儿（孤儿数 1）→ 绿。

### 5.3 为什么不把 29 写死

你原话是「孤儿集合仍是 29、kind 零不一致」写成可复跑断言。我用的是**上面那两条 + 现有三条不变量**，
**没有**加 `equal(result.unwired.length, 29)`，理由是本仓自己的纪律：
`docs/COORDINATION.md:3161` —— 「**不要钉绝对数字**（`SCHEMA_VERSION === 36`、`TOOLS.length === 97`）。钉**不变量**。」
写死 29 会让「真的接了一条线」（正是这份名单存在的意义）变成一次假红。

**如果你仍要那个字面数字**，一行就够，我加上去：
`equal(result.unwired.length, 29, '孤儿数变了 —— 要么接了线（改名单），要么剥离变了（查 ⑥⑦）: ')`
—— 但请同时接受：将来有人接线时，必须先删名单条目再改这个数。

---

## 六、已知边界（写进注释，也建议钉一条「声明式」断言）

`if (x) /re/.test(s)` —— **`)` 之后跟正则**这种写法，启发式会判成除法（`)` 不在 `REGEX_PRECEDER_CHARS` 里）。
代价：那一段按「代码」继续扫；只有当该正则体内含引号/反引号时才会再次失步。

- **本仓实测 0 处**（依据：72 个受影响文件修后全部 `node --check` 通过 + 445 个文件行数守恒；
  若有这种写法且正则体内含引号，剥完的文本几乎必然语法错）。
- 我**建议不钉**这条边界为断言（它不是一个值，而是一个语法形状；钉起来要写一个「反例必须仍在」的断言，
  容易变成永远绿）。**改成在 `stripComments` 的注释里明写**，与本仓其他「声明边界」的做法一致。
- 若将来真出现：修法是换真词法器；本仓零依赖，所以不引 `acorn` —— 除非有人愿意为它破例。

---

## 七、风险与回滚

| 项 | 结论 |
|---|---|
| 影响面 | 只改 `tests/wired-source.mjs` 一个文件，**不动生产代码**；`analyzeWiring` 的对外行为已实测零翻转 |
| 失败方式 | 剥坏 → 剥完的文本语法错 → 72 个文件的 `node --check` 会抓到（我在落笔后会重跑一次并把输出贴进报告） |
| 回滚 | 单文件 `git revert`/手改回原函数即可；`UNWIRED` 名单不需要跟着动（§4.2） |
| 与 v68 的关系 | 完全解耦：一个改 `tests/wired-source.mjs`，一个改 `src/store/**`；两个都动过一次即互不阻塞 |
| 已知边界 | §六。没修「`)` 后跟正则」，只声明 |

---

## 八、顺带件：`SCHEMA_VERSION` 绝对值钉了几处？

**结论：测试里只有 1 处 —— `tests/t52-product-profile.mjs:22`（`equal(SCHEMA_VERSION, 62, …)`）。**

`grep -rn "SCHEMA_VERSION\s*(===|==|,)\s*\d+|SCHEMA_VERSION\s*=\s*\d+"` 的 12 条命中里：

| 命中 | 是不是「钉死最新版本号」 |
|---|---|
| `tests/t52-product-profile.mjs:22` | **是**（唯一一处） |
| `docs/` 共 6 条（`COORDINATION.md:1113`、`COORDINATION.md:3161`、`architecture/API-B04-collect.md:1108`、`architecture/API-F14-10-report-export.md:302`、`requirements/B-12.6-…md:186`、`PLAN-v2.1-…md:194`） | 不是断言，是**当时的验收记录 / 自律条款**（「本批应有 v37/v43/v50」「不要钉绝对数字」），随文档冻结 |
| `team/dev/` 我那两份报告里共 5 条（`v68-rows-read-plan:317,358,398`、`v68-rows-read:4,226`） | 我自己的引用，不是代码 |

（合计 1 + 6 + 5 = 12，与 `grep` 命中数一致。）

**相邻的「绝对数字」要不要担心**（我顺手一起扫了，供你的 dev-11 审计参考）：

- `equal(Number(...user_version), 35 / 39 / 21 / 23 / 22 / 7 / 11 / 14 / 67)` —— 这些钉的是**夹具版本**
  （「我重放到 v35 的库应当自称 v35」），不会随新迁移漂移，**不是**病；
- `equal(step.version, 29)` / `equal(published.version, 24)` —— 钉的是**某一条具体迁移的号**，同样不漂；
- 其余全是下限式（`SCHEMA_VERSION < 48` → 报错），是本仓推荐的写法。

**关于「25 个未接入测试文件」**（只作交叉核对，**归属仍是 dev-11 的 `orphan-tests-audit-2026-10-25.md`**）：
三个数字不冲突，是三把尺子：

| 尺子 | 数 | 谁 |
|---|---|---|
| 压根没被 `run.mjs` **import** 的 `tests/*.mjs` | **28**（我复算一致） | 我 / dev-11 |
| 上面 28 份里，去掉夹具/生成器/探针后「真值得看」的 | **23** | dev-11（他的 `28 − 5`） |
| 导出 `run*Tests` 但 `run.mjs` 里**没有 `await`** 的 | **12** | 我（§八） |

那 12 份是：`keyword-role`、`qa-shop-management-2026-10-22`、`t34`、`t38`、`t39`、`t40`、`t49`、`t52`、
`t73-prompt-ui`、`t73b-false-audit`、`t74`，以及 `t8-honest` 的**部分**导出。

两个特例值得 dev-11 复核（我这两条是实测的）：

- **`qa-shop-management-2026-10-22.mjs` 其实在跑** —— 由 `tests/t30-stray-wiring.mjs` 用**子进程**接的，
  `run.mjs` 里搜不到它的 `await`，但它不是游离的（dev-11 的表里也把它标成了「子进程接线器」）；
- **`t8-honest.mjs` 是部分接线**（导出两个 run 函数，只 await 了其中一个）—— 按「文件级」算它接上了，
  按「导出级」算它还漏一个。选哪把尺子要**写在审计报告里**，别让两个数字打架。

---

## 九、落笔后的自证清单（我会在交付报告里逐条贴输出）

1. `node --input-type=module -e` 跑 §一 的复现 → 修前红、修后绿；
2. 8 条现有断言 + 新增 2 条 = **10 checks 全绿**（`runWiredSourceTests`）；
3. 72 个受影响文件 `node --check` 全过（脚本重跑）；
4. `analyzeWiring()` 孤儿 **29 = 29**、`kind` / `testCallers` 零变化（脚本重跑，贴表格）；
5. 唯一定向回归：`wired-source` 一套 + `t30-stray-wiring`（它靠子进程接 qa-shop，顺便验证没把剥离改坏）。
