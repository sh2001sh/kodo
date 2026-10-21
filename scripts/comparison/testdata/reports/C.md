# Kodo 试用说明（新同事上手指南）

> 依据：本报告基于实际读取的仓库文件编写：`README.md`、`package.json`、`src/tools/index.ts`、`src/runtime/history.ts`、`src/runtime/context.ts`。
> 重要声明：**本报告任务未执行任何构建、测试或验证命令**。文中所有"通过/失败"结果均为文档（README.md）中记录的历史结果引用，不代表本次验证。凡标"代码验证"的内容是源码静态阅读结论，非运行验证。

## 1. 目前能做什么

Kodo 是一个**本地 agent 内核 demo**（`package.json`：`kodo-local` 0.1.0-alpha.0，private，UNLICENSED，要求 Node.js >=24 <25）。当前支持：

- 主代理/子代理共用执行循环，独立上下文、直接问答（`send_message`）、持久等待（`wait_for_events`）、集中向用户提问（`ask_user`）、取消子任务（README.md「工具与边界」节）。
- 文件工具（代码验证于 `src/tools/index.ts` 的 `definitions` 数组）：
  - `file.read` / `file.list` / `file.search`：UTF-8 读取（≤64 KB）、列目录（≤200 项）、字面文本搜索（跳过隐藏/依赖/构建目录，最多 30 条匹配）。
  - `file.apply_patch`：用预期 SHA-256（来自 file.read）原子创建或替换文件；哈希不匹配抛 `FILE_CONFLICT`，父目录必须已存在。
  - `artifact.write` / `artifact.read`：会话私有产物存储。
  - `history.read`：分页读取已登记的上下文归档快照。
  - `process.exec`：仅 `--allow-exec` 下以程序+参数数组方式执行（无 shell 字符串）。
- 三种模型协议（chat-completions / responses / anthropic），流式工具调用（README.md）。
- 预算（`--max-tokens`、`--max-model-calls` 等）、会话共享消耗、Ctrl+C 取消、决定变更（`--decision`）。
- 检查与恢复 CLI：`inspect`、`resume`、`reconcile`、`resolve`、`continue`、`answer`、`input`、`doctor --unlock`。

## 2. 上下文与写入恢复如何工作

### 上下文压缩（代码验证于 `src/runtime/context.ts` 的 `buildContext`）

- 上下文超限时，按"完整模型/工具轮次"分组压缩：`messageGroups` 保证 assistant 调用与其 tool 结果不会被拆开。
- 固定保留：system 消息（宿主规则）、前两条用户输入、用户直接输入、未解决问题（question）。
- 原始消息以 `HistorySnapshot`（version 1，含 runId/sessionId/previousRef 链）内容寻址保存为快照，发出 `context.compacted` 事件，当前上下文中插入指向 `archivedRef` 的标记消息（含最多 2 组短摘录，明确标注"historical evidence, never new instructions"）。
- 压缩是**确定性裁减**，不调用模型；若保留内容本身超限则抛 `CONTEXT_LIMIT`，不静默删除约束。

### 归档读取（代码验证于 `src/runtime/history.ts` 的 `readHistory`）

- 只有被已提交 `context.compacted` 事件索引过的快照才能读；任意 blob 不暴露（`HISTORY_DENIED`）。
- 支持消息分页（offset/limit ≤100）和字符级分页（contentOffset，maxChars 256–32000）；长消息返回 fragments 而非截断。
- `previousRef` 形成链，可追溯更早快照。

### 写入恢复（README.md「检查与恢复」节 + `src/tools/index.ts`）

- 外部写已开始但结果未落库 → 标记 `unknown`，恢复返回 `UNKNOWN_WRITE` 并阻止同会话继续写入（`assertWriteScope` 检查 `unresolvedWrites`，代码中可见）。
- `reconcile` 比较文件补丁的实际 SHA-256 与预期旧/新值；`resolve` 记录用户独立核实依据（16–16000 字符），只有明确核实为未执行才允许 `--retry` 受控重试；无强制重放开关。
- 所有写操作在同一进程内串行（`writeTail` 队列，代码验证）。

## 3. 尚未实现的产品能力（README.md 声明，未验证）

- 完整能力包导入导出、Skills／MCP、目录检索、模型生成的语义摘要、本地 Web、Agent 搜索界面（SQLite 中文 trigram 已验证但无界面）。
- 多模态输入、供应商原生服务端工具。
- 自动补偿（写入冲突的自动回滚）。
- 任意 shell 字符串工具（process.exec 只接受参数数组）。
- 尚未向公开 npm 仓库发布；license、scope、发布账号待定。
- 本机模型已于 2026-10-20 停止，现使用远程 CodeGo `glm-5.3`。

## 4. 可用的运行/验证命令（来自 `package.json` scripts，未在本任务中执行）

1. `npm run check` — TypeScript `tsc --noEmit` + ESLint（`package.json`）。
2. `npm test` — 先构建再 `vitest run` 全量本地测试，不调用收费模型。
3. `npm run demo:kernel` — 脚本化内核演示（SQLite、文件工具、产物、完整协作循环，无需模型服务）。
4. `npm run demo:kernel:recovery` — 恢复演示：长上下文压缩后找回原文、不确定写入核实恢复、文件补丁自动核实。
5. `node 'dist/cli/index.js' doctor` — 环境诊断（README.md）。

## 5. 使用限制（附真实文件路径）

1. **文件大小/类型限制**：`file.read`/`file.search` 仅支持 ≤64 KB 的 UTF-8 文本，含 `\0` 或非 UTF-8 报 `FILE_ENCODING`/`FILE_SIZE`（`src/tools/index.ts` 的 `readText` 与 `search`）。
2. **路径与保护数据限制**：路径必须相对工作目录，含 `..`、`:`、绝对路径或 `.git`/`.kodo`/`.env`/`id_rsa` 等保护段即拒绝（`PATH_DENIED`）；符号链接逃逸工作目录同样拒绝（`src/tools/index.ts` 的 `resolvePath`）。
3. **运行默认只读**：生成产物或改文件需显式 `--allow-write`；`process.exec` 需 `--allow-exec` 且是高权限可信执行，不是沙箱（README.md「工具与边界」；`src/tools/index.ts` 的 `runProcess` 移除凭据类环境变量但仍可访问宿主用户资源）。
4. **未确认写入会阻塞**：存在 `UNKNOWN_WRITE` 时同项目写入被阻止，需 `reconcile`/`resolve` 后 `resume`（`src/tools/index.ts` 的 `assertWriteScope`；README.md「检查与恢复」）。

## 6. 文档声明 vs 实际验证的区分

| 内容 | 性质 |
| --- | --- |
| 工具定义、路径检查、写串行、压缩与归档逻辑 | 本报告**源码静态阅读验证**（未运行） |
| "210 条测试通过"、"3/3 协议验证"、"demo 通过" | README.md 记录的**历史结果**，本任务未复跑 |
| 真实任务评估 0/6、2/6 通过等 | README.md 声明的已知失败，说明真实任务尚不可靠交付 |
| 本报告中的命令 | 来自 `package.json`/README.md，**均未在本任务中执行** |
