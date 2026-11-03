import { digest } from '../storage/index.js';
import type { Store } from '../storage/index.js';
import { KodoError, terminal } from '../runtime/types.js';
import { childIsActive } from '../messaging/spawn-spec.js';
import type { ToolRegistration } from './registry.js';
import type { Run } from '../runtime/types.js';
import { refreshTodoDependencies, todoDependenciesCurrent } from '../runtime/todo-dependencies.js';
import { readDynamicTodo, writeDynamicTodo } from './todo-dynamic.js';
import type { TodoUpdateOptions } from './todo-dynamic.js';
export { dynamicTodoSpec, validateDynamicTodoArgs } from './todo-dynamic.js';

export type TodoExecutor = 'main' | 'agent';
export interface TodoItem { id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; executor?: TodoExecutor; dependsOn?: string[]; title?: string; note?: string }
export interface TodoSnapshot { ownerRunId: string; revision: number; items: TodoItem[]; generations?: Record<string, number>; acceptedDependencies?: Record<string, { id: string; generation: number }[]> }
export interface TodoDispatchState {
  id: string;
  generation: number;
  state: 'awaiting_dispatch' | 'running' | 'needs_attention' | 'awaiting_acceptance' | 'completed';
  runIds: string[];
}
const eventType = 'todo.updated';
const schema = {
  type: 'object', additionalProperties: false, required: ['expectedRevision', 'items'],
  properties: {
    expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
    items: { type: 'array', maxItems: 100, items: {
      type: 'object', additionalProperties: false, required: ['id', 'content', 'status'],
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, content: { type: 'string', minLength: 1, maxLength: 1000 }, status: { enum: ['pending', 'in_progress', 'completed'] }, executor: { enum: ['main', 'agent'] }, dependsOn: { type: 'array', uniqueItems: true, maxItems: 100, items: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } } },
    } },
  },
};

export function readTodoSnapshot(store: Store, runId: string): TodoSnapshot {
  const latest = store.latestEvent(runId, { types: [eventType] });
  return latest ? (latest.data as unknown as { snapshot: TodoSnapshot }).snapshot : { ownerRunId: runId, revision: 0, items: [] };
}

/** Continue the same audited task plan after recovery changes its run identity. */
export function carryRecoveryTodo(store: Store, sourceId: string, targetId: string, replacements: ReadonlyMap<string, string>): void {
  const source = store.run(sourceId);
  const target = store.run(targetId);
  if (source.sessionId !== target.sessionId || target.continuationOf !== sourceId || target.historyFrom === sourceId || !store.hasEvent(sourceId, { types: ['recovery.continued'], match: { runId: targetId } })) throw new KodoError('TODO_OWNER', 'task plans transfer only across an audited same-session recovery');
  if (store.latestEvent(targetId, { types: [eventType] })) return;
  const snapshot = readTodoSnapshot(store, sourceId);
  if (!snapshot.revision) return;
  store.event(targetId, eventType, { snapshot: { ...structuredClone(snapshot), ownerRunId: targetId }, recoverySourceRunId: sourceId });
  for (const event of store.events(sourceId, { types: ['todo.dispatched'] })) {
    const childId = event.data.childRunId as string;
    store.event(targetId, 'todo.dispatched', { todoId: event.data.todoId, generation: event.data.generation, childRunId: replacements.get(childId) ?? childId, recoverySourceRunId: sourceId });
  }
}

export function itemGeneration(snapshot: TodoSnapshot, id: string): number {
  return snapshot.generations && Object.hasOwn(snapshot.generations, id) ? snapshot.generations[id]! : snapshot.revision;
}

export function parallelTasks(store: Store, runId: string): boolean {
  return (store.session(store.run(runId).sessionId).taskProtocol ?? 1) >= 2;
}

/** Resolve inside the same transaction that prepares and commits a child. */
export function resolveTodoAssignment(store: Store, parentId: string, todoId: unknown): Run['todo'] {
  if (!parallelTasks(store, parentId)) {
    if (todoId !== undefined) throw new KodoError('TODO_PROTOCOL', 'explicit todoId requires task protocol 2');
    return;
  }
  if (todoId === undefined) return;
  const snapshot = readTodoSnapshot(store, parentId);
  const item = snapshot.items.find(item => item.id === todoId);
  if (!item || item.executor !== 'agent' || item.status === 'completed') throw new KodoError('TODO_ASSIGNMENT', 'todoId must name an unfinished agent-owned task in this run');
  return { id: item.id, generation: itemGeneration(snapshot, item.id), dependencies: (item.dependsOn ?? []).map(id => ({ id, generation: itemGeneration(snapshot, id) })) };
}

export function activeAgentTodo(store: Store, runId: string): { id: string; generation: number } | undefined {
  if (store.run(runId).parentId) return;
  const snapshot = readTodoSnapshot(store, runId);
  const item = snapshot.items.find(item => item.status === 'in_progress' && item.executor === 'agent');
  return item ? { id: item.id, generation: itemGeneration(snapshot, item.id) } : undefined;
}

/** Called in the child-creation transaction, after the child run has been persisted. */
export function recordTodoDispatch(store: Store, parentId: string, childRunId: string): void {
  const child = store.run(childRunId);
  const active = parallelTasks(store, parentId) ? child.todo : activeAgentTodo(store, parentId);
  if (!active) return;
  const parent = store.run(parentId);
  if (child.parentId !== parentId || child.sessionId !== parent.sessionId) throw new KodoError('TODO_DISPATCH_OWNER', 'dispatched work must belong to this parent run and session');
  const data = { todoId: active.id, generation: active.generation, childRunId };
  if (!store.hasEvent(parentId, { types: ['todo.dispatched'], match: data })) store.event(parentId, 'todo.dispatched', data);
}

export function dispatchedRuns(store: Store, runId: string, todoId?: string, generation?: number) {
  const events = store.events(runId, todoId === undefined || generation === undefined ? { types: ['todo.dispatched'] } : { types: ['todo.dispatched'], match: { todoId, generation } });
  const ids = new Set(events.map(event => event.data.childRunId as string));
  return [...ids].map(id => store.run(id));
}

export function todoDispatchState(store: Store, runId: string): TodoDispatchState[] {
  const snapshot = readTodoSnapshot(store, runId);
  return snapshot.items.filter(item => item.executor === 'agent').map(item => {
    const generation = itemGeneration(snapshot, item.id);
    const runs = dispatchedRuns(store, runId, item.id, generation);
    const state: TodoDispatchState['state'] = runs.some(run => childIsActive(store, run)) ? 'running'
      : runs.length === 0 ? 'awaiting_dispatch'
        : !runs.some(run => run.status === 'completed') ? 'needs_attention'
          : item.status === 'completed' && (!parallelTasks(store, runId) || runs.some(run => run.status === 'completed' && todoDependenciesCurrent(store, run))) ? 'completed' : 'awaiting_acceptance';
    return { id: item.id, generation, state, runIds: runs.map(run => run.id) };
  });
}

/** Completion remains a parent decision, after every dispatched run has settled. */
export function todoCompletionFeedback(store: Store, runId: string): string | undefined {
  const pending = todoDispatchState(store, runId).filter(item => item.state !== 'completed');
  const active = dispatchedRuns(store, runId).filter(run => childIsActive(store, run));
  if (!pending.length && !active.length) return;
  return `Delegated work is not yet accepted. ${pending.map(item => `${item.id}: ${item.state}`).join('; ')}${active.length ? ` Unsettled child runs: ${active.map(run => run.id).join(', ')}.` : ''} Use todo.read, resolve or wait for delegated work, inspect its evidence, and explicitly complete accepted items with todo.write.`;
}

/** Run-owned plans are internal durable state, never workspace files or cross-agent writes. */
export function todoTools(store: Store, options: TodoUpdateOptions = {}): ToolRegistration[] {
  return [
    {
      name: 'todo.read', version: '2', permission: 'read', effect: 'read',
      description: 'Read this run’s persistent task list, revision, and delegated task dispatch states. Lists are private to the current run and survive application restart.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute({ run, session, signal }, args) {
        signal.throwIfAborted();
        if (store.run(run.id).sessionId !== session.id) throw new KodoError('TODO_OWNER', 'task list belongs to a different session');
        if (session.taskProtocol === 3) return readDynamicTodo(store, run.id, args);
        const snapshot = readTodoSnapshot(store, run.id);
        const dispatch = todoDispatchState(store, run.id);
        return dispatch.length ? { ...snapshot, dispatch } : snapshot;
      },
    },
    {
      name: 'todo.write', version: '2', permission: 'read', effect: 'read', parameters: schema,
      description: 'Update this run’s persistent plan with expectedRevision (0 initially). Preserve IDs. Set executor main or agent in team-lead mode; children use main. Task protocol 2 permits independent in_progress items, explicit todoId on dispatch and optional dependsOn IDs. Dependencies must be accepted before execution. Legacy sessions allow one active item and implicit dispatch association. Accept delegated work after a child completes and all linked runs settle; inspect evidence first. When accepting, preserve content, executor and dependsOn; reopen or create a task for changed work. Do not rewrite an active assignment. This bookkeeping never proves overall completion.',
      execute({ run, session, signal, markEffectStarted }, args) {
        signal.throwIfAborted();
        if (session.taskProtocol === 3) return writeDynamicTodo(store, { run, session, signal, markEffectStarted }, args, options);
        return store.transaction(() => {
          const current = store.run(run.id);
          if (current.sessionId !== session.id) throw new KodoError('TODO_OWNER', 'task list belongs to a different session');
          if (terminal(current.status)) throw new KodoError('TODO_TERMINAL', 'a finished run cannot change its task list');
          const items = args.items as TodoItem[];
          const parallel = parallelTasks(store, run.id);
          if (new Set(items.map(item => item.id)).size !== items.length) throw new KodoError('TODO_ITEMS', 'task IDs must be unique');
          if (!parallel && items.filter(item => item.status === 'in_progress').length > 1) throw new KodoError('TODO_ITEMS', 'only one task may be in_progress');
          if (!parallel && items.some(item => item.dependsOn?.length)) throw new KodoError('TODO_PROTOCOL', 'dependencies require task protocol 2');
          validateDependencies(items);
          if (items.some(item => !item.content.trim() || item.content.includes('\0'))) throw new KodoError('TODO_ITEMS', 'task content must contain visible text and no NUL');
          const previous = readTodoSnapshot(store, run.id);
          if (args.expectedRevision !== previous.revision) throw new KodoError('TODO_CONFLICT', 'task revision changed; read the current list before updating');
          if (current.parentId && items.some(item => item.executor === 'agent')) throw new KodoError('TODO_EXECUTOR', 'child task lists cannot delegate to another agent; use executor main');
          if (!current.parentId && store.session(current.sessionId).agentFactors?.B === true && items.some(item => item.executor === undefined)) throw new KodoError('TODO_EXECUTOR', 'team-lead task lists require executor main or agent on every item');
          const generations = new Map(Object.entries(previous.generations ?? {}).filter(([id]) => items.some(item => item.id === id && (parallel || item.executor === 'agent'))));
          for (const old of previous.items.filter(item => item.executor === 'agent')) {
            const next = items.find(item => item.id === old.id);
            const active = dispatchedRuns(store, run.id, old.id, itemGeneration(previous, old.id)).some(child => childIsActive(store, child));
            if (active && (!next || next.executor !== 'agent' || next.content !== old.content || JSON.stringify(next.dependsOn ?? []) !== JSON.stringify(old.dependsOn ?? []) || (!parallel && next.status === 'pending') || (old.status === 'completed' && next.status !== 'completed'))) {
              throw new KodoError('TODO_ACTIVE', `task ${old.id} has active delegated work; settle its child runs before changing or removing the assignment`);
            }
          }
          for (const item of items.filter(item => parallel || item.executor === 'agent')) {
            const old = previous.items.find(old => old.id === item.id);
            const assignmentChanged = old && (old.executor !== item.executor || old.content !== item.content || JSON.stringify(old.dependsOn ?? []) !== JSON.stringify(item.dependsOn ?? []));
            if (item.status === 'completed' && item.executor === 'agent' && assignmentChanged) {
              throw new KodoError('TODO_ACCEPTANCE', `task ${item.id} changes its assignment while marking it completed; acceptance cannot reuse evidence from the previous task generation. Use todo.read and preserve content, executor and dependsOn when accepting. For changed work, set pending or in_progress and dispatch a child for the new generation.`);
            }
            if (!old || assignmentChanged || (old.status === 'completed' && item.status !== 'completed') || !generations.has(item.id)) generations.set(item.id, previous.revision + 1);
            if (item.status === 'completed' && item.executor === 'agent') {
              const runs = dispatchedRuns(store, run.id, item.id, generations.get(item.id));
              if (!runs.some(child => child.status === 'completed') || runs.some(child => childIsActive(store, child))) {
                throw new KodoError('TODO_ACCEPTANCE', `task ${item.id} requires a completed child and all linked child runs settled before acceptance`);
              }
              if (parallel && !runs.some(child => child.status === 'completed' && todoDependenciesCurrent(store, child))) throw new KodoError('TODO_DEPENDENCY_CHANGED', `task ${item.id} needs a completed run verified against the current accepted dependency versions`);
            }
          }
          signal.throwIfAborted();
          markEffectStarted();
          const snapshot: TodoSnapshot = { ownerRunId: run.id, revision: previous.revision + 1, items: structuredClone(items), ...(generations.size ? { generations: Object.fromEntries(generations) } : {}) };
          store.event(run.id, eventType, { snapshot, argsDigest: digest(JSON.stringify(args)) });
          if (parallel) refreshTodoDependencies(store, run.id);
          return snapshot;
        });
      },
      recover({ run, request, signal }) {
        signal.throwIfAborted();
        const hash = digest(JSON.stringify(JSON.parse(request.arguments) as unknown));
        const committed = store.latestEvent(run.id, { types: [eventType], match: { argsDigest: hash } });
        return committed ? { outcome: 'succeeded', evidence: 'The run-owned task update committed in the durable event store.', result: committed.data.result ?? (committed.data as unknown as { snapshot: TodoSnapshot }).snapshot }
          : { outcome: 'not_applied', evidence: 'No matching task update committed; the transaction left no partial state.' };
      },
    },
  ];
}

function validateDependencies(items: TodoItem[]): void {
  const byId = new Map(items.map(item => [item.id, item]));
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new KodoError('TODO_DEPENDENCY', 'task dependencies must not contain cycles');
    if (visited.has(id)) return;
    const item = byId.get(id);
    if (!item) throw new KodoError('TODO_DEPENDENCY', `dependency ${id} does not exist in the task list`);
    visiting.add(id);
    for (const prerequisite of item.dependsOn ?? []) visit(prerequisite);
    visiting.delete(id); visited.add(id);
    if (item.status === 'completed' && (item.dependsOn ?? []).some(id => byId.get(id)?.status !== 'completed')) throw new KodoError('TODO_DEPENDENCY', `task ${id} cannot complete before its dependencies are accepted`);
  };
  for (const item of items) visit(item.id);
}
