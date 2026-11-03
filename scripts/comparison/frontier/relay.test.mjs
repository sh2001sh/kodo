import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createLocalRelay } from './launch.mjs';
import OpenAI from 'openai';

const key = 'fixture-private-key-0123456789';
const script = path.join(import.meta.dirname, 'relay.mjs');
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const thought = 'thinking about it '.repeat(4);
const body = { model: 'fixture', stream: true, messages: [{ role: 'user', content: 'go' }], max_tokens: 64 };

test('credit admission stops before another upstream call, including when billing is unknown', async () => {
  for (const credit of [2, undefined]) {
    let forwarded = 0;
    const f = await fixture((_request, response) => {
      forwarded++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(event({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: credit === undefined ? {} : { credit } }) + 'data: [DONE]\n\n');
    }, { maxCredit: 3, creditReserve: 1 });
    try {
      await (await f.send()).text();
      await settled(f);
      const rejected = await f.send();
      assert.equal(rejected.status, 402);
      assert.match(await rejected.text(), credit === undefined ? /UNKNOWN_CREDIT/u : /CREDIT_BUDGET/u);
      assert.equal(forwarded, 1);
    } finally { await f.close(); }
  }
});

async function fixture(handler, config = {}, splitConfig = false) {
  const upstream = createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const directory = await mkdtemp(path.join(tmpdir(), 'fh-relay-'));
  const child = spawn(process.execPath, [script], { env: { ...process.env, FH_EVIDENCE_DIR: directory, FH_RELAY_PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const input = Buffer.from(JSON.stringify({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, key, model: 'fixture', outputTokens: 32, contextTokens: 1024, ...config }));
  const started = splitConfig ? (async () => { for (const byte of input) { child.stdin.write(Buffer.from([byte])); await delay(1); } child.stdin.end(); })() : Promise.resolve(child.stdin.end(input));
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { const match = /relay ready (\d+)/u.exec(String(chunk)); if (match) resolve(Number(match[1])); });
    child.once('exit', code => reject(new Error(`relay exited ${code}`)));
  });
  await started;
  const calls = async () => JSON.parse(await readFile(path.join(directory, 'calls.json'), 'utf8'));
  return {
    directory, child, calls, port,
    send: (options = {}) => globalThis.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ ...body, model: config.model ?? body.model }), ...options }),
    async close() {
      if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function settled(f) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [call] = await f.calls();
    if (call && call.status !== 'running') return call;
    await delay(20);
  }
  assert.fail('relay call did not settle');
}

test('writes the stream while it arrives and records phase timings and usage', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event({ model: 'fixture', choices: [{ delta: { reasoning_content: thought } }] }));
    await gate;
    response.write(event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{"command":"ls"}' } }] } }] }));
    response.end(event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } }) + 'data: [DONE]\n\n');
  });
  try {
    const pending = f.send();
    const response = await pending;
    const reader = response.body.getReader();
    await reader.read();
    const file = path.join(f.directory, 'response-1.txt');
    for (let attempt = 0; attempt < 50 && !(existsSync(file) && (await readFile(file, 'utf8')).includes('thinking')); attempt++) await delay(20);
    // The last key-length characters are held back for split-credential redaction.
    assert.match(await readFile(file, 'utf8'), /thinking about it/u, 'partial stream is on disk before the response ends');
    assert.equal((await f.calls())[0].status, 'running');
    release();
    while (!(await reader.read()).done) { /* drain */ }
    for (let attempt = 0; attempt < 50 && (await f.calls())[0].status === 'running'; attempt++) await delay(20);
    const [call] = await f.calls();
    assert.equal(call.status, 'completed');
    assert.deepEqual(call.usage, { prompt_tokens: 5, completion_tokens: 7 });
    assert.deepEqual(call.finishReasons, ['tool_calls']);
    assert.equal(call.timing.reasoningChars, thought.length);
    assert.equal(call.timing.toolArgChars, 'bash'.length + '{"command":"ls"}'.length);
    assert.ok(call.timing.firstReasoningMs <= call.timing.firstToolMs && call.timing.firstToolMs <= call.timing.streamEndMs);
    assert.ok(call.timing.samples.length >= 1);
    assert.equal(JSON.parse(await readFile(path.join(f.directory, 'request-1.json'), 'utf8')).max_tokens, 32, 'output cap is applied');
    assert.equal(JSON.parse(await readFile(path.join(f.directory, 'request-incoming-1.json'), 'utf8')).max_tokens, 64, 'incoming request is separately preserved');
  } finally { await f.close(); }
});

test('preserves split UTF-8 in stdin, incoming requests, forwarded bodies and saved streams', async () => {
  const unicode = '中文→😀';
  const model = `fixture-${unicode}`;
  let received;
  const f = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const output = Buffer.from(event({ choices: [{ delta: { content: unicode.repeat(9) }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    for (const byte of output) { response.write(Buffer.from([byte])); await delay(1); }
    response.end();
  }, { model }, true);
  try {
    const input = Buffer.from(JSON.stringify({ ...body, model, messages: [{ role: 'user', content: unicode }] }));
    const response = new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST' }, incoming => {
        incoming.resume(); incoming.once('end', resolve); incoming.once('error', reject);
      });
      request.on('error', reject);
      void (async () => { for (const byte of input) { request.write(Buffer.from([byte])); await delay(1); } request.end(); })().catch(reject);
    });
    await response;
    await settled(f);
    assert.equal(received.messages[0].content, unicode);
    assert.equal(received.model, model);
    for (const file of ['request-incoming-1.json', 'request-1.json']) {
      assert.equal(JSON.parse(await readFile(path.join(f.directory, file), 'utf8')).messages[0].content, unicode);
    }
    assert.match(await readFile(path.join(f.directory, 'response-1.txt'), 'utf8'), new RegExp(unicode.repeat(9), 'u'));
  } finally { await f.close(); }
});

test('propagates client cancellation through the local hop and closes the upstream', async () => {
  let upstreamClosed = false;
  const f = await fixture((_request, response) => {
    response.once('close', () => { upstreamClosed = true; });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event({ choices: [{ delta: { content: 'partial response' } }] }));
  });
  const local = createLocalRelay({ hostname: '127.0.0.1', port: f.port });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  try {
    const controller = new globalThis.AbortController();
    const response = await globalThis.fetch(`http://127.0.0.1:${local.address().port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
    await response.body.getReader().read();
    controller.abort();
    const call = await settled(f);
    for (let attempt = 0; attempt < 50 && !upstreamClosed; attempt++) await delay(20);
    assert.equal(upstreamClosed, true);
    assert.equal(call.status, 'cancelled');
    assert.equal(call.abortReason, 'CLIENT_DISCONNECTED');
    assert.equal(call.clientDisconnected, true);
    assert.ok(call.upstreamEndedMs >= call.abortRequestedMs);
    assert.equal(call.usage, null, 'cancelled requests with no usage remain unknown');
    assert.equal(call.protocol.status, 'unknown');
    assert.equal(call.protocol.doneSeen, false);
    assert.equal(call.connectionClose, undefined);
    assert.match(await readFile(path.join(f.directory, 'response-1.txt'), 'utf8'), /partial response/u);
  } finally {
    local.closeAllConnections(); await new Promise(resolve => local.close(resolve)); await f.close();
  }
});

test('a real SDK completes at DONE through both relays while upstream cleanup stays separately observable', async () => {
  let upstreamClosed = false;
  const f = await fixture((_request, response) => {
    response.once('close', () => { upstreamClosed = true; });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: null }] }));
    response.write(event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }) + 'data: [DONE]\n\n');
    // HTTP stays open after its application-level terminal marker.
  });
  const local = createLocalRelay({ hostname: '127.0.0.1', port: f.port });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  try {
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${local.address().port}/v1`, apiKey: 'fixture-stub', maxRetries: 0, timeout: 2000 });
    const stream = await client.chat.completions.create({ model: 'fixture', messages: body.messages, stream: true });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 3, completion_tokens: 4 });
    const call = await settled(f);
    for (let attempt = 0; attempt < 50 && !upstreamClosed; attempt++) await delay(20);
    assert.equal(upstreamClosed, true);
    assert.equal(call.status, 'cancelled', 'raw transport status is not overwritten');
    assert.equal(call.protocol.status, 'completed');
    assert.equal(call.protocol.doneSeen, true);
    assert.ok(call.protocol.doneMs <= call.clientDisconnectedMs);
    assert.equal(call.connectionClose, 'after_protocol_terminal');
    assert.equal(call.usage.credit, undefined, 'protocol success does not invent missing credit');
  } finally {
    local.closeAllConnections(); await new Promise(resolve => local.close(resolve)); await f.close();
  }
});

for (const finish of [undefined, 'length']) {
  test(`DONE with ${finish ?? 'no'} finish reason is not a normal completion`, async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(event({ choices: [{ index: 0, delta: { content: 'partial' }, ...(finish ? { finish_reason: finish } : {}) }] }) + 'data: [DONE]\n\n');
    });
    try {
      await (await f.send()).text();
      const call = await settled(f);
      assert.equal(call.status, 'completed', 'HTTP transport completed');
      assert.equal(call.protocol.status, 'incomplete');
      assert.equal(call.usage, null);
    } finally { await f.close(); }
  });
}

test('literal DONE in content is retained and a split terminal marker is recognized exactly', async () => {
  const content = 'The literal [DONE] is ordinary text.';
  const f = await fixture(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] }));
    response.write('data: [DO'); await delay(10); response.end('NE]\n\n');
  });
  try {
    await (await f.send()).text();
    const call = await settled(f);
    assert.equal(call.timing.contentChars, content.length);
    assert.deepEqual(call.finishReasons, ['stop']);
    assert.equal(call.protocol.status, 'completed');
    assert.equal(call.protocol.doneSeen, true);
  } finally { await f.close(); }
});

test('literal DONE content alone does not establish a protocol terminal', async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(event({ choices: [{ index: 0, delta: { content: '[DONE]' } }] }));
  });
  try {
    await (await f.send()).text();
    const call = await settled(f);
    assert.equal(call.timing.contentChars, 6);
    assert.equal(call.protocol.doneSeen, false);
    assert.equal(call.protocol.status, 'unknown');
  } finally { await f.close(); }
});

test('times out an upstream that never sends its first byte', async () => {
  const f = await fixture(() => {}, { firstByteTimeoutMs: 80 });
  try {
    const response = await f.send();
    assert.equal(response.status, 502); await response.text();
    const call = await settled(f);
    assert.equal(call.status, 'failed');
    assert.equal(call.abortReason, 'FIRST_BYTE_TIMEOUT');
    assert.equal(call.usage, null);
  } finally { await f.close(); }
});

test('times out a stalled stream while preserving received content', async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event({ choices: [{ delta: { content: 'stalled' } }] }));
  }, { streamIdleTimeoutMs: 80 });
  try {
    await (await f.send()).text();
    const call = await settled(f);
    assert.equal(call.status, 'failed');
    assert.equal(call.abortReason, 'STREAM_IDLE_TIMEOUT');
    assert.match(await readFile(path.join(f.directory, 'response-1.txt'), 'utf8'), /stalled/u);
  } finally { await f.close(); }
});

test('keeps a long active stream alive beyond its first-byte and idle deadlines', async () => {
  const f = await fixture(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let index = 0; index < 12; index++) {
      response.write(event({ choices: [{ delta: { reasoning_content: 'working' } }] }));
      await delay(30);
    }
    response.end(event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  }, { firstByteTimeoutMs: 120, streamIdleTimeoutMs: 120 });
  try {
    await (await f.send()).text();
    const call = await settled(f);
    assert.equal(call.status, 'completed');
    assert.ok(call.elapsedMs > 240);
    assert.equal(call.abortReason, undefined);
  } finally { await f.close(); }
});

test('redacts a credential split across chunks', async () => {
  const f = await fixture(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = event({ choices: [{ delta: { content: `leak ${key} end` } }] });
    const cut = text.indexOf(key) + 7;
    response.write(text.slice(0, cut));
    await delay(30);
    response.end(text.slice(cut) + 'data: [DONE]\n\n');
  });
  try {
    await (await f.send()).text();
    for (let attempt = 0; attempt < 50 && (await f.calls())[0].status === 'running'; attempt++) await delay(20);
    const saved = await readFile(path.join(f.directory, 'response-1.txt'), 'utf8');
    assert.ok(!saved.includes(key));
    assert.match(saved, /leak \[REDACTED\] end/u);
  } finally { await f.close(); }
});

test('keeps a partial stream when the upstream drops the connection', async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event({ choices: [{ delta: { reasoning_content: 'half' } }] }));
    setTimeout(() => response.socket.destroy(), 30);
  });
  try {
    await (await f.send()).text().catch(() => '');
    for (let attempt = 0; attempt < 50 && (await f.calls())[0].status === 'running'; attempt++) await delay(20);
    const [call] = await f.calls();
    assert.equal(call.status, 'failed');
    assert.equal(call.timing.reasoningChars, 4);
    assert.ok(call.timing.streamEndMs !== null);
    assert.match(await readFile(path.join(f.directory, 'response-1.txt'), 'utf8'), /half/u);
  } finally { await f.close(); }
});

test('settles open calls on SIGTERM so partial streams survive docker stop', { skip: process.platform === 'win32' && 'SIGTERM cannot be delivered to a child on Windows' }, async () => {
  const f = await fixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event({ choices: [{ delta: { reasoning_content: 'still going' } }] }));
  });
  try {
    const response = await f.send();
    await response.body.getReader().read();
    f.child.kill('SIGTERM');
    await once(f.child, 'exit');
    const [call] = await f.calls();
    assert.equal(call.status, 'interrupted');
    assert.equal(call.timing.reasoningChars, 'still going'.length);
    assert.match(await readFile(path.join(f.directory, 'response-1.txt'), 'utf8'), /still going/u);
  } finally { await f.close(); }
});
