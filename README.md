# memory-bridge —— TencentDB Agent Memory × DSH（v0.3）

把腾讯开源的 [TencentDB Agent Memory](https://github.com/TencentCloud/tencentdb-agent-memory) 接进 DeepSeekRuntime：
**四个工具 + 一个侧边栏三页签面板**，可选每轮自动召回。

## 形状

| 层 | 文件 | 干什么 |
|---|---|---|
| Host | `index.js` | 注册 `memory_recall` / `memory_save` / `memory_status` / `memory_browse`；`/memory-bridge/api` 给面板用；`autoInject` 时把召回结果注入系统提示词 |
| Client | `client.js` | 侧边栏入口（id `memory-bridge`, order 44）+ 主面板：概览 / 浏览 / 设置 三个页签 |
| 配置 | `cordis.patch.yml` | 首次安装的默认值；面板保存的值落在 `~/.dsh/storages/memory-bridge.json`，**覆盖**这里 |

## 面板能看什么（这是这个插件的主要价值）

**概览**——一眼判断「通不通、库多大」：

- 网关：`/health` 的 status / version / uptime、向量库/embedding/全文检索是否就绪、抽取 worker 完成数与死信数、定时扫描次数
- 规模：**L1 原子条数 / L2 场景个数 / L3 画像字数** 三个大数字
- 画像开头几行 + 最近的场景列表（点进「浏览」看全文）
- 召回/写入次数与上次成功时间

**浏览**——按记忆金字塔逐层翻，全部只读：

| 页签 | 层 | 调什么 | 看到什么 |
|---|---|---|---|
| L3 画像 | Persona | `/v3/core/read` | 用户画像 markdown（称呼、偏好、长期目标） |
| L2 场景 | Scenario | `/v3/scenario/ls` → `/v3/scenario/read` | 场景块列表 + 点开全文 |
| L1 原子 | Atom | `/v3/atomic/search` | 事实条目 + 所属场景 + 相似度分数 |
| L0 对话 | Conversation | `/v3/conversation/search` | 原话命中（谁说的、哪个 session、什么时候） |

> v1（GitHub 开源 gateway）只有 L1/L0 的检索接口，没有画像和场景——面板会明说
> 「这个网关没有这些层」，**不会用空列表冒充「没有记忆」**。

**设置**——连接、高级项、诊断：

- 一个「入口地址」输入框，支持**整段粘贴自动拆分**：把 `http://…/relay/rl-xxxx` 和 `X-Relay-Key: rk_…` 一起粘进去，自动填成两个字段
- 两个预设按钮：`填本机直连`（`http://127.0.0.1:8420`）/ `填隧道默认`
- 高级（默认收起）：方言 v3/v1/auto、serviceId、命名空间四元组、超时、召回条数、会话键、每轮自动召回开关
- 诊断链路：`GET /health` → `v3 /v3/atomic/count` → `v1 /search/memories` 逐跳打勾，直接看断在哪一跳

## 工具（给模型用的）

| 工具 | 用途 |
|---|---|
| `memory_recall` | 按问题召回（L1 命中；v1 走 `/search/memories`） |
| `memory_save` | 写入事实（v3 写 L0 conversation，v1 走 `/capture`） |
| `memory_status` | 连通性 + 方言 + 命名空间，只读 |
| `memory_browse` | **翻库**：`mode=overview/persona/scenes/scene/atoms/conversations`，只读 |

`memory_browse` 是给「我现在库里有啥」这类问题用的；`memory_recall` 是给「我之前说过关于 X 的结论」用的。两者不要互相替代。

## 传输：一条 HTTP 隧道，不是 ssh

记忆网关（`tdai-gateway`）默认只听 `127.0.0.1:8420`。两种走法：

1. **直连**：`baseUrl = http://127.0.0.1:8420`，`relayKey` 留空。
2. **隧道**：网关跑在某台客户机的 8420，由面板发布成 `http://47.251.253.188:8080/relay/<id>`，请求带 `X-Relay-Key`：

```
DSH 插件 ──HTTP──▶ 面板 /relay/rl-xxxx（校验 X-Relay-Key）
                    └─▶ rathole 隧道口 172.17.0.1:18500
                         └─▶ 客户机 rathole client
                              └─▶ 127.0.0.1:8420 tdai-gateway
```

每一跳断掉都翻成人话（`describeFailure`）：

| 现象 | 含义 |
|---|---|
| `Relay Key 无效：面板侧 401` | 面板拦下了，`rk_` 那串不对 |
| `隧道对端没起来 … 502 upstream unreachable: EOF` | 面板通、隧道口通，但客户机 8420 上没有网关 |
| `网关 401：Bearer 令牌缺失或不匹配` | 网关开了 `TDAI_GATEWAY_API_KEY`，没带 Bearer |
| `路径不存在（404）：对端不是这个方言` | 部署的是另一套 API（v1 / v3） |

## 两套方言

| 方言 | 长什么样 | 关键路由 |
|---|---|---|
| `v3` | 部署版 `tencentdb-agent-memory-v2`：`{code,message,data}`，带 `x-tdai-service-id` | `/v3/atomic/{search,count}`、`/v3/conversation/{search,add,append,query}`、`/v3/scenario/{ls,read}`、`/v3/core/read` |
| `v1` | GitHub 开源 gateway（`src/gateway/server.ts`）：裸对象 | `/recall`、`/capture`、`/search/memories`、`/search/conversations`、`/session/end` |

`dialect=auto` 先探 v3 再探 v1，命中缓存 5 分钟。

## 网关侧建议配置（跟这个插件配套）

插件只负责「连」和「看」，记忆怎么攒是网关那边的事。按官方 README，值得调的几个：

| 项 | 默认 | 建议 |
|---|---|---|
| `recall.strategy` | `hybrid` | 保持 hybrid（BM25 + 向量 RRF），中文场景别单用 embedding |
| `recall.maxResults` | 5 | 与插件「召回条数」对齐，6 左右 |
| `pipeline.everyNConversations` | 5 | 想更快沉淀就调到 3 |
| `persona.triggerEveryN` | 50 | 想早点看到 L3 画像就调到 20 |
| `offload.enabled` | false | 长任务/长 session 才开（省 token），短对话没必要 |
| `embedding.*` | 本地 | 换远程 embedding 时注意 `sendDimensions:false`（BGE-M3 不支持 matryoshka） |
| `TDAI_GATEWAY_API_KEY` | 未设 | 走公网隧道**必须设**，否则 8420 谁都能写 |

## 已踩过的坑（改代码前先看）

1. **`output.render` 必须返回 `ContentBlock[]`**：`[{type:'text', text}]`。返回字符串 → 工具一调就 `content.some is not a function`。
2. **Host 进程里没有 `DSH_HOME`**：`process.env.DSH_HOME ?? '.'` 会退化成相对 cwd，配置永远读不到（`persistedAt: 0`）。按 `DSH_HOME → DSH_PROFILE_DIR 上一级 → ~/.dsh` 依次退。
3. **密钥字段别用「回遮罩值 + •••• 前缀判断没改」**：字符串一过 JSON/终端就变形，前缀判断失效后遮罩值会被当成新密钥写进配置。正确做法：面板只回 `relayKeySet` + `relayKeyMask`，输入框留空 = 不改。
4. 工具定义 `output: { schema, render }` 两个都要；入口方法叫 `execute`；工具名是进程级全局（另一个插件也注册 `memory_recall` 会让整棵插件树起不来）。
5. 装/改回路：`remove_bundle` → `install_bundle`（target 传**目录**）→ `GET /memory-bridge/api` 验。首次 install 后依赖变 `link:`，之后改源码再走一次 remove+install 让 Host 重新 import。

## v0.4：闭环、状态、代理开关、日志

### 一轮问答的数据流

```
你发一句话
  ↓ ① agent/pre-step（异步，不阻塞）
     这句话当 query → POST /v3/atomic/search（L1）
     top-6 × ≤260 字 → <team_memory> 注入系统提示词
     预算 4000 字 / 4s 超时 / 同 query 10 分钟不重查 / 连失 3 次停 5 分钟
  ↓ ② 模型推理（可自己调 memory_recall / memory_browse 下钻）
  ↓ ③ agent/turn-stopping（autoCapture 开着才做）
     用户这句 + 我的回答 → POST /v3/conversation/add（L0）
     L1 提炼交给网关（pipeline.everyNConversations），L2/L3 再往上归纳
```

省 token 的原则：**上下文只放索引与结论，原文按需下钻**——L3 画像（几十字）> L1 原子（top-k）> L2 场景（不自动注入）> L0 原文（只在核对时查）。

### 三段状态（memory_status）

| 段 | 看什么 | 失败含义 |
|---|---|---|
| 网关 | `/health` status/version、stores、pipeline worker | 记忆服务本身挂了 |
| 代理 | 记忆代理 `/health` status/upstream/configHash | LLM 转发挂了（不影响召回） |
| 隧道 | 401 / 502 / 404 分类 | Key 错 / 对端没起 / 路径不对 |

三段各自给结论，**不因为代理挂了就说网关挂了**。

### 记忆代理开关（memory_proxy / 面板卡片）

- 查询：`GET {proxyUrl}/health`
- 暂停/恢复：`POST {panelUrl}/panel/api/relay/save`
  - **必须带 `id` + `access_key`** 才是原地更新；只给 name/client_id 会**新建一条规则**（access_key 变、所有客户端断流）——实测踩过。
  - 暂停后该 relay 返回 404，恢复后 200；记忆网关（另一条 relay）不受影响。
- 工具侧 `pause/resume` 需 `confirm=true`；面板侧是二次确认按钮。

### 本地日志（默认脱敏）

- 文件：`~/.dsh/storages/memory-bridge.log.jsonl`（环形，2000 行）
- 字段：`ts / action / status / ms / count / chars / err / note`
- `logRedact: true`（默认）只记长度不记正文；面板「最近活动」可看最近 30 条，`memory_browse mode=logs` 给模型看。

### 新增配置

| 键 | 默认 | 说明 |
|---|---|---|
| `proxyUrl` | 记忆代理 relay | LLM 转发入口 |
| `proxyKey` | 空 | 该 relay 的 X-Relay-Key（同时作为规则 access_key） |
| `proxyRuleId` / `proxyClientId` / `proxyLocalAddr` | rl-c4628f30 / cli-9164e6181daf / 127.0.0.1:8096 | 开关代理时定位规则 |
| `panelUrl` / `panelKey` | 面板地址 / 空 | 开关代理需要面板 api_key |
| `autoCapture` | false | 每轮自动写 L0 |
| `logRedact` / `maxLogLines` | true / 2000 | 日志脱敏与环形上限 |
