import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Application } from '../src/application/index.js';
import type { Provider, Run } from '../src/runtime/types.js';
import { readTaskGraph } from '../src/runtime/task-graph.js';
import { freezeTaskWorkspace, repositoryRoot, sharedScopeHolder, taskWorkspaceMode } from '../src/runtime/task-workspace.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

type Request = Parameters<Provider['complete']>[0];
function owner(app: Application, request: Request): Run {
  const id = /Run ID: ([^. ]+)\./u.exec(request.messages.find(message => message.role === 'system')?.content ?? '')?.[1];
  if (!id) throw new Error('missing run identity');
  return app.store.run(id);
}
const toolResult = (request: Request, id: string): string => request.messages.find(message => message.role === 'tool' && message.tool_call_id === id)?.content ?? '';
const team = (provider: Provider, capacity = 3) => {
  const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
  const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
  f.app.store.putSession({ ...session, budget: { ...session.budget, maxConcurrentModels: 4, maxActiveChildren: capacity } });
  return f;
};

describe('lean team shared-workspace fallback (6.7)', () => {
  it('detects repository roots and freezes the mode with the first declaration', () => {
    const f = team(scripted(answer()));
    expect(repositoryRoot(f.root)).toBe(false);
    expect(freezeTaskWorkspace(f.app.store, f.runId, f.root)).toBe('shared');
    // A repository created later never switches an existing graph back to snapshots.
    execFileSync('git', ['init', '-q'], { cwd: f.root, windowsHide: true });
    expect(repositoryRoot(f.root)).toBe(true);
    expect(freezeTaskWorkspace(f.app.store, f.runId, f.root)).toBe('shared');
    expect(taskWorkspaceMode(f.app.store, f.runId)).toBe('shared');
    const nested = path.join(f.root, 'nested');
    mkdirSync(nested);
    expect(repositoryRoot(nested)).toBe(false);
  });

  it('holds only writers whose scopes overlap an active writer', () => {
    const node = (id: string, scope?: string[], role?: string) => ({ id, goal: id, owner: 'agent' as const, after: [], order: 0, state: 'queued' as const, generation: 1, ...(scope ? { scope } : {}), ...(role ? { role } : {}) });
    const active = [node('a', ['src/a'])];
    expect(sharedScopeHolder(node('b', ['src/a/one.ts']), active)).toBe('a');
    expect(sharedScopeHolder(node('c', ['src/c']), active)).toBeUndefined();
    expect(sharedScopeHolder(node('r', undefined, 'reviewer'), active)).toBeUndefined();
    expect(sharedScopeHolder(node('d', ['src/a']), [node('x', undefined, 'explorer')])).toBeUndefined();
  });

  it('requires scope, writes directly, serializes overlapping scopes and refuses main writes into an active scope', async () => {
    let releaseChild!: () => void, childStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseChild = resolve; });
    const started = new Promise<void>(resolve => { childStarted = resolve; });
    const active = new Set<string>(), overlaps: string[][] = [];
    let mainTurns = 0, delegated = '';
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        const turn = mainTurns++;
        if (turn === 0) return calls(call('delegate', { tasks: [{ id: 'a', goal: 'Write a' }] }, 'd0'));
        if (turn === 1) {
          expect(toolResult(request, 'd0')).toContain('scope is required because child tasks share the workspace');
          expect(readTaskGraph(f.app.store, run.id).nodes).toHaveLength(0);
          return calls(call('delegate', { tasks: [
            { id: 'a', goal: 'Write a', scope: ['a.txt'] }, { id: 'b', goal: 'Rewrite a', scope: ['a.txt'] },
            { id: 'c', goal: 'Write c', scope: ['c.txt'] }, { id: 'look', role: 'reviewer', goal: 'Review the files' },
          ] }, 'd1'));
        }
        if (turn === 2) {
          delegated = toolResult(request, 'd1');
          await started;
          return calls(call('write', { path: 'a.txt', content: 'main\n' }, 'w1'));
        }
        if (turn === 3) {
          const refused = toolResult(request, 'w1');
          releaseChild();
          expect(refused).toMatch(/TODO_DELEGATED: target overlaps active child/u);
          return calls(call('task', { action: 'wait', node_ids: ['a', 'b', 'c', 'look'], mode: 'all' }, 'wait'));
        }
        return answer('All shared tasks finished.');
      }
      const id = run.taskNode!.nodeId;
      expect(run.execution).toBeUndefined();
      if (id === 'look') {
        expect(request.tools.map(tool => tool.name)).not.toContain('bash');
        return answer('Reviewed.');
      }
      if (id === 'b' && run.step === 0) {
        // b starts only after a settled, so it sees a's result and must read it before rewriting it.
        expect(active.has('a')).toBe(false);
        return calls(call('read', { path: 'a.txt' }));
      }
      if (run.step === (id === 'b' ? 1 : 0)) {
        if (id === 'b') expect(toolResult(request, 'read')).toContain('a');
        active.add(id);
        overlaps.push([...active].sort());
        if (id === 'a') { childStarted(); await gate; }
        else await new Promise(resolve => setTimeout(resolve, 40));
        active.delete(id);
        return calls(call('write', { path: `${id === 'b' ? 'a' : id}.txt`, content: `${id}\n` }));
      }
      return answer(`${id} done`);
    } };
    const f = team(provider);
    writeFileSync(path.join(f.root, 'base.txt'), 'not a repository\n');
    const result = await f.app.coordinator.drive(f.runId);
    expect(result.status, result.error).toBe('completed');
    const reply = JSON.parse(delegated) as { workspaceMode: string; note: string };
    expect(reply.workspaceMode).toBe('shared');
    expect(reply.note).toContain('Shared workspace mode');
    expect(readTaskGraph(f.app.store, f.runId).nodes.map(node => node.state)).toEqual(['done', 'done', 'done', 'done']);
    // b overlaps a and starts only after a finished, so it overwrites a's result.
    expect(readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('b\n');
    expect(readFileSync(path.join(f.root, 'c.txt'), 'utf8')).toBe('c\n');
    expect(overlaps.some(set => set.includes('a') && set.includes('c'))).toBe(true);
    expect(overlaps.some(set => set.includes('a') && set.includes('b'))).toBe(false);
    const children = f.app.store.listRuns(result.sessionId).filter(run => run.parentId);
    expect(children.every(run => !run.execution)).toBe(true);
    expect(children.find(run => run.taskNode?.nodeId === 'look')!.permissions).toEqual(['read']);
    for (const type of ['execution.snapshot', 'task.delivery', 'execution.integrated']) expect(f.app.store.events(f.runId, { types: [type] })).toHaveLength(0);
  }, 120_000);
});
