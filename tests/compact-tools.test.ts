import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import type { ApplicationOptions } from '../src/application/index.js';
import { parseCard, serializeCard, simpleDefaultCard } from '../src/agents/card.js';
import { initialContext } from '../src/runtime/context.js';
import { roleAllows } from '../src/runtime/role-view.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import type { Message, Run } from '../src/runtime/types.js';
import { answer, binding, fixture, fullToolCard, scripted, temp } from './helpers.js';

const signal = () => new AbortController().signal;
function defaultApp(options: ApplicationOptions = {}): { app: Application; root: string } {
  const root = temp();
  const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false }, ...options });
  return { app, root };
}

describe('default stable tool view', () => {
  it('reduces default schemas while keeping CRUD, collaboration, artifacts and recovery usable', async () => {
    const { app, root } = defaultApp();
    try {
      const run = app.createRun({ objective: 'Inspect the project and provide evidence.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
      const full = app.createRun({ objective: 'Inspect the project and provide evidence.', workspace: root, binding, permissions: ['read', 'write', 'exec'], card: fullToolCard });
      const view = (item: Run) => toolSpecs(app.coordinator, app.store.run(item.id), app.store.session(item.sessionId));
      const before = view(run);
      const names = before.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        'shell.exec', 'process.read', 'file.read', 'file.search', 'file.apply_patch', 'file.patch',
        'artifact.read', 'history.read', 'recovery.inspect', 'todo.read', 'todo.write',
        'spawn_agent', 'wait_for_events', 'inspect_run', 'ask_user', 'cancel_agent',
      ]));
      // With exec, commands replace redundant native CRUD; update_progress, history.search and
      // artifact.write stay hidden in the default view; the 1d collaboration removals are absent everywhere.
      for (const name of ['file.list', 'file.mkdir', 'file.rename', 'file.delete', 'artifact.write', 'history.search', 'agent.search', 'agent.directory', 'agent.route', 'agent.derive', 'agent.propose', 'agent.retain', 'knowledge.browse', 'knowledge.search', 'knowledge.read', 'explore', 'exploration.plan', 'update_progress', 'list_agents', 'followup_task', 'send_message', 'interrupt_agent', 'report.submit']) expect(names).not.toContain(name);
      expect(names.length).toBeLessThan(view(full).length);
      // Re-measured in 1e against the full-tool test card: 15610 vs 21459 bytes.
      expect(Buffer.byteLength(JSON.stringify(before))).toBeLessThan(Buffer.byteLength(JSON.stringify(view(full))) * 0.9);

      await app.coordinator.tools.execute(run.id, 'todo.write', { expectedRevision: 0, items: [{ id: 'independent', content: 'Independent work', status: 'in_progress' }] }, signal());
      expect(view(run)).toEqual(before);
      // A card that declares artifact.write keeps the shared artifact workflow.
      const artifact = await app.coordinator.tools.execute(full.id, 'artifact.write', { name: 'shared-contract', content: 'A single immutable behavior source.' }, signal()) as { id: string };
      expect(await app.coordinator.tools.execute(full.id, 'artifact.read', { id: artifact.id }, signal())).toHaveProperty('content');
    } finally { await app.shutdown(); }
  });

  it('retains explicitly configured memory and web workflows with the default view', async () => {
    const { app, root } = defaultApp({ memory: true, webFetch: { enabled: true, allowedHosts: ['example.org'] } });
    try {
      const run = app.createRun({ objective: 'Inspect the explicitly enabled workflow.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
      const session = app.store.session(run.sessionId);
      const names = toolSpecs(app.coordinator, run, session).map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['memory.write', 'web.fetch']));
      // 1d removed the exploration workflows; update_progress stays hidden in the default view.
      for (const name of ['explore', 'exploration.plan', 'update_progress']) expect(names).not.toContain(name);
      expect((await app.run(run.id)).status).toBe('completed');
      expect(app.store.listRuns(session.id)).toHaveLength(1);
    } finally { await app.shutdown(); }
  });

  it('keeps explicit specialist and custom card tools instead of applying the default catalog filter', () => {
    const card = parseCard(serializeCard({ ...fullToolCard, id: 'builtin/general-custom' }), { toolNames: fullToolCard.tools });
    const session: Pick<Run, 'permissions'> = { permissions: ['read', 'write', 'exec'] };
    for (const name of ['agent.route', 'knowledge.search', 'web.fetch', 'lsp.references', 'update_progress', 'shell.exec', 'file.delete', 'artifact.write']) {
      expect(roleAllows({ card }, session, name)).toBe(true);
    }
    const configuredDefault = { card: { ...simpleDefaultCard, id: 'builtin/general-simple-web-lsp' } };
    expect(roleAllows(configuredDefault, session, 'web.fetch')).toBe(true);
    expect(roleAllows(configuredDefault, session, 'lsp.hover')).toBe(true);
    expect(roleAllows(configuredDefault, session, 'update_progress')).toBe(false);
    expect(roleAllows(configuredDefault, session, 'file.delete')).toBe(false);
    // Without exec, native file management remains the complete write path.
    expect(roleAllows(configuredDefault, { permissions: ['read', 'write'] }, 'file.delete')).toBe(true);
  });

  it('creates a default worker that inherits the parent card and keeps managed execution', async () => {
    const { app, root } = defaultApp();
    try {
      const parent = app.createRun({ objective: 'Inspect the project and provide evidence.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
      const child = app.spawnAgent(parent.sessionId, { objective: 'Check the assigned module.', scope: { read: ['.'], write: ['result.txt'] } });
      expect(child.card.digest).toBe(parent.card.digest);
      expect(child.card.id).toBe(parent.card.id);
      expect(child.permissions).toEqual(app.store.session(parent.sessionId).permissions);
      const names = toolSpecs(app.coordinator, child, app.store.session(child.sessionId)).map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['shell.exec', 'process.read', 'artifact.read', 'history.read', 'recovery.inspect', 'inspect_run', 'wait_for_events']));
      expect(names).not.toContain('process.exec');
      expect(names).not.toContain('workspace.commit');
      expect(names).not.toContain('workspace.integrate');
      const result = await app.coordinator.tools.execute(child.id, 'shell.exec', { command: 'printf default-worker', background: true }, signal()) as { background: { id: string } };
      let observed: unknown;
      let stdoutOffset = 0, stderrOffset = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        observed = await app.coordinator.tools.execute(child.id, 'process.read', { id: result.background.id, stdoutOffset, stderrOffset, waitMs: 1000 }, signal());
        if ((observed as { state: string }).state !== 'running') break;
        ({ stdoutOffset, stderrOffset } = observed as { stdoutOffset: number; stderrOffset: number });
      }
      expect(observed).toMatchObject({ state: 'exited', exitCode: 0 });
    } finally { await app.shutdown(); }
  });

  it('assembles coordination rules independently of method wording', () => {
    const changedMethod = { ...simpleDefaultCard, prompt: 'You are the main agent. Own delivery and acceptance. Custom method wording.' };
    const current = initialContext('/workspace', ['read'], changedMethod, 'Find an entry.', { id: 'lead' });
    expect(current[0]!.content).toContain('keep a concise todo list; it guides the work and proves nothing');
    expect(current[0]!.content).not.toContain('todoId');
    expect(current[0]!.content).not.toContain('Start each request with a brief plan');
    expect(current[0]!.content).not.toContain('an active agent todo blocks');
    expect(current[0]!.content).not.toContain('Custom method wording');
    expect(current[1]!.content).toBe(`Agent method configuration (subordinate to host rules and user task):\n${changedMethod.prompt}`);
  });

  it('keeps task semantics independent of the card tool set', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write']);
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
    // 1d: todo is a plain checklist; several items may be in_progress.
    expect(context[0]!.content).toContain('keep a concise todo list; it guides the work and proves nothing');
    for (const removed of ['keep only one item in_progress', 'todoId', 'Use dependsOn', 'executor main or agent']) expect(context[0]!.content).not.toContain(removed);
    expect(properties).not.toHaveProperty('todoId');
    await expect(app.coordinator.tools.execute(runId, 'todo.write', { expectedRevision: 0, items }, signal())).resolves.toHaveProperty('revision', 1);
    expect(specs.map(spec => spec.name)).not.toContain('agent.route');
    expect(specs.map(spec => spec.name)).not.toContain('agent.derive');
    expect(app.store.run(runId).scope).toEqual(run.scope);
  });
});
