import { mkdir, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../tools/index.js';
import { assertManagedExecutionRoot } from './execution-workspace.js';
import { captureExecutionSnapshot } from './execution-snapshot.js';
import type { ExecutionSnapshot, SnapshotOptions, SnapshotTarget } from './execution-snapshot.js';
import { KodoError } from './types.js';

/** Host-owned local Git operations use the same bounded process-tree lifecycle as native commands. */
async function gitAsync(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).filter(name => name.startsWith('GIT_')).map(name => [name, undefined]));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const controller = new AbortController();
  let onSettled!: () => void;
  const settled = new Promise<void>(resolve => { onSettled = resolve; });
  const timer = setTimeout(() => controller.abort(new KodoError('EXECUTION_GIT', 'checkout Git command timed out')), 30_000);
  try {
    const result = await runProcess('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', ...args], cwd, '', signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, { env, onSettled });
    signal?.throwIfAborted();
    controller.signal.throwIfAborted();
    if (result.exitCode !== 0 || result.signal || result.cancelled || result.outputLimitExceeded) throw new KodoError('EXECUTION_GIT', `git ${args[0]} failed: ${result.stderr.trim().slice(0, 1000)}`);
    return result.stdout;
  } catch (error) {
    // Keep the checkout lock and dispatch reservation until process cleanup really settles.
    // A cleanup deadline is not evidence that Git has stopped writing the checkout.
    if (error instanceof KodoError && error.code === 'PROCESS_STOP') await settled;
    throw error;
  } finally { clearTimeout(timer); }
}

/** The source snapshot ref stays pinned until the dispatch or session releases its checkout. */
export async function prepareSnapshotCheckout(snapshot: ExecutionSnapshot, signal?: AbortSignal): Promise<void> {
  const { execution, record } = snapshot;
  const { root, sourceRoot, baseCommit } = execution;
  assertManagedExecutionRoot(execution);
  signal?.throwIfAborted();
  if (existsSync(root)) {
    let reusable = false;
    try {
      reusable = realpathSync((await gitAsync(root, ['rev-parse', '--show-toplevel'], signal)).trim()) === realpathSync(root)
        && (await gitAsync(root, ['rev-parse', 'HEAD'], signal)).trim() === baseCommit
        && !(await gitAsync(root, ['remote'], signal)).trim();
    } catch (error) { signal?.throwIfAborted(); if (!(error instanceof KodoError) || error.code !== 'EXECUTION_GIT') throw error; }
    if (reusable) { record.reused.checkout = true; return; }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
  await mkdir(path.dirname(root), { recursive: true });
  try {
    await gitAsync(sourceRoot, ['clone', '--no-local', '--no-hardlinks', '--no-checkout', '--', sourceRoot, root], signal);
    await gitAsync(root, ['fetch', '--no-tags', '--', sourceRoot, `+${record.ref}:refs/kodo/base`], signal);
    if ((await gitAsync(root, ['rev-parse', 'refs/kodo/base'], signal)).trim() !== baseCommit) throw new KodoError('EXECUTION_SNAPSHOT_CHANGED', 'the pinned snapshot ref changed during checkout preparation');
    await gitAsync(root, ['-c', 'core.symlinks=true', 'checkout', '--detach', 'refs/kodo/base'], signal);
    await gitAsync(root, ['remote', 'remove', 'origin'], signal);
  } catch (error) {
    // A process cleanup failure must not race deletion against a surviving process.
    if (!(error instanceof KodoError) || error.code !== 'PROCESS_STOP') await rm(root, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

/** Convenience entry for callers that own the source while capturing it. */
export async function takeExecutionSnapshot(target: SnapshotTarget, options: SnapshotOptions = {}): Promise<ExecutionSnapshot> {
  const snapshot = captureExecutionSnapshot(target, options);
  await prepareSnapshotCheckout(snapshot);
  return snapshot;
}
