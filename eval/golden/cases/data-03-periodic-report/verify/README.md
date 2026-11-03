# data-03-periodic-report 验收自检说明

## 样例内容

- `workspace/materials/daily_ledger.csv`：180 条流水（6,511 B），覆盖 2026-07-01 至 2026-09-28 共 90 天、每天 2 条，列 `entry_id,date,category,amount`，5 个中文类别。
- `verify/reference/deliverables/monthly-report.md`：参考月报（878 B），含两张 Markdown 表和最大类别说明。
- `verify/gen-data.py`：生成材料 + 参考月报 + 期望值。
- `verify/stage/check-report.mjs`：held-out 验收脚本（模型运行期不可见）。
- `verify/check-rubric.py`：自检脚本（reference / empty / tampered）。
- `verify/expected-data-03.json`：期望值快照。

## 期望值来源（pandas 计算 + Decimal 交叉核对）

`gen-data.py` 用 pandas 按 `date[:7]` 分月、按 `category` 分组，用 `Decimal` 汇总并与 pandas 结果逐项断言一致；环比用 `Decimal` 计算并 `ROUND_HALF_UP` 保留两位小数，且脚本断言不存在“第三位小数为 5”的临界值（避免不同实现的舍入分歧）。

| 月份 | 合计 | 环比 |
| --- | --- | --- |
| 2026-07 | 114325.16 | — |
| 2026-08 | 110368.29 | -3.46% |
| 2026-09 | 97463.51 | -11.69% |

| 类别 | 季度合计 |
| --- | --- |
| 办公用品 | 96274.26（最大类别） |
| 技术服务 | 75320.31 |
| 差旅 | 63106.90 |
| 市场推广 | 54236.13 |
| 其他 | 33219.36 |

- 全季度合计 322,156.96；行数 180、distinct 日期 90（脚本内断言）。objective 固定了数字格式（两位小数/不写千分位/环比带 %/首月 —），rubric 直接核对格式化后的字符串。

## P0/P1 硬化修复（独立 rubric 复核 2026-11-03 后）

- **P0-1 阈值**：`passThreshold` 0.9 → **0.95**。human pending 时 W=19，任一权重 1 的机械检查失败即 `18/19 = 0.9474 < 0.95` 不合格（此前最大类别写错 0.9333 仍合格的问题已修复）。
- **P0-2 材料保护**：rules 增加 `R01 protected-unchanged paths=["materials"]`，篡改材料直接违规。
- **P1-4 表格语义绑定**：新增 held-out `command` C01（权重 4）执行 `_verify/check-report.mjs`：解析 `月份|合计|环比` 表，逐行把月份标签绑定到期望合计与环比；解析 `类别|合计` 表，逐类别绑定期望合计。月份标签互换（数字仍在文中）会判不合格。
- **人工兜底**：新增 `H01`（weight 1）：月份/类别/合计/环比与流水是否一致、最大类别与文字结论是否吻合。
- **grading**：显式 `grading.stage = verify/stage → _verify`，避免默认把整个 `verify/` stage 进评分工作区。

## 自检方法与结果

```powershell
python verify/gen-data.py
python verify/check-rubric.py
```

```
mode: reference  score=1.0000 threshold=0.95 passed=True violations=0（9/9 + C01 + R01，H01 pending）
mode: empty      score=0.0000 passed=False（全部 check 失败，C01 exit 1）
mode: tampered   score=1.0000 passed=False violations=1（R01: modified materials/daily_ledger.csv）
SELF-CHECK OK
```

## 真实评分引擎负例矩阵（scripts/golden/score.mjs）

复现：`node eval/golden/cases/data-01-stats-chart/verify/negative-controls.mjs`（跨 5 个 data/report 样例的负例脚本）。

| 场景 | passed | score | 失败项 |
| --- | --- | --- | --- |
| reference | true | 1.0000 | — |
| materials-tampered（P0-2） | false | 1.0000 | violation R01 |
| empty | false | 0.0000 | 全部 check |
| 月份 2026-07/2026-09 标签互换（P1-4） | false | 0.7895 | C01 |
| 最大类别写错（P0-1） | false | 0.7368 | M07、C01 |

## 已知限制

- command 只校验两张表的标签-数值绑定与期望值；不校验表格样式（列宽、加粗等）。
- human 项权重 1：human 判 false 时 `19/20 = 0.95`，恰好达到阈值；如需人工项独立否决，可把 H01 权重提到 2。

## 与真实评分引擎的交叉验证

- reference：`passed=true score=1.0000`，9/9 + R01，H01 pending；empty：`passed=false score=0.0000`。
- `cases.mjs.loadCase` 加载成功（grading/rubric schema 通过）。

## 依赖的评分引擎检查类型

`file-exists`、`markdown-table`、`file-contains`、`command`、`human`（checks）；`protected-unchanged`（rules）。
