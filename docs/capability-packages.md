# 能力包分发与启用

能力包是包含清单与资源的 ZIP。它把一张代理卡片、Skill、隔离执行的自定义工具和 MCP 模板交给另一个本地宿主；导入只校验和登记。登记目录、凭据绑定、依赖准备结果、验收记录和采用版本属于接收端，不会随包再次导出。

## 运行完整例子

```powershell
npm run demo:package
```

这会执行 [文本统计能力包](../examples/capability-package/README.md) 的 ZIP 导出、两个独立登记目录的导入与重新导出，再显式启用。三个确定性例子使用真实操作系统沙箱执行 JavaScript 工具，覆盖空输入、ASCII 多行及 Unicode/CRLF。随后脚本模型通过真实内核循环加载 Skill、提交并记录无效参数失败、调用工具，并由宿主检查持久化结果。不调用模型 API。

只验证归档格式可运行 `npm run build` 后执行 `node scripts/demo-capability-package.mjs --archive-only`。此模式不会启用任何代码，不能作为沙箱或工具运行成功的证据。脚本打印保存 ZIP、登记目录与证据的临时目录。

## 包格式

`AGENT.md` 是固定的代理身份与行为入口；其 front matter 定义 `id: author/name`、三段数字版本、工具与 Skill 允许列表。包身份来自该文件，清单不再重复维护一份名称或行为提示词。

`CAPABILITY.json` 使用 `schema_version: 1`，包含：

| 字段 | 含义 |
| --- | --- |
| `license`、`source.url` | 分发许可证与不带凭据的 HTTP(S) 来源；可附 `source.revision` |
| `files` | 每个允许分发的相对路径、SHA-256、字节数与 `distributable: true` |
| `resources.skills` | Skill ID、入口与其附加资源引用 |
| `resources.tools` | 工具名称、`kodo-tool/v1` JSON 描述入口与 JavaScript 模块入口 |
| `resources.mcp` | 本地 Node stdio 入口或远端 HTTP 模板，以及宿主认可的逐工具权限/副作用声明 |
| `requirements` | Node 版本条件、操作系统、架构与显式依赖声明 |
| `examples` | 验收名称、输入与预期结果；启用时必须由宿主实际核验 |

源目录导出声明可以省略文件摘要和长度，导出器读取并计算后生成清单。所有资源引用必须列在 `files` 中。导出只读取显式声明，不递归打包项目目录。运行数据、常见私密配置及密钥路径不允许进入归档；还会拒绝部分可识别的明文凭据。内容扫描不能证明包完全没有敏感信息，分发者仍须审查声明文件。

归档最多 32 MiB，最多 2,048 个资源，每个资源最多 16 MiB，总解压资源最多 64 MiB，清单最多 1 MiB。导入会验证 UTF-8 元数据、完整文件集合、长度、摘要、卡片、Skill 与工具描述，拒绝重复或大小写冲突路径、路径穿越、绝对路径、Windows 保留名称、符号链接、硬链接来源、加密条目和不支持的 ZIP 编码。已安装目录再次启用前会重新验证，不允许同一 ID/版本替换成另一内容。

SHA-256 确认内容一致性，不提供发布者签名或来源真实性证明。`source` 是分发者声明；接受端仍需选择可信的包来源。

## 命令行

以下命令只管理本地包，不需要模型配置。工作区必须先存在；源导出声明使用示例中的 `declaration.json`：

```powershell
node dist/cli/index.js package export examples/capability-package --manifest examples/capability-package/declaration.json --output text-statistics.zip
node dist/cli/index.js package inspect text-statistics.zip
node dist/cli/index.js package import text-statistics.zip
node dist/cli/index.js package list
node dist/cli/index.js package diagnose example/text-statistics@1.0.0
node dist/cli/index.js package verify example/text-statistics@1.0.0 --workspace .
node dist/cli/index.js package adopt example/text-statistics@1.0.0
node dist/cli/index.js package export example/text-statistics@1.0.0 --output relayed.zip
```

通用 `--data-dir` 选择接收端本地数据目录，`--json` 输出结构化结果；包登记目录位于数据目录的 `capabilities/`。默认数据目录遵循 CLI 的 `KODO_DATA_DIR` 或平台本地数据目录配置。`package configure id@version --bindings file.json` 设置本地 MCP 绑定，`package prepare id@version [--npm-cli trusted-path]` 显式准备依赖，`package rollback author/name` 回退此前采用版本。

配置模型后，`run`/`chat` 的 `--package author/name@version` 会在创建运行前显式启用该包；例子由离线工具验收器实际运行，写入/执行例子须有相应 `--allow-write`/`--allow-exec`。包内工具始终使用操作系统沙箱。宿主进程工具的 `--sandbox` 和 `--allow-network` 是独立政策；网络选项要求同时启用沙箱。恢复时会重新挂载记录的相同包摘要与策略，变更包内容不能接管旧运行。

## 本地 Web 开发面板

`kodo serve` 可显式开启能力包开发面板（默认关闭）：

```powershell
node dist/cli/index.js serve --workspace . --packages
node dist/cli/index.js serve --workspace . --packages --package-actions --npm-cli /absolute/npm-cli.js
node dist/cli/index.js serve --workspace . --package example/text-statistics@1.0.0
```

- `--packages`：只读面板，展示兼容性诊断（`imported`/`needs_configuration`/`incompatible`/`ready` 及原因）、依赖准备状态、默认版本、当前服务启用的包版本与有访问资格任务使用的卡片版本。
- `--package-actions`：允许浏览器触发依赖准备（`npm ci --ignore-scripts --omit=dev`，独立可写沙箱、显式联网、可能耗时）和默认版本 adopt/rollback。两者都不执行包代码、不修改已有运行、不自动启用、不授予模型工具或验收。
- `--npm-cli PATH`：依赖准备使用的可信 npm CLI 模块路径；要求 `--package-actions`。
- `--package author/name[@version]`：宿主显式启用包（省略版本时使用 adopted 指针），Web 新任务使用该包卡片；启用沿用 `verifyToolExamples` 与沙箱策略，失败拒绝启动。包身份持久化在本地 host state，重启后需相同包摘要与宿主配置才能访问旧会话；切换默认版本不会改变已运行任务。

面板数据不含包登记目录绝对路径、MCP 绑定、环境变量值或密钥；诊断只读取本地登记与文件摘要，不执行包代码。案例验收和包导入/导出/verify 仍使用 CLI。接口与重连语义见[本地 Web](local-web.md)，实现契约见 [Web 第二批体验](web-experience-batch2.md)。

## 宿主 API

```javascript
import { Application, PackageRegistry, exportPackage, verifyToolExamples } from 'kodo-local';

// declaration.files 必须逐一列明允许分发的资源。
await exportPackage(sourceDirectory, declaration, archivePath);

const registry = new PackageRegistry(registryDirectory);
const installed = await registry.import(archivePath); // 不加载模块、不安装依赖、不启动 MCP
console.log(await registry.diagnose(installed.card.id, installed.card.version));

const workspace = absoluteWorkspace;
const app = new Application(runtimeDataDirectory, provider);
try {
  const card = await registry.activate(app, installed.card.id, installed.card.version, {
    workspace,
    scope: { read: [], write: [] },
    verifyExamples: verifyToolExamples({ workspace, scope: { read: [], write: [] } }),
  });
  await registry.adopt(card.id, card.version);
  // 在 createRun({card,...}) 中显式选择该卡片与运行权限。
} finally {
  await app.shutdown();
}
```

`inspectPackage(zip)` 可以不导入地检查 ZIP。`registry.inspect(id, version)`、`list()`、`export(id, version, destination)` 提供安装检查、列表与重新分发。`provenance()` 返回接收端保存的导入时间、摘要、来源与原归档名。

`diagnose()` 返回 `imported`、`needs_configuration`、`incompatible` 或 `ready` 及原因。它检查平台要求、配置、依赖准备和验收记录；`ready` 表示该包通过这些静态条件和已记录验收，不保证当前沙箱后端或外部服务此刻可用。真实启用/调用仍会检查并可失败。

`adopt(id, version)` 仅切换本地默认版本指针，`rollback(id)` 选择此前采用的版本。它们不运行代码、不修改现有运行、不替代启用，也不自动授予权限。默认版本可处于尚未验收状态，使用前应诊断并启用。

## 自定义工具与验收

工具描述采用以下结构，参数是 JSON Schema：

```json
{
  "format": "kodo-tool/v1",
  "name": "text.stats",
  "version": "1.0.0",
  "description": "Count unchanged text.",
  "parameters": { "type": "object", "required": ["text"], "properties": { "text": { "type": "string" } } },
  "permission": "read",
  "effect": "read"
}
```

模块导出 `execute(arguments, context)` 或默认函数，返回不为 `undefined` 的 JSON 值。`context` 只含 `workspace`、`runId`、`sessionId`。模块在独立 Node 进程里加载，宿主不 `import()` 包代码；请求和返回 JSON 各限制为 1 MiB。常规 `console.log` 诊断写入 stderr。自行写 stdout 的代码可能破坏协议并导致明确失败。

每次调用都会使用当前运行的真实工作区和文件范围，包目录只读暴露，默认断网。声明为写副作用的工具还要求真实运行具备 `write` 授权。沙箱不可用、启动失败、超限、无效 JSON 或非零退出均失败，不转成可信宿主回调。宿主自行注册的回调仍属于宿主可信代码；这一机制不会自动隔离任意回调。

`verifyToolExamples({workspace, scope?, permissions?})` 是离线工具验收器。例子的 `input` 必须是 JSON 字符串 `{"tool":"text.stats","arguments":{"text":""}}`，`expected` 为预期 JSON 字符串。它校验参数、卡片允许列表和权限，实际调用隔离工具，并比较 JSON 值。自然语言、MCP 交互或跨步骤任务例子需宿主提供 `verifyExamples(input) -> {passed,evidence}`，自行实际执行相应检查；不能只根据例子描述返回通过。未提供验收器、验收失败或证据为空时拒绝启用。

`Application.activatePackage()` 先暂存资源，等待全部连接和校验通过再提交注册；连接或名称冲突失败时关闭已启动的连接。工具绑定包含包内容摘要，重启后需要重新启用相同包；不能用同名不同实现恢复旧运行。

## MCP 与凭据

本地 MCP 模板声明 `transport: "stdio"`、相对 Node 模块 `entry`、可选参数、环境变量引用和逐工具策略。启用必须提供 `stdio: {write: false, network: "none"}` 等显式宿主政策。该政策持续作用于服务进程；较窄的运行范围不能借用访问范围更广的服务。

远端模板声明 `transport: "http"`、`url` 和逐工具策略。模板 URL 不直接获得执行授权，接收端通过 `registry.configure(id, version, bindings)` 显式绑定实际 URL。HTTP 仅允许回环地址，其余须 HTTPS，不支持 URL 内嵌凭据。

```javascript
await registry.configure('author/package', '1.0.0', {
  mcp: {
    remote: {
      url: 'https://service.example/mcp',
      headers: { Authorization: { env: 'LOCAL_MCP_AUTHORIZATION' } },
    },
  },
});
```

凭据只能是本地环境变量引用，变量须实际存在；分发清单中的引用不直接授予读取接收端环境的能力。本地绑定保存在登记目录的 `local/` 下，重新导出时不会携带。远端 MCP 在服务端执行，宿主操作系统沙箱无法隔离远端服务的副作用，仍需信任接收端选择的服务与工具策略。

## 显式准备依赖

包声明第三方依赖时必须同时分发对应的 `package.json` 和现代 `package-lock.json`；顶层依赖须与清单一致，锁定条目必须是带 SHA-512 完整性值的 npm 官方 HTTPS 注册表制品。不会把开发者的 `node_modules` 打入包中。

接收端显式调用 `registry.prepareDependencies(id, version, {npmCli?})`，才会在单独可写沙箱中执行 `npm ci --ignore-scripts --omit=dev`，明确允许联网。不会执行 npm 生命周期脚本。依赖缓存与准备结果位于接收端派生目录，原始分发文件保持摘要一致；准备完成后仍需启用和验收。需要安装脚本、私有注册表、工作区依赖或本地文件依赖的包当前会被拒绝，不能靠关闭检查导入执行。

## 操作系统边界

Windows 使用受限 AppContainer 与 Job Object，Linux 使用 bubblewrap，macOS 使用 sandbox-exec；平台不支持或后端缺失时拒绝启动。Windows 同一用户同时仅允许一个工作区写入沙箱，macOS 禁止派生子进程；完整配置和恢复语义见 [操作系统沙箱](os-sandbox.md)。运行时必需的系统资源可能只读可见，不能把沙箱理解为整个宿主文件系统绝对不可见。工作区范围、现有受保护资源、外部只读包目录与网络政策由原生后端落实。包启用不会授权公共发布、上传、部署或消息发送。
