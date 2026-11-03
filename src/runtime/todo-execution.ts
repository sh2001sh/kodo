import { parallelTasks, readTodoSnapshot } from '../tools/todo.js';
import type { Store } from '../storage/index.js';
import type { Run } from './types.js';
import { KodoError } from './types.js';
import path from 'node:path';
import { actualPath } from './scope.js';
import { childIsActive } from '../messaging/spawn-spec.js';
import { todoDependenciesSatisfied } from './todo-dependencies.js';

/** Ownership is a scheduling constraint, separate from tool permissions. */
export function todoExecutionFeedback(store: Store, run: Run, name: string, effect: 'read' | 'write', effectRoots?: string[]): string | undefined {
  if (run.parentId || name === 'artifact.write' || name.startsWith('todo.')) return;
  const execution = effect === 'write' || ['process.exec', 'process.run', 'shell.exec'].includes(name);
  if (!execution) return;
  const items = readTodoSnapshot(store, run.id).items;
  if (parallelTasks(store, run.id)) {
    if (effect === 'read') return;
    const active = items.filter(item => item.status === 'in_progress' && item.executor === 'main');
    if (items.some(item => item.status !== 'completed') && !active.length) return 'TODO_PLAN_REQUIRED: select an independent main-owned task before writing; other agent tasks may remain in_progress.';
    if (active.length && active.every(item => (item.dependsOn ?? []).some(id => !items.some(dependency => dependency.id === id && dependency.status === 'completed')))) return 'TODO_DEPENDENCY: main tasks are waiting for prerequisite acceptance; work on a ready independent task or wait.';
    const session = store.session(run.sessionId);
    const roots = effectRoots ?? [session.workspace];
    const overlaps = (left: string, right: string): boolean => {
      const relative = path.relative(actualPath(left), actualPath(right));
      return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    };
    const holder = store.listRuns(run.sessionId).find(child => child.parentId === run.id && !child.execution && !child.executionPending && childIsActive(store, child)
      && (child.permissions ?? session.permissions).includes('write') && child.scope?.write?.length !== 0
      && (child.status !== 'queued' || todoDependenciesSatisfied(store, run.id, child.todo))
      && roots.some(target => (child.scope?.write ?? ['.']).some(root => overlaps(path.resolve(session.workspace, root), target) || overlaps(target, path.resolve(session.workspace, root)))));
    if (holder) return `TODO_DELEGATED: target overlaps active child ${holder.id}; use independent files or settle its ownership before writing.`;
    return;
  }
  const active = items.find(item => item.status === 'in_progress');
  if (active?.executor === 'agent') return `TODO_DELEGATED: task ${active.id} belongs to teammates. Dispatch with spawn_agent, followup_task or explore, inspect their evidence, then explicitly accept the task with todo.write. Main may read and coordinate; replan ownership explicitly if requirements change.`;
  // Small direct tasks need no list; ownership must be explicit only while a recorded plan has open work.
  const openWork = items.some(item => item.status !== 'completed');
  if (store.session(run.sessionId).agentFactors?.B && openWork && !active?.executor) return 'TODO_PLAN_REQUIRED: the task list has open work but no in_progress task with an executor. Use todo.write to select one in_progress task with executor main or agent before execution. Use main for small bounded tasks; choose agent when delegation benefits exceed handoff and acceptance costs.';
}

export function assertTodoExecution(store: Store, run: Run, name: string, effect: 'read' | 'write', effectRoots?: string[]): void {
  const feedback = todoExecutionFeedback(store, run, name, effect, effectRoots);
  if (feedback) throw new KodoError(feedback.slice(0, feedback.indexOf(':')), feedback.slice(feedback.indexOf(':') + 2));
}
