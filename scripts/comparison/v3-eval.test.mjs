import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compactionPlan, summarize as summarizeCompaction } from './v3-compaction-eval.mjs';
import { delegationPlan, summarize as summarizeDelegation, surveyAnswers } from './v3-delegation-eval.mjs';
import { deliveryCheck, protectedSnapshot, usageLedger } from './v3-eval-ledger.mjs';
import { completeness, fatalRules, parsePrices, prepareOutput, priceLedger, readProgress, runMatrix } from './v3-eval-matrix.mjs';

const temp = () => mkdtempSync(path.join(tmpdir(), 'kodo-v3-eval-'));
const measured = (tokens = 1000) => ({ totalTokens: tokens, inputTokens: tokens - 100, outputTokens: 100, cacheRead: 0, cacheWrite: 0, uncachedInput: tokens - 100, unknownCalls: 0, peakMainInput: 500, wallMs: 1000, compactionTokens: 0 });
const cell = (key, overrides = {}) => {
  const [task, arm, repeat] = key.split(':');
  return { key, task, arm, repeat: Number(repeat), policy: arm === 'off' ? null : { strategy: arm }, status: 'completed', completed: true, usage: measured(), deterministicFailures: [], summaryFailures: [], compaction: arm === 'summary' ? { 'context.summary.installed': 1 } : {}, ...overrides };
};
const fullPlan = compactionPlan(['task-a', 'task-b'], ['off', 'summary'], 2);

/** A cell function that records starts and simulated upstream requests; `rejectAt` returns a relay rejection. */
function scripted(rejectAt) {
  const log = { started: [], requests: 0 };
  return { log, runCell: async key => {
    log.started.push(key);
    log.requests += 3;
    return { relay: { requests: 3, tokens: 300, rejected: key === rejectAt ? ['MODEL_CALL_BUDGET'] : [], estimated: false }, status: 'completed' };
  } };
}

test('a relay rejection at the first, a middle or the last cell stops the whole matrix', async () => {
  const plan = ['a:1', 'a:2', 'b:1', 'b:2', 'c:1'];
  for (const [at, index] of [['a:1', 0], ['b:1', 2], ['c:1', 4]]) {
    const outRoot = temp();
    try {
      const { log, runCell } = scripted(at);
      const { stop, results } = await runMatrix({ outRoot, plan, runCell });
      assert.deepEqual(log.started, plan.slice(0, index + 1), `no cell starts after ${at}`);
      assert.equal(log.requests, 3 * (index + 1), 'no upstream request after the rejecting cell');
      assert.match(stop.reason, /^RELAY_REJECTED/u);
      const progress = readProgress(outRoot);
      assert.equal(progress.state, 'stopped');
      assert.deepEqual(progress.completed, plan.slice(0, index + 1));
      assert.deepEqual(progress.notStarted, plan.slice(index + 1));
      assert.equal(results.length, index + 1);
    } finally { rmSync(outRoot, { recursive: true, force: true }); }
  }
});

test('the matrix budget stops before a cell starts and caps the next cell', async () => {
  const outRoot = temp();
  try {
    const seen = [];
    const { stop, results } = await runMatrix({ outRoot, plan: ['x:1', 'x:2', 'x:3'], budget: { requests: 5 },
      runCell: async (key, remaining) => { seen.push(remaining.requests); return { relay: { requests: 3, tokens: 1, rejected: [] } }; } });
    assert.deepEqual(seen, [5, 2]);
    assert.equal(results.length, 2);
    assert.equal(stop.reason, 'MATRIX_BUDGET');
    assert.equal(stop.at, 'x:3');
  } finally { rmSync(outRoot, { recursive: true, force: true }); }
});

test('a crash mid-matrix keeps completed evidence readable and marks the cell interrupted', async () => {
  const outRoot = temp();
  try {
    const { stop } = await runMatrix({ outRoot, plan: ['p:1', 'p:2', 'p:3'], runCell: async key => {
      if (key === 'p:2') throw new Error('provider exploded');
      return { status: 'completed' };
    } });
    assert.match(stop.reason, /^CELL_ERROR/u);
    const progress = readProgress(outRoot);
    assert.deepEqual(progress.completed, ['p:1']);
    assert.deepEqual(progress.interrupted, ['p:2']);
    assert.deepEqual(progress.notStarted, ['p:3']);
    // A process that died while a cell was running leaves state "running".
    const crashed = JSON.parse(readFileSync(path.join(outRoot, 'progress.json'), 'utf8'));
    writeFileSync(path.join(outRoot, 'progress.json'), JSON.stringify({ ...crashed, state: 'running', running: 'p:3', stop: null }));
    assert.deepEqual(readProgress(outRoot).interrupted, ['p:3']);
    assert.throws(() => prepareOutput(outRoot), /not empty/u, 'existing evidence is never overwritten');
  } finally { rmSync(outRoot, { recursive: true, force: true }); }
});

test('registered fatal conditions stop the matrix; ordinary task failures do not', () => {
  const fatal = fatalRules();
  assert.equal(fatal({ status: 'failed', usage: { providerFailures: 0 } }), null);
  assert.equal(fatal({ status: 'failed', usage: { providerFailures: 1 } }), null);
  assert.equal(fatal({ status: 'failed', usage: { providerFailures: 2 } }), 'PROVIDER_FAILURES');
  assert.equal(fatalRules()({ delivery: { reasons: ['PROTECTED_SET_CHANGED'] } }), 'PROTECTED_VIOLATION');
  assert.equal(fatalRules()({ relay: { estimated: true } }), 'USAGE_UNRECONCILED');
});

test('an agent cancellation within tolerance is a lower bound, not a matrix stop', () => {
  const cancelled = { status: 'completed', relay: { estimated: true, unmeasured: 1, clientAborted: 1 }, usage: { providerFailures: 0, unknownCalls: 1, agentCancelledUnknown: 1 } };
  assert.equal(fatalRules({ agentCancelTolerance: 2 })(cancelled), null);
  // Without a registered tolerance the old rule holds.
  assert.equal(fatalRules()(cancelled), 'USAGE_UNRECONCILED');
  // Over tolerance, an upstream transport loss, or an unknown call outside an agent cancel still stops.
  assert.equal(fatalRules({ agentCancelTolerance: 2 })({ ...cancelled, relay: { estimated: true, unmeasured: 3, clientAborted: 3 }, usage: { ...cancelled.usage, unknownCalls: 3, agentCancelledUnknown: 3 } }), 'USAGE_UNRECONCILED');
  assert.equal(fatalRules({ agentCancelTolerance: 2 })({ ...cancelled, relay: { estimated: true, unmeasured: 1, clientAborted: 0 } }), 'USAGE_UNRECONCILED');
  assert.equal(fatalRules({ agentCancelTolerance: 2 })({ ...cancelled, usage: { ...cancelled.usage, unknownCalls: 2 } }), 'USAGE_UNRECONCILED');
});

test('the ledger attributes unknown calls of agent-cancelled runs and does not count them as provider failures', () => {
  const store = {
    listRuns: () => [{ id: 'main' }, { id: 'child', parentId: 'main' }, { id: 'grand', parentId: 'child' }],
    run: id => ({ id }),
    calls: id => ({ main: [], child: [{ id: 'c1', kind: 'model', status: 'cancelled', resultRef: 'lost', reservedTokens: 900 }], grand: [{ id: 'g1', kind: 'model', status: 'cancelled', resultRef: 'lost', reservedTokens: 100 }] })[id],
    events: id => ({
      main: [],
      child: [{ type: 'run.cancelled', time: '2026-10-26T00:00:00.000Z', data: { initiator: 'agent', by: 'main', callId: 'x' } }, { type: 'model.failed', time: '2026-10-26T00:00:01.000Z', data: { callId: 'c1' } }],
      grand: [{ type: 'run.cancelled', time: '2026-10-26T00:00:00.000Z', data: { initiator: 'parent', by: 'child' } }],
    })[id],
    readBlob: () => ({ error: 'x', usage: 'unknown; reservation retained' }),
  };
  const ledger = usageLedger(store, 's');
  assert.equal(ledger.unknownCalls, 2);
  assert.equal(ledger.agentCancelledUnknown, 2);
  assert.equal(ledger.unknownReservedTokens, 1000);
  assert.equal(ledger.providerFailures, 0);
  assert.equal(ledger.complete, false);
});

test('a complete, measured, delivered matrix passes', () => {
  const report = summarizeCompaction(fullPlan.map(key => cell(key, key.includes('summary') ? { usage: measured(800) } : {})), { plan: fullPlan });
  assert.equal(report.verdict, 'passed', report.reasons.join(','));
});

test('off and summary both failing cannot pass on relative completion', () => {
  const results = fullPlan.map(key => cell(key, { status: 'failed', completed: false }));
  const report = summarizeCompaction(results, { plan: fullPlan });
  assert.equal(report.verdict, 'failed');
  assert.ok(report.reasons.includes('qualityFloor'));
});

test('all failed with unknown usage is never passed', () => {
  const results = fullPlan.map(key => cell(key, { status: 'failed', completed: false, usage: { ...measured(0), unknownCalls: 1 } }));
  assert.notEqual(summarizeCompaction(results, { plan: fullPlan }).verdict, 'passed');
});

test('skipping the expensive samples leaves the matrix incomplete, not passed', () => {
  const cheap = fullPlan.filter(key => !key.startsWith('task-b')).map(key => cell(key));
  const report = summarizeCompaction(cheap, { plan: fullPlan });
  assert.equal(report.verdict, 'inconclusive');
  assert.ok(report.reasons.includes('MATRIX_INCOMPLETE'));
  assert.deepEqual(report.matrix.missing, fullPlan.filter(key => key.startsWith('task-b')));
});

test('duplicated cells or a mixed policy make the matrix invalid', () => {
  const results = fullPlan.map(key => cell(key));
  assert.equal(summarizeCompaction([...results, results[0]], { plan: fullPlan }).verdict, 'invalid');
  const mixed = results.map(result => (result.arm === 'summary' && result.repeat === 2 ? { ...result, policy: { strategy: 'hybrid' } } : result));
  const report = summarizeCompaction(mixed, { plan: fullPlan });
  assert.equal(report.verdict, 'invalid');
  assert.equal(report.matrix.mixedPolicy.length, 2);
});

test('a failed call with spending but no usage makes the cost inconclusive', () => {
  const results = fullPlan.map(key => cell(key, key === 'task-a:summary:1' ? { usage: { ...measured(10), unknownCalls: 1 } } : {}));
  const report = summarizeCompaction(results, { plan: fullPlan });
  assert.equal(report.verdict, 'inconclusive');
  assert.equal(report.passLine.costNotAboveOff, null);
  assert.equal(report.cost.certain, false);
  assert.ok(report.reasons.includes('USAGE_UNKNOWN'));
});

/** Minimal store over in-memory runs, calls, events and blobs. */
function fakeStore({ runs, calls, events = {}, blobs }) {
  return { listRuns: () => runs, calls: id => calls[id] ?? [], events: id => events[id] ?? [], readBlob: ref => blobs[ref] };
}

test('the ledger counts unknown usage separately and never as zero', () => {
  const store = fakeStore({
    runs: [{ id: 'main' }, { id: 'child', parentId: 'main' }],
    calls: {
      main: [
        { kind: 'model', status: 'succeeded', resultRef: 'ok', purpose: undefined },
        { kind: 'model', status: 'failed', resultRef: 'lost' },
        { kind: 'model', status: 'failed', resultRef: 'zero' },
        { kind: 'model', status: 'succeeded', resultRef: 'summary', purpose: 'compaction' },
        { kind: 'tool', name: 'file.read', requestRef: 'r1' }, { kind: 'tool', name: 'file.read', requestRef: 'r1' },
      ],
      child: [{ kind: 'model', status: 'succeeded', resultRef: 'nousage' }],
    },
    events: { main: [{ type: 'model.failed', time: '2026-10-24T00:00:00.000Z', data: {} }, { type: 'run.completed', time: '2026-10-24T00:00:04.000Z', data: {} }] },
    blobs: { ok: { usage: { input: 100, output: 10, cacheRead: 40 } }, lost: { error: 'x', usage: 'unknown; reservation retained' }, zero: { error: 'x', usage: 'known-zero' }, summary: { usage: { input: 50, output: 5 } }, nousage: {}, r1: { arguments: '{"path":"a.txt"}' } },
  });
  const ledger = usageLedger(store, 's');
  assert.equal(ledger.unknownCalls, 2);
  assert.equal(ledger.knownZeroCalls, 1);
  assert.equal(ledger.complete, false);
  assert.equal(ledger.totalTokens, 165);
  assert.equal(ledger.uncachedInput, 110);
  assert.equal(ledger.roles.main.rereads, 1);
  assert.equal(ledger.roles.compaction.requests, 1);
  assert.equal(ledger.roles.child.unknown, 1);
  assert.equal(ledger.wallMs, 4000);
  assert.equal(priceLedger(ledger, parsePrices('1,0.1,2')).certain, false);
});

test('a new file under a protected directory fails delivery like an edit', () => {
  const root = temp();
  try {
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(root, 'docs', 'a.md'), 'a');
    writeFileSync(path.join(root, 'verify.mjs'), 'v');
    const before = protectedSnapshot(root, ['docs', 'verify.mjs']);
    writeFileSync(path.join(root, 'docs', 'added.md'), 'new');
    const added = deliveryCheck({ status: 'completed', finalText: 'done', acceptance: true, before, after: protectedSnapshot(root, ['docs', 'verify.mjs']) });
    assert.equal(added.ok, false);
    assert.deepEqual(added.protected.added, ['docs/added.md']);
    rmSync(path.join(root, 'verify.mjs'));
    const removed = deliveryCheck({ status: 'completed', finalText: 'done', acceptance: true, before, after: protectedSnapshot(root, ['docs', 'verify.mjs']) });
    assert.ok(removed.protected.removed.includes('verify.mjs'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an empty reply fails delivery even when the run completed and acceptance passed', () => {
  assert.deepEqual(deliveryCheck({ status: 'completed', finalText: '  ', acceptance: true }).reasons, ['EMPTY_REPLY']);
  const report = summarizeCompaction(fullPlan.map(key => cell(key, key === 'task-b:summary:2' ? { completed: false } : {})), { plan: fullPlan });
  assert.notEqual(report.verdict, 'passed');
});

test('delegation lines are not computed from unknown usage, and incomplete matrices are labelled', () => {
  const plan = delegationPlan(['m'], [['survey', 'explore'], ['survey', 'solo']], 2);
  assert.deepEqual(plan, ['m:survey:explore:1', 'm:survey:solo:1', 'm:survey:solo:2', 'm:survey:explore:2']);
  const result = (key, usage) => { const [model, group, arm, repeat] = key.split(':'); return { key, model, group, arm, repeat: Number(repeat), policy: arm === 'solo' ? { delegation: false, exploreNudge: false } : { delegation: true, exploreNudge: false }, success: true, usage }; };
  const report = summarizeDelegation(plan.map(key => result(key, key === 'm:survey:solo:2' ? { ...measured(), unknownCalls: 1 } : measured())), { plan });
  assert.equal(report.matrixState, 'complete');
  assert.equal(report.usageComplete, false);
  assert.equal(report.lines.m.surveyTokensVsSolo, null);
  assert.equal(summarizeDelegation(plan.slice(0, 2).map(key => result(key, measured())), { plan }).matrixState, 'incomplete');
});

test('completeness reports missing, duplicate and unexpected cells', () => {
  const report = completeness(['a', 'b'], [{ key: 'a' }, { key: 'a' }, { key: 'z' }]);
  assert.deepEqual(report, { complete: false, valid: false, missing: ['b'], duplicated: ['a'], unexpected: ['z'], mixedPolicy: [] });
});

test('survey scoring still accepts a second numbered answer block', () => {
  const text = '1. evidence only\n1. 8 — runtime/types.ts\n';
  assert.equal(surveyAnswers(text)[0], true);
});
