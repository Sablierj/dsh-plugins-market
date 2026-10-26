# dsh-plugins-market

> 由 `Sablierj/dsh-plugins` 的 `scripts/market/publish.mjs` 生成，**不要手改**。

这是这台机器上若干 DSH 插件（组合包）的发布仓兼插件市场索引。

## 装法（在另一台机器上）

1. DSH → **插件页 → 「发现」→ 索引源**，填：

   ```
   https://raw.githubusercontent.com/Sablierj/dsh-plugins-market/main/index.json
   ```

2. 在列表里选插件 → 安装（DSH 会用 `git+…&path:/plugins/<名字>` 拉这一版）。
3. 装完重启服务。

## 更新

市场只报告「有新版本」，不原地升级：先卸载再安装（DSH 行为，不是这里的限制）。

## 自检（发布后跑一次）

```bash
node scripts/market/verify.mjs --url https://raw.githubusercontent.com/Sablierj/dsh-plugins-market/main/index.json
```

它像另一台机器那样：不跟重定向地取索引、查 BOM、按 format 1 校验、取每个图标、
再逐个 git 版本 `fetch --depth 1 <commit>` 并核对 `<path>/package.json` 的 name/version。

## 内容

| 目录 | 说明 |
| --- | --- |
| `index.json` | 插件市场索引（format 1），由 `node scripts/market/build.mjs` 生成 |
| `market.config.json` | 生成索引用到的元数据 |
| `plugins/` | 插件本体，每个目录是一个可安装的 DSH 组合包 |
| `scripts/market/` | `build`（生成索引）/ `check`（本仓自查）/ `verify`（发布后联网自检） |

安全边界：本仓只应包含可公开的插件代码，不得有 API key、密码、内网地址、候选人/客户数据。
