# Bash 与网页读取工具

## Bash

`shell.exec` 是内置工具名称，不应作为自定义工具重复注册。`ApplicationOptions.shellProgram` 可配置绝对 Bash 路径；CLI 使用 `--shell-program ABSOLUTE_BASH_PATH`。内置后端用 `resolveBashProgram({ program? })` 查找 Bash，再以 `createShellTool({ program, executeProcess })` 适配已有进程后端。
Windows 默认查找 Git for Windows Bash；Linux/macOS 查找系统和常见安装位置。显式路径必须为绝对 Bash 路径。不会从当前目录或 PATH 搜索，也不会隐式调用 WSL，避免绕过宿主工作区与沙箱约束。

模型参数是 `command`、可选的 `background` 和 `timeoutMs`。`background:true` 在启动后返回受管理的后台句柄；普通调用到达会话的 `toolTimeoutMs`（CLI 的 `--tool-timeout-ms`）时，有后台容量也会转入后台。后台最多同时运行 8 个进程，已满时显式后台请求报错，前台调用仍受宿主等待时限约束。`timeoutMs` 是包含后台时间的进程总存活时限，默认 600000 毫秒，最大 86400000 毫秒，同时受运行剩余预算约束。每次从运行工作区启动新进程，变量和 `cd` 不跨调用保留。支持变量、管道、重定向和复合命令，默认开启 `pipefail`。`--noprofile --norc -p` 禁用启动文件、环境启动脚本和继承的 shell 函数。

执行前检查会拒绝显式 shell 后台作业（如 `nohup ... &`），提示移除 `nohup` 和末尾 `&`，改用 `background:true`。这是对直接 shell 作业语法的使用提示，不是完整 Bash 解析器，也不保证识别嵌套脚本或程序自行派生的后台工作；不会擅自改写命令。

工具要求 `exec` 权限。宿主把受支持的字面只读／等待命令归为读取：包括 `sleep`、`tail`、`head`、`cat`、`grep`、`pwd` 等受限参数形式，以及每段都能确认的 `;`、`&&`、`||` 串联和管道；允许丢弃标准错误的 `2>/dev/null`。变量展开、后台作业、文件输出和未知程序或选项仍按可能写入处理。这个分类依赖宿主受信任的命令环境，不是操作系统隔离。

`executeProcess(context, { program, args, background, timeoutMs }, signal)` **必须复用宿主现有的进程执行后端**，由后端管理总存活时限和后台句柄，保留沙箱、敏感环境过滤、输出截断和工件、终止进程树、未知写入阻塞与实际退出前的写入锁。不能从该回调递归调用 `Tools.execute('process.exec')`，否则会重复取得写入锁。工厂自身不创建第二套不受管控的进程执行路径。

后端的总存活计时器在返回后台句柄后继续生效，超时结果带 `timedOut`；命令非零退出仍保留退出码和标准错误。只读／等待命令超时后，在确认进程树已停止时自动记录 `effects.verified=true`、`basis=read-only-command` 和 `tool.reconciled` 事件；即使没有沙箱也不产生 `UNKNOWN_WRITE`，后续调用可以继续。超时仍是失败，不是任务成功。可能写入的命令在进程树确认停止后由宿主扫描写入根：有 OS 沙箱时比对派发前后清单；无沙箱时列出命令启动后 mtime/ctime 变化的条目（含 2 秒时间戳余量），记录 `basis=workspace-change-time`、`unobserved=outside-roots`，不再产生 `UNKNOWN_WRITE`。该记录只说明写入根内的观察结果，不证明写入根外没有副作用；扫描超出预算或文件持续变化时仍保留 `UNKNOWN_WRITE`。

Windows 上未启用沙箱的 Bash 通过宿主启动器进入独立 Job Object：目标在挂起状态下加入任务组后才开始执行，后代进程继承成员关系。即使 Git/MSYS 改变父子进程关系，取消启动器仍会关闭任务组并终止全部后代，释放输出管道。Bash 主进程先退出时，启动器继续等待后代，整组退出后才返回原始退出码；后台任务使用 `shell.exec` 或 `process.exec` 的 `background:true`。沙箱运行沿用其已有任务组。

启动器使用 Windows .NET Framework 的编译器构建，按源码摘要缓存到系统临时目录，后续命令直接复用；编译不可用时明确报错。如果实际清理仍失败，保留 `PROCESS_STOP`，不生成已确认退出的核实记录。

长测试或构建优先使用 `shell.exec({command, background:true, timeoutMs})` 或 `process.exec({program, args, background:true, timeoutMs})`。收到 `background.id` 后用 `process.read({id, waitMs:30000})` 等待输出或退出，使用返回的偏移量续读。只配置 `shell.exec` 的卡片也获得 `process.read`。`waitMs` 到期只返回当前状态，不杀进程；实际等待上限为宿主工具时限的 90%。这避免通过 shell 的 `sleep` 和外部日志轮询来管理长任务。

模型可调用 `recovery.inspect({})`，请求宿主用已有文件探针或已注册验证器核实当前运行的未知写入；工具不接收模型提供的结论，也不重放调用。明确核实后可以继续；无法核实时返回阻塞调用及原因，其他运行的未知效果仍须其所有者或宿主核实。`process.exec` 的受限 `pgrep` 参数和宿主声明的精确只读命令允许用于调查。若一轮回复全部是被未知写入阻塞的调用，宿主尝试一次核实；仍无法核实则立即保存 `UNKNOWN_WRITE` 交接，不再空转到六轮 `NO_PROGRESS`。混合批次中的独立工作仍可继续。

原生文件工具统一使用工作区相对路径。编辑已有文件前，先用本轮的 `file.read` 取得完整文件哈希并传给 `expectedHash`；shell 读取不会登记这个前置条件。`file.patch` 做局部替换，`file.apply_patch` 的 `content` 是完整文件内容，用于创建或整文件替换。

## 网页读取

`Application` 默认注册 `web.fetch`，宿主通过第四个构造参数的 `webFetch` 配置网络策略，模型调用 `web.fetch({ url, maxChars? })`。不应通过 `registerTool` 重复注册。缺省策略为 `{ enabled: false }`。工具要求运行卡片允许且会话授予 `read`；宿主还必须设置 `enabled: true`，仅有读权限不会开启网络。

```ts
const app = new Application(dataDirectory, provider, undefined, {
  webFetch: { enabled: true, allowedHosts: ['docs.example.com'] },
});
```

CLI 使用 `--webfetch` 开启公网读取，可通过 `--web-hosts HOST1,HOST2` 限定目标；CLI 不开放私网访问。内网或本地测试由可信宿主配置 `allowPrivate: true`，仍受主机列表限制。启用策略需要在恢复运行时保持一致，否则能力指纹检查会拒绝恢复。

策略字段：

| 字段 | 默认与范围 |
| --- | --- |
| `enabled` | 必填，可信宿主显式开启 |
| `allowedHosts` | 可选；精确主机名/IP 列表，不接受通配符、端口或路径；重定向目标也必须匹配 |
| `allowPrivate` | 默认 `false`；仅可信内网或本地测试配置开启 |
| `maxBytes` | 1 MiB；256 字节至 8 MiB |
| `timeoutMs` | 30 秒；1 毫秒至 120 秒，覆盖 DNS、所有重定向和正文 |
| `maxRedirects` | 5；0 至 10 |

仅支持无内嵌认证信息的 HTTP(S) GET。每次重定向重新检查协议、主机列表及 DNS 的全部返回地址；默认拒绝私有、环回、链路本地、文档、组播和 IPv4 映射地址。实际 HTTP 连接固定使用已验证的解析地址，保留原主机名的 HTTP Host 与 HTTPS 证书验证，避免校验后再次解析导致 DNS 重绑定。不发送 Cookie、认证头或宿主环境凭据，不启用连接池跨目标复用。

支持 UTF-8/ASCII 的 `text/*`、HTML/XHTML、JSON 和 `application/*+json`。请求未压缩内容，对不遵守要求的压缩响应明确报错，避免压缩炸弹。HTML 提取可读文本、移除脚本样式并返回标题，不执行 JavaScript；JSON 在完整捕获时解析并排版。正文按实际接收字节限制，超限停止读取；返回 `truncated`、`bytesRead`、HTTP 状态、原始/最终 URL 和完整重定向链。字符截断不切开 UTF-16 代理对。HTTP 4xx/5xx 保留正文和 `ok: false`，网络/协议/类型错误明确失败。

网页始终标为不可信外部内容。工具不执行网页指令。公网访问是宿主能力，独立于进程沙箱的网络策略；宿主应有意识地决定是否为一个沙箱运行额外授予网页读取能力。策略与 Bash 路径进入工具版本指纹，重启后配置改变不能伪装为原有能力契约。

验证：`npx vitest run tests/shell-tool.test.ts tests/shell-background.test.ts tests/shell-kernel-timeout.test.ts tests/windows-process-tree.test.ts tests/background-exec.test.ts tests/recovery-tool.test.ts`。测试使用本地模拟模型及实际已安装 Bash，不调用收费模型。
