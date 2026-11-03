import { storageTestConnection } from '../src/storage/test-access.js';
import { describe, expect, it } from 'vitest';
import { parseCard } from '../src/agents/card.js';
import { cardDirectoryTool, cardSearchTool, directoryCards, searchCards } from '../src/agents/discovery.js';
import { cardRoutingTool, routeCards } from '../src/agents/routing.js';
import { Store } from '../src/storage/index.js';
import { fixture as applicationFixture } from './helpers.js';

/** This suite preserves the installed-registry protocol for pre-roster sessions. */
function fixture() {
  const result = applicationFixture(undefined, ['read', 'write'], { agentFactors: { A: false, B: false, C: false } });
  const sessionId = result.app.store.run(result.runId).sessionId;
  storageTestConnection(result.app.store).prepare('DELETE FROM roster_snapshots WHERE session_id=?').run(sessionId);
  return result;
}

function install(store: Store, id: string, description: string, version = '1.0.0', tools = ['file.read'], name = id): void {
  store.registerCard(parseCard(`---
schema_version: 1
id: ${id}
version: ${version}
name: ${name}
description: ${description}
capabilities:
  tools: ${JSON.stringify(tools)}
---
Secret prompt must never be indexed or returned.`, { toolNames: tools }));
}

function context(store: Store, runId: string) {
  const run = store.run(runId);
  return { run, session: store.session(run.sessionId), signal: new AbortController().signal, markEffectStarted() {} };
}

describe('indexed metadata discovery and routing', () => {
  it('builds a trigram index from existing cards, follows later inserts/deletes and excludes prompts', () => {
    const { app } = fixture();
    install(app.store, 'test/sql', '数据库 query planning');
    expect(searchCards(app.store, { query: '数据库' }).cards.map(card => card.id)).toEqual(['test/sql']);
    const definition = storageTestConnection(app.store).prepare("SELECT sql FROM sqlite_master WHERE name='agent_metadata_fts'").get() as { sql: string };
    expect(definition.sql).toContain("tokenize='trigram'");
    install(app.store, 'test/after', '数据库 migrations');
    expect(searchCards(app.store, { query: '数据库' }).cards).toHaveLength(2);
    storageTestConnection(app.store).prepare('DELETE FROM card_versions WHERE id=?').run('test/after');
    expect(searchCards(app.store, { query: '数据库' }).cards).toHaveLength(1);
    expect(searchCards(app.store, { query: 'Secret prompt' }).cards).toEqual([]);
    expect(storageTestConnection(app.store).prepare('SELECT rowid FROM agent_metadata_fts WHERE agent_metadata_fts MATCH ?').all('"Secret"')).toEqual([]);
  });

  it('supports Chinese one/two-character queries, mixed short terms, literal operators and relevance ordering', () => {
    const { app } = fixture();
    install(app.store, 'test/sql', '数据库 performance SQL', '1.0.0', ['file.read']);
    install(app.store, 'test/other', 'Read sql specifications and 数据索引');
    expect(searchCards(app.store, { query: '库' }).cards.map(card => card.id)).toEqual(['test/sql']);
    expect(searchCards(app.store, { query: '数据' }).cards).toHaveLength(2);
    expect(searchCards(app.store, { query: 'SQL 库' }).cards.map(card => card.id)).toEqual(['test/sql']);
    install(app.store, 'test/name', 'A specialist', '1.0.0', ['file.read'], 'SQL');
    expect(searchCards(app.store, { query: 'SQL' }).cards[0]?.id).toBe('test/name');
    expect(searchCards(app.store, { query: 'test/s' }).cards[0]?.id).toBe('test/sql');
    for (const query of ['" OR "', 'NEAR(sql)', '%', 'sql NOT data', 'sql*', "' OR 1=1 --"]) expect(searchCards(app.store, { query }).cards).toEqual([]);
    expect(searchCards(app.store, { query: '_' }).cards.every(card => card.tools.some(tool => tool.includes('_')))).toBe(true);
    expect(searchCards(app.store, { query: 'sql', tools: ['file.patch'] }).cards).toEqual([]);
    expect(searchCards(app.store, { query: 'file.read sql' }).cards.map(card => card.id)).toContain('test/sql');
  });

  it('pages the namespace directory independently of vocabulary and preserves immutable versions', () => {
    const { app } = fixture();
    install(app.store, 'alpha/sql', 'Database specialist');
    install(app.store, 'alpha/sql', 'Database specialist v2', '2.0.0');
    install(app.store, 'zulu/read', 'Document specialist');
    const first = directoryCards(app.store, { limit: 1 });
    expect(first).toEqual({ namespaces: [{ namespace: 'alpha', agents: 1, versions: 2 }], cards: [], next: { offset: 1 } });
    expect(directoryCards(app.store, { limit: 1, ...first.next! }).namespaces[0]?.namespace).toBe('builtin');
    const versions = directoryCards(app.store, { namespace: 'alpha', limit: 1 });
    expect(versions.namespaces).toEqual([{ namespace: 'alpha', agents: 1, versions: 2 }]);
    expect(versions.cards[0]).toMatchObject({ id: 'alpha/sql', version: '1.0.0', digest: expect.any(String) });
    expect(directoryCards(app.store, { namespace: 'alpha', limit: 1, ...versions.next! }).cards[0]?.version).toBe('2.0.0');
    expect(directoryCards(app.store, { namespace: 'missing' })).toEqual({ namespaces: [], cards: [], next: null });
    expect(directoryCards(app.store, { tools: ['not.installed'] }).namespaces).toEqual([]);
    expect(() => directoryCards(app.store, { namespace: 'alpha/%' })).toThrow('namespace');
  });

  it('routes distinct candidates, picks numeric latest versions and honours only immutable host preferences', () => {
    const { app } = fixture();
    install(app.store, 'test/review', 'Review TypeScript boundaries', '1.9.0');
    install(app.store, 'test/review', 'Review TypeScript boundaries', '1.10.0');
    install(app.store, 'test/extra', 'Review TypeScript workflows');
    const result = routeCards(app.store, { query: 'review typescript', tools: ['file.read'] });
    expect(result.cards.map(card => card.id)).toEqual(expect.arrayContaining(['test/review', 'test/extra']));
    expect(result.cards.find(card => card.id === 'test/review')).toMatchObject({ version: '1.10.0', versionSelection: 'newest_matching_installed', authorization: 'not_checked', missingTools: [] });
    expect(result.cards[0]?.reasons.some(reason => reason.includes('description:'))).toBe(true);
    const old = app.store.card('test/review', '1.9.0');
    expect(routeCards(app.store, { query: 'typescript' }, { preferredVersions: [{ id: old.id, version: old.version, digest: old.digest }] }).cards[0]).toMatchObject({ id: old.id, version: old.version, versionSelection: 'host_preferred' });
    expect(routeCards(app.store, { query: 'typescript' }, { preferredVersions: [{ id: old.id, version: old.version, digest: 'wrong-digest' }] }).cards.find(card => card.id === old.id)?.version).toBe('1.10.0');
    expect(JSON.stringify(result)).not.toContain('Secret prompt');
    expect(() => routeCards(app.store, { query: ' ' })).toThrow('nonempty');
    expect(() => routeCards(app.store, { query: 'sql', limit: 21 })).toThrow('1-20');
  });

  it('exposes partial matches and capability gaps without claiming suitability or permission', () => {
    const { app } = fixture();
    install(app.store, 'test/review', 'Review TypeScript boundaries');
    const result = routeCards(app.store, { query: 'review unavailable-specialty', tools: ['file.patch'], skills: ['missing-skill'] });
    expect(result.retrieval).toBe('partial_terms');
    expect(result.cards[0]).toMatchObject({ id: 'test/review', missingTools: ['file.patch'], missingSkills: ['missing-skill'], authorization: 'not_checked' });
    expect(result.unresolved.join(' ')).toContain('may be unsuitable');
    expect(routeCards(app.store, { query: 'absent-vocabulary' })).toMatchObject({ cards: [], retrieval: 'none' });
  });

  it('shares durable exploration calls across search/directory/route and distinguishes exhaustion from no match', async () => {
    const { app, runId } = fixture();
    install(app.store, 'test/review', 'Review source');
    const policy = { maxCalls: 2, maxCards: 10 };
    expect(await cardSearchTool(app.store, policy).execute(context(app.store, runId), { query: 'absent' })).toMatchObject({ status: 'no_match', budget: { callsUsed: 1, cardsUsed: 0 } });
    expect(await cardDirectoryTool(app.store, policy).execute(context(app.store, runId), { namespace: 'test' })).toMatchObject({ status: 'matched', budget: { callsUsed: 2, cardsUsed: 1 } });
    expect(await cardRoutingTool(app.store, policy).execute(context(app.store, runId), { query: 'review' })).toMatchObject({ status: 'budget_exhausted', cards: [], budget: { callsRemaining: 0 } });
    // Host read/search remains stateless after the model's allowance is exhausted.
    expect(searchCards(app.store, { query: 'review' }).cards).toHaveLength(1);
    const directory = app.store.directory;
    await app.shutdown();
    const reopened = new Store(directory);
    try {
      // Raising registration defaults cannot reset the persisted session allowance.
      expect(await cardSearchTool(reopened, { maxCalls: 20, maxCards: 100 }).execute(context(reopened, runId), { query: 'review' })).toMatchObject({ status: 'budget_exhausted', budget: { maxCalls: 2, callsUsed: 2 } });
      expect(searchCards(reopened, { query: 'review' }).cards[0]?.id).toBe('test/review');
    } finally { reopened.close(); }
  });

  it('caps output candidates and paginated directories by the remaining shared budget', async () => {
    const { app, runId } = fixture();
    install(app.store, 'alpha/one', 'Review');
    install(app.store, 'zulu/two', 'Review');
    const result = await cardDirectoryTool(app.store, { maxCalls: 10, maxCards: 1 }).execute(context(app.store, runId), { limit: 100 });
    expect(result).toMatchObject({ namespaces: [{ namespace: 'alpha' }], status: 'matched', next: { offset: 1 }, budget: { cardsUsed: 1, cardsRemaining: 0 } });
    expect(await cardSearchTool(app.store).execute(context(app.store, runId), {})).toMatchObject({ status: 'budget_exhausted', cards: [] });
    expect(app.store.events(runId).filter(event => event.type === 'agent.discovery.explored')).toHaveLength(1);
  });

  it('prevents a spawned child from resetting the session allowance and leaves cancelled/invalid calls uncharged', async () => {
    const { app, runId } = fixture();
    const child = app.store.transaction(() => {
      const run = app.store.run(runId);
      return app.coordinator.mailbox.execute(run, 'spawn', 'spawn_agent', { objective: 'Independent metadata review' }) as { id: string };
    });
    const tool = cardSearchTool(app.store, { maxCalls: 2, maxCards: 20 });
    expect(() => tool.execute(context(app.store, runId), { limit: 0 })).toThrow();
    const cancelled = context(app.store, runId);
    cancelled.signal = AbortSignal.abort(new Error('Cancelled before exploration'));
    expect(() => tool.execute(cancelled, {})).toThrow('Cancelled before exploration');
    expect(app.store.events(runId).some(event => event.type === 'agent.discovery.explored')).toBe(false);
    expect(await tool.execute(context(app.store, runId), { query: 'missing' })).toMatchObject({ status: 'no_match', budget: { callsUsed: 1 } });
    expect(await tool.execute(context(app.store, child.id), { query: 'missing' })).toMatchObject({ status: 'no_match', budget: { callsUsed: 2 } });
    expect(await tool.execute(context(app.store, runId), {})).toMatchObject({ status: 'budget_exhausted', budget: { callsUsed: 2 } });
  });
});
