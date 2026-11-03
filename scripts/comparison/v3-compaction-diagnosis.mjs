// Zero-cost compaction diagnosis (P3 §6.1 of docs/kodo-next-optimization-plan.md).
// Reads a finished evaluation directory without modifying it: SQLite is opened
// read-only and blobs are read from disk, so no Store lock is ever written into
// frozen evidence. For every model call it replays the token estimator against
// only the calls that existed before it, and compares the estimate, the
// calibration branch, the shared message prefix with the previous request and
// provider cache reads. Results describe mechanisms; they are not cost claims.

import console from 'node:console';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const STATE_PREFIX = 'Kernel execution state: ';

/** Number of leading messages two requests share exactly. */
export function commonPrefix(left, right) {
  let index = 0;
  while (index < left.length && index < right.length && digest(left[index]) === digest(right[index])) index++;
  return index;
}

/** Why `next` stops matching `previous`: what sits at the first differing position of `previous`. */
export function divergence(previous, next) {
  const at = commonPrefix(previous, next);
  if (at === previous.length) return { at, kind: 'none' };
  const message = previous[at];
  const kind = message.role === 'system' && String(message.content ?? '').startsWith(STATE_PREFIX) ? 'kernel-state'
    : message.role === 'user' && String(message.content ?? '').startsWith('Task handoff summary') ? 'summary-marker'
      : `${message.role}-changed`;
  return { at, kind, previousLength: previous.length, tail: previous.length - at };
}

/** Read-only adapter with the Store methods the estimator uses, limited to calls before `rowid`. */
function evidenceStore(db, directory) {
  let before = Infinity;
  const blob = ref => JSON.parse(readFileSync(path.join(directory, 'blobs', `${ref}.json`), 'utf8'));
  return {
    at(rowid) { before = rowid; return this; },
    readBlob: blob,
    run: id => JSON.parse(db.prepare('SELECT data FROM runs WHERE id=?').get(id).data),
    events: runId => db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY seq').all(runId).map(row => ({ ...row, data: JSON.parse(row.data) })),
    recentModelCalls: (runId, limit = 32) => db.prepare("SELECT data FROM calls WHERE run_id=? AND rowid<? AND json_extract(data,'$.kind')='model' AND json_extract(data,'$.status')='succeeded' ORDER BY rowid DESC LIMIT ?")
      .all(runId, Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER, limit).map(row => JSON.parse(row.data)),
  };
}

const empty = { readBlob: () => ({}), run: () => ({}), events: () => [], recentModelCalls: () => [] };

const isKernelState = message => message?.role === 'system' && String(message.content ?? '').startsWith(STATE_PREFIX);

/**
 * Counterfactual for the §6.2 row-1 candidate, run through the real estimator:
 * each prior request is presented without its trailing kernel-state message, so
 * its measured input is attributed to a shorter prefix. That only overstates the
 * prefix (the dropped message was billed too), so the candidate cannot undercount.
 */
export function stateTolerantStore(base) {
  const prefix = 'state-tolerant:';
  return {
    ...base,
    at(rowid) { base.at(rowid); return this; },
    readBlob: ref => {
      if (!ref.startsWith(prefix)) return base.readBlob(ref);
      const request = base.readBlob(ref.slice(prefix.length));
      return isKernelState(request.messages?.at(-1)) ? { ...request, messages: request.messages.slice(0, -1) } : request;
    },
    recentModelCalls: (runId, limit) => base.recentModelCalls(runId, limit).map(call => ({ ...call, requestRef: `${prefix}${call.requestRef}` })),
  };
}

/** One row per model call of the main run, in order. */
function callRows(db, directory, estimator) {
  const store = evidenceStore(db, directory);
  const tolerant = stateTolerantStore(store);
  const main = JSON.parse(db.prepare("SELECT data FROM runs WHERE json_extract(data,'$.parentId') IS NULL").get().data);
  const rows = [];
  let previous;
  for (const { rowid, data } of db.prepare('SELECT rowid, data FROM calls WHERE run_id=? ORDER BY rowid').all(main.id)) {
    const call = JSON.parse(data);
    if (call.kind !== 'model' || call.status !== 'succeeded' || !call.resultRef) continue;
    const request = store.readBlob(call.requestRef);
    const usage = store.readBlob(call.resultRef).usage ?? null;
    const replayed = estimator(store.at(rowid), main, request.messages, request.tools);
    const raw = estimator(empty, main, request.messages, request.tools);
    const candidate = estimator(tolerant.at(rowid), main, request.messages, request.tools);
    rows.push({
      purpose: call.purpose ?? 'work', step: call.step, messages: request.messages.length,
      input: usage?.input ?? null, cacheRead: usage?.cacheRead ?? 0, output: usage?.output ?? null,
      estimate: replayed, calibrated: replayed !== raw, estimateRatio: usage?.input ? replayed / usage.input : null,
      candidateEstimate: candidate, candidateCalibrated: candidate !== raw, candidateRatio: usage?.input ? candidate / usage.input : null,
      prefixWithPrevious: previous ? commonPrefix(previous.messages, request.messages) : 0,
      toolsSame: previous ? digest(previous.tools) === digest(request.tools) : null,
      toolChoice: request.toolChoice ?? null,
      divergence: previous ? divergence(previous.messages, request.messages) : null,
    });
    previous = request;
  }
  return rows;
}

/** Summary attempts: planned size, measured request size, output against target, steps between installs. */
function summaryRows(db) {
  const events = db.prepare("SELECT type, data FROM events WHERE type LIKE 'context.summary.%' ORDER BY seq").all().map(row => ({ type: row.type, ...JSON.parse(row.data) }));
  const started = events.filter(event => event.type === 'context.summary.started');
  const installed = events.filter(event => event.type === 'context.summary.installed');
  return {
    attempts: started.length, installs: installed.length, skips: events.filter(event => event.type === 'context.summary.skipped').map(event => event.reason),
    installsDetail: installed.map((event, index) => ({
      beforeTokens: event.beforeTokens, afterTokens: event.afterTokens, fixedTokens: event.fixedTokens, installTargetTokens: event.installTargetTokens, targetMet: event.targetMet,
      targetTokens: started[index]?.targetTokens ?? null, summaryInput: event.usage?.input ?? null, summaryOutput: event.usage?.output ?? null,
      summaryInputVsBefore: event.usage?.input && event.beforeTokens ? event.usage.input / event.beforeTokens : null,
      outputVsTarget: event.usage?.output && started[index]?.targetTokens ? event.usage.output / started[index].targetTokens : null,
      droppedGroups: event.droppedGroups, coveredMessages: event.coveredOffsets?.length ?? 0,
    })),
  };
}

const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/** Aggregate the rows of one trial into the questions §6.1 asks. */
export function trialFindings(rows, summaries) {
  const work = rows.filter(row => row.purpose === 'work');
  const compaction = rows.filter(row => row.purpose === 'compaction');
  const later = work.slice(1);
  const kinds = {};
  for (const row of later) kinds[row.divergence.kind] = (kinds[row.divergence.kind] ?? 0) + 1;
  const ratio = (part, whole) => (whole ? part / whole : null);
  return {
    workCalls: work.length, compactionCalls: compaction.length,
    calibratedShare: ratio(later.filter(row => row.calibrated).length, later.length),
    meanEstimateRatio: mean(work.filter(row => row.estimateRatio).map(row => row.estimateRatio)),
    candidateCalibratedShare: ratio(later.filter(row => row.candidateCalibrated).length, later.length),
    meanCandidateRatio: mean(work.filter(row => row.candidateRatio).map(row => row.candidateRatio)),
    minCandidateRatio: work.some(row => row.candidateRatio) ? Math.min(...work.filter(row => row.candidateRatio).map(row => row.candidateRatio)) : null,
    workCacheReadShare: ratio(work.reduce((sum, row) => sum + row.cacheRead, 0), work.reduce((sum, row) => sum + (row.input ?? 0), 0)),
    compactionCacheReadShare: ratio(compaction.reduce((sum, row) => sum + row.cacheRead, 0), compaction.reduce((sum, row) => sum + (row.input ?? 0), 0)),
    divergenceKinds: kinds,
    compactionPrefix: compaction.map(row => ({ prefix: row.prefixWithPrevious, messages: row.messages, toolsSame: row.toolsSame, toolChoice: row.toolChoice, divergence: row.divergence.kind })),
    ...summaries,
  };
}

function trials(root) {
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(path.join(root, entry.name, 'state', 'kodo.sqlite'))).map(entry => entry.name).sort();
}

async function main() {
  const [source, outArg] = process.argv.slice(2);
  if (!source) throw new Error('usage: node scripts/comparison/v3-compaction-diagnosis.mjs <evaluation-dir> [out-dir]');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const { estimateInputTokens } = await import(pathToFileURL(path.join(repoRoot, 'dist/runtime/context-tokens.js')).href);
  const root = path.resolve(source);
  const report = { source: root, createdAt: new Date().toISOString(), note: 'Read-only replay of recorded requests; estimates use the current dist estimator.', trials: {} };
  for (const name of trials(root)) {
    const directory = path.join(root, name, 'state');
    const db = new DatabaseSync(path.join(directory, 'kodo.sqlite'), { readOnly: true });
    try {
      const rows = callRows(db, directory, estimateInputTokens);
      report.trials[name] = { findings: trialFindings(rows, summaryRows(db)), rows };
    } finally { db.close(); }
  }
  const outRoot = path.resolve(outArg ?? path.join(repoRoot, '.kodo', `v3-compaction-diagnosis-${Date.now()}`));
  if (existsSync(outRoot) && readdirSync(outRoot).length) throw new Error(`output directory is not empty: ${outRoot}`);
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(path.join(outRoot, 'diagnosis.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ out: outRoot, trials: Object.fromEntries(Object.entries(report.trials).map(([name, trial]) => [name, { ...trial.findings, installsDetail: undefined, compactionPrefix: undefined }])) }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
