import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Provider } from '../src/runtime/types.js';
import { todoMessage } from '../src/runtime/context-progress.js';
import { readTodoSnapshot } from '../src/tools/todo.js';
import { answer, call, calls, fixture } from './helpers.js';

describe('simple coding workflow through the coordinator', () => {
  it('overlaps independent implementation and admits the join only after acceptance', async () => {
    const names = new Map<string, string>(), turns = new Map<string, number>();
    let entered = 0, overlapping = 0, maximumOverlap = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>(resolve => { release = resolve; });
    const provider: Provider = { async complete(request) {
      const id = /Run ID: ([^.]+)\./u.exec(request.messages[0]!.content!)![1]!;
      const run = app.store.run(id);
      if (id === mainId) {
        const snapshot = readTodoSnapshot(app.store, mainId);
        const completed = [...names].filter(([child, name]) => app.store.run(child).status === 'completed' && snapshot.items.find(item => item.id === name)?.status !== 'completed');
        if (completed.length) return calls(call('todo.write', { expectedRevision: snapshot.revision, updates: completed.map(([, name]) => ({ id: name, status: 'completed', note: 'Checked the delivered file and recorded outcome.' })) }, `accept-${snapshot.revision}`));
        const remaining = [...names.keys()].filter(child => app.store.run(child).status !== 'completed');
        if (remaining.length) return calls(call('wait_for_events', { run_ids: remaining, mode: 'all' }, `wait-${snapshot.revision}`));
        return answer('Independent files and joined result delivered.');
      }
      const name = names.get(id)!;
      const turn = turns.get(id) ?? 0;
      turns.set(id, turn + 1);
      if (turn) return answer(`${name} file delivered.`);
      if (name !== 'join') {
        entered++; overlapping++; maximumOverlap = Math.max(maximumOverlap, overlapping);
        if (entered === 2) release();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([bothStarted, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('independent tasks did not overlap')), 5000); })]);
        } finally { clearTimeout(timer); overlapping--; }
      } else {
        const plan = readTodoSnapshot(app.store, mainId);
        expect(plan.items.filter(item => item.id !== 'join').every(item => item.status === 'completed')).toBe(true);
        expect(run.todo?.dependencies).toHaveLength(2);
        expect(readFileSync(path.join(root, 'left.txt'), 'utf8')).toBe('left');
        expect(readFileSync(path.join(root, 'right.txt'), 'utf8')).toBe('right');
      }
      return calls(call('file.apply_patch', { path: `${name}.txt`, expectedHash: null, content: name === 'join' ? 'left+right' : name }, `write-${name}`));
    } };
    const { app, root, runId: mainId } = fixture(provider, ['read', 'write', 'exec'], { taskProtocol: 3, toolProfile: 'compact-v2', instructions: { global: false }, agentFactors: { A: true, B: true, C: true, D: true, E: true } });
    await app.coordinator.tools.execute(mainId, 'todo.write', { expectedRevision: 0, updates: [
      { id: 'left', content: 'Create left.txt', status: 'in_progress', executor: 'agent' },
      { id: 'right', content: 'Create right.txt', status: 'in_progress', executor: 'agent' },
      { id: 'join', content: 'Join the two accepted files', status: 'pending', executor: 'agent', dependsOn: ['left', 'right'] },
    ] }, new AbortController().signal);
    for (const name of ['left', 'right', 'join']) {
      const child = app.spawnAgent(app.store.run(mainId).sessionId, { objective: `Create ${name}.txt using the assigned input files.`, scope: { read: ['.'], write: [`${name}.txt`] } });
      names.set(child.id, name);
    }
    const result = await app.run(mainId);
    expect(result.status, result.error).toBe('completed');
    expect(maximumOverlap).toBe(2);
    expect(readFileSync(path.join(root, 'join.txt'), 'utf8')).toBe('left+right');
    expect(readTodoSnapshot(app.store, mainId).items.every(item => item.status === 'completed')).toBe(true);
    for (const id of names.keys()) {
      const notices = app.store.messages(result.sessionId).filter(message => message.id === `terminal:${id}`);
      expect(notices).toHaveLength(1);
    }
  });

  it('bounds graph notes and dependencies in repeated context snapshots', () => {
    const dependencies = Array.from({ length: 30 }, (_, index) => `input-${index}`);
    const message = todoMessage({ ownerRunId: 'root', revision: 1, acceptedDependencies: {}, items: [{ id: 'build', content: 'Build the result', status: 'pending', title: 'Implementation', note: 'details '.repeat(120), dependsOn: dependencies }] });
    const view = JSON.parse(message.content!.slice(message.content!.indexOf('{')));
    expect(view.items[0].note.length).toBeLessThan(200);
    expect(view.items[0].dependsOn).toHaveLength(8);
    expect(view.items[0].omittedDependencies).toBe(22);
    expect(view.readFullListWith).toBe('todo.read({full:true})');
  });
});
