# data-03-periodic-report 验收自检说明

## 样例内容

- `workspace/materials/daily_ledger.csv`：180 条流水（6,511 B），覆盖 2026-07-01 至 2026-09-28 共 90 天、每天 2 条，列 `entry_id,date,category,amount`，5 个中文类别。
- `verify/reference/deliverables/monthly-report.md`：参考月报（878 B），含两张 Markdown 表和最大类别说明。
- `verify/gen-data.py`：生成材料 + 参考月报 + 期望值。
- `verify/expected-data-03.json`：期望值快照。
- `verify/check-rubric.py`：一次性自检脚本。

## 期望值来源（pandas 计算 + Decimal 交叉核对）

`gen-data.py` 用 pandas 按 `date[:7]` 分月、按 `category` 分组，用 `Decimal` 汇总并与 pandas 结果逐项断言一致；环比用 `Decimal` 计算并 `ROUND_HALF_UP` 保留两位小数，且脚本断言不存在“第三位小数为 5”的临界值（避免不同实现的舍入分歧）。结果：

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

- 全季度合计 322,156.96；行数 180、distinct 日期 90（脚本内断言）。
- objective 固定了数字格式：金额两位小数、不写千分位；环比两位小数带 %、正数不加 +、首月写 —。rubric 直接核对格式化后的字符串，因此不会出现“数值对但格式不同”的误判。

## 自检方法与结果

```powershell
python verify/gen-data.py
python verify/check-rubric.py
```

```
mode: reference  score=1.0000 threshold=0.9 passed=True  violations=0  (9/9 checks PASS)
mode: empty      score=0.0000 threshold=0.9 passed=False violations=0
SELF-CHECK OK
```

## 与真实评分引擎的交叉验证

除本目录的自检脚本外，已用 `scripts/golden/score.mjs` 的 `evaluateRubric`（注入 `readFile`/`listFiles`/`statFile`，staged reference/empty 工作区）对同一份 `rubric.json` 做回归：

- reference：`passed=true score=1.0000`，9/9 checks 通过，violations=0；
- empty：`passed=false score=0.0000`，0/9 checks 通过；
- `scripts/golden/cases.mjs` 的 `loadCase` 可成功加载本样例（case.json + rubric.json 通过真实 schema 校验）。

## rubric 要点

- `markdown-table` 两张：`月份|合计|环比` 至少 3 行；`类别|合计` 至少 5 行。
- `file-contains` 精确核对 3 个月合计字符串、2 个环比字符串、最大类别名及其合计 `96274.26`，以及首月环比 `—`。
- 月份文本固定为 `2026-07/08/09`，`file-contains` 同时校验三个月份字符串。

## 依赖的评分引擎检查类型

`file-exists`、`markdown-table`（`requiredHeaders`/`minRows`）、`file-contains`（`all`/`any`/`none`）。
