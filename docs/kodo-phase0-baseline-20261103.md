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

## 4. 基线结果（待填）

### 4.1 总体

| 指标 | 值 |
|---|---|
| 运行格数 / 完成格数 | 待填 |
| 合格率（总体） | 待填 |
| 合格率（文献/数据/报告/编码） | 待填 |
| 平均总 token（未污染格） | 待填 |
| 平均输入 / 输出 token | 待填 |
| 平均墙钟耗时 | 待填 |
| 缓存读取占比（cacheRead / input） | 待填 |
| 子运行重复读取率（分母） | 待填 |
| 污染格 / 未对账格 | 待填 |
| provider 失败 | 待填 |

### 4.2 逐样例

| 样例 | 通过次数/3 | 平均 token | 平均耗时 | 缓存读取占比 | 主要失败原因 |
|---|---|---|---|---|---|
| lit-01 | | | | | |
| lit-02 | | | | | |
| lit-03 | | | | | |
| lit-04 | | | | | |
| data-01 | | | | | |
| data-02 | | | | | |
| data-03 | | | | | |
| report-01 | | | | | |
| report-02 | | | | | |
| coding-01 | | | | | |

### 4.3 翻转与异常

（阶段 1 每批重跑后，在这里对照基线记录翻转样例：同一格从通过变失败或反之。）

## 5. 结论与进入阶段 1 的判断

待基线数据填完后填写。若门槛满足，按 [减法方案](kodo-subtraction-plan-20261103.md) §4 开始批次 1a；否则先修评测或样例，不开始删除。
