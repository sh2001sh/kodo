// Baseline vs candidate comparison for the Kodo golden evaluations
// (docs/kodo-golden-eval-design-20261103.md §8 stage-1 gate).
//
//   node scripts/golden/compare.mjs --baseline .kodo/golden/baseline-20261103 \
//     --candidate .kodo/golden/<rerun> [--out comparison.json] [--json] [--fail-on-gate]
//
// Reads two completed golden runs (summary.json + runs/<case>/r<N>/report.json),
// computes per-case pass-rate/mean deltas, flips, rule-violation additions and
// applies the stage-1 gate:
//   (a) passRate not below the baseline (3 runs per case; equal is allowed),
//   (b) no new rule violations (new cell+rule pairs),
//   (c) mean cost and mean wallMs regression <= 10%.
// A baseline mean of 0/null (or a blocked cost basis) makes that criterion
// undetermined; a matrix that is incomplete, stopped, polluted, missing reports
// or has pending human verdicts makes the whole comparison inconclusive — it is
// reported as "cannot be used as a gate", never as a pass.
//
// The analysis (`buildSide`, `compareGolden`, `renderText`) is pure; only
// `readEvidence` and `main` touch the filesystem/CLI.

import console from 'node:console';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GoldenError } from './errors.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const COMPARE_SCHEMA_VERSION = 1;
/** Stage-1 regression ceiling for mean cost and mean wall time (§8). */
export const REGRESSION_LIMIT_PCT = 10;
const LIMIT_RATIO = 1 + REGRESSION_LIMIT_PCT / 100;
const EPSILON = 1e-9;
const MAX_LISTED = 25;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = value => typeof value === 'string' && value.length > 0;
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const array = value => (Array.isArray(value) ? value : []);
const listOf = (values, limit = MAX_LISTED) => (values.length > limit ? [...values.slice(0, limit), `…+${values.length - limit} more`] : values);

export const stamp = () => {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
};

// ---------------------------------------------------------------------------
// Input validation and loading.
// ---------------------------------------------------------------------------

function readJson(file, label) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { throw new GoldenError('COMPARE_INPUT', `cannot read ${label}: ${error.message}`); }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try { return JSON.parse(text); }
  catch (error) { throw new GoldenError('COMPARE_FORMAT', `${label} is not valid JSON: ${error.message}`); }
}

/** Validate the summary.json shape this tool compares; throws GoldenError on bad input. */
export function assertSummary(summary, label) {
  if (!isRecord(summary)) throw new GoldenError('COMPARE_FORMAT', `${label}: summary.json must be a JSON object`);
  if (!Array.isArray(summary.plan) || !summary.plan.length || summary.plan.some(key => !isNonEmptyString(key))) {
    throw new GoldenError('COMPARE_FORMAT', `${label}: summary.plan must be a non-empty array of cell keys`);
  }
  if (!Array.isArray(summary.cells)) throw new GoldenError('COMPARE_FORMAT', `${label}: summary.cells must be an array`);
  for (const [index, cell] of summary.cells.entries()) {
    if (!isRecord(cell)) throw new GoldenError('COMPARE_FORMAT', `${label}: summary.cells[${index}] must be an object`);
    if (!isNonEmptyString(cell.key)) throw new GoldenError('COMPARE_FORMAT', `${label}: summary.cells[${index}].key is missing`);
    if (!isNonEmptyString(cell.caseId)) throw new GoldenError('COMPARE_FORMAT', `${label}: summary.cells[${index}].caseId is missing`);
    if (!Number.isSafeInteger(cell.repeat) || cell.repeat < 1) throw new GoldenError('COMPARE_FORMAT', `${label}: summary.cells[${index}].repeat must be a positive integer`);
  }
  if (!isRecord(summary.cases)) throw new GoldenError('COMPARE_FORMAT', `${label}: summary.cases must be an object`);
  if (!isRecord(summary.overall)) throw new GoldenError('COMPARE_FORMAT', `${label}: summary.overall must be an object`);
  return summary;
}

/**
 * Restrict a summary to one case set (stage-1 gate on an established subset when
 * a case's baseline is explicitly not established, e.g. coding-01 here).
 * Throws when a requested case is absent so a typo cannot silently shrink scope.
 */
export function scopeSummary(summary, cases) {
  if (!Array.isArray(cases) || !cases.length || cases.some(entry => !isNonEmptyString(entry))) {
    throw new GoldenError('COMPARE_SCOPE', '--cases needs a non-empty comma-separated list of case ids');
  }
  const known = new Set(Object.keys(summary.cases));
  const unknown = cases.filter(caseId => !known.has(caseId));
  if (unknown.length) throw new GoldenError('COMPARE_SCOPE', `--cases names cases that are not in the run: ${unknown.join(', ')}; available: ${[...known].sort().join(', ')}`);
  const keep = new Set(cases);
  const plan = summary.plan.filter(key => keep.has(key.split(':')[0]));
  const matrix = isRecord(summary.matrix)
    ? {
      ...summary.matrix,
      missing: array(summary.matrix.missing).filter(key => keep.has(String(key).split(':')[0])),
      duplicated: array(summary.matrix.duplicated).filter(key => keep.has(String(key).split(':')[0])),
      unexpected: array(summary.matrix.unexpected).filter(key => keep.has(String(key).split(':')[0])),
    }
    : summary.matrix;
  const cells = summary.cells.filter(cell => keep.has(cell.caseId));
  if (cells.length !== plan.length) {
    throw new GoldenError('COMPARE_SCOPE', `scoped run for cases ${cases.join(',')} has ${cells.length} cells but ${plan.length} planned cells; rerun the same matrix for the scope`);
  }
  // A stop recorded for an out-of-scope case (for example the coding case whose
  // baseline is not established) must not poison the scoped comparison.
  const stopInScope = summary.stop && keep.has(String(summary.stop.at ?? '').split(':')[0]) ? summary.stop : null;
  const scopedStop = summary.stop && !stopInScope ? summary.stop : null;
  return {
    ...summary,
    ...(scopedStop ? { stop: null, ignoredStop: scopedStop } : {}),
    plan,
    cells,
    cases: Object.fromEntries(Object.entries(summary.cases).filter(([caseId]) => keep.has(caseId))),
    categories: Object.fromEntries(Object.entries(summary.categories ?? {}).filter(([, bucket]) => cases.some(caseId => summary.cases[caseId]?.category === bucket.category))),
    matrix,
    scopedCases: cases,
  };
}

/**
 * Load one side from a completed run directory (or directly from its summary.json).
 * A run with progress.json but no summary.json is refused: partial matrices are
 * never compared silently.
 */
export function readEvidence(target) {
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) throw new GoldenError('COMPARE_INPUT', `path does not exist: ${resolved}`);
  const isDirectory = statSync(resolved).isDirectory();
  const directory = isDirectory ? resolved : path.dirname(resolved);
  const summaryFile = isDirectory ? path.join(directory, 'summary.json') : resolved;
  if (!existsSync(summaryFile)) {
    const partial = existsSync(path.join(directory, 'progress.json'));
    throw new GoldenError('COMPARE_INPUT', partial
      ? `${directory}: the matrix is not finished (summary.json is missing but progress.json exists); wait for the run to complete — a partial matrix cannot be compared`
      : `${directory}: no summary.json; point --baseline/--candidate at a completed golden run directory`);
  }
  const summary = assertSummary(readJson(summaryFile, `${directory}/summary.json`), directory);
  const reports = new Map();
  for (const cell of summary.cells) {
    const reportFile = path.join(directory, 'runs', cell.caseId, `r${cell.repeat}`, 'report.json');
    if (!existsSync(reportFile)) continue;
    reports.set(cell.key, readJson(reportFile, `${directory}/runs/${cell.caseId}/r${cell.repeat}/report.json`));
  }
  return { directory, summaryFile, summary, reports };
}

// ---------------------------------------------------------------------------
// Per-side aggregation (pure).
// ---------------------------------------------------------------------------

/** A cell's normalized evidence: summary row first, report.json details win when present. */
function buildCell(raw, report) {
  const metrics = isRecord(report?.metrics) ? report.metrics : null;
  const violations = Array.isArray(report?.score?.violations)
    ? report.score.violations.map(violation => ({ ruleId: String(violation.id ?? '?'), kind: String(violation.kind ?? '?') }))
    : null;
  return {
    key: raw.key,
    caseId: raw.caseId,
    category: typeof report?.category === 'string' ? report.category : null,
    title: typeof report?.title === 'string' ? report.title : null,
    repeat: raw.repeat,
    passed: Boolean(report?.passed ?? raw.passed),
    status: report?.status ?? raw.status ?? null,
    humanPending: Boolean(report?.humanPending ?? raw.humanPending),
    polluted: Boolean(report?.polluted ?? raw.polluted),
    usageComplete: Boolean(metrics?.usageComplete ?? raw.usageComplete),
    unknownCalls: isFiniteNumber(metrics?.unknownCalls) ? metrics.unknownCalls : null,
    agentCancelledUnknown: isFiniteNumber(metrics?.agentCancelledUnknown) ? metrics.agentCancelledUnknown : null,
    providerFailures: isFiniteNumber(metrics?.providerFailures) ? metrics.providerFailures : null,
    violations,
    violationsKnown: violations !== null,
    totalTokens: metrics?.totalTokens ?? (isFiniteNumber(raw.totalTokens) ? raw.totalTokens : null),
    cost: metrics?.cost?.value ?? (isFiniteNumber(raw.cost) ? raw.cost : null),
    wallMs: metrics?.wallMs ?? (isFiniteNumber(raw.wallMs) ? raw.wallMs : null),
    cacheReadShare: isFiniteNumber(metrics?.cacheReadShare) ? metrics.cacheReadShare : (isFiniteNumber(raw.cacheReadShare) ? raw.cacheReadShare : null),
    fileReadCalls: isRecord(metrics?.fileReadCalls) ? metrics.fileReadCalls : null,
    rereads: isRecord(metrics?.rereads) ? metrics.rereads : null,
    childRereadOfMain: isFiniteNumber(metrics?.childRereadOfMain) ? metrics.childRereadOfMain : null,
    childRereadDetail: isRecord(metrics?.childRereadOfMainDetail) ? metrics.childRereadOfMainDetail : null,
  };
}

const newAggregate = () => ({
  runs: 0, passed: 0, humanPendingRuns: 0, violationCells: 0, eligibleRuns: 0,
  tokensSum: 0, costSum: 0, wallSum: 0, cacheShareSum: 0, cacheShareSamples: 0,
  mainReadCalls: 0, mainRereads: 0, childReadCalls: 0, childRereads: 0, childPairNumerator: 0, childPairDenominator: 0,
});

function addToAggregate(aggregate, cell) {
  aggregate.runs++;
  if (cell.passed) aggregate.passed++;
  if (cell.humanPending) aggregate.humanPendingRuns++;
  if (cell.violationsKnown && cell.violations.length) aggregate.violationCells++;
  const eligible = cell.usageComplete && !cell.polluted;
  if (!eligible) return;
  aggregate.eligibleRuns++;
  if (isFiniteNumber(cell.totalTokens)) aggregate.tokensSum += cell.totalTokens;
  if (isFiniteNumber(cell.cost)) aggregate.costSum += cell.cost;
  if (isFiniteNumber(cell.wallMs)) aggregate.wallSum += cell.wallMs;
  if (isFiniteNumber(cell.cacheReadShare)) { aggregate.cacheShareSum += cell.cacheReadShare; aggregate.cacheShareSamples++; }
  aggregate.mainReadCalls += cell.fileReadCalls?.main ?? 0;
  aggregate.mainRereads += cell.rereads?.main ?? 0;
  aggregate.childReadCalls += cell.fileReadCalls?.child ?? 0;
  aggregate.childRereads += cell.rereads?.child ?? 0;
  aggregate.childPairNumerator += cell.childRereadDetail?.numerator ?? 0;
  aggregate.childPairDenominator += cell.childRereadDetail?.denominator ?? 0;
}

const ratioOrNull = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);

function finalizeAggregate(aggregate) {
  const eligible = aggregate.eligibleRuns;
  return {
    runs: aggregate.runs,
    passed: aggregate.passed,
    passRate: aggregate.runs ? aggregate.passed / aggregate.runs : null,
    humanPendingRuns: aggregate.humanPendingRuns,
    violationCells: aggregate.violationCells,
    eligibleRuns: eligible,
    meanTokens: eligible ? aggregate.tokensSum / eligible : null,
    meanCost: eligible ? aggregate.costSum / eligible : null,
    meanWallMs: eligible ? aggregate.wallSum / eligible : null,
    meanCacheReadShare: aggregate.cacheShareSamples ? aggregate.cacheShareSum / aggregate.cacheShareSamples : null,
    mainFileReadCalls: aggregate.mainReadCalls,
    mainRereads: aggregate.mainRereads,
    mainRereadRate: ratioOrNull(aggregate.mainRereads, aggregate.mainReadCalls),
    childFileReadCalls: aggregate.childReadCalls,
    childRereads: aggregate.childRereads,
    childRereadRate: ratioOrNull(aggregate.childRereads, aggregate.childReadCalls),
    childRereadOfMain: ratioOrNull(aggregate.childPairNumerator, aggregate.childPairDenominator),
    childRereadOfMainDetail: { numerator: aggregate.childPairNumerator, denominator: aggregate.childPairDenominator },
  };
}

/**
 * Aggregate one side: per-case and overall §6-style metrics. Means only include
 * cells with usageComplete && !polluted; `eligibleRuns` is the denominator.
 */
export function buildSide(evidence) {
  const { summary, reports } = evidence;
  assertSummary(summary, evidence.directory ?? 'summary');
  const cells = [];
  const missingReports = [];
  for (const raw of summary.cells) {
    const report = reports?.get(raw.key) ?? null;
    if (!report) missingReports.push(raw.key);
    cells.push(buildCell(raw, report));
  }
  const caseAggregates = new Map();
  const overall = newAggregate();
  for (const cell of cells) {
    addToAggregate(overall, cell);
    let aggregate = caseAggregates.get(cell.caseId);
    if (!aggregate) { aggregate = newAggregate(); caseAggregates.set(cell.caseId, aggregate); }
    addToAggregate(aggregate, cell);
  }
  const cases = {};
  for (const [caseId, aggregate] of [...caseAggregates.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const summaryCase = isRecord(summary.cases[caseId]) ? summary.cases[caseId] : {};
    const firstCell = cells.find(cell => cell.caseId === caseId);
    cases[caseId] = {
      caseId,
      category: summaryCase.category ?? firstCell?.category ?? 'unknown',
      title: summaryCase.title ?? firstCell?.title ?? caseId,
      ...finalizeAggregate(aggregate),
    };
  }
  const categories = {};
  for (const entry of Object.values(cases)) {
    const bucket = (categories[entry.category] ??= { category: entry.category, cases: 0, runs: 0, passed: 0 });
    bucket.cases++;
    bucket.runs += entry.runs;
    bucket.passed += entry.passed;
  }
  for (const bucket of Object.values(categories)) bucket.passRate = bucket.runs ? bucket.passed / bucket.runs : null;

  const violations = [];
  const unknownViolationCells = [];
  for (const cell of cells) {
    if (!cell.violationsKnown) { unknownViolationCells.push(cell.key); continue; }
    for (const violation of cell.violations) violations.push({ key: cell.key, caseId: cell.caseId, repeat: cell.repeat, ...violation });
  }
  return {
    directory: evidence.directory,
    summary,
    cells,
    missingReports,
    unknownViolationCells,
    cases,
    categories,
    overall: finalizeAggregate(overall),
    violations,
    pollutedCells: cells.filter(cell => cell.polluted).map(cell => cell.key),
    humanPendingCells: cells.filter(cell => cell.humanPending).map(cell => cell.key),
    usageIncompleteCells: cells.filter(cell => !cell.usageComplete).map(cell => cell.key),
  };
}

// ---------------------------------------------------------------------------
// Comparison (pure).
// ---------------------------------------------------------------------------

const percentChange = (baseline, candidate) => (isFiniteNumber(baseline) && isFiniteNumber(candidate) && baseline !== 0 ? (candidate - baseline) / baseline : null);
const round = (value, digits = 6) => (isFiniteNumber(value) ? Number(value.toFixed(digits)) : null);

function deltaOf(baseline, candidate) {
  return {
    passed: candidate.passed - baseline.passed,
    passRate: isFiniteNumber(baseline.passRate) && isFiniteNumber(candidate.passRate) ? candidate.passRate - baseline.passRate : null,
    meanTokensPct: round(percentChange(baseline.meanTokens, candidate.meanTokens) * 100),
    meanCostPct: round(percentChange(baseline.meanCost, candidate.meanCost) * 100),
    meanWallMsPct: round(percentChange(baseline.meanWallMs, candidate.meanWallMs) * 100),
    meanCacheReadSharePp: isFiniteNumber(baseline.meanCacheReadShare) && isFiniteNumber(candidate.meanCacheReadShare)
      ? round((candidate.meanCacheReadShare - baseline.meanCacheReadShare) * 100) : null,
    mainRereadRatePp: isFiniteNumber(baseline.mainRereadRate) && isFiniteNumber(candidate.mainRereadRate)
      ? round((candidate.mainRereadRate - baseline.mainRereadRate) * 100) : null,
    childRereadOfMainPp: isFiniteNumber(baseline.childRereadOfMain) && isFiniteNumber(candidate.childRereadOfMain)
      ? round((candidate.childRereadOfMain - baseline.childRereadOfMain) * 100) : null,
  };
}

/** Completeness: anything that makes the comparison a non-conclusion (§8). */
function assessCompleteness(baseline, candidate) {
  const reasons = [];
  const reason = (code, detail) => reasons.push({ code, detail });
  const matrixOf = side => {
    const matrix = isRecord(side.summary.matrix) ? side.summary.matrix : {};
    const state = typeof side.summary.matrixState === 'string' ? side.summary.matrixState : matrix.complete === true ? 'complete' : 'incomplete';
    return {
      state,
      complete: matrix.complete ?? state === 'complete',
      valid: matrix.valid ?? state !== 'invalid',
      missing: array(matrix.missing),
      duplicated: array(matrix.duplicated),
      unexpected: array(matrix.unexpected),
    };
  };
  const baselineMatrix = matrixOf(baseline);
  const candidateMatrix = matrixOf(candidate);
  for (const [label, matrix, side] of [['baseline', baselineMatrix, baseline], ['candidate', candidateMatrix, candidate]]) {
    if (matrix.state !== 'complete' || matrix.missing.length || matrix.duplicated.length || matrix.unexpected.length) {
      reason(`${label.toUpperCase()}_MATRIX_INCOMPLETE`, `matrixState=${matrix.state} missing=${JSON.stringify(listOf(matrix.missing))} duplicated=${JSON.stringify(listOf(matrix.duplicated))} unexpected=${JSON.stringify(listOf(matrix.unexpected))}`);
    }
    if (side.summary.stop) reason(`${label.toUpperCase()}_STOPPED`, `the matrix stopped: ${JSON.stringify(side.summary.stop)}`);
  }
  const planA = baseline.summary.plan;
  const planB = candidate.summary.plan;
  const planMismatch = JSON.stringify(planA) !== JSON.stringify(planB);
  if (planMismatch) reason('PLAN_MISMATCH', `baseline plan (${planA.length} cells) and candidate plan (${planB.length} cells) differ; rerun the same matrix configuration`);

  const keysOf = side => side.cells.map(cell => cell.key);
  const keysA = keysOf(baseline);
  const keysB = keysOf(candidate);
  const setA = new Set(keysA);
  const setB = new Set(keysB);
  const missingInCandidate = keysA.filter(key => !setB.has(key));
  const missingInBaseline = keysB.filter(key => !setA.has(key));
  if (missingInCandidate.length || missingInBaseline.length) {
    reason('CELL_SET_MISMATCH', `missing in candidate=${JSON.stringify(listOf(missingInCandidate))} missing in baseline=${JSON.stringify(listOf(missingInBaseline))}`);
  }
  const duplicatedA = keysA.filter((key, index) => keysA.indexOf(key) !== index);
  const duplicatedB = keysB.filter((key, index) => keysB.indexOf(key) !== index);
  if (duplicatedA.length || duplicatedB.length) reason('CELLS_DUPLICATED', `baseline=${JSON.stringify(listOf(duplicatedA))} candidate=${JSON.stringify(listOf(duplicatedB))}`);
  const planSet = new Set(planA);
  const unexpectedA = keysA.filter(key => !planSet.has(key));
  const unexpectedB = keysB.filter(key => !new Set(planB).has(key));
  if (unexpectedA.length || unexpectedB.length) reason('CELLS_UNEXPECTED', `baseline=${JSON.stringify(listOf(unexpectedA))} candidate=${JSON.stringify(listOf(unexpectedB))}`);
  if (baseline.cells.length !== baseline.summary.plan.length) reason('BASELINE_CELL_COUNT', `summary.cells has ${baseline.cells.length} rows but the plan has ${baseline.summary.plan.length} cells`);
  if (candidate.cells.length !== candidate.summary.plan.length) reason('CANDIDATE_CELL_COUNT', `summary.cells has ${candidate.cells.length} rows but the plan has ${candidate.summary.plan.length} cells`);

  const baseBasis = baseline.summary.costBasis ?? 'tokens';
  const candidateBasis = candidate.summary.costBasis ?? 'tokens';
  const costBasisComparable = baseBasis === candidateBasis;
  if (!costBasisComparable) reason('COST_BASIS_MISMATCH', `baseline basis=${baseBasis} vs candidate basis=${candidateBasis}; mean cost is not comparable`);

  const polluted = { baseline: baseline.pollutedCells, candidate: candidate.pollutedCells };
  if (polluted.baseline.length || polluted.candidate.length) {
    reason('POLLUTED_CELLS', `baseline=${JSON.stringify(listOf(polluted.baseline))} candidate=${JSON.stringify(listOf(polluted.candidate))}; polluted cells are excluded from means and their quality verdicts are not a cost baseline`);
  }
  const humanPending = { baseline: baseline.humanPendingCells, candidate: candidate.humanPendingCells };
  if (humanPending.baseline.length || humanPending.candidate.length) {
    reason('HUMAN_PENDING_CELLS', `baseline=${JSON.stringify(listOf(humanPending.baseline))} candidate=${JSON.stringify(listOf(humanPending.candidate))}; fill human.json and rescore before gating`);
  }
  // A cell whose only missing usage is a recorded provider failure attempt is
  // explained; it stays out of the cost means but does not block the gate.
  const explainedUsage = side => side.cells
    .filter(cell => {
      if (cell.usageComplete) return false;
      const excused = (cell.agentCancelledUnknown ?? 0) + (cell.providerFailures ?? 0);
      return excused > 0 && (cell.unknownCalls ?? 0) <= excused;
    })
    .map(cell => cell.key);
  const usageIncomplete = {
    baseline: baseline.usageIncompleteCells.filter(key => !explainedUsage(baseline).includes(key)),
    candidate: candidate.usageIncompleteCells.filter(key => !explainedUsage(candidate).includes(key)),
    explained: { baseline: explainedUsage(baseline), candidate: explainedUsage(candidate) },
  };
  if (usageIncomplete.baseline.length || usageIncomplete.candidate.length) {
    reason('USAGE_INCOMPLETE_CELLS', `baseline=${JSON.stringify(listOf(usageIncomplete.baseline))} candidate=${JSON.stringify(listOf(usageIncomplete.candidate))}; token/cost means have missing samples`);
  }
  const missingReports = { baseline: baseline.missingReports, candidate: candidate.missingReports };
  if (missingReports.baseline.length || missingReports.candidate.length) {
    reason('REPORTS_MISSING', `baseline=${JSON.stringify(listOf(missingReports.baseline))} candidate=${JSON.stringify(listOf(missingReports.candidate))}; per-run metrics/violations are incomplete`);
  }
  const unknownViolations = { baseline: baseline.unknownViolationCells, candidate: candidate.unknownViolationCells };
  if (unknownViolations.baseline.length || unknownViolations.candidate.length) {
    reason('VIOLATIONS_UNKNOWN', `baseline=${JSON.stringify(listOf(unknownViolations.baseline))} candidate=${JSON.stringify(listOf(unknownViolations.candidate))}; rule violations cannot be compared without report.json`);
  }
  return {
    conclusive: reasons.length === 0,
    reasons,
    matrix: { baseline: baselineMatrix, candidate: candidateMatrix },
    planMismatch,
    cells: { missingInCandidate, missingInBaseline, duplicated: { baseline: duplicatedA, candidate: duplicatedB }, unexpected: { baseline: unexpectedA, candidate: unexpectedB } },
    polluted,
    humanPending,
    usageIncomplete,
    missingReports,
    unknownViolations,
    costBasis: { baseline: baseBasis, candidate: candidateBasis, comparable: costBasisComparable },
  };
}

function compareViolations(baseline, candidate) {
  const pairKey = violation => `${violation.key}::${violation.ruleId}`;
  const baselinePairs = new Map(baseline.violations.map(violation => [pairKey(violation), violation]));
  const candidatePairs = new Map(candidate.violations.map(violation => [pairKey(violation), violation]));
  const added = [...candidatePairs.entries()].filter(([key]) => !baselinePairs.has(key)).map(([, violation]) => violation);
  const removed = [...baselinePairs.entries()].filter(([key]) => !candidatePairs.has(key)).map(([, violation]) => violation);
  const rulesOfCase = side => {
    const map = new Map();
    for (const violation of side.violations) {
      const rules = map.get(violation.caseId) ?? new Set();
      rules.add(violation.ruleId);
      map.set(violation.caseId, rules);
    }
    return map;
  };
  const baselineCaseRules = rulesOfCase(baseline);
  const candidateCaseRules = rulesOfCase(candidate);
  const caseRulesAdded = [];
  const caseRulesRemoved = [];
  for (const [caseId, rules] of candidateCaseRules) {
    for (const ruleId of rules) if (!baselineCaseRules.get(caseId)?.has(ruleId)) caseRulesAdded.push({ caseId, ruleId });
  }
  for (const [caseId, rules] of baselineCaseRules) {
    for (const ruleId of rules) if (!candidateCaseRules.get(caseId)?.has(ruleId)) caseRulesRemoved.push({ caseId, ruleId });
  }
  const byCase = {};
  for (const violation of added) {
    const entry = (byCase[violation.caseId] ??= { added: [], removed: [] });
    entry.added.push({ key: violation.key, ruleId: violation.ruleId, kind: violation.kind });
  }
  for (const violation of removed) {
    const entry = (byCase[violation.caseId] ??= { added: [], removed: [] });
    entry.removed.push({ key: violation.key, ruleId: violation.ruleId, kind: violation.kind });
  }
  return {
    comparable: baseline.unknownViolationCells.length === 0 && candidate.unknownViolationCells.length === 0,
    baselineCount: baseline.violations.length,
    candidateCount: candidate.violations.length,
    added,
    removed,
    addedByCase: Object.fromEntries(Object.entries(byCase).map(([caseId, entry]) => [caseId, entry.added]).filter(([, entry]) => entry.length)),
    removedByCase: Object.fromEntries(Object.entries(byCase).map(([caseId, entry]) => [caseId, entry.removed]).filter(([, entry]) => entry.length)),
    caseRulesAdded,
    caseRulesRemoved,
    byCase,
  };
}

function compareCaseSets(baseline, candidate) {
  const caseIds = [...new Set([...Object.keys(baseline.cases), ...Object.keys(candidate.cases)])].sort();
  const cases = {};
  for (const caseId of caseIds) {
    const base = baseline.cases[caseId] ?? null;
    const next = candidate.cases[caseId] ?? null;
    const basePassed = base?.passed ?? 0;
    const nextPassed = next?.passed ?? 0;
    const passedDelta = nextPassed - basePassed;
    const passRateNotBelow = Boolean(base && next) && nextPassed >= basePassed;
    const verdict = !base || !next ? 'not-comparable' : passedDelta > 0 ? 'improved' : passedDelta < 0 ? 'regressed' : 'unchanged';
    cases[caseId] = {
      caseId,
      category: next?.category ?? base?.category ?? 'unknown',
      title: next?.title ?? base?.title ?? caseId,
      baseline: base,
      candidate: next,
      delta: base && next ? { passed: passedDelta, passRate: (next.passRate ?? 0) - (base.passRate ?? 0), ...deltaOf(base, next) } : null,
      passRateNotBelow,
      verdict,
    };
  }
  return cases;
}

function compareFlips(baseline, candidate) {
  const baseByKey = new Map(baseline.cells.map(cell => [cell.key, cell]));
  const candidateByKey = new Map(candidate.cells.map(cell => [cell.key, cell]));
  const flips = { passedToFailed: [], failedToPassed: [], unchangedPassed: 0, unchangedFailed: 0 };
  for (const [key, base] of baseByKey) {
    const next = candidateByKey.get(key);
    if (!next) continue;
    if (base.passed && !next.passed) flips.passedToFailed.push({ key, caseId: base.caseId, repeat: base.repeat });
    else if (!base.passed && next.passed) flips.failedToPassed.push({ key, caseId: base.caseId, repeat: base.repeat });
    else if (base.passed) flips.unchangedPassed++;
    else flips.unchangedFailed++;
  }
  const byCase = {};
  for (const flip of flips.passedToFailed) (byCase[flip.caseId] ??= { passedToFailed: 0, failedToPassed: 0 }).passedToFailed++;
  for (const flip of flips.failedToPassed) (byCase[flip.caseId] ??= { passedToFailed: 0, failedToPassed: 0 }).failedToPassed++;
  flips.byCase = byCase;
  flips.total = flips.passedToFailed.length + flips.failedToPassed.length;
  return flips;
}

/** Compare a mean against the regression ceiling; undefined baselines are undetermined, never pass. */
function judgeMean({ id, name, baseline, candidate, kind }) {
  const detail = { baselineMean: round(baseline), candidateMean: round(candidate), limitPct: REGRESSION_LIMIT_PCT };
  if (!isFiniteNumber(baseline)) return { id, name, status: 'undetermined', detail: { ...detail, reason: `baseline mean is ${baseline === null ? 'null (no eligible sample)' : 'not a number'}` } };
  if (!isFiniteNumber(candidate)) return { id, name, status: 'undetermined', detail: { ...detail, reason: 'candidate mean is null (no eligible sample)' } };
  if (baseline === 0) return { id, name, status: 'undetermined', detail: { ...detail, reason: 'baseline mean is 0; relative regression is undefined, not a pass' } };
  const ratio = candidate / baseline;
  const deltaPct = (ratio - 1) * 100;
  return {
    id, name,
    status: ratio <= LIMIT_RATIO + EPSILON ? 'passed' : 'failed',
    detail: { ...detail, ratio: round(ratio), deltaPct: round(deltaPct, 2), reason: kind === 'cost' ? 'mean cost, eligible cells only' : 'mean wallMs, eligible cells only' },
  };
}

/** Stage-1 gate (§8): (a) passRate not below, (b) no new violations, (c) cost/wall <= +10%. */
function judgeGate({ completeness, cases, violations, means, costBasisComparable }) {
  const criteria = [];
  const commonCases = Object.values(cases).filter(entry => entry.baseline && entry.candidate);
  const regressed = commonCases.filter(entry => !entry.passRateNotBelow).map(entry => ({
    caseId: entry.caseId,
    baseline: `${entry.baseline.passed}/${entry.baseline.runs}`,
    candidate: `${entry.candidate.passed}/${entry.candidate.runs}`,
  }));
  const improved = commonCases.filter(entry => entry.candidate.passed > entry.baseline.passed).map(entry => ({
    caseId: entry.caseId,
    baseline: `${entry.baseline.passed}/${entry.baseline.runs}`,
    candidate: `${entry.candidate.passed}/${entry.candidate.runs}`,
  }));
  criteria.push({
    id: 'passRateNotBelow',
    name: 'passRate not below baseline (3 runs per case, equal allowed)',
    status: !commonCases.length ? 'undetermined' : regressed.length ? 'failed' : 'passed',
    detail: {
      comparedCases: commonCases.length,
      regressedCases: regressed,
      improvedCases: improved,
      baselineOverall: means.baseline.overallPassRate,
      candidateOverall: means.candidate.overallPassRate,
      reason: !commonCases.length ? 'no case exists on both sides' : 'candidate passed count per case must be >= baseline',
    },
  });
  criteria.push({
    id: 'noNewRuleViolations',
    name: 'no new rule violations',
    status: !violations.comparable ? 'undetermined' : violations.added.length ? 'failed' : 'passed',
    detail: {
      baselineViolations: violations.baselineCount,
      candidateViolations: violations.candidateCount,
      added: violations.added,
      removed: violations.removed,
      casesWithNewRuleIds: violations.caseRulesAdded,
      reason: !violations.comparable ? 'some cells have no report.json; violations cannot be compared' : 'a new rule violation is a new cell+rule instance',
    },
  });
  criteria.push(costBasisComparable
    ? judgeMean({ id: 'costRegression', name: `mean cost regression <= ${REGRESSION_LIMIT_PCT}%`, baseline: means.baseline.meanCost, candidate: means.candidate.meanCost, kind: 'cost' })
    : { id: 'costRegression', name: `mean cost regression <= ${REGRESSION_LIMIT_PCT}%`, status: 'undetermined', detail: { reason: 'baseline and candidate use different cost bases' } });
  criteria.push(judgeMean({ id: 'wallRegression', name: `mean wallMs regression <= ${REGRESSION_LIMIT_PCT}%`, baseline: means.baseline.meanWallMs, candidate: means.candidate.meanWallMs, kind: 'wall' }));

  const failed = criteria.filter(entry => entry.status === 'failed');
  const undetermined = criteria.filter(entry => entry.status === 'undetermined');
  let status;
  if (!completeness.conclusive) status = 'inconclusive';
  else if (failed.length) status = 'failed';
  else if (undetermined.length) status = 'undetermined';
  else status = 'passed';
  const summary = status === 'passed'
    ? 'gate passed: passRate not below, no new rule violations, cost/wall within +10%'
    : status === 'failed'
      ? `gate failed: ${failed.map(entry => entry.id).join(', ')}`
      : status === 'undetermined'
        ? `gate undetermined: ${undetermined.map(entry => entry.id).join(', ')}`
        : 'inconclusive: this comparison cannot be used as a stage-1 gate conclusion';
  return {
    status,
    passed: status === 'passed',
    conclusive: completeness.conclusive,
    summary,
    triggered: failed.map(entry => entry.id),
    undetermined: undetermined.map(entry => entry.id),
    blockedBy: completeness.conclusive ? [] : completeness.reasons.map(reason => reason.code),
    limits: { regressionPct: REGRESSION_LIMIT_PCT },
    criteria,
  };
}

/**
 * Compare two completed golden runs. Pure given the evidence objects produced by
 * readEvidence(): `{summary, reports: Map<cellKey, report>}`.
 */
export function compareGolden(baselineEvidence, candidateEvidence) {
  const baseline = buildSide(baselineEvidence);
  const candidate = buildSide(candidateEvidence);
  const completeness = assessCompleteness(baseline, candidate);
  const cases = compareCaseSets(baseline, candidate);
  const flips = compareFlips(baseline, candidate);
  const violations = compareViolations(baseline, candidate);
  const overallDelta = deltaOf(baseline.overall, candidate.overall);
  const means = {
    eligibility: 'cells with usageComplete && !polluted',
    baseline: { ...baseline.overall, overallPassRate: baseline.overall.passRate, cases: Object.keys(baseline.cases).length },
    candidate: { ...candidate.overall, overallPassRate: candidate.overall.passRate, cases: Object.keys(candidate.cases).length },
    delta: overallDelta,
  };
  const gate = judgeGate({ completeness, cases, violations, means: { ...means, baseline: { ...means.baseline }, candidate: { ...means.candidate } }, costBasisComparable: completeness.costBasis.comparable });
  // judgeGate expects overall pass rates inside means.baseline/candidate; pass them explicitly.
  const categoryComparison = {};
  for (const category of [...new Set([...Object.keys(baseline.categories), ...Object.keys(candidate.categories)])].sort()) {
    const base = baseline.categories[category] ?? null;
    const next = candidate.categories[category] ?? null;
    categoryComparison[category] = {
      category,
      baseline: base,
      candidate: next,
      delta: base && next ? { passed: next.passed - base.passed, passRate: (next.passRate ?? 0) - (base.passRate ?? 0) } : null,
    };
  }
  return {
    schemaVersion: COMPARE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    baseline: {
      directory: baseline.directory,
      mode: baseline.summary.mode ?? null,
      model: baseline.summary.model ?? null,
      costBasis: completeness.costBasis.baseline,
      matrixState: completeness.matrix.baseline.state,
      stop: baseline.summary.stop ?? null,
      plan: baseline.summary.plan,
    },
    candidate: {
      directory: candidate.directory,
      mode: candidate.summary.mode ?? null,
      model: candidate.summary.model ?? null,
      costBasis: completeness.costBasis.candidate,
      matrixState: completeness.matrix.candidate.state,
      stop: candidate.summary.stop ?? null,
      plan: candidate.summary.plan,
    },
    completeness,
    gate,
    overall: { baseline: baseline.overall, candidate: candidate.overall, delta: overallDelta },
    categories: categoryComparison,
    cases,
    flips,
    violations,
    means,
    notes: [
      'means include only cells with usageComplete=true and polluted=false; eligibleRuns is the denominator',
      'passRate gate compares passed counts per case (3 runs, equal allowed) and the overall count',
      'cost/wall gate: candidate <= baseline * (1 + 10%); a 0/null baseline mean is undetermined, never a pass',
      'any data-completeness reason makes the gate inconclusive: do not use it as a stage-1 conclusion',
    ],
  };
}

// ---------------------------------------------------------------------------
// Human-readable rendering.
// ---------------------------------------------------------------------------

const formatValue = (value, digits = 2) => (isFiniteNumber(value) ? Number(value.toFixed(digits)).toLocaleString('en-US') : 'n/a');
const formatPct = ratio => (isFiniteNumber(ratio) ? `${(ratio * 100).toFixed(1)}%` : 'n/a');
const formatDeltaPct = value => (isFiniteNumber(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : 'n/a');
const formatPp = value => (isFiniteNumber(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}pp` : 'n/a');
const criterionMark = status => ({ passed: 'PASS', failed: 'FAIL', undetermined: 'N/A' })[status] ?? status;

/** Markdown/text rendering of a compareGolden() result. */
export function renderText(report) {
  const lines = [];
  lines.push('# Golden baseline comparison');
  lines.push('');
  lines.push(`- baseline: \`${report.baseline.directory}\` (${report.baseline.mode ?? '?'}, ${report.baseline.model ?? '?'}, matrix=${report.baseline.matrixState}, costBasis=${report.baseline.costBasis})`);
  lines.push(`- candidate: \`${report.candidate.directory}\` (${report.candidate.mode ?? '?'}, ${report.candidate.model ?? '?'}, matrix=${report.candidate.matrixState}, costBasis=${report.candidate.costBasis})`);
  lines.push(`- generated: ${report.generatedAt}`);
  lines.push('');
  const gateLabel = report.gate.status === 'passed' ? 'PASS' : report.gate.status === 'failed' ? 'FAIL' : report.gate.status === 'undetermined' ? 'UNDETERMINED' : 'INCONCLUSIVE';
  lines.push(`## Gate: ${gateLabel}`);
  lines.push('');
  lines.push(report.gate.summary);
  if (report.gate.triggered.length) lines.push(`- triggered: ${report.gate.triggered.join(', ')}`);
  if (report.gate.undetermined.length) lines.push(`- undetermined: ${report.gate.undetermined.join(', ')}`);
  lines.push('');
  lines.push('| criterion | status | detail |');
  lines.push('| --- | --- | --- |');
  for (const criterion of report.gate.criteria) {
    const detail = criterion.id === 'passRateNotBelow'
      ? `regressed cases: ${criterion.detail.regressedCases.map(entry => `${entry.caseId} ${entry.baseline}→${entry.candidate}`).join(', ') || 'none'}`
      : criterion.id === 'noNewRuleViolations'
        ? `added: ${criterion.detail.added.map(entry => `${entry.key} ${entry.ruleId}`).join(', ') || 'none'}`
        : `${formatValue(criterion.detail.baselineMean)} → ${formatValue(criterion.detail.candidateMean)}` +
          (isFiniteNumber(criterion.detail.deltaPct) ? ` (${formatDeltaPct(criterion.detail.deltaPct)})` : '') +
          (criterion.detail.reason ? `; ${criterion.detail.reason}` : '');
    lines.push(`| ${criterion.id} | ${criterionMark(criterion.status)} | ${detail} |`);
  }
  lines.push('');

  lines.push('## Data completeness');
  lines.push('');
  if (report.completeness.conclusive) lines.push('complete: both matrices full, no pollution/human-pending/usage gaps — the gate above is usable.');
  else {
    lines.push('**This comparison cannot be used as a stage-1 gate conclusion.** Reasons:');
    lines.push('');
    for (const reason of report.completeness.reasons) lines.push(`- \`${reason.code}\`: ${reason.detail}`);
  }
  lines.push('');

  lines.push('## Overall');
  lines.push('');
  lines.push('| metric | baseline | candidate | delta |');
  lines.push('| --- | --- | --- | --- |');
  const baseline = report.overall.baseline;
  const candidate = report.overall.candidate;
  lines.push(`| passed | ${baseline.passed}/${baseline.runs} | ${candidate.passed}/${candidate.runs} | ${report.overall.delta.passed >= 0 ? '+' : ''}${report.overall.delta.passed} |`);
  lines.push(`| passRate | ${formatPct(baseline.passRate)} | ${formatPct(candidate.passRate)} | ${formatPp(isFiniteNumber(report.overall.delta.passRate) ? report.overall.delta.passRate * 100 : null)} |`);
  lines.push(`| meanTokens | ${formatValue(baseline.meanTokens)} | ${formatValue(candidate.meanTokens)} | ${formatDeltaPct(report.means.delta.meanTokensPct)} |`);
  lines.push(`| meanCost (${report.baseline.costBasis}) | ${formatValue(baseline.meanCost, 6)} | ${formatValue(candidate.meanCost, 6)} | ${formatDeltaPct(report.means.delta.meanCostPct)} |`);
  lines.push(`| meanWallMs | ${formatValue(baseline.meanWallMs)} | ${formatValue(candidate.meanWallMs)} | ${formatDeltaPct(report.means.delta.meanWallMsPct)} |`);
  lines.push(`| meanCacheReadShare | ${formatPct(baseline.meanCacheReadShare)} | ${formatPct(candidate.meanCacheReadShare)} | ${formatPp(report.means.delta.meanCacheReadSharePp)} |`);
  lines.push(`| mainRereadRate | ${formatPct(baseline.mainRereadRate)} | ${formatPct(candidate.mainRereadRate)} | ${formatPp(report.means.delta.mainRereadRatePp)} |`);
  lines.push(`| childRereadOfMain | ${formatPct(baseline.childRereadOfMain)} | ${formatPct(candidate.childRereadOfMain)} | ${formatPp(report.means.delta.childRereadOfMainPp)} |`);
  lines.push(`| eligibleRuns | ${baseline.eligibleRuns}/${baseline.runs} | ${candidate.eligibleRuns}/${candidate.runs} | |`);
  lines.push('');

  lines.push('## Per case');
  lines.push('');
  lines.push('| case | baseline | candidate | Δpassed | meanTokens | meanCost | meanWallMs | cacheReadShare | verdict |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of Object.values(report.cases)) {
    const base = entry.baseline;
    const next = entry.candidate;
    if (!base || !next) {
      lines.push(`| ${entry.caseId} | ${base ? `${base.passed}/${base.runs}` : 'missing'} | ${next ? `${next.passed}/${next.runs}` : 'missing'} | n/a | n/a | n/a | n/a | n/a | not-comparable |`);
      continue;
    }
    lines.push(`| ${entry.caseId} | ${base.passed}/${base.runs} (${formatPct(base.passRate)}) | ${next.passed}/${next.runs} (${formatPct(next.passRate)}) | ${entry.delta.passed >= 0 ? '+' : ''}${entry.delta.passed} | ${formatDeltaPct(entry.delta.meanTokensPct)} | ${formatDeltaPct(entry.delta.meanCostPct)} | ${formatDeltaPct(entry.delta.meanWallMsPct)} | ${formatPct(next.meanCacheReadShare)} | ${entry.verdict} |`);
  }
  lines.push('');
  lines.push('Means are computed only over cells with `usageComplete && !polluted`; `eligibleRuns` is the denominator. `humanPendingRuns` per case: ' +
    Object.values(report.cases).map(entry => `${entry.caseId}=${(entry.candidate ?? entry.baseline)?.humanPendingRuns ?? 0}`).join(', '));
  lines.push('');

  lines.push('## Flips');
  lines.push('');
  lines.push(`- PASSED→FAILED (${report.flips.passedToFailed.length}): ${report.flips.passedToFailed.map(flip => flip.key).join(', ') || 'none'}`);
  lines.push(`- FAILED→PASSED (${report.flips.failedToPassed.length}): ${report.flips.failedToPassed.map(flip => flip.key).join(', ') || 'none'}`);
  lines.push('');

  lines.push('## Rule violations');
  lines.push('');
  lines.push(`- baseline: ${report.violations.baselineCount} instance(s); candidate: ${report.violations.candidateCount}`);
  lines.push(`- added (${report.violations.added.length}): ${report.violations.added.map(entry => `${entry.key} ${entry.ruleId}`).join(', ') || 'none'}`);
  lines.push(`- removed (${report.violations.removed.length}): ${report.violations.removed.map(entry => `${entry.key} ${entry.ruleId}`).join(', ') || 'none'}`);
  if (report.violations.caseRulesAdded.length) lines.push(`- cases whose new rule ids appear: ${report.violations.caseRulesAdded.map(entry => `${entry.caseId}/${entry.ruleId}`).join(', ')}`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const USAGE = `Kodo golden baseline comparison (stage-1 regression gate)

  node scripts/golden/compare.mjs --baseline <dir|summary.json> --candidate <dir|summary.json> \\
      [--out <file>] [--json] [--fail-on-gate] [--cases id1,id2]

Reads two COMPLETED golden runs and reports: per-case passRate/mean deltas,
PASSED<->FAILED flips, new rule violations, data completeness, and the stage-1
gate (passRate not below baseline; no new rule violations; mean cost and mean
wallMs regression <= 10%). The JSON report is written to --out (default
.kodo/golden/compare-<stamp>.json) and the Markdown summary is printed.

  --json          print the JSON report to stdout instead of the Markdown summary
  --fail-on-gate  exit 2 unless the gate status is "passed" (inconclusive counts as not passed)
  --cases         restrict the comparison to the listed case ids (both runs must cover
                  exactly the same scoped matrix; cases outside the list are excluded)

Exit codes: 0 comparison produced; 2 --fail-on-gate and gate not passed; 1 input/format error.
`;

async function main() {
  const { values } = parseArgs({
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean', default: false },
      'fail-on-gate': { type: 'boolean', default: false },
      cases: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.baseline || !values.candidate) throw new GoldenError('COMPARE_CLI', 'both --baseline and --candidate are required (run with --help for usage)');
  let baseline = readEvidence(values.baseline);
  let candidate = readEvidence(values.candidate);
  const onlyCases = values.cases ? String(values.cases).split(',').map(entry => entry.trim()).filter(Boolean) : null;
  if (onlyCases) {
    baseline = { ...baseline, summary: scopeSummary(baseline.summary, onlyCases) };
    candidate = { ...candidate, summary: scopeSummary(candidate.summary, onlyCases) };
  }
  const report = compareGolden(baseline, candidate);
  if (onlyCases) {
    report.scope = { cases: onlyCases, note: 'comparison restricted with --cases; cases outside this list are excluded from the gate' };
    report.notes.push(`scope restricted to cases: ${onlyCases.join(', ')}`);
  }
  const outFile = values.out
    ? path.resolve(values.out)
    : path.join(repoRoot, '.kodo', 'golden', `compare-${stamp()}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  // --json is machine-readable: stdout carries exactly one JSON document; the path goes to stderr.
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    console.error(`JSON report: ${outFile}`);
  } else {
    console.log(renderText(report));
    console.log(`\nJSON report: ${outFile}`);
  }
  if (values['fail-on-gate']) process.exitCode = report.gate.status === 'passed' ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error instanceof GoldenError ? error.message : error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
