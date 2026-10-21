# Kodo 真实任务失败分析与 harness 源码对照

后续对进程错误、分页、token 窗口、重试、停滞检测、验收和缓存的逐项源码核查，见[竞品处理机制](competitor-problem-handling.md)。其中注明 Pi core/编码层及源码/发布包的差别。

日期：2026-10-20。对象为当前 Kodo 内核、CodeGo `glm-5.3` 真实任务，以及固定版本的 Pi 和 OpenCode。当前轮次添加比较脚本和证据，不修改 `src/` 中的内核实现。

后续仅使用 256k token 目标窗口的 12 次比较已完成，调用次数、输入／输出／缓存 token、耗时与失败开销见[256k 任务效率比较](harness-comparison-256k.md)。该轮按用户要求将 HTTP 429 记为 0 token；本篇保留旧字符窗口组及预算预留数据供历史取证。

## 结论依据

之前的失败不能统称为“模型能力不足”。有两条从源码到运行记录都能确认的内核失败链：小上下文会删掉刚读取的长文件整轮结果，模型随后反复读取；Windows 下明确未启动的进程被误归类为未知写入，直接阻断任务。另有评分器的 ANSI 假阴性，以及任务没有明示的读取数量门槛。

本轮 14 次真实比较严格验收通过 **8 次**，并非某套竞品全部通过：Kodo 256k、Pi core、OpenCode 都各有一次完整分页修复成功；Kodo 20k 再现重复探索，OpenCode 一次给出错误补丁并超时。另三项受到供应商 HTTP 429 中断，其中 Kodo 两项尚未开始工具执行，不宜归因于内核能力。当前证据支持先修正上下文输入和启动错误分类，尚不支持整体替换内核。

协议连通、内核状态机回归、真实任务交付是不同的承诺。先前三种协议 3/3 通过和普通回归 210 条通过，不能推出复杂真实任务已可靠完成。旧远程 Responses 组的成绩仍为 20k 字符组 2/6、64k 字符组复核后 1/3；原始评分与更正记录均保留，见[远程验证](remote-api-verification.md)。

## 1. 失败机制

### 1.1 刚读到的文件会在下一次模型请求前被裁掉

位置：`src/tools/index.ts:21`、`src/runtime/context.ts:24,103,113`、`src/runtime/coordinator.ts:297`。

`file.read` 只有 `path`，返回整份文件，允许最大 64 KB；它没有行范围或分页参数。上下文按 `JSON.stringify({messages,tools}).length` 计数，是 JavaScript 字符串长度，不是 token 数或 UTF-8 字节数。裁剪按完整 assistant／tool 轮次处理：最新一轮装不下就 `break`，不再尝试较小的旧轮次。归档标记仅摘取最后两组、每组前两条消息的前 120 字符。

旧 20k 分页任务第一次裁剪：

```json
{"originalChars":41317,"compactedChars":8808,"omittedMessages":10}
```

当次 `tests/context.test.ts` 的工具消息 JSON 已有 21256 字符，大于整个 20000 字符限额。下一次请求只剩宿主规则、当前权限、方法、原始任务和归档标记，没有任何 assistant 或 tool 历史。模型刚读到的测试与源码因此不可见。

| 旧 20k 任务 | 裁剪次数 | 裁剪后无 assistant／tool 的请求 | 实际后果 |
| --- | ---: | ---: | --- |
| 分页修复 1 | 7 | 7 | START_HERE 读 8 次、context 测试读 7 次；无补丁、无测试，26 次调用耗尽 |
| 分页修复 2 | 8 | 7 | 补丁通过独立验收；未运行回归，26 次调用耗尽 |
| 协作修复 1 | 19 | 17 | context 测试读 17 次；分页未修复，超时 |
| 协作修复 2 | 10 | 7 | 两处补丁通过独立验收；主代理和一个子代理未完成，超时 |

`history.read` 实际包含在全部请求的工具列表中，不是缺少权限。它可分页恢复已登记的归档，但旧 20k 六次任务中只有报告 2 使用过一次；重新 `file.read` 长文件会再次触发同一裁剪。原文已落盘不等于模型当前拿到了有效工作记忆。

证据根目录：`.kodo/task-evaluation-1792453921029-41e987e4`。分页任务 1 的归档 blob 为 `8a234e9a3843f8c79b7a303c2a8f83a91c3401d4148e98b3e3c2a574674a51c5`，后续模型请求为 `d738e4788877c3c7312ca702200f06a3e2612f931b4d1057f8aa5b5b64dd85e7`，均在该任务的 `state/blobs/` 中。

### 1.2 明确的进程启动失败被升级为 UNKNOWN_WRITE

位置：`src/tools/index.ts:28,208,237`、`src/runtime/coordinator.ts:446,459`。

旧 64k 协作中，模型把 `vitest.mjs` 填进 `program`，没有使用 `node.exe` 并把脚本放进参数列表。任务说明给了正确示例，因此起因包含模型参数错误。但内核也有独立缺陷：只监听 `child.on('error')`，没有捕获 `spawn()` 的同步异常。Windows／当前 Node 组合直接抛出：

```text
{"phase":"synchronous throw","name":"Error","code":"EFTYPE","message":"spawn EFTYPE"}
```

该路径根本没有启动进程，却因所有 `process.exec` 都被标记为写操作、异常不是 `KodoError`，被归类为 `unknown`。工具开始 10 ms 后未知，主代理与另一子代理均被暂停，分页子代理失败；全任务 90.9 秒，没有触及 240 秒超时。

正确边界是将已知未启动的错误反馈为可纠正的 `PROCESS_START`；对于已启动但退出或副作用不明的进程，继续保留未知写入阻断。不能为提高成绩把所有异常一律视为安全失败。

证据：`.kodo/task-evaluation-1792454244058-d4b71326` 的协作事件 seq77、79–82；请求 blob `092be35d0a609aee6b5eecd194f22ddf05dd9c13ca5516667bcdcb2c9b2cebec`，结果 blob `e0cd474413cfbf1a545d0bb8c0821abe0f1942a51ba5637e7c8643523ddb7d9a`。

### 1.3 评分缺陷不能算成模型失败

- 旧 64k 分页修复实际执行了 15 条通过的回归，原正则受 ANSI 颜色码影响。去除终端控制码后，以原输出复核为通过；原 0/3 不覆盖，更正成绩单列为 1/3。
- 旧 64k 报告已经保存，也用 `file.search` 查了源码；它失败于“排除任务说明后，至少 3 份不同的 `file.read`”的自动门槛。旧任务没有明示这个数量，不能解释为没有报告或没有查源码。
- 旧协作评分只需指定测试中的 `some` 一个通过，反而偏宽。本轮要求 `every` 指定测试均有实际执行成功的输出，并提前写明报告的读取与保存要求。
- 本轮 OpenCode 分页修复 1 暴露了另一处输出匹配缺陷：`1 passed | 14 skipped (15)` 也会匹配原先的简单正则。已改为要求整行通过数等于总数，退出码明确为 0；本轮原记录不改，另存复核。该任务的独立验收本来就失败，因此没有把坏补丁误算成整体成功。

## 2. 实际运行的竞品与源码

| 对象 | 固定版本／源码提交 | 本轮真正运行的范围 |
| --- | --- | --- |
| Pi | `@earendil-works/pi-agent-core` 1.3.0；`73f8de80bc87021375f8b525292ac07492253002` | 官方 Agent 循环，接 Kodo 模型适配器、工具与任务；不是完整 Pi coding-agent |
| OpenCode | 原生 Windows CLI 1.19.3；`e3c4eb242585dcd77be1a867391b7c25fd47ce52` | 原生提示、工具、会话循环、上下文策略，通过自定义兼容接口访问同一模型 |

Pi 原 `badlogic/pi-mono` 当前重定向至 `earendil-works/pi`。安装当前官方 `@earendil-works/pi-*` 1.3.0，未使用旧命名包。OpenCode 采用实际发行 tag 的提交，不能用不同的 release `target_commitish` 代替版本身份。

源码、依赖锁、二进制哈希与无模型启动证据保存在 `.kodo/competitor-sources/pi/SOURCE.md` 和 `.kodo/competitor-sources/opencode/info.json`。本轮比较不是依据宣传页、源码片段或模拟响应替代真实模型任务。

| 机制 | Kodo 当前实现 | Pi 源码 | OpenCode 源码 |
| --- | --- | --- | --- |
| 长文件读取 | 整文件，最大 64 KB | 编码层 read 支持 offset／limit，默认 2000 行／50 KB | read 按行分页，支持 offset／limit |
| 历史缩减 | 完整轮次裁剪、短前缀、归档引用 | core 本身不压缩；编码层调用模型形成结构化摘要，默认保留最近 20000 token | 以 token 窗口触发摘要，保留最近原文尾部 |
| 超长工具结果 | 各工具自身限制；file.read 可能大于整个上下文 | 原生 read 返回下一段 offset | 超限完整输出另存文件，返回预览与定位路径 |
| 工具异常 | 写操作遇非类型化异常可能进入未知并停会话 | 循环将执行异常转成错误结果继续；没有 Kodo 的未知写入审计 | 原生工具错误回传模型；未验证与 Kodo 等价的未知副作用恢复契约 |

可复核的官方源码：

- [Pi Agent 循环](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/agent/src/agent-loop.ts)：`executePreparedToolCall` 捕获工具异常并生成错误结果。
- [Pi 编码层压缩](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/src/core/compaction/compaction.ts)：默认值第 128 行、触发第 269 行、结构化摘要模板第 507 行附近。
- [Pi 原生 read](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/src/core/tools/read.ts)：第 16 行起的分页参数与第 190 行起的续读提示。
- [OpenCode 会话循环](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/prompt.ts)：第 1088 行起；工具调用存在时继续推进。
- [OpenCode 窗口判定](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/overflow.ts)、[摘要与尾部](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/compaction.ts)、[输出另存](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/tool/truncate.ts)。

## 3. 比较条件与验收

统一使用 CodeGo `glm-5.3`、Chat Completions 和冻结源码快照，每次新建项目副本、会话与数据目录，不在模型执行中代写补丁或人工提示。单次输出最多 3072 token，最多 26 次实际远程请求、500000 token 预算、240 秒执行时间。请求经过同一个本机计量转发器，记录实际请求 JSON、原始 SSE、usage 与拒绝原因；真实凭据仅在父进程内存中，竞品子进程只收到本机占位凭据。

| 配置 | 上下文与工具边界 | 可支持的推断 |
| --- | --- | --- |
| Kodo 20k | 20000 字符；仅测分页任务 | 与本轮 Kodo 256k 比较，观察上下文限额影响 |
| Kodo 256k | 256000 字符，现有工具与裁剪策略 | 当前 Kodo 在较宽窗口下的真实交付 |
| Pi core 256k | 同一 Kodo 提示、动态权限消息、工具定义、实现、适配器；完整历史达到字符上限后拒绝 | 替换基础循环后的差异；不包含 Pi 编码层的摘要与原生工具 |
| OpenCode 原生 | 自有提示、工具、读取／修改方式；声明 128000 token 模型窗口，外加转发器 256000 字符上限 | 整套 harness 的交付对照，不能把差异全归因于循环算法 |

Kodo／Pi 最多执行 70 次工具调用；OpenCode 的 steps 是软限制，远程请求数由转发器硬限制，原生工具数仅从事件核实，不能声称三者实现了同样的工具硬预算。256000 字符也不等于 128000 token。没有固定随机种子；每任务两次样本不构成稳定成功率或成本排名。

正式组首轮报告的 Kodo／Pi 首请求在规范化工作路径和运行 ID 后，整个 JSON 完全一致，包含四条消息、十二项工具定义和请求参数。后续执行仍有机制差异：Kodo 持久保存调用与恢复状态，网络／限流失败时同一请求最多尝试三次（初次及两次重试），每次计入预算；Pi 对照入口遇模型错误直接失败，工具异常则作为错误结果继续。Pi 不具备 Kodo 的未知写入审计契约，因此“发生工具错误后能继续”不能一概解释为更安全或适合直接替换。Pi 的计量来自 `wire` 和 `outcome.stats`，不能使用没有推进的 Kodo session 计数。

转发记录的 `CLIENT_ABORTED` 可能只是 SDK 收到完整终结帧后正常关闭连接；已有完整模型结果与 usage 时，不计为模型调用失败。

**原生比较的额外限制：**本轮冻结文件列表漏了原仓库已有的 `package-lock.json`，副本靠祖先目录的已安装模块及说明中的绝对 Vitest 路径验证。OpenCode 没有读取说明而自行安装；它的“原仓库缺少锁文件”结论只对测试副本成立。Kodo 卡片要求先读 `START_HERE.md`，OpenCode 只收到共同任务目标与原生提示，这也是整套 harness 的提示差异。文件范围评分忽略 `dist/node_modules`，却计入 demo 生成的 `.kodo` 数据；报告任务也未明示禁止这些验证产物。因此 OpenCode 的严格范围失败须单列，不能据此排名任务推理能力。两份源码修复仍以真实补丁、指定测试和独立行为验收判断。

任务为仓库试用报告与预置 `history.read` 游标回归修复。报告明示至少读三份项目文件且包含源码、保存 Markdown、至少两条限制、区分实际执行与文档声明。修复必须只改允许的源码、运行指定 Vitest 回归成功、完成最终交付，并通过位于候选工作区外的独立行为验收。原始实现正例和预置缺陷反例先运行；验收检查 Unicode JSON 分片无损、游标前进、非法参数拒绝、跨会话读取拒绝，不限定补丁写法。

每任务重复两次，第二轮反转配置顺序。比较不包含竞品多代理协作、崩溃恢复、权限撤销或分发安装，因此不能据此宣称竞品替代了 Kodo 全部契约。

## 4. 实测结果

正式组：`.kodo/harness-comparison-1792457295092-e4a3a9f5`。原始总表为 results-34020.json（本机证据 `../.kodo/harness-comparison-1792457295092-e4a3a9f5/results-34020.json`，不随源码或安装包分发），逐项原始结果、请求、SSE、模型修改后的工作区与独立验收均保留。输出匹配复核另存 assessment-correction.json（本机证据 `../.kodo/harness-comparison-1792457295092-e4a3a9f5/assessment-correction.json`，不随源码或安装包分发），整体通过数仍为 8/14，进程退出码为 1，没有吞掉失败。

| 配置 | 报告任务（两次） | 分页修复（两次） | 解释 |
| --- | --- | --- | --- |
| Kodo 20k | 未测 | 一次调用耗尽；一次 HTTP 429 | 有效执行中复现上下文问题，不能把 429 算作第二次上下文失败 |
| Kodo 256k | 2 次通过 | 1 次通过；1 次 HTTP 429 | 成功案例无需替换循环；第二次还未执行工具 |
| Pi core 256k | 2 次通过 | 1 次通过；1 次基线测试超时后 HTTP 429 | 使用同一 Kodo 工具，未获得 Pi 编码层的分页工具或语义摘要 |
| OpenCode 原生 | 2 次成品通过内容门槛；其中 1 次严格范围失败 | 1 次通过；1 次错误补丁、测试 OOM、最终超时 | 范围失败有测试副本／验证产物政策因素；错误补丁则是独立行为验收确认的真实失败 |

逐次数据如下。token 列是输入／输出累计，含缓存命中输入；带“估”的行包含无 usage 的失败预留，不是精确消费或账单。耗时含原生启动和会话导出、评估收尾，因此 OpenCode 超时行会略超过 240 秒。

| 任务／轮次 | 配置 | 严格结果 | 远程请求 | token | 秒 | 主要证据 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| 报告 1 | Kodo 256k | 通过 | 7 | 70941 | 51.8 | 保存产物、读 5 文件、含源码 |
| 报告 1 | Pi core | 通过 | 7 | 69860 | 54.3 | 保存产物、读 5 文件、含源码 |
| 报告 1 | OpenCode | 范围未通过 | 15 | 330771 | 137.2 | 报告已交付；额外 lockfile 与 231 个 demo 数据文件 |
| 修复 1 | Kodo 20k | 未通过 | 26 | 83771 | 155.6 | 11 次裁剪，无修改／测试，调用耗尽 |
| 修复 1 | Kodo 256k | 通过 | 8 | 65727 | 92.8 | 只改 history.ts；15 条指定回归与独立验收通过 |
| 修复 1 | Pi core | 通过 | 11 | 109694 | 187.2 | 只改 history.ts；纠正命令参数后 15 条回归与独立验收通过 |
| 修复 1 | OpenCode | 未通过 | 8 | 130193 | 243.6 | 错误游标补丁；完整回归两次 OOM，独立验收拒绝，超时 |
| 报告 2 | OpenCode | 通过 | 8 | 131702 | 72.9 | 读 6 文件；实际 check 退出 0，保存报告 |
| 报告 2 | Pi core | 通过 | 7 | 58242 | 71.6 | 读 4 文件；保存报告，未伪称运行测试 |
| 报告 2 | Kodo 256k | 通过 | 7 | 62664 | 95.9 | 读 5 文件；保存报告，未伪称运行测试 |
| 修复 2 | OpenCode | 通过 | 7 | 83307 | 111.3 | 只改 history.ts；15 条指定回归、210 条全回归及独立验收通过 |
| 修复 2 | Pi core | 未交付／HTTP 429 | 7 | 109590（估） | 77.8 | 未写补丁；原缺陷测试达工具时限，被取消；下一请求 429 |
| 修复 2 | Kodo 256k | 无法开展／HTTP 429 | 3 | 34827（估） | 7.4 | 同一首次请求共尝试三次均 429，无工具执行 |
| 修复 2 | Kodo 20k | 无法开展／HTTP 429 | 3 | 34824（估） | 8.0 | 同一首次请求共尝试三次均 429，无工具执行 |

### 成功案例实际证明了什么

三套较宽上下文配置各自至少完成一次修复。独立验收使用随机 Unicode／引号／反斜线数据分片还原，核对游标每步前进，并检查非法参数及跨会话拒绝；既验证正常路径，也验证边界与失败路径。它不依赖模型说“完成”，也不要求补丁必须与原文完全同写法。

Kodo 修复 1 的真实回归与独立验收输出：

```text
Test Files  1 passed (1)
     Tests  15 passed (15)
{"passed":true,"checks":["lossless Unicode JSON pagination","invalid page bound rejected","foreign history denied"]}
```

Kodo 20k 与 256k 首次修复来自同一冻结快照、提示、模型协议与预算，只改变上下文上限：20k 裁剪 11 次、26 次调用后无补丁；256k 没有裁剪、8 次调用完成。与旧两组同时改适配器的观察相比，这条证据更直接支持上下文上限的影响；但只完成一对有效样本，第二对被 429 阻断，不能宣称稳定成功率已经提升到某个百分比，也不能说扩大窗口修复了所有问题。

### OpenCode 失败补丁与评分复核

修复 1 把预置错误：

```ts
if (end < serialized.length) { position = 0; break; }
```

改为 `if (end < serialized.length) break;`，却没有设置 `position = end`，游标仍为旧值。独立验收准确报 `AssertionError: cursor did not advance`。完整 `context.test.ts` 两次执行都因重复读取而内存耗尽，退出 1；增加堆内存未解决逻辑错误。后续筛选测试仅 `1 passed | 14 skipped (15)`，不构成完整回归成功；末尾长消息测试执行中被总体超时终止。全部八次模型请求均 HTTP 200、完整结束、有 usage，没有供应商中断或测错工作目录的证据。

原 `testsRunByAgent=true` 是评估正则的假阳性，复核改为 false；`acceptance=false` 和 `completed=false` 原本就阻止整体通过，故成绩不变。第二次原生任务正常给出正确补丁并跑完指定回归与全套回归，不能隐去首轮失败，也不能仅凭一次成功宣称稳定。

### 报告人工核查

六份报告均保存真实 Markdown，含至少三份实际文件读取、源码、两条以上限制与真实命令。Kodo／Pi 报告卡片没有 exec，正文均明确未执行测试；OpenCode 原生有 bash，报告 2 确实执行 `npm run check` 退出 0。这是工具条件差异，不是 Kodo／Pi 未完成报告。

报告仍有局部错误，自动内容通过不能等同完全准确：

- Kodo 报告 1 的日期写成 21 日，实际为 20 日；报告 2 把归档 marker 的字段写成 `archivedRef`，实际消息 JSON 为 `ref`。多份报告将 `resume` 都概括为创建延续任务，实际只针对可恢复的 `UNKNOWN_WRITE` 失败，中断运行通常继续原运行。
- Pi 报告 1 把旧文件读取的 64 KB／NUL 检查推广到补丁新内容；实际新内容 schema 上限为 64000 字符，没有同样的字节数或 NUL 校验。报告 2 的 `doctor` 注释遗漏解锁需要 `--unlock`。
- OpenCode 报告 1 的“原仓库缺锁文件”来自测试副本遗漏，不是原项目缺陷。两项 demo 有最终 PASS 和持久证据支持；但它的类型检查使用 `... & echo TSC_EXIT=%errorlevel%`，该 shell 写法不能证明 tsc 的独立退出码。报告 2 的 check 使用独立命令，退出码证据充分。

### 供应商拒绝的解释

最后三项的 429 是上游 HTTP 状态；转发器记录为 `UPSTREAM_HTTP_429`，没有本机预算拒绝。没有保留供应商错误正文，无法确定是瞬时限流、额度还是其他策略，不能声称某一种原因已确认。Pi 修复 2 在拒绝前尚未写入补丁，原缺陷测试又被工具时限取消，任务未完成；不能把它改判为通过，也不能假设若没有 429 一定成功。Kodo 两项则尚未开始工作，不是上下文或推理失败样本。

### 本仓库验证

`npm run check` 退出 0；`npm test` 重新执行得到：

```text
Test Files  14 passed (14)
     Tests  210 passed (210)
```

原始输出保存于 harness-comparison-regression.log（本机证据 `../.kodo/harness-comparison-regression.log`，不随源码或安装包分发）。固定快照的 16 份 `src/` 文件与当前文件 SHA-256 全部一致，本轮没有用修改生产内核提高成绩。比较转发器、Pi 工具回放、上下文拒绝、复制锁文件、正例及预置缺陷反例另有无模型验证；这些不计入 14 次真实任务成绩。测试进程均已退出，未发现运行中的 `llama-server` 或 OpenCode。

## 5. 改进优先级

1. **先让输入能留在工作窗口。** 给 `file.read` 增加有界分页和明确续读位置；超长结果保留全文引用，避免默认把一份长文件直接塞满上下文。为“最新结果大于可用窗口”设定明确策略，保留任务进度、已修改文件、已执行测试和下一步；不能只把文件开头当工作摘要。先以本次 20k 案例验收，不能仅把默认窗口改大后宣布解决。
2. **区分已知未启动与副作用未知。** 捕获同步 `spawn()` 失败，返回可纠正的启动错误；保留已启动后状态不明的阻断与人工核实机制。成功验收应同时覆盖 `.mjs` 当程序、程序不存在，以及进程启动后被中断这三种路径。
3. **再决定摘要与循环替换。** Pi 编码层和 OpenCode 的摘要、分页读取值得借鉴；单独替换 Pi core 不会带来这些能力。引入模型摘要时，其调用、失败和 token 成本也必须受预算计量，原文与工具配对仍须可追溯。
4. **固定交付验收。** 提前向模型说明可见要求；所有指定测试都需真实成功，不依赖模型自述；ANSI 控制码先规范化，人工核查报告事实。保留失败结果，不能靠改评分口径或仅选成功轮次制造改善。

比较入口为 `scripts/compare-harnesses.mjs`，Pi 与 OpenCode 适配分别位于 `scripts/comparison/pi-core.mjs`、`scripts/comparison/opencode.mjs`。运行前需按上述固定版本在 `.kodo/competitor-sources/` 安装竞品，并通过环境变量提供 `KODO_MODEL`、`KODO_BASE_URL`、`KODO_API_KEY`；禁止把凭据写进命令、脚本或报告。

```powershell
node 'scripts/compare-harnesses.mjs'
node 'scripts/compare-harnesses.mjs' --profiles 'kodo-256k,pi-256k,opencode' --cases 'pagination-repair' --repeats 2
```

本次较早的比较试运行根目录为 `.kodo/harness-comparison-1792456722780-c6e7c9bf`，因 Pi 遗漏一条动态权限消息、转发器在客户端提前关流时未及时结算 usage 而停止。部分任务虽已通过，但整组不计入正式比较；已产生的文件不删除、不覆盖。修正入口后另开正式组，提前关闭流的计量失败路径有独立离线验证，不计为真实模型任务成绩。

本轮取证后，后续比较入口已补复制 `package-lock.json`，并像 `dist/node_modules` 一样排除验证生成的 `.kodo` 数据；完整回归匹配也拒绝跳过用例和缺失退出码。正式组进程使用启动时已加载的旧复制／评分规则，原始结果与冻结脚本保持不变，本报告不把后续脚本修正追算为模型成绩。后续运行必须新建证据目录，不与本组混算。
