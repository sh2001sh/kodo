# 阶段 1 批次 1b 实施与门槛结果（2026-11-03）

范围：隔离检出与集成子系统删除（[1b 删除地图](kodo-phase1-batch1b-map-20261103.md)）。
分支 `phase1/batch1b`，已合入 `main`（merge `03edea1`）。

## 1. 实施内容

| 提交 | 内容 |
|---|---|
| `443894e` | step 1：把 `execution-snapshot.ts` 里的 `sha256` / `workspaceManifest` 等哈希辅助迁到新 `src/runtime/workspace-manifest.ts`（`check-hint` 依赖），为新文件补 `workspace-manifest.test.ts` |
| `2fbdc70` | step 2：删除 9 个 `execution-*` 文件（checkout/integrate/integration/lean/retention/tool-paths/host-calls/admission + 快照的检出部分）；`execution-workspace.ts` 缩到 `runWorkspace`/`executionSession`/`git`/`protectedPath`/`changedExecutionFiles`/`executionFileViolation`；删 `Run.execution`/`executionPending`/`Call.host`、spawn 的 `execution` 参数、`workspace.commit`/`workspace.integrate` 工具；子运行始终共享会话工作区；卡片工具名与版本同 commit 更新 |
| `41855e2` | step 3：`session-compat` 改为 store-aware，除 1a 的 lean-team 标记外，任何带 `execution`/`executionPending` 字段或 execution 事件的旧会话在 `Application.run/recover/spawnAgent/submitInput` 四个入口显式报 `SESSION_INCOMPATIBLE`；无 SQLite 迁移、`Store.session` 不变 |
| `eb1527c` | step 2 后续：同步受影响的版本/目录断言（compact-tools、simplicity-tools、lean-solo、default-progress-policy、default-profile-invariants、tui-agents、inspection-acceptance 等） |

净删除：`65b2c23..eb1527c` = **47 文件，+382 / −2,235**（src 29 文件 +153/−1,224，净删 ~1,071；map 估算 ~1,050）。
新增 `spawn-shared-workspace.test.ts`：shared 默认路径、无 execution 字段、isolated 参数被 schema 拒、
写范围冲突语义保留、卡片版本/工具面/旧卡 fail-fast。测试整删 4 文件（955 行），改写 13 个。

验证：分支 worktree 每步 `npm run check`；S2 后 `npm run build` 通过；最终全量 `npx vitest run` =
**2364 passed / 13 skipped / 1 failed**，唯一失败是 `windows-verification-compat` 在 junction worktree
里 `EPERM symlink node_modules`（环境限制，主仓库同测试通过）。合并后主仓库 `npm run check` / `npm run build` 通过。

## 2. 阶段 1 门槛（按修正后的口径）

候选矩阵 A：`.kodo/golden/phase1b-20261103/`（9 文本样例 × 3 = 27 格，complete、无污染、人工项已补齐）。
候选矩阵 B（同代码复测）：`.kodo/golden/phase1b-20261103-b/`。
基线：`.kodo/golden/baseline-20261103/`（同 9 例 22/27）。

| 指标 | 基线 | 1b 矩阵 A | 1b 矩阵 B |
|---|---:|---:|---:|
| 合格（人工项补齐后） | 22/27 | 24/27 | 21/27 |
| 匹配格 token 比值中位数 | — | 0.994 | 0.830 |
| 匹配格 token 均值比 | — | 1.004（n=19） | 0.967（n=21） |
| 匹配格 wall 比值中位数 | — | 1.246 | 0.937 |
| 新增规则违规 | — | 无 | 1（lit-01:r2 R1） |

**矩阵 B 的唯一新增规则违规是模型的“强调引号”误用**（`结构信息值得显式建模` 等短语被写成引文但
不是材料原文）。同一份代码单独复测 lit-01 三次（`.kodo/golden/phase1b-lit01-recheck/`）**3/3 通过、
0 违规**，说明它是模型文风抖动，不是 1b 引入的回归（符合修正后口径第 4 条：同代码重跑也会翻转的
不计为批次回归）。

矩阵 A 的 wall 均值 +29% 由两个因素造成：① 该时段 provider 响应变慢（多个 cell 本身 wall 翻倍，
但 token 不变）；② 1a 引入的分钟级退避在 3 个 cell 上各等待 30s。矩阵 B（同代码）wall 均值比 1.019、
中位数 0.937，证明 wall 差异不可复现。

**结论：批次 1b 通过（带与 1a 相同的口径修正）**：
- 合格数两次分别为 24/27、21/27，与基线 22/27 同量级；两次合计 45/54 = 83.3% ≥ 基线 22/27 = 81.5%。
- 无新增规则违规（唯一的单格违规已复测证明是模型抖动）。
- 匹配格 token 中位数比 0.994 / 0.830，均值比 1.004 / 0.967 —— 成本未退化。
- wall 时间中位数 1.246 / 0.937；均值受 provider 延迟与重试等待影响，不构成代码回归。
- `npm run check` + 合并后主仓库 `npm run build` 通过；分支全量测试除 junction 环境项外全绿。

## 3. 已知问题与后续

1. **黄金评测每次全量约 20 分钟 + 付费**：1b 的门槛跑了两轮（A/B）才排除一次单格文风抖动，
   1c/1d 会再次改变工具面与提示，按同样流程各跑两轮。若预算紧张，可只跑 1 轮并在翻转时按
   lit-01 的方式做单例复测。
2. **`default-profile-invariants` 的 compact-v2 工具目录字节常量**需每批更新（1b 已更新）。
3. **旧 `.kodo-executions/` 目录与 `refs/kodo/snapshots/*`** 不再自动清理，release notes 需说明手动清理。
4. `workspace.git` 保留（1c/1d 不动）；`Card.execution.modes`、cases 的 execution 证据、
   exploration 的 execution 决策未触碰（分别留给 1e/无关）。
