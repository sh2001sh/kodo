// Minimal §9B real-continuation runner: two pre-registered tasks that must continue
// working after a naturally triggered compaction, with a zero-cost dry-run that
// exercises the real summary install path end to end.
//
// What this script measures (structural facts only):
//  - summary event counts (started/installed/failed/skipped/truncated/discarded),
//  - installed summary refs plus envelope/event budgets, marker token sizes and
//    coverage counts,
//  - run terminal status/error, model/tool call counts and session usage,
//  - the project verification command result and protected-file hashes,
//  - paid mode only: loopback relay request/token budget statistics.
// It does NOT measure semantic summary quality, task success rates or cost savings;
// a completed run or a passing verification command is not a quality claim.
//
// Modes:
//  --dry-run  Zero model cost. A scripted Provider answers normal requests with one
//             file.read per call (fixture.dryRunReadFiles in order) and answers
//             summary-purpose requests with a minimal valid seven-key handoff that
//             cites the first [S<n>] host label visible in the request. This runs the
//             real prepareContext -> summarizeContext -> installSummary path through
//             dist/, so install budgets/no-gain/source resolution are production code.
//             The seed-state verify command is EXPECTED to fail (the scripted agent
//             does not fix code); that is recorded, never flattered.
//  --run      Paid experiment, executed only by the operator. The real provider talks
//             to a loopback budget relay (scripts/comparison/relay.mjs); the actual
//             credential never reaches the harness child and is never printed.
//             Stop rule for --task both: task B is not started when task A fails, has
//             zero installs, exposes a deterministic SUMMARY_* failure code, or hits a
//             model/transport completion error. No paid reruns are performed.
//
// Usage: node scripts/comparison/compaction-continuation.mjs (--dry-run | --run) [options]
// See printUsage() for all options. Bad arguments print usage and exit 2.
//
// Safety: --dry-run never resolves provider credentials, never opens a network socket
// and never calls a model. --run reads the real credential once, passes it only to the
// loopback relay in this parent process, and records nothing that contains it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';

import { Application } from '../../dist/application/index.js';
import { estimateTextTokens } from '../../dist/runtime/context-tokens.js';
import { createBudgetRelay } from './relay.mjs';
import { classifyContinuationOutcome } from './continuation/outcomes.mjs';
import { assertBuildMatchesSource, captureFreeze, compareFreeze } from './continuation/freeze.mjs';
import { CONTINUATION_PROTOCOL_VERSION } from './continuation/registration.mjs';

const RUNNER_VERSION = 'compaction-continuation-v2.1';
const REPOSITORY = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE_MODULE = './continuation/fixtures.mjs';

const LIMITS = Object.freeze({ context: 1_000_000, output: 393_216 });
const RELAY_API_KEY_ENV = 'KODO_CONTINUATION_RELAY_KEY';
const RELAY_API_KEY_VALUE = 'fixture-relay-key';
const DRY_BINDING = Object.freeze({ protocol: 'chat-completions', model: 'deepseek-v4.1-flash', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_CONTINUATION_DRY_UNUSED', limits: LIMITS });
const DEFAULT_PROVIDER_CONFIG = 'C:/Users/admin/.config/opencode/opencode.json';
const DEFAULT_PROVIDER = 'codego1';
const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const REQUESTED_TOOLS = Object.freeze([
  'file.read', 'file.list', 'file.search', 'file.apply_patch', 'file.patch',
  'shell.exec', 'history.read', 'history.search', 'todo.read', 'todo.write',
]);
const PERMISSIONS = Object.freeze(['read', 'write', 'exec']);
const WORKSPACE_VERIFY_TIMEOUT_MS = 120_000;
const MAX_TOOL_CALLS = 200;
const MAX_DURATION_MS = 900_000;
const TOOL_TIMEOUT_MS = 120_000;
const DRY_RUN_MODEL_CALL_RESERVE = 4;
// Deterministic summary-contract failures. A literal match in a recorded reason is
// enough: these codes are stable host diagnostics, not model prose.
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
const SUMMARY_SYSTEM_PROMPT_MARKER = 'You write JSON task handoff summaries';
const SUMMARY_INSTRUCTION_MARKER = 'Return ONLY one JSON object';
const CARD_VERSION = '1.0.0';

const CLI_OPTIONS = {
  'dry-run': { kind: 'boolean', description: 'zero model cost; scripted provider; real install path' },
  run: { kind: 'boolean', description: 'paid experiment through the loopback budget relay' },
  task: { kind: 'string', default: 'both', description: 'fixture selection: a | b | both' },
  out: { kind: 'string', default: null, description: 'output root (default .kodo/continuation-<timestamp>)' },
  'provider-config': { kind: 'string', default: DEFAULT_PROVIDER_CONFIG, description: 'opencode-style provider config JSON' },
  provider: { kind: 'string', default: DEFAULT_PROVIDER, description: 'provider id inside the config' },
  model: { kind: 'string', default: DEFAULT_MODEL, description: 'model id' },
  'max-calls': { kind: 'integer', default: 64, description: 'model call budget per task' },
  'max-tokens': { kind: 'integer', default: 4_000_000, description: 'token reservation budget per task' },
  'max-context-tokens': { kind: 'integer', default: 262_144, description: 'run context window' },
  'max-output-tokens': { kind: 'integer', default: 8_192, description: 'run output reservation' },
};

function printUsage(stream = process.stderr) {
  const lines = [
    'Usage: node scripts/comparison/compaction-continuation.mjs (--dry-run | --run) [options]',
    '',
    'Minimal real-continuation check for the compaction contract. --dry-run is zero cost and',
    'must pass before any paid run; --run is executed only by the operator.',
    '',
    'Options:',
    '  --dry-run                  scripted provider, no credentials, no network (install path only)',
    '  --run                      paid provider exposed only through the loopback budget relay',
    '  --task a|b|both            fixture selection (default: both)',
    '  --out <dir>                output root (default: .kodo/continuation-<timestamp>)',
    `  --provider-config <path>   provider config JSON (default: ${DEFAULT_PROVIDER_CONFIG})`,
    `  --provider <id>            provider id in the config (default: ${DEFAULT_PROVIDER})`,
    `  --model <id>               model id (default: ${DEFAULT_MODEL})`,
    '  --max-calls <n>            model call budget per task (default: 64)',
    '  --max-tokens <n>           token reservation budget per task (default: 4000000)',
    '  --max-context-tokens <n>   run context window (default: 262144)',
    '  --max-output-tokens <n>    run output reservation (default: 8192)',
    '  --help                     print this usage and exit 0',
    '',
    'Exit codes: 0 structural assertions passed; 1 a task failed; 2 bad arguments or a',
    'paid stop rule fired (task B skipped, <out>/stopped.json written).',
  ];
  stream.write(`${lines.join('\n')}\n`);
}

class CliError extends Error {}
class RunnerError extends Error {}

function parseCli(argv) {
  const values = {
    dryRun: false, run: false,
    task: CLI_OPTIONS.task.default,
    out: CLI_OPTIONS.out.default,
    providerConfig: CLI_OPTIONS['provider-config'].default,
    provider: CLI_OPTIONS.provider.default,
    model: CLI_OPTIONS.model.default,
    maxCalls: CLI_OPTIONS['max-calls'].default,
    maxTokens: CLI_OPTIONS['max-tokens'].default,
    maxContextTokens: CLI_OPTIONS['max-context-tokens'].default,
    maxOutputTokens: CLI_OPTIONS['max-output-tokens'].default,
  };
  const strings = new Map([['task', 'task'], ['out', 'out'], ['provider-config', 'providerConfig'], ['provider', 'provider'], ['model', 'model']]);
  const integers = new Map([['max-calls', 'maxCalls'], ['max-tokens', 'maxTokens'], ['max-context-tokens', 'maxContextTokens'], ['max-output-tokens', 'maxOutputTokens']]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    if (!name.startsWith('--')) throw new CliError(`unexpected positional argument ${JSON.stringify(arg)}`);
    if (seen.has(name)) throw new CliError(`${name} was provided more than once`);
    seen.add(name);
    const raw = equals >= 0 ? arg.slice(equals + 1) : undefined;
    if (name === '--dry-run' || name === '--run') {
      if (raw !== undefined) throw new CliError(`${name} does not take a value`);
      if (name === '--dry-run') values.dryRun = true; else values.run = true;
      continue;
    }
    let value = raw;
    if (value === undefined) {
      index++;
      if (index >= argv.length) throw new CliError(`${name} requires a value`);
      value = argv[index];
    }
    const shortName = name.slice(2);
    if (strings.has(shortName)) {
      if (!value) throw new CliError(`${name} requires a nonempty value`);
      values[strings.get(shortName)] = value;
      continue;
    }
    if (integers.has(shortName)) {
      const expected = CLI_OPTIONS[shortName].default;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new CliError(`${name} requires a positive safe integer (example: ${expected})`);
      values[integers.get(shortName)] = parsed;
      continue;
    }
    throw new CliError(`unknown option ${name}`);
  }
  if (values.dryRun === values.run) throw new CliError('exactly one of --dry-run or --run is required');
  if (!['a', 'b', 'both'].includes(values.task)) throw new CliError('--task must be a, b or both');
  if (!values.provider.trim()) throw new CliError('--provider must not be empty');
  if (!values.model.trim()) throw new CliError('--model must not be empty');
  if (values.maxOutputTokens >= values.maxContextTokens) throw new CliError('--max-output-tokens must be smaller than --max-context-tokens');
  return { help: false, mode: values.dryRun ? 'dry-run' : 'run', ...values };
}

// ---------- generic helpers ----------

const sha256 = value => createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();
const timestamp = () => nowIso().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const errorText = error => (error instanceof Error ? error.message : String(error));
function parseJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}
function makeRedactor(secret) {
  return text => (secret ? String(text).split(secret).join('[redacted]') : String(text));
}
async function writeJson(file, value, redact) {
  await writeFile(file, `${redact(JSON.stringify(value, null, 2))}\n`, 'utf8');
}

// ---------- fixtures ----------

async function loadFixtures() {
  const url = new URL(FIXTURE_MODULE, import.meta.url);
  let module;
  try {
    module = await import(url.href);
  } catch (error) {
    throw new RunnerError(`cannot import ${FIXTURE_MODULE}: ${errorText(error)}. The fixtures owner must create scripts/comparison/continuation/fixtures.mjs with fixtures + seedWorkspace; this runner does not create fixture content.`);
  }
  if (!Array.isArray(module.fixtures)) throw new RunnerError(`${FIXTURE_MODULE} does not export a fixtures array`);
  if (typeof module.seedWorkspace !== 'function') throw new RunnerError(`${FIXTURE_MODULE} does not export seedWorkspace(fixture, workspaceDir)`);
  return { fixtures: module.fixtures, seedWorkspace: module.seedWorkspace };
}

function selectFixtures(fixtures, selection) {
  const byId = new Map();
  for (const fixture of fixtures) {
    if (!fixture || typeof fixture.id !== 'string' || !fixture.id) throw new RunnerError('every fixture needs a nonempty string id');
    if (byId.has(fixture.id)) throw new RunnerError(`duplicate fixture id ${fixture.id}`);
    byId.set(fixture.id, fixture);
  }
  const wanted = selection === 'both' ? ['task-a', 'task-b'] : [`task-${selection}`];
  return wanted.map(id => {
    const fixture = byId.get(id);
    if (!fixture) throw new RunnerError(`fixture ${id} is missing; available: ${[...byId.keys()].join(', ')}`);
    return fixture;
  });
}

function validateFixture(fixture, mode) {
  const problems = [];
  if (typeof fixture.title !== 'string' || !fixture.title) problems.push('title');
  if (typeof fixture.objective !== 'string' || !fixture.objective.trim()) problems.push('objective');
  if (!Number.isSafeInteger(fixture.workInputTokens) || fixture.workInputTokens < 1024 || fixture.workInputTokens > 10_000_000) problems.push('workInputTokens (1024..10000000)');
  if (!Number.isSafeInteger(fixture.expectedMinCompactions) || fixture.expectedMinCompactions < 1) problems.push('expectedMinCompactions (positive integer)');
  if (!Array.isArray(fixture.verifyCommand) || !fixture.verifyCommand.length || fixture.verifyCommand.some(part => typeof part !== 'string' || !part)) problems.push('verifyCommand (nonempty string array)');
  if (!Array.isArray(fixture.protected) || !fixture.protected.length) problems.push('protected (nonempty array)');
  if (mode === 'dry-run' && (!Array.isArray(fixture.dryRunReadFiles) || !fixture.dryRunReadFiles.length)) problems.push('dryRunReadFiles (nonempty array)');
  if (problems.length) throw new RunnerError(`fixture ${fixture.id} has invalid fields: ${problems.join(', ')}`);
}

function resolveDryRunReadFiles(fixture) {
  const files = fixture.dryRunReadFiles.map((file, index) => {
    if (typeof file !== 'string' || !file) throw new RunnerError(`fixture ${fixture.id} dryRunReadFiles[${index}] is not a nonempty string`);
    return file;
  });
  return files;
}

// ---------- workspace seeding + protected hashes ----------

async function ensureEmptyDirectory(target, description) {
  if (existsSync(target)) {
    let entries;
    try { entries = await readdir(target); } catch { entries = ['<unreadable>']; }
    if (entries.length) throw new RunnerError(`${description} already exists and is not empty: ${target}. Use a fresh --out directory.`);
  }
  await mkdir(target, { recursive: true });
}

async function hashProtectedFiles(workspace, protectedFiles) {
  const hashes = {};
  const missing = [];
  for (const relative of protectedFiles) {
    const normalized = String(relative).split('\\').join('/');
    try { hashes[normalized] = sha256(await readFile(path.join(workspace, normalized))); }
    catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') { hashes[normalized] = null; missing.push(normalized); }
      else throw error;
    }
  }
  return { hashes, missing };
}

function compareProtectedHashes(seeded, after, afterFiles = Object.keys(after.hashes)) {
  const mismatches = [];
  const expected = new Set(Object.keys(seeded.hashes));
  for (const [relative, before] of Object.entries(seeded.hashes)) {
    const current = after.hashes[relative] ?? null;
    if (before === null) mismatches.push({ path: relative, kind: 'seed-unreadable', seeded: before, current });
    else if (current === null) mismatches.push({ path: relative, kind: 'deleted-or-unreadable', seeded: before, current });
    else if (current !== before) mismatches.push({ path: relative, kind: 'modified', seeded: before, current });
  }
  // Extra files created inside a protected directory also change what is protected:
  // the seeded protection contract is a file set, not only a per-file hash list.
  const extraFiles = [...new Set(afterFiles.filter(relative => !expected.has(relative)))].sort();
  for (const relative of extraFiles) mismatches.push({ path: relative, kind: 'extra-file-in-protected-scope', seeded: null, current: after.hashes[relative] ?? null });
  return { ok: mismatches.length === 0, mismatches, checked: expected.size, extraFiles: extraFiles.length };
}

/** Expand fixture.protected entries to the current file list (used to detect added files after the run). */
async function expandProtectedFiles(workspace, protectedEntries) {
  const files = [];
  for (const entry of protectedEntries) {
    const normalized = path.posix.normalize(String(entry).split('\\').join('/'));
    if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) throw new RunnerError(`protected entry stays outside the workspace: ${entry}`);
    const absolute = path.join(workspace, ...normalized.split('/'));
    let info;
    try { info = await stat(absolute); } catch { continue; }
    if (info.isDirectory()) files.push(...await listFilesRecursively(absolute, normalized));
    else if (info.isFile()) files.push(normalized);
  }
  return [...new Set(files)].sort();
}

async function listFilesRecursively(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursively(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

// ---------- card, budget, bindings ----------

function cardPrompt(fixture) {
  return [
    `Task: ${fixture.title}`,
    `Objective: ${fixture.objective}`,
    '',
    'Work directly in the current workspace. Read the project documentation and source code you need, fix the defect, run the project verification command until it passes, and finish with a short delivery summary describing what changed and what you verified.',
    'Do not modify the verification script, the documentation contract files, or any protected legacy contract file. Do not claim checks you did not run.',
  ].join('\n');
}

function buildCard(fixture, tools) {
  const id = `continuation-${fixture.id}`;
  const prompt = cardPrompt(fixture);
  return Object.freeze({
    id, version: CARD_VERSION, name: `Continuation ${fixture.title}`,
    prompt, digest: sha256(`compaction-continuation-card-v1:${id}:${prompt}:${tools.join(',')}`), tools: [...tools],
  });
}

function runBudgetOptions(cli) {
  return {
    maxTokens: cli.maxTokens,
    maxModelCalls: cli.maxCalls,
    maxToolCalls: MAX_TOOL_CALLS,
    maxDurationMs: MAX_DURATION_MS,
    maxContextTokens: cli.maxContextTokens,
    maxOutputTokens: cli.maxOutputTokens,
    maxContextChars: null,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
  };
}

// ---------- dry-run scripted provider (zero cost) ----------

function summaryRequestDetected(request) {
  const first = request.messages[0];
  const systemText = first && first.role === 'system' && typeof first.content === 'string' ? first.content : '';
  if (systemText.includes(SUMMARY_SYSTEM_PROMPT_MARKER)) return true;
  if (request.toolChoice !== 'none' || request.tools.length !== 0) return false;
  return request.messages.some(message => typeof message.content === 'string' && message.content.includes(SUMMARY_INSTRUCTION_MARKER));
}

function minimalDryRunSummary(request) {
  const text = request.messages.map(message => (typeof message.content === 'string' ? message.content : '')).join('\n');
  const match = /\[(S[1-9]\d*)\]/.exec(text);
  // Decisions require at least one resolvable source; when no [S<n>] label is visible
  // (defensive path only) use pending with no citations instead of inventing one.
  const body = match
    ? { goal: 'dry-run handoff', decisions: [{ text: 'continue the registered continuation task', source_refs: [match[1]] }], completed: [], failed_attempts: [], pending: ['continue'], hypotheses: [], knowledge_refs: [] }
    : { goal: 'dry-run handoff', decisions: [], completed: [], failed_attempts: [], pending: ['continue'], hypotheses: [], knowledge_refs: [] };
  return { json: JSON.stringify(body), citedLabel: match === null ? null : match[1] };
}

function createDryRunProvider(fixture, readFiles, maxCalls) {
  const stats = {
    modelCalls: 0, summaryRequests: 0, fileReadRequests: 0, finalAnswers: 0, readIndex: 0,
    readListLength: readFiles.length, readCapped: false, summaryBodies: [],
  };
  const provider = {
    async complete(request, signal) {
      signal.throwIfAborted();
      stats.modelCalls++;
      if (summaryRequestDetected(request)) {
        stats.summaryRequests++;
        const summary = minimalDryRunSummary(request);
        stats.summaryBodies.push({ tokens: estimateTextTokens(summary.json), chars: summary.json.length, citedLabel: summary.citedLabel });
        return { message: { role: 'assistant', content: summary.json }, finishReason: 'stop' };
      }
      const next = readFiles[stats.readIndex];
      if (next !== undefined && stats.modelCalls >= maxCalls - DRY_RUN_MODEL_CALL_RESERVE) {
        stats.readCapped = true;
        readFiles.length = stats.readIndex;
      }
      if (next === undefined || stats.readCapped) {
        stats.finalAnswers++;
        return { message: { role: 'assistant', content: 'dry-run complete: scripted provider exhausted the registered read list.' }, finishReason: 'stop' };
      }
      stats.readIndex++;
      stats.fileReadRequests++;
      const toolCall = { id: `dry-read-${stats.readIndex}`, name: 'file.read', arguments: JSON.stringify({ path: next }) };
      return { message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finishReason: 'tool_calls' };
    },
  };
  return { provider, stats, readFiles };
}

// ---------- credentials (paid mode only) ----------

function extractProviderOptions(config, provider) {
  const options = config && typeof config === 'object' ? config.provider?.[provider]?.options : undefined;
  return options && typeof options === 'object' ? options : undefined;
}

async function resolveCredentials(cli) {
  let key = process.env.KODO_API_KEY ?? process.env.OPENAI_API_KEY;
  let upstream = process.env.KODO_BASE_URL;
  const keyFromEnvironment = typeof key === 'string' && key.length > 0;
  const upstreamFromEnvironment = typeof upstream === 'string' && upstream.length > 0;
  if ((!keyFromEnvironment || !upstreamFromEnvironment) && cli.providerConfig) {
    const absolute = path.resolve(cli.providerConfig);
    let text;
    try { text = await readFile(absolute, 'utf8'); }
    catch (error) { throw new RunnerError(`cannot read --provider-config ${absolute} (${error.code ?? 'read error'}); environment variables remain supported`); }
    const config = parseJson(text, undefined);
    if (config === undefined) throw new RunnerError(`cannot parse --provider-config ${absolute} as JSON`);
    const options = extractProviderOptions(config, cli.provider);
    if (!keyFromEnvironment) key = options?.apiKey;
    if (!upstreamFromEnvironment) upstream = options?.baseURL;
  }
  if (typeof key !== 'string' || !key || typeof upstream !== 'string' || !upstream) {
    throw new RunnerError(`no credentials for provider ${cli.provider}: set KODO_API_KEY/OPENAI_API_KEY and KODO_BASE_URL or configure provider.${cli.provider}.options in --provider-config; never pass a key on the command line`);
  }
  let endpoint;
  try { endpoint = new URL(upstream); } catch { throw new RunnerError('provider URL is not a valid absolute URL'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new RunnerError('provider URL must be plain HTTP(S) without credentials or query parameters');
  }
  return { key, upstream, keySource: keyFromEnvironment ? 'environment' : 'provider-config', upstreamSource: upstreamFromEnvironment ? 'environment' : 'provider-config' };
}

// ---------- verification command + state inspection ----------

function runVerifyCommand(fixture, workspace) {
  const [program, ...args] = fixture.verifyCommand;
  const executable = program === 'node' ? process.execPath : program;
  const startedAt = Date.now();
  const result = spawnSync(executable, args, {
    cwd: workspace, timeout: WORKSPACE_VERIFY_TIMEOUT_MS, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env },
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return {
    command: [program, ...args],
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    timedOut,
    recorded: typeof result.status === 'number' || timedOut,
    spawnError: result.error ? errorText(result.error) : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    durationMs: Date.now() - startedAt,
  };
}

function emptyCompactionCounts() {
  return Object.fromEntries(SUMMARY_EVENT_TYPES.map(type => [type, 0]));
}

function emptyInspection(error) {
  return {
    available: false, error: error === undefined ? null : error,
    events: [], runs: [], run: null, sessions: [], calls: [],
    compactionEvents: emptyCompactionCounts(), eventTypeCounts: {},
    installed: [], started: [], failed: [], skipped: [], truncated: [], discarded: [],
    repaired: 0, deterministicCodes: [], modelFailures: [], transportFailures: [], runFailureEvents: [],
    resultText: '', usage: null, callsSummary: null,
  };
}

function isModelTransportFailure(error) {
  const text = String(error ?? '');
  return MODEL_TRANSPORT_PREFIXES.some(prefix => text.includes(prefix));
}

/** Read the experiment state database read-only (node:sqlite) plus immutable JSON blobs. */
function inspectState(stateDir, runId) {
  const databasePath = path.join(stateDir, 'kodo.sqlite');
  if (!existsSync(databasePath)) return emptyInspection(`state database ${databasePath} does not exist`);
  let database;
  try { database = new DatabaseSync(databasePath, { readOnly: true }); }
  catch (error) { return emptyInspection(`cannot open state database read-only: ${errorText(error)}`); }
  try {
    const rows = sql => database.prepare(sql).all();
    const events = rows('SELECT seq,session_id,run_id,type,time,data FROM events ORDER BY seq').map(row => ({
      seq: Number(row.seq), sessionId: row.session_id, runId: row.run_id, type: row.type, time: row.time, data: parseJson(row.data, {}),
    }));
    const runs = rows('SELECT id,session_id,status,data FROM runs').map(row => ({ id: row.id, sessionId: row.session_id, status: row.status, ...(parseJson(row.data, {}) ?? {}) }));
    const sessions = rows('SELECT id,data FROM sessions').map(row => ({ id: row.id, ...(parseJson(row.data, {}) ?? {}) }));
    const calls = rows('SELECT id,run_id,data FROM calls').map(row => ({ id: row.id, runId: row.run_id, ...(parseJson(row.data, {}) ?? {}) }));
    const blob = ref => {
      if (typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref)) throw new RunnerError('invalid blob reference in state database');
      return parseJson(readFileSync(path.join(stateDir, 'blobs', `${ref}.json`), 'utf8'), undefined);
    };
    const targetRun = runs.find(run => run.id === runId) ?? runs.at(-1) ?? null;
    const targetSession = targetRun ? sessions.find(session => session.id === targetRun.sessionId) ?? null : sessions.at(-1) ?? null;
    const runEvents = targetRun ? events.filter(event => event.runId === targetRun.id) : events;
    const eventTypeCounts = {};
    for (const event of events) eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
    const compactionEvents = emptyCompactionCounts();
    for (const event of events) if (event.type in compactionEvents) compactionEvents[event.type]++;
    const installed = events.filter(event => event.type === 'context.summary.installed').map(event => installedSummaryRow(event, blob));
    const extractReason = event => ({ runId: event.runId, attemptKey: event.data?.attemptKey ?? null, reason: event.data?.reason ?? null, chunk: event.data?.chunk ?? null, completedChunks: event.data?.completedChunks ?? null, plannedChunks: event.data?.plannedChunks ?? null });
    const failed = events.filter(event => event.type === 'context.summary.failed').map(extractReason);
    const skipped = events.filter(event => event.type === 'context.summary.skipped').map(extractReason);
    const truncated = events.filter(event => event.type === 'context.summary.truncated').map(extractReason);
    const discarded = events.filter(event => event.type === 'context.summary.discarded').map(extractReason);
    const started = events.filter(event => event.type === 'context.summary.started').map(event => ({
      runId: event.runId, attemptKey: event.data?.attemptKey ?? null, archivedRef: event.data?.archivedRef ?? null,
      chunks: event.data?.chunks ?? null, budgets: event.data?.budgets ?? null, projection: event.data?.projection ?? null,
      coverage: event.data?.coverage ?? null, previousSummaryRef: event.data?.previousSummaryRef ?? null,
    }));
    const runFailureEvents = runEvents.filter(event => event.type === 'run.failed' || event.type === 'run.interrupted').map(event => ({ type: event.type, error: event.data?.error ?? null }));
    const texts = [...failed.map(item => item.reason), ...truncated.map(item => item.reason), ...discarded.map(item => item.reason)];
    if (targetRun?.error) texts.push(targetRun.error);
    for (const event of runFailureEvents) texts.push(event.error);
    const deterministicCodes = [...new Set(DETERMINISTIC_SUMMARY_CODES.filter(code => texts.some(text => String(text ?? '').includes(code))))];
    const modelFailures = events.filter(event => event.type === 'model.failed').map(event => ({
      runId: event.runId, callId: event.data?.callId ?? null, purpose: event.data?.purpose ?? null, error: event.data?.error ?? null,
      usageKnownZero: event.data?.usageKnownZero ?? null,
    }));
    const transportFailures = modelFailures.filter(item => isModelTransportFailure(item.error));
    const resultText = targetRun?.resultRef ? String(blob(targetRun.resultRef)?.text ?? '') : '';
    const callsSummary = summarizeCalls(calls, blob, targetRun);
    return {
      available: true, error: null,
      events, runs, run: targetRun, sessions, calls,
      compactionEvents, eventTypeCounts,
      installed, started, failed, skipped, truncated, discarded,
      repaired: (eventTypeCounts['context.summary.repair.completed'] ?? 0),
      deterministicCodes, modelFailures, transportFailures, runFailureEvents,
      resultText, usage: summarizeUsage(targetSession, callsSummary), callsSummary,
    };
  } catch (error) {
    return emptyInspection(`cannot read experiment state: ${errorText(error)}`);
  } finally {
    database.close();
  }
}

function installedSummaryRow(event, blob) {
  const data = event.data ?? {};
  let envelope = null;
  let envelopeError = null;
  try { envelope = typeof data.summaryRef === 'string' ? blob(data.summaryRef) : null; } catch (error) { envelopeError = errorText(error); }
  const marker = typeof data.marker === 'string' ? data.marker : null;
  return {
    runId: event.runId,
    summaryRef: data.summaryRef ?? null,
    attemptKey: data.attemptKey ?? null,
    beforeTokens: data.beforeTokens ?? null,
    afterTokens: data.afterTokens ?? null,
    targetTokens: data.targetTokens ?? null,
    targetMet: data.targetMet ?? null,
    markerTokens: marker === null ? (data.projection?.actualMarkerTokens ?? null) : estimateTextTokens(marker),
    markerChars: marker === null ? null : marker.length,
    eventBudgets: data.budgets ?? null,
    projection: data.projection ?? null,
    coverage: data.coverage ?? null,
    coveredMessages: Array.isArray(data.coveredOffsets) ? data.coveredOffsets.length : null,
    sourcesCount: typeof data.sources === 'number' ? data.sources : (Array.isArray(envelope?.sources) ? envelope.sources.length : null),
    envelopeError,
    envelope: envelope === null ? null : {
      version: envelope.version ?? null,
      budgets: envelope.budgets ?? null,
      coveredOffsets: Array.isArray(envelope.coveredOffsets) ? envelope.coveredOffsets.length : null,
      coverage: envelope.coverage ?? null,
      usage: envelope.usage ?? null,
      previousSummaryRef: envelope.previousSummaryRef ?? null,
    },
  };
}

function summarizeCalls(calls, blob, targetRun) {
  const relevant = targetRun ? calls.filter(call => call.runId === targetRun.id) : calls;
  const byKey = new Map();
  let modelCalls = 0;
  let toolCalls = 0;
  let summaryModelCalls = 0;
  const measured = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, callsWithUsage: 0, callsWithoutUsage: 0 };
  const summaryMeasured = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, callsWithUsage: 0, callsWithoutUsage: 0 };
  for (const call of relevant) {
    const key = `${call.kind}/${call.purpose ?? '-'}/${call.name ?? '-'}/${call.status ?? '-'}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
    if (call.kind !== 'model') { if (call.kind === 'tool') toolCalls++; continue; }
    modelCalls++;
    const summary = call.purpose === 'compaction';
    if (summary) summaryModelCalls++;
    let usage = null;
    try { usage = call.resultRef ? blob(call.resultRef)?.usage ?? null : null; } catch { /* unreadable result stays unmeasured */ }
    const bucket = summary ? summaryMeasured : measured;
    if (usage && Number.isSafeInteger(usage.input) && Number.isSafeInteger(usage.output)) {
      bucket.input += usage.input; bucket.output += usage.output;
      bucket.cacheRead += usage.cacheRead ?? 0; bucket.cacheWrite += usage.cacheWrite ?? 0;
      bucket.callsWithUsage++;
    } else bucket.callsWithoutUsage++;
  }
  return {
    total: relevant.length, modelCalls, toolCalls, summaryModelCalls,
    byKindPurposeNameStatus: [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => ({ key, count })),
    measured, summaryMeasured,
  };
}

function summarizeUsage(session, callsSummary) {
  return {
    session: session === null ? null : {
      tokens: session.tokens ?? null,
      modelCalls: session.modelCalls ?? null,
      toolCalls: session.toolCalls ?? null,
      usageEstimated: session.usageEstimated ?? null,
      maxTokens: session.budget?.maxTokens ?? null,
      maxModelCalls: session.budget?.maxModelCalls ?? null,
      maxContextTokens: session.budget?.maxContextTokens ?? null,
      maxOutputTokens: session.budget?.maxOutputTokens ?? null,
    },
    measuredModelCalls: callsSummary?.measured ?? null,
    measuredSummaryCalls: callsSummary?.summaryMeasured ?? null,
  };
}

function summarizeRelay(stats) {
  const calls = Array.isArray(stats?.calls) ? stats.calls : [];
  return {
    requests: stats?.requests ?? 0,
    tokens: stats?.tokens ?? 0,
    estimated: Boolean(stats?.estimated),
    rejected: Array.isArray(stats?.rejected) ? [...stats.rejected] : [],
    calls: calls.map(call => ({
      index: call.index ?? null,
      contextChars: call.contextChars ?? null,
      reserve: call.reserve ?? null,
      requestedOutput: call.requestedOutput ?? null,
      outputLimit: call.outputLimit ?? null,
      httpStatus: call.httpStatus ?? null,
      usage: call.usage ?? null,
      elapsedMs: call.elapsedMs ?? null,
      error: call.error ?? null,
      usageKnownZero: call.usageKnownZero ?? null,
    })),
  };
}

// ---------- report + assertions ----------

function buildReport(context) {
  const { mode, cli, fixture, taskDir, workspace, stateDir, startedAt, finishedAt, durationMs, setupFailures, seed, protectedResult, verify, inspection, appResult, dryRunProvider, relay, credentials, droppedTools, card } = context;
  const report = {
    runner: RUNNER_VERSION,
    disclaimer: 'Structural serialization/install/continuation plumbing facts only. No semantic summary quality, task success rate or cost-saving claim is made by this report.',
    mode,
    task: {
      id: fixture.id,
      title: fixture.title,
      objective: fixture.objective,
      workInputTokens: fixture.workInputTokens,
      expectedMinCompactions: fixture.expectedMinCompactions,
      verifyCommand: fixture.verifyCommand,
      protected: fixture.protected ?? [],
    },
    model: { provider: cli.provider, model: cli.model, ...(credentials ? { credentialSource: credentials.keySource, upstreamSource: credentials.upstreamSource } : {}) },
    card,
    droppedTools,
    paths: { taskDir, workspace, kodoState: stateDir },
    startedAt, finishedAt, durationMs,
    setupFailures,
    run: {
      runId: appResult.runId,
      status: inspection.run?.status ?? appResult.finalStatus ?? null,
      error: inspection.run?.error ?? appResult.finalError ?? null,
      createdAt: inspection.run?.createdAt ?? null,
      resultTextChars: inspection.resultText.length,
      resultText: inspection.resultText.slice(0, 8000),
      resultTextTruncated: inspection.resultText.length > 8000,
    },
    dryRunProvider: mode === 'dry-run' ? dryRunProvider : null,
    seed: seed === null ? null : {
      protectedFileCount: Object.keys(seed.hashes).length,
      protectedHashes: seed.hashes,
      missingAtSeed: seed.missing,
    },
    protected: protectedResult,
    verify: verify === null ? null : {
      command: verify.command,
      exitCode: verify.exitCode,
      signal: verify.signal,
      timedOut: verify.timedOut,
      recorded: verify.recorded,
      spawnError: verify.spawnError,
      durationMs: verify.durationMs,
      passed: verify.exitCode === 0,
      expectedSeedFailure: mode === 'dry-run' ? verify.exitCode !== 0 || verify.timedOut : null,
      stdout: verify.stdout.slice(0, 8000),
      stderr: verify.stderr.slice(0, 8000),
      stdoutTruncated: verify.stdout.length > 8000,
      stderrTruncated: verify.stderr.length > 8000,
      stdoutChars: verify.stdout.length,
      stderrChars: verify.stderr.length,
    },
    state: {
      available: inspection.available,
      error: inspection.error,
      runCount: inspection.runs.length,
      runs: inspection.runs.map(run => ({ id: run.id, status: run.status, error: run.error ?? null })),
      compactionEvents: inspection.compactionEvents,
      eventTypeCounts: inspection.eventTypeCounts,
      deterministicFailureCodes: inspection.deterministicCodes,
      summaryFailures: inspection.failed,
      summarySkipped: inspection.skipped,
      summaryTruncated: inspection.truncated,
      summaryDiscarded: inspection.discarded,
      repairCompletedEvents: inspection.repaired,
      transportModelFailures: inspection.transportFailures,
      modelFailures: inspection.modelFailures,
      startedSummaries: inspection.started,
      installedSummaries: inspection.installed,
      calls: inspection.callsSummary,
      usage: inspection.usage,
    },
    relay: mode === 'run' ? relay : null,
  };
  // Explicit aliases keep the report self-describing without parsing nested state.
  report.protectedHashOk = protectedResult !== null && protectedResult.ok;
  report.installCounts = {
    expectedMinCompactions: fixture.expectedMinCompactions,
    installed: inspection.installed.length,
    started: inspection.compactionEvents['context.summary.started'] ?? 0,
    failed: inspection.compactionEvents['context.summary.failed'] ?? 0,
    skipped: inspection.compactionEvents['context.summary.skipped'] ?? 0,
    truncated: inspection.compactionEvents['context.summary.truncated'] ?? 0,
    discarded: inspection.compactionEvents['context.summary.discarded'] ?? 0,
    contextCompacted: inspection.compactionEvents['context.compacted'] ?? 0,
  };
  report.deterministicFailureCodes = [...inspection.deterministicCodes];
  report.usage = inspection.usage;
  report.status = report.run.status;
  const lastInstallSeq = inspection.events.filter(event => event.type === 'context.summary.installed').at(-1)?.seq ?? null;
  const continuedAfterInstall = lastInstallSeq !== null && inspection.events.some(event => event.seq > lastInstallSeq && event.type === 'model.finished' && event.data?.purpose !== 'compaction');
  report.outcome = classifyContinuationOutcome({
    runStatus: report.run.status, notRun: false, stopped: false,
    stateReadable: inspection.available,
    verifyRecorded: verify !== null && verify.recorded,
    protectedRecorded: protectedResult !== null,
    finalDeliveryRecorded: inspection.available,
    verifyPassed: verify !== null && verify.exitCode === 0,
    protectedOk: protectedResult !== null && protectedResult.ok,
    finalDeliveryPresent: inspection.resultText.length > 0,
    deterministicFailures: inspection.deterministicCodes.length,
    installs: inspection.installed.length,
    expectedMinCompactions: fixture.expectedMinCompactions,
    continuedAfterInstall,
  });
  report.outcome.continuedAfterInstall = continuedAfterInstall;
  return report;
}

function buildAssertions(context) {
  const { mode, fixture, inspection, verify, protectedResult, relay } = context;
  const assertions = [];
  const add = (name, passed, detail) => assertions.push({ name, passed: Boolean(passed), detail: detail === undefined ? null : detail });
  const installedCount = inspection.installed.length;
  const runStatus = inspection.run?.status ?? null;
  const runError = inspection.run?.error ?? null;
  add('run-terminal-completed', runStatus === 'completed', `status=${runStatus ?? 'unknown'}${runError ? ` error=${runError}` : ''}`);
  add('no-deterministic-summary-failures', inspection.deterministicCodes.length === 0, inspection.deterministicCodes.length ? inspection.deterministicCodes.join(',') : 'none');
  add('protected-hashes-unchanged', protectedResult !== null && protectedResult.ok, protectedResult === null ? 'not checked' : `${protectedResult.checked} file(s), ${protectedResult.mismatches.length} mismatch(es)`);
  add('state-database-readable', inspection.available, inspection.error ?? 'read-only node:sqlite');
  if (mode === 'dry-run') {
    add('summary-installs', installedCount >= fixture.expectedMinCompactions, `installed=${installedCount} expected>=${fixture.expectedMinCompactions}`);
    const markerWithinBudget = inspection.installed.length > 0 && inspection.installed.every(row => {
      const budget = row.eventBudgets?.displayBudgetTokens ?? row.projection?.displayBudgetTokens ?? null;
      return budget !== null && row.markerTokens !== null && row.markerTokens <= budget;
    });
    const markers = inspection.installed.map(row => row.markerTokens ?? '?').join(',') || '-';
    const budgets = inspection.installed.map(row => row.eventBudgets?.displayBudgetTokens ?? row.projection?.displayBudgetTokens ?? '?').join(',') || '-';
    add('installed-marker-within-display-budget', markerWithinBudget, `${markers} <= ${budgets}`);
    add('seed-verify-fails-as-expected', verify !== null && verify.recorded && verify.exitCode !== 0, verify === null ? 'verify not run' : `exit=${verify.exitCode}${verify.timedOut ? ' timedOut' : ''}`);
  } else {
    add('summary-install-events-present', installedCount >= fixture.expectedMinCompactions, `installed=${installedCount} expected>=${fixture.expectedMinCompactions}`);
    add('verify-result-recorded', verify !== null && verify.recorded, verify === null ? 'verify not run' : `exit=${verify.exitCode}${verify.spawnError ? ` spawnError=${verify.spawnError}` : ''}`);
    // The fixtures' pre-registered acceptance criterion is verify exit 0. It is
    // reported as a task failure (never softened into a structural success), while
    // the structural facts above stay separately visible in the report.
    add('verify-accepted', verify !== null && verify.exitCode === 0, verify === null ? 'verify not run' : `exit=${verify.exitCode}`);
    add('no-model-transport-failures', inspection.transportFailures.length === 0, inspection.transportFailures.length ? inspection.transportFailures.map(item => item.error).join('; ') : 'none');
    const relayRejected = Array.isArray(relay?.rejected) ? relay.rejected : [];
    add('relay-budget-clean', relayRejected.length === 0, relayRejected.length ? relayRejected.join(',') : 'no rejected requests');
  }
  return { assertions, passed: assertions.every(assertion => assertion.passed) };
}

// ---------- printing ----------

function printTaskReport(fixture, report, assertions, reportPath, redact) {
  const lines = [];
  lines.push('');
  lines.push(`=== ${fixture.id}: ${fixture.title} ===`);
  for (const assertion of assertions) lines.push(`${assertion.passed ? 'PASS' : 'FAIL'} ${fixture.id} ${assertion.name}${assertion.detail === null ? '' : ` — ${assertion.detail}`}`);
  const installed = report.state.compactionEvents['context.summary.installed'] ?? 0;
  lines.push(`INFO ${fixture.id} installs: installed=${installed} started=${report.state.compactionEvents['context.summary.started'] ?? 0} failed=${report.state.compactionEvents['context.summary.failed'] ?? 0} skipped=${report.state.compactionEvents['context.summary.skipped'] ?? 0} truncated=${report.state.compactionEvents['context.summary.truncated'] ?? 0} compacted=${report.state.compactionEvents['context.compacted'] ?? 0} expected>=${fixture.expectedMinCompactions}`);
  const usage = report.state.usage;
  if (usage?.session) {
    const measured = usage.measuredModelCalls;
    const measuredTotal = measured === null ? 0 : measured.callsWithUsage + measured.callsWithoutUsage;
    lines.push(`INFO ${fixture.id} usage: sessionTokens=${usage.session.tokens} modelCalls=${usage.session.modelCalls} toolCalls=${usage.session.toolCalls} usageEstimated=${usage.session.usageEstimated} measuredInput=${measured?.input ?? 0} measuredOutput=${measured?.output ?? 0} measuredCalls=${measured?.callsWithUsage ?? 0}/${measuredTotal}`);
  }
  if (report.relay !== null) lines.push(`INFO ${fixture.id} relay: requests=${report.relay.requests} tokens=${report.relay.tokens} estimated=${report.relay.estimated} rejected=${report.relay.rejected.length ? report.relay.rejected.join(',') : 'none'}`);
  if (report.verify !== null) lines.push(`INFO ${fixture.id} verify: exit=${report.verify.exitCode}${report.verify.timedOut ? ' timedOut' : ''} expectedSeedFailure=${report.verify.expectedSeedFailure === null ? 'n/a' : report.verify.expectedSeedFailure}`);
  if (report.state.installedSummaries.length) {
    lines.push(`INFO ${fixture.id} marker tokens: ${report.state.installedSummaries.map(row => `${row.markerTokens}<=${row.eventBudgets?.displayBudgetTokens ?? '?'}`).join(', ')}`);
  }
  lines.push(`INFO ${fixture.id} report: ${reportPath}`);
  console.log(lines.map(redact).join('\n'));
}

// ---------- task execution ----------

async function runTask(context, fixture) {
  const { cli, mode, outRoot, credentials, redact } = context;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const taskDir = path.join(outRoot, fixture.id);
  const workspace = path.join(taskDir, 'workspace');
  const stateDir = path.join(taskDir, 'kodo-state');
  await ensureEmptyDirectory(taskDir, `task output directory for ${fixture.id}`);
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const setupFailures = [];
  let seed = null;
  let seedProtectedFiles = null;
  try {
    const seeded = await context.seedWorkspace(fixture, workspace);
    if (!seeded || !Array.isArray(seeded.protectedFiles) || !seeded.protectedFiles.length) throw new RunnerError('seedWorkspace must return { protectedFiles: string[] } with at least one entry');
    seedProtectedFiles = [...seeded.protectedFiles];
    seed = await hashProtectedFiles(workspace, seedProtectedFiles);
  } catch (error) {
    setupFailures.push(`seed: ${errorText(error)}`);
  }

  let readFiles = [];
  if (setupFailures.length === 0 && mode === 'dry-run') {
    try {
      readFiles = resolveDryRunReadFiles(fixture);
      const missing = readFiles.filter(relative => !existsSync(path.join(workspace, relative)));
      if (missing.length) setupFailures.push(`dryRunReadFiles missing from the seeded workspace: ${missing.join(', ')}`);
    } catch (error) {
      setupFailures.push(`dry-run read list: ${errorText(error)}`);
    }
  }

  const budget = runBudgetOptions(cli);
  const appOptions = { compaction: { strategy: 'summary', workInputTokens: fixture.workInputTokens }, exploration: false };
  let droppedTools = [];
  let card = null;
  let appResult = { runId: null, finalStatus: null, finalError: null, threw: null };
  let dryRunProvider = null;
  let relayStats = null;
  let app = null;
  let relay = null;
  if (setupFailures.length === 0) {
    try {
      if (mode === 'run') {
        const wireDir = path.join(taskDir, 'wire');
        await mkdir(wireDir, { recursive: true });
        process.env[RELAY_API_KEY_ENV] = RELAY_API_KEY_VALUE;
        relay = await createBudgetRelay({ directory: wireDir, upstream: credentials.upstream, key: credentials.key, model: cli.model, maxCalls: cli.maxCalls, maxTokens: cli.maxTokens, maxOutputTokens: cli.maxOutputTokens, maxContextChars: Number.MAX_SAFE_INTEGER });
        app = new Application(stateDir, undefined, undefined, appOptions);
      } else {
        dryRunProvider = createDryRunProvider(fixture, readFiles, cli.maxCalls);
        app = new Application(stateDir, dryRunProvider.provider, undefined, appOptions);
      }
      const prepared = prepareCard(app, fixture);
      card = prepared.card;
      droppedTools = prepared.droppedTools;
      const binding = mode === 'run'
        ? { protocol: 'chat-completions', model: cli.model, baseURL: relay.baseURL, apiKeyEnv: RELAY_API_KEY_ENV, limits: LIMITS }
        : DRY_BINDING;
      appResult = await executeRun(app, fixture, workspace, binding, card, budget);
    } catch (error) {
      appResult.finalError = appResult.finalError ?? errorText(error);
      appResult.threw = errorText(error);
    } finally {
      if (app !== null) {
        try { await app.shutdown(); } catch (error) { setupFailures.push(`shutdown: ${errorText(error)}`); }
      }
      if (relay !== null) {
        try { await relay.close(); } finally { relayStats = summarizeRelay(relay.stats); }
      }
    }
  }

  const verify = runVerifyCommand(fixture, workspace);
  let protectedResult = { ok: false, checked: 0, mismatches: [], extraFiles: 0 };
  if (seed !== null) {
    try {
      const afterFiles = await expandProtectedFiles(workspace, fixture.protected);
      const after = await hashProtectedFiles(workspace, afterFiles);
      protectedResult = compareProtectedHashes(seed, after, afterFiles);
    } catch (error) {
      protectedResult = { ok: false, checked: seedProtectedFiles?.length ?? 0, mismatches: [{ path: '<hash-error>', kind: errorText(error), seeded: null, current: null }], extraFiles: 0 };
    }
  }
  const inspection = inspectState(stateDir, appResult.runId);
  const finishedAt = nowIso();
  const reportCard = card === null ? null : { id: card.id, version: card.version, name: card.name, digest: card.digest, tools: [...card.tools], prompt: card.prompt };
  const report = buildReport({
    mode, cli, fixture, taskDir, workspace, stateDir, startedAt, finishedAt, durationMs: Date.now() - startedMs,
    setupFailures, seed, protectedResult, verify, inspection, appResult,
    dryRunProvider: dryRunProvider === null ? null : { ...dryRunProvider.stats, readFiles: dryRunProvider.readFiles, summaryBodies: dryRunProvider.stats.summaryBodies },
    relay: relayStats, credentials: mode === 'run' ? credentials : null, droppedTools, card: reportCard,
  });
  const { assertions, passed } = buildAssertions({ mode, fixture, inspection, verify, protectedResult, relay: relayStats });
  report.assertions = assertions;
  report.passed = passed;
  report.setupFailed = setupFailures.length > 0;

  const reportPath = path.join(taskDir, 'report.json');
  await writeJson(reportPath, report, redact);
  await writeFile(path.join(taskDir, 'verify.stdout.txt'), redact(verify.stdout), 'utf8');
  await writeFile(path.join(taskDir, 'verify.stderr.txt'), redact(verify.stderr), 'utf8');
  await writeTrace(taskDir, report, inspection, redact);
  printTaskReport(fixture, report, assertions, reportPath, redact);
  return { fixture, report, assertions, passed, reportPath };
}

function prepareCard(app, fixture) {
  // `isRegistered` only covers host-registered tools; builtin tools live in the
  // registry's reserved builtin set. Ask the real Tools projection which requested
  // names are exposed to this session so an unavailable tool is dropped, not guessed.
  const exposed = new Set(app.coordinator.tools.specs(REQUESTED_TOOLS, { permissions: [...PERMISSIONS] }).map(spec => spec.name));
  const tools = REQUESTED_TOOLS.filter(name => exposed.has(name));
  const droppedTools = REQUESTED_TOOLS.filter(name => !exposed.has(name));
  if (!tools.length) throw new RunnerError('no requested tool is exposed by Application to a read/write/exec session');
  return { card: buildCard(fixture, tools), droppedTools };
}

async function executeRun(app, fixture, workspace, binding, card, budget) {
  const run = app.createRun({ objective: fixture.objective, workspace, binding, card, permissions: [...PERMISSIONS], budget });
  try {
    const final = await app.run(run.id);
    return { runId: run.id, finalStatus: final?.status ?? null, finalError: final?.error ?? null, threw: null };
  } catch (error) {
    return { runId: run.id, finalStatus: null, finalError: errorText(error), threw: errorText(error) };
  }
}

async function writeTrace(taskDir, report, inspection, redact) {
  const lines = [];
  lines.push(redact(JSON.stringify({ type: 'runner.task.started', task: report.task.id, mode: report.mode, startedAt: report.startedAt })));
  if (!inspection.available) lines.push(redact(JSON.stringify({ type: 'runner.state.unavailable', error: inspection.error })));
  for (const event of inspection.events) {
    lines.push(redact(JSON.stringify({ type: event.type, seq: event.seq, time: event.time, runId: event.runId, data: event.data })));
  }
  lines.push(redact(JSON.stringify({ type: 'runner.task.finished', task: report.task.id, mode: report.mode, passed: report.passed, assertionFailures: report.assertions.filter(assertion => !assertion.passed).map(assertion => assertion.name), finishedAt: report.finishedAt })));
  await writeFile(path.join(taskDir, 'trace.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

// ---------- stop rule ----------

function stopReasonsFor(outcome) {
  const reasons = [];
  const { report } = outcome;
  if (report.run.status !== 'completed') reasons.push(`run status ${report.run.status ?? 'unknown'}${report.run.error ? ` (${report.run.error})` : ''}`);
  const installed = report.state.compactionEvents['context.summary.installed'] ?? 0;
  if (installed === 0) reasons.push('installed === 0 (no summary install event)');
  const codes = report.state.deterministicFailureCodes ?? [];
  if (codes.length) reasons.push(`deterministic summary failure codes: ${codes.join(', ')}`);
  const transport = report.state.transportModelFailures ?? [];
  if (transport.length) reasons.push(`model/transport failures: ${transport.map(item => item.error).join('; ')}`);
  // Any non-summary model failure (protocol, retries, credentials, budget) also stops
  // the experiment: a paid rerun against the same registration is not attempted.
  const modelCompletionFailures = (report.state.modelFailures ?? []).filter(item => /^MODEL_[A-Z_]+/.test(String(item.error ?? '')));
  if (modelCompletionFailures.length) reasons.push(`model completion failures: ${modelCompletionFailures.map(item => item.error).join('; ')}`);
  if (Array.isArray(report.relay?.rejected) && report.relay.rejected.length) reasons.push(`relay rejected requests: ${report.relay.rejected.join(', ')}`);
  return reasons;
}

// ---------- main ----------

async function main() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`error: ${error.message}\n\n`);
      printUsage(process.stderr);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (cli.help) { printUsage(process.stdout); process.exitCode = 0; return; }

  const outRoot = path.resolve(cli.out ?? path.join('.kodo', `continuation-${timestamp()}`));

  let loaded;
  try { loaded = await loadFixtures(); }
  catch (error) { process.stderr.write(`FAIL runner setup: ${errorText(error)}\n`); process.exitCode = 1; return; }
  let selected;
  try {
    selected = selectFixtures(loaded.fixtures, cli.task);
    for (const fixture of selected) validateFixture(fixture, cli.mode);
  } catch (error) { process.stderr.write(`FAIL runner setup: ${errorText(error)}\n`); process.exitCode = 1; return; }

  let buildCheck;
  let freezeBefore;
  try {
    buildCheck = assertBuildMatchesSource(REPOSITORY);
    freezeBefore = captureFreeze(REPOSITORY);
  } catch (error) {
    process.stderr.write(`FAIL frozen build check: ${errorText(error)}\n`);
    process.exitCode = 2;
    return;
  }

  try { await mkdir(outRoot, { recursive: true }); }
  catch (error) { process.stderr.write(`FAIL cannot create --out ${outRoot}: ${errorText(error)}\n`); process.exitCode = 2; return; }

  const registration = {
    protocol: CONTINUATION_PROTOCOL_VERSION,
    runner: RUNNER_VERSION,
    frozenAt: nowIso(),
    mode: cli.mode,
    git: freezeBefore.git,
    inputs: freezeBefore.groups,
    build: {
      manifestPath: 'dist/.kodo-build-manifest.json',
      builtAt: buildCheck.recorded.builtAt ?? null,
      buildCommand: buildCheck.recorded.buildCommand ?? null,
      sourceDigest: buildCheck.current.source.digest,
      distDigest: buildCheck.current.dist.digest,
      matchedAtStart: true,
    },
    model: { protocol: 'chat-completions', provider: cli.provider, model: cli.model, declaredLimits: LIMITS },
    tasks: selected.map(fixture => ({ id: fixture.id, workInputTokens: fixture.workInputTokens, expectedMinCompactions: fixture.expectedMinCompactions })),
    limits: {
      maxModelCallsPerTask: cli.maxCalls, maxTokenReservationPerTask: cli.maxTokens,
      maxDurationMs: MAX_DURATION_MS, maxContextTokens: cli.maxContextTokens,
      maxOutputTokens: cli.maxOutputTokens, maxToolCalls: MAX_TOOL_CALLS,
      toolTimeoutMs: TOOL_TIMEOUT_MS,
    },
    compaction: { strategy: 'summary', assembly: false },
    tools: [...REQUESTED_TOOLS],
    permissions: [...PERMISSIONS],
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    command: ['node', 'scripts/comparison/compaction-continuation.mjs', ...process.argv.slice(2).map(value => value === cli.providerConfig ? '<provider-config>' : value)],
  };
  await writeJson(path.join(outRoot, 'registration.json'), registration, value => value);

  let credentials = null;
  if (cli.mode === 'run') {
    try { credentials = await resolveCredentials(cli); }
    catch (error) { process.stderr.write(`FAIL paid setup: ${errorText(error)}\n`); process.exitCode = 2; return; }
  }
  const redact = makeRedactor(credentials?.key ?? null);

  console.log(`Kodo compaction continuation runner — mode=${cli.mode} out=${outRoot} tasks=${selected.map(fixture => fixture.id).join(',')} model=${cli.model}`);
  console.log(`budgets per task: maxCalls=${cli.maxCalls} maxTokens=${cli.maxTokens} maxContextTokens=${cli.maxContextTokens} maxOutputTokens=${cli.maxOutputTokens}`);
  console.log(`frozen inputs: source=${registration.build.sourceDigest} dist=${registration.build.distDigest} registration=${path.join(outRoot, 'registration.json')}`);
  if (cli.mode === 'dry-run') console.log('dry-run: zero model calls, no credentials, no network; the real summary install path runs through dist/.');

  const context = { cli, mode: cli.mode, outRoot, credentials, seedWorkspace: loaded.seedWorkspace, redact };
  const outcomes = [];
  let stopped = null;
  for (let index = 0; index < selected.length; index++) {
    const fixture = selected[index];
    let outcome;
    try {
      outcome = await runTask(context, fixture);
    } catch (error) {
      console.error(`FAIL ${fixture.id} crashed: ${errorText(error)}`);
      outcome = {
        fixture, passed: false, assertions: [], reportPath: null,
        report: { run: { status: null, error: null }, state: { deterministicFailureCodes: [], transportModelFailures: [], compactionEvents: { 'context.summary.installed': 0 } } },
      };
    }
    outcomes.push(outcome);
    if (cli.mode === 'run') {
      // The registered stop rule is structural: zero installs, deterministic summary
      // failures, model/transport failures or relay rejections. A completed run that
      // installs correctly but fails task acceptance is a quality observation, not a
      // structural stop, so task B still runs and the failure is reported at exit 1.
      const reasons = stopReasonsFor(outcome);
      const remaining = selected.slice(index + 1).map(item => item.id);
      if (remaining.length && reasons.length) {
        stopped = {
          stoppedAfter: fixture.id, skippedTasks: remaining,
          reasons,
          taskReport: outcome.reportPath,
        };
        break;
      }
    }
  }

  if (stopped !== null) {
    stopped.runner = RUNNER_VERSION;
    stopped.mode = cli.mode;
    stopped.createdAt = nowIso();
    stopped.disclaimer = 'Registrations remain frozen. No paid rerun was performed.';
    await writeJson(path.join(outRoot, 'stopped.json'), stopped, redact);
    console.error(redact(`STOP paid run after ${stopped.stoppedAfter}: ${stopped.reasons.join(' | ')}`));
    if (stopped.skippedTasks.length) console.error(`STOP skipped task(s): ${stopped.skippedTasks.join(', ')} (no paid reruns)`);
    console.error(`INFO stop record: ${path.join(outRoot, 'stopped.json')}`);
  }

  const installedTotal = outcomes.reduce((total, outcome) => total + (outcome.report.state?.compactionEvents?.['context.summary.installed'] ?? 0), 0);
  const relayRequests = outcomes.reduce((total, outcome) => total + (outcome.report.relay?.requests ?? 0), 0);
  const failed = outcomes.filter(outcome => !outcome.passed);
  const freezeAfter = captureFreeze(REPOSITORY);
  const freezeComparison = compareFreeze(freezeBefore, freezeAfter);
  let exitCode;
  if (stopped !== null) exitCode = 2;
  else if (failed.length || !freezeComparison.ok) exitCode = 1;
  else exitCode = 0;
  const summary = {
    runner: RUNNER_VERSION,
    protocol: CONTINUATION_PROTOCOL_VERSION,
    mode: cli.mode,
    out: outRoot,
    model: { provider: cli.provider, model: cli.model },
    tasks: selected.map(fixture => fixture.id),
    completedTasks: outcomes.map(outcome => outcome.fixture.id),
    passed: outcomes.length - failed.length,
    failed: failed.map(outcome => outcome.fixture.id),
    taskOutcomes: Object.fromEntries([
      ...outcomes.map(outcome => [outcome.fixture.id, outcome.report.outcome ?? null]),
      ...selected.filter(fixture => !outcomes.some(outcome => outcome.fixture.id === fixture.id)).map(fixture => [fixture.id, classifyContinuationOutcome({ notRun: true, stopped: stopped !== null })]),
    ]),
    freeze: { before: freezeBefore, after: freezeAfter, stable: freezeComparison.ok, changes: freezeComparison.changes },
    installedTotal,
    expectedMinCompactionsTotal: selected.reduce((total, fixture) => total + fixture.expectedMinCompactions, 0),
    relayRequests,
    stopped: stopped === null ? null : { after: stopped.stoppedAfter, skipped: stopped.skippedTasks, reasons: stopped.reasons },
    createdAt: nowIso(),
    passedAll: failed.length === 0 && stopped === null && freezeComparison.ok,
    exitCode,
  };
  try { await writeJson(path.join(outRoot, 'runner.json'), summary, redact); } catch { /* per-task reports remain authoritative */ }

  console.log('');
  console.log(`SUMMARY mode=${cli.mode} tasks=${summary.tasks.join(',')} passed=${summary.passed}/${outcomes.length} installed=${installedTotal}${cli.mode === 'run' ? ` relayRequests=${relayRequests}` : ''}${stopped === null ? '' : ` stoppedAfter=${stopped.stoppedAfter}`} exit=${exitCode}`);
  console.log(cli.mode === 'dry-run'
    ? 'SUMMARY dry-run covers serialization/install/continuation plumbing only; it does not measure semantic quality.'
    : 'SUMMARY paid run records install/usage/verification facts only; it does not claim task quality or cost savings.');
  console.log(`SUMMARY out=${outRoot}`);
  process.exitCode = exitCode;
}

main().catch(error => {
  console.error(`FAIL runner crashed: ${errorText(error)}`);
  if (error?.stack) console.error(error.stack);
  process.exitCode = 1;
});
