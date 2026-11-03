import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import { taskToolSpec } from '../src/messaging/delegate.js';
import { executeTaskAction } from '../src/messaging/task-tool.js';
import { finishHostCall, openHostCall } from '../src/runtime/execution-host-calls.js';
import { classifyTaskGraph } from '../src/runtime/task-completion.js';
import { declareTasks } from '../src/runtime/task-declare.js';
import { scheduleTasks } from '../src/runtime/task-dispatch.js';
import { moveTaskNode, readTaskGraph, requireTaskNode, writeTaskNode } from '../src/runtime/task-graph.js';
import type { TaskCheck } from '../src/runtime/task-graph.js';
import { recheckTask, recordTaskRunOutcome } from '../src/runtime/task-lifecycle.js';
import { TaskRuntime } from '../src/runtime/task-runtime.js';
import type { Provider } from '../src/runtime/types.js';
import { fakeHost, taskStore } from './task-fixture.js';
import { answer, call, calls, fixture } from './helpers.js';

const check = (script: string): TaskCheck => ({ program: process.execPath.replaceAll('\\', '/'), args: ['-e', script] });

async function failedCheck() {
  const f = taskStore(), host = fakeHost(f.store);
  f.store.putSession({ ...f.store.session('session'), toolProfile: 'lean-team' });
  declareTasks(f.store, f.ownerId, { tasks: [{ id: 'edit', goal: 'Edit', scope: ['result.txt'], check: check('process.exit(7)') }] });
  await scheduleTasks(f.store, f.ownerId, host);
  const node = () => requireTaskNode(readTaskGraph(f.store, f.ownerId), 'edit');
  const child = f.store.run(node().runId!);
  f.store.updateRun(child.id, { status: 'completed' });
  recordTaskRunOutcome(f.store, f.ownerId, 'edit', child.id, { status: 'completed', finalText: 'Done', integrate: true });
  const hostCheck = openHostCall(f.store, f.store.run(f.ownerId), 'host.task.check', { nodeId: 'edit', childId: child.id, generation: 1 }, ['result.txt']);
  finishHostCall(f.store, hostCheck.id, 'failed', 'applied', { exitCode: 7 });
  moveTaskNode(f.store, f.ownerId, node(), 'needs_input', { verification: { status: 'failed', version: 'old', callId: hostCheck.id }, reason: 'check failed' });
  return { ...f, host, node, child, hostCheck };
}

describe('check-only task revalidation', () => {
  it('retains the run, checkout and generation, resets evidence and never dispatches', async () => {
    const f = await failedCheck(), before = f.node(), starts = [...f.host.log];
    expect(classifyTaskGraph(readTaskGraph(f.store, f.ownerId)).needsMain[0]!.actions).toContain('recheck');
    const revised = check('process.exit(0)');
    const next = recheckTask(f.store, f.ownerId, 'edit', revised);
    expect(next).toMatchObject({ state: 'integrating', runId: before.runId, checkout: before.checkout, generation: before.generation, check: revised, scope: before.scope });
    expect(next.verification).toBeUndefined();
    expect(next.continuation).toBeUndefined();
    expect(next.reason).toBeUndefined();
    await scheduleTasks(f.store, f.ownerId, f.host);
    expect(f.host.log).toEqual(starts);
    expect(() => recheckTask(f.store, f.ownerId, 'edit')).toThrow('requires a failed host check');
  });

  it('does not treat a child request for input or failed model run as failed host verification', async () => {
    const f = await failedCheck(), before = f.node();
    writeTaskNode(f.store, f.ownerId, { ...before, verification: undefined });
    expect(() => recheckTask(f.store, f.ownerId, 'edit')).toThrow('requires a failed host check');
    writeTaskNode(f.store, f.ownerId, before);
    f.store.updateRun(f.child.id, { status: 'failed' });
    expect(() => recheckTask(f.store, f.ownerId, 'edit')).toThrow('current completed child');
    f.store.updateRun(f.child.id, { status: 'completed', taskNode: { ownerId: f.ownerId, nodeId: 'edit', generation: 2, role: 'implementer' } });
    expect(() => recheckTask(f.store, f.ownerId, 'edit')).toThrow('current completed child');
    expect(f.node()).toEqual(before);
  });

  it('rejects changed prerequisites and leaves the existing evidence intact', async () => {
    const f = await failedCheck();
    declareTasks(f.store, f.ownerId, { tasks: [{ id: 'base', goal: 'prerequisite', owner: 'self' }] });
    const base = requireTaskNode(readTaskGraph(f.store, f.ownerId), 'base');
    writeTaskNode(f.store, f.ownerId, { ...base, state: 'done', generation: 2 });
    writeTaskNode(f.store, f.ownerId, { ...f.node(), after: ['base'], dependencies: [{ id: 'base', generation: 1 }] });
    const before = f.node();
    expect(() => recheckTask(f.store, f.ownerId, 'edit')).toThrow('superseded prerequisites');
    expect(f.node()).toEqual(before);
  });

  it('rejects unresolved effects and a host check that has not settled', async () => {
    const f = await failedCheck(), before = f.node();
    f.store.putCall({ ...f.store.call(f.hostCheck.id), status: 'running' });
    expect(() => recheckTask(f.store, f.ownerId, 'edit')).toThrow('previous host check to settle');
    finishHostCall(f.store, f.hostCheck.id, 'unknown', 'unknown', {});
    expect(() => recheckTask(f.store, f.ownerId, 'edit')).toThrow('reconcile outstanding effects');
    expect(f.node()).toEqual(before);
  });

  it.each(['busy', 'effects', 'background'] as const)('rejects %s child work before clearing evidence', async active => {
    const f = await failedCheck(), before = f.node();
    const env = fixture(), tools = env.app.coordinator.tools;
    const effects = vi.spyOn(tools, 'hasInFlightEffects').mockReturnValue(active === 'effects');
    const background = vi.spyOn(tools, 'backgroundRunning').mockReturnValue(active === 'background');
    const runtime = new TaskRuntime({ store: f.store, tools, mailbox: env.app.coordinator.mailbox, busy: () => active === 'busy', cancel: () => {}, interrupt: () => {}, waitForStop: async () => f.child });
    try {
      expect(() => runtime.operation(f.store.run(f.ownerId), 'recheck', 'task', { action: 'recheck', node_id: 'edit' })).toThrow('effects to settle');
      expect(f.node()).toEqual(before);
    } finally { effects.mockRestore(); background.mockRestore(); }
  });

  it('validates revised executable checks and rejects scope/input instead of ignoring them', async () => {
    const f = await failedCheck(), before = f.node(), main = f.store.run(f.ownerId);
    expect(new Ajv().compile(taskToolSpec.parameters)({ action: 'recheck', node_id: 'edit', check: check('') })).toBe(true);
    expect(() => recheckTask(f.store, f.ownerId, 'edit', { program: '', args: [] })).toThrow('check requires');
    expect(() => executeTaskAction(f.store, main, 'recheck', { node_id: 'edit', scope: ['other.txt'] })).toThrow('only supported by task resume');
    expect(() => executeTaskAction(f.store, main, 'recheck', { node_id: 'edit', input: 'fix code' })).toThrow('use resume to send input');
    expect(f.node()).toEqual(before);
  });

  it.each([false, true])('reruns actual host checks with fresh evidence and one delivery (code changed=%s)', async changed => {
    let declared = false, rechecks = 0, childCalls = 0, previousVersion: string | undefined;
    let childId: string | undefined, checkout: string | undefined;
    const provider: Provider = { async complete(request) {
      const id = /Run ID: ([^. ]+)\./u.exec(request.messages.find(message => message.role === 'system')!.content!)![1]!;
      const run = f.app.store.run(id);
      if (run.parentId) {
        childCalls++;
        expect(run.continuationOf).toBeUndefined();
        return run.step === 0 ? calls(call('write', { path: 'result.txt', content: 'retained' })) : answer('Ready.');
      }
      if (!declared) { declared = true; return calls(call('delegate', { tasks: [{ id: 'edit', goal: 'Create result', scope: ['result.txt'], check: check('process.exit(7)') }] })); }
      const node = readTaskGraph(f.app.store, run.id).nodes[0]!;
      if (node.state === 'needs_input') {
        expect(rechecks).toBeLessThan(2);
        expect(node.verification?.status).toBe('failed');
        expect(f.app.store.events(run.id, { types: ['task.delivery'] })).toHaveLength(0);
        if (rechecks++ === 0) {
          childId = node.runId; checkout = node.checkout!.path; previousVersion = node.verification!.version;
          // An unchanged retry still fails, without re-running the child.
          return calls(call('task', { action: 'recheck', node_id: 'edit' }));
        }
        expect(node.runId).toBe(childId);
        expect(node.checkout!.path).toBe(checkout);
        if (changed) writeFileSync(path.join(checkout!, 'result.txt'), 'updated');
        return calls(call('task', { action: 'recheck', node_id: 'edit', check: check(`if(require('fs').readFileSync('result.txt','utf8') !== '${changed ? 'updated' : 'retained'}') process.exit(8)`) }));
      }
      if (node.state !== 'done') return calls(call('task', { action: 'wait', node_ids: ['edit'] }));
      expect(node.runId).toBe(childId);
      expect(node.generation).toBe(1);
      if (changed) expect(node.verification!.version).not.toBe(previousVersion);
      else expect(node.verification!.version).toBe(previousVersion);
      expect(() => f.app.coordinator.tasks.operation(run, 'duplicate', 'task', { action: 'recheck', node_id: 'edit' })).toThrow('requires a failed host check');
      return answer('Delivered verified result.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false }, lockDirectory: false });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=', ...args], { cwd: f.root, windowsHide: true });
    git('init', '-q'); writeFileSync(path.join(f.root, 'base.txt'), 'base\n'); git('add', 'base.txt'); git('commit', '-qm', 'base');
    const result = await f.app.coordinator.drive(f.runId);
    expect(result.status, result.error).toBe('completed');
    expect(childCalls).toBe(2);
    expect(rechecks).toBe(2);
    expect(f.app.store.listRuns(f.app.store.run(f.runId).sessionId).filter(run => run.parentId)).toHaveLength(1);
    expect(readFileSync(path.join(f.root, 'result.txt'), 'utf8')).toBe(changed ? 'updated' : 'retained');
    const hostCalls = f.app.store.calls(f.runId);
    const checks = hostCalls.filter(call => call.name === 'host.task.check');
    expect(checks.map(call => call.status)).toEqual(['failed', 'failed', 'succeeded']);
    expect(new Set(checks.map(call => call.id)).size).toBe(3);
    expect(hostCalls.filter(call => call.name === 'host.execution.commit')).toHaveLength(1);
    expect(f.app.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(1);
  }, 120_000);
});
