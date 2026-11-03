# Agent 委派机制对照与 Kodo 零采用分析

核对日期：2026-10-28。范围：公开源码、官方文档、Kodo 实际模型请求与两轮验收记录。本次没有修改运行时代码，没有运行真实模型实验。

结论：DeepSeek Harness、Claude Code、OpenCode 都通过模型可见的角色描述、工具说明和上下文引导模型发起委派，再由宿主执行创建与调度。不能从“有团队工具”推出“普通任务必然自动分工”。Kodo 本批零采用发生在模型选择工具的阶段，尚无证据将其归因于容量、创建失败或提示未加载。调用准备成本与角色呈现存在可改进之处，但它们对零采用的因果贡献尚未实测。

## 1. 来源与版本

| 对象 | 本次依据 | 证据边界 |
|---|---|---|
| DeepSeek Harness | 官方提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` | 缓存 API tree 与 22 份源码的 Git blob 摘要匹配；普通 subagent 与 experimental Team 分别分析 |
| OpenCode | 项目此前实验所用 v1.19.3，官方提交 `e3c4eb242585dcd77be1a867391b7c25fd47ce52` | 在线核对标签及关键源码，非最新 HEAD；不同版本可能改变默认异步行为和提示 |
| Claude Code | 本日获取的官方 [subagents 文档](https://code.claude.com/docs/en/sub-agents)、[agent teams 文档](https://code.claude.com/docs/en/agent-teams) | 说明公开产品行为，不声称核对了当前发行版内部调度实现。仓库中的 `claude-code-main/` 仅有 src，没有足以确认官方来源和版本的元数据，本次未将其作为官方源码证据 |
| Kodo | 当前源码，以及 [选择性指导验收](experiments/agent-delegation-real-acceptance-20261028.md)、[负责人模式复测](experiments/agent-delegation-team-lead-retest-20261028.md) | 实测仅代表该网关下 `deepseek-v4.1-flash` 的这些任务；未用同一配置对三个竞品做自主采用对照 |

Claude 官方文档为可变页面，不能把当前描述追溯到旧版本。例如当前文档对后台执行、SendMessage 续接有专门版本说明；本报告只采用本次实际读取的内容。

## 2. DeepSeek Harness

### 2.1 普通 subagent：自然语言任务与上下文隔离

普通工具的决策说明直接强调收益：

> offload focused, independent work … so it does not consume this conversation's context.

`subagent` 用于聚焦的研究、限定实现和分析；`subagent_fork` 用于需要当前会话背景的后续分析、审阅和继续处理。两者基本必填字段为 `description`、`prompt`，无需先创建契约 artifact 或 todo。fresh 任务描述要自足；fork 继承已经完成的轮次，不包含当前尚在进行的轮次，描述只需说明新增任务。

执行链是模型发出工具调用，工具选择对应 provider，再进入 `startActivation`。启动到初始消息接收后返回 ID，子代理后台工作，结果通过通知返回。共同指导要求独立委派可同一响应发起，主代理继续有用工作，只剩等待时结束当前轮次。工具注册取决于 provider、scope 和深度等配置，不根据用户任务的复杂度评分自动创建代理。

证据：[工具说明、参数与 provider](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/subagent/tool-subagent/src/index.ts#L117)、[可见性与共同指导](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/subagent/tool-subagent/src/index.ts#L335)、[后台启动](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/subagent/subagent/src/manager.ts#L373)。

### 2.2 Experimental Team：持久成员、消息和共享任务

Team 给主代理注入 `You are the Team Lead named "lead".`，创建工具说明是：

> Create one named, durable teammate. Only the Team Lead may call this tool.

`spawn_teammate` 必填 `name`、`description`、`prompt`，可选 `context: fresh|fork`，默认 fresh。调用后进入 `spawnTeammate → roster.spawn → startActivation`；宿主检查主代理身份、成员名字和数量，然后启动后台成员。普通 `send_message` 可启动或恢复 inactive 队友，因而持久成员可继续处理后续任务。

Team policy 主要规定工作范围、依赖、等待和通信，没有额外的任务评分器，也没有要求所有实质工作必须交给队友。其说明明确写着 `Task readiness never starts an owner`，任务就绪本身不会启动负责人；同时要求 Lead 检查最终 diff 并运行测试。基础 shell、文件和搜索工具仍在主代理手中。

尤其需要区分配置：Team overlay 关闭普通 `subagent/subagent_fork/control`，不能把普通工具的强上下文收益说明当成 Team 同时拥有的提示。官方 Team 示例显式要求 `Use Agent Teams to split this task...`，它是显式使用示例，不是自主采用率证据。

证据：[Team policy](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/experimental/tool-agent-team/src/index.ts#L34)、[身份与创建 Schema](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/experimental/tool-agent-team/src/index.ts#L173)、[创建实现](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/experimental/agent-team/src/roster.ts#L229)、[overlay](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/experimental/agent-team-profile/cordis.patch.yml#L4)、[官方示例](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/experimental/agent-team-profile/README.md#L28)。

普通 todo 确实要求多步骤任务开始前列出步骤；但其执行只更新清单，不调用创建入口。Team 共享任务板又是另一套能力。由此不能推出“先 todo 就会自动派工”。[todo 源码](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/todo/tool-todo/src/index.ts#L45)。

## 3. Claude Code

### 3.1 普通子代理

官方明确说明，Claude 根据用户请求、子代理的 `description` 和当前上下文选择是否委派；配置中的 description 用于“何时使用”，子代理自己的系统提示用于“如何完成”。官方建议在适用角色的 description 中写 `use proactively`。内置 Explore 面向代码库查找和理解，general-purpose 面向既要调查又要执行、多步骤且有关联的任务。

每个子代理拥有独立上下文与受限工具集合。前台执行阻塞主会话，后台执行允许主会话继续，完成后通知。当前文档说明，通用或自定义子代理完成后可由 `SendMessage` 向其 ID 或名字提交后续工作，保留会话历史；内置 Explore/Plan 是一次性任务，不应当作任意可续接成员使用。

这些公开接口降低了重复使用固定角色的成本，但官方没有给出“任意模型在任意任务上必然自主委派”的保证。它也不能证明换用 DeepSeek 后会复制 Claude 的工具选择行为。

证据：[自动委派依据](https://code.claude.com/docs/en/sub-agents#work-with-subagents)、[内置角色](https://code.claude.com/docs/en/sub-agents#built-in-subagents)、[前后台](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)、[续接](https://code.claude.com/docs/en/sub-agents#resume-subagents)。

### 3.2 Agent Teams

Team 为实验能力，默认关闭；启用后由 lead 创建并协调各自拥有上下文的成员，使用共享任务与消息。当前官方文档还区分交互会话与非交互/SDK 行为，不能把所有入口当成同一种 Team 调度。

官方文档直接承认：

> Sometimes the lead starts implementing tasks itself instead of waiting for teammates.

因此，负责人自行实现并非只有 Kodo 才会出现。文档建议提醒它等待队友；这进一步说明团队分工仍有模型选择成分。不能用“Claude Code 有 Team”推导它默认彻底禁用负责人编码能力。

证据：[Team 启用与入口](https://code.claude.com/docs/en/agent-teams#enable-agent-teams)、[负责人自行实现](https://code.claude.com/docs/en/agent-teams#wait-for-teammates-to-finish)。

## 4. OpenCode v1.19.3

OpenCode 的 Task 工具说明直接列出当前可调用的成员 `name: description`。通用 `general` 子代理可以研究和实现；`explore` 有单独的搜索角色提示。模型在选择 Task 时就能看到角色用途，无需先查询目录。

Task 必填字段为 `description`、`prompt`、`subagent_type`；可以在自然语言 prompt 中交代目标、约束和验证。没有必填契约 artifact、结构化 report 或 todo 前置检查。默认同步返回子会话最终文本；只有开启实验性后台子代理选项时，才暴露 `background` 参数。复用通过 `task_id` 继续同一个子 session，保留已有对话。

主代理仍拥有读、写、命令、搜索等工具。普通委派由模型选择；用户 `@general` 的路径会增加“调用 task”的明确指令，不能混入无诱导自主委派统计。todo 只持久化会话内清单，Task 不读取它，也不存在一个 todo 自动对应一个 agent 的绑定。

另一个重要区别是按模型选择提示。对于常规 DeepSeek provider 和 `deepseek-v4.1-flash`，该版本会落入 `PROMPT_DEFAULT`，其中明确建议文件搜索优先用 Task 以减少上下文消耗。Claude 专用 `anthropic.txt` 有更强的探索委派和 todo 指导，不能将其归到 DeepSeek 的默认请求；自定义 `agent.prompt` 还会覆盖模型默认提示。

证据：[Task 描述](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/tool/task.txt#L1)、[角色嵌入工具说明](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/tool/registry.ts#L265)、[参数和调用链](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/tool/task.ts#L43)、[内置 general/explore](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/agent/agent.ts#L182)、[模型提示路由](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/system.ts#L28)、[DeepSeek 默认提示](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/prompt/default.txt#L70)、[显式 agent 引用](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/prompt.ts#L974)。

## 5. Kodo 当前失败在哪一层

委派链条应分为：模型看到说明 → 选择并发出调用 → 宿主准入 → 子代理执行 → 结果消费与续接。当前两批默认任务都停在第二步之前；显式正控制则跑通了后续链条。

### 已确认的事实

1. **实际请求存在新提示和工具。** 负责人组的持久化请求包含 team lead、实质执行默认委派及串行委派要求，`spawn_agent`、`explore`、`followup_task`、todo 均可见。不能继续用“可能还是旧提示”解释本批结果。
2. **模型没有尝试委派。** 默认组创建、探索、续接均为零，目录/路由也没有带来创建尝试；因此不是填错 slots 后创建失败。例：负责人调查 1 共记录 31 次主代理 list/search/read 调用，全部自行执行，没有进入派发链。
3. **初始容量可用。** 这些任务开始时没有子运行占位。终态对账的容量释放缺陷是真实问题，已另行修复，但不能解释第一位队友都未创建。
4. **负责人模式只是提示。** `src/runtime/step-host.ts:35` 仍合并普通工具与协作工具；`src/runtime/agent-factors.ts` 改文本，不改变执行角色。主代理可以持续直接读写，宿主不会据负责人提示拒绝这条路径。
5. **同一模型也未采用 todo 指导。** 负责人复测的 7 轮实质任务中 todo 调用为零。问题涉及默认工作方式的采用，不只某个创建 API 的名称。

证据：[复测报告](experiments/agent-delegation-team-lead-retest-20261028.md)、[请求核对](../.kodo/delegation-retest-20261028-r2/request-and-source-audit.json)、[负责人调查实际请求](../.kodo/delegation-retest-20261028-r2/survey-default-1/wire/request-1.json)、[工具调用记录](../.kodo/delegation-retest-20261028-r2/survey-default-1/turn-initial.json)。

### 具体实现差异，以及不能越过的推断边界

| Kodo 事实 | 可能影响 | 尚不能断言 |
|---|---|---|
| 名册 `routing()` 展示角色、用途和 mode，没有必填 inputs 或最小调用例；spawn 的 slots 只说明按卡片填写 | 看到成员名字后仍需查契约，不能像一个熟悉的普通工具直接填参 | 不能断言模型一定因怕填错而放弃 |
| implementer 要求 requirement、contract artifact、显式写范围；tester 要求 behavior_contract artifact；有报告契约的卡要求 report.submit | 专家工作流的前置交接比 DeepSeek 普通工具/OpenCode general 多 | Kodo 通用 spawn 的 Schema 仍只必填 objective，不能说所有创建都必须先写 artifact |
| 因子 C 工具说明重点介绍成员 slots、tester artifact、写范围，未突出“省略角色即可用通用队友”的最短路径 | 已存在的简单路径不够显眼，模型容易只看到专用卡片协议 | 不能据此解释只读 explore 也零调用；explore 本身已经提供简单示例 |
| spawn 异步，通常还需等待与检查结果；explore 提供同步便捷路径 | 对很短任务，直接执行需要的交互更少 | DeepSeek 同样异步；异步本身不是零委派根因 |
| 当前 B 明确要求默认委派，比所核对的 DeepSeek Team/OpenCode DeepSeek 默认提示更强 | 继续追加“主动”“必须”文字的收益缺乏证据 | 不能由此判定模型普遍不能委派，显式控制已经成功 |

名册及契约证据：`src/runtime/roster-context.ts:11`、`src/agents/presets.ts:31`、`src/agents/presets.ts:50`、`src/agents/contracts.ts:9`、`src/messaging/index.ts:78`、`src/messaging/index.ts:323`、`src/messaging/spawn-spec.ts:14`。

首个负责人调查请求实际有 29 个工具，序列化工具定义为 28,737 字节，两个 system 消息分别为 4,123 和 1,622 字节。这说明委派规则处在多种能力说明中，但字节数本身不证明提示被忽略，也不是计费 token。关于模型训练偏好、网关处理多个 system 消息或注意力分配，目前没有足以确认因果的证据。

## 6. 对当前产品目标的建议

用户目标已经明确：主代理理解和指挥，实质执行主要交给子代理。它比三个产品的“可自主使用子代理”更强，不应仅通过复制其提示来期待相同的职责保证。

优先减少已有入口的交接障碍：突出通用 spawn 的最小调用，名册显示必要输入及简短调用例；简单限定任务可用自然语言契约，跨模块并行任务再使用结构化契约。复用继续使用当前稳定身份和 followup_task，不需要为此新增团队服务、评分器或第二套 todo。

然后区分两种验证，不能混记为同一种成功：

- **模型自主采用实验**：保持主工具不变，只简化委派入口；同一网关、模型、任务下检查是否开始委派，并比较另一个模型。记录所有失败和成本，不以显式要求创建的控制组代替自主采用。
- **负责人职责实现**：若要求稳定做到主调度、子执行，应把执行职责落实到宿主提供的工具入口。保留主代理必要的项目理解、证据检查和调度能力，常规修改与测试交给执行代理；用户明确不委派和少量整合例外需要有清晰语义。该方案是产品工作流设计，不是已经证明竞品使用的统一机制，也不能标作“模型自发决定”。

当前最有把握的诊断是：工具生命周期已可用，默认工作方式没有被模型采用；角色约定没有宿主执行约束，专用卡片交接又比通用任务工具更重。哪项调整能改善 `deepseek-v4.1-flash` 的自主采用，仍需隔离变量验证。本报告不把源码差异写成已证实的模型心理原因。
