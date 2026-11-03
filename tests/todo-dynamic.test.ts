import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { readTodoSnapshot, todoTools } from '../src/tools/todo.js';
import type { TodoItem, TodoSnapshot } from '../src/tools/todo.js';
import { dynamicTodoSpec, validateDynamicTodoArgs } from '../src/tools/todo-dynamic.js';
import { refreshTodoDependencies, todoDependenciesCurrent, todoRunReady } from '../src/runtime/todo-dependencies.js';
import { toolFingerprint } from '../src/tools/registry.js';
import { binding, fixture, scripted, temp } from './helpers.js';

const options = { taskProtocol: 3 as const, toolProfile: 'full' as const, agentFactors: { A: true, B: true, C: true, D: false, E: false }, instructions: { global: false as const } };
const setup = () => fixture(scripted(), ['read', 'write'], options);
const task = (id: string, executor: 'main' | 'agent' = 'agent', dependsOn: string[] = [], status: TodoItem['status'] = 'pending'): TodoItem => ({ id, content: `Deliver ${id}`, executor, dependsOn, status });
function write(app: Application, runId: string, change: Record<string, unknown>): TodoSnapshot {
  const run = app.store.run(runId);
  const args = { expectedRevision: readTodoSnapshot(app.store, runId).revision, ...change };
  return todoTools(app.store, { cancelQueued: (id, by) => app.coordinator.cancel(id, { initiator: 'agent', by }) })[1]!.execute({ run, session: app.store.session(run.sessionId), signal: new AbortController().signal, markEffectStarted() {} }, args) as TodoSnapshot;
}
function dispatch(app: Application, runId: string, todoId: string): string {
  const parent = app.store.run(runId), mailbox = app.coordinator.mailbox;
  const args = { objective: `Investigate ${todoId}`, todoId };
  return (mailbox.execute(parent, crypto.randomUUID(), 'spawn_agent', mailbox.validate(parent, 'spawn_agent', JSON.stringify(args))) as { id: string }).id;
}
function accept(app: Application, runId: string, id: string, childId: string): void {
  expect(todoRunReady(app.store, app.store.run(childId))).toBe(true);
  app.store.updateRun(childId, { status: 'completed', step: 1 });
  write(app, runId, { updates: [{ id, status: 'completed' }] });
}

describe('dynamic task graph protocol 3', () => {
  it('exposes partial updates through real tool validation without changing legacy fingerprints', async () => {
    const { app, runId } = setup();
    const before = todoTools(app.store).map(toolFingerprint);
    await app.coordinator.tools.execute(runId, 'todo.write', { expectedRevision: 0, updates: [task('work', 'main')] }, new AbortController().signal);
    await app.coordinator.tools.execute(runId, 'todo.write', { expectedRevision: 1, updates: [{ id: 'work', status: 'completed', note: 'Checked actual result' }] }, new AbortController().signal);
    expect(readTodoSnapshot(app.store, runId)).toMatchObject({ revision: 2, generations: { work: 1 }, items: [{ status: 'completed', note: 'Checked actual result' }] });
    expect(todoTools(app.store).map(toolFingerprint)).toEqual(before);
    expect(dynamicTodoSpec('todo.write')?.parameters).toHaveProperty('properties.updates');
    expect(todoTools(app.store)[1]!.parameters).not.toHaveProperty('properties.updates');
  });

  it('updates display text on active work without changing its assignment or evidence', () => {
    const { app, runId } = setup();
    write(app, runId, { updates: [task('review')] });
    const child = dispatch(app, runId, 'review');
    app.store.updateRun(child, { status: 'running', step: 1 });
    const original = app.store.run(child).todo;
    write(app, runId, { updates: [{ id: 'review', title: 'Review API boundaries', note: 'Investigation underway', status: 'in_progress' }] });
    expect(readTodoSnapshot(app.store, runId).generations?.review).toBe(1);
    expect(app.store.run(child).todo).toEqual(original);
    expect(() => write(app, runId, { updates: [{ id: 'review', content: 'Different goal' }] })).toThrow(/unsettled runs/);
    app.store.updateRun(child, { status: 'completed' });
    const result = write(app, runId, { updates: [{ id: 'review', status: 'completed', note: 'Boundary checks passed' }] });
    expect(result.generations?.review).toBe(1);
  });

  it('treats dependency order as a set and retains the started input snapshot', () => {
    const { app, runId } = setup();
    write(app, runId, { updates: [task('a', 'main', [], 'completed'), task('b', 'main', [], 'completed'), task('c', 'agent', ['b', 'a'])] });
    const child = dispatch(app, runId, 'c');
    expect(todoRunReady(app.store, app.store.run(child))).toBe(true);
    app.store.updateRun(child, { status: 'running', step: 1 });
    const before = app.store.run(child).todo;
    const plan = write(app, runId, { updates: [{ id: 'c', dependsOn: ['a', 'b'] }] });
    expect(plan.generations?.c).toBe(1);
    expect(plan.items.find(item => item.id === 'c')?.dependsOn).toEqual(['a', 'b']);
    expect(app.store.run(child).todo).toEqual(before);
  });

  it.each([
    { updates: [{ id: 'a', dependsOn: ['a'] }] },
    { updates: [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }] },
    { updates: [{ id: 'a', dependsOn: ['missing'] }] },
    { updates: [{ id: 'a', note: 'one' }, { id: 'a', note: 'two' }] },
    { updates: [{ id: 'a', note: 'one' }], remove: ['a'] },
    { expectedRevision: 0, updates: [{ id: 'a', note: 'stale writer' }] },
  ])('rejects invalid graph changes atomically: %j', change => {
    const { app, runId } = setup();
    write(app, runId, { updates: [task('a'), task('b')] });
    const before = readTodoSnapshot(app.store, runId), events = app.store.events(runId).length;
    expect(() => write(app, runId, change)).toThrow();
    expect(readTodoSnapshot(app.store, runId)).toEqual(before);
    expect(app.store.events(runId)).toHaveLength(events);
  });

  it('splits queued work atomically with explicit cancellation and releases new successors correctly', () => {
    const { app, runId } = setup();
    write(app, runId, { updates: [task('design', 'main'), task('build', 'agent', ['design'])] });
    const old = dispatch(app, runId, 'build');
    expect(todoRunReady(app.store, app.store.run(old))).toBe(false);
    const split = { remove: ['build'], updates: [task('left', 'agent', ['design']), task('right', 'agent', ['design'])], cancelQueued: [old] };
    write(app, runId, split);
    const result = readTodoSnapshot(app.store, runId);
    expect(result.items.map(item => item.id)).toEqual(['design', 'left', 'right']);
    expect(app.store.run(old)).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(app.store.events(old, { types: ['run.cancel_requested'] })).toHaveLength(1);
    expect(app.store.events(old, { types: ['run.cancelled'] })).toHaveLength(1);
    expect(app.store.message(`terminal:${old}`)).toBeDefined();
    const left = dispatch(app, runId, 'left'), right = dispatch(app, runId, 'right');
    expect(todoRunReady(app.store, app.store.run(left))).toBe(false);
    write(app, runId, { updates: [{ id: 'design', status: 'completed' }] });
    expect(todoRunReady(app.store, app.store.run(left))).toBe(true);
    expect(todoRunReady(app.store, app.store.run(right))).toBe(true);
    expect(app.store.calls(left)).toHaveLength(0);
    expect(app.store.calls(right)).toHaveLength(0);
  });

  it('does not cancel anything when a batch also contains an invalid graph', () => {
    const { app, runId } = setup();
    write(app, runId, { updates: [task('old')] });
    const child = dispatch(app, runId, 'old'), before = readTodoSnapshot(app.store, runId);
    expect(() => write(app, runId, { remove: ['old'], updates: [task('replacement', 'agent', ['missing'])], cancelQueued: [child] })).toThrow('does not exist');
    expect(readTodoSnapshot(app.store, runId)).toEqual(before);
    expect(app.store.run(child)).toMatchObject({ status: 'queued', cancelRequested: false });
    expect(app.store.events(child, { types: ['run.cancel_requested', 'run.cancelled'] })).toHaveLength(0);
    expect(app.store.message(`terminal:${child}`)).toBeUndefined();
  });

  it('requires explicit settlement instead of leaving a queued dispatch on an obsolete generation', () => {
    const { app, runId } = setup();
    write(app, runId, { updates: [task('a'), task('b', 'main')] });
    const child = dispatch(app, runId, 'a');
    expect(() => write(app, runId, { updates: [{ id: 'a', dependsOn: ['b'] }] })).toThrow(child);
    expect(readTodoSnapshot(app.store, runId).generations?.a).toBe(1);
    app.coordinator.cancel(child, { initiator: 'agent', by: runId });
    const plan = write(app, runId, { updates: [{ id: 'a', dependsOn: ['b'] }] });
    expect(plan.generations?.a).toBe(2);
    const successor = dispatch(app, runId, 'a');
    expect(todoRunReady(app.store, app.store.run(successor))).toBe(false);
    write(app, runId, { updates: [{ id: 'b', status: 'completed' }] });
    expect(todoRunReady(app.store, app.store.run(successor))).toBe(true);
  });

  it.each(['started', 'waiting'] as const)('rejects cancelQueued when execution is %s', state => {
    const { app, runId } = setup();
    write(app, runId, { updates: [task('work')] });
    const child = dispatch(app, runId, 'work');
    if (state === 'started') app.store.updateRun(child, { step: 1 });
    if (state === 'waiting') app.store.updateRun(child, { status: 'waiting' });
    expect(() => write(app, runId, { remove: ['work'], cancelQueued: [child] })).toThrow(/may have started/);
    expect(app.store.run(child).cancelRequested).toBe(false);
    expect(readTodoSnapshot(app.store, runId).revision).toBe(1);
  });

  it('invalidates completed descendants transitively while preserving independent results and old attempts', () => {
    const { app, runId } = setup();
    write(app, runId, { updates: [task('a', 'main', [], 'completed'), task('b', 'agent', ['a']), task('c', 'agent', ['b']), task('independent', 'main', [], 'completed')] });
    const b = dispatch(app, runId, 'b'); accept(app, runId, 'b', b);
    const c = dispatch(app, runId, 'c'); accept(app, runId, 'c', c);
    write(app, runId, { updates: [{ id: 'a', status: 'in_progress', content: 'Updated contract' }] });
    const plan = readTodoSnapshot(app.store, runId);
    expect(plan.items.map(item => [item.id, item.status])).toEqual([['a', 'in_progress'], ['b', 'pending'], ['c', 'pending'], ['independent', 'completed']]);
    expect(plan.generations).toEqual({ a: 4, b: 4, c: 4, independent: 1 });
    expect(app.store.run(b).status).toBe('completed');
    expect(app.store.run(c).status).toBe('completed');
    expect(todoDependenciesCurrent(app.store, app.store.run(b))).toBe(false);
    expect(todoDependenciesCurrent(app.store, app.store.run(c))).toBe(false);
    write(app, runId, { updates: [{ id: 'a', status: 'completed' }] });
    expect(() => write(app, runId, { updates: [{ id: 'b', status: 'completed' }] })).toThrow('needs a completed child');
    const mailbox = app.coordinator.mailbox, parent = app.store.run(runId);
    const request = { target: b, objective: 'Verify revised contract', todoId: 'b' };
    const newB = (mailbox.execute(parent, 'reuse-b', 'followup_task', mailbox.validate(parent, 'followup_task', JSON.stringify(request))) as { id: string }).id;
    expect(app.store.run(newB)).toMatchObject({ continuationOf: b, todo: { generation: 4, dependencies: [{ id: 'a', generation: 4 }] } });
    accept(app, runId, 'b', newB);
    const newC = dispatch(app, runId, 'c'); accept(app, runId, 'c', newC);
    expect(readTodoSnapshot(app.store, runId).items.every(item => item.status === 'completed')).toBe(true);
  });

  it('keeps running inputs frozen and does not repeat stale-input notifications for display edits', () => {
    const { app, runId } = setup();
    write(app, runId, { updates: [task('a', 'main', [], 'completed'), task('b', 'agent', ['a'])] });
    const b = dispatch(app, runId, 'b');
    expect(todoRunReady(app.store, app.store.run(b))).toBe(true);
    app.store.updateRun(b, { status: 'running', step: 1 });
    const original = app.store.run(b).todo;
    write(app, runId, { updates: [{ id: 'a', status: 'in_progress' }] });
    write(app, runId, { updates: [{ id: 'a', note: 'Repairing' }] });
    refreshTodoDependencies(app.store, runId);
    expect(app.store.events(b, { types: ['todo.dependencies.changed'] })).toHaveLength(1);
    expect(app.store.run(b).todo).toEqual(original);
    write(app, runId, { updates: [{ id: 'a', status: 'completed' }] });
    app.store.updateRun(b, { status: 'completed' });
    expect(() => write(app, runId, { updates: [{ id: 'b', status: 'completed' }] })).toThrow('current accepted dependency versions');
  });

  it('rejects changed definitions completed in the same call, including main-owned tasks', () => {
    const { app, runId } = setup();
    write(app, runId, { updates: [task('a', 'main', [], 'completed')] });
    expect(() => write(app, runId, { updates: [{ id: 'a', content: 'Another deliverable', status: 'completed' }] })).toThrow('reopen it');
    expect(readTodoSnapshot(app.store, runId).generations?.a).toBe(1);
  });

  it('returns relevant bounded pages and original content for explicit task reads', async () => {
    const { app, runId } = setup();
    write(app, runId, { updates: Array.from({ length: 15 }, (_, i) => task(`t${i}`, 'main')) });
    const read = (args: Record<string, unknown>) => app.coordinator.tools.execute(runId, 'todo.read', args, new AbortController().signal);
    const first = await read({}) as { items: TodoItem[]; next: Record<string, unknown> };
    expect(first.items).toHaveLength(10);
    expect((await read(first.next) as { items: TodoItem[] }).items).toHaveLength(5);
    write(app, runId, { updates: [{ id: 't0', status: 'completed' }] });
    write(app, runId, { updates: [{ id: 't1', note: 'Latest progress' }] });
    const specific = await read({ ids: ['t0'] }) as { items: TodoItem[] };
    expect(specific.items).toEqual([expect.objectContaining({ id: 't0', content: 'Deliver t0', status: 'completed' })]);
    expect((await read({}) as { items: TodoItem[] }).items.some(item => item.id === 't0')).toBe(false);
    expect((await read({ full: true, limit: 25 }) as { items: TodoItem[] }).items).toHaveLength(15);
  });

  it('stores the complete graph but returns and recovers the same bounded update receipt', async () => {
    const { app, runId } = setup();
    const items = Array.from({ length: 100 }, (_, i) => ({ ...task(`t${i}`, 'main'), content: 'x'.repeat(1000), note: 'n'.repeat(1000) }));
    const args = { expectedRevision: 0, updates: items };
    const result = write(app, runId, args);
    expect(result.items).toHaveLength(10);
    expect(result.items[0]).toMatchObject({ content: 'x'.repeat(400), note: 'n'.repeat(200), detailsTruncated: true });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12_000);
    expect(readTodoSnapshot(app.store, runId).items).toEqual(items);
    const recovered = await todoTools(app.store)[1]!.recover!({ run: app.store.run(runId), call: {} as never, request: { id: 'update-receipt', name: 'todo.write', arguments: JSON.stringify(args) }, signal: new AbortController().signal });
    expect(recovered).toMatchObject({ outcome: 'succeeded', result });
    const noteUpdate = write(app, runId, { updates: [{ id: 't99', note: 'Latest result' }] });
    expect(noteUpdate.items[0]?.id).toBe('t99');
    expect(readTodoSnapshot(app.store, runId).items).toHaveLength(100);
  });

  it('preserves the graph, cancellation and notification identities across reopening', async () => {
    const root = temp(), directory = path.join(root, '.state');
    const app = new Application(directory, scripted(), undefined, options);
    const run = app.createRun({ objective: 'Exercise persisted graph state', workspace: root, binding, permissions: ['read', 'write'] });
    let plan: TodoSnapshot, b: string, cancelled: string;
    try {
      write(app, run.id, { updates: [task('a', 'main', [], 'completed'), task('b', 'agent', ['a']), task('obsolete')] });
      b = dispatch(app, run.id, 'b'); cancelled = dispatch(app, run.id, 'obsolete');
      expect(todoRunReady(app.store, app.store.run(b))).toBe(true);
      app.store.updateRun(b, { status: 'queued', step: 1 });
      write(app, run.id, { updates: [{ id: 'a', status: 'pending' }], remove: ['obsolete'], cancelQueued: [cancelled] });
      plan = readTodoSnapshot(app.store, run.id);
      expect(app.store.events(b, { types: ['todo.dependencies.changed'] })).toHaveLength(1);
    } finally { await app.shutdown(); }
    const reopened = new Application(directory, scripted(), undefined, { ...options, taskProtocol: 1 });
    try {
      expect(readTodoSnapshot(reopened.store, run.id)).toEqual(plan!);
      expect(reopened.store.session(run.sessionId).taskProtocol).toBe(3);
      expect(reopened.store.run(cancelled!).status).toBe('cancelled');
      refreshTodoDependencies(reopened.store, run.id);
      expect(reopened.store.events(b!, { types: ['todo.dependencies.changed'] })).toHaveLength(1);
      expect(reopened.store.events(cancelled!, { types: ['run.cancelled'] })).toHaveLength(1);
      expect(reopened.store.run(b!).todo?.dependencies).toEqual([{ id: 'a', generation: 1 }]);
    } finally { await reopened.shutdown(); }
  });

  it('rejects protocol 3 fields in legacy calls and malformed partial updates', () => {
    const { app, runId } = fixture(undefined, ['read'], { taskProtocol: 2 });
    const run = app.store.run(runId), session = app.store.session(run.sessionId);
    expect(() => app.coordinator.tools.validate('todo.write', JSON.stringify({ expectedRevision: 0, updates: [task('a', 'main')] }), run.card.tools, session, run)).toThrow('schema');
    for (const args of [{ expectedRevision: 0 }, { expectedRevision: 0, items: [], updates: [] }, { expectedRevision: 0, updates: [{ id: 'a', owner: 'foreign' }] }]) expect(() => validateDynamicTodoArgs('todo.write', args)).toThrow('schema');
  });
});
