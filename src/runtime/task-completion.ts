import type { Store } from '../storage/index.js';
import { dependenciesCurrent, readTaskGraph, taskGraphFingerprint, taskNode } from './task-graph.js';
import type { TaskGraph, TaskNode, TaskNodeState } from './task-graph.js';

/** Work some background executor (child run, integrator, scheduler) advances without the main agent. */
export interface TaskAutonomousItem { id: string; state: TaskNodeState }
/** Work nothing in the background can unblock; the main agent must act (plan 7.1). */
export interface TaskAttentionItem { id: string; state: TaskNodeState; reason: string; blockers?: string[]; actions: string[] }
export interface TaskGraphCompletionState {
  /** `feedback`: return feedback now (counts as a correction); `wait`: defer and wait durably (no correction); `complete`: graph passes. */
  decision: 'complete' | 'wait' | 'feedback';
  autonomous: TaskAutonomousItem[];
  needsMain: TaskAttentionItem[];
  dropped: { id: string; reason?: string }[];
  feedback?: string;
  /** Appended before the final answer so dropped work is not omitted from it. */
  droppedHint?: string;
  /** Compare with the terminal-transaction value; a difference means `completion.invalidated`. */
  fingerprint: string;
}

const autonomousStates: readonly TaskNodeState[] = ['running', 'integrating', 'queued'];
const blockingUpstream: readonly TaskNodeState[] = ['failed', 'conflict', 'needs_input', 'dropped', 'stale'];
const ownAttention: Partial<Record<TaskNodeState, { reason: string; actions: string[] }>> = {
  needs_input: { reason: 'the child asked for input', actions: ['resume', 'redo', 'drop'] },
  conflict: { reason: 'integration conflicted with the workspace', actions: ['redo', 'drop'] },
  stale: { reason: 'the result is based on a superseded prerequisite generation', actions: ['redo', 'task accept', 'drop'] },
  failed: { reason: 'the run or its integration failed and has not been inspected', actions: ['task inspect', 'resume', 'redo', 'drop'] },
};

/** Upstream nodes that stop `node` from advancing on its own: settled failures or unfinished `self` work. */
function upstreamBlockers(graph: TaskGraph, node: TaskNode): string[] {
  const blockers = new Set<string>(), seen = new Set<string>();
  const queue = [...node.after];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const upstream = taskNode(graph, id);
    if (!upstream) { blockers.add(id); continue; }
    if (blockingUpstream.includes(upstream.state) || (upstream.owner === 'self' && upstream.state !== 'done')) blockers.add(id);
    else if (upstream.state !== 'done') queue.push(...upstream.after);
  }
  return [...blockers];
}

function attention(graph: TaskGraph, node: TaskNode): TaskAttentionItem | undefined {
  if (node.owner === 'self') {
    const blockers = upstreamBlockers(graph, node);
    return { id: node.id, state: node.state, reason: blockers.length ? 'this self task waits on blocked prerequisites' : 'this task is owned by the main agent', ...(blockers.length ? { blockers } : {}), actions: ['task done', 'drop'] };
  }
  const own = ownAttention[node.state];
  if (own && !(node.state === 'failed' && node.acknowledged)) return { id: node.id, state: node.state, ...own,
    ...(['needs_input', 'failed'].includes(node.state) && node.verification?.status === 'failed' ? { reason: node.verification.reason ?? 'the host check did not pass', actions: ['recheck', 'resume', 'redo', 'drop'] } : {}) };
  if (node.state !== 'pending') return undefined;
  const blockers = upstreamBlockers(graph, node);
  return blockers.length ? { id: node.id, state: node.state, reason: 'a prerequisite failed, was dropped, needs input, is stale or is unfinished self work', blockers, actions: ['redo the prerequisite', 'drop', 'redeclare as self'] } : undefined;
}

function feedbackText(items: TaskAttentionItem[]): string {
  const lines = items.map(item => `- ${item.id} (${item.state}): ${item.reason}${item.blockers ? `; blocked by ${item.blockers.join(', ')}` : ''}. Options: ${item.actions.join(', ')}.`);
  return `TASK_GRAPH_INCOMPLETE: no background work can unblock these tasks; act on them before the final answer:\n${lines.join('\n')}`;
}

/**
 * Classifies unfinished task-graph work (plan 7.1). Any node that needs the main agent yields
 * immediate feedback even when other nodes are still advancing; only when every remaining node
 * advances on its own does the caller wait durably without counting a correction.
 */
export function classifyTaskGraph(graph: TaskGraph): TaskGraphCompletionState {
  const autonomous: TaskAutonomousItem[] = [], needsMain: TaskAttentionItem[] = [], dropped: { id: string; reason?: string }[] = [];
  for (const node of graph.nodes) {
    if (node.state === 'done') {
      if (!dependenciesCurrent(graph, node)) needsMain.push({ id: node.id, state: node.state, reason: 'the completed result references a superseded prerequisite generation', actions: ['redo'] });
      continue;
    }
    if (node.state === 'dropped') { dropped.push({ id: node.id, ...(node.reason ? { reason: node.reason } : {}) }); continue; }
    const item = attention(graph, node);
    if (item) needsMain.push(item);
    else if (autonomousStates.includes(node.state) || node.state === 'pending') autonomous.push({ id: node.id, state: node.state });
  }
  const droppedHint = dropped.length ? `Dropped tasks (disclose them in the final answer): ${dropped.map(item => `${item.id}${item.reason ? `: ${item.reason}` : ''}`).join('; ')}` : undefined;
  return { decision: needsMain.length ? 'feedback' : autonomous.length ? 'wait' : 'complete', autonomous, needsMain, dropped,
    ...(needsMain.length ? { feedback: feedbackText(needsMain) } : {}), ...(droppedHint ? { droppedHint } : {}), fingerprint: taskGraphFingerprint(graph) };
}

/** `taskGraphCompletionState` for the main run that owns the graph. */
export function taskGraphCompletionState(store: Store, ownerId: string): TaskGraphCompletionState {
  return classifyTaskGraph(currentGraph(store, ownerId));
}

/**
 * Terminal-transaction re-check (7.1): recompute the graph, re-verify every `done` node's recorded
 * prerequisite generations, and compare with the state accepted at the final answer. Call it inside
 * the main run's terminal transaction; `valid: false` means record `completion.invalidated` and requeue.
 */
export function taskGraphTerminalCheck(store: Store, ownerId: string, accepted: string): { valid: boolean; state: TaskGraphCompletionState; staleDone: string[] } {
  const graph = currentGraph(store, ownerId);
  const state = classifyTaskGraph(graph);
  const staleDone = graph.nodes.filter(node => node.state === 'done' && !dependenciesCurrent(graph, node)).map(node => node.id);
  return { valid: state.decision === 'complete' && !staleDone.length && state.fingerprint === accepted, state, staleDone };
}

function currentGraph(store: Store, ownerId: string): TaskGraph {
  const graph = readTaskGraph(store, ownerId);
  const decision = store.session(store.run(ownerId).sessionId).decisionVersion ?? 0;
  return { ...graph, nodes: graph.nodes.map(node => node.needs && node.state === 'done' && node.resultDecisionVersion !== decision ? { ...node, state: 'stale' } : node) };
}
