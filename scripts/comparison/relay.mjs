import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

/** A loopback-only budget meter. The real credential is never passed to a harness child. */
export async function createBudgetRelay({ directory, upstream, key, model, maxCalls = 26, maxTokens = 500000, maxContextChars = 256000, maxOutputTokens = 3072, unrestricted = false }) {
  const stats = { requests: 0, tokens: 0, estimated: false, rejected: [], calls: [] };
  const pending = new Set();
  const active = new Set();
  const server = createServer((request, response) => {
    const operation = (async () => {
      const reject = (status, code) => {
        stats.rejected.push(code);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'benchmark_limit', message: code } }));
      };
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return reject(404, 'CHAT_COMPLETIONS_ONLY');
      let byteCount = 0;
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk); byteCount += chunk.length;
        if (!unrestricted && byteCount > 2000000) return reject(413, 'REQUEST_TOO_LARGE');
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(400, 'INVALID_JSON'); }
      if (body.model !== model || body.stream !== true) return reject(400, 'MODEL_OR_STREAM_MISMATCH');
      const context = JSON.stringify({ messages: body.messages, tools: body.tools });
      if (context.length > maxContextChars) return reject(400, 'CONTEXT_BUDGET');
      if (!unrestricted && stats.requests >= maxCalls) return reject(429, 'MODEL_CALL_BUDGET');
      const maxOutput = Math.min(body.max_tokens ?? body.max_completion_tokens ?? maxOutputTokens, maxOutputTokens);
      const reserve = Buffer.byteLength(context) + maxOutput;
      if (!unrestricted && stats.tokens + reserve > maxTokens) return reject(429, 'TOKEN_BUDGET');
      const requestedOutput = body.max_tokens ?? body.max_completion_tokens;
      if ('max_completion_tokens' in body) body.max_completion_tokens = maxOutput;
      else body.max_tokens = maxOutput;
      body.stream_options = { ...body.stream_options, include_usage: true };
      const index = ++stats.requests;
      stats.tokens += reserve;
      const call = { index, contextChars: context.length, reserve, requestedOutput, outputLimit: maxOutput, startedAt: Date.now() };
      stats.calls.push(call);
      await writeFile(path.join(directory, `request-${index}.json`), JSON.stringify(body, null, 2), 'utf8');
      const controller = new globalThis.AbortController();
      active.add(controller);
      const onClose = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', onClose);
      let streamText = '';
      let usageLines = '', accounted = reserve, measuredUsage = false;
      const capture = text => {
        streamText += text;
        usageLines += text;
        let newline;
        while ((newline = usageLines.indexOf('\n')) >= 0) {
          const line = usageLines.slice(0, newline).replace(/\r$/, '');
          usageLines = usageLines.slice(newline + 1);
          if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
          let item;
          try { item = JSON.parse(line.slice(5)); } catch { continue; }
          const usage = item.usage;
          const measured = usage?.prompt_tokens + usage?.completion_tokens;
          if (Number.isSafeInteger(measured) && measured >= 0) {
            // Settle before forwarding: clients may close as soon as finish_reason arrives.
            call.usage = usage;
            stats.tokens += measured - accounted;
            accounted = measured;
            measuredUsage = true;
          }
        }
      };
      try {
        const remote = await globalThis.fetch(`${upstream.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST', redirect: 'error', signal: unrestricted ? controller.signal : globalThis.AbortSignal.any([controller.signal, globalThis.AbortSignal.timeout(120000)]),
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body),
        });
        call.httpStatus = remote.status;
        if (!remote.ok) {
          // Preserve provider classification and retry timing instead of replacing
          // quota/auth errors with a synthetic rate-limit envelope.
          if (remote.status === 429) {
            stats.tokens -= accounted;
            accounted = 0;
            call.usageKnownZero = true;
          }
          const errorChunks = [];
          let errorBytes = 0;
          if (remote.body) for await (const chunk of remote.body) {
            errorBytes += chunk.length;
            if (errorBytes > 64000) throw new Error('ERROR_BODY_LIMIT');
            errorChunks.push(chunk);
          }
          streamText = Buffer.concat(errorChunks).toString('utf8').replaceAll(key, '[redacted]');
          const headers = { 'content-type': remote.headers.get('content-type') ?? 'application/json' };
          for (const name of ['retry-after', 'retry-after-ms']) {
            const value = remote.headers.get(name);
            if (value !== null) headers[name] = value;
          }
          response.writeHead(remote.status, headers);
          response.end(streamText);
          return;
        }
        response.writeHead(remote.status, { 'content-type': remote.headers.get('content-type') ?? 'text/event-stream' });
        const decoder = new globalThis.TextDecoder();
        for await (const chunk of remote.body) {
          capture(decoder.decode(chunk, { stream: true }));
          if (!unrestricted && Buffer.byteLength(streamText) > 2000000) throw new Error('OUTPUT_LIMIT');
          if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
        }
        capture(decoder.decode());
        response.end();
      } catch {
        call.error = controller.signal.aborted ? 'CLIENT_ABORTED' : 'UPSTREAM_TRANSPORT';
        if (!response.headersSent) reject(502, call.error);
        else response.destroy();
      } finally {
        if (!measuredUsage && !call.usageKnownZero) stats.estimated = true;
        active.delete(controller);
        response.removeListener('close', onClose);
        call.elapsedMs = Date.now() - call.startedAt;
        await writeFile(path.join(directory, `response-${index}.sse`), streamText, 'utf8');
      }
    })();
    pending.add(operation);
    operation.catch(() => { response.destroy(); }).finally(() => pending.delete(operation));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, stats,
    async close() {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...pending]);
      await writeFile(path.join(directory, 'relay.json'), JSON.stringify(stats, null, 2), 'utf8');
    },
  };
}
