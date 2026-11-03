import type { Store } from '../storage/index.js';
import { recoveryHistoryRuns } from './history.js';
import { terminal } from './types.js';
import type { Run } from './types.js';

/** Lifecycle evidence is distinct from acceptance of the child's deliverable. */
export function childCompletionState(store: Store, run: Run) {
  const owners = run.parentId ? [] : recoveryHistoryRuns(store, run);
  const ownerIds = new Set(owners.map(owner => owner.id));
  const children = store.listRuns(run.sessionId).filter(child => child.parentId && ownerIds.has(child.parentId));
  const inspected = new Set<string>();
  if (children.some(child => child.status === 'failed')) {
    for (const owner of owners) for (const call of store.calls(owner.id)) {
      if (call.kind !== 'tool' || call.name !== 'inspect_run' || call.status !== 'succeeded' || !call.resultRef) continue;
      const request = store.readBlob<{ arguments: string }>(call.requestRef);
      const args = JSON.parse(request.arguments) as { run_id?: string; call_id?: string; call_ids?: string[]; section?: string };
      // A prior running-state inspection, or only an individual call, does not
      // acknowledge the failure. The atomic recorded result proves timing.
      if (args.call_id || args.call_ids) continue;
      const result = store.readBlob<{ runId?: string; status?: string }>(call.resultRef);
      if (result.status === 'failed' && result.runId === args.run_id) inspected.add(result.runId!);
    }
  }
  const outcomes = children.filter(child => child.status === 'failed' || child.status === 'cancelled').map(child => ({ runId: child.id, status: child.status, ...(child.status === 'failed' ? { acknowledged: inspected.has(child.id) } : {}) }));
  const interrupted = children.filter(child => child.status === 'interrupted').map(child => child.id);
  const unhandled = outcomes.filter(child => child.status === 'failed' && !child.acknowledged).map(child => child.runId);
  const feedback = [
    interrupted.length ? `CHILDREN_INCOMPLETE: interrupted children ${interrupted.join(', ')} need host recovery for fault interruptions or cancel_agent to cancel. Waiting alone does not resume them.` : '',
    unhandled.length ? `CHILDREN_INCOMPLETE: failed children ${unhandled.join(', ')} need inspect_run without call_id after failure. Cancelling an already failed run does not resolve it. Inspection acknowledges failure, not acceptance; disclose incomplete work in the final answer.` : '',
  ].filter(Boolean).join('\n');
  return { active: children.filter(child => !terminal(child.status) && child.status !== 'interrupted').map(child => child.id), interrupted,
    feedback: feedback || undefined,
    result: outcomes.length ? { status: outcomes.some(child => !child.acknowledged) ? 'partial' : 'settled', outcomes } : undefined };
}
