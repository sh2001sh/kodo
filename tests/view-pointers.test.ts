import { describe, expect, it } from 'vitest';
import { historyReadCall, historyReadPointer, historySearchName, leanProfile, parseHistoryPointer } from '../src/runtime/view-pointers.js';
import { maskToolMessage, prunedMarker, pruneToolMessage } from '../src/runtime/tool-result-prune.js';
import type { ToolResultSource } from '../src/runtime/tool-result-prune.js';
import { summaryMarker } from '../src/runtime/summary-schema.js';
import { summaryPrefix, buildContext } from '../src/runtime/context.js';
import type { HistorySnapshot } from '../src/runtime/context.js';
import { readHistory, searchHistory } from '../src/runtime/history.js';
import type { Message, Session } from '../src/runtime/types.js';
import { fixture } from './helpers.js';

const ref = 'a'.repeat(64);
const profiles = [undefined, 'full', 'compact-v1', 'compact-v2'] as const;

/** Freeze a profile on the fixture session; the cast tolerates the not-yet-widened profile type. */
function setProfile(f: ReturnType<typeof fixture>, profile: string | undefined): void {
  const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
  f.app.store.putSession({ ...session, toolProfile: profile } as Session);
}

function append(f: ReturnType<typeof fixture>, messages: Message[]): void {
  const run = f.app.store.run(f.runId);
  f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob([...f.app.store.readBlob<Message[]>(run.contextRef), ...messages]) });
}

describe('view pointer helpers', () => {
  it('detects lean profiles only', () => {
    expect([...profiles, 'lean-solo'].map(leanProfile)).toEqual([false, false, false, false, true]);
  });

  it('keeps the old pointer object as given and renders lean read with stable key order', () => {
    const args = { ref, offset: 3, contentOffset: 9, limit: 1, maxChars: 4000 };
    for (const profile of profiles) {
      const pointer = historyReadPointer(profile, args);
      expect(pointer).toEqual({ tool: 'history.read', args });
      expect(pointer.args).toBe(args);
    }
    expect(JSON.stringify(historyReadPointer('lean-solo', args))).toBe(`{"tool":"read","args":{"history":"${ref}","offset":3,"contentOffset":9,"limit":1,"maxChars":4000}}`);
  });

  it('parses both pointer shapes and rejects malformed ones', () => {
    expect(parseHistoryPointer({ tool: 'history.read', args: { ref, offset: 2, limit: 1 } })).toEqual({ ref, offset: 2 });
    expect(parseHistoryPointer({ tool: 'read', args: { history: ref, offset: 0 } })).toEqual({ ref, offset: 0 });
    for (const bad of [undefined, null, 'x', {}, { tool: 'read', args: { path: 'a.ts', offset: 1 } }, { tool: 'history.read', args: { history: ref, offset: 1 } },
      { tool: 'read', args: { ref, offset: 1 } }, { tool: 'history.read', args: { ref, offset: -1 } }, { tool: 'history.read', args: { ref, offset: 1.5 } }, { tool: 'file.read', args: { ref, offset: 1 } }]) {
      expect(parseHistoryPointer(bad)).toBeUndefined();
    }
  });

  it('names prose calls for the view', () => {
    expect(historySearchName(undefined)).toBe('history.search');
    expect(historySearchName('lean-solo')).toBe('read with history_query');
    expect(historyReadCall('compact-v2', ref, 4)).toBe(`history.read({"ref":"${ref}","offset":4})`);
    expect(historyReadCall('lean-solo', ref, 4)).toBe(`read({"history":"${ref}","offset":4})`);
  });
});

describe('pointer producers', () => {
  const big: Message = { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(9000) };
  const source = (profile?: string): ToolResultSource => ({ archivedRef: ref, offsetOf: () => 7, call: () => undefined, ...(profile ? { profile } : {}) });

  it('prune keeps the old literal and renders lean read', () => {
    const tail = `${prunedMarker} 3880 characters omitted from model input, not deleted; full result: `;
    for (const profile of profiles) {
      expect(pruneToolMessage(big, source(profile))!.content).toBe(`${'x'.repeat(4096)}\n${tail}{"tool":"history.read","args":{"ref":"${ref}","offset":7,"limit":1}}\n${'x'.repeat(1024)}`);
    }
    expect(pruneToolMessage(big, source('lean-solo'))!.content).toBe(`${'x'.repeat(4096)}\n${tail}{"tool":"read","args":{"history":"${ref}","offset":7,"limit":1}}\n${'x'.repeat(1024)}`);
  });

  it('mask keeps the old literal and renders lean read', () => {
    const group: Message[] = [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'file.read', arguments: '{}' }] }, big];
    const masked = (profile?: string) => JSON.parse(maskToolMessage(big, group, source(profile))!.content) as Record<string, unknown>;
    const old = masked();
    expect(old.read).toEqual({ tool: 'history.read', args: { ref, offset: 7, limit: 1 } });
    expect(Object.keys(old)).toEqual(['contextHidden', 'tool', 'callId', 'status', 'preview', 'originalChars', 'coverage', 'read', 'note']);
    for (const profile of profiles) expect(maskToolMessage(big, group, source(profile))!.content).toBe(maskToolMessage(big, group, source())!.content);
    expect(masked('lean-solo')).toEqual({ ...old, read: { tool: 'read', args: { history: ref, offset: 7, limit: 1 } } });
  });

  it('summary marker keeps the old prose and names lean read', () => {
    const input = { text: 'Goal: x', archivedRef: ref, coveredOffsets: [2, 3, 9], droppedGroups: 0 };
    const old = `${summaryPrefix}Goal: x\n\n[Archive] Summarized messages 2-9 remain verbatim: page them with history.read({"ref":"${ref}","offset":2}) and use history.search to find exact details instead of repeating work.`;
    expect(summaryMarker(input)).toBe(old);
    for (const profile of profiles) expect(summaryMarker({ ...input, ...(profile ? { profile } : {}) })).toBe(old);
    expect(summaryMarker({ ...input, profile: 'lean-solo' })).toBe(`${summaryPrefix}Goal: x\n\n[Archive] Summarized messages 2-9 remain verbatim: page them with read({"history":"${ref}","offset":2}) and use read with history_query to find exact details instead of repeating work.`);
  });
});

describe('history pointers follow the requester session profile', () => {
  const archive = (f: ReturnType<typeof fixture>): string => {
    const run = f.app.store.run(f.runId);
    const snapshot: HistorySnapshot = { version: 1, runId: run.id, sessionId: run.sessionId, messages: [{ role: 'user', content: 'needle-token here' }] };
    const archived = f.app.store.blob(snapshot);
    f.app.store.event(f.runId, 'context.compacted', { archivedRef: archived });
    return archived;
  };

  it.each([undefined, 'full', 'lean-solo'])('readHistory and searchHistory render for %s', profile => {
    const f = fixture();
    const archived = archive(f);
    setProfile(f, profile);
    const options = { ref: archived, offset: 0, limit: 1 };
    const read = readHistory(f.app.store, f.runId, options).source.read;
    const hit = searchHistory(f.app.store, f.runId, { query: 'needle-token' }).items.find(item => item.source.kind === 'history');
    if (profile === 'lean-solo') {
      expect(read).toEqual({ tool: 'read', args: { history: archived, offset: 0, limit: 1 } });
      expect(hit?.read).toEqual({ tool: 'read', args: { history: archived, offset: 0, contentOffset: 0, limit: 1, maxChars: 4000 } });
    } else {
      expect(read).toEqual({ tool: 'history.read', args: options });
      expect(hit?.read).toEqual({ tool: 'history.read', args: { ref: archived, offset: 0, contentOffset: 0, limit: 1, maxChars: 4000 } });
    }
  });
});

describe('assembled evidence pointers', () => {
  const body = (label: string): string => `${label} evidence `.repeat(100);
  const round = (id: string, path: string): Message[] => [
    { role: 'assistant', content: `Inspect ${path}`, tool_calls: [{ id, name: 'file.read', arguments: JSON.stringify({ path }) }] },
    { role: 'tool', tool_call_id: id, content: JSON.stringify({ path, hash: id.padEnd(64, 'a').slice(0, 64), content: body(path) }) },
  ];
  const assembled = (profile: string | undefined) => {
    const f = fixture();
    setProfile(f, profile);
    append(f, [...round('alpha', 'src/alpha.ts'), ...round('beta', 'src/beta.ts'), ...round('gamma', 'src/gamma.ts'), ...round('r1', 'src/r1.ts'), ...round('r2', 'src/r2.ts'), { role: 'user', content: 'Focus on src/alpha.ts.' }]);
    const built = buildContext(f.app.store, f.app.store.run(f.runId), null, [], { maxContextTokens: 131_072, maxOutputTokens: 8_192, assembly: { strategy: 'deterministic', workInputTokens: 65_536, evidenceInputTokens: 1_600 } });
    const hidden = built.messages.filter(message => message.role === 'tool' && message.content.includes('"contextHidden":true')).map(message => JSON.parse(message.content as string) as { read: unknown });
    return { built, hidden };
  };

  it('keeps kernel pointers for old profiles and renders lean read for lean-solo', () => {
    const old = assembled(undefined);
    expect(old.hidden.length).toBeGreaterThan(0);
    const archivedRef = old.built.assembly!.archivedRef;
    for (const item of old.hidden) expect(item.read).toMatchObject({ tool: 'history.read', args: { ref: archivedRef, limit: 1 } });
    const lean = assembled('lean-solo');
    expect(lean.hidden.length).toBe(old.hidden.length);
    for (const item of lean.hidden) {
      expect(item.read).toMatchObject({ tool: 'read', args: { history: lean.built.assembly!.archivedRef, limit: 1 } });
      expect(Object.keys((item.read as { args: object }).args)).toEqual(['history', 'offset', 'limit']);
    }
    expect(lean.built.assembly!.hiddenOffsets).toEqual(old.built.assembly!.hiddenOffsets);
  });
});
