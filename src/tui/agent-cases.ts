import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { compareCaseRuns, runCase } from '../cases/runner.js';
import type { CaseCommand, CaseExecutionInput, CaseExecutionResult } from '../cases/runner.js';
import { caseDigest, freezeCase } from '../cases/schema.js';
import type { FrozenCase } from '../cases/schema.js';
import { CaseRunStore } from '../cases/store.js';
import type { CaseRun } from '../cases/store.js';
import type { InstalledPackage } from '../packages/schema.js';
import type { FileScope, ModelBinding, Permission } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';
import { terminalText } from '../cli/terminal.js';
import type { AgentCommandContext, TuiPanel } from './types.js';

/** The existing host owns model execution, package activation, policy and budgets. */
export interface AgentCaseHost {
  binding: ModelBinding;
  permissions: Permission[];
  scope?: FileScope;
  commands?: Record<string, CaseCommand>;
  signal?: AbortSignal;
  hostPolicyDigest(installed: InstalledPackage): Promise<string>;
  execute(input: CaseExecutionInput, installed: InstalledPackage): Promise<CaseExecutionResult>;
}
type PendingCase = { kind: 'test'; installed: InstalledPackage; frozen: FrozenCase; conditions: string; binding: ModelBinding; permissions: Permission[]; scope?: FileScope; commands?: Record<string, CaseCommand>; owner?: string };
type PendingAdoption = { kind: 'adopt' | 'rollback'; id: string; version: string; packageDigest: string; runIds: string[]; conditionsDigest?: string; pointer: string; evidence: string; owner?: string };
const requests = new WeakMap<AgentCommandContext['app'], Map<string, PendingCase | PendingAdoption>>();
function pending(context: AgentCommandContext): Map<string, PendingCase | PendingAdoption> {
  let map = requests.get(context.app); if (!map) { map = new Map(); requests.set(context.app, map); } return map;
}
function remember(context: AgentCommandContext, value: PendingCase | PendingAdoption): string {
  const map = pending(context), id = randomUUID();
  if (map.size >= 32) map.delete(map.keys().next().value!);
  map.set(id, value); return id;
}
function fail(message: string): never { throw new KodoError('TUI_AGENT_CASES', message); }
function identity(reference: string): { id: string; version: string } {
  const match = /^([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d+)$/.exec(reference);
  if (!match) fail('Specify an exact version: author/name@1.0.0.');
  return { id: match[1]!, version: match[2]! };
}
function options(args: string[], names: string[]): { positionals: string[]; values: Record<string, string | undefined> } {
  try {
    const parsed = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(names.map(name => [name, { type: 'string' as const }])) });
    return parsed as { positionals: string[]; values: Record<string, string | undefined> };
  } catch { fail('Missing arguments or unknown options.'); }
}
function exact(values: unknown[], count: number): void { if (values.length !== count) fail('Incorrect argument count. Use the command shown in the panel.'); }
function summary(run: CaseRun): string[] {
  return [`Case run: ${run.id}`, `Target: ${run.target.id}@${run.target.version}`, `Package digest: ${run.target.digest}`, `Card digest: ${run.target.cardDigest}`, `Case: ${run.case.id}@${run.case.version} · ${run.caseDigest}`, `Frozen input: ${run.inputDigest}`, `Conditions: ${run.conditionsDigest}`, `Model: ${terminalText(run.conditions.model.model)} · Permissions: ${run.conditions.permissions.join(', ')}`, `Result: ${run.status} · assertions ${run.assertions.filter(item => item.passed).length}/${run.case.assertions.length}`, ...(run.error ? [`Execution notes: ${terminalText(run.error)}`] : []), ...run.assertions.map(item => `${item.index + 1}. ${terminalText(item.detail)}`)];
}
async function conditions(host: AgentCaseHost, installed: InstalledPackage): Promise<string> {
  return caseDigest(JSON.parse(JSON.stringify({ binding: host.binding, permissions: host.permissions, scope: host.scope ?? null, commands: host.commands ?? {}, policy: await host.hostPolicyDigest(installed) })) as unknown);
}

/** Local frozen-case commands share the already-open Application and evidence store. */
export async function agentCaseCommand(context: AgentCommandContext, command: string, args: string[], host?: AgentCaseHost): Promise<TuiPanel> {
  const store = new CaseRunStore(context.app.store);
  if (command === 'cases') {
    if (args[0] === 'show') { exact(args, 2); return { title: 'Frozen case evidence', lines: summary(store.get(args[1]!)) }; }
    const parsed = options(args, ['after']); if (parsed.positionals.length > 1) fail('Use /agents cases [id@version] [--after cursor].');
    const target = parsed.positionals[0] ? identity(parsed.positionals[0]) : undefined;
    const page = store.list({ ...(target ? { targetId: target.id, version: target.version } : {}), after: Number(parsed.values.after ?? 0), limit: 30 });
    return { title: 'Local frozen cases', lines: ['Cases, inputs, target packages/cards and conditions are frozen separately. Results from different conditions cannot establish a version improvement.', ...(page.items.length ? [] : ['No case runs yet.'])], items: [...page.items.map(run => ({ id: run.id, label: `${run.case.name} · ${run.target.id}@${run.target.version} · ${run.status}`, detail: run.id, command: `/agents cases show ${run.id}` })), ...(page.next === null ? [] : [{ id: 'next', label: 'Next page', command: `/agents cases${target ? ` ${target.id}@${target.version}` : ''} --after ${page.next}` }])], hint: '/agents test id@version "case.json" · /agents compare BASELINE_RUN_ID CANDIDATE_RUN_ID' };
  }
  if (command === 'compare') {
    exact(args, 2); const baseline = store.get(args[0]!), candidate = store.get(args[1]!), comparison = compareCaseRuns(baseline, candidate);
    return { title: 'Case version comparison', lines: [`Baseline: ${baseline.target.id}@${baseline.target.version} · ${baseline.id}`, `Candidate: ${candidate.target.id}@${candidate.target.version} · ${candidate.id}`, `Comparable conditions: ${comparison.comparable ? 'yes' : 'no'}`, `Candidate passed without regressions: ${comparison.passed ? 'yes' : 'no'}`, `Regressed assertions: ${comparison.regressions.map(index => index + 1).join(', ') || 'none'}`, ...(comparison.reason ? [`Reason: ${terminalText(comparison.reason)}`] : []), 'Comparisons do not automatically adopt a version.'], items: [{ id: 'candidate', label: 'View original candidate evidence', command: `/agents cases show ${candidate.id}` }] };
  }
  if (command === 'test') {
    exact(args, 2); if (!host) fail('This host has no case execution policy configured.');
    const target = identity(args[0]!), installed = await context.registry.inspect(target.id, target.version);
    const bytes = await readFile(path.resolve(context.workspace, args[1]!));
    if (bytes.length > 4_000_000) fail('Case file exceeds 4 MB.');
    const frozen = freezeCase(JSON.parse(bytes.toString('utf8')) as unknown);
    const diagnostic = await context.registry.diagnose(target.id, target.version);
    if (diagnostic.status === 'incompatible' || diagnostic.reasons.some(reason => reason !== 'examples require verification at activation')) fail(`Case cannot run yet: ${diagnostic.reasons.join('; ')}`);
    if (frozen.definition.inputs.files.length && !host.permissions.includes('write')) fail('This case includes frozen input files, but the host has not allowed writing inputs in the isolated case directory.');
    if (frozen.definition.assertions.some(check => check.type === 'command' && !host.commands?.[check.command])) fail('The case references a fixed assertion command not configured by the host.');
    const capturedHost = { ...host, binding: structuredClone(host.binding), permissions: [...host.permissions], ...(host.scope ? { scope: structuredClone(host.scope) } : {}), ...(host.commands ? { commands: structuredClone(host.commands) } : {}) };
    const token = remember(context, { kind: 'test', installed, frozen, conditions: await conditions(capturedHost, installed), binding: capturedHost.binding, permissions: capturedHost.permissions, ...(capturedHost.scope ? { scope: capturedHost.scope } : {}), ...(capturedHost.commands ? { commands: capturedHost.commands } : {}), owner: context.runId });
    return { title: 'Confirm frozen case execution', lines: [`Agent: ${target.id}@${target.version}`, `Package digest: ${installed.digest}`, `Card digest: ${installed.card.digest}`, `Case: ${frozen.definition.id}@${frozen.definition.version} · ${frozen.digest}`, `Frozen input: ${frozen.inputDigest} · ${frozen.definition.inputs.files.length} files`, `Target: ${terminalText(frozen.definition.objective)}`, `Assertions: ${frozen.definition.assertions.map(check => check.type).join(', ')}`, `Model: ${terminalText(host.binding.model)} · Permissions: ${host.permissions.join(', ')}`, `Scope: ${terminalText(JSON.stringify(host.scope ?? {}))}`, 'Creates frozen inputs in a separate empty directory and uses the host model and capabilities against the case budget. Failures and evidence are retained; no automatic adoption.'], items: [{ id: 'confirm', label: 'Confirm model request and frozen case execution', command: `/agents case-confirm ${token}` }] };
  }
  if (command === 'adopt' || command === 'rollback') {
    const parsed = options(args, ['runs', 'conditions-digest']); exact(parsed.positionals, 1);
    const reference = parsed.positionals[0]!, previous = command === 'rollback' ? await context.registry.current(reference) : undefined;
    if (command === 'rollback' && !previous?.previous) fail('No previously adopted version is available for rollback.');
    const target = command === 'rollback' ? { id: reference, version: previous!.previous!.version } : identity(reference);
    const installed = await context.registry.inspect(target.id, target.version), runIds = (parsed.values.runs ?? '').split(',').filter(Boolean);
    if (!runIds.length || runIds.length > 100 || new Set(runIds).size !== runIds.length) fail('Provide 1–100 distinct case run IDs with --runs.');
    const rows = runIds.map(id => store.get(id));
    const pointer = await context.registry.current(target.id);
    const token = remember(context, { kind: command, id: target.id, version: target.version, packageDigest: installed.digest, runIds, conditionsDigest: parsed.values['conditions-digest'], pointer: caseDigest(pointer ?? null), evidence: caseDigest(rows), owner: context.runId });
    return { title: command === 'adopt' ? 'Confirm local version adoption' : 'Confirm local version rollback', lines: [`Target: ${target.id}@${target.version}`, `Package digest: ${installed.digest}`, `Currently adopted: ${pointer?.version ?? 'none'}`, ...rows.map(row => `${row.id} · ${row.status} · ${row.case.id}@${row.case.version} · conditions ${row.conditionsDigest}`), 'Checks current cases, package/card digests, frozen inputs and conditions. Adoption changes only with complete, regression-free evidence. Existing session rosters remain frozen.'], items: [{ id: 'confirm', label: command === 'adopt' ? 'Verify evidence and adopt' : 'Verify evidence and roll back', command: `/agents case-confirm ${token}` }] };
  }
  if (command === 'case-confirm') {
    exact(args, 1); const token = args[0]!, request = pending(context).get(token);
    if (!request || request.owner !== context.runId) fail('Confirmation has expired. Review the case or version again.');
    pending(context).delete(token);
    if (request.kind === 'test') {
      if (!host || await conditions(host, request.installed) !== request.conditions) fail('The host model, permissions, bindings or execution policy changed. Confirm the case again.');
      const installed = await context.registry.inspect(request.installed.card.id, request.installed.card.version);
      if (installed.digest !== request.installed.digest) fail('Target package content changed. Confirm the case again.');
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodo-tui-case-'));
      const result = await runCase({ store, definition: request.frozen.definition, target: { id: installed.card.id, version: installed.card.version, digest: installed.digest, cardDigest: installed.card.digest }, workspace, binding: request.binding, permissions: request.permissions, scope: request.scope, commands: request.commands, hostPolicyDigest: await host.hostPolicyDigest(installed), signal: host.signal, execute: input => host.execute(input, installed) });
      return { title: 'Frozen case result', lines: summary(result), items: [{ id: 'details', label: 'View retained case evidence', command: `/agents cases show ${result.id}` }, { id: 'adopt', label: 'Adopt this version after review', input: `/agents adopt ${installed.card.id}@${installed.card.version} --runs ${result.id}`, disabled: result.status !== 'passed' }] };
    }
    if (caseDigest(await context.registry.current(request.id) ?? null) !== request.pointer || caseDigest(request.runIds.map(id => store.get(id))) !== request.evidence) fail('The adoption pointer or case evidence changed. Review again.');
    if ((await context.registry.inspect(request.id, request.version)).digest !== request.packageDigest) fail('Target package digest changed.');
    const adoption = { store, runIds: request.runIds, ...(request.conditionsDigest ? { conditionsDigest: request.conditionsDigest } : {}) };
    const pointer = request.kind === 'adopt' ? await context.registry.adoptVerified(request.id, request.version, adoption) : await context.registry.rollbackVerified(request.id, adoption);
    return { title: request.kind === 'adopt' ? 'Local version adopted' : 'Local version rolled back', lines: [`${request.id}@${pointer.version}`, `Package digest: ${pointer.digest}`, `Evidence: ${pointer.verification?.runIds.join(', ') ?? ''}`, 'Updates affect future version selection only. Import status, local bindings and case evidence are retained separately.'] };
  }
  fail('Commands: cases, test, compare, adopt, rollback.');
}
