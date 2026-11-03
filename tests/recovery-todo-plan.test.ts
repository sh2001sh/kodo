import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { carryRecoveryTodo, readTodoSnapshot, todoDispatchState, todoCompletionFeedback } from '../src/tools/todo.js';
import { todoExecutionFeedback } from '../src/runtime/todo-execution.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

describe('task plans across audited effect recovery', () => {
  it('retains the original main plan before an authorized retry without repeating an applied effect', async () => {
    const items = [{ id: 'write', content: 'Write and verify the recovery marker', status: 'in_progress' as const, executor: 'main' as const }];
    const { app, root, runId } = fixture(scripted(
      calls(call('file.apply_patch', { path: 'marker.txt', expectedHash: null, content: 'written once' }, 'write')),
      answer('The write needs reconciliation.'),
      async request => {
        const recovered = app.store.listRuns().find(run => run.continuationOf === runId)!;
        expect(readFileSync(path.join(root, 'marker.txt'), 'utf8')).toBe('written once');
        expect(readTodoSnapshot(app.store, recovered.id)).toMatchObject({ ownerRunId: recovered.id, revision: 1, items });
        expect(JSON.stringify(request.messages)).not.toContain('TODO_PLAN_REQUIRED');
        return calls(call('todo.write', { expectedRevision: 1, items: [{ ...items[0]!, status: 'completed' }] }));
      },
      answer('Recovered and verified.'),
    ), ['read', 'write'], { agentFactors: { B: true } });
    await app.coordinator.tools.execute(runId, 'todo.write', { expectedRevision: 0, items }, new AbortController().signal);
    const execute = app.coordinator.tools.execute.bind(app.coordinator.tools);
    let attempts = 0;
    vi.spyOn(app.coordinator.tools, 'execute').mockImplementation(async (...input) => {
      if (input[1] === 'file.apply_patch' && attempts++ === 0) {
        input[4]?.();
        throw new Error('fixture lost the write response before applying the marker');
      }
      return await execute(...input);
    });
    const source = await app.run(runId);
    expect(source).toMatchObject({ status: 'failed', error: expect.stringMatching(/^UNKNOWN_WRITE:/) });
    expect(existsSync(path.join(root, 'marker.txt'))).toBe(false);
    const original = app.store.calls(runId).find(call => call.name === 'file.apply_patch')!;
    expect((await app.reconcile(runId)).resolutions).toMatchObject([{ outcome: 'not_applied', retryAuthorized: true }]);
    const recovered = await app.recover(runId);
    expect(recovered.status, recovered.error).toBe('completed');
    expect(attempts).toBe(2);
    expect(app.store.calls(recovered.id).filter(call => call.name === 'file.apply_patch' && call.status === 'succeeded')).toHaveLength(1);
    expect(readTodoSnapshot(app.store, recovered.id)).toMatchObject({ revision: 2, items: [{ ...items[0]!, status: 'completed' }] });
    expect(readTodoSnapshot(app.store, runId)).toMatchObject({ revision: 1, items });
    expect(app.store.run(runId)).toEqual(source);
    expect(app.store.call(original.id)).toEqual(original);
  });

  it('preserves delegated work and its replacement identity without transferring plans to ordinary followups', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write'], { agentFactors: { B: true } });
    const items = [{ id: 'review', content: 'Review the original evidence', status: 'in_progress' as const, executor: 'agent' as const }];
    await app.coordinator.tools.execute(runId, 'todo.write', { expectedRevision: 0, items }, new AbortController().signal);
    const child = app.coordinator.mailbox.spawnHost(runId, { objective: 'Review evidence', permissions: ['read'] }).id as string;
    const source = app.store.updateRun(runId, { status: 'failed', error: 'UNKNOWN_WRITE: fixture recovery' });
    const targetId = 'recovered-plan';
    const replacementChildId = 'recovered-child';
    app.store.putRun({ ...source, id: targetId, continuationOf: runId, status: 'queued', error: undefined });
    app.store.putRun({ ...app.store.run(child), id: replacementChildId, parentId: targetId, status: 'queued' });
    app.store.updateRun(child, { status: 'failed' });
    app.store.event(runId, 'recovery.continued', { runId: targetId });
    app.store.transaction(() => carryRecoveryTodo(app.store, runId, targetId, new Map([[runId, targetId], [child, replacementChildId]])));
    expect(todoDispatchState(app.store, targetId)).toMatchObject([{ id: 'review', generation: 1, state: 'running', runIds: [replacementChildId] }]);
    expect(todoCompletionFeedback(app.store, targetId)).toContain(replacementChildId);
    expect(todoExecutionFeedback(app.store, app.store.run(targetId), 'file.apply_patch', 'write')).toMatch(/^TODO_DELEGATED:/);
    await expect(app.coordinator.tools.execute(targetId, 'todo.write', { expectedRevision: 1, items: [{ ...items[0]!, executor: 'main' }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'TODO_ACTIVE' });
    await expect(app.coordinator.tools.execute(targetId, 'todo.write', { expectedRevision: 1, items: [{ ...items[0]!, status: 'completed' }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'TODO_ACCEPTANCE' });
    const next = app.submitInput(runId, 'A separate ordinary task');
    expect(readTodoSnapshot(app.store, next.id).revision).toBe(0);
    // The followup starts without the source plan, so a direct small task needs no new list.
    expect(todoExecutionFeedback(app.store, next, 'file.apply_patch', 'write')).toBeUndefined();
    expect(() => carryRecoveryTodo(app.store, runId, next.id, new Map())).toThrow('audited same-session recovery');
  });
});
