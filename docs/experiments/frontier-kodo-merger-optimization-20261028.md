# Kodo 数据合并题效率优化（2026-10-28）

目标：在进入 FastAPI 复测前，先压低 Kodo 在 Terminal-Bench `multi-source-data-merger` 上的耗时与额度。任务、模型（`deepseek-v4.1-flash`）、网关、上下文 65536、输出上限 8192、容器与验证器均与[第二轮复测](frontier-fourway-repeat-20261028.md)相同。

## 发现

1. **前两轮测的是旧内核。** `kodo-frontier-tools:20261028` 镜像构建于 16:22，本地 `dist` 构建于 19:54。镜像内的 team-lead 提示仍要求“默认把实质工作交给队友，包括顺序任务”，`TODO_PLAN_REQUIRED` 也写着“Delegate substantive work”。第二轮数据题的 50 次请求里，主 agent 因此创建 implementer、写合同、为报告格式往返（`INPUT_SLOTS`、`REPORT_FIELDS` 错误）、再派一次 followup 做验证。本地代码已把这段提示改为“小任务直接执行”，只是没进镜像。
2. **当前代码剩余的浪费在 todo 门槛。** 用本地 `dist` 跑一次：84.0 秒、10 次请求，没有委派。其中 4 次请求只为 todo：第一次执行被 `TODO_PLAN_REQUIRED` 拒绝，之后每个阶段切换和最后收尾各写一次 `todo_write`。

## 改动

- [run.mjs](../../scripts/comparison/frontier/run.mjs) 新增 `--kodo-local`：把本地 `dist` 只读挂载到 Kodo 容器的 `/opt/fh/kodo/dist`，清单记录 `kodoBuild` 与构建清单哈希。之后改内核不必重建镜像，也能确认测的是哪个构建。
- [todo-execution.ts](../../src/runtime/todo-execution.ts)：team-lead 模式下，只有任务列表里还有未完成项、却没有 in_progress 项时才要求选择执行者。没有任务列表的小任务可直接执行；agent todo 的所有权约束不变。
- [agent-factors.ts](../../src/runtime/agent-factors.ts)：对应提示改为“小任务不需要任务列表”，并要求不要在最终回答前单独花一步把 main todo 标为完成。
- 测试：[todo-runtime.test.ts](../../tests/todo-runtime.test.ts) 新增“无任务列表直接执行”用例，原用例改为“有未完成计划时仍需指定执行者”；[recovery-todo-plan.test.ts](../../tests/recovery-todo-plan.test.ts) 的普通 followup 断言随之更新。

## 结果

| 运行 | 内核 | 秒 | 请求 | 输入 token / 缓存 | 输出 token | credit | 验证 |
|---|---|---:|---:|---:|---:|---:|---|
| 第二轮 | 镜像（旧） | 351.5 | 50 | 1,018,058 / 858,752 | 28,553 | 4.17 | 3/3 |
| 改前 | 本地 dist | 84.0 | 10 | 157,212 / 104,192 | 5,846 | 1.12 | 3/3 |
| 改后 #1 | 本地 dist | 135.4 | 17 | 286,632 / 255,232 | 7,967 | 至少 0.99 | 3/3 |
| 改后 #2 | 本地 dist | 67.1 | 7 | 104,083 / 83,200 | 4,926 | 0.61 | 3/3 |
| 改后 #3 | 本地 dist | 51.1 | 6 | 85,608 / 66,304 | 4,040 | 0.52 | 3/3 |

改后三次均无 `todo_write`、无委派。#2、#3 的轨迹是：查看输入 → 写脚本 → 运行 → 检查输出 → 回答。#1 是模型波动：首版脚本把合并结果写成空值，模型花了 9 次 shell 调试；另有 1 次流式响应被中断（`terminated`），缺 usage，所以该格 credit 是下界。改后三次的中位数为 67.1 秒、7 次请求、0.61 credit。第二轮同题 Pi 44.2 秒/0.27、OpenCode 59.8/0.40、DeepSeek Harness 51.5/0.34，Kodo 已进入同一量级。credit 只比较同日相近时段的运行；跨轮计价是否一致仍未核实。

## 仍存在的固定开销

Kodo 每次请求带 38 个工具定义（约 35k 字符），首次输入约 12k token；Pi 是 4 个工具。数据题里步数已接近其他三方，剩余差距主要来自每步更大的输入。缩减主 agent 的默认工具集是下一项候选，但会影响复杂任务的委派能力，应在 FastAPI 上一并验证。

## 验证

- `tsc --noEmit` 与 `eslint src tests scripts` 通过。
- 全量 `npm test`：158/159 个文件通过；`tests/tui-view.test.tsx` 有 7 项失败（文件补全与外部编辑器）。把本次两处源码改动临时还原后，该文件仍是同样 7 项失败，属于既有问题，与本次改动无关。

## FastAPI 复测（`--kodo-local`）

第二轮 FastAPI 的 Kodo 格同样运行在旧镜像上，183 次请求里的委派开销来自已被替换的提示。为确认当前内核的表现，用 `--kodo-local` 单独重跑 Kodo 一格：任务 `fastapi-deprecation-response-headers`，限时 1800 秒，模型、网关、上下文、输出上限、容器资源（8 GiB/2 核）与外部验证器均与第二轮相同。挂载的构建清单哈希为 `9bbc1fb2…`，与数据题改后三次相同。

| 运行 | 内核 | 秒 | 请求 | 输入 token / 缓存 | 输出 token | credit | 新增测试 | 原有测试 | reward |
|---|---|---:|---:|---:|---:|---:|---|---|---:|
| 首轮 | 镜像（旧） | 1490.8 | 136 | 4,048,588 / 3,444,224 | 150,293 | 36.39 | 137/137 | 3134/3134 | 1 |
| 第二轮 | 镜像（旧） | 1806.5（超时） | 183 | 5,538,854 / 4,823,552 | 166,062 | 至少 21.05 | 127/137 | 3134/3134 | 0 |
| 本次 | 本地 dist | 527.5 | 39 | 1,067,942 / 912,256 | 55,185 | 至少 5.66 | 134/137 | 3134/3134 | 0 |

- **效率：** 相比第二轮，耗时约降至 29%，请求约降至 21%，可见 credit 约降至 27%。本次正常退出（exit 0），没有触及时限。第二轮同题 Pi 为 773.8 秒、93 次请求、5.58 credit、136/137。
- **行为：** 全程没有委派和 `todo_write`；工具调用以 `shell_exec` 为主，另有少量 `file_read`、`file_apply_patch` 和 1 次 `update_progress`。有 1 次响应达到 8192 输出上限（第 20 次请求），随后模型改为分段继续。上下文在约 55k token 处做过一次 mask 压缩（54,612 → 46,990）。
- **失败原因：** 3 项新增测试失败，全部是 `DeprecationTrackingMiddleware`：补丁为未弃用的路径也写入了 `{"deprecated_hits": 0, "sunset_hits": 0}`，测试要求这类路径不出现在 `get_stats()` 中。任务说明只写了“按路径统计”和两类命中条件，没有明示零计数路径要排除，属于对规格的一处理解偏差，不是流程问题。
- **自检：** 模型自己新增了 `tests/test_deprecation_signals.py`（15 项），并报告本地全量 3149 passed；自写测试没有覆盖“未弃用路径不应出现”，所以没发现这处偏差。
- **usage 缺口：** 第 11、13 次请求流式中断（`terminated`），缺 usage，因此 token 与 credit 都是下界。

结论：当前内核在 FastAPI 上不再出现旧镜像那种委派开销，耗时与额度已和 Pi 同一量级，且在时限内正常交付；质量差 3 项，二值 reward 仍为 0。这是单次采样，不能据此估计稳定通过率。

## 证据

- 数据题：`.kodo/frontier-kodo-opt-baseline`、`.kodo/frontier-kodo-opt-1`、`-2`、`-3`。
- FastAPI：`.kodo/frontier-kodo-opt-fastapi`，含补丁 `artifacts/model.patch`、验证器 `verifier/reward.json` 与 `ctrf.json`。

每个目录含 `manifest.json`、逐请求 relay 记录与验证日志。运行结束后已确认无遗留 `fh-` 试验容器或网络。
