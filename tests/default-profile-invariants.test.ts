import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { answer, binding, scripted, temp } from './helpers.js';

/** Serialized default compact-v2 tool catalog; a changed budget must be an explicit, reviewed decision. */
const COMPACT_V2_TOOL_SPEC_BYTES = 17_278;
const COMPACT_V2_TOOL_NAMES = [
  'file.read', 'file.list', 'file.search', 'artifact.read', 'history.read', 'recovery.inspect', 'todo.read', 'todo.write',
  'spawn_agent', 'followup_task', 'inspect_run', 'send_message', 'wait_for_events', 'ask_user', 'interrupt_agent', 'cancel_agent',
];

describe('default compact-v2 profile invariants', () => {
  it('keeps the removed scheduler tools out of the default session surface', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Inspect a bounded task.', workspace: root, binding });
      const session = app.store.session(run.sessionId);
      expect(session).toMatchObject({ taskProtocol: 3, toolProfile: 'compact-v2' });
      const specs = toolSpecs(app.coordinator, run, session);
      const names = specs.map(spec => spec.name);
      for (const removed of ['delegate', 'task', 'find_agents']) expect(names).not.toContain(removed);
      expect(names).toEqual(expect.arrayContaining(['file.read', 'spawn_agent', 'ask_user', 'wait_for_events', 'inspect_run']));
      expect(app.coordinator.mailbox.specs(run).map(spec => spec.name)).not.toContain('delegate');
      // Stable request catalog sentinel: the deletion must not alter default prompt or tool bytes.
      expect(Buffer.byteLength(JSON.stringify(specs), 'utf8')).toBe(COMPACT_V2_TOOL_SPEC_BYTES);
      expect(names).toEqual(COMPACT_V2_TOOL_NAMES);
    } finally { await app.shutdown(); }
  });

  it('rejects the removed lean-team profile from host configuration', () => {
    const directory = path.join(temp(), '.state');
    expect(() => new Application(directory, scripted(), undefined, { toolProfile: 'lean-team' as 'full' })).toThrow('toolProfile must be compact-v1, compact-v2, full or lean-solo');
  });
});
