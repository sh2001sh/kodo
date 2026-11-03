# lit-01-comparison-table 验收说明

## 1. 样例目标

模型通读 `workspace/materials/` 下 5 篇中文论文（长上下文检索增强、学术写作辅助、引用忠实性主题），
在 `workspace/deliverables/comparison.md` 中产出一份对比报告：一张 6 列（论文/方法/数据集/样本量/主要指标/局限）
且不少于 5 个数据行的 Markdown 对比表，加一个不少于 300 个汉字的「综合结论」小节。

评分要点：表格结构与行数、从材料中精确提取的指标数值与样本量、引用来源必须是真实的 `materials/...` 路径、
引用原文片段必须能逐字核对、禁止外部链接、综合结论的篇幅与质量。

## 2. 材料清单

| 材料文件 | 字节数 | 内容概要 |
|---|---:|---|
| `materials/paper-1-hier-rag.md` | 9,641 | Hier-RAG：章节树 + 两阶段检索；LongDoc-Write（1,200 篇/28,000 段）；ROUGE-L 84.7、引用准确率 92.3 |
| `materials/paper-2-iterwrite.md` | 8,978 | IterWrite：检索—反思迭代；同一 LongDoc-Write 测试集；ROUGE-L 86.1、引用准确率 90.8 |
| `materials/paper-3-longqa-bench.md` | 7,917 | LongQA-Aca 基准：2,400 题；4K→128K 准确率 75.9→49.8 |
| `materials/paper-4-outline-write.md` | 8,039 | OutlineWrite：大纲驱动写作；WriteBench-zh 960 任务；结构一致性 88.5 |
| `materials/paper-5-citeguard.md` | 7,629 | CiteGuard：引用忠实性检测；CiteBench-zh 1,600 条；精确率 94.6 |
| **合计** | **42,204** | 5 篇，均含标题/作者机构/年份/摘要/方法/数据集与结果表/讨论/局限/参考文献 |

所有数值在「摘要」「结果表」「正文」三处互相一致（例：84.7、92.3、91.2 同时出现在 paper-1 摘要与表 2）。

## 3. rubric 结构（`rubric.json`，passThreshold = 0.95）

机械检查（checks，参与加权得分）：

| id | kind | weight | 检查内容 |
|---|---|---:|---|
| M1 | file-exists | 1 | `deliverables/comparison.md` ≥ 2000 字节 |
| M2 | markdown-table | 2 | 同一张表表头含 论文/方法/数据集/样本量/主要指标/局限，数据行 ≥ 5 |
| M3 | file-contains | 2 | 5 个真实 `materials/paper-*.md` 路径全部出现（引用真实） |
| M4 | file-contains | 2 | 6 个精确指标数值全部出现：84.7、92.3、86.1、90.8、88.5、94.6 |
| M5 | file-contains | 1 | 样本量 1,200（或 1200）出现 |
| M6 | file-contains | 1 | 引用断言条数 1,600（或 1600）出现 |
| M7 | file-contains | 1 | 含「综合结论」 |
| M8 | command | 1 | `node _verify/check-conclusion.mjs`：「综合结论」正文 ≥ 300 个汉字 |
| H1 | human | 1 | 对比表信息准确性 + 综合结论是否覆盖方法路线/数据规模/指标可比性/共同局限 |

规则（rules，违反即本次不合格）：

- `R1 citation-sources`：交付物中出现的每个 `materials/...` 路径必须真实存在；中文引号 / 英文双引号内
  ≥ 10 字的原文片段必须能在 `materials/` 某份来源中逐字找到（含标点）。
- `R2 file-contains`：交付物不得包含 `http://` 或 `https://`（禁止外部链接、编造外部文献）。
- `R3 protected-unchanged paths=["materials"]`：`materials/` 下任何文件被修改/新增/删除即违规。

`M8` 使用 `case.json.grading.stage`：评分前把 `verify/stage/` 复制到运行工作区的 `_verify/`，
held-out 脚本只在评分阶段出现，模型运行期间不可见。

## 4. 参考解

`verify/reference/deliverables/comparison.md`（5 行对比表 + 580 汉字的综合结论）。
自检脚本会把它覆盖到种子工作区，然后用独立实现的检查逻辑评分。

## 5. 自检方法与结果

自检脚本：`verify/check-rubric.mjs`（Node 标准库，不 import `scripts/golden`）。

```powershell
cd E:\sh\Coding\agent-harness\eval\golden\cases\lit-01-comparison-table
node verify/check-rubric.mjs
```

脚本做四件事：

1. 校验 `case.json` / `rubric.json` 结构（含 limits 默认值、objective 自包含、id 与目录名一致、UTF-8 无 BOM）；
2. 统计 materials 数量与字节，检查合法 UTF-8、无 BOM；
3. 正例：种子工作区 + 参考解 + grading.stage → 用等价逻辑逐项评分，要求全部机械检查通过、rules 无违规、score = 1.0；
4. 负例：只有种子工作区（空输出）→ 要求 `passed = false` 且至少一项失败/违规。

实测输出（2026-11-03）：

```
--- 2. workspace/materials 统计 ---
  材料数=5，总字节=42204
--- 3. 正例/负例评估 ---
=== 参考解（verify/reference） ===
  [check] M1 file-exists     w=1 PASS  deliverables/comparison.md 存在且 >= 2000B
  [check] M2 markdown-table  w=2 PASS  表头齐全，数据行 5 >= 5
  [check] M3 file-contains   w=2 PASS  包含关系满足
  [check] M4 file-contains   w=2 PASS  包含关系满足
  [check] M5 file-contains   w=1 PASS  包含关系满足
  [check] M6 file-contains   w=1 PASS  包含关系满足
  [check] M7 file-contains   w=1 PASS  包含关系满足
  [check] M8 command         w=1 PASS  exit=0 期望=0 输出：[PASS] 「综合结论」正文汉字数 = 580（要求 >= 300）
  [check] H1 human           w=1 PENDING（人工项，不计入分母）
  [rule ] R1 citation-sources PASS
  [rule ] R2 file-contains    PASS
  score=1.000 passed=true humanPending=true
=== 空输出（只有种子工作区） ===
  M1..M8 FAIL、R1/R2 VIOLATION，score=0.000 passed=false
SELF-CHECK PASS
```

结论：参考解 100% 通过 rubric 的 8 项机械检查与 2 条规则；空输出不通过。

## 6. 与真实评分引擎的交叉验证（2026-11-03）

评分引擎 `scripts/golden/` 落地后，用**真实引擎代码**（只读，不修改）做了两层交叉验证：

1. `scripts/golden/cases.mjs` 的 `loadCase()`：本样例 PASS（case.json / rubric.json 通过引擎 schema 校验）。
2. 用 `scripts/golden/score.mjs` 的 `evaluateRubric()`（含 runner 侧的 protected 快照、
   grading.stage、command 执行）跑参考解与空输出：
   `[lit-01-comparison-table][reference] passed=true score=1.000 violations=none failedChecks=none`，
   `[lit-01-comparison-table][empty] passed=false score=0.000`。
3. 端到端离线冒烟：`node scripts/golden/run.mjs --dry --cases lit-01-comparison-table --repeat 1 --out .kodo/golden/lit-fixtures-dry`
   → `status=completed`，`polluted=false`，`smoke.ok=true`；dry provider 不做任务，passRate=0 符合预期，
   说明样例在真实 runner 的 restore/stage/command/评分全链路上可运行、无基础设施错误。
4. 引擎最终版（含 citation-sources 路径终止符修复）复跑 `evaluateRubric()`：仍为
   `reference passed=true score=1.000 / empty passed=false score=0.000`，无语义差异。
