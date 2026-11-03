# report-02-meeting-minutes 验收自检说明

## 样例内容

- `workspace/materials/`：
  - `meeting-transcript.md`（4,853 B，满足 ≥4KB）：2026-10-22 Q4「极光」智能客服助手扩量试点需求评审会逐字记录，含 6 位发言人、3 项决定、5 条待办与下次会议时间。
  - `attendees.md`（668 B）：6 位参会人名单（周明远、张伟、王琳、刘洋、陈曦、林可），并注明无列席人员。
- `verify/reference/deliverables/minutes.md`：参考会议纪要（2,032 B），含会议信息、3 条决定、5 行待办表格、关键讨论摘录、下次会议时间。
- `verify/check-rubric.py`：一次性自检脚本。

## 会议记录中的待办（rubric 抽查来源）

| 负责人 | 截止日期 | 事项 |
| --- | --- | --- |
| 张伟 | 2026-11-06 | 知识库检索接口性能优化方案（含压测结果与 P95 指标） |
| 陈曦 | 2026-11-10 | 更新 Q4 项目排期并同步渠道收敛决定 |
| 刘洋 | 2026-11-13 | 灰度发布测试计划（覆盖 5%/20%/50% 三阶段） |
| 王琳 | 2026-11-17 | 在线客服与工单高频问题清单及话术库初稿 |
| 林可 | 2026-11-20 | 更新工单界面原型（含相似问题推荐入口） |

决定 3 条（渠道收敛、检索性能列为扩量前置项 P95≤800ms、灰度 5%→20%→50% 且 CSAT<4.2 回滚）与下次会议时间 2026-11-24 14:00 均写在记录正文中；纪要必须逐条对应，不得改写负责人与日期。

## 引用真实性与“不虚构参会人”

- 参考纪要包含 2 处中文引号逐字引用（“检索慢的问题已经影响到在线客服的响应速度，必须先解决”“测试计划会覆盖 5%、20%、50% 三个阶段，每个阶段都要有回滚演练”），均可在 `meeting-transcript.md` 中逐字找到。
- `citation-sources` 规则校验纪要里 `materials/...` 路径真实存在、引号片段逐字可查。
- 参会人校验采用“正向白名单 + 反向黑名单”：`file-contains all` 要求 6 位真实参会人姓名都出现（会议信息要列全），`file-contains none` 禁止 5 个材料中不存在的人名（赵磊、孙倩、高翔、杨帆、何静）出现。这是机械可验证的近似，最终仍需人工核验纪要没有编造名单外人员；该事项已写入 `case.json.notes` 供出题复核。

## 自检方法与结果

```powershell
python verify/check-rubric.py
```

```
mode: reference  score=1.0000 threshold=0.9 passed=True  violations=0  (8/8 checks PASS, R01 PASS)
mode: empty      score=0.0000 threshold=0.9 passed=False violations=1 (missing delivered minutes.md)
SELF-CHECK OK
```

## 与真实评分引擎的交叉验证

除本目录的自检脚本外，已用 `scripts/golden/score.mjs` 的 `evaluateRubric`（注入 `readFile`/`listFiles`/`statFile`，staged reference/empty 工作区）对同一份 `rubric.json` 做回归：

- reference：`passed=true score=1.0000`，8/8 checks 通过，rule R01 通过，violations=0；
- empty：`passed=false score=0.0000`，0/8 checks 通过，R01 违规 1 条（deliverable 缺失）；
- `scripts/golden/cases.mjs` 的 `loadCase` 可成功加载本样例（case.json + rubric.json 通过真实 schema 校验）。

交叉验证过程中发现并上报了 `score.mjs` 的 `citation-sources` 两处路径提取缺陷（`match[2]` 空指针、顿号未作为路径终止符），已由评测引擎作者修复后回归通过；本样例的参考纪要把相邻来源路径用“，”分隔，避免依赖特定终止符实现。

## rubric 要点

- `markdown-table`：表头必须含“负责人/截止日期/事项”，至少 5 行数据；表格可以追加状态列，但三列必须存在。
- `file-contains` 精确核对 5 个 YYYY-MM-DD 截止日期、5 位负责人、6 位参会人、3 条决定的存在（“决定”关键词）、下次会议日期 2026-11-24。
- `file-contains none` 黑名单用于抓“凭空加参会人/发言人”这类典型错误。

## 依赖的评分引擎检查类型

`file-exists`、`markdown-table`（`requiredHeaders`/`minRows`）、`file-contains`（`all`/`any`/`none`）、`citation-sources`（`allowedRoots`/`requireExcerpt`）。
