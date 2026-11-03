import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzePollution } from './pollution.mjs';
import { assertSummary, buildSide, compareGolden, readEvidence, renderText } from './compare.mjs';
import { GoldenError } from './errors.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// Synthetic evidence: the same shape scripts/golden/run.mjs writes
// (summary.json + runs/<case>/r<n>/report.json), so the comparison is tested
// against the real field layout without needing the paid baseline.
// ---------------------------------------------------------------------------

const baseMetrics = (overrides = {}) => ({
  usageComplete: true, measuredCalls: 3, unknownCalls: 0,
  inputTokens: 1_500, outputTokens: 100, totalTokens: 1_600,
  cacheRead: 400, cacheWrite: 0, uncachedInput: 1_100, cacheReadShare: 400 / 1_600,
  wallMs: 5_000, toolCalls: 4, relayRequests: 3, relayRejected: 0, providerFailures: 0,
  fileReadCalls: { main: 2, child: 0 }, rereads: { main: 1, child: 0 },
  childRereadOfMain: null, childRereadOfMainDetail: { numerator: 0, denominator: 0 },
  cost: { basis: 'tokens', value: 1_600, certain: true },
  ...overrides,
});

const makeReport = ({ caseId = 'case-a', repeat = 1, category = 'literature', title, passed = true, violationIds = [], humanPending = false, polluted = false, metrics = {}, status = 'completed' } = {}) => ({
  key: `${caseId}:r${repeat}`,
  caseId,
  category,
  title: title ?? `Case ${caseId}`,
  repeat,
  status,
  passed,
  humanPending,
  polluted,
  metrics: baseMetrics({ ...metrics, ...(polluted ? {} : {}) }),
  score: {
    passed, score: passed ? 1 : 0, passThreshold: 0.9, humanPending,
    violations: violationIds.map(id => ({ id, kind: 'file-contains', reasons: ['fixture violation'] })),
    rules: [], checks: [], counts: {},
  },
  pollution: { polluted, reasons: polluted ? [{ code: 'MODEL_MISMATCH', call: 1, detail: 'fixture' }] : [], excused: [], counts: {} },
});

/** Build the summary.json shape summarize() emits for a set of reports. */
function summarizeFor(reports, overrides = {}) {
  const cells = reports.map(report => ({
    key: report.key, caseId: report.caseId, repeat: report.repeat, status: report.status,
    passed: report.passed, score: report.score.score, humanPending: report.humanPending,
    polluted: report.polluted, usageComplete: report.metrics.usageComplete,
    totalTokens: report.metrics.totalTokens, cost: report.metrics.cost.value,
    wallMs: report.metrics.wallMs, cacheReadShare: report.metrics.cacheReadShare,
    violations: report.score.violations.length,
  }));
  const cases = {};
  for (const report of reports) {
    const entry = (cases[report.caseId] ??= {
      caseId: report.caseId, category: report.category, title: report.title,
      runs: 0, passed: 0, humanPendingRuns: 0, eligibleRuns: 0,
      meanTokens: null, meanCost: null, meanWallMs: null, meanCacheReadShare: null,
    });
    entry.runs++;
    if (report.passed) entry.passed++;
    if (report.humanPending) entry.humanPendingRuns++;
    if (report.metrics.usageComplete && !report.polluted) entry.eligibleRuns++;
  }
  for (const entry of Object.values(cases)) entry.passRate = entry.runs ? entry.passed / entry.runs : null;
  const overall = {
    cases: Object.keys(cases).length,
    runs: cells.length,
    passed: cells.filter(cell => cell.passed).length,
    humanPendingRuns: cells.filter(cell => cell.humanPending).length,
  };
  overall.passRate = overall.runs ? overall.passed / overall.runs : null;
  return {
    schemaVersion: 1,
    mode: 'dry-run',
    model: 'fixture-model',
    costBasis: 'tokens',
    plan: cells.map(cell => cell.key),
    stop: null,
    matrix: { complete: true, valid: true, missing: [], duplicated: [], unexpected: [], mixedPolicy: [] },
    matrixState: 'complete',
    overall,
    cases,
    cells,
    pollutedCells: cells.filter(cell => cell.polluted).map(cell => ({ key: cell.key, caseId: cell.caseId, repeat: cell.repeat, reasons: [] })),
    humanPendingCells: cells.filter(cell => cell.humanPending).map(cell => cell.key),
    ...overrides,
  };
}

function evidence(directory, reports, summaryOverrides = {}) {
  return {
    directory,
    summary: summarizeFor(reports, summaryOverrides),
    reports: new Map(reports.map(report => [report.key, report])),
  };
}

const threeRuns = (overrides = {}, caseId = 'case-a') => [1, 2, 3].map(repeat => makeReport({ caseId, repeat, ...overrides }));

// ---------------------------------------------------------------------------
// Gate behaviour.
// ---------------------------------------------------------------------------

test('an identical candidate passes the gate with zero deltas and no flips', () => {
  const baseline = evidence('/runs/baseline', [...threeRuns({}), ...threeRuns({ caseId: 'case-b', category: 'data' }, 'case-b')]);
  const candidate = evidence('/runs/candidate', [...threeRuns({}), ...threeRuns({ caseId: 'case-b', category: 'data' }, 'case-b')]);
  const report = compareGolden(baseline, candidate);
  assert.equal(report.gate.status, 'passed');
  assert.equal(report.gate.passed, true);
  assert.equal(report.gate.conclusive, true);
  assert.deepEqual(report.gate.triggered, []);
  assert.equal(report.flips.passedToFailed.length, 0);
  assert.equal(report.flips.failedToPassed.length, 0);
  assert.equal(report.overall.delta.passed, 0);
  assert.equal(report.overall.delta.meanCostPct, 0);
  assert.equal(report.completeness.conclusive, true);
  assert.equal(buildSide(candidate).overall.eligibleRuns, 6);
});

test('a passRate drop fails the gate and lists PASSED→FAILED flips per cell key', () => {
  const baseline = evidence('/runs/baseline', threeRuns({ passed: true }));
  const candidate = evidence('/runs/candidate', threeRuns({ passed: false }));
  const report = compareGolden(baseline, candidate);
  assert.equal(report.gate.status, 'failed');
  assert.equal(report.gate.conclusive, true);
  assert.ok(report.gate.triggered.includes('passRateNotBelow'));
  assert.equal(report.flips.passedToFailed.length, 3);
  assert.deepEqual(report.flips.passedToFailed.map(flip => flip.key), ['case-a:r1', 'case-a:r2', 'case-a:r3']);
  assert.equal(report.cases['case-a'].verdict, 'regressed');
  assert.equal(report.cases['case-a'].passRateNotBelow, false);
  assert.equal(report.cases['case-a'].baseline.passed, 3);
  assert.equal(report.cases['case-a'].candidate.passed, 0);
  assert.match(renderText(report), /## Gate: FAIL/u);
});

test('FAILED→PASSED flips keep the gate passing and are reported per case', () => {
  const baseline = evidence('/runs/baseline', threeRuns({ passed: false }));
  const candidate = evidence('/runs/candidate', threeRuns({ passed: true }));
  const report = compareGolden(baseline, candidate);
  assert.equal(report.gate.status, 'passed');
  assert.equal(report.flips.failedToPassed.length, 3);
  assert.equal(report.flips.byCase['case-a'].failedToPassed, 3);
  assert.equal(report.cases['case-a'].verdict, 'improved');
  assert.equal(report.cases['case-a'].delta.passed, 3);
});

test('new rule violations fail the gate with added/removed instances by case', () => {
  const baseline = evidence('/runs/baseline', [
    makeReport({ repeat: 1, violationIds: ['R1'] }),
    makeReport({ repeat: 2 }),
    makeReport({ repeat: 3 }),
  ]);
  const candidate = evidence('/runs/candidate', [
    makeReport({ repeat: 1, violationIds: ['R1', 'R2'] }),
    makeReport({ repeat: 2, violationIds: ['R2'] }),
    makeReport({ repeat: 3 }),
  ]);
  const report = compareGolden(baseline, candidate);
  assert.equal(report.gate.status, 'failed');
  assert.ok(report.gate.triggered.includes('noNewRuleViolations'));
  assert.equal(report.violations.added.length, 2);
  assert.deepEqual(report.violations.added.map(entry => `${entry.key}:${entry.ruleId}`).sort(), ['case-a:r1:R2', 'case-a:r2:R2']);
  assert.equal(report.violations.removed.length, 0);
  assert.deepEqual(report.violations.caseRulesAdded, [{ caseId: 'case-a', ruleId: 'R2' }]);
  assert.equal(report.violations.candidateCount, 3);
});

test('cost and wall regressions within 10% pass; larger regressions fail with ratios', () => {
  const baseline = evidence('/runs/baseline', threeRuns({ metrics: { totalTokens: 1_000, cost: { basis: 'tokens', value: 1_000, certain: true }, wallMs: 10_000 } }));
  const within = evidence('/runs/candidate', threeRuns({ metrics: { totalTokens: 1_050, cost: { basis: 'tokens', value: 1_050, certain: true }, wallMs: 11_000 } }));
  const withinReport = compareGolden(baseline, within);
  assert.equal(withinReport.gate.status, 'passed', withinReport.gate.summary);
  const costCriterion = withinReport.gate.criteria.find(entry => entry.id === 'costRegression');
  assert.equal(costCriterion.status, 'passed');
  assert.equal(costCriterion.detail.ratio, 1.05);

  const over = evidence('/runs/candidate', threeRuns({ metrics: { totalTokens: 1_200, cost: { basis: 'tokens', value: 1_240, certain: true }, wallMs: 12_500 } }));
  const overReport = compareGolden(baseline, over);
  assert.equal(overReport.gate.status, 'failed');
  assert.deepEqual(overReport.gate.triggered.sort(), ['costRegression', 'wallRegression']);
  assert.equal(overReport.gate.criteria.find(entry => entry.id === 'wallRegression').detail.deltaPct, 25);
  assert.equal(overReport.means.delta.meanCostPct, 24);
});

test('a zero or null baseline mean makes the criterion undetermined, never a pass', () => {
  const zero = evidence('/runs/baseline', threeRuns({ metrics: { totalTokens: 0, cost: { basis: 'tokens', value: 0, certain: true } } }));
  const normal = evidence('/runs/candidate', threeRuns({}));
  const zeroReport = compareGolden(zero, normal);
  assert.equal(zeroReport.gate.status, 'undetermined');
  assert.equal(zeroReport.gate.passed, false);
  assert.ok(zeroReport.gate.undetermined.includes('costRegression'));
  assert.match(zeroReport.gate.criteria.find(entry => entry.id === 'costRegression').detail.reason, /baseline mean is 0/u);

  const noSamples = evidence('/runs/baseline', threeRuns({ metrics: { usageComplete: false } }));
  const nullReport = compareGolden(noSamples, normal);
  assert.equal(nullReport.gate.status, 'inconclusive');
  assert.ok(nullReport.completeness.reasons.some(reason => reason.code === 'USAGE_INCOMPLETE_CELLS'));
});

// ---------------------------------------------------------------------------
// Data completeness: anything incomplete must be an explicit non-conclusion.
// ---------------------------------------------------------------------------

test('an incomplete candidate matrix makes the comparison inconclusive', () => {
  const baseline = evidence('/runs/baseline', threeRuns({}));
  const partialReports = [makeReport({ repeat: 1 }), makeReport({ repeat: 2 })];
  const candidate = evidence('/runs/candidate', partialReports, {
    matrixState: 'incomplete',
    matrix: { complete: false, valid: true, missing: ['case-a:r3'], duplicated: [], unexpected: [] },
  });
  const report = compareGolden(baseline, candidate);
  assert.equal(report.completeness.conclusive, false);
  assert.equal(report.gate.status, 'inconclusive');
  assert.equal(report.gate.passed, false);
  assert.ok(report.gate.summary.includes('cannot be used as a stage-1 gate'));
  assert.deepEqual(report.gate.blockedBy, report.completeness.reasons.map(reason => reason.code));
  assert.ok(report.gate.blockedBy.includes('CANDIDATE_MATRIX_INCOMPLETE'));
  const codes = report.completeness.reasons.map(reason => reason.code);
  assert.ok(codes.includes('CANDIDATE_MATRIX_INCOMPLETE'));
  assert.ok(codes.includes('PLAN_MISMATCH'));
  assert.ok(codes.includes('CELL_SET_MISMATCH'));
  assert.match(renderText(report), /cannot be used as a stage-1 gate conclusion/u);
});

test('polluted, human-pending and usage-incomplete cells block a gate conclusion', () => {
  const baseline = evidence('/runs/baseline', threeRuns({}));
  const polluted = evidence('/runs/candidate', [
    makeReport({ repeat: 1 }), makeReport({ repeat: 2, polluted: true }), makeReport({ repeat: 3 }),
  ]);
  const pollutedReport = compareGolden(baseline, polluted);
  assert.equal(pollutedReport.gate.status, 'inconclusive');
  assert.ok(pollutedReport.completeness.reasons.some(reason => reason.code === 'POLLUTED_CELLS'));
  assert.equal(buildSide(polluted).overall.eligibleRuns, 2, 'polluted cells are excluded from means');

  const pending = evidence('/runs/candidate', [
    makeReport({ repeat: 1 }), makeReport({ repeat: 2, humanPending: true }), makeReport({ repeat: 3 }),
  ]);
  assert.ok(compareGolden(baseline, pending).completeness.reasons.some(reason => reason.code === 'HUMAN_PENDING_CELLS'));
  const incompleteUsage = evidence('/runs/candidate', [
    makeReport({ repeat: 1 }), makeReport({ repeat: 2, metrics: { usageComplete: false } }), makeReport({ repeat: 3 }),
  ]);
  assert.ok(compareGolden(baseline, incompleteUsage).completeness.reasons.some(reason => reason.code === 'USAGE_INCOMPLETE_CELLS'));
});

test('missing reports, plan mismatch and cost-basis mismatch are explicit non-conclusions', () => {
  const baseline = evidence('/runs/baseline', threeRuns({}));
  const reports = threeRuns({});
  const missingReports = {
    directory: '/runs/candidate',
    summary: summarizeFor(reports),
    reports: new Map([...reports].slice(0, 2).map(report => [report.key, report])),
  };
  const missingReport = compareGolden(baseline, missingReports);
  assert.ok(missingReport.completeness.reasons.some(reason => reason.code === 'REPORTS_MISSING'));
  assert.ok(missingReport.completeness.reasons.some(reason => reason.code === 'VIOLATIONS_UNKNOWN'));
  assert.equal(missingReport.violations.comparable, false);
  assert.equal(missingReport.gate.criteria.find(entry => entry.id === 'noNewRuleViolations').status, 'undetermined');

  const planMismatch = evidence('/runs/candidate', [...threeRuns({}), makeReport({ caseId: 'case-c', repeat: 1 })]);
  const mismatchReport = compareGolden(baseline, planMismatch);
  assert.ok(mismatchReport.completeness.reasons.some(reason => reason.code === 'PLAN_MISMATCH'));

  const priceBasis = evidence('/runs/candidate', threeRuns({}));
  priceBasis.summary.costBasis = 'price';
  const basisReport = compareGolden(baseline, priceBasis);
  assert.ok(basisReport.completeness.reasons.some(reason => reason.code === 'COST_BASIS_MISMATCH'));
  assert.equal(basisReport.gate.criteria.find(entry => entry.id === 'costRegression').status, 'undetermined');
});

// ---------------------------------------------------------------------------
// Input errors: malformed or partial evidence must throw GoldenError.
// ---------------------------------------------------------------------------

test('malformed summaries and partial run directories throw GoldenError', () => {
  assert.throws(() => assertSummary(null, 'x'), error => error instanceof GoldenError && error.code === 'COMPARE_FORMAT');
  assert.throws(() => assertSummary({ cells: [], cases: {}, overall: {} }, 'x'), /summary\.plan/u);
  assert.throws(() => assertSummary({ plan: ['k'], cells: 'nope', cases: {}, overall: {} }, 'x'), /summary\.cells/u);
  assert.throws(() => assertSummary({ plan: ['k'], cells: [{ key: 'k', caseId: 'c', repeat: 0 }], cases: {}, overall: {} }, 'x'), /repeat/u);
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-golden-compare-'));
  try {
    assert.throws(() => readEvidence(path.join(root, 'missing')), /does not exist/u);
    const partial = path.join(root, 'partial');
    mkdirSync(partial, { recursive: true });
    writeFileSync(path.join(partial, 'progress.json'), '{"state":"running"}');
    assert.throws(() => readEvidence(partial), error => error instanceof GoldenError && error.code === 'COMPARE_INPUT' && /progress\.json exists/u.test(error.message));
    const empty = path.join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    assert.throws(() => readEvidence(empty), /no summary\.json/u);
    const broken = path.join(root, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, 'summary.json'), '{not json');
    assert.throws(() => readEvidence(broken), error => error instanceof GoldenError && error.code === 'COMPARE_FORMAT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI end-to-end on synthetic completed runs (no model calls).
// ---------------------------------------------------------------------------

function writeRun(root, reports, summaryOverrides = {}) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'summary.json'), `${JSON.stringify(summarizeFor(reports, summaryOverrides), null, 2)}\n`, 'utf8');
  for (const report of reports) {
    const directory = path.join(root, 'runs', report.caseId, `r${report.repeat}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return root;
}

const runCompare = args => spawnSync(process.execPath, [path.join(repoRoot, 'scripts/golden/compare.mjs'), ...args], { cwd: repoRoot, encoding: 'utf8' });

test('compare.mjs CLI writes JSON and exits per --fail-on-gate', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-golden-compare-cli-'));
  try {
    const baseline = writeRun(path.join(root, 'baseline'), threeRuns({}));
    const passing = writeRun(path.join(root, 'candidate-pass'), threeRuns({}));
    const outFile = path.join(root, 'comparison.json');
    const pass = runCompare(['--baseline', baseline, '--candidate', passing, '--out', outFile, '--fail-on-gate']);
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /## Gate: PASS/u);
    assert.match(pass.stdout, /JSON report:/u);
    const parsed = JSON.parse(readFileSync(outFile, 'utf8'));
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.gate.status, 'passed');
    assert.ok(Array.isArray(parsed.cases['case-a'] ? [parsed.cases['case-a']] : []));
    assert.equal(parsed.overall.baseline.passed, 3);

    const regressed = writeRun(path.join(root, 'candidate-fail'), threeRuns({ passed: false }));
    const fail = runCompare(['--baseline', baseline, '--candidate', regressed, '--out', path.join(root, 'fail.json'), '--fail-on-gate']);
    assert.equal(fail.status, 2, fail.stderr);
    assert.match(fail.stdout, /## Gate: FAIL/u);
    const failParsed = JSON.parse(readFileSync(path.join(root, 'fail.json'), 'utf8'));
    assert.deepEqual(failParsed.flips.passedToFailed.length, 3);
    assert.ok(failParsed.gate.triggered.includes('passRateNotBelow'));

    // Without --fail-on-gate a failed comparison still exits 0 (report produced).
    const noGate = runCompare(['--baseline', baseline, '--candidate', regressed, '--out', path.join(root, 'nogate.json'), '--json']);
    assert.equal(noGate.status, 0, noGate.stderr);
    const json = JSON.parse(noGate.stdout);
    assert.equal(json.gate.status, 'failed');
    // Inconclusive counts as "not passed" for --fail-on-gate.
    const pending = writeRun(path.join(root, 'candidate-pending'), [
      makeReport({ repeat: 1 }), makeReport({ repeat: 2, humanPending: true }), makeReport({ repeat: 3 }),
    ]);
    const inconclusive = runCompare(['--baseline', baseline, '--candidate', pending, '--out', path.join(root, 'pending.json'), '--fail-on-gate']);
    assert.equal(inconclusive.status, 2, inconclusive.stderr);
    const pendingReport = JSON.parse(readFileSync(path.join(root, 'pending.json'), 'utf8'));
    assert.equal(pendingReport.gate.status, 'inconclusive');
    assert.ok(pendingReport.gate.blockedBy.includes('HUMAN_PENDING_CELLS'));
    // --help exits 0 without inputs.
    const help = runCompare(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--baseline/u);
    // A missing --candidate is a CLI error.
    assert.equal(runCompare(['--baseline', baseline]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readEvidence accepts either the run directory or its summary.json', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-golden-compare-read-'));
  try {
    const directory = writeRun(path.join(root, 'run'), threeRuns({}));
    const fromDirectory = readEvidence(directory);
    const fromFile = readEvidence(path.join(directory, 'summary.json'));
    assert.equal(fromDirectory.summary.plan.length, 3);
    assert.equal(fromFile.summary.plan.length, 3);
    assert.equal(fromDirectory.reports.size, 3);
    assert.equal(fromFile.directory, fromDirectory.directory);
    const report = compareGolden(fromDirectory, fromFile);
    assert.equal(report.gate.status, 'passed');
    assert.equal(report.flips.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pollution analysis and comparison agree on which cells are excluded from means', () => {
  const pollution = analyzePollution({ requests: [{ index: 1, model: 'a' }], responses: [{ index: 1, text: 'data: {"model":"b","usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n' }], calls: [{ index: 1, httpStatus: 200, metering: 'measured', usage: {} }] });
  assert.equal(pollution.polluted, true);
  const baseline = evidence('/runs/baseline', threeRuns({}));
  const candidate = evidence('/runs/candidate', [
    makeReport({ repeat: 1, polluted: true }), makeReport({ repeat: 2 }), makeReport({ repeat: 3 }),
  ]);
  const side = buildSide(candidate);
  assert.deepEqual(side.pollutedCells, ['case-a:r1']);
  assert.equal(side.overall.eligibleRuns, 2);
  assert.ok(Math.abs(side.overall.meanCost - 1_600) < 1e-9);
  const report = compareGolden(baseline, candidate);
  assert.equal(report.gate.status, 'inconclusive');
});
