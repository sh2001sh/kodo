import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeRoster, rosterMember } from '../src/agents/roster.js';
import { cardDirectoryTool, cardSearchTool, directoryRosterCards, searchCards, searchRosterCards } from '../src/agents/discovery.js';
import { cardRoutingTool, routeCards } from '../src/agents/routing.js';
import { defaultBudget } from '../src/runtime/types.js';
import type { Card, Session } from '../src/runtime/types.js';
import { Store, digest } from '../src/storage/index.js';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function card(id: string, extra: Partial<Card> = {}): Card {
  const value = { id, version: '1.0.0', name: id, description: 'Source review', prompt: 'Private workflow text.', tools: ['file.read'], schemaVersion: 2 as const, catalog: { path: 'engineering/source' }, routing: { use_when: ['Review source'], mode: 'read' as const }, ...extra };
  return { ...value, digest: digest(JSON.stringify(value)) };
}
function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kodo-roster-'));
  const store = new Store(directory);
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const session: Session = { id: 'session', workspace: directory, permissions: ['read', 'write'], budget: { ...defaultBudget, maxOutputTokens: 2048, maxContextTokens: 100_000 }, agentFactors: { A: true, B: true, C: true }, tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, createdAt: new Date().toISOString() };
  store.putSession(session);
  const main = card('test/main');
  store.putRun({ id: 'run', sessionId: session.id, card: main, objective: 'Review source', status: 'queued', binding: { model: 'test', baseURL: 'http://localhost', apiKeyEnv: 'TEST_KEY' }, contextRef: store.blob([]), step: 0, cancelRequested: false, createdAt: session.createdAt });
  const context = () => ({ run: store.run('run'), session: store.session(session.id), signal: new AbortController().signal, markEffectStarted() {} });
  return { store, session, main, context };
}

describe('frozen session roster', () => {
  it('applies source precedence and stores the selected full card without global replacement', () => {
    const { store, session, main } = setup();
    const builtin = card('test/expert', { prompt: 'builtin' });
    const user = card('test/expert', { prompt: 'user' });
    const project = card('test/expert', { prompt: 'project' });
    store.registerCard(user);
    const snapshot = freezeRoster(store, session, main, { builtinCards: [builtin], userCards: [user], projectCards: [project], tools: ['file.read'] });
    expect(snapshot.members).toHaveLength(1);
    expect(rosterMember(store, session.id, project.id)).toMatchObject({ source: 'project', availability: 'available', card: { digest: project.digest, prompt: 'project' } });
    expect(store.card(user.id, user.version).prompt).toBe('user');
    expect(freezeRoster(store, session, main, { projectCards: [builtin] })).toEqual(snapshot);
    expect(() => store.cards.freezeRoster({ ...snapshot, digest: 'different' })).toThrow('already frozen');
  });

  it('selects numeric latest versions and pins explicit member versions', () => {
    const { store, session, main } = setup();
    const older = card('test/expert', { version: '1.9.0' });
    const newer = card('test/expert', { version: '1.10.0' });
    const snapshot = freezeRoster(store, session, main, { userCards: [newer, older], tools: ['file.read'] });
    expect(snapshot.members[0]?.card.version).toBe('1.10.0');
    const pinnedSession = { ...session, id: 'pinned' }; store.putSession(pinnedSession);
    const pinned = freezeRoster(store, pinnedSession, { ...main, members: [older] }, { userCards: [newer, older], tools: ['file.read'] });
    expect(pinned.members[0]?.card.version).toBe('1.9.0');
  });

  it('keeps digests stable across input order and session ids while binding descriptions', () => {
    const { store, session, main } = setup();
    const cards = [card('test/alpha'), card('test/beta')];
    const first = freezeRoster(store, session, main, { userCards: cards, tools: ['file.read'], catalogDescriptions: { engineering: 'Engineering' } });
    for (const id of ['same', 'changed']) store.putSession({ ...session, id });
    const same = freezeRoster(store, { ...session, id: 'same' }, main, { userCards: [...cards].reverse(), tools: ['file.read'], catalogDescriptions: { engineering: 'Engineering' } });
    const changed = freezeRoster(store, { ...session, id: 'changed' }, main, { userCards: cards, tools: ['file.read'], catalogDescriptions: { engineering: 'Build software' } });
    expect(same.digest).toBe(first.digest);
    expect(changed.digest).not.toBe(first.digest);
  });

  it('keeps late registrations out of model search and route while host search remains global', () => {
    const { store, session, main } = setup();
    const initial = card('test/initial'); store.registerCard(initial);
    freezeRoster(store, session, main, { userCards: [initial], tools: ['file.read'] });
    const late = card('test/late'); store.registerCard(late);
    expect(searchCards(store, { query: 'review' }).cards).toHaveLength(2);
    expect(searchRosterCards(store, session.id, { query: 'review' }).cards.map(item => item.id)).toEqual([initial.id]);
    expect(routeCards(store, { query: 'review' }, {}, session.id).cards.map(item => item.id)).toEqual([initial.id]);
    expect(searchRosterCards(store, session.id, { query: 'Private workflow' }).cards).toEqual([]);
    expect(JSON.stringify(searchRosterCards(store, session.id))).not.toContain('Private workflow');
  });

  it('shows unavailable members with actionable reasons only in directory results', () => {
    const { store, session, main } = setup();
    const unavailable = card('test/missing', { tools: ['verify.run'], skills: ['review-guidelines'], mcp: [{ server: 'design', tools: ['inspect'] }], constraints: { scope: { write: ['${project.tests}'] } } });
    freezeRoster(store, session, main, { userCards: [unavailable], tools: ['file.read'] });
    expect(searchRosterCards(store, session.id).cards).toEqual([]);
    const member = directoryRosterCards(store, session.id, { path: 'engineering/source' }).cards[0]!;
    expect(member.availability).toBe('unavailable');
    expect(member.reasons?.join(' ')).toContain('verify.run');
    expect(member.reasons?.join(' ')).toContain('review-guidelines');
    expect(member.reasons?.join(' ')).toContain('MCP server unavailable');
    expect(member.reasons?.join(' ')).toContain('project.tests');
  });

  it('matches all structural filters on the same member and supports short aliases', () => {
    const { store, session, main } = setup();
    const first = card('test/alpha', { catalog: { path: 'engineering/source', aliases: ['UI', '界面'] }, tools: ['file.read'], mcp: [{ server: 'design', tools: ['inspect'] }] });
    const second = card('test/beta', { tools: ['file.patch'], routing: { use_when: ['Patch source'], mode: 'write' }, mcp: [{ server: 'code', tools: ['edit'] }] });
    freezeRoster(store, session, main, { userCards: [first, second], tools: ['file.read', 'file.patch', 'mcp.design.inspect', 'mcp.code.edit'], mcpServers: ['design', 'code'] });
    expect(searchRosterCards(store, session.id, { tools: ['file.read', 'file.patch'] }).cards).toEqual([]);
    expect(directoryRosterCards(store, session.id, { path: 'engineering', tools: ['file.read'], mcp: ['code'] })).toMatchObject({ nodes: [], cards: [] });
    expect(searchRosterCards(store, session.id, { mcp: ['design'], mode: 'write' }).cards).toEqual([]);
    expect(searchRosterCards(store, session.id, { query: '界面', tools: ['file.read'], mcp: ['design'], mode: 'read' }).cards.map(item => item.id)).toEqual([first.id]);
    expect(searchRosterCards(store, session.id, { query: 'UI' }).cards.map(item => item.id)).toEqual([first.id]);
  });

  it('paginates deterministically and rejects stale or mismatched cursors', () => {
    const { store, session, main } = setup();
    freezeRoster(store, session, main, { userCards: [card('test/c'), card('test/a'), card('test/b')], tools: ['file.read'] });
    const first = searchRosterCards(store, session.id, { limit: 1 });
    const second = searchRosterCards(store, session.id, { limit: 1, ...first.next! });
    const third = searchRosterCards(store, session.id, { limit: 1, ...second.next! });
    expect([first, second, third].flatMap(page => page.cards.map(item => item.id))).toEqual(['test/a', 'test/b', 'test/c']);
    expect(third.next).toBeNull();
    expect(() => searchRosterCards(store, session.id, { offset: 1 })).toThrow('cursor');
    expect(() => searchRosterCards(store, session.id, { cursor: { ...first.next!.cursor!, digest: 'stale' } })).toThrow('cursor');
    expect(() => searchRosterCards(store, session.id, { ...first.next!, query: 'review' })).toThrow('cursor');
    expect(() => directoryRosterCards(store, session.id, { ...first.next! })).toThrow('cursor');
    const directory = directoryRosterCards(store, session.id, { path: 'engineering/source', limit: 1 });
    expect(directoryRosterCards(store, session.id, { path: 'engineering/source', limit: 1, ...directory.next! }).cards[0]?.id).toBe('test/b');
  });

  it('charges distinct leaves once across tools and preserves the shared allowance on reopen', async () => {
    const { store, session, main, context } = setup();
    freezeRoster(store, session, main, { userCards: [card('test/alpha'), card('test/beta')], tools: ['file.read'] });
    const policy = { maxCalls: 8, maxCards: 1 };
    expect(await cardDirectoryTool(store, policy).execute(context(), {})).toMatchObject({ nodes: [{ path: 'engineering' }], budget: { cardsUsed: 0, callsUsed: 1 } });
    expect(await cardSearchTool(store, policy).execute(context(), { query: 'alpha' })).toMatchObject({ cards: [{ id: 'test/alpha' }], budget: { cardsUsed: 1, callsUsed: 2 } });
    expect(await cardRoutingTool(store, policy).execute(context(), { objective: 'alpha' })).toMatchObject({ cards: [{ id: 'test/alpha' }], budget: { cardsUsed: 1, callsUsed: 3 } });
    expect(await cardDirectoryTool(store, policy).execute(context(), { path: 'engineering' })).toMatchObject({ nodes: [{ path: 'engineering/source' }], budget: { cardsUsed: 1, callsUsed: 4 } });
    expect(await cardSearchTool(store, policy).execute(context(), { query: 'beta' })).toMatchObject({ status: 'budget_exhausted', cards: [], exploredPaths: expect.any(Array), unexploredBranches: expect.any(Number), budget: { cardsUsed: 1, callsUsed: 5 } });
    store.close();
    const reopened = new Store(store.directory);
    try {
      expect(reopened.cards.rosterMember(session.id, 'test/alpha')?.card.prompt).toBe('Private workflow text.');
      expect(searchRosterCards(reopened, session.id).cards).toHaveLength(2);
      expect(reopened.cards.explorationUsage(session.id)).toMatchObject({ cards: 1, calls: 5, maxCards: 1 });
      expect(reopened.cards.seenRosterMembers(session.id)).toEqual(new Set(['test/alpha@1.0.0']));
    } finally { reopened.close(); }
  });

  it('ranks use_when and aliases, penalizes not_for and keeps the frozen version', () => {
    const { store, session, main } = setup();
    const match = card('test/match', { catalog: { path: 'engineering/source', aliases: ['layout'] }, routing: { use_when: ['page layout'], mode: 'read' } });
    const wrong = card('test/wrong', { description: 'page layout', routing: { use_when: ['page layout'], not_for: ['layout'], mode: 'read' } });
    freezeRoster(store, session, main, { userCards: [wrong, match], tools: ['file.read'] });
    store.registerCard(card(match.id, { version: '2.0.0' }));
    const result = routeCards(store, { query: 'layout' }, {}, session.id);
    expect(result.cards[0]).toMatchObject({ id: match.id, version: '1.0.0', versionSelection: 'session_snapshot' });
    expect(result.cards[0]?.reasons.join(' ')).toContain('aliases');
    expect(result.cards[1]?.reasons.join(' ')).toContain('not_for');
  });

  it('recreates lazy roster tables after an enclosing transaction is rolled back', () => {
    const { store, session, main } = setup();
    const options = { userCards: [card('test/expert')], tools: ['file.read'] };
    expect(() => store.transaction(() => { freezeRoster(store, session, main, options); throw new Error('ordinary setup failure'); })).toThrow('ordinary setup failure');
    expect(store.cards.rosterSnapshot(session.id)).toBeUndefined();
    expect(freezeRoster(store, session, main, options).members).toHaveLength(1);
    expect(searchRosterCards(store, session.id, { query: 'review' }).cards).toHaveLength(1);
  });

  it('preserves global discovery for legacy sessions without snapshots', async () => {
    const { store, context, session } = setup();
    store.registerCard(card('test/expert'));
    expect(searchRosterCards(store, session.id)).toEqual(searchCards(store));
    expect(await cardDirectoryTool(store).execute(context(), { namespace: 'test' })).toMatchObject({ cards: [{ id: 'test/expert' }], status: 'matched' });
  });

  it('accepts legacy offset schemas for A/C-off sessions without leaving the snapshot', async () => {
    const { store, session, main, context } = setup();
    store.putSession({ ...session, agentFactors: { A: false, B: true, C: false } });
    freezeRoster(store, session, main, { userCards: [card('test/alpha'), card('test/beta')], tools: ['file.read'] });
    store.registerCard(card('test/late'));
    const first = searchRosterCards(store, session.id, { limit: 1 });
    expect(searchRosterCards(store, session.id, { limit: 1, offset: first.next!.offset }).cards[0]?.id).toBe('test/beta');
    expect(await cardDirectoryTool(store).execute(context(), { namespace: 'test', limit: 1 })).toMatchObject({ namespaces: [{ namespace: 'test', agents: 2, versions: 2 }], cards: [{ id: 'test/alpha' }] });
    expect(directoryRosterCards(store, session.id, { path: 'engineering/source', offset: 1, limit: 1 }).cards.map(item => item.id)).toEqual(['test/beta']);
  });

  it('does not cap internal directory nodes by the remaining member allowance', async () => {
    const { store, session, main, context } = setup();
    freezeRoster(store, session, main, { userCards: [card('test/alpha', { catalog: { path: 'alpha/source' } }), card('test/beta', { catalog: { path: 'beta/source' } })], tools: ['file.read'] });
    expect(await cardDirectoryTool(store, { maxCalls: 3, maxCards: 1 }).execute(context(), {})).toMatchObject({ nodes: [{ path: 'alpha' }, { path: 'beta' }], budget: { cardsUsed: 0 } });
    expect(await cardSearchTool(store, { maxCalls: 3, maxCards: 1 }).execute(context(), { path: 'alpha' })).toMatchObject({ cards: [{ id: 'test/alpha' }], budget: { cardsUsed: 1 } });
    expect(await cardSearchTool(store, { maxCalls: 3, maxCards: 1 }).execute(context(), { path: 'beta' })).toMatchObject({ status: 'budget_exhausted', exploredPaths: ['', 'alpha', 'beta'], unexploredBranches: 2, budget: { callsUsed: 3 } });
    expect(await cardSearchTool(store, { maxCalls: 3, maxCards: 1 }).execute(context(), {})).toMatchObject({ status: 'budget_exhausted', budget: { callsUsed: 3 } });
  });

  it('returns public input/report/scope contracts for members found outside the initial view', () => {
    const { store, session, main } = setup();
    const specialist = card('test/specialist', {
      inputs: [{ name: 'contract', kind: 'artifact', required: true }],
      report: [{ name: 'checks', kind: 'calls', required: true }],
      constraints: { rules: ['Private implementation method'], scope: { read: ['src'] } },
    });
    freezeRoster(store, session, main, { userCards: [specialist], tools: ['file.read'] });
    for (const result of [searchRosterCards(store, session.id), directoryRosterCards(store, session.id, { path: 'engineering/source' }), routeCards(store, { query: 'review' }, {}, session.id)]) {
      expect(result.cards[0]).toMatchObject({ inputs: specialist.inputs, report: specialist.report, resolvedScope: { read: ['src'], write: [] } });
      expect(JSON.stringify(result)).not.toContain(specialist.prompt);
      expect(JSON.stringify(result)).not.toContain('Private implementation method');
    }
  });

  it('loads fixed older members from storage while preserving higher-source overrides', () => {
    const { store, session, main } = setup();
    const older = card('test/expert');
    const newer = card('test/expert', { version: '2.0.0' });
    store.registerCard(older); store.registerCard(newer);
    const fixedMain = { ...main, members: [older] };
    expect(freezeRoster(store, session, fixedMain, { userCards: [newer], tools: ['file.read'] }).members[0]?.card).toEqual(older);
    const projectSession = { ...session, id: 'project' }; store.putSession(projectSession);
    const project = card('test/expert', { prompt: 'Project workflow' });
    expect(freezeRoster(store, projectSession, fixedMain, { userCards: [newer], projectCards: [project], tools: ['file.read'] }).members[0]).toMatchObject({ source: 'project', card: project });
    const userSession = { ...session, id: 'user' }; store.putSession(userSession);
    expect(freezeRoster(store, userSession, fixedMain, { builtinCards: [older], userCards: [newer], tools: ['file.read'] }).members[0]).toMatchObject({ source: 'user', card: newer });
  });

  it('distinguishes incomplete capabilities from no match and budget exhaustion in snapshot routing', async () => {
    const { store, session, main, context } = setup();
    const expert = card('test/expert'); store.registerCard(expert);
    freezeRoster(store, session, main, { userCards: [expert], tools: ['file.read'] });
    const tool = cardRoutingTool(store, { maxCalls: 3 });
    expect(await tool.execute(context(), { objective: 'review', tools: ['file.patch'] })).toMatchObject({ status: 'missing_capabilities', cards: [{ missingTools: ['file.patch'] }] });
    expect(await tool.execute(context(), { objective: 'unknown-domain' })).toMatchObject({ status: 'no_match' });
    expect(await tool.execute(context(), { objective: 'review', tools: ['file.read'] })).toMatchObject({ status: 'matched' });
    expect(await tool.execute(context(), { objective: 'review', tools: ['file.read'] })).toMatchObject({ status: 'budget_exhausted' });
    expect(routeCards(store, { query: 'review', tools: ['file.patch'] })).not.toHaveProperty('status');
  });

  it('accepts offset pagination when restored sessions have no factor flags', () => {
    const { store, session, main } = setup();
    const { agentFactors: _flags, ...legacy } = session; void _flags;
    store.putSession(legacy);
    freezeRoster(store, session, main, { userCards: [card('test/alpha'), card('test/beta')], tools: ['file.read'] });
    expect(searchRosterCards(store, session.id, { offset: 1, limit: 1 }).cards[0]?.id).toBe('test/beta');
  });

  it('preserves baseline tool projections over an identical frozen registry', async () => {
    const baseline = setup(), frozen = setup();
    const members = [card('alpha/first', { description: 'Review TypeScript source' }), card('beta/second', { description: 'Review Markdown source', catalog: { path: 'engineering/docs', aliases: ['layout'] } })];
    for (const instance of [baseline, frozen]) {
      instance.store.putSession({ ...instance.session, agentFactors: { A: false, B: false, C: false } });
      for (const member of members) instance.store.registerCard(member);
    }
    freezeRoster(frozen.store, frozen.session, frozen.main, { userCards: members, tools: ['file.read'] });
    // A later global registration must stay invisible even to the baseline projection.
    frozen.store.registerCard(card('late/third', { description: 'Review TypeScript source' }));
    const requests = [
      { factory: cardSearchTool, args: { query: 'TypeScript', limit: 1 } },
      { factory: cardDirectoryTool, args: { limit: 1 } },
      { factory: cardDirectoryTool, args: { limit: 1, offset: 1 } },
      { factory: cardDirectoryTool, args: { namespace: 'beta', limit: 1 } },
      { factory: cardRoutingTool, args: { query: 'review missing', tools: ['file.patch'] } },
      { factory: cardSearchTool, args: { query: 'layout' } },
    ];
    const project = (value: unknown) => {
      const { budget: _budget, ...result } = value as { budget: unknown; [key: string]: unknown }; void _budget;
      return result;
    };
    for (const request of requests) {
      const oldResult = await request.factory(baseline.store).execute(baseline.context(), request.args);
      const newResult = await request.factory(frozen.store).execute(frozen.context(), request.args);
      expect(project(newResult)).toEqual(project(oldResult));
      if (request === requests[0]) expect(newResult).toEqual(oldResult);
    }
    expect(frozen.store.cards.explorationUsage(frozen.session.id)).toMatchObject({ calls: 6, cards: 2 });
    expect(baseline.store.cards.explorationUsage(baseline.session.id).cards).toBeGreaterThan(2);
    expect(searchCards(frozen.store, { query: 'TypeScript' }).cards).toHaveLength(2);
  });

  it('intersects declared permissions with the selected member mode before marking availability', () => {
    const { store, session, main } = setup();
    const members = [
      card('test/reader', { constraints: { permissions: ['write'] } }),
      card('test/reviewer', { routing: { use_when: ['Review source'], mode: 'review' }, constraints: { permissions: ['write'] } }),
      card('test/reader-ok', { constraints: { permissions: ['read', 'write'] } }),
    ];
    const snapshot = freezeRoster(store, session, main, { userCards: members, tools: ['file.read'] });
    expect(snapshot.members.filter(member => member.availability === 'available').map(member => member.card.id)).toEqual(['test/reader-ok']);
    expect(snapshot.members.filter(member => member.availability === 'unavailable').every(member => member.reasons.includes('card and session permissions do not intersect'))).toBe(true);
  });
});
