import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Application } from '../src/application/index.js';
import { RecoveryManager } from '../src/runtime/recovery.js';
import { digest, unlockData } from '../src/storage/index.js';
import type { Call, ToolRequest } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, scripted, temp } from './helpers.js';

function uncertain(app: Application, runId: string, request: ToolRequest = call('file.apply_patch', { path: 'effect.txt', expectedHash: null, content: 'applied exactly once' }, 'effect'), state: 'interrupted' | 'failed' = 'interrupted'): Call {
  const modelId = `model-before-crash:${runId}`;
  app.store.putCall({ id: modelId, runId, step: 0, kind: 'model', name: 'fixture', status: 'succeeded', effect: 'read', requestRef: app.store.blob({}), resultRef: app.store.blob(calls(request)), reservedTokens: 0 });
  const effect: Call = { id: `${modelId}:${request.id}`, runId, step: 0, kind: 'tool', name: request.name, effect: 'write', status: 'unknown', requestRef: app.store.blob(request), resultRef: app.store.blob({ error: 'effect may have happened' }), reservedTokens: 0 };
  app.store.putCall(effect);
  app.store.updateRun(runId, { status: state, stepCallId: modelId, ...(state === 'failed' ? { error: 'UNKNOWN_WRITE: effect not confirmed' } : {}) });
  return effect;
}
const manager = (app: Application): RecoveryManager => new RecoveryManager(app.store, app.coordinator.tools);

describe('verified recovery of uncertain effects', () => {
  it('records an already applied patch as successful and resumes without writing again', async () => {
    const { app, root, runId } = fixture(scripted(answer('verified completion')));
    const original = uncertain(app, runId);
    writeFileSync(path.join(root, 'effect.txt'), 'applied exactly once');
    const execute = vi.spyOn(app.coordinator.tools, 'execute');
    const result = await manager(app).inspect(runId);
    expect(result.blocked).toEqual([]);
    expect(app.store.call(original.id).status).toBe('succeeded');
    expect(app.store.readBlob(app.store.call(original.id).resultRef!)).toMatchObject({ path: 'effect.txt', hash: digest('applied exactly once'), recovery: { verified: true } });
    expect((await app.coordinator.resume(runId)).status).toBe('completed');
    expect(execute).not.toHaveBeenCalled();
    expect(app.store.events(runId).find(x => x.type === 'recovery.resolved')?.data).toMatchObject({ originalResultRef: original.resultRef, outcome: 'succeeded' });
  });

  it.each([false, true])('authorizes one safe retry when the expected before state remains (existing=%s)', async existing => {
    const { app, root, runId } = fixture();
    if (existing) writeFileSync(path.join(root, 'effect.txt'), 'before');
    const original = uncertain(app, runId, call('file.apply_patch', { path: 'effect.txt', expectedHash: existing ? digest('before') : null, content: 'after' }, 'retry'));
    const execute = vi.spyOn(app.coordinator.tools, 'execute');
    const report = await manager(app).inspect(runId);
    expect(report.blocked).toEqual([]);
    expect(app.store.call(original.id).status).toBe('planned');
    expect(report.resolutions[0]).toMatchObject({ outcome: 'not_applied', retryAuthorized: true });
    expect((await app.coordinator.resume(runId)).status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(root, 'effect.txt'), 'utf8')).toBe('after');
  });

  it('keeps divergent files unknown and records hash evidence without file content', async () => {
    const { app, root, runId } = fixture();
    const effect = uncertain(app, runId);
    writeFileSync(path.join(root, 'effect.txt'), 'third-party-content');
    const recovery = manager(app);
    const report = await recovery.inspect(runId);
    await recovery.inspect(runId);
    expect(report.blocked).toEqual([effect.id]);
    expect(report.observations[0]?.evidence).toContain(digest('third-party-content'));
    expect(JSON.stringify(report)).not.toContain('third-party-content');
    expect(app.store.call(effect.id)).toEqual(effect);
    expect(app.store.events(runId).filter(x => x.type === 'recovery.inspected')).toHaveLength(1);
  });

  it('requires concrete manual evidence for process effects, preserves the original result and deduplicates resolution', async () => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId, call('process.exec', { program: 'external-action', args: [] }, 'process'));
    const recovery = manager(app);
    expect((await recovery.inspect(runId)).blocked).toEqual([effect.id]);
    expect(() => recovery.resolve(runId, effect.id, { outcome: 'succeeded', evidence: 'ok' })).toThrow('concrete verification');
    const options = { outcome: 'succeeded' as const, evidence: 'Checked transaction receipt 8472 in the external system; the requested operation completed once.' };
    expect(recovery.resolve(runId, effect.id, options).blocked).toEqual([]);
    recovery.resolve(runId, effect.id, options);
    expect(app.store.events(runId).filter(x => x.type === 'recovery.resolved')).toHaveLength(1);
    expect(app.store.events(runId).find(x => x.type === 'recovery.resolved')?.data.originalResultRef).toBe(effect.resultRef);
    expect(() => recovery.resolve(runId, effect.id, { ...options, outcome: 'failed' })).toThrow('different recovery resolution');
    expect(app.store.readBlob(effect.resultRef!)).toEqual({ error: 'effect may have happened' });
  });

  it('requires explicit manual retry authorization and never applies an earlier retry verdict to a later uncertain attempt', () => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId, call('process.exec', { program: 'external-action', args: [] }, 'process'));
    const recovery = manager(app);
    const options = { outcome: 'not_applied' as const, evidence: 'Inspected the external transaction ledger and verified no transaction was submitted.' };
    expect(() => recovery.resolve(runId, effect.id, options)).toThrow('explicitly authorize');
    expect(recovery.resolve(runId, effect.id, { ...options, retry: true }).calls.find(x => x.id === effect.id)?.status).toBe('planned');
    app.store.transaction(() => {
      app.store.event(runId, 'tool.started', { callId: effect.id });
      app.store.putCall({ ...effect, status: 'unknown' });
    });
    expect(recovery.plan(runId).blocked).toEqual([effect.id]);
    recovery.resolve(runId, effect.id, { outcome: 'failed', evidence: 'Checked the second transaction attempt; it returned a confirmed rejection without applying changes.' });
    expect(app.store.events(runId).filter(x => x.type === 'recovery.resolved')).toHaveLength(2);
    expect(app.store.call(effect.id).status).toBe('failed');
  });

  it('keeps terminal failed source records immutable and returns the effective calls for a continuation', async () => {
    const { app, root, runId } = fixture();
    const effect = uncertain(app, runId, undefined, 'failed');
    const before = app.store.run(runId);
    writeFileSync(path.join(root, 'effect.txt'), 'applied exactly once');
    const plan = await manager(app).inspect(runId);
    expect(plan.requiresContinuation).toBe(true);
    expect(plan.pendingModelCallId).toBe(before.stepCallId);
    expect(plan.calls.find(x => x.id === effect.id)?.status).toBe('succeeded');
    expect(app.store.run(runId)).toEqual(before);
    expect(app.store.call(effect.id)).toEqual(effect);
    expect(() => app.coordinator.resume(runId)).toThrow('terminal records remain immutable');
  });

  it('continues a failed run through the application without replaying a verified patch', async () => {
    const { app, root, runId } = fixture(scripted(async request => {
      expect(request.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'effect')).toHaveLength(1);
      expect(JSON.stringify(request.messages)).toContain('verified');
      const continuation = app.store.listRuns().find(run => run.continuationOf === runId)!;
      expect(request.messages[0]?.content).toContain(`Run ID: ${continuation.id}`);
      return answer('recovered via immutable continuation');
    }));
    const effect = uncertain(app, runId, undefined, 'failed');
    const originalRun = app.store.run(runId);
    writeFileSync(path.join(root, 'effect.txt'), 'applied exactly once');
    await app.reconcile(runId);
    const execute = vi.spyOn(app.coordinator.tools, 'execute');
    const resumed = await app.recover(runId);
    expect(resumed.id).not.toBe(runId);
    expect(resumed.continuationOf).toBe(runId);
    expect(resumed.status).toBe('completed');
    expect(app.store.run(runId)).toEqual(originalRun);
    expect(app.store.call(effect.id)).toEqual(effect);
    expect(execute).not.toHaveBeenCalled();
    expect(() => app.recover(runId)).toThrow('already created run');
  });

  it('retries a verified unapplied patch in a failed-run continuation exactly once', async () => {
    const { app, root, runId } = fixture();
    const effect = uncertain(app, runId, undefined, 'failed');
    await app.reconcile(runId);
    const execute = vi.spyOn(app.coordinator.tools, 'execute');
    const resumed = await app.recover(runId);
    expect(resumed.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(root, 'effect.txt'), 'utf8')).toBe('applied exactly once');
    expect(app.store.call(effect.id)).toEqual(effect);
  });

  it('notifies the resumed main about a child recovery and lets it await the new child result', async () => {
    let mainCalls = 0;
    let originalChildId = '';
    const { app, root, runId } = fixture({ async complete(request) {
      const identity = request.messages[0]?.content ?? '';
      const childContinuation = app.store.listRuns().find(run => run.continuationOf === originalChildId)!;
      if (identity.includes('You are a child.')) {
        expect(identity).toContain(`Run ID: ${childContinuation.id}`);
        return answer('verified recovered child evidence');
      }
      if (++mainCalls === 1) {
        expect(JSON.stringify(request.messages)).toContain(childContinuation.id);
        return calls(call('wait_for_events', { run_ids: [childContinuation.id], timeout_ms: 5000 }, 'await-recovered-child'));
      }
      expect(JSON.stringify(request.messages)).toContain('verified recovered child evidence');
      return answer('main accepted recovered evidence');
    } });
    const main = app.store.run(runId);
    const child = app.store.transaction(() => app.coordinator.mailbox.execute(main, 'spawn-failed-child', 'spawn_agent', { objective: 'recoverable child' })) as { id: string };
    originalChildId = child.id;
    const effect = uncertain(app, child.id, undefined, 'failed');
    app.store.updateRun(runId, { status: 'interrupted' });
    writeFileSync(path.join(root, 'effect.txt'), 'applied exactly once');
    await app.reconcile(child.id);
    expect((await app.recover(runId)).status).toBe('completed');
    const recoveredChild = app.store.listRuns().find(run => run.continuationOf === child.id)!;
    expect(recoveredChild.status).toBe('completed');
    expect(app.store.run(child.id).status).toBe('failed');
    expect(app.store.call(effect.id)).toEqual(effect);
  });

  it('commits call reconciliation and the immutable audit together', async () => {
    const { app, root, runId } = fixture();
    const effect = uncertain(app, runId);
    writeFileSync(path.join(root, 'effect.txt'), 'applied exactly once');
    const originalEvent = app.store.event.bind(app.store);
    const failure = vi.spyOn(app.store, 'event').mockImplementation((id, type, data) => {
      if (type === 'recovery.resolved') throw new Error('simulated audit persistence failure');
      return originalEvent(id, type, data);
    });
    await expect(manager(app).inspect(runId)).rejects.toThrow('audit persistence failure');
    expect(app.store.call(effect.id)).toEqual(effect);
    expect(app.store.events(runId).filter(x => x.type === 'recovery.resolved')).toEqual([]);
    failure.mockRestore();
    expect((await manager(app).inspect(runId)).blocked).toEqual([]);
  });

  it('rejects cross-run and cross-session calls and never reopens cancelled runs', () => {
    const { app, root, runId } = fixture();
    const effect = uncertain(app, runId);
    const other = app.createRun({ objective: 'other session', workspace: root, binding });
    uncertain(app, other.id, call('process.exec', { program: 'none', args: [] }, 'other-effect'));
    const recovery = manager(app);
    expect(() => recovery.resolve(other.id, effect.id, { outcome: 'failed', evidence: 'Inspected the external system and verified the operation failed.' })).toThrow('selected run');
    app.coordinator.cancel(runId);
    recovery.resolve(runId, effect.id, { outcome: 'failed', evidence: 'Inspected the external system and verified the operation failed.' });
    expect(() => app.recover(runId)).toThrow('terminal records remain immutable');
    expect(app.store.run(runId).status).toBe('cancelled');
    expect(app.store.call(effect.id)).toEqual(effect);
    expect(app.store.events(other.id).filter(x => x.type === 'recovery.resolved')).toHaveLength(0);
  });

  it('reconciles late uncertain effects on a cancelled child before releasing the paused main run', async () => {
    const { app, root, runId } = fixture();
    const main = app.store.run(runId);
    const child = app.store.transaction(() => app.coordinator.mailbox.execute(main, 'spawn-recovery-child', 'spawn_agent', { objective: 'cancelled writer' })) as { id: string };
    const effect = uncertain(app, child.id);
    app.coordinator.cancel(child.id);
    const cancelled = app.store.run(child.id);
    app.store.updateRun(runId, { status: 'interrupted' });
    writeFileSync(path.join(root, 'effect.txt'), 'applied exactly once');
    expect(() => app.recover(runId)).toThrow('reconcile or provide verification');
    const report = await app.reconcile(child.id);
    expect(report.blocked).toEqual([]);
    expect(report.requiresContinuation).toBe(false);
    expect(app.store.run(child.id)).toEqual(cancelled);
    expect(app.store.call(effect.id)).toEqual(effect);
    expect((await app.recover(runId)).status).toBe('completed');
    expect(app.store.run(child.id)).toEqual(cancelled);
  });

  it('retires a prior durable wait when an interrupted run resumes into a new wait', async () => {
    const { app, runId } = fixture(scripted(calls(call('ask_user', { question: 'Confirm the revised task after recovery?' }, 'new-wait'))));
    const main = app.store.run(runId);
    const child = app.store.transaction(() => app.coordinator.mailbox.execute(main, 'spawn-wait-peer', 'spawn_agent', { objective: 'old wait target' })) as { id: string };
    const previous = app.store.transaction(() => app.coordinator.mailbox.execute(main, 'old-wait', 'wait_for_events', { run_ids: [child.id], timeout_ms: 300_000 })) as { waitId: string };
    app.store.updateRun(runId, { status: 'interrupted' });
    expect((await app.coordinator.resume(runId)).status).toBe('waiting');
    expect(app.store.wait(previous.waitId).status).toBe('settled');
    expect(app.store.run(runId).waitId).not.toBe(previous.waitId);
    expect(app.store.waits().filter(wait => wait.runId === runId && wait.status === 'registered')).toHaveLength(1);
  });

  it.each(['.env', '../outside.txt', 'C:\\outside.txt'])('does not probe protected or outside paths: %s', async file => {
    const { app, root, runId } = fixture();
    writeFileSync(path.join(root, '.env'), 'PRIVATE-VALUE');
    const effect = uncertain(app, runId, call('file.apply_patch', { path: file, expectedHash: null, content: 'replacement' }, 'protected'));
    const plan = await manager(app).inspect(runId);
    expect(plan.blocked).toEqual([effect.id]);
    expect(plan.observations[0]?.evidence).toContain('PATH_DENIED');
    expect(JSON.stringify(plan)).not.toContain('PRIVATE-VALUE');
  });

  it('does not probe files after read permission is revoked', async () => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId);
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, permissions: ['write'] });
    const plan = await manager(app).inspect(runId);
    expect(plan.blocked).toEqual([effect.id]);
    expect(plan.observations[0]?.evidence).toContain('TOOL_DENIED');
  });

  it('recovers after a real process crash after file commit without replaying the write', async () => {
    const root = temp();
    const child = spawn(process.execPath, ['tests/fixtures/crash-writer.mjs', root], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stderr.on('data', chunk => { errors += String(chunk); });
    try {
      const runId = await new Promise<string>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`crash fixture exited before effect barrier: ${errors}`)));
        child.stdout.on('data', chunk => {
          output += String(chunk);
          if (output.includes('\n')) resolve((JSON.parse(output.trim()) as { runId: string }).runId);
        });
      });
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      unlockData(path.join(root, 'state'));
      const app = new Application(path.join(root, 'state'), scripted(answer('crash effect verified')));
      try {
        expect(app.store.run(runId).status).toBe('interrupted');
        const execute = vi.spyOn(app.coordinator.tools, 'execute');
        expect((await manager(app).inspect(runId)).blocked).toEqual([]);
        expect((await app.coordinator.resume(runId)).status).toBe('completed');
        expect(execute).not.toHaveBeenCalled();
        expect(readFileSync(path.join(root, 'external-effect.txt'), 'utf8')).toBe('written once');
      } finally { app.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
    expect(existsSync(path.join(root, 'external-effect.txt'))).toBe(true);
  }, 15_000);
});
