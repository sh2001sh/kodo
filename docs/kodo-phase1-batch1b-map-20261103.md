# Kodo 阶段 1 批次 1b 删除地图：隔离检出与集成

- 快照：HEAD `65b2c23`（`docs: record batch 1a results and adoption-gate correction`），工作区干净；只读分析，未改源码/测试/文档，未 commit。
- 依据：`docs/kodo-final-positioning-20261103.md:138`（1b = 隔离检出与集成，计划约 1,156 行）、`docs/kodo-subtraction-plan-20261103.md:69`。
- 实测规模：`src/runtime/execution-*.ts` 现有 **10 个文件、1,141 行**（1a 合并已顺带删掉约 15 行，故比计划表少 15）。其中真正删除 **9 个文件 802 行**，`execution-workspace.ts` 与 `execution-snapshot.ts` 拆分保留（见 §1.2）。加上外围调用点，**源码净删约 1,050 行**；关联测试整删 955 行、改写 5 个文件、新增约 100–120 行。
- 结论：可以整批删除，无外部（web/TUI/cases/CLI）直接依赖；唯一不可拆的是"删除 `workspace.commit`/`workspace.integrate` 工具定义 + 卡片工具列表 + 子系统文件 + `Run.execution` 类型"必须在同一步完成，否则 `parseCard` 在模块加载期直接失败（见 §5 步骤 2）。

---

## 1. 逐文件清单

### 1.1 整体删除（9 文件，802 行）

| 文件 | 行数 | 职责 | 关键导出（行） | 外部消费者（删除后无） |
|---|---:|---|---|---|
| `src/runtime/execution-checkout.ts` | 67 | 快照检出（clone/pinned ref）与 `takeExecutionSnapshot` | `prepareSnapshotCheckout:33`、`takeExecutionSnapshot:63` | 仅 execution-* 与测试 |
| `src/runtime/execution-integrate.ts` | 197 | 文件级 integration plan（pre/post image、staging、apply/reconcile） | `IntegrationPlan:13`、`planIntegration:106`、`applyIntegrationPlan:166`、`reconcileIntegration:182` | 仅 execution-integration/tool-paths/lean 与测试 |
| `src/runtime/execution-integration.ts` | 195 | 宿主侧集成调用、恢复与 verifier 装配 | `integrateDeliveryPlan:45`、`prepareIntegration:66`、`integrateNode:100`、`plannedIntegration:107`、`recoverHostCalls:154`、`integrationVerifier:185` | 仅 tool-paths/cases? 无；测试 |
| `src/runtime/execution-lean.ts` | 115 | 仅 lean-session 的快照/commit/release/cleanup 编排 | `snapshotExecution:15`、`snapshotForChild:26`、`hostCommitChild:69`、`releaseChildCheckout:95`、`cleanupSessionCheckouts:108` | 仅测试/执行子系统 |
| `src/runtime/execution-retention.ts` | 69 | 删除 checkout 目录与 `refs/kodo/snapshots/*` | `releaseExecutionCheckout:36`、`cleanupSessionExecutions:47` | 仅测试/执行子系统 |
| `src/runtime/execution-tool-paths.ts` | 57 | `workspace.commit`/`workspace.integrate` 的模型工具实现与恢复 verifier | `commitSnapshotWorkspace:14`、`integrateSnapshotDelivery:26`、`executionVerifier:53` | 仅 `tools/index.ts:37` |
| `src/runtime/execution-host-calls.ts` | 63 | host 调用记录（事务化 tool record）与快照子运行校验 | `WorkspaceLocks:7`、`HostCallName:12`、`openHostCall:21`、`finishHostCall:41`、`snapshotChild:59` | 仅执行子系统 |
| `src/runtime/execution-admission.ts` | 39 | 首次 admit 前创建/丢弃 checkout，注入 execution context | `executionContext:7`、`preparePendingExecution:12` | `coordinator.ts:27,109`、`messaging/index.ts:11,412` |
| **合计** | **802** | | | |

补充：`host.execution.commit|integrate`、`host.task.check` 三个 host call 名只由本子系统产生；`host.task.check` 的生产者已在 1a 删除，`recoverHostCalls:155` 只是过滤它。整删后无需保留 host-call 记录设施。

### 1.2 拆分保留（2 文件：只删隔离检出部分）

#### `src/runtime/execution-workspace.ts`（151 行 → 约 55 行）

**保留**（均为跨子系统基础设施，删除后仍有调用方）：

| 导出 | 行 | 保留理由 |
|---|---|---|
| `runWorkspace` | 11-14 | 应用/CLI/messaging/tools/context/completion/inspection/instruction-layer/method-stage/tool-step 共 30+ 处；**改造**：删掉 `current.execution?.root ??` 分支，直接返回 `store.session(current.sessionId).workspace` |
| `executionSession` | 16-19 | 5 个模块调用；**改造**为 `store.session(run.sessionId)`（保留函数名可把改动压到 0 处调用点；若 1e 仍只剩空壳可再删） |
| `git` | 22-29 | `workspace-git.ts:46/52/66-68/86/101-116/134-166` 全部 Git 交付依赖 |
| `protectedPart` / `protectedPath` | 31-33 | `workspace-git.ts:6` 导入 `protectedPath`（提交/集成路径保护） |
| `changedExecutionFiles` | 36-41 | `workspace-git.ts:6` 导入（`workspace.git commit` 的变更集） |
| `executionFileViolation` | 44-52 | `workspace-git.ts:6` 导入（提交前的 scope/protected/非普通文件校验） |
| `WorkspaceLocks` | 7-10（旧 host-calls） | 不保留：随 host-calls 删除 |

**删除**：`commitExecutionWorkspace:55-71`（仅 `tools/index.ts:553` legacy 分支）、`createExecutionWorkspace:74-97`（仅 admission）、`discardExecutionWorkspace:99-103`（仅 admission）、`assertManagedExecutionRoot:105-109`（仅 checkout/retention）、`ExecutionDelivery:111-114` / `executionDelivery:117-143` / `applyExecutionDelivery:146-151`（仅 `tools/index.ts:555-560` 与 integration）。

**导入整理（1-8 行）**：保留 `spawnSync`、`lstatSync`、`path`、`Store`、`KodoError`、`Run/Session`、`assertFileScope`；删除 `existsSync`、`mkdirSync`、`realpathSync`、`rmSync`、`terminal`、`managedChild`。

#### `src/runtime/execution-snapshot.ts`（188 行 → 迁移出约 95 行，文件本身删除）

**迁移**到新文件 `src/runtime/workspace-manifest.ts`（`check-hint.ts:5` 与 `tests/check-hint.test.ts:4` 现从 execution-snapshot 导入）：

| 迁移内容 | 行 | 消费者 |
|---|---:|---|
| `FileMode`、`ManifestEntry`、`WorkspaceManifest` | 8-11 | check-hint、manifest 自身 |
| `sha256` | 24 | `check-hint.ts:5,25`（另测试 mock） |
| `missing`、`snapshotPaths`、`indexModes`、`snapshotLink`、`workspaceManifest` | 45-80 | `check-hint.ts:20,25,95`（工作区版本/重复 check hint）；`snapshotPaths` 与 `indexModes` 是 manifest 内部实现 |
| 合计约 95 行（新文件含 import） | | |

**删除**：`SnapshotTarget:12`、`ExecutionSnapshotRecord:13-16`、`ExecutionSnapshot:17`、`SnapshotOptions:18`、`identifier:20`、`identity:21`、`fixedDates:23`、`snapshotRef:26`、`snapshotCheckoutRoot:27`、`workspaceVersion:83`（仅 execution-integrate/integration 与测试使用）、`captureExecutionSnapshot:140-158`、`HostCommitViolation/Result:159-167`、`hostCommitExecution:168-188`。

### 1.3 外围代码改造（精确引用点）

| 文件 | 行 | 改动 |
|---|---|---|
| `src/runtime/types.ts` | 127-134 | 删除 `Run.execution`（含 `kind:'clone'`/`snapshotRef`/`generation` 字段）与 `Run.executionPending` |
| `src/runtime/types.ts` | 191 | 删除 `Call.host?: true`；随 host-call 子系统消失 |
| `src/tools/index.ts` | 21 | import 收窄为 `{ executionSession, runWorkspace }`（去掉 apply/commit/executionDelivery） |
| `src/tools/index.ts` | 37 | 删除 `commitSnapshotWorkspace, executionVerifier, integrateSnapshotDelivery` import |
| `src/tools/index.ts` | 76-77 | 删除 `workspace.commit`、`workspace.integrate` 两个 tool 定义（`builtinToolNames` 由 `definitions` 派生：`:112`） |
| `src/tools/index.ts` | 186 | 删除公开 `workspaceWriteLock`（仅执行子系统使用）；保留私有 `writeLock:192`（`:509/:815/:839` 仍在用） |
| `src/tools/index.ts` | 188 | 删除 `checkoutWriteLock`（无剩余调用方） |
| `src/tools/index.ts` | 190 | 删除 `planVerifier` 方法（`executionVerifier` 唯一实现） |
| `src/tools/index.ts` | 317 | 删除 `workspace.integrate/commit` 的 effectRoots 分支（fall through 即 `[workspace]`，对 `workspace.git` 行为不变） |
| `src/tools/index.ts` | 476 | 删除 `executionPending` 守卫 |
| `src/tools/index.ts` | 539 | 保留 `assertOwnership`，但把 `name.startsWith('workspace.')` 收窄为 `name === 'workspace.git'`（唯一保留的 workspace 工具） |
| `src/tools/index.ts` | 553-566 | 删除 `workspace.commit` / `workspace.integrate` 的 dispatch 整块（legacy clone 与 snapshot 两分支） |
| `src/tools/index.ts` | 477/503/537 | `executionSession(...)` 调用点：保留（函数改造后等价 `store.session`），或统一替换，净行数≈0 |
| `src/runtime/recovery.ts` | 18, 102 | 删除 Tools 接口可选 `planVerifier` 与调用链中的 `this.tools.planVerifier?.(call)`（`registerVerifier` 扩展 API 保留，recovery-extensions.test 不受影响） |
| `src/runtime/coordinator.ts` | 27, 109 | 删除 `preparePendingExecution` import 与第一次 `wake` 前的 admission 调用 |
| `src/runtime/coordinator.ts` | 431-436 | 删除"中断的 host call"分支（无 host call 后不可达）；`classifyRecovery` 其余逻辑不变 |
| `src/messaging/index.ts` | 10-11 | import：保留 `executionSession`（改造后空壳）或删除；删除 `executionContext` |
| `src/messaging/index.ts` | 146 | 删除 taskProtocol<2 时 `delete properties.execution`（字段已不存在） |
| `src/messaging/index.ts` | 350 | 删除 `args.execution` 需要 protocol≥2 的守卫 |
| `src/messaging/index.ts` | 361 | 删除 continuation 的 `EXECUTION_REUSE` 守卫 |
| `src/messaging/index.ts` | 393 | 写冲突条件删掉 `... && !previous?.execution && !previous?.executionPending` 分支 |
| `src/messaging/index.ts` | 404-406 | 删除 `execution`/`executionPending`/`workspace` 推导，改成 `const workspace = session.workspace` |
| `src/messaging/index.ts` | 410-412 | 删除 `executionPending` 分支与 packet 中的 `executionContext` 注入 |
| `src/messaging/index.ts` | 415-416 | 删除 `child.execution` / `child.executionPending` 赋值 |
| `src/messaging/index.ts` | 425 | `if (!child.executionPending && ...)` 改为 `if (factors...)` |
| `src/messaging/index.ts` | 441 | spawn 返回结构删除 `execution`/`executionPending` 字段 |
| `src/messaging/spawn-spec.ts` | 66 | 删除 `execution: {enum:['shared','isolated']}` 参数 |
| `src/messaging/spawn-spec.ts` | 75 | 删除 `SpawnAgentRequest.execution` |
| `src/messaging/spawn-spec.ts` | 158 | holder 条件删掉 `!peer.execution && !peer.executionPending`（所有子运行都在共享工作区；内核写冲突修复 2d84453 的语义保留） |
| `src/agents/card.ts` | 167/171 | `compactDefaultCard` 1.0.0→1.1.0；tools（171）去掉 `workspace.integrate, workspace.commit` |
| `src/agents/card.ts` | 184/188 | `legacySimpleDefaultCard` 1.0.0→1.1.0；tools（188）去掉两个 workspace 工具 |
| `src/agents/card.ts` | 197 | `simpleDefaultCard` 由 legacy 派生，版本 1.1.0→1.2.0（工具列表随之变化） |
| `src/agents/card.ts` | 200-204 | `leanDefaultCard` 工具列表显式覆盖（无 workspace.*），不需改；版本 1.4.0 保持 |
| `src/agents/presets.ts` | 90 | `compactWriteTools` 去掉 `'workspace.commit'`（子代理卡工具集） |
| `src/agents/presets.ts` | 102 | `compactBuiltinAgentCards` 版本 1.2.0→1.3.0（工具集变化） |
| `src/agents/presets.ts` | 112-114 | `simpleBuiltinAgentCards` 版本 1.3.0→1.4.0；tools（114）去掉 `'workspace.commit'` |
| `src/runtime/role-view.ts` | 7-8 | 删除 `workspace.integrate`（仅 main）与 `workspace.commit`（仅隔离子）两条 roleAllows |
| `src/runtime/workspace-git.ts` | 59 | 守卫简化为 `if (run.parentId) throw ...`，错误文案去掉 isolated checkout 措辞 |
| `src/runtime/inspection.ts` | 191 | 删除 `acceptance.execution` 段（`inspect_run` 不再投影 checkout） |
| `src/runtime/check-hint.ts` | 5 | 改为从 `./workspace-manifest.js` 导入 `sha256, workspaceManifest` |
| `src/runtime/check-hint.ts` | 43 | 删除 `execution.integrated` 事件判断（不会再产生） |
| `src/runtime/todo-execution.ts` | 27 | `!child.execution && !child.executionPending` 条件删除（所有子运行共享工作区；`TODO_DELEGATED` 判定保留） |
| `src/runtime/todo-dependencies.ts` | 9, 35-36 | `:9` 的 `store.hasEvent(..., { types: ['execution.prepared'] })` 改为只按 `step/mode 调用` 判断（事件不再产生）；`:35-36` 删掉 `!run.execution && !run.executionPending` 与 `!peer.execution && !peer.executionPending`（共享子运行写冲突排序逻辑保留） |
| `src/runtime/session-compat.ts` | 12-26 | **新增** execution-legacy 判定（store-aware）：session 下任一 run 带 `execution`/`executionPending`，或存在 `execution.snapshot.captured` / `execution.prepared` / `execution.integrated` / `execution.committed` 事件 → `SESSION_INCOMPATIBLE`（复用 1a 的显式不兼容策略） |
| `src/application/index.ts` | 449, 521, 543, 618 | 现有 `assertSessionCompatible(session)` 4 个入口改为 store-aware 版本（调用点不变，只改实现/签名） |
| **新增** `src/runtime/workspace-manifest.ts` | ~95 | 从 execution-snapshot 迁入的 manifest/hash 基础（§1.2），无执行语义 |
| **新增** `src/runtime/session-compat.ts` | +~12 | execution-legacy 门（见 §4） |

**不需要改动**：`src/web/**`、`src/tui/**`（无 `Run.execution`/workspace.commit 引用；tui 的 `recordExecution` 是 case-run 概念）、`src/cli/**`（无相关参数）、`src/storage/**`（见 §4）、`src/cases/**`（见 §1.4）、`scripts/**`（见 §6）。

### 1.4 同名但无关、不得误删的 `execution`

| 位置 | 含义 | 处置 |
|---|---|---|
| `src/runtime/types.ts:67`、`src/agents/card.ts:61,79` 的 `Card.execution.modes` | 卡片是否可 inline/child 运行 | **保留**（application:267,283、child-config:26、method-stage:144、extensions/methods:75,117、agents/discovery 使用） |
| `src/cases/store.ts:19`、`src/cases/runner.ts:109-119` 的 case `execution` | 用例一次 run 的执行证据（runId/status/outputDigest） | **保留**（`src/cases` 是 package/套件评测，与隔离检出无关） |
| `src/messaging/index.ts:305-338` 的 exploration `execution` | 调研问题的 child/reuse/deferred 决策 | **保留**（1d 协作工具精简再处理 explore） |
| `src/tools/write-locks.ts` 的写锁 | 共享工作区写锁 | **保留**（私有 `writeLock` 继续使用；只删没人用的公开包装） |

---

## 2. 删除后必须保留的最小接口

### 2.1 `runWorkspace`：保留并简化（30+ 调用点）

改造后实现（3 行）：

```ts
/** The session workspace; kept as the seam between run identity and tool roots. */
export function runWorkspace(store: Store, run: Run | string): string {
  const current = typeof run === 'string' ? store.run(run) : run;
  return store.session(current.sessionId).workspace;
}
```

调用点（`runWorkspace(` 全部命中）：
- `src/application/index.ts:215,576,601,624`
- `src/cli/index.ts:263`
- `src/messaging/index.ts:427,597`（427 同时是 executionSession 调用，改造后两者等价）
- `src/runtime/completion.ts:26,27`
- `src/runtime/context.ts:79,158`
- `src/runtime/inspection.ts:62`
- `src/runtime/instruction-layer.ts:76,126,162`
- `src/runtime/method-stage.ts:89`
- `src/runtime/tool-step.ts:104,412,418`
- `src/tools/index.ts:186,303,312,459,477,503,537,814,819,843,870,877,920,971`

### 2.2 `executionSession`：保留为空壳或直接删除

调用点：`src/messaging/index.ts:427`、`src/runtime/context.ts:79,158`、`src/runtime/instruction-layer.ts:76,126,162`、`src/runtime/tool-step.ts:104,412,418`、`src/tools/index.ts:477,503,537`。

建议：保留一行的 `executionSession = store.session(run.sessionId)`，避免这 15 处改动；它现在只是"run → workspace session"的命名缝，等 1e 收敛工具档位时再评估删除。若倾向彻底删，改动量相同、行为等价。

### 2.3 `Run.execution` 的全部使用点（删除清单）

- 定义：`src/runtime/types.ts:127-134`（连同 `executionPending`）。
- 写：`src/messaging/index.ts:405-406,415-416`；`src/runtime/execution-admission.ts:16-33`（整删）。
- 读/判空：`src/runtime/execution-workspace.ts:13,18`（简化）、`:56-57,70`（随 commit 删）、`src/runtime/execution-snapshot.ts:17,168`（随文件删）、`src/tools/index.ts:553,557`（dispatch 删）、`src/runtime/workspace-git.ts:59`（简化）、`src/runtime/inspection.ts:191`（删除投影）、`src/runtime/role-view.ts:8`（删除）、`src/messaging/spawn-spec.ts:158`（简化）、`src/runtime/todo-execution.ts:27`、`src/runtime/todo-dependencies.ts:35-36`（三处 `!child.execution`/`!peer.execution` 条件删掉）、`src/runtime/coordinator.ts:109`（经 admission 删）；另有 `src/runtime/todo-dependencies.ts:9` 的 `execution.prepared` 事件判断。
- `executionPending` 使用点：`types.ts:133-134`、`messaging/index.ts:361,404-405,425`、`spawn-spec.ts:158`、`tools/index.ts:476`、`workspace-git.ts:59`、`todo-execution.ts:27`、`todo-dependencies.ts:35-36`、`coordinator.ts:109`。
- 测试：4 个 execution-*.test（整删）与 §3 列出的改写点。

### 2.4 `git`/保护路径等保留函数

- `git`：唯一外部模块 `workspace-git.ts`（46/52/66-68/86/101-116/134-166）+ workspace 内部；保留在 execution-workspace.ts（文件名可留，或顺手改名 `workspace-git-core.ts`——建议留名，减小 diff）。
- `protectedPath` / `changedExecutionFiles` / `executionFileViolation`：只有 `workspace-git.ts` 依赖（import 在 `:6`）；保留，并保留工具侧 `protectedPart` 副本不变。
- `workspaceManifest`/`sha256`/`indexModes`：迁移到 `workspace-manifest.ts`，消费者只有 `check-hint.ts`（`checkVersion` 用于重复 check hint 的版本比对）。
- `Call.host`：删除（只被 coordinator:433 与 execution-* 使用）；`recovery.registerVerifier` 外部扩展 API 保留。
- `WorkspaceLocks`/`workspaceWriteLock`/`checkoutWriteLock`：删除；私有 `writeLock` 保留。

---

## 3. 关联测试

### 3.1 整体删除（4 文件，955 行）

| 文件 | 行数 | 覆盖内容（全部属于被删子系统） |
|---|---:|---|
| `tests/execution-integrate.test.ts` | 174 | plan/apply/reconcile integration、staging |
| `tests/execution-snapshot.test.ts` | 204 | 快照捕获、pinned ref、checkout、retention cleanup、manifest |
| `tests/execution-wiring.test.ts` | 371 | host calls、`workspace.commit`/`workspace.integrate`、恢复、lean 编排 |
| `tests/execution-workspace.test.ts` | 206 | clone/dirty 拒绝、delivery、admission、`preparePendingExecution` |

删除后这批覆盖全部消失，需按下节补最小等价测试（尤其 manifest/hash 与 spawn shared 路径）。

### 3.2 必须改写的测试（精确 case/行）

| 文件 | 行 | 改动 |
|---|---|---|
| `tests/check-hint.test.ts` | 4（import）、80/107/119（`vi.mocked(snapshot.workspaceManifest)`） | 导入路径改 `workspace-manifest.js`；mock 对象不变（148 行，其余断言保留） |
| `tests/compact-tools.test.ts` | 77-83 | 子卡版本 1.2.0→1.3.0；`:78` 期望工具列表去掉 `workspace.commit`；`:82-83` 的 not-contain 断言改为断言工具列表里不再有这两个名字（或直接删） |
| `tests/event-resource-wait.test.ts` | 25-33 | 首例 `records isolated admission failure ...` 删除（该行为不存在）；其余 event-driven wait 用例与执行无关，保留 |
| `tests/inspection-acceptance.test.ts` | 124-133 | 删除 `execution` fake 与 `acceptance.execution` 断言；保留其余 acceptance 断言 |
| `tests/role-tool-view.test.ts` | 33（标题） | 仅措辞"child execution"可保留（测试用的是共享子运行，无 `execution` 字段），无需改代码 |

### 3.3 需要新增的测试（迁移/保底）

1. **spawn shared 默认路径**：`spawn_agent` 不传 `execution` 时子运行 `workspace == session.workspace`、`run.execution === undefined`、spawn 返回无 `execution` 键；传 `execution:'isolated'` 会被 schema（`additionalProperties:false`）拒绝为 `TOOL_ARGUMENTS`。
2. **旧会话不兼容门**：构造带 `execution` 字段的旧 run/session JSON，`app.run`/`recover`/resume 抛 `SESSION_INCOMPATIBLE`；只读 list/inspect 仍可读（与 1a lean-team 门一致）。
3. **manifest 迁移回归**（从删掉的 execution-snapshot.test 移最小集）：同内容同 digest、`.kodo` runtime 目录排除逻辑（`checkVersion` 依赖）、`indexModes` Windows 大小写路径、protected 文件不计入、符号链接限制。至少 8-10 条断言。
4. **workspace.git 保底**：main 运行可用 status/commit；子运行仍被 `EXECUTION_OWNER` 拒绝（`workspace-git-wiring.test.ts` 已有主体，补改文案断言即可）。
5. **卡片工具面**：`simpleDefaultCard`/`compactDefaultCard` 的 tools 不含两个 workspace 工具、版本已 bump；旧卡（声明 `workspace.commit`）经 `parseCard` 抛 `CARD_SCHEMA`（错误信息明确"unsupported card fields"）。
6. `npm run test` 全量 + `npm run build`（每步提交前）。

### 3.4 明确不受影响的测试

`tests/recovery-extensions.test.ts`（host.publish 的 `registerVerifier` 扩展保留）、`tests/workspace-git-wiring.test.ts`（保留工具，无 execution 引用）、`tests/cases*.test.ts` / `tests/tui-*.test.ts`（case 证据的 `execution` 字段是另一概念）、`tests/agent-card-v2.test.ts` / `inline-methods.test.ts` / `method-stages.test.ts`（`Card.execution` 保留）。

---

## 4. 数据兼容（旧会话 / 旧 store 中的 `execution`）

- **无 SQLite 迁移**：`runs` 表只有 `data TEXT`（`src/storage/index.ts:88`：`runs(id, session_id, status, data)`），`execution`/`executionPending` 是 JSON 字段；删除类型字段后旧 `data` 里的键会被忽略，不需要 schema 变更。
- **读取路径**：旧会话/旧 run 仍可 `list`/`inspect`/导出；`inspect_run` 的 `acceptance.execution` 段对旧运行不再出现（属投影变化，非错误）。
- **恢复/继续路径（建议：显式不兼容）**：产品未发布，沿用 1a 策略（`session-compat.ts:4-26`）。扩展 `assertSessionCompatible` 为 store-aware：
  - session 上有 `toolProfile: 'lean-team'` 或 `maxTaskNodes`（1a 已有）；或
  - session 下任一 run 带 `execution`/`executionPending`；或
  - 存在 `execution.snapshot.captured` / `execution.prepared` / `execution.integrated` / `execution.committed` 等事件（`store.events`）。
  命中即 `SESSION_INCOMPATIBLE`，文案说明"由已删除的隔离检出子系统创建，未发布产品请新建任务；旧证据可用 `kodo inspect` 查看"。调用点仍是 `application/index.ts:449,521,543,618`，只改实现。
- **旧卡片**：`parseCard` 用 `builtinToolNames`（`tools/index.ts:112`）校验工具名（`card.ts:105-106`）；删除定义后，声明 `workspace.commit/integrate` 的旧卡片会在 parse/registration（`application/index.ts:245,282-286`）失败。产品未发布，fail fast 可接受；建议错误信息保持现有 `CARD_SCHEMA`/`CARD_UNAVAILABLE`，并在 release notes 写明"旧卡需去掉这两个工具名"。
- **磁盘残留**：旧隔离检出在 `<workspace 父目录>/.kodo-executions/<session>/<child>/`，旧快照 ref 在用户仓库 `refs/kodo/snapshots/<session>/<node>-<gen>`；retention 代码随 1b 删除后不再自动清理。不要自动删除工作区之外的目录；在 release notes 给出手动清理命令（`rm -rf` 目录 / `git update-ref -d` refs），可选的一次性清理脚本不属于 1b。
- **`.kodo/golden/baseline-20261103` 等历史证据目录**：只读使用不受影响；其中冻结卡含已删工具名，若被重新注册/resume 会命中上面的门（该目录不应被 resume）。

---

## 5. 分步提交计划（4-5 步，每步可独立编译+测试）

| 步骤 | 内容 | 文件 | 风险/验证 |
|---|---|---|---|
| **S1（纯迁移）** | 新建 `workspace-manifest.ts`（~95 行），把 `sha256/indexModes/workspaceManifest/ManifestEntry/WorkspaceManifest/FileMode` 从 execution-snapshot 迁入；execution-snapshot 改为从新模块 import（暂时保留旧 re-export 或直接改内部引用），`check-hint.ts:5` 与 `tests/check-hint.test.ts:4` 改导入 | 新增 1、改 3 | 零行为变化；`npm test`（check-hint 全套） |
| **S2（原子删除，核心）** | 删 9 个 execution-*.ts + execution-workspace 裁剪 + execution-snapshot 剩余删除；同步删除类型字段/工具定义/dispatch/卡片工具列表+版本 bump/presets/role-view/messaging/coordinator/workspace-git/inspection/recovery/check-hint 事件；删 4 个 execution 测试、改 4 个测试、补 §3.3-1/3/5 测试 | ~25 文件 | **不可再拆**：工具定义、卡列表、`Run.execution` 类型与子系统必须同 commit；编译期全量纠错；`npm run build`+`npm test`；重点 todo-delegation/write-scope/compact-tools/check-hint/role-tool-view |
| **S3（兼容门）** | `session-compat.ts` 扩展 execution-legacy 判定（store-aware），`application` 4 个入口改调用；新增旧会话拒绝测试 | 2 + 测试 | 读路径不变；旧数据测试手工构造 JSON；resume/recover 抛 `SESSION_INCOMPATIBLE` |
| **S4（评测门禁，可单独提交结果/文档）** | 重跑阶段 1 黄金评测门槛：27 格候选矩阵（含 coding-01 编码样例）与基线逐格对比；要求 passRate 不低于基线、无新增违规、翻转格逐个复核（工具 schema 与卡版本变化会改变请求字节，必须实测而非推断） | — | 最大验收风险；如 coding-01 或 text 样例出现翻转，先定位是否由工具面/卡版本引起再决定接受 |
| **S5（文档与残留说明）** | 更新 `kodo-final-positioning-20261103.md:138`（1b 实际行数）、`kodo-subtraction-plan-20261103.md:69`（标记完成）、`cli-host-configuration.md:241`（历史节加"已删除"注）、设计文档中 execution checkout 段落标历史；补 `.kodo-executions`/`refs/kodo/snapshots` 手工清理说明 | 4-6 docs | 只写文档；不影响代码/测试 |

建议提交顺序：S1 → S2 → S3 → S4 → S5。S2 是唯一大 commit；S1/S3 可独立 review。

---

## 6. 风险清单（按影响排序）

1. **spawn 共享路径（最高风险）**：1b 只删 `execution` 选项，`spawn_agent`/`wait_for_events`/`inspect_run`/`cancel_agent`/`ask_user` 全部保留给 1d。改动集中在 `prepareSpawn`（messaging:350-416）与 `assertNoWriteConflict`（spawn-spec:113-162）：
   - 现条件 `!peer.execution && !peer.executionPending`（spawn-spec:158）删除后，所有活动子运行都算写冲突 holder；此前隔离子被排除。由于隔离子不再存在，语义等价，但必须跑 `todo-delegation`/`todo-parallel`/`write-scope` 相关测试确认没有误伤。
   - 内核修复 `2d84453`（同一响应 spawn 的写范围整体校验）依赖 `assertNoWriteConflict` 的调用时机；`messaging/index.ts:393` 的条件删减不得改变该调用的触发范围。
   - 子运行 `workspace` 全部 = session workspace：`completion.ts`/`context.ts`/`instruction-layer.ts` 的 `executionSession` 改造要保持"工作区一致"，不要误改 `session.workspace` 语义。
2. **卡片工具列表与版本（会导致启动失败）**：`parseCard` 在模块加载/注册时校验工具名（`card.ts:105-106`），`builtinToolNames` 由 definitions 派生（`tools/index.ts:112`）。若只删工具定义而漏改 `card.ts:171,188` 或 `presets.ts:90,114`，默认卡解析直接 `CARD_SCHEMA`，应用无法启动。版本必须 bump（compactDefaultCard 1.1.0、legacySimple 1.1.0、simple 1.2.0、compactBuiltin 1.3.0、simpleBuiltin 1.4.0），并同步 `tests/compact-tools.test.ts:77`。旧卡（用户/项目卡）会因同一校验被拒，属预期不兼容。
3. **黄金评测门槛（阶段 1 验收）**：coding-01 编码样例与 27 格候选矩阵是在"含 workspace.commit/integrate 工具"的卡上测的。1b 改变默认卡工具面/版本 → 请求 schema 变化、系统提示/工具描述变化；必须重跑矩阵并逐格对比（不能只看总分），确认无样例翻转或无新增违规。基线证据目录里的冻结卡含已删工具名，不要 resume 这些会话（会被兼容门拒绝）。
4. **workspace.git 保留工具**：它依赖保留下来的 `git/protectedPath/changedExecutionFiles/executionFileViolation`；`workspace-git.ts:59` 改为只拒 `run.parentId`。`check-hint.ts` 的 `quietSince` 仍以 `workspace.git commit` 成功作为"安静"证据（:48-51），这部分保留；删除 `execution.integrated` 判断（:43）不影响共享工作区语义。
5. **check-hint 版本指纹迁移**：`workspaceManifest`/`sha256` 迁到新模块后，`checkVersion` 对 `.kodo` 运行时目录的排除逻辑（`check-hint.ts:18-26`）必须逐字保留，否则重复 check hint 会全部失效或误报；`tests/check-hint.test.ts` 的 mock 路径同步改。
6. **inspect/web/TUI 投影**：`inspect_run` 的 `acceptance.execution` 消失，web workbench/TUI 动态渲染不会崩，但旧证据预览字段变少；只有 `tests/inspection-acceptance.test.ts:124-133` 需要同步。`src/web/**`/`src/tui/**` 无 `Run.execution` 直接引用，无需改代码。
7. **cases 包与 `Card.execution` 误删**：`src/cases/store.ts:19`、`src/cases/runner.ts:109-119` 与 `Card.execution.modes` 是不同概念，绝不能顺手删；`npm test` 会暴露过度删除（cases/inline-methods/method-stages 测试）。
8. **旧会话/旧卡片/磁盘残留**：见 §4。最大风险是"旧 session 静默跑到共享工作区"——必须用 S3 的兼容门阻止；只读 inspect 保持可用。
9. **host-call 基础设施删除的连带**：`Call.host`、`coordinator:431-436` 中断分支、`recovery.planVerifier` 在 1b 后不可达；但 `recovery.registerVerifier` 扩展 API 与 host.publish 恢复测试必须保留（recovery-extensions.test）。`host.task.check` 的生产者已在 1a 删除，删除名字列表无影响。
10. **文档/参数残留**：`spawn_agent` 的 `execution` 参数从 schema 删除后，旧提示词/旧任务卡文本里若仍要求"isolated"会被额外属性校验拒绝（`TOOL_ARGUMENTS`）；`docs/cli-host-configuration.md:241` 等历史文档需标注已删除，避免误导。

---

## 7. 与批次 1c / 1d / 1e 的边界

- **1b 负责**（本批次）：`runtime/execution-*` 子系统；`Run.execution`/`executionPending`；`workspace.commit`/`workspace.integrate` 工具定义、dispatch、role-view 两行、默认/子代理卡中的两个工具名与必要版本 bump（仅为编译通过，不做卡片体系重构）；`spawn_agent` 的 `execution` 参数；`check-hint` manifest 迁移；`session-compat` 的 execution-legacy 门。
- **留给 1c**（名册、路由、留存、派生、预设与角色卡，1,159 行）：`presets.ts` 的 compact/simple 卡片体系重构与删除、`card.ts` 内置卡集合的进一步收敛、`agents/discovery.ts`、`agents/route*`、`agent-retention`、`agent.derive` 等。1b 只在 `presets.ts:90,114` 与 `card.ts:171,188` 做"去掉两个工具名 + bump 版本"的最小改动，**不删除卡类/方法/名册结构**；1c 删除时自然接管这些遗留行。
- **留给 1d**（协作工具精简为 spawn/wait/inspect/cancel/ask_user；fresh/fork；todo 去依赖与派发）：`spawn_agent` 的其余参数与语义、`explore`/`exploration.plan`、`send_message` 点对点、`followup_task`、`agent.derive`、`report.submit`；todo 的依赖/派发逻辑。1b 只删 `execution` 字段并把写冲突条件里的隔离分支去掉，**不得删除**这些工具与 todo 逻辑。
- **留给 1e**（工具档位/因素/协议收敛）：compact-v1/compact-v2/full/lean-solo 档位与 A–E 因素、任务协议；1b 只 bump 版本与工具名，不改 `toolProfile` 选择逻辑与因素分支。
- **明确不在 1b**：`workspace.git` 工具（保留，属主工作区 Git 交付）；`check-hint` 重复检查提示（保留，仅迁移 manifest）；`recovery.registerVerifier` 扩展 API（保留）；sandbox/write-locks（保留）；`src/cases`（保留）。

---

## 附：行数核算

| 项 | 行数 |
|---|---:|
| 现 `src/runtime/execution-*.ts` 合计 | 1,141 |
| 其中整体删除 9 文件 | 802 |
| execution-workspace 删除（54-151） | 98 |
| execution-snapshot 删除（迁移后） | 93 |
| 新建 workspace-manifest.ts | +95 |
| 新建/扩展 session-compat.ts | +12 |
| 外围源码净删（tools/messaging/spawn-spec/coordinator/types/card/presets/role-view/workspace-git/inspection/recovery/check-hint） | 约 -75 |
| **源码净删合计** | **约 1,050 行** |
| 测试整删 4 文件 | 955 |
| 测试改写 + 新增 | 约 +100～120 |
| **测试净删** | **约 840 行** |

计划表的 1,156 与实测 1,141 的差异来自 1a 合并（`execution-workspace.ts` 等文件被顺手收窄约 15 行）；以实测 1,141 为准。
