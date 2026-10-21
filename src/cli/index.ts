#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { Application, KodoError, loadCard } from '../application/index.js';
import { errorText, terminal } from '../runtime/types.js';
import type { Budget, ModelProtocol, Permission, Run } from '../runtime/types.js';
import { unlockData } from '../storage/index.js';
import { interactive } from './interactive.js';
import { terminalText } from './terminal.js';
import { runProcess } from '../tools/index.js';

const help = `Kodo development preview (collaboration kernel)
  kodo run "task" [--json] [--workspace path] [--allow-write] [--allow-exec]
  kodo chat "task" [--workspace path] [--allow-write] [--allow-exec]
  kodo runs [--json]
  kodo gc [--vacuum] [--older-than-days N]
  kodo inspect <run-id> [--json]
  kodo resume <run-id> [--json]
  kodo reconcile <run-id> [--json]
  kodo resolve <run-id> --call-id ID --outcome succeeded|not_applied|failed --evidence "verification" [--retry] [--json]
  kodo continue <run-id> [--json]
  kodo input <run-id> --text "input" [--decision] [--follow-up] [--json]
  kodo answer <question-id> --text "answer" [--decision] [--json]
  kodo cancel <run-id>
  kodo doctor [--unlock]
Options: Model context/output limits are resolved automatically; no budget presets.
         --input-price N --output-price N (USD per million tokens, for cost projection)
         --verify-command JSON_ARGV (trusted host acceptance program and args; persisted for resume)
         --allow-empty-response (explicit silent/artifact-only delivery; acceptance still applies)
         --data-dir path --model name --base-url URL --api-key-env NAME
         --protocol chat-completions|responses|anthropic --prompt-cache off|session
         --max-tokens N --max-model-calls N --max-tool-calls N
         --max-output-tokens N --max-context-chars N --max-context-tokens N --timeout-ms N --tool-timeout-ms N --card AGENT.md
         --max-children N --max-concurrent-models N
Environment: KODO_MODEL, KODO_BASE_URL, KODO_PROTOCOL, KODO_PROMPT_CACHE, KODO_API_KEY (or OPENAI_API_KEY).
Default permission: workspace read only. --allow-exec grants high privilege, not a sandbox.
Waiting for user input exits with code 2; answer/continue uses the same data directory.
Uncertain writes require reconciliation or explicit evidence before resume; no force replay.
--retry explicitly authorizes retry only after --outcome not_applied verification.
chat uses native terminal line input. MCP and package import are not implemented.`;

async function main(): Promise<void> {
  const { values, positionals } = (() => { try { return parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, json: { type: 'boolean' }, 'allow-empty-response': { type: 'boolean' },
    'data-dir': { type: 'string' }, workspace: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' },
    'api-key-env': { type: 'string' }, protocol: { type: 'string' }, 'prompt-cache': { type: 'string' }, 'allow-write': { type: 'boolean' }, 'allow-exec': { type: 'boolean' }, unlock: { type: 'boolean' }, card: { type: 'string' },
    'max-tokens': { type: 'string' }, 'max-model-calls': { type: 'string' }, 'max-tool-calls': { type: 'string' },
    'max-output-tokens': { type: 'string' }, 'max-context-chars': { type: 'string' }, 'max-context-tokens': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'tool-timeout-ms': { type: 'string' },
    'max-children': { type: 'string' }, 'max-concurrent-models': { type: 'string' },
    'input-price': { type: 'string' }, 'output-price': { type: 'string' }, 'verify-command': { type: 'string' },
    vacuum: { type: 'boolean' }, 'older-than-days': { type: 'string' },
    text: { type: 'string' }, decision: { type: 'boolean' }, 'follow-up': { type: 'boolean' },
    'call-id': { type: 'string' }, outcome: { type: 'string' }, evidence: { type: 'string' }, retry: { type: 'boolean' },
  } }); } catch { throw new KodoError('ARGUMENTS', 'invalid options; use --help'); } })();
  if (values.version) { console.log('0.1.0-alpha.0'); return; }
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command, argument] = positionals;
  if (!['run', 'chat', 'inspect', 'resume', 'reconcile', 'resolve', 'continue', 'input', 'answer', 'cancel', 'doctor', 'runs', 'list', 'gc'].includes(command!)) throw new KodoError('COMMAND', 'unknown command; use --help');
  if (positionals.length > (['doctor', 'runs', 'list', 'gc'].includes(command!) ? 1 : 2)) throw new KodoError('ARGUMENTS', 'unexpected positional arguments; quote the task');
  if (!['doctor', 'runs', 'list', 'gc'].includes(command!) && !argument) throw new KodoError('ARGUMENTS', 'task or run ID is required');
  if (command === 'chat' && values.json) throw new KodoError('ARGUMENTS', 'chat uses terminal output; use run for JSONL');
  if (['input', 'answer'].includes(command!) && !values.text) throw new KodoError('ARGUMENTS', '--text is required');
  if (values.text !== undefined && !['input', 'answer'].includes(command!)) throw new KodoError('ARGUMENTS', '--text is only valid for input or answer');
  if (values.decision && !['input', 'answer'].includes(command!)) throw new KodoError('ARGUMENTS', '--decision is only valid for input or answer');
  if (values['follow-up'] && command !== 'input') throw new KodoError('ARGUMENTS', '--follow-up is only valid for input');
  if (command === 'resolve') {
    if (!values['call-id']?.trim() || !values.evidence?.trim() || !['succeeded', 'not_applied', 'failed'].includes(values.outcome ?? '')) throw new KodoError('ARGUMENTS', 'resolve requires --call-id, --outcome succeeded|not_applied|failed and nonempty --evidence');
    if ((values.outcome === 'not_applied') !== Boolean(values.retry)) throw new KodoError('ARGUMENTS', '--retry is required exactly when --outcome is not_applied');
  } else if (values['call-id'] !== undefined || values.outcome !== undefined || values.evidence !== undefined || values.retry !== undefined) throw new KodoError('ARGUMENTS', '--call-id, --outcome, --evidence and --retry are only valid for resolve');
  if (command !== 'gc' && (values.vacuum !== undefined || values['older-than-days'] !== undefined)) throw new KodoError('ARGUMENTS', '--vacuum and --older-than-days are only valid for gc');
  const creationFlags = ['input-price', 'output-price', 'verify-command', 'allow-empty-response', 'workspace', 'model', 'base-url', 'api-key-env', 'protocol', 'prompt-cache', 'card', 'allow-write', 'allow-exec', 'max-tokens', 'max-model-calls', 'max-tool-calls', 'max-output-tokens', 'max-context-chars', 'max-context-tokens', 'timeout-ms', 'tool-timeout-ms', 'max-children', 'max-concurrent-models'] as const;
  if (!['run', 'chat'].includes(command!) && creationFlags.some(flag => values[flag] !== undefined)) throw new KodoError('ARGUMENTS', 'model, workspace, permission and budget options are only valid for run or chat');
  const directory = path.resolve(values['data-dir'] ?? process.env.KODO_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'kodo'));
  if (values.unlock) {
    if (command !== 'doctor') throw new KodoError('ARGUMENTS', '--unlock is only valid for doctor');
    unlockData(directory);
  }
  let currentRun: string | undefined;
  const startup = new AbortController();
  const app = new Application(directory, undefined, (runId, text) => {
    if (!currentRun || app.store.run(runId).sessionId !== app.store.run(currentRun).sessionId) return;
    if (values.json) console.log(JSON.stringify({ type: 'text.delta', runId, transient: true, data: { text } }));
    else if (runId === currentRun) process.stderr.write(terminalText(text));
  });
  const interrupt = (): void => { if (currentRun) app.coordinator.cancel(currentRun); else startup.abort(new KodoError('CANCELLED', 'user cancelled before execution')); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const unsubscribe = app.store.subscribe(event => {
    if (!currentRun || event.sessionId !== app.store.run(currentRun).sessionId) return;
    const result = event.type === 'run.completed' ? app.store.readBlob<{ text: string; quality: { status: string } }>(String(event.data.resultRef)) : undefined;
    if (values.json) console.log(JSON.stringify(result ? { ...event, data: { ...event.data, result } } : event));
    else if (result && event.runId === currentRun) { console.log(terminalText(result.text)); console.error(`验收：${result.quality.status === 'passed' ? '通过' : '未被验收'}`); }
    else if (event.type === 'run.failed' || event.type === 'run.interrupted') console.error(terminalText(String(event.data.error)));
    else console.error(terminalText(`${event.type}${event.data.name ? ` ${String(event.data.name)}` : ''}`));
  });
  const attachVerification = (runId: string): void => {
    const run = app.store.run(runId);
    if (terminal(run.status) && !(run.requiresValidation && run.status === 'failed' && run.error?.startsWith('UNKNOWN_WRITE:'))) return;
    const session = app.store.session(run.sessionId);
    if (!session.verificationCommand) return;
    const verification = session.verificationCommand;
    app.setCompletionValidator(runId, async ({ signal }) => {
      const output = await runProcess(verification.program, verification.args, session.workspace, run.binding.apiKeyEnv, AbortSignal.any([signal, AbortSignal.timeout(session.budget.toolTimeoutMs)]));
      const passed = output.exitCode === 0 && !output.cancelled && !output.outputLimitExceeded;
      const secret = process.env[run.binding.apiKeyEnv];
      const redact = (text: string): string => secret ? text.replaceAll(secret, '[REDACTED]') : text;
      return { passed, feedback: passed ? undefined : redact(`Verification command failed (exit ${output.exitCode}): ${output.stderr || output.stdout}`).slice(0, 16000), evidence: { ...output, stdout: redact(output.stdout), stderr: redact(output.stderr) } };
    });
  };
  try {
    if (command === 'runs' || command === 'list') {
      console.log(JSON.stringify(app.store.listRuns().map(run => ({ id: run.id, sessionId: run.sessionId, parentId: run.parentId, status: run.status, objective: run.objective, createdAt: run.createdAt })), null, values.json ? undefined : 2));
      return;
    }
    if (command === 'gc') {
      console.log(JSON.stringify(app.store.gc({ vacuum: values.vacuum, olderThanDays: values['older-than-days'] === undefined ? undefined : Number(values['older-than-days']) })));
      return;
    }
    if (command === 'doctor') {
      const diagnostics = {
        node: process.version, sqlite: app.store.db.pragma('quick_check', { simple: true }),
        chineseTrigram: app.store.probeSearch(),
        modelConfigured: Boolean(process.env.KODO_MODEL),
        credentialConfigured: Boolean(process.env.KODO_API_KEY || process.env.OPENAI_API_KEY),
        interruptedRuns: app.store.listRuns().filter(x => x.status === 'interrupted').map(x => x.id),
        status: 'development-preview',
      };
      console.log(JSON.stringify(diagnostics, null, 2));
      if (!diagnostics.chineseTrigram || diagnostics.sqlite !== 'ok') process.exitCode = 1;
      return;
    }
    if (command === 'inspect') {
      const run = app.store.run(argument!);
      console.log(JSON.stringify(app.snapshot(run.id), null, values.json ? undefined : 2));
      return;
    }
    if (command === 'reconcile' || command === 'resolve') {
      const originalCalls = app.store.calls(argument!);
      const report = command === 'reconcile' ? await app.reconcile(argument!) : app.resolveCall(argument!, values['call-id']!, { outcome: values.outcome as 'succeeded' | 'not_applied' | 'failed', evidence: values.evidence!, retry: values.retry });
      console.log(JSON.stringify({ ...report, originalCalls }, null, values.json ? undefined : 2));
      return;
    }
    let result: Run;
    if (command === 'resume') {
      currentRun = argument;
      for (const peer of app.store.listRuns(app.store.run(argument!).sessionId)) attachVerification(peer.id);
      result = await app.recover(argument!);
      if (result.id !== currentRun) {
        currentRun = result.id;
        if (!values.json && result.status === 'completed' && result.resultRef) console.log(terminalText(app.store.readBlob<{ text: string }>(result.resultRef).text));
      }
    } else if (['continue', 'input', 'answer', 'cancel'].includes(command!)) {
      const run = command === 'input' ? app.submitInput(argument!, values.text!, { decision: values.decision, mode: values['follow-up'] ? 'follow_up' : 'steer' }) : command === 'answer' ? app.answer(argument!, values.text!, { decision: values.decision }) : app.store.run(argument!);
      currentRun = run.id;
      if (command === 'cancel') app.coordinator.cancel(run.id);
      if (command !== 'cancel') attachVerification(run.id);
      result = command === 'cancel' ? app.store.run(run.id) : await app.run(run.id);
    } else {
      const model = values.model ?? process.env.KODO_MODEL;
      if (!model) throw new KodoError('MODEL_CONFIG', 'set KODO_MODEL or pass --model');
      const apiKeyEnv = values['api-key-env'] ?? (process.env.KODO_API_KEY ? 'KODO_API_KEY' : 'OPENAI_API_KEY');
      if (!process.env[apiKeyEnv]) throw new KodoError('MODEL_CREDENTIAL', `set ${apiKeyEnv} in the local environment`);
      const budget: Partial<Budget> = {};
      const budgets = { 'max-tokens': 'maxTokens', 'max-model-calls': 'maxModelCalls', 'max-tool-calls': 'maxToolCalls', 'max-output-tokens': 'maxOutputTokens', 'max-context-chars': 'maxContextChars', 'max-context-tokens': 'maxContextTokens', 'timeout-ms': 'maxDurationMs', 'tool-timeout-ms': 'toolTimeoutMs', 'max-children': 'maxChildren', 'max-concurrent-models': 'maxConcurrentModels' } as const;
      for (const [flag, field] of Object.entries(budgets)) if (values[flag as keyof typeof values] !== undefined) budget[field] = Number(values[flag as keyof typeof values]);
      const permissions: Permission[] = ['read'];
      if (values['allow-write']) permissions.push('write');
      if (values['allow-exec']) permissions.push('exec');
      const run = await app.createRunWithDiscovery({ objective: argument!, workspace: path.resolve(values.workspace ?? process.cwd()),
        binding: { model, baseURL: values['base-url'] ?? process.env.KODO_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', apiKeyEnv, protocol: (values.protocol ?? process.env.KODO_PROTOCOL) as ModelProtocol | undefined, promptCache: (values['prompt-cache'] ?? process.env.KODO_PROMPT_CACHE) as 'off' | 'session' | undefined },
        permissions, budget, finalResponse: values['allow-empty-response'] ? 'optional' : 'required', card: values.card ? loadCard(path.resolve(values.card)) : undefined }, startup.signal);
      const session = app.store.session(run.sessionId);
      let commandArgv: unknown;
      if (values['verify-command']) {
        try { commandArgv = JSON.parse(values['verify-command']); } catch { throw new KodoError('ARGUMENTS', '--verify-command must be a JSON array of program and arguments'); }
        if (!Array.isArray(commandArgv) || !commandArgv.length || commandArgv.some(value => typeof value !== 'string' || value.includes('\0')) || !commandArgv[0]) throw new KodoError('ARGUMENTS', '--verify-command must be a nonempty JSON argv array');
        app.store.putSession({ ...session, verificationCommand: { program: commandArgv[0] as string, args: commandArgv.slice(1) as string[] } });
        attachVerification(run.id);
      }
      const prices = [values['input-price'], values['output-price']];
      if (prices.some(value => value !== undefined) && prices.some(value => value === undefined || !Number.isFinite(Number(value)) || Number(value) < 0)) throw new KodoError('ARGUMENTS', 'provide both nonnegative --input-price and --output-price in USD per million tokens');
      const rates = prices.every(value => value !== undefined) ? { input: Number(prices[0]), output: Number(prices[1]) } : undefined;
      const costUpperBoundUSD = rates && session.budget.maxTokens !== null ? session.budget.maxTokens * Math.max(rates.input, rates.output) / 1_000_000 : null;
      const budgetInfo = { limits: session.budget, modelLimits: session.modelLimits, costUpperBoundUSD, ratesPerMillionTokens: rates ?? null,
        costNote: session.budget.maxTokens === null ? 'No cumulative token limit; cost depends on actual usage.' : 'Conservative projection at supplied rates; excludes cache discounts and non-token charges.' };
      if (values.json) console.log(JSON.stringify({ type: 'budget.info', runId: run.id, data: budgetInfo }));
      else {
        const limit = (value: number | null): string => value === null ? '不限' : String(value);
        console.error(`模型窗口 ${session.budget.maxContextTokens} tokens，单次输出上限 ${session.budget.maxOutputTokens} tokens（来源：${session.modelLimits?.source}）。`);
        console.error(`会话限额：累计 token ${limit(session.budget.maxTokens)}，模型调用 ${limit(session.budget.maxModelCalls)} 次，工具调用 ${limit(session.budget.maxToolCalls)} 次，活动时长 ${limit(session.budget.maxDurationMs)} 毫秒。`);
        if (session.modelLimits?.warning) console.error(terminalText(session.modelLimits.warning));
        if (costUpperBoundUSD !== null) console.error(`按输入/输出最高单价估算的累计费用上限：$${costUpperBoundUSD.toFixed(2)}`);
      }
      currentRun = run.id;
      for (const event of app.store.events(run.id)) {
        if (values.json) console.log(JSON.stringify(event)); else console.error(`${event.type} ${run.id}`);
      }
      result = command === 'chat' ? await interactive(app, run, id => { currentRun = id; }, attachVerification) : await app.run(run.id);
    }
    const questions = app.coordinator.mailbox.userQuestions(result.sessionId);
    const needsInput = result.status === 'waiting' || (!terminal(result.status) && questions.length > 0);
    if (needsInput) {
      if (values.json) console.log(JSON.stringify({ type: 'input.required', runId: result.id, questions }));
      else for (const question of questions) console.error(terminalText(`待回答 ${question.id}: ${question.content}`));
    }
    process.exitCode = result.status === 'completed' ? 0 : needsInput ? 2 : result.status === 'cancelled' ? 130 : 1;
  } finally {
    unsubscribe();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await app.shutdown();
  }
}
main().catch(error => { console.error(terminalText(errorText(error))); process.exitCode = error instanceof KodoError && error.code === 'CANCELLED' ? 130 : 1; });
