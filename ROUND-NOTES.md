# 招聘流程问题记录（供插件优化）

> 每轮处理沟通中候选人的过程中遇到的问题，按轮次记录。

---

## 2026-10-28 第 1 轮（14:11-14:27）

**范围**：只处理「沟通中」tab（按新流程：mode reply → flow → chatScope → observe → 逐个处理 → log）

**处理结果**：7 人
| 人 | 动作 | 结果 |
|---|---|---|
| 蒋梦瑶 | 收附件（更新版）| 已收简历 |
| 杨艺 | 收附件 | 已收简历 |
| 申鹏 | 收附件 | 已收简历 |
| 曾剑 | 收附件 | 已收简历 |
| nuyoah（李宛烨）| 收附件 | 已收简历 |
| 何敏东 | 回「可查非计算机专业」→ 要简历 | 已索简历 |
| 杨毅 | 收附件 + 回安抚话术 | 已收简历 |

---

## 遇到的问题（7 条）

### ① log 不推进 stage，必须额外调一次 upsert

**现象**：调 `log(dir=in, summary=...)` 返回 `logs: 1`，但 `stage` 仍是原值（如 `qualified`）。必须再调 `upsert(stage=resume_received)` 才推进。

**影响**：每人多一次工具调用；如果忘了调，台账里「已收简历」的人是 `qualified`，后续筛选会漏。

**建议**：`log` 支持 `stage` 参数（其实代码里已有 `if (args.stage)` 分支），或者在 `dir=in` 且检测到简历附件时自动推进。更根本的做法是**收简历与 log 合并成一个动作**。

---

### ② 搜索框对部分会话搜不到

**现象**：搜「曾剑」「何敏东」→ 显示「没有相关联系人」，但列表里明明有这两个人。

**影响**：按插件文档「用搜索框定位、别按坐标硬点」的做法失效，只能退回按坐标点。

**建议**：`nextInbox` 返回 `searchKeyword` 时，同时给出「搜索不到则按列表第 N 位点击」的兜底；或插件提供 `locate(name)` 动作返回可用坐标。

---

### ③ 列表点击命中率低

**现象**：点列表第 N 位 → 打开的是第 N-1 或第 N+1 位的人。多次点错（蒋梦瑶 → 点了何敏东位置 → 打开蒋梦瑶；杨毅 → 打开蒋梦瑶）。

**原因**：BOSS 会话列表按最后消息时间实时重排，点击瞬间列表已变。

**影响**：每次点完必须看标题栏确认，否则会操作错人（历史上有过误拒简历的教训）。

**建议**：
- 插件层面：`observe` 时记录每个人的「最后消息时间 + 头像哈希」，Agent 每次点击前用它校验
- 或者提供「搜索 + 精确匹配」的替代路径（见 ②）

---

### ④ tab 坐标易点错

**现象**：点「沟通中」tab 实际落在「新招呼」（两者只差 67px）；点「已获取简历」落在「已交换微信」。

**影响**：误入其他 tab，浪费轮次。尤其「新招呼」和「沟通中」相邻，误点后看到的是完全不同的人。

**建议**：`chatTabs` 返回每个 tab 的坐标或 DOM 选择器，而不是只返回语义说明。

---

### ⑤ 页面偶发失去响应，需 F5 刷新

**现象**：连续点击列表 3-4 次后，点击不再生效（页面无变化）。F5 刷新后恢复。

**影响**：不清楚是 BOSS 前端状态问题还是浏览器问题；只能靠刷新，刷新后 tab 回到「全部」需重新切换。

**建议**：插件在 `chatTabs`/`observe` 返回值里带一个 `health` 字段（如连续 N 次点击无响应 → 提示刷新）。

---

### ⑥ 候选人只发简历不答硬项

**现象**：杨毅、曾剑都没在聊天里回答「哪年毕业、什么专业、学信网可查吗」，直接发附件；何敏东只回了「可查非计算机专业」（没说毕业年份）。

**影响**：台账的 `gradYear` / `xuexinSelf` 只能从附件里读，而附件是 PDF/Word，需要额外读。

**建议**：`log` 增加 `missing` 字段记录「哪几项硬项还没确认」，`nextInbox` 把这些列出来当待办。

---

### ⑦ 候选人反复催回复，容易重复客套

**现象**：杨毅发「不合适就回复一下」→ 我回「收到您的简历…有进展第一时间联系您」→ 他又发「没有也回复一下」。

**影响**：按 `chatTabs` 的 forbidden「重复回客气话」，不该再回；但不回又显得失礼。

**建议**：`checkReply` 增加「同一人 24 小时内已发过回执」的检查，返回 `duplicate: true` 提示不要再发；`log` 里记录「已回过执」的时间戳。

---

## 本轮验证通过的（新流程的好处）

1. **mode reply 前置**：2.26.1 的闸门确实拦住了「在推荐页推沟通阶段」，没有误操作
2. **chatScope**：页面标签「测试工程师」与岗位口径一致，一次通过
3. **observe**：一次性记录 8 人名单，避免漏人
4. **log 记录**：7 条 log 全部落库（`dialogCount` 从 0 变成对应条数）
5. **标题栏确认**：每次点完都核对，本轮 0 次点错人（虽然点了 3 次才命中）

---

## 2026-10-28 第 2 轮（14:29-14:37）补充

### 最重要的认知修正（第 ⑩ 条）

**「沟通中 → 未读」是一个动态列表：点开即从列表消失。**

我第一轮把「这个会话我处理过」当成了「它没有新消息」，于是看到列表里全是熟面孔就判定「本轮无未读」——**这是错的**。它们出现在「未读」筛选里，正是因为有新消息没被读过。

**证据**：逐个点开 6 个会话后，切走再切回「未读」，列表变成「暂无牛人」。

**影响**：如果没有这条修正，会持续漏处理所有「候选人在我上次回复后又说了话」的会话。

**建议**：插件在 `observe` 的返回里直接给出「未读会话数」，并在 `nextInbox` 里按「最后一条是谁说的」排序——不要把「是否已处理」和「是否已读」混为一谈。

---

### 新增问题

### ⑧ 台账状态与实际不一致（已收附件但台账停在旧状态）

**现象**：
- 曾女士：附件《软件测试工程师-曾清.pdf》昨天就收到了，台账却是 `resume_requested`
- 刘聪：附件《刘聪-软件测试.pdf》昨天收到，台账是 `greeted`

**影响**：audit 看不出来（它只查 dialogCount 和 mode），但统计和筛选会失真。

**建议**：`audit` 增加一条——「会话里已有附件消息，但台账 stage 不在 resume_received 及之后」。

### ⑨ 「未读」子标签坐标易点错

**现象**：「全部 / 未读 / 牛人已读未回」三个标签横向只差约 30px，点 (340,183) 落在「全部」与「未读」之间，连点两次都没切过去，最后靠 zoom 放大才定位到「未读」在 x≈365。

**建议**：`chatTabs` 返回每个子标签的坐标，或者插件提供「按语义筛选」的工具调用（不依赖坐标）。

---

## 第 2 轮处理结果

| 人 | 对方最后一句 | 处理 | 台账 |
|---|---|---|---|
| 钟雨蒙 | 「26年软件技术」 | 确认 2026 届 → **淘汰** | rejected(freshgrad) |
| 温剑锋 | 「好的」 | 礼貌收尾，不回 | 已收简历（不变）|
| 曾女士 | 「好」 | 礼貌收尾，不回 | **resume_requested → resume_received** |
| 孙康 | 「谢谢」 | 礼貌收尾，不回 | 已收简历（不变）|
| 刘聪 | 「辛苦了」 | 礼貌收尾，不回 | **greeted → resume_received** |
| 邬子衡 | 「辛苦了」 | 礼貌收尾，不回 | 已收简历（不变）|

**「未读」列表现已清空（显示「暂无牛人」）。**

---

# 2026-10-29 推荐页招聘（运营岗 · 首次）

## 本轮处理

| 人 | 方向 | score | 结果 |
|---|---|---|---|
| 林华 | member/growth | 78 | ✅ 已打招呼（2020.04-2021.11 会员体系负责人 1年7个月）|
| 姚志鹏 | community | **88** | ✅ 已打招呼（大疆+追觅，0→1 搭 40 个创作者社群、10 万私域用户、Pocket4 带动 2000 万）|

本轮 2/15，日额度 2/80。

## 推荐页特有的新问题

### ⑪ `markBrowse` 必须手动补，否则 pace 一直卡「先浏览」

**现象**：读完林华、姚志鹏两份在线简历后调 `pace`，`browses` 仍是 0，`nextAction` 一直提示「先浏览牛人卡片再打招呼（本轮还差 1 张）」。

**原因**：看简历发生在浏览器里，插件看不到；`browses` 只能靠 `markBrowse` 显式登记。

**影响**：不补记就一直发不出招呼，而且**看不出为什么**——`nextAction` 说的话和实际做过的事对不上。

**建议**：`screen` 成功登记时顺带 `browses += 1`（读在线简历本来就是它登记的），不要让 Agent 记两次。

---

### ⑫ `markGreet.nextWaitSec` 与 `pace.waitSec` 语义混淆

**现象**：`markGreet` 返回 `nextWaitSec: 576`（招呼间隔），立刻调 `pace` 却返回 `waitSec: 15`、`nextAction: 等 15 秒`。两个数字差 38 倍。

**原因**：`pace.waitSec` 反映的是**当前阻塞项**（browse 没满足时 = 15 秒），不是招呼间隔。真正卡住的是 browse。

**影响**：容易误判「只要等 15 秒」，实际要等 6-10 分钟。

**建议**：`pace` 把两个约束分开列——`greetGap: {elapsed, required, remain}` 和 `browseNeed: {done, target, remain}`，让 Agent 一眼看出卡在哪。

---

### ⑬ 简历侧边栏打开后，左侧列表被遮罩挡住

**现象**：点开在线简历后，左侧候选人列表变暗（覆盖层），此时点列表项无反应。必须先关侧边栏（点 X 或点左侧灰色区域）才能切下一个人。

**影响**：不先关会以为「点击没生效」，反复点同一位置。

**建议**：`screen` 之后给一句提示「关掉侧边栏再切下一位」。

---

### ⑭ `clickPlan` 的 scroll 步骤会让按钮位置偏移

**现象**：`clickPlan(1003, 165)` 返回的序列第一步是「按配置概率先滚一下再点」，scroll 执行后按钮从 (1003,165) 移到 (1001,171)，按原坐标点击落空，必须补点一次。

**原因**：scroll 改变了页面滚动位置，视口内元素跟着移动。

**建议**：`clickPlan` 如果决定插入 scroll，坐标应在 scroll **之后**再取；或者不让 scroll 参与打招呼这种精确点击。

---

# 2026-10-29 v2.29.0 拟人化行为增强

## 背景：用户提的三个问题

1. 「模型分析一次要 20-50 秒，能不能不用刻意设间隔」
2. 「滚动次数建议随机，可以多滚几下」
3. 「点击坐标要有偏差，围绕中心点画圆」

## 第 1 点的澄清（重要）

**风控看的是浏览器事件，不是模型思考时间。**

| | 模型分析 30 秒 | 真人读简历 30 秒 |
|---|---|---|
| 浏览器状态 | 完全静止 | 持续有事件 |
| 风控看到 | 30 秒死寂 → 突然打招呼 | 30 秒活跃操作 → 打招呼 |

**连续 15 次「精确死寂 30 秒 + 立即打招呼」比随机长间隔更像机器**，因为它是固定节奏。

**但模型思考的时间不是负债，是资产**——页面停留 60-90 秒本来就是「认真看简历」的信号。
关键是这 90 秒里要有几次真实滚动，而不是「死寂 90 秒突然打招呼」。

所以改成：**分段滚动**，让模型思考夹在两次滚动之间。

## 改动

### clickPlan 弧线轨迹

| 项 | 原来 | 现在 |
|---|---|---|
| 路径 | 2 段直线 | 二次贝塞尔弧线，采样 8-14 点 |
| 控制点 | 无 | 垂直偏移 5-30px，正负随机 |
| 速度 | 固定 waitMs | 先快后慢（8→42ms） |
| 过冲 | 无 | 20% 概率超 5-10px 再回拉 |
| 落点 | 精确目标 | ±2px 微抖 |

### 去掉 scrollBeforeClick（默认改 0）

它会把页面滚动、按钮跟着移动——正是 ROUND-NOTES ⑭ 记录的「点了没中」根因。

### readPlan 随机 + 分段

| 项 | 原来 | 现在 |
|---|---|---|
| times | 固定 3 | 区间随机 [3,9] |
| 滚动量 | 2-4 行 | [2,6] |
| 停顿 | 0.8-2.0s | [0.6-3.0s] |
| 分段 | 无 | partSize（默认 3），支持 times/part 参数 |

### 其他

- skipRate 0.15 → 0.2
- wanderRate 0.1 → 0.15
- 新增 humanize.mouseArc 配置块

## 实测

**clickPlan(700,400 → 1003,165)**：
- 15 步，11 个弧线点
- 控制点 (837,262)，偏离直线中点 18px（确实是弧）
- 速度 11→45ms
- 过冲 (1004,147) → 回拉 (998,152)
- 落点 (997,153)

**readPlan(times=8, partSize=3, part=1)**：
- totalParts=3, isLast=false
- 滚动量 3/5/2，停顿 1573/2594/806ms
- nextHint 提示第 2/3 段

## 预期节奏

```
每条：开卡 5s + 分段阅读 60-90s（模型思考夹在中间）+ 打招呼 10s + 随机间隔 0-90s
     ≈ 2-4 分钟
15 条 ≈ 30-60 分钟（原来 2-3 小时）
```

## 风险声明

这是概率游戏，不是保证。弧线轨迹消除的是「轨迹特征」这一项，如果 BOSS 检测的是
频率分布、账号行为历史或其他维度，轨迹再像也没用。

**建议**：改完后先跑 15 条观察，有验证码/限流立刻回调间隔。
---

# 2026-10-29 运营岗第 1 轮（11/15）暴露的问题

## 已修（v2.30.x）

### ⑮ markGreet 只加计数器，不碰候选人记录

**现象**：打完 5 条招呼，`markGreet` 返回 `greeted: 5` 看着正常，但台账里 5 个人全停在 `stage=new`、`greetedAt` 全空。

**原因**：`markGreet` 只操作 `todayCount`（计数器），没有任何写 `state.candidates` 的代码。要让台账推进，得 Agent 再手动 `upsert stage=greeted` 一次。

**连锁**：那次 upsert 又被 `chatScope` 拦死（见 ⑯），于是台账一直是 new。

**已修 2.30.2**：markGreet 打完直接把 stage 推进到 greeted + 写 greetedAt，返回值带 `seq`（null = 台账没这个人，说明漏了 screen）。

---

### ⑯ requireChatContext 把推荐页阶段也要求 chatScope

**现象**：`batch` 补 5 条 `stage=greeted` 全部报错「chatScope 记录的是另一个岗位」。

**原因**：`requireChatContext` 无条件调 `requireChatScope`。但 `greeted`/`new`/`qualified`/`pending`/`rejected`/`stale` 都发生在**推荐页**，推荐页根本没有「职位下拉筛选」这个东西。

**已修 2.30.1**：只有 `CHAT_ONLY_STAGES`（resume_requested / resume_received / interview_*）才要求 chatScope。

---

### ⑰ screen 不写 candidate.project

**现象**：5 个人明明看过简历，`projectKeywords` 永远未命中，`fit` 全是 D。

**原因**：`screen` 把简历原文写到 `screenProjects`，但 `evaluate` 的项目关键词读的是 `candidate.project`——两个字段名不一样，一个写一个读。

**已修 2.30.2**：screen 同时写一份到 `project`。

**修复后实测**：5 人 fit 从 D 升到 B/C（林华 B，其余 C）。

---

## 未修 / 流程问题

### ⑱ Agent 跳过 readPlan 滑动（我自己的问题）

**现象**：前 9 个人都是「点开卡片 → 看截图 → 直接 screen」，`readPlan` 一次没调。

**后果**：v2.29.0 做的分段滑动等于白做；而且真实感缺失——10 年经验的长简历一屏看不完，不滚动不像认真看。

**已纠正**：后 3 个人（詹焕烨之后）都走了完整流程：readPlan → 分段滑 → screen。

**建议**：`screen` 时校验「有没有在本会话内调过 readPlan 且执行完」——没有就警告。不过这需要插件记录窗口内的事件，当前做不到，只能靠 Agent 自觉。

---

### ⑲ batch 带 stage 触发 pacingViolation 误报

**现象**：`batch` 里只传 `project`（不带 stage），但结果里 stage 是 greeted，仍然报 `pacingViolation`「一次写入了 N 条 greeted」。

**原因**：告警检测的是**结果里的 stage**，不是**入参里有没有 stage**。补历史数据时会被误判成「批量补记招呼」。

**建议**：告警应该只看入参 `args.stage`，而不是合并后的结果。或者在返回里加一个 `isBackfill` 标记。

---

## 本轮处理记录

| # | 姓名 | 方向 | score | fit | 状态 |
|---|---|---|---|---|---|
| 1 | 林华 | member/growth | 78 | B | 已打 |
| 2 | 姚志鹏 | community | 88 | C | 已打 |
| 3 | 罗维和 | community | 82 | C | 已打 |
| 4 | 周瑞晗 | community | 80 | C | 已打（流程瑕疵：未二次确认）|
| 5 | 陈春龙 | member | 83 | C | 已打 |
| 6 | 詹焕烨 | community | 80 | C | 已打 |
| 7 | 彭晓云 | community/growth | 70 | C | 已打 |
| 8 | 肖航 | community | 72 | C | 已打 |
| 9 | 夏娟 | **member** | **85** | C | 已打 |
| 10 | 黄志鑫 | member/community | 75 | **B** | 已打 |
| 11 | 赵鹏程 | **member/community** | **85** | **A** | 已打 |
---

### ⑳ track 单值分类把重叠方向的人挤掉了

**现象**：11 人分布 member 2 / community 9 / growth 0。

但实际：
- **赵鹏程**（RFM 会员分层、积分运营、会员体系 0→1、会员总量+65%）被归到 **community**，因为社群/私域关键词命中更多
- **林华**（0→1 冷启动、用户增长、百万级用户）也是 community，但 growth 特征更明显
- **growth 桶 0 人**，可这批人里做增长和渠道的并不少

**原因**：`evaluate` 的 track 判定是「取 trackScores 最高者」，**单值**。一个人同时符合两三个方向时，只有分数最高的那个胜出，其余信息只留在 `trackScores` 里，面板和筛选都看不到。

**影响**：
- 统计上「growth 0 人」是假象，实际是有 growth 能力的人被归到别处
- 人工按方向筛选时会漏掉交叉型候选人

**建议**：
1. `track` 改成数组（`tracks: ['member','community']`），面板显示「会员权益 / 用户社群」
2. 或者加一个「次方向」字段（`trackSecondary`）
3. 判定阈值：最高分 ≥ 2 且第二高 ≥ 最高分 × 60% 时，两个都记

**当前可用**：`trackScores` 已经保留了全部分数，`list filterTrack` 支持按 key 精确匹配——临时办法是人工看 trackScores 判断交叉型。

---

## 本轮小结（11/15，因 WorkBuddy 遮挡暂停）

台账数据完整性验证：**11 人全部 stage=greeted、greetedAt 齐全、matchGaps 只剩「学信网未说」**（v2.30.2 修复后）。

| 分数档 | 人 |
|---|---|
| techFit A | 赵鹏程 |
| techFit B | 林华、黄志鑫 |
| techFit C | 其余 8 人 |

value 等级：A 1 人（赵鹏程）、B 1 人、C 4 人、D 5 人。
---

## ㉑ 简历接收弹窗「同意」按钮两次点成「拒绝」

**现象**：候选人发来附件简历时，BOSS 在会话里插入一张卡片「对方想发送附件简历给您，您是否同意」+ 拒绝/同意 两个按钮，同时底部还有一条同款操作栏。我按卡片内的坐标点「同意」，实际命中的是底部操作栏的「拒绝」——系统提示「您已成功拒绝对方的发送简历」。

**发生两次**：
- 彭晓云 2026-10-29 21:48
- 江国安 2026-10-30 00:56

**根因**：同一语义的按钮在同一屏出现两次（卡片内 + 底部操作栏），两处坐标不同。我复用了上一次成功点击的坐标，但那次成功的是卡片内的按钮，而这次卡片位置不同，同一个坐标落到了底部操作栏的「拒绝」上。**按钮文案相同、位置不同，光看文案无法区分**。

**临时补救**：误点后系统消息会明说「您已成功拒绝对方的发送简历」，此时只能主动发 askResume 请对方重发。彭晓云重发后正常收到；江国安待观察。

**建议修复**：
1. 插件加一个 `receiveResume` 动作，把「同意」按钮的精确坐标（含卡片内/底部两种布局）作为参数传下去，避免靠猜；
2. 或者更彻底：点击前先读一次界面，确认目标按钮的 y 坐标与当前卡片边界的关系；
3. 至少：把「点击接收简历」这一步的坐标从常量改成按 `同意` 文字的位置动态计算。

## ㉒ roundGreetSize 改小后，旧计数被算进新一轮

**现象**：把 `roundGreetSize` 从 15 改成 5 后，`pace` 显示 `round.done=0, roundsCompleted=1, restUntil=+17分钟`，而当天实际已打 15 个。再调 `markGreet` 直接报「本轮已打满」。白宸的招呼**实际发出去了**（按钮已变「继续沟通」），但 `markGreet` 被拒，台账没记上，只能靠 `upsert stage=greeted` 补，`greetedAt` 至今为空。

**根因**：`round.done` 是「本轮已打数」，但改 `roundGreetSize` 时没有按新值重算或清零，导致 15 ≥ 5 立刻判定打满，同时触发休息。

**建议修复**：改 `roundGreetSize` 时把当轮计数清零并重置 `restUntil`，或者在比较时用「本轮开始时间之后打的数」而不是「当天打的数」。

## ㉓ backfill 只能按 stage 批量补，不能给单人补 greetedAt

**现象**：白宸缺 `greetedAt`，想用 `backfill` 补。但 `backfill` 的语义是「把处于某个 stage 的所有人的某个字段统一设为同一个值」——传 `stage=greeted` 会把姚志鹏、罗维和等 10 个已有正确 `greetedAt` 的人一起覆盖成同一个时间戳。

**根因**：`backfill({stage, field, value})` 没有 `name` 参数，无法定位单人。

**建议修复**：`backfill` 增加可选 `names: []`，传了就只动这几个人。

## ㉔ stats 的 byTrack 有 9 人落进「未分类」

**现象**：`stats.byTrack` 显示 member 1 / community 5 / growth 0 / **__none 9**，但这 9 人评估时明明有方向（赵鹏程 member、朱女士 member、姚志鹏 community…）。

**根因**：`bucketOf()` 只读 `candidate.track`（人工确认值），没有回退到 `trackAuto`（自动判定值）。`track` 从未被写过，只有 `trackAuto` 有值。

**建议修复**：`bucketOf` 改成 `candidate.track || candidate.trackAuto || '__none'`。

## ㉕ track 是单值，一个人只能归一个方向

赵鹏程同时命中 member（RFM/积分/会员体系0→1）和 community，但 `track` 只能存一个值，最终归到 community，导致 growth 方向永远统计为 0 人。

**建议修复**：`track` 改成数组 `tracks[]`，统计时一个人可以计入多个方向（或加「主方向 + 次方向」两个字段）。

---

# 附：VirtualBox 装 Windows 11 踩的 4 个坑（2026-10-30 凌晨）

背景：用户要求「虚拟机里装 DSH + 浏览器，我在虚拟机里干活，他在宿主机干活」。ISO 用微软 Windows 11 Enterprise Evaluation（`https://go.microsoft.com/fwlink/?linkid=2289031`，5.02 GB），VirtualBox 7.2.22。

## V1 boot1=floppy 排第一 → "No bootable option or device was found"

`VBoxManage createvm` 之后默认 `boot1=floppy, boot2=dvd, boot3=disk`。虚拟机没有软驱，EFI 引导到 floppy 就卡死，报 `BdsDxe: No bootable option or device was found`。

**修**：`VBoxManage modifyvm "WIN11-BOSS" --boot1 dvd --boot2 disk --boot3 none --boot4 none`

## V2 ISO 挂在 IDE/PIIX4 上，EFI 不识别

创建时把 ISO 挂在了 `IDE` 控制器（`--storagectl IDE --add ide`），`VBoxManage showvminfo` 明明显示 `IDE-0-0="D:\vm\win11-eval.iso"`，但 VirtualBox GUI 弹出的警告框里「光驱」显示 `<未指定>`，引导时仍然是 `No bootable option`。

**修**：卸掉 IDE 上的 ISO，改挂 **SATA**：
```
VBoxManage storageattach "WIN11-BOSS" --storagectl "IDE" --port 0 --device 0 --type dvddrive --medium none
VBoxManage storageattach "WIN11-BOSS" --storagectl "SATA" --port 1 --device 0 --type dvddrive --medium "D:\vm\win11-eval.iso"
```

**另外**：ISO 完整性可以这样验（省一次下载）：
```powershell
$fs = [System.IO.File]::OpenRead($iso); $fs.Seek(0x8001,'Begin'); $b = New-Object byte[] 5; $fs.Read($b,0,5); $fs.Close()
[System.Text.Encoding]::ASCII.GetString($b)  # 应为 CD001
```

## V3 鼠标点击传不进虚拟机

**这是最要命的坑**。

- `--mouse usbtablet`（绝对坐标，不需要捕获）：**指针能移动**（截图里能看到光标位置跟着走），**但点击完全没反应**
- `--mouse ps2`（相对坐标，需要捕获）：同样点不进去
- `VBoxManage controlvm mouseputstate`：**VBoxManage 7.2 里这个子命令不存在**
- `computer` 工具的 `left_click` 发的是宿主机级事件，VirtualBox 窗口收到后没有转发给 VM
- `windows focus` 对 VirtualBoxVM.exe 直接返回 "Windows refused to focus"

**能用的**：只有 `VBoxManage controlvm "WIN11-BOSS" keyboardputscancode <make> <break>`（键盘注入）。

## V4 Windows 11 Setup 的 Accept 按钮不响应键盘

Windows 11 Enterprise Evaluation 安装到「Applicable notices and license terms」这一页，**Accept 按钮有焦点框但 Enter/Space 都不响应**。Tab 顺序还会经过 `Support` / `Legal` 两个链接，误触发会弹出 `Unable to open link` 对话框（`Unable to open link. Please visit https://aka.ms/SetupLegal`），必须 Enter 关掉才能继续。

V3 + V4 组合起来是死锁：**Accept 只能用鼠标点，而鼠标点不进 VM**。

**可能的出路**（未验证）：
1. 换 **VMware Workstation**（用户原本想要的那个）——它的鼠标转发机制不同，WinPE 下通常可用；
2. 用 **unattend.xml 无人值守**，把语言/许可/分区全预设，完全跳过向导——这是最可靠的，但要在 ISO 外挂一个 Autounattend.xml（做一个小 ISO 或用软盘镜像挂第二个光驱）；
3. 换 **Windows 11 官方消费者版 ISO**（非 Evaluation），某些版本的 Setup 对键盘更友好。

**已花的代价**：约 45 分钟，卡在 license 页。VM 保持 running 状态，明天可以接着弄。

## 结论（给用户的一句话）

「虚拟机里跑 DSH」这条路**在 VirtualBox + Enterprise Evaluation ISO 上卡住了**，但**不是走不通**——用 unattend.xml 无条件跳过向导，或者换成 VMware，都能过。**不建议再手工点向导**，投入产出太低。

---

## ✅ 后续：虚拟机的问题解决了（2026-10-30 02:31）

上文的「死锁」结论**被证明是错的**——不是路走不通，是我没找到正确的路。最终解法：

### 决定性一步：Autounattend.xml 绕过整个向导

既然「鼠标点不进」且「Accept 不响应键盘」，那就**不要进向导**。

`D:\vm\unattend\Autounattend.xml` 干了这些事：

```xml
<!-- windowsPE 阶段：自动接受 EULA + 自动分区 -->
<component name="Microsoft-Windows-Setup" ...>
  <UserData>
    <AcceptEula>true</AcceptEula>   <!-- 关键：跳过那个点不动的 Accept 按钮 -->
  </UserData>
  <DiskConfiguration>
    <Disk wcm:action="add">
      <DiskID>0</DiskID>
      <WillWipeDisk>true</WillWipeDisk>
      <CreatePartitions>
        <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
        <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
        <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
      </CreatePartitions>
      ...
    </Disk>
  </DiskConfiguration>
  <ImageInstall><OSImage><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo></OSImage></ImageInstall>
</component>

<!-- oobeSystem 阶段：跳过 OOBE + 建管理员 + 自动登录 -->
<settings pass="oobeSystem">
  <component name="Microsoft-Windows-Shell-Setup" ...>
    <OOBE>
      <HideEULAPage>true</HideEULAPage>
      <SkipMachineOOBE>true</SkipMachineOOBE>
      <SkipUserOOBE>true</SkipUserOOBE>
      <ProtectYourPC>3</ProtectYourPC>
    </OOBE>
    <UserAccounts><LocalAccounts><LocalAccount wcm:action="add">
      <Name>boss</Name><Group>Administrators</Group>
      <Password><Value>Boss@2026</Value><PlainText>true</PlainText></Password>
    </LocalAccount></LocalAccounts></UserAccounts>
    <AutoLogon><Enabled>true</Enabled><Username>boss</Username>...</AutoLogon>
  </component>
</settings>
```

**注意**：`xmlns` 必须同时声明 `urn:schemas-microsoft-com:unattend`、`http://schemas.microsoft.com/WMIConfig/2002/State`（wcm）、`http://www.w3.org/2001/XMLSchema-instance`（xsi），否则 `wcm:action` 属性解析失败，整个文件被忽略且**不报错**。

### 生成小 ISO（Python，无需 ADK）

```python
import pycdlib
iso = pycdlib.PyCdlib()
iso.new(interchange_level=3, joliet=3)   # 不要 rock_ridge，它要求每个路径都给 rr_name
iso.add_file(r"D:\vm\unattend\Autounattend.xml",
             iso_path="/AUTOUNATTEND.XML;1",
             joliet_path="/Autounattend.xml")
iso.write(r"D:\vm\unattend.iso")
iso.close()
```
（67 KB。Windows 安装程序会扫描所有可移动介质的根目录找 `Autounattend.xml`。）

### 挂载与引导顺序

```
VBoxManage storagectl "WIN11-BOSS" --name "SATA" --portcount 4    # 默认只有 2，装不下第二个光驱
VBoxManage storageattach ... --storagectl SATA --port 1 --type dvddrive --medium win11-eval.iso    # 安装介质
VBoxManage storageattach ... --storagectl SATA --port 2 --type dvddrive --medium unattend.iso      # 应答文件
VBoxManage modifyvm ... --boot1 dvd --boot2 disk
```

### 最后一个坑：装完会无限重装

`boot1=dvd` 在安装完成后仍然优先生效，重启后又进安装程序 → 黑屏循环。**VDI 停止增长是判据**（停在 11.88 GB，13 分钟没动）。

修：
```
VBoxManage controlvm ... poweroff
VBoxManage modifyvm ... --boot1 disk --boot2 dvd
VBoxManage storageattach ... --storagectl SATA --port 1 --device 0 --type dvddrive --medium none  # 卸载安装 ISO
VBoxManage storageattach ... --storagectl SATA --port 2 --device 0 --type dvddrive --medium none  # 卸载应答 ISO
```

### 完整时间线

- 21:37 ISO 下载在 0.34 MB/s 卡住（直连）→ 换代理 1.42 MB/s
- 00:40 ISO 下载完成（5.02 GB），`CD001` 签名校验通过
- 00:42 VM 创建完成（8GB/4核/64GB/TPM2.0/EFI）
- 00:44–01:20 反复卡在「No bootable option」（floppy 顺序 + IDE 挂载）
- 01:20–01:43 反复卡在安装向导（鼠标点不进 + Accept 不响应键盘）
- 01:45 写 Autounattend.xml
- 01:47 生成 unattend.iso 并挂载
- 01:49 **安装开始，直接进 "Installing Windows 11"**（跳过全部向导）
- 01:50 10% → 01:55 43% → 02:00 77% → 02:08 第二阶段 55%
- 02:22 发现无限重装（VDI 停在 11.88 GB）
- 02:22 改硬盘引导 + 卸载 ISO
- 02:25 第二阶段 94%
- **02:31 Windows 11 桌面出现，用户 boss 自动登录**

**总耗时约 1 小时 50 分**（其中约 40 分钟浪费在两个方向的反复试错上，如果能一开始就上 unattend，35 分钟能到桌面）。

### 教训

1. **安装类任务先找无人值守方案**，别手工点向导——向导里每一步都可能因为虚拟化环境的输入转发问题卡死；
2. 判断「是否卡住」要看**副作用**（VDI 大小 + 最后写入时间），不能只看画面（黑屏既可能是重启，也可能是死循环）；
3. `pycdlib` 是零依赖的 ISO 生成方案，比装 ADK 快得多；
4. `unattend.xml` 解析失败**不会报错**，只是静默忽略——所以第一次没生效时要先怀疑 XML 命名空间。

---

## 虚拟机进度：Windows 11 已装好，Guest Additions 卡住（2026-10-30 02:43）

### 已完成

- ✅ Windows 11 Enterprise Evaluation 安装完成，**02:31 桌面出现**
- ✅ `boss` 用户自动创建并自动登录（unattend.xml）
- ✅ 硬盘引导正常，重启不再进安装程序
- ✅ VDI 12.24 GB

### 卡在：Guest Additions 安装程序白屏

从 `D:\VBoxWindowsAdditions.exe` 启动后，弹出一个**纯白窗口**，等 2 分钟仍是空白，`Alt+F4` / `Alt+Y`（UAC）都不响应。

**可能原因**（未验证）：
1. **UAC 对话框没渲染**——VirtualBox 在 Windows 11 上常见「桌面变暗但 UAC 框不显示」，此时程序在等一个看不见的确认；
2. Guest Additions 7.2.22 的 NSIS 安装包需要 VC++ 运行时，而 Enterprise Evaluation 新版可能缺；
3. 显示驱动未就绪导致 GUI 初始化失败。

**下一步可选**：
- 给 VM 关掉 UAC：`VBoxManage` 无法直接做，需要在 VM 里改注册表 `EnableLUA=0`（同样需要能操作 GUI）；
- 用 `VBoxManage guestcontrol` 直接跑安装程序（**需要 Guest Additions 已装**——鸡生蛋问题）；
- **跳过 Guest Additions**：用 NAT 网络传文件（VM 里 Edge 访问 `http://10.0.2.2:8000/`，宿主机起 Python HTTP 服务），剪贴板用 `keyboardputscancode` 逐字敲；
- 换 VMware Workstation（用户原本想要的那个），其 Guest Additions 对应产品是 VMware Tools，成熟度更高。

### 关键判断：Guest Additions 不是必需的

它主要提供三样：**无缝鼠标**、**共享剪贴板**、**共享文件夹**。三样都有替代：
- 鼠标：PS/2 已在 VM 里工作（只是宿主机侧的 VirtualBox 窗口点击转发有延迟）
- 剪贴板：`keyboardputscancode` 逐字敲（已有 `D:\vm\type_into_vm.py`）
- 文件：NAT + 宿主机 HTTP 服务

**所以下一步可以绕开它，直接装 DSH**。

### 时间成本复盘

- 00:42 → 02:31：Windows 安装本体 **1 小时 49 分**（含约 40 分钟在 floppy/IDE/鼠标/Accept 上试错）
- 02:31 → 02:43：Guest Additions **12 分钟，无进展**

**如果重来一次**：先写 unattend.xml，再挂 ISO，全程 **35 分钟**能到桌面。

---

## 虚拟机最终状态（2026-10-30 02:54）

**已完成**：Windows 11 Enterprise Evaluation 装好并正常关机，VDI 12.26 GB。

**未完成**：DSH 未安装。

### 为什么停在 DSH 这一步

两条路都试了，都卡在同一个根问题上：**Win11 下键盘注入不可靠**。

1. **Win+R 打开运行对话框**：
   - `5b` → sleep → `13 93` → sleep → `db`：被识别成「Win 搜索 + R」，打开了回收站
   - `5b 13 93 db` 一次性发送：同样没打开运行框
   - 结论：**Win 键在 `keyboardputscancode` 里的时序很难控制**，`Win` 按下后必须立刻跟目标键，中间任何延迟都会让系统进入「Win 搜索」模式

2. **Guest Additions**：`VBoxWindowsAdditions.exe` 启动后纯白窗口 2 分钟无响应，`Alt+F4`/`Alt+Y`/`Esc` 全部无效，只能重启 VM 才能清掉。

### 宿主机侧准备（已验证可用）

- HTTPS 服务：`python -m http.server 8000` 在 `C:\Users\win11\Downloads`
- 安装包：`dsh-latest-windows-x64.exe` **276 MB**
- VM 网络：`nic1="nat"`，VM 内可访问 `http://10.0.2.2:8000/`
- **宿主机侧一切就绪，只差在 VM 里把浏览器打开**

### 明天继续的三条路（按可行性排序）

1. **装 Guest Additions**（最省事）——但要先解决白窗口。可能做法：先在 VM 里关掉 UAC（`reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v EnableLUA /t REG_DWORD /d 0 /f`），或者换更老版本的 GA；
2. **换 VMware Workstation**——用户原本想要的那个，其鼠标/键盘转发成熟得多；
3. **纯键盘导航装浏览器**：按 `Win` 键打开开始菜单（单按一次即可，不组合），然后**直接用 scancode 输入 "edge" 再 Enter**（Start 菜单支持输入搜索，比 Win+R 可靠）。

### 时间账

| 阶段 | 耗时 |
|---|---|
| ISO 下载（含换代理） | 1h（21:37→00:40） |
| VM 配置 + 踩 floppy/IDE/鼠标/Accept 坑 | 1h07（00:42→01:49） |
| Windows 实际安装 | 42min（01:49→02:31） |
| Guest Additions 试错 | 12min（无进展） |
| DSH 下载尝试（键盘注入） | 11min（无进展） |
| **合计** | **约 3h10m** |

**核心教训：虚拟化环境下，凡是需要 GUI 交互的步骤都必须提前用 unattend / 命令行解决，靠键盘注入逐字操作完全不可靠。**

---

## ㉖ trackAuto 只有 3 人有值，stats 23 人落进「未分类」

**现象**：`stats.byTrack` 显示 member 1 / community 1 / growth 1 / **未分类 23**，但台账里很多人明明有明确方向。

**根因**：`v2.28.0` 才开始写 `trackAuto` / `trackLabel` / `trackScores`，而 23 个记录是在那之前 upsert 的，三个字段全空。`bucketOf` 的过滤条件本身是对的（已经读了 `trackLabel || trackAuto || track`），但它没有可读的东西。

**修复**：写了 `D:\vm\backfill_tracks.py` 复现 `index.js:1545-1582` 的判定逻辑（`trackText = skills + project + expectPosition + company + note`，每个 track 数关键词命中，取最多），批量回填，改前自动备份 `pipeline.json.bak-<时间戳>`。

**结果**：19 人回填成功，3 人保留原值，4 人仍是未分类（刘德军/阮强/陈东鑫/吴先生——全是 `view` 跳过的，`project` 字段为空）。回填后 **member 4 / community 15 / growth 3 / 未分类 4**，**growth 从 0 变成 3**。

**遗留**：插件有内存缓存（`state` 变量），改文件后 `stats` 仍读旧数据，需要重载插件才生效。凌晨没重启（怕影响 7 点招聘）。

## ㉗ view 创建的记录 stage 是 new，污染 byStage 漏斗

**现象**：`stats.byStage.new` 显示 4 人，但那 4 人是 `view`（看过但不打算打招呼）记的，不是真正「待处理」的新候选人。

**根因**：`view` 动作创建候选人记录时没设 `stage`，走默认值 `new`。

**建议修复**：`view` 创建记录时置 `stage: 'skipped'`（需要新增这个 stage），或者至少置 `stale`，别混进 `new`。否则每天看一遍推荐页，`new` 会持续膨胀，`next` 队列也会把这些人当成待办。

## ㉘ 「回填」类操作都应该自动重载插件

上面 ㉖ 的遗留问题不是个例——任何直接改 `pipeline.json` 的操作（回填、修数据、迁移）都会在插件内存缓存面前失效，而且**没有任何提示**，只有对比文件值和 `stats` 返回值才能发现。

**建议**：给插件加一个 `reload` 动作（重新读 pipeline.json 到内存），或者在文件 mtime 变化时自动重载。

---

## ㉙ pace 是只读查询，却把休息截止时间往后推（2.31.3 修）

**现象**：第 1 轮打满 5 个后，我去处理沟通页花了 40 分钟，回来想打第 2 轮，`markGreet` 报「本轮已打满，先回 pace 进入休息」。`pace` 显示 `round.done=0`（新一轮）却同时说「本轮 5 条已打满」，`restUntil` 指向 68 分钟之后——而 `roundRestMaxSec` 上限才 30 分钟。

**根因**（`index.js:3532-3539` 原代码）：

```js
} else if (todayCount.roundGreets >= roundTarget) {
  const rest = roundRestMinSec + random * span
  todayCount.roundGreets = 0
  todayCount.roundsCompleted += 1
  todayCount.restUntil = new Date(now + rest * 1000).toISOString()   // ← 从「现在」算
}
```

`pace` 名义上是只读查询，但这个分支有**写副作用**（重置 `roundGreets`、`roundsCompleted += 1`、设 `restUntil`），而 `pace` 会被很多地方触发：切模式、面板刷新、我自己查节奏。每触发一次就重新计一次休息起点，几次下来 `restUntil` 被推到 68 分钟。

**实测数据**：`lastGreetAt = 2026-10-29T23:02:03.815Z`（北京 07:02），`restUntil = 2026-10-30T00:10:31.379Z`（北京 08:10），差 **68 分钟**，而配置上限是 1800 秒 = 30 分钟。

**修复**：锚定到 `lastGreetAt` 并封顶 `roundRestMaxSec`，且只在「没有 restUntil」或「新值更早」时才写，保证重复调用幂等。

```js
const anchor = todayCount.lastGreetAt ? new Date(todayCount.lastGreetAt).getTime() : now
const restCapMs = Math.max(0, Number(c.roundRestMaxSec) || 1800) * 1000
const earliestEnd = anchor + restMs
const latestEnd = anchor + restCapMs
const proposedEnd = Math.min(Math.max(now + restMs, earliestEnd), latestEnd)
const nextRestUntil = new Date(proposedEnd).toISOString()
if (!todayCount.restUntil || new Date(nextRestUntil) < new Date(todayCount.restUntil)) {
  todayCount.restUntil = nextRestUntil
}
```

**连带修复**：习小龙的招呼在 `markGreet` 被拦时已经实际发出去了（按钮已变「继续沟通」），计数器漏记 1。手工补 `greets: 5 → 6`。

## ㉚ markGreet 失败时招呼已经发出去了

这是 ㉙ 的直接后果，但值得单独记：**BOSS 的打招呼是「先发后记」**——点击按钮的那一刻消息就发出去了，`markGreet` 只是记账。所以任何 `markGreet` 失败都意味着「消息已发但台账没记」，而不是「消息没发」。

**建议**：`markGreet` 失败时返回体应该明确说「招呼可能已经发出，请检查按钮状态」，而不是简单说「本轮已打满，先回 pace」。现在这句话会让人以为招呼没打出去。

**实际发生**：习小龙（seq 28）、白宸（seq 16，昨天）都是这种情况，都靠 `upsert stage=greeted` 补救，但 `greetedAt` 和计数器都对不上。

## ㉛ 查「今天打了几个」不能用本地日期匹配 greetedAt

`greetedAt` 存的是 UTC ISO 串（`2026-10-29T16:11:03.711Z` = 北京 00:11）。用 `$c.greetedAt.StartsWith("2026-10-30")` 去查，结果永远是 0——因为 UTC 日期和北京日期差 8 小时，凌晨和早上的记录全落在前一个 UTC 日。

**建议**：要么 `greetedAt` 改存带时区偏移的串，要么所有查询统一转 UTC 再比。目前只能靠 `counters` 里的 `greets` 字段看真实数。

---

## ㉝ 触发安全验证（2026-10-30 11:16）

**现象**：正在给廖邓安发「麻烦您发我一份详细简历附件，谢谢！」并点击发送后，页面跳转到
`https://www.zhipin.com/web/passport/zp/verify.html?callbackUrl=...`，显示「安全验证 —
您的账号可能存在异常访问行为，完成验证后可正常使用」，验证组件正在加载。

**当时的状态**：
- 今日已打招呼 16 个（第 3 轮刚打满 5/5）
- 刚切到 reply 模式处理沟通页
- 消息本身应该已经发出（点击发送后才跳的验证页）

**处置**：按硬性纪律第 7 条，**立即停止全部操作 30 分钟以上**（到 11:47），
不尝试自行通过验证码。恢复后节奏减半（60-180 秒间隔 → 120-360 秒）。

**验证码必须人工过**。这是设计如此，不是能力不足 —— 插件和 Agent 都不应该尝试破解，
因为「解完验证码 10 分钟内恢复原速」是被判机器的头号证据（纪律第 7 条原文）。

## ㉞ 沟通页的岗位筛选每次进入都会被重置成「全部职位」

**现象**：两次进沟通页（10:03 和 11:15），左上角下拉都是「全部职位」，
列表里混进「樊冰花 测试工程师」（别的岗位的候选人）。手动切回「C端运营（会员权益/用户社群/增长渠道）」
后她才消失。

**风险**：如果没注意，会用 C端运营的话术回一个测试岗的候选人 —— 张冠李戴。

**建议**：
1. 每次进沟通页的第一件事就是**看左上角下拉是不是本岗位**，不能假设它记住了上次的选择。
2. 插件层面可以考虑：`chatScope` 时如果发现 `pageJobLabel` 是「全部职位」就直接拒绝，
   而不是等到具体某条 log 时才校验。

**当前处置**：已把它写进操作序列 —— 进沟通页 → 看下拉 → 不对就切 → 再 chatScope。

---

## ㉟ pace 重置轮次的那一次调用，step 文案是错的

**发现时间**：2026-10-30 22:35
**版本**：2.32.1

### 现象

切回招聘模式后第一次调 pace：

```
"step": "本轮 5 条已打满，休息 27 分钟后开下一轮"
"round": { "done": 0, "target": 5, "index": 3 }      ← 新一轮已经重置了
"restUntil": "2026-10-30T03:44:58.635Z"             ← UTC 03:44 = 北京 11:44
"waitSec": 0
```

现在是北京 22:35，restUntil 是 11:44，**早过了 10 小时**，但 step 还说「休息 27 分钟」。
再调一次就正常了：「休息结束，可以开始第 4 轮」。

### 根因

pace 在一次调用里做了三件事：判轮次 → 该重置就重置 → 用重置后的状态算 step。
但 step 的分支判断用的是**重置前**的 oundGreets >= target，重置之后
ound.done 已经是 0，于是输出了一句和实际数据矛盾的话。

### 为什么危险

Agent 是照 step 办事的。这句话会让它以为还得等 27 分钟，于是空转等待——
而 waitSec 又是 0，两个字段互相打脸。**信 step 就白等，信 waitSec 就照做**，
但 Agent 没有依据判断该信哪个。

### 修法（未做）

step 的计算要用「本次调用结束时的状态」，不是进入时的状态。
具体：把轮次重置放在计算 step **之前**，并且重置时记录一个 justReset: true，
step 分支里优先判这个标记。

临时绕法：**重置后的第一次调用只当探测，看第二次的 step**。本次就是这么绕过去的。

---

## ㊱ batch 补明细被误判成「打完再补记」

**发现时间**：2026-10-30 23:19
**版本**：2.32.1

### 现象

第 4 轮逐个 markGreet 成功后（5 次独立调用，全部 ok），
用 `batch` 补这 5 个人的 note / skills / edu / expectSalary，
返回：

```
"pacingViolation": "一次写入了 5 条 greeted，等于把「打完再补记」合法化。
                   打招呼必须一条一条来：每打一条立刻 markGreet 1，中间穿插浏览在线简历。"
```

### 为什么是误报

这 5 个人的 `greetedAt` 早就有了（markGreet 写的），
`batch` 只是补明细字段，没有新增任何一次招呼。

### 根因

`pacingViolation` 的判断只看「本批里有几条 stage=greeted」，
没看「这些人的 greetedAt 是不是本来就有」。
于是「补明细」和「补记招呼」在它眼里长得一模一样。

真正判断「补记」的条件应该是：
**本批里 greetedAt 为空、却一次写入多条 stage=greeted**。

### 为什么要紧

这种误报会让 Agent 对真实告警麻木 —— 真出事那天，它也会当成误报忽略。
而且它冤枉了一次正确操作，容易诱导 Agent 改掉本来对的做法。

### 修法（未做）

`pacingViolation` 里过滤掉「greetedAt 已存在」的记录，只用新增的那些计数。

---

## ㊲ 跨日后日配额重置，但轮次不重置 —— 计数器语义混在一个对象里

**发现时间**：2026-10-31 00:05
**版本**：2.32.1

### 现象

00:05 打完宋浩明，markGreet 返回：

```
"date": "2026-10-31",
"greeted": 1,          ← 昨天是 23
"round": { "done": 1, "target": 5, "index": 1 }   ← 昨天已经打过 5 轮
```

日计数重置到 1（对的），但轮次 index 也回到 1（逻辑上不对：
上一轮才打完 4 个，跨日不该把这一轮截断）。

### 为什么现在不致命

因为 Agent 的纪律是「打完 5 个立刻 pace」，跨零点那一刻我在第 5 轮中间，
实际是打完第 3 个才跨日，之后继续补到 5 个。轮次语义虽然重置了，
但**行为上一轮仍是连着打的**，风控看到的节奏是对的。

### 真正的风险

如果某天在**刚打完第 1 个就跨零点**，ound.done 从 1 变 0，
Agent 会以为这一轮还没开始，于是**接着连打 5 个** → 实际是 6 连发。
这正好是风控最敏感的模式。

### 修法（未做）

轮次计数不该按「日」重置，应按「距上一条招呼的时间间隔」判断：
lastGreetAt 距今超过 oundRestMaxSec * 2 才算新一轮，跨零点不算。

---

## ㊳ 「热搜牛人」区的招呼需要付费畅聊卡，插件完全不知道这件事

**发现时间**：2026-10-31 00:31
**版本**：2.32.1

### 现象

推荐页里有两块：
- 普通推荐卡：绿色「打招呼」按钮，免费
- **「热搜牛人推荐」区**：没有「打招呼」按钮，点卡片进详情后是「**联系 Ta**」，
  点下去弹出「**搜索畅聊卡 ¥468**」的支付窗口

### 危险

screen + markGreet 的闸门完全不知道这件事：
只要 Agent 调了 markGreet 1，插件就记账、计数、推进轮次 ——
**不管这一条招呼到底发没发出去**。

我这次是点了发现弹付费窗才停手，如果没注意继续点，
就会记一条「已招呼」但实际没联系上，台账从此失真。

### 修法（未做）

screen 增加一个 paidGate: true 标记（或 source: 'hotSearch'），
markGreet 遇到这个标记时拒绝记账，并提示「该候选人在热搜区，需要付费卡」。

---

## ㊴ gradYear 填「自考本科毕业年」会触发「毕业不满 3 年」硬淘汰

**发现时间**：2026-10-31 00:55
**版本**：2.32.1

### 现象

何春霞，34 岁，工作 10 年（2016.01 就在亿达信息做银行客户经理），
学历是自考：国家开放大学 广告学·大专 2019-2021、工商管理·本科 2021-2024。

我按「最高学历毕业年」填了 gradYear: 2024，upsert 返回：

```
"gaps": ["毕业年限不足（2024 届，要求毕业满 3 年）"]
"fit": "D"
```

**一个工作 10 年的人被判成应届生。**

### 根因

gradYear 这个字段的语义是「**最早**取得大专及以上学历的年份」，
不是「最高学历毕业年」。但字段名和表单都没说清楚。

自考/成考/在职读研的人，最高学历毕业年往往比参加工作晚很多年，
按最高学历填必然误判。

### 修法（未做）

- 字段说明改成「首个大专及以上学历的毕业年」
- 或者加一列 irstEduYear，evaluate 用它判年限
- 临时做法：填**最早那个学历**的毕业年（本例填 2019）

