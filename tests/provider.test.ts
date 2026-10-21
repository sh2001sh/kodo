import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Application } from '../src/application/index.js';
import { ChatCompletionsProvider } from '../src/providers/openai.js';
import { ResponsesProvider } from '../src/providers/responses.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { delta, mockServer, sendStream } from './http-server.js';
import { temp } from './helpers.js';

afterEach(() => { delete process.env.KODO_HTTP_TEST_KEY; });
const binding = (baseURL: string) => ({ limits: { context: 256_000, output: 8192 }, baseURL, model: 'test-model', apiKeyEnv: 'KODO_HTTP_TEST_KEY' });
describe('Chat Completions SDK adapter', () => {
  it('rejects foreign provider state and colliding tool names before sending a request', async () => {
    process.env.KODO_HTTP_TEST_KEY = 'local-fixture';
    let requests = 0;
    const baseURL = await mockServer((_body, response) => { requests++; sendStream(response, [delta({ content: 'unexpected' }), delta({}, 'stop')]); });
    const provider = new ChatCompletionsProvider();
    const request = { binding: binding(baseURL), messages: [{ role: 'assistant' as const, content: 'private', providerData: { protocol: 'responses' as const, output: [] } }], tools: [], maxOutputTokens: 20 };
    await expect(provider.complete(request, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    const tools = ['file.read', 'file_read'].map(name => ({ name, description: 'test', parameters: { type: 'object' } }));
    await expect(provider.complete({ ...request, messages: [{ role: 'user', content: 'test' }], tools }, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    expect(requests).toBe(0);
  });
  it.each([
    ['responses', () => new ResponsesProvider()], ['anthropic', () => new AnthropicProvider()],
  ] as const)('rejects Chat Completions reasoning history in %s before sending', async (_protocol, create) => {
    process.env.KODO_HTTP_TEST_KEY = 'local-fixture';
    let requests = 0;
    const url = await mockServer((_body, response) => { requests++; sendStream(response, [delta({}, 'stop')]); });
    await expect(create().complete({
      binding: binding(url), messages: [{ role: 'assistant', content: null,
        providerData: { protocol: 'chat-completions', reasoningContent: 'private-reasoning-fixture' } }],
      tools: [], maxOutputTokens: 20,
    }, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    expect(requests).toBe(0);
  });
  it('joins split tool arguments and privately round-trips reasoning, wire names and tool IDs', async () => {
    process.env.KODO_HTTP_TEST_KEY = 'local-fixture-not-a-real-key';
    let rounds = 0;
    const privateReasoning = 'fixture-private-reasoning-part-one-part-two';
    const url = await mockServer((body, response) => {
      rounds++;
      const tools = body.tools as { function: { name: string } }[];
      expect(tools.some(x => x.function.name === 'artifact_write')).toBe(true);
      expect(tools.every(x => /^[a-zA-Z0-9_-]+$/.test(x.function.name))).toBe(true);
      if (rounds === 1) {
        sendStream(response, [
          delta({ reasoning_content: 'fixture-private-reasoning-part-one-' }),
          delta({ tool_calls: [{ index: 0, id: 'call-real-id', type: 'function', function: { name: 'artifact_write', arguments: '{"name":"r",' } }] }),
          delta({ reasoning_content: 'part-two' }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '"content":"checked"}' } }] }),
          delta({}, 'tool_calls'),
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
        ]);
      } else {
        const messages = body.messages as { role: string; reasoning_content?: string; tool_calls?: { function: { name: string }; id: string }[]; tool_call_id?: string }[];
        expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-real-id' });
        expect(messages.at(-2)?.tool_calls?.[0]).toMatchObject({ id: 'call-real-id', function: { name: 'artifact_write' } });
        expect(messages.at(-2)?.reasoning_content).toBe(privateReasoning);
        expect(messages.at(-2)).not.toHaveProperty('providerData');
        sendStream(response, [delta({ reasoning_content: 'second-round-private-reasoning' }), delta({ content: 'validated' }), delta({}, 'stop'), { choices: [], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } }]);
      }
    });
    const root = temp();
    let visibleText = '';
    const app = new Application(path.join(root, 'state'), new ChatCompletionsProvider(), (_id, text) => { visibleText += text; });
    try {
      const run = app.createRun({ objective: 'test', workspace: root, binding: binding(url), permissions: ['read', 'write'] });
      const result = await app.coordinator.wake(run.id);
      expect(result.status).toBe('completed');
      expect(rounds).toBe(2);
      expect(app.store.session(run.sessionId)).toMatchObject({ tokens: 80, usageEstimated: false });
      const firstCall = app.store.calls(run.id).find(call => call.kind === 'model');
      expect(app.store.readBlob(firstCall!.resultRef!)).toMatchObject({ message: {
        content: null, providerData: { protocol: 'chat-completions', reasoningContent: privateReasoning },
      } });
      expect(visibleText).toBe('validated');
      expect(app.store.readBlob(result.resultRef!)).toMatchObject({ text: 'validated' });
      expect(JSON.stringify(app.store.readBlob(result.resultRef!))).not.toContain('private-reasoning');
    } finally { app.close(); }
  });
  it.each(['content', 'reasoning_content'])('accepts a complete SSE stream over 2 MB of %s without exposing reasoning', async field => {
    process.env.KODO_HTTP_TEST_KEY = 'local-fixture';
    const part = 'x'.repeat(64_000);
    const count = 33;
    const maxOutputTokens = 262_144;
    const url = await mockServer((body, response) => {
      expect(body.max_completion_tokens).toBe(maxOutputTokens);
      sendStream(response, [
        ...Array.from({ length: count }, () => delta({ [field]: part })),
        delta({ reasoning_content: 'private-reasoning-fixture' }),
        delta({ content: 'completed' }), delta({}, 'stop'),
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 260_000 } },
      ]);
    });
    let received = '';
    const result = await new ChatCompletionsProvider().complete({
      binding: binding(url), messages: [{ role: 'user', content: 'large fixture' }], tools: [], maxOutputTokens,
    }, new AbortController().signal, text => { received += text; });
    const expectedLength = (field === 'content' ? part.length * count : 0) + 'completed'.length;
    expect(result.finishReason).toBe('stop');
    expect(result.message.content?.length).toBe(expectedLength);
    expect(received.length).toBe(expectedLength);
    expect(received.endsWith('completed')).toBe(true);
    expect(received.includes('private-reasoning-fixture')).toBe(false);
    expect(result.message.content?.includes('private-reasoning-fixture')).toBe(false);
    expect(result.message.tool_calls).toBeUndefined();
    expect(result.message.providerData?.protocol).toBe('chat-completions');
    expect(result.usage).toEqual({ input: 20, output: 260_000 });
  });
  it('rejects a malformed reasoning delta without exposing its payload', async () => {
    process.env.KODO_HTTP_TEST_KEY = 'local-fixture';
    const url = await mockServer((_body, response) => sendStream(response, [
      delta({ reasoning_content: { private: 'private-reasoning-fixture' } }), delta({}, 'stop'),
    ]));
    let visibleText = '';
    const failure = await new ChatCompletionsProvider().complete({
      binding: binding(url), messages: [{ role: 'user', content: 'test' }], tools: [], maxOutputTokens: 20,
    }, new AbortController().signal, text => { visibleText += text; }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MODEL_PROTOCOL' });
    expect(String(failure)).not.toContain('private-reasoning-fixture');
    expect(visibleText).toBe('');
  });
  it.each(['length', null])('executes no tool from a truncated response (finish=%s)', async finish => {
    process.env.KODO_HTTP_TEST_KEY = 'local-fixture';
    const url = await mockServer((_body, response) => sendStream(response, [
      delta({ tool_calls: [{ index: 0, id: 'bad', function: { name: 'file_apply_patch', arguments: '{"path":"should-not-exist.txt","expectedHash":null,"content":"bad"}' } }] }),
      ...(finish ? [delta({}, finish)] : []),
    ], false));
    const root = temp();
    const app = new Application(path.join(root, 'state'));
    try {
      const run = app.createRun({ objective: 'test', workspace: root, binding: binding(url), permissions: ['read', 'write'] });
      const result = await app.coordinator.wake(run.id);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('MODEL_INCOMPLETE');
      expect(existsSync(path.join(root, 'should-not-exist.txt'))).toBe(false);
      expect(app.store.calls(run.id).filter(x => x.kind === 'tool')).toHaveLength(0);
    } finally { app.close(); }
  });
  it('does not retry rate limits or retain provider error bodies', async () => {
    process.env.KODO_HTTP_TEST_KEY = 'do-not-log-this-key';
    let attempts = 0;
    const url = await mockServer((_body, response) => {
      attempts++;
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'do-not-log-this-key', type: 'rate_limit_error' } }));
    });
    const provider = new ChatCompletionsProvider();
    await expect(provider.complete({ binding: binding(url), messages: [{ role: 'user', content: 'x' }], tools: [], maxOutputTokens: 20 }, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_RATE_LIMIT', message: 'provider request failed (HTTP 429)' });
    expect(attempts).toBe(1);
  });
  it.each([
    { status: 400, attempts: 1, code: 'MODEL_REQUEST' },
    { status: 404, attempts: 1, code: 'MODEL_REQUEST' },
    { status: 422, attempts: 1, code: 'MODEL_REQUEST' },
    { status: 502, attempts: 3, code: 'MODEL_TRANSPORT' },
  ])('makes $attempts accounted runtime attempt(s) for HTTP $status', async ({ status, attempts, code }) => {
    process.env.KODO_HTTP_TEST_KEY = 'local-fixture-key-never-log';
    let received = 0;
    const url = await mockServer((_body, response) => {
      received++;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'local-fixture-key-never-log private provider diagnostic', type: 'request_error' } }));
    });
    const root = temp();
    const app = new Application(path.join(root, 'state'));
    try {
      const run = app.createRun({ objective: 'Validate error policy', workspace: root, binding: binding(url), budget: { maxTokens: 200_000 } });
      const result = await app.run(run.id);
      expect(result.status).toBe('failed');
      expect(result.error).toContain(code);
      expect(received).toBe(attempts);
      const recorded = app.store.calls(run.id);
      expect(recorded).toHaveLength(attempts);
      expect(recorded.every(call => call.kind === 'model' && call.status === 'failed')).toBe(true);
      expect(new Set(recorded.map(call => call.requestRef)).size).toBe(1);
      expect(app.store.session(run.sessionId)).toMatchObject({ modelCalls: attempts, usageEstimated: true });
      expect(JSON.stringify({ result, events: app.store.events(run.id), results: recorded.map(call => app.store.readBlob(call.resultRef!)) })).not.toContain('local-fixture-key-never-log');
    } finally { app.close(); }
  });
  it('stops transient HTTP retries at the shared model-call budget', async () => {
    process.env.KODO_HTTP_TEST_KEY = 'local-fixture';
    let received = 0;
    const url = await mockServer((_body, response) => {
      received++;
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'temporary upstream failure' } }));
    });
    const root = temp();
    const app = new Application(path.join(root, 'state'));
    try {
      const run = app.createRun({ objective: 'Validate retry budget', workspace: root, binding: binding(url), budget: { maxModelCalls: 1 } });
      const result = await app.run(run.id);
      expect(result.error).toContain('MODEL_BUDGET');
      expect(received).toBe(1);
      expect(app.store.session(run.sessionId).modelCalls).toBe(1);
    } finally { app.close(); }
  });
  it('cancels an open SDK stream after tool arguments arrive without executing the call', async () => {
    process.env.KODO_HTTP_TEST_KEY = 'local-fixture';
    let responseObserved: (() => void) | undefined;
    const observed = new Promise<void>(resolve => { responseObserved = resolve; });
    let responseClosed: (() => void) | undefined;
    const closed = new Promise<void>(resolve => { responseClosed = resolve; });
    const url = await mockServer((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.once('close', () => responseClosed!());
      response.write(`data: ${JSON.stringify(delta({ tool_calls: [{ index: 0, id: 'pending-write', type: 'function', function: {
        name: 'file_apply_patch', arguments: '{"path":"should-not-exist.txt","expectedHash":null,"content":"bad"}',
      } }] }))}\n\n`);
      response.write(`data: ${JSON.stringify(delta({ content: 'in progress' }))}\n\n`);
    });
    const root = temp();
    const app = new Application(path.join(root, 'state'), new ChatCompletionsProvider(), () => responseObserved!());
    try {
      const run = app.createRun({ objective: 'cancel', workspace: root, binding: binding(url), permissions: ['read', 'write'] });
      const pending = app.coordinator.wake(run.id);
      await observed;
      app.coordinator.cancel(run.id);
      expect((await pending).status).toBe('cancelled');
      await closed;
      expect(existsSync(path.join(root, 'should-not-exist.txt'))).toBe(false);
      expect(app.store.calls(run.id).filter(x => x.kind === 'tool')).toHaveLength(0);
    } finally { app.close(); }
  });
});
