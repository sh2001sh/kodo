# 子代理自主委派与复用优化设计

日期：2026-10-28。状态：容量、队友续接及两阶段执行合同已实现。根据[四方实验成本归因](experiments/frontier-fourway-cost-analysis-20261028.md)，当前因子 B 调整为按收益选择分工，并减少报告和验收往返；实际费用收益尚待同条件复测。此前选择性策略与负责人策略的历史报告保留，不作为当前版本的实测结论。

本方案补充 `agent-card-design.md` 的委派决策与生命周期部分。主代理负责理解任务、规划、验收与最终交付；范围明确的小任务可直接实现和验证。并行、专业能力或独立上下文的收益超过交接与验收成本时才委派，耦合实现与检查由同一负责人完成。成功标准是交付质量、耗时和完整会话成本，不是创建数量或委派率越高越好。

## 1. DeepSeek Harness 实际怎样让模型决定

核对版本：官方仓库 `deepseek-ai/deepseek-harness`，提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。以下区分已经看到的实现与本方案的新增建议。

### 1.1 Team 路径：提供能力与协作规则，由模型作语义判断

`tool-agent-team/src/index.ts` 在 Agent 范围内安装三类内容：

| 模型看到的内容 | 作用 | 不代表什么 |
|---|---|---|
| `team:identity`：Lead/teammate 身份、名字和消息寻址方法 | 知道自己能创建谁、可以找谁协作 | 不自动拆解任务 |
| `team:policy`：共享工作区、分开写范围、任务依赖、消息和等待语义 | 降低协调歧义，告诉模型创建之后怎样推进 | 没有计算任务复杂度或委派收益分数 |
| `spawn_teammate`、`list_agents`、`send_message`、任务板等工具 | 将模型的选择变成可执行操作 | 工具可用不保证模型每次都会调用 |

`spawn_teammate` 的描述是“Create one named, durable teammate. Only the Team Lead may call this tool.”，参数只有名字、职责描述、初始任务和 `fresh/fork` 上下文选择。调用后直接进入 `spawnTeammate()`；成员权限、名字和数量等由运行时检查。

在所检查的 Team 创建链路中，没有独立的模型裁判、文件数阈值或评分公式来决定“应该创建”。决定来自主模型对用户任务和当前上下文的理解，然后输出工具调用。Team 的主要贡献是让模型知道可用协作方式，并降低执行与续接成本。

Team 提示本身没有强制“收到请求后先拆分步骤，再创建队友”，但不能据此推断完整配置没有先规划的指导：基础配置同时安装 `todo_write`，其描述明确要求多步骤工作开始前为每个具体步骤添加待办，并跳过简单单步任务。基础配置设置 `allowParallelInProgress: true`，允许实际并行的工作同时标为进行中。

因此，DeepSeek 的完整配置通过普通 todo 工具引导先列步骤，再由模型选择如何执行。普通 todo 不带负责人或依赖字段，不自动创建队友；Team 的共享任务板是另一套工具。创建入口也不把“已经写过 todo”作为硬前置条件。本方案将先拆步骤、再选择分工的顺序合并进主代理提示，使模型不必从多个工具描述中自行拼接规则。

Team 配置包默认关闭，需要先启用。其文档示例明确要求 Lead 使用 Team，不能据此证明任意任务下都能稳定自发委派。服务的 `maxMembers` 默认 16，但官方 `agent-team-profile/cordis.patch.yml` 显式设置为 8。两者都是累计成员上限，成员可反复接任务。

### 1.2 普通子代理路径：有更明确的“何时适合”描述

`tool-subagent/src/index.ts` 的 `providerWording()` 分两种情况：

- 新上下文：委派完整、独立、聚焦的调查、实现或分析，把中间工作移出主会话；任务说明必须自足。
- 继承上下文：用于依赖当前对话的后续分析、审阅或继续处理；继承已完成轮次，任务只需说明新增要求。

其系统提示进一步要求：独立委派可在同一条模型响应中一起发出；子代理运行期间继续做有用工作；只剩等待时交回控制，由结果通知启动后续轮次。

这给模型的判断依据是“独立性、上下文依赖、主上下文负担和可并行工作”，没有固定的必委派阈值。**Team 配置包会关闭普通 `subagent/subagent_fork` 工具，因此不能声称上述普通工具描述同时存在于 Team 路径。** 本方案借鉴两者，主动补足 Kodo 的判断说明。

### 1.3 借鉴范围

采用：明确身份与工具、语义上的适用场景、异步派发、消息通知、可反复使用的队友。

不照搬：完整任务板、全部主历史分叉、对普通消息自动启动新任务、累计 8 个成员上限。是否需要这些能力应由 Kodo 的实际流程决定。

## 2. 改造前的阻力

以下为本轮改造前的源码事实，用于解释改动原因；改造后的行为见第 5—7 节：

1. `maxChildren` 默认 8，统计全部子 run，完成与取消不释放；`continuation_of` 也创建新 run 并计数。
2. `send_message` 对终态目标返回 `delivered: false`，主模型无法通过消息复用完成的队友。
3. `continuation_of` 使用新的初始上下文和有界结果证据，不等于继续原代理的完整工作上下文。
4. `explore` 创建后等待全部结果，是同步控制工具；主代理不能在本轮调用它后继续工作。`spawn_agent` 已有异步基础。
5. 委派指导分散在内核提示、主卡片、因子 B 和工具说明中。基线文本把 `spawn_agent` 限定为独立模块修改，容易形成“阅读只能用同步 explore”的理解。
6. 现有提示用“三个以上文件”等粗略线索指导探索，但文件数量无法代表独立性、是否值得交接或是否已有合适队友。

因此不能只加强一句“请主动委派”。需要同时改善判断说明、任务交接成本和生命周期。

## 3. 执行顺序：先记录分工，执行时再决定怎样派发

因子 B 使用两阶段合同。规划阶段只记录工作步骤与 `executor: main | agent`：小任务可以使用一个主代理步骤直接实现和验证，分离后的工作在委派有收益时交给子代理。待办不增加角色、代理数量或复用对象字段；这些选择留到该阶段真正执行时，根据已有结果和空闲队友决定。不能并行不排除委派，也不构成默认委派的理由。

1. **记录计划**：使用 `todo.read/todo.write` 维护步骤，为每项注明 `executor`。简短的已知事实问答无需待办；读取和协调本身没有强制先建计划的运行时门槛。多步骤实质工作先列计划是提示要求。
2. **选择阶段**：待办最多一个 `in_progress`。派发前选中一个 `executor: agent` 的待办并标为进行中，其实际派发状态最初为 `awaiting_dispatch`。这只表示选中了阶段，尚未创建子代理，也不能显示为已经委派。
3. **执行派发**：B 模式下，模型必须先选中代理待办才能调用 `spawn_agent`、`followup_task` 或 `explore` 创建新子运行，否则返回 `TODO_DISPATCH_REQUIRED`。运行时自动把实际创建的子 run 关联到选中的待办。执行时才决定派几个、选什么角色、复用谁；一个阶段可以关联多个队友，也可以关联串行续接或失败后的重试。已经提交的续作重试仍返回原结果；显式宿主派发入口不要求模型先建待办，选中代理待办时仍自动关联。
4. **验收阶段**：主代理查看关联结果、证据和失败尝试，补做仍有必要的重试。至少一个真实关联子 run 已完成、全部关联工作已经结算，且主代理明确接受结果后，才能把该委派待办标为 `completed`。子任务终态或一段成功文字都不自动完成待办。

`in_progress` 是计划阶段选择，`awaiting_dispatch` 是实际派发尚未发生；不能用计划状态替代运行事实，也不根据待办条目数自动创建代理。运行时关联以实际 run ID 为准，失败或取消的历史尝试仍供主代理验收时检查，不因后续重试而消失。

因子 B 下主代理写入待办必须提供 `executor`；文件修改、被宿主标为写入的扩展工具和进程启动必须选中一个分配给主代理的进行中待办。选中的是代理待办时，主代理的这些操作被阻止，读取、发消息、等待及证据检查仍可进行。少量整合修补也遵循该选择规则，不能一边保留代理阶段进行中，一边由主代理直接启动进程或修改文件。内部 `artifact.write` 交接材料与协作工具不受此执行归属检查限制，但仍遵守原有权限检查。读取没有强制规划门槛，不能据此声称主代理全部工具都被禁用。

尚未完成的委派待办阻止最终成功。任务改变或某项已不再需要时，可以重新规划、修改分工或删除过时项，但必须先等待该项关联的未结束工作结算，不能靠改待办丢弃正在执行的任务。用户要求不委派时按其要求安排主代理步骤；委派受容量、权限或能力阻塞时明确报告并调整计划，不静默接管大块实现。

关闭 B 时继续支持没有 `executor` 的旧计划，不将新的分工合同追溯强加给基线会话。两阶段合同使派发与验收可检查，但不自动生成计划、自动创建代理或保证模型自主采用；真实分工效果仍需重复实验验证。

待办工具合同升级为版本 2。旧 B 会话的待办快照可以读取，下一次更新时须补齐 `executor`；若持久运行绑定了旧版工具指纹，原有能力一致性检查仍会要求启动新运行，不会静默重解释旧工具调用。真实模型复测应使用新会话。

## 4. 主代理的英文指导

模型提示统一使用英文。以下为指导原则；实际文字通过 `src/runtime/agent-factors.ts` 的因子 B 渲染到主代理内核及方法提示，卡片承担“谁适合”，工具说明承担“如何调用”。新会话默认开启 B；`--agent-factors none` 保留基线提示，不代表禁用协作工具。

```text
You are the team lead. Own task understanding, planning, acceptance and delivery.
Choose delegation when parallel work, specialist expertise or a separate context
outweighs handoff and acceptance costs. Execute small bounded tasks directly,
including implementation and verification. Keep coupled work with one owner.
Before execution select an in_progress todo with executor main; before model
dispatch select an in_progress todo with executor agent. Selection does not
start an agent. Actual child runs are linked to the selected phase.
Pass established facts and file locations to avoid duplicate orientation.
Have each owner deliver implementation and actual check-call references together.
Inspect existing evidence with inspect_run before requesting revisions.
Rerun checks when code changed, evidence is missing or a concrete concern requires it.
After acceptance, finish. Use followup_task for an unmet requirement or new request,
not to package evidence, create backups or clean up report-only artifacts.
Accept an agent todo only after a linked child completed and all linked work settled.
Respect user instructions, permissions and capacity; explicitly replan if blocked.
```

不新增必须填写的“决策理由”工具，不收集模型内部推理。用户可见的任务说明、工具调用、结果和运行事件足以检查实际行为；没有创建记录不能被解释为模型已经显式评估过所有备选方案。

## 5. 工具与交互：降低选择和交接成本

| 工具 | 已实现语义 |
|---|---|
| `spawn_agent` | 异步创建独立代理，支持现有 read/review/write 卡片；返回稳定身份、run ID、状态和容量；B 下关联选中的代理待办 |
| `followup_task` | 给已空闲的代理提交一个新的明确任务，延续其可用上下文；仅主代理可调用，B 下将新 run 关联到选中的代理待办 |
| `send_message` | 保留现有通知、问答用途；不因普通消息自动启动已完成代理的新任务 |
| `list_agents` | 展示代理职责、最近任务、当前可用状态、最新 run、结果入口和剩余容量 |
| `wait_for_events` | 继续使用现有等待与唤醒机制；等待实际 run 或消息，不轮询 |
| `explore` | 保留“创建并等待”便捷语义，B 下关联该批实际子 run 到选中的代理待办；需要异步阅读时使用 explorer 卡片的 `spawn_agent` |

第一次有明确目标且无需复用现有队友时，可直接使用冻结名册中的成员，不强制先查目录或路由。名册列出必填输入槽及其类型，implementer 另提示显式写范围，减少试错。只有角色不匹配或能力不清楚时才调用发现工具。

子代理的报告工具按卡片生成具体字段定义；定义不随已有调用数量变化。检查引用可用本运行内唯一的可见工具调用编号，保存时规范化为内部编号；重名时要求使用 `inspect_run` 的精确编号，未结算调用仍拒绝。父代理先读取已有原始证据；代码变化、证据不足或具体风险才补测，不为报告另建备份和清理任务。报告完整与验收通过仍分开判断。

`followup_task` 必填 `target` 和 `objective`，并按卡片契约提供必要的 `slots`；可选 `context`、`inputs`、`acceptance`。`target` 接受稳定 agentId 或该队友任一历史 run ID，运行时定位最新任务。若目标已有未结束任务，返回 `AGENT_BUSY` 并在错误中指出当前 run；补充信息用 `send_message`，不隐式堆积第二个任务队列。相同工具调用 ID 和输入的重试返回原创建结果，改变输入则拒绝。

`list_agents` 保留原 `agents` 运行列表，并增加 `members` 队友列表，包含 agentId、最新 runId、职责、目标、状态、可用性和结果检查入口。对队友发起新任务使用 agentId；发信、等待及读取证据使用实际 run ID。

新建代理默认使用独立上下文和必要材料。本期不新增复制全部主历史的 fork 模式；评审尤其不默认继承实现者对话。复用代理则使用其保存的工作上下文，经过当前上下文预算与压缩流程，不仅传递最后一段结果摘要。

## 6. 身份、运行与数量

### 6.1 最小身份模型

给子 run 增加稳定的 `agentId`：首次创建时可直接使用初始 run ID，后续任务继续使用该身份，每轮仍有新的 run ID。这个字段用于区分“同一队友执行下一轮”与“创建另一名队友”，避免继续把每轮任务都算作新成员。

复用现有 run、context、消息和事件存储，暂不建立完整 Team 或任务板服务。最新 run 与职责视图从现有记录派生；旧运行结果保持不可变。

代理可用状态与任务结果分开：已完成 run 对应可接新任务的空闲代理；上轮失败不自动表示可以安全重试。涉及尚未确认的副作用时，必须完成现有恢复流程才能重新执行。

同一 `agentId` 同时只允许一个未结束 run。两个并发续接请求必须在事务中竞争，只有一个成功。重复同一工具调用不得产生两个 run。主任务在同一会话进入后续轮次时，通过受验证的主运行续接关系继续管理旧队友；不能仅凭知道 ID 就取得管理权。

### 6.2 已采用的默认限制

| 限制 | 新会话默认 | 含义 |
|---|---:|---|
| `maxActiveChildren` | 8 | 同时未结束的子任务上限，包含排队、运行和等待；不含主代理 |
| `maxConcurrentModels` | 2 | 全会话正在请求模型的数量，包含主代理；保留当前语义 |
| 现有 `maxChildren` | `null` | 新会话默认不限制历史累计子 run 数；显式配置时继续按旧累计口径计数，包含续接 |

8 和 2 是便于控制变量的起始值，不是已经证明最优的配置。身份存在不占执行名额；开始新建或续接任务时原子预留名额，执行结束后释放。等待中的任务仍占未结束任务名额，因此不可为等待无可运行依赖的任务不断创建队友；已有循环等待检测继续生效。

容量从持久运行、工具调用及有效对账事件派生，创建检查和写入处于同一事务，无需单独维护容易失配的计数器。创建失败回滚；取消请求不立即释放。任务进入终态后，普通 planned 调用、尚在运行的读取及未经对账的 unknown/running 写调用仍占位；写调用在当前执行尝试中被确认 succeeded、failed 或 not_applied 后不再占位，原始历史记录保持不变。中断但尚未结束的任务保留名额。宿主入口、模型入口和批量 explore 共用同一检查，批量超过剩余容量则整体拒绝，不部分派发。

容量与恢复管理共用 `recoveryResolution`，只采用最近一次 `tool.started` 之后的对账事件，旧尝试的结论不能结算新尝试。`not_applied` 的重试许可不代表旧终态运行已重新执行；旧名额释放，真正创建的后续运行单独计数。部分调用完成对账不能释放仍有其他未收敛调用的子任务。

`run`、`chat`、`serve` 支持 `--max-active-children N` 和 `--max-children N|none`。例如 `--max-active-children 8 --max-children none --max-concurrent-models 2` 使用以上默认口径；显式 `--max-children 8` 则仍会在累计创建 8 个子 run 后停止创建，包括续接产生的新 run。

限制返回应说明是活跃任务容量、累计创建限制还是共享预算不足，并给出当前占用者和可行后续动作。容量满时没有任何可释放任务，也不能通过重复调用强行创建。

### 6.3 兼容与上下文规则

- 旧会话缺少新字段时保留累计限制，不在恢复时偷偷改成无限累计。新会话显式提供旧 `maxChildren` 时继续遵循它。
- 现有 `continuation_of` 保持可读取与兼容；旧记录如何映射身份应根据已验证的续接链判断，不能将所有同卡片运行合并成同一个代理。
- 新一轮任务保留工作对话、工具历史、已有压缩摘要及上轮最终回答，但刷新当前目标、主任务版本与有效指令；清除旧待办快照和旧完成检查，新待办从 revision 0 开始；旧报告不自动满足新任务验收。
- 复用要求有效权限和文件范围与前驱一致。发生变化时返回 `FOLLOWUP_CONTEXT_CHANGED`；需要不同卡片或执行范围时，新建并走现有宿主校验。
- 每轮报告、证据和通知绑定 run ID；代理寻址绑定 agentId。结果与消息不会因最新 run 改变而被重复消费或错误归属。
- 工具 Schema 保持稳定，动态容量放在运行状态及工具返回中。模型先前看到“还有名额”不替代执行时的原子检查。

## 7. 实施结果与验收

| 阶段 | 已实现范围 | 验收范围 |
|---|---|---|
| D1：容量语义 | runtime/types、messaging/spawn-spec、所有创建入口、CLI 与检查视图 | 8 个活跃任务时第 9 个被拒；完成后可再创建；取消未完成清理时不释放；并发与批量不超限；旧会话口径保留 |
| D2：队友续接 | 子 run 稳定身份、followup_task、消息/报告寻址、恢复路径 | 同一队友多轮任务；上下文连续但任务验收隔离；重复请求幂等；并发续接互斥；重启恢复；权限与未确认副作用检查 |
| D3：统一委派指导 | context、agent-factors、child-card、卡片与工具说明；因子 B 采用负责人模式 | 提示与工具确实送达，子代理不获得管理能力；负责人组 7 轮仍由主代理执行，默认分工未被采用 |
| D4：行为实验 | 已扩展既有实验运行器与离线指标测试；选择性与负责人策略均完成小样本实测 | 显式创建和复用正控制通过；未观察到自主采用，不将未产生协作的耗时波动归为协作收益 |

本轮新增 D5 两阶段执行合同，验收与 D1—D4 的既有结果分开：规划只记录步骤和执行方；选择代理阶段后仍显示 `awaiting_dispatch`；派发、续接和批量调查关联真实子 run；没有真实完成结果或仍有未结算工作时不能接受委派待办；主代理原生写入及进程入口遵循选中阶段；未完成委派项阻止最终成功；结算后可重规划；B 关闭时旧待办仍可使用。实际检查结果以本轮验证输出为准，本节不预填通过结论。

本期不做完整共享任务板、任意深度的委派树、自动选择模型的路由器或每轮评估委派的额外模型调用。它们不是解决当前问题的必要条件。

实现入口：容量在 `src/messaging/spawn-spec.ts`；队友身份及工作上下文在 `src/messaging/agent-lifecycle.ts`；续接事务与幂等事件在 `src/messaging/index.ts`；历史管理关系在 `src/runtime/history.ts`。CLI、存储兼容层及 Web 协作视图使用同一容量口径。

新增 `tests/agent-followup.test.ts` 覆盖容量释放、显式累计限制、上下文与最终回答延续、独立任务结果、待办刷新、嵌套项目指令、忙碌队友、幂等重试、取消结算、批量容量、输入槽、重启及主任务续接。脚本模型还覆盖“待办 → 创建 → 等待 → 复用 → 等待 → 完成”的完整调用链；它证明机制可用，不代表真实模型已经会自行选择这些动作。

实验运行器保留旧指标口径，新增 `followupCalls`、`successfulFollowupCalls`、`childRuns`、`distinctChildAgents`、`followupRuns`、`reusedChildAgents`，按实际运行去重；固定团队收益组隐藏 `followup_task`。

[此前真实验收](experiments/agent-delegation-real-acceptance-20261028.md)使用旧选择性委派策略：默认策略的 7 轮真实任务没有调用 `spawn_agent`、`explore` 或 `followup_task`；显式正控制证明创建与复用机制可用。该报告中的“新指导”指当时的先规划、按需委派提示，不是负责人模式。保留原报告、标签与数据，不把原结果归到新提示。

[负责人模式复测](experiments/agent-delegation-team-lead-retest-20261028.md)确认负责人身份、默认串行委派指导及相关工具均已加载，但 `deepseek-v4.1-flash` 的 7 轮实质任务依然没有自主创建、续接或待办调用。显式正控制的 8 项检查通过；两次自然追问前没有既有队友，未构成自主复用选择的有效检验。调查组每组仅两次且均无协作，时长和 token 下降不构成协作收益。复测另确认终态写调用对账后的容量释放缺陷；默认任务开始时没有子任务占位，因此该缺陷不能解释零采用。

复测后的容量修复按第 6.2 节读取有效对账事件，补充通过公开宿主入口 `Application.resolveCall` 的隔离合成状态回归，覆盖重新创建、续接、成员可用性、部分结算、执行尝试边界及存储重开。合成状态不执行模型、真实写工具或进程。历史复测报告中的缺陷结果保留，用于记录修复前版本；该修复不改变负责人提示，也不代表自主采用问题已解决。

负责人模式调整前，在 Windows / Node 24.13.0 完成 `npm run check`、`npm run build`；相关回归 19 文件 221 项通过，CLI 容量参数专项 1 项通过，实验指标离线测试 9 项通过。以上为此前实现的验证记录，不覆盖新的负责人策略，也不是全仓测试结论；macOS/Linux 本轮未实机验证。

## 8. 如何证明“能自行创建，而且判断合理”

确定性测试只能证明工具和生命周期可用，不能证明真实模型会作出合适选择。采用实验的用户任务不出现“请创建代理”“请并行”等诱导词，也不预先创建固定团队。

| 任务类型 | 要观察的行为 |
|---|---|
| 简短的已知事实问答 | 能直接回答，不为问答创建无必要的队友 |
| 已知位置的小修改 | 委派一个明确任务，优先复用合适队友，不为每一步拆出新代理 |
| 多个独立模块的调查 | 是否自主拆出有明确结果的调查任务 |
| 契约确定且写范围分离的实现 | 是否异步派发，主代理继续调度、解决跨任务问题及核验 |
| 高度耦合、契约尚未确定的修改 | 是否先明确契约，再由同一队友串行调查与实现，避免提前并行写入 |
| 同一模块的后续问题 | 是否选择原队友，减少重复调查 |
| 新主题或独立审查 | 是否选择独立上下文，而非无条件复用 |
| 前 8 个子任务已经结束 | 能续接旧队友或新建不同队友，不受默认累计上限阻塞 |
| 用户明确要求不委派，或委派被权限／容量阻塞 | 遵从用户指令；如受阻明确报告原因，不静默接管大块实现 |

实验先冻结代码、模型、任务、权限、容量、压缩和组装设置，再比较旧指导与新指导。新旧指导使用同一个已完成生命周期改造的版本，避免把提示收益与续接能力混在一起。历史 A/B/C 结果保留原标签和实现，不追溯改写。

记录：交付验收、首次有效源码修改时间、首次委派时点、派发/复用数量、实际并行区间、重复调查、失败工具调用、主输入峰值、未缓存输入、输出、完整会话 token、费用和端到端时长。对子任务边界和复用选择采用预先约定的任务标准复核。主代理直接完成适合直接执行的任务不算失败；自主采用、成功交付和协作收益分别统计。

真实模型比较须多次重复、交错执行顺序并报告波动。固定团队收益实验与自主采用实验分开。动态组装在两组中保持相同设置；容量和提示改动没有真实结果之前不宣称提高了委派率或节省了成本。

## 9. 来源

- [DeepSeek Team 模型提示与工具](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/experimental/tool-agent-team/src/index.ts)：teamPolicy、身份注入与 spawn_teammate 执行路径。
- [DeepSeek 普通子代理工具](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/subagent/tool-subagent/src/index.ts)：providerWording 与异步协作说明。
- [DeepSeek todo 工具](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/todo/tool-todo/src/index.ts)：多步骤任务开始前列清单、全量替换、并行进行中项的部署选项。
- [DeepSeek Team 配置包](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/experimental/agent-team-profile/cordis.patch.yml)：关闭普通委派工具并设置 maxMembers=8。
- [DeepSeek Team 文档](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/experimental/agent-team/README.md)：服务默认值、持久成员和消息唤醒语义。
- [Codex followup_task](https://github.com/openai/codex/blob/c0e88f3c04219aaa032aaf4b20a8c3284cc81449/codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs)：任务消息明确触发新轮次；与普通消息区分的参考。
- Kodo 当前实现：`src/messaging/index.ts`、`src/messaging/spawn-spec.ts`、`src/messaging/explore.ts`、`src/runtime/context.ts`、`src/runtime/agent-factors.ts`、`src/agents/child-card.ts`。
