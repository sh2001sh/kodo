# Kodo 试用说明（面向新同事）

日期：2026-10-20 · 依据当前仓库副本实际读取的代码与文档编写。本报告为只读任务产物：**本文未执行任何验证命令**，所有"已通过"表述均引自项目文档声明的既有验证记录，未经本轮复核。

## 1. 目前能做什么

Kodo 是一个本地 Agent 内核 demo（`kodo-local` 0.1.0-alpha.0，private），不是完整产品。当前已实现：

- **非交互 CLI 与原生终端行输入**（`node dist/cli/index.js chat ...`），支持 `/decision`、`/next`、`/status`、`/cancel`、`/paste` 等命令（README.md:25）。
- **主／子代理协作**：主代理可用 `spawn_agent`、`cancel_agent`、`ask_user`；主／子均可用 `list_agents`、`send_message`、`wait_for_events`。子任务固定卡片版本与模型绑定，权限只能缩减（README.md:84）。
- **内置工具集**（src/tools/index.ts:20-29 定义）：`file.read`／`file.list`／`file.search`（只读）、`file.apply_patch`（基于预期 SHA-256 的原子写）、`artifact.write`／`artifact.read`（会话私有产物）、`history.read`（归档分页读取）、`process.exec`（需 `--allow-exec`，程序与参数数组分开，无 shell 字符串）。
- **三种模型协议**：`chat-completions`（默认）、`responses`、`anthropic`，经 `KODO_PROTOCOL` 或 `--protocol` 选择（README.md:53-61）。
- **预算与状态**：`--max-tokens`、`--max-model-calls`、`--timeout-ms` 等多项限制，主／子任务与后续运行共享会话预算（README.md:94）。

## 2. 上下文与写入恢复如何工作

**上下文压缩与追溯**（README.md:96）：上下文超限时，内核按完整模型／工具轮次压缩已完成历史，保留宿主规则、初始任务、用户输入与决定、未解决问题；原始上下文作为内容寻址快照保存，发出 `context.compacted` 事件并在当前上下文留下原文引用。`history.read` 仅允许读取已登记且归属允许的快照，按消息及字符游标分页。压缩为确定性裁减，不另调用模型；必要信息超限时返回 `CONTEXT_LIMIT` 而非静默删除。

**写入恢复**（README.md:125-127，examples/kernel-demo/README.md:10-22）：

1. 内部协作操作与结果同事务提交，可安全恢复；外部写操作已开始但结果未落库时标为 `unknown`，恢复返回 `UNKNOWN_WRITE` 并阻止同会话继续写入。
2. `reconcile` 比较文件补丁的实际 SHA-256、预期旧值及预期新值，能确认才记录已完成或未应用。
3. 无法自动核实的外部写入需 `resolve` 记录用户独立核实的具体依据（16 至 16000 字符，结果为 `succeeded`／`failed`／`not_applied`）；只有核实为未执行才允许 `--retry` 受控重试，没有强制重放开关。
4. 核实后 `resume` 继续中断运行，或为失败的 `UNKNOWN_WRITE` 运行创建恢复延续任务，沿用已确认结果与会话预算；原失败运行记录不变，重复恢复不重复执行。自动补偿尚未实现。

## 3. 尚未实现的产品能力

以下为文档声明未实现（README.md:7、docs/implementation-plan.md:15、24）：

- 完整能力包导入导出
- Skills 与 MCP（`src/mcp/` 目录尚不存在）
- 目录检索（discovery）与 Agent 搜索界面（SQLite trigram 已验证但无界面）
- 模型生成的语义摘要（当前压缩为确定性裁减）
- 本地 Web（P5 阶段）
- 任意 shell 字符串工具、多模态输入、供应商原生服务端工具、自动补偿

## 4. 可用的运行或验证命令（均来自 package.json:23-36 实际脚本定义）

```powershell
npm run check            # tsc --noEmit + eslint（类型与静态检查）
npm test                 # 先构建再 vitest run（本地测试，不调收费模型）
npm run demo:kernel      # 构建并运行确定性内核协作演示（脚本模型，无需模型服务）
npm run demo:kernel:recovery  # 长上下文压缩追溯与不确定写入恢复演示
node dist/cli/index.js doctor  # 构建后 CLI 自检
```

本报告未执行以上任何命令；如需验证，从 `npm run check` 与 `npm run demo:kernel` 开始。

## 5. 使用限制（引用真实文件）

1. **写入需显式授权且受未知写入阻塞**：运行默认只读，生成产物或改项目需 `--allow-write`（README.md:63）；存在未核实的 `unknown` 写入时，同数据目录中相同或父子嵌套工作目录的其他会话也不能绕过继续写入（README.md:125，对应 src/tools/index.ts:34-37 的 `assertWriteScope`）。
2. **`process.exec` 是高权限非沙箱执行**：仅在 `--allow-exec` 下可用，程序可访问宿主用户资源，应用层文件范围不能约束它；不支持任意 shell 字符串（README.md:88，src/tools/index.ts:28）。
3. **文件路径严格受限**：仅允许相对工作目录的 UTF-8 路径，禁止绝对路径、`..`、盘符及 `.git`／`.env`／私钥等保护路径，且检查符号链接逃逸（README.md:82，src/tools/index.ts:146-159）。
4. **单进程独占数据目录**：同一数据目录只允许一个进程拥有；崩溃遗留锁文件不会按文件年龄接管，需 `doctor --unlock` 且原进程确认退出（README.md:117-123）。
5. **平台与环境限制**：要求 Node.js 24（package.json:9 `"node": ">=24 <25"`）；首要验证平台为 Windows／PowerShell，其他操作系统尚未人工验证（README.md:29、161）。

## 6. 文档声明与实际验证的区分

- **文档声明、本轮未复核**：三协议真实验证 3/3 通过、回归 210 条测试通过（README.md:151、159）——这些是项目文档记录的历史结果，本报告未运行任何测试。
- **文档明确声明的失败记录**：本机 9B 真实任务主评估 **0/6 通过**（MODEL_BUDGET／MODEL_INCOMPLETE），定向修复 2/2、定向报告 0/2（docs/task-capability-evaluation.md:21-36）；真实模型下的跨文件调查与协作任务**尚不能可靠交付**，普通回归通过不代表真实任务成功（README.md:155）。
- **本报告实际做的**：仅读取 README.md、package.json、src/tools/index.ts、docs/implementation-plan.md、docs/task-capability-evaluation.md、examples/kernel-demo/README.md 并撰写本产物，未执行任何命令。

## 参考文件

- README.md（项目总览与命令）
- package.json（脚本与依赖）
- src/tools/index.ts（工具定义、权限与写锁实现）
- docs/implementation-plan.md（架构与阶段边界）
- docs/task-capability-evaluation.md（真实任务评估证据）
- examples/kernel-demo/README.md（演示流程与恢复检查点）
