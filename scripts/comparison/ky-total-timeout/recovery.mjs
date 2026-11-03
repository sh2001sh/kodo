// Recovery diagnosis: can public regression feedback let an agent repair the
// A1/D1 v2-r6 deliverables? Each trial starts from a copy of the frozen broken
// workspace, keeps its original arm policy and gets the same equal repair budget.
// Only the public test set is exposed (test.run); the private oracle stays hidden.
// This is a diagnosis, never merged with full-task win rates.

import console from 'node:console';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { taskTreeDigest } from './fixture.mjs';
import { REGISTRATION as MATRIX, armForKey, dependencyRoot, genericCard, soloProvider, taskFile } from './eval.mjs';
import { executeTrial } from './trial.mjs';
import { containerPreflight } from './container/preflight.mjs';
import { TEST_IMAGE, runPublicTests } from './container/run-tests.mjs';
import { testRunTool } from './container/test-tool.mjs';
import { errorText, parseArgs, resolveCredentials, sha256, stamp, writeJson } from '../v3-eval-common.mjs';
import { fatalRules, prepareOutput, runMatrix, writeRegistration } from '../v3-eval-matrix.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const sourceRun = path.join(repoRoot, '.kodo', 'ky-total-timeout-paid-20261025-110711');
const baseTemplate = path.join(repoRoot, '.kodo', 'research', 'ky-total-timeout', 'base-template');

export const RECOVERY = Object.freeze({
  ...MATRIX,
  id: 'ky-total-timeout-recovery-r1',
  revision: 'Recovery diagnosis after the v2-r6 review: A1 and D1 completed but failed the public AVA regression set (A1: its new http-error test expects TimeoutError; D1: shouldRetry with TimeoutError retried). Each trial resumes from a copy of its frozen v2-r6 workspace with its original arm policy, the v2-r7 runtime, and a test.run host tool that runs public AVA tests in an isolated Linux container. Equal repair budget per trial. Hidden oracle assertions are never shown.',
  sourceRun: path.relative(repoRoot, sourceRun).replaceAll('\\', '/'),
  order: Object.freeze(['A1', 'D1']),
  testImage: TEST_IMAGE,
  testToolTimeoutMs: 110_000,
  // The equal repair budget; the full-task matrix has no caps.
  repairBudget: Object.freeze({ maxModelCalls: 60 }),
  deliverables: Object.freeze([Object.freeze({ path: 'DELIVERY.md', minBytes: 200 })]),
  stopRules: Object.freeze([...MATRIX.stopRules.filter(rule => !rule.startsWith('block 1')), 'container test-feedback preflight failure']),
});

const sourceReport = key => JSON.parse(readFileSync(path.join(sourceRun, key, 'report.json'), 'utf8'));

/** Copy the frozen broken workspace (never touching it), then add fresh dependencies. */
export function seedRecoveryWorkspace(key, workspace) {
  const original = path.join(sourceRun, key, 'workspace');
  if (existsSync(workspace)) throw new Error(`workspace already exists: ${workspace}`);
  mkdirSync(workspace, { recursive: true });
  for (const entry of readdirSync(original, { withFileTypes: true })) {
    if (['node_modules', 'distribution', '.git', '.npmrc'].includes(entry.name)) continue;
    cpSync(path.join(original, entry.name), path.join(workspace, entry.name), { recursive: true, errorOnExist: true });
  }
  cpSync(dependencyRoot, path.join(workspace, 'node_modules'), { recursive: true, errorOnExist: true });
  mkdirSync(path.join(workspace, 'distribution'));
  mkdirSync(path.join(workspace, 'node_modules', '.cache'));
  const expected = sourceReport(key).workspaceDigest;
  if (taskTreeDigest(workspace) !== expected) throw new Error(`${key} seed does not match the frozen v2-r6 workspace digest`);
}

export function recoveryObjective(key) {
  const task = readFileSync(taskFile, 'utf8').trim();
  return `${task}

## 恢复诊断说明

当前工作区是此前一次尝试留下的交付物（${key}），不是原始基线。宿主验收时公开回归集（test/retry.ts、test/http-error.ts、test/hooks.ts）未通过。请从现有改动继续：先用 test.run 获取公开测试反馈，定位原因并修复，使功能契约成立且公开回归集通过。不要为了通过而删除或弱化与本功能无关的已有断言；若修改测试，需按功能契约说明理由。最后更新 DELIVERY.md，记录修复内容与实际运行的命令和结果。

## 冻结环境说明

依赖已经安装，禁止重新安装或访问网络。Node ${process.versions.node}。原生进程沙箱只授权当前工作区；以下命令每条单独用一次 process.exec 调用（program 为 node）：

- 构建：\`node node_modules/typescript/bin/tsc --project tsconfig.dist.json\`
- 类型检查：\`node node_modules/typescript/bin/tsc --noEmit --project tsconfig.json\`
- lint：\`node node_modules/xo/dist/cli.js source\`

沙箱内不能创建带管道或 IPC 的子进程，所以不要用 process.exec 运行 ava、tsx 或 npm 脚本；请改用 test.run 工具运行 AVA（可指定 files 与 match）。test.run 在隔离 Linux 容器中对调用时刻的工作区快照运行测试，只允许本机回环网络，返回计数、失败标题和输出尾部。单次工具调用上限 120 秒。`;
}

function imageId() {
  const result = spawnSync('docker', ['image', 'inspect', TEST_IMAGE, '--format', '{{.Id}}'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (result.status !== 0) throw new Error(`test image ${TEST_IMAGE} is missing; build scripts/comparison/ky-total-timeout/container/Dockerfile first`);
  return result.stdout.trim();
}

function fixtures() {
  const hash = file => sha256(readFileSync(path.join(here, file)));
  return {
    sourceWorkspaceDigests: Object.fromEntries(RECOVERY.order.map(key => [key, sourceReport(key).workspaceDigest])),
    taskSha256: sha256(readFileSync(taskFile)),
    testImageId: imageId(),
    scripts: Object.fromEntries(['recovery.mjs', 'trial.mjs', 'eval.mjs', 'oracle.mjs', 'fixture.mjs', 'container/Dockerfile', 'container/run-tests.mjs', 'container/test-tool.mjs', 'container/preflight.mjs'].map(file => [file, hash(file)])),
  };
}

function executeRecoveryTrial({ cli, credentials, key, outRoot }) {
  const { arm, block, policy } = armForKey(key);
  return executeTrial({
    directory: path.join(outRoot, key), key, arm, block, policy, registration: RECOVERY, credentials, model: cli.model,
    seed: workspace => seedRecoveryWorkspace(key, workspace), objective: recoveryObjective(key),
    card: app => genericCard(app, policy.delegation, ['test.run']),
    wrapProvider: provider => (policy.delegation ? provider : soloProvider(provider)),
    tools: [testRunTool({ timeoutMs: RECOVERY.testToolTimeoutMs })], deliverables: RECOVERY.deliverables, budget: RECOVERY.repairBudget,
    // The same public set, rerun by the host in the container after the agent stops.
    postChecks: async workspace => { const { stdout, stderr, ...rest } = await runPublicTests({ workspace }); return { ...rest, tail: `${stdout}\n${stderr}`.slice(-3000) }; },
  });
}

function summary(result) {
  return {
    key: result.key, arm: result.arm, status: result.status, error: result.error, delivery: result.delivery?.ok ?? false, reasons: result.delivery?.reasons ?? [],
    passedChecks: Object.values(result.audit?.checks ?? {}).filter(check => check.passed).length, totalChecks: Object.keys(result.audit?.checks ?? {}).length,
    hostRegression: result.audit?.regression?.exitCode ?? null, containerRegression: result.postChecks?.summary ?? null,
    testRunCalls: result.toolUse?.['test.run'] ?? 0, modelCalls: result.usage?.modelCalls ?? null, tokens: result.usage?.totalTokens ?? null,
    uncachedInput: result.usage?.uncachedInput ?? null, output: result.usage?.outputTokens ?? null,
    tokensLowerBound: Boolean(result.usage?.unknownCalls || result.relay?.unmeasured), agentMs: result.agentMs, children: result.delegation?.created ?? 0,
  };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2), { run: { kind: 'boolean', default: false }, 'dry-run': { kind: 'boolean', default: false }, model: { kind: 'string', default: RECOVERY.model }, provider: { kind: 'string', default: RECOVERY.provider }, 'provider-config': { kind: 'string', default: undefined }, out: { kind: 'string', default: undefined } });
  if (cli.model !== RECOVERY.model) throw new Error(`model is frozen to ${RECOVERY.model}`);
  const credentials = cli.run ? await resolveCredentials({ providerConfig: cli['provider-config'], provider: cli.provider }) : undefined;
  const outRoot = path.resolve(cli.out ?? path.join(repoRoot, '.kodo', `ky-recovery-${cli.run ? 'paid' : 'preflight'}-${stamp()}`));
  prepareOutput(outRoot);
  // Preflight on throwaway copies: base passes, the D1 copy fails the known test, boundaries hold.
  const probeRoot = path.join(outRoot, '.preflight');
  seedRecoveryWorkspace('D1', path.join(probeRoot, 'D1'));
  const container = await containerPreflight({ baseWorkspace: baseTemplate, brokenWorkspace: path.join(probeRoot, 'D1'), expectedFailure: 'retry › shouldRetry: works with TimeoutError' });
  rmSync(probeRoot, { recursive: true, force: true });
  if (!container.passed) throw new Error(`container test-feedback preflight failed: ${JSON.stringify(container.checks)}`);
  const plan = [...RECOVERY.order];
  const settings = { mode: cli.run ? 'paid' : 'preflight', model: cli.model, provider: cli.provider, providerHost: credentials?.host ?? null, container };
  writeRegistration(outRoot, { registration: RECOVERY, plan, settings, fixtures: fixtures(), repoRoot });
  if (!cli.run) {
    writeFileSync(path.join(outRoot, 'preflight.json'), `${JSON.stringify({ passed: true, note: 'No model request was made.', plan, container }, null, 2)}\n`);
    console.log(JSON.stringify({ out: outRoot, passed: true, mode: 'preflight', container: Object.fromEntries(Object.entries(container.checks).map(([name, check]) => [name, check.passed])) }, null, 2));
    return;
  }
  let interrupted = null;
  process.once('SIGINT', () => { interrupted = 'INTERRUPTED'; console.error('stopping after the current trial'); });
  const { results, stop, spent } = await runMatrix({
    outRoot, plan, secret: credentials.key, fatal: fatalRules({ agentCancelTolerance: RECOVERY.agentCancelTolerance }), shouldStop: () => interrupted,
    runCell: async key => {
      const result = await executeRecoveryTrial({ cli, credentials, key, outRoot });
      const row = summary(result);
      console.error(`${key}: status=${row.status} delivery=${row.delivery} checks=${row.passedChecks}/${row.totalChecks} testRuns=${row.testRunCalls} calls=${row.modelCalls ?? '?'} tokens=${row.tokens ?? '?'}${row.error ? ` error=${row.error}` : ''}`);
      return result;
    },
  });
  const report = { registration: RECOVERY, settings, stop, spent, trials: results.map(summary) };
  await writeJson(path.join(outRoot, 'summary.json'), report, credentials.key);
  console.log(JSON.stringify({ out: outRoot, stop, spent, trials: report.trials }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
