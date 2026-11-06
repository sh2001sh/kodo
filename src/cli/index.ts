#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { KodoError, errorText, terminal } from '../runtime/types.js';
import type { Budget, CompletionValidator, Permission, Run } from '../runtime/types.js';
import { interactive } from './interactive.js';
import { terminalText } from './terminal.js';
import type { ReadOnlyCommand } from '../tools/index.js';
import { runWorkspace } from '../runtime/execution-workspace.js';
import type { FileScope } from '../runtime/types.js';
import type { TuiActions } from '../tui/types.js';
import { configuredAgentModels, hasModelCredentials, hydrateConfigCredentials, resolveConfiguredBinding, tuiModelConfig } from './config-binding.js';
import { readUserConfig, userConfigPath } from './user-config.js';

const help = `Kodo development preview (collaboration kernel)
  kodo run "task" [--json] [--workspace path] [--allow-write] [--allow-exec]
  kodo                         (TTY: interactive workspace)
  kodo chat ["task"] [--plain] [--workspace path] [--allow-write] [--allow-exec]
  kodo spawn <session-id> --objective "task" [--model-binding ALIAS] [--scope JSON] [--json]
  kodo runs [--json]
  kodo gc [--vacuum] [--older-than-days N]
  kodo inspect <run-id> [--context] [--json]
  kodo context <run-id> [--json]
  kodo context-report <run-id> [--json]  (C0 aggregation across the run's session)
  kodo knowledge <run-id> [--parent-id ID | --query TEXT --in summary|evidence | --knowledge-id ID --revision N] [--after CURSOR] [--offset N] [--json]
  kodo resume <run-id> [--json]
  kodo reconcile <run-id> [--json]
  kodo reconcile <call-id> --applied|--not-applied --evidence "verification" [--json]
  kodo resolve <run-id> --call-id ID --outcome succeeded|not_applied|failed --evidence "verification" [--retry] [--json]
  kodo continue <run-id> [--json]
  kodo input <run-id> --text "input" [--decision] [--follow-up] [--json]
  kodo answer <question-id> --text "answer" [--decision] [--json]
  kodo cancel <run-id>
  kodo interrupt <run-id> [--json]
  kodo rewind <run-id> --to <step> [--json]
  kodo doctor [--unlock] [--sandbox]
  kodo config                      (configure providers and select a fetched model)
  kodo package --help
  kodo case --help
  kodo serve --help
Options: Model context/output limits are resolved automatically; no budget presets.
         --input-price N --output-price N (USD per million tokens, for cost projection)
         --verify-command JSON_ARGV (trusted host acceptance program and args; persisted for resume)
         --read-only-commands JSON_ARGV_ARRAYS (trusted exact commands for process.run; reattach on resume/continue/input/answer)
         --allow-empty-response (explicit silent/artifact-only delivery; acceptance still applies)
         --sandbox (native OS isolation, network denied; fail closed when unavailable)
         --allow-network (requires --sandbox; explicitly permits sandbox networking)
         --sandbox-resources JSON_FILE (requires --sandbox; native memory/process limits)
         --shell-program ABSOLUTE_BASH_PATH --lsp-config JSON_FILE
         --webfetch [--web-hosts HOST,HOST] (explicit host network grant)
         --compaction off|mask|summary|hybrid [--compaction-trigger-ratio 0.5-0.95 | --compaction-work-tokens N] (default: conditional summary at 0.8 of the effective window; persisted for resume)
         --assembly deterministic [--assembly-work-tokens N] [--assembly-evidence-tokens N] (experimental; no extra model call)
         --memory --lazy-tools (optional; disabled by default, persisted for resume)
         --verification-config JSON_FILE (fixed WSL/container command; enabled and approved by the host)
         --package author/name[@version] (activate imported/adopted package; persisted for resume)
         --data-dir path --provider NAME --model name --base-url URL --api-key-env NAME
         --protocol chat-completions|responses|anthropic --prompt-cache off|session
         --max-tokens N --max-model-calls N --max-tool-calls N
         --max-output-tokens N --max-context-chars N --max-context-tokens N --timeout-ms N --tool-timeout-ms N --card AGENT.md
         --max-active-children N (default 8 unfinished child tasks)
         --max-children N|none (cumulative child runs; default none)
         --max-concurrent-models N --cache-read-cost-percent 0-100
Configuration: ~/.kodo/config.json; kodo config manages providers. KODO_HOME overrides ~/.kodo.
Environment: KODO_PROVIDER, KODO_MODEL, KODO_BASE_URL, KODO_PROTOCOL, KODO_PROMPT_CACHE, KODO_API_KEY (or OPENAI_API_KEY).
Interactive TUI: Ask mode reviews writes and commands; /permissions selects Ask or YOLO.
Plain chat and run default to workspace read only; --allow-write and --allow-exec grant tools.
Package stdio writes still require --allow-write; --sandbox enables OS isolation.
Waiting for user input exits with code 2; answer/continue uses the same data directory.
Uncertain writes require reconciliation or explicit evidence before resume; no force replay.
--retry explicitly authorizes retry only after --outcome not_applied verification.
TTY chat uses the Ink workspace; --plain or non-TTY uses native line input.
Package management and browsing the TUI do not require model credentials.`;

/** Trusted host spawn scope: JSON object with read/write relative-root arrays only. */
function parseSpawnScope(raw: string): FileScope {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new KodoError('ARGUMENTS', '--scope must be a JSON object containing read/write path-root arrays'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, roots]) => !['read', 'write'].includes(key) || !Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !root))) throw new KodoError('ARGUMENTS', '--scope must be a JSON object containing read/write path-root arrays');
  return value as FileScope;
}

export async function runCli(argv: string[]): Promise<void> {
  if (argv[0] === 'config') { const { configCommand } = await import('./config.js'); await configCommand(argv.slice(1)); return; }
  if (argv[0] === 'package') { const { packageCommand } = await import('./packages.js'); await packageCommand(argv.slice(1)); return; }
  if (argv[0] === 'case') { const { caseCommand } = await import('../cases/cli.js'); await caseCommand(argv.slice(1)); return; }
  if (argv[0] === 'serve') { const { serveCommand } = await import('./serve.js'); await serveCommand(argv.slice(1)); return; }
  const args = argv;
  // parseArgs otherwise treats a negative step as a new option; accept the documented --to -1 spelling.
  for (let index = 0; index < args.length - 1; index++) if (args[index] === '--to' && /^-\d+$/.test(args[index + 1]!)) args.splice(index, 2, `--to=${args[index + 1]}`);
  const { values, positionals } = (() => { try { return parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, json: { type: 'boolean' }, plain: { type: 'boolean' }, 'allow-empty-response': { type: 'boolean' },
    'data-dir': { type: 'string' }, workspace: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' },
    'api-key-env': { type: 'string' }, protocol: { type: 'string' }, 'prompt-cache': { type: 'string' }, 'model-binding': { type: 'string' }, 'allow-write': { type: 'boolean' }, 'allow-exec': { type: 'boolean' }, unlock: { type: 'boolean' }, card: { type: 'string' },
    'max-tokens': { type: 'string' }, 'max-model-calls': { type: 'string' }, 'max-tool-calls': { type: 'string' },
    'max-output-tokens': { type: 'string' }, 'max-context-chars': { type: 'string' }, 'max-context-tokens': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'tool-timeout-ms': { type: 'string' },
    'max-children': { type: 'string' }, 'max-active-children': { type: 'string' }, 'max-concurrent-models': { type: 'string' }, 'cache-read-cost-percent': { type: 'string' },
    'input-price': { type: 'string' }, 'output-price': { type: 'string' }, 'verify-command': { type: 'string' }, 'read-only-commands': { type: 'string' },
    vacuum: { type: 'boolean' }, 'older-than-days': { type: 'string' },
    text: { type: 'string' }, decision: { type: 'boolean' }, 'follow-up': { type: 'boolean' },
    'call-id': { type: 'string' }, outcome: { type: 'string' }, evidence: { type: 'string' }, retry: { type: 'boolean' },
    sandbox: { type: 'boolean' }, 'allow-network': { type: 'boolean' }, package: { type: 'string' },
    'sandbox-resources': { type: 'string' }, 'shell-program': { type: 'string' }, 'lsp-config': { type: 'string' }, webfetch: { type: 'boolean' }, 'web-hosts': { type: 'string' },
    compaction: { type: 'string' }, 'compaction-work-tokens': { type: 'string' }, 'compaction-trigger-ratio': { type: 'string' },
    assembly: { type: 'string' }, 'assembly-work-tokens': { type: 'string' }, 'assembly-evidence-tokens': { type: 'string' },
    memory: { type: 'boolean' }, 'lazy-tools': { type: 'boolean' }, 'verification-config': { type: 'string' },
    objective: { type: 'string' }, scope: { type: 'string' },
    context: { type: 'boolean' }, to: { type: 'string' }, applied: { type: 'boolean' }, 'not-applied': { type: 'boolean' },
    'parent-id': { type: 'string' }, query: { type: 'string' }, in: { type: 'string' }, 'knowledge-id': { type: 'string' }, revision: { type: 'string' }, after: { type: 'string' }, offset: { type: 'string' },
  } }); } catch { throw new KodoError('ARGUMENTS', 'invalid options; use --help'); } })();
  if (values.version) { console.log((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version); return; }
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
  if (!positionals.length && tty && !values.help && !values.json && !values.plain) positionals.push('chat');
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command, argument] = positionals;
  const useTui = command === 'chat' && tty && !values.json && !values.plain;
  if (values.plain !== undefined && command !== 'chat') throw new KodoError('ARGUMENTS', '--plain is only valid for chat');
  if (!['run', 'chat', 'spawn', 'inspect', 'context', 'context-report', 'knowledge', 'resume', 'reconcile', 'resolve', 'continue', 'input', 'answer', 'cancel', 'interrupt', 'rewind', 'doctor', 'runs', 'list', 'gc'].includes(command!)) throw new KodoError('COMMAND', 'unknown command; use --help');
  if (command === 'spawn') {
    if (!values.objective?.trim()) throw new KodoError('ARGUMENTS', 'spawn requires --objective');
  } else if (['objective', 'scope', 'model-binding'].some(key => values[key as keyof typeof values] !== undefined)) throw new KodoError('ARGUMENTS', '--objective, --scope and --model-binding are only valid for spawn');
  if (values.context !== undefined && command !== 'inspect') throw new KodoError('ARGUMENTS', '--context is only valid for inspect');
  if (command === 'rewind') {
    if (values.to === undefined || !/^(?:-1|\d+)$/.test(values.to) || !Number.isSafeInteger(Number(values.to))) throw new KodoError('ARGUMENTS', 'rewind requires --to with step -1 or a nonnegative step number');
  } else if (values.to !== undefined) throw new KodoError('ARGUMENTS', '--to is only valid for rewind');
  const settlingCall = command === 'reconcile' && (values.applied === true || values['not-applied'] === true);
  if (values.applied !== undefined || values['not-applied'] !== undefined) {
    if (!settlingCall || Boolean(values.applied) === Boolean(values['not-applied']) || !values.evidence?.trim()) throw new KodoError('ARGUMENTS', 'reconcile a call with exactly one of --applied or --not-applied and nonempty --evidence');
  }
  if (command !== 'knowledge' && ['parent-id', 'query', 'in', 'knowledge-id', 'revision', 'after', 'offset'].some(key => values[key as keyof typeof values] !== undefined)) throw new KodoError('ARGUMENTS', 'knowledge query options are only valid for knowledge');
  if (positionals.length > (['doctor', 'runs', 'list', 'gc'].includes(command!) ? 1 : 2)) throw new KodoError('ARGUMENTS', 'unexpected positional arguments; quote the task');
  if (!['doctor', 'runs', 'list', 'gc'].includes(command!) && !argument && !useTui) throw new KodoError('ARGUMENTS', 'task or run ID is required');
  if (command === 'chat' && values.json) throw new KodoError('ARGUMENTS', 'chat uses terminal output; use run for JSONL');
  if (values['allow-network'] && !values.sandbox) throw new KodoError('ARGUMENTS', '--allow-network requires --sandbox');
  if ((values.sandbox !== undefined || values['allow-network'] !== undefined || values['sandbox-resources'] !== undefined) && !['run', 'chat', 'resume', 'continue', 'input', 'answer', 'doctor'].includes(command!)) throw new KodoError('ARGUMENTS', '--sandbox is only valid for execution commands or doctor');
  if (['shell-program', 'lsp-config', 'webfetch', 'web-hosts'].some(key => values[key as keyof typeof values] !== undefined) && !['run', 'chat', 'resume', 'continue', 'input', 'answer'].includes(command!)) throw new KodoError('ARGUMENTS', 'trusted tool options are only valid for execution commands');
  if (['memory', 'lazy-tools', 'verification-config'].some(key => values[key as keyof typeof values] !== undefined) && !['run', 'chat', 'resume', 'continue', 'input', 'answer'].includes(command!)) throw new KodoError('ARGUMENTS', 'optional runtime features are only valid for execution commands');
  if (values.compaction !== undefined || values['compaction-work-tokens'] !== undefined || values['compaction-trigger-ratio'] !== undefined) {
    if (!['run', 'chat'].includes(command!)) throw new KodoError('ARGUMENTS', '--compaction is only valid for run or chat; resume reattaches the original compaction policy');
  }
  if (values.assembly !== undefined || values['assembly-work-tokens'] !== undefined || values['assembly-evidence-tokens'] !== undefined) {
    if (!['run', 'chat'].includes(command!)) throw new KodoError('ARGUMENTS', '--assembly is only valid for run or chat; resume reattaches the original assembly policy');
  }
  if (values.package !== undefined && !['run', 'chat'].includes(command!)) throw new KodoError('ARGUMENTS', '--package is only valid for run or chat; resume reattaches the original package');
  if (values.package && values.card) throw new KodoError('ARGUMENTS', '--package and --card cannot be combined');
  if (['input', 'answer'].includes(command!) && !values.text) throw new KodoError('ARGUMENTS', '--text is required');
  if (values.text !== undefined && !['input', 'answer'].includes(command!)) throw new KodoError('ARGUMENTS', '--text is only valid for input or answer');
  if (values.decision && !['input', 'answer'].includes(command!)) throw new KodoError('ARGUMENTS', '--decision is only valid for input or answer');
  if (values['follow-up'] && command !== 'input') throw new KodoError('ARGUMENTS', '--follow-up is only valid for input');
  if (command === 'resolve') {
    if (!values['call-id']?.trim() || !values.evidence?.trim() || !['succeeded', 'not_applied', 'failed'].includes(values.outcome ?? '')) throw new KodoError('ARGUMENTS', 'resolve requires --call-id, --outcome succeeded|not_applied|failed and nonempty --evidence');
    if ((values.outcome === 'not_applied') !== Boolean(values.retry)) throw new KodoError('ARGUMENTS', '--retry is required exactly when --outcome is not_applied');
  } else if (values['call-id'] !== undefined || values.outcome !== undefined || (values.evidence !== undefined && !settlingCall) || values.retry !== undefined) throw new KodoError('ARGUMENTS', '--call-id, --outcome and --retry are only valid for resolve; --evidence also supports call reconciliation');
  if (command !== 'gc' && (values.vacuum !== undefined || values['older-than-days'] !== undefined)) throw new KodoError('ARGUMENTS', '--vacuum and --older-than-days are only valid for gc');
  const creationFlags = ['input-price', 'output-price', 'verify-command', 'allow-empty-response', 'workspace', 'provider', 'model', 'base-url', 'api-key-env', 'protocol', 'prompt-cache', 'card', 'allow-write', 'allow-exec', 'max-tokens', 'max-model-calls', 'max-tool-calls', 'max-output-tokens', 'max-context-chars', 'max-context-tokens', 'timeout-ms', 'tool-timeout-ms', 'max-children', 'max-active-children', 'max-concurrent-models', 'cache-read-cost-percent'] as const;
  if (!['run', 'chat'].includes(command!) && creationFlags.some(flag => values[flag] !== undefined)) throw new KodoError('ARGUMENTS', 'model, workspace, permission and budget options are only valid for run or chat');
  const userConfig = ['run', 'chat'].includes(command!)
    ? useTui ? await (await import('./config.js')).ensureInteractiveProviderConfig() : readUserConfig()
    : ['spawn', 'resume', 'continue', 'input', 'answer'].includes(command!) ? readUserConfig() : undefined;
  if (userConfig) hydrateConfigCredentials(userConfig);
  const agentModels = userConfig ? configuredAgentModels(userConfig) : {};
  let readOnlyCommands: ReadOnlyCommand[] = [];
  if (values['read-only-commands'] !== undefined) {
    if (!['run', 'chat', 'spawn', 'resume', 'continue', 'input', 'answer'].includes(command!)) throw new KodoError('ARGUMENTS', '--read-only-commands is only valid for execution commands');
    let declarations: unknown;
    try { declarations = JSON.parse(values['read-only-commands']); } catch { throw new KodoError('ARGUMENTS', '--read-only-commands must be a JSON array of complete argv arrays'); }
    if (!Array.isArray(declarations) || declarations.length > 128 || declarations.some(argv => !Array.isArray(argv) || !argv.length || argv.length > 129 || !argv[0] || argv.some(value => typeof value !== 'string' || value.length > 4096 || value.includes('\0')))) throw new KodoError('ARGUMENTS', '--read-only-commands requires at most 128 nonempty argv arrays, with a program and at most 128 arguments');
    readOnlyCommands = declarations.map((argv: string[]) => ({ program: argv[0]!, args: argv.slice(1) }));
  }
  const [{ Application }, { unlockData }, { runProcess }, { cliDataDirectory, packageIdentity }, { cliSandboxPolicy, cliToolPolicy, cliCompactionPolicy, cliAssemblyPolicy, cliVerificationPolicy, defaultCompactionPolicy, readHostState, writeHostState }, { PackageRegistry }, { verifyToolExamples }, { createSandbox }] = await Promise.all([
    import('../application/index.js'), import('../storage/index.js'), import('../tools/index.js'), import('./packages.js'), import('./host-state.js'), import('../packages/registry.js'), import('../packages/runtime.js'), import('../sandbox/execute.js'),
  ]);
  const directory = cliDataDirectory(values['data-dir']);
  const hostState = readHostState(directory);
  const persistedHost = command === 'spawn' ? hostState.find(item => item.sessionId === argument) : ['inspect', 'context', 'context-report', 'resume', 'continue', 'input', 'answer', 'interrupt', 'rewind'].includes(command!) ? hostState.find(item => item.runIds.includes(argument ?? '') || item.questionIds.includes(argument ?? '')) : undefined;
  const requestedSandbox = cliSandboxPolicy(values);
  const requestedTools = cliToolPolicy(values);
  const requestedCompaction = cliCompactionPolicy(values);
  const requestedAssembly = cliAssemblyPolicy(values);
  const requestedVerification = cliVerificationPolicy(values);
  if (persistedHost && requestedSandbox && JSON.stringify(requestedSandbox) !== JSON.stringify(persistedHost.sandbox)) throw new KodoError('CAPABILITY_CHANGED', 'resume must preserve the original sandbox policy');
  const sandbox = persistedHost?.sandbox ?? requestedSandbox;
  if (persistedHost && requestedTools && JSON.stringify(requestedTools) !== JSON.stringify(persistedHost.tools)) throw new KodoError('CAPABILITY_CHANGED', 'resume must preserve the original trusted tool configuration');
  const trustedTools = persistedHost?.tools ?? requestedTools;
  if (persistedHost && requestedCompaction !== undefined && JSON.stringify(requestedCompaction) !== JSON.stringify(persistedHost.compaction ?? false)) throw new KodoError('CAPABILITY_CHANGED', 'resume must preserve the original compaction policy');
  // Missing policy on old persisted sessions means they were created before the
  // default changed and must remain off. New sessions receive the new default.
  const compaction = persistedHost ? persistedHost.compaction ?? false : requestedCompaction ?? { ...defaultCompactionPolicy };
  if (persistedHost && requestedAssembly && JSON.stringify(requestedAssembly) !== JSON.stringify(persistedHost.assembly)) throw new KodoError('CAPABILITY_CHANGED', 'resume must preserve the original assembly policy');
  const assembly = persistedHost?.assembly ?? requestedAssembly;
  if (persistedHost && ((values.memory !== undefined && values.memory !== Boolean(persistedHost.memory)) || (values['lazy-tools'] !== undefined && values['lazy-tools'] !== Boolean(persistedHost.lazyTools)) || (requestedVerification !== undefined && JSON.stringify(requestedVerification) !== JSON.stringify(persistedHost.verification)))) throw new KodoError('CAPABILITY_CHANGED', 'resume must preserve the original optional runtime configuration');
  const memory = persistedHost?.memory ?? values.memory;
  const lazyTools = persistedHost?.lazyTools ?? values['lazy-tools'];
  const verification = persistedHost?.verification ?? requestedVerification;
  const packages = new PackageRegistry(path.join(directory, 'capabilities'));
  let activeHost = persistedHost;
  const runtimeDeny = (workspace: string): string[] => {
    const relative = path.relative(workspace, directory);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? [] : [relative || '.'];
  };
  if (values.unlock) {
    if (command !== 'doctor') throw new KodoError('ARGUMENTS', '--unlock is only valid for doctor');
    unlockData(directory);
  }
  let currentRun: string | undefined;
  let tui: TuiActions | undefined;
  const startup = new AbortController();
  const app = new Application(directory, undefined, (runId, text) => {
    if (tui) { tui.onText(runId, text); return; }
    if (!currentRun || app.store.run(runId).sessionId !== app.store.run(currentRun).sessionId) return;
    if (values.json) console.log(JSON.stringify({ type: 'text.delta', runId, transient: true, data: { text } }));
    else if (runId === currentRun) process.stderr.write(terminalText(text));
  }, { readOnlyCommands, ...agentModels, ...(sandbox ? { sandbox } : {}), ...trustedTools, compaction, ...(assembly ? { assembly } : {}), ...(memory !== undefined ? { memory } : {}), ...(lazyTools !== undefined ? { lazyTools } : {}), ...(verification ? { verification } : {}) });
  const interrupt = (): void => {
    if (tui) return; // runTui owns terminal signals while its screen is mounted.
    if (currentRun) app.coordinator.cancel(currentRun); else startup.abort(new KodoError('CANCELLED', 'user cancelled before execution'));
  };
  const terminate = (): void => { if (!tui) interrupt(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const unsubscribe = app.store.subscribe(event => {
    if (activeHost && event.sessionId === activeHost.sessionId && ['run.queued', 'message.created'].includes(event.type)) {
      activeHost.runIds = app.store.listRuns(activeHost.sessionId).map(run => run.id);
      activeHost.questionIds = app.coordinator.mailbox.userQuestions(activeHost.sessionId).map(question => question.id);
      writeHostState(directory, hostState);
    }
    if (useTui || !currentRun || event.sessionId !== app.store.run(currentRun).sessionId) return;
    const result = event.type === 'run.completed' ? app.store.readBlob<{ text: string; quality: { status: string } }>(String(event.data.resultRef)) : undefined;
    if (values.json) console.log(JSON.stringify(result ? { ...event, data: { ...event.data, result } } : event));
    else if (result && event.runId === currentRun) { console.log(terminalText(result.text)); console.error(`验收：${result.quality.status === 'passed' ? '通过' : '未被验收'}`); }
    else if (event.type === 'run.failed' || event.type === 'run.interrupted') console.error(terminalText(String(event.data.error)));
    else if (event.type === 'exploration.planned') console.error(terminalText(`探索分工 ${String(event.data.batchId)}：${Array.isArray(event.data.mapping) ? event.data.mapping.filter((item: { execution?: string }) => item.execution === 'child').length : 0} 个只读子任务`));
    else if (event.type === 'knowledge.saved') console.error(terminalText(`知识已保存 ${String(event.data.id)}@${String(event.data.revision)}（${String(event.data.freshness)}，候选结论）`));
    else if (event.type === 'knowledge.used') console.error(terminalText(`知识已采用：${JSON.stringify(event.data.uses)}`));
    else console.error(terminalText(`${event.type}${event.data.name ? ` ${String(event.data.name)}` : ''}`));
  });
  const completionValidator = (runId: string): CompletionValidator | undefined => {
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    if (!session.verificationCommand) return;
    const verification = session.verificationCommand;
    return async ({ signal }) => {
      const workspace = runWorkspace(app.store, run);
      const output = await runProcess(verification.program, verification.args, workspace, run.binding.apiKeyEnv, AbortSignal.any([signal, AbortSignal.timeout(session.budget.toolTimeoutMs)]), sandbox ? { sandbox: { ...sandbox, workspace, scope: run.scope, write: session.permissions.includes('write'), deny: runtimeDeny(workspace) } } : undefined);
      const passed = output.exitCode === 0 && !output.cancelled && !output.outputLimitExceeded;
      const secret = process.env[run.binding.apiKeyEnv];
      const redact = (text: string): string => secret ? text.replaceAll(secret, '[REDACTED]') : text;
      return { passed, feedback: passed ? undefined : redact(`Verification command failed (exit ${output.exitCode}): ${output.stderr || output.stdout}`).slice(0, 16000), evidence: { ...output, stdout: redact(output.stdout), stderr: redact(output.stderr) } };
    };
  };
  const attachVerification = (runId: string): void => {
    const run = app.store.run(runId);
    if (terminal(run.status) && !(run.requiresValidation && run.status === 'failed' && run.error?.startsWith('UNKNOWN_WRITE:'))) return;
    const validator = completionValidator(runId);
    if (validator) app.setCompletionValidator(runId, validator);
  };
  try {
    if (['spawn', 'resume', 'continue', 'input', 'answer', 'rewind'].includes(command!)) {
      const sessionId = command === 'spawn' ? argument : command === 'answer' ? app.store.message(argument!)?.sessionId : app.store.run(argument!).sessionId;
      if (hostState.some(host => host.sessionId === sessionId && host.tuiApproval)) throw new KodoError('TUI_APPROVAL_REQUIRED', `Open kodo and use /resume to continue this session with interactive tool approvals. Session: ${sessionId}`);
    }
    if (persistedHost?.package && !['inspect', 'context', 'context-report', 'knowledge', 'cancel', 'interrupt', 'rewind', 'runs', 'list', 'gc', 'doctor'].includes(command!)) {
      const identity = persistedHost.package;
      const installed = await packages.inspect(identity.id, identity.version);
      if (installed.digest !== identity.digest) throw new KodoError('CAPABILITY_CHANGED', 'the original package digest has changed');
      const original = app.store.session(persistedHost.sessionId);
      await packages.activate(app, identity.id, identity.version, { workspace: original.workspace, deny: runtimeDeny(original.workspace), stdio: { write: identity.stdioWrite, network: identity.stdioNetwork }, reuseVerification: true, signal: startup.signal });
    }
    if (command === 'runs' || command === 'list') {
      console.log(JSON.stringify(app.store.listRuns().map(run => ({ id: run.id, sessionId: run.sessionId, parentId: run.parentId, status: run.status, objective: run.objective, createdAt: run.createdAt })), null, values.json ? undefined : 2));
      return;
    }
    if (command === 'gc') {
      console.log(JSON.stringify(app.store.gc({ vacuum: values.vacuum, olderThanDays: values['older-than-days'] === undefined ? undefined : Number(values['older-than-days']) })));
      return;
    }
    if (command === 'doctor') {
      const configured = resolveConfiguredBinding();
      const sandboxProbe = values.sandbox ? await createSandbox({ ...sandbox, workspace: process.cwd(), scope: { read: [], write: [] } }).run(process.execPath, ['-e', 'process.stdout.write("sandbox-ok")'], { signal: AbortSignal.any([startup.signal, AbortSignal.timeout(30000)]) }) : undefined;
      const diagnostics = {
        node: process.version, sqlite: app.store.quickCheck(),
        chineseTrigram: app.store.probeSearch(),
        configPath: userConfigPath(), provider: configured.provider ?? null,
        modelConfigured: Boolean(configured.binding.model),
        credentialConfigured: hasModelCredentials(configured.binding),
        interruptedRuns: app.store.listRuns().filter(x => x.status === 'interrupted').map(x => x.id),
        status: 'development-preview',
        ...(sandboxProbe ? { sandbox: { passed: sandboxProbe.exitCode === 0 && sandboxProbe.stdout === 'sandbox-ok' && !sandboxProbe.cancelled, exitCode: sandboxProbe.exitCode, stderr: sandboxProbe.stderr } } : {}),
      };
      console.log(JSON.stringify(diagnostics, null, 2));
      if (!diagnostics.chineseTrigram || diagnostics.sqlite !== 'ok') process.exitCode = 1;
      if (diagnostics.sandbox && !diagnostics.sandbox.passed) process.exitCode = 1;
      return;
    }
    if (command === 'inspect') {
      const run = app.store.run(argument!);
      console.log(JSON.stringify(values.context ? app.context(run.id) : app.snapshot(run.id), null, values.json ? undefined : 2));
      return;
    }
    if (command === 'context') { console.log(JSON.stringify(app.context(argument!), null, values.json ? undefined : 2)); return; }
    if (command === 'context-report') { console.log(JSON.stringify(app.contextReport(argument!), null, values.json ? undefined : 2)); return; }
    if (command === 'knowledge') {
      const knowledge = app.coordinator.knowledge!;
      const integer = (value: string | undefined): number | undefined => {
        if (value === undefined) return undefined;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new KodoError('ARGUMENTS', 'knowledge pagination and revision require nonnegative integers');
        return Number(value);
      };
      const reading = values['knowledge-id'] !== undefined;
      if (reading !== (values.revision !== undefined) || (reading && [values.query, values['parent-id'], values.after, values.in].some(value => value !== undefined)) || (!reading && values.offset !== undefined) || (values.query !== undefined && values['parent-id'] !== undefined) || (values.in !== undefined && values.query === undefined) || (values.in !== undefined && !['summary', 'evidence'].includes(values.in))) throw new KodoError('ARGUMENTS', 'choose directory browsing, query with in summary|evidence, or knowledge-id with revision and optional offset');
      const result = reading ? knowledge.read(argument!, { id: values['knowledge-id']!, revision: integer(values.revision)!, offset: integer(values.offset) }) : values.query !== undefined ? knowledge.search(argument!, { query: values.query, in: values.in as 'summary' | 'evidence' | undefined, after: integer(values.after) }) : knowledge.browse(argument!, { parentId: values['parent-id'], after: values.after }, true);
      console.log(JSON.stringify(result, null, values.json ? undefined : 2)); return;
    }
    if (settlingCall) {
      console.log(JSON.stringify(app.resolveCall(argument!, values.applied ? 'applied' : 'not_applied', values.evidence!), null, values.json ? undefined : 2));
      return;
    }
    if (command === 'rewind') {
      console.log(JSON.stringify(await app.rewind(argument!, Number(values.to)), null, values.json ? undefined : 2));
      return;
    }
    if (command === 'interrupt') {
      app.coordinator.interrupt(argument!);
      console.log(JSON.stringify(await app.coordinator.waitForStop(argument!), null, values.json ? undefined : 2));
      return;
    }
    if (command === 'reconcile' || command === 'resolve') {
      const originalCalls = app.store.calls(argument!);
      const report = command === 'reconcile' ? await app.reconcile(argument!) : app.resolveCall(argument!, values['call-id']!, { outcome: values.outcome as 'succeeded' | 'not_applied' | 'failed', evidence: values.evidence!, retry: values.retry });
      console.log(JSON.stringify({ ...report, originalCalls }, null, values.json ? undefined : 2));
      return;
    }
    let result: Run;
    if (command === 'spawn') {
      const child = app.spawnAgent(argument!, { objective: values.objective!, ...(values['model-binding'] ? { model_binding: values['model-binding'] } : {}), ...(values.scope ? { scope: parseSpawnScope(values.scope) } : {}) });
      currentRun = child.id;
      attachVerification(child.id);
      result = await app.run(child.id);
    } else if (command === 'resume') {
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
      result = command === 'cancel' ? await app.coordinator.waitForStop(run.id) : await app.run(run.id);
    } else {
      const config = userConfig ?? readUserConfig();
      const configured = resolveConfiguredBinding(values, config);
      if (!configured.binding.model && !useTui) throw new KodoError('MODEL_CONFIG', 'Select a provider model with kodo config or /model in the TUI, set KODO_MODEL, or pass --model.');
      if (!hasModelCredentials(configured.binding) && !useTui) throw new KodoError('MODEL_CREDENTIAL', 'Configure provider credentials with kodo config or set the selected credential environment variable.');
      const budget: Partial<Budget> = {};
      const budgets = { 'max-tokens': 'maxTokens', 'max-model-calls': 'maxModelCalls', 'max-tool-calls': 'maxToolCalls', 'max-output-tokens': 'maxOutputTokens', 'max-context-chars': 'maxContextChars', 'max-context-tokens': 'maxContextTokens', 'timeout-ms': 'maxDurationMs', 'tool-timeout-ms': 'toolTimeoutMs', 'max-children': 'maxChildren', 'max-active-children': 'maxActiveChildren', 'max-concurrent-models': 'maxConcurrentModels', 'cache-read-cost-percent': 'cacheReadCostPercent' } as const;
      for (const [flag, field] of Object.entries(budgets)) {
        const value = values[flag as keyof typeof values];
        if (value !== undefined) {
          if (field === 'maxChildren' && value === 'none') budget.maxChildren = null;
          else budget[field] = Number(value);
        }
      }
      const explicitPermissions: Permission[] = ['read'];
      if (values['allow-write']) explicitPermissions.push('write');
      if (values['allow-exec']) explicitPermissions.push('exec');
      const permissions: Permission[] = useTui ? ['read', 'write', 'exec'] : explicitPermissions;
      const workspace = path.resolve(values.workspace ?? process.cwd());
      const prices = [values['input-price'], values['output-price']];
      if (prices.some(value => value !== undefined) && prices.some(value => value === undefined || !Number.isFinite(Number(value)) || Number(value) < 0)) throw new KodoError('ARGUMENTS', 'provide both nonnegative --input-price and --output-price in USD per million tokens');
      const rates = prices.every(value => value !== undefined) ? { input: Number(prices[0]), output: Number(prices[1]) } : undefined;
      const selectedPackage = values.package ? values.package.includes('@') ? packageIdentity(values.package) : await (async () => {
        const pointer = await packages.current(values.package!);
        if (!pointer) throw new KodoError('PACKAGE_REGISTRY', 'package has no adopted version; specify author/name@version or adopt a version first');
        return { id: values.package!, version: pointer.version };
      })() : undefined;
      const packageCard = selectedPackage ? await packages.activate(app, selectedPackage.id, selectedPackage.version, { workspace, deny: runtimeDeny(workspace), stdio: { write: Boolean(values['allow-write']), network: sandbox?.network ?? 'none' }, verifyExamples: verifyToolExamples({ workspace, permissions: explicitPermissions }), signal: startup.signal }) : undefined;
      if (useTui) {
        const [{ TuiController }, { runTui }, { createCliTuiOptions }] = await Promise.all([import('../tui/controller.js'), import('../tui/index.js'), import('./tui-host.js')]);
        const options = createCliTuiOptions({
          options: { app, workspace, registry: packages, permissions, budget, rates, completionValidator,
            binding: configured.binding, modelConfig: tuiModelConfig(configured, config),
            card: packageCard ?? (values.card ? app.parseCard(readFileSync(path.resolve(values.card), 'utf8')) : undefined),
            activatePackage: (id, version) => packages.activate(app, id, version, { workspace, deny: runtimeDeny(workspace), stdio: { write: Boolean(values['allow-write']), network: sandbox?.network ?? 'none' }, verifyExamples: verifyToolExamples({ workspace, permissions: explicitPermissions }), reuseVerification: true, signal: startup.signal }),
            activatePackageAt: (id, version, caseWorkspace, signal) => packages.activate(app, id, version, { workspace: caseWorkspace, deny: runtimeDeny(caseWorkspace), stdio: { write: Boolean(values['allow-write']), network: sandbox?.network ?? 'none' }, verifyExamples: verifyToolExamples({ workspace: caseWorkspace, permissions: explicitPermissions }), signal }),
          },
          policy: { ...(sandbox ? { sandbox } : {}), ...(trustedTools ? { tools: trustedTools } : {}), compaction, ...(assembly ? { assembly } : {}), ...(memory !== undefined ? { memory } : {}), ...(lazyTools !== undefined ? { lazyTools } : {}), ...(verification ? { verification } : {}) },
          state: hostState, verificationCommand: values['verify-command'], finalResponse: values['allow-empty-response'] ? 'optional' : 'required', stdioWrite: Boolean(values['allow-write']),
          ...(selectedPackage ? { package: { ...selectedPackage, digest: (await packages.inspect(selectedPackage.id, selectedPackage.version)).digest, stdioWrite: Boolean(values['allow-write']), stdioNetwork: sandbox?.network ?? 'none' } } : {}),
          select: id => { currentRun = id; }, attachVerification, onHost: host => { activeHost = host; },
        });
        tui = new TuiController(options);
        try {
          const screen = runTui(tui);
          // Submission errors are already visible in the workspace; keep it open for correction.
          if (argument) await tui.submit(argument).catch(() => undefined);
          await screen;
        } finally { await tui.close(); }
        return;
      }
      const run = await app.createRunWithDiscovery({ objective: argument!, workspace,
        binding: configured.binding,
        permissions, budget, finalResponse: values['allow-empty-response'] ? 'optional' : 'required', card: packageCard ?? (values.card ? app.parseCard(readFileSync(path.resolve(values.card), 'utf8')) : undefined) }, startup.signal);
      const session = app.store.session(run.sessionId);
      {
        activeHost = { sessionId: session.id, runIds: [run.id], questionIds: [], ...(sandbox ? { sandbox } : {}), ...(trustedTools ? { tools: trustedTools } : {}), compaction, ...(assembly ? { assembly } : {}), ...(memory !== undefined ? { memory } : {}), ...(lazyTools !== undefined ? { lazyTools } : {}), ...(verification ? { verification } : {}), ...(selectedPackage ? { package: { ...selectedPackage, digest: (await packages.inspect(selectedPackage.id, selectedPackage.version)).digest, stdioWrite: permissions.includes('write'), stdioNetwork: sandbox?.network ?? 'none' } } : {}) };
        hostState.push(activeHost);
        writeHostState(directory, hostState);
      }
      let commandArgv: unknown;
      if (values['verify-command']) {
        try { commandArgv = JSON.parse(values['verify-command']); } catch { throw new KodoError('ARGUMENTS', '--verify-command must be a JSON array of program and arguments'); }
        if (!Array.isArray(commandArgv) || !commandArgv.length || commandArgv.some(value => typeof value !== 'string' || value.includes('\0')) || !commandArgv[0]) throw new KodoError('ARGUMENTS', '--verify-command must be a nonempty JSON argv array');
        app.store.putSession({ ...session, verificationCommand: { program: commandArgv[0] as string, args: commandArgv.slice(1) as string[] } });
        attachVerification(run.id);
      }
      const costUpperBoundUSD = rates && session.budget.maxTokens !== null ? session.budget.maxTokens * Math.max(rates.input, rates.output) / 1_000_000 : null;
      const budgetInfo = { limits: session.budget, modelLimits: session.modelLimits, compaction: compaction || null, assembly: assembly ?? null, costUpperBoundUSD, ratesPerMillionTokens: rates ?? null,
        costNote: session.budget.maxTokens === null ? 'No cumulative token limit; cost depends on actual usage.' : 'Conservative projection at supplied rates; excludes cache discounts and non-token charges.' };
      if (values.json) console.log(JSON.stringify({ type: 'budget.info', runId: run.id, data: budgetInfo }));
      else {
        const limit = (value: number | null): string => value === null ? '不限' : String(value);
        console.error(`模型窗口 ${session.budget.maxContextTokens} tokens，单次输出上限 ${session.budget.maxOutputTokens} tokens（来源：${session.modelLimits?.source}）。`);
        console.error(`会话限额：累计 token ${limit(session.budget.maxTokens)}，模型调用 ${limit(session.budget.maxModelCalls)} 次，工具调用 ${limit(session.budget.maxToolCalls)} 次，活动时长 ${limit(session.budget.maxDurationMs)} 毫秒。`);
        console.error(compaction ? `上下文压缩：${compaction.strategy}，${compaction.workInputTokens !== undefined ? `工作预算 ${compaction.workInputTokens} tokens` : `有效窗口 ${compaction.triggerRatio ?? 0.8} 比例触发`}。` : '上下文压缩：关闭（由 --compaction off 显式关闭）。');
        console.error(assembly ? `动态组装：${assembly.strategy}，工作预算 ${assembly.workInputTokens ?? 65_536} tokens，证据额度 ${assembly.evidenceInputTokens ?? Math.min(8192, Math.floor((assembly.workInputTokens ?? 65_536) * 0.10))} tokens（实验性，无额外模型调用）。` : '动态组装：关闭（实验性策略需 --assembly 显式启用）。');
        if (session.budget.maxTokens === null) console.error('费用提醒：未设置累计 token 上限，费用随实际用量增长；默认调用次数和活动时长也不限，可用预算参数设限或手动取消。');
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
    try {
      if (activeHost) {
        activeHost.runIds = app.store.listRuns(activeHost.sessionId).map(run => run.id);
        activeHost.questionIds = app.coordinator.mailbox.userQuestions(activeHost.sessionId).map(question => question.id);
        writeHostState(directory, hostState);
      }
    } finally {
      unsubscribe();
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      await app.shutdown();
    }
  }
}
main().catch(error => { console.error(terminalText(errorText(error))); process.exitCode = error instanceof KodoError && error.code === 'CANCELLED' ? 130 : 1; });

async function main(): Promise<void> {
  return runCli(process.argv.slice(2));
}
