import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCard, serializeCard } from '../agents/card.js';
import { safeOutput, writeAgentDraft } from '../agents/authoring.js';
import { saveConfigurationDraft } from '../agents/configuration-save.js';
import { methodCatalogDigest } from '../extensions/methods.js';
import { CaseRunStore } from '../cases/store.js';
import { exportPackage, inspectPackage } from '../packages/archive.js';
import type { PackageBindings } from '../packages/runtime.js';
import type { InstalledPackage, PackageDeclaration } from '../packages/schema.js';
import { KodoError } from '../runtime/types.js';
import type { Card } from '../runtime/types.js';
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
function parse(args: string[], allowed: string[]): Options {
  const values: Options['values'] = {}, positional: string[] = []; let confirm = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === '--confirm' && allowed.includes('confirm')) { if (confirm) fail('Duplicate --confirm.'); confirm = true; }
    else if (token.startsWith('--')) {
      const key = token.slice(2);
      if (!allowed.includes(key) || key === 'confirm' || args[index + 1] === undefined || args[index + 1]!.startsWith('--')) fail(`Invalid option ${token}.`);
      if (values[key] && !['read', 'write'].includes(key)) fail(`Duplicate ${token}.`);
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
  const cards = new Map([...context.app.store.registeredCards(), ...packages.map(item => item.card)].map(card => [identity(card), card]));
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
  } else lines.push('Source: local card. Dependencies are checked when a host activates the package.');
  lines.push(evidence(context, card, installed), ...((card.inputs ?? []).map(slot => `Input ${slot.name}: ${slot.kind}${slot.required ? ' (required)' : ' (optional)'}${slot.description ? ` · ${display(slot.description)}` : ''}`)), 'Method:', display(card.prompt.slice(offset, offset + 4000)));
  return { title: card.name, lines, items: [
    { id: 'export', label: 'Export distributable files', input: `/agents export ${identity(card)} "agent.zip"${installed ? '' : ' --source-url "https://your-source.example"'}` },
    ...(installed ? [{ id: 'configure', label: 'Configure bindings from a local file', input: `/agents configure ${identity(card)} "bindings.json"` }, { id: 'test', label: 'Test this version with a frozen case', input: `/agents test ${identity(card)} ` }, { id: 'cases', label: 'View case evidence for this version', command: `/agents cases ${identity(card)}` }, { id: 'adopt', label: 'Adopt using case evidence', input: `/agents adopt ${identity(card)} --runs ` }] : []),
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
  items.push({ id: 'new', label: 'Create a local agent', detail: 'Choose model generation or an offline template', command: '/agents new' }, { id: 'import', label: 'Import an agent package', detail: 'Inspect ZIP contents and dependencies before activation', input: '/agents import ' }, { id: 'cases', label: 'Frozen cases and version comparisons', detail: 'Confirm execution, comparison and adoption separately', command: '/agents cases' });
  return { title: 'Agent library', lines: [`${matching.length} matching local versions${query ? ` · Search: ${display(query)}` : ''}`, 'Versions, bindings, adoption and case evidence are shown separately. Importing does not adopt or execute a package.'], items, hint: '/agents list keyword · Enter to view · /agents import "file.zip"' };
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
    if (card.skills?.length || card.mcp?.length || card.tools.some(tool => !portable.includes(tool)) || card.constraints?.rules?.length) fail('This card references external capabilities or rule files. Export a capability package with an explicit resource manifest to preserve its dependencies.');
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
  fail(`Unsupported agent action: ${display(command)}. Use /agents, show, import, export, save or cases.`);
}
