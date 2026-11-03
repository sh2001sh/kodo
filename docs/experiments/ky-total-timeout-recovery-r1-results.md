# ky-total-timeout-recovery-r1：A1/D1 恢复诊断结果

这是一次恢复诊断，不与完整任务的胜率合并。证据目录为 `.kodo/ky-recovery-paid-20261026-040059`；v2-r6 原证据只读，未改动。

## 设置

- **种子**：A1、D1 的 v2-r6 工作区副本，`taskTreeDigest` 与原 `report.json` 的 `workspaceDigest` 一致。
- **运行条件**：
  - 沿用原 arm 策略：A 为 Solo，D 为委派 + 摘要压缩。
  - 使用 v2-r7 运行时。
  - 两组修复预算相同，均为 `maxModelCalls: 60`。
- **公开反馈**：
  - agent 通过 `test.run` 工具获得 AVA 反馈，测试在隔离的 Linux 容器中运行。
  - 容器为 `kodo-ky-test:e55482f55be2`，基于 `node:24-bookworm-slim@sha256:55fb5f5a…`，依赖按冻结的 `package-lock.json` 执行 `npm ci --ignore-scripts`。
  - 目标文本只说明“公开回归集未通过”，不含隐藏断言。
- **容器预检**（零费用，每次运行前执行）：

  | 检查项 | 结果 |
  |---|---|
  | 基线回归 | 241 通过 |
  | D1 副本 | 按预期失败 |
  | 网络 | 回环可用；外网 `ENETUNREACH`，DNS `EAI_AGAIN` |
  | 写入 | 挂载的工作区和依赖只读，只有 tmpfs 副本可写 |
  | 超时回收 | 5 秒超时后回收进程，无残留容器 |

## 结果

| 试验 | 状态 | 隐藏验收 | 宿主 AVA（Windows） | test.run 调用次数 | 模型调用 | 总 tokens | 未缓存输入 | 输出 | 耗时 |
|---|---|---|---|---|---|---|---|---|---|
| A1 | completed | 14/14 | 3/3 次通过（250） | 9 | 42 | 1,535,119 | 99,236 | 30,443 | 421 s |
| D1 | completed | 14/14 | 3/3 次通过（249） | 7 | 38 | 1,089,360 | 137,703 | 29,801 | 359 s |

- **计量**：两组都没有未知用量，relay 的 `estimated` 为 false，`unmeasured` 为 0。relay 加权 tokens（cache read 计 10%）合计 529,940，共 80 次请求，矩阵没有提前停止。
- **受保护文件**：没有新增、删除或修改。
- **修复过程**：
  - 两组都在第 0 步先调用 `test.run`，拿到原失败标题后才修改。
  - A1 修复 `source/core/Ky.ts`：把错误响应体的读取和解析放进整体预算的竞速中。
  - D1 修复 `source/core/Ky.ts`：只有整体预算耗尽时才不发送请求。
  - D1 把已有测试 `shouldRetry: works with TimeoutError` 改为期望 3 次 `TimeoutError`、4 次请求，并写明理由；参考实现的这个测试也是同样的期望。
  - 修改后，两组在运行中的 `test.run` 都报告公开回归集全部通过，并补跑了其他测试文件。

## 遗留问题：agent 自写的计时测试在容器里不稳定

运行结束后，宿主在容器里复跑公开回归集。两组各有一项 agent 自写的测试失败，基线中都没有这两项测试：

| 工作区 | 失败测试 | 容器默认并发 | `--concurrency=1` | 单独 `--match` | 宿主 Windows |
|---|---|---|---|---|---|
| A1 修复后 | `totalTimeout budget is shared by attempts and not reset on retry` | 5 次中 2 次通过 | 3 次中 1 次通过 | 未测 | 3/3 通过 |
| D1 修复后 | `caller cancellation during the retry delay stops further requests` | 5 次中 0 次通过 | 3 次中 1 次通过 | 3/3 通过 | 3/3 通过 |

- **A1**：测试依赖“第一次尝试耗时 100 ms、整体预算 150 ms”，期望第二次请求已经发出。
- **D1**：测试在 100 ms 时取消，期望第一次请求已经到达服务器；在负载下实际请求数为 0。
- 两项都属于任务明确禁止的“以真实等待时间恰好相等作为正确性依据”。agent 在运行中调用 `test.run` 时恰好通过，所以没有发现问题。
- 修复前的副本同样有计时敏感项：
  - D1 副本中，`caller cancellation…` 在容器里 3/3 失败。
  - A1 副本中，原失败项在 `--concurrency=1` 下 3 次只失败 1 次。

## 结论

- 公开测试反馈让两组都修好了原先导致失败的回归，隐藏验收达到 14/14，没有删除或弱化无关断言。D1 对已有断言的修改与参考实现一致。
- 两组都留下了依赖计时的测试，宿主 Windows 环境下通过，负载更高的容器里不稳定。可见“一次通过”不足以作为证据。
- 样本只有两次，只能描述现象，不说明稳定的恢复率。

## 运行后的改动

- `container/run-tests.mjs`：`runInContainer` 新增 `cpus` 参数用于诊断，默认值 4 与运行时相同。
- `eval.mjs`：注册信息中新增 `trialSha256`。

因此，当前这两个文件的哈希与本次 `registration.json` 中记录的不同。agent 运行所用的命令行为没有变化。

## 建议

- `test.run` 可以选择对新增或修改过的测试重复运行 N 次，报告不稳定的标题，使 agent 能自行发现计时依赖。
- 容器预检加入一项重复运行检查：基线在 N 次运行中必须全部通过。
- 在下一轮 Solo 与开放委派的成对对照中，固定使用这套容器反馈，并把不稳定性检测作为预注册的一部分。
