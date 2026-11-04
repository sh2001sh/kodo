import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { answer, binding, scripted, temp } from './helpers.js';

/**
 * Serialized default tool catalog (the former compact-v2 view); a changed budget must be an explicit, reviewed decision.
 * 1d: re-measured after removing followup_task, send_message and interrupt_agent (was 15_135).
 */
const DEFAULT_TOOL_SPEC_BYTES = 11_829;
const DEFAULT_TOOL_NAMES = [
  'file.read', 'file.list', 'file.search', 'artifact.read', 'history.read', 'recovery.inspect', 'todo.read', 'todo.write',
  'spawn_agent', 'inspect_run', 'wait_for_events', 'ask_user', 'cancel_agent',
];

describe('default configuration invariants', () => {
  it('keeps the removed scheduler tools out of the default session surface', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Inspect a bounded task.', workspace: root, binding });
      const session = app.store.session(run.sessionId);
      // The single default configuration no longer freezes a per-session profile, protocol or factors.
      for (const field of ['toolProfile', 'taskProtocol', 'agentFactors']) expect(session).not.toHaveProperty(field);
      const specs = toolSpecs(app.coordinator, run, session);
      const names = specs.map(spec => spec.name);
      for (const removed of ['delegate', 'task', 'find_agents', 'followup_task', 'send_message', 'interrupt_agent', 'explore', 'list_agents', 'update_progress']) expect(names).not.toContain(removed);
      expect(names).toEqual(expect.arrayContaining(['file.read', 'spawn_agent', 'ask_user', 'wait_for_events', 'inspect_run']));
      expect(app.coordinator.mailbox.specs(run).map(spec => spec.name)).not.toContain('delegate');
      // Stable request catalog sentinel: the deletion must not alter default prompt or tool bytes.
      expect(Buffer.byteLength(JSON.stringify(specs), 'utf8')).toBe(DEFAULT_TOOL_SPEC_BYTES);
      expect(names).toEqual(DEFAULT_TOOL_NAMES);
    } finally { await app.shutdown(); }
  });

});
