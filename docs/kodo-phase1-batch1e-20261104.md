# 阶段 1 批次 1e 实施与门槛结果（2026-11-04）

范围：工具档位 / A–E 因素 / 任务协议收敛为一套默认配置，删除方法阶段 P1–P4 与任务图（[1e/1f 收敛地图](kodo-phase1-batch1e-1f-map-20261103.md) §1–§4）。
分支 `phase1/batch1e`，门槛通过后合入 `main`（merge `348a97c`）。

## 1. 实施内容

| 提交 | 内容 |
|---|---|
| `879d087` | S0：默认请求护栏 `tests/default-request-invariants.test.ts`——默认会话下主运行与子运行的首个请求（消息 + 工具），归一化路径/ID/时间后逐字节快照。之后每一步都必须保持它不变 |
| `b37fa91` | S1（子 Agent 实施、主线审查）：删 `method-stage`、`method-context`、`extensions/methods`、`task-graph`、`task-declare`、`task-completion` 六个文件与 `task` 工具、`effectiveMethodRun`（34 处调用改为直接用 run）、方法卸载、状态帧方法字段、`Session.method*`、`Card.execution`、CLI `--inline-methods/--method-*` 与 `kodo methods`、web 方法端点；通用 Skill（`skill.list/load`）保留 |
| `a14c748` | S2：删 `toolProfile`/`taskProtocol`/`agentFactors`（会话字段、宿主选项、CLI 参数、host-state agent 策略）；主运行策略固定为原默认组合（compact-v2 + 协议 3 + 因子全开）的渲染结果，存为 `runtime/main-guidance.ts` 常量；默认卡只留 `builtin/general-simple` 1.4.0；删 lean-solo 视图（`tool-view`、`lean-prompt`、lean 状态帧与分页）、重复检查提示（`check-hint`、`check-command`）、compact-v1/full/lean 默认卡与知识主卡、协议 1 的等待/加锁分支与依赖因子的指令装配和 spawn 分支 |
| `58f407f` | 测试对齐（两个子 Agent 按不重叠文件分组并行、主线审查）：共享夹具改为显式传入测试专用的完整工具卡 `test/general-full`（原 `builtin/general`）；只删除测试对象整体消失的用例并逐条说明 |
| `356c6c1` | 两个 kernel 演示脚本改为在单一默认配置上运行（需要 `process.exec` 的阶段显式声明演示卡） |

兼容：会话记录带 `toolProfile`/`taskProtocol`/`agentFactors` 或任何方法字段/事件/`taskNode` → `SESSION_INCOMPATIBLE`；host-state 带 `agents` 策略或方法策略 → `CLI_HOST_STATE`；v2 卡片带 `execution` → `CARD_SCHEMA`。

净变化（`8603a4f..348a97c`）：src **43 文件，+257 / −2,093**；tests 73 文件，+2,105 / −1,927（新增的约 2,000 行主要是默认请求快照 JSON）。合并前分支：`npm run check` 通过；全量 vitest 1948 passed，剩余失败为 7 个 `tui-view` 用例（main 上同样失败）与 junction 下的 `windows-verification-compat`。

## 2. 门槛

1e 的设计目标是**默认请求逐字节不变**，护栏测试在 S1、S2、测试对齐之后都保持通过（未重新生成快照）。所以 1e 对默认会话的模型输入与 1d 完全相同，评测只用来确认没有意外。

矩阵：`.kodo/golden/phase1e-20261104/`（10 样例 × 3）。

| 对照 | 合格（9 文本样例） | 新增违规 | token 中位数比 | 耗时中位数比 |
|---|---|---|---|---|
| 1d 矩阵 | 19/27 → **20/27**，无样例下降 | 无 | 0.828 | 0.862 |
| 同时段 1c 对照 | 24/27 → 20/27（data-03 3/3→0/3，lit-02 1/3→0/3） | 无 | 0.830 | 0.925 |

data-03 仍是“结束日期写成 09-30”这一个陷阱：1d 扩样后 5/12、同时段 1c 8/12（见 1d 记录 §2.3），1e 的 0/3 落在同一分布里，而且 1e 与 1d 的请求逐字节相同，不可能是 1e 引入的差异。lit-02 在基线里就是 0/3。

**结论：批次 1e 通过。**

子运行样例 sub-01：三格都派出 5 个子运行，0/3 合格，失败全是引号转述违规（R01/R02）。本批还修正了 sub-01 检查脚本的一处误判：`## 推荐` 小节里“不予推荐……蓝桥数智”被当成推荐了不合格供应商；现在只认“推荐”后直接跟供应商名的正面推荐（反例从 11 个增加到 13 个），所有 sub-01 矩阵已用 `--rerun-commands` 重评分：基线 2/3、1c 1/3、1d 2/3、1e 0/3，不合格格子全部只剩引号违规。

## 3. 已知问题

1. **单一默认的提示词仍是旧实验的产物**：`mainGuidance` 逐字保留了原默认组合（含 todo、交接、单一集成负责人等段落），默认身份仍是编码 Agent。1f 负责改写并单独过门槛。
2. **冻结实验脚本**：`scripts/comparison/frontier/` 与 `scripts/comparison/agent-roster-v1.mjs` 仍引用已删除的选项。没有 npm 脚本运行它们，保留为历史证据，不作为可运行工具。
3. `knowledge.publish` 只由已删除的 inline 方法注册，现在 Application 不再注册它，`knowledge/tools.ts` 与工具目录里的定义是死代码，留到阶段 2 改知识工具时一起处理。
4. 普通会话里模型若调用已删除的 `task`，现在由原生工具校验拒绝，错误文本与以前不同（仍被拒绝）。
