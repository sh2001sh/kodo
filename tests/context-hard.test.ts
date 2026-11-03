import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/runtime/context.js';
import { estimateInputTokens } from '../src/runtime/context-tokens.js';
import { validateHardTargetRatio } from '../src/runtime/context-hard.js';
import type { Message, Run } from '../src/runtime/types.js';
import { fixture } from './helpers.js';

function round(index: number, chars = 4000): Message[] {
  const id = `call-${index}`;
  return [
    { role: 'assistant', content: null, tool_calls: [{ id, name: 'file.read', arguments: `{"path":"f${index}.ts"}` }] },
    { role: 'tool', tool_call_id: id, content: `ROUND_${index} ${'x'.repeat(chars)}` },
  ];
}

function setup(rounds: number): { f: ReturnType<typeof fixture>; run: Run; base: number } {
  const f = fixture();
  const run = f.app.store.run(f.runId);
  const initial = f.app.store.readBlob<Message[]>(run.contextRef);
  const base = estimateInputTokens(f.app.store, run, initial, []);
  const messages = [...initial, ...Array.from({ length: rounds }, (_, index) => round(index)).flat()];
  return { f, run: f.app.store.updateRun(run.id, { contextRef: f.app.store.blob(messages) }), base };
}

/** Tool results must follow the assistant message that called them. */
function pairsIntact(messages: Message[]): boolean {
  return messages.every((message, index) => message.role !== 'tool' || messages.slice(0, index).some(prior => prior.role === 'assistant' && prior.tool_calls?.some(call => call.id === message.tool_call_id)));
}

describe('hard trim headroom', () => {
  it('refills to the target ratio, not to capacity, and keeps call/result pairs intact', () => {
    const { f, run, base } = setup(30);
    const options = { maxContextTokens: base + 20_000, maxOutputTokens: 1000 };
    const built = buildContext(f.app.store, run, null, [], options);
    const capacity = options.maxContextTokens - options.maxOutputTokens;
    expect(built.strategy).toBe('hard');
    expect(built.hardTargetTokens).toBe(Math.floor(capacity * 0.8));
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(built.hardTargetTokens!);
    expect(JSON.stringify(built.messages)).toContain('ROUND_29');
    expect(pairsIntact(built.messages)).toBe(true);
    const legacy = buildContext(f.app.store, run, null, [], { ...options, hardTargetRatio: 1 });
    expect(legacy.estimatedInputTokens).toBeGreaterThan(built.estimatedInputTokens);
    expect(legacy.omittedMessages).toBeLessThan(built.omittedMessages);
  });

  it('does not trim again when the next small observation arrives', () => {
    const { f, run, base } = setup(30);
    const options = { maxContextTokens: base + 20_000, maxOutputTokens: 1000 };
    const first = buildContext(f.app.store, run, null, [], options);
    const next = f.app.store.updateRun(run.id, { contextRef: f.app.store.blob([...first.messages, ...round(30, 1200)]) });
    const second = buildContext(f.app.store, next, null, [], options);
    expect(second.strategy).toBeUndefined();
    expect(second.archivedRef).toBeUndefined();
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
  });

  it('retains the newest round within full capacity even when it alone exceeds the target', () => {
    const { f, run, base } = setup(6);
    const options = { maxContextTokens: base + 4_000, maxOutputTokens: 500 };
    const messages = f.app.store.readBlob<Message[]>(run.contextRef);
    const large = f.app.store.updateRun(run.id, { contextRef: f.app.store.blob([...messages, ...round(6, 10_500)]) });
    const built = buildContext(f.app.store, large, null, [], options);
    expect(built.strategy).toBe('hard');
    expect(JSON.stringify(built.messages)).toContain('ROUND_6');
    expect(pairsIntact(built.messages)).toBe(true);
  });

  it('validates the ratio', () => {
    for (const ratio of [0.49, 1.01, Number.NaN]) expect(() => validateHardTargetRatio(ratio)).toThrow('hardTargetRatio');
    expect(() => validateHardTargetRatio(0.75)).not.toThrow();
  });
});
