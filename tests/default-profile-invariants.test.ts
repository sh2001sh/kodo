import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { answer, binding, scripted, temp } from './helpers.js';

/**
 * Serialized default compact-v2 tool catalog; a changed budget must be an explicit, reviewed decision.
 * 1d: re-measured after removing followup_task, send_message and interrupt_agent (was 15_135).
 */
const COMPACT_V2_TOOL_SPEC_BYTES = 11_829;
const COMPACT_V2_TOOL_NAMES = [
  'file.read', 'file.list', 'file.search', 'artifact.read', 'history.read', 'recovery.inspect', 'todo.read', 'todo.write',
  'spawn_agent', 'inspect_run', 'wait_for_events', 'ask_user', 'cancel_agent',
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
      for (const removed of ['delegate', 'task', 'find_agents', 'followup_task', 'send_message', 'interrupt_agent', 'explore', 'list_agents', 'update_progress']) expect(names).not.toContain(removed);
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
