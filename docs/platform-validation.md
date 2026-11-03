# 原生平台验证

运行 `npm run build` 后执行 `node 'scripts/verify-platform.mjs'`。该命令调用真正的操作系统后端，验证允许的文件读写、拒绝工作区外与受保护文件、对活跃 TCP 监听端口的网络隔离、取消以及平台资源限制。它不跳过缺失后端：任何一个原生门禁不可用都会以非零状态结束。

| 平台 | 所需后端 | 资源限制的真实含义 |
| --- | --- | --- |
| Windows 10+ | AppContainer、.NET Framework 编译器、Job Object；构建 Node 管道插件还需 MSVC C++、Windows SDK、Python | `resources.memoryBytes` 限制整个 Job 的已提交内存；`resources.maxProcesses` 限制同时活跃进程数，含主进程；派生进程加入相同 Job |
| Linux | bubblewrap、可用的无特权用户命名空间、util-linux `prlimit`；门禁额外使用 Python 3 | `memoryBytes` 是每个进程的虚拟地址空间上限，并非进程树总驻留内存；`maxProcesses` 是该真实用户的进程/线程保守上限，其他会话也会占用，root 真实用户被拒绝 |
| macOS | 系统 `sandbox-exec` | 支持 `maxProcesses: 1`，通过禁止 fork 实现；内存限制或更大的进程上限明确拒绝 |

JavaScript 宿主示例：

```javascript
const sandbox = createSandbox({
  workspace,
  network: 'none',
  resources: { memoryBytes: 512 * 1024 * 1024, maxProcesses: 8 },
});
```

CLI 可通过 `--sandbox --sandbox-resources 'resources.json'` 加载同一资源政策，JSON 文件例如 `{"memoryBytes":536870912,"maxProcesses":8}`。续接任务时保存原政策，不允许静默改变配额。macOS 请使用 `{"maxProcesses":1}`。

能力包的自定义工具与长驻 stdio MCP 也继承宿主资源政策；自定义工具仍保持断网，不因 MCP 的网络许可获得额外联网权。`package verify --sandbox-resources 'resources.json'` 使用同一配额验收示例，配额纳入自定义工具与 MCP 的绑定身份。

Linux 的地址空间限制会影响 V8 的大范围虚拟内存预留；适合 Python 或原生命令的限额可能无法启动 Node.js。没有设置配额就保留原行为，不会自作主张施加过低限制。内存/进程配额不同于墙上时间、输出长度，后两者继续由现有进程执行器与取消信号约束。

## 网络白名单的边界

目前三个原生后端只落实 `network: 'none' | 'allow'`。`networkAllowlist` 字段被识别后明确抛出 `SANDBOX_UNAVAILABLE`，不会忽略、退化为全部放行，或把 URL 主机名检查冒充任意子进程的网络白名单。真正实现端点白名单还需要受宿主控制的强制代理或网络过滤后端，并拦截直接 IP、DNS 重绑定、重定向、UDP 和本地套接字绕过；该部分尚未完成。

已检查两条实质不同的落实路径：Windows 可以为独立 AppContainer SID 建立 WFP 出口过滤，但当前进程为中等完整性、管理员组仅作拒绝使用，`FwpmEngineOpen0` 返回 Win32 50；不能建立引擎会话，也未修改任何防火墙策略。Linux 可以在无外网接口的命名空间内通过强制代理转发，仅让代理按实际 IP／端口连接；当前 WSL 启动失败，Docker Linux Engine 查询失败，无法验证该新后端。单独配置 HTTP 代理环境变量可绕过，不能作为替代实现。macOS 的 Seatbelt 数字端点规则需要真机验证后才可采用。

## 平台证据

CI 已配置 Ubuntu、Windows、macOS 三平台，并为 Linux 安装 bubblewrap、prlimit 和 Python 3。CI 的独立原生门禁即使普通测试为了兼容性跳过了某些平台用例，也会失败，不会以跳过充当通过。

当前开发环境为 Windows。Linux/macOS 的 CI 配置与可运行门禁属于已实现的验证入口，只有实际对应平台输出 `PASS platform gate` 后才能记为该平台实测通过；本地静态检查不能替代真机结果。

Windows 本地执行 `node 'scripts/verify-platform.mjs'` 的原始结果：

```text
PASS win32/x64: real sandbox scoped IO and denied host/protected paths
PASS native network denial against a live TCP listener
PASS native process cancellation
PASS native Windows job process and aggregate committed-memory ceilings
PASS platform gate: win32/x64 v24.13.0; native gates skipped: 0
```

同一宿主尝试了两个 Linux 执行入口：已登记的 WSL Ubuntu 启动返回 `Wsl/Service/HCS_E_CONNECTION_TIMEOUT`；Docker Desktop Linux Engine 的版本查询返回 HTTP 500。它们都没有完成原生门禁，不能记为 Linux 实测通过。macOS 未连接可用真机；三平台 CI 工作流也尚未在此次本地修改后运行。

## 宿主声明的验证通道

`verify.run` 在原生沙箱、WSL 或容器内执行宿主批准的完整命令。宿主通过 `VerificationPolicy` 固定后端、可执行文件绝对路径和整个参数数组；模型只能选择 `repeat`，不能替换命令或追加参数。默认不启用，`enabled` 和 `approved` 必须同时为 `true`，否则工具不可见且不会启动后端。配置纳入工具绑定摘要，后续运行不能静默换成另一条验证命令。

```typescript
const verification = {
  enabled: true,
  approved: true, // 宿主已确认可以启动这个后端
  backend: 'wsl' as const,
  program: 'C:\\Windows\\System32\\wsl.exe',
  args: ['--distribution', 'KodoVerifier', '--cd', '/workspace/project', '--exec', 'node', '--test', '--test-reporter=tap'],
  parser: 'tap' as const,
  repeatLimit: 3,
  timeoutMs: 120_000,
};
```

容器使用 `backend: 'container'`，由宿主填写 Docker 或 Podman 的绝对可执行路径与完整参数，显式选择镜像、工作目录、挂载及网络策略。工具不会发现、启动或创建未配置的后端，也不会在后端失败时改为宿主本地执行。

原生验证使用 `backend: 'native'`，并要求宿主显式配置 `ApplicationOptions.sandbox`。CLI 对应 `--sandbox --verification-config 'verification.json'`。该命令使用当前运行的原生文件范围、写权限、私有数据目录隔离及资源策略；没有沙箱配置时，已批准并启用的原生验证会报 `VERIFY_SANDBOX`，不会退回可信宿主进程执行。

模型调用 `verify.run({ repeat: 3 })` 后得到每次的退出码、标准输出、标准错误及解析出的测试状态。`parser: 'tap'` 读取 Node TAP；`vitest-json` 要求验证命令把完整 Vitest JSON 报告写到 stdout；默认 `exit-code` 仅比较进程结果，无法列出测试名称。测试状态在重复运行间变化或测试消失时，结果包含 `flaky: true` 和 `unstableTests`。耗时及普通日志变化不算不稳定测试。持续失败会报告 `passed: false, flaky: false`，不会将稳定失败误标为随机失败。

命令超时、取消、输出捕获不完整或报告无法解析时，结果不能标为验证通过，也不会继续重复不完整的执行。每次执行受工具取消信号、进程树清理及宿主时间上限约束，整个调用还受普通工具预算约束。验证可能写入构建产物，所以它声明为写效果并使用普通工具写锁。结束 WSL 或容器客户端不等于证明远端任务已停止；超时、取消或输出上限触发终止时，结果携带 `effectUnknown: true`，内核保留相应范围的未知写入阻塞，等待宿主对账。

`tests/verify-tool.test.ts` 用明确的合成执行器覆盖固定命令、重复结果、失败、取消、超时和报告解析；`tests/native-verification.test.ts` 用合成进程执行器检查原生沙箱配置传递。这两个文件在 2026-10-27 合计 16 项通过，不是外部后端可用性或全部项目回归的证据。另有 `tests/native-verification-smoke.test.ts` 的 1 项实机测试通过：在两个独立原生沙箱调用中运行 `node --test`，解析并比较 TAP 结果。本轮没有启动 WSL 或容器。

## Windows 测试运行兼容范围

Windows AppContainer 的 Node 子进程管道已由宿主句柄代理、原生插件及 Node 预加载适配层提供。宿主创建双向、重叠 I/O 管道，只向当前 Job 内的进程交付句柄。Node 继续负责 `spawn` 的流、退出通知以及 `fork` 的 JSON／advanced IPC 编解码，同步调用具有超时和 `maxBuffer`。这不是任意程序的通用管道改写，也不开放任意命名管道访问。

2026-10-27，`tests/windows-verification-compat.test.ts` 新增兼容路径已分别在真实 AppContainer 中通过：

- 异步子进程的标准输入、标准输出和标准错误传递。
- 同步捕获、非零退出、超时和输出限额。
- `fork` IPC 与 advanced 序列化。
- 缺失子进程可执行文件的错误返回与已分配流的关闭。
- Node 测试运行器的默认子进程隔离方式。
- 实际 Vitest 依赖及 fork 工作进程：普通算术用例使用 `--pool=forks --maxWorkers 1` 通过。

此前已验证的 `node --test --test-isolation=none` 和 `stdio: 'inherit'` 仍是可用路径，但不再是唯一的 Node 验证方式。上述结果只覆盖列出的 Node 版本和配置，不能推断所有 Vitest 进程池、任意原生程序或全部项目测试都已通过。本轮未启动 WSL／Docker，也未运行付费缓存实验。

## Windows 插件构建与资源上限

`npm run build` 在 Windows 上自动通过 `node-gyp` 编译插件，需要 MSVC C++ 构建工具、Windows SDK 和 Python。生成的 `dist/sandbox/windows/node-pipes.node` 随包分发。虽然插件使用 N-API，它还依赖 Node 的进程／管道包装与 libuv 的 Windows IPC 结构，因此精确绑定构建时的 Node／libuv 版本；更换 Node 后必须重新构建。插件缺失、版本不匹配或构建失败会明确报错，不静默降级。

资源上限独立于 Job 的内存和进程数限制：每次 `spawn` 最多申请 32 对管道，每次沙箱调用累计最多分配 8192 对；同步输入不得超过 16 MiB，`maxBuffer` 必须是 0–16 MiB 的有限值。超出支持范围明确拒绝；输出触及调用设定的捕获上限也不能被解释为完整成功结果。
