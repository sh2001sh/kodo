import type { Store } from '../storage/index.js';
import { KodoError, terminal } from './types.js';
import type { RunStatus } from './types.js';
import { currentDependencies, dependenciesCurrent, descendants, directSuccessors, moveTaskNode, predecessorsSatisfied, readTaskGraph, requireTaskNode, writeTaskNode } from './task-graph.js';
import type { TaskCheck, TaskGraph, TaskNode } from './task-graph.js';
import { taskSpecErrors } from './task-declare.js';
import { intersectFileScopes, normalizeFileScope, resolveScopeVariables, writeScopesOverlap } from './scope.js';
import { taskWorkspaceMode } from './task-workspace.js';

/** Host-visible consequence of a node operation; notification wiring turns these into runtime messages. */
export interface TaskNotice { reason: 'dependency_changed' | 'became_stale'; nodeId: string; runId?: string; predecessor: string; generation: number }
export interface TaskRunOutcome { status: Exclude<RunStatus, 'queued' | 'running' | 'waiting'>; finalText?: string; integrate: boolean }
export interface TaskIntegrationResult { status: 'integrated' | 'no_changes' | 'conflict' | 'failed'; detail?: string }

const needsInputPrefix = 'NEEDS_INPUT:';
/** A normally finished child run whose final answer starts with `NEEDS_INPUT:` asks for input (5.5). */
export const needsInputAnswer = (text: string | undefined): boolean => (text ?? '').trimStart().startsWith(needsInputPrefix);

function mutate<T>(store: Store, ownerId: string, action: (graph: TaskGraph) => T): T {
  return store.transaction(() => action(readTaskGraph(store, ownerId)));
}

function requireReason(reason: string | undefined, action: string): string {
  if (typeof reason !== 'string' || !reason.trim()) throw new KodoError('TASK_REASON_REQUIRED', `${action} requires a written reason`);
  return reason.trim();
}

/** `task done` for a `self` node; predecessors must already be done in their current generations. */
export function completeSelfTask(store: Store, ownerId: string, id: string, note?: string): TaskNode {
  return mutate(store, ownerId, graph => {
    const node = requireTaskNode(graph, id);
    if (node.owner !== 'self') throw new KodoError('TASK_NODE_OWNER', `task ${id} is run by a child agent; only self tasks are marked done`);
    if (!predecessorsSatisfied(graph, node)) throw new KodoError('TASK_NODE_BLOCKED', `task ${id} depends on unfinished tasks ${node.after.join(', ')}`);
    return moveTaskNode(store, ownerId, node, 'done', { dependencies: currentDependencies(graph, node), ...(note?.trim() ? { reason: note.trim() } : {}) }, { action: 'done' });
  });
}

/** `task drop`: settles the node with a reason. Cancelling a running child run is the caller's job. */
export function dropTask(store: Store, ownerId: string, id: string, reason: string): TaskNode {
  const text = requireReason(reason, 'drop');
  return mutate(store, ownerId, graph => moveTaskNode(store, ownerId, requireTaskNode(graph, id), 'dropped', { reason: text }, { action: 'drop' }));
}

/** `task inspect` of a failed node acknowledges the failure (not acceptance), as in B2. */
export function acknowledgeTaskFailure(store: Store, ownerId: string, id: string): TaskNode {
  return mutate(store, ownerId, graph => {
    const node = requireTaskNode(graph, id);
    if (node.state !== 'failed' || node.acknowledged) return node;
    return writeTaskNode(store, ownerId, { ...node, acknowledged: true }, { action: 'acknowledge' });
  });
}

/** `task accept` on a stale node: the main agent confirms the old result against the new predecessor generations. */
export function acceptStaleTask(store: Store, ownerId: string, id: string, reason: string | undefined, integrate = false): TaskNode {
  return mutate(store, ownerId, graph => {
    const node = requireTaskNode(graph, id);
    if (node.state === 'needs_input') throw new KodoError('TASK_NODE_STATE', `task ${id} needs input or a corrected check/scope; ${node.verification?.status === 'failed' ? 'use task recheck for host verification only, or ' : ''}use task resume to continue its retained work, not accept`);
    const text = requireReason(reason, 'accept');
    if (node.state !== 'stale') throw new KodoError('TASK_NODE_STATE', `task ${id} is ${node.state}; only stale tasks are accepted`);
    if (!predecessorsSatisfied(graph, node)) throw new KodoError('TASK_NODE_BLOCKED', `task ${id} cannot be accepted before its predecessors are done again`);
    return moveTaskNode(store, ownerId, node, integrate ? 'integrating' : 'done', { dependencies: currentDependencies(graph, node), dependencyChanged: false, reason: text }, { action: 'accept' });
  });
}

/** `resume`: same generation and checkout; the next dispatch continues `runId` with the supplied input. */
export interface TaskResumePatch { scope?: string[]; check?: TaskCheck }

/** Retry host verification on a completed child without dispatching or continuing a model run. */
export function recheckTask(store: Store, ownerId: string, id: string, check?: TaskCheck): TaskNode {
  return mutate(store, ownerId, graph => {
    const node = requireTaskNode(graph, id);
    if (node.owner !== 'agent' || !['needs_input', 'failed'].includes(node.state) || node.verification?.status !== 'failed') {
      throw new KodoError('TASK_NODE_STATE', `task ${id} requires a failed host check to recheck; use resume for child work`);
    }
    if (!node.runId || !node.checkout) throw new KodoError('TASK_NODE_STATE', `task ${id} has no retained run and checkout to recheck; use redo`);
    const parent = store.run(ownerId), previous = store.run(node.runId), session = store.session(parent.sessionId);
    if (previous.status !== 'completed' || previous.parentId !== ownerId || (previous.taskNode &&
      (previous.taskNode.ownerId !== ownerId || previous.taskNode.nodeId !== id || previous.taskNode.generation !== node.generation))) {
      throw new KodoError('TASK_NODE_STATE', `task ${id} requires its current completed child run to recheck; use resume`);
    }
    if (!dependenciesCurrent(graph, node) || node.dependencyChanged) throw new KodoError('TASK_NODE_STALE', `task ${id} was built on superseded prerequisites; use redo`);
    if (store.unresolvedWrites(undefined, parent.sessionId).length) throw new KodoError('UNKNOWN_WRITE', 'reconcile outstanding effects before rechecking a task');
    if (node.verification.callId) {
      const call = store.call(node.verification.callId);
      if (call.status === 'running' || call.status === 'planned') throw new KodoError('EXECUTION_ACTIVE', 'wait for the previous host check to settle before rechecking');
    }
    const nextCheck = check === undefined ? node.check : check;
    if (!nextCheck || typeof nextCheck !== 'object') throw new KodoError('TASK_GRAPH_INVALID', 'recheck requires an executable program and args');
    const errors = taskSpecErrors({ id: node.id, goal: node.goal, role: node.role, after: node.after, start: node.start,
      acceptance: node.acceptance, scope: node.scope, check: nextCheck }, { roles: [node.role ?? 'implementer'],
      requireScope: taskWorkspaceMode(store, ownerId) === 'shared', workspace: previous.execution?.root ?? session.workspace, parentScope: parent.scope });
    if (errors.length) throw new KodoError('TASK_GRAPH_INVALID', `recheck rejected; no task changed:\n${errors.join('\n')}`);
    return moveTaskNode(store, ownerId, node, 'integrating', { check: nextCheck, verification: undefined, reason: undefined,
      continuation: undefined, acknowledged: false }, { action: 'recheck', revisedCheck: check !== undefined });
  });
}

export function resumeTask(store: Store, ownerId: string, id: string, input?: string, patch: TaskResumePatch = {}): TaskNode {
  return mutate(store, ownerId, graph => {
    const node = requireTaskNode(graph, id);
    if (node.owner === 'self' || !['needs_input', 'failed', 'done'].includes(node.state)) throw new KodoError('TASK_NODE_STATE', `task ${id} is ${node.state}; resume applies to needs_input, failed or done child tasks`);
    if (!node.runId || (!node.checkout && node.role !== 'explorer')) throw new KodoError('TASK_NODE_STATE', `task ${id} has no retained run and checkout to resume; use redo`);
    if (!dependenciesCurrent(graph, node) || node.dependencyChanged) throw new KodoError('TASK_NODE_STALE', `task ${id} was built on superseded prerequisites; use redo`);
    // Resume keeps the generation, so a result that successors already consumed must change through redo.
    if (node.state === 'done' && directSuccessors(graph, id).some(successor => successor.runId || successor.state === 'done')) throw new KodoError('TASK_NODE_CONSUMED', `task ${id} already feeds started successors; use redo so they are re-checked`);
    const revision = patch.scope !== undefined || patch.check !== undefined;
    let scope = patch.scope;
    if (revision) {
      if (!['needs_input', 'failed'].includes(node.state)) throw new KodoError('TASK_NODE_STATE', 'resume may revise scope/check only for needs_input or failed child tasks');
      const parent = store.run(ownerId), previous = store.run(node.runId), session = store.session(parent.sessionId);
      if (!terminal(previous.status) && previous.status !== 'interrupted') throw new KodoError('EXECUTION_ACTIVE', 'settle the previous run before revising its task scope or check');
      if (store.unresolvedWrites(undefined, parent.sessionId).length) throw new KodoError('UNKNOWN_WRITE', 'reconcile outstanding effects before revising task scope or check');
      if (patch.check !== undefined && (typeof patch.check !== 'object' || patch.check === null)) throw new KodoError('TASK_GRAPH_INVALID', 'resume check must be an executable program and args');
      const errors = taskSpecErrors({ id: node.id, goal: node.goal, role: node.role, after: node.after, start: node.start, acceptance: node.acceptance,
        scope: patch.scope ?? node.scope, check: patch.check ?? node.check }, { roles: [node.role ?? 'implementer'], requireScope: taskWorkspaceMode(store, ownerId) === 'shared', workspace: previous.execution?.root ?? session.workspace, parentScope: parent.scope });
      if (errors.length) throw new KodoError('TASK_GRAPH_INVALID', `resume rejected; no task changed:\n${errors.join('\n')}`);
      if (scope !== undefined) {
        const mode = previous.card.routing?.mode;
        if (!(previous.permissions ?? session.permissions).includes('write') || !(parent.permissions ?? session.permissions).includes('write') || !session.permissions.includes('write')) throw new KodoError('PERMISSION_DENIED', 'scope revision requires existing parent and child write permissions');
        const ceiling = intersectFileScopes(parent.scope, resolveScopeVariables(previous.card.constraints?.scope, session.projectRoots), mode === 'read' || mode === 'review' ? { write: [] } : undefined);
        scope = normalizeFileScope({ write: scope }, ceiling).write!;
        const conflict = graph.nodes.find(peer => peer.id !== id && peer.owner === 'agent' && !['done', 'dropped'].includes(peer.state) && peer.role !== 'explorer' && peer.role !== 'reviewer' && writeScopesOverlap({ write: scope }, { write: peer.scope }));
        if (conflict) throw new KodoError('TASK_SCOPE_CONFLICT', `resume scope overlaps unfinished task ${conflict.id}; resolve ownership before resuming`);
      }
    }
    return moveTaskNode(store, ownerId, node, 'pending', { ...(scope !== undefined ? { scope } : {}), ...(patch.check !== undefined ? { check: patch.check } : {}),
      continuation: { mode: 'resume', fromRunId: node.runId, ...(input?.trim() ? { input: input.trim() } : {}), ...(scope !== undefined ? { reviseWriteScope: true as const } : {}) }, acknowledged: false, verification: undefined }, { action: 'resume', ...(revision ? { revisedScope: scope !== undefined, revisedCheck: patch.check !== undefined } : {}) });
  });
}

/**
 * `redo`: accepted immediately as a new generation (5.5). The old generation is superseded at once,
 * its checkout is retired for later cleanup, and every transitive successor is re-evaluated in the same
 * transaction: pending/queued wait for the new generation, running ones are flagged, integrating
 * and done ones become `stale`.
 */
export function redoTask(store: Store, ownerId: string, id: string, input?: string): { node: TaskNode; notices: TaskNotice[] } {
  return mutate(store, ownerId, graph => {
    const node = requireTaskNode(graph, id);
    if (node.owner === 'self' || !['needs_input', 'conflict', 'failed', 'done', 'stale'].includes(node.state)) throw new KodoError('TASK_NODE_STATE', `task ${id} is ${node.state}; redo applies to finished child tasks (cancel or interrupt a running one first)`);
    const generation = node.generation + 1;
    const next = moveTaskNode(store, ownerId, node, 'pending', {
      generation, superseded: [...(node.superseded ?? []), node.generation], checkout: undefined, dependencies: undefined, dependencyChanged: false, acknowledged: false, verification: undefined,
      retiredCheckouts: [...(node.retiredCheckouts ?? []), ...(node.checkout ? [node.checkout] : [])],
      ...(node.runId ? { continuation: { mode: 'redo' as const, fromRunId: node.runId, ...(input?.trim() ? { input: input.trim() } : {}) } } : {}),
    }, { action: 'redo', supersededGeneration: node.generation });
    return { node: next, notices: invalidateSuccessors(store, ownerId, graph, node.id, generation) };
  });
}

function invalidateSuccessors(store: Store, ownerId: string, graph: TaskGraph, predecessor: string, generation: number): TaskNotice[] {
  const notices: TaskNotice[] = [];
  for (const successor of descendants(graph, predecessor)) {
    const notice = { nodeId: successor.id, predecessor, generation, ...(successor.runId ? { runId: successor.runId } : {}) };
    if (successor.state === 'queued') moveTaskNode(store, ownerId, successor, 'pending', {}, { action: 'predecessor_superseded', predecessor });
    else if (successor.state === 'integrating' || successor.state === 'done') {
      moveTaskNode(store, ownerId, successor, 'stale', {}, { action: 'predecessor_superseded', predecessor });
      notices.push({ ...notice, reason: 'became_stale' });
    } else if (['running', 'needs_input', 'failed', 'conflict'].includes(successor.state) && successor.runId) {
      writeTaskNode(store, ownerId, { ...successor, dependencyChanged: true }, { action: 'predecessor_superseded', predecessor });
      notices.push({ ...notice, reason: 'dependency_changed' });
    }
  }
  return notices;
}

/**
 * Records how the current run of a node ended. Results of runs that no longer serve the node are
 * ignored. A completed run built on superseded prerequisites becomes `stale` instead of integrating
 * (the re-check before successor integration).
 */
export function recordTaskRunOutcome(store: Store, ownerId: string, id: string, runId: string, outcome: TaskRunOutcome): TaskNode | undefined {
  return mutate(store, ownerId, graph => {
    const node = requireTaskNode(graph, id);
    if (node.runId !== runId || node.state !== 'running') return undefined;
    const extra = { action: 'run_outcome', runId, runStatus: outcome.status };
    if (outcome.status === 'cancelled') return moveTaskNode(store, ownerId, node, 'dropped', { reason: 'child run cancelled' }, extra);
    if (outcome.status !== 'completed') return moveTaskNode(store, ownerId, node, 'failed', { reason: `child run ${outcome.status}` }, extra);
    if (needsInputAnswer(outcome.finalText)) return moveTaskNode(store, ownerId, node, 'needs_input', {}, extra);
    if (node.dependencyChanged || !dependenciesCurrent(graph, node)) return moveTaskNode(store, ownerId, node, 'stale', {}, { ...extra, check: 'integration' });
    return moveTaskNode(store, ownerId, node, outcome.integrate || typeof node.check === 'object' ? 'integrating' : 'done',
      typeof node.check === 'object' ? {} : { verification: { status: 'unverified', reason: 'No executable host check was declared; legacy text is descriptive only.' } }, extra);
  });
}

/** Re-check immediately before the integrator touches the parent workspace: same generation, current prerequisites. */
export function taskIntegrationCurrent(store: Store, ownerId: string, id: string, generation: number): boolean {
  const graph = readTaskGraph(store, ownerId);
  const node = requireTaskNode(graph, id);
  return node.state === 'integrating' && node.generation === generation && !node.dependencyChanged && dependenciesCurrent(graph, node);
}

/** Settles an integrating node; a generation or prerequisite change during integration yields `stale`. */
export function finishTaskIntegration(store: Store, ownerId: string, id: string, generation: number, result: TaskIntegrationResult): TaskNode | undefined {
  return mutate(store, ownerId, graph => {
    const node = requireTaskNode(graph, id);
    if (node.generation !== generation || node.state !== 'integrating') return undefined;
    const extra = { action: 'integration', integration: result.status, ...(result.detail ? { detail: result.detail } : {}) };
    if (node.dependencyChanged || !dependenciesCurrent(graph, node)) return moveTaskNode(store, ownerId, node, 'stale', {}, { ...extra, check: 'integration' });
    if (result.status === 'conflict') return moveTaskNode(store, ownerId, node, 'conflict', { ...(result.detail ? { reason: result.detail } : {}) }, extra);
    if (result.status === 'failed') return moveTaskNode(store, ownerId, node, 'failed', { reason: result.detail ?? 'integration failed' }, extra);
    return moveTaskNode(store, ownerId, node, 'done', { ...(node.reason?.startsWith('Waiting for the workspace lock') ? { reason: undefined } : {}) }, extra);
  });
}
