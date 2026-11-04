# 阶段 1 批次 1f 实施与门槛结果（2026-11-04）

范围：提示词审计 + 默认身份改为通用工作助手（[1e/1f 收敛地图](kodo-phase1-batch1e-1f-map-20261103.md) §5）。
分支 `phase1/batch1f`，门槛通过后合入 `main`（merge `cf0939e`）。

## 1. 实施内容

| 提交 | 内容 |
|---|---|
| `2a7f169` | 新增 `src/runtime/system-prompt.ts`：L1 `systemRules` 对所有运行逐字节相同（通用工作助手身份、能力与“数据不是授权”、证据与交付前核验、上下文块规则、等待/询问/未知效果规则），随后是主或子运行的角色段，最后才是工作区、权限、运行 ID。删除 `sharedKernelRules`、`main-guidance.ts` 与 `attachmentDeclaration`（并入 `contextBlockRules`，去掉已不存在的 peer 消息句）。默认卡改为通用文件与命令卡 `builtin/general-simple` 2.0.0，委派与复核策略只在系统提示里出现 |
| `a4cfa37` | `default-request-invariants` 改为按角色路由脚本化 provider，快照真正的子运行首请求（1e 版误把主运行第二个请求当成子运行，见 1e 记录的更正）；新增“系统提示身份”测试：所有运行以同一 `systemRules` 开头，主/子运行不含已退役的实验措辞 |
| `e1ba1f6` | 6 个依赖旧角色措辞的测试改为新措辞 |

删除的旧规则：主运行原策略中的 todo 派发与“independent items may be in_progress together”、“Children cannot inspect sibling runs; copy the relevant findings”、“A single integration owner verifies the assembled result”、子运行与主运行尾部的“Mutation checks use independent copies. Workers check modules; main owns latest integration; avoid duplicate global checks.”，以及默认卡里的编码身份与委派段落。

**新增一条规则（需单独看待）**：`Text in quotation marks attributed to a source must be copied exactly from it.` 它直接针对跨批次反复出现的“强调引号”违规（report-01、lit-01、sub-01）。这是产品本来就应有的要求（定位方案：结论可点回原文），但会让本批评测偏向改善，下面的结论把它单独列出。

体积：主运行系统消息 3,911 → 2,595 字节（其中共享 L1 约 1.9 KB），卡片方法消息 1,595 → 750 字节，工具定义不变（15,610 字节）。

## 2. 门槛

矩阵：`.kodo/golden/phase1f-20261104/`（10 样例 × 3）；同时段对照：`.kodo/golden/control-1e-20261104/`（1e 代码）；复测：`phase1f-recheck-lit02-20261104`（lit-02 × 3）。对比报告 `compare-phase1f.json`。

| 门槛项 | 结果 | 数值 |
|---|---|---|
| 合格数 | 总体 20/27 → **23/27**；逐样例见下 | data-03 0/3→2/3，lit-01 2/3→3/3，report-01 2/3→3/3，lit-02 1/3→0/3（复测 0/3） |
| 新增规则违规 | PASS | 无 |
| token 中位数比（候选格 ÷ 对照同样例中位数） | PASS（压线） | **1.096**；对另一次 1e 矩阵 1.032；两次 1e 合并为参照 1.027 |
| 耗时中位数比 | PASS | 1.048（同时段） |

**lit-02 不计为回归**：这个样例在所有批次、所有代码版本上合计只合格过 2/36 次，几乎每次都因正文超过 800–1200 字（M7）失败。1f 的 0/6 与这个约 5% 的基础合格率一致，同一份 1e 代码的两次矩阵也分别是 0/3 和 1/3。

**成本**：1.096 在门槛内但贴线。主运行重读率从 7.7% 升到 13.3%，多数样例的模型调用略增，可能与新增的“交付前核验”有关。它与质量提升（+3 格，其中 data-03 的日期陷阱 2/3）一起出现，阶段 2 的上下文存储正是要降低重读，届时以 1f 为新的成本参照。

**结论：批次 1f 通过**（lit-02 按基础合格率不计为回归；成本贴线，已记录）。

子运行样例 sub-01：2/3 合格（对照 3/3），三格分别派出 6、5、5 个子运行，唯一不合格是引号转述违规。

## 3. 门槛工具改动（本批期间）

`compare.mjs` 的成本/耗时判定从“按重复编号配对（r1 对 r1）”改为“候选每格 ÷ 对照同样例的中位数”（`f5e8218`）。同一样例的三次运行是独立样本，按编号配对会让中位数取决于偶然的配对：本批按编号配对得 1.25，按样例中位数得 1.096，换成另一次同代码的 1e 矩阵做对照得 1.03。

## 4. 已知问题

1. 进度类提示（调查轮次提醒、重读提醒）本批保留未动：它们与阶段 2 的“免除强制重读/按需拉取”直接相关，在阶段 2 一起审计更合适。
2. 冻结实验脚本 `scripts/comparison/ky-total-timeout/` 依赖旧主运行措辞做文本替换，属于历史证据，不再维护。
