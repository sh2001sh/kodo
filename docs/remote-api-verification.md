# 远程 API 接入与真实任务验证（2026-10-20）

本机 llama.cpp 9B 服务已停止。本轮使用 `https://codegoai.com/v1` 的 `glm-5.3`，三种协议的真实工具循环与无效凭据检查均通过。协议连通不代表内核能够可靠完成所有真实任务。

## 使用方式与实现范围

```powershell
$env:KODO_BASE_URL = 'https://codegoai.com/v1'
$env:KODO_MODEL = 'glm-5.3'
$env:KODO_PROTOCOL = 'responses'
# 在本机安全配置 KODO_API_KEY；不要把真实密钥写入项目文件。
npm run build
node 'dist/cli/index.js' run '阅读 README.md，保存能力与限制清单' --allow-write --max-tokens 160000 --json
npm run test:protocols
```

`--protocol` 可覆盖创建运行时的环境配置，取值为 `chat-completions`、`responses`、`anthropic`。未指定时默认 Chat Completions；旧数据保持这一默认。运行、子任务与恢复保留协议绑定，不自动切换供应商格式或启动本机模型。

| 协议 | 端点 | 已实现行为 |
| --- | --- | --- |
| Chat Completions | `/chat/completions` | 文本流、函数工具调用、工具结果与调用 ID 回传 |
| Responses | `/responses` | 文本与函数工具流、`call_id` 对应结果、完整有序输出项及加密推理回传；`store:false` |
| Anthropic Messages | `/messages` | 文本、`tool_use`／`tool_result`、有序内容块与签名思考块回传；`x-api-key` 认证 |

只有完整且正常终止的模型响应才可启动工具。截断、断流、非法调用身份、失败终态均明确报错。Anthropic 请求拒绝重定向；三个适配器不会把供应商错误响应正文写入公开错误信息。SDK 隐式重试关闭。多模态输入与供应商原生服务端工具尚未实现；协议特有历史不能混用到其他协议。

CodeGo 的 Responses 实际返回 SSE，不能假设非流式请求一定得到 JSON。本实现统一使用流式请求。这里只验证上述服务与模型；没有据此宣称所有兼容服务、推理模式或模型均可用。

## 协议与普通回归

最终代码的真实验证原始输出：

```text
3/3 real protocol checks passed
Test Files  14 passed (14)
     Tests  210 passed (210)
```

三种协议分别完成：读取包含随机标识的真实文件 → 写入报告产物 → 用返回的实际 ID 读回产物 → 最终回复包含相同标识。每种协议还用故意无效的测试凭据发起独立请求，均得到 `MODEL_AUTH`。没有使用脚本模型替代远程响应。

| 协议 | 工具与内容核验 | 无效凭据拒绝 | 耗时（含负例） |
| --- | --- | --- | ---: |
| Chat Completions | 通过 | 通过 | 21.0 秒 |
| Responses | 通过 | 通过 | 26.5 秒 |
| Anthropic Messages | 通过 | 通过 | 18.8 秒 |

最终证据：协议结果（本机证据 `../.kodo/protocol-verification-1792454244038-d9922fa7/results.json`，不随源码或安装包分发）、执行日志（本机证据 `../.kodo/codego-protocol-final.log`，不随源码或安装包分发）、210 条回归日志（本机证据 `../.kodo/multi-protocol-regression-final.log`，不随源码或安装包分发）。`npm run check` 也通过。

首次验证脚本误把产物正文对象当作带 ID 的记录，且用不稳定的“未知模型”错误分类作负例，曾输出 0/3；实际三个工具循环已经完成。修正为核对 `artifact.write` 返回的 ID，并以无效凭据作为负例后重新运行得到 3/3。首次记录保存在 `.kodo/protocol-verification-1792453789464-cc9a2599`，第二次记录保存在 `.kodo/protocol-verification-1792453921015-65ad186b`，没有覆盖或隐去。

## 真实任务的条件与验收

真实任务通过内核 Responses 适配器执行，模型为 `glm-5.3`。任务包括仓库试用报告、预置历史分页缺陷修复、两个子代理分别修复分页与 LF/CRLF 身份缺陷。预置缺陷只存在于独立任务副本，原仓库没有这两处回归。

每次使用新会话，不在运行中人工补充提示或代写代码。代码任务必须同时满足：运行完成、限定文件修改、代理真实运行相关测试成功、独立行为验收通过；协作还要求两个子代理完成各自修改。独立验收位于候选工作区外，检查 Unicode 原文无损分页、游标前进、参数和会话权限边界，以及换行身份与非法 schema。原始实现与预置缺陷的正负对照均已执行。

共享预算为 500000 token、70 次工具调用、240 秒活动时间、3072 token 单次输出，普通任务最多 26 次模型请求、协作最多 40 次；最多两个子代理，请求串行。token 包含断流时的保守预留，不可直接当作精确账单。

两组测试分别保留：20000 字符组使用早期 Responses 适配器、每类重复两次，各任务副本保留，但准备时尚未冻结统一源码；64000 字符组使用最终适配器、每类一次，从冻结源码副本准备任务并保存 SHA-256 清单。两组同时改变了上下文限制与适配器版本，不能解释为仅上下文不同的受控对照，也不能声称第一组全部任务来自同一版本快照。

## 20000 字符任务组：2/6

| 任务 | 轮次 | 完整验收 | 模型／工具调用 | 耗时 | 主要结果 |
| --- | --- | --- | ---: | ---: | --- |
| 仓库试用报告 | 1 | 通过 | 13／25 | 94.6 秒 | 保存可读报告，内容和命令符合已读文档 |
| 仓库试用报告 | 2 | 通过 | 24／43 | 173.3 秒 | 保存可读报告，内容和命令符合已读文档 |
| 分页修复 | 1 | 未通过 | 26／44 | 170.7 秒 | 重复探索，`MODEL_BUDGET`，没有修改 |
| 分页修复 | 2 | 未通过 | 26／38 | 215.0 秒 | 补丁通过独立验收，但未运行回归且 `MODEL_BUDGET` |
| 双子代理修复 | 1 | 未通过 | 33／61 | 241.6 秒 | 仅完成换行身份补丁和相关测试；分页未修复，`TIME_BUDGET` |
| 双子代理修复 | 2 | 未通过 | 37／56 | 241.6 秒 | 两处补丁通过独立验收，分页 15 条测试通过；一个子代理及主代理超时，未完成协调交付 |

两份成功报告已人工核查主要事实与命令，均能作为基于仓库文档的试用说明；它们主要读取 README、package.json 与其他文档，不应宣传为源码审计。第二份引用了旧 README 中的 155 条历史回归记录，不能拿该表述证明本轮测试数量；本轮数量以独立保存的 210 条回归日志为准。

```text
2/6 real tasks passed
MODEL_BUDGET: model call or token budget exhausted
TIME_BUDGET: shared session execution time exhausted
```

本组的两次协作实际都有成功的回归执行，但同样受 ANSI 解析问题影响，原 `testsRunByAgent` 为 false。按相同修正复核后为 true；因运行或协作仍未完成，整体成绩保持 2/6。全部原始文件保留，更正另存，不重跑模型来替换失败。

证据：原始结果（本机证据 `../.kodo/task-evaluation-1792453921029-41e987e4/results.json`，不随源码或安装包分发）、输出解析复核（本机证据 `../.kodo/task-evaluation-1792453921029-41e987e4/assessment-correction.json`，不随源码或安装包分发）、执行日志（本机证据 `../.kodo/codego-real-tasks.log`，不随源码或安装包分发）。

## 64000 字符诊断：复核后 1/3

| 任务 | 完整验收 | 模型／工具调用 | 耗时 | 证据与原因 |
| --- | --- | ---: | ---: | --- |
| 仓库试用报告 | 未通过 | 5／10 | 48.3 秒 | 保存了报告，但 `file.read` 除任务说明外仅读取两份文件，未满足至少三份的自动验收条件 |
| 分页修复 | 通过（评分解析更正后） | 6／7 | 64.9 秒 | 只改 `history.ts`，代理执行 15 条相关测试通过，独立验收通过 |
| 双子代理修复 | 未通过 | 11／17 | 90.9 秒 | 一个子代理把 `.mjs` 脚本直接作为程序启动，调用进入 `UNKNOWN_WRITE`；会话暂停，另一修复未交付 |

报告还通过 `file.search` 查找了源码证据，内容覆盖主要能力与限制；上述结果严格保留原自动验收要求，没有把搜索命中改算为文件读取。其“根据代码与文档”的表述应结合实际读取与搜索范围理解，不能作为完整代码审计。

分页任务的原始结果为失败：评分脚本直接在含 ANSI 颜色码的 stdout 上匹配 `Tests 15 passed`，发生假阴性。修正仅在匹配前移除终端控制码，不修改候选代码、测试输出或验收门槛；根据已保存的原输出另存更正记录（本机证据 `../.kodo/task-evaluation-1792454244058-d4b71326/assessment-correction.json`，不随源码或安装包分发），结果为通过。原 `results.json` 的 0/3 和各 `result.json` 保持原样，因此复核后成绩单独表述为 1/3。

```text
Test Files  1 passed (1)
     Tests  15 passed (15)
{"passed":true,"checks":["lossless Unicode JSON pagination","invalid page bound rejected","foreign history denied"]}
```

证据：本组原始结果（本机证据 `../.kodo/task-evaluation-1792454244058-d4b71326/results.json`，不随源码或安装包分发）、源码清单（本机证据 `../.kodo/task-evaluation-1792454244058-d4b71326/source-manifest.json`，不随源码或安装包分发）、运行日志（本机证据 `../.kodo/codego-tasks-64k.log`，不随源码或安装包分发）。分页修复仅把预置错误游标复原为实际分片结束位置，未改变权限校验或其他行为。协作中断没有恢复重试以改写本次成绩。

## 当前结论

三种协议已可执行真实文本与工具循环。远程模型至少交付了有独立测试证据的单文件修复；当前采样仍暴露上下文压缩后重复探索、报告验收不足和进程工具参数错误，不能宣称真实协作任务已可靠交付。本轮没有修改内核上下文压缩或恢复策略来提高成绩。

协议验证进程退出码为 0；两组真实任务评估退出码均为 1，未通过项目没有被吞掉。全部测试结束后再次检查，未发现运行中的 `llama-server`。源码、构建结果和测试证据经过实际凭据字节扫描，未发现凭据落盘；报告不包含密钥值。

此前本机 9B 的 0/6 主评估与定向诊断见[本机真实任务评估](task-capability-evaluation.md)，与本轮远程结果分开记录。

接口参考：[Responses 创建响应](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages)、[Anthropic 流式响应](https://platform.claude.com/docs/en/build-with-claude/streaming)。
