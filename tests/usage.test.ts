import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { chargedTokens } from '../src/runtime/usage.js';
import type { ModelResponse } from '../src/runtime/types.js';
import { binding, scripted, temp } from './helpers.js';

const cachedAnswer: ModelResponse = { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { input: 1000, output: 50, cacheRead: 800, cacheWrite: 100 } };

describe('cache-aware token charging', () => {
  it('charges cache-read input at the configured percent and everything else in full', () => {
    const usage = cachedAnswer.usage!;
    expect(chargedTokens(usage, {})).toBe(1050);
    expect(chargedTokens(usage, { cacheReadCostPercent: 100 })).toBe(1050);
    expect(chargedTokens(usage, { cacheReadCostPercent: 10 })).toBe(200 + 80 + 50);
    expect(chargedTokens(usage, { cacheReadCostPercent: 0 })).toBe(250);
    expect(chargedTokens({ input: 3, output: 0, cacheRead: 3 }, { cacheReadCostPercent: 10 })).toBe(1);
  });

  it('settles session spending with the discounted charge and records it on model.finished', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(cachedAnswer));
    try {
      const run = app.createRun({ objective: 'Reply.', workspace: root, binding, budget: { maxTokens: 100_000, cacheReadCostPercent: 10 } });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(app.store.session(run.sessionId).tokens).toBe(330);
      expect(app.store.events(run.id).find(event => event.type === 'model.finished')?.data.chargedTokens).toBe(330);
    } finally { await app.shutdown(); }
  });

  it('keeps raw-volume accounting by default and rejects out-of-range percents', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(cachedAnswer));
    try {
      expect(() => app.createRun({ objective: 'x', workspace: root, binding, budget: { cacheReadCostPercent: 101 } })).toThrow('0 to 100');
      expect(() => app.createRun({ objective: 'x', workspace: root, binding, budget: { cacheReadCostPercent: 2.5 } })).toThrow('0 to 100');
      const run = app.createRun({ objective: 'Reply.', workspace: root, binding, budget: { maxTokens: 100_000 } });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(app.store.session(run.sessionId).tokens).toBe(1050);
    } finally { await app.shutdown(); }
  });
});
