# FastAPI 四方对比（全过程记录版，2026-10-29）

**结论：** 四个 harness 都通过了 FastAPI 验证（reward 1）。这一轮 Kodo 墙钟最短（2,242 秒，其余 2,501–2,592 秒），推理量与 DeepSeek Harness 相当，之前那种 1,350 秒的差距没有再出现。但网关状态和基线时已经不同：四方的输出 token 都涨到基线的 3–8 倍，所以这一轮只能和自己内部比，不能直接和[真实上限报告](frontier-fourway-real-limits-20261028.md)的数字相减。Kodo 的 credit 最高（47.07），原因是缓存命中率较低（90.6%，其余 96–98%）。

## 条件

- 模型 `deepseek-v4.1-flash`，网关 `codego1`，上下文 1,048,576，输出 393,216，与真实上限报告相同。
- 四格依次串行运行，不并发。顺序为 dsh → opencode → pi → kodo（FastAPI 的倒序）。
- Kodo 用 `--kodo-local` 挂载本地构建。第一次 Kodo 格在第 2 个请求就失败了（见下文“Kodo 第一次失败”），修复后在单独目录重跑。
- 证据目录：
  - `.kodo/frontier-fourway-recorded-fastapi`：dsh、opencode、pi，以及失败的第一次 Kodo。
  - `.kodo/frontier-fourway-recorded-fastapi-kodo`：Kodo 重跑。
- 运行时间为 10-29 06:31–09:27 UTC。

## 结果

| harness | 墙钟 s | 退出码 | 验证 | 请求 | 输入 token | 缓存命中 | 输出 token | 推理 token | credit | 模型 s | 工具 s | harness s | 工具调用 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Kodo | 2,242 | 1 | 通过 | 86 | 5,194,309 | 90.6% | 265,800 | 238,836 | 47.07 | 2,213 | 116 | 0 | 123 |
| OpenCode | 2,501 | 0 | 通过 | 100 | 6,987,752 | 95.2% | 216,064 | 193,168 | 38.22 | 2,329 | 150 | 30 | 123 |
| DeepSeek Harness | 2,533 | 1 | 通过 | 102 | 5,482,909 | 96.8% | 268,171 | 247,432 | 38.68 | 2,603 | 66 | 0 | 100 |
| Pi | 2,592 | 0 | 通过 | 155 | 14,249,026 | 98.0% | 178,756 | 139,521 | 36.65 | 2,369 | 448 | 0 | 166 |

模型秒数是 relay 测得的每个请求从收到到流结束的时长之和。工具秒数来自各 harness 自己的会话记录（同一步内并行的工具取首个开始到最后结束）。harness 秒数是请求间隙减去工具时间的剩余部分。DeepSeek Harness 的模型秒数略大于墙钟，因为它的最后一个请求在容器退出后才被 relay 结算。

每步推理 token 分布：

| harness | 中位数 | P90 | 超过 5k 的步数 | 首个推理 token 中位延迟 |
|---|---|---|---|---|
| Kodo | 396 | 8,809 | 24 | 7.0 s |
| OpenCode | 1,464 | 5,838 | 12 | 6.7 s |
| DeepSeek Harness | 721 | 6,706 | 23 | 6.6 s |
| Pi | 1 | 3,015 | 10 | 6.5 s |

## 观察

1. **时间几乎全在模型里。** 四方的模型时间都占墙钟的 90% 以上，工具时间 66–448 秒，harness 自身处理不超过 30 秒。Pi 工具时间最多，因为它调用了 166 次工具，请求数也最多（155）。
2. **固定延迟变高了，而且四方一样。** 首个推理 token 的中位延迟都在 6.5–7.0 秒，基线时约 1–2 秒。以 Kodo 86 个请求计，这一项就约 600 秒。这是网关侧的变化，不是 harness 差异。
3. **Kodo 的推理分布两极化。** 中位数低（396），但有 24 步超过 5k，P90 是四方最高的 8,809。最慢的几步（第 8、20 步，各 13k 推理 token，约 90 秒）值得在 `transcript.md` 里逐步看它在想什么。
4. **Kodo credit 高的原因是缓存未命中。** Kodo 的未命中输入约 487k token，DeepSeek Harness 约 173k，Pi 约 286k，OpenCode 约 334k。Kodo 每个请求末尾追加的 `<kodo-runtime kind="state">` 状态块会变化，是缓存前缀被打断的首要嫌疑，需要按步对比 `cachedTokens` 来确认。
5. **没有出现长时间卡流。** 单步最长约 99 秒（Pi 第 20 步），之前那次 328 秒的卡死没有复现。

## 两个退出码 1

- **DeepSeek Harness**：任务做完后，第 102 个请求收到网关的 HTTP 520（Cloudflare 错误页），harness 以退出码 1 结束。补丁已经完成，验证通过。relay 当时把这个请求记成 `completed`，因为流本身正常结束了；`trace.mjs` 现在把 HTTP ≥ 400 的请求记为失败步，并标出 `HTTP 520`。
- **Kodo 重跑**：第 75 步模型执行了 `sleep 120; tail ...`。`shell.exec` 的默认超时是 60 秒（`src/tools/shell.ts:83`），命令被杀掉，Kodo 把它标为“写入结果未知”（UNKNOWN_WRITE）并阻塞 `/app` 下的写操作。之后模型连续 6 步只做 `pwd`、`echo alive` 之类的探测，全部被拒，触发 `NO_PROGRESS` 交接而退出。补丁在此之前已经完成，验证通过。这是一个独立的 Kodo 问题：一个只读的等待命令因为超时就被当成未知写入，后面又没有自动和解的路径。

## Kodo 第一次失败

第一次 Kodo 格在第 2 个请求失败，错误是 `MODEL_PROTOCOL: invalid usage counters`。原因是网关现在在每个流式块上都附带不完整的 `usage`（只有 `prompt_tokens_details.cached_tokens`），Kodo 的 Chat Completions 客户端把它当成最终用量去校验 `prompt_tokens`，于是报错。这一轮四格的响应里都有这种块（dsh 100 个文件、opencode 99、pi 154、kodo 85），其他三个 harness 都能容忍。

修复（`src/providers/openai.ts`）：只有带 `prompt_tokens` 或 `completion_tokens` 的 `usage` 才作为最终用量；计数存在但非法时仍然报错。新增两个测试放在 `tests/provider-hardening.test.ts`。

## 新保存的过程数据

每个格子 `<cell>/` 下现在有：

| 路径 | 内容 | 用途 |
|---|---|---|
| `relay/request-N.json` | 每次发给模型的完整请求（消息、工具定义、参数） | 看上下文怎么增长、缓存前缀在哪里变化 |
| `relay/response-N.txt` | 原始 SSE 流，边收边写；失败或中断的流也保留 | 回放模型的完整输出 |
| `relay/calls.json` | 每个请求的状态、HTTP 码、用量，以及阶段计时：响应头、首个/最后推理、首个/最后正文、首个/最后工具参数、流结束，外加约每秒一个的进度采样 | 区分排队等待、推理、写工具参数各花了多久；定位卡流 |
| `process/agent.timestamped.log` | 带 Docker 时间戳的 harness 标准输出 | 按时间对齐 harness 自己的事件 |
| `process/workspace/NNNN-<秒>s.patch` 和 `workspace.jsonl` | 每 60 秒的工作区 diff，有变化才存 | 看代码在什么时候变成什么样 |
| `process/resources.jsonl` | 每 60 秒的容器 CPU 和内存 | 排查测试或构建卡住 |
| `process/native/` | 导出的 harness 原生记录：Kodo 的 sqlite events/calls、OpenCode 的 message/part、DeepSeek Harness 解压后的会话、Pi 的会话 jsonl | 各 harness 内部视角的完整过程 |
| `process/tools.jsonl` | 每次工具调用的开始、结束时间和状态 | 计算工具时间 |
| `process/steps.jsonl` | 每步一行：计时、token、完整推理、正文、工具调用，以及 harness 回送的工具结果 | 程序化分析的主入口 |
| `process/transcript.md` | 同上的可读版，长段落截断 | 人工逐步阅读 |
| `process/summary.json` | 汇总：请求、模型/工具/harness 时间、最慢步、最长间隙 | 快速对比 |

一轮四格的证据合计约 750 MB，主要是 `relay/request-*.json`（每次请求都包含完整历史）。

## 用法

```bash
node scripts/comparison/frontier/run.mjs --task fastapi --kodo-local --context-tokens 1048576 --output-tokens 393216 --record-interval-sec 60 --out .kodo/<新目录>
```

```bash
node scripts/comparison/frontier/trace.mjs .kodo/<证据目录>
```

```bash
node .kodo/recorded-compare.mjs .kodo/frontier-fourway-recorded-fastapi .kodo/frontier-fourway-recorded-fastapi-kodo
```

`run.mjs` 每格结束后会自动生成 `process/` 下的 trace 文件；`trace.mjs` 用来对旧证据补生成，或在修改了解析逻辑后重新生成。trace 生成失败时记录在 manifest 的 `cell.traceError`，不会中断整轮运行。

## 建议的下一步优化

1. 修 Kodo 的超时处理：只读 shell 命令（或明显只是等待的命令）超时后不应标为未知写入；或者在未知写入后提供自动和解，避免 NO_PROGRESS 退出。
2. 按步对比 Kodo 的 `cachedTokens` 和请求前缀，确认状态块是否打断了缓存，若是则把易变字段移出缓存前缀。
3. 读 Kodo 第 8、20 步的推理，看高推理步是在做规划、在消化状态块，还是在重复检查。

## 本轮改动

- `scripts/comparison/frontier/relay.mjs`：流式边收边写、跨块的密钥脱敏、阶段计时与进度采样、SIGTERM 时结算未完成请求。
- `scripts/comparison/frontier/recorder.mjs`（新）：带时间戳的日志、工作区快照、资源采样。
- `scripts/comparison/frontier/native.mjs`（新）：导出四个 harness 的原生记录和工具计时。
- `scripts/comparison/frontier/trace.mjs`（新）：生成 steps.jsonl、transcript.md、summary.json；HTTP ≥ 400 记为失败步。
- `scripts/comparison/frontier/run.mjs`：接入 recorder 和 trace，新增 `--record-interval-sec`。
- `src/providers/openai.ts`：忽略不带计数的 `usage` 块。
- 测试：`relay.test.mjs`（3 通过，SIGTERM 用例在 Windows 跳过，在 Linux 容器里 4 个全过）、`trace.test.mjs`（6 通过）、`tests/provider-hardening.test.ts` 新增 2 个用例；provider 相关 3 个测试文件共 106 个通过，tsc 和 eslint 无错误。

## 后续修复说明（2026-10-29，未提交工作区）

以上是历史实验，原始数字与故障描述保持不变。当前代码已包含只读等待命令的效果分类、后台进程登记和恢复检查；无法证明进程已停止时仍保留清理失败事实，不把未知写入无条件改为成功。历史第 75 步的具体超时应按该轮 `toolTimeoutMs: 120_000` 与日志判断，不能只引用 shell 默认值。

本次角色交接优化将 trace 的前缀比较和工具结果匹配改为同一 run 内进行，避免子代理交错请求造成误判。新增 delegation-metrics 脚本区分内容证据和未知重复、实际修改与首次观察。状态块导致缓存损失仍是待验证假设，结构分类和命中比例不能单独证明因果或性能收益。本轮未重新运行付费模型实验，相关实现尚无提交号。
