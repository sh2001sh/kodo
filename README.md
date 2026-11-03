# Kodo

Kodo by CodeGo AI · 理解目标，组织协作，执行交付。

当前为 **本地开发预览版**，尚未公开发布。主代理和子代理共用执行循环，支持独立上下文、直接问答、持久等待、集中询问用户、决定变更、会话共享预算、长上下文压缩与原文追溯、取消和有证据的写入恢复。提供 Ink 终端工作台、非交互 CLI、兼容行输入，以及通过 `kodo serve` 启动的本机 Web 工作台。

新会话可选 `--tool-profile lean-solo`（6 个基础工具）或 `--tool-profile lean-team`（再增加委派、任务操作和代理查询，共 9 个工具）。两者使用任务协议 3、短提示和按需状态帧；团队模式按依赖图自动调度，在包含未提交修改的独立检出中执行写任务，由宿主提交和集成。`--max-active-children` 控制活动子任务数，`--max-concurrent-models` 控制同时请求模型的数量。默认仍为 `compact-v2`；并行功能的行为测试不代表已证明真实任务的速度或费用收益，详见[精简与并行方案](docs/kodo-lean-parallel-plan.md)。

宿主 API 已支持注册工具、按需读取 Skills、HTTP/SSE 与 stdio MCP、独立子代理模型与文件范围，以及带 SHA-256 校验的能力包 ZIP 分发、显式启用和隔离工具执行。已安装卡片使用 FTS5 trigram 排名、中文短查询补偿、命名空间目录和有预算的候选路由；检索结果不构成授权，也不自动委派。自然语言创建／保存 Agent、冻结案例执行、新旧版本比较及有证据的采用／回退已接入 CLI。格式和边界见[能力包](docs/capability-packages.md)、[Agent 创建](docs/agent-authoring.md)和[案例验收](docs/agent-cases.md)。公共社区目录仍未实现；模型生成的任务摘要作为条件性容量保护默认启用，仅在达到上下文压力阈值时调用模型，可用 `--compaction off` 或 `ApplicationOptions.compaction: false` 关闭，格式见[上下文压缩方案](docs/context-compaction.md)。

宿主可注册任务完成验收器，CLI 可通过 `--verify-command` 指定验收程序；验收失败时反馈给模型纠正，最多两次。未注册的运行标为 `quality.status=not_checked`，终端同时打印“未被验收”。结构和确定性测试通过不等于真实模型任务已经可靠完成。

`Application`、普通 CLI／Web 默认开启结构化只读探索及私有项目知识：分工原子创建并支持重启幂等，结果自动保存为带真实读取证据的候选版本，后续会话按需检索，来源变化或权限收窄后拒绝直接采用。宿主可用 `exploration: false` 显式关闭；简短的已知事实问答无需计划或子代理，实质执行按下文的负责人策略分工。启用契约、验收和基线／并行／复用对照入口见[并行探索与项目知识](docs/parallel-exploration.md#11-当前实现与启用)。真实模型收益尚未验证。

确定性动态上下文组装也保持实验开关默认关闭。它以授权归档中的稳定原文评分，按实际注入的完整工具组扣证据额度，并在检查视图记录来源 ID；来源不可读时只保留指针。每次模型请求均带有当前状态帧，包含实际单工具时限和剩余预算；`kodo inspect RUN_ID --context` 查看上下文组成。该修复尚未重跑付费对照，不能据离线测试宣称质量、费用或时延收益，详见[动态组装对照方案](docs/context-assembly-experiment.md)。

CLI 提供 `interrupt RUN_ID` 暂停当前轮次、`rewind RUN_ID --to STEP` 回退原生文件检查点，以及 `reconcile CALL_ID --applied|--not-applied --evidence "核对依据"` 确认效果而不自动重放。项目记忆与延迟工具加载分别由 `--memory`、`--lazy-tools` 显式开启；`--verification-config` 声明并批准固定原生沙箱／WSL／容器验证命令，支持重复运行及不稳定测试报告，默认不启用。配置随会话保存，详见 [CLI 本地宿主配置](docs/cli-host-configuration.md)。Windows Node 子进程的异步管道、同步捕获和 fork IPC 已通过宿主句柄代理接入；支持范围及实测记录见[原生平台验证](docs/platform-validation.md)。这不是任意程序的通用管道改写，也不代表所有测试框架和后端已经实机验收。

## 先运行内核 demo

```powershell
npm ci
npm run demo:kernel
npm run demo:kernel:recovery
```

上述命令使用明确标注的脚本模型，实际执行 SQLite、文件工具、产物和完整协作循环，无需模型服务。第二个演示覆盖长上下文压缩后找回随机原文、不确定外部写入经核实后恢复，以及文件补丁自动核实与终态不变。证据和运行标识保存在打印的数据目录中。真实模型协作模式运行 `npm run demo:kernel:local`，需要先配置下文的模型环境变量；两种模式不会静默相互替代。演示流程和检查点见 [内核 demo](examples/kernel-demo/README.md)。

交互式运行（先完成下文的构建）：

```powershell
node 'dist/cli/index.js'
node 'dist/cli/index.js' chat '请把项目检查拆成两个独立子任务，直接交流证据，最后汇总' --allow-write --max-tokens 200000 --max-model-calls 30
```

TTY 中裸命令或 `chat` 打开英文界面的终端工作台，仍支持中文输入与内容；首页、命令与本地 Agent 浏览不需要凭据，也不调用模型。发送任务前运行 `kodo config` 配置 provider，向导会请求该 provider 的模型列表端点并供选择；TUI 中输入 `/model` 也可获取列表、切换 provider 和保存模型。新选择用于新会话，已有任务继续使用原绑定，使用 `/new` 开始应用。输入 `/` 即时显示命令候选，输入 `@` 显示文件候选；↑↓ 选择，Enter／Tab 接受，Esc 关闭并保留草稿。文件候选仍在加载时 Enter 不会发送任务。`Ctrl+P` 或 `/help` 打开完整命令面板，`/help keys` 查看快捷键；`Ctrl+O` 展开过程，`Ctrl+G` 打开外部编辑器。编辑器支持 `KODO_EDITOR_JSON` 完整参数数组，也支持 `VISUAL`／`EDITOR`，不通过 shell 拼接命令。

首页居中展示清晰的 Kodo 点阵标识；顶部为产品／版本和工作区，底部为输入与一行状态。品牌语、费用说明和详细快捷键不常驻显示。`Ctrl+C` 中断当前轮次，1.5 秒内再次按下会清理执行并退出。标识与网站／应用图标共用 SVG 源文件，深浅版 Logo、透明 PNG、ICO、ICNS 和使用说明见 [品牌资产](brand/README.md)。

直接输入在运行中补充资料；`/decision 内容` 修改约束；`/next 任务` 排队，`/next` 查看、编辑或撤回；`/tasks answer` 通过待回答列表选择具体问题。`/resume` 先浏览记录，再显式恢复；已结束运行继续为新任务。`/stop` 中断当前主轮次，`/cancel` 保留终止语义，`/quit` 在活动任务存在时先显示退出选择。任务面板分别显示子代理和后台进程，查看详情不会改变主输入收件人。

`/changes` 查看主／子任务可归属的检查点与差异，`/check` 运行启动时已批准的固定验证命令，`/context` 查看真实上下文与用量。检查结果关联同会话已记录的文件路径和决定版本，文件或约束再次修改后显示过期；未覆盖路径不据此宣称通过。`/agents` 支持搜索、详情、显式任务向导、ZIP 导入导出、本机依赖绑定、保存静态配置与按摘要确认草稿。

本地方法创建、提炼、冻结案例、版本比较、采用与回退也可直接在 TUI 中完成：

```text
/agents new "检查接口及其调用方" --id local/reviewer --output reviewer --source-url https://example.com/reviewer
/agents test local/reviewer@0.1.0 "case.json"
/agents cases
/agents compare 基线执行ID 候选执行ID
/agents adopt local/reviewer@0.1.0 --runs 案例执行ID
/agents rollback local/reviewer --runs 旧版案例执行ID
```

作者流程先预览并确认模型请求；`--template` 明确选择不调用模型的模板。`/agents save 任务ID` 可选择静态配置保存或模型提炼方法。作者请求使用有计量、无工具的独立运行，失败或取消不写草稿；生成的 ZIP 需显式导入。案例在独立空目录中执行，保留冻结输入、模型条件、运行关联和成功／失败证据；采用与回退需重新核对证据。案例格式见[案例验收](docs/agent-cases.md)；启动参数 `--verify-command` 映射为案例固定断言命令 `default`，该程序需使用绝对路径。社区与远端发布未接入。

相同包和宿主配置可重复使用工具、Skill 与 HTTP MCP。stdio MCP 固定原工作区，同名扩展的不同版本也不能在同一 Application 中替换旧绑定；这些包需按原工作区／版本分别启动，已有会话的能力合同保持固定。只使用内置工具的方法版本可在同一 TUI 中执行案例、比较、采用与回退。

底部使用有边框的多行输入框，并显示当前 Ask／YOLO 模式；按 Shift+Tab 或输入 `/permissions` 打开权限选择。默认 Ask 在文件修改、通用命令、网络工具与 MCP 调用前逐次询问，Allow once 仅批准当前调用；YOLO 自动批准等待中及后续已获工具授权的调用。模式只在本次 TUI 运行中有效，重启恢复 Ask。读取、私有报告和宿主明确声明的只读命令不重复询问。卡片约束、文件范围、工具授予和宿主沙箱继续生效；进程的操作系统隔离由 `--sandbox` 决定。

非 TTY 和 `chat --plain` 保留行输入，`run --json` 保留脚本接口。多行输入可用括号粘贴、支持的 Shift+Enter，或 `/paste` 开始、`/send` 提交；粘贴的命令按文本处理。已做 Windows ConPTY 中文注入和退出恢复冒烟；微软拼音实际组合输入与各终端的 Shift+Enter 支持仍需人工验收。设计与实现边界见 [TUI 方案](docs/kodo-tui-design.md)。

## 开发运行

要求 Node.js 24、npm。当前首要验证平台为 Windows／PowerShell。Linux/macOS 已配置安装与原生沙箱 CI 门禁，尚无本轮真机验收结果；不能把配置文件存在或平台测试跳过视为验证通过。

Windows 的 `npm run build` 会通过 `node-gyp` 编译 Node 管道原生插件，需要 MSVC C++ 构建工具、Windows SDK 和 Python。输出 `dist/sandbox/windows/node-pipes.node` 随包分发；插件精确绑定构建时的 Node／libuv 版本，更换 Node 后须重新构建。缺少插件、版本不匹配或构建工具不可用时明确报错，不改用无隔离执行。

```powershell
npm ci
npm run check
npm test
node 'dist/cli/index.js' --version
node 'dist/cli/index.js' doctor
```

`npm test` 先构建，再执行包括构建后 CLI 在内的所有本地测试，不调用收费模型。`npm run dev -- --help` 可构建并显示命令。

用户配置保存在 `~/.kodo/config.json`，Windows 通常为 `C:\Users\用户名\.kodo\config.json`。首次打开 TUI 或运行 `kodo config init` 会创建缺失的文件；`kodo config path` 显示实际位置。配置多个 provider 最直接的方法是交互式向导：

```powershell
kodo config
kodo config list
kodo config use my-provider
kodo --provider my-provider
```

向导先选择协议，再显示对应 URL 示例并填写凭据。`chat-completions`／`responses` 的 Base URL 以 `/v1` 结尾，例如 `https://api.openai.com/v1`；`anthropic` 使用不带 `/v1` 的根地址，例如 `https://api.anthropic.com`，Kodo 请求时自动补成 `/v1/messages` 和 `/v1/models`。向导只查询模型元数据，不发送生成请求；列表不可用时会报告原因，也可手动填写精确模型 ID。API Key 隐藏输入，可保存在本机配置文件，或使用环境变量引用；`kodo config list` 脱敏显示密钥。JSON 示例中的密钥只是占位符：

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
      "protocol": "responses",
      "apiKey": "YOUR_API_KEY",
      "model": "another-model-id"
    }
  }
}
```

每个 provider 的 `apiKey` 和 `apiKeyEnv` 二选一。非交互配置可用 `kodo config add NAME --base-url URL --api-key-env ENV_NAME --model MODEL`，删除使用 `kodo config remove NAME`。provider 选择顺序为 `--provider`、`KODO_PROVIDER`、`defaultProvider`、唯一已配置 provider；显式模型／连接参数覆盖所选配置。没有选中 provider 时继续支持原有环境变量配置：

```powershell
$env:KODO_MODEL = 'glm-5.3'
$env:KODO_BASE_URL = 'https://codegoai.com/v1'
$env:KODO_PROTOCOL = 'responses'
# 在本机安全配置 KODO_API_KEY 或 OPENAI_API_KEY。
node 'dist/cli/index.js' run '阅读 README.md，列出已实现能力与限制' --json
```

`KODO_HOME` 可将用户配置目录改为其他绝对路径；它不改变运行历史目录。配置文件含凭据时应仅保存在本机，不加入仓库。完整字段、命令和选择规则见 [CLI 本地宿主配置](docs/cli-host-configuration.md#用户级模型配置)。

`/providers` 选择连接或合并 provider，`/model all` 浏览所有 provider 的实际模型目录并显示来源；部分目录失败会明确提示。可用 `kodo config merge shared primary secondary --model model-id` 建立有序备用组，成员须为 2–8 个协议相同的物理 provider。运行中的主／子任务在鉴权、配额、限流、连接或 404 错误且未收到内容或用量时，按顺序尝试组内下一连接，始终使用同一个精确模型 ID；每次物理请求分别计量。收到部分回复、思考、工具内容或用量后不切换，取消也不切换。切换通知显示原因，费用变化未知时不会编造金额。

`modelBindings` 为子代理声明允许选择的模型别名及简短能力说明，`modelRoles` 将已有的 `fast`／`standard`／`strong` 角色映射到别名；说明由用户填写或依据实测维护，不代表 Kodo 自动评测结论。新会话冻结这些配置，子代理优先使用显式 `model_binding`，其次使用卡片角色默认，最后继承主代理。复用或续接同一子代理保留原模型与上下文；换模型需新建代理并交接资料。主代理模型不会因此自动改变，也不会为每条待办逐一试跑所有模型。组配置、别名命令及当前调用覆盖范围见[模型分工与备用连接](docs/cli-host-configuration.md#模型分工与备用连接)。

本机无认证的服务也需要给 SDK 一个非空占位值，例如 `KODO_API_KEY=local-not-required`；它不是真实密钥，也不表示服务具备认证。远程接口要求 HTTPS，不接受 URL 中的用户名、密码或查询参数。不同供应商／模型需各自通过工具循环测试，不能仅凭接口兼容就视为可用。

支持三种模型协议，可通过 provider 的 `protocol` 字段、创建运行时的 `--protocol`，或未选 provider 时的 `KODO_PROTOCOL` 选择：

| 配置值 | 请求端点（相对于 Base URL） | 认证 |
| --- | --- | --- |
| `chat-completions`（默认） | `/chat/completions` | Bearer |
| `responses` | `/responses` | Bearer |
| `anthropic` | `/messages` | `x-api-key`、`anthropic-version: 2023-06-01` |

协议随运行与子任务持久保存，恢复时沿用原绑定；不自动切换协议或回退到本机模型。三种协议均使用流式响应，支持文本、函数工具调用和结果回传；Responses 保留原有输出项与加密推理，Anthropic 保留签名思考块，供后续调用按原顺序回传。`image.read` 可把本地图片实际字节作为三种协议的原生视觉输入，要求所选模型支持视觉；不生成图片，也不支持音视频输入或供应商原生服务端工具。图片格式与限额见[图像输入](docs/image-input.md)。2026-10-20 使用 CodeGo `glm-5.3` 完成的三协议真实验证覆盖文本与工具循环，不代表新增视觉能力已通过收费模型实测；详见[远程 API 验证](docs/remote-api-verification.md)。

运行默认只读。生成报告产物或修改项目需显式加 `--allow-write`：

```powershell
node 'dist/cli/index.js' run '阅读 README.md，使用 artifact.write 保存能力清单和未验证项' --allow-write --json
node 'dist/cli/index.js' run '整理验收记录' --card 'examples/reporter/AGENT.md' --allow-write --json
```

`--workspace` 指定工作目录，默认为当前目录；`--data-dir` 或 `KODO_DATA_DIR` 指定运行数据目录。Windows 默认使用 `%LOCALAPPDATA%\kodo`。不要把私有运行数据目录作为可分发资源。

## Agent、案例与本地 Web

```powershell
node 'dist/cli/index.js' agent --help
node 'dist/cli/index.js' case --help
node 'dist/cli/index.js' serve --workspace '.' --port 0
```

`agent create` 从自然语言生成方法草稿；`agent save` 从指定会话的已完成任务提炼做法。草稿和归档不自动启用、不自动采用，也不生成缺少实现的工具或 MCP。`case run` 在新的临时工作区写入冻结输入并实际运行已导入包，执行前记录关联运行，保留成功、失败及中断证据；GC 不删除案例引用的执行会话和原始证据。`case compare` 要求输入、模型和环境条件一致。`case adopt/rollback` 重新检查包摘要、最新案例及旧版覆盖，拒绝失败和回归；原有 `package adopt/rollback` 保留为底层指针操作。

`serve` 只监听 `127.0.0.1`，在终端打印地址与一次性启动口令。页面提供任务、协作面板（待处理事项、执行团队、定向交互）、连接与恢复状态（重连后补齐遗漏事件，列出需恢复/核实的任务）、能力包开发面板（兼容性诊断、依赖准备进度、版本切换与运行版本展示，需 `--packages`/`--package-actions` 显式开启）、问题、输入、取消、显式恢复和证据；`completed` 只表示执行结束，验收状态与“本浏览器是否查看”分开显示，待处理项按稳定事件 ID 去重。用户可以指定子 Agent 补充要求或取消，同一事务通知主 Agent，但不改变权限、决定版本、模型或预算；`--package author/name[@version]` 可让 Web 新任务使用已启用包，切换默认版本不会改变已运行任务。Cookie、CSRF、幂等请求回执及持久 SSE 重放保护本机访问；权限、模型和工作区由启动参数固定，浏览器不能扩大授权，包面板默认关闭。案例管理与包导入/验收仍使用 CLI。详见[本地 Web](docs/local-web.md)、[Web 协作面板](docs/web-collaboration.md) 与 [Web 第二批体验](docs/web-experience-batch2.md)。

## 工具与边界

| 工具 | 行为 |
| --- | --- |
| `file.read`／`file.list`／`file.search` | 相对工作目录读取 UTF-8 文本、分页列目录和流式字面搜索 |
| `file.apply_patch` | 使用预期 SHA-256 创建或原子替换一个文件；修改前验证旧内容，父目录必须存在 |
| `file.mkdir`／`file.patch`／`file.rename`／`file.delete` | 创建单层目录、按哈希局部替换、移到不存在的目标、按哈希删除单个文本文件 |
| `agent.search`／`agent.directory`／`agent.route` | 排名检索、浏览命名空间与推荐已安装的不可变版本；返回能力缺口、选择原因及共享探索预算 |
| `skill.list`／`skill.load` | 按卡片允许列表发现 Skill 摘要，按 ID 分页读取正文；需宿主先注册 |
| `artifact.write`／`artifact.read` | 写入与读取本会话的私有报告产物；不同会话不能互读 |
| `history.read` | 分页读取本运行或主代理管理的子运行的已登记上下文归档；长消息可按字符继续读取 |
| `history.search` | 在授权历史和工具证据中做有界字面搜索；返回精确读取参数与扫描是否完成，不把未扫完当作不存在 |
| `knowledge.browse`／`knowledge.search`／`knowledge.read` | 浏览项目知识浅目录、跨目录检索摘要或已保存证据、读取不可变版本；来源与权限每次都重新检查 |
| `process.run` | 仅运行宿主通过库 API `readOnlyCommands` 或 CLI `--read-only-commands` 声明的完整程序及参数；参数必须逐项匹配，只读超时不会建立写入屏障 |
| `process.exec` | 仅在 `--allow-exec` 下启动程序及参数数组，保留退出码、输出和取消信息 |
| `shell.exec` | Bash 命令、管道和重定向；支持 `background:true`，用 `process.read` 读取后台结果；受支持的字面只读／等待命令超时不建立写入屏障，其余按可能写入管理 |
| `recovery.inspect` | 请求宿主核实当前运行的未知写入，返回核实证据及剩余阻塞；不接受模型自报结论，不重放调用 |
| `web.fetch` | 宿主明确开启后执行有界 HTTP(S) GET；检查重定向和 DNS，返回不可信网页文本 |
| `lsp.hover`／`lsp.definition`／`lsp.references`／`lsp.symbols`／`lsp.diagnostics` | 查询宿主配置的语言服务；检查读取范围，不允许模型选择程序或执行服务端编辑 |
| `image.read` | 校验并读取本地 PNG/JPEG/GIF/静态 WebP，保存摘要并向视觉模型发送实际字节 |
| `todo.read`／`todo.write` | 本运行持久任务清单，修订号防止覆盖冲突；不授予文件写入权限或证明任务完成 |

`file.read` 默认返回 200 行以内、8000 字符以内，使用返回的 `next` 继续读取，超长单行通过 `contentOffset` 无损续读；完整文件 SHA-256 不随分页改变，文本文件上限 16 MiB。`file.list` 每页最多 200 项，按 `next.cursor` 续读；目录项变化时拒绝旧游标。`file.search` 流式扫描每个最多 16 MiB 的 UTF-8 文件，最多访问 1000 项、返回 30 个匹配行；跳过隐藏目录、依赖、构建目录、链接、受保护或无权读取的项，并返回 `incomplete`、跳过数量及原因，不能把不完整的空结果解释为没有匹配。`file.patch` 要求每项 `oldText` 恰好匹配一次，支持最多 16 MiB 的文件；歧义和哈希冲突都在写入前失败。目录创建不递归，重命名不覆盖目标，删除不接受目录。`artifact.read` 同样支持内容分页。`process.exec` 每路输出预览 4000 字符，超出部分保存到 `outputArtifact` 指向的私有产物，可用 `artifact.read` 分页读回并解析 JSON；总捕获硬限 2 MiB，超限明确标记不完整。明确未启动的进程返回 `PROCESS_START`，启动后结果未知的写操作仍须核实。

工具参数、卡片允许列表与实际授权在执行入口校验。文件路径检查包括实际目标和链接；`.git`、`.env`、常见私钥及运行时数据受保护。同一运行时中，同一工作区及父子目录的写操作串行，不重叠工作区可并行。文件检查不等于恶意代码沙箱，也不能防止外部程序同时修改文件。

CLI 可用完整 argv 数组声明可信只读命令，无需授予通用 `--allow-exec`：

```powershell
node 'dist/cli/index.js' run '检查 Node 版本和工作区状态' --read-only-commands '[["node","--version"],["git","status","--short"]]'
```

声明本身是宿主对命令的信任，不是沙箱或自动副作用分析。`process.run` 的声明摘要随运行持久化；重启后，宿主须重新提供相同的 `readOnlyCommands`，CLI 在 `resume/continue/input/answer` 时须重新传入相同的 `--read-only-commands`。缺失或变更返回 `CAPABILITY_CHANGED`，在重放前拒绝；不会从数据库自动恢复执行授权。`inspect_run` 对 `process.run` 和 `process.exec` 都恢复完整捕获后分页，返回 `exitCode` 与 `outputComplete`；进程退出成功不代表任务验收通过。

协作工具由宿主按角色提供：主代理可用 `spawn_agent`、`followup_task`、`cancel_agent`、`ask_user`；主／子代理均可用 `list_agents`、`inspect_run`、`send_message`、`wait_for_events` 和 `update_progress`。创建子任务时省略 `card_id` 和 `card_version` 即继承当前卡片；指定二者只选择已注册的不可变版本，不能通过起名字创建卡片。子任务固定卡片版本，模型默认继承，也可通过 `model_binding` 选择宿主预先注册的别名；每个子任务使用自身模型窗口，累计消耗仍共享会话。`permissions` 与 `scope.read/write` 只能缩减父任务及续接前驱的范围；任务资料包独立于父对话，工作目录共享。发信身份由运行时注入，答复检查问题与接收者归属。`list_agents` 返回职责、状态、结果是否可读、决定版本、未解决问题及复用就绪状态和容量，不暴露内部结果引用。

`followup_task({target, objective, slots})` 给已结束且工具调用已收敛的受管子代理分配新任务；`target` 可用稳定的 `agentId` 或其历史 `runId`，`slots` 必须重新满足原卡片的必填输入。复用保留代理身份和工作上下文，每个任务生成独立 `runId`，原任务结果不变。需要改变卡片或授权范围时创建新代理；给正在工作的代理补充资料使用 `send_message`，普通消息不会启动已结束代理的新任务。消息、等待和证据检查仍按具体 `runId` 定位。规划、复用和容量规则见[代理委派优化方案](docs/agent-delegation-optimization-design.md)。

`inspect_run({run_id})` 返回分页结果和可读取的工具调用目录；`inspect_run({run_id,call_id})` 分页读取对应原始工具输出。结果页和调用目录各有 `next` 游标，按返回参数继续读取。主代理可查看受管子任务、显式普通后续链中的前序主任务及其子任务，以及经过持久审计的恢复链；子代理可查看自身、宿主显式授权的前序子任务及其已审计恢复链；子任务前序授权必须是同会话、同一主任务下已结束的 `continuation_of`，不开放父任务或其他兄弟任务；同伴须显式共享结果。读取需要当前 `read` 权限，工具证据另受对应 `read`／`write`／`exec` 权限约束。不返回模型请求、私有推理或原始工具参数，不接受任意 blob 引用。长进程输出从归属已核实的捕获产物恢复后分页；受绑定环境变量保护的模型凭据会脱敏。

终态通知只携带最多 1200 字符摘要和运行 ID，唤醒事件只描述条件；详情按需通过 `inspect_run` 读取。`completed` 表示运行结束，`quality: not_checked` 表示未做宿主验收；工具 `succeeded` 表示调用执行结束，进程仍可能 `exitCode: 1`。

默认开启的因子 B 按收益选择分工：主代理理解任务、规划、核验证据并最终交付；范围明确的小任务可由主代理直接实现和验证，只有并行、专业能力或独立上下文的收益超过交接与验收成本时才委派。耦合实现和验证交同一负责人，避免重复调查。执行前选择 `executor: main` 的进行中待办；模型派发前选择 `executor: agent` 的进行中待办。子任务完成后通过 `inspect_run` 读取现有证据，验收后及时交付；仅为明确缺口或新需求续接，不为整理报告而复制证据、创建备份或重复测试。现有授权、容量与待办验收约束仍适用。

名册直接展示必填输入槽，子代理的 `report.submit` 展示其卡片的具体字段。检查引用支持本运行内唯一的可见 `tool_call_id`，保存时转换为内部编号；编号重名时须使用 `inspect_run` 的精确 `call_id`，未完成调用不能作为已结算证据。摘要根据现有上下文预算给出建议目标，保留必要约束，不额外统一限制为 2048 token，也不截断文本或压低模型推理输出额度；依据见[摘要长度限制核查](docs/experiments/summary-length-policy-review-20261028.md)。这些调整针对[四方实验成本归因](docs/experiments/frontier-fourway-cost-analysis-20261028.md)，实际节省比例尚需同条件复测。

[此前真实验收](docs/experiments/agent-delegation-real-acceptance-20261028.md)中，旧选择性委派策略的 7 轮默认任务没有自主创建或复用队友。[负责人模式复测](docs/experiments/agent-delegation-team-lead-retest-20261028.md)确认新提示实际加载后，7 轮实质任务仍无自主委派。两批显式正控制均验证了创建和复用机制；默认职责分工尚未通过实际采用验收，不据此宣称协作效率或成本收益。原始报告和结果保留。

等待记录与工具结果持久化后才挂起，挂起前再次检查新输入。收到答复、目标终态、超时或新问题会唤醒；新问题不会把原问题标为已回答。循环等待会生成 `wait.deadlock` 并通知主代理，`any` 条件的可用出口与已满足条件不会误判为死锁。等待不反复调用模型。

未启用沙箱时，`--allow-exec` 是高权限可信执行，程序及 Bash 命令可访问宿主用户资源；应用层文件范围不能约束它们。加 `--sandbox` 后使用 Windows LPAC／Job Object、Linux bubblewrap 或 macOS sandbox-exec，默认断网，工作区写入还须 `--allow-write`。后端不可用时拒绝执行。`shell.exec` 每次从工作区启动新的 Bash，不保留前次变量或目录，关闭启动脚本且开启 `pipefail`。Windows 使用 Git for Windows Bash，也可用 `--shell-program` 指定可信绝对路径；不隐式调用 WSL。详见[Bash 与网页读取](docs/shell-webfetch.md)。

`web.fetch` 默认由宿主禁用；CLI 用 `--webfetch` 显式开启，可用 `--web-hosts example.org,docs.example.org` 限定主机。它拒绝内嵌凭据、默认私网地址与 DNS 重绑定，不携带 Cookie 或认证头，不执行网页脚本；这项宿主网络授权独立于进程沙箱。LSP 默认没有服务器，不自动下载安装；用 `--lsp-config 配置.json` 声明固定程序、参数、语言映射及可信只读资源，或通过 `ApplicationOptions.lsp` 配置。未配置的语言服务和禁用的网页工具仍保留能力绑定，但不向模型发送参数定义，避免占用小窗口；直接调用会明确报不可用。未启用沙箱的语言服务仍是可信本地进程。todo 的修订、LSP 位置编码及关闭规则见[LSP 与任务清单](docs/lsp-todo.md)。

沙箱资源限额可通过 `--sandbox-resources` 配置内存与进程数；Windows、Linux 与 macOS 的实际含义和限制不同，不支持的设置明确拒绝。操作系统网络端点白名单尚未实现，传入该策略会失败；`web.fetch` 的主机列表不能限制任意子进程的套接字。配置、清理语义及平台限制见[操作系统沙箱](docs/os-sandbox.md)。

模型工具名称在协议上使用下划线（如 `file_read`），运行记录使用逻辑名称（`file.read`）。工具参数只有在整份响应正常结束后才可能执行；响应截断或断流不会执行其中的请求。工具结果与原始调用 ID 一起保存。

## 宿主扩展 API

扩展由可信宿主先注册，再用 `app.parseCard()` 校验卡片允许列表。注册本身不向模型授予调用权；有效卡片和运行权限必须同时允许。以下示例要求宿主已有 `skills/review/SKILL.md`（YAML 中 `name: review`、`description`，正文为方法说明），并配置模型密钥与完整 MCP 认证头的环境变量：

```js
import { Application, loadSkill } from 'kodo-local';

const binding = {
  model: 'custom-model', baseURL: 'https://model.example.com/v1',
  apiKeyEnv: 'KODO_API_KEY', limits: { context: 128000, output: 8192 },
};
const app = new Application('./.kodo', undefined, undefined, {
  modelBindings: { reviewer: binding },
  skills: [await loadSkill('./skills/review/SKILL.md')],
  tools: [{
    name: 'host.project_info', version: '1',
    description: 'Read the current task identity.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    permission: 'read', effect: 'read',
    execute: ({ run, signal }) => { signal.throwIfAborted(); return { runId: run.id }; },
  }],
});
try {
  await app.connectMcp({
    id: 'catalog', transport: 'http', url: 'https://mcp.example.com/mcp',
    headers: { Authorization: { env: 'MCP_AUTHORIZATION' } },
    tools: { lookup: { permission: 'read', effect: 'read', version: '1' } },
  });
  const card = app.parseCard(`---
schema_version: 1
id: local/reviewer
version: 1.0.0
name: Reviewer
description: Read source code and report evidence.
capabilities:
  tools: [file.read, file.list, host.project_info, skill.list, skill.load, mcp.catalog.lookup, agent.search]
  skills: [review]
---
Use the review skill when relevant. Verify claims with original evidence.
`);
  app.registerCard(card);
  const run = app.createRun({
    objective: '检查 src 中的实现并交付证据', workspace: process.cwd(), binding, card,
    permissions: ['read'], scope: { read: ['src'], write: [] },
  });
  app.updateProgress(run.id, { pending: ['阅读源码并验证结论'] });
  await app.run(run.id);
  const page = app.events({ runId: run.id, after: 0, limit: 100 });
  console.log(page.items);
  // page.next 非 null 时，保持筛选条件并传 after: page.next 继续读取。
} finally {
  await app.shutdown();
}
```

stdio 连接使用同一接口：`await app.connectMcp({ id: 'local', transport: 'stdio', command: 'node', args: ['/absolute/server.mjs'], tools: { lookup: { permission: 'read', effect: 'read' } } })`。服务器地址、程序、参数、环境变量引用与每个工具的权限／副作用全部由宿主声明，模型不能自行指定。HTTP 支持 JSON 与 SSE 响应、会话 ID 和取消通知；stdio 使用换行 JSON-RPC，关闭时清理进程。当前 MCP 范围为工具初始化、发现和调用，不含通用资源／提示词客户端，也没有自动重连重放。Skill 正文按需读取；获准工具的参数定义仍随模型请求发送，通用工具参数按需发现尚未实现。远端的只读注解不构成授权。

卡片的 `capabilities.skills` 允许已登记 Skill ID；同时列入 `skill.list/skill.load` 才可发现并读取正文。加载正文不执行脚本、不安装依赖、不递归导入引用文件。`agent.search({query,tools,skills,offset,limit})` 对已安装版本的元数据使用 FTS5 trigram 和排名，一至两个字符的词使用有界字面匹配；`tools/skills` 为必须包含的名称。保留筛选条件并按 `next.offset` 续读。`agent.directory` 按发布者命名空间浏览，`agent.route` 返回匹配原因、能力缺口及版本选择；未配置宿主偏好时选择匹配的最新版本，不声称已采用。三者默认共享会话内 12 次调用、100 个候选的探索预算，耗尽与无结果分别返回；宿主可通过 `ApplicationOptions.discovery` 收紧或调整。宿主直接查询使用 `app.searchCards()`；选中后用原始 `id/version` 创建子任务。当前为词法检索与规则路由，未实现向量语义搜索。

主代理可调用 `spawn_agent({objective,model_binding:'reviewer',scope:{read:['src'],write:[]}})` 选择上述宿主别名；未知别名明确失败，不能填写任意模型端点。文件范围是相对工作区的文件或目录根，省略的一侧继承父范围，空列表禁止该操作；真实路径、大小写与链接边界仍由原生文件工具检查。启用宿主沙箱后，进程工具同样受文件范围约束；包内工具始终隔离。本地 MCP 可配置 `sandbox` 并检查每次调用是否超出运行范围；自行注册的宿主回调及远端服务仍须自行落实实际资源授权。

运行时在派发自定义写回调前保守记录效果已开始；回调可再次调用幂等的 `markEffectStarted()`，并须观察 `signal`。回调抛错、超时或取消都不能证明外部操作未发生，结果按未知写入处理。函数无法强制终止任意宿主 JavaScript，未结束的回调会阻止把该效果核实为可重试；`close()` 和 `shutdown()` 此时返回 `RUNTIME_ACTIVE` 并保留数据库锁，回调结束后再关闭。重启前调用 `await app.shutdown()` 关闭运行与 MCP；重启后重新注册工具、Skills、MCP、模型别名和必要的验收／恢复回调，再恢复任务。运行持久固定工具名称、参数、权限、副作用和 `version` 摘要，Skill 内容及 MCP 绑定也纳入摘要；缺失或变化返回 `CAPABILITY_CHANGED`。同 Schema 的回调语义变化必须由宿主提升 `version`，不能靠摘要推断函数实现相同。凭据只引用环境变量，函数和活动连接不会序列化。

`app.snapshot(runId)` 具有明确的 `RunSnapshot` 类型，仍返回整批快照。长期任务使用 `app.runs/sessions/calls/events/messages` 的 `{after,limit}` 分页接口，返回 `{items,next}`；默认 100、最多 1000 项，游标由存储序号产生，保持筛选条件续读。事件重连保存最后消费的 `seq` 再传 `after`；流式文本仍属临时显示，不能充当持久事件。订阅者异常会通过 `onSubscriberError` 上报，不把已提交的运行事务改判为失败。token 校准只检查最近 32 次模型调用并复用匹配指纹缓存；这没有替代长期负载测试。

## 预算、状态与取消

支持 `--max-tokens`、`--max-model-calls`、`--max-tool-calls`、`--max-output-tokens`、`--max-context-chars`、`--timeout-ms`、`--tool-timeout-ms`、`--max-children`、`--max-concurrent-models` 和 `--cache-read-cost-percent`。`--cache-read-cost-percent N`（0–100，默认 100）让 `--max-tokens` 按费用而非原始体量计账：供应商 usage 报告的缓存命中输入只按 N% 计入，未命中输入、缓存写入和输出仍全额计入；默认值保持旧语义。设计 v3 取消收尾阶段与交付预留：限额只是宿主可选的硬上限，触达即停止并给出交接报告；未设置时运行只因模型完成、真实错误或无进展熔断而结束。主／子任务与后续运行共享会话消耗。条件性摘要压缩默认在有效窗口 E=窗口−输出预留 的 0.8 倍触发；可用 `--compaction off` 关闭，或用 `--compaction mask|summary|hybrid [--compaction-work-tokens N | --compaction-trigger-ratio R]` 覆盖。确定性动态组装仍需 `--assembly deterministic [--assembly-work-tokens N] [--assembly-evidence-tokens N]` 显式启用，不会增加模型调用。执行时间按至少一个任务正在推进的会话墙钟累计，全部挂起等待时暂停；活动起点 `activeSince` 先持久化。若执行时进程崩溃，重开时保守累计到重开时刻，包含无法确认的停机时段、最多记到预算上限，不通过重启清洗消耗。排队时主代理优先。调用前预留 token，得到 usage 后结算；usage 缺失或断流时保留估计，不伪装成精确费用。输入按字符类别加权估算，中文、日文约 1.375 token/字，韩文约 1.65 token/字，另计协议与工具开销；不是精确 tokenizer，不保证供应商侧账单上限。

模型窗口和单次输出上限由宿主声明、端点元数据或模型目录确定；可通过 `--max-context-tokens` / `--max-output-tokens` 收紧。累计 token、模型与工具调用次数、活动时长和字符上限默认不限制，仅执行用户显式配置的限额。CLI 会查询第三方端点的模型元数据；未知型号没有元数据时仍可运行，但明确标为暂定窗口，详见下方模型参数说明。成功响应的 usage 仅在绑定、工具 Schema 和完整历史前缀相同时校准，新增内容使用字符类别估算。

上下文超限时，内核按完整的模型／工具轮次压缩已完成历史，保留宿主规则、初始任务、用户输入与决定、未解决问题；超长工具轮保留调用 ID 与结果摘录。原始上下文作为内容寻址快照保存，发出 `context.compacted` 事件并在当前上下文留下原文引用。`history.read` 仅允许读取已登记且归属允许的快照，通过消息及字符游标分页；`history.search` 在同样授权范围内做有界字面扫描。默认仍是确定性裁减和短摘录，不另调用模型；必要信息或工具 Schema 本身超限时返回 `CONTEXT_LIMIT`，不静默删除约束。

条件性工作上下文压缩默认使用 `summary`，在有效窗口的 0.8 倍触发；可通过 `--compaction off` 或 `ApplicationOptions.compaction: false` 关闭，也可用 `--compaction mask|summary|hybrid` 覆盖策略。触发后按工作软预算成批隐藏已完成轮次的旧工具正文并留下读取指针，必要时调用一次当前会话模型生成有界任务摘要。摘要请求禁用工具，校验结构、来源与知识引用，记录覆盖范围与前后 token，并在覆盖前缀、决定版本或当前上下文变化时丢弃；安装后重建上下文并注入运行时状态。以下历史实验是在策略仍默认关闭时完成，保留其原始结论作为版本证据。大上下文（约 362k token / 128k 窗口 / 均匀深埋唯一事实）复核实验结果见[压缩 QA 结果](docs/context-compaction-qa-results.md)与[实验复核](docs/context-compaction-experiment-review.md)：固定投影闭卷下旧版硬容量 30.0%、mask/hybrid 10.0%、summary@65536 60.0%（2/2 安装，coverage 39%）；同一投影开卷 off/mask 均 97.5%，但输入为闭卷的 4.8–9.2 倍（0.75–1.29M token/2 trials），恢复必须设检索预算；增量 4 批/3 次压缩下 off 57.5%、summary 52.5%（6/6 安装）、mask/hybrid 20–25%，事实细节约保留一半、执行状态基本保留（Q20 原评分口径已修正）；人工预置知识目录 92.5–97.5% 仅为读取正控制，不证明自然沉淀；C4 未通过，默认关闭不变。补充复核后实验：定向探索自动沉淀知识目录（5 条、15/15 KF 标记命中）后目录 QA 自动评分 15/15，但人工复核 Q14 存在语义错误，严格成绩 14/15；无目录 0% 仅是负控制。3 个相关布局配对压力测试中 off 20.8%、summary 12.5%、mask/hybrid 4.2%，不能当作三个独立领域任务。3 个真实代码任务四组对照中 off/mask/hybrid 各 1/3 完整交付、summary 2/3；mask 少 25.1% 输入但费用略增，summary 质量较高但费用高 43.4%，hybrid 0 次摘要且质量最低。样本仅 3 个、每组 1 次，不能据此默认开启；与 OpenCode/Picode(Pi) 的压缩机制横向对比见[第三方对比](docs/context-compaction-third-party-comparison.md)（端到端同 seed 重放因上游通道不稳定未取得有效样本）。

确定性动态组装可通过 `--assembly deterministic` 或 `ApplicationOptions.assembly` 独立启用。它按当前目标和近期用户输入给旧工具证据排序，保留最近两个工具轮次，将未选旧正文替换为精确 `history.read` 指针；目标变化时可从已登记归档恢复新相关原文。策略随 CLI 会话持久化，`context.assembled` 与压缩事件分开记录，`kodo context` 可查看最近装配。当前最小实现只有在装配投影本身满足工作预算时才采用，否则回退原上下文再走既有压缩；尚未把装配投影直接交给同轮摘要。离线固定快照诊断减少 23.7% 估算输入且通过恢复检查，但一项真实 onboarding 四组配对中纯 assembly 虽少 14.5% 输入，分数从 off 的 70 降到 10，耗时增加 40.3%；四组均未完整交付。样本只有一个任务，不能估计总体效应，但已否定当前启发式默认启用，策略继续关闭。证据、停止规则和实验方案见[动态上下文组装与压缩对照方案](docs/context-assembly-experiment.md)。

SDK 自动重试关闭，由内核统一记录最多三次尝试，遵循供应商 Retry-After（最多 60 秒）或指数退避，并计入调用和时间预算。三协议区分认证、额度、上下文、请求和临时服务错误，包括 HTTP 200 心跳后裸 JSON 的 CodeGo 网关错误。按本项目约定，HTTP 429 计 0 token 并释放该次预留；其他没有 usage 的失败保留估计，不能算作零费用。相同参数连续三次得到相同失败或不变证据时反馈模型，第四次不变调用停止运行。按 Ctrl+C 停止新调用并尽力中断本次拥有的进程树；已发生的文件或远程副作用不会自动撤销。

`--prompt-cache session` 或 `KODO_PROMPT_CACHE=session` 显式启用会话缓存提示，默认 `off`。OpenAI 两协议使用 `prompt_cache_key`，Anthropic 使用稳定 system 块的 `cache_control`。必须由供应商支持这些参数；开启不保证命中率提高。usage 分开保存 `cacheRead/cacheWrite`，`input` 已包含缓存部分，不重复累加。缓存、完成验收接口和边界详见[执行补强说明](docs/kernel-hardening.md)。

JSON 模式 stdout 输出同会话的 JSONL：持久事件带递增 `seq`，文本增量带 `transient: true`，只供显示。最终回复和调用结果引用可从持久事件和快照读取；stderr 用于命令错误。退出码：成功 `0`，失败／中断 `1`，需输入 `2`，用户取消 `130`。非交互 `ask_user` 保存问题后退出，不永久占用终端。

普通补充在模型／工具边界读取；`--decision` 创建会话决定版本并通知任务。旧响应中尚未启动的动作返回 `DECISION_CHANGED`，旧版本完成结果在快照中标记 `stale`，保留原始证据供复核。应用 API 的 `updatePermissions` 可撤权并中断在途工具，不允许动态提升授权。终态输入或 `/next` 创建后续运行，原运行不重新打开。普通后续链通过独立的 `historyFrom` 授权保留原始用户约束、有限前序结果与证据索引、最近进展；排队期间前序任务尚未完成时，实际执行前刷新最终结果。明确续接的子任务也携带有限前序结果和 `inspect_run` 索引，并可沿显式授权链读取原始证据；仅填写 `continuationOf` 不授予历史访问。原问题、等待、邮箱身份和宿主验收回调不会因此转移；新任务验收须重新注册。写入恢复链仍单独按持久审计处理。

`update_progress` 与宿主 `app.updateProgress(runId, progress)` 替换持久进展快照，字段为 `facts/completed/pending/evidence` 字符串数组，省略的数组清空；每项最多 800 字符，每类最多 16 项，总 JSON 最多 8000 字符。进展在压缩与后续任务中重新注入，明确作为待核验资料，不授予权限。终态进展不可修改。必要约束不做有损语义摘要，无法放入窗口时明确失败。

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

`resolve` 记录用户独立核实的具体依据（16 至 16000 字符），结果可为 `succeeded`、`failed` 或 `not_applied`。只有明确核实为未执行时，才允许附带 `--retry` 显式授权受控重试；没有强制重放开关。核实输出包含原调用记录、证据和恢复计划，冲突的核实结论拒绝覆盖。核实后执行 `resume`：中断运行继续其已保存步骤；已失败的 `UNKNOWN_WRITE` 运行创建恢复延续任务，沿用已确认的调用结果与会话预算，原失败运行及其调用记录不变。重复恢复同一来源不会再次复制执行。恢复主任务时先检查同会话中断与不确定写入，不让其他任务绕过阻塞。宿主可通过 `registerRecoveryVerifier(toolName, verifier)` 或注册工具的 `recover` 回调核实其他副作用；回调收到 `{run,call,request,signal}`，返回带具体 `evidence` 的 `succeeded/not_applied/failed/unknown`，可附已核实结果。只有核实为 `not_applied` 才允许受控重试；超时、抛错或 `unknown` 继续阻塞。

`file.patch/mkdir/rename/delete` 已增加调用尝试绑定的操作前快照和完成回执。核实会检查请求、真实路径、文件身份与内容；完成回执和当前状态一致才确认完整操作。`file.patch` 也可凭操作前记录的完整新内容摘要确认成功；未发生变化的原始身份与状态可确认未应用。缺少回执时，单凭目录出现、源文件消失或目标文件出现不能证明 `mkdir/delete/rename` 完成，仍按未知写入阻塞；旧版无准备证据、路径变化或结果分歧须用宿主核实器或手工证据处理。进程及 Bash 写入没有通用自动核实器，自动补偿尚未实现。

工具已退役或契约变化时，人工确认 `succeeded`／`failed` 仍可记录核实证据并解除未知写入屏障；这不会执行旧工具。自动核实、旧任务恢复以及 `not_applied` 后重试仍要求原工具契约一致。

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

2026-10-22 上下文压缩完善后的本地回归（串行全量）：**74 个测试文件、988 条测试通过（8 条平台相关跳过）**，`npm run check` 通过，评测脚本 70 条通过。新增批量旧观察隐藏、摘要安装／非法引用／预算不足／决定变化／连续摘要与崩溃／重启边界、摘要 markdown 围栏解析与推理 token 余量、短来源 ID（S1..Sn）映射与覆盖范围记录、C0 会话级聚合报表、协调器真实路径、`history.search`、知识目录整理、Web `/context`／`/knowledge` 路由与视图、`knowledge_nodes` 迁移／幂等回归。并行全量时 `tests/mcp-sandbox.test.ts` 的进程树清理用例在本机会因负载偶发超时；该用例单文件复跑与串行全量均通过，与本次改动无关。该实验开关默认关闭；真实模型的压缩收益仍按[上下文压缩方案](docs/context-compaction.md)第 11 节验收，不能据本地机制测试宣称收益。

本轮 CodeGo `glm-5.3` 的 256k token 配置复测中，分页修复和双子代理修复都通过真实测试与独立行为验收。三项任务自动验收为 3/3，但报告独立复核仍发现 1 处实质事实错误，因此计入该复核后为 **2/3**。评估的单次工具期限由 30 秒提高至 60 秒，报告新增实际源码读取要求；旧失败证据保留，不能与旧成绩直接比较。

本轮真实 9B 协作复验在服务设置 `--temp 0` 后通过：4 个运行均完成，使用 16 次模型调用、12 次工具调用和 47644 个实际计量 token。此前默认采样出现过一次随机标识抄错和一次响应截断，验收均明确拒绝并保存证据。这证明已测组合的一条完整链路，不能据此宣称模型普遍稳定。终端输入法及其他操作系统尚未人工验证。

npm 包当前名为 `kodo-local`，保持 `private: true`，命令入口为 `kodo`，许可证已按用户选择改为 [MIT](LICENSE)。尚未向公开仓库发布；正式包名和官网／反馈地址由用户另行提供，发布账户和发布动作仍待落实。本地安装／升级／回退演练入口为 `npm run verify:installation`，平台检查入口为 `npm run verify:platform`；脚本存在不表示所有平台均已通过。实际包包含构建产物、源码、回归测试、构建配置、文档、示例与验证评测脚本，不包含 `.kodo` 私有运行记录、凭据和 `node_modules`。文档中的本机历史证据路径只是来源说明，不承诺随包分发。安装后可直接运行 `npm run test:provider` / `npm run test:protocols`；源码构建、回归与任务评测需要先在包目录安装开发依赖。

产品目标、内核基线、技术计划分别见 [设计方案](docs/design.md)、[实现方案](docs/implementation-plan.md) 和 [上线方案](docs/product-launch-plan.md)。

最新[真实仓库协作收益对照](docs/collaboration-benefit.md)比较Solo、指定分工、自主选择各两次。指定分工产生真实并行且代码验收2/2，完整交付三组均1/2；自主两次仍未委派。指定分工减少主代理上下文但增加总费用，尚不能证明总体收益或自主决策错误。报告区分代码与最终交付，保留全部失败、调用、token、缓存及费用。


## 模型参数、可选限额与完成验收

没有任务预算档位。宿主 `binding.limits` 声明优先；原厂端点的已知型号可直接读取打包的 [models.dev 模型目录](https://models.dev)。第三方端点由 CLI 查询 `/models` 和 `/models/{id}`，OpenRouter 优先查询账户的 `/models/user`；读取精确型号的 `context_length`、`max_model_len`、`meta.n_ctx`、输出上限等扩展字段。端点报告的能力优先于同名原厂值，可正确采用中转端更小的窗口。发现总期限为 3 秒，响应上限为 8 MiB，不跟随重定向，不发送生成探测请求。声明两个窗口参数时跳过发现。

标准模型列表通常仅包含型号，并不保证返回上下文能力。元数据缺失时先使用同名原厂目录值；仍未知则使用暂定的 128000 上下文 / 16384 输出，并在终端和 JSONL 中明确提示来源与未核实状态。只返回部分能力时，缺失字段也单独提示。暂定值是客户端兼容默认值，不能证明服务端支持该窗口；遇到不匹配可声明真实参数。不会根据模型自述、型号前缀或训练窗口伪装出精确上限。模型目录随本版本固定；旧会话恢复继续使用持久化参数。

库 API 可用 `await app.createRunWithDiscovery(options, signal)` 自动发现端点能力。原有同步 `app.createRun(options)` 不发网络请求，使用声明、目录或带警告的暂定值。显式声明示例：`binding: { model: 'custom-model', baseURL: 'https://example.com/v1', apiKeyEnv: 'MODEL_API_KEY', limits: { context: 200000, output: 32000 } }`。可选 `limits.input` 表示供应商另外限制的输入长度。模型窗口包含输入和输出；每次输出上限还会按当前输入占用与剩余显式累计 token 限额缩小。压缩默认预留约 15%（大窗口至少 16384 token），不将模型全部输出能力预先扣作固定输入容量。

默认累计 token、调用次数、总活动时长和字符上限均为不限（持久化值为 `null`）。CLI 启动时明确提示“费用随实际用量增长”；不同调用持续推进时不会由重复调用检测自动停机，需要用户取消或显式限额。需要成本或时间上限时再传 `--max-tokens`、`--max-model-calls`、`--max-tool-calls`、`--timeout-ms`。内核依然统计全部消耗，保留重试、停滞检测和取消机制；工具期限默认 120 秒，可用 `--tool-timeout-ms` 调整，并不从模型窗口推算。并发与子任务数量属于宿主资源限制，独立于模型窗口。旧会话恢复继续使用原来持久化的限额。

新会话默认 `maxActiveChildren=8`、`maxChildren=null`、`maxConcurrentModels=2`：最多同时占用 8 个子任务名额，累计子任务数不限，最多同时执行 2 个模型请求。子任务进入终态且相关工具调用全部收敛后才释放活动名额，之后可以继续创建或复用；等待中的任务仍占名额。`run`、`chat`、`serve` 可用 `--max-active-children N` 调整活动上限，用 `--max-children N|none` 设置或取消累计上限。显式累计上限统计所有新子运行，包括 `followup_task`，不会因完成任务而归还。这些参数用于创建新会话，旧会话继续沿用保存的限制，不会自动改为新默认值。

如已指定累计 token 上限，可额外传 `--input-price` 与 `--output-price`（美元 / 百万 token）显示按较高单价计算的费用投影。没有累计 token 上限就没有固定的总费用上限；该值显示为空，绝不把“不限”展示为巨大数字或虚构费用保证。

```powershell
node 'dist/cli/index.js' run '完成修复并验收' --model glm-5.3 --base-url 'https://open.bigmodel.cn/api/paas/v4' --allow-write --allow-exec --verify-command '["node","node_modules/vitest/vitest.mjs","run"]'
# 可选显式累计限额：
node 'dist/cli/index.js' run '有成本上限的任务' --max-tokens 200000 --input-price 2 --output-price 8
```

`--verify-command` 接受完整 JSON 参数数组，直接启动程序，不进行 shell 展开；验收程序由用户选择并信任，可以独立于模型工具权限运行。退出码为 0、输出未超限且未中止才通过。验收的输出证据另存 blob；配置随会话保存，`continue`、`resume`、后续聊天自动重新接入，预算和单工具期限继续适用。它验证的是所选脚本的检查范围，不能证明脚本未检查的性质。

默认交付还要求非空白最终答复；私有推理不算正文。正文与公开验收必须同时通过，失败共允许两次纠正，耗尽后明确失败并保留证据。未配置验收时，正文完整性通过也仍标为质量未验收。显式静默／仅产物任务可用 `--allow-empty-response`，库对应 `finalResponse: 'optional'`；这不会免除已配置的公开检查。公开验收每次针对最新交付状态，受管写入使旧结果失效；破坏性验证可用 `node 'scripts/verify-in-copy.mjs' -- PROGRAM ARGS` 在独立副本执行。实现边界与真实验证见[交付闭环修复](docs/delivery-closure.md)。

内置文件工具保护 `.git`、`.kodo`、`.env*`、`.ssh`、`.aws`、`.npmrc`、`.netrc`、常见私钥名及 `.pem/.key/.p12/.pfx`。未启用 `--sandbox` 的进程工具与验收命令仍属于可信执行；启用后使用原生隔离并屏蔽现有受保护资源及实际私有运行目录。`process.run` 的完整命令仍必须由宿主确认只读。文件 SHA-256 按原始字节计算，`file.read` 保留 UTF-8 BOM，读改写不会因解码而自动丢失 BOM。终端文本过滤控制字符，JSONL 保留原始数据的 JSON 转义。

存储不自动删除历史；`gc` 从数据库引用开始标记并递归保留归档和嵌入 JSON 引用，仅清理无引用 blob。`--older-than-days` 才会删除超过保留期的终态会话，无法核实的写调用保留。启动时在取得独占目录锁后清理 blob 临时文件；`--vacuum` 回收 SQLite 空间。持久事件仅保存消息 ID / 结果引用，JSONL 的完成事件仍展开结果以兼容现有使用者。

本轮审查修复及模型参数调整的本地回归：22 个测试文件、416 条测试通过；评测脚本自身 49 条测试通过。实际安装包在独立临时目录仅安装生产依赖后，版本、诊断、列表及 GC 检查均通过；第三方元数据发现另用本地 HTTP 服务验证。供应商脚本仅验证了无凭据时的明确拒绝路径，未重新调用收费模型。详见 [审查修复记录](docs/review-fixes.md)。

按阶段加载卡片方法、检查点卸载、显式阶段、项目知识和会话热插拔通过 `--inline-methods` 试用，默认关闭。宿主入口和实验边界见 [P1–P4 实现说明](docs/inline-methods.md)。
