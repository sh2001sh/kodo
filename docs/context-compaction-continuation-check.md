# 最小真实续做检查（§9B）付费运行与独立审计（2026-10-24）

日期：2026-10-24。状态：**预注册付费运行已执行一次并按规则停止；结构预期未确认，不能报告为成功。** 任务 A 的验收/约束证据成立（verify 退 0、受保护文件未变、pager 使用冻结上限 37），但摘要安装出现确定性失败码 `SUMMARY_BUDGET`，触发预注册停止规则，任务 B 未运行；本目录没有任何重跑。

上游：[架构复核 §9B](context-compaction-architecture-review.md#b-再做极小的真实续做检查) · [投影契约 v2](context-compaction-contract.md) · [预注册协议](../scripts/comparison/continuation/README.md) · [runner](../scripts/comparison/compaction-continuation.mjs) · [独立审计脚本](../scripts/comparison/continuation-audit.mjs)。

后续执行方案：[v2.1 后续修正与实验方案](context-compaction-next-plan.md)。其中 P0 契约/判定/冻结和 E0 离线触发分析已完成，未修改本文的旧注册、原始结果或停止结论；P1 与新付费实验仍未执行。

## 1. 结论摘要

| 项目 | 结果 |
| --- | --- |
| 付费运行 | 执行 1 次（任务 A），任务生成 19 次模型调用，运行窗口 2026-10-24 02:09:28–02:13:41（本地 +08），runner 进程退出码 **2** |
| 结构判定（预注册） | **FAIL**：出现确定性摘要失败码 `SUMMARY_BUDGET`（3 次生成/修复正文超预算）；安装数 1 ≥ 预期 1、受保护文件未变、无 relay 拒绝、无模型/传输失败 |
| 停止规则 | **触发**：`stopped.json` 记录 `stoppedAfter=task-a`、`skippedTasks=[task-b]`、原因 `deterministic summary failure codes: SUMMARY_BUDGET`；未重跑 |
| 任务 B | **未运行**（预注册规则），没有任务 B 证据 |
| 任务 A 质量证据 | 独立复核：verify 退 0（27/27）、11 个受保护文件哈希未变、pager 从 `./legacy.js` 导入并使用 37；最终回答提到冻结上限（观察项） |
| 与 report.json 对账 | 独立审计发现 **0 个 material 差异、0 个 warning 差异** |
| 独立审计退出码 | **1**（结构预期未独立确认；质量失败单独记录） |
| 解释边界 | 这是**协议停止，不是语义成功**；两次任务不能支持可靠率/非劣效/语义收益/费用收益结论；不得把本次运行当作 v2.1 修复会通过的证据 |

## 2. 预注册与工作树状态

- 协议在付费前冻结：[`scripts/comparison/continuation/README.md`](../scripts/comparison/continuation/README.md)（两任务、每任务单次付费尝试、`expectedMinCompactions` A=1 / B=2、停止规则、解释边界）。
- 付费证据目录：`.kodo/continuation-paid-20261024-a/`（只读，不被本审计修改）。
- 独立审计输出：`.kodo/continuation-audit-20261023-181803/audit.json`（机器可读；只写入该目录与 OS 临时目录）。
- git 状态：HEAD `28a5cd7 first commit`；审计执行时 `git status --short` 共 **202 项 = 46 modified + 156 untracked**；写入本文档后为 46 modified + 157 untracked = 203 项。实验期间**没有** git commit/checkout/reset/stash。
- 代码时间线：付费运行使用的是运行前的 `dist/`；运行结束后（约 02:14–02:17，本地时间）工作树才加入 v2.1 正文硬上限修复（`src/runtime/summary-projection.ts`、`compaction.ts`、`summary-install.ts`、`dist/` 重建、`tests/summary-body-ceiling.test.ts`）。**该修复没有参与本次付费运行**，其测试结果由 Lead 另行报告，本次审计未运行这些测试。

## 3. 实际付费命令与预算

实际执行命令（Lead 确认为原始命令；输出同时 tee 到 `.kodo/continuation-paid-20261024-a.log`）：

```bash
node scripts/comparison/compaction-continuation.mjs --run --task both \
  --out .kodo/continuation-paid-20261024-a \
  --max-calls 64 --max-tokens 4000000
```

| 参数 | 值（来自 task 日志 / report / state） |
| --- | --- |
| 模式 | `--run`，任务 `task-a,task-b`，先跑 A |
| provider / model | `codego1` / `deepseek-v4.1-flash`（凭据来自 provider-config，未写入证据） |
| 预算 | `maxCalls=64`、`maxTokens=4000000`、`maxContextTokens=262144`、`maxOutputTokens=8192`、`workInputTokens=16384` |
| 其他 | `maxToolCalls=200`、`maxDurationMs=900000`、工具超时 120s；无重跑 |

## 4. 停止规则结果（预注册 §5）

- 任务 A 结束时 state 中出现 `SUMMARY_BUDGET`：3 次 `context.summary.failed` 与 3 次 `context.summary.repair.failed`，reason 均为 `SUMMARY_BUDGET: repaired summary exceeds its token budget`。
- `stopped.json`：`stoppedAfter=task-a`，`skippedTasks=["task-b"]`，`reasons=["deterministic summary failure codes: SUMMARY_BUDGET"]`，`createdAt=2026-10-23T18:13:41.867Z`；声明 “Registrations remain frozen. No paid rerun was performed.”
- `runner.json`：`passed=0/1`、`installedTotal=1`、`expectedMinCompactionsTotal=3`、`relayRequests=19`、`exitCode=2`、`passedAll=false`。
- 任务 B 因此**没有运行、没有付费、没有证据**；不得补跑同一注册来“获得安装”。

## 5. 任务 A 证据（独立重算）

运行：run id `07f2ec09-40fc-4cde-8754-e780ac13cc38`，status `completed`，无 `run.failed`/`run.interrupted`；事件 140 条，时间 02:09:28.172–02:13:41.611（本地 +08）。

| 证据项 | 独立结果 |
| --- | --- |
| 摘要事件 | started **4**、installed **1**、failed **3**、repair.started **3**、repair.failed **3**、repair.completed **0**、skipped **3**（原因均为 `projection budget leaves no room for a summary body`）、truncated 0、discarded 0、archived 4、context.compacted 0 |
| 安装数 vs 预注册 | installed **1** ≥ expectedMinCompactions **1** |
| 唯一成功安装 | marker **2,150** ≤ displayBudget **2,764**；plannedMarker 2,222；injectionActual 2,150；目录 12 来源 / 531 token；bodyActual **1,309** ≤ bodyTokens **1,310**；覆盖 12 条消息；before 29,678 → after 14,975（target 11,468，targetMet=false） |
| 受保护文件 | 11 个文件（verify.mjs、docs/*、src/legacy.js）：changed **0**、missing **0**、extra **0**；report.seed 哈希与冻结 fixture assets 一致 |
| 独立 verify（OS 临时副本） | exit **0**、无超时、stderr 空、stdout 与记录文件完全一致（27 行 `ok`，末行 `PASS: all 27 acceptance checks passed`），耗时约 206ms |
| 冻结约束 | pager 导入 `./legacy.js`=true，使用 `MAX_PAGE_SIZE`=true，无本地重定义；行为探针 `paginate(100 行, page 1, pageSize 1000)` 被钳制为 **37**；`docs/legacy-contract.md` 哈希未变（`12f1945d…`）；`src/legacy.js` 未变（`5abeca21…`）；post-run pager sha256 `34e4d0b4…` |
| 最终回答 | 2,262 字符，**提到冻结上限 37**（并提到 `MAX_PAGE_SIZE`/`PAGE_DEFAULT`）——按预注册只是观察项，不是通过条件 |
| 模型/工具调用 | model **19**（常规 12 + compaction 7），tool **17**（file.read 9、shell.exec 6、file.apply_patch 1、file.list 1），全部 succeeded |
| 用量（provider 实测，未知=0） | 常规调用 input **142,971** / output **2,786**；摘要调用 input **41,984** / output **39,818**；合计 input **184,955** / output **42,604**；cacheRead 合计 132,736（常规 116,352 + 摘要 16,384） |
| 会话/relay | sessionTokens **227,559**（`usageEstimated=false`）；relay **19** 请求、**227,559** tokens、**0** 拒绝、`estimated=false`；wire 19 请求 / 19 响应、全部流式、模型 deepseek-v4.1-flash |
| 模型/传输失败 | `model.failed` 事件 **0**；无 `MODEL_*` 错误；relay 未拒绝任何请求（relay call 记录中的 `CLIENT_ABORTED` 是响应完成后连接关闭的标注，19 条均有 HTTP 200、实测 usage 与 `[DONE]`，不是模型/传输失败） |

## 6. 根因：生成侧正文预算拒绝，不是投影/安装守卫

独立审计从 state DB 与模型响应原始正文重算了每次摘要尝试（`rawBodyTokens = estimateTextTokens(模型返回的摘要 JSON)`，与 `validSummaryResponse`/`repairSummary` 的检查对象一致）：

| 尝试 | 起始 seq | displayBudget | plannedMarker | fixed | directoryBudget | bodyTokens（首选） | 生成正文 tokens | 修复正文 tokens | repair.failed 记录 beforeTokens | 结果 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 54 | 2,764 | 2,222 | 360 | 552 | 1,310 | **1,309** ≤ 1,310 | — | — | 安装（marker 2,150） |
| 2 | 78 | 3,890 | 2,448 | 360 | 778 | 1,310 | **1,716** > 1,310 | 1,679 > 1,310 | 1,716 | SUMMARY_BUDGET |
| 3 | 95 | 3,581 | 2,386 | 360 | 716 | 1,310 | **1,816** > 1,310 | 1,700 > 1,310 | 1,816 | SUMMARY_BUDGET |
| 4 | 120 | 3,761 | 2,422 | 360 | 752 | 1,310 | **1,820** > 1,310 | 1,692 > 1,310 | 1,820 | SUMMARY_BUDGET |

- 6 次失败事件（3×`context.summary.failed` + 3×`context.summary.repair.failed`）全部落在 **generation-body-budget** 阶段（`displayBudgetGuardFailures=0`、`installGuardFailures=0`）：老代码在“正文超过首选 1,310”时就进入一次有界修复，而修复结果仍是 1,679/1,700/1,692 > 1,310，因此抛出 `SUMMARY_BUDGET`。
- **不是**投影/注入/安装守卫失败：唯一安装的 marker 2,150 ≤ display 2,764，`bodyActual 1,309 ≤ 1,310`；4 次 `started` 的 displayBudget（2,764/3,890/3,581/3,761）都足够容纳 plannedMarker（2,222/2,448/2,386/2,422）。
- 3 次 `context.summary.skipped`（“projection budget leaves no room for a summary body”，seq 31/42/68）是另一个独立机制投影预算不足，**不含** `SUMMARY_*` 失败码，也不属于确定性失败。
- 事后（运行结束后的零费用分析，非本次证据）：v2.1 把 display 推导的 **hardBodyTokens** 暴露为硬上限、把首选 1,310 降为建议值、只在超过硬上限时触发修复。按该边界复算，上述 3 次生成正文（1,716/1,816/1,820）低于各自推导硬上限（约 1,820/2,473/2,617），因此“可能不会触发修复”；但这只是修复后代码的预算边界分析，**不能声称 v2.1 会在本次任务上通过**——模型行为、任务 B、最终安装质量都未被本次付费运行观测，且本次证据在旧代码下冻结。

## 7. 独立审计 PASS/FAIL（原文，零费用）

审计脚本：`node scripts/comparison/continuation-audit.mjs --out .kodo/continuation-paid-20261024-a`（不调用模型/网络，不写证据目录）。

```text
=== task-a ===
PASS task-a structural:evidence-recorded — report.json, trace.jsonl, workspace, kodo.sqlite and verify outputs present, wire/relay.json present
PASS task-a structural:fixture-registration — expectedMinCompactions=1 (frozen README §2); fixture=1
PASS task-a structural:run-terminal-completed — status=completed runFailureEvents=0
PASS task-a structural:summary-installs — installed=1 started=4 failed=3 repairFailed=3 skipped=3 truncated=0 discarded=0 expected>=1
FAIL task-a structural:no-deterministic-summary-failures — SUMMARY_BUDGET (failure stages: generation-body-budget=3)
PASS task-a structural:protected-hashes-unchanged — 11 file(s) from report.seed.protectedHashes: changed=0 missing=0 extra=0
PASS task-a structural:no-model-transport-failures — transport=0 modelCompletion=0
PASS task-a structural:relay-budget-clean — requests=19 tokens=227559 rejected=none
PASS task-a structural:protected-baseline-frozen — report.seed agrees with fixture assets (11 file(s))
PASS task-a quality:independent-verify-exit-0 — independent verify exit=0 timedOut=false passClaim=true
PASS task-a quality:frozen-legacy-constraint-retained — importsLegacy=true usesMaxPageSize=true clamp=37(expected 37) docs/legacy-contract.mdHashUnchanged=true
PASS task-a quality:protected-hashes-unchanged — independent hash check: unchanged

=== task-b ===
INFO task-b status: not-run-stopped — not run: pre-registered stop rule after task-a (deterministic summary failure codes: SUMMARY_BUDGET)
FAIL task-b structural:evidence-recorded — not run: pre-registered stop rule after task-a (deterministic summary failure codes: SUMMARY_BUDGET)
FAIL task-b structural:run-terminal-completed — task was not run
FAIL task-b structural:summary-installs — task was not run
FAIL task-b structural:no-deterministic-summary-failures — task was not run
FAIL task-b structural:protected-hashes-unchanged — task was not run
FAIL task-b structural:no-model-transport-failures — task was not run
FAIL task-b structural:relay-budget-clean — task was not run

AUDIT STOP-RULE: triggered: stopped after task-a (deterministic summary failure codes: SUMMARY_BUDGET); skipped task-b
AUDIT TASKS: task-a=audited(structural=FAIL,quality=PASS) task-b=not-run-stopped(structural=FAIL,quality=FAIL)
AUDIT DISCREPANCIES: material=0 warning=0
AUDIT USAGE: modelCalls=19 summaryModelCalls=7 toolCalls=17 normalInput=142971 normalOutput=2786 summaryInput=41984 summaryOutput=39818 totalMeasuredInput=184955 totalMeasuredOutput=42604 cacheRead=132736 unknownUsageCalls=0 sessionTokensKodoEstimate=227559 relayRequests=19 relayTokens=227559 relayRejections=none
AUDIT RESULT: structural=FAIL quality=FAIL exit=1
AUDIT OUTCOME: structural expectations NOT confirmed; pre-registered stop rule outcome applies (quality evidence from the completed task exists, but the session is a structural stop, not a success)
```

## 8. 与 report.json 的对账

独立审计逐项比较 report.json 与从 state/wire 重算的结果：run id/status、4 类摘要计数与全部 10 类摘要事件、确定性失败码、受保护哈希（11 文件）、verify 退出码与输出、installed marker/budget、session/调用数、relay 请求与拒绝集合。结论：**0 material、0 warning 差异**；runner 的 9 条断言与独立结果一致（唯一 FAIL 为 `no-deterministic-summary-failures — SUMMARY_BUDGET`，与审计一致）。

用量口径说明：runner 控制台/报告字段 `measured` **只统计常规调用**（142,971 / 2,786，12 次），`summaryMeasured` 单独统计 7 次 compaction 调用（41,984 / 39,818）；两者合计 184,955 / 42,604，恰好等于 sessionTokens 227,559（= relay measured tokens）。独立审计同时报告两者，不把“常规调用实测”误读为全会话费用。此处无货币估算。

## 9. 解释边界（预注册 §9）

- 本检查是**协议停止，不是语义成功**；任务 A 的质量/验收证据成立不等于“摘要保留了信息”或“压缩方法有效”。任务 B 未运行，无法观测“两次折叠后保留早期约束”的注册目标。
- 两次任务、每任务一次尝试、无基线臂、无随机化：**不能**支持可靠率、非劣效、语义质量或费用收益结论；通过两项也只够进入下一阶段（§9C 配对实验），不是发布验收。
- 最终回答提到 37 只是观察项，不是通过条件；安装数超预期也只是结构事实。
- v2.1 修复在本次付费运行之后才进入工作树：本次证据解释旧代码行为；不声称修复后的代码会通过本次或任何未发生的运行。不得用同一注册补跑。

## 10. 下一步选项（不重跑同一注册）

1. **（a）新预注册**：由用户批准后，用同一对 fixture 在 v2.1 下做**新的**预注册付费运行（新 run id、新证据目录，旧证据不复用）；预算与停止规则需重新登记，这仍只是两任务筛查，不构成发布验收。
2. **（b）仅做零费用加固**：继续离线验证 v2.1 边界（fixture/契约/回放测试），不产生新的付费证据。
3. **（c）停止付费扩展**：保留本次“确定性正文预算拒绝”的负结果，不投入更多付费运行。

在用户明确批准新预注册之前，不应执行 (a)；本审计不建议任何形式的同注册重跑。

## 11. 零费用复现

```bash
# 独立审计（零模型费用、无网络；不修改付费证据目录）
node scripts/comparison/continuation-audit.mjs --out .kodo/continuation-paid-20261024-a

# 结果行与机器可读审计
#   AUDIT RESULT: structural=FAIL quality=FAIL exit=1
#   .kodo/continuation-audit-20261023-181803/audit.json
```

退出码语义：`0` = 结构预期已独立确认；`1` = 结构预期未确认（本次）；`2` = 审计自身用法/取证错误。质量失败单独记录，不改变结构退出码；对缺失任务（任务 B）记为未观测而非通过。

## 12. P0/E0 后续离线复核（2026-10-24，不改写旧结果）

新审计口径修正了“未运行等于质量失败”的旧展示，并修复成功独立 verify 遗漏 `available=true` 的证据标志。对同一旧证据重新展示为：

| 任务 | run | quality | mechanism | exposure | protocol |
| --- | --- | --- | --- | --- | --- |
| Task A | completed | **pass** | **fail** | sufficient | stopped |
| Task B | not_run | not_observed | not_observed | not_observed | stopped |

这没有改变旧协议停止结论，只把“已观察到的任务质量”和“摘要机制失败”分开。新版审计仍退出 1，因为结构预期没有确认；全局已观测质量为 PASS，Task B 不进入质量分母。

E0 脚本：[continuation-trigger-analysis.mjs](../scripts/comparison/continuation-trigger-analysis.mjs)。输出：[REPORT.md](../.kodo/research/compaction-e0-20261024/REPORT.md) 与 [analysis.json](../.kodo/research/compaction-e0-20261024/analysis.json)。它只读旧 SQLite/blob，得到：

- 四次摘要尝试的活动输入估算均超过 H，且隐藏正文为 0；因此没有观测到 hidden-history-only 触发。
- v2.1 对四份旧原始响应均可接受并有净收益；这只确认固定响应的预算契约，不证明真实模型会生成同样内容。
- 第 3/4 次折叠有 75%/80% 消息重叠，但各新增 2 条证据；三个一步固定后续观察模拟仍均超过 H，不能把四次一概称为无进展抖动。
- 维护总账精确对上 7 次请求、81,802 token；开销高，但没有证据支持在 P1 直接增加冷却、取消隐藏量触发或改 attempt key。

新版零费用 dry-run 的注册文件先于任务报告写入，A/B 阈值分别为 1/2，实际安装 4/7 次，运行后输入冻结稳定且无确定性摘要失败。该 dry-run 的 seed verify 按设计失败，只验证机制与实验清单，不是语义质量实验。

## 13. v2.1 新预注册真实检查（2026-10-24）

本节记录新的 E1 注册 `continuation-v2.1-screen-20261024`，不改写第 1–12 节的旧运行。执行命令使用 `codego1/deepseek-v4.1-flash`、`workInputTokens=16384`、`maxCalls=64`、`maxTokens=4000000`、`maxContextTokens=262144`、`maxOutputTokens=8192`；证据目录为 `.kodo/continuation-paid-v21-20261024-a/`。运行前后 freeze 摘要一致，没有输入漂移。

| 项目 | Task A | Task B |
| --- | --- | --- |
| 运行状态 | completed | not_run |
| 任务质量 | **pass**：独立 `node verify.mjs` 27/27，退出 0 | not_observed |
| 压缩机制 | **fail**：确定性 `SUMMARY_BUDGET` | not_observed |
| 暴露程度 | sufficient：成功安装 3 次，注册要求 ≥1 | not_observed |
| 协议结果 | stopped | stopped |

Task A 的保护文件 11/11 哈希未变，最终答复存在且与独立验收一致。摘要事件为 started 8、installed 3、failed 5、skipped 4；三次安装都在展示预算内，分别把工作上下文从 43,737 降到 14,567、19,769 降到 13,698、27,828 降到 14,650 token。每次安装的局部 coverage 均为 planned=covered（21/21、8/8、13/13），但这只证明对应消息进入并安装了摘要，不证明事实完整或闭卷准确率。

五次失败分为两类：

- 2 次在 `parseSummary` 中以 `SUMMARY_BUDGET: canonical summary JSON exceeds its character budget` 拒绝。对应硬正文额度仅 583 / 896 token，代码仍把 `hardBodyTokens * 4` 作为规范 JSON 的字符上限；字符数仍在充当 token 预算的代理，生成与校验口径没有真正统一。
- 3 次进入一次有界缩写，但缩写后正文仍为 1,155 / 1,285 / 1,237 token，高于 964 / 907 / 1,018 token 的硬上限，均以 `repaired summary exceeds its token budget` 结束。没有无限重试，也没有错误安装。

用量均有 provider 记录：30 次模型调用、352,087 token。正常工作为输入 220,242 / 输出 4,022；摘要维护为 11 次调用、输入 76,849 / 输出 50,974，共 127,823 token，占会话总量 **36.3%**，并占全部输出 token 的 **92.7%**。这批没有 off 基线，不能把该比例直接解释为相对成本增幅，但足以说明当前维护开销不可忽略。

独立审计目录 `.kodo/continuation-audit-20261024-022645/`：0 material / 0 warning 差异；最终判定为 `quality=PASS`、`structural=FAIL`，Task B 按预注册停止规则保持 `not_observed`。因此本轮没有测得闭卷准确率变化，也没有新的自主委派样本；不能用 Task A 的成功推断压缩带来收益。下一步只修“异常原始响应字符守卫”与“语义 token 预算”的分离，并验证超额响应只进入一次有界缩写；不继续本注册，也不启动 Task B。
