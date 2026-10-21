# 已发现执行问题：Pi 与 OpenCode 的源码处理方式

核查日期：2026-10-20。本次对照此前使用的 Pi 源码快照 `73f8de80bc87021375f8b525292ac07492253002` 与 OpenCode 1.19.3 源码 `e3c4eb242585dcd77be1a867391b7c25fd47ce52`。以解决 Kodo 已观察到的执行问题为范围，不新增收费模型测试，不修改生产内核。

后续已依据这些结论实施工具分页、进程错误分类、token 窗口、协议重试、重复检测与宿主完成验收，当前行为见[执行补强说明](kernel-hardening.md)。本文保留调查时的事实口径与源码证据。

**最值得借鉴的是工具输出控制、基于 usage 的上下文管理、可纠正错误回传与分层重试。竞品没有默认解决任务事实验收，也不能保证缓存命中或特定网关故障恢复。**

Pi 必须区分 core、coding-agent 与 provider：此前横向对照仅是官方 core 加 Kodo 的提示、适配器和工具，不能将 Pi 原生分页、摘要和缓存能力算作那轮对照已覆盖。另发现本地 Pi 源码 HEAD 与已安装 npm 1.3.0 的部分重试逻辑不同；静态结论按提交固定，动态检查分别注明源代码或发布包。

## 逐项对照

| Kodo 已发现的问题 | Pi 的做法 | OpenCode 的做法 | 对 Kodo 的判断 |
| --- | --- | --- | --- |
| 程序未启动却触发 UNKNOWN_WRITE | 工具异常变成 isError 工具结果，再交给模型 | 普通工具错误保存为 error，并投影为模型可见错误结果 | 区分未启动、退出失败、启动后结果未知；保留后者的写入审计 |
| 长文件读完即被上下文裁掉 | 原生 read 按行分页，默认 2000 行/50 KiB；超长 shell 输出另存文件 | read 分页，通用工具输出截断并保存全文；shell 保留输出路径 | 先限制进入模型的单次输出，再处理历史压缩 |
| 缺少真正的 token 窗口管理 | coding-agent 用最近有效 usage 加新增内容估算；预留输出并生成摘要 | 用模型 token 窗口、实际 usage 触发摘要，保留近期尾部 | 借鉴 usage 校正、输出预留和近期信息保护；两者也不是精确 tokenizer |
| 相同失败反复执行 | 未发现默认重复工具熔断；有轮次结束钩子 | 三次连续同名同参工具触发 doom_loop 权限询问 | 检测重复不等于自动纠错；不能照抄为硬停止保证 |
| 429、网络、流内服务错误 | coding-agent 外层有界退避，溢出单独摘要后重试 | Retry-After、指数退避与抖动、服务/流错误分类 | 临时失败可重试，认证/额度/参数错误应明确退出；重试统一计预算 |
| 模型正常停止但内容不合格 | finishTurn/扩展边界可继续；默认无事实核验 | 正常 finish 且无待执行工具即可结束 | 运行结束与任务验收应分开；需要任务专用验证 |
| 缓存命中低、费用难解释 | 按供应商能力发送 key/retention/cache_control，拆分 usage | SDK 适配缓存 key/标记，按独立输入/缓存/输出价格统计 | 必须确认 CodeGo 支持；不能保证加参数就提高命中 |
| 429 内部预算仍占用预留 | 未找到 Kodo 式预留/结算/释放账本 | 未找到对应硬预算账本；无 usage 常按零显示 | 竞品的零统计不能直接用作 Kodo 预算正确性的参考 |

## 1. 进程错误：可纠正失败与未知副作用分开

Pi 的 bash 通过 shell 启动；子进程错误向上抛出，core 捕获 execute 异常并生成 `isError:true` 的工具结果，下一轮模型仍能看到失败原因。OpenCode 将普通工具失败记录为 `status:error`，下一轮映射为 `output-error`；未发现等价于 Kodo 的未知写入全会话阻断契约。

这解释了竞品为什么通常能纠正命令后继续，却不能证明它们对不确定副作用具有更强恢复保证。本次没有在竞品完整运行链上复现相同 Windows `EFTYPE`；不据静态路径声称该具体平台问题已全部解决。

Kodo 应修正明确未启动的同步异常分类；**已启动但结果不明的写操作仍应阻断和核实**，不能把所有错误都改成可重试失败。

证据：[Pi 工具异常捕获](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/agent/src/agent-loop.ts#L830)、[Pi 子进程错误](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/src/utils/child-process.ts#L109)、[OpenCode 错误持久化](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/processor.ts#L186)、[模型错误结果转换](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/message-v2.ts#L338)。

## 2. 文件和日志：优先控制工具结果体积

Pi read 公开 `offset/limit`，偏移从第 1 行开始，先按请求选行，再按默认 2000 行/50 KiB 截断；明确返回下一 offset。超长单行返回提示和局部读取方式，而不是把整行塞进模型。它仍先把文本文件读进内存再切行，因此不能称为流式文件 I/O。bash 截断时保留全文文件和尾部预览。

OpenCode read 采用流式读取、按行分页，默认 2000 行/50 KiB；通用工具截断层将超长内容另存文件，给模型预览和定位路径。shell 也将超限完整输出落盘。它有另一个应避开的边界：read 对超过 2000 字符的单行直接截短，行 offset 无法补回同一行尾部，且该情形不一定设置整体 truncated 标记。

分页只是第一层保护：2000 行/50 KiB 也可能超过某个小上下文。Kodo 的单次返回量还应与剩余上下文配合，不能机械复制默认数值。

证据：[Pi read](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/src/core/tools/read.ts#L159)、[Pi shell 全文定位](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/src/core/tools/bash.ts#L333)、[OpenCode read 单行截断](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/tool/read.ts#L162)、[通用截断及落盘](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/tool/truncate.ts#L121)。

## 3. 上下文：实际 usage、增量估算、摘要与近期原文

Pi coding-agent 以最近有效 usage 为锚，对之后新增消息估算；错误、取消或全零 usage 不替换有效锚。默认保留 16384 token 余量和约 20000 token 近期内容。摘要是额外模型请求，结构化记录目标、约束、进展、决定及后续步骤；摘要被截断或失败不应当作完整检查点。core 本身不提供这一整套策略。

OpenCode 用模型 `limit.context/limit.input` 和输出预留计算可用容量，以实际 usage 判断溢出，再用 compaction agent 生成摘要并保留近期尾部；可对更旧的大工具输出做 prune。

**两者都不是精确的发送前 token 计数器。** Pi 新增文本和 OpenCode 的部分上下文估算仍采用约 `字符数/4`。值得借鉴的是实际用量反馈与保护策略，而非宣称换成它们就能准确保证满 256k 容量。模型摘要还会增加调用、费用，并可能丢信息；Kodo 原文归档与追溯应保留。

证据：[Pi 用量锚及估算](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/src/core/compaction/compaction.ts#L126)、[OpenCode token 窗口](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/overflow.ts#L10)、[近期尾部](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/compaction.ts#L223)、[字符估算](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/core/src/util/token.ts#L3)。

## 4. 重试：服务故障、上下文溢出与策略失败分别处理

Pi coding-agent 默认启用最多 3 次重试、基础退避 2 秒；core 遇模型错误则结束，由会话层处理继续。上下文溢出走摘要后一次重试，不进入普通网络重试循环。请求层另有 Retry-After 处理，但默认不自行重试，不能把所有层的次数当成同一个预算。

OpenCode 默认最多 5 次重试，基础 2 秒、指数翻倍、0–25% 抖动；优先采用 `retry-after-ms` 或 `Retry-After`。它将部分 HTTP 200 流内错误、网络断流、5xx 分类为临时错误，溢出另走压缩路径，SDK 隐式重试默认关闭。

这类分类比 Kodo 目前仅识别 rate-limit/transport 更细，但**不能证明它们一定救活本次 CodeGo 的裸 `get_channel_failed`**。Pi 纯函数探测对该名字返回不可重试；OpenCode 也需要载荷被 SDK 正确映射为可识别的服务/流错误。Kodo 应针对实际网关载荷解析、保留脱敏错误类型，再按有限次数重试；不得重放已执行工具或未知写入。

证据：[Pi 会话重试](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/src/core/agent-session.ts#L3739)、[重试分类](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/ai/src/utils/retry.ts#L7)、[OpenCode 退避与分类](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/retry.ts#L26)、[流内服务错误解析](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/provider/error.ts#L102)。

## 5. 重复工具调用与最终验收：没有默认万能纠错

OpenCode 检查当前 assistant 消息最近 3 个 part：同一工具、JSON 参数完全相同、状态非 pending 时触发 `doom_loop` 权限询问。默认 agent 对此 ask；允许规则可直接放行。此前本仓库比较配置为 `permission:'allow'`，因此不能把这条检测当成当时实际阻止循环的保证。不同输入、非连续调用等也可能不触发；它不会自动改换修复策略。

Pi core 有可选 `finishTurn`，正常轮次结束后可追加输入并继续；coding-agent 将它桥接到扩展边界，还提供最终 settle 前的继续钩子。本次范围内未发现默认“重复同一失败测试后换策略”的机制。

两者默认都没有逐条报告事实核验：OpenCode 以正常结束且无待执行工具等条件退出，Pi 默认也可在模型不再请求工具后结束。Kodo 仍需将任务要求转成独立验证，分别记录执行完成和质量合格；接入钩子只是入口，不是验证器本身。

证据：[OpenCode 重复检测](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/processor.ts#L353)、[权限 allow 行为](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/permission/index.ts#L73)、[Pi 轮次边界](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/agent/src/types.ts#L146)、[OpenCode 结束条件](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/prompt.ts#L1111)。

## 6. 缓存与费用：按供应商适配，不能由统计零推定免费

Pi Responses 可按 sessionId 设置缓存 key；Chat Completions 则按端点与兼容能力决定是否发送 key/retention。Anthropic 使用系统、工具和会话位置的 cache_control。OpenCode 也按 SDK/供应商选择 session key 和缓存标记。

两个容易误读的具体边界：

- OpenCode 默认设置 key 的 SDK 列表不含通用 `@ai-sdk/openai-compatible`；本次 CodeGo 比较恰好使用该 SDK，且没有 `setCacheKey:true`。因此**本批较高命中率不能归因于已设置 session key**。
- Pi 对照共用 Kodo 适配器，原生 Pi provider 的缓存设置没有参与那次比较。缓存命中仍依赖网关支持、路由和有效期；不能承诺照搬参数即可提升命中。

OpenCode 将非缓存输入、缓存读写、输出和推理分别归一化并计算价格，避免缓存与推理重复计费。Pi 也单列 usage/cost。两者部分缺 usage 路径默认零，但未发现对应 Kodo 的硬预算预留账本；**显示零不证明上游免费，也不能说明已解决失败预留释放**。

Kodo 应分别保存实际观测用量、未知用量和内部预留。按用户约定，明确 429 在消费统计中为零；其他缺 usage 仍为未知，不能沿用零默认值。缓存参数需先确认网关契约，再做交叉顺序的真实对照。Pi 源码还有额外请求的缓存保温机制，它未参与此前 core 对照，也不宜作为目前第一步优化。

证据：[Pi Chat 缓存条件](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/ai/src/api/openai-completions.ts#L828)、[OpenCode key 条件](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/provider/transform.ts#L1323)、[费用归一化](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/session.ts#L338)、[本仓库对照配置](../scripts/comparison/opencode.mjs)。

## 验证与采用顺序

本次实际运行已安装 Pi 1.3.0 的原生工具/core，使用脚本流代替模型，检查分页、Unicode、续读、超 EOF、缺失文件、超长单行与工具异常反馈。输出：

```json
"tests": 7,
"passed": 7,
"networkAttempts": 0
```

这只验证上述机制，不证明真实模型会正确选择分页或纠错。OpenCode 本次为固定源码及现有测试核查，未重新运行其测试或模型任务。没有新增竞品总体成功率。

另实际执行 Pi 源码与已安装发布包的重试分类纯函数：两者对裸 `get_channel_failed` 都返回 false，普通 429 返回 true，配额不足的 429 返回 false；`upstream_stream_read_error` 则源码为 true、发布包为 false。两者退避均得到 2000/4000/8000/60000 毫秒，断言全部通过。这一差异说明不能用同名版本号替代已测函数身份。

复现已执行的 Pi 工具检查：

```powershell
node '.kodo/competitor-mechanisms-20261020/offline-check.mjs'
node '.kodo/competitor-mechanisms-20261020/pi-retry-probe.mjs'
```

- 离线工具检查脚本（本机证据 `../.kodo/competitor-mechanisms-20261020/offline-check.mjs`，不随源码或安装包分发）与结果（本机证据 `../.kodo/competitor-mechanisms-20261020/offline-results.json`，不随源码或安装包分发）。
- Pi 重试分类源代码/发布包对照（本机证据 `../.kodo/competitor-mechanisms-20261020/pi-retry-results.json`，不随源码或安装包分发）及复现脚本（本机证据 `../.kodo/competitor-mechanisms-20261020/pi-retry-probe.mjs`，不随源码或安装包分发）。
- [已有真实执行失败](harness-comparison.md)、[256k 配置与容量边界](harness-comparison-256k.md)、[产物质量核验](quality-comparison.md)。

采用顺序为：先修未启动错误分类和分页读取/超长输出；接着增加模型窗口、usage 校正与近期信息保护，完善服务错误重试和预算结算；再加入重复失败纠错及任务专用验收；最后在明确网关能力后优化缓存。现有证据支持补齐这些具体机制，不支持通过更换整个 core 自动解决全部问题。
