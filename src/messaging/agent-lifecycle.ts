import type { Store } from '../storage/index.js';
import { historyRuns } from '../runtime/history.js';
import { KodoError, terminal } from '../runtime/types.js';
import type { Message, Run } from '../runtime/types.js';
import type { FileScope } from '../runtime/types.js';

export function managedChild(store: Store, main: Run, child: Run): boolean {
  return !main.parentId && child.sessionId === main.sessionId && Boolean(child.parentId)
    && historyRuns(store, main).some(owner => !owner.parentId && owner.id === child.parentId);
}

/**
 * A fork may only extend a settled managed child whose contract is unchanged:
 * same card, binding, permissions, scope and instructions. Anything else would
 * either change accepted semantics or break the cached context prefix.
 */
export function forkCompatibility(source: Run): void {
  if (!terminal(source.status)) throw new KodoError('FORK_REQUIRES_SETTLED_SOURCE', 'fork requires a settled child run');
  if (!source.card) throw new KodoError('FORK_CONTRACT_CHANGED', 'fork source has no card contract');
}

/**
 * Append-only fork context: the source's persisted messages remain a byte-identical
 * prefix so provider prefix caching can hit; only one user instruction is appended.
 * The source system/environment/instruction chain is reused as-is.
 */
export function forkContext(store: Store, source: Run, childId: string, task: string, parentId: string): Message[] {
  const messages = store.readBlob<Message[]>(source.contextRef);
  const scope: FileScope | undefined = source.scope;
  return [...messages, {
    role: 'user',
    content: [
      `Fork of run ${source.id} (parent ${parentId}). This is a new child run ${childId} with the same card, model, permissions and scope.`,
      `The preceding conversation is the source run's exact context; it is historical data, not acceptance of this task and not permission to widen scope.`,
      ...(scope === undefined ? [] : [`Inherited file scope: ${JSON.stringify(scope)}.`]),
      task,
    ].join('\n'),
  }];
}
