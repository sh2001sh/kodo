import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { KodoError } from '../../runtime/types.js';
import type { PreparedSandbox, SandboxLaunchInput } from '../types.js';
import { validateSandboxNetworkAllowlist, validateSandboxResources } from '../policy.js';

const execute = promisify(execFile);

async function copyResource(source: string, destination: string, count: { value: number }): Promise<void> {
  if (++count.value > 50_000) throw new KodoError('SANDBOX_LIMIT', 'sandbox resource snapshot exceeds 50000 entries');
  const info = await lstat(source);
  if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new KodoError('SANDBOX_CONFIG', 'sandbox resources cannot contain links or special files');
  if (info.isDirectory()) {
    await mkdir(destination);
    for (const name of await readdir(source)) await copyResource(path.join(source, name), path.join(destination, name), count);
  } else await copyFile(source, destination);
}

/** Sandbox assets ship beside the source; dist builds fall back to the package's src tree. */
function trustedAsset(name: string): string {
  const local = fileURLToPath(new URL(`./${name}`, import.meta.url));
  return existsSync(local) ? local : fileURLToPath(new URL(`../../../src/sandbox/windows/${name}`, import.meta.url));
}

/** Each invocation owns a separate profile, ACL identity, job and cleanup journal. */
export async function prepareWindowsSandbox(input: SandboxLaunchInput): Promise<PreparedSandbox> {
  if (process.platform !== 'win32') throw new KodoError('SANDBOX_UNAVAILABLE', 'Windows AppContainer requires Windows 10 or newer');
  validateSandboxNetworkAllowlist(input.networkAllowlist);
  validateSandboxResources(input.resources, 'win32');
  const control = await mkdtemp(path.join(tmpdir(), 'kodo-appcontainer-'));
  const scratch = path.join(control, 'scratch');
  const runtime = path.join(control, 'runtime');
  const launcher = path.join(control, 'launcher.exe');
  const journal = path.join(control, 'journal.json');
  const config = path.join(control, 'config.json');
  const pipeDirectory = path.join(control, 'pipes');
  const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const writerState = path.join(process.env.LOCALAPPDATA ?? tmpdir(), '.kodo', 'sandbox', 'workspace-writer.json');
  // Persistent output ACLs need the same journal recovery/serialization as workspace writes.
  const persistentWrite = input.write.length > 0 || Boolean(input.outputDirectory);
  const cleanup = async () => {
    if (existsSync(journal)) {
      try { await execute(launcher, ['--cleanup', journal], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }); }
      catch (cause) { throw new KodoError('SANDBOX_CLEANUP', `Windows sandbox cleanup failed; journal retained at ${journal}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    await rm(control, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  };
  try {
    await mkdir(scratch);
    await mkdir(runtime);
    if (persistentWrite) await mkdir(path.dirname(writerState), { recursive: true });
    const trustedSource = path.join(control, 'launcher.cs');
    await writeFile(trustedSource, await readFile(trustedAsset('launcher.cs')), { flag: 'wx' });
    const brokerSource = path.join(control, 'pipe-broker.cs');
    await writeFile(brokerSource, await readFile(trustedAsset('pipe-broker.cs')), { flag: 'wx' });
    try { await execute(compiler, ['/nologo', '/nowarn:0649', '/r:System.Web.Extensions.dll', `/out:${launcher}`, trustedSource, brokerSource], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }); }
    catch (cause) { throw new KodoError('SANDBOX_UNAVAILABLE', `Windows AppContainer launcher compilation failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
    const scoped = (entry: string) => path.resolve(input.workspace, entry);
    const read = (input.read ?? ['.']).map(scoped);
    const write = [...input.write.map(scoped), scratch, ...(input.outputDirectory ? [input.outputDirectory] : [])];
    const deny = input.deny.map(scoped);
    // Windows and Program Files already grant AppContainer access to public
    // runtime components; changing their administrator-owned ACLs is unnecessary.
    const publicRuntime = [process.env.SystemRoot].filter((value): value is string => !!value);
    const publicPath = (value: string) => publicRuntime.some(root => value.toLowerCase() === root.toLowerCase() || value.toLowerCase().startsWith(root.toLowerCase() + path.sep));
    // Snapshot host resources instead of changing administrator-owned runtime
    // ACLs. Code/dependencies become read-only invocation-owned resources.
    const mappings: { original: string; snapshot: string }[] = [];
    const count = { value: 0 };
    const resourceBase = path.join(control, 'resources');
    await mkdir(resourceBase);
    for (const [index, entry] of (input.readOnlyPaths ?? []).entries()) {
      if (publicPath(entry)) throw new KodoError('SANDBOX_CONFIG', 'Windows system trees cannot be exposed as package resources');
      const snapshot = path.join(resourceBase, String(index));
      await copyResource(entry, snapshot, count);
      mappings.push({ original: entry, snapshot });
    }
    const resources = mappings.map(mapping => mapping.snapshot);
    const mapped = (value: string): string => {
      const mapping = mappings.find(item => value.toLowerCase() === item.original.toLowerCase() || value.toLowerCase().startsWith(item.original.toLowerCase() + path.sep));
      return mapping ? mapping.snapshot + value.slice(mapping.original.length) : value;
    };
    // Map the executable and adjacent native DLLs into an invocation-owned
    // runtime directory. A system installation's ACL often permits image loading
    // but denies the restricted child opening/spawning the original pathname.
    const program = path.join(runtime, path.basename(input.program));
    await copyFile(input.program, program);
    for (const entry of await readdir(path.dirname(input.program), { withFileTypes: true })) if (entry.isFile() && /\.dll$/i.test(entry.name)) await copyFile(path.join(path.dirname(input.program), entry.name), path.join(runtime, entry.name));
    read.push(runtime);
    // Windows assigns AppContainer processes TEMP/TMP under
    // %LOCALAPPDATA%\Packages\<moniker>\AC\Temp regardless of the supplied block.
    // LOCALAPPDATA is the invocation scratch, so create that directory up front.
    const profile = `Kodo.${randomUUID().replaceAll('-', '')}`;
    await mkdir(path.join(scratch, 'Packages', profile.toLowerCase(), 'AC', 'Temp'), { recursive: true });
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.env)) if (value !== undefined) env[name] = value;
    for (const name of ['KODO_RUN_OUTPUT_DIR', 'COVERAGE_FILE']) if (env[name]) env[name] = mapped(env[name]);
    Object.assign(env, { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows', USERPROFILE: scratch, HOME: scratch, LOCALAPPDATA: scratch, APPDATA: scratch, TEMP: scratch, TMP: scratch, PATH: `${runtime};${env.PATH ?? env.Path ?? ''}` });
    if (/^node(?:\.exe)?$/i.test(path.basename(input.program))) {
      // The preload keeps Node's child-process protocol and uses host-created
      // channels. Direct pipe creation remains restricted by AppContainer.
      const compat = path.join(runtime, 'kodo-node-compat.cjs');
      await writeFile(compat, await readFile(trustedAsset('node-compat.cjs')), { flag: 'wx' });
      await copyFile(trustedAsset('node-pipes.cjs'), path.join(runtime, 'node-pipes.cjs'));
      const localAddon = fileURLToPath(new URL('./node-pipes.node', import.meta.url));
      const addon = existsSync(localAddon) ? localAddon : fileURLToPath(new URL('../../../dist/sandbox/windows/node-pipes.node', import.meta.url));
      if (!existsSync(addon)) throw new KodoError('SANDBOX_UNAVAILABLE', 'Windows Node pipe adapter is missing; run npm run build on Windows with the MSVC C++ build tools installed');
      await copyFile(addon, path.join(runtime, 'node-pipes.node'));
      await mkdir(pipeDirectory);
      env.KODO_PIPE_DIRECTORY = pipeDirectory;
      // NODE_OPTIONS treats backslashes inside quotes as escapes; Windows accepts '/'.
      env.NODE_OPTIONS = `--preserve-symlinks --preserve-symlinks-main --require "${compat.replaceAll('\\', '/')}" ${env.NODE_OPTIONS ?? ''}`.trim();
    }
    await writeFile(config, JSON.stringify({ program, args: input.args.map(mapped), cwd: input.cwd, env, read: [...new Set(read)], resources, write: [...new Set(write)], deny, network: input.network, memoryBytes: input.resources?.memoryBytes ?? 0, maxProcesses: input.resources?.maxProcesses ?? 0, profile, journal, workspaceWrite: persistentWrite, writerState, ...(env.KODO_PIPE_DIRECTORY ? { pipeDirectory } : {}) }), { flag: 'wx' });
    return { program: launcher, args: [config], cwd: input.cwd, env: input.env, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
