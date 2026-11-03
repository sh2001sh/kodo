// Runs in a parent-owned relay container. Credentials arrive only over stdin.
// Responses are written to disk while they stream, with phase timings, so partial and failed streams stay inspectable.
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';

const evidence = process.env.FH_EVIDENCE_DIR ?? '/evidence';
const port = Number(process.env.FH_RELAY_PORT ?? 4010);
const { upstream, key, model, outputTokens, contextTokens, maxCredit, creditReserve = 1, maxRequests, firstByteTimeoutMs = 120_000, streamIdleTimeoutMs = 120_000 } = await (async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
})();
if (typeof key !== 'string' || !key) throw new Error('relay requires a credential');
if (maxCredit !== undefined && (!Number.isFinite(maxCredit) || maxCredit <= 0 || !Number.isFinite(creditReserve) || creditReserve < 0 || creditReserve >= maxCredit)) throw new Error('invalid credit admission budget');
if (maxRequests !== undefined && (!Number.isSafeInteger(maxRequests) || maxRequests < 1)) throw new Error('invalid request budget');
if (![firstByteTimeoutMs, streamIdleTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('relay timeouts must be positive integers');
const redact = text => text.replaceAll(key, '[REDACTED]');
await mkdir(evidence, { recursive: true });
const calls = [];
const open = new Set();
const operations = new Set();
let saving = Promise.resolve();
// Serialized so overlapping requests never interleave writes to calls.json.
const save = () => (saving = saving.then(async () => {
  await writeFile(path.join(evidence, 'calls.json.tmp'), JSON.stringify(calls, null, 2));
  await rename(path.join(evidence, 'calls.json.tmp'), path.join(evidence, 'calls.json'));
})
  .catch(error => { process.stderr.write(`calls.json write failed: ${error.message}\n`); }));

/** Appends redacted text, holding back a key-length tail so a credential split across chunks is still caught. */
function redactingFile(file) {
  const stream = createWriteStream(file);
  const keep = key.length - 1;
  let pending = '';
  let failure;
  stream.on('error', error => { failure = error; });
  return {
    write(text) {
      if (failure) throw failure;
      pending = redact(pending + text);
      let end = Math.max(0, pending.length - keep);
      if (end && /[\uD800-\uDBFF]/u.test(pending[end - 1])) end--;
      if (end) { stream.write(pending.slice(0, end)); pending = pending.slice(end); }
    },
    close() {
      if (failure) return Promise.reject(failure);
      stream.write(redact(pending)); pending = '';
      return new Promise((resolve, reject) => { stream.once('error', reject); stream.end(resolve); });
    },
  };
}

/** Records when reasoning, text and tool arguments arrive, relative to the request start, sampled about once a second. */
function streamTimer(startedMs) {
  const timing = { headersMs: null, firstChunkMs: null, firstReasoningMs: null, lastReasoningMs: null, firstContentMs: null, lastContentMs: null, firstToolMs: null, lastToolMs: null, streamEndMs: null, chunks: 0, reasoningChars: 0, contentChars: 0, toolArgChars: 0, samples: [] };
  const result = { usage: null, model: null, finishReasons: [], doneSeen: false, doneMs: null, errorSeen: false, malformedEvents: 0 };
  let buffer = '';
  const record = (value, now) => {
    if (value.error || ['error', 'new_api_error', 'get_channel_failed'].includes(value.type) || value.code === 'get_channel_failed') result.errorSeen = true;
    if (value.usage) result.usage = value.usage;
    if (value.model) result.model = value.model;
    for (const choice of value.choices ?? []) {
      if (choice.finish_reason) result.finishReasons.push(choice.finish_reason);
      const part = choice.delta ?? choice.message ?? {};
      const reasoning = String(part.reasoning_content ?? part.reasoning ?? '');
      const content = String(part.content ?? '');
      const tool = (part.tool_calls ?? []).reduce((sum, call) => sum + String(call.function?.name ?? '').length + String(call.function?.arguments ?? '').length, 0);
      if (reasoning) { timing.firstReasoningMs ??= now; timing.lastReasoningMs = now; timing.reasoningChars += reasoning.length; }
      if (content) { timing.firstContentMs ??= now; timing.lastContentMs = now; timing.contentChars += content.length; }
      if (tool) { timing.firstToolMs ??= now; timing.lastToolMs = now; timing.toolArgChars += tool; }
    }
  };
  const line = (text, now) => {
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trim();
    if (data === '[DONE]') { result.doneSeen = true; result.doneMs ??= now; return; }
    try { record(JSON.parse(data), now); } catch { result.malformedEvents++; }
  };
  const sample = now => timing.samples.push([now, timing.reasoningChars, timing.contentChars, timing.toolArgChars]);
  return {
    timing, result, record,
    push(text) {
      const now = Date.now() - startedMs;
      timing.firstChunkMs ??= now;
      timing.chunks++;
      const lines = (buffer + text).split(/\r?\n/u);
      buffer = lines.pop();
      for (const item of lines) line(item, now);
      if (!timing.samples.length || now - timing.samples.at(-1)[0] >= 1000) sample(now);
    },
    end() {
      if (timing.streamEndMs !== null) return;
      const now = Date.now() - startedMs;
      line(buffer, now); buffer = '';
      timing.streamEndMs = now;
      if (timing.chunks) sample(now);
    },
  };
}
async function relay(request, response, call) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const raw = bytes.toString('utf8');
  call.incomingSha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(evidence, `request-incoming-${call.index}.json`), redact(raw));
  const body = JSON.parse(raw);
  if (body.model !== model) throw new Error('unexpected model');
  call.model = body.model;
  call.stream = body.stream === true;
  call.requestedOutput = body.max_tokens ?? body.max_completion_tokens ?? null;
  call.messageCount = body.messages?.length ?? 0;
  call.tools = body.tools?.map(tool => tool.function?.name ?? tool.name) ?? [];
  call.requestCharacters = raw.length;
  if (call.stream) body.stream_options = { ...body.stream_options, include_usage: true };
  if (body.max_completion_tokens !== undefined) body.max_completion_tokens = Math.min(body.max_completion_tokens, outputTokens);
  else body.max_tokens = Math.min(body.max_tokens ?? outputTokens, outputTokens);
  const forwarded = JSON.stringify(body);
  call.forwardedSha256 = createHash('sha256').update(forwarded).digest('hex');
  await writeFile(path.join(evidence, `request-${call.index}.json`), redact(forwarded));
  call.controller.signal.throwIfAborted();
  call.upstreamStartedMs = Date.now() - call.startedMs;
  let timeout;
  const armTimeout = (duration, reason) => { clearTimeout(timeout); timeout = setTimeout(() => call.abort(reason), duration); };
  armTimeout(firstByteTimeoutMs, 'FIRST_BYTE_TIMEOUT');
  try {
    const remote = await globalThis.fetch(`${upstream.replace(/\/$/u, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: call.controller.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: forwarded,
    });
    call.httpStatus = remote.status;
    call.responseHeaders = Object.fromEntries(['content-type', 'x-request-id', 'request-id', 'x-oneapi-request-id'].map(name => [name, remote.headers.get(name)]).filter(([, value]) => value));
    call.timing.headersMs = Date.now() - call.startedMs;
    response.writeHead(remote.status, { 'content-type': remote.headers.get('content-type') ?? 'application/json' });
    const decoder = new TextDecoder();
    let text = '';
    try {
      for await (const chunk of remote.body) {
        armTimeout(streamIdleTimeoutMs, 'STREAM_IDLE_TIMEOUT');
        const piece = decoder.decode(chunk, { stream: true });
        call.file.write(piece);
        if (call.stream) call.timer.push(piece); else text += piece;
        if (!response.destroyed && !response.write(chunk)) await once(response, 'drain', { signal: call.controller.signal });
      }
      const tail = decoder.decode();
      call.file.write(tail);
      if (call.stream) call.timer.push(tail); else text += tail;
    } finally {
      call.timer.end();
    }
    if (!call.stream) {
      try { call.timer.record(JSON.parse(text), call.timing.streamEndMs); } catch { /* non-JSON error body stays in the response file */ }
    }
    if (!response.destroyed) response.end();
  } finally {
    clearTimeout(timeout);
    call.upstreamEndedMs = Date.now() - call.startedMs;
  }
}

const server = createServer((request, response) => {
  const operation = handleRequest(request, response);
  operations.add(operation);
  void operation.catch(error => { process.stderr.write(`relay request failed: ${redact(String(error.message))}\n`); response.destroy(); }).finally(() => operations.delete(operation));
});
async function handleRequest(request, response) {
  if (request.url === '/health') { response.end('ready'); return; }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', context_length: contextTokens }] })); return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
  if (maxCredit !== undefined || maxRequests !== undefined) {
    const knownCredit = calls.reduce((sum, item) => sum + (typeof item.usage?.credit === 'number' ? item.usage.credit : 0), 0);
    const reason = open.size ? 'BUDGET_REQUEST_IN_FLIGHT'
      : maxRequests !== undefined && calls.length >= maxRequests ? 'REQUEST_BUDGET'
        : maxCredit !== undefined && calls.some(item => !Number.isFinite(item.usage?.credit) || item.usage.credit < 0) ? 'UNKNOWN_CREDIT'
          : maxCredit !== undefined && knownCredit + creditReserve >= maxCredit ? 'CREDIT_BUDGET' : undefined;
    if (reason) {
      await writeFile(path.join(evidence, 'budget-stop.json'), JSON.stringify({ reason, knownCredit, requests: calls.length, maxCredit, creditReserve, time: new Date().toISOString() }, null, 2));
      response.writeHead(402, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: reason } })); return;
    }
  }
  const startedMs = Date.now();
  const timer = streamTimer(startedMs);
  const call = { index: calls.length + 1, startedAt: new Date(startedMs).toISOString(), startedMs, status: 'running', timing: timer.timing };
  calls.push(call);
  const controller = new globalThis.AbortController();
  const abort = reason => {
    if (controller.signal.aborted) return;
    call.abortReason = reason;
    call.abortRequestedMs = Date.now() - startedMs;
    controller.abort(new Error(reason));
    if (!request.complete) request.destroy();
  };
  // Non-enumerable working state keeps calls.json free of handles.
  Object.defineProperties(call, { controller: { value: controller }, abort: { value: abort }, timer: { value: timer }, file: { value: redactingFile(path.join(evidence, `response-${call.index}.txt`)) } });
  open.add(call);
  response.on('close', () => { if (!response.writableFinished) { call.clientDisconnectedMs ??= Date.now() - startedMs; abort('CLIENT_DISCONNECTED'); } });
  request.on('aborted', () => abort('CLIENT_DISCONNECTED'));
  await save();
  try {
    await relay(request, response, call);
    call.status = 'completed';
  } catch (error) {
    call.status = call.abortReason === 'SIGTERM' ? 'interrupted' : call.abortReason === 'CLIENT_DISCONNECTED' ? 'cancelled' : 'failed';
    call.error = redact(String(error.message));
    if (!response.destroyed && !response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
    if (!response.destroyed) response.end(JSON.stringify({ error: { message: call.error } }));
  } finally {
    await finish(call);
  }
}

async function finish(call) {
  if (!open.delete(call)) return;
  call.timer.end();
  call.usage = call.timer.result.usage;
  call.responseModel = call.timer.result.model;
  call.finishReasons = call.timer.result.finishReasons;
  const { doneSeen, doneMs, errorSeen, malformedEvents } = call.timer.result;
  const normalFinish = call.finishReasons.length > 0 && call.finishReasons.every(reason => ['stop', 'tool_calls'].includes(reason));
  const protocolStatus = call.httpStatus >= 400 || errorSeen || malformedEvents ? 'error'
    : doneSeen ? normalFinish ? 'completed' : 'incomplete'
      : call.finishReasons.some(reason => !['stop', 'tool_calls'].includes(reason)) ? 'incomplete' : 'unknown';
  // Transport cancellation also occurs when an SDK stops reading at [DONE].
  // Keep it separate from protocol completion; only native records prove acceptance.
  call.protocol = { status: protocolStatus, doneSeen, doneMs, errorSeen, malformedEvents };
  if (call.abortReason === 'CLIENT_DISCONNECTED' && doneSeen && doneMs <= call.clientDisconnectedMs) call.connectionClose = 'after_protocol_terminal';
  call.clientDisconnected = call.clientDisconnectedMs !== undefined;
  call.elapsedMs = Date.now() - call.startedMs;
  try { await call.file.close(); } catch (error) { call.fileError = String(error.message); }
  await save();
}

// docker stop sends SIGTERM: settle in-flight calls so partial streams and their timings are kept.
process.on('SIGTERM', async () => {
  server.close();
  for (const call of [...open]) call.abort('SIGTERM');
  await Promise.allSettled([...operations]);
  await saving;
  process.exit(0);
});
server.listen(port, process.env.FH_RELAY_HOST ?? '0.0.0.0', () => { process.stdout.write(`relay ready ${server.address().port}\n`); });
