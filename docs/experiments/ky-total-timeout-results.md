# Ky `totalTimeout` 真实模型实验结果

日期：2026-10-25。模型：`deepseek-v4.1-flash`。真实 API：`codego1`。最终注册：`ky-total-timeout-v1-r4`。

## 结论

本次没有得到完整 2x2 效果结论。r4 完成 A1 和 D1 后，D1 的沙箱进程调用达到 120 秒工具时限，写入效果按内核规则标为未知；预注册停止规则随即终止矩阵。B1、C1 和第二 block 均未开始，不能计算 B-A、C-A、D-B 或 D-C。

现有证据支持三个较窄的判断：

1. A1 的实现通过隐藏验收 T01-T11 和 T13，但没有完成回归修正、测试、文档、`DELIVERY.md` 和最终答复，完整交付失败。
2. D1 安装摘要后显著降低主代理输入峰值和累计 token，但没有进入实现，最终因一个无价值的嵌套 Git 检查超时而停止。不能把 token 降低称为效率收益。
3. D1 开放自主委派但没有创建子代理，也没有调用委派控制。当前可观察采用率为 0/1 个有资格 trial，样本不足以估计稳定频率。

默认摘要开关应继续关闭。本批首先暴露的是交付路线和工具使用可靠性，而不是摘要事实保留能力。

## 冻结与入场验证

- Ky 基线：`3713ce8d4bc50db655837bb1dd79550df24219fc`
- 参考 head：`d96ff8add845cbd1db99249cde1747ac71df9af6`
- 参考合并：`c20d7c78da256a89d56138e9091d0253b83cde99`
- Node：`24.13.0`；npm：`11.6.2`
- lock SHA-256：`e55482f55be21fd3fcce0ec5480e24e3a2f7215f7613ebe8cc29a200b1732f0f`
- G1：参考实现及 M1-M4 各三次验证稳定通过。
- r4 正式目录同卷沙箱预检：16,305 个依赖文件；Node 探针 47.2 秒；TypeScript 46.7 秒；均通过。
- r4 registration digest：`dfab8c73bf273b20f0ea964b701808b4a020517fc34014fe6b62b487014b7ca0`。

r4 注册预先哈希了主 runner、oracle、fixture、launcher 和 source/dist，但没有单独哈希三个共享 runner 依赖。运行后复算值为：

- `relay.mjs`：`42c1b4a9438bc0a4cde0e9ba525cf7ae28b7fc9e3d9948942566d9b07619d8a4`
- `v3-eval-common.mjs`：`4244ac133244843e1c56c85cd1b9f0dd098bc58ed272b7034ea819276cb6f6e9`
- `v3-eval-matrix.mjs`：`1d5cb7604fe78537c1af2e02c0203948c65aae23db0fe96e01eec13a97e69fdd`

这些是运行后记录，不等价于预注册。因此严格的 G3 依赖闭包冻结不完整；原始请求、响应、usage 和验收证据仍可复核，但本批不能宣称达到完整预注册强度。

正式证据位于 `.kodo/ky-total-timeout-paid-20261025-r4/`。价格未冻结，只报告 token，不推导金额。

## r4 结果

| 指标 | A1：无委派、无摘要 | D1：开放委派、summary |
| --- | ---: | ---: |
| 终态 | `MODEL_PROTOCOL` | `UNKNOWN_WRITE` |
| 完整交付 | 否 | 否 |
| 验收 | 12/14 | 4/14 |
| API 请求 | 50 | 48 |
| provider 完整 token | 1,800,795 | 806,961 |
| provider 输入 | 1,775,782 | 774,463 |
| provider 输出 | 25,013 | 32,498 |
| provider 缓存读 | 1,587,840 | 572,795 |
| 主代理输入峰值 | 52,727 | 21,234 |
| Agent 时长 | 381.9 秒 | 646.2 秒 |
| 工具调用 | 78 | 60 |
| 重复读取 | 29 | 36 |
| 子代理 | 不可用 | 0 |
| 摘要安装 | 0 | 5 |

provider relay 对 98 次请求均取得 usage，`estimated=false` 且没有 relay 拒绝。Kodo 状态中 A1 和 D1 各有一个响应未能正常安装，因此 session ledger 分别只显示 1,773,474 和 782,768 token；上表采用 relay 的完整 provider usage，不把未知调用按零处理。

### A1

A1 在约第 44 次请求后才开始写实现，最终修改 `source/core/Ky.ts`、`source/core/constants.ts` 和 `source/types/options.ts`。隐藏验收结果：

- T01-T11：全部通过。
- T12：失败；上游定向回归有 10 个失败、2 个在工具验收时限内未结束。
- T13：通过。
- T14：失败；没有测试改动、README 更新、`DELIVERY.md` 内容或最终答复。

第 50 个 provider 响应请求了不存在的 `file_read`，而冻结工具名是 `file.read`。provider 以 `finish_reason=tool_calls` 正常结束，但 Kodo 按协议拒绝该完成响应并终止。已有功能代码被保留并接受独立验收，没有追加免费收尾调用。

这说明模型在任务功能上取得了较大进展，但完整交付仍失败。12/14 不能等同于任务成功。

### D1

D1 共发生 6 次摘要模型调用，其中 5 次安装成功；另一次输出达到 8,192 token 后以 `MODEL_INCOMPLETE` 失败，随后同一摘要尝试成功。按 relay 补齐后：

- 摘要调用实际消耗 122,669 token，占 D1 总 token 的 15.2%。
- 主代理输入峰值比 A1 低 59.7%。
- D1 总 token 比 A1 低 55.2%。
- D1 时长比 A1 高 69.2%。

这些差异不能解释为摘要收益：D1 在 42 个主代理请求内没有修改源码、测试、README 或 `DELIVERY.md`，而 A1 已实现大部分功能。D1 还进行了 36 次重复读取，高于 A1 的 29 次。

最终失败来自模型发起的：

```text
node -e "... execSync('git status --porcelain') ... execSync('git log --oneline -3') ..."
```

冻结副本没有 `.git`，该检查不属于交付所需路径。命令达到 120 秒工具时限后被取消。`process.exec` 已开始且具有潜在写入能力，内核无法证明副作用未发生，因此正确标记为 `unknown` 并阻止后续写入；这不是 sandbox cleanup 失败。

### 委派

D1 暴露了 `explore`、`spawn_agent`、等待、消息和检查能力，但记录为：

- 创建子代理：0
- `explore`：0
- `spawn_agent`：0
- 主代理观察子结果：0

因此本批没有测到自主委派的质量或成本效果。只能报告“开放后未采用”，不能报告委派无效。

## 被排除的运行

以下目录保留为基础设施诊断证据，不并入 r4 效果比较：

- r1：Windows AppContainer 准备/清理失败；矩阵被人工终止并离线封存。
- r2：relay 用 UTF-8 字节而不是 token 做下一请求预留，A1 在 1,867,774 token 时被本地预算错误拒绝。
- r3：预检只在 C: 临时目录执行，未覆盖 E: 仓库卷的 ACL；正式 A1 在设置 Low Integrity 前失败。

r2 后 relay 改用 Kodo 带余量 token 估算做请求预留，provider usage 仍是最终账本。r3 后 launcher 在宿主只有 `Modify`、没有 `WRITE_OWNER` 时临时授予所需位，设置标签后精确恢复原 DACL；预检也改为在实验输出同卷运行。

## 判定

- 有效性：r4 的策略注册、provider 计量和已运行 trial 的验收证据完整；内部矩阵检查为有效但不完整。共享 runner 依赖没有逐项预哈希，严格 G3 冻结不完整。
- 交付：A1、D1 均未完整交付，不能称质量持平。
- 压缩：观察到输入容量下降和 15.2% 摘要开销，但没有观察到交付收益。
- 委派：有资格的唯一 trial 未采用，无法评估。
- 成本：价格未知；失败 trial 的全部 2,607,756 provider token 均计入实验成本。

根据预注册规则，不补跑 D1，也不以 r5 替换本次失败。下一次实验应是新的注册，且首先针对“冻结副本禁止无效 Git 调查”和“长命令在工具时限前收尾”做零付费行为验证；在此之前扩展付费矩阵没有足够依据。
