# Ky v2-r6：失败归因、同类实现核对与修正顺序

日期：2026-10-25。范围：核对当前源码、冻结的 v2-r6 报告及 SQLite/请求快照，以及 Pi、OpenCode、DeepSeek Harness 源码和 Codex 官方文档。本次不修改生产代码，不重新执行付费实验，不改变冻结结果或停止规则。

## 1. 结论

当前证据不支持推翻 Kodo 的多代理或上下文设计，但已支持修正几处基础执行契约。最重要的问题是：

1. **代理没有公开回归测试的执行反馈。** 沙箱预检通过并不代表 Ky 的实际测试链能运行；实验主动排除了 AVA，最后却用宿主 AVA 判定交付。A1、D1 确有语义错误，环境问题解释了错误为何难以被发现，不能把代码错误豁免掉。
2. **B2 的高开销不只是多了子代理。** 主代理发生 46 次硬容量裁剪，缓存命中率只有 65.41%；约 79.77% 的未缓存输入来自主代理。硬裁剪反复填满窗口并改写靠前归档标记，是重要的成本放大机制。
3. **正常取消被实验停止规则当成全局计量故障。** 取消请求后没有最终 usage 是允许发生的状态，必须保留费用不确定性，但不能与记账损坏、上游故障混为一类。
4. **并行写入范围没有落实为调度约束。** B2 同时存在写 `test/` 和写 `test/retry.ts` 的活动子任务，随后取消后者。没有观察到由此造成的文件损失，但已能证明“不重叠分工”的提示不是实际保证。
5. **输出截断修复只是一种有限恢复，且失败路径会丢失已知 usage。** 同参数重试不能解决确定性输出容量不足；当前 provider 已收到的 usage 在抛出截断异常时没有传回结算层。

不要先增加新的代理类型、复杂路由或更多压缩层。先修测试反馈、预算/计量契约和硬裁剪行为，再测委派收益。

## 2. 这轮结果应如何读

原始结果：[v2-r6 结果](ky-total-timeout-v2-r6-results.md)。冻结证据：`.kodo/ky-total-timeout-paid-20261025-110711/`。

- 6/8 完成；D2、A2 未运行。B2 的功能结果保留，但用量不完整。不能补跑两个修改后的 trial，就把它们拼成同一版本的完整矩阵。
- B1、C1、C2、B2 通过当前 14 项自动检查。A1、D1 的 T12、T14 都受同一个 `actualRegression` 失败影响，因此 12/14 不是两个独立错误。14/14 也不是所有语义的形式化证明：文档检查等仍包含存在性/正则检查。
- A1 新测试预期 `TimeoutError`，实际为 `HTTPError`；D1 破坏已有 `shouldRetry: works with TimeoutError` 断言。这两例是具体行为差异，不能未经重现就归为定时测试抖动。
- 本轮没有输出截断，所以没有实测证明输出重试修复有效。
- 两次字段级错误的下一次调用纠正，支持“明确错误信息有助于恢复”。未发生格式错误的 `expectedHash`，因此新增 hash 格式提示未实测。
- 四次带当前 hash 的 `FILE_CONFLICT` 均来自 `file.apply_patch`，这一路已有该信息；不能把它们归功于此次新增的 rename/delete 提示。
- 本轮无模型调用数/token 总量上限：`eval.mjs` 明确使用 `unrestricted: true`，运行预算只设窗口、单次输出、并发和子任务创建数等参数。因此数百万累计输入并不是违反了本轮 token 总预算；它说明收益和经济性仍需控制与衡量。

代码入口：[预检](../../scripts/comparison/ky-total-timeout/preflight.mjs)、[实验运行器](../../scripts/comparison/ky-total-timeout/eval.mjs)、[判定器](../../scripts/comparison/ky-total-timeout/oracle.mjs)。

## 3. 首要问题：验证反馈没有形成闭环

`preflight.mjs` 检查 Node、受限文件、管道子进程快速拒绝、TypeScript 编译、导入和 source lint，没有运行 AVA。实验给代理的环境说明明确要求不要在沙箱运行 AVA，宿主会在验收时运行它。

这套预检证明了“限定命令可运行、禁止项会被拒绝”，没有证明“真实工程任务可自行验证”。类型检查不验证异常类型、重试次数或取消语义；临时 fake-fetch 脚本也不能完整替代已有回归套件。

具体限制来自当前 Windows 后端的 `node-compat.cjs`：拦截带 pipe/IPC 的子进程，`fork` 也受限。它是当前后端的兼容性边界，不应表述为所有 Windows 沙箱、所有 AppContainer 或所有 harness 都必然不能跑测试。

**优先修复路径：**

1. 优先复用能支持工程测试的隔离执行环境，例如配置妥当的 WSL/容器或兼容子进程的本地后端。必须验证完整的 AVA → TypeScript 加载器/esbuild → 子进程链，不能只验证 AVA 自身启动。
2. 如果短期不能修本地后端，提供一个宿主配置的项目验证入口。它在隔离的工作区快照中运行公开的项目检查，并把退出码和失败详情返回代理。固定命令不等于安全：提交的源码、测试和插件同样是可执行代码，不能直接借此获得不受限的宿主权限。
3. Ky 的服务器测试需要测试环境内的回环监听/连接；应与访问外网分开配置。当前“无网络”的约束不能无差别阻断本地测试基础设施。
4. 私有验收仍独立运行。代理可以看公开测试输出，不能看到隐藏断言。源码或测试再次修改后，之前通过的快照不再代表当前产物。

预检至少增加：原始仓库真实 AVA 成功；已知错误快照能返回相应失败；测试超时能够回收进程树；写入和网络限制仍有效。仅把 `pipedChild` 从拒绝改为成功不足以验收。

## 4. 新发现：B2 的硬裁剪与缓存退化

本次从冻结 SQLite 事件、每次模型请求快照和报告重新计算：

| Trial | 主代理请求 | 主代理未缓存输入 | 主代理输入缓存率 | 主代理硬裁剪次数 |
| --- | ---: | ---: | ---: | ---: |
| A1 | 93 | 251,199 | 93.04% | 5 |
| D1 | 140 | 325,462 | 91.63% | 4 |
| B1 | 122 | 314,482 | 93.63% | 7 |
| C1 | 157 | 279,527 | 94.00% | 6 |
| C2 | 121 | 272,360 | 92.25% | 5 |
| B2 | 105 | 1,346,058 | 65.41% | 46 |

主代理请求数以报告 `usage.roles.main.requests` 为准；摘要调用单独计量。派生数据在 `.kodo/research/r6-harness-review/local-derived-metrics.json`。

B2 子代理贡献 142 次请求、341,444 未缓存输入；主代理贡献 105 次请求、1,346,058 未缓存输入。B2 主代理请求数甚至少于未委派的 B1，但主代理未缓存输入约为 B1 的 4.28 倍。

源码机制见 [context.ts](../../src/runtime/context.ts)：硬容量分支从近期轮次向回填充，只要 `fits` 就保留，结果经常接近允许输入上限。B2 样本裁剪后估算输入为 57,236、56,952、57,300 token；65,536 总窗口扣除 8,192 输出预留只剩 57,344，几乎没有后续增长空间。单次新观察就可能再次裁剪。

此外，每次硬裁剪产生新的归档引用、遗漏计数/摘录，标记放在第一个 assistant 之前。B2 相邻请求首次变化经常发生在第 5–7 个消息；这会改变后续可复用的前缀。三组 A1/B1/B2 各自的工具 schema 都只有一个版本，没有证据支持“动态工具 schema 变化是这轮缓存下降原因”。

这些证据支持“频繁硬裁剪和前缀变化是重要贡献因素”，还不能精确分摊上游缓存策略、请求交错、回读等因素各占多少成本。不要把缓存机制归因写成已经做过消融实验。

**修复应直接针对现有硬裁剪分支：**

- 区分“触发上限”和“裁剪后目标”，保留下一阶段的增长空间。可先离线比较有效输入容量的 75%/80% 两个目标，不把比例直接当产品保证，也不额外增加一套框架。
- 主动 summary 关闭时，硬窗口保护仍须工作；明确 `off` 是关闭主动摘要，不是无限历史。本轮 A/B 都发生了硬裁剪。
- 一次处理完整旧轮次，保持 assistant/tool 配对和必要约束，保留可追溯引用；避免每轮只腾出几百 token。
- 在发生裁剪的时点一次性生成稳定检查点。新的遥测/状态尽量在尾部，不每轮更新早期检查点或随机化工具定义。
- 对大探索报告保留决策摘要、证据索引和按需读取入口。不要无条件把全部工具原文注入主代理。
- 离线同时统计裁剪次数、连续两轮再次裁剪、保留内容和前缀变化；改变投影后的模型轨迹尚未知，不能由离线 token 下降直接宣称质量提升或费用降低。

## 5. 委派不是没能力，而是范围和协调仍不稳定

B2 实际链路：

1. 第 11 步 `explore` 创建两个只读子任务，报告约 9,423、6,699 字符。
2. 第 16 步创建测试修改子任务，写入范围为整个 `test/`。
3. 第 56 步再申请三个按文件划分的测试子任务。其中 `test/retry.ts` 创建成功；`test/hooks.ts`、`test/http-error.ts` 因累计创建额度 4/4 被拒绝。此时原 `test/` 写任务仍活动，成功创建的文件任务与它范围重叠。
4. 第 60 步取消 `test/retry.ts` 子任务，该请求尚未收到 usage。

因此“4 个子代理”包含两个只读探索、一个完成的测试修改和一个被取消的测试修改，不是四个有效并行实现模块。`spawnCalls=4` 也不等于四次成功创建：两次显式 spawn 被拒绝，另两个孩子由 explore 创建。

当前系统提示要求不重叠范围，但调度仍接受重叠申请。应在共享工作区模式下，对活动写入范围做最小冲突检查：目录包含文件也算重叠。冲突时返回谁持有范围、可以缩小到何处或等待其结束；不必立即引入复杂工作流系统。真正需要重叠并行修改时再使用独立工作树和显式合并。

创建总量与活跃并发是不同约束，不能把前者悄悄改成无限可循环额度。先清晰暴露剩余容量，支持在已有非终态任务中沟通/调整工作，避免“广范围任务还在执行，又启动文件任务”的重复分派。

预算不应只是为了防止报错：未来工程对照应给各组相同会话总费用/调用/时间约束，并为主代理最终集成验证保留预算。子代理不需要每次都跑全量套件，但主代理必须能验证最终合并状态。

## 6. 输出截断和 usage 结算仍有契约缺口

当前 [model-step.ts](../../src/runtime/model-step.ts) 对同一不可变请求最多尝试三次，其中 output-limit 额外恢复至多一次。拒绝执行不完整工具调用是正确的。

但注释把输出上限停止概括为随机事件，不够准确：推理预算和答案共享输出空间、参数本身过小、大 patch 输出过长，都可能稳定重现。原参数重试可以保留为有限的偶发恢复，不能称为完整的截断修复。

更直接的实现问题：

- [openai.ts](../../src/providers/openai.ts) 先解析并保存流的 usage，遇到 `finish=length` 时只抛出 `{outputLimit: true}`。
- [anthropic.ts](../../src/providers/anthropic.ts) 也收集 usage，但 `max_tokens` 异常不携带它。
- [responses.ts](../../src/providers/responses.ts) 在 `response.incomplete` 分支没有把响应可能存在的 usage 交给结算层。
- `recordFailure` 只区分 `usageKnownZero` 和未知，所以已知用量可能退化为未知、保留预留量并设置 estimated。真实 r6 没有触发该问题，不能把它解释为本轮中断原因；它是源码检查发现的下一处风险。

最小修复是把“尝试结果”和“计量结果”分开携带，不需要重写所有 provider：停止原因、可用 usage 及其完整性、是否允许恢复都保留下来。未完成响应有准确账单，准确账单不意味着响应可执行。

恢复策略应区分：短暂传输错误退避重试；输入溢出释放输入空间；输出不足在模型和总预算允许时提高输出余量，或降低受支持的推理配置、拆小修改。不要为了修输出上限无条件删除输入证据，也不要拼接执行半截工具 JSON。

## 7. 取消用量应影响经济性结论，而非一律使矩阵失效

本轮按冻结规则停止是正确的。应修改下一版规则，而不是改写 r6 的结论。

建议保留至少三种计量状态：实测、明确零用量、未知/部分已知；另行记录终止原因（用户/主代理取消、超时、上游故障、正常结束）。最后可用的流中 usage 是证据，但未必是最终账单；须区分累计/增量语义，不能重复相加。

对于已关联到主代理 `cancel_agent` 的取消：

- 已收到完整 usage 则按实测结算；未收到则保留未知，不报零费用。
- 功能检查可以独立成立，精确费用比较不能成立；聚合报告标明缺失请求数和已知下限。
- 仅在不确定费用/次数达到预注册容忍度，或独立硬预算无法继续保证时停止后续运行。
- 预留 token 是计量估算，不天然构成服务端收费的严格上界；取消连接也不保证上游立即停止计费。
- 不把一次正常取消放入 provider 故障连续计数。当前 `run.cancelled` 还写成泛化的 `user cancelled`，应保留真实发起者和关联调用，方便审计。

账本损坏、重复结算、无法关联请求身份与正常取消不同，仍应停机。参考 [relay.mjs](../../scripts/comparison/relay.mjs)。

## 8. 同类项目如何处理；是否也会出问题

这部分是当前源码/文档机制对比，不是同任务性能测试。不能由机制判断它们能通过 Ky 或比 Kodo 更省钱。Pi、OpenCode、DeepSeek 固定到下述 SHA；Codex 使用当日获取的官方文档。

| 产品 | 本次查到的处理 | 对 Kodo 的启发与边界 |
| --- | --- | --- |
| Pi | Bash 工具通过管道采集 stdout/stderr，返回退出码，超时/取消清理进程树；编辑工具匹配唯一旧文本，支持一次修改多个不重叠片段。会话对可恢复 length/context overflow 做一次压缩恢复，普通暂态错误走独立重试路径。 | 优先让模型运行真实验证命令；输出限制与传输重试分开。Pi 的本地 Bash 与 Kodo AppContainer 权限不同，执行能力更宽不代表隔离更强。不能保证任意机器上的 AVA 都成功。 |
| OpenCode | Shell 工具有输出、超时和后台执行语义；编辑工具检查唯一匹配。模型重试区分类型并有退避/次数界限；step 先保存可用 usage，再将 `length` 映射成独立 `OutputLimit` 结果。compaction 有 buffer/保留近期历史和缓存相关设计。 | 借鉴“保存尝试证据，再作恢复决定”和压缩余量。仍可能遇到测试不可运行、截断、缺失最终 usage；本次没有验证其完整续写路径或 Windows Ky 兼容性。 |
| Codex | 官方文档将沙箱和审批策略分开；云环境可通过 setup/maintenance 安装依赖；Windows 文档提供原生沙箱和 WSL 路径，并明确兼容性限制。 | 测试环境是产品能力的一部分，受限操作不能直接等同代码失败。官方页面不足以证明它采用何种精确输出截断/取消计费恢复，不能凭印象断言“自动解决”。 |
| DeepSeek Harness | 沙箱层区分能力限制、权限拒绝和后端启动失败；Windows ACL 后端提供受限令牌+管道进程适配，但文档明确部分隔离边界，网络不是该文件沙箱模式的承诺。重试插件按 provider 策略执行；normal 默认只重试指定暂态错误，取消抑制重试。流结束后保留 attempt/message 及 usage，`max-tokens` 独立表示。 | 借鉴明确的执行能力报告和“失败尝试也可计量”。不能把 ACL 后端当成等价替换 Kodo AppContainer 的补丁。其 token-meter 对无 usage 样本不增加总计，也不能据此宣称它恢复了未知真实账单。不要照搬可选无限重试。 |

所以共同问题确实都会出现：模型写错、测试失败、输出上限、取消后缺少最终 usage、并行相互影响。Kodo 特有的重点是当前几项规则组合后放大了问题：公开测试不可见、硬裁剪频繁改前缀、取消触发全局停止、分工约束只写在提示里。

### 可核查来源

- Pi `d5b3de22d0e24a3e9c38a9410d3329b099717283`：[Bash](https://github.com/badlogic/pi-mono/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/coding-agent/src/core/tools/bash.ts)、[编辑](https://github.com/badlogic/pi-mono/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/coding-agent/src/core/tools/edit.ts)、[会话恢复](https://github.com/badlogic/pi-mono/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/coding-agent/src/core/agent-session.ts#L3037)。
- OpenCode `9cc9e58c73a13d0d5aa29300b401b29a9266dad8`：[Shell](https://github.com/anomalyco/opencode/blob/9cc9e58c73a13d0d5aa29300b401b29a9266dad8/packages/core/src/tool/plugin/shell.ts)、[重试](https://github.com/anomalyco/opencode/blob/9cc9e58c73a13d0d5aa29300b401b29a9266dad8/packages/core/src/model-retry.ts)、[usage 和 OutputLimit](https://github.com/anomalyco/opencode/blob/9cc9e58c73a13d0d5aa29300b401b29a9266dad8/packages/core/src/session/runner/step.ts#L235)、[compaction](https://github.com/anomalyco/opencode/blob/9cc9e58c73a13d0d5aa29300b401b29a9266dad8/packages/core/src/session/compaction.ts)。
- Codex：[沙箱与审批](https://developers.openai.com/codex/agent-approvals-security/)、[Windows](https://developers.openai.com/codex/windows/)、[云环境](https://developers.openai.com/codex/cloud/environments/)。
- DeepSeek Harness `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`：[沙箱边界](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/subsystems/sandbox.md)、[Windows 管道进程适配](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sandbox/sandbox-windows-acl/src/spawn.ts)、[重试策略](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm/src/retry-policy.ts)、[agent 结束处理](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L495)、[用量投影](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/token-meter/src/usage-projection.ts#L104)。

## 9. 接下来的修正与实验顺序

| 阶段 | 动作 | 通过条件 |
| --- | --- | --- |
| 零模型费用：测试反馈 | 在选定隔离环境运行实际 AVA 及依赖链；用 A1/D1 的副本复现失败并验证输出返回 | 原始/参考快照通过；错误快照给出预期失败；超时、回环服务、进程回收和权限边界正常 |
| 零模型费用：计量 | 三种 provider 的截断响应夹具；取消发生在 usage 前后；取消与完成竞争 | 已收到用量不丢失；未知不伪报零；每次尝试仅结算一次；截断工具零副作用；正常取消不算 provider 故障 |
| 零模型费用：委派 | 创建 `test/` 与 `test/retry.ts` 重叠写范围；再测互不重叠文件 | 同工作区的活动写范围冲突明确拒绝或等待；合法分工仍能并行；取消不能让晚到写入越过新任务所有权 |
| 零模型费用：投影 | 固定请求/观察序列比较现有硬裁剪与有余量策略 | 不越窗口；工具消息完整；目标/约束和来源可恢复；明显减少连续裁剪；仅报告结构性结果，不预测模型质量 |
| 小额付费诊断（另行执行） | 从 A1/D1 错误副本分别恢复，只提供公开回归反馈和同等修复预算 | 判断公开反馈能否促成修复；禁止提供隐藏答案；这属于恢复诊断，不与原完整任务胜率合并 |
| 新版本工程对照 | 固定修正后的环境，先 Solo/开放委派成对重复，主动摘要保持同一设置 | 先验证完整交付；再比较所有 trial 的总成本、成功交付成本、墙钟时间、主/子用量、硬裁剪和缓存率 |
| 后续压缩消融 | 基础链路稳定后才恢复 2×2 矩阵 | 新版本、新预注册、完整样本；小样本只给描述性结果，不宣布稳定胜率 |

不建议立即继续四组付费扩样：当前最有信息增益的工作，是让已经知道的失败能在代理执行阶段被观察并恢复，并消除已定位的确定性计量和裁剪缺陷。

## 10. 本次验证边界

本次只读冻结实验并重算主/子用量、硬裁剪事件、工具 schema 和相邻消息变化；没有使用任何模型 API。外部仓库按固定提交读取，未执行其代码。报告不意味着修复已经实现或能保证后续通过。

已有评测单元测试复核：`node --test scripts/comparison/ky-total-timeout/eval.test.mjs`，8 passed / 0 failed。它验证当前评测行为，包括旧停止规则；不是证明旧规则适合未来实验。

已有定向回归复核：`npx --no-install vitest run tests/design-v3.test.ts tests/provider.test.ts tests/anthropic.test.ts tests/responses.test.ts`，4 files / 81 passed。没有重新运行全量套件；现有用例通过不覆盖上述新发现的全部缺口。
