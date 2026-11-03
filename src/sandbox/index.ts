import { access, lstat, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { KodoError } from '../runtime/types.js';
import type { FileScope } from '../runtime/types.js';
import { canAccessFileScope, normalizeFileScope } from '../runtime/scope.js';
import { preparePosixSandbox } from './posix.js';
import { prepareWindowsSandbox } from './windows/index.js';
import type { PreparedSandbox, SandboxLaunchInput } from './types.js';
import { validateSandboxNetworkAllowlist, validateSandboxResources } from './policy.js';
import type { SandboxResources } from './policy.js';

export interface SandboxPolicy {
  network?: 'none' | 'allow';
  /** Rejected until an endpoint-enforcing backend is available. Never reduced to a hostname check. */
  networkAllowlist?: string[];
  resources?: SandboxResources;
}
export interface SandboxOptions extends SandboxPolicy {
  workspace: string;
  scope?: FileScope;
  write?: boolean;
  /** Trusted host resources, mounted read-only; never inferred from model arguments. */
  readOnlyPaths?: string[];
  /** Trusted run scratch directory, never inferred from model arguments. */
  outputDirectory?: string;
  /** Additional workspace-relative resources which must remain inaccessible. */
  deny?: string[];
}
const protectedName = (name: string): boolean => /^(?:\.git|\.kodo|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i.test(name);
const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Minimal inherited environment; credentials require an explicit trusted-host binding. */
export function sandboxEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG']) if (process.env[name]) env[name] = process.env[name];
  for (const [name, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || (value !== undefined && (typeof value !== 'string' || value.includes('\0')))) throw new KodoError('SANDBOX_CONFIG', 'invalid sandbox environment');
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function protectedResources(workspace: string): Promise<string[]> {
  const denied: string[] = [];
  const queue = [workspace];
  let visited = 0;
  while (queue.length) {
    const directory = queue.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 200_000) throw new KodoError('SANDBOX_LIMIT', 'workspace safety scan exceeds 200000 entries; select a narrower workspace');
      const target = path.join(directory, entry.name);
      if (protectedName(entry.name) || (process.platform === 'win32' && entry.isSymbolicLink())) denied.push(path.relative(workspace, target));
      else if (entry.isDirectory()) queue.push(target);
      else if (!entry.isSymbolicLink() && (!entry.isFile() || (await lstat(target)).nlink > 1)) denied.push(path.relative(workspace, target));
    }
  }
  return denied;
}

async function executablePath(program: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const explicit = path.isAbsolute(program) || program.includes('/') || program.includes('\\');
  const search = explicit ? [path.resolve(cwd, program)] : (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean).map(root => path.join(root.replace(/^"|"$/g, ''), program));
  for (const base of search) for (const candidate of process.platform === 'win32' && !path.extname(base) ? [base, `${base}.exe`, `${base}.com`] : [base]) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  throw new KodoError('SANDBOX_CONFIG', 'sandbox executable must resolve to an existing native executable');
}

/** Prepare real OS isolation. No backend or policy failure ever falls back to an ordinary process. */
export async function prepareSandboxCommand(program: string, args: string[], options: SandboxOptions & { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<PreparedSandbox> {
  if (!options || typeof options !== 'object' || !['none', 'allow'].includes(options.network ?? 'none') || (options.write !== undefined && typeof options.write !== 'boolean')) throw new KodoError('SANDBOX_CONFIG', 'invalid sandbox policy');
  validateSandboxNetworkAllowlist(options.networkAllowlist);
  validateSandboxResources(options.resources);
  if (typeof options.workspace !== 'string' || !options.workspace || (options.deny !== undefined && !Array.isArray(options.deny)) || (options.readOnlyPaths !== undefined && (!Array.isArray(options.readOnlyPaths) || options.readOnlyPaths.some(value => typeof value !== 'string' || !value)))) throw new KodoError('SANDBOX_CONFIG', 'invalid sandbox resource paths');
  if (typeof program !== 'string' || !program || program.includes('\0') || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new KodoError('SANDBOX_CONFIG', 'invalid sandbox command');
  const workspace = await realpath(options.workspace);
  if (!(await lstat(workspace)).isDirectory()) throw new KodoError('SANDBOX_CONFIG', 'sandbox workspace must be a directory');
  const cwd = await realpath(options.cwd ?? workspace);
  if (!inside(workspace, cwd)) throw new KodoError('SANDBOX_CONFIG', 'sandbox cwd must be inside its workspace');
  const scope = normalizeFileScope(options.scope ?? {});
  const env = sandboxEnvironment(options.env);
  const executable = await executablePath(program, cwd, env);
  const deny = [...new Set([...await protectedResources(workspace), ...(options.deny ?? [])])];
  for (const value of deny) {
    if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value) || value.replaceAll('\\', '/').split('/').includes('..') || !inside(workspace, path.resolve(workspace, value))) throw new KodoError('SANDBOX_CONFIG', 'sandbox deny paths must remain inside the workspace');
  }
  if (inside(workspace, executable) && (!canAccessFileScope(scope, 'read', workspace, executable) || deny.some(value => inside(path.resolve(workspace, value), executable)))) throw new KodoError('SANDBOX_CONFIG', 'sandbox executable is outside the granted read scope or inside protected storage');
  const readOnlyPaths: string[] = [];
  for (const value of options.readOnlyPaths ?? []) {
    const resolved = await realpath(value);
    if (inside(resolved, workspace)) throw new KodoError('SANDBOX_CONFIG', 'read-only host resources cannot contain the workspace');
    readOnlyPaths.push(resolved);
  }
  let outputDirectory: string | undefined;
  if (options.outputDirectory !== undefined) {
    const value = options.outputDirectory;
    if (typeof value !== 'string' || !path.isAbsolute(value) || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new KodoError('SANDBOX_CONFIG', 'run output must be an absolute directory');
    outputDirectory = await realpath(value);
    if (!(await lstat(value)).isDirectory() || path.resolve(value) !== outputDirectory || inside(workspace, outputDirectory) || inside(outputDirectory, workspace)) throw new KodoError('SANDBOX_CONFIG', 'run output must be a separate directory outside the workspace');
  }
  const input: SandboxLaunchInput = { program: executable, args: [...args], workspace, cwd, env, read: scope.read, write: options.write ? scope.write ?? ['.'] : [], deny, readOnlyPaths, outputDirectory, network: options.network ?? 'none', resources: options.resources };
  if (process.platform === 'win32') return await prepareWindowsSandbox(input);
  if (process.platform === 'linux' || process.platform === 'darwin') return await preparePosixSandbox(input);
  throw new KodoError('SANDBOX_UNAVAILABLE', 'no operating system sandbox backend is available for this platform');
}

export type { PreparedSandbox, SandboxLaunchInput } from './types.js';
export type { SandboxResources } from './policy.js';
