# Kodo 方法发现诊断（2026-11-03）

修正展示并换用有专属规则的方法后，两次自主运行均主动加载方法，并通过规则验收：**采用 2/2、遵守约定 2/2**。显式正控制另计，加载和验收均通过。因此旧实验 0/6 不触发停止条件。本次只验证这一小任务中的发现和加载链路，不证明阶段、卸载或动态工具具有性能收益。

## 旧数据复核

旧十格首请求消息均未出现 inline；所有 skill.list / skill.load 调用均为零。inline 卡被展示在子 Agent 名册里，没有执行模式或加载句柄。

statemachine-marking 两次、checkpoint 一次尝试 spawn_agent("engineering/implement")，均返回 CARD_EXECUTION，说明仅能 inline 加载。成功创建的子运行实际使用通用卡或 kodo/implementer。因此“模型尝试把方法当队友”有直接证据，“这三张方法已作为子 Agent 成功执行”不成立。错误返回曾提示 skill.load，但模型未继续使用，不能把整个结果单独归因于初始展示。

原始成绩不改写。复核结果保存为 previous-discovery-audit.json；旧报告已补充发现环节混杂，撤除以 0/6 推断停止的依据。

## 实现修改

- 首请求名册显示 execution_modes；inline 卡显示精确 inline_method.id、skill.load 入口和 skill.list 兼容性检查入口，明确加载到主 Agent。
- inline-only 卡不再在功能关闭时出现在初始子 Agent 名册中；启用时明确只有含 child 模式的卡可派发。
- 方法发现独立于子 Agent 路由因素 A，并计入共享指令预算；正文仍按需加载。输入、报告等合同不被误承诺为直接可加载，实际资格仍由 skill.list / skill.load 校验。
- Skill 工具描述明确支持 inline 方法。未改变既有会话的冻结工具绑定，验证针对新建会话。
- 诊断 relay 增加可选的跨运行费用准入、请求数上限及未知计费停止；调用记录改用临时文件写完后替换，修复读取过程中可能看到半份 JSON 的问题。

## 预先固定的条件

使用 codego1 / deepseek-v4.1-flash，返回的 responseModel 也均为 deepseek-v4.1-flash。沿用 FastAPI 容器 `kodo-frontier-trial-fastapi:20261028` 和基础提交 `11614be9021aa4ac078d4d0693a8b5250a1010d8`。

任务是**隔离的合成发布演练**，要求读取 fastapi/__init__.py 的版本并按项目约定交付 release-note.json，不实际发布。方法正文规定 rehearsal_protocol 和专属兼容性文案，描述和自主提示中不含这些值。验收器独立检查文件字段、原始版本、专属约定，并核对版本源文件未变；容器文件差异中源码无修改。

这不是原 fastapi-deprecation-response-headers 功能任务的复测。为满足约 10 credit 的诊断范围，使用一个小任务，顺序固定为正控制、自主 1、自主 2；正控制失败则停止调查，不将其计入自主采用率。

配置为 marking：inlineMethods=true、methodUnloading=false、methodToolView=stable；compact-v2、taskProtocol=3、因素 A–E。每次新容器和新会话，不传递上次结果。上下文上限 1,048,576；输出上限降为 8,192；每次最多 16 次模型调用、30 次工具调用、300 秒。全程共用 10 credit 准入预算，预留 1 credit，在已知累计达到 9 或计费缺失时拒绝新请求；它不能约束供应商最终在途结算金额。

冻结 dist 摘要为 `9338838111f9a1a43db32958015b5187209c89fc0a79c6ed94d0ad2b759a4dd0`。plan.json 在运行前保存，build.json 保存逐文件哈希、脚本及镜像身份，audit.json 确认冻结构建完整且与当前 dist 一致。

## 结果

| 运行 | 加载 | 专属约定验收 | 秒 | API 请求 | 计入自主采用 |
|---|---|---|---:|---:|---|
| 显式正控制 | 成功 | 通过 | 34.375 | 6 | 否 |
| 自主 1 | 成功 | 通过 | 29.451 | 6 | 是 |
| 自主 2 | 成功 | 通过 | 26.962 | 5 | 是 |

自主 1 的工具顺序为 skill.list → file.read → skill.load → shell.exec → file.apply_patch → shell.exec；自主 2 为 file.read → skill.list → skill.load → file.apply_patch → shell.exec。两者加载成功后才创建交付文件，没有派发子 Agent。正控制第一步直接 skill.load。

三次首请求都有方法句柄和 inline 说明，均未提前包含专属规则值。三次均 completed，方法加载事件持久化，独立验收通过。每次均为 28 个工具、1 种工具定义，没有工具视图切换。

17 次 API 请求均收到正常协议终止；其中连接关闭标记出现在协议终止之后，不等于模型失败。输入合计 210,319 token，输出 2,907，缓存读取 162,304。

**计费限制：17 次返回的 usage.credit 全为 0，无缺失字段。这里只报告网关原始字段合计 0，未核对账户实际扣款，不能宣称实际免费，也不据此计算节费收益。** 预算门控与请求/时间上限均已启用；未触发费用停止。

首次启动目录 `.kodo/method-discovery-20261103` 因容器内 HTTP 地址绑定不符合本地地址要求，在模型调用前失败。复用既有本地转发器后修复；该次零模型请求，不计入三次诊断。失败日志与 outcome.json 保留，临时容器已清理。

## 结论边界

旧 0/6 不支持“该模型不会自主加载”。新条件下发现和加载链路可用，不触发停止条件，值得继续做小规模重复对照；本次没有自动启动新的矩阵。

展示、方法内容和任务都改变了，缺少新任务上的旧展示对照，不能将 0/6 → 2/2 称为展示修复的净效应。任务和方法描述有直接匹配，专属规则也具有刻意设计的增量价值；两次成功不能代表陌生任务上的稳定采用率，更不证明通用任务竞争力。

本诊断没有阶段切换、物理卸载或冲突方法，不验证这些机制的收益。将来比较 skill.load 基线、常驻和 marking 时，应保持同一任务、方法价值、发现说明和预算，每组至少三次，并独立记录加载、规则遵守、交付与费用；未授权的后续费用不在本轮执行范围。

## 验证与证据

npm run check、npm run build 通过。5 个相关运行时测试文件 57 项通过；诊断及 relay 测试 15 项通过，1 项因 Windows 不支持发送 SIGTERM 而跳过。首次 relay 检查暴露了 calls.json 非原子写入的读取竞争，修复后复测通过。未重跑全仓测试，旧报告所述 MCP 取消测试问题未在本轮处理。

关键原始输出：

```text
Test Files  5 passed (5)
     Tests  57 passed (57)
ℹ tests 16
ℹ pass 15
ℹ fail 0
ℹ skipped 1
{"cell":"positive-control","valid":true,"loaded":true,"passed":true,"credit":0}
{"cell":"autonomous-1","valid":true,"loaded":true,"passed":true,"credit":0}
{"cell":"autonomous-2","valid":true,"loaded":true,"passed":true,"credit":0}
```

完整证据：`.kodo/method-discovery-20261103-fixed-launch/`，包括 plan.json、build.json、results.json、audit.json、previous-discovery-audit.json、relay 首请求及响应、三份原生数据库和 release-note.json。没有重跑旧十格矩阵。

复用入口：`node scripts/comparison/frontier/method-discovery.mjs --out <新目录>` 只保存计划；加 `--run` 才调用模型。实际调用需要已有 codego1 配置和历史 Docker 镜像。
