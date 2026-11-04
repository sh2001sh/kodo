import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { messageGroups, summaryPrefix } from '../src/runtime/context.js';
import { summarizeContext } from '../src/runtime/compaction.js';
import { runBudget } from '../src/runtime/coordinator.js';
import { readHistory, searchHistory } from '../src/runtime/history.js';
import type { SummaryEnvelopeV2 } from '../src/runtime/summary-schema.js';
import { KodoError } from '../src/runtime/types.js';
import type { Message, Provider, ToolSpec } from '../src/runtime/types.js';
import { answer, binding, fixture, scripted, temp } from './helpers.js';
import { append, build, contextOf, eventTypes, handoff, longText, rounds, summarize, textResponse } from './summary-helpers.js';
import type { Fixture } from './summary-helpers.js';

type Request = Parameters<Provider['complete']>[0];
const probeTool: ToolSpec = { name: 'file.read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } };

/** Records every request and replays scripted outcomes; a thrown KodoError models a provider failure. */
function recording(...outcomes: (string | KodoError)[]): { provider: Provider; requests: Request[] } {
  const requests: Request[] = [];
  return { requests, provider: { async complete(request) {
    requests.push(request);
    const next = outcomes.shift();
    if (next === undefined) throw new Error('unexpected model request');
    if (next instanceof KodoError) throw next;
    return textResponse(next);
  } } };
}
function markers(f: Fixture): string[] {
  return contextOf(f).filter(message => message.role === 'user' && message.content.startsWith(summaryPrefix)).map(message => message.content as string);
}
function installed(f: Fixture) {
  return f.app.store.events(f.runId).filter(event => event.type === 'context.summary.installed');
}

describe('working-context compaction v3: mask projection and trigger geometry', () => {
  it('masks old completed observations, keeps protocol pairs, and skips a summary the geometry cannot hold', () => {
    const f = fixture();
    append(f, rounds(12));
    const built = build(f, 5_000, 'hybrid');
    expect(built.strategy).toBe('mask');
    expect(built.targetTokens).toBe(3_500);
    expect(built.estimatedInputTokens).toBeLessThan(built.originalInputTokens!);
    expect(built.summaryPlan).toBeUndefined();
    expect(built.summarySkipped).toMatchObject({ reason: 'geometry', archivedRef: expect.any(String) });
    expect(built.summarySkipped!.roomTokens).toBeLessThan(2_048);
    const hidden = built.messages.filter((message): message is Extract<Message, { role: 'tool' }> => message.role === 'tool' && message.content.includes('"contextHidden":true'));
    expect(hidden.length).toBeGreaterThan(0);
    const record = JSON.parse(hidden[0]!.content) as { preview: string; read: unknown };
    expect(record).toMatchObject({ contextHidden: true, tool: 'file.read', coverage: 'recorded-message' });
    expect(record.read).toMatchObject({ tool: 'history.read', args: { ref: built.archivedRef, limit: 1 } });
    expect(record.preview).toContain('round-0');
    expect(record.preview.length).toBeLessThan(400);
    const pairs = new Set<string>();
    for (const message of built.messages) {
      if (message.role === 'assistant' && message.tool_calls) for (const call of message.tool_calls) pairs.add(call.id);
      else if (message.role === 'tool') expect(pairs.delete(message.tool_call_id)).toBe(true);
    }
    expect(pairs.size).toBe(0);
  });

  it('never masks unresolved failed tool rounds or the most recent complete round', () => {
    const f = fixture();
    append(f, rounds(12));
    append(f, [
      { role: 'assistant', content: 'Try a broken command', tool_calls: [{ id: 'failed-call', name: 'process.exec', arguments: '{"program":"node"}' }] },
      { role: 'tool', tool_call_id: 'failed-call', content: JSON.stringify({ error: 'failed-hard', cancelled: false }) },
    ]);
    const built = build(f, 8_000, 'hybrid');
    const failed = built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'failed-call');
    expect(failed?.content).toContain('failed-hard');
    expect(failed?.content).not.toContain('contextHidden');
  });

  it('leaves a fitting context untouched without a hidden model request', () => {
    const f = fixture();
    append(f, rounds(1));
    const before = contextOf(f);
    const built = build(f);
    expect(built.messages).toEqual(before);
    expect(built.strategy).toBeUndefined();
    expect(built.summaryPlan).toBeUndefined();
    expect(f.app.store.session(f.app.store.run(f.runId).sessionId).modelCalls).toBe(0);
  });

  it('keeps a 0.3(H - F) recent tail and targets an install at or below F + 0.5(H - F)', () => {
    const f = fixture();
    append(f, rounds(30));
    const built = build(f);
    const plan = built.summaryPlan!;
    expect(plan).toBeDefined();
    expect(plan.recentOffsets.length).toBeGreaterThan(0);
    const archive = f.app.store.readBlob<{ messages: Message[] }>(plan.archivedRef).messages;
    const tail = plan.recentOffsets.map(offset => archive[offset]!);
    expect(JSON.stringify(tail).length / 4).toBeLessThanOrEqual(16_000 * 0.3 + 2_000);
    expect(plan.targetTokens).toBeGreaterThanOrEqual(2_048);
    expect(plan.targetTokens).toBeLessThanOrEqual(8_000);
  });
});

describe('working-context compaction v3: prefix-reusing free-text summary', () => {
  it('reuses the main request prefix and tools, installs one marker, and does not retrigger on the next step', async () => {
    const { provider, requests } = recording(handoff);
    const f = fixture(provider);
    append(f, rounds(30));
    const built = build(f, 16_000, 'summary', [probeTool]);
    expect(await summarize(f, provider, built, [probeTool])).toBe(true);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.messages.slice(0, -1)).toEqual(built.messages);
    expect(request.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('Context checkpoint') });
    expect(request.tools).toEqual([probeTool]);
    expect(request.toolChoice).toBe('none');
    expect(built.summaryPlan!.targetTokens).toBeGreaterThan(2048);
    expect(request.messages.at(-1)?.content).toContain(`about ${built.summaryPlan!.targetTokens} tokens or fewer`);
    expect(request.messages.at(-1)?.content).not.toContain('at most 2048 tokens');
    // A concise handoff target must not truncate the provider's reasoning allowance.
    expect(request.maxOutputTokens).toBe(runBudget(f.app.store.run(f.runId), f.app.store.session(f.app.store.run(f.runId).sessionId)).maxOutputTokens);

    const [marker] = markers(f);
    expect(markers(f)).toHaveLength(1);
    expect(marker).toContain(handoff);
    expect(marker).toContain(`history.read({"ref":"${built.summaryPlan!.archivedRef}"`);
    expect(marker).toContain('history.search');
    const event = installed(f)[0]!;
    const envelope = f.app.store.readBlob<SummaryEnvelopeV2>(event.data.summaryRef as string);
    expect(envelope).toMatchObject({ version: 2, text: handoff, archivedRef: built.summaryPlan!.archivedRef, coveredOffsets: built.summaryPlan!.foldOffsets, droppedGroups: 0 });
    expect(envelope.afterTokens).toBeLessThan(envelope.beforeTokens);
    expect(envelope.afterTokens).toBeLessThanOrEqual(8_000);
    expect(() => messageGroups(contextOf(f))).not.toThrow();
    expect(f.app.context(f.runId).summary).toMatchObject({ version: 2, text: handoff, ref: event.data.summaryRef });

    const next = build(f, 16_000, 'summary', [probeTool]);
    expect(next.summaryPlan).toBeUndefined();
    expect(next.estimatedInputTokens).toBeLessThanOrEqual(16_000);
  });

  it.each([
    ['short', 'Next step: run the tests.'],
    ['over the advisory target', longText(6_000)],
    ['fenced JSON', '```json\n{"goal":"finish"}\n```'],
  ])('installs any non-empty %s summary text', async (_, text) => {
    const { provider } = recording(text);
    const f = fixture(provider);
    append(f, rounds(30));
    expect(await summarize(f, provider, build(f))).toBe(true);
    expect(markers(f)[0]).toContain(text.trim());
  });

  it('rejects an empty summary, falls back to mask, and never re-requests the same archive version', async () => {
    const { provider, requests } = recording('   ');
    const f = fixture(provider);
    append(f, rounds(30));
    const built = build(f);
    const before = f.app.store.run(f.runId).contextRef;
    expect(await summarize(f, provider, built)).toBe(false);
    expect(await summarize(f, provider, built)).toBe(false);
    expect(requests).toHaveLength(1);
    expect(f.app.store.run(f.runId).contextRef).toBe(before);
    const failed = f.app.store.events(f.runId).find(event => event.type === 'context.summary.failed');
    expect(failed?.data.reason).toMatch(/^SUMMARY_EMPTY:/);
    const fallback = build(f);
    expect(fallback.strategy).toBe('mask');
    expect(fallback.messages.some(message => message.role === 'tool' && message.content.includes('"contextHidden":true'))).toBe(true);
  });

  it('rejects a summary that does not reduce working input as SUMMARY_NO_GAIN', async () => {
    const { provider } = recording(handoff);
    const f = fixture(provider);
    append(f, rounds(30));
    const built = build(f);
    built.estimatedInputTokens = 1;
    expect(await summarize(f, provider, built)).toBe(false);
    expect(f.app.store.events(f.runId).find(event => event.type === 'context.summary.failed')?.data.reason).toMatch(/^SUMMARY_NO_GAIN:/);
    expect(installed(f)).toHaveLength(0);
  });

  it.each([
    ['transport', new KodoError('MODEL_TRANSPORT', 'connection lost')],
    ['tool call', 'tool-call'],
  ])('retries a %s failure once and accounts for both requests', async (_, failure) => {
    let requests = 0;
    const provider: Provider = { async complete() {
      requests++;
      if (failure instanceof KodoError) throw failure;
      return { ...textResponse(), message: { role: 'assistant', content: null, tool_calls: [{ id: 'forbidden', name: 'file.delete', arguments: '{}' }] }, finishReason: 'tool_calls' };
    } };
    const f = fixture(provider);
    append(f, rounds(30));
    expect(await summarize(f, provider, build(f))).toBe(false);
    expect(requests).toBe(2);
    expect(f.app.store.session(f.app.store.run(f.runId).sessionId).modelCalls).toBe(2);
    expect(f.app.store.calls(f.runId).filter(call => call.kind === 'tool')).toHaveLength(0);
  });

  it('retries once after an incomplete response within one started attempt', async () => {
    const { provider, requests } = recording(new KodoError('MODEL_INCOMPLETE', 'cut off'), handoff);
    const f = fixture(provider);
    append(f, rounds(30));
    expect(await summarize(f, provider, build(f))).toBe(true);
    expect(requests).toHaveLength(2);
    expect(f.app.store.events(f.runId).filter(event => event.type === 'model.started').map(event => event.data.retry ?? false)).toEqual([false, true]);
    expect(f.app.store.events(f.runId).filter(event => event.type === 'context.summary.started')).toHaveLength(1);
  });

  it('shrinks toward the install target once after a context-window error and records archive-only history', async () => {
    const { provider, requests } = recording(new KodoError('MODEL_CONTEXT', 'prompt_too_long'), handoff);
    const f = fixture(provider);
    append(f, rounds(30));
    expect(await summarize(f, provider, build(f))).toBe(true);
    expect(requests[1]!.messages.length).toBeLessThan(requests[0]!.messages.length - 2);
    expect(JSON.stringify(requests[1]!.messages)).not.toContain('Inspect round-0"');
    const dropped = f.app.store.readBlob<SummaryEnvelopeV2>(installed(f)[0]!.data.summaryRef as string).droppedGroups;
    expect(dropped).toBeGreaterThan(1);
    expect(markers(f)[0]).toContain(`earliest ${dropped} rounds`);
  });

  it('falls back to readable history when one forced summary projection still overflows', async () => {
    const window = (): KodoError => new KodoError('MODEL_CONTEXT', 'prompt_too_long');
    const { provider, requests } = recording(window(), window(), window(), window(), handoff);
    const f = fixture(provider);
    append(f, rounds(30));
    expect(await summarize(f, provider, build(f))).toBe(false);
    expect(requests).toHaveLength(2);
    expect(f.app.store.events(f.runId).find(event => event.type === 'context.summary.failed')?.data.reason).toMatch(/^MODEL_CONTEXT:/);
    expect(f.app.store.run(f.runId).status).toBe('queued');
    expect(build(f).strategy).toBe('mask');
  });

  it('merges a previous summary from the prefix and keeps exactly one marker', async () => {
    const { provider, requests } = recording(handoff, 'Merged handoff: still keep old/api.ts unchanged.');
    const f = fixture(provider);
    append(f, rounds(30));
    expect(await summarize(f, provider, build(f))).toBe(true);
    const first = installed(f)[0]!;
    append(f, rounds(30, 'later'));
    const second = build(f);
    expect(second.summaryPlan).toBeDefined();
    expect(await summarize(f, provider, second)).toBe(true);
    expect(requests[1]!.messages.some(message => message.content === first.data.marker)).toBe(true);
    expect(markers(f)).toHaveLength(1);
    expect(markers(f)[0]).toContain('Merged handoff');
    const envelope = f.app.store.readBlob<SummaryEnvelopeV2>(installed(f)[1]!.data.summaryRef as string);
    expect(envelope.previousSummaryRef).toBe(first.data.summaryRef);
  });

  it('retains negative constraints and exact evidence through three summaries and garbage collection', async () => {
    const { provider } = recording(handoff, handoff, handoff);
    const f = fixture(provider);
    const constraint = 'Never change old/api.ts; preserve limit=37 and the legacy signature.';
    append(f, [{ role: 'user', content: constraint }]);
    const needle = 'random-original-evidence-84571';
    for (let iteration = 0; iteration < 3; iteration++) {
      append(f, rounds(30, iteration === 0 ? needle : `pass-${iteration}`));
      expect(await summarize(f, provider, build(f))).toBe(true);
      expect(contextOf(f).some(message => message.content === constraint)).toBe(true);
      expect(markers(f)).toHaveLength(1);
      expect(() => messageGroups(contextOf(f))).not.toThrow();
    }
    f.app.store.gc();
    let cursor: string | undefined;
    const matches = [];
    do {
      const page = searchHistory(f.app.store, f.runId, { query: needle, cursor });
      matches.push(...page.items); cursor = page.next ?? undefined;
    } while (cursor);
    const hit = matches.find(item => item.read.tool === 'history.read');
    expect(hit).toBeDefined();
    expect(JSON.stringify(readHistory(f.app.store, f.runId, hit!.read.args as { ref: string; offset: number }))).toContain(needle);
  });
});

describe('working-context compaction v3: coordinator path', () => {
  it('summarizes before the normal call, reusing its prefix and tools, then consumes input arriving during generation', async () => {
    const directory = temp();
    const workspace = path.join(directory, 'workspace');
    mkdirSync(workspace);
    let runId = '';
    const requests: Request[] = [];
    const provider: Provider = { async complete(request) {
      requests.push(request);
      if (requests.length === 1) {
        app.submitInput(runId, 'Keep the newly requested API compatibility.');
        return textResponse();
      }
      expect(JSON.stringify(request.messages)).toContain('Keep the newly requested API compatibility.');
      expect(request.messages.some(message => message.content?.startsWith(summaryPrefix))).toBe(true);
      return answer('delivered');
    } };
    const app = new Application(path.join(directory, 'data'), provider, undefined, { compaction: { strategy: 'summary', workInputTokens: 64_000 }, exploration: false });
    try {
      const run = app.createRun({ objective: 'Maintain compatibility.', workspace, binding, permissions: ['read'] });
      runId = run.id;
      app.store.updateRun(runId, { contextRef: app.store.blob([...app.store.readBlob<Message[]>(run.contextRef), ...rounds(50)]) });
      const final = await app.run(runId);
      expect(final.status).toBe('completed');
      expect(requests).toHaveLength(2);
      expect(requests[0]!.toolChoice).toBe('none');
      expect(requests[0]!.tools.map(tool => tool.name)).toEqual(requests[1]!.tools.map(tool => tool.name));
      expect(app.store.events(runId).map(event => event.type)).toEqual(expect.arrayContaining(['context.summary.started', 'context.summary.installed', 'run.completed']));
      expect(app.store.inbox(runId)).toEqual([]);
    } finally { await app.shutdown(); }
  });
});

describe('working-context compaction: source deduplication, budget and lifecycle', () => {
  it('keeps masking after repeated failures and summarizes new material without a failure-count circuit breaker', async () => {
    const { provider, requests } = recording('', '', handoff);
    const f = fixture(provider);
    append(f, rounds(60));
    expect(await summarize(f, provider, build(f))).toBe(false);
    append(f, rounds(10, 'more'));
    const second = build(f);
    expect(second.strategy).toBe('mask');
    expect(second.summaryPlan).toBeDefined();
    expect(await summarize(f, provider, second)).toBe(false);
    expect(requests).toHaveLength(2);
    expect(eventTypes(f)).not.toContain('context.summary.disabled');
    append(f, rounds(10, 'after'));
    const next = build(f);
    expect(next.summaryPlan).toBeDefined();
    expect(next.strategy).toBe('mask');
    expect(await summarize(f, provider, next)).toBe(true);
    expect(requests).toHaveLength(3);
  });

  it('does not disable future summaries when reducing installs remain above their preferred target', async () => {
    const { provider } = recording(longText(9_000), longText(9_000));
    const f = fixture(provider);
    append(f, rounds(30));
    expect(await summarize(f, provider, build(f))).toBe(true);
    expect(eventTypes(f)).not.toContain('context.summary.disabled');
    append(f, rounds(2, 'next'));
    const second = build(f);
    expect(second.summaryPlan).toBeDefined();
    expect(await summarize(f, provider, second)).toBe(true);
    expect(installed(f).every(event => Number(event.data.afterTokens) > 11_200)).toBe(true);
    expect(eventTypes(f)).not.toContain('context.summary.disabled');
    append(f, rounds(10, 'future'));
    expect(build(f).summaryPlan).toBeDefined();
  });

  it('skips the request when the shared session budget cannot preserve a normal response', async () => {
    const f = fixture();
    append(f, rounds(30));
    const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
    f.app.store.putSession({ ...session, budget: { ...session.budget, maxModelCalls: 1 } });
    const provider: Provider = { async complete() { throw new Error('summary request must not run'); } };
    expect(await summarize(f, provider, build(f))).toBe(false);
    expect(f.app.store.events(f.runId).find(event => event.type === 'context.summary.skipped')?.data.reason).toBe('shared budget preserves normal response');
    expect(f.app.store.calls(f.runId).some(call => call.purpose === 'compaction')).toBe(false);
  });

  it('discards a generated summary when the decision version changes during generation', async () => {
    const holder: { fixture?: Fixture } = {};
    const provider = scripted(async () => {
      const f = holder.fixture!;
      const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
      f.app.store.putSession({ ...session, decisionVersion: (session.decisionVersion ?? 0) + 1 });
      return textResponse();
    });
    const f = fixture(provider);
    holder.fixture = f;
    append(f, rounds(30));
    const before = f.app.store.run(f.runId).contextRef;
    expect(await summarize(f, provider, build(f))).toBe(false);
    expect(f.app.store.run(f.runId).contextRef).toBe(before);
    expect(eventTypes(f)).toContain('context.summary.discarded');
  });

  it('cancels generation without installing or repeating the source request', async () => {
    const controller = new AbortController();
    const provider: Provider = { async complete() { controller.abort(new Error('cancel summary')); return await new Promise<never>(() => {}); } };
    const f = fixture(provider);
    append(f, rounds(30));
    const built = build(f);
    const before = f.app.store.run(f.runId).contextRef;
    const run = f.app.store.run(f.runId);
    await expect(summarizeContext({ store: f.app.store, run, built, budget: runBudget(run, f.app.store.session(run.sessionId)), tools: [], provider, signal: controller.signal })).rejects.toThrow('cancel summary');
    expect(f.app.store.run(f.runId).contextRef).toBe(before);
    expect(f.app.store.calls(f.runId)[0]!.status).toBe('cancelled');
    expect(await summarize(f, provider, built)).toBe(false);
  });

  it('keeps the pre-crash context and never half-installs a generated summary after restart', async () => {
    const { provider, requests } = recording(handoff);
    const f = fixture(provider);
    append(f, rounds(30));
    const built = build(f);
    const before = f.app.store.run(f.runId).contextRef;
    f.app.store.updateRun(f.runId, { status: 'running' });
    const store = f.app.store;
    const originalUpdate = store.updateRun.bind(store);
    store.updateRun = ((id: string, changes: Parameters<typeof store.updateRun>[1]) => {
      if (id === f.runId && changes.contextRef !== undefined) throw new Error('simulated process death before atomic install');
      return originalUpdate(id, changes);
    }) as typeof store.updateRun;
    try { await expect(summarize(f, provider, built)).rejects.toThrow('simulated process death'); }
    finally { store.updateRun = originalUpdate; }
    expect(f.app.store.run(f.runId).contextRef).toBe(before);
    expect(eventTypes(f)).toContain('context.summary.started');
    expect(eventTypes(f)).not.toContain('context.summary.installed');
    expect(await summarize(f, provider, built)).toBe(false);
    expect(requests).toHaveLength(1);
    await f.app.shutdown();
    const reopened = new Application(path.join(f.root, '.state'), provider);
    try {
      const run = reopened.store.run(f.runId);
      expect(run.status).toBe('interrupted');
      expect(run.contextRef).toBe(before);
      const inspection = reopened.context(f.runId);
      expect(inspection.summary).toBeNull();
      expect(inspection.latestCompaction).toBeNull();
      expect(inspection.usage.summaryCalls).toBe(1);
    } finally { await reopened.shutdown(); }
  });
});
