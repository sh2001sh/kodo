# Kodo P1–P4 方法上下文对比实验（2026-11-03）

P1–P4 已实现，默认关闭。全部 10 组运行已结束并取得独立验收结果。

已完成运行中，6/10 格通过全部独立验收。阶段机制组自主采用为 0/6；所有按需加载组（含普通 Skill）为 0/8。常驻组不参与自主加载率计算。

**发现入口审计修订：上述 0/6 不能触发停止条件。** 原首请求将 inline 方法放在 `Available session agents (frozen)` 名册内，没有展示执行模式、加载句柄或加载到主 Agent 的说明；所有组的 `skill.list` 与 `skill.load` 调用均为零。这是存在发现环节混杂的观察，不能解释为“模型不需要方法”或“模型不会自主加载”。后续诊断见 [方法发现诊断](kodo-method-discovery-20261103.md)。

正式矩阵共 1,334 次 API 请求，已知费用至少 188.25 credit，1 次请求缺失费用用量。更早停止的试跑另计至少 0.83 credit。

**实现完成尚未转化为已验证的机制收益。** 本轮已完成的阶段组没有方法加载、显式阶段或物理卸载事件；它们实际发送的工具定义摘要相同，运行中均没有工具定义切换。单次耗时、费用或分数差异不能归因于这些未触发的机制。结论限定于本次模型、两项工程任务和三张通用方法卡。建议保持默认关闭，后续首先验证具有明确增量价值的卡片能否被模型主动发现和使用。

实现与接口见 [使用说明](../inline-methods.md)。本实验复用历史模型和任务，使用当前同一冻结构建进行五组比较；不能与旧版本的单次成绩直接作因果比较。

## 条件与分组

- 模型：codego1 / deepseek-v4.1-flash。上下文 1,048,576 token，输出上限 393,216 token，每格原始时限 5,400 秒。
- 任务：python-statemachine-state-data-scoping、fastapi-deprecation-response-headers。复用历史基础提交、任务指令、容器与独立验收器。
- 每格独立容器、2 CPU、8 GiB；compact-v2、taskProtocol 3、因素 A–E。实验期间不修改构建、提示或模型决策。
- 冻结构建源摘要：`189e5673a60c1aea1225e1032820f551fe0b718f44fb38b71aa9c916352af36e`。完整冻结元数据保存在结果目录的 matrix.json。

| 组 | 配置 | 比较含义 |
|---|---|---|
| resident | 三个方法正文常驻，同时保留普通 Skill 目录 | 常驻基线 |
| skill | 仅普通 skill.load | 已有按需加载基线 |
| marking | P1–P4 开启，物理卸载关闭，稳定工具视图 | 与 skill 是整体机制比较 |
| checkpoint | marking 加检查点物理卸载 | 与 marking 比较卸载 |
| active | checkpoint 改为当前方法工具视图 | 与 checkpoint 比较工具可见性 |

所有组使用相同的三个通用方法正文：理解、实现、验证。任务没有要求必须加载方法或声明阶段；不强制缩小窗口来制造卸载。三张方法卡的工具声明相同，因此即使配置不同，也必须核对实际请求是否出现不同工具定义。

## 已记录结果

| 任务 / 组 | 状态 | 新要求 / 旧行为验收 | 秒 | API 请求 | Credit | 方法选择覆盖 | 卸载次数 |
|---|---|---|---:|---:|---:|---|---:|
| statemachine-resident | completed | 72/72 / 1286/1286 | 1934.175 | 211 | ≥23.93 | 不适用 | 0 |
| statemachine-skill | completed | 72/72 / 1286/1286 | 1987.990 | 209 | 21.61 | 0/3 | 0 |
| statemachine-marking | completed | 70/72 / 1286/1286 | 2295.961 | 230 | 24.03 | 0/3 | 0 |
| statemachine-checkpoint | completed | 72/72 / 1286/1286 | 1958.775 | 149 | 20.17 | 0/3 | 0 |
| statemachine-active | completed | 70/72 / 1286/1286 | 2401.502 | 183 | 31.59 | 0/3 | 0 |
| fastapi-skill | completed | 134/137 / 3134/3134 | 3920.217 | 130 | 43.97 | 0/3 | 0 |
| fastapi-marking | completed | 137/137 / 3134/3134 | 575.485 | 48 | 4.65 | 0/3 | 0 |
| fastapi-checkpoint | completed | 137/137 / 3134/3134 | 613.502 | 49 | 5.67 | 0/3 | 0 |
| fastapi-active | completed | 134/137 / 3134/3134 | 779.342 | 64 | 6.52 | 0/3 | 0 |
| fastapi-resident | completed | 137/137 / 3134/3134 | 697.297 | 61 | 6.11 | 不适用 | 0 |

方法选择覆盖是成功选择的不同方法数 / 预设三个方法，属于选择行为，不能证明因果使用或任务质量。运行级自主采用另记为是否至少选择过一个方法。费用缺失不补零，≥ 表示已知小计。

| 任务 / 组 | 已知请求缓存读取比例 | 用量缺失请求 | 显式阶段数 | 主请求工具数 / 定义种数 / 切换数 | 子任务状态 |
|---|---:|---:|---:|---|---|
| statemachine-resident | 97.15% | 1 | 0 | 22 / 1 / 0 | cancelled, cancelled, completed, completed |
| statemachine-skill | 97.52% | 0 | 0 | 22 / 1 / 0 | completed, completed |
| statemachine-marking | 97.35% | 0 | 0 | 28 / 1 / 0 | completed, cancelled, completed, completed |
| statemachine-checkpoint | 98.39% | 0 | 0 | 28 / 1 / 0 | 无 |
| statemachine-active | 95.82% | 0 | 0 | 28 / 1 / 0 | 无 |
| fastapi-skill | 98.68% | 0 | 0 | 22 / 1 / 0 | 无 |
| fastapi-marking | 95.62% | 0 | 0 | 28 / 1 / 0 | 无 |
| fastapi-checkpoint | 96.08% | 0 | 0 | 28 / 1 / 0 | 无 |
| fastapi-active | 96.79% | 0 | 0 | 28 / 1 / 0 | 无 |
| fastapi-resident | 96.81% | 0 | 0 | 22 / 1 / 0 | 无 |

completed 仅表示模型运行正常结束，独立验收是否通过以新要求和旧行为的测试结果为准。失败用例如下：

- statemachine-marking: `[f2p] tests.test_state_data.TestDataChangeTracking.test_changes_cleared_between_macrosteps[async]`。
- statemachine-marking: `[f2p] tests.test_state_data.TestDataChangeTracking.test_changes_cleared_between_macrosteps[sync]`。
- statemachine-active: `[f2p] tests.test_state_data.TestDataChangeTracking.test_changes_cleared_between_macrosteps[async]`。
- statemachine-active: `[f2p] tests.test_state_data.TestDataChangeTracking.test_changes_cleared_between_macrosteps[sync]`。
- fastapi-skill: `[f2p] tests.test_deprecation_sunset_headers.test_middleware_multiple_routes_separate_counts`。
- fastapi-skill: `[f2p] tests.test_deprecation_sunset_headers.test_middleware_non_deprecated_not_tracked`。
- fastapi-skill: `[f2p] tests.test_deprecation_sunset_headers.test_middleware_tracks_deprecated_hits`。
- fastapi-active: `[f2p] tests.test_deprecation_sunset_headers.test_middleware_multiple_routes_separate_counts`。
- fastapi-active: `[f2p] tests.test_deprecation_sunset_headers.test_middleware_non_deprecated_not_tracked`。
- fastapi-active: `[f2p] tests.test_deprecation_sunset_headers.test_middleware_tracks_deprecated_hits`。

缓存比例按同时存在输入与缓存字段的请求计算；缺失请求存在时，不代表完整会话缓存率。API 请求包括子任务及取消请求，原生调用数与网关请求数可能不同。

## 记录中断及修复

原始批次 `.kodo/method-p1-p4-ablation-20261103` 在第一格结束后停止：Windows 提取子任务目录的 CLAUDE.md 符号链接时缺少权限。功能验收、主仓库补丁、Git、原生数据库与调用记录仍保留，但子任务目录归档不完整。原容器及验证快照已由旧脚本清理，不能声称补回完整归档。

修复仅改变运行结束后的证据收集：保存原始 tar 流并校验目录列表，记录大小和 SHA-256；若以后归档失败，保留停止的容器。三个回归测试通过，真实容器验证确认符号链接和 Git 内容可保存在归档中。

续跑批次 `.kodo/method-p1-p4-continuation-20261103` 只运行原矩阵未开始的九格。第一格沿用原始成绩并保留归档缺口，没有因分数重跑；Kodo 构建、模型、方法正文、指令和组序不变。两个批次的脚本摘要与修订原因均保留。

更早的 `.kodo/method-context-ablation-20261103` 是范围明确为 P1–P4 前停止的 P1/P2 未完成试跑，已标为 invalid_partial，不进入比较。它另有 12 次请求，已知费用至少 0.83 credit，1 次请求缺失用量；这部分成本保留，不计入上表各格。

## 解释边界

- 首请求消息中 `inline` 出现零次。statemachine-marking 两次、checkpoint 一次尝试将 `engineering/implement` 交给 `spawn_agent`，均因仅支持 inline 被拒绝。成功创建的子运行使用通用卡或 implementer，不能声称三张方法卡已经成功以子 Agent 形式执行；错误提示虽告知可用 `skill.load`，模型没有继续加载。证据支持初始展示有误导性，但不能据此证明展示是唯一原因。
- 方法正文为通用的理解、实现、验证建议，未设置可独立验收的仓库专属规则；原十格也没有验证互相冲突的方法规则。发现、增量价值和阶段收益需要分别验证。
- skill 与阶段机制还存在 task/knowledge 入口差异，不能将差异全部归因于阶段标记。
- 未发生自主加载，不能证明方法生命周期改善表现；未发生卸载，不能证明检查点卸载的效果。
- 如果实际工具定义未变化，不能从 active/checkpoint 两格成绩推导动态工具切换的缓存收益。
- 每格仅一次，组间随机差异及运行时段影响未排除；这不是统计显著性或产品竞争力证明。
- 本轮只复测两项软件工程任务，不覆盖通用非开发任务。会话热安装由宿主集成测试验证，没有在自主实验中强行注入。
- 第一格有子任务归档缺口，不能与其他格声称拥有相同完整度的过程证据。

FastAPI 的运行行为差异很大：普通 Skill 基线有 130 次 API 请求、389,022 个推理 token；marking 为 48 次、26,112 个，checkpoint 为 49 次、35,130 个。后两组主要通过 shell 完成操作。数据记录了明显的模型执行路径差异，但没有实际方法挂载，且每格仅一次，不能把这组差异宣传为阶段机制带来的加速或节费。

## 实现验证

冻结构建前已完成 npm run check 与 npm run build。18 个相关测试文件共 258 项通过；后续 CLI 检查 2 文件、34 项通过，部分覆盖重复，不相加为独立测试总数。实验脚本原有 6 项测试通过；归档修复另有 3 项回归测试及一次真实容器验证。

未声称全仓测试全部通过：此前全量运行的 tests/mcp-sandbox.test.ts 中，`kills a cancelled sandboxed server before reporting completion and awaits cleanup` 失败，预期 cancelled，实际为 MCP process termination could not be confirmed。本轮没有修改该既有问题，也未重跑全仓测试。

归档回归检查的关键原始输出：

```text
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

最终 audit.json 确认 comparableConfiguration=true、currentBuildMatchesTestedBuild=true，10 格使用一致模型及限额，同一任务五格指令摘要相同，两份冻结构建逐文件校验通过。唯一记录例外仍是 statemachine-resident 的子任务归档缺口。完整接口、卸载约束、热安装边界与验证范围以实现说明及实际测试为准。

原始矩阵、逐请求记录、独立验收输出和派生 analysis.json 均留在上述两个结果目录。
