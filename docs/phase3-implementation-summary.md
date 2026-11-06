# Phase 3 实际实施摘要

**更新时间**：2026-11-06 12:55  
**分支**：claude/phase3-integration-cleanup-e86094  
**最新提交**：a1ac28f

---

## 设计调整

原设计（`phase3-integration-cleanup-design.md`）假设**完整迁移**所有应用模块到 IntegrationPlugin。

**实际采用策略**（协调者指示）：

1. **薄包装**：插件只提供 API 和命令路由，内部调用现有实现
2. **不重构 RunCoordinator**：完整 runtime 驱动等 Phase 2 coordinator 插件化后再做
3. **优先级**：CLI → Web → TUI
4. **阻塞点**：Web/TUI 需要 Application 实例，等待 Phase 2 coordinator

---

## 已完成插件

### 1. EvalIntegrationPlugin

**提交**：c9bcaf4  
**文件**：`src/integrations/eval-plugin.ts` (180 行)  
**测试**：`tests/integration/eval-plugin.test.ts` (4 个测试通过，1 个跳过)

**API 接口**：
- `freeze(definition)`: 冻结案例定义
- `run(caseId, options)`: 执行案例（TODO: 需完整 RuntimeCore 集成）
- `list(options)`: 列出案例运行
- `compare(runIdA, runIdB)`: 比较两个运行结果
- `adopt(caseId, runId)`: 采用新版本
- `rollback(caseId, runId)`: 回退版本

**CLI 命令**（6 个，占位）：
- `freeze`: 冻结案例
- `run`: 执行案例
- `list`: 列出运行
- `compare`: 比较运行
- `adopt`: 采用版本
- `rollback`: 回退版本

**依赖**：
- `runtime.store` (必须，通过 `initialize()` 获取)
- `CaseRunStore(store)`: 案例运行持久化

**设计特点**：
- 直接包装 `src/cases/` 模块
- Store 验证：`runtime.store` 缺失时 throw
- 所有方法绑定 `this`，避免上下文丢失

---

### 2. AgentAuthoringPlugin

**提交**：020aa32  
**文件**：`src/integrations/agent-authoring-plugin.ts` (214 行)  
**测试**：`tests/integration/agent-authoring-plugin.test.ts` (7 个测试通过，1 个跳过)

**API 接口**：
- `create(options)`: 创建 agent draft
- `save(runId, options)`: 从运行提取 agent method
- `saveConfig(runId, options)`: 保存配置 draft
- `write(draft, output)`: 写入磁盘
- `export(directory, declaration, archive)`: 导出包

**CLI 命令**（3 个，占位）：
- `create`: 创建 agent
- `save`: 保存 method
- `save-config`: 保存配置

**依赖**：
- `runtime.store` (可选，save/saveConfig 需要，create 不需要)
- 方法调用时验证，而非初始化时

**设计特点**：
- 包装 `src/agents/authoring.ts` 和 `src/agents/configuration-save.ts`
- Store 按需验证（灵活性）
- 文档引用 Phase 2b 工具名（file.read, file.write, file.edit, file.search, background.read）
- 默认 allowedTools 推荐：8 个核心工具

---

### 3. CliIntegrationPlugin

**提交**：84010b9  
**文件**：`src/integrations/cli-plugin.ts` (202 行)  
**测试**：`tests/integration/cli-plugin.test.ts` (7 个测试通过)

**API 接口**：
- `run(prompt, options)`: 创建 session 并运行到完成
- `createSession(options)`: 创建新 session
- `startRun(sessionId, prompt, options)`: 排队运行
- `advance(runId)`: 驱动运行到完成
- `cancel(runId)`: 取消运行
- `getRun(runId)`: 检查运行状态
- `listTools()`: 列出可用工具

**CLI 命令**（5 个，占位）：
- `run`: 运行 prompt
- `session`: 创建 session
- `inspect`: 检查运行
- `tools`: 列出工具
- `cancel`: 取消运行

**依赖**：
- 无（纯 RuntimeCore API 包装）

**设计特点**：
- 最薄的包装：直接调用 `RuntimeCore` 公开方法
- 无 Store 依赖
- `runs.get()` 抛异常时返回 undefined（try-catch）

**范围讨论**：
- 当前只包装 RuntimeCore 核心执行方法
- 完整 CLI（config/package/case/serve/spawn/runs/gc 等）未包含
- 已向协调者确认是否需扩展

---

### 4. WebIntegrationPlugin（占位符）

**提交**：1237343  
**文件**：`src/integrations/web-plugin.ts` (122 行)  
**测试**：`tests/integration/web-plugin.test.ts` (3 个测试通过)

**API 接口**：
- `start(options)`: 启动 workbench 服务器（**不可用**）
- `stop(handle)`: 停止服务器

**CLI 命令**（1 个，占位）：
- `serve`: 启动服务器

**依赖**：
- `Application` 实例（**RuntimeCore 未提供，阻塞**）

**设计特点**：
- 薄包装 `src/web/server.ts` 的 `createLocalServer`
- API 调用时检查 Application 存在性，缺失时 throw
- 占位实现，等待 Phase 2 coordinator 提供 Application

**阻塞原因**：
- `createLocalServer(app, options)` 需要 `Application` 实例
- Application 持有 Store、Provider、Binding、RunCoordinator
- 需要 Phase 2 coordinator 插件化后才能提供

---

### 5. TuiIntegrationPlugin（占位符）

**提交**：a1ac28f  
**文件**：`src/integrations/tui-plugin.ts` (98 行)  
**测试**：`tests/integration/tui-plugin.test.ts` (2 个测试通过)

**API 接口**：
- `start(controller, streams)`: 启动 TUI（**不可用**）

**CLI 命令**（1 个，占位）：
- `chat`: 启动交互式 TUI

**依赖**：
- `TuiActions` controller（**RuntimeCore 未提供，阻塞**）

**设计特点**：
- 薄包装 `src/tui/index.tsx` 的 `runTui`
- API 调用时检查 controller 存在性，缺失时 throw
- 占位实现，等待 Phase 2 coordinator 提供 controller

**阻塞原因**：
- `runTui(controller, streams)` 需要 `TuiActions` 实例
- TuiActions 由 Application 创建，持有所有 runtime 状态
- 需要 Phase 2 coordinator 插件化后才能提供

---

## 测试覆盖

| 插件 | 测试文件 | 通过 | 跳过 | 提交 |
|---|---|---|---|---|
| EvalIntegrationPlugin | tests/integration/eval-plugin.test.ts | 4 | 1 | c9bcaf4 |
| AgentAuthoringPlugin | tests/integration/agent-authoring-plugin.test.ts | 7 | 1 | 020aa32 |
| CliIntegrationPlugin | tests/integration/cli-plugin.test.ts | 7 | 0 | 84010b9 |
| WebIntegrationPlugin | tests/integration/web-plugin.test.ts | 3 | 0 | 1237343 |
| TuiIntegrationPlugin | tests/integration/tui-plugin.test.ts | 2 | 0 | a1ac28f |
| **总计** | | **23** | **2** | |

**跳过原因**：
- EvalPlugin.runCase: 需要完整 RuntimeCore 集成（TODO）
- AgentAuthoringPlugin: CLI 命令处理器未实现

---

## 已知问题与待办

### 1. CLI 命令处理器未实现

**现状**：所有三个插件的 CLI handlers 当前为：

```typescript
private readonly cmdName: (args: Record<string, unknown>) => Promise<unknown> = async () => {
  throw new Error('CLI handler not yet implemented');
};
```

**原因**：薄包装策略下，CLI 命令应调用现有 CLI 模块（src/cli/）

**待办**：
- 确认是否需要实现
- 若需要，每个 handler 调用 src/cli/ 中对应函数
- 不重构内部逻辑，纯转发

### 2. EvalPlugin.runCase 未完成

**现状**：

```typescript
async runCase(): Promise<CaseRun> {
  throw new Error('EvalIntegrationPlugin.runCase needs proper RuntimeCore integration - TODO');
}
```

**原因**：案例执行需要完整 runtime 上下文（session, provider, binding）

**待办**：
- 设计 runCase 与 RuntimeCore 的集成方式
- 可能需要扩展 RuntimeCore API

### 3. WebIntegrationPlugin 和 TuiIntegrationPlugin 不可用

**现状**：占位符实现，API 调用时 throw

**原因**：
- 需要 `Application` 实例（Web）
- 需要 `TuiActions` controller（TUI）
- 两者都依赖完整的 Application 架构

**待办**：
- 等待 Phase 2 coordinator 插件化
- Application 变为插件或由插件组合提供
- 完整实现 Web/TUI 包装

### 4. 集成测试未执行

**现状**：Phase 3 integration test plan 定义了 18 个测试用例，未运行

**原因**：
- 需要 Phase 2a capability plugins（task-analysis 已完成）
- 需要 Phase 2b tool plugins（未转换）
- 需要完整 runtime 组合

**待办**：
- Phase 2a/2b 完成后执行
- 验证插件组合和端到端流程

### 5. 目录清理未开始

**现状**：原设计计划清理 src/ 目录结构，未执行

**原因**：
- 薄包装策略保留现有模块
- 插件不迁移代码，只包装接口
- 现有目录结构仍被使用

**待办**：
- 重新评估目录清理必要性
- 若需要，定义新的清理范围

---

## 与 Phase 1/2 的依赖

### Phase 1（已合并）

**提交**：3b57b48（本地 main）

**提供接口**：
- `IntegrationPlugin` 接口
- `RuntimeCore` 类（run/createSession/startRun/advance/cancel/runs.get/toolSpecs）
- `runtime.store` 字段
- `PluginRegistry` (registry.integration(name))
- `createRuntime({ provider, binding, store, capabilities, tools, integrations })`
- `ToolBoundary`（57f1def）

**Phase 3 使用**：
- ✅ 所有插件实现 IntegrationPlugin
- ✅ 所有插件通过 createRuntime 注册和初始化
- ✅ CLI/Eval 插件访问 runtime.store
- ✅ CLI 插件包装 RuntimeCore 公开 API

### Phase 2a（已完成）

**提交**：6f59322

**提供插件**：
- `task-analysis` CapabilityPlugin

**Phase 3 使用**：
- ⏳ 集成测试将使用 task-analysis

**合并冲突风险**：
- `src/runtime/attachments.ts` 被修改（新增 task-analysis, order 85）
- Phase 3 未修改此文件，无冲突

### Phase 2b（已完成）

**提交**：c3484f9

**工具精简**：
- 公开别名：file.write, file.edit, background.read, context.snapshot
- 内部名保持稳定（兼容性）
- 模型可见工具 ~14 个

**Phase 3 使用**：
- ✅ AgentAuthoringPlugin 文档引用新别名
- ✅ CliIntegrationPlugin 文档可用新名称
- ⏳ 集成测试将使用新工具名

**完整工具名表**：见 `C:\Users\admin\AppData\Local\Claude-3p\side-session-notes\local_e685eee4-688c-4ad9-8eed-c2d5336c51df\phase-dependencies.md`

---

## 下一步

### 立即可做（无阻塞）

1. **文档完善**
   - 更新 phase3-integration-cleanup-design.md 加入实施摘要
   - 完善各插件的 API 文档
   - 编写使用示例

2. **已知问题跟踪**
   - 创建 phase3-known-issues.md
   - 记录每个 TODO 的具体方案

### 等待协调者指示

1. **CliIntegrationPlugin 范围**
   - 是否需包装完整命令集（config/package/case/serve 等）？
   - 还是保持当前 RuntimeCore API 包装？

2. **CLI 命令处理器实现**
   - 所有 CLI handlers 是否需要实现？
   - 还是留待后续？

3. **Web/TUI 完整实施时机**
   - 当前占位符，等待 Phase 2 coordinator
   - 还是有其他方案？

### 等待 Phase 2 完成

1. **集成测试**
   - Phase 2a capability plugins 全部转换
   - Phase 2b tool plugins 全部转换
   - 执行 18 个集成测试用例

2. **目录清理**
   - 重新评估范围
   - 执行必要的清理

---

**更新时间**：2026-11-06 12:55  
**分支**：claude/phase3-integration-cleanup-e86094  
**最新提交**：a1ac28f
