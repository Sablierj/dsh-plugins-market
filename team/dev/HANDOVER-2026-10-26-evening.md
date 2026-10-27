# HANDOVER — amazon-ops / dsh-restart（2026-10-26 21:00）

> 写这份的原因：本轮目标跑到第 8 圈，会话上下文接近耗尽。**代码与测试都在仓库里、都验过**，
> 剩下的两件事需要「一个能装下完整上下文的回合」去做。下一个人（或下一个我）照着这页就能接上。

## 一、现在的事实（都有命令输出为证）

| 项 | 值 | 怎么验 |
|---|---|---|
| 全量测试 | **2901 / 0** | `node tests/run.mjs` |
| 守门 | **10 / 10**（都会红、恢复后全绿） | `node scripts/check-guards.mjs`（要求工作区干净） |
| 磁盘代码自检 | **21 / 21** | `node scripts/post-restart-check.mjs` |
| 工具面扫描 | **142 ok · 0 异常** | `node scripts/verify-tool-surface.mjs` |
| 优化流程 | prepare → report 全通 + fail-closed | `node scripts/verify-optimize-flow.mjs` |
| HEAD | `4f4fdf7` | `git log -1` |

## 二、没做完的两件事

### 1. 运行中的插件还差 7 个提交

宿主：**端口 7509 · PID 16112 · 启动 14:20:41**。
之后落地的提交（全在磁盘、全在测试里，**页面和对话里都看不到**）：

```
4f4fdf7 R-98 属性缺口清单
8c1af71 R-97 路由级往返 + 门 8 提示改指真路
2944b8a R-96 属性补齐接面板
11516f0 R-95 属性补齐（工具）
4eb2646 R-94 字段模板调顺序
dc221a1 t104 fail-closed 五条
cf93f11 R-93 字段模板逐行编辑
```

重启怎么按：`dsh_restart`（插件已加「磁盘上已是修好的脚本就不覆盖」的保护，见
`C:\Users\win11\dsh-plugins\dsh-restart\index.js` 的 `writeHelper`），
或绕过插件直接跑 `C:\Users\win11\.dsh\dsh-restart\launch.cmd`。
失败先看 `relaunch.log` 与 `relaunch.log.err`（stderr 已接管，解析错误不会再静默）。

### 2. 26 项必填属性还缺真值

`team/dev/attr-backlog-2026-10-26.md` 是清单：26 项里只有 5 项在文案里找得到痕迹，
其余 21 项**本库无证据**。补法两条都印在那份文档里（页面「优化 → 属性补齐」／`amzn_asin_attribute_set`）。

**不许自动填**：把文案词当值写进 `attributes_json` 会得到一条看起来像真的假数据，
门 8 会因此显示通过 —— 那比 17/43 更糟。

## 三、这一程修掉的、值得记住的坑

1. **`store.get` 查不到返回 `undefined` 不是 `null`** —— 按 null 判空直接炸（R-95 现场）。
2. **`TOOLS` ⇄ `buildTools` 的守门比的是名字序列**，插错位置就红（漏一处 = 工具存在但调不到）。
3. **`ctx.get('service')` 在未声明 inject 时会抛**，而写在 async IIFE 里就成了未处理 rejection ——
   启动弹窗、整个应用起不来。只能用 `ctx.inject([...], cb)`，且整段必须 try/catch。
4. **PowerShell 把 `$i:` 当成「驱动器 i 上的变量」** —— `"attempt $i: …"` 是语法错误，整脚本不执行。
5. **PS 5.1 按 ANSI 解码无 BOM 的 UTF-8 .ps1** —— 脚本里写中文就静默退出 1。
6. **`start "" /b` 与父进程同控制台**，父进程一死助手跟着走；要 `start "" /min`（不带 /b）。
7. **`spawn(powershell, {detached:true, stdio:'ignore'})` 在这台机器上一秒内退出码 0、无输出**。
8. **文案让人点的控件必须出现在下发文档里**（T86-⑧）—— 只由脚本现建会被守门抓住。

## 四、下一步的顺序（不用再想）

1. 重启 → 按 `team/dev/post-restart-checklist-2026-10-25.md` 五步做运行时核对。
2. 逐条核那 5 项有线索的属性（一次一条，确认后才写库）。
3. 其余模块的真实 ASIN 巡检：采集 → 关键词 → 竞品 → 报告，各走一遍真流程并记下发现。
