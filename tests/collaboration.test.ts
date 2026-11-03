import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import type { Wait } from '../src/runtime/types.js';
import { answer, binding, scripted, temp } from './helpers.js';

function operation(app: Application, runId: string, name: string, args: Record<string, unknown>, callId = name): Record<string, unknown> {
  return app.store.transaction(() => {
    const run = app.store.run(runId);
    return app.coordinator.mailbox.execute(run, callId, name, app.coordinator.mailbox.validate(run, name, JSON.stringify(args))) as Record<string, unknown>;
  });
}
function child(app: Application, mainId: string, objective = 'child task', permissions: ('read' | 'write' | 'exec')[] = ['read']): string {
  return operation(app, mainId, 'spawn_agent', { objective, permissions }).id as string;
}
function wait(app: Application, runId: string, args: Record<string, unknown>): Wait {
  const result = operation(app, runId, 'wait_for_events', args);
  const record = app.store.wait(result.waitId as string);
  if (record.status === 'registered') app.store.updateRun(runId, { status: 'waiting' });
  return record;
}
function setup() {
  const root = temp();
  const app = new Application(path.join(root, '.state'), scripted(answer('done')), undefined, { instructions: { global: false } });
  const main = app.createRun({ objective: 'Coordination fixture.', workspace: root, binding, permissions: ['read', 'write'] });
  return { app, root, main };
}

describe('collaboration through the unified loop', () => {
  it('spawns independent children, waits for all, and reads original results through inspect_run', () => {
    const { app, main } = setup();
    try {
      const first = child(app, main.id, 'first task');
      const second = child(app, main.id, 'second task');
      expect(app.store.run(first)).toMatchObject({ parentId: main.id, card: { digest: main.card.digest } });
      const joined = wait(app, main.id, { run_ids: [first, second], mode: 'all', timeout_ms: 300_000 });
      expect(joined).toMatchObject({ status: 'registered', runIds: [first, second] });
      expect(app.store.run(main.id).status).toBe('waiting');
      for (const id of [first, second]) app.store.updateRun(id, { status: 'completed', resultRef: app.store.blob({ text: `result for ${id}` }) });
      app.coordinator.mailbox.refresh(main.id);
      expect(app.store.wait(joined.id).status).toBe('settled');
      expect(app.store.run(main.id).status).toBe('queued');
      const inspected = operation(app, main.id, 'inspect_run', { run_id: first }) as { status: string; result: { text: string } };
      expect(inspected).toMatchObject({ status: 'completed', result: { text: `result for ${first}` } });
      expect(app.coordinator.mailbox.result(app.store.run(first))).toMatchObject({ text: `result for ${first}` });
    } finally { app.close(); }
  });

  it('persists a registered wait across restart and drives it once the peer settles', async () => {
    const { app, main } = setup();
    const peer = child(app, main.id, 'restart peer');
    const joined = wait(app, main.id, { run_ids: [peer], mode: 'all', timeout_ms: 300_000 });
    const directory = app.store.directory;
    await app.shutdown();
    const restored = new Application(directory, scripted(answer('done')), undefined, { instructions: { global: false } });
    try {
      expect(restored.store.wait(joined.id)).toMatchObject({ status: 'registered' });
      expect(restored.store.run(main.id).waitId).toBe(joined.id);
      restored.store.updateRun(peer, { status: 'completed', resultRef: restored.store.blob({ text: 'restart peer result' }) });
      restored.coordinator.mailbox.refresh(main.id);
      expect(restored.store.wait(joined.id).status).toBe('settled');
      expect(restored.store.run(main.id).status).toBe('queued');
    } finally { await restored.shutdown(); }
  });

  it('limits child control capabilities and permission grants', () => {
    const { app, main } = setup();
    try {
      const peer = child(app, main.id, 'limited peer');
      const mailbox = app.coordinator.mailbox;
      const run = app.store.run(peer);
      for (const name of ['spawn_agent', 'ask_user', 'cancel_agent']) expect(() => mailbox.validate(run, name, '{}')).toThrow(/not available to a child|ROLE_DENIED/u);
      expect(() => operation(app, peer, 'spawn_agent', { objective: 'grandchild' })).toThrow(/not available to a child/u);
      expect(mailbox.specs(run).map(spec => spec.name)).toEqual(expect.arrayContaining(['inspect_run', 'wait_for_events']));
      const session = app.store.session(main.sessionId);
      app.store.putSession({ ...session, permissions: ['read'] });
      expect(() => app.spawnAgent(main.sessionId, { objective: 'escalate', permissions: ['write'] })).toThrow(/subset|PERMISSION_ESCALATION/u);
    } finally { app.close(); }
  });

  it('only lets main cancel its own managed child', () => {
    const { app, main } = setup();
    try {
      const peer = child(app, main.id, 'cancelled peer');
      const cancelled = operation(app, main.id, 'cancel_agent', { run_id: peer }) as { status: string };
      expect(app.store.run(peer)).toMatchObject({ cancelRequested: true });
      expect(cancelled).toMatchObject({ status: expect.any(String) });
      expect(() => operation(app, peer, 'cancel_agent', { run_id: main.id })).toThrow(/child|ROLE_DENIED/u);
    } finally { app.close(); }
  });

  it('rejects cross-session waits and non-main ask_user', () => {
    const { app, main, root } = setup();
    try {
      const other = app.createRun({ objective: 'other session', workspace: root, binding });
      const otherChild = child(app, other.id, 'other child');
      expect(() => operation(app, main.id, 'wait_for_events', { run_ids: [otherChild] })).toThrow('session');
      const peer = child(app, main.id, 'peer');
      expect(() => operation(app, peer, 'ask_user', { question: 'may a child ask?' })).toThrow(/not available to a child|ROLE_DENIED/u);
    } finally { app.close(); }
  });

  it('persists main-only user questions and accepts an idempotent centralized reply', () => {
    const { app, main } = setup();
    try {
      const result = operation(app, main.id, 'ask_user', { question: 'Pick a direction.' }) as { waitId: string };
      const first = app.coordinator.mailbox.userQuestions(main.sessionId);
      expect(first).toHaveLength(1);
      expect(app.store.wait(result.waitId)).toMatchObject({ status: 'registered', questionIds: [first[0]!.id] });
      operation(app, main.id, 'ask_user', { question: 'Pick a direction.' }, 'ask-again');
      expect(app.coordinator.mailbox.userQuestions(main.sessionId)).toHaveLength(1);
      app.answer(first[0]!.id, 'Use the left path.');
      app.coordinator.mailbox.refresh(main.id);
      expect(app.store.wait(result.waitId).status).toBe('settled');
      expect(app.store.answer(first[0]!.id)).toMatchObject({ content: 'Use the left path.' });
    } finally { app.close(); }
  });

  it('settles a timed-out wait with timeout evidence instead of blocking forever', async () => {
    const { app, main } = setup();
    try {
      const pending = child(app, main.id, 'never completes');
      const joined = wait(app, main.id, { run_ids: [pending], mode: 'all', timeout_ms: 1 });
      await new Promise(resolve => setTimeout(resolve, 5));
      app.coordinator.mailbox.refresh(main.id);
      expect(app.store.wait(joined.id)).toMatchObject({ status: 'settled', reason: 'timeout' });
      expect(app.store.run(main.id).status).toBe('queued');
      expect(app.store.inbox(main.id).some(message => message.content.includes('timeout'))).toBe(true);
    } finally { app.close(); }
  });

  it('detects a closed two-child wait cycle instead of hanging', () => {
    const { app, main } = setup();
    try {
      const a = child(app, main.id, 'cycle a');
      const b = child(app, main.id, 'cycle b');
      const waitA = wait(app, a, { run_ids: [b], mode: 'all', timeout_ms: 300_000 });
      wait(app, b, { run_ids: [a], mode: 'all', timeout_ms: 300_000 });
      app.coordinator.mailbox.refresh(a);
      expect(app.store.wait(waitA.id).status).toBe('settled');
      expect(app.store.events(a, { types: ['wait.deadlock'] })).toHaveLength(1);
    } finally { app.close(); }
  });

  it('settles immediately when a waited peer already ended', () => {
    const { app, main } = setup();
    try {
      const peer = child(app, main.id, 'already ended');
      app.store.updateRun(peer, { status: 'completed', resultRef: app.store.blob({ text: 'ended result' }) });
      const joined = wait(app, main.id, { run_ids: [peer], mode: 'all', timeout_ms: 300_000 });
      expect(app.store.wait(joined.id)).toMatchObject({ status: 'settled', reason: 'conditions_met' });
    } finally { app.close(); }
  });

  it('enforces session creation counts even after children have terminated', () => {
    const { app, main } = setup();
    try {
      const session = app.store.session(main.sessionId);
      app.store.putSession({ ...session, budget: { ...session.budget, maxChildren: 2 } });
      const first = child(app, main.id, 'first');
      app.store.updateRun(first, { status: 'completed' });
      child(app, main.id, 'second');
      expect(() => child(app, main.id, 'third')).toThrow(/child creation limit/u);
    } finally { app.close(); }
  });
});
