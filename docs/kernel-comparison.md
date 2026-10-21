# Kodo 内核参考：OpenCode、Claude Code、Pi 与 Codex

调研日期：2026-10-19（Asia/Shanghai）。

2026-10-20 的真实失败取证、固定版本 Pi／OpenCode 运行对照及适用边界，见[真实任务失败分析与 harness 对照](harness-comparison.md)。下文仍是原日期的静态调研，版本与本轮实测分别记录。

最新的模型调用次数、工具调用次数、token 与耗时实测见[256k token 目标窗口任务效率比较](harness-comparison-256k.md)：12 次固定验收通过 10 次，包含失败成本和 HTTP 429=0 的计量口径。

范围：读取官方仓库源码、仓库内文档和产品官方文档，比较执行、上下文、工具、通信与恢复设计。本次没有构建或运行这些产品，没有做性能、成本或正确性排名。

## 1. 结论与证据边界

四者的共同基础是模型与工具反复交互的执行循环。工程上的主要差异在于：如何接收新输入、组装上下文、推进工具调用、保存状态、处理权限，以及管理多个执行者。不能把“支持多 Agent”“有 MCP”“可共享配置”本身当成 Kodo 的独有优势。

| 产品 | 本次证据 | 最值得 Kodo 学习的边界 |
| --- | --- | --- |
| OpenCode | 默认开发分支源码及官方服务文档 | 会话协调器、单步执行、持久输入与客户端接口 |
| Claude Code | 官方架构、子 Agent、Agent Teams、沙箱与检查点文档；检查公开仓库目录 | 渐进加载、协作产品语义、权限与回退边界 |
| Pi | 默认分支源码及仓库内文档 | 模型适配、通用 Agent 循环、编码会话分层；上下文转换接口 |
| Codex | 开源 Rust 核心、工具执行与多 Agent 模块，以及官方 App Server 文档 | 会话／轮次／事件、工具审批与执行隔离、多 Agent 生命周期 |

本次固定的源码快照：

| 仓库入口 | 分支 | 提交 |
| --- | --- | --- |
| `anomalyco/opencode` | `dev` | `a15de38eef8e643ca43c1059408a2566b402a595` |
| `badlogic/pi-mono` | `main` | `d2e7d8b7c1d31d3661f769d5caef7ba8d50c3e03` |
| `openai/codex` | `main` | `4e7b9e285ba4ac6ce18ca452cf9e88d3d75ec857` |
| `anthropics/claude-code` | `main` | `ef7bfdca55d906929fe6b782025b93758c325074` |

这些是调研时的默认分支快照，不代表全部功能已经进入稳定发行版。官方网页可能继续更新。Claude Code 公开仓库本次未提供可供审阅的完整产品执行循环，因此不推断其私有函数、调度框架或完整数据库结构。其文档公开的行为可以作为产品契约参考，不能替代源码证明。

## 2. OpenCode：围绕会话组织执行

### 2.1 已确认的结构

当前源码入口位于 `packages/core`，不是许多旧文章使用的 `packages/opencode/src/session/processor.ts` 路径。

```text
客户端：TUI／其他界面
  → 服务接口
  → SessionExecution / SessionRunCoordinator
  → SessionRunner：消化输入并安排逻辑步骤
  → SessionStep：一次模型请求、工具执行与结果收尾
  → @opencode/ai 的 LLMClient、工具运行时与事件存储
```

- `SessionRunCoordinator` 按键串行推进，不同键可以并发。同一会话忙碌时，新的唤醒请求通过 `pendingWake` 保留；结束清理阶段仍有唤醒时，安排后续执行，避免退出边界丢工作。[O1]
- `SessionRunner` 负责步骤策略、收件箱输入、压缩和重试安排；`SessionStep` 负责一次尝试的流式响应、工具任务、取消与持久结果收尾。代码显式区分完成、重试、压缩、输出长度限制等结果。[O2][O3]
- 当前步骤代码使用 Effect 的 Fiber、Scope 与取消机制；关键终结记录通过不可中断区完成。模型和工具执行的可取消部分，与记录最终状态的部分分开。[O3]
- 会话、消息、输入等结构有 SQLite 表定义。事件总线的持久模式在事务内处理事件与投影；不能把 UI 收到文本流等同于状态已经可靠保存。[O4][O5]
- 官方服务文档描述 HTTP／OpenAPI 服务与客户端关系，TUI 与服务分开，支持无界面服务。[O6]

### 2.2 子 Agent 与上下文

`subagent` 工具创建带 `parentID` 的子会话，解析 Agent 与模型配置，并通过标准会话输入机制启动或继续子会话。它支持前台等待与后台立即返回，后台完成后通知；运行有错误或取消时返回明确状态。[O7]

源码把压缩放在独立的会话模块，执行器按条件触发；对超长请求、流中断和未收尾工具有专门处理，而非仅把历史消息截成最后若干条。[O2][O3]

### 2.3 对 Kodo 的启示

采用“调度器只决定谁运行，执行步骤只处理这一轮”的边界。特别要验证结束与新消息到达同时发生的情况。持久输入是事实，内存唤醒只是通知。

不直接复制完整 Effect 服务体系、跨位置迁移和事件投影机制。Kodo 首版用单进程协调器、短事务和类型化步骤结果即可；是否引入 Effect 应由团队熟悉程度与实际取消复杂度决定。

## 3. Claude Code：公开行为强调上下文与协作

### 3.1 执行与上下文

官方将基本循环描述为获取上下文、执行动作、验证结果，三个动作按任务动态交替，不是必须逐一经过的固定状态机。工具结果返回模型，影响下一步选择。[C1]

官方文档确认：

- 会话消息、工具使用与结果保存为本地 JSONL，可用于恢复、分支等操作。
- 接近上下文限制时，先清理较早工具输出，必要时总结对话；细节可能丢失，持久规则需要单独保存。
- Skill 描述与正文分开，正文按需加载；MCP 工具定义可通过工具搜索延迟加载。
- 普通子 Agent 使用独立上下文，返回摘要；fork 模式可以复制已有对话，应与默认的新上下文区分。[C1][C2]

### 3.2 子 Agent 与 Agent Teams 要分开看

子 Agent 文档提供自定义职责、工具、模型、权限、Skills 和 MCP 等配置。具体字段是否生效与加载方式有关，例如当前文档明确列出插件分发的 Agent 某些 frontmatter 字段不生效，不能假设插件包内所有设置原样执行。[C2]

当前文档也描述了具名子 Agent 之间发送消息、恢复子 Agent、嵌套深度和并发限制。因此不能继续沿用“Claude 子 Agent 只能向父级返回结果，不能彼此通信或嵌套”的旧结论。具体功能需核对发行版本与设置。[C2]

Agent Teams 则公开了更接近部门协作的结构：[C3]

```text
Lead：组织工作与综合结果
Teammates：独立上下文的执行者
Task list：共享任务及依赖
Mailbox：成员之间的消息
```

其官方文档写明邮箱为本地 JSON 文件，发送成功以写入成功为前提，任务领取使用文件锁避免竞争；成员不自动继承主会话全部对话，需要在委派时提供任务信息。

Agent Teams 当前标为实验性、默认关闭。文档列出的限制包括进程内成员无法由普通会话恢复完整恢复、任务状态可能滞后、关闭有延迟等。不要将它等同于已验证的持久任务引擎，也不能忽略它已经覆盖的直接协作能力。[C3]

### 3.3 权限、沙箱与回退

权限决定某动作能否执行；操作系统沙箱限制执行过程中实际能访问什么。官方 Bash 沙箱文档指出，它覆盖 shell 命令及其子进程，不覆盖全部文件工具、MCP 服务和 hooks；平台支持也有区别。[C4]

检查点能恢复受跟踪的编辑，但不能恢复所有 Bash 改动、其他执行者的全部修改或远程系统副作用。对话恢复、文件恢复、外部动作撤销是三个不同问题。[C5]

### 3.4 对 Kodo 的启示

直接通信、主 Agent 统筹和独立上下文已经有成熟产品参考。Kodo 应把精力投入更容易复用的 Agent 能力包、清晰的配置缺口，以及带案例证据的版本改进。

借鉴渐进加载和输入分层，同时让通信、等待、任务决定版本与结果验收明确落在运行时。不要复制“实验性协作已经解决所有恢复问题”的假设。

## 4. Pi：通用 Agent 循环与编码会话分层

### 4.1 已确认的分层

```text
模型适配层：packages/ai
  → 通用循环与 Agent 状态：packages/agent
  → 编码会话、资源、压缩、持久化：packages/coding-agent
  → TUI / print / JSON / RPC / SDK
```

当前读取到的包名是 `@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core`，并非应从旧文章照搬的历史包名。安装前仍须确认所选发行版及兼容性。[P1]

通用循环中可以直接看到：[P2]

- 内层循环处理模型响应、工具调用与中途补充输入；外层在当前工作结束后处理后续消息。
- `transformContext` 先裁剪、补充内部消息；`convertToLlm` 再转换为模型协议消息。这两个职责明确分开。
- 模型调用、消息、工具执行通过事件输出，界面可以独立订阅。
- 提供工具执行前后接口、参数校验、取消及顺序／并行执行分支。当前代码不能概括为“所有工具永远串行”。

### 4.2 持久化与扩展

Pi 的会话存储为 JSONL 树，每项有 ID 与父项，当前分支用于构造模型输入。压缩生成摘要项，原历史仍保留；界面分支操作不等于外部文件自动回滚。[P3]

扩展作为 TypeScript 模块加载到进程，可以注册工具、事件处理等。仓库提供子 Agent 扩展示例：启动独立 `pi` 进程，用 Markdown 定义职责，支持单任务、并行和链式执行。这个示例证明其扩展路径，不应被描述成已经内置完整的部门通信调度系统。[P4]

当前仓库已提供 MCP 文档与实现，支持 stdio 与 Streamable HTTP。因此“Pi 不支持 MCP”不适用于本次源码快照。[P5]

官方安全文档明确：项目信任控制资源加载，不等于执行隔离；启用工具和进程内扩展具有宿主用户权限。需要实际隔离时依赖容器、虚拟机或操作系统边界。[P6]

### 4.3 对 Kodo 的启示

Pi 最值得借鉴的是执行循环的清晰边界，而不只是“代码少”。Kodo 应分开内部状态、模型可见上下文与供应商消息格式。

可优先验证复用其模型适配库是否满足协议保真、取消、usage 和工具请求关联。是否复用整个 Agent 循环，要额外验证：能否在副作用前持久化、持久等待后恢复、由 Kodo 独占预算和调度权。不要同时让 Pi 会话层与 Kodo 各自掌握重试、历史、工具执行及恢复。

## 5. Codex：执行核心与客户端协议分开

### 5.1 会话、轮次与事件

公开源码的执行核心是 Rust。当前采样循环入口在 `core/src/session/turn.rs`，不应根据旧文章假设仍全部位于 `core/src/codex.rs`。[X1]

官方 App Server 对外定义：[X2]

- `Thread`：持续会话。
- `Turn`：一次用户输入及随后的执行。
- `Item`：用户消息、模型消息、工具调用、命令或文件变化等单元。
- `turn/steer`：给正在执行的轮次补充输入。
- `turn/interrupt`：中断执行；客户端通过事件读取进展和终态。

App Server 提供双向 JSON-RPC 风格协议，支持 stdio 等传输；部分传输和接口仍带实验性限制。这里借鉴的是稳定的应用边界，不推断所有客户端在所有版本都采用完全相同部署拓扑。

### 5.2 执行与工具

`run_turn` 组织输入、采样、上下文压缩、继续执行与结束检查。工具层另有 `ToolRouter`／注册表和 `ToolOrchestrator`：[X1][X3][X4]

```text
模型产生工具请求
  → Router：解析并找到注册工具
  → 对需要受控执行的工具进行审批与沙箱编排
  → 工具运行时执行
  → 记录结果并继续模型轮次
```

`ToolOrchestrator` 明确负责审批、沙箱选择与沙箱拒绝后的重试处理；扩大执行权限不能被当成普通网络重试。工具注册表还区分哪些调用支持并行。[X3][X4]

平台沙箱实现与模型提示词分离。Kodo 不必首版照搬所有平台后端，但必须区分“模型看不到工具”“执行入口拒绝调用”和“操作系统隔离”。

### 5.3 多 Agent 与保存

源码已把 Agent 创建、配置、消息、等待与生命周期处理拆入 `agent/control`。其中 `mailbox.rs` 保留本地会话卸载期间的待处理消息，`residency.rs` 管理常驻子会话与空闲卸载。[X5][X6]

需要特别区分：这里读取的邮箱实现使用内存结构；能够跨运行实例卸载保留，不等于这段代码单独保证进程崩溃后的消息持久性。不能仅凭“mailbox”名字就宣称它是持久消息队列。

历史记录有 JSONL rollout 保存实现，同时使用 SQLite 保存和查询线程状态等信息。恢复会话不代表自动撤销或安全重放全部外部操作。[X7][X8]

### 5.4 对 Kodo 的启示

参考 Thread／Turn／Item 的分层，在 Kodo 中固定 Session／Run／Call／Event 的含义。对话、一次任务执行、某次工具调用不能混用同一个状态。

借鉴工具路由与受控执行分离、空闲执行者不占推理资源、界面通过统一命令与事件交互。首版不需要照搬 Codex 的全部 Rust workspace、远程执行、复杂驻留管理与审批体系。

## 6. 对 Kodo 方案的具体取舍

保留现有 TypeScript／Node.js 单进程、SQLite、独立上下文与统一执行循环方案。此次调研没有提供必须改成 Rust、多进程 Agent 或完整事件溯源架构的证据。

| 方面 | Kodo 首版选择 | 依据与边界 |
| --- | --- | --- |
| 调度 | 同一 Run 单推进者，不同 Run 限额并发 | 参考 OpenCode 的会话协调，不把每条消息启动成新循环 |
| 执行步骤 | 一轮模型调用与工具结果收尾有明确出口 | 参考 Pi／OpenCode，调度策略不混入工具函数 |
| 新输入 | 区分当前任务补充、后续任务、取消／撤权 | 参考 Pi 的 steering／follow-up 和 Codex 的 steer／interrupt；具体优先级由 Kodo 明确 |
| 上下文 | 内部记录 → 本轮必要上下文 → 供应商消息 | 参考 Pi，保留原始证据与协议专有字段，不能只保留拼接文本 |
| 工具 | 统一入口校验、记录、执行；首版顺序调用 | 参考 Codex 的职责分离，后续按实际冲突与收益开放并行 |
| 通信 | SQLite 收件箱与等待条件，同事务协调唤醒 | Kodo 自身选择；不声称四款产品采用相同实现 |
| Agent 生命周期 | 定义、执行、常驻资源分开 | 已保存多少卡片不决定要启动多少 Agent；等待不调用模型 |
| 恢复 | 区分可重试读取与结果未知的写入 | 不把会话恢复、文件检查点和外部副作用撤销混为一谈 |
| 界面 | 先稳定应用命令与事件，后增加 HTTP | 参考 OpenCode／Codex 的边界，不在首版提前做远程服务 |
| 差异化 | 能力包就绪检查、真实方法复用、带证据的版本改进 | 直接通信与多 Agent 已有参考，优势仍要以可比任务验证 |

实现前优先验证四个条件：

1. 模型返回的工具请求与结果在流中断、取消、重试后仍正确关联。
2. 答复先到与等待先登记两种顺序都不会丢唤醒；结束清理阶段的新输入不会丢失。
3. 工具已产生写入但结果未保存时，重启不会盲目重放。
4. 一个 Agent 等待同伴时可以释放资源，用户输入与取消仍能及时处理。

这些检查通过后再增加能力包与 UI。若评估 Pi 复用，应比较“仅模型适配”与“复用 Agent 循环”两种小原型，以取消、持久化和调度控制权作为选择依据；本次研究尚未验证兼容性，不直接更换依赖选型。

## 7. 官方来源与源码入口

以下源码链接固定到本次读取的提交；官方产品网页为调研当日内容。

[O1]: https://github.com/anomalyco/opencode/blob/a15de38eef8e643ca43c1059408a2566b402a595/packages/core/src/session/run-coordinator.ts
[O2]: https://github.com/anomalyco/opencode/blob/a15de38eef8e643ca43c1059408a2566b402a595/packages/core/src/session/runner/llm.ts
[O3]: https://github.com/anomalyco/opencode/blob/a15de38eef8e643ca43c1059408a2566b402a595/packages/core/src/session/runner/step.ts
[O4]: https://github.com/anomalyco/opencode/blob/a15de38eef8e643ca43c1059408a2566b402a595/packages/core/src/session/sql.ts
[O5]: https://github.com/anomalyco/opencode/blob/a15de38eef8e643ca43c1059408a2566b402a595/packages/core/src/bus.ts
[O6]: https://opencode.ai/docs/server/
[O7]: https://github.com/anomalyco/opencode/blob/a15de38eef8e643ca43c1059408a2566b402a595/packages/core/src/tool/plugin/subagent.ts
[C1]: https://code.claude.com/docs/en/how-claude-code-works
[C2]: https://code.claude.com/docs/en/sub-agents
[C3]: https://code.claude.com/docs/en/agent-teams
[C4]: https://code.claude.com/docs/en/sandboxing
[C5]: https://code.claude.com/docs/en/checkpointing
[P1]: https://github.com/badlogic/pi-mono/blob/d2e7d8b7c1d31d3661f769d5caef7ba8d50c3e03/packages/agent/README.md
[P2]: https://github.com/badlogic/pi-mono/blob/d2e7d8b7c1d31d3661f769d5caef7ba8d50c3e03/packages/agent/src/agent-loop.ts
[P3]: https://github.com/badlogic/pi-mono/blob/d2e7d8b7c1d31d3661f769d5caef7ba8d50c3e03/packages/coding-agent/docs/how-pi-works.md
[P4]: https://github.com/badlogic/pi-mono/blob/d2e7d8b7c1d31d3661f769d5caef7ba8d50c3e03/packages/coding-agent/examples/extensions/subagent/README.md
[P5]: https://github.com/badlogic/pi-mono/blob/d2e7d8b7c1d31d3661f769d5caef7ba8d50c3e03/packages/coding-agent/docs/mcp.md
[P6]: https://github.com/badlogic/pi-mono/blob/d2e7d8b7c1d31d3661f769d5caef7ba8d50c3e03/packages/coding-agent/docs/security.md
[X1]: https://github.com/openai/codex/blob/4e7b9e285ba4ac6ce18ca452cf9e88d3d75ec857/codex-rs/core/src/session/turn.rs
[X2]: https://learn.chatgpt.com/docs/app-server
[X3]: https://github.com/openai/codex/blob/4e7b9e285ba4ac6ce18ca452cf9e88d3d75ec857/codex-rs/core/src/tools/router.rs
[X4]: https://github.com/openai/codex/blob/4e7b9e285ba4ac6ce18ca452cf9e88d3d75ec857/codex-rs/core/src/tools/orchestrator.rs
[X5]: https://github.com/openai/codex/blob/4e7b9e285ba4ac6ce18ca452cf9e88d3d75ec857/codex-rs/core/src/agent/control/mailbox.rs
[X6]: https://github.com/openai/codex/blob/4e7b9e285ba4ac6ce18ca452cf9e88d3d75ec857/codex-rs/core/src/agent/control/residency.rs
[X7]: https://github.com/openai/codex/blob/4e7b9e285ba4ac6ce18ca452cf9e88d3d75ec857/codex-rs/rollout/src/recorder.rs
[X8]: https://github.com/openai/codex/blob/4e7b9e285ba4ac6ce18ca452cf9e88d3d75ec857/codex-rs/rollout/src/state_db.rs
