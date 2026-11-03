import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { KodoError } from '../runtime/types.js';

const execute = promisify(execFile);
let launcher: Promise<string> | undefined;

/** Cache the host-owned launcher by source content; never compile on each tool call. */
async function compileLauncher(): Promise<string> {
  const local = fileURLToPath(new URL('./windows-process-tree.cs', import.meta.url));
  const source = existsSync(local) ? local : fileURLToPath(new URL('../../src/tools/windows-process-tree.cs', import.meta.url));
  const hash = createHash('sha256').update(await readFile(source)).digest('hex');
  const cache = path.join(tmpdir(), 'kodo-process-tree');
  const target = path.join(cache, `${hash}.exe`);
  if (existsSync(target)) return target;
  await mkdir(cache, { recursive: true });
  const build = await mkdtemp(path.join(cache, 'build-'));
  try {
    const output = path.join(build, 'launcher.exe');
    const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    await execute(compiler, ['/nologo', '/nowarn:0649', `/out:${output}`, source], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    // Publish only a complete executable, including when another host compiles concurrently.
    try { await link(output, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return target;
  } finally { await rm(build, { recursive: true, force: true }); }
}

/** A Job Object owns Bash descendants even when Git/MSYS changes their parent relationships. */
export async function windowsProcessTree(program: string, args: string[]): Promise<{ program: string; args: string[] }> {
  if (process.platform !== 'win32') throw new KodoError('PROCESS_START', 'Windows process jobs require Windows');
  try {
    launcher ??= compileLauncher().catch(error => { launcher = undefined; throw error; });
    return { program: await launcher, args: [program, ...args] };
  } catch (error) {
    throw new KodoError('PROCESS_START', `Windows process-tree launcher is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
