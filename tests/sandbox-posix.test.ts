import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preparePosixSandbox } from '../src/sandbox/posix.js';
import type { PreparedSandbox, SandboxLaunchInput } from '../src/sandbox/types.js';

const posix = process.platform === 'linux' || process.platform === 'darwin';

async function execute(prepared: PreparedSandbox): Promise<{ code: number | null; output: string; error: string }> {
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(prepared.program, prepared.args, { cwd: prepared.cwd, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe', ...(prepared.extraFiles ?? [])] });
      let output = '', error = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('sandbox command timed out')); }, 10000);
      child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      child.stderr!.on('data', (chunk: Buffer) => { error += chunk.toString('utf8'); });
      child.once('error', failure => { clearTimeout(timeout); reject(failure); });
      child.once('close', code => { clearTimeout(timeout); resolve({ code, output, error }); });
    });
  } finally { await prepared.cleanup(); }
}

it.skipIf(posix)('rejects a POSIX backend on unsupported operating systems without running the command', async () => {
  await expect(preparePosixSandbox({ program: process.execPath, args: [], cwd: process.cwd(), env: {}, workspace: process.cwd(), write: [], deny: [], network: 'none' })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
});

describe.skipIf(!posix)('real POSIX OS containment', () => {
  let root: string;
  let workspace: string;
  let unavailable: string | undefined;
  const input = (script: string, overrides: Partial<SandboxLaunchInput> = {}): SandboxLaunchInput => ({
    program: process.execPath, args: ['-e', script], cwd: workspace, workspace,
    env: { PATH: process.env.PATH }, read: ['.'], write: ['write'], deny: ['private'], network: 'none', ...overrides,
  });
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-posix-test-')));
    workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    for (const entry of ['read', 'write', 'private']) await mkdir(path.join(workspace, entry));
    await writeFile(path.join(root, 'outside'), 'outside secret');
    await writeFile(path.join(workspace, 'read', 'visible'), 'visible');
    await writeFile(path.join(workspace, 'private', 'secret'), 'private secret');
    try { await (await preparePosixSandbox(input(''))).cleanup(); }
    catch (error) {
      if ((error as { code?: string }).code !== 'SANDBOX_UNAVAILABLE') throw error;
      unavailable = (error as Error).message;
    }
  }, 10000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it.skipIf(process.platform !== 'linux')('resolves installed system commands through the alternatives directory', async context => {
    if (unavailable) { context.skip(unavailable); return; }
    const awk = await realpath('/usr/bin/awk').catch(() => undefined);
    if (!awk) { context.skip('awk is not installed'); return; }
    const result = await execute(await preparePosixSandbox(input('', {
      program: '/bin/sh', args: ['-c', "awk 'BEGIN {print 6 * 7}'"], env: { PATH: '/usr/bin:/bin' }, write: [],
    })));
    expect(result.code, result.error).toBe(0);
    expect(result.output.trim()).toBe('42');
  });

  it('allows granted IO and blocks host sibling, protected directory and read-only writes', async context => {
    if (unavailable) { context.skip(unavailable); return; }
    const result = await execute(await preparePosixSandbox(input(`
      const fs = require('node:fs');
      const attempt = (fn) => { try { fn(); return true; } catch { return false; } };
      console.log(JSON.stringify({
        read: fs.readFileSync('read/visible', 'utf8'),
        write: attempt(() => fs.writeFileSync('write/result', 'ok')),
        outside: attempt(() => fs.readFileSync(${JSON.stringify(path.join(root, 'outside'))})),
        denied: attempt(() => fs.readFileSync('private/secret')),
        readonly: attempt(() => fs.writeFileSync('read/visible', 'bad')),
        privateHome: process.env.HOME !== ${JSON.stringify(os.homedir())},
      }));
    `)));
    expect(result.error).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ read: 'visible', write: true, outside: false, denied: false, readonly: false, privateHome: true });
    expect(await readFile(path.join(workspace, 'write', 'result'), 'utf8')).toBe('ok');
  });

  it('projects narrow read roots and keeps descendants contained', async context => {
    if (unavailable) { context.skip(unavailable); return; }
    const result = await execute(await preparePosixSandbox(input(`
      const fs = require('node:fs');
      let hidden = false;
      try { fs.readFileSync('private/secret'); } catch { hidden = true; }
      const child = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(`try { require('node:fs').readFileSync(${JSON.stringify(path.join(root, 'outside'))}); process.exit(9); } catch { process.exit(0); }`)}]);
      console.log(JSON.stringify({ visible: fs.readFileSync('read/visible','utf8'), hidden, child: child.status }));
    `, { read: ['read'] })));
    expect(result.code, result.error).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ visible: 'visible', hidden: true, child: process.platform === 'darwin' ? null : 0 });
  });

  it('does not let a read mount revoke a broader explicit write grant', async context => {
    if (unavailable) { context.skip(unavailable); return; }
    const result = await execute(await preparePosixSandbox(input(`require('node:fs').writeFileSync('read/allowed', 'ok')`, { read: ['read'], write: ['.'] })));
    expect(result.code, result.error).toBe(0);
    expect(await readFile(path.join(workspace, 'read', 'allowed'), 'utf8')).toBe('ok');
  });

  it.skipIf(process.platform !== 'linux')('runs ordinary commands before a future scoped file exists, then mounts it after native creation', async context => {
    if (unavailable) { context.skip(unavailable); return; }
    const future = 'read/future-test.txt';
    const target = path.join(workspace, future);
    const launch = (script: string) => preparePosixSandbox(input(script, { read: ['.', 'read/future-read.txt'], write: [future] }));
    const first = await execute(await launch(`console.log(require('node:fs').readFileSync('read/visible', 'utf8'))`));
    expect(first.code, first.error).toBe(0);
    expect(first.output.trim()).toBe('visible');
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // The native file tool writes in the host workspace, before a fresh launch.
    await writeFile(target, 'created');
    const second = await execute(await launch(`const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(future)}, '-checked'); console.log(fs.readFileSync(${JSON.stringify(future)}, 'utf8'))`));
    expect(second.code, second.error).toBe(0);
    expect(second.output.trim()).toBe('created-checked');
    expect(await readFile(target, 'utf8')).toBe('created-checked');
  });

  it('blocks network access to a live host TCP listener', async context => {
    if (unavailable) { context.skip(unavailable); return; }
    const server = createServer(socket => socket.end('host secret'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('invalid TCP fixture');
      const result = await execute(await preparePosixSandbox(input(`
        const socket = require('node:net').connect(${address.port}, '127.0.0.1');
        socket.on('connect', () => process.exit(9)); socket.on('error', () => process.exit(0));
        setTimeout(() => process.exit(0), 1000);
      `)));
      expect(result.code, result.error).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it.skipIf(process.platform !== 'linux')('supports Python asyncio wakeups and propagates coroutine failures while offline', async context => {
    if (unavailable) { context.skip(unavailable); return; }
    const python = (script: string) => preparePosixSandbox(input('', { program: '/usr/bin/python3', args: ['-c', script] }));
    const result = await execute(await python('import asyncio, socket\na, b = socket.socketpair()\na.send(b"local")\nassert b.recv(5) == b"local"\na.close(); b.close()\nasync def main():\n await asyncio.sleep(0.01)\n return "done"\nprint(asyncio.run(main()))'));
    expect(result.code, result.error).toBe(0);
    expect(result.output.trim()).toBe('done');
    const failed = await execute(await python('import asyncio\nasync def main():\n await asyncio.sleep(0)\n raise ValueError("ordinary task failure")\nasyncio.run(main())'));
    expect(failed.code).toBe(1);
    expect(failed.error).toContain('ValueError: ordinary task failure');
  });

  it('blocks pathname Unix sockets even when the workspace path is readable', async context => {
    if (unavailable) { context.skip(unavailable); return; }
    const socketPath = path.join(workspace, 'host.sock');
    const server = createServer(socket => socket.end('host secret'));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    try {
      const result = await execute(await preparePosixSandbox(input(`
        const socket = require('node:net').connect(${JSON.stringify(socketPath)});
        socket.on('connect', () => process.exit(9)); socket.on('error', () => process.exit(0));
        setTimeout(() => process.exit(0), 1000);
      `)));
      expect(result.code, result.error).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('rejects scope traversal, symlink redirection and runtime paths that expose a workspace ancestor', async context => {
    if (unavailable) { context.skip(unavailable); return; }
    await expect(preparePosixSandbox(input('', { write: ['../outside'] }))).rejects.toMatchObject({ code: 'SANDBOX_POLICY' });
    await expect(preparePosixSandbox(input('', { readOnlyPaths: [root] }))).rejects.toMatchObject({ code: 'SANDBOX_POLICY' });
    await symlink(root, path.join(workspace, 'escape'));
    await expect(preparePosixSandbox(input('', { read: ['escape'] }))).rejects.toMatchObject({ code: 'SANDBOX_POLICY' });
  });

  it('treats argument and environment metacharacters as literal data', async context => {
    if (unavailable) { context.skip(unavailable); return; }
    const text = '$(touch injected); "quoted" `commands`';
    const result = await execute(await preparePosixSandbox(input(`console.log(JSON.stringify([process.argv[1], process.env.VALUE]))`, { args: ['-e', `console.log(JSON.stringify([process.argv[1], process.env.VALUE]))`, text], env: { PATH: process.env.PATH, VALUE: text } })));
    expect(result.code, result.error).toBe(0);
    expect(JSON.parse(result.output)).toEqual([text, text]);
  });
});
