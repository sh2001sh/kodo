import { describe, expect, it } from 'vitest';
import type { Call, Message, Run } from '../src/runtime/types.js';
import { buildContext } from '../src/runtime/context.js';
import { fixture } from './helpers.js';

describe('managed run inspection', () => {
  function setup() {
    const { app, runId } = fixture();
    const invoke = (who: string, name: string, args: Record<string, unknown>) => {
      const run = app.store.run(who);
      return app.store.transaction(() => app.coordinator.mailbox.execute(run, name, name, app.coordinator.mailbox.validate(run, name, JSON.stringify(args)))) as Record<string, unknown>;
    };
    const spawn = (args: Record<string, unknown> = {}) => invoke(runId, 'spawn_agent', { objective: 'independent evidence', ...args }).id as string;
    const evidence = (owner: string, name: string, value: unknown, extra: Partial<Call> = {}) => {
      const id = `evidence-${app.store.calls(owner).length}`;
      app.store.putCall({ id, runId: owner, step: 0, kind: 'tool', name, effect: 'read', status: 'succeeded', requestRef: app.store.blob({ arguments: 'PRIVATE INPUT' }), resultRef: app.store.blob(value), reservedTokens: 0, ...extra });
      return id;
    };
    return { app, runId, invoke, spawn, evidence };
  }

  it('reads archive-free child results and actual tool evidence without exposing internal references or model records', () => {
    const { app, runId, invoke, spawn, evidence } = setup();
    const peer = spawn();
    app.store.updateRun(peer, { status: 'completed', resultRef: app.store.blob({ text: 'child conclusion', quality: { status: 'not_checked' } }) });
    const proof = evidence(peer, 'file.read', { content: 'ACTUAL PROOF' });
    evidence(peer, 'private-model', { reasoning: 'PRIVATE REASONING' }, { id: 'private-model', kind: 'model' });
    const listing = invoke(runId, 'list_agents', {});
    expect(JSON.stringify(listing)).not.toContain('resultRef');
    expect(listing).toMatchObject({ agents: expect.arrayContaining([expect.objectContaining({ id: peer, resultAvailable: true })]) });
    const summary = invoke(runId, 'inspect_run', { run_id: peer });
    expect(summary).toMatchObject({ runId: peer, status: 'completed', quality: { status: 'not_checked' }, result: { text: 'child conclusion', complete: true }, calls: [{ id: proof, name: 'file.read', status: 'succeeded' }] });
    expect(invoke(runId, 'inspect_run', { run_id: peer, call_id: proof })).toMatchObject({ call: { id: proof, status: 'succeeded' }, evidence: { text: JSON.stringify({ content: 'ACTUAL PROOF' }) } });
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|Ref/);
    expect(() => invoke(runId, 'inspect_run', { run_id: peer, call_id: 'private-model' })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
    expect(app.store.events(peer).some(e => e.type === 'context.compacted')).toBe(false);
  });

  it('rejects foreign, sibling, unmanaged and forged call ownership and revoked read permission', () => {
    const { app, runId, invoke, spawn, evidence } = setup();
    const peer = spawn();
    const sibling = spawn();
    const proof = evidence(peer, 'file.read', { content: 'owned' });
    const other = app.createRun({ objective: 'foreign', workspace: app.store.session(app.store.run(runId).sessionId).workspace, binding: app.store.run(runId).binding });
    expect(() => invoke(runId, 'inspect_run', { run_id: other.id })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
    expect(() => invoke(sibling, 'inspect_run', { run_id: peer })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
    expect(() => invoke(runId, 'inspect_run', { run_id: sibling, call_id: proof })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
    const detached: Run = { ...app.store.run(peer), id: 'unmanaged', parentId: 'someone-else' };
    app.store.putRun(detached);
    expect(() => invoke(runId, 'inspect_run', { run_id: detached.id })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
    app.store.updateRun(runId, { permissions: [] });
    expect(() => invoke(runId, 'inspect_run', { run_id: peer })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
  });

  it('inherits registered cards and explains how to correct an invalid card without creating a child', () => {
    const { app, runId, invoke, spawn } = setup();
    expect(() => spawn({ card_id: 'invented', card_version: '1' })).toThrow(/omit both card_id and card_version/);
    expect(() => spawn({ card_id: 'invented' })).toThrow(/omit both/);
    expect(app.store.listRuns()).toHaveLength(1);
    expect(app.store.run(spawn()).card).toEqual(app.store.run(runId).card);
    const main = JSON.stringify(app.store.readBlob<Message[]>(app.store.run(runId).contextRef));
    const sub = JSON.stringify(app.store.readBlob<Message[]>(app.store.run(spawn()).contextRef));
    expect(main).toContain('coordination cost');
    expect(sub).not.toContain('coordination cost');
    expect(invoke(runId, 'list_agents', {})).toHaveProperty('agents');
  });

  it('pages complete process capture without splitting Unicode and separates execution, exit and acceptance', () => {
    const { app, runId, invoke, spawn, evidence } = setup();
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, permissions: ['read', 'write', 'exec'] });
    app.store.updateRun(runId, { permissions: ['read', 'write', 'exec'] });
    const peer = spawn();
    const output = { stdout: 'x'.repeat(244) + '😀'.repeat(300), stderr: 'test failed', exitCode: 1, truncated: false, cancelled: false, outputLimitExceeded: false };
    const artifact = app.store.artifact(peer, app.store.blob({ name: 'process-output', content: JSON.stringify(output) }));
    const proof = evidence(peer, 'process.exec', { ...output, stdout: 'preview', truncated: true, outputArtifact: { id: artifact } });
    let cursor: Record<string, unknown> | null = { run_id: peer, call_id: proof, max_chars: 256 };
    let restored = '';
    while (cursor) {
      const value = invoke(runId, 'inspect_run', cursor) as { evidence: { text: string; next: Record<string, unknown> | null }; exitCode: number; outputComplete: boolean; call: { status: string } };
      expect(value).toMatchObject({ exitCode: 1, outputComplete: true, call: { status: 'succeeded' } });
      expect(value.evidence.text).not.toMatch(/[\uD800-\uDBFF]$/);
      restored += value.evidence.text;
      cursor = value.evidence.next;
    }
    expect(JSON.parse(restored)).toEqual(output);
    const split = JSON.stringify(output).indexOf('😀') + 1;
    expect(() => invoke(runId, 'inspect_run', { run_id: peer, call_id: proof, content_offset: split })).toThrowError(expect.objectContaining({ code: 'INSPECT_CURSOR' }));
    expect(() => invoke(runId, 'inspect_run', { run_id: peer, call_id: proof, content_offset: restored.length + 1 })).toThrowError(expect.objectContaining({ code: 'INSPECT_CURSOR' }));
    app.store.updateRun(runId, { permissions: ['read'] });
    expect(() => invoke(runId, 'inspect_run', { run_id: peer, call_id: proof })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
  });

  it('pages call indexes, redacts the bound credential, and grants recovery history only with its durable audit', () => {
    const { app, runId, invoke, spawn, evidence } = setup();
    const peer = spawn();
    const a = evidence(peer, 'file.read', { content: 'first' });
    const b = evidence(peer, 'file.read', { content: 'second' });
    expect(invoke(runId, 'inspect_run', { run_id: peer, limit: 1 })).toMatchObject({ calls: [{ id: a }], next: { run_id: peer, offset: 1, limit: 1 } });
    expect(invoke(runId, 'inspect_run', { run_id: peer, offset: 1, limit: 1 })).toMatchObject({ calls: [{ id: b }], next: null });
    const envName = app.store.run(runId).binding.apiKeyEnv;
    const prior = process.env[envName];
    try {
      process.env[envName] = 'inspection-private-fixture-credential';
      const proof = evidence(peer, 'file.read', { content: process.env[envName] });
      expect(JSON.stringify(invoke(runId, 'inspect_run', { run_id: peer, call_id: proof }))).not.toContain(process.env[envName]);
    } finally { if (prior === undefined) delete process.env[envName]; else process.env[envName] = prior; }
    const successor: Run = { ...app.store.run(runId), id: 'main-recovery', continuationOf: runId };
    app.store.putRun(successor);
    expect(() => invoke(successor.id, 'inspect_run', { run_id: peer })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
    app.store.event(runId, 'recovery.continued', { runId: successor.id });
    expect(invoke(successor.id, 'inspect_run', { run_id: peer })).toMatchObject({ runId: peer });
  });

  it('keeps child evidence readable after the main context is compacted and rejects an unrelated process artifact', () => {
    const { app, runId, invoke, spawn, evidence } = setup();
    const peer = spawn();
    const proof = evidence(peer, 'file.read', { content: 'durable child proof' });
    const run = app.store.run(runId);
    const messages = app.store.readBlob<Message[]>(run.contextRef);
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'large', name: 'file.read', arguments: '{}' }] }, { role: 'tool', tool_call_id: 'large', content: 'large historic output '.repeat(2000) });
    app.store.updateRun(runId, { contextRef: app.store.blob(messages) });
    const built = buildContext(app.store, app.store.run(runId), 8000, []);
    expect(built.archivedRef).toBeDefined();
    app.store.updateRun(runId, { contextRef: app.store.blob(built.messages) });
    app.store.event(runId, 'context.compacted', { archivedRef: built.archivedRef });
    expect(invoke(runId, 'inspect_run', { run_id: peer, call_id: proof })).toMatchObject({ evidence: { text: '{"content":"durable child proof"}' } });
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, permissions: ['read', 'exec'] });
    app.store.updateRun(runId, { permissions: ['read', 'exec'] });
    const sibling = spawn();
    const foreignArtifact = app.store.artifact(sibling, app.store.blob({ name: 'process-output', content: '{"stdout":"unrelated"}' }));
    const forged = evidence(peer, 'process.exec', { outputArtifact: { id: foreignArtifact } });
    expect(() => invoke(runId, 'inspect_run', { run_id: peer, call_id: forged })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
  });

  it.each(['before-wait', 'after-wait'])('injects one bounded summary and no duplicate wake result (%s)', order => {
    const { app, runId, invoke, spawn } = setup();
    const peer = spawn();
    const finish = () => {
      app.store.updateRun(peer, { status: 'completed', resultRef: app.store.blob({ text: 'UNIQUE CHILD RESULT' + 'x'.repeat(8000), quality: { status: 'not_checked' } }) });
      app.coordinator.mailbox.onTerminal(peer);
    };
    if (order === 'before-wait') finish();
    invoke(runId, 'wait_for_events', { run_ids: [peer] });
    if (order === 'after-wait') finish();
    const messages = app.store.messages(app.store.run(runId).sessionId);
    const notification = JSON.parse(messages.find(m => m.id === `terminal:${peer}`)!.content);
    expect(notification).toMatchObject({ runId: peer, quality: { status: 'not_checked' }, inspect: { run_id: peer }, summaryTruncated: true });
    expect(notification.summary.length).toBeLessThanOrEqual(1200);
    const wake = JSON.parse(messages.find(m => m.id.startsWith('wake:'))!.content);
    expect(wake.details).toEqual([{ runId: peer, status: 'completed', decisionVersion: 0, ready: true }]);
    expect(messages.filter(m => m.content.includes('UNIQUE CHILD RESULT'))).toHaveLength(1);
    expect(invoke(runId, 'inspect_run', { run_id: peer, content_offset: 1200 })).toMatchObject({ result: { contentOffset: 1200 } });
  });
});
