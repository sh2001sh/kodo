# data-01-stats-chart 验收自检说明

## 样例内容

- `workspace/materials/sales.csv`：240 条区域销售记录（UTF-8、逗号分隔），表头 `order_id,region,month,sales_amount`；含 12 条 `sales_amount` 空洞和 2 条 `N/A` 文本，共 14 条无效行。
- `verify/reference/deliverables/`：参考交付物 `summary.csv`（4 行 / 190 B）、`chart.png`（PNG，20,483 B）、`report.md`（260 个中文字符 / 1,014 B）。
- `verify/gen-data.py`：生成材料 + 参考交付物 + 期望值。
- `verify/stage/check-chart.mjs`：held-out 验收脚本（`grading.stage` → `workspace/_verify/`，模型运行期不可见）。
- `verify/check-rubric.py`：自检脚本（reference / empty / tampered 三种模式）。
- `verify/expected-data-01.json`：期望值快照。

## 期望值来源（pandas 计算 + Decimal 交叉核对）

`gen-data.py` 用 `pandas.read_csv` 读取生成的 `sales.csv`，`pd.to_numeric(errors="coerce")` 剔除 14 条无效行后按 `region` 做 `groupby().agg(sum/mean/median/count)`；同时用 `Decimal` 精确计算同一批有效金额并逐区域断言四舍五入到分后一致。结果：

| region | total_sales | mean_sales | median_sales | order_count |
| --- | --- | --- | --- | --- |
| 华东 | 85528.13 | 1474.62 | 1496.62 | 58 |
| 华北 | 53777.43 | 995.88 | 1061.17 | 54 |
| 华南 | 42520.76 | 733.12 | 765.51 | 58 |
| 西部 | 29994.35 | 535.61 | 538.53 | 56 |

- 原始 240 行、无效 14 行、有效 226 行；四区域合计 211,820.67；`华东` 为最高区域。`order_count` 口径（有效行计数）在 objective 中写明，期望值唯一确定。

## P0/P1 硬化修复（独立 rubric 复核 2026-11-03 后）

- **P0-1 阈值与权重**：`passThreshold` 0.9 → **0.95**；16 条 `csv-cell` 与 `csv-rows` 权重提到 4。human 为 pending 时已计入权重 W=78，单个数值错误即 `74/78 = 0.9487 < 0.95` 不合格（不再出现“两个区域写错仍合格”）。
- **P0-2 材料保护**：`rules` 增加 `R01 protected-unchanged paths=["materials"]`，篡改/新增/删除材料文件判违规（直接不合格，与分数无关）。
- **P1-1 图表内容**：新增 held-out `command` C01（权重 4）执行 `_verify/check-chart.mjs`：校验 PNG 签名、IHDR、IDAT、文件以 IEND 结尾（追加非图片文本会被抓）、像素 ≥600×400；并校验 `report.md` 中文字符数在 190–330（objective 200–300 字 ±10%）、且写出最高区域 `华东`。
- **P1-2 报告长度**：由上一条 command 精确统计中文字符，替代仅 `minBytes:400` 的弱约束。
- **人工兜底**：新增 `H01`（weight 1）：图表与结论是否与 `summary.csv` 一致、是否编造数字。
- **grading**：显式声明 `grading.stage = verify/stage → _verify`，避免 runner 默认把整个 `verify/`（含参考解）stage 进评分工作区。

## 自检方法与结果

```powershell
python verify/gen-data.py        # 可重复生成材料与参考解（随机种子 20261103）
python verify/check-rubric.py    # 三种模式：reference / empty / tampered
```

`check-rubric.py` 镜像 `scripts/golden/run.mjs` 的评分流水线（保护快照 → grading stage → command → 评分），结果：

```
mode: reference  score=1.0000 threshold=0.95 passed=True  violations=0
                （22/22 check + C01 通过，R01 通过，H01 pending）
mode: empty      score=0.0000 passed=False（全部 check 失败，C01 exit 1）
mode: tampered   score=1.0000 passed=False violations=1（R01: modified materials/sales.csv）
SELF-CHECK OK
```

## 真实评分引擎负例矩阵（scripts/golden/score.mjs）

复现：`node eval/golden/cases/data-01-stats-chart/verify/negative-controls.mjs`（该脚本覆盖 5 个 data/report 样例的 reference/empty/篡改材料/全部变异场景，只读导入真实引擎，staging 只在系统临时目录）。

用真实引擎 + runner 语义（staged reference / empty / 变异）回归，每个变异都必须不合格：

| 场景 | passed | score | 失败项 |
| --- | --- | --- | --- |
| reference | true | 1.0000 | — |
| materials-tampered（P0-2） | false | 1.0000 | violation R01 |
| empty | false | 0.0000 | 全部 check |
| 两个区域 total 互换（P0-1） | false | 0.8974 | M04、M08 |
| chart.png 追加非图片文本（P1-1） | false | 0.9487 | C01 |
| report 缺最高区域（P1-2） | false | 0.9359 | M22、C01 |
| report 写成 1000+ 字（P1-2） | false | 0.9487 | C01 |

## 已知限制

- `chart.png` 只做 PNG 结构与尺寸校验，不比对图像内容（“是否按区域总额作图、可读性”由 H01 人工兜底）。
- human 项权重 1：本样例 W=78 较大，H01 判 false 时 78/79=0.987 仍可能合格；人工项主要用于语义兜底，不作为唯一否决项（报告类/data-03 的较小 W 下单个人工失败会不合格）。如需人工项独立否决，可把 H01 权重提到 ≥5。
- command 的中文字符区间允许 ±10% 容差，避免“字”的口径差异误伤。

## 与真实评分引擎的交叉验证

- reference：`passed=true score=1.0000`，22/22 check + R01 通过，H01 pending；empty：`passed=false score=0.0000`。
- `scripts/golden/cases.mjs` 的 `loadCase` 可成功加载本样例（case.json 含 `grading.stage`、rubric 含 command/protected-unchanged/human，均通过真实 schema 校验）。

## 依赖的评分引擎检查类型

`file-exists`、`file-contains`、`csv-columns`、`csv-rows`、`csv-cell`、`command`、`human`（checks）；`protected-unchanged`（rules）。`command` 需 runner 在 restore/stage 之后以 `cwd=workspace` 执行，node 缺失时回退 `process.execPath`（`run.mjs` 已实现）。
