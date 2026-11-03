# Web 协作面板（Herdr 借鉴·第一批）

日期：2026-10-23。状态：实现契约，范围仅第一批“协作面板＋待处理事项＋定向交互”。本文件同时作为并行开发的分工契约；以当前仓库的内核事件、消息、等待与证据持久化为基础，不引入第二套状态机，不嵌入 Herdr 本身。

## 1. 范围

本批实现：

1. Agent 协作面板：显示目标、负责人（主/子）、执行状态、阻塞原因、最新结果、验收状态、用户是否查看。
2. 待处理事项：优先展示等待用户决定、执行失败、待核验结果；同一底层事件使用稳定 ID，重复刷新不重复提醒。
3. 定向交互：对指定子 Agent 补充要求、取消子 Agent、查看子 Agent 的消息/产物/验收/原始证据；复用现有消息、权限、CSRF、幂等回执与 SSE 机制。用户直接给子 Agent 的要求同时通知主 Agent，避免两套互相矛盾的指令。

本批不做：断线重连的完整恢复编排、能力包开发体验、外部 Harness 接入、终端模拟、Herdr 状态协议。重连仍沿用现有 SSE 持久序号重放。浏览器关闭后任务是否继续、宿主重启后的恢复核实继续由现有 `serve` 语义负责，不在面板内承诺。

## 2. 状态语义

Herdr 的 `done` 不能当作成功。Kodo 面板必须分别显示三个维度，不得合并：

| 维度 | 来源 | 显示 |
| --- | --- | --- |
| 执行是否结束 | `Run.status` 与未结束的等待 | 排队中、执行中、等待你决定、等待协作方、等待中、已结束、执行失败、已取消、执行中断 |
| 产物是否验收通过 | 结果 blob 的 `quality.status` 与会话决定版本 | 宿主验收通过、已结束但未验收、验收失败、决定版本已变化需复核 |
| 用户是否查看过结果 | 仅浏览器本地记录 | 已查看、未查看 |

约束：

- `completed` 只表示执行结束；“已结束但未验收”不是成功，也不能用“已查看”代替验收。
- 用户查看状态是界面状态，写入浏览器 `localStorage`（按会话隔离、按结果标识记录），不是内核事实，不能同步给模型或其他浏览器。界面需明确文案“仅记录本浏览器已查看，不代表验收”。
- 决定版本（`session.decisionVersion`）变化后，旧的子任务/结果标记为 stale，需要复核。stale 不算验收失败，也不自动取消。
- 待处理项使用稳定 ID（见 §5）。刷新、SSE 重放、同会话多个浏览器打开都不会产生重复条目；本批不实现通知弹窗，因此“不重复提醒”指列表状态由事件身份决定，而不是每次刷新追加一行。

## 3. 安全与边界

- 协作接口与现有接口同源、同一 cookie/CSRF/Idempotency-Key 校验；只监听 127.0.0.1。
- 定向输入只携带文本，不改变卡片、模型、权限、文件范围或预算；不能借子 Agent 绕过主 Agent 的 grant。服务端先按现有 host policy 校验锚点主任务，再校验目标必须是该主任务的直接子任务且属于同一会话。
- 给子 Agent 的定向要求与“通知主 Agent”的消息在同一 SQLite 事务提交；通知只是上下文证据，不是新的用户决定，不改变 `decisionVersion`。
- 接受定向输入后，服务异步驱动非终态的锚点主任务（会话驱动会同时唤醒排队的子任务）。这样等待子任务的主任务不会在服务重启后停在 `queued`：子任务结束后主任务继续执行并读取通知。锚点已终态或中断时退化为直接驱动目标子任务。
- 取消指定子 Agent 只终止该子任务及其下级（当前子任务不能再 spawn，实际为其自身）；主任务通过现有 `onTerminal` 通知获得终态事件。
- 结果摘要来自已持久化结果 blob，服务端会截断并替换该运行绑定中的 API key 环境变量值；不向前端发送 `binding`、`apiKeyEnv`、端点或任意 blob 引用内容。浏览器仍只能读取当前工作区、当前授权范围内的会话。
- 子任务详情复用现有 `/api/runs/:id/snapshot`、`artifacts`、`evidence` 接口及其授权校验；“用户命令发给主任务”的旧限制在定向交互中显式放宽为“锚点主任务的直接子任务”，其余写操作仍拒绝子任务。

## 4. 模块与接口

### 4.1 投影模块 `src/web/collaboration.ts`

只读、无副作用；从 `Application` 的持久状态生成面板视图。主消息不发模型调用。

```ts
export interface AgentResultView {
  available: boolean;
  summary: string;            // 已脱敏、截断（约 600 字符）
  truncated: boolean;
  quality: 'passed' | 'not_checked' | 'failed' | 'unknown';
  stale: boolean;
  resultRef: string | null;
}

export interface AgentBlockedView {
  reason: 'user_question' | 'peer' | 'timeout' | 'validation' | null;
  questionIds: string[];
  runIds: string[];
  until: number | null;       // 等待截止时间（epoch ms）
}
export interface AgentView {
  id: string;
  parentId?: string;
  role: 'main' | 'child';
  objective: string;
  status: RunStatus;
  state: 'queued' | 'running' | 'waiting_user' | 'waiting_peer' | 'waiting'
    | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  requiresValidation: boolean;
  stale: boolean;
  decisionVersion: number;
  createdAt: string;
  updatedAt: string;          // 该 run 最后事件时间，缺省 createdAt
  error: string | null;
  blocked: AgentBlockedView | null;
  result: AgentResultView | null;
}

export type PendingKind =
  | 'question' | 'failed' | 'unknown_write' | 'interrupted'
  | 'unverified_result' | 'command_failed' | 'blocked';

export type PendingAction = 'answer' | 'resume' | 'cancel' | 'view_agent' | 'inspect';

export interface PendingView {
  id: string;                 // 稳定去重 ID
  kind: PendingKind;
  severity: 'critical' | 'warning' | 'info';
  runId: string;              // 负责该事项的 Agent
  role: 'main' | 'child';
  agentObjective: string;
  title: string;
  detail: string;
  questionId?: string;
  createdAt: string;
  order: number;              // 持久序号，用于同优先级排序
  actions: PendingAction[];
}

export interface CollaborationView {
  sessionId: string;
  anchorRunId: string;        // 主任务
  decisionVersion: number;
  children: { maximum: number; created: number; active: number };
  agents: AgentView[];        // 主任务在前，其后按创建顺序的直接子任务
  pending: PendingView[];
  generatedAt: string;
}

export function collaborationView(app: Application, runId: string): CollaborationView;
```

锚定规则：传入任意本会话 run；若为子任务则取其 `parentId` 对应主任务为锚点。`agents` 包含锚点主任务与其直接子任务；其他根任务（后续任务续接）不属于当前面板。`pending` 只统计这些 Agent 的事件。同一底层事件只出现一次（按稳定 ID 去重）。`children` 计数按会话范围统计（会话内所有有 `parentId` 的 run），因为 `session.budget.maxChildren` 是会话共享额度。

### 4.2 HTTP 接口

| 方法与路径 | 请求 | 响应 | 说明 |
| --- | --- | --- | --- |
| `GET /api/runs/:id/collaboration` | — | `CollaborationView` | 任意本会话 run；读，无副作用；走现有认证 |
| `POST /api/runs/:id/agents/:agentId/input` | `{ content }`，1–16000 字符 | 202 `{ requestId, runId, sessionId, agentRunId, status: 'accepted' }` | `:id` 必须为主任务（host policy 锚点）；`:agentId` 必须是其直接子任务；同一 `Idempotency-Key` 重放返回原回执，不重复写入 |
| `POST /api/runs/:id/agents/:agentId/cancel` | `{}` | 202 `{ requestId, runId, sessionId, agentRunId, status }` | 取消指定直接子任务；幂等；不取消主任务 |

错误码沿用现有 Web 适配器映射：Host/Origin/CSRF/host policy 为 403，目标不存在为 404，其余业务校验错误（`MAIN_RUN`、`AGENT_TARGET`、`SESSION_DENIED`、`RUN_ENDED` 等）为 400。`agent_input` 回执的 `status` 固定为 `accepted`（接受不代表执行完成）；`agent_cancel` 的 `status` 是取消后目标状态，重复取消返回当前终态。

复用：`GET /api/runs/:id/snapshot`（子任务详情，返回其自身 run/calls/events/result）、`/artifacts`、`/evidence/:callId`、`POST /api/runs/:id/answer`（回答问题）、`/input`（给主任务补充要求）、`/cancel`、`/resume`、`/events` SSE。

重启续接：`web_requests` 中 `action='agent_input'` 的行，服务重启时从已保存回执取 `agentRunId`，若目标仍为 `queued`/`waiting` 则重新驱动它；`agent_cancel` 不同步重放。回执 `runId` 保存锚点主任务 ID，保证幂等重放仍可按 host policy 校验。

### 4.3 Application 方法

```ts
/** 用户直接向锚点主任务的直接子任务补充要求；同事务通知主任务。 */
submitAgentInput(mainRunId: string, agentRunId: string, content: string): {
  messageId: string; agent: Run; main: Run;
};

/** 取消锚点主任务管理的直接子任务；终态幂等返回当前记录。 */
cancelAgent(mainRunId: string, agentRunId: string): Run;
```

校验与副作用：

- `content` 去空白后 1–16000 字符；空输入拒绝。
- 目标必须同会话、`parentId === mainRunId`；对已结束或 `interrupted` 子任务发送定向输入抛 `RUN_ENDED`（中断任务需要显式恢复，不能安全唤醒）；取消已结束子任务直接返回。
- `submitAgentInput` 事务内写两条 Envelope：`user -> 子任务` `kind='input'`；`user -> 主任务` `kind='notice'`，内容包含子任务目标与用户补充要求，提示主 Agent 对齐指令、不要给出相反要求。随后 `mailbox.refresh(agentRunId)`，使等待中的子任务被唤醒。另记录 `user.agent_input` 事件到子任务与主任务，作为审计证据。
- `cancelAgent` 调用 `coordinator.cancel(agentRunId)`，沿用现有终态通知、已启动写入不确定性与子级级联规则。
- 不改变 `decisionVersion`，不改变任何权限/预算/卡片。

## 5. 待处理事项规则

| kind | 触发 | 稳定 ID | severity | actions |
| --- | --- | --- | --- | --- |
| `question` | 面板 Agent 未回答的 `to='user'` 问题 | `question:<messageId>` | warning | `answer`, `view_agent` |
| `failed` | Agent `failed` 且非 `UNKNOWN_WRITE` | `failed:<runId>` | critical | `view_agent`, `inspect` |
| `unknown_write` | Agent `failed` 且 `error` 以 `UNKNOWN_WRITE` 开头 | `unknown_write:<runId>` | critical | `view_agent`, `inspect`（禁止自动恢复） |
| `interrupted` | Agent `interrupted` | `interrupted:<runId>` | warning | `resume`（仅主任务）, `view_agent`, `inspect` |
| `unverified_result` | Agent `completed` 且 `resultRef` 存在、`quality.status !== 'passed'`；stale 时 detail 标复核 | `unverified_result:<runId>:<resultRef>` | info（stale 升 warning） | `view_agent`, `inspect` |
| `command_failed` | 该 Agent 最新持久事件为 `web.command_failed` | `command_failed:<runId>:<eventSeq>` | warning | `view_agent`, `inspect` |
| `blocked` | 该 Agent 非终态且有最近一次 `wait.deadlock` 事件 | `blocked:<runId>:<eventSeq>` | warning | `view_agent` |

排序：severity（critical → warning → info），同级按 `order` 降序（较新在前），再按 ID 字典序保证确定性。`question` 的 `order` 取消息 seq；事件类取事件 seq；`failed`/`interrupted` 取最后事件 seq；结果类取最后事件 seq。重复读取不产生重复项。终态的 Agent 不再因历史 `wait.deadlock` 产生阻塞项。

`unverified_result` 的“用户是否查看”由前端本地状态补充；查看不会从 `pending` 删除该项，也不会把它标成验收通过。界面可提供“只看未查看”过滤与“标记已查看”按钮。

## 6. Agent 视图规则

- `state`：终态直接用 status；`waiting` 时若注册 wait 中有未回答的 `to='user'` 问题 → `waiting_user`；否则有 peer 依赖 → `waiting_peer`；无 wait 信息 → `waiting`；`interrupted` 保留。
- `blocked`：从 `run.waitId` 对应注册 wait 推导；`questionIds` 为未回答的用户问题；`runIds` 为未终态协作对象；`until` 为 wait deadline；`reason` 优先级为 `validation`（`failed` 且 `UNKNOWN_WRITE`）→ `user_question` → `peer` → `timeout`（截止已过且无用户问题/peer 依赖）→ `null`。
- `result`：读 `resultRef` blob；探索类 run 取结果 JSON 的 `summary` 作为摘要；`quality` 取 blob `quality.status === 'passed'` 为通过，`failed` 为失败，其余为未验收；blob 缺失或不可读时返回 `available: false`、`quality: 'unknown'`，不抛出；已结束 run 仍会产生待核验项。摘要做密钥替换与 surrogate 安全截断。
- `updatedAt` 取该 run 最后一条持久事件时间。
- 不返回 `binding` 或结果 blob 全文；详情页通过既有 snapshot/evidence 接口按需读取。

## 7. 前端行为

工作台保持“用户主要与主 Agent 交互”，协作信息默认收起，不干扰主对话：

1. 工具栏新增“协作”按钮与待处理计数徽标（计入未查看的待处理项；已查看的 `unverified_result` 不计入徽标，但仍列在面板）。
2. 点击打开右侧检查器（复用现有 `#evidence` 面板），显示“待处理”和“执行团队”：
   - 待处理项：类型、级别、负责 Agent、原因、可用动作；回答问题可直接在项内提交（复用 `/answer`），恢复仅主任务可用。
   - 团队卡片：主/子标识、目标、执行状态、阻塞对象（等待用户/等待哪些子任务/超时）、结果摘要、验收状态、查看状态；动作“查看详情”“补充要求”“取消”。
   - 给子 Agent 补充要求：内联表单，提交到定向接口；文案提示会同时通知主 Agent、避免相反指令。
3. 任务详情：显示该 Agent 的“执行/验收/查看”三项；目标、结果摘要与完整结果（按需展开）、与该 Agent 相关的消息、工具调用证据（点击加载）、产物（按 run 过滤）、原始事件（折叠）。打开详情或点击“标记已查看”时写本地查看状态；不产生验收。
4. 刷新：SSE 收到本会话事件后仍用现有防抖刷新主快照，同时刷新协作视图；面板打开时重绘并保留未提交表单草稿与焦点。窄屏与键盘操作沿用现有规则；所有模型/用户文本以 `textContent` 呈现，禁止 `innerHTML`。
5. 状态文案：不得把“完成”写成“成功”；“验收通过”只来自宿主 validator；查看状态注明仅本浏览器。

## 8. 测试与验收

新增测试（目标）：

- `tests/collaboration-projection.test.ts`：构造问用户、失败、未知写入、中断、完成未验收、stale、命令失败、死锁等待等状态，断言 agents/pending 字段、稳定 ID、重复调用不重复、排序确定、不泄露 binding。
- `tests/web-collaboration.test.ts`：HTTP 认证/CSRF/幂等；定向输入写子任务与主任务通知、唤醒等待、重复请求不重复；定向取消只影响目标；子任务详情与证据可读；越权（非直接子任务、跨会话）拒绝；重启后 `agent_input` 续接；静态资源仍无 HTML 注入面。
- 静态前端断言扩展：协作面板文案、调用 `/collaboration`、`localStorage` 查看记录、无 `innerHTML`/`onclick`。

验收命令：

```bash
npm run build
npx vitest run tests/collaboration-projection.test.ts tests/web-collaboration.test.ts tests/web.test.ts
npm run check
```

回归：`npx vitest run tests/web-context.test.ts tests/inspection.test.ts tests/cli-workbench.test.ts`。真实模型行为不是本批验收条件；界面状态必须与持久事件一致。

## 9. 分工与写入范围

| 角色 | 文件 |
| --- | --- |
| Lead | `docs/web-collaboration.md`、`README.md`、`docs/local-web.md`、最终集成修复与验证 |
| 投影 | `src/web/collaboration.ts`、`tests/collaboration-projection.test.ts` |
| 内核+服务端 | `src/application/index.ts`、`src/web/server.ts`、`tests/web-collaboration.test.ts` |
| 前端工作台 | `src/web/workbench.ts`、`tests/web.test.ts`（只追加协作面板静态断言） |

共享规范：不修改他人写入范围；不执行 `git commit`/`git reset`/`git checkout`；不删除无关文件；不并发运行 `npm run build`（会写 `dist/`），测试用 `npx vitest run <文件>`；最终由 Lead 统一运行 `npm run check` 与回归。

## 10. 实现状态（2026-10-23）

第一批已完成并接入本地 Web 工作台：

| 文件 | 内容 |
| --- | --- |
| `src/web/collaboration.ts` | 只读协作视图投影：anchors、agents、blocked、result、七类 pending、稳定 ID/去重/排序、脱敏与截断 |
| `src/web/server.ts` | `GET /api/runs/:id/collaboration`；`POST .../agents/:agentId/input`、`.../cancel`；host policy/CSRF/幂等回执；定向输入后驱动锚点主任务；重启按回执续接且不重放取消 |
| `src/application/index.ts` | `submitAgentInput`（child input + main notice + 审计事件 + 唤醒，同事务）与 `cancelAgent`（终态幂等） |
| `src/web/workbench.ts` | 工具栏“协作”按钮与徽标；待处理/执行团队面板；Agent 详情三态、消息/证据/产物/事件；定向补充与取消；localStorage 查看记录；SSE 同步刷新与草稿保留 |
| `README.md`、`docs/local-web.md` | 能力与接口说明 |
| `tests/collaboration-projection.test.ts`、`tests/web-collaboration.test.ts`、`tests/web.test.ts` | 投影、HTTP 定向交互/重启/越权、前端静态安全断言 |

验证结果（本机）：

- `npm run build`：通过。
- `npm run check`：通过（tsc strict + eslint）。
- `npx vitest run tests/collaboration-projection.test.ts tests/web-collaboration.test.ts tests/web.test.ts tests/web-context.test.ts tests/inspection.test.ts tests/cli-workbench.test.ts`：52 passed / 6 files。
- 定向输入测试额外重复运行 4 次，5/5 稳定通过。
- 未做真实浏览器视觉/键盘人工验收；窄屏与提示文案以静态断言和既有样式约束为准。

边界重申：本批只交付协作显示与定向控制，不改变内核任务状态机、权限模型与上下文组装策略；未实现断线重连编排、能力包开发体验与外部 Harness 接入。
