import { storageTestConnection } from '../src/storage/test-access.js';
import { describe, expect, it, vi } from 'vitest';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordNativeCompletion, recordNativePreparation, probeNativeRecovery } from '../src/tools/native-recovery.js';
import type { NativePreparationToken } from '../src/tools/native-recovery.js';
import { RecoveryManager } from '../src/runtime/recovery.js';
import { assertFileScope } from '../src/runtime/scope.js';
import { digest } from '../src/storage/index.js';
import type { Application } from '../src/application/index.js';
import type { Call, ToolRequest } from '../src/runtime/types.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

function start(app: Application, runId: string, request: ToolRequest): Call {
  const modelId = `native-model:${runId}`;
  app.store.putCall({ id: modelId, runId, step: 0, kind: 'model', name: 'fixture', status: 'succeeded', effect: 'read', requestRef: app.store.blob({}), resultRef: app.store.blob(calls(request)), reservedTokens: 0 });
  const effect: Call = { id: `${modelId}:${request.id}`, runId, step: 0, kind: 'tool', name: request.name, effect: 'write', status: 'running', effectState: 'not_started', requestRef: app.store.blob(request), reservedTokens: 0 };
  app.store.putCall(effect);
  app.store.updateRun(runId, { status: 'running', stepCallId: modelId });
  app.store.event(runId, 'tool.started', { callId: effect.id, name: effect.name });
  return effect;
}
function uncertain(app: Application, runId: string, effect: Call, terminal = false): void {
  app.store.putCall({ ...effect, status: 'unknown', effectState: 'started', resultRef: app.store.blob({ error: 'IO completed before result was persisted' }) });
  app.store.updateRun(runId, { status: terminal ? 'failed' : 'interrupted', ...(terminal ? { error: 'UNKNOWN_WRITE: native mutation interrupted' } : {}) });
}
function manager(app: Application): RecoveryManager {
  return new RecoveryManager(app.store, {
    probePatchForRecovery: app.coordinator.tools.probePatchForRecovery.bind(app.coordinator.tools),
    async probeNativeForRecovery(runId, call, request, signal) {
      const run = app.store.run(runId);
      const session = app.store.session(run.sessionId);
      return await probeNativeRecovery(app.store, { run, call, request, signal }, async input => {
        const file = path.resolve(session.workspace, input);
        assertFileScope(run.scope, 'read', session.workspace, file);
        assertFileScope(run.scope, 'write', session.workspace, file);
        return file;
      });
    },
  });
}
async function setup(name: 'file.patch' | 'file.mkdir' | 'file.rename' | 'file.delete') {
  const { app, root, runId } = fixture();
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'target.txt');
  if (name !== 'file.mkdir') await writeFile(source, 'before');
  const args = name === 'file.mkdir' ? { path: 'source.txt' } : { path: 'source.txt', expectedHash: digest('before'), ...(name === 'file.patch' ? { edits: [{ oldText: 'before', newText: 'after' }] } : name === 'file.rename' ? { destination: 'target.txt' } : {}) };
  const request = call(name, args);
  const effect = start(app, runId, request);
  const token = await recordNativePreparation(app.store, runId, name, args, { path: source, ...(name === 'file.rename' ? { destination } : {}) }, name === 'file.patch' ? { afterHash: digest('after'), bytes: 5 } : {});
  expect(token).toBeDefined();
  const mutate = async (): Promise<Record<string, unknown>> => {
    switch (name) {
      case 'file.patch': await writeFile(path.join(root, 'temp.txt'), 'after'); await rename(path.join(root, 'temp.txt'), source); return { path: args.path, hash: digest('after'), bytes: 5 };
      case 'file.mkdir': await mkdir(source); return { path: args.path, created: true };
      case 'file.rename': await link(source, destination); await unlink(source); return { path: args.path, destination: 'target.txt', hash: digest('before'), bytes: 6 };
      case 'file.delete': await unlink(source); return { path: args.path, deleted: true, hash: digest('before') };
    }
  };
  return { app, root, runId, source, destination, args, request, effect, token, mutate };
}

describe('evidence-based native file recovery', () => {
  it.each(['file.patch', 'file.mkdir', 'file.rename', 'file.delete'] as const)('records %s evidence through the real Tools execution path and reconciles a lost result', async name => {
    const args = name === 'file.mkdir' ? { path: 'source.txt' } : { path: 'source.txt', expectedHash: digest('before'), ...(name === 'file.patch' ? { edits: [{ oldText: 'before', newText: 'after' }] } : name === 'file.rename' ? { destination: 'target.txt' } : {}) };
    const request = call(name, args);
    const { app, root, runId } = fixture(scripted(calls(...(name === 'file.mkdir' ? [] : [call('file.read', { path: 'source.txt' }, 'read-before-edit')]), request), answer('recovered')));
    if (name !== 'file.mkdir') await writeFile(path.join(root, 'source.txt'), 'before');
    const execute = app.coordinator.tools.execute.bind(app.coordinator.tools);
    vi.spyOn(app.coordinator.tools, 'execute').mockImplementation(async (...input) => {
      // Lose the runtime result commit while retaining the native recovery receipt.
      const result = await execute(input[0], input[1], input[2], input[3], input[4], { ...input[5], settle: undefined });
      if (input[1] === name) throw new Error('fixture lost native result after IO');
      return result;
    });
    expect((await app.run(runId)).status).toBe('failed');
    expect(app.store.events(runId).filter(event => event.type === 'file.recovery.prepared')).toHaveLength(1);
    expect(app.store.events(runId).filter(event => event.type === 'file.recovery.completed')).toHaveLength(1);
    const report = await app.reconcile(runId);
    expect(report.blocked).toEqual([]);
    expect(report.resolutions).toMatchObject([{ source: 'probe', outcome: 'succeeded' }]);
  });
  it.each(['file.patch', 'file.mkdir', 'file.rename', 'file.delete'] as const)('recovers committed %s receipts while preserving terminal source records', async name => {
    const f = await setup(name);
    const result = await f.mutate();
    await recordNativeCompletion(f.app.store, f.token, result);
    uncertain(f.app, f.runId, f.effect, true);
    const original = f.app.store.call(f.effect.id);
    const report = await manager(f.app).inspect(f.runId);
    expect(report.blocked).toEqual([]);
    expect(report.resolutions).toMatchObject([{ source: 'probe', outcome: 'succeeded', retryAuthorized: false }]);
    expect(f.app.store.readBlob(report.calls.find(item => item.id === f.effect.id)!.resultRef!)).toEqual(result);
    expect(f.app.store.call(f.effect.id)).toEqual(original);
  });
  it.each(['file.patch', 'file.mkdir', 'file.rename', 'file.delete'] as const)('permits one safe retry only when exact %s prepared state remains', async name => {
    const f = await setup(name);
    uncertain(f.app, f.runId, f.effect);
    const report = await manager(f.app).inspect(f.runId);
    expect(report.blocked).toEqual([]);
    expect(report.resolutions).toMatchObject([{ outcome: 'not_applied', retryAuthorized: true }]);
    expect(f.app.store.call(f.effect.id).status).toBe('planned');
  });
  it('recovers deterministic localized patch output without a post-IO receipt and leaves divergent content unknown', async () => {
    const f = await setup('file.patch');
    await f.mutate();
    uncertain(f.app, f.runId, f.effect);
    expect((await manager(f.app).inspect(f.runId)).resolutions).toMatchObject([{ outcome: 'succeeded' }]);
    const divergent = await setup('file.patch');
    await writeFile(divergent.source, 'third party');
    uncertain(divergent.app, divergent.runId, divergent.effect);
    expect((await manager(divergent.app).inspect(divergent.runId)).blocked).toEqual([divergent.effect.id]);
  });
  it.each(['file.mkdir', 'file.delete'] as const)('keeps %s unknown if only the desired state is visible without a completion receipt', async name => {
    const f = await setup(name);
    await f.mutate();
    uncertain(f.app, f.runId, f.effect);
    const report = await manager(f.app).inspect(f.runId);
    expect(report.blocked).toEqual([f.effect.id]);
    expect(report.observations[0]!.evidence).toContain('No completion receipt');
  });
  it('keeps the partial hard-link rename unknown and never removes either path during inspection', async () => {
    const f = await setup('file.rename');
    await link(f.source, f.destination);
    uncertain(f.app, f.runId, f.effect);
    expect((await manager(f.app).inspect(f.runId)).blocked).toEqual([f.effect.id]);
    expect(await readFile(f.source, 'utf8')).toBe('before');
    expect(await readFile(f.destination, 'utf8')).toBe('before');
  });
  it('does not accept a replacement file with matching bytes as unchanged before evidence', async () => {
    const f = await setup('file.delete');
    await writeFile(path.join(f.root, 'replacement.txt'), 'before');
    await rename(path.join(f.root, 'replacement.txt'), f.source);
    uncertain(f.app, f.runId, f.effect);
    expect((await manager(f.app).inspect(f.runId)).blocked).toEqual([f.effect.id]);
  });
  it('does not authorize retry after a completed mutation was undone or modified by another writer', async () => {
    const f = await setup('file.patch');
    await recordNativeCompletion(f.app.store, f.token, await f.mutate());
    await writeFile(f.source, 'before');
    uncertain(f.app, f.runId, f.effect);
    expect((await manager(f.app).inspect(f.runId)).blocked).toEqual([f.effect.id]);
  });
  it('ignores stale evidence from earlier attempts and rejects changed canonical paths', async () => {
    const f = await setup('file.delete');
    f.app.store.event(f.runId, 'tool.started', { callId: f.effect.id, name: f.effect.name });
    uncertain(f.app, f.runId, f.effect);
    expect((await manager(f.app).inspect(f.runId)).blocked).toEqual([f.effect.id]);
    const other = await setup('file.delete');
    uncertain(other.app, other.runId, other.effect);
    const check = await probeNativeRecovery(other.app.store, { run: other.app.store.run(other.runId), call: other.app.store.call(other.effect.id), request: other.request, signal: new AbortController().signal }, async () => path.join(other.root, 'different.txt'));
    expect(check.outcome).toBe('unknown');
    expect(check.evidence).toContain('Canonical');
  });
  it('reports receipt persistence failure as uncertainty after mutation and never invents a completion record', async () => {
    const f = await setup('file.delete');
    const result = await f.mutate();
    const event = f.app.store.event.bind(f.app.store);
    vi.spyOn(f.app.store, 'event').mockImplementation((runId, type, data) => { if (type === 'file.recovery.completed') throw new Error('database fixture failure'); event(runId, type, data); });
    await expect(recordNativeCompletion(f.app.store, f.token, result)).rejects.toThrow('completed but');
    uncertain(f.app, f.runId, f.effect);
    expect((await manager(f.app).inspect(f.runId)).blocked).toEqual([f.effect.id]);
    expect(f.app.store.events(f.runId).some(item => item.type === 'file.recovery.completed')).toBe(false);
  });
  it('rejects source changes during preparation, and does not consume other runs or absent legacy evidence', async () => {
    const f = await setup('file.delete');
    await writeFile(f.source, 'changed');
    await expect(recordNativePreparation(f.app.store, f.runId, 'file.delete', f.args, { path: f.source })).rejects.toThrow('preconditions changed');
    const legacy = await setup('file.mkdir');
    storageTestConnection(legacy.app.store).prepare('DELETE FROM events WHERE run_id=? AND type=?').run(legacy.runId, 'file.recovery.prepared');
    uncertain(legacy.app, legacy.runId, legacy.effect);
    expect((await manager(legacy.app).inspect(legacy.runId)).blocked).toEqual([legacy.effect.id]);
    const other = fixture();
    await expect(probeNativeRecovery(f.app.store, { run: other.app.store.run(other.runId), call: f.effect, request: f.request, signal: new AbortController().signal }, async value => value)).rejects.toThrow('owned call');
  });
  it('supports direct trusted Tools execution without inventing a durable call binding', async () => {
    const { app, runId, root } = fixture();
    expect(await recordNativePreparation(app.store, runId, 'file.mkdir', { path: 'new' }, { path: path.join(root, 'new') })).toBeUndefined();
    await expect(recordNativeCompletion(app.store, undefined as NativePreparationToken | undefined, {})).resolves.toBeUndefined();
  });
});
