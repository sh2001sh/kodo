# FrontierHarness 四方对比复测（第二轮）

日期：2026-10-28。沿用[首轮实验](frontier-fourway-20261028.md)的两道任务、四个 harness 和 `deepseek-v4.1-flash`；以下是第二次独立采样，不与官方 Kimi K3 榜单混比。

## 口径

- 基准固定在 `frontier-harness-eval/eval` 提交 `e837a70bd6beb4e72eeeda62dd06e3bd34f6cb63`。数据合并限时 900 秒；FastAPI 弃用响应头任务原限时 5400 秒，本实验统一截为 1800 秒。
- 四方经同一 `codego1` 网关请求同一模型，上下文 65536、单次输出上限 8192。两轮 `launch.mjs` 的 SHA-256 均为 `de3549f86a626a803413b70b9ee4c1228df8c54b466fb05c24eafb6f143c6234`。
- 每格在独立一次性 Docker 容器运行；任务容器只连内部网络与模型中继，外部验证器断网。Agent 秒为容器启动到退出，不含外部验证；`credit` 为网关返回的额度单位，不是美元。FastAPI 第二轮逆序运行 DeepSeek Harness、OpenCode、Pi、Kodo。不同 harness 的内建提示和工具仍是比较对象。

## 第二轮结果

| 任务 | Harness | Agent 秒 | 请求 | 输入 token / 缓存命中 | 输出 token | credit | 外部验证 |
|---|---|---:|---:|---:|---:|---:|---|
| 数据合并 | Kodo | 351.5 | 50 | 1,018,058 / 858,752 | 28,553 | 4.17 | 3/3 通过 |
| 数据合并 | Pi | 44.2 | 6 | 22,186 / 18,944 | 3,745 | 0.27 | 3/3 通过 |
| 数据合并 | OpenCode | 59.8 | 7 | 61,620 / 53,632 | 4,831 | 0.40 | 3/3 通过 |
| 数据合并 | DeepSeek Harness | 51.5 | 7 | 49,522 / 45,824 | 4,859 | 0.34 | 3/3 通过 |
| FastAPI | Kodo | 1806.5（超时） | 183 | 5,538,854 / 4,823,552 | 166,062 | 至少 21.05 | 新增 127/137，原有 3134/3134；reward 0 |
| FastAPI | Pi | 773.8 | 93 | 2,936,415 / 2,808,448 | 51,479 | 5.58 | 新增 136/137，原有 3134/3134；reward 0 |
| FastAPI | OpenCode | 116.0 | 11 | 202,398 / 172,416 | 9,240 | 1.00 | 无补丁；新增 0/137，原有 3134/3134；reward 0 |
| FastAPI | DeepSeek Harness | 283.5 | 44 | 1,487,663 / 1,450,496 | 23,490 | 2.26 | 补丁未通过测试收集；新增 0/137，原有 3134/3134；reward 0 |

数据合并四格均通过官方的产物、内容与冲突报告断言。FastAPI 的 Kodo 在 1800 秒限制后被停止，容器退出计时含约 6.5 秒停止宽限；留下的补丁有 10 项新增测试失败，均涉及 `include_router` 覆盖或 OpenAPI 优先级。Pi 补丁仅在嵌套 `include_router` 覆盖优先级上失败一项。两者虽有部分通过，官方二值 reward 都是 0。OpenCode 退出时没有补丁，最后一次响应耗尽 8192 输出额度。DeepSeek Harness 的补丁缺少 `fastapi.middleware.deprecation` 模块，新增测试收集失败；运行本身以非零状态结束。

Kodo FastAPI 的 183 次请求中有 1 次缺少 usage；该格的 token 数与 21.05 credit 都只累计了已返回 usage 的请求，实际总额无法据此精确确认。其余七格无 usage 缺口。本轮八格可见额度合计 **35.07 credit**，也应视为下界。

## 两轮对照

| 任务 | Harness | 首轮：秒 / credit / 质量 | 第二轮：秒 / credit / 质量 |
|---|---|---|---|
| 数据合并 | Kodo | 468.7 / 11.41 / 3/3 | 351.5 / 4.17 / 3/3 |
| 数据合并 | Pi | 78.9 / 0.94 / 3/3 | 44.2 / 0.27 / 3/3 |
| 数据合并 | OpenCode | 126.6 / 1.46 / 3/3 | 59.8 / 0.40 / 3/3 |
| 数据合并 | DeepSeek Harness | 48.8 / 0.71 / 3/3 | 51.5 / 0.34 / 3/3 |
| FastAPI | Kodo | 1490.8 / 36.39 / 137/137 | 1806.5 / 至少 21.05 / 超时，127/137 |
| FastAPI | Pi | 79.8 / 1.62 / 无补丁 | 773.8 / 5.58 / 136/137 |
| FastAPI | OpenCode | 701.4 / 8.07 / 137/137 | 116.0 / 1.00 / 无补丁 |
| FastAPI | DeepSeek Harness | 168.8 / 3.32 / 无补丁 | 283.5 / 2.26 / 0/137 |

数据题重复通过支持四方均能完成这一类明确产物任务；Kodo 在两轮中均最慢、额度最高。FastAPI 首轮 Kodo 和 OpenCode 全过，第二轮四方均未全过，且 Kodo 超时；Pi 从无补丁变为仅差一项，OpenCode 从全过变为无补丁。这是明显的单次运行波动，不能由两轮采样估计稳定成功率，也不能据此给出总体排名。1800 秒截断不等于官方完整时限成绩。Kodo 的真实任务能力已有通过样本，但复杂任务的稳定性、时间与额度效率尚未达到“完善”。

## 权限与隔离

本轮使用相同启动配置：Kodo 显式 `--allow-write --allow-exec`、未启用内层 OS 沙箱；Pi 使用原生工具并关闭扩展、MCP 与项目提示发现；OpenCode 设置 `permission: "allow"`；DeepSeek Harness 使用 `danger-full-access`。这使非交互任务可写，但**不是四方的默认审批策略**。默认机制与产品隔离边界见[首轮的逐项审阅](frontier-fourway-20261028.md#权限与隔离)。本轮只检查配置和正常任务轨迹，没有进行隔离突破测试。真实网关凭据仅存在父级中继容器，任务容器使用占位密钥。

## 证据

- [数据合并清单](../../.kodo/frontier-fourway-1793191327065/manifest.json)：逐格 agent 日志、中继 usage、产物和验证日志位于同目录。
- [FastAPI 清单](../../.kodo/frontier-fourway-1793191869581/manifest.json)：逐格补丁、验证器 `reward.json` 和原始日志位于同目录。
- [运行器](../../scripts/comparison/frontier/run.mjs)与[启动适配](../../scripts/comparison/frontier/launch.mjs)。
