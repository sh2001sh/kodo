import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Store } from '../storage/index.js';
import { KodoError } from './types.js';

/** Temporary run output survives commands/restarts, until the host clears its temp directory. */
export function runOutputDirectory(store: Pick<Store, 'directory'>, runId: string): string {
  if (!/^[a-z0-9_-]{1,200}$/iu.test(runId)) throw new KodoError('RUN_OUTPUT', 'invalid run output identity');
  const owner = createHash('sha256').update(path.resolve(store.directory)).digest('hex');
  return path.join(realpathSync(os.tmpdir()), 'kodo-run-output', owner, runId);
}

/** Host-only setup: never expose the runtime store or broaden workspace file scope. */
export async function prepareRunOutput(store: Pick<Store, 'directory'>, runId: string, extra: NodeJS.ProcessEnv = {}): Promise<{ directory: string; env: NodeJS.ProcessEnv }> {
  const directory = runOutputDirectory(store, runId);
  const base = await realpath(os.tmpdir());
  let current = base;
  for (const part of path.relative(base, directory).split(path.sep)) {
    current = path.join(current, part);
    await mkdir(current, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    if (!(await lstat(current)).isDirectory() || await realpath(current) !== current) throw new KodoError('RUN_OUTPUT', 'run output directory must not redirect through links');
  }
  // Pytest expands cache_dir variables after parsing PYTEST_ADDOPTS, so spaces
  // and sandbox-remapped output paths remain intact. Later explicit options win.
  const pytestOptions = extra.PYTEST_ADDOPTS ?? process.env.PYTEST_ADDOPTS ?? '';
  return { directory: current, env: { COVERAGE_FILE: process.env.COVERAGE_FILE ?? path.join(current, '.coverage'), ...extra,
    PYTEST_ADDOPTS: `-o cache_dir=$KODO_RUN_OUTPUT_DIR/.pytest_cache${pytestOptions ? ` ${pytestOptions}` : ''}`,
    KODO_RUN_OUTPUT_DIR: current } };
}
