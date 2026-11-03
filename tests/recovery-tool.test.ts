import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolRegistration } from '../src/tools/registry.js';
import { answer, binding, call, calls, fixture, scripted } from './helpers.js';

function allowProbe(app: ReturnType<typeof fixture>['app'], runId: string): void {
  const run = app.store.run(runId);
  const card = { ...run.card, tools: [...run.card.tools, 'probe.write'] };
  app.store.updateRun(runId, { card, toolBindings: app.coordinator.tools.bindingSnapshot(card.tools) });
}

function probe(onStart: () => void): ToolRegistration {
  return { name: 'probe.write', description: 'Write an ordinary fixture receipt then lose the response.', permission: 'write', effect: 'write',
    parameters: { type: 'object', additionalProperties: false }, writeScope: () => ['receipt.txt'],
    execute(context) {
      onStart();
      writeFileSync(path.join(context.session.workspace, 'receipt.txt'), 'recorded');
      throw new Error('fixture response unavailable');
    },
  };
}

describe('in-run host recovery inspection', () => {
  it.each(['explicit', 'automatic'] as const)('uses %s host verification and continues without replaying the uncertain operation', async mode => {
    let executions = 0;
    let verifications = 0;
    const { app, root, runId } = fixture(scripted(
      calls(call('probe.write', {}, 'uncertain')),
      mode === 'explicit' ? calls(call('recovery.inspect', {})) : calls(call('file.apply_patch', { path: 'receipt.txt', expectedHash: null, content: 'must not run' }, 'blocked')),
      async request => {
        expect(app.store.unresolvedWrites(root)).toEqual([]);
        expect(JSON.stringify(request.messages)).toContain(mode === 'explicit' ? 'Fixture receipt verified' : 'Host verification resolved');
        expect(readFileSync(path.join(root, 'receipt.txt'), 'utf8')).toBe('recorded');
        return calls(call('file.apply_patch', { path: 'saved.txt', expectedHash: null, content: 'continued' }));
      }, answer('Host verified the receipt and subsequent work is saved.'),
    ), ['read', 'write'], { tools: [probe(() => { executions++; })] });
    allowProbe(app, runId);
    app.registerRecoveryVerifier('probe.write', () => {
      verifications++;
      expect(readFileSync(path.join(root, 'receipt.txt'), 'utf8')).toBe('recorded');
      return { outcome: 'succeeded', evidence: 'Fixture receipt verified from its saved content after the operation settled.', result: { receipt: 'recorded' } };
    });
    const final = await app.run(runId);
    expect(final.status, final.error).toBe('completed');
    expect(executions).toBe(1);
    expect(verifications).toBe(1);
    expect(readFileSync(path.join(root, 'saved.txt'), 'utf8')).toBe('continued');
    expect(app.store.events(runId, { types: ['recovery.resolved'] })).toHaveLength(1);
    expect(app.store.events(runId, { types: ['run.handoff'] })).toEqual([]);
  });

  it('allows host-declared process diagnostics, then hands off an unresolved blocked write immediately', async () => {
    const diagnostic = { program: process.execPath, args: ['-e', "console.log('diagnostic complete')"] };
    const { app, root, runId } = fixture(scripted(
      calls(call('probe.write', {})),
      calls(call('process.exec', diagnostic)),
      async request => {
        const output = JSON.parse(request.messages.findLast(message => message.role === 'tool')!.content);
        expect(output).toMatchObject({ exitCode: 0, stdout: 'diagnostic complete\n' });
        return calls(call('file.apply_patch', { path: 'receipt.txt', expectedHash: null, content: 'must not run' }));
      },
    ), ['read', 'write', 'exec'], { tools: [probe(() => {})], readOnlyCommands: [diagnostic] });
    allowProbe(app, runId);
    const final = await app.run(runId);
    expect(final).toMatchObject({ status: 'failed', error: expect.stringMatching(/^UNKNOWN_WRITE:/) });
    expect(final.error).toContain('No automatic verifier');
    expect(app.store.calls(runId).filter(item => item.kind === 'model')).toHaveLength(3);
    expect(app.store.calls(runId).find(item => item.name === 'process.exec')).toMatchObject({ effect: 'read', status: 'succeeded' });
    expect(app.store.events(runId, { types: ['run.handoff'] })).toHaveLength(1);
    expect(app.store.unresolvedWrites(root)).toHaveLength(1);
    expect(readFileSync(path.join(root, 'receipt.txt'), 'utf8')).toBe('recorded');
    expect(app.coordinator.tools.effect('process.exec', { program: 'pgrep', args: ['-af', 'pytest'] })).toBe('read');
  });

  it('still saves private artifacts while a workspace effect is unresolved', async () => {
    // FastAPI run step 86: artifact.write was refused with UNKNOWN_WRITE although artifacts never touch workspace files.
    const { app, root, runId } = fixture(scripted(
      calls(call('probe.write', {})),
      calls(call('artifact.write', { name: 'handoff', content: 'Remaining work: full suite and commit.' }, 'save')),
      async request => {
        const output = JSON.parse(request.messages.findLast(message => message.role === 'tool')!.content);
        expect(output.error).toBeUndefined();
        expect(output.id).toEqual(expect.any(String));
        return answer('Saved the handoff; the uncertain receipt still needs host verification.');
      },
    ), ['read', 'write'], { tools: [probe(() => {})] });
    allowProbe(app, runId);
    const final = await app.run(runId);
    expect(app.store.calls(runId).find(item => item.name === 'artifact.write')).toMatchObject({ status: 'succeeded' });
    expect(app.store.unresolvedWrites(root)).toHaveLength(1);
    // Completion still refuses to hide the unresolved effect.
    expect(final).toMatchObject({ status: 'failed', error: expect.stringMatching(/^UNKNOWN_WRITE:/) });
  });

  it('returns an empty inspection when no effect needs verification', async () => {
    const { app, runId } = fixture(scripted(calls(call('recovery.inspect', {})), answer()));
    expect((await app.run(runId)).status).toBe('completed');
    const inspection = app.store.calls(runId).find(item => item.name === 'recovery.inspect')!;
    expect(app.store.readBlob(inspection.resultRef!)).toMatchObject({ sourceRunId: runId, blocked: [], observations: [] });
  });

  it('reports a foreign run effect without invoking its verifier', async () => {
    const { app, root, runId } = fixture(scripted(calls(call('probe.write', {})), answer()), ['read', 'write'], { tools: [probe(() => {})] });
    allowProbe(app, runId);
    expect((await app.run(runId)).error).toMatch(/^UNKNOWN_WRITE:/);
    let verified = false;
    app.registerRecoveryVerifier('probe.write', () => { verified = true; return { outcome: 'succeeded', evidence: 'Fixture operation verified by the owning host.' }; });
    const other = app.createRun({ objective: 'Inspect the workspace.', workspace: root, binding, permissions: ['read'] });
    const result = await app.coordinator.tools.execute(other.id, 'recovery.inspect', {}, new AbortController().signal) as { blocked: string[]; observations: { evidence: string }[] };
    expect(result.blocked).toEqual(app.store.unresolvedWrites(root).map(item => item.id));
    expect(result.observations[0]?.evidence).toContain('another run');
    expect(verified).toBe(false);
    expect(existsSync(path.join(root, 'receipt.txt'))).toBe(true);
  });
});
