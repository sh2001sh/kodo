import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../storage/index.js';
import { KodoError, terminal } from './types.js';
import type { Run, Session } from './types.js';
import { assertFileScope } from './scope.js';
import { managedChild } from '../messaging/agent-lifecycle.js';

/** A run-owned checkout changes tool roots, never session permissions. */
export function runWorkspace(store: Store, run: Run | string): string {
  const current = typeof run === 'string' ? store.run(run) : run;
  return current.execution?.root ?? store.session(current.sessionId).workspace;
}

export function executionSession(store: Store, run: Run): Session {
  const session = store.session(run.sessionId);
  return run.execution ? { ...session, workspace: runWorkspace(store, run) } : session;
}

/** A resumed task may retain its interrupted predecessor's checkout after that turn has stopped. */
function retiredTaskTurn(store: Store, child: Run, peer: Run): boolean {
  if (peer.status !== 'interrupted' || !peer.taskNode || !child.taskNode || peer.taskNode.nodeId !== child.taskNode.nodeId || peer.taskNode.generation !== child.taskNode.generation) return false;
  const seen = new Set([child.id]);
  let current = child;
  while (current.continuationOf && !seen.has(current.continuationOf)) {
    const previous = store.run(current.continuationOf);
    if (previous.sessionId !== child.sessionId || previous.taskNode?.nodeId !== child.taskNode.nodeId || previous.taskNode.generation !== child.taskNode.generation || previous.execution?.root !== child.execution?.root) return false;
    if (previous.id === peer.id) return true;
    seen.add(previous.id);
    current = previous;
  }
  return false;
}

/** Managed Git; `extraEnv` is applied after inherited GIT_* variables are stripped. */
export function git(cwd: string, args: string[], input?: string, extraEnv: Record<string, string> = {}): string {
  // Managed Git must not inherit a different repository or execute host hooks.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ATTR_NOSYSTEM: '1' }, extraEnv);
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], { cwd, input, env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new KodoError('EXECUTION_GIT', `git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim().slice(0, 1000)}`);
  return result.stdout;
}

export const protectedPart = /^(?:\.git|\.kodo|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/iu;

export const protectedPath = (file: string): boolean => file.split('/').some(part => protectedPart.test(part));

/** Staged, modified, deleted and unignored new paths in a checkout. */
export function changedExecutionFiles(root: string): string[] {
  return [...new Set([
    ...git(root, ['diff', '--name-only', '--cached', '-z', '--']).split('\0'),
    ...git(root, ['ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
}

/** Why a changed path cannot be committed, or undefined when it can. Check order matches the original commit. */
export function executionFileViolation(scope: Run['scope'], root: string, file: string): KodoError | undefined {
  if (protectedPath(file)) return new KodoError('PATH_DENIED', 'delivery modifies a protected path');
  const absolute = path.resolve(root, file);
  try { assertFileScope(scope, 'write', root, absolute); }
  catch (error) { if (error instanceof KodoError) return error; throw error; }
  try { const stat = lstatSync(absolute); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return new KodoError('EXECUTION_FILE', 'commit supports regular files only'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return undefined;
}

/** Host-owned Git snapshot for sandboxed workers whose command view hides .git. */
export function commitExecutionWorkspace(store: Store, run: Run, message: string, markStarted: () => void): { commit: string; files: string[]; baseCommit: string } {
  if (!run.parentId || !run.execution) throw new KodoError('EXECUTION_OWNER', 'workspace.commit belongs to an isolated child');
  const root = runWorkspace(store, run);
  const files = changedExecutionFiles(root);
  for (const file of files) {
    const violation = executionFileViolation(run.scope, root, file);
    if (violation) throw violation;
  }
  if (files.length) {
    markStarted();
    git(root, ['add', '--', ...files]);
    git(root, ['-c', 'user.name=Kodo', '-c', 'user.email=kodo@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
  }
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  store.event(run.id, 'execution.committed', { commit, files, baseCommit: run.execution.baseCommit });
  return { commit, files, baseCommit: run.execution.baseCommit };
}

/** Each clone owns its Git metadata. A clone is not an OS sandbox. */
export function createExecutionWorkspace(store: Store, parent: Run, childId: string): NonNullable<Run['execution']> {
  if (!/^[a-zA-Z0-9-]+$/u.test(childId)) throw new KodoError('EXECUTION_ROOT', 'invalid generated child identity');
  const sourceRoot = realpathSync(runWorkspace(store, parent));
  const top = realpathSync(git(sourceRoot, ['rev-parse', '--show-toplevel']).trim());
  if (top !== sourceRoot) throw new KodoError('EXECUTION_ROOT', 'isolated execution requires the workspace to be the repository root');
  if (git(sourceRoot, ['status', '--porcelain', '--untracked-files=no']).trim()) throw new KodoError('EXECUTION_DIRTY', 'commit tracked changes before starting an isolated task, or use shared execution; isolated tasks use the committed baseline');
  const baseCommit = git(sourceRoot, ['rev-parse', 'HEAD']).trim();
  const session = store.session(parent.sessionId);
  const root = path.join(path.dirname(sourceRoot), '.kodo-executions', session.id, childId);
  if (existsSync(root)) throw new KodoError('EXECUTION_EXISTS', 'the generated execution directory already exists');
  mkdirSync(path.dirname(root), { recursive: true });
  const execution: NonNullable<Run['execution']> = { kind: 'clone', root, sourceRoot, baseCommit };
  try {
    git(sourceRoot, ['clone', '--no-local', '--no-hardlinks', '--no-checkout', '--', sourceRoot, root]);
    git(root, ['checkout', '--detach', baseCommit]);
    // A local source is an implementation detail, not an automatic push destination.
    git(root, ['remote', 'remove', 'origin']);
    return execution;
  } catch (error) {
    discardExecutionWorkspace(execution);
    throw error;
  }
}

/** Only an uncommitted spawn may discard its newly allocated directory. */
export function discardExecutionWorkspace(execution: NonNullable<Run['execution']>): void {
  assertManagedExecutionRoot(execution);
  rmSync(execution.root, { recursive: true, force: true });
}

/** A managed checkout is exactly `<source parent>/.kodo-executions/<session>/<name>`. */
export function assertManagedExecutionRoot(execution: Pick<NonNullable<Run['execution']>, 'root' | 'sourceRoot'>): void {
  const container = path.resolve(path.dirname(execution.sourceRoot), '.kodo-executions');
  const relative = path.relative(container, execution.root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).length !== 2) throw new KodoError('EXECUTION_ROOT', 'refusing to remove an unmanaged execution directory');
}

export interface ExecutionDelivery {
  runId: string; baseCommit: string; commit: string; sourceRoot: string; root: string;
  files: string[]; diff: string; untracked: string[];
}

/** Inspect a committed delivery. Parent acceptance remains a separate decision. */
export function executionDelivery(store: Store, requester: Run, childId: string): ExecutionDelivery {
  const child = store.run(childId);
  if (!managedChild(store, requester, child) || !child.execution) throw new KodoError('EXECUTION_OWNER', 'select an isolated child managed by this main run');
  const permissions = store.session(requester.sessionId).permissions;
  if (!permissions.includes('read') || !(requester.permissions ?? permissions).includes('read')) throw new KodoError('EXECUTION_PERMISSION', 'read permission is required to inspect and integrate a delivery');
  if (!terminal(child.status) || store.calls(child.id).some(call => ['planned', 'running', 'unknown'].includes(call.status))) throw new KodoError('EXECUTION_ACTIVE', 'settle the child and its effects before inspecting its delivery');
  const { root, sourceRoot, baseCommit } = child.execution;
  if (store.listRuns(child.sessionId).some(peer => peer.id !== child.id && peer.execution?.root === root && ((!terminal(peer.status) && !retiredTaskTurn(store, child, peer)) || store.calls(peer.id).some(call => ['planned', 'running', 'unknown'].includes(call.status))))) throw new KodoError('EXECUTION_ACTIVE', 'a continuation still owns this checkout; wait for its delivery');
  if (realpathSync(sourceRoot) !== realpathSync(runWorkspace(store, requester))) throw new KodoError('EXECUTION_BASE', 'the child delivery belongs to a different execution root');
  if (git(root, ['status', '--porcelain', '--untracked-files=no']).trim()) throw new KodoError('EXECUTION_DIRTY', 'the child must commit tracked changes before delivery');
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['merge-base', '--is-ancestor', baseCommit, commit]);
  const files = git(root, ['diff', '--name-only', '-z', baseCommit, commit, '--']).split('\0').filter(Boolean);
  for (const file of files) {
    if (protectedPath(file)) throw new KodoError('PATH_DENIED', 'delivery modifies a protected path');
    assertFileScope(child.scope, 'write', root, path.resolve(root, file));
    assertFileScope(requester.scope, 'write', sourceRoot, path.resolve(sourceRoot, file));
    assertFileScope(requester.scope, 'read', sourceRoot, path.resolve(sourceRoot, file));
    for (const ref of [baseCommit, commit]) {
      const entry = git(root, ['ls-tree', ref, '--', file]).trim();
      if (entry && !/^100(?:644|755) blob /u.test(entry)) throw new KodoError('EXECUTION_FILE', 'integration supports regular file changes only');
    }
  }
  return { runId: child.id, root, sourceRoot, baseCommit, commit, files,
    diff: git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', baseCommit, commit, '--']),
    untracked: git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean) };
}

/** Caller holds the destination write lock. A conflict leaves the existing tree intact. */
export function applyExecutionDelivery(delivery: ExecutionDelivery, markStarted: () => void = () => {}): void {
  if (!delivery.diff) return;
  git(delivery.sourceRoot, ['apply', '--check', '--index', '--binary', '-'], delivery.diff);
  markStarted();
  git(delivery.sourceRoot, ['apply', '--index', '--binary', '-'], delivery.diff);
}
