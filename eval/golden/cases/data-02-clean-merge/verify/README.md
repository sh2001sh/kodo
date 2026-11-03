# data-02-clean-merge 验收自检说明

## 样例内容

- `workspace/materials/`：`orders.csv`（320 行 / 15,248 B）、`customers.csv`（40 行 / 1,243 B）、`products.csv`（25 行 / 912 B）。
- `verify/reference/deliverables/`：`merged.csv`（275 行 × 10 列 / 20,451 B）、`data-quality.md`（1,210 B）。
- `verify/gen-data.py`：生成材料 + 参考流水线 + 期望值。
- `verify/stage/check-quality.mjs`：held-out 验收脚本（模型运行期不可见）。
- `verify/check-rubric.py`：自检脚本（reference / empty / tampered）。
- `verify/expected-data-02.json`：期望计数与抽查行快照。

## 清洗规则与唯一确定的期望行数

objective 已把规则顺序写死，因此计数唯一：原始 **320** 行 = order_id 空白 **8**（A）+ 去重移除 **12**（B）+ 无效外键 **25**（C：customer 14 + product 11）+ 最终 **275** 行。

## 期望值来源（pandas 计算 + Decimal 交叉核对）

- `gen-data.py` 用 pandas 实现参考流水线；`order_date` 手写解析器与 `pd.to_datetime(format="mixed")` 逐行断言一致；`total_amount` 用 `Decimal` 计算并 `quantize(0.01)`，写出的 `merged.csv` 再读回逐行断言分位一致、行数 275、order_id 唯一。
- rubric 抽查 5 个 order_id（覆盖 4 种日期格式 + 1 个“保留最新”去重用例）：

| order_id | order_date | customer_name | total_amount | 覆盖点 |
| --- | --- | --- | --- | --- |
| O0001 | 2026-01-11 | 周军 | 12274.00 | YYYY-MM-DD |
| O0002 | 2026-02-06 | 何平 | 7939.72 | MM/DD/YYYY |
| O0003 | 2026-01-14 | 朱霞 | 3682.24 | YYYYMMDD |
| O0008 | 2026-01-08 | 赵敏 | 3876.00 | YYYY/M/D |
| O0006 | 2026-03-05 | 陈强 | 23074.74 | updated_at 去重保留最新 |

O0006 的两条原始记录在 customer_id、order_date、quantity 上都不同；“保留第一条”的实现会同时挂掉这 3 个抽查格。

## P0/P1 硬化修复（独立 rubric 复核 2026-11-03 后）

- **P0-1 阈值与权重**：`passThreshold` 0.9 → **0.95**；`csv-rows` 权重 3→4、15 条 `csv-cell` 权重 2→4。human pending 时 W=76，少 1 行（M03 失败）`72/76 = 0.9474 < 0.95` 不合格。
- **P0-2 材料保护**：rules 增加 `R01 protected-unchanged paths=["materials"]`，篡改材料直接违规。
- **P1-3 计数标签绑定**：新增 held-out `command` C01（权重 4）执行 `_verify/check-quality.mjs`：① `merged.csv` 必须 10 列齐全、恰 275 数据行、order_id 唯一；② `data-quality.md` 的概览表（`项目|行数`）逐行绑定：原始→320、order_id 为空→8、重复→12、无效外键→25、最终→275；否则退回“标签与行数同一行”的逐行绑定。A/B/C 标签互换会判不合格。
- **人工兜底**：新增 `H01`（weight 1）：计数与实际行数/去重规则/无效外键处理是否一致、原因是否与数字写在一起。
- **grading**：显式 `grading.stage = verify/stage → _verify`，避免默认把整个 `verify/` stage 进评分工作区。

## 自检方法与结果

```powershell
python verify/gen-data.py
python verify/check-rubric.py
```

```
mode: reference  score=1.0000 threshold=0.95 passed=True violations=0（22/22 + C01 + R01，H01 pending）
mode: empty      score=0.0000 passed=False（全部 check 失败，C01 exit 1）
mode: tampered   score=1.0000 passed=False violations=1（R01: modified materials/customers.csv）
SELF-CHECK OK
```

## 真实评分引擎负例矩阵（scripts/golden/score.mjs）

复现：`node eval/golden/cases/data-01-stats-chart/verify/negative-controls.mjs`（跨 5 个 data/report 样例的负例脚本）。

| 场景 | passed | score | 失败项 |
| --- | --- | --- | --- |
| reference | true | 1.0000 | — |
| materials-tampered（P0-2） | false | 1.0000 | violation R01 |
| empty | false | 0.0000 | 全部 check |
| merged.csv 只有 274 行（P0-1） | false | 0.8947 | M03、C01 |
| data-quality A/B 计数标签互换（P1-3） | false | 0.9474 | C01 |

## 已知限制

- 计数绑定优先解析 `项目|行数` 概览表；若输出只用纯文字条目（无表格），则退回“标签与数字同一行”的逐行校验，理论上仍可能出现“另起一行复述数字”造成的弱绑定（参考解使用表格，负例已被抓住）。
- human 项权重 1：本样例 W=76，H01 判 false 时 76/77=0.987 仍可能合格；人工项作为语义兜底，不作唯一否决项。
- `data-quality.md` 之外不校验剔除原因的措辞（只校验数字与原因的对应关系）。

## 与真实评分引擎的交叉验证

- reference：`passed=true score=1.0000`，22/22 + R01，H01 pending；empty：`passed=false score=0.0000`。
- `cases.mjs.loadCase` 加载成功（grading/rubric schema 通过）。

## 依赖的评分引擎检查类型

`file-exists`、`csv-columns`、`csv-rows`、`csv-cell`、`file-contains`、`command`、`human`（checks）；`protected-unchanged`（rules）。
