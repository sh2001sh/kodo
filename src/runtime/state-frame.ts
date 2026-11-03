import { activeMethod, effectiveMethodRun, methodCatalogDigest } from '../extensions/methods.js';
import { attachment, attachmentKind, attachmentKinds, escapeMarkers } from './attachments.js';
import { deliverableStatus } from './deliverables.js';
import { effectiveSession } from './step-host.js';
import type { StepHost } from './step-host.js';
import type { Store } from '../storage/index.js';
import { runMemory } from './memory.js';
import { excerpt } from './tool-result-prune.js';
import { terminal } from './types.js';
import { todoDispatchState } from '../tools/todo.js';
import { readTaskGraph } from './task-graph.js';
import type { Call, Message, Run, Session } from './types.js';

/** Unsettled calls shown in the state frame; the rest are only counted. */
export const stateFrameCalls = 5;
const unsettledOrder: Call['status'][] = ['unknown', 'running', 'planned', 'failed'];
// Failed calls are settled outcomes, already delivered as tool results. Keep
// their audit/history records without repeatedly labelling them pending work.
const leanPendingOrder: Call['status'][] = ['unknown', 'running', 'planned'];
const deliveryCache = new WeakMap<Store, Map<string, { key: string; observedAt: string; items: { deliverable: string; status: string }[] }>>();

export interface ContextPressure { inputTokens: number; triggerTokens: number; hardCapacityTokens: number }

/** L4 body: the current workspace, platform, effective permissions, decisions and process boundary. */
export function environmentBlock(host: StepHost, run: Run, session: Session): Message {
  run = effectiveMethodRun(host.store, run);
  const memory = runMemory(host.store, run.id);
  const body = [
    `Workspace: ${session.workspace}. Platform: ${process.platform}.`,
    `Current decision version: ${session.decisionVersion ?? 0}. Effective permissions: ${effectiveSession(run, session).permissions.join(', ') || 'none'}. Current user decisions: ${JSON.stringify(host.store.decisions(session.id))}`,
    `Current execution environment: ${host.tools.environmentDescription()} Native file scope (relative workspace roots): ${JSON.stringify(run.scope ?? {})}. Omitted sides inherit workspace access; empty arrays deny that operation.`,
    ...(memory ? [`Recorded session memory (historical claims, verify before relying on them): ${JSON.stringify(memory)}`] : []),
  ].join('\n');
  return attachment('environment', body);
}

/**
 * Places the environment block: the first one joins the frozen prefix right
 * after the system rules and project instructions; a changed environment is
 * appended as a delta so the prefix never changes.
 */
export function withEnvironment(context: Message[], block: Message): Message[] {
  const current = context.findLast(message => attachmentKind(message) === 'environment');
  if (current?.content === block.content) return context;
  if (current) return [...context, block];
  let index = 0;
  while (index < context.length && (context[index]!.role === 'system' || ['agents', 'project-instructions'].includes(attachmentKind(context[index]!) ?? ''))) index++;
  return [...context.slice(0, index), block, ...context.slice(index)];
}

/**
 * Lean views send the state frame only while it carries dynamic work: active
 * children, waits, unsettled calls, pending messages, context pressure or a
 * nearly exhausted time budget. The objective is already in the task message.
 */
export function leanStateFrame(host: StepHost, run: Run, session: Session, pressure?: ContextPressure): Message | undefined {
  const { store } = host;
  const unsettled = store.countCalls(run.id, { kind: 'tool', status: leanPendingOrder });
  const children = store.listRuns(session.id).filter(child => child.parentId === run.id && !terminal(child.status));
  const waits = store.waits(session.id, true).filter(wait => wait.runId === run.id);
  const limit = session.budget.maxDurationMs;
  const used = (session.activeMs ?? 0) + (session.activeSince === undefined ? 0 : Math.max(0, Date.now() - session.activeSince));
  const remainingMs = limit === null ? null : Math.max(0, limit - used);
  const lowTime = remainingMs !== null && limit !== null && remainingMs < limit * 0.25;
  const overPressure = Boolean(pressure && pressure.inputTokens > pressure.triggerTokens);
  if (!unsettled && !children.length && !waits.length && !store.countInbox(run.id) && !lowTime && !overPressure) return undefined;
  const calls = store.queryCalls(run.id, { kind: 'tool', status: leanPendingOrder, limit: stateFrameCalls, statusOrder: leanPendingOrder });
  return attachment('state', JSON.stringify({
    step: run.step,
    ...(calls.length ? { calls: calls.map(call => ({ id: call.id, name: call.name, status: call.status })), ...(unsettled > stateFrameCalls ? { moreCalls: unsettled - stateFrameCalls } : {}) } : {}),
    ...(children.length ? { children: children.slice(0, 8).map(child => ({ id: child.id, status: child.status })) } : {}),
    ...(waits.length ? { waits: waits.slice(0, 4).map(wait => ({ id: wait.id, mode: wait.mode })) } : {}),
    ...(store.countInbox(run.id) ? { pendingMessages: store.countInbox(run.id) } : {}),
    ...(lowTime ? { remainingMinutes: Math.round(remainingMs! / 60_000) } : {}),
    ...(overPressure ? { context: { ...pressure, unit: 'estimated tokens' } } : {}),
    note: 'Runtime status. Unknown writes are never repeated; the host verifies them.',
  }));
}

/** L7: authoritative runtime status sent last on every request and never stored in history. */
export function stateFrame(host: StepHost, run: Run, session: Session, pressure?: ContextPressure): Message {
  const { store } = host;
  const runs = store.listRuns(session.id);
  let delivery: { observedAt: string; items: { deliverable: string; status: string }[] } | undefined;
  if (!run.parentId && run.deliverables?.length) {
    let cache = deliveryCache.get(store);
    if (!cache) deliveryCache.set(store, cache = new Map());
    // Model-only steps do not repeatedly walk deliverable globs. Writes by any
    // run and changed-file observations invalidate this observation; completion
    // still performs a fresh filesystem check, including unobserved external edits.
    const key = JSON.stringify([run.deliverables, session.decisionVersion, ...runs.map(owner => {
      const write = store.queryCalls(owner.id, { kind: 'tool', effect: 'write', limit: 1 })[0];
      return [owner.id, owner.status, write?.id, write?.status, store.latestEvent(owner.id, { types: ['files.changed'] })?.seq];
    })]);
    let cached = cache.get(run.id);
    if (!cached || cached.key !== key) {
      cached = { key, observedAt: new Date().toISOString(), items: deliverableStatus(session.workspace, run.deliverables, Date.parse(run.createdAt)).map(item => ({ deliverable: item.label, status: item.status })) };
      cache.set(run.id, cached);
    }
    delivery = cached;
  }
  const filter = { kind: 'tool', status: unsettledOrder };
  const unsettled = store.queryCalls(run.id, { ...filter, limit: stateFrameCalls, statusOrder: unsettledOrder });
  const unsettledCount = store.countCalls(run.id, filter);
  const children = runs.filter(child => child.parentId === run.id && !terminal(child.status));
  const waits = store.waits(session.id, true).filter(wait => wait.runId === run.id);
  const knowledge = store.knowledge.usesOf(run.id);
  const dispatch = todoDispatchState(store, run.id);
  const state = {
    objective: excerpt(run.objective, 600), step: run.step, decisionVersion: session.decisionVersion ?? 0,
    ...(session.inlineMethods && !run.parentId ? { method: activeMethod(store, run.id) ?? null, methodCatalog: methodCatalogDigest(session.methodCards), stages: readTaskGraph(store, run.id).nodes.slice(0, 8).map(node => ({ id: node.id, state: node.state, generation: node.generation, ...(node.runId ? { runId: node.runId } : {}), staleDecision: node.resultDecisionVersion !== undefined && node.resultDecisionVersion !== (session.decisionVersion ?? 0) })) } : {}),
    toolTimeoutMs: session.budget.toolTimeoutMs,
    ...(dispatch.length ? { todoDispatch: dispatch.slice(0, 12).map(item => ({ ...item, runIds: item.runIds.slice(-8), omittedRuns: Math.max(0, item.runIds.length - 8) })), todoDispatchOmitted: Math.max(0, dispatch.length - 12), todoDispatchReadMore: 'todo.read' } : {}),
    remainingTokens: session.budget.maxTokens === null ? null : Math.max(0, session.budget.maxTokens - session.tokens),
    ...(delivery ? { deliverables: delivery.items.map(item => ({ ...item, deliverable: excerpt(item.deliverable, 160) })), deliverablesObservedAt: delivery.observedAt } : {}),
    children: children.slice(0, 8).map(child => ({ id: child.id, status: child.status, waitId: child.waitId })),
    waits: waits.slice(0, 4).map(wait => ({ id: wait.id, deadline: wait.deadline, mode: wait.mode, questions: wait.questionIds.length, runs: wait.runIds.length })),
    calls: unsettled.slice(0, stateFrameCalls).map(call => ({ id: call.id, name: call.name, status: call.status, effect: call.effect, decisionVersion: call.decisionVersion ?? 0 })),
    ...(unsettledCount > stateFrameCalls ? { moreCalls: unsettledCount - stateFrameCalls } : {}),
    pendingMessages: store.countInbox(run.id),
    ...(pressure && pressure.inputTokens > pressure.triggerTokens ? { context: { ...pressure, unit: 'estimated tokens', note: 'Context remains above the compaction trigger. Finish the current subtask or record its progress with update_progress.' } } : {}),
    knowledge: knowledge.slice(-4).map(use => ({ id: excerpt(use.id, 128), revision: use.revision, purpose: excerpt(use.purpose, 80) })),
    omitted: { children: Math.max(0, children.length - 8), waits: Math.max(0, waits.length - 4), knowledge: Math.max(0, knowledge.length - 4), deliverables: 0 },
    note: 'Runtime status, not task acceptance. Deliverable observations are refreshed after writes; completion checks current files independently. Unknown writes require reconciliation, never repetition. Use inspect_run for bounded evidence; knowledge versions are fixed.',
  };
  // Preserve valid JSON under the registry budget instead of cutting a JSON
  // string halfway through a property. The five call rows always survive.
  while (escapeMarkers(JSON.stringify(state)).length > attachmentKinds.state.maxChars) {
    if (state.knowledge.length) { state.knowledge.pop(); state.omitted.knowledge++; }
    else if (state.todoDispatch?.length) { state.todoDispatch.pop(); state.todoDispatchOmitted!++; }
    else if (state.deliverables?.length) { state.deliverables.pop(); state.omitted.deliverables++; }
    else if (state.waits.length) { state.waits.pop(); state.omitted.waits++; }
    else if (state.children.length) { state.children.pop(); state.omitted.children++; }
    else break;
  }
  return attachment('state', JSON.stringify(state));
}
