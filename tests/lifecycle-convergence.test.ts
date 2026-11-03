import { describe, expect, it, vi } from 'vitest';
import { answer, fixture } from './helpers.js';
import type { Provider } from '../src/runtime/types.js';
import { Application } from '../src/application/index.js';
import { binding, call, calls, scripted, temp } from './helpers.js';
import path from 'node:path';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('lifecycle convergence and resumable turns', () => {
  it('allows immediate store closure after the driver finishes without detached wake reads', async () => {
    const { app, runId } = fixture(scripted(answer('finished')));
    expect((await app.run(runId)).status).toBe('completed');
    app.close();
    // Flush promise continuations after closure; none may access the closed database.
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it('interrupts a child turn, retains its identity and continues on a new message without replay', async () => {
    let requests = 0;
    const provider: Provider = { async complete(_request, signal) {
      requests++;
      if (requests === 1) return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return answer('continued with the new instruction');
    } };
    const { app, runId } = fixture(provider);
    const parent = app.store.run(runId);
    app.coordinator.mailbox.execute(parent, 'spawn', 'spawn_agent', { objective: 'a resumable child' });
    const child = app.store.listRuns().find(run => run.parentId === runId)!;
    const running = app.coordinator.wake(child.id);
    await until(() => app.store.calls(child.id).some(call => call.kind === 'model' && call.status === 'running'));
    app.coordinator.interrupt(child.id);
    await app.coordinator.waitForStop(child.id);
    await running;
    expect(app.store.run(child.id)).toMatchObject({ status: 'interrupted', interruptRequested: true, cancelRequested: false, id: child.id });
    expect(app.store.run(runId).status).toBe('queued');
    app.coordinator.mailbox.execute(parent, 'resume', 'send_message', { to: child.id, kind: 'notice', content: 'Continue with the second part.' });
    expect(app.store.run(child.id).status).toBe('queued');
    expect((await app.coordinator.wake(child.id)).status).toBe('completed');
    expect(requests).toBe(2);
    expect(app.store.calls(child.id).filter(call => call.kind === 'model')).toHaveLength(2);
  });

  it('marks cancellation requested before publishing a settled terminal notification', async () => {
    const provider: Provider = { async complete(_request, signal) {
      return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 20), { once: true }));
    } };
    const { app, runId } = fixture(provider);
    const running = app.coordinator.wake(runId);
    await until(() => app.store.calls(runId).some(call => call.kind === 'model'));
    app.coordinator.cancel(runId);
    expect(app.store.run(runId).cancelRequested).toBe(true);
    expect(app.store.run(runId).status).not.toBe('cancelled');
    expect(app.store.hasEvent(runId, { types: ['run.cancelled'] })).toBe(false);
    expect((await app.coordinator.waitForStop(runId)).status).toBe('cancelled');
    await running;
    expect(app.store.calls(runId).every(call => call.status !== 'running')).toBe(true);
  });

  it('publishes a cancelled outcome at the five-second deadline if a provider ignores interruption', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { app, runId } = fixture({ async complete() { entered(); await gate; return answer('late response'); } });
    vi.useFakeTimers();
    const execution = app.coordinator.wake(runId);
    try {
      await started;
      app.coordinator.cancel(runId);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await app.coordinator.waitForStop(runId)).status).toBe('cancelled');
      const before = app.store.run(runId);
      release();
      await execution;
      expect(app.store.run(runId)).toEqual(before);
    } finally { release(); vi.useRealTimers(); await execution; }
  });

  it('defers resume until a timed-out old provider settles so its late rejection cannot fail the new turn', async () => {
    let entered!: () => void;
    let release!: () => void;
    let count = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { app, runId } = fixture({ async complete() {
      if (++count === 1) { entered(); await gate; }
      return answer('response');
    } });
    const parent = app.store.run(runId);
    app.coordinator.mailbox.execute(parent, 'spawn', 'spawn_agent', { objective: 'resume after old request' });
    const child = app.store.listRuns().find(run => run.parentId === runId)!;
    vi.useFakeTimers();
    const execution = app.coordinator.wake(child.id);
    try {
      await started;
      app.coordinator.interrupt(child.id);
      await vi.advanceTimersByTimeAsync(5000);
      await app.coordinator.waitForStop(child.id);
      app.coordinator.mailbox.execute(parent, 'resume', 'send_message', { to: child.id, kind: 'notice', content: 'Continue after the old turn exits.' });
      expect(app.store.run(child.id)).toMatchObject({ status: 'interrupted', interruptRequested: true });
      release();
      await execution;
      expect(app.store.run(child.id)).toMatchObject({ status: 'queued', interruptRequested: false });
      expect((await app.coordinator.wake(child.id)).status).toBe('completed');
      expect(count).toBe(2);
    } finally { release(); vi.useRealTimers(); await execution; }
  });

  it('waits for an interrupt:block tool to finish without aborting its admitted callback', async () => {
    const { app, root } = fixture(scripted(calls(call('host.finish', {}))));
    let entered!: () => void;
    let release!: () => void;
    let observedAbort = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    app.registerTool({ name: 'host.finish', description: 'Finish one admitted operation.', permission: 'read', effect: 'read', interrupt: 'block', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async ({ signal }) => {
      entered();
      await gate;
      observedAbort = signal.aborted;
      return { finished: true };
    } });
    const card = app.parseCard('---\nschema_version: 1\nid: test/block\nversion: 1.0.0\nname: Block\ndescription: Complete an admitted operation.\ncapabilities:\n  tools: [host.finish]\n---\nComplete the operation.');
    const run = app.createRun({ objective: 'Finish one operation.', workspace: root, binding, card });
    const execution = app.coordinator.wake(run.id);
    try {
      await started;
      app.coordinator.interrupt(run.id);
      expect(app.store.run(run.id).status).toBe('running');
      release();
      await app.coordinator.waitForStop(run.id);
      await execution;
      expect(observedAbort).toBe(false);
      expect(app.store.run(run.id).status).toBe('interrupted');
      expect(app.store.calls(run.id).find(call => call.name === 'host.finish')?.status).toBe('succeeded');
    } finally { release(); await execution; }
  });

  it('stops active execution on a storage fault without committing another state or event', async () => {
    const provider: Provider = { async complete(_request, signal) {
      return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } };
    const { app, runId } = fixture(provider);
    const running = app.coordinator.wake(runId);
    await until(() => app.store.calls(runId).some(call => call.kind === 'model'));
    const beforeEvents = app.store.events(runId);
    const beforeRun = app.store.run(runId);
    app.store.fail(new Error('simulated storage unavailable'));
    expect((await running).status).toBe('interrupted');
    expect(app.store.events(runId)).toEqual(beforeEvents);
    expect(app.store.run(runId)).toEqual(beforeRun);
  });

  it('settles an unknown write on an active run without authorizing replay or stopping its peers', () => {
    const { app, runId } = fixture();
    const requestRef = app.store.blob({ id: 'uncertain', name: 'process.exec', arguments: '{}' });
    app.store.putCall({ id: 'uncertain', runId, step: 0, kind: 'tool', name: 'process.exec', status: 'unknown', effect: 'write', effectState: 'started', requestRef, reservedTokens: 0 });
    const evidence = 'Host checked the output directory and confirmed the operation had not applied.';
    app.coordinator.recovery.resolve(runId, 'uncertain', { outcome: 'not_applied', evidence });
    expect(app.store.call('uncertain')).toMatchObject({ status: 'cancelled', effectOutcome: 'not_applied' });
    expect(app.store.run(runId).status).toBe('queued');
    expect(app.coordinator.recovery.resolve(runId, 'uncertain', { outcome: 'not_applied', evidence }).blocked).toEqual([]);
  });

  it('delivers a stop-hook refusal to the next turn and emits session start/end once', async () => {
    const workspace = temp();
    let stops = 0;
    const lifecycle: string[] = [];
    const app = new Application(path.join(workspace, '.state'), scripted(answer('first candidate'), async request => {
      expect(request.messages.some(message => message.content?.includes('Include the verified result.'))).toBe(true);
      return answer('final candidate with the verified result');
    }), undefined, { exploration: false, hooks: [
      { kind: 'session.start', callback: () => { lifecycle.push('start'); return { note: 'Work on the declared task.' }; } },
      { kind: 'run.stop', callback: () => ++stops === 1 ? { deny: 'Include the verified result.' } : undefined },
      { kind: 'session.end', callback: () => { lifecycle.push('end'); } },
    ], agentFactors: { D: false, E: false, B: false } });
    try {
      const run = app.createRun({ objective: 'Finish the task.', workspace, binding });
      expect((await app.run(run.id)).status).toBe('completed');
      expect(lifecycle).toEqual(['start', 'end']);
      expect(stops).toBe(2);
    } finally { await app.shutdown(); }
  });

  it('retains non-vetoing stop and session-end notes in the final result without another model turn', async () => {
    const workspace = temp();
    let modelCalls = 0;
    const app = new Application(path.join(workspace, '.state'), { async complete() { modelCalls++; return answer('verified delivery'); } }, undefined, { exploration: false, hooks: [
      { kind: 'run.stop', callback: () => ({ note: 'Formatting completed successfully.' }) },
      { kind: 'session.end', callback: () => ({ note: 'Temporary service stopped.' }) },
    ], agentFactors: { D: false, E: false, B: false } });
    try {
      const created = app.createRun({ objective: 'Finish the task.', workspace, binding });
      const run = await app.run(created.id);
      expect(app.store.readBlob(run.resultRef!)).toMatchObject({ text: 'verified delivery', hostNotes: [
        { kind: 'run.stop', notes: ['Formatting completed successfully.'] },
        { kind: 'session.end', notes: ['Temporary service stopped.'] },
      ] });
      expect(modelCalls).toBe(1);
      const repeated = await app.run(created.id);
      expect(repeated.resultRef).toBe(run.resultRef);
      expect(app.store.countEvents(run.id, { types: ['session.ended'] })).toBe(1);
    } finally { await app.shutdown(); }
  });

  it('includes subagent stop notes in the result referenced by its parent notification', async () => {
    const workspace = temp();
    const app = new Application(path.join(workspace, '.state'), scripted(answer('child result')), undefined, { exploration: false, hooks: [
      { kind: 'subagent.stop', callback: () => ({ note: 'Child validation completed.' }) },
    ], agentFactors: { D: false, E: false, B: false } });
    try {
      const parent = app.createRun({ objective: 'Coordinate the task.', workspace, binding });
      app.coordinator.mailbox.execute(parent, 'spawn', 'spawn_agent', { objective: 'Complete the child task.' });
      const child = app.store.listRuns(parent.sessionId).find(run => run.parentId === parent.id)!;
      const completed = await app.coordinator.wake(child.id);
      const notice = app.store.messages(parent.sessionId).find(message => message.id === `terminal:${child.id}`)!;
      const data = JSON.parse(notice.content) as { resultRef: string };
      expect(data.resultRef).toBe(completed.resultRef);
      expect(app.store.readBlob(data.resultRef)).toMatchObject({ text: 'child result', hostNotes: [
        { kind: 'subagent.stop', notes: ['Child validation completed.'] },
      ] });
      expect(app.store.countCalls(child.id, { kind: 'model' })).toBe(1);
    } finally { await app.shutdown(); }
  });
});
