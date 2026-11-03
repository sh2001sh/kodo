import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateTrial, rootFiles, supportedVerificationCommands, tasks, treeManifest } from './real-tasks.mjs';

test('frozen task input includes repository metadata required by installation checks', () => {
  assert.ok(rootFiles.includes('LICENSE'));
  assert.ok(rootFiles.includes('.github'));
});

test('onboarding command scoring accepts the four documented direct runners', () => {
  const text = [
    'node "C:/repo/node_modules/typescript/bin/tsc" -p tsconfig.build.json',
    'node "C:/repo/node_modules/typescript/bin/tsc" --noEmit -p tsconfig.json',
    'node "C:/repo/node_modules/vitest/vitest.mjs" run tests/context.test.ts',
    'node "C:/repo/node_modules/eslint/bin/eslint.js" src tests scripts',
  ].join('\n');
  assert.deepEqual(supportedVerificationCommands(text), ['direct TypeScript build', 'direct TypeScript check', 'direct Vitest run', 'direct ESLint run']);
});

test('pending manual fact review does not make automatic onboarding acceptance fail', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-real-task-'));
  try {
    for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'docs/a.md', 'docs/b.md', 'examples/a.json']) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), 'fixture');
    }
    const before = await treeManifest(root);
    const report = `ZIP CAPABILITY.json 导入。导入不会执行或安装，依赖准备使用 ignore-scripts。\n
AppContainer 与 LPAC、bubblewrap bwrap、sandbox-exec 都需要 --sandbox 显式启用。\n
只允许单个 writer；macOS 禁止子进程；Linux 尚未验证。\n
写入需要 --allow-write；UNKNOWN_WRITE 后使用 reconcile 核实。\n
远程 MCP 凭据通过环境变量 bind；rollback 后旧运行仍使用原版本。\n
src/a.ts src/b.ts src/c.ts docs/a.md docs/b.md examples/a.json\n
node "C:/repo/node_modules/typescript/bin/tsc" -p tsconfig.build.json\n
node "C:/repo/node_modules/typescript/bin/tsc" --noEmit -p tsconfig.json\n
node "C:/repo/node_modules/vitest/vitest.mjs" run tests/context.test.ts\n`;
    await writeFile(path.join(root, 'REPORT.md'), report);
    const acceptance = await evaluateTrial({ repository: root, source: root, workspace: root, directory: root, task: tasks[0], before, outcome: { status: 'completed', text: 'REPORT.md' } });
    assert.equal(acceptance.automaticPassed, true);
    assert.equal(acceptance.passed, true);
    assert.equal(acceptance.manualFactualReviewRequired, true);
    assert.equal(acceptance.criteria.some(item => item.name === 'source factual review completed'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
