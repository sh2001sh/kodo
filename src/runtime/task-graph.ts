import type { Store } from '../storage/index.js';
import { digest } from '../storage/index.js';
import { KodoError } from './types.js';
import type { FileScope } from './types.js';

/** Node state, recorded separately from the status of any run that served the node (plan 5.2). */
export type TaskNodeState = 'pending' | 'queued' | 'running' | 'needs_input' | 'integrating' | 'conflict' | 'failed' | 'done' | 'stale' | 'dropped';
/** Program and literal arguments for a host-executed targeted check. */
export interface TaskCheck { program: string; args: string[]; timeoutMs?: number }
export interface TaskVerification { status: 'running' | 'passed' | 'failed' | 'unverified'; callId?: string; version?: string; reason?: string }
/** One `delegate` task declaration; `id` and `goal` are required (plan 5.1). */
export interface TaskNeeds { capabilities?: string[]; knowledgeQueries?: string[]; requiredRefs?: { id: string; revision: number }[]; execution?: 'auto' | 'inline' | 'child' }
export interface TaskNodeSpec { id: string; goal: string; owner?: 'self'; role?: string; after?: string[]; start?: string[]; scope?: string[]; check?: string | TaskCheck; acceptance?: string; needs?: TaskNeeds }
export interface TaskDependency { id: string; generation: number }
/** Host-named snapshot reference and checkout directory for one dispatch (plan 6.2). */
export interface TaskCheckout { snapshotRef: string; path: string; shared?: boolean }
/** `resume` reuses the checkout and generation; `redo` takes a new snapshot in a new generation. */
export interface TaskContinuation { mode: 'resume' | 'redo'; fromRunId: string; input?: string; /** Host-validated task resume revision; never a normal followup permission. */ reviseWriteScope?: true }
export interface TaskNode {
  needs?: TaskNeeds;
  methodInstance?: string;
  activationCallId?: string;
  artifactId?: string;
  completionKey?: string;
  boundScope?: FileScope;
  boundCard?: { id: string; version: string; digest: string };
  resultRef?: string;
  resultDecisionVersion?: number;
  id: string; goal: string; owner: 'self' | 'agent'; role?: string; after: string[];
  start?: string[]; scope?: string[]; check?: string | TaskCheck; acceptance?: string;
  /** Host check evidence for this child attempt, never an integrated-workspace verdict. */
  verification?: TaskVerification;
  /** Declaration order; scheduling and reports are deterministic in this order. */
  order: number;
  state: TaskNodeState; generation: number;
  /** Generations replaced by an accepted `redo`; their results are no longer valid. */
  superseded?: number[];
  /** Current (or last) child run serving this generation. */
  runId?: string;
  /** Checkout of the current generation; kept until session end or explicit release (6.3). */
  checkout?: TaskCheckout;
  /** Checkouts of superseded generations, cleaned only after the new generation's evidence persists. */
  retiredCheckouts?: TaskCheckout[];
  /** Set by an accepted `resume` or `redo`; the next dispatch continues from `fromRunId` (5.5). */
  continuation?: TaskContinuation;
  /** Predecessor generations the current result was built on. */
  dependencies?: TaskDependency[];
  /** Set while running when a predecessor was superseded; the result cannot be accepted as-is. */
  dependencyChanged?: boolean;
  /** A failed node acknowledged through inspection no longer blocks completion by itself. */
  acknowledged?: boolean;
  /** Drop, failure or acceptance reason supplied by the main agent or host. */
  reason?: string;
}
export interface TaskGraph { ownerId: string; nodes: TaskNode[] }

export const taskNodeEvent = 'task.node.updated';
export const settledTaskStates: readonly TaskNodeState[] = ['done', 'dropped'];

const transitions: Record<TaskNodeState, readonly TaskNodeState[]> = {
  pending: ['queued', 'running', 'done', 'dropped'],
  queued: ['pending', 'running', 'failed', 'dropped'],
  running: ['needs_input', 'integrating', 'done', 'failed', 'stale', 'dropped'],
  needs_input: ['pending', 'integrating', 'dropped'],
  integrating: ['done', 'conflict', 'failed', 'stale', 'needs_input'],
  conflict: ['pending', 'dropped'],
  failed: ['pending', 'integrating', 'dropped'],
  done: ['stale', 'pending'],
  stale: ['done', 'integrating', 'pending', 'dropped'],
  dropped: [],
};

/** Legacy self nodes skip run states; explicit method stages additionally track running work. */
const selfStates: readonly TaskNodeState[] = ['pending', 'running', 'needs_input', 'failed', 'done', 'stale', 'dropped'];

/** Throws `TASK_NODE_STATE` when the state machine does not allow `node.state -> to`; same-state writes are allowed. */
export function assertTaskTransition(node: TaskNode, to: TaskNodeState): void {
  if (node.owner === 'self' && !(node.needs ? selfStates : ['pending', 'done', 'stale', 'dropped']).includes(to)) throw new KodoError('TASK_NODE_STATE', `task ${node.id} is owned by self and is never run by a child agent`);
  if (node.state !== to && !transitions[node.state].includes(to)) throw new KodoError('TASK_NODE_STATE', `task ${node.id} cannot move from ${node.state} to ${to}`);
}

/** Validates and persists a state change; `patch` carries the fields that change with it. */
export function moveTaskNode(store: Store, ownerId: string, node: TaskNode, to: TaskNodeState, patch: Partial<TaskNode> = {}, extra: Record<string, unknown> = {}): TaskNode {
  assertTaskTransition(node, to);
  return writeTaskNode(store, ownerId, { ...node, ...patch, state: to }, { ...extra, from: node.state });
}

/** Rebuilds the graph from `task.node.updated` events of the owning main run; the latest record per node wins. */
export function readTaskGraph(store: Store, ownerId: string): TaskGraph {
  const nodes = new Map<string, TaskNode>();
  for (const event of store.events(ownerId, { types: [taskNodeEvent] })) {
    const id = event.data.nodeId as string;
    if (event.data.removed === true) nodes.delete(id);
    else nodes.set(id, event.data.node as TaskNode);
  }
  return { ownerId, nodes: [...nodes.values()].sort((left, right) => left.order - right.order) };
}

/** Persists one node record; callers group related records in one Store transaction. */
export function writeTaskNode(store: Store, ownerId: string, node: TaskNode, extra: Record<string, unknown> = {}): TaskNode {
  store.event(ownerId, taskNodeEvent, { ...extra, nodeId: node.id, generation: node.generation, state: node.state, node });
  return node;
}

/** Records the removal of a node that has not started; only `declareTasks` should call it. */
export function removeTaskNode(store: Store, ownerId: string, node: TaskNode): void {
  store.event(ownerId, taskNodeEvent, { nodeId: node.id, generation: node.generation, state: node.state, removed: true });
}

export function taskNode(graph: TaskGraph, id: string): TaskNode | undefined {
  return graph.nodes.find(node => node.id === id);
}

/** Like `taskNode`, but a missing node is a `TASK_NODE_UNKNOWN` error. */
export function requireTaskNode(graph: TaskGraph, id: string): TaskNode {
  const node = taskNode(graph, id);
  if (!node) throw new KodoError('TASK_NODE_UNKNOWN', `task ${JSON.stringify(id)} does not exist in this task graph`);
  return node;
}

/** Nodes that list `id` in `after`. */
export function directSuccessors(graph: TaskGraph, id: string): TaskNode[] {
  return graph.nodes.filter(node => node.after.includes(id));
}

/** Every node reachable through `after` edges from `id`, in breadth-first order. */
export function descendants(graph: TaskGraph, id: string): TaskNode[] {
  const seen = new Set<string>([id]), result: TaskNode[] = [];
  const queue = [id];
  while (queue.length) for (const next of directSuccessors(graph, queue.shift()!)) {
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    result.push(next);
    queue.push(next.id);
  }
  return result;
}

/** The predecessors' current generations, in `after` order. */
export function currentDependencies(graph: TaskGraph, node: TaskNode): TaskDependency[] {
  return node.after.map(id => ({ id, generation: requireTaskNode(graph, id).generation }));
}

/** Whether recorded predecessor generations are current and still accepted (the 5.5 re-check). */
export function dependenciesCurrent(graph: TaskGraph, node: TaskNode, recorded = node.dependencies): boolean {
  if (!node.after.length) return true;
  if (!recorded || recorded.length !== node.after.length) return false;
  return node.after.every((id, index) => {
    const predecessor = taskNode(graph, id);
    return recorded[index]!.id === id && predecessor?.state === 'done' && predecessor.generation === recorded[index]!.generation;
  });
}

/** Every predecessor is `done` in its current generation and the caller confirms its result is integrated. */
export function predecessorsSatisfied(graph: TaskGraph, node: TaskNode, integrated: (node: TaskNode) => boolean = () => true): boolean {
  return node.after.every(id => {
    const predecessor = taskNode(graph, id);
    return predecessor?.state === 'done' && integrated(predecessor);
  });
}

/** Stable digest of the graph's observable state, compared between acceptance and the terminal transaction. */
export function taskGraphFingerprint(graph: TaskGraph): string {
  return digest(JSON.stringify(graph.nodes.map(node => [node.id, node.state, node.generation, node.runId ?? null, node.dependencies ?? null, node.after, node.needs ?? null, node.methodInstance ?? null, node.resultRef ?? null, node.resultDecisionVersion ?? null])));
}
