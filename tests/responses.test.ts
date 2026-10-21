import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { Application } from '../src/application/index.js';
import { ResponsesProvider } from '../src/providers/responses.js';
import { mockServer } from './http-server.js';
import { temp } from './helpers.js';

afterEach(() => { delete process.env.KODO_RESPONSES_TEST_KEY; });
const binding = (baseURL: string) => ({ limits: { context: 256_000, output: 8192 }, baseURL, model: 'test-model', apiKeyEnv: 'KODO_RESPONSES_TEST_KEY', protocol: 'responses' as const });
const request = (baseURL: string) => ({ binding: binding(baseURL), messages: [{ role: 'user' as const, content: 'test' }], tools: [], maxOutputTokens: 20 });
const toolItem = (call_id = 'call-preserved') => ({ type: 'function_call', id: 'fc-item-id', call_id, name: 'file_apply_patch', arguments: '{"path":"should-not-exist.txt","expectedHash":null,"content":"bad"}', status: 'completed' });
const completion = (output: Record<string, unknown>[], status = 'completed') => ({ type: 'response.completed', response: { id: 'resp-test', status, output, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
function stream(response: ServerResponse, events: Record<string, unknown>[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

describe('Responses SDK adapter', () => {
  it('replays full tool history using call_id and retains encrypted reasoning across rounds', async () => {
    process.env.KODO_RESPONSES_TEST_KEY = 'local-fixture-not-a-real-key';
    const requests: Record<string, unknown>[] = [];
    const reasoning = { type: 'reasoning', id: 'rs-test', summary: [], encrypted_content: 'opaque-encrypted-item', status: 'completed' };
    const args = '{"name":"report","content":"verified"}';
    const url = await mockServer((body, response, incoming) => {
      expect(incoming.url).toBe('/v1/responses');
      expect(incoming.headers.authorization).toBe('Bearer local-fixture-not-a-real-key');
      requests.push(body);
      if (requests.length === 1) {
        const item = { type: 'function_call', id: 'fc-different-from-call-id', call_id: 'call-preserved', name: 'artifact_write', arguments: args, status: 'completed' };
        stream(response, [
          { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: 'unfinished', status: 'in_progress' } },
          { type: 'response.output_item.done', output_index: 0, item: reasoning },
          { type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '', status: 'in_progress' } },
          { type: 'response.function_call_arguments.delta', output_index: 1, item_id: item.id, delta: '{"name":"report",' },
          { type: 'response.function_call_arguments.delta', output_index: 1, item_id: item.id, delta: '"content":"verified"}' },
          { type: 'response.output_item.done', output_index: 1, item },
          completion([{ ...reasoning, encrypted_content: null }, item]),
        ]);
      } else stream(response, [
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg-result', delta: 'validated' },
        completion([{ type: 'message', id: 'msg-result', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'validated', annotations: [] }] }]),
      ]);
    });
    const root = temp();
    const seen: string[] = [];
    const app = new Application(path.join(root, 'state'), new ResponsesProvider(), (_id, text) => seen.push(text));
    try {
      const run = app.createRun({ objective: 'create an artifact', workspace: root, binding: binding(url), permissions: ['read', 'write'] });
      const result = await app.run(run.id);
      expect(result.status).toBe('completed');
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ store: false, stream: true, max_output_tokens: 8192, include: ['reasoning.encrypted_content'] });
      const tools = requests[0]!.tools as { type: string; name: string; strict: boolean }[];
      expect(tools.some(tool => tool.type === 'function' && tool.name === 'artifact_write' && tool.strict === false)).toBe(true);
      expect(tools.every(tool => /^[a-zA-Z0-9_-]+$/.test(tool.name))).toBe(true);
      const secondInput = requests[1]!.input as Record<string, unknown>[];
      expect(secondInput).toContainEqual(reasoning);
      expect(secondInput).toContainEqual({ type: 'function_call', id: 'fc-different-from-call-id', call_id: 'call-preserved', name: 'artifact_write', arguments: args, status: 'completed' });
      expect(secondInput.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call-preserved' });
      expect(secondInput.some(item => item.call_id === 'fc-different-from-call-id')).toBe(false);
      expect(app.store.calls(run.id).filter(call => call.kind === 'tool')).toMatchObject([{ name: 'artifact.write', status: 'succeeded' }]);
      expect(app.store.session(run.sessionId)).toMatchObject({ tokens: 60, usageEstimated: false });
      expect(app.store.readBlob(result.resultRef!)).toMatchObject({ text: 'validated' });
      expect(seen).toEqual(['validated']);
    } finally { app.close(); }
  });

  it('replays multiple message phases and interleaved reasoning in their original order without losing item fields', async () => {
    process.env.KODO_RESPONSES_TEST_KEY = 'local-fixture';
    const output = [
      { type: 'message', id: 'msg-commentary', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'Checking.', annotations: [] }] },
      { type: 'reasoning', id: 'rs-middle', summary: [], encrypted_content: 'opaque-middle', status: 'completed' },
      { type: 'message', id: 'msg-second', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'Reading.', annotations: [{ type: 'file_citation', file_id: 'file-local', filename: 'README.md', index: 0 }] }] },
      { type: 'function_call', id: 'fc-original', call_id: 'call-original', name: 'file_read', arguments: '{"path":"README.md"}', status: 'completed' },
    ];
    const requests: Record<string, unknown>[] = [];
    const url = await mockServer((body, response) => {
      requests.push(body);
      stream(response, [completion(requests.length === 1 ? output : [{ type: 'message', id: 'msg-final', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] }])]);
    });
    const provider = new ResponsesProvider();
    const first = await provider.complete(request(url), new AbortController().signal, () => {});
    expect(first.message.content).toBe('Checking.Reading.');
    expect(first.message.tool_calls).toEqual([{ id: 'call-original', name: 'file_read', arguments: '{"path":"README.md"}' }]);
    expect(first.message.providerData).toEqual({ protocol: 'responses', output });
    const persisted = JSON.parse(JSON.stringify(first.message)) as typeof first.message;
    const second = await provider.complete({ ...request(url), messages: [
      { role: 'user', content: 'test' }, persisted, { role: 'tool', tool_call_id: 'call-original', content: 'read result' },
    ] }, new AbortController().signal, () => {});
    expect(requests[1]!.input).toEqual([{ role: 'user', content: 'test' }, ...output, { type: 'function_call_output', call_id: 'call-original', output: 'read result' }]);
    expect(second.message.providerData).toMatchObject({ protocol: 'responses', output: [{ id: 'msg-final', phase: 'final_answer' }] });
  });

  it('rejects foreign protocol reasoning rather than silently dropping signed history', async () => {
    process.env.KODO_RESPONSES_TEST_KEY = 'local-fixture';
    await expect(new ResponsesProvider().complete({ ...request('http://127.0.0.1:1/v1'), messages: [
      { role: 'user', content: 'test' },
      { role: 'assistant', content: 'visible', providerData: { protocol: 'anthropic', blocks: [{ type: 'thinking', thinking: 'private', signature: 'opaque' }] } },
    ] }, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_PROTOCOL', message: 'assistant history belongs to another provider protocol' });
  });

  it.each(['missing', 'incomplete', 'failed', 'error', 'wrong-status', 'unfinished-item'])('executes no tool when the stream ends as %s', async failure => {
    process.env.KODO_RESPONSES_TEST_KEY = 'local-fixture';
    const url = await mockServer((_body, response) => {
      const item = toolItem();
      const terminal = failure === 'missing' ? [] : failure === 'wrong-status' ? [completion([item], 'incomplete')]
        : failure === 'unfinished-item' ? [completion([{ ...item, status: 'in_progress' }])]
          : failure === 'error' ? [{ type: 'error', code: 'upstream_error', message: 'never-retain-private-detail' }]
            : [{ type: `response.${failure}`, response: { status: failure, output: [item], error: { message: 'never-retain-private-detail' } } }];
      stream(response, [{ type: 'response.output_item.done', output_index: 0, item }, ...terminal]);
    });
    const root = temp();
    const app = new Application(path.join(root, 'state'), new ResponsesProvider());
    try {
      const run = app.createRun({ objective: 'do not execute partial tools', workspace: root, binding: binding(url), permissions: ['read', 'write'], budget: { maxTokens: 200_000 } });
      const result = await app.run(run.id);
      expect(result.status).toBe('failed');
      expect(result.error).toContain(failure === 'error' ? 'MODEL_TRANSPORT' : 'MODEL_INCOMPLETE');
      expect(result.error).not.toContain('never-retain-private-detail');
      expect(existsSync(path.join(root, 'should-not-exist.txt'))).toBe(false);
      expect(app.store.calls(run.id).filter(call => call.kind === 'tool')).toHaveLength(0);
    } finally { app.close(); }
  });

  it.each([401, 403, 429, 400, 502])('sanitizes HTTP %i and leaves retries to the runtime', async status => {
    process.env.KODO_RESPONSES_TEST_KEY = 'fixture-secret-never-print';
    let attempts = 0;
    const url = await mockServer((_body, response) => {
      attempts++;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture-secret-never-print private prompt', type: 'invalid_request_error' } }));
    });
    const code = status === 401 || status === 403 ? 'MODEL_AUTH' : status === 429 ? 'MODEL_RATE_LIMIT' : status === 400 ? 'MODEL_REQUEST' : 'MODEL_TRANSPORT';
    await expect(new ResponsesProvider().complete(request(url), new AbortController().signal, () => {})).rejects.toMatchObject({ code, message: `provider request failed (HTTP ${status})` });
    expect(attempts).toBe(1);
  });

  it('cancels an open stream without executing an already streamed tool', async () => {
    process.env.KODO_RESPONSES_TEST_KEY = 'local-fixture';
    let notify: (() => void) | undefined;
    const started = new Promise<void>(resolve => { notify = resolve; });
    const url = await mockServer((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = { type: 'response.output_item.done', output_index: 0, item: toolItem() };
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      notify!();
    });
    const root = temp();
    const app = new Application(path.join(root, 'state'), new ResponsesProvider());
    try {
      const run = app.createRun({ objective: 'cancel test', workspace: root, binding: binding(url), permissions: ['read', 'write'] });
      const pending = app.run(run.id);
      await started;
      app.coordinator.cancel(run.id);
      expect((await pending).status).toBe('cancelled');
      expect(app.store.calls(run.id).filter(call => call.kind === 'tool')).toHaveLength(0);
      expect(existsSync(path.join(root, 'should-not-exist.txt'))).toBe(false);
    } finally { app.close(); }
  });

  it.each(['duplicate-id', 'invalid-usage', 'unsupported-item'])('rejects malformed completed output: %s', async kind => {
    process.env.KODO_RESPONSES_TEST_KEY = 'local-fixture';
    const url = await mockServer((_body, response) => {
      const event = completion(kind === 'unsupported-item' ? [{ type: 'web_search_call', id: 'native-tool', status: 'completed' }] : [toolItem(), ...(kind === 'duplicate-id' ? [toolItem()] : [])]);
      if (kind === 'invalid-usage') event.response.usage.input_tokens = -1;
      stream(response, [event]);
    });
    await expect(new ResponsesProvider().complete(request(url), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
  });

  it('accounts transient retries against the runtime model-call budget', async () => {
    process.env.KODO_RESPONSES_TEST_KEY = 'local-fixture';
    let attempts = 0;
    const url = await mockServer((_body, response) => {
      attempts++;
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'temporary upstream failure' } }));
    });
    const root = temp();
    const app = new Application(path.join(root, 'state'), new ResponsesProvider());
    try {
      const run = app.createRun({ objective: 'retry budget', workspace: root, binding: binding(url), budget: { maxModelCalls: 1 } });
      expect((await app.run(run.id)).error).toContain('MODEL_BUDGET');
      expect(attempts).toBe(1);
      expect(app.store.session(run.sessionId).modelCalls).toBe(1);
    } finally { app.close(); }
  });
});
