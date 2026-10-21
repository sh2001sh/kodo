import { describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { KodoError } from '../src/runtime/types.js';
import type { Message, ModelResponse, Provider } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, scripted } from './helpers.js';

describe('unified runtime', () => {
  it('completes three tool rounds and preserves call/result associations', async () => {
    let artifactId = '';
    const provider = scripted(
      calls(call('file.read', { path: 'source.txt' }, 'read-1')),
      async request => {
        expect(request.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'read-1' });
        expect(request.messages.at(-1)?.content).toContain('证据');
        return calls(call('artifact.write', { name: 'report', content: '证据已保存' }, 'write-2'));
      },
      async request => {
        artifactId = (JSON.parse(request.messages.at(-1)!.content!) as { id: string }).id;
        return calls(call('artifact.read', { id: artifactId }, 'read-3'));
      },
      answer('done with evidence'),
    );
    const { app, root, runId } = fixture(provider);
    writeFileSync(path.join(root, 'source.txt'), '证据');
    const result = await app.coordinator.wake(runId);
    expect(result.status).toBe('completed');
    expect(app.store.calls(runId).filter(x => x.kind === 'tool').map(x => x.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(app.store.readArtifact(runId, artifactId)).toMatchObject({ content: '证据已保存' });
    expect(app.store.session(result.sessionId)).toMatchObject({ tokens: 320, modelCalls: 4, toolCalls: 3, usageEstimated: false });
  });
  it('coalesces duplicate wakeups into one execution', async () => {
    const complete = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return answer(); });
    const { app, runId } = fixture({ complete });
    await Promise.all([app.coordinator.wake(runId), app.coordinator.wake(runId), app.coordinator.wake(runId)]);
    expect(complete).toHaveBeenCalledTimes(1);
    await app.coordinator.wake(runId);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('retains estimates after a later measured response', async () => {
    const estimated = calls(call('file.list', { path: '.' }));
    delete estimated.usage;
    const { app, runId } = fixture(scripted(estimated, answer()));
    const run = await app.coordinator.wake(runId);
    expect(run.status).toBe('completed');
    expect(app.store.session(run.sessionId).usageEstimated).toBe(true);
  });
  it('stops before exceeding model-call and tool budgets', async () => {
    const { app, runId } = fixture(scripted(calls(call('file.list', { path: '.' })), answer()));
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxModelCalls: 1 } });
    const result = await app.coordinator.wake(runId);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('MODEL_BUDGET');
    expect(app.store.session(session.id).modelCalls).toBe(1);
  });
  it('reserves concurrent requests against the shared session budget', async () => {
    const complete = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return answer(); });
    const { app, runId } = fixture({ complete });
    const first = app.store.run(runId);
    app.store.putRun({ ...first, id: 'second' });
    const session = app.store.session(first.sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxModelCalls: 1 } });
    const results = await Promise.all([app.coordinator.wake(runId), app.coordinator.wake('second')]);
    expect(results.map(x => x.status).sort()).toEqual(['completed', 'failed']);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('does not start a tool returned after cancellation', async () => {
    let returned: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const complete: Provider['complete'] = async () => {
      entered!();
      await new Promise<void>(resolve => { returned = resolve; });
      return calls(call('file.apply_patch', { path: 'cancelled.txt', expectedHash: null, content: 'no' }));
    };
    const { app, runId } = fixture({ complete });
    const running = app.coordinator.wake(runId);
    await started;
    app.coordinator.cancel(runId);
    returned!();
    expect((await running).status).toBe('cancelled');
    expect(app.store.events(runId).some(x => x.type === 'tool.started')).toBe(false);
    expect(app.store.calls(runId)[0]?.status).toBe('cancelled');
  });
  it('records transport failures and retains their uncertain token reservation', async () => {
    const { app, runId } = fixture({ async complete() { throw new KodoError('MODEL_TRANSPORT', 'stream disconnected'); } });
    const run = await app.coordinator.wake(runId);
    expect(run.status).toBe('failed');
    const session = app.store.session(run.sessionId);
    expect(session.tokens).toBeGreaterThan(0);
    expect(session.usageEstimated).toBe(true);
  });
  it('rejects malformed tool JSON and allows the model to correct it', async () => {
    const { app, runId } = fixture(scripted(calls({ id: 'broken', name: 'file.read', arguments: '{' }), async request => {
      expect(request.messages.at(-1)?.content).toContain('TOOL_ARGUMENTS');
      return answer('unable to read until corrected');
    }));
    expect((await app.coordinator.wake(runId)).status).toBe('completed');
    expect(app.store.calls(runId).find(x => x.name === 'file.read')?.status).toBe('failed');
  });
  it('does not silently discard context to meet the bound', async () => {
    const { app, runId } = fixture();
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxContextChars: 10 } });
    const run = await app.coordinator.wake(runId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('CONTEXT_LIMIT');
    expect(app.store.calls(runId)).toHaveLength(0);
  });
  it('rejects invalid provider usage without dispatching tools', async () => {
    const response = calls(call('file.list', { path: '.' }));
    response.usage = { input: -100, output: 2 };
    const { app, runId } = fixture(scripted(response));
    const run = await app.coordinator.wake(runId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('MODEL_PROTOCOL');
    expect(app.store.calls(runId)[0]?.status).toBe('failed');
    expect(app.store.events(runId).filter(x => x.type === 'tool.started')).toHaveLength(0);
  });
  it('stops before the next tool when the tool budget runs out', async () => {
    const { app, runId } = fixture(scripted(calls(call('file.list', { path: '.' }, 'one'), call('file.list', { path: '.' }, 'two'))));
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxToolCalls: 1 } });
    const result = await app.coordinator.wake(runId);
    expect(result.error).toContain('TOOL_BUDGET');
    expect(app.store.events(runId).filter(x => x.type === 'tool.started')).toHaveLength(1);
  });
  it('treats a timed-out process write as uncertain and stops subsequent actions', async () => {
    const { app, runId } = fixture(scripted(calls(call('process.exec', { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }))), ['exec']);
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, toolTimeoutMs: 100 } });
    const result = await app.coordinator.wake(runId);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('UNKNOWN_WRITE');
    expect(app.store.calls(runId).find(x => x.kind === 'tool')?.status).toBe('unknown');
  });
  it('rejects insecure remote endpoints and invalid budgets', () => {
    const { app, root } = fixture();
    expect(() => app.createRun({ objective: 'x', workspace: root, binding: { ...binding, baseURL: 'http://example.com/v1' } })).toThrow('HTTPS');
    expect(() => app.createRun({ objective: 'x', workspace: root, binding, budget: { maxTokens: -1 } })).toThrow('positive');
    expect(() => app.createRun({ objective: '', workspace: root, binding })).toThrow('nonempty');
  });
});

describe('conservative recovery', () => {
  it('marks abandoned runs interrupted and never replays unknown writes', async () => {
    const { app, root, runId } = fixture();
    app.store.updateRun(runId, { status: 'running' });
    app.store.putCall({ id: 'external-write', runId, step: 0, kind: 'tool', name: 'process.exec', status: 'running', effect: 'write', requestRef: app.store.blob({ program: 'external' }), reservedTokens: 0 });
    writeFileSync(path.join(root, 'external-effect.txt'), 'already happened');
    const directory = app.store.directory;
    app.close();
    const complete = vi.fn(async () => answer());
    const reopened = new Application(directory, { complete });
    try {
      expect(reopened.store.run(runId).status).toBe('interrupted');
      expect(() => reopened.coordinator.resume(runId)).toThrow('automatic resume is blocked');
      expect(reopened.store.call('external-write').status).toBe('unknown');
      expect(complete).not.toHaveBeenCalled();
      expect(readFileSync(path.join(root, 'external-effect.txt'), 'utf8')).toBe('already happened');
    } finally { reopened.close(); }
  });
  it('resumes from persisted tool results without redoing a successful write', async () => {
    const { app, root, runId } = fixture();
    const response = calls(call('file.apply_patch', { path: 'effect.txt', expectedHash: null, content: 'written once' }, 'write'));
    const modelId = 'model-before-crash';
    writeFileSync(path.join(root, 'effect.txt'), 'written once');
    app.store.putCall({ id: modelId, runId, step: 0, kind: 'model', name: 'test', effect: 'read', status: 'succeeded', requestRef: app.store.blob({}), resultRef: app.store.blob(response), reservedTokens: 0 });
    app.store.putCall({ id: `${modelId}:write`, runId, step: 0, kind: 'tool', name: 'file.apply_patch', effect: 'write', status: 'succeeded', requestRef: app.store.blob({}), resultRef: app.store.blob({ path: 'effect.txt' }), reservedTokens: 0 });
    app.store.updateRun(runId, { status: 'running', stepCallId: modelId });
    const directory = app.store.directory;
    app.close();
    const reopened = new Application(directory, scripted(async request => {
      expect(request.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'write' });
      return answer('recovered');
    }));
    try {
      expect((await reopened.coordinator.resume(runId)).status).toBe('completed');
      expect(readFileSync(path.join(root, 'effect.txt'), 'utf8')).toBe('written once');
      expect(reopened.store.events(runId).filter(x => x.type === 'tool.started')).toHaveLength(0);
    } finally { reopened.close(); }
  });
  it('uses a persisted final response without making a second model call', async () => {
    const { app, runId } = fixture();
    app.store.putCall({ id: 'final-model', runId, step: 0, kind: 'model', name: 'test', effect: 'read', status: 'succeeded', requestRef: app.store.blob({}), resultRef: app.store.blob(answer('finished before crash')), reservedTokens: 0 });
    app.store.updateRun(runId, { status: 'running', stepCallId: 'final-model' });
    const directory = app.store.directory;
    app.close();
    const complete = vi.fn(async (): Promise<ModelResponse> => answer());
    const reopened = new Application(directory, { complete });
    try {
      const run = await reopened.coordinator.resume(runId);
      expect(run.status).toBe('completed');
      expect(reopened.store.readBlob<{ text: string }>(run.resultRef!).text).toBe('finished before crash');
      expect(complete).not.toHaveBeenCalled();
    } finally { reopened.close(); }
  });
  it('leaves terminal runs immutable on resume', () => {
    const { app, runId } = fixture();
    app.coordinator.cancel(runId);
    expect(() => app.coordinator.resume(runId)).toThrow('terminal records remain immutable');
    const history = app.store.readBlob<Message[]>(app.store.run(runId).contextRef);
    expect(history.at(-1)?.content).toContain('Inspect the project');
  });
});
