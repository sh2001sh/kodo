import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application/index.js';
import { failedStepStreak, identicalStreak } from '../src/runtime/progress-advisor.js';
import { acquireWriteLock } from '../src/tools/write-locks.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

function child(app: Application, runId: string): string {
  return (app.coordinator.mailbox.execute(app.store.run(runId), crypto.randomUUID(), 'spawn_agent', { objective: 'Synthetic independent task', permissions: ['read'] }) as { id: string }).id;
}

describe('event-driven task waits', () => {
  it('renews internal deadlines without another model request, then wakes on completion', async () => {
    let peer = '';
    const { app, runId } = fixture(scripted(async () => calls(call('wait_for_events', { run_ids: [peer] })), answer('Accepted the completed task.')));
    peer = child(app, runId);
    expect((await app.coordinator.wake(runId)).status).toBe('waiting');
    const wait = app.store.wait(app.store.run(runId).waitId!);
    expect(wait.eventDriven).toBe(true);
    const now = vi.spyOn(Date, 'now').mockReturnValue(wait.deadline + 1);
    try {
      expect((await app.coordinator.wake(runId)).status).toBe('waiting');
      expect(app.store.wait(wait.id)).toMatchObject({ status: 'registered', deadline: wait.deadline + 300_001 });
      expect(app.store.calls(runId).filter(value => value.kind === 'model')).toHaveLength(1);
      expect(app.store.inbox(runId)).toHaveLength(0);
    } finally { now.mockRestore(); }
    app.store.updateRun(peer, { status: 'completed' });
    expect((await app.coordinator.wake(runId)).status).toBe('completed');
    expect(app.store.calls(runId).filter(value => value.kind === 'model')).toHaveLength(2);
  });

  it('preserves explicit caller deadlines', async () => {
    let peer = '';
    const { app, runId } = fixture(scripted(async () => calls(call('wait_for_events', { run_ids: [peer], timeout_ms: 50 })), async request => {
      expect(request.messages.some(message => message.content?.includes('timeout'))).toBe(true);
      expect(app.store.waits().some(wait => wait.runId === runId && wait.reason === 'timeout')).toBe(true);
      app.store.updateRun(peer, { status: 'completed' });
      return answer();
    }));
    peer = child(app, runId);
    expect((await app.coordinator.wake(runId)).status).toBe('waiting');
    const wait = app.store.wait(app.store.run(runId).waitId!);
    expect(wait.eventDriven).toBeUndefined();
    const now = vi.spyOn(Date, 'now').mockReturnValue(wait.deadline + 1);
    try { expect((await app.coordinator.wake(runId)).status).toBe('completed'); }
    finally { now.mockRestore(); }
    expect(app.store.wait(wait.id)).toMatchObject({ status: 'settled', reason: 'timeout' });
  });

  it('keeps completion deferrals event-driven across storage restart', async () => {
    const { app, root, runId } = fixture(scripted(answer('Early completion candidate.')));
    const peer = child(app, runId);
    expect((await app.coordinator.wake(runId)).status).toBe('waiting');
    const wait = app.store.wait(app.store.run(runId).waitId!);
    expect(wait.eventDriven).toBe(true);
    await app.shutdown();
    const restored = new Application(path.join(root, '.state'), scripted(answer('Now complete.')));
    try {
      const now = vi.spyOn(Date, 'now').mockReturnValue(wait.deadline + 1);
      try { expect((await restored.coordinator.wake(runId)).status).toBe('waiting'); }
      finally { now.mockRestore(); }
      expect(restored.store.calls(runId).filter(value => value.kind === 'model')).toHaveLength(1);
      restored.store.updateRun(peer, { status: 'completed' });
      expect((await restored.coordinator.wake(runId)).status).toBe('completed');
    } finally { await restored.shutdown(); }
  });
});

describe('resource queues retain one tool invocation', () => {
  it('does not spend the execution timeout while waiting for a path lock', async () => {
    const { app, runId, root } = fixture(scripted(calls(call('file.apply_patch', { path: 'result.txt', content: 'saved', expectedHash: null })), answer()), undefined, { lockDirectory: false });
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, toolTimeoutMs: 100 } });
    const release = await acquireWriteLock(root, [], { directory: false });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const unsubscribe = app.store.subscribe(event => { if (event.runId === runId && event.type === 'tool.started') started(); });
    const running = app.coordinator.wake(runId);
    try {
      await entered;
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(app.store.calls(runId).filter(value => value.kind === 'model')).toHaveLength(1);
      expect(app.store.calls(runId).find(value => value.kind === 'tool')).toMatchObject({ status: 'running', effectState: 'not_started' });
      release();
      expect(await running).toMatchObject({ status: 'completed' });
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('saved');
      expect(app.store.calls(runId).filter(value => value.kind === 'tool')).toHaveLength(1);
      expect(app.store.events(runId, { types: ['tool.resource_ready'] })).toHaveLength(1);
    } finally { release(); unsubscribe(); await running; }
  });

  it('cancels a queued operation without creating an unknown write or releasing its owner', async () => {
    const { app, runId, root } = fixture(scripted(calls(call('file.apply_patch', { path: 'result.txt', content: 'saved', expectedHash: null }))), undefined, { lockDirectory: false });
    const release = await acquireWriteLock(root, [], { directory: false });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const unsubscribe = app.store.subscribe(event => { if (event.runId === runId && event.type === 'tool.started') started(); });
    const running = app.coordinator.wake(runId);
    try {
      await entered;
      app.coordinator.cancel(runId);
      expect((await running).status).toBe('cancelled');
      expect(app.store.unresolvedWrites(root)).toHaveLength(0);
      await expect(acquireWriteLock(root, [], { directory: false, timeoutMs: 20 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    } finally { release(); unsubscribe(); await running; }
    (await acquireWriteLock(root, [], { directory: false }))();
  });

  it('stops resource waiting at the shared run deadline before effects start', async () => {
    const { app, runId, root } = fixture(scripted(calls(call('file.apply_patch', { path: 'result.txt', content: 'saved', expectedHash: null }))), undefined, { lockDirectory: false });
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxDurationMs: 300 } });
    const release = await acquireWriteLock(root, [], { directory: false });
    try {
      const result = await app.coordinator.wake(runId);
      expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('TIME_BUDGET') });
      expect(app.store.unresolvedWrites(root)).toHaveLength(0);
      expect(app.store.calls(runId).filter(value => value.kind === 'model')).toHaveLength(1);
    } finally { release(); }
  });

  it('does not count unstarted resource contention as model errors, while real failures still count', () => {
    const { app, runId } = fixture(scripted());
    for (let step = 0; step < 6; step++) {
      const request = call('file.apply_patch', { path: 'a.txt' }, `tool-${step}`);
      const modelId = `model-${step}`;
      app.store.putCall({ id: modelId, runId, step, kind: 'model', name: 'model', status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef: app.store.blob({}), resultRef: app.store.blob(calls(request)) });
      app.store.putCall({ id: `${modelId}:${request.id}`, runId, step, kind: 'tool', name: request.name, status: 'failed', effect: 'write', effectState: 'not_started', reservedTokens: 0, requestRef: app.store.blob(request), resultRef: app.store.blob({ error: 'LOCK_TIMEOUT: synthetic queued operation', notStarted: true }) });
    }
    expect(failedStepStreak(app.store, runId)).toBe(0);
    expect(identicalStreak(app.store, runId)).toBeUndefined();
    for (const value of app.store.calls(runId).filter(value => value.kind === 'tool')) app.store.putCall({ ...value, resultRef: app.store.blob({ error: 'FILE_STALE: real tool error', notStarted: true }) });
    expect(failedStepStreak(app.store, runId)).toBe(6);
  });
});
