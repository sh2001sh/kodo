// Independent A/B/C adoption matrix and a separate host-fixed-team benefit matrix.
// Nothing contacts a model unless --run is explicitly supplied. Task fixtures,
// build identity, prompts, acceptance commands and policies are frozen first.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dryBinding, parseArgs, relayBinding, resolveCredentials, sessionUsage, sha256, writeJson } from './v3-eval-common.mjs';
import { prepareOutput, runMatrix, writeRegistration, completeness } from './v3-eval-matrix.mjs';
import { protectedSnapshot, deliveryCheck } from './v3-eval-ledger.mjs';

export const EXPERIMENT_ID = 'agent-roster-v1';
export const FACTORS = Object.freeze({ R0: { A: false, B: false, C: false }, RA: { A: true, B: false, C: false }, RB: { A: false, B: true, C: false }, RC: { A: false, B: false, C: true }, RABC: { A: true, B: true, C: true } });

/** Resolve host-declared contract references once inside createRun's team transaction. */
export function resolveTeamContracts(team, contracts, createArtifact) {
  const ids = new Map();
  return team.map(member => ({ ...member, ...(member.slots ? { slots: Object.fromEntries(Object.entries(member.slots).map(([name, value]) => {
    if (typeof value !== 'string' || !value.startsWith('$contract:')) return [name, value];
    const contract = value.slice('$contract:'.length);
    if (!Object.hasOwn(contracts, contract)) throw new Error(`unknown team contract: ${contract}`);
    if (!ids.has(contract)) ids.set(contract, createArtifact(contract, contracts[contract]));
    return [name, ids.get(contract)];
  })) } : {}) }));
}

/** First model: five arms; second model: only R0/RABC. Repeats alternate arm order. */
export function experimentPlan({ models, tasks = ['ky', 'frontend-backend'], repeats = 2, kind = 'adoption' }) {
  if (!Array.isArray(models) || models.length !== 2 || models.some(model => typeof model !== 'string' || !model) || new Set(models).size !== 2) throw new Error('two distinct model names are required');
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('repeats must be a positive integer');
  if (!['adoption', 'benefit'].includes(kind)) throw new Error('kind must be adoption or benefit');
  if (tasks.length !== 2 || tasks[0] !== 'ky' || tasks[1] !== 'frontend-backend') throw new Error('tasks must be ordered ky, frontend-backend');
  const cells = [];
  for (const task of tasks) for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const arms = kind === 'benefit' ? ['solo', 'fixed-team'] : modelIndex === 0 ? Object.keys(FACTORS) : ['R0', 'RABC'];
    for (let repeat = 1; repeat <= repeats; repeat++) for (const arm of repeat % 2 ? arms : arms.toReversed()) {
      cells.push({ key: `${kind}-${task}-m${modelIndex + 1}-${arm}-${repeat}`, kind, task, model: models[modelIndex], arm, repeat, factors: kind === 'benefit' ? FACTORS.RABC : FACTORS[arm] });
    }
  }
  return cells;
}

/** Model-visible discovery responses, including rows already returned in another call. */
export function delegationMetrics({ calls, children, events, initialMembers = [] }) {
  const discoveries = calls.filter(call => ['agent.directory', 'agent.search'].includes(call.name));
  const selected = calls.find(call => call.name === 'spawn_agent' && call.status === 'succeeded');
  const identity = value => {
    if (!value) return undefined;
    if (typeof value === 'object') return { id: value.id, version: value.version };
    const separator = value.lastIndexOf('@');
    return separator > 0 ? { id: value.slice(0, separator), version: value.slice(separator + 1) } : { id: value };
  };
  const matches = (left, right) => left?.id === right?.id && (!left?.version || !right?.version || left.version === right.version);
  const spawned = children.find(child => child.id === selected?.result?.id || child.card.id === selected?.arguments?.agent);
  const selectedIdentity = identity(selected?.result?.card?.derivedFrom ?? spawned?.card?.derivedFrom ?? selected?.result?.card ?? (selected?.arguments?.card_id ? { id: selected.arguments.card_id, version: selected.arguments.card_version } : selected?.arguments?.agent));
  const seen = initialMembers.map(identity);
  for (const call of calls) {
    if (call === selected) break;
    if (['agent.directory', 'agent.search', 'agent.route'].includes(call.name)) for (const card of call.result?.cards ?? []) if (!seen.some(previous => matches(previous, identity(card)))) seen.push(identity(card));
  }
  // Attempts and actual task runs are different: a retried follow-up can return
  // the same run, and its persisted event can repeat the same evidence.
  const childRuns = [...new Map(children.map(child => [child.id ?? child, child])).values()];
  const byRunId = new Map(childRuns.filter(child => child.id).map(child => [child.id, child]));
  const childIdentity = child => {
    const visited = new Set();
    let current = child;
    while (!current.agentId && current.parentId && current.continuationOf && !visited.has(current.id)) {
      visited.add(current.id);
      const source = byRunId.get(current.continuationOf);
      if (!source || source.parentId !== current.parentId || source.sessionId !== child.sessionId || !['completed', 'failed', 'cancelled'].includes(source.status)) break;
      current = source;
    }
    return current.agentId ?? current.id ?? current;
  };
  const followups = calls.filter(call => call.name === 'followup_task');
  const successfulFollowups = followups.filter(call => call.status === 'succeeded');
  const followupIds = new Set([
    ...successfulFollowups.map(call => call.result?.id),
    ...events.filter(event => event.type === 'agent.followup').map(event => event.data?.result?.id),
  ].filter(id => byRunId.has(id)));
  const followupChildren = childRuns.filter(child => followupIds.has(child.id));
  return {
    delegationCalls: calls.filter(call => ['spawn_agent', 'explore'].includes(call.name)).length,
    spawnedChildren: children.length, memberTypes: children.map(child => ({ id: child.card.id, mode: child.card.routing?.mode ?? (child.explore ? 'read' : 'legacy') })),
    followupCalls: followups.length,
    successfulFollowupCalls: successfulFollowups.length,
    childRuns: childRuns.length,
    distinctChildAgents: new Set(childRuns.map(childIdentity)).size,
    followupRuns: followupChildren.length,
    reusedChildAgents: new Set(followupChildren.map(childIdentity)).size,
    directoryCalls: discoveries.filter(call => call.name === 'agent.directory').length,
    searchCalls: discoveries.filter(call => call.name === 'agent.search').length,
    returnedMembers: discoveries.reduce((sum, call) => sum + (call.result?.cards?.length ?? 0), 0),
    returnedCategories: discoveries.reduce((sum, call) => sum + (call.result?.nodes?.length ?? call.result?.namespaces?.length ?? 0), 0),
    firstSelectionRank: selectedIdentity && seen.some(member => matches(member, selectedIdentity)) ? seen.findIndex(member => matches(member, selectedIdentity)) + 1 : null,
    budgetExhausted: calls.filter(call => call.result?.status === 'budget_exhausted').length,
    slotValidationErrors: calls.filter(call => String(call.result?.error ?? '').includes('INPUT_SLOTS')).length,
    reportCorrections: events.filter(event => event.type === 'report.correction_requested').length,
    childPrefixShared: events.filter(event => event.type === 'child.prefix_shared').map(event => event.data),
  };
}

export function summarize(plan, results, { dryRun = false } = {}) {
  const coverage = completeness(plan.map(cell => cell.key), results);
  const groups = {};
  for (const cell of plan) groups[`${cell.kind}:${cell.task}:${cell.model}:${cell.arm}`] ??= { planned: 0, completed: 0, successful: 0, delegated: 0 };
  for (const cell of plan) groups[`${cell.kind}:${cell.task}:${cell.model}:${cell.arm}`].planned++;
  for (const result of results) {
    const cell = plan.find(cell => cell.key === result.key);
    if (!cell) continue;
    const group = groups[`${cell.kind}:${cell.task}:${cell.model}:${cell.arm}`];
    group.completed++; group.successful += result.delivery?.ok ? 1 : 0; group.delegated += result.metrics?.spawnedChildren ? 1 : 0;
  }
  return { experiment: EXPERIMENT_ID, dryRun, coverage, groups,
    descriptiveOnly: dryRun || !coverage.complete || !coverage.valid || Object.values(groups).some(group => group.completed < 2),
    interpretation: 'Adoption and fixed-team benefit are separate outcomes. No direct comparison with r10. These results alone do not establish statistical significance or causal effects.' };
}

function fixtureDigest(directory) {
  const entries = [];
  const visit = (root, relative = '') => {
    for (const item of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const name = path.posix.join(relative, item.name), file = path.join(root, item.name);
      if (item.isDirectory()) visit(file, name);
      else if (item.isFile()) entries.push([name, sha256(readFileSync(file))]);
      else throw new Error(`fixture entries must be ordinary files/directories: ${name}`);
    }
  };
  visit(directory);
  return sha256(JSON.stringify(entries));
}

function validateManifest(manifest, base, kind) {
  if (!Array.isArray(manifest.tasks) || manifest.tasks.map(task => task.id).join(',') !== 'ky,frontend-backend') throw new Error('manifest.tasks must contain ky then frontend-backend');
  return manifest.tasks.map(task => {
    if (!task.source || typeof task.objective !== 'string' || !task.objective.trim()) throw new Error(`${task.id}: source and objective are required`);
    if (typeof task.acceptance?.program !== 'string' || !Array.isArray(task.acceptance.args) || task.acceptance.args.some(arg => typeof arg !== 'string')) throw new Error(`${task.id}: acceptance requires program and string args`);
    if (kind === 'benefit' && (!Array.isArray(task.team) || !task.team.length)) throw new Error(`${task.id}: the benefit experiment requires a fixed team`);
    if (task.contracts !== undefined && (!task.contracts || typeof task.contracts !== 'object' || Array.isArray(task.contracts) || Object.entries(task.contracts).some(([name, content]) => !name || typeof content !== 'string' || !content.trim()))) throw new Error(`${task.id}: contracts must map names to nonempty content strings`);
    return { ...task, source: path.resolve(base, task.source) };
  });
}

async function executeCell({ cell, task, outRoot, cli, credentials, remaining }) {
  const directory = path.join(outRoot, cell.key), workspace = path.join(directory, 'workspace');
  mkdirSync(directory, { recursive: true });
  cpSync(task.frozen, workspace, { recursive: true, errorOnExist: true });
  const protectedFiles = task.protected ?? [];
  const before = protectedSnapshot(workspace, protectedFiles);
  const { Application, ModelProvider } = await import('../../dist/application/index.js');
  const { serializeCard } = await import('../../dist/agents/card.js');
  const { relay, binding } = await relayBinding({ directory: path.join(directory, 'wire'), credentials, model: cell.model, maxCalls: Math.min(cli['max-calls'], remaining.requests), maxTokens: Math.min(cli['max-tokens'], remaining.tokens), maxOutputTokens: cli.output, contextTokens: cli.context });
  const baseProvider = new ModelProvider();
  const provider = cell.kind === 'benefit' ? { complete(request, signal, onText) { return baseProvider.complete({ ...request, tools: request.tools.filter(tool => !['spawn_agent', 'followup_task', 'explore', 'exploration.plan', 'agent.derive'].includes(tool.name)) }, signal, onText); } } : baseProvider;
  let app;
  const result = { ...cell };
  try {
    app = new Application(path.join(directory, 'state'), provider, undefined, { agentFactors: cell.factors, exploration: false, exploreNudge: false, instructions: { global: false }, projectRoots: task.projectRoots, verification: task.verification });
    // Both benefit arms forbid spontaneous delegation, isolating the host-fixed team.
    const card = cell.kind === 'benefit' ? app.parseCard(serializeCard({ ...app.defaultCard, id: 'experiment/fixed-controller', members: [], tools: app.defaultCard.tools.filter(name => !name.startsWith('agent.')) })) : undefined;
    const objective = task.contracts ? `${task.objective}\nAgreed task contracts:\n${JSON.stringify(task.contracts)}` : task.objective;
    const run = app.createRun({ objective, workspace, binding, permissions: task.permissions ?? ['read', 'write', 'exec'], card,
      budget: { maxModelCalls: cli['max-calls'], maxTokens: cli['max-tokens'], maxDurationMs: cli['max-duration'], maxOutputTokens: cli.output, maxContextTokens: cli.context },
      ...(cell.arm === 'fixed-team' ? { team: main => resolveTeamContracts(task.team, task.contracts ?? {}, (name, content) => app.store.artifact(main.id, app.store.blob({ name, kind: 'contract', content }))) } : {}) });
    await app.run(run.id);
    const final = app.store.run(run.id), owners = app.store.listRuns(run.sessionId);
    const calls = app.store.calls(run.id).filter(call => call.kind === 'tool').map(call => ({ ...call, arguments: JSON.parse(app.store.readBlob(call.requestRef).arguments), result: call.resultRef ? app.store.readBlob(call.modelResultRef ?? call.resultRef) : undefined }));
    const events = owners.flatMap(owner => app.store.events(owner.id));
    const initial = app.store.readBlob(run.contextRef).find(message => message.content?.startsWith('<kodo-context kind="agents"'));
    const initialMembers = initial ? JSON.parse(initial.content.slice(initial.content.indexOf('\n') + 1, initial.content.lastIndexOf('\n'))).members?.map(member => ({ id: member.id, version: member.version })) ?? [] : [];
    result.metrics = delegationMetrics({ calls, children: owners.filter(owner => owner.parentId), events, initialMembers });
    result.usage = sessionUsage(app.store, run.sessionId);
    result.agentTimeMs = Object.values(result.usage.roles).reduce((sum, role) => sum + role.durationMs, 0);
    result.status = final.status;
    const acceptance = spawnSync(task.acceptance.program === '$node' ? process.execPath : task.acceptance.program, task.acceptance.args, { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    result.acceptance = { exitCode: acceptance.status, stdout: acceptance.stdout ?? '', stderr: acceptance.stderr ?? '', error: acceptance.error?.message };
    result.delivery = deliveryCheck({ status: final.status, finalText: final.resultRef ? app.store.readBlob(final.resultRef).text : '', acceptance: acceptance.status === 0 && !acceptance.error, before, after: protectedSnapshot(workspace, protectedFiles) });
  } finally {
    try { await app?.shutdown(); } finally {
      await relay.close();
      result.relay = { requests: relay.stats.requests, tokens: relay.stats.tokens, rejected: relay.stats.rejected, estimated: relay.stats.estimated };
    }
  }
  await writeJson(path.join(directory, 'result.json'), result, credentials.key);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const cli = parseArgs(argv, { 'dry-run': { kind: 'boolean', default: false }, run: { kind: 'boolean', default: false }, manifest: { kind: 'string' }, out: { kind: 'string' }, models: { kind: 'list' }, repeats: { kind: 'integer', default: 2 }, kind: { kind: 'string', default: 'adoption' }, context: { kind: 'integer', default: 128_000 }, output: { kind: 'integer', default: 8192 }, 'max-calls': { kind: 'integer', default: 100 }, 'max-tokens': { kind: 'integer', default: 1_000_000 }, 'max-duration': { kind: 'integer', default: 900_000 }, 'matrix-calls': { kind: 'integer', default: 2000 }, 'matrix-tokens': { kind: 'integer', default: 20_000_000 } });
  if (!cli.manifest || !cli.out) throw new Error('--manifest and --out are required');
  const manifestPath = path.resolve(cli.manifest), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const tasks = validateManifest(manifest, path.dirname(manifestPath), cli.kind);
  const plan = experimentPlan({ models: cli.models, tasks: tasks.map(task => task.id), repeats: cli.repeats, kind: cli.kind });
  const outRoot = path.resolve(cli.out);
  for (const task of tasks) { const relative = path.relative(task.source, outRoot); if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('output must be outside every source fixture'); }
  prepareOutput(outRoot);
  const fixtures = {};
  for (const task of tasks) {
    fixtureDigest(task.source);
    task.frozen = path.join(outRoot, 'fixtures', task.id);
    cpSync(task.source, task.frozen, { recursive: true, errorOnExist: true });
    fixtures[task.id] = { digest: fixtureDigest(task.frozen), objective: task.objective, acceptance: task.acceptance, team: task.team, contracts: task.contracts, protected: task.protected, projectRoots: task.projectRoots, permissions: task.permissions, verification: task.verification };
  }
  writeRegistration(outRoot, { registration: { id: EXPERIMENT_ID, kind: cli.kind, exploreNudge: false, factors: FACTORS }, plan, settings: cli, fixtures, repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), requireBuild: cli.run });
  let results = [];
  if (cli.run) {
    const credentials = await resolveCredentials({});
    ({ results } = await runMatrix({ outRoot, plan: plan.map(cell => cell.key), secret: credentials.key, budget: { requests: cli['matrix-calls'], tokens: cli['matrix-tokens'] }, runCell: (key, remaining) => { const cell = plan.find(cell => cell.key === key); return executeCell({ cell, task: tasks.find(task => task.id === cell.task), cli, credentials, remaining, outRoot }); } }));
  } else writeFileSync(path.join(outRoot, 'dry-run.json'), JSON.stringify({ noModelCalls: true, plan, bindingExample: dryBinding(cli.models[0], cli.context, cli.output) }, null, 2));
  const report = summarize(plan, results, { dryRun: cli['dry-run'] });
  await writeJson(path.join(outRoot, 'summary.json'), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().then(report => process.stdout.write(`${JSON.stringify(report)}\n`)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
