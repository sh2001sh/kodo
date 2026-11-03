# Kodo 阶段 1 批次 1d 删除/精简地图：协作工具、子运行 fresh/fork、todo 去依赖与派发

- 快照：HEAD `14deba8`（1a 已合并；1b 在 worktree `phase1/batch1b` 实施中；1c 未开始但已有删除地图）。本图是**只读分析**，未改源码/测试，未 commit。
- 依据：`docs/kodo-final-positioning-20261103.md:140`（1d = 协作工具精简为 spawn/wait/inspect/cancel/ask_user；子运行只留 fresh/fork；todo 去掉依赖与派发，约 1,500 行）、`:69-77`（子运行三种用途）、`docs/kodo-subtraction-plan-20261103.md:72-73`、`docs/kodo-phase1-batch1a-map-20261103.md:102-117`（1a 后 `Run`/`Session` 最小形状与 task 文件保留决策）。
- 前提：本图按 **1b、1c 先落地** 分析（1d 在其后）：
  - 1b 已删 `execution` 参数与隔离检出（`spawn-spec.ts:66`、`prepareSpawn` 相关分支）；
  - 1c 已删名册/角色卡/派生（`child-config.ts`、`configuration.ts`、`presets.ts`、derive/contracts 卡片部分），子运行**继承父卡**，报告机制迁至 `src/runtime/report.ts`，`Card.execution.modes` 保留到 1e；
  - 因此 1d 开工时 `messaging/index.ts` 的卡片选择、`explore` 的 read-only 卡逻辑、`report` 的卡片契约都已被 1c 清掉；本图引用当前 HEAD 行号，并注明 1c 后变化。
- 规模：1d 直接相关源文件约 **1,700 行**（messaging 605 + spawn-spec 163 + explore/exploration/nudge 184 + bindings/todo 555 + completion/state/context 相关），**源码净删约 1,500–1,650 行**（含 new fork 追加约 50 行）；关联测试整删 10 文件约 **2,097 行**、改写约 10 文件，测试净删约 **2,200–2,400 行**。
- 结论：1d 是"接口面收缩"而不是纯删除——必须同时完成 ① 协作工具面收敛到 5 个；② spawn 改成 fresh/fork 两条受控路径并保住 2d84453 的同响应写范围整体校验；③ todo 退化为纯清单。三件事有共享调用链（`prepareSpawn`/`specs()`/`tool-step`），建议按 §7 的 5 步拆。

---

## 1. `src/messaging/index.ts` 逐工具清单（605 行）

当前工具定义在 `definitions`（`:42-58`），`specs()`（`:95-161`）按 factors/卡片/agentFeatures 追加或改写描述，`validate()`（`:162-171`）校验，`execute()`（`:172-253`）分发。

| 工具 | 定义 | 主要执行分支 | 参数（当前） | 1d 处置 |
|---|---|---|---|---|
| `spawn_agent` | `spawn-spec.ts:39-68` | `:177`→`spawn():254`→`prepareSpawn():344-418`/`commitSpawn():419-442` | objective/context/inputs/acceptance/agent/card_id/card_version/permissions/model_binding/scope/continuation_of/slots/configuration/todoId/execution（1b/1c 后只剩 objective/context/inputs/acceptance/permissions/model_binding/scope/continuation_of/todoId） | **保留并改造**：删 `todoId`；`continuation_of` 明确为 **fork**（或改名 `fork_of`，见 §2）；保留 permissions 子集、scope、写冲突校验；描述重写为"fresh/fork 两种" |
| `wait_for_events` | `:54` | `:251`→`register():484-503` | question_ids/run_ids/mode/timeout_ms | **保留**：wait 对 run_ids 与 ask_user 的 question 都还要用；`taskProtocol` 分支（`:136-141`、`:482`、`:496`）留给 1e 收敛，1d 不动逻辑 |
| `inspect_run` | `:52` | `:197`→`inspectRun()`（`runtime/inspection.ts`） | run_id/call_id/call_ids/offset/limit/section（1c 后 section=report 已无意义） | **保留**：删 `section=report` 及 report/todo 投影（§4）；child 结果唯一读取入口 |
| `cancel_agent` | `:57` | `:234-242` | run_id | **保留**：只允许取消自己管理的 child |
| `ask_user` | `:55` | `:243-250` | question | **保留** |
| `send_message` | `:53` | `:216-233` | to/kind/content/reply_to/artifacts/message_id | **删除**：工具定义、execute 分支；连带 application `submitAgentInput`（`:641`）、TUI `/tasks message`（`controller.ts:805-807`）、web `agent_input` action（`server.ts:365`）、child-completion 中"send_message to resume"提示（`child-completion.ts:43`）。消息机制本身保留（用户问题/回答、runtime notice） |
| `explore` | `messaging/explore.ts:79` | `:179-188` + `commitExplore` | tasks[prompt/scope/thoroughness/configuration/todoId] | **删除**：工具定义（`:45`）、specs 过滤（`:111`、`:147-150`）、execute 分支、`explore.ts` 整文件；`Run.explore`、`exploreInstructions`、`exploreReportChars`、`Run.exploration` 相关逻辑一并删；read-only 调查改由 **fresh 子运行**承担（§2.4、§8-R3） |
| `exploration.plan` | `runtime/exploration.ts:27-47` | `:176`→`planExploration():286-343` | batch_id/decision_version/questions… | **删除**：定义、execute、`planExploration` 整段（约 57 行）、`runtime/exploration.ts`（83）、`ApplicationOptions.structuredExploration/exploreNudge/exploration`（`application:92-97`、`:181`、coordinator 选项）、`exploreNudge` 提示（`tool-step.ts:9,291,305,429`） |
| `followup_task` | `spawn-spec.ts:89-99` | `:178`→`followup():257-274` | target/objective/context/inputs/acceptance/slots/model_binding/todoId | **删除**：工具、specs 分支（`:117`、`:158`）、followup 方法、`resolveManagedAgent`/`agentIdentity` 复用身份（`agent-lifecycle.ts:13-45`）；"继续已结束的子运行"由 **fork**（`spawn_agent.fork_of`）承担，不保留独立工具 |
| `agent.derive` | `agents/derive.ts:17-29`（1c 删实现） | `:174` + specs `:112` | base/overlay | **1c 已删实现；1d 清残余**：删除 `:174` 分支与 specs 过滤中的 `agent.derive` 条件（1c 若未删干净在此收尾） |
| `report.submit` | `agents/contracts.ts:48-68`（1c 迁至 `runtime/report.ts`） | `:175`、specs `:113,115` | fields | **删除工具**：定义、specs、execute 分支；删除 1c 新建的 `runtime/report.ts`（validateReport/submitReport/reportCompleteness/hostAcceptanceStatus）并简化其 5 个消费点：`completion.ts:3,86-87,158-160`、`inspection.ts:8-9,43,124,193`、`method-stage.ts:14,66,104`（只删报告检查，不删 method 文件，P1–P4 属 1e）、`messaging/index.ts` child packet 的 `card.report` 段（`:412`） |
| `task` | `method-stage.ts:?`（`methodTaskSpec`，`:43`） | `:173` `executeMethodStage` | action/inputs | **保留到 1e**：inline methods P1–P4；不要动 `task-graph/declare/completion.ts` |
| `list_agents` | `:50` | `:198-215` | 无参 | **删除**：属聊天/名册式协作工具。子运行容量/成员信息改由 spawn 错误、`inspect_run` 与 web 协作视图（直接读 store）提供；同时删 tests 断言与 agent-factors 提示 |
| `interrupt_agent` | `:56` | `:237-240` | run_id | **删除**：保留 `cancel_agent`；崩溃/fault 中断的恢复仍走 coordinator 的 `resumeInterrupted`（host 侧），不再暴露"逐轮中断子运行"模型工具。application `interruptAgent`（`:672`）与 TUI `/tasks interrupt`（`controller.ts:808`）删除 |
| `update_progress` | `:51` | `:189-196`→`updateTaskProgress`（`context-progress.ts:54-92`） | facts/completed/pending/evidence/knowledge_uses | **保留功能、移出协作工具**：它是上下文进度快照（压缩/状态帧使用），不是协作工具。1d 建议把它从 `definitions` 移到上下文工具注册（`tools/index.ts` 或 context-progress 注册），并删除 `knowledge_uses`（知识库仍在，最终由 1e 上下文存储接管）；若 Lead 要求严格五工具，则删工具并从 `state-frame/context-progress` 移除进度快照逻辑 |

**连带结构改动（messaging/index.ts）**：
- `definitions` 从 13 项缩到 5 + `task`（1e）；`schemas`/`collaborationTool`/`controlTool`（`:59-65`）随之缩小；`methodTaskSchema` 保留（1e）。
- `specs()`（`:95-161`）：删除 factors/agentFeatures/snapshot/pinned/routing 分支（`:110-134`；1c 已删 roster，1d 删剩余 factor 文案）；删除 `handoffSpec`（`:153`，`handoff.ts` 整文件删除）；`spawn_agent` 的 compact-v2 描述（`:155-157`）改为 fresh/fork 短说明；`followup_task`/`report.submit` 分支删除；`taskProtocol<2` 的 `delete properties.todoId/execution`（`:143-152`）只留 `todoId`（1e 收敛协议后整体删）。
- `prepareSpawn`（`:344-418`）：1b/1c 后只保留：活跃/容量/预算校验（351-354）、继续(fork)校验（357-364，去掉 `resolveManagedAgent` 链式要求，改为"settled managed child + 同一 card/binding/permissions/scope"）、permissions 子集（365-369，保持不变）、子卡=父卡（1c）、`scope` 归一（387-391，去掉 cardScope/项目变量）、**同响应写冲突组校验的入参**（393→ `assertNoWriteConflict`，2d84453 不能回退）、模型 binding（394-402，1e 收敛 model roles）、fork/运行上下文（见 §2）、删除 todo assignment/execution/agent factors 分支/instructions 分支中 1d 无关项、删除 `card.report`/slots/exploration/explore packet 段。
- `commitSpawn`（`:419-442`）：删除 `recordTodoDispatch`（423）、todo/execution 字段（441）、`agentId` 复用（421/436，fork 不需要身份别名）、report/todo 输出；保留 run.queued/model_selected 事件、instruction chain、返回给模型的 id/status。
- `register/wait`（`:481-503`）：保留；`refresh` 输入判断（`:520-525`）去掉 `dependency_changed`/`execution_blocked`（todo/1b 已删）。
- `detectDeadlocks`（`:539-572`）：删除 continuation gate 逻辑（`:541,547`；fork 只允许 settled source，queued gate 不会出现）；保留 wait 环检测。
- `onTerminal`（`:573-600`）：**统一子运行结果交付**——保留 summary（1200 字符）+ resultRef + deliverables + reconciliation + quality + `inspect` 指针；删除 `run.exploration` 分支（586-590）、`run.explore` 报告分支（594-597）、`card.report` completeness 分支（597）、`taskProtocol===3` 的 `childCompletionSummary` evidence 分支（597，1e 任务图处理）。`result()`/`userQuestions` 保留。
- `recoveryTarget/recoverySuccessor/recoveryIdentities`（`:449-480`）：保留——verified-effect recovery 的 continuation 仍要转发问题/答案；但 `agent.followup` 事件与 `agentId` 分支删除。
- `followup`（`:257-274`）删除；`spawnHost`（`:276-285`）保留（host/CLI/web 初始 spawn 用），schema 换成新 spawn 后继续可用。

---

## 2. 子运行：1a/1b/1c 之后还剩什么；如何只留 fresh 与 fork

### 2.1 现状组件（1a 后）

| 组件 | 位置 | 1d 处置 |
|---|---|---|
| 容量/活跃判定 | `spawn-spec.ts:102-128`（`childIsActive/childCapacity/assertChildCapacity`） | 保留 |
| 写冲突与 group fix | `spawn-spec.ts:147-163`（`assertNoWriteConflict`）；`runtime/tool-step.ts:26-69`（`spawnWriteClaim`/`responseSpawnWriteConflicts`，调用点 `:322`） | **保留且不得回退**（2d84453）；1c 删 card_id 后 `strict` 只剩 `agentFactors.A/C`（`:38`），1e 再收敛 |
| 创建与提交 | `messaging/index.ts:254-285,344-442` | 改造为 fresh/fork（§2.2） |
| 子运行身份/名册复用 | `agent-lifecycle.ts:13-45`（`agentIdentity/managedChild/resolveManagedAgent`） | `managedChild` 保留（inspect/cancel 用）；`agentIdentity/resolveManagedAgent` 删除（followup/名册） |
| fork 上下文 | `agent-lifecycle.ts:48-71`（`childFollowupContext`） | **重写为 append-only fork**（§2.3）；`FOLLOWUP_CONTEXT_CHANGED` 约束（same binding/permissions/scope）保留 |
| 结果回传 | `onTerminal`（`messaging/index.ts:573-600`）、`child-completion.ts:7-48`、`inspection.ts:32-49` | 保留汇总 + `inspect_run` 指针；删 explore/探索/report/task 分支 |
| 完成检查/延期 | `runtime/completion.ts:80-110,135-161` | 保留"等活跃子运行"（94-109）；删 todo/report/exploration/图分支（1e 图） |
| 用户输入/继续 | `application.submitInput`（`:612-635`）、`context.followUpContext`/`historyFrom` | 保留（main run 的 host follow-up）；child 的 `submitAgentInput` 删除 |
| 方法 P1–P4 | `task-graph/declare/completion.ts`、`method-stage.ts` | **1e 才处理，1d 不碰** |

### 2.2 1d 后的两种子运行（目标契约）

- **fresh**：`spawn_agent({ objective, context?, inputs?, acceptance?, permissions?, model_binding?, scope? })`；不在 `definition` 里出现 agent/card/slots/todo/fork 参数；子运行 `card = parent.card`（1c 已定）、新 `initialContext`；结果经 `onTerminal` 摘要 + `inspect_run` 回主运行。
- **fork**：`spawn_agent({ fork_of: <settled managed child run id>, objective, ... })`（可保留旧名 `continuation_of` 作为内部/兼容别名，模型面只暴露一个）。要求：同一 session、同一 parent、source 已 terminal、source 的 card/binding/permissions/scope 与本次一致（沿用 `childFollowupContext:48-56` 的检查）；**上下文 append-only**：以 source 的已持久化 context 前缀 + 新任务指令组成，不重排/过滤，以便提供方缓存命中；结果折回同 fresh。
- 删除 `followup_task` 后，"独立复核" = **fresh 子运行**（read-only 或统一父卡，显式要求黑盒复核，不传实现者结论），而不是 `explore`/reviewer 角色卡。默认提示里"用 explore 做只读调查/reviewer 复核"的文案需在 1d 改写（`card.ts` 默认 prompt 由 1c 改，`agent-factors.ts:20-23` 再删 explore/followup/send_message 句）。

### 2.3 fork 的当前实现与缺口（缓存前缀）

- 当前 fork 语义 = `continuation_of` 的 follow-up：`prepareSpawn`（`:357-364`）要求 source 是 settled managed child、且是该 teammate 最新 run；`commitSpawn`（`:432-435`）用 `childFollowupContext` 替换 context。
- `childFollowupContext`（`agent-lifecycle.ts:48-71`）把 source 的旧会话**重排**为：`fresh.slice(0,-1)`（新 system/environment）→ 过滤后的旧历史（去掉 system/agents/project-instructions/environment/state/notice/nudge/completion-check/delivery-audit，以及旧 method/todo 消息）→ 状态过渡 user 消息 → `fresh.at(-1)` 新 objective。这与 source run 的原始消息前缀**不是逐字节相同**，提供方前缀缓存无法命中；且 `fresh` 前段本身是子运行系统提示/环境（不同 request 的 system 位置）。
- 目标实现：`forkContext(sourceRun, childRun)` = `store.readBlob<Message[]>(source.contextRef)` 的**原样前缀** + 一条新的 user 指令（说明这是 fork 新任务、旧结论不构成验收），不再插入/过滤/重排；因为 1c 后 child.card = parent.card、permissions/scope/binding 与 source 相同，system/tool schema 也与 source 的后续请求一致；首个不同 token 出现在追加的用户消息处，缓存命中 source 已缓存前缀。
- 缺口清单：(a) 需要保证 `source.contextRef` 在 source 结束后不再变化（已持久化，满足）；(b) `initialContext` 的环境/权限块必须与 source 相同（same scope/permissions 检查已存在）；(c) instructions chain 不能重渲染（fork 沿用 source 的 `instructions`）；(d) 目前没有"main → 子运行共享主干前缀"的 fork（final positioning 的 fork 场景是主运行前缀），1d 先实现 child→child fork（删除 followup 后仍有"继续某交付物复核"需求），main-prefix fork 留到阶段 2 上下文编译器（不在 1d 范围，README 也不应承诺）；(e) 缓存断点/请求尾部状态帧（state-frame）在 source 的 context 里是历史消息，无需重算。
- 结果回传：fork 完成后 `onTerminal` 仍发 summary+resultRef；主运行用 `inspect_run` 读证据；不再有 `followup_task` 的 agentId 身份链。

### 2.4 子运行相关删除/保留一览

| 文件 | 行 | 处置 |
|---|---:|---|
| `src/messaging/explore.ts` | 79 | 整删（`explore`/`ExploreTask`/`commitExplore`/`exploreInstructions`） |
| `src/messaging/handoff.ts` | 26 | 整删（`leadHandoffGuidance`/`handoffSpec`/`childHandoffGuidance`）；`leadHandoffGuidance` 被 `agent-factors.ts:?` 使用，需在 factors 文案中内联或删除 |
| `src/runtime/exploration.ts` | 83 | 整删（`exploration.plan` spec/validate/`explorationCard`/`explorationResultContract`） |
| `src/runtime/explore-nudge.ts` | 22 | 整删（explore 提醒） |
| `src/messaging/agent-lifecycle.ts` | 72 | 改造：保留 `managedChild`；`agentIdentity/resolveManagedAgent` 删；`childFollowupContext` 改为 append-only fork（约 -37 行） |
| `src/runtime/child-completion.ts` | 49 | 改造：删 send_message/followup_task 反馈文案（`:43-44`），保留 fault/interrupted 与 inspect 失败确认规则（约 -8 行） |
| `src/runtime/inspection.ts` | 223 | 改造：删 `childCompletionSummary` 的 report/todo/exploration 依赖（`:32-49`、`:132-141`、`:193`），`inspect_run` 保留 section=result/acceptance；约 -25 行 |
| `src/runtime/completion.ts` | 163 | 改造：删 todo/report/exploration 分支（`:2-3,86-87,107-109,135-161` 部分），保留 delivery/children/quality/workspace；约 -30 行 |
| `src/runtime/context-progress.ts` | 92 | 改造：progress/todo 消息简化（todo 只保留纯清单）；约 -25 行 |
| `src/runtime/state-frame.ts` | 137 | 改造：删 `todoDispatch` 块（`:10,108-113,130`）；约 -12 行 |
| `src/runtime/coordinator.ts` | 589 | 改造：删 todo 钩子（`:26,100,273`）、exploration 选项/复核（`:44,50,54,66,498-499`、`:564`）约 -35 行 |
| `src/application/index.ts` | 822 | 改造：删 `structuredExploration/exploreNudge/exploration` 选项与 `createRunWithDiscovery` 的探索分支（`:92-97,181,205` 等）、`submitAgentInput`（`:641`）、`interruptAgent`（`:672`）、已被移除子运行的分支（`:704-710`）；`spawnAgent`/`options.team`/`submitInput`/`answer`/`cancelAgent` 保留；约 -55 行 |
| `src/runtime/context.ts` | 401 | 改造：删 `run.explore/exploration` 上下文分支（`:386` 等）、state 帧探索/任务段；约 -15 行 |
| `src/runtime/model-step.ts` | 435 | 改造：删 continuation/exploration 提示分支（`:77`、探索相关）约 -10 行 |
| `src/runtime/types.ts` | 250 | 改造：删 `Run.exploration/explore`（`:138-140`）、`Run.todo`（`:136`）、`agentId/historyFrom` 中 fork 不再需要的字段（`Run.agentId` 只服务 followup；`historyFrom` 保留给主运行 follow-up）约 -10 行 |

---

## 3. todo：删除依赖/派发，保留简单清单

### 3.1 目标形状

保留：`todo.read` / `todo.write`（或合并为 `todo.update`）、`readTodoSnapshot`、revision 乐观并发、items `{id, content, status: pending|in_progress|completed, title?, note?}`、`expectedRevision`、 durable `todo.updated` 事件、`recover` verifier、上下文中的计划摘要（`context-progress.ts` `todoMessage/withTodo`，简化）。
删除：`executor`、`dependsOn`、`generations`、`acceptedDependencies`、`dispatch`、`todo.dispatched`、`TODO_*` 依赖/验收/派发错误、`parallelTasks`/taskProtocol 分支（协议统一留给 1e）、`refreshTodoDependencies`、`todoExecutionFeedback` 对主运行的写前阻断、`child.todo`/`todoId` 关联、`carryRecoveryTodo` 的 dispatch 事件搬运（保留快照搬运即可）。

### 3.2 精确引用点

| 文件/位置 | 内容 | 改动 |
|---|---|---|
| `src/tools/todo.ts:12-14` | `TodoExecutor`/`TodoItem.executor/dependsOn`/`TodoSnapshot.generations/acceptedDependencies` | 删字段 |
| `src/tools/todo.ts:22-31` | write schema（executor/dependsOn） | 简化 schema |
| `:53-79` | `itemGeneration/parallelTasks/resolveTodoAssignment/activeAgentTodo` | 全删（1d 不再有派发分配） |
| `:81-97` | `recordTodoDispatch/dispatchedRuns` | 全删 |
| `:98-117` | `todoDispatchState/todoCompletionFeedback` | 全删（改为简单"仍有未完成项"提示） |
| `:120-196` | todo.read/write 工具执行 | 重写简化版（约 100 行 → 约 60 行） |
| `:198-212` | `validateDependencies` | 删 |
| `src/tools/todo-dynamic.ts` 整文件 205 行 | protocol 3 动态 todo schema | **整删**；其协议 3 特有的 items/updates/remove/cancelQueued 语义并入简化版 todo.write 或直接删除（1e 统一协议） |
| `src/runtime/todo-dependencies.ts` 94 行 | 依赖满足/刷新/blocked 通知 | **整删** |
| `src/runtime/todo-execution.ts` 44 行 | 主运行写前 todo 执行约束 | **整删**；`tool-step.ts:3,112` 的 `assertTodoExecution` 调用删除（todo 变纯提醒，工作区写冲突仍由 kernel 锁/ownership 保证） |
| `src/messaging/index.ts:8-9` | `recordTodoDispatch/resolveTodoAssignment`、`todoDependenciesSatisfied` import | 删 |
| `:349` | `const todo = resolveTodoAssignment(...)` | 删；无 todoId 参数 |
| `:392-393` | `assertNoWriteConflict` 前 todo 依赖条件 | 改为仅 `assertNoWriteConflict(...)`（保留 group fix 语义） |
| `:414` | `child.todo = todo` | 删 |
| `:423` | `recordTodoDispatch` | 删 |
| `:441` | spawn 返回值 `todo/blockedOnDependencies` | 删 |
| `:520-525` | wait 输入判断含 `dependency_changed/execution_blocked` | 只保留 question/input/decision/user notice |
| `src/messaging/explore.ts:43`（删除文件） | explore 的 todoId | 随文件删 |
| `src/messaging/spawn-spec.ts:9,17,65,97,158-160` | `todoDependenciesSatisfied`、`todoIdSchema`、followup todoId、holder 条件 | 删 import/参数/条件（`todoId` 完全移出 spawn） |
| `src/runtime/completion.ts:2,10,107-109,146-161` | todo 完成反馈/依赖等待 | 删 todo 分支；保留 children.active 延期逻辑 |
| `src/runtime/coordinator.ts:26,100,273` | `refreshTodoDependencies/todoRunReady` | 删 import/检查 |
| `src/runtime/state-frame.ts:10,108-113,130` | todoDispatch | 删块 |
| `src/runtime/context-progress.ts:4-5,54-92` | todo 消息/withTodo | 保留简化版（纯清单，无 executor/dispatch/deps） |
| `src/runtime/inspection.ts:132-141`、`:193` 附近 | 子运行 todo 分配/依赖投影 | 删（子运行不再有 todo 关联） |
| `src/application/index.ts:33,211`（`todoTools(store,{cancelQueued})`） | todo 注册选项 | 简化 `todoTools(store)`，去 `cancelQueued` |
| `src/runtime/types.ts:136` | `Run.todo` | 删字段（子运行无 todo 关联；主运行计划只存事件） |
| `src/runtime/tool-step.ts:3,112` | assertTodoExecution | 删 import/调用 |
| `docs`/CLI 帮助中 todo 依赖说明 | — | 1d 文档同步 |

### 3.3 与 1e 的 task 边界

`src/runtime/task-graph.ts`(165)、`task-declare.ts`(170)、`task-completion.ts`(108) **1d 不碰**（1a 决定保留给 inlineMethods P1–P4）。1d 只保证：`todo` 不再引用 task 图/派发，`completion.ts` 的 `taskGraphStamp`/`classifyTaskGraph`（1e）保持可编译；`method-stage.ts` 的 `validateSlots/reportCompleteness` 改动仅限报告删除（P1–P4 属 1e），不改 task 文件。

---

## 4. 逐文件删除/改造/保留（含行数与引用点）

| 文件 | 行数 | 处置 | 行数变化估计 |
|---|---:|---|---:|
| `src/messaging/index.ts` | 605 | 改造（§1） | → 约 300（-305） |
| `src/messaging/spawn-spec.ts` | 163 | 改造：删 agent/slots/configuration/todoId/followup spec/rosterSpawn spec，保留 capacity/active/writeConflict/模型校验 | → 约 85（-78） |
| `src/messaging/explore.ts` | 79 | 整删 | -79 |
| `src/messaging/handoff.ts` | 26 | 整删 | -26 |
| `src/runtime/exploration.ts` | 83 | 整删 | -83 |
| `src/runtime/explore-nudge.ts` | 22 | 整删 | -22 |
| `src/messaging/agent-lifecycle.ts` | 72 | 改造：删 identity/resolveManagedAgent；fork context append-only | → 约 30（-42，另 fork 实现 +30 在 index/新文件） |
| `src/runtime/child-completion.ts` | 49 | 改造反馈文案 | -8 |
| `src/runtime/completion.ts` | 163 | 改造（todo/report/exploration 分支） | -30 |
| `src/runtime/inspection.ts` | 223 | 改造（report/todo 投影） | -25 |
| `src/runtime/context-progress.ts` | 92 | 简化 | -25 |
| `src/runtime/state-frame.ts` | 137 | 删 dispatch 块 | -12 |
| `src/runtime/coordinator.ts` | 589 | 删 todo/explore 钩子 | -35 |
| `src/runtime/context.ts` | 401 | 删 explore/exploration 上下文分支 | -15 |
| `src/runtime/model-step.ts` | 435 | 删 continuation/explore 提示分支 | -10 |
| `src/runtime/types.ts` | 250 | 删 `Run.exploration/explore/todo/agentId` 等 | -10 |
| `src/runtime/tool-step.ts` | 434 | 删 `assertTodoExecution`、exploreNudge 调用 | -8（group fix 保持） |
| `src/tools/todo.ts` | 212 | 重写简化 | → 约 105（-107） |
| `src/tools/todo-dynamic.ts` | 205 | 整删 | -205 |
| `src/runtime/todo-dependencies.ts` | 94 | 整删 | -94 |
| `src/runtime/todo-execution.ts` | 44 | 整删 | -44 |
| `src/application/index.ts` | 822 | 删探索选项/child 输入/interrupt/探索 supersede 分支 | -55 |
| `src/runtime/role-view.ts` | 35 | 删 `agent.*`/explore/update_progress 的视图豁免（工具已不存在） | -6 |
| `src/runtime/agent-factors.ts` | 53 | 删 explore/followup/send_message/名册文案（factor 本体 1e 删） | -8 |
| `src/web/server.ts` | 443 | 删 `/agents/:id/input`、`agent_input` action（`:301-306,365-366` 中的 input 分支；`interrupt` 同步）、exploration 事件流 | -25 |
| `src/web/collaboration.ts` | 452 | 删 send_message/agent 输入相关 pending action 与展示（`message` 相关；保留 ask_user/answer、cancel、inspect、view_agent） | -30 |
| `src/web/workbench.ts` | 157 | 删 agent 输入/消息 composer 相关请求 | -20 |
| `src/tui/controller.ts` | 1055 | 删 `/tasks message`、`/tasks interrupt`（`805-808`）；保留 `/tasks cancel`/`/tasks resume`（fault 恢复） | -25 |
| `src/tui/agents.ts` | 318 | 1c 已大幅裁剪；1d 再删 message/interrupt 动作（`173` 附近 launch 已由 1c 处理） | -10 |
| `src/cli/index.ts` | 492 | `spawn` 参数去 `--agent/--slot`（1c 已做工具面则只剩 help/校验）；删 child 相关命令帮助；保留 `input/continue/answer`（用户→主运行） | -20 |
| `src/cli/agent-input.ts` | 28 | 1c 已删（`--slot/--scope` 属卡片选择） | - |
| `src/runtime/method-stage.ts` / `src/extensions/methods.ts` | 165/134 | 只删 report 检查（`method-stage:14,66,104`）与 explore 兼容视图；P1–P4 留给 1e | -10 |
| `src/runtime/execution-*` | — | 1b 负责 | - |
| 新增 `src/messaging/fork.ts`（建议） | +60 | `forkContext(source, child)` + 校验（append-only、same card/binding/permissions/scope） | +60 |

**净删估计**：上表删除合计约 **1,500–1,650 行源码**（未计 1c 已删项与 1b）；若把 web/tui 只做最小改（保留旧面板但移除请求），可保守到约 1,350。

---

## 5. 关联测试

### 5.1 整体删除（10 文件，约 2,097 行）

| 文件 | 行数 | 原因 |
|---|---:|---|
| `tests/agent-followup.test.ts` | 336 | followup_task/agent identity 全删 |
| `tests/explore.test.ts` | 320 | explore 工具删除 |
| `tests/exploration-plan.test.ts` | 278 | exploration.plan 删除 |
| `tests/exploration-runtime.test.ts` | 221 | 探索运行时删除 |
| `tests/explore-nudge.test.ts` | 98 | explore 提醒删除 |
| `tests/todo-delegation.test.ts` | 225 | todo 派发/executor 删除 |
| `tests/todo-parallel.test.ts` | 198 | 并行/依赖删除 |
| `tests/todo-dynamic.test.ts` | 257 | protocol 3 动态 todo 删除 |
| `tests/todo-acceptance-contract.test.ts` | 92 | 派发验收删除 |
| `tests/recovery-todo-plan.test.ts` | 72 | 依赖/派发恢复 |
| **合计** | **2,097** | |

### 5.2 必须改写

| 文件 | 行数 | 改动 |
|---|---:|---|
| `tests/collaboration.test.ts` | 474 | 协作工具面：send_message/followup/explore/list_agents/interrupt 用例删；保留 spawn/wait/inspect/cancel/ask_user；重写 fresh/fork、child 结果回传 |
| `tests/collaboration-projection.test.ts` | 451 | web 协作投影：去 message/agent_proposal 流（1c 已删 retention），保留 question/answer/cancel/inspect/view_agent |
| `tests/child-completion.test.ts` | 165 | 反馈文案去 send_message/followup；保留 failed/inspect 确认、interrupted/fault 规则 |
| `tests/child-result-summary.test.ts` | 127 | 统一 summary+resultRef+inspect 指针；删 explore/report 分支断言 |
| `tests/event-resource-wait.test.ts` | 203 | 事件等待保留；删除隔离/探索相关（1b/1c 已删并入）、child 消息唤醒用例 |
| `tests/write-scope.test.ts` | 85 | **保留并扩展** group fix 两用例（`:39-78`）；删除 execution 字段相关（1b 后） |
| `tests/kernel-acceptance.test.ts` | 486 | 只改 spawn/inspect 相关段；其余验收不变 |
| `tests/simplicity-tools.test.ts` / `simplicity-runtime.test.ts` | 134/78 | 工具集合收敛到 5+task 后改写 |
| `tests/todo-tool.test.ts` / `todo-runtime.test.ts` | 57/136 | 改为纯清单 API（read/write/revision/恢复） |
| `tests/inspection.test.ts` / `inspection-acceptance.test.ts` / `inspection-extensions.test.ts` | 194/159/108 | inspect_run section/report/todo 投影删除 |
| `tests/autonomous-delegation.test.ts` | 243 | 端到端只留 fresh（spawn→wait→inspect→cancel）；fork 新用例 |
| `tests/handoff-factors.test.ts` | 120 | handoff.ts 删除、factors 文案改（整体 factors 收敛 1e） |
| `tests/continuity.test.ts` / `lifecycle.test.ts` / `lifecycle-convergence.test.ts` | 204/214/233 | main follow-up 历史保留；child 身份/继续用例删 |
| `tests/model-scope.test.ts` / `role-coordination.test.ts` / `compact-tools.test.ts` / `cli.test.ts` / `web.test.ts` | 260/86/171/599/200 | spawn 参数/卡片选择（1c 已减）+ 1d 工具面；CLI spawn 参数、web agent input 路由 |
| `tests/agent-context.test.ts` / `agent-card-runtime.test.ts` / `agent-model-policy.test.ts` | 251/271/200 | 1c 已处理名册/卡；1d 再删 explore/followup 上下文断言 |

### 5.3 必须新增

1. 协作工具面恰好 `spawn_agent/wait_for_events/inspect_run/cancel_agent/ask_user`（+ `task` 临时保留）；`send_message/followup_task/explore/exploration.plan/agent.derive/report.submit/list_agents/interrupt_agent/update_progress` 不出现在 specs/validate 中。
2. **fresh**：无 fork 参数；child.card === parent.card；结果只通过 summary+inspect 回传；无 mailbox 点对点消息。
3. **fork**：`fork_of` settled child；上下文 = source context 原样前缀 + 新 user 指令（断言字节前缀相等：`child.contextRef` 前缀 JSON 等于 source 的 contextRef 前缀）；source 未 settled / 不同 binding / permissions/scope 不同 → 拒绝；fork 完成后 summary 回传。
4. **kernel fix 2d84453**：同一响应两个重叠 scope 的 spawn（含 fork）整体拒绝、0 子运行；不重叠允许；`tool-step.ts:26-69` 逻辑保留。
5. **todo 简化**：read/write/revision/note/恢复；不再有 executor/dependsOn/dispatch/todoId；子运行无 todo 字段。
6. 默认提示不再推荐 explore/reviewer/followup/send_message；把"独立复核"表述为由 fresh 子运行执行（`card.ts` 1c 改、`agent-factors.ts` 1d 改）。

---

## 6. 数据兼容与 web/TUI 投影

- **旧 run/session**：1c 的 `SESSION_INCOMPATIBLE` 门通常已拒绝带名册的旧会话；1d 再补充：任一 run 有 `exploration/explore/todo` 字段、或存在 `exploration.planned`/`agent.followup`/`send_message` 相关事件/消息的会话 → 显式 `SESSION_INCOMPATIBLE`（只读 `inspect`/`events` 仍可看）。不新增 SQLite 迁移；旧列 JSON 字段忽略即可。
- **持久等待**：旧 `waits` 行若引用已删子运行/消息，恢复时 `peer`/`message` 缺失会报错；gate 在 resume/recover 入口先拒绝旧会话，避免半执行。
- **web**：`/api/runs/:id/agents/:child/input` 删除；`/agents/spawn` 保留（host spawn 继续）；`/api/runs/:id/agents/:child/cancel` 保留；collaboration pending 只保留 `answer/resume/cancel/view_agent/inspect`；`agent_input` action 与 UI composer 删除；children 结果/view 用 summary+inspect。
- **TUI**：`/tasks message`、`/tasks interrupt` 删除；`/tasks cancel`、`/tasks logs`、`/tasks evidence` 保留；`/tasks resume` 仅用于中断/fault 恢复（`resumeInterrupted` host 路径）。
- **CLI**：`kodo spawn` 去掉 `--agent/--slot`（1c 卡片选择删除后只剩 objective/scope/model-binding/fork-of）；`kodo input/continue/answer` 保留（用户→主运行）；`kodo agent`（1c 删除）。
- **事件/文档**：`exploration.*`、`agent.followup`、`agent.derived`、`send_message` 相关事件仅用于旧数据；文档同步（1d 范围外但需在合并前）：`docs/cli-host-configuration.md` 协作节、README 多 Agent 描述、`docs/agent-*.md` 标历史。

---

## 7. 分步提交计划（5 步，每步可独立编译+测试）

| 步骤 | 内容 | 主要文件 | 风险/验证 |
|---|---|---|---|
| **S1（删工具面）** | 删 `send_message/followup_task/explore/exploration.plan/agent.derive(残余)/report.submit/list_agents/interrupt_agent/update_progress` 的定义与执行分支；删除 `explore.ts/handoff.ts/exploration.ts/explore-nudge.ts`；删 application `submitAgentInput/interruptAgent/createRunWithDiscovery` 与探索选项；删 web/TUI/CLI 对应路由与动作；`prepareSpawn` 暂保持（followup 删除后 continuation 仍可用）；同步删/改测试 5.1 与相关用例 | messaging、spawn-spec、application、web、tui、cli、测试 | 工具 schema 大幅变化（黄金门槛在 S5 统一跑）；`npm run check` + 受影响测试 |
| **S2（fresh/fork 改造）** | `prepareSpawn/commitSpawn` 收敛为 fresh/fork；新增 `fork.ts` append-only 上下文；重写 `agent-lifecycle`（保留 managedChild，删 agentIdentity/resolveManagedAgent）；`child-completion`/`onTerminal` 统一结果回传；**保留并测试** `tool-step.ts:26-69` group fix；`types.ts` 删 exploration/explore/todo/agentId | 上述 + tool-step/测试 | 最高风险步骤：spawn 保留路径（2d84453）；写冲突/容量/recovery continuation 测试；新增 fork 前缀断言 |
| **S3（todo 简化）** | 删 `todo-dynamic/todo-dependencies/todo-execution`；重写 `todo.ts` 纯清单；删 spawn `todoId`/`Run.todo`/dispatch 事件/`state-frame` dispatch 块/`completion`/`coordinator`/`inspection` 引用；todo 只作为主运行计划 + 上下文提醒 | tools/runtime/application | `todo-tool/todo-runtime` 改写；确保 1e 的 task-* 文件未动、method-stage 可编译 |
| **S4（兼容与投影）** | `session-compat` 追加 1d legacy 判定；web/TUI 投影清理完成；CLI help/文档片段；旧表/旧 JSON 只读兼容；补充 §5.3 测试 | session-compat、web、tui、cli、docs | 旧会话拒绝、只读可读；web/TUI 无 404 |
| **S5（门槛与文档）** | 全量 `npm run check`+`npm test`；27 格文本矩阵 + coding-01 重跑并逐格对比基线（工具集/默认 prompt 变化）；更新状态板/减法清单/README 协作节 | docs + eval | 门槛：合格数不降、无新增违规、匹配格 token 中位比 ≤1.10；单格翻转复测 |

依赖顺序：1b → 1c → **1d S1-S5**。S1 与 S2 都对 `messaging/index.ts` 大改，建议同分支连续提交、各自可编译。

---

## 8. 风险清单（按影响排序）

1. **spawn 写范围整体校验不能回退（2d84453）**：实现位于 `src/runtime/tool-step.ts:26-69`（`SpawnWriteClaim/spawnWriteClaim/responseSpawnWriteConflicts`），调用点 `:322`；测试 `tests/write-scope.test.ts:39-78`。1c 删 `card_id` 后 `spawnWriteClaim` 的 `strict` 只剩 `session.agentFactors?.A/C`（`:38`）；1d 改 spawn 参数（fresh/fork）时**必须保持**"同一响应所有 spawn 先整体校验、冲突一次性拒绝、0 子运行"，fork 若也走 spawn_agent 同样纳入组校验；`prepareSpawn` 中 `assertNoWriteConflict` 调用（`messaging/index.ts:393` 附近）不能因删 todo 条件而改变触发范围。
2. **fork 缓存前缀**：`childFollowupContext`（`messaging/agent-lifecycle.ts:48-71`）重建消息序列，和 source 前缀不一致，提供方前缀缓存无法命中（这也是 final positioning "fork 共享主干前缀"的收益所在）。1d 必须改成 append-only：`source.contextRef` 原样 + 新 user 指令，且要求 card/binding/permissions/scope/instructions 与 source 完全一致（复用现有 `:48-56` 检查）。若 1d 仍用旧 `childFollowupContext`，fork 只是"语义继续"而非缓存优化，指标不会改善，也会与阶段 2 上下文编译器冲突。
3. **explore 删除后"独立复核"由 fresh 承担**：默认 prompt/`agent-factors.ts:20-23` 目前把 explore/reviewer/followup 当作推荐方式；1d 必须改写为"用 fresh 子运行做黑盒复核（不提供实现者结论）"，否则模型会继续找已删工具。同步影响黄金评测 prompt 与人工项。
4. **默认工具集合变化对黄金评测 prompt 的影响**：1d 一次移除 6+ 工具（send_message/followup/explore/exploration.plan/derive/report.submit/list_agents/interrupt）并重写 spawn 参数与描述、agent-factors 文案；这会改变 system prompt、工具 schema/token 数、默认行为。必须按阶段 1 门槛口径重跑 27 格 + 逐格对比（`docs/kodo-phase1-status-20261103.md:17-30`），并检查 coding-01 loadCase/held-out 可运行；1b/1c 已各自改变工具面，建议 1d 独立跑门槛。
5. **子运行默认权限面变化**：1c 后子卡=父卡，1d 再删 followup/send_message 的权限约束路径；fresh 子运行继承父 permissions（spawn `permissions` 仍可子集），必须保留 `prepareSpawn` 的 `PERMISSION_ESCALATION` 校验（`messaging/index.ts:365-369`）与 scope 继承（`:387-391`），否则子运行可能比旧审查更宽。测试 todo/autonomous/write-scope 覆盖。
6. **recovery/中断语义**：`interrupt_agent` 删除后，`Run.interruptRequested` 只由崩溃/fault/host 产生；`coordinator.resumeInterrupted`、`application.interruptAgent`、TUI resume、`child-completion.ts:43` 的中断反馈必须一致（保留 fault 恢复路径，删"模型主动中断"路径）。`continuationOf` 仍被 verified-effect recovery 使用（`application/index.ts:577,591`），**不能**随 followup 一起删；区分"recovery continuation"与"用户 fork"。
7. **report 删除跨界 1e**：`method-stage.ts:14,66,104` 属 P1–P4（1e），1d 只删报告检查，不改文件结构；`completion/inspection` 的报告投影删除后，1e 若还需要"任务完成度"必须换成图/编译器证据，不能悄悄回退。
8. **todo 变纯清单的行为变化**：删除 `assertTodoExecution`（`runtime/todo-execution.ts`）后，主运行不再被"计划未选任务/依赖未验收"阻断写入——这是**预期简化**，但需在文档与测试中明确；容量/写冲突由现有 kernel 锁与 ownership 保证，不新增语义。
9. **web/TUI/CLI 投影残留**：删端点/命令后旧前端代码若仍 fetch 会 404/抛错；`docs/cli-host-configuration.md` 与 README 的协作描述需同步，避免文档继续承诺 send_message/explore/followup。
10. **1e 边界**：`task-graph/task-declare/task-completion`、`method-stage/extensions/methods`、`Card.execution.modes`、`Session.taskProtocol/agentFactors/toolProfile` 属 1e，本批不得顺手删除；1d 的 todo/protocol 分支删除要留下 1e 可收敛的空间（尽量只删依赖/派发，不提前做协议收敛）。

---

## 附：行数核算

| 项 | 行数 |
|---|---:|
| 1d 直接相关源文件（messaging/spawn/explore/exploration/todo/child 生命周期等） | 约 1,700 |
| 删除估算（§4 表） | 约 1,500–1,650 |
| 其中新增 fork 上下文 | +60 |
| **源码净删** | **约 1,500–1,650**（若 web/TUI 保守保留可降至 ~1,350） |
| 测试整删 10 文件 | 2,097 |
| 测试改写净减 | 约 300–500 |
| 测试新增 | 约 200 |
| **测试净删** | **约 2,200–2,400** |

计划表 1d 的"约 1,500（精简）"与上述源码净删一致；测试删减会明显更大（协作/探索/派发测试几乎整组失效）。
