import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { REGISTRATION, armForKey, experimentPlan, genericCard, kyFatalRules, soloProvider } from './eval.mjs';
import { prepareOutput, runMatrix } from '../v3-eval-matrix.mjs';

const binding = { model: 'fixture', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_KY_DRY_UNUSED', limits: { context: 65_536, output: 8_192 } };
const usage = { input: 1000, output: 50 };
const answer = content => ({ message: { role: 'assistant', content }, finishReason: 'stop', usage });
const calls = (...tool_calls) => ({ message: { role: 'assistant', content: null, tool_calls }, finishReason: 'tool_calls', usage });
const call = (name, args, id) => ({ id, name, arguments: JSON.stringify(args) });
const runId = request => {
  const system = request.messages.find(message => message.role === 'system')?.content ?? '';
  return /Run ID: ([^. ]+)\./u.exec(system)?.[1];
};
const toolResult = (request, id) => {
  const message = request.messages.findLast(item => item.role === 'tool' && item.tool_call_id === id);
  return message ? JSON.parse(message.content) : null;
};

test('freezes the exact alternating 2x2 order and policies', () => {
  assert.deepEqual(experimentPlan(), ['A1', 'D1', 'B1', 'C1', 'C2', 'B2', 'D2', 'A2']);
  assert.deepEqual(armForKey('A1').policy, { delegation: false, compaction: null });
  assert.deepEqual(armForKey('D2').policy, { delegation: true, compaction: { strategy: 'summary', triggerRatio: 0.8 } });
});

test('v2-r10 registration sets no caps and gives every arm the same isolated public-test tool', () => {
  assert.equal(REGISTRATION.id, 'ky-total-timeout-v2-r10');
  assert.equal(REGISTRATION.agentCancelTolerance, 2);
  for (const cap of ['maxModelCalls', 'maxTokens', 'maxToolCalls', 'maxDurationMs', 'matrixCalls', 'matrixTokens', 'workInputTokens']) assert.equal(cap in REGISTRATION, false, cap);
  assert.equal(REGISTRATION.cacheReadCostPercent, 10);
  assert.deepEqual(REGISTRATION.deliverables, [{ path: 'DELIVERY.md', minBytes: 200 }, { pattern: 'test/**/*.{ts,js,mjs}', exclude: ['**/tmp-*', '**/scratch*'], changed: true }]);
  assert.deepEqual(REGISTRATION.scope.write, ['source', 'test', 'readme.md', 'DELIVERY.md', 'distribution', 'node_modules/.cache']);
  assert.ok(REGISTRATION.tools.includes('test.run'));
  assert.ok(REGISTRATION.testToolTimeoutMs < REGISTRATION.toolTimeoutMs);
});

test('solo provider removes delegation instructions and controls', async () => {
  let observed;
  const base = { async complete(request) { observed = request; return answer('done'); } };
  const provider = soloProvider(base);
  await provider.complete({
    binding, maxOutputTokens: 100,
    messages: [{ role: 'system', content: 'Prefix. You are the main agent. Only you can spawn/cancel children and ask the user. Own delivery and acceptance. Your context is limited; the reading and searching a child does never enters it, only its report. Use explore for work. Use spawn_agent only for modules. Verify child evidence and integration via inspect_run before accepting; completed is not acceptance. Re-plan when needed.' }],
    tools: [{ name: 'explore' }, { name: 'spawn_agent' }, { name: 'file.read' }],
  }, new globalThis.AbortController().signal, () => {});
  assert.deepEqual(observed.tools.map(tool => tool.name), ['file.read']);
  assert.doesNotMatch(observed.messages[0].content, /\b(?:explore|spawn_agent)\b/u);
});

test('stops after the first block only when all four deliveries fail', () => {
  const fatal = kyFatalRules();
  for (const [index, arm] of ['A', 'D', 'B'].entries()) assert.equal(fatal({ arm, block: 1, status: 'failed', delivery: { ok: false, reasons: [] }, usage: { providerFailures: 0 }, relay: { estimated: false, rejected: [] } }), null, `row ${index}`);
  assert.equal(fatal({ arm: 'C', block: 1, status: 'failed', delivery: { ok: false, reasons: [] }, usage: { providerFailures: 0 }, relay: { estimated: false, rejected: [] } }), 'BLOCK_1_NO_COMPLETE_DELIVERIES');
  const passing = kyFatalRules();
  for (const [index, arm] of ['A', 'D', 'B', 'C'].entries()) assert.equal(passing({ arm, block: 1, status: 'completed', delivery: { ok: index === 1, reasons: [] }, usage: { providerFailures: 0 }, relay: { estimated: false, rejected: [] } }), null);
});

test('treats usage, provider streak, and protection failures as matrix stops', () => {
  const base = { arm: 'A', block: 1, status: 'completed', delivery: { ok: true, reasons: [] }, usage: { providerFailures: 0 }, relay: { estimated: false, rejected: [] } };
  assert.equal(kyFatalRules()({ ...base, status: 'failed', error: 'SANDBOX_CLEANUP: journal retained' }), 'DETERMINISTIC_RUNTIME_CONTRACT');
  assert.equal(kyFatalRules()({ ...base, shutdownError: 'store close failed' }), 'DETERMINISTIC_RUNTIME_CONTRACT');
  // A model command that timed out is a failed trial, not a harness contract failure.
  assert.equal(kyFatalRules()({ ...base, status: 'failed', error: 'UNKNOWN_WRITE: write result is uncertain; inspect before continuing', delivery: { ok: false, reasons: ['RUN_NOT_COMPLETED'] } }), null);
  assert.equal(kyFatalRules()({ ...base, relay: { estimated: true, rejected: [] } }), 'USAGE_UNRECONCILED');
  assert.equal(kyFatalRules()({ ...base, delivery: { ok: false, reasons: ['PROTECTED_MODIFIED'] } }), 'PROTECTED_VIOLATION');
  const providers = kyFatalRules();
  const failed = { ...base, status: 'failed', delivery: { ok: false, reasons: ['RUN_NOT_COMPLETED'] }, usage: { providerFailures: 1 } };
  assert.equal(providers(failed), null);
  assert.equal(providers(failed), 'PROVIDER_FAILURES');
});

test('shared matrix runner stops immediately on relay rejection', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-ky-g2-relay-'));
  try {
    prepareOutput(root);
    const matrix = await runMatrix({ outRoot: root, plan: ['A1', 'D1'], runCell: async () => ({ relay: { requests: 1, tokens: 10, rejected: ['MODEL_CALL_BUDGET'] } }) });
    assert.equal(matrix.results.length, 1);
    assert.match(matrix.stop.reason, /^RELAY_REJECTED:/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('summary arm actually installs a checkpoint with the current Application', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-ky-g2-summary-'));
  mkdirSync(path.join(root, 'workspace'));
  const provider = { async complete(request) {
    if (request.toolChoice === 'none') return answer('Goal: finish the Ky change.\nUser constraints: preserve public behavior.\nKey decisions and reasons: none yet.\nFiles changed: none.\nFailed attempts and reasons: none.\nOpen items: implementation.\nNext step: inspect source/core/Ky.ts.');
    return answer('Dry summary-path delivery.');
  } };
  const { Application } = await import(pathToFileURL(path.resolve('dist/application/index.js')).href);
  const app = new Application(path.join(root, 'state'), provider, undefined, { exploration: false, structuredExploration: false, exploreNudge: false, compaction: REGISTRATION.arms.C.compaction });
  try {
    const run = app.createRun({ objective: 'Dry summary trigger.', workspace: path.join(root, 'workspace'), binding, card: genericCard(app, false), permissions: ['read'], budget: { maxContextTokens: 65_536, maxOutputTokens: 8_192, maxModelCalls: 20, maxTokens: 500_000 } });
    const current = app.store.run(run.id);
    const payload = 'Recorded historical source evidence. '.repeat(90);
    // Enough history to cross 0.8 of the effective window (about 39k of 49k tokens) without exceeding it.
    const rounds = Array.from({ length: 52 }, (_, index) => [
      { role: 'assistant', content: `Read source ${index}`, tool_calls: [{ id: `dry-${index}`, name: 'file.read', arguments: JSON.stringify({ path: `source/${index}.ts` }) }] },
      { role: 'tool', tool_call_id: `dry-${index}`, content: JSON.stringify({ path: `source/${index}.ts`, content: payload, hash: 'a'.repeat(64) }) },
    ]).flat();
    app.store.updateRun(run.id, { contextRef: app.store.blob([...app.store.readBlob(current.contextRef), ...rounds]) });
    const final = await app.run(run.id);
    assert.equal(final.status, 'completed');
    const eventTypes = app.store.events(run.id).map(event => event.type);
    assert.ok(eventTypes.includes('context.summary.started'), JSON.stringify(eventTypes));
    assert.ok(eventTypes.includes('context.summary.installed'), JSON.stringify(eventTypes));
  } finally { await app.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test('delegation arm can create, message, wait, inspect, and deliver', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-ky-g2-delegation-'));
  mkdirSync(path.join(root, 'workspace'));
  let app;
  const provider = { async complete(request) {
    const id = runId(request);
    const run = app.store.run(id);
    if (run.parentId) return answer('Child inspected the requested bounded area.');
    if (run.step === 0) return calls(call('spawn_agent', { objective: 'Inspect one bounded area', permissions: ['read'], acceptance: ['Return a non-empty result'] }, 'spawn'));
    const child = toolResult(request, 'spawn')?.id ?? app.store.listRuns(run.sessionId).find(candidate => candidate.parentId)?.id;
    if (run.step === 1) return calls(call('send_message', { to: child, kind: 'notice', content: 'Use source evidence only.' }, 'message'));
    if (run.step === 2) return calls(call('wait_for_events', { run_ids: [child], mode: 'all' }, 'wait'));
    if (run.step === 3) return calls(call('inspect_run', { run_id: child }, 'inspect'));
    return answer('Dry delegation-path delivery after inspecting the child result.');
  } };
  const { Application } = await import(pathToFileURL(path.resolve('dist/application/index.js')).href);
  app = new Application(path.join(root, 'state'), provider, undefined, { exploration: false, structuredExploration: false, exploreNudge: false });
  try {
    const run = app.createRun({ objective: 'Dry delegation trigger.', workspace: path.join(root, 'workspace'), binding, card: genericCard(app, true), permissions: ['read'], budget: { maxContextTokens: 65_536, maxOutputTokens: 8_192, maxModelCalls: 20, maxTokens: 500_000, maxChildren: 4, maxConcurrentModels: 3 } });
    assert.equal((await app.run(run.id)).status, 'completed');
    const names = app.store.calls(run.id).filter(item => item.kind === 'tool').map(item => item.name);
    assert.deepEqual(names, ['spawn_agent', 'send_message', 'wait_for_events', 'inspect_run']);
    assert.equal(app.store.listRuns(run.sessionId).filter(item => item.parentId).length, 1);
  } finally { await app.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

