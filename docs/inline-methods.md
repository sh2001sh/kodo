# 按阶段加载能力：P1–P4 实验功能

默认关闭。主 Agent 保留项目理解和执行历史，按需加载一个卡片方法；独立子 Agent 用于独立模型、成员合同或显式选择的子任务。方法加载不等于任务完成。

```ts
const app = new Application(dataDirectory, provider, undefined, {
  inlineMethods: true,
  methodUnloading: true,
  methodToolView: 'stable', // active 只展示当前方法的工具
  toolProfile: 'compact-v2',
});
app.registerCard(app.parseCard(agentMarkdown));
const run = app.createRun({ workspace, objective, binding, permissions: ['read', 'write', 'exec'] });
await app.run(run.id);
```

卡片沿用 schema v2，增加 `execution: { modes: [inline, child] }`。仅声明 inline 的卡片不能独立启动；旧卡片不自动成为方法。工具、Skill、MCP 仍须由宿主注册并提供给会话。lean-solo/lean-team 没有对应 Skill 入口，不能启用本功能。

## 方法与阶段

`skill.list` 返回方法摘要、精确版本句柄和不能隐式加载的原因。`skill.load` 成功加载后建立当前方法合同；分页、重试和补充普通 Skill 不重复开阶段。加载失败保留旧方法，切换成功追加失效说明。等待和中断不结束方法，实际运行终止才结束。

新运行首请求中的名册明确显示 `execution_modes`；启用方法功能时，inline 卡还显示 `inline_method.id`、`load: skill.load` 与兼容性检查入口 `skill.list`，正文仍按需加载。只有包含 child 模式的卡才能派发。该方法发现入口独立于子 Agent 路由因素 A，但仍受共享指令预算限制，空间不足时退化为分页提示。未开启方法功能时，inline-only 卡不出现在初始子 Agent 名册里。命名输入、报告等合同可能不支持直接 skill.load，应读取目录中的原因再选择显式激活。

命名输入、报告字段和规则文件使用现有 `task` 工具：

| 操作 | 行为 |
|---|---|
| declare | 声明 tasks，包括 id、goal、after、needs |
| activate | 用 node_id、expectedGeneration、card、可选 inputs 绑定方法，或按 execution: child 创建独立运行 |
| extend | 返回当前方法声明的 Skill 加载入口 |
| done | 引用 resultRef 和 checkCallIds；或提供 result: {name, content}，由宿主保存报告，适用于只读方法 |
| inspect / wait | 查看阶段或等待对应子运行 |
| resume / redo / drop | 同代次继续、递增代次重做、注明原因放弃；后继成果失效 |

needs 支持 capabilities、knowledgeQueries、requiredRefs: [{id, revision}]、execution: auto/inline/child。能力标签用于记录与选择，不把自然语言标签匹配当成客观资格认证。主运行同一时间只有一个活动 inline 方法；显式阶段未结束时不能直接切到另一方法。

成果、检查记录、节点状态、方法合同与工具结果在同一事务中提交。恢复沿用持久状态，不重放已提交的外部动作。done 至少引用一次本阶段的实际检查。命令检查必须成功且退出码为零，或工具明确报告通过；材料读取标记为 source-inspection，只证明读取，业务结论仍是 model-review。宿主不把模型选取的任意检查当作完整业务验收。检查之后发生已记录的工作区写入，需重查；决定版本或依赖代次变化不能复用旧完成结论。

## 上下文与工具

方法结束只追加失效说明。原有压力/压缩检查点才移除已结束的方法正文及方法规则，并保留 history.read 指针。阶段输入、项目观察和执行证据不随方法删除；普通参考 Skill 也不按阶段统一删除。当前方法的配对调用与结果保留。原有历史压缩仍可能产生信息损失，属于独立行为。

stable 展示宿主批准的候选集合，执行使用当前方法合同；active 只展示当前合同。两者均不扩大宿主权限。工具切换可能影响缓存，稳定前缀也不保证缓存命中。当前方法、名册修订和阶段代次进入末尾状态帧。

必需输入、方法、工具与输出余量必须放得下；显式激活结果不能超过工具结果预算（32 KiB），超限明确失败，不截断后声称加载成功。大方法使用分页 skill.load 或拆分阶段。

## 项目知识

knowledge.publish 接受本运行成功 file.read 的来源调用，分开声明观察、假设和未决问题。沿用不可变修订、文件哈希和决定版本，结果始终是候选知识。激活时校验必需知识引用的范围和新鲜度，并过滤不能直接复用的搜索结果；知识正确性仍需判断。它不承诺自动消除重复探索。

## 会话热插拔

registerCard 只注册全局卡片，不改变既有会话。宿主显式发布：

```ts
const expectedDigest = app.store.cards.rosterSnapshot(run.sessionId)!.digest;
app.updateSessionMethods(run.id, { expectedDigest, install: [newCard], disable: ['old/method'] });
```

发布校验资源、版本和文件范围，通过名册摘要比较后原子提交。当前阶段固定原版本；停用只阻止后续新挂载。主运行处于模型/工具调用中时返回 METHOD_BUSY，应在调用边界或中断后发布。已有资源绑定不能被新版本覆盖，新资源须先由宿主注册，恢复时重挂同版本资源。发布会追加可见通知。

```text
kodo run "任务" --inline-methods --method-tool-view stable
kodo methods RUN_ID
kodo methods RUN_ID --card AGENT.md --digest CURRENT_DIGEST
kodo methods RUN_ID --disable business/old-method --digest CURRENT_DIGEST

/agents methods
/agents install-method AGENT.md --digest CURRENT_DIGEST
/agents disable-method business/old-method --digest CURRENT_DIGEST
```

Web 提供认证后的 GET/POST `/api/runs/:id/methods`。POST 沿用 CSRF、会话约束和幂等请求头，正文为 `{expectedDigest, card?: "完整 AGENT.md", disable?: string[]}`。接口不安装任意服务器或扩大资源授权。CLI/TUI/Web 恢复保存的卸载和工具视图策略。

## 实验

```powershell
npm run build
node 'scripts/comparison/frontier/method-ablation.mjs' --out '.kodo/method-plan-NEW'
node 'scripts/comparison/frontier/method-ablation.mjs' --out '.kodo/method-run-NEW' --run
```

复用历史 codego1 / deepseek-v4.1-flash、状态机数据作用域与 FastAPI 弃用响应头任务、原窗口/时限、独立容器与验收器。冻结构建、脚本和任务指令摘要，凭据不进入结果。

五组：常驻方法、普通 Skill、完整阶段机制但仅标记、加检查点卸载、加活动工具视图。所有组的方法正文与句柄相同。Skill 与完整机制之间还存在阶段和知识入口差异，是整体比较，不能把全部差异归因于失效标记。标记/卸载与稳定/活动视图分别构成单因素消融。

任务不要求加载方法。记录自主加载分子/预先固定的三个机会点、阶段使用、卸载、交付验收、费用和实际缓存用量。未采用不能算机制收益，没有检查点不能说明卸载有效。每格一次只用于探索。热插拔由宿主集成测试验证，不在真实任务中强制注入以伪造自主采用。旧采购脚本保留为独立合成材料冒烟，不冒充历史任务复测。

2026-11-03 的十组复测已完成，详见 [实验结果与限制](experiments/kodo-method-p1-p4-ablation-20261103.md)。六个阶段组均未主动加载方法，实际卸载和工具定义切换均为零；本轮没有验证出新增机制的收益，功能保持默认关闭。
