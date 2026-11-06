# Phase 3：集成测试计划

## 测试目标

验证 Phase 3 完成后，Kodo 的插件化架构：
1. **功能完整性**：所有功能工作正常，与重构前行为一致
2. **模块独立性**：插件可以独立启用/禁用
3. **性能指标**：不同配置的性能差异有文档化
4. **易用性**：新用户能快速上手

---

## 测试分类

| 测试类别 | 覆盖范围 | 目标 | 执行时间 | 优先级 |
|---|---|---|---|---|
| **E2E 全插件测试** | 所有插件启用 | ≈ 当前系统行为 | 2 小时 | P0 |
| **最小配置测试** | 核心 + 基础工具 | 最小可用系统 | 1 小时 | P0 |
| **部分插件测试** | 选择性禁用 | 验证插件独立性 | 1 小时 | P1 |
| **性能对比测试** | 最小 vs 标准配置 | 性能差异 | 2 小时 | P1 |
| **新用户测试** | 文档 + 示例 | 易用性 | 30 分钟 | P0 |

**总计**：约 6.5 小时

---

## 1. E2E 全插件测试

### 1.1 测试目标

验证所有插件启用时，系统行为与重构前完全一致。

### 1.2 测试配置

```typescript
// tests/integration/e2e-full-config.ts

import { KodoRuntime, PluginRegistry } from 'kodo';
import {
  FileToolPlugin,
  ShellToolPlugin,
  ContextToolPlugin,
  SpawnToolPlugin,
  AskToolPlugin,
  TodoToolPlugin,
  VerifyToolPlugin,
  WebFetchToolPlugin,
} from 'kodo/tools';
import {
  ContextPlugin,
  MemoryPlugin,
  KnowledgePlugin,
} from 'kodo/capabilities';
import {
  CliIntegrationPlugin,
  TuiIntegrationPlugin,
  WebIntegrationPlugin,
  EvalIntegrationPlugin,
  AgentAuthoringPlugin,
} from 'kodo/integrations';

export function createFullConfig() {
  const registry = new PluginRegistry();

  // 工具插件（8 个）
  registry.register(new FileToolPlugin());
  registry.register(new ShellToolPlugin());
  registry.register(new ContextToolPlugin());
  registry.register(new SpawnToolPlugin());
  registry.register(new AskToolPlugin());
  registry.register(new TodoToolPlugin());
  registry.register(new VerifyToolPlugin());
  registry.register(new WebFetchToolPlugin());

  // 能力插件（3 个）
  registry.register(new ContextPlugin());
  registry.register(new MemoryPlugin());
  registry.register(new KnowledgePlugin());

  // 集成插件（5 个）
  registry.register(new CliIntegrationPlugin());
  registry.register(new TuiIntegrationPlugin());
  registry.register(new WebIntegrationPlugin());
  registry.register(new EvalIntegrationPlugin());
  registry.register(new AgentAuthoringPlugin());

  return KodoRuntime.create({ registry });
}
```

### 1.3 测试用例

#### TC-001：CLI 基础命令

**描述**：验证 CLI 命令行工具正常工作。

**步骤**：
```bash
# 1. 版本信息
node dist/cli/index.js --version
# 预期：显示版本号

# 2. 健康检查
node dist/cli/index.js doctor
# 预期：显示系统状态

# 3. 简单任务
node dist/cli/index.js run "列出当前目录的文件" --allow-write
# 预期：执行成功，列出文件
```

**预期结果**：
- 版本号正确显示
- doctor 显示所有检查通过
- 简单任务执行成功

**验收标准**：
- ✅ 所有命令返回退出码 0
- ✅ 输出符合预期格式
- ✅ 无错误或警告

---

#### TC-002：TUI 启动

**描述**：验证 TUI 交互式界面正常启动。

**步骤**：
```bash
node dist/cli/index.js
```

**预期结果**：
- TUI 界面正常显示
- 显示 Kodo 点阵标识
- 输入框可用
- 命令面板可打开（/help）

**验收标准**：
- ✅ 界面渲染正确
- ✅ 无 Ink 渲染错误
- ✅ 快捷键响应正常（Ctrl+P, Ctrl+C）

**注意**：需要 TTY 环境。

---

#### TC-003：案例评测

**描述**：验证案例评测框架正常工作。

**步骤**：
```bash
# 1. 创建测试案例
cat > test-case.json << 'EOF'
{
  "name": "simple-list",
  "objective": "列出当前目录",
  "assertions": [
    {
      "type": "exit_code",
      "expected": 0
    }
  ]
}
EOF

# 2. 冻结案例
node dist/cli/index.js case freeze test-case.json --output frozen.json

# 3. 执行案例
node dist/cli/index.js case run frozen.json
```

**预期结果**：
- 案例冻结成功
- 案例执行成功
- 断言通过

**验收标准**：
- ✅ 冻结的案例文件结构正确
- ✅ 案例执行无错误
- ✅ 断言结果正确

---

#### TC-004：Web 服务

**描述**：验证 Web 工作台正常启动。

**步骤**：
```bash
# 1. 启动服务
node dist/cli/index.js serve --port 3000 &
PID=$!

# 2. 等待启动
sleep 3

# 3. 测试端点
curl http://localhost:3000/
curl http://localhost:3000/api/status

# 4. 停止服务
kill $PID
```

**预期结果**：
- Web 服务启动成功
- 根路径返回 HTML
- API 端点返回 JSON
- 服务可以正常停止

**验收标准**：
- ✅ HTTP 响应码 200
- ✅ 返回内容正确
- ✅ 无内存泄漏

---

#### TC-005：Agent 创作

**描述**：验证 Agent 创作工具正常工作。

**步骤**：
```bash
# 1. 创建 Agent
node dist/cli/index.js agents new "测试代理" \
  --id local/test-agent \
  --output test-agent

# 2. 验证生成的文件
ls test-agent/
cat test-agent/AGENT.md
```

**预期结果**：
- Agent 创建成功
- 生成 AGENT.md 卡片文件
- 卡片格式正确

**验收标准**：
- ✅ 文件生成
- ✅ 卡片可以解析
- ✅ 验证通过

---

#### TC-006：子代理委派

**描述**：验证子代理委派功能正常工作。

**步骤**：
```bash
# 创建测试任务
node dist/cli/index.js run "创建两个子任务：1. 列出文件，2. 显示时间" \
  --allow-write \
  --max-active-children 2
```

**预期结果**：
- 主代理启动
- 创建 2 个子代理
- 子代理执行任务
- 主代理汇总结果

**验收标准**：
- ✅ 子代理成功创建
- ✅ 子代理并行执行
- ✅ 主代理接收到结果
- ✅ 最终输出正确

---

#### TC-007：知识检索

**描述**：验证项目知识检索功能正常工作。

**前置条件**：
- 项目中有文档文件
- 知识索引已建立

**步骤**：
```bash
node dist/cli/index.js run "总结 README.md 的主要内容" --allow-write
```

**预期结果**：
- 知识检索触发
- 找到相关文档
- 生成摘要

**验收标准**：
- ✅ 检索成功
- ✅ 摘要准确
- ✅ 引用正确

---

#### TC-008：项目记忆

**描述**：验证项目记忆功能正常工作。

**步骤**：
```bash
# 1. 保存记忆
node dist/cli/index.js run "记住：项目使用 TypeScript 5.0" --memory

# 2. 回忆记忆
node dist/cli/index.js run "这个项目使用什么语言？" --memory
```

**预期结果**：
- 记忆保存成功
- 记忆可以检索
- 回答正确

**验收标准**：
- ✅ 记忆文件生成
- ✅ 记忆可检索
- ✅ 回答包含记忆内容

---

### 1.4 测试脚本

```bash
#!/bin/bash
# tests/integration/run-e2e-tests.sh

set -e

echo "=== E2E 全插件测试 ==="

echo "TC-001: CLI 基础命令"
node dist/cli/index.js --version
node dist/cli/index.js doctor

echo "TC-003: 案例评测"
cat > test-case.json << 'EOF'
{
  "name": "simple-list",
  "objective": "列出当前目录",
  "assertions": [{"type": "exit_code", "expected": 0}]
}
EOF
node dist/cli/index.js case freeze test-case.json --output frozen.json
node dist/cli/index.js case run frozen.json
rm test-case.json frozen.json

echo "TC-004: Web 服务"
node dist/cli/index.js serve --port 3000 &
PID=$!
sleep 3
curl http://localhost:3000/ > /dev/null
curl http://localhost:3000/api/status > /dev/null
kill $PID

echo "TC-005: Agent 创作"
node dist/cli/index.js agents new "测试代理" --id local/test-agent --output test-agent
test -f test-agent/AGENT.md
rm -rf test-agent/

echo "=== 所有 E2E 测试通过 ==="
```

---

## 2. 最小配置测试

### 2.1 测试目标

验证只使用核心 + 基础工具时，系统可以正常工作。

### 2.2 测试配置

```typescript
// tests/integration/minimal-config.ts

import { KodoRuntime, PluginRegistry } from 'kodo';
import { FileToolPlugin, ShellToolPlugin } from 'kodo/tools';
import { CliIntegrationPlugin } from 'kodo/integrations';

export function createMinimalConfig() {
  const registry = new PluginRegistry();

  // 只有 2 个基础工具
  registry.register(new FileToolPlugin());
  registry.register(new ShellToolPlugin());

  // 只有 CLI 集成
  registry.register(new CliIntegrationPlugin());

  return KodoRuntime.create({ registry });
}
```

### 2.3 测试用例

#### TC-MIN-001：文件读写

```bash
node dist/cli/index.js run "读取 package.json 的 name 字段" \
  --tool-profile minimal
```

**预期**：成功读取并返回 name 字段。

#### TC-MIN-002：Shell 执行

```bash
node dist/cli/index.js run "执行 ls 命令" \
  --tool-profile minimal \
  --allow-exec
```

**预期**：成功执行命令并返回结果。

#### TC-MIN-003：基础对话

```bash
node dist/cli/index.js run "什么是 TypeScript？" \
  --tool-profile minimal
```

**预期**：返回关于 TypeScript 的回答（无工具调用）。

### 2.4 验收标准

- ✅ 核心功能可用
- ✅ 无插件依赖错误
- ✅ 性能更快（见性能对比测试）

---

## 3. 部分插件测试

### 3.1 测试目标

验证插件可以独立启用/禁用，不会相互干扰。

### 3.2 测试矩阵

| 配置 | 工具插件 | 能力插件 | 集成插件 | 测试用例 |
|---|---|---|---|---|
| 无能力插件 | 全部 | 无 | CLI | 基础任务 |
| 无工具插件 | 无 | 全部 | CLI | 纯对话 |
| 无知识插件 | 全部 | Context, Memory | CLI | 任务（无知识检索） |
| 无记忆插件 | 全部 | Context, Knowledge | CLI | 任务（无记忆） |

### 3.3 测试用例

#### TC-PART-001：无能力插件

```typescript
const registry = new PluginRegistry();
registry.register(new FileToolPlugin());
registry.register(new ShellToolPlugin());
registry.register(new ContextToolPlugin());
registry.register(new CliIntegrationPlugin());
// 无能力插件

const runtime = KodoRuntime.create({ registry });
```

**测试**：运行基础任务

**预期**：任务成功，但无上下文管理、记忆、知识功能。

#### TC-PART-002：无工具插件

```typescript
const registry = new PluginRegistry();
registry.register(new ContextPlugin());
registry.register(new MemoryPlugin());
registry.register(new KnowledgePlugin());
registry.register(new CliIntegrationPlugin());
// 无工具插件

const runtime = KodoRuntime.create({ registry });
```

**测试**：纯对话

**预期**：对话成功，但不能执行文件操作或 Shell 命令。

### 3.4 验收标准

- ✅ 无插件依赖错误
- ✅ 功能正确降级
- ✅ 错误消息清晰

---

## 4. 性能对比测试

### 4.1 测试目标

测量不同配置的性能差异，并文档化。

### 4.2 测试基准

| 任务 | 描述 | 预期时间 |
|---|---|---|
| **简单任务** | 读取文件 + 回答问题 | < 5 秒 |
| **中等任务** | 多文件分析 + 生成报告 | < 30 秒 |
| **复杂任务** | 子代理协作 + 知识检索 | < 2 分钟 |

### 4.3 测试配置

- **最小配置**：核心 + 2 工具（File, Shell）
- **标准配置**：核心 + 10 工具 + 3 能力 + 5 集成

### 4.4 性能指标

```typescript
interface PerformanceMetrics {
  // 启动时间
  startupTime: number;

  // 首次响应时间
  firstResponseTime: number;

  // 内存占用
  memoryUsage: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };

  // Token 使用量
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };

  // 任务完成时间
  taskCompletionTime: number;
}
```

### 4.5 测试脚本

```typescript
// tests/performance/benchmark.ts

import { performance } from 'perf_hooks';
import { createMinimalConfig } from './minimal-config';
import { createFullConfig } from './e2e-full-config';

async function benchmark(
  name: string,
  configFn: () => KodoRuntime,
  task: string
): Promise<PerformanceMetrics> {
  const startTime = performance.now();

  const runtime = configFn();

  const startupTime = performance.now() - startTime;

  const responseStart = performance.now();
  const result = await runtime.run(task);
  const firstResponseTime = performance.now() - responseStart;

  const mem = process.memoryUsage();

  return {
    startupTime,
    firstResponseTime,
    memoryUsage: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    tokenUsage: result.usage,
    taskCompletionTime: result.duration,
  };
}

// 运行基准测试
async function runBenchmarks() {
  const tasks = [
    { name: '简单任务', task: '读取 package.json 的 name 字段' },
    { name: '中等任务', task: '分析 src/ 目录下的所有 .ts 文件' },
  ];

  for (const { name, task } of tasks) {
    console.log(`\n=== ${name} ===`);

    const minimal = await benchmark('最小配置', createMinimalConfig, task);
    console.log('最小配置:', minimal);

    const full = await benchmark('标准配置', createFullConfig, task);
    console.log('标准配置:', full);

    const speedup = full.taskCompletionTime / minimal.taskCompletionTime;
    console.log(`加速比: ${speedup.toFixed(2)}x`);
  }
}

runBenchmarks();
```

### 4.6 预期结果

| 任务 | 配置 | 启动时间 | 首次响应 | 内存占用 | Token 使用 |
|---|---|---|---|---|---|
| 简单任务 | 最小 | < 100ms | < 3s | < 50MB | < 1K |
| 简单任务 | 标准 | < 200ms | < 5s | < 100MB | < 2K |
| 中等任务 | 最小 | < 100ms | < 20s | < 100MB | < 10K |
| 中等任务 | 标准 | < 200ms | < 30s | < 150MB | < 15K |

**注意**：实际数字需要真实测量。

### 4.7 性能报告模板

```markdown
# Kodo 性能对比报告

## 测试环境
- Node.js: 24.x
- OS: Windows 11 / Linux / macOS
- CPU: ...
- RAM: ...

## 测试配置
- 最小配置：核心 + 2 工具
- 标准配置：核心 + 10 工具 + 3 能力 + 5 集成

## 测试结果

### 简单任务（读取文件 + 回答）

| 指标 | 最小配置 | 标准配置 | 差异 |
|---|---|---|---|
| 启动时间 | 95ms | 180ms | +89% |
| 首次响应 | 2.8s | 4.5s | +61% |
| 内存占用 | 48MB | 95MB | +98% |
| Token 使用 | 850 | 1500 | +76% |

### 中等任务（多文件分析）

| 指标 | 最小配置 | 标准配置 | 差异 |
|---|---|---|---|
| 启动时间 | 95ms | 180ms | +89% |
| 首次响应 | 18s | 28s | +56% |
| 内存占用 | 95MB | 145MB | +53% |
| Token 使用 | 8500 | 14000 | +65% |

## 结论

- 最小配置适合：简单任务，资源受限环境
- 标准配置适合：复杂任务，需要完整功能
- 性能开销：约 50%–100%，但换来完整功能
```

---

## 5. 新用户测试

### 5.1 测试目标

验证新用户能在 30 分钟内从零到运行示例。

### 5.2 测试场景

假设一个新用户，从未使用过 Kodo：
1. 没有代码库
2. 没有配置
3. 只有文档

### 5.3 测试流程

#### Step 1：阅读文档（5 分钟）

**任务**：阅读 docs/README.md

**预期**：
- 理解 Kodo 是什么
- 理解五层架构
- 知道如何开始

**验收**：
- [ ] 用户能用自己的话解释 Kodo
- [ ] 用户能画出五层架构图
- [ ] 用户知道下一步做什么

#### Step 2：安装和配置（10 分钟）

**任务**：
```bash
# 1. 克隆仓库
git clone https://github.com/your-org/kodo.git
cd kodo

# 2. 安装依赖
npm ci

# 3. 构建
npm run build

# 4. 配置模型（可选）
node dist/cli/index.js config
```

**预期**：
- 所有步骤成功
- 无错误或警告
- 配置文件生成

**验收**：
- [ ] 构建成功
- [ ] 可执行 `kodo --version`
- [ ] 配置文件存在（如果配置了）

#### Step 3：运行最小示例（5 分钟）

**任务**：
```bash
# 运行 examples/minimal-setup.ts
node examples/minimal-setup.js
```

**预期**：
- 示例成功运行
- 输出符合预期
- 无错误

**验收**：
- [ ] 示例运行成功
- [ ] 用户理解代码做了什么

#### Step 4：运行标准示例（5 分钟）

**任务**：
```bash
# 运行 examples/standard-setup.ts
node examples/standard-setup.js
```

**预期**：
- 示例成功运行
- 用户看到更多功能
- 理解配置差异

**验收**：
- [ ] 示例运行成功
- [ ] 用户理解最小 vs 标准配置的区别

#### Step 5：创建自定义工具（5 分钟）

**任务**：
```bash
# 运行 examples/custom-tool-example.ts
node examples/custom-tool-example.js
```

**预期**：
- 示例成功运行
- 用户理解如何创建工具

**验收**：
- [ ] 示例运行成功
- [ ] 用户能修改示例代码
- [ ] 用户能添加自己的逻辑

### 5.4 成功标准

- ✅ 30 分钟内完成所有步骤
- ✅ 理解五层架构
- ✅ 成功运行所有示例
- ✅ 能创建简单插件

### 5.5 失败分析

如果用户卡住，记录：
- 卡在哪一步？
- 什么导致卡住？
- 文档哪里不清楚？
- 需要什么改进？

---

## 6. 测试自动化

### 6.1 自动化测试脚本

```bash
#!/bin/bash
# tests/integration/run-all-tests.sh

set -e

echo "=== Kodo Phase 3 集成测试 ==="

echo "1. E2E 全插件测试"
./tests/integration/run-e2e-tests.sh

echo "2. 最小配置测试"
node tests/integration/minimal-config.test.js

echo "3. 部分插件测试"
node tests/integration/partial-plugins.test.js

echo "4. 性能对比测试"
node tests/performance/benchmark.js

echo "=== 所有测试通过 ==="
```

### 6.2 CI 集成

```yaml
# .github/workflows/integration-tests.yml

name: Integration Tests

on:
  push:
    branches: [main, claude/phase3-*]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [24.x]

    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: ${{ matrix.node }}

      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: ./tests/integration/run-all-tests.sh
```

---

## 7. 测试报告模板

```markdown
# Phase 3 集成测试报告

**日期**：2026-11-XX  
**版本**：v0.3.0  
**测试人员**：XXX

## 测试环境

- Node.js: 24.x
- OS: Windows 11 / Ubuntu 22.04
- 分支：claude/phase3-integration-cleanup-e86094

## 测试结果汇总

| 测试类别 | 总数 | 通过 | 失败 | 跳过 | 通过率 |
|---|---|---|---|---|---|
| E2E 全插件测试 | 8 | 8 | 0 | 0 | 100% |
| 最小配置测试 | 3 | 3 | 0 | 0 | 100% |
| 部分插件测试 | 4 | 4 | 0 | 0 | 100% |
| 性能对比测试 | 2 | 2 | 0 | 0 | 100% |
| 新用户测试 | 1 | 1 | 0 | 0 | 100% |
| **总计** | **18** | **18** | **0** | **0** | **100%** |

## 详细结果

### E2E 全插件测试

- ✅ TC-001: CLI 基础命令
- ✅ TC-002: TUI 启动
- ✅ TC-003: 案例评测
- ✅ TC-004: Web 服务
- ✅ TC-005: Agent 创作
- ✅ TC-006: 子代理委派
- ✅ TC-007: 知识检索
- ✅ TC-008: 项目记忆

### 最小配置测试

- ✅ TC-MIN-001: 文件读写
- ✅ TC-MIN-002: Shell 执行
- ✅ TC-MIN-003: 基础对话

### 部分插件测试

- ✅ TC-PART-001: 无能力插件
- ✅ TC-PART-002: 无工具插件
- ✅ TC-PART-003: 无知识插件
- ✅ TC-PART-004: 无记忆插件

### 性能对比测试

- ✅ 简单任务：最小 vs 标准配置
- ✅ 中等任务：最小 vs 标准配置

### 新用户测试

- ✅ 30 分钟完成所有步骤

## 性能数据

（附性能对比报告）

## 发现的问题

（如果有）

## 建议

（如果有）

## 结论

✅ Phase 3 集成测试全部通过，可以进入下一阶段。
```

---

## 8. 测试检查清单

### 测试准备

- [ ] 所有插件已迁移
- [ ] 目录清理完成
- [ ] 代码编译通过
- [ ] 单元测试通过

### 测试执行

- [ ] E2E 全插件测试
  - [ ] TC-001 ~ TC-008 全部通过
- [ ] 最小配置测试
  - [ ] TC-MIN-001 ~ TC-MIN-003 全部通过
- [ ] 部分插件测试
  - [ ] TC-PART-001 ~ TC-PART-004 全部通过
- [ ] 性能对比测试
  - [ ] 简单任务测试完成
  - [ ] 中等任务测试完成
  - [ ] 性能报告生成
- [ ] 新用户测试
  - [ ] 测试完成
  - [ ] 反馈收集

### 测试报告

- [ ] 测试结果汇总
- [ ] 详细测试报告
- [ ] 性能对比报告
- [ ] 问题列表
- [ ] 改进建议

### 测试通过标准

- [ ] 所有 P0 测试通过
- [ ] P1 测试通过 > 90%
- [ ] 无阻塞性问题
- [ ] 性能指标在可接受范围内
- [ ] 新用户测试成功

---

## 9. 风险与缓解

### 风险 1：测试环境不一致

**影响**：测试结果不可靠

**缓解**：
- 使用 Docker 容器统一环境
- CI 矩阵测试多个 OS/Node 版本
- 文档化测试环境要求

### 风险 2：性能测试不稳定

**影响**：无法得出可靠结论

**缓解**：
- 多次运行取平均值
- 使用稳定的测试环境
- 排除网络因素（使用本地模型）

### 风险 3：新用户测试主观性强

**影响**：结果偏差

**缓解**：
- 多个新用户测试
- 标准化测试流程
- 记录详细反馈

---

## 10. 附录

### A. 测试数据

测试数据存放在 `tests/fixtures/` 目录：

```
tests/fixtures/
├── simple-task.json
├── medium-task.json
├── complex-task.json
├── test-agent.md
└── test-case.json
```

### B. 测试工具

- **Vitest**：单元测试和集成测试
- **node-tap**：CLI 测试
- **supertest**：HTTP 测试
- **benchmark.js**：性能测试

### C. 参考文档

- [Phase 3 总体设计](phase3-integration-cleanup-design.md)
- [Phase 3 目录清理计划](phase3-directory-cleanup-plan.md)
