---
description: "用户控制台的常驻一半：本机凭据库（vault_list / vault_get / vault_save 工具与 /custom/vault 网页）与腾讯云 Agent Memory 桥（memory_recall / memory_save，经 ssh 访问远端 Memory Core）。"
kind: "private-plugin"
---

# dsh-plugin-user-console

<a id="use-this-package"></a>
## 使用本包

需要读写本机凭据库、或让 agent 跨会话记住事实时用它：它以 profile bundle 形式安装，因此凭据库与记忆桥都能挺过 Host 重启。凭据保存在本机 `.credentials.yaml`，记忆调用经 `ssh` 打到 47.251.253.188 上的 Memory Core，因为 8420 只在那台机器上发布，本机无法经公网直连。
