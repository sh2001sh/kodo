import { KodoError } from '../runtime/types.js';

const firstByteTimeoutMs = 120_000;
const streamIdleTimeoutMs = 120_000;

/** Content silence has a separate deadline: gateway heartbeats are not generation. */
export function providerProgress(parent: AbortSignal): { signal: AbortSignal; advance(): void; close(): void } {
  parent.throwIfAborted();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let closed = false;
  const close = (): void => { closed = true; clearTimeout(timer); parent.removeEventListener('abort', cancelled); };
  const cancelled = (): void => { close(); abort.abort(parent.reason); };
  const advance = (): void => {
    if (closed) return;
    clearTimeout(timer);
    // Longer than transport silence, so a dead connection retains its more precise diagnosis.
    timer = setTimeout(() => {
      close();
      abort.abort(new KodoError('MODEL_TRANSPORT', 'provider content progress timed out', {
        timeoutPhase: 'content_idle', timeoutMs: 180_000, usageKnownZero: false,
      }));
    }, 180_000);
  };
  parent.addEventListener('abort', cancelled, { once: true });
  advance();
  return { signal: abort.signal, advance, close };
}

/** Bound silence, not total generation time. Used by every streaming provider. */
export const timedProviderFetch: typeof fetch = async (input, init) => {
  const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  parent?.throwIfAborted();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  const cleanup = (): void => { clearTimeout(timer); parent?.removeEventListener('abort', cancelled); };
  const stop = (reason: unknown): void => {
    if (finished) return;
    finished = true;
    cleanup();
    abort.abort(reason);
    output?.error(reason);
    // The original error is already delivered; cancellation failure cannot replace it.
    void reader?.cancel(reason).catch(() => undefined);
  };
  const cancelled = (): void => stop(parent?.reason);
  const arm = (phase: 'first_byte' | 'stream_idle'): void => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(new KodoError('MODEL_TRANSPORT', `provider ${phase === 'first_byte' ? 'first response byte' : 'stream activity'} timed out`, {
      timeoutPhase: phase, usageKnownZero: false,
    })), phase === 'first_byte' ? firstByteTimeoutMs : streamIdleTimeoutMs);
  };
  parent?.addEventListener('abort', cancelled, { once: true });
  arm('first_byte');
  try {
    const response = await fetch(input, { ...init, redirect: 'error', signal: abort.signal });
    abort.signal.throwIfAborted();
    if (!response.body) { finished = true; cleanup(); return response; }
    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      async pull(controller) {
        try {
          const chunk = await reader!.read();
          if (finished) return;
          if (chunk.done) { finished = true; cleanup(); controller.close(); reader!.releaseLock(); }
          else { if (chunk.value.byteLength) arm('stream_idle'); controller.enqueue(chunk.value); }
        } catch (error) { stop(error); }
      },
      async cancel(reason) {
        if (finished) return;
        finished = true;
        cleanup();
        abort.abort(reason);
        // Aborting fetch may already error its reader. Consumer cleanup must not
        // replace a protocol rejection (or a successful early completion).
        await reader!.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    finished = true;
    cleanup();
    throw abort.signal.aborted ? abort.signal.reason : error;
  }
};
