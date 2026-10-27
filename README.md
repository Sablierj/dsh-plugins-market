# dsh-web-search-searxng

给 DSH 的 **SearXNG 一体化插件**：自己装环境、自己起服务、面板里管启停，然后给 agent 提供搜索。

**默认「便携优先」**：用 DSH 自带的 Python 跑 SearXNG——**不需要 Docker、不需要管理员、不需要重启系统**。换一台机器只要装这个插件，点一次「安装」就能用。

## 三种后端（自动选）

| 后端 | 前提 | 说明 |
|---|---|---|
| **portable**（默认） | DSH 自带 Python | 插件把源码 + 依赖装进自己的数据目录，起一个本地进程 |
| docker | 有 Docker Desktop | 拉镜像起容器；容器内引擎可走代理 |
| external | 你已有 SearXNG | 填 `baseUrl`，什么都不装 |
| — | 都没有 | 自动降级到 Bing HTML，保证搜索不空转 |

`backend: auto` 的判定：**有 Python 就用便携 → 没有再退 Docker → 再没有就 external/兜底**。

## 便携运行时到底装了什么

```
~/.dsh/dsh-web-search-searxng/runtime/
├─ portable-2026.10.20/        ← 一次安装 = 一个版本目录
│  ├─ searxng-master/          ← 源码（GitHub zip）
│  ├─ site-packages/           ← 私有依赖（pip --target，不污染系统 Python）
│  ├─ wincompat/               ← Windows 垫片：pwd / os.getuid（不改源码）
│  ├─ settings.yml             ← 开 json、关 limiter、默认开 360search/sogou/bing
│  ├─ manifest.json            ← 版本 / 体积 / 来源 / 安装时间
│  └─ searxng.pid
└─ current.txt                 ← 健康检查通过后才切
```

实测：**89.2 MB / 120 秒**（下载 6.8 MB + 31 个 wheel，全程不编译）。

升级 = 装新目录 → 起新进程 → 健康检查 → 切 `current.txt` → 停旧进程；旧版本留着可回滚。

## 离线包（断网机器）

```
searxng_service { action: "export" }                     # → ~/.dsh/dsh-web-search-searxng/export/searxng-portable-<版本>.zip
searxng_service { action: "import", file: "<zip 路径>" }  # → 解压成新版本目录 → 切 → 起
```

实测：**89.2 MB 的运行时压成 33.3 MB**；import 走的是「解压 + 写 settings + manifest」，不联网、不 pip。
导入前后会自动停旧实例（否则抢不到端口），旧版本目录保留可回滚。

## 源码镜像：拉不到 GitHub 时自动换源

按顺序尝试，第一个拿到 >1 MB 的胜出：

| 顺序 | 源 | 实测 |
|---|---|---|
| 0 | `runtime.sourceUrl`（你配的） | 可选 |
| 1 | `github.com/searxng/searxng/archive/.../master.zip` | ✅ 7,140,347 B |
| 2 | `gitee.com/mirrors/SearXNG/.../master.zip` | ✅ 字节数一致 |
| 3 | `gh-proxy.com/...` | ✅ 字节数一致 |

下载日志里会写出到底用了哪个源（`6.8 MB ← gitee.com`）。

## 面板

**设置 → SearXNG 搜索**

```
SearXNG 实例     后端：便携运行时 · 判定：自动（Python 可用）· 地址 127.0.0.1:8080
                 Python 3.12.14（dsh-bundled）· 版本 2026.10.20 · 89.2 MB
                 健康：5 条 / 20016ms
生命周期          安装 / 部署 · 启动 · 停止 · 重启 · 测活 · 日志 · 刷新 · 卸载
后端与搜索配置     自动 / 便携 / Docker / 外部 · 端口 · 引擎 · 语言 · 分类 · 安全搜索 · 条数 · 缓存
代理             启用 / 模式 / 地址 / Docker 容器内引擎也走代理
```

面板路由（同源、仅回环）：`/dsh-searxng/{status,action,config,logs}`。

## 工具

| 工具 | 用途 |
|---|---|
| `searxng_search` | `search` / `doctor` / `config` / `status` |
| `searxng_service` | `status` / `deploy` / `install` / `start` / `stop` / `restart` / `remove` / `uninstall` / `logs` / `health` / `versions` / `switch` |
| `searxng_web_search` | 与内置 `web_search` 同形的别名（`queries: [...]`） |

工具与面板调的是**同一批函数**，不存在两套逻辑。

## 为什么要接管 `web` 服务（这才是「不能用」的根因）

内置 `web_search` 工具并不直接选工具，它调用的是 harness 的 **`ctx.web.search()`**，而 `web` 服务按「配置的 provider id」解析实现。这台机器上配置的是 `deepseek-official`，那个 provider 没有 API key，于是**每一次搜索都在链路最底层失败**——插件自己注册的 `searxng_search` 再好也没用，因为没人调用它。

现在插件做两件事：

1. `ctx.web.registerSearchProvider()` 注册 SearXNG 实现，**同时占 `searxng` 与兼容 id `deepseek-official`**（配置里写的是选择键，不是实现）；
2. 在 `cordis.patch.yml` 里把内置的 `web-search-deepseek` 行关掉，避免两个 provider 抢同一个 id。

结果：内置 `web_search`、其它 agent、任何走 `web.search()` 的地方，全都自动落到 SearXNG。

> 想换回官方搜索：把 `web-search-deepseek` 改回 `disabled: false`，并给 DeepSeek 配 key。

## 引擎：国内必须显式指定

实测（国内网络）：

| 引擎 | 结果 | 备注 |
|---|---|---|
| `sogou` | ✅ 9–10 条 / 677ms | 快 |
| `360search`（360so） | ✅ 12–13 条 | 首查约 20s，之后快 |
| `baidu`（bd） | ⚠️ 有结果但常 CAPTCHA | 不建议首选 |
| `brave` / `google` / `duckduckgo` / `qwant` | ❌ timeout | 墙外，默认超时 |
| `bing` | ❌ 0 条 | 引擎解析已落后于 Bing 改版 |

所以默认 `engines: '360so,sogou'`，并把超时提到 **25s**——9s 会把「首次抓取慢」误判成「实例挂了」，直接掉进 Bing 兜底。

## 已知限制

- 首次安装要联网（GitHub 源码 + wheel）；纯离线包尚未提供。
- Docker 本身不能被插件安装（要 UAC + WSL2 + 重启），插件只能检测并建议。
- 便携运行时只在 Windows 验证过；Linux/macOS 上 `wincompat` 无副作用但未实测。
- 客户端面板改动后需要**重启 DSH**（渲染进程只在启动时装配 client 模块）。
