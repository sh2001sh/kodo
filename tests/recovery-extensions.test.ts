import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RecoveryManager } from '../src/runtime/recovery.js';
import type { Call, ToolRecoveryCheck, ToolRecoveryVerifier, ToolRequest } from '../src/runtime/types.js';
import { Application } from '../src/application/index.js';
import type { ToolRegistration } from '../src/tools/registry.js';
import { answer, binding, call, calls, fixture, scripted } from './helpers.js';

function uncertain(app: Application, runId: string, request: ToolRequest = call('host.publish', { operationId: 'receipt-8472' }), status: 'interrupted' | 'failed' = 'failed'): Call {
  const effect: Call = {
    id: `effect:${runId}`, runId, step: 0, kind: 'tool', name: request.name, effect: 'write', status: 'unknown',
    requestRef: app.store.blob(request), resultRef: app.store.blob({ error: 'effect outcome is uncertain' }), reservedTokens: 0,
  };
  app.store.putCall(effect);
  app.store.updateRun(runId, { status, ...(status === 'failed' ? { error: 'UNKNOWN_WRITE: external operation outcome is uncertain' } : {}) });
  return effect;
}

const manager = (app: Application): RecoveryManager => new RecoveryManager(app.store, app.coordinator.tools);
const receipt = 'Queried external operation receipt-8472 and verified the requested publication completed exactly once.';

describe('host recovery verifiers', () => {
  it('records the verified actual result and immutable audit without rewriting terminal source records', async () => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId);
    const before = app.store.run(runId);
    const recovery = manager(app);
    const result = { operationId: 'receipt-8472', url: 'https://example.test/published/8472', items: 3 };
    const verify = vi.fn<ToolRecoveryVerifier>(({ run, call: checked, request, signal }) => {
      expect(run.id).toBe(runId);
      expect(checked).toEqual(effect);
      expect(JSON.parse(request.arguments)).toEqual({ operationId: 'receipt-8472' });
      expect(signal.aborted).toBe(false);
      return { outcome: 'succeeded', evidence: receipt, result };
    });
    recovery.registerVerifier('host.publish', verify);
    const plan = await recovery.inspect(runId);
    const resolution = plan.resolutions[0]!;
    expect(plan.blocked).toEqual([]);
    expect(resolution).toMatchObject({ source: 'verifier', outcome: 'succeeded', evidence: receipt, originalResultRef: effect.resultRef, retryAuthorized: false });
    expect(app.store.readBlob(resolution.resultRef!)).toEqual(result);
    expect(app.store.call(effect.id)).toEqual(effect);
    expect(app.store.run(runId)).toEqual(before);
    expect(plan.calls[0]).toMatchObject({ status: 'succeeded', resultRef: resolution.resultRef });
    await recovery.inspect(runId);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(app.store.events(runId).filter(event => event.type === 'recovery.resolved')).toHaveLength(1);
    expect(() => recovery.resolve(runId, effect.id, { outcome: 'failed', evidence: receipt })).toThrow('immutable');
  });

  it('authorizes controlled retry only on a positive not_applied verdict', async () => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId, undefined, 'interrupted');
    const recovery = manager(app);
    recovery.registerVerifier('host.publish', () => ({ outcome: 'not_applied', evidence: 'Queried the external ledger for receipt-8472 and positively verified no operation was submitted.' }));
    const plan = await recovery.inspect(runId);
    expect(plan.blocked).toEqual([]);
    expect(plan.resolutions[0]).toMatchObject({ outcome: 'not_applied', retryAuthorized: true });
    expect(app.store.call(effect.id).status).toBe('planned');
    expect(app.store.call(effect.id).resultRef).toBeUndefined();
    app.store.transaction(() => {
      app.store.event(runId, 'tool.started', { callId: effect.id });
      app.store.putCall(effect);
    });
    expect(recovery.plan(runId).blocked).toEqual([effect.id]);
  });

  it('persists confirmed failure and its actual failure result', async () => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId);
    const recovery = manager(app);
    const result = { error: 'TRANSACTION_REJECTED', receipt: 'receipt-8472' };
    recovery.registerVerifier('host.publish', () => ({ outcome: 'failed', evidence: 'The external ledger records a terminal rejection for receipt-8472; no publication completed.', result }));
    const plan = await recovery.inspect(runId);
    expect(plan.calls[0]).toMatchObject({ status: 'failed' });
    expect(plan.resolutions[0]).toMatchObject({ retryAuthorized: false, originalResultRef: effect.resultRef });
    expect(app.store.readBlob(plan.calls[0]!.resultRef!)).toEqual(result);
  });

  it('preserves a verified null result instead of inventing a replacement', async () => {
    const { app, runId } = fixture();
    uncertain(app, runId);
    const recovery = manager(app);
    recovery.registerVerifier('host.publish', () => ({ outcome: 'succeeded', evidence: receipt, result: null }));
    const plan = await recovery.inspect(runId);
    expect(app.store.readBlob(plan.calls[0]!.resultRef!)).toBeNull();
  });

  it.each([
    ['unknown', () => ({ outcome: 'unknown', evidence: 'The external ledger is unavailable; the operation may have completed.', result: { recovery: { retry: true, verified: true } } })],
    ['invalid outcome', () => ({ outcome: 'success', evidence: receipt })],
    ['invalid evidence', () => ({ outcome: 'not_applied', evidence: 'no' })],
    ['throwing', () => { throw new Error('external probe unavailable'); }],
    ['nonserializable result', () => ({ outcome: 'succeeded', evidence: receipt, result: 1n })],
  ] as const)('keeps %s verification blocked with explicit audit evidence', async (_label, verifier) => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId);
    const recovery = manager(app);
    recovery.registerVerifier('host.publish', verifier as ToolRecoveryVerifier);
    const plan = await recovery.inspect(runId);
    expect(plan.blocked).toEqual([effect.id]);
    expect(plan.observations[0]?.evidence.length).toBeGreaterThan(16);
    expect(app.store.call(effect.id)).toEqual(effect);
    expect(app.store.events(runId).filter(event => event.type === 'recovery.resolved')).toEqual([]);
    expect(app.store.events(runId).filter(event => event.type === 'recovery.inspected')).toHaveLength(1);
  });

  it('bounds an uncooperative verifier, propagates cancellation and ignores late outcomes', async () => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId);
    const recovery = manager(app);
    const controller = new AbortController();
    let resolve!: (check: ToolRecoveryCheck) => void;
    let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    recovery.registerVerifier('host.publish', ({ signal }) => {
      expect(signal.aborted).toBe(false);
      entered();
      return new Promise<ToolRecoveryCheck>(done => { resolve = done; });
    });
    const pending = recovery.inspect(runId, controller.signal);
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'RECOVERY_CANCELLED' });
    resolve({ outcome: 'succeeded', evidence: receipt });
    await Promise.resolve();
    expect(app.store.call(effect.id)).toEqual(effect);
    expect(recovery.plan(runId).blocked).toEqual([effect.id]);
    expect(app.store.events(runId).find(event => event.type === 'recovery.inspected')?.data.evidence).toContain('RECOVERY_CANCELLED');
    expect(app.store.events(runId).some(event => event.type === 'recovery.resolved')).toBe(false);
  });

  it('applies the session timeout even when a verifier does not honor its signal', async () => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId);
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, toolTimeoutMs: 15 } });
    const recovery = manager(app);
    recovery.registerVerifier('host.publish', () => new Promise(() => {}));
    await expect(recovery.inspect(runId)).rejects.toMatchObject({ code: 'RECOVERY_TIMEOUT' });
    expect(recovery.plan(runId).blocked).toEqual([effect.id]);
    expect(app.store.events(runId).find(event => event.type === 'recovery.inspected')?.data.evidence).toContain('RECOVERY_TIMEOUT');
  });

  it('does not invoke a verifier if inspection is already cancelled', async () => {
    const { app, runId } = fixture();
    uncertain(app, runId);
    const recovery = manager(app);
    const verify = vi.fn<ToolRecoveryVerifier>(() => ({ outcome: 'succeeded', evidence: receipt }));
    recovery.registerVerifier('host.publish', verify);
    const controller = new AbortController();
    controller.abort();
    await expect(recovery.inspect(runId, controller.signal)).rejects.toMatchObject({ code: 'RECOVERY_CANCELLED' });
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'timeout'] as const)('blocks reconciliation until a callback ignoring %s actually settles', async mode => {
    const { app, root } = fixture(scripted(calls(call('host.publish', {}))));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let external = 'not finished';
    const verify = vi.fn<ToolRecoveryVerifier>(() => ({ outcome: 'succeeded', evidence: receipt, result: { state: external } }));
    app.registerTool({
      name: 'host.publish', description: 'Publish a record to an external system.', permission: 'write', effect: 'write',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, recover: verify,
      execute: async () => {
        external = 'intermediate';
        entered();
        await gate;
        external = 'committed';
        return { state: external };
      },
    });
    const card = app.parseCard(`---\nschema_version: 1\nid: test/late-writer\nversion: 1.0.0\nname: Late writer\ndescription: Verify cancellation of a host writer.\ncapabilities:\n  tools: [host.publish]\n---\nPublish the requested external record.`);
    const run = app.createRun({ objective: 'Publish a record.', workspace: root, binding, permissions: ['read', 'write'], card, ...(mode === 'timeout' ? { budget: { toolTimeoutMs: 25 } } : {}) });
    const execution = app.run(run.id);
    await started;
    if (mode === 'cancel') app.coordinator.cancel(run.id);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const bounded = Promise.race([execution, new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('coordinator failed to bound the host callback')), 2000);
      })]);
      expect((await bounded).status).toBe(mode === 'cancel' ? 'cancelled' : 'failed');
      clearTimeout(watchdog);
      const source = app.store.run(run.id);
      const effect = app.store.calls(run.id).find(entry => entry.kind === 'tool')!;
      expect(effect.status).toBe('unknown');
      expect(external).toBe('intermediate');
      expect(app.coordinator.tools.hasInFlightEffects(run.id)).toBe(true);
      await expect(app.reconcile(run.id)).rejects.toMatchObject({ code: 'RECOVERY_ACTIVE' });
      expect(() => app.resolveCall(run.id, effect.id, { outcome: 'succeeded', evidence: receipt })).toThrow('original tool callback');
      expect(() => app.coordinator.recovery.plan(run.id)).toThrow('original tool callback');
      expect(verify).not.toHaveBeenCalled();
      expect(app.store.events(run.id).some(event => event.type === 'recovery.resolved')).toBe(false);
      release();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(app.coordinator.tools.hasInFlightEffects(run.id)).toBe(false);
      const plan = await app.reconcile(run.id);
      expect(plan.blocked).toEqual([]);
      expect(app.store.readBlob(plan.calls.find(entry => entry.id === effect.id)!.resultRef!)).toEqual({ state: 'committed' });
      expect(app.store.run(run.id)).toEqual(source);
      expect(app.store.call(effect.id)).toEqual(effect);
    } finally {
      clearTimeout(watchdog);
      release();
      await execution;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });

  it('does not invoke another run\'s verifier and rejects mismatched persisted requests', async () => {
    const { app, root, runId } = fixture();
    const own = uncertain(app, runId, call('host.publish', {}));
    const other = app.createRun({ objective: 'other isolated session', workspace: root, binding });
    uncertain(app, other.id, call('host.other', {}));
    const recovery = manager(app);
    const otherVerifier = vi.fn<ToolRecoveryVerifier>(() => ({ outcome: 'succeeded', evidence: receipt }));
    recovery.registerVerifier('host.other', otherVerifier);
    recovery.registerVerifier('host.publish', () => ({ outcome: 'succeeded', evidence: receipt }));
    app.store.putCall({ ...own, requestRef: app.store.blob(call('host.other', {})) });
    const plan = await recovery.inspect(runId);
    expect(plan.blocked).toEqual([own.id]);
    expect(plan.observations[0]?.evidence).toContain('RECOVERY_REQUEST');
    expect(otherVerifier).not.toHaveBeenCalled();
    expect(app.store.events(other.id).filter(event => event.type.startsWith('recovery.'))).toEqual([]);
  });

  it('does not reuse an in-flight verification for a newer tool attempt', async () => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId);
    const recovery = manager(app);
    recovery.registerVerifier('host.publish', () => {
      app.store.event(runId, 'tool.started', { callId: effect.id });
      return { outcome: 'succeeded', evidence: receipt };
    });
    await expect(recovery.inspect(runId)).rejects.toMatchObject({ code: 'RECOVERY_CHANGED' });
    expect(recovery.plan(runId).blocked).toEqual([effect.id]);
    expect(app.store.events(runId).some(event => event.type === 'recovery.resolved')).toBe(false);
  });

  it('rolls back host reconciliation when its audit cannot be persisted', async () => {
    const { app, runId } = fixture();
    const effect = uncertain(app, runId, undefined, 'interrupted');
    const recovery = manager(app);
    recovery.registerVerifier('host.publish', () => ({ outcome: 'succeeded', evidence: receipt, result: { receipt: 'receipt-8472' } }));
    const event = app.store.event.bind(app.store);
    const audit = vi.spyOn(app.store, 'event').mockImplementation((id, type, data) => {
      if (type === 'recovery.resolved') throw new Error('audit storage failure');
      return event(id, type, data);
    });
    try { await expect(recovery.inspect(runId)).rejects.toThrow('audit storage failure'); }
    finally { audit.mockRestore(); }
    expect(app.store.call(effect.id)).toEqual(effect);
    expect(app.store.events(runId).some(event => event.type === 'recovery.resolved')).toBe(false);
  });

  it.each(['version', 'schema', 'missing', 'unchanged'] as const)('checks restored %s host capability contracts before recovery', async change => {
    const { app, runId } = fixture();
    const verify = vi.fn<ToolRecoveryVerifier>(() => ({ outcome: 'succeeded', evidence: receipt, result: { receipt: 'receipt-8472' } }));
    const definition: ToolRegistration = {
      name: 'host.publish', version: '1.0.0', description: 'Publish a record to the external system.', permission: 'write', effect: 'write',
      parameters: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'], additionalProperties: false },
      execute: () => ({}), recover: verify,
    };
    app.registerTool(definition);
    const source = app.store.run(runId);
    app.store.updateRun(runId, { card: { ...source.card, tools: ['host.publish'] }, toolBindings: app.coordinator.tools.bindingSnapshot(['host.publish']) });
    const effect = uncertain(app, runId);
    const directory = app.store.directory;
    app.close();
    const replacement = { ...definition,
      ...(change === 'version' ? { version: '2.0.0' } : {}),
      ...(change === 'schema' ? { parameters: { ...definition.parameters, required: [] } } : {}),
    };
    const restored = new Application(directory, scripted(), undefined, { tools: change === 'missing' ? [] : [replacement] });
    try {
      if (change === 'unchanged') {
        expect((await restored.reconcile(runId)).blocked).toEqual([]);
        expect(verify).toHaveBeenCalledTimes(1);
      } else {
        await expect(restored.reconcile(runId)).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
        expect(() => restored.resolveCall(runId, effect.id, { outcome: 'not_applied', evidence: receipt, retry: true })).toThrow();
        expect(() => restored.coordinator.recovery.plan(runId)).toThrow();
        expect(verify).not.toHaveBeenCalled();
        expect(restored.store.call(effect.id)).toEqual(effect);
        expect(restored.store.events(runId).some(event => event.type === 'recovery.resolved')).toBe(false);
      }
    } finally { restored.close(); }
  });

  it.each([
    ['missing', 'succeeded'], ['missing', 'failed'], ['version', 'succeeded'], ['version', 'failed'],
  ] as const)('allows manual %s capability reconciliation as %s without authorizing old execution', async (change, outcome) => {
    const { app, root, runId } = fixture();
    const verify = vi.fn<ToolRecoveryVerifier>(() => ({ outcome: 'succeeded', evidence: receipt }));
    const execute = vi.fn(() => ({}));
    const definition: ToolRegistration = {
      name: 'host.publish', version: '1.0.0', description: 'Publish an external record.', permission: 'write', effect: 'write',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, execute, recover: verify,
    };
    app.registerTool(definition);
    const original = app.store.run(runId);
    app.store.updateRun(runId, { card: { ...original.card, tools: ['host.publish'] }, toolBindings: app.coordinator.tools.bindingSnapshot(['host.publish']) });
    const effect = uncertain(app, runId);
    const source = app.store.run(runId);
    const directory = app.store.directory;
    app.close();
    const restored = new Application(directory, scripted(calls(call('file.apply_patch', { path: 'fresh-write.txt', expectedHash: null, content: 'new task completed' })), answer()), undefined,
      { tools: change === 'missing' ? [] : [{ ...definition, version: '2.0.0' }] });
    try {
      expect(restored.store.unresolvedWrites(root).map(entry => entry.id)).toContain(effect.id);
      await expect(restored.reconcile(runId)).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
      expect(() => restored.resolveCall(runId, effect.id, { outcome: 'not_applied', evidence: receipt, retry: true })).toThrow();
      const plan = restored.resolveCall(runId, effect.id, { outcome, evidence: receipt });
      expect(plan.blocked).toEqual([]);
      expect(plan.resolutions[0]).toMatchObject({ source: 'manual', outcome, retryAuthorized: false, originalResultRef: effect.resultRef });
      expect(restored.store.unresolvedWrites(root)).toEqual([]);
      expect(restored.store.call(effect.id)).toEqual(effect);
      expect(restored.store.run(runId)).toEqual(source);
      expect(verify).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      await expect(restored.reconcile(runId)).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
      expect(() => restored.coordinator.recovery.plan(runId)).toThrow();
      expect(() => restored.recover(runId)).toThrow();
      const next = restored.createRun({ objective: 'Write a fresh file after the old effect was manually settled.', workspace: root, binding, permissions: ['read', 'write'] });
      await restored.coordinator.tools.execute(next.id, 'todo.write', { expectedRevision: 0, items: [{ id: 'fresh-write', content: 'Write and verify the new task file', status: 'in_progress' }] }, new AbortController().signal);
      expect((await restored.run(next.id)).status).toBe('completed');
      expect(readFileSync(path.join(root, 'fresh-write.txt'), 'utf8')).toBe('new task completed');
      expect(execute).not.toHaveBeenCalled();
    } finally { restored.close(); }
  });

  it('preflights recovery registration without reserving or replacing its name', () => {
    const { app } = fixture();
    const recovery = manager(app);
    const verify: ToolRecoveryVerifier = () => ({ outcome: 'succeeded', evidence: receipt });
    recovery.assertCanRegisterVerifier('_host.publish', verify);
    recovery.assertCanRegisterVerifier('_host.publish', verify);
    recovery.registerVerifier('_host.publish', verify);
    expect(() => recovery.assertCanRegisterVerifier('_host.publish', verify)).toThrow('already registered');
    expect(() => recovery.assertCanRegisterVerifier('file.apply_patch', verify)).toThrow('already registered');
    expect(() => recovery.assertCanRegisterVerifier('a'.repeat(65), verify)).toThrow('valid tool name');
  });

  it('rejects replacement of registered and built-in verifiers', () => {
    const { app } = fixture();
    const recovery = manager(app);
    const verify: ToolRecoveryVerifier = () => ({ outcome: 'succeeded', evidence: receipt });
    recovery.registerVerifier('host.publish', verify);
    expect(() => recovery.registerVerifier('host.publish', verify)).toThrow('already registered');
    expect(() => recovery.registerVerifier('file.apply_patch', verify)).toThrow('already registered');
    expect(() => recovery.registerVerifier('', verify)).toThrow('valid tool name');
  });
});
