import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { ModelResponse, Provider } from '../src/runtime/types.js';
import { mockServer } from './http-server.js';
import { temp } from './helpers.js';

type Event = Record<string, unknown>;
const start = (usage = { input_tokens: 20, output_tokens: 1 }): Event => ({ type: 'message_start', message: { id: 'msg-fixture', role: 'assistant', content: [], usage } });
const blockStart = (index: number, content_block: Event): Event => ({ type: 'content_block_start', index, content_block });
const blockStop = (index: number): Event => ({ type: 'content_block_stop', index });
const blockDelta = (index: number, delta: Event): Event => ({ type: 'content_block_delta', index, delta });
const done = (stop_reason = 'end_turn', output_tokens = 10): Event[] => [
  { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens } }, { type: 'message_stop' },
];
const text = (value: string): Event[] => [blockStart(0, { type: 'text', text: '' }), blockDelta(0, { type: 'text_delta', text: value }), blockStop(0)];
const tool = (name = 'file_apply_patch', id = 'toolu-fixture', input = '{"path":"out.txt","expectedHash":null,"content":"checked"}'): Event[] => [
  blockStart(0, { type: 'tool_use', id, name, input: {} }),
  blockDelta(0, { type: 'input_json_delta', partial_json: input.slice(0, 18) }),
  blockDelta(0, { type: 'input_json_delta', partial_json: input.slice(18) }), blockStop(0),
];
const encode = (events: Event[], crlf = false): string => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('').replaceAll('\n', crlf ? '\r\n' : '\n');
function send(response: ServerResponse, events: Event[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(encode(events));
}
const binding = (baseURL: string) => ({ limits: { context: 256_000, output: 8192 }, baseURL, model: 'claude-fixture', apiKeyEnv: 'KODO_ANTHROPIC_TEST_KEY', protocol: 'anthropic' as const });
const request = (baseURL: string): Parameters<Provider['complete']>[0] => ({ binding: binding(baseURL), messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'test' }], tools: [], maxOutputTokens: 100 });
afterEach(() => { delete process.env.KODO_ANTHROPIC_TEST_KEY; });

describe('Anthropic Messages adapter', () => {
  it('executes a tool only after message_stop, then round-trips system, tool identity and actual result', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    let rounds = 0;
    const baseURL = await mockServer((body, response, incoming) => {
      expect(incoming.url).toBe('/v1/messages');
      expect(incoming.headers['x-api-key']).toBe('local-fixture');
      expect(incoming.headers['anthropic-version']).toBe('2023-06-01');
      expect(body).toMatchObject({ model: 'claude-fixture', max_tokens: 8192, stream: true });
      expect(typeof body.system).toBe('string');
      expect((body.tools as Event[]).find(item => item.name === 'file_apply_patch')).toHaveProperty('input_schema');
      if (++rounds === 1) send(response, [start(), ...tool(), ...done('tool_use')]);
      else {
        const messages = body.messages as { role: string; content: Event[] }[];
        expect(messages.at(-2)?.content).toContainEqual({ type: 'tool_use', id: 'toolu-fixture', name: 'file_apply_patch', input: { path: 'out.txt', expectedHash: null, content: 'checked' } });
        expect(messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-fixture' }] });
        expect(String(messages.at(-1)?.content[0]?.content)).toContain('out.txt');
        send(response, [start(), ...text('verified'), ...done()]);
      }
    });
    const root = temp();
    const app = new Application(path.join(root, 'state'), new AnthropicProvider());
    try {
      const run = app.createRun({ objective: 'test', workspace: root, binding: binding(baseURL), permissions: ['read', 'write'] });
      const result = await app.run(run.id);
      expect(result.status).toBe('completed');
      expect(rounds).toBe(2);
      expect(readFileSync(path.join(root, 'out.txt'), 'utf8')).toBe('checked');
      expect(app.store.session(run.sessionId)).toMatchObject({ tokens: 60, usageEstimated: false });
    } finally { app.close(); }
  });

  it('joins split UTF-8, CRLF SSE, text, JSON inputs, cache counters and signed thinking without displaying it', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    let round = 0;
    const baseURL = await mockServer((body, response) => {
      if (++round === 2) {
        const messages = body.messages as { role: string; content: Event[] }[];
        expect(messages[1]?.content).toEqual([
          { type: 'thinking', thinking: '秘密思考', signature: 'opaque-signature' },
          { type: 'redacted_thinking', data: 'redacted-opaque' },
          { type: 'text', text: '你好🙂' },
          { type: 'tool_use', id: 'toolu-test', name: 'artifact_write', input: { content: '中文🙂' } },
        ]);
        expect(messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu-test', content: 'saved' }, { type: 'tool_result', tool_use_id: 'second-id', content: 'second-result' }]);
        send(response, [start(), ...text('done'), ...done('stop_sequence')]);
        return;
      }
      const events = [
        start({ input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } as { input_tokens: number; output_tokens: number }),
        { type: 'ping' },
        blockStart(0, { type: 'thinking', thinking: '' }),
        blockDelta(0, { type: 'thinking_delta', thinking: '秘密' }), blockDelta(0, { type: 'thinking_delta', thinking: '思考' }),
        blockDelta(0, { type: 'signature_delta', signature: 'opaque-' }), blockDelta(0, { type: 'signature_delta', signature: 'signature' }), blockStop(0),
        blockStart(1, { type: 'redacted_thinking', data: 'redacted-opaque' }), blockStop(1),
        blockStart(2, { type: 'text', text: '你' }), blockDelta(2, { type: 'text_delta', text: '好🙂' }), blockStop(2),
        blockStart(3, { type: 'tool_use', id: 'toolu-test', name: 'artifact_write', input: {} }),
        blockDelta(3, { type: 'input_json_delta', partial_json: '{"content":"中' }), blockDelta(3, { type: 'input_json_delta', partial_json: '文🙂"}' }), blockStop(3), ...done('tool_use', 13),
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from(`: keepalive\r\n\r\n${encode(events, true)}`);
      for (let offset = 0; offset < bytes.length; offset += 7) response.write(bytes.subarray(offset, offset + 7));
      response.end();
    });
    const provider = new AnthropicProvider();
    const chunks: string[] = [];
    const first = await provider.complete(request(baseURL), new AbortController().signal, chunk => chunks.push(chunk));
    expect(first.usage).toEqual({ input: 21, output: 13, cacheRead: 7, cacheWrite: 3 });
    expect(chunks.join('')).toBe('你好🙂');
    expect(first.message.tool_calls).toEqual([{ id: 'toolu-test', name: 'artifact_write', arguments: '{"content":"中文🙂"}' }]);
    const second = await provider.complete({ ...request(baseURL), messages: [
      { role: 'user', content: 'test' }, first.message,
      { role: 'tool', tool_call_id: 'toolu-test', content: 'saved' }, { role: 'tool', tool_call_id: 'second-id', content: 'second-result' },
    ] }, new AbortController().signal, () => {});
    expect(second.message.content).toBe('done');
  });

  it.each(['max_tokens', 'pause_turn', 'refusal', 'end_turn-without-stop', 'disconnect'])('executes no tool for incomplete response: %s', async finish => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    const baseURL = await mockServer((_body, response) => send(response, [start(), ...tool(),
      ...(finish === 'disconnect' ? [] : finish === 'end_turn-without-stop' ? [{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }] : done(finish)),
    ]));
    const root = temp();
    const app = new Application(path.join(root, 'state'), new AnthropicProvider());
    try {
      const run = app.createRun({ objective: 'test', workspace: root, binding: binding(baseURL), permissions: ['read', 'write'] });
      const result = await app.run(run.id);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('MODEL_INCOMPLETE');
      expect(existsSync(path.join(root, 'out.txt'))).toBe(false);
      expect(app.store.calls(run.id).filter(call => call.kind === 'tool')).toHaveLength(0);
    } finally { app.close(); }
  });

  it.each([
    { status: 401, code: 'MODEL_AUTH' }, { status: 429, code: 'MODEL_RATE_LIMIT' },
    { status: 422, code: 'MODEL_REQUEST' }, { status: 502, code: 'MODEL_TRANSPORT' },
  ])('redacts HTTP $status response bodies without retrying', async ({ status, code }) => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'fixture-key-must-not-leak';
    let attempts = 0;
    const baseURL = await mockServer((_body, response) => { attempts++; response.writeHead(status); response.end('fixture-key-must-not-leak private prompt'); });
    const provider = new AnthropicProvider();
    await expect(provider.complete(request(baseURL), new AbortController().signal, () => {})).rejects.toMatchObject({ code, message: `provider request failed (HTTP ${status})` });
    expect(attempts).toBe(1);
  });

  it('redacts SSE error payloads', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    const baseURL = await mockServer((_body, response) => send(response, [start(), { type: 'error', error: { type: 'overloaded_error', message: 'private-provider-payload' } }]));
    await expect(new AnthropicProvider().complete(request(baseURL), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_TRANSPORT', message: 'provider returned a stream error' });
  });

  it('uses cumulative output usage across multiple message deltas rather than summing it', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    const baseURL = await mockServer((_body, response) => send(response, [start(), ...text('done'),
      { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 3 } }, ...done('end_turn', 9),
    ]));
    const result = await new AnthropicProvider().complete(request(baseURL), new AbortController().signal, () => {});
    expect(result.usage).toEqual({ input: 20, output: 9 });
  });

  it('uses cumulative input and cache usage updates without counting the same cache twice', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    const baseURL = await mockServer((_body, response) => send(response, [start(), ...text('done'),
      { type: 'message_delta', delta: { stop_reason: null }, usage: { input_tokens: 22, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 3 } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 22, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 9 } },
      { type: 'message_stop' },
    ]));
    const result = await new AnthropicProvider().complete(request(baseURL), new AbortController().signal, () => {});
    expect(result.usage).toEqual({ input: 32, output: 9, cacheRead: 7, cacheWrite: 3 });
  });

  it('rejects JSON responses when a stream was requested instead of accepting an unverified completion', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    const baseURL = await mockServer((_body, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"private":"payload"}'); });
    await expect(new AnthropicProvider().complete(request(baseURL), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_PROTOCOL', message: 'provider did not return an event stream' });
  });

  it.each([
    ['event before start', [...text('bad'), ...done()]],
    ['tool reason without tools', [start(), ...text('bad'), ...done('tool_use')]],
    ['tools with end_turn', [start(), ...tool(), ...done()]],
    ['unclosed block', [start(), blockStart(0, { type: 'text', text: 'bad' }), ...done()]],
    ['duplicate block', [start(), ...text('x'), ...text('y'), ...done()]],
    ['negative usage', [start({ input_tokens: -1, output_tokens: 0 }), ...done()]],
    ['fractional usage', [start(), ...text('x'), ...done('end_turn', 1.5)]],
    ['invalid tool json', [start(), ...tool('artifact_write', 'id', '{broken'), ...done('tool_use')]],
    ['unsigned thinking', [start(), blockStart(0, { type: 'thinking', thinking: 'private' }), blockStop(0), ...done()]],
    ['prepopulated content', [{ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'lost' }], usage: { input_tokens: 1, output_tokens: 1 } } }, ...done()]],
    ['unknown block', [start(), blockStart(0, { type: 'server_tool_use', id: 'server' }), blockStop(0), ...done()]],
  ] as [string, Event[]][])('rejects malformed wire sequence: %s', async (_label, events) => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    const baseURL = await mockServer((_body, response) => send(response, events));
    await expect(new AnthropicProvider().complete(request(baseURL), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
  });

  it('cancels an open stream without yielding partial tool calls', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const baseURL = await mockServer((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(encode([start(), blockStart(0, { type: 'tool_use', id: 'cancelled', name: 'file_apply_patch', input: {} })]));
      started();
    });
    const controller = new AbortController();
    const reason = new Error('cancel-test');
    const pending = new AnthropicProvider().complete(request(baseURL), controller.signal, () => {});
    await ready;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('accepts a complete large response within the caller output allowance', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    const content = 'a'.repeat(2_000_001);
    const baseURL = await mockServer((_body, response) => send(response, [start(), ...text(content), ...done()]));
    const result = await new AnthropicProvider().complete({ ...request(baseURL), maxOutputTokens: 3_000_000 }, new AbortController().signal, () => {});
    expect(result.message.content).toBe(content);
    expect(result.finishReason).toBe('stop');
  });

  it('rejects missing credentials before any request', async () => {
    await expect(new AnthropicProvider().complete(request('http://127.0.0.1:1/v1'), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_CREDENTIAL' });
  });

  it('does not lose signed thinking when the response is used as persisted assistant history', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    const first: ModelResponse = { message: { role: 'assistant', content: null, providerData: { protocol: 'anthropic', blocks: [{ type: 'thinking', thinking: 'signed', signature: 'signature' }, { type: 'tool_use', id: 'toolu-a', name: 'artifact_write', input: {} }] }, tool_calls: [{ id: 'toolu-a', name: 'artifact.write', arguments: '{}' }] }, finishReason: 'tool_calls' };
    const baseURL = await mockServer((body, response) => {
      expect((body.messages as { content: Event[] }[])[1]?.content).toEqual(first.message.providerData?.protocol === 'anthropic' ? first.message.providerData.blocks : null);
      send(response, [start(), ...text('done'), ...done()]);
    });
    await new AnthropicProvider().complete({ ...request(baseURL), messages: [{ role: 'user', content: 'test' }, JSON.parse(JSON.stringify(first.message)) as typeof first.message, { role: 'tool', tool_call_id: 'toolu-a', content: 'ok' }] }, new AbortController().signal, () => {});
  });

  it('replays interleaved thinking, text and tools in their original block order after persistence', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'local-fixture';
    let rounds = 0;
    const original: Event[] = [
      { type: 'thinking', thinking: 'first thought', signature: 'first-signature' },
      { type: 'text', text: 'before' },
      { type: 'tool_use', id: 'toolu-middle', name: 'artifact_write', input: { name: 'proof', content: 'saved' } },
      { type: 'thinking', thinking: 'second thought', signature: 'second-signature' },
      { type: 'text', text: 'after' },
      { type: 'redacted_thinking', data: 'opaque-last' },
    ];
    const baseURL = await mockServer((body, response) => {
      if (++rounds === 1) send(response, [start(), ...original.flatMap((block, index) => [blockStart(index, block), blockStop(index)]), ...done('tool_use')]);
      else {
        const messages = body.messages as { role: string; content: Event[] }[];
        expect(messages[1]?.content).toEqual(original);
        expect(messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu-middle', content: 'saved' }]);
        send(response, [start(), ...text('done'), ...done()]);
      }
    });
    const provider = new AnthropicProvider();
    const displayed: string[] = [];
    const first = await provider.complete(request(baseURL), new AbortController().signal, chunk => displayed.push(chunk));
    expect(displayed.join('')).toBe('beforeafter');
    expect(first.message.content).toBe('beforeafter');
    expect(first.message.tool_calls).toEqual([{ id: 'toolu-middle', name: 'artifact_write', arguments: '{"name":"proof","content":"saved"}' }]);
    const persisted = JSON.parse(JSON.stringify(first.message)) as typeof first.message;
    const result = await provider.complete({ ...request(baseURL), messages: [
      { role: 'user', content: 'test' }, persisted,
      { role: 'tool', tool_call_id: 'toolu-middle', content: 'saved' },
    ] }, new AbortController().signal, () => {});
    expect(result.message.content).toBe('done');
    expect(rounds).toBe(2);
  });

  it('refuses cross-origin redirects without forwarding the API key or request body', async () => {
    process.env.KODO_ANTHROPIC_TEST_KEY = 'fixture-private-credential';
    let forwarded = 0;
    const target = await mockServer((_body, response) => { forwarded++; response.writeHead(401); response.end('private body'); });
    const origin = await mockServer((_body, response) => {
      response.writeHead(307, { location: `${target}/capture` }); response.end();
    });
    await expect(new AnthropicProvider().complete(request(origin), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_TRANSPORT', message: 'provider request failed or stream disconnected' });
    expect(forwarded).toBe(0);
  });
});
