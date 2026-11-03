import type { Store } from '../storage/index.js';
import { KodoError, terminal } from './types.js';
import { readTaskGraph, taskNode, writeTaskNode } from './task-graph.js';
import type { TaskNode } from './task-graph.js';

const copiedEvent = (type: string): boolean => type.startsWith('task.') || type.startsWith('execution.') || type === 'todo.dispatched' || type === 'completion.task_disclosure';
const runReferenceFields = new Set(['runId', 'childId', 'childRunId', 'ownerId', 'parentId', 'fromRunId']);

/** Rewrite only typed runtime reference fields, never text, paths, node IDs, call IDs or artifact IDs. */
function remap(value: unknown, replacements: ReadonlyMap<string, string>, key = ''): unknown {
  if (typeof value === 'string') return runReferenceFields.has(key) ? replacements.get(value) ?? value : value;
  if (Array.isArray(value)) return value.map(item => remap(item, replacements, key === 'runIds' ? 'runId' : ''));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, remap(item, replacements, field)]));
}

function currentNode(node: TaskNode, replacements: ReadonlyMap<string, string>): TaskNode {
  const next = remap(node, replacements) as TaskNode;
  if (node.runId && replacements.has(node.runId) && node.state === 'dropped') throw new KodoError('TASK_RECOVERY', `task ${node.id} was dropped; recovery cannot restart cancelled task work`);
  if (node.runId && replacements.has(node.runId) && ['running', 'failed', 'needs_input', 'conflict'].includes(node.state)) {
    // A verified recovery continuation is active work in the same generation,
    // not the outcome of its immutable failed predecessor.
    next.state = 'running';
    next.acknowledged = false;
    delete next.verification;
    delete next.reason;
  }
  return next;
}

function assertRecovery(store: Store, sessionId: string, sourceId: string, targetId: string): void {
  const source = store.run(sourceId), target = store.run(targetId);
  if (source.sessionId !== sessionId || target.sessionId !== sessionId || target.continuationOf !== sourceId || target.historyFrom === sourceId
    || !store.hasEvent(sourceId, { types: ['recovery.continued'], match: { runId: targetId } })) {
    throw new KodoError('TASK_RECOVERY', 'task graphs transfer only across an audited same-session recovery');
  }
}

/** Copies runtime evidence in order, preserving original calls/artifacts and recording provenance on each new event. */
function carryEvents(store: Store, sourceId: string, targetId: string, replacements: ReadonlyMap<string, string>, onlyChanged: boolean): void {
  const sequences = new Map<number, number>();
  for (const event of store.events(sourceId).filter(event => copiedEvent(event.type))) {
    if (onlyChanged && event.type === 'task.node.updated') continue;
    const data = remap(event.data, replacements) as Record<string, unknown>;
    if (onlyChanged && JSON.stringify(data) === JSON.stringify(event.data)) continue;
    if (typeof data.requestSeq === 'number' && sequences.has(data.requestSeq)) data.requestSeq = sequences.get(data.requestSeq)!;
    // The legacy todo transfer may already have copied a linked dispatch.
    if (event.type === 'todo.dispatched' && typeof data.childRunId === 'string' && typeof data.todoId === 'string' && typeof data.generation === 'number'
      && store.hasEvent(targetId, { types: ['todo.dispatched'], match: { childRunId: data.childRunId, todoId: data.todoId, generation: data.generation } })) continue;
    store.event(targetId, event.type, { ...data, recoverySourceRunId: sourceId, recoverySourceSeq: event.seq });
    sequences.set(event.seq, store.latestEvent(targetId, { types: [event.type] })!.seq);
  }
}

/**
 * Called in the recovery transaction after run IDs and live parent links have been replaced.
 * Main recovery transfers the complete graph/evidence stream. Child-only recovery rewrites
 * its current graph references in place. Terminal source runs and calls remain immutable.
 */
export function carryRecoveryTaskGraphs(store: Store, sessionId: string, replacements: ReadonlyMap<string, string>, resumedRunIds: readonly string[] = []): void {
  if ((!replacements.size && !resumedRunIds.length) || (store.session(sessionId).toolProfile !== 'lean-team' && !store.session(sessionId).inlineMethods)) return;
  store.transaction(() => {
    for (const [sourceId, targetId] of replacements) assertRecovery(store, sessionId, sourceId, targetId);
    const migrated = new Set<string>();
    for (const [sourceId, targetId] of replacements) {
      if (store.run(sourceId).parentId) continue;
      if (store.run(targetId).parentId) throw new KodoError('TASK_RECOVERY', 'a main task graph cannot transfer to a child run');
      migrated.add(targetId);
      if (store.hasEvent(targetId, { types: ['recovery.task_graph_carried'], match: { sourceRunId: sourceId } })) continue;
      if (store.hasEvent(targetId, { types: ['task.node.updated'] })) throw new KodoError('TASK_RECOVERY', 'the recovery destination already has an independent task graph');
      const graph = readTaskGraph(store, sourceId);
      carryEvents(store, sourceId, targetId, replacements, false);
      for (const node of graph.nodes) {
        const next = currentNode(node, replacements);
        if (JSON.stringify(next) !== JSON.stringify(remap(node, replacements))) writeTaskNode(store, targetId, next, { action: 'recovery_continuation' });
      }
      store.event(targetId, 'recovery.task_graph_carried', { sourceRunId: sourceId, nodes: graph.nodes.length });
    }
    const mapping = JSON.stringify([...replacements]);
    for (const main of store.listRuns(sessionId).filter(run => !run.parentId && !terminal(run.status) && !replacements.has(run.id) && !migrated.has(run.id))) {
      if (store.hasEvent(main.id, { types: ['recovery.task_children_remapped'], match: { mapping } })) continue;
      const changes = readTaskGraph(store, main.id).nodes.map(node => ({ node, next: currentNode(node, replacements) }))
        .filter(({ node, next }) => JSON.stringify(node) !== JSON.stringify(next));
      if (!changes.length) continue;
      carryEvents(store, main.id, main.id, replacements, true);
      for (const { next } of changes) writeTaskNode(store, main.id, next, { action: 'recovery_continuation' });
      store.event(main.id, 'recovery.task_children_remapped', { mapping });
    }
    // A process-interrupted run resumes in place rather than getting a new ID.
    // The graph may already have observed that interruption as a failed node.
    for (const id of resumedRunIds) {
      const run = store.run(id);
      if (run.status !== 'queued' || !run.taskNode) continue;
      const node = taskNode(readTaskGraph(store, run.taskNode.ownerId), run.taskNode.nodeId);
      if (!node || node.runId !== id) throw new KodoError('TASK_RECOVERY', 'the resumed child no longer owns its task node');
      if (node.state === 'dropped') throw new KodoError('TASK_RECOVERY', `task ${node.id} was dropped; recovery cannot restart cancelled task work`);
      if (node.state === 'failed') writeTaskNode(store, run.taskNode.ownerId, { ...node, state: 'running', acknowledged: false, reason: undefined, verification: undefined }, { action: 'recovery_resume' });
    }
  });
}
