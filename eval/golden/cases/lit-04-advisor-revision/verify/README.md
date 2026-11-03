# lit-04-advisor-revision 验收说明

## 1. 样例目标

模型阅读 `workspace/materials/` 下的论文初稿与导师意见：

- `materials/draft.md`：待修改初稿（结构错序、摘要冗长、结论过度声称、无局限小节）；
- `materials/advisor-comments.md`：5 条可逐条核验的修改意见；
- `materials/paper-1-hier-rag.md`、`materials/paper-2-iterwrite.md`：初稿依据的两篇论文，用于核对数据与补引。

任务是在 `workspace/deliverables/revised.md` 写出修订稿，逐条落实 5 条意见，且**不得修改** draft 与意见文件。

## 2. 5 条意见与机械验收方式

| # | 意见 | 机械验收 |
|---|---|---|
| 1 | 补局限：新增「## 5 局限与未来工作」，用 `- ` 列表 ≥ 3 条具体局限 | M2 标题存在；M6 脚本检查列表项 ≥ 3、小节 ≥ 100 汉字 |
| 2 | 修正结论：IterWrite ROUGE-L 86.1 > 本文 84.7，仅引用准确率 92.3 > 90.8；不得再写“全面优于/显著优于” | M5 none 检查；M6 检查结论含“引用准确率”“ROUGE-L”“略低/低于”；M4 检查四个数值 |
| 3 | 补引 paper-2：引言与讨论都写完整路径 `materials/paper-2-iterwrite.md` | M3 路径存在；M6 分别检查引言与讨论小节；R2 citation-sources 校验路径真实与引文逐字 |
| 4 | 调整结构：按 摘要→1 引言→2 方法→3 实验→4 讨论→5 局限与未来工作→6 结论 重排，标题逐字一致 | M2 七个标题；M6 检查出现顺序严格递增 |
| 5 | 压缩摘要：≤ 180 个汉字（不含标题），保留方法 + 数据 + 两个关键数值 | M6 检查摘要小节汉字数在 [60, 180] |

## 3. 材料清单

| 材料文件 | 字节数 | 说明 |
|---|---:|---|
| `materials/draft.md` | 4,069 | 初稿（含表 1：Hier-RAG 84.7/92.3、IterWrite 86.1/90.8、Dense-RAG 78.9/84.7） |
| `materials/advisor-comments.md` | 1,688 | 5 条修改意见 |
| `materials/paper-1-hier-rag.md` | 9,641 | 数据与引文来源（“引用准确率达到 92.3%”等） |
| `materials/paper-2-iterwrite.md` | 8,978 | 补引来源（“延迟相对 Hier-RAG 增加 64%”等） |
| **合计** | **24,376** | 4 份 |

## 4. rubric 结构（`rubric.json`，passThreshold = 0.9）

| id | kind | weight | 检查内容 |
|---|---|---:|---|
| M1 | file-exists | 1 | `deliverables/revised.md` ≥ 3000 字节 |
| M2 | file-contains | 2 | 7 个规定章节标题全部存在 |
| M3 | file-contains | 2 | 含 `materials/paper-1-hier-rag.md` 与 `materials/paper-2-iterwrite.md` |
| M4 | file-contains | 2 | 4 个关键数值 84.7 / 92.3 / 86.1 / 90.8 全部出现 |
| M5 | file-contains | 1 | 不含“全面优于”“显著优于” |
| M6 | command | 2 | `node _verify/check-revision.mjs`：章节顺序、摘要字数、局限列表、结论措辞、引言/讨论补引 |
| H1 | human | 1 | 是否忠实保留原方法与数据、语言通顺、5 条意见真正落实 |

规则：

- `R1 protected-unchanged paths=["materials/draft.md","materials/advisor-comments.md"]`：两份文件被改即违规；
- `R2 citation-sources allowedRoots=["materials"] requireExcerpt=true`：引用路径必须真实，≥ 10 字引号片段必须逐字可查；
- `R3 file-contains none=["http://","https://"]`：禁止外部链接。

`M6` 的 held-out 脚本位于 `verify/stage/check-revision.mjs`，通过 `case.json.grading.stage`
在评分前复制到运行工作区 `_verify/`，模型运行期间不可见。

## 5. 参考解

`verify/reference/deliverables/revised.md`：7 个规定章节按顺序排列；摘要 123 汉字；
「局限与未来工作」4 条列表项；结论改为“引用准确率更高、ROUGE-L 略低”并给出 84.7/86.1/92.3/90.8；
引言与讨论各引用一次 `materials/paper-2-iterwrite.md`；两处逐字引文（“引用准确率达到 92.3%”、
“延迟相对 Hier-RAG 增加 64%”）均可在材料中逐字找到。

## 6. 自检方法与结果

```powershell
cd E:\sh\Coding\agent-harness\eval\golden\cases\lit-04-advisor-revision
node verify/check-rubric.mjs
```

`verify/check-rubric.mjs` 独立实现等价校验（不 import `scripts/golden`），流程：校验元数据 →
统计材料 → 正例（种子 + 参考解 + grading.stage）要求 score=1.0 且无违规 → 负例（空输出）passed=false
→ 篡改 `materials/draft.md` 负例要求触发 R1 违规。

实测输出（2026-11-03）：

```
材料数=4，总字节=24376
=== 参考解（verify/reference） ===
  M1 PASS  deliverables/revised.md 存在且 >= 3000B
  M2 PASS  包含关系满足（7 个标题）
  M3 PASS  包含关系满足（paper-1 / paper-2 路径）
  M4 PASS  包含关系满足（84.7 / 92.3 / 86.1 / 90.8）
  M5 PASS  包含关系满足（无“全面优于/显著优于”）
  M6 PASS  exit=0 输出：[PASS] 章节顺序正确；摘要 123 汉字（<=180）；局限小节 4 条列表项；结论已按要求修正；引言与讨论均引用 paper-2
  H1 PENDING
  R1 protected-unchanged PASS
  R2 citation-sources PASS
  R3 file-contains PASS
  score=1.000 passed=true humanPending=true
=== 空输出 ===
  M1..M6 FAIL，R2/R3 VIOLATION，score=0.000 passed=false
=== 受保护文件被篡改（负例） ===
  R1 VIOLATION（被修改 materials/draft.md），passed=false
SELF-CHECK PASS
```

结论：参考解 100% 通过 rubric 的 6 项机械检查与 3 条规则；空输出不通过；篡改受保护文件触发违规。

## 7. 与真实评分引擎的交叉验证（2026-11-03）

评分引擎 `scripts/golden/` 落地后，用**真实引擎代码**（只读，不修改）做了两层交叉验证：

1. `scripts/golden/cases.mjs` 的 `loadCase()`：本样例 PASS，`grading.stage` 被引擎正确解析为
   `[{from:"verify/stage", to:"_verify"}]`。
2. 用 `scripts/golden/score.mjs` 的 `evaluateRubric()`（含 runner 侧 protected 快照、grading.stage、
   command 执行）跑参考解与空输出：
   `[lit-04-advisor-revision][reference] passed=true score=1.000 violations=none failedChecks=none`，
   `[lit-04-advisor-revision][empty] passed=false score=0.000`。
3. 端到端离线冒烟：`node scripts/golden/run.mjs --dry --cases lit-04-advisor-revision --repeat 1 --out .kodo/golden/lit-fixtures-dry`
   → `status=completed`；report 中 `protected.ok=true`（R1 通过）、`grading.staged=[verify/stage→_verify]`、
   `commandResults.M6` 已执行（deliverable 缺失时按预期 exit=1）、`polluted=false`、`smoke.ok=true`。
4. 引擎最终版（含 citation-sources 修复与 §3.1 protected-unchanged 语义）复跑 `evaluateRubric()`：
   仍为 `reference passed=true score=1.000 / empty passed=false score=0.000`，无语义差异。
