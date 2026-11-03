import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProvider } from '../src/providers/index.js';
import { KodoError } from '../src/runtime/types.js';
import type { ModelBinding, Provider } from '../src/runtime/types.js';
import { answer, binding, fixture } from './helpers.js';
import { delta, mockServer, sendStream } from './http-server.js';

afterEach(() => vi.unstubAllEnvs());
const incomplete = (): KodoError => new KodoError('MODEL_INCOMPLETE', 'fixture stream ended without completion', { incompleteStream: true, partialResponse: true });
const route = (baseURL: string): ModelBinding => ({ ...binding, baseURL, apiKeyEnv: 'KODO_INCOMPLETE_TEST_KEY' });

describe('bounded missing-terminal recovery', () => {
  it.each([false, true])('retries the unchanged request on the same endpoint (group=%s) and retains measured usage', async grouped => {
    vi.stubEnv('KODO_INCOMPLETE_TEST_KEY', 'local-fixture');
    const requests: Record<string, unknown>[] = [];
    let backups = 0;
    const backup = await mockServer((_body, response) => { backups++; sendStream(response, [delta({}, 'stop')]); });
    const primary = await mockServer((body, response) => {
      requests.push(body);
      sendStream(response, requests.length === 1
        ? [delta({ reasoning_content: 'isolated reasoning fixture' }), { choices: [], usage: { prompt_tokens: 30, completion_tokens: 15 } }]
        : [delta({ content: 'done' }), delta({}, 'stop'), { choices: [], usage: { prompt_tokens: 60, completion_tokens: 20 } }]);
    });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: { ...route(primary), ...(grouped ? { fallbacks: [route(backup)] } : {}) } });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(backups).toBe(0);
    expect(app.store.session(result.sessionId)).toMatchObject({ tokens: 125, modelCalls: 2, usageEstimated: false });
    expect(app.store.calls(runId).map(call => call.status)).toEqual(['failed', 'succeeded']);
    expect(app.store.events(runId, { types: ['model.retry'] }).map(event => event.data.reason)).toEqual(['incomplete_stream']);
    expect(app.store.events(runId, { types: ['model.provider_changed'] })).toHaveLength(0);
  });

  it.each(['{', '{"path":"unexpected.txt","content":"must not execute"}'])('discards uncompleted tool arguments %s and retains unknown usage', async args => {
    vi.stubEnv('KODO_INCOMPLETE_TEST_KEY', 'local-fixture');
    let requests = 0;
    const url = await mockServer((_body, response) => {
      sendStream(response, ++requests === 1
        ? [delta({ tool_calls: [{ index: 0, id: 'uncompleted', type: 'function', function: { name: 'file_apply_patch', arguments: args } }] })]
        : [delta({ content: 'done' }), delta({}, 'stop'), { choices: [], usage: { prompt_tokens: 60, completion_tokens: 20 } }]);
    });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: route(url) });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    const attempts = app.store.calls(runId);
    expect(attempts).toHaveLength(2);
    expect(attempts.every(call => call.kind === 'model')).toBe(true);
    expect(app.store.session(result.sessionId)).toMatchObject({ tokens: attempts[0]!.reservedTokens + 80, usageEstimated: true });
  });

  it('keeps an incomplete retry on the active backup after an earlier endpoint failure', async () => {
    vi.stubEnv('KODO_INCOMPLETE_TEST_KEY', 'local-fixture');
    let primaryRequests = 0, backupRequests = 0;
    const primary = await mockServer((_body, response) => { primaryRequests++; response.writeHead(503).end('{}'); });
    const backup = await mockServer((_body, response) => {
      sendStream(response, ++backupRequests === 1
        ? [delta({ reasoning_content: 'isolated backup fixture' })]
        : [delta({ content: 'done' }), delta({}, 'stop')]);
    });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: { ...route(primary), fallbacks: [route(backup)] } });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(primaryRequests).toBe(1);
    expect(backupRequests).toBe(2);
    expect(app.store.calls(runId).map(call => call.routeIndex)).toEqual([0, 1, 1]);
    expect(app.store.events(runId, { types: ['model.retry'] }).map(event => event.data.reason)).toEqual(['provider_failover', 'incomplete_stream']);
  });

  it.each([false, true])('stops after two incomplete attempts and cannot reset the limit on resume (group=%s)', async grouped => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() { attempts++; throw incomplete(); } });
    if (grouped) app.store.updateRun(runId, { binding: { ...binding, fallbacks: [{ ...binding, baseURL: 'http://127.0.0.1:2/v1' }] } });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/^MODEL_INCOMPLETE:/u);
    expect(attempts).toBe(2);
    expect(app.store.events(runId, { types: ['model.retry'] })).toHaveLength(1);
    app.store.updateRun(runId, { status: 'interrupted' });
    expect((await app.coordinator.resume(runId)).status).toBe('failed');
    expect(attempts).toBe(2);
  });

  it.each([
    ['visible content', delta({ content: 'already displayed' })],
    ['explicit filter', delta({}, 'content_filter')],
    ['refusal without terminal', delta({ refusal: 'fixture refusal' })],
  ])('does not retry %s', async (_label, part) => {
    vi.stubEnv('KODO_INCOMPLETE_TEST_KEY', 'local-fixture');
    let requests = 0;
    const url = await mockServer((_body, response) => { requests++; sendStream(response, [part]); });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: route(url) });
    expect((await app.run(runId)).status).toBe('failed');
    expect(requests).toBe(1);
    expect(app.store.events(runId, { types: ['model.retry'] })).toHaveLength(0);
  });

  it.each(['calls', 'tokens', 'cancel'] as const)('honors %s before the extra attempt', async boundary => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      attempts++;
      if (boundary === 'tokens') {
        const session = app.store.session(app.store.run(runId).sessionId);
        app.store.putSession({ ...session, budget: { ...session.budget, maxTokens: session.tokens } });
      }
      throw incomplete();
    } });
    const session = app.store.session(app.store.run(runId).sessionId);
    if (boundary === 'calls') app.store.putSession({ ...session, budget: { ...session.budget, maxModelCalls: 1 } });
    if (boundary === 'cancel') app.store.subscribe(event => { if (event.type === 'model.retry') app.coordinator.cancel(runId); });
    const result = await app.run(runId);
    expect(result.status).toBe(boundary === 'cancel' ? 'cancelled' : 'failed');
    if (boundary !== 'cancel') expect(result.error).toMatch(/^MODEL_BUDGET:/u);
    expect(attempts).toBe(1);
    const first = app.store.calls(runId)[0]!;
    expect(app.store.session(result.sessionId).tokens).toBe(first.reservedTokens);
  });

  it.each([
    { grouped: false, consumed: false }, { grouped: true, consumed: false },
    { grouped: false, consumed: true }, { grouped: true, consumed: true },
  ])('consumes a persisted retry transition only once after interruption: %j', async ({ grouped, consumed }) => {
    let requests = 0;
    const { app, runId } = fixture({ async complete() { requests++; throw incomplete(); } });
    const modelBinding = { ...binding, ...(grouped ? { fallbacks: [{ ...binding, baseURL: 'http://127.0.0.1:2/v1' }] } : {}) };
    const request: Parameters<Provider['complete']>[0] = { binding: modelBinding, messages: [{ role: 'user', content: 'isolated persisted request fixture' }], tools: [], maxOutputTokens: 100 };
    const logical = app.store.blob(request);
    const physical = grouped ? app.store.blob({ ...request, binding }) : logical;
    app.store.putCall({ id: 'interrupted-attempt', runId, step: 0, kind: 'model', name: binding.model, status: 'failed', effect: 'read', requestRef: physical, reservedTokens: 100,
      ...(grouped ? { logicalRequestRef: logical, routeIndex: 0 } : {}), resultRef: app.store.blob({ error: 'MODEL_INCOMPLETE: isolated fixture', usage: 'unknown' }),
    });
    app.store.event(runId, 'model.started', { callId: 'interrupted-attempt', requestRef: physical, ...(grouped ? { logicalRequestRef: logical, routeIndex: 0 } : {}) });
    app.store.event(runId, 'model.failed', { callId: 'interrupted-attempt', requestRef: physical, incompleteStream: true, error: 'MODEL_INCOMPLETE: isolated fixture' });
    app.store.event(runId, 'model.retry', { requestRef: logical, previousCallId: 'interrupted-attempt', reason: 'incomplete_stream', ...(grouped ? { nextRouteIndex: 0 } : {}) });
    app.store.updateRun(runId, { status: 'interrupted', stepCallId: 'interrupted-attempt', binding: modelBinding });
    if (consumed) {
      // Simulate process loss after the retry started but before its result was saved.
      app.store.putCall({ ...app.store.call('interrupted-attempt'), id: 'consumed-retry', status: 'running', resultRef: undefined });
      app.store.event(runId, 'model.started', { callId: 'consumed-retry', requestRef: physical, ...(grouped ? { logicalRequestRef: logical, routeIndex: 0 } : {}) });
      app.store.updateRun(runId, { stepCallId: 'consumed-retry' });
    }
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, modelCalls: consumed ? 2 : 1, tokens: consumed ? 200 : 100, usageEstimated: true });
    const result = await app.coordinator.resume(runId);
    expect(result.status).toBe('failed');
    expect(requests).toBe(consumed ? 0 : 1);
    if (consumed) {
      expect(result.error).toMatch(/^MODEL_RETRIES:/u);
      expect(app.store.session(result.sessionId)).toMatchObject({ tokens: 200, modelCalls: 2, usageEstimated: true });
    }
    expect(app.store.events(runId, { types: ['model.retry'] })).toHaveLength(1);
  });

  it('does not spend the transient retry allowance on a missing terminal', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      attempts++;
      if (attempts === 2) throw incomplete();
      if (attempts < 4) throw new KodoError('MODEL_RATE_LIMIT', 'fixture rate limit', { usageKnownZero: true, retryAfterMs: 0 });
      return answer();
    } });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(attempts).toBe(4);
  });
});
