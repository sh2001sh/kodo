import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Store } from '../storage/index.js';
import type { Tools } from '../tools/index.js';
import type { Mailbox } from '../messaging/index.js';
import { defaultBudget, KodoError, terminal } from './types.js';
import type { Run } from './types.js';
import type { TaskCheckout, TaskNode } from './task-graph.js';
import { readTaskGraph, requireTaskNode } from './task-graph.js';
import type { TaskDispatchHost } from './task-dispatch.js';
import { snapshotCheckoutRoot, snapshotRef } from './execution-snapshot.js';
import { snapshotForChild } from './execution-lean.js';
import { releaseExecutionCheckout } from './execution-retention.js';
import type { WorkspaceLocks } from './execution-host-calls.js';
import { sharedScopeHolder, taskWorkspaceMode } from './task-workspace.js';

export interface TaskRuntimeHost { store: Store; tools: Tools; mailbox: Mailbox; busy(runId: string): boolean; cancel(runId: string): void; interrupt(runId: string): void; waitForStop(runId: string): Promise<Run> }
const snapshotNode = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 32);

/** Dispatch owns names before IO; snapshot records make the second transaction recoverable. */
export function taskExecutionHost(host: TaskRuntimeHost, main: Run, signal?: AbortSignal, locks: WorkspaceLocks = host.tools): TaskDispatchHost {
  const { store, tools, mailbox } = host;
  const session = store.session(main.sessionId);
  const executions = new Map<string, Run['execution']>();
  const quota = session.budget.maxActiveChildren ?? defaultBudget.maxActiveChildren!;
  const shared = taskWorkspaceMode(store, main.id) === 'shared';
  // Serialize only capture admission within this batch. Checkout IO runs after release and may overlap.
  let captures = Promise.resolve();
  const captureLocks: WorkspaceLocks = { checkoutWriteLock: (id, root, abort) => locks.checkoutWriteLock(id, root, abort), async workspaceWriteLock(id, abort) {
    const previous = captures;
    let next!: () => void;
    captures = new Promise<void>(resolve => { next = resolve; });
    await previous;
    try {
      abort?.throwIfAborted();
      const release = await locks.workspaceWriteLock(id, abort);
      return () => { try { release(); } finally { next(); } };
    } catch (error) { next(); throw error; }
  } };
  return {
    quota,
    otherActive: () => {
      const running = new Set(readTaskGraph(store, main.id).nodes.filter(node => node.state === 'running').map(node => node.runId));
      return store.listRuns(main.sessionId).filter(child => child.parentId === main.id && !running.has(child.id)
        && (host.busy(child.id) || tools.backgroundRunning(child.id) || !terminal(child.status) && child.status !== 'interrupted')).length;
    },
    allocateRunId: () => randomUUID(),
    checkoutFor: (node, id) => ({ snapshotRef: snapshotRef(main.sessionId, snapshotNode(node.id), node.generation), path: snapshotCheckoutRoot(session.workspace, main.sessionId, id), ...(shared || node.role === 'explorer' ? { shared: true } : {}) }),
    holdReason: (node, active) => {
      const holder = shared ? sharedScopeHolder(node, active) : undefined;
      return holder ? `Waiting for task ${holder} to finish: their write scopes overlap in the shared workspace.` : undefined;
    },
    async ensureCheckout(preparation) {
      signal?.throwIfAborted();
      const node = requireTaskNode(readTaskGraph(store, main.id), preparation.nodeId);
      const current = store.run(main.id);
      if (terminal(current.status) || current.cancelRequested || current.interruptRequested) throw new KodoError('TASK_OWNER_ENDED', 'the task owner is no longer running');
      if (shared || (node.role ?? 'implementer') === 'explorer') return;
      if (preparation.reuseCheckout) {
        const previous = store.run(preparation.continuation!.fromRunId);
        if (!previous.execution || !existsSync(previous.execution.root)) throw new KodoError('EXECUTION_RELEASED', 'the retained checkout is unavailable; use redo');
        if (host.busy(previous.id) || tools.hasInFlightEffects(previous.id) || tools.backgroundRunning(previous.id)) throw new KodoError('EXECUTION_ACTIVE', 'the previous task still has active effects');
        const integrated = store.latestEvent(main.id, { types: ['execution.integrated'], match: { childId: previous.id } });
        // An already delivered prefix must not be applied a second time on resume.
        executions.set(preparation.runId, { ...previous.execution, ...(integrated ? { baseCommit: String(integrated.data.commit) } : {}) });
        return;
      }
      const recorded = store.latestEvent(main.id, { types: ['execution.snapshot'], match: { childId: preparation.runId } });
      if (recorded) {
        if (!existsSync(preparation.checkout.path)) throw new KodoError('EXECUTION_RELEASED', 'a prepared snapshot checkout is missing');
        executions.set(preparation.runId, { kind: 'clone', root: preparation.checkout.path, sourceRoot: session.workspace, baseCommit: String(recorded.data.commit), snapshotRef: preparation.checkout.snapshotRef, generation: preparation.generation });
        return;
      }
      const snapshot = await snapshotForChild(store, captureLocks, { main, nodeId: snapshotNode(node.id), generation: node.generation, childId: preparation.runId }, { signal });
      executions.set(preparation.runId, snapshot.execution);
    },
    discardCheckout: checkout => discardTaskCheckout(host, main, checkout, locks, signal),
    startRun(preparation, node) {
      const current = store.run(main.id);
      if (terminal(current.status) || current.cancelRequested || current.interruptRequested) throw new KodoError('TASK_OWNER_ENDED', 'the task owner stopped before dispatch');
      mailbox.spawnTaskHost(main.id, { runId: preparation.runId, nodeId: node.id, generation: node.generation, role: node.role ?? 'implementer', goal: node.goal,
        start: node.start, scope: node.scope, check: node.check, acceptance: node.acceptance, execution: executions.get(preparation.runId), continuation: preparation.continuation });
    },
    runExists: id => store.listRuns(main.sessionId).some(run => run.id === id),
  };
}

/** Release only host-named checkouts, after every user of that checkout has settled. */
export async function discardTaskCheckout(host: TaskRuntimeHost, main: Run, checkout: TaskCheckout, locks: WorkspaceLocks = host.tools, signal?: AbortSignal): Promise<void> {
  if (checkout.shared) return;
  const { store, tools } = host;
  const users = store.listRuns(main.sessionId).filter(run => run.execution?.root === checkout.path);
  if (users.some(run => host.busy(run.id) || tools.hasInFlightEffects(run.id) || tools.backgroundRunning(run.id) || !terminal(run.status) && run.status !== 'interrupted')) throw new KodoError('EXECUTION_ACTIVE', 'a task still uses this checkout');
  const release = await locks.workspaceWriteLock(main.id, signal);
  try {
    if (store.unresolvedWrites(undefined, main.sessionId).length) throw new KodoError('UNKNOWN_WRITE', 'retain task checkouts until all session effects have been reconciled');
    const root = store.session(main.sessionId).workspace;
    const result = releaseExecutionCheckout({ root: checkout.path, sourceRoot: root }, checkout.snapshotRef);
    for (const failure of result.failures) store.event(main.id, 'execution.cleanup_failed', { ...failure });
    if (result.failures.length) throw new KodoError('EXECUTION_CLEANUP', result.failures.map(failure => failure.message).join('; '));
    store.event(main.id, 'execution.released', { root: checkout.path, ref: checkout.snapshotRef });
  } finally { release(); }
}

/** Checkouts may be removed only after node evidence and delivery are durably recorded. */
export function nodeHasDelivery(store: Store, main: Run, node: TaskNode): boolean {
  // Shared-mode children wrote the workspace directly; there is no delivery to integrate.
  if (node.owner === 'self' || node.role === 'explorer' || node.role === 'reviewer' || taskWorkspaceMode(store, main.id) === 'shared') return true;
  if (!node.runId) return false;
  return store.hasEvent(main.id, { types: ['task.delivery'], match: { nodeId: node.id, generation: node.generation, runId: node.runId } });
}
