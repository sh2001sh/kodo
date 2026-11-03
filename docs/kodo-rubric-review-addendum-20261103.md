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
