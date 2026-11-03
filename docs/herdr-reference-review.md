# Herdr 源码调研与 Kodo 借鉴建议

日期：2026-10-23。调研版本：Cargo.toml 的 0.9.5，提交 `5bd900d88c80d95f5b145397e45bbeea398b8165`（2026-10-21）。源码保存在 `.kodo/competitor-sources/herdr-20261023/`。本报告核对 README、对应 0.9.5 文档、核心实现和相关测试代码；未构建运行 Herdr、未安装其集成、未做性能或真实多 Agent 收益实验。测试代码存在不等于本机测试通过。

## 1. 核心判断

Herdr 是面向编码 Agent 的终端工作台：后台服务持有 PTY/终端进程，客户端展示多个本地/远程工作区，识别 Agent 状态，并通过 CLI/socket 控制现有 Agent。它没有取代这些 Agent 的模型循环。

Kodo 是自己执行模型与工具循环的 Harness，拥有任务、卡片、权限、证据和上下文管理。两者存在协作体验交集，但主要处于不同层。最值得借鉴的是控制接口、注意事项呈现和外部接入，而不是把 Kodo 改造成终端模拟器。

| 维度 | Herdr 本次代码/文档 | Kodo 当前方向及已有基础 |
| --- | --- | --- |
| 执行对象 | 已安装 Agent 的终端进程 | 自有运行内核中的 run、工具与能力包 |
| 协作 | agent start/prompt/read/wait；向终端提交输入 | spawn_agent、消息关联、wait_for_events、inspect_run |
| 状态来源 | 集成报告、进程识别、屏幕规则 | 内核事件与持久化运行状态 |
| 历史与恢复 | 布局快照、可选终端历史、原 Agent 的 resume 命令 | 持久调用/来源、上下文归档、未知副作用核实后恢复 |
| 扩展分发 | GitHub 插件、清单、构建/动作/事件/面板入口 | 版本化 Agent 能力包、Skills、工具、MCP、依赖与案例 |
| 上下文压缩 | 本次审阅的控制层没有语义压缩；由底层 Agent 自己负责 | 可追溯归档、动态组装和压缩实验 |

依据：[README](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/README.md)、[运行自动化文档](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/docs/versions/0.9.5/website/src/content/docs/agent-automation.mdx)。Kodo 对照来自 [消息接口](../src/messaging/index.ts)、[运行检查](../src/runtime/inspection.ts)、[本地 Web](../src/web/server.ts)，不是仅按设计愿景比较。

## 2. 值得借鉴的机制

### 2.1 将“进程状态、任务结果、用户是否看过”分开

Herdr 对外有 working/blocked/idle/done/unknown；done 是工作后进入 idle 且尚未被标记已查看，并不是代码通过验收。`state_change_seq`、`completion_seq` 让状态变化、工作结束和用户查看彼此分离；客户端也能独立记录是否看过。侧栏按状态优先级和最新变化排序。

Kodo 已经区分运行 completed 与 quality 状态，无需重建状态机。可在 Web/TUI 上补足表达：正在执行、等待同伴、等待用户、执行失败、已结束待核验、已验收；“新结果未查看”作为单独的界面状态。优先呈现需要用户决定/失败/新结果，并明确阻塞者、原因和可采取动作。不能将所有等待都变成需要用户介入。

证据：[AgentInfo 字段](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/api/schema/agents.rs#L210)、[侧栏排序](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/client/shell/agent_sidebar.rs#L38)。Kodo 的 [inspectRun](../src/runtime/inspection.ts) 已说明 completed 不代表质量通过，现有 [工作台](../src/web/workbench.ts) 可作为增量落点。

### 2.2 明确提交、开始执行和完成之间的边界

Herdr 的 prompt 在写入前检查目标是否仍占据该终端、是否准备就绪、是否 blocked；blocked 时拒绝直接发普通提示。prompt --wait 对原本非 working 的目标先观察本次提交后的 working/blocked 活动，再等待稳定状态，避免把原有 idle 立即当作完成。超时并不证明消息没发送，文档要求先读取再决定重试。

重要限制：Herdr 明确不跟踪每个独立 turn；向已 working 的 Agent 发 prompt 时，当前活动轮次的结束可能满足等待。Kodo 不能照搬为任务完成协议，应继续以 runId、消息 replyTo、waitId、决定版本和验收证据关联操作。

借鉴重点是增加边界验证：旧完成事件不能唤醒新任务；消息提交后断线不能重复委派；目标被替换时不能把输入发送给新对象；等待超时不能自动重放有副作用操作。Kodo 已有持久等待和关联消息，应检查现有覆盖再补测试，而不是再建消息总线。

证据：[提交前检查](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/app/api/agents.rs#L138)、[提交后活动门禁](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/api/wait.rs#L244)、[等待测试](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/tests/cli/agent_wait.rs)。

### 2.3 用小状态和按需结果降低协调成本

Herdr 提供状态列表、指定目标读取和等待；普通 recent 读取默认只返回 80 行，可按需扩大。结果太长时，文档推荐让执行 Agent 写成文件并返回路径。它是在控制信息传递量，并没有提供保证保留语义的上下文压缩算法。

Kodo 已有有界子任务摘要、artifact 与 inspect_run，应继续使用“状态/摘要/来源引用 → 必要时分页原文”的方式。可以测一次主代理协调实际注入多少 token、多少次重复读取、恢复一个关键事实用了多少请求。不要把 80 行当成通用 token 预算，也不要丢掉原始结构化证据改抓终端屏幕。

### 2.4 接入协议轻量，适合 Kodo 成为其受支持 Agent

Herdr 支持 Agent 自报状态和 resume 命令，无需先向 Herdr 提交内建适配。报告带 source 与可选递增 seq，过期报告不能覆盖新状态；退出时 release。集成仅在 HERDR_ENV=1 且相关变量齐备时启用。Pi 的集成也有有界 IPC 超时与递增序号。

可选的小型适配：Kodo 在真实 Herdr pane 内运行时，将自身状态映射成 working/blocked/idle，报告会话恢复命令并退出释放。失败诊断留在本地，外部状态展示故障不阻断任务；展示通道的状态合并不能删除 Kodo 的可靠任务事件。恢复命令须固定 data-dir/会话及原有配置，不携带密钥，不绕过 UNKNOWN_WRITE 核实；只在存在可恢复会话时报告。

这能让用户把 Kodo 与现有编码 Agent 放在同一工作台，作为兼容性入口。它不等于 Kodo 已能可靠调度所有其他 Harness：终端控制层不能提供工具级权限、准确 token 账本或逐任务验收契约。先验证 Kodo 被托管，不立即实现一套跨 Harness 后端。

证据：[接入协议](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/docs/versions/0.9.5/website/src/content/docs/add-herdr-support.mdx)、[报告处理](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/app/api/panes.rs#L1554)、[Pi 集成](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/integration/assets/pi/herdr-agent-state.ts)。

### 2.5 将断开界面、服务重启和任务恢复作为不同承诺

Herdr 客户端退出时后台进程仍可运行；服务/机器重启不会保住原进程，只能恢复布局，并在受支持情况下调用原 Agent 的恢复命令。终端画面回放也不等于进程或对话恢复。其文档明确列出这些边界。

Kodo 的 serve 已把浏览器连接与执行宿主分开，SSE 断开会清理订阅；服务停止则关闭并中断活动工作。因此不需要为了借鉴再造一个后台服务。应验证并清楚展示：关闭浏览器后任务是否继续，重连是否补齐事件，宿主重启时哪些任务需要恢复/核实，未知写入为什么不能自动续跑。

证据：[恢复边界](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/docs/versions/0.9.5/website/src/content/docs/session-state.mdx)、[恢复参数验证](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/agent_resume.rs#L50)；Kodo 对照 [serve](../src/cli/serve.ts) 与 [SSE](../src/web/server.ts)。

### 2.6 从插件分发借鉴渐进生态与运行版本保护

Herdr 插件清单包含版本、最低宿主版本、平台、构建与动作/事件/面板入口；支持 GitHub 子目录安装及本地 link 开发。更新使用新安装目录，现有命令继续持有旧文件；安装租约避免旧版本被过早回收。其测试明确覆盖多个服务器和仍在运行的命令引用。

Kodo 已有不可变能力包、导入后准备/验收/采用、版本回滚和旧运行绑定。可以借鉴兼容性诊断、开发调试路径和运行引用保护的测试场景；不需要另建第二套插件协议。社区可先展示可运行示例包、任务效果、依赖与验证条件，再逐步扩展投稿和发现。Git/文件分享也能先验证复用价值。

边界：Herdr 文档明确插件以用户权限执行、继承环境、不做插件沙箱。Kodo 的包导入惰性、显式依赖准备、隔离工具执行不应因为追求安装方便而被去掉。拥有插件市场也不证明每个插件有效；Kodo 可继续以方法+依赖+案例+实际验证作为待证明的产品价值。

证据：[插件协议与信任边界](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/docs/versions/0.9.5/website/src/content/docs/plugins.mdx)、[安装租约与回收](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/plugin_installations.rs#L284)；Kodo [能力包实现说明](capability-packages.md)。

### 2.7 CLI/API 共享契约，减少接口漂移

Herdr 在类型定义上组合 serde/schemars 和 cli_params 投影，AgentRead/Wait 等参数同时支撑 JSON 接口与 CLI 参数绑定。对 Kodo，适合让已有业务校验在 CLI、Web、模型工具入口复用，先核对字段、默认值、错误码和权限语义的一致性。不建议为了这一点整体引入代码生成框架或重写语言。

证据：[参数与投影定义](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/api/schema/agents.rs#L9)。

## 3. 与当前上下文实验的关系

Herdr 不提供可以直接替代 Kodo 动态组装选择器的算法，也没有本次可用的质量/费用对照来证明它解决了自主委派。它提供的是更可控的外部交互机制。Kodo 当前的上下文实验应继续按 [已设计的门禁与小样本](context-assembly-experiment.md#8-修复后的诊断实验2026-10-23)推进，不因这次调研切换内核架构。

它对上下文的间接启发是把状态、工作结束、结果正文分开传递，并只在确有消费需求时读取大结果。Kodo 已有大部分基础，应测量是否减少主代理重复读回，而不是以“有按需读取”直接声称省 token。

## 4. 推荐顺序与最小验证

| 优先级 | 建议 | 最小可证伪验证 |
| --- | --- | --- |
| 近期 | 协作状态与结果呈现：优先显示用户阻塞/失败/未查看结果，完成与验收分开 | 一组失败、等待同伴、等待用户、已结束未核验的任务，界面与 API 对各自状态/下一动作一致；重复事件不重复提醒 |
| 近期 | 复用现有协作协议补边界覆盖 | 旧事件不结束新等待；提交后断线不重复创建；对象替换拒绝误投；超时保留副作用不确定性 |
| 可选集成 | Kodo 在 Herdr 内自报状态、会话、释放 | 乱序报告不回退；外部 IPC 不可用不阻断；独立测试会话重启恢复到同一 Kodo 数据与配置，不重放未知写入 |
| 后续 | 能力包开发/分发与旧版本回收体验 | 新版本采用后旧任务仍使用旧摘要对应的资源；活动引用未释放不得删旧资源；导入不执行代码 |
| 暂缓 | 跨 Harness 调度、多机编排、终端模拟和屏幕识别 | 有明确用户需求和端到端验收契约后再讨论，不为展示“多 Agent”提前建设 |

这是一份借鉴建议，没有修改 Kodo 生产代码或安装 Herdr。若后续直接复用代码，Herdr 当前为 Apache-2.0，应保留适用许可证和署名；此次仅记录设计分析。
