# 摘要长度限制核查（2026-10-28）

结论：撤回本轮新增的统一 2048 token 建议，恢复按现有上下文预算计算的摘要目标。保留去除流水账、引用已有证据、不重复检查的指导。没有进行新的付费模型实验，因此不能声称摘要缩短后质量不变或费用必然下降。

## 必须区分的限制

- **触发阈值**：历史多长时压缩，不是摘要多长。
- **保留近期原文预算**：摘要之外还保留多少消息，不是摘要输出额度。
- **建议摘要长度**：提示中的软目标，可影响信息取舍，即使程序不截断也有丢失细节的风险。
- **请求输出上限**：提供给模型的最大输出额度，部分模型的推理与正文共享额度；不等于实际摘要正文长度。

## 对照结果

| 工具与核对版本 | 摘要正文指导 | 实际限制及边界 |
|---|---|---|
| Pi 1.3.0 本地源码 | 各节简洁，保留路径、函数名、错误和仍有效的历史信息；没有固定 2048 目标 | 摘要调用不再使用 reserveTokens 限制输出；代码明确注明使用模型输出上限。通用层还会根据剩余上下文扣除 4096 余量后夹取。`length` 结束的摘要拒绝保存 |
| OpenCode 1.19.3，固定源码 e3c4eb24，CLI 会话路径 | 结构化简短要点，保留准确标识与约束；没有固定 2048 目标 | compaction 调用通用 processor/LLM，默认最大输出取模型 output 与 32,000 的较小值；可被配置或插件覆盖。本次实验又统一限制为 8192 |
| 同一 OpenCode 源码的 `packages/core` 独立路径 | 共用结构化摘要模板 | `SUMMARY_OUTPUT_TOKENS=4096`，摘要请求 `generation.maxTokens=min(当前输出额度或4096,4096)`。这是实际硬额度，不能遗漏；也不能混称为上述 CLI 路径的专用上限 |
| DeepSeek Harness `dsh-compaction-basic` 0.2.1-rc.2 发布包 | 简洁工程文字，保留精确命令、数值、签名与用户纠正；没有固定 2048 目标 | `maxTokens` 可配置，默认取 `headroomTokens`，后者默认 65,536；摘要请求传入此值。这个默认数是生成额度，不要求正文写满，实际受模型、上下文与网关限制。达到 token cap 的不完整摘要拒绝使用 |
| Codex 官方配置文档与公开实现快照 | 不能从公开资料确立统一 2048 正文上限 | 官方配置的 `model_auto_compact_token_limit` 是触发阈值。OpenAI 远端压缩可返回不透明的加密压缩项，不能按普通文本摘要长度类比。公开本地实现里的 20,000 常量用于保留用户消息，不是摘要正文上限；不能据此断言服务端内部没有限制 |

OpenCode 两条路径的区别来自调用链检查：`packages/opencode/src/session/compaction.ts` 只从 core 导入 `buildPrompt`，执行摘要走 `processor.process`；4096 常量在 core 的独立 `make().compactAfterOverflow()` 内使用。不能只搜索到一个常量就归到所有入口。

Pi 的默认 `reserveTokens=16384` 和 `keepRecentTokens=20000` 分别用于触发/预留与保留近期消息，不是摘要正文上限。DeepSeek 的默认 headroom 也不能不加调整地套到本次 64k 小窗口上。

Codex 官方资料本轮在线获取；源码对照使用此前已保存的公开快照 `398500106707f0a3217c7cf83edc2bf226cc342f`（2026-10-23）。不把快照视为当前桌面应用所有后端的完整实现。

## 为什么现在不应优先统一缩短

上一轮的 2048 只加在提示中：代码没有截断摘要，没有把摘要请求的输出上限降到 2048。它仍可能让模型主动省略信息，尤其是多文件接口约定、未解决错误、父子任务关系、验收编号和用户的早期纠正。连续多次摘要可能累积这种损失。

本次真实轨迹的 usage 元数据可将输出拆成推理与非推理部分。以下非推理 token 是账单减法，不是另行分词测量：

| 任务/摘要请求编号 | 输出 token | 推理 token | 非推理输出 |
|---|---:|---:|---:|
| 数据题 #48 | 2053 | 353 | 1700 |
| 数据题 #63 | 1438 | 0 | 1438 |
| FastAPI #29 | 4355 | 1649 | 2706 |
| FastAPI #40 | 4093 | 1517 | 2576 |
| FastAPI #63 | 2518 | 0 | 2518 |
| FastAPI #106 | 3682 | 114 | 3568 |
| FastAPI #127 | 4208 | 1693 | 2515 |

数据题两次摘要已经低于 2048。FastAPI 若假设五次摘要都刚好缩到 2048，而次数、输入、推理和后续行为不变，只减少 3643 个输出 token；按既有账单拟合约为 **0.416 credit，占 36.39 总费用的约 1.14%**。

这是条件化算术示例，不是实测收益、最大收益或完整成本预测。后续输入可能减少，也可能因为遗失信息而重读、重复测试或重新调查，造成更多调用。尤其不能把 4.77 credit 的全部摘要费用当作缩短正文就能省下的费用，其中包含读取历史的输入成本和推理输出。

## 当前处理与更合适的验证

本轮撤回 `Math.min(targetTokens, 2048)`；摘要提示重新使用现有 `targetTokens`。当前几何仍按可用空间计算，比例模式的建议上界为 8192，旧绝对工作预算模式为 4096；这些原有目标本身也不是质量保证。摘要请求的输出额度继续遵循模型/会话预算，不额外压低；合格摘要不因超过建议目标而机械截断。

优先减少不必要的摘要触发、报告往返和重复调查。若以后比较长度策略，应固定模型、任务和触发位置，至少观察：关键约束与未完成项保留、恢复后的任务通过率、重读和重复测试次数、全任务总费用，以及多次连续压缩后的表现。只比摘要当次 token 数不足以证明优化。

## 来源

- Pi：[摘要调用与不完整结果处理](../../.kodo/competitor-sources/pi/source/packages/coding-agent/src/core/compaction/compaction.ts)、[通用输出预算](../../.kodo/competitor-sources/pi/source/packages/ai/src/api/simple-options.ts)。
- OpenCode：[CLI 压缩路径](../../.kodo/competitor-sources/opencode/source/opencode-e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/compaction.ts)、[CLI 请求参数](../../.kodo/competitor-sources/opencode/source/opencode-e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/session/llm/request.ts)、[通用输出上限](../../.kodo/competitor-sources/opencode/source/opencode-e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/provider/transform.ts)、[core 的 4096 上限](../../.kodo/competitor-sources/opencode/source/opencode-e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/core/src/session/compaction.ts)。
- DeepSeek：[本轮读取的固定版本发布代码](../../.kodo/research/summary-limits-20261028/dsh-compaction-basic/index.js)、[版本与来源记录](../../.kodo/research/summary-limits-20261028/dsh-compaction-basic/source.json)。仅下载并读取发布包，未安装或执行包代码。
- Codex：[官方配置参考](https://developers.openai.com/codex/config-reference)、[官方压缩指南](https://developers.openai.com/api/docs/guides/compaction)、[已有公开源码快照](../../.kodo/research/compaction-audit-20261024/codex--codex-rs__core__src__compact.rs)、[快照版本](../../.kodo/research/compaction-audit-20261024/codex-revision.json)。
- Kodo：[费用分析数据](../../.kodo/frontier-cost-analysis-20261028/analysis.json)、[摘要提示](../../src/runtime/summary-schema.ts)、[预算几何](../../src/runtime/compaction-trigger.ts)。
