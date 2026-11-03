// Read-only analysis for the two-build efficiency comparison; never starts a model or container.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readEvidence } from './delegation-metrics.mjs';
import { auditRepeatedChecks } from './check-audit.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const rows = file => existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)) : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = values => { const result = {}; for (const value of values) result[value ?? 'unknown'] = (result[value ?? 'unknown'] ?? 0) + 1; return result; };
const millis = value => Date.parse(value);

export function usageTotals(calls) {
  const fields = { credit: usage => usage?.credit, input: usage => usage?.prompt_tokens ?? usage?.input_tokens,
    cached: usage => usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens,
    output: usage => usage?.completion_tokens ?? usage?.output_tokens,
    reasoning: usage => usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_thinking_tokens };
  return Object.fromEntries(Object.entries(fields).map(([name, pick]) => {
    const known = calls.map(call => pick(call.usage)).filter(finite);
    return [name, { knownSubtotal: known.reduce((sum, value) => sum + value, 0), missingRequests: calls.length - known.length,
      complete: calls.length > 0 && known.length === calls.length && calls.every(call => call.status !== 'running') }];
  }));
}

/** Elapsed time with at least two intervals active, rather than double-counted occupancy. */
export function overlapSeconds(intervals) {
  const marks = intervals.filter(([start, end]) => finite(start) && finite(end) && end >= start)
    .flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, previous = 0, duration = 0;
  for (const [at, delta] of marks) { if (active >= 2) duration += at - previous; active += delta; previous = at; }
  return duration / 1000;
}

export function peakConcurrency(intervals) {
  const marks = intervals.filter(([start, end]) => finite(start) && finite(end) && end > start)
    .flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, peak = 0;
  for (const [, delta] of marks) { active += delta; peak = Math.max(peak, active); }
  return peak;
}

/** Lock waiting is separate from tool execution; overlapping waiters are not extra wall time. */
export function nativeLockTiming(events) {
  const waits = events.filter(event => event.type === 'lock.waited');
  const valid = waits.filter(event => finite(event.data?.waitedMs) && finite(millis(event.time)));
  const intervals = valid.map(event => [millis(event.time) - event.data.waitedMs, millis(event.time)]).sort((a, b) => a[0] - b[0]);
  let end = -Infinity, union = 0;
  for (const [start, stop] of intervals) { union += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  return { events: waits.length, invalidEvents: waits.length - valid.length,
    cumulativeSec: valid.reduce((sum, event) => sum + event.data.waitedMs, 0) / 1000,
    unionSec: union / 1000, peakWaiters: peakConcurrency(intervals),
    note: 'Recorded lock waits only. Concurrent waits overlap execution by other agents; neither subtotal is net lost wall time.' };
}

/** Native call lifetimes, independent of delayed relay stream closure. */
export function nativeModelTiming(events) {
  const calls = new Map();
  let invalid = 0;
  for (const event of events) {
    if (!['model.started', 'model.finished'].includes(event.type)) continue;
    if (!event.data?.callId) { invalid++; continue; }
    const key = JSON.stringify([event.runId, event.data.callId]);
    const call = calls.get(key) ?? {};
    const field = event.type === 'model.started' ? 'start' : 'end';
    if (call[field] !== undefined) invalid++;
    call[field] = millis(event.time);
    calls.set(key, call);
  }
  const intervals = [...calls.values()].filter(call => finite(call.start) && finite(call.end) && call.end >= call.start)
    .map(call => [call.start, call.end]);
  const incompleteCalls = calls.size - intervals.length;
  const complete = calls.size > 0 && incompleteCalls === 0 && invalid === 0;
  return { complete, pairedCalls: intervals.length, incompleteCalls, invalidEvents: invalid,
    peakModelRequests: complete ? peakConcurrency(intervals) : null,
    modelRequestOverlapSec: complete ? overlapSeconds(intervals) : null };
}

async function native(directory) {
  const database = path.join(directory, 'state', 'kodo', 'kodo.sqlite');
  if (!existsSync(database)) return { sessions: [], runs: [], calls: [], events: [], finalTexts: {}, warnings: ['Native database is missing'] };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const records = table => tables.has(table) ? db.prepare(`SELECT data FROM ${table}`).all().map(row => JSON.parse(row.data)) : [];
    const sessions = records('sessions'), runs = records('runs');
    const events = db.prepare('SELECT seq,time,run_id AS runId,type,data FROM events ORDER BY seq').all().map(row => ({ ...row, data: JSON.parse(row.data) }));
    const finalTexts = {}, warnings = [];
    const decode = ref => {
      if (typeof ref !== 'string' || !/^[a-f0-9]{64}$/u.test(ref)) return undefined;
      const stored = tables.has('blob_segments') ? db.prepare('SELECT data FROM blob_segments WHERE ref=?').get(ref)?.data : undefined;
      const file = path.join(directory, 'state', 'kodo', 'blobs', `${ref}.json`);
      const blob = path.join(directory, 'state', 'kodo', 'blobs', `${ref}.blob`);
      const text = stored === '{"kodo.blob":"file"}' && existsSync(blob) ? readFileSync(blob, 'utf8') : stored ?? (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
      return typeof text === 'string' && createHash('sha256').update(text).digest('hex') === ref ? JSON.parse(text) : undefined;
    };
    for (const run of runs.filter(item => !item.parentId && item.resultRef)) {
      const ref = run.resultRef, value = decode(ref);
      if (typeof value?.text === 'string') finalTexts[run.id] = value.text;
      if (finalTexts[run.id] === undefined) warnings.push(`Final result ${ref} needs manual decoding; presence is not counted as a nonempty reply`);
    }
    const calls = records('calls').filter(call => ['shell.exec', 'process.exec'].includes(call.name)).map(call => {
      const request = decode(call.kernelRef ?? call.requestRef);
      const args = typeof request?.arguments === 'string' ? JSON.parse(request.arguments) : request?.arguments ?? request?.args;
      if (!args) warnings.push(`Missing command arguments for ${call.id}; repeated-check audit cannot classify it`);
      return { ...call, args, result: decode(call.resultRef) };
    });
    db.exec('COMMIT');
    return { sessions, runs, calls, events, finalTexts, warnings };
  } finally { db.close(); }
}

export async function analyzeComparisonCell(directory, result = {}, { sourceRoots = ['fastapi'] } = {}) {
  const calls = existsSync(path.join(directory, 'relay', 'calls.json')) ? read(path.join(directory, 'relay', 'calls.json')) : [];
  const steps = rows(path.join(directory, 'process', 'steps.jsonl'));
  const metrics = await readEvidence(directory, { sourceRoots });
  const state = await native(directory);
  const primary = state.runs.filter(run => !run.parentId).sort((a, b) => millis(a.createdAt) - millis(b.createdAt)).at(-1);
  const terminalAt = run => state.events.filter(event => event.runId === run.id && /^run\.(completed|failed|cancelled)$/u.test(event.type)).at(-1)?.time;
  const children = state.runs.filter(run => run.parentId);
  const intervals = children.map(run => [millis(run.createdAt), millis(terminalAt(run))]);
  const childEnds = children.map(run => millis(terminalAt(run))).filter(Number.isFinite);
  const lastChild = childEnds.length ? Math.max(...childEnds) : null;
  const mainAfter = lastChild === null ? [] : steps.filter(step => step.runId === primary?.id && step.startedMs > lastChild);
  const git = existsSync(path.join(directory, 'git-state.json')) ? read(path.join(directory, 'git-state.json')) : null;
  const checks = { rootCompleted: primary?.status === 'completed', externalVerifierPassed: result.verification?.passed === true,
    branchRecorded: typeof git?.branch === 'string' && !['', 'main', 'master', 'HEAD'].includes(git.branch.trim()),
    committed: typeof git?.commits === 'string' && git.commits.trim().length > 0,
    clean: typeof git?.status === 'string' && !git.status.trim(), finalReplyRecorded: Boolean(state.finalTexts[primary?.id]?.trim()) };
  const requestIntervals = calls.map(call => [call.startedMs ?? millis(call.startedAt), (call.startedMs ?? millis(call.startedAt)) + (call.timing?.streamEndMs ?? call.elapsedMs ?? Number.NaN)]);
  return { result, requests: calls.length, usage: usageTotals(calls), httpStatuses: count(calls.map(call => call.httpStatus)),
    recordingStatuses: count(calls.map(call => call.status)),
    savedConfiguration: state.sessions.map(session => ({ agentFactors: session.agentFactors, taskProtocol: session.taskProtocol ?? null, toolProfile: session.toolProfile ?? null, efficiencyVersion: session.efficiencyVersion ?? null, budget: session.budget ?? null })),
    taskEvents: state.events.filter(event => /^(?:todo|task|dependency|resource|workspace|execution|lock|wait|run)\.|^tool\.resource_ready$|^completion\.(?:deferred|invalidated)$/u.test(event.type)),
    childRuns: children.map(run => ({ id: run.id, parentId: run.parentId, status: run.status, createdAt: run.createdAt,
      terminalAt: terminalAt(run) ?? null, continuationOf: run.continuationOf ?? null, todoId: run.todo?.id ?? null,
      todo: run.todo ?? null, execution: run.execution ?? null })),
    executionEvidence: existsSync(path.join(directory, 'process', 'execution-archive.json')) ? read(path.join(directory, 'process', 'execution-archive.json')) : null,
    parallelism: { childLifespanOverlapSec: overlapSeconds(intervals), ...nativeModelTiming(state.events), lockWait: nativeLockTiming(state.events),
      peakChildLifespans: peakConcurrency(intervals), peakRelayConnections: peakConcurrency(requestIntervals),
      relayConnectionOverlapSec: overlapSeconds(requestIntervals),
      writerActivity: metrics.parallelism, note: 'Model concurrency uses paired native calls; absent or incomplete events yield unknown. Relay connection occupancy is separate. Overlaps do not establish simultaneous useful work or speedup.' },
    acceptance: { requestsAfterLastChild: mainAfter.length, wallAfterLastChildSec: lastChild === null || !primary ? null : (millis(terminalAt(primary)) - lastChild) / 1000,
      credit: { knownSubtotal: mainAfter.reduce((sum, step) => sum + (finite(step.credit) ? step.credit : 0), 0), missingRequests: mainAfter.filter(step => !finite(step.credit)).length } },
    delivery: { checks, completeObserved: Object.values(checks).every(Boolean), git, finalText: state.finalTexts[primary?.id] ?? null,
      note: 'Observed conditions are not proof of complete semantic task compliance; inspect branch ancestry and requirement coverage separately.' },
    repeatedChecks: auditRepeatedChecks(state.calls, state.events), metrics, warnings: state.warnings };
}

export function comparisonVerdict(cells) {
  const baseline = cells.find(cell => cell.name === 'baseline'), optimized = cells.find(cell => cell.name === 'optimized');
  const complete = [baseline, optimized].every(cell => cell?.analysis?.delivery.completeObserved === true);
  const a = baseline?.analysis, b = optimized?.analysis;
  return { completeObserved: complete,
    wallReductionPercent: complete && finite(a.result.elapsedSec) && a.result.elapsedSec > 0 && finite(b.result.elapsedSec) ? 100 * (1 - b.result.elapsedSec / a.result.elapsedSec) : null,
    creditReductionPercent: complete && a.usage.credit.complete && b.usage.credit.complete && a.usage.credit.knownSubtotal > 0 ? 100 * (1 - b.usage.credit.knownSubtotal / a.usage.credit.knownSubtotal) : null,
    note: 'One sequential sample per build. No causal attribution, statistical significance or stable speed/quality advantage is established.' };
}

export async function analyzeComparison(root) {
  const matrix = read(path.join(root, 'matrix.json'));
  const cells = [];
  for (const cell of matrix.cells) {
    const directory = path.join(root, cell.name, 'fastapi-kodo');
    cells.push({ name: cell.name, status: cell.status, ...(existsSync(directory) ? { analysis: await analyzeComparisonCell(directory, cell.result) } : {}) });
  }
  return { generatedAt: new Date().toISOString(), cells, comparison: comparisonVerdict(cells) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node efficiency-analysis.mjs COMPARISON_DIRECTORY');
  const root = path.resolve(process.argv[2]);
  const report = await analyzeComparison(root);
  await writeFile(path.join(root, 'analysis.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ directory: root, comparison: report.comparison }) + '\n');
}
