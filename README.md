# wechat-session-bind

在 DSH 会话标题旁增加「绑定微信」按钮：点击后把微信（dsh-wechat-workbench）绑定到当前会话——微信消息将路由到这个会话。

## 行为

- 按钮位置：会话标题旁的操作区（`conversation.session.header.actions`）
- 初始状态读取绑定情况；点击执行绑定；结果如实显示：
  - **微信已绑定 ✓** —— 文件已写入且 `dsh-wechat-workbench` 已重载，即时生效
  - **已写入 · 重载后生效** —— 文件已写入但重载未确认，重启 DSH 后生效
  - **绑定失败** —— 显示原因（如 pointers.json 为空：需先在微信里给机器人发消息完成首次绑定）

## 绑定做了什么

1. 备份 `~/.dsh/wechat-workbench/pointers.json` 与 `driven-sessions.json`（时间戳 `.bak-bind-*`）
2. 把每个微信会话的指针改为 `{workspaceId, sessionId: 当前会话}`；workspace 解析顺序：显式提示 → workspaceRegistry 归属 → 保留原 workspace
3. 当前会话加入 driven-sessions（若缺）
4. 禁用→启用 workbench 行（其 PointerStore 只在构造时读文件，需重载才 live）；行 id 运行时解析（`include:wechat-workbench` / 裸 id 回落），并以 `build.json.appliedAt` 标记移动作为**生效证据**——只有标记动了才显示「微信已绑定 ✓」，否则「已写入 · 未生效，点击重试」。v1.0 用裸 id 寻址打不中 `include:` 行（文件写了、内存指针没动），v1.1 已修并加校验。

## 边界

- **用户专属操作**：绑定决定微信消息路由到哪个会话，属授权动作；不注册 agent 工具，Agent 不能替用户绑定。
- 不改 workbench 插件代码；只写它的两个状态文件（带备份）+ 触发其官方重载路径。
- 卸载本插件不影响既有绑定。

## 文件

- `index.js` —— Host 半：`POST/GET /api/wechat-session-bind/state`（绑定/状态）
- `client.js` —— Client 半：会话标题按钮
- `locale/en.json`、`locale/zh.json` —— 显示元数据与文案
- `icon.svg` —— 原创图标（气泡+链接）
