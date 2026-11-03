import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { prepareWindowsSandbox } from '../src/sandbox/windows/index.js';
import type { PreparedSandbox, SandboxLaunchInput } from '../src/sandbox/types.js';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<SandboxLaunchInput> {
  const root = await mkdtemp(path.join(tmpdir(), 'kodo-windows-test-')); roots.push(root);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  await writeFile(path.join(root, 'outside.txt'), 'host secret');
  await writeFile(path.join(workspace, '.env'), 'protected secret');
  return { program: process.execPath, args: [], cwd: workspace, workspace, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, write: ['.'], deny: ['.env'], network: 'none' };
}
async function run(input: SandboxLaunchInput) {
  const prepared = await prepareWindowsSandbox(input);
  try { return await execute(prepared.program, prepared.args, { cwd: prepared.cwd, env: prepared.env, windowsHide: true, timeout: 15000 }); }
  finally { await prepared.cleanup(); }
}
const windows = describe.skipIf(process.platform !== 'win32');
windows('Windows native AppContainer OS sandbox', () => {
  it('refuses a second workspace writer while permitting independent read-only execution', async () => {
    const input = await fixture();
    const first = await prepareWindowsSandbox({ ...input, args: ['-e', `console.log('READY');process.stdin.resume()`] });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(first.program, first.args, { cwd: first.cwd, env: first.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const firstClosed = new Promise<void>(resolve => child!.once('close', () => resolve()));
      await new Promise<void>((resolve, reject) => { child!.stdout!.once('data', () => resolve()); child!.once('error', reject); });
      await expect(run({ ...input, args: ['-e', `require('node:fs').writeFileSync('must-not-exist','bad')`] })).rejects.toThrow('workspace-writing sandbox is active');
      const reader = await run({ ...input, write: [], args: ['-e', `console.log('reader-ok')`] });
      expect(reader.stdout.trim()).toBe('reader-ok');
      child.stdin!.end(); await firstClosed; child = undefined;
      await first.cleanup();
      expect((await run({ ...input, args: ['-e', `require('node:fs').writeFileSync('after','ok')`] })).stderr).toBe('');
    } finally { child?.kill(); await first.cleanup(); }
  }, 30000);
  it('keeps a surviving reader isolated while another sandbox restores its own ACLs', async () => {
    const input = await fixture();
    input.write = [];
    const before = await execute('icacls.exe', [input.workspace]);
    const first = await prepareWindowsSandbox({ ...input, args: ['-e', `console.log('READY');setTimeout(()=>{},500)`] });
    const second = await prepareWindowsSandbox({ ...input, args: ['-e', `setTimeout(()=>{try{console.log(require('node:fs').readFileSync('.env','utf8'))}catch{console.log('DENIED')}},1500)`] });
    try {
      const a = spawn(first.program, first.args, { cwd: first.cwd, env: first.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const aClosed = new Promise<void>((resolve, reject) => { a.once('error', reject); a.once('close', code => code === 0 ? resolve() : reject(new Error(`first sandbox exit ${code}`))); });
      await new Promise<void>((resolve, reject) => { a.stdout.once('data', () => resolve()); a.once('error', reject); });
      const b = execute(second.program, second.args, { cwd: second.cwd, env: second.env, windowsHide: true, timeout: 15000 });
      await aClosed;
      await first.cleanup();
      expect((await b).stdout.trim()).toBe('DENIED');
      await second.cleanup();
      expect((await execute('icacls.exe', [input.workspace])).stdout).toBe(before.stdout);
      expect(await readFile(path.join(input.workspace, '.env'), 'utf8')).toBe('protected secret');
    } finally { await first.cleanup(); await second.cleanup(); }
  }, 30000);
  it('runs Node, allows scoped files, refuses outside/protected reads and writes, and inherits isolation in descendants', async () => {
    const input = await fixture();
    input.args = ['-e', `const f=require('node:fs'),c=require('node:child_process');
      const outside=${JSON.stringify(path.join(path.dirname(input.workspace), 'outside.txt'))};
      const denied=(fn)=>{try{fn();return false}catch(e){return ['EACCES','EPERM'].includes(e.code)}};
      f.writeFileSync('allowed.txt','allowed');
      const checks=[f.readFileSync('allowed.txt','utf8')==='allowed',denied(()=>f.readFileSync(outside)),denied(()=>f.writeFileSync(outside,'bad')),denied(()=>f.readFileSync('.env')),denied(()=>f.writeFileSync('.env','bad'))];
      const nested=c.spawnSync(process.execPath,['-e', 'try{require("node:fs").readFileSync('+JSON.stringify(outside)+');process.exit(42)}catch(e){process.exit(e.code==="EACCES"||e.code==="EPERM"?0:43)}'],{timeout:3000,stdio:'inherit'});checks.push(nested.status===0);
      console.log(JSON.stringify(checks));`];
    const result = await run(input);
    expect(JSON.parse(result.stdout.trim())).toEqual([true, true, true, true, true, true]);
    expect(await readFile(path.join(path.dirname(input.workspace), 'outside.txt'), 'utf8')).toBe('host secret');
    expect(await readFile(path.join(input.workspace, '.env'), 'utf8')).toBe('protected secret');
  }, 30000);

  it('sets and restores integrity labels when the owner has Modify but not WRITE_OWNER', async () => {
    const input = await fixture();
    const limited = path.join(input.workspace, 'limited');
    await mkdir(limited);
    await execute('icacls.exe', [limited, '/inheritance:r', '/grant:r', '*S-1-5-11:(OI)(CI)M']);
    input.write = ['limited'];
    input.args = ['-e', `require('node:fs').writeFileSync('limited/result.txt','ok')`];
    await expect(run(input)).resolves.toMatchObject({ stderr: '' });
    expect(await readFile(path.join(limited, 'result.txt'), 'utf8')).toBe('ok');
  }, 30000);

  it('denies networking against a live host listener', async () => {
    const input = await fixture(); let connections = 0;
    const server = createServer(socket => { connections++; socket.end('reachable'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No TCP port');
    input.args = ['-e', `const s=require('node:net').connect(${address.port},'127.0.0.1');s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('error',e=>console.log('DENIED:'+e.code));s.setTimeout(800,()=>{console.log('DENIED:timeout');s.destroy()})`];
    try { const result = await run(input); expect(result.stdout).toContain('DENIED:'); expect(connections).toBe(0); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 30000);

  it('loads a file entry point with an interactive stdin pipe and a read-only workspace', async () => {
    const input = await fixture(); input.write = [];
    const entry = path.join(input.workspace, 'entry.mjs');
    await writeFile(entry, "import { createInterface } from 'node:readline'; createInterface({input:process.stdin}).once('line',line=>{console.log('reply:'+line);process.exit(0)})");
    input.args = [entry]; const prepared = await prepareWindowsSandbox(input);
    try {
      const child = spawn(prepared.program, prepared.args, { cwd: prepared.cwd, env: prepared.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const result = new Promise<string>((resolve, reject) => { let out='', err=''; child.stdout.on('data', chunk => { out += String(chunk); }); child.stderr.on('data', chunk => { err += String(chunk); }); child.once('error', reject); child.once('close', code => code ? reject(new Error(err)) : resolve(out)); });
      child.stdin.write('hello\n');
      expect(await result).toBe('reply:hello\n');
    } finally { await prepared.cleanup(); }
  }, 30000);

  it('runs Node tooling compatibly: temp dir, userInfo, realpath, nested creation, and piped-child output', async () => {
    const input = await fixture();
    const before = await execute('icacls.exe', [input.workspace]);
    const probe = [
      `const fs=require('node:fs'),os=require('node:os'),cp=require('node:child_process');`,
      `fs.mkdirSync('out/a/b',{recursive:true});fs.writeFileSync('out/a/b/x.txt','ok');`,
      `const child=cp.spawnSync(process.execPath,['-e',"process.stdout.write('pipe-ok')"],{stdio:'pipe',encoding:'utf8'});if(child.error)throw child.error;`,
      `console.log(JSON.stringify({tmp:fs.existsSync(os.tmpdir()),user:typeof os.userInfo().username,real:fs.realpathSync('.')===process.cwd(),tmpReal:fs.realpathSync(os.tmpdir())===os.tmpdir(),pipe:child.stdout,status:child.status}))`,
    ].join('');
    const result = await run({ ...input, args: ['-e', probe] });
    expect(JSON.parse(result.stdout.trim())).toEqual({ tmp: true, user: 'string', real: true, tmpReal: true, pipe: 'pipe-ok', status: 0 });
    // Cleanup must restore labels on objects the container created (non-canonical DACLs).
    expect(result.stderr).toBe('');
    expect(await readFile(path.join(input.workspace, 'out', 'a', 'b', 'x.txt'), 'utf8')).toBe('ok');
    expect((await execute('icacls.exe', [input.workspace])).stdout).toBe(before.stdout);
  }, 30000);

  it('grants a deny-free tree by inheritance, covers protected-DACL descendants, and restores every object', async () => {
    const input = await fixture();
    await rm(path.join(input.workspace, '.env'));
    await mkdir(path.join(input.workspace, 'deep', 'nested'), { recursive: true });
    await writeFile(path.join(input.workspace, 'deep', 'nested', 'file.txt'), 'deep');
    const isolated = path.join(input.workspace, 'deep', 'isolated.txt');
    await writeFile(isolated, 'isolated');
    await execute('icacls.exe', [isolated, '/inheritance:d', '/Q']);
    await mkdir(path.join(input.workspace, 'out'));
    const snapshot = async () => (await execute('icacls.exe', [input.workspace, '/T', '/C', '/Q'])).stdout;
    const before = await snapshot();
    const probe = `const f=require('node:fs');f.writeFileSync('out/new.txt','ok');console.log(f.readFileSync('deep/nested/file.txt','utf8')+'|'+f.readFileSync('deep/isolated.txt','utf8'))`;
    const result = await run({ ...input, deny: [], write: ['out'], args: ['-e', probe] });
    expect(result.stdout.trim()).toBe('deep|isolated');
    expect(result.stderr).toBe('');
    expect(await readFile(path.join(input.workspace, 'out', 'new.txt'), 'utf8')).toBe('ok');
    // The container-created file is not a host object; every pre-existing object must match exactly.
    await rm(path.join(input.workspace, 'out', 'new.txt'));
    const after = await snapshot();
    expect(after).not.toMatch(/S-1-15-2-/);
    expect(after).toBe(before);
  }, 30000);

  it('kills detached descendants when the launcher is forcibly terminated, then restores ACLs and integrity labels', async () => {
    const input = await fixture();
    const before = await execute('icacls.exe', [input.workspace]);
    input.args = ['-e', `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`];
    let prepared: PreparedSandbox | undefined;
    try {
      prepared = await prepareWindowsSandbox(input);
      const child = spawn(prepared.program, prepared.args, { cwd: prepared.cwd, env: prepared.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
      const descendant = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Sandbox startup timed out: ' + stderr)), 12000);
        child.stdout.once('data', chunk => { clearTimeout(timeout); resolve(Number(String(chunk).trim())); });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error('Sandbox exited before child startup: ' + stderr)); });
      });
      expect(descendant).toBeGreaterThan(0);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited;
      await prepared.cleanup(); prepared = undefined;
      expect(() => process.kill(descendant, 0)).toThrow();
      const after = await execute('icacls.exe', [input.workspace]);
      expect(after.stdout).toBe(before.stdout);
    } finally { await prepared?.cleanup(); }
  }, 30000);
});
