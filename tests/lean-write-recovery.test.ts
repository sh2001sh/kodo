import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { answer, call, calls, fixture, scripted } from './helpers.js';

describe('lean whole-file write recovery uses native preparation evidence', () => {
  it.each([false, true])('recovers an unapplied write with an %s existing target without a model-supplied hash', async existing => {
    const initial = existing ? [calls(call('read', { path: 'target.txt' }))] : [];
    const { app, root, runId } = fixture(scripted(...initial,
      calls(call('write', { path: 'target.txt', content: 'new content' }, 'write')),
      answer('The interrupted operation needs verification.'), answer('Recovered.'),
    ), ['read', 'write'], { toolProfile: 'lean-solo', taskProtocol: 3 });
    const file = path.join(root, 'target.txt');
    if (existing) writeFileSync(file, 'original content');
    const execute = app.coordinator.tools.execute.bind(app.coordinator.tools);
    let attempts = 0;
    vi.spyOn(app.coordinator.tools, 'execute').mockImplementation(async (...input) => {
      if (input[1] === 'file.apply_patch' && attempts++ === 0) {
        const mark = input[4];
        input[4] = () => { mark?.(); throw new Error('isolated failure after durable preparation and before replacement'); };
      }
      return await execute(...input);
    });
    const source = await app.run(runId);
    expect(source).toMatchObject({ status: 'failed', error: expect.stringMatching(/^UNKNOWN_WRITE:/) });
    const original = app.store.calls(runId).find(item => item.name === 'file.apply_patch')!;
    expect(JSON.parse(app.store.readBlob<{ arguments: string }>(original.requestRef).arguments)).not.toHaveProperty('expectedHash');
    expect(app.store.events(runId, { types: ['file.recovery.prepared'] })).toHaveLength(1);
    expect(existing ? readFileSync(file, 'utf8') : existsSync(file)).toBe(existing ? 'original content' : false);
    const plan = await app.reconcile(runId);
    expect(plan.blocked).toEqual([]);
    expect(plan.resolutions).toMatchObject([{ callId: original.id, outcome: 'not_applied', retryAuthorized: true, source: 'probe' }]);
    const recovered = await app.recover(runId);
    expect(recovered.status, recovered.error).toBe('completed');
    expect(attempts).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe('new content');
    expect(app.store.run(runId)).toEqual(source);
    expect(app.store.call(original.id)).toEqual(original);
  });

  it('keeps a hashless write unresolved when no preparation was persisted', async () => {
    const { app, runId } = fixture(scripted(calls(call('write', { path: 'target.txt', content: 'new content' })), answer('Needs verification.')),
      ['read', 'write'], { toolProfile: 'lean-solo', taskProtocol: 3 });
    const execute = app.coordinator.tools.execute.bind(app.coordinator.tools);
    vi.spyOn(app.coordinator.tools, 'execute').mockImplementation(async (...input) => {
      if (input[1] === 'file.apply_patch') { input[4]?.(); throw new Error('isolated missing preparation fixture'); }
      return await execute(...input);
    });
    expect((await app.run(runId)).status).toBe('failed');
    const original = app.store.calls(runId).find(item => item.name === 'file.apply_patch')!;
    const plan = await app.reconcile(runId);
    expect(plan.blocked).toEqual([original.id]);
    expect(plan.resolutions).toEqual([]);
    expect(plan.observations[0]?.evidence).toContain('No preparation evidence');
  });
});
