import { describe, expect, it } from 'vitest';
import type { Provider } from '../src/runtime/types.js';
import { answer, call, calls, fixture } from './helpers.js';

describe('ordinary agent control and context handoff', () => {
  it('interrupts through the model tool and resumes the same child after a new message', async () => {
    let childId = '';
    let childRequests = 0;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const provider: Provider = { async complete(request, signal) {
      const identity = /Run ID: ([^. ]+)\./u.exec(request.messages.find(message => message.role === 'system')?.content ?? '')?.[1];
      expect(identity).toBeTruthy();
      const run = app.store.run(identity!);
      if (run.parentId) {
        childRequests++;
        if (childRequests === 1) return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          entered();
        });
        expect(run.id).toBe(childId);
        expect(JSON.stringify(request.messages)).toContain('Continue with the second part.');
        return answer('The second part is complete.');
      }
      if (run.step === 0) {
        expect(request.tools.some(tool => tool.name === 'interrupt_agent')).toBe(true);
        return calls(call('interrupt_agent', { run_id: childId }, 'interrupt-child'));
      }
      if (run.step === 1) {
        await app.coordinator.waitForStop(childId);
        expect(app.store.run(childId)).toMatchObject({ status: 'interrupted', interruptRequested: true, cancelRequested: false });
        return calls(call('send_message', { to: childId, kind: 'notice', content: 'Continue with the second part.' }, 'resume-child'));
      }
      if (run.step === 2) return calls(call('wait_for_events', { run_ids: [childId], mode: 'all' }, 'join-child'));
      expect(app.store.run(childId).status).toBe('completed');
      return answer('The interrupted child resumed and completed.');
    } };
    const { app, runId } = fixture(provider, ['read']);
    const parent = app.store.run(runId);
    const args = app.coordinator.mailbox.validate(parent, 'spawn_agent', JSON.stringify({ objective: 'Complete a resumable reading task.' }));
    childId = (app.store.transaction(() => app.coordinator.mailbox.execute(parent, 'spawn-child', 'spawn_agent', args)) as { id: string }).id;
    const execution = app.coordinator.wake(childId);
    try {
      await started;
      const completed = await app.run(runId);
      expect(completed.status, completed.error).toBe('completed');
      expect(app.store.calls(runId).find(item => item.name === 'interrupt_agent')).toMatchObject({ status: 'succeeded' });
      expect(app.store.run(childId)).toMatchObject({ id: childId, parentId: runId, status: 'completed', cancelRequested: false, interruptRequested: false });
      expect(childRequests).toBe(2);
      expect(app.store.listRuns(parent.sessionId).filter(run => run.parentId)).toHaveLength(1);
      expect(app.store.countEvents(childId, { types: ['run.interrupt_requested'] })).toBe(1);
      expect(app.store.countEvents(childId, { types: ['run.cancel_requested'] })).toBe(0);
    } finally {
      await app.shutdown();
      await execution;
    }
  });

  it('records a durable CONTEXT_LIMIT handoff when required input exceeds the host budget', async () => {
    let providerCalls = 0;
    const { app, runId } = fixture({ async complete() { providerCalls++; return answer(); } });
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxContextChars: 512 } });
    const stopped = await app.run(runId);
    expect(stopped.status).toBe('failed');
    expect(stopped.error).toContain('CONTEXT_LIMIT');
    expect(providerCalls).toBe(0);
    const handoff = app.store.latestEvent(runId, { types: ['run.handoff'] });
    expect(handoff?.data).toMatchObject({ code: 'CONTEXT_LIMIT', reportRef: expect.any(String) });
    const report = app.store.readBlob<{ text: string }>(handoff!.data.reportRef as string);
    expect(report.text).toContain('Runtime handoff report: CONTEXT_LIMIT');
    expect(report.text).toContain(run.objective);
    expect(app.store.countEvents(runId, { types: ['run.handoff'] })).toBe(1);
  });
});
