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

## 为什么插件在 `pkg/<名字>` 分支的根上，而不是 `main` 的子目录里

> 更正（2026-10-27）：这里原本写「pnpm 不认 `&path:`」，**已复测推翻**。用 DSH 自带的
> pnpm **11.28.5** 装 `git+<url>.git#<commit>&path:/plugins/x`，装进来的确实是子目录那个包，
> 仓库根包没装，依赖行也原样保留 `&path:`，DSH 的 apply 状态是 applied。

仍然沿用「一插件一分支、包在分支根」的理由只有一个：安装参数更短更稳
（`git+<url>.git#<sha>`，没有第二个参数），且这套已经跑通、有 tag 兜底。
想改回子目录布局随时可以，pnpm 这一层不再是障碍。

## 版本历史

- `state.json` 里每个插件是 `versions[]`（每版 `{version, commit, timestamp}`），索引列出**全部历史版本**，DSH 的版本列表会把它们都显示出来。
- 每次发布给该版本打 tag：`<插件>-v<版本>`。分支可能被 force-push 覆盖，**tag 才是旧版本的锚点**；没有 tag 的旧 commit 迟早被 GC，索引里记着也装不回来。
- 回滚 = 装旧版本的 commit：`git+<url>.git#<旧 sha>`。

## 更新

升级 = 用新版本的 commit 再装一次（同包名覆盖依赖行），不必先卸载；装完刷新一次窗口。
索引缓存默认 10 分钟（`cacheTtlMs`），刚发完看不到新版先等缓存。

## 红线

本仓只放可公开的插件代码：不得有 API key、密码、内网地址、候选人/客户数据、截图。
