import { describe, expect, it } from 'vitest';
import { HostHooks } from '../src/runtime/hooks.js';
import { fixture } from './helpers.js';

describe('bounded host lifecycle hooks', () => {
  it('collects notes in registration order and records a stop veto', async () => {
    const { app, runId } = fixture();
    const hooks = new HostHooks(app.store, [
      { kind: 'run.stop', id: 'review', callback: input => ({ note: `reviewed step ${input.data.step}` }) },
      { kind: 'run.stop', id: 'acceptance', callback: () => ({ deny: 'The report still needs its test result.' }) },
    ]);
    expect(await hooks.run('run.stop', { runId, data: { step: 2 } })).toEqual({ denied: true, notes: ['reviewed step 2', 'The report still needs its test result.'] });
    expect(app.store.events(runId, { types: ['hook.finished'] }).map(event => event.data.hookId)).toEqual(['review', 'acceptance']);
  });

  it('times out an unanswered callback and ignores its late result', async () => {
    const { app, runId } = fixture();
    let finish!: (result: { note: string }) => void;
    let observedSignal: AbortSignal | undefined;
    const hooks = new HostHooks(app.store, [{ kind: 'tool.before', callback: (_input, signal) => {
      observedSignal = signal;
      return new Promise(resolve => { finish = resolve; });
    } }], { timeoutMs: 10 });
    expect(await hooks.run('tool.before', { runId })).toEqual({ denied: false, notes: [] });
    expect(observedSignal?.aborted).toBe(true);
    finish({ note: 'too late' });
    await Promise.resolve();
    expect(app.store.events(runId, { types: ['hook.timed_out'] })).toHaveLength(1);
    expect(app.store.events(runId, { types: ['hook.finished'] })).toHaveLength(0);
  });

  it('records a failed observer and still calls later observers', async () => {
    const { app, runId } = fixture();
    const hooks = new HostHooks(app.store, [
      { kind: 'session.start', callback: () => { throw new Error('observer failed'); } },
      { kind: 'session.start', callback: () => ({ note: 'Workspace ready.' }) },
    ]);
    expect(await hooks.run('session.start', { runId })).toEqual({ denied: false, notes: ['Workspace ready.'] });
    expect(app.store.events(runId, { types: ['hook.failed'] })).toHaveLength(1);
  });

  it('passes immutable snapshots and propagates host cancellation', async () => {
    const { app, runId } = fixture();
    const controller = new AbortController();
    const data = { command: { args: ['test'] } };
    const hooks = new HostHooks(app.store, [{ kind: 'tool.before', callback: input => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.data.command)).toBe(true);
      controller.abort(new Error('stop waiting'));
      return new Promise(() => {});
    } }]);
    await expect(hooks.run('tool.before', { runId, data }, controller.signal)).rejects.toThrow('stop waiting');
    expect(data).toEqual({ command: { args: ['test'] } });
  });
});
