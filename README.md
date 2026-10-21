# Kodo

Kodo by CodeGo AI · 理解目标，组织协作，执行交付。

当前为 **完整本地内核 demo**，还不是完整产品或公开 Beta。主代理和子代理共用执行循环，支持独立上下文、直接问答、持久等待、集中询问用户、决定变更、会话共享预算、长上下文压缩与原文追溯、取消和有证据的写入恢复。提供非交互 CLI 与原生终端行输入。

完整能力包导入导出、Skills／MCP、目录检索、模型生成的语义摘要和本地 Web 尚未实现。内核已验证 SQLite 中文 trigram 能力，但还没有 Agent 搜索界面。宿主可注册任务完成验收器，CLI 可通过 `--verify-command` 指定验收程序；验收失败时反馈给模型纠正，最多两次。未注册的运行标为 `quality.status=not_checked`，终端同时打印“未被验收”。

## 先运行内核 demo

```powershell
npm ci
npm run demo:kernel
npm run demo:kernel:recovery
```

上述命令使用明确标注的脚本模型，实际执行 SQLite、文件工具、产物和完整协作循环，无需模型服务。第二个演示覆盖长上下文压缩后找回随机原文、不确定外部写入经核实后恢复，以及文件补丁自动核实与终态不变。证据和运行标识保存在打印的数据目录中。真实模型协作模式运行 `npm run demo:kernel:local`，需要先配置下文的模型环境变量；两种模式不会静默相互替代。演示流程和检查点见 [内核 demo](examples/kernel-demo/README.md)。

交互式运行：

```powershell
node 'dist/cli/index.js' chat '请把项目检查拆成两个独立子任务，直接交流证据，最后汇总' --allow-write --max-tokens 200000 --max-model-calls 30
```

直接输入补充资料；`/decision 内容` 修改约束；`/next 任务` 排队后续运行；`/status` 查看持久快照；`/cancel` 取消当前任务；`/quit` 取消未完成任务并退出。多行粘贴用 `/paste` 开始、`/send` 提交。终端沿用原生输入编辑，不依赖全屏 TUI；Windows 中文输入法仍需在用户实际终端中验收。

## 开发运行

要求 Node.js 24、npm。当前首要验证平台为 Windows／PowerShell。

```powershell
npm ci
npm run check
npm test
node 'dist/cli/index.js' --version
node 'dist/cli/index.js' doctor
```

`npm test` 先构建，再执行包括构建后 CLI 在内的所有本地测试，不调用收费模型。`npm run dev -- --help` 可构建并显示命令。

配置模型时只在本机设置环境变量，不把真实密钥写进仓库：

```powershell
$env:KODO_MODEL = 'glm-5.3'
$env:KODO_BASE_URL = 'https://codegoai.com/v1'
$env:KODO_PROTOCOL = 'responses'
# 在本机安全配置 KODO_API_KEY 或 OPENAI_API_KEY。
node 'dist/cli/index.js' run '阅读 README.md，列出已实现能力与限制' --json
```

本机无认证的服务也需要给 SDK 一个非空占位值，例如 `KODO_API_KEY=local-not-required`；它不是真实密钥，也不表示服务具备认证。远程接口要求 HTTPS，不接受 URL 中的用户名、密码或查询参数。不同供应商／模型需各自通过工具循环测试，不能仅凭接口兼容就视为可用。

支持三种模型协议，可通过 `KODO_PROTOCOL` 或创建运行时的 `--protocol` 选择：

| 配置值 | 请求端点（相对于 `KODO_BASE_URL`） | 认证 |
| --- | --- | --- |
| `chat-completions`（默认） | `/chat/completions` | Bearer |
| `responses` | `/responses` | Bearer |
| `anthropic` | `/messages` | `x-api-key`、`anthropic-version: 2023-06-01` |

协议随运行与子任务持久保存，恢复时沿用原绑定；不自动切换协议或回退到本机模型。三种协议均使用流式响应，支持文本、函数工具调用和结果回传；Responses 保留原有输出项与加密推理，Anthropic 保留签名思考块，供后续调用按原顺序回传。多模态输入、供应商原生服务端工具暂不支持。2026-10-20 已停止本机模型，使用 CodeGo 的 `glm-5.3` 完成三种协议真实验证；详见[远程 API 验证](docs/remote-api-verification.md)。

运行默认只读。生成报告产物或修改项目需显式加 `--allow-write`：

```powershell
node 'dist/cli/index.js' run '阅读 README.md，使用 artifact.write 保存能力清单和未验证项' --allow-write --json
node 'dist/cli/index.js' run '整理验收记录' --card 'examples/reporter/AGENT.md' --allow-write --json
```

`--workspace` 指定工作目录，默认为当前目录；`--data-dir` 或 `KODO_DATA_DIR` 指定运行数据目录。Windows 默认使用 `%LOCALAPPDATA%\kodo`。不要把私有运行数据目录作为可分发资源。

## 工具与边界

| 工具 | 行为 |
| --- | --- |
| `file.read`／`file.list`／`file.search` | 相对工作目录读取 UTF-8 文本、列目录和有限字面搜索 |
| `file.apply_patch` | 使用预期 SHA-256 创建或原子替换一个文件；修改前验证旧内容，父目录必须存在 |
| `artifact.write`／`artifact.read` | 写入与读取本会话的私有报告产物；不同会话不能互读 |
| `history.read` | 分页读取本运行或主代理管理的子运行的已登记上下文归档；长消息可按字符继续读取 |
| `process.run` | 仅运行宿主通过库 API `readOnlyCommands` 声明的完整程序及参数；参数必须逐项匹配，只读超时不会建立写入屏障 |
| `process.exec` | 仅在 `--allow-exec` 下启动程序及参数数组，保留退出码、输出和取消信息 |

`file.read` 默认返回 200 行以内、8000 字符以内，使用返回的 `next` 继续读取，超长单行通过 `contentOffset` 无损续读；完整文件 SHA-256 不随分页改变，文本文件上限 16 MiB。`artifact.read` 同样支持内容分页。`process.exec` 每路输出预览 4000 字符，超出部分保存到 `outputArtifact` 指向的私有产物，可用 `artifact.read` 分页读回并解析 JSON；总捕获硬限 2 MiB，超限明确标记不完整。明确未启动的进程返回 `PROCESS_START`，启动后结果未知的写操作仍须核实。

工具参数、卡片允许列表与实际授权在执行入口校验。文件路径检查包括实际目标和链接；`.git`、`.env`、常见私钥及运行时数据受保护。写操作在同一运行时中串行。文件检查不等于恶意代码沙箱，也不能防止外部程序同时修改文件。

协作工具由宿主按角色提供：主代理可用 `spawn_agent`、`cancel_agent`、`ask_user`；主／子代理均可用 `list_agents`、`inspect_run`、`send_message`、`wait_for_events`。创建子任务时省略 `card_id` 和 `card_version` 即继承当前卡片；指定二者只选择已注册的不可变版本，不能通过起名字创建卡片。子任务固定卡片版本与模型绑定，权限只能缩减；任务资料包独立于父对话，工作目录共享。发信身份由运行时注入，答复检查问题与接收者归属。`list_agents` 返回职责、状态、结果是否可读、决定版本和未解决问题，不暴露内部结果引用。

`inspect_run({run_id})` 返回分页结果和可读取的工具调用目录；`inspect_run({run_id,call_id})` 分页读取对应原始工具输出。结果页和调用目录各有 `next` 游标，按返回参数继续读取。主代理可查看受管子任务及经过持久审计的恢复链，子代理只能查看自身运行；同伴须显式共享结果。读取需要当前 `read` 权限，工具证据另受对应 `read`／`write`／`exec` 权限约束。不返回模型请求、私有推理或原始工具参数，不接受任意 blob 引用。长进程输出从归属已核实的捕获产物恢复后分页；受绑定环境变量保护的模型凭据会脱敏。

终态通知只携带最多 1200 字符摘要和运行 ID，唤醒事件只描述条件；详情按需通过 `inspect_run` 读取。`completed` 表示运行结束，`quality: not_checked` 表示未做宿主验收；工具 `succeeded` 表示调用执行结束，进程仍可能 `exitCode: 1`。主代理专属方法指导识别有价值的独立工作、传递资料、推进不冲突的工作及核验证据；小任务保留直接执行能力，不设置强制子代理人数。

等待记录与工具结果持久化后才挂起，挂起前再次检查新输入。收到答复、目标终态、超时或新问题会唤醒；新问题不会把原问题标为已回答。循环等待会生成 `wait.deadlock` 并通知主代理，`any` 条件的可用出口与已满足条件不会误判为死锁。等待不反复调用模型。

`--allow-exec` 是高权限可信执行，程序可访问宿主用户资源；应用层文件范围不能约束它。子进程环境移除模型凭据引用及常见密钥／令牌变量，但这不等于隔离宿主。首版没有任意 shell 字符串工具。

模型工具名称在协议上使用下划线（如 `file_read`），运行记录使用逻辑名称（`file.read`）。工具参数只有在整份响应正常结束后才可能执行；响应截断或断流不会执行其中的请求。工具结果与原始调用 ID 一起保存。

## 预算、状态与取消

支持 `--max-tokens`、`--max-model-calls`、`--max-tool-calls`、`--max-output-tokens`、`--max-context-chars`、`--timeout-ms`、`--tool-timeout-ms`、`--max-children` 和 `--max-concurrent-models`。主／子任务与后续运行共享会话消耗。执行时间按至少一个任务正在推进的会话墙钟累计，全部挂起等待时暂停；活动起点 `activeSince` 先持久化。若执行时进程崩溃，重开时保守累计到重开时刻，包含无法确认的停机时段、最多记到预算上限，不通过重启清洗消耗。模型请求数和 token 为主代理保留一次回复余量，排队时主代理优先。调用前预留 token，得到 usage 后结算；usage 缺失或断流时保留估计，不伪装成精确费用。输入按字符类别加权估算，中文、日文约 1.375 token/字，韩文约 1.65 token/字，另计协议与工具开销；不是精确 tokenizer，不保证供应商侧账单上限。

模型窗口和单次输出上限由宿主声明、端点元数据或模型目录确定；可通过 `--max-context-tokens` / `--max-output-tokens` 收紧。累计 token、模型与工具调用次数、活动时长和字符上限默认不限制，仅执行用户显式配置的限额。CLI 会查询第三方端点的模型元数据；未知型号没有元数据时仍可运行，但明确标为暂定窗口，详见下方模型参数说明。成功响应的 usage 仅在绑定、工具 Schema 和完整历史前缀相同时校准，新增内容使用字符类别估算。

上下文超限时，内核按完整的模型／工具轮次压缩已完成历史，保留宿主规则、初始任务、用户输入与决定、未解决问题；超长工具轮保留调用 ID 与结果摘录。原始上下文作为内容寻址快照保存，发出 `context.compacted` 事件并在当前上下文留下原文引用。`history.read` 仅允许读取已登记且归属允许的快照，通过消息及字符游标分页。压缩为确定性裁减和短摘录，不另调用模型；必要信息或工具 Schema 本身超限时返回 `CONTEXT_LIMIT`，不静默删除约束。

SDK 自动重试关闭，由内核统一记录最多三次尝试，遵循供应商 Retry-After（最多 60 秒）或指数退避，并计入调用和时间预算。三协议区分认证、额度、上下文、请求和临时服务错误，包括 HTTP 200 心跳后裸 JSON 的 CodeGo 网关错误。按本项目约定，HTTP 429 计 0 token 并释放该次预留；其他没有 usage 的失败保留估计，不能算作零费用。相同参数连续三次得到相同失败或不变证据时反馈模型，第四次不变调用停止运行。按 Ctrl+C 停止新调用并尽力中断本次拥有的进程树；已发生的文件或远程副作用不会自动撤销。

`--prompt-cache session` 或 `KODO_PROMPT_CACHE=session` 显式启用会话缓存提示，默认 `off`。OpenAI 两协议使用 `prompt_cache_key`，Anthropic 使用稳定 system 块的 `cache_control`。必须由供应商支持这些参数；开启不保证命中率提高。usage 分开保存 `cacheRead/cacheWrite`，`input` 已包含缓存部分，不重复累加。缓存、完成验收接口和边界详见[执行补强说明](docs/kernel-hardening.md)。

JSON 模式 stdout 输出同会话的 JSONL：持久事件带递增 `seq`，文本增量带 `transient: true`，只供显示。最终回复和调用结果引用可从持久事件和快照读取；stderr 用于命令错误。退出码：成功 `0`，失败／中断 `1`，需输入 `2`，用户取消 `130`。非交互 `ask_user` 保存问题后退出，不永久占用终端。

普通补充在模型／工具边界读取；`--decision` 创建会话决定版本并通知任务。旧响应中尚未启动的动作返回 `DECISION_CHANGED`，旧版本完成结果在快照中标记 `stale`，保留原始证据供复核。应用 API 的 `updatePermissions` 可撤权并中断在途工具，不允许动态提升授权。终态输入创建 `continuationOf` 后续运行，原运行不重新打开。

产物读取附带来源运行、创建时的决定版本和当前 `stale` 状态，不能用新的任务版本掩盖旧产物。SQLite 数据库自动迁移旧版结构，保留已有运行、产物和预算。

## 检查与恢复

```powershell
node 'dist/cli/index.js' runs --json
node 'dist/cli/index.js' gc --vacuum
# 可选删除最后活动时间超过 30 天的终态会话；未解决写入和活动会话保留。
node 'dist/cli/index.js' gc --older-than-days 30 --vacuum
node 'dist/cli/index.js' inspect '<run-id>' --json
node 'dist/cli/index.js' resume '<run-id>' --json
node 'dist/cli/index.js' reconcile '<run-id>' --json
node 'dist/cli/index.js' resolve '<run-id>' --call-id '<call-id>' --outcome succeeded --evidence '已独立检查目标文件或系统，确认这次操作成功且只执行了一次。' --json
node 'dist/cli/index.js' continue '<waiting-run-id>' --json
node 'dist/cli/index.js' answer '<question-id>' --text '用户回答' --json
node 'dist/cli/index.js' input '<run-id>' --text '更新约束' --decision --json
node 'dist/cli/index.js' input '<run-id>' --text '下一项任务' --follow-up --json
```

同一数据目录只允许一个进程拥有。进程崩溃后遗留锁文件，不会按文件年龄擅自接管。确认原进程退出后执行：

```powershell
node 'dist/cli/index.js' doctor --unlock
```

`doctor --unlock` 会检查锁中的 PID；进程仍存在、权限不足或锁损坏时拒绝解锁。启动时将遗留 `running` 运行标为 `interrupted`，再通过 `resume` 显式恢复。

成功的工具结果不会重放；调用登记与副作用开始分别持久化，等锁超时或取消按失败且未开始处理，不产生恢复屏障。崩溃前已登记但未启动的调用可以继续；旧版没有阶段标记的在途写调用继续保守核实。内部协作操作与结果同事务提交，可以安全恢复；外部写操作已开始但结果未落库时标为 `unknown`，恢复返回 `UNKNOWN_WRITE` 并阻止同会话继续执行。同一数据目录中，相同或父子嵌套工作目录的其他会话也不能绕过未知状态继续写入；仍允许其他会话只读调查，以及推进无关项目。`reconcile` 比较文件补丁的实际 SHA-256、预期旧值及预期新值，能确认才记录已完成或未应用；冲突与无法核实的外部进程写入继续阻塞。

`resolve` 记录用户独立核实的具体依据（16 至 16000 字符），结果可为 `succeeded`、`failed` 或 `not_applied`。只有明确核实为未执行时，才允许附带 `--retry` 显式授权受控重试；没有强制重放开关。核实输出包含原调用记录、证据和恢复计划，冲突的核实结论拒绝覆盖。核实后执行 `resume`：中断运行继续其已保存步骤；已失败的 `UNKNOWN_WRITE` 运行创建恢复延续任务，沿用已确认的调用结果与会话预算，原失败运行及其调用记录不变。重复恢复同一来源不会再次复制执行。恢复主任务时先检查同会话中断与不确定写入，不让其他任务绕过阻塞。自动补偿尚未实现。

## 验证与分发

```powershell
npm run check
npm test
npm run test:integration
npm run test:e2e
npm run test:provider
npm run test:protocols
npm run eval:tasks
npm pack --dry-run
npm pack
```

`test:provider` 要求真实 `KODO_MODEL` 和凭据环境配置，验证文件读取、产物写入／读取及最终证据；缺配置时返回非零并标明未验证。普通测试使用本地 HTTP 协议服务和临时目录，覆盖参数／权限错误、重复唤醒、共享预算、断流、取消、事务回滚、路径链接边界，以及写完文件后强制杀进程再恢复的检查。

`test:protocols` 要求真实 `KODO_MODEL`、`KODO_BASE_URL` 和凭据，逐一验证三种协议的文件读取 → 产物写入 → 产物读回 → 最终回复，并以无效凭据验证拒绝路径。可用 `npm run test:protocols -- --protocol anthropic` 单独验证一种格式；每次保留独立证据目录，不覆盖失败记录。

`eval:tasks` 使用真实模型，在独立项目副本中重复测试仓库报告、预置分页回归修复和双子代理修复；独立验收实际产物，不以模型自述判断成功。默认每类两次，结果写入新的 `.kodo/task-evaluation-*` 目录，任一任务失败返回非零。可用 `-- --case targeted-newline-repair --repeats 2` 单独运行小范围修复诊断；诊断不混入默认成绩。

评估沿用 `KODO_PROTOCOL`，从冻结的源码副本准备各次任务并记录 SHA-256 清单。默认目标窗口为 256000 token，字符上限独立且默认不额外收紧；可用 `--context-tokens` 与 `--context-chars` 分别设置。报告任务使用结构与限定事实验收，并给模型最多两次纠正机会；修复任务另外运行独立行为验收。新条件与历史分数分开记录。远程 API 的真实任务结果与协议连通结果分开记录，见[远程 API 验证](docs/remote-api-verification.md)。

CodeGo `glm-5.3` 的三协议真实验证为 **3/3 通过**；Responses 真实任务的 20000 字符组为 **2/6 通过**，64000 字符组复核后为 **1/3 通过**。后者的原始评分为 0/3，另存更正记录修复 ANSI 颜色码造成的测试输出假阴性。两组适配器版本也不同，不能仅凭这些结果推断上下文大小的因果影响；协作任务尚未可靠交付。

失败原因的源码取证，以及固定版本 Pi Agent core／OpenCode 原生 CLI 的真实任务对照，见[内核失败分析与实测比较](docs/harness-comparison.md)。比较入口为 `node 'scripts/compare-harnesses.mjs'`；需先准备该文档指定的竞品版本与远程模型环境，不使用模拟响应代替真实任务。

最新[内核补强后 256k token 目标窗口比较](docs/harness-comparison-postfix.md)完成 12 次真实任务：独立复核为 Kodo 4/4、Pi core 3/4、OpenCode 4/4；六份分页补丁全部通过追加的 29 项行为验收。报告保留原自动 10/12 与评分误伤更正后的 11/12，列出调用、token、缓存和费用。实际最大输入为 31555 token，未开展填满 256k 窗口的压力测试；[历史 256k 比较](docs/harness-comparison-256k.md)原样保留，HTTP 429 继续按 0 token 计。

2026-10-20 的真实任务评估使用本机 9B、8192 token 服务上下文、20000 字符内核上下文：主评估 **0/6 通过**，另外的小范围定向修复 **2/2 通过**、定向报告 **0/2 通过**。主要问题是大文件结果被压缩后重复探索，以及报告工具调用格式失败。普通回归通过不代表真实任务已能可靠交付，完整条件、原始输出与证据位置见[真实任务能力评估](docs/task-capability-evaluation.md)。

2026-10-19 在 Windows／Node.js 24.13.0 上，使用本机 llama.cpp + **Qwen3.5-9B Q6_K**（8192 上下文、关闭 thinking）通过了真实文件读取、产物写入／读回、最终内容核验，以及输出限制为 1 token 时拒绝截断响应且不执行工具的检查。这只证明该组合的上述案例，不是所有任务或同协议模型的兼容保证。测试服务临时启动，不包含在 Kodo 包中。

2026-10-20 多协议实现后的回归为 **14 个测试文件、210 条测试通过**，包含三个协议的工具循环、推理块回传、断流／截断拒绝、认证失败、CLI 协议绑定与原有内核测试。此前本地内核版本的实际 `.tgz` 在独立目录安装后，安装命令、SQLite 诊断、协作与恢复两项确定性演示均通过；该安装检查不代表本轮新代码已重新打包验收。

后续执行补强的本地回归为 **18 个测试文件、332 条测试通过**，另外 **25 条评估脚本测试通过**；`npm run check` 与两项确定性 demo 均通过。它覆盖工具分页、长日志原文恢复、三协议错误分类与缓存提示、429 预留释放、usage 校准、停滞保护、完成纠错及取消／新决定／多层恢复边界。真实远程复测结果独立记录于[执行补强说明](docs/kernel-hardening.md)，不将本地协议回归等同于模型任务成功。

本轮 CodeGo `glm-5.3` 的 256k token 配置复测中，分页修复和双子代理修复都通过真实测试与独立行为验收。三项任务自动验收为 3/3，但报告独立复核仍发现 1 处实质事实错误，因此计入该复核后为 **2/3**。评估的单次工具期限由 30 秒提高至 60 秒，报告新增实际源码读取要求；旧失败证据保留，不能与旧成绩直接比较。

本轮真实 9B 协作复验在服务设置 `--temp 0` 后通过：4 个运行均完成，使用 16 次模型调用、12 次工具调用和 47644 个实际计量 token。此前默认采样出现过一次随机标识抄错和一次响应截断，验收均明确拒绝并保存证据。这证明已测组合的一条完整链路，不能据此宣称模型普遍稳定。终端输入法及其他操作系统尚未人工验证。

npm 包当前名为 `kodo-local`，`private: true`，用于本机归档安装；命令入口为 `kodo`。尚未向公开仓库发布，npm scope、许可证和发布账号留待公司确认。实际包包含构建产物、源码、回归测试、构建配置、文档、示例与验证评测脚本，不包含 `.kodo` 私有运行记录、凭据和 `node_modules`。文档中的本机历史证据路径只是来源说明，不承诺随包分发。安装后可直接运行 `npm run test:provider` / `npm run test:protocols`；源码构建、回归与任务评测需要先在包目录安装开发依赖。

产品目标、内核基线、技术计划分别见 [设计方案](docs/design.md)、[实现方案](docs/implementation-plan.md) 和 [上线方案](docs/product-launch-plan.md)。

最新[真实仓库协作收益对照](docs/collaboration-benefit.md)比较Solo、指定分工、自主选择各两次。指定分工产生真实并行且代码验收2/2，完整交付三组均1/2；自主两次仍未委派。指定分工减少主代理上下文但增加总费用，尚不能证明总体收益或自主决策错误。报告区分代码与最终交付，保留全部失败、调用、token、缓存及费用。


## 模型参数、可选限额与完成验收

没有任务预算档位。宿主 `binding.limits` 声明优先；原厂端点的已知型号可直接读取打包的 [models.dev 模型目录](https://models.dev)。第三方端点由 CLI 查询 `/models` 和 `/models/{id}`，OpenRouter 优先查询账户的 `/models/user`；读取精确型号的 `context_length`、`max_model_len`、`meta.n_ctx`、输出上限等扩展字段。端点报告的能力优先于同名原厂值，可正确采用中转端更小的窗口。发现总期限为 3 秒，响应上限为 8 MiB，不跟随重定向，不发送生成探测请求。声明两个窗口参数时跳过发现。

标准模型列表通常仅包含型号，并不保证返回上下文能力。元数据缺失时先使用同名原厂目录值；仍未知则使用暂定的 128000 上下文 / 16384 输出，并在终端和 JSONL 中明确提示来源与未核实状态。只返回部分能力时，缺失字段也单独提示。暂定值是客户端兼容默认值，不能证明服务端支持该窗口；遇到不匹配可声明真实参数。不会根据模型自述、型号前缀或训练窗口伪装出精确上限。模型目录随本版本固定；旧会话恢复继续使用持久化参数。

库 API 可用 `await app.createRunWithDiscovery(options, signal)` 自动发现端点能力。原有同步 `app.createRun(options)` 不发网络请求，使用声明、目录或带警告的暂定值。显式声明示例：`binding: { model: 'custom-model', baseURL: 'https://example.com/v1', apiKeyEnv: 'MODEL_API_KEY', limits: { context: 200000, output: 32000 } }`。可选 `limits.input` 表示供应商另外限制的输入长度。模型窗口包含输入和输出；每次输出上限还会按当前输入占用与剩余显式累计 token 限额缩小。压缩默认预留约 15%（大窗口至少 16384 token），不将模型全部输出能力预先扣作固定输入容量。

默认累计 token、调用次数、总活动时长和字符上限均为不限（持久化值为 `null`）。需要成本或时间上限时再传 `--max-tokens`、`--max-model-calls`、`--max-tool-calls`、`--timeout-ms`。内核依然统计全部消耗，保留重试、停滞检测和取消机制；工具期限默认 120 秒，可用 `--tool-timeout-ms` 调整，并不从模型窗口推算。并发与子任务数量属于宿主资源限制，独立于模型窗口。旧会话恢复继续使用原来持久化的限额。

如已指定累计 token 上限，可额外传 `--input-price` 与 `--output-price`（美元 / 百万 token）显示按较高单价计算的费用投影。没有累计 token 上限就没有固定的总费用上限；该值显示为空，绝不把“不限”展示为巨大数字或虚构费用保证。

```powershell
node 'dist/cli/index.js' run '完成修复并验收' --model glm-5.3 --base-url 'https://open.bigmodel.cn/api/paas/v4' --allow-write --allow-exec --verify-command '["node","node_modules/vitest/vitest.mjs","run"]'
# 可选显式累计限额：
node 'dist/cli/index.js' run '有成本上限的任务' --max-tokens 200000 --input-price 2 --output-price 8
```

`--verify-command` 接受完整 JSON 参数数组，直接启动程序，不进行 shell 展开；验收程序由用户选择并信任，可以独立于模型工具权限运行。退出码为 0、输出未超限且未中止才通过。验收的输出证据另存 blob；配置随会话保存，`continue`、`resume`、后续聊天自动重新接入，预算和单工具期限继续适用。它验证的是所选脚本的检查范围，不能证明脚本未检查的性质。

默认交付还要求非空白最终答复；私有推理不算正文。正文与公开验收必须同时通过，失败共允许两次纠正，耗尽后明确失败并保留证据。未配置验收时，正文完整性通过也仍标为质量未验收。显式静默／仅产物任务可用 `--allow-empty-response`，库对应 `finalResponse: 'optional'`；这不会免除已配置的公开检查。公开验收每次针对最新交付状态，受管写入使旧结果失效；破坏性验证可用 `node 'scripts/verify-in-copy.mjs' -- PROGRAM ARGS` 在独立副本执行。实现边界与真实验证见[交付闭环修复](docs/delivery-closure.md)。

内置文件工具保护 `.git`、`.kodo`、`.env*`、`.ssh`、`.aws`、`.npmrc`、`.netrc`、常见私钥名及 `.pem/.key/.p12/.pfx`。`process.exec` 与宿主验收命令属于可信执行，能绕过文件工具的路径保护，并非操作系统沙箱；`process.run` 的完整命令也必须由宿主确认只读。文件 SHA-256 按原始字节计算，`file.read` 保留 UTF-8 BOM，读改写不会因解码而自动丢失 BOM。终端文本过滤控制字符，JSONL 保留原始数据的 JSON 转义。

存储不自动删除历史；`gc` 从数据库引用开始标记并递归保留归档和嵌入 JSON 引用，仅清理无引用 blob。`--older-than-days` 才会删除超过保留期的终态会话，无法核实的写调用保留。启动时在取得独占目录锁后清理 blob 临时文件；`--vacuum` 回收 SQLite 空间。持久事件仅保存消息 ID / 结果引用，JSONL 的完成事件仍展开结果以兼容现有使用者。

本轮审查修复及模型参数调整的本地回归：22 个测试文件、416 条测试通过；评测脚本自身 49 条测试通过。实际安装包在独立临时目录仅安装生产依赖后，版本、诊断、列表及 GC 检查均通过；第三方元数据发现另用本地 HTTP 服务验证。供应商脚本仅验证了无凭据时的明确拒绝路径，未重新调用收费模型。详见 [审查修复记录](docs/review-fixes.md)。
