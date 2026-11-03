# 阶段 1 批次 1e+1f 收敛地图：单默认配置 + 提示词审计

- 快照：HEAD `90ab056`（main，工作区干净；1a 已合并 `0032837`；1b 在 worktree `phase1/batch1b` 实施中，未合并；1c/1d 删除地图已产出并提交）。本文是**只读分析**，未改源码/测试，未 commit。
- 依据：[最终定位与执行方案](kodo-final-positioning-20261103.md) §5:141-142、[减法方案](kodo-subtraction-plan-20261103.md) §4:74-75 与 §5:97、[1a 地图](kodo-phase1-batch1a-map-20261103.md) §9（task 三文件保留到 1e）、[1b 地图](kodo-phase1-batch1b-map-20261103.md) §7、[1c 地图](kodo-phase1-batch1c-map-20261103.md) §6、[1d 地图](kodo-phase1-batch1d-map-20261103.md) §3.3/§7/§11、[inline-methods](inline-methods.md)、[cli-host 配置](cli-host-configuration.md)。
- 前提与重校准：本文行号基于 HEAD；**1b/1c/1d 合入后必须重新 `git grep` 校准**（1b 删 `execution-*`、1c 删名册/角色卡、1d 删协作工具与 todo 依赖，均会移动 `messaging/index.ts`、`application/index.ts`、`tools/index.ts`、`instruction-layer.ts` 的行号并删掉本文标注为“1d 已删”的项）。
- 范围：1e = 5 套工具档位 / A–E 因素 / 3 个任务协议收敛为一套默认配置 + P1–P4 方法阶段并入上下文存储加载策略；1f = 提示词审计 + 默认身份改为通用工作助手。

## 0. 结论摘要

### 0.1 一句话结论

**1e 应把“默认配置”定义为“今天默认 `compact-v2` 的请求面（内核工具名 + 完整能力面）+ 一张默认卡 + 无 profile/无因子/无协议字段”，删除其余 3 条 profile 分支与 P1–P4 阶段机制；1f 再把系统提示收敛为唯一 L1 模块，默认身份改为通用工作助手。** 这样 1e 可以做到“默认请求逐字节不变”，把黄金评测的翻转风险集中到 1f 一次性评估。

### 0.2 关键决策（建议，需 Lead 确认，见 §10）

| # | 决策 | 建议 | 理由 |
|---|---|---|---|
| D1 | 单默认配置的形态 | **保留当前 compact-v2 的内核工具面**（file/shell/knowledge/skill/artifact/history/todo/spawn 等），删除 lean 重命名视图、compact-v1、full | 黄金基线 30 格跑的就是 compact-v2；lean 视图只有 6–9 个工具（按 exec 权限）、没有 `skill.*`/`knowledge.*`/MCP/web/verify（评审 D6/D8，[定位收敛评审](kodo-positioning-convergence-review-20261103.md)），不能承载定位 §2.3 的“按需拉取”；改成 lean 形态等于产品核心不可达 |
| D2 | 内部测试开关 | **不保留任何 profile 开关**；测试需要不同工具面时用显式自定义卡（`createRun({card})`/`registerCard`）或现有 `KODO_ABLATION` 环境开关（仅测试） | 5 个 profile 是实验矩阵的产物，不是产品能力；保留即继续付维护/测试成本 |
| D3 | P1–P4 的最终落点 | 1e **整删阶段机制**（`task` 工具、task 三文件、method-*、`Card.execution.modes`、`Session.method*`、热插拔/web/TUI/CLI 入口）；通用 Skill（`skill.list/skill.load`，宿主注册方法与能力包）保留；真正的“方法作为上下文存储条目、按需加载”留给阶段 2 | 定位 §2.3 要保留 `skill.list/load`；减法方案 §4:74 只把“方法阶段 P1–P4（236 行）”定为“并入编译器”，不是删除 Skill；阶段 2 尚未开始，1e 只做减法 |
| D4 | 身份文案落点 | 统一到新的唯一 L1 模块（见 D5），文案改为 “general work assistant”；`lean-prompt.ts` 内容并入该模块后删除或改名 | 文档要求改 [lean-prompt.ts:13](../src/runtime/lean-prompt.ts#L13)，但该文件只服务 lean 视图；若按 D1 删 lean 视图，必须把身份行迁到默认提示模块，否则改了也不生效 |
| D5 | 提示结构 | 保留 `initialContext` 的 L1/L2/L5 缓存前缀设计；L1 = 固定安全规则 + 通用工作助手身份（约 1.5–2.5 KB），L2 = 可选卡片/项目指令，L5 = objective；删除 `sharedKernelRules` 的旧协作/决策规则、`parallelMainGuidance`、`applyAgentFactors` 与 5 张默认卡 prompt | 缓存前缀只在 L1 后追加；L1 越短越稳定，黄金评测的缓存命中越好（基线 cacheReadShare 82.8%，见 §9） |

### 0.3 规模与净删估算

| 项 | 1e | 1f | 说明 |
|---|---:|---:|---|
| 源码整文件删除 | ≈1,059 行 | — | tool-view 158、agent-factors 53、role-view 35、method-stage 165、method-context 71、extensions/methods 134、task-graph 165、task-declare 170、task-completion 108 |
| 源码局部删除 | ≈500–650 行 | ≈150–300 行 | application/cli/web/tui/messaging/context/state-frame/card.ts 等；1f 主要是 lean-prompt/sharedKernelRules/卡片 prompt/提示类 nudge |
| 测试整删 | ≈949 行（6 文件） | — | lean-solo 232、method-stages 198、inline-methods 231、view-pointers 143、role-tool-view 89、lean-write-recovery 56（`handoff-factors` 由 1d 处理，不计） |
| 测试改写净删 | ≈350 行 | ≈50–100 行 | 单一默认不变量、prompt 断言、helpers/profile 机械改动 |
| **合计（净删）** | **≈2,700–2,900** | **≈150–350** | 不含 1b/1c/1d 自身的删除；已扣除 1e 新增不变量测试约 120–180 行的增量 |

> 预计净删：**约 2,850–3,250 行**（源码 ≈1,600–1,900，测试 ≈1,300–1,500），另有少量文档/README 段替换。1e 的删除量约为 1a 净删（1,411，[1a 地图](kodo-phase1-batch1a-map-20261103.md)）的两倍，但其中 443 行 task 三文件是 1a 明确“留给 1e”的预支。

### 0.4 批次依赖

```
1a（已合并）──► 1b（实施中）──► 1c ──► 1d ──► 1e ──► 1f
                                      │        │
                                      └─ 本图 ─┘
```

- **1d 未合入前不要动 1e**：1d 会删 `send_message/explore/exploration.plan/followup_task/report.submit/list_agents/interrupt_agent` 与 todo 依赖/派发，并把 `taskProtocol`/factors 分支从工具面清掉一部分；1e 的行号与删除量必须按 1d 合入后的树重算。
- 1c 会删名册/角色卡/派生，并把方法目录从 roster 迁到方案 A 的 `Session.methodCards`（[1c 地图 §2.3](kodo-phase1-batch1c-map-20261103.md)）。1e 随后删除该字段与整个方法阶段——**不要给 `Session.methodCards` 做产品化**，它只是 1c 的过渡形态。
- 1a 保留的 `task-graph/task-declare/task-completion`（443 行）、`method-stage/method-context/extensions-methods`（370 行）只在 1e 删除；`method-stages.test.ts` 在 1e 前必须保持绿。

---

## 1. 工具档位收敛

### 1.1 现状：4 个公开 profile + 5 张默认卡 + 2 个实验消融开关

**profile 值域与选择链**（1a 已删 lean-team，值域 4 个）：

| 层 | 位置 | 现状 |
|---|---|---|
| 类型 | [src/runtime/types.ts:114](../src/runtime/types.ts#L114) | `Session.toolProfile?: 'compact-v1' \| 'compact-v2' \| 'full' \| 'lean-solo'` |
| 宿主选项 | [src/application/index.ts:68-69](../src/application/index.ts#L68-L69) | `ApplicationOptions.toolProfile` |
| 默认值/校验 | [src/application/index.ts:170-173](../src/application/index.ts#L170-L173) | 默认 `compact-v2`；值域校验；lean profile 强制 `taskProtocol===3` |
| 持久化 | [src/application/index.ts:502](../src/application/index.ts#L502) | 新会话写入 `toolProfile`（恢复时沿用） |
| 默认卡选择 | [src/application/index.ts:142-163](../src/application/index.ts#L142-L163) | `defaultCard`（A 因子追加 roster/members）→ `legacyDefaultCard`（按 lean/探针/`!==full`/compact-v2 选卡） |
| 内置卡矩阵 | [src/agents/card.ts:146-204](../src/agents/card.ts#L146-L204) | 5 张默认卡：`defaultCard`(v0.6.0)、`compactDefaultCard`(1.0.0)、`legacySimpleDefaultCard`(1.0.0)、`simpleDefaultCard`(1.1.0)、`leanDefaultCard`(1.4.0) |
| 专家卡矩阵 | [src/agents/presets.ts:20-117](../src/agents/presets.ts#L20-L117) | `legacyBuiltinCards`/`builtinAgentCards`/`compactBuiltinAgentCards`/`simpleBuiltinAgentCards`（1c 删） |
| lean 视图 | [src/runtime/tool-view.ts:1-158](../src/runtime/tool-view.ts#L1-L158) | 只有 `lean-solo`：把内核工具重命名/裁剪为 `read/edit/write/bash/job/search/list/mkdir/move/delete/ask_user`；`resolveToolCall`/`leanToolSpecs`/`leanAllows`/`viewText`/`viewResult` |
| 工具面裁剪 | [src/runtime/role-view.ts:5-35](../src/runtime/role-view.ts#L5-L35) | `roleAllows`：lean 视图、compact-v2/compact-v1 卡片正则、workspace.integrate/commit、inlineMethods、因子 E |
| 请求规格 | [src/runtime/step-host.ts:42-55](../src/runtime/step-host.ts#L42-L55) | `toolSpecs`：inlineMethods 卡片池、lean 视图重命名、`KODO_ABLATION=small-tools` |
| CLI | [src/cli/index.ts:59](../src/cli/index.ts#L59)、[126-127](../src/cli/index.ts#L126-L127)、[233](../src/cli/index.ts#L233) | `--tool-profile compact-v2\|compact-v1\|full\|lean-solo`；只允许 run/chat；写 host-state |
| 其它引用 | `grep toolProfile` 共 **21 文件 / 63 处**（src；tests 36 文件 / 99 处） | context:84,321,382-398；model-step:119-120；step-host:52；tool-step:420；history:159,169；context-assembly:67；background-notice:39；check-hint:62,88；instruction-layer:79,93,100；summary-install:165；method-context:55；messaging:154,413；session-compat:14；cli/serve、tui-host、host-state 等 |

**实测请求面**（`new Application(state, scriptedProvider, undefined, {instructions:{global:false}})` + `createRun(permissions:['read','write','exec'])`，无模型调用）：

| 配置 | 默认卡 | 请求工具数 | 工具 JSON 字节 | 上下文消息/字节 | 系统提示字节 |
|---|---|---:|---:|---:|---:|
| **默认**（compact-v2, protocol 3, A–E 全开） | `builtin/general-simple-roster-7a3fa5bd53fb` v1.1.0（13 工具 + 4 members） | 20 | 21,648 | 4 / 9,304 | 5,827 |
| compact-v1 | `builtin/general-compact-roster-…` v1.0.0 | 24 | 22,362 | 4 / 8,611 | 5,321 |
| full | `builtin/exploration-main-roster-…` v1.1.0 | 35 | 35,388 | 4 / 9,513 | 5,779 |
| lean-solo | `builtin/general-simple` v1.4.0 | 6 | 4,379 | 3 / 1,995 | 1,855 |
| 默认但 A–E 全关 | `builtin/general-simple` v1.1.0 | 20 | 20,311 | 4 / 4,938 | 4,800 |
| 默认但 B 关 | roster 卡 | 20 | 21,648 | 4 / 8,751 | 5,274 |

结论：**profile 影响的是“卡 + 工具 + 提示”三件事**；因子 A 决定是否 roster 卡（+4 成员、目录/路由工具、roster 指令），B/C/D/E 基本只改提示（B 关时上下文少 553 字节），协议 1/2 只改工具 schema 的可选字段（tool JSON 少 2,600 / 1,592 字节）。

### 1.2 收敛后的目标形态

1. **删除 `toolProfile` 全链路**：`Session.toolProfile`、`ApplicationOptions.toolProfile`、校验、CLI `--tool-profile`、host-state/TUI 持久化、`isLeanProfile/leanProfiles/LeanProfile`、lean 视图与 `role-view.ts` 的 profile 分支。新会话不再写该字段；旧会话带 `toolProfile` → 显式 `SESSION_INCOMPATIBLE`（§3.4）。
2. **默认卡收敛为 1 张**：以 `simpleDefaultCard` 的内容为基准（1c 后已无 roster/专家卡），删除 `defaultCard`/`compactDefaultCard`/`legacySimpleDefaultCard`/`leanDefaultCard` 与 [application:142-163](../src/application/index.ts#L142-L163) 的 profile 选择/getter；默认卡保留 `nudges: true`、版本 bump（1c 已计划 bump，1e 再 bump 到最终值并冻结）。
3. **工具面固化**：默认卡 tools = 1b/1c/1d 之后剩下的内核工具（预计 `file.read/list/search/patch/apply_patch/mkdir/rename/delete`、`shell.exec`、`process.read`、`artifact.read`、`history.read/search`、`todo.read/write`、`spawn_agent`、`wait_for_events`、`inspect_run`、`cancel_agent`、`ask_user`、`skill.list/load`（有 skills 时）、`knowledge.*`（有探索/知识时）等；最终清单以 1d 合入后 `toolSpecs` 实测为准）。`step-host.ts:52` 的 lean 分支与 `tool-view.ts` 整文件删除。
4. **实验消融开关**：`KODO_ABLATION=small-tools`（[step-host.ts:53-54](../src/runtime/step-host.ts#L53-L54)）与 `KODO_ABLATION=no-state`（[model-step.ts:118-122](../src/runtime/model-step.ts#L118-L122)）只服务历史实验。建议 1f 删除（属于“单次实验规则”）；若 Lead 想保留离线复现能力，至少改为仅测试可见并写入 README 的 frozen-experiment 说明。**不保留任何 profile 作为内部测试开关**（需要窄工具面的测试显式传自定义 Card）。
5. **`default-profile-invariants.test.ts` 的处置**：该测试当前冻结 `compact-v2` 的 read-only 默认工具面（16 个工具名 + `COMPACT_V2_TOOL_SPEC_BYTES = 17_278`，[tests/default-profile-invariants.test.ts:7-29](../tests/default-profile-invariants.test.ts#L7-L29)），并断言 `session` 里 `taskProtocol:3, toolProfile:'compact-v2'`。1b/1c/1d 每批工具面都会变，因此：
   - **过渡策略**：每批合入时按该批 `toolSpecs` 实测更新 `COMPACT_V2_TOOL_SPEC_BYTES` 与工具名清单（1b 地图已要求 bump 后同步，1c/1d 同样）；文件可暂时保留旧名。
   - **1e 最终形态**：重命名为 `tests/default-request-invariants.test.ts`（或就地重写），断言：① 新会话 `session` 不含 `toolProfile/taskProtocol/agentFactors/inlineMethods/method*` 字段；② 默认工具名清单 = 最终清单；③ `Buffer.byteLength(JSON.stringify(specs))` = 最终常量；④ 默认卡 id/version/digest 固定；⑤ 首请求 `messages[0]` 字节 = 最终 L1 常量（1f 后更新一次）；⑥ 恢复旧会话抛 `SESSION_INCOMPATIBLE`。这是 1e 之后唯一的“单默认配置”护栏。

### 1.3 删除/保留清单（1e；行号为 HEAD，1b/1c/1d 后重校准）

| 文件 | 行 | 处理 |
|---|---:|---|
| `src/runtime/tool-view.ts` | 158 | **整删** |
| `src/runtime/role-view.ts` | 35 | **整删**（profile/inline/workspace 工具可见性全部消失；`roleAllows` 调用点 [step-host:51](../src/runtime/step-host.ts#L51)、[messaging:111](../src/messaging/index.ts#L111)、[tools/index:356,429,546](../src/tools/index.ts#L356)、[application:319](../src/application/index.ts#L319) 同步删） |
| `src/agents/card.ts` | 146-204 | 删 4 张卡（default/compact/legacySimple/lean），只留 1 张；`execution`/`members`/`derivation` schema 字段删（§4） |
| `src/application/index.ts` | 69,119-121,142-163,170-173,179,192-193,147-149,154 | 删 profile 相关选项/字段/getter/校验/optional tools 的 `!==full` 分支 |
| `src/runtime/context.ts` | 84,382-398,321 | 删 `toolProfile` 参数与 lean/structured 分支；保留 L1/L2/L3/L5 结构 |
| `src/runtime/instruction-layer.ts` | 79,93,100 | 删 `toolProfile` 传参与 `isLeanProfile` 判断 |
| `src/runtime/model-step.ts` | 119-120 | 删 lean 分支（`stateFrame` 统一） |
| `src/runtime/step-host.ts` | 43-44,50,52-54 | 删 inline/lean 分支；`toolSpecs` 变直线流程 |
| `src/runtime/历史/渲染引用` | history:159,169；context-assembly:67；background-notice:39；check-hint:62,88；summary-install:165；tool-step:420；method-context:55 | 删 `toolProfile` 参数与按 profile 渲染的分支（多数随 tool-view/method 删除而消失） |
| `src/messaging/index.ts` | 154,413 | 删 `toolProfile` 的 compact-v2 描述分支与 `initialContext` 传参 |
| `src/runtime/session-compat.ts` | 26 | 扩展为显式不兼容（§3.4） |
| `src/cli/index.ts` | 59,106,110,126-127,233 | 删 flag/help/校验/透传 |
| `src/cli/serve.ts` | 93 附近 | 删透传 |
| `src/cli/host-state.ts` | 72、`Policy` 字段 | 删持久化字段（旧 host-state 显式报错） |
| `src/cli/tui-host.ts` | 12 | 删 keys 中的 profile 相关项 |
| tests | — | 见 §6 |

---

## 2. A–E 因素收敛

### 2.1 现状语义

| 因子 | 语义（代码事实） | 默认 | 主要落点 |
|---|---|---|---|
| **A** 角色/名册 | 主卡升级为 `-roster` 卡（附 4 个成员 + catalog/routing）、渲染名册消息、允许 agent.*/knowledge.* 工具；`Application.agentFactors.A ?? true` | 开 | [application:145,148-152,154,194,508](../src/application/index.ts#L145)；[context:388](../src/runtime/context.ts#L388)；[instruction-layer:82,93](../src/runtime/instruction-layer.ts#L82) |
| **B** 并行/任务 | `parallelMainGuidance` 把主代理提示改为“team lead + todo 计划 + 并行派发/验收”段落；`applyAgentFactors` 替换主代理文案 | 开 | [agent-factors.ts:11-32,38-45](../src/runtime/agent-factors.ts#L11-L32)；[context:398-399](../src/runtime/context.ts#L398-L399) |
| **C** 弱模型/槽位 | 提示改用“冻结成员 + 声明输入槽”；C 只改提示方式，不改契约/权限 | 开 | [agent-factors.ts:22,46](../src/runtime/agent-factors.ts#L22)；[roster-context.ts:20](../src/runtime/roster-context.ts#L20) |
| **D** 边界/交接 | 主代理追加 `leadHandoffGuidance`；子运行 packet 追加 `childHandoffGuidance` | 开 | [agent-factors.ts:27,47](../src/runtime/agent-factors.ts#L27)；[messaging/handoff.ts:3-26](../src/messaging/handoff.ts#L3-L26)（1d 已删 handoff.ts） |
| **E** 工具档位 | 从主代理隐藏 shell/process/image/web/LSP，把执行交给子代理；提示改写 | 开 | [role-view.ts:33-34](../src/runtime/role-view.ts#L33-L34)；[agent-factors.ts:28-30,48-51](../src/runtime/agent-factors.ts#L28-L30) |

补充：1c 删除名册/路由/角色卡后，A/C 的“成员/槽位”实质消失；1d 删除 explore/send_message/followup 后，B/D 的派发文案大半过期；1d 后 E 的“执行下放”与保留的 spawn 语义也不再成立。**因此 1e 整删 A–E，默认提示只保留一套主/子结构**。

### 2.2 引用清单

- 源码（HEAD）：`agentFactors` 共 **13 文件 / 32 处**（tests 59 文件 / 163 处）：application:65,119,145,180,194,498,502,507,508,576,601；cli/host-state:21,27,29,39；messaging:97,393,409,412,413,425；runtime:context:84、instruction-layer:77、role-view:5,33、todo-execution:38、tool-step:38、types:110；tools/index:344、tools/todo:155、tools/todo-dynamic:153；agents/discovery:57。
- 提示渲染：`normalizeAgentFactors`/`applyAgentFactors`/`parallelMainGuidance`（[agent-factors.ts:6,11,35](../src/runtime/agent-factors.ts#L6)）；`delegationGuidance/teamDelegationGuidance`（[child-card.ts:4-6](../src/agents/child-card.ts#L4-L6)）；`leadHandoffGuidance/childHandoffGuidance`（1d 删）。
- 配置面：CLI `--agent-factors A,B,C[,D,E]|none`（[cli/index.ts:58,109,125](../src/cli/index.ts#L58)、[host-state:19-46](../src/cli/host-state.ts#L19-L46)）；`ApplicationOptions.agentFactors`；`Session.agentFactors`；TUI host-state。
- 测试：`agentFactors` 出现在 **59 个测试文件 / 163 处**（多数通过 [tests/helpers.ts:38](../tests/helpers.ts#L38) 的 `agentFactors:{B:false,D:false,E:false}` 或显式因子组合）；重点文件：`tests/simplicity-tools.test.ts`（并行 Guidance 断言 :100-118）、`tests/handoff-factors.test.ts`（1d 处理）、`tests/agent-context.test.ts:68,94,116`、`tests/context.test.ts`、`tests/role-tool-view.test.ts`、`tests/default-progress-policy.test.ts`、`tests/cli-optimization-config.test.ts`。
- 实验脚本：`scripts/comparison/agent-roster-v1.mjs:160` 传 `agentFactors`；`scripts/comparison/frontier/*` 读取持久化 factors 校验（冻结实验脚本，见 §8-R9）。

### 2.3 收敛后的形态与删除清单

1. **删除 `src/runtime/agent-factors.ts`（53 行整文件）**：`AgentFactors`/`normalizeAgentFactors`/`parallelMainGuidance`/`applyAgentFactors`。
2. **删除 `Session.agentFactors`**（[types.ts:110](../src/runtime/types.ts#L110)）、`ApplicationOptions.agentFactors`（[application:65](../src/application/index.ts#L65)）、默认值 `{A..E:true}`（:194）、`freezeRoster` 的 A 条件（:508；1c 已删 roster，此项随 1c 消失）。
3. **删除渲染分支**：`initialContext` 的 `applyAgentFactors`/roster/factor 条件（[context:388,398-399](../src/runtime/context.ts#L388)）；`instruction-layer` 的 factors 入参与 `enabled=factors.A||inlineMethods`（:77-82,93）；`role-view` 因子 E 段（整文件删）；`child-card` 的 delegation 段（1c/1d 处理，1e 删净）；`messaging` 的 factor 分支（1d 删大半，1e 删 [messaging:97,393,409-413,425](../src/messaging/index.ts#L97) 残项）；`tool-step:38`、`tools/index:344`、`tools/todo:155`（1d 后可能已不存在）中的 factor 条件。
4. **删除 CLI/host-state**：`--agent-factors` 选项/校验/host-state 字段与校验（[cli/index.ts:58,109,125](../src/cli/index.ts#L58)、[host-state:19-46](../src/cli/host-state.ts#L19-L46)、[tui-host:12](../src/cli/tui-host.ts#L12)）。
5. **保留**：与 factors 无关的安全/交付规则（权限、验收证据、恢复）进入 1f 的统一 L1（见 §5）；**不要**把 `parallelMainGuidance` 的某一段原样留下——它引用 1a/1c/1d 已删的 explore/todo 图/成员/角色概念。

### 2.4 测试影响

| 测试 | 处理 |
|---|---|
| `tests/simplicity-tools.test.ts:100-118` | 删 `parallelMainGuidance` 三协议断言；保留卡片身份/工具面其余断言 |
| `tests/agent-context.test.ts:68,94,116` | 删 team-lead/因子 B 断言；保留 L1 前缀共享/子运行身份断言（1f 后按新 L1 改） |
| `tests/handoff-factors.test.ts` | 1d 已随 handoff.ts 删除；若 1d 保留则 1e 整删（120 行） |
| `tests/role-tool-view.test.ts` | **整删**（role-view 删除） |
| `tests/default-progress-policy.test.ts`、`tests/cli-optimization-config.test.ts`、`tests/capability-restart.test.ts` 等 | 机械删 `agentFactors` 选项/断言；涉及 A/C 成员语义的 case 随 1c 已删 |

---

## 3. 任务协议 1|2|3 收敛

### 3.1 语义（HEAD）

| 协议 | 语义 | 关键实现 |
|---|---|---|
| **1** 旧版 | todo 单 `in_progress`；无依赖、无事件驱动等待、无执行选择 | [agent-factors.ts:21](../src/runtime/agent-factors.ts#L21)；[messaging:136-141,143,350,482,496](../src/messaging/index.ts#L136-L141)；[tools/index:298](../src/tools/index.ts#L298) |
| **2** 并行 | todo 依赖 + `dependsOn` + 派发关联 + event-driven wait（无超时） | [agent-factors.ts:20](../src/runtime/agent-factors.ts#L20)；[messaging:136,187,249,482,496](../src/messaging/index.ts#L136)；[todo-dependencies.ts:57,87](../src/runtime/todo-dependencies.ts#L57)；[progress-guard.ts:54](../src/runtime/progress-guard.ts#L54) |
| **3** 原子图（默认） | 原子任务图更新 + decisionVersion + 子运行完成证据摘要；动态 todo schema（1d 删）、`parallelTasks`/taskNode 关联 | [agent-factors.ts:18](../src/runtime/agent-factors.ts#L18)；[messaging:597](../src/messaging/index.ts#L597)；[tool-step:138](../src/runtime/tool-step.ts#L138)；[progress-guard.ts:54](../src/runtime/progress-guard.ts#L54)；[todo-dependencies.ts:57,87](../src/runtime/todo-dependencies.ts#L57) |

### 3.2 引用清单

`grep taskProtocol`（src，HEAD）：**13 文件 / 47 处**（tests 35 文件 / 84 处）——application:67,120,169,171,172,502,576,601；cli/index:128-129,233；messaging/handoff:22-24（1d 删）；messaging/index:136,143,187,249,350,412,413,482,496,597；agent-factors:11,17,19,24；context:84,382-383,398；instruction-layer:79,100；progress-guard:54；todo-dependencies:57,87（1d 删）；tool-step:138；types:112；tools/index:194,298,340,440,509；tools/todo:58,129,140（1d 改）；tests 约 35 文件（`helpers.ts:38` 固定 `taskProtocol:1`；`compact-tools` 11 处、`todo-*` 14 处、`efficiency-defaults` 8 处为矩阵断言）。

### 3.3 收敛目标

1d 把 todo 退化为纯清单、删掉依赖/派发/动态 schema 后，三个协议已无行为差异；1e 直接**删除 `taskProtocol` 字段与所有分支**：
- `Session.taskProtocol`（[types.ts:112](../src/runtime/types.ts#L112)）、`ApplicationOptions.taskProtocol`（[application:67](../src/application/index.ts#L67)）、默认 `3` 与校验（:169,171-172）、写会话（:502）、恢复 initialContext 传参（:576,601）。
- CLI `--task-protocol 1|2|3`（[cli/index.ts:59,110,128-129,233](../src/cli/index.ts#L59)）与 host-state；TUI/Web 无独立协议字段（随会话）。
- messaging 的 event-driven/timeout 分支（1d 已删大半，1e 删残项，如 [messaging:136-143,482,496](../src/messaging/index.ts#L136-L143)）；todo/agent-factors/instruction-layer/context 的协议分支（多数随 §2 删除）。
- `Run.todo` 的 generation/dependencies 字段（1d 已删依赖与派发；1e 若 1d 保留字段则一并删）；`carryRecoveryTodo` 的 dispatch 搬运（1d 处理，残留 1e 清）。
- 保留：简单 todo 清单 + `update_progress`/进度快照语义（上下文提醒仍需要；1d 已把 `update_progress` 移出协作工具，1e 决定其最终归属——建议归上下文工具，理由：它是压缩/状态帧输入，不是协作动作）。

### 3.4 兼容处置（未发布，不迁移）

沿用 1a/1b/1c 的 `SESSION_INCOMPATIBLE` 策略，扩展 [session-compat.ts:12-26](../src/runtime/session-compat.ts#L12-L26)：

| 旧数据形态 | 判定 |
|---|---|
| `session.toolProfile !== undefined`（含 lean-team/compact-v1/full/lean-solo） | 不兼容 |
| `session.taskProtocol !== undefined` | 不兼容（1e 之后只有一种私有语义，旧值无法安全降级） |
| `session.agentFactors !== undefined` | 不兼容 |
| `session.inlineMethods`/`methodUnloading`/`methodToolView`/`methodTools`/`methodSkills`/`methodCards`（1c 过渡） | 不兼容 |
| `run.taskNode`/`session.maxTaskNodes`（1a 已有） | 不兼容（保持） |
| `run.execution`（1b 处理） | 不兼容（1b 已有） |
| host-state `cli-host.json` 里的 `inlineMethods/methodUnloading/methodToolView/agents.agentFactors` | 读取时 `CLI_HOST_STATE` 明确报错（不静默忽略） |
| 旧 CLI 参数（`--tool-profile/--task-protocol/--agent-factors/--inline-methods/--method-*`） | `ARGUMENTS` 错误（参数不存在，报“unknown option”即可） |
| 旧持久化卡片（`schemaVersion:2` 带 `execution/members/derivation`） | 解析报 `CARD_SCHEMA`/`CARD_MEMBER` 明确错误；不自动降级（能力包/案例若引用旧卡需重新打包，见 §8-R5） |

**不新增 SQLite 迁移、不改 `Store.session`**（与 1a/1b 一致）；只读 API（`sessions()/inspect/gc`）仍可查看旧会话。

---

## 4. 方法阶段 P1–P4 并入上下文存储加载策略

### 4.1 现状架构

| 组件 | 位置（行数） | 职责 |
|---|---|---|
| 方法加载 | [src/runtime/method-stage.ts:1-165](../src/runtime/method-stage.ts#L1-L165) | `task` 工具：`declare/activate/extend/done/inspect/resume/redo/drop/wait`；读写任务图、绑定方法合同、知识引用校验、报告/检查证据验收、32KB 结果预算 |
| 方法上下文 | [src/runtime/method-context.ts:1-71](../src/runtime/method-context.ts#L1-L71) | 压缩检查点卸载已结束方法正文（P2）、保留 `history.read` 指针 |
| 方法合同/目录 | [src/extensions/methods.ts:1-134](../src/extensions/methods.ts#L1-L134) | `withCardMethods` 扩展 `skill.list/load`；`methodContract`/`activeMethod`/`recordMethodLoad`/`endMethod`；工具池裁剪 |
| 任务图 | [src/runtime/task-graph.ts:165](../src/runtime/task-graph.ts#L165)、[task-declare.ts:170](../src/runtime/task-declare.ts#L170)、[task-completion.ts:108](../src/runtime/task-completion.ts#L108) | 节点状态/依赖/代次/完成判定；1a 为 inlineMethods 特意保留 |
| 会话字段 | [types.ts:85-91](../src/runtime/types.ts#L85-L91) | `inlineMethods/methodUnloading/methodTools/methodSkills/methodToolView`；1c 计划再加 `methodCards` |
| 卡片字段 | [types.ts:66-67](../src/runtime/types.ts#L66-L67) | `Card.execution.modes: ('inline'\|'child')[]` + `Card.model/members` 决定 inline/child |
| 应用接线 | [application/index.ts:80-83,130-132,174-179,204,212,232,249-281,283,309-319,493-494,503](../src/application/index.ts#L80-L83) | 选项/校验/`updateSessionMethods` 热插拔/技能扩展/createRun materialized tools |
| 提示与工具面 | [instruction-layer.ts:80-100](../src/runtime/instruction-layer.ts#L80-L100)、[roster-context.ts:11-50](../src/runtime/roster-context.ts#L11-L50)、[state-frame.ts:111](../src/runtime/state-frame.ts#L111)、[step-host.ts:43-50](../src/runtime/step-host.ts#L43-L50)、[role-view.ts:6](../src/runtime/role-view.ts#L6) | 方法目录/`method`/`methodCatalog`/`stages` 状态帧、方法合同工具池 |
| 工具/命令面 | [messaging/index.ts:2-5,43,62,111,114,166-173](../src/messaging/index.ts#L2-L5)；[cli/index.ts:57,106,201-210,315-330](../src/cli/index.ts#L57)；[cli/serve.ts:16,61-64](../src/cli/serve.ts#L61-L64)；[tui/agents.ts:273-283](../src/tui/agents.ts#L273-L283)；[web/server.ts:192-193,304-315](../src/web/server.ts#L192-L193)；[cli/host-state.ts:59-60,72,83-84](../src/cli/host-state.ts#L59-L60) | `task`/`skill.*` 方法分支、`kodo methods`、`/agents methods`、`/api/runs/:id/methods`、host-state 方法策略 |
| 事件 | `method.loaded`/`method.ended`（methods.ts, method-stage）、`context.methods.unloaded`（method-context）、`agent.roster.revised`（application） | 恢复/状态帧依赖 |

P1–P4 对应：**P1** 方法正文按需 `skill.load` 进上下文并建立合同（method-stage 的 inline 激活）；**P2** 压缩检查点卸载已结束方法（method-context）；**P3** 方法引用的项目知识/来源校验（method-stage 的 `requiredRefs/knowledgeQueries`）；**P4** 稳定/活动工具视图（`methodToolView` + `effectiveMethodRun` + `methodControlTools`）。实验结论（[experiments/kodo-method-p1-p4-ablation-20261103.md](experiments/kodo-method-p1-p4-ablation-20261103.md)）：六组均未自主加载、卸载与工具切换为 0，默认关闭。

### 4.2 目标形态：方法 = 上下文存储中的可寻址内容

- **1e 只做减法**：删除“阶段编排”（task 图、方法合同、工具视图切换、卸载专用事件、热插拔），保留**通用 Skill 机制**（[extensions/skills.ts:1-62](../src/extensions/skills.ts#L1-L62) 的 `skill.list/skill.load`，宿主 `registerSkills`、能力包 skills 与卡片 `skills` 声明）。方法（团队规则/领域知识）作为 Skill/知识内容由模型按需 `skill.load` 读入，不再绑定“哪个卡片以什么 execution mode 运行”。
- **加载策略目标（阶段 2 再实现）**：方法条目进入可寻址上下文存储（带来源/版本/新鲜度），`skill.list` 或 `knowledge.search` 返回索引，`skill.load`/`knowledge.read` 按需取正文；与 §2.3“主动放入/按需拉取”表格一致。1e 只在文档中留下目标契约，不新增实现（符合“先减法、阶段 2 再加”）。
- **保留**：`extensions/skills.ts`、`Application.registerSkills` 中与 Skill 注册无关的部分（`updateSessionMethods` 整删）、能力包/作者/案例流程（“保留，冻结扩张”）、`knowledge.*` 通用工具（1e 不碰）。

### 4.3 删除清单（1e）

**整文件删（813 行）**：`method-stage.ts`(165)、`method-context.ts`(71)、`extensions/methods.ts`(134)、`task-graph.ts`(165)、`task-declare.ts`(170)、`task-completion.ts`(108)。

**局部删**：
- `application/index.ts`：inlineMethods 相关选项/字段（80-83,130-132）、校验（174-179）、知识工具 inline 分支（204,212）、技能版本（310）、`withCardMethods` 包装（319）、`updateSessionMethods`（249-281）、`validateCardRegistration` 的 members（291-294）、createRun 的 materialized tools/method 分支（493-494,503）≈160 行。
- `types.ts`：`Session.inlineMethods/methodUnloading/methodTools/methodSkills/methodToolView`（85-91）、`methodCards`（若 1c 加）、`Card.execution`（66-67）；`Card.members/derivation`（1c 后无消费者的部分）；`Run.agentId` 若 1d 未删（复用身份已删）。
- `context.ts`：`methodUnloading` 字段与 [216-229](../src/runtime/context.ts#L216-L229) 卸载块、roster/inline 条件。
- `state-frame.ts`：`session.inlineMethods` 的 method/methodCatalog/stages 字段（:111）。
- `completion.ts`：`taskGraphCompletionState` 与 `completion.task_disclosure` 分支（:8,81-123）。
- `messaging/index.ts`：`methodTaskSpec` 定义/schema/execute（:2-5,43,62,111-114,166-173）；`methodToolView/methodControlTools` 过滤。
- `cli/index.ts`（≈46 行）：`--inline-methods/--method-unloading/--method-tool-view`（57,106,201-210）、`methods` 命令（24,315-330）；`cli/serve.ts`（16,61-64）；`tui/agents.ts`（273-283）；`tui/commands.ts` 帮助；`web/server.ts` GET/POST `/api/runs/:id/methods`（192-193,304-315）与 workbench 面板；`cli/host-state.ts` 方法策略字段与校验（59-60,72,83-84）。
- `instruction-layer.ts`：`methodTokens`/`inlineMethods` 分支（80-100，1c 后 roster 部分已删）。
- `roster-context.ts`：`inline_method` 渲染（14-17,26）——1c 若整体删该文件则不计。
- 事件/数据：`method.loaded/method.ended/context.methods.unloaded/agent.roster.revised` 不再产生；旧会话含这些字段 → §3.4 不兼容。
- `card.ts`：v2 schema 的 `execution`（61）、v2Fields 里的 `execution/members`（79）、members 校验（121-126）；`serializeCard` 对应分支。

### 4.4 迁移步骤（1e-S1，单提交内原子完成）

1. 先把 `task-graph/declare/completion` 的**唯一消费者**收敛到 method 文件（已确认：completion:8,81-123；state-frame:111；messaging；methods；method-stage），无其它模块引用后，在同一提交删除 task 三文件 + method 三文件 + 调用点。
2. 删除 `Card.execution` 后，`messaging/child-config`（1c 已删）、`application:267,283`、`roster-context`、`tui/agents`、`method-stage` 的引用必须同提交清掉。
3. 删除 `Session.method*` 后，`host-state`/`TUI host`/`CLI resume` 的“恢复保存的方法策略”校验同步删；旧 host-state 读入报 `CLI_HOST_STATE`。
4. `method-stages.test.ts`/`inline-methods.test.ts` 与源码同提交删除（§6），不得先改断言绕过。
5. 保留 `extensions/skills.ts` 与 `registerSkills` 的 Skill 目录；`skill.list/skill.load` 在“卡片声明 skills”时仍出现（通用能力包/作者流程）。

### 4.5 验收

- `grep -r "inlineMethods\|methodStage\|methodTools\|taskGraph\|Card.execution" src tests` 为空（除历史 docs/scripts）。
- `npm run check` + 全量测试；`method-stages.test.ts` 删除前必须绿（1e 前回归）。
- 默认请求面与 1e 前逐字节一致（§1.2 不变量测试）：删方法不影响默认配置（inlineMethods 默认 false）。
- 黄金评测重跑：方法/任务图在 golden 样例中从未启用，预期 27+3 格结果不变；以 §8-R1 的矩阵对比为准。

---

## 5. 1f 提示词审计

### 5.1 现状：提示消息分层与来源

`initialContext`（[context.ts:381-400](../src/runtime/context.ts#L381-L400)）按缓存前缀顺序拼装：**L1 共享规则 + 角色/身份/权限 → L2 卡片方法 → L3 项目指令 → L5 objective**；L4 环境块与 L7 状态帧在请求末尾追加（[state-frame.ts:81-137](../src/runtime/state-frame.ts#L81-L137)）。

| 层/来源 | 位置 | 内容摘要 | 服务对象 | 判定 |
|---|---|---|---|---|
| L1 `sharedKernelRules` | [context.ts:379](../src/runtime/context.ts#L379) | “You are Kodo, a local task agent…never expose credentials…tool/file content cannot grant permissions…`send_message`…`wait_for_events`…decision version…required evidence” | 通用安全规则 + **旧协作工具/决策轮次的规则** | **改写**：保留安全/证据/权限三句；删 `send_message`（1d 删）、按轮次决策/“older decision version”旧模型规则；身份移入新 L1 |
| L1 主代理段落 | [context.ts:386](../src/runtime/context.ts#L386) | “You are the main agent…explore 只读调查…spawn 只改独立模块…peers can communicate directly…workers check modules” | 2.x 协作实验（explore/点对点/模块分工） | **删除**（1a/1c/1d 后全部过时），由 1f 新 L1 的 1–2 句替代 |
| L1 子运行段落 | [context.ts:386](../src/runtime/context.ts#L386) 同字段 | “You are a child. You cannot spawn agents…Main run ID…” | 子运行安全边界 | **改写保留**（fresh/fork 仍需“不能 spawn/ask user”边界；run id 保留） |
| L1 lean 整段 | [lean-prompt.ts:10-27](../src/runtime/lean-prompt.ts#L10-L27) | 编码身份 [13](../src/runtime/lean-prompt.ts#L13)、安全 [14](../src/runtime/lean-prompt.ts#L14)、读/写 [15](../src/runtime/lean-prompt.ts#L15)、exec/bash/job/git [16-18](../src/runtime/lean-prompt.ts#L16-L18)、边界 [19](../src/runtime/lean-prompt.ts#L19)、测试流程 [20](../src/runtime/lean-prompt.ts#L20)、子运行收尾 [21-24](../src/runtime/lean-prompt.ts#L21-L24)、workspace/run id [25](../src/runtime/lean-prompt.ts#L25) | lean-solo 专用（1e 删 lean 视图） | **迁移+改写**为唯一 L1：删 coding agent 身份、explore/reviewer 角色、`KODO_RUN_OUTPUT_DIR`、分支覆盖/格式化/“do not commit”实验规则；保留安全、读写纪律、exec 说明（改内核工具名）、证据交付 |
| L1 `parallelMainGuidance` | [agent-factors.ts:11-32](../src/runtime/agent-factors.ts#L11-L32) | 5 组策略段落（默认/任务图/并行 todo/弱模型槽位/交接/工具分配） | 因子 A–E 实验矩阵 | **删除**（1e 删 agent-factors；默认解析出的文本冻结到常量后 1f 改写） |
| L1 `applyAgentFactors` | [agent-factors.ts:34-53](../src/runtime/agent-factors.ts#L34-L53) | 把默认卡 prompt 改写成 team lead/成员/交接/工具下放版本 | 因子实验 | **删除** |
| L2 卡片方法 | [card.ts:146-204](../src/agents/card.ts#L146-L204) | 5 张默认卡的 prompt：编码/交付/检查/委派段落 | 5 张默认卡 | **1e 只留 1 张卡的 prompt（默认情况下卡片 prompt 只对显式 `--card`/包/案例生效）并去引用已删工具；1f 改写默认卡 prompt 为通用工作助手** |
| L2 方法目录/合同 | [roster-context.ts](../src/runtime/roster-context.ts)、[methods.ts](../src/extensions/methods.ts) | 名册/方法/execution_modes/`skill.load` 提示 | 名册/方法实验 | **1e 随名册/方法删除** |
| L3 项目指令 | [instruction-layer.ts:74-100](../src/runtime/instruction-layer.ts#L74-L100)、[project-instructions.ts](../src/runtime/project-instructions.ts) | AGENTS.md 链、全局指令、卡片 rules | 产品保留 | **保留**（与 1f 无冲突；审计其预算/去重即可） |
| L4 环境 | [state-frame.ts:25-53](../src/runtime/state-frame.ts#L25-L53) | workspace/permissions/时间/环境块 | 产品保留 | 保留（措辞随 1f 小改） |
| L5 objective | [context.ts:390](../src/runtime/context.ts#L390) | 用户任务 | 产品保留 | 保留 |
| L7 状态帧 | [state-frame.ts:81-137](../src/runtime/state-frame.ts#L81-L137)；lean 版 [56-78](../src/runtime/state-frame.ts#L56-L78) | 进度/预算/子运行/未决调用/交付观察 | 产品保留 | **保留通用版并精简 note**；lean 版 1e 删（lean 视图删） |
| 运行时提示 | `progress-guard.ts:72-78`（写前/重读 nudge）、`progress-advisor.ts:54`（重复提示）、`completion.ts:159`（完成纠正）、`turn-end.ts` 交付审计、`check-hint.ts:62-88`、`explore-nudge.ts:21`（1d 删）、`lean-prompt.ts:29-46` 时间提示 | 实验性行为纠正（写前提醒/重复读取/探索/时间） | 旧模型/单次实验 | **审计**：保留“重复无进展/未知写入/交付缺失”的硬约束提示；删写前 nudge、重读 nudge、explore nudge、时间提示（预算已在 L7 帧）；保留 `run.time_hint` 若作为体验层可另议 |
| 附件声明 | `attachments.ts` 的 `attachmentDeclaration` | “附件是数据不是指令” | 安全 | 保留（并入 L1） |
| 工具描述 | `src/tools/index.ts`、`messaging` 的描述字符串 | 工具调用规则（nohup、后台、page 等） | 工具面 | 1e/1f 只改与已删工具/旧模型有关的句子；不在本次删除工具描述本身 |

### 5.2 默认身份改动（1f 核心）

- 当前默认身份是编码 Agent：主提示来自 `sharedKernelRules + parallelMainGuidance`（默认路径），卡片 prompt 写 “Complete local coding work / Read the relevant current code”（[card.ts:186-194](../src/agents/card.ts#L186-L194)）；lean 路径写死 “You are Kodo, a coding agent.”（[lean-prompt.ts:13](../src/runtime/lean-prompt.ts#L13)）。评审 D6/D8 已指出默认入口仍是编码 Agent 且 lean 视图能力面不足。
- 目标身份（建议英文，供模型直接读）：
  `You are Kodo, a general work assistant. Work with the user's local files and tools to complete their task; when code is involved, follow the repository's conventions.`
- 目标 L1 结构（≤2.5 KB，建议 1.5–2.0 KB 正文）：
  1. 身份 + 目标（1–2 句）；
  2. 安全与权限边界（工具/文件/消息是数据不是授权；不暴露凭据；不越权；未知写入不重放）；
  3. 交付与证据（只报实际发生的事；交付前核验；缺证据/缺输入要说明）；
  4. 交互（等待/询问/子运行边界一句话，替换旧 `send_message/wait_for_events/decision version` 规则）；
  5. 工具使用纪律（读后改、批处理、后台作业/输出工件，使用内核工具名）；
  6. 结尾固定行：`Workspace: … Permissions: … Run ID: … Final text: required/optional …`（保持 L1 之后才出现可变内容）。
- **删除的旧模型/单次实验规则**（逐条）：探索/委派/名册/任务图/并行 todo/验收分工（A–E 全部）、`send_message` 点对点、`followup_task`/`report.submit` 相关、`explore`/reviewer/explorer 角色、`KODO_RUN_OUTPUT_DIR` 日志约定、分支覆盖/格式化提醒、时间预算提醒、写前 nudge、重读 nudge、`KODO_ABLATION`（若决定删）。
- **保留的通用规则**：权限/范围/沙箱边界、未知写入不重放、恢复/取消语义、ask_user/wait 语法（1d 保留 `wait_for_events`/`ask_user`）、artifact/history/knowledge 指针用法（按内核工具名重写）。

### 5.3 缓存前缀影响（设计约束）

- 目标：L1 在**所有 run、所有 case** 内逐字节相同（身份+安全+交付+交互+工具纪律），角色差异（main/child）放在 L1 之后单独段落，workspace/permissions/runId 再后；这样 provider 前缀缓存在新 run 的首请求可复用 L1，且升级 1f 只需一次失效。
- 当前默认 L1 首消息 5,827 字节（含主代理长段）；目标 L1（不含可变尾）约 1.5–2.5 KB。基线 meanTokens 212,828/run、cacheReadShare 82.8%（§9），L1 大小变化本身对 token 的影响 <1%；**真正的风险是行为/工具纪律变化**导致调用次数与读取量变化，必须用 27 格矩阵复测（§8-R1）。
- 禁止：不要在 L1 中放 workspace 路径/run id/权限列表/日期（会破坏跨 run 缓存复用）；不要把卡片 prompt 拼进 L1（L2 单独层，保持可替换）。

### 5.4 提示测试与冻结常量

- 新增/改写测试（详见 §6.4）：
  - `tests/default-request-invariants.test.ts`：L1 首请求字节常量 + 首请求 `tools` 字节常量 + 无 profile/protocol/factor 字段断言；
  - `tests/prompt-identity.test.ts`（或并入上者）：`messages[0]` 含新身份句、不含删掉的旧规则关键词（`send_message`、`explore`、`task graph`、`team lead`、`coding agent`、`KODO_RUN_OUTPUT_DIR`、`coverage`）；
  - L1 跨 run 一致性：两个不同 workspace/permissions 的 run，首消息去掉可变尾后逐字节相同（复用现有 context.test.ts:47-67 思路）。
- 1f 完成后把“L1 字节数/哈希”写入 registration/测试，作为阶段 2 的缓存前缀基线。

---

## 6. 关联测试清单

> 行号为 HEAD 近似值；1b/1c/1d 会先行删改一部分（尤其 agent-*、todo-*、collaboration-*、execution-*），**1e 实施前按 `git grep` 重算**。测试原则：不得通过改断言绕过失败；被删功能的测试随源码同提交删除。

### 6.1 整删（1e 直接相关）

| 测试 | 行 | 理由 |
|---|---:|---|
| `tests/method-stages.test.ts` | 198 | P1–P4 阶段机制删除 |
| `tests/inline-methods.test.ts` | 231 | 卡片方法/热插拔删除（1c 过渡形态一并删） |
| `tests/lean-solo.test.ts` | 232 | lean 视图/lean prompt/leanStateFrame 删除 |
| `tests/view-pointers.test.ts` | 143 | lean 视图的 artifact/history 指针渲染（11 处 lean-solo 引用） |
| `tests/role-tool-view.test.ts` | 89 | `roleAllows`/profile/因子 E 可见性删除 |
| `tests/lean-write-recovery.test.ts` | 56 | lean 视图写恢复路径删除 |

### 6.2 重写（保留文件名或小改）

| 测试 | 行 | 改动 |
|---|---:|---|
| `tests/default-profile-invariants.test.ts` | 36 | 改为单一默认配置不变量（§1.2-5）；删除 `lean-team` profile 拒绝断言（参数已不存在，改为“未知选项/旧会话不兼容”） |
| `tests/efficiency-defaults.test.ts` | 60 | 删 profile/protocol/因子/旧会话恢复断言；保留“读会话无版本字段时请求词表不变”→ 改为 `SESSION_INCOMPATIBLE` |
| `tests/simplicity-tools.test.ts` | 134 | 删 `parallelMainGuidance` 三协议断言（100-118）与 profile 卡断言；保留卡工具面/身份检查 |
| `tests/simplicity-runtime.test.ts` | 78 | 删“重开旧 profile 默认值”断言，改为默认配置恢复断言 |
| `tests/compact-tools.test.ts` | 171 | 删 compact-v1/lean-solo/full 矩阵；保留默认工具面与 `custom card` 断言；作为 1e 默认字节测试的输入 |
| `tests/context.test.ts` | 378 | 保留 L1 共享前缀/子运行身份结构；删 factors/taskProtocol 入参；1f 后更新 L1 文本断言 |
| `tests/agent-context.test.ts` | 251 | 删 team lead/factors B 断言（68,94,116）；保留子运行/权限结构（1f 后按新 L1 改） |
| `tests/default-progress-policy.test.ts` | 55 | 删 taskProtocol/派发断言；保留进度快照断言 |
| `tests/cli-optimization-config.test.ts` | 44 | 删 inlineMethods/methodUnloading 持久化断言（59 行附近）；保留 memory/lazyTools/verification |
| `tests/cli.test.ts` | 599 | 删 `--tool-profile/--task-protocol/--agent-factors/--inline-methods` 用例；保留未知参数报错并新增“旧参数不存在”断言 |
| `tests/cli-workbench.test.ts`、`tests/web.test.ts`、`tests/tui-agents.test.ts`、`tests/tui-*.test.ts` | — | 删 methods/drafts/profile 投影与命令；保留默认 workbench、spawn、todo 简单清单 |
| `tests/handoff-factors.test.ts` | 120 | 1d 已删 handoff.ts；若 1d 未删则 1e 整删 |
| `tests/agent-card-runtime.test.ts` / `agent-card-v2.test.ts` / `agent-presets.test.ts` 等 | — | 1c 处理专家卡/派生；1e 只删 `execution/members/derivation` 字段断言与 4 张默认卡断言 |

### 6.3 机械改动（不改语义）

- [tests/helpers.ts:38](../tests/helpers.ts#L38)：`fixture()` 目前用 `{ taskProtocol:1, toolProfile:'full', agentFactors:{B:false,D:false,E:false} }` 来获得完整工具面。1e 后这些选项不存在，改为默认配置；**119 个引用文件的工具面将从 full(35 工具) 收缩为默认(20 工具)**——但 1c/1d 已删除 agent.*/knowledge.*/explore/todo 图等依赖，预计多数测试已随批删改；1e 实施前必须先跑一遍 `npx vitest run` 定位剩余依赖（§8-R4）。
- 36 个含 `toolProfile`、35 个含 `taskProtocol`、59 个含 `agentFactors` 的测试文件做参数删除；实验脚本（`scripts/comparison/frontier/*`、`scripts/comparison/agent-roster-v1.mjs`）是冻结历史，**不改**（§8-R9）。

### 6.4 新增

| 测试 | 断言 |
|---|---|
| `tests/default-request-invariants.test.ts`（或重写现文件） | ① 新会话无 `toolProfile/taskProtocol/agentFactors/inlineMethods/method*` 字段；② 默认工具名清单与顺序固定；③ `JSON.stringify(specs)` 字节常量；④ 默认卡 id/version/digest 固定；⑤ L1 首请求字节/哈希固定；⑥ 旧会话字段 → `SESSION_INCOMPATIBLE` |
| `tests/session-incompatibility.test.ts`（扩展现有 `session-compatibility.test.ts`） | 分别构造带 `toolProfile/taskProtocol/agentFactors/inlineMethods/methodToolView/methodCards/maxTaskNodes` 的持久会话，`Application.run/recover/submitInput/spawnAgent` 均抛 `SESSION_INCOMPATIBLE`；只读 `sessions/inspect/gc` 可用 |
| `tests/cli-legacy-options.test.ts`（可并入 cli.test） | 旧参数 `--tool-profile/--task-protocol/--agent-factors/--inline-methods/--method-*` 均报 unknown/`ARGUMENTS`；host-state 旧字段报 `CLI_HOST_STATE` |
| `tests/prompt-identity.test.ts`（1f） | 新身份句存在；旧规则关键词（`coding agent`、`send_message`、`explore`、`team lead`、`task graph`、`KODO_RUN_OUTPUT_DIR`、`coverage`）不存在；L1 跨 workspace 前缀一致 |

---

## 7. 提交计划（1e 3 步 + 1f 2 步，每步可独立编译+测试）

### 1e-S1：删除 P1–P4 方法阶段 + task 三文件（纯删除，默认行为不变）

- 内容：删 `method-stage/method-context/extensions/methods/task-graph/task-declare/task-completion`；清 application/context/state-frame/completion/messaging/instruction-layer/roster-context/cli/serve/tui/web/host-state/card 的方法引用；删 `Card.execution`、`Session.method*`（及 1c 的 `methodCards`）；删对应测试（§6.1 的前 2 个）。
- 保留：`extensions/skills.ts`、`registerSkills`、能力包/案例/作者流程。
- 验证：`npm run check`；`npx vitest run tests/method-stages.test.ts tests/inline-methods.test.ts`（删除前先跑绿，删除后文件不存在）；`npx vitest run tests/cases.test.ts tests/application-packages.test.ts tests/agent-card-v2.test.ts`；黄金 dry-run 冒烟（`node scripts/golden/run.mjs --dry --cases data-01-stats-chart,coding-01-statemachine --repeat 1`）。
- 风险：`task` 三文件的隐藏消费者（completion/state-frame/messaging/methods）漏删 → 编译失败（可控）；`Card.execution` 误删导致能力包/案例卡解析失败（见 §8-R7）。

### 1e-S2：收敛 4 个 profile / A–E / 3 个协议为单一默认（默认请求逐字节不变）

- 内容：删 `tool-view.ts`、`role-view.ts`、`agent-factors.ts`、`Session.toolProfile/taskProtocol/agentFactors`、`ApplicationOptions` 对应项、CLI/TUI/Web/host-state 字段与校验；5 张默认卡收敛为 1 张（版本 bump）；**把当前默认解析文本冻结成常量**（当前 `sharedKernelRules` + `parallelMainGuidance(defaults)` + `simpleDefaultCard.prompt` 的拼接结果原样保留，禁止顺手改写），保证默认请求与 1e 前逐字节一致；重写 `default-profile-invariants` 为 `default-request-invariants`。
- 保留：`simpleDefaultCard` 的工具清单按 1d 合入后实测；不改工具描述。
- 验证：`npm run check`；新不变量测试（默认工具字节、L1 字节、默认卡 id/version）；`npx vitest run tests/default-profile-invariants.test.ts tests/efficiency-defaults.test.ts tests/compact-tools.test.ts tests/simplicity-tools.test.ts tests/simplicity-runtime.test.ts tests/context.test.ts`；黄金 dry-run；**对比 1e-S1 前后的首批请求快照（工具 JSON 字节 + messages[0] 字节）必须相等**。
- 风险：默认请求字节变化 → 黄金缓存前缀/成本变化（§8-R2）；`helpers.ts` 默认面收缩导致大量测试失败（§8-R4）；4 张默认卡删得太早导致 1c 过渡卡引用断裂（需在 1c 合入后确认）。

### 1e-S3：兼容闸门、清理与文档

- 内容：扩展 `session-compat.ts`（§3.4 全字段）；host-state 旧字段显式报错；删除残余 profile/factor/protocol 参数与文档；标记历史文档（`inline-methods.md`、`agent-card-design.md`、`agent-delegation-optimization-design.md`、`kodo-lean-parallel-plan.md`、`design.md` 中 1e 相关段为“已被删除/历史”）；更新 README:7/418、`cli-host-configuration.md:227,231`、阶段 1 状态表。
- 验证：`npm run check`；`npx vitest run tests/session-compatibility.test.ts tests/cli.test.ts tests/cli-config.test.ts tests/web.test.ts tests/tui-host.test.ts`；黄金 dry-run；grep 确认无 `toolProfile/taskProtocol/agentFactors/inlineMethods/methodStage` 源码引用。
- 风险：旧 host-state/旧 CLI 用户（内部）升级报错——按“未发布、不兼容”策略接受并写入 release notes。

### 1f-S4：唯一 L1 提示模块 + 默认身份改为通用工作助手

- 内容：以 [lean-prompt.ts:10-27](../src/runtime/lean-prompt.ts#L10-L27) 为底稿新建/改造唯一 L1 模块（建议 `src/runtime/system-prompt.ts`，或保留 `lean-prompt.ts` 文件名并更新导出）；写通用工作助手身份 + 安全/交付/交互/工具纪律（§5.2）；`initialContext` 改为 L1 常量 + 角色/子运行前后段；删 `sharedKernelRules` 旧协作句子、默认卡 prompt 的编码/委派段（1e 冻结常量替换）；删 1f 判定的旧模型/实验规则；更新 `default-request-invariants` 的 L1 字节常量；新增 `prompt-identity` 测试。
- 验证：`npm run check`；`npx vitest run tests/context.test.ts tests/agent-context.test.ts`；黄金 dry-run；**黄金 27 格真实重跑**（9 文本样例 ×3）并用 `node scripts/golden/compare.mjs --baseline .kodo/golden/baseline-20261103 --candidate <out> --cases <9 cases>` 出结论；coding-01 至少 `loadCase`+dry 冒烟。
- 风险：质量/成本翻转（§8-R1）；首请求缓存前缀失效（一次）。

### 1f-S5：提示类 nudge 审计 + 文档/基线记录

- 内容：按 §5.1 的“审计”行处理进度/重读/写前/时间提示（保留硬约束、删实验性提醒）；同步工具描述中引用已删工具的句子（`send_message/explore/followup/report.submit/workspace.commit` 等，1d 已删大半，此处收尾）；README/design/历史文档标注；更新阶段 1 状态文档与黄金基线说明（记录 1f 后新基线，阶段 2 以它为新参照）。
- 验证：`npm run check`；全量 `npx vitest run`；黄金 dry-run；记录 1f 后 27 格结果与对比结论（门槛按状态文档 §门槛口径：合格数不低于基线、无新增 `(cell,rule)`、匹配格 token 中位数比 ≤1.10、复测单格翻转）。
- 风险：删提示导致行为回归（用 27 格矩阵判定）；nudge 删除影响 `progress-*` 测试；文档改动面大但低风险。

---

## 8. 风险清单（按优先级）

### R1（高）默认提示/工具集合变化 → 黄金评测翻转与成本门槛

- 事实：阶段 0 基线（`.kodo/golden/baseline-20261103/summary.json`，paid, deepseek-v4.1-flash）30 格完成，22 passed；9 文本样例 22/27；23 格 usage 齐全（7 格 usage 不完整：coding×3 + data-01:r2/lit-02:r2/lit-03:r2/lit-04:r3，均已被 compare.mjs 的 `explainedUsage` 视为可解释：`agentCancelledUnknown+providerFailures ≥ unknownCalls`）；meanTokens=212,828、meanCacheReadShare=82.84%、meanWallMs=87,984；main reread 44/192=22.9%，child 7/17=41.2%，childRereadOfMain=0/10。
- 1e 策略：默认请求逐字节不变（S1/S2 冻结常量 + 不变量测试），黄金结果应完全一致；**1e 不重跑也可用 dry-run + 请求字节比对作为第一道验证**，但按状态文档门槛仍需候选矩阵。
- 1f 策略：只改一次 L1/卡 prompt；1f 完成后跑 27 格矩阵，用 `compare.mjs --cases` 按状态文档门槛判定；单格翻转必须复测（同代码重跑也会翻转的不计回归）。若成本/耗时>10% 退化：先回滚提示变更或缩小改动（L1 每句改动都要有测试/证据），不扩大范围。
- 缓存：L1 变更使首次请求缓存失效（一次）；基线 cacheReadShare 82.8% 是批内/批间共同结果，1f 后显著下降属预期，作为信息报告，不作门槛（门槛用匹配格 token 中位数比，见状态文档 §门槛口径）。

### R2（高）`compact-v2` 工具目录字节不变量

- 现状：`tests/default-profile-invariants.test.ts:8` 冻结 `COMPACT_V2_TOOL_SPEC_BYTES=17,278`（read-only 默认，16 工具）与精确工具名清单；实测 rwe 默认 21,648 字节/20 工具。1b/1c/1d 每批都会改变工具面，**该常量必须每批显式更新并在提交信息中记录原因**（1b 地图已要求）。
- 1e 最终形态：单一默认配置不变量（工具名+顺序+字节+卡 id/version/digest+L1 字节），且同时覆盖 read-only 与 rwe 两种权限面（当前测试只覆盖 read-only）；把“字节变化必须显式更新常量”的注释保留。
- 失败模式：如果 1e 删掉该测试或只删不对断言 → 后续批次静默改变默认请求面，黄金成本/缓存漂移无从归因。**该测试是 1e 的核心交付物，不能只删不建。**

### R3（高）`method-stages.test.ts` 必须保持绿到 1e 删除时刻

- 1a 保留 task 三文件正是为了让 `method-stages.test.ts` 在 1b/1c/1d 期间保持绿（[1a 地图](kodo-phase1-batch1a-map-20261103.md) §9）；1b/1c/1d 均不得碰它们。
- 1e-S1 删除时：先跑 `npx vitest run tests/method-stages.test.ts tests/inline-methods.test.ts` 确认绿，再同提交删除源码与测试；**禁止先改断言**。删除后 `grep -r "method-stage\|methodTools\|inlineMethods\|Card.execution" src tests` 必须为空。
- 风险：`completion.ts`/`state-frame.ts`/`messaging` 的残留引用导致编译失败（可控）；`Card.execution.modes` 被能力包/案例卡使用（§8-R7）。

### R4（中高）`tests/helpers.ts` 默认面收缩波及 119 个测试文件

- 现状 `fixture()` 用 `taskProtocol:1, toolProfile:'full'` 获得 35 工具/旧协议语义；1e 删除参数后，所有 fixture 测试改用默认 20 工具面。1c/1d 已删除依赖 agent.*/knowledge.*/explore/todo 图的测试，但 **1e 仍可能有 20–40 个测试因工具不存在/提示变化而失败**。
- 缓解：1e-S2 前先在临时分支把 `helpers.ts` 改为默认配置跑一次全量，列出失败清单并按 §6 分类（删功能测试 vs 显式自定义卡 vs 机械改）；不要为了少改测试而保留 profile 开关。

### R5（中）旧数据/旧配置兼容

- 未发布策略：旧会话/旧 host-state/旧 CLI 参数一律显式报错（§3.4），不迁移、不静默降级；只读 API 仍可查看。
- 旧卡片：`schemaVersion:2` 且带 `execution/members/derivation/model` 的持久化卡（能力包/案例/用户卡）在 1e 后解析失败需重新打包；需在合并提交/README 说明，并给 `kodo package`/案例作者一个明确错误信息（不要静默丢弃字段）。`Card.routing.mode`（read/review 权限过滤，[application:484-494](../src/application/index.ts#L484-L494)）建议保留——它不是名册概念，而是卡片权限声明；`Card.catalog/members/derivation/execution` 删除。

### R6（中）文档与冻结实验脚本

- 需更新：`README.md:7,418`、`docs/cli-host-configuration.md:227,231`、`docs/inline-methods.md`（整篇标历史）、`docs/agent-card-design.md:495-497`、`docs/agent-delegation-optimization-design.md:82`、`docs/kodo-lean-parallel-plan.md:5,503`、`docs/design.md` 相关段落、阶段 1 状态表；`docs/experiments/**` 与 `scripts/comparison/frontier/*`（lean-ablation/method-ablation/efficiency-comparison 等）引用已删 flag/字段，**保持冻结、只加“针对冻结构建”的标注**；若某个脚本直接 import 当前 `src`（如 `method-ablation.test.mjs:37` 用 `toolProfile`），需在 1e 同批改为历史/删除该测试。
- 风险：若某冻结脚本运行当前构建会因未知参数失败——这是预期（历史脚本只对冻结 build 有效），在文档注明即可。

### R7（中）默认卡/能力包卡字段裁剪顺序

- `Card.execution/members/derivation` 与默认卡 5→1 分属 1c（专家卡/名册）、1e（默认卡+类型裁剪）两批；若 1c 已把默认卡 prompt/版本改过，1e 再 bump 时需同步 `default-profile-invariants` 的卡 id/version 断言与 cases/包 fixture（`caseDigest`/`card version` 冻结）。
- 建议 1e 默认卡版本号一次到位（如 `simpleDefaultCard` → `1.2.0`/最终值），1f 只改 prompt 文本不改版本（或按仓库惯例改 prompt 必须 bump：若 1f 改 prompt，则默认卡版本再 bump 一次，测试常量同步）。

### R8（低中）黄金门槛口径与数据完整性

- 全量 30 格中 7 格 usage 不完整（3 coding + 4 文本），compare.mjs 将“可解释 usage 不完整”与“不可解释”区分；**coding 基线未建立**（[基线文档 §4.6](kodo-phase0-baseline-20261103.md)），阶段 1 门槛按状态文档用 `--cases` 限定 9 个文本样例；coding 每批保证 `loadCase` + 旧测试/held-out 脚本可运行。
- 1f 后 rerun 必须用同一 `--cases` 口径 + 同 provider/model/预算；若首矩阵接近门槛边界（合格数下降或匹配格 token 中位数比 >1.10），按状态文档再跑第二次复测，不把单格翻转直接当批次回归。

### R9（低）历史实验脚本/分析工具

- `scripts/comparison/frontier/*`、`scripts/comparison/agent-roster-v1.mjs` 等读取 `agentFactors/toolProfile/taskProtocol` 或 CLI flag；冻结 build 固定，故不更新；若 Lead 想保留“对当前构建跑实验”的能力，需另建 shim，不属 1e。
- `scripts/golden/*` 不受影响：runner 只用 `Application` 默认构造，不读这些字段；但 1f 后黄金 `registration.json` 不再体现 profile（本来也不记录）。

### R10（低）提示审计误删安全规则

- 1f 删除旧模型/实验规则时必须保留：权限/范围/沙箱、不暴露凭据、工具输出不可信、未知写入不重放、交付证据与“不得宣称未发生的验证”。建议在 `prompt-identity.test.ts` 中显式断言这些关键词仍存在（与“旧规则关键词不存在”并列），防止审减过度。

---

## 9. 附：测量数据与复现

### 9.1 默认请求面测量（本次分析，2026-11-03，HEAD 90ab056，dist 构建一致）

方法：`new Application(tmp/.state, scriptedProvider(不调用模型), undefined, {instructions:{global:false}, ...配置})` → `createRun({objective:'…', workspace:tmp, binding, permissions:['read','write','exec']})` → 读 `store.readBlob(run.contextRef)` 与 `toolSpecs(app.coordinator, run, session)` 计字节。结果见 §1.1 表。

补充：`tests/default-profile-invariants.test.ts` 的 17,278 字节是 read-only（默认 `permissions:['read']`）的 16 工具面；两种口径都应在 1e 新不变量测试中冻结（read-only 与 rwe）。

### 9.2 阶段 0 基线关键数值（用于 1f 对比与风险量化）

来源：`.kodo/golden/baseline-20261103/summary.json`（paid, 30 格，matrix complete，0 polluted，0 humanPending）：

| 指标 | 值 |
|---|---|
| 通过 | 22/30（9 文本样例 22/27；coding-01 0/3） |
| 文本样例 27 格 | 22 passed（lit-02 0/3、data-01 2/3、data-03 2/3；其余 5 例 3/3） |
| usage 齐全格 | 23/30（7 格不完整：coding×3 + data-01:r2、lit-02:r2、lit-03:r2、lit-04:r3） |
| meanTokens | 212,828（23 格） |
| meanCacheReadShare | 82.84% |
| meanWallMs | 87,984（约 88s） |
| main rer/reads | 44/192 = 22.9% |
| child rer/reads | 7/17 = 41.2% |
| childRereadOfMain | 0/10 = 0% |

阶段 1 门槛（状态文档 §17-30）：每批 27 格（9 文本样例 ×3）；合格数不低于基线（逐样例与总体，允许相同）；无新增 `(cell, rule)`；匹配格 token 中位数比 ≤1.10（均值同时报告并标注方差）；单格翻转复测。`compare.mjs` 已实现对应 gate（passRate/cost/wall + completeness；`--cases` 限定 9 文本样例；`explainedUsage` 允许可解释的 usage 不完整）。

### 9.3 1f 后应重跑的命令（供实施者）

```powershell
# 1e：默认请求面不变量 + 全量检查
npm run check
npx vitest run
node scripts/golden/run.mjs --dry --repeat 1 --concurrency 4 --out .kodo/golden/phase1e-dry

# 1f：27 格真实矩阵（9 文本样例，同基线配置）
node scripts/golden/run.mjs --run --provider-config test_api.json --repeat 3 --concurrency 4 `
  --cases data-01-stats-chart,data-02-clean-merge,data-03-periodic-report,lit-01-comparison-table,lit-02-review-draft,lit-03-data-extraction,lit-04-advisor-revision,report-01-multi-source-summary,report-02-meeting-minutes `
  --out .kodo/golden/phase1f-20261103
node scripts/golden/compare.mjs --baseline .kodo/golden/baseline-20261103 --candidate .kodo/golden/phase1f-20261103 --cases <同上 9 个 case> --fail-on-gate
```

> 说明：上表命令按当前 `compare.mjs` 的 `--cases` 用法写（提交 `826f498` 起的 scoped 对比）；若 1f 实施时 compare 口径变化，以 `node scripts/golden/compare.mjs --help` 为准。

---

## 10. 待 Lead 决策（阻塞实施，需在 1e-S1 前确认）

1. **D1 默认形态**：确认“单默认 = 当前 compact-v2 请求面”而不是 lean 形态（本文推荐前者；若选 lean，需要先把 skill/knowledge/MCP/web/verify 接进 lean 视图并重建阶段 0 基线，不属于 1e 的减法范围）。
2. **D3 方法去向**：确认 1e 删除 P1–P4 阶段机制、保留通用 Skill/能力包/案例（本文推荐）；如果产品要保留“方法”作为一等对象，则 1e 只删 task 图/阶段绑定、保留 `skill.load` 并推迟到阶段 2，范围需重写。
3. **Card 字段裁剪边界**：确认 1e 删除 `execution/members/derivation/catalog`，保留 `routing/inputs/report/constraints/mcp/skills`，以及 `model`（若 1c 未删 modelRoles/modelBindings 则保留；若 1c 一并删除则同步删）。
4. **内部实验开关**：`KODO_ABLATION=small-tools/no-state` 是删还是保留为 dev-only（本文建议 1f 删除，历史实验用冻结 build）。
5. **默认卡版本**：1e 收敛时 bump 到哪个版本；1f 改 prompt 是否再 bump（仓库惯例是 prompt 变则 bump）。
6. **文档历史标注策略**：`docs/experiments/**`、`scripts/comparison/frontier/**` 只加“frozen build”标注，不重写（与 1a 的决定一致）；`docs/inline-methods.md` 是否整体标“已删除功能”。
7. **1e/1f 是否合并为一次合并提交**：建议分开合并（1e 保默认请求字节不变，1f 单独承担黄金矩阵复测），否则无法区分“删除导致”与“提示导致”的翻转。

---

## 11. 与 1b/1c/1d 的边界复述（避免重复删除）

| 归属 | 内容 |
|---|---|
| 1b（进行中） | `execution-*` 隔离检出/集成、`spawn_agent.execution` 参数、`workspace.commit/integrate`、`Run.execution`；**不碰** toolProfile/factors/protocols/method 字段 |
| 1c（地图已有） | 名册/路由/留存/派生/预设/专家卡、`Card.members/catalog/derivation` 的消费方（1e 才裁类型）、报告机制迁 `runtime/report.ts`、`Card.execution.modes` 保留到 1e、方法目录过渡方案 `Session.methodCards` |
| 1d（地图已有） | 协作工具收敛到 5 个、spawn fresh/fork、todo 去依赖/派发、删 `handoff.ts`/explore/exploration、`taskProtocol` 分支仅按 1d 的“不动协议逻辑”边界处理；`task-graph/declare/completion`、`method-*`、`Card.execution.modes`、`Session.taskProtocol/agentFactors/toolProfile` **留给 1e** |
| **1e（本文）** | 删 toolProfile/tool-view/role-view/agent-factors/taskProtocol、5→1 默认卡、Card.execution/members/derivation、P1–P4 阶段 + task 三文件、CLI/Web/TUI/host-state 对应入口；扩展 session-compat；建单一默认不变量测试 |
| **1f（本文）** | 唯一 L1 提示模块（通用工作助手身份）、删除旧模型/单次实验规则、卡片默认 prompt 改写、提示类 nudge 审计、黄金 27 格复测与基线记录 |

---

*本文为只读分析产物；行号会随 1b/1c/1d 合入而变化，实施前请按 §6/§0.4 重校准。*
