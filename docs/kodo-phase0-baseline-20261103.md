# Kodo 阶段 0 基线与黄金评测记录

日期：2026-11-03。状态：进行中（评测基建与样例编写中，基线数据待本次运行后填写）。依据 [最终产品定位与执行方案](kodo-final-positioning-20261103.md) §5 阶段 0 与 [黄金评测设计](kodo-golden-eval-design-20261103.md)。

## 1. 阶段目标与门槛

1. 提交当前状态作为基线：已完成 `2f95839`（工作树冻结）与 `197fdaf`（评测契约与编码样例）。
2. 建 10 个黄金样例：文献 4（lit-01..04）、数据 3（data-01..03）、报告 2（report-01..02）、编码 1（coding-01-statemachine）。
3. 每个样例写评分标准：机械检查 + 人工判断项，不能违反的规则单独列出。
4. 用当前默认配置每个样例跑 3 次，记录合格率、费用、耗时、缓存读取占比、重复读取率。
5. 评测基础设施：逐请求记录响应模型与计费字段，线路变化标污染；第一格冒烟失败自动中止。

**进入阶段 1 的门槛**：基线数据完整，评分标准经人工复核。

## 2. 基线运行配置（冻结）

| 项 | 值 |
|---|---|
| 模型 | `deepseek-v4.1-flash`（codego1，chat-completions） |
| 模型能力上限 | context 1,048,576 / output 393,216 tokens（与既往 v3 评测注册一致） |
| Kodo 配置 | `new Application(state, new ModelProvider(), undefined, {})`，即默认 `toolProfile=compact-v2`、默认卡、默认压缩策略，无实验开关 |
| 每样例运行次数 | 3 |
| 样例数 | 10（文献 4 / 数据 3 / 报告 2 / 编码 1） |
| 并发 | 4（不同样例/重复互不影响，各自独立 state 与 relay） |
| 单次预算 | 见各 case.json：文本类 maxModelCalls 100 / maxTokens 3M / maxDurationMs 45min；编码类 120 / 8M / 60min |
| 凭据 | `test_api.json` 的 codego1 provider（不进入 Kodo 进程，只进入 loopback relay） |
| 成本口径 | token 计费（输入/输出/缓存读/缓存写分别记录）；价格换算仅在同一口径下比较 |
| 运行命令 | `node scripts/golden/run.mjs --run --cases <smoke 在前、编码最后> --repeat 3 --concurrency 3 --provider-config test_api.json --provider codego1 --model deepseek-v4.1-flash`（详见 scripts/golden/README.md） |
| 产物 | `.kodo/golden/<stamp>/`（registration.json、progress.json、runs/**/report.json、summary.json） |

冒烟顺序：先跑 1 个样例 1 次（data-01，成本最低），检查逐请求模型、usage、污染与评分链路，再跑完整矩阵。矩阵首格即冒烟门禁，因此 `--cases` 顺序把 data-01 放在最前、coding-01 放在最后。

### 2.1 复核发现与第一次基线中止

- 真实付费冒烟（data-01 × 1）已通过：11 次模型调用、161,919 tokens、68.5s、缓存读取占比 83.8%、无污染、评分 1.0。
- 第一次 30 格基线在跑完 data-01:r1 后被**主动中止**：独立复核 [docs/kodo-rubric-review-20261103.md](kodo-rubric-review-20261103.md) 用 28 组变异实验证明当时评分标准存在 P0 安全网缺口（passThreshold 0.9 太松、7/9 样例缺 materials 保护、report-01 材料时间线矛盾），基线数据不能用于阶段 1 对比。中止产物保留在 `.kodo/golden/baseline-aborted-20261103/`（不计入结论）。
- 修正：文本样例阈值统一 0.95、全部补 `protected-unchanged: ["materials"]`、report-01 材料时间线由作者修正；修完重跑全部自检与真实引擎回归后再启动正式基线。

## 3. 样例与评分标准复核清单

复核标记：`[ ]` 待复核、`[x]` 通过。复核人：Lead + 独立复核（[评分标准复核](kodo-rubric-review-20261103.md) 与 [修复回归](kodo-rubric-review-addendum-20261103.md)）。

| 样例 | 类别 | 材料 | 机械检查 | 人工项 | 不可违反规则 | 复核 |
|---|---|---|---|---|---|---|
| lit-01-comparison-table | 文献 | 5 篇文本化论文 | 表格结构/行数/精确指标/引用真实/无外部链接 | 综合结论质量 | 引用真实、不编造、不改 materials | [x] |
| lit-02-review-draft | 文献 | 6 篇论文 | 字数/引用数/研究空白小节/引用真实 | 综述结构与论证 | 引用真实、无外部链接、不改 materials | [x] |
| lit-03-data-extraction | 文献 | 3 篇带结果表论文 | CSV 列名/行数/精确数值 | 抽取口径一致性 | 数值真实、不改 materials | [x] |
| lit-04-advisor-revision | 文献 | 草稿+导师意见 | 5 条意见逐条落实 | 修改是否保留原意 | 不改 materials 原件 | [x] |
| data-01-stats-chart | 数据 | 销售 CSV 240 行 | 统计值精确核对/CSV 结构/图存在/图表 PNG 结构 | 结论是否基于数据 | 不篡改输入、数字自洽 | [x] |
| data-02-clean-merge | 数据 | 三表 | 清洗后行数/join 缺失数/列结构/标签-计数绑定 | 数据质量说明 | 清洗规则与 objective 一致、不改 materials | [x] |
| data-03-periodic-report | 数据 | 90 天流水 | 月度合计/环比/表格标签-数值绑定 | 报告可读性 | 数字自洽、不改 materials | [x] |
| report-01-multi-source-summary | 报告 | 4 份材料 | 必需小节/引用真实/关键数字/引文逐字/首末周配对 | 结论与证据对应 | 引用真实、不虚构来源、不改 materials | [x] |
| report-02-meeting-minutes | 报告 | 会议记录+参会名单 | 待办负责人/日期配对/决定条数/不虚构参会人 | 纪要完整性 | 不虚构、不改 materials | [x] |
| coding-01-statemachine | 编码 | python-statemachine 快照 | 旧测试回归（115 条）+ 11 条规格验收 | 最终答复证据如实性 | 不改测试、旧行为不翻转 | [x] |

编码样例自检已完成：未实现新特性时旧测试 115/115 通过、held-out 验收 11 条全部失败（预期）。

### 3.1 复核结论与修复

- 独立复核用真实评分引擎跑了 28 组变异，发现初版评分标准有 P0 安全网缺口：阈值 0.9 允许单个核心检查失败仍合格；7/9 文本样例没有 materials 保护；report-01 材料时间线矛盾。第一次基线因此中止。
- 修复：文本样例阈值统一 0.95；全部补 `protected-unchanged: ["materials"]`；data/report 重标定权重并新增 held-out command 与人工兜底项；report-01 时间线修复；lit-03 行数固定 36。
- 回归证据：`docs/kodo-rubric-review-addendum-20261103.md` 确认 lit 4 例 P0 全部关闭；`eval/golden/cases/data-01-stats-chart/verify/negative-controls.mjs` 的 15 个变异全部不合格；10/10 样例 `loadCase` 与自检通过，`npm run test:golden` 49/49。
- 已知限制（不阻塞基线，记录待后续批次）：citation 规则对“强调引号”偏严；data-01/02 的人工项权重不足以独立否决；部分 command 校验是启发式；5 份自检脚本为复制件。

## 4. 基线结果

产物：`.kodo/golden/baseline-20261103/`（`summary.json`、`runs/<case>/r<N>/report.json`、逐请求 `wire/`、人工判定 `human.json`）。
30 格全部跑完（`matrixState=complete`），人工项已全部判定（`humanPendingRuns=0`），判定证据见
[人工评分记录](kodo-human-grading-20261103.md)。编码样例 3 格被 relay 预算/传输错误截断，不是质量结论，处理方式见 §4.6。

### 4.1 总体

| 指标 | 值 |
|---|---|
| 运行格数 / 完成格数 | 30 / 30 |
| 合格次数 / 合格率（含人工项） | 22 / 73.3% |
| 人工项待评格数 | 0 |
| 污染格 / 未对账格 | 0 / 19 次调用的 usage 缺失（编码样例） |
| 平均总 token（未污染格，n=23） | 212,828 |
| 平均输入 / 输出 token | 203,604 / 9,224 |
| 平均缓存读取（cacheRead）/ 未缓存输入 | 172,561 / 31,043 |
| 缓存读取占比（cacheRead / inputTokens） | 82.8% |
| 平均墙钟耗时 | 88.0 s |
| 平均模型调用数 | 10.3 |
| 主运行重复读取率 | 5.4% |
| 子运行重复读取率 | 仅 1 格产生子运行（编码样例），无统计意义 |
| provider 失败（账本 `model.failed`） | 22（集中在上限截断的编码样例） |

### 4.2 逐样例

| 样例 | 类别 | 通过/3 | 合格率 | 平均 token | 平均耗时 | 缓存读取占比 | 失败检查 |
|---|---|---|---|---|---|---|---|
| data-01-stats-chart | 数据 | 2 | 66.7% | 151,444 | 74 s | 82.3% | C01×1（report.md 只有 182 汉字，要求 200–300±10%） |
| data-02-clean-merge | 数据 | 3 | 100% | 200,438 | 104 s | 84.3% | — |
| data-03-periodic-report | 数据 | 2 | 66.7% | 97,983 | 44 s | 80.5% | H01×1（r1 把材料日期范围写成 07-01–09-30） |
| lit-01-comparison-table | 文献 | 3 | 100% | 335,082 | 110 s | 85.7% | — |
| lit-02-review-draft | 文献 | 0 | 0% | 437,899 | 134 s | 88.4% | M4/M5/M6/M7（缺引用与超字数），r2 传输失败无产物 |
| lit-03-data-extraction | 文献 | 3 | 100% | 157,574 | 65 s | 82.0% | — |
| lit-04-advisor-revision | 文献 | 3 | 100% | 228,727 | 106 s | 82.3% | — |
| report-01-multi-source-summary | 报告 | 3 | 100% | 249,289 | 120 s | 83.6% | — |
| report-02-meeting-minutes | 报告 | 3 | 100% | 98,459 | 44 s | 77.7% | — |
| coding-01-statemachine | 编码 | 0 | 0% | — | — | — | 见 §4.6（预算/传输截断，非质量结论） |

类别汇总：数据 7/9（77.8%）、文献 9/12（75.0%）、报告 6/6（100%）、编码 0/3（0%，截断）。

**文本样例（9 例 × 3 次）基线：22/27 = 81.5%**。这是阶段 1 每批重跑的对照口径。

### 4.3 模型调用与读取行为（逐样例均值）

| 样例 | modelCalls | 主读取次数 | 主重复读取率 | 子读取次数 | 子重复读取率 | 子读主已读 |
|---|---|---|---|---|---|---|
| data-01-stats-chart | 12.0 | 1.0 | 0% | 0 | — | — |
| data-02-clean-merge | 11.3 | 0.3 | 0% | 0 | — | — |
| data-03-periodic-report | 8.3 | 0.7 | 0% | 0 | — | — |
| lit-01-comparison-table | 12.3 | 6.7 | 13.1% | 0 | — | — |
| lit-02-review-draft | 12.3 | 7.0 | 4.2% | 0 | — | — |
| lit-03-data-extraction | 8.0 | 3.0 | 0% | 0 | — | — |
| lit-04-advisor-revision | 11.0 | 5.3 | 5.6% | 0 | — | — |
| report-01-multi-source-summary | 11.3 | 5.3 | 11.1% | 0 | — | — |
| report-02-meeting-minutes | 7.3 | 3.0 | 0% | 0 | — | — |
| coding-01-statemachine（截断） | 77.3 | 31.7 | 38.7% | 5.7 | 41.2% | 0% |

### 4.4 未通过的运行

| 样例:重复 | 状态 | 分数 | 失败检查 | 违规 | 错误 |
|---|---|---|---|---|---|
| data-01:r2 | completed | 0.9579 | C01（report.md 只有 182 个汉字，要求 200–300±10%） | — | — |
| data-03:r1 | completed | 0.9048 | H01（材料日期范围写错：07-01–09-30，实际止于 09-28） | — | — |
| lit-02:r1 | completed | 0.5000 | M4 M5 M6 M7（缺 LongQA-Aca/OutlineWrite/90.8；正文 1,232 汉字超出 800–1,200） | — | — |
| lit-02:r2 | failed | 0.0000 | M1–M7、H1 H2 | R1 R2 | MODEL_TRANSPORT |
| lit-02:r3 | completed | 0.8333 | M7（正文 1,411 汉字超出上限） | — | — |
| coding-01:r1–r3 | failed | 0.06–0.22 | C1–C11、H1 | R2（pytest 字节码） | RELAY TOKEN_BUDGET / MODEL_TRANSPORT |

### 4.5 复核后修正的两处评分假阴性（已修复引擎，基线已 `--rescore`）

- `lit-01:r2` 原本因 `M2 markdown-table` 失败得 0.8182：模型写了合法 GFM 表格 `论文 | 方法 | …`（无首尾竖线），引擎只接受带首尾竖线的行。修复后该格通过。
- `report-01:r3` 原本触发 `R01 citation-sources` 违规：引用写成 `materials/interview-01.md（客服运营负责人王琳访谈）`，引擎把全角括号当成路径的一部分。修复后该违规消失。

两处都属于评测器缺陷而非模型错误，修正后基线数字如上；修复提交 `55ed7a8`。

### 4.6 编码样例（`coding-01-statemachine`）基线状态：**未建立**

该样例无法在现有 provider 上稳定跑完，三次尝试的证据：

| 尝试 | 预算 | 结果 |
|---|---|---|
| 第一次矩阵 r1 | 120 calls / 8M tokens | 在 87 次请求、7.28M tokens 处被 relay `TOKEN_BUDGET` 拒绝（MODEL_RATE_LIMIT） |
| 第一次矩阵 r2 | 同上 | 在 103 次请求、7.62M tokens 处被 `TOKEN_BUDGET` 拒绝，客户端中止 |
| 第一次矩阵 r3 | 同上 | 36 次请求、1.5M tokens 处 `MODEL_TRANSPORT` |
| 重跑 r1（预算上调后） | 250 calls / 24M tokens | 52 次请求、6.29M tokens 处上游传输中断（`UPSTREAM_TRANSPORT`） |

也就是说，该 provider 对这条 120+ 步的编码轨迹在 6–8M tokens 处会稳定断流/拒绝，加上 relay 预算上限，编码样例在当前环境下无法产出「3 次有效运行」。已确认不是 harness 侧错误：`wire/` 里每次请求都有响应，`relay.json` 记录的是上游断流与预算拒绝。

处理决定（记录在案）：

1. **阶段 1 的基线对比以 9 个文本样例的 27 格为准**（当前合格 22/27 = 81.5%），编码样例的删减影响用 `npm run check` + 全量单测 + 编码样例的 rubric 静态检查（`loadCase` 通过、旧测试与 held-out 验收脚本可运行）来守。
2. 编码样例保留在矩阵里但标记为 `inconclusive`；`scripts/golden/compare.mjs` 会因该格失败而给出 inconclusive，此时看 9 个文本样例的逐例结论。
3. 已修的两个评测器问题保留：`protected-unchanged` 的 `ignore` glob（否则 pytest 字节码会被误判为篡改测试），以及编码预算上调（避免 relay 在运行中途拒绝）。这两项都不影响文本样例基线。
4. 待 provider 稳定或换用可长跑的通道后，补跑编码样例的 3 格基线；届时以同一 rubric 重跑，不与本文的文本基线混算。

### 4.7 翻转与异常

（阶段 1 每批重跑后，在这里对照基线记录翻转样例：同一格从通过变失败或反之。）


## 5. 结论与进入阶段 1 的判断

- 文本样例基线可用：27 格中 22 格合格（81.5%），人工项已补齐，污染 0 格，成本/缓存/读取指标齐全（§4.1、§4.3）。
- 评分标准经独立复核（`docs/kodo-rubric-review-20261103.md`）与变异回归（`addendum`），复核发现的 P0 已全部关闭；基线过程中又修复了 3 个评测器缺陷（舍入边界、GFM 表格、引用路径终止符）与 1 个运行器缺陷（受保护路径的字节码忽略）。
- 编码样例基线未建立（§4.6），不作为阶段 1 的门槛依据；它仍参与每批检查（至少要求 `loadCase` 通过、旧测试与 held-out 脚本可执行）。
- **结论：满足进入阶段 1 的条件**。按 [减法方案](kodo-subtraction-plan-20261103.md) §4 从批次 1a 开始；每批删除后跑 9 个文本样例，用 `scripts/golden/compare.mjs` 对照本基线，门槛为「逐样例合格次数不下降 + 无新增规则违规 + 平均费用/耗时退化 ≤10%」。

