import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { createBudgetRelay } from './relay.mjs';

const request = { model: 'fixture', stream: true, messages: [{ role: 'user', content: 'check' }], tools: [], max_tokens: 16 };
const reserve = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools })) + 16;
async function fixture(handler, budget = reserve + 1, options = {}) {
  const upstream = createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const directory = await mkdtemp(path.join(tmpdir(), 'kodo-relay-'));
  const relay = await createBudgetRelay({ directory, upstream: `http://127.0.0.1:${upstream.address().port}/v1`, key: 'fixture-private-key', model: 'fixture', maxTokens: budget, ...options });
  return { relay, directory,
    send: (body = request) => globalThis.fetch(`${relay.baseURL}/chat/completions`, { method: 'POST', body: JSON.stringify(body), signal: globalThis.AbortSignal.timeout(5000) }),
    async close() { await relay.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(directory, { recursive: true, force: true }); },
  };
}

test('429 releases the shared reservation and preserves quota classification and retry headers', async () => {
  let calls = 0;
  const f = await fixture((_request, response) => {
    if (++calls === 1) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2', 'retry-after-ms': '125' });
      response.end(JSON.stringify({ error: { type: 'insufficient_quota', message: 'fixture-private-key' } }));
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
    }
  });
  try {
    const first = await f.send();
    assert.equal(first.status, 429);
    assert.equal(first.headers.get('retry-after'), '2');
    assert.equal(first.headers.get('retry-after-ms'), '125');
    assert.deepEqual(await first.json(), { error: { type: 'insufficient_quota', message: '[redacted]' } });
    const second = await f.send();
    assert.equal(second.status, 200);
    await second.text();
    await f.relay.close();
    assert.equal(f.relay.stats.requests, 2);
    assert.equal(f.relay.stats.tokens, 7);
    assert.equal(f.relay.stats.estimated, false);
    assert.equal(f.relay.stats.calls[0].usageKnownZero, true);
    assert.deepEqual(f.relay.stats.rejected, []);
    assert.ok(!(await readFile(path.join(f.directory, 'response-1.sse'), 'utf8')).includes('fixture-private-key'));
  } finally { await f.close(); }
});

test('complex-task output allowance is actually forwarded, with the legacy default unchanged', async () => {
  for (const [options, expected] of [[{ maxOutputTokens: 8192 }, 8192], [{}, 3072]]) {
    let body = '';
    const f = await fixture(async (request, response) => {
      for await (const chunk of request) body += chunk;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
    }, 20000, options);
    try {
      const response = await f.send({ ...request, max_tokens: 12000 });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(JSON.parse(body).max_tokens, expected);
      assert.equal(f.relay.stats.calls[0].outputLimit, expected);
    } finally { await f.close(); }
  }
});

test('model-maximum mode forwards the real output ceiling and accepts large requests/streams without artificial call/token caps', async () => {
  let forwarded;
  const f = await fixture(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    forwarded = JSON.parse(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`: ${'x'.repeat(2000001)}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n`);
  }, 1, { unrestricted: true, maxCalls: 1, maxOutputTokens: 393216, maxContextChars: Number.MAX_SAFE_INTEGER });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.send({ ...request, max_tokens: 393216, messages: [{ role: 'user', content: 'x'.repeat(2000001) }] });
      assert.equal(response.status, 200);
      assert.ok((await response.text()).length > 2000000);
    }
    assert.equal(forwarded.max_tokens, 393216);
    assert.equal(f.relay.stats.requests, 2);
    assert.deepEqual(f.relay.stats.rejected, []);
  } finally { await f.close(); }
});

test('non-429 failures keep unknown usage and the shared token budget still rejects excess work', async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
    response.end('{"error":{"type":"overloaded_error"}}');
  });
  try {
    const first = await f.send();
    assert.equal(first.status, 503);
    assert.equal((await first.json()).error.type, 'overloaded_error');
    const second = await f.send();
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.message, 'TOKEN_BUDGET');
    assert.equal(f.relay.stats.requests, 1);
    assert.equal(f.relay.stats.tokens, reserve);
    assert.equal(f.relay.stats.estimated, true);
  } finally { await f.close(); }
});

test('unbounded provider error bodies are rejected and 429 still remains known zero', async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end('x'.repeat(64001));
  });
  try {
    const response = await f.send();
    assert.equal(response.status, 502);
    await response.text();
    assert.equal(f.relay.stats.tokens, 0);
    assert.equal(f.relay.stats.requests, 1);
    assert.equal(f.relay.stats.estimated, false);
  } finally { await f.close(); }
});
