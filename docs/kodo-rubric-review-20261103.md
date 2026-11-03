# 黄金样例评分标准独立复核（9 个非编码样例）

日期：2026-11-03。复核者：phase1-mapper（独立复核，非样例作者）。状态：只读复核，未修改 `eval/golden/**`、`scripts/**`、`src/**`、`package.json`，未 git commit。
复核快照：2026-11-03 15:20–15:33（Asia/Shanghai）。样例作者当时仍在收尾（lit-01/02/03/04 的 `verify/README.md` 于 15:27:40 更新、report-02 参考解于 15:20:36 重存、`scripts/golden/` 的 runner 于 15:27 更新）；`case.json`/`rubric.json` 自 15:14–15:19 后未变，本文结论以本文 §10 附录的哈希为准。**若作者之后改动 rubric.json、case.json 或参考解，需要重新执行本文的复核脚本。**

范围：`data-01/02/03`、`lit-01/02/03/04`、`report-01/02`，共 9 例。编码样例 `coding-01-statemachine` 不在本任务范围。
复核依据：[黄金评测设计](kodo-golden-eval-design-20261103.md) §3/§3.1/§4/§4.1/§4.2/§8、[最终定位](kodo-final-positioning-20261103.md) §5 阶段 0/1 门槛。

---

## 0. 结论摘要

1. **文件完整性：9/9 齐全，无“未完成”样例。** 每例都有 `case.json`、`rubric.json`、`workspace/materials/*`、`verify/reference/deliverables/*`（data-01 另有 `chart.png`）；`verify/check-rubric.py`（data/report 5 例，同一份）或 `verify/check-rubric.mjs`（lit 4 例，同一份）都在。唯一的“收尾中”迹象是 README 在复核期间更新，不影响评分。
2. **Schema：9/9 通过。** JSON 可解析且无 BOM；`id` 与目录名一致；`category` 合法；`limits` 与契约默认值逐字段一致；`permissions=["read","write","exec"]`；`deliverableDir="deliverables"`；`materialsGlobs=["materials/**/*"]`；`smoke` 三字段齐；`objective` 均自包含且明确 `materials/`、`deliverables/`；rubric `passThreshold=0.9`、id 无重复、weight 为正、`rules` 无 human、`citation-sources.allowedRoots` 均存在、`protected-unchanged.paths` 均存在、`grading.stage` 源均存在。
3. **参考解与空输出：9/9 通过真实评分引擎。** 我用**真实引擎** `scripts/golden/score.mjs`（哈希前缀 `4E2893B74043DEA7`）+ `cases.mjs`（`5B90CBDADB3073B1`）按 runner 语义（保护路径比较 → grading restore/stage → command → evaluateRubric）复核：9 例参考解全部 `score=1.0, passed=true, violations=0`（human 为 pending，lit-01/02/04 的 held-out command 均 exit 0）；9 例空输出全部 `passed=false`。9 例自带自检脚本我也独立执行，全部 exit 0 / `SELF-CHECK OK`（未采信其 README 结论）。
4. **独立重算：数据与材料层面全部一致。** data-01 的 16 个区域指标与重算完全一致；data-02 的 A=8/B=12/C=25/275 及 15 个抽查单元格一致，**参考解 275 行 merged.csv 与独立重算逐行零差异**；data-03 的 3 个月合计、2 个环比、5 个类别合计与最大值一致；lit-03 参考解 **36/36** 行与三篇论文“表 2 主要结果”完全对应；lit-01/02/04 的标题/数值/数据集/引用均可逐字回溯到材料；report-01 的关键数值与访谈原话、report-02 的负责人/截止日期/参会人与材料一致。
5. **但当前 9 个里 0 个可以直接进入阶段 0 基线。** 全部 9 例都存在“错误解仍然合格”的评分安全网缺口（详见 §4、§6），已用真实引擎的变异实验证明：
   - data-01：两个区域指标写错仍 **0.90 合格**；chart.png 追加非图片文本仍 **1.0 合格**；
   - data-02：merged.csv 只有 274 行（差 1 行）仍 **0.9268 合格**；A/B/C 计数标签互换仍 **1.0 合格**；
   - data-03：月份 2026-07/2026-09 标签互换仍 **1.0 合格**；最大类别写错仍 **0.9333 合格**；
   - lit-01：综合结论删到 0 个汉字仍 **0.9091 合格**；
   - lit-02：少一个核心数据集名仍 **0.9000 合格**；
   - lit-03：一个抽样值写错仍 **0.9091 合格**；混入论文表 3 的消融行仍 **1.0 合格**；
   - report-01：首周/末周数值对调仍 **1.0 合格**；全文中文引号全部删除（0 处访谈引用）仍 **1.0 合格**；
   - report-02：两位负责人的截止日期互换仍 **1.0 合格**；把 3 条决定全部删掉仍 **1.0 合格**（“决定清单”标题里的“决定”二字满足 M07）；
   - **7/9 例没有 materials 保护规则**：data-01、data-03、lit-01、report-01、report-02 实测篡改 materials 后仍 **1.0 合格**；只有 lit-03/lit-04 有 `protected-unchanged`（篡改后正确判违规）。
6. **样例质量本身值得保留。** 参考解全部真实达标、材料自洽（除 report-01 的一处时间线矛盾，见 §4.3），问题集中在 rubric 的约束强度与语义绑定，而不是样例内容。修复 P0 后 9 例都可作为基线候选；P1 建议在基线前完成，否则基线合格率会被“错误解也能通过”抬高。

---

## 1. 逐样例结论表

| # | 样例 | 文件 | schema | 参考解(真实引擎) | 空输出 | 自带自检 | 独立重算/核对 | 结论 | 当前可否进基线 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | data-01-stats-chart | 完整 | OK | 1.0 / pass | fail | exit 0 | 16/16 指标一致 | 需修（P0×2、P1×2、P2×3） | **否** |
| 2 | data-02-clean-merge | 完整 | OK | 1.0 / pass | fail | exit 0 | 275/275 行零差异 | 需修（P0×2、P1×2、P2×2） | **否** |
| 3 | data-03-periodic-report | 完整 | OK | 1.0 / pass | fail | exit 0 | 月/环比/类别一致 | 需修（P0×2、P1×2、P2×2） | **否** |
| 4 | lit-01-comparison-table | 完整 | OK | 1.0 / pass | fail | exit 0 | 数值/标题/引用可回溯 | 需修（P0×2、P1×1、P2×3） | **否** |
| 5 | lit-02-review-draft | 完整 | OK | 1.0 / pass | fail | exit 0 | 800–1200 字/6 引用达标 | 需修（P0×2、P1×1、P2×2） | **否** |
| 6 | lit-03-data-extraction | 完整 | OK | 1.0 / pass | fail | exit 0 | 36/36 单元格一致 | 需修（P0×2、P1×2、P2×2） | **否** |
| 7 | lit-04-advisor-revision | 完整 | OK | 1.0 / pass | fail | exit 0 | 5 条意见/引用均可核 | 需修（P0×2、P1×1、P2×2） | **否** |
| 8 | report-01-multi-source-summary | 完整 | OK | 1.0 / pass | fail | exit 0 | 数值/访谈原话一致；材料时间线矛盾 | 需修（P0×3、P1×2、P2×2） | **否** |
| 9 | report-02-meeting-minutes | 完整 | OK | 1.0 / pass | fail | exit 0 | 5 待办/6 参会人一致 | 需修（P0×2、P1×2、P2×2） | **否** |

**“未完成”标注：无。** 复核时 9 例均具备设计文档 §2 要求的全部文件；作者仍在更新的是 `verify/README.md`（不参与评分）与 `scripts/golden/`（评分基础设施，非样例内容）。

---

## 2. 复核方法（不复用作者结论）

1. **Schema 独立校验**：自写 Python 检查器逐字段核对设计文档 §3/§4（结果见 §0-2、§8），并用官方 `scripts/golden/cases.mjs::loadCases` 实际加载 9 例，无异常。
2. **独立重算**：`pandas 3.0.1` 从 `workspace/materials/` 重新实现清洗/统计/抽取（不复用 `verify/gen-data.py` 或参考解代码）：data-01 分组统计；data-02 空 order_id→去重→日期归一→外键剔除→join→金额；data-03 月度/环比/类别；lit-03 解析三篇论文 markdown 表格。逐项与 `rubric.json` 的期望值对比，差异数为 0（详见 §8）。
3. **真实引擎复核**：用临时 harness 导入仓库的 `scripts/golden/cases.mjs` 与 `scripts/golden/score.mjs`，镜像 `run.mjs` 的评分流水线（保护路径比较在 grading 之前、restore→stage、command 在评分前执行、node 缺失时回退 `process.execPath`），对 9 例分别跑：参考解、空输出、以及 28 组变异（§6）。所有写操作只在系统临时目录，未改仓库。
4. **自带自检脚本**：在各自 case 目录执行 `python verify/check-rubric.py` 或 `node verify/check-rubric.mjs`，9 例全部 exit 0（§7 列出覆盖范围与缺口）。
5. **材料一致性**：对文献/报告逐项定位 rubric 抽查值、标题、样本量、数据集、负责人、日期、参会人、引号片段在材料中的出现位置（文件:行）；跨文件核对 report 类材料。

---

## 3. 逐样例复核详情

### 3.1 data-01-stats-chart（区域销售统计、图表与结论）

- 文件：`case.json`、`rubric.json`、`workspace/materials/sales.csv`（240 行）、`verify/{gen-data.py,check-rubric.py,expected-data-01.json,README.md,reference/deliverables/{summary.csv,chart.png,report.md}}`。
- Schema：OK；`limits` 与默认一致；objective 明确 materials/deliverables；rubric 22 项 check（无 human、无 rules）。
- 参考解：真实引擎 1.0/pass；空输出 0.0/fail；自检 exit 0。
- 独立重算（与 rubric 的 16 个 csv-cell 全部一致）：
  | region | total_sales | mean_sales | median_sales | order_count |
  |---|---|---|---|---|
  | 华东 | 85528.13 | 1474.62 | 1496.62 | 58 |
  | 华北 | 53777.43 | 995.88 | 1061.17 | 54 |
  | 华南 | 42520.76 | 733.12 | 765.51 | 58 |
  | 西部 | 29994.35 | 535.61 | 538.53 | 56 |
  - 原始 240 行，无效 14 行（12 空 + 2 `N/A`），有效 226 行，总销售额 211820.67，华东为最高区域（领先第二名 31750.70）。
- 问题：
  - **P0-1（权重）**：单个 `csv-cell` 权重 2（`rubric.json:8-23`），W=40、阈值 0.9，允许失败权重 4.0；实测把华东 total 改成 85528.99 仍 **0.95 合格**，再改华北 total 仍 **0.90 合格**（§6 表）。核心数据错误不能触发不合格。
  - **P0-2（材料保护）**：`rules: []`（`rubric.json:28`），objective 第 3 段要求“不要修改 materials/ 下的任何文件”（`case.json:6`）；实测向 `materials/sales.csv` 追加内容后仍 **1.0 合格**。
  - **P1-1（图表内容）**：`M20` 只查 `file-exists` + `minBytes:5000`（`rubric.json:24`），objective 第 4 条要求“用 matplotlib 生成按区域销售总额的柱状图或折线图”（`case.json:6`）；实测向 `chart.png` 追加非图片文本仍 **1.0 合格**（参考解 PNG 合法，20,483 B）。
  - **P1-2（报告长度）**：objective 要求 200–300 字，rubric 只有 `minBytes:400`（`rubric.json:25`）与包含“华东”（`:26`）；参考解 260 汉字（合规），但 1000 字或 150 字都可过。
- 人工项：无（见 §7）。

### 3.2 data-02-clean-merge（订单清洗与多表合并）

- 文件齐全；schema OK；rubric 22 项 check（无 human、无 rules）。
- 参考解：1.0/pass；空输出 fail；自检 exit 0。
- 独立重算：原始 320 行；A（空 order_id）=8；B（重复移除）=12（12 个重复 order_id，`updated_at` 无并列最大值，去重唯一确定）；C（无效外键）=25 = customer 14 + product 11（**互不重叠**，14+11=25）；最终 275 行；四种日期格式 79/80/78/83，全部可解析（0 行解析失败）。15 个抽查单元格（O0001/O0002/O0003/O0008/O0006 的日期/客户名/金额）与重算一致；**参考解 275 行 merged.csv 与独立重算逐行、逐列零差异**（§8）。
- 问题：
  - **P0-1（权重）**：`M03` 行数权重 3（`rubric.json:7`），W=41、允许失败权重 4.1；实测删掉 1 行（274 行）仍 **0.9268 合格**；行数+1 个客户名错误（总失败权重 5）才 **0.8780 不合格**。
  - **P0-2（材料保护）**：`rules: []`（`rubric.json:28`）；objective 要求“不要修改 materials/ 下的文件”（`case.json:6`），无保护规则（同一规则缺失，未逐例跑篡改实验，规则数组为空可证）。
  - **P1-3（计数字段未绑定语义）**：`M20` 只要求 `data-quality.md` 含子串 `["320","8","12","25","275"]`（`rubric.json:24`）；实测把参考解表格中的“A=8/B=12”两行数值互换后仍 **1.0 合格**。且 `"8"`/`"12"` 这类子串极弱（任何包含这些数字的文本都可满足）。
- 人工项：无。

### 3.3 data-03-periodic-report（季度费用月度报告）

- 文件齐全；schema OK；rubric 9 项 check（无 human、无 rules）。
- 参考解：1.0/pass；空输出 fail；自检 exit 0。
- 独立重算：180 行、90 天、每天 2 条（2026-07-01 至 2026-09-28）；月度合计 114325.16 / 110368.29 / 97463.51；环比 -3.46% / -11.69%（首月无环比）；类别合计 其他 33219.36、办公用品 96274.26、差旅 63106.90、市场推广 54236.13、技术服务 75320.31；最大类别办公用品 96274.26（占 29.88%，与参考解文字一致）。
- 问题：
  - **P0-1（权重）**：`M07` 最大类别权重 1（`rubric.json:11`），W=15、允许失败权重 1.5；实测把“办公用品”全部替换为“市场推广”仍 **0.9333 合格**；只有把月份合计改错（`M05` 权重 3）才 0.80 不合格。`M08` 权重 1、`M09` 权重 1 同理可单失败。
  - **P0-2（材料保护）**：`rules: []`（`rubric.json:15`）；实测向 `materials/daily_ledger.csv` 追加内容仍 **1.0 合格**。
  - **P1-4（表格内容未绑定）**：`M02/M03` 只查表头与行数（`rubric.json:6-7`），月份字符串由 `M04` 在全文任意位置校验（`:8`）；实测把三行月份标签 2026-07/2026-09 互换后仍 **1.0 合格**（合计与环比数字仍在文中）。
- 人工项：无。

### 3.4 lit-01-comparison-table（五篇论文对比表）

- 文件齐全（5 篇材料、参考解 5 行对比表 + 580 字综合结论）；schema OK；rubric 8 机械 check + 1 human、2 rules。
- 参考解：1.0/pass（M8 command exit 0）；空输出 fail（2 条规则违规）；自检 exit 0。
- 独立核对：rubric `M4` 的 6 个数值均能在对应论文摘要/结果表中定位（如 84.7/92.3 在 `paper-1-hier-rag.md:11,74,84`；86.1/90.8 在 `paper-2-iterwrite.md:11,73,91`；88.5 在 `paper-4-outline-write.md:11,67,77`；94.6 在 `paper-5-citeguard.md:11,71,79`，全表见 §8）；`M5` 的 1,200 在 `paper-1:11,51,59`；`M6` 的 1,600 在 `paper-5:11,55`；参考解 5 个《》标题逐字等于材料首行标题；参考解 3 处引号片段（≥10 字）全部在材料中逐字存在；参考解表格 5 行，综合结论 580 汉字（≥300）。
- 问题：
  - **P0-1（权重）**：`M8`（综合结论 ≥300 汉字）权重 1（`rubric.json:64-73`），`H1` 权重 1；W pending=11、允许失败权重 1.1；实测把综合结论删空后 M8 失败但 **0.9091 合格**；人类项若判 false 后重算为 11/12=**0.9167 合格**，即人工项单独失败也不影响判定。
  - **P0-2（材料保护）**：rules 只有 citation-sources 与禁外链（`rubric.json:83-101`），无 `protected-unchanged`；实测向 `materials/paper-1-hier-rag.md` 追加内容仍 **1.0 合格**（objective 第 4 段要求“不要修改 materials/ 下的任何文件”，`case.json:6`）。
  - **P2-1（“表头恰好”与逐行数值未校验）**：objective 要求表头“恰好”为 6 列、每行至少 2 个数值；`M2` 只要求 requiredHeaders 是子集（`rubric.json:12-20`，引擎 `score.mjs:501-533`），多列/换序都能过；逐行数值数量全靠 H1。
  - **P2-2（引用规则偏严）**：`R1` 会把任意 ≥10 字的中文引号片段当成引文校验（`score.mjs:535-568,570-637`）；实测在参考解末尾追加一句含“综合比较五篇材料的主要差异”的强调引号后，R1 判违规（**passed=false**）。这与 objective “引用原文必须逐字”一致，但模型把中文引号当强调时会误伤，需在 objective/提示中强调“引号只用于逐字引用”；属契约级可接受风险。
- 人工项：`H1`（1 项，权重 1）：问“对比表是否逐篇准确提取方法、数据集、样本量、主要指标与局限（无编造），且综合结论是否覆盖方法路线、数据规模、指标可比性、共同局限四方面？”——可判定，但是复合问题且与 M2/M4/M8 部分重叠；权重不足（见上）。

### 3.5 lit-02-review-draft（6 篇材料综述草稿）

- 文件齐全（含新增 `paper-6-survey.md`）；schema OK；rubric 7 机械 check + 2 human、2 rules。
- 参考解：1.0/pass（M7 command exit 0）；空输出 fail；自检 exit 0。
- 独立核对：6 个材料标题逐字存在；`M4` 的 5 个方法名、`M6` 的 5 个数据集名均可在材料中定位（含 `IterBench-500` 在 `paper-2-iterwrite.md:11,19,47,49,62,77,100,108`）；`M5` 的 5 个数值可在论文/综述中定位；参考解正文 950 汉字（800–1200 ✓）、6 个二级标题（≥4 ✓）、研究空白小节 253 汉字（≥150 ✓）、6 条不同 `materials/paper-*.md` 路径；参考解 3 处 ≥10 字引文均逐字可核。
- 问题：
  - **P0-1（权重）**：`M6`（数据集名，权重 1）等单项失败不致命；W pending=10、允许失败权重 1.0；实测把 `CiteBench-zh` 改为 `CiteBench` 后 **0.9000 合格**（恰好等于阈值）。人工项：`H1`/`H2` 各权重 1，单个人工项 false 后重算 11/12=**0.9167 合格**。
  - **P0-2（材料保护）**：rules 为 citation/禁外链（`rubric.json:88-106`），无 `protected-unchanged`；objective 第 6 段禁止修改材料（`case.json:6`）。
  - **P2-3**：`M2` 只保证 6 个路径各出现≥1 次，未校验“≥6 条真实引用”的条数与位置（位置由 objective 要求，未机械约束）。
- 人工项：`H1`（准确概括 6 份材料贡献/方法/差异且无矛盾）与 `H2`（研究空白 ≥3 条具体、可操作、与材料一致）——均可判定；`H2` 与 `M7` 的 command 互补（command 只查小节字数，不数 ≥3 条空白），不重复；但权重（各 1）不足以让 false 判定影响合格。

### 3.6 lit-03-data-extraction（3 篇论文表 2 抽取）

- 文件齐全；schema OK；rubric 9 机械 check + 1 human、1 rule（protected-unchanged）。
- 参考解：1.0/pass（无 command，真实引擎 1.0）；空输出 fail；自检 exit 0。
- 独立重算：解析三篇论文“### 4.3 主要结果 / 表 2”：
  - paper-1：表头 `模型|数据集|nDCG@10|Recall@100`，6 个（模型,数据集）组合；
  - paper-2：表头 `模型|数据集|nDCG@10|MAP`，6 个组合；
  - paper-3：表头 `模型|数据集|Recall@50|MRR`，6 个组合；
  - 三篇各 6 行 × 2 指标 = **36 个单元格**。参考解 `extracted.csv` 恰为 36 行，与重算集合**双向零差异**（缺失 0、多出 0），6 个抽查值（41.3/75.4/50.3/55.2/0.487/71.8）全部命中正确（论文、模型、数据集、指标四元组唯一）。
- 问题：
  - **P1-5（结构约束不足，最重要）**：`M3` 只有 `minRows:12`、无 `maxRows`（`rubric.json:21-25`）；objective 明确“只抽取正文 4.3 节标题为「表 2 主要结果」的那张表，不要抽取表 1、表 3、消融表或附录表”（`case.json:6`）。实测向参考解追加 1 行表 3 的消融数据（`paper-1…,去掉章节号,LongDoc-Write-test,nDCG@10,49.8`）后仍 **1.0 合格**；且只抽 12 行（每篇 4 行）也会过 `M3`。
  - **P0-1（权重+人工）**：6 个 `csv-cell` 权重均为 1（`rubric.json:27-91`），W pending=11、允许失败权重 1.1；实测把一个值 0.487 改为 0.499 后 **0.9091 合格**。唯一覆盖“完整性/不混表”的 `H1`（`rubric.json:93-99`）权重 1，false 后 11/12=**0.9167 仍合格**。
  - **P0-2（材料保护）**：有 `protected-unchanged ["materials"]`（`rubric.json:101-107`）——**本项正确**；实测篡改 `materials/paper-1-retriever-bench.md` → R1 违规、passed=false。
  - **P2-4（objective 歧义）**：objective 写“共至少 12 行”，而参考解/表 2 完整抽取应为 36 行；建议 objective 改为“完整 36 行（每篇 12 行）”，rubric `minRows=36, maxRows=36`，消除“12 行也算完成”的歧义。
- 人工项：`H1`（完整抽取表 2 全部行、无遗漏/重复/混入消融附录、模型名/数据集名/指标名/数值一致）——可判定，但机械检查只抽样 6/36 个单元格，H1 是唯一完整性保障，权重必须提高（见 §7）。

### 3.7 lit-04-advisor-revision（按导师 5 条意见修订）

- 文件齐全；schema OK；rubric 6 机械 check + 1 human、3 rules（protected/citation/禁外链）。
- 参考解：1.0/pass（M6 command exit 0）；空输出 fail；自检 exit 0。
- 独立核对：导师意见 5 条（`advisor-comments.md:9,11,13,15,17`）；参考解摘要 123 汉字（≤180 ✓，且 ≥60 下限由 held-out 脚本约束）、局限小节 4 条 `- ` 列表、章节顺序正确、结论写明“引用准确率更高、ROUGE-L 略低”、引言与讨论均含 `materials/paper-2-iterwrite.md`；`M4` 的 84.7/92.3/86.1/90.8 与引用片段“引用准确率达到 92.3%”“延迟相对 Hier-RAG 增加 64%”均能在材料中逐字定位（如 `paper-1-hier-rag.md:11`、`paper-2-iterwrite.md:75`）；参考解无“全面优于/显著优于”，原材料 `draft.md:55` 有这两个词。
- 问题：
  - **P0-1（权重+人工）**：`M5`（禁止措辞）权重 1，但 `M6` command 也检查同一条件（权重 2），实测追加“全面优于”后 0.70 不合格（冗余检查有效）；`H1` 权重 1，false 后 10/11=**0.9091 仍合格**（恰好等于阈值）。其余单项 w1 失败仍可合格（W=10、允许失败权重 1.0）。
  - **P0-2**：有 `protected-unchanged ["materials/draft.md","materials/advisor-comments.md"]`（`rubric.json:67-72`）——**正确**；实测篡改 draft → R1 违规 fail。
  - **P2-5**：禁用词只枚举“全面优于/显著优于”，同义的“全面超越”等不会被抓——导师意见原文只点名这两句，属可接受。
- 人工项：`H1`（修订稿是否忠实保留初稿方法与数据事实、语言通顺、5 条意见真正落实）——可判定；但权重不足，且“语言通顺”较主观。

### 3.8 report-01-multi-source-summary（多源材料汇总报告）

- 文件齐全（4 份材料）；schema OK；rubric 11 机械 check、1 rule（citation），**无 human**。
- 参考解：1.0/pass；空输出 fail（R01 违规）；自检 exit 0。
- 独立核对：`metrics.csv` 首周 W1（2026-08-31）deflection 52.4 / CSAT 3.86，末周 W8（2026-10-19）68.4 / 4.42（与 rubric M04–M07 一致）；访谈人物王琳（`interview-01.md:1`）、陈昊（`interview-02.md:1`）与项目简报负责人一致；参考解 1421 汉字（objective ≥1200 ✓）、4 处 ≥10 字访谈引文全部逐字可核、四个材料路径齐全、风险 4 条（objective ≥3 ✓）。
- 问题：
  - **P0-3（材料时间线矛盾，必须由作者修）**：`project-brief.md:11` 说“2026 年 7 月至 9 月…完成第一代灰度验证，灰度期周报见 materials/metrics.csv”，但 `metrics.csv:2-9` 的 W1–W8 覆盖 **2026-08-31 至 2026-10-19**；且简报日期 `2026-10-08`（`project-brief.md:5`）早于 W7（10-12）、W8（10-19）的数据日期。模型若忠实引用材料会写出自相矛盾的期间；rubric 也不校验日期，故不会发现。建议作者把简报期间改为“2026 年 8 月底至 10 月中旬”或把 metrics 周次前移，并统一简报日期。
  - **P1-6（首末周绑定）**：`M04–M07` 只查四个数值出现（`rubric.json:8-11`），未绑定“首周/末周”；实测把“首周为 52.4%，末周为 68.4%”与“CSAT 首周 3.86，末周 4.42”对调后仍 **1.0 合格**。
  - **P1-7（访谈引用数量）**：objective 要求“至少 2 处访谈原话引用”（`case.json:6`）；`R01` 只校验“出现的中文引号片段必须逐字可核”，不要求至少出现；实测把参考解全部中文引号删除（0 处引用）后仍 **1.0 合格**。
  - **P0-2（材料保护）**：rules 只有 citation（`rubric.json:17-19`），无 protected；实测向 `materials/metrics.csv` 追加内容仍 **1.0 合格**。
  - **P2-6**：`M01` 用 3500 字节下界代替“≥1200 字”（纯中文 1200 字≈3600 B），存在约 1167 汉字的灰区；`M02` 只查“结论/证据/风险”子串，不查三级结构。
- 人工项：无（建议补 1 项：报告结论/证据/风险的匹配度与访谈引用真实性）。

### 3.9 report-02-meeting-minutes（会议纪要）

- 文件齐全（transcript + attendees）；schema OK；rubric 8 机械 check、1 rule，**无 human**。
- 参考解：1.0/pass；空输出 fail；自检 exit 0。
- 独立核对：transcript 中 5 条待办（张伟 11-06、陈曦 11-10、刘洋 11-13、王琳 11-17、林可 11-20）、3 项决定、下次会议 2026-11-24、6 位参会人（周明远/张伟/王琳/刘洋/陈曦/林可）；参考解待办表 5 行与 transcript **负责人-日期-事项逐条一致**；2 处引文逐字可核；未出现材料外参会人。
- 问题：
  - **P1-8（负责人-日期映射未校验，最重要）**：`M02` 只查表头/行数（`rubric.json:6`），`M03`/`M04`/`M05` 分别只查日期集合、负责人集合、参会人集合（`:7-9`）。实测把参考解中张伟与陈曦两人（含表中负责人）互换后仍 **1.0 合格**——负责人-截止日期错配无法发现。
  - **P1-9（决定数量未校验）**：`M07` 只要求包含子串“决定”（`rubric.json:11`）；实测把 3 条决定全部删除（标题“决定清单”仍含“决定”）后仍 **1.0 合格**。objective 要求“完整列出全部决定（不少于 3 条）”（`case.json:6`）。
  - **P1-7（引用数量）**：objective 要求“至少 1 处”逐字摘录；R01 不要求出现；实测删除中文引号后仍 **1.0 合格**（本次与删除决定同测，score 1.0）。
  - **P0-2（材料保护）**：无 protected 规则（`rubric.json:14-16`）；实测向 `materials/attendees.md` 追加内容仍 **1.0 合格**。
  - **P2-7**：`M06` 只枚举 5 个常见虚构人名，不足以防其他编造；`M08` 只查下次会议日期，未查时间/地点。
- 人工项：无（建议补 1 项：决定清单完整性与负责人-日期对应）。

---

## 4. 必须修的问题（按严重度）

### 4.1 P0-1：权重/阈值标定不足，核心检查单失败不能判不合格（影响全部 9 例）

- 判定公式：`passed = violations.length===0 && score>=passThreshold`（[score.mjs:722-723](scripts/golden/score.mjs#L722-L723)），全部样例 `passThreshold=0.9`。因此 W 总权重下允许失败权重 ≤ `0.1×W`；核心检查权重低于该值就“写错也能合格”。
- 量化表（W 为已计入权重；human pending 时扣除 H 权重）：

| 样例 | W(pending) | human 权重 | 允许失败权重 | 实测“仍合格”的错误 |
|---|---:|---:|---:|---|
| data-01 | 40 | 0 | 4.0 | 2 个区域指标错（0.90） |
| data-02 | 41 | 0 | 4.1 | 行数 274（0.9268） |
| data-03 | 15 | 0 | 1.5 | 最大类别错（0.9333）；月份标签互换（1.0） |
| lit-01 | 11 | 1 | 1.1 | 综合结论 0 汉字（0.9091） |
| lit-02 | 10 | 2 | 1.0 | 少一个数据集名（0.9000） |
| lit-03 | 11 | 1 | 1.1 | 一个抽样值错（0.9091）；混入表 3 行（1.0） |
| lit-04 | 10 | 1 | 1.0 | 单项检查失败（例如 M1 文件被压到 3000B 以下，0.9） |
| report-01 | 13 | 0 | 1.3 | 首末周对调（1.0）；0 引用（1.0） |
| report-02 | 14 | 0 | 1.4 | 负责人-日期互换（1.0）；决定全删（1.0） |

- 具体行：`rubric.json:3`（各例 passThreshold）、data-01 `:5-26`、data-02 `:5-26`、data-03 `:5-13`、lit-01 `:5-81`、lit-02 `:5-86`、lit-03 `:5-99`、lit-04 `:5-65`、report-01 `:5-15`、report-02 `:5-12`。
- 建议（二选一或组合）：
  1. 把 `passThreshold` 从 0.9 提到 **0.95**（W=40 时允许失败权重 2；lit 类 W≈11 时任何权重 1 失败都不合格），并重跑基线；
  2. 把“不能写错”的检查放进 `rules`（违反即不合格，不参与加权），例如数据类的行数/关键单元格、报告类的首末周绑定与负责人-日期映射、文献类的完整抽取；`rules` 的硬约束语义见设计文档 §4（[设计:112-118](docs/kodo-golden-eval-design-20261103.md#L112-L118)）。
  3. 仅调单个权重不够：例如 data-01 需要把每个区域的核心指标权重提到 >4 才能单独判失败，不如改用规则。

### 4.2 P0-2：7/9 例没有 materials 保护规则，篡改材料不会被发现（data-01/02/03、lit-01/02、report-01/02）

- 证据：只有 lit-03（`lit-03/rubric.json:101-107`）与 lit-04（`lit-04/rubric.json:67-72`）声明 `protected-unchanged`；其余 7 例 `rules` 为空或只有 citation/禁外链：data-01 `rubric.json:28`、data-02 `:28`、data-03 `:15`、lit-01 `:83-101`、lit-02 `:88-106`、report-01 `:17-19`、report-02 `:14-16`。
- 这 7 例的 objective 都明确要求“不要修改 materials/”（各 `case.json:6`），但均无机械规则。
- 实测（真实引擎）：向以下材料追加内容后仍 **1.0 合格**——`data-01/materials/sales.csv`、`data-03/materials/daily_ledger.csv`、`lit-01/materials/paper-1-hier-rag.md`、`report-01/materials/metrics.csv`、`report-02/materials/attendees.md`；对照：lit-03/lit-04 篡改材料后正确判 `protected-unchanged` 违规（passed=false）。
- 建议：给 7 例补 `rules: [{"id":"R1","kind":"protected-unchanged","params":{"paths":["materials"]}}]`（可复用 lit-03 的写法；引擎 `collectRequirements` 会先算保护快照再 restore/stage，见 [run.mjs:454-470](scripts/golden/run.mjs#L454-L470) 与 [score.mjs:570-637](scripts/golden/score.mjs#L570-L637)）。

### 4.3 P0-3：report-01 材料自身时间线矛盾（作者修材料）

- `report-01/workspace/materials/project-brief.md:11`：称灰度期为“2026 年 7 月至 9 月”，并让读者看 `materials/metrics.csv`；但 `metrics.csv:2-9` 的 W1=2026-08-31、W8=2026-10-19（8 周覆盖 8 月底至 10 月中）；`project-brief.md:5` 的简报日期 2026-10-08 早于 W7/W8 的数据日期。
- 影响：模型若引用简报期间会与指标周次矛盾；rubric 没有日期检查，所以评分不报错，但样例作为“报告类基线”的可信度受损。建议改成“2026 年 8 月底至 10 月中旬”并同步简报日期（或把 metrics 周次改到 7 月），作者确认后重跑自检。

---

## 5. P1（建议基线前修）——语义绑定与完整性缺口

| 编号 | 样例 | 问题（文件:行） | 实测证据 | 建议 |
|---|---|---|---|---|
| P1-1 | data-01 | 图表只查存在与字节数（`rubric.json:24`），objective 要求 matplotlib 柱/折线图（`case.json:6`） | 向 chart.png 追加非图片文本 → 1.0 合格 | 加 held-out command 校验 PNG 签名/尺寸（或人工 H） |
| P1-2 | data-01 | 报告 200–300 字未校验，只有 minBytes 400（`rubric.json:25`） | 1000 字/150 字都可过 | 加 H 或 command 统计汉字区间 |
| P1-3 | data-02 | data-quality 计数只查子串 `["320","8","12","25","275"]`（`rubric.json:24`），A/B/C 标签未绑定 | A/B/C 标签互换 → 1.0 合格 | 加 command 解析五处计数与标签对应，或 H |
| P1-4 | data-03 | 表格只查结构（`rubric.json:6-7`），月份-合计绑定未校验 | 月份 07/09 标签互换 → 1.0 合格 | 加 command 解析两张表并核对月份/类别与数值对应 |
| P1-5 | lit-03 | 只 `minRows:12` 无 `maxRows`（`rubric.json:21-25`），不排除表 1/表 3/附录（objective `case.json:6`） | 追加 1 行表 3 消融数据 → 1.0 合格 | `minRows:36,maxRows:36` + command 对照表 2 单元格集（或提高 H1 权重并补 command） |
| P1-6 | report-01 | 首周/末周未绑定（`rubric.json:8-11`） | 首末周数值对调 → 1.0 合格 | file-contains 组合短语或 command 校验 |
| P1-7 | report-01、report-02 | 引用数量未要求（R01 `report-01/rubric.json:18`、`report-02/rubric.json:15`） | 删除全部中文引号 → 1.0 合格 | 加 command 统计 ≥10 字逐字引文数（report-01 ≥2、report-02 ≥1） |
| P1-8 | report-02 | 负责人-日期映射未校验（`rubric.json:6-9`） | 张伟/陈曦互换 → 1.0 合格 | 加 held-out command 解析表格并对照 transcript 的 5 组（负责人,截止日期） |
| P1-9 | report-02 | 决定数量未校验，M07 只查子串“决定”（`rubric.json:11`） | 删除全部 3 条决定 → 1.0 合格 | command 统计“决定 N/1.”条数 ≥3（或 H） |
| P1-10 | lit-01/02/03/04 | 人工项权重 1–2，单个人工 false 不影响合格（见 §7） | lit-01/03：11/12=0.9167；lit-04：10/11=0.9091；lit-02 单个 11/12=0.9167 | 人工项权重提到 2（W=12 时 10/12 失败）或配合 passThreshold 0.95 |
| P1-11 | data-01/02/03、report-01/02 | 无任何人工项；语义正确性（图表、结论、风险、访谈引用真实性）无兜底 | 多个语义错误仍 1.0 | 每例补 1 项 H（问题见 §7 建议） |

---

## 6. 可接受问题（P2，不阻塞基线但建议记录）

1. **引用规则对“强调引号”偏严**（lit-01/02、report-01/02 的 citation-sources）：任意 ≥10 字中文引号片段必须逐字在材料中（`score.mjs:535-568`）。实测在 lit-01 参考解追加“综合比较五篇材料的主要差异”这类强调引句后 R1 违规；在 report-02 追加类似强调引句后 R01 违规。objective 已要求引号只用于逐字引用，属契约一致行为；建议在 objective/提示中再次强调，评审时把“引号误用”视为模型错误而非样例缺陷。
2. **markdown-table 检查只校验结构**（引擎 `score.mjs:501-533` 只做 requiredHeaders 子集 + 行数）：lit-01 的“表头必须恰好”与“每行 ≥2 个数值”未机械校验（`rubric.json:12-20`），由 H1 兜底；data-03/report-02 的表格单元格语义需按 P1-4/P1-8 补。
3. **数值容差偏宽**：data-01 的 `order_count` 也带 `tolerance:0.01`（`rubric.json:11,15,19,23`，对整数无意义）；均值/中位数 tolerance 0.01 允许 3 位小数输出，与 objective“保留两位”不完全一致。
4. **lit-01 M2 不校验列顺序/多余列**、**report-02 M06 虚构人名清单不穷尽**、**report-02 M08 只查下次会议日期不查时间/地点**、**data-03 M09 只查“—”字符**：均为轻量弱点，可留待后续批次。
5. **自检脚本是复制件且有陈旧注释**：5 个 data/report 例的 `verify/check-rubric.py` 哈希相同（`B14C2C50FB23054A`，21,503 B），4 个 lit 例的 `verify/check-rubric.mjs` 相同（`25526F9E00F91479`，26,057 B）；两个脚本头部仍写“评分引擎尚在开发”，而引擎已存在。python 版未实现 `command`/`protected-unchanged`（当前 5 例未使用，暂不影响）；lit 版把 human 记为 pending（符合设计）。建议在样例定稿时统一更新说明，或改为引用 `scripts/golden` 的校验函数以减少双实现偏差。
6. **无显式 `grading` 的样例会被 runner 默认 stage 整个 `verify/`**：`run.mjs` 对没有 `grading.stage` 但有 `verify/` 的样例，会执行 `verify → workspace/verify` 的默认 stage（[run.mjs:470-500](scripts/golden/run.mjs#L470-L500)），导致评分时 `workspace/verify/` 里出现参考解与自检脚本。当前 9 例的检查都不读该目录，故无评分影响；若以后加入 `artifact-count`/根目录 glob 检查需注意。建议给不需要 command 的样例显式声明空 stage 或在 runner 侧加显式开关。
7. **设计文档与实现的术语差**：设计 §4.1 `protected-unchanged` 参数写 `paths[]`、`beforeDigest`（[设计:136](docs/kodo-golden-eval-design-20261103.md#L136)），实际引擎只用 `paths`（快照由 runner 计算）；建议更新文档描述。

---

## 7. 人工项（H*）复核

| 样例 | H 项 | 权重 | 可判定性 | 与机械检查重复 | 结论/建议 |
|---|---|---:|---|---|---|
| data-01/02/03 | 无 | — | — | — | **缺人工兜底**：图表内容、报告语义、数据质量说明的文字正确性无法机械覆盖，建议各补 1 项（尤其 data-01 图表） |
| lit-01 | H1 | 1 | 可判定，但是复合问句（准确性 + 结论四要素） | 与 M2/M4/M8 部分重叠，独有价值是“准确/无编造”与“可比性判断” | 建议拆成 2 问或权重提到 2；否则 H 判 false 仍能合格（11/12=0.9167） |
| lit-02 | H1/H2 | 1/1 | 可判定 | H2 与 M7 command 互补（command 只查小节字数）；H1 无机械对应 | 单个 H false → 11/12=0.9167 合格；建议 H 权重提到 2（两个都 false 才 0.833 不合格，需至少一项能独立否决） |
| lit-03 | H1 | 1 | 可判定，是本例“完整性/不混表”的唯一保障 | 与 M2 列名、M3 行数部分重叠但覆盖更全 | **必须提高**：H 判 false 仍 11/12=0.9167 合格，而机械检查只抽 6/36；建议 H1 权重 ≥2 且 M3 改 36 行 |
| lit-04 | H1 | 1 | 可判定（忠实性/通顺/5 条落实），“语言通顺”略主观 | 与 M2–M6 部分重叠 | H1 权重 2（10/11→9/11 不合格）；否则 10/11=0.9091 合格 |
| report-01/02 | 无 | — | — | — | **缺人工兜底**：报告/纪要的语义正确性（结论与证据匹配、风险完整性）无人工项；建议各补 1 项 |

共性问题：所有 human 检查都按权重参与分数、不参与 rules；单个 H false 在 9 例中**没有一例能导致不合格**（lit-02 两个 H 同时 false 才会 0.833 不合格）。这与设计文档“人工项全部补评后重算总分与合格率”的意图不完全匹配——人工评了但不影响判定，需要提高权重或改阈值。

---

## 8. 独立重算与材料核对结果（摘要）

### 8.1 数据类（pandas 独立重算，全部与 rubric 一致）

- **data-01**：240 行→226 有效（12 空 + 2 `N/A`）；四区域 16 个指标与 rubric 完全一致（§3.1 表）；总销售额 211820.67；华东最高；无差异项。
- **data-02**：原始 320 行；A=8（空 order_id）、B=12（重复，保留 `updated_at` 最新，**无并列最大值**）、C=25（customer 14 + product 11，**无重叠**）、最终 275 行；四种日期格式 79/80/78/83，全部可解析；15 个抽查单元格一致；**参考解 275 行 merged.csv 与重算逐行逐列 0 差异**。
- **data-03**：180 行×90 天、每天 2 条；月度合计 114325.16/110368.29/97463.51；环比 -3.46%/-11.69%；类别合计与最大值一致（办公用品 96274.26，占 29.88%）。

### 8.2 文献类（逐项定位到材料，抽查值均可回溯）

- **lit-03**：三篇“表 2 主要结果”各 6 行×2 指标 = 36 单元格；参考解 36 行与重算集合**双向零差异**；表 2 位置唯一（`paper-1-retriever-bench.md:57-68`、`paper-2-rerank.md:58-69`、`paper-3-hybrid.md:58-69`），每篇另有表 1（数据统计）与表 3（消融/参数）存在——正是 P1-5 说的污染来源（表 3 行在 `paper-1:74-81`、`paper-2:75-82`、`paper-3:75-82`）。
- **lit-01**：rubric 6 个数值与 2 个样本量均在对应论文的摘要+结果表定位（84.7/92.3@paper-1、86.1/90.8@paper-2、88.5@paper-4、94.6@paper-5、1,200@paper-1、1,600@paper-5）；参考解 5 个《》标题逐字等于材料首行标题；3 处引文逐字存在；综合结论 580 汉字。
- **lit-02**：6 个标题逐字存在；5 个方法名、5 个数据集名、5 个数值均可定位；参考解 950 汉字（800–1200）、6 个二级标题、研究空白 253 汉字、6 个不同材料引用、3 处引文逐字可核。
- **lit-04**：5 条意见对应的机械要求均满足；引用片段“引用准确率达到 92.3%”（`paper-1-hier-rag.md:11`）与“延迟相对 Hier-RAG 增加 64%”（`paper-2-iterwrite.md:75`）逐字可核；摘要 123 汉字、局限 4 条列表；原材料含“全面优于/显著优于”，参考解已清除。

### 8.3 报告类（关键事实与材料一致，除 report-01 时间线矛盾）

- **report-01**：metrics 首 W1（2026-08-31）52.4/3.86、末 W8（2026-10-19）68.4/4.42；访谈人物王琳、陈昊与简报负责人（王琳/张伟/陈曦/周明远）不冲突；参考解 4 处访谈引文逐字可核、1421 汉字、4 条风险。**材料矛盾**见 P0-3。
- **report-02**：transcript 5 条待办（张伟 11-06、陈曦 11-10、刘洋 11-13、王琳 11-17、林可 11-20）、3 项决定、下次会议 2026-11-24、6 位参会人；attendees.md 与 transcript 一致，无材料外参会人；参考解表格逐条与 transcript 一致、2 处引文逐字可核。

### 8.4 参考解对 objective 的合规性（抽查）

| 样例 | objective 硬性要求 | 参考解实测 |
|---|---|---|
| data-01 | 200–300 字结论、chart ≥5KB | 260 汉字；PNG 20,483 B（合法 PNG 签名） |
| data-02 | 写明 320/A/B/C/最终行数 | 320/8/12/25/275 全部写明 |
| data-03 | 两表 3+5 行、金额两位小数、环比带 %、首月 — | 表 3 行/5 行；无千分位；-3.46%/-11.69%；— 1 处 |
| lit-01 | 6 列表 ≥5 行、综合结论 ≥300 汉字、≥2 数值/行 | 5 行；580 汉字；每行 12–19 个数字 |
| lit-02 | 800–1200 汉字、≥4 个二级标题、研究空白 ≥150 字/≥3 条、≥6 引用 | 950 汉字；6 个 H2；253 字（≥3 条空白）；6 条路径 |
| lit-03 | 表 2、≥12 行、5 列 | 36 行、5 列、精确到表 2 |
| lit-04 | 5 条意见（顺序/摘要 ≤180 字/≥3 条局限/引用 paper-2/禁用措辞） | 全部满足（摘要 123 字、4 条局限、引言+讨论各引用、无禁用词） |
| report-01 | ≥1200 字、三部分、≥2 访谈引文、4 材料引用 | 1421 汉字、结论/证据/风险、4 处引文、4 条路径 |
| report-02 | 会议信息+全部参会人、≥3 决定、5 条待办表、≥1 引文、下次会议 | 6 人、3 项决定、5 行表、2 段引文、2026-11-24 |

---

## 9. 基线准入结论与建议

1. **当前结论：9 个里 0 个可直接进入阶段 0 基线。** 原因不是样例/参考解错误，而是评分安全网不足：§4 的 P0-1/P0-2 影响全部 9 例，report-01 另有 P0-3 材料矛盾；§5 的 P1 是让“错误解”通过的直接原因（尤其 P1-5/P1-8/P1-9 会让“混表、错配、漏决定”这类典型错误满分通过）。
2. **修复后的准入判断：P0 全部修复 + report-01 材料矛盾修复后，9 例都可作为基线候选；P1 建议在基线前完成**（至少 P1-3/4/5/6/8/9/10/11），否则基线合格率会被抬高，阶段 1 的“删后不翻转”比较会失真。
3. **修复分工建议**：
   - 样例作者：补 `protected-unchanged`（7 例）、新增 held-out command/H 检查（P1-3/4/5/6/7/8/9/11）、data-01 图表校验、提高核心检查权重；report-01 作者修 `project-brief.md` 时间线并同步简报日期。
   - 评测基础设施负责人：确认 `passThreshold` 是否统一升到 0.95（或把关键检查提升为 rules），并在 `scripts/golden` 侧固定“rules 只用于不可违反约束”的语义；同步更新设计文档 §4.1 `beforeDigest` 描述。
   - Lead/评审：P0 修复后按设计 §8 重跑 9 例 × 3 次基线；本文的变异用例可直接复用为“评分反例集”（建议加入 `scripts/golden` 的回归测试）。
4. **未完成项**：无样例缺文件；仅建议作者在定稿后重跑本文 §2 的四类复核，并确认 `verify/README.md` 与实现一致（复核期间 README 于 15:27 更新，本文未采信其结论）。

---

## 10. 附录：复核快照与执行记录

### 10.1 被复核文件哈希（sha256 前 16 位，2026-11-03 15:30 采样）

| 样例 | case.json | rubric.json | 参考解 |
|---|---|---|---|
| data-01 | `da319b59630a1a7b` | `98cd7d1cc35902c3` | chart.png `8fd4f98821666102`；report.md `9234d29c2dc4391b`；summary.csv `ddb23febbbf2b81a` |
| data-02 | `c1284f96f84d6dfb` | `5066a8c998685a27` | data-quality.md `79ce0bac11b3ccd5`；merged.csv `eb0381ae25c1e1c2` |
| data-03 | `e1326b3a825647c5` | `cddb3db5a2e1c995` | monthly-report.md `13a7e659ab2541fc` |
| lit-01 | `058661353faa24aa` | `8eb3d0664d1285c5` | comparison.md `3d6a4b015f627844` |
| lit-02 | `ca18d5ba8374dfb1` | `b898b8095d18e114` | review.md `70184cee0410dd10` |
| lit-03 | `bcd08229c6ff8165` | `b235c67184f156c7` | extracted.csv `d1287acf88936d7c` |
| lit-04 | `ec64705ac8cb2968` | `591933aea7f323a6` | revised.md `e0b05e2e9eb87b79` |
| report-01 | `0568d1cffd3c8131` | `db2fcf0326272115` | summary.md `3aa57eed6023fb2d` |
| report-02 | `e2de8e38876080bd` | `6640a0cd88f27374` | minutes.md `db166747ccdc048b` |

评分引擎快照：`scripts/golden/score.mjs` = `4E2893B74043DEA7`（37,905 B，15:23:48）、`cases.mjs` = `5B90CBDADB3073B1`（11,307 B，15:23:48）；复核期间 `run.mjs`/`workspace.mjs` 在 15:27 更新（本文未用其改动后的流水线，harness 只导入 `cases.mjs` + `score.mjs` 并自行镜像 runner 语义）。

### 10.2 执行记录

- 环境：Windows PowerShell；Python `3.12`（bundled，pandas 3.0.1）；Node `v24.21.0`（bundled）。
- 9 例自带自检：`cd <case>; python verify/check-rubric.py` 或 `node verify/check-rubric.mjs` → 全部 exit 0 / `SELF-CHECK OK`（参考解 100% 通过、空输出不通过；lit-03/lit-04 追加篡改 protected 负例也通过）。
- 真实引擎 harness：临时脚本导入仓库 `scripts/golden/cases.mjs` 与 `score.mjs`，对每例在系统临时目录构造“种子 + 参考解 + grading restore/stage”工作区，先做 protected 快照比较，再执行 command，最后 `evaluateRubric`；参考解 9/9 = 1.0，空输出 9/9 fail，变异 28 组（见 §4/§5/§6 的表格）。
- 独立重算/核对脚本：`recompute.py`（data-01/02/03）、`verify-material.py`（schema+data）、`verify-lit-report.py`（lit/report 文本定位）、`final-analysis.py`（权重/合规/一致性）；全部只在 `%TEMP%\rubric-review-20261103` 下写中间产物，**未修改仓库文件**。
- 只读声明：本次复核未改动 `eval/golden/**`、`scripts/**`、`src/**`、`package.json`，未执行 `git add/commit`；仓库中仅新增本文档。
