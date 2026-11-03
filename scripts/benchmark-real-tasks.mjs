import { appendFileSync, existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { parseArgs } from 'node:util';
import { URL } from 'node:url';
import ts from 'typescript';
import { Application } from '../dist/application/index.js';
import { createBudgetRelay } from './comparison/relay.mjs';
import { runOpenCode } from './comparison/opencode.mjs';
import { piEntry, runPiNative } from './comparison/pi-native.mjs';
import { tasks, treeManifest, freezeSource, prepareTask, execute, runOracle, evaluateTrial } from './comparison/real-tasks.mjs';
import { historicRates, usageScorecard, summarizeTrials } from './comparison/real-scorecard.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, 'provider-config': { type: 'string' }, provider: { type: 'string', default: 'codego1' }, model: { type: 'string', default: 'deepseek-v4.1-flash' }, repeats: { type: 'string', default: '2' }, profiles: { type: 'string', default: 'kodo,pi,opencode' }, cases: { type: 'string', default: 'onboarding,pagination,package-versions' }, 'preflight-only': { type: 'boolean' }, 'controls-only': { type: 'boolean' } } });
const repository = path.resolve(import.meta.dirname, '..');
const model = values.model;
if (model !== 'deepseek-v4.1-flash') throw new Error('This frozen experiment describes deepseek-v4.1-flash capacities and rates only');
let key = process.env.KODO_API_KEY ?? process.env.OPENAI_API_KEY;
let upstream = process.env.KODO_BASE_URL;
if (values['provider-config']) {
  const file = path.resolve(values['provider-config']);
  const parsed = ts.parseConfigFileTextToJson(file, await readFile(file, 'utf8'));
  if (parsed.error) throw new Error('Cannot parse local provider configuration');
  const options = parsed.config?.provider?.[values.provider]?.options;
  key ??= options?.apiKey; upstream ??= options?.baseURL;
}
if (!key || !upstream) throw new Error('Configure the existing provider through environment variables or --provider-config; never pass a key on the command line');
const endpoint = new URL(upstream);
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Provider URL must not contain credentials or query parameters');
const profiles = values.profiles.split(',');
if (profiles.some(profile => !['kodo', 'pi', 'opencode'].includes(profile)) || new Set(profiles).size !== profiles.length) throw new Error('Profiles must be unique native harness IDs');
const definitions = tasks.filter(task => values.cases.split(',').includes(task.id));
if (!definitions.length) throw new Error('No benchmark cases selected');
const repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('repeats must be 1..3');
const root = path.resolve(values.root ?? path.join(repository, '.kodo', `real-tasks-${Date.now()}`));
if (existsSync(root)) throw new Error('Use a fresh root; previous evidence is never overwritten');
await mkdir(root, { recursive: true });
const source = path.join(root, 'source');
const frozen = await freezeSource(repository, source);
const limits = { contextWindowTokens: 1000000, maxOutputTokens: 393216, timeoutMs: 900000 };
const manifest = { evaluationVersion: 'native-real-tasks-v2', createdAt: new Date().toISOString(), model, upstream, repeats, profiles, tasks: definitions, limits,
  source: Object.fromEntries(frozen), environment: { platform: process.platform, release: os.release(), node: process.version, cpu: os.cpus()[0]?.model },
  harnesses: { kodo: { version: JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version, identity: 'current uncommitted frozen working tree', hash: createHash('sha256').update(JSON.stringify(frozen)).digest('hex') }, pi: { version: '1.3.0', kind: 'complete native Pi Coding Agent CLI, native prompt/tools/context/retries', entrySha256: createHash('sha256').update(await readFile(piEntry)).digest('hex') }, opencode: JSON.parse(await readFile(path.join(repository, '.kodo/competitor-sources/opencode/info.json'), 'utf8')) },
  accounting: { tokens: 'Upstream HTTP usage, cache/reasoning subsets not added twice; HTTP429=0 under the previous user accounting rule; other missing usage unknown', costs: historicRates, actualBilling: 'Token is unlimited; usage endpoint total_used=0 is not a usable invoice. Historic default-group estimate is separate from measured tokens; no claim of actual currency deduction.', startup: 'Kodo measures Application.run only (construction/createRun/shutdown excluded); native Pi/OpenCode include CLI startup; agent verification included; independent evaluation and native export excluded', preflight: 'Separate raw evidence and costs, never pooled into task scores' },
  design: { order: 'Round one task-specific rotation; round two reversed rotations; serial execution; no best-of reruns', contexts: 'All declare 1M combined window and384K output; actual outgoing limits audited separately', isolation: 'Independent project copies and native state; real credentials stay in parent relay; external skills/plugins/user instructions disabled', singleAgent: true, toolDifferences: 'Native tools/prompts retained; Kodo mailbox tools withheld, OpenCode task denied; no equality claim for prompt or tool schema', taskLimit: 'Common15-minute emergency wall limit; no relay cumulative token/call/request-byte caps; model and tools retain native error handling', reportScoring: '60 source-fact checklist,20 valid citations,10 supported commands,10 scope; manual factual review required', codeScoring: '60 held-out behavior,10 regression/new tests,10 tsc+eslint,10 scope,10 completed final delivery', success: 'All predeclared requirements plus nonempty completed final response; evaluator is outside model workspace and uses frozen dependencies/tests', sourceExclusions: [...['scripts/comparison', 'scripts/benchmark-real-tasks.mjs', 'scripts/compare-harnesses.mjs', 'scripts/test-collaboration-benefit.mjs', 'scripts/evaluate-tasks.mjs', 'docs/real-task-harness-comparison.md']], limitations: 'Two attempts per task are exploratory; report auto-scores remain provisional pending source review. Host processes can access parent source: tool-action boundary review is required, and fresh strict blind trials need OS-enforced isolation. No statistical dominance or sandbox-speed claim.' },
};
await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
const priceResponses = {};
for (const name of ['pricing', 'status']) {
  try { const response = await globalThis.fetch(new URL(`/api/${name}`, upstream), { signal: globalThis.AbortSignal.timeout(15000) }); priceResponses[name] = { status: response.status, body: await response.json() }; }
  catch (error) { priceResponses[name] = { error: error.message }; }
}
await writeFile(path.join(root, 'public-pricing.json'), JSON.stringify(priceResponses, null, 2));
const selectedPrice = priceResponses.pricing?.body?.data?.find(row => row.model_name === model);
await writeFile(path.join(root, 'pricing-basis.json'), JSON.stringify({ ...historicRates, currentExactAliasListed: Boolean(selectedPrice), currentExactAliasPrice: selectedPrice ?? null, note: 'User requested the previous accounting basis. Absent current exact alias prevents verifying these historical rates against the current endpoint.' }, null, 2));
const emit = value => console.log(JSON.stringify(value));
emit({ event: 'benchmark.preparing', root, model, profiles, repeats });

async function runHarness(profile, workspace, directory, objective, relay) {
  const traceEvents = [];
  const trace = (type, data) => { const event = { type, time: Date.now(), ...data }; traceEvents.push(event); appendFileSync(path.join(directory, 'trace.jsonl'), JSON.stringify(event).replaceAll(key, '[redacted]') + '\n'); };
  let outcome;
  if (profile === 'pi') outcome = await runPiNative({ workspace, directory: path.join(directory, 'native'), objective, baseURL: relay.baseURL, model, ...limits, trace });
  else if (profile === 'opencode') outcome = await runOpenCode({ workspace, directory: path.join(directory, 'native'), objective, baseURL: relay.baseURL, model, ...limits, maxModelCalls: Number.MAX_SAFE_INTEGER, singleAgent: true, unrestricted: true, trace });
  else {
    process.env.KODO_REAL_TASK_RELAY_KEY = 'fixture-relay-key';
    const app = new Application(path.join(directory, 'kodo-state'));
    app.coordinator.mailbox.specs = () => [];
    try {
      const run = app.createRun({ objective, workspace, binding: { protocol: 'chat-completions', model, baseURL: relay.baseURL, apiKeyEnv: 'KODO_REAL_TASK_RELAY_KEY', limits: { context: limits.contextWindowTokens, output: limits.maxOutputTokens } }, permissions: ['read', 'write', 'exec'], budget: { maxTokens: null, maxModelCalls: null, maxToolCalls: null, maxDurationMs: limits.timeoutMs, maxContextTokens: limits.contextWindowTokens, maxContextChars: null, maxOutputTokens: limits.maxOutputTokens, maxConcurrentModels: 1, toolTimeoutMs: 120000 } });
      app.store.subscribe(event => { if (['tool.started', 'tool.finished', 'tool.stalled', 'model.started', 'model.finished', 'model.failed', 'model.retry', 'run.failed', 'run.completed'].includes(event.type)) trace(event.type, { runId: event.runId, ...event.data }); });
      const started = Date.now(); const final = await app.run(run.id);
      outcome = { status: final.status, error: final.error, text: final.resultRef ? app.store.readBlob(final.resultRef).text : '', executionMs: Date.now() - started, runId: run.id, calls: app.store.calls(run.id) };
    } finally { await app.shutdown(); delete process.env.KODO_REAL_TASK_RELAY_KEY; }
  }
  let parts;
  if (profile === 'pi') parts = outcome.events.filter(event => event.type === 'tool_execution_end').map(event => ({ id: event.toolCallId, failed: Boolean(event.isError) }));
  else if (profile === 'opencode') parts = (outcome.toolParts ?? []).map(part => ({ id: part.callID ?? part.id, failed: ['error', 'cancelled'].includes(part.state?.status) }));
  else parts = outcome.calls.filter(call => call.kind === 'tool').map(call => ({ id: call.id, failed: call.status !== 'succeeded' }));
  return { outcome, traceEvents, tools: { total: new Set(parts.map(part => part.id)).size, failed: parts.filter(part => part.failed).length } };
}
async function trialExecution(profile, workspace, directory, objective) {
  const wire = path.join(directory, 'wire'); await mkdir(wire, { recursive: true });
  const relay = await createBudgetRelay({ directory: wire, upstream, key, model, maxContextChars: Number.MAX_SAFE_INTEGER, maxOutputTokens: limits.maxOutputTokens, unrestricted: true });
  let execution;
  const started = Date.now();
  try { execution = await runHarness(profile, workspace, directory, objective, relay); }
  catch (error) { execution = { outcome: { status: 'failed', error: error.message, text: '', executionMs: Date.now() - started }, traceEvents: [], tools: { total: 0, failed: 0 } }; }
  finally { await relay.close(); }
  await writeFile(path.join(directory, 'outcome.json'), JSON.stringify(execution.outcome, null, 2));
  return { ...execution, executionMs: execution.outcome.executionMs, wire: globalThis.structuredClone(relay.stats), usage: usageScorecard(relay.stats) };
}
if (values['preflight-only']) {
  const preflights = [];
  for (const profile of profiles) {
    const directory = path.join(root, 'preflight-' + profile); const workspace = path.join(directory, 'workspace'); await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'input.txt'), 'native harness preflight 中文 42');
    const result = await trialExecution(profile, workspace, directory, 'Read input.txt and write exactly the same contents to output.txt using your native tools. Read output.txt to verify it, then report completion. Do not read outside the current directory, install dependencies, ask questions, or invoke another agent.');
    const copy = await readFile(path.join(workspace, 'output.txt'), 'utf8').catch(() => '');
    const passed = result.outcome.status === 'completed' && Boolean(result.outcome.text.trim()) && copy === 'native harness preflight 中文 42' && result.wire.requests >= 2;
    const row = { profile, passed, usage: result.usage, status: result.outcome.status, error: result.outcome.error, outputLimits: [...new Set(result.wire.calls.map(call => call.requestedOutput))] }; preflights.push(row); emit({ event: 'preflight.finished', ...row });
  }
  await writeFile(path.join(root, 'preflight.json'), JSON.stringify(preflights, null, 2));
  if (preflights.some(row => !row.passed)) process.exitCode = 1;
} else {
  // Controls run before any model attempt; they do not consume model tokens.
  for (const task of definitions.filter(task => task.id !== 'onboarding')) {
    for (const positive of [false, true]) {
      const directory = path.join(root, `control-${task.id}-${positive ? 'positive' : 'negative'}`); const workspace = path.join(directory, 'workspace'); await mkdir(directory);
      await prepareTask(source, workspace, task, repository);
      if (positive && task.id === 'pagination') await cp(path.join(source, 'src/runtime/history.ts'), path.join(workspace, 'src/runtime/history.ts'));
      if (positive && task.id === 'package-versions') {
        const registry = path.join(workspace, 'src/packages/registry.ts'); const code = await readFile(registry, 'utf8');
        const reference = `  async versions(id: string): Promise<{version:string;digest:string}[]> { identity(id); return (await this.list()).filter(item=>item.card.id===id).map(item=>({version:item.card.version,digest:item.digest})).sort((a,b)=>{const x=a.version.split('.').map(Number),y=b.version.split('.').map(Number);return y[0]!-x[0]!||y[1]!-x[1]!||y[2]!-x[2]!;}); }\n`;
        await writeFile(registry, code.replace('  async provenance(', reference + '  async provenance('));
        const cli = path.join(workspace, 'src/cli/packages.ts'); let cliCode = await readFile(cli, 'utf8');
        cliCode = cliCode.replace("['export', 'inspect', 'import', 'list',", "['versions', 'export', 'inspect', 'import', 'list',");
        cliCode = cliCode.replace('  let result: unknown;', "  if(command==='versions'){console.log(JSON.stringify(await registry.versions(argument!)));return;}\n  let result: unknown;");
        await writeFile(cli, cliCode); await writeFile(path.join(workspace, 'docs/capability-packages.md'), 'kodo package versions author/name');
      }
      const build = await execute(process.execPath, [path.join(repository, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], workspace, path.join(directory, 'build.json'));
      if (build.code !== 0) throw new Error(`Control build failed: ${task.id}`);
      const oracle = await runOracle(workspace, directory, task); const all = oracle.checks.every(check => check.passed);
      await writeFile(path.join(directory, 'control.json'), JSON.stringify({ positive, all, checks: oracle.checks }, null, 2));
      if (positive !== all) throw new Error(`Held-out oracle control invalid: ${task.id}/${positive}; see ${directory}`);
      emit({ event: 'control.passed', task: task.id, kind: positive ? 'positive' : 'negative', checks: oracle.checks.length });
    }
  }
  if (!values['controls-only']) {
    const results = [];
    for (let repeat = 1; repeat <= repeats; repeat++) for (const [index, task] of definitions.entries()) {
      const rotated = [...profiles.slice(index % profiles.length), ...profiles.slice(0, index % profiles.length)];
      for (const profile of repeat % 2 ? rotated : rotated.toReversed()) {
        const id = `${task.id}-${profile}-${repeat}`; const directory = path.join(root, id); const workspace = path.join(directory, 'workspace');
        await mkdir(directory); await prepareTask(source, workspace, task, repository); const before = await treeManifest(workspace);
        emit({ event: 'trial.started', id, directory });
        const objective = `当前项目副本绝对路径为 ${workspace}；全部源码读取和命令均应在此副本中进行。祖先目录只提供依赖可执行文件，不是任务源码位置。先阅读 START_HERE.md。${task.objective}\n仅使用当前项目副本，不读取父目录源码、其他试验或评测程序。请独立完成，无需子代理，不向用户提问。`;
        const started = Date.now(); const execution = await trialExecution(profile, workspace, directory, objective);
        const acceptance = await evaluateTrial({ repository, source, workspace, directory, task, before, outcome: execution.outcome });
        const row = { id, task: task.id, profile, repeat, directory, status: execution.outcome.status, error: execution.outcome.error, executionMs: execution.executionMs, evaluationTotalMs: Date.now() - started, tools: execution.tools, usage: execution.usage, acceptance };
        results.push(row); await writeFile(path.join(directory, 'result.json'), JSON.stringify(row, null, 2));
        await writeFile(path.join(root, 'results.json'), JSON.stringify({ results, summary: summarizeTrials(results) }, null, 2));
        emit({ event: 'trial.finished', id, passed: acceptance.passed, quality: acceptance.score, coverage: acceptance.coverage, seconds: row.executionMs / 1000, usage: row.usage, failedCriteria: acceptance.criteria.filter(check => !check.passed).map(check => check.name) });
      }
    }
    emit({ event: 'benchmark.finished', root, summary: summarizeTrials(results) });
    if (results.some(row => !row.acceptance.passed)) process.exitCode = 1;
  }
}
