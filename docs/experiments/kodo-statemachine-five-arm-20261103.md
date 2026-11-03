# python-statemachine 五组复测（2026-11-03）

矩阵状态：finished；已结束 5/5 组。每组一次，串行执行，没有运行 FastAPI。

请求模型统一为 codego1 / deepseek-v4.1-flash；响应模型标识例外见末尾审计。沿用历史任务 python-statemachine-state-data-scoping、原始任务指令、容器、基础提交及独立验收器；方法仍为理解、实现、验证三张通用卡，未注入发布演练的专属规则，也未要求模型加载方法。

使用修复发现入口后的同一冻结构建。compact-v2、taskProtocol 3、因素 A–E；每组 2 CPU / 8 GiB，上下文 1,048,576、输出上限 393,216 token，最长 5,400 秒。

构建源摘要：`0632484db0da69c309312766db48d90659d56e995e0d360b97602afc7d03fb5b`；dist 摘要：`9338838111f9a1a43db32958015b5187209c89fc0a79c6ed94d0ad2b759a4dd0`。

## 时间、额度与验收

运行时间从 Docker 启动到 Agent 退出，不含外部验收；单格总时间另含验收和归档。Credit 为网关逐请求 usage.credit 的合计，缺失不补零；返回零不等于已确认实际账单免费。Token 统计包括主 Agent 和子 Agent，输入为累计调用量，缓存读取是其中的子集。

| 组 | 状态 | 运行秒 / 分钟 | 单格总秒 | API 请求 | Credit 字段合计 | 新需求验收 | 原有行为验收 |
|---|---|---:|---:|---:|---:|---|---|
| 常驻方法 | completed | 3260.833 / 54.35 | 3311.158 | 236 | 0.00 | 72/72 | 1286/1286 |
| 普通 Skill | completed | 2066.043 / 34.43 | 2120.323 | 243 | ≥0.00 | 70/72 | 1286/1286 |
| 阶段标记 | completed | 1796.472 / 29.94 | 1839.611 | 164 | ≥13.22 | 72/72 | 1286/1286 |
| 检查点卸载 | completed | 4481.852 / 74.70 | 4539.210 | 181 | ≥21.07 | 67/72 | 1286/1286 |
| 动态工具 | failed | 1250.395 / 20.84 | 1293.587 | 142 | ≥0.00 | 72/72 | 1286/1286 |

| 组 | 输入 token | 缓存读取 token | 输出 token | 费用缺失请求 |
|---|---:|---:|---:|---:|
| 常驻方法 | 26,381,667 | 25,598,336 | 273,680 | 0 |
| 普通 Skill | ≥21,831,864 | ≥20,996,864 | ≥182,520 | 2 |
| 阶段标记 | ≥17,614,788 | ≥16,985,984 | ≥123,618 | 1 |
| 检查点卸载 | ≥16,123,889 | ≥15,509,760 | ≥136,734 | 7 |
| 动态工具 | ≥8,881,393 | ≥8,535,936 | ≥98,055 | 3 |

网关计费字段在本次串行运行中发生了明显变化：前两组所有已返回字段均为 0，阶段标记组运行中开始出现正数。未核对账户实际账单，无法解释这一变化；不得用这些 Credit 字段合计直接推断跨组节费收益。以下保留返回分布，缺失仍单列。

| 组 | 返回零额度的请求 | 返回正额度的请求 | 第一条正额度请求 |
|---|---:|---:|---|
| 常驻方法 | 236 | 0 | 无 |
| 普通 Skill | 241 | 0 | 无 |
| 阶段标记 | 111 | 52 | 113（2026-11-03T03:40:42.059Z） |
| 检查点卸载 | 15 | 159 | 1（2026-11-03T03:52:26.321Z） |
| 动态工具 | 139 | 0 | 无 |

## 实际机制采用

| 组 | skill.list 成功次数 | skill.load 成功次数 | 不同方法加载数 | 物理卸载 | 工具定义种数 / 切换数 |
|---|---:|---:|---|---:|---|
| 常驻方法 | 0 | 0 | 常驻，不计采用率 | 0 | 1 / 0 |
| 普通 Skill | 0 | 0 | 0/3 | 0 | 1 / 0 |
| 阶段标记 | 0 | 0 | 0/3 | 0 | 1 / 0 |
| 检查点卸载 | 0 | 0 | 0/3 | 0 | 1 / 0 |
| 动态工具 | 0 | 0 | 0/3 | 0 | 1 / 0 |

每格仅一次，不能证明统计显著性。普通 Skill 与 inline 组还存在方法展示及 task/knowledge 入口差异，属于整体机制比较。只有实际发生的加载、卸载、工具切换才能作为相应机制被测到的证据。三张通用方法工具声明相同，active 不一定产生工具定义变化。

## 失败与证据限制

- statemachine-skill: `[f2p] tests.test_state_data.TestDataChangeTracking.test_changes_cleared_between_macrosteps[async]`。
- statemachine-skill: `[f2p] tests.test_state_data.TestDataChangeTracking.test_changes_cleared_between_macrosteps[sync]`。
- statemachine-checkpoint: `[f2p] tests.test_state_data.TestDataChangeTracking.test_changes_cleared_between_macrosteps[async]`。
- statemachine-checkpoint: `[f2p] tests.test_state_data.TestDataChangeTracking.test_changes_cleared_between_macrosteps[sync]`。
- statemachine-checkpoint: `[f2p] tests.test_state_data.TestStateDataEdgeCases.test_transition_from_data_state_to_no_data_state[async]`。
- statemachine-checkpoint: `[f2p] tests.test_state_data.TestStateDataEdgeCases.test_transition_from_data_state_to_no_data_state[sync]`。
- statemachine-checkpoint: `[f2p] tests.test_state_data.TestStateDataValidation.test_state_without_data_backward_compat`。
- statemachine-checkpoint 有 9 次请求在有效内容前等待至少 120 秒，最大 179.871 秒；无有效内容便终止的请求按已观察等待时长记录。时间保留在端到端结果中，不能将供应商等待解释为阶段机制的净耗时。逐请求明细见 analysis.json。
- statemachine-active 主运行状态为 failed：`MODEL_TRANSPORT: provider request failed (HTTP 502)`。独立验收针对中断时留下的补丁，不能视为 Agent 正常完成交付，也不能把供应商错误归因为阶段机制。

## 最终结论与审计

五组各执行一次，总 Agent 运行时间 12855.595 秒（3.57 小时），API 请求 966 次；独立验收全部通过 3/5 组。网关 Credit 已知字段合计 34.29，另有 13 个请求缺失计费字段；该合计不是核实后的账户扣费。

所有五组均未调用 skill.load，四个非预加载组均未加载方法。本轮没有触发方法加载、阶段结束后的卸载或由方法切换导致的动态工具变化，因此不能用分数、耗时或额度差异证明这些新增机制有效或无效。当前方法仍是通用方法，本轮也不能推翻先前专属方法诊断中观察到的自主加载。

配置一致性审计：未通过；当前构建与冻结实验构建一致：True。逐格审计见 audit.json。
审计问题：['Model identity mismatch: statemachine-checkpoint']。

statemachine-checkpoint 第 145 次请求指定 `deepseek-v4.1-flash`，响应标识为 `deepseek-v4.1-flash-sg`；流协议状态为 `error`，usage 为 None。无法仅凭后缀确定实际后端模型是否不同；本报告保留严格审计失败，不把它当作已确认同模型的响应。

原始证据目录：`.kodo/statemachine-five-arm-20261103/`。matrix.json 保存配置和逐格结果；analysis.json 保存派生统计；各格保留 relay 请求与响应、原生数据库、独立验收输出及 Git 补丁。额外的隔离执行目录归档仅普通 Skill 和阶段标记组为 captured，其余三组记录为 absent；没有记录归档异常或 trace 错误。旧十格与三次小诊断均不计入本表。
