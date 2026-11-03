import { afterEach, describe, expect, it, vi } from 'vitest';
import { timedProviderFetch } from '../src/providers/transport.js';
import { ChatCompletionsProvider } from '../src/providers/openai.js';
import { ResponsesProvider } from '../src/providers/responses.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { ModelProtocol, Provider } from '../src/runtime/types.js';

const silence = 120_000;
const encoder = new TextEncoder();
const event = (value: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
const providers: ModelProtocol[] = ['chat-completions', 'responses', 'anthropic'];
const provider = (protocol: ModelProtocol): Provider => protocol === 'responses' ? new ResponsesProvider() : protocol === 'anthropic' ? new AnthropicProvider() : new ChatCompletionsProvider();
const request = (protocol: ModelProtocol): Parameters<Provider['complete']>[0] => ({
  binding: { protocol, baseURL: 'http://fixture.invalid/v1', model: 'fixture', apiKeyEnv: 'KODO_TRANSPORT_TEST_KEY' },
  messages: [{ role: 'user', content: 'task' }], tools: [], maxOutputTokens: 20,
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); delete process.env.KODO_TRANSPORT_TEST_KEY; });

function streamingFetch(initial?: Uint8Array) {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  const cancel = vi.fn();
  const fake = vi.fn<typeof fetch>(async (_input, options) => {
    signal = options!.signal!;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; if (initial) source.enqueue(initial); },
      cancel,
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fake);
  return { fake, cancel, get source() { return source; }, get signal() { return signal; } };
}

describe('provider transport silence deadlines', () => {
  it('does not mistake headers for the first response byte', async () => {
    vi.useFakeTimers();
    const fixture = streamingFetch();
    const response = await timedProviderFetch('http://fixture.invalid');
    const outcome = response.text().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(silence);
    expect(await outcome).toMatchObject({ code: 'MODEL_TRANSPORT', metadata: { timeoutPhase: 'first_byte', usageKnownZero: false } });
    expect(fixture.signal.aborted).toBe(true);
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a continuously active stream running beyond multiple idle deadlines and clears the timer at EOF', async () => {
    vi.useFakeTimers();
    const fixture = streamingFetch(encoder.encode('a'));
    const response = await timedProviderFetch('http://fixture.invalid');
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    for (let index = 0; index < 5; index++) {
      await vi.advanceTimersByTimeAsync(silence - 1);
      fixture.source.enqueue(encoder.encode('b'));
      expect((await reader.read()).done).toBe(false);
    }
    fixture.source.close();
    expect((await reader.read()).done).toBe(true);
    expect(fixture.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('immediately propagates caller cancellation and clears the idle timer', async () => {
    vi.useFakeTimers();
    const fixture = streamingFetch(encoder.encode('a'));
    const parent = new AbortController();
    const response = await timedProviderFetch('http://fixture.invalid', { signal: parent.signal });
    const reader = response.body!.getReader(); await reader.read();
    const outcome = reader.read().catch((error: unknown) => error);
    const reason = new Error('caller stopped'); parent.abort(reason);
    expect(await outcome).toBe(reason);
    expect(fixture.signal.reason).toBe(reason);
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up when a consumer ends early, including a Request-owned signal', async () => {
    vi.useFakeTimers();
    const fixture = streamingFetch();
    const parent = new AbortController();
    const response = await timedProviderFetch(new Request('http://fixture.invalid', { signal: parent.signal }));
    await response.body!.cancel();
    expect(fixture.signal.aborted).toBe(true);
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    parent.abort();
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });
});

describe.each(providers)('%s silence handling', protocol => {
  it('times out content silence despite heartbeat and metadata traffic', async () => {
    vi.useFakeTimers(); process.env.KODO_TRANSPORT_TEST_KEY = 'fixture';
    const metadata = protocol === 'chat-completions' ? event({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 0 } })
      : protocol === 'responses' ? event({ type: 'response.in_progress', response: { status: 'in_progress' } })
        : event({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 0 } } });
    const fixture = streamingFetch(metadata);
    const outcome = provider(protocol).complete(request(protocol), new AbortController().signal, () => {}).catch((error: unknown) => error);
    for (let index = 0; index < 2; index++) {
      await vi.advanceTimersByTimeAsync(60_000);
      fixture.source.enqueue(protocol === 'anthropic' ? event({ type: 'ping' }) : metadata);
      fixture.source.enqueue(encoder.encode(': heartbeat\n\n'));
    }
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fixture.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ code: 'MODEL_TRANSPORT', metadata: { timeoutPhase: 'content_idle', timeoutMs: 180_000, partialResponse: true, usageKnownZero: false } });
    expect(fixture.signal.aborted).toBe(true);
    expect(fixture.fake).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['text', 'reasoning', 'tool'] as const)('keeps %s increments alive beyond the content deadline without requiring visible text', async kind => {
    vi.useFakeTimers(); process.env.KODO_TRANSPORT_TEST_KEY = 'fixture';
    const block = kind === 'text' ? { type: 'text', text: '' } : kind === 'reasoning'
      ? { type: 'thinking', thinking: '' } : { type: 'tool_use', id: 'call1', name: 'read', input: {} };
    const initial = protocol === 'anthropic' ? encoder.encode(
      new TextDecoder().decode(event({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 0 } } }))
      + new TextDecoder().decode(event({ type: 'content_block_start', index: 0, content_block: block }))) : encoder.encode(': started\n\n');
    const delta = protocol === 'chat-completions' ? event({ choices: [{ index: 0, delta: kind === 'text' ? { content: 'x' }
      : kind === 'reasoning' ? { reasoning_content: 'x' } : { tool_calls: [{ index: 0, function: { arguments: 'x' } }] }, finish_reason: null }] })
      : protocol === 'responses' ? event({ type: kind === 'text' ? 'response.output_text.delta' : kind === 'reasoning'
        ? 'response.reasoning_summary_text.delta' : 'response.function_call_arguments.delta', delta: 'x' })
        : event({ type: 'content_block_delta', index: 0, delta: kind === 'text' ? { type: 'text_delta', text: 'x' }
          : kind === 'reasoning' ? { type: 'thinking_delta', thinking: 'x' } : { type: 'input_json_delta', partial_json: 'x' } });
    const fixture = streamingFetch(initial);
    const parent = new AbortController();
    const onText = vi.fn();
    const outcome = provider(protocol).complete(request(protocol), parent.signal, onText).catch((error: unknown) => error);
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(90_000);
      expect(fixture.signal.aborted).toBe(false);
      fixture.source.enqueue(delta);
    }
    await vi.advanceTimersByTimeAsync(0);
    if (kind !== 'text') expect(onText).not.toHaveBeenCalled();
    const reason = new Error('caller finished'); parent.abort(reason);
    expect(await outcome).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies an initial stalled fetch without retrying or claiming zero usage', async () => {
    vi.useFakeTimers(); process.env.KODO_TRANSPORT_TEST_KEY = 'fixture';
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const fake = vi.fn<typeof fetch>((_input, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
      entered();
    }));
    vi.stubGlobal('fetch', fake);
    const outcome = provider(protocol).complete(request(protocol), new AbortController().signal, () => {}).catch((error: unknown) => error);
    await ready;
    await vi.advanceTimersByTimeAsync(silence);
    expect(await outcome).toMatchObject({ code: 'MODEL_TRANSPORT', metadata: { timeoutPhase: 'first_byte', usageKnownZero: false } });
    expect(fake).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves partial response classification when the stream becomes idle', async () => {
    vi.useFakeTimers(); process.env.KODO_TRANSPORT_TEST_KEY = 'fixture';
    const initial = protocol === 'chat-completions' ? event({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })
      : protocol === 'responses' ? event({ type: 'response.output_text.delta', delta: 'partial' })
        : encoder.encode(new TextDecoder().decode(event({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 0 } } }))
          + new TextDecoder().decode(event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } })));
    const fixture = streamingFetch(initial);
    let received!: () => void;
    const ready = new Promise<void>(resolve => { received = resolve; });
    const outcome = provider(protocol).complete(request(protocol), new AbortController().signal, () => received()).catch((error: unknown) => error);
    await ready;
    await vi.advanceTimersByTimeAsync(silence);
    expect(await outcome).toMatchObject({ code: 'MODEL_TRANSPORT', metadata: { timeoutPhase: 'stream_idle', partialResponse: true, usageKnownZero: false } });
    expect(fixture.signal.aborted).toBe(true);
    expect(fixture.fake).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
