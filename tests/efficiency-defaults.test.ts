import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { answer, binding, scripted, temp } from './helpers.js';

describe('frozen efficiency defaults', () => {
  it('creates sessions with the single default view and keeps it across a reopen', async () => {
    const root = temp();
    const directory = path.join(root, '.state');
    const app = new Application(directory, scripted(answer()), undefined, { instructions: { global: false } });
    const run = app.createRun({ objective: 'Inspect a bounded task.', workspace: root, binding });
    const session = app.store.session(run.sessionId);
    // No per-session profile, protocol or factor configuration is frozen any more.
    for (const field of ['toolProfile', 'taskProtocol', 'agentFactors']) expect(session).not.toHaveProperty(field);
    const names = toolSpecs(app.coordinator, run, session).map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['file.read', 'spawn_agent', 'ask_user', 'wait_for_events', 'inspect_run']));
    expect(names).not.toContain('agent.propose');
    expect(names).not.toContain('knowledge.browse');
    await app.shutdown();
    const reopened = new Application(directory, scripted(answer()));
    try {
      expect(toolSpecs(reopened.coordinator, reopened.store.run(run.id), reopened.store.session(run.sessionId)).map(tool => tool.name)).toEqual(names);
      const next = reopened.createRun({ objective: 'Another task.', workspace: root, binding });
      expect(next.card).toEqual(run.card);
      expect(next.card.members).toBeUndefined();
      expect(next.card.id).not.toMatch(/-roster/u);
    } finally { await reopened.shutdown(); }
  });

  it.each(['toolProfile', 'taskProtocol', 'agentFactors'])('refuses to execute a saved session that still carries %s', async field => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Saved before the single default.', workspace: root, binding });
      const session = app.store.session(run.sessionId);
      const legacy = { toolProfile: 'full', taskProtocol: 1, agentFactors: { E: false } }[field];
      app.store.putSession({ ...session, [field]: legacy } as typeof session);
      expect(() => app.run(run.id)).toThrow(expect.objectContaining({ code: 'SESSION_INCOMPATIBLE' }));
      expect(app.store.run(run.id).status).toBe('queued');
    } finally { await app.shutdown(); }
  });

  it('restores a saved default session without upgrading its tools or task semantics', async () => {
    const root = temp();
    const directory = path.join(root, '.state');
    const original = new Application(directory, scripted(answer()));
    const run = original.createRun({ objective: 'Continue an old task.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
    const tools = JSON.stringify(toolSpecs(original.coordinator, run, original.store.session(run.sessionId)));
    await original.shutdown();
    const restored = new Application(directory, scripted(answer()));
    try {
      const saved = restored.store.session(run.sessionId);
      expect(JSON.stringify(toolSpecs(restored.coordinator, restored.store.run(run.id), saved))).toBe(tools);
      // 1d: todo is a plain checklist, so several items may be in_progress.
      await expect(restored.coordinator.tools.execute(run.id, 'todo.write', { expectedRevision: 0, items: [
        { id: 'a', content: 'First task', status: 'in_progress' },
        { id: 'b', content: 'Second task', status: 'in_progress' },
      ] }, new AbortController().signal)).resolves.toHaveProperty('revision', 1);
      for (const field of ['toolProfile', 'taskProtocol', 'agentFactors']) expect(restored.store.session(run.sessionId)).not.toHaveProperty(field);
    } finally { await restored.shutdown(); }
  });
});
