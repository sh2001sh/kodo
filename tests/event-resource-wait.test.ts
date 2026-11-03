import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application/index.js';
import { failedStepStreak, identicalStreak } from '../src/runtime/progress-advisor.js';
import { acquireWriteLock } from '../src/tools/write-locks.js';
import { checkCompletion } from '../src/runtime/completion.js';
import { readTodoSnapshot, todoTools } from '../src/tools/todo.js';
import type { TodoItem } from '../src/tools/todo.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

function protocol(app: Application, runId: string): void {
  const session = app.store.session(app.store.run(runId).sessionId);
  app.store.putSession({ ...session, taskProtocol: 2 });
}
function child(app: Application, runId: string): string {
  return (app.coordinator.mailbox.execute(app.store.run(runId), crypto.randomUUID(), 'spawn_agent', { objective: 'Synthetic independent task', permissions: ['read'] }) as { id: string }).id;
}
function plan(app: Application, runId: string, items: TodoItem[]): void {
  const run = app.store.run(runId);
  todoTools(app.store)[1]!.execute({ run, session: app.store.session(run.sessionId), signal: new AbortController().signal, markEffectStarted() {} }, { items, expectedRevision: readTodoSnapshot(app.store, runId).revision });
}

describe('event-driven task waits', () => {
  it('records isolated admission failure on the child without rejecting the driver', async () => {
    const { app, runId } = fixture(scripted());
    protocol(app, runId);
    const isolated = app.coordinator.mailbox.execute(app.store.run(runId), 'non-git-isolated', 'spawn_agent', { objective: 'Synthetic isolated task in a non-Git fixture', permissions: ['read', 'write'], scope: { read: ['.'], write: ['.'] }, execution: 'isolated' }) as { id: string };
    await expect(app.coordinator.wake(isolated.id)).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('EXECUTION_GIT') });
    expect(app.store.calls(isolated.id)).toHaveLength(0);
    expect(app.store.events(isolated.id, { types: ['run.failed'] }).at(-1)?.data.phase).toBe('execution_admission');
    expect(app.store.run(runId).status).toBe('queued');
  });

  it('renews internal deadlines without another model request, then wakes on completion', async () => {
    let peer = '';
    const { app, runId } = fixture(scripted(async () => calls(call('wait_for_events', { run_ids: [peer] })), answer('Accepted the completed task.')));
    protocol(app, runId);
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
    protocol(app, runId);
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
    protocol(app, runId);
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

  it('does not start a dependent model until its main-owned prerequisite is accepted', async () => {
    const { app, runId } = fixture(scripted(answer('Dependent task completed.')));
    protocol(app, runId);
    const items: TodoItem[] = [{ id: 'design', content: 'Define the interface', executor: 'main', status: 'in_progress' }, { id: 'build', content: 'Implement the accepted interface', executor: 'agent', status: 'in_progress', dependsOn: ['design'] }];
    plan(app, runId, items);
    const dependent = (app.coordinator.mailbox.execute(app.store.run(runId), 'dependent', 'spawn_agent', { objective: 'Read the accepted design', permissions: ['read'], todoId: 'build' }) as { id: string }).id;
    expect((await app.coordinator.wake(dependent)).status).toBe('queued');
    expect(app.store.calls(dependent)).toHaveLength(0);
    plan(app, runId, items.map(item => item.id === 'design' ? { ...item, status: 'completed' } : item));
    expect((await app.coordinator.wake(dependent)).status).toBe('completed');
    expect(app.store.calls(dependent).filter(value => value.kind === 'model')).toHaveLength(1);
  });

  it('returns actionable dependency input instead of sleeping forever on its own unfinished work', async () => {
    const { app, runId } = fixture(scripted());
    protocol(app, runId);
    plan(app, runId, [{ id: 'design', content: 'Define the interface', executor: 'main', status: 'in_progress' }, { id: 'build', content: 'Implement the interface', executor: 'agent', status: 'in_progress', dependsOn: ['design'] }]);
    app.coordinator.mailbox.execute(app.store.run(runId), 'dependent', 'spawn_agent', { objective: 'Read the accepted design', permissions: ['read'], todoId: 'build' });
    expect((await checkCompletion(app.coordinator, app.store.run(runId), answer(), new AbortController().signal)).kind).toBe('wait');
    app.store.updateRun(runId, { status: 'waiting' });
    app.coordinator.mailbox.refresh(runId);
    expect(app.store.run(runId).status).toBe('queued');
    expect(app.store.inbox(runId).some(message => message.content.includes('dependency_blocked'))).toBe(true);
    expect(app.store.events(runId, { types: ['completion.checked'] })).toHaveLength(0);
  });

  it('keeps waiting while a prerequisite owner is still working', async () => {
    const { app, runId } = fixture(scripted());
    protocol(app, runId);
    plan(app, runId, [{ id: 'first', content: 'Implement first', executor: 'agent', status: 'in_progress' }, { id: 'next', content: 'Check first', executor: 'agent', status: 'in_progress', dependsOn: ['first'] }]);
    const first = app.coordinator.mailbox.execute(app.store.run(runId), 'first', 'spawn_agent', { objective: 'First task', permissions: ['read'], todoId: 'first' }) as { id: string };
    app.store.updateRun(first.id, { status: 'running' });
    app.coordinator.mailbox.execute(app.store.run(runId), 'next', 'spawn_agent', { objective: 'Dependent task', permissions: ['read'], todoId: 'next' });
    expect((await checkCompletion(app.coordinator, app.store.run(runId), answer(), new AbortController().signal)).kind).toBe('wait');
    app.store.updateRun(runId, { status: 'waiting' });
    app.coordinator.mailbox.refresh(runId);
    expect(app.store.run(runId).status).toBe('waiting');
    expect(app.store.inbox(runId)).toHaveLength(0);
  });
});

describe('resource queues retain one tool invocation', () => {
  it('does not spend the execution timeout while waiting for a path lock', async () => {
    const { app, runId, root } = fixture(scripted(calls(call('file.apply_patch', { path: 'result.txt', content: 'saved', expectedHash: null })), answer()), undefined, { lockDirectory: false });
    protocol(app, runId);
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
    protocol(app, runId);
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
    protocol(app, runId);
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
