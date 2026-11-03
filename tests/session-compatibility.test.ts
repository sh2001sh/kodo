import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { storageTestConnection } from '../src/storage/test-access.js';
import type { Run } from '../src/runtime/types.js';
import { answer, binding, scripted, temp } from './helpers.js';

function caught(action: () => unknown): unknown {
  try { void action(); return undefined; } catch (error) { return error; }
}
/** Recreate the tables only the deleted roster/draft/derived subsystem wrote. */
function seedLegacyTable(app: Application, table: 'roster_snapshots' | 'derived_agents' | 'agent_drafts', sessionId: string): void {
  const db = storageTestConnection(app.store);
  if (table === 'roster_snapshots') {
    db.exec('CREATE TABLE IF NOT EXISTS roster_snapshots(session_id TEXT PRIMARY KEY, digest TEXT NOT NULL, data TEXT NOT NULL)');
    db.prepare('INSERT INTO roster_snapshots VALUES (?,?,?)').run(sessionId, 'f'.repeat(64), JSON.stringify({ sessionId, members: [] }));
  } else if (table === 'derived_agents') {
    db.exec('CREATE TABLE IF NOT EXISTS derived_agents(session_id TEXT NOT NULL, handle TEXT NOT NULL, digest TEXT NOT NULL, created_by_run TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,handle))');
    db.prepare('INSERT INTO derived_agents VALUES (?,?,?,?,?)').run(sessionId, 'tmp:handle', 'a'.repeat(64), 'legacy-run', '{}');
  } else {
    db.exec('CREATE TABLE IF NOT EXISTS agent_drafts(draft_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_run TEXT NOT NULL, owner_id TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)');
    db.prepare('INSERT INTO agent_drafts VALUES (?,?,?,?,?,?,?)').run('draft-1', sessionId, 'legacy-run', 'owner', 'b'.repeat(64), 'draft', '{}');
  }
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

  it('treats the legacy task graph size budget as an incompatible marker too', () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Old graph-sized task.', workspace: root, binding });
      const session = app.store.session(run.sessionId);
      app.store.putSession({ ...session, maxTaskNodes: 16 } as typeof session);
      expect(caught(() => app.run(run.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
    } finally { app.close(); }
  });

  it('refuses to execute a session whose runs carry legacy execution state', () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Legacy checkout task.', workspace: root, binding });
      app.store.putRun({ ...run, execution: { kind: 'clone', root: `${root}/.kodo-executions/x/y`, sourceRoot: root, baseCommit: 'a'.repeat(40) } } as unknown as typeof run);
      expect(caught(() => app.run(run.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(caught(() => app.spawnAgent(run.sessionId, { objective: 'Child of the old checkout' }))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(app.sessions().items.map(item => item.id)).toContain(run.sessionId);
      expect(app.snapshot(run.id).runs[0]!.id).toBe(run.id);
    } finally { app.close(); }
  });

  it('treats a legacy execution event as an incompatible marker', () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Old prepared checkout.', workspace: root, binding });
      app.store.event(run.id, 'execution.prepared', { synthetic: true });
      expect(caught(() => app.run(run.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(caught(() => app.submitInput(run.id, 'Continue the old checkout'))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
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

describe('deleted inline-method stage data', () => {
  const markers: [string, (app: Application, run: Run) => void][] = [
    ...(['inlineMethods', 'methodUnloading', 'methodTools', 'methodSkills', 'methodToolView', 'methodCards'] as const).map((field): [string, (app: Application, run: Run) => void] => [`session.${field}`, (app, run) => {
      const session = app.store.session(run.sessionId);
      app.store.putSession({ ...session, [field]: field === 'methodToolView' ? 'stable' : field === 'methodCards' || field === 'methodTools' || field === 'methodSkills' ? [] : false } as typeof session);
    }]),
    ...['method.loaded', 'method.ended', 'context.methods.unloaded'].map((type): [string, (app: Application, run: Run) => void] => [`event ${type}`, (app, run) => { app.store.event(run.id, type, { synthetic: true }); }]),
    ['run.taskNode', (app, run) => { app.store.putRun({ ...run, taskNode: { ownerId: run.id, id: 'stage' } } as unknown as Run); }],
  ];
  it.each(markers)('gates a session carrying %s while read-only evidence stays available', async (_marker, seed) => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Old inline-method task.', workspace: root, binding });
      seed(app, run);
      for (const action of [() => app.run(run.id), () => app.recover(run.id), () => app.spawnAgent(run.sessionId, { objective: 'Child of a method session' }), () => app.submitInput(run.id, 'Continue the method session')]) {
        expect(caught(action)).toMatchObject({ code: 'SESSION_INCOMPATIBLE', message: expect.stringContaining('inline-method stages') });
      }
      expect(app.sessions().items.map(item => item.id)).toContain(run.sessionId);
      expect(app.snapshot(run.id).runs[0]!.id).toBe(run.id);
      const fresh = app.createRun({ objective: 'New task after the incompatible one.', workspace: root, binding });
      expect((await app.run(fresh.id)).status).toBe('completed');
    } finally { await app.shutdown(); }
  });

  it('never writes method policy into a new session', () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const session = app.store.session(app.createRun({ objective: 'Ordinary task.', workspace: root, binding }).sessionId);
      for (const field of ['inlineMethods', 'methodUnloading', 'methodTools', 'methodSkills', 'methodToolView', 'methodCards']) expect(session).not.toHaveProperty(field);
    } finally { app.close(); }
  });
});

describe('deleted roster, draft and derived-agent session data', () => {
  it.each(['roster_snapshots', 'derived_agents', 'agent_drafts'] as const)('gates a session whose old data directory still has %s rows', async table => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Old roster-era task.', workspace: root, binding });
      seedLegacyTable(app, table, run.sessionId);
      expect(caught(() => app.run(run.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(caught(() => app.spawnAgent(run.sessionId, { objective: 'Child of a roster session' }))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(caught(() => app.submitInput(run.id, 'Continue the roster session'))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      // Read-only evidence and maintenance stay available: no table migration or DROP happens.
      expect(app.sessions().items.map(item => item.id)).toContain(run.sessionId);
      expect(app.snapshot(run.id).runs[0]!.id).toBe(run.id);
      expect(app.store.gc({})).toMatchObject({ removedSessions: 0 });
      const fresh = app.createRun({ objective: 'New task after the incompatible one.', workspace: root, binding });
      expect((await app.run(fresh.id)).status).toBe('completed');
    } finally { await app.shutdown(); }
  });

  it('gates a run whose persisted card still carries the roster-era identity or member references', () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const rosterRun = app.createRun({ objective: 'Old roster card task.', workspace: root, binding });
      app.store.putRun({ ...rosterRun, card: { ...rosterRun.card, id: `${rosterRun.card.id}-roster-${'a'.repeat(12)}` } });
      expect(caught(() => app.run(rosterRun.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      const memberRun = app.createRun({ objective: 'Old member-reference task.', workspace: root, binding });
      app.store.putRun({ ...memberRun, card: { ...memberRun.card, members: [{ id: 'kodo/explorer', version: '1.0.0', digest: 'c'.repeat(64) }] } });
      expect(caught(() => app.run(memberRun.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      // Old registered cards still read back without crashing; they are just never selected.
      const legacy = { ...memberRun.card, id: 'legacy/registered', version: '1.0.0' };
      app.store.registerCard(legacy);
      expect(app.store.card('legacy/registered', '1.0.0').id).toBe('legacy/registered');
    } finally { app.close(); }
  });
});
