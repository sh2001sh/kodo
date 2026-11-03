import { storageTestConnection } from '../src/storage/test-access.js';
import { describe, expect, it } from 'vitest';
import { CaseRunStore, caseDigest, freezeCase, runCase } from '../src/cases/index.js';
import type { CaseRun } from '../src/cases/index.js';
import { answer, binding, fixture, scripted, temp } from './helpers.js';

const definition = { schema_version: 1, id: 'gc/evidence', version: '1.0.0', name: 'GC evidence', objective: 'Produce preserved evidence.', inputs: { files: [] }, assertions: [{ type: 'output', equals: 'verified' }] };
const old = new Date(Date.now() - 30 * 86_400_000).toISOString();

describe('case evidence garbage collection', () => {
  it('preserves an associated run and complete nested history while collecting unrelated old sessions and blobs', async () => {
    const { app, runId, root } = fixture(scripted(answer('verified')));
    const cases = new CaseRunStore(app.store);
    const result = await runCase({ store: cases, definition, workspace: temp(), target: { id: 'local/gc', version: '1.0.0', digest: caseDigest('package'), cardDigest: app.store.run(runId).card.digest }, binding, permissions: ['read'], hostPolicyDigest: caseDigest('host'), execute: async () => {
      const run = await app.run(runId);
      return { runId, status: run.status, output: app.store.readBlob<{ text: string }>(run.resultRef!).text };
    } });
    const nested = app.store.blob({ originalEvidence: 'only reachable through an archived reference' });
    const archive = app.store.blob({ nested: JSON.stringify({ ref: nested }) });
    const callResult = app.store.blob({ rawOutput: 'complete independent tool output', archive });
    const callRequest = app.store.blob({ exact: 'original tool arguments' });
    app.store.putCall({ id: 'case-tool-evidence', runId, step: 5, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', requestRef: callRequest, resultRef: callResult, reservedTokens: 0 });
    const unrelated = app.createRun({ objective: 'unrelated', workspace: root, binding });
    const unrelatedResult = app.store.blob({ unrelated: 'expired session' }); app.store.updateRun(unrelated.id, { status: 'completed', resultRef: unrelatedResult });
    const orphan = app.store.blob({ orphan: 'collect me' });
    for (const session of app.store.sessionsPage().items) app.store.putSession({ ...session, createdAt: old });
    storageTestConnection(app.store).prepare('UPDATE events SET time=?').run(old);
    expect(app.store.gc({ olderThanDays: 2 })).toMatchObject({ removedSessions: 1 });
    expect(app.store.run(runId).status).toBe('completed');
    expect(() => app.store.run(unrelated.id)).toThrow('not found');
    const retained = [app.store.run(runId).contextRef, app.store.run(runId).resultRef!, callRequest, callResult, archive, nested];
    for (const ref of retained) expect(app.store.hasBlob(ref)).toBe(true);
    for (const ref of [orphan, unrelatedResult]) expect(app.store.hasBlob(ref)).toBe(false);
    expect(cases.get(result.id)).toEqual(result);
    expect(app.store.calls(runId).some(call => call.id === 'case-tool-evidence')).toBe(true);
  });

  it.each(['failed', 'interrupted'] as const)('preserves sessions linked by %s case records without retaining unassociated sessions', status => {
    const { app, runId, root } = fixture(); const cases = new CaseRunStore(app.store);
    const frozen = freezeCase(definition);
    const conditions: CaseRun['conditions'] = { model: { model: binding.model, baseURL: binding.baseURL }, environment: { platform: process.platform, arch: process.arch, node: process.versions.node }, permissions: ['read'], policyDigest: caseDigest('policy') };
    const pending: CaseRun = { id: `case-${status}`, case: frozen.definition, caseDigest: frozen.digest, inputDigest: frozen.inputDigest, target: { id: 'local/gc', version: '1.0.0', digest: caseDigest('package'), cardDigest: app.store.run(runId).card.digest }, conditions, conditionsDigest: caseDigest(conditions), workspace: root, status: 'running', startedAt: old, assertions: [] };
    cases.start(pending);
    cases.finish({ ...pending, status, completedAt: old, execution: { runId, status: 'failed', outputDigest: caseDigest('partial') }, error: 'original failure retained' });
    const unrelated = app.createRun({ objective: 'no case association', workspace: root, binding });
    for (const run of [app.store.run(runId), unrelated]) { app.store.updateRun(run.id, { status: 'failed' }); app.store.putSession({ ...app.store.session(run.sessionId), createdAt: old }); }
    storageTestConnection(app.store).prepare('UPDATE events SET time=?').run(old);
    expect(app.store.gc({ olderThanDays: 2 }).removedSessions).toBe(1);
    expect(app.store.run(runId).status).toBe('failed'); expect(() => app.store.run(unrelated.id)).toThrow('not found');
    expect(cases.get(pending.id).status).toBe(status);
  });

  it('retains an execution attached before a timeout even when the execution callback never returns', async () => {
    const { app, runId, root } = fixture(); const cases = new CaseRunStore(app.store);
    const result = await runCase({ store: cases, definition: { ...definition, timeoutMs: 10 }, workspace: temp(), target: { id: 'local/gc', version: '1.0.0', digest: caseDigest('package'), cardDigest: app.store.run(runId).card.digest }, binding, permissions: ['read'], hostPolicyDigest: caseDigest('host'), execute: async input => { input.recordExecution?.(runId); return await new Promise(() => {}); } });
    expect(result.status).toBe('failed'); expect(result.execution?.runId).toBe(runId);
    app.store.updateRun(runId, { status: 'failed' });
    app.store.putSession({ ...app.store.session(app.store.run(runId).sessionId), createdAt: old });
    const unrelated = app.createRun({ objective: 'unrelated timeout record', workspace: root, binding });
    app.store.updateRun(unrelated.id, { status: 'completed' }); app.store.putSession({ ...app.store.session(unrelated.sessionId), createdAt: old });
    storageTestConnection(app.store).prepare('UPDATE events SET time=?').run(old);
    expect(app.store.gc({ olderThanDays: 2 }).removedSessions).toBe(1);
    expect(app.store.run(runId).status).toBe('failed'); expect(() => app.store.run(unrelated.id)).toThrow('not found');
  });

  it('marks nested blob references stored only in case inputs and preserves ordinary GC when case tables are absent', () => {
    const { app, runId, root } = fixture(); const cases = new CaseRunStore(app.store);
    app.store.gc();
    const leaf = app.store.blob({ durable: 'case-only reference' }); const parent = app.store.blob({ encoded: JSON.stringify({ leaf }) });
    const frozen = freezeCase({ ...definition, inputs: { files: [], data: { reference: parent } } });
    const conditions: CaseRun['conditions'] = { model: { model: binding.model, baseURL: binding.baseURL }, environment: { platform: process.platform, arch: process.arch, node: process.versions.node }, permissions: ['read'], policyDigest: caseDigest('policy') };
    const pending: CaseRun = { id: 'case-nested', case: frozen.definition, caseDigest: frozen.digest, inputDigest: frozen.inputDigest, target: { id: 'local/gc', version: '1.0.0', digest: caseDigest('package'), cardDigest: app.store.run(runId).card.digest }, conditions, conditionsDigest: caseDigest(conditions), workspace: root, status: 'running', startedAt: old, assertions: [] };
    cases.start(pending); cases.finish({ ...pending, status: 'failed', completedAt: old, error: 'failed before creating an execution' });
    const orphan = app.store.blob({ orphan: true });
    expect(app.store.gc().removedBlobs).toBe(1);
    expect(app.store.readBlob(parent)).toEqual({ encoded: JSON.stringify({ leaf }) }); expect(app.store.readBlob(leaf)).toEqual({ durable: 'case-only reference' });
    expect(app.store.hasBlob(orphan)).toBe(false);
    storageTestConnection(app.store).exec('DROP TABLE case_runs; DROP TABLE case_definitions');
    expect(app.store.gc().removedBlobs).toBe(2);
  });
});
