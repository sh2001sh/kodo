import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createAgentDraft, hostPrivateValues, safeOutput, saveAgentMethod, writeAgentDraft } from '../agents/authoring.js';
import type { AgentDraftOptions } from '../agents/authoring.js';
import { exportPackage } from '../packages/archive.js';
import { assertManifest } from '../packages/schema.js';
import { caseDigest } from '../cases/schema.js';
import { builtinToolNames } from '../tools/index.js';
import { hostToolNames } from '../tools/catalog.js';
import { KodoError } from '../runtime/types.js';
import type { ModelBinding, Provider, Run } from '../runtime/types.js';
import { terminalText } from '../cli/terminal.js';
import type { AgentCommandContext, TuiPanel } from './types.js';

/** Provider.complete is a host adapter that records a real, budgeted Application run. */
export interface AgentAuthoringHost { binding: ModelBinding; allowedTools: readonly string[]; model: Provider; signal?: AbortSignal }
interface AuthorRequest {
  kind: 'new' | 'method'; options: Omit<AgentDraftOptions, 'model' | 'signal'>;
  directory: string; archive: string; license: string; sourceUrl: string;
  owner?: string; sourceId?: string; sourceState?: string; hostState?: string;
}
const requests = new WeakMap<AgentCommandContext['app'], Map<string, AuthorRequest>>();
function pending(context: AgentCommandContext): Map<string, AuthorRequest> {
  let map = requests.get(context.app); if (!map) { map = new Map(); requests.set(context.app, map); } return map;
}
function fail(message: string): never { throw new KodoError('TUI_AGENT_AUTHORING', message); }
const sourceState = (run: Run): string => caseDigest({ card: run.card.digest, status: run.status, result: run.resultRef ?? null, step: run.step });
const hostState = (host: AgentAuthoringHost): string => caseDigest(JSON.parse(JSON.stringify({ binding: host.binding, tools: [...host.allowedTools].sort() })) as unknown);
async function absent(file: string): Promise<void> {
  try { await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  fail('Output already exists. Choose a new directory or archive filename.');
}
async function validateOutput(request: AuthorRequest): Promise<void> {
  await absent(request.directory); await absent(request.archive);
  const parent = path.dirname(request.directory), canonical = await realpath(parent);
  const same = process.platform === 'win32' ? parent.toLowerCase() === canonical.toLowerCase() : parent === canonical;
  if (!same || !(await lstat(parent)).isDirectory()) fail('The output parent directory must exist and must not traverse symlinks or junctions.');
  if (path.dirname(request.archive) !== request.directory) await realpath(path.dirname(request.archive));
  assertManifest({ schema_version: 1, license: request.license, source: { url: request.sourceUrl }, files: [{ path: 'AGENT.md', sha256: '0'.repeat(64), size: 0, distributable: true }] });
}

/** Confirmed authoring calls the existing service, using the live host's metered provider. */
export async function agentAuthoringCommand(context: AgentCommandContext, command: string, args: string[], host?: AgentAuthoringHost): Promise<TuiPanel> {
  if (command === 'author-confirm') {
    if (args.length !== 1) fail('Confirmation accepts only the current authoring wizard ID.');
    const token = args[0]!, request = pending(context).get(token);
    if (!request || request.owner !== context.runId) fail('Authoring confirmation has expired. Enter the details again.');
    pending(context).delete(token);
    if (!request.options.template && (!host || hostState(host) !== request.hostState)) fail('The host model or available tools changed. Confirm again.');
    const source = request.sourceId ? context.app.store.run(request.sourceId) : undefined;
    if (source && sourceState(source) !== request.sourceState) fail('The source task version or result changed. Extract the method again.');
    await validateOutput(request);
    const options: AgentDraftOptions = { ...request.options, ...(host?.signal ? { signal: host.signal } : {}), ...(request.options.template ? {} : { model: { provider: host!.model, binding: structuredClone(host!.binding) } }) };
    const draft = source ? await saveAgentMethod({ ...options, store: context.app.store, sessionId: source.sessionId, runId: source.id }) : await createAgentDraft(options);
    const written = await writeAgentDraft(draft, { directory: request.directory, license: request.license, sourceUrl: request.sourceUrl });
    await exportPackage(written.directory, written.declaration, request.archive);
    return { title: command === 'author-confirm' && request.kind === 'method' ? 'Method draft extracted' : 'Agent draft created', lines: [`Identity: ${draft.id}@${draft.version}`, `Mode: ${draft.mode}`, `Card: ${written.cardPath}`, `Archive: ${request.archive}`, ...(draft.source ? [`Source: current session task · ${draft.source.calls} tool evidence records · source acceptance ${draft.source.quality}${draft.source.evidenceTruncated ? ' · evidence truncated' : ''}`] : []), 'The draft is not registered, adopted or verified by reuse cases. Extraction leaves the source card and existing versions unchanged.'], items: [{ id: 'import', label: 'Import the draft archive and review dependencies', input: `/agents import ${JSON.stringify(request.archive)}` }] };
  }
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args, allowPositionals: true, options: {
    id: { type: 'string' }, version: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
    output: { type: 'string' }, archive: { type: 'string' }, 'source-url': { type: 'string' }, license: { type: 'string' },
    tools: { type: 'string' }, template: { type: 'boolean' },
  } }); } catch { fail('Missing authoring arguments or unknown options.'); }
  const { values, positionals } = parsed;
  const get = (name: string): string | undefined => typeof values[name] === 'string' ? values[name] : undefined;
  if (command !== 'new' && command !== 'method') fail('Authoring commands: new and method.');
  const source = command === 'method' && positionals[0] ? context.app.store.run(positionals[0]) : undefined;
  if (positionals.length !== 1 || !get('id') || !get('output') || !get('source-url') || (command === 'method' && !get('description'))) {
    return { title: command === 'method' ? 'Extract a method (model request)' : 'Create a local agent', lines: ['Provide the intended task, unique identity, output directory and actual source URL, then confirm.', command === 'method' ? 'Extract from a completed task in this session. The source method and existing versions stay unchanged.' : 'Uses the current host model by default. Choose --template for an offline template.'], items: [{ id: 'details', label: 'Enter authoring details', input: command === 'method' ? `/agents method ${source?.id ?? 'TASK_ID'} --description "Intended task" --id local/new-method --output "new-method" --source-url ` : '/agents new "Intended task" --id local/new-agent --output "new-agent" --source-url ' }] };
  }
  if (command === 'new' && get('description')) fail('Put the new agent description after /agents new. --description is only for method extraction.');
  if (command === 'method' && values.template) fail('Method extraction requires a model. An offline template cannot replace analysis.');
  if (source) {
    if (!context.runId || context.app.store.run(context.runId).sessionId !== source.sessionId) fail('Open the source task session before extracting its method.');
    if (source.status !== 'completed' || !source.resultRef) fail('The source task must be completed with a retained result.');
  }
  if (!values.template && !host) fail('This host has no metered authoring model configured.');
  const allowed = host?.allowedTools ?? ['file.read', 'file.list', 'file.search'];
  if (source && (source.card.skills?.length || source.card.mcp?.length) && !get('tools')) fail('The source method references Skill or MCP resources. Choose --tools to extract a method using built-in tools only, or use package authoring to preserve the full resource manifest.');
  const tools = get('tools')?.split(',').map(tool => tool.trim()).filter(Boolean) ?? source?.card.tools ?? ['file.read', 'file.list', 'file.search'].filter(tool => allowed.includes(tool));
  if (tools.some(tool => !allowed.includes(tool))) fail('Selected tools exceed the capabilities explicitly allowed by this host.');
  const portable: readonly string[] = [...builtinToolNames, ...hostToolNames];
  if (tools.some(tool => !portable.includes(tool) || tool.startsWith('skill.'))) fail('This draft format does not include host extensions, Skill or MCP resources. Choose distributable built-in --tools, or use package authoring.');
  const id = get('id')!, version = get('version') ?? '0.1.0';
  if (context.app.store.registeredCards().some(card => card.id === id && card.version === version) || (await context.registry.list()).some(item => item.card.id === id && item.card.version === version)) fail('This identity and version already exist. Specify a new --version.');
  const privateValues = source ? hostPrivateValues(context.app.store, source) : [context.workspace, context.app.store.directory, ...Object.entries(process.env).filter(([name, value]) => /key|token|secret|password|credential/i.test(name) && value && value.length >= 8).map(([, value]) => value!)];
  const description = command === 'new' ? positionals[0]! : get('description')!;
  safeOutput(description, privateValues);
  if (get('name')) safeOutput(get('name')!, privateValues);
  const directory = path.resolve(context.workspace, get('output')!);
  const request: AuthorRequest = { kind: command, options: { id, version, description, name: get('name'), allowedTools: tools, privateValues, ...(values.template ? { template: true } : {}) }, directory, archive: get('archive') ? path.resolve(context.workspace, get('archive')!) : path.join(directory, 'agent.zip'), sourceUrl: get('source-url')!, license: get('license') ?? 'MIT', owner: context.runId, ...(source ? { sourceId: source.id, sourceState: sourceState(source) } : {}), ...(!values.template ? { hostState: hostState(host!) } : {}) };
  await validateOutput(request);
  const map = pending(context), token = randomUUID(); if (map.size >= 32) map.delete(map.keys().next().value!); map.set(token, request);
  return { title: values.template ? 'Confirm offline template creation' : command === 'method' ? 'Confirm method extraction' : 'Confirm agent creation', lines: [`Identity: ${id}@${version}`, `Intended task: ${terminalText(description)}`, `Tools: ${tools.join(', ') || 'none'}`, values.template ? 'No model request. Generate an offline template for review.' : `Uses host model ${terminalText(host!.binding.model)} with the current host authoring budget.`, ...(source ? [`Source task: ${source.id}`, `Source card: ${source.card.id}@${source.card.version} · ${source.card.digest}`, 'Only bounded task evidence with private values removed is sent. One completion does not verify the method.'] : []), `Output directory: ${directory}`, `Archive: ${request.archive}`, 'Writes AGENT.md, a distribution manifest and ZIP. The result remains an unadopted draft for import and independent validation.'], items: [{ id: 'confirm', label: values.template ? 'Create unadopted template' : 'Confirm model request and generate an unadopted draft', command: `/agents author-confirm ${token}` }] };
}
