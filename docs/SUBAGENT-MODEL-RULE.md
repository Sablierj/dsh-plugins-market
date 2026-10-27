# 派子代理的硬规则（主理人自用，2026-10-10）

> 用户明确要求：**后续派子 agent 要显式传模型，跟着配置跑。**
> 本文件是这条规则的落盘，防止我下次又忘（本会话我已经忘过一次「PowerShell 不支持 heredoc」——
> 说明「记在脑子里」不够，得写成可复查的动作）。

## 规则

**每次调用 `subagent` / `subagent_fork`，都必须显式传 `provider` 与 `model`。**

```javascript
subagent({
  description: "...",
  prompt: "...",
  provider: "b-worbuddy",
  model: "cn:deepseek-v4.1-flash",
  run_in_background: true,
})
```

## 为什么必须显式传

配置在 `C:\Users\78452\.dsh\profiles\desktop\cordis.patch.yml`：

```yaml
- id: subagent-model-selection-settings
  name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings"
  config:
    enabled: true
    allowedModels:
      - provider: b-worbuddy
        model: cn:deepseek-v4.1-flash
```

DSH 源码里那条策略的注释（`dsh-tool-subagent/lib/index.js` 的 `assertAllowedModelSelection`）：

> **Pure inheritance remains outside this policy because no model-facing choice occurred**;
> any explicit route or effort field must resolve to an allowed route.

⇒ **`allowedModels` 只管「显式指定」；不指定（纯继承）时它不生效。**
所以「不传模型」不等于「跟着配置跑」——那只是继承我这条会话当时的模型。

## 实测证据（2026-10-10，从会话日志解出来的）

会话日志在 `~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`，
是**多个 zstd 帧拼接**的（`zstdDecompressSync` 只解第一帧，必须按 magic `28 B5 2F FD` 切分再逐帧解）。
读 `subagent/descriptor` 的 `agentProvider`/`agentModel` 与 `request/header` 的 `config`：

| 批次 | 实际 provider / model | 传模型了吗 |
|---|---|---|
| T-01 ~ T-05（首发五条） | `b-worbuddy` / `cn:kimi-k3-1` | ❌ 没传（继承当时的会话模型） |
| T-01/T-04 收尾 + T-05 重派 | `b-worbuddy` / `global:deepseek-v4.1-flash` | ❌ 没传（会话模型切了，跟着切） |

**两条都不等于配置里的 `cn:deepseek-v4.1-flash`** —— 因为走的都是纯继承。

## 两个推论（下次别踩）

1. **想让它跑配置里那个** → 必须显式传 `provider: "b-worbuddy", model: "cn:deepseek-v4.1-flash"`。
   显式指定才会去查 `allowedModels`，而它正好在白名单里 ✅。
2. **不能显式指定白名单外的** → 例如 `global:deepseek-v4.1-flash` 不在 `allowedModels` 里，
   显式传它会被拒（`child LLM route "…/…" is not allowed for this Session`）。

## 派活前的自查（照抄）

- [ ] `provider` 传了吗？`model` 传了吗？
- [ ] 传的值是 `b-worbuddy` / `cn:deepseek-v4.1-flash` 吗？
- [ ] 如果确实需要白名单外的模型 → **先问用户**，不要硬传。
