import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Store, unlockData } from '../src/storage/index.js';
import { defaultCard, parseCard } from '../src/agents/card.js';
import { fixture, temp } from './helpers.js';

describe('durable storage', () => {
  it('commits state and events together; rolled-back events are never published', () => {
    const { app, runId } = fixture();
    const observed: string[] = [];
    app.store.subscribe(event => observed.push(event.type));
    expect(() => app.store.transaction(() => {
      app.store.updateRun(runId, { status: 'completed' });
      app.store.event(runId, 'run.completed');
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(app.store.run(runId).status).toBe('queued');
    expect(observed).toEqual([]);
    expect(app.store.events(runId).map(x => x.type)).toEqual(['run.queued']);
  });
  it('verifies stored content digests and rejects arbitrary blob paths', () => {
    const { app } = fixture();
    const ref = app.store.blob({ text: 'original' });
    writeFileSync(path.join(app.store.directory, 'blobs', `${ref}.json`), '{}');
    expect(() => app.store.readBlob(ref)).toThrow('digest mismatch');
    expect(() => app.store.readBlob('../owner.lock')).toThrow('invalid content reference');
  });
  it('supports Chinese trigram search', () => {
    const { app } = fixture();
    expect(app.store.probeSearch()).toBe(true);
  });
  it('migrates a v1 database while preserving existing runs and budgets', () => {
    const { app, runId } = fixture();
    const directory = app.store.directory;
    const previous = app.store.run(runId);
    app.store.db.exec('DROP TABLE messages; DROP TABLE waits; DROP TABLE decisions; ALTER TABLE artifacts DROP COLUMN decision_version; PRAGMA user_version = 1;');
    const session = app.store.session(previous.sessionId);
    const legacyBudget = { ...session.budget } as Partial<typeof session.budget>;
    delete legacyBudget.maxChildren;
    delete legacyBudget.maxConcurrentModels;
    app.store.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify({ ...session, budget: legacyBudget }), session.id);
    app.close();
    const migrated = new Store(directory);
    try {
      expect(migrated.db.pragma('user_version', { simple: true })).toBe(3);
      expect(migrated.run(runId)).toEqual(previous);
      expect(migrated.messages(session.id)).toEqual([]);
      expect(migrated.waits()).toEqual([]);
      expect(migrated.session(session.id).budget).toMatchObject({ maxChildren: 8, maxConcurrentModels: 2, maxTokens: session.budget.maxTokens });
    } finally { migrated.close(); }
  });
  it('rejects a second owner and refuses to unlock a live owner', () => {
    const { app } = fixture();
    expect(() => new Store(app.store.directory)).toThrow('owned');
    expect(() => unlockData(app.store.directory)).toThrow('still alive');
  });
  it('requires explicit stale-lock repair and preserves an unknown owner', () => {
    const root = temp();
    writeFileSync(path.join(root, 'owner.lock'), JSON.stringify({ pid: -1 }));
    expect(() => unlockData(root)).toThrow('cannot verify');
    expect(readFileSync(path.join(root, 'owner.lock'), 'utf8')).toContain('-1');
  });
  it('pins immutable card versions', () => {
    const { app } = fixture();
    expect(() => app.store.registerCard({ ...defaultCard, digest: 'different' })).toThrow('different content');
    app.store.registerCard(defaultCard);
  });
  it('rejects malformed cards and unsupported executable resources', () => {
    expect(() => parseCard('not a card')).toThrow('front matter');
    const source = '---\nschema_version: 1\nid: local/test\nversion: 1.0.0\nname: test\ndescription: test\ncapabilities:\n  tools: []\n  local_tools: [evil.ts]\n---\nprompt';
    expect(() => parseCard(source)).toThrow('supports built-in tools only');
    expect(() => parseCard(source.replace('schema_version: 1', 'schema_version: 2'))).toThrow();
    expect(() => parseCard(source.replace('name: test', 'name: test\nname: duplicate'))).toThrow('duplicate keys');
  });
});
