# Agent 卡片与委派设计

日期：2026-10-27（修订 2）。依据 v2-r10 实验（`docs/experiments/ky-total-timeout-v2-r10-results.md`）与现有代码。卡片、运行时、名册、宿主入口、保留流程与实验运行器已落地；当前验证范围和使用约定见第 14 节，不将定向测试等同于第 11 节的全量门禁。

修订 2 根据评审收紧了六处契约：

- 文件范围；
- 委派输入与报告；
- 长期保留的授权；
- 缓存声明；
- 评审只读；
- 名册容量。

同时修正了目录树的成本声明，以及快照、过滤和回退规则；问题诊断改为“事实 + 待验证假设”。

## 1. 问题诊断：事实与待验证假设

### 1.1 已确认的事实

| # | 事实 | 依据 |
|---|---|---|
| F1 | D1、B1 与中断前的 B2 都没有调用 `explore` 和 `spawn_agent`；D1 的助手文本中没有出现委派相关表述 | r10 报告与 wire 请求 |
| F2 | 实验只注册了一张通用卡片，卡片中没有 `agent.route/search/directory`；`spawn_agent` 描述写着 "Specialist routing tools: none here" | `eval.mjs:110`、wire 中的工具描述 |
| F3 | `spawn_agent` 的 schema 只把 `objective` 列为必填；其余任务包字段可选，但 L1 和工具描述要求提供完整任务包与不重叠的写范围 | `spawn-spec.ts`、`context.ts:356` |
| F4 | L1 把 `spawn_agent` 限定为“修改写范围不重叠的独立模块” | `context.ts:356` |
| F5 | ky 任务的源码改动集中在少数几个耦合文件 | r10 任务说明 |
| F6 | 产品层缺少宿主或用户启动子 agent 的入口，也缺少运行中把临时配置保存为长期资产的入口 | `application/index.ts`、`configuration-save.ts` |

F6 是产品能力缺口，不能用来解释模型为什么一次都没有委派。

### 1.2 待验证假设

| # | 假设 | 若成立应观察到 | 检验方式（第 12 节） |
|---|---|---|---|
| H1 | 没有可区分的专家资产，模型认为委派等于复制自己，看不到收益 | 加入名册与预设后，委派率上升 | 因子 A：名册 + 预设 |
| H2 | L1 只把委派写成“并行写”，与耦合任务不匹配 | 改为按价值委派后，测试或评审委派出现 | 因子 B：L1 文本 |
| H3 | 提示要求的任务包让模型高估了委派成本 | 卡片提供输入槽和默认范围后，委派率上升 | 因子 C：输入槽 + 默认范围 |
| H4 | 委派倾向与模型有关 | 换模型后，同一条件下的委派率不同 | 第二模型复核 |

同时改动名册、预设、L1 和工具描述，再与 r10 对比，只能测到组合效果。因此第 12 节按单因子消融设计，所有比较都在新实验内部进行，不与 r10 直接比较。`exploreNudge` 保持默认关闭，不靠计数阈值提醒模型去委派。

## 2. 定位

### 2.1 为什么需要子 agent

| 价值 | 程度 | 成立条件与边界 |
|---|---|---|
| 上下文隔离：领域规范、skill 正文和 MCP schema 不进入主 agent | 确定 | 主 agent 只看名册视图与报告 |
| 能力隔离：前端与后端使用不同的 MCP，彼此不可见 | 确定 | 工具按卡片绑定，权限只收窄 |
| 约束隔离：各领域的设计原则互不干扰 | 确定 | 约束写在成员卡片里 |
| 减少作者上下文的影响：评审时不携带写作者的历史 | 部分 | 同一模型、同一任务材料仍可能犯相关的错误；这只是减少影响，不是独立性保证 |
| 并行提速 | 有条件 | 写范围不重叠、接口与行为契约已先确定、整合成本低于节省的时间 |

写范围不重叠只解决写冲突。源码和测试分开写，并不意味着测试设计与实现已经解耦：测试 agent 依赖主 agent 预先确定的行为契约，契约没有确定时，不应并行写测试。

### 2.2 角色

- **主 agent（负责人）**：唯一能派生、启动、取消子 agent 的角色。负责理解任务和项目、初步阅读、规划、契约、调度、整合与最终验收交付。默认因子 B 下，小任务可直接实现和验证；并行、专业能力或独立上下文的收益超过交接与验收成本时才委派，耦合实现和检查由同一负责人完成。
- **成员 agent（执行者）**：由会话名册中的一张卡片定义，不能再派生子 agent。
- **临时 agent**：主 agent 在名册卡片上叠加只收窄的覆盖层得到，只在本会话内有效。
- 委派树只有一层（用户已确认）。

## 3. 卡片 schema v2

卡片内容按可见性分为三部分：

- 路由元数据：主 agent 可见。
- 能力与私有方法：只进入子 agent。
- 约束：作为上限，只能进一步收窄。

v1 卡片继续可用；v1 缺少的字段按“无路由提示、无输入槽、无报告字段”处理。

```yaml
schema_version: 2
id: kodo/frontend
version: 1.0.0
name: Frontend engineer
description: 实现和修改 Web 界面、组件、样式与交互。

catalog:                       # 目录位置与同义说法，见 6.3
  path: engineering/frontend
  aliases: [界面, 页面, UI]

routing:                       # ① 主 agent 可见
  use_when: [新增或修改页面、组件、样式、交互]
  not_for: [后端接口、数据库迁移]
  mode: write                  # write | review | read，见 3.3

inputs:                        # 结构化输入槽，见 3.1
  - { name: requirement, kind: text, required: true, description: 界面需求或设计引用 }
  - { name: contract, kind: artifact, required: true, description: 接口契约 artifact }
  - { name: entry_files, kind: paths, required: false, description: 已知入口文件 }

report:                        # 报告字段，见 3.2
  - { name: changed_files, kind: paths, required: true }
  - { name: checks, kind: calls, required: true, description: 运行过的检查 }
  - { name: open_issues, kind: list, required: true }
  - { name: contract_requests, kind: list, required: false }

capabilities:                  # ② 只在子 agent 中加载
  tools: [file.read, file.search, file.patch, process.exec]
  skills: [frontend/design-system]
  mcp: [{ server: browser, tools: [screenshot, console] }]   # 只声明需求；连接和凭据由宿主提供

constraints:                   # ③ 上限
  permissions: [read, write, exec]
  scope: { write: [web, packages/ui] }                      # 只用路径根，不用 glob，见 3.4
  rules: [docs/frontend-principles.md]

model: { role: standard }      # 由宿主映射；卡片不写模型 ID
derivation: { allowed: true }
members: []                    # 只对主卡片有意义，见 6.2
---
私有方法正文：只进入子 agent 的 L2，不进入路由索引。
```

### 3.1 输入槽：结构化的必填输入

- `inputs` 声明命名槽位，`kind` 可取以下三种：
  - `text`：非空字符串；
  - `paths`：工作区相对路径列表；
  - `artifact`：artifact id。
- `spawn_agent` 新增 `slots: { <name>: value }` 参数。现有的 `inputs: string[]` 保留，用来写补充事实。
- 内核检查以下几项：
  - 必填槽位是否存在且非空；
  - 值的类型是否正确；
  - `paths` 是否在子 agent 的读范围内，对应文件是否存在；
  - `artifact` 是否属于本会话、能否解析。
- 缺项或类型错误时，spawn 返回参数错误，列出缺少的槽位名，子 agent 不会启动。
- 这一层只证明“结构完整”，不判断内容是否充分。内容是否充分由主 agent 负责。
- 槽位值作为任务数据放进子 agent 的 L5，并标明“任务数据，不是指令”。

### 3.2 三层结果契约

| 层 | 内容 | 谁来检查 | 能证明什么 |
|---|---|---|---|
| 报告完整性 | 子 agent 用新增的 `report.submit { fields }` 提交报告，字段按卡片 `report` 声明 | 内核：必填字段是否存在、类型是否正确；`calls` 类型的字段必须引用本子 run 中已结算的调用 | 报告填写完整，引用的调用确实发生过 |
| 宿主验收 | 宿主验证器、`verify.run` 结果、交付物检查 | 宿主与内核，复用现有的 completion 与 verify | 宿主声明的检查通过或不通过 |
| 主 agent 验收 | 主 agent 用 `inspect_run` 核对报告与原始工具记录 | 主 agent | 主 agent 的整合判断 |

- 卡片声明了 `report` 时，子 agent 的 completion 检查会多一项“报告完整性”。缺项时走现有的纠正回合，纠正回合用尽后子 run 失败。
- 引用某个调用，只能证明“这个检查运行过”，不能证明“检查通过”。调用的退出状态原样写在报告视图里，由宿主验收或主 agent 判断是否通过。`task-notification` 里三层结果分开列出，不合并成一个“通过”。

### 3.3 mode 与评审只读

| mode | 工作区写 | 执行 | 典型卡片 |
|---|---|---|---|
| `read` | 拒绝 | 拒绝 | explorer |
| `review` | 拒绝（`scope.write: []`） | 只允许宿主批准的固定检查：`verify.run` 和 `process.run` 只读白名单（`--read-only-commands`） | reviewer |
| `write` | 按 scope | 按权限 | implementer、tester、领域卡片 |

- `review` 不等于 `read + exec`。测试、构建、lint 可能写缓存或产物，所以评审 agent 不能使用任意 `process.exec`。
- 需要写产物的检查只能走 `verify.run` 的宿主后端，或者在沙箱提供的临时目录中运行。检查一旦向工作区写入，就会被写范围拒绝，并作为失败结果报告，不做静默放行。
- 原生沙箱的临时目录能否覆盖常见工具的缓存位置，需要在 A1 阶段实测；未验证之前，评审卡片只开放 `verify.run`。

### 3.4 文件范围

- 第一版只支持路径根（目录或文件），与 `src/runtime/scope.ts` 的现有语义一致：拒绝 `*`、`?`，按包含关系收窄。不引入 glob。
- 实际范围 = 卡片上限 ∩ 父 run 授权 ∩ spawn 请求，用现有的 `normalizeFileScope` 与包含关系计算。如果请求的根不在上限之内，返回 `SCOPE_ESCALATION`。如果上限与父授权没有共同的根，卡片在会话名册筛选阶段就会被标记为不可启动（见第 4 节）。
- 只按当前匹配的文件展开会漏掉以后新建的文件，所以不采用展开方式。类似 `*.motion.ts` 这样的文件模式需求，第一版用目录根来表达（例如 `web/src/motion`）。glob 范围涉及匹配、交集、冲突检测和沙箱表达，单独立项，不在本方案范围内。
- 测试目录这类与项目相关的根，用占位变量 `${project.tests}` 表示，由项目指令的 front matter 或宿主配置解析为路径根列表。解析不到时，在名册筛选阶段标记为不可启动，并写入原因。

## 4. 三阶段校验

| 阶段 | 时机 | 检查 | 失败处理 |
|---|---|---|---|
| 注册校验 | 写入注册表 | schema、字段长度、`catalog.path` 格式、输入槽和报告字段定义、成员引用是否存在且 digest 一致、工具名是否为已知内置或已注册工具 | 拒绝注册 |
| 会话名册筛选 | 会话开始、构建名册快照时 | 宿主是否提供卡片声明的 MCP server 和 skill；卡片 `constraints.permissions` 与会话权限是否有交集；scope 上限与会话范围是否有交集；占位变量能否解析 | 卡片仍在快照中，但标记为 `unavailable` 并附原因；名册视图默认不显示这类卡片，`agent.directory` 可以看到它们及原因 |
| 实际启动授权 | 每次 spawn | 权限 = 卡片上限 ∩ 父 run ∩ 请求；scope 收窄；与兄弟 run 的写范围是否冲突；子 agent 预算；输入槽 | 返回工具错误，不启动 |

注册时不存在“会话权限”，所以权限与 MCP 的可用性只能在会话阶段判断。

## 5. 上下文组成

| 层 | 主 agent | 成员/临时 agent |
|---|---|---|
| L1 | 内核共享规则 + 主角色 + 身份 | 内核共享规则 + 子角色 + 身份 |
| L2 | 主卡片方法 + `<kodo-context kind="agents">` 名册视图 | 成员私有方法 + 临时覆盖层（追加在后） |
| L3 | 项目指令 | 项目指令 + 写范围子目录指令 + 卡片 `rules` |
| 工具 | 主卡片工具（含 spawn/derive/propose） | 成员工具 + 声明的 MCP + skill + `report.submit`，不含委派工具 |
| L5 | 用户目标 | 任务包：objective、输入槽、补充 inputs、acceptance、报告字段说明 |

- 名册视图属于 L2，随会话快照冻结（第 6.2 节）。子 agent 的启动和结束不改变名册视图；余量和状态放在 `state` 帧里。
- **缓存声明**：当前 L1（`context.ts:356`）在共享规则之后就是角色文本、Run ID 和范围，不同 run 从这里开始就不同了。所以同一基础卡片的多个临时 agent，即使 L2 相同，通常也不能复用 L2 的前缀缓存。本方案不改变这个结构，也不承诺共享到 L2：
  - 继续用现有的 `child.prefix_shared` 记录实际公共前缀的字符数，并用 provider 返回的 `cacheRead` 核对；
  - 如果实测表明值得，再单独立项把身份信息从 L1 移到 L5 之后，并重新验证各 provider 的请求结构。这项改动对模型可见，需要新的实验 id。

## 6. 预设 agent、名册与目录

### 6.1 预设

内置命名空间是 `kodo/*`，随包注册。`builtin/general` 的 `members` 默认引用通用成员。

| 卡片 | mode | 写范围上限 | 价值 | 默认成员 |
|---|---|---|---|---|
| `kodo/explorer` | read | 无 | 大范围阅读与定位，读取过程不进入主 agent 的上下文 | 是 |
| `kodo/tester` | write | `${project.tests}` | 按主 agent 给定的行为契约写回归测试 | 是 |
| `kodo/reviewer` | review | `[]` | 核对差异，运行宿主批准的检查，减少作者上下文的影响 | 是 |
| `kodo/implementer` | write | spawn 时必须给出（不继承整个工作区） | 已划好边界的模块实现 | 是 |
| `kodo/frontend` | write | 模板 `web`，可被项目覆盖 | 前端原则、可访问性、视觉验证 | 否，模板 |
| `kodo/backend` | write | 模板 `server` | 接口、数据、错误处理原则 | 否，模板 |

- `kodo/tester` 的输入槽 `behavior_contract`（artifact）是必填项，用来落实第 2.1 节“先确定契约”的要求。
- 领域模板默认不带 MCP。项目可以在 `.kodo/agents/*.md` 中覆盖或扩展模板。

### 6.2 名册快照

- **会话快照**：会话开始时，内核固定一份成员清单，每个成员记录 `{ id, version, digest, catalog.path, availability }`，来源包括：
  - 主卡片的 `members`；
  - 项目卡片；
  - 已批准的长期卡片；
  - 内置卡片。

  同一 id 按“项目 > 用户 > 内置”去重。快照写入会话表 `roster_snapshots`，并计算快照 digest。
- **digest 覆盖范围**：规范化后的成员清单、`_catalog.md` 节点说明的内容哈希，以及规范化的排序规则（按 `catalog.path`、`id`、版本数字依次排序）。
- **三个检索工具都查快照**：`agent.directory`、`agent.search`、`agent.route` 都把查询限定在快照成员里（在 SQL 层与快照清单做连接），不查实时的全局注册表。翻页游标里带上快照 digest，digest 不一致时游标作废。这样不会出现以下情况：
  - 搜出名册中没有的卡片；
  - 搜出与会话固定版本不同的版本；
  - 翻页过程中候选集合发生变化。
- 宿主侧的 `searchCards` API 保持现在的全局语义，只有模型可调用的工具受快照约束。
- 会话中途批准的卡片从下一个会话开始才进入快照。

### 6.3 目录索引与名册视图

把**完整目录索引**和放进 L2 的**名册视图**分开：

- **完整目录索引**：由会话快照确定性生成的树，包含全部成员。成员不会丢失，任何成员都能通过 `agent.directory` 分页到达。
- **名册视图**：这棵树的一个渲染结果，严格服从预算，可以只显示一部分。

参考 [PageIndex](https://github.com/VectifyAI/PageIndex)：用带摘要的层级结构代替平铺和向量检索，由模型推理选择要展开的分支。与 PageIndex 不同的是，Kodo 的树形状由卡片声明的 `catalog.path` 决定，节点摘要由内核确定性生成，不调用模型。

#### 编写规则（注册时校验）

| 字段 | 规则 | 用途 |
|---|---|---|
| `catalog.path` | 2–4 段 slug，由作者声明，不预置分类表 | 在树中的位置 |
| `routing.use_when` | 必填，写任务形态，不写自我评价 | 叶子行和检索 |
| `routing.not_for` | 建议填写；与兄弟卡片的 `use_when` 重叠时给出警告 | 区分相近的卡片 |
| `catalog.aliases` | 可选，作者给出的同义说法 | 只进 FTS，缓解用词不一致 |
| `_catalog.md` 节点说明 | 可选，每个节点一句话 | 内部节点的任务语义 |

内核不维护任何词表或分类表。

#### 节点摘要

- 内部节点：节点说明（如果有）、成员数，以及子树中**分别出现过的**能力（工具、MCP server、mode）。能力列表按名册视图的剩余预算截断，截断时标出“另有 N 项”。
- 这类能力并集只是结构摘要，只用于初步导航：
  - 它不证明子树中存在**同时满足**多个条件的成员；
  - 没有节点说明、各分支能力又相同时，它也提供不了足够的任务语义。

  因此注册时如果同级节点都没有说明，会给出警告，并建议项目补充 `_catalog.md`。
- 叶子：`id@version`、`name`、一行 `use_when`、`mode`、`availability`。

#### 名册视图的渲染（严格服从预算）

名册预算是 L2 指令预算中分给名册的部分（指令总量上限沿用 `docs/kodo-overall-optimization-design.md` 5.2 节的“不超过输入容量 10%”，不另设常数），按实际渲染出的 token 计算：

1. 先放固定部分：视图头、快照 digest、“完整目录用 `agent.directory` 分页查询”的说明，以及“剩余未显示数量”字段。固定部分本身放不下时，视图只保留这一句入口说明，并写 `context.roster_degraded` 事件。
2. **优先展示**主卡片 `members` 中的固定成员：按声明顺序逐个加入，放不下的计入剩余数量，不保证全部展示。
3. 从根开始广度优先，逐个节点加入，节点超出预算就停止。如果顶层分类就已经放不下，就退化为虚拟根节点：只显示“共 N 个分类、M 个成员”和分页入口。
4. 末尾总是写上剩余未显示的分类数和成员数。

这些步骤不设固定的条目上限，展示多少完全由预算和实际渲染长度决定。

#### 检索与过滤

- `agent.directory { path?, cursor? }`：返回某个节点的直接子节点和叶子，按 6.2 的规范化顺序分页。
- `agent.search { query?, path?, mode?, tools?, mcp?, cursor? }`：
  - 先在**同一叶子**上同时检查全部结构化条件（mode、工具、MCP、`availability`），再在满足条件的叶子中按 FTS 排序；
  - `path` 只限定子树，不放宽任何条件；
  - 内部节点的能力并集只用来决定先展开哪个分支，不能作为匹配结果。
- `agent.route { objective }`：在快照成员中按 `use_when`、`not_for`、`aliases` 排序，返回候选和每个候选不满足的条件。

#### 探索额度的计量

继续使用现有的会话共享探索额度（`maxCalls`、`maxCards`），不另设额度：

- `directory`、`search`、`route` 每次调用都计 1 次调用；
- 返回的叶子按条计入 `maxCards`，内部节点只计调用、不计卡片；
- 已经返回过的同一 `id@version` 不重复计数。

因此“每个成员都可分页到达”不等于“在额度内一定能找到”。额度耗尽时返回 `budget_exhausted`，并带上已经查过的路径和剩余未查的分支数。

#### 成本声明

目录树只是让大名册**可分页导航**，不保证比平铺列表更省 token：

- 分支选错时需要回溯，分页会增加调用次数；
- 节点没有说明时，结构摘要提供的任务语义很弱。

实际成本以实验记录的 `directory/search` 调用数、返回条目数和首次选中位置为准（第 12 节）。

#### 找不到合适卡片时

三种情况分开处理，不统一成“派生”：

| 情况 | 判断依据 | 处理 |
|---|---|---|
| 能力齐全，但方法或约束不合适 | 某张可用卡片满足全部能力条件，`use_when` 不匹配或需要更窄的约束 | 用 `agent.derive` 在这张卡片上叠加只收窄的覆盖层（第 7 节） |
| 缺少能力 | 快照中没有任何可用叶子同时具备所需的工具或 MCP | 返回缺少的能力列表；由宿主配置，或走第 8 节提议长期卡片，并经用户批准。派生不能补出能力 |
| 额度耗尽 | 返回 `budget_exhausted` | 报告“检索未完成”，不当作“没有匹配”；可使用已知且合适的成员，委派仍受阻时明确说明，不静默接管大块实现 |

### 6.4 接口契约

- 主 agent 用 `artifact.write { kind: "contract" }` 写下接口和行为契约，得到一个本会话的 artifact id，再通过输入槽（`contract`、`behavior_contract`）交给成员。
- 契约写入后不可原地修改；需要修改时生成新版本，旧 id 仍然可读。成员报告里的 `contract_requests` 只是变更请求，由主 agent 决定是否生成新版本。
- 并行条件：tester 与 implementer 只有在引用同一个契约版本时才能并行；契约还没写出来时，主 agent 应该先自己确定契约，或者串行执行。内核不判断契约质量，只检查槽位引用的 artifact 存在且属于本会话。

## 7. 临时 agent

```text
agent.derive {
  base: "kodo/frontend@1.0.0",
  overlay: {
    instructions: "只负责动效：过渡、关键帧、减弱动效偏好。",
    scope: { write: ["web/src/motion"] },
    tools: [file.read, file.search, file.patch],
    inputs_required: [requirement, contract]
  }
}
→ { handle: "tmp:frontend-motion-3f2a", digest }
```

- 覆盖层只能收窄：
  - instructions 追加在成员方法之后；
  - tools、skills、MCP 只能取子集；
  - scope 必须被基础卡片的上限包含（路径根包含关系）；
  - permissions 只能取交集；
  - 可以把可选槽位改为必填，不能新增槽位或删除必填槽位。
- 句柄幂等：同一 `base@version` 加上同一规范化覆盖层得到同一个 `tmp:` 句柄和 digest，重复派生不新建记录。
- 记录写入会话表 `derived_agents { handle, base, digest, overlay, created_by_run }`，只在本会话有效，不进入快照和目录索引。
- 不允许在 `tmp:` 句柄上再派生，派生链只有一层。
- 临时 agent 可以作为第 8 节长期卡片提议的来源。

## 8. 长期卡片

### 8.1 谁决定保留

| 方案 | 用户成本 | 资产质量 | 风险 |
|---|---|---|---|
| 用户每次手写卡片 | 高 | 取决于用户 | 几乎没人写，资产长期为零 |
| 模型自动保存 | 零 | 不可控；一次性任务的配置也会被保留 | 名册膨胀；模型给自己扩充可用的能力配置 |
| 模型提议、用户在任务结束时确认 | 一次按键或一句话 | 只保留实际运行过、用户认为有用的配置 | 打断一次；用“跳过两次后静默保存为草稿”控制 |

采用第三种。长期卡片会进入以后所有会话的名册，属于用户授权范围，所以决定权在用户；模型负责发现候选和准备草稿，减少用户的操作。

### 8.2 提议

- 只能从本会话中**实际运行过**的子 run 提议：`agent.propose { run_id, name, catalog, routing }`。卡片的能力、约束和覆盖层由内核从该 run 实际使用的成员卡片或 `tmp:` 记录生成，模型不能在提议时加入新的工具、MCP、权限或范围。
- 证据由内核生成并附在草稿上：来源 run、结果三层状态（第 3.2 节）、使用过的工具、改动文件数。模型写的理由只作为说明展示。
- 草稿写入 `agent_drafts { draft_id, digest, source_run, evidence, status }`，经过第 4 节的注册校验；校验不通过的草稿不会出现在确认界面。
- 同一会话中对同一来源只保留一份草稿；再次提议会生成新 digest，旧 digest 的批准随之失效（8.3）。

### 8.3 批准：绑定草稿与内容摘要

批准记录是 `agent.approval { draft_id, draft_digest, decision: approve | reject | edit, source, user_event_id }`：

- `source` 表示用户的操作入口：`terminal_key`、`web_button` 或 `conversation`。三种入口都只写这一种记录，注册表只认这种记录。
- 用户在对话中说“保留”时，模型调用 `agent.retain { draft_id, digest }`。这只是**请求**：宿主把它显示为与按钮相同的确认项，等用户明确操作后才写入批准记录。宿主不根据“本轮有用户消息”推断授权。
- 写入注册表前再次核对 digest：草稿在批准后被修改，digest 就会变化，旧批准作废，需要重新确认。
- `edit` 打开草稿编辑；保存后生成新 digest，再走一次确认。

### 8.4 交互

- 时机：主 run 完成、最终答复给出之后再询问，不打断任务。
- 终端：一行摘要（名称、来源 run、三层结果），单键 `y` 保留、`n` 丢弃、`e` 编辑。
- 工作台：待处理面板新增 `agent_proposal` 项，动作为保留、丢弃、编辑。
- 同一用户连续跳过两次提议后，后续提议只保存为草稿，不再询问；`kodo agent drafts` 和工作台可以随时查看并批准。草稿不进入名册。
- `--json` 和非交互模式下不询问，只输出草稿列表。
- 策略 `agentRetention: review | off`：`off` 时不生成提议。不提供自动保留。

## 9. 启动入口

| 入口 | 调用方 | 说明 |
|---|---|---|
| `spawn_agent { agent, objective, slots, inputs?, acceptance?, scope? }` | 主 agent | `agent` 可以是快照成员 `id@version` 或 `tmp:` 句柄；校验见第 4 节 |
| `followup_task { target, objective, slots?, context?, inputs?, acceptance? }` | 主 agent | 复用已结束且工具调用已收敛的受管成员；重新提供原卡片的必填槽，稳定 `agentId` 不变，新任务使用独立 `runId` |
| `agent.derive` | 主 agent | 第 7 节 |
| `Application.spawnAgent(sessionId, request)` | 宿主 | 与工具走同一条授权路径，`origin` 记为 `host` |
| `kodo spawn <sessionId> --agent <id> --slot k=v ...` | 用户 | CLI 对 `Application.spawnAgent` 的封装 |
| `createRun({ team })` | 宿主/实验 | 宿主固定团队与分工，用于测量委派收益（第 12 节） |

- 所有入口创建的子 run 都挂在主 run 下，遵守一层委派树和兄弟写范围不重叠的规则。
- 宿主和用户启动的子 run 完成后，同样向主 agent 发 `task-notification`。

`followup_task.target` 接受稳定 `agentId` 或该成员任一历史 `runId`，解析到最新任务；成员忙碌时返回 `AGENT_BUSY`。复用保留工作上下文、卡片和范围，不改写原任务结果；改变卡片或授权范围时新建成员。`list_agents` 展示成员身份、当前运行、复用就绪状态和容量。`send_message` 用于补充运行中任务的信息，不会使已结束成员开始新任务；消息、等待和证据读取仍使用具体 `runId`。

新会话默认 `maxActiveChildren=8`、`maxChildren=null`、`maxConcurrentModels=2`。子运行进入终态且工具调用全部收敛才释放活动名额，等待中的任务仍占名额，因此完成一批后可继续创建或复用。显式 `maxChildren` 是累计子运行上限，包含复用产生的新运行，不随完成而归还。`run/chat/serve` 支持 `--max-active-children N`、`--max-children N|none`；旧会话保留原有持久化限制。详细生命周期及容量设计见[代理委派优化方案](agent-delegation-optimization-design.md)。

## 10. 让模型愿意委派

每项改动对应第 1.2 节的一个假设，作为第 12 节的一个实验因子单独开关。不使用计数阈值提醒，`exploreNudge` 保持默认关闭。

| 因子 | 改动 | 对应假设 |
|---|---|---|
| A：名册 + 预设 | L2 放入名册视图；`kodo/*` 预设作为默认成员；`spawn_agent` 描述列出可用成员，不再写 "none here" | H1 |
| B：L1 文本 | 按收益选择分工：小任务直接执行；有明确收益时委派，耦合实现和验证交同一负责人；验收后及时结束 | H2 |
| C：输入槽 + 默认范围 | 用卡片输入槽代替提示中要求的完整任务包；read/review 卡片不需要写范围，tester 默认使用 `${project.tests}` | H3 |

- 因子 A/C 改变名册和交接内容，因子 B 同时要求执行归属与实际派发关联；权限授权仍按第 4 节执行。
- 因子 B 不设置委派次数目标；主代理执行和模型委派分别要求选中 main/agent 待办，不能在活动委派期间混用执行归属。服从用户要求和现有容量、权限限制，受阻时明确调整分工。

因子 B 的核心英文提示为：

```text
You are the team lead. Own task understanding, planning, acceptance and delivery.
Choose delegation when parallel work, specialist expertise or a separate context
outweighs handoff and acceptance costs. Execute small bounded tasks directly,
including implementation and verification. Keep coupled work with one owner.
Before execution select an in_progress todo with executor main; before model
dispatch select an in_progress todo with executor agent. Selection does not
start an agent. Actual child runs are linked to the selected phase.
Pass established facts and file locations to avoid duplicate orientation.
Have each owner deliver implementation and actual check-call references together.
Inspect existing evidence with inspect_run before requesting revisions.
Rerun checks when code changed, evidence is missing or a concrete concern requires it.
After acceptance, finish. Use followup_task for an unmet requirement or new request,
not to package evidence, create backups or clean up report-only artifacts.
Accept an agent todo only after a linked child completed and all linked work settled.
Respect user instructions, permissions and capacity; explicitly replan if blocked.
```

待办记录主任务阶段，成员的实际执行状态由 `list_agents` 提供；因子 B 下模型创建代理前须选中代理待办，宿主显式派发保持原入口语义。无需额外评分表或独立模型判断调用。异步阅读、评审和实现可用 `spawn_agent`；只读创建并等待可用 `explore`。单步骤实现可使用一个主代理待办直接完成；详细合同见[委派优化方案](agent-delegation-optimization-design.md)。

[此前真实验收](experiments/agent-delegation-real-acceptance-20261028.md)中，旧选择性委派策略的 7 轮默认任务均未自主委派；显式正控制验证了创建与续接机制。原报告中的“新指导”是当时的先规划、按需委派提示，原始结果与标签保留。[负责人模式复测](experiments/agent-delegation-team-lead-retest-20261028.md)确认新提示和工具已实际加载，7 轮实质任务仍未自主委派或调用待办；显式创建与复用控制通过。当前职责划分仍是模型可见的默认指导，尚未通过实际采用验收，不能宣称已实现稳定自主调度或协作收益。

## 11. 实施阶段

每个阶段先写测试再实现；阶段验收要求 `npm run build`、`npm test`、`npm run check` 全部通过。定向测试通过不等于阶段完成。

| 阶段 | 内容 | 验收测试 |
|---|---|---|
| A0 | 修复当前 51 个失败测试；补 `interrupt_agent` 工具路径测试和 `CONTEXT_LIMIT` 交接测试 | 全量测试通过 |
| A1 | schema v2 与 v1 兼容；输入槽校验；`report.submit` 与报告完整性检查；`mode`；评审只读与沙箱临时目录实测 | 缺槽位时不启动并列出槽位名；`calls` 引用其他 run 的调用被拒；review 模式写工作区被拒并报告；v1 卡片照常运行 |
| A2 | 名册快照与 digest；目录索引；名册视图按预算渲染；三个检索工具查快照；同叶子过滤；额度计量 | 中途注册的卡片搜不到；digest 变化后游标作废；预算极小时只剩入口说明并写事件；组合条件不会被并集误匹配；内部节点不计卡片 |
| A3 | `kodo/*` 预设；`${project.tests}` 解析；契约 artifact | 解析不到时预设标为 `unavailable` 并附原因；契约不可原地修改 |
| A4 | `agent.derive` 与 `derived_agents` | 越过上限的覆盖层返回 `SCOPE_ESCALATION`；相同覆盖层得到相同句柄；`tmp:` 上不能再派生 |
| A5 | `Application.spawnAgent`、`kodo spawn`、`createRun({team})` | 三种入口与工具走同一授权路径；兄弟写范围冲突被拒 |
| A6 | `agent.propose`、草稿、digest 绑定的批准、终端与工作台确认、`agentRetention` | 草稿修改后旧批准失效；只有 `agent.retain` 没有用户操作时不注册；`--json` 下不询问；`off` 时不生成提议 |
| A7 | 因子 A/B/C 的模型可见文本与开关；实验运行器 | 每个因子可单独开关；关闭全部因子时请求与基线逐字节一致 |

- A1 的评审沙箱实测结果决定 reviewer 是否开放 `process.run` 只读白名单；未通过时保持只开放 `verify.run`，并在文档中记录。
- A7 之前不做付费实验。

## 12. 实验

新实验 id 为 `agent-roster-v1`，与 r10 不直接比较。所有组都在同一冻结版本、同一任务、同一模型下运行。

### 12.1 采用率：单因子消融

| 组 | 因子 | 目的 |
|---|---|---|
| R0 | 无（新 id 下的基线） | 新版本的委派基线 |
| RA | A | 检验 H1 |
| RB | B | 检验 H2 |
| RC | C | 检验 H3 |
| RABC | A + B + C | 组合效果 |

- 先在 ky 任务上运行，再加一个前后端可分离的任务，用来区分“任务耦合”与“提示不足”。
- 第二模型只复跑 R0 和 RABC，用来检验 H4。
- 记录：委派次数、成员类型、`directory/search` 调用数、返回条目数、首次选中位置、`budget_exhausted` 次数、槽位校验失败次数、报告完整性纠正次数。

### 12.2 收益：宿主固定团队

- 用 `createRun({ team })` 由宿主固定分工（例如 explorer + implementer + reviewer），与同任务的单 agent 对比质量、token、Agent 时间和主输入峰值。
- 这一组测的是“委派本身是否有收益”，与采用率无关，所以不受模型是否愿意委派的影响。
- 同时记录 `child.prefix_shared` 和 `cacheRead`，核对第 5 节的缓存声明。

### 12.3 结论边界

- 每组至少两次重复；样本不足时只做描述性报告，不做因果或显著性声明。
- 采用率上升不等于收益成立；只有 12.2 能回答收益问题。

## 13. 不在本方案范围内

- 多层委派（成员 agent 再派生子 agent）。
- glob 文件范围。
- 自动保留长期卡片。
- 在卡片中写入凭据或 MCP 连接信息。
- 按卡片设固定的 token 或调用预算。
- 把身份信息移出 L1 以延长缓存前缀（第 5 节，需单独立项）。

## 14. 实现与验证边界

实现入口：

| 能力 | 代码 |
|---|---|
| v1/v2 解析、序列化、六张预设 | `src/agents/card.ts`、`src/agents/presets.ts` |
| 槽位、结构化报告、完成纠正、报告分页 | `src/agents/contracts.ts`、`src/runtime/completion.ts`、`src/runtime/inspection.ts` |
| 冻结名册、目录和检索、去重额度 | `src/agents/roster.ts`、`src/agents/discovery.ts`、`src/storage/cards.ts` |
| 临时派生、统一子任务启动 | `src/agents/derive.ts`、`src/messaging/index.ts` |
| 稳定代理身份、后续任务与活动容量 | `src/messaging/agent-lifecycle.ts`、`src/messaging/spawn-spec.ts`、`src/storage/index.ts` |
| 草稿、明确批准、终端及工作台操作 | `src/agents/retention.ts`、`src/cli/agent-review.ts`、`src/web/collaboration.ts` |
| A/B/C 提示与离线实验运行器 | `src/runtime/agent-factors.ts`、`scripts/comparison/agent-roster-v1.mjs` |

新宿主默认开启 A/B/C；`agentFactors: { A: false, B: false, C: false }` 或 CLI `--agent-factors none` 使用基线提示。C 控制槽位与默认范围的提示方式，不关闭输入契约或授权检查。A 组需要能够选择预设并填写其槽位，因此也提供新参数语法；不能把 C 的比较解释为启用或禁用输入校验。

项目卡片从 `.kodo/agents/**/*.md` 读取，`_catalog.md` 用于其目录节点说明。宿主可通过 `projectRoots: { "project.tests": ["tests"] }` 指定测试根；项目根 `AGENTS.md`（不存在时使用 `CLAUDE.md`）也可声明以下 front matter，宿主配置优先：

```yaml
---
project:
  tests: [tests]
---
```

`modelRoles` 将 `fast`、`standard`、`strong` 映射到 `modelBindings` 的宿主别名；未映射时继承父运行的模型。MCP 连接与技能安装仍由宿主提供。项目卡片覆盖可留在会话快照中，不覆盖全局同 ID、同版本的不可变记录。

`createRun({ team })` 接受请求数组，也接受同步的 `(mainRun) => requests` 回调。回调在会话和主任务写入后、同一事务内执行，宿主可以先用 `app.store.artifact(mainRun.id, app.store.blob({ kind: 'contract', name, content }))` 创建契约，再将其 ID 填入成员槽位；任一成员校验失败，团队创建整体回滚。`Application.spawnAgent` 要求会话恰有一个活动主任务；已结束的会话需先创建后续任务。

名册和项目规则按实际渲染内容的 token 估算共享输入容量 10% 的额度。名册入口本身也放不下时，省略名册块并记录降级事件；卡片方法本身超额时返回 `CARD_INSTRUCTION_BUDGET`，不截断方法或越过额度。B/C 单独开启保持旧项目指令装配，以避免把名册预算变化混入提示实验。

Windows 上已实际跑通 reviewer 的原生沙箱只读 Node TAP 检查、调用持久化、结构化报告提交和完成通知。reviewer 暂不开 `process.run`，且 WSL/container 的现有适配器不能证明工作区只读时返回 `VERIFY_READ_ONLY`；普通写模式的这些验证后端仍按原策略使用。未运行 macOS/Linux 原生验证，不将 Windows 结果外推为跨平台实测。

此前卡片实现阶段已验证全关闭因子时，包含真实项目指令的首个 Provider 请求与保留的基线逐字节一致。发现工具还对照了冻结成员上的旧结果投影；新快照的去重计量仍然保留，因此不承诺重复发现后的预算字段与旧实现相同。运行器说明和固定契约团队示例见 [agent-roster-experiments.md](agent-roster-experiments.md)。该阶段没有执行付费模型实验；后续旧策略真实验收与当前负责人模式的边界见第 10 节。

“当前 51 个失败测试”是原方案的历史记录，未作为本次现状。已补齐普通中断恢复和 `CONTEXT_LIMIT` 交接回归，并修复本次定向检查发现的旧断言与流程问题；未运行全量 `npm test`，所以 A0 及各阶段的全量测试门禁仍不能标记为已验收。

以下为此前卡片实现阶段的验证记录，不覆盖本次委派优化：`npm run build`、`npm run check` 均退出 0；新增功能与相关旧行为的 19 个测试文件使用 `--maxWorkers 1 --testTimeout 20000` 统一运行，输出为：

```text
Test Files  19 passed (19)
     Tests  156 passed (156)
```

`node --test scripts/comparison/agent-roster-v1.test.mjs` 的离线结果为 `tests 6 / pass 6 / fail 0`。工作台另用真实浏览器完成了编辑、重新确认和保留操作，并检查桌面及窄屏布局。此前多代理同时运行测试时曾触发 Windows 进程身份查询和测试超时；最终结果来自停止其他验证进程后的统一串行运行。
