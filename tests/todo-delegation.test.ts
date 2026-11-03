import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { activeAgentTodo, readTodoSnapshot, recordTodoDispatch, todoCompletionFeedback, todoDispatchState, todoTools } from '../src/tools/todo.js';
import type { TodoItem, TodoSnapshot } from '../src/tools/todo.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolExecutionContext } from '../src/tools/registry.js';
import { todoMessage } from '../src/runtime/context-progress.js';
import { fixture, scripted } from './helpers.js';

// All child results and call states below are isolated synthetic lifecycle data.
// The real mailbox records dispatch, but no model or workspace tool is executed.
function setup(leadMode = true) {
  return fixture(scripted(), undefined, { agentFactors: { A: true, B: leadMode, C: true }, instructions: { global: false } });
}
function context(app: Application, runId: string): ToolExecutionContext {
  const run = app.store.run(runId);
  return { run, session: app.store.session(run.sessionId), signal: new AbortController().signal, markEffectStarted() {} };
}
function write(app: Application, runId: string, items: TodoItem[], expectedRevision = readTodoSnapshot(app.store, runId).revision): TodoSnapshot {
  return todoTools(app.store)[1]!.execute(context(app, runId), { expectedRevision, items }) as TodoSnapshot;
}
function operation(app: Application, mainId: string, name: string, args: Record<string, unknown>, callId: string = crypto.randomUUID()) {
  const mailbox = app.coordinator.mailbox;
  const run = app.store.run(mainId);
  return mailbox.execute(run, callId, name, mailbox.validate(run, name, JSON.stringify(args))) as { id: string; agentId: string };
}
function spawn(app: Application, runId: string, callId?: string) {
  return operation(app, runId, 'spawn_agent', { objective: 'Synthetic bounded investigation' }, callId);
}
const work: TodoItem = { id: 'investigate', content: 'Investigate the assigned question', status: 'in_progress', executor: 'agent' };

describe('todo delegation ownership and durable dispatch', () => {
  it('requires explicit lead ownership while reading legacy snapshots unchanged', () => {
    const { app, runId } = setup();
    const legacy: TodoSnapshot = { ownerRunId: runId, revision: 4, items: [{ id: 'legacy', content: 'Historical plan', status: 'in_progress' }] };
    app.store.event(runId, 'todo.updated', { snapshot: legacy });
    const marker = todoMessage(legacy);
    expect(readTodoSnapshot(app.store, runId)).toEqual(legacy);
    expect(todoTools(app.store)[0]!.execute(context(app, runId), {})).toEqual(legacy);
    expect(activeAgentTodo(app.store, runId)).toBeUndefined();
    expect(() => write(app, runId, legacy.items)).toThrow('require executor');
    expect(readTodoSnapshot(app.store, runId)).toEqual(legacy);
    const explicit = write(app, runId, [{ ...legacy.items[0]!, executor: 'main' }]);
    expect(explicit).toMatchObject({ revision: 5, items: [{ executor: 'main' }] });
    expect(app.store.events(runId, { types: ['todo.updated'] })[0]!.data.snapshot).toEqual(legacy);
    expect(todoMessage(legacy)).toEqual(marker);
  });

  it('supports omitted executors with factor B off and forbids child delegation ownership', () => {
    const { app, runId } = setup(false);
    const legacy = { id: 'legacy', content: 'Legacy own work', status: 'in_progress' as const };
    expect(write(app, runId, [legacy])).toEqual({ ownerRunId: runId, revision: 1, items: [legacy] });
    const child = spawn(app, runId);
    expect(app.store.events(runId, { types: ['todo.dispatched'] })).toHaveLength(0);
    expect(() => write(app, child.id, [work])).toThrow('child task lists cannot delegate');
    expect(write(app, child.id, [{ ...work, executor: 'main' }]).items).toMatchObject([{ executor: 'main' }]);
    expect(activeAgentTodo(app.store, child.id)).toBeUndefined();
  });

  it('keeps generation data host-owned and validates executor values in the tool schema', () => {
    const { app } = setup();
    const registry = new ToolRegistry();
    for (const tool of todoTools(app.store)) registry.register(tool);
    const tool = registry.get('todo.write')!;
    expect(tool.validate({ expectedRevision: 0, items: [work] })).toBe(true);
    expect(tool.validate({ expectedRevision: 0, items: [{ ...work, executor: 'worker' }] })).toBe(false);
    expect(tool.validate({ expectedRevision: 0, items: [work], generations: { investigate: 1 } })).toBe(false);
    expect(tool.validate({ expectedRevision: 0, items: [{ ...work, generation: 1 }] })).toBe(false);
  });

  it('tracks real mailbox dispatch, failed attempts, successful retries and explicit acceptance', () => {
    const { app, runId } = setup();
    write(app, runId, [work]);
    expect(activeAgentTodo(app.store, runId)).toEqual({ id: work.id, generation: 1 });
    expect(todoDispatchState(app.store, runId)).toEqual([{ id: work.id, generation: 1, state: 'awaiting_dispatch', runIds: [] }]);
    expect(todoCompletionFeedback(app.store, runId)).toContain('awaiting_dispatch');
    expect(() => write(app, runId, [{ ...work, status: 'completed' }])).toThrow('requires a completed child');

    const failed = spawn(app, runId);
    recordTodoDispatch(app.store, runId, failed.id);
    expect(app.store.events(runId, { types: ['todo.dispatched'] })).toHaveLength(1);
    expect(todoDispatchState(app.store, runId)).toEqual([{ id: work.id, generation: 1, state: 'running', runIds: [failed.id] }]);
    app.store.updateRun(failed.id, { status: 'failed', error: 'Synthetic task failure; no model was called.' });
    expect(todoDispatchState(app.store, runId)[0]?.state).toBe('needs_attention');
    expect(() => write(app, runId, [{ ...work, status: 'completed' }])).toThrow('requires a completed child');

    const retry = operation(app, runId, 'followup_task', { target: failed.agentId, objective: 'Synthetic retry task' });
    expect(todoDispatchState(app.store, runId)[0]).toMatchObject({ state: 'running', runIds: [failed.id, retry.id] });
    app.store.updateRun(retry.id, { status: 'completed', resultRef: app.store.blob({ text: 'Synthetic accepted evidence' }) });
    expect(todoDispatchState(app.store, runId)[0]?.state).toBe('awaiting_acceptance');
    expect(todoCompletionFeedback(app.store, runId)).toContain('awaiting_acceptance');
    const accepted = write(app, runId, [{ ...work, status: 'completed' }]);
    expect(accepted.generations).toEqual({ investigate: 1 });
    expect(todoDispatchState(app.store, runId)[0]?.state).toBe('completed');
    expect(todoCompletionFeedback(app.store, runId)).toBeUndefined();
    expect(todoTools(app.store)[0]!.execute(context(app, runId), {})).toEqual({ ...accepted, dispatch: todoDispatchState(app.store, runId) });
  });

  it('does not replace or accept an assignment while its linked child is active', () => {
    const { app, runId } = setup();
    const original = write(app, runId, [work]);
    spawn(app, runId);
    for (const items of [[], [{ ...work, executor: 'main' as const }], [{ ...work, content: 'A different question' }], [{ ...work, status: 'pending' as const }]]) {
      expect(() => write(app, runId, items)).toThrow('active delegated work');
      expect(readTodoSnapshot(app.store, runId)).toEqual(original);
    }
    expect(() => write(app, runId, [{ ...work, status: 'completed' }])).toThrow('requires a completed child');
    expect(readTodoSnapshot(app.store, runId)).toEqual(original);
    const preserved = write(app, runId, [work, { id: 'integrate', content: 'Review results', status: 'pending', executor: 'main' }]);
    expect(preserved.generations).toEqual({ investigate: 1 });
    expect(todoDispatchState(app.store, runId)[0]?.state).toBe('running');
  });

  it('requires all dispatched runs to settle even when one child already completed', () => {
    const { app, runId } = setup();
    write(app, runId, [work]);
    const first = spawn(app, runId);
    const second = spawn(app, runId);
    app.store.updateRun(first.id, { status: 'completed' });
    expect(() => write(app, runId, [{ ...work, status: 'completed' }])).toThrow('all linked child runs settled');
    app.store.updateRun(second.id, { status: 'interrupted' });
    expect(todoDispatchState(app.store, runId)[0]?.state).toBe('running');
    app.store.updateRun(second.id, { status: 'cancelled' });
    expect(todoDispatchState(app.store, runId)[0]?.state).toBe('awaiting_acceptance');
    write(app, runId, [{ ...work, status: 'completed' }]);
    expect(todoCompletionFeedback(app.store, runId)).toBeUndefined();
  });

  it('keeps unsettled terminal tool work attached until its definite reconciliation', () => {
    const { app, runId } = setup();
    write(app, runId, [work]);
    const successful = spawn(app, runId);
    app.store.updateRun(successful.id, { status: 'completed' });
    const unsettled = spawn(app, runId);
    // Synthetic persisted write state only; no workspace tool or side effect runs.
    app.store.putCall({ id: 'synthetic-todo-effect', runId: unsettled.id, step: 0, kind: 'tool', name: 'file.apply_patch', status: 'unknown', effect: 'write', effectState: 'started', requestRef: app.store.blob({ synthetic: true }), reservedTokens: 0 });
    app.store.event(unsettled.id, 'tool.started', { callId: 'synthetic-todo-effect' });
    app.store.updateRun(unsettled.id, { status: 'cancelled' });
    expect(todoDispatchState(app.store, runId)[0]?.state).toBe('running');
    expect(todoCompletionFeedback(app.store, runId)).toContain(unsettled.id);
    expect(() => write(app, runId, [])).toThrow('active delegated work');
    app.resolveCall(unsettled.id, 'synthetic-todo-effect', { outcome: 'failed', evidence: 'Isolated synthetic lifecycle fixture: effect definitively failed; no tool was executed.' });
    expect(todoDispatchState(app.store, runId)[0]?.state).toBe('awaiting_acceptance');
    write(app, runId, [{ ...work, status: 'completed' }]);
    expect(todoCompletionFeedback(app.store, runId)).toBeUndefined();
  });

  it('starts a new generation when accepted work reopens, content changes or ownership returns to an agent', () => {
    const { app, runId } = setup();
    write(app, runId, [work]);
    const child = spawn(app, runId);
    app.store.updateRun(child.id, { status: 'completed' });
    write(app, runId, [{ ...work, status: 'completed' }]);
    const reopened = write(app, runId, [work]);
    expect(reopened.generations).toEqual({ investigate: 3 });
    expect(todoDispatchState(app.store, runId)[0]).toMatchObject({ generation: 3, state: 'awaiting_dispatch', runIds: [] });
    expect(() => write(app, runId, [{ ...work, status: 'completed' }])).toThrow('requires a completed child');
    expect(write(app, runId, [work]).generations).toEqual({ investigate: 3 });
    const edited = { ...work, content: 'Investigate the changed question' };
    expect(write(app, runId, [edited]).generations).toEqual({ investigate: 5 });
    expect(write(app, runId, [{ ...edited, executor: 'main' }]).generations).toBeUndefined();
    expect(write(app, runId, [edited]).generations).toEqual({ investigate: 7 });
    expect(write(app, runId, []).generations).toBeUndefined();
    expect(write(app, runId, [edited]).generations).toEqual({ investigate: 9 });
    expect(app.store.events(runId, { types: ['todo.dispatched'] })[0]?.data).toMatchObject({ todoId: work.id, generation: 1, childRunId: child.id });
  });

  it('records no dispatch for main-owned work and rolls back dispatch with a failed creation transaction', () => {
    const { app, runId } = setup(false);
    write(app, runId, [{ ...work, executor: 'main' }]);
    const unlinked = spawn(app, runId);
    recordTodoDispatch(app.store, runId, unlinked.id);
    expect(app.store.events(runId, { types: ['todo.dispatched'] })).toHaveLength(0);
    app.store.updateRun(unlinked.id, { status: 'completed' });
    write(app, runId, [work]);
    const before = app.store.listRuns(app.store.run(runId).sessionId).length;
    expect(() => app.store.transaction(() => {
      spawn(app, runId);
      throw new Error('Synthetic transaction rollback');
    })).toThrow('Synthetic transaction rollback');
    expect(app.store.listRuns(app.store.run(runId).sessionId)).toHaveLength(before);
    expect(app.store.events(runId, { types: ['todo.dispatched'] })).toHaveLength(0);
    expect(todoDispatchState(app.store, runId)[0]?.state).toBe('awaiting_dispatch');
  });

  it('associates every explore child with one assignment and leaves rejected batches unassociated', () => {
    const { app, runId } = setup();
    write(app, runId, [work]);
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxActiveChildren: 1 } });
    const args = { tasks: [{ prompt: 'Synthetic independent question one' }, { prompt: 'Synthetic independent question two' }] };
    expect(() => operation(app, runId, 'explore', args)).toThrow('only 1 child slots');
    expect(app.store.listRuns(session.id)).toHaveLength(1);
    expect(app.store.events(runId, { types: ['todo.dispatched'] })).toHaveLength(0);
    expect(todoDispatchState(app.store, runId)[0]).toMatchObject({ state: 'awaiting_dispatch', runIds: [] });
    app.store.putSession({ ...session, budget: { ...session.budget, maxActiveChildren: 2 } });
    operation(app, runId, 'explore', args);
    const children = app.store.listRuns(session.id).filter(run => run.parentId === runId);
    expect(children).toHaveLength(2);
    const events = app.store.events(runId, { types: ['todo.dispatched'] });
    expect(events).toHaveLength(2);
    expect(events.map(event => event.data)).toEqual(children.map(child => ({ todoId: work.id, generation: 1, childRunId: child.id })));
    expect(todoDispatchState(app.store, runId)).toEqual([{ id: work.id, generation: 1, state: 'running', runIds: children.map(child => child.id) }]);
  });

  it('preserves dispatch and raw recovery snapshots after storage reopens', async () => {
    const { app, root, runId } = setup();
    const args = { expectedRevision: 0, items: [work] };
    const original = write(app, runId, [work]);
    const child = spawn(app, runId);
    app.store.updateRun(child.id, { status: 'completed' });
    await app.shutdown();
    const restored = new Application(path.join(root, '.state'), scripted());
    try {
      expect(readTodoSnapshot(restored.store, runId)).toEqual(original);
      expect(todoDispatchState(restored.store, runId)).toEqual([{ id: work.id, generation: 1, state: 'awaiting_acceptance', runIds: [child.id] }]);
      const recovered = await todoTools(restored.store)[1]!.recover!({ run: restored.store.run(runId), call: {} as never, request: { id: 'recover-todo', name: 'todo.write', arguments: JSON.stringify(args) }, signal: new AbortController().signal });
      expect(recovered).toMatchObject({ outcome: 'succeeded', result: original });
      expect(recovered).not.toHaveProperty('result.dispatch');
      write(restored, runId, [{ ...work, status: 'completed' }]);
      expect(todoCompletionFeedback(restored.store, runId)).toBeUndefined();
    } finally { await restored.shutdown(); }
  });
});
