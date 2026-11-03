// Golden-evaluation runner (docs/kodo-golden-eval-design-20261103.md §5, §7).
//
// Orchestration only:
//  - one fresh `state/` and `workspace/` copy per cell (case × repeat), one
//    loopback budget relay per paid cell, `--concurrency` cells in flight;
//  - `Application` default configuration (`new Application(stateDir, provider,
//    undefined, {})`), `createRun` with the case limits and
//    `finalResponse: 'required'`;
//  - grading pipeline after the model run: protected snapshot comparison →
//    restore → stage → command checks → scoring (score.mjs) and metrics
//    (metrics.mjs);
//  - registration.json before the first cell, progress.json around every cell,
//    whole-matrix stop on smoke failure / relay rejection / protected violation
//    / unreconciled usage / two consecutive provider-failure cells;
//  - --dry runs the whole pipeline with an offline scripted provider.
//
// Usage:
//   node scripts/golden/run.mjs --dry
//   node scripts/golden/run.mjs --run --provider-config test_api.json --provider codego1 \
//     --model deepseek-v4.1-flash --repeat 3 --concurrency 4 --out .kodo/golden/<stamp>
//   node scripts/golden/run.mjs --rescore .kodo/golden/<stamp>
//
// Only `--run` spends money; `--dry` never opens a network connection.

import console from 'node:console';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createBudgetRelay } from '../comparison/relay.mjs';
import { errorText, finalText, parseArgs, resolveCredentials, sha256, stamp, writeJson } from '../comparison/v3-eval-common.mjs';
import { protectedSnapshot, treeDigest, usageLedger } from '../comparison/v3-eval-ledger.mjs';
import { prepareOutput, parsePrices, writeRegistration } from '../comparison/v3-eval-matrix.mjs';
import { buildPlan, loadCases, loadCase } from './cases.mjs';
import { GoldenError, isGoldenError } from './errors.mjs';
import { runMetrics, summarize } from './metrics.mjs';
import { analyzePollution } from './pollution.mjs';
import { collectRequirements, compareProtected, evaluateRubric } from './score.mjs';
import { ensureDeliverableDir } from './workspace.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RELAY_KEY_ENV = 'KODO_GOLDEN_RELAY_KEY';
export const DRY_PROBE_FILE = '.golden-dry-probe.txt';
export const REGISTRATION = Object.freeze({
  id: 'kodo-golden-eval-r1-20261103',
  design: 'docs/kodo-golden-eval-design-20261103.md',
  schemaVersion: 1,
});
const DEFAULT_REPEATS = 3;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_CASES_DIR = 'eval/golden/cases';
const OPTIONS = {
  run: { kind: 'boolean', default: false },
  'dry-run': { kind: 'boolean', default: false },
  cases: { kind: 'list', default: [] },
  'cases-dir': { kind: 'string', default: DEFAULT_CASES_DIR },
  repeat: { kind: 'integer', default: undefined },
  repeats: { kind: 'integer', default: undefined },
  concurrency: { kind: 'integer', default: DEFAULT_CONCURRENCY },
  out: { kind: 'string', default: undefined },
  'provider-config': { kind: 'string', default: undefined },
  provider: { kind: 'string', default: 'codego1' },
  model: { kind: 'string', default: 'deepseek-v4.1-flash' },
  prices: { kind: 'string', default: undefined },
  seed: { kind: 'integer', default: undefined },
  'allow-unbuilt-dist': { kind: 'boolean', default: false },
};

// ---------------------------------------------------------------------------
// Small IO helpers.
// ---------------------------------------------------------------------------

function writeText(file, value, secret) {
  let text = JSON.stringify(value, null, 2);
  if (secret) text = text.replaceAll(secret, '[REDACTED]');
  writeFileSync(file, `${text}\n`, 'utf8');
}

const posix = value => value.replace(/\\/gu, '/');
const tail = (value, length) => {
  const text = String(value ?? '');
  return text.length <= length ? text : `…${text.slice(-length)}`;
};
const relativeTo = (root, target) => posix(path.relative(root, target));

function resolveInside(root, relativePath) {
  const normalized = String(relativePath ?? '').replace(/\\/gu, '/');
  const base = path.resolve(root);
  const target = path.resolve(base, normalized === '.' ? '' : normalized);
  if (target === base) return base;
  return target.startsWith(`${base}${path.sep}`) ? target : null;
}

function listWorkspaceFiles(workspace) {
  const files = [];
  const walk = (absolute, prefix) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(absolute, entry.name), next);
      else if (entry.isFile()) files.push(next);
    }
  };
  if (existsSync(workspace) && statSync(workspace).isDirectory()) walk(workspace, '');
  return files.sort();
}

const readWorkspaceText = (workspace, relativePath) => {
  const target = resolveInside(workspace, relativePath);
  if (!target) return null;
  try { return readFileSync(target, 'utf8'); } catch { return null; }
};

const statWorkspaceFile = (workspace, relativePath) => {
  const target = resolveInside(workspace, relativePath);
  if (!target) return null;
  try {
    const info = statSync(target);
    return info.isFile() ? { size: info.size } : null;
  } catch { return null; }
};

function readJsonFile(file, label, errorCode = 'RUN_IO') {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { throw new GoldenError(errorCode, `cannot read ${label}: ${error.message}`); }
  // Windows editors commonly add a UTF-8 BOM; hand-edited human.json must still parse.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try { return JSON.parse(text); }
  catch (error) { throw new GoldenError('RUN_JSON', `${label} is not valid JSON: ${error.message}`); }
}

function readHumanVerdicts(directory) {
  const file = path.join(directory, 'human.json');
  if (!existsSync(file)) return {};
  const parsed = readJsonFile(file, `${relativeTo(directory, file)} human.json`, 'HUMAN_JSON');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new GoldenError('HUMAN_JSON', `${file} must contain an object like {"H1": true}`);
  const verdicts = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') verdicts[id] = value;
    else if (value !== null && value !== undefined) throw new GoldenError('HUMAN_JSON', `${file} verdict for ${id} must be true, false or omitted`);
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// Matrix state, progress and stop rules.
// ---------------------------------------------------------------------------

function progressRecord(context, state, finished = false) {
  const results = state.results.filter(Boolean).map(report => ({
    key: report.key, caseId: report.caseId, repeat: report.repeat, status: report.status,
    passed: report.passed, score: report.score?.score ?? null, humanPending: Boolean(report.humanPending),
    polluted: Boolean(report.polluted), usageComplete: report.metrics?.usageComplete === true,
  }));
  const done = new Set(results.map(result => result.key));
  const stateName = finished ? (state.stop ? 'stopped' : 'finished') : state.stop ? 'stopping' : 'running';
  return {
    state: stateName,
    running: [...state.running],
    stop: state.stop,
    completed: results.map(result => result.key),
    notStarted: context.plan.filter(entry => !done.has(entry.key) && !state.running.has(entry.key)).map(entry => entry.key),
    results,
  };
}

function publishProgress(context, state, finished = false) {
  writeText(path.join(context.outRoot, 'progress.json'), progressRecord(context, state, finished), context.credentials?.key);
}

/** Relay rejection codes that the kernel already retries; they abort nothing by themselves. */
const TRANSIENT_RELAY_REJECTIONS = new Set(['UPSTREAM_TRANSPORT', 'CLIENT_ABORTED']);

/** §7: stop the whole matrix on a fatal cell. Ordinary task failures are results, not stops. */
export function fatalReason(context, state) {
  const { plan } = context;
  // Plan-order prefix of completed cells; concurrency may complete later cells out of order.
  const prefix = [];
  for (let index = 0; index < plan.length; index++) {
    const report = state.results[index];
    if (!report) break;
    prefix.push(report);
  }
  for (const report of prefix) {
    // Budget/config rejections are fatal (a rerun needs a different setup), but a
    // transient upstream transport failure is retried by the kernel (minute-scale
    // backoff) and the cell can still complete; it stays a provider failure, not a
    // reason to abandon the matrix.
    const fatalRejections = (report.relay?.rejected ?? []).filter(code => !TRANSIENT_RELAY_REJECTIONS.has(code));
    if (fatalRejections.length) return `RELAY_REJECTED: ${fatalRejections.join(', ')}`;
    if (report.protected && report.protected.ok === false) return 'PROTECTED_VIOLATION';
    if (report.metrics?.usageComplete === false) {
      // An unknown-usage call is explained when it corresponds to a recorded
      // provider failure (a retried transport error leaves one such attempt).
      // Only unresolved missing usage is an accounting hole worth stopping for.
      const excused = Math.max(report.metrics.agentCancelledUnknown ?? 0, report.pollution?.excused?.length ?? 0) + (report.metrics.providerFailures ?? 0);
      if ((report.metrics.unknownCalls ?? 0) > excused) return 'USAGE_UNRECONCILED';
    }
  }
  const trailing = prefix.slice(-2);
  if (trailing.length === 2 && trailing.every(report => report.status !== 'completed' && (report.metrics?.providerFailures ?? 0) > 0)) return 'PROVIDER_FAILURES';
  return null;
}

/** §7 smoke gate: the first cell of the matrix must prove the harness worked at all. */
function smokeFailure(caseData, report) {
  const smoke = caseData.smoke;
  const modelCalls = report.metrics?.modelCalls ?? 0;
  const toolCalls = report.metrics?.toolCalls ?? 0;
  if (modelCalls < smoke.minModelCalls) return `modelCalls ${modelCalls} < ${smoke.minModelCalls}`;
  if (toolCalls < smoke.minToolCalls) return `toolCalls ${toolCalls} < ${smoke.minToolCalls}`;
  const eventTypes = Object.keys(report.eventCounts ?? {});
  for (const prefix of smoke.requireEventPrefixes) {
    const count = eventTypes.filter(type => type.startsWith(prefix)).reduce((total, type) => total + report.eventCounts[type], 0);
    if (!count) return `event prefix ${prefix} never fired`;
  }
  return null;
}

/** Offline scripted provider for --dry: one successful file.read, then a final answer. */
function dryProvider(caseData) {
  return {
    async complete(request) {
      const usage = { input: 1_000, output: 40 };
      const alreadyRead = request.messages.some(message => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length);
      if (!alreadyRead) {
        return {
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'dry-read-1', name: 'file.read', arguments: JSON.stringify({ path: DRY_PROBE_FILE }) }] },
          finishReason: 'tool_calls', usage,
        };
      }
      // Keep the scripted reply free of real task work: dry runs prove plumbing, not quality.
      return {
        message: { role: 'assistant', content: `Dry run of ${caseData.id}: offline scripted provider, no task work attempted.` },
        finishReason: 'stop', usage,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence collection: events, reads, relay wire, commands, grading.
// ---------------------------------------------------------------------------

function collectEventCounts(store, sessionId) {
  const counts = {};
  for (const run of store.listRuns(sessionId)) {
    for (const event of store.events(run.id)) counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function collectReads(store, sessionId) {
  const runs = store.listRuns(sessionId);
  const eventsByRun = new Map();
  const callsByRun = new Map();
  const startedSeq = new Map();
  for (const run of runs) {
    const events = store.events(run.id);
    eventsByRun.set(run.id, events);
    callsByRun.set(run.id, store.calls(run.id));
    for (const event of events) {
      if (event.type === 'tool.started' && event.data?.callId !== undefined) startedSeq.set(`${run.id}:${event.data.callId}`, event.seq);
    }
  }
  const readPath = call => {
    try {
      const blob = call.requestRef ? store.readBlob(call.requestRef) : undefined;
      return JSON.parse(blob?.arguments ?? '{}').path;
    } catch { return undefined; }
  };
  const readsFor = runId => (callsByRun.get(runId) ?? [])
    .filter(call => call.kind === 'tool' && call.name === 'file.read')
    .map(call => ({ path: readPath(call), seq: startedSeq.get(`${runId}:${call.id}`) }))
    .filter(read => typeof read.path === 'string');
  const mainRuns = runs.filter(run => !run.parentId).map(run => ({ reads: readsFor(run.id) }));
  const childRuns = runs.filter(run => run.parentId).map(run => {
    const events = eventsByRun.get(run.id) ?? [];
    const sequences = events.map(event => event.seq).filter(Number.isSafeInteger);
    return { reads: readsFor(run.id), startSeq: sequences.length ? Math.min(...sequences) : undefined };
  });
  return { mainRuns, childRuns };
}

function readWireEvidence(wireDirectory, calls) {
  const requests = [];
  const responses = [];
  if (!existsSync(wireDirectory)) return { requests, responses };
  for (const name of readdirSync(wireDirectory)) {
    const requestMatch = /^request-(\d+)\.json$/u.exec(name);
    if (requestMatch) {
      const body = readJsonFile(path.join(wireDirectory, name), `wire/${name}`, 'WIRE_JSON');
      requests.push({ index: Number(requestMatch[1]), model: typeof body?.model === 'string' ? body.model : undefined });
      continue;
    }
    const responseMatch = /^response-(\d+)\.sse$/u.exec(name);
    if (responseMatch) responses.push({ index: Number(responseMatch[1]), text: readFileSync(path.join(wireDirectory, name), 'utf8') });
  }
  // A relay call without a request file means the wire record is incomplete.
  for (const call of calls) {
    if (!requests.some(request => request.index === call.index)) requests.push({ index: call.index, model: undefined, present: false });
  }
  return { requests, responses };
}

function executeCommand(params, workspace, caseDir) {
  const cwd = params.cwd ? resolveInside(workspace, params.cwd) : workspace;
  if (!cwd) throw new GoldenError('GRADING_COMMAND', `command cwd ${params.cwd} escapes the workspace`);
  if (!existsSync(cwd)) throw new GoldenError('GRADING_COMMAND', `command cwd does not exist after restore/stage: ${params.cwd}`);
  const timeoutMs = params.timeoutMs ?? 600_000;
  const args = params.args ?? [];
  const environment = { ...process.env, GOLDEN_CASE_DIR: caseDir, GOLDEN_VERIFY_DIR: path.join(caseDir, 'verify') };
  const spawn = (program) => spawnSync(program, args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: false, env: environment, maxBuffer: 64 * 1024 * 1024 });
  const startedAt = Date.now();
  let result = spawn(params.program);
  let usedProgram = params.program;
  if ((params.program === 'node' || params.program === 'node.exe') && result.error?.code === 'ENOENT') {
    usedProgram = process.execPath;
    result = spawn(usedProgram);
  }
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  return {
    program: params.program, usedProgram, args,
    exitCode: Number.isSafeInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT' || Boolean(result.error && result.signal === 'SIGTERM' && !Number.isSafeInteger(result.status)),
    durationMs: Date.now() - startedAt,
    stdout: tail(stdout, 4_000), stderr: tail(stderr, 4_000),
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'), stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    truncated: stdout.length > 4_000 || stderr.length > 4_000,
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

/**
 * §3.1 grading pipeline, after the model run and the protected comparison:
 * restore case-workspace files first, then stage held-out verification assets.
 * Without an explicit `grading.stage`, a case `verify/` directory is staged at
 * `workspace/verify/` so command checks can reference it (it is never visible to
 * the model during its run).
 */
function applyGrading({ caseData, caseDir, caseWorkspace, verifyDir, workspace }) {
  const restored = [];
  const staged = [];
  for (const relativePath of caseData.grading.restore) {
    if (relativePath === '.') throw new GoldenError('GRADING_RESTORE', 'grading.restore must not target the workspace root');
    const source = path.join(caseWorkspace, relativePath);
    if (!existsSync(source)) throw new GoldenError('GRADING_RESTORE', `grading.restore path ${relativePath} is missing from the case workspace`);
    const target = path.join(workspace, relativePath);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
    restored.push(relativePath);
  }
  const stages = caseData.grading.stage.length
    ? caseData.grading.stage
    : verifyDir ? [{ from: 'verify', to: 'verify' }] : [];
  for (const stage of stages) {
    if (stage.to === '.') throw new GoldenError('GRADING_STAGE', 'grading.stage must not target the workspace root');
    const source = path.join(caseDir, stage.from);
    if (!existsSync(source)) throw new GoldenError('GRADING_STAGE', `grading.stage source ${stage.from} is missing under ${caseDir}`);
    const target = path.join(workspace, stage.to);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
    staged.push({ from: stage.from, to: stage.to });
  }
  return { restored, staged };
}

// ---------------------------------------------------------------------------
// One cell.
// ---------------------------------------------------------------------------

async function runCell(entry, context) {
  const { caseData, workspaceDir, caseDir, verifyDir } = entry.case;
  const limits = caseData.limits;
  const directory = path.join(context.outRoot, 'runs', caseData.id, `r${entry.repeat}`);
  mkdirSync(directory, { recursive: true });
  const workspace = path.join(directory, 'workspace');
  const stateDir = path.join(directory, 'state');
  const wireDirectory = path.join(directory, 'wire');
  for (const target of [stateDir, wireDirectory]) mkdirSync(target, { recursive: true });
  cpSync(workspaceDir, workspace, { recursive: true });
  // The task prompt points the model at case.deliverableDir; git cannot carry an empty
  // directory, so make sure it exists in every seeded workspace.
  ensureDeliverableDir(workspace, caseData.deliverableDir);
  if (!context.cli.run) writeFileSync(path.join(workspace, DRY_PROBE_FILE), 'golden dry-run probe: the scripted provider reads this file\n', 'utf8');
  const model = context.model;
  let relay = null;
  let binding;
  if (context.cli.run) {
    relay = await createBudgetRelay({
      directory: wireDirectory,
      upstream: context.credentials.upstream,
      key: context.credentials.key,
      model,
      maxCalls: limits.maxModelCalls,
      maxTokens: limits.maxTokens,
      maxOutputTokens: limits.maxOutputTokens,
      maxContextChars: Number.MAX_SAFE_INTEGER,
      cacheReadCostPercent: 100,
      unrestricted: false,
    });
    binding = {
      protocol: 'chat-completions', model, baseURL: relay.baseURL, apiKeyEnv: RELAY_KEY_ENV,
      limits: { context: limits.contextTokens, output: limits.outputTokens },
    };
  } else {
    binding = {
      protocol: 'chat-completions', model, baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: RELAY_KEY_ENV,
      limits: { context: limits.contextTokens, output: limits.outputTokens },
    };
  }
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const provider = context.cli.run ? new context.ModelProvider() : dryProvider(caseData);
  // Contract §5: default configuration, no experimental switches.
  const app = new context.Application(stateDir, provider, undefined, {});
  let runId = null;
  let runError = null;
  try {
    const run = app.createRun({
      objective: caseData.objective,
      workspace,
      binding,
      permissions: caseData.permissions,
      budget: {
        maxContextTokens: limits.contextTokens,
        maxOutputTokens: limits.maxOutputTokens,
        maxModelCalls: limits.maxModelCalls,
        maxTokens: limits.maxTokens,
        maxToolCalls: limits.maxToolCalls,
        maxDurationMs: limits.maxDurationMs,
      },
      finalResponse: 'required',
    });
    runId = run.id;
    await app.run(runId).catch(error => {
      runError = errorText(error);
      return app.store.run(runId);
    });
  } catch (error) {
    await app.shutdown().catch(() => {});
    if (relay) await relay.close().catch(() => {});
    throw new GoldenError('RUN_SETUP', `case ${entry.key} could not start: ${errorText(error)}`);
  }
  const elapsedMs = Date.now() - startedMs;
  // Collect persisted evidence while the store is still open; Application.shutdown()
  // closes the store, so nothing may read it afterwards.
  const storedRun = app.store.run(runId);
  const sessionId = storedRun.sessionId;
  const ledger = usageLedger(app.store, sessionId);
  const reply = finalText(app.store, app.store.run(runId));
  const eventCounts = collectEventCounts(app.store, sessionId);
  const reads = collectReads(app.store, sessionId);
  await app.shutdown().catch(error => { runError ??= `shutdown: ${errorText(error)}`; });
  if (relay) await relay.close();
  const relayStats = relay
    ? {
        requests: relay.stats.requests, tokens: relay.stats.tokens, rejected: relay.stats.rejected,
        estimated: relay.stats.estimated, unmeasured: relay.stats.unmeasured, clientAborted: relay.stats.clientAborted,
        calls: relay.stats.calls,
      }
    : { requests: 0, tokens: 0, rejected: [], estimated: false, unmeasured: 0, clientAborted: 0, calls: [] };
  const pollution = analyzePollution(readWireEvidence(wireDirectory, relayStats.calls));
  const metrics = runMetrics({ ledger, relay: relayStats, reads, prices: context.prices });
  metrics.agentCancelledUnknown = ledger.agentCancelledUnknown ?? 0;

  // §3.1: compare protected paths before restore/stage replace the model's evidence.
  const requirements = context.caseRequirements.get(caseData.id);
  const protectedResults = {};
  for (const requirement of requirements.protectedChecks) {
    const seedSnapshot = protectedSnapshot(workspaceDir, requirement.paths);
    const runSnapshot = protectedSnapshot(workspace, requirement.paths);
    protectedResults[requirement.id] = compareProtected(seedSnapshot, runSnapshot, requirement.ignore ?? []);
  }
  const grading = applyGrading({ caseData, caseDir, caseWorkspace: workspaceDir, verifyDir, workspace });

  // Command checks run after restore/stage, declaration order (rules then checks),
  // so a producer command can feed the file checks that follow it.
  const commandResults = {};
  for (const requirement of requirements.commands) commandResults[requirement.id] = executeCommand(requirement.params, workspace, caseDir);

  const human = readHumanVerdicts(directory);
  const score = evaluateRubric({
    rubric: context.caseRubrics.get(caseData.id),
    caseData,
    finalText: reply,
    human,
    protectedResults,
    commandResults,
    readFile: relativePath => readWorkspaceText(workspace, relativePath),
    listFiles: () => listWorkspaceFiles(workspace),
    statFile: relativePath => statWorkspaceFile(workspace, relativePath),
  });

  const report = {
    key: entry.key,
    schemaVersion: 1,
    caseId: caseData.id,
    category: caseData.category,
    title: caseData.title,
    repeat: entry.repeat,
    model,
    mode: context.cli.run ? 'paid' : 'dry-run',
    status: storedRun.status,
    error: runError ?? storedRun.error ?? null,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs,
    permissions: caseData.permissions,
    budget: limits,
    workspace: relativeTo(context.outRoot, workspace),
    state: relativeTo(context.outRoot, stateDir),
    wire: relativeTo(context.outRoot, wireDirectory),
    metrics,
    relay: {
      requests: relayStats.requests, tokens: relayStats.tokens, rejected: relayStats.rejected,
      unmeasured: relayStats.unmeasured, clientAborted: relayStats.clientAborted, estimated: relayStats.estimated,
    },
    polluted: pollution.polluted,
    pollution: {
      polluted: pollution.polluted,
      reasons: pollution.reasons,
      excused: pollution.excused,
      counts: pollution.counts,
    },
    protected: {
      ok: Object.values(protectedResults).every(result => result.ok),
      items: protectedResults,
    },
    grading,
    eventCounts,
    commandResults: Object.fromEntries(Object.entries(commandResults).map(([id, result]) => [id, {
      program: result.program, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs,
      stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, error: result.error,
    }])),
    humanVerdicts: human,
    score,
    passed: score.passed,
    humanPending: score.humanPending,
    // Evidence needed to rescore later (after human.json is filled in) without rerunning.
    scoring: { finalText: reply, protectedResults, commandResults },
  };
  report.smoke = { ok: !smokeFailure(caseData, report), failure: smokeFailure(caseData, report) };
  await writeJson(path.join(directory, 'report.json'), report, context.credentials?.key);
  return report;
}

// ---------------------------------------------------------------------------
// Matrix execution.
// ---------------------------------------------------------------------------

async function runMatrix(context) {
  const { plan, concurrency } = context;
  const state = { results: new Array(plan.length), next: 1, stop: null, running: new Set() };
  process.once('SIGINT', () => {
    state.stop ??= { reason: 'INTERRUPTED', at: state.running.values().next().value ?? null, interrupted: [] };
    console.error('SIGINT: no new cells will start; waiting for the running cells to settle');
  });
  publishProgress(context, state);

  // The first cell of the plan is the smoke gate and runs alone (§7).
  let firstReport = null;
  state.running.add(plan[0].key);
  publishProgress(context, state);
  try {
    firstReport = await runCell(plan[0], context);
  } catch (error) {
    state.stop = { reason: `CELL_ERROR: ${errorText(error)}`, at: plan[0].key, interrupted: [plan[0].key], infrastructure: true };
  }
  state.running.delete(plan[0].key);
  if (firstReport) {
    state.results[0] = firstReport;
    const failure = smokeFailure(plan[0].case.caseData, firstReport);
    if (failure) state.stop ??= { reason: 'SMOKE_ABORT', at: plan[0].key, detail: failure, interrupted: [] };
  }
  publishProgress(context, state);
  if (!state.stop) state.stop = fatalReason(context, state);
  if (state.stop) {
    publishProgress(context, state, true);
    return { state };
  }

  const worker = async () => {
    while (!state.stop) {
      const index = state.next++;
      if (index >= plan.length) return;
      const entry = plan[index];
      state.running.add(entry.key);
      publishProgress(context, state);
      let report;
      try {
        report = await runCell(entry, context);
      } catch (error) {
        state.stop ??= { reason: `CELL_ERROR: ${errorText(error)}`, at: entry.key, interrupted: [entry.key], infrastructure: true };
        state.running.delete(entry.key);
        publishProgress(context, state);
        return;
      }
      state.results[index] = report;
      state.running.delete(entry.key);
      const fatal = fatalReason(context, state);
      if (fatal) state.stop ??= { reason: fatal, at: entry.key, interrupted: [] };
      publishProgress(context, state);
    }
  };
  const workers = [];
  const width = Math.max(1, Math.min(concurrency, plan.length - 1));
  for (let index = 0; index < width; index++) workers.push(worker());
  await Promise.all(workers);
  publishProgress(context, state, true);
  return { state };
}

// ---------------------------------------------------------------------------
// Rescore: recompute scores and summary from stored evidence after human.json.
// ---------------------------------------------------------------------------

async function rescore(outRoot) {
  const registration = readJsonFile(path.join(outRoot, 'registration.json'), 'registration.json');
  const storedCases = registration?.registration?.cases;
  if (!Array.isArray(storedCases)) throw new GoldenError('RESCORE', `${outRoot}/registration.json has no registration.cases list`);
  const loadedCases = new Map();
  for (const stored of storedCases) {
    const directory = path.resolve(repoRoot, stored.caseDir ?? path.join(DEFAULT_CASES_DIR, stored.id));
    const loaded = loadCase(directory);
    loadedCases.set(loaded.id, loaded);
  }
  const reports = [];
  for (const stored of storedCases) {
    const caseRuns = path.join(outRoot, 'runs', stored.id);
    if (!existsSync(caseRuns)) continue;
    for (const runDirectory of readdirSync(caseRuns, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
      const reportFile = path.join(caseRuns, runDirectory, 'report.json');
      if (!existsSync(reportFile)) continue;
      const report = readJsonFile(reportFile, `${stored.id}/${runDirectory}/report.json`);
      const loaded = loadedCases.get(report.caseId);
      if (!loaded) throw new GoldenError('RESCORE', `report ${reportFile} refers to unknown case ${report.caseId}`);
      const workspace = path.resolve(outRoot, report.workspace ?? path.join('runs', report.caseId, runDirectory, 'workspace'));
      const human = readHumanVerdicts(path.dirname(reportFile));
      const score = evaluateRubric({
        rubric: loaded.rubric,
        caseData: loaded.caseData,
        finalText: report.scoring?.finalText ?? '',
        human,
        protectedResults: report.scoring?.protectedResults ?? {},
        commandResults: report.scoring?.commandResults ?? {},
        readFile: relativePath => readWorkspaceText(workspace, relativePath),
        listFiles: () => listWorkspaceFiles(workspace),
        statFile: relativePath => statWorkspaceFile(workspace, relativePath),
      });
      report.score = score;
      report.passed = score.passed;
      report.humanPending = score.humanPending;
      report.humanVerdicts = human;
      report.rescoredAt = new Date().toISOString();
      writeText(reportFile, report);
      reports.push(report);
    }
  }
  const summaryFile = path.join(outRoot, 'summary.json');
  const previous = existsSync(summaryFile) ? readJsonFile(summaryFile, 'summary.json') : {};
  const summary = {
    ...previous,
    ...summarize(reports, {
      plan: previous.plan ?? reports.map(report => report.key),
      stop: previous.stop ?? null,
      prices: previous.prices ?? null,
      mode: previous.mode ?? null,
      model: previous.model ?? null,
    }),
    rescoredAt: new Date().toISOString(),
  };
  summary.plan = previous.plan ?? reports.map(report => report.key);
  writeText(summaryFile, summary);
  console.log(JSON.stringify({ rescored: outRoot, overall: summary.overall, cases: summary.cases, humanPendingCells: summary.humanPendingCells }, null, 2));
  return summary;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function normalizeArgv(argv) {
  return argv.map(argument => (argument === '--dry' ? '--dry-run' : argument));
}

function resolveRepeat(cli) {
  if (cli.repeat !== undefined && cli.repeats !== undefined && cli.repeat !== cli.repeats) throw new GoldenError('CLI', '--repeat and --repeats disagree');
  const repeats = cli.repeat ?? cli.repeats ?? DEFAULT_REPEATS;
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new GoldenError('CLI', '--repeat must be a positive integer');
  return repeats;
}

function resolveConcurrency(cli) {
  if (!Number.isSafeInteger(cli.concurrency) || cli.concurrency < 1) throw new GoldenError('CLI', '--concurrency must be a positive integer');
  return cli.concurrency;
}

const USAGE = `Kodo golden evaluation runner

  node scripts/golden/run.mjs --dry [--cases a,b] [--repeat 3] [--concurrency 4] [--out DIR]
      Offline plumbing check with a scripted provider: no network, no API key. Scores are
      expected to fail; the matrix, grading pipeline and summary must complete.

  node scripts/golden/run.mjs --run --provider-config test_api.json --provider codego1 \\
      --model deepseek-v4.1-flash [--cases a,b] [--repeat 3] [--concurrency 4] \\
      [--prices input,cacheRead,output[,cacheWrite]] [--seed N] [--out DIR] [--allow-unbuilt-dist]
      Paid matrix: the real key only reaches the per-cell loopback relay.

  node scripts/golden/run.mjs --rescore .kodo/golden/<stamp>
      Recompute scores and summary from stored evidence after editing
      runs/<case-id>/r<n>/human.json.

Options:
  --cases a,b          comma-separated case ids (default: every case under --cases-dir)
  --cases-dir DIR      cases root (default: ${DEFAULT_CASES_DIR})
  --repeat N           repeats per case (default ${DEFAULT_REPEATS}; --repeats is an alias)
  --concurrency N      cells in flight (default ${DEFAULT_CONCURRENCY})
  --out DIR            output root (default: .kodo/golden/<stamp>; must be new or empty)
  --model ID           bound model id (default deepseek-v4.1-flash)
  --provider ID        provider-config key (default codego1)
  --provider-config F  credentials file ({provider:{<id>:{options:{apiKey,baseURL}}}})
  --prices ...         per-million-token prices; switches cost basis to "price"
  --seed N             deterministic shuffle of case order inside each repeat
  --allow-unbuilt-dist skip the dist/src build-manifest check
  --help               print this help
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  // --rescore is a standalone maintenance mode: it never starts a matrix and does not
  // require --run/--dry, so it is handled before the matrix option check.
  const rescoreIndex = argv.findIndex(argument => argument === '--rescore' || argument.startsWith('--rescore='));
  if (rescoreIndex >= 0) {
    const argument = argv[rescoreIndex];
    const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[rescoreIndex + 1];
    if (!value) throw new GoldenError('CLI', '--rescore requires an output directory');
    const outRoot = path.resolve(repoRoot, value);
    if (!existsSync(path.join(outRoot, 'registration.json'))) throw new GoldenError('RESCORE', `${outRoot} has no registration.json`);
    await rescore(outRoot);
    return;
  }
  const cli = parseArgs(normalizeArgv(argv), OPTIONS);
  const repeat = resolveRepeat(cli);
  const concurrency = resolveConcurrency(cli);

  const casesRoot = path.resolve(repoRoot, cli['cases-dir']);
  const allCases = loadCases(casesRoot);
  let selected = allCases;
  if (cli.cases.length) {
    const byId = new Map(allCases.map(item => [item.id, item]));
    selected = cli.cases.map(id => {
      const item = byId.get(id);
      if (!item) throw new GoldenError('CLI', `unknown case ${id}; available: ${allCases.map(candidate => candidate.id).join(', ')}`);
      return item;
    });
    if (new Set(selected.map(item => item.id)).size !== selected.length) throw new GoldenError('CLI', '--cases lists a case twice');
  }
  const prices = (() => {
    if (!cli.prices) return null;
    try { return parsePrices(cli.prices); }
    catch (error) { throw new GoldenError('CLI', errorText(error)); }
  })();

  const mode = cli.run ? 'paid' : 'dry-run';
  const credentials = cli.run ? await resolveCredentials({ providerConfig: cli['provider-config'], provider: cli.provider }) : null;
  process.env[RELAY_KEY_ENV] = cli.run ? 'golden-loopback-relay-placeholder' : 'golden-dry-unused';
  const outRoot = path.resolve(repoRoot, cli.out ?? path.join('.kodo', 'golden', stamp()));
  prepareOutput(outRoot);
  const plan = buildPlan(selected, { repeats: repeat, seed: cli.seed });

  const fixtures = {};
  const caseSummaries = [];
  for (const item of selected) {
    const caseDigest = treeDigest(item.caseDir);
    const workspaceDigest = treeDigest(item.workspaceDir);
    fixtures[item.id] = { case: caseDigest, workspace: workspaceDigest, rubric: sha256(JSON.stringify(item.rubric)) };
    caseSummaries.push({
      id: item.id, category: item.caseData.category, title: item.caseData.title,
      caseDir: relativeTo(repoRoot, item.caseDir),
      workspace: relativeTo(repoRoot, item.workspaceDir),
      limits: item.caseData.limits,
      permissions: item.caseData.permissions,
      smoke: item.caseData.smoke,
      grading: item.caseData.grading,
      checks: item.rubric.checks.map(check => ({ id: check.id, kind: check.kind, weight: check.weight })),
      rules: item.rubric.rules.map(rule => ({ id: rule.id, kind: rule.kind })),
      passThreshold: item.rubric.passThreshold,
      digests: fixtures[item.id],
    });
  }
  const registration = {
    ...REGISTRATION,
    mode,
    model: cli.model,
    provider: cli.run ? cli.provider : null,
    providerHost: credentials?.host ?? null,
    prices,
    repeats: repeat,
    concurrency,
    seed: cli.seed ?? null,
    casesRoot: relativeTo(repoRoot, casesRoot),
    cases: caseSummaries,
    plan: plan.map(entry => entry.key),
  };
  const settings = {
    run: cli.run, dry: !cli.run, cases: cli.cases, casesDir: cli['cases-dir'], repeat, concurrency,
    out: cli.out ?? null, providerConfig: cli['provider-config'] ?? null, provider: cli.provider,
    model: cli.model, prices: cli.prices ?? null, seed: cli.seed ?? null,
    allowUnbuiltDist: cli['allow-unbuilt-dist'], mode, providerHost: credentials?.host ?? null,
  };
  const registrationDigest = writeRegistration(outRoot, {
    registration, plan: plan.map(entry => entry.key), settings, fixtures, repoRoot,
    // Dry runs are allowed against a stale dist (they only exercise plumbing); paid runs are not.
    requireBuild: cli.run && !cli['allow-unbuilt-dist'],
  });

  // Application/ModelProvider are imported only for a real matrix, so score/metrics
  // unit tests can load this file without a built dist/.
  const { Application, ModelProvider } = await import('../../dist/application/index.js');
  const context = {
    outRoot, plan, cli, concurrency, credentials, model: cli.model, prices, Application, ModelProvider,
    caseRequirements: new Map(selected.map(item => [item.id, collectRequirements(item.rubric)])),
    caseRubrics: new Map(selected.map(item => [item.id, item.rubric])),
  };
  for (const item of selected) if (!existsSync(item.workspaceDir)) throw new GoldenError('CASE_IO', `case ${item.id} is missing workspace/`);
  console.error(`golden ${mode}: ${plan.length} cells (${selected.length} cases x ${repeat} repeats, concurrency ${concurrency}) -> ${outRoot}`);
  const { state } = await runMatrix(context);

  const reports = state.results.filter(Boolean);
  const summary = {
    registration: REGISTRATION,
    registrationDigest,
    mode,
    model: cli.model,
    provider: cli.run ? cli.provider : null,
    providerHost: credentials?.host ?? null,
    prices,
    out: relativeTo(repoRoot, outRoot),
    plan: plan.map(entry => entry.key),
    stop: state.stop,
    ...summarize(reports, { plan: plan.map(entry => entry.key), stop: state.stop, prices, mode, model: cli.model }),
  };
  await writeJson(path.join(outRoot, 'summary.json'), summary, credentials?.key);
  console.log(JSON.stringify({
    out: outRoot,
    mode,
    outRelative: relativeTo(repoRoot, outRoot),
    stop: state.stop,
    matrixState: summary.matrixState,
    overall: summary.overall,
    cases: summary.cases,
    pollutedCells: summary.pollutedCells,
    humanPendingCells: summary.humanPendingCells,
  }, null, 2));
  // §7: an evaluation-infrastructure error aborts with a non-zero exit; it is never a sample failure.
  if (state.stop?.infrastructure) throw new GoldenError('CELL_INFRASTRUCTURE', state.stop.reason);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(isGoldenError(error) ? error.message : errorText(error));
    process.exitCode = 1;
  });
}
