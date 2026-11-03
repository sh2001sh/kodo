import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../storage/index.js';
import { KodoError } from './types.js';
import type { Run, Session } from './types.js';
import { assertFileScope } from './scope.js';

/** The session workspace; kept as the seam between run identity and tool roots. */
export function runWorkspace(store: Store, run: Run | string): string {
  const current = typeof run === 'string' ? store.run(run) : run;
  return store.session(current.sessionId).workspace;
}

/** Children share the session workspace; the function name keeps the run-to-workspace seam explicit. */
export function executionSession(store: Store, run: Run): Session {
  return store.session(run.sessionId);
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

/** Staged, modified, deleted and unignored new paths in the workspace. */
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
