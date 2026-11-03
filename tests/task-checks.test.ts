import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Application } from '../src/application/index.js';
import type { Provider } from '../src/runtime/types.js';
import { KodoError } from '../src/runtime/types.js';
import { readTaskGraph, writeTaskNode } from '../src/runtime/task-graph.js';
import type { TaskCheck } from '../src/runtime/task-graph.js';
import { TaskChecks, taskCheckCommand } from '../src/runtime/task-checks.js';
import { declareTasks } from '../src/runtime/task-declare.js';
import { classifyTaskGraph } from '../src/runtime/task-completion.js';
import { acknowledgeTaskFailure } from '../src/runtime/task-lifecycle.js';
import { openHostCall, startHostCall } from '../src/runtime/execution-host-calls.js';
import { recoverHostCalls } from '../src/runtime/execution-integration.js';
import { delegateSpec } from '../src/messaging/delegate.js';
import { Ajv } from 'ajv';
import { answer, call, calls, fixture } from './helpers.js';

function owner(app: Application, request: Parameters<Provider['complete']>[0]) {
  const id = /Run ID: ([^. ]+)\./u.exec(request.messages.find(message => message.role === 'system')!.content!)![1]!;
  return app.store.run(id);
}
function repository(root: string): void {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args], { cwd: root, windowsHide: true });
  git('init', '-q');
  writeFileSync(path.join(root, '.gitignore'), '.state/\n');
  writeFileSync(path.join(root, 'base.txt'), 'baseline\n');
  git('add', '.gitignore', 'base.txt'); git('commit', '-q', '-m', 'baseline');
}
const check = (script: string, timeoutMs?: number): TaskCheck => ({ program: process.execPath.replaceAll('\\', '/'), args: ['-e', script], ...(timeoutMs ? { timeoutMs } : {}) });

describe('host task verification', () => {
  it('keeps literal argv intact, including shell metacharacters and quotes', () => {
    const value = "a' b; echo hidden $(pwd) `pwd` &";
    const command = taskCheckCommand(check('console.log(process.argv[1])')) + ` '${value.replaceAll("'", "'\\''")}'`;
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
    expect(execFileSync(bash, ['--noprofile', '--norc', '-c', command], { encoding: 'utf8', windowsHide: true }).trim()).toBe(value);
  });

  it('rejects malformed checks atomically and keeps old descriptive checks readable', () => {
    const f = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3 });
    for (const invalid of [{ program: '', args: [] }, { program: 'node', args: ['bad\0arg'] }, { program: 'node', args: [], timeoutMs: 0 }]) {
      expect(() => declareTasks(f.app.store, f.runId, { tasks: [{ id: 'bad', goal: 'test', check: invalid }] })).toThrow('check requires');
      expect(readTaskGraph(f.app.store, f.runId).nodes).toHaveLength(0);
    }
    expect(() => declareTasks(f.app.store, f.runId, { tasks: [{ id: 'bad', goal: 'test', owner: 'self', check: check('') }] })).toThrow('executable child role');
    expect(() => declareTasks(f.app.store, f.runId, { tasks: [{ id: 'bad', goal: 'test', scope: ['result.txt'], check: check('') }] }, { requireScope: true })).toThrow('Git snapshot workspace');
    declareTasks(f.app.store, f.runId, { tasks: [{ id: 'old', goal: 'test', check: 'all tests pass' }] });
    expect(readTaskGraph(f.app.store, f.runId).nodes[0]!.check).toBe('all tests pass');
    const validate = new Ajv().compile(delegateSpec.parameters);
    expect(validate({ tasks: [{ id: 'new', goal: 'test', check: 'all tests pass' }] })).toBe(false);
    expect(validate({ tasks: [{ id: 'new', goal: 'test', acceptance: 'all tests pass', check: check('process.exit(0)') }] })).toBe(true);
  });

  it('blocks a failed check even after inspection, resumes the retained checkout, and delivers only checked code', async () => {
    let mainTurns = 0, failedRun: string | undefined;
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        if (mainTurns++ === 0) return calls(call('delegate', { tasks: [{ id: 'edit', goal: 'Create result', scope: ['result.txt'], acceptance: 'result must be good', check: check("const fs=require('fs'); console.log('actual host check'); process.exit(fs.readFileSync('result.txt','utf8') === 'good' ? 0 : 7)") }] }));
        const node = readTaskGraph(f.app.store, run.id).nodes[0]!;
        if (node.state === 'needs_input') {
          failedRun = node.runId;
          expect(node.verification?.status).toBe('failed');
          expect(f.app.store.events(run.id, { types: ['task.delivery'] })).toHaveLength(0);
          expect(existsSync(path.join(f.root, 'result.txt'))).toBe(false);
          expect(existsSync(node.checkout!.path)).toBe(true);
          acknowledgeTaskFailure(f.app.store, run.id, node.id);
          expect(classifyTaskGraph(readTaskGraph(f.app.store, run.id)).needsMain).not.toHaveLength(0);
          return calls(call('task', { action: 'resume', node_id: node.id, input: 'Write good, not bad.' }));
        }
        if (node.state !== 'done') return calls(call('task', { action: 'wait', node_ids: ['edit'] }));
        return answer('Delivered verified result.');
      }
      if (run.continuationOf) expect(run.execution!.root).toBe(f.app.store.run(failedRun!).execution!.root);
      if (run.step === 0 && run.continuationOf) return calls(call('read', { path: 'result.txt' }));
      if (run.step === 0 || (run.step === 1 && run.continuationOf)) return calls(call('write', { path: 'result.txt', content: run.continuationOf ? 'good' : 'bad' }));
      return answer('Changes ready; the host will run the check.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    repository(f.root);
    const result = await f.app.coordinator.drive(f.runId);
    expect(result.status, result.error).toBe('completed');
    expect(readFileSync(path.join(f.root, 'result.txt'), 'utf8')).toBe('good');
    const checks = f.app.store.calls(f.runId).filter(call => call.name === 'host.task.check');
    expect(checks.map(call => call.status)).toEqual(['failed', 'succeeded']);
    expect(checks.map(call => f.app.store.readBlob<{ exitCode: number }>(call.resultRef!).exitCode)).toEqual([7, 0]);
    expect(f.app.store.readBlob(checks[1]!.resultRef!)).toMatchObject({ stdout: 'actual host check\n', version: expect.any(String), durationMs: expect.any(Number) });
    expect(f.app.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(1);
  }, 120_000);

  it.each(['mutates', 'timeout', 'approval'] as const)('never integrates when the check %s', async failure => {
    let mainTurns = 0, blocked = false;
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        if (mainTurns++ === 0) return calls(call('delegate', { tasks: [{ id: 'edit', goal: 'Create result', scope: ['result.txt'], check: failure === 'mutates' ? check("require('fs').writeFileSync('result.txt','changed-by-check')") : failure === 'timeout' ? check('setTimeout(()=>{}, 20000)', 100) : check('process.exit(0)') }] }));
        const node = readTaskGraph(f.app.store, run.id).nodes[0]!;
        if (node.state === 'needs_input') {
          blocked = true;
          expect(node.verification?.status).toBe('failed');
          expect(existsSync(path.join(f.root, 'result.txt'))).toBe(false);
          return calls(call('task', { action: 'drop', node_id: node.id, reason: 'Explicitly abandon the unsuccessful fixture task.' }));
        }
        if (node.state === 'dropped') return answer('Fixture task abandoned after failed verification.');
        return calls(call('task', { action: 'wait', node_ids: ['edit'] }));
      }
      return run.step === 0 ? calls(call('write', { path: 'result.txt', content: 'candidate' })) : answer('Ready.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    repository(f.root);
    if (failure === 'approval') f.app.coordinator.tools.setApprovalHandler(async request => request.name !== 'shell.exec');
    const result = await f.app.coordinator.drive(f.runId);
    expect(result.status, result.error).toBe('completed');
    expect(blocked).toBe(true);
    expect(f.app.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(0);
    const hostCall = f.app.store.calls(f.runId).find(call => call.name === 'host.task.check')!;
    if (failure === 'timeout') expect(f.app.store.readBlob(hostCall.resultRef!)).toMatchObject({ timedOut: true });
    if (failure === 'approval') expect(hostCall.effectOutcome).toBe('not_applied');
  }, 120_000);

  it('runs independent main model work while the host check is still running', async () => {
    let mainTurns = 0, observed = false;
    let checkStarted!: () => void;
    const started = new Promise<void>(resolve => { checkStarted = resolve; });
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        if (mainTurns++ === 0) return calls(call('delegate', { tasks: [{ id: 'edit', goal: 'Create result', scope: ['result.txt'], check: check('setTimeout(()=>process.exit(0), 4000)') }] }));
        if (mainTurns === 2) { await started; return calls(call('task', { action: 'inspect', node_id: 'edit' })); }
        const node = readTaskGraph(f.app.store, run.id).nodes[0]!;
        if (node.verification?.status === 'running') {
          observed = true;
          expect(f.app.store.call(node.verification.callId!).status).toBe('running');
        }
        if (node.state === 'done') return answer('Done.');
        return calls(call('task', { action: 'wait', node_ids: ['edit'] }));
      }
      return run.step === 0 ? calls(call('write', { path: 'result.txt', content: 'result' })) : answer('Ready.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    repository(f.root);
    // Main's independent model turn overlaps the child and then continues while the check runs.
    const unsubscribe = f.app.store.subscribe(event => {
      if (event.type === 'task.check.started') checkStarted();
    });
    try { expect((await f.app.coordinator.drive(f.runId)).status).toBe('completed'); }
    finally { unsubscribe(); }
    expect(observed).toBe(true);
  }, 120_000);

  it.each([false, true])('recovers an interrupted host check without replaying it (started=%s)', async started => {
    const f = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3 });
    const store = f.app.store, main = store.run(f.runId);
    declareTasks(store, main.id, { tasks: [{ id: 'edit', goal: 'check', check: check('process.exit(0)') }] });
    const node = { ...readTaskGraph(store, main.id).nodes[0]!, runId: 'child', state: 'integrating' as const };
    const call = openHostCall(store, main, 'host.task.check', { childId: 'child' }, [f.root]);
    if (started) startHostCall(store, call.id);
    writeTaskNode(store, main.id, { ...node, verification: { status: 'running', callId: call.id } });
    const tools = f.app.coordinator.tools, execute = vi.spyOn(tools, 'execute');
    const checks = new TaskChecks({ store, tools, mailbox: f.app.coordinator.mailbox, busy: () => false, cancel: () => {}, interrupt: () => {}, waitForStop: async () => main });
    expect(await recoverHostCalls(store, tools, main)).toEqual([]);
    expect(checks.ready(main, readTaskGraph(store, main.id).nodes[0]!)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(readTaskGraph(store, main.id).nodes[0]).toMatchObject({ state: 'needs_input', verification: { status: 'failed' } });
    expect(store.call(call.id).status).toBe(started ? 'unknown' : 'failed');
  });

  it('records a known process-start failure as not applied, without an unknown-write barrier', async () => {
    const f = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3 });
    const store = f.app.store, main = store.run(f.runId);
    declareTasks(store, main.id, { tasks: [{ id: 'edit', goal: 'check', check: check('process.exit(0)') }] });
    store.putRun({ ...main, id: 'child', parentId: main.id, status: 'completed' });
    const node = { ...readTaskGraph(store, main.id).nodes[0]!, runId: 'child', state: 'integrating' as const };
    writeTaskNode(store, main.id, node);
    const tools = f.app.coordinator.tools;
    vi.spyOn(tools, 'execute').mockImplementation(async (...args) => { args[4]?.(); throw new KodoError('PROCESS_START', 'program could not be started'); });
    const checks = new TaskChecks({ store, tools, mailbox: f.app.coordinator.mailbox, busy: () => false, cancel: () => {}, interrupt: () => {}, waitForStop: async () => main });
    expect(checks.ready(main, node)).toBe(false);
    await vi.waitFor(() => expect(checks.busy(main.id)).toBe(false));
    checks.assertHealthy(main.id);
    const hostCall = store.calls(main.id).find(call => call.name === 'host.task.check')!;
    expect(hostCall).toMatchObject({ status: 'failed', effectOutcome: 'not_applied' });
    expect(store.unresolvedWrites(undefined, main.sessionId)).toHaveLength(0);
    expect(readTaskGraph(store, main.id).nodes[0]!.state).toBe('needs_input');
  });

  it('stops an active host check and settles its record before the main driver returns', async () => {
    let mainTurns = 0;
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        if (mainTurns++ === 0) return calls(call('delegate', { tasks: [{ id: 'edit', goal: 'Create result', scope: ['result.txt'], check: check('setTimeout(()=>{}, 20000)') }] }));
        return calls(call('task', { action: 'wait', node_ids: ['edit'] }));
      }
      return run.step === 0 ? calls(call('write', { path: 'result.txt', content: 'candidate' })) : answer('Ready.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    repository(f.root);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = f.app.store.subscribe(event => {
      if (event.type === 'task.check.started') timer = setTimeout(() => f.app.coordinator.cancel(f.runId), 100);
    });
    try {
      const result = await f.app.coordinator.drive(f.runId);
      expect(result.status).toBe('cancelled');
      const hostCall = f.app.store.calls(f.runId).find(call => call.name === 'host.task.check')!;
      expect(hostCall.status).not.toBe('running');
      expect(f.app.store.events(f.runId, { types: ['task.check.settled'] })).toHaveLength(1);
      expect(f.app.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(0);
      expect(f.app.coordinator.tools.hasInFlightEffects(readTaskGraph(f.app.store, f.runId).nodes[0]!.runId!)).toBe(false);
    } finally { clearTimeout(timer); unsubscribe(); }
  }, 120_000);

  it('does not execute legacy descriptive check text and labels its delivery unverified', async () => {
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        if (readTaskGraph(f.app.store, run.id).nodes[0]!.state !== 'done') return calls(call('task', { action: 'wait', node_ids: ['old'] }));
        return answer('Delivered without a host verification command.');
      }
      return run.step === 0 ? calls(call('write', { path: 'result.txt', content: 'candidate' })) : answer('Ready.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    repository(f.root);
    // Simulate a persisted declaration from the previous tool schema; new model calls only accept an object.
    declareTasks(f.app.store, f.runId, { tasks: [{ id: 'old', goal: 'Create result', scope: ['result.txt'], check: 'This is acceptance prose, not an executable command.' }] });
    expect((await f.app.coordinator.drive(f.runId)).status).toBe('completed');
    expect(f.app.store.calls(f.runId).filter(call => call.name === 'host.task.check')).toHaveLength(0);
    expect(readTaskGraph(f.app.store, f.runId).nodes[0]).toMatchObject({ state: 'done', verification: { status: 'unverified' } });
  }, 120_000);

  it('drains checks on shutdown even after the driver returned to wait for user input', async () => {
    let mainTurns = 0;
    let checkStarted!: () => void;
    const started = new Promise<void>(resolve => { checkStarted = resolve; });
    const provider: Provider = { async complete(request) {
      const run = owner(f.app, request);
      if (!run.parentId) {
        if (mainTurns++ === 0) return calls(call('delegate', { tasks: [{ id: 'edit', goal: 'Create result', scope: ['result.txt'], check: check('setTimeout(()=>{}, 20000)') }] }));
        await started;
        return calls(call('ask_user', { question: 'Which separate documentation format should I use?' }));
      }
      return run.step === 0 ? calls(call('write', { path: 'result.txt', content: 'candidate' })) : answer('Ready.');
    } };
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
    repository(f.root);
    const unsubscribe = f.app.store.subscribe(event => { if (event.type === 'task.check.started') checkStarted(); });
    try {
      expect((await f.app.coordinator.drive(f.runId)).status).toBe('waiting');
      expect(f.app.coordinator.busy).toBe(true);
      await f.app.coordinator.shutdown();
      expect(f.app.coordinator.busy).toBe(false);
      expect(f.app.coordinator.tools.hasPendingEffects()).toBe(false);
      expect(f.app.store.calls(f.runId).find(call => call.name === 'host.task.check')!.status).not.toBe('running');
      expect(f.app.store.events(f.runId, { types: ['task.delivery'] })).toHaveLength(0);
    } finally { unsubscribe(); }
  }, 120_000);
});
