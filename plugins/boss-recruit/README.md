# boss-recruit — BOSS 直聘招聘流水线插件

按岗位隔离的候选人筛选 / 记录 / 话术台账，配合**真实鼠标操作**在 BOSS 直聘网页上逐个打招呼。
插件本身**不发任何消息**——只负责判断、记录、排序筛选、给出该发的话术；发送动作由 Agent 用真实点击完成。

## 数据分级（重要，改动前必读）

本仓库**只放代码与通用模板**。任何真实业务数据一律留在本机，绝不入库。

| 内容 | 位置 | 是否入库 |
|---|---|---|
| 插件代码（`index.js` / `client.js`） | `boss-recruit/` | ✅ 入库 |
| 岗位**结构模板** + 流程步骤 + 话术模板 | `boss-recruit/templates/` | ✅ 入库（全部用 `{变量}` 占位，不含真实值） |
| 候选人台账（姓名、公司、备注、对话、评分） | `~/.dsh-boss-recruit/pipeline.json` | ❌ **只留本地** |
| 真实招聘信息（岗位名、城市、办公地点、薪资、卖点） | 属岗位实例，同上 | ❌ **只留本地** |
| 运行备份（`pipeline*.bak*`） | `~/.dsh-boss-recruit/` | ❌ **只留本地** |

**判断标准**：不会泄露「我们在招谁、给多少钱、在哪上班、接触过哪些人」的，才可以入库。
新增文件时先在 `.gitignore` 加护栏，再提交。

## 版本

- **v2.2.0**：多岗位管理与岗位×模式联动（新建/编辑/删除岗位、列表严格跟随岗位、每岗位记住自己的模式）
- **v2.1.0**：项目经历技术要求匹配度 `techFit` + 性价比 `valueScore` 两个派生评分
- **v2.0.0**（schema v3）：按岗位隔离、要求/要点/流程话术可编辑、招聘/回话/混合三模式、记录可排序可筛选、待定池、导出
- v1.0.0（schema v2）：单岗位、固定判定口径

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：注册 `recruit_pipeline` 工具 + `GET/POST /boss-recruit/api` 路由，读写台账 |
| `client.js` | Client 半：招聘流水线面板（岗位切换/新建/模式切换/要求编辑/排序筛选/评分/导出） |
| `templates/job-template.json` | 岗位通用模板：criteria 字段骨架 + 6 步流程话术 |
| `cordis.patch.yml` | bundle 插入声明 |

## 台账位置

`~/.dsh-boss-recruit/pipeline.json`（**仓库外**）

## 核心机制

### 数据隔离
- 候选人键 = `jobId::bossId`，不同岗位的候选人互不可见
- `list` / `next` / `stats` / `export` 未显式传 `jobId` 时只作用于当前岗位
- 切岗位会刷新列表、统计、筛选；切模式不动岗位

### 判定
- 硬淘汰：学历、毕业年限、工作年限、期望城市、否决方向且无必备技能证据、应届、项目关键词不命中
- **待定**（不淘汰）：仅「最低期望薪资超过岗位设定的上限」（`criteria.expectSalaryMinCapK`）一种情况，可后续回捞
- ⭐ 回捞标记：技术方向强匹配但被城市或年限淘汰者，人工优先复核

### 两个派生评分（v2.1.0，确定性纯函数）
- **`techFit`（0-100）**：必备技能覆盖 40 + 加分技能覆盖 20 + 项目关键词命中 20 + 工程深度证据 20（命中 `techDepthKeywords` 每条 4 分封顶）
- **`valueScore`（0-100）**：`techFit ÷ (期望下限 / 预算中值) × 0.8`，封顶 0–100
- 期望薪资为「面议」或缺省 → 性价比记 **NA（不可评估）**，不写 0，避免被当成极低性价比压到底部
- 等级表与公式通过 API 的 `definitions` 暴露，前后端共用一份定义

## 关键实现约束（踩过的坑，勿删）

1. `export const inject` 必须含 `'webServer'`，否则 `ctx.webServer` 为 undefined，路由静默不注册，面板报 `res.json()` 错误。
2. 路由用 `ctx.effect(() => ctx.webServer.register({...}))`，不要 `ctx.get('webServer')` + if。
3. Tool 返回值必须是无损 JSON，不能含 `undefined` / `NaN`。
4. Client 走 `window.__ModuleLoader__` + `React.createElement`（不能用 JSX）。
5. 读写台账走串行队列（`withState()`），避免并发 load-mutate-save 互相覆盖。
6. 安装时 `install_bundle` 的 target 必须传**目录路径**，传包名会去 npm 拉然后 404；改版本要先 `remove_bundle` 再 install。
7. 改完 `client.js` 需要宿主窗口 `Ctrl+R` 才会加载新代码。

## 后续迭代方向

- 更多岗位模板
- 面试排期与日历联动
- 候选人去重的更强匹配（手机号 / 简历指纹）
- 评分权重可在面板内调整

## v2.4 — 省 token 与流程提效

会话实测发现：**记账本身比对话还烧 token**。一次 `upsert` 会回吐整份候选人档案 + evaluation + techFit/value 明细（约 2–3K tokens），一轮处理十个人就烧掉 30K+，而这些数据 Agent 记完根本不会再读。

同样地，扫一遍会话列表要「截图 → 读图 → 肉眼比对台账 → 判断谁该回」，全靠 Agent 自己算，既慢又容易漏（实测首屏 8 条 vs 实际 32 条，漏了 8 个待回）。

v2.4 把这两件事下沉到插件：

### 1. 默认精简输出

`upsert` / `reject` / `star` 默认只返回「下一步动作需要的最小集」：

```json
{ "ok": true, "seq": 91, "name": "仇浩人", "stage": "resume_received",
  "stageLabel": "已收简历", "next": "发「简历回执 + 问可面试日期」话术",
  "fit": "D", "value": "NA", "gaps": ["学信网自述未确认（未说）"] }
```

要完整档案（含 evaluation / techFit / value 明细）加 `verbose=true`；单纯查某人详情用 `list` 过滤更省。

实测同一批两个候选人：**约 6000 tokens → 约 300 tokens**。

### 2. `batch` 批量记账

一次调用写多人，不再一人一次往返：

```
action=batch
batch=[{name,company,edu,gradYear,workYears,expectSalary,stage,...},
       {name,...,action:'reject',rejectReason:'freshgrad'}]
```

每条可用 `action` 决定 `upsert`（默认）或 `reject`。返回 `{count, failed, results[]}`，每条都是精简结果。

### 3. `sweep` 名单核对

把从界面采集到的会话名单一次性交给插件，直接回答「谁该处理」：

```
action=sweep
batch=[{name:"张三", preview:"[已读]您好，请问您毕业于哪一年"},
       {name:"李四", preview:"您好，请问还招人吗？"}]
hitEnd=true
```

返回：

| 字段 | 含义 |
|---|---|
| `missing` | 台账里没有 → 未入账，需要评估/登记 |
| `waitingMe` | 最后一句是对方说的 → **轮到我回** |
| `waitingThem` | 最后一句是我说的（预览以 `[已读]`/`[送达]` 开头）→ 等对方 |
| `terminal` | 已淘汰/关闭 → 跳过 |
| `hitEnd` / `warning` | 传 `hitEnd=false` 或省略会警告：本轮不得收工，必须继续下滚 |

判定依据是**预览文本前缀**，不依赖红色未读角标（角标在 UI 自动化里会把数字混进文本，不可靠）。

### 4. 系统提示内置操作纪律

`sopText` 里新增「效率纪律」一节，把这四条硬规则写进每次注入的提示词：先滚到底再 sweep、记账要 batch、默认已精简别乱加 verbose、waitingThem 不点开。

### 升级注意

- 返回结构从「全量」改成「精简」是一次**行为变更**：依赖 `candidate`/`evaluation` 字段的调用方需加 `verbose=true`。
- `sweep` 的 `jobId` 解析必须在 `const jobId = resolved.jobId` 之后，否则会抛 `Cannot access 'jobId' before initialization`（v2.4 开发时踩过一次）。

## v2.5 — 面试参数配置（岗位默认 + 候选人覆盖）

### 痛点

`interview_available`（候选人给了时间）之后，SOP 只写了「只记录、交 HR 定档」，插件里**没有"定档"这个动作**。面试时间、地点、方式散在聊天记录和 HR 脑子里，台账查不到，也没法批量通知。

### 数据模型：继承链

| 层级 | 存什么 | 说明 |
|---|---|---|
| `job.interview` | location / address / mode / contact / phone / link / extra / durationMin | 岗位级默认，一次配好全员复用 |
| `candidate.interview` | time / window + **需要覆盖的字段** | 空值一律继承岗位默认 |

这就是「批量设置」与「单独更改」能共存的原因：改岗位地点，没单独覆盖的人自动跟随；单独改过的人保持自己的值。

### 动作 `interview`

选择器三选一：

```
action=interview
name=张三                                  # 单个
names=["张三","李四"]                       # 指定多人
filterStage=interview_available             # 按状态批量（可叠加 filterCity / filterEdu）
```

参数（都可选，省略=不改）：`time` `window` `location` `address` `interviewMode` `contact` `phone` `link` `extra` `note`

- 传了 `time` → stage 自动转 `interview_scheduled`
- 没传 time 但人还没在面试阶段 → 转 `interview_pending`
- `dryRun=true` → 只渲染话术、不写库、不改 stage（先预览再发）
- 返回每个候选人的 `inviteText`，Agent 直接复制到 BOSS 发出

> `interviewMode` 而不是 `mode`：`mode` 已被「工作模式」占用（recruit/reply/all）。

### 岗位默认值配置

```
action=config key=interview value={location:"...",mode:"onsite",contact:"...",phone:"..."}
action=config key=interview.location value="深圳市南山区高新园XXX"
```

支持 `interview.location|address|mode|contact|phone|link|extra|durationMin` 单项改。

### 邀约话术模板

flow 新增 `interviewInvite`，变量：`{name}` `{jobTitle}` `{time}` `{window}` `{location}` `{address}` `{mode}` `{contact}` `{phone}` `{link}` `{extra}` `{durationMin}`。

默认模板：

```
{name}您好，简历已通过初审，面试安排如下：
时间：{time}
地点：{location}{address}
方式：{mode}
联系人：{contact} {phone}
{link}
{extra}

麻烦您回复确认一下，如果需要调整时间请提前告诉我，谢谢！
```

**空变量所在行会被整行删除**（`{link}` 没填就不会留一行空的），视频面试才需要链接。

### 落地顺序

1. HR 在面板/工具把候选人置 `interview_available` 或 `interview_pending`
2. 用 `interview` + `dryRun` 预览话术
3. 确认后去掉 dryRun 正式写入 → `interview_scheduled` → 复制话术发出

## v2.6 — SOP 数据化：可查看 / 可修改 / 可自动沉淀

### 问题

v2.5 之前 SOP 是 `sopText()` 里硬编码的字符串数组。改一句话要动代码、发版本、重装插件；而且**踩过的坑不会自动进去**——同一个错误（比如 TDZ 插入位置）会在不同会话里反复发生。

### 数据模型

SOP 从代码搬进 `state.sop`：

```js
state.sop = {
  version: 1,
  sections: [{ id, title, body, builtin, disabled, updatedAt }],  // 可编辑的最小单元
  lessons:  [{ id, text, at, hits, source }],                     // 沉淀的教训
  pending:  [{ id, at, kind, text }],                             // 自动捕获、待人工确认
}
```

- `section.body` 支持 `{变量}` 占位（`{eduMin}` `{mustSkills}` `{starTokens}` `{greetQuotaPerDay}` 等），渲染时用岗位口径替换 → **改口径不用改 SOP 文本**。
- 老台账没有 `sop` 字段会自动补默认值；升级新增的内置节也会自动补回。

### 查看与修改

```
action=sop                        # 看渲染后的全文 + 各节字数
action=sop op=list                # 只看目录
action=sop op=get  id=criteria    # 看某一节原文
action=sop op=set  id=rhythm text="..."   # 改某一节
action=sop op=add  title="..." text="..."
action=sop op=remove id=...
action=sop op=reset [id=...]      # 恢复内置（不带 id 则整份重置）
```

### 自动沉淀闭环

```
实战出问题 → 插件自动捕获 pending → 人工确认 accept → 变成 lesson → 自动注入下次提示词
```

**自动捕获钩子**：淘汰时 `rejectReason='other'` 说明现有口径没覆盖这类情况，插件自动生成一条待审观察（带候选人、公司、具体原因）。

```
action=sop op=pending              # 看待审观察
action=sop op=accept id=... text="..."  # 固化成教训（可改写措辞成可执行规则）
action=sop op=drop   id=...        # 认为没价值就丢掉
action=sop op=learn  text="..."    # 也可以直接手动沉淀一条
action=sop op=lessons              # 看所有教训（含命中次数）
action=sop op=unlearn id=...
```

**不直接改规则**是故意的：自动捕获只进 `pending`，必须人工 `accept` 才生效，避免自我污染把错误经验固化进 SOP。

### 注入

`sopText(state)` 现在渲染：岗位上下文 → 各 section（可编辑）→ **沉淀的教训（按 hits 排序，最多 20 条）** → 待审观察数量提示 → 话术。

总长超过 `SOP_MAX_CHARS`（9000）会在末尾警告，并提示用 `op=list` 看各节字数精简。

### 已知注意

- `interviewInvite` 话术含候选人级变量，SOP 里标注了「不要照抄花括号，直接用 interview 返回的 inviteText」，避免误发模板原文。

## v2.12.1 — 当前流程直接显示在面板顶部

面板顶部（当前岗位上下文下面）新增「当前流程」卡片，把**正在生效**的两套流程原样列出来：

- 「招聘流程（推荐页）· N 步」和「回话流程（沟通页）· N 步」两栏并排
- 每步一行：序号 · **动作名** · 说明
- 只读展示，右上角提示「改流程：岗位下拉 → 编辑当前岗位 → 工作流程」

## v2.12.0 — 防风控参数可视化 + 拟人点击计划 `clickPlan`

### 防风控参数全可配
岗位设置新增「防风控 · 拟人化参数（可配）」区块，12 项都能改：落点随机偏移、预移动次数、预移动间隔、到位停留、动作间停顿、读简历停留、打字逐字延迟、点击前先滚动概率、看了不打招呼比例、切换页面概率、验证码冷却、单日硬上限。

### 拟人点击计划
新增动作 `clickPlan(x, y)`：给定控件坐标，按当前 humanize 参数**现算出**一串动作——

1. N 次预移动（每次随机落在 ±70px，中间等 waitMs）
2. 移到目标点（已按 `clickOffsetPx` 随机偏移 ±N px）
3. 停 `hoverDwellMs` 再按下
4. 点完停 `postPauseMs`

返回 `steps[]`，照顺序执行即可；再按配置概率前置一次滚动制造分叉。**不再直接点控件中心。**
工作流程第 7 步与 SOP 拟人化章节都已改成「先 clickPlan 再执行」。

## v2.11.0 — 工作流程可视化 + 可改（按动作）

岗位口径新增 `criteria.workflow`：两套动作序列 `recruit`（推荐页）/ `reply`（沟通页），每一步是一个**动作**（动作名 + 说明），顺序即执行顺序。

- 渲染进 system prompt：「工作流程·招聘流程（推荐页）」和「工作流程·回话流程（沟通页）」，逐条编号，明确「按顺序执行，不可跳步」。
- 面板岗位设置新增「工作流程（可改）」区块：编号圆点 + 动作名 + 说明，框与框之间用 ↓ 连接；支持 ↑↓ 排序、✕ 删除、＋新增动作；招聘/回话两个 tab 切换。
- 支持 `{screenMinReadSec}` / `{replyMaxChars}` 变量。
- 默认招聘流程 9 步：确认岗位筛选 → 滚到底 → 点开卡片进在线简历 → 读项目经验 → screen 登记 → 综合评估 → 点打招呼 → markGreet 1 → 回 pace 查间隔。
- 默认回话流程 8 步：确认岗位筛选 → chatScope → 扫会话列表 → 打开会话读上下文 → 按回话规则判断 → 逐字输入发送 → log 记录 → 更新 stage。

## v2.10.0 — 两条硬闸门：不看简历不许打招呼 / 不选岗位不许回话

用户要求「强制约束」，所以做在记账层——流程不对，账记不上。

### ① 打招呼前置 `screen`
新增动作 `screen(name, company, resumeRead, projects, score, decision)`：登记「已点开在线简历并读完项目经验」。

- `resumeRead` 必须为 true，否则拒绝。
- `projects` 至少 20 字，必须是简历里的真实内容（事后可抽查）。
- `markGreet` 与 `upsert stage=greeted` 都会校验：有 screen、decision=greet、距登记满 `screenMinReadSec`（默认 20 秒）。任一不满足直接报错、不计数。

### ② 回话前置 `chatScope`
新增动作 `chatScope(pageJobLabel)`：声明沟通页当前选中的岗位。

- 页面标签与当前岗位 `jobTitle` 不匹配（去括号空格后子串比对）→ 报错，要求先切筛选。
- `log`（回话记录）必须先有作用域，且默认 `chatScopeTtlMin`（120 分钟）内有效。

SOP 同步新增两节「打招呼前置」「回话前置」，带 `{screenMinReadSec}` / `{chatScopeTtlMin}` 变量，面板可改。

## v2.9.0 — 回话边界改成「提示词规则」，由 AI 判断

之前的 `replyGuard` 是关键词黑名单：命中就硬拦。方向不对——**要的是把边界写进提示词，让 AI 自己判断**，关键词只适合当兜底。

- 新增岗位口径 `criteria.replyRules`（自然语言 Markdown，支持 `{replyMaxChars}`），渲染 system prompt 时**原样注入**，位置在「当前工作模式」之后、SOP 各节之前，标题「回话规则（在「沟通」页发任何消息前必须遵守）」。
- 默认 12 条规则：不主动约面试、不谈预算/不评价薪资、不承诺答复时间、不做保证性承诺、不索要微信电话、不谈派驻周期、按阶段只发对应模板、拿不准就不回复交人工、不闲聊不发散、字数上限、外包不考虑直接记淘汰、薪资细节只重复区间。
- `replyGuard`（关键词）降级为**可选兜底，默认关闭**；关闭时 `checkReply` 一律放行并说明「由提示词规则判断」。
- 面板岗位设置新增「回话规则（进提示词，AI 按它判断）」大文本框，下面才是「关键词兜底（可选，默认关闭）」。

## v2.8.1 — 回话边界加面板 UI

v2.8.0 的 `replyGuard` 只能靠 `config key=replyGuard` 命令改，面板里没有入口。本版补上：

岗位设置面板（招聘流水线 → 岗位下拉 → 编辑）里，话术流程下面新增「**回话边界（Reply Guard）**」区块：

- 启用校验开关
- 单条字数上限（默认 80，超出即拦）
- **禁止词**（命中即拦，红字，用「、」或换行分隔）
- **提醒词**（只提示不拦，橙字）
- 底部固定提示：改完要点「保存到 Host」

数据仍然落在 `criteria.replyGuard`，和 `config key=replyGuard` 是同一份，两边改都生效。

## v2.8.0 — 话术可编辑修好 + 回话边界（Reply Guard）

### 话术改了没保存
根因是交互不是存储：`保存到 Host` 按钮在岗位设置卡片**顶部**，话术流程在卡片**最底部**，中间隔几屏；改完话术直接点「收起」，改动就没了。后端 `saveJob` 本身一直是好的（已验证：POST 后 GET 与磁盘都生效）。

修复：
- 底部新增一条 **sticky 保存栏**（保存 + 收起 + 未保存提示）。
- 顶部与底部都显示 `● 有未保存改动`；收起时未保存会 confirm 拦一次。
- 话术流程支持 **＋新增步骤 / ↑↓ 排序 / ✕ 删除**。

### 回话边界 replyGuard（可改）
新增岗位口径字段 `criteria.replyGuard`：`enabled` / `maxChars`（默认 80）/ `forbid`（违规词，命中即拦截）/ `softWarn`（提醒词）。

新增工具动作 **`checkReply`**：发回话前先把要发的话过一遍，返回 `pass / violations / tooLong`。`pass !== true` 就不许点发送。

默认黑名单覆盖 6 类：约面试、谈预算/评价薪资、承诺答复时间、保证性承诺、索要微信电话、谈派驻周期。SOP 同步新增「回话边界」章节，面板可查看可修改。

## v2.7.0 — 节奏硬闸门（2026-10-21 风控事故后补）

事故：推荐页一口气连点 8 条「打招呼」、事后再用一个 `markGreet count=8` 补记，pace 的间隔/浏览闸门全部绕过，触发 BOSS「检测到第三方辅助工具」，web 端登录被限制 24 小时。

修复：
- `markGreet` **只接受 1 条**；`count > 1` 直接报错，错误信息里写清正确单条流程。
- `pace` 新增 `nextAction`（单条可执行动作序列）、`gap`、`dwell`，把「看简历 → 判定 → 打招呼 → 立刻记账 → 再查间隔」变成唯一合法路径。
- `batch` 一次写入多条 `greeted` 时返回 `pacingViolation` 告警（数据照存，但明确标记这是危险操作）。
- `browseBeforeGreetMin` 默认 5 → **1**（`browseBeforeGreetMax` 10 → 3）：原值意味着每条招呼前要浏览 5 张，实际不可执行，闸门等于不存在；改为 1 正好等于「每条招呼前先看一份在线简历」的质量要求。

### 拟人化操作规范（可配置）

新增岗位口径字段 `humanize`（`criteria.humanize`），默认值见 `HUMANIZE_DEFAULT`，`pace` 每次原样返回，可用 `config key=humanize value={...}` 覆盖：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `clickOffsetPx` | 15 | 落点在控件中心 ±N px 内随机 |
| `preMoveCount` | 2 | 点击前先做 1~N 次预移动，制造 mousemove 轨迹 |
| `preMoveDelayMs` | [120,420] | 预移动之间的随机停顿 |
| `actionPauseMs` | [600,1800] | 连续动作之间的随机停顿 |
| `hoverDwellMs` | [300,1200] | 鼠标在目标上的停留 |
| `scrollBeforeClick` | 0.35 | 点击前先滚动一下的概率 |
| `browseDwellSec` | [20,40] | 点开在线简历后的阅读停留 |
| `skipRate` | 0.15 | 「看了但不打招呼」比例，制造行为分叉 |
| `wanderRate` | 0.1 | 切去沟通页再切回的概率 |
| `typeCharDelayMs` | [60,160] | 打字逐字延迟 |
| `verifyCooldownMin` | 30 | 遇到验证码后的强制冷却分钟 |
| `dailyHardCap` | 40 | 单账号单日硬上限 |

同时新增 SOP 内置章节「拟人化操作规范」（面板可查看可修改）；那 9 条是硬要求，不是建议。

## v2.6.1 — 面板补齐：SOP 抽屉 / 面试编辑 / 行选择 / 改状态

### 审计发现的真实问题

用脚本比对「后端能做什么」和「面板实际能发什么」：

- 后端 `runAction` 支持 **28** 个动作，POST 白名单只接了 **6** 个，面板真正会用的只有 **6** 个。
- 最严重的缺口：**`upsert` 没接** → 面板改不了状态、改不了备注、改不了任何字段，等于只读台账（除了打星和切模式）。
- 另有 `log`、`reject`、`interview`、`sop`、`interviewDefaults` 都只有后端没有前端。

### 后端

- POST 白名单补齐：`upsert` / `log` / `reject` / `interview` / `interviewDefaults` / `sop`（全部复用 `runAction`，零重复实现）。
- `decorate()` 增加 `interview`（原始值）与 `interviewAt` → 面板才能看到面试参数。
- `jobPublic()` 增加 `interview` → 面板拿到岗位级默认值。
- `sop op=list` 同时返回 `lessons` / `pending` 明细，面板一次请求拿全。

### 前端

| 功能 | 位置 |
|---|---|
| **行选择** | 表格首列 checkbox，表头可全选 |
| **批量操作条** | 选中后顶部出现：已选 N 人 · 设面试 · 批量改状态 · 清除 |
| **面试列** | 每行一个按钮，未设置显示「设置」，已设置显示时间并高亮；点击打开弹层 |
| **面试弹层** | 时间/时间窗/方式/地点/地址/联系人/电话/视频链接/附加说明；「预览话术」走 `dryRun` 不写库；留空项继承岗位默认 |
| **状态下拉** | 状态列改成原生 select，直接改 stage（走 `upsert`），旁边显示下一步提示 |
| **📋 SOP 抽屉** | 工具栏按钮 → 右侧抽屉：分节折叠编辑、恢复内置、教训列表（可增删）、待审观察（固化/丢弃） |

### 为什么之前「看不到」

前端代码更新后，浏览器里的页面还是旧的 bundle —— **必须刷新页面（F5 / Ctrl+R）** 才会加载新 UI。
