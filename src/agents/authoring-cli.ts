import path from 'node:path';
import { parseArgs } from 'node:util';
import { ModelProvider } from '../providers/index.js';
import { Store } from '../storage/index.js';
import { KodoError } from '../runtime/types.js';
import type { ModelBinding, Provider } from '../runtime/types.js';
import { cliDataDirectory } from '../cli/packages.js';
import { hasModelCredentials, resolveConfiguredBinding } from '../cli/config-binding.js';
import { exportPackage } from '../packages/archive.js';
import { createAgentDraft, saveAgentMethod, writeAgentDraft } from './authoring.js';
import type { AgentDraftOptions } from './authoring.js';
import { saveConfigurationDraft } from './configuration-save.js';

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

/** Offline: the saved card reproduces the recorded configuration, so no provider is involved. */
async function saveConfigurationCommand(runId: string, values: Values, output: (text: string) => void): Promise<void> {
  const get = (key: string): string | undefined => typeof values[key] === 'string' ? values[key] : undefined;
  if (!get('session')) throw new KodoError('ARGUMENTS', 'agent save-config requires --session');
  if (['provider', 'model', 'base-url', 'api-key-env', 'protocol', 'tools', 'template'].some(key => values[key] !== undefined)) throw new KodoError('ARGUMENTS', 'agent save-config copies the recorded configuration; model, tool and template options do not apply');
  const store = new Store(cliDataDirectory(get('data-dir')));
  try {
    const draft = saveConfigurationDraft({ store, sessionId: get('session')!, runId, id: get('id')!, version: get('version'), name: get('name'), description: get('description') });
    const written = await writeAgentDraft(draft, { directory: path.resolve(get('output')!), license: get('license') ?? 'MIT', sourceUrl: get('source-url')! });
    const archive = get('archive');
    if (archive) await exportPackage(written.directory, written.declaration, path.resolve(archive));
    output(JSON.stringify({ id: draft.id, version: draft.version, mode: draft.mode, cardPath: written.cardPath, declarationPath: written.declarationPath, origin: draft.origin, ...(archive ? { archive: path.resolve(archive) } : {}), verification: 'draft-not-case-verified' }, null, values.json ? undefined : 2));
  } finally { store.close(); }
}

const help = `kodo agent create "description" --id author/name --output new-directory --source-url https://example.org/project
kodo agent save <run-id> --session <session-id> --description "reusable purpose" --id author/name --output new-directory --source-url URL
Options: --version 0.1.0 --name NAME --tools file.read,file.list,file.search --license MIT
         --archive file.zip --data-dir PATH --json --template (create only: explicit offline scaffold)
         --provider NAME --model NAME --base-url URL --api-key-env NAME --protocol chat-completions|responses|anthropic
kodo agent save-config <run-id> --session <session-id> --id author/name --output new-directory --source-url URL
         saves the ad-hoc configuration a completed child run used, without a model call
Creates reviewable drafts only; run task cases before package adoption. Saving a method requires a model.
Source runs must be completed and owned by the explicitly selected session. Output directories are never overwritten.`;

/** Entry point for the root CLI; injectable provider/output keep all authoring checks offline-testable. */
export async function agentAuthoringCommand(args: string[], host: { provider?: Provider; signal?: AbortSignal; output?: (text: string) => void } = {}): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, template: { type: 'boolean' },
      id: { type: 'string' }, version: { type: 'string' }, name: { type: 'string' }, tools: { type: 'string' },
      output: { type: 'string' }, license: { type: 'string' }, 'source-url': { type: 'string' }, archive: { type: 'string' },
      session: { type: 'string' }, description: { type: 'string' }, 'data-dir': { type: 'string' },
      provider: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' }, 'api-key-env': { type: 'string' }, protocol: { type: 'string' },
    } });
  } catch { throw new KodoError('ARGUMENTS', 'invalid agent options; use agent --help'); }
  const { values, positionals } = parsed; const output = host.output ?? console.log;
  if (values.help || !positionals.length) { output(help); return; }
  const [command, argument] = positionals;
  if (!['create', 'save', 'save-config'].includes(command!) || positionals.length !== 2 || !argument || typeof values.id !== 'string' || typeof values.output !== 'string' || typeof values['source-url'] !== 'string') throw new KodoError('ARGUMENTS', 'agent create/save/save-config requires an argument, --id, --output and --source-url; use agent --help');
  if (command === 'save-config') { await saveConfigurationCommand(argument, values, output); return; }
  if (command === 'save' && (typeof values.session !== 'string' || typeof values.description !== 'string' || values.template)) throw new KodoError('ARGUMENTS', 'agent save requires --session and --description, with model extraction');
  if (command === 'create' && (values.session !== undefined || values.description !== undefined)) throw new KodoError('ARGUMENTS', '--session and --description are only valid for agent save');
  const get = (key: string): string | undefined => typeof values[key] === 'string' ? values[key] : undefined;
  if (values.template && ['provider', 'model', 'base-url', 'api-key-env', 'protocol'].some(key => values[key] !== undefined)) throw new KodoError('ARGUMENTS', '--template cannot be combined with model options');
  let binding: ModelBinding | undefined;
  if (!values.template) {
    binding = resolveConfiguredBinding(values).binding;
    if (!['chat-completions', 'responses', 'anthropic'].includes(binding.protocol ?? 'chat-completions')) throw new KodoError('ARGUMENTS', 'unsupported model protocol');
    if (!binding.model || (!host.provider && !hasModelCredentials(binding))) throw new KodoError('ARGUMENTS', 'model extraction requires a configured model and credentials; run kodo config, or create can use --template explicitly');
  }
  const options: AgentDraftOptions = {
    description: command === 'create' ? argument : get('description')!, id: get('id')!, version: get('version'), name: get('name'),
    allowedTools: (get('tools') ?? 'file.read,file.list,file.search').split(',').map(tool => tool.trim()).filter(Boolean),
    ...(binding ? { model: { provider: host.provider ?? new ModelProvider(), binding } } : { template: true }), signal: host.signal,
  };
  let store: Store | undefined;
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new KodoError('CANCELLED', 'agent authoring cancelled'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  options.signal = AbortSignal.any([controller.signal, ...(host.signal ? [host.signal] : [])]);
  try {
    if (command === 'save') store = new Store(cliDataDirectory(get('data-dir')));
    const draft = store ? await saveAgentMethod({ ...options, store, sessionId: get('session')!, runId: argument }) : await createAgentDraft(options);
    options.signal.throwIfAborted();
    const written = await writeAgentDraft(draft, { directory: path.resolve(get('output')!), license: get('license') ?? 'MIT', sourceUrl: get('source-url')! });
    const archive = get('archive');
    if (archive) await exportPackage(written.directory, written.declaration, path.resolve(archive));
    output(JSON.stringify({ id: draft.id, version: draft.version, mode: draft.mode, cardPath: written.cardPath, declarationPath: written.declarationPath, ...(draft.source ? { source: draft.source } : {}), ...(archive ? { archive: path.resolve(archive) } : {}), verification: 'draft-not-case-verified' }, null, values.json ? undefined : 2));
  } finally { store?.close(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
