import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { ChatCompletionsProvider } from '../src/providers/openai.js';
import { ResponsesProvider } from '../src/providers/responses.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { KodoError } from '../src/runtime/types.js';
import type { Provider } from '../src/runtime/types.js';
import { failureSettlement } from '../src/runtime/usage.js';
import { delta, mockServer, sendStream } from './http-server.js';
import { answer, fixture } from './helpers.js';

afterEach(() => { delete process.env.KODO_METER_TEST_KEY; });
const binding = (baseURL: string, protocol?: 'responses' | 'anthropic') => ({ limits: { context: 256_000, output: 8192 }, baseURL, model: 'test-model', apiKeyEnv: 'KODO_METER_TEST_KEY', ...(protocol ? { protocol } : {}) });
const request = (baseURL: string, protocol?: 'responses' | 'anthropic'): Parameters<Provider['complete']>[0] => ({ binding: binding(baseURL, protocol), messages: [{ role: 'user', content: 'test' }], tools: [], maxOutputTokens: 20 });
function events(response: ServerResponse, list: Record<string, unknown>[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(list.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

describe('output-limit stops keep provider usage', () => {
  it('chat completions attaches usage reported after finish_reason length', async () => {
    process.env.KODO_METER_TEST_KEY = 'local-fixture';
    const url = await mockServer((_body, response) => sendStream(response, [
      delta({ content: 'partial' }), delta({}, 'length'),
      { choices: [], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50, prompt_tokens_details: { cached_tokens: 10 } } },
    ]));
    await expect(new ChatCompletionsProvider().complete(request(url), new AbortController().signal, () => {}))
      .rejects.toMatchObject({ code: 'MODEL_INCOMPLETE', metadata: { outputLimit: true, usage: { input: 30, output: 20, cacheRead: 10 } } });
  });

  it('responses attaches usage from response.incomplete', async () => {
    process.env.KODO_METER_TEST_KEY = 'local-fixture';
    const url = await mockServer((_body, response) => events(response, [{ type: 'response.incomplete', response: {
      id: 'resp-test', status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 },
    } }]));
    await expect(new ResponsesProvider().complete(request(url, 'responses'), new AbortController().signal, () => {}))
      .rejects.toMatchObject({ code: 'MODEL_INCOMPLETE', metadata: { outputLimit: true, usage: { input: 40, output: 20 } } });
  });

  it('anthropic attaches usage on a max_tokens stop', async () => {
    process.env.KODO_METER_TEST_KEY = 'local-fixture';
    const url = await mockServer((_body, response) => events(response, [
      { type: 'message_start', message: { id: 'msg-fixture', role: 'assistant', content: [], usage: { input_tokens: 25, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 20 } }, { type: 'message_stop' },
    ]));
    await expect(new AnthropicProvider().complete(request(url, 'anthropic'), new AbortController().signal, () => {}))
      .rejects.toMatchObject({ code: 'MODEL_INCOMPLETE', metadata: { outputLimit: true, usage: { input: 25, output: 20 } } });
  });
});

describe('failed attempt settlement', () => {
  const budget = { cacheReadCostPercent: 100 };

  it('distinguishes measured, known-zero and unknown usage', () => {
    const usage = { input: 30, output: 20 };
    expect(failureSettlement(new KodoError('MODEL_INCOMPLETE', 'x', { usage, usageKnownZero: true }), 500, budget)).toMatchObject({ settledTokens: 50, estimated: false, usage });
    expect(failureSettlement(new KodoError('MODEL_RATE_LIMIT', 'x', { usageKnownZero: true }), 500, budget)).toMatchObject({ settledTokens: 0, estimated: false, usage: 'known-zero' });
    expect(failureSettlement(new Error('aborted'), 500, budget)).toMatchObject({ settledTokens: 500, estimated: true });
  });

  it('charges the measured usage of a truncated attempt instead of its reservation', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      if (++attempts === 1) throw new KodoError('MODEL_INCOMPLETE', 'response stopped at the output token limit', { outputLimit: true, usage: { input: 30, output: 20 } });
      return answer('recovered');
    } });
    const run = await app.run(runId);
    expect(run.status, run.error).toBe('completed');
    const session = app.store.session(run.sessionId);
    expect(session.usageEstimated).toBeFalsy();
    // 50 for the truncated attempt plus 80 for the answer.
    expect(session.tokens).toBe(130);
    expect(app.store.events(runId).find(event => event.type === 'model.failed')?.data).toMatchObject({ usage: { input: 30, output: 20 }, chargedTokens: 50 });
  });

  it('keeps the reservation and marks the total estimated when usage is unknown', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      if (++attempts === 1) throw new KodoError('MODEL_TRANSPORT', 'connection reset');
      return answer('recovered');
    } });
    const run = await app.run(runId);
    expect(run.status, run.error).toBe('completed');
    const session = app.store.session(run.sessionId);
    expect(session.usageEstimated).toBe(true);
    const failed = app.store.events(runId).find(event => event.type === 'model.failed')!;
    expect(session.tokens).toBe(80 + Number(failed.data.reservedTokens));
  });
});
