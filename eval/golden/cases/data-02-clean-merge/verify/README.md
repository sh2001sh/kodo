# data-02-clean-merge 验收自检说明

## 样例内容

- `workspace/materials/`：
  - `orders.csv`：320 条订单原始记录（15,248 B），含 order_id 空值、order_id 重复、日期格式混用、无效外键。
  - `customers.csv`：40 条客户主数据（1,243 B）。
  - `products.csv`：25 条商品主数据（912 B）。
- `verify/reference/deliverables/`：
  - `merged.csv`：275 行 × 10 列（20,451 B）
  - `data-quality.md`：数据质量说明（1,210 B）
- `verify/gen-data.py`：生成材料 + 参考流水线（清洗规则与 objective 完全一致）。
- `verify/expected-data-02.json`：期望计数与抽查行快照。
- `verify/check-rubric.py`：一次性自检脚本。

## 清洗规则与唯一确定的期望行数

objective 已把规则顺序写死，因此计数唯一：

1. 原始 **320** 行。
2. 剔除 order_id 空白的 **8** 行（A）。
3. 按 order_id 去重，保留 updated_at 最晚一行，移除 **12** 行（B）。
4. `order_date` 四种格式统一为 YYYY-MM-DD。
5. 剔除无效外键合计 **25** 行（C）：customer_id 缺失 9 + customer_id 不在主数据 5 = 14；product_id 缺失 7 + product_id 不在主数据 4 = 11。
6. 最终 **275** 行：320 = 8 + 12 + 25 + 275。

## 期望值来源（pandas 计算 + Decimal 交叉核对）

- 参考流水线在 `gen-data.py` 中用 pandas 实现；`order_date` 的手写解析器与 `pd.to_datetime(..., format="mixed", dayfirst=False)` 逐行断言一致（不一致即抛异常）。
- `total_amount = quantity × products.unit_price` 用 `Decimal` 计算并 `quantize(0.01)`；写出的 `merged.csv` 再读回逐行断言金额分位一致，行数断言为 275，且 order_id 唯一。
- rubric 抽查 5 个 order_id（覆盖 4 种日期格式 + 1 个“保留最新”去重用例）：

| order_id | order_date | customer_name | total_amount | 覆盖点 |
| --- | --- | --- | --- | --- |
| O0001 | 2026-01-11 | 周军 | 12274.00 | YYYY-MM-DD |
| O0002 | 2026-02-06 | 何平 | 7939.72 | MM/DD/YYYY |
| O0003 | 2026-01-14 | 朱霞 | 3682.24 | YYYYMMDD |
| O0008 | 2026-01-08 | 赵敏 | 3876.00 | YYYY/M/D |
| O0006 | 2026-03-05 | 陈强 | 23074.74 | updated_at 去重保留最新 |

O0006 的两条原始记录在 customer_id、order_date、quantity 上都不同，若实现成“保留第一条”会同时挂掉这 3 个抽查格。

## 自检方法与结果

```powershell
python verify/gen-data.py
python verify/check-rubric.py
```

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

- `csv-rows` 精确 275/275；`csv-columns` 校验 10 列表头顺序无要求但必须齐全。
- 15 条 `csv-cell`：5 行 × 3 字段（日期归一、客户名关联、金额计算），数值容差 0.01。
- `data-quality.md`：`file-contains all ["320","8","12","25","275"]` 核对五个关键行数，并要求出现“去重/重复”与“外键/关联”原因说明。

## 依赖的评分引擎检查类型

`file-exists`、`csv-columns`、`csv-rows`、`csv-cell`、`file-contains`（`all`/`any`/`none`）。
