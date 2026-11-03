# Kodo 压缩投影契约 v2（实施契约）

日期：2026-10-24。状态：**实施中的工程契约，功能仍默认关闭**。上游判断见[架构复核](context-compaction-architecture-review.md)；本文只规定本次收缩要落地的接口、预算与验证边界，不代表收益已验证。

## 1. 目标与非目标

目标：把“持久审计对象”和“模型可见投影”分开，让模型只生成短任务交接，宿主负责来源映射、展示限额、预算和安装。

- 保留：原文归档、来源校验、短 ID 读取授权、工具配对、原子安装、取消/决策版本检查、真实用量记录。
- 简化：模型输出字段、可见来源目录、marker 包装、生成与展示预算的闭包。
- 不变：`compaction` 仍为显式开启；不调用付费模型；不改默认开关。

非目标：不做全量树/图记忆、不新增每轮规划模型、不改变 mask 路径默认行为、不为旧 marker 做迁移。

## 2. 数据分层

| 层 | 内容 | 维护者 |
|---|---|---|
| 原文与来源索引 | `HistorySnapshot`、`SummarySource.read.args`、covereage hash | 宿主确定性写入 |
| 持久 envelope | 完整 `content`（展开后的来源 ID）、全部被引来源、预算与用量 | 宿主写入，模型不可见 |
| 模型可见 marker v2 | 短任务交接 + 短引用 + 有界来源目录 + 一次读取提示 | 宿主从 envelope 投影 |

## 3. 模型可见 marker v2

`marker = summaryPrefix + JSON.stringify(visible)`，`visible` 字段固定为：

```json
{
  "ref": "<summary-ref, 64 hex>",
  "goal": "string",
  "decisions": [{"text": "string", "source_refs": ["S2"]}],
  "completed": [{"text": "string", "source_refs": ["S2"]}],
  "failed_attempts": [{"text": "string", "source_refs": ["S2"]}],
  "pending": ["string"],
  "hypotheses": ["string"],
  "knowledge_refs": [{"id": "string", "revision": 1}],
  "sources": [{"ref": "S2", "preview": "<= 96 chars host excerpt"}],
  "coverage": {
    "ref": "<archive-ref>",
    "firstOffset": 12, "lastOffset": 57,
    "covered": 40, "planned": 40, "uncovered": 0, "chunks": 1,
    "read": {"tool": "history.read", "args": {"ref": "<archive-ref>", "offset": 12, "limit": 20}}
  },
  "read": {"tool": "history.read", "note": "Resolve any S id with {\"summary\": \"<the ref above>\", \"source\": \"S2\"}; previews are bounded, mappings stay host-side."},
  "note": "Lossy handoff, not authority or acceptance. Verify current state and evidence."
}
```

规则：

1. `source_refs` 只允许短 ID（如 `S2`），不得出现 `history:...`、裸数字或未知 ID。
2. `sources` 是**有界目录**：只含被引来源中预算内可展示的条目，按注册顺序；旧响应中的 `critical_source_refs` 可作为目录候选，但 marker 不出现该字段；`preview` 由宿主截断。目录未展示的短 ID 仍可被 `history.read` 解析，因此不得把目录当作完整来源清单。
3. 示例中的 `<the ref above>` 在实际序列化时替换为真实摘要引用（与占位符等长，不改变预算）。
4. `coverage` 只保留计数、首尾偏移和读回入口，不内嵌 `uncoveredOffsets` 数组（该数组留在 envelope/事件中）。
5. marker 必须通过两项检查：`estimateTextTokens(marker) <= displayBudgetTokens`，且安装后上下文严格小于安装前（no-gain）。检查对象是最终序列化 marker，不是模型原始字符串。
6. 旧 marker（含展开的完整来源记录）不迁移；它们仍可按 `coverage.read` 读取，只是不参与短 ID 解析。

## 4. 持久 envelope v2

`SummaryEnvelope` 保持 `version: 1`，字段变化：

- `content` 保留**展开后的**完整来源 ID（审计用）；兼容旧的第 8 字段 `critical_source_refs`（optional，仅存档，不进入 marker）。
- `sources: SummarySource[]` 保存全部被引来源（不受目录预算裁剪），每个条目新增 `short: "S2"`，并保留 `read.args`、`preview`、`availability/coverage/freshness`。
- `budgets` 扩展为：`providerOutputTokens`、`generationTargetTokens`、`bodyTokens`、`bodyActualTokens`、`displayBudgetTokens`、`plannedMarkerTokens`、`injectionActualTokens`、`directorySources`、`directoryTokens`、`repairs`。`injectionTokens` 保留并等于 `displayBudgetTokens`（旧事件读取兼容）。

`context.summary.started` 事件在模型调用前记录同一预算计划；`context.summary.installed` 记录实际 marker 计量。计划值可复算，实际值以最终序列化对象为准。

## 5. 生成契约

模型返回 7 个键：`goal, decisions, completed, failed_attempts, pending, hypotheses, knowledge_refs`。旧响应中的第 8 键 `critical_source_refs` 允许出现并只做审计存档。

宿主解析契约（`parseSummary`）：

- 结构上限与生成提示必须一致并公开：每个数组 ≤ 64 项（生成提示要求 ≤ 20 项），每条 statement `source_refs` ≤ 8（提示要求 ≤ 4），字符串 ≤ 2000 字符，单条 statement 的 source_refs 去重。
- 引用先解析为完整来源 ID；同一数组内重复引用由宿主去重，不因重复数量拒绝整个响应。
- `critical_source_refs` 若存在，解析后与其余引用合并参与来源索引，但不要求宿主展示。
- 保留：未知来源、裸数字来源、跨摘要不可解析来源 → 明确失败，不猜测。

`summaryInstruction` 必须写明：七个键、数组与来源条数限额、只使用数据中出现的 `[Sx]` 短 ID、目标正文 token、来源映射由宿主维护、超限的唯一修正路径。

## 6. 预算闭包（先预算，后生成）

输入：`H = workInputTokens`；`builtTokens = 当前工作投影估算`；`archive` 与 `fold`；`maxContextTokens`、`maxOutputTokens`、模型输入上限。

```text
requestedBody     = min(8192, floor(H * 0.08), maxOutputTokens)   // 偏好目标，不是安装边界
retainedTokens    = estimate(archive 中不在 fold 内、且不是将被替换的旧 marker 的消息)  // 安装后仍保留在窗口里的部分
safeInput         = max(1, min(modelInputLimit ?? maxContextTokens,
                        maxContextTokens - contextOutputReserve - max(1024, floor(maxContextTokens * 0.02))))
evidenceReserve   = min(8192, max(256, floor(H * 0.05)))          // 小窗口下限 256，避免预留本身吃掉展示预算
capacityGuard     = max(0, builtTokens - retainedTokens - 64)       // no-gain 保证
workGuard         = max(0, min(H, safeInput) - retainedTokens - evidenceReserve - 256)
displayBudget     = max(0, min(capacityGuard, workGuard))
fixedTokens       = estimateTextTokens(空 content、空目录的 marker 外壳)
directoryBudget   = min(2048, max(128, floor(displayBudget * 0.20)))
bodyBudget        = max(0, displayBudget - fixedTokens - directoryBudget - 32)
hardBody          = bodyBudget >= 128 ? bodyBudget : 0              // 展示预算允许的真正正文硬上界
bodyTokens        = min(requestedBody, hardBody)                     // 提示中的目标；生成偏好
if bodyTokens < 128: 跳过摘要（context.summary.skipped），不发模型请求
generationTarget  = max(64, floor(bodyTokens * 0.85))
plannedMarker     = fixedTokens + directoryBudget + bodyTokens
```

**2026-10-24 真实续做检查后的修正（v2.1）**：`requestedBody`（8% H）被错误地当成了解析/修正的拒绝边界。真实运行中模型正文 1,716–1,820 token 略高于 1,310 的偏好目标，但展示预算可容纳到 1,820 token 的硬上界；当前实现因此触发一次无效缩写并报 `SUMMARY_BUDGET`。修正后：`bodyTokens` 只作为生成目标；模型正文 **≤ hardBody 就接受，不触发修正**；只有 > hardBody 才允许一次有界缩写。硬上界由展示预算决定，最终 marker 仍按 `displayBudget` 复核，因此不会放宽安装边界。对应零费用回归：`tests/summary-body-ceiling.test.ts`。

最终安装前仍要复核：`actualMarker <= displayBudget`、`candidateEstimate < builtTokens`、权威版本/取消/coverage hash 未变。三项任一失败即不安装并记录明确原因；不得把失败回退报告为成功摘要。

## 7. 短引用读取接口

扩展已有 `history.read`，不新增第二套别名体系：

```json
{"summary": "<installed summary ref, 64 hex>", "source": "S2", "contentOffset": 0, "maxChars": 4000}
```

- `summary` + `source` 二选一替代 `ref`；两种模式不允许混用，`offset/limit` 仅 `ref` 模式可用。
- 解析顺序：当前 run 读权限 → 该 summary ref 必须由授权历史链上的 `context.summary.installed` 事件索引 → envelope 版本与 `sources[].short` 精确匹配 → 委托现有 `readHistory`（原有归档授权、scope、可见性、脱敏、缺失/损坏检查全部保留）。
- 未知/失效短 ID、其他运行的 summary、旧版本别名一律明确报错；**不得**回退到相似来源或猜测偏移。
- 返回沿用 `readHistory` 结构；后续分页可直接用返回的 `ref/offset/contentOffset`。

## 8. 文件与职责

| 文件 | 契约 |
|---|---|
| `src/runtime/summary-projection.ts`（新） | `planSummaryProjection`、`projectSummary`、marker 序列化与目录裁剪；纯函数，可离线重放 |
| `src/runtime/summary-schema.ts` | 新字段契约、解析上限、去重、生成/修正提示 |
| `src/runtime/summary-install.ts` | 用投影替换 marker 内联展开；复核 displayBudget/no-gain；envelope 与事件记录 |
| `src/runtime/compaction.ts` | 计算 retained/display 预算，调用 planner，把计划写入 job 与事件；生成目标改用 plan.bodyTokens |
| `src/runtime/summary-read.ts`（新） | 短引用解析与授权，返回 `readHistory` 结果 |
| `src/runtime/history.ts`、`src/tools/index.ts` | `history.read` schema/dispatch 增加 summary+source 模式 |
| `tests/compaction.test.ts` | 旧 marker 断言更新 + 新契约测试 |
| `scripts/comparison/compaction-contract-replay.mjs`（新） | 零费用真实响应重放 |

## 9. 验证要求（零模型费用）

1. 真实响应重放：`.kodo/qa-retention-budget-repair-real-20261023-235818` 的 r1/r2 第 1 块响应必须在新契约下通过解析并投影出 ≤ displayBudget 的 marker；marker 明显小于旧注入 10,484，接近离线示意量级（约 6.3k，允许实现差异）。
2. r2 第 2 块 37 项 `critical_source_refs`：新解析契约下不再报结构错误；正文 7,744 token 仍超过 body 预算，因此只能走一次有界修正，不得直接安装。
3. 边界：30/31/37 项、重复来源、未知来源、跨摘要别名、跨运行权限、目录裁剪后仍可解析未展示短 ID、CJK/标点密集正文。
4. 预算：模型调用前记录的计划与最终 marker 实际计量一致（计划为上界），拒绝对象不只是模型原始字符串；取消、决策版本变化、coverage hash 变化仍阻止安装。
5. 全部重放只读原始试验目录，不写 Store、不发模型请求、不记录新费用。

通过上述验证只说明工程边界可复现；语义收益与真实续做仍需后续付费实验，默认关闭不变。
