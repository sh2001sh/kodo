import OpenAI from 'openai';
import { KodoError } from '../runtime/types.js';
import { timedProviderFetch } from './transport.js';

type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Provider bodies are used only for classification, never retained in errors or events. */
export function providerError(value: unknown, status?: number, headers?: Headers, message?: string): KodoError {
  if (value instanceof KodoError) return value;
  // The OpenAI SDK wraps custom-fetch connection errors; retain our safe timeout metadata.
  if (value instanceof OpenAI.APIConnectionError && value.cause instanceof KodoError) return value.cause;
  const payload = value instanceof OpenAI.APIError ? value.error : value;
  if (value instanceof OpenAI.APIError) { status ??= value.status; headers ??= value.headers; }
  const outer = object(payload) ? payload : {};
  const detail = object(outer.error) ? outer.error : outer;
  const fields = [detail.code, detail.type, detail.message, outer.code, outer.type, outer.message]
    .filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 2048)).join(' ').toLowerCase();
  const reportedStatus = detail.status_code ?? detail.status ?? outer.status_code ?? outer.status;
  if (!status && typeof reportedStatus === 'number' && Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599) status = reportedStatus;
  const code = status === 401 || status === 403 || /authentication_error|invalid_api_key|permission_error|unauthorized/.test(fields) ? 'MODEL_AUTH'
    : /insufficient_quota|quota_exceeded|billing_hard_limit|credit_balance|insufficient.*(credit|balance)/.test(fields) ? 'MODEL_QUOTA'
      : /context_length_exceeded|context_window_exceeded|prompt_too_long|maximum context length/.test(fields) ? 'MODEL_CONTEXT'
        : status === 429 || /rate_limit/.test(fields) ? 'MODEL_RATE_LIMIT'
          : status !== undefined && status >= 400 && status < 500 && ![408, 409].includes(status) ? 'MODEL_REQUEST'
            : status !== undefined && status >= 500 ? 'MODEL_TRANSPORT'
            : /invalid_request_error|invalid_request|bad_request|unsupported_parameter/.test(fields) ? 'MODEL_REQUEST' : 'MODEL_TRANSPORT';
  const retryAfterMs = retryDelay(headers);
  return new KodoError(code, message ?? (status ? `provider request failed (HTTP ${status})` : 'provider request failed or stream disconnected'), {
    ...(status !== undefined ? { status } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(status === 429 ? { usageKnownZero: true } : {}),
  });
}

/** Bound server-directed waits; the runtime also applies its remaining duration budget. */
export function retryDelay(headers?: Headers, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get('retry-after-ms');
  const seconds = headers.get('retry-after');
  let delay: number | undefined;
  if (ms !== null && /^\d+(?:\.\d+)?$/.test(ms.trim())) delay = Number(ms);
  else if (seconds !== null) {
    delay = /^\d+(?:\.\d+)?$/.test(seconds.trim()) ? Number(seconds) * 1000 : Date.parse(seconds) - now;
  }
  return delay !== undefined && Number.isFinite(delay) && delay >= 0 ? Math.min(60_000, Math.ceil(delay)) : undefined;
}

/** Detect gateway envelopes even when they arrive inside an HTTP 200 stream. */
export function streamError(value: unknown, headers?: Headers, message = 'provider stream reported an error'): KodoError | undefined {
  if (!object(value)) return undefined;
  if (value.error || value.type === 'error' || value.type === 'new_api_error' || value.type === 'get_channel_failed'
    || value.code === 'get_channel_failed') return providerError(value, undefined, headers, message);
  return undefined;
}

export function usageCounter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new KodoError('MODEL_PROTOCOL', 'invalid usage counters');
  return value;
}

/** Some gateways append bare JSON after SSE heartbeats; SDK parsers silently ignore those lines. */
export const providerFetch: typeof fetch = async (input, init) => {
  const response = await timedProviderFetch(input, init);
  if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let partialResponse = false;
  let framedData: string[] = [];
  const markPartial = (): void => {
    if (!framedData.length) return;
    try {
      const value: unknown = JSON.parse(framedData.join('\n'));
      if (object(value) && value.type !== 'ping' && !streamError(value, response.headers)) partialResponse = true;
    } catch { /* The protocol parser validates framed JSON; this guard only tracks received response content. */ }
    framedData = [];
  };
  const guardError = (error: unknown): unknown => {
    if (!partialResponse) return error;
    const failure = error instanceof KodoError ? error : providerError(error, undefined, response.headers);
    return new KodoError(failure.code, failure.message, { ...failure.metadata, partialResponse: true, usageKnownZero: false });
  };
  const inspect = (line: string): void => {
    const text = line.trim();
    if (!text) { markPartial(); return; }
    if (text.startsWith('data:')) { framedData.push(text.slice(5).trimStart()); return; }
    if (!text.startsWith('{')) return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new KodoError('MODEL_PROTOCOL', 'provider sent unframed invalid event JSON'); }
    const failure = streamError(value, response.headers);
    if (failure) throw failure;
    throw new KodoError('MODEL_PROTOCOL', 'provider sent JSON without SSE framing');
  };
  const guarded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          inspect(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        controller.enqueue(chunk);
      } catch (error) { throw guardError(error); }
    },
    flush() { try { inspect(pending + decoder.decode()); markPartial(); } catch (error) { throw guardError(error); } },
  }));
  return new globalThis.Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
};
