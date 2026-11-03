# Kodo 黄金评测设计与样例规范

日期：2026-11-03。状态：评测契约，阶段 0 的评测基建与样例都按本文实现。依据 [最终产品定位与执行方案](kodo-final-positioning-20261103.md) §5 阶段 0。

本文只定义“怎么测”，不定义“怎么改”。任何删除、收敛、机制实验，都必须先用同一套配置跑基线，再用同一套配置重跑。

## 1. 目标与范围

- 10 个黄金样例：文献 4、数据 3、报告 2、编码 1。
- 每个样例 3 次，用当前默认配置跑：`Application` 默认 `toolProfile=compact-v2`、默认卡、默认压缩策略，不启用任何实验开关。
- 记录：合格率、费用（token 计费，可选用价格换算）、耗时、缓存读取占比、重复读取率、逐请求模型与计费字段、污染格。
- 阶段 0 材料先用文本化版本（md、csv、txt；PDF/Office 在阶段 3 换回原始格式后重跑同一批样例）。

## 2. 目录布局

```
eval/golden/
  README.md                 # 本契约（实现为 scripts/golden/README.md 的引用）
  cases/<case-id>/
    case.json               # 元数据与任务
    workspace/**            # 复制给模型的工作区种子（材料、代码）
    rubric.json             # 评分标准
    verify/**               # 可选：不给模型看的验收资产（held-out tests 等）
scripts/golden/
  run.mjs                   # 评测入口
  score.mjs                 # 评分引擎（纯函数，可单测）
  metrics.mjs               # 指标汇总（纯函数，可单测）
  README.md                 # 运行方法与 schema 摘要
```

运行产物写到 `.kodo/golden/<stamp>/`（已被 `.gitignore` 忽略），不污染工作区：

```
.kodo/golden/<stamp>/
  registration.json         # 代码/构建摘要、cases 摘要、模型、预算、计划、开始时间
  progress.json             # 每格开始/结束；崩溃后可判定中断
  runs/<case-id>/r<repeat>/
    workspace/              # 运行后的工作区（含产物）
    state/                  # Kodo 数据目录
    wire/                   # relay 逐请求记录：request-N.json、response-N.sse、relay.json
    report.json             # 单次运行结果：状态、评分、指标、污染标记
  summary.json              # 基线/重跑汇总
```

## 3. case.json

```json
{
  "schemaVersion": 1,
  "id": "lit-01-comparison-table",
  "category": "literature",
  "title": "四篇论文方法与结果对比表",
  "objective": "给模型的完整任务提示。材料在 materials/ 下，交付物写到 deliverables/ 下。",
  "limits": {
    "contextTokens": 1048576,
    "outputTokens": 393216,
    "maxOutputTokens": 16384,
    "maxModelCalls": 100,
    "maxTokens": 3000000,
    "maxToolCalls": 300,
    "maxDurationMs": 2700000
  },
  "permissions": ["read", "write", "exec"],
  "deliverableDir": "deliverables",
  "smoke": { "minModelCalls": 1, "minToolCalls": 1, "requireEventPrefixes": [] },
  "materialsGlobs": ["materials/**/*"],
  "notes": "出题说明，不进入模型上下文。"
}
```

约定：

- `limits.contextTokens/outputTokens` 是模型能力上限（deepseek-v4.1-flash：1048576/393216，取自既往评测注册）；`maxOutputTokens` 是每次请求的输出预留上限；`maxTokens` 是整次运行计费 token 上限（缓存读取按 100% 计）。
- `permissions` 统一 `["read","write","exec"]`，除非样例明确要求只读。
- 任务提示必须自包含：不依赖模型知识里的外部文件，不要求联网；材料、验收路径都能在 `workspace/` 里找到。
- `materialsGlobs` 用于引用校验：交付物里引用的来源路径必须落在这里声明的目录内。
- 编码样例可以带 `workspace/` 代码库；验收在 `verify/` 与 `rubric.json` 的 `command` 检查里。

### 3.1 评分前的工作区处理（`grading`）

编码类样例需要“恢复原始测试 + 注入不可见验收用例”，case.json 用 `grading` 声明：

```json
"grading": {
  "restore": ["tests", "conftest.py"],
  "stage": [{ "from": "verify/stage", "to": "_verify" }]
}
```

- `restore`：评分前，把 `eval/golden/cases/<id>/workspace/` 下的这些路径**原样覆盖**回运行工作区，防止模型改动测试作弊，同时保证既有测试是“新代码 + 原始测试”的回归。
- `stage`：把 `eval/golden/cases/<id>/<from>/` 复制到运行工作区的 `<to>/`，用于 held-out 验收脚本。
- 两者只影响评分，不影响模型运行期间看到的内容；评分引擎必须先 `restore` 再 `stage`，最后执行 `rules`/`checks`。
- `protected-unchanged` 的语义：比较运行工作区与样例 `workspace/` 中同一路径的摘要，任一文件新增/删除/修改即失败（路径可以是目录）。

## 4. rubric.json

```json
{
  "schemaVersion": 1,
  "passThreshold": 0.9,
  "checks": [
    { "id": "M1", "kind": "file-exists", "weight": 1, "params": { "path": "deliverables/comparison.md", "minBytes": 500 } },
    { "id": "M2", "kind": "file-contains", "weight": 2, "params": { "path": "deliverables/comparison.md", "all": ["Sample", "Accuracy"] } },
    { "id": "H1", "kind": "human", "weight": 1, "params": { "question": "对比表是否按方法、样本量、数据集、主要结论四列组织？" } }
  ],
  "rules": [
    { "id": "R1", "kind": "citation-sources", "params": { "path": "deliverables/comparison.md", "allowedRoots": ["materials"], "requireExcerpt": true } }
  ]
}
```

判定：

- `rules` 是“不能违反的规则”。任何一条失败 → 本次运行不合格（`violations`），与得分无关。
- `checks` 参与加权得分。`score = Σ(通过项权重) / Σ(已评分项权重)`。
- `human` 项由人工在 `runs/.../human.json`（`{"H1": true}`）中填写；未填写时该项从分母中排除，并标记 `humanPending=true`。人工项全部补评后重算总分与合格率。
- `passed = violations.length === 0 && score >= passThreshold`。
- 未实现 `kind` 视为评测错误（不是失败），必须修评分引擎而不是改样例。

### 4.1 支持的检查类型

参数均为相对 `workspace/` 的路径（`command` 的 `cwd` 除外）。

| kind | 参数 | 语义 |
|---|---|---|
| `file-exists` | `path`（支持 `*` 通配）、`minBytes?` | 产物存在且非空 |
| `file-contains` | `path`、`all[]`、`any[]`、`none[]` | 全部/任一包含、均不包含 |
| `final-contains` | `all[]`、`any[]`、`none[]` | 最终答复文本 |
| `final-regex` | `patterns[]`（字符串或 `{pattern,flags}`） | 最终答复匹配 |
| `csv-columns` | `path`、`required[]` | CSV 表头齐全 |
| `csv-rows` | `path`、`minRows`、`maxRows?` | 数据行数区间 |
| `csv-cell` | `path`、`where{col:value}`、`expect{col:value}`、`tolerance?` | 指定行的单元格值（数字带容差） |
| `markdown-table` | `path`、`requiredHeaders[]`、`minRows` | Markdown 表格结构 |
| `json-values` | `path`、`expect{path: value}` | JSON 产物关键值（点路径） |
| `citation-sources` | `path`、`allowedRoots[]`、`requireExcerpt?` | 引用的来源文件必须真实存在；`requireExcerpt` 时引用的原文片段必须能在对应来源里逐字找到 |
| `protected-unchanged` | `paths[]`、`beforeDigest` | 受保护文件内容未变（运行前后摘要一致） |
| `command` | `program`、`args[]`、`cwd?`、`expectExit`、`timeoutMs?` | 在运行后的工作区执行验收命令 |
| `artifact-count` | `dir`、`glob`、`min` | 产物数量 |
| `human` | `question` | 人工判断 |

### 4.2 引用真实性

- 交付物中的来源写法约定为 `materials/<file>` 或 `<file>`（`allowedRoots` 内）。`citation-sources` 提取形如 `materials/xx.md`、`《标题》` 的引用吗？**不**：只做可机械验证的两件事：
  1. 出现的每个 `allowedRoots` 下文件路径都真实存在；
  2. `requireExcerpt` 时，交付物中带引号的片段（`“…”`/`"…"`，≥10 字）必须能在某份来源中逐字找到。
- 文献样例的“引用必须真实”由这两条覆盖；编造文献标题由 `final-contains`/`file-contains` 的白名单与 `none` 规则补充。

## 5. 运行语义

- 每次运行使用**全新**的 `state/` 与 `workspace/` 副本（`workspace/` 从 `cases/<id>/workspace/` 复制），样例之间完全隔离。
- `Application` 构造：`new Application(stateDir, new ModelProvider(), undefined, {})`，即默认配置；`createRun` 传 `objective`、`workspace`、`binding`、`permissions`、`budget`（来自 case.json 的 limits）、`finalResponse: 'required'`。
- 模型绑定：`{ protocol: 'chat-completions', model, baseURL: relay.baseURL, apiKeyEnv: <relay 占位>, limits: { context, output } }`。真实密钥只进 relay，不进 Kodo 进程。
- relay 复用 `scripts/comparison/relay.mjs`：逐请求保存 request/response、结算 usage、强制执行调用与 token 预算。
- 运行结束条件：`app.run(runId)` 返回；`maxDurationMs` 触发、崩溃、取消都记录为结果，不吞掉。
- 并发：不同样例/重复次数之间可并行（默认 4 并发，`--concurrency`），同一样例的三次运行互相独立。
- 缺省每样例 3 次；`--repeat` 可覆盖。

## 6. 指标定义

单次运行（`report.json.metrics`）：

| 字段 | 定义 |
|---|---|
| `modelCalls` / `measuredCalls` / `unknownCalls` | 持久化的模型调用数；usage 齐全/缺失 |
| `inputTokens` / `outputTokens` / `totalTokens` | 来自 Kodo 持久调用账本（`usageLedger`） |
| `cacheRead` / `cacheWrite` / `uncachedInput` | 账本字段；`cacheReadShare = cacheRead / inputTokens`（`inputTokens>0`） |
| `wallMs` | 会话首事件到末事件的墙钟跨度 |
| `relayRequests` / `relayRejected` | relay 层请求与拒绝 |
| `providerFailures` | 账本中的 `model.failed`（排除主动取消） |
| `fileReadCalls` / `rereads`（main/child 分开） | `file.read` 次数与“同一运行内重复读同一路径”的次数 |
| `childRereadOfMain` | 子运行读取的文件中，主运行在子运行启动前已读过的比例（分母=子运行读取的 distinct 路径数）；无子运行时为 `null` |
| `cost` | 默认 `basis: "tokens"`；传 `--prices input,cacheRead,output[,cacheWrite]`（每百万 token）时给 `basis: "price"` |

汇总（`summary.json`）：

- `passRate`：每样例 `passed` 次数 / 运行次数；报告样例级与类别级（literature/data/report/coding）。
- `meanTokens`、`meanCost`、`meanWallMs`、`meanCacheReadShare`：只对 `usageComplete && !polluted` 的运行求均值；样本不足时给 `null` 并注明。
- `repeatedReadBaseline`：子运行重复读取率与其分母（阶段 2 验收对照用）。
- `pollutedCells[]`：线路/计费异常的结果格。

## 7. 污染与中止

- **污染**：单个 relay 请求出现以下任一情况时，该运行标记 `polluted=true` 并记录原因：
  - 响应里的 `model` 字段与请求 `model` 不一致（线路被换）；
  - `usage` 缺失（`metering=unknown`）且不是主动取消；
  - HTTP 状态非 200（429/5xx 由 relay 记录）。
- 受污染运行仍计入合格率（质量结论保留），但不计入费用/缓存均值；`summary` 中单列。
- **冒烟**：矩阵第一个格必须满足 `case.smoke`（默认 ≥1 次模型调用、≥1 次工具调用）；若第一个格的目标机制触发次数为 0（`requireEventPrefixes` 可配），整个矩阵中止并报 `SMOKE_ABORT`。
- **中止**：`runMatrix` 的 `fatalRules`（受保护文件被改、usage 无法对账、连续两格 provider 失败）触发时停止整批，不产生“通过”结论。
- 评测基础设施自身错误（未知检查类型、schema 不合法、relay 启动失败）直接非零退出，不记为样例失败。

## 8. 基线记录与验收

- 基线产物：`.kodo/golden/<stamp>/summary.json` + `runs/**/report.json`；基线结论另写 `docs/kodo-phase0-baseline-20261103.md`（先写运行配置与样例摘要，数据跑完后补表格）。
- 阶段 1 每批重跑后与基线比较：`passRate` 不低于基线（按 3 次）、`rules` 违规不新增、费用与耗时退化 ≤10%；并单独列出翻转样例。
- 阶段 2 对照 `off`/`summary` 两个基线时，§6 的 `cacheReadShare`、`childRereadOfMain`、深埋事实 QA 准确率与输入 token 是主指标；验收线见定位文档 §2.5（得分 ≥ 开卷 90%，输入 ≤ 闭卷 2 倍）。

## 9. 编码样例（statemachine）

- 沿用 Frontier Harness Eval 的 `python-statemachine-state-data-scoping`（base commit `8d17ba9f6ba8420cf05fddb94013bc221ed9a222`），对应任务说明见 `.kodo/frontier-eval-source/tasks/python-statemachine-state-data-scoping/instruction.md`。
- 仓库快照取自 `.kodo/sandbox-real-statemachine-20261031-r1/original.tar` 的 `app/`（去掉 `.git/` 与构建缓存），放入 `eval/golden/cases/coding-01-statemachine/workspace/`。
- 验收：旧行为回归（仓库原有测试子集通过）+ 新增需求验收用例（`verify/` 下，从 instruction.md 规格编写，不提供给模型）。
- 环境：系统 Python（Anaconda 3.13）已装 pytest/pandas/numpy/matplotlib；样例验收命令用 `python -m pytest`。若依赖缺失，验收命令退化为可执行的子集并在 `case.json.notes` 说明。
