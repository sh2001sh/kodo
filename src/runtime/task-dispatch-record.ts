import type { Store } from '../storage/index.js';
import { currentDependencies, predecessorsSatisfied, taskNode } from './task-graph.js';
import type { TaskCheckout, TaskContinuation, TaskDependency, TaskGraph, TaskNode } from './task-graph.js';

/** Durable first-transaction record of a dispatch (plan 5.3 step 1); the run ID is preallocated, never reused. */
export interface TaskDispatchPreparation {
  nodeId: string; generation: number; runId: string; checkout: TaskCheckout;
  /** `resume` continues in the node's retained checkout, which abandonment must never discard. */
  reuseCheckout: boolean;
  dependencies: TaskDependency[];
  continuation?: TaskContinuation;
}

export const dispatchPreparedEvent = 'task.dispatch.prepared';
export const dispatchCommittedEvent = 'task.dispatch.committed';
export const dispatchAbandonedEvent = 'task.dispatch.abandoned';

/** Preparations without a matching committed or abandoned record, in preparation order. */
export function openTaskDispatches(store: Store, ownerId: string): TaskDispatchPreparation[] {
  const closed = new Set(store.events(ownerId, { types: [dispatchCommittedEvent, dispatchAbandonedEvent] }).map(event => event.data.runId as string));
  return store.events(ownerId, { types: [dispatchPreparedEvent] })
    .map(event => event.data as unknown as TaskDispatchPreparation)
    .filter(preparation => !closed.has(preparation.runId));
}

export function writeTaskDispatchPreparation(store: Store, ownerId: string, preparation: TaskDispatchPreparation): void {
  store.event(ownerId, dispatchPreparedEvent, { ...preparation });
}

const sameDependencies = (left: TaskDependency[], right: TaskDependency[]): boolean =>
  left.length === right.length && left.every((dependency, index) => dependency.id === right[index]!.id && dependency.generation === right[index]!.generation);

/**
 * Why a preparation can no longer be committed, or undefined when it still can: the node must still
 * be queued in the prepared generation, and every predecessor must be integrated in the generation
 * the preparation recorded (the re-check before downstream dispatch).
 */
export function taskDispatchInvalid(graph: TaskGraph, preparation: TaskDispatchPreparation, integrated: (node: TaskNode) => boolean): string | undefined {
  const node = taskNode(graph, preparation.nodeId);
  if (!node) return 'task removed';
  if (node.generation !== preparation.generation) return `task generation changed to ${node.generation}`;
  if (node.state !== 'queued') return `task is ${node.state}`;
  if (!predecessorsSatisfied(graph, node, integrated)) return 'prerequisites are no longer integrated';
  if (!sameDependencies(currentDependencies(graph, node), preparation.dependencies)) return 'prerequisite generation changed';
  return undefined;
}
