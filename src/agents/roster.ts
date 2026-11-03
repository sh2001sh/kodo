import { digest } from '../storage/index.js';
import type { Store } from '../storage/index.js';
import { intersectFileScopes, resolveScopeVariables } from '../runtime/scope.js';
import { KodoError } from '../runtime/types.js';
import type { Card, FileScope, Session } from '../runtime/types.js';

export interface RosterMember {
  card: Card;
  catalogPath: string;
  availability: 'available' | 'unavailable';
  reasons: string[];
  source: 'project' | 'user' | 'builtin' | 'member';
  resolvedScope?: FileScope;
  fixedOrder?: number;
}
export interface RosterSnapshot {
  sessionId: string;
  digest: string;
  members: RosterMember[];
  catalogDescriptions: Record<string, string>;
  ordering: 'catalog.path,id,numeric-version';
  warnings: string[];
}
export interface RosterOptions {
  projectCards?: readonly Card[]; userCards?: readonly Card[]; builtinCards?: readonly Card[];
  skills?: readonly string[]; tools?: readonly string[]; mcpServers?: readonly string[];
  projectVariables?: Record<string, string[]>; catalogDescriptions?: Record<string, string>; scope?: FileScope;
}
export interface RosterNode {
  path: string; name: string; description?: string; members: number;
  tools: string[]; mcp: string[]; modes: string[]; children: RosterNode[]; leaves: RosterMember[];
}
export const compareRosterText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  return (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!) || compareRosterText(left, right);
}
const memberOrder = (a: RosterMember, b: RosterMember): number => compareRosterText(a.catalogPath, b.catalogPath) || compareRosterText(a.card.id, b.card.id) || compareVersions(a.card.version, b.card.version);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareRosterText(a, b)).map(([key, item]) => [key, canonical(item)])) : value;

/** Immutable session membership; later registrations and approvals affect only the next session. */
export function freezeRoster(store: Store, session: Session, mainCard: Card, options: RosterOptions = {}): RosterSnapshot {
  const existing = store.cards.rosterSnapshot(session.id);
  if (existing) return existing;
  const selected = new Map<string, { card: Card; source: RosterMember['source'] }>();
  const users = (options.userCards ?? []).filter(card => !options.builtinCards?.some(builtin => builtin.id === card.id && builtin.version === card.version && builtin.digest === card.digest));
  for (const [source, cards] of [['builtin', options.builtinCards ?? []], ['user', users], ['project', options.projectCards ?? []]] as const) {
    const local = new Map<string, Card>();
    for (const card of cards) {
      const fixed = mainCard.members?.find(ref => ref.id === card.id);
      const previous = local.get(card.id);
      const fixedCandidate = fixed?.version === card.version && fixed.digest === card.digest;
      const fixedPrevious = fixed?.version === previous?.version && fixed?.digest === previous?.digest;
      if (!previous || fixedCandidate || (!fixedPrevious && compareVersions(card.version, previous.version) > 0)) local.set(card.id, card);
    }
    for (const [id, card] of local) selected.set(id, { card, source });
  }
  for (const ref of mainCard.members ?? []) {
    const current = selected.get(ref.id);
    const matches = (card: Card): boolean => card.id === ref.id && card.version === ref.version && card.digest === ref.digest;
    if (current && matches(current.card)) continue;
    const fixed = ([['project', options.projectCards ?? []], ['user', users], ['builtin', options.builtinCards ?? []]] as const)
      .map(([source, cards]) => ({ source, card: cards.find(matches) })).find(item => item.card);
    // A fixed reference wins within its source; a project/user override still wins over lower sources.
    const rank = { builtin: 0, member: 1, user: 1, project: 2 };
    if (current && rank[current.source] > rank[fixed?.source ?? 'member']) continue;
    const card = fixed?.card ?? store.card(ref.id, ref.version);
    if (card.digest !== ref.digest) throw new KodoError('CARD_MEMBER', 'main member reference no longer matches its registered digest');
    selected.set(card.id, { card, source: fixed?.source ?? current?.source ?? 'member' });
  }
  const descriptions = Object.fromEntries(Object.entries(options.catalogDescriptions ?? {}).sort(([a], [b]) => compareRosterText(a, b)).map(([key, value]) => [key, value.trim()]));
  const members = [...selected.values()].map(({ card, source }): RosterMember => {
    const reasons: string[] = [];
    const requiredTools = [...card.tools, ...(card.mcp ?? []).flatMap(server => server.tools.map(name => `mcp.${server.server}.${name}`))];
    for (const name of requiredTools) if (!options.tools?.includes(name)) reasons.push(`tool unavailable: ${name}`);
    for (const name of card.skills ?? []) if (!options.skills?.includes(name)) reasons.push(`skill unavailable: ${name}`);
    for (const server of card.mcp ?? []) if (!options.mcpServers?.includes(server.server)) reasons.push(`MCP server unavailable: ${server.server}`);
    const allowed = (card.constraints?.permissions ?? session.permissions).filter(permission => card.routing?.mode === 'read' ? permission === 'read' : card.routing?.mode === 'review' ? permission !== 'write' : true);
    if (!allowed.some(permission => session.permissions.includes(permission))) reasons.push('card and session permissions do not intersect');
    let resolvedScope: FileScope | undefined;
    try {
      const ceiling = resolveScopeVariables(card.constraints?.scope, options.projectVariables);
      resolvedScope = intersectFileScopes(ceiling, options.scope);
      if ((card.routing?.mode === 'write' || ceiling.write?.length) && resolvedScope.write?.length === 0) reasons.push('card write scope and session scope do not intersect');
      if (ceiling.read?.length && resolvedScope.read?.length === 0) reasons.push('card read scope and session scope do not intersect');
      if (card.routing?.mode === 'read' || card.routing?.mode === 'review') resolvedScope.write = [];
    } catch (error) { if (!(error instanceof KodoError)) throw error; reasons.push(error.message); }
    const fixedOrder = mainCard.members?.findIndex(ref => ref.id === card.id);
    return { card: structuredClone(card), catalogPath: card.catalog?.path ?? `${card.id.split('/')[0] ?? 'legacy'}/general`, source, availability: reasons.length ? 'unavailable' : 'available', reasons, ...(resolvedScope ? { resolvedScope } : {}), ...(fixedOrder !== undefined && fixedOrder >= 0 ? { fixedOrder } : {}) };
  }).sort(memberOrder);
  const ordering = 'catalog.path,id,numeric-version' as const;
  const warnings: string[] = [];
  const parents = new Map<string, Set<string>>();
  for (const member of members) {
    const parts = member.catalogPath.split('/');
    for (let index = 0; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/'), node = parts.slice(0, index + 1).join('/');
      const siblings = parents.get(parent) ?? new Set<string>(); siblings.add(node); parents.set(parent, siblings);
    }
  }
  for (const [parent, nodes] of parents) if (nodes.size > 1 && [...nodes].every(node => !descriptions[node])) warnings.push(`Sibling catalog nodes below ${parent || '/'} have no descriptions; add _catalog.md descriptions for task navigation.`);
  const fingerprint = { ordering, members: members.map(({ card, ...member }) => ({ ...member, id: card.id, version: card.version, digest: card.digest })), descriptions: Object.fromEntries(Object.entries(descriptions).map(([key, value]) => [key, digest(value)])) };
  const snapshot: RosterSnapshot = { sessionId: session.id, digest: digest(JSON.stringify(canonical(fingerprint))), ordering, members, catalogDescriptions: descriptions, warnings };
  store.cards.freezeRoster(snapshot);
  return store.cards.rosterSnapshot(session.id)!;
}

export const rosterSnapshot = (store: Store, sessionId: string): RosterSnapshot | undefined => store.cards.rosterSnapshot(sessionId);
export const rosterMember = (store: Store, sessionId: string, id: string, version?: string): RosterMember | undefined => store.cards.rosterMember(sessionId, id, version);

/** Full deterministic navigation tree. Capability unions describe branches, never matching members. */
export function rosterTree(snapshot: RosterSnapshot): RosterNode[] {
  const nodes = new Map<string, RosterNode>();
  const roots: RosterNode[] = [];
  for (const member of snapshot.members) {
    const parts = member.catalogPath.split('/');
    for (let index = 0; index < parts.length; index++) {
      const current = parts.slice(0, index + 1).join('/');
      let node = nodes.get(current);
      if (!node) {
        node = { path: current, name: parts[index]!, ...(snapshot.catalogDescriptions[current] ? { description: snapshot.catalogDescriptions[current] } : {}), members: 0, tools: [], mcp: [], modes: [], children: [], leaves: [] };
        nodes.set(current, node);
        if (index === 0) roots.push(node); else nodes.get(parts.slice(0, index).join('/'))!.children.push(node);
      }
      node.members++;
      node.tools = [...new Set([...node.tools, ...member.card.tools])].sort(compareRosterText);
      node.mcp = [...new Set([...node.mcp, ...(member.card.mcp ?? []).map(server => server.server)])].sort(compareRosterText);
      node.modes = [...new Set([...node.modes, member.card.routing?.mode ?? 'legacy'])].sort(compareRosterText);
      if (index === parts.length - 1) node.leaves.push(member);
    }
  }
  for (const node of nodes.values()) { node.children.sort((a, b) => compareRosterText(a.path, b.path)); node.leaves.sort(memberOrder); }
  return roots.sort((a, b) => compareRosterText(a.path, b.path));
}
