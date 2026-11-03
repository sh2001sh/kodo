import type { Store } from '../storage/index.js';
import { isDeepStrictEqual } from 'node:util';
import { historyRuns } from '../runtime/history.js';
import { attachmentKind } from '../runtime/attachments.js';
import { messageGroups } from '../runtime/context.js';
import { todoMessage } from '../runtime/context-progress.js';
import type { TodoSnapshot } from '../tools/todo.js';
import { KodoError, terminal } from '../runtime/types.js';
import type { Message, Run } from '../runtime/types.js';
import { childIsActive } from './spawn-spec.js';

/** Old continuation chains acquire a stable identity without rewriting their records. */
export function agentIdentity(store: Store, run: Run): string {
  if (run.agentId) return run.agentId;
  let current = run;
  const visited = new Set([current.id]);
  while (current.parentId && current.continuationOf && !visited.has(current.continuationOf)) {
    const source = store.run(current.continuationOf);
    if (source.sessionId !== run.sessionId || source.parentId !== current.parentId || !terminal(source.status)) break;
    if (source.agentId) return source.agentId;
    visited.add(source.id);
    current = source;
  }
  return current.id;
}

export function managedChild(store: Store, main: Run, child: Run): boolean {
  return !main.parentId && child.sessionId === main.sessionId && Boolean(child.parentId)
    && historyRuns(store, main).some(owner => !owner.parentId && owner.id === child.parentId);
}

/** A target may be the stable identity or any historical run belonging to that teammate. */
export function resolveManagedAgent(store: Store, main: Run, target: string): Run {
  const runs = store.listRuns(main.sessionId).filter(run => managedChild(store, main, run));
  const selected = runs.find(run => run.id === target || agentIdentity(store, run) === target);
  if (!selected) throw new KodoError('AGENT_TARGET', 'target must be a child managed by this main run or its main-run predecessors');
  const identity = agentIdentity(store, selected);
  const lineage = runs.filter(run => agentIdentity(store, run) === identity);
  const active = lineage.find(run => childIsActive(store, run));
  if (active) throw new KodoError('AGENT_BUSY', `agent ${identity} has unfinished work in run ${active.id}; send_message for updates or wait for completion`);
  const predecessors = new Set(lineage.map(run => run.continuationOf).filter(Boolean));
  const latest = lineage.filter(run => !predecessors.has(run.id));
  if (latest.length !== 1) throw new KodoError('AGENT_LINEAGE', 'agent has multiple continuation branches; select a new independent agent');
  return latest[0]!;
}

/** Preserve conversation evidence, while regenerating authority and the current task contract. */
export function childFollowupContext(store: Store, source: Run, next: Run): Message[] {
  if (!isDeepStrictEqual(source.binding, next.binding)) throw new KodoError('FOLLOWUP_CONTEXT_CHANGED', 'reusing a teammate preserves its model and context; create a fresh child and explicitly hand off the necessary context for another model');
  const session = store.session(next.sessionId);
  const oldPermissions = [...source.permissions ?? session.permissions].sort();
  const permissions = [...next.permissions ?? session.permissions].sort();
  const scopeKey = (run: Run) => JSON.stringify({ read: run.scope?.read?.toSorted(), write: run.scope?.write?.toSorted() });
  if (JSON.stringify(oldPermissions) !== JSON.stringify(permissions) || scopeKey(source) !== scopeKey(next)) {
    throw new KodoError('FOLLOWUP_CONTEXT_CHANGED', 'permissions or scope changed; create a fresh child with the current task inputs instead of inheriting its previous context');
  }
  const fresh = store.readBlob<Message[]>(next.contextRef);
  const old = store.readBlob<Message[]>(source.contextRef);
  const inherited = historyRuns(store, source);
  const inheritedMethods = new Set(inherited.map(run => `Agent method configuration (subordinate to host rules and user task):\n${run.card.prompt}`));
  const oldTodos = new Set(inherited.flatMap(run => store.events(run.id, { types: ['todo.updated'] })
    .filter(event => event.data.snapshot).map(event => todoMessage(event.data.snapshot as TodoSnapshot).content)));
  const history = old.filter(message => message.role !== 'system' && !['agents', 'project-instructions', 'environment', 'state', 'notice', 'nudge', 'completion-check', 'delivery-audit'].includes(attachmentKind(message) ?? '')
    && !(message.role === 'user' && (inheritedMethods.has(message.content) || oldTodos.has(message.content))));
  messageGroups(history);
  // Completion stores the final answer separately from the conversation preceding it.
  const result = source.resultRef ? store.readBlob<{ text?: string }>(source.resultRef) : undefined;
  if (result?.text && !(history.at(-1)?.role === 'assistant' && history.at(-1)?.content === result.text)) history.push({ role: 'assistant', content: result.text });
  return [...fresh.slice(0, -1), ...history,
    { role: 'user', content: `Previous run ${source.id} ended with status ${source.status}. The preceding conversation is historical context. The following task replaces the previous objective; old reports and completion do not satisfy its acceptance. This run starts with an empty task list; use todo.read for its current revision. Use run IDs when inspecting historical evidence.` },
    fresh.at(-1)!];
}
