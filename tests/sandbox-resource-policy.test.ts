import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSandbox } from '../src/sandbox/execute.js';
import { prepareSandboxCommand } from '../src/sandbox/index.js';
import { validateSandboxResources } from '../src/sandbox/policy.js';

const roots: string[] = [];
async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-resource-test-'));
  roots.push(root); return root;
}
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('sandbox resource policy', () => {
  it('rejects invalid and unknown ceilings before executing a payload', async () => {
    const root = await workspace();
    for (const resources of [null, [], { cpu: 2 }, { memoryBytes: 0 }, { memoryBytes: -1 }, { memoryBytes: 1.5 }, { memoryBytes: Number.MAX_SAFE_INTEGER + 1 }, { maxProcesses: '3' }, { maxProcesses: 0x100000000 }]) {
      await expect(prepareSandboxCommand(process.execPath, ['-e', 'throw Error("must not execute")'], { workspace: root, resources } as never)).rejects.toMatchObject({ code: 'SANDBOX_CONFIG' });
    }
  });
  it('fails closed for endpoint allowlists instead of silently permitting child sockets', async () => {
    const root = await workspace();
    for (const network of ['none', 'allow'] as const) await expect(prepareSandboxCommand(process.execPath, [], { workspace: root, network, networkAllowlist: ['example.com:443'] })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    await expect(prepareSandboxCommand(process.execPath, [], { workspace: root, networkAllowlist: [3] } as never)).rejects.toMatchObject({ code: 'SANDBOX_CONFIG' });
  });
  it('rejects unsupported macOS quotas and accepts only its enforced no-fork ceiling', () => {
    expect(() => validateSandboxResources({ memoryBytes: 1024 }, 'darwin')).toThrow('different backend');
    expect(() => validateSandboxResources({ maxProcesses: 2 }, 'darwin')).toThrow('different backend');
    expect(() => validateSandboxResources({ maxProcesses: 1 }, 'darwin')).not.toThrow();
  });
});

describe.skipIf(process.platform !== 'win32')('native Windows resource ceilings', () => {
  it('allows normal execution but denies another child in a one-process job', async () => {
    const root = await workspace();
    const script = `const r=require('node:child_process').spawnSync(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'});console.log(JSON.stringify({error:r.error?.code,status:r.status}))`;
    const control = await createSandbox({ workspace: root, scope: { read: ['.'], write: [] }, resources: { maxProcesses: 2, memoryBytes: 384 * 1024 * 1024 } }).run(process.execPath, ['-e', script], { signal: AbortSignal.timeout(15000) });
    expect(control.exitCode, JSON.stringify(control)).toBe(0);
    expect(JSON.parse(control.stdout), JSON.stringify(control)).toEqual({ status: 0 });
    const sandbox = createSandbox({ workspace: root, scope: { read: ['.'], write: [] }, resources: { maxProcesses: 1, memoryBytes: 384 * 1024 * 1024 } });
    const result = await sandbox.run(process.execPath, ['-e', script], { signal: AbortSignal.timeout(15000) });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(JSON.parse(result.stdout), JSON.stringify(result)).toMatchObject({ error: expect.any(String), status: null });
    expect(result.cancelled).toBeFalsy();
  }, 40000);
  it('rejects allocations above aggregate committed job memory without waiting for cancellation', async () => {
    const sandbox = createSandbox({ workspace: await workspace(), scope: { read: [], write: [] }, resources: { memoryBytes: 384 * 1024 * 1024 } });
    const control = await sandbox.run(process.execPath, ['-e', 'console.log("READY")'], { signal: AbortSignal.timeout(30000) });
    expect(control.exitCode, control.stderr).toBe(0);
    expect(control.stdout.trim()).toBe('READY');
    const over = await sandbox.run(process.execPath, ['-e', 'const a=[];for(let i=0;i<64;i++)a.push(Buffer.alloc(16*1024*1024,1));console.log("ESCAPED")'], { signal: AbortSignal.timeout(30000) });
    expect(over.exitCode).not.toBe(0);
    expect(over.cancelled).toBeFalsy();
    expect(over.stdout).not.toContain('ESCAPED');
  }, 70000);
});
