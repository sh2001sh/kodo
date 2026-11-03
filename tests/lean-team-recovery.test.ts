import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { carryRecoveryTaskGraphs } from '../src/runtime/task-recovery.js';
import { declareTasks } from '../src/runtime/task-declare.js';
import { moveTaskNode, readTaskGraph, requireTaskNode } from '../src/runtime/task-graph.js';
import { openTaskDispatches, writeTaskDispatchPreparation } from '../src/runtime/task-dispatch-record.js';
import { nodeHasDelivery } from '../src/runtime/task-execution-host.js';
import { managedChild } from '../src/messaging/agent-lifecycle.js';
import { cleanupSessionCheckouts, hostCommitChild, snapshotForChild } from '../src/runtime/execution-lean.js';
import { integrateNode } from '../src/runtime/execution-integration.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

describe('lean task graphs across audited recovery', () => {
  it('carries the active graph through real main-run recovery before executing the verified retry', async () => {
    const { app, root, runId } = fixture(scripted(
      calls(call('delegate', { tasks: [{ id: 'main', owner: 'self', goal: 'Write and verify the marker' }] })),
      calls(call('write', { path: 'marker.txt', content: 'written once' }, 'write')),
      answer('The interrupted write needs recovery.'),
      async () => {
        const recovered = app.store.listRuns().find(run => run.continuationOf === runId)!;
        expect(readFileSync(path.join(root, 'marker.txt'), 'utf8')).toBe('written once');
        expect(readTaskGraph(app.store, recovered.id).nodes).toMatchObject([{ id: 'main', owner: 'self', state: 'pending' }]);
        return calls(call('task', { action: 'done', node_id: 'main' }));
      },
      answer('Recovered and verified the requested file.'),
    ), ['read', 'write'], { toolProfile: 'lean-team', taskProtocol: 3 });
    const execute = app.coordinator.tools.execute.bind(app.coordinator.tools);
    let attempts = 0;
    vi.spyOn(app.coordinator.tools, 'execute').mockImplementation(async (...input) => {
      if (input[1] === 'file.apply_patch' && attempts++ === 0) {
        input[4]?.();
        throw new Error('isolated fixture lost the result before writing');
      }
      return await execute(...input);
    });
    const source = await app.run(runId);
    expect(source).toMatchObject({ status: 'failed', error: expect.stringMatching(/^UNKNOWN_WRITE:/) });
    expect(existsSync(path.join(root, 'marker.txt'))).toBe(false);
    const original = app.store.calls(runId).find(item => item.name === 'file.apply_patch')!;
    app.resolveCall(runId, original.id, { outcome: 'not_applied', retry: true, evidence: 'The isolated fixture failed before writing; marker.txt is confirmed absent.' });
    const recovered = await app.recover(runId);
    expect(recovered.status, recovered.error).toBe('completed');
    expect(attempts).toBe(2);
    expect(readTaskGraph(app.store, recovered.id).nodes).toMatchObject([{ id: 'main', state: 'done' }]);
    expect(readTaskGraph(app.store, runId).nodes).toMatchObject([{ id: 'main', state: 'pending' }]);
    expect(app.store.run(runId)).toEqual(source);
    expect(app.store.call(original.id)).toEqual(original);
  });

  it('preserves finished nodes, delivery evidence, dispatch preparation and release ordering without rewriting terminal runs', () => {
    const { app, runId } = fixture(undefined, ['read'], { toolProfile: 'lean-team', taskProtocol: 3 });
    const store = app.store, source = store.run(runId);
    declareTasks(store, runId, { tasks: [{ id: 'done', goal: 'completed work' }, { id: 'failed', goal: 'failed work' }, { id: 'next', goal: 'queued work', after: ['done'] }] });
    const node = (id: string) => requireTaskNode(readTaskGraph(store, runId), id);
    const doneChild = { ...source, id: 'done-child', parentId: runId, status: 'completed' as const, taskNode: { ownerId: runId, nodeId: 'done', role: 'implementer', generation: 1 } };
    const failedChild = { ...doneChild, id: 'failed-child', status: 'failed' as const, taskNode: { ...doneChild.taskNode, nodeId: 'failed' } };
    store.putRun(doneChild); store.putRun(failedChild);
    for (const id of ['done', 'failed']) {
      moveTaskNode(store, runId, node(id), 'queued');
      moveTaskNode(store, runId, node(id), 'running', { runId: `${id}-child`, dependencies: [] });
      moveTaskNode(store, runId, node(id), id === 'done' ? 'done' : 'failed', { acknowledged: id === 'failed' });
    }
    moveTaskNode(store, runId, node('next'), 'queued');
    store.event(runId, 'task.delivery', { nodeId: 'done', generation: 1, runId: doneChild.id, status: 'applied', version: 'synthetic-version' });
    store.event(runId, 'execution.integrated', { childId: doneChild.id, callId: 'original-host-call', commit: 'synthetic-commit', files: ['result.txt'] });
    store.event(runId, 'execution.integration.planned', { childId: doneChild.id, callId: 'original-host-call', planRef: 'immutable-plan', artifact: 'immutable-artifact' });
    const preparation = { nodeId: 'next', generation: 1, runId: 'prepared-child', checkout: { snapshotRef: 'refs/kodo/snapshots/session/next-1', path: '/isolated/prepared-child' }, reuseCheckout: false, dependencies: [{ id: 'done', generation: 1 }] };
    writeTaskDispatchPreparation(store, runId, preparation);
    store.event(runId, 'execution.snapshot', { nodeId: 'next', generation: 1, childId: preparation.runId, commit: 'snapshot-commit', root: preparation.checkout.path });
    store.event(runId, 'task.release.requested', { nodeId: 'done', generation: 1 });
    const requestSeq = store.latestEvent(runId)!.seq;
    store.event(runId, 'task.release.finished', { requestSeq, nodeId: 'done' });
    const original = store.updateRun(runId, { status: 'failed', error: 'UNKNOWN_WRITE: isolated recovery fixture' });
    const targetId = 'recovered-main';
    const target = { ...original, id: targetId, continuationOf: runId, status: 'queued' as const, error: undefined };
    store.putRun(target); store.event(runId, 'recovery.continued', { runId: targetId });
    const replacements = new Map([[runId, targetId]]);
    carryRecoveryTaskGraphs(store, source.sessionId, replacements);
    expect(readTaskGraph(store, targetId).nodes).toEqual(readTaskGraph(store, runId).nodes);
    expect(nodeHasDelivery(store, target, requireTaskNode(readTaskGraph(store, targetId), 'done'))).toBe(true);
    expect(openTaskDispatches(store, targetId)).toMatchObject([preparation]);
    expect(store.latestEvent(targetId, { types: ['execution.integration.planned'] })!.data).toMatchObject({ childId: doneChild.id, callId: 'original-host-call', planRef: 'immutable-plan', artifact: 'immutable-artifact' });
    const copiedRelease = store.latestEvent(targetId, { types: ['task.release.requested'] })!;
    expect(copiedRelease.seq).not.toBe(requestSeq);
    expect(store.latestEvent(targetId, { types: ['task.release.finished'] })!.data.requestSeq).toBe(copiedRelease.seq);
    expect(managedChild(store, target, doneChild)).toBe(true);
    expect(store.run(runId)).toEqual(original);
    expect(store.run(doneChild.id)).toEqual(doneChild);
    const count = store.events(targetId).length;
    carryRecoveryTaskGraphs(store, source.sessionId, replacements);
    expect(store.events(targetId)).toHaveLength(count);
  });

  it('updates a child-only recovery in the existing graph and keeps its original terminal record', () => {
    const { app, runId } = fixture(undefined, ['read'], { toolProfile: 'lean-team', taskProtocol: 3 });
    const store = app.store, main = store.run(runId);
    declareTasks(store, runId, { tasks: [{ id: 'worker', goal: 'recover child' }] });
    const node = () => requireTaskNode(readTaskGraph(store, runId), 'worker');
    const source = { ...main, id: 'old-child', parentId: runId, status: 'failed' as const, taskNode: { ownerId: runId, nodeId: 'worker', role: 'explorer', generation: 1 } };
    store.putRun(source);
    moveTaskNode(store, runId, node(), 'queued'); moveTaskNode(store, runId, node(), 'running', { runId: source.id }); moveTaskNode(store, runId, node(), 'failed', { reason: 'unknown effect', acknowledged: true });
    store.event(runId, 'task.dispatch.committed', { nodeId: 'worker', generation: 1, runId: source.id });
    const replacement = { ...source, id: 'new-child', continuationOf: source.id, status: 'queued' as const };
    store.putRun(replacement); store.event(source.id, 'recovery.continued', { runId: replacement.id });
    carryRecoveryTaskGraphs(store, main.sessionId, new Map([[source.id, replacement.id]]));
    expect(node()).toMatchObject({ runId: replacement.id, state: 'running', generation: 1, acknowledged: false });
    expect(node().reason).toBeUndefined();
    expect(store.latestEvent(runId, { types: ['task.dispatch.committed'] })!.data.runId).toBe(replacement.id);
    expect(store.run(source.id)).toEqual(source);
  });

  it('reparents replacement and live children together while terminal children stay immutable', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write'], { toolProfile: 'lean-team', taskProtocol: 3 });
    const store = app.store, main = store.run(runId);
    declareTasks(store, runId, { tasks: [{ id: 'worker', goal: 'recover original work' }] });
    const child = { ...main, id: 'old-worker', parentId: runId, taskNode: { ownerId: runId, nodeId: 'worker', role: 'implementer', generation: 1 } };
    const live = { ...child, id: 'live-worker', taskNode: { ...child.taskNode, nodeId: 'live' } };
    store.putRun(child); store.putRun(live);
    const node = () => requireTaskNode(readTaskGraph(store, runId), 'worker');
    moveTaskNode(store, runId, node(), 'queued'); moveTaskNode(store, runId, node(), 'running', { runId: child.id }); moveTaskNode(store, runId, node(), 'failed');
    for (const source of [main, child]) {
      const modelId = `model-${source.id}`, effectId = `${modelId}:write`;
      const request = call('file.apply_patch', { path: 'synthetic.txt', expectedHash: null, content: 'isolated test data' }, 'write');
      store.putCall({ id: modelId, runId: source.id, step: 0, kind: 'model', name: 'complete', status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef: store.blob({}), resultRef: store.blob(calls(request)) });
      store.putCall({ id: effectId, runId: source.id, step: 0, kind: 'tool', name: request.name, status: 'unknown', effect: 'write', effectState: 'started', reservedTokens: 0, requestRef: store.blob(request) });
      store.updateRun(source.id, { status: 'failed', error: 'UNKNOWN_WRITE: isolated recovery state', stepCallId: modelId });
      app.resolveCall(source.id, effectId, { outcome: 'succeeded', evidence: 'The isolated synthetic recovery record is explicitly settled for this transaction test.' });
    }
    const beforeMain = store.run(main.id), beforeChild = store.run(child.id);
    vi.spyOn(app, 'run').mockImplementation(async id => store.run(id));
    const resumed = await app.recover(runId);
    const newChild = store.listRuns(main.sessionId).find(run => run.continuationOf === child.id)!;
    expect(newChild).toMatchObject({ parentId: resumed.id, taskNode: { ownerId: resumed.id, nodeId: 'worker' } });
    expect(store.run(live.id)).toMatchObject({ parentId: resumed.id, taskNode: { ownerId: resumed.id, nodeId: 'live' } });
    expect(readTaskGraph(store, resumed.id).nodes).toMatchObject([{ id: 'worker', runId: newChild.id, state: 'running' }]);
    expect(store.run(main.id)).toEqual(beforeMain);
    expect(store.run(child.id)).toEqual(beforeChild);
  });

  it('reconnects an interrupted child resumed with the same ID', () => {
    const { app, runId } = fixture(undefined, ['read'], { toolProfile: 'lean-team', taskProtocol: 3 });
    const store = app.store, main = store.run(runId);
    declareTasks(store, runId, { tasks: [{ id: 'worker', goal: 'resume after process interruption' }] });
    const child = { ...main, id: 'interrupted-worker', parentId: runId, taskNode: { ownerId: runId, nodeId: 'worker', role: 'explorer', generation: 1 } };
    store.putRun(child);
    const node = () => requireTaskNode(readTaskGraph(store, runId), 'worker');
    moveTaskNode(store, runId, node(), 'queued'); moveTaskNode(store, runId, node(), 'running', { runId: child.id }); moveTaskNode(store, runId, node(), 'failed', { reason: 'child run interrupted' });
    // prepareResume has requeued the same run after recovery verification.
    carryRecoveryTaskGraphs(store, main.sessionId, new Map(), [child.id]);
    expect(node()).toMatchObject({ runId: child.id, state: 'running', acknowledged: false });
    expect(node().reason).toBeUndefined();
  });

  it.each([false, true])('integrates a predecessor child after main recovery with interrupted ancestor=%s', async interruptedAncestor => {
    const { app, root, runId } = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      cwd: root, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    });
    git('init', '-q');
    writeFileSync(path.join(root, '.gitignore'), '.state/\n'); writeFileSync(path.join(root, 'result.txt'), 'original\n');
    git('add', '.'); git('commit', '-q', '-m', 'baseline');
    const store = app.store, tools = app.coordinator.tools, main = store.run(runId);
    const snapshot = await snapshotForChild(store, tools, { main, nodeId: 'worker', generation: 1, childId: 'completed-worker' });
    try {
      const child = { ...main, id: 'completed-worker', parentId: runId, execution: snapshot.execution, status: 'completed' as const,
        taskNode: { ownerId: runId, nodeId: 'worker', role: 'implementer', generation: 1 }, ...(interruptedAncestor ? { continuationOf: 'paused-worker' } : {}) };
      if (interruptedAncestor) store.putRun({ ...child, id: 'paused-worker', status: 'interrupted', continuationOf: undefined });
      store.putRun(child);
      writeFileSync(path.join(child.execution.root, 'result.txt'), 'child result\n');
      expect(hostCommitChild(store, main, child.id).status).toBe('committed');
      const source = store.updateRun(runId, { status: 'failed', error: 'UNKNOWN_WRITE: isolated parent recovery state' });
      const target = { ...source, id: 'recovered-main', continuationOf: runId, status: 'queued' as const, error: undefined };
      store.putRun(target); store.event(runId, 'recovery.continued', { runId: target.id });
      carryRecoveryTaskGraphs(store, main.sessionId, new Map([[runId, target.id]]));
      if (interruptedAncestor) {
        // An interrupted predecessor is retired only after its recorded effects
        // settle; retaining the same checkout is not an unknown-write waiver.
        store.putCall({ id: 'paused-effect', runId: 'paused-worker', step: 0, kind: 'tool', name: 'file.patch', status: 'unknown', effect: 'write', effectState: 'started', reservedTokens: 0,
          requestRef: store.blob(call('file.patch', { path: 'result.txt' }, 'paused-effect')) });
        await expect(integrateNode(store, tools, target, child.id)).rejects.toMatchObject({ code: 'EXECUTION_ACTIVE' });
        store.putCall({ ...store.call('paused-effect'), status: 'succeeded', effectOutcome: 'not_applied' });
      }
      expect(await integrateNode(store, tools, target, child.id)).toMatchObject({ status: 'applied', files: ['result.txt'] });
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('child result\n');
      expect(store.run(child.id)).toEqual(child);
      expect(store.run(runId)).toEqual(source);
    } finally { await cleanupSessionCheckouts(store, tools, store.run(runId)); }
  });

  it('rejects ordinary followups and destinations with an independent graph atomically', () => {
    const { app, runId } = fixture(undefined, ['read'], { toolProfile: 'lean-team', taskProtocol: 3 });
    const store = app.store, main = store.run(runId);
    declareTasks(store, runId, { tasks: [{ id: 'original', owner: 'self', goal: 'original task' }] });
    const ordinary = { ...main, id: 'ordinary', continuationOf: runId, historyFrom: runId };
    store.putRun(ordinary);
    expect(() => carryRecoveryTaskGraphs(store, main.sessionId, new Map([[runId, ordinary.id]]))).toThrow('audited same-session recovery');
    const target = { ...main, id: 'already-started', continuationOf: runId };
    store.putRun(target); store.event(runId, 'recovery.continued', { runId: target.id });
    declareTasks(store, target.id, { tasks: [{ id: 'independent', owner: 'self', goal: 'different task' }] });
    expect(() => carryRecoveryTaskGraphs(store, main.sessionId, new Map([[runId, target.id]]))).toThrow('independent task graph');
    expect(readTaskGraph(store, target.id).nodes.map(item => item.id)).toEqual(['independent']);
  });
});
