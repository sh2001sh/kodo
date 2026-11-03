# GitHub 工程评测项目筛选

调研日期：2026-10-24。已读取 GitHub 仓库元数据、固定提交的依赖/测试配置、PR 合并状态与文件清单，以及重点测试源码。未安装外部依赖、未在本机运行这些项目、未调用付费模型；以下是可制作任务的候选，不是已通过入场验收的任务包。

对应[工程任务规格](engineering-evaluation-tasks.md)。本轮研究快照保存在 `.kodo/research/github-task-projects/`，不放入未来被测 Agent 工作区。

## 1. 推荐顺序

| 项目 | 推荐用途 | 已核实的基础 | 接入代价与边界 |
| --- | --- | --- | --- |
| [Ky](https://github.com/sindresorhus/ky) | SDK 取消、重试、超时、配置继承 | TypeScript、AVA、本地 HTTP 测试、真实已合并回归 | 首批优先；浏览器测试另需 Playwright，不必把全部浏览器矩阵纳入每次短任务 |
| [TanStack Query](https://github.com/TanStack/query) | 缓存状态、订阅恢复、核心层与 React 状态一致性 | query-core/react-query 分包、Vitest/jsdom、跨包回归 | 首批第二优先；pnpm workspace/Nx 比单包重，应限定相关包，但保留依赖关系 |
| [JSON Server](https://github.com/typicode/json-server) | HTTP 参数校验、筛选/排序/分页、CLI/API 一致性 | 实际 REST 服务、Node 原生测试、app/service/paginate 测试 | 首批低成本入口；它是 JSON 文件后端，不代表 SQL 事务/生产数据库能力 |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | 完整应用的前后端、重连、监控生命周期、资源清理 | Vue 应用、后端测试、Playwright E2E | 第二阶段；依赖和环境复杂，部分测试使用容器，优先限定本地服务和固定版本 |
| [PocketBase](https://github.com/pocketbase/pocketbase) | 实际 SQLite API、筛选、实时订阅、服务集成 | Go、SQLite、API 与 realtime 测试、管理界面 | 后续跨语言/真实数据库任务；新增 Go 工具链，不能当即用型 TypeScript 任务 |

GitHub 在检查时将这五个仓库的许可证识别为 MIT，均未归档。任务包分发仍应保留对应固定版本的许可文件；不把项目许可证等同于所有依赖或测试数据的统一许可。

### 已检查的当前版本

| 项目 | 检查时提交 | 环境信息 |
| --- | --- | --- |
| Ky | `3541888878c4d303a8bc2ad61815f4e048f55a5d` | Node >=22，AVA；test 脚本包括 lint、构建和测试 |
| TanStack Query | `9e4253766f8015d1372bcd515f50103fd067a42d` | pnpm 12.4.2；workspace/Nx，Vitest；应按该版本锁定依赖 |
| JSON Server | `89a34a44b7a6a5311dc84f3b8a1b8b45c0905aea` | Node >=22.12.0，Node 原生 test；README 标明 v1 beta |
| Uptime Kuma | `365c4b289d0e96a76e3e7b35bc4dbc303f744691` | 当前 master 要求 Node >=26.2.0，不能直接复用 Kodo 的 Node 24 环境 |
| PocketBase | `9d281ccaba65f2686eb7b0b614ccda72d1116a1b` | go.mod 要求 Go 1.27，modernc SQLite |

历史任务使用其修复前版本的配置，不能把当前分支的环境要求套到旧 PR。比如 Uptime Kuma #6783 的候选基线要求 Node >=20.4.0，比当前 master 更容易接入，但仍需验证依赖与测试环境。

## 2. 已找到的真实任务来源

以下 PR 均已核对 merged=true 及改动文件。基线 SHA 来自 GitHub PR 的 base.sha，是准备入口；必须进一步验证补丁应用关系和失败→通过，不能仅凭 SHA 直接认定是有效评测基线。

| 来源 | 问题与交付 | 改动范围（含测试/文档） | 定位 |
| --- | --- | --- | --- |
| [Ky #867](https://github.com/sindresorhus/ky/pull/867) | 数字形式 retry 在 extend 合并对象选项时丢失 | merge.ts 与 retry 测试，共 2 文件 | 优先短修复、成本负控制 |
| [Ky #663](https://github.com/sindresorhus/ky/pull/663) | 传入已取消信号时没有及时中止请求 | Ky.ts 与 main 测试，共 2 文件 | 取消行为短修复，历史公开时间较长 |
| [Ky #848](https://github.com/sindresorhus/ky/pull/848) | 增加 totalTimeout，区分单次尝试与全流程时间上限 | 核心、常量、类型、文档、三组测试，共 7 文件 | 中等跨层交付，最适合首批较复杂任务 |
| [TanStack Query #11172](https://github.com/TanStack/query/pull/11172) | MutationObserver 取消订阅后重订阅，结果停留 pending | 实现、observer 测试、changeset，共 3 文件 | 生命周期与状态修复 |
| [TanStack Query #11470](https://github.com/TanStack/query/pull/11470) | clear 通知先于缓存移除，订阅者和 React hooks 读到旧状态 | 实现、core 测试、React 测试、changeset，共 4 文件 | 跨包因果分析，优先中等任务 |
| [JSON Server #1722](https://github.com/typicode/json-server/pull/1722) | 非对象 JSON 请求体错误返回 404，应为 400 | app 实现与 HTTP 测试，共 2 文件 | 容易黑盒验收的短工程任务 |
| [Uptime Kuma #6783](https://github.com/louislam/uptime-kuma/pull/6783) | RADIUS 超时/响应竞争中的 socket 清理与错误处理 | 两个后端文件，没有新增测试文件 | 候补；先补本地 UDP 可控验收，不直接入场 |

首批推荐四题：Ky #867、JSON Server #1722、TanStack Query #11470、Ky #848。前两题验证短任务代价，后两题验证较复杂的理解与交付。两道 Ky 任务属于同一仓库任务族，不能当作独立工程来源。

这些题都是真实工程改动，但多数修复范围很小。不能因为仓库规模大或 PR 涉及多个测试文件，就称为长上下文、多代理有优势的任务。尤其 #11470 核心修改较小，跨包验证复杂不等于实现必须多人分工。

### 候选基线与参考合并提交

| PR | 候选基线 base SHA | 合并提交 |
| --- | --- | --- |
| Ky #867 | `61d6d66d27911001b9b4d57ab93139f9ad61384b` | `06375efbacfc1bdc96f7a4de7560684b765e1274` |
| Ky #663 | `1d92c203f7f60df37c03d60360237d8cb9bcb30a` | `6d063383a602ecb75b60bd4dda7ece60da66f462` |
| Ky #848 | `3713ce8d4bc50db655837bb1dd79550df24219fc` | `c20d7c78da256a89d56138e9091d0253b83cde99` |
| Query #11172 | `6e3d521fe54f78624e53c1c6f9cadd678504bee8` | `18c1c1ef94883e781ad36d36f9ea4a043ce4260b` |
| Query #11470 | `c20886163a3759725cceafb421e864e7d213ec26` | `1fee0443dbeb346b8401557ca286a66cdec7ad71` |
| JSON Server #1722 | `e98d8a02473f59e8a82024cf94181adf3d131ec1` | `d2b3decc5ea59b4e962be2e4bacaf7d2a476348b` |
| Uptime Kuma #6783 | `a38c6dea2521caa672034e4b30e08a7786182a46` | `236d74238cf31e3eacbebe9d09c76daa7d8f7e27` |

## 3. 为什么推荐这些题，以及如何验收

### Ky：优先替代 SDK 合成任务

当前已有 retry、retry timing/options、resilience、memory leak 等测试。已读 resilience 测试明确检查退避期间取消和取消后不再发请求，适合复用测试方法，但当前正确实现本身不是待修缺陷。

Ky #867 的验收可直接比较请求次数、继承参数和父实例不变性；加入数字→对象、对象→数字、对象→对象与多次 extend 的未公开组合，防止只修一个例子。

Ky #848 能覆盖类型、文档、重试、总预算、单次超时、hook 和响应体读取。已检查参考测试包含总超时优先于 retry limit、Retry-After 受总预算约束、关闭单次超时仍受总超时约束等情况。测试中也有真实计时，制作时必须检查波动并优先采用可控计时，不能直接把计时脆弱性算成 Agent 错误。

配置来源：[Ky 历史基线 package.json](https://github.com/sindresorhus/ky/blob/3713ce8d4bc50db655837bb1dd79550df24219fc/package.json)。先按版本构建再运行定向 AVA，最后执行约定回归；准确命令须经过准备阶段实际运行确认。

### TanStack Query：适合状态一致性，不替代完整浏览器产品

#11470 的 core 测试检查“通知订阅者时缓存已经移除”与“订阅回调新增的 mutation 不应被误清除”；React 测试检查 clear 后 hooks 显示更新。它能验证真实的实现—订阅—界面状态链。

验收使用 core 与 react-query 相关测试，再加独立事件序列。不要仅断言 changed lines，也不要为了测一个 core 问题让模型运行整个仓库几十种框架的全部测试。

已核实 [query-core 配置](https://github.com/TanStack/query/blob/c20886163a3759725cceafb421e864e7d213ec26/packages/query-core/vite.config.ts) 是 Vitest/jsdom。jsdom 不等于真实浏览器；浏览器重连任务仍需完整应用或额外浏览器验证。

### JSON Server：轻量 REST 集成入口

#1722 已有真实 POST 数组、PATCH 字符串、PUT null 的 HTTP 回归测试，可以补合法对象、空对象、缺失资源、不同方法等未公开组合，核对状态码、响应及数据无意外修改。

当前源码也有 service、paginate 和查询表达式测试，适合随后提取筛选/排序/分页任务。应遵循其实际公开协议，不把页码分页硬改成计划中预设的游标分页，也不拿它证明数据库事务能力。

历史基线 [package.json](https://github.com/typicode/json-server/blob/e98d8a02473f59e8a82024cf94181adf3d131ec1/package.json) 的测试使用 Node 原生 test；build 含 POSIX shell 清理命令，在 Windows 上要固定兼容 shell 或记录等价的干净构建适配，不能声称已经原生验证。

### Uptime Kuma / PocketBase：为较长工程任务储备

Uptime Kuma 有真实应用和 Playwright，适合 UI、状态同步和服务生命周期；#6783 本身缺少新增测试，必须补正确、错误补丁都能区分的验收后使用。当前 master 与历史版本的 Node 要求差别大，固定版本和容器/浏览器环境是主要准备成本。

PocketBase 的源码具有 SQLite、实时订阅和 API 测试，适合工程任务 E04 的真实数据库部分。此次尚未找到并核验一个足够合适的分页/订阅 PR，不列为已就绪题目。更不应为了凑题而采用与目标无关的随机字符串修复。

这两个项目可以提供较长任务，但“完整应用”不自动意味着某项改动足够长；需独立挑选需求、校准自然历史增长。

## 4. 现成评测项目能借鉴什么

[SWE-bench](https://github.com/SWE-bench/SWE-bench) 提供真实 GitHub issue、补丁和可复现评测框架。当前 README 列出 verified、multilingual 等数据集入口，支持参考补丁评估和 Docker 运行。

建议借鉴“固定版本 + 问题描述 + 外部测试 + 参考补丁”的组织方式。若需要标准对外基准，可另选小子集做接入，不取代本地工程任务库。

它不是最轻的 Windows 本地首选：README 建议 x86_64、约 120GB 可用存储、16GB RAM、8 CPU 核心，并要求 Docker。此处没有运行容器、核验可用任务镜像或下载数据集，不能称为已接入。

## 5. 把 GitHub PR 制作成公平的任务

1. 验证修复前基线及锁文件，隔离完整参考补丁和评分器。取得对应测试补丁并确认它能在坏基线上复现目标失败。
2. 基线、正确补丁、至少两个错误补丁分别验收；确认任务可解、验收有区分力，排除时钟/环境失败。
3. 被测 Agent 只收到需求、症状、允许的工程资料和原有测试。不要直接复制含根因/修复方法的 PR 正文；不给后续提交历史、参考答案、研究报告或其他组结果。
4. 不把公开历史 PR 当全新无污染任务。模型可能见过，较新的 PR 也不能保证未见；这些先作工程开发基准。新输入组合验证稳健性，不变成新的独立任务。
5. 同一题跨模型/策略使用相同快照、工具、预算和验收。短题不触发委派/压缩属于有效结果，不能因机制没触发就反复加长题目。

本次最明确的落地选择是：先从 Ky、TanStack Query、JSON Server 制作四个真实任务，完成零费用的基线/参考补丁/错误补丁验证；再增加 Uptime Kuma 的完整应用任务。要验证长上下文和自主协作的稳定收益，仍需补自然持续的中长需求，不能只依赖这些小 PR。
