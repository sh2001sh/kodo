# Kodo 与 Pi、Codex、DeepSeek Harness、OpenCode 的沙箱设计对比

核查日期：2026-10-31。本文是源码与官方资料研究，没有修改运行时代码，没有执行模型实验，也没有实测竞品沙箱吞吐。固定源码版本和本次获取的官方文档不能代表历史实验当时的所有部署配置。

**结论：Kodo 应保留简洁的模型工具视图，把并行能力落实到每个子任务的执行环境。优先修正锁根、缩短快照临界区，然后让子检出的命令获得可强制执行的隔离，再缩小命令锁。** 工具数量、Git 检出隔离、操作系统沙箱、进程回收是四个不同的问题。

## 1. 比较范围与结果

| 项目与版本 | 默认本地执行 | 可选或平台实现 | 子代理与工作区 | 值得借鉴的部分 |
| --- | --- | --- | --- | --- |
| Pi 1.3.0，提交 `73f8de80bc87021375f8b525292ac07492253002` | 默认 bash 工具直接启动宿主 shell | 官方扩展示例接入 `@anthropic-ai/sandbox-runtime`，Linux bubblewrap、macOS sandbox-exec；不能视为核心默认配置 | 核心不内置子代理；示例扩展可启动多个 Pi 进程，默认继承工作目录，没有自动独立检出保证 | 小工具接口和可替换执行后端分离 |
| Codex，本次读取的官方文档 | 默认权限配置约束命令的文件系统和网络访问；审批是另一个控制层 | Linux/WSL 使用 bubblewrap；macOS 使用 Seatbelt；Windows 文档列出 MXC、elevated、unelevated | 托管工作树提供独立文件副本，但共享 Git 元数据；官方工作树资料不能证明每个内部子代理自动独占沙箱 | 明确的执行边界、审批分层、工作区生命周期 |
| DeepSeek Harness `0.2.1-rc.2` | 标准 base-backed CLI 默认 `workspace-write`；SDK minimal 的配置不同，不能混用结论 | Linux bwrap/Landlock，macOS Seatbelt，Windows ACL restricted-token 后端；文件效果策略与进程生命周期独立 | 策略按 session 的工作目录解析；本轮没有证据证明默认子代理自动创建独立检出 | 统一策略来源、托管进程、临时空间和后端能力报告 |
| OpenCode 1.19.3，提交 `e3c4eb242585dcd77be1a867391b7c25fd47ce52` | `SECURITY.md` 明确说明不提供 agent 沙箱，权限提示不等于安全隔离 | 官方建议需要隔离时使用容器或 VM；源码中的 worktree 不等于 OS 沙箱 | `task` 创建子 session 并派生权限，所查路径不自动建 worktree；另有工作树创建、初始化和清理功能 | 会话权限与工作区管理；不能据其默认宿主执行模式推导 Kodo 可以直接删锁 |

### Pi

`BashOperations` 把工具参数和实际执行方式分开。默认 `createLocalShellOperations` 使用 `spawn`，扩展可以替换执行操作，在不新增模型工具的情况下包装沙箱。这比给模型增加“创建沙箱、进入沙箱、申请挂载”等工具更符合 Kodo 的精简方向。

子代理扩展示例限制单次最多 8 个任务、最多 4 个并发，启动进程时使用 `cwd ?? defaultCwd`。这是扩展示例的限制，不是 Pi 核心的默认多代理调度；独立进程也不自动隔离文件写入。

证据：[默认 bash 实现](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/src/core/tools/bash.ts)、[沙箱扩展示例](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/examples/extensions/sandbox/index.ts)、[子代理扩展示例](https://github.com/earendil-works/pi/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/examples/extensions/subagent/index.ts)。

### Codex

官方资料将三层分开：沙箱限制进程能访问什么，审批决定额外访问何时需要确认，工作树解决不同任务文件副本的冲突。命令及其子进程继承沙箱约束，Git 工作树本身不承担这项约束。

当前 Windows 文档推荐兼容设备使用 Microsoft Execution Containers（MXC）原生进程隔离；legacy elevated 使用专用低权限用户、文件权限和防火墙；unelevated 使用受限令牌，网络隔离较弱。不应继续把 Codex Windows 概括成单一 restricted-token 实现。MXC 有系统版本和能力要求，文档还说明前台命令结束会停止剩余子进程，依赖长驻服务的流程需要单独适配。

对 Kodo 可迁移的是分层设计，不是未经兼容性验证直接搬用某个平台后端。本次没有核查 Codex 内部子代理的沙箱创建策略，也没有运行其原生沙箱测试。

已实际获取的官方页面：[沙箱](https://learn.chatgpt.com/docs/sandboxing)、[Windows 沙箱](https://learn.chatgpt.com/docs/windows/windows-sandbox)、[Git 工作树](https://learn.chatgpt.com/docs/environments/git-worktrees)、[审批与安全配置](https://learn.chatgpt.com/docs/agent-approvals-security)。正文缓存位于 [本次研究目录](E:/sh/Coding/agent-harness/.kodo/sandbox-comparison-20261031)。

### DeepSeek Harness

必须区分三种配置事实：标准 CLI 的 base bundle 默认工作区写入；SDK minimal bundle 明确使用全访问；Kodo 的 Frontier 启动脚本也明确把 DSH 配成全访问。不能用这次历史四方实验来评价 DSH 默认沙箱的开销。

其策略服务统一解析 session 模式和工作目录，文件工具、shell 后端使用同一策略来源。沙箱后端主要承诺文件效果约束：不能把它的 `full` 能力标记解释成全面的读取保密、网络及进程隔离。所读 bwrap 配置将系统树只读挂载、工作区可写，提供私有 `/tmp` 和 PID namespace；该配置没有同时声明网络隔离。Windows 后端在源码里明确标记 `partial`。

进程管理另由 `subprocess-local` 负责，登记活动进程和终端、输出落盘、正常关闭时终止并等待收敛。文件权限边界和“子进程真的结束了”各有负责人，这一点适合 Kodo 借鉴。Windows 后端还区分按工作区复用的授权和每 session 的私有临时空间，但其保证与 Kodo LPAC 不相同，不能直接照搬权限实现。

证据：[base 配置](E:/sh/Coding/agent-harness/.kodo/competitor-sources/dsh-metadata/base/package/cordis.patch.yml:240)、[SDK minimal 配置](E:/sh/Coding/agent-harness/.kodo/sandbox-comparison-20261031/dsh/sdk-minimal/package/cordis.patch.yml:70)、[沙箱后端](E:/sh/Coding/agent-harness/.kodo/sandbox-comparison-20261031/dsh/sandbox-local/package/lib/index.js:22)、[策略来源](E:/sh/Coding/agent-harness/.kodo/sandbox-comparison-20261031/dsh/sandbox-policy/package/lib/index.js:108)、[进程管理](E:/sh/Coding/agent-harness/.kodo/sandbox-comparison-20261031/dsh/subprocess-local/package/lib/index.js:1434)。本轮从 npm 下载固定版本发布包，仅解包阅读，未安装或执行；各包目录的 `registry.json` 保存版本及发布来源。

### OpenCode

本地默认 shell 先做工具权限检查，再通过进程服务执行。`task` 子代理派生权限并新建 session，没有在这个路径自动创建工作树。独立的 worktree 模块处理检出、启动脚本和生命周期。代码里名为 sandbox 或 workspace 的对象，不能仅凭名字认定为操作系统隔离。

这套默认模式操作摩擦较低，但承担的隔离契约与 Kodo 不同。不能把“没有 Kodo 这样的家族锁”单独当成更先进的并发保证。

证据：[安全说明](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/SECURITY.md)、[shell](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/tool/shell.ts)、[task](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/tool/task.ts)、[worktree](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/worktree/index.ts)。

## 2. Kodo 的实际瓶颈

**已有检出隔离，但评测中的 shell 没有子任务级隔离。** [启动脚本](E:/sh/Coding/agent-harness/scripts/comparison/frontier/launch.mjs:49)没有给 Kodo 开启沙箱；外层是每个 harness 一个容器，同一个 harness 内的子代理仍共享容器。外层容器不会自动阻止子代理之间修改彼此的检出。

具体有四处：

1. [工具锁根](E:/sh/Coding/agent-harness/src/tools/index.ts:175)：`workspaceWriteLock(childId)` 传空 roots，而 `writeLock` 取 session 主工作区，结果仍锁主目录。宿主提交或版本检查应锁子检出，主工作区快照和集成才锁主目录。应保留共同协调域、改变实际锁根，不能把锁 key 简单换成不同目录而失去冲突协调。
2. [shell 副作用根](E:/sh/Coding/agent-harness/src/tools/index.ts:290)：未隔离 shell/process 的根覆盖主工作区和所有子检出；因此某个子代理的 pytest 会阻塞兄弟代理读写。把 cwd 设到子检出不足以改变这个事实。
3. [快照临界区](E:/sh/Coding/agent-harness/src/runtime/execution-lean.ts:16)：持有主写锁执行整个 `takeExecutionSnapshot`，包括生成提交、clone、fetch、checkout。可以先固定持久快照引用，再释放源文件锁去准备检出；引用回收和 Git 元数据仍需协调。
4. [Windows 写入互斥](E:/sh/Coding/agent-harness/src/sandbox/windows/launcher.cs:133)：同一用户只有一个写入沙箱，同时运行会被拒绝。它配合 ACL、完整性标签恢复和恢复日志，不能只删除互斥。macOS 后端目前禁止派生子进程，也不足以直接承载常规复杂测试。

[现有路径锁](E:/sh/Coding/agent-harness/src/tools/write-locks.ts:191)已经支持同进程内不相交路径并发和共享读；不是必须重写锁系统。跨宿主进程仍采用主工作区锁文件串行，但同一宿主内部复用它，它不是本轮子代理串行的直接根因。

[历史实验](E:/sh/Coding/agent-harness/docs/experiments/kodo-lean-team-statemachine-20261031-r1.md:82)记录全家族写锁约 569 秒、累计等待约 733 秒。累计等待存在重叠，不能承诺因此直接节省 733 秒墙钟。模型已经出现三路并发，主要缺的是准备与测试的并发。

## 3. 推荐的实施顺序

### P0：修正锁归属并缩短快照临界区

先修宿主操作的锁根，并将快照拆成“固定不可变提交与引用”和“创建检出”。共享协调域保持一致；未隔离命令继续持有家族锁，保证它仍与所有相关子检出操作互斥。取不到锁时继续排队，不让模型为等待反复发请求。

同时处理执行方式：[Git helper](E:/sh/Coding/agent-harness/src/runtime/execution-workspace.ts:41)使用 `spawnSync`。仅把 clone/fetch/checkout 移出锁，仍会阻塞宿主事件循环；这些较长的准备操作应改为有取消、超时和退出状态的异步执行，并保留现有环境过滤、恢复和引用生命周期约束。不要一次性重写所有 Git 操作。

这一阶段不用增加模型工具，也不用重造执行框架。它能减少不必要的主目录等待，但不能单独解除无沙箱测试的家族串行。

### P1：先落地 Linux 子任务隔离，覆盖宿主检查和子代理命令

复用已有 bubblewrap 后端，以一个子任务检出为执行单位：

- 子任务保有自己的检出、临时目录和测试输出；依赖尽量只读复用，需要写入的缓存使用任务专属位置。
- 文件可写根由可信宿主配置，执行层实际落实；锁使用落实后的物理可写根。修改交付范围仍按任务声明验证，两者不能混成一个随意放宽的 scope。
- 先接入已有结构化 `host.task.check`，再覆盖子代理 bash/process；只隔离宿主检查，模型自己启动的 pytest 仍会锁全家族。
- 每条命令登记进程及后代的生命周期；取消、超时和退出必须完成回收再释放相应锁。后台命令通过已有 job 管理，保存完整输出和实际退出码。
- 保留未知效果的恢复机制；若隔离已得到确认且影响根已知，阻塞范围限于实际受影响的根。隔离启动失败时明确报错，不自动改成未隔离执行。

一份任务检出可以跨多次命令复用，不要求每条命令新建容器或重装依赖。先采用现有每命令沙箱启动方式，只有测出明显启动开销后，才考虑长驻执行环境。

Linux 外层评测容器是否支持嵌套 bwrap 尚未验证。若环境不支持，应选择有受支持隔离配置的 Linux worker，或由宿主容器服务为各任务提供独立执行单元；不要为了跑通而全局放宽容器权限。跨任务的外部服务、端口和数据库测试数据也需要独立命名空间或专门资源锁，文件沙箱不会自动解决这些冲突。

### P2：平台适配与启动成本

Windows 近期以已验证的 Linux 执行环境承接并行测试更实际。原生 Windows 另行评估隔离身份和独立执行目录的方案；Codex 的 MXC 是研究方向，不能假定本机系统支持或可以直接复用。现有 LPAC 的全局写互斥要在权限生命周期得到替代后才可调整。

macOS 需先解决受管理子进程的生命周期，再讨论测试兼容性。不能单靠去掉禁止派生的限制交付。

启动成本要先分段计时。Kodo 当前每次准备会扫描受保护路径，并在 Linux 做启动预检；可研究缓存静态后端能力，但文件权限、工作区变化和有效策略仍需在正确边界重新检查，不能为了提速缓存过期授权。

### P3：控制测试并发和验证重复

模型并发额度与测试资源额度分开考虑。例如三个子代理各跑 `pytest -n 4`，会产生至少十二个测试 worker；解除写锁后可能从锁等待变成 CPU、内存和 I/O 争用。先固定总测试资源预算，实测再调整并发数。

子代理运行专项检查，集成后主代理执行要求的全套验证。成功检查只有在对应代码版本与环境仍匹配时才能复用。集成到主工作区先继续串行，子检出的检查成功不能代替集成后的验证。

## 4. 对模型保持简单

主代理继续使用现有 lean-team 的 9 个工具；沙箱创建、依赖挂载、进程清理和锁调度由宿主处理，不增加模型工具和冗长系统提示。工具返回只给模型需要处理的信息：任务在等资源、检查结果、输出指针、需要处理的错误。

这能改善工具执行与等待，但不会自动减少主代理的前期探索、过细交接或重复推理。提前委派独立任务、遇到需求冲突立即上报、子代理专项测试等优化仍然需要保留。不能把所有性能问题重新归因给沙箱。

## 5. 验证与日志要求

先进行无模型的功能和调度测试，再安排模型实验。并发测试使用正常、受授权的独立任务，不需要漏洞触发或攻击性探测。

- 两个独立检出的正常测试进程存在真实时间重叠；一个任务跑测试时，主目录和另一检出的正常读写能继续。同目录冲突仍按预期排队。
- 取消、普通超时、检查失败、运行中关闭和重启恢复，都保留正确退出状态与版本证据；未收敛的进程不提前释放锁。
- 沙箱后端不可用时明确失败；任务专属临时输出不会混入交付。验证常见测试框架的临时文件、子进程、本地通信需求，不能把“沙箱能启动 true”当成 pytest 兼容性证明。
- 保留原有 relay 请求/SSE、模型可见交互历史、原生工具记录；新增或补齐后端及有效策略、检出标识、物理写根、排队/启动/执行/回收分段计时、测试真实退出码、代码版本与输出文件指针。
- 正常后台命令按进程开始到结束统计，不能只记工具返回后台句柄的时间。统计并行区间和关键路径，不把各任务等待时间简单相加当成墙钟收益。

实验建议分两步：先固定同一组专项命令及资源预算，对照当前串行与隔离并行；再在明确可拆分的项目上比较完整任务。记录墙钟、模型费用、推理量、验证结果和补丁质量，资源配置与失败计量保持一致。是否付费及重复次数另按实验授权执行，本轮未启动。

**本轮产出仅为研究报告和来源缓存。收益是待验证假设；直接可执行的首批改动是 P0 与 Linux P1，不是进一步减少工具或调高代理数量。**

## 后续实施记录：2026-10-31

上面的结论保留为研究时点记录。随后按用户要求实施了宿主实际锁根、快照捕获与异步检出分离、捕获版本持久化、准备期间主代理继续工作、取消/关闭等待准备收敛，以及锁争用的宿主重试间隔。已有 Linux 沙箱路径经真实并发测试确认可以覆盖子代理 shell 与结构化宿主检查；没有新增模型工具或静默开启/降级沙箱。

Frontier runner 现有日志链路保留，并增加显式 `--kodo-sandbox` 选择，写入 manifest 和 trial.json。快照增加 captured、checkout.started/finished/failed 事件，结束和失败事件包含准备耗时。Linux 启用条件及平台限制见 [操作系统沙箱](E:/sh/Coding/agent-harness/docs/os-sandbox.md)。

三轮交错的无模型合成对照（每轮两个独立的 1 秒任务，同一份代码）中，可信宿主模式执行中位耗时 2,073 ms、重叠 0 ms；Linux 沙箱模式中位耗时 1,064 ms、重叠约 1,001 ms。执行段约减少 48.7%，准备时间另列且未计入。这个结果证明隔离后消除了这组任务的家族锁串行，不代表真实项目提速 48.7%，也不是修改前后代码的完整对照。没有模型请求或费用数据。

完整合成输出、运行时事件、脚本和验证日志保存在 [.kodo/sandbox-optimization-20261031](E:/sh/Coding/agent-harness/.kodo/sandbox-optimization-20261031)。Windows 原生写入沙箱仍有单实例限制；没有改动其权限与恢复机制。

验证结果：`npm run check`（tsc 与 ESLint）、`npm run build` 通过；Linux bubblewrap 实测 3 项通过，Frontier runner 测试 11 项通过。宿主锁、调度与恢复回归 4 文件 44 项通过；最后补跑调度、协调器并发、快照与集成 4 文件 32 项通过（两组包含重复用例）。

全量运行原始结果如下。运行期间修正了批量检出仍串行的问题，因此这不是最终代码的一次全量全绿证明：两项失败分别是并发额度为 3 和独立检出准备重叠；它们已在上述最后 32 项回归中通过，未再重跑整个全量集合。另补了旧运行调度失败不影响后续续接的回归测试。

```text
Test Files  2 failed | 199 passed | 1 skipped (202)
     Tests  2 failed | 2307 passed | 12 skipped (2321)

最后专项补跑：
Test Files  4 passed (4)
     Tests  32 passed (32)
```

本轮没有模型调用或真实项目付费对照。Linux 并行实测使用普通 Node 子进程，不等于已验证所有 pytest 插件、本地通信或项目依赖都兼容断网沙箱；具体项目仍需先完成环境预检。无法确认 Git 进程清理结束时，准备阶段继续保留检出锁与任务预留，不以清理超时作为释放依据。

随后按用户要求启动真实项目预检，发现 statemachine 在普通宿主通过全套测试，但断网沙箱阻止了 asyncio 所需的 `socketpair`；项目符号链接也仍阻断快照。正式模型实验未启动，模型请求数为 0。见 [真实项目预检记录](E:/sh/Coding/agent-harness/docs/experiments/kodo-sandbox-statemachine-preflight-20261031.md)。
