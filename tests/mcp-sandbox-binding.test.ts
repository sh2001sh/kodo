import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectMcp } from '../src/extensions/mcp.js';
import type { SandboxOptions } from '../src/sandbox/index.js';

const backend = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../src/sandbox/index.js', () => ({ prepareSandboxCommand: backend.prepare }));

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
beforeEach(() => {
  // Protocol/binding test only: native enforcement remains covered by native sandbox suites.
  backend.prepare.mockReset().mockImplementation(async (program: string, args: string[], options: SandboxOptions) => ({ program, args, cwd: options.workspace, env: { ...process.env }, cleanup: async () => {} }));
});
const server = `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line); if(!m.id)return;
const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'ok'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`;
async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-mcp-binding-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return root;
}
async function version(root: string, policy: Partial<SandboxOptions>): Promise<string> {
  const connection = await connectMcp({ id: 'binding', transport: 'stdio', command: process.execPath, args: ['--input-type=module', '-e', server], sandbox: { workspace: root, ...policy }, tools: { echo: { permission: 'read', effect: 'read' } } });
  cleanup.push(() => connection.close());
  return connection.tools[0]!.version!;
}

describe('MCP sandbox policy identity', () => {
  it('pins resource limits and canonicalizes resource property order', async () => {
    const root = await workspace();
    const first = await version(root, { resources: { memoryBytes: 512_000_000, maxProcesses: 10 } });
    expect(await version(root, { resources: { maxProcesses: 10, memoryBytes: 512_000_000 } })).toBe(first);
    expect(await version(root, { resources: { memoryBytes: 256_000_000, maxProcesses: 10 } })).not.toBe(first);
    expect(await version(root, { resources: { memoryBytes: 512_000_000, maxProcesses: 20 } })).not.toBe(first);
    expect(await version(root, {})).not.toBe(first);
  });

  it('pins network endpoint declarations without claiming the current native backend enforces them', async () => {
    const root = await workspace();
    const first = await version(root, { network: 'allow', networkAllowlist: ['api.example.test', 'files.example.test'] });
    expect(await version(root, { network: 'allow', networkAllowlist: ['files.example.test', 'api.example.test'] })).toBe(first);
    expect(await version(root, { network: 'allow', networkAllowlist: ['api.example.test'] })).not.toBe(first);
    expect(await version(root, { network: 'allow' })).not.toBe(first);
    expect(backend.prepare).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({ networkAllowlist: ['api.example.test', 'files.example.test'] }));
  });
});
