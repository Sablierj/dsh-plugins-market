# 产品研发团队（product-team bundle）

一个 DSH **bundle**：往 profile 里插两样东西 ——

1. **一套编制**：agent preset `product-team`（8 个角色 + 软件工程流程与门禁）；
2. **一套电脑操作能力**：`desktop_mouse`（真实鼠标/键盘/截图）+ `browser_*`（Chrome CDP 自动化）。

装完在桌面 App 里新建会话时选「**产品研发团队**」，团队编制、技能与电脑操作能力就都在了。

---

## 一、装了是什么

| 组成 | 落点 | 说明 |
|---|---|---|
| `preset-product-team` | profile 插件树（agent preset） | 会话编制：人设 + 工具集 + 技能目录 |
| `desktop-mouse` | host 层（进程全局） | `desktop_mouse`：move / click / scroll / drag / type / key / screenshot |
| `browser-cdp` | host 层（进程全局） | `browser_open` / `browser_page` / `browser_click` / `browser_type` / `browser_eval` / `browser_screenshot` / `browser_close` / `browser_status` |
| 9 个技能 | `<bundle>/skills/` | 流程总纲 `product-team-process` + 8 个角色章程 `team-role-*` |

角色：产品经理、需求研究员、架构师、全栈开发、UI 设计师、用户体验师、测试工程师、亚马逊运营。

## 二、软件工程流程（7 阶段 / 5 门禁）

```
P0 立项 ─G0→ P1 需求发现 ─G1→ P2 体验与界面设计 ─┐
                                       ├─G2→ P4 开发实现 ─P5 测试与验收 ─G3→ P6 运营与迭代
                     P3 架构与技术方案 ─┘
```

- **G0 立项**：目标可量化、有明确用户、有非目标、有 owner。
- **G1 需求（DoR）**：需求 = 用户故事 + 可测验收标准 + 优先级 + 依赖 + 非目标；证据带来源与置信度。
- **G2 设计**：每条需求有流程与线框；每个接口有契约；数据变更带迁移与回滚；非功能要求有数字。
- **G3 发布**：验收标准逐条有证据；无 P0/P1 未决缺陷；有回滚与可观测性；发布说明已写。

每道门禁的完整清单、交付物落盘位置、任务书模板、协作纪律（任务板 / 写作用域 / 依赖 / 验收口径）在
技能 `product-team-process` 里，那是**唯一事实来源**。

## 三、安装状态（本机 2026-10-01 已装）

已装进**当前桌面 App 的 `desktop` profile**：

| 事实 | 值 |
|---|---|
| profile 依赖 | `"@local/dsh-product-team": "link:C:/Users/win11/dsh-plugins/product-team"` |
| profile bundles | `@local/dsh-product-team` 已在 `dsh.profile.bundles` 里 |
| 安装形态 | `node_modules\@local\dsh-product-team` 是指向本目录的**符号链接**（SymbolicLink，改源即生效，没有副本漂移） |
| preset 行 | `include:preset-product-team` 状态 `schema`（与 4 个发行预设同级） |
| 实测 | 新会话里 8 个 `browser_*` + `desktop_mouse` 都在；`browser_status` 返回真实 JSON |

**要生效必须新建会话**：已经开着的会话沿用启动时的插件版本，不会自动切到新 preset。

重新安装 / 卸载：

```
plugin_manager { action: install_bundle, target: 'C:\Users\win11\dsh-plugins\product-team' }
plugin_manager { action: remove_bundle, target: '@local/dsh-product-team' }
```

## 三之二、装的时候踩的两个坑（已修，已写进 `docs\plugin-contract.md`）

1. **注册工具的行必须导出 `inject = ['tools']`**：否则 `ctx.tools` 抛
   `cannot get property "tools" without inject`，该行 `did not activate`（Host 仍能启动，
   只是工具没注册上，很容易被误判成「模型不会用」）。
2. **Cordis 按文件 URL 缓存模块**：改完文件再 toggle bundle **不会**重新加载失败的行
   （错误 stack 里的行号还指向旧代码）。要么换路径，要么重启应用 —— 本 bundle 因此把插件
   放在 `plugins\<id>\index.cjs` 这种「每个插件一个目录」的形状里，换实现就是换路径。

## 四、自检（改完这个 bundle 就跑）

```powershell
cd C:\Users\win11\dsh-plugins
node product-team\tools\check-skills.mjs      # 9 个技能：结构、术语、证据口径、失效写法
node product-team\tools\smoke-browser.mjs     # 真拉起浏览器：开页/取文/求值/截图/点击失败/收尾
node scripts\check.mjs                        # 仓库预检（amazon-ops / user-console 不受本 bundle 影响）
```

`smoke-browser.mjs` 会**真的在你屏幕上开一个 Chrome 窗口**（专用 profile + 端口 9333），跑完自动关掉
「它自己拉起的那一个」；如果端口上本来就有浏览器，它只关自己开的那张标签页。加 `--keep-open` 可保留现场。

## 五、已知边界

- **浏览器**走 CDP，比物理鼠标稳，优先用它；`desktop_mouse` 留给没有网页界面的桌面操作与视觉验收。
- 采集浏览器用**专用 profile**（默认复用 `amazon-ops\data\chrome-profile`，里面有登录态），端口 9333，与日常浏览器隔离。
- `desktop_mouse` 会**真的移动用户鼠标、敲键盘**：动之前先说清楚要做什么；破坏性操作先要用户确认。
- 步骤类操作的截图证据请用 `browser_screenshot` 或 `desktop_mouse action=screenshot` 落 PNG，再用 `read_image` 看，
  不要用文字描述「我看到了什么」。
- 这个 bundle 的路径是**绝对路径**（`file:///C:/Users/win11/dsh-plugins/product-team/...`），换机器/挪仓库要同步改 `cordis.patch.yml`。

## 六、建议补充的能力（按性价比排序）

| 能力 | 为什么需要 | 怎么加 |
|---|---|---|
| `amzn_*`（amazon-ops 本体，57 个工具 + workbench 页 + Agent run 门禁） | 团队真正干活的领域工具；装上后 `/custom/amazon-ops` 才有页面 | 把 `amazon-ops` 也装进当前 profile |
| 长期记忆 `memory_recall` / `memory_save`（user-console） | 跨会话记住项目约束、用户偏好、踩过的坑 | 把 `user-console` 装进当前 profile（接 47.251.253.188） |
| 凭据库 `vault_list` / `vault_get` / `vault_save` | 账号密钥只写位置不写值，团队共享位置 | 同上，随 user-console |
| 定时任务 `schedule_*` | 运营日报、巡检、门禁提醒 | 桌面 profile 已带 schedule 工具，直接可用 |
| 长目标 `create_goal` / `update_goal` | 多阶段目标不丢线（本会话自带） | 已在 standard/team 编制里 |
| Office 交付物（docx/xlsx/pptx + `present`） | 给非技术干系人的需求书、测试报告、运营周报 | `load_workspace_dependencies` 取 Python 环境，产出后用 `present` 挂卡片 |
| 只读数据库探针（`pwsh` + `node:sqlite`） | 任何「数据分布/新鲜度」的结论要有真实库支撑，不能靠印象 | 已具备（`pwsh` + `amazon-ops\data\amazon-ops.db`） |
| 视觉闭环（截图 + `read_image`，模型支持 image 输入） | UI/UX 验收必须看图，不看描述 | 已具备 |
| 通知通道（IM/Webhook，如果本机有） | 门禁通过/阻塞时通知人，而不是等人来问 | 需要一个能出网的 webhook 地址；当前没有配置 |
| 角色级写作用域与审批分级 | 8 个角色同时写一个仓库时，避免互相踩文件 | 用任务板 `write_scopes` + 危险操作先要用户确认（已写进流程技能） |

## 七、卸载

```
plugin_manager { action: remove_bundle, target: '@local/dsh-product-team' }
```

host 层的两个工具随 bundle 一起撤掉；已经拉起的 Chrome 不会被杀（它本来就是独立的进程）。
