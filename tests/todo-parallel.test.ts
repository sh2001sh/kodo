import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fixture, scripted } from './helpers.js';
import { readTodoSnapshot, todoDispatchState, todoTools } from '../src/tools/todo.js';
import type { TodoItem, TodoSnapshot } from '../src/tools/todo.js';
import type { Application } from '../src/application/index.js';
import { todoRunReady, todoDependenciesCurrent } from '../src/runtime/todo-dependencies.js';
import { todoExecutionFeedback } from '../src/runtime/todo-execution.js';

function setup() { return fixture(scripted(), ['read', 'write'], { taskProtocol: 2, toolProfile: 'full', agentFactors: { A: true, B: true, C: true }, instructions: { global: false } }); }
function write(app: Application, runId: string, items: TodoItem[]): TodoSnapshot {
  const run = app.store.run(runId);
  return todoTools(app.store)[1]!.execute({ run, session: app.store.session(run.sessionId), signal: new AbortController().signal, markEffectStarted() {} }, { items, expectedRevision: readTodoSnapshot(app.store, runId).revision }) as TodoSnapshot;
}
function dispatch(app: Application, runId: string, todoId?: string) {
  const run = app.store.run(runId), mailbox = app.coordinator.mailbox;
  const args = { objective: 'Isolated synthetic investigation lifecycle; no model executes', agent: 'kodo/explorer', slots: { question: 'Synthetic fixture question' }, ...(todoId ? { todoId } : {}) };
  return mailbox.execute(run, crypto.randomUUID(), 'spawn_agent', mailbox.validate(run, 'spawn_agent', JSON.stringify(args))) as { id: string; agentId: string };
}
const task = (id: string, executor: 'main' | 'agent' = 'agent', dependsOn?: string[]): TodoItem => ({ id, content: `Complete ${id}`, status: 'in_progress', executor, ...(dependsOn ? { dependsOn } : {}) });

describe('explicit parallel task protocol', () => {
  it('binds two active tasks explicitly and leaves omitted todoId unassociated', () => {
    const { app, runId } = setup();
    write(app, runId, [task('first'), task('second')]);
    const second = dispatch(app, runId, 'second'), first = dispatch(app, runId, 'first'), unlinked = dispatch(app, runId);
    expect(app.store.run(second.id).todo?.id).toBe('second');
    expect(app.store.run(first.id).todo?.id).toBe('first');
    expect(app.store.run(unlinked.id).todo).toBeUndefined();
    expect(todoDispatchState(app.store, runId).map(item => item.runIds)).toEqual([[first.id], [second.id]]);
  });

  it('rejects invalid task associations atomically before child creation', () => {
    const { app, runId } = setup();
    write(app, runId, [task('main', 'main')]);
    for (const id of ['missing', 'main']) expect(() => dispatch(app, runId, id)).toThrow('unfinished agent-owned task');
    expect(app.store.listRuns(app.store.run(runId).sessionId)).toHaveLength(1);
    expect(app.store.events(runId, { types: ['todo.dispatched'] })).toHaveLength(0);
  });

  it('queues a dependency without starting it and releases only that successor after acceptance', () => {
    const { app, runId } = setup();
    const items = [task('first'), task('next', 'agent', ['first']), task('other')];
    write(app, runId, items);
    const first = dispatch(app, runId, 'first'), next = dispatch(app, runId, 'next'), other = dispatch(app, runId, 'other');
    expect(todoRunReady(app.store, app.store.run(next.id))).toBe(false);
    expect(todoRunReady(app.store, app.store.run(other.id))).toBe(true);
    app.store.updateRun(first.id, { status: 'completed' });
    expect(todoRunReady(app.store, app.store.run(next.id))).toBe(false);
    write(app, runId, items.map(item => item.id === 'first' ? { ...item, status: 'completed' } : item));
    expect(todoRunReady(app.store, app.store.run(next.id))).toBe(true);
    expect(app.store.run(other.id).status).toBe('queued');
    expect(app.store.run(next.id).todo).toMatchObject({ dependencies: [{ id: 'first', generation: 1 }], ready: true });
  });

  it('keeps failed and cancelled prerequisites blocked, and rejects invalid dependency graphs', () => {
    const { app, runId } = setup();
    for (const items of [[task('a', 'agent', ['missing'])], [task('a', 'agent', ['a'])], [task('a', 'agent', ['b']), task('b', 'agent', ['a'])]]) expect(() => write(app, runId, items)).toThrow(/dependenc/);
    write(app, runId, [task('a'), task('b', 'agent', ['a'])]);
    const a = dispatch(app, runId, 'a'), b = dispatch(app, runId, 'b');
    for (const status of ['failed', 'cancelled'] as const) {
      app.store.updateRun(a.id, { status });
      expect(todoRunReady(app.store, app.store.run(b.id))).toBe(false);
    }
  });

  it('does not silently rebind started work when a prerequisite reopens', () => {
    const { app, runId } = setup();
    const items = [task('design', 'main'), task('build', 'agent', ['design'])];
    write(app, runId, items.map(item => item.id === 'design' ? { ...item, status: 'completed' } : item));
    const build = dispatch(app, runId, 'build');
    expect(todoRunReady(app.store, app.store.run(build.id))).toBe(true);
    app.store.updateRun(build.id, { status: 'running', step: 1 });
    write(app, runId, items);
    expect(todoDependenciesCurrent(app.store, app.store.run(build.id))).toBe(false);
    expect(app.store.run(build.id).todo?.dependencies).toEqual([{ id: 'design', generation: 1 }]);
    expect(app.store.events(build.id, { types: ['todo.dependencies.changed'] })).toHaveLength(1);
    app.store.updateRun(build.id, { status: 'completed' });
    write(app, runId, items.map(item => item.id === 'design' ? { ...item, status: 'completed' } : item));
    expect(() => write(app, runId, items.map(item => ({ ...item, status: 'completed' })))).toThrow('current accepted dependency versions');
  });

  it('re-evaluates an unstarted dependency generation after reopening', () => {
    const { app, runId } = setup();
    const items = [task('design', 'main'), task('build', 'agent', ['design'])];
    write(app, runId, items.map(item => item.id === 'design' ? { ...item, status: 'completed' } : item));
    const build = dispatch(app, runId, 'build');
    write(app, runId, items);
    expect(todoRunReady(app.store, app.store.run(build.id))).toBe(false);
    write(app, runId, items.map(item => item.id === 'design' ? { ...item, status: 'completed' } : item));
    expect(todoRunReady(app.store, app.store.run(build.id))).toBe(true);
    expect(app.store.run(build.id).todo?.dependencies).toEqual([{ id: 'design', generation: 2 }]);
  });

  it('preserves prerequisite versions between model steps and wakes the parent to decide', () => {
    const { app, runId } = setup();
    const items = [task('design', 'main'), task('build', 'agent', ['design'])];
    write(app, runId, items.map(item => item.id === 'design' ? { ...item, status: 'completed' } : item));
    const child = dispatch(app, runId, 'build');
    expect(todoRunReady(app.store, app.store.run(child.id))).toBe(true);
    app.store.updateRun(child.id, { status: 'queued', step: 2 });
    const wait = app.coordinator.mailbox.waitForRuns(app.store.run(runId), [child.id]);
    app.store.updateRun(runId, { status: 'waiting' });
    write(app, runId, items);
    write(app, runId, items.map(item => item.id === 'design' ? { ...item, status: 'completed' } : item));
    expect(todoRunReady(app.store, app.store.run(child.id))).toBe(true);
    expect(app.store.run(child.id).todo?.dependencies).toEqual([{ id: 'design', generation: 1 }]);
    expect(todoDependenciesCurrent(app.store, app.store.run(child.id))).toBe(false);
    app.coordinator.mailbox.refresh(runId);
    expect(app.store.wait(wait.waitId).reason).toBe('new_input');
  });

  it('treats an admitted checkout waiting for a model slot as frozen input', () => {
    const { app, runId } = setup();
    const items = [task('design', 'main'), task('build', 'agent', ['design'])];
    write(app, runId, items.map(item => item.id === 'design' ? { ...item, status: 'completed' } : item));
    const child = dispatch(app, runId, 'build');
    expect(todoRunReady(app.store, app.store.run(child.id))).toBe(true);
    // Isolated synthetic admission event: no model executes and no checkout is created here.
    app.store.event(child.id, 'execution.prepared', { synthetic: true });
    write(app, runId, items);
    write(app, runId, items.map(item => item.id === 'design' ? { ...item, status: 'completed' } : item));
    expect(todoRunReady(app.store, app.store.run(child.id))).toBe(true);
    expect(app.store.run(child.id).todo?.dependencies).toEqual([{ id: 'design', generation: 1 }]);
    expect(app.store.events(child.id, { types: ['todo.dependencies.changed'] }).length).toBeGreaterThan(0);
    expect(todoDependenciesCurrent(app.store, app.store.run(child.id))).toBe(false);
  });

  it('wakes a parent waiting only for a successor whose prerequisite needs a parent decision', () => {
    const { app, runId } = setup();
    write(app, runId, [task('design', 'main'), task('build', 'agent', ['design'])]);
    const child = dispatch(app, runId, 'build');
    const wait = app.coordinator.mailbox.waitForRuns(app.store.run(runId), [child.id]);
    app.store.updateRun(runId, { status: 'waiting' });
    expect(todoRunReady(app.store, app.store.run(child.id))).toBe(false);
    app.coordinator.mailbox.refresh(runId);
    expect(app.store.wait(wait.waitId).reason).toBe('new_input');
    expect(app.store.events(child.id, { types: ['todo.dependencies.blocked'] })).toHaveLength(1);
  });

  it('supports explicit association on followup and each explore task without implicit rebinding', () => {
    const { app, runId } = setup();
    write(app, runId, [task('first'), task('second')]);
    const first = dispatch(app, runId, 'first');
    app.store.updateRun(first.id, { status: 'completed' });
    const mailbox = app.coordinator.mailbox, run = app.store.run(runId);
    const args = { target: first.agentId, objective: 'Synthetic followup task', slots: { question: 'Second synthetic question' }, todoId: 'second' };
    const second = mailbox.execute(run, 'followup-once', 'followup_task', mailbox.validate(run, 'followup_task', JSON.stringify(args))) as { id: string };
    const replay = mailbox.execute(run, 'followup-once', 'followup_task', args) as { id: string };
    expect(replay.id).toBe(second.id);
    expect(app.store.run(second.id).todo?.id).toBe('second');
    app.store.updateRun(second.id, { status: 'completed' });
    const exploration = { tasks: [{ prompt: 'Synthetic independent one', todoId: 'first' }, { prompt: 'Synthetic independent two', todoId: 'second' }] };
    const result = mailbox.execute(run, 'explore-explicit', 'explore', mailbox.validate(run, 'explore', JSON.stringify(exploration))) as { runs: { id: string }[] };
    expect(result.runs.map(child => app.store.run(child.id).todo?.id)).toEqual(['first', 'second']);
  });

  it('accepts an explicitly linked verifier rather than changing its executor', () => {
    const { app, runId } = setup();
    const items = [task('implement'), task('verify')];
    write(app, runId, items);
    const implement = dispatch(app, runId, 'implement'), verify = dispatch(app, runId, 'verify');
    app.store.updateRun(implement.id, { status: 'completed' }); app.store.updateRun(verify.id, { status: 'completed' });
    const result = write(app, runId, items.map(item => ({ ...item, status: 'completed' })));
    expect(result.items.every(item => item.executor === 'agent')).toBe(true);
    expect(todoDispatchState(app.store, runId).every(item => item.state === 'completed')).toBe(true);
  });

  it('allows main writes to independent paths while retaining active child ownership', () => {
    const { app, root, runId } = setup();
    write(app, runId, [task('child'), task('main', 'main')]);
    const child = dispatch(app, runId, 'child');
    app.store.updateRun(child.id, { status: 'running', permissions: ['read', 'write'], scope: { write: ['child.ts'] } });
    const run = app.store.run(runId);
    expect(todoExecutionFeedback(app.store, run, 'file.patch', 'write', [path.join(root, 'main.ts')])).toBeUndefined();
    expect(todoExecutionFeedback(app.store, run, 'file.patch', 'write', [path.join(root, 'child.ts')])).toContain('TODO_DELEGATED');
    expect(todoExecutionFeedback(app.store, run, 'shell.exec', 'write', [root])).toContain('TODO_DELEGATED');
    expect(todoExecutionFeedback(app.store, run, 'shell.exec', 'read')).toBeUndefined();
  });

  it('renews event-only waits without a wake but retains explicit timeout behavior', () => {
    const { app, runId } = setup(); const child = dispatch(app, runId);
    const mailbox = app.coordinator.mailbox, run = app.store.run(runId);
    const wait = mailbox.waitForRuns(run, [child.id]);
    app.store.updateRun(runId, { status: 'waiting' });
    app.store.putWait({ ...app.store.wait(wait.waitId), deadline: Date.now() - 1 });
    mailbox.refresh(runId);
    expect(app.store.wait(wait.waitId).status).toBe('registered');
    expect(app.store.run(runId).status).toBe('waiting');
    expect(app.store.message(`wake:${wait.waitId}`)).toBeUndefined();
    app.store.updateRun(child.id, { status: 'completed' }); mailbox.refresh(runId);
    expect(app.store.wait(wait.waitId).reason).toBe('conditions_met');
    const another = dispatch(app, runId);
    const explicit = mailbox.execute(app.store.run(runId), 'explicit-wait', 'wait_for_events', { run_ids: [another.id], timeout_ms: 1 }) as { waitId: string };
    app.store.putWait({ ...app.store.wait(explicit.waitId), deadline: Date.now() - 1 }); mailbox.refresh(runId);
    expect(app.store.wait(explicit.waitId).reason).toBe('timeout');
  });
});
