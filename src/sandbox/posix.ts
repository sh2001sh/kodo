import { constants } from 'node:fs';
import { access, lstat, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { KodoError } from '../runtime/types.js';
import type { PreparedSandbox, SandboxLaunchInput } from './types.js';
import { validateSandboxNetworkAllowlist, validateSandboxResources } from './policy.js';

const within = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const validText = (value: string): boolean => !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const unavailable = (message: string): KodoError => new KodoError('SANDBOX_UNAVAILABLE', message);
const invalid = (message: string): KodoError => new KodoError('SANDBOX_POLICY', message);

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function canonical(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try { return path.join(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function scopeRoots(workspace: string, entries: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry || !validText(entry) || entry.includes('\\') || entry.split('/').includes('..')) throw invalid('sandbox scope entries must be relative workspace paths');
    const lexical = path.resolve(workspace, entry);
    if (path.isAbsolute(entry) || !within(workspace, lexical)) throw invalid('sandbox scope entries must remain inside the workspace');
    const resolved = await canonical(lexical);
    if (!within(workspace, resolved) || !within(lexical, resolved)) throw invalid('sandbox scope entries cannot redirect through symbolic links');
    roots.push(resolved);
  }
  return [...new Set(roots)].sort((left, right) => left.length - right.length || left.localeCompare(right));
}

async function resolveExecutable(program: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (!program || !validText(program) || program.includes('\\') || /^[a-z]:/iu.test(program)) throw invalid('sandbox executable must be a native POSIX path or command');
  const candidates = path.isAbsolute(program) ? [program] : program.includes('/') ? [] : (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').filter(part => path.isAbsolute(part)).map(part => path.join(part, program));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw invalid('sandbox executable could not be resolved to an executable file');
}

async function runProbe(program: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, extraFiles: number[] = []): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { env, cwd, stdio: ['ignore', 'ignore', 'pipe', ...extraFiles] });
    let settled = false;
    let diagnostics = '';
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(unavailable('sandbox readiness probe timed out'));
    }, 5000);
    child.stderr!.on('data', (data: Buffer) => { if (diagnostics.length < 2048) diagnostics += data.toString('utf8').slice(0, 2048 - diagnostics.length); });
    child.once('error', () => finish(unavailable('sandbox backend cannot be executed')));
    child.once('close', code => finish(code === 0 ? undefined : unavailable(`sandbox readiness probe failed${diagnostics.trim() ? `: ${diagnostics.trim()}` : ''}`)));
  });
}

const hostEnvironment = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8' });

/** Block addressable sockets; anonymous AF_UNIX pairs support local event-loop wakeups. */
function noNetworkFilter(): Buffer {
  const architectures: Record<string, { audit: number; calls: number[]; socketpair: number }> = {
    x64: { audit: 0xc000003e, calls: [41, 42, 425], socketpair: 53 },
    arm64: { audit: 0xc00000b7, calls: [198, 199, 425], socketpair: 203 },
    // Legacy multiplexed socketcall stays denied; modern direct socketpair is supported.
    ia32: { audit: 0x40000003, calls: [102, 359, 362, 425], socketpair: 360 },
  };
  const architecture = architectures[process.arch];
  if (!architecture) throw unavailable('Linux socket filtering is supported on x86-64, ARM64 and x86 hosts');
  const instructions: [number, number, number, number][] = [
    [0x20, 0, 0, 4], // seccomp_data.arch
    [0x15, 1, 0, architecture.audit],
    [0x06, 0, 0, 0x80000000], // kill on an unexpected syscall ABI
    [0x20, 0, 0, 0], // seccomp_data.nr
  ];
  if (process.arch === 'x64') instructions.push([0x45, 0, 1, 0x40000000], [0x06, 0, 0, 0x00050001]); // reject the x32 ABI
  for (const syscall of architecture.calls) instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]); // EPERM
  instructions.push(
    [0x15, 0, 4, architecture.socketpair],
    [0x20, 0, 0, 16], // first syscall argument: domain
    [0x15, 1, 0, 1], // AF_UNIX only; these endpoints cannot connect to a host pathname
    [0x06, 0, 0, 0x00050001],
    [0x06, 0, 0, 0x7fff0000],
  );
  instructions.push([0x06, 0, 0, 0x7fff0000]);
  const result = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, argument], index) => {
    result.writeUInt16LE(code, index * 8);
    result.writeUInt8(yes, index * 8 + 2);
    result.writeUInt8(no, index * 8 + 3);
    result.writeUInt32LE(argument, index * 8 + 4);
  });
  return result;
}

/** No shell is involved. Child environment is installed only after containment. */
function childEnvironment(input: SandboxLaunchInput, home: string, temp: string): [string, string][] {
  const entries = Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined);
  for (const [key, value] of entries) if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes('\0')) throw invalid('invalid sandbox environment entry');
  const map = new Map(entries);
  map.set('HOME', home);
  map.set('TMPDIR', temp);
  map.set('TMP', temp);
  map.set('TEMP', temp);
  return [...map];
}

/** Prepare an enforced OS sandbox. Missing backends and rejected kernel facilities fail closed. */
export async function preparePosixSandbox(input: SandboxLaunchInput): Promise<PreparedSandbox> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw unavailable('POSIX sandboxes require Linux bubblewrap or macOS sandbox-exec');
  validateSandboxNetworkAllowlist(input?.networkAllowlist);
  validateSandboxResources(input?.resources);
  if (!input || typeof input.workspace !== 'string' || typeof input.cwd !== 'string' || !path.isAbsolute(input.workspace) || !path.isAbsolute(input.cwd) || !validText(input.workspace) || !validText(input.cwd) || !Array.isArray(input.args) || input.args.some(argument => typeof argument !== 'string' || argument.includes('\0')) || !Array.isArray(input.write) || !Array.isArray(input.deny) || (input.read !== undefined && !Array.isArray(input.read)) || !['none', 'allow'].includes(input.network)) throw invalid('invalid sandbox launch policy');
  const workspace = await realpath(input.workspace);
  const cwd = await realpath(input.cwd);
  if (!(await stat(workspace)).isDirectory() || !(await stat(cwd)).isDirectory() || !within(workspace, cwd)) throw invalid('sandbox working directory must be inside its workspace');
  const read = await scopeRoots(workspace, input.read ?? ['.']);
  const write = await scopeRoots(workspace, input.write);
  if (input.outputDirectory) write.push(input.outputDirectory);
  const deny = await scopeRoots(workspace, input.deny);
  const extra = await Promise.all((input.readOnlyPaths ?? []).map(async target => {
    if (!path.isAbsolute(target) || !validText(target)) throw invalid('sandbox runtime paths must be absolute');
    const result = await realpath(target);
    if (within(result, workspace)) throw invalid('sandbox runtime paths cannot expose an ancestor of the workspace');
    return result;
  }));
  const executable = await resolveExecutable(input.program, input.env);
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-sandbox-')));
  let seccomp: FileHandle | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (!cleaned) {
      if (seccomp) { await seccomp.close(); seccomp = undefined; }
      await rm(temp, { recursive: true, force: true });
      cleaned = true;
    }
  };
  try {
    if (process.platform === 'linux') {
      const runtime = ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/libexec', '/usr/share', '/usr/local/bin', '/usr/local/lib', '/bin', '/sbin', '/lib', '/lib64', '/etc/alternatives', '/etc/fonts'];
      if (['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/alternatives', '/etc/fonts', '/etc/ssl/certs', '/etc/ld.so.cache', '/etc/pki'].some(root => within(root, workspace) || within(workspace, root))) throw invalid('sandbox workspace cannot overlap a system runtime tree');
      let backend: string;
      try { backend = await resolveExecutable('bwrap', { PATH: '/usr/bin:/bin:/usr/local/bin' }); }
      catch { throw unavailable('Linux OS sandbox requires bubblewrap (bwrap)'); }
      const args = ['--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL', '--clearenv'];
      if (input.network === 'allow') args.push('--share-net');
      for (const root of runtime) if (await exists(root)) args.push('--ro-bind', root, root);
      for (const target of ['/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/ssl/certs', '/etc/pki/ca-trust/extracted', '/etc/pki/tls/certs', '/etc/pki/java/cacerts', '/etc/localtime']) if (await exists(target)) args.push('--ro-bind', target, target);
      if (input.network === 'allow') for (const target of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf']) if (await exists(target)) args.push('--ro-bind', target, target);
      args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--dir', '/tmp/kodo-home', '--dir', '/tmp/kodo-tmp', '--dir', workspace);
      const mounts = [...read.map(target => ({ target, writable: false })), ...write.map(target => ({ target, writable: true }))].sort((left, right) => Number(left.writable) - Number(right.writable) || left.target.length - right.target.length);
      for (const { target, writable } of mounts) {
        // A scope may name a file that the agent has yet to create. It must not
        // prevent unrelated commands from starting. Keep the existing parent
        // mount unchanged: native write can create an exact future file, and
        // the next launch will bind it. Never create a placeholder or grant its
        // parent directory merely to make a missing bind source available.
        if (!await exists(target)) continue;
        args.push(writable ? '--bind' : '--ro-bind', target, target);
      }
      const empty = path.join(temp, 'denied');
      await writeFile(empty, '', { mode: 0o400 });
      for (const target of deny) {
        const metadata = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
        if (!metadata || metadata.isDirectory()) args.push('--tmpfs', target, '--remount-ro', target);
        else args.push('--ro-bind', empty, target);
      }
      // Exact immutable host resources may live beneath the private registry.
      // Expose those verified trees after hiding their surrounding data store.
      for (const target of new Set([...extra, executable])) args.push('--ro-bind', target, target);
      args.push('--remount-ro', '/proc', '--chdir', cwd);
      for (const [key, value] of childEnvironment(input, '/tmp/kodo-home', '/tmp/kodo-tmp')) args.push('--setenv', key, value);
      const probe = await resolveExecutable('true', { PATH: '/usr/bin:/bin' });
      let extraFiles: number[] | undefined;
      if (input.network === 'none') {
        const filterPath = path.join(temp, 'socket-filter.bpf');
        await writeFile(filterPath, noNetworkFilter(), { mode: 0o400 });
        args.push('--seccomp', '3');
        const probeFilter = await open(filterPath, 'r');
        try { await runProbe(backend, [...args, '--', probe], hostEnvironment(), workspace, [probeFilter.fd]); }
        finally { await probeFilter.close(); }
        seccomp = await open(filterPath, 'r');
        extraFiles = [seccomp.fd];
      } else await runProbe(backend, [...args, '--', probe], hostEnvironment(), workspace);
      let payload = [executable, ...input.args];
      if (input.resources && Object.keys(input.resources).length) {
        // prlimit executes inside containment and sets hard as well as soft limits,
        // so an untrusted payload cannot raise them again. RLIMIT_NPROC includes
        // other tasks owned by this real UID, making it intentionally conservative.
        if (input.resources.maxProcesses !== undefined && process.getuid?.() === 0) throw unavailable('Linux process quotas cannot be enforced for a root real UID; run as an unprivileged user or use a cgroup backend');
        let limiter: string;
        try { limiter = await resolveExecutable('prlimit', { PATH: '/usr/bin:/bin' }); }
        catch { throw unavailable('Linux sandbox resource quotas require util-linux prlimit'); }
        const limits: string[] = [];
        if (input.resources.memoryBytes !== undefined) limits.push(`--as=${input.resources.memoryBytes}:${input.resources.memoryBytes}`);
        if (input.resources.maxProcesses !== undefined) limits.push(`--nproc=${input.resources.maxProcesses}:${input.resources.maxProcesses}`);
        payload = [limiter, ...limits, '--', ...payload];
      }
      return { program: backend, args: [...args, '--', ...payload], cwd: workspace, env: hostEnvironment(), extraFiles, cleanup };
    }
    const backend = '/usr/bin/sandbox-exec';
    try { await access(backend, constants.X_OK); } catch { throw unavailable('macOS OS sandbox requires sandbox-exec'); }
    const literal = (value: string): string => JSON.stringify(value);
    const predicate = async (target: string): Promise<string> => {
      const info = await stat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      return `(${!info || info.isDirectory() ? 'subpath' : 'literal'} ${literal(target)})`;
    };
    const readable = [...new Set(['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/libexec', '/usr/share', '/usr/local/bin', '/usr/local/lib', '/usr/local/Cellar', '/usr/local/opt', '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/bin', '/sbin', '/System/Library', '/Library/Apple/System/Library', '/private/var/db/dyld', '/private/etc/ssl/certs', '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/fd', '/private/etc/localtime', executable, temp, ...extra, ...read, ...write])];
    if (input.network === 'allow') readable.push('/private/etc/resolv.conf', '/private/etc/hosts');
    if (['/usr', '/bin', '/sbin', '/System', '/Library/Apple/System', '/opt/homebrew', '/private/var/db/dyld', '/private/etc/ssl/certs'].some(root => within(root, workspace) || within(workspace, root))) throw invalid('sandbox workspace cannot overlap a system runtime tree');
    // macOS has no PID namespace/job equivalent here. Disallow forks rather than
    // letting a detached child outlive cancellation or a successful tool result.
    const profile = ['(version 1)', '(deny default)', '(allow process-exec)', '(deny process-fork)', '(allow signal (target self))', '(allow sysctl-read)', '(allow mach-lookup (global-name "com.apple.system.logger"))'];
    const parentDirectories = new Set<string>([workspace, cwd]);
    for (const target of readable) for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
      parentDirectories.add(parent);
      if (parent === path.dirname(parent)) break;
    }
    for (const parent of parentDirectories) profile.push(`(allow file-read-metadata (literal ${literal(parent)}))`);
    for (const target of readable) profile.push(`(allow file-read* ${await predicate(target)})`);
    profile.push(`(allow file-write* (subpath ${literal(temp)}))`, '(allow file-write-data (literal "/dev/null"))');
    for (const target of write) profile.push(`(allow file-write* ${await predicate(target)})`);
    for (const target of deny) {
      const exceptions = extra.filter(resource => within(target, resource));
      const exclusion = exceptions.length ? ` (require-not (require-any ${await Promise.all(exceptions.map(predicate)).then(values => values.join(' '))}))` : '';
      profile.push(`(deny file-read* (require-all (subpath ${literal(target)})${exclusion}))`, `(deny file-write* (subpath ${literal(target)}))`);
    }
    if (input.network === 'allow') profile.push('(allow network*)');
    const prefix = ['-p', profile.join('\n')];
    await runProbe(backend, [...prefix, '/usr/bin/true'], hostEnvironment(), workspace);
    const env = childEnvironment(input, temp, temp).map(([key, value]) => `${key}=${value}`);
    return { program: backend, args: [...prefix, '/usr/bin/env', '-i', ...env, executable, ...input.args], cwd, env: hostEnvironment(), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
