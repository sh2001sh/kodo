import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareWindowsSandbox } from '../src/sandbox/windows/index.js';

const execute = promisify(execFile);
const roots: string[] = [];
async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kodo-verification-compat-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(tmpdir()).toLowerCase() || !path.basename(root).startsWith('kodo-verification-compat-')) throw new Error('unexpected temporary workspace');
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function sandbox(workspace: string, args: string[], readOnlyPaths: string[] = []): Promise<{ stdout: string; stderr: string }> {
  const prepared = await prepareWindowsSandbox({ program: process.execPath, args, cwd: workspace, workspace, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, read: ['.'], write: [], deny: [], network: 'none', readOnlyPaths });
  try { return await execute(prepared.program, prepared.args, { cwd: prepared.cwd, env: prepared.env, windowsHide: true, timeout: 60_000 }); }
  finally { await prepared.cleanup(); }
}

describe.skipIf(process.platform !== 'win32')('Windows verification through brokered and inherited handles', () => {
  it('runs the Node test runner in one process with TAP output', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'arithmetic.test.mjs'), "import { test } from 'node:test'; import { strictEqual } from 'node:assert'; test('adds two numbers', () => strictEqual(2 + 3, 5));\n", 'utf8');
    const result = await sandbox(root, ['--test', '--test-isolation=none', '--test-reporter=tap', 'arithmetic.test.mjs']);
    expect(result.stdout).toContain('ok 1 - adds two numbers');
    expect(result.stdout).toContain('# fail 0');
  }, 30_000);

  it('passes the existing standard output handle to an ordinary Node child', async () => {
    const root = await workspace();
    const result = await sandbox(root, ['-e', "const result = require('node:child_process').spawnSync(process.execPath, ['-e', 'console.log(\"inherited-output-ok\")'], { stdio: 'inherit' }); if (result.error) throw result.error; process.exitCode = result.status;"]);
    expect(result.stdout.trim()).toBe('inherited-output-ok');
  }, 30_000);

  it('streams stdin, stdout and stderr through an asynchronous child', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'child.cjs'), "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{process.stdout.write(text.toUpperCase());process.stderr.write('ordinary diagnostic');});", 'utf8');
    const result = await sandbox(root, ['-e', "const assert=require('node:assert/strict');const child=require('node:child_process').spawn(process.execPath,['child.cjs']);let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',e=>{throw e});child.on('close',code=>{assert.equal(code,0);assert.equal(out,'HELLO 管道');assert.equal(err,'ordinary diagnostic');console.log('stream-ok')});child.stdin.end('hello 管道');"]);
    expect(result.stdout.trim()).toBe('stream-ok');
  }, 30_000);

  it('captures synchronous output, nonzero exits, timeouts and bounded output', async () => {
    const root = await workspace();
    const probe = [
      "const assert=require('node:assert/strict'),cp=require('node:child_process');",
      "const r=cp.spawnSync(process.execPath,['-e',\"process.stdin.pipe(process.stdout);process.stderr.write('diagnostic');process.exitCode=7\"],{input:'同步 input',encoding:'utf8'});",
      "assert.equal(r.error,undefined);assert.equal(r.status,7);assert.equal(r.stdout,'同步 input');assert.equal(r.stderr,'diagnostic');",
      "assert.equal(cp.execFileSync(process.execPath,['-e',\"process.stdout.write('captured')\"],{encoding:'utf8'}),'captured');",
      "const timed=cp.spawnSync(process.execPath,['-e','setTimeout(()=>{},10000)'],{timeout:200});assert.equal(timed.error.code,'ETIMEDOUT');",
      "const capped=cp.spawnSync(process.execPath,['-e',\"process.stdout.write('x'.repeat(65536))\"],{maxBuffer:1024});assert.equal(capped.error.code,'ENOBUFS');",
      "console.log('sync-ok');",
    ].join('');
    const result = await sandbox(root, ['-e', probe]);
    expect(result.stdout.trim()).toBe('sync-ok');
  }, 30_000);

  it('keeps fork messages and advanced serialization on the Node IPC channel', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'worker.cjs'), "process.on('message',m=>{process.send({value:m.value+1n},()=>process.disconnect());});", 'utf8');
    const result = await sandbox(root, ['-e', "const assert=require('node:assert/strict');const child=require('node:child_process').fork('worker.cjs',[],{silent:true,serialization:'advanced'});child.on('error',e=>{throw e});let seen=false;child.on('message',m=>{assert.equal(m.value,42n);seen=true});child.on('close',code=>{assert.equal(code,0);assert.equal(seen,true);console.log('ipc-ok')});child.send({value:41n});"]);
    expect(result.stdout.trim()).toBe('ipc-ok');
  }, 30_000);

  it('reports a missing child executable and closes its allocated streams', async () => {
    const root = await workspace();
    const result = await sandbox(root, ['-e', "const assert=require('node:assert/strict'),cp=require('node:child_process'),path=require('node:path');const missing=path.join(process.cwd(),'does-not-exist.exe');const child=cp.spawn(missing,[]);let failed=false;child.on('error',e=>{assert.equal(e.code,'ENOENT');failed=true});child.on('close',()=>{assert.equal(failed,true);const sync=cp.spawnSync(missing,[]);assert.equal(sync.error.code,'ENOENT');console.log('missing-ok')});"]);
    expect(result.stdout.trim()).toBe('missing-ok');
  }, 30_000);

  it('preserves nested child transport with an explicit environment and handles async cancellation', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'nested.cjs'), "const cp=require('node:child_process');process.stdout.write(cp.execFileSync(process.execPath,['-e',\"process.stdout.write('nested-ok')\"],{env:{},encoding:'utf8'}));", 'utf8');
    const probe = [
      "const assert=require('node:assert/strict'),cp=require('node:child_process');",
      "assert.equal(cp.execFileSync(process.execPath,['nested.cjs'],{env:{},encoding:'utf8'}),'nested-ok');",
      "assert.throws(()=>cp.spawnSync(process.execPath,['-e','1'],{maxBuffer:17*1024*1024}),{code:'ERR_KODO_PIPE_UNSUPPORTED'});",
      "const controller=new AbortController();const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{signal:controller.signal});let aborted=false;",
      "child.on('error',e=>{assert.equal(e.name,'AbortError');aborted=true});child.on('spawn',()=>controller.abort());child.on('close',()=>{assert.equal(aborted,true);console.log('nested-cancel-ok')});",
    ].join('');
    const result = await sandbox(root, ['-e', probe]);
    expect(result.stdout.trim()).toBe('nested-cancel-ok');
  }, 30_000);

  it('runs the Node test runner with its normal child process isolation', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'isolated.test.mjs'), "import { test } from 'node:test'; import { strictEqual } from 'node:assert'; test('isolated addition', () => strictEqual(2 + 3, 5));\n", 'utf8');
    const result = await sandbox(root, ['--test', '--test-reporter=tap', 'isolated.test.mjs']);
    expect(result.stdout).toContain('ok 1 - isolated addition');
    expect(result.stdout).toContain('# fail 0');
  }, 30_000);

  it('runs Vitest with a real fork worker inside AppContainer', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}', 'utf8');
    await writeFile(path.join(root, 'arithmetic.test.js'), "test('vitest addition',()=>expect(2+3).toBe(5));\n", 'utf8');
    await writeFile(path.join(root, 'vitest.config.mjs'), "import os from 'node:os';import path from 'node:path';export default {cacheDir:path.join(os.tmpdir(),'vite-cache'),test:{globals:true,pool:'forks',maxWorkers:1}};\n", 'utf8');
    // Keep the actual node_modules hierarchy: bare ESM package imports resolve
    // through that directory name, not an arbitrarily named resource snapshot.
    const dependencies = path.join(root, 'node_modules');
    await cp(path.resolve('node_modules'), dependencies, { recursive: true });
    const result = await sandbox(root, [path.join(dependencies, 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.config.mjs', '--configLoader=native']);
    expect(result.stdout).toMatch(/1 passed/);
    expect(result.stdout).toContain('arithmetic.test.js');
  }, 90_000);
});
