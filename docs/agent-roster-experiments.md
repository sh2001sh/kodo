# agent-roster-v1 实验运行器

入口是 `scripts/comparison/agent-roster-v1.mjs`。采用率和固定团队收益是两个独立矩阵，不与 r10 直接比较。运行器不会自动发起模型请求：必须明确指定 `--run`；`--dry-run` 只冻结任务文件、生成注册记录和矩阵。

任务清单是 JSON，按 `ky`、`frontend-backend` 顺序声明两个已经准备好的工作区。源码目录相对于清单文件解析；输出目录必须在源码目录之外，且为空。接受验收的命令由清单固定，模型无法修改运行器中的命令配置；验收脚本本身应列入 `protected`。

```json
{
  "tasks": [
    {
      "id": "ky",
      "source": "./fixtures/ky",
      "objective": "填写完整、冻结的 ky 任务要求。",
      "acceptance": { "program": "$node", "args": ["verify.mjs"] },
      "protected": ["verify.mjs"],
      "projectRoots": { "project.tests": ["test"] }
    },
    {
      "id": "frontend-backend",
      "source": "./fixtures/frontend-backend",
      "objective": "填写前后端接口已经约定、写入范围可分离的任务要求。",
      "acceptance": { "program": "$node", "args": ["verify.mjs"] },
      "protected": ["verify.mjs"],
      "projectRoots": { "project.tests": ["tests"] }
    }
  ]
}
```

先执行离线注册检查：

```sh
node scripts/comparison/agent-roster-v1.mjs --dry-run --manifest tasks.json --out results/roster-dry --models first-model,second-model --repeats 2
```

第一个模型有 R0、RA、RB、RC、RABC 五组，第二个模型只有 R0、RABC；每个任务内重复轮次交替组顺序。至少两次重复时，共 28 个单元。样本不足、矩阵不完整或离线运行时，报告标记为描述性结果，不据此声明因果或显著性。

固定团队收益矩阵使用 `--kind benefit`。每个任务还必须提供 `team`，内容与 `createRun({ team })` 的请求数组相同。两个模型各比较 `solo` 与 `fixed-team`，两次重复共 16 个单元。两组均不向模型提供自主启动子 agent 的工具，固定团队仅由宿主创建。

固定团队矩阵同时隐藏 `followup_task`，避免模型自主新增队友任务轮次改变固定分工。自主续接与复用行为应在采用矩阵观察。

必填 artifact 槽可以引用任务的 `contracts`，例如以下任务字段：

```json
{
  "contracts": { "behavior": "GET /status 返回 HTTP 200 和 JSON {\"status\":\"ok\"}；页面展示 status 文本。" },
  "team": [
    { "agent": "kodo/implementer", "objective": "实现状态接口。", "scope": { "write": ["server"] }, "slots": { "requirement": "实现约定的状态接口。", "contract": "$contract:behavior" } },
    { "agent": "kodo/tester", "objective": "按已确定契约补充测试。", "slots": { "behavior_contract": "$contract:behavior" } }
  ]
}
```

运行器在 `createRun` 的同步 team 回调中创建同会话的不可变 contract artifact，把 `$contract:behavior` 替换为真实 ID，再提交成员请求。同一契约只创建一次，缺失引用直接报错。契约全文也追加到两组共同的主任务中，使 solo 与 fixed-team 收到相同的行为要求。测试目录由 `projectRoots` 中的 `project.tests` 声明；成员仍必须满足输入槽、权限和不重叠写范围约束。这是运行配置示例，尚未执行付费模型实验。

可选任务字段 `permissions` 指定会话权限，`verification` 接收宿主 `VerificationPolicy` 配置，供 reviewer 使用 `verify.run`。成员不可用会保留真实原因，不静默替换为其他角色。

实际模型实验要求先构建当前代码，并在环境中设置 `KODO_API_KEY` 与 `KODO_BASE_URL`，再使用新的输出目录和 `--run`。`--max-calls`、`--max-tokens`、`--max-duration` 控制单元上限；`--matrix-calls`、`--matrix-tokens` 控制整个矩阵上限。超出预算或单元执行错误会停止后续单元。

输出包含冻结任务、`registration.json`、逐单元状态和结果、模型调用记录、`summary.json`。指标包括委派次数、成员类型、目录和搜索调用及条目数、首次选择位置、发现预算耗尽、输入槽错误、报告纠正、质量验收、token、Agent 时间、主输入峰值、`child.prefix_shared` 与 `cacheRead`。采用率上升不代表固定团队收益成立。

续接相关指标按“调用、运行、代理身份”分开统计：

| 指标 | 口径 |
|---|---|
| `delegationCalls` | 保留原口径：`spawn_agent` 与 `explore` 调用次数，不混入续接 |
| `followupCalls` / `successfulFollowupCalls` | `followup_task` 总调用次数及成功调用次数；重试仍属于调用 |
| `spawnedChildren` | 保留原口径：收集到的子 run 数量，包含续接，不代表新代理身份数 |
| `childRuns` | 按 run ID 去重后的子运行数 |
| `distinctChildAgents` | 按稳定 `agentId` 去重；旧记录仅沿同父运行、同会话且前驱终态的续接链归并 |
| `followupRuns` | 成功续接调用或持久 `agent.followup` 事件所指向的实际子 run，按 run ID 去重 |
| `reusedChildAgents` | 上述续接运行涉及的不同代理身份数 |

同一运行同时出现在工具返回和事件中、或者幂等重试返回同一运行，都只计一次实际续接。相同卡片创建的两个队友仍是两个代理；遗留 `continuation_of` 或恢复运行不会仅凭该字段被算作一次 `followup_task` 派发。历史结果缺少新增指标时不据此补填零。

离线验证命令：

```sh
node --test scripts/comparison/agent-roster-v1.test.mjs
```
