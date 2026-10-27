# 13 节终点判据 · 通过（round 4，2026-10-10）

> 报告原件：`wt-dsh-e2e2/amazon-ops/scratch/e2e-round4/EVIDENCE-2026-10-10-round4.md`
> （新建，前三场未覆盖）。证据 `scratch/e2e-round4/out/`（setup/run/sql/sections/dom/judge/verdict/tabs）。

## 结论

**13 节这条线从 B-04 起的最大一块 `unverified` 关掉了。** 四处判据全部真机通过，
`variations` 的子体也不再是假阴性。

```
status = partial | page_region = #twister_feature_div | errors_json = []
parsed_value_json: {"parent_asin":null,"variation_dimensions":["color_name"],
  "children":["B0BRKQDS3S","B0GCMK4NZM","B0GCMT2CKC","B0GCMSQ21D","B0GCLSLKV2",
              "B0GCM827KY","B0BRKPK85W","B0GCMCSZNN","B0BX5DKMBJ","B0BX5BBM9M","B0GCMP6VSP"],
  "child_tiles":12}
```

| 判据 | round 3（修前） | round 4（修后） | 判定 |
|---|---|---|---|
| `variations` 维度 | `missing` / `[]` | `partial` / `["color_name"]` | ✅ |
| **`variations` 子体** | `[]`（假阴性） | **11 个**（12 减自己） | ✅ **终点判据** |
| `page_signals.return_policy` | `null` | `"FREE Returns"` | ✅ |
| `basic` / `page_signals` 的 `availability` | `In Stock {"isInternal":…}` | `In Stock` | ✅ |
| `page_signals.badges` | `["{\"acAsin\":…}"]` | `[]`（容器里只有脚本，`[]` 是对读数） | ✅ |

`status = partial` 而不是 `collected`，是因为这张 listing **本来就没有 `parent_asin`**
（`sectionValueCounts = {collected:2,total:3,missing:["parent_asin"]}`）—— **那是如实，不是缺陷。**

## 四重独立验证（这是「通过」的依据，不是单点）

1. **原始 SQL**：11 个互不相同、不含自己；`GROUP BY status` = collected 6 / missing 2 / partial 5；
   **无 failed、无 blocked**；`errors_json LIKE '%STATUS_%'|'%VARIATION%'` = 0 行。
2. **DOM 佐证**：`[id^="inline-twister-row-"]` 恰好 1 行；该行 15 个 `li`，`li[data-asin]` **12** 个（含自己）；
   **4 条 legacy 子选择器在该容器内仍命中 0** ⇒ 证明确实修的是第 5 种拼法 `data-asin`。
3. **机器集合运算**：`stored children == DOM − self` → **true**。
4. **插件自己的 `buildScript` 重跑**（在验证者那次渲染上）：`childHrefs` 12、`childTiles` 12、
   解析出 `children` 11 —— **与采集器落库逐字相同**。

**外加一条**：把 `children` 清空、重现 round 3 的失效形态 → `variationsChildrenUnread` =
`unread:true` / `sectionRecordStatus` = `failed` / 审计出 `VARIATION_CHILDREN_UNREAD`
⇒ **round 3 要的那条「没读到子体」安全网，在真实载荷上确实会触发**（进程内证明）。

## 本轮顺带查出的三件（都不是这条判据的事，但都要记账）

### ① ⚠️ **主线库 schema = 39，而本轮验的树是 38** —— 常驻那份跑的**不是** `dedc847`

验证者实测：主线 DB `user_version` = **39**，而它建的库是 **38**。
main 当时在 `dedc847`（v38）；v39 是 `wb-f1107`（F11-07）带来的。
⇒ **用户常驻的那份插件已经跑到比 `dedc847` 更新的树上去了**，或别的会话动过它。**值得确认一次。**

另：主线 DB 在验证者开工后**变过**（`576AA381…`(12:38) → `C7985246…`(14:07:51)），
但**不是它**：它显式传了 `dataDir`；查主线库**只读副本**按它的 task id → 0 行、今天 `submitted_at` → 0 条
（主线最新采集任务是 2026-09-24）。**是别的会话/常驻实例在写自己的库。**

### ② 两处「身份显示」都是**配置口径**，不是事实口径

- `browser_status.profile` 报主线路径，而 9333 上活着的是 scratch profile（round 3 已记）。
- **本轮新增**：插件体检 **`03-profile` 也是配置口径** —— 它报 `…\e2e-round4\chrome-profile`「目录还不存在」，
  而**那个目录从未被创建**，因为 `launcher.js:70-73` 遇到端口已有人就**收养**，
  此时 `config.profileDir` 是**无效配置**。⇒ **体检报的「profile 目录」不等于「实际在用的 profile」。**

### ③ `variations` 的**读表陷阱**仍在（可读性问题，不是采集问题）

`1/3` 与 `2/3` **都印 `partial`**，只有靠 `errors_json` / `child_tiles` 才分得清
「维度读到了但子体没读到」与「读到了一部分」。**表格上分不出来。**

## 本轮**未被行使**的两条（如实记，不当作已验证）

1. **拦截页（条件①）本轮 0 次遇到**，点了 0 下 ⇒ 「点几下」无答案；「冷 profile 下这条路能跑通」仍 `unverified`。
   造拦截页需要杀 Chrome / 换冷 profile = **破坏性操作，需用户确认**，验证者没有做。
   （round 3 的「1 下」继续算 `documented`/`stale`。）
2. **「采集器把邮编改过去」这个动作未行使** —— 暖 profile 已带 US cookie，
   `storefrontActions` 只有 2 条。证到的只是**状态**（`deliveryLocation` 与 DOM 两处对上）。
3. `closePage` 关被拦页那个缺口 —— 本轮未行使，仍 `unverified`（修复已派出）。

## 仍不可推广的边界

- **只跑 1 个 ASIN、1 次成功、US、一种布局**；`11/12` 是这条 listing 的 Color 行的数，**不可推广**。
- `child_tiles` 的「开集探针」这一半**未被独立证伪**（本页「属性名含 asin 的元素」与 `li[data-asin]` 是同 12 个）。
- `parent_asin` 为何为 null 未查。
- 那 5 分钟 `poll: null` 是**验证者自己的轮询夹具**读错了 `amzn_collect_status` 的字段
  （它返回渲染好的 `text` + 结构化键），**采集本身 9.5 秒就 done** —— 不是产品卡住。
