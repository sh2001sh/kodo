import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { KodoError } from '../src/runtime/types.js';
import type { Message, Provider } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, scripted, temp } from './helpers.js';

describe('execution quality and accounting', () => {
  it('releases known-zero 429 reservations while counting every attempt', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      if (++attempts < 3) throw new KodoError('MODEL_RATE_LIMIT', 'limited', { status: 429, usageKnownZero: true, retryAfterMs: 0 });
      return answer();
    } });
    const run = await app.run(runId);
    expect(run.status).toBe('completed');
    expect(app.store.session(run.sessionId)).toMatchObject({ tokens: 80, modelCalls: 3, usageEstimated: false });
    expect(app.store.events(runId).filter(event => event.type === 'model.failed').every(event => event.data.usageKnownZero === true)).toBe(true);
  });

  it('retains unknown failed usage rather than treating it as free', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      if (++attempts === 1) throw new KodoError('MODEL_TRANSPORT', 'disconnected', { retryAfterMs: 0 });
      return answer();
    } });
    const run = await app.run(runId);
    expect(run.status).toBe('completed');
    expect(app.store.session(run.sessionId).tokens).toBeGreaterThan(80);
    expect(app.store.session(run.sessionId).usageEstimated).toBe(true);
  });

  it('still stops known-zero retries at the model-call budget', async () => {
    const { app, runId } = fixture({ async complete() { throw new KodoError('MODEL_RATE_LIMIT', 'limited', { status: 429, usageKnownZero: true, retryAfterMs: 0 }); } });
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxModelCalls: 2 } });
    const run = await app.run(runId);
    expect(run.error).toContain('MODEL_BUDGET');
    expect(app.store.session(session.id)).toMatchObject({ modelCalls: 2, tokens: 0, usageEstimated: false });
  });

  it('uses the provider retry delay and permits cancellation while waiting', async () => {
    const { app, runId } = fixture({ async complete() { throw new KodoError('MODEL_RATE_LIMIT', 'limited', { usageKnownZero: true, retryAfterMs: 60_000 }); } });
    app.store.subscribe(event => { if (event.type === 'model.retry') app.coordinator.cancel(runId); });
    expect((await app.run(runId)).status).toBe('cancelled');
    expect(app.store.events(runId).find(event => event.type === 'model.retry')?.data.delayMs).toBe(60_000);
    expect(app.store.calls(runId).filter(item => item.kind === 'model')).toHaveLength(1);
  });

  it('warns after three identical reads and blocks an unchanged fourth call', async () => {
    const request = calls(call('file.read', { path: 'proof.txt' }));
    const { app, root, runId } = fixture(scripted(request, request, request, async input => {
      expect(input.messages.some(item => item.content?.startsWith('Runtime progress check:'))).toBe(true);
      return request;
    }));
    writeFileSync(path.join(root, 'proof.txt'), 'unchanged');
    expect((await app.run(runId)).error).toContain('TOOL_STALLED');
    expect(app.store.session(app.store.run(runId).sessionId).toolCalls).toBe(3);
    expect(app.store.events(runId).filter(event => event.type === 'tool.repetition_warning')).toHaveLength(1);
  });

  it('still detects unchanged repeats after a user decision advances the version', async () => {
    const request = calls(call('file.read', { path: 'proof.txt' }));
    const { app, root, runId } = fixture(scripted(request, request, request, request, answer()));
    writeFileSync(path.join(root, 'proof.txt'), 'unchanged under version one');
    app.submitInput(runId, 'Use read-only evidence for this decision', { decision: true });
    expect((await app.run(runId)).error).toContain('TOOL_STALLED');
    expect(app.store.session(app.store.run(runId).sessionId).toolCalls).toBe(3);
    expect(app.store.calls(runId).filter(item => item.kind === 'tool').every(item => item.decisionVersion === 1)).toBe(true);
  });

  it('allows repeated reads when the observed file content changes', async () => {
    const { app, root, runId } = fixture();
    let attempts = 0;
    const provider: Provider = { async complete() {
      if (++attempts > 4) return answer();
      writeFileSync(path.join(root, 'proof.txt'), `revision ${attempts}`);
      return calls(call('file.read', { path: 'proof.txt' }));
    } };
    // A new application gets the provider through its normal public constructor.
    const directory = temp();
    const other = new Application(path.join(directory, 'state'), provider);
    try {
      const run = other.createRun({ objective: 'Observe changing evidence', workspace: root, binding });
      expect((await other.run(run.id)).status).toBe('completed');
      expect(other.store.events(run.id).some(event => event.type === 'tool.stalled')).toBe(false);
    } finally { other.close(); }
    expect(app.store.run(runId).status).toBe('queued');
  });

  it('counts repeated nonzero process exits despite differing runner text', async () => {
    const result = calls(call('process.exec', { program: process.execPath, args: ['-e', 'console.error(Date.now());process.exit(2)'] }));
    const { app, runId } = fixture(scripted(result, result, result, result), ['read', 'exec']);
    expect((await app.run(runId)).error).toContain('TOOL_STALLED');
    expect(app.store.session(app.store.run(runId).sessionId).toolCalls).toBe(3);
  });

  it('allows successful silent processes to make four distinct writes with identical output', async () => {
    const request = calls(call('process.exec', { program: process.execPath, args: ['-e', "require('node:fs').appendFileSync('counter.txt','x')"] }));
    const { app, root, runId } = fixture(scripted(request, request, request, request, answer('four writes completed')), ['read', 'exec']);
    expect((await app.run(runId)).status).toBe('completed');
    expect(readFileSync(path.join(root, 'counter.txt'), 'utf8')).toBe('xxxx');
    expect(app.store.session(app.store.run(runId).sessionId).toolCalls).toBe(4);
    expect(app.store.events(runId).some(event => event.type === 'tool.stalled')).toBe(false);
  });

  it('uses the parent measured input when preserving its response reserve for a child', async () => {
    const { app, runId } = fixture(scripted(answer('child completed within the shared budget')));
    const initial = app.store.run(runId);
    const session = app.store.session(initial.sessionId);
    session.budget = { ...session.budget, maxTokens: 32_000, maxOutputTokens: 2048 };
    const messages: Message[] = [...app.store.readBlob<Message[]>(initial.contextRef), { role: 'assistant', content: 'previously measured context '.repeat(2_000) }];
    const parent = app.store.updateRun(runId, { contextRef: app.store.blob(messages), step: 1 });
    const tools = [...app.coordinator.tools.specs(parent.card.tools, session), ...app.coordinator.mailbox.specs(parent)];
    expect(Buffer.byteLength(JSON.stringify({ messages, tools }))).toBeGreaterThan(32_000);
    app.store.putCall({ id: 'measured-parent-context', runId, step: 0, kind: 'model', name: parent.binding.model, status: 'succeeded', effect: 'read', requestRef: app.store.blob({ binding: parent.binding, messages, tools, maxOutputTokens: session.budget.maxOutputTokens }), resultRef: app.store.blob(answer('previous measured answer')), reservedTokens: 0, decisionVersion: 0 });
    app.store.putSession({ ...session, tokens: 80, modelCalls: 1 });
    const child = app.store.transaction(() => app.coordinator.mailbox.execute(parent, 'spawn-for-budget', 'spawn_agent', { objective: 'Complete the delegated check' }) as { id: string });
    expect((await app.coordinator.wake(child.id)).status).toBe('completed');
    expect(app.store.run(runId).status).toBe('queued');
    expect(app.store.session(session.id).modelCalls).toBe(2);
  });

  it('returns failed host checks to the model and records a corrected delivery', async () => {
    const { app, runId } = fixture(scripted(answer('missing evidence'), async request => {
      expect(request.messages.some(item => item.content?.includes('Include the verified result'))).toBe(true);
      return answer('verified result');
    }));
    app.setCompletionValidator(runId, ({ response }) => ({ passed: response.message.content === 'verified result', feedback: 'Include the verified result', evidence: { check: 'fixture acceptance' } }));
    const run = await app.run(runId);
    expect(run.status).toBe('completed');
    expect(app.store.readBlob<{ quality: { status: string } }>(run.resultRef!).quality.status).toBe('passed');
    expect(app.store.events(runId).filter(event => event.type === 'completion.checked').map(event => event.data.passed)).toEqual([false, true]);
  });

  it('fails quality after two unsuccessful correction opportunities', async () => {
    const { app, runId } = fixture(scripted(answer(), answer(), answer()));
    app.setCompletionValidator(runId, () => ({ passed: false, feedback: 'Required evidence still missing' }));
    const run = await app.run(runId);
    expect(run.error).toContain('QUALITY_FAILED');
    expect(app.store.events(runId).filter(event => event.type === 'completion.correction_requested')).toHaveLength(2);
  });

  it('does not silently complete when a required validator is absent after restart', async () => {
    const directory = temp();
    const first = new Application(path.join(directory, 'state'), scripted(answer()));
    const run = first.createRun({ objective: 'Require durable acceptance', workspace: directory, binding });
    first.setCompletionValidator(run.id, () => ({ passed: true }));
    first.close();
    const second = new Application(path.join(directory, 'state'), scripted(answer()));
    try {
      expect((await second.run(run.id)).status).toBe('interrupted');
      expect(second.store.run(run.id).error).toContain('reattach');
      second.setCompletionValidator(run.id, () => ({ passed: true }));
      expect((await second.recover(run.id)).status).toBe('completed');
      expect(second.store.calls(run.id).filter(item => item.kind === 'model')).toHaveLength(1);
    } finally { second.close(); }
  });

  it('inherits a required validator across multiple audited recovery continuations', async () => {
    const { app, runId } = fixture(scripted(answer('verified after two recoveries')));
    let checkedRun = '';
    app.setCompletionValidator(runId, ({ run }) => { checkedRun = run.id; return { passed: true }; });
    const original = app.store.run(runId);
    const firstId = 'first-audited-recovery';
    const secondId = 'second-audited-recovery';
    app.store.transaction(() => {
      app.store.updateRun(runId, { status: 'failed', error: 'UNKNOWN_WRITE: reconciled original' });
      app.store.putRun({ ...original, id: firstId, continuationOf: runId, status: 'failed', error: 'UNKNOWN_WRITE: reconciled again' });
      app.store.event(runId, 'recovery.continued', { runId: firstId });
      app.store.putRun({ ...original, id: secondId, continuationOf: firstId, status: 'queued' });
      app.store.event(firstId, 'recovery.continued', { runId: secondId });
    });
    const result = await app.run(secondId);
    expect(result.status).toBe('completed');
    expect(checkedRun).toBe(secondId);
    expect(app.store.readBlob<{ quality: { status: string } }>(result.resultRef!).quality.status).toBe('passed');
  });

  it('discards a late validator result after cancellation while validation was pending', async () => {
    const { app, runId } = fixture(scripted(answer('candidate')));
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    app.setCompletionValidator(runId, async () => { entered(); await held; return { passed: false, feedback: 'A late result must not reopen cancellation' }; });
    const running = app.run(runId);
    await started;
    app.coordinator.cancel(runId);
    const cancelled = app.store.run(runId);
    release();
    expect((await running).status).toBe('cancelled');
    expect(app.store.run(runId).contextRef).toBe(cancelled.contextRef);
    expect(app.store.events(runId).some(event => ['completion.checked', 'completion.correction_requested', 'run.completed'].includes(event.type))).toBe(false);
  });

  it('does not mutate a cancelled run when a verdict event listener cancels before correction', async () => {
    const { app, runId } = fixture(scripted(answer('candidate')));
    app.setCompletionValidator(runId, () => ({ passed: false, feedback: 'Failed evidence' }));
    let cancelledContext = '';
    let cancelledStep = -1;
    app.store.subscribe(event => {
      if (event.type !== 'completion.checked') return;
      app.coordinator.cancel(runId);
      const cancelled = app.store.run(runId);
      cancelledContext = cancelled.contextRef;
      cancelledStep = cancelled.step;
    });
    expect((await app.run(runId)).status).toBe('cancelled');
    expect(app.store.run(runId)).toMatchObject({ contextRef: cancelledContext, step: cancelledStep });
    expect(app.store.events(runId).some(event => event.type === 'completion.correction_requested')).toBe(false);
  });

  it('gives a new user decision its own correction opportunities after a stale third failure', async () => {
    const { app, runId } = fixture(scripted(answer('old 1'), answer('old 2'), answer('old 3'), answer('new 1'), answer('new 2'), answer('new accepted')));
    let checks = 0;
    app.setCompletionValidator(runId, () => {
      checks++;
      if (checks === 3) app.submitInput(runId, 'Replace the old acceptance with this new decision', { decision: true });
      return { passed: checks === 6, feedback: 'Required evidence is missing for the inspected version' };
    });
    const run = await app.run(runId);
    expect(run.status).toBe('completed');
    expect(checks).toBe(6);
    expect(app.store.readBlob<{ text: string }>(run.resultRef!).text).toBe('new accepted');
    const newCorrections = app.store.events(runId).filter(event => event.type === 'completion.checked' && event.data.passed === false && event.data.decisionVersion === 1);
    expect(newCorrections).toHaveLength(2);
  });

  it('keeps unchecked completion separate from validated quality', async () => {
    const { app, runId } = fixture();
    const run = await app.run(runId);
    expect(app.store.readBlob<{ quality: { status: string } }>(run.resultRef!).quality.status).toBe('not_checked');
  });

  it('cannot hide newly arriving user input behind an accepted old response', async () => {
    const { app, runId } = fixture(scripted(answer('old'), answer('new')));
    let checks = 0;
    app.setCompletionValidator(runId, () => {
      if (++checks === 1) app.submitInput(runId, 'New acceptance constraint', { decision: true });
      return { passed: true };
    });
    const run = await app.run(runId);
    expect(run.status).toBe('completed');
    expect(app.store.readBlob<{ text: string }>(run.resultRef!).text).toBe('new');
    expect(checks).toBe(2);
  });

  it('uses a stable session cache key only when explicitly enabled', async () => {
    const received: Parameters<Provider['complete']>[0][] = [];
    const directory = temp();
    const app = new Application(path.join(directory, 'state'), { async complete(request) { received.push(request); return answer(); } });
    try {
      const first = app.createRun({ objective: 'First', workspace: directory, binding: { ...binding, promptCache: 'session' } });
      await app.run(first.id);
      const follow = app.submitInput(first.id, 'Follow-up');
      await app.run(follow.id);
      const isolated = app.createRun({ objective: 'Default cache policy', workspace: directory, binding });
      await app.run(isolated.id);
      expect(received[0]!.cacheKey).toBe(first.sessionId);
      expect(received[1]!.cacheKey).toBe(first.sessionId);
      expect(received[2]!.cacheKey).toBeUndefined();
    } finally { app.close(); }
  });
});
