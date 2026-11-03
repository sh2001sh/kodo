# Kodo 阶段驱动能力挂载：设计与实现状态审计（2026-11-03）

> 审计对象：[阶段驱动能力挂载设计](kodo-stage-capability-design-20261103.md)（评审后历史设计）与 [实现说明](inline-methods.md)（现行接口/行为说明）。
> 审计时间：2026-11-03 13:48–14:15（Asia/Shanghai）。
> 方法：6 路只读代码审计（P1/P2/P3/P4、构建与测试、实验证据）+ 结果目录只读核验；未修改产品代码，未运行新的真实模型实验。
> 一句话结论：**P1–P4 已全部实现并接入生产路径，默认关闭；构建、类型检查与相关合同测试通过；但真实模型中机制从未被触发，收益没有任何验证。实现进度领先证据进度，属于「已实现、未验证」，不是「已验证无效」，更不是「已证伪」。**

## 0. 结论摘要

- **范围**：设计文档正文（§1–§8）仍按「先只做 P1、验证后决定」的历史排期书写；文档头部第 1/5 行记录了用户随后要求覆盖 P1–P4，`.kodo/method-context-ablation-20261103/administrative-stop.json` 也留了同一授权。实际代码已覆盖 P1–P4，且 `docs/inline-methods.md` 是唯一现行的接口与边界说明。
- **实现**：P1（卡片 `execution`、`skill.list/load` 方法目录、隐式阶段事件、失效说明、持久恢复）、P2（压缩检查点物理卸载）、P3（显式阶段协议 + 知识发布 + stable/active 工具视图）、P4（会话内热安装/停用 + CLI/TUI/Web 入口）均有生产代码落点与单测，不是「只在文档里」。
- **质量**：P2 与 P3 各有 1–2 处实质缺陷（涉及执行证据被误删、回读被权限拒绝、检查后误判工作区变更），P4 的 CLI 入口零测试，P1 的句柄校验与「inline-only 卡不得独立启动」有偏差。见 §6。
- **验证**：`npm run check`、`npm run build` 通过；定向 17 个测试文件 200 项通过、1 项既有 Windows MCP 取消用例失败；实验脚本 7 项通过。文档中「18 文件/258 项」「CLI 2 文件/34 项」「脚本 6 项」无法按现有信息复现。
- **实验**：十格消融（5 组 × 2 任务各 1 次）阶段组自主采用 0/6、按需加载组 0/8；发现入口修复后换用带专属规则的方法，合成小任务自主采用 2/2；随后用当前构建做五臂复测（同任务、通用方法卡）仍为 0 加载、0 卸载、0 工具切换。机制从未触发，因此**任何成绩差异都不能归因于它**。
- **门槛**：设计 §10 三门槛 = 合同测试通过 / 未提示自主选择与实际使用 **未通过** / 相对普通 Skill 可重复改善 **证据不足**。功能保持默认关闭（`inlineMethods ?? false`）符合设计自己的停止条件。

## 1. 方案要点（复述，用于对照）

1. **一个主 Agent 持续负责交付**，按需通过 `skill.load` 加载卡片方法；隐式记录当前方法阶段，不要求先 `declare/activate/done`。
2. **三层分开**：方法逻辑失效（追加失效说明，不省 token，P1）、方法物理卸载（只在既有压缩检查点移除正文，P2）、执行过程收拢（有损，独立验证，本次不实施）。
3. **复用现有结构**：方法阶段不新建任务节点或第三套调度器；显式阶段统一扩展现有 TaskGraph；项目知识复用 ProjectKnowledge；不动态扩大工具或权限。
4. **P3/P4 是候选而非默认**：显式阶段、知识发布、动态工具视图、会话热插拔原本标为「验证有效后再做」，本次按用户要求一次做完。
5. **验证优先于收益宣称**：三组/五组对照、不得从实现完成推导收益、未观察到的机制不能计入效果。

## 2. 实现总表

| 批次 | 设计承诺 | 实现状态 | 关键落点 | 主要缺口 |
|---|---|---|---|---|
| P1 隐式方法阶段 | 卡片 `execution` 声明；`skill.list/load` 方法目录；加载即记录；换方法只追加失效说明；分页/重试不重开；运行终止才结束；恢复重建 | **已实现**（生产接线完整） | `src/agents/card.ts:61,112,109,132`；`src/extensions/methods.ts:10,92,112,118-134`；`src/runtime/roster-context.ts`；`src/runtime/state-frame.ts:113` | 开启 P1 默认连带开启 P2 卸载；§5「记录边界遗漏」未实现；句柄未真正走 ID 校验；inline-only 卡主运行未拦截 |
| P2 检查点卸载 | 仅在既有压力/压缩检查点移除已结束方法正文与方法规则；保留过程与证据；配对合法、可回读；切换不触发 | **已实现，含 2 处实质缺陷** | `src/runtime/context.ts:223-228`（唯一入口）；`src/runtime/method-context.ts:36-60`；`src/runtime/compaction.ts:68`、`src/runtime/model-step.ts:70`、`src/runtime/summary-install.ts:186` | 显式 `task` 结果被连带「卸载」；显式阶段原文回读被协作工具权限拒绝；真请求级覆盖仅有 1 个用例 |
| P3 显式阶段/知识/工具视图 | declare/activate/extend/done/inspect/resume/redo/drop；needs 四要素；done 需真实检查与成果；知识发布候选化；stable/active 视图 | **已实现，含质量缺陷** | `src/runtime/method-stage.ts:23,41-162`；`src/runtime/task-graph.ts`；`src/runtime/task-completion.ts`；`src/knowledge/tools.ts:8-14`；`src/runtime/step-host.ts:44-51` | 「检查后写入需重查」会误判协作工具；done 的检查由模型自选、无宿主执行/指定；stale 只虚拟计算；三项被同一开关捆绑 |
| P4 会话热插拔 | 名册修订原子发布、摘要比较、固定在途版本、停用只阻后续、恢复按确切版本、CLI/TUI/Web 入口 | **已实现，测试不足** | `src/application/index.ts:255-286`；`src/storage/cards.ts:75`；`src/cli/index.ts:315-323`；`src/tui/agents.ts:273-283`；`src/web/server.ts:193,304-318` | `kodo methods` 与 METHOD_BUSY 等零测试；崩溃遗留 running call 误 BUSY；暂停/通知在产品界面几乎不可见 |
| 发现入口修复（非设计原文） | — | 已补齐 | `src/runtime/roster-context.ts:14,26,34`；冻结后改动 4 个源文件 | 五臂复测显示修复后仍无人加载（方法增量价值问题） |

## 3. 分批次证据

### 3.1 P1：本体完整，边界有小偏差

已实现：

- `execution: {modes:[inline,child]}` 进入 schema v2（`src/agents/card.ts:61`）、解析（`:112` 走 `v2Fields`）、文档摘要（`:109`）、序列化（`:132-137`），因此导入导出/版本比较同源；同 `id@version` 不同摘要被拒（`src/storage/index.ts:301`）。
- 方法句柄 `card-method/<sha256([id,version,digest])>`（`src/extensions/methods.ts:10`），目录项 `kind:'card-method'`（`:92`）；命名冲突 fail-closed（`:88`）；加载绑定精确版本（`:117`）；普通 Skill 加载不切换主方法（`:112`）。
- 隐式阶段：成功加载写 `method.loaded`（`:123`）；失败不切换（`src/runtime/tool-step.ts:195`）；分页/重试/普通 Skill 用同 id、同 callId 判重（`methods.ts:118-120`）；换方法写失效说明并保留历史（`:122,125`）；只有 run terminal 才 `method.ended`（`:130-134`）；当前方法由持久事件重建（`:40-47`），名册缺版本时按 `store.card` 重建、摘要不符抛 `METHOD_IDENTITY`（`:81-83`）。
- 默认关闭（`src/application/index.ts:179`）；未开启时 inline-only 卡从初始名册排除（`roster-context.ts:26`）；lean-solo/lean-team 直接拒绝（`application/index.ts:184`）。

缺口与偏差：

1. **中高**：启用 P1 时 `methodUnloading` 默认 `true`（`application/index.ts:180`；CLI `src/cli/index.ts:205`），即 P2 卸载默认随 P1 打开。只做「标记」的对照组必须显式传 `--method-unloading off`，否则处理变量不干净。
2. **中**：设计 §5 承诺「不换方法又未终止时保留当前方法，记录边界遗漏」，代码没有边界遗漏记录。
3. **中**：设计 §10.2 要求扩展 `agent-card-v2/extensions/application-capabilities` 覆盖加载/失效边界；实际 `tests/extensions.test.ts` 无方法相关用例（覆盖在 `tests/inline-methods.test.ts`，可接受但文档口径不一致）。
4. **低**：句柄未真正通过现有 Skill ID 校验（靠 `card-method/` 前缀 + `kind` 区分），`methods.ts:77` 只保证 ID 结构；inline-only 卡在 `createRun`/`--card` 主运行路径未被拦截，「不能独立启动」只在子 Agent 侧强制（`src/messaging/child-config.ts:26`）。
5. **低**：`execution_modes` 对所有名册成员无条件展示（`roster-context.ts:14`），旧会话表示有轻微变化。

### 3.2 P2：卸载真实发生，但会误伤执行证据

已实现：

- 唯一入口在 `src/runtime/context.ts:223-228`：仅 `force/!fits/估算输入 > workInputTokens` 时调用 `unloadMethods` 并递归重建投影；方法切换只追加消息（`src/runtime/tool-step.ts:375-380`），不触发重建。
- 只替换「已结束方法实例」配对的 `skill.load`/`task` 工具结果（`method-context.ts:14-16,42-46`）；当前方法结果被 pin（`:29-33`）；普通参考 Skill 无 `methodInstance` 不匹配（`:20-26`）；占位内容保留 `inputs/knowledge/method` 三键（`:68-70`）并写入 `history.read` 回读指针（`:55`）；替换保持 role/tool_call_id 配对合法。
- 配置链完整：`application/index.ts:84,180,183,507` → `runtime/types.ts:86-88` → `session.methodUnloading`（`method-context.ts:38`）；CLI/serve/host-state 均持久化校验。
- 真请求级断言存在但只有 1 个：`tests/inline-methods.test.ts:51-72`（检查点后最后请求不含旧方法、保留当前方法与用户约束、工具 schema 不变、事件写入、重启后可回读）。

**实质缺陷（静态推导，未运行验证）**：

- **A（高）过度卸载**：`task` 的 activate/inspect/done/drop 结果也带顶层 `methodInstance`（`src/runtime/method-stage.ts:47,109,155,163`；`task-graph.ts:83-85` 直接回传 node），会被 `methodResults` 一并匹配（`method-context.ts:14-16,42-46`）。结果被替换成只剩 `inputs/knowledge/method` 的占位，**阶段验收、产物引用、检查记录等执行证据从后续请求中消失**，违反设计 §6「阶段输入、项目观察和执行证据不随方法删除」。
- **B（高）回读不可用**：卸载占位里的 `history.read` 指针指向归档，但显式阶段调用属于协作工具，`history.read → visibleHistoryMessage → inspectRun` 对协作调用一律 `INSPECT_DENIED`（`src/runtime/history.ts:95-105`；`src/runtime/inspection.ts:16,87-89`）。违反 §10.2「原文可回读」。`skill.load` 路径不受影响（`tests/inline-methods.test.ts:69-71`）。
- **C（中）覆盖缺口**：task 真请求、方法规则移除、普通 Skill 高压保留、`force/hard/summary/assembly` 路径均无断言（`tests/method-stages.test.ts:153-162` 只是单元投影）。
- **D（中低）说明不进状态帧**：失效/卸载说明只在工具结果与占位中（`methods.ts:125`；`method-context.ts:56`），末尾状态帧只有 `method/名册/stages`（`state-frame.ts:113`），压缩后不再重现；若摘要在方法活跃时生成，正文可能被回写进 summary marker 而卸载不清。
- **E（低）**：设计 §11 仍称「P2 未实施」，与代码和 §1 矛盾。

### 3.3 P3：协议齐全，验收与写入判定有缺陷

已实现：

- 操作枚举齐全：`declare/activate/extend/done/inspect/resume/redo/drop/wait`（`src/runtime/method-stage.ts:23`）；`declare` 复用既有 `declareTasks`（`src/runtime/task-declare.ts:160`）。
- `needs`：`requiredRefs`/`knowledgeQueries`/`execution` 在 activate 生效（`method-stage.ts:124-142`）；`capabilities` 只记录、不用于资格校验（与文档「标签匹配不等于资格认证」一致）。
- activate：依赖校验（`:113`）、代次与幂等（`:48,112`）、单活动 inline 阶段（`:114`）、固定绑定（`:129,163`）、`execution:child` 走子运行（`:143-146`）、知识范围/新鲜度过滤（`:130-142`）、32 KiB 结果预算（`:157-162`）。
- done：要求成果（resultRef/result）或已保存报告、至少一个检查、检查必须成功且发生在激活之后、检查后不得有本阶段写效应、决策版本一致（`:76-107`）；验收类型明确标 `model-review`（`:107`），不伪装成宿主验证。
- 知识与工具视图：`knowledge.publish` 只接受本运行成功 `file.read` 的来源调用，观察/假设/未决问题分开（`src/knowledge/tools.ts:8-14`；`src/knowledge/index.ts:102-166`）；stable/active 由 `src/runtime/step-host.ts:44-51` + `methods.ts:18-37` 实现；方法激活后执行按合同收窄（`src/messaging/index.ts:174-175`，`METHOD_TOOL_INACTIVE`），`coordinator.ts:580` 做能力核对。

缺陷与风险：

1. **高（静态）检查后写入误判**：`method-stage.ts:97` 把所有 `effect === 'write'` 的后续调用当作「工作区已变更」。协作工具（`task`、`update_progress`、`send_message` 等）不在内置工具表也不在注册表，`Tools.effect()` 会落回 `'write'`（`src/tools/index.ts:411-419`）。因此检查之后再调一次 `task inspect` 或 `update_progress` 就可能被拒绝验收（`TASK_CHECK: workspace changed after the check`）。本项无测试。
2. **高**：done 的检查完全由模型自选，宿主没有「指定检查/执行宿主检查」的入口；`task-checks`、`check-hint` 未接入显式阶段。设计 §5「可机械检查的条件由宿主检查」只做到「记录了检查」。
3. **中**：stale 只在 completion/state-frame 处虚拟计算（`task-completion.ts:104-108`；`state-frame.ts:113`），不落事件；显式阶段模式下 `task` 被替换为阶段协议（`messaging/index.ts:119-122`），原 `accept` 等动作只属于 lean-team（`messaging/index.ts:183`），两种模式不可共存——设计 §5 提到的 `task accept` 处理 stale 在 inline 模式下没有对应入口。
4. **中**：P3 三项（显式阶段、知识发布、工具视图）与 P1/P2 共用同一个 `inlineMethods` 开关（`application/index.ts:182,184,209,217`），违反设计 §9「P3 各能力不捆绑、各有单独基线」。
5. **中**：`resultRef` 未校验必须是本阶段产物（`src/storage/index.ts:321-327` 只按 artifact 读取）。
6. **中低**：`method.loaded` 事件先于资源/预算校验写出（`:129` 在 `:130-162` 之前），依赖回滚；`drop` 的 `cancel_agent` 不可回滚。
7. **测试**：`tests/method-stages.test.ts:34-197`、`tests/knowledge.test.ts:29-59` 有覆盖，但缺 extend/resume-redo/代次/容量/写后重查/执行拒绝断言；`tests/task-*.test.ts` 不覆盖 inlineMethods。

### 3.4 P4：热插拔扎实，入口测试是短板

已实现：

- `registerCard` 只写全局卡表（`src/storage/index.ts:299-303`；`application/index.ts:250-253`）；会话名册在创建时冻结（`src/agents/roster.ts:41-44`），迟到注册不进会话（`tests/agent-roster.test.ts:67-74`）。
- `updateSessionMethods` 校验链完整、单事务提交：摘要比较（`:259-260`、事务内复核 `:277`）、重复/未知 disable（`:263-264`）、卡片资源与文件范围（`:265,287-300`、`:272-273`）、绑定快照与已有 pin 冲突（`:268-269`）、名册冻结 + session + 全部 main run bindings + notice + 事件（`:276-284`）。
- 在途方法由 `method.loaded` 的 `{card{id,version,digest}, contract}` 精确固定（`methods.ts:11-13,123`）；停用只置 unavailable（`application/index.ts:270`），当前方法仍可执行（`methods.ts:75-87`）；重启按确切版本重挂，缺失抛 `METHOD_IDENTITY/CARD_NOT_FOUND`（`methods.ts:81-83`）。
- CLI `kodo methods`（`src/cli/index.ts:315-323`）、TUI `/agents methods|install-method|disable-method`（`src/tui/agents.ts:273-283`）、Web `GET/POST /api/runs/:id/methods`（`src/web/server.ts:192-193,304-318`）真实存在；Web 的认证、CSRF、`Idempotency-Key` 为实际比较而非注释（`:165,257-258,290-298`），测试见 `tests/method-stages.test.ts:47-56`。
- lean 拒绝是代码强制（`application/index.ts:184`），不是文档约定。

缺口：

1. **高（测试）**：`kodo methods` 命令零 CLI 测试；METHOD_BUSY、非法卡/范围拒绝、lean 拒绝、通知、METHOD_IDENTITY 均无断言，结论主要靠读代码。
2. **中**：崩溃后 `Store` 打开只把 run 标 interrupted，不结算遗留 `running` call（`src/storage/index.ts:149-153`），未 resume/recover 前发布恒 `METHOD_BUSY`，与文档「中断后发布」冲突。
3. **中**：可见通知弱——只有 mailbox notice（模型可见）+ 事件，TUI/Web 聊天面板不显示（`src/tui/controller.ts:664-670`）。
4. **中**：文件范围校验弱于初始冻结（`application/index.ts:273` 未按 read/review 清 write、空交集也不标 unavailable+reason；对比 `src/agents/roster.ts:80-89`），可能出现 `available` 但实际不可用。
5. **中低**：pin 只校验目标 run（`:269`），却把合并后的 bindings 写入全部 main run（`:281`），多 main run 时可能覆盖他人 pin。
6. **低**：`agent.roster.revised` 携带整个 before 快照（含方法正文）导致事件/SSE 膨胀（`:283`）；发布路径只复核名册摘要，未复核 decisionVersion/阶段代次（§8 的「准备期新输入重校」）。
7. **低**：TUI `/agents` 主面板未列 methods（`src/tui/agents.ts:99-100`），`:164` 仍称「名册冻结，新版本需新会话」，与新入口易混淆。

## 4. 构建与测试实测（2026-11-03 13:50–13:55）

| 命令 | 结果 |
|---|---|
| `npm run check`（tsc --noEmit + eslint src tests scripts） | **0 错误 0 警告**（15.6s） |
| `npm run build` | **成功**（10.9s）；dist 616 文件；source digest `0632484d…`，dist digest `dafb8374…` |
| vitest 批1：agent-card-v2 / extensions / application-capabilities | 3 文件 **28 项通过** |
| vitest 批2：inline-methods / method-stages | 2 文件 **24 项通过** |
| vitest 批3：task-graph / task-checks / task-declare-paths / task-dispatch / task-resume-revision / task-recheck | 6 文件 **58 项通过** |
| vitest 批4：knowledge / agent-roster / capability-restart | 3 文件 **48 项通过** |
| 补充 CLI 候选对：cli.test + cli-workbench | 2 文件 **35 项通过** |
| `node --test` 实验脚本（method-ablation / method-discovery / execution-evidence） | **7 项通过** |
| `tests/mcp-sandbox.test.ts` | 1 失败 / 7 通过；**既有 Windows 环境问题**，文件与失败源 mtime 均早于 11-02/03 改动 |

无法复现的文档数字（`docs/experiments/kodo-method-p1-p4-ablation-20261103.md:102`）：

- 「18 个相关测试文件共 258 项通过」→ 无文件清单；本次 14 个相关文件实测 158 项全通过，加 CLI 候选对也只有 16 文件 193 项。
- 「CLI 检查 2 文件、34 项」→ 最可能的一对实测 35 项，差 1。
- 「实验脚本原有 6 项」→ 指定 3 个脚本实测 7 项（含归档修复 3 项），口径无法对齐。
- 构建对应关系：本轮构建 source digest `0632484d…` 与 **五臂实验** 构建一致；十格消融用的是更早的 `189e5673…`（差 4 个源文件，即 09:36–09:37 的发现入口修复）。因此「十格构建 = 当前构建」不成立，只有五臂成立。

## 5. 实验证据与 §10 推进门槛

时间线（同日）：

| 时间 | 事件 | 构建 |
|---|---|---|
| 00:25–01:38 | 实现 P1–P4（用户要求完整覆盖） | — |
| 01:42–06:44 | 十格消融（5 组 × 2 任务各 1 次；首格归档失败后停、续跑 9 格） | `189e5673…` |
| 09:36–09:37 | 发现入口修复（名册显示 execution_modes/句柄/load；inline-only 不进关闭时名册） | 改为 `0632484d…` |
| 09:41–09:46 | 发现诊断：正控制 + 2 次自主，合成任务 + 带专属规则的方法 | 同上 |
| 13:30–13:38 | 五臂复测：statemachine 五组各 1 次 + 离线日志分析 | 同上（= 当前构建） |

关键数字：

| 批次 | 样本 | 自主采用 | 独立验收 | API 请求 | Credit |
|---|---|---:|---|---:|---|
| 十格消融 | 5 组 × 2 任务各 1 | 阶段组 0/6；按需组 0/8 | 6/10 格全通过 | 1,334 | ≥188.25 |
| 发现诊断 | 正控制 + 自主 ×2 | **2/2**（合成任务 + 专属规则） | 3/3 | 17 | 字段 0 |
| 五臂复测 | 5 组各 1（仅 statemachine） | 非 resident **0/4** | 3/5（active 因 HTTP 502 中断） | 966 | ≥34.29 |

证据判定：

- **十格与五臂中 `skill.list`/`skill.load`/`task` 调用均为 0**，方法加载、结束、物理卸载、knowledge.publish、压缩事件全部未出现；五个/十个非预加载组方法覆盖都是 0/3，工具定义始终 1 种、切换 0 次。按设计 §10 自己写的规则，「未观察到的机制不能计入效果比较」，因此这些成绩差异不可归因于阶段机制。
- 发现诊断是唯一一次观察到自主加载（2/2），但条件不同：合成小任务 + 方法卡含任务专属规则（`rehearsal_protocol` 等），且没有同任务旧展示对照，不能把 0/6 → 2/2 称为展示修复的净效应。
- 五臂在**修复后的展示**下仍未加载，日志分析给出的解释是：三张通用方法卡（理解/实现/验证）对主卡而言增量价值低，主卡本身已要求读代码、实现、验证、必要时委派；这属于「方法内容与任务价值」问题，不是「模型不会用工具」（五组分别成功创建 3/3/2/2/2 个子运行）。
- 检查点物理卸载在真实运行中零触发：五组主 Agent 单次输入峰值 227,305 / 219,895 / 215,019 / 204,264 / 136,296 token，窗口 1,048,576，从未触发检查点；累计数千万 token 是多次请求累加。
- 动态工具视图未测到：三张方法卡声明相同工具集合，即使加载也不会产生工具定义变化（`active` 与 `checkpoint` 请求工具定义种数均为 1）。
- 五臂审计 `comparableConfiguration=false`：checkpoint 第 145 次请求指定 `deepseek-v4.1-flash`、响应标识 `-sg`、流协议 error、usage 缺失；严格模型一致性不成立。

§10 门槛判定：

| 门槛 | 判定 | 依据 |
|---|---|---|
| P1/P2 合同测试通过 | **通过**（文档记录；本次复跑 17 文件 200 项通过、1 项既有失败） | §4 |
| 未提示条件下自主选择并实际使用 | **未通过** | 十格 0/6、0/8；五臂 0/4；仅合成诊断 2/2 且条件不同 |
| 相对普通 Skill 基线可重复改善 | **证据不足** | 每组仅 1 次、机制未触发、模型/供应商波动（HTTP 502、流错误） |
| 长任务「方法积累造成窗口压力」替代门槛 | **未达** | 单次峰值 227K / 1M，无检查点、无卸载 |

## 6. 缺陷与风险清单（按严重度）

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| 高 | P2 过度卸载：`task` 阶段结果被当作方法正文替换，执行证据从请求消失 | `method-context.ts:14-16,42-46`；`method-stage.ts:47,109,163` | 显式阶段的验收/产物引用在检查点后不可见 |
| 高 | 显式阶段原文回读被协作工具权限拒绝（`INSPECT_DENIED`） | `history.ts:95-105`；`inspection.ts:16,87-89` | 违反「原文可回读」，卸载不可逆取证 |
| 高 | P3「检查后工作区写入需重查」误判：协作工具 effect 落回 `write` | `method-stage.ts:97`；`tools/index.ts:411-419` | 检查后调 `task inspect`/`update_progress` 可能被拒验收（静态推导，无测试） |
| 高 | P4 CLI `kodo methods` 与 METHOD_BUSY/身份恢复零测试 | `src/cli/index.ts:315-323`；`tests/method-stages.test.ts:34-58` | 主要产品入口无回归保护 |
| 中 | P1 开启默认连带 P2 卸载 | `application/index.ts:180`；`cli/index.ts:205` | 标记组/卸载组处理变量不干净，与 §11 矛盾 |
| 中 | P3 三项捆绑同一开关，违反 §9「不捆绑」 | `application/index.ts:182,184,209,217` | 无法按单因素做知识/阶段/工具视图实验 |
| 中 | P3 done 检查由模型自选，无宿主检查入口 | `method-stage.ts:85-101`；`task-checks`/`check-hint` 未接入 | 「机械可检条件由宿主检查」只部分满足 |
| 中 | P4 崩溃后遗留 running call → 永久 METHOD_BUSY | `storage/index.ts:149-153`；`application/index.ts:258` | 中断后无法发布，需先 recover/doctor |
| 中 | P2/P3 真请求级测试少（task 路径无断言） | `tests/method-stages.test.ts:153-162`；`tests/inline-methods.test.ts:51-72` | 「请求确实不含正文」只在 skill.load 路径被验证 |
| 中低 | P2 说明不进状态帧、摘要可能回写正文 | `state-frame.ts:113`；`summary-install.ts:186` | 压缩后失效提示不再重现 |
| 中低 | P4 文件范围校验弱于初始冻结；通知在产品界面不可见 | `application/index.ts:273,282`；`tui/controller.ts:664-670` | 可能出现 available 但不可用；用户看不到修订结果 |
| 低 | inline-only 卡主运行未拦截；句柄未过 ID 校验 | `child-config.ts:26`；`methods.ts:77` | 与实现说明「不能独立启动」字面不符 |
| 低 | §5「记录边界遗漏」未实现 | 设计 §5（无代码落点） | 方法边界遗漏不可观测 |

## 7. 文档一致性偏差

1. **设计文档自相矛盾**：头部第 1/5 行称「已实现 P1–P4」，§9/§11（`:278`）仍称「仅 P1」「P2 未实施」「尚未运行真实模型对照」。正文被保留为历史依据可以理解，但缺少一处「§9/§11 为历史状态」的显式标注，易被误读为当前状态。
2. **旧文档未更新**：`docs/kodo-general-task-positioning-20261102.md:17` 仍写「P1 实验入口已实现」，未提 P1–P4 全量实现与后续实验。
3. **`docs/inline-methods.md:90` 已落后**：只引用十格消融，未引用 09:46 的发现诊断与 13:30/13:38 的五臂复测与日志分析；读者会得到「0/6 即结论」的过时印象（虽然该文件用词已很克制）。
4. **实验文档数字无法复现**：18 文件/258 项、CLI 34 项、脚本 6 项（见 §4）。
5. **结果目录与文档不符**：文档称 ablation 与 continuation 两目录均有 `matrix/analysis/audit`；实际 `.kodo/method-p1-p4-ablation-20261103/` 只有 `matrix.json`（1 完成/9 pending）与 resident 的 analysis，缺 `analysis.json`/`audit.json`；十格中只有 `statemachine-skill` 归档为 captured，其余 absent/failed（文档已说明归档缺口，但「派生物齐全」不成立）。
6. **构建口径**：十格冻结 `189e5673…`、当前与五臂 `0632484d…`；引用实验结论时需注明对应构建。
7. **范围授权只写在文档头部与 admin-stop.json**，`inline-methods.md` 未记载「用户要求覆盖 P1–P4」，追溯时只靠两处记录。

## 8. 建议

1. **先冻结范围，不再扩展**：功能保持默认关闭。设计自己的门槛要求「未提示自主选择并实际使用」才能默认发布；目前 3 个批次都没有达到，继续加机制只会扩大未验证面积。
2. **把下一轮重点放回「方法卡增量价值 + 发现」**：唯一观察到 2/2 自主加载的是带任务专属规则的方法卡。下一步应固定同一任务、同一方法价值，比较「专属规则方法 vs 通用方法」的加载率与遵守率，而不是继续比较生命周期。
3. **进入任何显式阶段/知识实验前修 3 个高危缺陷**：P2 过度卸载、显式阶段原文回读、P3 检查后写入误判；并给 `task inspect/update_progress` 一个明确的 `read` effect 或排除协作工具。
4. **拆开关**：按 §9 把显式阶段、知识发布、工具视图、物理卸载拆成独立开关（或至少独立实验配置），否则无法做单因素消融。
5. **修实验矩阵**：工具视图组用「工具合同不同」的方法卡；卸载组用明确压缩压力场景；每组至少 3 次、交错顺序；修 checkpoint 模型标识不一致的审计失败；十格补齐 analysis/audit 派生物或删除文档中的声称。
6. **补测试**：`kodo methods` CLI、METHOD_BUSY、METHOD_IDENTITY、P4 文件范围；P3 extend/resume/redo/代次/写后重查；P2 task 路径真请求断言。
7. **文档收尾**：设计文档 §9/§11 加「历史状态」标注；更新 positioning 文档与 `inline-methods.md` 的实验指向；把无法复现的测试/脚本数字改为可核对的清单或删除。

## 9. 审计局限

- 全部代码结论为只读静态分析；标注「静态推导」的两条高危（P2 过度卸载、P3 写后重查误判）未用运行验证，可能受未读到的接线影响。
- 未运行完整 `npm test`（仅定向 17 文件 + 1 个已知失败文件 + 3 个实验脚本文件），未复跑十格/五臂实验。
- 未验证并发发布（METHOD_BUSY 竞争）、恢复期 pinned 卡缺失、卡版本 GC、`rewind` 后卸载事件幂等、`methodToolView=active` 下回读指针可用性。
- 行号基于当前工作区（未提交改动、source digest `0632484d…`），后续修改会漂移。
