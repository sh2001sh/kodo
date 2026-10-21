import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { ChatCompletionsProvider } from '../src/providers/openai.js';
import { ResponsesProvider } from '../src/providers/responses.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { retryDelay } from '../src/providers/errors.js';
import type { ModelProtocol, Provider } from '../src/runtime/types.js';
import { KodoError } from '../src/runtime/types.js';
import { delta, mockServer, sendStream } from './http-server.js';

type Event = Record<string, unknown>;
const protocols: ModelProtocol[] = ['chat-completions', 'responses', 'anthropic'];
const fixtureSecret = 'fixture-private-key-and-prompt-never-retain';
const provider = (protocol: ModelProtocol): Provider => protocol === 'responses' ? new ResponsesProvider() : protocol === 'anthropic' ? new AnthropicProvider() : new ChatCompletionsProvider();
const request = (protocol: ModelProtocol, baseURL: string): Parameters<Provider['complete']>[0] => ({
  binding: { protocol, baseURL, model: 'fixture', apiKeyEnv: 'KODO_HARDENING_TEST_KEY' },
  messages: [{ role: 'system', content: 'stable system' }, { role: 'user', content: 'task' }], tools: [], maxOutputTokens: 20,
});
function events(response: ServerResponse, values: Event[], eventName?: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const value of values) response.write(`event: ${eventName ?? value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  response.end();
}
function success(protocol: ModelProtocol, response: ServerResponse, cached?: number): void {
  if (protocol === 'chat-completions') sendStream(response, [delta({ content: 'done' }), delta({}, 'stop'), {
    choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}) },
  }]);
  else if (protocol === 'responses') events(response, [{ type: 'response.completed', response: { status: 'completed', output: [],
    usage: { input_tokens: 20, output_tokens: 4, ...(cached !== undefined ? { input_tokens_details: { cached_tokens: cached } } : {}) },
  } }]);
  else events(response, [
    { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0,
      ...(cached !== undefined ? { cache_read_input_tokens: cached, cache_creation_input_tokens: 3 } : {}),
    } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
  ]);
}
function largeText(protocol: ModelProtocol, response: ServerResponse, content: string, completed: boolean): void {
  if (protocol === 'chat-completions') {
    sendStream(response, [delta({ content }), ...(completed ? [delta({}, 'stop'), {
      choices: [], usage: { prompt_tokens: 20, completion_tokens: 900_000 },
    }] : [])], completed);
  } else if (protocol === 'responses') {
    events(response, [{ type: 'response.output_text.delta', delta: content }, ...(completed ? [{ type: 'response.completed', response: {
      status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] }],
      usage: { input_tokens: 20, output_tokens: 900_000 },
    } }] : [])]);
  } else {
    events(response, [
      { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
      ...(completed ? [{ type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 900_000 } }, { type: 'message_stop' }] : []),
    ]);
  }
}
afterEach(() => { delete process.env.KODO_HARDENING_TEST_KEY; });

describe.each(protocols)('%s gateway hardening', protocol => {
  it.each([
    { value: { type: 'new_api_error', code: 'get_channel_failed' }, code: 'MODEL_TRANSPORT' },
    { value: { type: 'get_channel_failed' }, code: 'MODEL_TRANSPORT' },
    { value: { type: 'error', error: { type: 'overloaded_error' } }, code: 'MODEL_TRANSPORT' },
    { value: { type: 'error', error: { type: 'authentication_error' } }, code: 'MODEL_AUTH' },
    { value: { type: 'error', error: { code: 'insufficient_quota' } }, code: 'MODEL_QUOTA' },
    { value: { type: 'error', error: { code: 'context_length_exceeded' } }, code: 'MODEL_CONTEXT' },
    { value: { type: 'error', error: { type: 'invalid_request_error' } }, code: 'MODEL_REQUEST' },
    { value: { type: 'error', error: { type: 'rate_limit_error' } }, code: 'MODEL_RATE_LIMIT' },
  ])('classifies HTTP 200 $code envelopes without exposing their contents', async ({ value, code }) => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const baseURL = await mockServer((_body, response) => events(response, [{ ...value, message: fixtureSecret }]));
    const failure = await provider(protocol).complete(request(protocol, baseURL), new AbortController().signal, () => {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KodoError);
    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain(fixtureSecret);
    expect(JSON.stringify(failure)).not.toContain(fixtureSecret);
    expect((failure as KodoError).metadata?.usageKnownZero).toBeUndefined();
  });

  it('recognizes a named SSE error event with no JSON type field', async () => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const baseURL = await mockServer((_body, response) => events(response, [{ code: 'get_channel_failed', message: fixtureSecret }], 'error'));
    await expect(provider(protocol).complete(request(protocol, baseURL), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_TRANSPORT' });
  });

  it('recognizes the observed CodeGo heartbeat followed by bare JSON error, including split UTF-8 and no final newline', async () => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const baseURL = await mockServer((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from(`: PING\n\n${JSON.stringify({ error: { type: 'new_api_error', code: 'get_channel_failed', message: `当前模型服务暂不可用 ${fixtureSecret}` } })}`);
      for (let offset = 0; offset < bytes.length; offset += 7) response.write(bytes.subarray(offset, offset + 7));
      response.end();
    });
    const failure = await provider(protocol).complete(request(protocol, baseURL), new AbortController().signal, () => {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MODEL_TRANSPORT' });
    expect(String(failure)).not.toContain(fixtureSecret);
    expect((failure as KodoError).metadata?.usageKnownZero).toBeUndefined();
  });

  it('still classifies a gateway failure after more than 2 MB of ignored heartbeat data', async () => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const baseURL = await mockServer((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`: ${'a'.repeat(2_000_001)}\n\n${JSON.stringify({ error: { code: 'get_channel_failed', message: fixtureSecret } })}`);
    });
    const failure = await provider(protocol).complete(request(protocol, baseURL), new AbortController().signal, () => {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MODEL_TRANSPORT' });
    expect(String(failure)).not.toContain(fixtureSecret);
    expect((failure as KodoError).metadata?.usageKnownZero).toBeUndefined();
  });

  it('accepts complete output larger than 2 MB when the caller allows it', async () => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const content = '正文🙂'.repeat(300_000);
    const baseURL = await mockServer((body, response) => {
      expect(body[protocol === 'chat-completions' ? 'max_completion_tokens' : protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(3_000_000);
      largeText(protocol, response, content, true);
    });
    const input = { ...request(protocol, baseURL), maxOutputTokens: 3_000_000 };
    const chunks: string[] = [];
    const result = await provider(protocol).complete(input, new AbortController().signal, chunk => chunks.push(chunk));
    expect(result.message.content).toBe(content);
    expect(chunks.join('')).toBe(content);
    expect(result.finishReason).toBe('stop');
  });

  it('rejects incomplete large output and preserves caller cancellation after large deltas', async () => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const content = 'a'.repeat(2_000_001);
    let attempts = 0;
    const baseURL = await mockServer((_body, response) => largeText(protocol, response, content, ++attempts > 1));
    const input = { ...request(protocol, baseURL), maxOutputTokens: 3_000_000 };
    await expect(provider(protocol).complete(input, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_INCOMPLETE' });
    const controller = new AbortController();
    const reason = new Error('caller cancelled large output');
    await expect(provider(protocol).complete(input, controller.signal, () => controller.abort(reason))).rejects.toBe(reason);
  });

  it('continues to reject invalid UTF-8 after removing the stream size bound', async () => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const baseURL = await mockServer((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(Buffer.from([0xc3, 0x28]));
    });
    await expect(provider(protocol).complete(request(protocol, baseURL), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_TRANSPORT' });
  });

  it.each([
    { status: 429, type: 'rate_limit_error', code: 'MODEL_RATE_LIMIT', zero: true },
    { status: 429, type: 'insufficient_quota', code: 'MODEL_QUOTA', zero: true },
    { status: 403, type: 'authentication_error', code: 'MODEL_AUTH', zero: undefined },
    { status: 400, type: 'context_length_exceeded', code: 'MODEL_CONTEXT', zero: undefined },
    { status: 502, type: 'server_error', code: 'MODEL_TRANSPORT', zero: undefined },
  ])('attaches safe HTTP $status metadata and preserves unknown usage', async ({ status, type, code, zero }) => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    let attempts = 0;
    const baseURL = await mockServer((_body, response) => {
      attempts++;
      response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '30', 'retry-after-ms': '125' });
      response.end(JSON.stringify({ error: { type, message: fixtureSecret } }));
    });
    const failure = await provider(protocol).complete(request(protocol, baseURL), new AbortController().signal, () => {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code, metadata: { status, retryAfterMs: 125 } });
    expect((failure as KodoError).metadata?.usageKnownZero).toBe(zero);
    expect(String(failure)).not.toContain(fixtureSecret);
    expect(attempts).toBe(1);
  });

  it.each([undefined, 'off', 'session'] as const)('sends cache hints only for explicit session policy (%s)', async policy => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const received: Event[] = [];
    const baseURL = await mockServer((body, response) => { received.push(body); success(protocol, response); });
    const input = request(protocol, baseURL);
    input.binding.promptCache = policy;
    input.cacheKey = 'stable-session-id';
    await provider(protocol).complete(input, new AbortController().signal, () => {});
    expect(received).toHaveLength(1);
    if (protocol === 'anthropic') expect(received[0]?.system).toEqual(policy === 'session'
      ? [{ type: 'text', text: 'stable system', cache_control: { type: 'ephemeral' } }] : 'stable system');
    else expect(received[0]?.prompt_cache_key).toBe(policy === 'session' ? 'stable-session-id' : undefined);
    expect(JSON.stringify(received[0])).not.toContain(fixtureSecret);
  });

  it('does not send an incomplete cache policy without a session key', async () => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const baseURL = await mockServer((body, response) => {
      expect(body.prompt_cache_key).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('cache_control');
      success(protocol, response);
    });
    const input = request(protocol, baseURL);
    input.binding.promptCache = 'session';
    await provider(protocol).complete(input, new AbortController().signal, () => {});
  });

  it('reports cache counters without double counting cached input', async () => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const baseURL = await mockServer((_body, response) => success(protocol, response, 7));
    const result = await provider(protocol).complete(request(protocol, baseURL), new AbortController().signal, () => {});
    expect(result.usage).toEqual(protocol === 'anthropic' ? { input: 20, output: 4, cacheRead: 7, cacheWrite: 3 } : { input: 20, output: 4, cacheRead: 7 });
  });

  it('rejects invalid cache counters', async () => {
    process.env.KODO_HARDENING_TEST_KEY = fixtureSecret;
    const baseURL = await mockServer((_body, response) => success(protocol, response, -1));
    await expect(provider(protocol).complete(request(protocol, baseURL), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
  });
});

describe('bounded Retry-After interpretation', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  it.each([
    [{ 'retry-after': '1.5' }, 1500],
    [{ 'retry-after': 'Tue, 20 Oct 2026 00:00:03 GMT' }, 3000],
    [{ 'retry-after-ms': '1000000000' }, 60_000],
    [{ 'retry-after-ms': 'bad', 'retry-after': '2' }, 2000],
    [{ 'retry-after': '-1' }, undefined],
    [{ 'retry-after': 'not a date' }, undefined],
    [{ 'retry-after': 'Tue, 20 Oct 2026 00:00:00 GMT' }, 0],
  ] as [Record<string, string>, number | undefined][])('bounds and validates %j', (headers, expected) => {
    expect(retryDelay(new Headers(headers), now)).toBe(expected);
  });
});
