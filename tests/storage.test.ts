import { storageTestConnection } from '../src/storage/test-access.js';
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { Store, unlockData } from '../src/storage/index.js';
import { parseCard } from '../src/agents/card.js';
import { answer, fixture, scripted, temp } from './helpers.js';

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
    storageTestConnection(app.store).prepare('UPDATE blob_segments SET data=? WHERE ref=?').run('{}', ref);
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
    storageTestConnection(app.store).exec('DROP TABLE messages; DROP TABLE waits; DROP TABLE decisions; ALTER TABLE artifacts DROP COLUMN decision_version; PRAGMA user_version = 1;');
    const session = app.store.session(previous.sessionId);
    const legacyBudget = { ...session.budget } as Partial<typeof session.budget>;
    delete legacyBudget.maxChildren;
    delete legacyBudget.maxActiveChildren;
    delete legacyBudget.maxConcurrentModels;
    storageTestConnection(app.store).prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify({ ...session, budget: legacyBudget }), session.id);
    app.close();
    const migrated = new Store(directory);
    try {
      expect(storageTestConnection(migrated).pragma('user_version', { simple: true })).toBe(7);
      expect(migrated.run(runId)).toEqual(previous);
      expect(migrated.messages(session.id)).toEqual([]);
      expect(migrated.waits()).toEqual([]);
      expect(migrated.session(session.id).budget).toMatchObject({ maxChildren: 8, maxConcurrentModels: 2, maxTokens: session.budget.maxTokens });
      expect(migrated.session(session.id).budget.maxActiveChildren).toBeUndefined();
    } finally { migrated.close(); }
  });
  it('preserves child budget defaults and legacy limits across restart', () => {
    const { app, runId } = fixture();
    const directory = app.store.directory;
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    expect(session.budget).toMatchObject({ maxChildren: null, maxActiveChildren: 8, maxConcurrentModels: 2 });
    app.close();
    const reopened = new Store(directory);
    try {
      expect(reopened.session(session.id).budget).toMatchObject({ maxChildren: null, maxActiveChildren: 8 });
      const legacyBudget = { ...session.budget, maxChildren: 3 };
      delete legacyBudget.maxActiveChildren;
      reopened.putSession({ ...session, budget: legacyBudget });
      expect(reopened.session(session.id).budget).toMatchObject({ maxChildren: 3 });
      expect(reopened.session(session.id).budget.maxActiveChildren).toBeUndefined();
      const legacy = { ...legacyBudget } as Partial<typeof legacyBudget>;
      delete legacy.maxChildren;
      storageTestConnection(reopened).prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify({ ...session, budget: legacy }), session.id);
      expect(reopened.session(session.id).budget).toMatchObject({ maxChildren: 8 });
      expect(reopened.session(session.id).budget.maxActiveChildren).toBeUndefined();
    } finally { reopened.close(); }
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
    const { app, runId } = fixture();
    const card = app.store.run(runId).card;
    expect(() => app.store.registerCard({ ...card, digest: 'different' })).toThrow('different content');
    app.store.registerCard(card);
  });
  it('rejects malformed cards and unsupported executable resources', () => {
    expect(() => parseCard('not a card')).toThrow('front matter');
    const source = '---\nschema_version: 1\nid: local/test\nversion: 1.0.0\nname: test\ndescription: test\ncapabilities:\n  tools: []\n  local_tools: [evil.ts]\n---\nprompt';
    expect(() => parseCard(source)).toThrow('supports built-in tools only');
    expect(() => parseCard(source.replace('schema_version: 1', 'schema_version: 2'))).toThrow();
    expect(() => parseCard(source.replace('name: test', 'name: test\nname: duplicate'))).toThrow('duplicate keys');
  });
  it('creates the knowledge_nodes catalog with durable constraints across an application restart', async () => {
    const { app, runId } = fixture();
    const directory = app.store.directory;
    const required = ['project_id', 'id', 'parent_id', 'kind', 'title', 'knowledge_id'];
    const tableColumns = (database: ReturnType<typeof storageTestConnection>): string[] => (database.pragma('table_info(knowledge_nodes)') as { name: string }[]).map(column => column.name);
    expect(tableColumns(storageTestConnection(app.store))).toEqual(required);
    // The primary key and the same-project knowledge uniqueness are both enforced by unique indexes.
    const indexes = storageTestConnection(app.store).pragma('index_list(knowledge_nodes)') as { name: string; unique: number }[];
    expect(indexes.filter(index => index.unique === 1).length).toBeGreaterThanOrEqual(2);
    expect(storageTestConnection(app.store).pragma('foreign_key_list(knowledge_nodes)')).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'knowledge_projects', from: 'project_id', to: 'id' }),
      expect.objectContaining({ table: 'knowledge_nodes', from: 'parent_id', to: 'id' }),
    ]));
    expect(storageTestConnection(app.store).pragma('foreign_keys', { simple: true })).toBe(1);
    storageTestConnection(app.store).prepare("INSERT INTO knowledge_projects(id,owner_id,workspace) VALUES ('project-schema','owner','/workspace')").run();
    const insert = storageTestConnection(app.store).prepare('INSERT INTO knowledge_nodes(project_id,id,parent_id,kind,title,knowledge_id) VALUES (?,?,?,?,?,?)');
    expect(() => insert.run('project-schema', 'folder-root', null, 'folder', 'Protocols', null)).not.toThrow();
    expect(() => insert.run('project-schema', 'bad-kind', null, 'invalid', 'bad', null)).toThrow(/constraint failed/);
    expect(() => insert.run('project-schema', 'entry-without-knowledge', null, 'entry', 'bad', null)).toThrow(/constraint failed/);
    expect(() => insert.run('project-schema', 'folder-with-knowledge', null, 'folder', 'bad', 'contract')).toThrow(/constraint failed/);
    expect(() => insert.run('missing-project', 'orphan-project', null, 'folder', 'bad', null)).toThrow(/constraint failed/);
    expect(() => insert.run('project-schema', 'orphan-parent', 'missing-folder', 'folder', 'bad', null)).toThrow(/constraint failed/);
    expect(() => insert.run('project-schema', 'folder-root', null, 'folder', 'Duplicate', null)).toThrow(/constraint failed/);
    insert.run('project-schema', 'entry-contract', 'folder-root', 'entry', 'Contract', 'contract');
    expect(storageTestConnection(app.store).prepare("SELECT COUNT(*) AS count FROM knowledge_nodes WHERE project_id='project-schema'").get()).toEqual({ count: 2 });
    await app.shutdown();
    const reopened = new Application(directory, scripted(answer()));
    try {
      expect(storageTestConnection(reopened.store).pragma('user_version', { simple: true })).toBe(7);
      expect(tableColumns(storageTestConnection(reopened.store))).toEqual(required);
      expect(storageTestConnection(reopened.store).pragma('foreign_keys', { simple: true })).toBe(1);
      expect(storageTestConnection(reopened.store).prepare("SELECT id,parent_id AS parentId,kind,title,knowledge_id AS knowledgeId FROM knowledge_nodes WHERE project_id='project-schema' ORDER BY id").all()).toEqual([
        { id: 'entry-contract', parentId: 'folder-root', kind: 'entry', title: 'Contract', knowledgeId: 'contract' },
        { id: 'folder-root', parentId: null, kind: 'folder', title: 'Protocols', knowledgeId: null },
      ]);
      expect(() => storageTestConnection(reopened.store).prepare('INSERT INTO knowledge_nodes(project_id,id,parent_id,kind,title,knowledge_id) VALUES (?,?,?,?,?,?)').run('project-schema', 'bad-after-restart', null, 'entry', 'bad', null)).toThrow(/constraint failed/);
      const knowledge = reopened.coordinator.knowledge;
      expect(knowledge).toBeDefined();
      const folder = knowledge!.createFolder(runId, 'After restart');
      expect(knowledge!.browse(runId, {}, true).items.map(item => item.id)).toContain(folder.id);
    } finally { await reopened.shutdown(); }
  });
});
