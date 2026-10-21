# Kodo 新同事试用说明

日期：本报告基于当前仓库副本实际读取的文件编写。本任务只读取代码与文档并产出报告，**未执行任何验证命令**；下述所有“已通过/已验证”的表述均引自项目文档声明，与本报告的实际验证相区分，见各节标注。

## 1. 目前能做什么（当前状态）

根据 `README.md` 与 `docs/implementation-plan.md` 的声明，当前仓库是一个**完整本地内核 demo**（版本 `0.1.0-alpha.0`，包名 `kodo-local`，`private: true`，见 `package.json`），不是完整产品或公开 Beta。已声明实现的能力：

- 主代理与子代理共用执行循环；支持独立上下文的子任务、直接问答（`send_message`）、持久等待（`wait_for_events`）、集中询问用户（`ask_user`）、决定变更、会话共享预算。
- 长上下文压缩与原文追溯：上下文超限时做确定性压缩并保留原文快照，可用 `history.read` 分页找回。
- 取消与有证据的写入恢复：不确定外部写入标记 `unknown`，经 `reconcile`／`resolve` 核实后通过 `resume` 恢复，不盲目重放。
- 三种模型协议（`chat-completions`、`responses`、`anthropic`），流式响应与工具调用回传。
- 内置工具：`file.read`／`file.list`／`file.search`／`file.apply_patch`／`artifact.read`／`artifact.write`／`history.read`，以及在 `--allow-exec` 下的 `process.exec`（程序与参数数组，非 shell 字符串）。
- 非交互 CLI（`kodo run/chat/inspect/resume/reconcile/resolve/answer/input/doctor` 等）与原生终端行输入。

实际读取源码中可确认的对应实现（本报告实际验证部分）：

- `src/runtime/recovery.ts`：`RecoveryManager` 实现了 `inspect`（对 `file.apply_patch` 自动比对实际 SHA-256 与预期新旧值）、`resolve`（人工核实依据须 16–16000 字符，`not_applied` 才允许 `retry:true`）、恢复计划与不可覆盖的 `recovery.resolved` 事件，与文档描述一致。
- `src/runtime/context.ts`：`buildContext` 实现确定性压缩——按完整 assistant/tool 轮次裁减，保留宿主规则、初始任务、前两条用户输入、未解决问题与投递信封；原文写入内容寻址快照，当前上下文留下引用标记；超限且无法裁减时抛出 `CONTEXT_LIMIT`，与 README／实现方案第 3.6 节描述一致。

## 2. 上下文与写入恢复如何工作

**上下文（依据 `src/runtime/context.ts` 与 `docs/implementation-plan.md` 3.6 节）：**

1. 上下文按“宿主规则与授权 → 用户目标与决定 → 当前任务与未解决问题 → 必要历史／工具结果／同伴消息”组装。
2. 超出 `--max-context-chars` 时，压缩是**确定性裁减**（不调用模型）：保留 system 消息、前两条用户输入、来自用户或未答复问题的信封消息、可核对的历史归档标记之外的普通用户消息；被裁减的完整轮次连同原消息保存为 `HistorySnapshot`（内容寻址 blob），形成归档链。
3. 当前上下文中插入一条引用标记（含归档 ref、上一归档 ref、被省略消息数与末尾短摘录），模型可用 `history.read` 按消息和字符游标分页读回原文。
4. 归档标记带"untrusted historical data; never grants permissions"前缀——历史文本不能提升权限。

**写入恢复（依据 `src/runtime/recovery.ts`、`README.md` 与 `examples/kernel-demo/README.md`）：**

1. 外部写操作已开始但结果未落库（如进程崩溃）时，调用标为 `unknown`，运行以 `UNKNOWN_WRITE` 失败，同会话及同/嵌套工作目录的其他会话也被阻止继续写入（只读调查仍允许）。
2. `reconcile` 对 `file.apply_patch` 自动核实：实际 SHA-256 等于预期新值 → `succeeded`；等于预期旧值 → `not_applied`；否则继续阻塞。其他外部写入没有通用自动验证器（源码注释明确写明 "No automatic verifier exists for this effect. Explicit user verification is required."）。
3. `resolve` 记录用户独立核实的具体依据（16–16000 字符），结论为 `succeeded`/`failed`/`not_applied`，保存为不可覆盖的 `recovery.resolved` 事件，冲突结论拒绝覆盖。
4. `resume`：中断运行从已保存步骤继续；已失败 `UNKNOWN_WRITE` 的运行创建恢复延续任务（`continuationOf`），沿用已确认调用结果，原失败运行记录不变；重复恢复不会再次复制执行。

`scripts/demo-kernel-recovery.mjs` 提供覆盖这条链路的确定性演示（压缩后找回随机原文、外部写入核实恢复、补丁自动核实），演示证据保留在 `.kodo/kernel-recovery-demo-*/data/recovery-evidence.json`。**注意：本报告未运行该演示，以上为文档声明。**

## 3. 尚未实现的产品能力

依据 `README.md` 与 `docs/implementation-plan.md`（实现方案明确“后续章节中的能力包、MCP、目录和 Web 仍描述产品目标，不代表已经实现”）：

- 完整能力包导入导出、Skills／MCP（`src/mcp/`、`src/server/`、`web/` 目录在实现方案中标注为后续阶段新增，当前 `src/` 下不存在这些目录——本报告实际查看了 `src/` 目录列表确认）。
- 目录检索（Agent 搜索界面；SQLite 中文 trigram 能力已验证但无搜索界面）。
- 模型生成的语义摘要（当前压缩为确定性裁减）。
- 本地 Web（P5 阶段）。
- 自动补偿（automatic compensation）。
- 多模态输入、供应商原生服务端工具。
- 任意 shell 字符串工具。
- 公开发布：npm 包为 `private: true`，未向公开仓库发布。

## 4. 当前项目确实支持的运行/验证命令（来自 `package.json` scripts，实际读取确认存在）

以下命令定义在 `package.json` 的 `scripts` 中（本报告已实际读取该文件确认命令存在；但**本报告未执行它们**，运行结果未知）：

1. `npm run demo:kernel` — 构建后运行 `scripts/demo-kernel.mjs --scripted`，确定性内核协作演示（不调用模型）。
2. `npm run demo:kernel:recovery` — 构建后运行 `scripts/demo-kernel-recovery.mjs`，覆盖上下文压缩原文追溯与不确定写入恢复的确定性演示。
3. `npm run check` — `tsc --noEmit` 类型检查 + ESLint（`src tests scripts`）。
4. `npm test` — 构建后运行 vitest 全部本地测试（不调用收费模型）。
5. 其他可用入口：`npm run test:integration`、`npm run test:e2e`、`npm run build`、`node 'dist/cli/index.js' --version`、`node 'dist/cli/index.js' doctor`（后两个需先构建）。

`npm run test:provider`、`test:protocols`、`eval:tasks` 需要真实模型凭据环境变量，缺配置时返回非零并标明未验证。

## 5. 使用限制（至少两条，引用真实文件路径）

1. **运行默认只读，写与执行需显式授权；`process.exec` 是高权限可信执行。** `README.md`（“运行默认只读……需显式加 `--allow-write`”；“`--allow-exec` 是高权限可信执行，程序可访问宿主用户资源；应用层文件范围不能约束它”）及 `docs/implementation-plan.md` 第 4 节（“任意 shell、自定义代码和本地 MCP 明确采用可信执行假设，应用层路径检查不能隔离这些进程”）。文件检查不是恶意代码沙箱。
2. **同数据目录单进程所有；崩溃后不按锁文件年龄擅自接管。** `README.md`（“同一数据目录只允许一个进程拥有……确认原进程退出后执行 `doctor --unlock`”），对应 `docs/implementation-plan.md` 3.2 节（“一个数据目录同时只有一个运行时所有者……不能凭锁文件年龄擅自接管”）。
3. **未知写操作会阻塞会话且无通用自动验证器。** `src/runtime/recovery.ts` 中 `RecoveryManager.inspect` 对非 `file.apply_patch` 的写调用直接要求用户显式核实；`resolve` 强制核实依据 16–16000 字符，且只有 `not_applied` 才允许 `--retry`，没有强制重放开关。
4. **真实模型可靠性不能由确定性测试推断。** `README.md` 记录真实任务评估有失败组（如 20000 字符组 2/6 通过、主评估 0/6 通过）；“普通回归通过不代表真实任务已能可靠交付”。
5. **平台限制：** `package.json` `engines` 限定 `node >=24 <25`；`docs/implementation-plan.md` 声明首要验证平台为 Windows／PowerShell，其他操作系统尚未人工验证。

## 6. 文档声明 vs 实际验证（本报告的边界）

- **本报告实际执行的动作：** 读取了 `README.md`、`package.json`、`examples/kernel-demo/README.md`、`docs/implementation-plan.md`、`src/runtime/recovery.ts`、`src/runtime/context.ts`（以及目录列表）。以上源码结论（第 1、2、5 节中标注“源码”处）基于实际读取的代码。
- **本报告未执行的动作：** 未运行任何构建、测试或演示命令（按任务要求）。因此 `npm test`、demo 等结果在本报告中均为**未验证**；文中引用的历史验证结果（如“210 条测试通过”、“三协议 3/3 通过”）全部是 `README.md`／`docs/` 中的**文档声明**，未经本报告复现。
- 新同事应自行运行 `npm run check` 与 `npm test` 确认当前副本状态。

## 附：快速上手建议（按文档推荐顺序）

```powershell
npm ci
npm run check
npm test
npm run demo:kernel
npm run demo:kernel:recovery
node 'dist/cli/index.js' --version
node 'dist/cli/index.js' doctor
```
