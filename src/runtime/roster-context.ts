import { rosterTree } from '../agents/roster.js';
import type { RosterMember, RosterSnapshot } from '../agents/roster.js';
import { attachment } from './attachments.js';
import { estimateTextTokens } from './context-tokens.js';
import type { Message } from './types.js';
import { methodSkillId } from '../extensions/methods.js';

/** Includes wrapper and message protocol fields, not raw source byte counts. */
export const instructionMessageTokens = (message?: Message): number => message ? estimateTextTokens(JSON.stringify(message)) : 0;

function routing(member: RosterMember, inlineMethods: boolean) {
  const card = member.card;
  return { id: card.id, version: card.version, name: card.name, catalog: member.catalogPath,
    execution_modes: card.execution?.modes ?? ['child'],
    ...(inlineMethods && card.execution?.modes.includes('inline') ? { inline_method: { id: methodSkillId(card),
      load: 'skill.load', availability_check: 'skill.list',
      note: 'Load this method into yourself, without spawning a child. Check skill.list for compatibility; named inputs or report contracts may require task activate.' } } : {}),
    use_when: card.routing?.use_when ?? (card.description ? [card.description] : []),
    mode: card.routing?.mode ?? 'legacy', availability: member.availability,
    ...(card.inputs?.length ? { required_slots: card.inputs.filter(field => field.required).map(({ name, kind }) => ({ name, kind })) } : {}),
    ...(card.id === 'kodo/implementer' ? { write_scope: 'Explicit scope.write roots required at spawn.' } : {}) };
}

/** Budgeted view of the immutable snapshot; the complete directory stays independently pageable. */
export function renderRoster(snapshot: RosterSnapshot, budgetTokens: number, inlineMethods = false): { message?: Message; tokens: number; degraded?: 'empty' | 'paging' | 'root'; hiddenMembers: number; hiddenCategories: number } {
  const available = { ...snapshot, members: snapshot.members.filter(member => member.availability === 'available' && (inlineMethods || !member.card.execution || member.card.execution.modes.includes('child'))) };
  const roots = rosterTree(available);
  const queue = [...roots];
  const nodes = [] as typeof roots;
  while (queue.length) { const node = queue.shift()!; nodes.push(node); queue.push(...node.children); }
  const totalMembers = available.members.length;
  const totalCategories = nodes.length;
  const entry = 'Use agent.directory with path and cursor to page the complete frozen catalog; agent.search finds matching members.'
    + (inlineMethods ? ' Inline methods are instructions for your own work: skill.list lists compatible methods and skill.load loads one by id. Only execution_modes containing child support spawn_agent.' : '');
  const wrap = (body: unknown) => attachment('agents', JSON.stringify(body));
  const fits = (message: Message) => instructionMessageTokens(message) <= Math.max(0, budgetTokens);
  const minimal = wrap({ directory: entry });
  if (!fits(minimal)) return { tokens: 0, degraded: 'empty', hiddenMembers: totalMembers, hiddenCategories: totalCategories };
  const members: ReturnType<typeof routing>[] = [];
  const categories: { path: string; description?: string; members: number; tools: string[]; mcp: string[]; modes: string[]; moreCapabilities?: number }[] = [];
  const seen = new Set<string>();
  const render = (virtualRoot = false) => wrap({ title: inlineMethods ? 'Available session agents and inline methods (frozen)' : 'Available session agents (frozen)', digest: snapshot.digest, directory: entry,
    capabilityNote: 'Category capabilities are unions across members; they do not prove one member satisfies all requirements.',
    ...(virtualRoot ? { root: { path: '/', categories: roots.length, members: totalMembers } } : {}),
    members, categories, hidden: { members: totalMembers - members.length, categories: totalCategories - categories.length } });
  if (!fits(render())) return { message: minimal, tokens: instructionMessageTokens(minimal), degraded: 'paging', hiddenMembers: totalMembers, hiddenCategories: totalCategories };
  const addMember = (member: RosterMember) => {
    const key = `${member.card.id}@${member.card.version}`;
    if (seen.has(key)) return true;
    members.push(routing(member, inlineMethods));
    if (!fits(render())) { members.pop(); return false; }
    seen.add(key);
    return true;
  };
  for (const member of available.members.filter(member => member.fixedOrder !== undefined).sort((a, b) => a.fixedOrder! - b.fixedOrder!)) if (!addMember(member)) break;
  // Breadth-first directory nodes follow the declared main members. Leaf details
  // are then filled in the same breadth-first order if room remains.
  for (const node of nodes) {
    const row = { path: node.path, description: node.description, members: node.members, tools: [...node.tools], mcp: [...node.mcp], modes: [...node.modes], moreCapabilities: 0 };
    categories.push(row);
    while (!fits(render()) && (row.tools.length || row.mcp.length || row.modes.length)) {
      if (row.tools.length) row.tools.pop(); else if (row.mcp.length) row.mcp.pop(); else row.modes.pop();
      row.moreCapabilities++;
    }
    if (!fits(render())) { categories.pop(); break; }
  }
  const visiblePaths = new Set(categories.map(node => node.path));
  outer: for (const node of nodes) if (visiblePaths.has(node.path)) for (const member of node.leaves) if (!addMember(member)) break outer;
  const virtualRoot = roots.length > 0 && !roots.some(root => categories.some(node => node.path === root.path));
  let message = render(virtualRoot);
  // Reserve space for the virtual-root summary by dropping the last optional row.
  while (!fits(message) && (categories.length || members.length)) { if (categories.length) categories.pop(); else members.pop(); message = render(virtualRoot); }
  if (!fits(message)) return { message: minimal, tokens: instructionMessageTokens(minimal), degraded: 'paging', hiddenMembers: totalMembers, hiddenCategories: totalCategories };
  return { message, tokens: instructionMessageTokens(message), ...(virtualRoot ? { degraded: 'root' as const } : {}), hiddenMembers: totalMembers - members.length, hiddenCategories: totalCategories - categories.length };
}
