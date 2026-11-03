# 本地 Web 工作台

工作台复用 `Application`，提供任务列表、对话、补充输入、待回答问题、取消、显式恢复、执行证据，以及协作面板：待处理事项、执行团队和目标 Agent 的定向交互。浏览器界面使用中文，支持窄屏布局和键盘操作。模型与用户文本以纯文本显示，保留换行；不把 Markdown 或 HTML 注入页面。

协作面板把“执行是否结束”“产物是否验收通过”“用户是否查看过结果”分开显示：`completed` 只表示运行结束，验收状态只取宿主 validator 的 `quality.status`，查看状态只记录在本浏览器 `localStorage`，不写回内核。待处理项按稳定事件 ID 去重，同一底层事件刷新或 SSE 重放不会重复追加；问题、失败、未知写入、中断、完成未验收和协作死锁分别给出可采取动作。用户可以直接向指定子 Agent 补充要求或取消它；定向补充在同一事务内通知主 Agent，但不改变决定版本、权限、模型或预算，也不能绕过主任务的授权边界。详见 [Web 协作面板](web-collaboration.md)。

宿主通过 `createLocalServer` 启动服务：

```ts
import { Application, createLocalServer } from 'kodo-local';

const app = new Application('/path/to/private-state');
const server = await createLocalServer(app, {
  workspace: '/path/to/project',
  binding: { model: 'your-model', baseURL: 'https://your-provider/v1', apiKeyEnv: 'MODEL_API_KEY' },
  permissions: ['read'],
  port: 0,
});
console.log(server.origin);         // http://127.0.0.1:<分配端口>
console.log(server.startupSecret);  // 只在可信终端显示，随后在页面中粘贴

// 退出顺序：停止接收 HTTP，再结束内核运行、关闭存储。
await server.close();
await app.shutdown();
```

`workspace`、模型绑定、权限、文件范围、预算和卡片都来自宿主配置。HTTP 客户端只能提交目标与输入，不能改变这些配置。默认可以查看固定工作区中的会话；`sessionIds` 可进一步限定已有会话，新建会话也会保留访问资格。对已有任务执行命令前，服务核对其模型绑定、会话权限、文件范围和宿主指定卡片，拒绝超出当前配置的操作。子任务默认只展示证据与状态；用户可以通过定向接口对锚点主任务的直接子任务补充要求或取消它，其余用户命令仍发给主任务，定向接口不改变任何宿主授权。启动参数可带实验性的 `--compaction ...`；该策略只影响本进程创建的新会话，已有会话要求相同的本地执行绑定，不能在浏览器请求中更换。

宿主可提供同步 `onSession(sessionId)` 回调，记录或核对 shell、网络、语言服务、沙箱等不可移植配置。回调在创建与写命令接受前、以及异步执行和启动续接前调用；抛出错误即拒绝操作。CLI 应使用此回调保留本地执行绑定，不能通过浏览器请求更换配置。

服务只监听 `127.0.0.1`，不支持外部监听地址。Host 必须精确匹配启动时的地址与端口；出现 Origin 时也必须精确匹配，写入必须带 Origin。首次 `POST /api/auth` 在 JSON 正文中交换一次性密钥，返回 `HttpOnly; SameSite=Strict` 的浏览器 cookie 和 CSRF 令牌；秘密不放进 URL。cookie 仅用于此进程，12 小时后失效。浏览器重载使用已有 cookie 重新读取 CSRF；若 cookie 丢失或过期，应重启服务生成新密钥。HTTP 是本机明文连接，因此 cookie 未设置只适用于 HTTPS 的 Secure 属性。

所有写命令需要 `X-Kodo-CSRF` 及 `Idempotency-Key`。后者由 8–128 个字母、数字、短横线或下划线组成；工作台自动生成，并在网络失败重试时复用。命令接受回执与同步状态变更保存在同一个 SQLite 事务中，相同请求 ID 与相同 JSON 请求会返回原回执，换内容返回 409。回执表示已接受，不代表任务成功；最终结果和异步失败看持久事件。进程重启会重新推进已接受的排队任务；普通执行中断仍需显式恢复，已接受的恢复命令可以继续核实恢复，不会绕过未知写入保护。调用者应保留请求 ID，不能通过更换 ID 来掩盖不确定的写入结果。

接口均位于同源 `/api` 下：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/auth` | 正文 `{ secret }` 交换启动密钥 |
| `GET /api/state` | 当前工作区、权限与 CSRF，以及本地服务进程 `serverId`/`startedAt`（用于界面判断服务是否重启） |
| `GET /api/sessions`、`GET /api/runs` | `after`、`limit` 分页；任务可按 `sessionId` 过滤 |
| `GET /api/runs/:id/snapshot` | 主任务、同会话协作状态、消息、问题与结果 |
| `GET /api/runs/:id/collaboration` | 协作面板投影：主/子 Agent 状态、阻塞、结果与待处理事项；任意本会话 run 均锚定到其主任务 |
| `GET /api/runs/:id/agent-drafts` | 当前会话的保留草稿与来源证据 |
| `POST /api/runs/:id/agent-drafts/:draftId/approve` | `{ digest }` 明确保留当前内容；主任务结束后可用 |
| `POST /api/runs/:id/agent-drafts/:draftId/discard`、`skip` | `{ digest }` 丢弃或暂时跳过；跳过仍保留草稿 |
| `POST /api/runs/:id/agent-drafts/:draftId/edit` | `{ digest, metadata: { name?, catalog?, routing?, reason? } }` 更新草稿，须重新确认 |
| `POST /api/runs/:id/agents/spawn` | `{ agent, objective, slots?, inputs?, acceptance?, scope? }` 通过统一宿主路径创建直接子任务 |
| `GET /api/runs/:id/events?after=:seq` | 同会话 SSE 事件；支持 `Last-Event-ID` 重放 |
| `GET /api/recovery` | 恢复与核实事项：返回有访问资格的会话中 `interrupted`、`UNKNOWN_WRITE` 失败、最新 `web.command_failed` 与排队中的运行；只读，不自动恢复 |
| `GET /api/runs/:id/artifacts` | 本会话产物 ID 列表 |
| `GET /api/runs/:id/artifacts/:artifactId` | 按已登记 ID 读取同会话产物，不能读取任意路径或 blob |
| `GET /api/runs/:id/evidence/:callId` | 本任务调用的请求与结果证据 |
| `POST /api/runs` | 正文 `{ objective }` 新建并执行任务 |
| `POST /api/runs/:id/input` | `{ content, mode?, decision? }` 补充或创建后续任务 |
| `POST /api/runs/:id/agents/:agentId/input` | `{ content }` 向该主任务的直接子任务定向补充要求；同事务通知主任务，不能用于已结束的子任务 |
| `POST /api/runs/:id/agents/:agentId/cancel` | `{}` 取消该主任务的直接子任务；终态幂等，不取消主任务 |
| `POST /api/runs/:id/answer` | `{ questionId, content }` 回答同会话问题 |
| `POST /api/runs/:id/cancel` | `{}` 取消任务及其子任务 |
| `POST /api/runs/:id/resume` | `{}` 显式恢复中断任务；未知写入仍需宿主核实 |
| `GET /api/packages` | 能力包开发面板数据：兼容性诊断、依赖准备状态、默认版本与可访问任务使用的卡片/包版本；宿主未开启时返回 `enabled:false` |
| `GET /api/packages/jobs/:jobId` | 依赖准备任务状态与阶段（只在宿主开启 `prepare` 时创建） |
| `POST /api/packages/:id/:version/prepare` | `{}` 在宿主批准的沙箱内准备依赖（`npm ci --ignore-scripts --omit=dev`）；需要宿主开启 `prepare` |
| `POST /api/packages/:id/adopt` | `{ version }` 切换默认版本指针；不执行代码、不修改已有运行、不自动启用；需要宿主开启 `adopt` |
| `POST /api/packages/:id/rollback` | `{}` 回退此前采用的默认版本指针；需要宿主开启 `adopt` |

SSE 事件序号来自 SQLite，浏览器重连使用最后收到的序号补齐。连接关闭时取消订阅与心跳；慢消费者超过 1 MiB 待发送数据会断开，让客户端从持久序号重连。当前内核在模型轮次完成后保存回复，工作台随事件更新正文；宿主若将流式文本作为 `web.text` 事件持久化，也可逐段显示，完整模型响应仍作为最终依据。

工作台把连接状态显式展示出来：已连接、重新连接中、已重新连接并补齐遗漏事件、服务重启后需要重新认证、无法连接。浏览器关闭不中断执行，只是失去 SSE 订阅；重新打开后按持久序号补齐并刷新快照。`kodo serve` 进程退出会中断执行中的任务，重启后已接受的排队任务由宿主继续推进，`interrupted` 必须显式恢复，`UNKNOWN_WRITE` 必须核实后才能恢复。`/api/recovery` 只汇总当前服务有访问资格会话中的这些事项；重连、恢复或取消后工作台会刷新计数和内容。`serverId` 只用于判断服务是否更换，不代表任务状态或验收。

宿主通过 `createLocalServer(..., { packages: { enabled: true, ... } })` 或 CLI `serve --packages` 显式开启能力包开发面板；`prepare` 与 `adopt` 分别需要单独开关。面板展示兼容性诊断、依赖准备状态/进度、默认版本、当前 Web 服务启用的包版本，以及有访问资格任务使用的卡片版本。`adopt/rollback` 只切换默认版本指针，不执行代码、不修改现有运行、不自动启用；依赖准备在宿主批准的沙箱中执行 `npm ci --ignore-scripts --omit=dev`，需要网络；两者都不授予模型工具、权限或验收。未开启 `/api/packages` 的宿主返回 `enabled:false`，相关写路由返回 404，浏览器不能自行扩大开关。`serve --package author/name[@version]` 显式启用包后，Web 新任务使用该包卡片并在运行版本中展示；切换默认版本不会改变已运行任务。

`/api/runs/:id/collaboration` 与定向写接口仍要求同一 cookie、Host/Origin 与 CSRF；定向写命令要求 `Idempotency-Key`，回执与写入在同一 SQLite 事务提交。`:id` 是宿主策略校验的锚点主任务，`:agentId` 必须是其直接子任务；重启时按已保存回执继续驱动仍未完成的定向输入，定向取消不重放。子任务详情复用 `/snapshot`、`/artifacts`、`/evidence`，浏览器仍只能读取当前工作区和授权范围内的会话，响应不含模型密钥或端点绑定。

验证命令：`npx vitest run tests/web.test.ts tests/web-context.test.ts tests/web-reconnect.test.ts tests/web-packages.test.ts tests/web-collaboration.test.ts tests/collaboration-projection.test.ts`。覆盖实际 HTTP 鉴权、Host/Origin/CSRF 拒绝、重复请求与重启、跨工作区与产物拒绝、固定宿主权限、问题回答、取消、定向输入/取消、协作投影、连接恢复投影、能力包诊断/依赖准备/版本指针、SSE 持久重放与纯文本输出边界。该工作台是单用户本机入口，没有多租户、互联网部署或远程代理认证。

## 保留可复用的 Agent

主任务结束并显示最终答复后，协作面板会列出 `agent_proposal` 待处理项。面板分别展示报告完整性、宿主验收和主任务验收；未记录的验收保持“未记录”，不会因任务结束或用户查看过而变成通过。展开“查看将保留的方法与能力”可核对完整卡片，再选择保留、丢弃或暂时跳过。

“编辑名称与适用范围”可修改名称、目录路径与适用任务。保存编辑只更新草稿，必须对新版本再次点击保留。每个动作携带当前草稿 digest，沿用写命令的浏览器认证和幂等回执。草稿来源限定在当前会话，批准只登记对应内容，不改变已有运行绑定或当前会话快照。

连续跳过两次后，后续草稿不再增加主动待处理提示；它们仍可从协作面板的“已保存的 Agent 草稿”展开查看和批准。`kodo serve --agent-retention off` 不生成保留提议；没有自动保留模式。新批准的卡片仅在下一次会话进入名册。
