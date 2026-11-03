import { describe, expect, it } from 'vitest';
import type { Store } from '../src/storage/index.js';
import { KodoError } from '../src/runtime/types.js';
import { readTaskGraph, requireTaskNode } from '../src/runtime/task-graph.js';
import { declareTasks } from '../src/runtime/task-declare.js';
import { finishTaskIntegration, recordTaskRunOutcome, redoTask } from '../src/runtime/task-lifecycle.js';
import { cleanRetiredCheckouts, recoverTaskDispatches, releaseTaskCheckout, scheduleTasks } from '../src/runtime/task-dispatch.js';
import { dispatchAbandonedEvent, dispatchCommittedEvent, dispatchPreparedEvent, openTaskDispatches } from '../src/runtime/task-dispatch-record.js';
import { fakeHost, reopen, taskStore } from './task-fixture.js';

const node = (store: Store, id: string) => requireTaskNode(readTaskGraph(store, 'main'), id);
const states = (store: Store) => Object.fromEntries(readTaskGraph(store, 'main').nodes.map(item => [item.id, item.state]));
const childRuns = (store: Store) => store.listRuns('session').filter(run => run.parentId === 'main');

describe('task scheduling under the active quota', () => {
  it.each(['LOCK_BUSY', 'LOCK_TIMEOUT'])('preserves one preparation and retries %s without failing the node', async code => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'a', goal: 'a' }] });
    const host = fakeHost(store);
    const ensure = host.ensureCheckout;
    host.ensureCheckout = () => { throw new KodoError(code, 'workspace is occupied'); };
    for (let i = 0; i < 3; i++) expect(await scheduleTasks(store, 'main', host)).toMatchObject({ failed: [], started: [], queued: ['a'] });
    expect(node(store, 'a')).toMatchObject({ state: 'queued', reason: expect.stringContaining('snapshot') });
    expect(openTaskDispatches(store, 'main')).toHaveLength(1);
    const reserved = openTaskDispatches(store, 'main')[0]!.runId;
    expect(host.log).toEqual([]);
    host.ensureCheckout = ensure;
    expect((await scheduleTasks(store, 'main', host)).started).toEqual([{ nodeId: 'a', runId: reserved }]);
    expect(node(store, 'a').reason).toBeUndefined();
    expect(childRuns(store)).toHaveLength(1);
  });

  it('starts three independent nodes together within quota and records todo.dispatched', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'a', goal: 'a' }, { id: 'b', goal: 'b' }, { id: 'c', goal: 'c' }] });
    const result = await scheduleTasks(store, 'main', fakeHost(store, 3));
    expect(result.started.map(item => item.nodeId)).toEqual(['a', 'b', 'c']);
    expect(states(store)).toEqual({ a: 'running', b: 'running', c: 'running' });
    expect(childRuns(store)).toHaveLength(3);
    expect(store.countEvents('main', { types: ['todo.dispatched'] })).toBe(3);
    expect(store.countEvents('main', { types: [dispatchCommittedEvent] })).toBe(3);
  });

  it('queues nodes beyond the quota and starts them as slots free up', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, goal: id })) });
    const host = fakeHost(store, 2);
    const first = await scheduleTasks(store, 'main', host);
    expect(first.started.map(item => item.nodeId)).toEqual(['a', 'b']);
    expect(first.queued).toEqual(['c', 'd', 'e']);
    expect(store.countEvents('main', { types: [dispatchPreparedEvent] })).toBe(2);
    expect((await scheduleTasks(store, 'main', host)).started).toEqual([]);
    recordTaskRunOutcome(store, 'main', 'a', node(store, 'a').runId!, { status: 'completed', finalText: 'nothing to change', integrate: false });
    expect((await scheduleTasks(store, 'main', host)).started.map(item => item.nodeId)).toEqual(['c']);
    expect(states(store)).toMatchObject({ a: 'done', b: 'running', c: 'running', d: 'queued', e: 'queued' });
    const shared = fakeHost(store, 3);
    shared.otherActive = () => 1;
    expect((await scheduleTasks(store, 'main', shared)).started).toEqual([]);
  });

  it('starts a dependent node only after its predecessor is integrated', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'core', goal: 'core' }, { id: 'tests', goal: 'tests', after: ['core'] }] });
    const integrated = new Set<string>();
    const host = fakeHost(store, 4, { integrated });
    await scheduleTasks(store, 'main', host);
    expect(states(store)).toEqual({ core: 'running', tests: 'pending' });
    const core = node(store, 'core');
    recordTaskRunOutcome(store, 'main', 'core', core.runId!, { status: 'completed', finalText: 'ok', integrate: true });
    await scheduleTasks(store, 'main', host);
    expect(states(store)).toEqual({ core: 'integrating', tests: 'pending' });
    finishTaskIntegration(store, 'main', 'core', core.generation, { status: 'integrated' });
    expect((await scheduleTasks(store, 'main', host)).started).toEqual([]);
    expect(states(store).tests).toBe('pending');
    integrated.add('core');
    const result = await scheduleTasks(store, 'main', host);
    expect(result.started.map(item => item.nodeId)).toEqual(['tests']);
    expect(node(store, 'tests').dependencies).toEqual([{ id: 'core', generation: 1 }]);
    const order = host.log.filter(entry => entry.startsWith('ensure:'));
    expect(order).toHaveLength(2);
  });
});

describe('two-transaction dispatch recovery', () => {
  it('finishes an interrupted dispatch after restart without a duplicate run', async () => {
    const { store, directory } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'mw', goal: 'middleware' }] });
    const crashing = fakeHost(store, 2);
    crashing.ensureCheckout = preparation => { crashing.checkouts.add(preparation.checkout.path); throw new Error('process killed'); };
    // Simulate the crash: the checkout is half-created and the process stops before the second transaction.
    crashing.discardCheckout = () => { throw new Error('process killed before cleanup'); };
    await expect(scheduleTasks(store, 'main', crashing)).rejects.toThrow(/process killed/);
    expect(openTaskDispatches(store, 'main')).toHaveLength(1);
    expect(childRuns(store)).toHaveLength(0);
    const reopened = reopen(store, directory);
    const host = fakeHost(reopened, 2);
    for (const checkout of crashing.checkouts) host.checkouts.add(checkout);
    const recovered = await recoverTaskDispatches(reopened, 'main', host);
    expect(recovered.started.map(item => item.nodeId)).toEqual(['mw']);
    expect(openTaskDispatches(reopened, 'main')).toHaveLength(0);
    expect(childRuns(reopened)).toHaveLength(1);
    expect(childRuns(reopened)[0]!.id).toBe(openRunId(reopened));
    expect((await scheduleTasks(reopened, 'main', host)).started).toEqual([]);
    expect(childRuns(reopened)).toHaveLength(1);
    expect(reopened.countEvents('main', { types: ['todo.dispatched'] })).toBe(1);
  });

  it('abandons an interrupted dispatch on restart when its prerequisite was redone, leaving no orphan checkout', async () => {
    const { store, directory } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'core', goal: 'core' }, { id: 'tests', goal: 'tests', after: ['core'] }] });
    await scheduleTasks(store, 'main', fakeHost(store, 4));
    const core = node(store, 'core');
    recordTaskRunOutcome(store, 'main', 'core', core.runId!, { status: 'completed', finalText: 'ok', integrate: true });
    finishTaskIntegration(store, 'main', 'core', 1, { status: 'integrated' });
    const crashing = fakeHost(store, 4);
    crashing.ensureCheckout = preparation => { crashing.checkouts.add(preparation.checkout.path); throw new Error('process killed'); };
    crashing.discardCheckout = () => { throw new Error('process killed before cleanup'); };
    await expect(scheduleTasks(store, 'main', crashing)).rejects.toThrow(/process killed/);
    const reopened = reopen(store, directory);
    redoTask(reopened, 'main', 'core');
    const host = fakeHost(reopened, 4);
    for (const checkout of crashing.checkouts) host.checkouts.add(checkout);
    const recovered = await recoverTaskDispatches(reopened, 'main', host);
    expect(recovered.abandoned.map(item => item.nodeId)).toEqual(['tests']);
    expect([...host.checkouts].some(item => item.includes('tests'))).toBe(false);
    expect(openTaskDispatches(reopened, 'main')).toHaveLength(0);
    expect(childRuns(reopened).filter(run => run.objective === 'tests')).toHaveLength(0);
  });

  it('does not create the run twice when the crash follows run creation inside the commit', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'mw', goal: 'middleware' }] });
    const host = fakeHost(store, 2);
    const start = host.startRun;
    host.startRun = (preparation, item) => { start(preparation, item); throw new Error('crash after start'); };
    await expect(scheduleTasks(store, 'main', host)).rejects.toThrow(/crash after start/);
    // The second transaction rolled back, including the run row, so recovery creates it exactly once.
    expect(childRuns(store)).toHaveLength(0);
    host.startRun = start;
    expect((await recoverTaskDispatches(store, 'main', host)).started).toHaveLength(1);
    expect(host.log.filter(entry => entry.startsWith('start:'))).toHaveLength(2);
    expect(childRuns(store)).toHaveLength(1);
  });

  it('abandons a preparation whose prerequisite generation changed and removes its checkout', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'core', goal: 'core' }, { id: 'tests', goal: 'tests', after: ['core'] }] });
    const host = fakeHost(store, 4);
    await scheduleTasks(store, 'main', host);
    const core = node(store, 'core');
    recordTaskRunOutcome(store, 'main', 'core', core.runId!, { status: 'completed', finalText: 'ok', integrate: true });
    finishTaskIntegration(store, 'main', 'core', core.generation, { status: 'integrated' });
    // Re-check at downstream dispatch: the predecessor is redone after step 1 but before commit.
    host.ensureCheckout = preparation => { host.checkouts.add(preparation.checkout.path); redoTask(store, 'main', 'core'); };
    const result = await scheduleTasks(store, 'main', host);
    expect(result.abandoned).toMatchObject([{ nodeId: 'tests', reason: 'task is pending' }]);
    expect(states(store)).toMatchObject({ core: 'pending', tests: 'pending' });
    expect([...host.checkouts].filter(item => item.includes('tests'))).toEqual([]);
    expect(store.countEvents('main', { types: [dispatchAbandonedEvent] })).toBe(1);
    expect(childRuns(store).filter(run => run.objective === 'tests')).toHaveLength(0);
  });

  it('marks the node failed and cleans up when the checkout cannot be created', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'mw', goal: 'middleware' }] });
    const host = fakeHost(store, 2, { failCheckout: new Set(['mw']) });
    const result = await scheduleTasks(store, 'main', host);
    expect(result.failed).toMatchObject([{ nodeId: 'mw', error: 'clone failed' }]);
    expect(node(store, 'mw')).toMatchObject({ state: 'failed', reason: 'checkout failed: clone failed' });
    expect(host.log.some(entry => entry.startsWith('discard:'))).toBe(true);
    expect(openTaskDispatches(store, 'main')).toHaveLength(0);
  });
});

describe('checkout retention', () => {
  it('keeps redo checkouts until the new generation settles, and release removes retained ones', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'mw', goal: 'middleware' }] });
    const host = fakeHost(store, 2);
    await scheduleTasks(store, 'main', host);
    const first = node(store, 'mw');
    recordTaskRunOutcome(store, 'main', 'mw', first.runId!, { status: 'completed', finalText: 'ok', integrate: true });
    finishTaskIntegration(store, 'main', 'mw', 1, { status: 'conflict', detail: 'mw.py changed' });
    redoTask(store, 'main', 'mw');
    expect(await cleanRetiredCheckouts(store, 'main', 'mw', host.discardCheckout)).toEqual([]);
    await scheduleTasks(store, 'main', host);
    const second = node(store, 'mw');
    expect(second.checkout!.path).not.toBe(first.checkout!.path);
    expect(host.checkouts.has(first.checkout!.path)).toBe(true);
    recordTaskRunOutcome(store, 'main', 'mw', second.runId!, { status: 'completed', finalText: 'ok', integrate: true });
    finishTaskIntegration(store, 'main', 'mw', 2, { status: 'integrated' });
    expect(await cleanRetiredCheckouts(store, 'main', 'mw', host.discardCheckout)).toEqual([first.checkout]);
    expect(host.checkouts.has(first.checkout!.path)).toBe(false);
    expect(host.checkouts.has(second.checkout!.path)).toBe(true);
    await releaseTaskCheckout(store, 'main', 'mw', host.discardCheckout);
    expect(host.checkouts.size).toBe(0);
    expect(node(store, 'mw').checkout).toBeUndefined();
  });
});

function openRunId(store: Store): string {
  return store.latestEvent('main', { types: [dispatchCommittedEvent] })!.data.runId as string;
}
