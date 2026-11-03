# 审查修复与预算取舍

2026-10-20 对用户报告逐项核对，报告涉及的实现缺口均存在。以下为当前行为；历史评测文档的数字与旧失败案例保留，不作为新版本的成绩。

| 问题 | 当前处理 |
| --- | --- |
| 等锁取消误判未知写入 | `Call.effectState` 将登记和外部副作用分开。取得工作区锁后仍要通过权限、路径、哈希检查；仅在启动进程或原子替换前记录 started。取消、恢复、写入屏障均读取该阶段。旧记录缺少标记时保守处理。 |
| 通用进程被视为写入 | 通用 `process.exec` 维持潜在写入分类；新增宿主完整命令白名单 `process.run`，程序和全部参数逐项匹配，不允许模型自称只读。 |
| 预算过低、字符上限遮蔽窗口 | 取消预算档位，按端点元数据、模型目录或宿主声明读取窗口与输出能力；未知型号可使用明确标记的暂定值。累计 token、调用次数、活动时长及字符上限默认不限，仅执行显式限制。 |
| 中文估算偏高 | 中日文字、韩文、ASCII 和其他 Unicode 分别估算，另留协议余量；只有绑定、工具、历史前缀完全一致时复用供应商实测 input，新文本单独估算。 |
| 退避占用模型槽位 | 退避前释放，重试时重新排队，保留主代理优先级与每次尝试独立预留。退避仍占用总活动时限，避免无限等待。 |
| 父等待被误结算 | 只结算固定点 blocked 集合内的等待，父代理仍收到通知，健康 any 分支或无关问题继续等待。 |
| 无存储回收入口 | 独占锁后清理 blob 临时文件；基于数据库引用的递归 mark-and-sweep、显式会话保留期与 vacuum。归档、恢复证据和嵌入 JSON 中的引用仍保留。 |
| 热路径扫描 | runs/session、events/run、message/reply、call/effect/status 索引；收件箱按 recipient/seq 查询，写入屏障仅查询候选调用，等待刷新与死锁检测按会话运行。没有引入需要额外事务失效规则的缓存。 |
| CLI 缺少验收 | `--verify-command` 完整 JSON argv，证据持久化并参与最多两次纠正；配置随会话保存，恢复自动接入。无验收时终端明确标记。 |
| 写锁、撤权 | 进程内锁按 canonical workspace 及父子目录重叠关系隔离，跨 Tools 实例共享；撤权中止在途模型和工具。其他进程仍由数据目录独占锁控制，未宣称提供跨数据目录的操作系统项目锁。 |
| 卡片格式 | 设计示例改为当前可解析子集，未来能力包字段明确标为未实现；未知内置工具名在解析时拒绝。 |
| BOM、保护路径、终端 | 哈希覆盖原始字节，读取保留 BOM；扩充密钥文件保护；终端过滤控制字符，JSONL 保留转义数据。可信进程执行的权限边界明确说明。 |
| 包装、发现、版本控制 | 包含运行所需脚本及源码评测材料，README 描述同步；文档改用相对源码链接，本机证据不冒充随包资源；提供 runs/list，新增 Windows/Linux CI。 |

## 公开实现依据

参考版本固定到下列源码提交，不能把这些项目的预算行为说成同一个统一标准。

- [pi compaction，48c8f322](https://github.com/badlogic/pi-mono/blob/48c8f322844087ff6cd80885f093ad44557647d1/packages/coding-agent/src/core/compaction/compaction.ts)：使用最近实测 usage 加尾部估算；压缩默认预留 16384 token，保留最近 20000 token；未实测文本估算为字符数 / 4。Kodo 采用实测前缀校准思路，但对中日韩文本单独加权，没有照搬 / 4。
- [OpenCode compaction，133b1ebf](https://github.com/anomalyco/opencode/blob/133b1ebfafc3ae040b9b23ff3fcad49e273c9cf9/packages/core/src/session/compaction.ts)：按模型 input/context 窗口计算触发点，默认预留约 15%，足够大的窗口至少预留 16000 token；与累计任务费用上限分离。[其通用估算器](https://github.com/anomalyco/opencode/blob/133b1ebfafc3ae040b9b23ff3fcad49e273c9cf9/packages/core/src/util/token.ts)使用字符数 / 4，不能视为中文精确分词。
- [Codex 官方配置参考](https://developers.openai.com/codex/config-reference/)：`model_context_window`、`model_auto_compact_token_limit` 和每个 MCP 服务的 `tool_timeout_sec` 分别配置。页面还说明自动压缩阈值可使用模型默认值。它使用模型能力元数据，不以任务预算档位替代模型窗口。

本次另外核查了自定义模型与在线元数据行为，不能将“没有目录条目”说成竞品都会拒绝启动：

- [pi 自定义模型，73f8de80](https://github.com/badlogic/pi-mono/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/src/core/provider-composer.ts)：自定义条目可以只填型号；缺失 `contextWindow` / `maxTokens` 时使用 128000 / 16384。[OpenRouter 适配](https://github.com/badlogic/pi-mono/blob/73f8de80bc87021375f8b525292ac07492253002/packages/ai/src/providers/openrouter.ts)通过 `/models/user` 读取账户可用窗口；[llama.cpp 适配](https://github.com/badlogic/pi-mono/blob/73f8de80bc87021375f8b525292ac07492253002/packages/coding-agent/src/extensions/llama/provider.ts)优先使用运行时 `meta.n_ctx`，再考虑配置、缓存与训练窗口。
- [OpenCode 自定义模型，60c9be09](https://github.com/anomalyco/opencode/blob/60c9be092129745688bb3c3a752affc6cbd66ede/packages/opencode/src/provider/provider.ts)：允许配置目录外型号，缺失的 context/output 可保留为 0，不能据此声称已知真实窗口。[Modal 适配](https://github.com/anomalyco/opencode/blob/60c9be092129745688bb3c3a752affc6cbd66ede/packages/opencode/src/plugin/modal/models.ts)读取 `/models` 返回的 `context_length` 和 `max_output_length`。[压缩逻辑](https://github.com/anomalyco/opencode/blob/60c9be092129745688bb3c3a752affc6cbd66ede/packages/core/src/session/compaction.ts)在 context 未知或非正数时无法据窗口触发压缩。

## Kodo 的选择及限制

不提供任务预算档位。宿主声明优先；原厂端点的已知型号使用目录；CLI 对第三方端点先做受限元数据发现，读取精确型号的能力字段，优先于同名原厂推断。OpenRouter 先读 `/models/user`，其余读 `/models` 及必要时的 `/models/{id}`。整个发现阶段最多 3 秒、响应上限 8 MiB、不跟随重定向，只发送模型元数据读取请求。取消会在创建运行前生效。同步库入口仍不发网络请求，新增 `createRunWithDiscovery` 供异步宿主使用。

元数据缺失时尝试同名目录，仍未知则采用暂定 128000 / 16384，不再阻止第三方未知型号运行。参数来源、接口失败和缺失字段均明确提示；暂定值不等于服务端真实能力。只识别数字能力字段，不分析模型自述或型号前缀，也不将训练窗口当运行窗口。打包目录来自 models.dev 原厂条目，版本固定；未知能力不会触发收费生成探测。

累计 token、模型与工具调用次数、活动时长、字符上限默认 `null`，表示不限；统计、取消、停滞检测继续有效。有显式限额时保留共享预算与主代理回复预留，恢复沿用原值。工具超时默认 120 秒和并发限制是宿主执行参数，不从模型窗口猜测。

压缩以输入加回复预留是否超过模型窗口或供应商独立输入限制为判据，参考 OpenCode 预留约 15%，大窗口至少 16384 token，并限制到单次输出能力与半个窗口以内。请求中的输出上限再按实际输入、模型输出能力和用户剩余累计 token 限额取最小值，避免预扣整个模型输出能力导致窗口浪费。仍使用确定性裁减与可检索原文归档，没有新增语义摘要调用。

启动时显示模型参数及来源、可选限额。只有用户提供累计 token 限额和输入/输出单价时才投影总费用；无限运行的总费用不可预知。未知用量失败保留预留，供应商实测 usage 用于结算；字符类别估算仍不是精确 tokenizer。

GC 默认只回收不可达数据。用户必须显式提供保留天数才删除终态会话，且按最后事件时间检查，活动、等待、中断及未知写入会话保留。运行期间不允许 GC。旧完整正文事件不会追溯改写，以保留历史证据。

本地回归覆盖正常、失败、取消、超时、并发和持久恢复路径。CI 配置只有在代码进入远程仓库并运行工作流后才有远程执行记录；本轮没有重新请求收费模型，不把旧模型评测计为新版本通过。


## 本轮本地验证

`npm run check` 通过；`npm test -- --reporter=dot` 输出 `Test Files 22 passed (22)`、`Tests 416 passed (416)`；`npm run test:assessment` 输出 `tests 49`、`pass 49`、`fail 0`。协作、上下文与恢复演示输出 PASS。模型参数回归覆盖目录解析、未知型号自动发现及暂定值、同名中转窗口覆盖、部分元数据、精确型号匹配、认证、响应上限、超时与取消、CLI 持久化、独立输入限制、默认不限、显式限额下输出缩减和主代理回复预留。

实际生成 `.tgz` 并在系统临时目录独立安装，只安装生产依赖。安装后的版本、doctor、runs、gc --vacuum 均退出 0；test:provider / test:protocols 可找到并启动脚本，在清空供应商凭据的环境中分别按设计退出 2 / 1 并打印 NOT VERIFIED。没有把缺少凭据的拒绝运行计作真实模型通过。

## 2026-10-21 复审

以下核对当前工作区，不把此前固定版本的通过数或模型成绩更新成新版本成绩。

| 复审项 | 核对与处理 |
| --- | --- |
| `process.run` 长输出 | 缺陷存在。`inspect_run` 对两种进程工具统一恢复 `process-output` 产物，检查所属运行，再按 Unicode 边界分页；均返回 `exitCode` 和 `outputComplete`。回归包含真实长输出进程、非零退出、撤权与跨运行伪造产物。 |
| 默认不限预算 | 保留用户确定的产品取舍，不新增预设或隐含调用／时长上限。非 JSON 启动也明确提醒费用随实际用量增长。持续不同调用不能依靠重复检测兜底，仍需取消或显式限额。 |
| 长窗口估算性能 | 当前代码已有先查实测前缀及有界校准缓存；仍存在逐字符正则和候选重复扫描。新增常见字符码点快速分类，整数权重消除浮点累加误差；单次上下文构建缓存消息序列化、权重与前缀摘要，跨步骤不缓存可变消息。 |
| 窗口为 1 | 缺陷存在。解析配置与合并运行预算时要求上下文至少 2、输出至少 1，创建持久运行前拒绝。 |
| 只读声明恢复／CLI | 当前已持久化 `Run.toolBindings`，只读声明也在摘要中，无需新增重复的会话摘要；重启需宿主重新提供相同声明。新增缺失／变更／相同声明的真实重启验证，以及 CLI `--read-only-commands`，执行与恢复命令均可重新接入。 |
| 中转同名模型窗口 | 按用户要求保留目录回退，不对已知同名模型强加 128k／16k 限额。API 元数据优先；缺失字段沿用目录并明确提示，完全未知型号才使用已有暂定值。新增终端来源提示与部分元数据回归；目录值仍不能证明中转实际支持该容量。 |
| 文档与证据口径 | 更新工作区锁范围、内联迁移、现有 CLI 入口、解析／加载与完整包导入的区别。当前 `.git`、提交及远程配置存在；MCP 轻量客户端及测试存在；协作报告已有六次正式运行，结论仍为“尚无证据证明自主协作改善”。这些不是仍缺失的实现。远程 CI 执行结果未在本轮核实。 |

可复现性能命令：`npm run build`，再执行 `node scripts/benchmark-context.mjs`。Node v24.13.0／Windows，ASCII／中日韩／emoji 混合文本、100 轮工具历史，预热后 5 次中位数，压缩过程包含归档写入。测量为本机微基准，不代表所有任务的延迟：

| 字符数 | 原文本估算 ms：前→后 | 未校准输入估算 ms：前→后 | 压缩 ms：前→后 |
| --- | --- | --- | --- |
| 100,000 | 3.46 → 0.43 | 5.15 → 0.71 | 88.27 → 4.05 |
| 1,000,000 | 29.98 → 4.25 | 35.06 → 4.09 | 2657.21 → 21.89 |

两档文本估算仍为 55,798／557,970 token；已有实测前缀的输入估算约 0.52→0.56 ms、2.77→2.87 ms，未观察到该路径的性能改善。估算并非精确 tokenizer，供应商 usage 仍为实际结算依据。

本次最终验证在固定源码与构建产物后独立运行，关键原始输出：

```text
npm run check                              exit 0
npm test -- --reporter=dot
 Test Files  36 passed (36)
      Tests  594 passed (594)
npm run test:assessment
ℹ tests 56
ℹ pass 56
ℹ fail 0
PASS kernel demo (scripted)
PASS kernel recovery demo (scripted)
npm pack --dry-run --json                   exit 0
```

本轮没有重新请求收费模型或验证远程 CI，不将历史模型评测当作当前版本通过。新增回归另覆盖最新实测前缀匹配时只读取该请求与响应的两个 blob，不扫描较旧完整请求。
