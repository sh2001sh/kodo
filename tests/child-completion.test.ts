import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { childCompletionState } from '../src/runtime/child-completion.js';
import { checkCompletion } from '../src/runtime/completion.js';
import type { Message, Run } from '../src/runtime/types.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

// Synthetic run states below exercise lifecycle accounting without workspace effects.
function spawn(app: Application, runId: string): Run {
  const child = app.coordinator.mailbox.execute(app.store.run(runId), crypto.randomUUID(), 'spawn_agent', { objective: 'Synthetic bounded child task', permissions: ['read'] }) as { id: string };
  return app.store.run(child.id);
}
const check = (app: Application, runId: string) => checkCompletion(app.coordinator, app.store.run(runId), answer('Candidate final answer.'), new AbortController().signal);
function recordedInspection(app: Application, runId: string, childId: string, args: Record<string, unknown> = {}) {
  const request = call('inspect_run', { run_id: childId, ...args }, crypto.randomUUID());
  const result = app.coordinator.mailbox.execute(app.store.run(runId), request.id, request.name, JSON.parse(request.arguments));
  app.store.putCall({ id: request.id, runId, step: 0, kind: 'tool', name: request.name, status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef: app.store.blob(request), resultRef: app.store.blob(result) });
}

describe('completion owns every directly managed child', () => {
  it.each(['queued', 'running', 'waiting'] as const)('durably waits for an unlinked %s child without exhausting correction attempts', async status => {
    const { app, runId } = fixture(scripted(), undefined, { agentFactors: { B: true } });
    const child = spawn(app, runId);
    app.store.updateRun(child.id, { status });
    for (let attempt = 0; attempt < 4; attempt++) {
      const outcome = await check(app, runId);
      expect(outcome.kind).toBe('wait');
      if (outcome.kind !== 'wait') throw new Error('expected wait');
      expect(app.store.wait(outcome.waitId)).toMatchObject({ runIds: [child.id], status: 'registered' });
      // Simulate a timed-out wait already consumed by the model; no quality failure.
      app.store.putWait({ ...app.store.wait(outcome.waitId), status: 'settled', reason: 'timeout' });
    }
    expect(app.store.events(runId, { types: ['completion.checked', 'completion.correction_requested'] })).toHaveLength(0);
    expect(app.store.run(child.id).cancelRequested).toBe(false);
    app.store.updateRun(child.id, { status: 'completed' });
    expect((await check(app, runId)).kind).toBe('complete');
  });

  it('requires an interrupted child to be recovered or cancelled, without peer messaging', async () => {
    const { app, runId } = fixture(scripted());
    const child = spawn(app, runId);
    app.store.updateRun(child.id, { status: 'interrupted', interruptRequested: true });
    expect((await check(app, runId)).kind).toBe('continue');
    const context = app.store.readBlob<Message[]>(app.store.run(runId).contextRef);
    expect(context.at(-1)?.content).toContain('CHILDREN_INCOMPLETE');
    expect(context.at(-1)?.content).toContain('host recovery');
    app.coordinator.mailbox.execute(app.store.run(runId), 'cancel-child', 'cancel_agent', { run_id: child.id });
    expect(app.store.run(child.id).status).toBe('cancelled');
    expect(childCompletionState(app.store, app.store.run(runId)).result).toMatchObject({ status: 'partial', outcomes: [{ runId: child.id, status: 'cancelled' }] });
  });
  it('waits before spending deliverable audits on files still assigned to a child', async () => {
    const { app, runId } = fixture(scripted(answer('Early candidate.')));
    app.store.updateRun(runId, { deliverables: ['not-yet-produced.txt'] });
    const child = spawn(app, runId);
    expect((await app.coordinator.wake(runId)).status).toBe('waiting');
    expect(app.store.events(runId, { types: ['delivery.audit_requested', 'delivery.incomplete', 'completion.checked'] })).toHaveLength(0);
    expect(app.store.run(child.id)).toMatchObject({ status: 'queued', cancelRequested: false });
  });

  it('does not cancel a child dispatched after acceptance and before terminal commit', async () => {
    const { app, runId } = fixture(scripted(answer('Candidate.')));
    let childId = '';
    app.store.subscribe(event => {
      if (event.runId === runId && event.type === 'completion.checked' && !childId) childId = spawn(app, runId).id;
    });
    expect((await app.coordinator.wake(runId)).status).toBe('waiting');
    expect(app.store.run(childId)).toMatchObject({ status: 'queued', cancelRequested: false });
    expect(app.store.events(runId, { types: ['completion.invalidated'] }).at(-1)?.data.reason).toContain('managed child state changed');
    expect(app.store.events(runId, { types: ['run.completed'] })).toHaveLength(0);
  });

  it('uses a real successful inspect_run tool record to acknowledge failure', async () => {
    let childId = '';
    const { app, runId } = fixture(scripted(answer('Premature final answer.'),
      async request => {
        expect(request.messages.some(message => message.content?.includes('failed children'))).toBe(true);
        return calls(call('inspect_run', { run_id: childId }));
      }, answer('The child failed; its task remains incomplete.')));
    childId = spawn(app, runId).id;
    app.store.updateRun(childId, { status: 'failed', error: 'Synthetic child failure.' });
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.calls(runId).find(record => record.name === 'inspect_run')).toMatchObject({ status: 'succeeded' });
    expect(childCompletionState(app.store, app.store.run(runId)).result).toMatchObject({ status: 'partial', outcomes: [{ acknowledged: true }] });
  });

  it('requires a failure summary rather than a batch of individual evidence calls', () => {
    const { app, runId } = fixture(scripted());
    const child = spawn(app, runId);
    const request = call('file.read', { path: 'example.txt' }, 'synthetic-read');
    app.store.putCall({ id: request.id, runId: child.id, step: 0, kind: 'tool', name: request.name, status: 'succeeded', effect: 'read', evidencePermission: 'read', reservedTokens: 0, requestRef: app.store.blob(request), resultRef: app.store.blob({ content: 'isolated synthetic evidence' }) });
    app.store.updateRun(child.id, { status: 'failed', error: 'Synthetic task failure after reading.' });
    recordedInspection(app, runId, child.id, { call_ids: [request.id] });
    expect(childCompletionState(app.store, app.store.run(runId)).feedback).toContain(child.id);
    recordedInspection(app, runId, child.id, { section: 'acceptance' });
    expect(childCompletionState(app.store, app.store.run(runId)).feedback).toBeUndefined();
  });

  it('allows explicit cancellation and preserves its incomplete outcome', async () => {
    const { app, runId } = fixture(scripted(answer('Cancelled the unneeded portion.')));
    const child = spawn(app, runId);
    app.coordinator.mailbox.execute(app.store.run(runId), 'cancel-child', 'cancel_agent', { run_id: child.id });
    const result = await app.run(runId);
    expect(result.status).toBe('completed');
    expect(app.store.readBlob(result.resultRef!)).toMatchObject({ children: { status: 'partial', outcomes: [{ runId: child.id, status: 'cancelled' }] } });
  });

  it('restores waiting and post-failure inspection evidence after storage reopens', async () => {
    const { app, root, runId } = fixture(scripted(answer('Early candidate.')));
    const failed = spawn(app, runId);
    app.store.updateRun(failed.id, { status: 'failed', error: 'Synthetic failed task.' });
    recordedInspection(app, runId, failed.id);
    const pending = spawn(app, runId);
    expect((await app.coordinator.wake(runId)).status).toBe('waiting');
    const waitId = app.store.run(runId).waitId!;
    await app.shutdown();
    const restored = new Application(path.join(root, '.state'), scripted(answer('Child completed.'), answer('The failed portion remains incomplete; the other task completed.')));
    try {
      expect(restored.store.run(runId)).toMatchObject({ status: 'waiting', waitId });
      expect(restored.store.wait(waitId)).toMatchObject({ status: 'registered', runIds: [pending.id] });
      expect(childCompletionState(restored.store, restored.store.run(runId)).feedback).toBeUndefined();
      expect((await restored.coordinator.wake(pending.id)).status).toBe('completed');
      expect((await restored.run(runId)).status).toBe('completed');
      expect(restored.store.readBlob(restored.store.run(runId).resultRef!)).toMatchObject({ children: { status: 'partial', outcomes: [{ runId: failed.id, acknowledged: true }] } });
    } finally { await restored.shutdown(); }
  });
});
