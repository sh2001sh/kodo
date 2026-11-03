# ky-total-timeout v2-r6 评审后的零费用修正

依据 `ky-total-timeout-v2-r6-review.md`，本轮只做不调用付费模型的修正。v2-r6 证据（`.kodo/ky-total-timeout-paid-20261025-110711`）未改动；后续付费实验使用新 id `ky-total-timeout-v2-r7`。

## 1. 计量契约

- `ModelErrorMetadata.usage`：chat（`finish_reason: length` 及其他 incomplete）、Responses（`response.incomplete` / `failed`）、Anthropic（`max_tokens` 及其他停止）在失败时带上 provider 已报告的 usage。
- `failureSettlement`（`src/runtime/usage.ts`）把失败尝试分为三态：
  - measured：按实测结算，计入 `cacheReadCostPercent`；
  - known-zero：结算为 0；
  - unknown：保留预留额度，并设置 `usageEstimated`。
- `model-step.ts` 与 `compaction.ts` 共用这一结算；`model.failed` 事件记录 `usage`、`reservedTokens`、`chargedTokens`。
- 修正了 output-limit 重试的注释：这只是一次有界恢复，不能修复输出上限过小的问题。

## 2. 取消来源与评估停止规则

- `run.cancelled` 记录 `initiator`（user / agent / parent / decision / runtime / shutdown）、`by`（发起的 run）和 `callId`。
- relay 为每次调用标注 `metering`（measured / knownZero / unknown），并统计 `unmeasured` 与 `clientAborted`。
- ledger 沿 `run.cancelled` 链把未知调用归到 agent 取消的 run；被取消的调用不计入 provider failure。
- `fatalRules({ agentCancelTolerance })` 仅在以下条件全部满足时不停矩阵：
  - 未计量调用全部是客户端中止；
  - 全部属于 agent 取消的 run；
  - 数量不超过预注册容差。
  满足时成本按下限报告，不按 0 处理；其余情况仍判 `USAGE_UNRECONCILED`。默认容差为 0，即沿用旧行为。

## 3. 硬裁剪余量

- 硬裁剪逻辑移到 `src/runtime/context-hard.ts`。
- 回填目标为 `floor(输入容量 × hardTargetRatio)`，默认 0.8；设为 1 即恢复旧行为。
- 最新一轮含模型尚未看到的结果，允许用满容量。
- 放不下的旧轮次直接跳过，不会挤掉更早、更小的轮次。
- call/result 配对不被拆开。`hardTargetTokens` 写入 `context.compacted` 事件。

离线结构对比使用固定的 120 轮观测序列，窗口 65,536，输出预留 8,192，不调用模型：

| ratio | 硬裁剪次数 | 连续裁剪 | 最长连续 | 前缀变化 | 裁剪后平均保留 tokens |
|---|---|---|---|---|---|
| 1（旧） | 76 | 69 | 23 | 62 | 56,890 |
| 0.8 | 13 | 0 | 1 | 13 | 45,758 |
| 0.75 | 11 | 0 | 1 | 11 | 42,853 |

结论：0.8 消除了连续裁剪，前缀变化减少约 79%，代价是裁剪后每轮少保留约 11k tokens。0.75 只再省下 2 次裁剪，因此保持默认 0.8。这是合成序列上的结果，未用 B2 的真实请求快照验证缓存命中率。

## 4. 写范围冲突

- `spawn_agent` 拒绝与存活兄弟子代理声明的写范围重叠的请求，目录与其下文件视为重叠，错误码为 `WRITE_SCOPE_CONFLICT`。错误信息包含持有者 run id、状态和持有的范围。
- 只有比父范围更窄的写范围才算声明；未限定或继承父范围的子代理按选择共享工作区，不参与冲突判断。持有者被取消或进入终态后，其范围即释放。

## 5. 评估注册（v2-r7）

`eval.mjs`：
- id 改为 `ky-total-timeout-v2-r7`；
- 新增 `agentCancelTolerance: 2`，并更新停止规则文本；
- 每个 trial 摘要增加 `tokensLowerBound`、`unknownCalls`、`agentCancelledUnknown`、`unknownReservedTokens`、`relayUnmeasured`、`relayClientAborted`。

## 验证

- `npm run check`（tsc + eslint）通过。
- `npx vitest run`：93 个文件，1157 通过，8 跳过；新增 `metering`、`context-hard`、`write-scope` 测试。
- `node --test` 跑 v3-eval、relay、ky eval：34/34 通过。
- `npm run build` 通过；`eval.mjs --dry-run` 预检通过。

## 未完成

测试反馈环境仍被阻塞：
- `wsl.exe -e true` 60 秒超时；
- Docker Desktop 的 Linux 引擎返回 500。

A1/D1 恢复诊断需要能运行 AVA 的隔离环境，因此尚未开始。
