import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheReadShare, readMetrics, runMetrics, summarize } from './metrics.mjs';

const ledger = (overrides = {}) => ({
  modelCalls: 4, measuredCalls: 4, knownZeroCalls: 0, unknownCalls: 0,
  agentCancelledUnknown: 0, unknownReservedTokens: 0,
  inputTokens: 1_000, outputTokens: 100, cacheRead: 400, cacheWrite: 0, uncachedInput: 600,
  totalTokens: 1_100, providerFailures: 0, wallMs: 5_000, complete: true,
  roles: { main: { toolCalls: 2 }, child: { toolCalls: 1 }, compaction: { toolCalls: 0 } },
  ...overrides,
});

const relay = (overrides = {}) => ({ requests: 5, tokens: 4_000, rejected: [], ...overrides });

const report = (overrides = {}) => ({
  key: 'case-a:r1', caseId: 'case-a', category: 'literature', repeat: 1, status: 'completed',
  passed: true, humanPending: false, polluted: false,
  metrics: {
    usageComplete: true, totalTokens: 1_100, wallMs: 5_000, cacheReadShare: 0.4,
    cost: { basis: 'tokens', value: 1_100, certain: true },
    fileReadCalls: { main: 2, child: 0 }, rereads: { main: 1, child: 0 },
    childRereadOfMain: null, childRereadOfMainDetail: { numerator: 0, denominator: 0 },
  },
  score: { passed: true, score: 1, violations: [], rules: [], checks: [], ...(overrides.score ?? {}) },
  ...overrides,
});

test('cacheReadShare is cacheRead/inputTokens and null without input', () => {
  assert.equal(cacheReadShare(ledger()), 0.4);
  assert.equal(cacheReadShare(ledger({ inputTokens: 0, cacheRead: 0 })), null);
});

test('runMetrics reports §6 fields, read metrics and the cost basis', () => {
  const reads = {
    mainRuns: [{ reads: [{ path: 'a.md', seq: 1 }, { path: 'a.md', seq: 2 }, { path: 'b.md', seq: 3 }] }],
    childRuns: [{ startSeq: 10, reads: [{ path: 'a.md', seq: 11 }, { path: 'c.md', seq: 12 }, { path: 'a.md', seq: 13 }] }],
  };
  const metrics = runMetrics({ ledger: ledger(), relay: relay({ rejected: ['MODEL_CALL_BUDGET'] }), reads });
  assert.equal(metrics.modelCalls, 4);
  assert.equal(metrics.totalTokens, 1_100);
  assert.equal(metrics.cacheReadShare, 0.4);
  assert.equal(metrics.uncachedInput, 600);
  assert.equal(metrics.wallMs, 5_000);
  assert.equal(metrics.toolCalls, 3);
  assert.equal(metrics.relayRequests, 5);
  assert.equal(metrics.relayRejected, 1);
  assert.deepEqual(metrics.relayRejectedCodes, ['MODEL_CALL_BUDGET']);
  assert.equal(metrics.fileReadCalls.main, 3);
  assert.equal(metrics.rereads.main, 1);
  assert.equal(metrics.fileReadCalls.child, 3);
  assert.equal(metrics.rereads.child, 1);
  assert.equal(metrics.childRereadOfMain, 0.5);
  assert.deepEqual(metrics.childRereadOfMainDetail, { numerator: 1, denominator: 2 });
  assert.equal(metrics.usageComplete, true);
  assert.deepEqual(metrics.cost, { basis: 'tokens', value: 1_100, certain: true });
  const priced = runMetrics({ ledger: ledger({ cacheRead: 400 }), reads, prices: { input: 1, cacheRead: 0.1, output: 2 } });
  assert.equal(priced.cost.basis, 'price');
  assert.equal(priced.cost.value, (600 * 1 + 400 * 0.1 + 100 * 2) / 1e6);
});

test('readMetrics counts rerereads per run and compares child paths with earlier main reads', () => {
  const metrics = readMetrics({
    mainRuns: [{ reads: [{ path: 'x', seq: 1 }] }, { reads: [{ path: 'y', seq: 2 }] }],
    childRuns: [
      { startSeq: 3, reads: [{ path: 'x', seq: 4 }, { path: 'z', seq: 5 }] },
      { startSeq: 0, reads: [{ path: 'y', seq: 6 }] },
    ],
  });
  assert.equal(metrics.fileReadCalls.main, 2);
  assert.equal(metrics.rereads.main, 0);
  assert.equal(metrics.distinctPaths.child, 3);
  assert.equal(metrics.childRereadOfMain, 1 / 3, 'x was read before child 1; y was read after child 2 started');
  assert.deepEqual(metrics.childRereadOfMainDetail, { numerator: 1, denominator: 3 });
  assert.equal(metrics.rereadRates.main, 0);
  assert.equal(readMetrics().childRereadOfMain, null);
});

test('summarize reports pass rates per case/category and means only over eligible runs', () => {
  const reports = [
    report(),
    report({ key: 'case-a:r2', repeat: 2, passed: false, polluted: true, pollution: { reasons: [{ code: 'MODEL_MISMATCH' }] }, metrics: { ...report().metrics, totalTokens: 9_999 } }),
    report({ key: 'case-b:r1', caseId: 'case-b', category: 'data', metrics: { ...report().metrics, usageComplete: false, totalTokens: 50 } }),
  ];
  const summary = summarize(reports, { plan: ['case-a:r1', 'case-a:r2', 'case-b:r1'], mode: 'dry-run', model: 'm' });
  assert.equal(summary.matrixState, 'complete');
  assert.equal(summary.overall.runs, 3);
  assert.equal(summary.overall.passed, 2);
  assert.equal(summary.cases['case-a'].passRate, 0.5);
  assert.equal(summary.cases['case-a'].eligibleRuns, 1);
  assert.equal(summary.cases['case-a'].meanTokens, 1_100, 'polluted runs are excluded from means');
  assert.equal(summary.cases['case-b'].eligibleRuns, 0);
  assert.equal(summary.cases['case-b'].meanTokens, null);
  assert.equal(summary.cases['case-b'].meanCost, null);
  assert.equal(summary.cases['case-b'].meanCacheReadShare, null);
  assert.equal(summary.categories.literature.passRate, 0.5);
  assert.equal(summary.categories.data.passRate, 1);
  assert.equal(summary.categories.literature.cases, 1);
  assert.equal(summary.pollutedCells.length, 1);
  assert.equal(summary.pollutedCells[0].key, 'case-a:r2');
  assert.equal(summary.repeatedReadBaseline.main.fileReadCalls, 6);
  assert.equal(summary.repeatedReadBaseline.main.rereads, 3);
  assert.equal(summary.repeatedReadBaseline.main.rereadRate, 0.5);
  assert.equal(summary.repeatedReadBaseline.childRereadOfMain, null);
  assert.equal(summary.costBasis, 'tokens');
  assert.equal(summary.mode, 'dry-run');
});

test('summarize flags incomplete matrices and null means without eligible samples', () => {
  const summary = summarize([report()], { plan: ['case-a:r1', 'case-a:r2'] });
  assert.equal(summary.matrixState, 'incomplete');
  assert.deepEqual(summary.matrix.missing, ['case-a:r2']);
  const empty = summarize([], { plan: [] });
  assert.equal(empty.overall.passRate, null);
  assert.equal(empty.cases['missing-case'], undefined);
  assert.ok(Array.isArray(empty.notes) && empty.notes.length >= 2);
});

test('summarize uses price basis for meanCost and tracks human-pending cells', () => {
  const summary = summarize([
    report({ key: 'case-a:r1', humanPending: true, score: { passed: true, score: 1, violations: [], rules: [], checks: [{ id: 'H1', kind: 'human', status: 'pending', weight: 1, reasons: [] }] }, metrics: { ...report().metrics, cost: { basis: 'price', value: 0.5, certain: true } } }),
  ], { plan: ['case-a:r1'], prices: { input: 1, cacheRead: 0.1, output: 2 } });
  assert.equal(summary.costBasis, 'price');
  assert.equal(summary.cases['case-a'].meanCost, 0.5);
  assert.deepEqual(summary.humanPendingCells, ['case-a:r1']);
  assert.equal(summary.overall.humanPendingRuns, 1);
  assert.equal(summary.notes.length, 3);
});
