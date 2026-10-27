# 会话模型反代 · Session Model Bridge

把一个 **DSH 会话当前选择的模型**（包括免费模型）用 **统一的模型名** 反代到本机一个
**OpenAI 兼容 + Anthropic 兼容** 的 HTTP 端点上，让**其他 agent**（Claude Code、Codex、
Cline、任意 OpenAI/Anthropic SDK、脚本）直接拿去用。

- 对外只有一个模型名：`dsh-session`（可配）。
- 后台模型**不是**配置死的：每次请求都实时读取来源会话的当前模型选择，
  会话里换了模型，反代立刻跟着换 —— 客户端配置完全不用动。
- 每个会话有自己的令牌，互不干扰；令牌与固定设置持久化在
  `~/.dsh/session-model-bridge/state.json`，Harness 重启后依旧有效。

```
其他 agent ──(统一模型名 dsh-session)──► http://127.0.0.1:8788/v1/*
                                            │ 令牌 → 会话
                                            ▼
                                  会话当前模型 (provider/model)
                                            │
                                            ▼
                                      ctx.llm.stream(...)
```

## 快速开始

1. 在任意会话里让 agent 调用工具 `session_model_bridge`，`action: "publish"`。
   它返回 `baseUrl`、`apiKey`、当前后端模型，以及可直接抄的环境变量。
2. 把返回的环境变量给别的 agent（示例见下）。
3. 想让反代换成另一个模型？在 DSH 里把这个会话的模型换掉即可。

令牌也会自动为每个**新会话**生成（`autoPublish: true`），所以通常你只需要
`action: "list"` 找到目标会话的令牌。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 存活与状态（无需鉴权） |
| GET | `/v1/models` | 模型列表；带令牌时首个条目含 `x_dsh_backend`（真实后端、来源会话、是否过期） |
| POST | `/v1/chat/completions` | OpenAI Chat Completions，支持 `stream`、`tools`/`tool_calls`、`stream_options.include_usage` |
| POST | `/v1/messages` | Anthropic Messages，支持 `stream`、`tools`(tool_use/input_json_delta)、`tool_result` |

请求里的 `model` 字段**被忽略**（统一模型名），后端由令牌对应的会话决定。
鉴权：`Authorization: Bearer <token>`、`x-api-key: <token>` 或 `?key=<token>`。

错误体按协议返回：OpenAI 形状 `{"error":{message,type,code}}`，
Anthropic 形状 `{"type":"error","error":{type,message,code}}`。

## 客户端配置

**Claude Code / Anthropic SDK**

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:8788"
export ANTHROPIC_AUTH_TOKEN="sk-dsh-…"      # 也可以用 ANTHROPIC_API_KEY
export ANTHROPIC_MODEL="dsh-session"
```

**Codex / 任意 OpenAI 兼容客户端**

```sh
export OPENAI_BASE_URL="http://127.0.0.1:8788/v1"
export OPENAI_API_KEY="sk-dsh-…"
export OPENAI_MODEL="dsh-session"
```

**curl 冒烟**

```sh
curl http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer sk-dsh-…" -H "content-type: application/json" \
  -d '{"model":"dsh-session","messages":[{"role":"user","content":"ping"}]}'
```

**DSH 自己的子代理后端**：`@deepseek-ai/dsh-subagent-claude-code` 与
`@deepseek-ai/dsh-subagent-codex` 都支持 `env` 字典配置，把上面对应的环境变量塞进去，
就能让 Claude Code / Codex 子代理跑在会话当前（免费）模型上。

## 工具 `session_model_bridge`

| action | 作用 |
| --- | --- |
| `status` | 服务状态、端口、配置、目标数、最近 5 条请求 |
| `publish` | 为**当前会话**确保一个令牌，返回 baseUrl / apiKey / 后端模型 / 各客户端环境变量 |
| `list` | 列出全部会话令牌与各自当前后端（`reveal: true` 显示完整令牌） |
| `revoke` | 吊销令牌（默认吊销当前会话；`all: true` 吊销全部） |
| `pin` | 把后端固定到指定 `provider`/`model`；不带参数则取消固定，恢复跟随会话 |

## 配置

写在 profile 的 patch 层（`cordis.patch.yml` 里本插件那一行）或本包的
`cordis.patch.yml`，全部可选：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉则不监听端口 |
| `host` | `127.0.0.1` | 只绑本机；改成 `0.0.0.0` 前请想清楚，这是明文令牌 |
| `port` | `8788` | 监听端口 |
| `modelName` | `dsh-session` | 对外统一模型名 |
| `autoPublish` | `true` | 为每个新会话自动生成令牌 |
| `requireToken` | `true` | 关闭后仍需要一个令牌来定位会话，仅在显式放开时才允许无令牌 |
| `maxTokens` | `8192` | 客户端未指定 `max_tokens` 时的默认值 |
| `requestTimeoutMs` | `900000` | 单次模型请求上限；客户端断开也会取消上游 |
| `logRequests` | `true` | 每条请求记一行日志 |
| `fallbackToDefaultModel` | `true` | 会话还没发过请求时，退回进程默认模型 |
| `providerTools` | 内置见下 | 按 provider 追加「上游门禁要求的工具声明」；`false` 关闭内置 |
| `statePath` | `~/.dsh/session-model-bridge/state.json` | 令牌持久化位置 |

## 免费模型（OpenCode Zen Free）

本 profile 装了 `@jiesou/dsh-opencode-zen-free-provider`，它把 Zen 免费模型接进 DSH。
Zen 免费层有一道**服务端门禁**：请求里必须声明小写 `bash` 与 `read` 两个工具，
否则一律返回 `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`。

该 provider 会给 DSH 自己的请求自动补齐占位工具，但**反代进来的请求它不补**（它重写的是
会话转录里第一条 system 消息，而反代请求没有这条消息）。实测：

| 请求 | 结果 |
| --- | --- |
| 无 tools | `FreeTierError` |
| 声明 `bash` + `read` | 正常返回 |

所以本插件在**解析到后端 provider 为 `opencode-zen-free-provider` 时**，会自动补上同名同
参数的占位工具（描述沿用 provider 自己的文案「Requirement placeholder … cannot execute it」）。
其它 provider 一概不动。想自己控制：

```yaml
config:
  providerTools:
    some-provider:
      - name: bash
        description: ...
        parameters: { type: object, properties: { command: { type: string } }, required: [command] }
# 或者整体关闭内置补齐
# providerTools: false
```

## 已知限制

- **图片输入不支持**：OpenAI 的 `image_url` / Anthropic 的 `image` 块会返回 400，
  并给出明确提示（而不是静默丢图）。
- **Anthropic 用量字段**：流式的 `message_start.message.usage.input_tokens` 恒为 `0`
  （为了真流式，第一个字节不能等上游的 usage），真实用量在收尾的
  `message_delta.usage` 里，官方 `@anthropic-ai/sdk` 会合并进 `finalMessage().usage`。
- **用量口径**：OpenAI 路径按官方定义 `total_tokens = prompt_tokens + completion_tokens`，
  上游的缓存命中 token 折进 `prompt_tokens` 并暴露 `prompt_tokens_details.cached_tokens`，
  思考 token 暴露为 `completion_tokens_details.reasoning_tokens`（因此可能与上游控制台
  显示的 `total_tokens` 数值不同）。
- **思考内容**：OpenAI 路径以 `reasoning_content` 原样透出；Anthropic 流式会输出无签名的
  `thinking` 块（官方 SDK 解析正常）。若你的客户端强制校验 thinking 签名，请在客户端关闭
  extended thinking。
- 后端模型来自 `session.requestContext()`；会话关闭后使用最后一次已知的模型
  （`x_dsh_backend.stale = true` 可看出），保证反代在关掉聊天窗口后仍可用。
- 令牌是本机回环用的明文令牌，请勿把 `host` 暴露到公网。
- 免费模型本身可能被上游限流/限区，报错会按原样透传（`code` 字段保留上游错误码）。

## 实现结构

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 插件：监听、鉴权、会话→后端解析、令牌注册表、`session_model_bridge` 工具 |
| `lib/bridge-core.js` | 冻结契约：`BridgeApi`、`BridgeError`、`StreamChunk` 归并 |
| `lib/openai.js` | OpenAI Chat Completions / models 线协议 |
| `lib/anthropic.js` | Anthropic Messages 线协议 |
| `test/` | 离线协议测试与端到端 HTTP 测试 |

## 验证

```sh
# 离线（假 api，不调用模型）
node test/offline.mjs

# 端到端（需要 Harness 在跑且插件已挂载）
BRIDGE_TOKEN=sk-dsh-… node test/e2e.mjs

# 官方 Anthropic SDK 兼容性（需要 @anthropic-ai/sdk 可用）
node test/sdk-anthropic.mjs
```

最近一次全量结果（本机，插件 v0.1.0）：

| 套件 | 结果 |
| --- | --- |
| `test/offline.mjs` | 42 passed / 0 failed |
| `test/e2e.mjs` | 27 passed / 0 failed |
| `test/sdk-anthropic.mjs` | 6 passed / 0 failed |

未独立观测项：客户端断流后上游是否真正取消（`res.on('close') → abort()`，但没有统计端点可证）。

## 开发提示（改代码后如何生效）

插件以 `link:` 方式装进 profile，所以工作区就是运行代码；但 **dsh-hmr 只在插件入口
`index.js` 变化时重载整个模块图，只改 `lib/*.js` 不会生效**（ESM 缓存会继续用旧模块）。
可靠的重载方式：

```
plugin_manager set_plugin target="include:session-model-bridge" enabled=false
plugin_manager set_plugin target="include:session-model-bridge" enabled=true
```

重载后 `GET /healthz` 仍返回同一批会话令牌（令牌持久化在 state.json），不需要重新配置客户端。
