# Phase 3：目录清理详细计划

## 当前目录结构分析

### src/ 目录清单（清理前）

```
src/
├── agents/              [7 files, ~1.5K LOC]
│   ├── authoring-cli.ts         # CLI 入口
│   ├── authoring.ts             # Agent 创建逻辑
│   ├── card.ts                  # 卡片解析
│   ├── configuration-save.ts    # 配置保存
│   └── ...
│
├── application/         [1 file, ~800 LOC]
│   └── index.ts                 # Application 主类
│
├── cases/              [5 files, ~2K LOC]
│   ├── cli.ts                   # 案例 CLI
│   ├── index.ts                 # 导出
│   ├── runner.ts                # 案例执行
│   ├── schema.ts                # 案例定义
│   └── store.ts                 # 案例存储
│
├── cli/                [10 files, ~5K LOC]
│   ├── config-binding.ts        # 配置绑定
│   ├── config.ts                # 配置管理
│   ├── host-state.ts            # 宿主状态
│   ├── index.ts                 # CLI 入口
│   ├── interactive.ts           # 交互式命令
│   ├── packages.ts              # 包管理
│   ├── serve.ts                 # Web 服务启动
│   ├── terminal.ts              # 终端工具
│   ├── tui-host.ts              # TUI 宿主
│   └── user-config.ts           # 用户配置
│
├── extensions/         [3 files, ~1K LOC]
│   ├── index.ts
│   ├── mcp.ts                   # MCP 连接
│   └── skills.ts                # Skills 支持
│
├── knowledge/          [2 files, ~2K LOC]
│   ├── index.ts
│   └── tools.ts                 # 知识检索工具
│
├── messaging/          [3 files, ~1K LOC]
│   ├── agent-lifecycle.ts
│   ├── index.ts
│   └── spawn-spec.ts
│
├── packages/           [5 files, ~3K LOC]
│   ├── archive.ts
│   ├── registry.ts
│   ├── runtime.ts
│   ├── schema.ts
│   └── worker.ts
│
├── providers/          [10 files, ~5K LOC]
│   ├── anthropic.ts
│   ├── errors.ts
│   ├── index.ts
│   ├── model-catalog.ts
│   ├── model-discovery.ts
│   ├── model-limits.ts
│   ├── model-list.ts
│   ├── openai.ts
│   ├── responses.ts
│   └── transport.ts
│
├── runtime/            [~70 files, ~25K LOC]
│   ├── attachments.ts
│   ├── background-notice.ts
│   ├── child-completion.ts
│   ├── compaction-trigger.ts
│   ├── compaction.ts
│   ├── completion.ts
│   ├── context-assembly.ts
│   ├── context-hard.ts
│   ├── context-inspection.ts
│   ├── context-progress.ts
│   ├── context-tokens.ts
│   ├── context.ts
│   ├── coordinator.ts           # 核心协调器
│   ├── deliverables.ts
│   ├── delivery-state.ts
│   ├── execution-workspace.ts
│   ├── history.ts
│   ├── hooks.ts
│   ├── inspection.ts
│   ├── instruction-layer.ts
│   ├── memory.ts
│   ├── model-step.ts
│   ├── paths.ts
│   ├── progress-advisor.ts
│   ├── progress-guard.ts
│   ├── project-instructions.ts
│   ├── recovery-resolution.ts
│   ├── recovery.ts
│   ├── response-repair.ts
│   ├── rewind.ts
│   ├── role-view.ts
│   ├── run-budget.ts
│   ├── run-output.ts
│   ├── schema-errors.ts
│   ├── scope.ts
│   ├── script-read.ts
│   ├── session-compat.ts
│   ├── state-frame.ts
│   ├── step-host.ts
│   ├── summary-install.ts
│   ├── summary-read.ts
│   ├── summary-schema.ts
│   ├── system-prompt.ts
│   ├── tool-batch.ts
│   ├── tool-result-prune.ts
│   ├── tool-step.ts
│   ├── turn-end.ts
│   ├── types.ts
│   ├── usage.ts
│   ├── view-pointers.ts
│   ├── workspace-git.ts
│   └── workspace-manifest.ts
│
├── sandbox/            [6 files, ~2K LOC]
│   ├── execute.ts
│   ├── index.ts
│   ├── policy.ts
│   ├── posix.ts
│   ├── types.ts
│   └── windows/
│       └── node-pipes.node      # 原生模块
│
├── storage/            [~15 files, ~6K LOC]
│   ├── archive.ts
│   ├── catalog.ts
│   ├── digest.ts
│   ├── index.ts
│   ├── query.ts
│   ├── schema.ts
│   ├── store.ts
│   └── ...
│
├── tools/              [~20 files, ~10K LOC]
│   ├── ask.ts
│   ├── catalog.ts
│   ├── context.ts
│   ├── file.ts
│   ├── index.ts
│   ├── lsp.ts
│   ├── memory.ts
│   ├── process.ts
│   ├── registry.ts
│   ├── schema.ts
│   ├── spawn.ts
│   ├── todo.ts
│   ├── verify.ts
│   ├── webfetch.ts
│   └── ...
│
├── tui/                [13 files, ~10K LOC]
│   ├── agent-authoring.ts
│   ├── agent-cases.ts
│   ├── agents.ts
│   ├── brand.ts
│   ├── commands.ts
│   ├── controller.ts
│   ├── editor.ts
│   ├── index.tsx
│   ├── input.ts
│   ├── interrupt.ts
│   ├── operations.ts
│   ├── types.ts
│   ├── verification-state.ts
│   └── view.tsx
│
└── web/                [6 files, ~8K LOC]
    ├── collaboration.ts
    ├── index.ts
    ├── packages.ts
    ├── recovery.ts
    ├── server.ts
    └── workbench.ts
```

**总计**：约 159 files，~85K LOC

---

## 目标目录结构（清理后）

```
src/
├── core/                           [执行核心，~50K LOC]
│   ├── runtime/                    [协作循环，~25K LOC]
│   │   ├── coordinator.ts          # 核心协调器
│   │   ├── context.ts              # 上下文管理
│   │   ├── compaction.ts           # 压缩
│   │   ├── recovery.ts             # 恢复
│   │   ├── history.ts              # 历史
│   │   ├── types.ts                # 类型定义
│   │   └── ...                     [其他 runtime/ 文件]
│   │
│   ├── providers/                  [模型提供商，~5K LOC]
│   │   ├── index.ts
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   ├── model-catalog.ts
│   │   ├── model-discovery.ts
│   │   └── ...
│   │
│   ├── storage/                    [持久化，~6K LOC]
│   │   ├── index.ts
│   │   ├── store.ts
│   │   ├── archive.ts
│   │   ├── catalog.ts
│   │   └── ...
│   │
│   ├── messaging/                  [子代理消息，~1K LOC]
│   │   ├── index.ts
│   │   ├── agent-lifecycle.ts
│   │   └── spawn-spec.ts
│   │
│   ├── packages/                   [能力包，~3K LOC]
│   │   ├── index.ts
│   │   ├── runtime.ts
│   │   ├── registry.ts
│   │   ├── schema.ts
│   │   └── worker.ts
│   │
│   └── sandbox/                    [隔离执行，~2K LOC]
│       ├── index.ts
│       ├── execute.ts
│       ├── policy.ts
│       ├── posix.ts
│       ├── types.ts
│       └── windows/
│
├── plugins/                        [插件接口，新增 ~500 LOC]
│   ├── plugin-interface.ts         # 基础插件接口
│   ├── capability-plugin.ts        # 能力插件接口
│   ├── tool-plugin.ts              # 工具插件接口
│   ├── integration-plugin.ts       # 集成插件接口
│   └── index.ts
│
├── capabilities/                   [能力插件，新增或迁移 ~3K LOC]
│   ├── context/                    # 上下文能力
│   │   ├── plugin.ts
│   │   └── ...
│   ├── memory/                     # 记忆能力
│   │   ├── plugin.ts
│   │   └── ...
│   ├── knowledge/                  # 知识能力
│   │   ├── plugin.ts
│   │   └── ...
│   └── index.ts
│
├── tools/                          [工具插件，精简到 ~5K LOC]
│   ├── file.ts                     # 文件工具
│   ├── shell.ts                    # Shell 工具
│   ├── context.ts                  # 上下文工具
│   ├── spawn.ts                    # 委派工具
│   ├── ask.ts                      # 询问工具
│   ├── todo.ts                     # 待办工具
│   ├── verify.ts                   # 验证工具
│   ├── webfetch.ts                 # Web 抓取
│   ├── registry.ts                 # 工具注册
│   └── index.ts
│
├── integrations/                   [应用集成，新增 ~10K LOC]
│   ├── cli-plugin.ts               # CLI 集成
│   ├── eval-plugin.ts              # 案例评测集成
│   ├── tui-plugin.ts               # TUI 集成
│   ├── web-plugin.ts               # Web 集成
│   ├── agent-authoring-plugin.ts   # Agent 创作集成
│   └── index.ts
│
├── isolation/                      [可选隔离层，待定]
│   ├── sandbox-policy.ts
│   └── native/
│
├── plugin-registry.ts              [注册中心，新增 ~500 LOC]
├── factory.ts                      [运行时工厂，新增 ~500 LOC]
└── types.ts                        [全局类型，新增 ~200 LOC]
```

**预计**：约 120 files，~75K LOC（减少 10K LOC 是因为精简和去重）

---

## 详细迁移映射

### 1. 核心层（Core）

| 原路径 | 新路径 | 操作 | 说明 |
|---|---|---|---|
| src/runtime/ | src/core/runtime/ | 移动 | 保持内部结构 |
| src/providers/ | src/core/providers/ | 移动 | 保持内部结构 |
| src/storage/ | src/core/storage/ | 移动 | 保持内部结构 |
| src/messaging/ | src/core/messaging/ | 移动 | 保持内部结构 |
| src/packages/ | src/core/packages/ | 移动 | 保持内部结构 |
| src/sandbox/ | src/core/sandbox/ | 移动 | 或 src/isolation/ |

**注意**：所有移动操作需要同步更新内部 import。

### 2. 插件接口层（Plugins）

| 原路径 | 新路径 | 操作 | 说明 |
|---|---|---|---|
| 无 | src/plugins/plugin-interface.ts | 新建 | 基础接口 |
| 无 | src/plugins/capability-plugin.ts | 新建 | 能力插件接口 |
| 无 | src/plugins/tool-plugin.ts | 新建 | 工具插件接口 |
| 无 | src/plugins/integration-plugin.ts | 新建 | 集成插件接口 |

**前置条件**：Phase 1 完成接口定义。

### 3. 能力插件层（Capabilities）

| 原路径 | 新路径 | 操作 | 说明 |
|---|---|---|---|
| src/runtime/context*.ts | src/capabilities/context/ | 拆分 | 上下文能力 |
| src/runtime/memory.ts | src/capabilities/memory/ | 拆分 | 记忆能力 |
| src/knowledge/ | src/capabilities/knowledge/ | 迁移 | 知识能力 |

**前置条件**：Phase 2a 完成能力插件转换。

### 4. 工具插件层（Tools）

| 原路径 | 新路径 | 操作 | 说明 |
|---|---|---|---|
| src/tools/file.ts | 保留 | 精简 | 文件工具 |
| src/tools/process.ts | src/tools/shell.ts | 重命名 | Shell 工具 |
| src/tools/context.ts | 保留 | 精简 | 上下文工具 |
| src/tools/spawn.ts | 保留 | 精简 | 委派工具 |
| src/tools/ask.ts | 保留 | 精简 | 询问工具 |
| src/tools/todo.ts | 保留 | 精简 | 待办工具 |
| src/tools/verify.ts | 保留 | 精简 | 验证工具 |
| src/tools/webfetch.ts | 保留 | 精简 | Web 抓取 |
| src/tools/memory.ts | 移除 | 删除 | 合并到能力 |
| src/tools/lsp.ts | 待定 | 待定 | LSP 支持 |

**前置条件**：Phase 2b 完成工具精简（24 → 10）。

### 5. 集成插件层（Integrations）

| 原路径 | 新路径 | 操作 | 说明 |
|---|---|---|---|
| src/cli/ | src/integrations/cli-plugin.ts | 重构 | CLI 集成 |
| src/cases/ | src/integrations/eval-plugin.ts | 重构 | 案例评测集成 |
| src/tui/ | src/integrations/tui-plugin.ts | 重构 | TUI 集成 |
| src/web/ | src/integrations/web-plugin.ts | 重构 | Web 集成 |
| src/agents/ | src/integrations/agent-authoring-plugin.ts | 重构 | Agent 创作集成 |

**操作详情**：
- **重构**：提取核心逻辑，实现 IntegrationPlugin 接口，通过 runtime 和 registry 获取依赖
- **保留入口**：src/cli/index.ts 保留作为命令行入口，但它现在只是薄壳，调用 CliIntegrationPlugin

---

## 详细执行步骤

### 阶段 1：准备工作（Day 1，2 小时）

#### 1.1 创建新目录骨架
```bash
cd E:\sh\Coding\agent-harness\.claude\worktrees\phase3-integration-cleanup-e86094

# 插件接口
mkdir -p src/plugins

# 能力插件（可能在 Phase 2a 已创建）
mkdir -p src/capabilities/context
mkdir -p src/capabilities/memory
mkdir -p src/capabilities/knowledge

# 集成插件
mkdir -p src/integrations
```

#### 1.2 创建骨架文件
```bash
# 插件接口
touch src/plugins/plugin-interface.ts
touch src/plugins/capability-plugin.ts
touch src/plugins/tool-plugin.ts
touch src/plugins/integration-plugin.ts
touch src/plugins/index.ts

# 集成插件
touch src/integrations/cli-plugin.ts
touch src/integrations/eval-plugin.ts
touch src/integrations/tui-plugin.ts
touch src/integrations/web-plugin.ts
touch src/integrations/agent-authoring-plugin.ts
touch src/integrations/index.ts

# 注册中心和工厂
touch src/plugin-registry.ts
touch src/factory.ts
```

#### 1.3 Git 提交
```bash
git add src/plugins src/integrations src/plugin-registry.ts src/factory.ts
git commit -m "Phase 3: 创建目录骨架和文件骨架"
```

---

### 阶段 2：应用迁移（Day 2–5，4 天）

#### 2.1 CLI Integration Plugin（Day 2，6 小时）

**步骤**：
1. 分析 src/cli/ 的依赖关系
2. 实现 CliIntegrationPlugin 骨架
3. 迁移 config-binding.ts
4. 迁移 interactive.ts
5. 迁移 terminal.ts
6. 迁移 tui-host.ts
7. 保留 src/cli/index.ts 作为入口
8. 更新 import 路径
9. 测试 CLI 命令

**验收**：
```bash
node dist/cli/index.js --version
node dist/cli/index.js doctor
node dist/cli/index.js chat "hello"
```

#### 2.2 Eval Integration Plugin（Day 2，4 小时）

**步骤**：
1. 分析 src/cases/ 的依赖关系
2. 实现 EvalIntegrationPlugin 骨架
3. 迁移 schema.ts
4. 迁移 runner.ts
5. 迁移 store.ts
6. 迁移 cli.ts（与 CliPlugin 协作）
7. 更新 import 路径
8. 测试案例执行

**验收**：
```bash
node dist/cli/index.js case freeze test.json
node dist/cli/index.js case run frozen-case.json
```

#### 2.3 TUI Integration Plugin（Day 3，6 小时）

**步骤**：
1. 分析 src/tui/ 的依赖关系
2. 实现 TuiIntegrationPlugin 骨架
3. 迁移 controller.ts
4. 迁移 view.tsx
5. 迁移 commands.ts
6. 迁移 agent-*.ts
7. 更新 import 路径
8. 测试 TUI 启动

**验收**：
```bash
node dist/cli/index.js
# 应该看到 TUI 界面
```

#### 2.4 Web Integration Plugin（Day 4，6 小时）

**步骤**：
1. 分析 src/web/ 的依赖关系
2. 实现 WebIntegrationPlugin 骨架
3. 迁移 server.ts
4. 迁移 workbench.ts
5. 迁移 collaboration.ts
6. 迁移 packages.ts
7. 更新 import 路径
8. 测试 Web 服务

**验收**：
```bash
node dist/cli/index.js serve --port 3000
# 访问 http://localhost:3000
```

#### 2.5 Agent Authoring Plugin（Day 5，4 小时）

**步骤**：
1. 分析 src/agents/ 的依赖关系
2. 实现 AgentAuthoringPlugin 骨架
3. 迁移 card.ts
4. 迁移 authoring.ts
5. 迁移 authoring-cli.ts
6. 迁移 configuration-save.ts
7. 更新 import 路径
8. 测试 Agent 创建

**验收**：
```bash
node dist/cli/index.js agents new "Test Agent"
```

#### 2.6 每日 Git 提交
```bash
git add -A
git commit -m "Phase 3: Day X 完成 XXX Plugin 迁移"
```

---

### 阶段 3：核心重组（Day 6–7，2 天）

#### 3.1 移动 runtime/（Day 6 上午，2 小时）

```bash
mkdir -p src/core
git mv src/runtime src/core/runtime
```

**更新 import**：
```bash
# 查找所有引用
grep -r "from '../runtime/" src/
grep -r "from './runtime/" src/

# 批量替换（使用编辑器的全局替换功能）
'../runtime/' → '../core/runtime/'
'./runtime/' → './core/runtime/'
```

**测试**：
```bash
npm run check
npm test
```

**提交**：
```bash
git commit -m "Phase 3: 移动 runtime/ → core/runtime/"
```

#### 3.2 移动 providers/（Day 6 上午，1 小时）

```bash
git mv src/providers src/core/providers
```

**更新 import** 并测试，同上。

#### 3.3 移动 storage/（Day 6 下午，1 小时）

```bash
git mv src/storage src/core/storage
```

**更新 import** 并测试，同上。

#### 3.4 移动 messaging/（Day 6 下午，1 小时）

```bash
git mv src/messaging src/core/messaging
```

**更新 import** 并测试，同上。

#### 3.5 移动 packages/（Day 7 上午，1 小时）

```bash
git mv src/packages src/core/packages
```

**更新 import** 并测试，同上。

#### 3.6 移动 sandbox/（Day 7 上午，1 小时）

```bash
git mv src/sandbox src/core/sandbox
# 或
git mv src/sandbox src/isolation
```

**更新 import** 并测试，同上。

#### 3.7 每步提交
```bash
git commit -m "Phase 3: 移动 XXX/ → core/XXX/"
```

---

### 阶段 4：清理旧目录（Day 7 下午，4 小时）

#### 4.1 确认应用已迁移

**检查清单**：
- [ ] CliIntegrationPlugin 工作正常
- [ ] EvalIntegrationPlugin 工作正常
- [ ] TuiIntegrationPlugin 工作正常
- [ ] WebIntegrationPlugin 工作正常
- [ ] AgentAuthoringPlugin 工作正常

#### 4.2 删除旧目录

```bash
# 删除 agents/（已迁移到 integrations/agent-authoring-plugin.ts）
git rm -r src/agents

# 删除 cases/（已迁移到 integrations/eval-plugin.ts）
git rm -r src/cases

# 清理 cli/（保留 index.ts）
git rm src/cli/config-binding.ts
git rm src/cli/interactive.ts
git rm src/cli/terminal.ts
git rm src/cli/tui-host.ts
# ... 其他文件
# 保留 src/cli/index.ts

# 删除 tui/（已迁移到 integrations/tui-plugin.ts）
git rm -r src/tui

# 删除 web/（已迁移到 integrations/web-plugin.ts）
git rm -r src/web
```

#### 4.3 清理 application/index.ts

**选项 1**：保留作为兼容层
```typescript
// src/application/index.ts
/** @deprecated Use KodoRuntime.create() with PluginRegistry instead */
export class Application {
  constructor(options) {
    console.warn('Application class is deprecated.');
    // 内部转换为新 API
    this.runtime = KodoRuntime.create(...);
  }
}
```

**选项 2**：移除，直接使用新 API
```bash
git rm src/application/index.ts
```

**建议**：Phase 3 保留兼容层，Phase 4 移除。

#### 4.4 提交
```bash
git add -A
git commit -m "Phase 3: 清理旧目录（agents/、cases/、tui/、web/）"
```

---

### 阶段 5：更新引用（Day 8，1 天）

#### 5.1 更新 package.json

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./core": "./dist/core/index.js",
    "./core/runtime": "./dist/core/runtime/index.js",
    "./core/providers": "./dist/core/providers/index.js",
    "./core/storage": "./dist/core/storage/index.js",
    "./plugins": "./dist/plugins/index.js",
    "./capabilities": "./dist/capabilities/index.js",
    "./tools": "./dist/tools/index.js",
    "./integrations": "./dist/integrations/index.js"
  }
}
```

#### 5.2 更新 tsconfig.json

```json
{
  "compilerOptions": {
    "paths": {
      "@kodo/core/*": ["./src/core/*"],
      "@kodo/plugins/*": ["./src/plugins/*"],
      "@kodo/capabilities/*": ["./src/capabilities/*"],
      "@kodo/tools/*": ["./src/tools/*"],
      "@kodo/integrations/*": ["./src/integrations/*"]
    }
  }
}
```

#### 5.3 更新测试文件

```bash
# 查找所有测试文件中的旧 import
grep -r "from '../src/runtime/" tests/
grep -r "from '../src/cli/" tests/

# 更新为新路径
'../src/runtime/' → '../src/core/runtime/'
'../src/cli/' → '../src/integrations/cli-plugin'
```

#### 5.4 运行完整测试套件

```bash
npm run check
npm test
npm run build
```

#### 5.5 提交
```bash
git commit -m "Phase 3: 更新 package.json、tsconfig.json 和测试文件"
```

---

## 清理后的文件统计

### 预期减少

| 维度 | 清理前 | 清理后 | 减少 |
|---|---|---|---|
| 文件数 | 159 | ~120 | ~39 |
| 代码行 | 85K | ~75K | ~10K |
| 顶层目录 | 14 | 9 | 5 |

**减少原因**：
- 应用重构为插件（减少重复代码）
- 工具精简（24 → 10）
- 去除过时代码
- 合并相似功能

### 清理后的顶层目录

```
src/
├── core/           [执行核心，50K LOC]
├── plugins/        [插件接口，500 LOC]
├── capabilities/   [能力插件，3K LOC]
├── tools/          [工具插件，5K LOC]
├── integrations/   [应用集成，10K LOC]
├── isolation/      [隔离层，2K LOC，可选]
├── plugin-registry.ts  [500 LOC]
├── factory.ts          [500 LOC]
└── types.ts            [200 LOC]
```

**优势**：
- 目录更少，更易导航
- 职责更清晰
- 依赖更明确
- 新用户更容易理解

---

## 风险与缓解

### 风险 1：import 路径更新遗漏

**症状**：运行时找不到模块

**检测**：
```bash
npm run build
# TypeScript 会报错
```

**缓解**：
- 使用 TypeScript 编译器检查
- 使用 grep 全局搜索旧路径
- 使用编辑器的全局替换功能
- 分批次迁移，每批次测试

### 风险 2：Git 操作失误

**症状**：文件丢失或历史混乱

**缓解**：
- 使用 `git mv` 而不是手动移动（保留历史）
- 每步操作后立即提交
- 使用 worktree，不影响主分支
- 定期 push 到远程备份

### 风险 3：测试失败

**症状**：清理后测试不通过

**缓解**：
- 边迁移边测试，不积累问题
- 保留完整的测试套件
- 使用持续集成（CI）
- 回退到上一个正常提交

### 风险 4：运行时行为改变

**症状**：功能表现不一致

**缓解**：
- 保留兼容层
- 进行充分的集成测试
- 对比清理前后的行为
- 使用快照测试

---

## 验收清单

### 目录结构验收

- [ ] src/core/ 包含 runtime/、providers/、storage/、messaging/、packages/、sandbox/
- [ ] src/plugins/ 包含 4 个接口文件
- [ ] src/capabilities/ 包含 context/、memory/、knowledge/
- [ ] src/tools/ 包含 10 个工具文件
- [ ] src/integrations/ 包含 5 个集成插件
- [ ] src/plugin-registry.ts 存在
- [ ] src/factory.ts 存在
- [ ] 旧目录已删除（agents/、cases/、cli/ 大部分、tui/、web/）

### 编译验收

- [ ] `npm run check` 通过（无 TypeScript 错误）
- [ ] `npm run build` 成功
- [ ] 生成的 dist/ 目录结构正确

### 测试验收

- [ ] `npm test` 全部通过
- [ ] CLI 命令可用（`kodo --version`、`kodo doctor`）
- [ ] TUI 启动正常
- [ ] Web 服务启动正常
- [ ] 案例执行正常
- [ ] Agent 创建正常

### 导入路径验收

- [ ] 无旧路径残留（`grep -r "from '../runtime/" src/` 无结果）
- [ ] package.json 的 exports 更新
- [ ] tsconfig.json 的 paths 更新

---

## 执行检查点

### Day 1 检查点
- [ ] 目录骨架创建完成
- [ ] 文件骨架创建完成
- [ ] Git 提交

### Day 2 检查点
- [ ] CliIntegrationPlugin 迁移完成
- [ ] EvalIntegrationPlugin 迁移完成
- [ ] CLI 命令可用
- [ ] 案例执行可用
- [ ] Git 提交

### Day 3 检查点
- [ ] TuiIntegrationPlugin 迁移完成
- [ ] TUI 启动正常
- [ ] Git 提交

### Day 4 检查点
- [ ] WebIntegrationPlugin 迁移完成
- [ ] Web 服务启动正常
- [ ] Git 提交

### Day 5 检查点
- [ ] AgentAuthoringPlugin 迁移完成
- [ ] Agent 创建可用
- [ ] Git 提交

### Day 6 检查点
- [ ] runtime/、providers/、storage/ 移动完成
- [ ] 测试通过
- [ ] Git 提交

### Day 7 检查点
- [ ] messaging/、packages/、sandbox/ 移动完成
- [ ] 旧目录清理完成
- [ ] 测试通过
- [ ] Git 提交

### Day 8 检查点
- [ ] package.json、tsconfig.json 更新
- [ ] 所有测试通过
- [ ] Git 提交
- [ ] 准备合并到主分支

---

## 后续工作

### Phase 4：文档与验收（Day 9–10）

1. 完善架构文档
2. 完善插件开发指南
3. 完善用户指南
4. 完善示例代码
5. 运行完整集成测试
6. 性能对比测试
7. 新用户测试

### 合并到主分支

```bash
# 在主分支
git checkout main
git merge claude/phase3-integration-cleanup-e86094
git push origin main
```

---

## 参考

- [Phase 3 总体设计](phase3-integration-cleanup-design.md)
- [Phase 3 当前状态](../../../AppData/Local/Claude-3p/side-session-notes/local_e685eee4-688c-4ad9-8eed-c2d5336c51df/phase3-integration-status.md)
