---
description: "The persistent half of the DSH user console: the local credentials vault (vault_list / vault_get / vault_save tools plus the /custom/vault page) and the TencentDB Agent Memory bridge (memory_recall / memory_save over ssh)."
kind: "private-plugin"
---

# dsh-plugin-user-console

<a id="use-this-package"></a>
## Use this package

Load it when a session needs the local credentials vault or cross-session memory: it installs as a profile bundle, so both halves survive a Host restart. Credentials stay in this machine's `.credentials.yaml`, and memory calls reach Memory Core on 47.251.253.188 through `ssh`, because 8420 is published on that host only.
