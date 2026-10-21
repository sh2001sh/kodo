import { describe, expect, it } from 'vitest';
import { Application, resolveModelLimits } from '../src/application/index.js';
import { estimateInputTokens } from '../src/runtime/context-tokens.js';
import { Store } from '../src/storage/index.js';
import type { Budget, ModelLimits, Provider } from '../src/runtime/types.js';
import { answer, binding, fixture, temp } from './helpers.js';
import path from 'node:path';

describe('model capabilities without task budget presets', () => {
  it('resolves different context/output limits from exact native model IDs', () => {
    const openai = resolveModelLimits({ ...binding, limits: undefined, baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1' });
    const glm = resolveModelLimits({ ...binding, limits: undefined, baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' });
    expect(openai).toMatchObject({ source: 'catalog', context: 1_047_576, output: 32_768 });
    expect(glm).toMatchObject({ source: 'catalog', context: 1_000_000, output: 131_072 });
    expect(openai.warning).toBeUndefined();
  });

  it('discloses custom endpoint inference and provisional limits for an unknown alias', () => {
    expect(resolveModelLimits({ ...binding, limits: undefined, model: 'glm-5.3' })).toMatchObject({ source: 'model-name', context: 1_000_000, warning: expect.stringContaining('relay') });
    expect(resolveModelLimits({ ...binding, limits: undefined, model: 'gpt-4.1-private-alias' })).toMatchObject({ context: 128_000, output: 16_384, source: 'fallback', warning: expect.stringContaining('not verified') });
    expect(resolveModelLimits({ ...binding, limits: undefined }, { maxContextTokens: 50_000 })).toMatchObject({ context: 50_000, output: 16_384, source: 'fallback' });
    expect(resolveModelLimits({ ...binding, limits: undefined }, { maxContextTokens: 50_000, maxOutputTokens: 10_000 })).toEqual({ context: 50_000, output: 10_000, source: 'explicit' });
  });

  it('lets a host describe an endpoint with a smaller window than the native model', () => {
    const limits = { context: 64_000, output: 12_000, input: 52_000 };
    expect(resolveModelLimits({ ...binding, model: 'gpt-4.1', baseURL: 'https://api.openai.com/v1', limits })).toEqual({ ...limits, source: 'binding' });
  });

  it.each([
    { context: 0, output: 100 }, { context: 10.5, output: 10 }, { context: 10, output: -1 }, { context: 100, output: 10, input: 101 }, { context: 100, output: 10, input: NaN },
  ])('rejects invalid declared capabilities %j before persisting a run', limits => {
    const { app, root } = fixture();
    const previous = app.store.listRuns().length;
    expect(() => app.createRun({ objective: 'test', workspace: root, binding: { ...binding, limits } })).toThrow('model context');
    expect(app.store.listRuns()).toHaveLength(previous);
  });

  it('does not cap cumulative token usage, calls or duration unless the user asks', async () => {
    const { app, runId } = fixture();
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    expect(session.budget).toMatchObject({ maxTokens: null, maxModelCalls: null, maxToolCalls: null, maxDurationMs: null, maxContextChars: null });
    app.store.putSession({ ...session, tokens: 10_000_000, modelCalls: 1000, toolCalls: 1000, activeMs: 86_400_000 });
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.session(session.id).tokens).toBe(10_000_080);
    expect(app.store.session(session.id).activeMs).toBeGreaterThanOrEqual(86_400_000);
  });

  it.each([null, 10_000])('bounds output by actual input, model capability and optional %s token cap', async cap => {
    const root = temp();
    let request: Parameters<Provider['complete']>[0] | undefined;
    let estimatedInput = 0;
    const app = new Application(path.join(root, 'data'), { async complete(input) {
      request = input;
      estimatedInput = estimateInputTokens(app.store, app.store.listRuns()[0]!, input.messages, input.tools);
      return answer();
    } });
    try {
      // Some catalogs advertise output equal to context. It must still leave input room.
      const run = app.createRun({ objective: 'finish', workspace: root, binding: { ...binding, limits: { context: 50_000, output: 50_000 } }, budget: { maxTokens: cap } });
      expect((await app.run(run.id)).status).toBe('completed');
      const input = estimatedInput;
      expect(request!.maxOutputTokens).toBe(Math.min(49_999, 50_000 - input, cap === null ? Infinity : cap - input));
      expect(request!.maxOutputTokens).toBeGreaterThan(0);
      expect(input + request!.maxOutputTokens).toBeLessThanOrEqual(cap ?? 50_000);
    } finally { await app.shutdown(); }
  });

  it('honors a separate provider input limit even when the total context fits', async () => {
    const root = temp();
    let requested = false;
    const app = new Application(path.join(root, 'data'), { async complete() { requested = true; return answer(); } });
    try {
      const run = app.createRun({ objective: 'test', workspace: root, binding: { ...binding, limits: { context: 100_000, output: 20_000, input: 100 } } });
      expect((await app.run(run.id)).error).toContain('CONTEXT_LIMIT');
      expect(requested).toBe(false);
    } finally { await app.shutdown(); }
  });

  it('shrinks a child output allowance to preserve the main response under an explicit cap', async () => {
    const root = temp();
    const outputs: number[] = [];
    const app = new Application(path.join(root, 'data'), { async complete(request) { outputs.push(request.maxOutputTokens); return answer(); } });
    try {
      const main = app.createRun({ objective: 'main', workspace: root, binding: { ...binding, limits: { context: 50_000, output: 50_000 } }, budget: { maxTokens: 35_000 } });
      const child = app.store.transaction(() => app.coordinator.mailbox.execute(main, 'spawn', 'spawn_agent', app.coordinator.mailbox.validate(main, 'spawn_agent', JSON.stringify({ objective: 'child' })))) as { id: string };
      expect((await app.coordinator.wake(child.id)).status).toBe('completed');
      expect(outputs[0]).toBeGreaterThan(0);
      expect(outputs[0]).toBeLessThan(35_000 - 16_384);
      expect((await app.run(main.id)).status).toBe('completed');
      expect(app.store.session(main.sessionId).tokens).toBe(160);
    } finally { await app.shutdown(); }
  });

  it('preserves explicit stopping limits and capabilities across reopen', () => {
    const { app, root } = fixture();
    const budget: Partial<Budget> = { maxTokens: 200_000, maxModelCalls: 30, maxToolCalls: 80, maxDurationMs: 3_600_000, maxContextChars: null };
    const limits: ModelLimits = { context: 128_000, output: 16_000 };
    const run = app.createRun({ objective: 'persist', workspace: root, binding: { ...binding, limits }, budget });
    const directory = app.store.directory;
    app.close();
    const reopened = new Store(directory);
    try {
      expect(reopened.session(run.sessionId).budget).toMatchObject(budget);
      expect(reopened.session(run.sessionId).modelLimits).toEqual({ ...limits, source: 'binding' });
    } finally { reopened.close(); }
  });

  it('keeps requested reductions and rejects output beyond a declared capability', () => {
    const { app, root } = fixture();
    const run = app.createRun({ objective: 'test', workspace: root, binding, budget: { maxContextTokens: 32_000, maxOutputTokens: 4096 } });
    expect(app.store.session(run.sessionId).budget).toMatchObject({ maxContextTokens: 32_000, maxOutputTokens: 4096 });
    expect(() => app.createRun({ objective: 'invalid', workspace: root, binding, budget: { maxOutputTokens: 10_000 } })).toThrow('exceeds known model');
  });
});
