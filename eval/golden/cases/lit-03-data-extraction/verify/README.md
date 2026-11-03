# lit-03-data-extraction 验收说明

## 1. 样例目标

模型阅读 `workspace/materials/` 下 3 篇中文检索方向论文，把每篇**正文第 4.3 小节的「表 2 主要结果」**
抽取为 `workspace/deliverables/extracted.csv`：

- 表头逐字为 `paper,model,dataset,metric,value`（UTF-8、英文逗号分隔）；
- 每个（模型，数据集，指标）组合一行，共 36 行（每篇论文表 2 的 6 行 × 2 个指标）；
- `paper` 列填材料文件名（如 `paper-1-retriever-bench.md`）；
- `model` / `dataset` / `metric` 列逐字照抄表 2 的单元格与指标表头；
- `value` 只写数值（不带 %、不带单位），精度与论文一致；
- 只抽「表 2 主要结果」，不得混入表 1、表 3 与附录表；不得修改素材。

## 2. 材料清单

| 材料文件 | 字节数 | 表 2 覆盖 | 指标列 |
|---|---:|---|---|
| `materials/paper-1-retriever-bench.md` | 7,580 | 3 模型 × 2 数据集 | nDCG@10、Recall@100 |
| `materials/paper-2-rerank.md` | 6,914 | 3 模型 × 2 数据集 | nDCG@10、MAP |
| `materials/paper-3-hybrid.md` | 6,818 | 3 模型 × 2 数据集 | Recall@50、MRR |
| **合计** | **21,312** | 36 个（模型，数据集，指标）组合 | 5 种指标 |

每篇论文均含标题/作者机构/年份/摘要/方法/数据统计表/表 2 主要结果/消融表/讨论/局限/参考文献/附录，
表 2 与摘要中的数值一致。

## 3. rubric 结构（`rubric.json`，passThreshold = 0.95）

| id | kind | weight | 检查内容 |
|---|---|---:|---|
| M1 | file-exists | 1 | `deliverables/extracted.csv` ≥ 400 字节 |
| M2 | csv-columns | 2 | 表头含 paper / model / dataset / metric / value |
| M3 | csv-rows | 2 | 数据行固定 36（每篇 6 行 × 2 指标） |
| M4 | csv-cell | 1 | paper-1 / BM25 / LongDoc-Write-test / nDCG@10 = 41.3（容差 0.01） |
| M5 | csv-cell | 1 | paper-1 / DenseRet-Aca / SciRet-zh / Recall@100 = 75.4 |
| M6 | csv-cell | 1 | paper-2 / Rerank-Aca / LongDoc-Write-test / MAP = 50.3 |
| M7 | csv-cell | 1 | paper-2 / Rerank-Aca-增强 / SciRet-zh / nDCG@10 = 55.2 |
| M8 | csv-cell | 1 | paper-3 / Hybrid-RRF / TechDoc-zh / MRR = 0.487（容差 0.0005） |
| M9 | csv-cell | 1 | paper-3 / DenseRet-Aca / SciRet-zh / Recall@50 = 71.8 |
| H1 | human | 1 | 抽取是否完整、无重复、无混入消融/附录表，且名称与数值与论文一致 |

规则：

- `R1 protected-unchanged paths=["materials"]`：素材文件被修改/新增/删除即违规。

## 4. 参考解

`verify/reference/deliverables/extracted.csv`：36 行，内容用脚本与 3 篇论文的表 2 逐格对照，
`missing=0, extra=0`（见下节自检第 4 项）。

## 5. 自检方法与结果

```powershell
cd E:\sh\Coding\agent-harness\eval\golden\cases\lit-03-data-extraction
node verify/check-rubric.mjs
```

`verify/check-rubric.mjs` 为独立实现的等价校验逻辑（不 import `scripts/golden`），流程：
校验元数据 → 统计材料 → 正例（种子 + 参考解）要求 score=1.0 / 无违规 → 负例（空输出）要求 passed=false
→ 若存在 protected-unchanged 规则，追加“篡改素材”负例要求触发违规。

实测输出（2026-11-03）：

```
材料数=3，总字节=21312
=== 参考解（verify/reference） ===
  M1 PASS  deliverables/extracted.csv 存在且 >= 400B
  M2 PASS  表头齐全：paper,model,dataset,metric,value
  M3 PASS  数据行 36（要求固定 36）
  M4..M9 PASS（6 个 csv-cell 抽查全部命中且数值一致）
  H1 PENDING
  R1 protected-unchanged PASS
  score=1.000 passed=true humanPending=true
=== 空输出 ===
  M1..M9 FAIL，score=0.000 passed=false
=== 受保护文件被篡改（负例） ===
  R1 VIOLATION（被修改 materials/paper-1-retriever-bench.md），passed=false
SELF-CHECK PASS
```

另外用一次性脚本把参考 CSV 与 3 篇论文的表 2 逐格比对：

```
paper rows expected(from materials tables)= 36 csv rows= 36
missing from csv: 0 []
extra in csv: 0 []
metric headers: [ 'nDCG@10', 'Recall@100', 'MAP', 'Recall@50', 'MRR' ]
```

结论：参考解 100% 通过 rubric 的 9 项机械检查与 1 条规则；空输出不通过；篡改素材触发违规。

## 6. 与真实评分引擎的交叉验证（2026-11-03）

评分引擎 `scripts/golden/` 落地后，用**真实引擎代码**（只读，不修改）做了两层交叉验证：

1. `scripts/golden/cases.mjs` 的 `loadCase()`：本样例 PASS（case.json / rubric.json 通过引擎 schema 校验）。
2. 用 `scripts/golden/score.mjs` 的 `evaluateRubric()`（含 runner 侧 protected 快照与 csv 检查）跑参考解与空输出：
   `[lit-03-data-extraction][reference] passed=true score=1.000 violations=none failedChecks=none`，
   `[lit-03-data-extraction][empty] passed=false score=0.000`。
3. 端到端离线冒烟：`node scripts/golden/run.mjs --dry --cases lit-03-data-extraction --repeat 1 --out .kodo/golden/lit-fixtures-dry`
   → `status=completed`，`polluted=false`，`smoke.ok=true`；dry provider 不做任务，passRate=0 符合预期。
4. 引擎最终版复跑 `evaluateRubric()`：仍为 `reference passed=true score=1.000 / empty passed=false score=0.000`，
   无语义差异。
