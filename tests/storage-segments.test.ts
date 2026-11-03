import { storageTestConnection } from '../src/storage/test-access.js';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { digest, Store } from '../src/storage/index.js';
import type { Message, ToolSpec } from '../src/runtime/types.js';
import { fixture, temp } from './helpers.js';

const blobFiles = (directory: string): string[] => readdirSync(path.join(directory, 'blobs')).filter(file => /\.(json|blob)$/.test(file));
const blobBytes = (store: Store): number => blobFiles(store.directory).reduce((sum, file) => sum + statSync(path.join(store.directory, 'blobs', file)).size, 0)
  + (storageTestConnection(store).prepare('SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS size FROM blob_segments').get() as { size: number }).size;
/** Whether any stored form (file or segment row) exists for a ref. */
const stored = (store: Store, ref: string): boolean => store.hasBlob(ref);
const round = (index: number): Message[] => [
  { role: 'assistant', content: null, tool_calls: [{ id: `call-${index}`, name: 'file.read', arguments: JSON.stringify({ path: `src/file-${index}.ts` }) }] },
  { role: 'tool', tool_call_id: `call-${index}`, content: JSON.stringify({ path: `src/file-${index}.ts`, content: `export const value${index} = ${index};\n`.repeat(60) }) },
];
const tools: ToolSpec[] = Array.from({ length: 20 }, (_, index) => ({
  name: `probe.tool_${index}`, description: 'Schema text that stays in every request. '.repeat(12),
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}));

describe('segmented content-addressed blobs', () => {
  it('writes only new messages and references per step, so a 42-call run grows linearly', () => {
    const directory = temp();
    const store = new Store(directory);
    try {
      let context: Message[] = [{ role: 'system', content: 'Kernel rules. '.repeat(400) }, { role: 'user', content: 'Inspect every file.' }];
      let legacy = 0;
      for (let step = 0; step < 42; step++) {
        const added = round(step);
        context = [...context, ...added];
        const request = { binding: { model: 'test-model' }, messages: context, tools, maxOutputTokens: 1000 };
        const before = blobBytes(store);
        const contextRef = store.blob(context);
        const requestRef = store.blob(request);
        const written = blobBytes(store) - before;
        // The additive metadata allowance cannot grow with the number of prior messages.
        const fresh = step === 0 ? JSON.stringify(context).length + JSON.stringify(tools).length : JSON.stringify(added).length;
        expect(written).toBeLessThanOrEqual(fresh + (step === 0 ? 5000 : 1600));
        expect(contextRef).toBe(digest(JSON.stringify(context)));
        expect(requestRef).toBe(digest(JSON.stringify(request)));
        expect(store.readBlob(contextRef)).toEqual(context);
        expect(store.readBlob(requestRef)).toEqual(request);
        legacy += JSON.stringify(context).length + JSON.stringify(request).length;
      }
      expect(blobBytes(store)).toBeLessThan(legacy / 8);
    } finally { store.close(); }
  });

  it('reproduces the exact serialized value and stores manifest-like data as ordinary content', () => {
    const directory = temp();
    const store = new Store(directory);
    try {
      const value = { z: 1, messages: Array.from({ length: 40 }, (_, index) => ({ role: 'user', content: `${index} ${'x'.repeat(200)}`, extra: { nested: [index, null, true] } })), a: 'last', '10': 'numeric key' };
      const ref = store.blob(value);
      expect(store.blob(structuredClone(value))).toBe(ref);
      expect(JSON.stringify(store.readBlob(ref))).toBe(JSON.stringify(value));
      const lookalike = { kodoSegmented: 1, items: [ref] };
      const plain = store.blob(lookalike);
      expect(store.readBlob(plain)).toEqual(lookalike);
      // Small values stay in SQLite; larger unsegmented values use durable file payloads.
      const small = store.blob([{ role: 'user', content: 'short' }, { role: 'user', content: 'also short' }]);
      expect(storageTestConnection(store).prepare('SELECT data FROM blob_segments WHERE ref=?').get(small)).toEqual({ data: JSON.stringify([{ role: 'user', content: 'short' }, { role: 'user', content: 'also short' }]) });
      const scalars = Array.from({ length: 2000 }, (_, index) => index);
      expect(readFileSync(path.join(directory, 'blobs', `${store.blob(scalars)}.blob`), 'utf8')).toBe(JSON.stringify(scalars));
    } finally { store.close(); }
  });

  it('verifies segments end to end and still reads legacy single-file blobs', () => {
    const directory = temp();
    const first = new Store(directory);
    const messages = Array.from({ length: 30 }, (_, index) => ({ role: 'tool', tool_call_id: `c${index}`, content: 'evidence '.repeat(40) + index }));
    const ref = first.blob(messages);
    const legacyValue = Array.from({ length: 30 }, (_, index) => ({ role: 'user', content: `legacy ${index} ${'y'.repeat(300)}` }));
    const legacyRef = digest(JSON.stringify(legacyValue));
    writeFileSync(path.join(directory, 'blobs', `${legacyRef}.json`), JSON.stringify(legacyValue));
    const segment = digest(JSON.stringify(messages[7]));
    expect(stored(first, segment)).toBe(true);
    storageTestConnection(first).prepare('UPDATE blob_segments SET data=? WHERE ref=?').run(JSON.stringify({ ...messages[7], content: 'forged' }), segment);
    first.close();
    const reopened = new Store(directory);
    try {
      expect(() => reopened.readBlob(ref)).toThrow('digest mismatch');
      expect(reopened.readBlob(legacyRef)).toEqual(legacyValue);
    } finally { reopened.close(); }
  });

  it('keeps segments of referenced manifests through garbage collection and removes orphaned ones', () => {
    const { app, runId } = fixture();
    const shared = Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `shared ${index} ${'s'.repeat(300)}` }));
    const orphanOnly = Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `orphan ${index} ${'o'.repeat(300)}` }));
    const kept = app.store.blob(shared);
    const orphan = app.store.blob([...shared, ...orphanOnly]);
    app.store.updateRun(runId, { contextRef: kept });
    app.store.gc();
    expect(app.store.readBlob(kept)).toEqual(shared);
    expect(stored(app.store, orphan)).toBe(false);
    for (const message of orphanOnly) expect(stored(app.store, digest(JSON.stringify(message)))).toBe(false);
    for (const message of shared) expect(stored(app.store, digest(JSON.stringify(message)))).toBe(true);
  });

  it('stores sparse replacements and trimming as an overlay and reconstructs it after reopening', () => {
    const directory = temp();
    const store = new Store(directory);
    const original = Array.from({ length: 400 }, (_, index) => ({ role: 'tool', tool_call_id: `c${index}`, content: `Observation ${index}: ${'x'.repeat(100)}` }));
    const ref = store.blob(original);
    const before = blobBytes(store);
    const projected = original.slice(0, -20).map((message, index) => index === 5 ? { ...message, content: 'Masked: read the archived observation.' } : message);
    const changed = store.blob(projected);
    expect(blobBytes(store) - before).toBeLessThan(1600);
    store.close();
    const reopened = new Store(directory);
    try { expect(reopened.readBlob(ref)).toEqual(original); expect(reopened.readBlob(changed)).toEqual(projected); }
    finally { reopened.close(); }
  });

  it('reads an old full reference manifest without rewriting the archived representation', () => {
    const directory = temp();
    const store = new Store(directory);
    const messages = Array.from({ length: 40 }, (_, index) => ({ role: 'user', content: `old message ${index} ${'evidence '.repeat(40)}` }));
    const refs = messages.map(message => store.blob(message));
    const ref = digest(JSON.stringify(messages));
    const oldManifest = JSON.stringify({ 'kodo.blob': 'manifest', value: { 'kodo.segments': refs } });
    storageTestConnection(store).prepare('INSERT INTO blob_segments(ref,data) VALUES (?,?)').run(ref, oldManifest);
    store.close();
    const reopened = new Store(directory);
    try {
      expect(reopened.readBlob(ref)).toEqual(messages);
      expect(reopened.blob(messages)).toBe(ref);
      expect(storageTestConnection(reopened).prepare('SELECT data FROM blob_segments WHERE ref=?').get(ref)).toEqual({ data: oldManifest });
    } finally { reopened.close(); }
  });

  it('does not publish file payloads when the surrounding transaction rolls back', () => {
    const directory = temp();
    const store = new Store(directory);
    try {
      const value = { content: 'large payload '.repeat(1000) };
      const ref = digest(JSON.stringify(value));
      expect(() => store.transaction(() => { store.blob(value); throw new Error('rollback'); })).toThrow('rollback');
      expect(store.hasBlob(ref)).toBe(false);
      expect(() => store.readBlob(ref)).toThrow('missing');
      expect(store.blob(value)).toBe(ref);
      expect(store.readBlob(ref)).toEqual(value);
    } finally { store.close(); }
  });

  it('commits a segmented value with its segments, and a rolled-back transaction leaves neither', () => {
    const directory = temp();
    const store = new Store(directory);
    try {
      const value = Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `rolled back ${index} ${'r'.repeat(300)}` }));
      const ref = digest(JSON.stringify(value));
      expect(() => store.transaction(() => { expect(store.blob(value)).toBe(ref); throw new Error('rollback'); })).toThrow('rollback');
      expect(stored(store, ref)).toBe(false);
      for (const element of value) expect(stored(store, digest(JSON.stringify(element)))).toBe(false);
      // A retry after the rollback must not trust stale existence knowledge.
      expect(store.blob(value)).toBe(ref);
      expect(store.readBlob(ref)).toEqual(value);
      expect(stored(store, ref)).toBe(true);
    } finally { store.close(); }
  });
});
