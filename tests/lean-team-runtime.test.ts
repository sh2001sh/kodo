import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Application } from '../src/application/index.js';
import type { Provider, Run } from '../src/runtime/types.js';
import { readTaskGraph } from '../src/runtime/task-graph.js';
import { answer, call, calls, fixture } from './helpers.js';

type Request = Parameters<Provider['complete']>[0];
function owner(app: Application, request: Request): Run {
  const id = /Run ID: ([^. ]+)\./u.exec(request.messages.find(message => message.role === 'system')?.content ?? '')?.[1];
  if (!id) throw new Error('missing run identity');
  return app.store.run(id);
}
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
function repository(root: string): void {
  git(root, 'init', '-q');
  writeFileSync(path.join(root, 'base.txt'), 'baseline\n');
  git(root, 'add', 'base.txt'); git(root, 'commit', '-q', '-m', 'baseline');
  writeFileSync(path.join(root, 'base.txt'), 'uncommitted parent change\n');
}

describe('lean team through the real coordinator', () => {
  it.each([1, 3])('honors capacity %i, integrates before dependants, and preserves the parent index', async capacity => {
    const seen = new Map<string, number>();
    let active = 0, peak = 0;
    let arrivals = 0, release!: () => void;
    const firstWave = new Promise<void>(resolve => { release = resolve; });
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request), turn = seen.get(run.id) ?? 0;
      seen.set(run.id, turn + 1);
      if (!run.parentId) {
        if (turn === 0) return calls(call('delegate', { tasks: [
          { id: 'one', goal: 'Write one', scope: ['one.txt'] }, { id: 'two', goal: 'Write two', scope: ['two.txt'] },
          { id: 'three', goal: 'Write three', scope: ['three.txt'] },
          { id: 'joined', goal: 'Read all changes and write joined', scope: ['joined.txt'], after: ['one', 'two', 'three'] },
        ] }));
        if (turn === 1) return calls(call('task', { action: 'wait', node_ids: ['one', 'two', 'three', 'joined'], mode: 'all' }));
        return answer('All three files integrated and checked.');
      }
      const id = run.taskNode!.nodeId;
      expect(request.tools.some(tool => ['delegate', 'task', 'report.submit'].includes(tool.name))).toBe(false);
      const packet = request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
      expect(packet).toContain('captured workspace snapshot');
      expect(packet).toContain('The host checks, commits and integrates');
      expect(packet).not.toContain('Use workspace.commit');
      expect(packet).not.toContain('committed baseline only');
      if (turn === 0) {
        active++; peak = Math.max(active, peak);
        if (id !== 'joined') {
          if (++arrivals === capacity) release();
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([firstWave, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('independent child models did not enter concurrently')), 10_000); })]); }
          finally { clearTimeout(deadline); }
        }
        active--;
        if (id === 'joined') {
          expect(readFileSync(path.join(run.execution!.root, 'one.txt'), 'utf8')).toBe('one\n');
          expect(readFileSync(path.join(run.execution!.root, 'two.txt'), 'utf8')).toBe('two\n');
          expect(readFileSync(path.join(run.execution!.root, 'three.txt'), 'utf8')).toBe('three\n');
        }
        return calls(call('write', { path: `${id}.txt`, content: `${id}\n` }));
      }
      return answer(`${id} done`);
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
    f.app.store.putSession({ ...session, budget: { ...session.budget, maxConcurrentModels: 3, maxActiveChildren: capacity } });
    repository(f.root);
    const head = git(f.root, 'rev-parse', 'HEAD');
    const result = await f.app.coordinator.drive(f.runId);
    expect(result.status, result.error).toBe('completed');
    expect(peak).toBe(capacity);
    expect(readTaskGraph(f.app.store, f.runId).nodes.map(node => node.state)).toEqual(['done', 'done', 'done', 'done']);
    for (const name of ['one', 'two', 'three', 'joined']) expect(readFileSync(path.join(f.root, `${name}.txt`), 'utf8')).toBe(`${name}\n`);
    expect(readFileSync(path.join(f.root, 'base.txt'), 'utf8')).toBe('uncommitted parent change\n');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(f.root, 'diff', '--cached', '--name-only')).toBe('');
    expect(f.app.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(4);
    expect(f.app.store.events(f.runId, { types: ['execution.session_cleaned'] })).toHaveLength(1);
    expect(f.app.store.listRuns(result.sessionId).filter(run => run.parentId).every(run => !existsSync(run.execution!.root))).toBe(true);
  }, 120_000);

  it('resumes a needs-input task with its checkout and integrates exactly once', async () => {
    let mainTurns = 0;
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        if (mainTurns++ === 0) return calls(call('delegate', { tasks: [{ id: 'edit', goal: 'Create result', scope: ['result.txt'] }] }));
        const node = readTaskGraph(f.app.store, run.id).nodes[0]!;
        if (node.state === 'needs_input') return calls(call('task', { action: 'send', node_id: node.id, input: 'Use the agreed result.' }));
        if (node.state !== 'done') return calls(call('task', { action: 'wait', node_ids: ['edit'] }));
        return answer('Result delivered.');
      }
      if (!run.continuationOf) return answer('NEEDS_INPUT: Which result?');
      return run.step === 0 ? calls(call('write', { path: 'result.txt', content: 'agreed\n' })) : answer('Result created.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
    f.app.store.putSession({ ...session, budget: { ...session.budget, maxActiveChildren: 1 } });
    repository(f.root);
    const result = await f.app.coordinator.drive(f.runId);
    expect(result.status, result.error).toBe('completed');
    const children = f.app.store.listRuns(result.sessionId).filter(run => run.parentId);
    expect(children).toHaveLength(2);
    expect(children[1]!.execution?.root).toBe(children[0]!.execution?.root);
    expect(children[1]!.agentId).toBe(children[0]!.agentId);
    expect(readFileSync(path.join(f.root, 'result.txt'), 'utf8')).toBe('agreed\n');
    expect(f.app.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(1);
  }, 120_000);

  it.each(['resume', 'redo'] as const)('%s updates an already integrated result without replaying its earlier patch', async mode => {
    let mainTurns = 0, continued = false;
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        if (mainTurns++ === 0) return calls(call('delegate', { tasks: [{ id: 'edit', goal: 'Create result', scope: ['result.txt'] }] }));
        const node = readTaskGraph(f.app.store, run.id).nodes[0]!;
        if (node.state === 'done' && !continued) { continued = true; return calls(call('task', { action: mode, node_id: node.id, input: 'Change result to second.' })); }
        if (node.state !== 'done') return calls(call('task', { action: 'wait', node_ids: ['edit'] }));
        return answer('Updated result delivered.');
      }
      if (!run.continuationOf) return run.step === 0 ? calls(call('write', { path: 'result.txt', content: 'first\n' })) : answer('First result.');
      if (run.step === 0) return calls(call('read', { path: 'result.txt' }));
      if (run.step === 1) return calls(call('edit', { path: 'result.txt', edits: [{ oldText: 'first', newText: 'second' }] }));
      return answer('Second result.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    repository(f.root);
    const result = await f.app.coordinator.drive(f.runId);
    expect(result.status, result.error).toBe('completed');
    expect(readFileSync(path.join(f.root, 'result.txt'), 'utf8')).toBe('second\n');
    const children = f.app.store.listRuns(result.sessionId).filter(run => run.parentId);
    expect(children).toHaveLength(2);
    expect(children[0]!.agentId).toBe(children[1]!.agentId);
    expect(children[0]!.execution!.root === children[1]!.execution!.root).toBe(mode === 'resume');
    expect(f.app.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(2);
    expect(readTaskGraph(f.app.store, f.runId).nodes[0]!.generation).toBe(mode === 'resume' ? 1 : 2);
  }, 120_000);

  it('reports an integration conflict without overwriting the accepted sibling, then permits explicit drop', async () => {
    let mainTurns = 0;
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        if (mainTurns++ === 0) return calls(call('delegate', { tasks: ['a', 'b'].map(id => ({ id, goal: `Create competing result ${id}`, scope: ['result.txt'] })) }));
        const graph = readTaskGraph(f.app.store, run.id);
        const conflict = graph.nodes.find(node => node.state === 'conflict');
        if (conflict) return calls(call('task', { action: 'drop', node_id: conflict.id, reason: 'Keep the first integrated result.' }));
        if (graph.nodes.some(node => ['pending', 'queued', 'running', 'integrating'].includes(node.state))) return calls(call('task', { action: 'wait', node_ids: ['a', 'b'], mode: 'all' }));
        return answer('Delivered one result; dropped the conflicting alternative.');
      }
      return run.step === 0 ? calls(call('write', { path: 'result.txt', content: run.taskNode!.nodeId })) : answer('Result ready.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    repository(f.root);
    const result = await f.app.coordinator.drive(f.runId);
    expect(result.status, result.error).toBe('completed');
    expect(readTaskGraph(f.app.store, f.runId).nodes.map(node => node.state).sort()).toEqual(['done', 'dropped']);
    expect(['a', 'b']).toContain(readFileSync(path.join(f.root, 'result.txt'), 'utf8'));
    expect(f.app.store.events(f.runId, { types: ['execution.integration.conflict'] })).toHaveLength(1);
    expect(f.app.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(1);
    expect(f.app.store.events(f.runId, { types: ['completion.task_disclosure'] })).toHaveLength(1);
  }, 120_000);

  it('interrupts a child, releases its active slot, and resumes the retained checkout', async () => {
    let started!: () => void, mainTurns = 0, interrupted = false;
    const childStarted = new Promise<void>(resolve => { started = resolve; });
    const provider: Provider = { async complete(request, signal) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        if (mainTurns++ === 0) return calls(call('delegate', { tasks: [{ id: 'edit', goal: 'Create result', scope: ['result.txt'] }] }));
        if (!interrupted) { await childStarted; interrupted = true; return calls(call('task', { action: 'interrupt', node_id: 'edit' })); }
        const node = readTaskGraph(f.app.store, run.id).nodes[0]!;
        if (node.state === 'failed') return calls(call('task', { action: 'resume', node_id: 'edit', input: 'Continue with a small result.' }));
        if (node.state !== 'done') return calls(call('task', { action: 'wait', node_ids: ['edit'] }));
        return answer('Resumed task delivered.');
      }
      if (!run.continuationOf) {
        started();
        await new Promise<void>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      }
      return run.step === 0 ? calls(call('write', { path: 'result.txt', content: 'resumed\n' })) : answer('Resumed result.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
    f.app.store.putSession({ ...session, budget: { ...session.budget, maxActiveChildren: 1, maxModelCalls: 20 } });
    repository(f.root);
    const result = await f.app.coordinator.drive(f.runId);
    const diagnostic = { error: result.error, nodes: readTaskGraph(f.app.store, f.runId).nodes, calls: f.app.store.calls(f.runId).filter(item => item.kind === 'tool').slice(-3).map(item => ({ name: item.name, result: item.resultRef ? f.app.store.readBlob(item.resultRef) : null })) };
    expect(result.status, JSON.stringify(diagnostic)).toBe('completed');
    const children = f.app.store.listRuns(result.sessionId).filter(run => run.parentId);
    // Session closure cancels the superseded paused source, after its continuation delivered.
    expect(children.map(run => run.status)).toEqual(['cancelled', 'completed']);
    expect(f.app.store.events(children[0]!.id, { types: ['run.interrupted'] })).toHaveLength(1);
    expect(children[0]!.execution!.root).toBe(children[1]!.execution!.root);
    expect(readFileSync(path.join(f.root, 'result.txt'), 'utf8')).toBe('resumed\n');
  }, 120_000);
});
