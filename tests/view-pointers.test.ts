import { describe, expect, it } from 'vitest';
import { historyReadCall, historyReadPointer, parseHistoryPointer } from '../src/runtime/view-pointers.js';
import { maskToolMessage, prunedMarker, pruneToolMessage } from '../src/runtime/tool-result-prune.js';
import type { ToolResultSource } from '../src/runtime/tool-result-prune.js';
import { summaryMarker } from '../src/runtime/summary-schema.js';
import { summaryPrefix, buildContext } from '../src/runtime/context.js';
import type { HistorySnapshot } from '../src/runtime/context.js';
import { readHistory, searchHistory } from '../src/runtime/history.js';
import type { Message } from '../src/runtime/types.js';
import { fixture } from './helpers.js';

const ref = 'a'.repeat(64);

function append(f: ReturnType<typeof fixture>, messages: Message[]): void {
  const run = f.app.store.run(f.runId);
  f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob([...f.app.store.readBlob<Message[]>(run.contextRef), ...messages]) });
}

describe('view pointer helpers', () => {
  it('keeps the pointer arguments object as given', () => {
    const args = { ref, offset: 3, contentOffset: 9, limit: 1, maxChars: 4000 };
    const pointer = historyReadPointer(args);
    expect(pointer).toEqual({ tool: 'history.read', args });
    expect(pointer.args).toBe(args);
    expect(JSON.stringify(pointer)).toBe(`{"tool":"history.read","args":{"ref":"${ref}","offset":3,"contentOffset":9,"limit":1,"maxChars":4000}}`);
  });

  it('parses history.read pointers and rejects malformed or other shapes', () => {
    expect(parseHistoryPointer({ tool: 'history.read', args: { ref, offset: 2, limit: 1 } })).toEqual({ ref, offset: 2 });
    expect(parseHistoryPointer({ tool: 'history.read', args: { ref, offset: 0 } })).toEqual({ ref, offset: 0 });
    for (const bad of [undefined, null, 'x', {}, { tool: 'read', args: { history: ref, offset: 0 } }, { tool: 'read', args: { path: 'a.ts', offset: 1 } }, { tool: 'history.read', args: { history: ref, offset: 1 } },
      { tool: 'read', args: { ref, offset: 1 } }, { tool: 'history.read', args: { ref, offset: -1 } }, { tool: 'history.read', args: { ref, offset: 1.5 } }, { tool: 'file.read', args: { ref, offset: 1 } }]) {
      expect(parseHistoryPointer(bad)).toBeUndefined();
    }
  });

  it('names the prose paging call', () => {
    expect(historyReadCall(ref, 4)).toBe(`history.read({"ref":"${ref}","offset":4})`);
  });
});

describe('pointer producers', () => {
  const big: Message = { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(9000) };
  const source = (): ToolResultSource => ({ archivedRef: ref, offsetOf: () => 7, call: () => undefined });

  it('prune renders the kernel history.read literal', () => {
    const tail = `${prunedMarker} 3880 characters omitted from model input, not deleted; full result: `;
    expect(pruneToolMessage(big, source())!.content).toBe(`${'x'.repeat(4096)}\n${tail}{"tool":"history.read","args":{"ref":"${ref}","offset":7,"limit":1}}\n${'x'.repeat(1024)}`);
  });

  it('mask renders the kernel history.read pointer with stable key order', () => {
    const group: Message[] = [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'file.read', arguments: '{}' }] }, big];
    const masked = JSON.parse(maskToolMessage(big, group, source())!.content) as Record<string, unknown>;
    expect(masked.read).toEqual({ tool: 'history.read', args: { ref, offset: 7, limit: 1 } });
    expect(Object.keys(masked)).toEqual(['contextHidden', 'tool', 'callId', 'status', 'preview', 'originalChars', 'coverage', 'read', 'note']);
  });

  it('summary marker names history.read and history.search', () => {
    const input = { text: 'Goal: x', archivedRef: ref, coveredOffsets: [2, 3, 9], droppedGroups: 0 };
    expect(summaryMarker(input)).toBe(`${summaryPrefix}Goal: x\n\n[Archive] Summarized messages 2-9 remain verbatim: page them with history.read({"ref":"${ref}","offset":2}) and use history.search to find exact details instead of repeating work.`);
  });
});

describe('history pointers', () => {
  it('readHistory and searchHistory render kernel history.read pointers', () => {
    const f = fixture();
    const run = f.app.store.run(f.runId);
    const snapshot: HistorySnapshot = { version: 1, runId: run.id, sessionId: run.sessionId, messages: [{ role: 'user', content: 'needle-token here' }] };
    const archived = f.app.store.blob(snapshot);
    f.app.store.event(f.runId, 'context.compacted', { archivedRef: archived });
    const options = { ref: archived, offset: 0, limit: 1 };
    const read = readHistory(f.app.store, f.runId, options).source.read;
    const hit = searchHistory(f.app.store, f.runId, { query: 'needle-token' }).items.find(item => item.source.kind === 'history');
    expect(read).toEqual({ tool: 'history.read', args: options });
    expect(hit?.read).toEqual({ tool: 'history.read', args: { ref: archived, offset: 0, contentOffset: 0, limit: 1, maxChars: 4000 } });
  });

  it('searchHistory covers a large archive in one call through the index', () => {
    const f = fixture();
    const run = f.app.store.run(f.runId);
    const filler = '无关的段落内容。'.repeat(1500);
    const pages: Message[] = Array.from({ length: 60 }, (_, index) => ({ role: 'user', content: `${filler}${index === 47 ? '【备忘】「青岚」归档集群的冷备份保留 42 天。' : ''}${filler}` }));
    const archived = f.app.store.blob({ version: 1, runId: run.id, sessionId: run.sessionId, messages: [...pages, pages[47]!] } satisfies HistorySnapshot);
    f.app.store.event(f.runId, 'context.compacted', { archivedRef: archived });
    const page = searchHistory(f.app.store, f.runId, { query: '青岚 冷备份' });
    expect(page.totalMatches).toBe(1); // the duplicated message is one record
    expect(page.next).toBeNull();
    expect(page.items[0]!.snippet).toContain('保留 42 天');
    const read = readHistory(f.app.store, f.runId, page.items[0]!.read.args as { ref: string; offset: number; contentOffset: number; maxChars: number });
    expect(read.fragments[0]!.text).toContain('「青岚」归档集群的冷备份保留 42 天');
    expect(searchHistory(f.app.store, f.runId, { query: '青岚 热备份' }).items).toEqual([]);
    for (let index = 0; index < 3; index++) append(f, [{ role: 'user', content: `Repeated MARKER-${index} line` }]);
    const first = searchHistory(f.app.store, f.runId, { query: 'marker', limit: 2 });
    expect(first.totalMatches).toBe(3);
    const second = searchHistory(f.app.store, f.runId, { query: 'marker', limit: 2, cursor: first.next! });
    expect([...first.items, ...second.items].map(item => item.snippet.match(/MARKER-\d/)![0])).toEqual(['MARKER-0', 'MARKER-1', 'MARKER-2']);
    expect(second.next).toBeNull();
  });
});

describe('assembled evidence pointers', () => {
  const body = (label: string): string => `${label} evidence `.repeat(100);
  const round = (id: string, path: string): Message[] => [
    { role: 'assistant', content: `Inspect ${path}`, tool_calls: [{ id, name: 'file.read', arguments: JSON.stringify({ path }) }] },
    { role: 'tool', tool_call_id: id, content: JSON.stringify({ path, hash: id.padEnd(64, 'a').slice(0, 64), content: body(path) }) },
  ];

  it('points hidden evidence at the assembly archive through history.read', () => {
    const f = fixture();
    append(f, [...round('alpha', 'src/alpha.ts'), ...round('beta', 'src/beta.ts'), ...round('gamma', 'src/gamma.ts'), ...round('r1', 'src/r1.ts'), ...round('r2', 'src/r2.ts'), { role: 'user', content: 'Focus on src/alpha.ts.' }]);
    const built = buildContext(f.app.store, f.app.store.run(f.runId), null, [], { maxContextTokens: 131_072, maxOutputTokens: 8_192, assembly: { strategy: 'deterministic', workInputTokens: 65_536, evidenceInputTokens: 1_600 } });
    const hidden = built.messages.filter(message => message.role === 'tool' && message.content.includes('"contextHidden":true')).map(message => JSON.parse(message.content as string) as { read: unknown });
    expect(hidden.length).toBeGreaterThan(0);
    for (const item of hidden) {
      expect(item.read).toMatchObject({ tool: 'history.read', args: { ref: built.assembly!.archivedRef, limit: 1 } });
      expect(Object.keys((item.read as { args: object }).args)).toEqual(['ref', 'offset', 'limit']);
    }
  });
});
