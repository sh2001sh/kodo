import path from 'node:path';
import { parseArgs } from 'node:util';
import { Application } from '../application/index.js';
import { KodoError } from '../runtime/types.js';
import type { Budget, Card, Permission } from '../runtime/types.js';
import { createLocalServer } from '../web/server.js';
import { PackageRegistry } from '../packages/registry.js';
import { verifyToolExamples } from '../packages/runtime.js';
import { cliDataDirectory } from './packages.js';
import { cliAgentPolicy, cliAssemblyPolicy, cliSandboxPolicy, cliToolPolicy, cliCompactionPolicy, defaultCompactionPolicy, readHostState, writeHostState } from './host-state.js';
import type { CliHostSession } from './host-state.js';
import { configuredAgentModels, hasModelCredentials, resolveConfiguredBinding } from './config-binding.js';
import { readUserConfig } from './user-config.js';

const help = `kodo serve [--workspace PATH] [--port 0] [--data-dir PATH] [--json]
  --inline-methods [--method-unloading on|off] [--method-tool-view stable|active]
  --provider NAME --model NAME --base-url URL --api-key-env NAME --protocol chat-completions|responses|anthropic
  --allow-write --allow-exec --sandbox [--allow-network] [--sandbox-resources JSON_FILE]
  --shell-program ABSOLUTE_BASH_PATH --lsp-config JSON_FILE --webfetch [--web-hosts HOST,HOST]
  --compaction off|mask|summary|hybrid [--compaction-trigger-ratio 0.5-0.95 | --compaction-work-tokens N] (default: conditional summary at 0.8 of the effective window)
  --assembly deterministic [--assembly-work-tokens N] [--assembly-evidence-tokens N] (experimental, no extra model call)
  --agent-retention review|off --agent-factors A,B,C[,D,E]|none --project-roots JSON_FILE
  --packages (read-only capability-package panel: diagnostics, default-version and run-version views)
  --package-actions (requires --packages or --package; enables sandboxed dependency preparation and default-version switching)
  --npm-cli ABSOLUTE_PATH (requires --package-actions; trusted npm CLI module used for dependency preparation)
  --package author/name[@x.y.z] (activate an installed package for new Web tasks; omitted version uses the adopted pointer)
  --max-tokens N --max-model-calls N --max-tool-calls N --max-context-tokens N --max-output-tokens N
  --max-active-children N (default 8) --max-children N|none (cumulative; default none) --max-concurrent-models N
The server binds to 127.0.0.1. Its one-time startup secret is printed only to this terminal.
Package activation keeps the host permission/sandbox policy; a failed activation refuses startup.
The package panel is closed unless the host passes --packages or --package; actions need --package-actions.
Existing sessions can be continued only with their original trusted host configuration.
SIGINT/SIGTERM closes HTTP/SSE and interrupts active work before releasing local storage.`;

/** Explicit package requests are author/name or author/name@x.y.z; the version may resolve from the adopted pointer. */
function requestedPackage(value: string): { id: string; version?: string } {
  const match = /^([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)(?:@(\d+\.\d+\.\d+))?$/.exec(value);
  if (!match) throw new KodoError('ARGUMENTS', '--package requires author/name or author/name@1.2.3');
  return { id: match[1]!, ...(match[2] === undefined ? {} : { version: match[2] }) };
}

/** Start the loopback workbench until a shutdown signal; the API cannot grant host capabilities. */
export async function serveCommand(args: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: false, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, workspace: { type: 'string' }, port: { type: 'string' }, 'data-dir': { type: 'string' },
      provider: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' }, 'api-key-env': { type: 'string' }, protocol: { type: 'string' },
      'allow-write': { type: 'boolean' }, 'allow-exec': { type: 'boolean' }, sandbox: { type: 'boolean' }, 'allow-network': { type: 'boolean' },
      'sandbox-resources': { type: 'string' }, 'shell-program': { type: 'string' }, 'lsp-config': { type: 'string' }, webfetch: { type: 'boolean' }, 'web-hosts': { type: 'string' },
      compaction: { type: 'string' }, 'compaction-work-tokens': { type: 'string' }, 'compaction-trigger-ratio': { type: 'string' },
      assembly: { type: 'string' }, 'assembly-work-tokens': { type: 'string' }, 'assembly-evidence-tokens': { type: 'string' },
      'inline-methods': { type: 'boolean' }, 'method-unloading': { type: 'string' }, 'method-tool-view': { type: 'string' },
      'agent-retention': { type: 'string' }, 'agent-factors': { type: 'string' }, 'project-roots': { type: 'string' },
      packages: { type: 'boolean' }, 'package-actions': { type: 'boolean' }, 'npm-cli': { type: 'string' }, package: { type: 'string' },
      'max-tokens': { type: 'string' }, 'max-model-calls': { type: 'string' }, 'max-tool-calls': { type: 'string' }, 'max-context-tokens': { type: 'string' }, 'max-output-tokens': { type: 'string' },
      'max-active-children': { type: 'string' }, 'max-children': { type: 'string' }, 'max-concurrent-models': { type: 'string' },
    } });
  } catch { throw new KodoError('ARGUMENTS', 'invalid serve options; use serve --help'); }
  const { values } = parsed;
  if (values['method-unloading'] !== undefined && (!values['inline-methods'] || !['on', 'off'].includes(values['method-unloading']))) throw new KodoError('ARGUMENTS', '--method-unloading on|off requires --inline-methods');
  if (values['method-tool-view'] !== undefined && (!values['inline-methods'] || !['stable', 'active'].includes(values['method-tool-view']))) throw new KodoError('ARGUMENTS', '--method-tool-view stable|active requires --inline-methods');
  const methodToolView = (values['method-tool-view'] ?? 'stable') as 'stable' | 'active';
  const methodPolicy = values['inline-methods'] ? { inlineMethods: true, methodToolView, methodUnloading: values['method-unloading'] !== 'off' } : {};
  if (values.help) { console.log(help); return; }
  // Package switches are validated before credentials, the runtime store or any activation is touched.
  const actions = values['package-actions'] === true;
  const panelRequested = values.packages === true;
  const selectedPackage = typeof values.package === 'string' ? requestedPackage(values.package) : undefined;
  if (actions && !panelRequested && !selectedPackage) throw new KodoError('ARGUMENTS', '--package-actions requires --packages or --package');
  if (values['npm-cli'] !== undefined) {
    if (!actions) throw new KodoError('ARGUMENTS', '--npm-cli requires --package-actions');
    if (!path.isAbsolute(values['npm-cli'])) throw new KodoError('ARGUMENTS', '--npm-cli requires an absolute trusted npm CLI path');
  }
  const config = readUserConfig();
  const { binding } = resolveConfiguredBinding(values, config);
  if (!binding.model) throw new KodoError('MODEL_CONFIG', 'Configure a model with kodo config or pass --model.');
  if (!hasModelCredentials(binding)) throw new KodoError('MODEL_CREDENTIAL', 'Configure provider credentials with kodo config or set the configured API key environment variable.');
  if (!['chat-completions', 'responses', 'anthropic'].includes(binding.protocol ?? 'chat-completions')) throw new KodoError('MODEL_PROTOCOL', 'unsupported model protocol');
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (values.port !== undefined && !/^\d+$/.test(values.port))) throw new KodoError('WEB_PORT', 'port must be an integer from 0 to 65535');
  const directory = cliDataDirectory(values['data-dir']); const workspace = path.resolve(values.workspace ?? process.cwd());
  const sandbox = cliSandboxPolicy(values); const tools = cliToolPolicy(values); const compaction = cliCompactionPolicy(values) ?? { ...defaultCompactionPolicy }; const assembly = cliAssemblyPolicy(values); const agents = cliAgentPolicy(values);
  const state = readHostState(directory); const permissions: Permission[] = ['read', ...(values['allow-write'] ? ['write' as const] : []), ...(values['allow-exec'] ? ['exec' as const] : [])];
  const budget: Partial<Budget> = {};
  const budgetFlags = { 'max-tokens': 'maxTokens', 'max-model-calls': 'maxModelCalls', 'max-tool-calls': 'maxToolCalls', 'max-context-tokens': 'maxContextTokens', 'max-output-tokens': 'maxOutputTokens', 'max-active-children': 'maxActiveChildren', 'max-children': 'maxChildren', 'max-concurrent-models': 'maxConcurrentModels' } as const;
  for (const [flag, field] of Object.entries(budgetFlags)) if (values[flag as keyof typeof values] !== undefined) {
    if (field === 'maxChildren' && values['max-children'] === 'none') { budget.maxChildren = null; continue; }
    const value = Number(values[flag as keyof typeof values]);
    if (!Number.isSafeInteger(value) || value < 1) throw new KodoError('ARGUMENTS', `${flag} must be a positive safe integer`);
    budget[field] = value;
  }
  const app = new Application(directory, undefined, undefined, { ...tools, ...agents, ...methodPolicy, ...configuredAgentModels(config), ...(sandbox ? { sandbox } : {}), compaction, ...(assembly ? { assembly } : {}) });
  const controller = new AbortController(); const interrupt = (): void => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let server: Awaited<ReturnType<typeof createLocalServer>> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const registry = new PackageRegistry(path.join(directory, 'capabilities'));
    const runtimeDeny = (workspace: string): string[] => {
      const relative = path.relative(workspace, directory);
      return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? [] : [relative || '.'];
    };
    let packageCard: Card | undefined;
    let hostPackage: NonNullable<CliHostSession['package']> | undefined;
    if (selectedPackage) {
      const { id } = selectedPackage;
      let { version } = selectedPackage;
      if (version === undefined) {
        const pointer = await registry.current(id);
        if (!pointer) throw new KodoError('PACKAGE_REGISTRY', 'package has no adopted version; specify author/name@version or adopt a version first');
        version = pointer.version;
      }
      const installed = await registry.inspect(id, version).catch(() => { throw new KodoError('PACKAGE_REGISTRY', `package ${id}@${version} is not installed or is invalid`); });
      packageCard = await registry.activate(app, id, version, {
        workspace,
        deny: runtimeDeny(workspace),
        stdio: { write: permissions.includes('write'), network: sandbox?.network ?? 'none' },
        verifyExamples: verifyToolExamples({ workspace, permissions }),
        signal: controller.signal,
      });
      hostPackage = { id: installed.card.id, version: installed.card.version, digest: installed.digest, stdioWrite: permissions.includes('write'), stdioNetwork: sandbox?.network ?? 'none' };
    }
    // A session is visible only with the same trusted host capabilities and the same (or absent) package identity.
    const matching = (item: CliHostSession): boolean => JSON.stringify(item.package ?? null) === JSON.stringify(hostPackage ?? null)
      && JSON.stringify(item.sandbox) === JSON.stringify(sandbox) && JSON.stringify(item.tools) === JSON.stringify(tools)
      && JSON.stringify(item.agents) === JSON.stringify(agents)
      && Boolean(item.inlineMethods) === Boolean(methodPolicy.inlineMethods) && item.methodUnloading === methodPolicy.methodUnloading && item.methodToolView === methodPolicy.methodToolView
      && JSON.stringify(item.compaction) === JSON.stringify(compaction) && JSON.stringify(item.assembly) === JSON.stringify(assembly);
    const sessionIds = state.filter(matching).map(item => item.sessionId);
    const persist = (sessionId: string): void => {
      let item = state.find(entry => entry.sessionId === sessionId);
      if (item && !matching(item)) throw new KodoError('CAPABILITY_CHANGED', 'this session requires its original trusted host configuration');
      if (!item) { item = { ...methodPolicy, sessionId, runIds: [], questionIds: [], ...(agents ? { agents } : {}), ...(sandbox ? { sandbox } : {}), ...(tools ? { tools } : {}), compaction, ...(assembly ? { assembly } : {}), ...(hostPackage ? { package: hostPackage } : {}) }; state.push(item); }
      item.runIds = app.store.listRuns(sessionId).map(run => run.id);
      item.questionIds = app.coordinator.mailbox.userQuestions(sessionId).map(question => question.id);
      writeHostState(directory, state);
    };
    unsubscribe = app.store.subscribe(event => { if (state.some(item => item.sessionId === event.sessionId && matching(item)) && ['run.queued', 'message.created'].includes(event.type)) persist(event.sessionId); });
    const panelEnabled = panelRequested || selectedPackage !== undefined;
    server = await createLocalServer(app, {
      workspace,
      binding,
      permissions, budget, port, sessionIds, onSession: persist,
      ...(packageCard ? { card: packageCard } : {}),
      ...(panelEnabled ? { packages: {
        enabled: true,
        ...(hostPackage ? { runtime: { id: hostPackage.id, version: hostPackage.version, digest: hostPackage.digest } } : {}),
        prepare: actions,
        adopt: actions,
        ...(typeof values['npm-cli'] === 'string' ? { npmCli: path.resolve(values['npm-cli']) } : {}),
      } } : {}),
    });
    if (values.json) console.log(JSON.stringify({ type: 'server.listening', origin: server.origin, startupSecret: server.startupSecret }));
    else { console.log(`Kodo: ${server.origin}`); console.log(`Startup secret: ${server.startupSecret}`); }
    if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    unsubscribe?.();
    try { await server?.close(); } finally { await app.shutdown(); }
  }
}
