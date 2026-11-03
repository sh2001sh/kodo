import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { createBuildManifest } from '../../write-build-manifest.mjs';
import { frozenBuild, runComparison, sourceChanges, stopReason, validateScope } from './efficiency-comparison.mjs';
import { analyzeComparisonCell, comparisonVerdict, nativeLockTiming, nativeModelTiming, overlapSeconds, peakConcurrency, usageTotals } from './efficiency-analysis.mjs';
import { kodoConcurrencyArgs, kodoSandboxArgs, selectKodoSandbox, sandboxPreflight } from './launch.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');

test('parallel lock wait metrics separate accumulated waiting from overlapping time', () => {
  const event = (end, waitedMs) => ({ type: 'lock.waited', time: new Date(end).toISOString(), data: { waitedMs } });
  const result = nativeLockTiming([event(5000, 3000), event(5000, 2000), event(8000, 1000), event(9000, -1)]);
  assert.equal(result.cumulativeSec, 6);
  assert.equal(result.unionSec, 4);
  assert.equal(result.peakWaiters, 2);
  assert.equal(result.invalidEvents, 1);
  assert.equal(nativeLockTiming([]).cumulativeSec, 0);
});
test('native model concurrency is independent of delayed relay closure and incomplete pairs stay unknown', () => {
  const event = (type, runId, callId, ms) => ({ type, runId, data: { callId }, time: new Date(ms).toISOString() });
  const events = [event('model.started', 'main', 'a', 1000), event('model.finished', 'main', 'a', 2000),
    event('model.started', 'child', 'a', 2000), event('model.finished', 'child', 'a', 3000)];
  assert.equal(nativeModelTiming(events).peakModelRequests, 1);
  assert.equal(nativeModelTiming(events).modelRequestOverlapSec, 0);
  assert.equal(peakConcurrency([[1000, 2500], [2000, 3500]]), 2);
  assert.equal(nativeModelTiming([]).peakModelRequests, null);
  assert.equal(nativeModelTiming(events.slice(0, -1)).peakModelRequests, null);
  assert.equal(nativeModelTiming([...events, events[0]]).peakModelRequests, null);
});
const scope = { task: 'fastapi', groups: ['baseline', 'optimized'], repeats: 1, factors: 'A,B,C,D,E', contextTokens: 1_048_576, outputTokens: 393_216 };
const scripts = ['run.mjs', 'launch.mjs', 'relay.mjs', 'recorder.mjs', 'execution-evidence.mjs', 'native.mjs', 'trace.mjs', 'delegation-metrics.mjs', 'efficiency-comparison.mjs', 'efficiency-analysis.mjs', 'check-audit.mjs'];
const flags = { A: true, B: true, C: true, D: true, E: true };
const concurrency = { baseline: { maxConcurrentModels: 2, maxActiveChildren: 8 }, optimized: { maxConcurrentModels: 8, maxActiveChildren: 16 } };
const json = (file, data) => writeFile(file, JSON.stringify(data));

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodo-efficiency-'));
  const repository = path.join(directory, 'repo'), root = path.join(directory, 'evidence');
  for (const name of ['src', 'dist/cli', 'scripts/comparison/frontier']) await mkdir(path.join(repository, name), { recursive: true });
  await mkdir(root);
  await writeFile(path.join(repository, 'src/main.ts'), 'export const version = 1;');
  await writeFile(path.join(repository, 'dist/cli/index.js'), 'export const version = 1;');
  for (const name of scripts) await writeFile(path.join(repository, 'scripts/comparison/frontier', name), '// offline fixture');
  await json(path.join(repository, 'dist/.kodo-build-manifest.json'), createBuildManifest(repository));
  await cp(path.join(repository, 'dist'), path.join(root, 'baseline-build'), { recursive: true });
  await json(path.join(root, 'scope.json'), scope);
  await writeFile(path.join(repository, 'src/main.ts'), 'export const version = 2;');
  await writeFile(path.join(repository, 'dist/cli/index.js'), 'export const version = 2;');
  await json(path.join(repository, 'dist/.kodo-build-manifest.json'), createBuildManifest(repository));
  return { directory, repository, root, close: () => rm(directory, { recursive: true, force: true }) };
}

async function completedCell(args, credit = 1, profileOverride) {
  const out = args[args.indexOf('--out') + 1], build = args[args.indexOf('--kodo-dist') + 1];
  const cell = path.join(out, 'fastapi-kodo');
  for (const dir of ['relay', 'process', 'state/kodo']) await mkdir(path.join(cell, dir), { recursive: true });
  const result = { harness: 'kodo', status: 'completed', elapsedSec: 4, verification: { passed: true }, instructionSha256: 'same-task',
    initialRepository: { branch: 'main', commit: '11614be9021aa4ac078d4d0693a8b5250a1010d8' } };
  await json(path.join(out, 'manifest.json'), { cells: [result], model: 'deepseek-v4.1-flash', contextTokens: scope.contextTokens,
    outputTokens: scope.outputTokens, kodoFactors: scope.factors,
    ...(args.includes('--kodo-max-concurrent-models') ? { kodoConcurrency: { maxConcurrentModels: Number(args[args.indexOf('--kodo-max-concurrent-models') + 1]), maxActiveChildren: Number(args[args.indexOf('--kodo-max-active-children') + 1]) } } : {}),
    kodoBuild: { buildManifestSha256: sha(await readFile(path.join(build, '.kodo-build-manifest.json'))) } });
  await json(path.join(cell, 'git-state.json'), { branch: 'feature/test\n', head: 'new-commit\n', status: '', commits: 'new-commit fixture\n' });
  const call = { index: 1, status: 'completed', startedMs: 1000, elapsedMs: 100, httpStatus: 200, usage: { prompt_tokens: 20, completion_tokens: 10, ...(credit === null ? {} : { credit }) } };
  await json(path.join(cell, 'relay/calls.json'), [call]);
  await json(path.join(cell, 'relay/request-1.json'), { messages: [{ role: 'system', content: 'Run ID: root.' }], tools: [] });
  await cp(path.join(cell, 'relay/request-1.json'), path.join(cell, 'relay/request-incoming-1.json'));
  await writeFile(path.join(cell, 'relay/response-1.txt'), 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  await writeFile(path.join(cell, 'process/steps.jsonl'), JSON.stringify({ index: 1, step: 1, runId: 'root', startedMs: 1000, credit }) + '\n');
  await writeFile(path.join(cell, 'process/tools.jsonl'), '');
  await writeFile(path.join(cell, 'process/transcript.md'), 'done');
  await json(path.join(cell, 'process/summary.json'), { requests: 1 });
  await json(path.join(cell, 'process/execution-archive.json'), { status: 'absent' });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(cell, 'state/kodo/kodo.sqlite'));
  try {
    db.exec('CREATE TABLE runs(data TEXT); CREATE TABLE calls(data TEXT); CREATE TABLE sessions(data TEXT); CREATE TABLE events(seq INTEGER,time TEXT,run_id TEXT,type TEXT,data TEXT); CREATE TABLE blob_segments(ref TEXT,data TEXT);');
    const final = JSON.stringify({ text: 'Implemented and verified.' }), ref = sha(final);
    db.prepare('INSERT INTO runs VALUES(?)').run(JSON.stringify({ id: 'root', sessionId: 's', status: 'completed', createdAt: new Date(1000).toISOString(), resultRef: ref }));
    const profile = profileOverride ?? (path.basename(build) === 'optimized-build' ? { taskProtocol: 2, toolProfile: 'compact-v1' } : {});
    db.prepare('INSERT INTO sessions VALUES(?)').run(JSON.stringify({ id: 's', workspace: '/app', agentFactors: flags, ...profile }));
    db.prepare('INSERT INTO blob_segments VALUES(?,?)').run(ref, final);
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(1, new Date(4000).toISOString(), 'root', 'run.completed', '{}');
  } finally { db.close(); }
  return 0;
}

test('rejects expanded scope and corrupted frozen artifacts before any experiment', async () => {
  assert.doesNotThrow(() => validateScope(scope));
  assert.throws(() => validateScope({ ...scope, repeats: 3 }), /Scope/);
  const f = await fixture();
  try {
    await frozenBuild(path.join(f.root, 'baseline-build'));
    await writeFile(path.join(f.root, 'baseline-build/cli/index.js'), 'changed');
    let calls = 0;
    await assert.rejects(runComparison(f.root, { repository: f.repository, execute: async () => { calls++; } }), /Frozen build changed/);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('concurrency arguments preserve defaults and reject invalid limits', () => {
  assert.deepEqual(kodoConcurrencyArgs(), []);
  assert.deepEqual(kodoConcurrencyArgs(concurrency.optimized), ['--max-concurrent-models', '8', '--max-active-children', '16']);
  for (const value of [0, -1, 1.5, null, '8']) assert.throws(() => kodoConcurrencyArgs({ maxConcurrentModels: value }), /Invalid/);
  assert.throws(() => validateScope({ ...scope, concurrency }), /parallelism-v1/);
  assert.throws(() => validateScope({ ...scope, experiment: 'parallelism-v1', concurrency: { baseline: concurrency.baseline } }), /positive limits/);
});

test('concurrency pair uses one build and checks persisted limits rather than command flags alone', async () => {
  for (const mismatch of [false, true]) {
    const f = await fixture(); let count = 0;
    try {
      await cp(path.join(f.repository, 'dist'), path.join(f.root, 'baseline-build'), { recursive: true });
      await json(path.join(f.root, 'scope.json'), { ...scope, experiment: 'parallelism-v1', concurrency });
      const matrix = await runComparison(f.root, { repository: f.repository, execute: async args => {
        count++;
        const arm = path.basename(args[args.indexOf('--out') + 1]);
        assert.equal(Number(args[args.indexOf('--kodo-max-concurrent-models') + 1]), concurrency[arm].maxConcurrentModels);
        return completedCell(args, 1, { taskProtocol: 3, toolProfile: 'compact-v2', budget: mismatch ? { maxConcurrentModels: 1, maxActiveChildren: 8 } : concurrency[arm] });
      } });
      assert.equal(count, mismatch ? 1 : 2);
      assert.equal(matrix.stopReason, mismatch ? 'experiment conditions mismatch' : undefined);
      if (mismatch) assert.ok(matrix.cells[0].conditionErrors.includes('persisted concurrency'));
      else assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'source-changes.json'), 'utf8')), []);
    } finally { await f.close(); }
  }
});

test('concurrency comparison rejects differing builds before executing either cell', async () => {
  const f = await fixture(); let count = 0;
  try {
    await json(path.join(f.root, 'scope.json'), { ...scope, experiment: 'parallelism-v1', concurrency });
    await assert.rejects(runComparison(f.root, { repository: f.repository, execute: async () => { count++; } }), /same source and build/);
    assert.equal(count, 0);
  } finally { await f.close(); }
});

test('stops the matrix after infrastructure failure and archives failure without starting second cell', async () => {
  const f = await fixture(); let count = 0;
  try {
    const matrix = await runComparison(f.root, { repository: f.repository, execute: async args => {
      count++; const out = args[args.indexOf('--out') + 1]; await mkdir(out);
      await json(path.join(out, 'manifest.json'), { cells: [{ status: 'infra_invalid' }] }); return 0;
    } });
    assert.equal(count, 1); assert.equal(matrix.cells[1].status, 'not_started'); assert.equal(matrix.stopReason, 'infrastructure invalid');
    assert.equal(matrix.comparison.wallReductionPercent, null);
    assert.ok((JSON.parse(await readFile(path.join(f.root, 'evidence-sha256.json'), 'utf8'))).some(file => file.path === 'matrix.json'));
    await assert.rejects(runComparison(f.root, { repository: f.repository, execute: async () => { count++; } }), /overwrite/);
    assert.equal(count, 1);
  } finally { await f.close(); }
});

test('runs exactly the registered pair and leaves unknown credit unknown', async () => {
  const f = await fixture(); let count = 0;
  try {
    const matrix = await runComparison(f.root, { repository: f.repository, execute: async args => completedCell(args, ++count === 1 ? 1 : null) });
    assert.equal(count, 2); assert.equal(matrix.stopReason, undefined);
    assert.equal(matrix.comparison.completeObserved, true); assert.equal(matrix.comparison.wallReductionPercent, 0);
    assert.equal(matrix.comparison.creditReductionPercent, null);
    assert.equal(matrix.cells[1].analysis.usage.credit.missingRequests, 1);
    assert.equal(matrix.cells[1].analysis.usage.credit.complete, false);
    assert.equal(matrix.cells[0].analysis.savedConfiguration[0].taskProtocol, null);
    assert.equal(matrix.cells[1].analysis.savedConfiguration[0].taskProtocol, 2);
    assert.equal(matrix.cells[1].analysis.savedConfiguration[0].toolProfile, 'compact-v1');
    assert.ok((JSON.parse(await readFile(path.join(f.root, 'source-changes.json'), 'utf8'))).some(file => file.path === 'src/main.ts'));
  } finally { await f.close(); }
});

test('rejects task-protocol/tool-profile treatment mismatch even when ABCDE and quality pass', async () => {
  for (const badArm of ['baseline', 'optimized']) {
    const f = await fixture(); let count = 0;
    try {
      const matrix = await runComparison(f.root, { repository: f.repository, execute: async args => {
        count++;
        const arm = path.basename(args[args.indexOf('--out') + 1]);
        const wrongProfile = badArm === 'baseline' ? { taskProtocol: 2, toolProfile: 'compact-v1' } : {};
        return completedCell(args, 1, arm === badArm ? wrongProfile : undefined);
      } });
      assert.equal(count, badArm === 'baseline' ? 1 : 2);
      assert.equal(matrix.stopReason, 'experiment conditions mismatch');
      assert.ok(matrix.cells.find(cell => cell.name === badArm).conditionErrors.includes('persisted task protocol/tool profile'));
      if (badArm === 'baseline') assert.equal(matrix.cells[1].status, 'not_started');
      assert.equal(matrix.comparison.completeObserved, false);
      assert.equal(matrix.comparison.wallReductionPercent, null);
      assert.equal(matrix.comparison.creditReductionPercent, null);
    } finally { await f.close(); }
  }
});

test('script drift invalidates the comparison and prevents the next cell', async () => {
  const f = await fixture(); let count = 0;
  try {
    const matrix = await runComparison(f.root, { repository: f.repository, execute: async args => {
      count++; await completedCell(args); await writeFile(path.join(f.repository, 'scripts/comparison/frontier/relay.mjs'), '// changed'); return 0;
    } });
    assert.equal(count, 1); assert.equal(matrix.stopReason, 'experiment scripts changed'); assert.equal(matrix.cells[1].status, 'not_started');
  } finally { await f.close(); }
});

test('usage, overlap and verdict distinguish known zero, missing costs and incomplete quality', () => {
  const usage = usageTotals([{ status: 'completed', usage: { credit: 0 } }, { status: 'completed' }]);
  assert.deepEqual(usage.credit, { knownSubtotal: 0, missingRequests: 1, complete: false });
  assert.equal(overlapSeconds([[0, 1000], [500, 1500], [750, 1250]]), 0.75);
  assert.equal(overlapSeconds([[0, 1000], [1000, 2000]]), 0);
  assert.equal(peakConcurrency([[0, 1000], [1000, 2000], [1000, 1000]]), 1);
  assert.equal(peakConcurrency([[0, 1000], [500, 1500], [750, 1250]]), 3);
  assert.equal(comparisonVerdict([{ name: 'baseline', analysis: { delivery: { completeObserved: false } } }]).wallReductionPercent, null);
  assert.deepEqual(sourceChanges({ a: '1', b: '2' }, { a: '1', c: '3' }).map(item => item.kind), ['removed', 'added']);
  assert.equal(stopReason({ runnerExitCode: 1 }), 'runner failed');
  assert.equal(stopReason({ runnerExitCode: 0, result: { status: 'completed', recordingErrors: ['archive copy failed'] } }), 'execution evidence incomplete');
});

test('analysis retains actual todo bindings and execution, lock, dependency and event-wait records', async () => {
  const f = await fixture();
  try {
    const out = path.join(f.root, 'sample');
    await completedCell(['--out', out, '--kodo-dist', path.join(f.root, 'baseline-build')]);
    const directory = path.join(out, 'fastapi-kodo');
    const todo = { id: 'verify', generation: 4, dependencies: [{ id: 'implement', generation: 2 }], ready: true };
    const execution = { kind: 'clone', root: '/.kodo-executions/s/child', sourceRoot: '/app', baseCommit: 'base' };
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(directory, 'state/kodo/kodo.sqlite'));
    const types = ['execution.created', 'execution.committed', 'execution.integrated', 'todo.dependencies.ready', 'todo.dependencies.changed',
      'todo.dependencies.blocked', 'lock.waited', 'lock.acquired', 'lock.released', 'tool.resource_ready', 'wait.renewed', 'wait.settled', 'run.queued'];
    try {
      db.prepare('INSERT INTO runs VALUES(?)').run(JSON.stringify({ id: 'child', parentId: 'root', sessionId: 's', status: 'completed',
        createdAt: new Date(1000).toISOString(), todo, execution }));
      const put = db.prepare('INSERT INTO events VALUES(?,?,?,?,?)');
      types.forEach((type, index) => put.run(index + 2, new Date(1200 + index).toISOString(), 'child', type, JSON.stringify({ todoId: todo.id })));
      put.run(types.length + 2, new Date(2000).toISOString(), 'child', 'run.completed', '{}');
      put.run(types.length + 3, new Date(2001).toISOString(), 'child', 'tool.finished', '{}');
      for (let i = 0; i < 2; i++) {
        const id = `check-${i}`, request = JSON.stringify({ name: 'shell.exec', arguments: JSON.stringify({ command: 'pytest -q' }) });
        const result = JSON.stringify({ exitCode: 0 });
        for (const blob of [request, result]) db.prepare('INSERT OR IGNORE INTO blob_segments VALUES(?,?)').run(sha(blob), blob);
        db.prepare('INSERT INTO calls VALUES(?)').run(JSON.stringify({ id, runId: 'root', kind: 'tool', name: 'shell.exec', status: 'succeeded', requestRef: sha(request), resultRef: sha(result) }));
        for (const [offset, type, time, data] of [[0, 'check.started', 2500 + i * 200, { callId: id, version: 'same', cwd: '/app', command: 'pytest -q' }],
          [1, 'tool.started', 2500 + i * 200, { callId: id }], [2, 'tool.finished', 2600 + i * 200, { callId: id, status: 'succeeded' }]]) {
          put.run(100 + i * 3 + offset, new Date(time).toISOString(), 'root', type, JSON.stringify(data));
        }
      }
    } finally { db.close(); }
    const analysis = await analyzeComparisonCell(directory);
    assert.deepEqual(analysis.childRuns[0].todo, todo);
    assert.equal(analysis.childRuns[0].todoId, 'verify');
    assert.deepEqual(analysis.childRuns[0].execution, execution);
    for (const type of types) assert.ok(analysis.taskEvents.some(event => event.type === type), type);
    assert.equal(analysis.taskEvents.some(event => event.type === 'tool.finished'), false);
    assert.equal(analysis.repeatedChecks.repeatedBroadInvocations, 1);
    assert.equal(analysis.repeatedChecks.knownRepeatedBroadCallSeconds, 0.1);
    assert.equal(analysis.repeatedChecks.tests[1].previousSuccessfulCallId, 'check-0');
  } finally { await f.close(); }
});

test('sandbox experiments preserve the explicit isolation selection', () => {
  assert.deepEqual(kodoSandboxArgs(), []);
  assert.deepEqual(kodoSandboxArgs(false), []);
  assert.deepEqual(kodoSandboxArgs(true), ['--sandbox']);
  assert.throws(() => kodoSandboxArgs('true'), /Invalid/);
});

test('new team trials select isolation, while explicit legacy trials remain reproducible', () => {
  assert.equal(selectKodoSandbox('lean-team'), true);
  assert.equal(selectKodoSandbox('lean-team', false, true), false);
  assert.equal(selectKodoSandbox('lean-solo'), false);
  assert.equal(selectKodoSandbox('lean-solo', true), true);
  assert.throws(() => selectKodoSandbox('lean-team', true, true), /Choose only one/);
});

test('sandbox preflight requires a successful native probe, not just a successful process', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodo-preflight-'));
  const cli = path.join(directory, 'doctor.cjs');
  try {
    await writeFile(cli, 'console.log(JSON.stringify({sandbox:{passed:true}}))');
    assert.equal((await sandboxPreflight(process.execPath, cli, directory, process.env)).sandbox.passed, true);
    await writeFile(cli, 'console.log(JSON.stringify({sandbox:{passed:false}}))');
    await assert.rejects(sandboxPreflight(process.execPath, cli, directory, process.env), /did not confirm/);
    await writeFile(cli, 'process.stderr.write("backend unavailable");process.exitCode=1');
    await assert.rejects(sandboxPreflight(process.execPath, cli, directory, process.env), /backend unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
