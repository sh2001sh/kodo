import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { todoTools } from '../src/tools/todo.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolExecutionContext } from '../src/tools/registry.js';
import { binding, fixture, temp } from './helpers.js';

function context(app: Application, runId: string, signal = new AbortController().signal): ToolExecutionContext {
  const run = app.store.run(runId);
  return { run, session: app.store.session(run.sessionId), signal, markEffectStarted() {} };
}
describe('persistent run-owned todo tools', () => {
  it('registers internal planning tools for read-only runs and validates bounded schemas', () => {
    const { app } = fixture();
    const registry = new ToolRegistry();
    for (const tool of todoTools(app.store)) registry.register(tool);
    const write = registry.get('todo.write')!;
    expect(write).toMatchObject({ permission: 'read', effect: 'read' });
    expect(write.validate({ expectedRevision: 0, items: [], runId: 'foreign' })).toBe(false);
    expect(write.validate({ expectedRevision: 0, items: [{ id: 'x', content: 'x', status: 'invalid' }] })).toBe(false);
    expect(write.validate({ expectedRevision: 0, items: Array.from({ length: 101 }, (_, i) => ({ id: String(i), content: 'x', status: 'pending' })) })).toBe(false);
  });
  it('persists complete lists through restart and isolates runs with optimistic concurrency', async () => {
    const root = temp();
    const state = path.join(root, '.state');
    const first = new Application(state, undefined, undefined, { agentFactors: { D: false, E: false, B: false } });
    const run = first.createRun({ objective: 'plan', workspace: root, binding });
    const [read, write] = todoTools(first.store);
    const args = { expectedRevision: 0, items: [{ id: 'inspect', content: 'Inspect source', status: 'in_progress' }] };
    expect(await read!.execute(context(first, run.id), {})).toEqual({ ownerRunId: run.id, revision: 0, items: [] });
    expect(await write!.execute(context(first, run.id), args)).toMatchObject({ revision: 1, items: args.items });
    expect(() => write!.execute(context(first, run.id), args)).toThrow('revision changed');
    const other = first.createRun({ objective: 'other', workspace: root, binding });
    expect(await read!.execute(context(first, other.id), {})).toMatchObject({ revision: 0, items: [] });
    await first.shutdown();
    const second = new Application(state, undefined, undefined, { agentFactors: { D: false, E: false, B: false } });
    try {
      expect(await todoTools(second.store)[0]!.execute(context(second, run.id), {})).toMatchObject({ revision: 1, items: args.items });
      const recovered = await todoTools(second.store)[1]!.recover!({ run: second.store.run(run.id), call: {} as never, request: { id: 'w', name: 'todo.write', arguments: JSON.stringify(args) }, signal: new AbortController().signal });
      expect(recovered).toMatchObject({ outcome: 'succeeded', result: { revision: 1 } });
    } finally { await second.shutdown(); }
  });
  it('rejects duplicate IDs, concurrent active work, blank content, foreign session, and cancellation without mutation', async () => {
    const { app, runId, root } = fixture();
    const [read, write] = todoTools(app.store);
    const item = { id: 'one', content: 'work', status: 'in_progress' };
    for (const items of [[item, item], [item, { ...item, id: 'two' }], [{ ...item, content: '  ' }]]) expect(() => write!.execute(context(app, runId), { expectedRevision: 0, items })).toThrow();
    const foreign = app.createRun({ objective: 'foreign', workspace: root, binding });
    expect(() => write!.execute({ ...context(app, runId), session: app.store.session(foreign.sessionId) }, { expectedRevision: 0, items: [] })).toThrow('different session');
    const controller = new AbortController(); controller.abort();
    expect(() => write!.execute(context(app, runId, controller.signal), { expectedRevision: 0, items: [item] })).toThrow();
    expect(await read!.execute(context(app, runId), {})).toMatchObject({ revision: 0, items: [] });
    app.store.updateRun(runId, { status: 'completed' });
    expect(() => write!.execute(context(app, runId), { expectedRevision: 0, items: [item] })).toThrow('finished run');
  });
});
