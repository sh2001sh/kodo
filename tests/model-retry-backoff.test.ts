import { describe, expect, it } from 'vitest';
import { providerError } from '../src/providers/errors.js';
import { transportBackoffMs } from '../src/runtime/model-step.js';
import { KodoError } from '../src/runtime/types.js';
import { answer, fixture } from './helpers.js';

describe('minute-scale transport backoff', () => {
  it('waits about 30s then 60s and keeps the production delays on the durable retry events', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      attempts++;
      throw new KodoError('MODEL_TRANSPORT', 'gateway disconnected');
    } });
    const run = await app.run(runId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('MODEL_TRANSPORT');
    expect(attempts).toBe(3);
    const retries = app.store.events(runId, { types: ['model.retry'] });
    expect(retries.map(event => event.data.delayMs)).toEqual([30_000, 60_000]);
    expect(app.store.calls(runId).filter(call => call.kind === 'model')).toHaveLength(3);
    expect(app.store.session(run.sessionId).usageEstimated).toBe(true);
  });

  it('lets a provider retry-after lengthen the transport backoff instead of shortening it', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      attempts++;
      if (attempts === 1) throw new KodoError('MODEL_TRANSPORT', 'unavailable', { status: 503, retryAfterMs: 120_000 });
      return answer('recovered after the long wait');
    } });
    const run = await app.run(runId);
    expect(run.status).toBe('completed');
    const retry = app.store.events(runId, { types: ['model.retry'] })[0]!;
    expect(retry.data.delayMs).toBe(120_000);
  });

  it('remains cancellable during the injected long wait and keeps the single charged attempt', async () => {
    const previous = process.env.KODO_TEST_RETRY_DELAY_MS;
    process.env.KODO_TEST_RETRY_DELAY_MS = '5000';
    try {
      let attempts = 0;
      const { app, runId } = fixture({ async complete() {
        attempts++;
        throw new KodoError('MODEL_TRANSPORT', 'gateway disconnected');
      } });
      app.store.subscribe(event => { if (event.type === 'model.retry') app.coordinator.cancel(runId); });
      const started = Date.now();
      const run = await app.run(runId);
      expect(run.status).toBe('cancelled');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(attempts).toBe(1);
      expect(app.store.calls(runId).filter(call => call.kind === 'model')).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.KODO_TEST_RETRY_DELAY_MS;
      else process.env.KODO_TEST_RETRY_DELAY_MS = previous;
    }
  });
});

describe('transport backoff policy', () => {
  it('uses 30s then 60s and only lets retry-after lengthen the wait', () => {
    expect(transportBackoffMs(0)).toBe(30_000);
    expect(transportBackoffMs(1)).toBe(60_000);
    expect(transportBackoffMs(2)).toBe(60_000);
    expect(transportBackoffMs(0, 5_000)).toBe(30_000);
    expect(transportBackoffMs(1, 90_000)).toBe(90_000);
  });

  it('raises the retry-after cap only for gateway/server errors', () => {
    const server = providerError(new Error('bad gateway'), 502, new Headers({ 'retry-after': '120' }));
    expect(server).toMatchObject({ code: 'MODEL_TRANSPORT', metadata: { retryAfterMs: 120_000 } });
    const limited = providerError(new Error('slow down'), 429, new Headers({ 'retry-after': '120' }));
    expect(limited).toMatchObject({ code: 'MODEL_RATE_LIMIT', metadata: { retryAfterMs: 60_000 } });
  });
});
