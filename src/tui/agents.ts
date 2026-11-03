import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCard, serializeCard } from '../agents/card.js';
import { safeOutput, writeAgentDraft } from '../agents/authoring.js';
import { saveConfigurationDraft } from '../agents/configuration-save.js';
import { builtinAgentCards } from '../agents/presets.js';
import { methodCatalogDigest } from '../extensions/methods.js';
import { CaseRunStore } from '../cases/store.js';
import { exportPackage, inspectPackage } from '../packages/archive.js';
import type { PackageBindings } from '../packages/runtime.js';
import type { InstalledPackage, PackageDeclaration } from '../packages/schema.js';
import { KodoError, terminal } from '../runtime/types.js';
import type { Card, CardInput, FileScope } from '../runtime/types.js';
import { terminalText } from '../cli/terminal.js';
import { hostToolNames } from '../tools/catalog.js';
import { builtinToolNames } from '../tools/index.js';
import type { AgentCommandContext, TuiItem, TuiPanel } from './types.js';
import { agentAuthoringCommand } from './agent-authoring.js';
import { agentCaseCommand } from './agent-cases.js';

function fail(message: string): never { throw new KodoError('TUI_AGENTS', message); }
const q = (value: string): string => JSON.stringify(value);
const identity = (card: Card): string => `${card.id}@${card.version}`;
const display = (value: string): string => terminalText(value);
interface Options { values: Record<string, string[]>; positional: string[]; confirm: boolean }
interface Launch { agent: string; objective: string; slots: Record<string, unknown>; scope?: FileScope; owner?: string; card: Card }
const launches = new WeakMap<AgentCommandContext['app'], Map<string, Launch>>();
function pending(context: AgentCommandContext): Map<string, Launch> {
  let value = launches.get(context.app);
  if (!value) { value = new Map(); launches.set(context.app, value); }
  return value;
}
function parse(args: string[], allowed: string[]): Options {
  const values: Options['values'] = {}, positional: string[] = []; let confirm = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === '--confirm' && allowed.includes('confirm')) { if (confirm) fail('Duplicate --confirm.'); confirm = true; }
    else if (token.startsWith('--')) {
      const key = token.slice(2);
      if (!allowed.includes(key) || key === 'confirm' || args[index + 1] === undefined || args[index + 1]!.startsWith('--')) fail(`Invalid option ${token}.`);
      if (values[key] && !['slot', 'read', 'write'].includes(key)) fail(`Duplicate ${token}.`);
      (values[key] ??= []).push(args[++index]!);
    } else positional.push(token);
  }
  return { values, positional, confirm };
}
const option = (options: Options, key: string): string | undefined => options.values[key]?.[0];
function exact(options: Options, count: number): void { if (options.positional.length !== count) fail('Missing or extra arguments. Use the command shown in the panel.'); }
const absolute = (context: AgentCommandContext, value: string): string => path.resolve(context.workspace, value);
const versionOrder = (left: Card, right: Card): number => right.version.localeCompare(left.version, undefined, { numeric: true });
async function library(context: AgentCommandContext): Promise<{ cards: Card[]; packages: InstalledPackage[] }> {
  const packages = await context.registry.list();
  const cards = new Map([...builtinAgentCards, ...context.app.store.registeredCards(), ...packages.map(item => item.card)].map(card => [identity(card), card]));
  return { cards: [...cards.values()].sort((a, b) => a.id.localeCompare(b.id) || versionOrder(a, b)), packages };
}
async function find(context: AgentCommandContext, reference: string): Promise<{ card: Card; installed?: InstalledPackage }> {
  const { cards, packages } = await library(context);
  const card = cards.find(item => identity(item) === reference) ?? cards.filter(item => item.id === reference).sort(versionOrder)[0];
  if (!card) fail(`No local agent matches ${display(reference)}. Import one or select an installed agent.`);
  return { card, installed: packages.find(item => identity(item.card) === identity(card)) };
}
function evidence(context: AgentCommandContext, card: Card, installed?: InstalledPackage): string {
  const page = new CaseRunStore(context.app.store).list({ targetId: card.id, version: card.version, limit: 100 });
  const rows = page.items.filter(row => row.target.cardDigest === card.digest && (!installed || row.target.digest === installed.digest));
  return rows.length ? `Case evidence: ${rows.filter(row => row.status === 'passed').length} passed / ${rows.filter(row => row.status === 'failed').length} failed / ${rows.filter(row => !['passed', 'failed'].includes(row.status)).length} incomplete (latest 100)` : 'Case evidence: none recorded. Importing or completing one task does not verify reuse.';
}
async function detail(context: AgentCommandContext, reference: string, offset = 0): Promise<TuiPanel> {
  const { card, installed } = await find(context, reference);
  const lines = [display(card.description ?? card.name), `Version: ${identity(card)}`, `Card digest: ${card.digest}`, `Mode: ${card.routing?.mode ?? 'inherit host permissions'} · Model role: ${card.model?.role ?? 'inherit primary task'}`, `Tools: ${card.tools.join(', ') || 'none'}`, `Skill: ${card.skills?.join(', ') || 'none'}`, `MCP: ${card.mcp?.map(server => `${server.server} (${server.tools.join(', ')})`).join('; ') || 'none'}`];
  if (installed) {
    const diagnostic = await context.registry.diagnose(card.id, card.version);
    const current = await context.registry.current(card.id);
    lines.push(`Installed: imported · Local: ${diagnostic.status === 'ready' ? 'ready' : diagnostic.status === 'incompatible' ? 'incompatible' : 'needs bindings or preparation'}`, `Adoption: ${current?.version === card.version && current.digest === installed.digest ? 'adopted' : 'not adopted'}`, ...diagnostic.reasons.map(reason => `Action needed: ${display(reason)}`), `Dependencies: ${Object.entries(installed.manifest.requirements?.dependencies ?? {}).map(([name, version]) => `${name}@${version}`).join(', ') || 'none'}`, `Distributable files: ${installed.manifest.files.map(file => file.path).join(', ')}`);
  } else lines.push('Source: local card. Dependencies are checked against the session roster at startup.');
  lines.push(evidence(context, card, installed), ...((card.inputs ?? []).map(slot => `Input ${slot.name}: ${slot.kind}${slot.required ? ' (required)' : ' (optional)'}${slot.description ? ` · ${display(slot.description)}` : ''}`)), 'Method:', display(card.prompt.slice(offset, offset + 4000)));
  return { title: card.name, lines, items: [
    { id: 'run', label: 'Use this agent', input: `/agents run ${identity(card)} ` },
    { id: 'export', label: 'Export distributable files', input: `/agents export ${identity(card)} "agent.zip"${installed ? '' : ' --source-url "https://your-source.example"'}` },
    ...(installed ? [{ id: 'configure', label: 'Configure bindings from a local file', input: `/agents configure ${identity(card)} "bindings.json"` }] : []),
    ...(installed ? [{ id: 'test', label: 'Test this version with a frozen case', input: `/agents test ${identity(card)} ` }, { id: 'cases', label: 'View case evidence for this version', command: `/agents cases ${identity(card)}` }, { id: 'adopt', label: 'Adopt using case evidence', input: `/agents adopt ${identity(card)} --runs ` }] : []),
    ...(offset + 4000 < card.prompt.length ? [{ id: 'more', label: 'Next page of method', command: `/agents show ${identity(card)} --offset ${offset + 4000}` }] : []),
  ], hint: 'Browsing makes no model requests. Host bindings and permissions are checked before execution.' };
}
async function list(context: AgentCommandContext, args: string[]): Promise<TuiPanel> {
  const options = parse(args, ['offset']);
  const offset = Number(option(options, 'offset') ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) fail('Page offset must be a non-negative integer.');
  const query = options.positional.join(' ').trim().toLowerCase();
  const { cards, packages } = await library(context);
  const matching = cards.filter(card => !query || [card.id, card.name, card.description, ...(card.routing?.use_when ?? [])].join(' ').toLowerCase().includes(query));
  const items: TuiItem[] = [];
  for (const card of matching.slice(offset, offset + 40)) {
    const installed = packages.find(item => identity(item.card) === identity(card));
    const diagnostic = installed ? await context.registry.diagnose(card.id, card.version) : undefined;
    items.push({ id: identity(card), label: `${card.name} · ${identity(card)}`, detail: `${installed ? diagnostic?.status === 'ready' ? 'Imported · ready' : diagnostic?.status === 'incompatible' ? 'Imported · incompatible' : 'Imported · needs bindings or preparation' : 'Local card'} · ${display(card.description ?? '')}`, command: `/agents show ${identity(card)}` });
  }
  if (offset + 40 < matching.length) items.push({ id: 'more', label: 'Next page', detail: '', command: `/agents list ${q(query)} --offset ${offset + 40}` });
  items.push({ id: 'new', label: 'Create a local agent', detail: 'Choose model generation or an offline template', command: '/agents new' }, { id: 'import', label: 'Import an agent package', detail: 'Inspect ZIP contents and dependencies before activation', input: '/agents import ' }, { id: 'drafts', label: 'View retention drafts', detail: 'Review method, source and digest before keeping', command: '/agents drafts' }, { id: 'cases', label: 'Frozen cases and version comparisons', detail: 'Confirm execution, comparison and adoption separately', command: '/agents cases' });
  return { title: 'Agent library', lines: [`${matching.length} matching local versions${query ? ` · Search: ${display(query)}` : ''}`, 'Versions, bindings, adoption and case evidence are shown separately. Importing does not adopt or execute a package.'], items, hint: '/agents list keyword · Enter to view · /agents import "file.zip"' };
}
function slotValue(slot: CardInput, raw: string): unknown {
  if (!raw.trim()) fail(`${slot.name} cannot be empty.`);
  if (slot.kind === 'paths') {
    const paths: unknown = raw.startsWith('[') ? JSON.parse(raw) : [raw];
    if (!Array.isArray(paths) || !paths.length || paths.some(value => typeof value !== 'string' || !value.trim())) fail(`${slot.name} requires one or more non-empty paths.`);
    return paths;
  }
  return raw;
}
function launchPanel(context: AgentCommandContext, token: string, launch: Launch): TuiPanel {
  const missing = (launch.card.inputs ?? []).filter(slot => slot.required && !Object.hasOwn(launch.slots, slot.name));
  const lines = [`Agent: ${launch.agent}`, `Task: ${display(launch.objective)}`, ...Object.entries(launch.slots).map(([name, value]) => `${name}: ${display(JSON.stringify(value))}`)];
  if (missing.length) return { title: 'Agent inputs', lines: [...lines, `Required inputs: ${missing.map(slot => slot.name).join(', ')}`, 'Enter plain text, one path, or a JSON array of paths. Contract inputs use artifact IDs from this session.'], items: missing.map(slot => ({ id: slot.name, label: `${slot.name} · ${slot.kind}`, detail: slot.description, input: `/agents fill ${token} ${slot.name} ` })), hint: 'Input changes only update this wizard. Confirm after all required inputs are ready.' };
  if (launch.card.routing?.mode === 'write' && !launch.card.constraints?.scope?.write?.length && !launch.scope?.write?.length) return { title: 'Choose a write scope', lines: [...lines, 'This agent requires explicit write roots. Choose only the directories assigned to this task.'], items: [{ id: 'scope', label: 'Enter path roots', input: `/agents scope ${token} ` }] };
  return { title: 'Confirm agent run', lines: [...lines, `Write scope: ${launch.scope?.write?.join(', ') ?? launch.card.constraints?.scope?.write?.join(', ') ?? 'inherit host scope'}`, 'This makes a model request against the session budget. The primary agent remains responsible for the final delivery.'], items: [{ id: 'launch', label: 'Start managed task', command: `/agents launch ${token}` }, { id: 'back', label: 'Back to agent library', command: '/agents' }] };
}
async function run(context: AgentCommandContext, args: string[]): Promise<TuiPanel> {
  const options = parse(args, ['slot', 'read', 'write']);
  if (!options.positional.length) return list(context, []);
  const [reference, ...objectiveParts] = options.positional;
  const parent = context.runId ? context.app.store.run(context.runId) : undefined;
  // Bare names launch the version frozen into an active session. Explicit
  // versions still reach the confirmation check and explain roster conflicts.
  const member = parent && !terminal(parent.status)
    ? context.app.store.cards.rosterSnapshot(parent.sessionId)?.members.find(item => item.card.id === reference)
    : undefined;
  const { card, installed } = await find(context, member ? identity(member.card) : reference!);
  if (!objectiveParts.length || !objectiveParts.join(' ').trim()) return { title: 'Choose a task', lines: [`Agent: ${identity(card)}`, 'Describe the task, then provide the inputs required by this agent.'], items: [{ id: 'objective', label: 'Enter task', input: `/agents run ${identity(card)} ` }] };
  if (installed) {
    const diagnostic = await context.registry.diagnose(card.id, card.version);
    if (diagnostic.status === 'incompatible' || diagnostic.reasons.some(reason => reason !== 'examples require verification at activation')) return { ...await detail(context, identity(card)), title: 'Agent needs bindings or preparation' };
  }
  const slots: Record<string, unknown> = {};
  for (const value of options.values.slot ?? []) {
    const split = value.indexOf('='); const name = value.slice(0, split); const slot = card.inputs?.find(item => item.name === name);
    if (split < 1 || !slot || Object.hasOwn(slots, name)) fail('Use declared, distinct --slot name=value arguments.');
    slots[name] = slotValue(slot, value.slice(split + 1));
  }
  const token = randomUUID();
  const scope = options.values.read || options.values.write ? { ...(options.values.read ? { read: options.values.read } : {}), ...(options.values.write ? { write: options.values.write } : {}) } : undefined;
  const launch: Launch = { agent: identity(card), card, objective: objectiveParts.join(' '), slots, scope, owner: context.runId };
  const requests = pending(context); if (requests.size >= 32) requests.delete(requests.keys().next().value!);
  requests.set(token, launch);
  return launchPanel(context, token, launch);
}
async function wizard(context: AgentCommandContext, command: string, args: string[]): Promise<TuiPanel> {
  const [token, name, ...parts] = args; const launch = token ? pending(context).get(token) : undefined;
  if (!launch || launch.owner !== context.runId) fail('This launch wizard has expired. Select the agent again.');
  if (command === 'fill') {
    const slot = launch.card.inputs?.find(item => item.name === name);
    if (!slot || !parts.length) fail('Choose a declared input and provide its value.');
    launch.slots[name!] = slotValue(slot, parts.join(' '));
  } else if (command === 'scope') {
    if (!name) fail('Provide at least one workspace-relative path root.');
    launch.scope = { ...launch.scope, write: [name, ...parts] };
  } else {
    if (args.length !== 1) fail('Launch confirmation accepts only the current wizard ID.');
    const required = (launch.card.inputs ?? []).filter(slot => slot.required && !Object.hasOwn(launch.slots, slot.name));
    if (required.length || (launch.card.routing?.mode === 'write' && !launch.card.constraints?.scope?.write?.length && !launch.scope?.write?.length)) return launchPanel(context, token!, launch);
    const parent = context.runId ? context.app.store.run(context.runId) : undefined;
    if (parent && !terminal(parent.status)) {
      const member = context.app.store.cards.rosterSnapshot(parent.sessionId)?.members.find(item => identity(item.card) === launch.agent && item.card.digest === launch.card.digest);
      if (!member || member.availability !== 'available') return { title: 'This version requires a new session', lines: [`Agent: ${launch.agent}`, 'The current session roster is frozen. Imported, configured or retained versions become available in a new session.', ...(member?.reasons.map(reason => `Current roster: ${display(reason)}`) ?? []), 'Stop the current task, create a new session, then select this version from the agent library.'], items: [{ id: 'tasks', label: 'View current tasks', command: '/tasks' }, { id: 'new', label: 'New session', command: '/new' }] };
    }
    const { installed } = await find(context, launch.agent);
    if (installed) {
      if (!context.activatePackage) fail('This host has no package activation entry point. Importing a package does not activate it.');
      await context.activatePackage(installed.card.id, installed.card.version);
    }
    if (!parent || terminal(parent.status)) await context.startTask(launch.objective, { agent: launch.agent, slots: launch.slots, scope: launch.scope });
    else {
      const child = context.app.spawnAgent(parent.sessionId, { agent: launch.agent, objective: launch.objective, slots: launch.slots, ...(launch.scope ? { scope: launch.scope } : {}) });
      context.wake(child.id);
    }
    pending(context).delete(token!);
    return { title: 'Agent task submitted', lines: [`${launch.agent}: ${display(launch.objective)}`, 'Run status, report completeness, host acceptance and primary-agent acceptance are recorded separately. Input still goes to the primary agent.'], items: [{ id: 'tasks', label: 'View running tasks', command: '/tasks' }] };
  }
  return launchPanel(context, token!, launch);
}
async function draftCommand(context: AgentCommandContext, args: string[]): Promise<TuiPanel> {
  const [action, id, ...rest] = args;
  if (!action) {
    const session = context.runId ? context.app.store.run(context.runId).sessionId : undefined;
    const drafts = context.app.retention.list(session);
    return { title: 'Agent retention drafts', lines: [drafts.length ? `${drafts.length} drafts. Review their content and evidence before keeping them.` : 'No drafts yet. The primary agent can suggest keeping agents that actually ran.'], items: drafts.map(draft => ({ id: draft.id, label: `${draft.name} · ${draft.status}`, detail: `Source: ${draft.sourceRun}`, command: `/agents drafts show ${draft.id}` })) };
  }
  if (!id) fail('Select a draft.');
  const draft = context.app.retention.get(id);
  if (action === 'show') {
    const options = parse(rest, ['offset']); exact(options, 0);
    const offset = Number(option(options, 'offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) fail('Page offset must be a non-negative integer.');
    return { title: draft.name, lines: [`Status: ${draft.status}`, `Source task: ${draft.sourceRun}`, `Draft digest: ${draft.digest}`, `Report completeness: ${draft.evidence.reportCompleteness.status} · Host acceptance: ${draft.evidence.hostAcceptance.status} · Primary acceptance: ${draft.evidence.mainAcceptance.status}`, `Tools used: ${draft.evidence.toolsUsed.join(', ') || 'none'}`, `Method and capabilities (${offset + 1}–${Math.min(offset + 4000, draft.cardContent.length)} / ${draft.cardContent.length}):`, display(draft.cardContent.slice(offset, offset + 4000))], items: [
    { id: 'approve', label: 'Keep the version with this digest', command: `/agents drafts approve ${id} --digest ${draft.digest}`, disabled: !terminal(context.app.store.run(draft.ownerRun).status) },
    { id: 'edit', label: 'Edit name and confirm again', input: `/agents drafts edit ${id} --digest ${draft.digest} --name ${q(draft.name)}` },
    { id: 'skip', label: 'Skip for now', command: `/agents drafts skip ${id} --digest ${draft.digest}` },
    { id: 'discard', label: 'Discard draft', command: `/agents drafts discard ${id} --digest ${draft.digest}` },
    ...(offset + 4000 < draft.cardContent.length ? [{ id: 'more', label: 'Next page of draft', command: `/agents drafts show ${id} --offset ${offset + 4000}` }] : []),
  ], hint: 'Keeping a draft registers the reviewed definition for future sessions. It does not imply passing case validation.' };
  }
  const options = parse(rest, ['digest', 'name', 'catalog', 'use-when']); exact(options, 0);
  const digest = option(options, 'digest');
  if (!digest) fail('Provide the displayed --digest before approving this draft.');
  if (!terminal(context.app.store.run(draft.ownerRun).status)) fail('Wait for the primary task to finish before keeping the draft.');
  if (action === 'edit') {
    const name = option(options, 'name'), catalog = option(options, 'catalog'), use = option(options, 'use-when');
    if (!name && !catalog && !use) fail('Provide --name, --catalog or --use-when.');
    context.app.retention.edit(id, digest, { ...(name ? { name } : {}), ...(catalog ? { catalog: { ...draft.card.catalog, path: catalog } } : {}), ...(use && draft.card.routing ? { routing: { ...draft.card.routing, use_when: [use] } } : {}) });
  } else {
    const userAction = { source: 'terminal_key' as const, userEventId: randomUUID() };
    if (action === 'approve') context.app.retention.approve(id, digest, userAction);
    else if (action === 'discard' || action === 'skip') context.app.retention.decide(id, digest, action === 'discard' ? 'reject' : 'skip', userAction);
    else fail('Draft commands: show, edit, approve, discard, skip.');
  }
  return draftCommand(context, ['show', id]);
}
async function exportCard(context: AgentCommandContext, args: string[]): Promise<TuiPanel> {
  const options = parse(args, ['source-url', 'license', 'version']); exact(options, 2);
  const [reference, destination] = options.positional;
  const { card, installed } = await find(context, reference!);
  const output = absolute(context, destination!);
  if (installed) {
    if (option(options, 'version')) fail('Installed packages retain their version and distribution manifest on export. Use authoring to change a version.');
    await context.registry.export(card.id, card.version, output);
  }
  else {
    const url = option(options, 'source-url');
    if (!url) return { title: 'Provide an export source', lines: ['This local card has no distribution manifest. Static export includes only AGENT.md. Provide its actual source URL.'], items: [{ id: 'source', label: 'Enter source and export', input: `/agents export ${identity(card)} ${q(destination!)} --source-url ` }] };
    const portable = [...builtinToolNames, ...hostToolNames];
    if (card.skills?.length || card.mcp?.length || card.tools.some(tool => !portable.includes(tool)) || card.constraints?.rules?.length || card.members?.length) fail('This card references external capabilities or rule files. Export a capability package with an explicit resource manifest to preserve its dependencies.');
    const version = option(options, 'version') ?? card.version;
    const content = serializeCard({ ...card, version });
    const rendered = parseCard(content);
    if (rendered.digest !== card.digest && version === card.version) return { title: 'Choose a new export version', lines: [`Original version: ${identity(card)}`, 'The original card file is unavailable. Regenerating Markdown changes its digest. Specify a new version so one version cannot refer to different content.'], items: [{ id: 'version', label: 'Enter new version and export', input: `/agents export ${identity(card)} ${q(destination!)} --source-url ${q(url)} --version ` }] };
    if (version !== card.version && (await library(context)).cards.some(existing => existing.id === card.id && existing.version === version)) fail('This version already exists in the local library. Choose a new version for the generated definition.');
    const secrets = Object.entries(process.env).filter(([key, value]) => /key|token|secret|password|credential/i.test(key) && value && value.length >= 8).map(([, value]) => value!);
    safeOutput(content, [context.workspace, context.app.store.directory, ...secrets]);
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'kodo-tui-export-'));
    try {
      await writeFile(path.join(temporary, 'AGENT.md'), content, { encoding: 'utf8', flag: 'wx' });
      const declaration: PackageDeclaration = { schema_version: 1, license: option(options, 'license') ?? 'MIT', source: { url }, files: [{ path: 'AGENT.md', distributable: true }] };
      await exportPackage(temporary, declaration, output);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const inspection = await inspectPackage(output);
  return { title: 'Agent exported', lines: [output, `Identity: ${identity(inspection.card)}`, `Content digest: ${inspection.digest}`, `Distributed files: ${inspection.manifest.files.map(file => file.path).join(', ')}`, 'The package excludes run history, local bindings and undeclared project files. Recipients must configure external services.'] };
}
async function save(context: AgentCommandContext, args: string[], configuration: boolean): Promise<TuiPanel> {
  if (!configuration) {
    if (args.length !== 1) fail('Specify the task ID to save.');
    const run = context.app.store.run(args[0]!);
    return { title: 'Save this agent', lines: [`Task: ${display(run.objective)}`, 'Saving configuration makes no model request. Extracting a method uses the separate authoring flow and a model request.', 'One successful run records that evidence only. It does not adopt the agent or verify reuse.'], items: [
      { id: 'configuration', label: 'Save actual temporary configuration (no model request)', input: `/agents save-config ${run.id} --id local/saved-agent --output "saved-agent" --source-url `, disabled: !run.card.derivedFrom || run.status !== 'completed' },
      { id: 'method', label: 'Extract a method from task evidence', command: `/agents method ${run.id}` },
    ] };
  }
  const options = parse(args, ['id', 'version', 'output', 'source-url', 'license', 'archive']); exact(options, 1);
  const run = context.app.store.run(options.positional[0]!);
  if (context.runId && context.app.store.run(context.runId).sessionId !== run.sessionId) fail('Only task configurations from the current session can be saved.');
  const id = option(options, 'id'), directory = option(options, 'output'), sourceUrl = option(options, 'source-url');
  if (!id || !directory || !sourceUrl) fail('Saving configuration requires --id, --output and an actual --source-url.');
  const draft = saveConfigurationDraft({ store: context.app.store, sessionId: run.sessionId, runId: run.id, id, version: option(options, 'version') });
  const written = await writeAgentDraft(draft, { directory: absolute(context, directory), license: option(options, 'license') ?? 'MIT', sourceUrl });
  const archive = option(options, 'archive');
  if (archive) await exportPackage(written.directory, written.declaration, absolute(context, archive));
  return { title: 'Configuration draft saved', lines: [written.cardPath, `Identity: ${draft.id}@${draft.version}`, `Evidence: one run; acceptance ${draft.origin?.quality ?? 'not_checked'}`, 'Not activated or adopted. Configurations with Skills or host extensions still require an explicit capability-package resource manifest.', ...(archive ? [`Archive: ${absolute(context, archive)}`] : [])] };
}

/** TUI operations reuse the live application's services; no second Store or CLI process is opened. */
export async function agentCommand(context: AgentCommandContext, args: string[]): Promise<TuiPanel> {
  const [command = 'list', ...rest] = args;
  if (['methods', 'install-method', 'disable-method'].includes(command)) {
    if (!context.runId) fail('Open an inline-method session first.');
    const run = context.app.store.run(context.runId!);
    const session = context.app.store.session(run.sessionId);
    const revision = methodCatalogDigest(session.methodCards);
    if (command === 'methods') return { title: 'Session methods', lines: [`Revision: ${revision}`, 'Install: /agents install-method FILE --digest REVISION', 'Disable future activation: /agents disable-method ID --digest REVISION', ...(session.methodCards ?? []).map(ref => `${ref.id}@${ref.version}`)] };
    const options = parse(rest, ['digest']); exact(options, 1);
    const expectedDigest = option(options, 'digest');
    if (!expectedDigest) fail('Use /agents methods to read the current revision, then supply --digest.');
    const result = context.app.updateSessionMethods(run.id, { expectedDigest: expectedDigest!, ...(command === 'install-method' ? { install: [context.app.parseCard(await readFile(absolute(context, options.positional[0]!), 'utf8'))] } : { disable: [options.positional[0]!] }) });
    return { title: 'Session methods updated', lines: [`Revision: ${result.digest}`, 'The active method keeps its original version; future stages see the revised catalog.'] };
  }
  if (command === 'list' || command === 'search') return list(context, rest);
  if (command === 'show') { const options = parse(rest, ['offset']); exact(options, 1); const offset = Number(option(options, 'offset') ?? 0); if (!Number.isSafeInteger(offset) || offset < 0) fail('Offset must be a non-negative integer.'); return detail(context, options.positional[0]!, offset); }
  if (command === 'run') return run(context, rest);
  if (['fill', 'scope', 'launch'].includes(command)) return wizard(context, command, rest);
  if (command === 'drafts') return draftCommand(context, rest);
  if (command === 'export') return exportCard(context, rest);
  if (command === 'save' || command === 'save-config') return save(context, rest, command === 'save-config');
  if (['new', 'method', 'author-confirm'].includes(command)) return agentAuthoringCommand(context, command, rest, context.authoringHost);
  if (['cases', 'test', 'compare', 'adopt', 'rollback', 'case-confirm'].includes(command)) return agentCaseCommand(context, command, rest, context.caseHost);
  if (command === 'import') {
    const options = parse(rest, []); exact(options, 1);
    const archive = absolute(context, options.positional[0]!);
    const checked = await inspectPackage(archive);
    const installed = await context.registry.import(archive);
    if (checked.digest !== installed.digest) fail('Archive content changed after inspection. Review it again.');
    const panel = await detail(context, identity(installed.card));
    return { ...panel, title: 'Agent imported', lines: ['Archive inspected and registered locally. It has not been activated, adopted or executed.', ...panel.lines] };
  }
  if (command === 'configure') {
    const options = parse(rest, []); exact(options, 2);
    const { card, installed } = await find(context, options.positional[0]!); if (!installed) fail('This card is not an imported capability package.');
    const bindings = JSON.parse(await readFile(absolute(context, options.positional[1]!), 'utf8')) as PackageBindings;
    await context.registry.configure(card.id, card.version, bindings);
    return { ...await detail(context, identity(card)), title: 'Local bindings updated' };
  }
  if (command === 'prepare') {
    const options = parse(rest, ['confirm']); exact(options, 1);
    const { card, installed } = await find(context, options.positional[0]!); if (!installed) fail('This card is not an imported capability package.');
    if (!options.confirm) return { title: 'Prepare dependencies', lines: [`Target: ${identity(card)}`, `Dependencies: ${Object.entries(installed.manifest.requirements?.dependencies ?? {}).map(([name, version]) => `${name}@${version}`).join(', ') || 'none'}`, 'Download locked dependencies through the host package sandbox, with lifecycle scripts disabled. Network access and a working sandbox are required.'], items: [{ id: 'prepare', label: 'Confirm declared dependency preparation', command: `/agents prepare ${identity(card)} --confirm` }] };
    await context.registry.prepareDependencies(card.id, card.version);
    return { ...await detail(context, identity(card)), title: 'Dependencies prepared' };
  }
  fail(`Unsupported agent action: ${display(command)}. Use /agents, show, run, import, export, save or drafts.`);
}
