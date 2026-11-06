# Phase 3 已知问题与解决方案

**更新时间**：2026-11-06 12:56  
**分支**：claude/phase3-integration-cleanup-e86094

---

## 1. CLI 命令处理器未实现

### 现状

所有三个插件（EvalIntegrationPlugin, AgentAuthoringPlugin, CliIntegrationPlugin）的 CLI command handlers 当前为占位符：

```typescript
private readonly commandName: (args: Record<string, unknown>) => Promise<unknown> = async () => {
  throw new Error('CLI handler not yet implemented');
};
```

**影响插件**：
- EvalIntegrationPlugin: 6 个命令（freeze, run, list, compare, adopt, rollback）
- AgentAuthoringPlugin: 3 个命令（create, save, save-config）
- CliIntegrationPlugin: 5 个命令（run, session, inspect, tools, cancel）

### 原因

薄包装策略下，CLI 命令应调用现有 CLI 模块（src/cli/）而非重新实现。当前专注于 API 接口，CLI 部分延后。

### 解决方案

**方案 A：实现命令处理器（转发到现有 CLI）**

每个 handler 调用 src/cli/ 或相应模块中的现有函数：

```typescript
// EvalIntegrationPlugin
private readonly freezeCommand: (args: Record<string, unknown>) => Promise<unknown> = async (args) => {
  const { caseCommand } = await import('../cases/cli.js');
  return await caseCommand(['freeze', ...(args.definition as string[])]);
};

// AgentAuthoringPlugin
private readonly createCommand: (args: Record<string, unknown>) => Promise<unknown> = async (args) => {
  const { agentAuthoringCommand } = await import('../agents/authoring-cli.js');
  return await agentAuthoringCommand(['create', ...(args.flags as string[])]);
};

// CliIntegrationPlugin (核心命令)
private readonly runCommand: (args: Record<string, unknown>) => Promise<unknown> = async (args) => {
  const prompt = args.prompt as string | undefined;
  if (!prompt) throw new Error('cli run requires a prompt');
  const system = args.system as string | undefined;
  return this.run(prompt, system ? { system } : {}); // 已实现
};
```

**优点**：
- 完整的 CLI 功能
- 无需重复实现

**缺点**：
- 需要将现有 CLI 函数重构为可导出函数
- 参数解析需要适配

**方案 B：保持占位符，文档说明**

在文档中说明：
- CLI handlers 为占位符
- 用户应直接使用 API 接口
- CLI 完整实现延后到 Phase 4 或更高优先级时

**优点**：
- 无额外工作
- API 接口已完整可用

**缺点**：
- CLI 用户体验不完整
- 与原设计不符

### 推荐方案

**方案 C：混合方案**

1. **CliIntegrationPlugin**: 核心命令已实现（调用 API），保持现状
2. **EvalIntegrationPlugin/AgentAuthoringPlugin**: 保持占位符
3. **文档说明**：推荐使用 API 接口，CLI 支持待完善

理由：
- CliIntegrationPlugin 核心功能已可用
- Eval/AgentAuthoring 主要通过 API 使用
- 避免重构现有 CLI 模块

---

## 2. EvalPlugin.runCase 未完成

### 现状

```typescript
async runCase(caseId: string, options: RunOptions = {}): Promise<CaseRun> {
  throw new Error('EvalIntegrationPlugin.runCase needs proper RuntimeCore integration - TODO');
}
```

### 原因

案例执行需要：
1. 创建 session
2. 配置 provider 和 binding
3. 运行案例中的 prompt
4. 收集结果和断言
5. 保存到 Store

当前 RuntimeCore API 不足以支持完整流程。

### 解决方案

**方案 A：扩展 RuntimeCore API**

添加 `RuntimeCore.runCase(caseDefinition, options)` 方法：

```typescript
// RuntimeCore
async runCase(caseDefinition: CaseDefinition, options: RunOptions): Promise<CaseRun> {
  const session = this.createSession({ binding: options.binding });
  const run = await this.run(caseDefinition.prompt, { sessionId: session.id });
  
  // 执行断言
  const assertions = this.evaluateAssertions(run, caseDefinition.assertions);
  
  // 保存结果
  const caseRun: CaseRun = {
    id: randomUUID(),
    caseId: caseDefinition.id,
    runId: run.id,
    status: assertions.every(a => a.passed) ? 'passed' : 'failed',
    assertions,
    // ...
  };
  
  return caseRun;
}
```

**优点**：
- 完整的案例执行支持
- API 清晰

**缺点**：
- 需要修改 RuntimeCore（Phase 1 代码）
- 需要重新协调 Phase 1

**方案 B：在 EvalIntegrationPlugin 内部实现**

使用现有 RuntimeCore API 组合：

```typescript
async runCase(caseId: string, options: RunOptions = {}): Promise<CaseRun> {
  // 1. 从 Store 读取案例定义
  const caseDefinition = this.store.getCase(caseId);
  
  // 2. 创建 session
  const session = this.runtime.createSession({ binding: options.binding });
  
  // 3. 运行 prompt
  const run = await this.runtime.run(caseDefinition.prompt, { sessionId: session.id });
  
  // 4. 执行断言
  const assertions = this.evaluateAssertions(run, caseDefinition.assertions);
  
  // 5. 保存结果
  const caseRun: CaseRun = {
    id: randomUUID(),
    caseId,
    runId: run.id,
    status: assertions.every(a => a.passed) ? 'passed' : 'failed',
    assertions,
    createdAt: Date.now(),
  };
  
  this.store.saveCaseRun(caseRun);
  return caseRun;
}

private evaluateAssertions(run: CoreRun, assertions: Assertion[]): AssertionResult[] {
  return assertions.map(assertion => {
    // 根据 assertion.type 执行不同的检查
    // - 'contains': run.result?.includes(assertion.value)
    // - 'equals': run.result === assertion.value
    // - 'matches': new RegExp(assertion.pattern).test(run.result)
    // ...
  });
}
```

**优点**：
- 不修改 RuntimeCore
- 插件内部自包含

**缺点**：
- 断言逻辑需要在插件内实现
- 可能与 src/cases/ 模块重复

**方案 C：调用现有 src/cases/ 模块**

```typescript
async runCase(caseId: string, options: RunOptions = {}): Promise<CaseRun> {
  const { runCase: runCaseImpl } = await import('../cases/runner.js');
  
  // 传递 runtime 和 store
  return await runCaseImpl(caseId, {
    ...options,
    runtime: this.runtime,
    store: this.runtime.store,
  });
}
```

**优点**：
- 复用现有逻辑
- 最少代码

**缺点**：
- src/cases/runner.js 可能不接受这种接口
- 需要重构 runner.js

### 推荐方案

**方案 B（短期）+ 方案 A（长期）**

1. **短期**：在 EvalIntegrationPlugin 内部实现 runCase
   - 使用 RuntimeCore 现有 API
   - 简单断言逻辑（contains, equals）
   - 足够覆盖基本用例

2. **长期**：Phase 2 coordinator 完成后，扩展 RuntimeCore
   - 添加专门的 case execution API
   - 支持复杂断言和工具监控

---

## 3. WebIntegrationPlugin 和 TuiIntegrationPlugin 不可用

### 现状

两个插件只有占位符实现，API 调用时抛出异常：

```typescript
// WebIntegrationPlugin
async startServer(options: LocalServerOptions): Promise<LocalServerHandle> {
  if (!this.application) {
    throw new Error(
      'WebIntegrationPlugin.start requires an Application instance. ' +
      'Application is not yet available in RuntimeCore; this will be added when Phase 2 coordinator plugin is ready.'
    );
  }
  // ...
}

// TuiIntegrationPlugin  
async startTui(controller: TuiActions, streams?: TuiStreams): Promise<void> {
  await runTui(controller, streams);
}
```

### 原因

两个模块依赖 `Application` 实例：

- **Web**: `createLocalServer(app: Application, options)`
- **TUI**: `runTui(controller: TuiActions, streams)` where controller 来自 Application

Application 持有：
- Store
- Provider
- ModelBinding
- RunCoordinator
- ToolRegistry
- 所有 runtime 状态

Phase 1 的 RuntimeCore 不提供 Application（设计上是轻量级执行核心）。

### 解决方案

**方案 A：RuntimeCore 添加 application 字段**

```typescript
// RuntimeCore
export class RuntimeCore {
  readonly store?: Store;
  readonly application?: Application; // 新增
  // ...
}

// createRuntime
export async function createRuntime(options: RuntimeOptions): Promise<RuntimeContext> {
  // ...
  const application = new Application({
    store: options.store,
    provider: options.provider,
    binding: options.binding,
    // ...
  });
  
  const core = new RuntimeCore({
    // ...
    application,
  });
  // ...
}
```

**优点**：
- Web/TUI 可直接使用
- 最少代码改动

**缺点**：
- Application 是重量级对象，RuntimeCore 应该轻量
- 违反 Phase 1 设计意图
- 需要协调 Phase 1

**方案 B：等待 Phase 2 coordinator 插件**

Phase 2 将 Application 的功能拆分为插件：
- CoordinatorPlugin: 管理 session 和 run 生命周期
- StatePlugin: 管理 Store 和持久化
- ToolRegistryPlugin: 管理工具注册

Web/TUI 插件通过 PluginRegistry 获取这些插件，组合成所需的功能。

**优点**：
- 符合插件化架构
- 无需修改 Phase 1
- 更灵活的组合

**缺点**：
- 需要等待 Phase 2 coordinator 完成
- 当前 Web/TUI 不可用

**方案 C：在插件内部创建 Application（临时方案）**

```typescript
// WebIntegrationPlugin
async initialize(runtime: RuntimeCore): Promise<void> {
  this.runtime = runtime;
  
  // 临时：创建 Application 实例
  if (runtime.store) {
    this.application = new Application({
      store: runtime.store,
      // 其他参数从 runtime 获取或使用默认值
    });
  }
}
```

**优点**：
- 立即可用
- 无需等待 Phase 2

**缺点**：
- Application 构造函数需要很多参数
- 可能与 RuntimeCore 的 Application 重复
- 临时方案，需要后续重构

### 推荐方案

**方案 B（等待 Phase 2 coordinator）**

理由：
1. **Web/TUI 不是 Phase 3 的关键阻塞项**
   - Eval 和 AgentAuthoring 已可用
   - CLI 核心功能已实现
   
2. **占位符实现已足够**
   - 接口定义清晰
   - 测试验证结构正确
   - 等待依赖就绪后补全

3. **避免临时方案的技术债**
   - 方案 C 会引入需要清理的临时代码
   - 方案 A 违反 Phase 1 设计

4. **符合项目整体规划**
   - Phase 2 coordinator 本来就计划解决这个问题
   - 等待正确方案比临时修复更好

---

## 4. 集成测试未执行

### 现状

phase3-integration-test-plan.md 定义了 18 个测试用例，但未运行。

### 原因

集成测试需要：
1. **Phase 2a capability plugins 全部转换**
   - task-analysis: ✅ 已完成
   - 其他能力插件：⏳ 未转换

2. **Phase 2b tool plugins 全部转换**
   - 10 个工具：⏳ 未转换

3. **完整的 runtime 组合**
   - RuntimeCore + capabilities + tools + integrations

### 解决方案

**分阶段执行**：

1. **Phase 3 单元测试**（✅ 已完成）
   - 每个插件的初始化和接口测试
   - 35 个测试通过

2. **Phase 2 完成后：集成测试第一阶段**
   - 测试插件组合
   - 测试 task-analysis + tools + integrations
   - 执行 phase3-integration-test-plan.md 的前 6 个用例

3. **Phase 2 全部完成后：集成测试第二阶段**
   - 所有 capability plugins
   - 所有 tool plugins  
   - 执行全部 18 个测试用例

### 当前待办

- ⏳ 等待 Phase 2a 完成
- ⏳ 等待 Phase 2b 完成
- ⏳ 准备集成测试环境和数据

---

## 5. 目录清理未开始

### 现状

原设计（phase3-directory-cleanup-plan.md）计划清理 src/ 目录结构，将应用模块移入 src/integrations/。

### 原因

薄包装策略下，插件不迁移代码，只包装接口。现有模块（src/cli/, src/cases/, src/tui/, src/web/, src/agents/）仍被插件调用。

### 解决方案

**方案 A：取消目录清理**

理由：
- 薄包装策略保留现有结构
- 插件通过 import 调用现有模块
- 目录结构清晰，无混乱

**方案 B：部分清理**

清理可以移动的部分：
- ✅ src/integrations/ 已创建（插件定义）
- 保留 src/cli/, src/cases/, src/tui/, src/web/, src/agents/（实现）

**方案 C：延后到 Phase 4**

等待所有插件完整实施后，重新评估清理范围。

### 推荐方案

**方案 B（部分清理）**

当前结构已合理：
- `src/integrations/`: 插件接口定义（5 个文件，~800 行）
- `src/cli/`, `src/cases/`, `src/tui/`, `src/web/`, `src/agents/`: 实现模块

无需额外清理。

---

## 总结

### 立即可解决（Phase 3 内）

1. **EvalPlugin.runCase**: 方案 B，在插件内部实现
2. **目录清理**: 方案 B，当前结构已合理

### 等待协调者指示

1. **CLI 命令处理器**: 推荐方案 C（混合），等待协调者确认
2. **CliIntegrationPlugin 范围**: 等待协调者答复

### 等待 Phase 2 完成

1. **Web/TUI 完整实施**: 方案 B，等待 coordinator 插件
2. **集成测试**: 分阶段执行，Phase 2 完成后开始

---

**更新时间**：2026-11-06 12:56  
**分支**：claude/phase3-integration-cleanup-e86094
