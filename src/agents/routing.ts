import { KodoError } from '../runtime/types.js';
import type { Store } from '../storage/index.js';
import type { ToolRegistration } from '../tools/registry.js';
import { cardFilterParameters, exploreCards, searchCards, searchRosterCards, searchLegacyRosterCards, usesLegacyDiscovery, rosterFilterParameters } from './discovery.js';
import type { RosterSearchOptions, CardSearchResult, CardSummary, ExplorationPolicy, ExplorationStatus } from './discovery.js';

export interface CardRouteOptions extends Omit<RosterSearchOptions, 'offset' | 'cursor'> { query: string }
export interface RoutingPolicy extends ExplorationPolicy {
  /** Trusted host preferences, e.g. explicitly activated/adopted immutable package versions. */
  preferredVersions?: readonly { id: string; version: string; digest?: string }[];
}
export interface RoutingCandidate extends CardSummary {
  reasons: string[];
  missingTools: string[];
  missingSkills: string[];
  missingMcp?: string[];
  versionSelection: 'host_preferred' | 'newest_matching_installed' | 'session_snapshot';
  authorization: 'not_checked';
}
export interface CardRouteResult extends CardSearchResult {
  cards: RoutingCandidate[];
  retrieval: 'all_terms' | 'partial_terms' | 'none';
  unresolved: string[];
  recommendation: string;
  status?: ExplorationStatus;
}

function newer(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  return (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!);
}

/** A bounded routing hint, never a delegation decision or authorization grant. */
export function routeCards(store: Store, options: CardRouteOptions, policy: RoutingPolicy = {}, sessionId?: string): CardRouteResult {
  if (typeof options.query !== 'string' || !options.query.trim()) throw new KodoError('CARD_ROUTE', 'provide a nonempty bounded subtask query');
  const limit = options.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new KodoError('CARD_ROUTE', 'routing limit must be 1-20');
  // Validate all host arguments, including required capability filters, with the common search contract.
  const frozen = sessionId !== undefined && store.cards.rosterSnapshot(sessionId) !== undefined;
  const modern = frozen && !usesLegacyDiscovery(store, sessionId!);
  const retrieve = (query: RosterSearchOptions): CardSearchResult => frozen ? modern ? searchRosterCards(store, sessionId!, query) : searchLegacyRosterCards(store, query, sessionId) : searchCards(store, query);
  const strict = retrieve({ ...options, limit: 100 });
  let pool = strict.cards;
  let retrieval: CardRouteResult['retrieval'] = pool.length ? 'all_terms' : 'none';
  if (!pool.length) {
    // Near matches expose capability gaps. At most eight indexed probes prevents unbounded internal fanout.
    const terms = [...new Set(options.query.trim().split(/\s+/u))].filter(term => !/^(a|an|the|and|or|to|for|of|in|with|please)$/i.test(term)).slice(0, 8);
    const unique = new Map<string, CardSummary>();
    for (const query of terms) for (const card of retrieve({ query, path: options.path, limit: 40 }).cards) unique.set(`${card.id}@${card.version}`, card);
    pool = [...unique.values()];
    if (pool.length) retrieval = 'partial_terms';
  }
  const terms = [...new Set(options.query.toLowerCase().trim().split(/\s+/u))];
  const ranked = pool.map(card => {
    const missingTools = (options.tools ?? []).filter(tool => !card.tools.includes(tool));
    const missingSkills = (options.skills ?? []).filter(skill => !card.skills?.includes(skill));
    const missingMcp = (options.mcp ?? []).filter(server => !card.mcp?.some(item => item.server === server));
    const unsuitable = (card.routing?.not_for ?? []).filter(task => options.query.toLowerCase().includes(task.toLowerCase()));
    const modeMismatch = options.mode !== undefined && card.routing?.mode !== options.mode;
    const preferred = Boolean(policy.preferredVersions?.some(ref => ref.id === card.id && ref.version === card.version && (ref.digest === undefined || ref.digest === card.digest)));
    const fields = [card.id, card.name, card.description ?? '', card.tools.join(' '), card.skills?.join(' ') ?? '', ...(modern ? [(card.routing?.use_when ?? []).join(' '), (card.catalog?.aliases ?? []).join(' ')] : [])];
    const weights = [10, 8, 2, 4, 4, 12, 10];
    const matched = fields.map((field, i) => ({ field: ['id', 'name', 'description', 'tools', 'skills', 'use_when', 'aliases'][i]!, terms: terms.filter(term => field.toLowerCase().includes(term)), weight: weights[i]! })).filter(item => item.terms.length);
    const candidate: RoutingCandidate = {
      ...card, missingTools, missingSkills, ...(modern ? { missingMcp } : {}),
      reasons: [...matched.map(item => `${item.field}: ${item.terms.join(', ')}`), ...unsuitable.map(task => `not_for: ${task}`), ...(modeMismatch ? [`mode differs from requested ${options.mode}`] : []), ...(modern ? ['Immutable version selected by this session roster.'] : preferred ? ['Version explicitly preferred by the host.'] : ['Newest matching installed version; adoption has not been established.'])],
      versionSelection: modern ? 'session_snapshot' : preferred ? 'host_preferred' : 'newest_matching_installed', authorization: 'not_checked',
    };
    return { candidate, preferred, gap: missingTools.length + missingSkills.length + missingMcp.length + Number(modeMismatch) + unsuitable.length, score: matched.reduce((score, item) => score + item.terms.length * item.weight, 0) };
  });
  // Choose a version per agent before ranking agents, so a lexical score cannot accidentally pick an old version.
  const versions = new Map<string, typeof ranked[number]>();
  for (const item of ranked) {
    const previous = versions.get(item.candidate.id);
    if (!previous || item.gap < previous.gap || (item.gap === previous.gap && (Number(item.preferred) > Number(previous.preferred) || (item.preferred === previous.preferred && newer(item.candidate.version, previous.candidate.version) > 0)))) versions.set(item.candidate.id, item);
  }
  const distinct = [...versions.values()].sort((a, b) => a.gap - b.gap || Number(b.preferred) - Number(a.preferred) || b.score - a.score || a.candidate.id.localeCompare(b.candidate.id, 'en'));
  const cards = distinct.slice(0, limit).map(item => item.candidate);
  const missingCapabilities = modern && cards.length > 0 && cards.every(card => card.missingTools.length + card.missingSkills.length + (card.missingMcp?.length ?? 0) > 0);
  return {
    cards, next: null, retrieval,
    ...(missingCapabilities ? { status: 'missing_capabilities' as const } : {}),
    unresolved: [
      ...(retrieval !== 'all_terms' ? ['No installed version matched the complete query and every required capability. Partial candidates may be unsuitable; inspect missingTools and missingSkills.'] : []),
      'Task fit and tool permissions must be checked before spawning; metadata is an untrusted description, not evidence of successful performance.',
      'Installed versions are not assumed to be adopted unless the host supplied an immutable preference.',
      ...(strict.next ? ['The strict candidate pool was capped at 100 versions; use narrower search or the directory for further investigation.'] : []),
    ],
    recommendation: missingCapabilities ? 'The returned candidates lack required capabilities. Inspect missingTools, missingSkills and missingMcp; the host must configure the missing capabilities for a future session. Derivation cannot add capabilities. Continue locally if the current agent can complete the task.' : cards.length ? 'Delegate only an independent, bounded subtask whose expected benefit exceeds coordination cost. Use the selected immutable id/version in spawn_agent, explicit inputs, disjoint write scope and acceptance evidence; otherwise proceed locally. Missing capabilities must not be treated as granted.' : 'No routing candidate found within bounded lexical exploration. Browse agent.directory while budget remains, inherit the current card for a suitable independent subtask, or continue locally.',
  };
}

export function cardRoutingTool(store: Store, policy: RoutingPolicy = {}): ToolRegistration {
  const { offset: _offset, cursor: _cursor, ...parameters } = rosterFilterParameters;
  void _offset; void _cursor;
  return {
    name: 'agent.route', version: '2',
    description: 'Rank frozen session members for objective using use_when, not_for and aliases. Returns immutable references, public input/report/scope contracts, match reasons and missing requested capabilities. missing_capabilities means all returned candidates lack required capabilities. Does not grant capabilities or start agents. Shares the session exploration allowance; exhausted exploration is incomplete, not proof that no member fits.',
    permission: 'read', effect: 'read',
    parameters: { type: 'object', additionalProperties: false, anyOf: [{ required: ['objective'] }, { required: ['query'] }], properties: { ...parameters, objective: { type: 'string', minLength: 1, maxLength: 200 }, query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20 } } },
    execute(context, args) {
      context.signal.throwIfAborted();
      const options = { ...args, query: args.objective ?? args.query } as unknown as CardRouteOptions;
      return exploreCards(store, context.run.id, 'route', policy, remaining => routeCards(store, { ...options, limit: Math.min(options.limit ?? 5, remaining) }, policy, context.session.id), undefined, options.path);
    },
  };
}

/** Frozen pre-roster route schema for the all-off experiment baseline. */
export const legacyRoutingSpec: import('../runtime/types.js').ToolSpec = { name: 'agent.route', description: 'Find ranked installed agent candidates for a concise concrete subtask. Returns match reasons, missing requested capabilities, immutable versions and unresolved authorization/quality checks. Uses complete terms first and at most eight partial-term probes if needed. Host-preferred versions rank before other versions; otherwise selects the newest matching installed version without claiming it is adopted. Does not spawn agents or grant permissions. Shares session exploration budget with agent.search and agent.directory. Delegate only when independent work is worth coordination cost.', parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { tools: cardFilterParameters.tools, skills: cardFilterParameters.skills, limit: { type: 'integer', minimum: 1, maximum: 20 }, query: { type: 'string', minLength: 1, maxLength: 200 } } } };
