import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Application } from '../application/index.js';
import { cliDataDirectory, packageIdentity } from '../cli/packages.js';
import { configuredAgentModels, resolveConfiguredBinding } from '../cli/config-binding.js';
import { readUserConfig } from '../cli/user-config.js';
import { PackageRegistry } from '../packages/registry.js';
import { verifyToolExamples } from '../packages/runtime.js';
import { KodoError } from '../runtime/types.js';
import type { Permission } from '../runtime/types.js';
import { Store } from '../storage/index.js';
import { caseDigest, freezeCase } from './schema.js';
import { CaseRunStore } from './store.js';
import { compareCaseRuns, runCase } from './runner.js';
import type { CaseCommand } from './runner.js';

const help = `kodo case run <case.json> --package author/name@version [--allow-write] [--allow-exec]
kodo case list [--package author/name@version] [--after N] [--limit N]
kodo case inspect <case-run-id>
kodo case compare <baseline-run-id> <candidate-run-id>
kodo case adopt <author/name@version> --runs id,id [--conditions-digest SHA256]
kodo case rollback <author/name> --runs id,id [--conditions-digest SHA256]
Options: --data-dir path --json --provider name --model name --base-url URL --api-key-env NAME --protocol name
         --commands trusted-host-commands.json (named literal argv definitions; sandboxed, no network)
         --environment-label name
Run creates a fresh temporary workspace; fixtures, failures and evidence are retained. Cases grant no permissions.
Adoption checks the latest evidence and compares all current-version cases under the same conditions.`;
async function readJson(file: string): Promise<unknown> {
  const bytes = await readFile(path.resolve(file));
  if (bytes.length > 4_000_000) throw new KodoError('CASE_BOUNDS', 'case/policy file exceeds 4 MB');
  try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new KodoError('CASE_SCHEMA', 'case/policy file must contain valid JSON'); }
}
/** Dispatched by the host CLI; metadata operations open no model or package module. */
export async function caseCommand(args: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, 'data-dir': { type: 'string' }, package: { type: 'string' },
    provider: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' }, 'api-key-env': { type: 'string' }, protocol: { type: 'string' },
    'allow-write': { type: 'boolean' }, 'allow-exec': { type: 'boolean' }, commands: { type: 'string' }, 'environment-label': { type: 'string' },
    runs: { type: 'string' }, 'conditions-digest': { type: 'string' }, after: { type: 'string' }, limit: { type: 'string' },
  } }); } catch { throw new KodoError('ARGUMENTS', 'invalid case options; use case --help'); }
  const { positionals, values } = parsed;
  if (!positionals.length || values.help) { console.log(help); return; }
  const [command, target, other] = positionals;
  if (!['run', 'list', 'inspect', 'compare', 'adopt', 'rollback'].includes(command!) || positionals.length !== (command === 'list' ? 1 : command === 'compare' ? 3 : 2)) throw new KodoError('ARGUMENTS', 'invalid case command or target count; use case --help');
  for (const option of ['provider', 'model', 'base-url', 'api-key-env', 'protocol', 'allow-write', 'allow-exec', 'commands', 'environment-label']) if (values[option] !== undefined && command !== 'run') throw new KodoError('ARGUMENTS', `--${option} is only valid for case run`);
  if (values.package !== undefined && !['run', 'list'].includes(command!)) throw new KodoError('ARGUMENTS', '--package is only valid for case run/list');
  if (['runs', 'conditions-digest'].some(option => values[option] !== undefined) && !['adopt', 'rollback'].includes(command!)) throw new KodoError('ARGUMENTS', '--runs/--conditions-digest are only valid for adoption');
  if (['after', 'limit'].some(option => values[option] !== undefined) && command !== 'list') throw new KodoError('ARGUMENTS', '--after/--limit are only valid for case list');
  const directory = cliDataDirectory(values['data-dir'] as string | undefined);
  const registry = new PackageRegistry(path.join(directory, 'capabilities'));
  let result: unknown;
  if (command !== 'run') {
    const storage = new Store(directory);
    try {
      const store = new CaseRunStore(storage); store.interruptRunning();
      if (command === 'list') {
        const identity = typeof values.package === 'string' ? packageIdentity(values.package) : undefined;
        result = store.list({ ...(identity ? { targetId: identity.id, version: identity.version } : {}), ...(values.after !== undefined ? { after: Number(values.after) } : {}), ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}) });
      } else if (command === 'inspect') result = store.get(target!);
      else if (command === 'compare') result = compareCaseRuns(store.get(target!), store.get(other!));
      else {
        const runIds = typeof values.runs === 'string' ? values.runs.split(',').filter(Boolean) : [];
        const options = { store, runIds, ...(typeof values['conditions-digest'] === 'string' ? { conditionsDigest: values['conditions-digest'] } : {}) };
        if (command === 'rollback') result = await registry.rollbackVerified(target!, options);
        else { const identity = packageIdentity(target!); result = await registry.adoptVerified(identity.id, identity.version, options); }
      }
    } finally { storage.close(); }
  } else {
    if (typeof values.package !== 'string') throw new KodoError('ARGUMENTS', 'case run requires --package author/name@version');
    const identity = packageIdentity(values.package);
    const installed = await registry.inspect(identity.id, identity.version);
    const definition = freezeCase(await readJson(target!)).definition;
    const config = readUserConfig();
    const resolved = resolveConfiguredBinding(values, config);
    const binding = resolved.binding;
    if (!binding.model && resolved.provider === undefined && values.model === undefined && process.env.KODO_MODEL === undefined) binding.model = 'gpt-5.4';
    if (!binding.model) throw new KodoError('MODEL_CONFIG', 'Configure a model with kodo config or pass --model.');
    if (!['chat-completions', 'responses', 'anthropic'].includes(binding.protocol ?? 'chat-completions')) throw new KodoError('ARGUMENTS', 'unsupported model protocol');
    const commands = values.commands === undefined ? {} : await readJson(values.commands as string);
    if (!commands || typeof commands !== 'object' || Array.isArray(commands)) throw new KodoError('CASE_POLICY', 'trusted commands must be a JSON object keyed by command name');
    for (const command of Object.values(commands)) if (!command || typeof command !== 'object' || Array.isArray(command) || Object.keys(command).some(key => !['program', 'args', 'write'].includes(key)) || typeof command.program !== 'string' || !Array.isArray(command.args) || (command.write !== undefined && typeof command.write !== 'boolean')) throw new KodoError('CASE_POLICY', 'invalid trusted command declaration');
    const permissions: Permission[] = ['read', ...(values['allow-write'] ? ['write' as const] : []), ...(values['allow-exec'] ? ['exec' as const] : [])];
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodo-case-'));
    const application = new Application(directory, undefined, undefined, { sandbox: { network: 'none' }, ...configuredAgentModels(config) });
    const cancellation = new AbortController();
    const interrupt = (): void => cancellation.abort(new KodoError('CANCELLED', 'case execution cancelled'));
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    try {
      const store = new CaseRunStore(application.store); store.interruptRunning();
      result = await runCase({ store, definition, target: { ...identity, digest: installed.digest, cardDigest: installed.card.digest }, workspace, binding, permissions,
        hostPolicyDigest: caseDigest({ sandbox: { network: 'none' }, bindings: await registry.bindings(identity.id, identity.version) }), commands: commands as Record<string, CaseCommand>,
        ...(typeof values['environment-label'] === 'string' ? { environmentLabel: values['environment-label'] } : {}), signal: cancellation.signal,
        execute: async input => {
          const card = await registry.activate(application, identity.id, identity.version, { workspace, stdio: { write: permissions.includes('write'), network: 'none' }, verifyExamples: verifyToolExamples({ workspace, permissions }), signal: input.signal });
          const objective = input.data === undefined ? input.objective : `${input.objective}\n\nFrozen case input data:\n${JSON.stringify(input.data)}`;
          const run = application.createRun({ objective, workspace, binding, permissions, card, budget: { maxDurationMs: definition.timeoutMs ?? 120000, maxModelCalls: 30, maxToolCalls: 100 } });
          input.recordExecution?.(run.id);
          const abort = (): void => application.coordinator.cancel(run.id);
          input.signal.addEventListener('abort', abort, { once: true });
          try { const completed = await application.run(run.id); return { runId: completed.id, status: completed.status, output: completed.resultRef ? application.store.readBlob<{ text: string }>(completed.resultRef).text : '' }; }
          finally { input.signal.removeEventListener('abort', abort); }
        },
      });
      if ((result as { status: string }).status !== 'passed') process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      await application.shutdown();
    }
  }
  console.log(JSON.stringify(result, null, values.json ? undefined : 2));
}
