# 上下文压缩横向对比：Kodo vs OpenCode vs Picode（Pi 基座）

日期：2026-10-22  
性质：**机制对比 + Kodo 实测 + 小型策略重放 pilot**。这不是三家工具的端到端运行对比；OpenCode/Picode 的端到端重放因共享上游模型通道不稳定未取得有效样本（见 §4）。

## 1. 结论先说

| 维度 | Kodo（本方案） | OpenCode | Picode（Pi 基座） |
| --- | --- | --- | --- |
| 压缩目标 | 工作上下文软预算 + 任务摘要 + 可溯源读取入口 | 上下文将满时生成 checkpoint summary + 保留近期 tail | 同上，结构化 summary + 保留近期 tail |
| 是否默认启用 | **否**（实验开关，C4 未验收） | 是（auto 默认开，可手动 `/compact`） | 是（auto 默认开，可手动 `/compact`） |
| 项目知识目录 | **有**（knowledge 目录 + 自然探索沉淀，本仓库 C2） | 无原生项目知识目录 | Picode 是 Pi 包，增加 agents/subagents，但无项目知识目录 |
| 摘要可追溯 | **有**（SummaryEnvelope sources + short ID + archive/read 指针 + coverage） | checkpoint 文本 + 会话历史仍持久；无逐条来源字段 | summary + file tracking（read/modified files）；无逐条来源 |
| 最近上下文保留 | `min(16384, 25%H)`（默认 16k token） | 固定提交源码中 `keep` 默认 **15000**；buffer 未设置时通常预留窗口的 15% 且至少 16k，小窗口特殊处理 | `keepRecentTokens` 默认 **20000**；reserve 16384 |
| 旧工具输出 | 原文归档，可 `history.read/search` 按偏移恢复 | 历史消息仍持久；仅在近期文本序列化或摘要请求需 flatten 缩减时，tool 输出文本截断 **1250 字符** | 历史 entry 持久；序列化摘要请求 tool result 截断 **2000 字符** |
| 摘要格式 | 严格 8 字段 JSON + 短来源 ID + 知识引用 | Markdown 模板（Objective/Requirements/Decisions/Work State/Next Move/Relevant Files/Important Context） | 结构化 Markdown（Goal/Constraints/Progress/Decisions/Next Steps/Critical Context） |
| 多次压缩 | 已有滚动摘要链 + attemptKey/原子安装/覆盖范围 | 新 checkpoint 替换旧 checkpoint；recent tail 保留 | 新 compaction entry；总结从上次 kept boundary 之后继续 |
| 适用主张 | 目录保留知识、任务摘要保留执行状态；原文可按需读取 | 单 agent 连续编码的上下文续航 | 同 Pi，另加模式/子代理工作流 |

**判断：** 三者的“压缩”目标不同。OpenCode/Picode 是**checkpoint 摘要器**，优化“继续做当前编码任务”；Kodo 在内核中额外提供**项目知识目录 + 来源/归档/读取入口 + coverage 遥测**，目标是“压缩后仍能按来源找回项目事实”。就“闭卷记忆全部项目事实”而言，三者都不够；Kodo 已验证定向探索后的自动知识沉淀与复用，但尚未与 OpenCode/Picode 通过持久历史、文件或扩展实现的记忆工作流做同任务比较。不能把本次结果简化为“Kodo 优于/劣于 OpenCode/Picode”。

## 2. 机制细节（源码依据）

### 2.1 OpenCode

- 自动触发：固定提交 `b42c31613fdcbd220e859bea357fea48260a6c7a` 中，buffer 未设置时按窗口的 15% 与通常至少 16,000 的规则计算，小窗口有特殊处理；支持 provider overflow 后的缩减重试；`auto=false` 关闭自动与 overflow 压缩，手动压缩仍可用。
- checkpoint：摘要请求生成 Markdown 模板（Objective、Requirements、Decisions、Work State、Next Move、Relevant Files、Important Context），recent context 的源码默认 `keep` 为 15,000；8,000 仅是本次重放选择或其他文档版本口径，不是该固定提交的默认值。
- V2 明确 `prune` 当前无运行时效果，不原地裁剪旧 tool 输出；旧 session messages 仍持久，但模型请求从最新 checkpoint + 后续消息重建。
- 没有项目知识目录，也没有逐条摘要来源字段。
- 参考：https://opencode.mintlify.site/compaction ，源码 `.kodo/opencode-src/packages/core/src/session/compaction.ts`（本机克隆）。

### 2.2 Picode（Pi 基座）

- Picode 是 Pi 包（`@judepayne/picode`），压缩行为来自 Pi Coding Agent，不是独立实现的压缩器；它增加模式、子代理、权限等。
- 自动触发：`contextTokens > contextWindow - reserveTokens`，reserve 默认 16384；`keepRecentTokens` 默认 20000；支持 `/compact`、overflow/length 恢复、split user-message span、branch summarization。
- 摘要：结构化 Markdown（Goal、Constraints & Preferences、Progress、Key Decisions、Next Steps、Critical Context），序列化时 tool result 截断 2000 字符，并累计 read/modified file lists。
- 没有项目知识目录；file tracking 只记录文件路径，不保存逐条事实来源。
- 参考：https://pi.dev/docs/latest/compaction ，源码 `packages/coding-agent/src/core/compaction/compaction.ts` 与 `utils.ts`。

### 2.3 Kodo（本方案）

- 触发：工作软预算 `workInputTokens`（默认 65536）；构建上下文超过预算时先隐藏旧正文/摘要；实验开关默认关闭。
- 摘要：严格 8 字段 JSON（goal/decisions/completed/failed_attempts/pending/hypotheses/critical_source_refs/knowledge_refs），宿主分配短来源 ID `S1..Sn` 并映射到 `history:<archive>:<offset>`；安装前复核覆盖范围、决定版本、contextRef。
- 保留：最近完整轮次预算 `min(16384, 25%H)`；旧消息归档 + `history.read/search` 按偏移恢复；coverage 记录 planned/covered/uncovered（未总结部分标记为仅归档）。
- 项目知识：C2 知识目录 + exploration 子代理自动沉淀（本仓库已实现并实验）。
- 参考：`src/runtime/compaction.ts`、`docs/context-compaction.md`。

## 3. 实测数据

### 3.1 Kodo（有效主实验，详见 QA 报告）

| 实验 | 结果 |
| --- | --- |
| 大上下文固定投影闭卷（362k/128k，2 repeats） | off 30.0%、mask 10.0%、hybrid 10.0%、**summary@65536 60.0%**（2/2 安装，coverage 39%） |
| 同投影开卷（工具预算 60） | off/mask 均 **97.5%**；输入为闭卷的 4.8–9.2 倍 |
| 增量 3 次压缩（4 批，final freeze） | off 57.5%、summary 52.5%（6/6 安装）、mask 25%、hybrid 20%；事实细节约一半，执行状态基本保留 |
| 人工预置知识目录（读取正控制，2 repeats） | 92.5–97.5%，mask+catalog 成本最低 |
| **定向探索后的知识沉淀（真实探索→自动目录→QA）** | 自动评分 **14/15 = 93.3%**，人工复核 Q10 后 15/15；无目录负控制 0%；建库 466k input token，目录 QA 45,204 input token，control 10,648 input token |
| 相关布局配对压力测试（3 task ×4 arms） | off 20.8%、mask 4.2%、summary 12.5%（消息 coverage 25.0%–32.4%）、hybrid 4.2% |

### 3.2 OpenCode / Picode 端到端重放：未取得有效样本

尝试用同一 seed（31 页/379k token/20 KF 事实/128k 窗口）在 harness 中按公开源码重放三策略。结果：

- 多次真实调用中，共享上游模型服务返回 `get_channel_failed` / 长请求挂起；OpenCode/Pi 的摘要本身可以完成，但 phase-2 QA 调用无法稳定完成，Kodo 的 107k-token 摘要请求持续失败/挂起。没有可用的 20 题有效数据。
- **没有把 0% 当作策略结果**；尝试记录保留在 `.kodo/c4-thirdparty*`、`.kodo/c4-thirdparty-openpi-*`（未纳入结论）。
- 失败原因在 harness/上游而非策略本身；需要更换稳定 provider 或让厂商 CLI 端到端跑同一任务后才能给出可比的 20 题数字。

### 3.3 小型策略重放 pilot（8 事实，仅机制 sanity check）

在 8 个真实文件页、8 条 KF 事实、单次摘要 + 单次闭卷 QA 的小规模重放中（同一模型、同一轮次、n=1）：

| 策略（按公开提示词/保留设置近似） | 8 题通过 |
| --- | --- |
| Kodo 风格（JSON handoff + 全部旧历史摘要） | 7/8 |
| OpenCode 风格（8-section checkpoint + keep 8000） | 5/8 |
| Picode/Pi 风格（Pi 结构化 summary + keepRecent 20000） | 8/8 |

**不能据此排名**：只有 8 条事实、1 次运行，Kodo 重放未启用严格来源校验，页面被扁平化而非真实 tool messages，且上下文远小于正式实验。该 pilot 只说明“三个提示词都能在简单场景保留大部分短事实”，以及不同提示词/保留策略在小样本下可能产生差异。

## 4. 公平性与局限

1. **不是端到端对比**：OpenCode/Picode 的官方运行时包含工具循环、压缩触发、恢复策略；本对比主要基于公开源码/文档的机制，以及 Kodo 的产品内实测。
2. **参数口径不同**：OpenCode `keep` 实验取 8000，固定提交源码默认 15000；Pi 摘要输出上限、split-turn 双摘要被简化；Kodo summary 的容量受限（107k 请求、39% 覆盖）是产品实现特征，不是模型能力。
3. **seed 粒度**：真实仓库页以 18–24k 字符为页，OpenCode/Pi 的 keep token 与页粒度不匹配（一个 page group 可能超过 keep），因此重放保留量只能近似。
4. **模型/上游**：共享上游在长请求上不稳定；任何缺样本的“横向数字”都不能作为结论。
5. **知识目录**：OpenCode/Pi 没有 Kodo 式原生项目知识目录；Kodo 的实验是一次预先指定事实类别与 KF 编号的 5 主题定向探索，长期选择、失效更新与维护质量未测。

## 5. 建议的下一步

1. 用稳定的 provider/模型完成 **同一 seed 的 20 题三策略重放**，或直接用三家 CLI 在同一真实任务上端到端运行并抓取压缩前后上下文（需要稳定的工具循环与窗口设置）。
2. 若要公平比较“项目知识保持”，应让 OpenCode/Pi 使用同样的外部知识工具或文件，并分别报告原生默认体验与同能力对照。
3. Kodo 侧继续补：summary 覆盖提升（39%→更高）、自然沉淀多次运行、独立 task 扩到 ≥5。

## 6. 证据与引用

- Kodo QA 报告：[context-compaction-qa-results.md](context-compaction-qa-results.md)（含自然沉淀 §11、独立配对 §12）
- 离线复核：[context-compaction-experiment-review.md](context-compaction-experiment-review.md)
- OpenCode：https://opencode.mintlify.site/compaction ；源码 `.kodo/opencode-src/packages/core/src/session/compaction.ts`
- Pi：https://pi.dev/docs/latest/compaction ；源码 https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts
- Picode：https://github.com/judepayne/picode ；npm `@judepayne/picode`
- 失败/未纳入结论的重放证据：`.kodo/c4-thirdparty5-20261022-203808/`、`.kodo/c4-thirdparty-openpi-20261022-210502/`
- 小型 pilot：`.kodo/thirdparty-mini.json`
