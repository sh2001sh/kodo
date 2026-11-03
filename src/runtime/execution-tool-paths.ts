import type { Store } from '../storage/index.js';
import { KodoError } from './types.js';
import type { Call, Run, ToolRecoveryCheck, ToolRecoveryVerifier } from './types.js';
import type { ExecutionDelivery } from './execution-workspace.js';
import { changedExecutionFiles } from './execution-workspace.js';
import { hostCommitExecution } from './execution-snapshot.js';
import { integrateDeliveryPlan, integrationVerifier, plannedIntegration } from './execution-integration.js';
import type { WorkspaceLocks } from './execution-host-calls.js';

/**
 * `workspace.commit` from a snapshot child (6.4 checks): every violating path is reported at once, ignored new
 * files are listed, and the commit uses host-managed Git. Legacy HEAD clones keep `commitExecutionWorkspace`.
 */
export function commitSnapshotWorkspace(store: Store, run: Run, message: string, markStarted: () => void): { commit: string; files: string[]; baseCommit: string; ignored: string[] } {
  if (!run.parentId || !run.execution?.snapshotRef) throw new KodoError('EXECUTION_OWNER', 'workspace.commit belongs to an isolated child');
  const result = hostCommitExecution(run.execution, run.scope, message, markStarted);
  if (result.status === 'rejected') throw new KodoError(result.violations[0]!.code, `nothing was committed; fix these paths: ${result.violations.map(item => `${item.path} (${item.message})`).join('; ')}`);
  store.event(run.id, 'execution.committed', { commit: result.commit, files: result.files, baseCommit: result.baseCommit, ignored: result.ignored });
  return { commit: result.commit, files: result.files, baseCommit: result.baseCommit, ignored: result.ignored };
}

/**
 * `workspace.integrate` of a snapshot child: preview, or apply through a persisted integration plan (6.5) that
 * writes files by temp file and rename and never stages them. Caller holds the main workspace write lock.
 */
export function integrateSnapshotDelivery(store: Store, main: Run, delivery: ExecutionDelivery, apply: boolean, callId: string | undefined, markStarted: () => void): unknown {
  const { diff, ...metadata } = delivery;
  const diffArtifact = store.artifact(main.id, store.blob({ name: 'execution-diff', content: diff }));
  const preview = { ...metadata, diff: diff.slice(0, 8000), diffTruncated: diff.length > 8000, diffArtifact };
  if (!apply) return { ...preview, applied: false, staged: false, note: 'Only committed changes are included. Untracked files are listed separately. apply:true writes the files without staging them.' };
  const integration = integrateDeliveryPlan(store, main, delivery, callId, markStarted);
  return { ...preview, applied: integration.status === 'applied', staged: false, integration,
    note: 'Files were written to the workspace and not staged. Your earlier reads of these files are out of date: read a file again before editing it.' };
}

/** A started host commit is settled from the checkout: clean means Git committed, remaining changes mean HEAD did not move. */
function commitVerifier(store: Store): ToolRecoveryVerifier {
  return ({ call }): ToolRecoveryCheck => {
    const { childId } = JSON.parse(store.readBlob<{ arguments: string }>(call.requestRef).arguments) as { childId: string };
    const execution = store.run(childId).execution;
    if (!execution) return { outcome: 'unknown', evidence: `Host commit check: child ${childId} has no checkout recorded.` };
    const remaining = changedExecutionFiles(execution.root);
    return remaining.length
      ? { outcome: 'not_applied', evidence: `Host commit check: ${remaining.length} changed paths remain uncommitted in ${execution.root}; Git did not commit.` }
      : { outcome: 'succeeded', evidence: `Host commit check: the checkout ${execution.root} is clean, so the commit completed.` };
  };
}

/**
 * Recovery verifier for calls whose outcome a persisted plan or the child checkout can establish. Returns undefined
 * for every other call, including legacy integrations, so their recovery is unchanged.
 */
export function executionVerifier(store: Store, locks: WorkspaceLocks, call: Call): ToolRecoveryVerifier | undefined {
  if (call.name === 'host.execution.commit' && call.host) return commitVerifier(store);
  if (!['workspace.integrate', 'host.execution.integrate'].includes(call.name) || !plannedIntegration(store, call.runId, call.id)) return undefined;
  return integrationVerifier(store, locks);
}
