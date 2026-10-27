# dsh-plugins-market

> 由私有仓 `Sablierj/dsh-plugins` 的 `scripts/market/publish.mjs` 生成，**不要手改**。

## 装法（在另一台机器上）

1. DSH → **插件页 → 「发现」→ 索引源**，填：

   ```
   https://raw.githubusercontent.com/Sablierj/dsh-plugins-market/main/index.json
   ```

2. 选插件 → 安装（安装参数是 `git+<本仓>.git#<commit>`）。
3. 重启服务。

## 结构

| 分支/目录 | 是什么 |
| --- | --- |
| `main` | 索引 `index.json` + `market.config.json` + `icons/` + `scripts/market/` |
| `pkg/<插件>` | **该插件的包本体，`package.json` 就在这个分支的根上** |

## 版本怎么更新

1. 改插件代码，**把 `package.json` 的 `version` 升上去**（DSH 比的是版本号，同版本不同 commit 不算更新）；
2. 在**有这份代码的机器**上跑 `node scripts/market/publish.mjs --remote <本仓>`；
3. 它只重新发布本机有的插件，其它插件的条目与分支原样保留；
4. 另一台机器：发现页刷新 → 「有新版本」→ 卸载 → 再装。

## 为什么插件不在 `main` 的子目录里

DSH 生成的安装参数是 `git+<url>#<commit>&path:/<子目录>`，而 **pnpm 只读 `#` 后第一段**：
实测 pnpm 12.4.1 会忽略 `&path:`，装成仓库根，拿到一个没有 `package.json` 的占位包。
所以每个插件独占一个分支、让包落在根上，安装参数里就不需要 `path`。

## 红线

本仓只放可公开的插件代码：不得有 API key、密码、内网地址、候选人/客户数据、截图。
