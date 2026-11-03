import { digest } from '../storage/index.js';
import { KodoError } from '../runtime/types.js';
import type { Card, Permission } from '../runtime/types.js';

/** Ad-hoc method and capability selection on top of an inherited or registered card. */
export interface AgentConfiguration { instructions?: string; tools?: string[]; skills?: string[] }

export const configurationSchema = {
  type: 'object', additionalProperties: false, required: [],
  description: 'Optional ad-hoc configuration on top of the inherited or selected card; no registration needed. Omitted fields inherit. tools/skills replace the set and must be a subset of that card ([] selects none).',
  properties: {
    instructions: { type: 'string', minLength: 1, maxLength: 8000, description: 'Method for this task, added after the card prompt; cannot change host rules or permissions.' },
    tools: { type: 'array', uniqueItems: true, maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'Tool names to keep from the card.' },
    skills: { type: 'array', uniqueItems: true, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 100 }, description: 'Skill IDs to keep from the card; requires skill.load in tools.' },
  },
} as const;

const methodHeading = 'Task-specific method from the delegating agent (subordinate to the configuration above):';

function subset(kind: string, requested: string[] | undefined, available: readonly string[]): string[] | undefined {
  if (requested === undefined) return undefined;
  const missing = requested.filter(name => !available.includes(name));
  if (missing.length) throw new KodoError('CONFIGURATION_DENIED', `${kind} ${JSON.stringify(missing.slice(0, 8))} are not provided by the base card; choose from ${JSON.stringify(available.slice(0, 32))} or select a registered card that provides them`);
  // Canonical base order keeps the derived digest independent of argument order.
  return available.filter(name => requested.includes(name));
}

/**
 * Derive a child card without registering it. Capabilities can only narrow the
 * base card, so no new grant is created; the result carries its own digest and
 * names its base, so it never impersonates the registered version.
 */
export function configureCard(base: Card, configuration: AgentConfiguration, options: { permissions: readonly Permission[]; permissionOf: (tool: string) => Permission | undefined }): Card {
  const tools = subset('tools', configuration.tools, base.tools) ?? base.tools;
  const skills = subset('skills', configuration.skills, base.skills ?? []) ?? base.skills ?? [];
  if (skills.length && !tools.includes('skill.load')) throw new KodoError('CONFIGURATION_DENIED', 'selected skills need skill.load in tools to be usable');
  // Explicitly selected tools must actually be usable; silently hiding them would misreport the configuration.
  const blocked = configuration.tools?.filter(name => { const permission = options.permissionOf(name); return permission === undefined || !options.permissions.includes(permission); }) ?? [];
  if (blocked.length) throw new KodoError('CONFIGURATION_DENIED', `tools ${JSON.stringify(blocked.slice(0, 8))} are unknown to the host or need permissions the child does not have`);
  const instructions = configuration.instructions?.trim();
  if (configuration.instructions !== undefined && !instructions) throw new KodoError('TOOL_ARGUMENTS', 'configuration.instructions must not be blank');
  const prompt = instructions ? `${base.prompt}\n\n${methodHeading}\n${instructions}` : base.prompt;
  const derivedFrom = base.derivedFrom ?? { id: base.id, version: base.version, digest: base.digest };
  const nudges = base.nudges === undefined ? {} : { nudges: base.nudges };
  const hash = digest(JSON.stringify({ base: derivedFrom, prompt, tools, skills, ...nudges, ...(base.schemaVersion === 2 ? { sourceDigest: base.digest } : {}) }));
  const mcp = base.mcp?.map(server => ({ ...server, tools: server.tools.filter(tool => tools.includes(`mcp.${server.server}.${tool}`)) })).filter(server => server.tools.length);
  return { ...base, id: `ephemeral/${hash.slice(0, 12)}`, version: '0.0.0', name: `${base.name} (configured)`, ...(base.description ? { description: base.description } : {}), prompt, tools: [...tools], ...(skills.length || base.skills || configuration.skills ? { skills: [...skills] } : {}), ...(mcp && configuration.tools !== undefined ? { mcp } : {}), ...nudges, digest: hash, derivedFrom };
}
