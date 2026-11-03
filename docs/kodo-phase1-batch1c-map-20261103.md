# Kodo 阶段 1 批次 1c 删除地图：名册、路由、留存、派生、预设与角色卡

- 快照：HEAD `14deba8`（`docs: add batch 1b deletion map and phase-1 status board`），工作区干净；只读分析，未改源码/测试，未 commit。
- 依据：`docs/kodo-final-positioning-20261103.md:139`（1c = 名册、路由、留存、派生、预设与角色卡，约 1,159 行）、`docs/kodo-subtraction-plan-20261103.md:70`。
- **1c 与 1b 并行**：1b 正在另一个 worktree 删除 execution 子系统并 bump 卡片版本号。本图基于当前 HEAD（1b 未合入）测量；§1.4 用 ⚔ 标出 1b 会先改动的点，并说明"1b 之后 1c 还剩什么"。1c 自身不动 `Run.execution` 相关代码。
- 规模：核心 9 个文件恰好 **1,159 行**（与计划表一致）。核心净删约 **989 行**（1,074 行删除 − 85 行报告机制迁移保留），连同 storage/web/tui/cli/application 依赖点，**源码净删约 2,150–2,250 行**（保守下限约 1,950）；关联测试净删约 **1,300–1,500 行**。
- 一句话结论：1c 把"可路由/可留存的角色卡市场"整块删除，只保留**一张默认卡 + 宿主显式传入的卡片（能力包/作者/用例）**；`Card` 类型与 `Card.execution.modes` 保留到 1e，`parseCard/serializeCard` 因作者流程与能力包保留。唯一不可拆的大提交是"删 9 个核心文件 + 删工具 + 删 spawn 卡片选择 + 默认卡收敛"，因为类型和工具注册互相引用。

---

## 1. 逐文件清单

### 1.1 核心删除（9 文件，1,159 行）

| 文件 | 行数 | 职责 | 关键导出/引用点 |
|---|---:|---|---|
| `src/agents/roster.ts` | 134 | 冻结会话名册：成员选择、可用性、catalog 树、digest | `freezeRoster:42`、`rosterSnapshot:108`、`rosterMember:109`、`rosterTree:112`；消费方 `application/index.ts:50,508`、`runtime/instruction-layer.ts:13,94`、`storage/cards.ts:2`、`extensions/methods.ts:6`、`runtime/roster-context.ts:1` |
| `src/agents/routing.ts` | 110 | `agent.route` 排名与候选说明；legacy 路由 spec | `routeCards:34`、`cardRoutingTool:93`、`legacyRoutingSpec:110`；消费方 `application/index.ts:31,32,208,778-779`、`tools/index.ts:9` |
| `src/agents/discovery.ts` | 219 | `agent.search`/`agent.directory`、探索预算、roster 搜索投影、legacy specs | `searchCards:95`、`sync` 系列 `searchRosterCards:62`、`directoryRosterCards:71`、`exploreCards:132`、`cardSearchTool:178`、`cardDirectoryTool:196`、`legacyDiscoverySpecs:216`；消费方 `application/index.ts:30,206-207,776-777`、`tools/index.ts:8` |
| `src/agents/retention.ts` | 273 | 角色卡留存草稿：propose/request/approve/edit/decide、证据快照 | `AgentRetention:94`、`retentionTools:250`；消费方 `application/index.ts:52,209-210`、`web/collaboration.ts:59,69,101`、`web/server.ts:194-195,324-329`、`cli/agent-review.ts`、`tui/agents.ts:185-213` |
| `src/agents/derive.ts` | 89 | `agent.derive` 临时卡派生与引用解析 | `deriveAgentSpec:17`、`resolveAgentReference:32`、`deriveAgent:57`；消费方 `messaging/index.ts:33-34`、`messaging/child-config.ts:5` |
| `src/agents/presets.ts` | 118 | 6 张内置专家卡（explorer/tester/reviewer/implementer/frontend/backend）及其版本矩阵 | `builtinCardsV1:20-77`、`legacyBuiltinCards:80`、`builtinAgentCards:83`、`compactBuiltinAgentCards:101`、`simpleBuiltinAgentCards:110`；消费方 `application/index.ts:49,498,507`、`tui/agents.ts:8,54` |
| `src/agents/contracts.ts` | 143 | 卡片输入槽校验、`report.submit` spec、报告校验/完整性 | `validateSlots:9`、`reportSubmissionSpec:48`、`reportSpecForCard:55`、`validateReport:76`、`submitReport:117`、`reportCompleteness:125`、`hostAcceptanceStatus:138` |
| `src/agents/child-card.ts` | 18 | 子运行去掉委派段落/`agent.*` 工具的卡片视图 | `delegationGuidance:4`、`teamDelegationGuidance:6`、`childCard:13`；消费方 `card.ts:10,158`、`agent-factors.ts:1,45`、`child-config.ts:2,34,52` |
| `src/agents/project-cards.ts` | 55 | 读取 `.kodo/agents/*.md` 项目卡 + `AGENTS.md` 项目变量 | `projectAgentAssets:9`；消费方 `application/index.ts:51,481` |

**处置**：
- 前 8 个文件（1,016 行）整删（`contracts.ts` 见下）。
- `contracts.ts` 拆分：卡片相关的 `validateSlots`（9-46）、`reportSubmissionSpec`（48-52）、`reportSpecForCard`（55-68）随卡片体系删除；报告校验/完整性/宿主验收（`validateReport` 76-115、`submitReport` 117-123、`reportCompleteness` 125-135、`hostAcceptanceStatus` 138-143，约 85 行）**迁移**到新 `src/runtime/report.ts`，因为 `report.submit` 要留到 1d 才精简（1d 才删协作工具 `report.submit`）。迁移期禁止改行为，`method-stage.ts:149` 的 `validateSlots` 在 1c 中改为"方法输入不再支持（方法改为无输入）"。

### 1.2 依赖存储/投影删除

| 位置 | 行数 | 处置 | 说明 |
|---|---:|---|---|
| `src/storage/cards.ts` | 197 | **整删** | `CardRecords` 只服务 discovery/roster：FTS `agent_metadata_fts`、`roster_snapshots/roster_members/roster_metadata_fts/roster_discovery_seen`、`search/namespaces/namespaceCards/rosterSearch/explorationUsage`。卡片注册表本身在 `storage/index.ts:299-311`（`registerCard/card/registeredCards`），不在这里；删 `cards.ts` 不影响能力包/作者/用例 |
| `src/storage/derived-agents.ts` | 38 | **整删** | `tmp:` 临时派生卡，仅 `derive.ts` 使用 |
| `src/storage/agent-drafts.ts` | 35 | **整删** | 留存草稿，仅 `retention.ts` 使用 |
| `src/storage/index.ts` | — | 改造 | 删除 import `:8-10`、字段 `:51-53`、构造 `:134-136`；`gc` 里 `agentDrafts.sessionIds()`（`:388` 附近）改为不再引用；旧表保留但不创建/不读（见 §4） |
| `src/runtime/roster-context.ts` | 75 | **整删** | 名册上下文渲染（`renderRoster`），仅 `instruction-layer.ts:14` 使用；删除后主运行不再注入名册目录 |
| `src/messaging/child-config.ts` | 57 | **删除并内联最小逻辑** | 卡片选择/配置解析入口；1c 后子运行直接继承父卡，保留约 5 行（权限过滤 + exploration 只读视图）可内联进 `messaging/index.ts` |
| `src/agents/configuration.ts` | 48 | **整删** | spawn 的 `configuration`（临时收窄 tools/skills/instructions）是卡片体系的配套；1c 删 `configuration` 参数（1d 做 spawn 生命周期精简时再统一） |
| `src/agents/configuration-save.ts` | 52 | **保留** | 属作者流程（`authoring`/TUI `agent-authoring`），能力包与作者流程按减法清单保留 |

### 1.3 外围代码改造（精确引用点）

| 文件 | 行 | 改动 |
|---|---|---|
| `src/application/index.ts` | 4,27,30-32,49-52 | 删除 presets/roster/project-cards/retention/discovery/routing 的 import；`withCardMethods` 保留（方法目录改造后仍需） |
| `src/application/index.ts` | 63-64,79-83,91,118,126,130,195-196,209-210 | 删 `agentRetention` 选项/字段/校验/注册；删 `discovery` 选项；`retention` 属性删除；保留 `inlineMethods/methodUnloading/methodToolView` 给方法目录迁移 |
| `src/application/index.ts` | 142-163 | `defaultCard` getter 收敛：删除 agentFactors.A 的 roster 分支（142-153）与 `builtinCards` getter（154）；`legacyDefaultCard`（155-163）暂时保留到 1e（见 §2） |
| `src/application/index.ts` | 206-210 | 删除 `cardSearchTool/cardDirectoryTool/cardRoutingTool/AgentRetention/retentionTools` 注册 |
| `src/application/index.ts` | 245-248,282-295 | `registerCard/validateCardRegistration` 保留（作者/能力包/用例仍注册卡）；删除 v2 card `members` 的解析校验分支（291-294）可由 1e 处理，1c 建议保留以少动 `parseCard` |
| `src/application/index.ts` | 250-281 | `updateSessionMethods` 改为基于 `Session.methodCards`（见 §2），不再读写 roster |
| `src/application/index.ts` | 296,776-781,794 | 删除 `searchCards` 方法（296）与 discovery/routing 的 export（776-779）；authoring/configuration-save/parseCard export 保留 |
| `src/application/index.ts` | 348,360,394 | 能力包注册卡的路径保留（`registerCard` 写入 card_versions，不进名册） |
| `src/application/index.ts` | 480-518 | 会话创建：删除 `projectAgentAssets`（481）、presets 注册（498）、`freezeRoster`（508）；保留 `options.card`（480）作为宿主显式卡；`options.team`（514-516）留给 1d 精简；`this.defaultCard` 仍按 profile 选择直至 1e |
| `src/messaging/index.ts` | 33-35 | 删除 derive import/spec；contracts 改为 `runtime/report.js`（report 部分） |
| `src/messaging/index.ts` | 371,388-392,412-413 | `resolveChildCard` 改为"子运行继承父卡"；删除 `validateSlots`/slots 注入；删除 card.report/slots 的 packet 段落（report 段落可留到 1d） |
| `src/messaging/index.ts` | 582,597 | `reportCompleteness` 迁到 runtime/report.js（行为不变，1d 删 `report.submit`） |
| `src/messaging/spawn-spec.ts` | 50-67,75-76 | 删除 `agent`/`card_id`/`card_version`/`slots`/`configuration` 参数与 `SpawnAgentRequest` 对应字段；`todoId` 留给 1d 的 todo 精简 |
| `src/messaging/explore.ts` | 1-2 | 删除 `configuration` schema 参数（explore 本体留给 1d） |
| `src/tools/index.ts` | 8-9 | 删除 `legacyDiscoverySpecs`/`legacyRoutingSpec` import |
| `src/tools/index.ts` | 344-345 | 删除 specs() 里 legacy discovery/routing 的替换分支 |
| `src/runtime/role-view.ts` | 15-16,18,29-32 | 删除 `simpleMember`/`kodo/*` 版本判断（角色卡已不存在）；删除 `agent.`/`explore`/`update_progress` 等已删工具的豁免；保留 profile/factor 分支给 1e |
| `src/runtime/instruction-layer.ts` | 13-14,86-100 | 删除 roster/roster-context import 与 roster 渲染块（`roster_degraded` 事件）；`initialContext` 不再收 roster；方法目录内容改由 `Session.methodCards` 渲染（若方法保留） |
| `src/runtime/agent-factors.ts` | 1,22-23,45-46,53 | 删除 child-card guidance import；编辑 B/C/D 段落中 `agent.route`/"frozen member"/`Card defaults` 等已删概念；factors 整体删除留给 1e |
| `src/agents/card.ts` | 10,158 | 删除 `delegationGuidance` import；默认卡 prompt 中的委派段落改为"spawn_agent 独立任务"短句（见 §2）；影响默认卡 digest/version |
| `src/agents/card.ts` | 164-204 | 保留 5 张默认卡的定义到 1e；1c 只改 prompt/工具引用（不含已删工具）并 bump 版本（⚔ 见 §1.4） |
| `src/web/server.ts` | 192-195,301-330 | 删除 `/api/runs/:id/methods` 的 roster 投影（改为返回 session methods refs，若方法保留）、`/api/runs/:id/agent-drafts` 及 approve/discard/edit/skip 分支；spawn 端点保留 |
| `src/web/collaboration.ts` | 44,59,69,101-121 | 删除 retention draft 的 pending action/proposal 字段与组装（约 60 行）；其余 agent/collaboration 视图保留给 1d |
| `src/web/workbench.ts` | 20-90 附近 | 删除 agent library/retention/proposal 面板的前端请求与渲染（若面板 JS 只引用已删端点，会 404）；packages 面板保留 |
| `src/tui/agents.ts` | 52-318 | 大幅裁剪：保留"包/作者/用例"库与报告相关只读视图；删除 roster launch/`/agents run|fill|scope|launch`、retention drafts、`/agents drafts`、`simpleMember` 版本逻辑（约 180-230 行） |
| `src/tui/controller.ts` / `commands.ts` | 视引用 | 删除 methods/drafts/agents launch 入口与帮助文案（按 grep 同步） |
| `src/cli/agent-drafts.ts` | 72 | **整删**（含 `agentCommand`，`cli/index.ts:84` 命令入口） |
| `src/cli/agent-input.ts` | 28 | **整删**（`--slot/--scope` 解析属卡片选择参数） |
| `src/cli/agent-review.ts` | 56 | **整删**（留存草稿审阅） |
| `src/cli/index.ts` | 12,24,57-58,84,106-109,121-125,201-210,315-317 | 删除 `agent` 命令与 retention/draft 参数；`--agent-retention --project-roots --agent-factors` 中前者/中者删除、factors 留到 1e；`methods` 命令改为 session method refs；删除 methods 里对 `store.cards.rosterSnapshot` 的读取 |
| `src/cli/host-state.ts` | 20-43 | 删除 `agentRetention`、`projectRoots` 持久字段与校验（旧 host-state JSON 中的未知字段按"容忍/丢弃"处理，见 §7-R9） |
| `src/extensions/methods.ts` | 6,51-67,70-108,110-127 | 去 roster：`RosterMember`→`Card`，方法来源改为 `Session.methodCards`（卡从 `store.card(id,version)` 取）；`Card.execution.modes` 判断保留（1e 删）；见 §2 |
| `src/runtime/session-compat.ts` | 12-26 | **扩展**：带 roster/draft/derived 痕迹的旧会话显式 `SESSION_INCOMPATIBLE`（见 §4） |
| `src/agents/authoring.ts`、`authoring-cli.ts`、`tui/agent-authoring.ts`、`agents/configuration-save.ts` | — | **保留**（作者流程按减法清单保留、冻结扩张；仅跟随 card.ts 的默认卡改动更新引用） |
| `src/packages/**`、`src/cases/**` | — | **保留**：能力包/用例仍可用 `options.card` + `registerCard`；`parseCard` 保留 |

**不需要改**：`src/runtime/execution-*`（1b 负责）、`src/storage/index.ts` 的 card_versions 注册（保留）、`src/packages/*`、`src/cases/*`、`src/knowledge/*`、sandbox。

### 1.4 ⚔ 1b 会先改动的点（1b 之后 1c 还剩什么）

| 文件/位置 | 1b 先做 | 1b 之后 1c 剩余工作 |
|---|---|---|
| `src/agents/card.ts:164-204` | bump `compactDefaultCard`/`legacySimpleDefaultCard`/`simpleDefaultCard` 版本（1.1.0/1.1.0/1.2.0 等），并从 tools 删除 `workspace.commit/workspace.integrate`（:171,:188） | 删除 `legacyBuiltinCards/builtinAgentCards/...` 消费方的 roster 分支；默认卡 prompt 去掉委派段落并再次 bump 默认卡版本（1c 的 prompt/tool 语义变化需要新身份）；`leanDefaultCard` 的 1.4.0 视 1e 处理 |
| `src/agents/presets.ts:90,102,112-114` | `compactWriteTools` 去掉 `workspace.commit`；`compactBuiltinAgentCards` 1.2.0→1.3.0；`simpleBuiltinAgentCards` 1.3.0→1.4.0、工具列表去掉 workspace.commit | **1c 整文件删除**（含 6 张专家卡与 4 个版本矩阵）。1b 的编辑只是为让 1b 编译，1c 直接丢弃；两批不要同时改此文件，按 1b→1c 顺序合入 |
| `src/runtime/role-view.ts:7-8` | 删除 workspace.integrate/commit 的 roleAllows | 1c 继续删除 15-16/18/29-32 的 kodo/* 专家卡与 agent.* 工具判断 |
| `src/runtime/session-compat.ts:12-26` | 增加 execution-legacy 判定 | 1c 在同一函数追加 roster/draft/derived-legacy 判定（**同一文件冲突点**，建议合入顺序 1b→1c，1c rebase 后合并两段判定）；`application/index.ts:449,521,543,618` 四个 gate 调用点同理 |
| `src/tools/index.ts:8-9,76-77` | 删 workspace 工具与 planVerifier 等 | 1c 再删 legacyDiscoverySpecs/legacyRoutingSpec 的 import 与 specs() 分支 |
| `src/messaging/spawn-spec.ts:66` | 删 execution 参数 | 1c 再删 agent/card_id/card_version/slots/configuration 参数（这两个变更都动同一 obeject，冲突小） |
| `src/application/index.ts:480-518` | 无直接改动（1b 不动 roster） | 1c 的会话创建收敛（删除 projectAgentAssets/presets/freezeRoster）都在这些行，1b 不冲突 |

---

## 2. 删除后必须保留的最小接口与"单一默认卡"收敛

### 2.1 改前/改后的卡片体系

**改前**：5 张默认卡（`defaultCard` v1、`compactDefaultCard` 1.0.0、`legacySimpleDefaultCard` 1.0.0、`simpleDefaultCard` 1.1.0、`leanDefaultCard` 1.4.0，按 toolProfile/agentFactors 选择）+ 6 张专家卡 × 4 个版本矩阵（`legacyBuiltinCards/builtinAgentCards/compactBuiltinAgentCards/simpleBuiltinAgentCards`）+ 用户注册卡 + `.kodo/agents` 项目卡 + 能力包卡 + 运行期派生卡。

**1c 后**：
- 内置卡只剩**默认卡**（仍是 5 个按 profile 选择的变体，真正收敛到一张是 1e，见 `kodo-subtraction-plan-20261103.md:75`、`kodo-final-positioning-20261103.md:141`）；**不再有专家卡、名册成员、项目卡、派生卡**。
- 子运行 **继承父卡**（共享工作区）；`spawn_agent` 不再接受 `agent/card_id/card_version/slots/configuration`；不再有 `childCard()`/`configureCard()`/`resolveChildCard()`/`validateSlots()`/`deriveAgent()` 链条。
- 宿主/能力包/用例仍可用 `CreateRunOptions.card`（`application/index.ts:480`）显式指定卡片，仍可用 `registerCard` 注册卡（作者流程与能力包）；这些卡**不进入任何名册**，也不可被模型选择。
- `parseCard/serializeCard/validateCard/loadCard` 与整个 `Card` 类型**保留**（作者流程、能力包、用例、旧卡读取都依赖）；`card.ts:12-127` 的 v2 校验继续接受 catalog/routing/inputs/report/members/execution 等字段（1e 再裁剪类型）。
- `Card.execution.modes`（`types.ts:67`；`card.ts:61,79,110-112,133-137`；`application/index.ts:267,283`；`method-stage.ts:144`）**1c 不动、留给 1e**；它在 1c 中只用于方法加载兼容（§2.3）。

### 2.2 默认卡如何从"注册表+卡片"变成单一配置（分两阶段）

1. **1c（本批）**：删除名册与专家卡后，`application.defaultCard` 的 roster 增强分支删除：
   - 删 `application/index.ts:142-153`（用 agentFactors.A 把默认卡升级成 `-roster` 卡、附 4 个成员引用）；
   - 删 `:154`（`builtinCards` getter）与 `:498`（每会话注册 4 套 presets）；
   - 删 `:507-508`（`registeredCards` 过滤 + `freezeRoster`）；
   - 保留 `:155-163` 的 `legacyDefaultCard`（按 toolProfile/factors 在 5 张默认卡中选择）直到 1e；
   - 默认卡 prompt 中引用已删工具/委派段落的句子重写（`card.ts:158` 的 `${delegationGuidance}`；compact/simple prompt 的 "hand off…card_id/card_version" 句），并 bump 默认卡版本（新 digest）。
2. **1e（后续）**：把 5 张默认卡、4 档 toolProfile、A–E 因素、3 个任务协议收敛成一张默认配置；届时删除 `legacyDefaultCard` 分支、`leanDefaultCard`、`compactDefaultCard`、`legacySimpleDefaultCard`、`simpleDefaultCard` 及 Session 的 `toolProfile/agentFactors/taskProtocol` 字段；本批**不要**提前做，否则与 1e 重复删除且增大黄金评测翻转面。

### 2.3 方法（inline methods）临时保留方案（Card.execution.modes 留给 1e）

方法加载依赖名册：`extensions/methods.ts:75,114` 从 `store.cards.rosterSnapshot(session.id).members` 取 `execution.modes.includes('inline')` 的卡；`application.updateSessionMethods`（250-281）把方法卡写进名册。1c 删除名册后必须选一个：

- **方案 A（推荐，语义最小变化）**：把方法目录改为**会话级卡引用**。给 `Session` 增加可选 `methodCards?: CardReference[]`（卡仍 `store.registerCard` 持久化）；`updateSessionMethods` 写 `session.methodCards/methodTools/methodSkills`，不再 freezeRoster；`withCardMethods/recordMethodLoad` 从 `session.methodCards` + `store.card()` 取卡；`methodContract/incompatibility` 的 `RosterMember` 参数改为 `Card`；web `/api/runs/:id/methods` 返回 `session.methodCards`；TUI/CLI methods 命令改读 session。约新增 25 行、删除 roster 逻辑约 80 行。1e 再把 P1–P4 并入编译器、删除 `Card.execution.modes/execution` 字段。
- **方案 B（更省事但改变功能）**：1c 连 inline methods 一起删除，`Card.execution.modes` 留作类型字段直到 1e。与 `Card.execution.modes 留给 1e` 的字面要求不冲突，但会提前去掉一个用户面功能，且 `method-stage.ts`/`method-context.ts`（共 236 行）属于 1e 范围，提前删会跨批。

建议 A；若 Lead 想减 1c 风险，可先把 `inlineMethods` 默认关闭并标实验，1e 统一处理。

### 2.4 必须保留的接口清单

- `CreateRunOptions.card`（宿主显式卡；能力包/用例/作者流程使用）
- `Application.registerCard/parseCard/validateCard/loadCard/card` 与 `Store.registerCard/card/registeredCards`（`storage/index.ts:299-311`；能力包 `application:348/360/394`、作者流程、旧卡读取）
- `report` 相关：`runtime/report.ts`（迁移自 contracts 的 validateReport/submitReport/reportCompleteness/hostAcceptanceStatus），供 `completion.ts:86`、`inspection.ts:124,195`、`method-stage.ts:104`、`messaging/index.ts:582,597` 使用到 1d
- `Session.methodTools/methodSkills`（已存在），加上 §2.3 的 `methodCards`
- `Card` 类型与 `parseCard` 的 v2 字段校验（1e 再裁）
- `spawn_agent`/`wait_for_events`/`inspect_run`/`cancel_agent`/`ask_user`（1d 保留集；1c 只删卡片选择参数）
- 默认卡与 `legacyDefaultCard` profile 选择（1e 收敛前必须可用）

---

## 3. 关联测试

### 3.1 整体删除（8 文件，约 1,066 行）

| 文件 | 行数 | 覆盖 |
|---|---:|---|
| `tests/agent-roster.test.ts` | 280 | 名册冻结/树/可用性/digest |
| `tests/agent-retention.test.ts` | 164 | 留存草稿全生命周期 |
| `tests/discovery-routing.test.ts` | 155 | agent.search/directory/route 排名与预算 |
| `tests/agent-presets.test.ts` | 100 | 6 张专家卡 × 版本矩阵/解析 |
| `tests/agent-discovery.test.ts` | 88 | 探索预算/legacy 搜索 |
| `tests/agent-web-retention.test.ts` | 72 | web 留存草稿端点 |
| `tests/spawn-configuration.test.ts` | 171 | spawn configuration/slots 选择 |
| `tests/agent-cli-drafts.test.ts` | 36 | CLI 留存草稿审阅 |
| **合计** | **1,066** | |

可一并删除：`tests/agent-cli-input.test.ts`（31，`--slot/--scope` 解析，随 spawn 参数删除）、`tests/agent-cli-review.test.ts`（41，留存审阅链路）。

### 3.2 必须改写（按影响排序，含行数与引用数）

| 文件 | 行数 | 改动 |
|---|---:|---|
| `tests/agent-context.test.ts` | 251 | 31 处 roster/上下文渲染断言：改为断言"不再注入名册目录"；保留项目指令/上下文预算用例 |
| `tests/agent-card-runtime.test.ts` | 271 | 15 处：删除 roster/spawn card_id/slots/method 相关；保留默认卡 toolBindings/技能/权限用例；新增"子运行继承父卡" |
| `tests/agent-card-v2.test.ts` | 94 | 7 处：保留 v2 卡解析（作者/包用途）；删除成员引用/名册语义 |
| `tests/compact-tools.test.ts` | 171 | 11 处：`:77` 子卡 1.3.0 版本断言与 `:78` 工具列表随 presets 删除；角色视图断言改为通用默认卡 |
| `tests/inline-methods.test.ts` | 231 | 方法目录迁移（方案 A）；roster 断言改 session.methodCards |
| `tests/method-stages.test.ts` | 198 | 10 处：`validateSlots`→方法无输入；`Card.execution` 断言保留 |
| `tests/model-scope.test.ts` | 260 | 4 处：卡片 scope/项目变量断言（项目卡删除）；改为默认卡 scope |
| `tests/agent-application-v2.test.ts` | 114 | 3 处 spawn 卡片参数/团队初始列表 |
| `tests/agent-followup.test.ts` | 336 | 2 处卡片参数；跟随 1d 再精简 |
| `tests/autonomous-delegation.test.ts` | 243 | 端到端 spawn 用例：删除卡片选择，保留共享写冲突/证据链 |
| `tests/agent-model-policy.test.ts` | 200 | 4 处 `card_id/agent`；改为默认卡 + binding 继承 |
| `tests/web.test.ts` | 200 | `/api/runs/:id/methods` 投影、草案端点删除 |
| `tests/tui-agents.test.ts` | 319 | 14 处：保留 package/authoring 视图；删除 library launch/retention |
| `tests/spawn-configuration.test.ts`（若保留） | 171 | 与 3.1 冲突时整删优先 |
| `tests/todo-*.test.ts`、`tests/exploration-*.test.ts`、`tests/simplicity-*.test.ts`、`tests/tui-controller.test.ts`、`tests/cli.test.ts` | — | 少量 spawn card/agent 参数与 `/agents` 命令断言，按编译错误逐个改 |

### 3.3 需要新增的测试（保底）

1. **单一默认卡**：新会话的 `run.card` 是默认卡（无 `-roster` 后缀），`store.cards.rosterSnapshot(sessionId) === undefined`，`store.registeredCards()` 不含 kodo/* 专家卡。
2. **子卡继承**：`spawn_agent` 仅带 objective/scope/permissions；child.card.digest === parent.card.digest；schema 拒绝 `agent/card_id/card_version/slots/configuration`（`TOOL_ARGUMENTS`）。
3. **方法目录**（方案 A）：`updateSessionMethods` 写入 session.methodCards 可被 `skill.list/skill.load` 读取；`Card.execution.modes` 仍生效。
4. **报告保留路径**：`report.submit` 与 `reportCompleteness` 行为与迁移前一致（1d 删除前不得回退）。
5. **旧会话/旧数据**：带 roster_snapshots/derived_agents/agent_drafts 的旧 session 恢复抛 `SESSION_INCOMPATIBLE`；只读 inspect/list 仍可用。
6. **能力包/作者流程不回归**：package 激活注册的卡仍可被 `CreateRunOptions.card` 使用（`tests/application-packages.test.ts`、`tests/agent-authoring.test.ts` 保留并更新）。
7. **旧卡容错**：`store.registeredCards()` 读出旧专家卡（card_versions 里已有的）不崩；但不会被自动选为默认卡。

---

## 4. 数据兼容：持久化卡片 JSON 与 web `/api/cards` 投影

- **card_versions 保留**：`storage/index.ts:299-311` 的卡片注册表继续存用户/作者/能力包卡；这些卡不再进入名册，也不会被模型选择。`store.registeredCards()` 仅作者/TUI/包库使用。**不新增 SQLite 迁移**，旧 JSON 原样可读。
- **删除的持久层**：`roster_snapshots/roster_members/roster_metadata_fts/roster_discovery_seen/derived_agents/agent_drafts`。旧数据库文件里这些表仍存在但新代码不再创建/读写；`gc` 需移除 `agentDrafts.sessionIds()` 引用（`storage/index.ts:388` 附近）。**不写迁移、不 DROP**（未发布产品，最省风险）。
- **旧会话兼容策略（显式不兼容，沿用 1a/1b 策略）**：扩展 `session-compat.ts`，命中任一即 `SESSION_INCOMPATIBLE`：
  - 1a：`toolProfile==='lean-team'` 或 `maxTaskNodes`；
  - 1b：任一 run 有 `execution/executionPending` 或 execution.* 事件；
  - 1c：`store.cards.rosterSnapshot(sessionId)` 存在，或 session 下有 derived agent/draft 记录，或 session 的 `agentFactors.C`/`inlineMethods` 旧组合无法安全降级（建议按 roster 存在判断即可，几乎所有旧会话都会命中——未发布，可接受）。
  - 读路径 `list/inspect/runs/calls/events` 不受 gate 影响；旧证据仍可查看。
- **web `/api/cards` 投影**：当前没有独立 `/api/cards`；卡片相关投影是 `/api/runs/:id/methods`（返回 roster snapshot，`web/server.ts:192-193`）与 `/api/runs/:id/agent-drafts`（:194-195）、草案命令（:301-330）。1c：删除 drafts 投影与命令；methods 投影改为 `session.methodCards` 的 `{id,version,digest}`（方案 A）；`web/workbench.ts` 对应面板同步改；`/api/packages`（含卡展示）保留。
- **host-state/CLI 持久配置**：旧 `--agent-retention`/`--project-roots` 字段删除；读取旧 host-state JSON 时未知字段忽略（见 §7-R9），不迁移。
- **磁盘/文档**：历史实验脚本（`scripts/comparison/agent-roster-v1.mjs`、`v3-delegation-eval.mjs` 等）仍引用 agent/card 选择——它们是历史证据，保留但标注 obsolete；golden eval 用例不使用卡片选择参数，无需改用例。

---

## 5. 分步提交计划（5 步，每步可独立编译+测试）

| 步骤 | 内容 | 主要文件 | 风险/验证 |
|---|---|---|---|
| **S1（零行为迁移）** | 把 `contracts.ts` 的报告部分迁到新 `src/runtime/report.ts`（`validateReport/submitReport/reportCompleteness/hostAcceptanceStatus`），`completion/inspection/method-stage/messaging` 改 import；contracts 只留卡片槽/报告 spec（1d 再处理 `report.submit` 精简） | contracts.ts、新 report.ts、4 个 import 点 | 纯迁移；`npm run build` + report/inspection/method 相关测试 |
| **S2（方法目录去 roster）** | 方案 A：`Session.methodCards` + `updateSessionMethods/withCardMethods/recordMethodLoad` 改造；web `/api/runs/:id/methods`、TUI/CLI methods 命令改读 session；roster 仍保留给 discovery/retention（暂不删） | session-compat 不动；application、extensions/methods、web/server、tui、cli | 方法测试 inline-methods/method-stages 全绿；`Card.execution` 保留 |
| **S3（原子删除，核心大提交）** | 删 9 个核心文件（contracts 去卡片部分）+ storage/cards/derived-agents/agent-drafts + roster-context + child-config/configuration + 删工具注册（agent.route/search/directory/derive/propose/retain）+ spawn 卡片参数 + application 会话创建收敛 + 默认卡 prompt/版本 + role-view/instruction-layer/agent-factors/web/tui/cli 调整 + 测试整删/改写 | 约 30 文件 | 类型系统纠错；`npm run build`；`node --test`（重点 roster 相关已删、todo/spawn 路径全过）；不可再拆（工具注册、卡解析、默认卡互相引用） |
| **S4（兼容门与数据收尾）** | session-compat 追加 roster/draft/derived 判定；storage gc 清理；旧表忽略；检查 web/TUI 无残留 404 请求；补充 §3.3 新测试 | session-compat、storage/index、application 4 个 gate、测试 | 旧会话拒绝、只读可用；数据目录可打开 |
| **S5（文档 + 黄金门槛）** | 更新 `kodo-final-positioning` 1c 行、`kodo-subtraction-plan` 70 行、`cli-host-configuration` 历史节（agent.route/retention 标已删）、`agent-routing.md`/`agent-card-design.md`/`inline-methods.md` 标历史；重跑黄金评测 27 格 + coding-01，逐格对比基线（工具集、默认 prompt/上下文均变） | docs + eval | 最大验收风险；翻转格必须逐个复核（见 §7-R1） |

合入顺序与 1b：**1b 先合入**（card.ts/presets.ts/session-compat/tools/index 小冲突），1c rebase 后在同一函数追加判定；1c 的 S3 动作会丢弃 1b 在 presets.ts 上的编辑，属预期。

---

## 6. 与 1d / 1e 的边界

**1c 负责（本批）**：
- 名册/路由/发现/留存/派生/预设/项目卡/子卡视图（9 文件）及 `CardRecords`、`DerivedAgentRecords`、`AgentDraftRecords`、`roster-context`；
- 模型可见的 `agent.route/agent.search/agent.directory/agent.derive/agent.propose/agent.retain` 工具；
- `spawn_agent` 的卡片选择参数 `agent/card_id/card_version/slots/configuration` 与对应解析链；
- 默认卡的 roster 增强、专家卡注册、名册冻结；
- 方法目录去 roster（方案 A，`Card.execution.modes` 保留）；
- web/TUI/CLI 的卡片库/留存/草案/名册页面与命令；
- 旧会话的 roster 兼容门。

**留给 1d（协作工具精简与 spawn 生命周期）**：
- `send_message`、`explore`/`exploration.plan`、`followup_task`、`agent.derive` 的**工具面删除**（1c 删了 derive 实现；1d 从 messaging 工具表/描述中删净）、`report.submit`；
- spawn/explore 生命周期与交接改造（只留 fresh/fork，上下文包由编译器生成）；
- todo 依赖/派发精简；`options.team` 初始派发、`todoId` 参数的去留；
- `followup_task` 实体删除、`agentId`/continuation 语义简化。
- 1c 必须**保留**这些工具可编译可用（除卡片选择参数外），避免与 1d 重复删除。

**留给 1e（档位/因素/协议收敛 + Card 类型裁剪 + 方法 P1–P4）**：
- 5 张默认卡合并为 1 张、`toolProfile/agentFactors/taskProtocol` 收敛；
- `Card` 类型字段裁剪（`execution`、`catalog`、`routing`、`members`、`derivation`、`inputs`、`report`、`model`、`constraints` 中不再需要的部分）与 `parseCard` v2 校验收敛；
- `Card.execution.modes` 与 inline methods 的最终去向（P1–P4 并入上下文存储加载策略）；
- `runtime/method-stage.ts`/`method-context.ts`（236 行）与 exploration 工作流、agent-factors 提示段落删除。

**不能误删的同名概念**：
- `Card.execution.modes`（`types.ts:67` 等）：1c 保留，1e 处理；
- `src/cases/store.ts:19`/`runner.ts:109-119` 的 case `execution`（runId/status/outputDigest）：与隔离检出/角色卡都无关，完全保留；
- `messaging/index.ts:305-338` 的 exploration question `execution`（child/reuse/deferred）：1d 处理，1c 不动；
- `WorkspaceLocks`/`Run.execution`：1b 处理，1c 不碰；
- 作者流程 `authoring.ts/authoring-cli.ts/tui/agent-authoring.ts` 与能力包 `registerCard/parseCard`：保留，不得因 grep 到 "agent"/"card" 而误删。

---

## 7. 风险清单

1. **黄金评测再次变化（最高）**：1c 同时改三类模型可见输入——工具集合（删 agent/retention 工具、spawn 参数收窄）、系统提示/上下文（默认卡 prompt 去委派段、名册目录不再注入、agent-factors 段落改）、卡片身份（默认卡版本/digest）。必须在 1c 合入后重跑 27 格候选矩阵 + coding-01，逐格对比基线；不能只看总分（`kodo-final-positioning:133` 已要求检查翻转样例）。1b 刚改过工具集，建议 1b、1c 各自独立跑门槛，避免归因混淆。
2. **默认卡收敛顺序（1b/1c/1e 冲突）**：1b bump 默认卡与专家卡版本、1c 删专家卡并再次 bump 默认卡、1e 再合并默认卡。三批都改 `card.ts/presets.ts/application.defaultCard`。建议先 1b→1c→1e 串行合入；1c 的 S3 一次到位，避免中间态"默认卡引用已删专家卡"。1c 后默认卡 prompt 中不得再提 agent.route/card_id；`role-view.ts` 的 `kodo/*` 版本正则必须同步删除，否则默认卡在 compact-v1/v2 视图下的工具可见性可能误判。
3. **方法功能半迁移**：名册删除后 inline methods 依赖 §2.3 的会话级方法目录；若只删 roster 不补方法目录，`inlineMethods` 会话会在 `skill.list/skill.load`/updateSessionMethods 处抛错。S2 必须先落地，S3 再删 roster；覆盖 `tests/inline-methods.test.ts`、`tests/method-stages.test.ts`。
4. **spawn 共享路径回归**：1c 改保留的 `prepareSpawn`（删卡片选择/slots/configuration）与 `assertNoWriteConflict` 调用条件；子运行从"专家卡+权限收窄"变为"继承父卡+继承父权限"，**默认权限面变大**（reviewer/tester 的只读/受限视图消失）。必须保留 spawn 的 `permissions` 子集校验与 `scope`/写冲突内核修复（2d84453），并跑 `todo-delegation/todo-parallel/autonomous-delegation/write-scope` 测试；在 map 落地时确认 1d 的 fresh/fork 设计是否进一步默认降权。
5. **GC/存储初始化**：`storage/index.ts` 的 `gc` 与构造函数引用 `agentDrafts/derivedAgents/cards`；删 store 时必须同步（`:8-10,51-53,134-136,388`），否则旧数据库打开即报错。旧表不迁移、不 DROP；新库不创建。
6. **作者流程/能力包误伤**：`registerCard/card_versions/parseCard/validateCard` 必须保留（能力包 `application:348,360,394`、作者流程、用例 `CreateRunOptions.card`）。`storage/cards.ts` 整删安全的前提是"卡片注册表在 storage/index.ts"；若误删到 registry 会破坏能力包。
7. **web/TUI/CLI 残留**：删后端端点后，`web/workbench.ts` 面板/TUI `/agents` 命令/CLI `kodo agent` 若仍发请求会 404 或抛错；S3/S4 必须同时清理并跑 `web.test/tui-agents/cli.test`。docs 中 `cli-host-configuration` 的 `agent route/retention` 段落要标历史，避免用户按旧文档使用。
8. **role-view/tool-view 规则残留**：`role-view.ts:15-16,18,29-32` 的 `kodo/*` 版本与 `agent.*` 豁免在卡删除后会成为死规则；若保留会导致默认卡工具可见性错误（例如 `simpleMember` 永假、`simpleMain` 正则仍匹配默认卡）。必须同步清理。
9. **host-state/旧 CLI 配置**：删 `agent-retention`/`project-roots` 参数后，旧 host-state JSON 含这些字段；读取时需忽略而不是报错（`cli/host-state.ts:27` 的键白名单可能拒绝未知字段，需允许旧字段或做一次性丢弃）。旧命令 `kodo agent ...` 明确报"已删除"。
10. **文档/历史实验脚本**：`docs/agent-routing.md`、`agent-card-design.md`、`inline-methods.md`、`scripts/comparison/agent-roster-v1.mjs` 等仍描述被删机制；按阶段 1 §6 统一处理（历史记录保留，标已取代/已删除），不要当作现行 API 或测试目标。

---

## 附：行数核算与净删估计

| 项 | 行数 |
|---|---:|
| 核心 9 文件 | 1,159 |
| 其中整删 8 文件 | 1,016 |
| contracts 删卡片部分（validateSlots/report spec） | 58 |
| contracts 报告部分迁移保留（新 runtime/report.ts） | +85 |
| **核心净删** | **约 989（1,074 删除 − 85 迁移保留）** |
| storage/cards.ts + derived-agents.ts + agent-drafts.ts | 197+38+35 = 270 |
| roster-context.ts | 75 |
| child-config.ts + configuration.ts（替换为小段） | 约 95 |
| application 收敛（defaultCard/注册/会话创建/methods/导出/选项） | 约 120 |
| messaging/tools/role-view/instruction-layer/agent-factors | 约 120 |
| web（server+collaboration+workbench）| 约 120 |
| tui（agents/controller/commands，保留包与作者流程） | 约 230 |
| cli（agent-drafts/agent-input/agent-review/index/host-state） | 约 200 |
| storage/index 与 compat 门等 | 约 25 |
| 外围净删小计 | 约 1,255 |
| **源码净删合计** | **约 2,150–2,250（保守 1,950，若 tui/cli 保留更多旧页面）** |
| 测试整删（8 文件 + 2 小文件） | 1,066 + 72 ≈ 1,138 |
| 测试改写/删减净额 | 约 250–400 |
| **测试净删** | **约 1,300–1,500** |

计划表的 1,159 只统计 9 个核心子系统文件；1c 的实际删除范围必须包括其 storage/web/tui/cli/application 依赖点，因此净删行数明显更大。
