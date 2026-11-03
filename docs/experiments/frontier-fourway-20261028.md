# FrontierHarness 子集：Kodo / Pi / OpenCode / DeepSeek Harness

日期：2026-10-28。结论只适用于本次同模型、单次运行的两个任务；不与官方 Kimi K3 榜单排名混比。

## 方法与范围

- 基准来源：[frontier-harness-eval/eval](https://github.com/frontier-harness-eval/eval)，固定提交 `e837a70bd6beb4e72eeeda62dd06e3bd34f6cb63`。
- 两道不同类型的任务：Terminal-Bench `multi-source-data-merger`（数据产物，原时限 900 秒）；DataCurve `fastapi-deprecation-response-headers`（跨文件功能与回归，原时限 5400 秒，本实验统一截为 1800 秒）。后者的截断结果不能视为官方完整时限成绩。
- 四方均通过同一 `codego1` 网关调用 `deepseek-v4.1-flash`，上下文设为 65536、单次输出上限 8192。Kodo 为本地构建的 `0.1.0-alpha.0` 快照，Pi `1.3.0`，OpenCode `1.19.3`，DeepSeek Harness `0.2.1-rc.2`。不同 harness 自带的提示、工具数量和推理处理保留为比较对象。
- 每格使用同一任务镜像的独立一次性 Docker 容器；任务容器仅连内部网络和模型中继，验证器是另一个断网容器。逐格顺序运行，时间从容器启动到 agent 退出，不计外部验证。内存/CPU：数据题 2 GiB/1 核，FastAPI 8 GiB/2 核。
- `credit` 是网关 usage 原样累加的额度单位，**不是美元**。输入 token 包含缓存命中；所有下表有效格的 usage 均有返回，没有估算缺口。单次运行有采样波动，不能据此给出稳定胜率。
- FastAPI 首轮 Pi/OpenCode 走容器到中继的直连，Kodo 与 DeepSeek Harness 有效复跑走容器回环转发后到同一中继；模型请求目标相同，网络路径多一跳。时间读数因此还包含这项很小但未单独量化的差异。

## 结果

| 任务 | Harness | Agent 秒 | 请求 | 输入 token / 缓存命中 | 输出 token | credit | 外部验证 |
|---|---|---:|---:|---:|---:|---:|---|
| 数据合并 | Kodo | 468.7 | 64 | 1,375,021 / 1,143,168 | 36,204 | 11.41 | 3/3 通过 |
| 数据合并 | Pi | 78.9 | 10 | 58,306 / 53,632 | 6,791 | 0.94 | 3/3 通过 |
| 数据合并 | OpenCode | 126.6 | 14 | 178,321 / 165,760 | 8,746 | 1.46 | 3/3 通过 |
| 数据合并 | DeepSeek Harness | 48.8 | 7 | 47,746 / 39,424 | 3,876 | 0.71 | 3/3 通过 |
| FastAPI | Kodo | 1490.8 | 136 | 4,048,588 / 3,444,224 | 150,293 | 36.39 | 新增 137/137、原有 3134/3134；reward 1 |
| FastAPI | Pi | 79.8 | 9 | 84,294 / 65,152 | 8,879 | 1.62 | 无补丁；未完成 |
| FastAPI | OpenCode | 701.4 | 93 | 3,210,958 / 3,111,808 | 30,363 | 8.07 | 新增 137/137、原有 3134/3134；reward 1 |
| FastAPI | DeepSeek Harness（修正配置复跑） | 168.8 | 18 | 411,534 / 377,600 | 18,598 | 3.32 | 新增 0/137、原有 3134/3134；reward 0，无补丁 |

数据题四份 Parquet 的四个用户、字段值和 `conflicts.json` 的三条冲突逐项一致。FastAPI 的 Kodo 与 OpenCode 补丁均经官方任务验证器全量通过；一次运行的通过不能证明所有未覆盖边界，也不代表维护性相同。Pi 在复杂题最后一次模型响应达到 8192 输出上限，退出时没有改动。DeepSeek Harness 复跑在约 50k 的单轮内部 token 上限处结束，未提交改动。

Kodo 的数据题使用 4 个运行上下文，记录了 2 次 `spawn_agent` 工具调用；首次请求输入 11,849 token、可见工具 38 个。Pi 为 1,517 token/4 工具，OpenCode 5,862/10，DeepSeek Harness 5,668/25。FastAPI 题 Kodo 到约 12 分钟才开始写文件，最后通过验收；相比同样全过的 OpenCode，耗时约 2.1 倍，`credit` 约 4.5 倍。这是本次轨迹的成本事实，不能单凭首轮提示大小断言因果。

八个有效格的可见 usage 合计约 **63.92 credit**；被排除的 DeepSeek Harness 首次 FastAPI 运行另消耗约 **4.07 credit**，故本次所有已返回 usage 的请求合计约 **67.99 credit**。早期 HTTP 502 未返回 usage，外部账单是否仍计费未获证实。

## 权限与隔离

| Harness | 产品默认或公开配置 | 本次可写试验 | 隔离边界 |
|---|---|---|---|
| Kodo | 非交互 CLI 默认只读；写和执行需分别授权，可选逐工具宿主审批；`--sandbox` 显式启用原生 OS 沙箱 | `--allow-write --allow-exec`，未启用内层 `--sandbox` | 原生文件工具检查工作区和受保护路径；此配置下进程工具本身是可信宿主进程，靠外层 Docker 隔离 |
| Pi | 官方说明无内建文件、进程、网络、凭据权限系统或 OS 沙箱；`--no-approve` 是项目本地文件信任开关 | 原生工具可操作容器工作区，关闭扩展/MCP/项目提示发现 | 外层 Docker；进程继承容器内用户权限 |
| OpenCode | 规则式 allow/ask/deny；默认多数工具允许，外部目录、`.env` 读取和循环风险等会问；非交互 `run` 默认拒绝待问请求 | 配置 `permission: "allow"`，使任务可非交互写入 | 审批是工具层策略；本次 OS 隔离来自外层 Docker |
| DeepSeek Harness | 发布配置默认 `workspace-write` + `ask`，文件和 shell 走本地沙箱提供者 | `danger-full-access` + `never`，关闭内层审批限制 | 本次有效隔离来自外层 Docker；默认模式的工作区约束不等同于本次实验设置 |

这些是配置与源码审阅及正常任务轨迹，不是隔离突破测试。任务容器不接触真实网关密钥，只持有中继占位值；真实凭据仅注入父级中继容器。第三方任务内容与模型响应只当作数据，不作为宿主指令。

## 无效轨迹与修正

1. 数据题最初两次短试跑分别遇到非回环模型 URL 拒绝、模型中继 HTTP 502；当时的验证器还把 Python 入口重复指定，因而结果无效。均未计入表格；完整 Kodo 轨迹和后三方使用正确的三项断言。
2. FastAPI 镜像中的 `/tests/test.sh` 带 CRLF，最初四格的原验证日志在 Bash 解析处失败。运行器改为执行时规范化换行；原 OpenCode 补丁经独立重验得到 reward 1。原 DeepSeek Harness 的部分补丁重验 reward 0，错误为 `datetime` 未导入。
3. FastAPI 的首次 Kodo 启动使用旧镜像内的非回环模型 URL，被 Kodo 的 URL 校验立即拒绝，耗时 1.9 秒且零模型请求；表中改用只读挂载的修正启动脚本复测。
4. DeepSeek Harness 首次试跑的遥测值 `OFF` 不受该版本接受，部分补丁在约 245 秒后中止。表中采用 `DISABLED` 的独立复跑；它没有产生补丁。两次原始轨迹均保留，没有把失败隐藏为成功。

## 判断

Kodo 已能进入真实横向评测，且本次复杂题质量与 OpenCode 同为全过；“内核基本可用”有实测支持。“已经完善”则不成立：简单题和复杂题的时间、额度差距都很大，复杂题前 12 分钟主要耗在调查与委派上。下一轮优化应针对真实轨迹中的首个有效改动时间、子任务交接与报告收尾成本，而不是继续增加泛化提示。两题单轮只提供定位方向，不能确定总体排名。

## 证据

- 数据题：[Kodo](../../.kodo/frontier-fourway-1793176239145/manifest.json)、[Pi](../../.kodo/frontier-fourway-1793176750979/manifest.json)、[OpenCode](../../.kodo/frontier-fourway-1793176841097/manifest.json)、[DeepSeek Harness](../../.kodo/frontier-fourway-1793176983344/manifest.json)。各目录保留中继调用、agent 日志、产物与验证日志。
- FastAPI：[首轮四格](../../.kodo/frontier-fourway-1793177045911/manifest.json)、[Kodo 复测](../../.kodo/frontier-fourway-1793178205500/manifest.json)、[DeepSeek Harness 复测](../../.kodo/frontier-fourway-1793179891430/manifest.json)。首轮 OpenCode 的 `verification-corrected.json` 与新日志为离线重验结果。
- 运行器：[run.mjs](../../scripts/comparison/frontier/run.mjs)、[launch.mjs](../../scripts/comparison/frontier/launch.mjs)、[reverify.mjs](../../scripts/comparison/frontier/reverify.mjs)。
- 权限来源：Kodo [CLI](../../src/cli/index.ts) 与 [工具宿主](../../src/tools/index.ts)、[OS 沙箱说明](../os-sandbox.md)；Pi 固定源码的 [README.md](../../.kodo/competitor-sources/pi/source/README.md)；OpenCode v1.19.3 的 [agent.ts](../../.kodo/competitor-sources/opencode/source/opencode-e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/agent/agent.ts) 与 [run.ts](../../.kodo/competitor-sources/opencode/source/opencode-e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/cli/cmd/run.ts)；DeepSeek Harness 固定包的 [cordis.patch.yml](../../.kodo/competitor-sources/dsh-metadata/base/package/cordis.patch.yml)。
