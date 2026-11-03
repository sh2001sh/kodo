import { Ajv } from 'ajv';
import type { Store } from '../storage/index.js';
import { digest } from '../storage/index.js';
import { KodoError, terminal } from '../runtime/types.js';
import type { Run, ToolSpec } from '../runtime/types.js';
import { childIsActive } from '../messaging/spawn-spec.js';
import { refreshTodoDependencies, todoDependenciesCurrent } from '../runtime/todo-dependencies.js';
import type { ToolExecutionContext } from './registry.js';
import { dispatchedRuns, itemGeneration, readTodoSnapshot, todoDispatchState } from './todo.js';
import type { TodoItem, TodoSnapshot } from './todo.js';

export interface TodoUpdateOptions { cancelQueued?: (runId: string, parentId: string) => void }
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' };
const ids = { type: 'array', uniqueItems: true, maxItems: 100, items: id };
const fields = {
  id, content: { type: 'string', minLength: 1, maxLength: 1000 },
  status: { enum: ['pending', 'in_progress', 'completed'] }, executor: { enum: ['main', 'agent'] }, dependsOn: ids,
  title: { type: 'string', maxLength: 160 }, note: { type: 'string', maxLength: 1000 },
};
const readSpec: ToolSpec = {
  name: 'todo.read',
  description: 'Read a bounded view of this run’s tasks, current revision, dependency blockers and dispatches. Defaults to unfinished or recently changed tasks. Use ids for selected tasks, or full:true with offset/limit for the complete plan. Task content defines the work; title/note are display only. Persisted plans survive restart.',
  parameters: { type: 'object', additionalProperties: false, properties: { ids, full: { type: 'boolean' }, offset: { type: 'integer', minimum: 0, maximum: 100 }, limit: { type: 'integer', minimum: 1, maximum: 25 } } },
};
const writeSpec: ToolSpec = {
  name: 'todo.write',
  description: 'Atomically update tasks by stable ID with expectedRevision (0 initially). Prefer updates:[{id,status,note}] for progress; new IDs require content and status. title/note never change task identity. content, executor or dependsOn changes require new evidence; dependencies are unordered. remove deletes IDs in the same transaction. Optional cancelQueued explicitly cancels listed never-started direct child runs before replacing their tasks; running work must settle first. items is an alternative full replacement, not a patch. Returned items are bounded summaries; use todo.read by ID for full definitions. Accepted results and dependent completed tasks become stale when their inputs change. This plan does not prove overall correctness.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['expectedRevision'],
    properties: {
      expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
      items: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id', 'content', 'status'], properties: fields } },
      updates: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id'], properties: fields } },
      remove: ids,
      cancelQueued: { type: 'array', uniqueItems: true, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } },
    },
    oneOf: [{ required: ['items'], not: { anyOf: [{ required: ['updates'] }, { required: ['remove'] }] } }, { required: ['updates'], not: { required: ['items'] } }, { required: ['remove'], not: { anyOf: [{ required: ['items'] }, { required: ['updates'] }] } }],
  },
};
const ajv = new Ajv({ allErrors: true, strictRequired: false });
const validators = new Map([readSpec, writeSpec].map(spec => [spec.name, ajv.compile(spec.parameters)]));

/** Old registration fingerprints remain intact; only protocol 3 advertises these schemas. */
export function dynamicTodoSpec(name: string): ToolSpec | undefined {
  return name === readSpec.name ? structuredClone(readSpec) : name === writeSpec.name ? structuredClone(writeSpec) : undefined;
}
export function validateDynamicTodoArgs(name: string, args: unknown): void {
  const validator = validators.get(name);
  if (!validator || !validator(args)) throw new KodoError('TOOL_ARGUMENTS', `arguments do not match the ${name} protocol 3 schema: ${ajv.errorsText(validator?.errors)}`);
}

export function readDynamicTodo(store: Store, runId: string, args: Record<string, unknown>): unknown {
  validateDynamicTodoArgs('todo.read', args);
  const snapshot = readTodoSnapshot(store, runId);
  if (!snapshot.revision && !Object.keys(args).length) return snapshot;
  const changed = new Set((store.latestEvent(runId, { types: ['todo.updated'] })?.data.changedIds as string[] | undefined) ?? []);
  const requested = args.ids as string[] | undefined;
  if (requested?.some(id => !snapshot.items.some(item => item.id === id))) throw new KodoError('TODO_ITEMS', 'requested task does not exist');
  const relevant = snapshot.items.filter(item => requested ? requested.includes(item.id) : args.full || item.status !== 'completed' || changed.has(item.id));
  const offset = args.offset as number ?? 0, limit = args.limit as number ?? 10;
  const items = relevant.slice(offset, offset + limit);
  const selected = new Set(items.map(item => item.id));
  const dispatch = todoDispatchState(store, runId).filter(item => selected.has(item.id));
  return {
    ownerRunId: runId, revision: snapshot.revision, items,
    generations: Object.fromEntries(items.map(item => [item.id, itemGeneration(snapshot, item.id)])),
    ...(dispatch.length ? { dispatch } : {}),
    readiness: items.map(item => {
      const blockedBy = (item.dependsOn ?? []).filter(id => !snapshot.items.some(dependency => dependency.id === id && dependency.status === 'completed'));
      return { id: item.id, ready: item.status !== 'completed' && !blockedBy.length, blockedBy };
    }),
    total: snapshot.items.length, matching: relevant.length,
    next: offset + items.length < relevant.length ? { ...args, offset: offset + items.length, limit } : null,
  };
}

const dependencies = (item: TodoItem): string[] => [...(item.dependsOn ?? [])].sort();
function assignmentChanged(previous: TodoItem, next: TodoItem): boolean {
  return previous.content !== next.content || previous.executor !== next.executor || JSON.stringify(dependencies(previous)) !== JSON.stringify(dependencies(next));
}
function candidateItems(previous: TodoSnapshot, args: Record<string, unknown>): { items: TodoItem[]; explicitCompletion: Set<string> } {
  const updates = args.updates as (Partial<TodoItem> & { id: string })[] | undefined;
  const removed = new Set(args.remove as string[] ?? []);
  if (updates && new Set(updates.map(item => item.id)).size !== updates.length) throw new KodoError('TODO_ITEMS', 'update IDs must be unique');
  if ([...removed].some(id => !previous.items.some(item => item.id === id))) throw new KodoError('TODO_ITEMS', 'cannot remove a missing task');
  if (updates?.some(item => removed.has(item.id))) throw new KodoError('TODO_ITEMS', 'cannot update and remove the same task');
  const byId = new Map(previous.items.filter(item => !removed.has(item.id)).map(item => [item.id, structuredClone(item)]));
  for (const update of updates ?? []) {
    const item = { ...byId.get(update.id), ...update };
    if (!item.content || !item.status) throw new KodoError('TODO_ITEMS', `new task ${item.id} requires content and status`);
    byId.set(item.id, item as TodoItem);
  }
  const raw = args.items as TodoItem[] | undefined;
  const items = structuredClone(raw ?? [...byId.values()]).map(item => ({ ...item, dependsOn: dependencies(item) }));
  if (items.length > 100 || new Set(items.map(item => item.id)).size !== items.length) throw new KodoError('TODO_ITEMS', 'plan requires at most 100 unique task IDs');
  if (items.some(item => !item.content.trim() || [item.content, item.title, item.note].some(text => text?.includes('\0')))) throw new KodoError('TODO_ITEMS', 'task text must contain visible content and no NUL');
  return { items, explicitCompletion: new Set((raw ?? updates ?? []).filter(item => item.status === 'completed').map(item => item.id)) };
}

/** Returns prerequisites before consumers; order in the displayed list is not a dependency. */
function topological(items: TodoItem[]): TodoItem[] {
  const byId = new Map(items.map(item => [item.id, item])), visiting = new Set<string>(), visited = new Set<string>(), sorted: TodoItem[] = [];
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new KodoError('TODO_DEPENDENCY', 'task dependencies must not contain cycles');
    if (visited.has(id)) return;
    const item = byId.get(id);
    if (!item) throw new KodoError('TODO_DEPENDENCY', `dependency ${id} does not exist in the task list`);
    visiting.add(id);
    for (const dependency of item.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id); sorted.push(item);
  };
  for (const item of items) visit(item.id);
  return sorted;
}

function queuedCancellations(store: Store, parent: Run, args: Record<string, unknown>, changed: Set<string>, options: TodoUpdateOptions): Run[] {
  const ids = args.cancelQueued as string[] ?? [];
  if (ids.length && !options.cancelQueued) throw new KodoError('TODO_ACTIVE', 'cancelQueued is unavailable; cancel_agent the listed child runs first, then retry the plan update');
  return ids.map(id => {
    const run = store.listRuns(parent.sessionId).find(item => item.id === id);
    if (!run || run.parentId !== parent.id || !run.todo || !changed.has(run.todo.id)) throw new KodoError('TODO_ACTIVE', `cancelQueued ${id} must name this parent’s dispatched task being changed or removed`);
    if (run.status !== 'queued' || run.step !== 0 || run.stepCallId || run.waitId || run.execution || run.cancelRequested || run.interruptRequested || store.calls(id).length || store.hasEvent(id, { types: ['execution.prepared'] }) || store.listRuns(parent.sessionId).some(child => child.parentId === id)) {
      throw new KodoError('TODO_ACTIVE', `run ${id} may have started; use cancel_agent and wait for settlement before changing its assignment`);
    }
    return run;
  });
}

function updateResult(snapshot: TodoSnapshot, changedIds: string[], removedIds: string[], invalidated: string[]) {
  const selected = [...snapshot.items.filter(item => changedIds.includes(item.id)), ...snapshot.items.filter(item => !changedIds.includes(item.id) && item.status !== 'completed')].slice(0, 10);
  return {
    ownerRunId: snapshot.ownerRunId, revision: snapshot.revision,
    items: selected.map(item => ({ ...item, content: item.content.slice(0, 400), ...(item.note !== undefined ? { note: item.note.slice(0, 200) } : {}), dependsOn: item.dependsOn?.slice(0, 10) ?? [],
      ...(item.content.length > 400 || (item.note?.length ?? 0) > 200 || (item.dependsOn?.length ?? 0) > 10 ? { detailsTruncated: true } : {}),
    })),
    generations: Object.fromEntries(selected.map(item => [item.id, itemGeneration(snapshot, item.id)])),
    total: snapshot.items.length, omitted: snapshot.items.length - selected.length, changedIds, removedIds, invalidated,
    read: { full: true, limit: 10 },
  };
}

export function writeDynamicTodo(store: Store, context: ToolExecutionContext, args: Record<string, unknown>, options: TodoUpdateOptions): TodoSnapshot {
  validateDynamicTodoArgs('todo.write', args);
  const { run, session, signal, markEffectStarted } = context;
  return store.transaction(() => {
    const current = store.run(run.id);
    if (current.sessionId !== session.id) throw new KodoError('TODO_OWNER', 'task list belongs to a different session');
    if (terminal(current.status)) throw new KodoError('TODO_TERMINAL', 'a finished run cannot change its task list');
    const previous = readTodoSnapshot(store, run.id);
    if (args.expectedRevision !== previous.revision) throw new KodoError('TODO_CONFLICT', 'task revision changed; read the current list before updating');
    const { items, explicitCompletion } = candidateItems(previous, args);
    if (current.parentId && items.some(item => item.executor === 'agent')) throw new KodoError('TODO_EXECUTOR', 'child task lists cannot delegate; use executor main');
    if (!current.parentId && session.agentFactors?.B && items.some(item => item.executor === undefined)) throw new KodoError('TODO_EXECUTOR', 'set executor main or agent for each task');
    const sorted = topological(items), byId = new Map(items.map(item => [item.id, item]));
    const revision = previous.revision + 1, generations = new Map(Object.entries(previous.generations ?? {}));
    const changed = new Set<string>(), invalidated: string[] = [];
    const accepted = Object.assign(Object.create(null) as NonNullable<TodoSnapshot['acceptedDependencies']>, structuredClone(previous.acceptedDependencies ?? {}));
    for (const old of previous.items) {
      const next = byId.get(old.id);
      if (!next || assignmentChanged(old, next) || (old.status === 'completed' && next.status !== 'completed')) changed.add(old.id);
      if (!next) { generations.delete(old.id); delete accepted[old.id]; }
    }
    for (const item of items) {
      const old = previous.items.find(old => old.id === item.id);
      if (!old || changed.has(item.id) || !generations.has(item.id)) generations.set(item.id, revision);
      if (old && changed.has(item.id) && item.status === 'completed') throw new KodoError('TODO_ACCEPTANCE', `task ${item.id} changes its definition while completing; reopen it and obtain evidence for the new version first. Use title/note for display-only changes.`);
      if (item.status !== 'completed') delete accepted[item.id];
    }
    const snapshot: TodoSnapshot = { ownerRunId: run.id, revision, items, generations: Object.fromEntries(generations), acceptedDependencies: accepted };
    for (const item of sorted) {
      const old = previous.items.find(old => old.id === item.id);
      if (item.status !== 'completed') continue;
      const inputs = (item.dependsOn ?? []).map(id => ({ id, generation: itemGeneration(snapshot, id) }));
      const priorInputs = previous.acceptedDependencies && Object.hasOwn(previous.acceptedDependencies, item.id)
        ? previous.acceptedDependencies[item.id] : (old?.dependsOn ?? []).map(id => ({ id, generation: itemGeneration(previous, id) }));
      const blocked = inputs.some(input => byId.get(input.id)?.status !== 'completed');
      const stale = old?.status === 'completed' && (blocked || JSON.stringify(inputs) !== JSON.stringify(priorInputs));
      if (stale) {
        if (explicitCompletion.has(item.id)) throw new KodoError('TODO_DEPENDENCY_CHANGED', `task ${item.id} has changed prerequisite versions; reopen and verify against the current inputs before acceptance`);
        item.status = 'pending'; snapshot.generations![item.id] = revision; delete accepted[item.id]; invalidated.push(item.id); continue;
      }
      if (blocked) throw new KodoError('TODO_DEPENDENCY', `task ${item.id} cannot complete before its dependencies are accepted`);
      if (item.executor === 'agent') {
        const runs = dispatchedRuns(store, run.id, item.id, itemGeneration(snapshot, item.id));
        if (!runs.some(child => child.status === 'completed') || runs.some(child => childIsActive(store, child))) throw new KodoError('TODO_ACCEPTANCE', `task ${item.id} needs a completed child and all linked child runs settled before acceptance`);
        if (!runs.some(child => child.status === 'completed' && todoDependenciesCurrent(store, child, snapshot))) throw new KodoError('TODO_DEPENDENCY_CHANGED', `task ${item.id} needs a completed run verified against the current accepted dependency versions`);
      }
      accepted[item.id] = inputs;
    }
    const cancellations = queuedCancellations(store, current, args, changed, options), cancelling = new Set(cancellations.map(child => child.id));
    for (const old of previous.items.filter(item => changed.has(item.id))) {
      const active = dispatchedRuns(store, run.id, old.id, itemGeneration(previous, old.id)).filter(child => childIsActive(store, child) && !cancelling.has(child.id));
      if (active.length) throw new KodoError('TODO_ACTIVE', `task ${old.id} has unsettled runs: ${active.map(child => child.id).join(', ')}. Use cancelQueued for never-started queued runs, or cancel_agent and wait for settlement before changing/removing this assignment. Display title/note can be updated now.`);
    }
    signal.throwIfAborted();
    markEffectStarted();
    const changedIds = items.filter(item => JSON.stringify(item) !== JSON.stringify(previous.items.find(old => old.id === item.id))).map(item => item.id);
    const result = updateResult(snapshot, changedIds, previous.items.filter(item => !byId.has(item.id)).map(item => item.id), invalidated);
    store.event(run.id, 'todo.updated', { snapshot, result, argsDigest: digest(JSON.stringify(args)), changedIds, invalidated, cancelledQueued: cancellations.map(child => child.id) });
    // Validation is complete. Truly unstarted cancellations take the existing synchronous stop path.
    for (const child of cancellations) options.cancelQueued!(child.id, run.id);
    refreshTodoDependencies(store, run.id);
    return result;
  });
}
