import { digest } from '../storage/index.js';
import type { Store } from '../storage/index.js';
import type { Card, FileScope, Permission, Run, ToolSpec } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';
import { intersectFileScopes, normalizeFileScope, resolveScopeVariables } from '../runtime/scope.js';

export interface AgentOverlay {
  instructions?: string;
  tools?: string[];
  skills?: string[];
  mcp?: { server: string; tools: string[] }[];
  scope?: FileScope;
  permissions?: Permission[];
  inputs_required?: string[];
}
const names = { type: 'array', uniqueItems: true, maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 100 } };
export const deriveAgentSpec: ToolSpec & { main: true } = {
  name: 'agent.derive', main: true,
  description: 'Create a session-only tmp: handle from one frozen roster member. The overlay appends method instructions and only narrows tools, skills, MCP tools, permissions and path roots. inputs_required can make declared optional inputs mandatory. Cannot derive from another temporary card; cannot add a missing capability.',
  parameters: { type: 'object', additionalProperties: false, required: ['base', 'overlay'], properties: {
    base: { type: 'string', minLength: 1, maxLength: 256 },
    overlay: { type: 'object', additionalProperties: false, properties: {
      instructions: { type: 'string', minLength: 1, maxLength: 8000 }, tools: names, skills: names,
      mcp: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['server', 'tools'], properties: { server: { type: 'string', minLength: 1, maxLength: 100 }, tools: names } } },
      scope: { type: 'object', additionalProperties: false, properties: { read: names, write: names } },
      permissions: { type: 'array', uniqueItems: true, items: { enum: ['read', 'write', 'exec'] } }, inputs_required: names,
    } },
  } },
};

/** One immutable source resolver shared by spawn and derive. */
export function resolveAgentReference(store: Store, run: Run, reference: string): Card {
  if (reference.startsWith('tmp:')) {
    const derived = store.derivedAgents.get(run.sessionId, reference);
    if (!derived) throw new KodoError('CARD_NOT_FOUND', 'temporary agent does not belong to this session');
    return derived.card;
  }
  const match = /^([^@]+)(?:@(\d+\.\d+\.\d+))?$/.exec(reference);
  if (!match) throw new KodoError('CARD_VERSION', 'agent must name id@version or a temporary handle');
  const [, id, version] = match;
  if (store.cards.rosterSnapshot(run.sessionId)) {
    const member = store.cards.rosterMember(run.sessionId, id!, version);
    if (member) {
      if (member.availability !== 'available') throw new KodoError('CARD_UNAVAILABLE', member.reasons.join('; '));
      return member.card;
    }
    // Published inline methods live in the session method catalog, not in the frozen roster.
    const published = store.session(run.sessionId).methodCards?.find(item => item.id === id && (version === undefined || item.version === version));
    if (published) {
      const card = store.card(published.id, published.version);
      if (card?.digest === published.digest) return card;
      throw new KodoError('CARD_NOT_FOUND', 'the session method version is no longer registered');
    }
    throw new KodoError('CARD_NOT_FOUND', 'agent is not a member of this session snapshot');
  }
  if (!version) throw new KodoError('CARD_VERSION', 'an exact registered version is required without a session roster');
  return store.card(id!, version);
}

const select = (kind: string, requested: string[] | undefined, available: string[]): string[] => {
  if (requested?.some(name => !available.includes(name))) throw new KodoError('SCOPE_ESCALATION', `${kind} must be a subset of the base card`);
  return [...new Set(requested ?? available)].sort();
};

/** Persist only canonical content; its hash is both identity and idempotency key. */
export function deriveAgent(store: Store, run: Run, baseReference: string, overlay: AgentOverlay): { handle: string; digest: string } {
  if (run.parentId) throw new KodoError('ROLE_DENIED', 'only the main run can derive an agent');
  if (baseReference.startsWith('tmp:')) throw new KodoError('DERIVATION_DEPTH', 'temporary agents cannot be derived again');
  const base = resolveAgentReference(store, run, baseReference);
  if (base.derivedFrom || base.derivation?.allowed === false) throw new KodoError('DERIVATION_DENIED', 'base card does not allow derivation');
  const session = store.session(run.sessionId);
  const tools = select('tools', overlay.tools, base.tools);
  const skills = select('skills', overlay.skills, base.skills ?? []);
  const permissions = select('permissions', overlay.permissions, base.constraints?.permissions ?? ['read', 'write', 'exec']) as Permission[];
  const scope = intersectFileScopes(normalizeFileScope(overlay.scope ?? {}, resolveScopeVariables(base.constraints?.scope, session.projectRoots)));
  const instructions = overlay.instructions?.trim();
  if (overlay.instructions !== undefined && !instructions) throw new KodoError('TOOL_ARGUMENTS', 'instructions must not be blank');
  const mcp = (overlay.mcp ?? base.mcp ?? []).map(server => {
    const original = base.mcp?.find(item => item.server === server.server);
    if (!original) throw new KodoError('SCOPE_ESCALATION', 'MCP server must be declared by the base card');
    return { server: server.server, tools: select('MCP tools', server.tools, original.tools) };
  }).sort((left, right) => left.server.localeCompare(right.server, 'en'));
  if (new Set(mcp.map(server => server.server)).size !== mcp.length) throw new KodoError('TOOL_ARGUMENTS', 'MCP servers must be unique');
  const required = select('inputs_required', overlay.inputs_required, (base.inputs ?? []).map(field => field.name));
  const requiredNames = overlay.inputs_required === undefined ? [] : required;
  const inputs = base.inputs?.map(field => ({ ...field, ...(requiredNames.includes(field.name) ? { required: true } : {}) }));
  const baseIdentity = { id: base.id, version: base.version, digest: base.digest };
  // Canonical effective configuration makes reordered lists and omitted inherited sets identical.
  const normalized = { ...(instructions ? { instructions } : {}), tools, skills, mcp, permissions, scope, inputs_required: inputs?.filter(field => field.required).map(field => field.name).sort() ?? [] };
  const hash = digest(JSON.stringify({ base: baseIdentity, overlay: normalized }));
  const handle = `tmp:${base.id.split('/').at(-1)!}-${hash.slice(0, 16)}`;
  const card: Card = { ...base, id: handle, version: '0.0.0', digest: hash, tools, skills, mcp,
    prompt: instructions ? `${base.prompt}\n\nTask-specific method (subordinate to the base card and host rules):\n${instructions}` : base.prompt,
    constraints: { ...base.constraints, permissions, scope }, ...(inputs ? { inputs } : {}), derivedFrom: baseIdentity };
  const record = store.derivedAgents.put({ sessionId: run.sessionId, handle, base: baseIdentity, digest: hash, overlay: normalized, card, createdByRun: run.id });
  if (!store.hasEvent(run.id, { types: ['agent.derived'], match: { handle } })) store.event(run.id, 'agent.derived', { handle, digest: hash, base: baseIdentity });
  return { handle: record.handle, digest: record.digest };
}
