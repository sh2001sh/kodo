# CLI 本地宿主配置

`kodo config`、`kodo agent`、`kodo case`、`kodo package` 在模型执行环境启动之前分发。查看帮助、离线创建 Agent 模板、检查和分发能力包、浏览历史案例不需要模型凭据。`kodo --version` 读取当前安装包的版本，不使用源码中的固定版本字符串。

## 用户级模型配置

用户配置文件为 `~/.kodo/config.json`，Windows 通常为 `C:\Users\用户名\.kodo\config.json`。首次启动交互式 TUI 或运行 `kodo config init` 会创建缺失的目录与配置，不覆盖现有文件。`KODO_HOME` 可指定其他非空绝对目录，文件仍名为 `config.json`；`kodo config path` 显示实际位置。

```sh
kodo config
kodo config init
kodo config path
kodo config list
kodo config add primary --base-url https://api.example.com/v1 --protocol responses --api-key-env PRIMARY_API_KEY --model model-id
kodo config use primary
kodo config remove secondary
```

直接执行 `kodo config` 打开英文终端向导。填写 provider 名称、Base URL、协议、隐藏输入的 API Key 或凭据环境变量名后，向导请求该 provider 的 `GET <Base URL>/models`，显示实际返回的模型供选择，再保存默认模型及默认 provider。已有 Base URL 中的 `/v1` 等路径前缀会保留。这个步骤只读取模型元数据，不发送生成请求；列表失败或为空时明确提示，可重试或手动输入模型 ID。配置完成前取消不会保存部分修改。

非交互环境下，裸命令显示帮助和脱敏配置；`add` 只保存明确提供的字段，不请求网络。更新已有 provider 时，省略的字段保留；首次添加的 provider 自动成为默认。`list`／`show` 和 `--json` 输出都会隐藏已保存的 `apiKey`。文件缺失时视为尚未配置 provider；格式无效或无法读取时会明确报错，不会被静默重置。

```json
{
  "defaultProvider": "primary",
  "providers": {
    "primary": {
      "baseURL": "https://api.example.com/v1",
      "protocol": "responses",
      "apiKeyEnv": "PRIMARY_API_KEY",
      "model": "model-id"
    },
    "secondary": {
      "baseURL": "https://api.other.example/v1",
      "protocol": "chat-completions",
      "apiKey": "YOUR_API_KEY",
      "model": "another-model-id"
    }
  }
}
```

示例密钥为占位符。`providers` 以名称为键，名称允许 1–64 个字母、数字、下划线或连字符，须以字母或数字开头。`baseURL` 必填，远程地址要求 HTTPS，本机回环地址可用 HTTP；不接受 URL 凭据、查询参数或片段。`chat-completions`／`responses` 地址以 `/v1` 结尾，例如 `https://api.openai.com/v1`；`anthropic` 使用不带 `/v1` 的根地址，例如 `https://api.anthropic.com`，运行时自动请求 `/v1/messages` 和 `/v1/models`。旧配置中已含 `/v1` 的 Anthropic 地址继续兼容，不会重复追加。`protocol` 可选 `chat-completions`（默认）、`responses` 或 `anthropic`。`model` 可暂不填写，之后通过向导或 `/model` 选择；非交互模型执行前须配置模型。

每个 provider 使用本地 `apiKey` 或环境变量引用 `apiKeyEnv`，两者不能同时存在。`apiKeyEnv` 对应的值由启动进程环境提供；本地密钥仅通过进程中的环境引用交给模型绑定，运行记录不保存密钥明文。配置文件本身可能含明文密钥，应保留在用户目录，不提交仓库。

provider 选择顺序为显式 `--provider NAME`、`KODO_PROVIDER`、配置中的 `defaultProvider`；仅配置一个连接时自动选择它，连接可以是物理 provider 或 provider 组。命令行的 `--model`、`--base-url`、`--protocol`、`--api-key-env` 可覆盖所选物理 provider 的对应字段。组选中后，各成员地址、协议、凭据独立固定，只允许覆盖模型，不允许覆盖组连接参数。选中 provider 后，模型、地址和协议来自该配置，避免混入旧的全局连接环境变量；未选中 provider 时仍沿用 `KODO_MODEL`、`KODO_BASE_URL`／`OPENAI_BASE_URL`、`KODO_PROTOCOL` 和原有凭据环境变量。新建 `run`／`chat`／`serve`、Agent 作者执行和案例执行共用这一选择规则。

TUI 中输入 `/providers` 选择物理 provider 或组，使用 `/providers merge shared primary secondary` 合并目录；组内来源顺序也是执行时的备用顺序。`/model` 请求所选连接的实际模型列表，`/model all` 浏览所有物理 provider 的目录并显示来源。同名模型在全局目录中按来源区分，组目录会合并同名 ID 并列出实际返回该 ID 的来源；部分来源查询失败时显示警告，不把未查询成功的来源当作已支持该模型。选择模型后保存对应 provider／组的模型及 `defaultProvider`，列表不可用时可用 `/model 精确模型ID` 手动选择。选择只作用于新会话，使用 `/new` 开始；当前任务及恢复的历史任务继续使用其持久化的原模型、连接、协议和凭据引用。`/settings` 显示配置路径及当前连接配置。

用户配置目录与运行数据目录分开：`--data-dir`／`KODO_DATA_DIR` 控制会话、数据库和宿主状态，Windows 默认仍为 `%LOCALAPPDATA%\kodo`。新增 `~/.kodo` 不迁移或清空历史，也不改变仓库内 `.kodo` 评测目录的用途。

## 模型分工与备用连接

`providerGroups`、`modelBindings`、`modelRoles` 均为可选配置。下面为完整结构示例；模型名称和能力说明仅用于演示，实际名称应来自 provider，能力说明应按自己的测试结果填写：

```json
{
  "defaultProvider": "shared",
  "providers": {
    "primary": {
      "baseURL": "https://api.example.com/v1",
      "protocol": "responses",
      "apiKeyEnv": "PRIMARY_API_KEY"
    },
    "secondary": {
      "baseURL": "https://api.other.example/v1",
      "protocol": "responses",
      "apiKeyEnv": "SECONDARY_API_KEY"
    }
  },
  "providerGroups": {
    "shared": { "providers": ["primary", "secondary"], "model": "general-model-id" }
  },
  "modelBindings": {
    "general": { "provider": "shared", "model": "general-model-id", "description": "示例：常规代码修改，需自行验证" },
    "reasoning": { "provider": "primary", "model": "reasoning-model-id", "description": "示例：复杂推理与审查，需自行验证" },
    "fast": { "provider": "secondary", "model": "fast-model-id", "description": "示例：简短检索与整理，需自行验证" }
  },
  "modelRoles": { "standard": "general", "strong": "reasoning", "fast": "fast" }
}
```

组名不得与物理 provider 重名；成员必须是 2–8 个不同的已配置物理 provider，不能嵌套组，且有效协议必须相同。组可有独立默认模型，`defaultProvider` 和模型别名中的 `provider` 均可指向组。`modelBindings` 的键为允许选择的别名，命名范围与 provider 名相同；每项固定连接及精确模型 ID，可附最多 240 字符、无控制字符的 `description`。它声明宿主批准的子代理模型范围，不改变主代理模型，也不授予新的工具权限。

```sh
kodo config merge shared primary secondary --model general-model-id
kodo config use shared
kodo config model add general --provider shared --model general-model-id
kodo config model add reasoning --provider primary --model reasoning-model-id --description "Illustrative: complex reasoning; validate independently"
kodo config model add fast --provider secondary --model fast-model-id
kodo config role standard general
kodo config role strong reasoning
kodo config role fast fast
kodo config role strong inherit
kodo config model remove reasoning
kodo config role standard inherit
kodo config model remove general
kodo config unmerge shared
```

`model add` 省略 `--model` 时使用该连接的默认模型，没有默认时须显式提供。`role ROLE inherit` 清除角色映射；删除别名前须解除其角色引用，删除 provider 或组前须解除组及别名引用，`unmerge` 仅移除组，不删除物理 provider。能力说明来自用户配置或外部评测，系统不把别名 `strong` 或示例说明视为性能证明，也不为每个待办穷举模型评测。

新会话冻结允许的模型绑定、角色映射和说明。新子代理按显式 `model_binding`、卡片 `model.role` 对应默认、继承父代理的顺序选择；显式别名必须在冻结范围内。CLI 也可明确指定：

```sh
kodo spawn SESSION_ID --agent kodo/implementer@1.0.0 --objective "实现约定模块" --model-binding general --slot requirement="实现约定模块" --slot contract=CONTRACT_ARTIFACT_ID --scope '{"write":["src/module"]}' --json
```

`followup_task` 复用以及 `continuation_of` 续接保留原模型和工作上下文，不能借角色默认变化切换绑定；显式请求不同绑定会被拒绝。需要另一模型时应创建新子代理，并明确交接必要背景和证据。

执行循环中的主／子代理模型步骤可在组内按顺序尝试同一精确模型 ID，条件为尚未收到任何内容或用量，并遇到鉴权、缺失凭据、配额、限流、传输错误或 HTTP 404。不会自动升级模型。取消、部分文本、思考、工具内容、已报告用量和输出截断不触发组内换源；所有候选仍受同一会话预算约束，每次物理请求各自登记调用、预留和结算。切换产生 `model.provider_changed` 事件和终端提示，记录来源、目标、模型及原因；没有可靠价格时 `costChange` 为 `unknown`，不推断美元差额。

当前组内换源覆盖有预算记录的执行循环模型步骤；直接 Agent 作者请求及上下文压缩请求仍使用首选连接。配置了组不表示所有 HTTP 请求都会自动尝试备用来源。

## 本地工作台与可信工具

本地工作台通过以下命令启动：

```sh
kodo serve --workspace ./project --data-dir ./private-state --model MODEL --port 0
```

服务只监听 `127.0.0.1`。终端打印实际地址和一次性连接密钥，浏览器中输入密钥后连接。密钥不会放进 URL。`--json` 输出单条 `server.listening` 对象，其中包含 `origin` 和本地连接所需的 `startupSecret`。按 Ctrl+C 或发送 SIGTERM 时，CLI 停止 HTTP、结束 SSE，再中断内核活动并关闭存储。任务中断和未知写入继续使用原有的显式恢复规则。

`run`、`chat` 和 `serve` 支持以下可信配置：

| 选项 | 行为 |
| --- | --- |
| `--shell-program ABSOLUTE_BASH_PATH` | 指定宿主信任的 Bash 绝对路径；调用仍需执行权限，写操作沿用现有授权和沙箱 |
| `--webfetch` | 显式启用网页抓取；默认关闭，不因读取文件权限自动启用 |
| `--web-hosts example.org,docs.example.org` | 限定抓取的精确目标域名，重定向也检查；必须同时指定 `--webfetch` |
| `--lsp-config ./lsp.json` | 读取明确配置的本地语言服务器，不接受模型选择进程命令 |
| `--sandbox --sandbox-resources ./resources.json` | 将原生资源限制交给沙箱；配置不受当前平台支持时直接报错 |

网页抓取继续禁止私网、回环地址和嵌入凭据；`--web-hosts` 只限制抓取工具，不限制任意子进程的网络。原生进程沙箱目前只支持网络全禁或显式放行，不提供会造成错误隔离承诺的域名白名单 CLI。

语言服务器配置示例：

```json
{
  "servers": [
    {
      "id": "typescript",
      "program": "typescript-language-server",
      "args": ["--stdio"],
      "languages": { ".ts": "typescript", ".tsx": "typescriptreact" }
    }
  ],
  "timeoutMs": 10000,
  "maxMessageBytes": 2097152
}
```

CLI 文件允许 `servers`、`timeoutMs` 和 `maxMessageBytes`，沙箱策略和私有存储目录由宿主控制。未启用沙箱时，配置的语言服务器属于可信本地进程；文档路径检查无法替代进程隔离。配置文件不应包含凭据。

资源配置示例：

```json
{ "memoryBytes": 536870912, "maxProcesses": 4 }
```

Windows 限制整个 Job 的内存与进程数量；Linux 的内存限制是单进程虚拟地址空间，进程限制具有真实用户范围的约束。macOS 当前只支持 `maxProcesses: 1`，不支持内存限额；不支持的配置不会降级忽略。

每个 CLI 会话的可信工具配置、完整沙箱资源策略和包版本绑定保存在数据目录的 `cli-host.json` 中。`resume`、`continue`、`input` 和 `answer` 跨进程自动重新附加这些原始设置，不依赖原来的 LSP 配置文件继续存在。显式传入不同设置会报 `CAPABILITY_CHANGED`。本地工作台也只允许以匹配的宿主配置继续已有会话；包驱动的 CLI 会话应继续使用原包命令恢复。

状态文件包含宿主选择的程序位置和本地配置，属于私有状态，不进入能力包分发清单。修改配置后应创建新会话；不能通过重启扩大历史任务的授权。

## 可选运行能力

`run` 和 `chat` 还支持下列显式开关；省略时保持关闭。它们随 CLI 会话保存，恢复执行时重新附加原始配置。

| 选项 | 行为 |
| --- | --- |
| `--memory` | 启用项目记忆文件及记忆工具；项目记忆仍作为方法约束加载，不授予权限 |
| `--lazy-tools` | 工具说明超过输入容量的 5% 时，按需通过 `tool.describe` 加载完整工具定义 |
| `--verification-config ./verification.json` | 固定原生沙箱、WSL 或容器验证命令；模型只能选择重复次数，不能修改后端、程序或参数 |

这些 CLI 选项目前属于 `run`／`chat` 及其恢复路径；`serve` 不读取这三个新选项。编程宿主使用 `ApplicationOptions.memory`、`lazyTools`、`verification`。

验证配置示例（后端需已安装，路径需按本机调整）：

```json
{
  "enabled": true,
  "approved": false,
  "backend": "wsl",
  "program": "C:\\Windows\\System32\\wsl.exe",
  "args": ["--distribution", "Ubuntu", "--cd", "/mnt/e/project", "--exec", "node", "--test", "--test-reporter=tap"],
  "timeoutMs": 120000,
  "repeatLimit": 3,
  "parser": "tap"
}
```

只有宿主将 `enabled` 和 `approved` 都设为 `true`，`verify.run` 才可用；读取配置不会启动 WSL 或 Docker。卡片也必须允许该工具，运行需要执行权限。配置内容复制进私有 `cli-host.json`，恢复不重新读取原文件。修改验证命令需要创建新会话。

原生验证使用 `backend: "native"`，`program` 指向本机可信验证程序的绝对路径，`args` 固定完整参数。CLI 必须同时启用 `--sandbox`；编程宿主必须配置 `ApplicationOptions.sandbox`，否则已启用并批准的原生验证配置会被拒绝。它使用当前运行的文件范围、权限、私有数据目录隔离和资源策略，复用相同的 `repeat` 与报告解析。默认不启用任何验证后端。

`verify.run({"repeat":3})` 比较各次解析到的测试结果，报告不一致的测试名称。`parser` 可选 `tap`、`vitest-json`、`exit-code`；最后一种只能比较进程结果，不能声称定位到了不稳定测试。验证结果作为工具证据返回，`--verify-command` 则仍是结束时的宿主验收器，两者用途不同。

Windows 的 Node 子进程管道由宿主句柄代理创建，只交付给同一 Job 内的进程；Node 保留 `spawn`／`fork` 的流和 IPC 协议，同步调用具有超时与输出上限。每次派生最多申请 32 对管道，每次沙箱调用最多累计分配 8192 对；同步输入不得超过 16 MiB，`maxBuffer` 必须是 0–16 MiB 的有限值。超限明确报错；这个适配层不自动改写任意程序的管道实现。

Windows `npm run build` 自动使用 `node-gyp` 编译插件，需要 MSVC C++、Windows SDK 和 Python。`dist/sandbox/windows/node-pipes.node` 随包分发，但只匹配构建时的精确 Node／libuv 版本，更换 Node 后须重建。实际兼容测试记录见[原生平台验证](platform-validation.md)，不能把普通宿主测试通过当作沙箱内验证通过。

## 检查、暂停、确认与回退

```sh
kodo inspect RUN_ID --context --json
kodo interrupt RUN_ID --json
kodo input RUN_ID --text "继续处理剩余工作" --json
kodo reconcile CALL_ID --applied --evidence "宿主已核对实际文件效果" --json
kodo reconcile CALL_ID --not-applied --evidence "宿主确认调用未产生效果" --json
kodo rewind RUN_ID --to 12 --json
```

`inspect --context` 与原有 `context` 命令使用同一上下文检查接口。`interrupt` 只停止当前轮次并保留上下文，新输入可继续执行；`cancel` 才终止任务。两者都等待停止收敛后打印当前结果。

数据目录仍由单个宿主独占。另一个宿主正在持锁执行时，第二个 CLI 进程不会接管它；活动任务的中断应通过当前宿主的控制接口发出。

带 `--applied`／`--not-applied` 的 `reconcile` 接收调用 ID，要求宿主提供核对依据，只解除已确认的不确定效果，不自动重放原调用。`applied` 表示有已确认效果，并不表示任务验收通过。不带这两个标志的 `reconcile` 仍接收运行 ID，返回原有恢复检查。旧 `resolve` 命令保留显式 `--retry` 工作流。

`rewind --to N` 使用原生文件操作的检查点恢复到第 N 步完成后的状态，即撤销步骤大于 N 的原生文件操作；`--to -1` 恢复到第 0 步之前。它不回退 shell／进程的改动，也不改写历史调用和用量。只保留最近 100 次原生文件变更检查点；目标早于保留边界时明确拒绝。执行前需停止相关写入，无法可靠恢复的检查点会明确报错。

## Agent 名册、宿主启动与草稿保留

`run`、`chat` 和 `serve` 支持 `--agent-retention review|off`、`--agent-factors A,B,C[,D,E]|none`、`--project-roots JSON_FILE`。新会话默认开启 A/B/C/D/E（2026-10-30 起），保留策略默认 `review`；`off` 不生成提议。显式因子列表只启用列出的因子，例如 `--agent-factors A,B,C` 关闭 D/E，`--agent-factors A,B,C,D` 只保留交接指导，`--agent-factors A,B,C,D,E` 同时启用主代理工具分工；`--agent-factors B` 只开启 B，`none` 关闭全部因子。D 提供起点、已知事实和验收的交接指导，不改派发规则；E 将 shell、process.exec/read、image、web、LSP 交给子代理，主代理保留文件工具、协调工具、ask_user、恢复检查及主机声明的 process.run。实验开关不会扩大执行权限。因子保存在会话中，重启与续接沿用原配置。

新会话默认使用 `compact-v2` 工具视图和任务协议 `3`，冻结内置成员 `1.3.0`。主代理保留完整编码能力，E 不再在此视图中移除命令；短命令、测试及版本控制可直接执行，独立完整任务才委派。新成员使用自然语言交付与真实调用证据，不强制 `report.submit`。保留 `file.patch` 处理大文件局部修改，以及 `history.read` 读取压缩历史引用；有执行权限时由命令处理目录管理，无执行权限时保留原生文件管理工具。

`run`/`chat` 可通过 `--tool-profile compact-v1|full` 选择旧工具视图，通过 `--task-protocol 2|1` 保留对应待办语义。旧视图的 E 仍保留上述命令下放规则。两项独立于 A/B/C/D/E，创建后持久化，恢复入口不能覆盖。Application 宿主可设置同名的 `toolProfile`、`taskProtocol`。旧会话缺失字段时保持原行为，旧 `1.0.0`/`1.1.0`/`1.2.0` 卡片照常解析。

协议 2/3 支持多个独立活动待办，派发、续接和批量探索通过 `todoId` 明确关联；省略就表示未关联，不再猜选当前项。可选 `dependsOn` 表示已验收任务的依赖；排队依赖不占模型或工作区锁。主代理可修改不冲突的独立文件。协议 1 继续只有一个活动项和隐式关联。无论是否关联待办，主代理都检查全部直接子运行：活动子运行需要等待，中断需恢复或取消，失败结果需查看或完成续接。

协议 3 的 `todo.write` 优先使用 `{expectedRevision, updates:[{id,status,note}]}` 局部更新。`content` 定义任务，`title/note` 只用于展示，不使证据换代；`dependsOn` 按集合处理。`remove` 与多个更新可同事务提交；循环、缺失依赖或 revision 冲突时整批不生效。`cancelQueued` 可显式列出需要取消的未启动直接子运行，使用原有取消路径后替换任务；已有调用、活动等待或准备过副本的运行必须先停止并等待收敛。上游实质变化会使受影响的已完成后继重新待办，旧执行记录保留，运行中的输入不静默改写。

协议 3 的读写结果默认有界；完整清单使用 `todo.read({full:true,offset:0,limit:25})` 并按返回游标续页，指定任务使用 `ids`。`items` 全量替换仍可用，但不能把有界回执直接作为完整清单重写。图的就绪状态不自动创建代理，已派发任务仍需满足资源和执行范围条件。

省略 `wait_for_events.timeout_ms` 时，协议 2/3 等待真实事件，内部五分钟续期不触发模型；显式超时仍会唤醒。协议 3 完成通知附最近少量命令、退出码、任务版本及原文引用，优先消费已有结果。`inspect_run` 的 `section: "acceptance"` 返回实际检查与任务依赖状态，`call_ids` 可批量展开最多 8 条证据；摘要和退出码不替代主代理验收，也不自动证明当前代码与原验证时相同。

派发可选 `execution: "isolated"`；运行时在依赖接受后、首次执行前，按父树当前提交创建独立 clone，避免提前排队的后继读取旧基线。源仓库已跟踪的修改须先提交，否则任务继续排队并通知主代理；源未跟踪文件不自动复制。文件工具、命令和项目指令使用同一执行根。隔离子代理以 `workspace.commit` 交付受范围约束的提交，主代理用 `workspace.integrate` 先预览，再显式应用并集成验证。副本保留供恢复，续接复用原副本；未集成的副本不能当作主树已交付。独立 clone 不是 OS 沙箱：无沙箱命令仍按同一源仓库家族保守互斥，Windows 沙箱写进程仍受已有全局写锁约束。

三种模型协议均有 120 秒首字节及字节流空闲时限，另有 180 秒有效内容进展时限。正文、推理和工具调用内容的非空增量刷新内容期限；心跳、状态及用量更新不刷新。持续生成有效内容的长流没有固定总生成时限，取消和任务总预算仍生效。内容停滞记录为 `MODEL_TRANSPORT`、`timeoutPhase: content_idle`，沿用内核已有的有限重试与预算记账；失败用量未知不能当作免费。180 秒是初始策略，不能区分网关排队与未传出内容的内部推理，因此也可能中断只在最后返回推理结果的上游。后台进程用已登记句柄查询，`process.read` 的 `stop: true` 停止自己拥有的进程并记录收敛结果，不需要自行启动未登记的后台轮询。

这三个入口还支持 `--max-active-children N` 和 `--max-children N|none`，数值须为正整数。新会话默认 `maxActiveChildren=8`、`maxChildren=null`、`maxConcurrentModels=2`，分别限制活动子任务数、累计子运行数和同时执行的模型请求数。子运行进入终态且工具调用全部收敛后释放活动名额；等待中的任务仍占名额。累计上限如显式设置，则完成任务不会归还额度，复用代理产生的新运行也会计入。`none` 只取消累计上限，不取消活动上限。配置用于新建会话，恢复或续接旧会话沿用其持久化限制，不自动升级默认值。

```sh
kodo run "检查项目并汇总" --max-active-children 8 --max-children none
kodo serve --max-active-children 4 --max-children 20
```

项目路径变量文件只包含路径根列表，例如：

```json
{ "project.tests": ["tests", "packages/ui/tests"] }
```

变量不支持 glob。配置在创建会话时复制到本地执行绑定，恢复与工作台续接使用同一配置；不能通过模型输出修改。名册卡片版本与可用性在会话开始时冻结，新批准的卡片从下一次会话才可见。

```sh
kodo spawn SESSION_ID --agent kodo/explorer@1.0.0 --objective "定位入口文件" --slot question="定位入口文件" --json
kodo spawn SESSION_ID --agent kodo/implementer@1.0.0 --objective "实现约定模块" --slot requirement="实现约定模块" --slot contract=CONTRACT_ARTIFACT_ID --scope '{"write":["src/module"]}' --json
```

`--slot` 可重复，文本直接写 `name=value`，路径列表写 JSON 数组，例如 `--slot 'entry_files=["web/index.ts","web/style.css"]'`。artifact 槽填本会话 artifact ID。卡片必填槽和文件范围由内核统一检查。`spawn` 复用会话保存的模型、宿主工具与沙箱设置；要求会话内有唯一可继续的主任务，已结束的任务需先创建后续任务。数据目录仍只允许一个宿主持锁，正在运行的工作台应使用其 HTTP 启动入口，不能用另一个 CLI 进程接管。

模型侧由主代理调用 `followup_task` 给已结束且工具调用已收敛的受管成员分配后续任务。以下是工具参数示例，目标为 `kodo/explorer` 成员，不是 CLI 命令：

```json
{"target":"AGENT_ID","objective":"补充检查配置加载入口","slots":{"question":"配置从哪些入口加载，调用关系是什么？"}}
```

`target` 可填稳定 `agentId` 或该成员的历史 `runId`；内核解析到最新任务，成员忙碌时拒绝启动。每次复用保留身份与工作上下文，创建独立 `runId`，重新校验卡片必填槽，原结果保持不变。`list_agents` 提供身份、当前运行、复用就绪状态和容量；消息、等待及证据读取使用具体 `runId`。`send_message` 只补充当前任务的信息，不启动后续任务。更换卡片或授权范围需创建新成员。完整规则见[代理委派优化方案](agent-delegation-optimization-design.md)。

主任务最终答复后，交互终端显示名称、来源任务、报告完整性、宿主验收、主任务验收，输入 `y` 保留、`n` 丢弃、`e` 编辑，回车跳过。编辑接受 `name`、`catalog`、`routing` 元数据 JSON；编辑后必须再次确认。连续跳过两次后只保存草稿，不再主动询问。`--json` 与非交互模式只输出 `agent.drafts` 列表，不读取确认输入。

```sh
kodo agent drafts --session SESSION_ID --data-dir ./private-state --json
kodo agent edit DRAFT_ID --digest CURRENT_DIGEST --metadata ./agent-metadata.json --data-dir ./private-state --json
kodo agent approve DRAFT_ID --digest CURRENT_DIGEST --data-dir ./private-state --json
kodo agent discard DRAFT_ID --digest CURRENT_DIGEST --data-dir ./private-state --json
```

所有批准都绑定草稿 ID 与当前 digest；编辑会生成新 digest，旧确认不再适用。`agent.retain` 仅请求确认，不能代替用户操作。查看、编辑与丢弃不调用模型；批准来源于 CLI 能力包的草稿时会重新启用保存的宿主依赖并检查原摘要，纯 SDK 注册的自定义工具仍需其原宿主批准。保留不会改变当前会话名册，也不代表方法已经通过验收。

## TUI 交互审批

交互式 TUI 的内置工具可用授予为 read／write／exec，默认 Ask 在执行文件修改、命令、网络工具及 MCP 调用前等待用户批准。`/permissions` 或 Shift+Tab 切换 Ask／YOLO；YOLO 自动批准等待中及后续已授权调用，重启恢复 Ask。原有卡片、范围、沙箱和工具配置仍适用，原生文件范围不代替进程的操作系统隔离。非 TUI CLI 默认仍只读，沿用 `--allow-write`／`--allow-exec`。

TUI 创建或重新接管的会话在本地执行绑定中保存 `tuiApproval: true`，普通 CLI 的 resume／continue／input／answer／spawn／rewind 不会执行它们，需打开 `kodo` 后使用 `/resume`。查看、中断、取消不受此限制。包的 stdio 写授予和离线示例执行仍取自显式启动参数，不随 Ask／YOLO 自动扩大。
