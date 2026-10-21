import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { Application } from '../../dist/application/index.js';
import { collectSessionEvidence } from './assessment.mjs';
import { historyCatalogTask, prepareHistoryCatalog } from './complex-history.mjs';
import { createFixtures } from './fixtures.mjs';

test('autonomy and matched solo use an overall task without forcing or forbidding delegation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-autonomy-contract-'));
  try {
    const task = historyCatalogTask({ autonomous: true });
    await prepareHistoryCatalog(directory, { autonomous: true });
    const contract = await readFile(path.join(directory, 'HISTORY_CATALOG_TASK.md'), 'utf8');
    assert.doesNotMatch(task.objective + contract, /禁止调用或派生子代理|请单代理完成|组织两个子代理|必须独立单代理|\{\{EXECUTION_MODE\}\}/);
    assert.match(task.objective, /五份完整测试/);
    assert.match(contract, /不可修改现有测试/);
    const fixtures = createFixtures(path.resolve(import.meta.dirname, '../..'), directory, { autonomous: true });
    assert.deepEqual(fixtures.definitions.find(item => item.id === task.id), task);
    await prepareHistoryCatalog(directory);
    assert.match(await readFile(path.join(directory, 'HISTORY_CATALOG_TASK.md'), 'utf8'), /请单代理完成，禁止调用或派生子代理/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('whole-session evidence includes delegated processes, failed child tools and complete captured output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-autonomy-evidence-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  let app, mainId, childId;
  const tool = (name, args) => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: name, name, arguments: JSON.stringify(args) }] }, finishReason: 'tool_calls', usage: { input: 100, output: 10 } });
  const answer = content => ({ message: { role: 'assistant', content }, finishReason: 'stop', usage: { input: 100, output: 10 } });
  const provider = { async complete(request) {
    const id = /Run ID: ([^. ]+)\./.exec(request.messages[0].content)?.[1];
    const run = app.store.run(id);
    if (id === mainId) {
      assert.ok(request.tools.some(tool => tool.name === 'spawn_agent'));
      if (run.step === 0) return tool('spawn_agent', { objective: 'Capture delegated process evidence' });
      childId = app.store.listRuns().find(run => run.parentId === mainId).id;
      if (run.step === 1) return tool('wait_for_events', { run_ids: [childId], mode: 'all' });
      assert.equal(app.store.run(childId).status, 'completed');
      return answer('Reviewed child result');
    }
    assert.ok(!request.tools.some(tool => tool.name === 'spawn_agent'));
    if (run.step === 0) return tool('process.exec', { program: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(6200))'] });
    if (run.step === 1) return tool('file.read', { path: 'missing-file.txt' });
    return answer('Child finished with explicit read error evidence');
  } };
  app = new Application(path.join(directory, 'state'), provider);
  try {
    const options = { workspace, permissions: ['read', 'write', 'exec'], binding: { model: 'offline', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'UNUSED', limits: { context: 256_000, output: 8192 } } };
    mainId = app.createRun({ ...options, objective: 'Overall task', budget: { maxTokens: 1000000, maxOutputTokens: 512 } }).id;
    const unrelated = app.createRun({ ...options, objective: 'Different session' });
    assert.equal((await app.run(mainId)).status, 'completed');
    const evidence = collectSessionEvidence(app.store, mainId);
    assert.equal(evidence.runLedger.length, 2);
    assert.ok(!evidence.runLedger.some(run => run.id === unrelated.id));
    assert.equal(evidence.calls.length, app.store.calls(mainId).length + app.store.calls(childId).length);
    assert.ok(evidence.calls.some(call => call.runId === childId && call.name === 'file.read' && call.status === 'failed'));
    assert.equal(evidence.processEvidence.length, 1);
    assert.equal(evidence.processEvidence[0].runId, childId);
    assert.equal(evidence.processEvidence[0].result.stdout, 'x'.repeat(6200));
    assert.equal(evidence.processEvidence[0].result.capturedComplete, true);
    assert.equal(evidence.runLedger.reduce((n, run) => n + run.modelCalls, 0), app.store.session(app.store.run(mainId).sessionId).modelCalls);
    assert.equal(evidence.runLedger.reduce((n, run) => n + run.toolCalls, 0), app.store.session(app.store.run(mainId).sessionId).toolCalls);
  } finally { await app.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
