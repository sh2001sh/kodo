# 内核协作演示

完整内核还包含长上下文原文追溯与不确定写入恢复，单独运行：

```powershell
npm run build
node "scripts/demo-kernel-recovery.mjs"
```

该脚本使用确定性供应商，执行真实文件工具、外部程序和 SQLite。它先用多轮文件读取触发上下文压缩，再通过 `history.read` 追溯归档链并找回随机原文标识。随后故意在外部程序已写入文件后丢失工具结果，验证未核实前无法恢复；独立读取文件后记录核实依据，再创建恢复延续任务，检查原失败任务及其不确定调用记录保持不变、外部副作用没有重复执行。最后验证文件补丁通过实际 SHA-256 自动核实，恢复时不重复应用。

数据默认保留于 `.kodo/kernel-recovery-demo-时间戳-随机后缀/`，完整证据为 `data/recovery-evidence.json`。此模式不调用真实模型，不把故障注入结果报告为模型能力。

实际任务遇到不确定写入时，可先检查自动核实结果：

```powershell
node "dist/cli/index.js" reconcile "RUN_ID" --json --data-dir "DATA_DIR"
node "dist/cli/index.js" resolve "RUN_ID" --call-id "CALL_ID" --outcome succeeded --evidence "已独立检查目标系统，确认操作成功且只发生一次。" --json --data-dir "DATA_DIR"
node "dist/cli/index.js" resume "RUN_ID" --json --data-dir "DATA_DIR"
```

`reconcile` 仅自动核实可验证的文件补丁，其他外部写入需要具体核实依据。`resolve` 的结果可为 `succeeded`、`failed` 或 `not_applied`；只有核实为未执行时才允许显式加 `--retry` 授权受控重试。依据须有 16 至 16000 个字符。两个核实命令均输出原调用、观察依据与恢复计划。核实本身不启动模型，`resume` 才继续执行。失败终态不会重新打开，恢复使用关联到原任务的新任务记录。

在项目根目录运行：

```powershell
npm run build
node "scripts/demo-kernel.mjs" --scripted
```

确定性模式使用脚本供应商，验证真实内核、SQLite、文件工具与消息调度；它不调用模型。每次生成随机证据文件，供应商必须从自己收到的 `file.read` 结果发现标识，不能预先获得标识。

演示包含：主任务创建两个独立上下文的子任务；A 直接提问 B；B 读取证据并写入、读取工件，然后直接回答 A；A 读取同一会话中的工件核验。主任务持久等待两个子任务结束后集中询问用户，脚本用 `Application.answer` 提供演示答案并更新决策。旧子任务的结果标为 `stale`，主任务审阅后结束。最后追加输入创建共享会话预算的延续任务，原终态保持不变。

使用已启动的本地 9B 服务：

```powershell
$env:KODO_MODEL = 'kodo-local-qwen35-9b'
$env:KODO_BASE_URL = 'http://127.0.0.1:18091/v1'
$env:KODO_API_KEY = 'local-not-required'
node "scripts/demo-kernel.mjs"
```

`local-not-required` 是无鉴权本地服务的占位值。连接需要鉴权的服务时，请在环境变量配置实际密钥。脚本不会启动或下载模型。真实模式由模型自行选择工具；任何缺失步骤、证据不符、失败或提前结束均退出 `1`，不会把确定性模式的结果报告为真实模型通过。

默认保留数据于 `.kodo/kernel-demo-时间戳-随机后缀/`，包含随机输入、SQLite、内容寻址结果，以及 `data/demo-evidence.json`。控制台输出任务 ID、消息、等待、调用状态、决策及 `PASS` 摘要。可指定目录：

```powershell
node "scripts/demo-kernel.mjs" --scripted --data-dir ".kodo/my-demo/data" --workspace ".kodo/my-demo/workspace"
```

失败时保留部分证据，并报告失败阶段。目录不会自动删除。运行使用单模型并发，最多 2 个子任务、30 次模型调用，每次输出上限 2048 token，总预算 200000 token，适配本地 9B 服务的单推理槽。

角色流程放在共享的演示任务卡中，主任务通过极短的 `DEMO_CHILD_A`、`DEMO_CHILD_B` 目标创建子任务，避免重复生成长参数。卡片约定每次响应只调用一个工具，明确区分运行 ID、问题 ID 与工件 ID。卡片包含本次随机输入文件名，因此每次演示注册独立卡片 ID，保留不可变版本语义。演示断言所有子任务模型请求均不包含主任务的私有上下文标记。

2026-10-19 已使用本地 `Qwen3.5-9B.Q6_K.gguf`、8192 上下文、单推理槽完成一次真实演示：18 次模型调用、14 次工具调用、50105 个实际计量 token，所有验收通过。B 曾将问题 ID 误用为消息目标，内核明确返回失败；模型随后查询同伴并修正，成功直接回答 A。该记录证明一次完整链路，不代表模型策略每次都成功；脚本会继续严格检查真实工具记录和随机证据。
