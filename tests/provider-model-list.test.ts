import { afterEach, describe, expect, it, vi } from 'vitest';
import { listProviderModels } from '../src/providers/model-list.js';
import type { ModelBinding } from '../src/runtime/types.js';
import { mockServer } from './http-server.js';

const binding = (baseURL: string, protocol: ModelBinding['protocol'] = 'chat-completions'): ModelBinding => ({ baseURL, model: '', apiKeyEnv: 'KODO_MODEL_LIST_TEST_KEY', protocol });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('provider model listing', () => {
  it.each(['chat-completions', 'responses'] as const)('reads actual %s model IDs without requiring a selected model', async protocol => {
    vi.stubEnv('KODO_MODEL_LIST_TEST_KEY', 'isolated-list-fixture');
    let reads = 0;
    const baseURL = await mockServer((_body, response, request) => {
      reads++;
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/v1/models');
      expect(request.headers.authorization).toBe('Bearer isolated-list-fixture');
      expect(request.headers['x-api-key']).toBeUndefined();
      response.end(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model', name: 'A model' }, { id: 'z-model', display_name: 'Z model' }] }));
    });
    expect(await listProviderModels(binding(`${baseURL}/`, protocol))).toEqual([{ id: 'a-model', name: 'A model' }, { id: 'z-model', name: 'Z model' }]);
    expect(reads).toBe(1);
  });

  it('retains custom provider prefixes and reads all Anthropic pages with their configured authentication', async () => {
    vi.stubEnv('KODO_MODEL_LIST_TEST_KEY', 'isolated-anthropic-fixture');
    const paths: string[] = [];
    const baseURL = await mockServer((_body, response, request) => {
      paths.push(request.url!);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers['x-api-key']).toBe('isolated-anthropic-fixture');
      expect(request.headers['anthropic-version']).toBe('2023-06-01');
      response.end(JSON.stringify(paths.length === 1
        ? { data: [{ id: 'model-first', display_name: 'First model' }], has_more: true, last_id: 'model-first' }
        : { data: [{ id: 'model-first' }, { id: 'model-next', display_name: 'Next model' }], has_more: false, last_id: 'model-next' }));
    });
    expect(await listProviderModels(binding(`${baseURL}/tenant`, 'anthropic'))).toEqual([{ id: 'model-first', name: 'First model' }, { id: 'model-next', name: 'Next model' }]);
    expect(paths).toEqual(['/v1/tenant/models', '/v1/tenant/models?after_id=model-first']);
  });

  it('allows public local metadata without sending an undefined credential', async () => {
    vi.stubEnv('KODO_MODEL_LIST_TEST_KEY', '');
    const baseURL = await mockServer((_body, response, request) => {
      expect(request.headers.authorization).toBeUndefined();
      response.end(JSON.stringify({ data: [{ id: 'local/model' }] }));
    });
    expect(await listProviderModels(binding(baseURL))).toEqual([{ id: 'local/model' }]);
  });

  it.each([401, 403, 404, 500])('reports HTTP %s without retaining provider response text or credentials', async status => {
    vi.stubEnv('KODO_MODEL_LIST_TEST_KEY', 'isolated-private-key');
    const baseURL = await mockServer((_body, response) => { response.writeHead(status).end('isolated-private-key: account-specific provider detail'); });
    const result = await listProviderModels(binding(baseURL)).catch(error => error as Error);
    expect(result).toMatchObject({ code: status === 401 || status === 403 ? 'MODEL_LIST_AUTH' : 'MODEL_LIST_HTTP', message: expect.stringContaining(`HTTP ${status}`) });
    expect(String(result)).not.toContain('isolated-private-key');
    expect(String(result)).not.toContain('account-specific');
  });

  it.each([
    'not JSON',
    { models: [{ id: 'unknown-shape' }] },
    { data: [{ name: 'Missing ID' }] },
    { data: [{ id: '' }] },
    { data: [{ id: 'ok' }], has_more: 'true' },
    { data: [{ id: 'ok' }], has_more: true },
  ])('reports malformed model metadata without substituting catalog entries (%j)', async body => {
    const baseURL = await mockServer((_request, response) => { response.end(typeof body === 'string' ? body : JSON.stringify(body)); });
    await expect(listProviderModels(binding(baseURL))).rejects.toMatchObject({ code: 'MODEL_LIST_FORMAT' });
  });

  it('reports an empty list and a repeating pagination cursor instead of returning a partial selection', async () => {
    let repeated = false;
    const baseURL = await mockServer((_request, response) => { response.end(JSON.stringify(repeated ? { data: [{ id: 'one' }], has_more: true, last_id: 'one' } : { data: [] })); });
    await expect(listProviderModels(binding(baseURL))).rejects.toMatchObject({ code: 'MODEL_LIST_EMPTY' });
    repeated = true;
    await expect(listProviderModels(binding(baseURL))).rejects.toMatchObject({ code: 'MODEL_LIST_FORMAT' });
  });

  it('bounds the amount of metadata read across pages', async () => {
    const baseURL = await mockServer((_request, response) => { response.end(JSON.stringify({ data: [{ id: 'one' }], padding: 'x'.repeat(4 * 1024 * 1024) })); });
    await expect(listProviderModels(binding(baseURL))).rejects.toMatchObject({ code: 'MODEL_LIST_LIMIT', message: expect.stringContaining('4 MiB') });
  });

  it('does not fetch after an already-cancelled request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by operator'));
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(listProviderModels(binding('https://provider.example/v1'), controller.signal)).rejects.toThrow('cancelled by operator');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels a pending metadata request promptly', async () => {
    const controller = new AbortController();
    const baseURL = await mockServer((_body, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{');
      controller.abort(new Error('operator cancelled model picker'));
    });
    await expect(listProviderModels(binding(baseURL), controller.signal)).rejects.toThrow('operator cancelled model picker');
  });

  it('bounds the entire listing deadline, including a stalled response body', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { expect(ms).toBe(8000); return deadline.signal; });
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      pull() { reading(); return new Promise<void>(() => {}); },
      cancel,
    })));
    const outcome = listProviderModels(binding('http://127.0.0.1/v1')).catch((error: unknown) => error);
    await started;
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    expect(await outcome).toMatchObject({ code: 'MODEL_LIST_TIMEOUT' });
    expect(cancel).toHaveBeenCalledOnce();
  }, 1000);

  it('does not wait for a stalled error-body cleanup before reporting the HTTP failure', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 500 }));
    await expect(listProviderModels(binding('http://127.0.0.1/v1'))).rejects.toMatchObject({ code: 'MODEL_LIST_HTTP' });
    expect(cancel).toHaveBeenCalledOnce();
  }, 1000);

  it('requires a configured provider connection before any network request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(listProviderModels(binding('not a URL'))).rejects.toMatchObject({ code: 'MODEL_LIST_CONFIG' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
