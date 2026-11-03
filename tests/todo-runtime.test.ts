import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Provider } from '../src/runtime/types.js';
import { attachmentBody, attachmentKind } from '../src/runtime/attachments.js';
import { todoDispatchState } from '../src/tools/todo.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

const item = { id: 'implement', content: 'Write the result', executor: 'agent', status: 'in_progress' };
const write = (filename: string) => call('file.apply_patch', { path: filename, expectedHash: null, content: 'child evidence' }, filename);
const plan = (expectedRevision: number, items: unknown[]) => call('todo.write', { expectedRevision, items }, `plan-${expectedRevision}`);

describe('todo execution ownership in the model loop', () => {
  it('permits model dispatch without a selected agent todo and waits for the unlinked child', async () => {
    const { app, runId } = fixture(scripted(
      calls(call('spawn_agent', { objective: 'Unlinked bounded task', permissions: ['read'] })),
      async request => {
        expect(request.messages.findLast(message => message.role === 'tool')?.content).not.toContain('TODO_DISPATCH_REQUIRED');
        return answer('Candidate before child completion.');
      },
      answer('Child completed.'),
      answer('Unlinked task completed.'),
    ), undefined, { agentFactors: { B: true } });
    expect((await app.coordinator.wake(runId)).status).toBe('waiting');
    const child = app.store.listRuns(app.store.run(runId).sessionId).find(run => run.parentId === runId)!;
    expect(child).toBeDefined();
    expect(app.store.events(runId, { types: ['todo.dispatched'] })).toHaveLength(0);
    expect(app.store.events(runId, { types: ['completion.checked'] })).toHaveLength(0);
    expect((await app.coordinator.wake(child.id)).status).toBe('completed');
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.run(child.id).status).toBe('completed');
  });

  it('appends task-list updates after history so earlier request bytes stay a cache prefix', async () => {
    // FastAPI run requests 14, 64 and 70 lost the provider cache after todo.write moved the list before the first assistant turn.
    const seen: string[][] = [];
    const record = (messages: { role: string; content?: string | null }[]) => seen.push(messages.slice(0, -1).map(message => JSON.stringify(message)));
    const { app, runId } = fixture(scripted(
      calls(plan(0, [{ id: 'a', content: 'First phase', status: 'in_progress', executor: 'main' }])),
      async request => { record(request.messages); return calls(plan(1, [{ id: 'a', content: 'First phase', status: 'completed', executor: 'main' }, { id: 'b', content: 'Second phase', status: 'in_progress', executor: 'main' }])); },
      async request => { record(request.messages); return answer('Both phases are done.'); },
    ));
    expect((await app.run(runId)).status).toBe('completed');
    const [before, after] = seen as [string[], string[]];
    // Everything sent before the update, except the per-request state frame, is resent unchanged.
    expect(after.slice(0, before.length)).toEqual(before);
    const lists = after.filter(message => message.includes('Current run task list'));
    expect(lists).toHaveLength(2);
    expect(lists.at(-1)).toContain('Second phase');
  });

  it('lets a small team-lead task execute directly without a task list', async () => {
    const { app, root, runId } = fixture(scripted(
      calls(write('direct.txt')),
      async request => {
        expect(request.messages.findLast(message => message.role === 'tool')?.content).not.toContain('TODO_PLAN_REQUIRED');
        return answer('The small change is ready.');
      },
    ), undefined, { agentFactors: { B: true } });
    expect((await app.run(runId)).status).toBe('completed');
    expect(readFileSync(path.join(root, 'direct.txt'), 'utf8')).toBe('child evidence');
  });

  it('requires an owner while a recorded plan has open work and honors a main assignment in the same response', async () => {
    const { app, root, runId } = fixture(scripted(
      calls(plan(0, [{ ...item, executor: 'main', status: 'pending' }]), write('unplanned.txt')),
      async request => {
        expect(request.messages.findLast(message => message.role === 'tool')?.content).toContain('TODO_PLAN_REQUIRED');
        return calls(plan(1, [{ ...item, executor: 'main' }]), write('main.txt'));
      },
      answer('A small integration change is ready.'),
    ), undefined, { agentFactors: { B: true } });
    const result = await app.run(runId);
    expect(result.status).toBe('completed');
    expect(existsSync(path.join(root, 'unplanned.txt'))).toBe(false);
    expect(readFileSync(path.join(root, 'main.txt'), 'utf8')).toBe('child evidence');
  });

  it('links actual child execution, denies direct work and early acceptance, then accepts inspected evidence', async () => {
    let childId = '';
    let mainStep = 0;
    const provider: Provider = { async complete(request) {
      const id = /Run ID: ([^. ]+)\./u.exec(request.messages[0]!.content!)![1]!;
      const run = app.store.run(id);
      if (run.parentId) return run.step === 0 ? calls(write('result.txt')) : answer('Created result.txt; inspect the successful file write.');
      const frame = JSON.parse(attachmentBody(request.messages.findLast(message => attachmentKind(message) === 'state')!));
      switch (mainStep++) {
        case 0: return calls(plan(0, [item]), write('wrong-owner.txt'));
        case 1:
          expect(frame.todoDispatch[0].state).toBe('awaiting_dispatch');
          expect(request.messages.findLast(message => message.role === 'tool')?.content).toContain('TODO_DELEGATED');
          expect(request.tools.some(tool => tool.name === 'file.apply_patch')).toBe(true);
          return calls(plan(1, [{ ...item, status: 'completed' }]), call('spawn_agent', { objective: 'Create result.txt containing child evidence', scope: { write: ['result.txt'] } }, 'spawn'));
        case 2:
          expect(request.messages.filter(message => message.role === 'tool').some(message => message.content.includes('TODO_ACCEPTANCE'))).toBe(true);
          childId = app.store.listRuns(run.sessionId).find(child => child.parentId === run.id)!.id;
          return calls(call('wait_for_events', { run_ids: [childId], mode: 'all' }));
        case 3:
          expect(frame.todoDispatch[0].state).toBe('awaiting_acceptance');
          return calls(call('inspect_run', { run_id: childId }));
        case 4:
          expect(request.messages.findLast(message => message.role === 'tool')?.content).toContain('result.txt');
          return calls(plan(1, [{ ...item, status: 'completed' }]));
        default: return answer('Accepted the child result after inspecting its evidence.');
      }
    } };
    const { app, root, runId } = fixture(provider, undefined, { agentFactors: { B: true }, instructions: { global: false } });
    const result = await app.run(runId);
    expect(result.status).toBe('completed');
    expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('child evidence');
    expect(existsSync(path.join(root, 'wrong-owner.txt'))).toBe(false);
    expect(todoDispatchState(app.store, runId)).toMatchObject([{ id: item.id, state: 'completed', runIds: [childId] }]);
  });

  it('does not complete a run with an undispatched delegated todo', async () => {
    const { app, runId } = fixture(scripted(calls(plan(0, [item])), answer('done'), answer('done'), answer('done')),
      undefined, { agentFactors: { B: true } });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('TODO_INCOMPLETE');
    expect(app.store.events(runId, { types: ['completion.correction_requested'] })).toHaveLength(2);
  });

  it('applies delegated ownership even with B disabled, including read-only shell execution', async () => {
    const { app, runId } = fixture(scripted(
      calls(plan(0, [item]), call('shell.exec', { command: 'git status --short' })),
      async request => {
        expect(request.messages.findLast(message => message.role === 'tool')?.content).toContain('TODO_DELEGATED');
        return calls(plan(1, []));
      },
      answer('Obsolete task removed without dispatch.'),
    ), ['read', 'write', 'exec'], { agentFactors: { B: false } });
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.events(runId, { types: ['tool.started'] }).some(event => event.data.name === 'shell.exec')).toBe(false);
  });
});
