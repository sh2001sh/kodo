import { describe, expect, it, vi } from 'vitest';
import { fixture, scripted } from './helpers.js';
import { readTodoSnapshot, todoDispatchState, todoTools } from '../src/tools/todo.js';
import type { TodoItem, TodoSnapshot } from '../src/tools/todo.js';
import type { Application } from '../src/application/index.js';

// Isolated synthetic lifecycle data: the real mailbox records dispatch; no model runs.
const work: TodoItem = { id: 'work', content: 'Investigate the assigned question', executor: 'agent', status: 'in_progress' };
function setup(taskProtocol: 1 | 2) {
  return fixture(scripted(), ['read', 'write'], { taskProtocol, toolProfile: 'full', agentFactors: { A: true, B: true, C: true }, instructions: { global: false } });
}
function write(app: Application, runId: string, items: TodoItem[], markEffectStarted = () => {}) {
  const run = app.store.run(runId);
  return todoTools(app.store)[1]!.execute({ run, session: app.store.session(run.sessionId), signal: new AbortController().signal, markEffectStarted }, {
    items, expectedRevision: readTodoSnapshot(app.store, runId).revision,
  }) as TodoSnapshot;
}
function dispatch(app: Application, runId: string, taskProtocol: 1 | 2) {
  const run = app.store.run(runId), mailbox = app.coordinator.mailbox;
  const args = { objective: 'Isolated synthetic lifecycle; no model runs', ...(taskProtocol === 2 ? { todoId: work.id } : {}) };
  return mailbox.execute(run, crypto.randomUUID(), 'spawn_agent', mailbox.validate(run, 'spawn_agent', JSON.stringify(args))) as { id: string };
}

describe.each([1, 2] as const)('task protocol %s acceptance contract', taskProtocol => {
  it('accepts unchanged completed work without changing its generation', () => {
    const { app, runId } = setup(taskProtocol);
    const initial = write(app, runId, [work]);
    const child = dispatch(app, runId, taskProtocol);
    app.store.updateRun(child.id, { status: 'completed' });
    const accepted = write(app, runId, [{ ...work, status: 'completed' }]);
    expect(accepted.generations).toEqual(initial.generations);
    expect(todoDispatchState(app.store, runId)).toEqual([{ id: work.id, generation: 1, state: 'completed', runIds: [child.id] }]);
  });

  it('explains simultaneous description changes and rolls back the entire update', () => {
    const { app, runId } = setup(taskProtocol);
    const sibling: TodoItem = { id: 'review', content: 'Review evidence', executor: 'main', status: 'pending' };
    const before = write(app, runId, [work, sibling]);
    const child = dispatch(app, runId, taskProtocol);
    app.store.updateRun(child.id, { status: 'completed' });
    const events = app.store.events(runId), marked = vi.fn();
    expect(() => write(app, runId, [{ ...work, content: 'Investigation delivered', status: 'completed' }, { ...sibling, status: 'completed' }], marked))
      .toThrow('preserve content, executor and dependsOn when accepting');
    expect(marked).not.toHaveBeenCalled();
    expect(readTodoSnapshot(app.store, runId)).toEqual(before);
    expect(app.store.events(runId)).toEqual(events);
    expect(todoDispatchState(app.store, runId)[0]).toMatchObject({ generation: 1, state: 'awaiting_acceptance', runIds: [child.id] });
    // The actionable recovery accepts the original task, without changing ownership.
    expect(write(app, runId, [{ ...work, status: 'completed' }, sibling]).generations).toEqual(before.generations);
  });

  it('rejects rewriting an already accepted assignment without altering its evidence', () => {
    const { app, runId } = setup(taskProtocol);
    write(app, runId, [work]);
    const child = dispatch(app, runId, taskProtocol);
    app.store.updateRun(child.id, { status: 'completed' });
    const accepted = write(app, runId, [{ ...work, status: 'completed' }]);
    expect(() => write(app, runId, [{ ...work, content: 'Polished completed wording', status: 'completed' }])).toThrow('previous task generation');
    expect(readTodoSnapshot(app.store, runId)).toEqual(accepted);
    expect(todoDispatchState(app.store, runId)[0]?.state).toBe('completed');
  });

  it('reopens changed work as a new generation and requires fresh child completion', () => {
    const { app, runId } = setup(taskProtocol);
    write(app, runId, [work]);
    const first = dispatch(app, runId, taskProtocol);
    app.store.updateRun(first.id, { status: 'completed' });
    const accepted = write(app, runId, [{ ...work, status: 'completed' }]);
    const changed: TodoItem = { ...work, content: 'Investigate a genuinely different question' };
    const reopened = write(app, runId, [changed]);
    expect(reopened.generations?.work).toBe(accepted.revision + 1);
    expect(todoDispatchState(app.store, runId)[0]).toMatchObject({ state: 'awaiting_dispatch', runIds: [] });
    expect(() => write(app, runId, [{ ...changed, status: 'completed' }])).toThrow('requires a completed child');
    expect(readTodoSnapshot(app.store, runId)).toEqual(reopened);
    const second = dispatch(app, runId, taskProtocol);
    expect(() => write(app, runId, [{ ...changed, status: 'completed' }])).toThrow('requires a completed child');
    app.store.updateRun(second.id, { status: 'completed' });
    expect(write(app, runId, [{ ...changed, status: 'completed' }]).generations).toEqual(reopened.generations);
    expect(todoDispatchState(app.store, runId)[0]?.runIds).toEqual([second.id]);
  });
});

it('rejects changed dependencies during protocol 2 acceptance without mutating task versions', () => {
  const { app, runId } = setup(2);
  const prerequisite: TodoItem = { id: 'design', content: 'Accepted design', executor: 'main', status: 'completed' };
  const before = write(app, runId, [prerequisite, work]);
  const child = dispatch(app, runId, 2);
  app.store.updateRun(child.id, { status: 'completed' });
  expect(() => write(app, runId, [prerequisite, { ...work, dependsOn: ['design'], status: 'completed' }])).toThrow('preserve content, executor and dependsOn');
  expect(readTodoSnapshot(app.store, runId)).toEqual(before);
  expect(app.store.run(child.id).todo?.dependencies).toEqual([]);
});
