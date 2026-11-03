import type { Store } from '../storage/index.js';
import type { Message, Run } from './types.js';
import { KodoError } from './types.js';
import { createExecutionWorkspace, discardExecutionWorkspace, executionSession } from './execution-workspace.js';
import { prepareInstructionContext } from './instruction-layer.js';

export const executionContext = (execution: NonNullable<Run['execution']>): string => `Host execution checkout: ${JSON.stringify(execution)}. ${execution.snapshotRef
  ? 'This checkout contains the captured workspace snapshot, including eligible uncommitted changes. Later parent or sibling edits are not automatically visible. The host checks, commits and integrates the delivery; do not commit yourself.'
  : 'This independent checkout contains the committed baseline only, not untracked or uncommitted files. Use workspace.commit for a recorded delivery; the parent integrates explicitly.'} A checkout is not an OS sandbox.`;

/** First admission only: waiting tasks never snapshot a prerequisite's old HEAD. */
export function preparePendingExecution(store: Store, run: Run): Run | undefined {
  if (!run.executionPending) return run;
  if (run.execution || !run.parentId || run.step > 0 || store.calls(run.id).some(call => call.kind === 'model')) throw new KodoError('EXECUTION_STATE', 'pending execution checkout requires an unstarted child');
  let execution: NonNullable<Run['execution']>;
  try { execution = createExecutionWorkspace(store, store.run(run.parentId), run.id); }
  catch (error) {
    if (!(error instanceof KodoError) || error.code !== 'EXECUTION_DIRTY') throw error;
    const id = `execution-blocked:${run.id}`;
    if (!store.message(id)) store.transaction(() => {
      store.putMessage({ id, sessionId: run.sessionId, from: 'runtime', to: run.parentId!, kind: 'event', content: JSON.stringify({ reason: 'execution_blocked', runId: run.id, code: error.code, note: 'The isolated task is queued until the prerequisite changes are integrated and committed. Commit the intended tracked state, then its checkout can be prepared; no model request has started.' }) });
      store.event(run.id, 'execution.blocked', { code: error.code, reason: 'source_has_uncommitted_tracked_changes' });
    });
    return;
  }
  try {
    return store.transaction(() => {
      const packet = store.readBlob<Message[]>(run.contextRef).find(message => message.role === 'user')?.content ?? run.objective;
      const next = { ...run, execution, executionPending: undefined };
      const prepared = prepareInstructionContext(store, { ...next, objective: `${packet}\n${executionContext(execution)}` }, executionSession(store, next), { global: run.executionPending!.global });
      store.updateRun(run.id, { execution, executionPending: undefined, contextRef: store.blob(prepared.messages), instructions: prepared.instructions });
      store.event(run.id, 'execution.prepared', { ...execution, ...(run.todo ? { todoId: run.todo.id, generation: run.todo.generation, dependencies: run.todo.dependencies } : {}) });
      return store.run(run.id);
    });
  } catch (error) {
    discardExecutionWorkspace(execution);
    throw error;
  }
}
