// Pure metrics aggregation for the Kodo golden evaluations
// (docs/kodo-golden-eval-design-20261103.md §6):
// per-run cost/token/wall/cache fields and the summary pass rates, means,
// repeated-read baseline and polluted cells. No I/O: the runner hands in the
// usage ledger, relay stats, extracted file.read records and final reports.

import { completeness, priceLedger } from '../comparison/v3-eval-matrix.mjs';

const sum = values => values.reduce((total, value) => total + value, 0);
const round = (value, digits = 6) => (value === null ? null : Number(value.toFixed(digits)));

/** cacheRead / inputTokens, null when the ledger recorded no input (§6). */
export function cacheReadShare(ledger) {
  return ledger && ledger.inputTokens > 0 ? ledger.cacheRead / ledger.inputTokens : null;
}

function roleReadStats(runs) {
  let fileReadCalls = 0;
  let rereads = 0;
  const distinct = new Set();
  for (const run of runs) {
    const seen = new Set();
    for (const read of run.reads ?? []) {
      fileReadCalls++;
      const path = read.path;
      if (typeof path !== 'string') continue;
      distinct.add(path);
      if (seen.has(path)) rereads++;
      seen.add(path);
    }
  }
  return { fileReadCalls, rereads, distinctPaths: distinct.size, rereadRate: fileReadCalls ? rereads / fileReadCalls : null };
}

/**
 * Re-read metrics (§6): file.read calls and repeated reads of the same path
 * inside one run, main and children separately, plus childRereadOfMain — the
 * share of paths a child read that the main run had already read before that
 * child started (event-sequence comparison; null when there are no children).
 *
 * Input: { mainRuns: [{reads: [{path, seq}]}], childRuns: [{reads, startSeq}] }.
 */
export function readMetrics({ mainRuns = [], childRuns = [] } = {}) {
  const main = roleReadStats(mainRuns);
  const child = roleReadStats(childRuns);
  const mainReadSeq = new Map();
  for (const run of mainRuns) {
    for (const read of run.reads ?? []) {
      if (typeof read.path !== 'string') continue;
      const current = mainReadSeq.get(read.path);
      if (current === undefined || (typeof read.seq === 'number' && read.seq < current)) mainReadSeq.set(read.path, typeof read.seq === 'number' ? read.seq : Infinity);
    }
  }
  let numerator = 0;
  let denominator = 0;
  for (const run of childRuns) {
    const paths = new Set((run.reads ?? []).map(read => read.path).filter(path => typeof path === 'string'));
    for (const path of paths) {
      denominator++;
      const mainSeq = mainReadSeq.get(path);
      if (mainSeq !== undefined && mainSeq !== Infinity && typeof run.startSeq === 'number' && mainSeq < run.startSeq) numerator++;
    }
  }
  return {
    fileReadCalls: { main: main.fileReadCalls, child: child.fileReadCalls },
    rereads: { main: main.rereads, child: child.rereads },
    rereadRates: { main: main.rereadRate, child: child.rereadRate },
    distinctPaths: { main: main.distinctPaths, child: child.distinctPaths },
    childRereadOfMain: denominator > 0 ? numerator / denominator : null,
    childRereadOfMainDetail: { numerator, denominator },
  };
}

/** Per-run metrics for report.json (§6). `reads` is the readMetrics() input. */
export function runMetrics({ ledger, relay = {}, reads = { mainRuns: [], childRuns: [] }, prices = null }) {
  if (!ledger) throw new Error('runMetrics requires a usage ledger');
  const read = readMetrics(reads);
  const cost = prices
    ? { ...priceLedger(ledger, prices), basis: 'price' }
    : { basis: 'tokens', value: ledger.totalTokens, certain: ledger.complete };
  const toolCalls = sum(Object.values(ledger.roles ?? {}).map(role => role.toolCalls ?? 0));
  return {
    modelCalls: ledger.modelCalls,
    measuredCalls: ledger.measuredCalls,
    unknownCalls: ledger.unknownCalls,
    inputTokens: ledger.inputTokens,
    outputTokens: ledger.outputTokens,
    totalTokens: ledger.totalTokens,
    cacheRead: ledger.cacheRead,
    cacheWrite: ledger.cacheWrite,
    uncachedInput: ledger.uncachedInput,
    cacheReadShare: cacheReadShare(ledger),
    wallMs: ledger.wallMs,
    toolCalls,
    relayRequests: relay.requests ?? 0,
    relayRejected: (relay.rejected ?? []).length,
    relayRejectedCodes: [...(relay.rejected ?? [])],
    providerFailures: ledger.providerFailures,
    ...read,
    usageComplete: Boolean(ledger.complete),
    cost,
  };
}

/**
 * Summary across all cells (§6):
 * - passRate per case and per category over every scheduled run (polluted runs
 *   still count for quality, §7);
 * - meanTokens/meanCost/meanWallMs/meanCacheReadShare only over
 *   `usageComplete && !polluted` runs, null with a note when no sample exists;
 * - repeatedReadBaseline (child reread rate and its denominators);
 * - pollutedCells and humanPendingCells.
 */
export function summarize(reports, { plan = [], stop = null, prices = null, mode = null, model = null } = {}) {
  const cases = {};
  const categories = {};
  const cellRows = [];
  let allPassed = 0;
  let allRuns = 0;
  let humanPendingRuns = 0;
  const pollutedCells = [];
  const humanPendingCells = [];
  let childReadCalls = 0;
  let childRereads = 0;
  let mainReadCalls = 0;
  let mainRereads = 0;
  let childPairNumerator = 0;
  let childPairDenominator = 0;

  for (const report of reports) {
    const metrics = report.metrics ?? {};
    const category = report.category ?? 'unknown';
    const caseId = report.caseId ?? 'unknown';
    const passed = Boolean(report.passed);
    allRuns++;
    if (passed) allPassed++;
    if (report.humanPending) { humanPendingRuns++; humanPendingCells.push(report.key); }
    const entry = (cases[caseId] ??= {
      caseId, category, title: report.title ?? caseId,
      runs: 0, passed: 0, humanPendingRuns: 0,
      eligibleRuns: 0, meanTokensSum: 0, meanCostSum: 0, meanWallSum: 0, cacheShareSum: 0, cacheShareSamples: 0,
      violationCells: 0, failingChecks: {},
    });
    entry.runs++;
    if (passed) entry.passed++;
    if (report.humanPending) entry.humanPendingRuns++;
    if ((report.score?.violations ?? []).length) entry.violationCells++;
    for (const check of report.score?.checks ?? []) {
      if (check.status !== 'failed') continue;
      entry.failingChecks[check.id] = (entry.failingChecks[check.id] ?? 0) + 1;
    }
    for (const rule of report.score?.rules ?? []) {
      if (rule.status !== 'failed') continue;
      entry.failingChecks[rule.id] = (entry.failingChecks[rule.id] ?? 0) + 1;
    }
    const reads = metrics.fileReadCalls ?? {};
    const rereads = metrics.rereads ?? {};
    mainReadCalls += reads.main ?? 0;
    mainRereads += rereads.main ?? 0;
    childReadCalls += reads.child ?? 0;
    childRereads += rereads.child ?? 0;
    childPairNumerator += metrics.childRereadOfMainDetail?.numerator ?? 0;
    childPairDenominator += metrics.childRereadOfMainDetail?.denominator ?? 0;
    const polluted = Boolean(report.polluted);
    if (polluted) pollutedCells.push({ key: report.key, caseId, repeat: report.repeat, reasons: report.pollution?.reasons ?? [], usageComplete: metrics.usageComplete !== false });
    const eligible = metrics.usageComplete === true && !polluted;
    if (eligible) {
      entry.eligibleRuns++;
      entry.meanTokensSum += metrics.totalTokens ?? 0;
      entry.meanCostSum += metrics.cost?.value ?? 0;
      entry.meanWallSum += metrics.wallMs ?? 0;
      const share = metrics.cacheReadShare;
      if (typeof share === 'number') { entry.cacheShareSum += share; entry.cacheShareSamples++; }
    }
    const categoryEntry = (categories[category] ??= { category, runs: 0, passed: 0, cases: 0, _caseIds: new Set() });
    categoryEntry.runs++;
    if (passed) categoryEntry.passed++;
    categoryEntry._caseIds.add(caseId);
    cellRows.push({
      key: report.key, caseId, repeat: report.repeat, status: report.status, passed,
      score: report.score?.score ?? null, humanPending: Boolean(report.humanPending), polluted,
      usageComplete: metrics.usageComplete === true, totalTokens: metrics.totalTokens ?? null,
      cost: metrics.cost?.value ?? null, wallMs: metrics.wallMs ?? null,
      cacheReadShare: metrics.cacheReadShare ?? null,
      violations: report.score?.violations?.length ?? 0,
    });
  }

  for (const entry of Object.values(cases)) {
    entry.passRate = entry.runs ? entry.passed / entry.runs : null;
    entry.meanTokens = entry.eligibleRuns ? round(entry.meanTokensSum / entry.eligibleRuns, 2) : null;
    entry.meanCost = entry.eligibleRuns ? round(entry.meanCostSum / entry.eligibleRuns, 8) : null;
    entry.meanWallMs = entry.eligibleRuns ? round(entry.meanWallSum / entry.eligibleRuns, 2) : null;
    entry.meanCacheReadShare = entry.cacheShareSamples ? round(entry.cacheShareSum / entry.cacheShareSamples, 6) : null;
    delete entry.meanTokensSum; delete entry.meanCostSum; delete entry.meanWallSum; delete entry.cacheShareSum;
  }
  for (const entry of Object.values(categories)) {
    entry.passRate = entry.runs ? entry.passed / entry.runs : null;
    entry.cases = entry._caseIds.size;
    delete entry._caseIds;
  }
  const matrix = completeness(plan, reports);
  const matrixState = !matrix.valid ? 'invalid' : !matrix.complete ? 'incomplete' : 'complete';
  const first = reports[0] ?? null;
  return {
    mode: mode ?? first?.mode ?? null,
    model: model ?? first?.model ?? null,
    costBasis: prices ? 'price' : 'tokens',
    prices: prices ?? null,
    stop: stop ?? null,
    matrix,
    matrixState,
    overall: { cases: Object.keys(cases).length, runs: allRuns, passed: allPassed, passRate: allRuns ? allPassed / allRuns : null, humanPendingRuns },
    cases,
    categories,
    cells: cellRows,
    repeatedReadBaseline: {
      note: 'main/child rereads count repeated file.read of the same path inside one run; childRereadOfMain compares the path set of each child run with main reads recorded before that child started',
      main: { fileReadCalls: mainReadCalls, rereads: mainRereads, rereadRate: mainReadCalls ? mainRereads / mainReadCalls : null },
      child: { fileReadCalls: childReadCalls, rereads: childRereads, rereadRate: childReadCalls ? childRereads / childReadCalls : null },
      childRereadOfMain: childPairDenominator ? childPairNumerator / childPairDenominator : null,
      childRereadOfMainDetail: { numerator: childPairNumerator, denominator: childPairDenominator },
    },
    pollutedCells,
    humanPendingCells,
    notes: [
      'passRate counts every run; polluted runs keep their quality verdict but are excluded from cost/token/cache means (§7)',
      'means use only runs with usageComplete && !polluted; null means no eligible sample',
      'human checks that are still pending are excluded from the score denominator; fill runs/<case>/r<n>/human.json and rescore to settle them',
    ],
  };
}
