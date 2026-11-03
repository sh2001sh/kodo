import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { declareTasks } from '../src/runtime/task-declare.js';
import { moveTaskNode, readTaskGraph, requireTaskNode } from '../src/runtime/task-graph.js';
import { taskExecutionHost } from '../src/runtime/task-execution-host.js';
import * as checkout from '../src/runtime/execution-checkout.js';
import { taskNoticeMaxBytes } from '../src/runtime/task-notice.js';
import type { Provider } from '../src/runtime/types.js';
import { acquireWriteLock } from '../src/tools/write-locks.js';
import { answer, call, calls, fixture } from './helpers.js';

function team(provider?: Provider) {
  const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false }, lockDirectory: false });
  const store = f.app.store, main = store.run(f.runId);
  const node = (id = 'child') => requireTaskNode(readTaskGraph(store, f.runId), id);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=', ...args], { cwd: f.root, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  writeFileSync(path.join(f.root, 'base.txt'), 'base\n');
  git('add', 'base.txt'); git('commit', '-q', '-m', 'base');
  return { ...f, store, main, node };
}

describe('lean task scheduling review regressions', () => {
  it('reports an active scheduling failure without poisoning a later continuation', async () => {
    const f = team();
    const refresh = vi.spyOn(f.app.coordinator.mailbox, 'refresh').mockImplementationOnce(() => { throw new Error('synthetic scheduler failure'); });
    try {
      await expect(f.app.coordinator.tasks.tick(f.main.sessionId)).rejects.toThrow('synthetic scheduler failure');
      await expect(f.app.coordinator.tasks.tickForModel(f.main.sessionId)).rejects.toThrow('synthetic scheduler failure');
      f.store.updateRun(f.runId, { status: 'failed' });
      f.store.putRun({ ...f.main, id: 'synthetic-continuation', continuationOf: f.runId });
      await expect(f.app.coordinator.tasks.tickForModel(f.main.sessionId)).resolves.toBeUndefined();
      await f.app.coordinator.tasks.tick(f.main.sessionId);
    } finally { refresh.mockRestore(); }
  });

  it('prepares independent checkouts concurrently after serialized source captures', async () => {
    const f = team();
    let release!: () => void, entered = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prepare = checkout.prepareSnapshotCheckout;
    const spy = vi.spyOn(checkout, 'prepareSnapshotCheckout').mockImplementation(async (snapshot, signal) => {
      entered++;
      await gate;
      await prepare(snapshot, signal);
    });
    declareTasks(f.store, f.runId, { tasks: [{ id: 'a', goal: 'Independent A' }, { id: 'b', goal: 'Independent B' }] });
    const pass = f.app.coordinator.tasks.tick(f.main.sessionId);
    try { await vi.waitFor(() => expect(entered).toBe(2), { timeout: 5000 }); }
    finally { release(); await pass; spy.mockRestore(); }
    expect(readTaskGraph(f.store, f.runId).nodes.map(node => node.state)).toEqual(['running', 'running']);
  });

  it('allows the main model to continue during asynchronous checkout preparation', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prepare = checkout.prepareSnapshotCheckout;
    const spy = vi.spyOn(checkout, 'prepareSnapshotCheckout').mockImplementationOnce(async (snapshot, signal) => {
      await gate;
      await prepare(snapshot, signal);
    });
    let turns = 0;
    const f = team({ async complete(request) {
      if (!request.tools.some(tool => tool.name === 'delegate')) return answer('Checked.');
      if (++turns === 1) return calls(call('delegate', { tasks: [{ id: 'child', goal: 'Check independent snapshot' }] }));
      if (turns === 2) {
        expect(f.node().state).toBe('queued');
        release();
        return calls(call('task', { action: 'wait', node_ids: ['child'] }));
      }
      return answer('Finished.');
    } });
    try {
      expect((await f.app.coordinator.drive(f.runId)).status).toBe('completed');
      expect(turns).toBe(3);
    } finally { release(); spy.mockRestore(); }
  });

  it('keeps the main model responsive and durably waits while snapshot creation is blocked', async () => {
    let mainTurns = 0;
    const provider: Provider = { async complete(request) {
      const main = request.tools.some(tool => tool.name === 'delegate');
      if (!main) return answer('Child checked the snapshot.');
      mainTurns++;
      if (mainTurns === 1) return calls(call('delegate', { tasks: [{ id: 'child', goal: 'Check the snapshot' }] }));
      if (mainTurns === 2) {
        expect(JSON.stringify(request.messages)).toContain('Waiting for the workspace lock to take the task snapshot.');
        return calls(call('task', { action: 'wait', node_ids: ['child'] }));
      }
      return answer('Finished.');
    } };
    const f = team(provider);
    // This holder emits no Store event when released: the host retry must resume dispatch on its own.
    const release = await acquireWriteLock(f.root, [], { directory: false });
    const running = f.app.coordinator.drive(f.runId);
    try {
      await vi.waitFor(() => expect(f.store.run(f.runId).status, f.store.run(f.runId).error).toBe('waiting'), { timeout: 5000 });
      expect(mainTurns).toBe(2);
      expect(f.node()).toMatchObject({ state: 'queued', reason: expect.stringContaining('snapshot') });
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(mainTurns).toBe(2);
      expect(f.node().state).toBe('queued');
      expect(f.store.listRuns(f.main.sessionId)).toHaveLength(1);
    } finally { release(); }
    expect((await running).status).toBe('completed');
    expect(mainTurns).toBe(3);
    expect(f.node().state).toBe('done');
  });

  it('defers integration without blocking main requests and retries without extra model wakeups', async () => {
    let turns = 0;
    const f = team({ async complete(request) {
      turns++;
      if (turns === 1) {
        expect(JSON.stringify(request.messages)).toContain('Waiting for the workspace lock to integrate the task result.');
        return calls(call('task', { action: 'wait', node_ids: ['child'] }));
      }
      return answer('Integrated.');
    } });
    declareTasks(f.store, f.runId, { tasks: [{ id: 'child', goal: 'Write a result', scope: ['result.txt'] }] });
    await f.app.coordinator.tasks.tick(f.main.sessionId);
    const child = f.store.run(f.node().runId!);
    writeFileSync(path.join(child.execution!.root, 'result.txt'), 'child result\n');
    f.store.updateRun(child.id, { status: 'completed', resultRef: f.store.blob({ text: 'Done.' }) });
    const release = await f.app.coordinator.tools.workspaceWriteLock(f.runId);
    const running = f.app.coordinator.drive(f.runId);
    try {
      await vi.waitFor(() => expect(f.store.run(f.runId).status, f.store.run(f.runId).error).toBe('waiting'), { timeout: 5000 });
      expect(f.node()).toMatchObject({ state: 'integrating', reason: expect.stringContaining('integrate') });
      expect(turns).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(turns).toBe(1);
      expect(f.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(0);
      for (let attempt = 0; attempt < 3; attempt++) await f.app.coordinator.tasks.tick(f.main.sessionId);
      expect(f.store.calls(f.runId).filter(call => call.name === 'host.execution.commit')).toHaveLength(0);
    } finally { release(); }
    expect((await running).status).toBe('completed');
    expect(turns).toBe(2);
    expect(f.node().reason).toBeUndefined();
    expect(readFileSync(path.join(f.root, 'result.txt'), 'utf8')).toBe('child result\n');
    expect(f.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(1);
    expect(f.store.calls(f.runId).filter(call => call.name === 'host.execution.commit')).toHaveLength(1);
  });

  it('releases the main reservation when the child lock is busy and commits once after retry', async () => {
    const f = team();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'child', goal: 'Write a result', scope: ['result.txt'] }] });
    await f.app.coordinator.tasks.tick(f.main.sessionId);
    const child = f.store.run(f.node().runId!);
    writeFileSync(path.join(child.execution!.root, 'result.txt'), 'child result\n');
    f.store.updateRun(child.id, { status: 'completed' });
    const releaseChild = await f.app.coordinator.tools.workspaceWriteLock(child.id);
    try {
      for (let attempt = 0; attempt < 3; attempt++) await f.app.coordinator.tasks.tick(f.main.sessionId);
      expect(f.node().state).toBe('integrating');
      expect(f.store.calls(f.runId).filter(call => call.name === 'host.execution.commit')).toHaveLength(0);
      const releaseMain = await f.app.coordinator.tools.workspaceWriteLock(f.runId, undefined, true);
      releaseMain();
    } finally { releaseChild(); }
    await f.app.coordinator.tasks.tick(f.main.sessionId);
    expect(f.node().state).toBe('done');
    expect(f.store.calls(f.runId).filter(call => call.name === 'host.execution.commit')).toHaveLength(1);
    expect(readFileSync(path.join(f.root, 'result.txt'), 'utf8')).toBe('child result\n');
  });

  it('bounds the entire completion notice and preserves the full evidence behind a usable read pointer', async () => {
    const f = team();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'child', role: 'explorer', goal: 'Read' }] });
    await f.app.coordinator.tasks.tick(f.main.sessionId);
    // Escaped in JSON, this summary is well over the 50 KiB inline budget.
    const summary = `${'\u0000"\\\n'.repeat(12_000)}tail marker`;
    f.store.updateRun(f.node().runId!, { status: 'completed', resultRef: f.store.blob({ text: summary }) });
    await f.app.coordinator.tasks.tick(f.main.sessionId);
    const message = f.store.inbox(f.runId).find(message => message.id.startsWith('task-result:'))!;
    expect(Buffer.byteLength(message.content, 'utf8')).toBeLessThanOrEqual(taskNoticeMaxBytes);
    const notice = JSON.parse(message.content) as { state: string; summary: string; truncated: { hint: string; details: { tool: string; args: { artifact: string } } } };
    expect(notice).toMatchObject({ state: 'done', truncated: { details: { tool: 'read' } } });
    expect(notice.truncated.hint).toContain('explorer');
    expect(notice.summary).toMatch(/characters omitted[\s\S]*tail marker$/u);
    expect(f.store.readArtifact(f.runId, notice.truncated.details.args.artifact)).toMatchObject({ summary });
  });

  it('accepts a stale undelivered child through one validated transition before integrating', async () => {
    const f = team();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'child', goal: 'Write', scope: ['result.txt'] }] });
    await f.app.coordinator.tasks.tick(f.main.sessionId);
    const child = f.store.run(f.node().runId!);
    writeFileSync(path.join(child.execution!.root, 'result.txt'), 'accepted\n');
    f.store.updateRun(child.id, { status: 'completed' });
    moveTaskNode(f.store, f.runId, f.node(), 'stale');
    expect(f.app.coordinator.tasks.operation(f.main, 'accept-child', 'task', { action: 'accept', node_id: 'child', reason: 'Reviewed against current prerequisites.' })).toMatchObject({ state: 'integrating' });
    expect(f.store.latestEvent(f.runId, { types: ['task.node.updated'] })?.data).toMatchObject({ from: 'stale', state: 'integrating', action: 'accept' });
    expect(() => f.app.coordinator.tasks.operation(f.main, 'accept-again', 'task', { action: 'accept', node_id: 'child', reason: 'Again' })).toThrow('only stale');
    await f.app.coordinator.tasks.tick(f.main.sessionId);
    expect(f.node().state).toBe('done');
    expect(readFileSync(path.join(f.root, 'result.txt'), 'utf8')).toBe('accepted\n');
  });

  it('defaults the child quota independently of the graph size', () => {
    const f = team();
    const session = f.store.session(f.main.sessionId);
    f.store.putSession({ ...session, maxTaskNodes: 64, budget: { ...session.budget, maxActiveChildren: undefined } });
    const host = taskExecutionHost({ store: f.store, tools: f.app.coordinator.tools, mailbox: f.app.coordinator.mailbox, busy: () => false, cancel: () => {}, interrupt: () => {}, waitForStop: async id => f.store.run(id) }, f.main);
    expect(host.quota).toBe(8);
  });
});
