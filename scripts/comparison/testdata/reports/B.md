# Kodo 新同事试用说明（本地内核 demo）

> 证据来源：本次实际读取了 `README.md`、`package.json`、`src/tools/index.ts`、`src/runtime/history.ts`、`src/runtime/context.ts`。以下内容区分"文档声明"与"实际验证"；凡标注"未运行"的命令均未在本副本中执行，因此不宣称通过。

## 一、目前能做什么

依据 `README.md` 文档声明，本仓库是**完整本地内核 demo**，不是完整产品或公开 Beta。已声明的能力包括：

- 主代理／子代理共用执行循环，支持独立上下文、直接问答、持久等待、集中询问用户、决定变更（decision version）、会话共享预算。
- 工具集（在 `src/tools/index.ts` 中逐一定义并经 Ajv schema 校验）：
  - `file.read` / `file.list` / `file.search`（只读）
  - `file.apply_patch`（基于 `file.read` 返回的 SHA-256 `expectedHash` 做原子替换；新文件传 `null`；不创建父目录）
  - `artifact.write` / `artifact.read`（本会话私有产物）
  - `history.read`（分页读取已登记的上下文归档快照）
  - `process.exec`（仅 `--allow-exec`，程序与参数数组分开，无 shell 字符串）
- 三种模型协议（`chat-completions`、`responses`、`anthropic`），随运行与子任务持久绑定。
- 恢复机制：`inspect`、`resume`、`reconcile`、`resolve`、`continue`、`answer` 等 CLI 子命令；`doctor --unlock` 处理遗留锁。

## 二、上下文压缩与写入恢复如何工作

**上下文压缩**（已在 `src/runtime/context.ts` 中核实实现）：

- `buildContext` 是**确定性裁减**，不另调用模型：上下文超限（`maxContextChars`）时按完整的"assistant 调用 + 相邻 tool 结果"轮次分组压缩已完成的旧历史。
- 永久保留：系统消息（宿主规则）、前两条用户输入（含初始任务）、来自用户的输入、未回答的问题。
- 原始上下文以内容寻址快照（`HistorySnapshot`，含 `runId`/`sessionId`/`previousRef`）保存，发出 `context.compacted` 事件，当前上下文留下含 `archivedRef` 的引用标记及短摘录。
- 必要信息或工具 Schema 本身超限时返回 `CONTEXT_LIMIT` 错误，不静默删除约束。

**原文追溯**（已在 `src/runtime/history.ts` 中核实实现）：

- `history.read` 只允许读取**已由持久 `context.compacted` 事件登记、且归属允许的快照**（本运行谱系或主代理管理的子运行），任意 blob 不暴露。
- 快照的 `runId`/`sessionId` 必须与持久索引匹配，否则 `HISTORY_DENIED`。
- 支持消息偏移、字符偏移（长消息分片）、分页与 `previousRef` 回溯。

**写入恢复**（文档声明 + `src/tools/index.ts` 中的机制核实）：

- 内部协作操作与结果同事务提交，可安全恢复；外部写操作（如 `file.apply_patch`）已开始但结果未落库时标为 `unknown`，恢复返回 `UNKNOWN_WRITE` 并阻塞同会话（及相同/嵌套工作目录的其他会话）继续写入。
- 写操作在本进程内串行（`writeTail` 队列）。
- `reconcile` 通过 `probePatchForRecovery` 比较文件实际 SHA-256、预期旧值与新值，能确认才记录。
- `resolve` 记录用户独立核实的依据（16–16000 字符）；仅明确核实为未执行时才允许 `--retry` 受控重试；核实后 `resume` 创建恢复延续任务，沿用已确认结果与会话预算。自动补偿尚未实现。

## 三、尚未实现的产品能力（文档声明，未验证）

依据 `README.md`：

- 完整能力包导入导出、Skills／MCP、目录检索、模型生成的语义摘要、本地 Web 界面。
- 内核已验证 SQLite 中文 trigram 能力，但**没有 Agent 搜索界面**。
- 多模态输入、供应商原生服务端工具暂不支持。
- 任意 shell 字符串工具（`process.exec` 只接受程序 + 参数数组）。
- 自动补偿（写冲突自动回滚）尚未实现。
- 未向公开 npm 仓库发布（包名 `kodo-local`，`private: true`，`UNLICENSED`，见 `package.json`）。
- Windows 中文输入法、其他操作系统尚未人工验收。

## 四、当前项目支持的运行/验证命令（来自 `package.json` 的 `scripts`，本次未运行）

1. `npm run check` — TypeScript 类型检查 + ESLint（`tsc --noEmit` + `eslint src tests scripts`）。
2. `npm test` — 先构建再执行全部本地测试（不调用收费模型）。
3. `npm run demo:kernel` — 使用脚本模型的内核演示，实际执行 SQLite、文件工具、产物与完整协作循环，无需模型服务。
4. `npm run demo:kernel:recovery` — 恢复演示：长上下文压缩后找回随机原文、不确定外部写入核实后恢复。
5. `npm run test:integration` — 集成测试（存储、运行时、工具、协作、恢复、上下文等）。

注：`npm test` 等命令依赖 `npm run build`（`tsc -p tsconfig.build.json`）产出的 `dist/`；本副本由宿主提供依赖，无需 `npm ci`。

## 五、使用限制（至少两条，引用真实文件路径）

1. **文件大小与类型限制**：`src/tools/index.ts` 的 `readText` 拒绝超过 64 KB 的文件（`FILE_SIZE`）和非 UTF-8 或含空字节的二进制内容（`FILE_ENCODING`）；`file.list` 每目录最多 200 条；`file.search` 最多访问 1000 个路径、返回 30 条匹配，且跳过隐藏目录、`node_modules`、`dist`、`coverage`。
2. **路径保护与工作目录边界**：`src/tools/index.ts` 的 `resolvePath` 要求相对路径，拒绝绝对路径、`..`、`.git`/`.kodo`/`.env`/私钥等受保护部分、解析后逃逸工作目录的符号链接，以及运行时数据目录本身。
3. **写操作授权与阻塞**：`src/tools/index.ts` 中所有写效果工具先经 `assertWriteScope` 检查——同一会话（或相同/嵌套工作目录）存在未核实的 `UNKNOWN_WRITE` 时全部写入被阻塞；`file.apply_patch` 需与 `file.read` 返回的哈希匹配，且在决定版本变更（`DECISION_CHANGED`）时拒绝提交。
4. **产物与会话隔离**：`artifact.write`/`artifact.read` 仅限本会话（`README.md`：不同会话不能互读）；`history.read` 只能读已登记快照。
5. **`process.exec` 是高权限非沙箱**（`README.md`）：仅在 `--allow-exec` 下可用，程序可访问宿主用户资源，应用层文件范围不能约束它；子进程环境移除密钥类环境变量但不等于宿主隔离。

## 六、证据与事实检查说明

- 实际读取的文件：`README.md`（整体能力与限制声明）、`package.json`（脚本、依赖、Node 24 要求）、`src/tools/index.ts`（工具定义、路径保护、写串行、恢复探查）、`src/runtime/context.ts`（确定性压缩实现）、`src/runtime/history.ts`（归档读取与归属校验）。
- 本报告**未执行**任何验证命令，因此上文第四节所列命令均标注"未运行"，不存在"测试已通过"的断言。
- `README.md` 中的历史验证数字（如 3/3 协议通过、真实任务评估结果）均为文档声明，本副本未复跑。
