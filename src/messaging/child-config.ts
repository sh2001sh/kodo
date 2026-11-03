import type { Store } from '../storage/index.js';
import { childCard } from '../agents/child-card.js';
import { configureCard } from '../agents/configuration.js';
import type { AgentConfiguration } from '../agents/configuration.js';
import { resolveAgentReference } from '../agents/derive.js';
import { explorationCard } from '../runtime/exploration.js';
import { KodoError } from '../runtime/types.js';
import type { Card, Permission, Run } from '../runtime/types.js';

interface ResolveOptions { run: Run; readOnlyExploration: boolean; permissions: readonly Permission[]; permissionOf: (tool: string) => Permission | undefined }

/**
 * One resolver for every child: inherited or registered base card, the child view
 * without delegation tools, the read-only exploration view, then any ad-hoc
 * configuration. Configuration can only narrow what the resolved base provides.
 */
export function resolveChildCard(store: Store, inherited: Card, args: Record<string, unknown>, options: ResolveOptions): Card {
  let card = inherited;
  if (args.agent || args.card_id) {
    try { card = resolveAgentReference(store, options.run, args.agent as string ?? `${args.card_id as string}@${args.card_version as string}`); }
    catch (error) {
      if (!(error instanceof KodoError) || error.code !== 'CARD_NOT_FOUND') throw error;
      throw new KodoError('CARD_NOT_FOUND', 'card version is not registered. Select a known registered ID/version, or omit both card_id and card_version to inherit the current card. Naming a card does not create it.');
    }
  }
  if (card.execution && !card.execution.modes.includes('child')) throw new KodoError('CARD_EXECUTION', 'this card supports inline method loading only; use skill.load instead of an independent run');
  // Dependencies are explicit on v2 cards. Materialize their host tool names only in the child view.
  if (card.schemaVersion === 2) card = { ...card, tools: [...new Set([...card.tools,
    ...(card.mcp ?? []).flatMap(server => server.tools.map(tool => `mcp.${server.server}.${tool}`)),
    ...(card.skills?.length ? ['skill.list', 'skill.load'] : []),
  ])] };
  const configuration = args.configuration as AgentConfiguration | undefined;
  if (options.readOnlyExploration) return explorationChild(card, configuration, options);
  card = childCard(card);
  if (card.routing?.mode === 'read' || card.routing?.mode === 'review') {
    const review = card.routing.mode === 'review';
    card = { ...card, tools: card.tools.filter(tool => options.permissionOf(tool) === 'read' || (review && tool === 'verify.run')) };
  }
  return configuration ? configureCard(card, configuration, options) : card;
}

/**
 * Explore keeps its native read-only view by default. An explicit selection may
 * add read-permission tools and skills of the base card (for example LSP, skills
 * or a host-registered read-only MCP tool); every selected tool is checked against
 * the read-only child permission, so a write or exec capability fails creation.
 */
function explorationChild(card: Card, configuration: AgentConfiguration | undefined, options: ResolveOptions): Card {
  // The legacy explore tool has its own task/report contract; it does not request a specialist role.
  if (card.schemaVersion === 2) card = { ...card, inputs: [], report: [] };
  const view = explorationCard(card);
  if (!configuration) return childCard(view);
  const selected = { ...configuration, tools: configuration.tools ?? view.tools, skills: configuration.skills ?? [] };
  const configured = configureCard(childCard(card), selected, options);
  if (!configured.tools.includes('file.read')) throw new KodoError('EXPLORATION_CAPABILITY', 'an explore configuration must keep native file.read so reports can cite read sources');
  return configured;
}
