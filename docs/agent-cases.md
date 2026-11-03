# 可执行 Agent 案例与采用证据

案例固定任务、输入文件、数据和断言。同一案例版本不可修改；输入、任务或断言变化必须增加版本。运行结果保存在应用数据库的 `case_runs` 表中，失败和进程中断也保留。案例身份另在 `case_definitions` 表中锁定。

## 案例格式

```json
{
  "schema_version": 1,
  "id": "reports/count",
  "version": "1.0.0",
  "name": "统计冻结输入",
  "objective": "读取 input.json，把项目数写入 result.json，并返回相同的 JSON。",
  "inputs": {
    "files": [{ "path": "input.json", "content": "{\"items\":[1,2,3]}" }],
    "data": { "outputFile": "result.json" }
  },
  "assertions": [
    { "type": "json", "source": "file", "path": "result.json", "pointer": "/count", "equals": 3 },
    { "type": "json", "source": "output", "pointer": "/count", "equals": 3 },
    { "type": "file", "path": "unexpected.txt", "exists": false }
  ],
  "timeoutMs": 120000
}
```

支持的断言：

| 类型 | 验证内容 |
| --- | --- |
| `output` | 正文与 `equals` 严格相等 |
| `file` | 普通文件存在/不存在，或 UTF-8 正文与 `equals` 相等，或原始文件字节的 `sha256` 相等 |
| `json` | 解析正文/文件，通过 RFC 6901 `pointer` 取值，与 `equals` 作 JSON 结构比较；对象键顺序不影响结果 |
| `command` | 执行宿主预先配置的具名命令，比较退出码和可选的完整标准输出 |

每个案例至少一条断言，最多 100 条；输入最多 100 个文件。案例 JSON 上限 4 MB，单文件输入/正文断言上限 1 MB，断言读取文件上限 1 MB，任务运行上限 10 分钟。路径必须是可移植相对路径，不能穿越目录；文件检查遵守宿主读取范围，并拒绝指向工作区外的链接。

## 运行、比较和采用

```sh
kodo case run ./count.case.json --package author/counter@1.0.0 --allow-write --data-dir ./state --model MODEL --base-url URL
kodo case run ./count.case.json --package author/counter@2.0.0 --allow-write --data-dir ./state --model MODEL --base-url URL
kodo case list --package author/counter@2.0.0 --limit 20 --data-dir ./state
kodo case inspect CANDIDATE_RUN_ID --data-dir ./state
kodo case compare BASELINE_RUN_ID CANDIDATE_RUN_ID --data-dir ./state
kodo case adopt author/counter@2.0.0 --runs CANDIDATE_RUN_ID --data-dir ./state
kodo case rollback author/counter --runs PREVIOUS_VERSION_NEW_RUN_ID --data-dir ./state
```

每次运行创建新的临时工作区，运行前必须为空，随后写入冻结输入。工作区路径随结果返回，方便检查产物，运行结束后保留。CLI 固定授予读取权限；写入冻结文件和产物需要 `--allow-write`，执行命令需要 `--allow-exec`。模型任务默认最多 30 次模型调用、100 次工具调用，并共享案例超时。案例正文不能提升权限。

CLI 运行启用操作系统沙箱并禁用网络；模型服务仍由宿主访问。系统没有可用沙箱时，需要沙箱执行的工具/断言会明确失败，不降级执行。包声明的旧版工具示例在显式激活时仍按原有验收逻辑运行。

`case compare` 要求案例摘要、冻结输入摘要、包 ID、模型条件和环境条件一致；包版本和摘要允许不同。记录包含 Node.js/操作系统/架构、模型与协议、宿主权限与文件范围、命令策略及宿主策略摘要。`--environment-label` 可标识其他宿主条件，例如固定数据集或工具服务环境；包绑定配置变化也会影响条件摘要。凭据值和凭据环境变量名不写入案例条件。

`case adopt`/`rollback` 重新检查包文件及摘要，要求：

1. 所有提供的候选运行都通过，并属于目标版本、包摘要和卡片摘要。
2. 条件摘要一致，且使用每个案例的最新运行；新的失败结果使之前的成功结果不能继续用于采用。
3. 已有采用版本时，它必须具有同条件基准；候选必须覆盖其全部案例，逐一比较且全部通过。
4. 通过后才原子更新本地指针，同时保存运行 ID、比较基准 ID 和条件摘要。操作不会执行包代码。

SDK 的 `PackageRegistry.adoptVerified()` 还接受 `requiredCases`，宿主可以指定必须覆盖的案例集合。测试集合的充分性仍由宿主决定；单个断言通过不能证明任意任务正确。原有 `package adopt`/`rollback` 与 SDK `adopt()`/`rollback()` 保留为兼容的底层指针接口，不声称经过案例验收。

## 宿主命令策略

案例只能引用命令名称，不能传入程序或追加参数。宿主通过显式 `--commands` 参数加载可信策略文件；不要把待评估包内的策略当成授权。

```json
{
  "unit": {
    "program": "/absolute/path/to/node",
    "args": ["--test", "acceptance.test.mjs"],
    "write": false
  }
}
```

对应断言为 `{"type":"command","command":"unit","exitCode":0}`。宿主程序必须是绝对路径，参数固定；命令始终在无网络操作系统沙箱内执行。`write: true` 还需要宿主授予写入权限。超时、信号终止、输出截断或输出超限均不能通过验收。

## 嵌入宿主

从公共应用入口导入 `CaseRunStore`、`runCase`、`freezeCase` 和 `compareCaseRuns`。`CaseRunStore` 复用 `Application.store.db`，不改变核心数据库版本。`runCase` 接受一个受信 `execute` 回调：宿主按固定目标卡片创建任务，传递权限与范围，监听 `signal` 并取消实际运行，返回真实运行状态与正文。

`hostPolicyDigest` 必须标识当前工具/模型路由等宿主配置；不要用常量跨不同配置伪造可比条件。SDK 调用方还负责确保工作区不是运行时私有存储。CLI 使用独立临时目录满足这一点。

`CaseRunStore.interruptRunning()` 仅应在确认上一个执行进程已退出后调用；CLI 获得应用数据锁后执行这一处理。中断记录不会变成成功，也不会自动重放任务。完成证据禁止修改，读取时校验内容摘要；该校验用于发现损坏，不能对抗能改写数据库及摘要的宿主管理员。

验证命令：

```sh
npx vitest run tests/cases.test.ts tests/package-cases.test.ts tests/cases-cli.test.ts
```

覆盖真实应用调用、HTTP 模型协议、CLI 运行/比较/采用、实际沙箱命令的成功与非零退出，以及失败结果、超时、权限、文件范围、链接越界、案例版本冲突、证据损坏、重启中断、回归与过期成功证据。
