# Rubric 修复回归复核（Lit 4 例）——task-5 变异缺口关闭验证

日期：2026-11-03。复核者：phase1-mapper（独立复核，非样例作者）。状态：只读，未修改 `eval/golden/**`、`scripts/**`、`src/**`、`package.json`，未 git commit。
本文是 [黄金样例评分标准独立复核](kodo-rubric-review-20261103.md)（task-5）的**追加报告**；选择“新建 addendum”而不是追加 review doc §9，因为 review doc 已被提交（commit `8c2256f`）作为历史记录，保持不可变。
复核快照：2026-11-03 15:36–15:39（Asia/Shanghai）。HEAD=`e839a68`；Lit 修复在 commit `8c2256f`（`eval: rubric safety fixes, stage-1 comparison gate, independent review`）。Data/Report 5 例的修复**正在工作区进行中**（未提交，见 §6），本轮只记录状态、不评分，等 Lead 通知后跑同一套回归。

范围：`lit-01-comparison-table`、`lit-02-review-draft`、`lit-03-data-extraction`、`lit-04-advisor-revision`。
方法：与 task-5 相同——临时 harness 导入**真实** `scripts/golden/cases.mjs`（`5B90CBDADB3073B1`）与 `scripts/golden/score.mjs`（`4E2893B74043DEA7`，与 task-5 相同、未变），按 runner 语义构造工作区（种子 + 参考解 + grading restore/stage → protected 快照比较 → command 执行 → `evaluateRubric`），并新增 `human.json` 注入以复核补评后的判定；另跑自带 `verify/check-rubric.mjs`。

---

## 0. 结论摘要

| 项 | lit-01 | lit-02 | lit-03 | lit-04 |
|---|---|---|---|---|
| **P0-1 权重/阈值**（0.9→0.95） | **已关闭** | **已关闭** | **已关闭** | **已关闭** |
| **P0-2 materials 保护规则** | **已关闭**（新增 R3） | **已关闭**（新增 R3） | 之前已有，保持关闭 | **已关闭**（保护范围扩为全部 materials） |
| **lit-03 P1-5（行数固定 36）** | — | — | **部分关闭**：37 行/35 行均判不合格；残留见 §5 | — |
| 参考解（真实引擎） | 1.0 pass，0 违规 | 1.0 pass，0 违规 | 1.0 pass，0 违规 | 1.0 pass，0 违规 |
| 空输出 | fail | fail | fail | fail |
| protected 误伤正常解 | 无（见 §4） | 无 | 无 | 无 |
| 自带自检脚本 | exit 0 | exit 0 | exit 0 | exit 0 |
| 仍开放问题 | 无 P0/P1；P2 陈旧 README | 无 P0/P1；P2 陈旧 README | **P1-A objective 与 rubric 不一致（新引入）** + P2 残留 | 无 P0/P1；P2 陈旧 README |

**一句话**：Lit 4 例的 P0-1、P0-2 全部关闭，task-5 的 Lit 变异（单检查失败、篡改 materials、人类项判 false）现在都会导致不合格，且 protected 规则没有误伤参考解/空输出/附加正常文字；**唯一新发现是 lit-03 把行数固定为 36 后，objective 仍写“共至少 12 行”，造成 rubric 严于 objective 的假阴性风险**（35 个合法行也会被判 0.8182 不合格），以及“36 行同基数替换”机械上仍不可见（依赖现已被 H1 兜住）。

---

## 1. 逐样例关闭结论与证据

### 1.1 lit-01-comparison-table（rubric `7b6e29ed9625ed5e`，task-5 为 `8eb3d0664d1285c5`）

改动：`passThreshold` 0.9→0.95（`rubric.json:3`）；新增 `R3 protected-unchanged paths:["materials"]`（`rubric.json:101-105`）。权重：W=12（含 H1=1），pending W=11。

| 情形 | 结果 | 判定 |
|---|---|---|
| 参考解 | score=1.0000，passed=true，violations=0 | 正常解不受 protected 影响 |
| 空输出 | score=0，passed=false；violations=`R1,R2`（**R3 protected 未报**） | protected 不误伤 |
| task-5 变异：删除「综合结论」正文（M8 w1 失败） | 0.9091，**passed=false**（旧：0.9091 合格） | **P0-1 已关闭** |
| task-5 变异：篡改 `materials/paper-1-hier-rag.md` | R3 违规，score 仍 1.0 但 **passed=false**（旧：1.0 合格） | **P0-2 已关闭** |
| 人工 H1=false（补评后重算） | W=12，score=0.9167，**passed=false**（旧：0.9167 合格） | 人工项现在有约束力 |
| 人工 H1=true | score=1.0000，passed=true | 正常补评可通过 |
| 正常附加文字（末尾加一句无引号/无链接的补充） | 1.0000，passed=true | 无受保护误伤 |
| 强调引号（中文引号包 ≥10 字非材料句） | R1 违规，passed=false | task-5 已列的 P2 契约风险，未变化（非新问题） |

### 1.2 lit-02-review-draft（rubric `f4260b3086350bfe`，task-5 为 `b898b8095d18e114`）

改动：`passThreshold` 0.95（`rubric.json:3`）；新增 `R3 protected-unchanged paths:["materials"]`（`rubric.json:107-110`）。权重：W=12（H1+H2=2），pending W=10。

| 情形 | 结果 | 判定 |
|---|---|---|
| 参考解 | 1.0000，passed=true，violations=0 | 正常解不受影响 |
| 空输出 | score=0，passed=false；violations=`R1,R2`（R3 未报） | protected 不误伤 |
| task-5 变异：`CiteBench-zh`→`CiteBench`（M6 w1 失败） | 0.9000，**passed=false**（旧：0.9000 合格） | **P0-1 已关闭** |
| 篡改 `materials/paper-6-survey.md` | R3 违规，**passed=false** | **P0-2 已关闭** |
| 人工 H2=false | W=11，0.9091，**passed=false** | 单个 H 判 false 现在会不合格 |
| 人工 H1=false + H2=false | W=12，0.8333，passed=false | — |
| 人工 H1=true + H2=true | 1.0000，passed=true | — |
| 正常附加文字 | 1.0000，passed=true | 无误伤 |

### 1.3 lit-03-data-extraction（rubric `45b9086755ae9094`，task-5 为 `b235c67184f156c7`）

改动：`passThreshold` 0.95（`rubric.json:3`）；`M3 csv-rows minRows=36, maxRows=36`（`rubric.json:21-25`）。权重：W=12（含 H1=1），pending W=11。

| 情形 | 结果 | 判定 |
|---|---|---|
| 参考解（36 行） | 1.0000，passed=true，violations=0（R1 protected pass） | 正常解不受影响 |
| 空输出 | score=0，passed=false；violations=[]（**protected 未报**） | protected 不误伤；仅因缺交付物 FAIL |
| task-5 变异：一个抽样值 0.487→0.499（M8 w1） | 0.9091，**passed=false**（旧：0.9091 合格） | **P0-1 已关闭** |
| task-5 变异：追加 1 行表 3 消融数据（37 行） | 0.8182，**passed=false**（旧：1.0 合格） | **P1-5 额外行已关闭** |
| 删除 1 行（35 行，仍满足 objective 的“≥12 行”） | 0.8182，**passed=false** | 行数双向锁定（见 §5 的 objective 不一致） |
| 同基数替换：删 1 个合法行 + 加 1 行表 3 行（仍 36 行） | score=1.0000，passed=true（H1 pending 时） | **机械残留**：行数正确时替换不可见（见 §5） |
| 同上 + 人工 H1=false | W=12，0.9167，passed=false | 依赖 H1 兜底（现已绑定） |
| 同上 + 人工 H1=true | 1.0000，passed=true | 人工若未发现仍可通过 |
| 篡改 `materials/paper-1-retriever-bench.md` | R1 违规，passed=false | 既有保护保持关闭 |

### 1.4 lit-04-advisor-revision（rubric `eb93938f95f904f7`，task-5 为 `591933aea7f323a6`）

改动：`passThreshold` 0.95（`rubric.json:3`）；`R1 protected-unchanged paths` 由 `["materials/draft.md","materials/advisor-comments.md"]` 扩为 `["materials"]`（`rubric.json:67-72`）。权重：W=11（含 H1=1），pending W=10。

| 情形 | 结果 | 判定 |
|---|---|---|
| 参考解 | 1.0000，passed=true，violations=0 | 正常解不受影响 |
| 空输出 | score=0，passed=false；violations=`R2,R3`（**R1 protected 未报**） | protected 不误伤 |
| task-5 变异：追加“全面优于”（M5+M6 失败） | 0.7000，passed=false（不变） | 已是硬约束 |
| 篡改 `materials/draft.md` | R1 违规，passed=false | 既有保护保持 |
| 篡改 `materials/advisor-comments.md` | R1 违规，passed=false | 既有保护保持 |
| **篡改 `materials/paper-1-hier-rag.md`**（旧规则不覆盖） | R1 违规，**passed=false**（旧：不保护） | **P0-2 扩围已生效** |
| 人工 H1=false | W=11，0.9091，**passed=false**（旧：0.9091 合格） | 人工项现在有约束力 |
| 人工 H1=true | 1.0000，passed=true | — |
| 正常附加文字 | 1.0000，passed=true | 无误伤 |

---

## 2. P0-1 关闭证据：阈值 0.95 下的权重敏感度

判定公式不变：[score.mjs:722-723](scripts/golden/score.mjs#L722-L723) `passed = violations===0 && score>=passThreshold`。文本样例阈值改为 0.95 后，每个样例“允许失败权重”降为：

| 样例 | W(pending) | W(含 human) | 允许失败权重（pending） | 旧 0.9 下允许 | 实测单检查失败 |
|---|---:|---:|---:|---:|---|
| lit-01 | 11 | 12 | 0.55 | 1.1 | M8 w1 失败 → 0.9091 **不合格** |
| lit-02 | 10 | 12 | 0.50 | 1.0 | M6 w1 失败 → 0.9000 **不合格** |
| lit-03 | 11 | 12 | 0.55 | 1.1 | M8 w1 失败 → 0.9091 **不合格** |
| lit-04 | 10 | 11 | 0.50 | 1.0 | 单检查失败→不可能合格（0.95 阈值下任何 w≥1 失败即 ≤0.909） |

补充：人类项在 0.95 阈值下也变成有约束力的（H 判 false → 可能不合格）：lit-01 0.9167、lit-02 单个 0.9091、lit-03 0.9167、lit-04 0.9091 全部 <0.95 → 不合格。这同时关闭了 task-5 §7 的 P1-10（人工项无约束力）在 Lit 例上的问题（H 权重仍为 1，靠阈值生效；若未来调回低阈值需重新评估）。

---

## 3. P0-2 关闭证据：materials 保护规则

- lit-01：新增 `R3 protected-unchanged {"paths":["materials"]}`（`rubric.json:101-105`）。
- lit-02：新增 `R3 protected-unchanged {"paths":["materials"]}`（`rubric.json:107-110`）。
- lit-03：保留 `R1 protected-unchanged {"paths":["materials"]}`（`rubric.json:101-107`）。
- lit-04：`R1 protected-unchanged {"paths":["materials"]}`（`rubric.json:67-72`，由 draft/advisor 两个文件扩为全部材料）。

真实引擎四种情形（参考解 / 空输出 / 正常附加文字 / 篡改材料）：

| 情形 | 期望 | lit-01 | lit-02 | lit-03 | lit-04 |
|---|---|---|---|---|---|
| 参考解（只写 deliverables） | protected 通过、整体通过 | pass，violations=0 | pass，0 | pass，0 | pass，0 |
| 空输出（无交付物） | protected 通过、整体 FAIL | FAIL，viol=R1,R2（**无 R3**） | FAIL，R1,R2（无 R3） | FAIL，viol=[]（R1 pass） | FAIL，R2,R3（**无 R1 protected**） |
| 正常附加一句无引号文字 | 整体通过 | pass | pass | —（CSV 场景不适用） | pass |
| 篡改 materials | protected 违规、整体 FAIL | FAIL（R3） | FAIL（R3） | FAIL（R1） | FAIL（R1） |

结论：**新增/扩围的 protected 规则不会误伤正常解、空输出或附加说明文字；只对“修改 materials 文件”判违规**，并且和 runner 的“protected 快照在 restore/stage 之前比较”语义一致（[run.mjs:454-470](scripts/golden/run.mjs#L454-L470)；本次参考解经 staging 后 R3 仍通过，说明 staging 出的 `_verify`/`verify` 不会被算进 `materials`）。

---

## 4. 仍未关闭 / 新发现的问题

### 4.1 P1-A（新引入，必须修）：lit-03 objective 仍写“共至少 12 行”，rubric 已固定 36 行

- objective：`eval/golden/cases/lit-03-data-extraction/case.json:6` 第 2 条：“每个（模型，数据集，指标）组合写一行，**共至少 12 行**”。
- rubric：`eval/golden/cases/lit-03-data-extraction/rubric.json:21-25` 已改为 `"minRows": 36, "maxRows": 36`。
- 后果：一个“只抽 12–35 个合法行、且抽查的 6 个单元格都正确”的解，按 objective 是合规的，但 M3（w2）失败 → 最高 0.8182（W=11）<0.95 → 判不合格（实测“删 1 行（35 行）”= 0.8182 不合格）。这会把**合法解误判为失败**，与 task-5 修复建议“objective 改为完整 36 行”不一致（只改了 rubric，未改 objective）。
- 同批陈旧文本（不影响评分，但会误导人工复核）：
  - `case.json:20` 的 `notes` 已写“参考交付物为 36 行 CSV”，与 objective 的“≥12”自相矛盾；
  - `verify/README.md:9`、`:33` 仍写“共 ≥12 行”“M3 数据行 ≥ 12”，`:69` 仍展示旧自检输出“要求 12..∞”。
- 建议（二选一，推荐前者）：把 `case.json:6` 第 2 条改为“**完整 36 行（每篇论文 12 行：6 个模型-数据集组合 × 2 个指标）**，不得只抽取部分行”，并同步 `verify/README.md:9,33,69`；或把 M3 恢复为 `minRows:12` 并把“完整性”交给 command/H（不推荐，会重开 task-5 P1-5 的行数缺口）。

### 4.2 P2-B（文档陈旧，建议随 P1-A 一起修）：4 个 Lit 例的 `verify/README.md` 未随 rubric 更新

| 文件:行 | 现内容 | 应为 |
|---|---|---|
| `lit-01/verify/README.md:25` | passThreshold = 0.9 | 0.95 |
| `lit-01/verify/README.md:43-45` | 只列 R1/R2 两条规则 | 新增 R3 protected（全文 3 条规则）；`:95` “2 条规则”应改 3 |
| `lit-02/verify/README.md:27,43-44,85` | passThreshold 0.9；只列 R1/R2 | 0.95；补 R3 protected（3 条规则） |
| `lit-03/verify/README.md:27,33,69,90` | passThreshold 0.9；M3 ≥12；旧输出“要求 12..∞” | 0.95；M3 固定 36；输出改为 36..36 |
| `lit-04/verify/README.md:33,47` | passThreshold 0.9；R1 只保护 draft/advisor | 0.95；R1 paths=["materials"] |

（README 更新于 15:27，早于 rubric 修复 15:33；本次自检脚本实际输出已显示规则数变化：lit-01 “8 项 + 3 条规则”、lit-04 “6 项 + 3 条规则”。）

### 4.3 P2-C（机械残留，可接受但应知情）：lit-03 固定 36 行只关闭“行数漂移”，不关闭“同基数替换”

- 实测：删 1 个合法行 + 追加 1 行论文表 3 的消融行，仍 36 行 → 真实引擎 score **1.0，passed=true**（H1 pending）；H1 判 false 时 0.9167 不合格、H1=true 时 1.0 通过。
- 原因：M4–M9 只抽查 6/36 个单元格（`rubric.json:27-91`），M3 只锁数量；内容完整性依赖 H1（`rubric.json:93-99`，权重 1，现已被 0.95 阈值绑定）。
- 影响可控：只要人工项 **必须** 在基线评分时补评（不能长期 humanPending 计 passRate），该残留即被兜住；若希望机械关闭，建议增加 held-out `command`：从 materials 解析表 2 的 36 个 (paper,model,dataset,metric,value) 元组，与提交 CSV 做集合相等比较（可直接复用 task-5 复核脚本的解析逻辑）。
- 另注：`humanPending` 时 score 分母不含 H，故“基线 passRate”若在人工补评前统计，同基数替换仍会计为合格；阶段 0 门槛要求“评分标准经人工复核”，建议基线运行流程明确规定 human.json 必须在汇总前填写（设计文档 §4 已写“人工项全部补评后重算”）。

### 4.4 未变化的 P2（沿用 task-5 §6，不算回归）

- citation-sources 对“强调引号”偏严：lit-01 追加“综合比较五篇材料的主要差异”这类 ≥10 字中文引号句仍判 R1 违规（pass=false）。objective 已要求引号只用于逐字引用，属契约一致行为。
- lit-01 的“表头必须恰好/每行 ≥2 数值”仍未机械校验；由 H1 兜底。
- 自带自检脚本（lit 4 例 `verify/check-rubric.mjs`，哈希 `25526F9E00F91479`）未随修复更新，但其“参考解 100% / 空输出失败 / 篡改 protected 负例”逻辑仍与当前 rubric 一致（4 例 exit 0）。

---

## 5. Lit 4 例基线准入结论

| 样例 | 当前结论 | 进入基线的条件 |
|---|---|---|
| lit-01 | **可候选**（P0-1/P0-2 关闭；无新问题） | 建议顺手更新 `verify/README.md`（P2-B） |
| lit-02 | **可候选**（P0-1/P0-2 关闭；无新问题） | 同上 |
| lit-03 | **待修 P1-A 后可候选**（行数缺口已关闭，但 objective 与 rubric 不一致，存在假阴性） | 改 `case.json:6` 与 `verify/README.md` 为“完整 36 行”；可选加同基数替换的 command（P2-C） |
| lit-04 | **可候选**（P0-1/P0-2 关闭，保护扩围生效） | 同上 README |

即：**P0-1、P0-2 对 Lit 4/4 已关闭；lit-03 的 P1-5 对“行数漂移”已关闭，但对“同基数替换”只是靠 H1 兜底，且引入了 objective/rubric 不一致（P1-A）——修掉 P1-A 后 4/4 均可作为阶段 0 基线候选。**

---

## 6. Data/Report 5 例当前状态（修复中，本轮不评分）

记录时间 15:37–15:39；作者正在工作区修改（未提交），**尚未验证**，等 Lead 通知后跑同一套回归。当前状态：

| 样例 | 已修改文件（`git status` M） | 新增 held-out 脚本（untracked） | 备注 |
|---|---|---|---|
| data-01 | `case.json`、`rubric.json`、`verify/check-rubric.py` | `verify/stage/check-chart.mjs`（15:36:02） | rubric mtime 15:37:14 |
| data-02 | `case.json`、`rubric.json` | `verify/stage/check-quality.mjs`（15:36:02） | rubric 15:37:14 |
| data-03 | `case.json`、`rubric.json` | `verify/stage/check-report.mjs`（15:36:18） | rubric 15:37:22 |
| report-01 | `case.json`、`rubric.json`、**`workspace/materials/metrics.csv`** | `verify/stage/check-report.mjs`（15:36:18） | **材料时间线疑似在修**（metrics.csv mtime 15:37:39）；project-brief.md 未改 |
| report-02 | `case.json`、`rubric.json` | `verify/stage/check-minutes.mjs`（15:36:27） | rubric 15:37:22 |

当前工作区快照（哈希前 16 位，供修复完成后对比）：

| 样例 | case.json | rubric.json | 新增 stage 脚本 |
|---|---|---|---|
| data-01 | `a6363d1936c5324c` | `9bb2506f628ef85b` | check-chart.mjs `d8a19d5294541cd9` |
| data-02 | `f49fb2520763d95c` | `8addb708a52228b6` | check-quality.mjs `daa9c6ab1a830ac5` |
| data-03 | `ffe5918bf65d9aa2` | `94312aba5e3f7b31` | check-report.mjs `f454ae81d80fc546` |
| report-01 | `61f11fc6bcba7df6` | `bf361178ef50455f` | check-report.mjs `46ef33b5602ca55c` |
| report-02 | `65f2959ea6d8c0bc` | `6b963e103d6de81b` | check-minutes.mjs `bdc0fc5bad84c183` |

当前树用官方 `cases.mjs::loadCases` 加载 10 例均无 schema 错误；已可见 5 例都改成 `passThreshold=0.95` 且都已有 `protected-unchanged: ["materials"]`（从加载结果读出），说明修复方向与 Lit 一致。**这些内容仍在变动（mtime 15:36–15:37），本轮不评分**；待修复提交/Lead 通知后，我将对 5 例跑同一套回归（重点：P0-1 单检查失败、P0-2 篡改 materials、report-01 P0-3 材料时间线、新增 command/H 是否误伤参考解、空输出是否仍 fail、新增 held-out 脚本的误伤与覆盖）。

---

## 7. 复核环境与快照

- 引擎：`scripts/golden/score.mjs` = `4E2893B74043DEA7`（与 task-5 相同）、`cases.mjs` = `5B90CBDADB3073B1`；runner 侧本次新增 `compare.mjs`（commit `8c2256f`）不影响单样例评分。
- Lit rubric 哈希（新）：lit-01 `7b6e29ed9625ed5e`、lit-02 `f4260b3086350bfe`、lit-03 `45b9086755ae9094`、lit-04 `eb93938f95f904f7`；case.json 未变（`058661353faa24aa`/`ca18d5ba8374dfb1`/`bcd08229c6ff8165`/`ec64705ac8cb2968`，与 task-5 相同）。
- 参考解未变（comparison `3d6a4b015f627844`、review `70184cee0410dd10`、extracted `d1287acf88936d7c`、revised `e0b05e2e9eb87b79`）。
- 执行：临时 harness（同 task-5，新增 `--human` 注入）跑 4 例 × {reference, empty} + 26 组变异（含 task-5 的 10 个 Lit 变异与 16 个新变异/补评情形）；4 例自带 `node verify/check-rubric.mjs` 均 exit 0。只在系统临时目录写中间产物，未改仓库。
- 只读声明：本轮未修改任何样例/脚本/源码，仅新增本文档；未 git commit。

---

## 8. Data/Report 5 例修复回归（task-8 第二部分）

状态更新：Lead 已在 commit `0d3d862`（`fix(eval): close rubric safety gaps in golden cases`）提交 Data/Report 5 例修复，工作区干净（HEAD=`0d3d862`）。本轮按与 Lit 相同的方法（真实 `scripts/golden/score.mjs` + `cases.mjs`，参考解/空输出/独立变异/held-out command）复核。**同一提交还修正了 lit-03 的 objective**（`case.json:6` 已改为“共 36 行（每篇论文表 2 的 6 行 × 2 个指标）”），因此前文 §4.1 的 P1-A 已关闭；lit-03 仅剩 `verify/README.md:33,69` 两行陈旧（仍写“M3 数据行 ≥ 12 / 要求 12..∞”）。

### 8.1 逐例关闭结论

| 样例 | P0-1 权重/阈值 | P0-2 materials 保护 | P0-3 | command/H 误伤参考解 | 空输出 | 结论 |
|---|---|---|---|---|---|---|
| data-01 | **已关闭** | **已关闭** | — | 无（reference 1.0、C01 exit 0） | fail | 见 §8.8（附 P1 建议） |
| data-02 | **已关闭** | **已关闭** | — | 无 | fail | 见 §8.8（附 P1 建议） |
| data-03 | **已关闭** | **已关闭** | — | 无 | fail | 见 §8.8（附 P1 建议） |
| report-01 | **已关闭** | **已关闭** | **已关闭**（材料时间线自洽 + held-out 能拦漂移） | 无 | fail | **可候选**（P2 残留） |
| report-02 | **已关闭** | **已关闭** | — | 无 | fail | **可候选**（P2 残留） |

修复内容（本轮核对）：5 例 `passThreshold` 均 0.95；核心 `csv-cell/csv-rows` 权重提到 4；每例新增 held-out `command` C01（权重 4）与 `human` H01；`rules` 增加 `protected-unchanged ["materials"]`；report-01 新增 `grading.restore/stage`（`case.json:20`）并在 `notes` 记录 P0-3；各 `case.json:6` objective 同步写入了新增的机械约束（如 data-01 要求真实 PNG 且 600×400、report-01 首末周数值必须与标签同一句/行）。

### 8.2 P0-1 关闭证据（lead 指定的 9 类核心错误全部不合格）

用真实引擎在“参考解 + 变异”工作区上评分（阈值 0.95）：

| 变异（独立构造） | 样例 | score | passed | 失败项 | C01 exit |
|---|---|---:|---|---|---:|
| **两区域 total 互换**（华东 85528.13 ↔ 华北 53777.43） | data-01 | 0.8974 | **false** | M04,M08 | 0 |
| 单个区域 total 错（85528.13→85528.99） | data-01 | 0.9487 | **false** | M04 | 0 |
| **假 chart**（向 chart.png 追加非 PNG 文本） | data-01 | 0.9487 | **false** | C01 | 1 |
| 报告过短（删掉一段，CJK<190） | data-01 | 0.9487 | **false** | C01 | 1 |
| **merged.csv 只有 274 行** | data-02 | 0.8947 | **false** | M03,C01 | 1 |
| A/B/C 计数标签互换（8↔12） | data-02 | 0.9474 | **false** | C01 | 1 |
| 一个客户名错（周军→李四） | data-02 | 0.9474 | **false** | M05 | 0 |
| **月份标签互换**（2026-07↔2026-09） | data-03 | 0.7895 | **false** | C01 | 1 |
| **最大类别写错**（办公用品→市场推广） | data-03 | 0.7368 | **false** | M07,C01 | 1 |
| 类别合计错（63106.90→63106.91） | data-03 | 0.7895 | **false** | C01 | 1 |
| **首末周数值对调** | report-01 | 0.7647 | **false** | C01 | 1 |
| **少引用材料**（materials/metrics.csv→materials/metrics） | report-01 | 0.5882 | **false** | M03,C01 + R01 违规 | 1 |
| 删除全部中文引号（0 处引文） | report-01 | 0.7647 | **false** | C01 | 1 |
| **负责人-截止日期互换**（张伟↔陈曦） | report-02 | 0.7778 | **false** | C01 | 1 |
| **删光 3 条决定** | report-02 | 0.7778 | **false** | C01 | 1 |
| 删除全部中文引号（0 处引文） | report-02 | 0.7778 | **false** | C01 | 1 |

结论：task-5 变异清单在 Data/Report 5 例上**全部由“通过”翻转为“不合格”**（此前 data-01 两区域指标错 0.90 合格、data-02 274 行 0.9268 合格、data-03 月份互换 1.0 合格、report-01 首末周对调 1.0 合格、report-02 负责人互换/删决定 1.0 合格——均已关闭）。权重敏感度：W(pending)=78/76/19/17/18，允许失败权重=3.90/3.80/0.95/0.85/0.90，故 data-01/02 的核心权重 4 检查、data-03/report-01/02 的任一权重 1 检查单失败都会导致不合格。

### 8.3 P0-2 关闭证据（篡改 materials 全部触发 protected 违规）

| 样例 | 篡改对象 | 结果 |
|---|---|---|
| data-01 | materials/sales.csv 追加内容 | score=1.0，**passed=false**，violations=[R01] |
| data-02 | materials/orders.csv 追加内容 | score=1.0，**passed=false**，violations=[R01] |
| data-03 | materials/daily_ledger.csv 追加内容 | score=1.0，**passed=false**，violations=[R01] |
| report-01 | materials/metrics.csv 追加内容 | score=1.0，**passed=false**，violations=[R02] |
| report-02 | materials/attendees.md 追加内容 | score=1.0，**passed=false**，violations=[R02] |

对照正常解：5 例参考解 violations=0；空输出时 protected 规则通过（data 类 viol=[]；report 类仅 citation 规则违规，无 protected 违规）——**新增保护规则没有误伤只写 deliverables 的正常解或空输出**。

### 8.4 P0-3 关闭证据（report-01 材料时间线）

- 材料自洽（独立重算）：`metrics.csv:2-9` 共 8 行，W1..W8 的 week_start 为 `2026-08-10/08-17/08-24/08-31/09-07/09-14/09-21/09-28`（连续 7 天、首末 08-10→09-28），**全部落在 `project-brief.md:11` 所述“2026 年 7 月至 9 月”内**，且全部早于简报日期 `2026-10-08`（`project-brief.md:5`）；旧版本破坏性的 `2026-10-19` 已不存在。
- held-out 漂移拦截（直接执行 `verify/stage/check-report.mjs`，不经过 protected）：
  - 未修改参考工作区 → exit 0（`check-report: OK`）；
  - 把 W8 week_start 改到 `2026-10-05` → **exit 1**，stderr：`materials/metrics.csv week_start 2026-10-05 is outside the 2026-07..2026-09 grazing period stated in project-brief.md`；
  - 只留 7 周 → **exit 1**，stderr：`materials/metrics.csv has 7 data rows, expected 8`。
- 残留（P2-R5c）：held-out 只校验“材料”自洽，不校验报告文字里声称的灰度期间——直接给参考解追加“灰度期为 2026 年 10 月至 11 月”后 command 仍 exit 0。该点由 H01 兜底（report-01 的 H01 判 false 会导致不合格：16/17=0.9412<0.95，实测 passed=false）。

### 8.5 command / human 不误伤参考解、空输出仍 fail

- 参考解：5/5 `score=1.0, passed=true, violations=0`，C01 全部 exit 0（data-01 `check-chart: OK (…, 20483 bytes?)`、data-02 `check-quality: OK (275 rows …)`、data-03 `check-report: OK`、report-01 `check-report: OK`、report-02 `check-minutes: OK`）。
- 空输出：5/5 `passed=false`，C01 全部 exit 1（缺交付物）；data 类 protected 通过，report 类仅 citation 违规。
- 自带自检脚本独立运行：5/5 `SELF-CHECK OK`（阈值已显示 0.95，且都包含“篡改 materials → protected 违规”负例）。

### 8.6 独立复跑作者 negative-controls 与交叉验证

- 独立执行 `node eval/golden/cases/data-01-stats-chart/verify/negative-controls.mjs` → **NEGATIVE-CONTROL OK（exit 0）**。脚本共 28 个场景（5 个参考解 + 23 个负例，含 5 个 materials-tampered、5 个 empty、13 个变异），全部符合“reference 通过、其余失败”的期望。该脚本导入真实 `score.mjs`/`cases.mjs`/`v3-eval-ledger.protectedSnapshot`，不是作者自报结论。
- 我的独立变异（与作者脚本不同的构造，见 §8.2–8.4）与作者脚本结论一致；5 例自检、`loadCases` 10/10（独立执行）、我自写的 schema/recompute 检查器（0 problems）也全部一致。
- 数据重算未回退：data-01 16 个区域指标、data-02 275 行全量、data-03 月/环比/类别与 task-5 相同，无差异。

### 8.7 仍存在的 P1/P2 残留（带 文件:行）

**P1-R1（建议基线前修；影响 data-01/02/03）：H01 人工项不具判定力。** `H01` 权重 1，而 data-01 W=79、data-02 W=77、data-03 W=20；H01 判 false 时真实引擎分数分别为 `78/79=0.9873`、`76/77=0.9870`、`19/20=0.9500`——**均 ≥0.95，仍然合格**（`data-01/rubric.json:28`、`data-02/rubric.json:28`、`data-03/rubric.json:15`）。后果：图表语义、未抽样行、文字结论等只能靠人工判断的质量问题，人工判 false 也无法让样例不合格。建议：data-01/02 的 H01 权重提到 4（`>0.05×W`），data-03 提到 2；或接受“H01 仅作质量记录”并在基线报告中注明。

**P2-R2（data-01）：图表内容只校验“是合法 PNG 且 ≥600×400”。** `verify/stage/check-chart.mjs:20-44` 校验签名/IHDR/IDAT/IEND/尺寸，不校验图形内容；实测把 chart.png 换成一张**合法但内容错误**的 600×400 随机像素 PNG（721 KB）后仍 **1.0 合格**（M20 只查 size）。同理 `report.md` 只说“含 华东”即可（`check-chart.mjs:46-58`），实测把结论改成“销售额最高的区域是华南”但保留别处“华东”字样仍 **1.0 合格**。该缺陷与 P1-R1 叠加（H01 不能判不合格），建议至少把 `最高区域` 措辞改为正则断言（如 `销售额最高的区域是华东`）或提高 H01 权重。

**P2-R3（data-02）：未抽样行不校验。** `check-quality.mjs:78-94` 只校验列、275 行、order_id 唯一；数值正确性只有 M04–M18 的 15 个抽查单元格（rubric `:8-22`）。实测把未抽样订单 O0100 的 total_amount 改为 9999.99 后仍 **1.0 合格**（H01 问题不覆盖 merged.csv 数值）。建议 command 增加低成本不变量：每行 `total_amount == round(quantity*unit_price,2)`、日期正则、join 后名称/类别非空。

**P2-R4（data-03）：文字结论不校验。** `check-report.mjs:55-125` 只校验两张表的“标签↔数值”绑定；实测把正文“全季度金额最大的类别是办公用品”改成“差旅”、表格保持正确后仍 **1.0 合格**（M07/M08 命中表格中的字符串）。H01 问题覆盖“文字结论是否与表格数字吻合”，但受 P1-R1 影响不具判定力。

**P2-R5（report-01）：**
- (a) 风险条数未校验：objective（`case.json:6` 第 2 条）要求“风险部分至少 3 条并说明影响”，`check-report.mjs` 无风险计数；实测删掉 2 条风险（剩 2 条）后仍 **1.0 合格**（长度仍 ≥1200）。
- (b) 引文来源未限定访谈：objective 要求“至少 2 处访谈原话”，`check-report.mjs:94-105` 只要求“≥2 处 ≥10 字的 materials 引文”；引用简报而非访谈也可满足。
- (c) 报告文字里的灰度期间未校验（见 §8.4 残留）。
  以上三项目前均由 H01（report-01 的 H01 有判定力）或人工复核兜底，可列为 P2。

**P2-R6（report-02）：参会人白名单与会议元数据未校验。** `check-minutes.mjs:69-147` 只校验待办“负责人↔截止日期”、决定条数、引文；实测在纪要中加入“外部列席：李明”并把“总部 3 号会议室”改为“总部 9 号会议室”后仍 **1.0 合格**（M05 只看 6 个姓名存在、M06 只禁 5 个固定虚构名）。H01 问题含“是否虚构了参会人”，可兜底参会人；但**会议地点/时间不在 H01 问题内**，建议 command 增加“参会人集合 == attendees.md 名单”和“时间/地点与 transcript 一致”两项。

**P2-R7（lit-03 文档同步）：** `lit-03-data-extraction/verify/README.md:33` 仍写“M3 数据行 ≥ 12”、`:69` 仍展示旧输出“要求 12..∞”，而 rubric 已固定 36 行、objective 已改为“共 36 行”。仅文档陈旧，不影响评分；建议随下次提交更新。

**P2-R8（未变）：** citation-sources 对强调引号偏严、report-01/02 的 `minBytes` 与汉字口径差异等 task-5 已列 P2 未变化；本轮未发现新的 command 误伤（参考解全部通过）。

### 8.8 最终名单：9 个文本样例是否可进入阶段 0 基线

**结论：9/9 均可作为阶段 0 基线候选；P0-1、P0-2、P0-3 与 task-5 的 P1 变异缺口已全部关闭。** 按“是否有阻塞项”细分：

| 样例 | 进入基线 | 条件/残留 |
|---|---|---|
| lit-01 | **可** | 无阻塞（task-5 P2 已在 0d3d862 同步 README） |
| lit-02 | **可** | 无阻塞 |
| lit-03 | **可** | P1-A 已关闭；仅 P2-R7 两行 README 陈旧，建议顺手修 |
| lit-04 | **可** | 无阻塞 |
| report-01 | **可** | P2-R5(a)(b)(c)，H01 有判定力可兜底；建议后续补 command |
| report-02 | **可** | P2-R6，H01 部分兜底（地点/时间未覆盖）；建议后续补 command |
| data-01 | **可（附 P1-R1 建议）** | H01 权重不足，图表语义/最高区域措辞错误不会判不合格 |
| data-02 | **可（附 P1-R1 建议）** | H01 权重不足；未抽样行数值不校验（P2-R3） |
| data-03 | **可（附 P1-R1 建议）** | H01 恰在阈值上（19/20=0.95 通过）；文字结论错误不判不合格（P2-R4） |

即：**5 个无阻塞（lit-01/02/03/04、report-01）、另有 report-02 仅 P2、data-01/02/03 各带 1 条 P1 建议；若 Lead 要求“人工兜底必须能独立否决”作为基线硬条件，则 data-01/02/03 需先把 H01 权重调到 4/4/2（3 个样例），其余 6 个立即可以进入基线。**

### 8.9 Data/Report 复核快照（HEAD=`0d3d862`，只读）

| 样例 | case.json | rubric.json | stage 脚本（verify/stage/） |
|---|---|---|---|
| data-01 | `a6363d1936c5324c` | `9bb2506f628ef85b` | check-chart.mjs `5d4f9f83f7a1338b` |
| data-02 | `f49fb2520763d95c` | `8addb708a52228b6` | check-quality.mjs `249b327ec92912a8` |
| data-03 | `ffe5918bf65d9aa2` | `94312aba5e3f7b31` | check-report.mjs `f454ae81d80fc546` |
| report-01 | `61f11fc6bcba7df6` | `bf361178ef50455f` | check-report.mjs `1bad892f5e5b6bcc` |
| report-02 | `65f2959ea6d8c0bc` | `6b963e103d6de81b` | check-minutes.mjs `bdc0fc5bad84c183` |
| lit-03（本轮 objective 修复） | `a200f6c2e6199c7a` | `45b9086755ae9094` | — |
| 引擎 | — | — | score.mjs `4e2893b74043dea7`、cases.mjs `5b90cbdadb3073b1`（均未变） |

执行：5 例 × {reference, empty} + 21 组独立核心变异 + 6 组残留探针 + 5 组 H01=false 补评；直接执行 4 组 P0-3 drift 测试；独立复跑作者 negative-controls（28 场景）；5/5 自带自检；`loadCases` 10/10；自写 schema/recompute 检查 0 problems。全部中间产物在系统临时目录，未改仓库、未 git commit。
