# 阶段 1 批次 1a 删除地图：任务图与 lean-team 调度

日期：2026-11-03。状态：只读分析结论，未改动任何源码或测试。分析基线为提交 `197fdaf`（`chore(eval): add golden eval contract and coding regression case`，在 `2f95839` 基线之上只新增 `docs/kodo-golden-eval-design-20261103.md` 与 `eval/golden/`，**`src/`、`tests/` 与 `2f95839` 完全一致**，本文件中的 `文件:行` 均按当前工作区核对）。工作区另有一处非本任务产生的未提交修改（`docs/kodo-golden-eval-design-20261103.md` 增加 §3.1 `grading` 16 行），与本批次无关。

依据：[最终产品定位](kodo-final-positioning-20261103.md) §5 阶段 1、[减法方案](kodo-subtraction-plan-20261103.md) §4/§5/§6、[黄金评测设计](kodo-golden-eval-design-20261103.md) 阶段 0 与 §8 验收。

---

## 0. 结论摘要（先看这五条）

1. **范围核验通过，但 1,854 行无法在批次 1a 内全部删完。** 15 个目标文件实测恰为 1,854 行（见 §1.1），但其中 **443 行**——`runtime/task-graph.ts`(165)、`runtime/task-declare.ts`(170)、`runtime/task-completion.ts`(108)——仍是**保留功能 `inlineMethods`（卡片方法阶段 P1–P4）**的存储与完成判定底座：[method-stage.ts:10-12](src/runtime/method-stage.ts#L10-L12)、[state-frame.ts:113](src/runtime/state-frame.ts#L113)、[completion.ts:81](src/runtime/completion.ts#L81)、[coordinator.ts:29](src/runtime/coordinator.ts#L29) 与 [coordinator.ts:500-502](src/runtime/coordinator.ts#L500-L502)。方法阶段按方案在 1e 才退出，因此 **1a 实际净删 ≈1,411 行**，余下 443 行必须随 1e（或阶段 2 编译器）一起删。若产品决定 1a 必须删满 1,854 行，只能把 `inlineMethods` 的删除提前并入 1a（见 §5 备选），风险更高。这是本批次最大的陷阱。
2. **黄金评测的直接翻转风险很低。** 黄金评测默认配置是 `compact-v2`（[黄金评测设计:10](docs/kodo-golden-eval-design-20261103.md#L10)、`Application` 默认构造见同文 [135](docs/kodo-golden-eval-design-20261103.md#L135)），而任务图工具 `delegate`/`task`/`find_agents` 只在 `lean-team` 主运行出现（[messaging/index.ts:104](src/messaging/index.ts#L104)）或在 `inlineMethods` 时以方法阶段 `task` 出现（[messaging/index.ts:119](src/messaging/index.ts#L119)），默认配置两者都没开。1a 删除的是默认配置**不可达**的代码，风险主要来自共享文件改造时的行为漂移与旧会话恢复，而不是能力变化。
3. **但“删后重跑黄金评测”的验收目前不可执行。** [黄金评测设计](docs/kodo-golden-eval-design-20261103.md) §2 要求的 `scripts/golden/run.mjs`、`score.mjs`、`metrics.mjs` 在当前基线**不存在**（`scripts/golden/` 不存在），`.kodo/golden/<stamp>/` 基线产物也不存在；10 个样例目录（`eval/golden/cases/*`）已就绪但只有契约与样例。阶段 0 门槛（基线数据完整、评分标准人工复核）未达成，1a 无法按 §5 门槛做“删前删后对比”。**这不是 1a 的代码风险，但会阻塞 1a 的验收结论**，需要 lead 决策：先补评测入口，或接受“以全量测试 + 请求字节不变量”作为 1a 的替代验收。
4. **两个内核问题都已定位到行，且与 1a 相互独立，可单独提交。** 写范围冲突在保留的 `spawn_agent` 路径上，是“strict 模式下省略 `scope` 被当成整工作区声明 + 同一次模型响应内先创建第一个子运行、后一个才被拒”造成的交接往返（证据见 §6.1）；502 三次即失败在 [model-step.ts:292-340](src/runtime/model-step.ts#L292-L340)。
5. **旧会话处置需要显式闸门，不能静默降级。** 任务图不新增任何 SQLite 表，数据只落在既有表的 JSON 列与 `events.type` 字符串里（§4.1）；删除后旧 `lean-team` 会话若被恢复会**悄然退化**到 legacy 视图（`roleAllows` 的 `toolProfile` 分支不再匹配），因此必须在 `Application` 的执行入口加 `SESSION_INCOMPATIBLE` 显式报错（§4.2），且**不能**放在 `Store.session()`，否则会把 `GET /api/sessions`（[web/server.ts:183](src/web/server.ts#L183)）一起打死。

---

## 1. 文件清单：删除 / 保留 / 改造

### 1.1 批次 1a 目标文件（15 个，实测合计 1,854 行）

行数用 `(Get-Content).Count` 实测（与减法方案 §4 的 1,854 完全吻合）。

| # | 文件 | 行数 | 当前职责 | 引用它的源码（精确行） | 结论 |
|---|---|---:|---|---|---|
| 1 | `src/runtime/task-graph.ts` | 165 | `TaskNode`/`TaskGraph` 类型、状态机、事件溯源读写、依赖判定、图指纹 | `task-declare.ts:7-8`、`task-dispatch.ts:3-4`、`task-dispatch-record.ts:2-3`、`task-execution-host.ts:8-9`、`task-lifecycle.ts:4-5`、`task-recovery.ts:3-4`、`task-runtime.ts:6-7`、`task-workspace.ts:4-5`、`task-completion.ts:2-3`、`task-checks.ts:5-6`、`state-frame.ts:11`、`method-stage.ts:12`、`messaging/index.ts:39`、`messaging/task-spawn.ts:7-8` | **保留（改造为方法阶段最小子集）** |
| 2 | `src/runtime/task-declare.ts` | 170 | `delegate` 声明校验（角色/scope/check/路径诊断/环/节点上限）、`declareTasks`、`builtinTaskRoles`、`defaultMaxTaskNodes` | `task-lifecycle.ts:6`、`task-runtime.ts:4-5`、`method-stage.ts:10-11`、`messaging/delegate.ts:2` | **保留（仅 `declareTasks` 子集给方法阶段）** |
| 3 | `src/runtime/task-completion.ts` | 108 | `classifyTaskGraph`（complete/wait/feedback 分类）、终态指纹复查、dropped 披露 | `completion.ts:8`、`coordinator.ts:29`、`messaging/index.ts:40` | **保留（方法阶段完成判定）** |
| 4 | `src/runtime/task-runtime.ts` | 295 | 调度总控：`delegate`/`task` 操作、tick/advance、快照捕获、集成、通知、清理 | `coordinator.ts:28` | 删除 |
| 5 | `src/runtime/task-dispatch.ts` | 214 | 两段式派发（准备/提交/放弃）、配额、调度、checkout 释放/清理 | `task-runtime.ts:8` | 删除 |
| 6 | `src/runtime/task-dispatch-record.ts` | 46 | `task.dispatch.prepared/committed/abandoned` 事件记录与恢复 | `task-dispatch.ts:5-6` | 删除 |
| 7 | `src/runtime/task-execution-host.ts` | 111 | `TaskDispatchHost` 实现：快照、配额、`spawnTaskHost`、`nodeHasDelivery` | `task-runtime.ts:10-11` | 删除 |
| 8 | `src/runtime/task-lifecycle.ts` | 204 | 节点操作：done/drop/accept/resume/recheck/redo、代次失效、运行结果归档、集成收尾 | `task-runtime.ts:9`、`messaging/task-tool.ts:4-5` | 删除 |
| 9 | `src/runtime/task-checks.ts` | 122 | 宿主定向检查（`host.task.check`）执行、证据与中断恢复 | `task-runtime.ts:21` | 删除 |
| 10 | `src/runtime/task-recovery.ts` | 100 | 审计恢复时迁移任务图事件、重映射 run ID、恢复中断子运行 | `application/index.ts:34,611` | 删除 |
| 11 | `src/runtime/task-workspace.ts` | 47 | snapshot/shared 工作区模式冻结、共享写者 scope 串行化判定 | `task-runtime.ts:16`、`task-execution-host.ts:15`、`messaging/task-spawn.ts:6`、`task-lifecycle.ts:8` | 删除 |
| 12 | `src/runtime/task-notice.ts` | 48 | 任务完成通知 50 KiB 预算与 head/tail 截断 | `task-runtime.ts:17` | 删除 |
| 13 | `src/messaging/task-spawn.ts` | 85 | 图节点 → 子运行准入：角色卡片、权限/scope、checkout、任务包 | `task-runtime.ts:3`、`messaging/index.ts:37-38` | 删除 |
| 14 | `src/messaging/task-tool.ts` | 103 | 模型可调用的 `task` 图操作（done/drop/inspect/accept/resume/recheck/redo…） | `task-runtime.ts:2` | 删除 |
| 15 | `src/messaging/delegate.ts` | 36 | `delegate`/`task`/`find_agents` 三个工具 schema | `messaging/index.ts:36,48,104` | 删除 |

**净删账**：删除 = 1,854 − 443 = **1,411 行源码**。另删测试 16 个文件 **2,366 行**（§3.1）。

### 1.2 需要改造的保留文件（删代码不改这些就编译不过或行为漂移）

行数为实测；行号为改造点，不是全部改动。

| 文件 | 行数 | 改造点 | 目的 |
|---|---:|---|---|
| `src/runtime/coordinator.ts` | 603 | 删除 `TaskRuntime` 字段/构造/`stop`/`settle`/`cleanup`/`tickForModel`/`retryDelay`/`busy`/`shutdown`/`revokeSession` 接线：[42](src/runtime/coordinator.ts#L42)、[76](src/runtime/coordinator.ts#L76)、[79](src/runtime/coordinator.ts#L79)、[153](src/runtime/coordinator.ts#L153)、[166](src/runtime/coordinator.ts#L166)、[257](src/runtime/coordinator.ts#L257)、[279](src/runtime/coordinator.ts#L279)、[284](src/runtime/coordinator.ts#L284)、[287](src/runtime/coordinator.ts#L287)、[304](src/runtime/coordinator.ts#L304)、[317](src/runtime/coordinator.ts#L317)、[323](src/runtime/coordinator.ts#L323)、[326](src/runtime/coordinator.ts#L326)、[333](src/runtime/coordinator.ts#L333)、[473](src/runtime/coordinator.ts#L473)。**保留** [29](src/runtime/coordinator.ts#L29) 与 [500-502](src/runtime/coordinator.ts#L500-L502) 给 inlineMethods | 断开调度器 |
| `src/runtime/completion.ts` | 178 | 删除 lean-team 条件（[81-82](src/runtime/completion.ts#L81-L82) 改为仅 `inlineMethods`）；删除 `host.tasks` 等待分支 [94-108](src/runtime/completion.ts#L94-L108)（方法阶段的 `self` 节点只会产出 `feedback`/`complete`，见 task-completion.ts:48-51，永远不会是 `wait`，故安全）；`taskGraphStamp` 字段相关 [82,89-90,163-165,171](src/runtime/completion.ts#L82) 删除 | 保留方法阶段完成判定 |
| `src/runtime/state-frame.ts` | 139 | 删除 lean-team 任务节点块 [61](src/runtime/state-frame.ts#L61)、[67](src/runtime/state-frame.ts#L67)、[73](src/runtime/state-frame.ts#L73)；**保留** [113](src/runtime/state-frame.ts#L113)（方法阶段 stages，依赖 task-graph） | 状态帧 |
| `src/runtime/child-completion.ts` | 54 | 删除 lean-team 过滤 [13-15](src/runtime/child-completion.ts#L13-L15)（`team` 常量与 taskNode 条件） | 子运行生命周期 |
| `src/messaging/index.ts` | 651 | 删 [36-38](src/messaging/index.ts#L36-L38) 导入；[47-48](src/messaging/index.ts#L47-L48) 三个 schema 定义改为仅保留方法阶段 `methodTaskSpec`（来自 `method-stage.ts`，[messaging/index.ts:2](src/messaging/index.ts#L2)）；删 lean-team 专用 specs [104](src/messaging/index.ts#L104)；删 `taskOperation` 选项 [84,87,92](src/messaging/index.ts#L84)、execute 分支 [182-186](src/messaging/index.ts#L182-L186)；删 `spawnTaskHost` [299-312](src/messaging/index.ts#L299-L312)、`waitForTasks` [515-527](src/messaging/index.ts#L515-L527)、`refresh` 的 `taskNodeIds` 分支 [554,563,565](src/messaging/index.ts#L554)、`detectDeadlocks` 过滤 [586](src/messaging/index.ts#L586)、终态通知条件 [627](src/messaging/index.ts#L627)；`prepareSpawn` 的 host 覆盖参数 [371](src/messaging/index.ts#L371)、[444-447](src/messaging/index.ts#L444-L447)（第 3、4 步） | 工具面与邮箱 |
| `src/runtime/tool-view.ts` | 175 | `LeanProfile`/`leanProfiles` 去掉 `lean-team` [6-8](src/runtime/tool-view.ts#L6-L8)；`passThrough` 去掉 `delegate/task/find_agents` [41](src/runtime/tool-view.ts#L41)；删子运行角色视图 `leanChildRole`/`childViews`/role 参数 [42-61](src/runtime/tool-view.ts#L42-L61)、[144-148](src/runtime/tool-view.ts#L144-L148)、[170-175](src/runtime/tool-view.ts#L170-L175)（`lean-solo` 的子运行本就不使用 lean 视图，[role-view.ts:11](src/runtime/role-view.ts#L11)） | 工具视图 |
| `src/runtime/role-view.ts` | 37 | `roleAllows` 去掉 lean-team 例外 [5,7-15](src/runtime/role-view.ts#L5)；`Pick<Run,'taskNode'>` 去掉 | 视图白名单 |
| `src/runtime/types.ts` | 256 | `Session.toolProfile` 去掉 `'lean-team'` [114](src/runtime/types.ts#L114)；删 `Session.maxTaskNodes` [115-116](src/runtime/types.ts#L115-L116)；删 `Run.taskNode` [125-126](src/runtime/types.ts#L125-L126)；删 `Wait.taskNodeIds` [204-205](src/runtime/types.ts#L204-L205)；删 `StepOutcome.taskGraphStamp` [215](src/runtime/types.ts#L215)。`taskProtocol` [111-112](src/runtime/types.ts#L111-L112) **保留**（todo 协议，1d/1e 处理） | 类型收敛 |
| `src/runtime/step-host.ts` | 69 | lean 判定 [53](src/runtime/step-host.ts#L53) 由 `(!parentId || profile==='lean-team')` 改为 `!run.parentId` | 工具面 |
| `src/runtime/model-step.ts` | 414 | lean 判定 [100](src/runtime/model-step.ts#L100) 同上 | 请求构建 |
| `src/runtime/tool-step.ts` | 387 | lean 判定 [373](src/runtime/tool-step.ts#L373) 同上 | 结果视图 |
| `src/runtime/context.ts` | 401 | lean 判定 [392](src/runtime/context.ts#L392) 同上（`lean-team` 子运行初始上下文） | 上下文 |
| `src/tools/index.ts` | 1260 | lean-team 子视图判定 [439](src/tools/index.ts#L439)、[760-761](src/tools/index.ts#L760-L761) 改为仅主运行 | 工具校验 |
| `src/runtime/view-pointers.ts` | 50 | `leanProfile` 去掉 `lean-team` [17](src/runtime/view-pointers.ts#L17) | 指针渲染 |
| `src/runtime/execution-workspace.ts` | 166 | 删除 `retiredTaskTurn` 的 taskNode 判定 [21-34](src/runtime/execution-workspace.ts#L21-L34)（该函数服务任务 resume；1b 会删整个文件，但 `Run.taskNode` 删字段后此处必须先改） | 跨批 |
| `src/messaging/agent-lifecycle.ts` | 73 | `taskRevision` 分支 [53-54](src/messaging/agent-lifecycle.ts#L53-L54) 删除（`reviseTaskWriteScope` 只由图节点路径传入） | 跨批 |
| `src/messaging/spawn-spec.ts` | 163 | `childIsActive` 的 `taskNode` 例外 [102-111](src/messaging/spawn-spec.ts#L102-L111) 删除；保留 `assertNoWriteConflict` [147-163](src/messaging/spawn-spec.ts#L147-L163)（内核问题 1 的落点） | spawn 保留路径 |
| `src/application/index.ts` | 824 | 删 `carryRecoveryTaskGraphs` 导入/调用 [34,611](src/application/index.ts#L34)；删 `ApplicationOptions.maxTaskNodes`/字段/校验 [71,124,175-176](src/application/index.ts#L71)；lean-team 分支 [148,157,162,502,506,511-512](src/application/index.ts#L148)；恢复重映射 [595-598](src/application/index.ts#L595-L598)；新增兼容闸门（§4.2） | 入口/恢复 |
| `src/agents/card.ts` | 216 | 删 `leanBuiltinAgentCards` [206-216](src/agents/card.ts#L206-L216)；`leanDefaultCard` [199-204](src/agents/card.ts#L199-L204) **保留**（lean-solo 用） | 内置卡 |
| `src/cli/index.ts` | 492 | help 去掉 `lean-team` [59](src/cli/index.ts#L59)；校验 [127](src/cli/index.ts#L127)。无 `--max-task-nodes` 参数（见 §4.3），`--task-protocol` 保留 | CLI |
| `src/storage/index.ts` | 503 | **不需要**迁移/改表；仅在 §4.2 闸门的调用侧配合（不改 `Store.session`） | 存储 |
| `src/runtime/method-stage.ts` | 165 | 按 1a 方案**不改**；其依赖的 3 个 task 文件保留到 1e（§0-1） | 方法阶段 |

> `src/web/*` 与 `src/tui/*` 没有任务图/lean-team 的直接引用（`src/tui` 全目录 grep 无 `taskNode`/`lean-team`/`task.` 命中；web 的 `collaboration.ts` 只按 `parentId` 列子运行：[web/collaboration.ts:96-100](src/web/collaboration.ts#L96-L100)，等待依赖只读 `questionIds/runIds`：[web/collaboration.ts:176-180](src/web/collaboration.ts#L176-L180)）。因此 web/TUI **不需要源码改动**，只需 §4.2 的旧会话闸门保护。

---

## 2. 导出与类型依赖图

### 2.1 删除后会断的 import / export

按“谁断”分组；**同一提交内必须一起改**。

| 断点（被删文件） | 断掉的引用 |
|---|---|
| `task-runtime.ts` | `coordinator.ts:28` |
| `task-recovery.ts` | `application/index.ts:34,611` |
| `task-completion.ts`（若删） | `completion.ts:8`、`coordinator.ts:29`、`messaging/index.ts:40` → **决策为保留，故不断** |
| `task-graph.ts`（若删） | `state-frame.ts:11`、`method-stage.ts:12`、`messaging/index.ts:39` → **决策为保留，故不断** |
| `messaging/delegate.ts` | `messaging/index.ts:36,48,104` |
| `messaging/task-spawn.ts` | `task-runtime.ts:3`（随 task-runtime 一起删）、`messaging/index.ts:37-38`（`spawnTaskHost` 随 §1.2 删除） |
| `messaging/task-tool.ts` | `task-runtime.ts:2`（一起删） |
| 其余 7 个任务文件 | 只被上述被删文件互相引用（§1.1 表） |

测试侧断点全部集中在 §3.1 的 16 个待删文件与 §3.2 的局部改文件；`tests/method-stages.test.ts` 保持不动（这正是保留 task-graph/task-declare/task-completion 的直接理由）。

### 2.2 删除后必须保留的最小接口

- **`RuntimeEvent` 无需改动**：[types.ts:211-214](src/runtime/types.ts#L211-L214) 是 `{seq,sessionId,runId,type,time,version,data}` 的通用信封，`events` 表的 `type` 是 TEXT；删除任务事件类型不需要表结构或类型改动。事件计数器（`src/storage/events.ts`/`counterSchema`）按 `type` 计数，旧任务事件只是继续留在计数里，新代码不查询。[storage/index.ts:85-131](src/storage/index.ts#L85-L131) 无任务表，`gc` 的表清单 [404-407](src/storage/index.ts#L404-L407) 也不含任务表。
- **store 表**：**没有**任何任务专用表（见 §4.1）。
- **保留类型**：`TaskNode`/`TaskGraph`/`TaskNodeState` 等继续由 `task-graph.ts` 导出，只服务 `method-stage.ts` 与 `state-frame.ts:113`；不得再被 `Run`/`Session`/`Wait`/`StepOutcome` 引用。
- **`Run` 的最小形状**：删除 `taskNode` 后，`Run` 仍有 `parentId/continuationOf/historyFrom/execution` 等，spawn/wait/inspect/cancel 全部不依赖任务图。[types.ts:118-167](src/runtime/types.ts#L118-L167)。
- **`Wait` 的最小形状**：保留 `questionIds/runIds/mode/deadline/status/eventDriven`；删除 `taskNodeIds` 后，`mailbox.refresh` 只走 question/run 条件（§1.2 messaging/index 改造），web 的等待投影无需改动。[types.ts:202-210](src/runtime/types.ts#L202-L210)。
- **`Session` 的最小形状**：保留 `toolProfile`（值域收敛为 `compact-v1|compact-v2|full|lean-solo`）、`taskProtocol`、`budget`；`taskProtocol===3` 的 todo 动态协议分支**不得**在 1a 改动（[tools/index.ts:340-343](src/tools/index.ts#L340-L343)、[messaging/index.ts:540](src/messaging/index.ts#L540)、[progress-guard.ts:54](src/runtime/progress-guard.ts#L54)、[todo-dependencies.ts:57,87](src/runtime/todo-dependencies.ts#L57)）。

### 2.3 业务事件清单（删除后不再产生，但旧数据里会存在）

| 事件类型 | 生产者（当前） | 删除后处置 |
|---|---|---|
| `task.node.updated` | [task-graph.ts:57,101-107](src/runtime/task-graph.ts#L57) | 不再产生；旧数据保留只读 |
| `task.dispatch.prepared/committed/abandoned` | [task-dispatch-record.ts:14-16](src/runtime/task-dispatch-record.ts#L14-L16) | 同上 |
| `task.check.started/settled`、`host.task.check` 调用 | [task-checks.ts:61,93](src/runtime/task-checks.ts#L61) | 同上 |
| `task.workspace_mode` | [task-workspace.ts:11](src/runtime/task-workspace.ts#L11) | 同上 |
| `task.delivery`、`task.release.requested/finished` | [task-runtime.ts:115,199,202,257](src/runtime/task-runtime.ts#L115) | 同上 |
| `todo.dispatched`（图派发也写） | [task-dispatch.ts:105](src/runtime/task-dispatch.ts#L105) | 任务图不再写；todo 自身仍写（[tools/todo.ts:89](src/tools/todo.ts#L89)），1d 处理 todo 时再收敛 |
| `recovery.task_graph_carried`、`recovery.task_children_remapped` | [task-recovery.ts:77,87](src/runtime/task-recovery.ts#L77) | 不再产生 |
| `completion.task_disclosure` | [completion.ts:138](src/runtime/completion.ts#L138) | 不再产生（方法阶段仍用 droppedHint？不：图分类保留但无任务图节点；方法阶段 dropped 提示仍在 completion.ts 保留路径） |
| `agent.spawned{origin:'task_graph'}` | [messaging/index.ts:310](src/messaging/index.ts#L310) | 不再产生；spawn 的 `origin:'host'`/普通路径保留 |

---

## 3. 关联测试清单

### 3.1 整体删除（16 个文件，2,366 行）

| 测试文件 | 行数 | 覆盖对象 | 备注 |
|---|---:|---|---|
| `tests/lean-team-completion.test.ts` | 151 | 图完成判定/终态复查/披露 | 1a 删除范围 |
| `tests/lean-team-mailbox.test.ts` | 138 | 图工具注册、图等待、`spawnTaskHost`、无报告卡拒绝 | 其中“图等待/工具面”属 1a；“无报告卡”能力随图删除一起消失 |
| `tests/lean-team-recovery.test.ts` | 205 | 审计恢复迁移任务图 | 1a |
| `tests/lean-team-runtime.test.ts` | 200 | 真实 coordinator 的并行/集成/resume/redo/冲突/中断 | 1a |
| `tests/lean-team-scheduling.test.ts` | 208 | 派发两段式、锁竞争、checkout 并发、通知预算、`maxTaskNodes` | 1a |
| `tests/lean-team-shared.test.ts` | 121 | shared 工作区模式、scope 串行、主写入被拒 | 1a；**其中写范围语义需用新测试在 spawn 路径补回**（§3.4、§6.1） |
| `tests/lean-team-view.test.ts` | 119 | lean-team 9 工具视图、角色视图、maxTaskNodes 校验 | 1a；lean-solo 视图断言在 `lean-solo.test.ts` 已覆盖 |
| `tests/task-checks.test.ts` | 260 | 宿主定向检查全链路 | 1a |
| `tests/task-declare-paths.test.ts` | 71 | 声明路径诊断 | 1a |
| `tests/task-dispatch.test.ts` | 203 | 派发/恢复/checkout 保留 | 1a |
| `tests/task-graph.test.ts` | 219 | 声明/状态机/代次/完成判定 | 1a |
| `tests/task-notice.test.ts` | 39 | 通知预算 | 1a |
| `tests/task-recheck.test.ts` | 156 | 宿主检查重验 | 1a |
| `tests/task-resume-revision.test.ts` | 131 | scope/check 修订与续接 | 1a |
| `tests/task-fixture.ts` | 59 | 上述测试的内存 store/host 夹具 | 随 1a 测试删除 |
| `tests/isolated-execution.test.ts` | 86 | Linux 隔离执行并发（依赖 `declareTasks`/`taskCheckCommand`/`f.tasks.tick`） | 功能属 1b，但它 import 任务图（第 5-7 行），删除任务文件后无法保留；1b 删除隔离执行时本来也会失去该覆盖 |

### 3.2 只删部分 case / 必须改写法

| 测试 | 精确位置 | 改动 |
|---|---|---|
| `tests/lean-solo.test.ts` | [107-108](tests/lean-solo.test.ts#L107-L108) | `it.each(['lean-solo','lean-team'])` → 只保留 `lean-solo` |
| `tests/view-pointers.test.ts` | [18](tests/view-pointers.test.ts#L18)、[28](tests/view-pointers.test.ts#L28)、[39](tests/view-pointers.test.ts#L39) | 去掉 `lean-team` 断言；期望列表由 6 变 5，`historyReadPointer('lean-team')` 用例删除 |
| `tests/process-receipts.test.ts` | [21](tests/process-receipts.test.ts#L21) | `toolProfile:'lean-team'` → `'lean-solo'`（该用例只测后台输出回执，与图无关） |
| `tests/workspace-git-wiring.test.ts` | [16](tests/workspace-git-wiring.test.ts#L16) | fixture profile 改 `lean-solo`；[69](tests/workspace-git-wiring.test.ts#L69) 期望工具列表去掉 `delegate/task/find_agents`（应为 `['read','edit','write','bash','job','ask_user']`）；[103-115](tests/workspace-git-wiring.test.ts#L103-L115) 的“子运行无 git job”用例删除（子角色视图只属 lean-team） |
| `tests/method-stages.test.ts` | 无 | **不改**。第 7 行 `readTaskGraph` 与图事件测试（[86](tests/method-stages.test.ts#L86)）继续有效，这是保留 task-graph 的收益 |

### 3.3 保持不动、但必须作为 1a 回归哨兵

- 默认配置请求字节/工具面：`tests/compact-tools.test.ts`、`tests/simplicity-tools.test.ts`、`tests/efficiency-defaults.test.ts`（`taskProtocol/toolProfile` 默认值断言 [efficiency-defaults.test.ts:14](tests/efficiency-defaults.test.ts#L14)、重开旧会话保留策略 [18-26](tests/efficiency-defaults.test.ts#L18-L26)）。
- spawn 保留路径：`tests/collaboration.test.ts`、`tests/spawn-configuration.test.ts`、`tests/write-scope.test.ts`、`tests/agent-followup.test.ts`、`tests/todo-runtime.test.ts`。
- 方法阶段：`tests/method-stages.test.ts`。
- 恢复/CHECK 恢复：`tests/recovery*.test.ts`、`tests/storage*.test.ts`（`user_version=7` 断言 [tests/storage.test.ts:49](tests/storage.test.ts#L49)、[tests/storage-events.test.ts:117](tests/storage-events.test.ts#L117) —— 1a **不改** schema 版本）。

### 3.4 1a 必须新增的最小测试

1. **旧会话兼容闸门**（新 `tests/session-compatibility.test.ts`）：构造 `toolProfile:'lean-team'` 的持久会话 → `Application.run/recover/submitInput/spawnAgent` 抛 `SESSION_INCOMPATIBLE`；只读的 `app.sessions()`、`inspect`、`gc` 仍可用；新会话不受影响。
2. **默认配置不变量**：`compact-v2` 会话的 `mailbox.specs()` 不含 `delegate/task/find_agents`；`--tool-profile lean-team` 被拒（覆盖 [cli/index.ts:127](src/cli/index.ts#L127)）；请求工具集与删除前字节一致（复用 compact-tools 风格）。
3. **保留 spawn 路径的写范围语义**（补 `tests/write-scope.test.ts`）：同一次模型响应内两个 `spawn_agent`、后一个声明与第一个重叠的 `scope.write` → 要么在创建任何子运行前整体拒绝并给出可行动错误，要么串行化；互不重叠仍可并行（对应 §6.1 修复）。
4. **502 退避**（新 `tests/model-retry-backoff.test.ts` 或扩 `tests/provider.test.ts`）：连续 3 次 502 时重试间隔为分钟级且可取消、计费/预算口径不变（对应 §6.2）；需提供测试用延迟注入点，否则真实等待会让单测不可接受。
5. **spawn 端到端回归**：没有 lean-team 之后，仍要有“spawn 子运行写文件 → 主运行 wait/inspect → 完成”的真实链路测试（现有 `collaboration.test.ts` 覆盖消息但无“写共享工作区并核验”的黄金级路径），用于替代被删的 `lean-team-runtime` 集成覆盖。

---

## 4. 数据与兼容

### 4.1 store 表 / 事件 / 数据字段

**没有任务专用 SQLite 表**。任务图的全部持久化都在既有表里：

| 位置 | 内容 | 删除后 |
|---|---|---|
| `events` 表（[storage/index.ts:96](src/storage/index.ts#L96)） | `task.*` / `recovery.task_*` / `todo.dispatched` 事件行 | 旧行保留只读；新代码不再写/读 |
| `sessions.data` JSON（[storage/index.ts:87,222-234](src/storage/index.ts#L87)） | `toolProfile:'lean-team'`、`maxTaskNodes`（[application/index.ts:506](src/application/index.ts#L506)）；`taskProtocol` 保留 | 旧值仍在；新会话不再写 `lean-team/maxTaskNodes`；**需闸门** |
| `runs.data` JSON（[storage/index.ts:88,240-249](src/storage/index.ts#L88)） | `taskNode{ownerId,nodeId,role,generation}`（[messaging/index.ts:445](src/messaging/index.ts#L445)`、[types.ts:125-126](src/runtime/types.ts#L125-L126)） | 旧值仍在；新代码不再写/读；类型字段最终删除 |
| `waits.data` JSON（[storage/index.ts:99,370-380](src/storage/index.ts#L99)） | `taskNodeIds`（[types.ts:204-205](src/runtime/types.ts#L204-L205)） | 旧等待行可能残留；图等待删除后这些 run 若恢复会表现为“无依赖的等待”，必须由闸门拦住 |
| `calls` 表 | `host.task.check` 调用（[task-checks.ts:56](src/runtime/task-checks.ts#L56)） | 旧行保留只读 |

结论：**不需要 schema 迁移，不需要提升 `user_version`（当前 7，见 [storage/index.ts:82-85,129](src/storage/index.ts#L82-L85)）**；把 `user_version` 提到 8 反而会让 `Storage` 直接拒绝整个数据目录（[storage/index.ts:84](src/storage/index.ts#L84)），过于粗暴。

### 4.2 旧会话处置：显式版本不兼容，不静默降级

产品未发布，定位文档 §5 要求“恢复旧会话时明确报出版本不兼容，不静默降级”（[定位文档:146](docs/kodo-final-positioning-20261103.md#L146)、[减法方案:109](docs/kodo-subtraction-plan-20261103.md#L109)）。

- **错误判定**：`session.toolProfile === 'lean-team'` 或 `session.maxTaskNodes !== undefined`（1a 之后这两者只可能来自旧会话）。可选加固：目标 run 的 `taskNode` 非空、或目标 session 存在 `task.node.updated`/`task.dispatch.*` 事件。
- **落点**：新增 `assertSessionCompatible(session)`（建议放 `src/runtime/session-compat.ts`，抛 `KodoError('SESSION_INCOMPATIBLE', ...)`），在**执行入口**调用：
  - `Application.run`（[application/index.ts:524](src/application/index.ts#L524)）——覆盖 CLI `resume/continue/input/answer`（[cli/index.ts:371,381](src/cli/index.ts#L371)）与 Web 的 resume/继续；
  - `Application.recover`（[application/index.ts:542](src/application/index.ts#L542)）——兜住恢复路径；
  - `Application.spawnAgent`（[application/index.ts:453](src/application/index.ts#L453)）——禁止旧会话再创建子运行。
- **不要放在 `Store.session()`**（[storage/index.ts:225-234](src/storage/index.ts#L225-L234)）：`Store.session` 被 `sessionsPage` 使用（[storage/index.ts:235-239](src/storage/index.ts#L235-L239)），而 `GET /api/sessions` 依赖它（[web/server.ts:183](src/web/server.ts#L183)）、`app.sessions()` 也有测试断言；放那里会让“列出旧会话”也报错，违背“可查看、不可执行”的最小破坏原则。
- **错误文案**：明确写“该会话由已删除的 lean-team 任务图创建，本版本不兼容；产品未发布，请新建任务（如需保留证据可用 `kodo inspect`）”，不提供降级成 legacy 视图的选项。

### 4.3 CLI 参数、环境变量、Web API、文档/脚本

| 面 | 现状 | 1a 处置 |
|---|---|---|
| CLI `--tool-profile` | 值域含 `lean-team`：[cli/index.ts:127](src/cli/index.ts#L127)；help [cli/index.ts:59](src/cli/index.ts#L59) | 值域删除 `lean-team`，help 同步；旧命令直接 `ARGUMENTS` 错误 |
| CLI `--task-protocol` | [cli/index.ts:128-129,233](src/cli/index.ts#L128-L129) | **保留**（todo 协议；1e 才收敛） |
| CLI `--max-task-nodes` | **不存在**；`maxTaskNodes` 只能通过 `ApplicationOptions`（[application/index.ts:71,124,176](src/application/index.ts#L71)）设置，且仅 lean-team 写入 session | 随 lean-team 一起删除 Application 选项/字段；CLI 无需改名 |
| serve/Web/TUI 入口 | `serve` 不传 toolProfile（[cli/serve.ts:93](src/cli/serve.ts#L93)）→ Web 新任务永远默认 compact-v2；host-state `Policy` 无 profile 字段（[cli/host-state.ts:72](src/cli/host-state.ts#L72)）→ TUI 恢复不受影响 | 无需改动，只要闸门拦住旧 lean-team 会话 |
| 环境变量 | 任务图无专属环境变量（`KODO_RUN_OUTPUT_DIR` 等为通用运行输出） | 无 |
| Web API | 无任务端点；`/api/runs`、`/api/sessions`、SSE 原样透传事件（[web/server.ts:183](src/web/server.ts#L183) 及事件流）；协作投影按 `parentId` 列子运行（[web/collaboration.ts:96-100](src/web/collaboration.ts#L96-L100)） | 源码不改；旧事件只是不再产生；旧会话由 §4.2 挡住 |
| 文档 | `README.md:7` 描述 lean-team 9 工具；`docs/inline-methods.md:17` 提到 lean-team 不能启用方法；`docs/check-output-preservation-plan.md:15` 提到 lean-team 输出；`docs/os-sandbox.md:45` 提到 `--kodo-tool-profile lean-team`；`docs/kodo-lean-parallel-plan.md` 是 1a 的设计文档（§4.1/§5 整章讲图调度）；定位文档 §6 已计划阶段 1 后统一改 README/设计文档 | 1a 内至少改 README:7 与 CLI help；其余在阶段 1 收尾统一改，历史实验文档（`docs/experiments/*`）**不重写**，只标注为历史 |
| 对照脚本 | `scripts/comparison/frontier/launch.mjs:13,102`、`run.mjs:66`、`lean-ablation.mjs:23-25,39,49` 接受 `lean-team`；`efficiency-comparison.test.mjs:268-272` 断言 `selectKodoSandbox('lean-team')`；`delegation-metrics.mjs:266-383` 从旧证据读 `delegate`/`task`/`task.*`（只读旧 .kodo 数据，不 import src） | 不 import src 的冻结分析器保留（它们只读历史证据）；launch/run/lean-ablation 在 1a 文档中标注“lean-team 配置已不可用，历史脚本仅作证据重放”，或在后续清理中删除 L3 格 |

---

## 5. 分步提交计划（5 步，每步独立编译 + 全量测试）

原则：先关入口与加闸门（行为可回退）→ 再断运行时接线 → 再删文件 → 再收类型与跨批引用 → 最后修内核问题与文档。**每一步结束都能 `npm run check` + `npm test` 全绿**，且不依赖后续步骤。

### 步骤 1：冻结 lean-team 入口、旧会话闸门、测试基线

- 改：`src/application/index.ts`（选项/字段/校验/默认卡/内置卡分支：§1.2 行）、`src/cli/index.ts:59,127`、`src/agents/card.ts:206-216`、新增 `src/runtime/session-compat.ts` 并在 `run/recover/spawnAgent` 调用（§4.2）。
- 删/改测试：§3.1 的 16 个文件全部删除或按 §3.2 改写（此时旧代码仍在，删测试不影响编译）；新增 §3.4 第 1 项兼容闸门测试。
- 不改：`types.ts` 的 `lean-team` 值域与任务文件（保持可编译）。
- 风险：`tests/efficiency-defaults.test.ts:32-33` 的 `toolProfile/taskProtocol` 校验断言、`tests/lean-solo.test.ts:230` 的错误文案断言；旧 dev 数据目录里的 lean-team 会话从此不可恢复（符合产品决定）。
- 验证：全量测试；`app.sessions()` 对旧会话仍可列出；新建会话 profile 只能是 4 种。

### 步骤 2：断开运行时接线（TaskRuntime 不再构造，删除的代码暂不可达）

- 改：`coordinator.ts` 去 `TaskRuntime`（§1.2 行；保留 [29](src/runtime/coordinator.ts#L29)/[500-502](src/runtime/coordinator.ts#L500-L502) 给方法阶段）、`completion.ts`（lean-team 条件 + `host.tasks` 等待分支）、`state-frame.ts`（删 lean-team 任务块）、`child-completion.ts`（删 team 过滤）、`application/index.ts`（去 `carryRecoveryTaskGraphs` 调用）。
- 不改：`messaging/index.ts`（工具面仍注册但无会话可达）、任务文件本体、`types.ts`。
- 风险：默认 `compact-v2` 行为应逐字节不变（这些调用在非 lean-team 下都是 early-return：`task-runtime.ts:146,291`）；必须重点跑 `compact-tools/simplicity-tools/efficiency-defaults/collaboration/context` 这些请求形状与生命周期测试，确认 `driveSession` 的等待/唤醒循环（[coordinator.ts:268-313](src/runtime/coordinator.ts#L268-L313)）在移除 `tickForModel/retryDelay` 后不空转、不多跑模型步。

### 步骤 3：删除 12 个任务文件 + 清理工具面（保留 task-graph/task-declare/task-completion）

- 删：§1.1 第 4–15 共 12 个文件（`task-runtime`、`task-dispatch`、`task-dispatch-record`、`task-execution-host`、`task-lifecycle`、`task-checks`、`task-recovery`、`task-workspace`、`task-notice`、`messaging/task-spawn`、`messaging/task-tool`、`messaging/delegate`）。
- 改：`messaging/index.ts`（§1.2 全部：任务 schema 换成方法阶段 `methodTaskSpec`、删 `spawnTaskHost`/`waitForTasks`/`taskNodeIds` 分支/`taskOperation`/execute 分支、`prepareSpawn` host 参数）、`application/index.ts` 的 `carryRecoveryTaskGraphs` 已在上一步删除（本步确认无残留 import）。
- 保留：`task-graph.ts`、`task-declare.ts`、`task-completion.ts` 原样（443 行，服务 `method-stage.ts`/`state-frame.ts:113`/`completion.ts:81`/`coordinator.ts:500-502`）。
- 风险：`method-stages.test.ts` 必须保持全绿（本步不碰 task 三文件即安全）；`messaging/index.ts` 的 `definitions` 数组重构最易出错（`main:true` 标记、inlineMethods 的 `task` 必须仍被 offer，见 §2.1）；`controlTool` 的 `task` 控制语义（[messaging/index.ts:70](src/messaging/index.ts#L70)）继续覆盖方法阶段。

### 步骤 4：类型与跨批残余引用清理

- 改：`types.ts`（§1.2：去 `lean-team` 值域、`maxTaskNodes`、`Run.taskNode`、`Wait.taskNodeIds`、`StepOutcome.taskGraphStamp`）；随之清理 `execution-workspace.ts:21-34`、`messaging/agent-lifecycle.ts:53-54`、`messaging/spawn-spec.ts:102-111`、`messaging/index.ts:440-448,627`、`application/index.ts:595-598`、`coordinator.ts:327-331`、`tool-view.ts`（lean-team/角色视图）、`role-view.ts`、`step-host/model-step/tool-step/context.ts/tools/index.ts/view-pointers.ts` 的 `(!parentId || profile==='lean-team')` 判定简化（逐处改成 `!run.parentId`，保持 lean-solo 子运行行为不变）。
- 测试：§3.2 的 view-pointers/workspace-git-wiring 改写在此步收尾。
- 风险：**最高的一步**。`Run.taskNode` 有 7 处隐藏引用（§1.2），漏一处就编译失败；`lean-solo` 子运行视图语义容易被“简化过头”（子运行在 lean-solo 会话本就走 kernel 视图，任何 profile 判断都要保留 `parentId` 条件）；`method-stages.test.ts` 第 7 行 import 仍须有效（保留 task-graph）。

### 步骤 5：两个内核修复 + 文档/脚本标注

- 改：§6.1、§6.2 的实现（与任务图删除完全独立，可单测）。
- 测试：§3.4 第 2–5 项；更新 `tests/provider.test.ts:154-182` 的 502 尝试次数/间隔断言、`tests/kernel-hardening.test.ts:49-55` 的退避断言（若改等待策略）。
- 文档：`README.md:7`、`src/cli/index.ts:59`（若步骤 1 未改完）、`docs/inline-methods.md:17`、`docs/check-output-preservation-plan.md:15`、`docs/os-sandbox.md:45`；实验对照脚本按 §4.3 标注冻结。
- 风险：退避测试如果走真实分钟级等待会拖慢全量测试 → 必须提供可注入延迟（建议 `StepHost`/Provider 测试缝或 `KODO_TEST_*` 环境变量），且取消语义（[model-step.ts:331-334](src/runtime/model-step.ts#L331-L334) 释放模型槽位后再等）保持不变。

**备选方案（若必须 1a 删满 1,854 行）**：把 `inlineMethods`（方法阶段）的删除并入步骤 3：删 `method-stage.ts`(165)、`method-context.ts`(64)、`extensions/methods.ts`(134) 及 `application`/`messaging`/`state-frame`/`completion`/`instruction-layer`/`roster-context` 的方法分支，再删 task 三文件。净删更多，但会把 1e 的范围提前、并与“方法阶段并入阶段 2 编译器”的路线冲突；除非产品明确放弃 P1–P4，否则不推荐。

**提交粒度**：建议每步一个提交（共 5 个），步骤 1–4 是纯删除/收敛、可逐提交回退；步骤 5 是独立内核修复，若需对照黄金评测可单独 revert。

---

## 6. 两个内核问题（只分析，不改）

### 6.1 共享执行下的写范围冲突（保留的 spawn 路径）

**现象（有原始证据）**：五组复测的 resident 组第 37 个请求**在同一次模型响应里**派发 SCXML 与图表两个子任务，两者都没给明确写范围；第二个派发被 `WRITE_SCOPE_CONFLICT` 拒绝，模型随后取消第一个子任务并在第 41 个请求用具体文件范围重新派发（[log-analysis:51](docs/experiments/kodo-statemachine-five-arm-log-analysis-20261103.md#L51)）。原始记录：`.kodo/statemachine-five-arm-20261103/statemachine-resident/statemachine-kodo/process/steps.jsonl:37`（`call_01` 报 `write scope undefined overlaps child … which holds write scope ["."]`）。定位文档把它列为 P0 稳定性问题：[positioning-convergence:145](docs/kodo-positioning-convergence-review-20261103.md#L145)、[最终定位:144](docs/kodo-final-positioning-20261103.md#L144)、[减法方案:98](docs/kodo-subtraction-plan-20261103.md#L98)。

**当前代码路径**：

1. `spawn_agent` 的 schema 中 `scope` 可省略（[spawn-spec.ts:59-62](src/messaging/spawn-spec.ts#L59-L62)），默认子运行落在**共享工作区**（`execution` 省略即不建隔离检出，[messaging/index.ts:431-432](src/messaging/index.ts#L431-L432)）。
2. `prepareSpawn` 归一化 scope（[messaging/index.ts:414-418](src/messaging/index.ts#L414-L418)），随后调用写冲突检查（[messaging/index.ts:420](src/messaging/index.ts#L420)）。
3. 检查本体 [spawn-spec.ts:147-163](src/messaging/spawn-spec.ts#L147-L163)：strict 模式下 `claims()`（[155](src/messaging/spawn-spec.ts#L155)）把 **`scope.write === undefined` 也当成占用整个工作区**；`holder` 扫描只看已存在的、共享执行中的存活子运行（[158-160](src/messaging/spawn-spec.ts#L158-L160)）。
4. 同一次模型响应的多个工具调用按 `toolBatches` 分批（[tool-batch.ts:11-19](src/runtime/tool-batch.ts#L11-L19)）；协作工具不是“安全并行”调用，因此每个 `spawn_agent` 各自成批、**顺序“准入→执行→提交”**（[tool-step.ts:290-321](src/runtime/tool-step.ts#L290-L321)）。于是第二个 spawn 被准入时，第一个子运行已经提交并持有 `["."]` 声明 → 拒绝。失败不是并发竞态，而是**逐个准入无法看到同一响应的整体意图**。
5. 保留路径上的第二层冲突：主代理自己的 shell/写操作会被当成工作区级写入，与共享子运行 scope 相交而被拒（[todo-execution.ts:27-31](src/runtime/todo-execution.ts#L27-L31) 的 `TODO_DELEGATED`；[tools/index.ts:296-305](src/tools/index.ts#L296-L305) 的 `WRITE_SCOPE_CONFLICT`，仅 `taskProtocol>=2` 生效）。这也是“共享执行”成本的一部分，1a 删除任务图后这两处**仍然存在**，属于保留 spawn 路径要复核的代码。

**修改建议（二选一或组合；与 1a 独立）**：

- **方案 A（推荐，小改）**：在 strict/共享执行下，**写权限子运行必须声明非空 `scope.write`**，否则在准入阶段抛 `SCOPE_REQUIRED` 并提示“给出两个子任务各自的写入范围”。落点：[messaging/index.ts:414-420](src/messaging/index.ts#L414-L420)（scope 归一化之后）；`claims()` 保持不变即可（声明后不会再出现 `undefined` 占。）。好处：错误发生在**创建任何子运行之前**，模型一次修正即可；符合最终定位“要求写任务声明 `scope.write`”。
- **方案 B**：**把同一次模型响应的多个 spawn 作为整体校验**。在 `runToolStep` 的准入循环（[tool-step.ts:290-316](src/runtime/tool-step.ts#L290-L316)）里先收集本响应所有 `spawn_agent`/`explore` 请求，按解析后的 `scope.write` 两两检查 `writeScopesOverlap`（[scope.ts:115-119](src/runtime/scope.ts#L115-L119)），有重叠则整体拒绝（不创建任何子运行）或按声明顺序串行（后者不理想：共享工作区仍会互相覆盖）。落点：`tool-step.ts` 的批次循环 + `spawn-spec.assertNoWriteConflict` 复用。
- 兜底（可选）：非 strict 模式下省略 scope 仍按继承处理，保持旧行为，不影响默认 compact-v2 的普通委派。

**必须新增的测试**：`tests/write-scope.test.ts` 增加“同一次模型响应里两个 spawn”的脚本化用例（现有测试只覆盖顺序单独调用，[write-scope.test.ts:23-36](tests/write-scope.test.ts#L23-L36)）；断言：重叠 → 不创建任何子运行或只创建第一个且第二个得到可行动错误；不重叠 → 两个都创建；主写入被活子运行 scope 拦下的行为仍保留。

### 6.2 “无内容时 25 秒内 3 次 502 即判失败” → 分钟级退避

**现象**：五组复测 active 组第 140–142 次请求连续 HTTP 502，第三次失败后主运行直接终止（[log-analysis:87](docs/experiments/kodo-statemachine-five-arm-log-analysis-20261103.md#L87)、[five-arm:63](docs/experiments/kodo-statemachine-five-arm-20261103.md#L63)），外部验收只能针对中断时留下的补丁。定位文档要求改为分钟级退避（[最终定位:144](docs/kodo-final-positioning-20261103.md#L144)）。

**当前代码**：

- 失败分类：5xx → `MODEL_TRANSPORT`（[providers/errors.ts:21-31](src/providers/errors.ts#L21-L31)）；`retry-after` 最大只接受 60 秒（[providers/errors.ts:35-45](src/providers/errors.ts#L35-L45)）。
- 重试策略：[model-step.ts:292-340](src/runtime/model-step.ts#L292-L340)（`callModel`）：
  - 上限：`attempts >= 3 + outputRetries + incompleteRetries` 抛 `MODEL_RETRIES`（[309](src/runtime/model-step.ts#L309)）；
  - 终止条件：`attempts - outputRetries - incompleteRetries >= 2` 时不再重试（[328](src/runtime/model-step.ts#L328)）→ 即**第 3 次尝试失败后直接失败**；
  - 退避：`Math.min(60_000, retryAfterMs ?? ceil(1000 * 2^attempts * (1 + random*0.25)))`（[329](src/runtime/model-step.ts#L329)）→ 依次约 1s、2s；加上 502 响应耗时，总窗口约 25 秒（与文献/日志的“25s 内 3 次”一致）。
  - 失败前会释放模型槽位、等待、重新排队（[331-334](src/runtime/model-step.ts#L331-L334)），取消可在等待中生效（[tests/kernel-hardening.test.ts:49-55](tests/kernel-hardening.test.ts#L49-L55)）。
- 多 endpoint 场景走 [model-step.ts:232-289](src/runtime/model-step.ts#L232-L289)（`callProviderGroup`）：按 fallback 路由切换、`delayMs:0`，与单 binding 的退避是两套逻辑。

**修改建议（只分析）**：

1. 对 `MODEL_TRANSPORT`（HTTP 5xx/连接类）保持 3 次尝试，但把退避改为**分钟级**：例如 `attempts` 为 1→约 30s、2→约 60s（带抖动；有 `retryAfterMs` 时取 `max(retryAfter, 30s)` 并仍受会话时间预算约束）；即把 [329](src/runtime/model-step.ts#L329) 的公式改为按错误类别分支，需同步放宽 [errors.ts:44](src/providers/errors.ts#L44) 的 60s 截断（仅 5xx 场景）。这样最坏等待约 90 秒 + 3 次请求时间，仍远小于黄金样例 `maxDurationMs=3,600,000`（[case.json:7-15](eval/golden/cases/coding-01-statemachine/case.json#L7-L15)）。
2. 或者把 5xx 的尝试上限从 3 提到 5–6 次、退避 15–60s，总窗口 2–4 分钟；但这会放大费用（每次 502 通常没有 usage，计费口径为 unknown 预留，见 [errors.ts:30](src/providers/errors.ts#L30) 与 [model-step.ts:177-189](src/runtime/model-step.ts#L177-L189)），需要评测口径配合。
3. **必须保留**：等待期取消、等待计入会话时长（`maxDurationMs`/`activeMs`，避免无限等待）、预算耗尽即停止、同请求的持久 retry transition 审计（[model-step.ts:240-248](src/runtime/model-step.ts#L240-L248)）不变。
4. **测试影响（必须同时改）**：`tests/provider.test.ts:154-182`（`{status: 502, attempts: 3}` 与 `received===attempts`）、`tests/provider.test.ts:183-200`（预算截断）、`tests/kernel-hardening.test.ts:28-55`（退避与取消）、`tests/runtime.test.ts:89-96`（transport 失败）。**若没有可注入的等待缝，分钟级真实等待会让全量测试从秒级变成分钟级**；建议在 `StepHost` 上加测试用 delay 注入（或识别 `NODE_ENV==='test'`/显式 `KODO_TEST_RETRY_DELAYS`），保持生产为分钟级。

---

## 7. 风险清单

### 7.1 黄金样例可能翻转的类别与判断

| 类别 | 是否受 1a 影响 | 说明 |
|---|---|---|
| 任务派发（literature/data/report 中若模型想用多任务并行） | **默认配置不受影响**，但行为上更“少一种选择” | 默认 compact-v2 根本没有 `delegate/task/find_agents`（§0-2），黄金评测的 `Application` 默认构造也拿不到；真实变化是模型可用的协作面只剩 `spawn_agent/followup_task/…`，与本批删除无关 |
| 检查点/任务图完成判定 | 不翻转（默认不可达） | `completion.ts:81` 的图分支只在 lean-team 或 inlineMethods 时启用；前者删除、后者保留 |
| Web 协作投影 | 不翻转 | 投影从不读任务图（[web/collaboration.ts:96-100](src/web/collaboration.ts#L96-L100)）；旧会话的事件重放客户会忽略 |
| TUI | 不翻转 | 无任务图/lean-team 引用（全目录 grep 无命中） |
| 方法阶段（inlineMethods） | **不翻转**（若按推荐保留三文件）；若选备选方案则整块能力消失，会产生未跑过的样例风险 | 这是保留三文件的第二个理由 |
| 提示词/工具字节（成本、缓存） | 低风险，但需哨兵 | 1a 不应改任何默认配置的 system prompt/tool schema；以 `compact-tools/simplicity-tools/efficiency-defaults` 为不变量测试；若步骤 2 误改 `driveSession` 等待循环，可能出现“多一次模型请求”的隐藏成本翻转 |
| 内核修复（同批） | **时间/费用指标会动** | 502 分钟级退避会拉长受污染格耗时，不会改合格率；`summary` 的 `wallMs` 均值要按“污染/无污染”分开看（[黄金评测设计:158-163](docs/kodo-golden-eval-design-20261103.md#L158-L163)） |

### 7.2 必须新增的最小保障（汇总）

1. `tests/session-compatibility.test.ts`：旧 lean-team 会话在 run/recover/input/spawn 上显式 `SESSION_INCOMPATIBLE`，只读入口仍可用。
2. 默认配置不变量：`compact-v2` 的工具/请求字节与删除前一致；`lean-team` CLI/profile 被拒；`taskProtocol` 语义不变。
3. spawn 共享写范围：同响应多 spawn 的整体校验（§6.1）。
4. 502 分钟级退避 + 取消 + 预算/计费不变（§6.2，带测试延迟缝）。
5. spawn 端到端替代覆盖：子运行写共享工作区 → 主运行 wait/inspect → 完成（替代被删 `lean-team-runtime` 的集成覆盖）。
6. 方法阶段回归：`method-stages.test.ts` 全绿（保留三文件的验收条件）。

### 7.3 阻塞/待决事项（交给 lead）

1. **阶段 0 门槛未达成**：`scripts/golden/` 评测入口缺失、无 `.kodo/golden` 基线；1a 的“删前删后黄金对比”无法执行（§0-3）。需要先补评测入口，或明确接受“全量测试 + 请求字节不变量”的替代验收。
2. **1,854 行承诺 vs 443 行保留**：需要产品决定是否把 `inlineMethods` 删除提前并入 1a（备选方案），否则 1a 的实际净删是 1,411 行、余量留给 1e。
3. **内核修复的验收口径**：分钟级退避会改变黄金评测的耗时指标，建议把该修复放在独立提交，并用“污染格不计均值”的口径比较。

---

## 8. 边界（其他批次一句话）

- 1b（隔离检出与集成，`runtime/execution-*`，约 1,156 行）：本文件只标注了与 1a 交叉的三处（`execution-workspace.ts:21-34` 的 taskNode 续接判定、`execution-lean/hostCommitChild` 被 `task-runtime` 调用、`tests/isolated-execution.test.ts` 因 import 任务图必须随 1a 删除），其余不在本文展开。
- 1c（名册/路由/留存/派生/预设/角色卡）与 1d（协作工具精简、todo 去依赖与派发）、1e（档位/A–E/任务协议收敛、方法阶段并入）、1f（提示词审计）：不在本批次范围；1a 只保证不提前改变 `taskProtocol`、spawn、todo 的现有语义，给后续批次留出干净切面。

---

## 9. Lead 决策（2026-11-03）

1. **接受 1a 净删 1,411 行的范围调整（不把 inlineMethods 提前并入 1a）。** `runtime/task-graph.ts`、`runtime/task-declare.ts`、`runtime/task-completion.ts` 保留到 1e，与定位方案“P1–P4 并入上下文存储的加载策略”一致；1e 完成时一并删除这 443 行。验收口径按净删 1,411 行记录，不再以 1,854 为批次承诺。
2. **旧会话闸门按本文 §4.2 落在 `Application` 的 run/recover/spawnAgent 入口，`SESSION_INCOMPATIBLE` 显式报错**；不新增 SQLite 迁移、不改 `Store.session`，只读列表接口保持可用。产品未发布，旧 lean-team 会话不静默降级。
3. **两个内核修复与 1a 删除分开提交**（同一批次内先修后删或先删后修均可，但提交与验收分开）：写范围冲突修复用“同一响应内多 spawn 的写范围整体校验”；502 三次即失败改为分钟级退避并保留可注入测试延迟（生产分钟级、测试不真实等待）。内核修复会拉长受污染格耗时，黄金对比按“污染格不计入均值”的口径比较。
4. **开始 1a 的门槛不变**：必须先完成阶段 0 基线（10 样例 × 3 次、评分标准人工复核）。当前 `scripts/golden` 与基线数据由 Lead 与 eval-harness 并行补齐；门槛达成后按本文 §5 的 5 步执行 1a。
5. 本文 §7.3 的 3 项待决事项按以上 1–3 关闭；第 4 项（基线可执行性）正在解决。
