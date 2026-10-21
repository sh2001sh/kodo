# 执行补强

本轮承接[竞品机制调查](competitor-problem-handling.md)，补齐已复现的执行缺口。工具失败、运行完成与任务正确性分别留证，不通过放松未知写入保护来提高表面通过率。

## 任务完成验收

宿主在运行前调用 `app.setCompletionValidator(run.id, validator)`。回调接收 `{run,response,signal}`，返回 `{passed,feedback?,evidence?}`。模型自然停止时才触发，验收结果及证据存档；失败反馈进入下一次模型请求，最多两次纠正机会，仍不通过返回 `QUALITY_FAILED`。纠正继续消耗同会话预算。

```js
app.setCompletionValidator(run.id, async ({ signal }) => {
  const evidence = await inspectDeliverable(signal);
  return { passed: evidence.passed, feedback: evidence.feedback, evidence };
});
const final = await app.run(run.id);
```

验收回调是可信宿主代码，必须处理取消，不能由模型或报告内容自行注册。`requiresValidation` 持久化，但函数不会序列化：重开后须为非终态运行重新注册，否则运行中断并提示恢复，不静默跳过验收。仅沿带审计记录的写入恢复链继承回调，普通后续任务须另行注册。验收期间新用户决定优先处理，取消后不继续修改终态。

若回调忽略取消信号且永不返回，运行状态能取消，但驱动仍等待该回调；宿主检查应有自己的可取消 I/O 或期限。

未配置验收时完成结果为 `quality.status=not_checked`；配置并通过才为 `passed`。这只证明所注册检查覆盖的范围。

真实报告评估已接入此接口：结构检查和事实检查分别输出；后者只拦截此前独立核验确认的三类错误（恢复身份、历史 offset 上限、file.search 错误行为）。不等于通用事实核验，也不能证明未命中的陈述正确。同名报告只验收最新且非 stale 的版本，所有旧版本仍保留供审计；不同名称报告仍一起检查。

仓库报告必须实际读取至少三份不同文件，其中至少一份为 `src/` 源码；只引用路径或阅读文档不能替代。修复评估的单次工具期限现为 60 秒：本机全套回归实测 31.82 秒，旧 30 秒期限会在追加全量测试时中止。超时仍按原未知写入规则处理，不自动重放。历史 30 秒条件下的失败原样保留。

## 工具证据

- `file.read` 使用从第 1 行开始的 `offset`、`limit`、`maxChars`，以及处理长单行的 `contentOffset`；按返回的 `next` 续读。默认 200 行／8000 字符，最大 32000 字符；每页对完整文件计算 SHA-256，最大文件 16 MiB。重复请求会重新扫描文件。
- `artifact.read` 通过 `contentOffset/maxChars` 分页。进程输出产物内容为 JSON，拼接各页后解析可得到 stdout/stderr 和退出信息；产物仍受会话访问控制。
- `process.exec` 每路预览 4000 字符，较长输出保存在 `outputArtifact`；总捕获 2 MiB，超过后停止并标为不完整，不能声称保留了全部输出。明确未启动为 `PROCESS_START`，启动后不确定状态仍保留 `UNKNOWN_WRITE` 审计。
- 相同工具及规范化参数连续三次得到相同结果时给出纠错反馈，第四次重复停止。非零进程退出忽略耗时等日志变化；文件 hash 或结果变化视为进展。协作消息、产物写入不使用此规则。它是连续重复保护，不识别所有低效策略。

## 模型窗口、失败预算与缓存

`maxContextTokens` 默认 256000，发送前预留输出。真实 usage 只校准匹配模型绑定、工具 Schema 与完整前缀的请求；新增消息按 UTF-8 字节保守估计。规则和必要资料无法装入时明确报 `CONTEXT_LIMIT`。长工具轮保留调用关联、供应商签名数据与可追溯摘录；原文归档。没有额外调用模型生成语义摘要，也未加入精确 tokenizer。

重试由内核统一执行，最多三次；SDK 内部重试关闭。Retry-After 最大等待 60 秒，等待可取消且计入时间预算。认证、配额、上下文、参数错误不会盲重试。HTTP 429 按用户指定口径计零 token、释放该次预留，仍计请求数；其他失败缺少 usage 保留预留估计。HTTP 200 流内错误或心跳后裸 JSON 错误能够分类，不能据此推断上游是否扣费。

缓存提示必须显式 `promptCache:'session'`，默认关闭。OpenAI 两协议发送会话 `prompt_cache_key`，Anthropic 稳定 system 块发送 ephemeral `cache_control`。返回 usage 的 `input` 包含缓存输入；`cacheRead/cacheWrite` 是子集，计算成本时应按供应商单价拆分，不能再次加到总 token。CodeGo 的提示支持及缓存收益需要独立实测，未以暖场请求制造命中率。

## 验证入口

```powershell
npm run check
npm test
node 'scripts/comparison/assessment.test.mjs'
node --test 'scripts/comparison/metrics.test.mjs'
node 'scripts/demo-kernel.mjs' --scripted
node 'scripts/demo-kernel-recovery.mjs'
npm run eval:tasks -- --repeats 1 --context-tokens 256000
```

最后一项调用实际供应商，需本机环境配置。每次保存独立证据，失败不会被后续运行覆盖；历史比较的提示、工具与验收条件和本轮不同，不能直接归因为性能或缓存改善。

2026-10-20 本地验证原始摘要：

```text
> tsc --noEmit -p tsconfig.json && eslint src tests scripts
exit 0

Test Files  18 passed (18)
     Tests  332 passed (332)

ℹ tests 25
ℹ pass 25
ℹ fail 0

PASS kernel demo (scripted)
PASS kernel recovery demo (scripted)
```

## 真实任务复测

使用 CodeGo `glm-5.3`、Chat Completions，窗口 256000 token、输出预留 3072，字符上限不额外收紧，缓存提示关闭。每项一次，单次工具上限 60 秒；两个修复任务在独立副本植入缺陷，并以未修改的行为验收程序核验。结果：自动验收 **3/3**，计入报告独立事实复核后 **2/3**。

| 任务 | 复核结论 | 模型调用 | 工具调用 | 实际总 token | 执行时间 |
| --- | --- | ---: | ---: | ---: | ---: |
| 仓库试用报告 | 结构和三类事实检查通过，但独立复核发现 1 处实质错误，需纠正 | 8 | 13 | 65145 | 99.2 秒 |
| 历史分页修复 | 相关测试、完整回归及独立行为验收通过，仅修改目标源码 | 9 | 9 | 57724 | 130.2 秒 |
| 双子代理修复 | 两个子代理完成各自修复与验证，主代理复核，两项独立行为验收通过 | 20 | 26 | 115762 | 201.3 秒 |

报告错误是排他性声称“只有旧快照标记/问题消息可被丢弃”；实际也可将完成的模型／工具轮次及已消费普通代理消息从当前上下文省略并归档。另有取消运行的“副作用核实”与“恢复执行”措辞歧义，单列为轻微问题。自动验收没有覆盖所有陈述，不能据 `quality.status=passed` 推断全面事实正确。

全部 37 次模型调用都有 usage；表中 token 是输入加输出，缓存部分不再累加。缓存读取／输入分别为报告 `4672/63032`（7.41%）、分页 `9728/56066`（17.35%）、协作 `67392/111011`（60.71%）。本轮没有启用缓存提示，任务与历史样本的提示和读取范围不同，不能据此宣称缓存改善或退化。最大实际单次输入为 14692 token；这是 256k 目标窗口下的任务测试，未进行填满窗口的压力测试。

原始结果：最终复测（本机证据 `../.kodo/task-evaluation-1792479065768-bcee12e6/results.json`，不随源码或安装包分发）、用量和复核汇总（本机证据 `../.kodo/task-evaluation-1792479065768-bcee12e6/verification-summary.json`，不随源码或安装包分发）、报告独立复核（本机证据 `../.kodo/task-evaluation-1792479065768-bcee12e6/quality-review.json`，不随源码或安装包分发）。

之前 30 秒工具条件的首轮结果（本机证据 `../.kodo/task-evaluation-1792478450221-16ba32e8/results.json`，不随源码或安装包分发）原样保留：原始自动成绩 1/3。两个修复的补丁均过独立行为验收，但追加整套回归时工具超时，触发未知写入保护或同会话暂停；报告当时的验收还未要求实际阅读源码。后续提高工具期限并补上源码读取检查，条件已经变化，不能把两轮成绩作为受控性能或可靠性提升的统计证据。
