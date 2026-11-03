import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { createSandbox } from '../dist/application/index.js';
const { AbortSignal } = globalThis;

// This gate intentionally has no skip/fallback: an unavailable native backend
// is a failed platform verification, not evidence of containment.
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-platform-')));
let server;
try {
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) throw new Error('No supported native sandbox on this platform');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace); await mkdir(path.join(workspace, 'allowed'));
  await writeFile(path.join(root, 'outside'), 'host-private', 'utf8');
  await writeFile(path.join(workspace, '.env'), 'protected', 'utf8');
  await writeFile(path.join(workspace, 'allowed', 'input'), 'scoped', 'utf8');
  const sandbox = createSandbox({ workspace, scope: { read: ['allowed'], write: ['allowed'] }, write: true, network: 'none' });
  const result = await sandbox.run(process.execPath, ['-e', `
    const fs=require('node:fs');const denied=p=>{try{fs.readFileSync(p);return false}catch{return true}};
    fs.writeFileSync('allowed/result','written');
    console.log(JSON.stringify({read:fs.readFileSync('allowed/input','utf8'),outside:denied(${JSON.stringify(path.join(root, 'outside'))}),protected:denied('.env')}));
  `], { signal: AbortSignal.timeout(30000) });
  if (result.cancelled || result.exitCode !== 0 || JSON.stringify(JSON.parse(result.stdout)) !== JSON.stringify({ read: 'scoped', outside: true, protected: true }) || await readFile(path.join(workspace, 'allowed/result'), 'utf8') !== 'written') throw new Error(`Native file containment failed: ${JSON.stringify(result)}`);
  console.log(`PASS ${process.platform}/${process.arch}: real sandbox scoped IO and denied host/protected paths`);
  let connections = 0;
  server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP listener did not start');
  const blocked = await sandbox.run(process.execPath, ['-e', `const s=require('node:net').connect(${address.port},'127.0.0.1');s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('error',()=>console.log('DENIED'));s.setTimeout(1000,()=>{console.log('DENIED');s.destroy()})`], { signal: AbortSignal.timeout(30000) });
  if (blocked.exitCode !== 0 || !blocked.stdout.includes('DENIED') || blocked.stdout.includes('CONNECTED') || connections !== 0) throw new Error(`Native network denial failed: ${JSON.stringify(blocked)}`);
  console.log('PASS native network denial against a live TCP listener');
  const cancelled = await sandbox.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: AbortSignal.timeout(3000) });
  if (!cancelled.cancelled) throw new Error('Native cancellation did not terminate the process');
  console.log('PASS native process cancellation');
  if (process.platform === 'win32') {
    const limited = createSandbox({ workspace, scope: { read: ['.'], write: [] }, resources: { maxProcesses: 1, memoryBytes: 384 * 1024 * 1024 } });
    const script = `const r=require('node:child_process').spawnSync(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'});console.log(JSON.stringify({error:r.error?.code,status:r.status}))`;
    const control = await createSandbox({ workspace, scope: { read: ['.'], write: [] }, resources: { maxProcesses: 2, memoryBytes: 384 * 1024 * 1024 } }).run(process.execPath, ['-e', script], { signal: AbortSignal.timeout(30000) });
    if (control.exitCode !== 0 || JSON.parse(control.stdout).status !== 0) throw new Error(`Windows job control child failed: ${JSON.stringify(control)}`);
    const child = await limited.run(process.execPath, ['-e', script], { signal: AbortSignal.timeout(30000) });
    if (child.exitCode !== 0 || !JSON.parse(child.stdout).error || JSON.parse(child.stdout).status !== null || child.cancelled) throw new Error(`Windows job process ceiling failed: ${JSON.stringify(child)}`);
    const memory = await limited.run(process.execPath, ['-e', 'const a=[];for(let i=0;i<64;i++)a.push(Buffer.alloc(16*1024*1024,1));console.log("ESCAPED")'], { signal: AbortSignal.timeout(30000) });
    if (memory.exitCode === 0 || memory.cancelled || memory.stdout.includes('ESCAPED')) throw new Error(`Windows job memory ceiling failed: ${JSON.stringify(memory)}`);
    console.log('PASS native Windows job process and aggregate committed-memory ceilings');
  } else if (process.platform === 'linux') {
    const limited = createSandbox({ workspace, scope: { read: [], write: [] }, resources: { maxProcesses: 1, memoryBytes: 128 * 1024 * 1024 } });
    const quota = await limited.run('/usr/bin/python3', ['-c', `import os,resource
assert resource.getrlimit(resource.RLIMIT_AS)==(134217728,134217728)
assert resource.getrlimit(resource.RLIMIT_NPROC)==(1,1)
try:
 bytearray(268435456)
 raise RuntimeError('memory ceiling escaped')
except MemoryError: print('MEMORY_DENIED')
try:
 child=os.fork()
 if child==0: os._exit(0)
 os.waitpid(child,0)
 raise RuntimeError('process ceiling escaped')
except OSError as error:
 assert error.errno==11
 print('PROCESS_DENIED')`], { signal: AbortSignal.timeout(30000) });
    if (quota.exitCode !== 0 || !quota.stdout.includes('MEMORY_DENIED') || !quota.stdout.includes('PROCESS_DENIED')) throw new Error(`Linux prlimit enforcement failed: ${JSON.stringify(quota)}`);
    console.log('PASS native Linux address-space and conservative real-UID process ceilings');
  } else {
    // Seatbelt itself forbids fork. Memory quotas are deliberately rejected.
    const limited = createSandbox({ workspace, resources: { maxProcesses: 1 } });
    const fork = await limited.run(process.execPath, ['-e', `const r=require('node:child_process').spawnSync('/usr/bin/true',[]);console.log(r.error?'DENIED':'ESCAPED')`], { signal: AbortSignal.timeout(30000) });
    if (fork.exitCode !== 0 || fork.stdout.trim() !== 'DENIED') throw new Error(`macOS fork denial failed: ${JSON.stringify(fork)}`);
    let rejected = false;
    try { await createSandbox({ workspace, resources: { memoryBytes: 1024 * 1024 } }).run('/usr/bin/true', []); }
    catch (error) { if (error.code !== 'SANDBOX_UNAVAILABLE') throw error; rejected = true; }
    if (!rejected) throw new Error('macOS silently accepted unsupported memory quotas');
    console.log('PASS macOS fork denial and explicit rejection of unsupported memory quotas');
  }
  console.log(`PASS platform gate: ${process.platform}/${process.arch} ${process.version}; native gates skipped: 0`);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally {
  if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
