# Kodo 整体优化设计

日期：2026-10-26。对照五个 harness 的源码，并结合 v2-r6 评审和内核问题评审，给出 Kodo 的整体优化设计。

## 1. 依据与边界

| 参考 | 版本 | 读取范围 |
|---|---|---|
| OpenCode | `anomalyco/opencode@9cc9e58` | system prompt、指令发现与状态、step 快照、文件互斥、shell 结果 |
| Pi | `badlogic/pi-mono@d5b3de2` | system prompt 分节、resource-loader、文件变更队列、bash |
| Codex | `openai/codex@342ed69` | agents_md、world_state、environment_context、parallel、exec、turn_aborted、interrupt_agent |
| DeepSeek harness | `deepseek-ai/deepseek-harness@22ddee3` | agent-instructions 包，以及超时、取消、持久化、锁接管、system-reminder 等设计笔记 |
| Claude Code | 本地 `E:\sh\Coding\claude-code-main`（2026-03-31 泄露的源码） | context、claudemd、attachments、Tool、工具编排、compact、fileHistory、sessionStorage、BashTool、hooks、fork 子 agent |

- 源码快照保存在 `.kodo/research/context-composition-20261026/`。DeepSeek 部分主要依据它的设计笔记。
- Claude Code 是泄露的专有代码，只借鉴设计思路，不复制代码。
- 本文不涉及代码体积问题（用户已明确不处理）。

## 2. Kodo 已有的优势（保持不变）

下面这些能力，参考对象大多没有，或只有一部分：

- **持久化状态机**：run、call、wait、mailbox 都存在 SQLite 里，每次调用的状态与计量在同一个事务中提交。中断后可以恢复，结果可以审计。
- **结算三态**：调用用量分为已测量、确认为零、未知（保留预留额度）三种状态，未知写操作禁止直接重放。
- **原生文件写的对账**：`file.patch`、`mkdir`、`rename`、`delete` 四种操作有执行前准备、执行后完成两张收据，崩溃后可以核实结果。
- **权限只收窄、不放大**：卡片、文件内容和同伴消息都不能授予权限；子 agent 的写范围不能与兄弟 agent 重叠。
- **交付物与完成判定**：宿主声明交付物，由内核检查文件实际状态，而不是采信模型的自述。
- **压缩体系**：按比例触发、生成摘要、硬裁剪留出余量，并支持 `history.read` 回溯原文。

## 3. 待修复的问题

| # | 问题 | 依据 | 影响 |
|---|---|---|---|
| 1 | `process.exec` 超时或中止一律记为 `UNKNOWN_WRITE`，整个会话被冻结 | `tool-step.ts` execute；A1/D1 恢复诊断 | 一次超时就要人工处理 |
| 2 | `cancel_agent` 走 `cancel()` → `suspendPeers()`，除来源外所有非终态 run 都被中断，包括父 agent | `coordinator.ts:248-264`、`386-396`；`messaging/index.ts:116-121`（按代码推断，未复现） | 取消一个子 agent 会连带停掉父 agent |
| 3 | Windows 沙箱拦截管道，测试反馈拿不到 | `sandbox/windows/node-compat.cjs:56` | Windows 上 `test.run` 不可用 |
| 4 | 写锁覆盖整个工作区，且只在单进程内有效 | `tools/index.ts:80+` | 并行写互相阻塞；多进程同时写不受保护 |
| 5 | 每次模型调用都把整段上下文存一个新 blob，体积按平方增长 | A1：42 次调用产生 276 个 blob，共 19 MB | 磁盘和 fsync 开销持续变大 |
| 6 | `events(runId)` 全表扫描，`outputLimitRetry` 等每步都扫一遍 | `storage/index.ts`、`model-step.ts` | 长 run 下每步耗时按平方增长 |
| 7 | `kernelState` 列出全部失败调用，每步都扫 glob；只在特定配置下才注入 | `model-step.ts:25-76` | 内容无上限，有时又完全缺失 |
| 8 | 行为提醒用 `user` 角色发送，模型分不清这是用户还是内核 | `tool-step.ts:345-369` | 模型把内核提醒当成用户新指令 |
| 9 | 非 `KodoError` 的异常一律变成 interrupted 并中断所有同伴 | `coordinator.ts:496-506` | 一个工具 bug 冻结整个会话 |
| 10 | 多个模块绕过 Store 直接操作 `store.db` | agents/discovery、cases/store、knowledge、tools/native-recovery、tools/todo、web/*、`model-step.ts:36` | 事务边界和 schema 演进失控 |
| 11 | Anthropic 适配器把所有 system 消息拼成一个顶层 system，中途的 system 消息改变前缀 | `providers/anthropic.ts:35` | 每次插入运行时信息都使 prompt cache 失效 |
| 12 | 没有项目指令层（AGENTS.md） | `context.ts:316-323` | 项目约定只能写进卡片或目标 |

## 4. 参考对象的做法与取舍

| 主题 | 参考做法 | 不足 | Kodo 取舍 |
|---|---|---|---|
| 项目指令 | Codex：git 根到 cwd 逐级拼 AGENTS.md，32 KiB 上限；OpenCode：向上查找 AGENTS.md/CLAUDE.md，并在读文件时补发子目录指令；Claude Code：Managed/User/Project/Local 四层，`.claude/rules/*.md` 带 `paths:` 条件，`@include` 深度 5 | Codex 不感知子目录；Claude Code 层级多、调试难；都把指令当可信文本 | 三层（全局、工作区、写范围子目录）+ 触达触发；指令只能收窄不能授权 |
| 前缀稳定性 | Claude Code 用 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 分静态/动态；Codex 把环境放在 user 消息里，变化时发增量 | 动态段仍在 system 内，部分模型会整段失效 | 静态内容放 system，所有会变的内容放 user 消息，只追加不改写 |
| 运行时提示 | Claude Code `<system-reminder>` 附件；DeepSeek 对不支持中途 system 的模型降级为 user | 附件来源分散，顺序靠约定 | 一个附件注册表，`<kodo-runtime kind>` 标记，内核规则声明其含义 |
| 超时与取消 | Codex：杀进程组，区分 ABORTED 与 ABORTED_BEFORE_DISPATCH；OpenCode：每步 git 快照；Claude Code：15 秒自动转后台 | 都不核实超时后文件是否改动；git 快照对大仓库成本高 | 执行前后写范围清单对账，只有无法证明时才 unknown |
| 并发与锁 | Claude Code：按输入判定并发安全，连续只读调用成批（上限 10）；Pi：按文件路径的变更队列；Codex：全局 RwLock | Codex 粒度太粗；Pi 只管文件工具不管 shell | 路径前缀读写锁 + 跨进程锁 |
| 失败隔离 | Claude Code：Bash 出错时中止同批兄弟调用，生成合成错误结果 | 无持久化，崩溃即丢 | 三级异常，持久化结果 |
| 文件安全 | Claude Code：读取时记录 mtime，写前校验；每条消息保存文件快照（上限 100）可回退 | 快照只在内存/本地，不参与崩溃对账 | 复用为对账依据和 rewind |
| 压缩 | Claude Code：13k 缓冲、20k 预警、3 次失败熔断、microcompact 清旧工具结果、压缩后恢复最近 5 个文件、prompt-too-long 触发被动压缩 | 规则硬编码，常数绑定窗口；失败计数不代表历史不可用 | 只用比例几何与硬容量一套预算；恢复只用剩余预算；按能否安全继续决定停止 |
| 持久化 | Claude Code：JSONL + parentUuid 链；DeepSeek：只用 JSONL 并批量写，pid 探测接管锁 | JSONL 难做事务和结算 | 保留 SQLite，改为消息级追加 + 清单投影 |
| 子 agent | Claude Code：fork 模式继承父上下文共享缓存，`<task-notification>` 异步通知；Codex：interrupt 只中止当前轮次 | fork 继承全部权限；缓存收益依赖卡片和工具一致，并非必然 | 逐层界定可共享前缀并实测命中，权限只收窄 |
| 扩展 | Claude Code：PreToolUse/PostToolUse/Stop/SubagentStop/PreCompact 等十余种 hook | hook 可改写权限，面太宽 | 宿主事件订阅，hook 只能拒绝或补充，不能授权 |

## 5. 上下文组成

### 5.1 目标分层

按从稳定到易变的顺序排列，前缀越稳定，缓存命中越高。

| 层 | 角色 | 内容 | 变化频率 |
|---|---|---|---|
| L1 | system | 内核规则、工具使用说明、`<kodo-runtime>` 与 `<kodo-context>` 的含义声明 | 版本级 |
| L2 | system | 卡片方法（agent 的工作方式） | 卡片级 |
| L3 | user | `<kodo-context kind="project-instructions">`：项目指令链 | 会话级，变化时发增量 |
| L4 | user | `<kodo-context kind="environment">`：工作区、平台、沙箱、写范围、已定决策 | 会话级，变化时发增量 |
| L5 | user | 目标（objective） | run 级 |
| L6 | 历史 | 模型输出、工具结果、`<kodo-runtime>` 附件、增量 | 每步追加 |
| L7 | user | `<kodo-runtime kind="state">` 状态帧，始终放最后 | 每步重建，不入历史 |

- L1–L5 一经生成即冻结，只有压缩时才重建。环境或指令变化时，在 L6 追加增量，不回改前缀。
- L7 每次请求重新生成，不写入历史；缓存可复用到共同前缀结束处，旧请求 L7 与下一请求新增历史之后的部分不保证复用，实际收益以 provider 缓存计量为准。
- 所有 provider 适配器保持 system 消息只出现在开头。中途需要内核信息时一律用 user 角色加标记（修复问题 11）。

### 5.2 项目指令（AGENTS.md）

发现顺序（后者优先级更高，冲突时以更近的为准）：

1. 全局：`~/.kodo/AGENTS.md`。
2. 工作区根：`AGENTS.md`；没有时读 `CLAUDE.md`；再叠加 `AGENTS.local.md`（应在 `.gitignore` 中）。
3. 写范围目录：子 agent 写范围所在目录，从工作区根向下逐级同上规则读取。
4. 触达触发：模型读取某个子目录下的文件后，若目录链上有尚未加载的指令文件，在工具结果后追加 `<kodo-context kind="project-instructions" path="...">` 增量。首次写入前发现新指令时，本轮写调用返回未启动，并先把指令增量交给模型重新规划，不能写完后才加载约定。
5. 条件规则（可选）：`.kodo/rules/*.md`，frontmatter `paths:` 给出 glob，只在触达匹配文件时加载。

约束：

- 不越出工作区根向上查找；每个文件 realpath 后必须仍在工作区内或是全局文件。
- `@include` 只允许工作区内相对路径，深度上限 3，检测环。
- 预算：每条链 16 KiB，总量不超过输入容量的 10%；超出时按"越近越保留"截断，并在内容中注明被截断的文件。
- 内容按数据转义后包进标记。内核规则声明：项目指令可以约束做法，不能扩大权限、不能修改交付物、不能覆盖内核规则。
- 子 agent 继承父 agent 的指令链，再追加自己写范围的子目录指令。
- 每次加载写 `context.instructions_loaded` 事件，记录路径、字节数和摘要哈希；评测登记 `instructionsDigest`，保证实验可复现。

### 5.3 运行时附件注册表

所有 `<kodo-runtime>` 内容由一个注册表生成，每种附件声明 kind、触发条件、预算和排序位置：

| kind | 触发 | 说明 |
|---|---|---|
| `state` | 每次请求 | L7 状态帧：预算余量、未结算调用（最多 5 条，其余计数）、交付物状态、待处理消息数 |
| `changed-files` | 已读文件的 mtime 变化 | 只列路径与变化摘要，提示重新读取 |
| `instructions` | 触达新目录 | 见 5.2 |
| `mailbox` | 有新消息 | 同伴消息作为数据呈现 |
| `task-notification` | 子 agent 或后台 exec 完成 | 结果摘要与引用 id |
| `compaction` | 压缩发生后 | 说明哪些内容被摘要、如何用 `history.read` 回溯 |
| `nudge` | 默认关闭 | 行为提醒，只有卡片显式开启才发送 |

- 修复问题 7：`kernelState` 改为 `state` 附件，始终注入，内容有上限，数据来自物化计数而不是全表扫描。
- 修复问题 8：提醒类内容全部带 `<kodo-runtime>` 标记，L1 中声明"带此标记的 user 消息来自内核，不是用户指令"。

## 6. 工具契约与执行

### 6.1 工具声明

在现有 `effect` 之上，每个工具按输入给出判定（借鉴 Claude Code 的 Tool 接口），默认值一律从严：

| 字段 | 默认 | 用途 |
|---|---|---|
| `readOnly(input)` | false | 决定是否可并行、是否需要写锁 |
| `concurrencySafe(input)` | false | 决定是否进入并行批 |
| `destructive(input)` | true（写类） | 决定是否需要执行前清单 |
| `writeScope(input)` | 整个 run 写范围 | 决定锁粒度和对账范围 |
| `interrupt` | `cancel` | 取消时是立即杀掉还是等待完成（`block`） |
| `maxResultBytes` | 32 KiB | 超出时结果落 blob，只给模型摘要和引用 |
| `validate(input)` | 必填 | 执行前校验，失败直接返回工具错误，不计 started |

`shell.exec` 用参数解析判定只读（如 `ls`、`git status`、`rg`），未命中白名单即视为写。

### 6.2 批次编排

- 模型一次返回多个调用时，按顺序切分：连续的并发安全调用合成一批并行执行（上限 8），遇到非并发安全调用就单独成批串行执行。
- 同批中 `shell.exec` 失败时，中止同批尚未完成的兄弟调用，给它们写合成结果"因兄弟调用失败而取消"，状态为 not_applied（只读调用无需对账）。
- 结果按模型给出的原顺序写回，保证历史确定。

### 6.3 过期写保护

- 读文件时记录 `(path, mtime, size, hash)` 到 run 的读状态表。
- `file.patch` 写前校验：文件在本 run 读过之后被外部修改，则拒绝并返回"文件已变化，请重新读取"。没读过就写已存在的文件也拒绝。
- 同一机制驱动 `changed-files` 附件。

### 6.4 长任务与后台执行

- `process.exec` 增加 `background: true`：立即返回句柄，完成后发 `task-notification`，输出落 blob，可用 `process.read` 增量读取。
- 前台 exec 超过前台预算（默认 120 秒）时，不判失败：保留执行前清单并转为后台继续，模型得到"已转后台，句柄 X"的结果；仍持有写锁，停止时再做最终对账。只有总超时才杀进程（见 7.1）。
- 后台任务计入 run 的预算和写锁，run 结束前必须结算。

### 6.5 延迟工具加载

工具总说明超过输入容量的 5% 时，只在 L1 列出名称和一行描述，模型用 `tool.describe` 取完整 schema。默认不开启，内置工具数量较少时没有必要。

## 7. 不确定性与恢复

### 7.1 exec 超时与中止的对账（修复问题 1）

1. 执行前：对本次调用的写范围做清单（路径、size、mtime、inode），文件数上限 20 000、总耗时上限 2 秒。超限时标记"无清单"。
2. 超时或中止：杀进程树（Windows 用 Job Object，POSIX 用进程组），等待退出，再观察 500 ms 确认写范围内无新变化。
3. 执行后：再做一次清单，与执行前比较。
   - 无变化 → `not_applied`，结果为普通工具错误"超时，未产生文件变化"。
   - 有变化且进程已确认退出 → `applied`，结果带 `timedOut: true` 和变化文件列表，模型可以继续。
   - 进程无法确认退出、无清单、或不在沙箱内 → `unknown`。
4. 写 `tool.reconciled` 事件，记录依据（清单哈希、变化数、退出确认方式）。

效果结算与命令结果分开记录：`applied` 可以是部分效果，不意味着命令成功或任务验收通过。清单只能证明声明范围内可观察的文件效果，不能把工作区静默等同于整个外部进程的效果已确定。

### 7.2 unknown 的影响范围

- unknown 只封锁与其写范围重叠的后续写调用，不冻结整个 run 或会话。
- 被封锁的调用返回"写范围 X 状态未知，需宿主确认"，模型可以去做其他范围的工作。
- 宿主用 `kodo reconcile <callId> --applied|--not-applied` 解除封锁。

### 7.3 收敛式取消（修复问题 2）

- `cancel(runId, origin)` 只作用于目标 run 及其子树，不再调用 `suspendPeers`。
- 步骤：发中止信号 → 有界等待静默（默认 5 秒）→ 对正在运行的写调用按 7.1 对账 → run 置为 cancelled → 给父 agent 发 `task-notification`（含对账结论）。
- `suspendPeers` 只保留给存储级故障（见 7.4）和宿主显式的全局暂停。
- 区分"派发前取消"和"执行中取消"（借鉴 Codex 的 ABORTED_BEFORE_DISPATCH），前者无需对账。

### 7.4 三级异常（修复问题 9）

| 级别 | 例子 | 处理 |
|---|---|---|
| 工具级 | 工具实现抛出非 KodoError | 包装为工具失败结果返回模型；started 的写调用按 7.1 对账 |
| run 级 | 上下文构建失败、provider 适配异常 | 若该 run 无未结算的 started 写调用，仅该 run 置为 failed 并通知父 agent；否则置为 interrupted 等待恢复 |
| 存储级 | SQLite 写失败、磁盘满、owner.lock 丢失 | 停止整个会话，不再写入任何状态 |

### 7.5 文件快照与回退

- 原生文件写在执行前已有准备收据。扩展为保存被覆盖文件的内容（按内容寻址去重），每个 run 保留最近 100 个检查点。
- 用途：崩溃对账时比较内容；宿主执行 `kodo rewind <runId> --to <step>` 回退文件。
- exec 的改动不在快照范围内，只记录 7.1 的清单差异。

## 8. 并发与锁（修复问题 4）

- 进程内：按路径前缀的读写锁。文件工具锁目标文件；写类 exec 锁本次调用的写范围；只读调用拿读锁。两个写范围不重叠即可并行。
- 跨进程：每个工作区（按 realpath）一把锁文件 `.kodo/locks/<hash>.lock`，内容为 pid、进程启动时间和主机名。获取失败时探测持有者：进程不存在或启动时间不符即接管，并写 `lock.takeover` 事件。
- 锁的获取与释放都写事件，便于诊断死锁；等待超过 30 秒返回工具错误，不无限阻塞。

## 9. 压缩

压缩只用一套预算：现有的比例几何（触发线 = 比例 × E，目标 = 0.5E，E = 窗口 − 输出预留）和硬裁剪容量。不再引入固定缓冲、固定恢复额度或失败次数阈值。Claude Code 的 13k/20k/40k/3 次是针对其固定窗口调出的常数，换窗口后不成立，不照搬。

- **压力提示**：压缩后输入仍高于触发线时，`state` 附件带 `context` 字段（当前输入、触发线、硬容量，单位都是估算 token），提示模型收尾当前子任务或用 `update_progress` 记录进度。数值全部来自同一几何。
- **微压缩**：即现有的 mask 阶段。较早的已完成工具结果替换为元数据、短预览和 `history.read` 指针。只改 L6 的 tool 消息，L1–L5 字节不变。
- **压缩后恢复**：摘要安装后，被折叠的工具结果里读写过的文件，如果当前哈希与 run 最后看到的一致，就在 `compaction` 附件里恢复摘录。恢复预算 = 安装目标 − 安装后输入，按估算 token 计；预算为零就只列路径。这样恢复内容不会把刚释放的空间重新占满，也不会让下一轮立刻再触发压缩。恢复清单（路径、token 数、是否完整、预算）写入 `context.summary.installed` 事件。
- **何时停止**：取决于能否安全继续，不按摘要失败计数。摘要失败时退回 mask 投影，原文仍可经 `history.read` 取回，run 继续。只有两种情况停止并写交接报告：强制压缩后请求仍超窗，或者必需输入（规则、任务、用户约束、未答问题、工具 schema）本身装不下。
- **输入超窗与输出截断分开处理**：输入超窗（预估超窗或 provider 返回 prompt-too-long）走强制压缩，每步一次。输出截断不压缩：先原样重试一次，用于偶发超长；再截断就追加一条 `notice`，说明输出上限并要求拆小这一步，用新请求重试一次；还截断则写交接报告停止。两种恢复各用一次，不设次数阈值。

## 10. 子 agent

- **可共享前缀**：L1–L5 含父代理身份、卡片方法、权限环境和目标，不能整体作为子代理的指令。逐层界定：
  - 工具 schema：卡片工具和有效权限相同时才相同。
  - L1 共享规则段（角色文本之前）：所有 run 相同。角色文本、Run ID、权限和范围属于子代理自身。
  - L2 卡片方法：卡片 digest 相同时才相同。专用 Agent 的卡片不同就不共享。
  - L3 项目指令：指令链相同时才相同。写范围子目录指令会增加内容。
  - L4 环境、L5 目标：子代理各自生成，不共享。
  
  provider 按前缀缓存，第一个不同处之后都无法复用。当前 L1 尾部就是 run 身份，所以可复用的部分是工具 schema 加上 L1 共享规则段。
- **先测后改**：子代理首个请求写 `child.prefix_shared` 事件，记录与父代理最近请求逐层是否相同，以及公共前缀字符数。缓存命中以 provider 返回的 `cacheRead` 为准。实测有收益之后，再决定是否把身份移出 L1 来延长公共前缀。"继承父上下文"不等于"共享缓存"，不作此保证。权限仍按现有规则只收窄，写范围不能与兄弟重叠。
- **异步通知**：子 agent 结束、取消或失败时，向父 agent 发 `task-notification`，包含结论、交付物状态、对账结论和完整结果的引用。父 agent 不需要轮询。
- **中断语义**：`interrupt_agent` 只中止子 agent 的当前轮次，子 agent 保留上下文，可以接收新消息后继续；`cancel_agent` 才终止。

## 11. 宿主扩展事件

在现有事件流上开放订阅面，宿主可以同步回调：

| 事件 | 回调能力 |
|---|---|
| `tool.before` | 拒绝调用，或附加一条说明 |
| `tool.after` / `tool.failed` | 附加说明（如格式化、lint 结果） |
| `run.stop` | 拒绝结束并给出理由（例如交付物检查未通过） |
| `subagent.stop` | 同上 |
| `compaction.before` / `.after` | 附加需保留的内容 |
| `session.start` / `.end` | 注入或清理环境 |

- 回调只能拒绝或补充，不能授予权限、修改工具输入或改写交付物。
- 回调有超时（默认 10 秒），超时视为未作答并写事件，不阻塞 run。

## 12. 记忆（可选）

- 会话记忆：压缩时把"已定决策"和"踩过的坑"写进 run 级记忆，在 L4 中呈现，不随压缩丢失。
- 项目记忆：`.kodo/memory/*.md`，由宿主或模型通过 `memory.write` 写入，按 5.2 的规则作为项目指令的一部分加载，同样只能约束不能授权。默认关闭。

## 13. 存储

### 13.1 消息级追加（修复问题 5）

- 每条消息只存一次（内容寻址），上下文改为"消息引用清单 + 覆盖层"：清单记录引用顺序，覆盖层记录微压缩替换和裁剪。
- 每步只追加新消息并写一条清单增量，同一事务提交。
- blob 按大小分流：小于 4 KiB 的直接存 SQLite，大的才写文件；文件写入批量 fsync。
- 迁移：旧 run 的整段 blob 保持只读，新 run 用新格式；读取路径兼容两种。

### 13.2 物化计数（修复问题 6）

- run 表增加计数列：失败调用数、未结算调用数、输出截断次数、压缩次数、最近事件序号。与事件写入在同一事务更新。
- `events(runId)` 增加 `since` 和 `kinds` 参数，配合 `(run_id, seq)` 和 `(run_id, kind)` 索引。

### 13.3 Store 边界（修复问题 10）

- 把各模块的直接 SQL 收进 Store 的命名方法（`knowledge.uses()`、`todo.list()` 等），`store.db` 不再导出。
- eslint 增加规则：`src/storage` 之外禁止访问 `.db`。

## 14. 验证通道（修复问题 3）

- 第一路径：Windows 宿主句柄代理创建双向、重叠 I/O 管道，只向当前 Job 内的进程交付句柄。Node 适配保留原有 `spawn`／`fork` 流与 IPC 编解码；同步调用保留超时和 `maxBuffer`。这是受限的 Node 子进程兼容层，不自动改写任意程序的管道创建，也不开放任意命名管道访问。
- 第二路径：内核 `verify.run` 在宿主明确声明并批准的后端执行固定验证命令。`backend: 'native'` 必须同时配置 `ApplicationOptions.sandbox`；另支持 `wsl` 和 `container`，默认均不启用。结果作为工具结果返回。
- 原生与外部后端的 `verify.run` 都支持 `repeat: n`：多次运行比较结果，结果不一致时标记 flaky 并列出可解析的不稳定测试名称。普通 `process.exec` 不因此隐式增加重复运行。
- 启动 Docker 或 WSL 之前须由宿主确认。
- Windows 构建通过 `node-gyp` 自动生成 `dist/sandbox/windows/node-pipes.node`，需要 MSVC C++、Windows SDK 和 Python，产物随包分发。插件精确绑定构建时 Node／libuv 版本，更换 Node 后重新构建。
- 有界资源：每次 `spawn` 最多 32 对管道，每个沙箱调用最多累计分配 8192 对；同步输入上限 16 MiB，`maxBuffer` 必须是 0–16 MiB 的有限值。超过上限明确拒绝，不静默截断为成功结果。

## 15. 可观测性

- 每次模型调用记录各层 token 数（L1–L7、历史、附件），写进调用的计量记录。
- 记录 provider 返回的缓存读写 token，用于验证前缀稳定性的效果。
- `kodo inspect <runId> --context` 输出分层占比，便于调指令预算和压缩阈值。

## 16. 分阶段实施

每阶段以正常流程、失败路径和边界验收验证改动；`npm run build`、`npm test`、`npm run check` 为项目验证命令。`check` 同时运行 TypeScript 检查和 ESLint，项目没有独立 `lint` 脚本。定向测试通过不等于全量验收通过。

| 阶段 | 内容 | 对应章节 | 验收测试 |
|---|---|---|---|
| P0 正确性 | 收敛式取消、exec 对账、unknown 按范围封锁、三级异常、Anthropic system 位置修复 | 7.1–7.4、5.1 | `cancel_agent` 取消运行中 `process.exec` 的子 agent 后父 agent 继续运行；超时无变化得 `not_applied`；工具抛异常不冻结会话；Anthropic 请求中途 system 不进顶层 |
| P1 上下文 | L1–L7 重排、AGENTS.md 指令层、附件注册表、`state` 帧、`<kodo-runtime>` 声明 | 5 | 指令发现与优先级、越界拒绝、预算截断、增量不改前缀、子 agent 继承 |
| P2 存储与性能 | 消息级追加、物化计数、Store 边界、事件索引 | 13 | 42 次调用的 run blob 体积线性增长；每步事件读取不随 run 长度增长；lint 规则生效 |
| P3 工具与并发 | 工具声明字段、批次编排、兄弟中止、过期写保护、路径读写锁、跨进程锁、后台 exec | 6、8 | 只读调用并行；不重叠写范围并行；外部修改后写被拒；死进程锁被接管 |
| P4 压缩与子 agent | 压力提示、微压缩、压缩后恢复、停止条件、输出截断恢复、前缀共享测量、异步通知、interrupt 语义 | 9、10 | 摘要连续失败后 run 仍以 mask 继续；微压缩只改 L6；恢复不超过安装目标；截断走引导重试而非压缩；`child.prefix_shared` 如实报告逐层差异 |
| P5 扩展 | 宿主事件、文件快照与 rewind、验证通道、可观测性、记忆、延迟工具加载 | 7.5、11、12、14、15 | 回调不能授权；rewind 恢复文件；`repeat` 识别 flaky 测试 |

- P0 依赖写范围声明、锁和效果收据；先完成 P3 中这部分基础，再验收 P0。适配器消息位置修正也会影响模型输入，因此涉及消息格式或行为变化的实验均使用新的实验 id，既有证据只读。
- Windows 管道原型（第 14 节）可与 P0 并行推进，不依赖其他阶段。
- 凭据只经 `--provider-config test_api.json` 传入，不写入任何文件或日志。

## 17. 宿主入口与平台边界（2026-10-27）

本节记录当前接口和可验证边界，不把规划中的阶段自动标为完成。

- CLI 新增 `inspect <runId> --context`、`interrupt <runId>`、`rewind <runId> --to <step>`，以及按调用 ID 的 `reconcile --applied|--not-applied --evidence ...`。确认效果不自动重放调用；旧的按运行 ID 检查和显式重试命令保留。
- 可选项目记忆、延迟工具加载和验证通道分别通过 `--memory`、`--lazy-tools`、`--verification-config` 开启；配置快照随会话保存，恢复保持原配置。原生验证还需 `--sandbox`。完整参数和批准语义见 [CLI 本地宿主配置](cli-host-configuration.md)。
- `verify.run` 已提供原生沙箱、WSL 和容器的固定命令入口，复用重复运行和测试结果比较；只读取配置不启动后端。WSL／Docker 的实际部署可用性仍需在已批准宿主上验收，合成执行器测试不能替代真实后端验收。
- Windows Node 管道／IPC 已接入原生句柄代理和版本绑定插件。本轮已在真实 AppContainer 中验证异步标准输入输出／错误、同步非零退出／超时／输出限额、fork advanced 序列化、默认 Node 测试进程隔离和缺失可执行文件处理；实际 Vitest fork 工作进程的普通算术用例也已通过。原生 `verify.run` 实机用例已完成两次隔离 Node 测试及 TAP 比较。具体范围与定向测试记录见 [原生平台验证](platform-validation.md)，不据此推断所有测试框架或配置均可用。
- 消息引用增量和稀疏覆盖层已减少重复落盘，42 次调用的存储增长由测试覆盖；为兼容现有内容哈希，写入时仍会序列化完整输入，不能把磁盘增长优化表述为每步 CPU 开销恒定。
- 压缩恢复严格服从剩余安装预算：预算为零时，候选路径只记录到审计事件，不再向模型追加路径文本。这是对第 9 节“只列路径”的收紧，避免路径本身突破预算。显式配置的旧 `workInputTokens` 几何仍为历史实验兼容保留，新比例配置使用当前设计几何。
- 各阶段以代码、对应测试及本次最终集成验证输出判定完成；未执行的真实模型缓存实验、跨平台测试和后端验收不得记为通过。

