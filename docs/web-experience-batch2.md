# Web 工作台第二批（断线重连体验 + 能力包开发体验）

日期：2026-10-23。状态：实现契约，范围仅 Herdr 借鉴的“第二批”两行：断线重连体验、能力包开发体验。以现有 `serve`（浏览器连接与执行宿主分离）、SQLite 持久事件/等待/恢复机制、`PackageRegistry` 和本地 Web 工作台为基础；不引入终端模拟、外部 Harness 调度或第二套状态机。

## 1. 范围

本批实现：

1. **断线重连体验**：连接/重新连接/服务重启状态可见；SSE 重连补齐遗漏事件后给出“已补齐 N 条”的反馈；工作台列出需要恢复或核实的任务（中断待恢复、未知写入待核实、已接受排队、Web 命令失败），并给出下一步动作。
2. **能力包开发体验**：Web 面板展示已安装能力包的兼容性诊断（`imported`/`needs_configuration`/`incompatible`/`ready` 及原因）、依赖准备状态与可观察进度、默认版本切换（adopt/rollback）、当前 Web 服务启用的包版本和可见任务使用的卡片/包版本。

本批不做：外部 Harness 接入、终端模拟、插件市场/发现、在浏览器中编辑包源码、自动验收/自动采用、包发布与上传、把“已查看”当验收。`package verify` 的示例执行仍走 CLI；本批准备依赖和执行包内工具都必须在宿主已批准的沙箱策略下进行。

## 2. 一致性与安全边界

### 2.1 连接与恢复语义

- 浏览器关闭 ≠ 执行停止：`serve` 进程与内核继续执行，只是失去 SSE 订阅；重新打开页面会用持久事件序号补齐。
- `serve` 进程退出/机器重启会中断执行中的运行；重启后：
  - 已接受且处于 `queued` 的任务由现有重启续接逻辑重新推进；
  - `interrupted` 运行必须显式恢复（`POST /api/runs/:id/resume`），未知副作用仍需先核实；
  - `failed` 且 `UNKNOWN_WRITE` 的运行禁止自动恢复，需宿主核实；
  - Web 命令异步失败保留 `web.command_failed` 事件，作为“需要核实/重试”的提示。
- 服务重启后进程内 cookie 失效，所有请求返回 401。界面必须明确提示“服务已重启或连接失效，请用新的启动密钥重新连接”，不能静默重试成“已连接”。
- 前端不得把重连成功或补齐事件当作任务完成/验收；补齐后可刷新快照，但状态以持久记录为准。
- `serverId`/`startedAt` 只用于界面判断进程是否更换，不参与任务语义。

### 2.2 能力包语义

- 导入、诊断、依赖准备、采用（adopt/rollback）、启用（activate）、运行是不同动作：
  - **诊断**只读文件与本地登记状态，不执行包代码；
  - **依赖准备**在宿主启用后，于单独可写沙箱执行 `npm ci --ignore-scripts --omit=dev`，需要网络，可能长时间运行；失败/取消必须可见；
  - **adopt/rollback** 只切换“默认版本指针”，不执行代码、不修改现有运行、不自动启用、不授予权限；
  - **运行版本**是任务创建时固定的卡片；升级包或切换默认版本不会改变已存在任务的卡片/工具绑定，恢复旧任务仍需重新启用相同包摘要。
- 浏览器不能扩大授权：能力包面板默认关闭，只有宿主 `createLocalServer(... packages)` 或 CLI `serve --packages/--package-actions` 显式开启后才暴露；准备依赖/切换默认版本分别需要 `prepare`/`adopt` 宿主开关；未开启的路由返回 404，界面隐藏或禁用对应动作。
- 所有包管理响应不含 `binding`、API key、环境变量值、MCP 本地绑定 URL/头信息；只展示“是否已配置”和诊断原因。登记目录路径不返回给前端。
- 包内代码/依赖准备只在宿主已批准的操作系统中沙箱执行；本批不新增“在浏览器验收包示例”的入口。

## 3. 断线重连体验

### 3.1 `GET /api/state` 扩展

现有响应增加：

```ts
{
  csrf: string;
  workspace: string;
  permissions: Permission[];
  serverId: string;   // 每个本地服务进程唯一，重启后变化
  startedAt: string;  // ISO，进程启动时间
}
```

### 3.2 `GET /api/recovery?limit=100`

认证后读取；只返回当前服务有访问资格的会话中的任务。新增模块 `src/web/recovery.ts`：

```ts
export type RecoveryKind = 'resume' | 'verify_write' | 'queued' | 'command_failed';

export interface RecoveryItemView {
  runId: string;
  sessionId: string;
  parentId?: string;
  role: 'main' | 'child';
  objective: string;
  status: RunStatus;
  kind: RecoveryKind;
  error: string | null;
  createdAt: string;
  lastEventAt: string;
}

export interface RecoveryView {
  serverId: string;
  startedAt: string;
  generatedAt: string;
  counts: Record<RecoveryKind, number>;
  items: RecoveryItemView[];
}

export function recoveryView(app: Application, allowedSession: (sessionId: string) => boolean, options?: { limit?: number }): RecoveryView;
```

规则（每个 run 最多一条，按下列优先级）：

| kind | 触发 |
| --- | --- |
| `verify_write` | `status==='failed'` 且 `error` 以 `UNKNOWN_WRITE` 开头 |
| `resume` | `status==='interrupted'` |
| `command_failed` | 该 run 最新持久事件为 `web.command_failed` |
| `queued` | `status==='queued'` |

- `limit` 默认 100，范围 1–200；排序：kind 优先级 `verify_write`→`resume`→`command_failed`→`queued`，同 kind 按 `lastEventAt` 降序，再按 runId。
- `lastEventAt` 取该 run 最后持久事件时间，缺省 `createdAt`；不返回 `binding` 或结果内容。
- 未认证 401；无资格会话完全不出现（不能只靠界面隐藏）。

### 3.3 前端连接状态与恢复面板

工作台顶部新增连接状态栏（具体 DOM 由负责人定，建议 `#connection-bar` + `#connection-text` + `#connection-dot` + `#recovery-toggle` + `#recovery-badge`）：

| 状态 | 触发 | 文案 |
| --- | --- | --- |
| 已连接 | 初次认证 + SSE 打开 | 已连接 |
| 重新连接中 | SSE `onerror`，且 `/api/state` 仍 2xx | 连接中断，正在重新连接… |
| 已重新连接 | SSE 重新 `onopen` 后 | 已重新连接，补齐 N 条遗漏事件（短暂显示后回到“已连接”） |
| 需要重新认证 | 任意 API 返回 401（服务重启/会话过期） | 服务已重启或会话失效，请用新的启动密钥重新连接；显示连接表单并保留上次任务 ID |
| 无法连接 | 重连失败且服务不可达 | 无法连接本地服务，请确认终端中的 `kodo serve` 仍在运行 |

实现要点：

- SSE 重连沿用现有 `EventSource` 自动重连 + `Last-Event-ID`/`after` 持久重放；重新打开后统计 `seq > 断线时 cursor` 的事件数作为“补齐 N 条”，并刷新主快照与协作/恢复视图。补齐后显示一次即可，不弹重复提醒。
- `onerror` 时调用 `/api/state` 探测：2xx 保持自动重连，401/网络失败进入对应状态；不要无限快速轮询。
- 重新认证成功后：`serverId` 与上次不同则提示“服务已重启”，恢复上次 `active` 任务（仍可访问时）；重新拉取 `/api/recovery`。401 不能静默当作普通事件错误。
- 恢复面板（复用右侧检查器，模式 `recovery`）：列出 items，显示 kind 标签/目标/状态/错误；动作：
  - `resume` 且 `role==='main'`：`POST /api/runs/:runId/resume`，提示“未知写入仍需宿主核实”；
  - `verify_write`：只提供“查看任务/证据”，不提供自动恢复，文案提示需宿主核实；
  - 其余：查看任务（`select(runId)`；child 则打开其主任务并进入协作面板）；
  - 恢复面板为空时显示“没有需要恢复或核实的任务”，并说明浏览器关闭不中断执行、服务退出会中断。
- 连接状态栏与恢复计数需在重连、恢复/取消动作后刷新；数量计入所有非空 items（不做本地“已读”抑制，避免掩盖待核实状态）。

## 4. 能力包开发体验

### 4.1 宿主选项与 CLI

`LocalServerOptions` 增加可选字段（由 `src/web/packages.ts` 导出类型）：

```ts
export interface PackagePanelOptions {
  /** 必须显式为 true 才开启面板；省略 packages 或 enabled 非 true 时 GET /api/packages 返回 enabled:false。 */
  enabled?: boolean;
  /** 已安装包的登记目录；默认 <app.store.directory>/capabilities。必须是绝对路径；测试/嵌入宿主可直接传 PackageRegistry 实例。 */
  registry?: string | PackageRegistry;
  /** 宿主为 Web 新任务启用的包版本，仅用于展示与运行版本核对。 */
  runtime?: { id: string; version: string; digest: string };
  /** 允许浏览器触发沙箱内 npm 依赖准备。 */
  prepare?: boolean;
  /** prepare 使用的可信 npm CLI 模块路径；省略时由 registry 默认解析。 */
  npmCli?: string;
  /** 允许浏览器切换默认版本指针（adopt/rollback）。 */
  adopt?: boolean;
}
// LocalServerOptions.packages?: PackagePanelOptions
```

CLI `serve` 新增（参数需在 `--help` 中说明；相互依赖关系在启动前报错）：

- `--packages`：开启只读能力包面板（诊断、版本/运行版本展示）。
- `--package-actions`：开启依赖准备与默认版本切换（要求同时有 `--packages` 或 `--package`）。
- `--npm-cli PATH`：准备依赖使用的可信 npm CLI 路径（要求 `--package-actions`）。
- `--package author/name[@1.2.3]`：宿主显式启用该包（省略版本时用 adopted 指针）；启用成功后 Web 新任务使用该包卡片，面板 `runtime` 显示其版本。包启用沿用现有 `PackageRegistry.activate` 与 `verifyToolExamples` 策略；失败即拒绝启动。
- 只有满足相同包身份/摘要、沙箱、工具、compaction、assembly 的旧会话才在重启后可见；`cli-host.json` 的 `package` 字段持久化该身份（id/version/digest/stdioWrite/stdioNetwork）。为保证宿主能力一致，`matching` 对称处理：`serve` 未启用 `--package` 时不展示已记录包身份的会话；启用包时也不展示旧的非包会话。

### 4.2 包管理服务 `src/web/packages.ts`

```ts
export interface PackagePanelOptions { /* 见 4.1 */ }

export interface PackageVersionView {
  version: string;
  digest: string;
  card: { id: string; version: string; digest: string; name: string; description: string; tools: string[]; skills: string[] };
  status: 'imported' | 'needs_configuration' | 'incompatible' | 'ready';
  reasons: string[];
  requirements: { node?: string; platforms?: string[]; arch?: string[]; dependencies?: Record<string, string> };
  resources: { tools: number; skills: number; mcp: number };
  examples: number;
  prepared: { ready: boolean; treeDigest: string | null };
  bindingsConfigured: boolean;
  provenance: { importedAt: string; source: { url: string; revision?: string }; archiveName: string } | null;
}

export interface PackageGroupView {
  id: string;
  defaultVersion: string | null;
  previousVersion: string | null;
  adoptedAt: string | null;
  versions: PackageVersionView[];
}

export interface RunningPackageRunView {
  runId: string;
  sessionId: string;
  role: 'main' | 'child';
  objective: string;
  status: RunStatus;
  cardId: string;
  cardVersion: string;
  cardDigest: string;
  /** 同版本已安装卡片的 digest；null 表示该版本已不在登记目录。用于与宿主卡片突变校验对齐。 */
  installedDigest: string | null;
  stale: boolean;
  createdAt: string;
  lastEventAt: string;
}

export interface PrepareJobView {
  id: string;
  packageId: string;
  version: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  phase: 'queued' | 'validating' | 'dependencies' | 'verifying' | 'committing' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface PackageOverview {
  enabled: boolean;
  actions: { prepare: boolean; adopt: boolean };
  runtime: { id: string; version: string; digest: string } | null;
  packages: PackageGroupView[];
  running: RunningPackageRunView[];
  prepareJobs: PrepareJobView[];
  errors: string[];
}

export class PackagePanel {
  constructor(options: {
    registry: PackageRegistry;
    runtime?: { id: string; version: string; digest: string };
    prepare?: boolean;
    npmCli?: string;
    adopt?: boolean;
  });
  overview(app: Application, allowedSession: (sessionId: string) => boolean): Promise<PackageOverview>;
  prepare(id: string, version: string): { jobId: string };
  job(jobId: string): PrepareJobView | undefined;
  async adopt(id: string, version: string): Promise<PackagePointer>;
  async rollback(id: string): Promise<PackagePointer>;
  close(): Promise<void>;   // 取消进行中的准备并等待结束
}
```

实现约束：

- `overview`：`registry.list()` 读版本；对每个版本调用 `registry.diagnose`；单包读取/诊断失败不拖垮整体，写入 `errors`。默认版本用 `registry.current(id)`；provenance 用 `registry.provenance`；`bindingsConfigured` 用 `registry.bindings` 是否成功（不返回绑定内容）。不返回登记目录绝对路径。
- `running`：遍历 `app.store.listRuns()`，仅保留 `allowedSession(run.sessionId)`；卡片 id 必须匹配已安装包 id；最多 200 条，按 `createdAt` 降序；`installedDigest` 取同版本已安装摘要；`stale = installedDigest !== null && run.card.digest !== installedDigest`；`lastEventAt` 取最后事件时间。
- `prepare`：内存队列，同一时刻最多一个 npm 准备任务；同一包版本已有 queued/running 任务时复用 jobId。任务内部调用 `registry.prepareDependencies(id, version, { npmCli, signal, onProgress })`，用新增的 `onProgress` 更新 phase；完成后重新诊断。任务不使用 Web 请求幂等回执，重启后丢失；错误只保存消息，不泄露内部路径。
- `PackageRegistry.prepareDependencies` 增加可选 `onProgress?: (progress: { phase: 'validating' | 'dependencies' | 'verifying' | 'committing' }) => void`，在对应阶段开始前调用；默认行为不变。
- `close()` 在服务关闭时 abort 所有任务并等待 settle。

### 4.3 HTTP 接口

| 方法与路径 | 请求 | 响应 | 宿主开关 |
| --- | --- | --- | --- |
| `GET /api/packages` | — | `PackageOverview`；未开启时 `enabled:false` | 认证即可 |
| `POST /api/packages/:id/:version/prepare` | `{}` | 202 `{ jobId }` | `packages.prepare === true`，否则 404 |
| `GET /api/packages/jobs/:jobId` | — | `PrepareJobView`；未知 job 404 | 认证即可 |
| `POST /api/packages/:id/adopt` | `{ version }` | 200 `{ pointer }` | `packages.adopt === true`，否则 404 |
| `POST /api/packages/:id/rollback` | `{}` | 200 `{ pointer }` | `packages.adopt === true`，否则 404 |

- `:id` 为 `author/name`，`:version` 为 `x.y.z`；非法身份 400，包不存在 404 `PACKAGE_NOT_FOUND`。
- POST 仍需同源 Origin 与 `X-Kodo-CSRF`；包管理动作不使用 `web_requests` 回执（`adopt` 本身幂等，`prepare` 同版本复用进行中任务）。响应不含包代码、绑定或宿主路径。
- 工具级错误沿用现有映射：业务错误 400，未找到 404，宿主关闭的路由 404，认证/CSRF/Origin 403/401。
- 服务 `close()` 时调用 `PackagePanel.close()`；准备任务不得阻止进程退出超过必要时间。

### 4.4 前端能力包面板

工作台新增“能力包”按钮与全屏面板（参考现有“项目知识”面板的布局模式；也可用检查器，但需容纳诊断/依赖进度/运行版本，建议全屏）：

- 连接后调用 `GET /api/packages`；`enabled:false` 时隐藏按钮或禁用并提示宿主启动参数；不报错打扰主对话。
- 面板头：能力包开发、刷新、关闭；若 `runtime` 非空显示“当前 Web 服务启用：id@version（摘要前 8 位）”和说明“新任务使用此卡片；切换默认版本不会改变已运行任务”。
- 包分组：id、默认版本/上一版本；版本卡片显示：
  - 状态徽标（ready/needs_configuration/imported/incompatible）与 reasons 列表；
  - 卡片名称/描述、tools/skills/mcp/例子数量；
  - requirements（Node/平台/架构/依赖声明）；依赖准备状态（未准备/已准备 + treeDigest 前 8 位）；
  - provenance（source URL、导入时间、归档名，均可为空）；
  - 动作（仅宿主开启时显示）：`准备依赖`（有依赖且未准备、`actions.prepare`）、`设为默认版本`（非默认、`actions.adopt`）、`回退默认版本`（存在 previousVersion、`actions.adopt`）。
- 依赖准备：点击后 POST prepare，显示排队/阶段（validate→dependencies→verifying→committing→done/failed）与已用时间；面板每 1s 重新读取 overview 或 job，直到任务结束；失败显示错误并提供重试。并发只允许一个进行中任务（服务端排队）。
- 运行版本：列出 `running` 任务（目标、主/子、状态、卡片版本、是否 stale）；说明“任务卡片在创建时固定；包升级/切换默认版本不会改变运行任务”。
- 所有文本用 `textContent`/`element()`，禁止 `innerHTML`/`onclick`；新增脚本不得使用模板字符串字面量（workbenchScript 本身是模板字符串）；`tests/web.test.ts` 只追加静态断言：面板 DOM/按钮、`/api/packages`、`prepare`/`adopt`/`rollback`、诊断/进度/运行版本文案、无注入面。

## 5. 测试与验收

新增测试：

- `tests/web-reconnect.test.ts`：`/api/state` 的 `serverId` 稳定、重启后变化；`/api/recovery` 四类 item 判定、排序/limit、401、跨工作区会话过滤、无 binding/结果泄露；重启后持久项仍可见。
- `tests/web-packages.test.ts`：临时登记目录构造真实已安装包；overview 状态/诊断/默认版本/provenance/running 过滤与 stale；`prepare` 使用注入的假 npm 或 `onProgress` 可控（避免真实网络），任务阶段/队列/失败/关闭取消；adopt/rollback 指针切换不改运行记录；宿主开关关闭时 404、`enabled:false`；CSRF/身份校验；界面静态断言在 `tests/web.test.ts`。
- CLI：`serve --help` 含新参数；非法参数组合在启动前失败；不要求真实 npm ci 或包示例沙箱执行。
- 回归：`tests/web.test.ts`、`tests/web-context.test.ts`、`tests/cli-workbench.test.ts`、`tests/application-packages.test.ts`、`tests/cli-packages.test.ts`。

验收命令：

```bash
npm run build
npm run check
npx vitest run tests/web-reconnect.test.ts tests/web-packages.test.ts tests/web.test.ts tests/web-context.test.ts tests/application-packages.test.ts
```

## 6. 分工与写入范围

| 角色 | 文件 |
| --- | --- |
| Lead | `docs/web-experience-batch2.md`、`README.md`、`docs/local-web.md`、`docs/capability-packages.md`、最终集成修复与验证 |
| 恢复后端 | `src/web/recovery.ts`、`src/web/server.ts`（连接/恢复路由与 state 扩展、包路由接线）、`tests/web-reconnect.test.ts` |
| 包后端 | `src/web/packages.ts`、`src/packages/registry.ts`（仅新增 `onProgress`）、`src/cli/serve.ts`、`src/cli/index.ts`（serve 参数/帮助）、`tests/web-packages.test.ts`、`tests/cli-package-serve.test.ts` |
| 工作台前端 | `src/web/workbench.ts`、`tests/web.test.ts`（只追加第二批静态断言） |

共享规范：不修改他人写入范围；不执行 `git commit`/`git reset`/`git checkout`；不删除无关文件；不并发运行 `npm run build`（会写 `dist/`），测试用 `npx vitest run <文件>`；最终由 Lead 统一运行 `npm run check` 与回归。`src/web/server.ts` 为单写者（恢复后端），包后端只提供 `packages.ts` 的接口与 CLI，不直接改 `server.ts`。

## 7. 实现状态（2026-10-23）

第二批已完成并接入本地 Web 工作台：

| 文件 | 内容 |
| --- | --- |
| `src/web/recovery.ts` | 只读恢复投影：serverId/startedAt、四类 kind、优先级排序、limit/counts、越权会话过滤、密钥脱敏 |
| `src/web/server.ts` | `/api/state` 进程身份；`/api/recovery`；能力包面板构造与 `GET /api/packages`、jobs、prepare/adopt/rollback 路由；host 开关、CSRF/同源、404 门禁；关闭时取消准备任务 |
| `src/web/packages.ts` | 诊断/默认版本/provenance/运行版本投影；prepare 单飞队列与阶段；adopt/rollback；不泄露登记路径、绑定与密钥 |
| `src/packages/registry.ts` | `prepareDependencies` 可选 `onProgress`（validating/dependencies/verifying/committing），默认行为不变 |
| `src/cli/serve.ts` | `--packages`、`--package-actions`、`--npm-cli`、`--package`；启用包得到卡片与 runtime；host-state 包身份持久化与对称匹配 |
| `src/web/workbench.ts` | 连接状态栏与重连补齐计数、重新认证/服务重启提示、恢复与核实面板、能力包开发面板（诊断/依赖进度/默认版本/运行版本）、窄屏与草稿保留 |
| `tests/web-reconnect.test.ts`、`tests/web-packages.test.ts`、`tests/cli-package-serve.test.ts`、`tests/web.test.ts` | 恢复投影/HTTP、包投影与准备队列、CLI 参数/激活/host-state、前端静态断言 |

验证结果（本机）：

- `npm run build`、`npm run check`：通过。
- 第二批相关测试（web-reconnect 7 + web-packages 12 + cli-package-serve 5 + web.test 13 + web-context 8 + web-collaboration 5 + collaboration-projection 12 + application-packages 8 + cli-workbench 4）：74 passed / 9 files。
- 全量 `npm test`（最终集成后复跑）：80 files / **1069 passed / 8 skipped**。
- 未做真实浏览器视觉/键盘人工验收；建议启动 `kodo serve --packages` 后实际点一遍断线重连、服务重启重新认证、恢复面板与依赖准备进度。

边界重申：包面板默认关闭；依赖准备与默认版本切换需要宿主开关；adopt/rollback 不执行代码、不改变运行任务；未知写入不能自动恢复；本批不包含包示例 verify、包导入/导出页面、案例管理页面或外部 Harness 接入。
