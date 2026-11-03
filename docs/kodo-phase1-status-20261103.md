# 阶段 1 执行状态（滚动更新，2026-11-03）

依据 [定位方案](kodo-final-positioning-20261103.md) §5 与 [减法方案](kodo-subtraction-plan-20261103.md) §4。
阶段 0 基线见 [基线文档](kodo-phase0-baseline-20261103.md)。

## 批次状态

| 批次 | 内容 | 状态 | 证据 |
|---|---|---|---|
| 1a | 任务图与 lean-team 调度删除 + 两个内核修复 | **已完成并合并** | [批次 1a 记录](kodo-phase1-batch1a-20261103.md)；merge `0032837`；主仓库全量测试 2403 passed / 14 skipped / 0 failed |
| 1b | 隔离检出与集成删除（`execution-*`，约 1,050 行源码） | **实施中**（worktree `phase1/batch1b`） | [1b 删除地图](kodo-phase1-batch1b-map-20261103.md) |
| 1c | 名册、路由、留存、派生、预设与角色卡删除（约 1,159 行） | 待开始 | — |
| 1d | 协作工具精简（spawn/wait/inspect/cancel/ask_user 保留），todo 去依赖与派发 | 待开始 | — |
| 1e | 工具档位 / A–E 因素 / 任务协议收敛为一套；P1–P4 并入上下文存储加载策略 | 待开始 | — |
| 1f | 提示词审计 + 默认身份改为通用工作助手 | 待开始 | — |

## 阶段 1 门槛口径（1a 之后修正）

1a 的两次同代码矩阵证明：3 次/样例的均值成本比较不可靠（同代码重跑 token 均值比 0.97–1.14 摆动；
A 相对基线的 +38% 与 B 的 −2.6% 差 0.89σ）。因此后续批次的门槛为：

1. 每批跑一次候选矩阵（9 文本样例 × 3 = 27 格）；若结果接近门槛边界（合格数下降或匹配格 token
   中位数比 > 1.10），再跑第二次复测。
2. **合格数不得低于基线**（逐样例与总体，允许相同）。
3. **无新增规则违规**（`(cell, rule)` 实例）。
4. **匹配格 token 比值中位数 ≤ 1.10**，均值同时报告并标注方差；耗时同理。
5. 单格翻转必须复测；同代码重跑也会翻转的不计为批次回归。
6. 编码样例基线未建立（见基线文档 §4.6），门槛用 `compare.mjs --cases` 限定 9 个文本样例；
   编码样例每批至少保证 `loadCase`、旧测试与 held-out 验收脚本可运行。
7. 每批合并前：`npm run check` + 主仓库全量 `npm test` 通过。

## 当前工作区状态

- main：`09b57e7`（阶段 0 + 1a 全部文档与评测修复已提交），工作区干净。
- worktree：`.kodo/tmp/p1a-worktree`（branch `phase1/batch1a`，已合并，可清理）、
  `.kodo/tmp/p1b-worktree`（branch `phase1/batch1b`，1b 实施中）。
- 基线证据：`.kodo/golden/baseline-20261103/`（30 格，人工项已补齐）、
  `.kodo/golden/phase1a-20261103/` 与 `-b/`（两次 1a 候选矩阵）。
- 评测工具：`scripts/golden/run.mjs`（runner）、`compare.mjs`（门槛，支持 `--cases`）、
  `score.mjs`（评分引擎），`npm run test:golden` 53 条断言。

## 已知未决

1. 编码样例基线未建立：provider 在 6–8M token 处长轨迹稳定断流/被 relay 预算拒绝（见基线文档
   §4.6）。需要换更长超时/更稳通道或缩小样例规模后再补。
2. `docs/kodo-final-positioning-20261103.md` 阶段 2（可寻址上下文存储）尚未开始。
3. 阶段 1 各批次合并后需更新 README / 设计文档中对应的功能描述（1a 的会话不兼容策略、
   1b 的 workspace.commit/integrate 移除等）。
