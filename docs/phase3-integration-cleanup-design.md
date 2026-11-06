# Phase 3: 应用集成与架构清理设计

## 概述

**目标**：将现有应用转换为 IntegrationPlugin，清理目录结构，完善文档，完成最终集成测试。

**前置条件**：
- Phase 1 完成：核心提取和插件接口定义
- Phase 2a 完成：能力和工具插件转换
- Phase 2b 完成：工具精简（24 → 10）和系统提示优化

**预计周期**：2 周

**关键输出**：
1. integrations/ 目录（3–5 个应用集成插件）
2. 清理后的 src/ 目录结构
3. 完善的文档体系
4. 通过的端到端集成测试

---

## 1. 应用分析与 IntegrationPlugin 转换

### 1.1 现有应用清单

基于 src/ 目录分析，识别出以下应用：

| 应用 | 当前位置 | 类型 | 接口类型 | 转换优先级 |
|---|---|---|---|---|
| **CLI** | src/cli/ | 命令行工具 | cli | P0 (必须) |
| **案例评测框架** | src/cases/ | 测试框架 | api + cli | P0 (必须) |
| **TUI 工作台** | src/tui/ | 终端界面 | ui (ink) | P0 (必须) |
| **Web 工作台** | src/web/ | HTTP 服务 | http + ui | P1 (高) |
| **Agent 创作工具** | src/agents/ | CLI + API | cli + api | P1 (高) |

### 1.2 IntegrationPlugin 接口设计

```typescript
// src/plugins/integration-plugin.ts

export interface IntegrationPlugin {
  id: string;
  name: string;
  version: string;
  
  // 接口类型标识
  interface: 'api' | 'cli' | 'ui' | 'http';
  
  // 初始化插件
  initialize(runtime: KodoRuntime, registry: PluginRegistry): Promise<void>;
  
  // 获取接口实现
  getInterface<T = unknown>(): T;
  
  // 清理资源
  dispose(): Promise<void>;
}

// 标准化的 IntegrationConfig
export interface IntegrationConfig {
  plugin: IntegrationPlugin;
  enabled: boolean;
  config?: Record<string, unknown>;
}
```

### 1.3 CLI 集成插件设计

**目标路径**：`src/integrations/cli-plugin.ts`

**职责**：
- 命令行参数解析
- 用户配置管理
- 交互式命令
- 进程生命周期管理

**接口实现**：

```typescript
export class CliIntegrationPlugin implements IntegrationPlugin {
  interface = 'cli' as const;
  
  async initialize(runtime: KodoRuntime, registry: PluginRegistry) {
    // 从 registry 获取所需插件
    this.toolRegistry = registry.get('tool-registry');
    this.runtimeCore = runtime.core;
  }
  
  getInterface(): CliInterface {
    return {
      parseArgs: () => { /* 使用 runtime 和 registry */ },
      interactive: () => { /* ... */ },
      serve: () => { /* ... */ },
    };
  }
}
```

**迁移清单**：
- [x] 识别 src/cli/ 中的核心功能
- [ ] 创建 CliIntegrationPlugin 骨架
- [ ] 迁移 config-binding.ts
- [ ] 迁移 interactive.ts
- [ ] 迁移 terminal.ts
- [ ] 迁移 tui-host.ts
- [ ] 测试命令行入口

### 1.4 案例评测插件设计

**目标路径**：`src/integrations/eval-plugin.ts`

**职责**：
- 案例定义和冻结
- 案例执行和断言
- 版本比较
- 采用和回退

**接口实现**：

```typescript
export class EvalIntegrationPlugin implements IntegrationPlugin {
  interface = 'api' as const;
  
  getInterface(): EvalInterface {
    return {
      freezeCase: (def) => { /* ... */ },
      runCase: (frozen, options) => { /* ... */ },
      compareRuns: (runA, runB) => { /* ... */ },
      adoptVersion: (agentId, runs) => { /* ... */ },
    };
  }
}
```

**迁移清单**：
- [x] 识别 src/cases/ 中的核心功能
- [ ] 创建 EvalIntegrationPlugin 骨架
- [ ] 迁移 schema.ts
- [ ] 迁移 runner.ts
- [ ] 迁移 store.ts
- [ ] 迁移 cli.ts（与 CliPlugin 协作）
- [ ] 测试案例执行流程

### 1.5 TUI 工作台插件设计

**目标路径**：`src/integrations/tui-plugin.ts`

**职责**：
- Ink 渲染组件
- 用户交互
- 命令面板
- 实时状态更新

**接口实现**：

```typescript
export class TuiIntegrationPlugin implements IntegrationPlugin {
  interface = 'ui' as const;
  
  getInterface(): TuiInterface {
    return {
      render: () => { /* Ink 组件 */ },
      controller: new TuiController(runtime, registry),
    };
  }
}
```

**迁移清单**：
- [x] 识别 src/tui/ 中的核心功能
- [ ] 创建 TuiIntegrationPlugin 骨架
- [ ] 迁移 controller.ts
- [ ] 迁移 view.tsx
- [ ] 迁移 commands.ts
- [ ] 迁移 agent-*.ts（与 Agent 插件协作）
- [ ] 测试 TUI 启动和交互

### 1.6 Web 工作台插件设计

**目标路径**：`src/integrations/web-plugin.ts`

**职责**：
- HTTP 服务器
- SSE 实时推送
- API 端点
- Web UI 渲染

**接口实现**：

```typescript
export class WebIntegrationPlugin implements IntegrationPlugin {
  interface = 'http' as const;
  
  getInterface(): WebInterface {
    return {
      createServer: (port) => { /* ... */ },
      routes: this.routes,
      workbench: () => { /* HTML/JS */ },
    };
  }
}
```

**迁移清单**：
- [x] 识别 src/web/ 中的核心功能
- [ ] 创建 WebIntegrationPlugin 骨架
- [ ] 迁移 server.ts
- [ ] 迁移 workbench.ts
- [ ] 迁移 collaboration.ts
- [ ] 迁移 packages.ts
- [ ] 测试 Web 服务启动

### 1.7 Agent 创作插件设计

**目标路径**：`src/integrations/agent-authoring-plugin.ts`

**职责**：
- Agent 定义和保存
- 卡片解析和验证
- 模板生成
- 配置管理

**接口实现**：

```typescript
export class AgentAuthoringPlugin implements IntegrationPlugin {
  interface = 'api' as const;
  
  getInterface(): AgentAuthoringInterface {
    return {
      parseCard: (content) => { /* ... */ },
      validateCard: (card) => { /* ... */ },
      saveConfiguration: (card, config) => { /* ... */ },
    };
  }
}
```

**迁移清单**：
- [x] 识别 src/agents/ 中的核心功能
- [ ] 创建 AgentAuthoringPlugin 骨架
- [ ] 迁移 card.ts
- [ ] 迁移 authoring.ts
- [ ] 迁移 authoring-cli.ts
- [ ] 迁移 configuration-save.ts
- [ ] 测试 Agent 创建流程

---

## 2. 目录清理计划

### 2.1 清理前的目录结构

```
src/
├── agents/              [待清理] → integrations/agent-authoring-plugin.ts
├── application/         [保留] → 可能需要重命名为 runtime-factory.ts
├── cases/              [待清理] → integrations/eval-plugin.ts
├── cli/                [待清理] → integrations/cli-plugin.ts
├── extensions/         [保留] → 重命名为 plugins/extensions/ (MCP, Skills)
├── knowledge/          [待审查] → 可能转为 plugins/knowledge/
├── messaging/          [保留] → core/messaging/
├── packages/           [保留] → core/packages/
├── providers/          [保留] → core/providers/
├── runtime/            [保留] → core/runtime/
├── sandbox/            [保留] → core/sandbox/ 或 plugins/isolation/
├── storage/            [保留] → core/storage/
├── tools/              [待审查] → 部分转为 plugins/tools/
├── tui/                [待清理] → integrations/tui-plugin.ts
└── web/                [待清理] → integrations/web-plugin.ts
```

### 2.2 清理后的目标结构

```
src/
├── core/                           [执行核心]
│   ├── runtime/                    [协作循环]
│   ├── providers/                  [模型提供商]
│   ├── storage/                    [持久化]
│   ├── messaging/                  [子代理消息]
│   ├── packages/                   [能力包]
│   └── sandbox/                    [隔离执行]（可选）
│
├── plugins/                        [插件接口定义]
│   ├── plugin-interface.ts
│   ├── capability-plugin.ts
│   ├── tool-plugin.ts
│   ├── integration-plugin.ts
│   └── index.ts
│
├── capabilities/                   [能力插件实现]
│   ├── context/
│   ├── memory/
│   ├── knowledge/
│   └── index.ts
│
├── tools/                          [工具插件实现]
│   ├── file.ts
│   ├── shell.ts
│   ├── context.ts
│   ├── spawn.ts
│   ├── ask.ts
│   └── index.ts
│
├── integrations/                   [应用集成]
│   ├── cli-plugin.ts
│   ├── eval-plugin.ts
│   ├── tui-plugin.ts
│   ├── web-plugin.ts
│   ├── agent-authoring-plugin.ts
│   └── index.ts
│
├── isolation/                      [可选隔离层]
│   ├── sandbox-policy.ts
│   └── native/
│
├── plugin-registry.ts              [注册中心]
├── factory.ts                      [运行时工厂]
└── types.ts                        [全局类型]
```

### 2.3 清理执行步骤

**阶段 1：准备工作**（1 天）
1. 创建新目录结构（空骨架）
2. 创建 src/integrations/ 目录
3. 创建各插件的骨架文件

**阶段 2：应用迁移**（3–5 天）
1. 迁移 CLI（P0）
2. 迁移案例评测（P0）
3. 迁移 TUI（P0）
4. 迁移 Web（P1）
5. 迁移 Agent 创作（P1）

**阶段 3：核心重组**（2–3 天）
1. 移动 runtime/ → core/runtime/
2. 移动 providers/ → core/providers/
3. 移动 storage/ → core/storage/
4. 移动 messaging/ → core/messaging/
5. 移动 packages/ → core/packages/
6. 移动 sandbox/ → core/sandbox/ 或 isolation/

**阶段 4：清理旧目录**（1 天）
1. 删除 src/agents/
2. 删除 src/cases/
3. 删除 src/cli/（保留 index.ts 入口）
4. 删除 src/tui/
5. 删除 src/web/

**阶段 5：更新引用**（1–2 天）
1. 更新所有 import 路径
2. 更新 package.json 的导出
3. 更新 tsconfig.json
4. 更新测试文件

---

## 3. 文档计划

### 3.1 新文档结构

```
docs/
├── README.md                           [总览：架构和快速开始]
│
├── architecture/                       [架构设计]
│   ├── overview.md                     [五层架构总览]
│   ├── core-execution.md               [执行核心详解，5 页]
│   ├── plugin-system.md                [插件系统设计]
│   └── data-flow.md                    [数据流和生命周期]
│
├── guides/                             [使用指南]
│   ├── getting-started.md              [快速开始]
│   ├── plugin-development.md           [插件开发完整指南]
│   │   ├── capability-plugins.md       [能力插件开发]
│   │   ├── tool-plugins.md             [工具插件开发]
│   │   └── integration-plugins.md      [集成插件开发]
│   ├── user-guide.md                   [用户使用指南]
│   └── migration-guide.md              [迁移指南]
│
├── examples/                           [示例代码]
│   ├── minimal-setup.ts                [最小化配置示例]
│   ├── standard-setup.ts               [生产标准配置]
│   ├── research-setup.ts               [研究定制配置]
│   ├── custom-tool-example.ts          [自定义工具示例]
│   └── custom-integration-example.ts   [自定义集成示例]
│
├── api-reference/                      [API 参考]
│   ├── core-api.md                     [核心 API]
│   ├── plugin-api.md                   [插件 API]
│   └── integration-api.md              [集成 API]
│
└── experiments/                        [实验文档，保持原样]
    └── ...
```

### 3.2 核心文档内容大纲

#### 3.2.1 architecture/overview.md（五层架构总览）

```markdown
# Kodo 架构总览

## 五层架构

1. **执行核心**（Core）：协作循环、模型提供商、持久化
2. **插件接口**（Plugin Interfaces）：CapabilityPlugin、ToolPlugin、IntegrationPlugin
3. **能力插件**（Capabilities）：上下文、记忆、知识
4. **工具插件**（Tools）：文件、Shell、上下文、委派、询问
5. **集成插件**（Integrations）：CLI、评测、TUI、Web、Agent 创作

## 设计原则

- 核心最小化：只包含协作循环
- 插件化：所有能力和工具都是插件
- 可组合：用户自由选择插件
- 清晰边界：每层职责明确

## 数据流

[流程图]

## 启动流程

[启动序列图]
```

#### 3.2.2 architecture/core-execution.md（执行核心详解）

```markdown
# 执行核心详解

## 协作循环

[详细流程图]

## 上下文管理

## 模型提供商

## 持久化

## 消息传递

## 能力包

## 隔离执行
```

#### 3.2.3 guides/plugin-development.md（插件开发完整指南）

```markdown
# 插件开发指南

## 插件类型

### 1. CapabilityPlugin（能力插件）

**用途**：为主代理提供额外能力

**示例**：
- ContextPlugin：上下文组装
- MemoryPlugin：项目记忆
- KnowledgePlugin：知识检索

**开发步骤**：
1. 实现 CapabilityPlugin 接口
2. 注册到 PluginRegistry
3. 在 RuntimeFactory 中启用

### 2. ToolPlugin（工具插件）

**用途**：提供模型可调用的工具

**示例**：
- FileToolPlugin：文件操作
- ShellToolPlugin：Shell 执行
- SpawnToolPlugin：子代理委派

**开发步骤**：
[详细步骤]

### 3. IntegrationPlugin（集成插件）

**用途**：提供外部接口（CLI、Web、API）

**示例**：
- CliIntegrationPlugin
- WebIntegrationPlugin
- EvalIntegrationPlugin

**开发步骤**：
[详细步骤]

## 最佳实践

## 常见陷阱
```

### 3.3 示例代码

#### examples/minimal-setup.ts

```typescript
import { KodoRuntime, PluginRegistry } from 'kodo';
import { FileToolPlugin, ShellToolPlugin } from 'kodo/tools';
import { CliIntegrationPlugin } from 'kodo/integrations';

// 最小化配置：只有基础工具
const registry = new PluginRegistry();
registry.register(new FileToolPlugin());
registry.register(new ShellToolPlugin());
registry.register(new CliIntegrationPlugin());

const runtime = KodoRuntime.create({ registry });

// 使用 CLI 接口
const cli = registry.get('cli-integration').getInterface();
cli.run(['kodo', 'chat', 'Hello']);
```

#### examples/standard-setup.ts

```typescript
import { KodoRuntime, PluginRegistry } from 'kodo';
import { 
  FileToolPlugin, 
  ShellToolPlugin, 
  ContextToolPlugin,
  SpawnToolPlugin,
  AskToolPlugin,
} from 'kodo/tools';
import { 
  ContextPlugin, 
  MemoryPlugin, 
  KnowledgePlugin 
} from 'kodo/capabilities';
import { 
  CliIntegrationPlugin, 
  TuiIntegrationPlugin,
  WebIntegrationPlugin,
} from 'kodo/integrations';

// 生产标准配置
const registry = new PluginRegistry();

// 工具插件
registry.register(new FileToolPlugin());
registry.register(new ShellToolPlugin());
registry.register(new ContextToolPlugin());
registry.register(new SpawnToolPlugin());
registry.register(new AskToolPlugin());

// 能力插件
registry.register(new ContextPlugin());
registry.register(new MemoryPlugin());
registry.register(new KnowledgePlugin());

// 集成插件
registry.register(new CliIntegrationPlugin());
registry.register(new TuiIntegrationPlugin());
registry.register(new WebIntegrationPlugin());

const runtime = KodoRuntime.create({ registry });

// 可以使用任何集成
const cli = registry.get('cli-integration').getInterface();
const tui = registry.get('tui-integration').getInterface();
const web = registry.get('web-integration').getInterface();
```

---

## 4. 集成测试计划

### 4.1 测试类别

| 测试类别 | 覆盖范围 | 目标 | 预期结果 |
|---|---|---|---|
| **E2E 全插件测试** | 所有插件启用 | ≈ 当前系统行为 | 功能完全兼容 |
| **最小配置测试** | 只有核心 + 基础工具 | 最小可用系统 | 能完成简单任务 |
| **部分插件测试** | 选择性禁用 | 验证插件独立性 | 无依赖冲突 |
| **性能对比测试** | 最小 vs 标准配置 | 性能差异 | 文档化开销 |
| **新用户测试** | 文档 + 示例 | 易用性 | 30 分钟内启动 |

### 4.2 E2E 测试用例

**TC-001：CLI 基础命令**
- 输入：`kodo run "列出当前目录"`
- 预期：执行成功，列出文件

**TC-002：TUI 启动**
- 输入：`kodo`（TTY 环境）
- 预期：TUI 正常启动，显示品牌标识

**TC-003：案例评测**
- 输入：`kodo case run test-case.json`
- 预期：案例执行成功，生成报告

**TC-004：Web 服务**
- 输入：`kodo serve --port 3000`
- 预期：Web 服务启动，可访问

**TC-005：Agent 创作**
- 输入：`kodo agents new "测试 Agent"`
- 预期：生成 Agent 卡片

**TC-006：子代理委派**
- 输入：任务包含"创建子任务处理"
- 预期：子代理启动，协作完成

**TC-007：知识检索**
- 输入：询问项目内容
- 预期：检索相关知识

**TC-008：项目记忆**
- 输入：保存和回忆项目信息
- 预期：记忆功能正常

### 4.3 最小配置测试

**配置**：
```typescript
registry.register(new FileToolPlugin());
registry.register(new ShellToolPlugin());
registry.register(new CliIntegrationPlugin());
```

**测试用例**：
- 文件读写
- Shell 命令执行
- 基础对话

**预期**：
- 核心功能可用
- 无插件依赖错误
- 性能更快

### 4.4 性能对比测试

**基准任务**：
- 简单：读取文件 + 回答问题
- 中等：多文件分析 + 生成报告
- 复杂：子代理协作 + 知识检索

**对比配置**：
1. 最小配置（核心 + 2 工具）
2. 标准配置（核心 + 10 工具 + 3 能力 + 5 集成）

**指标**：
- 启动时间
- 首次响应时间
- 内存占用
- Token 使用量

### 4.5 新用户测试流程

**场景**：新用户从零开始

**步骤**：
1. 阅读 docs/README.md（5 分钟）
2. 安装和配置（10 分钟）
3. 运行 examples/minimal-setup.ts（5 分钟）
4. 运行 examples/standard-setup.ts（5 分钟）
5. 创建自定义工具（5 分钟）

**成功标准**：
- 30 分钟内完成所有步骤
- 理解五层架构
- 成功运行示例
- 能创建简单插件

---

## 5. 迁移指南

### 5.1 现有用户迁移路径

**场景 1：使用默认配置的用户**

**迁移步骤**：
1. 更新到新版本
2. 无需修改代码（兼容层自动处理）
3. （可选）切换到显式插件配置

**场景 2：使用能力包的用户**

**迁移步骤**：
1. 更新能力包格式（新增插件声明）
2. 更新 Application 创建方式
3. 测试验证

**场景 3：扩展工具的用户**

**迁移步骤**：
1. 实现 ToolPlugin 接口
2. 注册到 PluginRegistry
3. 移除旧的工具注册代码

### 5.2 兼容性策略

**Phase 3 期间**：
- 保留 src/application/index.ts 作为兼容层
- 旧 API 标记为 @deprecated
- 提供自动迁移脚本

**Phase 4 后**：
- 移除兼容层
- 只保留新 API

### 5.3 废弃警告

```typescript
// src/application/index.ts (兼容层)
/** @deprecated Use KodoRuntime.create() with PluginRegistry instead */
export class Application {
  constructor(options) {
    console.warn('Application class is deprecated. Use KodoRuntime.create().');
    // 内部转换为新 API
  }
}
```

---

## 6. 实施时间表

### Week 1：应用迁移

**Day 1–2**：CLI + 案例评测（P0）
- 创建 integrations/ 目录
- 迁移 CliIntegrationPlugin
- 迁移 EvalIntegrationPlugin
- 基础测试

**Day 3–4**：TUI + Web（P0/P1）
- 迁移 TuiIntegrationPlugin
- 迁移 WebIntegrationPlugin
- 集成测试

**Day 5**：Agent 创作（P1）+ 文档起草
- 迁移 AgentAuthoringPlugin
- 开始编写核心文档

### Week 2：清理与文档

**Day 6–7**：目录重组
- 移动核心到 core/
- 更新所有 import
- 运行所有测试

**Day 8–9**：文档完善
- 完成架构文档
- 完成插件开发指南
- 完成用户指南
- 完成示例代码

**Day 10**：集成测试与验收
- 运行完整 E2E 测试
- 性能对比测试
- 新用户测试
- 修复发现的问题

---

## 7. 验收标准

### 7.1 功能验收

- ✅ 所有应用转为 IntegrationPlugin
- ✅ 应用通过 runtime 和 registry 获取功能
- ✅ 目录结构清晰（core/、plugins/、capabilities/、tools/、integrations/）
- ✅ 旧目录已清理（agents/、cases/、cli/ 内容、tui/、web/）
- ✅ 所有 import 路径更新
- ✅ 所有测试通过

### 7.2 文档验收

- ✅ 核心架构文档清晰易读（< 5 页）
- ✅ 插件开发文档完整（每类型 1–2 页）
- ✅ 用户指南有实际例子
- ✅ API 参考完整
- ✅ 示例代码可运行

### 7.3 测试验收

- ✅ E2E 测试全部通过
- ✅ 最小配置测试通过
- ✅ 部分插件测试通过
- ✅ 性能测试有文档化结果
- ✅ 新用户测试成功（30 分钟）

### 7.4 迁移验收

- ✅ 提供迁移指南
- ✅ 提供兼容性说明
- ✅ 提供废弃警告
- ✅ 提供迁移示例

---

## 8. 风险与缓解

### 风险 1：Phase 1/2 延期

**影响**：Phase 3 无法开始实质工作

**缓解**：
- Phase 3 先做设计和准备工作（本文档）
- 准备测试用例和文档大纲
- 一旦接口就绪，立即开始迁移

### 风险 2：import 路径更新遗漏

**影响**：运行时错误

**缓解**：
- 使用 TypeScript 编译器检查
- 使用 grep 全局搜索旧路径
- 分批次迁移，每批次充分测试

### 风险 3：集成测试失败

**影响**：发布延期

**缓解**：
- 边迁移边测试，不积累问题
- 保留兼容层，降低风险
- 使用 git worktree，保持主分支稳定

### 风险 4：文档不清晰

**影响**：新用户无法上手

**缓解**：
- 请他人评审文档
- 实际运行示例代码
- 模拟新用户操作流程

---

## 9. 下一步行动

### 立即可做（Phase 1/2 进行中）

1. ✅ 完成本设计文档
2. [ ] 创建 src/integrations/ 目录骨架
3. [ ] 起草核心文档大纲
4. [ ] 准备测试用例清单
5. [ ] 创建示例代码草稿

### 等待 Phase 1 完成后

1. [ ] 获取最终的插件接口定义
2. [ ] 开始应用迁移（CLI → 案例 → TUI → Web → Agent）
3. [ ] 开始目录重组

### 等待 Phase 2 完成后

1. [ ] 验证 10 工具的最终形态
2. [ ] 更新文档中的工具列表
3. [ ] 完成集成测试

---

## 附录

### A. 参考文档

- [完整重设计方案](../memory/kodo-complete-redesign-roadmap-20261106.md) #7
- [插件化架构重设计](../memory/kodo-plugin-architecture-design-20261106.md)
- [精简工具设计](../memory/kodo-minimalist-toolset-20261106.md)
- [委派与重组现状分析](../memory/kodo-delegation-status.md)

### B. 术语表

- **IntegrationPlugin**：提供外部接口的插件（CLI、Web、API）
- **PluginRegistry**：插件注册中心，管理所有插件实例
- **KodoRuntime**：运行时核心，协调各插件工作
- **E2E**：端到端测试（End-to-End）

### C. 联系方式

- 主协调会话：local_61e021b1-d643-4f18-b009-45371f90464e
- Phase 1 会话：local_5ec68e3b-0a23-463a-b4c8-b47dc02e6dfc
- Phase 2a 会话：local_5458458e-3535-41c7-b7c0-54a0917c8f41
- Phase 2b 会话：local_355927ba-3fe2-4633-a628-5130ab8eb379
