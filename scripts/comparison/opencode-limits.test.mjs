import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runOpenCode } from './opencode.mjs';

test('native OpenCode actually sends the model maximum instead of its default 32000 output cap', async () => {
  let received;
  const upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"id":"fixture","object":"chat.completion.chunk","model":"fixture","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-native-max-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  try {
    const result = await runOpenCode({ workspace, directory, objective: 'Reply done without calling tools.', baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'fixture', maxModelCalls: Number.MAX_SAFE_INTEGER, timeoutMs: 20000, maxOutputTokens: 393216, contextWindowTokens: 1000000, unrestricted: true, singleAgent: true });
    assert.equal(result.status, 'completed', `${JSON.stringify(result.error)} ${await readFile(path.join(directory, 'native-stderr.log'), 'utf8')}`);
    assert.equal(received.max_tokens ?? received.max_completion_tokens, 393216);
    const config = JSON.parse(await readFile(path.join(directory, 'native-config.json'), 'utf8'));
    assert.equal(config.provider.codego.models.fixture.limit.context, 1000000);
    assert.equal(config.provider.codego.options.timeout, false);
    assert.equal(config.provider.codego.options.headerTimeout, false);
    assert.equal(config.provider.codego.options.chunkTimeout, false);
  } finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
