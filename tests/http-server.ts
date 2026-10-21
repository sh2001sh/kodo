import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach } from 'vitest';

export async function mockServer(handler: (body: Record<string, unknown>, response: ServerResponse, request: IncomingMessage) => void | Promise<void>): Promise<string> {
  const server = createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += String(chunk);
    try { await handler(JSON.parse(data || '{}') as Record<string, unknown>, response, request); }
    catch (error) { response.destroy(error as Error); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return `http://127.0.0.1:${address.port}/v1`;
}
export function sendStream(response: ServerResponse, parts: Record<string, unknown>[], done = true): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const part of parts) response.write(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', ...part })}\n\n`);
  response.end(done ? 'data: [DONE]\n\n' : '');
}
export const delta = (content: Record<string, unknown>, finish_reason: string | null = null): Record<string, unknown> => ({ choices: [{ index: 0, delta: content, finish_reason }] });
