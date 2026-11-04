# 阶段 1 执行状态（2026-11-04，已完成）

阶段 1 六个批次全部完成，总结见 [阶段 1 总结](kodo-phase1-summary-20261104.md)。

依据 [定位方案](kodo-final-positioning-20261103.md) §5 与 [减法方案](kodo-subtraction-plan-20261103.md) §4。
阶段 0 基线见 [基线文档](kodo-phase0-baseline-20261103.md)。

## 批次状态

| 批次 | 内容 | 状态 | 证据 |
|---|---|---|---|
| 1a | 任务图与 lean-team 调度删除 + 两个内核修复 | **已完成并合并** | [批次 1a 记录](kodo-phase1-batch1a-20261103.md)；merge `0032837`；主仓库全量测试 2403 passed / 14 skipped / 0 failed |
| 1b | 隔离检出与集成删除（`execution-*`，约 1,050 行源码） | **已完成并合并** | [批次 1b 记录](kodo-phase1-batch1b-20261103.md)；merge `03edea1`；两次候选矩阵 24/27、21/27（基线 22/27），无新增违规 |
| 1c | 名册、路由、留存、派生、预设与角色卡删除 | **已完成并合并** | [批次 1c 记录](kodo-phase1-batch1c-20261103.md)；merge `0e50fbd`；矩阵 21/27，report-01 的掉格在 1b 代码上同时段复现（归因后不计），token/耗时匹配格中位数 0.88 / 0.96 |
| 1d | 协作工具精简（spawn/wait/inspect/cancel/ask_user 保留，fork 只追加），todo 改为纯清单 | **已完成并合并** | [批次 1d 记录](kodo-phase1-batch1d-20261104.md)；merge `1eb0e45`；对同时段 1c 对照：无新增违规，token/耗时中位数 1.00/1.09，data-03 扩样 5/12 对 8/12（p≈0.4） |
| 1e | 工具档位 / A–E 因素 / 任务协议收敛为一套；方法阶段 P1–P4 删除 | **已完成并合并** | [批次 1e 记录](kodo-phase1-batch1e-20261104.md)；merge `348a97c`；默认请求逐字节不变（护栏测试）；对 1d：20/27 对 19/27，token/耗时中位数 0.83/0.86 |
| 1f | 提示词审计 + 默认身份改为通用工作助手 | **已完成并合并** | [批次 1f 记录](kodo-phase1-batch1f-20261104.md)；merge `cf0939e`；对同时段 1e：23/27 对 20/27，token/耗时中位数 1.096/1.048 |

## 阶段 1 门槛口径（1a 之后修正）

1a 的两次同代码矩阵证明：3 次/样例的均值成本比较不可靠（同代码重跑 token 均值比 0.97–1.14 摆动；
A 相对基线的 +38% 与 B 的 −2.6% 差 0.89σ）。因此后续批次的门槛为：

1. 每批跑一次候选矩阵（9 文本样例 × 3 = 27 格）；若结果接近门槛边界（合格数下降或匹配格 token
   中位数比 > 1.10），再跑第二次复测。
2. **合格数不得低于基线**（逐样例与总体，允许相同）。
3. **无新增规则违规**（`(cell, rule)` 实例）。
4. **匹配格 token 比值中位数 ≤ 1.10**，均值同时报告并标注方差；耗时同理。
5. 单格翻转必须复测；模型服务输出会随时间漂移（1c 归因），合格数差距大时改用**同时段上一批代码**的对照矩阵（1d 起），必要时对单个样例扩样。同代码重跑也会翻转的不计为批次回归。`compare.mjs --recheck <dir>` 合并复测判定；
   必要时用上一批代码在同一时段重跑做归因（1c 的 report-01 即如此）。
8. 子运行样例 `sub-01-parallel-vendor-review`（1c 期间新增）每批一起跑：它是唯一会派生子运行的样例，
   `run-shape` 要求至少 4 个完成的子运行；基线来自 1a 之前的代码（`.kodo/golden/sub01-baseline-pre1a-20261103/`，2/3）。
6. 编码样例基线未建立（见基线文档 §4.6），门槛用 `compare.mjs --cases` 限定 9 个文本样例；
   编码样例每批至少保证 `loadCase`、旧测试与 held-out 验收脚本可运行。
7. 每批合并前：`npm run check` + 主仓库全量 `npm test` 通过。

## 当前工作区状态

- main：1f 已合并（`cf0939e`），阶段 1 完成。
- worktree：`p1a`–`p1f` 六个已合并分支的 worktree 可清理（强制删除需用户确认）；
  `.kodo/tmp/pre1a-worktree`（`e839a68`，只用于 sub-01 基线）。
- 评测证据：`baseline-20261103`、`phase1a-*`、`phase1b-*`、`phase1c-*`（含两次 report-01 复测）、`phase1b-attrib-report01-*`（1b 代码归因）、
  `sub01-baseline-pre1a-*`。
- 评测工具：`run.mjs`（含 `--rescore --rerun-commands`）、`compare.mjs`（`--cases`、`--recheck`、中位数门槛）、`score.mjs`（含 `run-shape`），
  `npm run test:golden` 61 条断言。

## 已知未决

1. 编码样例基线未建立：provider 在 6–8M token 处长轨迹稳定断流/被 relay 预算拒绝（见基线文档
   §4.6）。需要换更长超时/更稳通道或缩小样例规模后再补。
2. `docs/kodo-final-positioning-20261103.md` 阶段 2（可寻址上下文存储）尚未开始。
3. 阶段 1 各批次合并后需更新 README / 设计文档中对应的功能描述（1a 的会话不兼容策略、
   1b 的 workspace.commit/integrate 移除、1c 的名册/角色卡移除等）。
4. 模型把概括句写进中文引号（“强调引号”）是跨批次的稳定失败模式（report-01、lit-01、sub-01），与代码版本无关，
   需要在阶段 1 之后通过提示或评分规则单独处理。
5. lit-01 token 从基线约 335k 涨到 1c 约 633k，需单独查原因（见 1c 记录 §5）。
