# dsh-plugins-market（公开快照仓）

> 本文件由私有仓 `Sablierj/dsh-plugins` 的 `scripts/market/publish.mjs` **生成**，不要手改。

## 判据：这个仓是只读的

```bash
git remote get-url origin   # 含 `-market` ⇒ 这是只读快照仓
```

命中就不要在这里改代码、不要在这里提交：本仓除 `.git` 外的内容每次发布都会被删掉重铺，手写的东西下一次发布就没了。

## 该去哪儿改

| 想做什么 | 去哪儿 |
| --- | --- |
| 改插件本体 | 私有仓 `Sablierj/dsh-plugins/<plugin>/` |
| 改索引展示信息（标题/分类/关键词/图标） | 私有仓 `market.config.json`（本仓那份是生成物） |
| 发版 | 私有仓里 `node scripts/release.mjs <plugin> <spec> "说明"`（spec = patch / minor / major / x.y.z） |

## 索引

- 索引源：`https://raw.githubusercontent.com/Sablierj/dsh-plugins-market/main/index.json`
- 安装参数：`git+https://github.com/Sablierj/dsh-plugins-market.git#<commit>`（每个插件一个 `pkg/<插件>` 分支，包在分支根上）
