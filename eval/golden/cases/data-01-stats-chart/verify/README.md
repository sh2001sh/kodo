# data-01-stats-chart 验收自检说明

## 样例内容

- `workspace/materials/sales.csv`：240 条区域销售记录（UTF-8、逗号分隔），表头 `order_id,region,month,sales_amount`；含 12 条 `sales_amount` 空洞和 2 条 `N/A` 文本，共 14 条无效行。
- `verify/reference/deliverables/`：参考交付物
  - `summary.csv`：4 行（190 B），列 `region,total_sales,mean_sales,median_sales,order_count`
  - `chart.png`：matplotlib 柱状图（20,483 B）
  - `report.md`：260 个中文字符（1,014 B）
- `verify/gen-data.py`：生成材料 + 参考交付物，并计算全部期望值。
- `verify/expected-data-01.json`：期望值快照（供人工复核）。
- `verify/check-rubric.py`：一次性自检脚本（不提供给模型）。

## 期望值来源（pandas 计算 + Decimal 交叉核对）

`gen-data.py` 用 `pandas.read_csv` 读取生成的 `sales.csv`，`pd.to_numeric(errors="coerce")` 剔除 14 条无效行后，按 `region` 做 `groupby().agg(sum/mean/median/count)`；同时用 `Decimal` 对同一批有效金额做精确的合计、均值、中位数计算，逐区域断言两者四舍五入到分后完全一致（不一致会直接抛异常）。结果：

| region | total_sales | mean_sales | median_sales | order_count |
| --- | --- | --- | --- | --- |
| 华东 | 85528.13 | 1474.62 | 1496.62 | 58 |
| 华北 | 53777.43 | 995.88 | 1061.17 | 54 |
| 华南 | 42520.76 | 733.12 | 765.51 | 58 |
| 西部 | 29994.35 | 535.61 | 538.53 | 56 |

- 原始行 240，无效行 14（12 空 + 2 非数值），有效行 226；四区域合计 211,820.67，`华东` 为销售额最高区域。
- `order_count` 口径（有效行计数）与均值/中位数口径都在 objective 里写明，期望值唯一确定。

## 自检方法与结果

```powershell
# 在 case 目录下
python verify/gen-data.py        # 可重复生成材料与参考解（随机种子 20261103）
python verify/check-rubric.py    # 自检 reference 与 empty 两种情形
```

`check-rubric.py` 先把 `workspace/` 复制到临时目录，reference 模式再叠加 `verify/reference/`，empty 模式不叠加；然后按 `rubric.json` 逐项执行机械检查并校验 `case.json`/`rubric.json` 的 schema。结果：

```
mode: reference  score=1.0000 threshold=0.9 passed=True  violations=0  (22/22 checks PASS)
mode: empty      score=0.0000 threshold=0.9 passed=False violations=0
SELF-CHECK OK
```

## 与真实评分引擎的交叉验证

除本目录的自检脚本外，已用 `scripts/golden/score.mjs` 的 `evaluateRubric`（注入 `readFile`/`listFiles`/`statFile`，staged reference/empty 工作区）对同一份 `rubric.json` 做回归：

- reference：`passed=true score=1.0000`，22/22 checks 通过，violations=0；
- empty：`passed=false score=0.0000`，0/22 checks 通过；
- `scripts/golden/cases.mjs` 的 `loadCase` 可成功加载本样例（case.json + rubric.json 通过真实 schema 校验）。

## rubric 要点

- `csv-columns` 校验 5 列表头；`csv-rows` 精确锁定 4 行。
- 4 个区域 × 4 个指标共 16 条 `csv-cell`，数值容差 0.01，全部来自上表。
- `file-exists deliverables/chart.png minBytes=5000`：只检查文件存在且体积达标，**不比对图像内容**（图表由参考解用 matplotlib 生成，中文标签使用系统 Microsoft YaHei 字体）。
- `file-exists deliverables/report.md minBytes=400` + `file-contains ["华东"]`：短结论必须写出销售额最高区域。

## 依赖的评分引擎检查类型

`file-exists`（含 `minBytes`）、`csv-columns`、`csv-rows`、`csv-cell`（含 `where`/`expect`/`tolerance`）、`file-contains`（`all`/`any`/`none`）。
