import { describe, expect, it } from 'vitest';
import { Store } from '../src/storage/index.js';
import { buildContext } from '../src/runtime/context.js';
import { estimateInputTokens, estimateTextTokens } from '../src/runtime/context-tokens.js';
import { readHistory } from '../src/runtime/history.js';
import type { Message, ModelResponse, Run, ToolSpec } from '../src/runtime/types.js';
import { answer, fixture } from './helpers.js';

function append(f: ReturnType<typeof fixture>, messages: Message[]): Run {
  const run = f.app.store.run(f.runId);
  return f.app.store.updateRun(run.id, { contextRef: f.app.store.blob([...f.app.store.readBlob<Message[]>(run.contextRef), ...messages]) });
}

function measured(f: ReturnType<typeof fixture>, messages: Message[], tools: ToolSpec[], input: number, response: ModelResponse = answer()): void {
  const run = f.app.store.run(f.runId);
  f.app.store.putCall({ id: 'measured-request', runId: run.id, step: 0, kind: 'model', name: run.binding.model, status: 'succeeded', effect: 'read', requestRef: f.app.store.blob({ binding: run.binding, messages, tools, maxOutputTokens: 100 }), resultRef: f.app.store.blob({ ...response, usage: { input, output: 10 } }), reservedTokens: 0 });
}

describe('token window and durable compaction hardening', () => {
  it('estimates unseen Chinese and emoji by character class with framing headroom', () => {
    const f = fixture();
    const run = append(f, [{ role: 'assistant', content: '中文😀'.repeat(800) }]);
    const messages = f.app.store.readBlob<Message[]>(run.contextRef);
    const estimated = estimateInputTokens(f.app.store, run, messages, []);
    expect(estimated).toBeLessThan(Buffer.byteLength(JSON.stringify({ messages, tools: [] })));
    expect(estimated).toBeGreaterThan(estimateTextTokens(JSON.stringify({ messages, tools: [] })));
  });

  it('reserves output tokens and rejects mandatory inputs before any model call', () => {
    const f = fixture();
    const run = f.app.store.run(f.runId);
    const input = estimateInputTokens(f.app.store, run, f.app.store.readBlob(run.contextRef), []);
    const options = { maxContextTokens: input + 100, maxOutputTokens: 101 };
    expect(() => buildContext(f.app.store, run, 1_000_000, [], options)).toThrow('including reserved output tokens');
    expect(f.app.store.calls(run.id)).toEqual([]);
    expect(buildContext(f.app.store, run, 1_000_000, [], { ...options, maxOutputTokens: 100 }).archivedRef).toBeUndefined();
  });

  it('compacts on the token bound even when the independent character cap fits', () => {
    const f = fixture();
    const base = f.app.store.run(f.runId);
    const initial = estimateInputTokens(f.app.store, base, f.app.store.readBlob(base.contextRef), []);
    const run = append(f, [{ role: 'assistant', content: '中文😀'.repeat(5_000) }]);
    const result = buildContext(f.app.store, run, 1_000_000, [], { maxContextTokens: initial + 6_000, maxOutputTokens: 500 });
    expect(result.archivedRef).toBeDefined();
    expect(result.estimatedInputTokens + 500).toBeLessThanOrEqual(initial + 6_000);
    expect(result.omittedMessages).toBe(1);
  });

  it('restores a measured prefix from persisted calls and estimates new evidence by character class', () => {
    const f = fixture();
    const run = f.app.store.run(f.runId);
    const initial = f.app.store.readBlob<Message[]>(run.contextRef);
    measured(f, initial, [], 100);
    const fresh = [{ role: 'assistant', content: '新证据😀'.repeat(100) }] satisfies Message[];
    const next = append(f, fresh);
    // A reopened Store has no in-memory estimator state or shared ownership lock.
    const directory = f.app.store.directory;
    f.app.close();
    const reopened = new Store(directory);
    try {
      const estimated = estimateInputTokens(reopened, reopened.run(next.id), [...initial, ...fresh], []);
      expect(estimated).toBeGreaterThanOrEqual(100 + estimateTextTokens(JSON.stringify(fresh)));
      expect(estimated).toBeLessThan(estimateInputTokens(reopened, { ...next, binding: { ...next.binding, model: 'different-model' } }, [...initial, ...fresh], []));
    } finally { reopened.close(); }
  });

  it.each(['rules', 'tools', 'endpoint', 'compaction'])('invalidates usage calibration when %s changes', change => {
    const f = fixture();
    const run = f.app.store.run(f.runId);
    const initial = f.app.store.readBlob<Message[]>(run.contextRef);
    measured(f, initial, [], 1);
    const messages = structuredClone(initial);
    let candidate = run;
    let tools: ToolSpec[] = [];
    if (change === 'rules') messages[0] = { role: 'system', content: `${messages[0]!.content} Additional rules.` };
    if (change === 'tools') tools = [{ name: 'large', description: '中文😀'.repeat(200), parameters: {} }];
    if (change === 'endpoint') candidate = { ...run, binding: { ...run.binding, baseURL: 'http://different.invalid/v1' } };
    if (change === 'compaction') messages.splice(1, 1);
    expect(estimateInputTokens(f.app.store, candidate, messages, tools)).toBeGreaterThanOrEqual(estimateTextTokens(JSON.stringify({ messages, tools })));
  });

  it('inherits calibration only over an audited recovery edge and never from failed calls', () => {
    const f = fixture();
    const run = f.app.store.run(f.runId);
    const messages = f.app.store.readBlob<Message[]>(run.contextRef);
    measured(f, messages, [], 100);
    const continuation = { ...run, id: 'continued-for-calibration', continuationOf: run.id };
    f.app.store.putRun(continuation);
    const freshEstimate = estimateInputTokens(f.app.store, continuation, messages, []);
    f.app.store.event(run.id, 'recovery.continued', { runId: continuation.id });
    expect(estimateInputTokens(f.app.store, continuation, messages, [])).toBeLessThan(freshEstimate);
    const call = f.app.store.call('measured-request');
    f.app.store.putCall({ ...call, status: 'failed' });
    expect(estimateInputTokens(f.app.store, continuation, messages, [])).toBe(freshEstimate);
  });

  it('keeps a bounded latest tool preview and smaller earlier evidence without altering signed provider data', () => {
    const f = fixture();
    const old: Message = { role: 'assistant', content: 'Earlier verified result: SMALL_EVIDENCE' };
    const assistant: Message = { role: 'assistant', content: null, tool_calls: [{ id: 'long-call', name: 'process.exec', arguments: '{"program":"test"}' }], providerData: { protocol: 'anthropic', blocks: [{ type: 'thinking', thinking: 'reasoning', signature: 'immutable-signature' }, { type: 'tool_use', id: 'long-call', name: 'process.exec', input: { program: 'test' } }] } };
    const tool: Message = { role: 'tool', tool_call_id: 'long-call', content: `HEAD_EVIDENCE ${'long output '.repeat(10_000)} TAIL_RESULT: tests passed` };
    const run = append(f, [old, assistant, tool]);
    const result = buildContext(f.app.store, run, 9_000, []);
    expect(result.messages).toContainEqual(old);
    expect(result.messages).toContainEqual(assistant);
    const preview = result.messages.find(message => message.role === 'tool' && message.tool_call_id === 'long-call')!;
    const body = JSON.parse(preview.content!);
    expect(body).toMatchObject({ preview: true, history: { ref: result.archivedRef, offset: 5, limit: 1 } });
    expect(body.text).toContain('HEAD_EVIDENCE');
    expect(body.text).toContain('TAIL_RESULT: tests passed');
    expect(result.compactedChars).toBeLessThanOrEqual(9_000);
    expect(result.omittedMessages).toBe(1);
    f.app.store.event(run.id, 'context.compacted', { archivedRef: result.archivedRef });
    const page = readHistory(f.app.store, run.id, { ref: result.archivedRef!, offset: body.history.offset, limit: 1, maxChars: 32_000 });
    expect(page.fragments[0]!.text).toContain('HEAD_EVIDENCE');
    expect(f.app.store.readBlob<{ messages: Message[] }>(result.archivedRef!).messages.at(-1)).toEqual(tool);
  });

  it('skips an unshrinkable recent provider block while retaining smaller preceding results', () => {
    const f = fixture();
    const recent: Message = { role: 'assistant', content: null, providerData: { protocol: 'responses', output: [{ type: 'reasoning', encrypted_content: 'x'.repeat(50_000) }] } };
    const small: Message = { role: 'assistant', content: 'SMALL_PRECEDING_RESULT' };
    const run = append(f, [small, recent]);
    const built = buildContext(f.app.store, run, 8_000, []);
    expect(built.messages).toContainEqual(small);
    expect(built.messages).not.toContainEqual(recent);
    expect(f.app.store.readBlob<{ messages: Message[] }>(built.archivedRef!).messages).toContainEqual(recent);
  });

  it.each([{ maxContextTokens: 100, maxOutputTokens: 100 }, { maxContextTokens: 0 }, { maxContextTokens: 2.5 }, { maxOutputTokens: -1 }])('rejects invalid window/output settings: %j', options => {
    const f = fixture();
    expect(() => buildContext(f.app.store, f.app.store.run(f.runId), 1_000_000, [], options)).toThrow('token context window');
  });
});
