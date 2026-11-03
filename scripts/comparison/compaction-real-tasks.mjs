import { appendFileSync, existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import console from 'node:console';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { URL } from 'node:url';
import ts from 'typescript';
import { Application } from '../../dist/application/index.js';
import { createBudgetRelay } from './relay.mjs';
import { tasks, treeManifest, freezeSource, prepareTask, execute, runOracle, evaluateTrial } from './real-tasks.mjs';
import { historicRates, usageScorecard, summarizeTrials } from './real-scorecard.mjs';
import { settleHarnessExecution } from './runner-lifecycle.mjs';

// Real-task context-policy experiment: existing hard-capacity trimming,
// compaction, deterministic assembly, and their explicit combinations.
// The script never takes a credential on the command line; the real key stays
// in this parent process and only a loopback relay is visible to the model.
const EVALUATION_VERSION = 'context-policies-real-tasks-v2';
const FROZEN_MODEL = 'deepseek-v4.1-flash';
const DEFAULT_PROVIDER_CONFIG = 'C:/Users/admin/.config/opencode/opencode.json';
const DEFAULT_PROVIDER = 'codego1';
const DEFAULT_CASES = 'onboarding,pagination,package-versions';
const DEFAULT_ARMS = 'off,mask,summary,hybrid';
const DEFAULT_WORK_TOKENS = 16384;
const MIN_WORK_TOKENS = 1024;
const MAX_WORK_TOKENS = 10_000_000;
const STRATEGIES = ['mask', 'summary', 'hybrid'];
const ARM_NAMES = ['off', ...STRATEGIES, 'assembly', 'assembly-hybrid'];
const COMPACTION_EVENT_TYPES = ['context.assembled', 'context.compacted', 'context.summary.started', 'context.summary.installed', 'context.summary.failed', 'context.summary.skipped', 'context.summary.discarded'];
const TRACE_EVENT_TYPES = new Set(['tool.started', 'tool.finished', 'tool.stalled', 'model.started', 'model.finished', 'model.failed', 'model.retry', 'run.failed', 'run.completed', ...COMPACTION_EVENT_TYPES]);
const PREFLIGHT_INPUT = 'compaction arm preflight 中文 42';
const PREFLIGHT_OBJECTIVE = 'Read input.txt and write exactly the same contents to output.txt using your native tools. Read output.txt to verify it, then report completion. Do not read outside the current directory, install dependencies, ask questions, or invoke another agent.';
const emit = value => console.log(JSON.stringify(value));
const zeroCompactionEvents = () => Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, 0]));
const mean = values => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
const armRecord = arm => ({ arm: arm.name, compactionStrategy: arm.strategy, assembly: arm.assembly, workInputTokens: arm.workInputTokens, evidenceInputTokens: arm.evidenceInputTokens });

function parseArmList(text, fallbackWorkTokens) {
  const entries = String(text).split(',').map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) throw new Error('--arms must name at least one arm: off, mask[:tokens], summary[:tokens], hybrid[:tokens], assembly[:tokens[:evidence]] or assembly-hybrid[:tokens[:evidence]]');
  const seen = new Set();
  return entries.map(entry => {
    const parts = entry.split(':');
    if (parts.length > 3) throw new Error(`Malformed arm ${entry}; see --help for arm syntax`);
    const [name, rawWork, rawEvidence] = parts;
    if (!ARM_NAMES.includes(name)) throw new Error(`Unknown arm ${name}; expected ${ARM_NAMES.join(', ')}`);
    if (name === 'off') {
      if (rawWork !== undefined || rawEvidence !== undefined) throw new Error('The off arm takes no assembly or compaction policy budget');
      if (seen.has('off')) throw new Error('Duplicate arm off');
      seen.add('off');
      return { name: 'off', strategy: null, assembly: false, workInputTokens: null, evidenceInputTokens: null, usesDefaultWorkTokens: false };
    }
    const usesAssembly = name === 'assembly' || name === 'assembly-hybrid';
    if (!usesAssembly && rawEvidence !== undefined) throw new Error(`Arm ${name} does not take an evidence budget`);
    const workInputTokens = rawWork === undefined ? fallbackWorkTokens : Number(rawWork);
    if (!Number.isSafeInteger(workInputTokens) || workInputTokens < MIN_WORK_TOKENS || workInputTokens > MAX_WORK_TOKENS) throw new Error(`Arm ${name} needs workInputTokens ${MIN_WORK_TOKENS}..${MAX_WORK_TOKENS}`);
    const evidenceInputTokens = usesAssembly ? rawEvidence === undefined ? Math.min(8192, Math.floor(workInputTokens * 0.10)) : Number(rawEvidence) : null;
    if (usesAssembly && (!Number.isSafeInteger(evidenceInputTokens) || evidenceInputTokens < 256 || evidenceInputTokens > 1_000_000 || evidenceInputTokens > workInputTokens)) throw new Error(`Arm ${name} needs evidenceInputTokens 256..min(1000000, workInputTokens)`);
    // The same strategy may appear twice with different work budgets (for example
    // hybrid:16384 for trigger-frequency testing and hybrid:65536 for the
    // documented production starting point). The label keeps result directories
    // and summaries apart while the provider strategy stays the same.
    const label = rawWork === undefined && rawEvidence === undefined ? name : `${name}@${workInputTokens}${usesAssembly ? `+${evidenceInputTokens}` : ''}`;
    if (seen.has(label)) throw new Error(`Duplicate arm ${label}`);
    seen.add(label);
    return { name: label, strategy: name === 'assembly-hybrid' ? 'hybrid' : usesAssembly ? null : name, assembly: usesAssembly, workInputTokens, evidenceInputTokens, usesDefaultWorkTokens: rawWork === undefined };
  });
}

const { values } = parseArgs({ options: {
  root: { type: 'string' },
  'provider-config': { type: 'string', default: DEFAULT_PROVIDER_CONFIG },
  provider: { type: 'string', default: DEFAULT_PROVIDER },
  model: { type: 'string', default: FROZEN_MODEL },
  cases: { type: 'string', default: DEFAULT_CASES },
  arms: { type: 'string', default: DEFAULT_ARMS },
  'work-tokens': { type: 'string', default: String(DEFAULT_WORK_TOKENS) },
  repeats: { type: 'string', default: '1' },
  'max-model-calls': { type: 'string', default: '80' },
  'max-tool-calls': { type: 'string', default: '160' },
  'max-tokens': { type: 'string', default: '2000000' },
  'max-output-tokens': { type: 'string', default: '32768' },
  'dry-run': { type: 'boolean', default: false },
  'preflight-only': { type: 'boolean', default: false },
  'controls-only': { type: 'boolean', default: false },
  'allow-delegation': { type: 'boolean', default: false },
} });
const model = values.model;
if (model !== FROZEN_MODEL) throw new Error(`This frozen experiment describes ${FROZEN_MODEL} capacities only; pass --model ${FROZEN_MODEL}`);
if (typeof values.provider !== 'string' || !values.provider.trim()) throw new Error('--provider must be nonempty');
const provider = values.provider.trim();
const repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('--repeats must be 1, 2 or 3');
const workTokens = Number(values['work-tokens']);
if (!Number.isSafeInteger(workTokens) || workTokens < MIN_WORK_TOKENS || workTokens > MAX_WORK_TOKENS) throw new Error(`--work-tokens must be an integer ${MIN_WORK_TOKENS}..${MAX_WORK_TOKENS}`);
const arms = parseArmList(values.arms, workTokens);
if (values['preflight-only'] && values['controls-only']) throw new Error('--preflight-only and --controls-only are mutually exclusive');
const requestedCases = values.cases.split(',').map(entry => entry.trim()).filter(Boolean);
if (!requestedCases.length) throw new Error('--cases must name at least one frozen task');
const knownCases = new Set(tasks.map(task => task.id));
const unknownCases = requestedCases.filter(id => !knownCases.has(id));
if (unknownCases.length) throw new Error(`Unknown cases ${unknownCases.join(', ')}; available: ${tasks.map(task => task.id).join(', ')}`);
const definitions = tasks.filter(task => requestedCases.includes(task.id));
const allowDelegation = values['allow-delegation'];
const numericLimit = (name, minimum = 1) => {
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`--${name} must be a safe integer of at least ${minimum}`);
  return value;
};
const runLimits = { maxModelCalls: numericLimit('max-model-calls'), maxToolCalls: numericLimit('max-tool-calls'), maxTokens: numericLimit('max-tokens'), maxOutputTokens: numericLimit('max-output-tokens') };
if (values['dry-run']) {
  emit({ event: 'context-experiment.dry-run', model, provider, cases: definitions.map(task => task.id), arms, workTokens, repeats, runLimits, network: false, credentialsRead: false });
  process.exit(0);
}

// Resolve the existing provider configuration exactly like the current
// benchmark: environment overrides first, then the local OpenCode provider
// file. The key is read here and never serialized below.
let key = process.env.KODO_API_KEY ?? process.env.OPENAI_API_KEY;
let upstream = process.env.KODO_BASE_URL;
const providerConfigPath = path.resolve(values['provider-config']);
let providerConfigText;
try { providerConfigText = await readFile(providerConfigPath, 'utf8'); }
catch (error) { throw new Error(`Cannot read --provider-config for provider ${provider} (${error.code ?? 'read error'}); environment variables remain supported`, { cause: error }); }
const providerConfig = ts.parseConfigFileTextToJson(providerConfigPath, providerConfigText);
if (providerConfig.error) throw new Error(`Cannot parse --provider-config for provider ${provider}`);
const providerOptions = providerConfig.config?.provider?.[provider]?.options;
key ??= providerOptions?.apiKey;
upstream ??= providerOptions?.baseURL;
if (typeof key !== 'string' || !key || typeof upstream !== 'string' || !upstream) throw new Error('Configure the existing provider through environment variables or --provider-config; never pass a key on the command line');
let endpoint;
try { endpoint = new URL(upstream); } catch { throw new Error('Provider URL is not a valid absolute URL'); }
if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Provider URL must be plain HTTP(S) without credentials or query parameters');

const redact = text => text.replaceAll(key, '[redacted]');
const redactedJson = value => redact(JSON.stringify(value, null, 2));
const writeJson = (file, value) => writeFile(file, redactedJson(value));
const appendLine = (file, value) => appendFileSync(file, redact(JSON.stringify(value)) + '\n');

const repository = path.resolve(import.meta.dirname, '..', '..');
const root = path.resolve(values.root ?? path.join(repository, '.kodo', `compaction-real-tasks-${Date.now()}`));
if (existsSync(root)) throw new Error('Use a fresh --root directory; previous evidence is never overwritten');
await mkdir(root, { recursive: true });
const source = path.join(root, 'source');
const frozen = await freezeSource(repository, source);
const sourceHash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
const runtimeFiles = await treeManifest(path.join(repository, 'dist'));
const runnerFiles = await treeManifest(import.meta.dirname);
const limits = { contextWindowTokens: 1000000, maxOutputTokens: runLimits.maxOutputTokens, maxDurationMs: 900000, maxConcurrentModels: 1, toolTimeoutMs: 120000, permissions: ['read', 'write', 'exec'] };
const host = { platform: process.platform, release: os.release(), node: process.version, cpu: os.cpus()[0]?.model ?? null };
const manifest = {
  evaluationVersion: EVALUATION_VERSION,
  createdAt: new Date().toISOString(),
  model,
  provider,
  upstream,
  sourceHash,
  runtimeHash: createHash('sha256').update(JSON.stringify(runtimeFiles)).digest('hex'),
  runnerHash: createHash('sha256').update(JSON.stringify(runnerFiles)).digest('hex'),
  runtimeFiles: Object.fromEntries(runtimeFiles),
  runnerFiles: Object.fromEntries(runnerFiles),
  sampling: { temperature: 'provider default (not set)', seed: 'not set' },
  cases: definitions,
  arms,
  workTokens,
  repeats,
  host,
  limits: {
    model: { contextWindowTokens: limits.contextWindowTokens, maxOutputTokens: limits.maxOutputTokens },
    run: { maxDurationMs: limits.maxDurationMs, maxModelCalls: runLimits.maxModelCalls, maxTokens: runLimits.maxTokens, maxToolCalls: runLimits.maxToolCalls, maxContextTokens: limits.contextWindowTokens, maxInputTokens: null, maxContextChars: null, maxOutputTokens: limits.maxOutputTokens, maxConcurrentModels: limits.maxConcurrentModels, toolTimeoutMs: limits.toolTimeoutMs, permissions: limits.permissions },
    relay: { unrestricted: true, maxContextChars: Number.MAX_SAFE_INTEGER, maxOutputTokens: limits.maxOutputTokens, scope: 'loopback-only; the real credential never leaves this parent process' },
  },
  source: Object.fromEntries(frozen),
  accounting: {
    tokens: 'Upstream HTTP usage reported by the provider; cache/reasoning subsets are not added twice; unknown usage retains reservations and is reported as unknown, never as billing',
    costBasis: historicRates,
    scope: 'All arms share the same model, tools, output limits and frozen source hash per task; summary/auxiliary requests and recovery reads count toward total input tokens',
    notBilling: 'Historic default-group rates are estimates; the provider usage endpoint is not an invoice and no currency deduction is claimed',
  },
  design: {
    comparison: 'Explicit arms compare hard-capacity trimming, compaction, deterministic assembly, and assembly plus hybrid under the same declared input and run budgets',
    groups: { off: 'existing hard-capacity trimming', mask: 'batch hide old observation bodies behind read pointers', summary: 'bounded model-generated task summary', hybrid: 'mask then summary when still over budget', assembly: 'deterministic relevant-evidence projection without an auxiliary model', 'assembly-hybrid': 'deterministic projection with hybrid as capacity fallback' },
    experimentalSwitch: 'Compaction and assembly remain default-off; selecting an arm changes only this experiment',
    pairing: 'Same frozen source hash, model, tool set, output limits and held-out acceptance per task; fully serial execution with an interleaved arm rotation and a reversed second round to reduce order bias; no best-of reruns',
    sampleSize: 'Small exploratory matrix (cases × arms × repeats, repeats ≤ 3). Descriptive only: no statistical significance and no equivalence claim; C4 §11 requires at least 20 paired tasks per group before any default-enable decision',
    endpoints: 'Primary endpoint is complete delivery rate (acceptance.passed); constraint violations, key-fact accuracy and recovery reads are reported separately, never collapsed into one weighted average',
    order: 'Controls (data-independent held-out oracles) run before any model attempt; preflight runs each arm once on a minimal read/write task',
    costAccounting: 'Reported per trial from the relay: requests, prompt/completion tokens, estimated CNY using historic rates, and request context length distribution (max/mean contextChars); summary requests are identified by backend call purpose=compaction',
    delegation: allowDelegation
      ? 'Autonomous diagnostic: collaboration tools remain exposed and the task does not require or forbid delegation; creation, planning and child inspection are counted separately.'
      : 'Disabled for the frozen context-policy comparison; tasks explicitly require independent completion without a child.',
  },
};
await writeJson(path.join(root, 'manifest.json'), manifest);
const eventsPath = path.join(root, 'events.jsonl');
await writeFile(eventsPath, '');
emit({ event: 'context-benchmark.preparing', root, model, provider, sourceHash, cases: definitions.map(task => task.id), arms: arms.map(armRecord), workTokens, repeats, runLimits });

function applicationOptions(arm) {
  return {
    ...(arm.strategy ? { compaction: { strategy: arm.strategy, workInputTokens: arm.workInputTokens } } : {}),
    ...(arm.assembly ? { assembly: { strategy: 'deterministic', workInputTokens: arm.workInputTokens, evidenceInputTokens: arm.evidenceInputTokens } } : {}),
  };
}

function summarizeRelay(stats, compaction) {
  const contextChars = stats.calls.map(call => call.contextChars);
  return {
    requests: stats.requests,
    estimatedUsage: stats.estimated,
    rejected: stats.rejected,
    summaryRequests: compaction.summaryModelCalls,
    contextChars: { count: contextChars.length, max: contextChars.length ? Math.max(...contextChars) : null, mean: mean(contextChars), total: contextChars.reduce((total, value) => total + value, 0) },
    requestedOutput: [...new Set(stats.calls.map(call => call.requestedOutput ?? null))],
    httpStatuses: [...new Set(stats.calls.map(call => call.httpStatus ?? 'transport-error'))],
    calls: stats.calls.map(call => ({ index: call.index, contextChars: call.contextChars, requestedOutput: call.requestedOutput ?? null, outputLimit: call.outputLimit, httpStatus: call.httpStatus ?? null, estimated: !call.usage, usage: call.usage ? { prompt: call.usage.prompt_tokens ?? null, completion: call.usage.completion_tokens ?? null } : null })),
  };
}

function collectCompaction(app, run, arm) {
  const runs = app.store.listRuns(run.sessionId);
  const events = runs.flatMap(owner => app.store.events(owner.id)).sort((left, right) => left.seq - right.seq);
  const eventCounts = Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, events.filter(event => event.type === type).length]));
  const installed = events.filter(event => event.type === 'context.summary.installed');
  const latestInstalled = installed.at(-1);
  const calls = runs.flatMap(owner => app.store.calls(owner.id));
  const modelCalls = calls.filter(call => call.kind === 'model');
  const summaryModelCalls = modelCalls.filter(call => call.purpose === 'compaction').length;
  const mainModelCalls = modelCalls.filter(call => call.runId === run.id && call.purpose !== 'compaction');
  const delegationCalls = calls.filter(call => call.runId === run.id && call.kind === 'tool' && ['spawn_agent', 'exploration.plan'].includes(call.name));
  const childRuns = runs.filter(owner => owner.parentId === run.id);
  const childInspections = calls.filter(call => call.runId === run.id && call.kind === 'tool' && call.name === 'inspect_run');
  let inspection;
  try { inspection = app.context(run.id); }
  catch (error) { inspection = { error: error.message }; }
  const inspectionRow = inspection.error ? { available: false, error: inspection.error } : {
    available: true,
    estimatedInputTokens: inspection.estimatedInputTokens,
    parts: inspection.parts,
    messageCount: inspection.messageCount,
    hiddenObservations: inspection.hiddenObservations,
    latestCompaction: inspection.latestCompaction,
    latestAssembly: inspection.latestAssembly,
    summary: inspection.summary ? { present: true, ref: inspection.summary.ref, sources: inspection.summary.sources, coveredOffsets: inspection.summary.coveredOffsets, previousSummaryRef: inspection.summary.previousSummaryRef ?? null, beforeTokens: inspection.summary.beforeTokens, afterTokens: inspection.summary.afterTokens, contentChars: inspection.summary.content.length } : { present: false },
    usage: inspection.usage,
  };
  return {
    policy: { compaction: arm.strategy ? { strategy: arm.strategy, workInputTokens: arm.workInputTokens } : null, assembly: arm.assembly ? { strategy: 'deterministic', workInputTokens: arm.workInputTokens, evidenceInputTokens: arm.evidenceInputTokens } : null },
    events: eventCounts,
    summaryModelCalls,
    modelCalls: modelCalls.length,
    toolCalls: calls.filter(call => call.kind === 'tool').length,
    delegation: {
      enabled: allowDelegation,
      eligibleMainModelRequests: allowDelegation ? mainModelCalls.length : 0,
      attempted: delegationCalls.length > 0,
      toolCalls: delegationCalls.length,
      spawnCalls: delegationCalls.filter(call => call.name === 'spawn_agent').length,
      explorationPlanCalls: delegationCalls.filter(call => call.name === 'exploration.plan').length,
      childrenCreated: childRuns.length,
      childrenCompleted: childRuns.filter(child => child.status === 'completed').length,
      childInspectionCalls: childInspections.length,
      successfulChildInspectionCalls: childInspections.filter(call => call.status === 'succeeded').length,
    },
    latestInstalledSummary: latestInstalled ? { beforeTokens: latestInstalled.data.beforeTokens ?? null, afterTokens: latestInstalled.data.afterTokens ?? null, targetMet: latestInstalled.data.targetMet ?? null, sources: latestInstalled.data.sources ?? null, coveredOffsets: latestInstalled.data.coveredOffsets ?? null } : null,
    inspection: inspectionRow,
  };
}

function failedCompaction(arm, reason) {
  return { policy: { compaction: arm.strategy ? { strategy: arm.strategy, workInputTokens: arm.workInputTokens } : null, assembly: arm.assembly ? { strategy: 'deterministic', workInputTokens: arm.workInputTokens, evidenceInputTokens: arm.evidenceInputTokens } : null }, events: zeroCompactionEvents(), summaryModelCalls: 0, modelCalls: 0, toolCalls: 0, delegation: { enabled: allowDelegation, eligibleMainModelRequests: 0, attempted: false, toolCalls: 0, spawnCalls: 0, explorationPlanCalls: 0, childrenCreated: 0, childrenCompleted: 0, childInspectionCalls: 0, successfulChildInspectionCalls: 0 }, latestInstalledSummary: null, inspection: { available: false, error: reason } };
}

async function runHarness(arm, workspace, directory, objective, relay) {
  const traceEvents = [];
  const trace = (type, data) => { const event = { type, time: Date.now(), ...data }; traceEvents.push(event); appendLine(path.join(directory, 'trace.jsonl'), event); };
  process.env.KODO_REAL_TASK_RELAY_KEY = 'fixture-relay-key';
  let app;
  let execution;
  let executionError;
  let cleanupError;
  try {
    app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, applicationOptions(arm));
    if (!allowDelegation) app.coordinator.mailbox.specs = () => [];
    const run = app.createRun({ objective, workspace, binding: { protocol: 'chat-completions', model, baseURL: relay.baseURL, apiKeyEnv: 'KODO_REAL_TASK_RELAY_KEY', limits: { context: limits.contextWindowTokens, output: limits.maxOutputTokens } }, permissions: limits.permissions, budget: { maxTokens: runLimits.maxTokens, maxModelCalls: runLimits.maxModelCalls, maxToolCalls: runLimits.maxToolCalls, maxDurationMs: limits.maxDurationMs, maxContextTokens: limits.contextWindowTokens, maxContextChars: null, maxOutputTokens: limits.maxOutputTokens, maxConcurrentModels: limits.maxConcurrentModels, toolTimeoutMs: limits.toolTimeoutMs } });
    app.store.subscribe(event => { if (TRACE_EVENT_TYPES.has(event.type)) trace(event.type, { runId: event.runId, ...event.data }); });
    const started = Date.now();
    let final;
    try { final = await app.run(run.id); }
    catch (error) { final = { status: 'failed', error: error.message, resultRef: undefined }; }
    let text;
    try { text = final.resultRef ? String(app.store.readBlob(final.resultRef).text ?? '') : ''; }
    catch { text = ''; }
    const calls = app.store.calls(run.id);
    const parts = calls.filter(call => call.kind === 'tool').map(call => ({ id: call.id, failed: call.status !== 'succeeded' }));
    execution = {
      outcome: { status: final.status, error: final.error ?? null, text, executionMs: Date.now() - started, runId: run.id, calls },
      traceEvents,
      tools: { total: new Set(parts.map(part => part.id)).size, failed: parts.filter(part => part.failed).length },
      compaction: collectCompaction(app, run, arm),
    };
  } catch (error) {
    executionError = error;
  } finally {
    try { if (app) await app.shutdown(); }
    catch (error) {
      cleanupError = error;
      trace('runner.cleanup_failed', { error: error instanceof Error ? error.message : String(error) });
    }
    finally { delete process.env.KODO_REAL_TASK_RELAY_KEY; }
  }
  return settleHarnessExecution(execution, executionError, cleanupError);
}

async function trialExecution(arm, workspace, directory, objective) {
  const wire = path.join(directory, 'wire');
  await mkdir(wire, { recursive: true });
  await writeFile(path.join(directory, 'trace.jsonl'), '');
  const relay = await createBudgetRelay({ directory: wire, upstream, key, model, maxContextChars: Number.MAX_SAFE_INTEGER, maxOutputTokens: limits.maxOutputTokens, unrestricted: true });
  let execution;
  const started = Date.now();
  try { execution = await runHarness(arm, workspace, directory, objective, relay); }
  catch (error) { execution = { outcome: { status: 'failed', error: error.message, text: '', executionMs: Date.now() - started, runId: null, calls: [] }, traceEvents: [], tools: { total: 0, failed: 0 }, compaction: failedCompaction(arm, 'run failed before inspection') }; }
  finally { await relay.close(); }
  const wireStats = globalThis.structuredClone(relay.stats);
  await writeJson(path.join(directory, 'outcome.json'), execution.outcome);
  return { ...execution, executionMs: execution.outcome.executionMs ?? Date.now() - started, wire: summarizeRelay(wireStats, execution.compaction), usage: usageScorecard(wireStats) };
}

async function runPreflight() {
  const rows = [];
  for (const arm of arms) {
    const directory = path.join(root, `preflight-${arm.name}`);
    const workspace = path.join(directory, 'workspace');
    await mkdir(directory);
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'input.txt'), PREFLIGHT_INPUT);
    emit({ event: 'preflight.started', ...armRecord(arm), directory });
    let result;
    const started = Date.now();
    try { result = await trialExecution(arm, workspace, directory, PREFLIGHT_OBJECTIVE); }
    catch (error) {
      result = { outcome: { status: 'failed', error: error.message, text: '', executionMs: Date.now() - started }, tools: { total: 0, failed: 0 }, wire: { requests: 0, contextChars: { count: 0, max: null, mean: null }, requestedOutput: [], summaryRequests: 0, calls: [] }, usage: usageScorecard({ requests: 0, calls: [] }), compaction: failedCompaction(arm, 'preflight failed before inspection') };
    }
    let copied;
    try { copied = await readFile(path.join(workspace, 'output.txt'), 'utf8'); }
    catch { copied = ''; }
    const outputMatches = copied === PREFLIGHT_INPUT;
    const textPresent = Boolean(result.outcome.text?.trim());
    const passed = result.outcome.status === 'completed' && textPresent && outputMatches && result.wire.requests >= 2;
    const row = {
      ...armRecord(arm), passed,
      status: result.outcome.status, error: result.outcome.error ?? null,
      requests: result.wire.requests, outputMatches, textPresent,
      executionMs: result.executionMs,
      cleanupError: result.cleanupError ?? null,
      usage: result.usage,
      relayContextChars: result.wire.contextChars,
      requestedOutput: result.wire.requestedOutput,
      compaction: { events: result.compaction.events, summaryModelCalls: result.compaction.summaryModelCalls, inspection: { hiddenObservations: result.compaction.inspection.hiddenObservations ?? null, summaryPresent: result.compaction.inspection.summary?.present ?? false, available: result.compaction.inspection.available } },
    };
    rows.push(row);
    await writeJson(path.join(directory, 'result.json'), row);
    emit({ event: 'preflight.finished', ...armRecord(arm), passed, status: row.status, error: row.error, requests: row.requests, outputMatches, textPresent, usage: row.usage });
  }
  const preflight = { evaluationVersion: EVALUATION_VERSION, createdAt: new Date().toISOString(), model, provider, upstream, sourceHash, arms: arms.map(armRecord), rows };
  await writeJson(path.join(root, 'preflight.json'), preflight);
  emit({ event: 'preflight.complete', root, passed: rows.every(row => row.passed), rows: rows.map(row => ({ arm: row.arm, passed: row.passed, requests: row.requests, status: row.status })) });
  if (rows.some(row => !row.passed)) process.exitCode = 1;
}

async function runControls() {
  const controlTasks = definitions.filter(task => task.id !== 'onboarding');
  const rows = [];
  if (!controlTasks.length) {
    emit({ event: 'control.skipped', reason: 'no data-independent held-out control task selected' });
    await writeJson(path.join(root, 'controls.json'), { evaluationVersion: EVALUATION_VERSION, createdAt: new Date().toISOString(), rows });
    return;
  }
  // Held-out oracles must reject the unmodified regression and accept the
  // reference fix before any arm is allowed to spend model tokens.
  for (const task of controlTasks) {
    for (const positive of [false, true]) {
      const kind = positive ? 'positive' : 'negative';
      const directory = path.join(root, `control-${task.id}-${kind}`);
      const workspace = path.join(directory, 'workspace');
      await mkdir(directory);
      await prepareTask(source, workspace, task, repository);
      if (positive && task.id === 'pagination') await cp(path.join(source, 'src/runtime/history.ts'), path.join(workspace, 'src/runtime/history.ts'));
      if (positive && task.id === 'package-versions') {
        const registry = path.join(workspace, 'src/packages/registry.ts'); const code = await readFile(registry, 'utf8');
        const reference = '  async versions(id: string): Promise<{version:string;digest:string}[]> { identity(id); return (await this.list()).filter(item=>item.card.id===id).map(item=>({version:item.card.version,digest:item.digest})).sort((a,b)=>{const x=a.version.split(\'.\').map(Number),y=b.version.split(\'.\').map(Number);return y[0]!-x[0]!||y[1]!-x[1]!||y[2]!-x[2]!;}); }\n';
        await writeFile(registry, code.replace('  async provenance(', reference + '  async provenance('));
        const cli = path.join(workspace, 'src/cli/packages.ts'); let cliCode = await readFile(cli, 'utf8');
        cliCode = cliCode.replace("['export', 'inspect', 'import', 'list',", "['versions', 'export', 'inspect', 'import', 'list',");
        cliCode = cliCode.replace('  let result: unknown;', "  if(command==='versions'){console.log(JSON.stringify(await registry.versions(argument!)));return;}\n  let result: unknown;");
        await writeFile(cli, cliCode); await writeFile(path.join(workspace, 'docs/capability-packages.md'), 'kodo package versions author/name');
      }
      const build = await execute(process.execPath, [path.join(repository, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], workspace, path.join(directory, 'build.json'));
      if (build.code !== 0) throw new Error(`Control build failed: ${task.id}/${kind}`);
      const oracle = await runOracle(workspace, directory, task); const all = oracle.checks.every(check => check.passed);
      await writeJson(path.join(directory, 'control.json'), { positive, all, checks: oracle.checks });
      if (positive !== all) throw new Error(`Held-out oracle control invalid: ${task.id}/${kind}; see ${directory}`);
      rows.push({ task: task.id, kind, positive, all, checks: oracle.checks });
      emit({ event: 'control.passed', task: task.id, kind, checks: oracle.checks.length });
    }
  }
  await writeJson(path.join(root, 'controls.json'), { evaluationVersion: EVALUATION_VERSION, createdAt: new Date().toISOString(), rows });
}

function compactAcceptance(acceptance = {}) {
  return { passed: acceptance.passed ?? false, score: acceptance.score ?? 0, coverage: acceptance.coverage ?? 0, criteria: acceptance.criteria ?? [], changed: acceptance.changed ?? [], ...(acceptance.manualFactualReviewRequired ? { manualFactualReviewRequired: true } : {}), ...(acceptance.error ? { error: acceptance.error } : {}) };
}

function buildSummary(rows) {
  const byArm = summarizeTrials(rows);
  const compaction = arms.map(arm => {
    const armRows = rows.filter(row => row.arm === arm.name);
    const valuesOf = selector => armRows.map(selector);
    const sum = selector => armRows.reduce((total, row) => total + selector(row), 0);
    const eventCounts = Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, sum(row => row.compaction?.events?.[type] ?? 0)]));
    const peakInputs = valuesOf(row => row.compaction?.inspection?.usage?.peakInput ?? 0);
    const estimatedPeakInputs = valuesOf(row => row.compaction?.inspection?.usage?.estimatedPeakInput ?? 0);
    const hidden = valuesOf(row => row.compaction?.inspection?.hiddenObservations ?? 0);
    return {
      ...armRecord(arm), attempts: armRows.length,
      completed: armRows.filter(row => row.status === 'completed').length,
      compactionEvents: eventCounts,
      trialsWithCompaction: armRows.filter(row => Object.values(row.compaction?.events ?? {}).some(value => value > 0)).length,
      trialsWithAssembly: armRows.filter(row => (row.compaction?.events?.['context.assembled'] ?? 0) > 0).length,
      trialsWithInstalledSummary: armRows.filter(row => (row.compaction?.events?.['context.summary.installed'] ?? 0) > 0).length,
      summaryModelCalls: sum(row => row.compaction?.summaryModelCalls ?? 0),
      delegation: {
        enabled: allowDelegation,
        eligibleTrials: armRows.filter(row => row.compaction?.delegation?.enabled).length,
        delegatedTrials: armRows.filter(row => row.compaction?.delegation?.attempted).length,
        trialRate: armRows.length ? Number((armRows.filter(row => row.compaction?.delegation?.attempted).length / armRows.length).toFixed(4)) : null,
        eligibleMainModelRequests: sum(row => row.compaction?.delegation?.eligibleMainModelRequests ?? 0),
        toolCalls: sum(row => row.compaction?.delegation?.toolCalls ?? 0),
        childrenCreated: sum(row => row.compaction?.delegation?.childrenCreated ?? 0),
        childrenCompleted: sum(row => row.compaction?.delegation?.childrenCompleted ?? 0),
        successfulChildInspectionCalls: sum(row => row.compaction?.delegation?.successfulChildInspectionCalls ?? 0),
      },
      totalRecoveryReads: sum(row => row.compaction?.inspection?.usage?.recoveryReads ?? 0),
      maxPeakInput: Math.max(0, ...peakInputs),
      maxEstimatedPeakInput: Math.max(0, ...estimatedPeakInputs),
      meanEstimatedPeakInput: mean(estimatedPeakInputs),
      meanHiddenObservations: mean(hidden),
      maxHiddenObservations: Math.max(0, ...hidden),
      requests: sum(row => row.relay?.requests ?? 0),
      maxRequestContextChars: Math.max(0, ...valuesOf(row => row.relay?.contextChars?.max ?? 0)),
      meanRequestContextChars: mean(valuesOf(row => row.relay?.contextChars?.mean).filter(value => value !== null)),
    };
  });
  return { byArm, compaction };
}

/** Summary aggregation must never abort a long evidence run; rows stay authoritative. */
function safeSummary(rows) {
  try { return buildSummary(rows); }
  catch (error) { emit({ event: 'summary.failed', error: error.message }); return { byArm: [], compaction: [], error: error.message }; }
}

async function runMatrix() {
  const results = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const [index, task] of definitions.entries()) {
      const rotated = [...arms.slice(index % arms.length), ...arms.slice(0, index % arms.length)];
      const order = repeat % 2 ? rotated : rotated.toReversed();
      for (const arm of order) {
        const id = `${task.id}-${arm.name}-${repeat}`;
        const directory = path.join(root, id);
        const workspace = path.join(directory, 'workspace');
        await mkdir(directory);
        await prepareTask(source, workspace, task, repository);
        const before = await treeManifest(workspace);
        emit({ event: 'trial.started', id, task: task.id, ...armRecord(arm), repeat, directory });
        const autonomyInstruction = allowDelegation
          ? '是否委派由你根据任务的实际独立子问题自行判断；不要为了填充并发而创建子代理。'
          : '请独立完成，无需子代理。';
        const objective = `当前项目副本绝对路径为 ${workspace}；全部源码读取和命令均应在此副本中进行。祖先目录只提供依赖可执行文件，不是任务源码位置。先阅读 START_HERE.md。${task.objective}\n仅使用当前项目副本，不读取父目录源码、其他试验或评测程序。${autonomyInstruction}不向用户提问。`;
        const started = Date.now();
        let execution;
        try { execution = await trialExecution(arm, workspace, directory, objective); }
        catch (error) {
          execution = { outcome: { status: 'failed', error: error.message, text: '', executionMs: Date.now() - started }, tools: { total: 0, failed: 0 }, wire: { requests: 0, contextChars: { count: 0, max: null, mean: null }, requestedOutput: [], summaryRequests: 0, calls: [] }, usage: usageScorecard({ requests: 0, calls: [] }), compaction: failedCompaction(arm, 'trial failed before inspection'), executionMs: Date.now() - started };
        }
        let acceptance;
        try { acceptance = await evaluateTrial({ repository, source, workspace, directory, task, before, outcome: execution.outcome }); }
        catch (error) { acceptance = { passed: false, score: 0, coverage: 0, criteria: [{ name: 'held-out acceptance evaluation completed', passed: false, error: error.message }], changed: [], error: error.message }; }
        const row = { id, task: task.id, profile: arm.name, ...armRecord(arm), repeat, directory, status: execution.outcome.status, error: execution.outcome.error ?? null, cleanupError: execution.cleanupError ?? null, text: execution.outcome.text ?? '', executionMs: execution.executionMs, evaluationTotalMs: Date.now() - started, tools: execution.tools, usage: execution.usage, acceptance, compaction: execution.compaction, relay: execution.wire };
        results.push(row);
        await writeJson(path.join(directory, 'result.json'), row);
        if (!row.compaction) emit({ event: 'trial.warning', id, warning: 'compaction telemetry missing' });
        const summary = safeSummary(results);
        await writeJson(path.join(root, 'results.json'), { evaluationVersion: EVALUATION_VERSION, createdAt: manifest.createdAt, model, provider, sourceHash, arms: arms.map(armRecord), results: results.map(result => ({ ...result, acceptance: compactAcceptance(result.acceptance) })), summary });
        await writeJson(path.join(root, 'summary.json'), summary);
        appendLine(eventsPath, { event: 'trial', id, task: task.id, ...armRecord(arm), repeat, status: row.status, passed: acceptance.passed, score: acceptance.score, coverage: acceptance.coverage, executionMs: row.executionMs, evaluationTotalMs: row.evaluationTotalMs, usage: row.usage, compactionEvents: row.compaction.events, summaryModelCalls: row.compaction.summaryModelCalls, hiddenObservations: row.compaction.inspection?.hiddenObservations ?? null, error: row.error ?? null });
        emit({ event: 'trial.finished', id, task: task.id, ...armRecord(arm), repeat, status: row.status, passed: acceptance.passed, score: acceptance.score, coverage: acceptance.coverage, seconds: row.executionMs / 1000, usage: row.usage, compactionEvents: row.compaction.events, summaryModelCalls: row.compaction.summaryModelCalls, failedCriteria: (acceptance.criteria ?? []).filter(check => !check.passed).map(check => check.name) });
      }
    }
  }
  const summary = safeSummary(results);
  await writeJson(path.join(root, 'summary.json'), summary);
  emit({ event: 'matrix.finished', root, attempts: results.length, summary });
  if (results.some(row => !row.acceptance.passed)) process.exitCode = 1;
}

if (values['preflight-only']) await runPreflight();
else {
  await runControls();
  if (!values['controls-only']) await runMatrix();
}
