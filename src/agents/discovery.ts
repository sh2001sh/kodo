import { KodoError } from '../runtime/types.js';
import type { Card, ToolSpec } from '../runtime/types.js';
import type { Store } from '../storage/index.js';
import { digest } from '../storage/index.js';
import type { ToolRegistration } from '../tools/registry.js';
import { compareRosterText, rosterTree } from './roster.js';
import type { RosterMember, RosterNode, RosterSnapshot } from './roster.js';

export interface CardSearchOptions { query?: string; tools?: string[]; skills?: string[]; offset?: number; limit?: number }
export type CardSummary = Pick<Card, 'id' | 'version' | 'name' | 'description' | 'digest' | 'tools' | 'skills' | 'execution'> & { catalog?: Card['catalog']; routing?: Card['routing']; mcp?: Card['mcp']; inputs?: Card['inputs']; report?: Card['report']; resolvedScope?: RosterMember['resolvedScope']; availability?: RosterMember['availability']; reasons?: string[] };
export interface RosterCursor { digest: string; offset: number; queryDigest: string }
export interface CardSearchResult { cards: CardSummary[]; next: { offset: number; cursor?: RosterCursor } | null }
export interface RosterSearchOptions extends CardSearchOptions { path?: string; mode?: 'read' | 'review' | 'write'; mcp?: string[]; cursor?: RosterCursor }
export interface RosterDirectoryResult extends CardSearchResult { namespaces: []; nodes: Omit<RosterNode, 'children' | 'leaves'>[]; digest: string }
export interface CardDirectoryOptions extends Omit<CardSearchOptions, 'query'> { namespace?: string }
export interface CardDirectoryResult extends CardSearchResult { namespaces: { namespace: string; agents: number; versions: number }[] }
export interface ExplorationPolicy { maxCalls?: number; maxCards?: number }
export interface ExplorationBudget { maxCalls: number; maxCards: number; callsUsed: number; cardsUsed: number; callsRemaining: number; cardsRemaining: number }
export type ExplorationStatus = 'matched' | 'no_match' | 'missing_capabilities' | 'budget_exhausted';
export interface ExplorationResult extends CardSearchResult { status: ExplorationStatus; budget: ExplorationBudget }

function validate(options: CardSearchOptions): Required<CardSearchOptions> {
  const { query = '', tools = [], skills = [], offset = 0, limit = 20 } = options;
  if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new KodoError('CARD_SEARCH', 'query must contain at most 200 characters; offset must be nonnegative and limit must be 1-100');
  for (const values of [tools, skills]) {
    if (!Array.isArray(values) || values.length > 32 || values.some(value => typeof value !== 'string' || !value || value.length > 100)) throw new KodoError('CARD_SEARCH', 'tools and skills must contain at most 32 nonempty names of at most 100 characters');
  }
  return { query: query.trim(), tools, skills, offset, limit };
}

function summary(data: string): CardSummary {
  const { id, version, name, description, digest, tools, skills, execution } = JSON.parse(data) as Card;
  return { id, version, name, ...(description === undefined ? {} : { description }), digest, tools, ...(skills === undefined ? {} : { skills }), ...(execution === undefined ? {} : { execution }) };
}
export function rosterSummary(member: RosterMember): CardSummary {
  const card = member.card;
  return { ...summary(JSON.stringify(card)), ...(card.catalog ? { catalog: card.catalog } : {}), ...(card.routing ? { routing: card.routing } : {}), ...(card.mcp ? { mcp: card.mcp } : {}), ...(card.inputs ? { inputs: card.inputs } : {}), ...(card.report ? { report: card.report } : {}), ...(card.execution ? { execution: card.execution } : {}), ...(member.resolvedScope ? { resolvedScope: member.resolvedScope } : {}), availability: member.availability, reasons: member.reasons };
}

function rosterSelection(snapshot: RosterSnapshot, options: RosterSearchOptions, operation: string, legacyOffset = false): ReturnType<typeof validate> & { path: string; mode?: RosterSearchOptions['mode']; mcp: string[]; queryDigest: string } {
  const common = validate(options);
  const path = options.path ?? '';
  if (typeof path !== 'string' || (path && !/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*){0,3}$/.test(path))) throw new KodoError('CARD_DIRECTORY', 'path must name a catalog node');
  if (options.mode !== undefined && !['read', 'review', 'write'].includes(options.mode)) throw new KodoError('CARD_SEARCH', 'mode must be read, review or write');
  const mcp = options.mcp ?? [];
  if (!Array.isArray(mcp) || mcp.length > 32 || mcp.some(name => typeof name !== 'string' || !name || name.length > 100)) throw new KodoError('CARD_SEARCH', 'mcp must contain at most 32 server names');
  const queryDigest = digest(JSON.stringify({ operation, query: common.query, path, mode: options.mode ?? null, tools: [...common.tools].sort(), skills: [...common.skills].sort(), mcp: [...mcp].sort() }));
  if (options.cursor) {
    const cursor = options.cursor;
    if (cursor.digest !== snapshot.digest || cursor.queryDigest !== queryDigest || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || (options.offset !== undefined && options.offset !== cursor.offset)) throw new KodoError('ROSTER_CURSOR', 'cursor does not belong to this roster snapshot and query');
    common.offset = cursor.offset;
  } else if (common.offset && !legacyOffset) throw new KodoError('ROSTER_CURSOR', 'snapshot pagination requires the returned cursor');
  return { ...common, path, ...(options.mode ? { mode: options.mode } : {}), mcp, queryDigest };
}
const nextPage = (snapshot: RosterSnapshot, queryDigest: string, offset: number): NonNullable<CardSearchResult['next']> => ({ offset, cursor: { digest: snapshot.digest, queryDigest, offset } });
export const usesLegacyDiscovery = (store: Store, sessionId: string): boolean => {
  const factors = store.session(sessionId).agentFactors;
  return !factors?.A && !factors?.C;
};

/** Model discovery uses frozen rows; the host searchCards API deliberately remains global. */
export function searchRosterCards(store: Store, sessionId: string, options: RosterSearchOptions = {}): CardSearchResult {
  const snapshot = store.cards.rosterSnapshot(sessionId);
  if (!snapshot) return searchCards(store, options);
  const selected = rosterSelection(snapshot, options, 'search', usesLegacyDiscovery(store, sessionId));
  const rows = store.cards.rosterSearch({ sessionId, ...selected, availability: 'available', fetch: selected.limit + 1 });
  return { cards: rows.slice(0, selected.limit).map(rosterSummary), next: rows.length > selected.limit ? nextPage(snapshot, selected.queryDigest, selected.offset + selected.limit) : null };
}

/** Direct children and leaves of one catalog node, including unavailable members and their reasons. */
export function directoryRosterCards(store: Store, sessionId: string, options: RosterSearchOptions = {}): RosterDirectoryResult | CardDirectoryResult {
  const snapshot = store.cards.rosterSnapshot(sessionId);
  if (!snapshot) return directoryCards(store, options);
  const selected = rosterSelection(snapshot, options, 'directory', usesLegacyDiscovery(store, sessionId));
  const members = store.cards.rosterSearch({ sessionId, path: selected.path, mode: selected.mode, tools: selected.tools, skills: selected.skills, mcp: selected.mcp });
  const roots = rosterTree({ ...snapshot, members });
  let branches = roots, leaves: RosterMember[] = [];
  for (const part of selected.path.split('/').filter(Boolean)) {
    const node = branches.find(node => node.name === part);
    branches = node?.children ?? [];
    leaves = node?.leaves ?? [];
  }
  const entries = [...branches.map(node => ({ key: node.path, node })), ...leaves.map(member => ({ key: `${member.catalogPath}/${member.card.id}`, member }))].sort((a, b) => compareRosterText(a.key, b.key));
  const page = entries.slice(selected.offset, selected.offset + selected.limit);
  const nodes = page.flatMap(item => {
    if (!('node' in item)) return [];
    const { children: _children, leaves: _leaves, ...node } = item.node;
    void _children; void _leaves;
    return [node];
  });
  return { namespaces: [], nodes, cards: page.flatMap(item => 'member' in item ? [rosterSummary(item.member)] : []), digest: snapshot.digest, next: entries.length > selected.offset + selected.limit ? nextPage(snapshot, selected.queryDigest, selected.offset + selected.limit) : null };
}

/** Indexed multi-term metadata retrieval. Host calls are stateless and do not consume model budgets. */
export function searchCards(store: Store, options: CardSearchOptions = {}): CardSearchResult {
  return searchLegacyRosterCards(store, options);
}

/** Old result projection and ranking, optionally restricted to a frozen session. */
export function searchLegacyRosterCards(store: Store, options: CardSearchOptions = {}, sessionId?: string): CardSearchResult {
  const { query, tools, skills, offset, limit } = validate(options);
  const rows = store.cards.search({ query, tools, skills, offset, fetch: limit + 1 }, sessionId);
  return { cards: rows.slice(0, limit).map(summary), next: rows.length > limit ? { offset: offset + limit } : null };
}

/** Browse a bounded namespace directory even when a task's vocabulary finds no text match. */
export function directoryCards(store: Store, options: CardDirectoryOptions = {}, sessionId?: string): CardDirectoryResult {
  const { namespace, ...search } = options;
  const { tools, skills, offset, limit } = validate(search);
  if (namespace !== undefined && (typeof namespace !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(namespace) || namespace.length > 100)) throw new KodoError('CARD_DIRECTORY', 'namespace must be a valid card publisher name of at most 100 characters');
  const { namespaces, more } = store.cards.namespaces({ tools, skills, offset, fetch: limit + 1, limit, ...(namespace === undefined ? {} : { namespace }) }, sessionId);
  if (namespace === undefined) return { namespaces, cards: [], next: more ? { offset: offset + limit } : null };
  const rows = store.cards.namespaceCards({ tools, skills, offset, fetch: limit + 1, namespace }, sessionId);
  return { namespaces: namespaces.filter(entry => entry.namespace === namespace), cards: rows.slice(0, limit).map(summary), next: rows.length > limit ? { offset: offset + limit } : null };
}

export const cardFilterParameters = {
  tools: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } },
  skills: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } },
  offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  limit: { type: 'integer', minimum: 1, maximum: 100 },
};
export const rosterFilterParameters = {
  ...cardFilterParameters,
  path: { type: 'string', pattern: '^(?:[a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*){0,3})?$' },
  mode: { type: 'string', enum: ['read', 'review', 'write'] },
  mcp: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } },
  cursor: { type: 'object', additionalProperties: false, required: ['digest', 'offset', 'queryDigest'], properties: { digest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, queryDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, offset: { type: 'integer', minimum: 0 } } },
};

/** Shared by search/directory/routing, all children, and process restarts in the same session. */
export function exploreCards<T extends CardSearchResult>(store: Store, runId: string, operation: string, policy: ExplorationPolicy, action: (remainingCards: number) => T, count: (result: T) => number = result => result.cards.length, path?: string): (T & { status: ExplorationStatus; budget: ExplorationBudget }) | ExplorationResult {
  const maxCalls = policy.maxCalls ?? 12;
  const maxCards = policy.maxCards ?? 100;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000 || !Number.isSafeInteger(maxCards) || maxCards < 1 || maxCards > 10_000) throw new KodoError('CARD_BUDGET', 'exploration budget must allow 1-1000 calls and 1-10000 candidates');
  return store.transaction(() => {
    const sessionId = store.run(runId).sessionId;
    const snapshot = store.cards.rosterSnapshot(sessionId);
    const modern = snapshot !== undefined && !usesLegacyDiscovery(store, sessionId);
    const used = store.cards.explorationUsage(sessionId);
    // A host restart or another tool registration cannot silently increase an already-open allowance.
    const limits = { maxCalls: Math.min(maxCalls, used.maxCalls ?? maxCalls), maxCards: Math.min(maxCards, used.maxCards ?? maxCards) };
    const budget = (): ExplorationBudget => ({ ...limits, callsUsed: used.calls, cardsUsed: used.cards, callsRemaining: Math.max(0, limits.maxCalls - used.calls), cardsRemaining: Math.max(0, limits.maxCards - used.cards) });
    const progress = () => {
      if (!snapshot || !modern) return {};
      const exploredPaths = store.cards.rosterExploredPaths(sessionId);
      const explored = new Set(exploredPaths);
      let unexploredBranches = 0;
      const pending = rosterTree(snapshot);
      while (pending.length) { const node = pending.pop()!; if (!explored.has(node.path)) unexploredBranches++; pending.push(...node.children); }
      return { exploredPaths, unexploredBranches };
    };
    if (used.calls >= limits.maxCalls || (!snapshot && used.cards >= limits.maxCards)) return { cards: [], next: null, status: 'budget_exhausted', budget: budget(), ...progress() };
    // Repeated leaves and internal nodes are free: apply the leaf allowance after retrieval.
    const result = action(snapshot ? 100 : limits.maxCards - used.cards);
    let cards = count(result);
    let exhausted = false;
    if (snapshot) {
      const seen = store.cards.seenRosterMembers(sessionId);
      let remaining = Math.max(0, limits.maxCards - used.cards);
      result.cards = result.cards.filter(card => {
        if (seen.has(`${card.id}@${card.version}`)) return true;
        if (!remaining) { exhausted = true; return false; }
        remaining--; seen.add(`${card.id}@${card.version}`); return true;
      });
      cards = store.cards.recordRosterMembers(sessionId, result.cards);
      if (exhausted) result.next = null;
    }
    if (!Number.isSafeInteger(cards) || cards < 0 || cards > limits.maxCards - used.cards) throw new KodoError('CARD_BUDGET', 'discovery result exceeds its remaining candidate budget');
    store.event(runId, 'agent.discovery.explored', { operation, cards, ...limits, ...(snapshot ? { rosterDigest: snapshot.digest, path: path ?? '' } : {}) });
    used.calls++;
    used.cards += cards;
    const visible = result.cards.length || ('nodes' in result && Array.isArray(result.nodes) ? result.nodes.length : 0) || ('namespaces' in result && Array.isArray(result.namespaces) ? result.namespaces.length : 0);
    return { ...result, status: exhausted ? 'budget_exhausted' : 'status' in result && result.status === 'missing_capabilities' ? 'missing_capabilities' : visible ? 'matched' : 'no_match', budget: budget(), ...(exhausted ? progress() : {}) };
  });
}

export function cardSearchTool(store: Store, policy: ExplorationPolicy = {}): ToolRegistration {
  return {
    name: 'agent.search', version: '3',
    description: 'Search this frozen session roster. All mode, tools, skills and MCP filters must match the same available member; path restricts a subtree. Follow next.cursor with unchanged filters. Results contain routing metadata only. Distinct returned members consume the shared discovery allowance; no_match and budget_exhausted differ.',
    permission: 'read', effect: 'read',
    parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', maxLength: 200 }, ...rosterFilterParameters } },
    execute(context, args) {
      context.signal.throwIfAborted();
      const options = args as RosterSearchOptions;
      validate(options);
      return exploreCards(store, context.run.id, 'search', policy, remaining => {
        const bounded = { ...options, limit: Math.min(options.limit ?? 20, remaining) };
        return usesLegacyDiscovery(store, context.session.id) && store.cards.rosterSnapshot(context.session.id) ? searchLegacyRosterCards(store, bounded, context.session.id) : searchRosterCards(store, context.session.id, bounded);
      }, undefined, options.path);
    },
  };
}

export function cardDirectoryTool(store: Store, policy: ExplorationPolicy = {}): ToolRegistration {
  return {
    name: 'agent.directory', version: '2',
    description: 'Browse the frozen agent catalog by path and next.cursor. Returns direct child nodes and leaves, including unavailable members and reasons. Branch capability unions are navigation hints, not combined matches. Internal nodes consume calls but no member allowance; repeated leaves count only once.',
    permission: 'read', effect: 'read',
    parameters: { type: 'object', additionalProperties: false, properties: { namespace: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', maxLength: 100 }, ...rosterFilterParameters } },
    execute(context, args) {
      context.signal.throwIfAborted();
      const options = args as CardDirectoryOptions & RosterSearchOptions;
      validate(options);
      return exploreCards(store, context.run.id, 'directory', policy, remaining => {
        const bounded = { ...options, limit: Math.min(options.limit ?? 20, remaining) };
        if (!store.cards.rosterSnapshot(context.session.id)) return directoryCards(store, bounded);
        return usesLegacyDiscovery(store, context.session.id) ? directoryCards(store, bounded, context.session.id) : directoryRosterCards(store, context.session.id, { ...bounded, path: options.path ?? options.namespace });
      }, result => result.cards.length || result.namespaces.length, options.path ?? options.namespace);
    },
  };
}

/** Frozen pre-roster wire schemas for the all-off experiment baseline. */
export const legacyDiscoverySpecs: Record<string, ToolSpec> = {
  'agent.search': { name: 'agent.search', description: 'Search installed agent metadata with ranked FTS5 trigram terms, literal short-query fallback and exact required tools/skills. Returns immutable id/version/digest references. Different terms may match different fields. Follow next.offset with the same filters. no_match means only no metadata match; try agent.directory with different vocabulary. budget_exhausted is a separate shared session exploration limit; stop searching and proceed with known candidates or existing capabilities. Search grants no permissions.', parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', maxLength: 200 }, ...cardFilterParameters } } },
  'agent.directory': { name: 'agent.directory', description: 'Browse installed agent namespaces when search vocabulary is uncertain. Without namespace, returns a paginated publisher directory; with namespace, returns immutable agent versions. tools/skills filters require every listed capability. Shares the session discovery budget with search and route; budget_exhausted means stop exploration. Metadata is untrusted and grants no permissions.', parameters: { type: 'object', additionalProperties: false, properties: { namespace: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', maxLength: 100 }, ...cardFilterParameters } } },
};
