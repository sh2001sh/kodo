import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { Application, discoverModelLimits } from '../src/application/index.js';
import { answer, binding, temp } from './helpers.js';
import { mockServer } from './http-server.js';
import type { ModelBinding } from '../src/runtime/types.js';

const custom = (baseURL: string, model = 'private-alias'): ModelBinding => ({ ...binding, limits: undefined, baseURL, model });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('endpoint model capability discovery', () => {
  it.each([
    { context_length: 64000, top_provider: { context_length: 32000, max_completion_tokens: 8000 } },
    { context_length: 32000, max_output_length: 8000 },
    { max_model_len: 32000, max_output_tokens: 8000 },
    { meta: { n_ctx: 32000, n_ctx_train: 1000000 }, max_completion_tokens: 8000 },
    { limit: { context: 32000, output: 8000, input: 24000 } },
  ])('reads advertised limits for an exact unknown model: %j', async metadata => {
    let reads = 0;
    const baseURL = await mockServer((_body, response, request) => {
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/v1/models');
      reads++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'private-alias', ...metadata }] }));
    });
    expect(await discoverModelLimits(custom(baseURL))).toMatchObject({ context: 32000, output: 8000, source: 'api' });
    expect(reads).toBe(1);
  });

  it('prefers OpenRouter account-specific metadata and forwards only its configured credential', async () => {
    vi.stubEnv('KODO_METADATA_TEST', 'fixture-key');
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/models/user');
      expect(options).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer fixture-key' } });
      return Response.json({ data: [{ id: 'tenant/private', context_length: 100000, top_provider: { context_length: 64000, max_completion_tokens: 16000 } }] });
    });
    expect(await discoverModelLimits({ model: 'tenant/private', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'KODO_METADATA_TEST' })).toMatchObject({ source: 'api', context: 64000, output: 16000 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('looks up a model detail endpoint when a standard list contains only IDs', async () => {
    const paths: string[] = [];
    const baseURL = await mockServer((_body, response, request) => {
      paths.push(request.url!);
      response.end(JSON.stringify(request.url === '/v1/models' ? { data: [{ id: 'tenant/private' }] } : { id: 'tenant/private', limits: { context: 48000, output: 12000 } }));
    });
    expect(await discoverModelLimits(custom(baseURL, 'tenant/private'))).toEqual({ context: 48000, output: 12000, source: 'api' });
    expect(paths).toEqual(['/v1/models', '/v1/models/tenant%2Fprivate']);
  });

  it('uses endpoint capabilities over a same-name native catalog model', async () => {
    const baseURL = await mockServer((_body, response) => { response.end(JSON.stringify({ data: [{ id: 'glm-5.3', context_length: 32000, max_output_tokens: 4096 }] })); });
    expect(await discoverModelLimits(custom(baseURL, 'glm-5.3'))).toEqual({ context: 32000, output: 4096, source: 'api' });
  });

  it('persists discovered capabilities and uses them for the actual request', async () => {
    const root = temp();
    const baseURL = await mockServer((_body, response) => { response.end(JSON.stringify({ data: [{ id: 'private-alias', context_window: 24000, max_output_tokens: 6000 }] })); });
    const app = new Application(path.join(root, 'data'), { async complete(request) {
      expect(request.maxOutputTokens).toBe(6000);
      return answer();
    } });
    try {
      const run = await app.createRunWithDiscovery({ objective: 'test', workspace: root, binding: custom(baseURL) });
      expect(app.store.session(run.sessionId).modelLimits).toEqual({ context: 24000, output: 6000, source: 'api' });
      expect((await app.run(run.id)).status).toBe('completed');
      expect(app.store.session(run.sessionId)).toMatchObject({ modelCalls: 1, toolCalls: 0 });
      expect(app.store.session(run.sessionId).budget).toMatchObject({ maxContextTokens: 24000, maxOutputTokens: 6000, maxTokens: null });
    } finally { await app.shutdown(); }
  });

  it('marks a missing output capability as provisional while keeping a reported small context', async () => {
    const baseURL = await mockServer((_body, response) => { response.end(JSON.stringify({ data: [{ id: 'private-alias', max_model_len: 8192 }] })); });
    expect(await discoverModelLimits(custom(baseURL))).toEqual({ source: 'api', context: 8192, output: 8191, warning: expect.stringContaining('output limits') });
  });

  it.each([
    { data: [{ id: 'different-model', context_length: 1000000, max_output_tokens: 64000 }] },
    { data: [{ id: 'private-alias', context_length: -1, max_output_tokens: '999999' }] },
    { data: [{ id: 'private-alias', description: 'Use 1000000 context tokens', meta: { n_ctx_train: 1000000 } }] },
    { data: [{ id: 'private-alias', context_length: 32000 }, { id: 'private-alias', context_length: 64000 }] },
  ])('does not infer capabilities from mismatches, ambiguous or unverified fields: %j', async body => {
    const baseURL = await mockServer((_body, response) => { response.end(JSON.stringify(body)); });
    expect(await discoverModelLimits(custom(baseURL))).toMatchObject({ source: 'fallback', context: 128000, output: 16384, warning: expect.stringContaining('not verified') });
  });

  it('continues with an explicit warning on metadata errors without leaking response bodies', async () => {
    const baseURL = await mockServer((_body, response) => { response.writeHead(403).end('private response body'); });
    const limits = await discoverModelLimits(custom(baseURL));
    expect(limits).toMatchObject({ source: 'fallback', warning: expect.stringContaining('metadata HTTP 403') });
    expect(JSON.stringify(limits)).not.toContain('private response body');
  });

  it('never follows metadata redirects or forwards credentials to their target', async () => {
    vi.stubEnv('KODO_METADATA_TEST', 'fixture-key');
    let redirected = false;
    const baseURL = await mockServer((_body, response, request) => {
      if (request.url === '/leak') redirected = true;
      expect(request.headers.authorization).toBe('Bearer fixture-key');
      response.writeHead(302, { location: '/leak' }).end();
    });
    const result = await discoverModelLimits({ ...custom(baseURL), apiKeyEnv: 'KODO_METADATA_TEST' });
    expect(result.source).toBe('fallback');
    expect(redirected).toBe(false);
    expect(JSON.stringify(result)).not.toContain('fixture-key');
  });

  it('bounds a response body even if it advertises a valid model before excessive data', async () => {
    const baseURL = await mockServer((_body, response) => { response.end(JSON.stringify({ data: [{ id: 'private-alias', context_length: 32000, max_output_tokens: 8000 }], padding: 'x'.repeat(8 * 1024 * 1024) })); });
    expect(await discoverModelLimits(custom(baseURL))).toMatchObject({ source: 'fallback', warning: expect.stringContaining('exceeds 8 MiB') });
  });

  it('aborts discovery without persisting a run when the caller cancels', async () => {
    const root = temp();
    const controller = new AbortController();
    const baseURL = await mockServer(() => controller.abort(new Error('operator cancelled')));
    const app = new Application(path.join(root, 'data'));
    try {
      await expect(app.createRunWithDiscovery({ objective: 'test', workspace: root, binding: custom(baseURL) }, controller.signal)).rejects.toThrow('operator cancelled');
      expect(app.store.listRuns()).toEqual([]);
    } finally { await app.shutdown(); }
  });

  it('limits the entire metadata phase to three seconds, including a stalled body', async () => {
    let reads = 0;
    const baseURL = await mockServer((_body, response) => { reads++; response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); });
    expect(await discoverModelLimits(custom(baseURL))).toMatchObject({ source: 'fallback', warning: expect.stringContaining('timed out') });
    expect(reads).toBe(1);
  }, 10000);

  it('skips discovery for declared capabilities, explicit windows and exact native catalog entries', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
    expect((await discoverModelLimits(binding)).source).toBe('binding');
    expect((await discoverModelLimits(custom('https://api.openai.com/v1', 'gpt-4.1'))).source).toBe('catalog');
    expect((await discoverModelLimits(custom('https://relay.example/v1'), { maxContextTokens: 32000, maxOutputTokens: 8000 })).source).toBe('explicit');
    expect(request).not.toHaveBeenCalled();
  });
});
