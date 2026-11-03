import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import console from 'node:console';
import { appendFileSync, existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { URL } from 'node:url';
import ts from 'typescript';
import { Application } from '../../dist/application/index.js';
import { createBudgetRelay } from './relay.mjs';
import { evaluateTrial, tasks, treeManifest } from './real-tasks.mjs';
import { usageScorecard } from './real-scorecard.mjs';

const VERSION = 'context-assembly-finalization-branch-v1';
const MODEL = 'deepseek-v4.1-flash';
const DEFAULT_PROVIDER_CONFIG = 'C:/Users/admin/.config/opencode/opencode.json';
const DEFAULT_PROVIDER = 'codego1';
const DEFAULT_SOURCE = '.kodo/context-assembly-onboarding-targeted-20261023/onboarding-off-2';
const WORK_TOKENS = 65_536;
const EVIDENCE_TOKENS = 6_553;
const MAX_MODEL_CALLS = 4;
const MAX_TOOL_CALLS = 8;
const MAX_TOKENS = 800_000;
const MAX_OUTPUT_TOKENS = 32_768;
const TOOL_TIMEOUT_MS = 120_000;
const FINALIZATION_EVENT = 'delivery.finalization_started';
const TRACE_TYPES = new Set([
  'delivery.finalization_started', 'context.assembled', 'context.compacted',
  'model.started', 'model.finished', 'model.failed', 'model.retry',
  'tool.started', 'tool.finished', 'tool.stalled', 'run.completed', 'run.failed',
]);

const { values } = parseArgs({ options: {
  root: { type: 'string' },
  source: { type: 'string', default: DEFAULT_SOURCE },
  repeats: { type: 'string', default: '2' },
  provider: { type: 'string', default: DEFAULT_PROVIDER },
  'provider-config': { type: 'string', default: DEFAULT_PROVIDER_CONFIG },
  'dry-run': { type: 'boolean', default: false },
} });

const repository = path.resolve(import.meta.dirname, '..', '..');
const sourceTrial = path.resolve(values.source);
const repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 2) throw new Error('--repeats must be 1 or 2');
const root = path.resolve(values.root ?? path.join(repository, '.kodo', `context-assembly-finalization-branch-${Date.now()}`));
if (existsSync(root)) throw new Error('Use a fresh --root directory; branch evidence is never overwritten');
const sourceState = path.join(sourceTrial, 'kodo-state');
const sourceWorkspace = path.join(sourceTrial, 'workspace');
for (const required of [path.join(sourceState, 'kodo.sqlite'), sourceWorkspace]) if (!existsSync(required)) throw new Error(`Missing branch source ${required}`);

const hash = value => createHash('sha256').update(value).digest('hex');
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const appendLine = (file, value) => appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
const armOptions = arm => arm === 'assembly' ? { assembly: { strategy: 'deterministic', workInputTokens: WORK_TOKENS, evidenceInputTokens: EVIDENCE_TOKENS } } : {};
const rewriteStrings = (value, replacements) => {
  if (typeof value === 'string') return replacements.reduce((text, [from, to]) => text.replaceAll(from, to), value);
  if (Array.isArray(value)) return value.map(item => rewriteStrings(item, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteStrings(item, replacements)]));
  return value;
};

// Keep source extraction synchronous and read-only so no experiment can alter the historical trial.
const fs = process.getBuiltinModule('fs');
const branch = (() => {
  const db = new Database(path.join(sourceState, 'kodo.sqlite'), { readonly: true });
  try {
    const runs = db.prepare('SELECT data FROM runs ORDER BY rowid').all().map(row => JSON.parse(row.data));
    if (runs.length !== 1) throw new Error(`Expected one source run, found ${runs.length}`);
    const run = runs[0];
    const session = JSON.parse(db.prepare('SELECT data FROM sessions WHERE id=?').get(run.sessionId).data);
    const calls = db.prepare('SELECT rowid,data FROM calls WHERE run_id=? ORDER BY rowid').all(run.id).map(row => ({ rowid: row.rowid, ...JSON.parse(row.data) }));
    const blob = ref => JSON.parse(fs.readFileSync(path.join(sourceState, 'blobs', `${ref}.json`), 'utf8'));
    const failed = calls.find(call => {
      if (call.kind !== 'tool' || call.name !== 'file.apply_patch' || call.status !== 'failed') return false;
      const result = blob(call.resultRef);
      if (!String(result.error ?? '').includes('PATH_DENIED')) return false;
      const request = blob(call.requestRef);
      const args = JSON.parse(request.arguments);
      return typeof args.content === 'string' && args.content.includes('# Kodo');
    });
    if (!failed) throw new Error('Could not find the failed absolute REPORT.md write with retained body');
    const reportBody = JSON.parse(blob(failed.requestRef).arguments).content;
    const next = calls.find(call => call.kind === 'model' && call.step > failed.step);
    if (!next) throw new Error('Could not find the next model request after the failed write');
    const request = blob(next.requestRef);
    const messageCallId = failed.id.slice(failed.id.indexOf(':') + 1);
    if (!request.messages.some(message => message.role === 'tool' && message.tool_call_id === messageCallId && String(message.content).includes('PATH_DENIED'))) throw new Error('Branch request does not contain the failed write result');
    if (!request.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === messageCallId && JSON.parse(call.arguments).content === reportBody))) throw new Error('Branch request does not retain the report body');
    return { run, session, failed, next, messages: request.messages, reportBody };
  } finally { db.close(); }
})();

const sourceReport = path.join(sourceWorkspace, 'REPORT.md');
if (existsSync(sourceReport)) throw new Error('Historical source unexpectedly contains REPORT.md; refusing to change the branch condition');
const plan = {
  event: 'finalization-branch.plan', version: VERSION, sourceTrial, root, repeats,
  branch: { sourceRunId: branch.run.id, failedToolStep: branch.failed.step, nextModelStep: branch.next.step, messageCount: branch.messages.length, reportChars: branch.reportBody.length, reportHash: hash(branch.reportBody) },
  arms: ['off', 'assembly'], order: repeats === 1 ? [['off', 'assembly']] : [['off', 'assembly'], ['assembly', 'off']],
  budgets: { maxModelCalls: MAX_MODEL_CALLS, maxToolCalls: MAX_TOOL_CALLS, maxTokens: MAX_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS, workInputTokens: WORK_TOKENS, evidenceInputTokens: EVIDENCE_TOKENS, toolTimeoutMs: TOOL_TIMEOUT_MS },
};
if (values['dry-run']) {
  console.log(JSON.stringify({ ...plan, network: false, credentialsRead: false }));
  process.exit(0);
}

let key = process.env.KODO_API_KEY ?? process.env.OPENAI_API_KEY;
let upstream = process.env.KODO_BASE_URL;
const providerConfigPath = path.resolve(values['provider-config']);
const providerConfig = ts.parseConfigFileTextToJson(providerConfigPath, await readFile(providerConfigPath, 'utf8'));
if (providerConfig.error) throw new Error(`Cannot parse provider configuration ${providerConfigPath}`);
const providerOptions = providerConfig.config?.provider?.[values.provider]?.options;
key ??= providerOptions?.apiKey;
upstream ??= providerOptions?.baseURL;
if (typeof key !== 'string' || !key || typeof upstream !== 'string' || !upstream) throw new Error('Configured provider key and base URL are required');
const endpoint = new URL(upstream);
if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Provider URL must be plain HTTP(S) without credentials or query parameters');

await mkdir(root, { recursive: true });
await writeJson(path.join(root, 'manifest.json'), { ...plan, createdAt: new Date().toISOString(), provider: values.provider, model: MODEL, upstream, limits: { context: 1_000_000, input: WORK_TOKENS, output: MAX_OUTPUT_TOKENS }, design: {
  comparison: 'Two repeated paired continuations from the same persisted request immediately after an absolute REPORT.md write failed.',
  onlyArmDifference: 'Application assembly option is absent or deterministic@65536+6553; branch history, session identity, archived blobs, workspace source, model, tools and delivery budgets are otherwise cloned.',
  order: 'Round 1 off then assembly; round 2 assembly then off. Every failure is retained without selective rerun.',
  scope: 'Diagnostic finalization branch only; it does not replace end-to-end onboarding acceptance or establish statistical superiority.',
} });
const eventsPath = path.join(root, 'events.jsonl');
await writeFile(eventsPath, '', 'utf8');

const task = tasks.find(item => item.id === 'onboarding');
const orders = repeats === 1 ? [['off', 'assembly']] : [['off', 'assembly'], ['assembly', 'off']];
const rows = [];

for (let repeat = 1; repeat <= repeats; repeat++) for (const arm of orders[repeat - 1]) {
  const id = `finalization-${arm}-${repeat}`;
  const directory = path.join(root, id);
  const workspace = path.join(directory, 'workspace');
  const state = path.join(directory, 'kodo-state');
  const wire = path.join(directory, 'wire');
  await mkdir(directory);
  await cp(sourceWorkspace, workspace, { recursive: true });
  await cp(sourceState, state, { recursive: true });
  await mkdir(wire);
  const before = await treeManifest(workspace);
  appendLine(eventsPath, { event: 'trial.started', id, arm, repeat, time: new Date().toISOString() });
  const relay = await createBudgetRelay({ directory: wire, upstream, key, model: MODEL, maxContextChars: Number.MAX_SAFE_INTEGER, maxOutputTokens: MAX_OUTPUT_TOKENS, unrestricted: true });
  process.env.KODO_REAL_TASK_RELAY_KEY = 'fixture-relay-key';
  let app;
  let outcome;
  let inspection = null;
  let calls = [];
  let runtimeEvents = [];
  let cleanupError = null;
  const started = Date.now();
  try {
    app = new Application(state, undefined, undefined, armOptions(arm));
    app.coordinator.mailbox.specs = () => [];
    const binding = { protocol: 'chat-completions', model: MODEL, baseURL: relay.baseURL, apiKeyEnv: 'KODO_REAL_TASK_RELAY_KEY', limits: { context: 1_000_000, input: WORK_TOKENS, output: MAX_OUTPUT_TOKENS } };
    const budget = { ...branch.session.budget, maxTokens: MAX_TOKENS, maxModelCalls: MAX_MODEL_CALLS, maxToolCalls: MAX_TOOL_CALLS, maxDurationMs: 300_000, maxContextTokens: 1_000_000, maxContextChars: null, maxOutputTokens: MAX_OUTPUT_TOKENS, maxConcurrentModels: 1, toolTimeoutMs: TOOL_TIMEOUT_MS };
    const runId = randomUUID();
    const replacements = [
      [branch.run.id, runId],
      [sourceWorkspace, workspace],
      [sourceWorkspace.replaceAll('\\', '/'), workspace.replaceAll('\\', '/')],
    ];
    const objective = rewriteStrings(branch.run.objective, replacements);
    const messages = rewriteStrings(branch.messages, replacements);
    const modelLimits = { context: 1_000_000, input: WORK_TOKENS, output: MAX_OUTPUT_TOKENS, source: 'binding' };
    const run = {
      ...branch.run, id: runId, objective, status: 'queued', binding, modelLimits,
      toolBindings: app.coordinator.tools.bindingSnapshot(branch.run.card.tools, branch.run.card.skills ?? []),
      contextRef: app.store.blob(messages), step: 0, stepCallId: undefined, resultRef: undefined, error: undefined,
      cancelRequested: false, continuationOf: branch.run.id, historyFrom: branch.run.id, inputCursor: undefined,
      waitId: undefined, activeMs: 0, createdAt: new Date().toISOString(),
    };
    app.store.transaction(() => {
      app.store.putSession({ ...branch.session, workspace, budget, modelLimits, modelBudgetCeilings: { maxContextTokens: 1_000_000, maxOutputTokens: MAX_OUTPUT_TOKENS }, tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, activeMs: 0, activeSince: undefined });
      app.store.putRun(run);
      app.store.event(run.id, 'run.queued', { continuationOf: branch.run.id, branchStep: branch.next.step });
    });
    app.store.subscribe(event => { if (event.runId === run.id && TRACE_TYPES.has(event.type)) appendLine(path.join(directory, 'trace.jsonl'), event); });
    const final = await app.run(run.id).catch(error => ({ status: 'failed', error: error.message }));
    const text = final.resultRef ? String(app.store.readBlob(final.resultRef).text ?? '') : '';
    outcome = { status: final.status, error: final.error ?? null, text, runId: run.id };
    calls = app.store.calls(run.id);
    runtimeEvents = app.store.events(run.id);
    try { inspection = app.context(run.id); } catch (error) { inspection = { error: error.message }; }
  } catch (error) {
    outcome = { status: 'failed', error: error.message, text: '', runId: null };
  } finally {
    try { if (app) await app.shutdown(); } catch (error) { cleanupError = error.message; }
    delete process.env.KODO_REAL_TASK_RELAY_KEY;
    await relay.close();
  }
  const executionMs = Date.now() - started;
  const report = await readFile(path.join(workspace, 'REPORT.md'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const evaluation = await evaluateTrial({ repository, source: sourceWorkspace, workspace, directory, task, before, outcome });
  const modelCalls = calls.filter(call => call.kind === 'model');
  const toolCalls = calls.filter(call => call.kind === 'tool');
  const assemblies = runtimeEvents.filter(event => event.type === 'context.assembled');
  const wireStats = globalThis.structuredClone(relay.stats);
  const usage = usageScorecard(wireStats);
  const row = {
    id, arm, repeat, directory, status: outcome.status, error: outcome.error, cleanupError,
    executionMs, finalText: outcome.text, report: { present: Boolean(report), chars: report.length, hash: report ? hash(report) : null, exactBodyReuse: report === branch.reportBody },
    acceptance: evaluation,
    usage,
    relay: { requests: wireStats.requests, contextChars: wireStats.calls.map(call => call.contextChars), elapsedMs: wireStats.calls.map(call => call.elapsedMs), httpStatuses: [...new Set(wireStats.calls.map(call => call.httpStatus ?? null))] },
    calls: { model: modelCalls.length, tool: toolCalls.length, failedTools: toolCalls.filter(call => call.status !== 'succeeded').length, tools: toolCalls.map(call => ({ name: call.name, status: call.status, effect: call.effect })) },
    delivery: { finalizationEvents: runtimeEvents.filter(event => event.type === FINALIZATION_EVENT).map(event => event.data), savedDeliverable: toolCalls.some(call => call.name === 'file.apply_patch' && call.status === 'succeeded'), broadExplorationAttempts: toolCalls.filter(call => ['shell.exec', 'shell_exec', 'process.exec', 'process_exec', 'process.run', 'process_run', 'file.search', 'file_search', 'file.list', 'file_list'].includes(call.name)).map(call => ({ name: call.name, status: call.status })) },
    assembly: { events: assemblies.length, hiddenMessages: assemblies.reduce((total, event) => total + Number(event.data.hiddenOffsets?.length ?? 0), 0), restoredMessages: assemblies.reduce((total, event) => total + Number(event.data.restoredOffsets?.length ?? 0), 0), selectedSourceIds: assemblies.at(-1)?.data.selectedSourceIds ?? [], inspection: inspection?.error ? { error: inspection.error } : { estimatedInputTokens: inspection?.estimatedInputTokens ?? null, hiddenObservations: inspection?.hiddenObservations ?? null, latestAssembly: inspection?.latestAssembly ?? null } },
  };
  rows.push(row);
  await writeJson(path.join(directory, 'result.json'), row);
  appendLine(eventsPath, { event: 'trial.finished', id, arm, repeat, status: row.status, report: row.report, requests: usage.requests, input: usage.input, output: usage.output, executionMs, time: new Date().toISOString() });
  console.log(JSON.stringify({ event: 'trial.finished', id, arm, repeat, status: row.status, report: row.report, requests: usage.requests, input: usage.input, output: usage.output, executionMs }));
}

const armSummary = arm => {
  const selected = rows.filter(row => row.arm === arm);
  const sum = selector => selected.reduce((total, row) => total + selector(row), 0);
  return {
    arm, attempts: selected.length, completed: selected.filter(row => row.status === 'completed').length,
    reports: selected.filter(row => row.report.present).length, exactBodyReuse: selected.filter(row => row.report.exactBodyReuse).length,
    acceptancePassed: selected.filter(row => row.acceptance.passed).length,
    requests: sum(row => row.usage.requests), input: sum(row => row.usage.input), output: sum(row => row.usage.output), totalTokens: sum(row => row.usage.total),
    estimatedCny: { low: sum(row => row.usage.estimatedCny.low), high: sum(row => row.usage.estimatedCny.high) },
    meanExecutionMs: sum(row => row.executionMs) / selected.length,
    toolCalls: sum(row => row.calls.tool), failedTools: sum(row => row.calls.failedTools), broadExplorationAttempts: sum(row => row.delivery.broadExplorationAttempts.length),
    assemblyEvents: sum(row => row.assembly.events), hiddenMessages: sum(row => row.assembly.hiddenMessages), restoredMessages: sum(row => row.assembly.restoredMessages),
  };
};
const result = { version: VERSION, createdAt: new Date().toISOString(), source: plan.branch, rows, summary: [armSummary('off'), armSummary('assembly')], conclusionBoundary: 'Repeated same-state finalization diagnostic; not an end-to-end onboarding benchmark or a default-enable decision.' };
await writeJson(path.join(root, 'results.json'), result);
console.log(JSON.stringify({ event: 'experiment.complete', root, summary: result.summary }));
