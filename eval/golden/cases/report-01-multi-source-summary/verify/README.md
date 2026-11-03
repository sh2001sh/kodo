# report-01-multi-source-summary 验收自检说明

## 样例内容

- `workspace/materials/`（4 份材料，共 7,029 B，均自洽、无外部链接）：
  - `project-brief.md`（2,315 B）：2026-10-08 方案简报，含扩量范围、预算 80 万元、四项成功标准、里程碑、风险初判。
  - `interview-01.md`（2,337 B）：2026-10-14 访谈客服运营负责人王琳，含知识库、高峰期等待 46 秒、沟通培训等观点与原话摘录。
  - `interview-02.md`（1,989 B）：2026-10-16 访谈一线客服组长陈昊，含重复性问题 35%、新人上手六周、岗位担忧等观点与原话摘录。
  - `metrics.csv`（388 B）：8 周灰度指标，列 `week,week_start,active_agents,conversations,deflection_rate,csat,avg_handle_seconds`。
- `verify/reference/deliverables/summary.md`：参考报告（5,238 B / 1,420 个中文字符 ≥ 1,200 字），含“结论”“证据”“风险”三部分。
- `verify/check-rubric.py`：一次性自检脚本。

## 材料与 rubric 的对应关系

| rubric 检查 | 材料出处 |
| --- | --- |
| 引用 `materials/project-brief.md` | 简报正文（时间/预算/成功标准/里程碑） |
| 引用 `materials/interview-01.md` | 王琳：知识库八个月未更新、高峰等待 46 秒 |
| 引用 `materials/interview-02.md` | 陈昊：重复性工单 35%、新人六周、岗位担忧 |
| 引用 `materials/metrics.csv` | 首周 52.4% / 末周 68.4%，CSAT 3.86 → 4.42 |
| 风险关键词“知识库”“合规” | 简报风险初判 + 两份访谈 |

关键指标（`metrics.csv`）交叉核对：首周问题拦截率 52.4%、末周 68.4%（+16.0 个百分点）；CSAT 3.86 → 4.42；平均处理时长 418 → 317 秒（约 -24.2%）；周会话量 41,000 → 46,200；活跃坐席 118 → 128。项目简报的成功标准为拦截率 ≥ 60%、CSAT ≥ 4.3、平均处理时长 ≤ 300 秒、无 P1 级数据合规事故，因此参考报告指出“时长 317 秒距 300 秒目标还差 17 秒”。

## 引用真实性（rubric rule R01）

参考报告包含 4 处中文引号逐字引用，全部可在材料中逐字找到：

- “知识库最近一次更新已经是八个月前” → interview-01.md
- “重复性问题大约占工单量的 35%，新人上手周期需要六周” → interview-02.md
- “每条推荐答案都要能点开原始知识条目” → interview-02.md
- “一线同事最担心的是系统替我们把活干了，岗位就这么没了” → interview-02.md

`citation-sources` 规则（`allowedRoots=["materials"]`, `requireExcerpt=true`）会：① 校验报告里出现的每个 `materials/...` 路径真实存在；② 校验所有 ≥10 字的引号片段都能在材料中逐字找到。objective 已明确要求“引用原话用中文引号逐字摘录、来源写成 materials/<文件名>”，参考报告用反引号标注路径，避免路径文本被当成引用片段。

## 自检方法与结果

```powershell
python verify/check-rubric.py
```

```
mode: reference  score=1.0000 threshold=0.9 passed=True  violations=0  (11/11 checks PASS, R01 PASS)
mode: empty      score=0.0000 threshold=0.9 passed=False violations=1 (missing delivered summary.md)
SELF-CHECK OK
```

## 与真实评分引擎的交叉验证

除本目录的自检脚本外，已用 `scripts/golden/score.mjs` 的 `evaluateRubric`（注入 `readFile`/`listFiles`/`statFile`，staged reference/empty 工作区）对同一份 `rubric.json` 做回归：

- reference：`passed=true score=1.0000`，11/11 checks 通过，rule R01 通过，violations=0；
- empty：`passed=false score=0.0000`，0/11 checks 通过，R01 违规 1 条（deliverable 缺失）；
- `scripts/golden/cases.mjs` 的 `loadCase` 可成功加载本样例（case.json + rubric.json 通过真实 schema 校验）。

交叉验证过程中发现并上报了 `score.mjs` 的 `citation-sources` 两处路径提取缺陷（`match[2]` 空指针、顿号未作为路径终止符），已由评测引擎作者修复后回归通过；本样例的参考报告也把相邻来源路径用“与”/“，”分隔，避免依赖特定终止符实现。

## rubric 要点

- `file-exists minBytes=3500`：近似 1,200 中文字符（1,200 × 3 B ≈ 3,600 B）；契约没有“中文字符计数”检查类型，因此用字节下限近似，并在 objective 中明确“不少于 1200 字”。
- `file-contains` 校验三段标题、全部 4 份来源路径、首末周拦截率与 CSAT、风险关键词、两位受访者姓名。
- 空输出失败原因：`citation-sources` 规则在文件缺失时直接判违规。

## 依赖的评分引擎检查类型

`file-exists`、`file-contains`（`all`/`any`/`none`）、`citation-sources`（`allowedRoots`/`requireExcerpt`）。引擎需从 `“…”` 与 `"…"` 两种引号中提取 ≥10 字片段，并在 `allowedRoots` 下所有文本文件中做逐字查找。
