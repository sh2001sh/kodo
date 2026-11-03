import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { attachment, attachmentBody, attachmentKind } from '../src/runtime/attachments.js';
import { createInputTokenEstimator } from '../src/runtime/context-tokens.js';
import { summarizeContext } from '../src/runtime/compaction.js';
import { HostHooks } from '../src/runtime/hooks.js';
import { runMemory } from '../src/runtime/memory.js';
import { runBudget } from '../src/runtime/run-budget.js';
import { Store } from '../src/storage/index.js';
import { fixture } from './helpers.js';
import { append, build, contextOf, handoff, longText, rounds, summarize, textResponse } from './summary-helpers.js';

type Restoration = { files: { path: string; status: string; complete: boolean; tokens: number }[]; budget: number; usedTokens: number; candidates: string[] };

describe('budgeted file restoration after summary installation', () => {
  it('restores matching current file content and keeps prefix bytes and the install target', async () => {
    const f = fixture();
    const content = 'The accepted page size is 37.\n';
    writeFileSync(path.join(f.root, '0.txt'), content);
    await f.app.coordinator.tools.execute(f.runId, 'file.read', { path: '0.txt' }, new AbortController().signal);
    const prefix = contextOf(f);
    append(f, rounds(30));
    const built = build(f);
    expect(await summarize(f, { async complete() { return textResponse(); } }, built)).toBe(true);
    const context = contextOf(f);
    expect(context.slice(0, prefix.length)).toEqual(prefix);
    const notice = context.find(message => attachmentKind(message) === 'compaction')!;
    const decoded = JSON.parse(attachmentBody(notice)) as { files: { path: string; excerpt: string; complete: boolean }[] };
    expect(decoded.files).toContainEqual(expect.objectContaining({ path: '0.txt', excerpt: content, complete: true }));
    const event = f.app.store.latestEvent(f.runId, { types: ['context.summary.installed'] })!;
    const restoration = event.data.restoration as Restoration;
    expect(restoration.usedTokens).toBeGreaterThan(0);
    expect(restoration.usedTokens).toBeLessThanOrEqual(restoration.budget);
    expect(createInputTokenEstimator(f.app.store, f.app.store.run(f.runId), []).estimate(context)).toBeLessThanOrEqual(Number(event.data.installTargetTokens));
  });

  it('lists changed files without restoring stale excerpts', async () => {
    const f = fixture();
    const file = path.join(f.root, '0.txt');
    writeFileSync(file, 'old observation');
    await f.app.coordinator.tools.execute(f.runId, 'file.read', { path: '0.txt' }, new AbortController().signal);
    writeFileSync(file, 'new external content');
    append(f, rounds(30));
    expect(await summarize(f, { async complete() { return textResponse(); } }, build(f))).toBe(true);
    const notice = contextOf(f).find(message => attachmentKind(message) === 'compaction')!;
    expect(attachmentBody(notice)).toContain('"status":"changed"');
    expect(attachmentBody(notice)).not.toContain('new external content');
    expect(attachmentBody(notice)).not.toContain('old observation');
  });

  it('bounds large file excerpts and leaves only durable paths when no recovery budget remains', async () => {
    const f = fixture();
    writeFileSync(path.join(f.root, '0.txt'), 'Known content. '.repeat(20_000));
    await f.app.coordinator.tools.execute(f.runId, 'file.read', { path: '0.txt' }, new AbortController().signal);
    append(f, rounds(30));
    expect(await summarize(f, { async complete() { return textResponse(); } }, build(f))).toBe(true);
    const first = f.app.store.latestEvent(f.runId, { types: ['context.summary.installed'] })!;
    const restored = first.data.restoration as Restoration;
    expect(restored.files).toContainEqual(expect.objectContaining({ path: '0.txt', status: 'restored', complete: false }));
    expect(restored.usedTokens).toBeLessThanOrEqual(restored.budget);
    append(f, rounds(30, 'next'));
    expect(await summarize(f, { async complete() { return textResponse(longText(12_000)); } }, build(f))).toBe(true);
    const final = f.app.store.latestEvent(f.runId, { types: ['context.summary.installed'] })!.data.restoration as Restoration;
    expect(final.budget).toBe(0);
    expect(final.usedTokens).toBe(0);
    expect(final.candidates).toContain('0.txt');
  });
});

describe('persistent compaction memory and hooks', () => {
  it('keeps environment revisions byte-stable during masking and collapses them only on full summary installation', async () => {
    const f = fixture();
    const old = attachment('environment', 'Decision version: 1');
    const current = attachment('environment', 'Decision version: 2');
    append(f, [old, ...rounds(30), current]);
    const masked = build(f, 16_000, 'mask');
    expect(masked.messages.filter(message => attachmentKind(message) === 'environment')).toEqual([old, current]);
    expect(await summarize(f, { async complete() { return textResponse(); } }, build(f))).toBe(true);
    expect(contextOf(f).filter(message => attachmentKind(message) === 'environment')).toEqual([current]);
    const context = contextOf(f);
    expect(context.indexOf(context.find(message => attachmentKind(message) === 'environment')!))
      .toBeLessThan(context.findIndex(message => message.role === 'user' && attachmentKind(message) === undefined));
  });

  it('keeps decisions and lessons through a later summary and restart', async () => {
    const f = fixture();
    const text = 'Goal: finish.\nKey decisions and reasons:\nKeep the public schema because existing clients use it.\nFailed attempts and reasons:\nThe broad rewrite lost ordering; use the scoped patch.\nNext step: verify.';
    append(f, rounds(30));
    expect(await summarize(f, { async complete() { return textResponse(text); } }, build(f))).toBe(true);
    const memory = runMemory(f.app.store, f.runId)!;
    expect(memory.decisions).toContain('Keep the public schema because existing clients use it.');
    expect(memory.lessons).toContain('The broad rewrite lost ordering; use the scoped patch.');
    append(f, rounds(30, 'later'));
    expect(await summarize(f, { async complete() { return textResponse(handoff); } }, build(f))).toBe(true);
    expect(runMemory(f.app.store, f.runId)).toEqual(memory);
    const directory = f.app.store.directory;
    await f.app.shutdown();
    const restarted = new Store(directory);
    try { expect(runMemory(restarted, f.runId)).toEqual(memory); }
    finally { restarted.close(); }
  });

  it('passes before context to the summary and preserves after notes in durable context', async () => {
    const f = fixture();
    append(f, rounds(30));
    const hooks = new HostHooks(f.app.store, [
      { kind: 'compaction.before', callback: () => ({ note: 'Retain the exact migration command.' }) },
      { kind: 'compaction.after', callback: () => ({ note: 'Review the current integration result.' }) },
    ]);
    const run = f.app.store.run(f.runId);
    expect(await summarizeContext({
      store: f.app.store, run, built: build(f), budget: runBudget(run, f.app.store.session(run.sessionId)), tools: [], signal: new AbortController().signal, hooks,
      provider: { async complete(request) { expect(request.messages.at(-1)?.content).toContain('Retain the exact migration command.'); return textResponse(); } },
    })).toBe(true);
    expect(JSON.stringify(contextOf(f))).toContain('Review the current integration result.');
    expect(f.app.store.events(f.runId, { types: ['hook.finished'] })).toHaveLength(2);
  });
});
