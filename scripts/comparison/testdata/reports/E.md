# Kodo 新同事试用说明

面向刚加入项目的同事，基于当前仓库副本（kodo-local 0.1.0-alpha.0）编写。本说明区分**文档声明**与**本次实际验证**：本次任务只做了文件读取与代码核对，**没有运行任何测试或验证命令**，因此不把任何测试写成"已通过"。

## 一、当前能做什么（依据 README.md 与 src/ 代码结构）

Kodo 目前是一个**完整本地内核 demo**，不是完整产品或公开 Beta（README.md 第 3 行明确声明）：

- 单一执行循环同时驱动主代理与子代理，支持独立上下文、直接问答、持久等待、集中向用户提问（仅主代理可用 ask_user）、会话共享预算与取消。
- 非交互 CLI（`dist/cli/index.js`）与原生终端行输入的 chat 模式；`src/` 下有 agents、application、cli、messaging、providers、runtime、storage、tools 目录，与文档描述一致。
- 模型协议：Chat Completions、Responses、Anthropic Messages 三种，均流式（README"工具与边界"章节；src/providers/ 存在对应实现目录）。
- 内置工具：file.read / file.list / file.search / file.apply_patch（SHA-256 期望哈希的原子替换）、artifact.write / artifact.read、history.read，process.exec 仅在 `--allow-exec` 下可用（README"工具与边界"表）。
- 本任务实际读过的源码证据：
  - `src/runtime/context.ts` 中的 `buildContext` 实现**确定性上下文压缩**：超限时按完整 assistant/tool 轮次裁减，固定保留 system 规则、初始任务、前两条用户输入、来自用户或未答复问题的信封消息；把原文整体保存为内容寻址快照（HistorySnapshot），并在当前上下文插入带 `ref` 的追溯标记与最近两条 120 字符摘录；无法进一步压缩时抛出 `CONTEXT_LIMIT`。压缩不调用模型。
  - `src/runtime/recovery.ts` 中的 `RecoveryManager` 实现**有证据的写入恢复**：`inspect` 只对 `file.apply_patch` 有自动核实器（比对实际 SHA-256 与预期新旧值，得出 succeeded / not_applied，否则保持阻塞）；其他外部写入要求用户提供 16–16000 字符的独立核实依据（`resolve`）；核实结论以不可覆盖的 `recovery.resolved` 事件提交，冲突结论拒绝写入；终态运行永不重开，失败 UNKNOWN_WRITE 走延续运行。

## 二、上下文与写入恢复如何工作

**上下文**：见上文 `src/runtime/context.ts` 的 `buildContext`。要点：

1. 大小按 `JSON.stringify({messages, tools})` 计；未超限原样返回。
2. 超限时保留宿主规则、初始任务、用户约束/决定、未解决问题；已完成旧轮次整体删除，不做跨轮切断。
3. 被删原文存为版本化快照并链式保留 `previousRef`；模型通过 `history.read` 分页取回原文（仅限归属允许的快照）。
4. 必要输入或工具 Schema 本身超限 → `CONTEXT_LIMIT` 错误，不静默删约束（README"预算、状态与取消"章节，与源码一致）。

**写入恢复**：见 `src/runtime/recovery.ts` 与 README"检查与恢复"章节：

- 进程崩溃后遗留 `running` 标为 `interrupted`；外部写已开始但结果未落库时标 `unknown`，恢复返回 `UNKNOWN_WRITE` 并阻止同会话（含相同/嵌套工作目录的其他会话）继续写入，只读调查仍允许。
- `reconcile` / `Application.reconcile`（CLI `reconcile`）自动核实文件补丁；外部进程写入无自动验证器，必须 `resolve` 提供人工证据。
- 恢复执行 `resume`：中断运行继续原步骤；已失败 UNKNOWN_WRITE 创建恢复延续任务，复制已核实的调用结果，原运行不变；重复恢复同一来源拒绝再次复制。
- 自动补偿尚未实现（README 明示）。

## 三、尚未实现的产品能力（文档声明，均未验证）

来自 README 第 5 段与 `docs/implementation-plan.md` 第 1 节：

- 完整能力包导入导出（P3 目标）
- Skills 与 MCP（`src/` 下无 mcp、discovery 目录，与"尚未实现"一致；implementation-plan.md §2 目录规划中标注"MCP 测试在实现该功能后再加入"）
- 目录检索（FTS5 检索路由）
- 模型生成的语义摘要（当前只有确定性压缩，见 src/runtime/context.ts）
- 本地 Web（P5）
- 自动补偿、任意 shell 字符串工具、多模态输入、供应商原生服务端工具
- Windows 中文输入法（需用户实际终端人工验收）、macOS/Linux 平台
- 公开发布（npm scope、许可证、发布账号待确认）

## 四、当前项目确实支持的运行/验证命令

以下命令在 `package.json` scripts 与 README 中均有定义（本次未运行）：

```powershell
npm run check                        # tsc --noEmit + eslint src tests scripts
npm test                             # 先构建再 vitest run，本地确定性测试，不调收费模型
npm run demo:kernel                  # 脚本模型的内核协作演示（无需模型服务）
npm run demo:kernel:recovery         # 压缩找回原文 + 不确定写入核实恢复演示
node 'dist/cli/index.js' --version   # 构建后 CLI 版本（需先 npm run build）
node 'dist/cli/index.js' doctor      # 数据目录诊断
npm run test:provider                # 需真实 KODO_MODEL 与凭据；缺配置返回非零
```

需要真实模型凭据的命令（test:provider、test:protocols、eval:tasks、demo:kernel:local）在配置缺失时会明确报错，不会静默替换为脚本模型。

## 五、使用限制（至少两条，附真实文件路径）

1. **默认只读，写入需显式授权**：运行默认只读，生成产物或修改项目需 `--allow-write`；process.exec 需更高权限的 `--allow-exec`，且是可信执行、可访问宿主用户资源（README.md "工具与边界"章节）。授权只能缩减不能动态提升（README.md "预算、状态与取消"章节）。
2. **未知写操作会阻塞会话，无自动补偿**：外部写开始但结果未落库时，同会话及相同/嵌套工作目录的其他会话不能继续写入，必须经 `reconcile` 或 `resolve` 提供独立核实证据；自动补偿尚未实现（README.md "检查与恢复"章节；src/runtime/recovery.ts `uncertain`/`commit` 逻辑印证）。
3. **单一数据目录所有权**：同一数据目录只允许一个进程拥有；崩溃后遗留锁文件不会按年龄自动接管，需确认原进程退出后 `doctor --unlock`（README.md "检查与恢复"章节）。
4. **平台与输入法限制**：要求 Node.js 24（package.json engines `>=24 <25`），首要验证平台为 Windows/PowerShell；Windows 中文输入法及 macOS/Linux 尚未人工验证（README.md "开发运行"章节）。
5. **依赖宿主提供的依赖**：本副本由宿主提供同版本依赖，无需也不应 `npm ci` 安装（START_HERE.md；package.json devDependencies 锁定具体版本）。

## 六、事实核查说明

- 实际读取的文件：README.md、package.json、docs/implementation-plan.md、src/runtime/context.ts、src/runtime/recovery.ts、src/ 与 docs/ 目录列表。
- 文档声明但本次未运行验证的：所有测试结果（如 README 记载的"14 个测试文件、210 条测试通过"是 2026-10-20 的历史记录，不代表本副本当前状态）、demo 命令行为、远程 API 验证结论。使用前请自行运行 `npm test` 等命令确认。
- README 提醒：模型输出"完成"只表示该运行结束，验收仍需查看实际证据。
