# Kodo 推理量消融：FastAPI（2026-10-29）

[真实上限报告](frontier-fourway-real-limits-20261028.md)发现，Kodo 在 FastAPI 上每次请求平均产生约 1,889 个推理 token，OpenCode 约 228。本轮分别去掉运行时状态块、缩减工具定义，检查这两项是否是推理变多的原因。

**结论：两项消融都没有降低每步推理，两格都在 5400 秒时限内没做完，reward 都是 0。** 但本轮与基线之间网关行为变了，单靠本轮不能把差异归到消融本身，见下文“对照失效”。

## 设置

- 开关只用于基准实验，由环境变量 `KODO_ABLATION` 控制，不设时行为不变（`tests/ablation.test.ts` 覆盖默认、`no-state`、`small-tools` 三种情况）。
  - `no-state`：请求末尾不再附加 `<kodo-runtime kind="state">` 状态块（`src/runtime/model-step.ts`）。系统提示、卡片方法、名册和环境块都不变。
  - `small-tools`：只暴露 12 个文件与进程工具：`shell.exec`、`file.read/list/search/patch/apply_patch/mkdir/rename/delete`、`process.exec/read`、`artifact.read`（`src/runtime/step-host.ts`）。去掉的是 todo、knowledge、history、agent 路由与协作类工具。状态块保留。首次请求的工具定义估算从 16,240 token 降到 3,832。
- 运行器新增 `--kodo-ablation no-state|small-tools`，写入 `trial.json` 与 manifest，launch.mjs 把它作为环境变量传给 Kodo。因此 `launcherSha256` 从基线的 `de3549f8…` 变为 `9d639a21…`；本地构建清单哈希为 `ad80c6db…`（基线 `9bbc1fb2…`，差别是这两个开关）。
- 其余与基线相同：`--kodo-local`，上下文 1,048,576，输出 393,216，时限 5400 秒，同一镜像、网关和验证器。
- 两格从 2026-10-29 02:56 UTC 同时开始。基线是单独运行的（10-28 16:04 UTC）。第一次尝试在 02:31 UTC 因网关对所有请求返回 403（“市场分组当前不可用”）而在首个请求失败，不计入结果。

## 结果

| 指标 | 基线 | no-state | small-tools |
|---|---:|---:|---:|
| 秒 | 2442.6 | 5406.3（超时） | 5406.4（超时） |
| 请求 | 106 | 118 | 71 |
| 新增测试 | 137/137 | 127/137 | 0/137 |
| 原有测试 | 3134/3134 | 3134/3134 | 3134/3134 |
| reward | 1 | 0 | 0 |
| 推理 token（全程） | 196,406 | 300,096 | 395,038 |
| 每次请求平均推理 | 1,889 | 2,587 | 5,809 |
| 每次请求推理中位数 | 581 | 67 | 5,618 |
| 单步推理超过 10k 的次数 | 3 | 10 | 15 |
| 前 60 次请求平均推理 | 2,551 | 3,111 | 5,450 |
| 输出 token | 223,552 | 330,541 | 406,239 |
| 计费输入 token / 缓存 | 19,065,365 / 17,882,496 | 7,148,418 / 7,008,256 | 2,898,758 / 2,679,296 |
| 单次最大计费输入 | 287,392 | 101,611 | 72,144 |
| credit | 34.79 | 37.32 | 43.77 |
| 平均每次请求耗时（秒） | 20.2 | 47.6 | 77.8 |
| 输出速度（token/秒） | 106.6 | 59.9 | 76.8 |
| 首次写文件 | 第 25 次请求 | 第 42 次 | 第 56 次 |
| 中断后恢复的请求错误 | 1 次 `fetch failed` | 1 次 `terminated`、1 次 `fetch failed` | 2 次 `terminated` |

三格都有 1–3 次请求缺少 usage，token 与 credit 都是下界。

- **no-state：** 多数步骤推理很少（中位数 67），但长推理的次数从 3 次增加到 10 次，平均反而更高。补丁覆盖了全部功能文件，包括 `fastapi/middleware/deprecation.py`，失败的 10 项都是多层 `include_router` 覆盖和优先级链，例如 `test_precedence_full_chain_route_gt_include_gt_router_gt_app`、`test_nested_include_router_overrides_at_every_level`。超时时它仍在修改代码。
- **small-tools：** 几乎每一步都长推理（中位数 5,618），71 次请求中有 55 次在写文件之前。补丁只改了 `fastapi/applications.py` 和 `fastapi/routing.py`，没有创建测试要导入的 `fastapi.middleware.deprecation`，测试模块导入失败，新增测试 0/137。它还 2 次调用了不存在的 `shell_command`。
- **credit 更高主要是因为跑满时限。** 两格都超时，credit 分别比基线高 7% 和 26%，计费输入 token 却只有基线的 37% 和 15%。credit 随时段变化，本轮也不宜和基线直接比较。

## 对照失效

本轮和基线之间，网关对回传推理的处理变了。

- 基线以及 10-29 01:23 UTC 之前的所有运行，计费输入 token 都包含回传的 `reasoning_content`。按请求总字符计约 4.2–4.7 字符/token；扣掉推理字符后只有 1.4–3.6 字符/token，低于正常值。
- 本轮扣掉推理字符后为 4.3–4.6 字符/token，算上推理则高达 16–27。也就是说，推理字符不再计入输入。
- 直接探测也证实了这一点：同一请求附带 40,280 字符的历史推理与不附带时，`prompt_tokens` 都是 933（最后一条是 tool 或 user 都一样）。
- 变化出现在 01:23 UTC 之后、02:56 UTC 之前，与 02:31 起的 403 故障在同一时段。

这说明上游现在很可能丢弃历史推理，模型每步都看不到自己之前的推理。这会直接影响要测量的推理量，也解释了计费输入为何降到基线的一半以下。此外，本轮输出速度只有基线的 56%–72%，两格同时运行也可能互相拖慢，所以 5400 秒超时不能单独归因于消融。

## 能确定的和不能确定的

- 可以确定：在当前网关条件下，去掉状态块或缩减工具都没有让每步推理降下来；缩减工具后推理增加、动手更晚，最终交付最差。
- 不能确定：推理量的变化有多少来自消融，有多少来自网关丢弃历史推理和变慢。要回答这个问题，需要在同一时段用同一网关跑一个不加开关的 Kodo 基线作对照，最好三格依次运行，避免并发。
- small-tools 的设计本身有混杂：系统提示里的组长规则仍要求用 `todo.write`、`spawn_agent` 等已被移除的工具。更干净的对照是同时用 `--agent-factors none`，让提示与工具集一致。

## 证据

- no-state：`.kodo/frontier-ablation-fastapi-no-state-2/manifest.json`
- small-tools：`.kodo/frontier-ablation-fastapi-small-tools-2/manifest.json`
- 403 失败的首次尝试：`.kodo/frontier-ablation-fastapi-no-state`、`.kodo/frontier-ablation-fastapi-small-tools`
- 分析脚本（`.kodo/`）：`ablation-status.mjs`（汇总）、`ablation-prefix.mjs`（前 N 次请求推理分布）、`ablation-detail.mjs`（耗时与最后一次请求构成）、`ablation-billing.mjs` 与 `reasoning-billing-timeline.mjs`（计费字符比）、`reasoning-probe.mjs`（回传推理是否计费）

运行结束后已确认无遗留 `fh-` 试验容器或网络。
