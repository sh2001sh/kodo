# report-02-meeting-minutes 验收自检说明

## 样例内容

- `workspace/materials/`：
  - `meeting-transcript.md`（4,853 B ≥ 4KB）：2026-10-22 Q4「极光」智能客服助手扩量试点需求评审会逐字记录，含 6 位发言人、3 项决定、5 条待办与下次会议时间。
  - `attendees.md`（668 B）：6 位参会人名单（周明远、张伟、王琳、刘洋、陈曦、林可），注明无列席人员。
- `verify/reference/deliverables/minutes.md`：参考会议纪要（2,032 B），含会议信息、3 条决定、5 行待办表格、关键讨论摘录、下次会议时间。
- `verify/stage/check-minutes.mjs`：held-out 验收脚本（模型运行期不可见）。
- `verify/check-rubric.py`：自检脚本（reference / empty / tampered）。

## 会议记录中的待办（rubric 抽查来源）

| 负责人 | 截止日期 | 事项 |
| --- | --- | --- |
| 张伟 | 2026-11-06 | 知识库检索接口性能优化方案（含压测结果与 P95 指标） |
| 陈曦 | 2026-11-10 | 更新 Q4 项目排期并同步渠道收敛决定 |
| 刘洋 | 2026-11-13 | 灰度发布测试计划（覆盖 5%/20%/50% 三阶段） |
| 王琳 | 2026-11-17 | 在线客服与工单高频问题清单及话术库初稿 |
| 林可 | 2026-11-20 | 更新工单界面原型（含相似问题推荐入口） |

决定 3 条（渠道收敛、检索性能列为扩量前置项 P95≤800ms、灰度 5%→20%→50% 且 CSAT<4.2 回滚）与下次会议时间 2026-11-24 14:00 均写在记录正文中；纪要必须逐条对应，不得改写负责人与日期。

## P0/P1 硬化修复（独立 rubric 复核 2026-11-03 后）

- **P0-1 阈值**：`passThreshold` 0.9 → **0.95**；human pending 时 W=18，任一检查失败即 `17/18 = 0.9444 < 0.95`（此前负责人-日期互换、决定全删仍 1.0 的问题已修复）。
- **P0-2 材料保护**：rules 增加 `R02 protected-unchanged paths=["materials"]`。
- **P1-8/P1-9 语义绑定**：新增 held-out `command` C01（权重 4）执行 `_verify/check-minutes.mjs`：
  1. 解析 `负责人|截止日期|事项` 待办表，逐行校验 5 组“负责人→截止日期”绑定（互换会判不合格），事项列非空；
  2. 统计“决定”小节下的编号/项目符号条目数 ≥3（删光决定条目会判不合格）；
  3. 至少 1 处 ≥10 字中文引号片段可在材料中逐字找到。
- **人工兜底**：新增 `H01`（weight 1）：决定清单与待办表完整性、负责人-日期-事项一致性、是否虚构参会人、引文是否可核。
- **不虚构参会人**：仍保留正向白名单（6 位真实参会人必须出现）+ 反向黑名单（5 个材料外常见人名禁止出现）的机械近似。
- **grading**：显式 `grading.stage = verify/stage → _verify`，避免默认把整个 `verify/` stage 进评分工作区。

## 自检方法与结果

```powershell
python verify/check-rubric.py
```

```
mode: reference  score=1.0000 threshold=0.95 passed=True violations=0（8/8 + C01 + R01/R02，H01 pending）
mode: empty      score=0.0000 passed=False violations=1（R01 deliverable 缺失）
mode: tampered   score=1.0000 passed=False violations=1（R02: modified materials/attendees.md）
SELF-CHECK OK
```

## 真实评分引擎负例矩阵（scripts/golden/score.mjs）

复现：`node eval/golden/cases/data-01-stats-chart/verify/negative-controls.mjs`（跨 5 个 data/report 样例的负例脚本）。

| 场景 | passed | score | 失败项 |
| --- | --- | --- | --- |
| reference | true | 1.0000 | — |
| materials-tampered（P0-2） | false | 1.0000 | violation R02 |
| empty | false | 0.0000 | 全部 check + R01 |
| 张伟/陈曦 截止日期互换（P1-8） | false | 0.7778 | C01 |
| 删除全部 3 条决定（P1-9） | false | 0.7778 | C01 |

## 已知限制

- 决定条数的 command 启发式要求“决定”小节下使用编号或项目符号（objective 已明确要求）；若模型把决定写成段落而无列表，会判不能计数。
- 待办表要求表头含“负责人/截止日期”；表格可追加状态列（command 只按表头列名取值）。
- `citation-sources` 对 ≥10 字中文引号片段做逐字校验：引号误用为强调会被判违规（objective 已要求引号只用于逐字引用）。
- human 项权重 1：W=18 时 H01 判 false → 17/19=0.895 不合格，可独立否决。

## 与真实评分引擎的交叉验证

- reference：`passed=true score=1.0000`，8/8 + R01/R02，H01 pending；empty：`passed=false score=0.0000`。
- `cases.mjs.loadCase` 加载成功（grading/rubric schema 通过）。

## 依赖的评分引擎检查类型

`file-exists`、`markdown-table`、`file-contains`、`command`、`human`（checks）；`citation-sources`、`protected-unchanged`（rules）。
