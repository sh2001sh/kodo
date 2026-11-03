import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkCompletion } from '../src/runtime/completion.js';
import { childCompletionState } from '../src/runtime/child-completion.js';
import { declareTasks } from '../src/runtime/task-declare.js';
import { moveTaskNode, readTaskGraph, requireTaskNode, writeTaskNode } from '../src/runtime/task-graph.js';
import { acknowledgeTaskFailure, dropTask, recordTaskRunOutcome } from '../src/runtime/task-lifecycle.js';
import { taskGraphCompletionState, taskGraphTerminalCheck } from '../src/runtime/task-completion.js';
import type { StepHost } from '../src/runtime/step-host.js';
import type { Message, Run, RunStatus } from '../src/runtime/types.js';
import { answer, fixture, scripted } from './helpers.js';

// Direct completion tests isolate the acceptance boundary from scheduling. The
// wait adapter persists real waits, while runtime tests exercise their wakeups.
function team() {
  const f = fixture(scripted(), ['read'], { toolProfile: 'full', taskProtocol: 3 });
  const store = f.app.store, main = () => store.run(f.runId);
  store.putSession({ ...store.session(main().sessionId), toolProfile: 'lean-team' });
  const wait = vi.fn((run: Run, nodeIds: string[], mode: 'any' | 'all') => {
    const waitId = randomUUID();
    store.putWait({ id: waitId, runId: run.id, questionIds: [], runIds: [], mode, deadline: Date.now() + 300_000, eventDriven: true, status: 'registered' });
    store.updateRun(run.id, { waitId });
    store.event(run.id, 'wait.registered', { waitId, nodeIds });
    return { waitId };
  });
  const host = Object.create(f.app.coordinator) as StepHost;
  Object.defineProperty(host, 'tasks', { value: { wait } });
  const check = () => checkCompletion(host, main(), answer('Candidate final response.'), new AbortController().signal);
  const context = () => store.readBlob<Message[]>(main().contextRef);
  const node = (id: string) => requireTaskNode(readTaskGraph(store, f.runId), id);
  const child = (id: string, status: RunStatus = 'running', managed = true) => {
    const run: Run = { ...main(), id: randomUUID(), parentId: f.runId, objective: `Synthetic task ${id}`, status,
      ...(managed ? { taskNode: { ownerId: f.runId, nodeId: id, role: 'implementer', generation: node(id).generation } } : {}) };
    store.putRun(run);
    if (managed) {
      moveTaskNode(store, f.runId, node(id), 'queued');
      moveTaskNode(store, f.runId, node(id), 'running', { runId: run.id, dependencies: [] });
    }
    return run;
  };
  return { ...f, store, main, host, check, context, node, child, wait };
}

describe('lean-team task graph completion', () => {
  it('returns self-work feedback before waiting for live nodes or running host acceptance', async () => {
    const f = team();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'mine', owner: 'self', goal: 'finish main work' }, { id: 'other', goal: 'independent work' }] });
    f.child('other');
    const validator = vi.fn(() => ({ passed: true }));
    f.app.coordinator.setCompletionValidator(f.runId, validator);
    expect(await f.check()).toEqual({ kind: 'continue' });
    expect(f.context().at(-1)?.content).toContain('TASK_GRAPH_INCOMPLETE');
    expect(f.context().at(-1)?.content).toContain('mine');
    expect(f.wait).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
    expect(f.store.countEvents(f.runId, { types: ['completion.checked'], match: { passed: false } })).toBe(1);
  });

  it('durably waits on unstarted and integrating nodes without consuming correction attempts', async () => {
    const f = team();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'first', goal: 'integrating' }, { id: 'queued', goal: 'queued' }, { id: 'next', goal: 'dependent', after: ['first'] }] });
    const child = f.child('first', 'completed');
    recordTaskRunOutcome(f.store, f.runId, 'first', child.id, { status: 'completed', integrate: true, finalText: 'Done.' });
    moveTaskNode(f.store, f.runId, f.node('queued'), 'queued');
    for (let attempt = 0; attempt < 4; attempt++) {
      const outcome = await f.check();
      expect(outcome.kind).toBe('wait');
      if (outcome.kind !== 'wait') throw new Error('expected wait');
      expect(f.store.wait(outcome.waitId)).toMatchObject({ status: 'registered', mode: 'all', eventDriven: true });
      f.store.putWait({ ...f.store.wait(outcome.waitId), status: 'settled', reason: 'synthetic progress' });
    }
    expect(f.wait).toHaveBeenLastCalledWith(expect.objectContaining({ id: f.runId }), ['first', 'queued', 'next'], 'all');
    expect(f.store.events(f.runId, { types: ['completion.checked', 'completion.correction_requested'] })).toHaveLength(0);
    expect(f.store.events(f.runId, { types: ['completion.deferred'] })).toHaveLength(4);
    expect(f.context().at(-1)?.content).toContain('task nodes');
  });

  it('does not wait forever behind an acknowledged failed prerequisite', async () => {
    const f = team();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'failed', goal: 'upstream' }, { id: 'after', goal: 'downstream', after: ['failed'] }, { id: 'live', goal: 'independent' }] });
    const child = f.child('failed', 'failed');
    recordTaskRunOutcome(f.store, f.runId, 'failed', child.id, { status: 'failed', integrate: false });
    acknowledgeTaskFailure(f.store, f.runId, 'failed');
    f.child('live');
    expect((await f.check()).kind).toBe('continue');
    expect(f.context().at(-1)?.content).toContain('after');
    expect(f.context().at(-1)?.content).toContain('blocked by failed');
    expect(f.wait).not.toHaveBeenCalled();
  });

  it('accepts inspected graph failures without requiring hidden legacy inspect_run', async () => {
    const f = team();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'failed', goal: 'bounded task' }] });
    const child = f.child('failed', 'failed');
    recordTaskRunOutcome(f.store, f.runId, 'failed', child.id, { status: 'failed', integrate: false });
    expect((await f.check()).kind).toBe('continue');
    acknowledgeTaskFailure(f.store, f.runId, 'failed');
    expect(childCompletionState(f.store, f.main()).feedback).toBeUndefined();
    const outcome = await f.check();
    expect(outcome).toMatchObject({ kind: 'complete', taskGraphStamp: taskGraphCompletionState(f.store, f.runId).fingerprint });
  });

  it('gives one durable opportunity to disclose dropped work, without a quality correction', async () => {
    const f = team();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'optional', goal: 'optional task' }] });
    const child = f.child('optional', 'cancelled');
    dropTask(f.store, f.runId, 'optional', 'No longer requested.');
    expect(childCompletionState(f.store, f.main()).active).not.toContain(child.id);
    expect(await f.check()).toEqual({ kind: 'continue' });
    expect(f.context().at(-1)?.content).toContain('optional: No longer requested.');
    expect(f.store.events(f.runId, { types: ['completion.checked', 'completion.correction_requested'] })).toHaveLength(0);
    const outcome = await f.check();
    expect(outcome.kind).toBe('complete');
    if (outcome.kind !== 'complete') throw new Error('expected completion');
    expect(f.store.readBlob(outcome.resultRef)).toMatchObject({ taskGraph: { dropped: [{ id: 'optional', reason: 'No longer requested.' }] } });
    expect((await f.check()).kind).toBe('complete');
    expect(f.store.events(f.runId, { types: ['completion.task_disclosure'] })).toHaveLength(1);
  });

  it('still enforces lifecycle checks for a legacy child in a team session', async () => {
    const f = team();
    const child = f.child('legacy', 'failed', false);
    expect((await f.check()).kind).toBe('continue');
    expect(f.context().at(-1)?.content).toContain(child.id);
    expect(f.context().at(-1)?.content).toContain('failed children');
  });

  it('returns the pre-acceptance graph stamp so terminal recheck rejects later declarations', async () => {
    const f = team();
    const accepted = taskGraphCompletionState(f.store, f.runId).fingerprint;
    f.app.coordinator.setCompletionValidator(f.runId, () => {
      declareTasks(f.store, f.runId, { tasks: [{ id: 'late', owner: 'self', goal: 'new work during acceptance' }] });
      return { passed: true };
    });
    const outcome = await f.check();
    expect(outcome).toMatchObject({ kind: 'complete', taskGraphStamp: accepted });
    if (outcome.kind !== 'complete') throw new Error('expected candidate completion');
    expect(taskGraphTerminalCheck(f.store, f.runId, outcome.taskGraphStamp!).valid).toBe(false);
  });

  it('turns a stale completed dependency reference into feedback rather than an invalidation loop', async () => {
    const f = team();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'base', owner: 'self', goal: 'base' }, { id: 'dependent', owner: 'self', goal: 'consumer', after: ['base'] }] });
    moveTaskNode(f.store, f.runId, f.node('base'), 'done');
    moveTaskNode(f.store, f.runId, f.node('dependent'), 'done', { dependencies: [{ id: 'base', generation: 1 }] });
    writeTaskNode(f.store, f.runId, { ...f.node('base'), generation: 2 });
    expect((await f.check()).kind).toBe('continue');
    expect(f.context().at(-1)?.content).toContain('superseded prerequisite generation');
    expect(f.wait).not.toHaveBeenCalled();
  });
});
