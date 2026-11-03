import { describe, expect, it } from 'vitest';
import type { Call, Message, Run } from '../src/runtime/types.js';
import { buildContext } from '../src/runtime/context.js';
import { binding, fixture } from './helpers.js';
import { Tools } from '../src/tools/index.js';

describe('managed run inspection', () => {
  function setup(toolNames?: string[]) {
    const f = fixture();
    const { app } = f;
    const runId = toolNames ? app.createRun({ objective: 'Inspect process evidence.', workspace: f.root, binding, card: app.parseCard(`---
schema_version: 1
id: test/process-inspection
version: 1.0.0
name: Process inspection
description: Inspect approved process output.
capabilities:
  tools: ${JSON.stringify(toolNames)}
---
Report the captured output.
`) }).id : f.runId;
    const invoke = (who: string, name: string, args: Record<string, unknown>) => {
      const run = app.store.run(who);
      return app.store.transaction(() => app.coordinator.mailbox.execute(run, name, name, app.coordinator.mailbox.validate(run, name, JSON.stringify(args)))) as Record<string, unknown>;
    };
    const spawn = (args: Record<string, unknown> = {}) => invoke(runId, 'spawn_agent', { objective: 'independent evidence', scope: { write: [] }, ...args }).id as string;
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

  it('inherits the parent card and rejects removed card selectors without creating a child', () => {
    const { app, runId, spawn } = setup();
    expect(() => spawn({ card_id: 'missing/agent', card_version: '1.0.0' })).toThrow(/unknown field "card_id"/);
    expect(() => spawn({ card_id: 'invented' })).toThrow(/unknown field "card_id"/);
    expect(app.store.listRuns()).toHaveLength(1);
    const inherited = app.store.run(spawn()).card;
    const parentCard = app.store.run(runId).card;
    // Children keep the exact parent card identity, tool list and digest.
    expect(inherited).toMatchObject({ id: parentCard.id, version: parentCard.version, digest: parentCard.digest });
    expect(inherited.tools).toEqual(parentCard.tools);
    const main = JSON.stringify(app.store.readBlob<Message[]>(app.store.run(runId).contextRef));
    const sub = JSON.stringify(app.store.readBlob<Message[]>(app.store.run(spawn()).contextRef));
    // Delegation guidance is main-only; the removed explore workflow is no longer advertised.
    expect(main).toContain('fork_of continues a settled child');
    expect(sub).not.toContain('fork_of continues a settled child');
    expect(main).not.toContain('Use explore for read-only investigation');
  });

  it.each(['process.exec', 'process.run'])('pages complete %s capture without splitting Unicode and separates execution, exit and acceptance', name => {
    const { app, runId, invoke, spawn, evidence } = setup();
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, permissions: ['read', 'write', 'exec'] });
    app.store.updateRun(runId, { permissions: ['read', 'write', 'exec'] });
    const peer = spawn();
    const output = { stdout: 'x'.repeat(244) + '😀'.repeat(300), stderr: 'test failed', exitCode: 1, truncated: false, cancelled: false, outputLimitExceeded: false };
    const artifact = app.store.artifact(peer, app.store.blob({ name: 'process-output', content: JSON.stringify(output) }));
    const proof = evidence(peer, name, { ...output, stdout: 'preview', truncated: true, outputArtifact: { id: artifact } });
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
    app.store.updateRun(runId, { permissions: name === 'process.exec' ? ['read'] : [] });
    expect(() => invoke(runId, 'inspect_run', { run_id: peer, call_id: proof })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
  });

  it('restores actual long process.run output through paginated inspection with only read permission', async () => {
    const { app, runId, invoke, spawn, evidence } = setup(['process.run']);
    const peer = spawn();
    const stdout = '中文😀'.repeat(3000);
    const command = { program: process.execPath, args: ['-e', 'process.stdout.write("中文😀".repeat(3000))'] };
    const tools = new Tools(app.store, [command]);
    const value = await tools.execute(peer, 'process.run', command, new AbortController().signal);
    expect(value).toMatchObject({ truncated: true, outputArtifact: { id: expect.any(String) } });
    const proof = evidence(peer, 'process.run', value);
    let cursor: Record<string, unknown> | null = { run_id: peer, call_id: proof, max_chars: 1024 };
    let restored = '';
    while (cursor) {
      const page = invoke(runId, 'inspect_run', cursor) as { evidence: { text: string; next: Record<string, unknown> | null } };
      expect(page).toMatchObject({ exitCode: 0, outputComplete: true });
      restored += page.evidence.text;
      cursor = page.evidence.next;
    }
    expect(JSON.parse(restored)).toMatchObject({ stdout, stderr: '', truncated: false });
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

  it.each(['process.exec', 'process.run'])('keeps child evidence readable after compaction and rejects an unrelated %s artifact', name => {
    const { app, runId, invoke, spawn, evidence } = setup();
    const peer = spawn();
    const proof = evidence(peer, 'file.read', { content: 'durable child proof' });
    const run = app.store.run(runId);
    const messages = app.store.readBlob<Message[]>(run.contextRef);
    const maxChars = JSON.stringify({ messages, tools: [] }).length + 8_000;
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'large', name: 'file.read', arguments: '{}' }] }, { role: 'tool', tool_call_id: 'large', content: 'large historic output '.repeat(2000) });
    app.store.updateRun(runId, { contextRef: app.store.blob(messages) });
    const built = buildContext(app.store, app.store.run(runId), maxChars, []);
    expect(built.archivedRef).toBeDefined();
    app.store.updateRun(runId, { contextRef: app.store.blob(built.messages) });
    app.store.event(runId, 'context.compacted', { archivedRef: built.archivedRef });
    expect(invoke(runId, 'inspect_run', { run_id: peer, call_id: proof })).toMatchObject({ evidence: { text: '{"content":"durable child proof"}' } });
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, permissions: ['read', 'exec'] });
    app.store.updateRun(runId, { permissions: ['read', 'exec'] });
    const sibling = spawn();
    const foreignArtifact = app.store.artifact(sibling, app.store.blob({ name: 'process-output', content: '{"stdout":"unrelated"}' }));
    const forged = evidence(peer, name, { outputArtifact: { id: foreignArtifact } });
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
