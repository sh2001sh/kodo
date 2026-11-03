import type { Store } from '../storage/index.js';
import { KodoError } from './types.js';
import { currentDependencies, moveTaskNode, predecessorsSatisfied, readTaskGraph, requireTaskNode, taskNode, writeTaskNode } from './task-graph.js';
import type { TaskCheckout, TaskGraph, TaskNode } from './task-graph.js';
import { dispatchAbandonedEvent, dispatchCommittedEvent, openTaskDispatches, taskDispatchInvalid, writeTaskDispatchPreparation } from './task-dispatch-record.js';
import type { TaskDispatchPreparation } from './task-dispatch-record.js';

/**
 * Side effects the scheduler cannot own. Git, the filesystem and the database cannot commit
 * atomically, so checkout callbacks must be idempotent for the names in a preparation (5.3 step 2).
 */
export interface TaskDispatchHost {
  /** Active child-run quota (`maxActiveChildren`). */
  quota: number;
  /** Active child runs of the owner that are not task nodes (for example legacy `spawn_agent` children). */
  otherActive?(): number;
  /** Whether a `done` predecessor's result is integrated into the parent workspace (L2). Defaults to true. */
  isIntegrated?(node: TaskNode): boolean;
  /** A fresh, never reused child run ID. */
  allocateRunId(node: TaskNode): string;
  /** Host-owned snapshot ref name and checkout path for a new generation's dispatch. */
  checkoutFor(node: TaskNode, runId: string): TaskCheckout;
  /** Creates or reuses the snapshot ref and checkout named by the preparation; must be repeatable. */
  ensureCheckout(preparation: TaskDispatchPreparation): Promise<void> | void;
  /** Removes a ref and checkout; must succeed when either is already gone. */
  discardCheckout(checkout: TaskCheckout): Promise<void> | void;
  /** Persists the child run `preparation.runId`; runs inside the second Store transaction, so it is synchronous. */
  startRun(preparation: TaskDispatchPreparation, node: TaskNode): void;
  /** Whether the child run already exists. */
  runExists(runId: string): boolean;
  /** Why `node` must keep waiting although quota is free, given the nodes that hold or are taking a run (shared-workspace scope overlap). */
  holdReason?(node: TaskNode, active: readonly TaskNode[]): string | undefined;
}
export interface TaskScheduleResult {
  started: { nodeId: string; runId: string }[];
  abandoned: { nodeId: string; runId: string; reason: string }[];
  failed: { nodeId: string; runId: string; error: string }[];
  queued: string[];
}

const integratedBy = (host: TaskDispatchHost) => (node: TaskNode): boolean => host.isIntegrated ? host.isIntegrated(node) : true;
const emptyResult = (): TaskScheduleResult => ({ started: [], abandoned: [], failed: [], queued: [] });
export const taskLockBusy = (error: unknown): boolean => error instanceof KodoError && ['LOCK_BUSY', 'LOCK_TIMEOUT'].includes(error.code);

/** Moves child nodes between `pending` and `queued` as prerequisites become (or stop being) integrated. */
export function promoteReadyTasks(store: Store, ownerId: string, integrated: (node: TaskNode) => boolean = () => true): string[] {
  return store.transaction(() => {
    const graph = readTaskGraph(store, ownerId), promoted: string[] = [];
    for (const node of graph.nodes) {
      if (node.owner === 'self') continue;
      const ready = predecessorsSatisfied(graph, node, integrated);
      if (node.state === 'pending' && ready) { moveTaskNode(store, ownerId, node, 'queued', {}, { action: 'ready' }); promoted.push(node.id); }
      else if (node.state === 'queued' && !ready && !openTaskDispatches(store, ownerId).some(item => item.nodeId === node.id)) moveTaskNode(store, ownerId, node, 'pending', {}, { action: 'not_ready' });
    }
    return promoted;
  });
}

function activeCount(store: Store, ownerId: string, graph: TaskGraph, host: TaskDispatchHost): number {
  return graph.nodes.filter(node => node.state === 'running').length + openTaskDispatches(store, ownerId).length + (host.otherActive?.() ?? 0);
}

function preparationFor(graph: TaskGraph, node: TaskNode, host: TaskDispatchHost): TaskDispatchPreparation {
  const runId = host.allocateRunId(node);
  const resume = node.continuation?.mode === 'resume' && node.checkout;
  return { nodeId: node.id, generation: node.generation, runId, checkout: resume ? node.checkout! : host.checkoutFor(node, runId), reuseCheckout: Boolean(resume),
    dependencies: currentDependencies(graph, node), ...(node.continuation ? { continuation: node.continuation } : {}) };
}

/** First transaction: reserve quota for queued nodes in declaration order and record their preparations. */
function prepareDispatches(store: Store, ownerId: string, host: TaskDispatchHost): TaskDispatchPreparation[] {
  return store.transaction(() => {
    const graph = readTaskGraph(store, ownerId);
    const open = new Set(openTaskDispatches(store, ownerId).map(item => item.nodeId));
    let free = host.quota - activeCount(store, ownerId, graph, host);
    const prepared: TaskDispatchPreparation[] = [];
    const active = graph.nodes.filter(node => node.state === 'running' || open.has(node.id));
    for (const node of graph.nodes) {
      if (free <= 0) break;
      if (node.state !== 'queued' || open.has(node.id) || !predecessorsSatisfied(graph, node, integratedBy(host))) continue;
      const hold = host.holdReason?.(node, active);
      if (hold) {
        if (node.reason !== hold) writeTaskNode(store, ownerId, { ...node, reason: hold }, { action: 'dispatch_held' });
        continue;
      }
      const preparation = preparationFor(graph, node, host);
      active.push(node);
      writeTaskDispatchPreparation(store, ownerId, preparation);
      prepared.push(preparation);
      free--;
    }
    return prepared;
  });
}

/** Second transaction: re-check generations, create the run once, and move the node to `running`. */
function commitDispatch(store: Store, ownerId: string, preparation: TaskDispatchPreparation, host: TaskDispatchHost): string | undefined {
  return store.transaction(() => {
    const graph = readTaskGraph(store, ownerId);
    const invalid = taskDispatchInvalid(graph, preparation, integratedBy(host));
    if (invalid) return invalid;
    const node = requireTaskNode(graph, preparation.nodeId);
    if (!host.runExists(preparation.runId)) host.startRun(preparation, node);
    const dispatched = { todoId: node.id, generation: node.generation, childRunId: preparation.runId };
    if (!store.hasEvent(ownerId, { types: ['todo.dispatched'], match: dispatched })) store.event(ownerId, 'todo.dispatched', dispatched);
    store.event(ownerId, dispatchCommittedEvent, { nodeId: node.id, generation: node.generation, runId: preparation.runId });
    moveTaskNode(store, ownerId, node, 'running', { runId: preparation.runId, checkout: preparation.checkout, dependencies: preparation.dependencies, continuation: undefined, dependencyChanged: false, acknowledged: false, reason: undefined }, { action: 'dispatch', runId: preparation.runId });
    return undefined;
  });
}

/** Closes an uncommittable preparation: discard its fresh checkout first, then record the abandonment. */
async function abandonDispatch(store: Store, ownerId: string, preparation: TaskDispatchPreparation, host: TaskDispatchHost, reason: string, fail?: string): Promise<void> {
  if (!preparation.reuseCheckout) await host.discardCheckout(preparation.checkout);
  store.transaction(() => {
    store.event(ownerId, dispatchAbandonedEvent, { nodeId: preparation.nodeId, generation: preparation.generation, runId: preparation.runId, reason });
    const node = taskNode(readTaskGraph(store, ownerId), preparation.nodeId);
    if (!node || node.generation !== preparation.generation || node.state !== 'queued') return;
    if (fail) moveTaskNode(store, ownerId, node, 'failed', { reason: fail }, { action: 'dispatch_failed', runId: preparation.runId });
    else if (!predecessorsSatisfied(readTaskGraph(store, ownerId), node, integratedBy(host))) moveTaskNode(store, ownerId, node, 'pending', {}, { action: 'dispatch_abandoned', runId: preparation.runId });
  });
}

/** Steps 2-3 for one preparation, shared by fresh dispatch and recovery. */
async function completeDispatch(store: Store, ownerId: string, preparation: TaskDispatchPreparation, host: TaskDispatchHost, result: TaskScheduleResult): Promise<void> {
  const before = taskDispatchInvalid(readTaskGraph(store, ownerId), preparation, integratedBy(host));
  if (before) {
    await abandonDispatch(store, ownerId, preparation, host, before);
    result.abandoned.push({ nodeId: preparation.nodeId, runId: preparation.runId, reason: before });
    return;
  }
  try { await host.ensureCheckout(preparation); }
  catch (error) {
    if (error instanceof KodoError && error.code === 'PROCESS_STOP') throw error;
    if (taskLockBusy(error)) {
      const node = requireTaskNode(readTaskGraph(store, ownerId), preparation.nodeId);
      const reason = 'Waiting for the workspace lock to take the task snapshot.';
      if (node.reason !== reason) writeTaskNode(store, ownerId, { ...node, reason }, { action: 'snapshot_waiting' });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await abandonDispatch(store, ownerId, preparation, host, 'checkout failed', `checkout failed: ${message}`);
    result.failed.push({ nodeId: preparation.nodeId, runId: preparation.runId, error: message });
    return;
  }
  let invalid: string | undefined;
  try { invalid = commitDispatch(store, ownerId, preparation, host); }
  catch (error) {
    if (store.fault !== undefined || !(error instanceof KodoError)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await abandonDispatch(store, ownerId, preparation, host, 'run creation failed', message);
    result.failed.push({ nodeId: preparation.nodeId, runId: preparation.runId, error: message });
    return;
  }
  if (!invalid) { result.started.push({ nodeId: preparation.nodeId, runId: preparation.runId }); return; }
  await abandonDispatch(store, ownerId, preparation, host, invalid);
  result.abandoned.push({ nodeId: preparation.nodeId, runId: preparation.runId, reason: invalid });
}

/**
 * Restart recovery (5.3 step 4): every preparation without a commit is either finished from step 2
 * when its prerequisites are still current, or abandoned with its checkout removed. The preallocated
 * run ID is created at most once, so recovery never dispatches twice.
 */
export async function recoverTaskDispatches(store: Store, ownerId: string, host: TaskDispatchHost): Promise<TaskScheduleResult> {
  const result = emptyResult();
  await completeDispatches(store, ownerId, openTaskDispatches(store, ownerId), host, result);
  return result;
}

/** Reservations already bound this batch by quota. Join every preparation before propagating a failure. */
async function completeDispatches(store: Store, ownerId: string, preparations: TaskDispatchPreparation[], host: TaskDispatchHost, result: TaskScheduleResult): Promise<void> {
  const outcomes = await Promise.allSettled(preparations.map(async preparation => {
    const current = emptyResult();
    await completeDispatch(store, ownerId, preparation, host, current);
    return current;
  }));
  for (const outcome of outcomes) if (outcome.status === 'fulfilled') {
    result.started.push(...outcome.value.started); result.abandoned.push(...outcome.value.abandoned); result.failed.push(...outcome.value.failed);
  }
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

/**
 * One scheduling pass: recover open preparations, promote ready nodes, then dispatch queued nodes up to
 * the quota in declaration order. Excess nodes stay `queued` without holding quota or locks.
 */
export async function scheduleTasks(store: Store, ownerId: string, host: TaskDispatchHost): Promise<TaskScheduleResult> {
  if (!Number.isInteger(host.quota) || host.quota < 0) throw new KodoError('TASK_QUOTA', 'the active child quota must be a non-negative integer');
  const result = await recoverTaskDispatches(store, ownerId, host);
  promoteReadyTasks(store, ownerId, integratedBy(host));
  await completeDispatches(store, ownerId, prepareDispatches(store, ownerId, host), host, result);
  result.queued = readTaskGraph(store, ownerId).nodes.filter(node => node.state === 'queued').map(node => node.id);
  return result;
}

/** `task release`: discards a settled node's retained checkout. The discard runs before the record, so a crash only repeats it. */
export async function releaseTaskCheckout(store: Store, ownerId: string, id: string, discard: TaskDispatchHost['discardCheckout']): Promise<TaskNode> {
  const node = requireTaskNode(readTaskGraph(store, ownerId), id);
  if (!['done', 'dropped', 'stale', 'conflict', 'failed', 'needs_input'].includes(node.state)) throw new KodoError('TASK_NODE_STATE', `task ${id} is ${node.state}; only settled tasks release their checkout`);
  for (const checkout of [...(node.checkout ? [node.checkout] : []), ...(node.retiredCheckouts ?? [])]) await discard(checkout);
  return store.transaction(() => writeTaskNode(store, ownerId, { ...requireTaskNode(readTaskGraph(store, ownerId), id), checkout: undefined, retiredCheckouts: [] }, { action: 'release' }));
}

/** Cleans checkouts of superseded generations once the current generation's run has settled with evidence (6.3). */
export async function cleanRetiredCheckouts(store: Store, ownerId: string, id: string, discard: TaskDispatchHost['discardCheckout']): Promise<TaskCheckout[]> {
  const node = requireTaskNode(readTaskGraph(store, ownerId), id);
  const settled = node.runId && store.hasEvent(ownerId, { types: [dispatchCommittedEvent], match: { nodeId: id, generation: node.generation } }) && !['pending', 'queued', 'running', 'integrating'].includes(node.state);
  if (!settled || !node.retiredCheckouts?.length) return [];
  for (const checkout of node.retiredCheckouts) await discard(checkout);
  store.transaction(() => writeTaskNode(store, ownerId, { ...requireTaskNode(readTaskGraph(store, ownerId), id), retiredCheckouts: [] }, { action: 'clean_retired' }));
  return node.retiredCheckouts;
}
