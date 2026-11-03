import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { compactDefaultCard, defaultCard, parseCard, serializeCard } from '../src/agents/card.js';
import { initialContext } from '../src/runtime/context.js';
import { roleAllows } from '../src/runtime/role-view.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import type { Message } from '../src/runtime/types.js';
import { answer, binding, fixture, scripted, temp } from './helpers.js';

const factors = { A: true, B: true, C: true, D: true, E: true };
const signal = () => new AbortController().signal;

describe('compact stable tool profile', () => {
  it('reduces default schemas while keeping CRUD, collaboration, artifacts and recovery usable', async () => {
    const compact = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'compact-v1', taskProtocol: 2, agentFactors: factors });
    const full = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'full', taskProtocol: 1, agentFactors: factors });
    const view = (item: typeof compact) => {
      const run = item.app.store.run(item.runId);
      return toolSpecs(item.app.coordinator, run, item.app.store.session(run.sessionId));
    };
    const before = view(compact);
    const names = before.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'file.read', 'file.list', 'file.search', 'file.apply_patch', 'file.patch', 'file.mkdir', 'file.rename', 'file.delete',
      'artifact.read', 'artifact.write', 'history.read', 'history.search', 'recovery.inspect', 'todo.read', 'todo.write',
      'spawn_agent', 'wait_for_events', 'inspect_run', 'ask_user', 'cancel_agent',
    ]));
    // update_progress stays hidden in the compact default view; the 1d collaboration removals are absent everywhere.
    for (const name of ['agent.search', 'agent.directory', 'agent.route', 'agent.derive', 'agent.propose', 'agent.retain', 'knowledge.browse', 'knowledge.search', 'knowledge.read', 'explore', 'exploration.plan', 'update_progress', 'list_agents', 'followup_task', 'send_message', 'interrupt_agent', 'report.submit']) expect(names).not.toContain(name);
    expect(names.length).toBeLessThan(view(full).length);
    // 1d removed the collaboration tools both views carried, so the compact view now saves only knowledge.*/update_progress (re-measured: 16339 vs 18573 bytes).
    expect(Buffer.byteLength(JSON.stringify(before))).toBeLessThan(Buffer.byteLength(JSON.stringify(view(full))) * 0.9);

    await compact.app.coordinator.tools.execute(compact.runId, 'todo.write', { expectedRevision: 0, items: [{ id: 'independent', content: 'Independent work', status: 'in_progress' }] }, signal());
    expect(view(compact)).toEqual(before);
    const artifact = await compact.app.coordinator.tools.execute(compact.runId, 'artifact.write', { name: 'shared-contract', content: 'A single immutable behavior source.' }, signal()) as { id: string };
    expect(await compact.app.coordinator.tools.execute(compact.runId, 'artifact.read', { id: artifact.id }, signal())).toHaveProperty('content');
  });

  it('retains explicitly configured memory and web workflows with compact defaults', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, {
      taskProtocol: 2, toolProfile: 'compact-v1', instructions: { global: false }, memory: true,
      webFetch: { enabled: true, allowedHosts: ['example.org'] }, agentFactors: { E: false },
    });
    try {
      const run = app.createRun({ objective: 'Inspect the explicitly enabled workflow.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
      const session = app.store.session(run.sessionId);
      expect(session.toolProfile).toBe('compact-v1');
      const names = toolSpecs(app.coordinator, run, session).map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['memory.write', 'web.fetch']));
      // 1d removed the exploration workflows; update_progress stays hidden in the compact default view.
      for (const name of ['explore', 'exploration.plan', 'update_progress']) expect(names).not.toContain(name);
      expect((await app.run(run.id)).status).toBe('completed');
      expect(app.store.listRuns(session.id)).toHaveLength(1);
    } finally { await app.shutdown(); }
  });

  it('keeps explicit specialist and custom card tools instead of applying the default catalog filter', () => {
    const card = parseCard(serializeCard({ ...defaultCard, id: 'builtin/general-custom' }), { toolNames: defaultCard.tools });
    const run = { card };
    for (const name of ['agent.route', 'knowledge.search', 'web.fetch', 'lsp.references', 'update_progress']) {
      expect(roleAllows(run, { agentFactors: { E: false }, toolProfile: 'compact-v1' }, name)).toBe(true);
    }
    // Factor E remains an independent explicit role restriction.
    expect(roleAllows(run, { agentFactors: { E: true }, toolProfile: 'compact-v1' }, 'shell.exec')).toBe(false);
    const configuredDefault = { card: { ...compactDefaultCard, id: 'builtin/general-compact-web-lsp' } };
    expect(roleAllows(configuredDefault, { agentFactors: { E: false }, toolProfile: 'compact-v1' }, 'web.fetch')).toBe(true);
    expect(roleAllows(configuredDefault, { agentFactors: { E: false }, toolProfile: 'compact-v1' }, 'lsp.hover')).toBe(true);
    expect(roleAllows(configuredDefault, { agentFactors: { E: false }, toolProfile: 'compact-v1' }, 'update_progress')).toBe(false);
  });

  it('creates a compact worker that inherits the parent card and keeps managed execution', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'compact-v1', taskProtocol: 2, agentFactors: factors });
    const parent = app.store.run(runId);
    const child = app.spawnAgent(parent.sessionId, { objective: 'Check the assigned module.', scope: { read: ['.'], write: ['result.txt'] } });
    expect(child.card.digest).toBe(parent.card.digest);
    expect(child.card.id).toBe(parent.card.id);
    expect(child.permissions).toEqual(app.store.session(parent.sessionId).permissions);
    const names = toolSpecs(app.coordinator, child, app.store.session(child.sessionId)).map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['shell.exec', 'process.read', 'artifact.read', 'history.read', 'recovery.inspect', 'inspect_run', 'wait_for_events']));
    expect(names).not.toContain('process.exec');
    expect(names).not.toContain('workspace.commit');
    expect(names).not.toContain('workspace.integrate');
    const result = await app.coordinator.tools.execute(child.id, 'shell.exec', { command: 'printf compact-worker', background: true }, signal()) as { background: { id: string } };
    let observed: unknown;
    let stdoutOffset = 0, stderrOffset = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      observed = await app.coordinator.tools.execute(child.id, 'process.read', { id: result.background.id, stdoutOffset, stderrOffset, waitMs: 1000 }, signal());
      if ((observed as { state: string }).state !== 'running') break;
      ({ stdoutOffset, stderrOffset } = observed as { stdoutOffset: number; stderrOffset: number });
    }
    expect(observed).toMatchObject({ state: 'exited', exitCode: 0 });
  });

  it('has one default identity per profile and no specialist preset matrix', () => {
    expect(compactDefaultCard.id).not.toBe(defaultCard.id);
    expect(compactDefaultCard.version).toBe('1.2.0');
    expect(defaultCard.version).toBe('0.7.0');
  });

  it('assembles new coordination rules independently of method wording and retains legacy rendering', () => {
    const original = initialContext('/workspace', ['read'], defaultCard, 'Find an entry.', { id: 'lead' }, undefined, { factors });
    expect(original[0]!.content).toContain('Keep one main phase in_progress');
    const changedMethod = { ...compactDefaultCard, prompt: 'You are the main agent. Own delivery and acceptance. Custom method wording.' };
    const current = initialContext('/workspace', ['read'], changedMethod, 'Find an entry.', { id: 'lead' }, undefined, { factors, taskProtocol: 2, toolProfile: 'compact-v1' });
    expect(current[0]!.content).toContain('Independent items may be in_progress together');
    expect(current[0]!.content).toContain('Todo state is planning guidance, not a dispatch machine or an acceptance record.');
    expect(current[0]!.content).not.toContain('todoId');
    expect(current[0]!.content).not.toContain('Start each request with a brief plan');
    expect(current[0]!.content).not.toContain('an active agent todo blocks');
    expect(current[1]!.content).toBe(`Agent method configuration (subordinate to host rules and user task):\n${changedMethod.prompt}`);
  });

  it('retains a saved compact view when the host reopens with full defaults', async () => {
    const root = temp();
    const directory = path.join(root, '.state');
    const app = new Application(directory, scripted(answer()), undefined, { taskProtocol: 2, toolProfile: 'compact-v1', instructions: { global: false } });
    const run = app.createRun({ objective: 'Preserve this tool view.', workspace: root, binding, permissions: ['read'] });
    const session = app.store.session(run.sessionId);
    const tools = toolSpecs(app.coordinator, run, session);
    expect(session.toolProfile).toBe('compact-v1');
    await app.shutdown();
    const reopened = new Application(directory, scripted(answer()), undefined, { toolProfile: 'full', taskProtocol: 1, instructions: { global: false } });
    try {
      expect(reopened.store.session(session.id).toolProfile).toBe('compact-v1');
      expect(toolSpecs(reopened.coordinator, reopened.store.run(run.id), reopened.store.session(session.id))).toEqual(tools);
    } finally { await reopened.shutdown(); }
  });

  it.each([
    { taskProtocol: 1 as const, toolProfile: 'compact-v1' as const },
    { taskProtocol: 2 as const, toolProfile: 'full' as const },
  ])('keeps task semantics independent of tool profile: %j', async options => {
    const { app, runId } = fixture(undefined, ['read', 'write'], { ...options, agentFactors: factors });
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    const context = app.store.readBlob<Message[]>(run.contextRef);
    const specs = toolSpecs(app.coordinator, run, session);
    const spawn = specs.find(spec => spec.name === 'spawn_agent')!;
    const properties = spawn.parameters.properties as Record<string, unknown>;
    const items = [
      { id: 'one', content: 'First independent task', status: 'in_progress' },
      { id: 'two', content: 'Second independent task', status: 'in_progress' },
    ];
    expect(session.taskProtocol).toBe(options.taskProtocol);
    // 1d: todo is the same plain checklist for every task protocol; several items may be in_progress.
    expect(context[0]!.content).toContain('Independent items may be in_progress together');
    for (const removed of ['keep only one item in_progress', 'todoId', 'Use dependsOn', 'executor main or agent']) expect(context[0]!.content).not.toContain(removed);
    expect(properties).not.toHaveProperty('todoId');
    await expect(app.coordinator.tools.execute(runId, 'todo.write', { expectedRevision: 0, items }, signal())).resolves.toHaveProperty('revision', 1);
    expect(specs.map(spec => spec.name)).not.toContain('agent.route');
    expect(specs.map(spec => spec.name)).not.toContain('agent.derive');
    expect(app.store.run(runId).scope).toEqual(run.scope);
  });
});
