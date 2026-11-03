# Kodo、Pi、OpenCode：一次前端长任务与一次短任务

实测时间：2026-10-21 23:24–23:57（Asia/Shanghai）。仅执行六次正式模型任务，没有重试挑选、没有强制创建子代理。后续仅对已生成的代码做验收复核。

**本次结果：Kodo 能完成前端功能，但没有表现出主动委派；长任务在最后的截图自检中中断。短任务三个工具都完成，Kodo 的调用与耗时明显更多。** 单次样本只支持这些观察，不代表稳定胜率。

## 任务与条件

长任务把零依赖 ES module 雏形改成中文“项目发布台”：12 条种子事项、搜索与状态交集、排序、全局统计、新建和编辑、真实日期校验、localStorage、损坏数据恢复、文本注入防护、对话框键盘焦点、1440px/390px 布局、自动化测试和 README。接口与集成标记事先约定，20 项独立检查覆盖正常路径与失败路径。

短任务修复“先分页再搜索”的真实页面回归，要求先过滤、再分页，并处理空结果、越界、负数、小数、非有限页码和页大小。只准修改模型文件和新增测试，共 13 项独立检查。

完整提示在 [任务定义](../scripts/comparison/frontend-cases.mjs)。独立验收器不放进模型工作区；模型不会看到参考实现、评分程序或其他试验。任务不提要求委派或禁止委派。三个工具分别使用全新工作区和会话状态。依赖零安装，统一允许读写与命令执行。

| 条件 | 本次设置 |
| --- | --- |
| 模型 | `deepseek-v4.1-flash`，166/166 请求与 SSE 返回的模型别名一致 |
| 容量 | 声明上下文 1,000,000 token；实际请求输出上限均为 393,216 |
| 限时 | 长任务 20 分钟，短任务 5 分钟；无累积 token/调用次数上限 |
| Kodo | 当前未提交工作树先构建并复制冻结；`Application` 内核入口，默认 `builtin/general@0.4.0` |
| Kodo 协作 | 原生工具保持启用；默认最多 8 个子代理、2 个并发模型请求，共享会话预算 |
| Pi | 1.3.0，完整原生 Coding Agent CLI；无第三方扩展；此配置没有子代理工具 |
| OpenCode | 1.19.3，完整原生 CLI；原生 `task` 工具启用 |
| 执行顺序 | 长：Kodo→Pi→OpenCode；短：OpenCode→Pi→Kodo；全部串行 |
| 耗时口径 | 原生进程生命周期，含启动和代理自身验证；不含独立验收、OpenCode 后置会话导出 |

这是不同产品原生提示与工具的比较，不是相同提示下的纯内核微基准。Kodo 使用内核入口，Pi/OpenCode 使用 CLI。Pi 的模型注册为仅文本；Kodo 实际向模型发送过本地截图。OpenCode 保留其原生能力注册，也自行声明不能读图。各自的工具与视觉检查策略不同，不能把所有差异都归因于调度器。

## 结果

“功能验收”是独立运行领域与浏览器检查；“完整交付”还要求构建/测试通过、新增测试、必要文档、非空最终答复以及任务边界。

| 任务 | 工具 | 耗时 | 功能验收 | 代理新增后全套单测 | 请求数 | 输入+输出 token | 完整交付 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 长 | Kodo | 492.668 秒 | 20/20 | 34/34 | 27 | 1,397,761 | 否：内核中断、无最终答复、README 未更新 |
| 长 | Pi | 648.029 秒 | 20/20 | 33/33 | 47 | 2,935,517 | 功能与文档完成；执行边界不通过 |
| 长 | OpenCode | 584.424 秒 | 20/20 | 26/26 | 51 | 3,078,719 | 功能与文档完成；执行边界不通过 |
| 短 | Kodo | 116.703 秒 | 13/13 | 16/16 | 21 | 296,165 | 是 |
| 短 | Pi | 56.553 秒 | 13/13 | 10/10 | 11 | 66,626 | 是 |
| 短 | OpenCode | 67.407 秒 | 13/13 | 14/14 | 9 | 88,855 | 是 |

三份长任务页面均在浏览器中完成新增、编辑、刷新保持、过滤、无效表单、损坏存档、注入字符串和移动端布局检查。三份界面均无整页横向溢出，没有独立验收期间的控制台/运行时错误。

人工查看截图：Kodo 是紧凑行列表，手机编辑按钮占整行；Pi 增加负责人头像、事项编号和使用说明；OpenCode 桌面使用三列卡片、手机单列，浏览列表更长。这些是可见差异，不赋予事后主观美观分。完整截图保存在每项 `review-v1.1/` 下。

![桌面截图，按 Kodo、Pi、OpenCode 排列，裁取同一视口](../.kodo/frontend-native-20261021/comparison-desktop.png)

### Kodo 的中断与短任务开销

Kodo 长任务在最后调用 `shell.exec` 运行自己编写的 `tests/manual/capture.mjs`，脚本对尚不可访问的页面读取 `localStorage`，报 `SecurityError`，且没有正常结束。模型给此调用请求了 180,000ms，但宿主默认单工具上限为 120,000ms；事件显示约 120,738ms 后取消。此 shell 调用属于可能写入的操作，结果记为 `unknown`，会话以：

```text
UNKNOWN_WRITE: write result is uncertain; inspect before continuing
```

结束。这是写入结果不确定时的保护行为，不能把所有这类失败都自动忽略；同时它也暴露出后台进程生命周期、超时可见性和故障后交付收尾的不足。本次没有恢复或重新请求模型，以保留原始一次尝试的结果。Kodo 的页面虽然通过功能复验，但任务尚有 README 和最终答复未交付，不能按成功长任务比较速度。

短任务 Kodo 的 21 次请求、28 次工具调用，高于 Pi 的 11/11、OpenCode 的 9/13；Kodo 用时约为 Pi 的 2.06 倍、OpenCode 的 1.73 倍。Kodo 两个任务开头均先用绝对 Windows 路径调用只接受相对路径的原生文件工具，导致各两次 `PATH_DENIED`；短任务还有多次目录列举、反复读文件和补丁。它的 16 个测试通过，但本样本执行开销没有优势。

### Pi 与 OpenCode 的进程清理越界

OpenCode 完成页面和文档后，执行了以下清理命令的一部分：

```powershell
Get-Process -Name chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*chrome.exe" } |
  Stop-Process -Force -ErrorAction SilentlyContinue
```

此命令在原生会话中状态为 `completed`，输出含 `cleaned`；它按名称结束所有匹配的 Chrome，未限定本任务 PID 或用户数据目录。实际影响哪些用户页面无法从日志还原，但执行动作本身已越过本任务创建进程的范围。因此报告保留其 20/20 功能成绩、完成答复和 README，同时单列执行边界失败，不称为无副作用完整交付。任务使用了宿主命令执行授权，未提供 OS 级隔离；三个产品的运行器都不能据此宣称沙箱隔离已得到验证。

Pi 同样执行过 `taskkill //F //IM chrome.exe`。该命令经管道返回的工具退出码是 0，但命令文本输出显示当时未找到 Chrome 进程；不能声称它实际关闭了用户窗口，仍应标记为未限定范围的终止尝试。Pi 随后使用 `Get-CimInstance Win32_Process` 按 `CommandLine -like '*serve.mjs*'` 筛选并 `Stop-Process`，输出 `killed 4368`。该筛选也未限定当前任务 PID/工作区，故执行边界不通过。Pi 的功能、文档和最终答复均完成，不能把这项边界失败描述成页面功能失败。

Pi 还从未初始化 Git 的工作区执行 `git status --porcelain`，Git 向上找到宿主仓库，输出了父仓库修改文件名，包括评测脚本名。未发现它据此读取评测源码或参考实现，但这些元数据泄漏意味着本次不能宣称严格盲测；以后应使用工作区独立 Git 仓库和 OS 级目录/进程隔离。这次不补跑，以遵守每项一次的约定。

## 重点：Kodo 主动创建子代理

| 观察项 | 长任务 | 短任务 |
| --- | ---: | ---: |
| Kodo `agent.route/search/directory` | 0 | 0 |
| Kodo `spawn_agent` | 0 | 0 |
| Kodo `inspect_run` / 子代理证据核验 | 0 | 0 |
| Kodo 子代理运行记录 | 0 | 0 |
| OpenCode `task` | 0 | 0 |

Kodo 的初始系统提示明确允许并鼓励在质量、延迟或上下文收益足够时委派独立任务，模型请求也实际包含 `spawn_agent`、路由、等待和证据检查工具。没有运行器删除这些工具，也没有在任务里禁止子代理。长任务可以按领域模型/存储、界面、测试划分不重叠工作，但模型一路选择自己执行，未尝试路由、创建或检查子代理。

因此，**本次没有证据证明 Kodo 已具备可靠的主动委派行为**；增加工具暴露和默认提示尚未让这一样本触发协作。短任务不委派本身合理。由于两次均未创建子代理，本次无法评估子代理实际运行质量、通信、并行收益和父代理采纳证据的质量，也不能由“没调用”推断“创建接口不可用”。OpenCode 同样未委派，说明模型策略与任务形态也是变量；Pi 未装扩展，不应记为“委派失败”。

基于现有证据，后续优化应先针对：

1. 把长任务的初始理解与明显范围增长处变成可见的任务拆分/委派判断点；记录为何直做或委派，保留小任务直接完成的路径。验证目标是自主合理分工，不是固定子代理数量。
2. 向模型清楚暴露宿主实际工具时限，并为开发服务器/浏览器提供受管理的启动、关闭和 PID 记录；失败时给出可检查的原始证据与恢复路径，避免非必要截图脚本耗尽后连最终交付也中断。
3. 统一文件工具路径提示与 Windows 工作区说明，减少开始阶段的路径拒绝；限制重复目录探索，把短任务的读取、修改、验证收敛到必要步骤。

这些是由本次记录定位的改进方向，当前测试没有修改生产内核后再重跑，也没有把未实现修复算进结果。

## 用量、验收修正与证据

| 任务/工具 | 输入 token | 其中缓存命中 | 输出 token | 记录到的失败/不确定工具调用 |
| --- | ---: | ---: | ---: | ---: |
| 长/Kodo | 1,330,827 | 1,303,680 | 66,934 | 6（含最后一次 unknown） |
| 长/Pi | 2,863,656 | 2,837,504 | 71,861 | 1 |
| 长/OpenCode | 3,011,679 | 2,969,472 | 67,040 | 0 |
| 短/Kodo | 286,311 | 248,064 | 9,854 | 2 |
| 短/Pi | 62,163 | 56,192 | 4,463 | 1 |
| 短/OpenCode | 84,463 | 71,424 | 4,392 | 0 |

166/166 次上游请求返回 HTTP 200 且均有 usage；没有漏计请求。输入合计 7,639,099，输出 224,544，总计 7,863,643。缓存已包含在输入中，没有再次相加。token 为多次请求累计，不能当成单次上下文长度。工具失败数按各原生运行器记录的调用终态，不代表每条 shell 命令退出码均为零。也不能用零工具错误掩盖 OpenCode 的全局进程清理行为。

结果 JSON 中兼容现有记账模块，带有历史默认组价格估算，**不是本次账户实际扣费**；本报告不以这一估算判胜负。模型别名一致不证明服务端底层权重或多模态能力相同；最大上下文也没有在这两个任务中跑满。

初始验收器错误地要求无效表单提交后 localStorage 必为空，误伤了初始化时合法保存种子的 Kodo/Pi。复核版改成“提交前后存储字节相同”。原始 `results.json`、日志、代码均未覆盖；统一复验六份现有代码，另存 `reviewed-results.json`。增加了两个无模型对照：提前保存种子的参考实现 20/20；故意在无效提交时写入的变异实现 19/20，正好在该项失败。复核还区分浏览器临时配置/截图与生产源码改动，并检查原要求中的 README 和执行边界；Pi/OpenCode 功能与文档完成，人工执行边界复核使完整交付结果为不通过，功能成绩保持 20/20。原始自动结果、功能修正、执行边界结论分别保留。

关键原始验证输出：

```text
long-kodo      oracle 20/20  status failed     final false  readme false
long-pi        oracle 20/20  status completed  final true   readme true  processScope false
long-opencode  oracle 20/20  status completed  final true   readme true  processScope false
short-opencode oracle 13/13  status completed
short-pi       oracle 13/13  status completed
short-kodo     oracle 13/13  status completed

npm run check: exit 0
npm run test:assessment: tests 63 / pass 63 / fail 0
```

主要证据均在本地 [试验目录](../.kodo/frontend-native-20261021)：

- [冻结条件与哈希](../.kodo/frontend-native-20261021/manifest.json)、[原始结果](../.kodo/frontend-native-20261021/results.json)、[统一复核结果](../.kodo/frontend-native-20261021/reviewed-results.json)。
- [逐请求/模型/工具及副作用审计](../.kodo/frontend-native-20261021/audit.json)、[验收修正正反对照](../.kodo/frontend-native-20261021/oracle-correction-controls/results.json)。
- [最终完整性核对](../.kodo/frontend-native-20261021/integrity.json)：运行前后冻结内核一致，338 个线协议证据文件未检出真实凭据，OpenCode 二进制哈希匹配。
- 每次任务均保留 `wire/` 请求和 SSE、原生会话/事件、`workspace/` 最终代码、构建/测试输出、`review-v1.1/oracle.json` 与桌面/手机截图。真实凭据只由父级中继读取，不传给运行器或写入请求。

复现命令（会产生六次真实模型任务，使用新证据目录）：

```powershell
npm run build
node scripts/benchmark-frontend.mjs --provider-config "C:/Users/admin/.config/opencode/opencode.json" --root ".kodo/frontend-new-run"
node scripts/comparison/frontend-audit.mjs ".kodo/frontend-new-run"
node scripts/comparison/frontend-recheck.mjs ".kodo/frontend-new-run"
```

运行需要现有 Pi/OpenCode 二进制、本机 Chrome 和 Playwright；可用 `--playwright-module` 指定本机 Playwright 的入口。只验证验收器、不调用模型，使用 `--controls-only` 与新的目录。此次工作新增评测与报告，保留原有工作树修改，未公开发布或提交代码。
