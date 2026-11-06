# Phase 1：执行核心提取与插件接口

日期：2026-11-06。分支：`claude/phase1-core-extraction-d0a0bf`。

## 交付内容

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/core/runtime.ts` | 115 | `RuntimeCore`：模型循环 + 工具分派 + 能力钩子 + 取消 |
| `src/core/tool-dispatch.ts` | 32 | 按工具名找插件并调用；未知工具、坏 JSON、工具异常都转成工具结果 |
| `src/core/session.ts` | 19 | 内存会话表 |
| `src/core/run.ts` | 25 | 内存运行表（返回副本，只有 `update` 能改） |
| `src/core/types.ts` | 25 | 核心类型；复用 `runtime/types.ts` 的 `Provider`/`Message`，所以 `src/providers` 的适配器可直接驱动核心 |
| `src/core/index.ts` | 7 | 导出 |
| `src/plugins/{capability,tool,integration}.ts` | 103 | 三种插件接口，带 JSDoc |
| `src/plugin-registry.ts` | 76 | 注册、按序初始化、逆序清理、初始化失败回滚 |
| `src/factory.ts` | 49 | `RuntimeConfig` + `createRuntime()` |
| `tests/core-plugins.test.ts` | — | 10 个测试 |

核心（`src/core/`）共 223 行，低于 300 行目标。

## 与设计文档的差异

- **`createRuntime` 接收插件实例，不接收布尔开关。** 文档里的 `capabilities: { history: true }` 需要 history、compaction 等插件已经存在，而它们是 Phase 2 的产出。Phase 2 把标准库做成插件后，可以在工厂里加一层布尔开关映射到这些实例。
- **`beforeModelCall` 可以返回替换后的消息列表**（只影响这一次请求，不改写 transcript）。没有这个返回值，压缩插件就无法实现。
- **`beforeCompletion` 可以返回 `{ deny }`** 让运行继续，对应现在 `run.stop` 钩子和完成校验的行为。
- **`initialize`/`cleanup` 是可选的**，`execute` 可以同步返回。
- **核心不持久化。** 会话和运行在内存表里。SQLite `Store`、恢复、预算、并发许可都属于 Layer 2/3，Phase 2 作为能力插件接入。
- **工具串行执行。** 并发批处理（`tool-batch.ts`）和写锁是策略，留给插件。

## 现有测试

现有 173 个测试文件驱动的是 `Application` → `RunCoordinator`，依赖持久化、恢复、预算、子代理等语义，新核心刻意不包含这些。所以 Phase 1 **没有**把它们改成用 `createRuntime()` 创建：那需要先把这些能力移植成插件，属于 Phase 2。旧路径保持不变，新核心与之并存，没有改动任何现有文件。

验证结果（`npm run check` 通过，`npm run build` 通过）：

- 新测试：10/10 通过。
- 全量：1951 通过、8 失败、13 跳过。8 个失败在 main checkout（`4338ebf`）同样复现，与本次改动无关：
  - `tests/tui-view.test.tsx` 7 个（文件补全/外部编辑器相关断言）。
  - `tests/windows-verification-compat.test.ts` 1 个（`EPERM` 创建 symlink，Windows 权限问题）。

## coordinator.ts 分类

**必须的循环（已进 `core/runtime.ts`）**
- `wake` → `advance`：同一 run 的并发调用共享一个执行。
- `advance` 的 while 循环：模型调用 → 有 tool_calls 就分派并继续，否则完成。
- `executeStep` 中 `runModelStep` / `runToolStep` 的最小部分：发请求、追加 assistant 消息、追加 tool 结果、累计 usage。
- `cancel`（只保留 abort + 标记）、`shutdown`。

**可选的能力（Phase 2 做成插件）**
- 持久化与崩溃恢复：`Store`、`classifyRecovery`、`prepareResume`、`resume`、`finishStop` 中的未知写入对账、`stopForStorageFault`。
- 停止收敛：`beginStop`/`interrupt`/`resumeInterrupted` 的 5 秒期限、后台进程停止。
- 预算：`startClock`/`checkpointClock`（会话时长）、`acquireModel`（并发模型许可）。
- 多代理：`Mailbox`、`drive`/`driveSession`、子运行级联取消、`childCompletionState`、`suspendPeers`。
- 完成检查：`checkCompletion`、`completionValidators`、`turnEndDelivery`、`settleBackground`、工作区写入戳。
- 宿主钩子：`HostHooks`（session.start/end、run.stop）、`withHostNotes`。
- 上下文：`inspectContext`、compaction/assembly 策略。
- 权限：`revokeSession`、`assertRunCapabilities`。

## runtime/ 52 个文件分层

**Layer 1（核心，概念已提取到 `src/core/`）**
`types.ts`（核心类型子集）、`model-step.ts`（最小调用部分）、`tool-step.ts`（最小分派部分）、`step-host.ts`（被 `RuntimeCore` 取代）、`coordinator.ts`（循环部分）、`response-repair.ts`、`schema-errors.ts`、`usage.ts`、`run-output.ts`。

**Layer 2（执行隔离）**
`execution-workspace.ts`、`workspace-git.ts`、`workspace-manifest.ts`、`scope.ts`、`paths.ts`、`run-budget.ts`。

**Layer 3（能力插件）**
- 上下文/压缩：`context.ts`、`context-assembly.ts`、`context-hard.ts`、`context-inspection.ts`、`context-progress.ts`、`context-tokens.ts`、`compaction.ts`、`compaction-trigger.ts`、`summary-install.ts`、`summary-read.ts`、`summary-schema.ts`、`tool-result-prune.ts`、`state-frame.ts`、`view-pointers.ts`、`role-view.ts`。
- 历史：`history.ts`、`rewind.ts`、`session-compat.ts`、`inspection.ts`。
- 恢复：`recovery.ts`、`recovery-resolution.ts`。
- 完成与交付：`completion.ts`、`child-completion.ts`、`deliverables.ts`、`delivery-state.ts`、`turn-end.ts`、`background-notice.ts`。
- 进度引导：`progress-advisor.ts`、`progress-guard.ts`。
- 指令与记忆：`system-prompt.ts`、`instruction-layer.ts`、`project-instructions.ts`、`memory.ts`、`attachments.ts`、`script-read.ts`。
- 宿主钩子：`hooks.ts`。
- 工具批处理策略：`tool-batch.ts`。

## Phase 2 的起点

1. 把 `src/tools/index.ts` 的工具按组包装成 `ToolPlugin`（file、shell、todo、background）。
2. 先做持久化能力插件（基于现有 `Store`），这是迁移现有测试的前提。
3. 之后依次是 history、compaction、recovery；每做完一个，把对应测试改成 `createRuntime()`。
