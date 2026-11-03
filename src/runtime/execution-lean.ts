import type { Store } from '../storage/index.js';
import { KodoError } from './types.js';
import type { FileScope, Run } from './types.js';
import { captureExecutionSnapshot } from './execution-snapshot.js';
import type { ExecutionSnapshot, HostCommitResult, SnapshotOptions } from './execution-snapshot.js';
import { prepareSnapshotCheckout } from './execution-checkout.js';
import { hostCommitExecution } from './execution-snapshot.js';
import { cleanupSessionExecutions, releaseExecutionCheckout } from './execution-retention.js';
import type { CleanupResult } from './execution-retention.js';
import { failHostCall, finishHostCall, openHostCall, snapshotChild, startHostCall } from './execution-host-calls.js';
import type { WorkspaceLocks } from './execution-host-calls.js';
import { isLeanProfile } from './tool-view.js';

/** The snapshot, host-commit and plan-integration path (6.2–6.5) applies to lean sessions only; legacy sessions keep HEAD clones. */
export function snapshotExecution(store: Store, run: Pick<Run, 'sessionId'>): boolean {
  return isLeanProfile(store.session(run.sessionId).toolProfile);
}

export interface SnapshotRequest { main: Run; nodeId: string; generation: number; childId: string }

/**
 * Capture a pinned snapshot under the main workspace lock (6.2), then prepare its checkout asynchronously
 * under the checkout's own lock. Native writes and write shells cannot overlap the source capture.
 * Returns the `execution` value (with `snapshotRef` and `generation`) for the child run.
 */
export async function snapshotForChild(store: Store, locks: WorkspaceLocks, request: SnapshotRequest, options: SnapshotOptions & { signal?: AbortSignal } = {}): Promise<ExecutionSnapshot> {
  const { main, nodeId, generation, childId } = request;
  if (!snapshotExecution(store, main)) throw new KodoError('EXECUTION_PROFILE', 'snapshot execution is available in lean sessions only');
  const release = await locks.workspaceWriteLock(main.id, options.signal);
  let snapshot: ExecutionSnapshot;
  try {
    const current = store.run(main.id), session = store.session(main.sessionId);
    if (!session.permissions.includes('read') || !(current.permissions ?? session.permissions).includes('read')) throw new KodoError('PERMISSION_DENIED', 'taking a snapshot requires current read permission');
    const sourceRoot = store.session(main.sessionId).workspace;
    try {
      const captured = store.latestEvent(main.id, { types: ['execution.snapshot.captured'], match: { nodeId, generation, childId } });
      if (captured) snapshot = store.readBlob<ExecutionSnapshot>(String(captured.data.snapshotRef));
      else {
        snapshot = captureExecutionSnapshot({ sourceRoot, sessionId: main.sessionId, nodeId, generation, childId }, options);
        store.event(main.id, 'execution.snapshot.captured', { nodeId, generation, childId, snapshotRef: store.blob(snapshot), commit: snapshot.record.commit, root: snapshot.execution.root });
      }
    }
    catch (error) {
      if (error instanceof KodoError && error.code === 'EXECUTION_SNAPSHOT_CHANGED') store.event(main.id, 'execution.snapshot_failed', { nodeId, generation, childId, code: error.code, reason: 'the workspace was modified externally during the snapshot' });
      throw error;
    }
  } finally { release(); }
  // The ref is durable before releasing the source lock. Checkout only reads that immutable snapshot.
  const releaseCheckout = await locks.checkoutWriteLock(main.id, snapshot.execution.root, options.signal);
  const checkoutStarted = Date.now();
  try {
    store.event(main.id, 'execution.checkout.started', { nodeId, generation, childId, commit: snapshot.record.commit, root: snapshot.execution.root });
    await prepareSnapshotCheckout(snapshot, options.signal);
  }
  catch (error) {
    store.event(main.id, 'execution.checkout.failed', { nodeId, generation, childId, durationMs: Date.now() - checkoutStarted, code: error instanceof KodoError ? error.code : 'EXECUTION_CHECKOUT' });
    throw error;
  } finally { releaseCheckout(); }
  store.event(main.id, 'execution.checkout.finished', { nodeId, generation, childId, durationMs: Date.now() - checkoutStarted, reused: snapshot.record.reused.checkout });
  const execution = { ...snapshot.execution, snapshotRef: snapshot.record.ref, generation };
  store.event(main.id, 'execution.snapshot', { nodeId, generation, childId, ...snapshot.record, root: execution.root });
  return { ...snapshot, execution };
}

/**
 * Host commit of a finished snapshot child (6.4), recorded as `host.execution.commit` on the main run.
 * The child's checkout is its own root, so the main workspace lock is not needed; the record still blocks completion.
 */
export function hostCommitChild(store: Store, main: Run, childId: string, scope: FileScope | undefined = store.run(childId).scope): HostCommitResult {
  const { execution } = snapshotChild(store, childId);
  const call = openHostCall(store, main, 'host.execution.commit', { childId, baseCommit: execution.baseCommit }, [execution.root]);
  let result: HostCommitResult;
  try { result = hostCommitExecution(execution, scope, `kodo delivery ${childId}`, () => startHostCall(store, call.id)); }
  catch (error) { throw failHostCall(store, call.id, error); }
  if (result.status === 'rejected') {
    finishHostCall(store, call.id, 'failed', 'not_applied', { error: 'EXECUTION_REJECTED: the checkout changes protected, out-of-scope or non-regular paths', ...result });
    return result;
  }
  finishHostCall(store, call.id, 'succeeded', result.status === 'committed' ? 'applied' : 'not_applied', result, () => {
    if (result.status === 'committed') store.event(main.id, 'execution.committed', { childId, commit: result.commit, baseCommit: result.baseCommit, files: result.files, ignored: result.ignored, host: true });
  });
  return result;
}

function recordFailures(store: Store, runId: string, result: CleanupResult, reason: string): CleanupResult {
  for (const failure of result.failures) store.event(runId, 'execution.cleanup_failed', { ...failure, reason });
  return result;
}

/**
 * Release one child checkout and its snapshot ref (6.3: `task release`, a replaced `redo` generation once its
 * evidence is persisted, dropped and reviewer checkouts). Done-node checkouts are kept until this or session end.
 * Failures become `execution.cleanup_failed` events and never change the node's state.
 */
export async function releaseChildCheckout(store: Store, locks: WorkspaceLocks, main: Run, childId: string, signal?: AbortSignal): Promise<CleanupResult> {
  const { execution } = snapshotChild(store, childId);
  const active = store.listRuns(main.sessionId).find(peer => peer.execution?.root === execution.root && !['completed', 'failed', 'cancelled'].includes(peer.status));
  if (active) throw new KodoError('EXECUTION_ACTIVE', `run ${active.id} still uses this checkout`);
  const release = await locks.workspaceWriteLock(main.id, signal);
  try {
    const result = releaseExecutionCheckout(execution, execution.snapshotRef);
    store.event(main.id, 'execution.released', { childId, root: execution.root, ref: execution.snapshotRef, removed: result.removed });
    return recordFailures(store, main.id, result, 'release');
  } finally { release(); }
}

/** Session end (6.3): delete every snapshot ref and checkout of the session; failures are recorded, not thrown. */
export async function cleanupSessionCheckouts(store: Store, locks: WorkspaceLocks, main: Run, signal?: AbortSignal): Promise<CleanupResult> {
  const release = await locks.workspaceWriteLock(main.id, signal);
  try {
    const result = cleanupSessionExecutions(store.session(main.sessionId).workspace, main.sessionId);
    store.event(main.id, 'execution.session_cleaned', { removed: result.removed.length, failed: result.failures.length });
    return recordFailures(store, main.id, result, 'session_end');
  } finally { release(); }
}
