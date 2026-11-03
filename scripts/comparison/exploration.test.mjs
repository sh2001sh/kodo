import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { assess, collectMetrics, groups, matrix, preludePassed, prepareWorkspace, runComparison, summarize } from './exploration.mjs';

test('default matrix interleaves three repeats without conflating stale and unchanged tasks', () => {
  const rows = matrix();
  assert.equal(rows.length, 36);
  for (const scenario of ['short', 'branches', 'followup-current', 'followup-stale']) {
    for (const group of groups) assert.equal(rows.filter(row => row.scenario === scenario && row.group === group).length, 3);
    assert.equal(new Set([1, 2, 3].map(repeat => rows.find(row => row.repeat === repeat && row.scenario === scenario).group)).size, 3);
  }
  assert.throws(() => matrix(2), /At least 3/);
  assert.throws(() => matrix(NaN), /At least 3/);
});

test('CLI defaults to a dry matrix and refuses incomplete live configuration', () => {
  const result = spawnSync(process.execPath, ['scripts/benchmark-exploration.mjs'], { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).providerRequests, 0);
  const live = spawnSync(process.execPath, ['scripts/benchmark-exploration.mjs', '--live'], { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /requires explicit/);
});

test('execution API has no accidental default live mode', async () => {
  await assert.rejects(runComparison({ repeats: 3 }), /explicit scripted or live/);
  await assert.rejects(runComparison({ mode: 'live', repeats: 3 }), /explicit model/);
});

test('missing and failed provider usage remains missing; children do not imply adoption or quality', () => {
  const details = [{ run: { id: 'main' }, calls: [
    { kind: 'model', runId: 'main', status: 'failed', request: { messages: [] }, result: null },
    { kind: 'model', runId: 'main', status: 'succeeded', request: { messages: [] }, result: { usage: { input: 12, output: 4 } } },
  ] }, { run: { id: 'child', parentId: 'main', status: 'failed' }, calls: [] }];
  const metrics = collectMetrics(details, 'main', 10, { knowledgeCreated: 0, knowledgeAdopted: 0 });
  assert.equal(metrics.missingUsageRequests, 1);
  assert.equal(metrics.tokenUsageComplete, false);
  assert.equal(metrics.inputTokens, 12);
  assert.equal(metrics.failedModelRequests, 1);
  assert.equal(metrics.childrenCreated, 1);
  assert.equal(metrics.childrenCompleted, 0);
  assert.equal(metrics.knowledgeAdopted, 0);
  assert.equal(metrics.cost, null);
  const summary = summarize([{ scenario: 'short', group: 'baseline', passed: false, metrics }])[0];
  assert.equal(summary.failed, 1);
  assert.equal(summary.measuredInputTokens, 12);
  assert.equal(summary.missingUsageRequests, 1);
});

test('read duplication uses exact content versions and the input peak belongs to main', () => {
  const read = (runId, hash, status = 'succeeded') => ({ kind: 'tool', name: 'file.read', runId, status, request: { arguments: '{"path":"storage.mjs"}' }, result: { hash } });
  const model = (runId, input) => ({ kind: 'model', runId, status: 'succeeded', request: { messages: [], tools: [] }, result: { usage: { input, output: 2 } } });
  const details = [{ run: { id: 'main' }, calls: [read('main', 'v1'), read('main', 'v2'), read('main', 'v1', 'failed'), model('main', 20)], events: [
    { seq: 1, runId: 'main', type: 'model.started' }, { seq: 4, runId: 'main', type: 'model.finished' },
  ] }, { run: { id: 'child', parentId: 'main', status: 'completed' }, calls: [read('child', 'v1'), model('child', 200)], events: [
    { seq: 2, runId: 'child', type: 'run.started' }, { seq: 3, runId: 'child', type: 'model.started' },
    { seq: 5, runId: 'main', type: 'tool.started' }, { seq: 6, runId: 'child', type: 'model.finished' }, { seq: 7, runId: 'child', type: 'run.completed' },
  ] }];
  const metrics = collectMetrics(details, 'main', 10);
  assert.equal(metrics.repeatedVersionReads, 1);
  assert.equal(metrics.mainChildDuplicateVersions, 1);
  assert.equal(metrics.mainInputTokensPeak, 20);
  assert.equal(metrics.inputTokens, 220);
  assert.equal(metrics.modelConcurrencyPeak, 2);
  assert.equal(metrics.mainToolsWhileChildActive, 1);
});

test('prelude positive control requires both adoption and original child file evidence inspection', () => {
  const metrics = { knowledgeCreated: 1, knowledgeAdopted: 1, originalEvidenceInspected: 1 };
  assert.equal(preludePassed({ status: 'completed', metrics }), true);
  for (const missing of Object.keys(metrics)) assert.equal(preludePassed({ status: 'completed', metrics: { ...metrics, [missing]: 0 } }), false);
  assert.equal(preludePassed({ status: 'failed', metrics }), false);
  const evidence = { id: 'file-call', kind: 'tool', name: 'file.read', runId: 'child', status: 'succeeded', request: { arguments: '{"path":"storage.mjs"}' }, result: { hash: 'v1' } };
  const inspect = { kind: 'tool', name: 'inspect_run', runId: 'main', status: 'succeeded', request: { arguments: '{"run_id":"child","call_id":"file-call"}' }, result: { call: { id: 'file-call', name: 'file.read', status: 'succeeded' }, evidence: { text: '{"content":"source"}' } } };
  const details = inspection => [{ run: { id: 'main' }, calls: [inspection] }, { run: { id: 'child', parentId: 'main' }, calls: [evidence] }];
  assert.equal(collectMetrics(details(inspect), 'main', 1).originalEvidenceInspected, 1);
  assert.equal(collectMetrics(details({ ...inspect, request: { arguments: '{"run_id":"child"}' } }), 'main', 1).originalEvidenceInspected, 0);
  assert.equal(collectMetrics(details({ ...inspect, status: 'failed' }), 'main', 1).originalEvidenceInspected, 0);
  assert.equal(collectMetrics(details({ ...inspect, result: { ...inspect.result, evidence: null } }), 'main', 1).originalEvidenceInspected, 0);
});

test('behavior oracle rejects original bug, a normal-only patch and out-of-scope changes', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'kodo-exploration-oracle-'));
  try {
    await prepareWorkspace(workspace);
    const before = {};
    for (const name of ['page.mjs', 'storage.mjs', 'model.mjs', 'report.mjs']) before[name] = createHash('sha256').update(await readFile(path.join(workspace, name))).digest('hex');
    assert.equal((await assess(workspace, 'short', before)).passed, false);
    await writeFile(path.join(workspace, 'page.mjs'), 'export function page(a,i,s) { return a.slice((i-1)*s,i*s); }', 'utf8');
    assert.equal((await assess(workspace, 'short', before)).passed, false);
    await writeFile(path.join(workspace, 'page.mjs'), "export function page(a,i,s) { if(!Number.isSafeInteger(i)||i<1||!Number.isSafeInteger(s)||s<1) throw new RangeError(); return a.slice((i-1)*s,i*s); }", 'utf8');
    assert.equal((await assess(workspace, 'short', before)).passed, true);
    await writeFile(path.join(workspace, 'unexpected.mjs'), '// unrelated', 'utf8');
    const scope = await assess(workspace, 'short', before);
    assert.equal(scope.execution.exitCode, 0);
    assert.equal(scope.scopeRespected, false);
    assert.equal(scope.passed, false);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
