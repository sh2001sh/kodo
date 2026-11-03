# lit-02-review-draft 验收说明

## 1. 样例目标

模型综合 `workspace/materials/` 下 6 份材料（5 篇研究论文 + 1 篇综述），在
`workspace/deliverables/review.md` 写一篇中文学术综述草稿：

- 正文（不含标题行与参考文献条目）800–1200 个汉字；
- 至少 4 个二级小节，且必须有一个标题含「研究空白」的二级小节（正文 ≥ 150 汉字，至少 3 条具体空白——条数由人工项复核）；
- ≥ 6 条真实引用，全部写成 `materials/...` 真实路径，6 份材料都被引用；
- 用《》引用论文标题时，标题必须逐字来自材料（不得编造标题）；
- 直接引用原文时必须逐字复制并用中文引号括起（≥ 10 字），不得改写；
- 禁止外部链接，关键数值与材料一致。

## 2. 材料清单

| 材料文件 | 字节数 | 内容概要 |
|---|---:|---|
| `materials/paper-1-hier-rag.md` | 9,641 | Hier-RAG（ROUGE-L 84.7 / 引用准确率 92.3） |
| `materials/paper-2-iterwrite.md` | 8,978 | IterWrite（ROUGE-L 86.1 / 引用准确率 90.8 / 平均 2.8 轮） |
| `materials/paper-3-longqa-bench.md` | 7,917 | LongQA-Aca 基准（2,400 题；4K 75.9% → 128K 49.8%） |
| `materials/paper-4-outline-write.md` | 8,039 | OutlineWrite（结构一致性 88.5） |
| `materials/paper-5-citeguard.md` | 7,629 | CiteGuard（精确率 94.6 / 不支持断言率 5.2） |
| `materials/paper-6-survey.md` | 9,838 | 同主题综述：方法分类、五个中文基准、五个研究空白 |
| **合计** | **52,042** | 6 篇，数值与摘要/结果表一致 |

## 3. rubric 结构（`rubric.json`，passThreshold = 0.9）

| id | kind | weight | 检查内容 |
|---|---|---:|---|
| M1 | file-exists | 1 | `deliverables/review.md` ≥ 2500 字节 |
| M2 | file-contains | 2 | 6 个真实 `materials/paper-*.md` 路径全部出现（≥ 6 条真实引用） |
| M3 | file-contains | 1 | 含「研究空白」 |
| M4 | file-contains | 2 | 含 Hier-RAG / IterWrite / OutlineWrite / CiteGuard / LongQA-Aca |
| M5 | file-contains | 1 | 关键数值 84.7、92.3、86.1、90.8、49.8 全部出现 |
| M6 | file-contains | 1 | 5 个基准名全部出现（LongDoc-Write / IterBench-500 / LongQA-Aca / WriteBench-zh / CiteBench-zh） |
| M7 | command | 2 | `node _verify/check-review.mjs`：篇幅、二级小节数、研究空白小节字数、《》标题真实性 |
| H1 | human | 1 | 综述是否准确概括 6 份材料且无事实错误 |
| H2 | human | 1 | 研究空白是否 ≥ 3 条且具体可操作 |

规则：

- `R1 citation-sources`：`materials/...` 路径必须真实存在；≥ 10 字的引号片段必须能在材料中逐字找到；
- `R2 file-contains none`：不得出现 `http://` / `https://`。

`M7` 的 held-out 脚本位于 `verify/stage/`，通过 `case.json.grading.stage` 在评分前复制到
运行工作区的 `_verify/`，模型运行期间不可见。

## 4. 参考解

`verify/reference/deliverables/review.md`：6 个二级小节、正文 950 汉字、研究空白小节 253 汉字、
6 条真实路径引用、5 个《》标题均可逐字溯源、3 处逐字引文。

## 5. 自检方法与结果

```powershell
cd E:\sh\Coding\agent-harness\eval\golden\cases\lit-02-review-draft
node verify/check-rubric.mjs
```

`verify/check-rubric.mjs` 为独立实现的等价校验逻辑（不 import `scripts/golden`），流程：
校验元数据 → 统计材料 → 正例（种子 + 参考解 + grading.stage）要求 score=1.0 / 无违规 →
负例（空输出）要求 passed=false。

实测输出（2026-11-03）：

```
材料数=6，总字节=52042
=== 参考解（verify/reference） ===
  M1 PASS  deliverables/review.md 存在且 >= 2500B
  M2 PASS  包含关系满足
  M3 PASS  包含关系满足
  M4 PASS  包含关系满足
  M5 PASS  包含关系满足
  M6 PASS  包含关系满足
  M7 PASS  exit=0 输出：[PASS] 正文汉字数=950（要求 800–1200）；二级小节=6；研究空白小节=200 汉字；《》标题 5 个均可在 materials 中逐字核对
  H1/H2 PENDING
  R1 PASS  R2 PASS
  score=1.000 passed=true humanPending=true
=== 空输出 ===
  M1..M7 FAIL、R1/R2 VIOLATION，score=0.000 passed=false
SELF-CHECK PASS
```

结论：参考解 100% 通过 rubric 的 7 项机械检查与 2 条规则；空输出不通过。

## 6. 与真实评分引擎的交叉验证（2026-11-03）

评分引擎 `scripts/golden/` 落地后，用**真实引擎代码**（只读，不修改）做了两层交叉验证：

1. `scripts/golden/cases.mjs` 的 `loadCase()`：本样例 PASS（case.json / rubric.json 通过引擎 schema 校验）。
2. 用 `scripts/golden/score.mjs` 的 `evaluateRubric()`（含 runner 侧 grading.stage、command 执行）跑参考解与空输出：
   `[lit-02-review-draft][reference] passed=true score=1.000 violations=none failedChecks=none`，
   `[lit-02-review-draft][empty] passed=false score=0.000`。
3. 端到端离线冒烟：`node scripts/golden/run.mjs --dry --cases lit-02-review-draft --repeat 1 --out .kodo/golden/lit-fixtures-dry`
   → `status=completed`，`polluted=false`，`smoke.ok=true`；dry provider 不做任务，passRate=0 符合预期。
4. 引擎最终版（含 citation-sources 路径终止符修复）复跑 `evaluateRubric()`：仍为
   `reference passed=true score=1.000 / empty passed=false score=0.000`，无语义差异。
