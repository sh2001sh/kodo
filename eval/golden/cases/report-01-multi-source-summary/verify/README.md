# report-01-multi-source-summary 验收自检说明

## 样例内容

- `workspace/materials/`（4 份材料，共 7,029 B，自洽、无外部链接）：
  - `project-brief.md`（2,315 B）：2026-10-08 方案简报，含扩量范围、预算 80 万元、四项成功标准、里程碑、风险初判。
  - `interview-01.md`（2,337 B）：2026-10-14 访谈王琳（知识库、高峰等待 46 秒、沟通培训等，含原话摘录）。
  - `interview-02.md`（1,989 B）：2026-10-16 访谈陈昊（重复性问题 35%、新人上手六周、岗位担忧，含原话摘录）。
  - `metrics.csv`（388 B）：8 周灰度指标；**时间线已修复**：W1–W8 为 2026-08-10 至 2026-09-28，落在简报所述“2026 年 7 月至 9 月灰度期”内，且早于简报日期 2026-10-08（P0-3）。
- `verify/reference/deliverables/summary.md`：参考报告（5,238 B / 1,420 个中文字符 ≥ 1,200 字），含“结论”“证据”“风险”三部分。
- `verify/stage/check-report.mjs`：held-out 验收脚本（模型运行期不可见）。
- `verify/check-rubric.py`：自检脚本（reference / empty / tampered）。

## 材料与 rubric 的对应关系

| rubric 检查 | 材料出处 |
| --- | --- |
| 引用 `materials/project-brief.md` | 简报正文（时间/预算/成功标准/里程碑） |
| 引用 `materials/interview-01.md` | 王琳：知识库八个月未更新、高峰等待 46 秒 |
| 引用 `materials/interview-02.md` | 陈昊：重复性工单 35%、新人六周、岗位担忧 |
| 引用 `materials/metrics.csv` | 首周 52.4% / 末周 68.4%，CSAT 3.86 → 4.42 |
| 风险关键词“知识库”“合规” | 简报风险初判 + 两份访谈 |

关键指标：首周问题拦截率 52.4%、末周 68.4%（+16.0 个百分点）；CSAT 3.86 → 4.42；平均处理时长 418 → 317 秒（约 -24.2%）；周会话量 41,000 → 46,200；活跃坐席 118 → 128。简报成功标准为拦截率 ≥60%、CSAT ≥4.3、平均处理时长 ≤300 秒、无 P1 级数据合规事故，参考报告因此指出“317 秒距 300 秒目标还差 17 秒”。

## P0/P1 硬化修复（独立 rubric 复核 2026-11-03 后）

- **P0-3 材料时间线矛盾（已修）**：原先 `metrics.csv` 为 2026-08-31~2026-10-19，与简报日期 2026-10-08 及“7–9 月灰度”矛盾；现改为 2026-08-10~2026-09-28。rubric 期望值不受影响（无日期断言），但 held-out command 新增材料自洽校验：`metrics.csv` 必须 8 行、week_start 全部落在 2026-07~2026-09，防止后续改动再次漂移。
- **P0-1 阈值**：`passThreshold` 0.9 → **0.95**；human pending 时 W=17，任一检查失败即 `16/17 = 0.9412 < 0.95`（此前首末周对调/零引用仍 1.0 的问题已修复）。
- **P0-2 材料保护**：rules 增加 `R02 protected-unchanged paths=["materials"]`。
- **P1-6/P1-7 语义绑定**：新增 held-out `command` C01（权重 4）执行 `_verify/check-report.mjs`：
  1. `summary.md` ≥1200 个中文字符（精确统计，替代 minBytes 近似）；
  2. 必须引用全部 4 份材料，且引用的 `materials/...` 路径必须真实存在；
  3. ≥2 处 ≥10 字中文引号片段逐字可在材料中找到；
  4. 首周/末周数值与标签绑定：`52.4→首周`、`68.4→末周`、`3.86→首周`、`4.42→末周`（支持“首周/末周”表格列形式），数值对调会判不合格。
- **人工兜底**：新增 `H01`（weight 1）：结论/证据/风险与材料一致、数字与引文可逐条核对、无编造。
- **grading**：显式 `grading.stage = verify/stage → _verify`，避免默认把整个 `verify/` stage 进评分工作区。

## 自检方法与结果

```powershell
python verify/check-rubric.py
```

```
mode: reference  score=1.0000 threshold=0.95 passed=True violations=0（11/11 + C01 + R01/R02，H01 pending）
mode: empty      score=0.0000 passed=False violations=1（R01 deliverable 缺失）
mode: tampered   score=1.0000 passed=False violations=1（R02: modified materials/interview-01.md）
SELF-CHECK OK
```

## 真实评分引擎负例矩阵（scripts/golden/score.mjs）

复现：`node eval/golden/cases/data-01-stats-chart/verify/negative-controls.mjs`（跨 5 个 data/report 样例的负例脚本）。

| 场景 | passed | score | 失败项 |
| --- | --- | --- | --- |
| reference | true | 1.0000 | — |
| materials-tampered（P0-2） | false | 1.0000 | violation R02 |
| empty | false | 0.0000 | 全部 check + R01 |
| 首末周数值对调（P1-6） | false | 0.7647 | C01 |
| 删除全部中文引号（P1-7） | false | 0.7647 | C01 |
| 少引用一份材料（M03/R01） | false | 0.5882 | M03、C01、R01 |

## 已知限制

- 首末周绑定为启发式：优先最近前置标签（120 字符窗口），另支持 `| 指标 | 首周 | 末周 |` 表格列；如果模型用“从 52.4 升到 68.4”这类无标签的叙述，可能判不能绑定（objective 已要求数值与“首周/末周”标签写在一起）。
- citation-sources 对任意 ≥10 字中文引号片段做逐字校验（契约 §4.2）：报告中把引号用于强调可能被判违规；objective 已要求“引号只用于逐字引用”。
- human 项权重 1：W=17 时 H01 判 false → 16/18=0.889 不合格，可独立否决。

## 与真实评分引擎的交叉验证

- reference：`passed=true score=1.0000`，11/11 + R01/R02，H01 pending；empty：`passed=false score=0.0000`。
- `cases.mjs.loadCase` 加载成功（grading/rubric schema 通过）。

## 依赖的评分引擎检查类型

`file-exists`、`file-contains`、`command`、`human`（checks）；`citation-sources`、`protected-unchanged`（rules）。
