import type { Store } from '../storage/index.js';
import { digest } from '../storage/index.js';
import type { Run } from './types.js';
import { terminal } from './types.js';
import { itemGeneration, parallelTasks, readTodoSnapshot } from '../tools/todo.js';
import type { TodoSnapshot } from '../tools/todo.js';
import { writeScopesOverlap } from './scope.js';

const started = (store: Store, run: Run): boolean => run.step > 0 || store.calls(run.id).some(call => call.kind === 'model') || store.hasEvent(run.id, { types: ['execution.prepared'] });

/** Whether an already-started task used the currently accepted prerequisite versions. */
export function todoDependenciesCurrent(store: Store, run: Run, snapshot?: TodoSnapshot): boolean {
  if (!run.todo || !run.parentId) return true;
  const plan = snapshot ?? readTodoSnapshot(store, run.parentId);
  return run.todo.dependencies.every(dependency => plan.items.some(item => item.id === dependency.id && item.status === 'completed') && itemGeneration(plan, dependency.id) === dependency.generation);
}

export function todoDependenciesSatisfied(store: Store, parentId: string, assignment: Run['todo']): boolean {
  if (!assignment) return true;
  const plan = readTodoSnapshot(store, parentId);
  const item = plan.items.find(item => item.id === assignment.id);
  return Boolean(item && itemGeneration(plan, item.id) === assignment.generation && (item.dependsOn ?? []).every(id => plan.items.some(dependency => dependency.id === id && dependency.status === 'completed')));
}

/** Coordinator admission: queued dependencies consume no model slot or filesystem lock. */
export function todoRunReady(store: Store, run: Run): boolean {
  if (!run.parentId || !run.todo || !parallelTasks(store, run.id)) return true;
  // A run also returns to queued between model steps: its accepted inputs stay frozen.
  if (started(store, run)) return true;
  if (!todoDependenciesSatisfied(store, run.parentId, run.todo)) {
    notifyBlocked(store, run);
    return false;
  }
  const session = store.session(run.sessionId);
  if (!run.execution && !run.executionPending && (run.permissions ?? session.permissions).includes('write') && run.scope?.write?.length !== 0) {
    const holder = store.listRuns(run.sessionId).some(peer => peer.id !== run.id && peer.parentId === run.parentId && !peer.execution && !peer.executionPending && !terminal(peer.status)
      && (peer.status !== 'queued' || ((peer.createdAt < run.createdAt || (peer.createdAt === run.createdAt && peer.id < run.id)) && todoDependenciesSatisfied(store, peer.parentId!, peer.todo)))
      && (peer.permissions ?? session.permissions).includes('write') && peer.scope?.write?.length !== 0 && writeScopesOverlap(peer.scope, run.scope));
    if (holder) return false;
  }
  const snapshot = readTodoSnapshot(store, run.parentId);
  const item = snapshot.items.find(item => item.id === run.todo!.id)!;
  const dependencies = (item.dependsOn ?? []).map(id => ({ id, generation: itemGeneration(snapshot, id) }));
  if (!run.todo.ready || JSON.stringify(run.todo.dependencies) !== JSON.stringify(dependencies)) {
    store.updateRun(run.id, { todo: { ...run.todo, dependencies, ready: true } });
    store.event(run.id, 'todo.dependencies.ready', { todoId: item.id, generation: run.todo.generation, dependencies });
    if (dependencies.length) store.putMessage({ id: `todo-ready:${run.id}:${snapshot.revision}`, sessionId: run.sessionId, from: 'runtime', to: run.id, kind: 'event', content: JSON.stringify({ reason: 'dependencies_accepted', taskId: item.id, dependencies, note: 'Prerequisites are now accepted. Read the current assigned files and supplied artifacts before acting; task acceptance does not grant additional permissions.' }) });
  }
  return true;
}

/** A changed prerequisite never silently retargets work that has already started. */
export function refreshTodoDependencies(store: Store, parentId: string): void {
  for (const run of store.listRuns(store.run(parentId).sessionId)) {
    if (run.parentId !== parentId || !run.todo || !started(store, run) || terminal(run.status) || todoDependenciesCurrent(store, run)) continue;
    const plan = readTodoSnapshot(store, parentId), revision = plan.revision;
    const identity = store.session(run.sessionId).taskProtocol === 3
      ? digest(JSON.stringify(run.todo.dependencies.map(dependency => ({ ...dependency, currentGeneration: plan.items.some(item => item.id === dependency.id) ? itemGeneration(plan, dependency.id) : null, status: plan.items.find(item => item.id === dependency.id)?.status ?? 'missing' }))))
      : revision;
    const id = `todo-dependency:${run.id}:${identity}`;
    if (store.message(id)) continue;
    store.putMessage({ id, sessionId: run.sessionId, from: 'runtime', to: parentId, kind: 'event', content: JSON.stringify({ reason: 'dependency_changed', runId: run.id, todoId: run.todo.id, acceptedDependencies: run.todo.dependencies, note: 'This running task retains its original inputs. Decide whether to stop it or rerun verification against the new prerequisite version before acceptance.' }) });
    store.event(run.id, 'todo.dependencies.changed', { todoId: run.todo.id, revision, dependencies: run.todo.dependencies });
  }
}

function notifyBlocked(store: Store, run: Run): void {
  const parent = store.run(run.parentId!);
  const snapshot = readTodoSnapshot(store, parent.id);
  const dependencies = snapshot.items.find(item => item.id === run.todo!.id)?.dependsOn ?? [];
  const blocked = dependencies.filter(id => !snapshot.items.some(item => item.id === id && item.status === 'completed'));
  const failed = blocked.filter(id => {
    const generation = itemGeneration(snapshot, id);
    const children = store.events(parent.id, { types: ['todo.dispatched'], match: { todoId: id, generation } }).map(event => store.run(event.data.childRunId as string));
    return children.length > 0 && children.every(child => terminal(child.status));
  });
  const needsParent = blocked.some(id => {
    const item = snapshot.items.find(item => item.id === id);
    if (!item || item.executor !== 'agent') return true;
    const generation = itemGeneration(snapshot, id);
    const children = store.events(parent.id, { types: ['todo.dispatched'], match: { todoId: id, generation } }).map(event => store.run(event.data.childRunId as string));
    return children.length === 0 || children.every(child => terminal(child.status));
  });
  const wait = parent.waitId ? store.wait(parent.waitId) : undefined;
  const waitingForBlocked = wait?.status === 'registered' && wait.runIds.includes(run.id);
  if (!failed.length && !(waitingForBlocked && needsParent)) return;
  const identity = store.session(run.sessionId).taskProtocol === 3
    ? digest(JSON.stringify(blocked.map(id => ({ id, generation: itemGeneration(snapshot, id), failed: failed.includes(id) }))))
    : `${snapshot.revision}:${failed.join(',')}`;
  const id = `todo-blocked:${run.id}:${identity}:${wait?.id ?? ''}`;
  if (store.message(id)) return;
  store.putMessage({ id, sessionId: run.sessionId, from: 'runtime', to: parent.id, kind: 'event', content: JSON.stringify({ reason: 'dependency_blocked', runId: run.id, todoId: run.todo!.id, dependencies: blocked, settledPrerequisites: failed, note: 'This task cannot start before prerequisite acceptance. Resolve failed/cancelled work or explicitly accept completed prerequisites; waiting only for this successor cannot advance it.' }) });
  store.event(run.id, 'todo.dependencies.blocked', { todoId: run.todo!.id, dependencies: blocked, revision: snapshot.revision });
}
