import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { answer, call, calls, fixture, scripted } from './helpers.js';

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
      calls(plan(0, [{ id: 'a', content: 'First phase', status: 'in_progress' }])),
      async request => { record(request.messages); return calls(plan(1, [{ id: 'a', content: 'First phase', status: 'completed' }, { id: 'b', content: 'Second phase', status: 'in_progress' }])); },
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

  it('treats the plan as guidance: open items neither block writes nor completion', async () => {
    const { app, root, runId } = fixture(scripted(
      calls(plan(0, [{ id: 'a', content: 'First phase', status: 'pending' }, { id: 'b', content: 'Second phase', status: 'in_progress' }]), write('free.txt')),
      async request => {
        expect(request.messages.findLast(message => message.role === 'tool')?.content).not.toContain('TODO_');
        return answer('The change is ready; the remaining plan item is out of scope.');
      },
    ), undefined, { agentFactors: { B: true } });
    expect((await app.run(runId)).status).toBe('completed');
    expect(readFileSync(path.join(root, 'free.txt'), 'utf8')).toBe('child evidence');
    expect(app.store.events(runId, { types: ['todo.dispatched'] })).toHaveLength(0);
  });
});
