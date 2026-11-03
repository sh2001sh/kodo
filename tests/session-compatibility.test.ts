import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { answer, binding, scripted, temp } from './helpers.js';

function caught(action: () => unknown): unknown {
  try { void action(); return undefined; } catch (error) { return error; }
}

describe('legacy lean-team session compatibility', () => {
  it('keeps legacy sessions readable but refuses to execute them at every execution entry', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer('new task completed')), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Legacy evidence task.', workspace: root, binding });
      const session = app.store.session(run.sessionId);
      app.store.putSession({ ...session, toolProfile: 'lean-team' } as unknown as typeof session);

      expect(caught(() => app.run(run.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(caught(() => app.recover(run.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(caught(() => app.spawnAgent(run.sessionId, { objective: 'Child of an old graph run' }))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(caught(() => app.submitInput(run.id, 'Continue the old task'))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });

      // Read-only evidence stays available: listing, snapshots and raw records do not execute the session.
      expect(app.sessions().items.map(item => item.id)).toContain(run.sessionId);
      expect(app.snapshot(run.id).session.toolProfile as string).toBe('lean-team');
      expect(app.store.session(run.sessionId).toolProfile as string).toBe('lean-team');

      // A new session in the same application is unaffected.
      const fresh = app.createRun({ objective: 'New task after the incompatible one.', workspace: root, binding });
      expect((await app.run(fresh.id)).status).toBe('completed');
    } finally { await app.shutdown(); }
  });

  it('treats the legacy task-graph size budget as an incompatible marker too', () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Old graph-sized task.', workspace: root, binding });
      const session = app.store.session(run.sessionId);
      app.store.putSession({ ...session, maxTaskNodes: 16 } as typeof session);
      expect(caught(() => app.run(run.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
    } finally { app.close(); }
  });

  it('does not gate ordinary sessions', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer('ordinary')), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Ordinary compact task.', workspace: root, binding });
      expect((await app.run(run.id)).status).toBe('completed');
    } finally { await app.shutdown(); }
  });
});
