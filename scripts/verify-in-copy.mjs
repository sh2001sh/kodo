import { cp, lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import console from 'node:console';

// Kodo source/test validation only. Commands are trusted; this is not an OS sandbox.
const [separator, program, ...args] = process.argv.slice(2);
if (separator !== '--' || !program) throw new Error('Usage: node scripts/verify-in-copy.mjs -- PROGRAM [ARG ...]');
const source = await realpath(process.cwd());
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kodo-validation-'));
if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('kodo-validation-')) throw new Error('Invalid validation cleanup target');
const workspace = path.join(temporary, 'workspace');
try {
  await mkdir(workspace);
  for (const name of ['src', 'tests', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'eslint.config.mjs', 'vitest.config.mjs']) {
    const from = path.join(source, name);
    try { await lstat(from); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await cp(from, path.join(workspace, name), { recursive: true, filter: async entry => {
      if ((await lstat(entry)).isSymbolicLink()) throw new Error('Source symlinks require a dedicated validation fixture; refusing an incomplete copy');
      return true;
    } });
  }
  // Dependencies are shared and must be treated as read-only by the trusted command.
  try {
    const dependencies = await realpath(path.join(source, 'node_modules'));
    await symlink(dependencies, path.join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.error(JSON.stringify({ type: 'validation.copy', workspace, sourceCopied: true }));
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: workspace, shell: false, windowsHide: true, stdio: 'inherit',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
} finally {
  // No restore/write-back into source, including failure and cancellation paths.
  await rm(temporary, { recursive: true, force: true });
}
