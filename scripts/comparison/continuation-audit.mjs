// Independent, zero-cost auditor for the §9B minimal real-continuation check.
//
// It audits one paid output directory produced by
// scripts/comparison/compaction-continuation.mjs (--run) WITHOUT trusting the
// runner's report.json:
//   * every protected file in the post-run workspace is re-hashed from the
//     pre-registered protected list and compared with the seed hash map,
//   * the post-run workspace is copied to the OS temp directory and
//     `node verify.mjs` is run there (never in the evidence directory),
//   * run status/result, summary events, installed envelope budgets, marker
//     token sizes, model/tool calls, usage, model failures and relay stats are
//     re-extracted from the Kodo state database (node:sqlite, read-only, on an
//     immutable temp copy) and wire/relay.json,
//   * the independent numbers are reconciled against report.json and any
//     disagreement is recorded (material = acceptance-integrity conflict).
//
// It never calls a model or provider, never opens a network connection and
// never writes inside the audited output directory. Machine-readable output goes
// to `.kodo/continuation-audit-<timestamp>/audit.json`.
//
// Classification follows the frozen pre-registration in
// scripts/comparison/continuation/README.md:
//   structural = run completed, installs >= expectedMinCompactions, no
//                deterministic SUMMARY_* code, protected file set/hashes
//                unchanged, no relay rejection and no model/transport failure;
//   quality    = independent verify exits 0 AND the frozen legacy constraint is
//                retained (src/pager.mjs imports ./legacy.js and clamps to 37,
//                docs/legacy-contract.md unchanged).
// The final answer naming the frozen limit is an OBSERVATION, never pass/fail.
//
// Exit codes: 0 structural expectations independently confirmed; 1 structural
// expectations NOT confirmed; 2 audit setup/usage error. Quality failures are
// recorded separately and do not make the audit exit non-zero on their own.
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import console from 'node:console';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';
import { classifyContinuationOutcome } from './continuation/outcomes.mjs';
import { CONTINUATION_PROTOCOL_VERSION, registeredTasks } from './continuation/registration.mjs';

// Keep stdout/stderr clean: node:sqlite prints an ExperimentalWarning on first
// use. This audit has its own explicit error reporting, so process warnings are
// suppressed for the run; node:sqlite is imported dynamically afterwards so the
// experimental flag is honoured.
process.removeAllListeners('warning');
process.emitWarning = () => {};
let DatabaseSync = null;
let sqliteModuleError = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (error) {
  sqliteModuleError = error instanceof Error ? error.message : String(error);
}

const AUDITOR_VERSION = 'continuation-audit-v2.1';
const REPOSITORY = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE_MODULE = './continuation/fixtures.mjs';
const ARTIFACT_PREFIX = '.kodo';

// ---------------------------------------------------------------------------
// Frozen pre-registration constants, duplicated here on purpose: the audit must
// not inherit its acceptance windows from report.json or from the runner.
// Source: scripts/comparison/continuation/README.md §2, §4, §5, §9.
// ---------------------------------------------------------------------------
const REGISTERED = registeredTasks;
const PROTECTED_ENTRIES = Object.freeze(['verify.mjs', 'docs', 'src/legacy.js']);
const VERIFY_COMMAND = Object.freeze(['node', 'verify.mjs']);
const DETERMINISTIC_SUMMARY_CODES = Object.freeze([
  'SUMMARY_STRUCTURE', 'SUMMARY_BUDGET', 'SUMMARY_SOURCE', 'SUMMARY_INJECTION_BUDGET',
  'SUMMARY_INSTALL', 'SUMMARY_PARSE', 'SUMMARY_MESSAGE', 'SUMMARY_NO_GAIN',
]);
const SUMMARY_EVENT_TYPES = Object.freeze([
  'context.compacted', 'context.summary.started', 'context.summary.installed',
  'context.summary.failed', 'context.summary.skipped', 'context.summary.truncated',
  'context.summary.discarded', 'context.summary.repair.started',
  'context.summary.repair.completed', 'context.summary.repair.failed',
]);
const MODEL_TRANSPORT_PREFIXES = Object.freeze(['MODEL_TRANSPORT', 'MODEL_RATE_LIMIT', 'MODEL_INCOMPLETE', 'MODEL_PROTOCOL', 'MODEL_LLM']);
const MODEL_COMPLETION_PATTERN = /^MODEL_[A-Z_]+/;
const FROZEN_PAGE_LIMIT = 37;
const FROZEN_PAGE_DEFAULT = 10;
const FROZEN_CONTRACT_PATH = 'docs/legacy-contract.md';
const FROZEN_LEGACY_SOURCE_PATH = 'src/legacy.js';
const PAGER_PATH = 'src/pager.mjs';
const VERIFY_TIMEOUT_MS = 120_000;
const RESULT_TEXT_MAX_CHARS = 8000;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
class CliError extends Error {}

function printUsage(stream = process.stderr) {
  const lines = [
    'Usage: node scripts/comparison/continuation-audit.mjs --out <paid output dir> [options]',
    '',
    'Independent zero-cost audit of a compaction-continuation run. No model or network call is',
    'made and nothing is written inside --out. Machine-readable result goes to a separate',
    '`.kodo/continuation-audit-<timestamp>/audit.json` directory.',
    '',
    'Options:',
    '  --out <dir>            runner output root to audit (required; e.g. .kodo/continuation-paid-20261024-a)',
    '  --audit-dir <dir>      where audit.json is written (default .kodo/continuation-audit-<timestamp>)',
    '  --tasks a|b|both       fixtures expected in the output root (default: both)',
    '  --expect-mode auto|run|dry-run   expected evidence mode (default: auto, inferred from relay.json)',
    '  --keep-temp            keep temporary workspaces/DB copies for debugging (default: remove)',
    '  --help                 print this usage and exit 0',
    '',
    'Exit codes: 0 structural expectations independently confirmed; 1 structural expectations NOT',
    'confirmed; 2 audit setup/usage error. Quality failures are recorded separately.',
  ];
  stream.write(`${lines.join('\n')}\n`);
}

function parseCli(argv) {
  const values = { out: null, auditDir: null, tasks: 'both', expectMode: 'auto', keepTemp: false };
  const stringOptions = new Map([['--out', 'out'], ['--audit-dir', 'auditDir'], ['--tasks', 'tasks'], ['--expect-mode', 'expectMode']]);
  const booleanOptions = new Set(['--keep-temp']);
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    const equals = argument.indexOf('=');
    const name = equals >= 0 ? argument.slice(0, equals) : argument;
    if (!name.startsWith('--')) throw new CliError(`unexpected positional argument ${JSON.stringify(argument)}`);
    if (seen.has(name)) throw new CliError(`${name} was provided more than once`);
    seen.add(name);
    const inline = equals >= 0 ? argument.slice(equals + 1) : undefined;
    if (booleanOptions.has(name)) {
      if (inline !== undefined) throw new CliError(`${name} does not take a value`);
      values.keepTemp = true;
      continue;
    }
    if (!stringOptions.has(name)) throw new CliError(`unknown option ${name}`);
    let value = inline;
    if (value === undefined) {
      index++;
      if (index >= argv.length) throw new CliError(`${name} requires a value`);
      value = argv[index];
    }
    if (!value) throw new CliError(`${name} requires a nonempty value`);
    values[stringOptions.get(name)] = value;
  }
  if (values.out === null) throw new CliError('--out is required');
  if (!['a', 'b', 'both'].includes(values.tasks)) throw new CliError('--tasks must be a, b or both');
  if (!['auto', 'run', 'dry-run'].includes(values.expectMode)) throw new CliError('--expect-mode must be auto, run or dry-run');
  return { help: false, ...values };
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();
const timestamp = () => nowIso().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const errorText = error => (error instanceof Error ? error.message : String(error));
function parseJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function readJsonFile(file) {
  const text = readFileSync(file, 'utf8');
  return JSON.parse(text);
}
function listFilesRecursively(rootDirectory, relativePrefix = '') {
  const files = [];
  for (const entry of readdirSync(rootDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = relativePrefix ? path.posix.join(relativePrefix, entry.name) : entry.name;
    const absolute = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}
function toPosix(value) {
  return String(value).split('\\').join('/');
}
/** Expand the pre-registered protected entries of one workspace into a sorted file list. */
function expandProtectedEntries(workspaceDirectory, protectedEntries) {
  const files = [];
  for (const entry of protectedEntries) {
    const relative = toPosix(path.posix.normalize(String(entry).split('\\').join('/')));
    if (relative.startsWith('../') || relative === '..' || path.posix.isAbsolute(relative)) {
      throw new Error(`protected entry escapes the workspace: ${entry}`);
    }
    const absolute = path.join(workspaceDirectory, ...relative.split('/'));
    let info;
    try { info = statSync(absolute); } catch { continue; }
    if (info.isDirectory()) files.push(...listFilesRecursively(absolute, relative));
    else if (info.isFile()) files.push(relative);
  }
  return [...new Set(files)].sort();
}
function hashFiles(workspaceDirectory, relativeFiles) {
  const hashes = {};
  const missing = [];
  for (const relative of relativeFiles) {
    const absolute = path.join(workspaceDirectory, ...relative.split('/'));
    try { hashes[relative] = sha256File(absolute); } catch { hashes[relative] = null; missing.push(relative); }
  }
  return { hashes, missing };
}
function compareHashMaps(expected, actual) {
  const expectedKeys = new Set(Object.keys(expected ?? {}));
  const actualKeys = new Set(Object.keys(actual ?? {}));
  const changed = [];
  const missing = [];
  const extra = [];
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) missing.push(key);
    else if (expected[key] !== actual[key]) changed.push(key);
  }
  for (const key of actualKeys) if (!expectedKeys.has(key)) extra.push(key);
  return {
    expectedCount: expectedKeys.size,
    actualCount: actualKeys.size,
    changed: changed.sort(),
    missing: missing.sort(),
    extra: extra.sort(),
    ok: changed.length === 0 && missing.length === 0 && extra.length === 0,
  };
}
function isPathInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function sortedUnique(values) {
  return [...new Set(values)].sort();
}
function compactList(values, limit = 12) {
  const list = [...values];
  if (list.length <= limit) return list.join(', ');
  return `${list.slice(0, limit).join(', ')} … (+${list.length - limit} more)`;
}
function emptyCompactionCounts() {
  return Object.fromEntries(SUMMARY_EVENT_TYPES.map(type => [type, 0]));
}

// Token estimator: prefer the product's estimator so marker token counts are
// directly comparable with the recorded budgets; fall back to a coarse estimate
// only when dist/ is not built (a warning is recorded in that case).
let estimateTextTokens;
let tokenEstimatorSource;
try {
  ({ estimateTextTokens } = await import(new URL('../../dist/runtime/context-tokens.js', import.meta.url).href));
  tokenEstimatorSource = 'dist/runtime/context-tokens.js';
} catch (error) {
  estimateTextTokens = text => Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 4);
  tokenEstimatorSource = `fallback-bytes/4 (${errorText(error)})`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function loadFixtures() {
  const module = await import(new URL(FIXTURE_MODULE, import.meta.url).href);
  if (!Array.isArray(module.fixtures)) throw new Error(`${FIXTURE_MODULE} does not export a fixtures array`);
  return module.fixtures;
}

function expectedTaskIds(selection) {
  if (selection === 'a') return ['task-a'];
  if (selection === 'b') return ['task-b'];
  return ['task-a', 'task-b'];
}

function checkFixtureRegistration(fixtures, expectedIds) {
  const byId = new Map(fixtures.map(fixture => [fixture.id, fixture]));
  const problems = [];
  const rows = [];
  for (const id of expectedIds) {
    const fixture = byId.get(id);
    const registered = REGISTERED[id];
    if (!fixture) { problems.push(`fixture ${id} is not exported by ${FIXTURE_MODULE}`); continue; }
    const row = {
      id,
      title: fixture.title ?? null,
      expectedMinCompactions: fixture.expectedMinCompactions ?? null,
      registeredMinCompactions: registered.expectedMinCompactions,
      workInputTokens: fixture.workInputTokens ?? null,
      registeredWorkInputTokens: registered.workInputTokens,
      protectedEntries: Array.isArray(fixture.protected) ? fixture.protected : null,
      registeredProtectedEntries: [...PROTECTED_ENTRIES],
      verifyCommand: Array.isArray(fixture.verifyCommand) ? fixture.verifyCommand : null,
      assetsDir: fixture.assetsDir ?? null,
      matchesRegistration: false,
    };
    row.matchesRegistration =
      row.expectedMinCompactions === registered.expectedMinCompactions
      && row.workInputTokens === registered.workInputTokens
      && JSON.stringify(row.protectedEntries) === JSON.stringify([...PROTECTED_ENTRIES])
      && JSON.stringify(row.verifyCommand) === JSON.stringify([...VERIFY_COMMAND]);
    if (!row.matchesRegistration) problems.push(`fixture ${id} does not match the frozen pre-registration (expectedMinCompactions/workInputTokens/protected/verifyCommand)`);
    rows.push(row);
  }
  return { rows, problems };
}

/** Hash the untouched fixture asset tree: a baseline that does not depend on report.json. */
function hashFixtureAssets(fixture) {
  const entries = Array.isArray(fixture.protected) ? fixture.protected : [...PROTECTED_ENTRIES];
  if (typeof fixture.assetsDir !== 'string' || !existsSync(fixture.assetsDir)) {
    throw new Error(`fixture ${fixture.id} assetsDir is missing: ${fixture.assetsDir}`);
  }
  const files = expandProtectedEntries(fixture.assetsDir, entries);
  const hashed = hashFiles(fixture.assetsDir, files);
  return { entries, files, hashes: hashed.hashes, missing: hashed.missing };
}

// ---------------------------------------------------------------------------
// State database (copied to an immutable temp location, opened read-only)
// ---------------------------------------------------------------------------
function emptyCallsSummary() {
  return {
    total: 0, modelCalls: 0, toolCalls: 0, summaryModelCalls: 0,
    byKindPurposeNameStatus: [], measured: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, callsWithUsage: 0, callsWithoutUsage: 0 },
    summaryMeasured: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, callsWithUsage: 0, callsWithoutUsage: 0 },
    records: [],
  };
}

function emptyStateInspection(error) {
  return {
    available: false, error, databasePath: null,
    runs: [], run: null, runChoice: null,
    eventCount: 0, eventTypeCounts: {}, eventTimeRange: null,
    compactionEvents: emptyCompactionCounts(),
    startedSummaries: [], installedSummaries: [], failed: [], skipped: [], truncated: [], discarded: [],
    repairStarted: [], repairFailures: [],
    repairCompleted: 0, deterministicFailureCodes: [], deterministicSources: [],
    modelFailures: [], transportFailures: [], completionFailures: [], runFailureEvents: [],
    failureAnalysis: null,
    resultText: '', resultTextChars: 0,
    session: null, calls: emptyCallsSummary(),
  };
}

function summarizeCalls(callRows, blobReader, targetRunId, phaseByCallId) {
  const relevant = targetRunId === null ? callRows : callRows.filter(call => call.runId === targetRunId);
  const byKey = new Map();
  const measured = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, callsWithUsage: 0, callsWithoutUsage: 0 };
  const summaryMeasured = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, callsWithUsage: 0, callsWithoutUsage: 0 };
  const records = [];
  let modelCalls = 0;
  let toolCalls = 0;
  let summaryModelCalls = 0;
  for (const call of relevant) {
    const purpose = call.data.purpose ?? null;
    const name = call.data.name ?? null;
    const status = call.data.status ?? null;
    const key = `${call.data.kind}/${purpose ?? '-'}/${name ?? '-'}/${status ?? '-'}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
    if (call.data.kind === 'tool') { toolCalls++; records.push({ id: call.id, kind: 'tool', name, status }); continue; }
    if (call.data.kind !== 'model') continue;
    modelCalls++;
    const isSummary = purpose === 'compaction';
    if (isSummary) summaryModelCalls++;
    let usage = null;
    let usageError = null;
    let finishReason = null;
    let rawBodyTokens = null;
    let contentChars = null;
    if (typeof call.data.resultRef === 'string') {
      const blob = blobReader(call.data.resultRef);
      if (blob.ok && blob.value && typeof blob.value.usage === 'object' && blob.value.usage !== null) usage = blob.value.usage;
      else if (blob.ok && blob.value) usage = blob.value.usage ?? null;
      else usageError = blob.error;
      if (blob.ok && blob.value) {
        finishReason = blob.value.finishReason ?? null;
        const content = typeof blob.value.message?.content === 'string' ? blob.value.message.content : null;
        if (isSummary && content !== null) {
          // Independent measurement of the raw summary JSON the model returned.
          // `validSummaryResponse` compares exactly this number with job.summaryTokens.
          rawBodyTokens = estimateTextTokens(content);
          contentChars = content.length;
        }
      }
    }
    const known = Boolean(usage) && Number.isSafeInteger(usage.input) && Number.isSafeInteger(usage.output);
    const bucket = isSummary ? summaryMeasured : measured;
    if (known) {
      bucket.input += usage.input;
      bucket.output += usage.output;
      bucket.cacheRead += Number.isSafeInteger(usage.cacheRead) ? usage.cacheRead : 0;
      bucket.cacheWrite += Number.isSafeInteger(usage.cacheWrite) ? usage.cacheWrite : 0;
      bucket.callsWithUsage++;
    } else {
      bucket.callsWithoutUsage++;
    }
    const phaseInfo = phaseByCallId.get(call.id) ?? null;
    records.push({
      id: call.id, kind: 'model', purpose, name, status,
      phase: isSummary ? (phaseInfo?.repair === true ? 'repair' : 'generation') : null,
      chunk: phaseInfo?.chunk ?? null,
      step: call.data.step ?? null,
      rawBodyTokens,
      contentChars,
      finishReason,
      usageKnown: known,
      usage: known ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 } : null,
      usageError,
    });
  }
  return {
    total: relevant.length, modelCalls, toolCalls, summaryModelCalls,
    byKindPurposeNameStatus: [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => ({ key, count })),
    measured, summaryMeasured, records,
  };
}

function classifyFailureStage(reason) {
  const text = String(reason ?? '');
  const code = DETERMINISTIC_SUMMARY_CODES.find(candidate => text.includes(candidate)) ?? null;
  if (code === 'SUMMARY_BUDGET') {
    return { code, stage: /repaired summary exceeds its token budget/i.test(text) ? 'generation-body-budget' : 'budget-other' };
  }
  if (code === 'SUMMARY_INJECTION_BUDGET') return { code, stage: 'display-injection-budget-guard' };
  if (code === 'SUMMARY_INSTALL' || code === 'SUMMARY_NO_GAIN') return { code, stage: 'install-guard' };
  if (code !== null) return { code, stage: `contract-${code}` };
  return { code: null, stage: 'unknown' };
}

/**
 * Join the summary call phases to attempts and re-derive WHY each attempt failed:
 * generation/repair raw body-token overrun (SUMMARY_BUDGET from `validSummaryResponse`
 * / `repairSummary`) vs a display/injection budget guard vs an install guard.
 */
function buildFailureAnalysis({ startedSummaries, repairStarted, repairFailures, failed, installedSummaries, callsSummary }) {
  const generationCalls = callsSummary.records.filter(record => record.phase === 'generation');
  const repairCalls = callsSummary.records.filter(record => record.phase === 'repair');
  const repairCallById = new Map(repairCalls.map(record => [record.id, record]));
  const repairStartedByAttempt = new Map((repairStarted ?? []).map(item => [item.attemptKey, item]));
  const repairFailureByAttempt = new Map((repairFailures ?? []).map(item => [item.attemptKey, item]));
  const failedByAttempt = new Map((failed ?? []).map(item => [item.attemptKey, item]));
  const attempts = startedSummaries.map((started, index) => {
    const generation = generationCalls[index] ?? null;
    const repairStartedItem = repairStartedByAttempt.get(started.attemptKey) ?? null;
    const repairCall = repairStartedItem === null ? null : (repairCallById.get(repairStartedItem.callId) ?? null);
    const repairFailure = repairFailureByAttempt.get(started.attemptKey) ?? null;
    const failure = failedByAttempt.get(started.attemptKey) ?? null;
    const classification = failure === null ? null : classifyFailureStage(failure.reason);
    return {
      attemptKey: started.attemptKey,
      startedSeq: started.seq,
      bodyBudgetTokens: started.budgets?.bodyTokens ?? null,
      displayBudgetTokens: started.budgets?.displayBudgetTokens ?? null,
      plannedMarkerTokens: started.budgets?.plannedMarkerTokens ?? null,
      generationTargetTokens: started.budgets?.generationTargetTokens ?? null,
      generationCallId: generation?.id ?? null,
      generationRawBodyTokens: generation?.rawBodyTokens ?? null,
      generationWithinBodyBudget: generation?.rawBodyTokens !== null && started.budgets?.bodyTokens !== null ? generation?.rawBodyTokens <= started.budgets?.bodyTokens : null,
      repairStarted: repairStartedItem !== null,
      repairCallId: repairCall?.id ?? null,
      repairRawBodyTokens: repairCall?.rawBodyTokens ?? null,
      repairBeforeTokensRecorded: repairFailure?.beforeTokens ?? null,
      repairFailureReason: repairFailure?.reason ?? null,
      failureReason: failure?.reason ?? null,
      failureCode: classification?.code ?? null,
      failureStage: classification?.stage ?? null,
    };
  });
  const stages = {};
  for (const attempt of attempts) if (attempt.failureStage !== null) stages[attempt.failureStage] = (stages[attempt.failureStage] ?? 0) + 1;
  const installed = installedSummaries.map(row => ({
    summaryRef: row.summaryRef,
    markerTokens: row.markerTokens,
    displayBudgetTokens: row.displayBudgetTokens,
    injectionActualTokens: row.injectionActualTokens,
    plannedMarkerTokens: row.plannedMarkerTokens,
    bodyActualTokens: row.bodyActualTokens,
    bodyTokens: row.bodyTokens,
    markerWithinDisplayBudget: row.markerTokens !== null && row.displayBudgetTokens !== null ? row.markerTokens <= row.displayBudgetTokens : null,
    injectionWithinDisplayBudget: row.injectionActualTokens !== null && row.displayBudgetTokens !== null ? row.injectionActualTokens <= row.displayBudgetTokens : null,
    bodyWithinBodyBudget: row.bodyActualTokens !== null && row.bodyTokens !== null ? row.bodyActualTokens <= row.bodyTokens : null,
  }));
  const codes = sortedUnique(attempts.map(attempt => attempt.failureCode).filter(Boolean));
  const bodyOverruns = attempts.filter(attempt => attempt.failureStage === 'generation-body-budget').length;
  const displayGuardFailures = attempts.filter(attempt => attempt.failureStage === 'display-injection-budget-guard').length;
  const installGuardFailures = attempts.filter(attempt => attempt.failureStage === 'install-guard').length;
  let conclusion;
  if (attempts.length === 0) conclusion = 'no summary attempt was started, so no failure stage can be classified';
  else if (bodyOverruns === attempts.filter(attempt => attempt.failureReason !== null).length && displayGuardFailures === 0 && installGuardFailures === 0) {
    conclusion = 'every recorded failure is a generation/repair raw body-token overrun of the job body budget (SUMMARY_BUDGET); no display/injection-budget or install-guard failure is recorded, and the installed marker fits its display budget';
  } else if (displayGuardFailures === 0 && installGuardFailures === 0) {
    conclusion = 'recorded failures are body-budget/contract failures; no display/injection-budget or install-guard failure is recorded';
  } else {
    conclusion = 'recorded failures include display/injection-budget or install-guard failures; inspect per-attempt evidence';
  }
  return {
    attempts,
    generationBodyTokens: generationCalls.map(record => record.rawBodyTokens),
    repairBodyTokens: repairCalls.map(record => record.rawBodyTokens),
    codes,
    stages,
    installed,
    displayGuardFailures,
    installGuardFailures,
    conclusion,
  };
}

function inspectStateDatabase(taskDir, reportRunId) {
  if (DatabaseSync === null) return emptyStateInspection(`node:sqlite is unavailable: ${sqliteModuleError ?? 'unknown import error'}`);
  const stateDir = path.join(taskDir, 'kodo-state');
  const databasePath = path.join(stateDir, 'kodo.sqlite');
  if (!existsSync(databasePath)) return emptyStateInspection(`state database does not exist: ${databasePath}`);
  let tempDir = null;
  try {
    // Copy the state directory (database + WAL/SHM + immutable blobs) so the
    // evidence directory is never opened for writing and never locked.
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'kodo-continuation-audit-state-'));
    cpSync(stateDir, tempDir, { recursive: true });
    const copiedDatabase = path.join(tempDir, 'kodo.sqlite');
    const blobReader = ref => {
      if (typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref)) return { ok: false, error: 'invalid blob reference', value: null };
      const file = path.join(tempDir, 'blobs', `${ref}.json`);
      if (!existsSync(file)) return { ok: false, error: `blob does not exist: ${ref}`, value: null };
      try { return { ok: true, error: null, value: JSON.parse(readFileSync(file, 'utf8')) }; }
      catch (error) { return { ok: false, error: `unreadable blob ${ref}: ${errorText(error)}`, value: null }; }
    };
    let database;
    try { database = new DatabaseSync(copiedDatabase, { readOnly: true }); }
    catch (error) { return emptyStateInspection(`cannot open state database read-only: ${errorText(error)}`); }
    try {
      const rows = sql => database.prepare(sql).all();
      const events = rows('SELECT seq,session_id,run_id,type,time,data FROM events ORDER BY seq').map(row => ({
        seq: Number(row.seq),
        sessionId: row.session_id,
        runId: row.run_id,
        type: row.type,
        time: row.time,
        data: parseJson(row.data, {}) ?? {},
      }));
      const runs = rows('SELECT id,session_id,status,data FROM runs').map(row => {
        const data = parseJson(row.data, {}) ?? {};
        return {
          id: row.id,
          sessionId: row.session_id,
          status: data.status ?? row.status ?? null,
          rowStatus: row.status ?? null,
          error: data.error ?? null,
          createdAt: data.createdAt ?? null,
          objective: typeof data.objective === 'string' ? data.objective : null,
          data,
        };
      });
      const sessions = rows('SELECT id,data FROM sessions').map(row => ({ id: row.id, data: parseJson(row.data, {}) ?? {} }));
      const calls = rows('SELECT id,run_id,data FROM calls').map(row => ({
        id: row.id, runId: row.run_id, data: parseJson(row.data, {}) ?? {},
      }));

      const eventTypeCounts = {};
      for (const event of events) eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
      const compactionEvents = emptyCompactionCounts();
      for (const event of events) if (event.type in compactionEvents) compactionEvents[event.type]++;

      let targetRun = null;
      let runChoice = null;
      if (typeof reportRunId === 'string' && reportRunId) {
        targetRun = runs.find(run => run.id === reportRunId) ?? null;
        if (targetRun) runChoice = 'report.run.runId';
      }
      if (targetRun === null) {
        const ordered = [...runs].sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
        targetRun = ordered.at(-1) ?? null;
        runChoice = runs.length === 0 ? 'no-run' : 'latest-createdAt';
      }
      const targetSession = targetRun === null ? (sessions.at(-1) ?? null) : (sessions.find(session => session.id === targetRun.sessionId) ?? sessions.at(-1) ?? null);

      const extractReason = event => ({
        seq: event.seq, time: event.time, runId: event.runId,
        attemptKey: event.data?.attemptKey ?? null,
        reason: event.data?.reason ?? null,
        chunk: event.data?.chunk ?? null,
        completedChunks: event.data?.completedChunks ?? null,
        plannedChunks: event.data?.plannedChunks ?? null,
      });
      const extractInstalled = event => {
        const data = event.data ?? {};
        const marker = typeof data.marker === 'string' ? data.marker : null;
        const markerTokens = marker === null ? (data.projection?.actualMarkerTokens ?? null) : estimateTextTokens(marker);
        const envelope = typeof data.summaryRef === 'string' ? blobReader(data.summaryRef) : { ok: false, error: 'no summaryRef', value: null };
        const budgets = data.budgets ?? data.projection ?? null;
        return {
          seq: event.seq, time: event.time, runId: event.runId,
          summaryRef: data.summaryRef ?? null,
          attemptKey: data.attemptKey ?? null,
          archivedRef: data.archivedRef ?? null,
          beforeTokens: data.beforeTokens ?? null,
          afterTokens: data.afterTokens ?? null,
          targetTokens: data.targetTokens ?? null,
          targetMet: data.targetMet ?? null,
          markerTokens,
          markerChars: marker === null ? null : marker.length,
          displayBudgetTokens: budgets?.displayBudgetTokens ?? null,
          plannedMarkerTokens: budgets?.plannedMarkerTokens ?? null,
          injectionActualTokens: data.budgets?.injectionActualTokens ?? null,
          directorySources: budgets?.directorySources ?? null,
          directoryTokens: budgets?.directoryTokens ?? null,
          bodyTokens: budgets?.bodyTokens ?? null,
          bodyActualTokens: budgets?.bodyActualTokens ?? null,
          coveredMessages: Array.isArray(data.coveredOffsets) ? data.coveredOffsets.length : null,
          sourcesEventCount: Number.isSafeInteger(data.sources) ? data.sources : null,
          coverage: data.coverage ?? null,
          envelope: envelope.ok && envelope.value !== null ? {
            version: envelope.value.version ?? null,
            budgets: envelope.value.budgets ?? null,
            sourcesCount: Array.isArray(envelope.value.sources) ? envelope.value.sources.length : null,
            shortIds: Array.isArray(envelope.value.sources) ? envelope.value.sources.map(source => source?.short ?? null).filter(Boolean) : null,
            coverage: envelope.value.coverage ?? null,
            coveredOffsets: Array.isArray(envelope.value.coveredOffsets) ? envelope.value.coveredOffsets.length : null,
            previousSummaryRef: envelope.value.previousSummaryRef ?? null,
            usage: envelope.value.usage ?? null,
            error: null,
          } : { error: envelope.error },
        };
      };
      const extractStarted = event => {
        const data = event.data ?? {};
        return {
          seq: event.seq, time: event.time, runId: event.runId,
          attemptKey: data.attemptKey ?? null,
          archivedRef: data.archivedRef ?? null,
          chunks: data.chunks ?? null,
          budgets: data.budgets ?? null,
          projection: data.projection ?? null,
          coverage: data.coverage ?? null,
          previousSummaryRef: data.previousSummaryRef ?? null,
        };
      };

      const installedSummaries = events.filter(event => event.type === 'context.summary.installed').map(extractInstalled);
      const startedSummaries = events.filter(event => event.type === 'context.summary.started').map(extractStarted);
      const failed = events.filter(event => event.type === 'context.summary.failed').map(extractReason);
      const skipped = events.filter(event => event.type === 'context.summary.skipped').map(extractReason);
      const truncated = events.filter(event => event.type === 'context.summary.truncated').map(extractReason);
      const discarded = events.filter(event => event.type === 'context.summary.discarded').map(extractReason);
      const repairStarted = events.filter(event => event.type === 'context.summary.repair.started').map(event => ({
        seq: event.seq, time: event.time, runId: event.runId,
        callId: event.data?.callId ?? null,
        attemptKey: event.data?.attemptKey ?? null,
        chunk: event.data?.chunk ?? null,
        requestRef: event.data?.requestRef ?? null,
        targetTokens: event.data?.targetTokens ?? null,
        bodyTokens: event.data?.bodyTokens ?? null,
      }));
      const repairFailures = events.filter(event => event.type === 'context.summary.repair.failed').map(event => ({
        seq: event.seq, time: event.time, runId: event.runId,
        callId: event.data?.callId ?? null,
        attemptKey: event.data?.attemptKey ?? null,
        chunk: event.data?.chunk ?? null,
        reason: event.data?.reason ?? null,
        beforeTokens: event.data?.beforeTokens ?? null,
        targetTokens: event.data?.targetTokens ?? null,
      }));
      const modelStartedByCallId = new Map(events.filter(event => event.type === 'model.started').map(event => [event.data?.callId, event.data ?? {}]));

      const modelFailures = events.filter(event => event.type === 'model.failed').map(event => ({
        seq: event.seq, runId: event.runId,
        callId: event.data?.callId ?? null,
        purpose: event.data?.purpose ?? null,
        error: event.data?.error ?? null,
        usageKnownZero: event.data?.usageKnownZero ?? null,
      }));
      const transportFailures = modelFailures.filter(item => MODEL_TRANSPORT_PREFIXES.some(prefix => String(item.error ?? '').includes(prefix)));
      const completionFailures = modelFailures.filter(item => MODEL_COMPLETION_PATTERN.test(String(item.error ?? '')));

      const runFailureEvents = targetRun === null ? [] : events
        .filter(event => event.runId === targetRun.id && (event.type === 'run.failed' || event.type === 'run.interrupted'))
        .map(event => ({ seq: event.seq, type: event.type, error: event.data?.error ?? null }));

      // Deterministic summary codes: same failure surface the runner records,
      // re-derived from the database rather than from report.json.
      const deterministicSources = [];
      const pushText = (source, text) => {
        const value = String(text ?? '');
        if (!value) return;
        const matched = DETERMINISTIC_SUMMARY_CODES.filter(code => value.includes(code));
        deterministicSources.push({ source, text: value.slice(0, 400), codes: matched });
      };
      for (const item of failed) pushText('context.summary.failed', item.reason);
      for (const item of truncated) pushText('context.summary.truncated', item.reason);
      for (const item of discarded) pushText('context.summary.discarded', item.reason);
      for (const item of repairFailures) pushText('context.summary.repair.failed', item.reason);
      if (targetRun?.error) pushText('run.error', targetRun.error);
      for (const event of runFailureEvents) pushText(event.type, event.error);
      for (const failure of modelFailures) pushText('model.failed', failure.error);
      const deterministicFailureCodes = sortedUnique(deterministicSources.flatMap(item => item.codes));

      const resultBlob = targetRun !== null && typeof targetRun.data?.resultRef === 'string' ? blobReader(targetRun.data.resultRef) : null;
      const resultText = resultBlob !== null && resultBlob.ok && resultBlob.value !== null && typeof resultBlob.value.text === 'string' ? resultBlob.value.text : '';
      const callsSummary = summarizeCalls(calls, blobReader, targetRun?.id ?? null, modelStartedByCallId);
      const failureAnalysis = buildFailureAnalysis({ startedSummaries, repairStarted, repairFailures, failed, installedSummaries, callsSummary });
      const lastInstallSeq = events.filter(event => event.type === 'context.summary.installed').at(-1)?.seq ?? null;
      const continuedAfterInstall = lastInstallSeq !== null && events.some(event => event.seq > lastInstallSeq && event.type === 'model.finished' && event.data?.purpose !== 'compaction');

      const timeRange = events.length ? { first: events[0]?.time ?? null, last: events.at(-1)?.time ?? null } : null;
      const sessionData = targetSession?.data ?? null;
      const session = sessionData === null ? null : {
        id: targetSession.id,
        tokens: sessionData.tokens ?? null,
        modelCalls: sessionData.modelCalls ?? null,
        toolCalls: sessionData.toolCalls ?? null,
        usageEstimated: sessionData.usageEstimated ?? null,
        budget: sessionData.budget ?? null,
      };

      return {
        available: true,
        error: null,
        databasePath,
        runs: runs.map(run => ({ id: run.id, status: run.status, rowStatus: run.rowStatus, error: run.error, createdAt: run.createdAt, sessionId: run.sessionId })),
        run: targetRun === null ? null : {
          id: targetRun.id, status: targetRun.status, rowStatus: targetRun.rowStatus, error: targetRun.error,
          createdAt: targetRun.createdAt, sessionId: targetRun.sessionId, runCount: runs.length,
        },
        runChoice,
        eventCount: events.length,
        eventTypeCounts,
        eventTimeRange: timeRange,
        compactionEvents,
        startedSummaries,
        installedSummaries,
        failed,
        skipped,
        truncated,
        discarded,
        repairStarted,
        repairFailures,
        repairCompleted: eventTypeCounts['context.summary.repair.completed'] ?? 0,
        deterministicFailureCodes,
        deterministicSources,
        modelFailures,
        transportFailures,
        completionFailures,
        runFailureEvents,
        failureAnalysis,
        continuedAfterInstall,
        resultText,
        resultTextChars: resultText.length,
        session,
        calls: callsSummary,
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return emptyStateInspection(`cannot inspect state database read-only: ${errorText(error)}`);
  } finally {
    if (tempDir !== null) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Independent verify + frozen-constraint probe (temp copy only)
// ---------------------------------------------------------------------------
function normaliseOutput(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}
function lineStats(text) {
  const lines = normaliseOutput(text).split('\n');
  return {
    passLines: lines.filter(line => line.startsWith('PASS:') || line.startsWith('ok ')).length,
    failLines: lines.filter(line => line.startsWith('FAIL:') || line.startsWith('FAILED:')).length,
    passClaim: lines.some(line => line.startsWith('PASS: all ')),
    failClaim: lines.some(line => line.startsWith('FAILED: ')),
  };
}

function runIndependentVerify(taskDir) {
  const workspace = path.join(taskDir, 'workspace');
  if (!existsSync(workspace)) return { available: false, error: `post-run workspace is missing: ${workspace}`, tempRoot: null };
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'kodo-continuation-audit-workspace-'));
  const copiedWorkspace = path.join(tempRoot, 'workspace');
  cpSync(workspace, copiedWorkspace, { recursive: true });
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, VERIFY_COMMAND.slice(1), {
    cwd: copiedWorkspace,
    encoding: 'utf8',
    timeout: VERIFY_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env },
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const stats = lineStats(`${stdout}${stderr}`);
  const verify = {
    available: true,
    error: null,
    command: ['node', ...VERIFY_COMMAND.slice(1)],
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    timedOut,
    recorded: typeof result.status === 'number' || timedOut,
    spawnError: result.error ? errorText(result.error) : null,
    durationMs: Date.now() - startedAt,
    stdout,
    stderr,
    ...stats,
    tempRoot,
    copiedWorkspace,
  };
  return verify;
}

function runConstraintProbe(copiedWorkspace) {
  const pagerFile = path.join(copiedWorkspace, 'src', 'pager.mjs');
  if (!existsSync(pagerFile)) return { available: false, clamp: null, error: 'src/pager.mjs is missing' };
  const moduleUrl = pathToFileURL(pagerFile).href;
  const source = [
    `import { paginate } from ${JSON.stringify(moduleUrl)};`,
    'const rows = Array.from({ length: 100 }, (_, index) => index + 1);',
    'const page = paginate(rows, 1, 1000);',
    'if (!Array.isArray(page)) { console.log("AUDIT_PAGE=non-array"); }',
    'else { console.log("AUDIT_CLAMP=" + page.length); console.log("AUDIT_PAGE=" + JSON.stringify(page)); }',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: copiedWorkspace, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env },
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const match = /^AUDIT_CLAMP=(\d+)$/m.exec(stdout);
  return {
    available: true,
    exitCode: typeof result.status === 'number' ? result.status : null,
    clamp: match ? Number(match[1]) : null,
    page: /^AUDIT_PAGE=(.+)$/m.exec(stdout)?.[1] ?? null,
    error: result.error ? errorText(result.error) : null,
    stderr: (typeof result.stderr === 'string' ? result.stderr : '').slice(0, 2000),
  };
}

// ---------------------------------------------------------------------------
// Wire relay + request files
// ---------------------------------------------------------------------------
function readRelay(taskDir) {
  const relayPath = path.join(taskDir, 'wire', 'relay.json');
  if (!existsSync(relayPath)) return { available: false, path: relayPath, error: 'wire/relay.json does not exist', requests: 0, tokens: 0, estimated: false, rejected: [], calls: [] };
  let parsed;
  try { parsed = readJsonFile(relayPath); }
  catch (error) { return { available: false, path: relayPath, error: `cannot parse relay.json: ${errorText(error)}`, requests: 0, tokens: 0, estimated: false, rejected: [], calls: [] }; }
  const rejected = Array.isArray(parsed.rejected) ? parsed.rejected.map(String) : [];
  const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
  return {
    available: true,
    path: relayPath,
    error: null,
    requests: Number.isSafeInteger(parsed.requests) ? parsed.requests : calls.length,
    tokens: Number.isSafeInteger(parsed.tokens) ? parsed.tokens : 0,
    estimated: Boolean(parsed.estimated),
    rejected,
    calls: calls.map(call => ({
      index: call.index ?? null,
      httpStatus: call.httpStatus ?? null,
      reserve: call.reserve ?? null,
      requestedOutput: call.requestedOutput ?? null,
      outputLimit: call.outputLimit ?? null,
      usage: call.usage ?? null,
      usageKnownZero: call.usageKnownZero ?? null,
      error: call.error ?? null,
      elapsedMs: call.elapsedMs ?? null,
    })),
  };
}

function readWireRequests(taskDir) {
  const wireDir = path.join(taskDir, 'wire');
  if (!existsSync(wireDir)) return { available: false, requestCount: 0, responseCount: 0, models: [], allStreaming: null, unreadable: 0, error: 'wire directory is missing' };
  let entries;
  try { entries = readdirSync(wireDir); } catch (error) { return { available: false, requestCount: 0, responseCount: 0, models: [], allStreaming: null, unreadable: 0, error: errorText(error) }; }
  const requestFiles = entries.filter(name => /^request-\d+\.json$/.test(name)).sort((left, right) => Number(/(\d+)\.json$/.exec(left)[1]) - Number(/(\d+)\.json$/.exec(right)[1]));
  const responseFiles = entries.filter(name => /^response-\d+\.sse$/.test(name));
  const models = [];
  let allStreaming = requestFiles.length > 0;
  let unreadable = 0;
  for (const file of requestFiles) {
    try {
      const text = readFileSync(path.join(wireDir, file), 'utf8');
      const model = /"model"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      if (model) models.push(model);
      if (!/"stream"\s*:\s*true/.test(text)) allStreaming = false;
    } catch { unreadable++; }
  }
  return {
    available: true,
    requestCount: requestFiles.length,
    responseCount: responseFiles.length,
    models: sortedUnique(models),
    allStreaming,
    unreadable,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// trace.jsonl
// ---------------------------------------------------------------------------
function readTrace(taskDir) {
  const tracePath = path.join(taskDir, 'trace.jsonl');
  if (!existsSync(tracePath)) return { available: false, path: tracePath, eventCount: 0, eventTypeCounts: {}, finished: null, malformedLines: 0 };
  const eventTypeCounts = {};
  let eventCount = 0;
  let malformedLines = 0;
  let finished = null;
  const lines = readFileSync(tracePath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { malformedLines++; continue; }
    if (item.type === 'runner.task.started') continue;
    if (item.type === 'runner.task.finished') { finished = { passed: Boolean(item.passed), assertionFailures: item.assertionFailures ?? [], finishedAt: item.finishedAt ?? null }; continue; }
    if (item.type === 'runner.state.unavailable') continue;
    eventCount++;
    eventTypeCounts[item.type] = (eventTypeCounts[item.type] ?? 0) + 1;
  }
  return { available: true, path: tracePath, eventCount, eventTypeCounts, finished, malformedLines };
}

// ---------------------------------------------------------------------------
// Per-task audit
// ---------------------------------------------------------------------------
function readReport(taskDir) {
  const reportPath = path.join(taskDir, 'report.json');
  if (!existsSync(reportPath)) return { path: reportPath, report: null, error: 'report.json does not exist (run did not finish writing evidence)' };
  try { return { path: reportPath, report: readJsonFile(reportPath), error: null }; }
  catch (error) { return { path: reportPath, report: null, error: `cannot parse report.json: ${errorText(error)}` }; }
}

function deriveFinalAnswerObservation(resultText) {
  const text = String(resultText ?? '');
  const limitMatch = /\b37\b/.exec(text);
  const limitNameMatch = /MAX_PAGE_SIZE/.exec(text);
  const snippetStart = limitMatch ? Math.max(0, limitMatch.index - 90) : 0;
  return {
    chars: text.length,
    namesFrozenLimit: limitMatch !== null,
    namesMaxPageSize: limitNameMatch !== null,
    namesPageDefault: /\b10\b/.test(text) && /page.?default/i.test(text),
    contextSnippet: text.length ? text.slice(snippetStart, snippetStart + 260) : '',
  };
}

function auditTask(context, fixture, reportRunIdHint) {
  const { outDir, keepTemp, mode } = context;
  const taskDir = path.join(outDir, fixture.id);
  const task = {
    id: fixture.id,
    title: fixture.title ?? null,
    registered: { ...REGISTERED[fixture.id] },
    status: 'audited',
    taskDir,
    evidence: {},
    report: null,
    reportSummary: null,
    reportError: null,
    baseline: null,
    protectedCheck: null,
    verify: { independent: null, recorded: null, comparison: null },
    constraint: null,
    finalAnswer: null,
    run: null,
    installs: null,
    startedSummaries: [],
    installedSummaries: [],
    deterministicFailureCodes: [],
    deterministicSources: [],
    modelFailures: [],
    transportFailures: [],
    completionFailures: [],
    runFailureEvents: [],
    repairFailures: [],
    failureAnalysis: null,
    archivedEvents: 0,
    calls: null,
    session: null,
    relay: null,
    wire: null,
    trace: null,
    checks: { structural: [], quality: [] },
    structuralPass: false,
    qualityPass: false,
    discrepancies: [],
    warnings: [],
    tempCleanup: null,
  };

  const reportRead = readReport(taskDir);
  const report = reportRead.report;
  task.report = { path: reportRead.path, error: reportRead.error };
  task.reportError = reportRead.error;
  task.trace = readTrace(taskDir);
  task.relay = readRelay(taskDir);
  task.wire = readWireRequests(taskDir);

  const workspace = path.join(taskDir, 'workspace');
  const evidence = {
    taskDir: existsSync(taskDir),
    report: report !== null,
    trace: task.trace.available,
    workspace: existsSync(workspace),
    stateDatabase: existsSync(path.join(taskDir, 'kodo-state', 'kodo.sqlite')),
    verifyStdout: existsSync(path.join(taskDir, 'verify.stdout.txt')),
    verifyStderr: existsSync(path.join(taskDir, 'verify.stderr.txt')),
    relay: task.relay.available,
  };
  task.evidence = evidence;

  // --- protected file hashes -------------------------------------------------
  let currentFiles = [];
  let current;
  if (existsSync(workspace)) {
    try { currentFiles = expandProtectedEntries(workspace, Array.isArray(fixture.protected) ? fixture.protected : [...PROTECTED_ENTRIES]); } catch (error) { task.warnings.push(`cannot expand protected files: ${errorText(error)}`); }
    current = hashFiles(workspace, currentFiles);
  } else {
    current = { hashes: {}, missing: [] };
  }
  const frozenBaseline = context.frozenBaselines.get(fixture.id);
  const reportSeed = report?.seed?.protectedHashes && typeof report.seed.protectedHashes === 'object' ? report.seed.protectedHashes : null;
  const reference = reportSeed ?? frozenBaseline.hashes;
  const referenceSource = reportSeed ? 'report.seed.protectedHashes' : 'fixture.assets';
  const comparison = compareHashMaps(reference, current.hashes);
  const frozenComparison = reportSeed ? compareHashMaps(frozenBaseline.hashes, reportSeed) : null;
  task.baseline = {
    referenceSource,
    referenceCount: Object.keys(reference).length,
    frozenAssetCount: Object.keys(frozenBaseline.hashes).length,
    frozenMissingAtSource: frozenBaseline.missing,
    seedMatchesFrozenFixture: frozenComparison === null ? null : frozenComparison.ok,
    seedVsFrozen: frozenComparison,
    currentCount: currentFiles.length,
    currentMissing: current.missing,
  };
  task.protectedCheck = {
    checked: comparison.expectedCount,
    changed: comparison.changed,
    missing: comparison.missing,
    extra: comparison.extra,
    ok: comparison.ok,
    referenceSource,
  };

  // --- legacy contract hash (explicit acceptance fact) ----------------------
  const protectedHash = relative => (Object.prototype.hasOwnProperty.call(reference, relative) ? reference[relative] : (Object.prototype.hasOwnProperty.call(frozenBaseline.hashes, relative) ? frozenBaseline.hashes[relative] : null));
  const currentHash = relative => (Object.prototype.hasOwnProperty.call(current.hashes, relative) ? current.hashes[relative] : null);
  const legacyContractExpected = protectedHash(FROZEN_CONTRACT_PATH);
  const legacyContractCurrent = currentHash(FROZEN_CONTRACT_PATH);
  const legacySourceExpected = protectedHash(FROZEN_LEGACY_SOURCE_PATH);
  const legacySourceCurrent = currentHash(FROZEN_LEGACY_SOURCE_PATH);

  // --- independent verify + constraint probe ---------------------------------
  let verifyRun;
  let probe = null;
  let tempRoot = null;
  if (existsSync(workspace)) {
    verifyRun = runIndependentVerify(taskDir);
    tempRoot = verifyRun.tempRoot ?? null;
    if (verifyRun.available) probe = runConstraintProbe(verifyRun.copiedWorkspace);
  } else {
    verifyRun = { available: false, error: `post-run workspace is missing: ${workspace}` };
  }
  const independentVerify = verifyRun.available ? {
    available: true,
    exitCode: verifyRun.exitCode,
    signal: verifyRun.signal,
    timedOut: verifyRun.timedOut,
    recorded: verifyRun.recorded,
    spawnError: verifyRun.spawnError,
    durationMs: verifyRun.durationMs,
    passLines: verifyRun.passLines,
    failLines: verifyRun.failLines,
    passClaim: verifyRun.passClaim,
    failClaim: verifyRun.failClaim,
    stdoutChars: verifyRun.stdout.length,
    stderrChars: verifyRun.stderr.length,
    stdoutTail: normaliseOutput(verifyRun.stdout).slice(-1200),
    error: null,
  } : { exitCode: null, error: verifyRun.error, available: false };

  const recordedStdoutPath = path.join(taskDir, 'verify.stdout.txt');
  const recordedStderrPath = path.join(taskDir, 'verify.stderr.txt');
  const recordedStdout = existsSync(recordedStdoutPath) ? readFileSync(recordedStdoutPath, 'utf8') : null;
  const recordedStderr = existsSync(recordedStderrPath) ? readFileSync(recordedStderrPath, 'utf8') : null;
  const recordedStats = recordedStdout === null ? null : lineStats(`${recordedStdout}${recordedStderr ?? ''}`);
  task.verify = {
    independent: independentVerify,
    recorded: {
      stdoutPath: recordedStdoutPath,
      stderrPath: recordedStderrPath,
      available: recordedStdout !== null,
      stdoutChars: recordedStdout === null ? null : recordedStdout.length,
      stderrChars: recordedStderr === null ? null : recordedStderr.length,
      stdout: recordedStdout,
      stderr: recordedStderr,
      ...(recordedStats ?? {}),
      fromReport: report?.verify ? {
        exitCode: report.verify.exitCode ?? null,
        passed: report.verify.passed ?? null,
        timedOut: report.verify.timedOut ?? null,
        recorded: report.verify.recorded ?? null,
      } : null,
    },
    comparison: null,
  };
  if (recordedStdout !== null && independentVerify.exitCode !== null) {
    const independentOutput = normaliseOutput(`${verifyRun.stdout}${verifyRun.stderr}`);
    const recordedOutput = normaliseOutput(`${recordedStdout}${recordedStderr ?? ''}`);
    task.verify.comparison = {
      independentEqualsRecordedFile: independentOutput === recordedOutput,
      independentPassClaim: independentVerify.passClaim,
      recordedPassClaim: recordedStats?.passClaim ?? null,
      reportExitCode: report?.verify?.exitCode ?? null,
      reportedVsIndependent: report?.verify ? (report.verify.exitCode === independentVerify.exitCode) : null,
    };
  }

  // --- frozen legacy constraint ---------------------------------------------
  let pagerSource = null;
  if (existsSync(workspace)) {
    try { pagerSource = readFileSync(path.join(workspace, PAGER_PATH), 'utf8'); } catch { pagerSource = null; }
  }
  const importsLegacy = pagerSource !== null && /from\s+['"]\.\/legacy\.js['"]/.test(pagerSource);
  const usesMaxPageSize = pagerSource !== null && /\bMAX_PAGE_SIZE\b/.test(pagerSource);
  const definesLocalLimit = pagerSource !== null && /(?:const|let|var)\s+MAX_PAGE_SIZE\s*=/.test(pagerSource);
  const legacyContractHashUnchanged = legacyContractExpected !== null && legacyContractCurrent !== null && legacyContractExpected === legacyContractCurrent;
  const legacySourceHashUnchanged = legacySourceExpected !== null && legacySourceCurrent !== null && legacySourceExpected === legacySourceCurrent;
  const clamp = probe !== null && probe.available ? probe.clamp : null;
  const probeOk = clamp === FROZEN_PAGE_LIMIT;
  const constraintRetained = importsLegacy && usesMaxPageSize && legacyContractHashUnchanged && probeOk;
  task.constraint = {
    pagerPath: PAGER_PATH,
    pagerPresent: pagerSource !== null,
    pagerHash: pagerSource === null ? null : sha256File(path.join(workspace, PAGER_PATH)),
    importsLegacy,
    usesMaxPageSize,
    definesLocalLimit,
    probe: probe === null ? { available: false } : { available: probe.available, clamp, expectedClamp: FROZEN_PAGE_LIMIT, probeOk, exitCode: probe.exitCode, error: probe.error, stderr: probe.stderr },
    frozenPageLimit: FROZEN_PAGE_LIMIT,
    frozenPageDefault: FROZEN_PAGE_DEFAULT,
    legacyContractHashUnchanged,
    legacyContractExpectedHash: legacyContractExpected,
    legacyContractCurrentHash: legacyContractCurrent,
    legacySourceHashUnchanged,
    legacySourceExpectedHash: legacySourceExpected,
    legacySourceCurrentHash: legacySourceCurrent,
    retained: constraintRetained,
  };

  if (tempRoot !== null && !keepTemp) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch (error) { task.warnings.push(`temp workspace cleanup failed: ${errorText(error)}`); }
  } else if (tempRoot !== null && keepTemp) {
    task.tempCleanup = tempRoot;
  }

  // --- independent state database extraction --------------------------------
  const state = inspectStateDatabase(taskDir, reportRunIdHint);
  task.run = state.run === null ? null : {
    ...state.run,
    resultText: state.resultText.slice(0, RESULT_TEXT_MAX_CHARS),
    resultTextChars: state.resultTextChars,
    resultTextTruncated: state.resultText.length > RESULT_TEXT_MAX_CHARS,
    runFailureEvents: state.runFailureEvents,
    eventCount: state.eventCount,
    eventTimeRange: state.eventTimeRange,
  };
  task.installs = {
    installed: state.installedSummaries.length,
    started: state.startedSummaries.length,
    failed: state.failed.length,
    skipped: state.skipped.length,
    truncated: state.truncated.length,
    discarded: state.discarded.length,
    contextCompacted: state.compactionEvents['context.compacted'] ?? 0,
    archivedEvents: state.eventTypeCounts['context.archived'] ?? 0,
    repairStarted: state.compactionEvents['context.summary.repair.started'] ?? 0,
    repairCompleted: state.repairCompleted,
    repairFailed: state.compactionEvents['context.summary.repair.failed'] ?? 0,
    eventTypeCounts: state.eventTypeCounts,
    compactionEvents: state.compactionEvents,
    skippedReasons: state.skipped.map(item => ({ reason: item.reason, seq: item.seq, attemptKey: item.attemptKey })),
    stateAvailable: state.available,
    stateError: state.error,
  };
  task.installedSummaries = state.installedSummaries;
  task.startedSummaries = state.startedSummaries;
  task.repairFailures = state.repairFailures;
  task.failureAnalysis = state.failureAnalysis;
  task.archivedEvents = state.eventTypeCounts['context.archived'] ?? 0;
  task.summaryFailures = state.failed;
  task.summarySkipped = state.skipped;
  task.summaryTruncated = state.truncated;
  task.summaryDiscarded = state.discarded;
  task.deterministicFailureCodes = state.deterministicFailureCodes;
  task.deterministicSources = state.deterministicSources;
  task.modelFailures = state.modelFailures;
  task.transportFailures = state.transportFailures;
  task.completionFailures = state.completionFailures;
  task.runFailureEvents = state.runFailureEvents;
  task.calls = state.calls;
  task.session = state.session;
  task.finalAnswer = deriveFinalAnswerObservation(state.resultText);

  // --- report summary retained for reconciliation and the results doc -------
  if (report !== null) {
    task.reportSummary = {
      runner: report.runner ?? null,
      disclaimer: report.disclaimer ?? null,
      mode: report.mode ?? null,
      task: report.task ?? null,
      model: report.model ?? null,
      startedAt: report.startedAt ?? null,
      finishedAt: report.finishedAt ?? null,
      durationMs: report.durationMs ?? null,
      setupFailures: report.setupFailures ?? null,
      setupFailed: report.setupFailed ?? null,
      status: report.status ?? null,
      passed: report.passed ?? null,
      run: report.run ? {
        runId: report.run.runId ?? null,
        status: report.run.status ?? null,
        error: report.run.error ?? null,
        resultTextChars: report.run.resultTextChars ?? null,
        resultText: report.run.resultText ?? null,
      } : null,
      installCounts: report.installCounts ?? null,
      deterministicFailureCodes: report.deterministicFailureCodes ?? null,
      protected: report.protected ?? null,
      protectedHashOk: report.protectedHashOk ?? null,
      seed: report.seed ? { protectedFileCount: report.seed.protectedFileCount ?? null, missingAtSeed: report.seed.missingAtSeed ?? null } : null,
      verify: report.verify ?? null,
      relay: report.relay ?? null,
      usage: report.usage ?? null,
      assertions: report.assertions ?? null,
    };
  }

  // --- structural checks (pre-registration, independent evidence) -----------
  const expectedMin = REGISTERED[fixture.id]?.expectedMinCompactions ?? fixture.expectedMinCompactions;
  const addStructural = (name, passed, detail) => task.checks.structural.push({ name, passed: Boolean(passed), detail: detail === undefined ? null : detail });
  const addQuality = (name, passed, detail) => task.checks.quality.push({ name, passed: Boolean(passed), detail: detail === undefined ? null : detail });

  // Relay evidence is only required for a paid run; a dry run never opens a relay.
  const requiredEvidence = Object.entries(evidence).filter(([name]) => mode === 'run' || name !== 'relay');
  const missingEvidence = requiredEvidence.filter(([, present]) => !present).map(([name]) => name);
  addStructural('evidence-recorded', missingEvidence.length === 0 && report !== null, missingEvidence.length ? `missing: ${missingEvidence.join(', ')}` : `report.json, trace.jsonl, workspace, kodo.sqlite and verify outputs present${mode === 'run' ? ', wire/relay.json present' : `; relay not required in ${mode} mode`}`);
  addStructural('fixture-registration', true, `expectedMinCompactions=${expectedMin} (frozen README §2); fixture=${fixture.expectedMinCompactions}`);
  addStructural('run-terminal-completed', state.available && state.run !== null && state.run.status === 'completed' && state.runFailureEvents.length === 0, state.run === null ? 'no run row in state database' : `status=${state.run.status ?? 'null'}${state.run.error ? ` error=${String(state.run.error).slice(0, 200)}` : ''} runFailureEvents=${state.runFailureEvents.length}`);
  addStructural('summary-installs', state.installedSummaries.length >= expectedMin, `installed=${state.installedSummaries.length} started=${state.startedSummaries.length} failed=${state.failed.length} repairFailed=${state.repairFailures.length} skipped=${state.skipped.length} truncated=${state.truncated.length} discarded=${state.discarded.length} expected>=${expectedMin}`);
  const failureStages = state.failureAnalysis === null ? {} : state.failureAnalysis.stages;
  const stageText = Object.entries(failureStages).map(([stage, count]) => `${stage}=${count}`).join(',');
  addStructural('no-deterministic-summary-failures', state.deterministicFailureCodes.length === 0, state.deterministicFailureCodes.length ? `${state.deterministicFailureCodes.join(',')}${stageText ? ` (failure stages: ${stageText})` : ''}` : 'none');
  addStructural('protected-hashes-unchanged', task.protectedCheck.ok, `${task.protectedCheck.checked} file(s) from ${referenceSource}: changed=${task.protectedCheck.changed.length} missing=${task.protectedCheck.missing.length} extra=${task.protectedCheck.extra.length}${task.protectedCheck.changed.length ? ` changed=${compactList(task.protectedCheck.changed)}` : ''}`);
  addStructural('no-model-transport-failures', state.transportFailures.length === 0 && state.completionFailures.length === 0, `transport=${state.transportFailures.length} modelCompletion=${state.completionFailures.length}${state.transportFailures.length ? ` (${compactList(state.transportFailures.map(item => String(item.error ?? '?')))})` : ''}`);
  if (mode === 'run') {
    addStructural('relay-budget-clean', task.relay.available && task.relay.rejected.length === 0, task.relay.available ? `requests=${task.relay.requests} tokens=${task.relay.tokens} rejected=${task.relay.rejected.length ? task.relay.rejected.join(',') : 'none'}` : `relay evidence missing: ${task.relay.error}`);
  } else {
    addStructural('relay-budget-clean', true, `not applicable in ${mode} mode (no relay expected)`);
  }
  addStructural('protected-baseline-frozen', task.baseline.seedMatchesFrozenFixture !== false, reportSeed === null ? 'report.seed missing; compared against frozen fixture assets' : (task.baseline.seedMatchesFrozenFixture ? `report.seed agrees with fixture assets (${task.baseline.referenceCount} file(s))` : `report.seed disagrees with fixture assets: ${compactList(task.baseline.seedVsFrozen.changed)}…`));

  // --- quality checks (pre-registration acceptance, recorded separately) ----
  addQuality('independent-verify-exit-0', independentVerify.exitCode === 0, independentVerify.error ? independentVerify.error : `independent verify exit=${independentVerify.exitCode} timedOut=${independentVerify.timedOut} passClaim=${independentVerify.passClaim}`);
  addQuality('frozen-legacy-constraint-retained', constraintRetained, `importsLegacy=${importsLegacy} usesMaxPageSize=${usesMaxPageSize} clamp=${clamp ?? 'unavailable'}(expected ${FROZEN_PAGE_LIMIT}) ${FROZEN_CONTRACT_PATH}HashUnchanged=${legacyContractHashUnchanged}`);
  addQuality('protected-hashes-unchanged', task.protectedCheck.ok, `independent hash check: ${task.protectedCheck.ok ? 'unchanged' : 'CHANGED'}`);
  task.qualityPass = task.checks.quality.every(check => check.passed);
  task.outcome = classifyContinuationOutcome({
    runStatus: state.run?.status ?? 'failed', notRun: false, stopped: state.deterministicFailureCodes.length > 0,
    stateReadable: state.available,
    verifyRecorded: independentVerify.available,
    protectedRecorded: task.protectedCheck !== null,
    finalDeliveryRecorded: state.available,
    verifyPassed: independentVerify.exitCode === 0,
    protectedOk: task.protectedCheck.ok,
    finalDeliveryPresent: state.resultTextChars > 0,
    deterministicFailures: state.deterministicFailureCodes.length,
    installs: state.installedSummaries.length,
    expectedMinCompactions: expectedMin,
    continuedAfterInstall: state.continuedAfterInstall,
  });

  // --- reconciliation against report.json -----------------------------------
  reconcile(task, report, state, context);

  // --- final classification --------------------------------------------------
  task.structuralPass = task.checks.structural.every(check => check.passed) && task.discrepancies.every(discrepancy => discrepancy.severity !== 'material');
  task.status = 'audited';
  // Quality is a separate axis: a structural discrepancy does not rewrite the
  // verify/constraint facts, but quality can only pass when those facts pass.
  task.qualityPass = task.checks.quality.every(check => check.passed);
  return task;
}

// ---------------------------------------------------------------------------
// Reconciliation: independent evidence vs report.json
// ---------------------------------------------------------------------------
function reconcile(task, report, state, context) {
  const add = (severity, field, reportValue, independentValue, note) => {
    task.discrepancies.push({ task: task.id, severity, field, report: reportValue, independent: independentValue, note: note ?? null });
  };
  const warn = (field, reportValue, independentValue, note) => add('warning', field, reportValue, independentValue, note);
  const material = (field, reportValue, independentValue, note) => add('material', field, reportValue, independentValue, note);
  if (report === null) {
    material('report.json', null, 'unreadable/missing', task.reportError);
    return;
  }

  const reportMode = report.mode ?? null;
  if (context.mode === 'run' && reportMode !== 'run') material('report.mode', reportMode, 'run', 'paid evidence claims a non-paid mode');
  if (context.mode === 'dry-run' && reportMode !== 'dry-run') warn('report.mode', reportMode, 'dry-run');
  if (context.mode === 'unknown') warn('report.mode', reportMode, 'unknown', 'could not infer evidence mode');

  if (report.task?.id !== task.id) material('task.id', report.task?.id ?? null, task.id);
  const expectedMin = REGISTERED[task.id]?.expectedMinCompactions ?? null;
  if ((report.task?.expectedMinCompactions ?? null) !== expectedMin) material('task.expectedMinCompactions', report.task?.expectedMinCompactions ?? null, expectedMin, 'pre-registration window drift');
  if (report.installCounts?.expectedMinCompactions !== undefined && report.installCounts.expectedMinCompactions !== expectedMin) material('installCounts.expectedMinCompactions', report.installCounts.expectedMinCompactions, expectedMin);

  const independentRun = state.run;
  if (report.run?.runId !== (independentRun?.id ?? null)) material('run.runId', report.run?.runId ?? null, independentRun?.id ?? null);
  if ((report.run?.status ?? null) !== (independentRun?.status ?? null)) material('run.status', report.run?.status ?? null, independentRun?.status ?? null);
  if ((report.status ?? null) !== (independentRun?.status ?? null)) material('status', report.status ?? null, independentRun?.status ?? null);

  const countFields = ['installed', 'started', 'failed', 'skipped', 'truncated', 'discarded', 'contextCompacted'];
  for (const field of countFields) {
    const reportValue = report.installCounts?.[field] ?? null;
    const independentValue = task.installs?.[field === 'contextCompacted' ? 'contextCompacted' : field] ?? null;
    if (reportValue !== independentValue) material(`installCounts.${field}`, reportValue, independentValue);
  }

  const reportCodes = sortedUnique(Array.isArray(report.deterministicFailureCodes) ? report.deterministicFailureCodes : (report.state?.deterministicFailureCodes ?? []));
  const independentCodes = sortedUnique(state.deterministicFailureCodes);
  if (JSON.stringify(reportCodes) !== JSON.stringify(independentCodes)) {
    material('deterministicFailureCodes', reportCodes, independentCodes, 'deterministic summary failure surface differs');
  }

  const reportProtectedOk = report.protected?.ok;
  if (Boolean(reportProtectedOk) !== task.protectedCheck.ok) material('protected.ok', reportProtectedOk ?? null, task.protectedCheck.ok, 'acceptance-critical hash claim disagrees with independent hashing');
  if (report.protected?.checked !== undefined && report.protected.checked !== task.protectedCheck.checked) warn('protected.checked', report.protected.checked, task.protectedCheck.checked);
  if (report.protectedHashOk !== undefined && Boolean(report.protectedHashOk) !== task.protectedCheck.ok) material('protectedHashOk', report.protectedHashOk, task.protectedCheck.ok);

  if (report.seed?.protectedFileCount !== undefined && report.seed.protectedFileCount !== task.baseline.referenceCount) warn('seed.protectedFileCount', report.seed.protectedFileCount, task.baseline.referenceCount);
  if (task.baseline.seedMatchesFrozenFixture === false) material('seed.protectedHashes', 'differs from frozen fixture assets', compactList(task.baseline.seedVsFrozen.changed), 'seed baseline was not the pre-registered fixture state');

  const independentExit = task.verify.independent.exitCode;
  if (report.verify && report.verify.exitCode !== independentExit) material('verify.exitCode', report.verify.exitCode, independentExit, 'recorded and independently re-run acceptance disagree');
  if (report.verify && Boolean(report.verify.passed) !== (independentExit === 0)) material('verify.passed', report.verify.passed ?? null, independentExit === 0, null);
  const recordedClaim = task.verify.recorded?.passClaim ?? null;
  if (recordedClaim !== null && independentExit !== null && recordedClaim !== (independentExit === 0)) {
    material('verify.recordedOutputClaim', recordedClaim, independentExit === 0, 'recorded verify output contradicts the independent re-run');
  }
  if (report.verify && task.verify.comparison && task.verify.comparison.independentEqualsRecordedFile === false) {
    warn('verify.recordedFile', 'recorded output differs from independent output', 'differs');
  }

  if (report.state?.available !== undefined && Boolean(report.state.available) !== state.available) material('state.available', report.state.available, state.available);
  const reportInstalledCount = Array.isArray(report.state?.installedSummaries) ? report.state.installedSummaries.length : null;
  if (reportInstalledCount !== null && reportInstalledCount !== state.installedSummaries.length) material('state.installedSummaries.length', reportInstalledCount, state.installedSummaries.length);
  const reportStartedCount = Array.isArray(report.state?.startedSummaries) ? report.state.startedSummaries.length : null;
  if (reportStartedCount !== null && reportStartedCount !== state.startedSummaries.length) warn('state.startedSummaries.length', reportStartedCount, state.startedSummaries.length);

  // Every summary event type recorded in the report must match the database.
  if (report.state?.compactionEvents && typeof report.state.compactionEvents === 'object') {
    for (const type of SUMMARY_EVENT_TYPES) {
      const reportValue = report.state.compactionEvents[type] ?? 0;
      const independentValue = state.compactionEvents[type] ?? 0;
      if (reportValue !== independentValue) material(`compactionEvents.${type}`, reportValue, independentValue);
    }
  }
  if (Array.isArray(report.state?.summaryFailures)) {
    const reportReasons = sortedUnique(report.state.summaryFailures.map(item => String(item.reason ?? '')));
    const independentReasons = sortedUnique(state.failed.map(item => String(item.reason ?? '')));
    if (JSON.stringify(reportReasons) !== JSON.stringify(independentReasons)) warn('state.summaryFailures.reasons', reportReasons, independentReasons);
  }
  if (Number.isSafeInteger(report.state?.calls?.summaryModelCalls) && report.state.calls.summaryModelCalls !== state.calls.summaryModelCalls) {
    warn('state.calls.summaryModelCalls', report.state.calls.summaryModelCalls, state.calls.summaryModelCalls);
  }

  // Marker token / envelope budget facts.
  const reportRows = Array.isArray(report.state?.installedSummaries) ? report.state.installedSummaries : [];
  for (let index = 0; index < Math.min(reportRows.length, state.installedSummaries.length); index++) {
    const reportRow = reportRows[index];
    const independentRow = state.installedSummaries[index];
    if ((reportRow.summaryRef ?? null) !== (independentRow.summaryRef ?? null)) material(`installedSummaries[${index}].summaryRef`, reportRow.summaryRef ?? null, independentRow.summaryRef ?? null);
    if ((reportRow.markerTokens ?? null) !== (independentRow.markerTokens ?? null)) warn(`installedSummaries[${index}].markerTokens`, reportRow.markerTokens ?? null, independentRow.markerTokens ?? null);
    const reportBudget = reportRow.eventBudgets?.displayBudgetTokens ?? reportRow.projection?.displayBudgetTokens ?? null;
    if (reportBudget !== independentRow.displayBudgetTokens) warn(`installedSummaries[${index}].displayBudgetTokens`, reportBudget, independentRow.displayBudgetTokens);
    const reportBodyActual = reportRow.eventBudgets?.bodyActualTokens ?? null;
    if (reportBodyActual !== null && reportBodyActual !== independentRow.bodyActualTokens) warn(`installedSummaries[${index}].bodyActualTokens`, reportBodyActual, independentRow.bodyActualTokens);
    const reportInjectionActual = reportRow.eventBudgets?.injectionActualTokens ?? null;
    if (reportInjectionActual !== null && reportInjectionActual !== independentRow.injectionActualTokens) warn(`installedSummaries[${index}].injectionActualTokens`, reportInjectionActual, independentRow.injectionActualTokens);
    if (independentRow.injectionActualTokens !== null && independentRow.markerTokens !== null && independentRow.injectionActualTokens !== independentRow.markerTokens) {
      warn(`installedSummaries[${index}].markerMeasurement`, `event injectionActualTokens=${independentRow.injectionActualTokens}`, `recomputed markerTokens=${independentRow.markerTokens}`, 'host-recorded actual marker tokens differ from independently recomputed marker tokens');
    }
  }
  const markerAssertion = Array.isArray(report.assertions) ? report.assertions.find(assertion => assertion.name === 'installed-marker-within-display-budget') : null;
  const overBudget = state.installedSummaries.filter(row => row.markerTokens !== null && row.displayBudgetTokens !== null && row.markerTokens > row.displayBudgetTokens);
  if (markerAssertion?.passed === true && overBudget.length > 0) material('installed-marker-within-display-budget', 'report claims pass', `${overBudget.length} marker(s) exceed displayBudget`, 'marker budget assertion contradicted by independent marker measurement');

  const reportTransport = Array.isArray(report.state?.transportModelFailures) ? report.state.transportModelFailures.length : null;
  if (reportTransport !== null && reportTransport !== state.transportFailures.length) material('state.transportModelFailures.length', reportTransport, state.transportFailures.length);

  if (state.session !== null) {
    const reportSession = report.usage?.session ?? report.state?.usage?.session ?? null;
    if (reportSession !== null) {
      if (reportSession.tokens !== state.session.tokens) warn('usage.session.tokens', reportSession.tokens, state.session.tokens);
      if (reportSession.modelCalls !== state.session.modelCalls) warn('usage.session.modelCalls', reportSession.modelCalls, state.session.modelCalls);
      if (reportSession.toolCalls !== state.session.toolCalls) warn('usage.session.toolCalls', reportSession.toolCalls, state.session.toolCalls);
    }
  }
  const reportCallCount = report.state?.calls?.modelCalls ?? null;
  if (reportCallCount !== null && reportCallCount !== state.calls.modelCalls) warn('state.calls.modelCalls', reportCallCount, state.calls.modelCalls);
  const reportToolCount = report.state?.calls?.toolCalls ?? null;
  if (reportToolCount !== null && reportToolCount !== state.calls.toolCalls) warn('state.calls.toolCalls', reportToolCount, state.calls.toolCalls);

  if (state.available) {
    if (!task.relay.available && context.mode === 'run') material('relay', null, 'wire/relay.json missing', 'paid run evidence has no relay statistics');
    if (task.relay.available) {
      if (!report.relay) material('report.relay', null, 'relay.json present', 'paid evidence without a relay block in report.json');
      else {
        if (report.relay.requests !== task.relay.requests) warn('relay.requests', report.relay.requests, task.relay.requests);
        if (report.relay.tokens !== task.relay.tokens) warn('relay.tokens', report.relay.tokens, task.relay.tokens);
      }
      const reportRejected = Array.isArray(report.relay?.rejected) ? report.relay.rejected.map(String) : [];
      if (JSON.stringify(sortedUnique(reportRejected)) !== JSON.stringify(sortedUnique(task.relay.rejected))) material('relay.rejected', reportRejected, task.relay.rejected, 'relay rejection set differs');
    }
  }

  // Runner self-summary vs independent facts.
  if (Array.isArray(report.assertions) && report.passed === true) {
    // Quality failures intentionally do not contradict the runner's structural
    // assertions, so only an independent structural failure is material here.
    const structuralFailure = task.checks.structural.some(check => !check.passed);
    if (structuralFailure) material('report.passed', report.passed, false, 'runner claims pass while independent structural evidence fails');
  }

  // wire/relay request-count consistency.
  if (task.wire.available && task.relay.available && task.wire.requestCount !== task.relay.requests) {
    warn('wire.requestCount', task.relay.requests, task.wire.requestCount, 'relay.json request count differs from wire/request-*.json count');
  }

  // trace.jsonl is derived from the same event store; counts must agree.
  if (task.trace.available && state.available) {
    const eventTypes = new Set([...Object.keys(task.trace.eventTypeCounts), ...Object.keys(state.eventTypeCounts)]);
    const mismatches = [...eventTypes].filter(type => (task.trace.eventTypeCounts[type] ?? 0) !== (state.eventTypeCounts[type] ?? 0));
    if (mismatches.length) warn('trace.eventCounts', 'traces derived from state', `differ: ${compactList(mismatches)}`);
    if (task.trace.finished !== null && report.passed !== undefined && task.trace.finished.passed !== Boolean(report.passed)) warn('trace.finished.passed', report.passed, task.trace.finished.passed);
  }
}

// ---------------------------------------------------------------------------
// Usage summary
// ---------------------------------------------------------------------------
function buildUsageSummary(taskAudits) {
  const tasks = taskAudits.map(task => {
    const measured = task.calls?.measured ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, callsWithUsage: 0, callsWithoutUsage: 0 };
    const summaryMeasured = task.calls?.summaryMeasured ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, callsWithUsage: 0, callsWithoutUsage: 0 };
    return {
      id: task.id,
      status: task.status,
      modelCalls: task.calls?.modelCalls ?? 0,
      summaryModelCalls: task.calls?.summaryModelCalls ?? 0,
      toolCalls: task.calls?.toolCalls ?? 0,
      normalInput: measured.input,
      normalOutput: measured.output,
      summaryInput: summaryMeasured.input,
      summaryOutput: summaryMeasured.output,
      totalInput: measured.input + summaryMeasured.input,
      totalOutput: measured.output + summaryMeasured.output,
      totalCacheRead: measured.cacheRead + summaryMeasured.cacheRead,
      totalCacheWrite: measured.cacheWrite + summaryMeasured.cacheWrite,
      callsWithUsage: measured.callsWithUsage + summaryMeasured.callsWithUsage,
      callsWithoutUsage: measured.callsWithoutUsage + summaryMeasured.callsWithoutUsage,
      sessionTokens: task.session?.tokens ?? null,
      sessionModelCalls: task.session?.modelCalls ?? null,
      sessionToolCalls: task.session?.toolCalls ?? null,
      usageEstimated: task.session?.usageEstimated ?? null,
      relayRequests: task.relay?.available ? task.relay.requests : 0,
      relayTokens: task.relay?.available ? task.relay.tokens : 0,
      relayEstimated: task.relay?.available ? task.relay.estimated : null,
      relayRejections: task.relay?.available ? task.relay.rejected : [],
    };
  });
  const totalOf = key => tasks.reduce((sum, task) => sum + (task[key] ?? 0), 0);
  return {
    tasks,
    total: {
      modelCalls: totalOf('modelCalls'),
      summaryModelCalls: totalOf('summaryModelCalls'),
      toolCalls: totalOf('toolCalls'),
      normalInput: totalOf('normalInput'),
      normalOutput: totalOf('normalOutput'),
      summaryInput: totalOf('summaryInput'),
      summaryOutput: totalOf('summaryOutput'),
      totalInput: totalOf('totalInput'),
      totalOutput: totalOf('totalOutput'),
      totalCacheRead: totalOf('totalCacheRead'),
      totalCacheWrite: totalOf('totalCacheWrite'),
      callsWithUsage: totalOf('callsWithUsage'),
      callsWithoutUsage: totalOf('callsWithoutUsage'),
      sessionTokens: totalOf('sessionTokens'),
      relayRequests: totalOf('relayRequests'),
      relayTokens: totalOf('relayTokens'),
      relayRejections: tasks.flatMap(task => task.relayRejections),
      usageUnknownCalls: totalOf('callsWithoutUsage'),
    },
    approximations: [
      'sessionTokens are Kodo context estimates (session.usageEstimated); they are not provider billing totals',
      'measuredInput/measuredOutput include both normal and compaction calls when the provider returned usage; other calls are counted as unknown',
      'relayTokens are loopback budget reservations, replaced by measured provider tokens when the relay observed usage',
    ],
    disclaimer: 'Two tasks (one attempt each, no baseline arm, no randomization) cannot support a reliability, non-inferiority, semantic-quality or cost-saving claim. Passing both tasks only justifies considering a larger paired study.',
  };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------
function printTask(task) {
  const lines = [];
  lines.push('');
  lines.push(`=== ${task.id} ===`);
  if (task.status !== 'audited') lines.push(`INFO ${task.id} status: ${task.status}${task.notRunReason ? ` — ${task.notRunReason}` : ''}`);
  for (const check of task.checks.structural) lines.push(`${check.passed ? 'PASS' : 'FAIL'} ${task.id} structural:${check.name} — ${check.detail}`);
  for (const check of task.checks.quality) lines.push(`${check.passed ? 'PASS' : 'FAIL'} ${task.id} quality:${check.name} — ${check.detail}`);
  const installs = task.installs;
  const skipText = installs?.skippedReasons?.length ? ` skippedReasons=${compactList(sortedUnique(installs.skippedReasons.map(item => item.reason)))}` : '';
  if (installs !== null && installs !== undefined) {
    lines.push(`INFO ${task.id} installs: installed=${installs.installed} started=${installs.started} failed=${installs.failed} repairStarted=${installs.repairStarted} repairFailed=${installs.repairFailed} skipped=${installs.skipped} truncated=${installs.truncated} discarded=${installs.discarded} archived=${installs.archivedEvents} expected>=${task.registered.expectedMinCompactions}${skipText}`);
  }
  if (task.installedSummaries?.length) {
    lines.push(`INFO ${task.id} markers: ${task.installedSummaries.map(row => `${row.markerTokens ?? '?'}<=${row.displayBudgetTokens ?? '?'}`).join(', ')}`);
    lines.push(`INFO ${task.id} envelope budgets: ${task.installedSummaries.map(row => `plannedMarker=${row.plannedMarkerTokens ?? '?'} actualMarker=${row.markerTokens ?? '?'} injectionActual=${row.injectionActualTokens ?? '?'} dirSources=${row.directorySources ?? '?'} dirTokens=${row.directoryTokens ?? '?'} bodyActual=${row.bodyActualTokens ?? '?'}/bodyBudget=${row.bodyTokens ?? '?'}`).join(' | ')}`);
  }
  const analysis = task.failureAnalysis;
  if (analysis !== null && analysis !== undefined && (analysis.attempts.length > 0 || analysis.installed.length > 0)) {
    const stageText = Object.entries(analysis.stages).map(([stage, count]) => `${stage}=${count}`).join(',') || 'none';
    lines.push(`INFO ${task.id} failure-analysis: codes=${analysis.codes.length ? analysis.codes.join(',') : 'none'} stages=${stageText} generationRawBodyTokens=[${analysis.generationBodyTokens.join(',')}] repairRawBodyTokens=[${analysis.repairBodyTokens.join(',')}] bodyBudgetTokens=[${analysis.attempts.map(attempt => attempt.bodyBudgetTokens ?? '?').join(',')}] displayBudgetTokens=[${analysis.attempts.map(attempt => attempt.displayBudgetTokens ?? '?').join(',')}]`);
    lines.push(`INFO ${task.id} failure-conclusion: ${analysis.conclusion}`);
    lines.push(`INFO ${task.id} guards: displayBudgetGuardFailures=${analysis.displayGuardFailures} installGuardFailures=${analysis.installGuardFailures} installedFitsDisplay=${analysis.installed.map(row => row.markerWithinDisplayBudget).join(',') || 'n/a'} installedFitsBody=${analysis.installed.map(row => row.bodyWithinBodyBudget).join(',') || 'n/a'}`);
  }
  if (task.repairFailures?.length) {
    lines.push(`INFO ${task.id} repair-failures: ${task.repairFailures.map(item => `${item.reason} (attemptKey=${String(item.attemptKey ?? '?').slice(0, 12)}… beforeTokens=${item.beforeTokens ?? '?'})`).join(' | ')}`);
  }
  lines.push(`INFO ${task.id} verify: independent exit=${task.verify?.independent?.exitCode ?? 'n/a'} timedOut=${task.verify?.independent?.timedOut ?? 'n/a'} recorded exit=${task.verify?.recorded?.fromReport?.exitCode ?? 'n/a'} recordedPassClaim=${task.verify?.recorded?.passClaim ?? 'n/a'} outputsMatch=${task.verify?.comparison?.independentEqualsRecordedFile ?? 'n/a'}`);
  if (task.protectedCheck !== null) {
    lines.push(`INFO ${task.id} protected: ${task.protectedCheck.checked} file(s) from ${task.protectedCheck.referenceSource}: changed=${task.protectedCheck.changed.length} missing=${task.protectedCheck.missing.length} extra=${task.protectedCheck.extra.length} seedMatchesFrozenFixture=${task.baseline?.seedMatchesFrozenFixture ?? 'n/a'}`);
  }
  if (task.constraint !== null) {
    lines.push(`INFO ${task.id} constraint: importsLegacy=${task.constraint.importsLegacy} usesMaxPageSize=${task.constraint.usesMaxPageSize} clamp=${task.constraint.probe.clamp ?? 'unavailable'} legacyContractHashUnchanged=${task.constraint.legacyContractHashUnchanged} retained=${task.constraint.retained}`);
  }
  if (task.finalAnswer !== null) {
    lines.push(`OBSERVE ${task.id} final-answer-names-frozen-limit: ${task.finalAnswer.namesFrozenLimit} (namesMaxPageSize=${task.finalAnswer.namesMaxPageSize}) — snippet: ${JSON.stringify(task.finalAnswer.contextSnippet)}`);
  }
  if (task.calls !== null) {
    const measured = task.calls.measured;
    const summaryMeasured = task.calls.summaryMeasured;
    lines.push(`INFO ${task.id} calls: model=${task.calls.modelCalls} summary=${task.calls.summaryModelCalls} tool=${task.calls.toolCalls} normalInput=${measured.input} normalOutput=${measured.output} summaryInput=${summaryMeasured.input} summaryOutput=${summaryMeasured.output} cacheRead=${measured.cacheRead + summaryMeasured.cacheRead} unknownUsage=${measured.callsWithoutUsage + summaryMeasured.callsWithoutUsage}/${measured.callsWithUsage + measured.callsWithoutUsage + summaryMeasured.callsWithUsage + summaryMeasured.callsWithoutUsage}`);
  }
  if (task.session !== null && task.session !== undefined) lines.push(`INFO ${task.id} session: tokens=${task.session.tokens} modelCalls=${task.session.modelCalls} toolCalls=${task.session.toolCalls} usageEstimated=${task.session.usageEstimated}`);
  if (task.relay?.available) lines.push(`INFO ${task.id} relay: requests=${task.relay.requests} tokens=${task.relay.tokens} estimated=${task.relay.estimated} rejected=${task.relay.rejected.length ? task.relay.rejected.join(',') : 'none'}`);
  if (task.wire?.available) lines.push(`INFO ${task.id} wire: requests=${task.wire.requestCount} responses=${task.wire.responseCount} models=${task.wire.models.join(',') || '?'} streaming=${task.wire.allStreaming}`);
  for (const warning of task.warnings ?? []) lines.push(`WARN ${task.id} ${warning}`);
  for (const discrepancy of task.discrepancies ?? []) {
    lines.push(`WARN ${task.id} discrepancy(${discrepancy.severity}):${discrepancy.field} report=${JSON.stringify(discrepancy.report)} independent=${JSON.stringify(discrepancy.independent)}${discrepancy.note ? ` — ${discrepancy.note}` : ''}`);
  }
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let cli;
  try { cli = parseCli(process.argv.slice(2)); } catch (error) {
    if (error instanceof CliError) { process.stderr.write(`error: ${error.message}\n\n`); printUsage(process.stderr); process.exitCode = 2; return; }
    throw error;
  }
  if (cli.help) { printUsage(process.stdout); process.exitCode = 0; return; }

  const outDir = path.resolve(cli.out);
  if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
    process.stderr.write(`FAIL audit setup: --out directory does not exist: ${outDir}\n`);
    process.exitCode = 2;
    return;
  }
  const auditDir = cli.auditDir === null ? path.join(REPOSITORY, ARTIFACT_PREFIX, `continuation-audit-${timestamp()}`) : path.resolve(cli.auditDir);
  if (isPathInside(auditDir, outDir) || isPathInside(outDir, auditDir)) {
    process.stderr.write(`FAIL audit setup: --audit-dir ${auditDir} overlaps the audited evidence directory ${outDir}; refusing to write into paid evidence\n`);
    process.exitCode = 2;
    return;
  }

  let fixtures;
  try { fixtures = await loadFixtures(); } catch (error) { process.stderr.write(`FAIL audit setup: cannot import ${FIXTURE_MODULE}: ${errorText(error)}\n`); process.exitCode = 2; return; }
  const expectedIds = expectedTaskIds(cli.tasks);
  const registration = checkFixtureRegistration(fixtures, expectedIds);
  if (registration.problems.length) {
    process.stderr.write(`FAIL audit setup: fixture registration drift: ${registration.problems.join('; ')}\n`);
    process.exitCode = 2;
    return;
  }
  const fixturesById = new Map(fixtures.map(fixture => [fixture.id, fixture]));
  const frozenBaselines = new Map();
  for (const id of expectedIds) {
    try { frozenBaselines.set(id, hashFixtureAssets(fixturesById.get(id))); }
    catch (error) { process.stderr.write(`FAIL audit setup: cannot hash frozen fixture assets for ${id}: ${errorText(error)}\n`); process.exitCode = 2; return; }
  }

  // Evidence mode: paid runs always write wire/relay.json; dry runs never do.
  const stopped = readStoppedRecord(outDir);
  const runner = readRunnerSummary(outDir);
  const relayPresence = expectedIds.filter(id => existsSync(path.join(outDir, id, 'wire', 'relay.json')));
  const reportModes = expectedIds.map(id => readReport(path.join(outDir, id)).report?.mode ?? null).filter(Boolean);
  const inferredMode = relayPresence.length > 0
    ? 'run'
    : (reportModes.length > 0 ? reportModes[reportModes.length - 1] : (stopped?.mode ?? 'unknown'));
  const mode = cli.expectMode === 'auto' ? inferredMode : cli.expectMode;

  console.log(`Kodo continuation audit — ${AUDITOR_VERSION}`);
  console.log(`audit: independent, zero-cost (no provider/model/network call)`);
  console.log(`out=${outDir}`);
  console.log(`auditDir=${auditDir} (only write target)`);
  console.log(`mode=${mode} (inferred=${inferredMode}, expected ids=${expectedIds.join(',')})`);
  console.log(`tokenEstimator=${tokenEstimatorSource}`);
  console.log(`fixtures: ${registration.rows.map(row => `${row.id}(expectedMinCompactions=${row.registeredMinCompactions})`).join(', ')}`);
  if (stopped !== null) console.log(`STOP stop-rule record: after=${stopped.stoppedAfter ?? '?'} skipped=${(stopped.skippedTasks ?? []).join(',') || 'none'} reasons=${(stopped.reasons ?? []).join(' | ') || 'none'}`);

  const taskAudits = [];
  for (const id of expectedIds) {
    const fixture = fixturesById.get(id);
    const taskDir = path.join(outDir, id);
    const reportHint = readReport(taskDir).report?.run?.runId ?? null;
    if (!existsSync(taskDir)) {
      const stoppedSkip = stopped !== null && Array.isArray(stopped.skippedTasks) && stopped.skippedTasks.includes(id);
      const notRunReason = stoppedSkip
        ? `not run: pre-registered stop rule after ${stopped.stoppedAfter ?? '?'} (${(stopped.reasons ?? []).join(' | ') || 'no recorded reason'})`
        : 'task directory does not exist and no stop record explains why';
      const missingTask = {
        id,
        title: fixture.title ?? null,
        registered: { ...REGISTERED[id] },
        status: stoppedSkip ? 'not-run-stopped' : 'not-run',
        notRunReason,
        taskDir,
        evidence: { taskDir: false, report: false, trace: false, workspace: false, stateDatabase: false, verifyStdout: false, verifyStderr: false, relay: false },
        report: { path: path.join(taskDir, 'report.json'), error: 'task directory does not exist' },
        reportSummary: null,
        reportError: 'task directory does not exist',
        baseline: null,
        protectedCheck: null,
        verify: { independent: { available: false, error: 'task directory does not exist' }, recorded: null, comparison: null },
        constraint: null,
        finalAnswer: null,
        run: null,
        installs: null,
        startedSummaries: [],
        installedSummaries: [],
        repairFailures: [],
        failureAnalysis: null,
        archivedEvents: 0,
        deterministicFailureCodes: [],
        deterministicSources: [],
        modelFailures: [],
        transportFailures: [],
        completionFailures: [],
        runFailureEvents: [],
        calls: null,
        session: null,
        relay: { available: false, rejected: [], requests: 0, tokens: 0 },
        wire: { available: false, requestCount: 0, responseCount: 0, models: [] },
        trace: { available: false, eventTypeCounts: {}, finished: null },
        summaryFailures: [],
        summarySkipped: [],
        summaryTruncated: [],
        summaryDiscarded: [],
        warnings: [],
        discrepancies: [],
        outcome: classifyContinuationOutcome({ notRun: true, stopped: stoppedSkip }),
        checks: {
          structural: [
            { name: 'evidence-recorded', passed: false, detail: notRunReason },
            { name: 'run-terminal-completed', passed: false, detail: 'task was not run' },
            { name: 'summary-installs', passed: false, detail: 'task was not run' },
            { name: 'no-deterministic-summary-failures', passed: false, detail: 'task was not run' },
            { name: 'protected-hashes-unchanged', passed: false, detail: 'task was not run' },
            { name: 'no-model-transport-failures', passed: false, detail: 'task was not run' },
            { name: 'relay-budget-clean', passed: false, detail: 'task was not run' },
          ],
          quality: [],
        },
        structuralPass: false,
        qualityPass: null,
      };
      taskAudits.push(missingTask);
      printTask(missingTask);
      continue;
    }
    const task = auditTask({ outDir, frozenBaselines, keepTemp: cli.keepTemp, mode }, fixture, reportHint);
    task.reportHint = reportHint;
    taskAudits.push(task);
    printTask(task);
  }

  // Reconcile runner.json and stopped.json with independently extracted facts.
  const runnerSummary = reconcileRunner(runner, stopped, taskAudits, mode);
  const usageSummary = buildUsageSummary(taskAudits);
  const structuralFailures = [];
  for (const task of taskAudits) {
    if (task.status !== 'audited') {
      const label = task.status === 'not-run-stopped' ? 'not run (stop rule)' : 'not run / evidence missing';
      structuralFailures.push(`${task.id}: ${label}`);
      continue;
    }
    for (const check of task.checks.structural) if (!check.passed) structuralFailures.push(`${task.id} structural:${check.name} — ${check.detail}`);
    for (const discrepancy of task.discrepancies) if (discrepancy.severity === 'material') structuralFailures.push(`${task.id} reconciliation:${discrepancy.field} — report=${JSON.stringify(discrepancy.report)} independent=${JSON.stringify(discrepancy.independent)}`);
  }
  if (runnerSummary.materialFailures.length) structuralFailures.push(...runnerSummary.materialFailures);
  const structuralPass = structuralFailures.length === 0;
  const qualityFailures = [];
  for (const task of taskAudits) {
    if (task.outcome?.qualityStatus === 'not_observed') continue;
    for (const check of task.checks.quality) if (!check.passed) qualityFailures.push(`${task.id} quality:${check.name} — ${check.detail}`);
  }
  const observedQualityTasks = taskAudits.filter(task => task.outcome?.qualityStatus !== 'not_observed');
  const qualityPass = observedQualityTasks.length > 0 && qualityFailures.length === 0;
  const discrepancyCounts = {
    material: taskAudits.reduce((sum, task) => sum + task.discrepancies.filter(discrepancy => discrepancy.severity === 'material').length, 0) + runnerSummary.materialFailures.length,
    warning: taskAudits.reduce((sum, task) => sum + task.discrepancies.filter(discrepancy => discrepancy.severity === 'warning').length, 0),
  };
  const stopRuleOutcome = stopped === null
    ? 'not triggered'
    : `triggered: stopped after ${stopped.stoppedAfter ?? '?'} (${(stopped.reasons ?? []).join(' | ') || 'no recorded reason'}); skipped ${(stopped.skippedTasks ?? []).join(',') || 'none'}`;
  const auditedTasks = taskAudits.filter(task => task.status === 'audited');
  const taskOutcomes = Object.fromEntries(taskAudits.map(task => [task.id, { status: task.status, structuralPass: task.structuralPass, qualityPass: task.qualityPass, ...task.outcome }]));
  const result = {
    structuralPass,
    structuralFailures,
    qualityPass,
    qualityFailures,
    qualityObservedTasks: observedQualityTasks.map(task => task.id),
    stopRuleOutcome,
    taskOutcomes,
    tasksAudited: auditedTasks.map(task => task.id),
    tasksNotRun: taskAudits.filter(task => task.status !== 'audited').map(task => task.id),
    passedBothTasks: taskAudits.length === expectedIds.length && auditedTasks.length === expectedIds.length && structuralPass && qualityPass,
    protocolOutcome: structuralPass
      ? (qualityPass ? 'both pre-registered tasks passed structural and quality criteria (two-task screen only)' : 'structural expectations confirmed but quality criteria failed')
      : 'structural expectations NOT confirmed; pre-registered stop rule outcome applies',
    qualityEvidenceButStructuralStop: auditedTasks.some(task => task.qualityPass) && !structuralPass,
  };
  const audit = {
    auditor: AUDITOR_VERSION,
    protocol: CONTINUATION_PROTOCOL_VERSION,
    createdAt: nowIso(),
    zeroCost: true,
    disclaimer: 'Independent structural audit only. No provider/model/network call, no semantic-quality or cost claim. Two tasks cannot support reliability or non-inferiority.',
    out: outDir,
    mode,
    inferredMode,
    tokenEstimator: tokenEstimatorSource,
    cli: { tasks: cli.tasks, expectMode: cli.expectMode },
    fixtures: registration.rows,
    stopRule: stopped === null ? null : {
      source: path.join(outDir, 'stopped.json'),
      stoppedAfter: stopped.stoppedAfter ?? null,
      skippedTasks: stopped.skippedTasks ?? [],
      reasons: stopped.reasons ?? [],
      taskReport: stopped.taskReport ?? null,
      createdAt: stopped.createdAt ?? null,
      outcome: stopRuleOutcome,
    },
    runnerSummary,
    tasks: taskAudits,
    discrepancies: taskAudits.flatMap(task => task.discrepancies.map(discrepancy => ({ task: task.id, ...discrepancy }))),
    discrepancyCounts,
    usageSummary,
    interpretationLimits: [
      'Two tasks, one paid attempt each, no baseline arm and no randomization: this cannot support a reliability rate, non-inferiority, semantic-quality or cost-saving claim.',
      'Passing both tasks only justifies considering a larger paired study (§9C); it is not release acceptance.',
      'The final answer naming the frozen legacy limit is an observation only, not a pass/fail criterion.',
      'Install counts above expectedMinCompactions are structural facts, not text-quality evidence.',
      'A pre-registered structural stop is a failure of the registered expectation; verify/pager evidence from the completed task does not soften it into a success, and no claim is made that a later fix would have passed this completed run.',
    ],
    classification: {
      structuralDefinition: 'run completed; installs >= expectedMinCompactions; no deterministic SUMMARY_* code; protected file set and hashes unchanged; no relay rejection and no model/transport failure; report.json agrees with independent evidence',
      qualityDefinition: 'independent verify exit 0; src/pager.mjs imports ./legacy.js and clamps to 37; docs/legacy-contract.md hash unchanged',
    },
    result,
  };

  mkdirSync(auditDir, { recursive: true });
  const auditPath = path.join(auditDir, 'audit.json');
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');

  console.log('');
  for (const failure of structuralFailures) console.log(`FAIL ${failure}`);
  for (const failure of qualityFailures) console.log(`QUALITY-FAIL ${failure}`);
  console.log('');
  console.log(`AUDIT STOP-RULE: ${stopRuleOutcome}`);
  console.log(`AUDIT TASKS: ${taskAudits.map(task => `${task.id}=${task.status}(structural=${task.structuralPass ? 'PASS' : 'FAIL'},quality=${task.outcome?.qualityStatus ?? 'not_observed'},mechanism=${task.outcome?.mechanismStatus ?? 'not_observed'},exposure=${task.outcome?.exposureStatus ?? 'not_observed'},protocol=${task.outcome?.protocolStatus ?? 'incomplete'})`).join(' ')}`);
  console.log(`AUDIT DISCREPANCIES: material=${discrepancyCounts.material} warning=${discrepancyCounts.warning}`);
  console.log(`AUDIT USAGE: modelCalls=${usageSummary.total.modelCalls} summaryModelCalls=${usageSummary.total.summaryModelCalls} toolCalls=${usageSummary.total.toolCalls} normalInput=${usageSummary.total.normalInput} normalOutput=${usageSummary.total.normalOutput} summaryInput=${usageSummary.total.summaryInput} summaryOutput=${usageSummary.total.summaryOutput} totalMeasuredInput=${usageSummary.total.totalInput} totalMeasuredOutput=${usageSummary.total.totalOutput} cacheRead=${usageSummary.total.totalCacheRead} unknownUsageCalls=${usageSummary.total.usageUnknownCalls} sessionTokensKodoEstimate=${usageSummary.total.sessionTokens} relayRequests=${usageSummary.total.relayRequests} relayTokens=${usageSummary.total.relayTokens} relayRejections=${usageSummary.total.relayRejections.length ? usageSummary.total.relayRejections.join(',') : 'none'}`);
  console.log('AUDIT UNKNOWNS: calls without provider usage are counted as unknown; sessionTokens are Kodo estimates; relayTokens are budget reservations unless measured usage replaced them.');
  console.log('AUDIT LIMITS: two tasks cannot support a reliability or non-inferiority claim, and no semantic-gain or cost-saving claim is made; passing only justifies a larger paired study.');
  console.log(`AUDIT RESULT: structural=${structuralPass ? 'PASS' : 'FAIL'} quality=${qualityPass ? 'PASS' : 'FAIL'} exit=${structuralPass ? 0 : 1}`);
  console.log(`AUDIT OUTCOME: ${result.protocolOutcome}${result.qualityEvidenceButStructuralStop ? ' (quality evidence from the completed task exists, but the session is a structural stop, not a success)' : ''}`);
  console.log(`AUDIT JSON: ${auditPath}`);
  process.exitCode = structuralPass ? 0 : 1;
}

function readStoppedRecord(outDir) {
  const file = path.join(outDir, 'stopped.json');
  if (!existsSync(file)) return null;
  const value = parseJson(readFileSync(file, 'utf8'), null);
  if (value === null || typeof value !== 'object') return null;
  return value;
}

function readRunnerSummary(outDir) {
  const file = path.join(outDir, 'runner.json');
  if (!existsSync(file)) return { path: file, available: false, summary: null };
  const summary = parseJson(readFileSync(file, 'utf8'), null);
  return { path: file, available: summary !== null, summary };
}

function reconcileRunner(runner, stopped, taskAudits, mode) {
  const materialFailures = [];
  const warnings = [];
  if (!runner.available) {
    if (mode === 'run') warnings.push('runner.json is missing or unreadable; per-task evidence was audited instead');
    return { available: false, materialFailures, warnings, summary: null };
  }
  const summary = runner.summary;
  const independentInstalled = taskAudits.reduce((sum, task) => sum + (task.installs?.installed ?? 0), 0);
  if (Number.isSafeInteger(summary.installedTotal) && summary.installedTotal !== independentInstalled) {
    warnings.push(`runner.installedTotal=${summary.installedTotal} but independent installed=${independentInstalled}`);
  }
  if (Array.isArray(summary.failed)) {
    // runner.failed counts runner-assertion failures for the tasks it actually
    // executed; not-run tasks live in summary.stopped.skipped instead.
    const independentAuditedFailed = taskAudits
      .filter(task => task.status === 'audited' && (!task.structuralPass || !task.qualityPass))
      .map(task => task.id)
      .sort();
    const reportedFailed = [...summary.failed].sort();
    if (JSON.stringify(reportedFailed) !== JSON.stringify(independentAuditedFailed)) {
      warnings.push(`runner.failed=[${reportedFailed.join(',')}] differs from independent audited failed=[${independentAuditedFailed.join(',')}]`);
    }
  }
  if (summary.stopped !== null && summary.stopped !== undefined) {
    const summaryStopped = summary.stopped;
    if (stopped === null) warnings.push('runner.json records a stop but stopped.json is missing');
    else if (JSON.stringify(summaryStopped.skipped ?? []) !== JSON.stringify(stopped.skippedTasks ?? [])) warnings.push('runner.json stop record disagrees with stopped.json');
  } else if (stopped !== null) {
    warnings.push('stopped.json is present but runner.json has no stop record');
  }
  if (summary.passedAll === true && taskAudits.some(task => task.status !== 'audited')) {
    materialFailures.push('runner.json claims passedAll while at least one pre-registered task was not run');
  }
  if (summary.exitCode === 0 && taskAudits.some(task => task.status !== 'audited')) {
    materialFailures.push('runner.json claims exit 0 while at least one pre-registered task was not run');
  }
  return { available: true, path: runner.path, materialFailures, warnings, summary: {
    tasks: summary.tasks ?? null,
    completedTasks: summary.completedTasks ?? null,
    passed: summary.passed ?? null,
    failed: summary.failed ?? null,
    installedTotal: summary.installedTotal ?? null,
    expectedMinCompactionsTotal: summary.expectedMinCompactionsTotal ?? null,
    relayRequests: summary.relayRequests ?? null,
    stopped: summary.stopped ?? null,
    passedAll: summary.passedAll ?? null,
    exitCode: summary.exitCode ?? null,
    createdAt: summary.createdAt ?? null,
  } };
}

main().catch(error => {
  console.error(`FAIL audit crashed: ${errorText(error)}`);
  if (error?.stack) console.error(error.stack);
  process.exitCode = 2;
});
