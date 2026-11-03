import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { declareTasks } from '../src/runtime/task-declare.js';
import { scheduleTasks } from '../src/runtime/task-dispatch.js';
import { readTaskGraph, requireTaskNode, writeTaskNode } from '../src/runtime/task-graph.js';
import type { TaskCheck } from '../src/runtime/task-graph.js';
import { acceptStaleTask, recordTaskRunOutcome, resumeTask } from '../src/runtime/task-lifecycle.js';
import { executeTaskAction } from '../src/messaging/task-tool.js';
import { childFollowupContext } from '../src/messaging/agent-lifecycle.js';
import { finishHostCall, openHostCall } from '../src/runtime/execution-host-calls.js';
import type { Provider } from '../src/runtime/types.js';
import { fakeHost, taskStore } from './task-fixture.js';
import { answer, call, calls, fixture } from './helpers.js';

const check = (script: string): TaskCheck => ({ program: process.execPath.replaceAll('\\', '/'), args: ['-e', script] });

async function stoppedTask() {
  const { store, ownerId } = taskStore();
  declareTasks(store, ownerId, { tasks: [{ id: 'edit', goal: 'Edit', scope: ['old.txt'], check: check('process.exit(0)') }, { id: 'peer', goal: 'Peer', scope: ['peer.txt'] }] });
  await scheduleTasks(store, ownerId, fakeHost(store));
  const node = () => requireTaskNode(readTaskGraph(store, ownerId), 'edit');
  const child = store.run(node().runId!);
  store.updateRun(child.id, { status: 'completed', scope: { read: ['.'], write: ['old.txt'] } });
  recordTaskRunOutcome(store, ownerId, 'edit', child.id, { status: 'completed', finalText: 'NEEDS_INPUT: correct scope', integrate: true });
  return { store, ownerId, child: store.run(child.id), node };
}

describe('retained task scope and check revision', () => {
  it('rejects conflicting ownership atomically and retains the previous check and evidence', async () => {
    const f = await stoppedTask();
    writeTaskNode(f.store, f.ownerId, { ...f.node(), verification: { status: 'passed', version: 'old-version' } });
    const before = readTaskGraph(f.store, f.ownerId), events = f.store.events(f.ownerId).length;
    expect(() => resumeTask(f.store, f.ownerId, 'edit', 'retry', { scope: ['peer.txt'], check: check('process.exit(1)') })).toThrow(/overlaps unfinished task peer/);
    expect(readTaskGraph(f.store, f.ownerId)).toEqual(before);
    expect(f.store.events(f.ownerId)).toHaveLength(events);
  });

  it('replaces the scope literally, resets verification, and keeps the checkout and generation', async () => {
    const f = await stoppedTask();
    writeTaskNode(f.store, f.ownerId, { ...f.node(), verification: { status: 'passed', version: 'old-version' } });
    const before = f.node();
    const next = resumeTask(f.store, f.ownerId, 'edit', 'continue', { scope: ['new.txt'], check: check('process.exit(0)') });
    expect(next).toMatchObject({ state: 'pending', scope: ['new.txt'], checkout: before.checkout, generation: before.generation, continuation: { fromRunId: before.runId, reviseWriteScope: true } });
    expect(next.scope).not.toContain('old.txt');
    expect(next.verification).toBeUndefined();
    expect(f.store.run(f.child.id).scope).toEqual({ read: ['.'], write: ['old.txt'] });
  });

  it('rejects changes outside the parent or card assignment before changing the node', async () => {
    const f = await stoppedTask();
    const before = f.node();
    f.store.updateRun(f.ownerId, { scope: { write: ['old.txt'] } });
    expect(() => resumeTask(f.store, f.ownerId, 'edit', undefined, { scope: ['new.txt'] })).toThrow(/parent write scope/);
    expect(f.node()).toEqual(before);
    f.store.updateRun(f.ownerId, { scope: undefined });
    f.store.updateRun(f.child.id, { card: { ...f.child.card, constraints: { scope: { write: ['old.txt'] } } } });
    expect(() => resumeTask(f.store, f.ownerId, 'edit', undefined, { scope: ['new.txt'] })).toThrow(/parent write scope/);
    expect(f.node()).toEqual(before);
  });

  it('requires settled effects and limits revisions to needs_input/failed tasks', async () => {
    const f = await stoppedTask();
    const before = f.node();
    const effect = openHostCall(f.store, f.store.run(f.ownerId), 'host.task.check', {}, ['old.txt']);
    finishHostCall(f.store, effect.id, 'unknown', 'unknown', { reason: 'unresolved test operation' });
    expect(() => resumeTask(f.store, f.ownerId, 'edit', undefined, { check: check('process.exit(0)') })).toThrow(/reconcile outstanding effects/);
    expect(f.node()).toEqual(before);
    writeTaskNode(f.store, f.ownerId, { ...before, state: 'done' });
    expect(() => resumeTask(f.store, f.ownerId, 'edit', undefined, { scope: ['new.txt'] })).toThrow(/only for needs_input or failed/);
  });

  it('directs needs_input acceptance to resume even when a reason is absent', async () => {
    const f = await stoppedTask();
    expect(() => acceptStaleTask(f.store, f.ownerId, 'edit', undefined)).toThrow(/use task resume/);
    expect(() => executeTaskAction(f.store, f.store.run(f.ownerId), 'accept', { node_id: 'edit' })).toThrow(/use task resume/);
    expect(() => executeTaskAction(f.store, f.store.run(f.ownerId), 'inspect', { node_id: 'edit', scope: ['new.txt'] })).toThrow(/only supported by task resume/);
  });

  it('keeps ordinary followup scopes fixed and never revises read scope or permissions', async () => {
    const f = await stoppedTask();
    const source = { ...f.child, taskNode: { ownerId: f.ownerId, nodeId: 'edit', generation: 1, role: 'implementer' } };
    const next = { ...source, id: 'next', continuationOf: source.id, scope: { read: ['.'], write: ['new.txt'] } };
    expect(() => childFollowupContext(f.store, source, next)).toThrow(/permissions or scope changed/);
    expect(() => childFollowupContext(f.store, source, { ...next, scope: { read: ['base.txt'], write: ['new.txt'] } }, true)).toThrow(/permissions or scope changed/);
    expect(() => childFollowupContext(f.store, source, { ...next, permissions: ['read'] }, true)).toThrow(/permissions or scope changed/);
  });

  it('resumes a real worker, moves its retained work, reruns the revised host check and delivers once', async () => {
    let first = true, resumed = false;
    const provider: Provider = { async complete(request) {
      const id = /Run ID: ([^. ]+)\./u.exec(request.messages.find(message => message.role === 'system')!.content!)![1]!;
      const run = f.app.store.run(id);
      if (!run.parentId) {
        if (first) { first = false; return calls(call('delegate', { tasks: [{ id: 'edit', goal: 'Create and move a result', scope: ['old.txt'], check: check('process.exit(7)') }] })); }
        const node = readTaskGraph(f.app.store, run.id).nodes[0]!;
        if (node.state === 'needs_input') {
          expect(resumed).toBe(false);
          resumed = true;
          expect(node.verification?.status).toBe('failed');
          expect(() => f.app.coordinator.tasks.operation(run, 'accept-needs-input', 'task', { action: 'accept', node_id: 'edit' })).toThrow(/use task resume/);
          return calls(call('task', { action: 'resume', node_id: 'edit', input: 'Move the existing result to new.txt.', scope: ['old.txt', 'new.txt'], check: check("const fs=require('fs'); if(fs.existsSync('old.txt') || fs.readFileSync('new.txt','utf8') !== 'retained work') process.exit(8)") }));
        }
        if (node.state !== 'done') return calls(call('task', { action: 'wait', node_ids: ['edit'] }));
        return answer('Delivered.');
      }
      if (!run.continuationOf) return run.step === 0 ? calls(call('write', { path: 'old.txt', content: 'retained work' })) : answer('Retained worker result.');
      expect(run.execution!.root).toBe(f.app.store.run(run.continuationOf).execution!.root);
      expect(run.scope?.write).toEqual(['old.txt', 'new.txt']);
      expect(JSON.stringify(request.messages)).toContain('Retained worker result.');
      if (run.step === 0) {
        expect(readFileSync(path.join(run.execution!.root, 'old.txt'), 'utf8')).toBe('retained work');
        return calls(call('bash', { command: 'mv old.txt new.txt' }));
      }
      return answer('Moved retained work.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false }, lockDirectory: false });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=', ...args], { cwd: f.root, windowsHide: true });
    git('init', '-q'); writeFileSync(path.join(f.root, 'base.txt'), 'base\n'); git('add', 'base.txt'); git('commit', '-qm', 'base');
    const result = await f.app.coordinator.drive(f.runId);
    expect(result.status, result.error).toBe('completed');
    expect(resumed).toBe(true);
    expect(readFileSync(path.join(f.root, 'new.txt'), 'utf8')).toBe('retained work');
    expect(existsSync(path.join(f.root, 'old.txt'))).toBe(false);
    const hostCalls = f.app.store.calls(f.runId);
    expect(hostCalls.filter(call => call.name === 'host.task.check').map(call => call.status)).toEqual(['failed', 'succeeded']);
    expect(hostCalls.filter(call => call.name === 'host.execution.commit')).toHaveLength(1);
    expect(f.app.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(1);
  }, 120_000);
});
