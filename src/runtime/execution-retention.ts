import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { KodoError } from './types.js';
import type { Run } from './types.js';
import { assertManagedExecutionRoot, git } from './execution-workspace.js';

/** One cleanup step that did not succeed; callers record it as `execution.cleanup_failed`. */
export interface CleanupFailure { target: string; code: string; message: string }
export interface CleanupResult { removed: string[]; failures: CleanupFailure[] }

const identifier = /^[a-zA-Z0-9-]+$/u;
const snapshotRefPattern = /^refs\/kodo\/snapshots\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+-\d+$/u;

function attempt(result: CleanupResult, target: string, action: () => void): void {
  try { action(); result.removed.push(target); }
  catch (error) {
    const code = error instanceof KodoError ? error.code : (error as NodeJS.ErrnoException).code ?? 'EXECUTION_CLEANUP';
    result.failures.push({ target, code, message: error instanceof Error ? error.message : String(error) });
  }
}

function deleteRef(sourceRoot: string, ref: string): void {
  if (!snapshotRefPattern.test(ref)) throw new KodoError('EXECUTION_REF', 'refusing to delete a ref outside refs/kodo/snapshots');
  git(sourceRoot, ['update-ref', '-d', ref]);
}

function removeCheckout(execution: Pick<NonNullable<Run['execution']>, 'root' | 'sourceRoot'>): void {
  assertManagedExecutionRoot(execution);
  rmSync(execution.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/**
 * Release one checkout and its snapshot ref (`task release`, replaced `redo` checkouts, dropped and reviewer
 * checkouts). Failures are returned, never thrown. Caller holds the workspace write lock.
 */
export function releaseExecutionCheckout(execution: Pick<NonNullable<Run['execution']>, 'root' | 'sourceRoot'>, ref?: string): CleanupResult {
  const result: CleanupResult = { removed: [], failures: [] };
  attempt(result, execution.root, () => removeCheckout(execution));
  if (ref) attempt(result, ref, () => deleteRef(execution.sourceRoot, ref));
  return result;
}

/**
 * Session end: delete every ref under `refs/kodo/snapshots/<session>/` and every checkout under
 * `<source parent>/.kodo-executions/<session>/`. Failures are returned, never thrown. Caller holds the workspace write lock.
 */
export function cleanupSessionExecutions(sourceRoot: string, sessionId: string): CleanupResult {
  const result: CleanupResult = { removed: [], failures: [] };
  if (!identifier.test(sessionId)) {
    result.failures.push({ target: sessionId, code: 'EXECUTION_ROOT', message: 'invalid session identity' });
    return result;
  }
  // A missing workspace has no refs left, but its checkouts can still be removed.
  const present = existsSync(sourceRoot);
  const source = present ? realpathSync(sourceRoot) : path.resolve(sourceRoot);
  if (present) {
    try {
      const refs = git(source, ['for-each-ref', '--format=%(refname)', `refs/kodo/snapshots/${sessionId}/`]).split('\n').filter(Boolean);
      for (const ref of refs) attempt(result, ref, () => deleteRef(source, ref));
    } catch (error) {
      result.failures.push({ target: `refs/kodo/snapshots/${sessionId}/`, code: error instanceof KodoError ? error.code : 'EXECUTION_CLEANUP', message: error instanceof Error ? error.message : String(error) });
    }
  }
  const container = path.join(path.dirname(source), '.kodo-executions', sessionId);
  if (!existsSync(container)) return result;
  for (const entry of readdirSync(container)) attempt(result, path.join(container, entry), () => removeCheckout({ root: path.join(container, entry), sourceRoot: source }));
  if (!result.failures.length) attempt(result, container, () => rmSync(container, { recursive: true, force: true }));
  return result;
}
