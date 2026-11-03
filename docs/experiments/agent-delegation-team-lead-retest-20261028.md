# 负责人模式委派复测：2026-10-28

结论：本次负责人提示已实际加载，但在 `codego1 / deepseek-v4.1-flash` 的 7 轮实质任务中，自主创建队友、子运行和续接均为 0，待办工具调用也为 0。显式正控制成功创建 1 位队友、执行 2 个子运行并续接 1 次，8 项控制条件全部通过。创建和复用能力可用，但本批没有观察到新的默认分工被采用。

此外，补充边界检查确认一个容量释放缺陷：已取消子任务的未知写调用完成对账后，恢复计划已无阻塞，容量计算仍读取原始 `unknown` 状态，继续占用活跃名额。这与正常结束释放容量是两条不同路径，现有相关回归通过没有覆盖该缺陷。

## 范围与方法

Windows、Node `v24.13.0`。先运行检查和构建，再冻结源码及完整 dist，模型任务均在隔离副本中执行。构建清单的源码摘要为 `e23f302f3e29f3c99972aeca10d9a3b95e89ee60ceb0003a12c6e3cebef98e52`。功能任务沿用同一冻结快照，没有在后续读取实时工作区重新拼装源码。

本轮因子 B 是“负责人模式”：实质调查、实现、测试执行与审查默认委派，包含串行工作；简短已知事实可直接回答。它不同于[上一轮选择性委派报告](E:/sh/Coding/agent-harness/docs/experiments/agent-delegation-real-acceptance-20261028.md)中的“新指导”。原报告和原始结果保留。

调查对照只切换 B：基线 `{A:true,B:false,C:true}`，负责人组 `{A:true,B:true,C:true}`，顺序为基线／负责人／负责人／基线，每个负责人调查后追加同主题追问。生命周期、工具和其他设置相同。全局用户指令、额外委派提醒和动态组装关闭，保留默认条件性摘要。任务没有要求创建队友或并行，也没有预先创建团队。

调查预算：100 次模型调用、200 万 token、350 次工具调用、600 秒，窗口 65,536、输出上限 8,192；活跃子任务上限 8、累计不限、并发模型上限 2。完整功能任务预算为 150 次模型调用、400 万 token、900 秒。调查和功能模型执行均串行；正控制在功能模型结束后开始，与其独立评测的末段存在时间重叠，不影响所报告的功能模型执行时长。

已核对实际持久化模型请求：负责人身份、默认委派、串行委派、先规划和待办要求均存在，`spawn_agent` 的强化说明以及创建、调查、续接、待办工具均可见。基线没有这些负责人提示。因此本批零采用不能归因于加载了旧提示或隐藏了协作工具。

## 真实任务结果

| 默认策略任务 | 轮数 | 交付结果 | 新队友 | 子运行 | 续接 |
| --- | ---: | --- | ---: | ---: | ---: |
| 八项真实源码默认值调查 | 2 | 两次均 8/8，未修改文件 | 0 | 0 | 0 |
| 同主题生命周期追问 | 2 | 均完成；存在对账释放说明和前轮状态的事实错误 | 0 | 0 | 0 |
| README 补充活跃容量参数 | 1 | 只修改指定文档，语义复核通过 | 0 | 0 | 0 |
| history.read 分页回归修复 | 1 | 只修改指定源码；外部复验 2 项通过 | 0 | 0 | 0 |
| 版本查询 API、CLI、文档与新测试 | 1 | 11 项行为检查、67 项独立回归及类型／静态检查通过；范围计分修正见下文 | 0 | 0 | 0 |

以上 7 轮是按本次设计应默认分派执行的任务。小文档修改也计入，不能沿用上一版“小任务直接做即符合设计”的口径。主代理实际自行完成了调查、修改和验证；没有记录委派阻塞理由，也没有形成子任务并行区间。

另测简短已知事实问答 1 次：一句话正确解释 Git 工作区和暂存区，4.262 秒、9,584 token、无工具调用、无子代理，符合该例外。显式禁止委派的源码核对也正确返回 120,000 毫秒和 240 字符，22.998 秒、64,142 token、无创建或续接。由于默认样本本就零采用，禁止委派样本对区分策略行为的辨别力有限。

追问前没有合适的既有队友，因此两次自主追问不构成“已有队友时是否优先复用”的有效实验，不能用续接为 0 判定续接机制失效。该机制由下面的显式正控制单独检验。

## 调查对照与历史结果

| 本轮组别／样本 | 数值与定义路径核对 | 模型调用 | token | 墙钟 |
| --- | --- | ---: | ---: | ---: |
| 基线 1 | 8/8 | 18 | 398,463 | 96.057 秒 |
| 基线 2 | 8/8 | 20 | 530,504 | 110.984 秒 |
| 负责人 1 | 8/8 | 17 | 384,465 | 82.501 秒 |
| 负责人 2 | 8/8 | 15 | 330,862 | 77.578 秒 |
| 基线均值 | 8/8 | 19 | 464,483.5 | 103.5205 秒 |
| 负责人均值 | 8/8 | 16 | 357,663.5 | 80.0395 秒 |

本轮负责人样本平均时长减少 22.7%、token 减少 23.0%，但两组均没有委派；每组只有两次，不支持稳定收益或多代理协作收益的结论。token 包含模型报告的缓存输入，不等于货币成本。负责人组两次额外追问分别为 191.976／240.186 秒、883,422／1,148,952 token。

上一轮选择性指导的调查均值为 105.985 秒、427,105 token，历史基线为 85.758 秒、339,662.5 token；那一轮 7 轮实质任务同样零自主创建。历史值用于对照记录，不能与本轮构成仅切换提示的同时期因果比较。

完整功能任务本轮为 472.933 秒、55 次模型调用、1,812,439 token，含一次摘要调用；上一轮为 513.390 秒、52 次调用、1,813,037 token。均为单次观察，两个版本都未委派。本轮主输入峰值 41,654 token，主代理调用工具 65 次。

## 当前版本显式创建与复用正控制

正控制明确要求使用协作工具，不计入自主采用率。两轮完成“创建 → 等待 → 检查原始读取证据 → 主任务追问 → 同一队友续接 → 检查结果”。8 项控制条件全部通过：

- 仅 1 个稳定 `agentId`，对应 2 个不同子 `runId`，两轮都完成。
- `spawn_agent`、`followup_task` 各实际成功调用 1 次；续接链指向前轮。
- 首轮队友读到的完整随机标识在两轮交付中返回，并存在于续接工作上下文中。
- 标识文件仅由第一轮队友读取一次，主代理未读，第二轮未重读。
- 主代理通过带 `call_id` 的 `inspect_run` 检查了真实读取证据。

两轮合计 101.775 秒、22 次模型调用、294,781 token，无失败工具调用。这里的“1 位队友／2 个运行”按新身份指标计算，不能把旧指标 `spawnedChildren=2` 解读为创建了两位队友。

## 已确认缺陷：终态对账后的活跃名额未释放

位置：[childIsActive](E:/sh/Coding/agent-harness/src/messaging/spawn-spec.ts:76) 与 [RecoveryManager.commit](E:/sh/Coding/agent-harness/src/runtime/recovery.ts:248)。

在隔离状态目录建立明确标记的合成子任务及未知写调用，没有执行模型、命令或真实写工具。活跃上限设为 1，以检查边界。将子任务设为 `cancelled`，通过公开宿主入口 `Application.resolveCall` 确认调用成功后，关键原始结果为：

```text
resolutionAPI: Application.resolveCall
plan.calls[0].status: succeeded
plan.blocked: []
persistedCallStatus: unknown
after.active: 1
after.remainingActive: 0
newTaskAdmitted: false
admissionError: KodoError: active child limit reached (1/1)
passed: false
```

原因是 `commit` 为保持终态记录不可变，只记录对账事件，不改原调用行；`childIsActive` 仍直接检查原调用行的 `planned/running/unknown`，没有消费已验证的有效状态。对账完成的取消任务因而继续占位，可能在达到活跃上限后阻止后续派发或复用。应在保持历史记录不可变的前提下，让容量判定使用经过对账的有效状态，并继续保留真正未收敛调用的占位约束。

现有 `tests/agent-followup.test.ts` 的取消用例把挂起读取调用直接改为 `cancelled`，覆盖了原调用状态已落定的路径，没有覆盖“终态原记录保持 unknown，但已有成功对账事件”的路径。该缺陷也不解释本批默认零采用：默认任务开始时没有子任务占位，创建工具可用。

## 模型错误与评测修正

两次生命周期追问都将对账完成后释放容量说得过于确定，补充检查已经反证这一细节。第二次追问末尾还声称上一轮第 5、6 项为“未知”；保存的上一轮回答实际明确提供了 200 和 5,000。两轮追问不能只按 `completed` 状态当作全部事实验收通过。

功能任务有一次错误 `expectedHash` 被拒绝，之后成功修正；没有出现上一轮连续四次重复同一个错误哈希的情况。另有一次工具超时参数超出 schema 上限被拒。新增测试首跑 6 过、1 失败，原因是模型写的断言期待 provenance 错误，而既有实现先报告文件摘要错误；修正该新测试后 7 项通过，独立行为检查也确认篡改版本会失败。一次读取 Git HEAD 中尚未跟踪文件的命令返回非零，未改变产物。失败与重试全部计入用量，不删除记录。

分页副本注入的是原有源码的普通游标回退回归。评测器跳过了已知无页数上界的负样本预跑；模型自行在修复前运行了现有测试，仍导致 worker 退出 134。修复后模型记录所选 2 项通过、整文件 16 项通过，评测器另行重跑所选 2 项也通过。没有把修复前的 worker 退出当作委派优化引入的新缺陷。

本轮功能评测首次总判定为失败，唯一失败项是修改范围：`npm run build` 重建了 `src/sandbox/windows/build/` 中 20 个原生构建文件。该目录已在仓库 `.gitignore` 中，`scripts/build-windows-pipes.mjs` 明确在此运行 node-gyp。排除这个既有生成目录后，源码变更仅为允许的 4 个生产／文档文件和新增测试；`src/application/index.ts` 经专门检查仅追加已声明类型导出。11 项行为、67 项独立回归、类型和 lint 在首次评测即已通过。保留原始失败报告，并单独保存范围复核为通过，没有重跑模型、改动实现或重新抽样。

本轮在执行前已修正编号解析和标准测试缓存排除，保留完整 Windows adapter，未重现上一轮缺少原生适配器的环境失败。

## 确定性检查与关键原始输出

```text
npm run check
> tsc --noEmit -p tsconfig.json && eslint src tests scripts
exit 0

npm run build
gyp info ok
exit 0

委派相关 Vitest（10 文件）
Test Files  10 passed (10)
Tests       114 passed (114)

指标与评测运行器 node:test
tests 27
pass 27
fail 0

分页副本独立复验
Test Files  1 passed (1)
Tests       2 passed | 14 skipped (16)

功能副本独立复验
Test Files  5 passed (5)
Tests       67 passed (67)
Independent build / typecheck / lint: code 0
Independent behavior checks: 11 / 11

补充终态对账容量检查
passed: false
```

相关 Vitest 命令：`npx vitest run tests/agent-followup.test.ts tests/autonomous-delegation.test.ts tests/agent-control-regression.test.ts tests/spawn-configuration.test.ts tests/collaboration.test.ts tests/explore.test.ts tests/agent-context.test.ts tests/agent-card-runtime.test.ts tests/cli-optimization-config.test.ts tests/coordinator-completion.test.ts`。

指标检查命令：`node --test scripts/comparison/agent-roster-v1.test.mjs scripts/comparison/v3-eval.test.mjs`。补充容量脚本的退出码不作为通过依据，采用其明确保存的 `passed:false` 和准入错误。

全批为 237 次有计量模型调用、6,286,542 token，未知用量为 0，包含基线、默认任务、正负控制、主／子运行及摘要；没有查询货币账单。真实模型实验结束时全部运行已结束。合成边界检查不调用模型，其状态数据单独存放。

本轮不是全仓测试，也没有实测其他模型或 macOS/Linux。实验期间实时工作区还有 CLI、tools、TUI 的后续修改；冻结结论不覆盖这些后续修改。核对的委派、生命周期、恢复和应用相关 10 个文件仍与冻结版本一致。未将任何模型任务产物合入生产源码，也未修改生产代码修复上述缺陷。

## 可复核证据

- [完整汇总](E:/sh/Coding/agent-harness/.kodo/delegation-retest-20261028-r2/final-summary.json)
- [主矩阵注册与任务原文](E:/sh/Coding/agent-harness/.kodo/delegation-retest-20261028-r2/registration.json)
- [逐轮指标与人工发现](E:/sh/Coding/agent-harness/.kodo/delegation-retest-20261028-r2/summary.json)
- [主矩阵原始结果](E:/sh/Coding/agent-harness/.kodo/delegation-retest-20261028-r2/results.json)
- [实际请求、结束状态与源码漂移核对](E:/sh/Coding/agent-harness/.kodo/delegation-retest-20261028-r2/request-and-source-audit.json)
- [当前显式创建与续接控制](E:/sh/Coding/agent-harness/.kodo/delegation-retest-20261028-r2/explicit-toolchain-control/report.json)
- [用户禁止委派控制](E:/sh/Coding/agent-harness/.kodo/delegation-retest-20261028-r2/no-delegation-control/report.json)
- [终态对账容量检查脚本](E:/sh/Coding/agent-harness/.kodo/delegation-retest-20261028-r2/settled-capacity-check.mjs)
- [公开宿主入口的容量检查结果](E:/sh/Coding/agent-harness/.kodo/delegation-retest-20261028-r2/synthetic-settled-capacity-host/report.json)
- [功能任务原始评测，保留范围项失败](E:/sh/Coding/agent-harness/.kodo/delegation-feature-retest-20261028-r2/report.json)
- [生成文件范围计分复核](E:/sh/Coding/agent-harness/.kodo/delegation-feature-retest-20261028-r2/scope-revalidation.json)
