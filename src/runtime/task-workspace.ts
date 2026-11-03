import { realpathSync } from 'node:fs';
import type { Store } from '../storage/index.js';
import { git } from './execution-workspace.js';
import { readTaskGraph } from './task-graph.js';
import type { TaskNode } from './task-graph.js';
import { writeScopesOverlap } from './scope.js';
import { KodoError } from './types.js';

/** How child tasks reach the workspace (6.7): snapshot checkouts, or the shared workspace when snapshots are unavailable. */
export type TaskWorkspaceMode = 'snapshot' | 'shared';
export const taskWorkspaceEvent = 'task.workspace_mode';

export const sharedWorkspaceNote = 'Shared workspace mode: the workspace is not a Git repository root, so child tasks edit it directly instead of snapshot checkouts and no integration step runs. Every writing task needs scope. Tasks with overlapping scopes run one at a time, and your own writes into an active task\'s scope are refused until it finishes. Reviewers read without commands.';

/** Whether `workspace` is the top level of a Git work tree; any Git or path failure means it is not. */
export function repositoryRoot(workspace: string): boolean {
  try { return realpathSync(git(workspace, ['rev-parse', '--show-toplevel']).trim()) === realpathSync(workspace); }
  catch (error) {
    if (error instanceof KodoError || (error instanceof Error && 'code' in error)) return false;
    throw error;
  }
}

/** The owner's recorded mode; graphs from before the mode was recorded used snapshot checkouts. */
export function taskWorkspaceMode(store: Store, ownerId: string): TaskWorkspaceMode {
  return store.latestEvent(ownerId, { types: [taskWorkspaceEvent] })?.data.mode === 'shared' ? 'shared' : 'snapshot';
}

/**
 * Records the mode on the first declaration, so later Git changes never switch an existing graph.
 * Runs one read-only `git rev-parse` inside the delegate transaction.
 */
export function freezeTaskWorkspace(store: Store, ownerId: string, workspace: string): TaskWorkspaceMode {
  if (store.hasEvent(ownerId, { types: [taskWorkspaceEvent] })) return taskWorkspaceMode(store, ownerId);
  const mode: TaskWorkspaceMode = readTaskGraph(store, ownerId).nodes.length || repositoryRoot(workspace) ? 'snapshot' : 'shared';
  store.event(ownerId, taskWorkspaceEvent, { mode });
  return mode;
}

/** Child tasks that may write: explorers never do, and shared-mode reviewers run read-only. */
export const sharedTaskWriter = (node: Pick<TaskNode, 'owner' | 'role'>): boolean => node.owner === 'agent' && node.role !== 'explorer' && node.role !== 'reviewer';

/** The active writer whose scope overlaps `node`'s, which must finish before `node` may start in the shared workspace. */
export function sharedScopeHolder(node: TaskNode, active: readonly TaskNode[]): string | undefined {
  if (!sharedTaskWriter(node)) return undefined;
  return active.find(peer => peer.id !== node.id && sharedTaskWriter(peer) && writeScopesOverlap({ write: node.scope ?? ['.'] }, { write: peer.scope ?? ['.'] }))?.id;
}
