import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { ChatCompletionsProvider } from '../src/providers/openai.js';
import { ResponsesProvider } from '../src/providers/responses.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { Message, ModelProtocol, Provider } from '../src/runtime/types.js';
import { delta, mockServer, sendStream } from './http-server.js';

const image = { mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' };
const protocols: [ModelProtocol, () => Provider][] = [
  ['chat-completions', () => new ChatCompletionsProvider()], ['responses', () => new ResponsesProvider()], ['anthropic', () => new AnthropicProvider()],
];
afterEach(() => { delete process.env.KODO_IMAGE_TEST_KEY; });
const request = (baseURL: string, protocol: ModelProtocol, messages: Message[]): Parameters<Provider['complete']>[0] => ({
  binding: { baseURL, model: 'vision-fixture', apiKeyEnv: 'KODO_IMAGE_TEST_KEY', protocol }, messages, tools: [], maxOutputTokens: 20,
});
function reply(protocol: ModelProtocol, response: ServerResponse): void {
  if (protocol === 'chat-completions') { sendStream(response, [delta({ content: 'seen' }, 'stop')]); return; }
  const events = protocol === 'responses' ? [{ type: 'response.completed', response: { id: 'vision', status: 'completed', output: [{ type: 'message', id: 'out', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'seen', annotations: [] }] }] } }] : [
    { type: 'message_start', message: { id: 'vision', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'seen' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

describe.each(protocols)('%s vision wire input', (protocol, factory) => {
  it('sends actual validated bytes with text and preserves tool result identity', async () => {
    process.env.KODO_IMAGE_TEST_KEY = 'local-fixture';
    let captured: Record<string, unknown> | undefined;
    const url = await mockServer((body, response) => { captured = body; reply(protocol, response); });
    const messages: Message[] = [
      { role: 'user', content: 'inspect this', images: [image] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'image-call', name: 'image.read', arguments: '{"path":"pixel.png"}' }, { id: 'second-call', name: 'file.read', arguments: '{"path":"a.txt"}' }] },
      { role: 'tool', content: '{"width":1,"height":1}', tool_call_id: 'image-call', images: [image] },
      { role: 'tool', content: 'second result', tool_call_id: 'second-call' },
    ];
    const result = await factory().complete(request(url, protocol, messages), new AbortController().signal, () => {});
    expect(result.message.content).toBe('seen');
    const dataURL = `data:${image.mimeType};base64,${image.data}`;
    if (protocol === 'chat-completions') {
      const wire = captured!.messages as Record<string, unknown>[];
      expect(wire[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'inspect this' }, { type: 'image_url', image_url: { url: dataURL } }] });
      expect(wire.slice(2)).toEqual([
        { role: 'tool', content: '{"width":1,"height":1}', tool_call_id: 'image-call' },
        { role: 'tool', content: 'second result', tool_call_id: 'second-call' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: dataURL } }] },
      ]);
    } else if (protocol === 'responses') {
      const wire = captured!.input as Record<string, unknown>[];
      expect(wire[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'inspect this' }, { type: 'input_image', detail: 'auto', image_url: dataURL }] });
      expect(wire).toContainEqual({ type: 'function_call_output', call_id: 'image-call', output: '{"width":1,"height":1}' });
      expect(wire).toContainEqual({ role: 'user', content: [{ type: 'input_image', detail: 'auto', image_url: dataURL }] });
    } else {
      const wire = captured!.messages as { role: string; content: Record<string, unknown>[] }[];
      const block = { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } };
      expect(wire[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'inspect this' }, block] });
      expect(wire[2]!.content).toEqual([
        { type: 'tool_result', tool_use_id: 'image-call', content: [{ type: 'text', text: '{"width":1,"height":1}' }, block] },
        { type: 'tool_result', tool_use_id: 'second-call', content: 'second result' },
      ]);
    }
    expect(JSON.stringify(captured)).not.toContain('"images"');
  });

  it('rejects bad MIME, corrupt bytes, noncanonical base64 and excessive attachments before network IO', async () => {
    process.env.KODO_IMAGE_TEST_KEY = 'local-fixture';
    for (const images of [[{ ...image, mimeType: 'image/jpeg' as const }], [{ ...image, data: 'bm90IGFuIGltYWdl' }], [{ ...image, data: `${image.data}\n` }], Array.from({ length: 9 }, () => image)]) {
      await expect(factory().complete(request('http://127.0.0.1:1/v1', protocol, [{ role: 'user', content: 'bad', images }]), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    }
  });
});
