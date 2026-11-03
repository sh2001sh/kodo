import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProvider } from '../src/providers/index.js';
import { validateModelBinding } from '../src/providers/model-limits.js';
import { KodoError } from '../src/runtime/types.js';
import type { ModelBinding, ModelProtocol, Provider } from '../src/runtime/types.js';
import { answer, binding, fixture } from './helpers.js';
import { delta, mockServer, sendStream } from './http-server.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
type Request = Parameters<Provider['complete']>[0];
const route = (baseURL: string, provider: string, protocol: ModelProtocol = 'chat-completions'): ModelBinding => ({
  ...binding, baseURL, provider, protocol, apiKeyEnv: 'KODO_FAILOVER_TEST_KEY',
});
const group = (urls: string[], protocol: ModelProtocol = 'chat-completions'): ModelBinding => ({
  ...route(urls[0]!, 'primary', protocol), fallbacks: urls.slice(1).map((url, index) => route(url, `backup${index + 1}`, protocol)),
});
function success(response: ServerResponse): void {
  sendStream(response, [delta({ content: 'done' }), delta({}, 'stop'), { choices: [], usage: { prompt_tokens: 60, completion_tokens: 20 } }]);
}
function events(response: ServerResponse, values: Record<string, unknown>[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(values.map(value => `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
}

describe('host-owned same-model provider failover', () => {
  it.each([401, 403, 429, 503, 404])('tries the next configured provider after HTTP %s and accounts for each physical request', async status => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    const seen: { provider: string; model: unknown; authorization?: string }[] = [];
    const primary = await mockServer((body, response, request) => {
      seen.push({ provider: 'primary', model: body.model, authorization: request.headers.authorization });
      response.writeHead(status).end(JSON.stringify({ error: { message: 'private failure detail', code: status === 429 ? 'rate_limit_exceeded' : 'unavailable' } }));
    });
    const backup = await mockServer((body, response, request) => {
      seen.push({ provider: 'backup', model: body.model, authorization: request.headers.authorization }); success(response);
    });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup]) });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(seen).toEqual([
      { provider: 'primary', model: 'test-model', authorization: 'Bearer isolated-fixture-key' },
      { provider: 'backup', model: 'test-model', authorization: 'Bearer isolated-fixture-key' },
    ]);
    const attempts = app.store.calls(runId).filter(call => call.kind === 'model');
    expect(attempts.map(call => [call.status, call.routeIndex])).toEqual([['failed', 0], ['succeeded', 1]]);
    expect(attempts[0]!.logicalRequestRef).toBe(attempts[1]!.logicalRequestRef);
    expect(attempts[0]!.requestRef).not.toBe(attempts[1]!.requestRef);
    expect(app.store.readBlob<Request>(attempts[1]!.requestRef).binding).not.toHaveProperty('fallbacks');
    expect(app.store.readBlob<Request>(attempts[0]!.logicalRequestRef!).binding.fallbacks).toHaveLength(1);
    const session = app.store.session(result.sessionId);
    expect(session.modelCalls).toBe(2);
    expect(session.tokens).toBe(status === 429 ? 80 : attempts[0]!.reservedTokens + 80);
    expect(Boolean(session.usageEstimated)).toBe(status !== 429);
    const changes = app.store.events(runId, { types: ['model.provider_changed'] });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.data).toMatchObject({ from: 'primary', to: 'backup1', model: 'test-model', costChange: 'unknown' });
    expect(JSON.stringify(app.store.events(runId))).not.toContain('private failure detail');
  });

  it('fails over locally missing credentials without sending that endpoint a request or charging token usage', async () => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    vi.stubEnv('KODO_FAILOVER_MISSING_KEY', undefined);
    let primaryRequests = 0;
    const primary = await mockServer((_body, response) => { primaryRequests++; success(response); });
    const backup = await mockServer((_body, response) => { success(response); });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: { ...group([primary, backup]), apiKeyEnv: 'KODO_FAILOVER_MISSING_KEY' } });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(primaryRequests).toBe(0);
    expect(app.store.session(result.sessionId)).toMatchObject({ modelCalls: 2, tokens: 80, usageEstimated: false });
    expect(app.store.events(runId, { types: ['model.provider_changed'] })[0]!.data.reason).toBe('MODEL_CREDENTIAL');
  });

  it.each(['responses', 'anthropic'] as const)('preserves the %s protocol when switching endpoints', async protocol => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    const paths: string[] = [];
    const primary = await mockServer((_body, response, request) => { paths.push(request.url!); response.writeHead(401).end('{}'); });
    const backup = await mockServer((_body, response, request) => {
      paths.push(request.url!);
      if (protocol === 'responses') events(response, [{ type: 'response.completed', response: { id: 'response-fixture', status: 'completed',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }], usage: { input_tokens: 60, output_tokens: 20 },
      } }]);
      else events(response, [
        { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 60, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } }, { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }, { type: 'message_stop' },
      ]);
    });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup], protocol) });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(paths).toEqual(protocol === 'responses' ? ['/v1/responses', '/v1/responses'] : ['/v1/messages', '/v1/messages']);
    expect(app.store.session(result.sessionId).modelCalls).toBe(2);
  });

  it.each(['visible-text', 'hidden-reasoning', 'partial-tool', 'reported-usage'])('does not fail over after receiving %s from Chat Completions', async part => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    let backupRequests = 0;
    const partial = part === 'visible-text' ? delta({ content: 'visible partial' })
      : part === 'hidden-reasoning' ? delta({ reasoning_content: 'private partial reasoning' })
        : part === 'partial-tool' ? delta({ tool_calls: [{ index: 0, id: 'partial', function: { name: 'file_apply_patch', arguments: '{' } }] })
          : { choices: [], usage: { prompt_tokens: 60, completion_tokens: 20 } };
    const primary = await mockServer((_body, response) => {
      sendStream(response, [partial, { error: { code: 'rate_limit_exceeded', message: 'private error content' } }]);
    });
    const backup = await mockServer((_body, response) => { backupRequests++; success(response); });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup]) });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/^MODEL_RATE_LIMIT:/u);
    expect(backupRequests).toBe(0);
    const attempts = app.store.calls(runId).filter(call => call.kind === 'model');
    expect(attempts).toHaveLength(1);
    expect(app.store.events(runId, { types: ['model.provider_changed'] })).toHaveLength(0);
    expect(app.store.session(result.sessionId).tokens).toBe(part === 'reported-usage' ? 80 : attempts[0]!.reservedTokens);
    expect(JSON.stringify(app.store.events(runId))).not.toContain('private partial reasoning');
    expect(JSON.stringify(app.store.events(runId))).not.toContain('private error content');
  });

  it('retains Responses usage and prevents failover when a failed response already reported counters', async () => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    let backupRequests = 0;
    const primary = await mockServer((_body, response) => events(response, [{ type: 'response.failed', response: {
      id: 'failed-fixture', status: 'failed', output: [], error: { code: 'rate_limit_exceeded', message: 'private failure' },
      usage: { input_tokens: 33, output_tokens: 7 },
    } }]));
    const backup = await mockServer((_body, response) => { backupRequests++; success(response); });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup], 'responses') });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(backupRequests).toBe(0);
    expect(app.store.session(result.sessionId)).toMatchObject({ tokens: 40, modelCalls: 1, usageEstimated: false });
  });

  it('does not fail over after Responses private reasoning or partial tool items', async () => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    let backupRequests = 0;
    const primary = await mockServer((_body, response) => events(response, [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'private-item', encrypted_content: 'private-fixture-payload' } },
      { type: 'error', code: 'rate_limit_exceeded', message: 'private failure' },
    ]));
    const backup = await mockServer((_body, response) => { backupRequests++; success(response); });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup], 'responses') });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(backupRequests).toBe(0);
    expect(app.store.session(result.sessionId).modelCalls).toBe(1);
    expect(JSON.stringify(app.store.events(runId))).not.toContain('private-fixture-payload');
  });

  it('retains Anthropic counters after a partial thinking block and a later rate-limit stream error', async () => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    let backupRequests = 0;
    const primary = await mockServer((_body, response) => events(response, [
      { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 25, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'private-thinking', signature: '' } },
      { type: 'error', error: { type: 'rate_limit_error', status: 429, message: 'private failure' } },
    ]));
    const backup = await mockServer((_body, response) => { backupRequests++; success(response); });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup], 'anthropic') });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(backupRequests).toBe(0);
    expect(app.store.session(result.sessionId)).toMatchObject({ tokens: 26, modelCalls: 1, usageEstimated: false });
    expect(JSON.stringify(app.store.events(runId))).not.toContain('private-thinking');
  });

  it.each(['chat-completions', 'responses'] as const)('preserves reported %s usage when final response validation fails', async protocol => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    let backupRequests = 0;
    const primary = await mockServer((_body, response) => {
      if (protocol === 'chat-completions') sendStream(response, [delta({}, 'tool_calls'), { choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } }]);
      else events(response, [{ type: 'response.completed', response: { id: 'completed-fixture', status: 'completed', output: [{ type: 'function_call', call_id: '', name: 'file_read', arguments: '{}' }], usage: { input_tokens: 30, output_tokens: 10 } } }]);
    });
    const backup = await mockServer((_body, response) => { backupRequests++; success(response); });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup], protocol) });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/^MODEL_PROTOCOL:/u);
    expect(backupRequests).toBe(0);
    expect(app.store.session(result.sessionId)).toMatchObject({ tokens: 40, modelCalls: 1, usageEstimated: false });
  });

  it('does not fail over when a gateway coalesces partial reasoning and a bare JSON error into one network chunk', async () => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    let backupRequests = 0;
    const primary = await mockServer((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(delta({ reasoning_content: 'private-coalesced-reasoning' }))}\n\n${JSON.stringify({ error: { code: 'rate_limit_exceeded' } })}\n`);
    });
    const backup = await mockServer((_body, response) => { backupRequests++; success(response); });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup]) });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(backupRequests).toBe(0);
    expect(app.store.session(result.sessionId).modelCalls).toBe(1);
    expect(JSON.stringify(app.store.events(runId))).not.toContain('private-coalesced-reasoning');
  });

  it('allows failover after heartbeat-only SSE followed by a bare gateway error', async () => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    let backupRequests = 0;
    const primary = await mockServer((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`: heartbeat\n\n${JSON.stringify({ error: { code: 'get_channel_failed' } })}\n`);
    });
    const backup = await mockServer((_body, response) => { backupRequests++; success(response); });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup]) });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(backupRequests).toBe(1);
    expect(app.store.session(result.sessionId).modelCalls).toBe(2);
  });

  it.each(['MODEL_REQUEST', 'MODEL_PROTOCOL', 'MODEL_CONTEXT'])('does not advance providers for %s', async code => {
    const seen: string[] = [];
    const { app, runId } = fixture({ async complete(request) {
      seen.push(request.binding.provider!);
      throw new KodoError(code, 'fixture rejection', { status: 400, usageKnownZero: true });
    } });
    app.store.updateRun(runId, { binding: group(['https://primary.example/v1', 'https://backup.example/v1']) });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(seen.every(provider => provider === 'primary')).toBe(true);
    expect(app.store.events(runId, { types: ['model.provider_changed'] })).toHaveLength(0);
  });

  it('cancels an open primary stream without starting its backup', async () => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    let opened = false; let backupRequests = 0;
    const primary = await mockServer((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); opened = true;
    });
    const backup = await mockServer((_body, response) => { backupRequests++; success(response); });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup]) });
    const pending = app.run(runId);
    await expect.poll(() => opened).toBe(true);
    app.coordinator.cancel(runId);
    expect((await pending).status).toBe('cancelled');
    expect(backupRequests).toBe(0);
    expect(app.store.calls(runId).filter(call => call.kind === 'model')).toHaveLength(1);
    expect(app.store.events(runId, { types: ['model.provider_changed'] })).toHaveLength(0);
  });

  it('checks the shared call cap before starting or announcing a backup request', async () => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    let backupRequests = 0;
    const primary = await mockServer((_body, response) => { response.writeHead(429).end(JSON.stringify({ error: { code: 'rate_limit_exceeded' } })); });
    const backup = await mockServer((_body, response) => { backupRequests++; success(response); });
    const { app, runId } = fixture(new ModelProvider());
    const run = app.store.run(runId); const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxModelCalls: 1 } });
    app.store.updateRun(runId, { binding: group([primary, backup]) });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/^MODEL_BUDGET:/u);
    expect(backupRequests).toBe(0);
    expect(app.store.session(result.sessionId)).toMatchObject({ modelCalls: 1, tokens: 0 });
    expect(app.store.events(runId, { types: ['model.provider_changed'] })).toHaveLength(0);
  });

  it('retains an unknown failed reservation and rechecks the shared token cap before failover', async () => {
    const seen: string[] = [];
    const { app, runId } = fixture({ async complete(request) {
      seen.push(request.binding.provider!);
      const current = app.store.session(app.store.run(runId).sessionId);
      // An isolated fixture models another run spending the remainder while this attempt is in flight.
      app.store.putSession({ ...current, budget: { ...current.budget, maxTokens: current.tokens } });
      throw new KodoError('MODEL_TRANSPORT', 'fixture disconnected');
    } });
    app.store.updateRun(runId, { binding: group(['https://primary.example/v1', 'https://backup.example/v1']) });
    const result = await app.run(runId);
    expect(result.error).toMatch(/^MODEL_BUDGET:/u);
    expect(seen).toEqual(['primary']);
    const attempt = app.store.calls(runId).find(call => call.kind === 'model')!;
    expect(app.store.session(result.sessionId)).toMatchObject({ modelCalls: 1, tokens: attempt.reservedTokens, usageEstimated: true });
    expect(app.store.events(runId, { types: ['model.provider_changed'] })).toHaveLength(0);
  });

  it('retries output limits on the current backup, including the guided request, without restarting the group', async () => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    const seen: string[] = []; let backupRequests = 0;
    const primary = await mockServer((_body, response) => { seen.push('primary'); response.writeHead(503).end('{}'); });
    const backup = await mockServer((_body, response) => {
      seen.push('backup');
      if (++backupRequests <= 2) sendStream(response, [delta({}, 'length'), { choices: [], usage: { prompt_tokens: 30, completion_tokens: 20 } }]);
      else success(response);
    });
    const { app, runId } = fixture(new ModelProvider());
    app.store.updateRun(runId, { binding: group([primary, backup]) });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(seen).toEqual(['primary', 'backup', 'backup', 'backup']);
    expect(app.store.events(runId, { types: ['model.provider_changed'] })).toHaveLength(1);
    expect(app.store.events(runId, { types: ['model.output_guided'] })).toHaveLength(1);
    expect(app.store.session(result.sessionId).modelCalls).toBe(4);
  });

  it('exhausts every configured route once without upgrading the model or returning to a failed endpoint', async () => {
    const seen: string[] = [];
    const { app, runId } = fixture({ async complete(request) {
      seen.push(`${request.binding.provider}:${request.binding.model}`);
      throw new KodoError('MODEL_QUOTA', 'fixture quota exhausted', { usageKnownZero: true });
    } });
    app.store.updateRun(runId, { binding: group(['https://first.example/v1', 'https://second.example/v1', 'https://third.example/v1']) });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(seen).toEqual(['primary:test-model', 'backup1:test-model', 'backup2:test-model']);
    expect(app.store.session(result.sessionId)).toMatchObject({ modelCalls: 3, tokens: 0 });
    expect(app.store.events(runId, { types: ['model.provider_changed'] })).toHaveLength(2);
  });

  it('retains the existing three-attempt policy for standalone provider bindings', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      if (++attempts < 3) throw new KodoError('MODEL_RATE_LIMIT', 'isolated fixture rate limit', { usageKnownZero: true, retryAfterMs: 0 });
      return answer();
    } });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(attempts).toBe(3);
    expect(app.store.events(runId, { types: ['model.provider_changed'] })).toHaveLength(0);
  });

  it('resumes a recorded route transition from its immutable logical request even if the run binding changed', async () => {
    vi.stubEnv('KODO_FAILOVER_TEST_KEY', 'isolated-fixture-key');
    let originalBackup = 0; let changedBackup = 0;
    const backup = await mockServer((_body, response) => { originalBackup++; success(response); });
    const changed = await mockServer((_body, response) => { changedBackup++; success(response); });
    const { app, runId } = fixture(new ModelProvider());
    const original: Request = { binding: group(['https://primary.example/v1', backup]), messages: [{ role: 'user', content: 'Recorded immutable fixture request' }], tools: [], maxOutputTokens: 100 };
    const logicalRequestRef = app.store.blob(original);
    const { fallbacks: _fallbacks, ...primary } = original.binding; void _fallbacks;
    app.store.putCall({ id: 'recorded-primary-attempt', runId, step: 0, kind: 'model', name: 'test-model', status: 'failed', effect: 'read',
      requestRef: app.store.blob({ ...original, binding: primary }), logicalRequestRef, routeIndex: 0, reservedTokens: 100,
      resultRef: app.store.blob({ error: 'MODEL_AUTH: isolated fixture failure', usage: 'known-zero' }),
    });
    app.store.event(runId, 'model.started', { callId: 'recorded-primary-attempt', logicalRequestRef, routeIndex: 0 });
    app.store.event(runId, 'model.retry', { requestRef: logicalRequestRef, previousCallId: 'recorded-primary-attempt', reason: 'provider_failover', providerFailure: 'MODEL_AUTH', nextRouteIndex: 1 });
    app.store.updateRun(runId, { status: 'interrupted', stepCallId: 'recorded-primary-attempt', binding: group(['https://changed-primary.example/v1', changed]) });
    const session = app.store.session(app.store.run(runId).sessionId); app.store.putSession({ ...session, modelCalls: 1 });
    const result = await app.coordinator.resume(runId);
    expect(result.status, result.error).toBe('completed');
    expect(originalBackup).toBe(1); expect(changedBackup).toBe(0);
    expect(app.store.calls(runId).filter(call => call.kind === 'model').map(call => call.routeIndex)).toEqual([0, 1]);
  });
});

describe('approved provider route validation', () => {
  it('accepts at most seven flat alternatives for the exact same model and effective protocol', () => {
    const approved = group(Array.from({ length: 8 }, (_, index) => `https://p${index}.example/v1`));
    expect(() => validateModelBinding(approved)).not.toThrow();
    const defaultProtocol = { ...approved, protocol: undefined };
    expect(() => validateModelBinding(defaultProtocol)).not.toThrow();
  });

  it.each([
    { fallbacks: Array.from({ length: 8 }, () => route('https://backup.example/v1', 'backup')) },
    { fallbacks: [{ ...route('https://backup.example/v1', 'backup'), model: 'upgraded-model' }] },
    { fallbacks: [route('https://backup.example/v1', 'backup', 'responses')] },
    { fallbacks: [{ ...route('https://backup.example/v1', 'backup'), fallbacks: [] }] },
    { fallbacks: [route('http://remote.example/v1', 'backup')] },
    { fallbacks: [{ ...route('https://backup.example/v1', 'backup'), apiKeyEnv: 'not an env' }] },
  ].map((patch, index) => ({ patch, index })))('rejects invalid or unapproved route changes (#$index)', ({ patch }) => {
    expect(() => validateModelBinding({ ...route('https://primary.example/v1', 'primary'), ...patch })).toThrow();
  });
});
