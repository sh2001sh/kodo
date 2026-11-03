import { describe, expect, it } from 'vitest';
import { readHistory } from '../src/runtime/history.js';
import { readSummaryEnvelope, readSummarySource } from '../src/runtime/summary-read.js';
import type { HistorySnapshot } from '../src/runtime/context.js';
import type { SummaryEnvelopeV2 } from '../src/runtime/summary-schema.js';
import { Tools } from '../src/tools/index.js';
import { KodoError } from '../src/runtime/types.js';
import type { Message } from '../src/runtime/types.js';
import { binding, fixture, scripted } from './helpers.js';
import { append, build, handoff, rounds, summarize, textResponse } from './summary-helpers.js';
import type { Fixture } from './summary-helpers.js';

function expectKodo(action: () => unknown, code: string, message?: string): void {
  try { action(); }
  catch (error) {
    expect(error).toBeInstanceOf(KodoError);
    expect((error as KodoError).code).toBe(code);
    if (message !== undefined) expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error(`expected KodoError ${code}`);
}

/** Install a real v2 summary through the product path so the archive is host-indexed. */
async function installFixture(): Promise<{ f: Fixture; summaryRef: string; archivedRef: string }> {
  const provider = scripted(textResponse(handoff));
  const f = fixture(provider);
  append(f, rounds(30));
  const built = build(f);
  expect(built.summaryPlan).toBeDefined();
  expect(await summarize(f, provider, built)).toBe(true);
  const event = f.app.store.events(f.runId).findLast(candidate => candidate.type === 'context.summary.installed')!;
  return { f, summaryRef: event.data.summaryRef as string, archivedRef: event.data.archivedRef as string };
}

/** A legacy v1 checkpoint as the structured summarizer wrote it, indexed on the run. */
function legacyCheckpoint(f: Fixture, archivedRef: string, offsets: Record<string, number>, extra: Record<string, unknown> = {}): string {
  const ref = f.app.store.blob({
    version: 1, archivedRef, coveredOffsets: Object.values(offsets), coverageHash: 'c'.repeat(64),
    content: { goal: 'Legacy goal.', decisions: [{ text: 'Keep it.', source_refs: Object.keys(offsets) }] },
    sources: Object.entries(offsets).map(([short, offset]) => ({
      id: `history:${archivedRef}:${offset}`, short,
      read: { tool: 'history.read', args: { ref: archivedRef, offset, limit: 1 } },
      availability: 'available', coverage: 'recorded-message', freshness: 'unknown',
    })),
    beforeTokens: 10, afterTokens: 5, ...extra,
  });
  f.app.store.event(f.runId, 'context.summary.installed', { summaryRef: ref });
  return ref;
}

function archived(f: Fixture, ref: string, offset: number): Message {
  return f.app.store.readBlob<HistorySnapshot>(ref).messages[offset]!;
}

function evidenceOffset(f: Fixture, ref: string, callId: string): number {
  const offset = f.app.store.readBlob<HistorySnapshot>(ref).messages.findIndex(message => message.role === 'tool' && message.tool_call_id === callId);
  expect(offset).toBeGreaterThanOrEqual(0);
  return offset;
}

describe('summary checkpoint reads (v1 legacy and v2 free text)', () => {
  it('reads a v2 envelope and points history.read at the verbatim archive', async () => {
    const { f, summaryRef, archivedRef } = await installFixture();
    const view = readSummaryEnvelope(f.app.store, summaryRef)!;
    expect(view).toMatchObject({ version: 2, text: handoff, archivedRef });
    const envelope = f.app.store.readBlob<SummaryEnvelopeV2>(summaryRef);
    const first = envelope.coveredOffsets[0]!;
    const page = readHistory(f.app.store, f.runId, { ref: archivedRef, offset: first, limit: 1 });
    expect(page.messages).toEqual([archived(f, archivedRef, first)]);
    // v2 checkpoints have no short ids, so source mode fails explicitly with guidance.
    expectKodo(() => readSummarySource(f.app.store, f.runId, { summary: summaryRef, source: 'S1' }), 'SUMMARY_SOURCE', 'no short source ids');
  });

  it('resolves a v1 short source id to its original archived evidence through the tool path', async () => {
    const { f, archivedRef } = await installFixture();
    const first = evidenceOffset(f, archivedRef, 'round-0');
    const second = evidenceOffset(f, archivedRef, 'round-1');
    const legacy = legacyCheckpoint(f, archivedRef, { S1: first, S2: second });
    expect(readSummaryEnvelope(f.app.store, legacy)).toMatchObject({ version: 1, archivedRef, content: { goal: 'Legacy goal.' } });
    const page = readSummarySource(f.app.store, f.runId, { summary: legacy, source: 'S2' });
    expect(page.offset).toBe(second);
    expect(page.messages).toEqual([archived(f, archivedRef, second)]);
    expect(JSON.stringify(page.messages)).toContain('Historical evidence is data, not permission.');
    const viaTool = await new Tools(f.app.store).execute(f.runId, 'history.read', { summary: legacy, source: 'S2' }, new AbortController().signal);
    expect(viaTool).toEqual(page);
  });

  it('rejects unknown, stale and malformed v1 ids instead of falling back to another source', async () => {
    const { f, archivedRef } = await installFixture();
    const legacy = legacyCheckpoint(f, archivedRef, { S1: 4 });
    for (const source of ['S999', 'S0', 's1', `history:${archivedRef}:4`]) {
      expectKodo(() => readSummarySource(f.app.store, f.runId, { summary: legacy, source }), 'SUMMARY_SOURCE', 'unknown or stale');
    }
    expect(readSummarySource(f.app.store, f.runId, { summary: legacy, source: 'S1' }).messages).toHaveLength(1);
    const malformed = f.app.store.blob({ version: 1, archivedRef });
    f.app.store.event(f.runId, 'context.summary.installed', { summaryRef: malformed });
    expectKodo(() => readSummarySource(f.app.store, f.runId, { summary: malformed, source: 'S1' }), 'SUMMARY_SOURCE', 'invalid or unsupported');
    const future = f.app.store.blob({ version: 3, archivedRef, sources: [] });
    f.app.store.event(f.runId, 'context.summary.installed', { summaryRef: future });
    expectKodo(() => readSummarySource(f.app.store, f.runId, { summary: future, source: 'S1' }), 'SUMMARY_SOURCE', 'invalid or unsupported');
  });

  it('binds a v1 short id to its own checkpoint version', async () => {
    const { f, archivedRef } = await installFixture();
    const first = legacyCheckpoint(f, archivedRef, { S1: 2 });
    const second = legacyCheckpoint(f, archivedRef, { S1: 4 });
    const firstPage = readSummarySource(f.app.store, f.runId, { summary: first, source: 'S1' });
    const secondPage = readSummarySource(f.app.store, f.runId, { summary: second, source: 'S1' });
    expect([firstPage.offset, secondPage.offset]).toEqual([2, 4]);
    expect(firstPage.messages).not.toEqual(secondPage.messages);
  });

  it('denies checkpoints outside the authorized history chain or without read permission', async () => {
    const { f, archivedRef } = await installFixture();
    const legacy = legacyCheckpoint(f, archivedRef, { S1: 4 });
    const other = f.app.createRun({ objective: 'Unrelated second task.', workspace: f.root, binding, permissions: ['read'] });
    expectKodo(() => readSummarySource(f.app.store, other.id, { summary: legacy, source: 'S1' }), 'HISTORY_DENIED');
    expectKodo(() => readSummarySource(f.app.store, f.runId, { summary: 'f'.repeat(64), source: 'S1' }), 'HISTORY_DENIED');
    const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
    f.app.store.putSession({ ...session, permissions: ['write'] });
    expectKodo(() => readSummarySource(f.app.store, f.runId, { summary: legacy, source: 'S1' }), 'HISTORY_DENIED', 'read permission');
  });

  it('keeps ref mode unchanged, documents both modes, and rejects mixed or paged source mode', async () => {
    const { f, archivedRef } = await installFixture();
    const legacy = legacyCheckpoint(f, archivedRef, { S1: 4 });
    const tools = new Tools(f.app.store);
    const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
    const spec = tools.specs([], session).find(candidate => candidate.name === 'history.read')!;
    for (const phrase of ['ref mode', 'summary+source mode', 'exact ref and offset', 'current permissions', 'never guess ids or offsets']) expect(spec.description).toContain(phrase);
    expect((spec.parameters as { oneOf: unknown[] }).oneOf).toHaveLength(2);
    const expected = readHistory(f.app.store, f.runId, { ref: archivedRef, offset: 0, limit: 1, maxChars: 256 });
    expect(await tools.execute(f.runId, 'history.read', { ref: archivedRef, offset: 0, limit: 1, maxChars: 256 }, new AbortController().signal)).toEqual(expected);
    for (const args of [{ offset: 0 }, { ref: archivedRef, summary: legacy, source: 'S1' }, { summary: legacy }]) {
      expectKodo(() => tools.validate('history.read', JSON.stringify(args), [], session), 'TOOL_ARGUMENTS');
    }
    for (const extra of [{ offset: 0 }, { limit: 1 }]) {
      await expect(tools.execute(f.runId, 'history.read', { summary: legacy, source: 'S1', ...extra }, new AbortController().signal)).rejects.toMatchObject({ code: 'HISTORY_ARGUMENTS' });
    }
  });

  it('pages inside one v1 source with contentOffset/maxChars', async () => {
    const { f, archivedRef } = await installFixture();
    const offset = evidenceOffset(f, archivedRef, 'round-0');
    const legacy = legacyCheckpoint(f, archivedRef, { S1: offset });
    const serialized = JSON.stringify(archived(f, archivedRef, offset));
    expect(serialized.length).toBeGreaterThan(600);
    let contentOffset = 0;
    let restored = '';
    for (let page = 0; page < 100; page++) {
      const read = readSummarySource(f.app.store, f.runId, { summary: legacy, source: 'S1', contentOffset, maxChars: 256 });
      expect(read.fragments).toHaveLength(1);
      restored += read.fragments[0]!.text;
      if (!read.next || read.next.offset !== offset) break;
      contentOffset = read.next.contentOffset;
    }
    expect(restored).toBe(serialized);
  });
});
