import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';

const contract = `# 新功能：历史归档目录 API 与 CLI

这是从零新增功能，不是修复预置单行缺陷。{{EXECUTION_MODE}}只改允许的三层源码、README 和两份新测试；不可修改现有测试、依赖、配置或验证脚本。

## 公共契约

1. 在 src/runtime/history.ts 导出 listHistory(store, requesterId, options = {})，options 为 {offset?: number, limit?: number}。返回 {items: [{ref: string, runId: string}], total: number, nextOffset?: number}。默认 offset=0、limit=20；offset 是非负安全整数，limit 是1..100的安全整数。非法数值（含NaN、Infinity、小数、不安全整数、负offset、0或大于100的limit）抛 KodoError('HISTORY_ARGUMENTS', ...)。不要按数组自动截断或把非法值当默认值。
2. 目录仅包含请求者可用现有 readHistory 成功读取的、已由持久 context.compacted 事件登记的历史快照。权限与 readHistory 完全相同：自身及有 recovery.continued 审计确认的同会话恢复祖先；主代理还可读其当前或已验证恢复祖先管理的子代理及这些子代理的已验证恢复链；子代理不可读父/兄弟，外会话不可读，只有 continuationOf 字段而没有匹配审计事件不能扩大权限。不要只按sessionId放行。未登记blob、错误归属/错误结构的索引不应暴露为目录条目。
3. 汇总允许范围内持久归档事件，以事件全局 seq 从大到小排列；相同 ref 只出现一次，采用最新出现位置。runId 为通过 readHistory 归属核实的所有者。先授权、去重和排序，再算total及分页。offset超过末尾返回空items及正确total。只有后面还有条目时返回nextOffset=offset+items.length；到末尾时属性应缺省，不返回null或undefined占位对象。不得硬编码最多100个归档，100只是单页limit上限。
4. 在 src/application/index.ts 新增公共 Application.listHistory(runId, options = {}) 入口，返回相同目录结果。
5. CLI 新增 kodo history <run-id> --json [--offset N --limit N]，沿用 --data-dir。无需模型配置、凭据、写权限或运行任务。--json 下stdout只输出一个目录JSON对象，不输出模型事件；无需--json时也应能正常查看结果。帮助及README说明新命令、分页和权限。缺run-id、额外位置参数、缺失run均非零失败；数值flag接受十进制整数字符串，空/空白/非数字/负数/小数/不安全整数等报HISTORY_ARGUMENTS；--offset/--limit出现在history以外命令时报ARGUMENTS，其他已有选项的限制保持原样。
6. API/CLI是只读查询：不启动模型，不执行/恢复运行，不新增事件，不改变预算计数、持久运行状态或调用记录。持久重启后仍可列出原目录。

## 允许的改动

- src/runtime/history.ts、src/application/index.ts、src/cli/index.ts、README.md。
- 必须新增 tests/history-catalog.test.ts 和 tests/cli-history.test.ts。现有测试不能改；测试应覆盖正常、边界和拒绝路径，不只断言函数存在。

## 必须实际执行的验证

先构建，再完整运行上述两份新测试及 tests/context.test.ts、tests/recovery.test.ts、tests/cli.test.ts（禁止-t等筛选、禁止管道截断测试）；最后执行项目check（TypeScript noEmit与ESLint）。START_HERE.md提供宿主同版本Node、vitest、tsc与eslint路径；依赖已提供，不要安装。不能只写“应该通过”，必须依据真实退出码和输出汇报。隐藏验收只验证行为，不要求特定补丁写法。
`;

export const historyCatalogDefinition = {
  id: 'history-catalog',
  name: '跨层历史归档目录新功能',
  kind: 'implementation',
  mutations: [],
  tests: ['tests/history-catalog.test.ts', 'tests/cli-history.test.ts', 'tests/context.test.ts', 'tests/recovery.test.ts', 'tests/cli.test.ts'],
  files: ['src/runtime/history.ts', 'src/application/index.ts', 'src/cli/index.ts', 'README.md', 'tests/history-catalog.test.ts', 'tests/cli-history.test.ts'],
  objective: `请实现跨runtime、Application、CLI三层的历史归档目录新功能。先读 HISTORY_CATALOG_TASK.md 的完整公共契约及 START_HERE.md 的验证命令。新增 listHistory API、Application.listHistory 和 kodo history 命令，完善README及两份新测试，实际完成build、五份完整测试和check。原有测试、依赖与配置不允许改。必须独立单代理执行，禁止调用或派生子代理；不要询问用户，不要访问副本以外的任务/隐藏资产。完成后简洁报告实现范围和真实验证结果。`,
  tools: ['file.read', 'file.list', 'file.search', 'file.apply_patch', 'process.exec', 'artifact.write', 'artifact.read'],
};

export function historyCatalogTask({ autonomous = false } = {}) {
  return autonomous ? { ...historyCatalogDefinition, objective: historyCatalogDefinition.objective.replace('必须独立单代理执行，禁止调用或派生子代理；', '') } : historyCatalogDefinition;
}

export async function prepareHistoryCatalog(workspace, { autonomous = false } = {}) {
  await writeFile(path.join(workspace, 'HISTORY_CATALOG_TASK.md'), contract.replace('{{EXECUTION_MODE}}', autonomous ? '' : '请单代理完成，禁止调用或派生子代理。'), 'utf8');
}

async function hashes(root) {
  const result = {};
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else result[name.replaceAll('\\', '/')] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
    }
  }
  await walk('src');
  for (const name of ['package.json', 'tsconfig.json', 'tsconfig.build.json']) result[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
  return result;
}

async function execute(args, cwd, log) {
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    child.stdout.on('data', value => { stdout = (stdout + value).slice(-500_000); });
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-500_000); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, error: error.message, stdout, stderr, timedOut }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
  });
  await writeFile(log, JSON.stringify({ program: process.execPath, args, cwd, ...result }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return result;
}

/** Builds and tests an isolated copy. Hidden assertions and gold implementations stay outside model workspaces. */
export async function oracleHistoryCatalog({ workspace, directory, repository, prefix = 'history', assetsDirectory }) {
  if (!assetsDirectory) throw new Error('history-catalog requires external hidden assetsDirectory');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(prefix)) throw new Error('Unsafe history-catalog evidence prefix');
  const isolated = path.join(directory, `${prefix}-history-isolated`);
  await mkdir(isolated, { recursive: false });
  const isolatedWorkspace = path.join(isolated, 'workspace');
  await mkdir(isolatedWorkspace);
  const before = await hashes(workspace);
  for (const name of ['src', 'package.json', 'tsconfig.json', 'tsconfig.build.json']) await cp(path.join(workspace, name), path.join(isolatedWorkspace, name), { recursive: true });
  const build = await execute([path.join(repository, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], isolatedWorkspace, path.join(isolated, 'build.json'));
  let checks = null, evidence = null;
  if (build.code === 0) {
    checks = await execute([path.join(assetsDirectory, 'oracle.mjs'), isolatedWorkspace, path.join(isolated, 'runtime'), path.join(isolated, 'checks.json')], isolatedWorkspace, path.join(isolated, 'run.json'));
    try { evidence = JSON.parse(await readFile(path.join(isolated, 'checks.json'), 'utf8')); }
    catch (error) { evidence = { passed: false, error: error.message }; }
  }
  const sourceUnchanged = JSON.stringify(before) === JSON.stringify(await hashes(workspace));
  const result = { passed: build.code === 0 && checks?.code === 0 && evidence?.passed === true && sourceUnchanged && !build.timedOut && !checks?.timedOut, build, checks, evidence, sourceUnchanged, isolatedWorkspace, originalSourceHashes: before };
  await writeFile(path.join(isolated, 'verification.json'), JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return result;
}
