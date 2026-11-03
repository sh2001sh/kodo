import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { answer, binding, scripted, temp } from './helpers.js';

describe('frozen efficiency defaults', () => {
  it('creates compact parallel sessions while keeping explicit legacy sessions restorable', async () => {
    const root = temp();
    const directory = path.join(root, '.state');
    const app = new Application(directory, scripted(answer()), undefined, { instructions: { global: false } });
    const run = app.createRun({ objective: 'Inspect a bounded task.', workspace: root, binding });
    const session = app.store.session(run.sessionId);
    expect(session).toMatchObject({ taskProtocol: 3, toolProfile: 'compact-v2', agentFactors: { D: true, E: true } });
    const names = toolSpecs(app.coordinator, run, session).map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['file.read', 'spawn_agent', 'ask_user', 'wait_for_events', 'inspect_run']));
    expect(names).not.toContain('agent.propose');
    expect(names).not.toContain('knowledge.browse');
    await app.shutdown();
    const reopened = new Application(directory, scripted(answer()), undefined, { taskProtocol: 1, toolProfile: 'full' });
    try {
      expect(reopened.store.session(run.sessionId)).toMatchObject({ taskProtocol: 3, toolProfile: 'compact-v2' });
      expect(toolSpecs(reopened.coordinator, reopened.store.run(run.id), reopened.store.session(run.sessionId)).map(tool => tool.name)).toEqual(names);
      const legacy = reopened.createRun({ objective: 'Legacy workflow.', workspace: root, binding });
      expect(reopened.store.session(legacy.sessionId)).toMatchObject({ taskProtocol: 1, toolProfile: 'full' });
      expect(legacy.card.members?.some(member => member.version === '1.1.0')).toBe(true);
    } finally { await reopened.shutdown(); }
  });

  it('rejects invalid host profile and protocol values before creating runtime state', () => {
    const directory = path.join(temp(), '.state');
    expect(() => new Application(directory, scripted(), undefined, { toolProfile: 'invalid' as 'full' })).toThrow('toolProfile');
    expect(() => new Application(directory, scripted(), undefined, { taskProtocol: 4 as 3 })).toThrow('taskProtocol');
  });

  it('restores a session with neither persisted version field without upgrading its tools or task semantics', async () => {
    const root = temp();
    const directory = path.join(root, '.state');
    const original = new Application(directory, scripted(answer()), undefined, { taskProtocol: 1, toolProfile: 'full', agentFactors: { E: false } });
    const run = original.createRun({ objective: 'Continue an old task.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
    const legacy = original.store.session(run.sessionId);
    delete legacy.taskProtocol;
    delete legacy.toolProfile;
    original.store.putSession(legacy);
    const tools = JSON.stringify(toolSpecs(original.coordinator, run, legacy));
    await original.shutdown();
    const restored = new Application(directory, scripted(answer()));
    try {
      const saved = restored.store.session(run.sessionId);
      expect(saved.taskProtocol).toBeUndefined();
      expect(saved.toolProfile).toBeUndefined();
      expect(JSON.stringify(toolSpecs(restored.coordinator, restored.store.run(run.id), saved))).toBe(tools);
      await expect(restored.coordinator.tools.execute(run.id, 'todo.write', { expectedRevision: 0, items: [
        { id: 'a', content: 'First task', executor: 'main', status: 'in_progress' },
        { id: 'b', content: 'Second task', executor: 'main', status: 'in_progress' },
      ] }, new AbortController().signal)).rejects.toThrow('only one task');
    } finally { await restored.shutdown(); }
  });
});
