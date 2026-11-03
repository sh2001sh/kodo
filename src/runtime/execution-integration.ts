import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Store } from '../storage/index.js';
import { KodoError } from './types.js';
import type { Call, Run, ToolRecoveryCheck, ToolRecoveryVerifier } from './types.js';
import { changedExecutionFiles, executionDelivery } from './execution-workspace.js';
import type { ExecutionDelivery } from './execution-workspace.js';
import { applyIntegrationPlan, discardIntegrationStaging, planIntegration, reconcileIntegration } from './execution-integrate.js';
import type { IntegrationPlan } from './execution-integrate.js';
import { workspaceVersion } from './execution-snapshot.js';
import { failHostCall, finishHostCall, newHostCallId, openHostCall, snapshotChild, startHostCall } from './execution-host-calls.js';
import type { WorkspaceLocks } from './execution-host-calls.js';

export const plannedEvent = 'execution.integration.planned';
export interface PlannedIntegration { callId: string | null; childId: string; stagingId: string; planRef: string; artifact: string; files: string[] }
export interface IntegrationResult { status: 'applied' | 'empty'; files: string[]; version: string; changes: { path: string; hash: string | null }[]; checkNote?: string; planArtifact?: string }
export type NodeIntegration = IntegrationResult & { callId: string } | { status: 'conflict'; callId: string; files: string[]; message: string };

/** Staging directories accept `[a-zA-Z0-9-]` only; model tool call ids do not, so they are hashed. */
const stagingId = (callId: string): string => /^[a-zA-Z0-9-]+$/u.test(callId) ? callId : `call-${createHash('sha256').update(callId).digest('hex').slice(0, 40)}`;
const sourceOf = (delivery: ExecutionDelivery) => ({ root: delivery.root, baseCommit: delivery.baseCommit, commit: delivery.commit, diff: delivery.diff });

/** Persist the plan (6.5 step 3): content-addressed blob plus an artifact, linked to the call by an event. */
function persistPlan(store: Store, main: Run, childId: string, callId: string | null, plan: IntegrationPlan): PlannedIntegration {
  const planRef = store.blob(plan);
  const record: PlannedIntegration = { callId, childId, stagingId: plan.callId, planRef, artifact: store.artifact(main.id, planRef), files: plan.files.map(file => file.path) };
  store.event(main.id, plannedEvent, { ...record });
  return record;
}

/** Step 5: results and the external-change record. The main run's file observations are deliberately left untouched (4.3). */
function integrated(store: Store, main: Run, delivery: ExecutionDelivery, plan: IntegrationPlan, version: string, planned: PlannedIntegration | undefined, recovered = false): IntegrationResult {
  const changes = plan.files.map(file => ({ path: file.path, hash: file.post.exists ? file.post.hash! : null }));
  // A released checkout has no version left to compare; the note then stays conservative.
  const childVersion = existsSync(delivery.root) ? workspaceVersion(delivery.root) : null;
  const checkNote = childVersion === version ? undefined : 'Child checks ran on the snapshot version; the integrated main workspace has not been verified yet.';
  store.event(main.id, 'execution.integrated', { childId: delivery.runId, baseCommit: delivery.baseCommit, commit: delivery.commit, files: plan.files.map(file => file.path), version, childVersion, changes, ...(planned ? { callId: planned.callId, planRef: planned.planRef } : {}), ...(recovered ? { recovered: true } : {}) });
  return { status: 'applied', files: changes.map(change => change.path), version, changes, ...(checkNote ? { checkNote } : {}), ...(planned ? { planArtifact: planned.artifact } : {}) };
}

/**
 * Plan-based integration of a settled snapshot child from the main run's own `workspace.integrate` call.
 * The call record already exists in `not_started`; a conflict throws before any write. Caller holds the main write lock.
 */
export function integrateDeliveryPlan(store: Store, main: Run, delivery: ExecutionDelivery, callId: string | undefined, markStarted: () => void): IntegrationResult {
  snapshotChild(store, delivery.runId);
  const result = planIntegration(sourceOf(delivery), delivery.sourceRoot, stagingId(callId ?? newHostCallId()));
  if (result.status === 'empty') return { status: 'empty', files: [], version: workspaceVersion(delivery.sourceRoot), changes: [] };
  if (result.status === 'conflict') {
    store.event(main.id, 'execution.integration.conflict', { childId: delivery.runId, files: result.files, message: result.message });
    throw new KodoError('EXECUTION_CONFLICT', `the delivery does not apply to the current workspace (${result.files.join(', ')}); the workspace was not changed: ${result.message}`);
  }
  const planned = store.transaction(() => persistPlan(store, main, delivery.runId, callId ?? null, result.plan));
  const applied = applyIntegrationPlan(result.plan, markStarted);
  return integrated(store, main, delivery, result.plan, applied.version, planned);
}

export type PreparedIntegration =
  | { status: 'planned' | 'empty'; call: Call; delivery: ExecutionDelivery; plan?: IntegrationPlan; planned?: PlannedIntegration }
  | { status: 'conflict'; callId: string; files: string[]; message: string };

/**
 * Steps 1–3 of a host integration: compute expected post-images in staging, then open the
 * `host.execution.integrate` call (`not_started`) and persist the plan in one transaction. Caller holds the main write lock.
 */
export function prepareIntegration(store: Store, main: Run, childId: string): PreparedIntegration {
  const delivery = executionDelivery(store, main, snapshotChild(store, childId).id);
  const id = newHostCallId();
  const args = { childId, baseCommit: delivery.baseCommit, commit: delivery.commit };
  const result = planIntegration(sourceOf(delivery), delivery.sourceRoot, id);
  if (result.status === 'conflict') {
    const call = openHostCall(store, main, 'host.execution.integrate', args, [delivery.sourceRoot], () => store.event(main.id, 'execution.integration.conflict', { childId, files: result.files, message: result.message }), id);
    finishHostCall(store, call.id, 'failed', 'not_applied', { error: `EXECUTION_CONFLICT: ${result.message}`, files: result.files, notStarted: true });
    return { status: 'conflict', callId: call.id, files: result.files, message: result.message };
  }
  let planned: PlannedIntegration | undefined;
  const plan = result.status === 'planned' ? result.plan : undefined;
  const call = openHostCall(store, main, 'host.execution.integrate', args, [delivery.sourceRoot], opened => { if (plan) planned = persistPlan(store, main, childId, opened.id, plan); }, id);
  return { status: result.status, call, delivery, ...(plan ? { plan } : {}), ...(planned ? { planned } : {}) };
}

/** Steps 4–5: mark started, write post-images by temp file and rename, verify, settle the call. Caller holds the main write lock. */
export function applyPreparedIntegration(store: Store, main: Run, prepared: Exclude<PreparedIntegration, { status: 'conflict' }>): NodeIntegration {
  const { call, delivery, plan, planned } = prepared;
  try {
    const outcome: IntegrationResult = plan ? integrated(store, main, delivery, plan, applyIntegrationPlan(plan, () => startHostCall(store, call.id)).version, planned)
      : { status: 'empty', files: [], version: workspaceVersion(delivery.sourceRoot), changes: [] };
    finishHostCall(store, call.id, 'succeeded', outcome.status === 'applied' ? 'applied' : 'not_applied', outcome);
    return { ...outcome, callId: call.id };
  } catch (error) { throw failHostCall(store, call.id, error); }
}

/** Host-owned integration (6.5) recorded as `host.execution.integrate` on the main run. Caller holds the main write lock. */
export function integrateNodeLocked(store: Store, main: Run, childId: string): NodeIntegration {
  const prepared = prepareIntegration(store, main, childId);
  return prepared.status === 'conflict' ? prepared : applyPreparedIntegration(store, main, prepared);
}

/** {@link integrateNodeLocked} under the main workspace write lock, queued behind running write shells. */
export async function integrateNode(store: Store, locks: WorkspaceLocks, main: Run, childId: string, signal?: AbortSignal): Promise<NodeIntegration> {
  const release = await locks.workspaceWriteLock(main.id, signal);
  try { return integrateNodeLocked(store, store.run(main.id), childId); }
  finally { release(); }
}

/** The persisted plan of a call, if it reached step 3. */
export function plannedIntegration(store: Store, runId: string, callId: string): { record: PlannedIntegration; plan: IntegrationPlan } | undefined {
  const event = store.latestEvent(runId, { types: [plannedEvent], match: { callId } });
  if (!event) return undefined;
  const record = event.data as unknown as PlannedIntegration;
  return { record, plan: store.readBlob<IntegrationPlan>(record.planRef) };
}

export type IntegrationRecovery = { status: 'applied'; completed: string[]; result: IntegrationResult } | { status: 'unknown'; files: string[] };

/**
 * Recover a started integration from its persisted plan (6.5): all post-images → applied; each file at its pre- or
 * post-image → complete the rest, then applied; anything else → unknown, without writing. Caller holds the main write lock.
 */
export function reconcileIntegrationCall(store: Store, main: Run, callId: string): IntegrationRecovery {
  const found = plannedIntegration(store, main.id, callId);
  if (!found) throw new KodoError('EXECUTION_PLAN', `call ${callId} has no persisted integration plan`);
  const outcome = reconcileIntegration(found.plan, store.session(main.sessionId).workspace);
  if (outcome.status === 'unknown') {
    store.event(main.id, 'execution.integration.unknown', { callId, childId: found.record.childId, files: outcome.files });
    return outcome;
  }
  const { execution } = snapshotChild(store, found.record.childId);
  const delivery = { runId: found.record.childId, root: execution.root, sourceRoot: execution.sourceRoot, baseCommit: found.plan.baseCommit, commit: found.plan.commit, files: found.record.files, diff: '', untracked: [] };
  return { status: 'applied', completed: outcome.completed, result: integrated(store, main, delivery, found.plan, outcome.version, found.record, true) };
}

export type HostCallRecovery = { callId: string; name: string; status: 'reintegrate' | 'recommit' | 'committed' | 'applied' | 'unknown' };
const unsettled = (call: Call): boolean => Boolean(call.host) && ['running', 'planned', 'unknown'].includes(call.status);

/** Settle one interrupted host integration call; caller holds the main write lock. */
function recoverIntegrationCall(store: Store, main: Run, call: Call): HostCallRecovery['status'] {
  if (call.effectState === 'not_started') {
    discardIntegrationStaging(store.session(main.sessionId).workspace, plannedIntegration(store, main.id, call.id)?.record.stagingId ?? call.id);
    finishHostCall(store, call.id, 'cancelled', 'not_applied', { error: 'HOST_INTERRUPTED: integration had not started; the workspace was not changed', notStarted: true, reintegrate: true });
    return 'reintegrate';
  }
  if (!plannedIntegration(store, main.id, call.id)) return 'unknown';
  const outcome = reconcileIntegrationCall(store, main, call.id);
  if (outcome.status === 'unknown') finishHostCall(store, call.id, 'unknown', 'unknown', { error: `UNKNOWN_WRITE: files changed outside the integration plan: ${outcome.files.join(', ')}`, files: outcome.files });
  else finishHostCall(store, call.id, 'succeeded', 'applied', { ...outcome.result, completed: outcome.completed, recovered: true });
  return outcome.status;
}

/**
 * Startup recovery for host side-effect calls on a main run: not started → re-integrate (or re-commit);
 * started integration → applied, completed or unknown from the plan; started commit → checked in the checkout.
 */
export async function recoverHostCalls(store: Store, locks: WorkspaceLocks, main: Run, signal?: AbortSignal): Promise<HostCallRecovery[]> {
  const pending = store.calls(main.id).filter(call => unsettled(call) && call.name !== 'host.task.check');
  if (!pending.length) return [];
  const release = await locks.workspaceWriteLock(main.id, signal);
  try {
    return pending.map(call => ({ callId: call.id, name: call.name, status: call.name === 'host.execution.integrate' ? recoverIntegrationCall(store, main, call) : recoverCommitCall(store, call) }));
  } finally { release(); }
}

/** A host commit is local to the child checkout: a clean checkout means it finished; otherwise it can run again. */
function recoverCommitCall(store: Store, call: Call): HostCallRecovery['status'] {
  const { childId } = JSON.parse(store.readBlob<{ arguments: string }>(call.requestRef).arguments) as { childId: string };
  const child = store.run(childId);
  if (!child.execution) throw new KodoError('EXECUTION_OWNER', `host commit call ${call.id} has no child checkout`);
  // A Git commit is atomic: a clean checkout means it happened, remaining changes mean HEAD did not move.
  if (call.effectState !== 'not_started' && !changedExecutionFiles(child.execution.root).length) {
    finishHostCall(store, call.id, 'succeeded', 'applied', { recovered: true, note: 'the checkout is clean after the interrupted host commit' });
    return 'committed';
  }
  finishHostCall(store, call.id, 'cancelled', 'not_applied', { error: 'HOST_INTERRUPTED: the host commit did not finish; it can run again', notStarted: call.effectState === 'not_started', recommit: true });
  return 'recommit';
}

/** Same text the recovery manager uses for effects without a verifier, so legacy calls observe nothing new. */
const noVerifier = 'No automatic verifier exists for this effect. Explicit user verification is required.';

/**
 * Recovery verifier for plan-backed integration calls (`workspace.integrate` on a snapshot child, and
 * `host.execution.integrate`): completes a partial apply from the plan under the main write lock. Calls without a
 * persisted plan, including every legacy integration, stay unknown with the default evidence.
 */
export function integrationVerifier(store: Store, locks: WorkspaceLocks): ToolRecoveryVerifier {
  return async ({ run, call, signal }): Promise<ToolRecoveryCheck> => {
    if (!plannedIntegration(store, run.id, call.id)) return { outcome: 'unknown', evidence: noVerifier };
    const release = await locks.workspaceWriteLock(run.id, signal);
    try {
      const outcome = reconcileIntegrationCall(store, run, call.id);
      if (outcome.status === 'unknown') return { outcome: 'unknown', evidence: `Integration plan check: files differ from both the planned pre- and post-images: ${outcome.files.join(', ')}. Nothing was written.` };
      return { outcome: 'succeeded', evidence: `Integration plan check: every planned file now matches its post-image${outcome.completed.length ? `; completed ${outcome.completed.join(', ')} from the plan` : ''}.`, result: { ...outcome.result, completed: outcome.completed, recovered: true } };
    } finally { release(); }
  };
}
