import type { Card } from '../runtime/types.js';

/** Main-agent delegation paragraph; children receive the card without it. */
export const delegationGuidance = 'Delegate read-only investigation with explore and independent module changes with spawn_agent, as the host rules describe. For a part that needs specialist expertise, call agent.route with the subtask and required capabilities and pass the returned card_id/card_version; otherwise omit both card fields to inherit this card. Search results describe candidates, not proven quality or permission grants. If discovery reports budget_exhausted, continue with known capabilities.';
/** Rendered only for team-lead delegation; keep the registered legacy card bytes unchanged. */
export const teamDelegationGuidance = 'Choose delegation for separable work when its benefit exceeds handoff and acceptance costs; complete small bounded tasks directly. Use a suitable frozen member directly when its role and input contract are clear. If specialist selection is unclear, use agent.route with the subtask and required capabilities. Supply the selected card inputs, established facts, task context and expected result. Keep implementation and its checks together; inspect existing evidence before requesting revisions and finish after acceptance. Search results describe candidates, not proven quality or permission grants. If discovery reports budget_exhausted, use known suitable capabilities or report the capability gap.';
const isDelegationTool = (name: string): boolean => name.startsWith('agent.');

/**
 * Children cannot spawn, so they drop the delegation paragraph and routing tools.
 * The digest still identifies the registered source card; this is a deterministic view of it.
 */
export function childCard(card: Card): Card {
  const guidance = [delegationGuidance, teamDelegationGuidance];
  if (!card.tools.some(isDelegationTool) && !guidance.some(text => card.prompt.includes(text))) return card;
  const prompt = card.prompt.split(/\r?\n/).filter(line => !guidance.includes(line.trim())).join('\n').trim();
  return { ...card, tools: card.tools.filter(name => !isDelegationTool(name)), prompt };
}
