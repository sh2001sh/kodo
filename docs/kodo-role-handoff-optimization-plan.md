# Kodo 角色分工与交接优化方案（修订 2）

日期：2026-10-29。状态：修订 2，B1–B4、M1/M2、D/E 已实现并完成确定性验证。2026-10-30 用户已授权 Kodo 四组各一次消融；阶段 3 依赖实验结果，阶段 4 暂不实现。

修订 2 补充：正常子任务等待不消耗验收纠正次数；中断需要恢复或取消；失败确认使用已有成功调用及结果记录，必须发生在失败后。重复读取需要内容证据；首次修改区分实际修改与首次观察。字节等价仅针对冻结状态的确定性重放，真实实验交错安排同期 R0。缓存比例仅作诊断，费用、耗时和质量决定收益。

## 0. 修订记录

| 审阅项 | 处理 | 位置 |
|---|---|---|
| 1 预设卡片版本 | 实现类预设改为新版本 `1.1.0` 并加入 `shell.exec`，`1.0.0` 内容不动；作为基线修正 B3 单独完成，之后再冻结 R0 | 4.2 |
| 2 遗漏 `ask_user` | 主代理视图保留 `ask_user`，测试覆盖提问、持久等待、回复后继续及重启恢复 | 6.2、6.5 |
| 3 未关联派发的完成检查 | 完成检查覆盖主代理的全部直接子运行，明确等待、失败、取消、验收语义 | 4.2 B2 |
| 4 协调工具入口 | 角色视图由一个函数定义，请求过滤、`Tools` 执行校验、`Mailbox.specs/validate` 共用；E 不移除任何协调工具，`agent.derive` 不变 | 6.1、6.2 |
| 5 shell 通道 | 指标覆盖 shell/process，无法识别的标为 unknown；读取按区段去重；首次源码修改更正为第 20 步 | 2、9 |
| 6 缓存归因 | 按 run 序列比较；验收拆成"工具集合稳定"和"实际缓存表现"两项 | 4.3、9 |
| 7 写范围描述 | 区分旧模式与 strict 模式，现有拒绝行为不放宽 | 7.2 |
| 8 D 混入派发规则 | 派发规则移到基线修正 B2，D 只控制交接指导文本 | 4.2、5 |
| 定案：兄弟报告 | `inspect_run` 不能读兄弟 run，改为主代理转交要点或共享 artifact | 5.4 |
| 定案：阶段 0 | 拆为不改行为的收尾和改行为的基线修正；历史报告追加修复说明；测试基线比较具体用例 | 4 |

## 1. 目标

**主代理减少执行负担，子代理减少重复理解，独立任务真正并行，同一模块持续由同一个代理负责。**

工具数量、代理数量只是手段。最终看完成时间、实际费用和结果质量（验证通过率、审查结论、完整交付）。

顺序是：基线与测量口径 → 交接指导 D → 主代理视图 E。并行所有权和上下文继承放在后面，有证据再做。全程复用现有的 `spawn_agent`、`followup_task`、`explore`、预设卡片、写范围检查和恢复机制，不新增代理体系、强制工件或完整历史复制。

## 2. 实施前的证据

数字来自 FastAPI 四方实验中 Kodo 的重跑记录（`.kodo/frontier-fourway-recorded-fastapi-kodo/fastapi-kodo/`，`process/steps.jsonl` 与 `relay/request-1.json`）和当前源码。这次运行只有主代理，没有子代理请求。

**主代理把探索做到了"能自己实现"，而不是"能分工"。**

- 第 13 步正文写 "I have a clear picture of the architecture"，之后继续探索到第 19 步。
- 首次源码修改是第 20 步：shell 写出 `/tmp/propagate.py` 并执行，修改了 `routing.py` 和 `applications.py`；第 21 步的 `git diff --stat` 显示两个文件共新增 818 行。第 29 步只是首次使用原生文件工具修改。
- 第 1–19 步共 38 次工具调用、107,405 推理 token、16.15 credit（全程 47.07）。修订前写的"第 29 步之前 23.28 credit"以原生写入为界，不能当作首次修改前的成本。
- 第 13 步计划的 `executor: agent` 审查从未启动。第 86 步正文说要委派，实际调用的是 `artifact.write`。

**大量读取走的是 shell，不是原生文件工具。**

- 全程 91 次 `shell_exec`/`process_exec`。按命令文本粗分：约 60 次是 `sed -n`、`cat`、`grep` 一类读取，7 次 pytest，3 次 git，21 次无法归类（主要是内联 Python）。第 20 步之前有 37 次，其中约 27 次是读取。
- 这是启发式分类，只用于说明指标必须覆盖 shell 通道，不作为优化结论。

**主代理工具齐全，执行能力比实现者更顺手。**

- 主卡片 [card.ts:152](../src/agents/card.ts) 含 `shell.exec`、`process.exec`、`process.run`、`web.fetch`、5 个 LSP 工具、`image.read` 和全部协调工具。
- `request-1.json` 带 38 个工具，逐个 `json.dumps` 后合计 37,341 字符（修订前的 37,361 用了另一种序列化方式）。其中有 `ask_user`，没有 `process_run`（这次主机没有声明可运行命令）。
- 实现类预设 [presets.ts:6](../src/agents/presets.ts) 的 `writeTools` 只有 `process.exec`，没有 `shell.exec`。这些预设都注册为 `1.0.0`。

**派发与完成检查。**

- 因子 B 下，派发前必须有进行中的 `executor: agent` 待办，否则返回 `TODO_DISPATCH_REQUIRED`（[messaging/index.ts:133](../src/messaging/index.ts)）。
- [step-host.ts:45](../src/runtime/step-host.ts) 按待办状态从请求里移除部分原生工具；执行时 `assertTodoExecution` 也会拒绝同一批调用。
- 完成检查 `todoCompletionFeedback`（[todo.ts:90](../src/tools/todo.ts)）只看 `todo.dispatched` 事件关联的子运行。主代理结束时，coordinator 会取消仍在运行的直接子运行（[coordinator.ts:470](../src/runtime/coordinator.ts)）。因此未关联待办的子运行如果还没完成，主代理可以照常结束，子运行的工作随之被取消。

**交接通道与可见范围。**

- 子代理任务包由 [messaging/index.ts:367](../src/messaging/index.ts) 拼装：`objective`、`context`、`slots`、`inputs`、`acceptance` 和卡片的报告契约。
- `inspect_run`（[inspection.ts:21](../src/runtime/inspection.ts)）只允许读自身历史，或主代理读它管理的子运行。子代理读兄弟运行会得到 `INSPECT_DENIED`。
- 协调工具由 `Mailbox.specs` 生成，`Mailbox.validate` 拒绝不在 specs 里的调用（[messaging/index.ts:123](../src/messaging/index.ts)），不经过 `Tools.validate`。

**写范围检查有两种模式。**

- [spawn-spec.ts:147](../src/messaging/spawn-spec.ts) 的 `assertNoWriteConflict` 在 v2 卡片或因子 A/C 开启时使用 strict 模式：未声明写范围（继承整个工作区）也算占用，会和其他写代理冲突并被拒绝。旧模式下只有比父级更窄的写范围才参与检查。

**缓存归因。**

- [trace.mjs:82](../scripts/comparison/frontier/trace.mjs) 拿每个请求和时间上的前一个请求比较。单代理运行没有问题；多代理交错时，主、子代理本来就不同的工具列表会被归为 `tools-changed`。

**此前的委派实验**：探索型调研的委派率为 0/3，加运行时提示后为 1/3（`.helloagents/plans/delegation-explore/tasks.md` T8、T9）。

## 3. 原则

1. 主代理只探索到能够分工为止：入口、模块边界、共享接口和验收方式清楚后就派发。
2. 交接要让执行者知道从哪里开始：已确认的事实、具体文件和符号、未解决的问题、负责范围、检查方式。不只写一个标题，也不复制整段对话。
3. 修改前读取当前文件、独立审查都是必要核查，不算浪费。要减少的是重新遍历目录、重新寻找已知入口。
4. 实现和对应的验证由同一个执行者完成。只有能独立推进的模块才并行。
5. 同一模块的补充和验收修正优先用 `followup_task` 交回原代理。只读代理不会因复用获得写权限。
6. 按角色分配工具，一个会话内工具集合保持稳定。显示给模型的工具和执行端允许的工具来自同一份规则。
7. 不新增强制工件、额外规划轮次，也不为收尾而委派。
8. D、E 独立开关、单独测量。基线修正先验证；D、E 关闭时，在相同冻结状态、身份和脚本响应下，请求与修正后的 R0 逐字节一致。真实模型运行的身份、路径和历史不同，不作逐字节比较。

## 4. 阶段 0：基线与测量口径

阶段 0 分三部分：不改行为的收尾（4.1）、改变行为的基线修正（4.2）、测量口径（4.3）。4.2 每一项独立验证。当前工作区有大量已有改动，本轮不混合提交、不清理历史证据；提交整理与实现解耦。

### 4.1 收尾（不改变行为）

| 项 | 内容 | 完成标准 |
|---|---|---|
| 0.1 | 保留 P1/P2 与其他已有改动；本轮只完成方案范围内实现和验证 | 不覆盖已有工作，不混合提交 |
| 0.2 | 在 [frontier-fourway-recorded-20261029.md](experiments/frontier-fourway-recorded-20261029.md) 末尾追加修复说明，区分历史实验与当前未提交代码 | 原文与数字保持原样，不虚构提交号 |
| 0.3 | 保留 `.kodo/scratch/` 历史测试证据；保持卡片设计主线独立 | 无批量清理或无关实现 |
| 0.4 | 记录测试基线：按用例名和失败原因列出，而不是只记失败数（见下表）。之后每一步比较用例集合：不能出现新的失败用例，已有用例的失败原因也不能变 | 下表与本地复跑一致 |

历史全量测试的已知失败（`.kodo/scratch/full-suite-2.log`，本轮保留原始日志供对照）：

| 文件 | 用例 | 原因 |
|---|---|---|
| `provider-model-list.test.ts` | bounds the entire listing deadline, including a stalled response body | 超时 12000ms |
| `tui-view.test.tsx` | ignores stale file completions and never reopens a dismissed suggestion list | 输出中找不到 `ab.ts` |
| `tui-view.test.tsx` | normalizes external editor content and sends slash-prefixed content literally | `vi.fn()` 未收到 `['/quit\n中文', { literal: true }]` |
| `tui-view.test.tsx` | allows ordinary commands after an external editor clears the draft | `vi.fn()` 未收到 `['/help', { literal: false }]` |

### 4.2 基线修正（改变行为，各自独立）

FastAPI 那次运行的会话因子是 `A,B,C`（`state/kodo/kodo.sqlite` 的 sessions 记录）。以下修正都在这个配置上验证，完成后的代码与配置就是 R0。

**B1 文件工具接受工作区内的绝对路径。** 目前 [index.ts:827](../src/tools/index.ts) 拒绝所有绝对路径，FastAPI 第 24、77 步因此失败。改为：解析后仍在工作区内的绝对路径照常处理；工作区外的路径、受保护目录继续拒绝，错误码不变。测试覆盖 `/app/x.py`（工作区为 `/app`）被接受、`/etc/x` 被拒、受保护目录被拒、Windows 盘符路径。

**B2 派发不再要求先选中待办，完成检查覆盖全部直接子运行。** 两件事放在同一个提交里，因为只做前一件会让未关联的子任务漏出完成检查。

- 派发：删除 `TODO_DISPATCH_REQUIRED`（[messaging/index.ts:133](../src/messaging/index.ts)）。有进行中的 agent 待办时照旧自动关联（`recordTodoDispatch`）；没有时直接派发，子运行记为"未关联"。
- 完成检查：`todoCompletionFeedback` 之外，增加对主代理全部直接子运行（`parentId === run.id`）的检查，未关联的子运行适用以下语义：

| 子运行状态 | 主代理能否结束 | 需要主代理做什么 |
|---|---|---|
| 运行中、等待中 | 不能 | 进入现有持久等待，不计验收失败；主代理仍可取消 |
| 被中断 | 不能 | 用 `send_message` 恢复或 `cancel_agent` 取消；单纯等待不会恢复 |
| 已完成 | 能 | 无额外要求；是否采纳由主代理在最终答复中说明 |
| 失败 | 不能，直到主代理处理过 | 失败后成功 `inspect_run` 查看失败结果，或续接完成并处理结果；失败记录保留，查看不等于验收成功，对已失败运行的取消是空操作 |
| 被主代理取消 | 能 | 无 |
| 被用户或预算取消 | 能 | 最终答复说明这部分未完成 |

- 已关联待办的语义不变：至少一个子运行完成、全部关联运行结束后，主代理用 `todo.write` 显式标记完成。
- 正常运行中或等待中的子运行使用现有持久等待，不走 `requestCorrection` 失败计数。被中断、失败未查看等需要行动的问题返回具体纠正反馈。
- 成功 `inspect_run` 已由 `calls.resultRef` 和 `tool.finished` 持久化；检查结果中的失败状态，不能用失败前的查看充当确认。不新增重复的确认事件。续接创建本身不是解决，最新续接必须结束。失败确认允许报告部分结果，不能将原失败伪装为成功。
- 测试：未关联子运行运行中时主代理不能完成；失败后未查看时不能完成，查看后可以；主代理取消后可以；进程重启后上述判断不变；已关联待办的现有测试全部保持通过。

**B3 实现类预设升级到 `1.1.0`。** [presets.ts:16](../src/agents/presets.ts) 把所有预设固定成 `1.0.0`；直接改 `writeTools` 会改变摘要，已有数据库再注册时报 `CARD_CONFLICT`（[storage/index.ts:301](../src/storage/index.ts)）。做法：

- `kodo/implementer`、`kodo/tester`、`kodo/frontend`、`kodo/backend` 发布 `1.1.0`，`writeTools` 加入 `shell.exec`；`kodo/explorer`、`kodo/reviewer` 不变，仍为 `1.0.0`。
- 四个 `1.0.0` 定义原样保留在单独的 `legacyBuiltinCards` 中，照常注册，保证老数据库的摘要一致；新会话的成员名单（[application/index.ts:126](../src/application/index.ts)、`defaultMemberReferences`）只引用当前版本。
- 已经冻结名单的老会话按快照里记录的版本和摘要解析，继续使用 `1.0.0`。
- 测试：用旧版本代码创建的数据库再次启动，不报 `CARD_CONFLICT`；老会话的子代理仍拿到 `1.0.0` 的工具；新会话拿到 `1.1.0`；两版本同时存在时 `agent.directory` 只列出当前版本。

**B4 工具列表不随待办状态变化。** 删除 [step-host.ts:45](../src/runtime/step-host.ts) 的 `TODO_DELEGATED` 请求过滤，只保留执行时 `assertTodoExecution` 的拒绝。测试：待办切换前后主代理的工具定义逐字节一致；调用被委派范围内的工具仍返回 `TODO_DELEGATED`。

### 4.3 测量口径

**M1 按 run 序列做前缀比较。** 改 [trace.mjs:82](../scripts/comparison/frontier/trace.mjs)：先根据系统提示中的 `Run ID:` 把请求分到各自的 run，每个请求只和同一 run 的上一个请求比较；每个 run 的第一个请求不参与比较，标为 `first`。汇总时按 run 分别列出，再给全局合计。测试：构造主、子代理交错的请求序列，各自工具列表固定时不出现 `tools-changed`。

**M2 新增 `scripts/comparison/frontier/delegation-metrics.mjs`。** 按第 9 节计算指标，输入是 relay 请求、`process/steps.jsonl` 和会话数据库（只读打开）。要求：

- shell/process 调用按命令文本分类为 `read`、`search`、`write`、`test`、`git`、`unknown`。只认明确的模式（`sed -n`、`cat`、`head`、`tail`、`grep`、`rg`、`find`、`ls`、重定向写入、`python -c`/heredoc 写文件、`pytest`、`git`）；带管道组合、内联脚本等无法确定的一律 `unknown`，并在报告中单列数量，不并入任何一类。
- 读取按"路径 + 区段"计：`file.read` 用 `offset`/`limit`，`sed -n a,bp` 用行号区间。实际内容或哈希一致才计确认重复；没有成功写入不足以证明内容未变，证据不足标为 unknown。相邻或不同区段不算。
- 首次修改指目标项目源码实际变化，排除临时脚本创建、无变化写入与失败但效果不明的调用。后续 diff 只能证明首次观察或修改时间区间，不能倒推精确时刻。历史 FastAPI 的第 20 步需结合脚本执行结果及第 21 步 diff；不能靠工具名称推定。
- 测试：用一份小的合成证据覆盖各分类、`unknown`、分页不计重复、同区段重复计入；再对 FastAPI 证据输出一次，人工核对第 20 步和 37 次 shell 调用。

**M3 冻结 R0。** B1–B4、M1、M2 完成后，先用固定身份、冻结状态与脚本响应保存确定性基线；D/E 可据此直接开发验证。真实 FastAPI 单格是另行确认的付费冒烟实验（约 47 credit），不作为实现前置条件，也不替代正式对照中的同期 R0。

## 5. 阶段 1：交接指导（开关 D）

D 只改模型看到的指导文本，不改派发规则、权限、工具集合或运行时校验（派发规则已在 B2 中修正并固定在 R0 里）。沿用 A/B/C 的机制：`ApplicationOptions.agentFactors`、CLI 的 `--agent-factors`、[host-state.ts](../src/cli/host-state.ts) 校验，以及 [agent-factors.ts](../src/runtime/agent-factors.ts) 的渲染时替换。D 关闭时请求与 R0 逐字节一致。新文本放在新模块 `src/messaging/handoff.ts`，不继续加长 544 行的 `messaging/index.ts`。

**5.1 主代理指导：探索到能分工就停。**

- 入口、模块边界、共享接口和验收方式清楚后就派发，不必先把实现细节研究完。
- 派发后不再探索已交出的范围，转去处理依赖、接口和其他独立事项。
- 实现和对应的检查交给同一个负责人，不把"探索、修改、测试、整理报告"拆给不同代理。
- 简单阅读、问答、小文档修改直接做。

**5.2 交接填写指导，不新增字段。** 改写 `spawn_agent`、`followup_task` 中 `context`、`inputs`、`acceptance` 的参数说明：

| 内容 | 写在哪里 |
|---|---|
| 目标：必须完成的行为 | `objective` |
| 起点：相关文件、符号、已确认的调用关系 | `inputs` |
| 已知：核实过的事实、已约定的接口 | `inputs` 或 `context` |
| 未知：仍需调查的具体问题 | `context` |
| 范围：负责的文件，以及与他人的边界 | `scope.write` 和 `context` |
| 验收：要通过的检查、可复用的已有证据（call ID、artifact ID） | `acceptance` |

只是填写指导，运行时不校验。同时压缩 `spawn_agent` 的描述（当前 4,228 字符，最大的单个定义），D 开启后协调工具定义的总长度不超过 R0。

**5.3 子代理起步规则。** D 开启时，任务包（[messaging/index.ts:367](../src/messaging/index.ts)）末尾追加固定文本：

- 从 Inputs 列出的文件和符号开始，修改前先读取当前内容。
- 只有已知事实与代码冲突，或缺少依赖时，才扩大调查，并在报告中说明冲突。
- 不重新寻找已经给出的入口。

`followup_task` 使用同一段文本。只读 explore 子代理也加上，去掉"修改前"一句。

**5.4 续接与跨代理传递。**

- 同一模块的补充需求和验收修正，用 `followup_task` 交给原代理；独立审查、新领域或无关任务才新建代理。
- 只读的探索代理续接后仍然只读。实现要接在某次探索之后时，新建实现代理。
- 子代理不能用 `inspect_run` 读兄弟运行（[inspection.ts:24](../src/runtime/inspection.ts) 返回 `INSPECT_DENIED`），所以指导写明两条路径：主代理把探索结论的要点写进新代理的 `inputs`/`context`；或者要点较长时，主代理用 `artifact.write` 存成共享工件，把 artifact ID 写进 `inputs`，子代理用 `artifact.read` 读取（会话内可读）。指导里不出现"让子代理去查兄弟 run"。

**5.5 确定性测试**（脚本 provider，不调用真实模型）：

- D 关闭时，主、子代理请求与 R0 逐字节一致。
- D 开启时，任务包含起步规则；`followup_task` 保留原代理的身份和模型。
- 只读代理续接后仍无写权限。
- 主代理写入的 artifact，子代理能用 `artifact.read` 读到。
- 协调工具定义总长度不超过 R0。
- D 开启不改变派发结果：同一脚本下，D 开与关的派发调用、错误码和完成检查结论相同。

## 6. 阶段 2：主代理视图（开关 E）

E 与 D 独立。底层工具一个都不删，主卡片本身也不改；E 只决定顶层 run 能看到和能调用哪些原生工具。会话因子在创建会话时保存，同一会话内 E 不会变化。

**6.1 一份规则，三个入口共用。** 新增 `src/runtime/role-view.ts`，导出 `roleAllows(run, session, name): boolean`。以下三处都调用它，不各自维护列表：

- 请求：`toolSpecs`（[step-host.ts:40](../src/runtime/step-host.ts)）过滤原生工具和协调工具。
- 原生工具执行：`Tools` 三处 `validate` 调用（[tools/index.ts:375](../src/tools/index.ts)、393、418）传入的 `allowed` 先经过 `roleAllows` 过滤。被拒时返回 `TOOL_DENIED`，消息说明应交给哪类子代理。
- 协调工具执行：`Mailbox.validate`（[messaging/index.ts:123](../src/messaging/index.ts)）已经以 `specs(run)` 为准；`specs` 内部调用 `roleAllows`，执行端自然一致。

E 关闭时 `roleAllows` 恒为真。子代理（有 `parentId`）恒为真，它们的工具仍由卡片和权限决定。

**6.2 E 只下放执行类和专用原生工具。**

| 主代理保留 | E 开启时下放给子代理 |
|---|---|
| `file.read/list/search`、`file.patch/apply_patch/mkdir/rename/delete` | `shell.exec`、`process.exec`、`process.read` |
| `artifact.read/write`、`history.*`、`recovery.inspect`、`knowledge.*`、`todo.read/write` | `image.read`、`web.fetch`、`lsp.*` |
| `process.run`（主机声明的只读命令） | |
| 全部协调工具：`spawn_agent`、`followup_task`、`explore`、`send_message`、`wait_for_events`、`inspect_run`、`cancel_agent`、`interrupt_agent`、`list_agents`、`update_progress`、**`ask_user`** | |
| 现有路由与成员工具：`agent.route`、`agent.search`、`agent.directory`、`agent.derive`、`agent.propose`、`agent.retain` 保持现状 | |

修订前把 `agent.derive` 等列为"下放"，这不对：`agent.derive` 是主代理专用（[derive.ts:18](../src/agents/derive.ts) `main: true`），子代理本来就没有，移除等于关闭能力。是否精简路由和成员工具，另行评估，不放进 E。

**体积**：按 `request-1.json`，下放的 4 个工具（`shell_exec` 667、`process_exec` 1,378、`process_read` 876、`image_read` 472 字符）共 3,393 字符，约占工具定义 37,341 字符的 9%。`web.fetch` 和 LSP 在那次运行中不可用，未计入。E 的主要目的是改变分工（主代理不能自己执行命令完成实现），体积下降是次要的，不作为验收依据。

**6.3 子代理的执行能力**由 B3 的 `1.1.0` 预设提供；继承主卡片的子代理本来就有 `shell.exec`。E 不再改预设。

**6.4 说明文本同步。** E 开启时，从主代理提示中删除 `shell.exec`、`image.read` 的用法说明（[card.ts:156](../src/agents/card.ts)），改为"需要运行命令的工作，连同修改和验证一起交给实现代理；git 提交写进实现代理的验收要求"。

**6.5 风险与备选。**

- 主代理不能自己运行命令。FastAPI 要求"新建分支并提交"，必须写进实现代理的验收；小任务也至少多一次派发。只读的 `git status`、`git diff` 可以由主机在 `process.run` 中声明。
- TUI 的 `/process` 读取（[controller.ts:768](../src/tui/controller.ts)）用进程所属 run 的 ID 调用 `process.read`。E 开启后主代理不会启动进程，子代理的进程按子代理身份读取，不受影响；测试中确认这一点。
- 若对照显示小任务的墙钟或费用明显变差，备选 E′：主代理保留 `shell.exec` 和 `process.read`，只下放 `process.exec`、`image.read`、`web.fetch`、`lsp.*`。E′ 单独一组测量。

**6.6 确定性测试：**

- 对每个注册的工具名：E 开启时，主代理请求中是否出现，与执行端是否接受，结果一致（原生和协调工具都测）。
- 下放的工具被调用时返回 `TOOL_DENIED`，消息指向实现代理。
- `ask_user` 在 E 开启时：提问后 run 进入持久等待；用户回复后继续执行；等待中重启进程，恢复后仍在等待并能继续。
- `wait_for_events`、`cancel_agent`、`inspect_run`、`recovery.inspect`、写入阻塞时的交接在 E 开启时可用。
- 继承主卡片的子代理仍有 `shell.exec`；`1.1.0` 预设子代理有 `shell.exec`。
- 一次运行中主代理所有请求的工具定义逐字节相同。
- E 关闭时请求与 R0 逐字节一致。

## 7. 阶段 3：并行建立在明确所有权上（D、E 有收益后再做）

**7.1 指导文本**：跨模块功能先由一个执行者负责共享接口和核心行为；接口确定后，其他执行者再分别负责独立模块。每个执行者完成自己的修改和相关测试，主代理检查各模块证据，必要时安排一次集成验证。仍然高度耦合的工作不强行并行。

**7.2 运行时：现有拒绝行为不放宽。** `assertNoWriteConflict`（[spawn-spec.ts:147](../src/messaging/spawn-spec.ts)）有两种模式：

| 模式 | 何时生效 | 哪些写代理参与冲突判断 | 冲突时 |
|---|---|---|---|
| strict | v2 卡片，或因子 A/C 开启（[messaging/index.ts:351](../src/messaging/index.ts)） | 所有声明了非空写范围的代理，以及未声明写范围、继承整个工作区的代理 | 拒绝，`WRITE_SCOPE_CONFLICT` |
| 旧模式 | 其他情况 | 只有写范围比父级更窄的代理 | 拒绝 |

R0 使用 `A,B,C`，即 strict 模式：两个都继承整个工作区的写代理已经会被拒绝。阶段 3 不改这两种模式的判定，只在指导文本里提示"并行写代理需要不相交的 `scope.write`"。旧模式下继承工作区的写代理之间不检查，这个缺口是否要补，等指标显示真实发生过同文件冲突后再单独提案。

**7.3 验收**：看第 9 节的"实际并行"和"总体收益"。代理数量不作为成功条件。

## 8. 阶段 4：上下文继承（暂不做）

前三个阶段完成后，如果"重复探索"指标仍显示子代理大量时间花在重新理解已交接的信息上，再考虑可选的父上下文继承，只用于高度依赖主代理已有调查的任务。本方案不实现共享记忆或自动摘要。

## 9. 指标

由 M2 的脚本计算。每项都按 run 分别给出，再汇总。

| 指标 | 计算方式 |
|---|---|
| 派发效率 | 从运行开始到首次成功派发（`spawn_agent`、`followup_task`、`explore` 返回 run ID）的时间和请求数；派发失败次数及错误码 |
| 执行启动效率 | 子代理从启动到首次有证据的源码变化的时间和请求数；仅有后续快照时报告区间 |
| 重复探索 | 子代理对交接 `inputs` 中已给出路径的搜索和列目录次数（原生 + shell `search` 类）；同一路径同一区段、内容未变的重复读取次数（原生 + shell `read` 类）。修改前对目标文件的首次读取、审查代理的读取不计入。`unknown` 类 shell 调用单独列出 |
| 主代理探索量 | 首次派发（或首次修改，取较早者）之前的工具调用数、shell 读取数、推理 token、credit；派发后对已交出范围的读取次数 |
| 实际并行 | 各写代理执行区间的重叠时长；因写范围冲突或写锁而等待的次数 |
| 验收开销 | 相同命令且实际源码状态证据一致的重复检查；无状态证据时仅为候选；交付后多出的模型请求数 |
| 子任务收尾 | 主代理结束时各直接子运行的状态分布；B2 拒绝完成的次数及原因 |
| 总体收益 | 墙钟时间、credit、失败重试次数、外部验证结果、是否完整交付（提交并给出最终说明） |
| 工具集合稳定 | 每个 run 内，所有请求的工具定义是否逐字节相同；不同则列出变化的步号和工具名 |
| 实际缓存表现 | 每个 run 的缓存命中率；按 run 序列比较得到的 `cacheDrops` 及原因 |

缓存指标的用法：

- "工具集合稳定"是确定性检查，E 开启后主代理必须为是；它直接从请求字节判断，不依赖缓存数字。
- "实际缓存表现"受 provider 侧路由、淘汰影响。`cacheDrops` 的分类只是结构线索，不证明因果。历史更短、请求更少可能降低缓存比例却节省费用和时间，所以比例不得单独作为验收门槛；按完整交付、实际费用和耗时判断。

## 10. 对照实验

- **任务**：FastAPI（单模块、耦合较强，用来检验是否出现"为了委派而委派"），加上 [engineering-evaluation-tasks.md](engineering-evaluation-tasks.md) 中一个跨模块任务（如 E04 或 E06）。实验前先确认该任务的资产和独立验收可以运行。
- **分组**：R0（M3 冻结的基线，D、E 关闭）、RD、RE、RDE，必要时加 RE′。每组 3 次，同一模型、预算、网关时段，会话因子都包含 `A,B,C`。
- **判定**：主要看完整交付率、墙钟时间、credit；第 9 节其他指标用来解释。相对 R0 没有改善的开关不进入默认配置。
- **成本与安排**：单格约 47 credit。两个任务、4 组、各 3 次约 24 格。先跑 FastAPI 的 12 格，R0 与 RD/RE/RDE 交错安排，记录网关和顺序；早期 M3 冒烟不能替代同期 R0。每批执行前单独确认。

## 11. 不在本方案范围内

- 新的代理体系、共享记忆、自动摘要、完整历史复制。
- 新的强制交接字段或报告工件。
- 合并文件工具或改造工具协议。
- 动态工具发现。现有 `lazyTools` 保持现状。
- 精简路由与成员工具（`agent.search`、`agent.directory`、`agent.derive`、`agent.propose`、`agent.retain`）。
- `agent-card-design.md` 修订 2 的 A1–A7。关系：B3 的版本升级方式（新版本、旧版本保留注册）与 A3 的预设迁移一致；若之后进行 A1，`1.1.0` 预设并入 A3，不重复发布。

## 12. 实施顺序与验证

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | 4.1 保留已有工作和证据 | 记录本轮测试，区别历史失败 |
| 2 | B1–B4，分别验证 | 各项列出的测试；全量测试的失败用例集合与 0.4 相同 |
| 3 | M1、M2 | 新脚本的 `node --test`；FastAPI 证据回归得出第 20 步、91 次 shell/process 调用 |
| 4 | 相同冻结状态的确定性 R0；M3 付费冒烟另行确认 | 请求与工具字节等价；真实模型不做字节比较 |
| 5 | 开关 D | 5.5 的测试；D 关闭时与 R0 逐字节一致 |
| 6 | 开关 E | 6.6 的测试；E 关闭时与 R0 逐字节一致 |
| 7 | FastAPI 对照（付费，需确认） | 按第 10 节判定 |
| 8 | 阶段 3，视第 7 步结果决定 | 7.3 |

组件阶段运行对应的确定性测试；集成后统一运行 `npm run build`、全量 Vitest、`npm run check` 和测量脚本测试，并按 0.4 比较具体失败用例与原因。2026-10-30 按用户要求将新会话 D/E 默认开启；实验显式指定各组开关。不为固定行数机械拆分模块。

## 13. 实现与使用

B1–B4、M1/M2、D/E 已落地。子任务完成检查另覆盖两个边界：子代理仍在工作时不消耗交付审计次数；最终状态提交前重查子任务，防止异步验收期间派发的新任务被取消。失败、取消和续接结果保存在最终结果的 `children` 元数据中，原失败记录不改写。

2026-10-30 起新会话默认 A/B/C/D/E；旧会话保留冻结配置。关闭 D/E 使用 `--agent-factors A,B,C`，只启用 D 使用 `--agent-factors A,B,C,D`；同时启用 E 使用 `--agent-factors A,B,C,D,E`。参数传给现有的 `run`、`chat` 或 `serve` 命令。恢复旧会话沿用保存的因子，不被宿主当前默认值覆盖。

测量脚本用法（只读历史证据，不发模型请求）：

```powershell
node 'scripts/comparison/frontier/delegation-metrics.mjs' '.kodo/frontier-fourway-recorded-fastapi-kodo/fastapi-kodo' --source-root 'fastapi' --out '.kodo/delegation-metrics-recorded-fastapi.json'
```

历史证据复核：1 个运行、0 次派发、91 次 shell/process；首次源码变化候选第 20 步，之前 38 次工具调用、37 次 shell/process、107,405 推理 token、16.15 credit。候选步与快照观察区间分别保存，没有将区间当成精确修改时点。

2026-10-29 实现轮的测试原始记录在 `.kodo/scratch/role-handoff-full-suite-final.log`、`role-handoff-check.log`、`role-handoff-script-tests.log`。原始全量过程日志另存为 `role-handoff-full-suite.log`，保留修复前的测试失败；以最终稳定代码的重跑为准。该实现轮没有提交混合工作区或进行付费实验；2026-10-30 的默认调整和付费实验见下文。

最终验证（2026-10-29）：`npm test -- --reporter=verbose` 完成构建，168 个测试文件全部通过，1,991 项通过、9 项按环境跳过，共 2,000 项；`npm run check` 通过。trace、delegation-metrics、native、relay 的 Node 测试共 31 项通过、1 项 Windows SIGTERM 跳过。历史模型列表超时和 TUI 失败在最终重跑中均未复现；首次集成暴露的旧协作测试假设已修正，仍保留消息送达、恢复不重放和权限断言。

## 14. 2026-10-30 执行调整

用户要求默认开启 D/E，并将本次消融收缩为仅 Kodo、FastAPI 四组（R0/RD/RE/RDE）各一次，替代本批原定的 12 格。先运行全量测试，对发现的问题修正并复测相关用例，再启动实验；冻结同一构建，串行运行，保留全程请求/响应、原生状态、工具计时、工作区快照和 Git 交付状态。单次结果只作探索，不能当作稳定收益或统计显著性。M2 分类修复应用于全部组；五分钟等待与待办前缀暂不混入本轮改动，以便单独解释 D/E 的差异。

## 15. 2026-10-30 实测结果

四格已按 R0 → RDE → RD → RE 各运行一次，均正常退出并通过 137/137 新功能和 3134/3134 回归验证。墙钟/已知 credit：R0 3237.337 秒/20.48，RDE 2819.032 秒/23.71，RD 4797.870 秒/至少 41.98（1 请求费用缺失），RE 2291.976 秒/18.89。默认仍按用户要求开启 D/E，没有依据单样本自动回退配置。

完整分析见 [kodo-handoff-ablation-20261030.md](experiments/kodo-handoff-ablation-20261030.md)。RE 本轮最快且费用最低，但执行策略、故障与上游延迟不同，不能直接宣布 E 的稳定因果收益。主要问题是 R0 的后台等待占用整工作区写锁、RD 未及时交付的长时间只读审查、取消后上游仍生成内容，以及各组验收的模型往返。优先优化这些路径，再考虑继续收缩工具。

默认调整后的全量记录为 166 文件通过、2 文件失败（1991 通过、2 失败、9 跳过）；旧 CLI workbench 夹具已修正，模型列表截止时间用例复测通过，相关 4 文件 57 项全部通过。未声称第二次全量通过。`npm run check` 通过；trace/delegation-metrics/native/relay 的 Node 测试 37 通过、1 个 Windows SIGTERM 跳过。日志为 `.kodo/scratch/handoff-default-on-{full,rerun,check,scripts}-20261030.log`。

证据根目录 `.kodo/handoff-ablation-fastapi-20261030`：669 个请求及响应文件齐全，3080 个原始文件哈希全部一致，因子/构建/任务文本一致，详见 `integrity.json`。原始日志不改写；离线汇总在 `analysis.json`。初始仓库只有 master、任务文字却要求 main，这项共同的交付歧义在报告中独立说明。
