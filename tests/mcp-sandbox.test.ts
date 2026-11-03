import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SandboxOptions } from '../src/sandbox/index.js';
import type { ToolExecutionContext } from '../src/tools/registry.js';
import type { FileScope, Permission } from '../src/runtime/types.js';
import { connectMcp } from '../src/extensions/mcp.js';

const prepared = vi.hoisted(() => ({ prepare: vi.fn(), cleanup: vi.fn() }));
vi.mock('../src/sandbox/index.js', () => ({ prepareSandboxCommand: prepared.prepare }));

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
beforeEach(() => {
  prepared.cleanup.mockReset().mockResolvedValue(undefined);
  // Transport tests use a real child but substitute the backend deliberately.
  // Native containment is verified separately; this suite checks integration.
  prepared.prepare.mockReset().mockImplementation(async (program: string, args: string[], options: SandboxOptions & { cwd?: string; env?: NodeJS.ProcessEnv }) => ({ program, args, cwd: options.cwd ?? options.workspace, env: { ...process.env, ...options.env }, cleanup: prepared.cleanup }));
});
async function fixture(): Promise<{ workspace: string; server: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodo-mcp-sandbox-'));
  cleanup.push(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, 'src'));
  const server = path.join(workspace, 'server.mjs');
  await writeFile(server, `import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line', line=>{
const m=JSON.parse(line);if(!m.id)return;
let result;
if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}}};
else if(m.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};
else if(m.params.arguments.wait){writeFileSync('started','yes');setTimeout(()=>writeFileSync('late','escaped'),3000);return;}
else result={content:[{type:'text',text:'ok'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
  return { workspace, server };
}
function context(workspace: string, scope?: FileScope, permissions: Permission[] = ['read', 'write', 'exec'], signal = new AbortController().signal): ToolExecutionContext {
  return { run: { scope }, session: { workspace, permissions }, signal, markEffectStarted() {} } as unknown as ToolExecutionContext;
}
async function connection(workspace: string, server: string, sandbox: Partial<SandboxOptions> = {}) {
  const result = await connectMcp({ id: 'contained', transport: 'stdio', command: process.execPath, args: [server], sandbox: { workspace, ...sandbox }, tools: { echo: { permission: 'read', effect: 'read' } } });
  cleanup.push(() => result.close());
  return result;
}

describe('MCP sandbox integration', () => {
  it('prepares before spawn and refuses a run narrower than the persistent server', async () => {
    const { workspace, server } = await fixture();
    const result = await connection(workspace, server);
    expect(prepared.prepare).toHaveBeenCalledWith(process.execPath, [server], expect.objectContaining({ workspace, env: {} }));
    await expect(result.tools[0]!.execute(context(workspace, { read: ['src'] }), {})).rejects.toThrow('grants exceed');
    await expect(result.tools[0]!.execute(context(workspace, {}, []), {})).rejects.toThrow('read permission');
    await expect(result.tools[0]!.execute(context(path.join(workspace, 'src')), {})).rejects.toThrow('another workspace');
    await expect(result.tools[0]!.execute(context(workspace), {})).resolves.toMatchObject({ content: [{ text: 'ok' }] });
    await result.close();
    expect(prepared.cleanup).toHaveBeenCalledTimes(1);
  });

  it('allows narrower server grants but checks every actual writable root and permission', async () => {
    const { workspace, server } = await fixture();
    const result = await connection(workspace, server, { scope: { read: ['src'], write: ['src'] }, write: true });
    await expect(result.tools[0]!.execute(context(workspace, { read: ['src'], write: ['src'] }), {})).resolves.toBeTruthy();
    await expect(result.tools[0]!.execute(context(workspace, { read: ['src'], write: [] }), {})).rejects.toThrow('grants exceed');
    await expect(result.tools[0]!.execute(context(workspace, undefined, ['read', 'exec']), {})).rejects.toThrow('write permission');
    await expect(result.tools[0]!.execute(context(workspace, { read: [], write: ['src'] }), {})).rejects.toThrow('grants exceed');
  });

  it('pins sandbox grants and prevents host mutation after connecting', async () => {
    const { workspace, server } = await fixture();
    const config = { workspace, scope: { read: ['src'] }, network: 'none' as const };
    const first = await connection(workspace, server, config);
    config.scope.read[0] = '.';
    await expect(first.tools[0]!.execute(context(workspace, { read: ['src'] }), {})).resolves.toBeTruthy();
    const second = await connection(workspace, server, config);
    const third = await connection(workspace, server, { network: 'allow' });
    expect(first.tools[0]!.version).not.toBe(second.tools[0]!.version);
    expect(second.tools[0]!.version).not.toBe(third.tools[0]!.version);
  });

  it('never falls back after sandbox preparation fails', async () => {
    const { workspace, server } = await fixture();
    prepared.prepare.mockRejectedValueOnce(new Error('backend unavailable'));
    await expect(connection(workspace, server)).rejects.toThrow('backend unavailable');
    expect(prepared.cleanup).not.toHaveBeenCalled();
  });

  it('cleans prepared isolation after spawn or protocol initialization fails', async () => {
    const { workspace, server } = await fixture();
    prepared.prepare.mockImplementationOnce(async () => ({ program: path.join(workspace, 'missing.exe'), args: [], cwd: workspace, env: {}, cleanup: prepared.cleanup }));
    await expect(connection(workspace, server)).rejects.toThrow('could not be started');
    expect(prepared.cleanup).toHaveBeenCalledTimes(1);
    await writeFile(server, `process.stdin.once('data',()=>process.stdout.write('invalid\\n'));`);
    await expect(connection(workspace, server)).rejects.toThrow('invalid MCP process JSON');
    expect(prepared.cleanup).toHaveBeenCalledTimes(2);
  });

  it('kills a cancelled sandboxed server before reporting completion and awaits cleanup', async () => {
    const { workspace, server } = await fixture();
    const result = await connection(workspace, server);
    const controller = new AbortController();
    const pending = result.tools[0]!.execute(context(workspace, undefined, undefined, controller.signal), { wait: true });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await readFile(path.join(workspace, 'started'), 'utf8').catch(() => '') === 'yes') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await readFile(path.join(workspace, 'started'), 'utf8')).toBe('yes');
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(prepared.cleanup).toHaveBeenCalledTimes(1);
    // Outlast the server's late write by a margin that tree termination under load cannot erase.
    await new Promise(resolve => setTimeout(resolve, 3100));
    await expect(readFile(path.join(workspace, 'late'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces cleanup errors on close instead of losing them in an event handler', async () => {
    const { workspace, server } = await fixture();
    const result = await connection(workspace, server);
    cleanup.pop();
    prepared.cleanup.mockRejectedValueOnce(new Error('restore refused'));
    await expect(result.close()).rejects.toThrow('sandbox cleanup failed');
    await expect(result.close()).rejects.toThrow('sandbox cleanup failed');
  });

  it('keeps cleanup errors visible when request cancellation also occurs', async () => {
    const { workspace, server } = await fixture();
    const result = await connection(workspace, server);
    cleanup.pop();
    prepared.cleanup.mockRejectedValueOnce(new Error('restore refused'));
    const controller = new AbortController();
    const pending = result.tools[0]!.execute(context(workspace, undefined, undefined, controller.signal), { wait: true });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await readFile(path.join(workspace, 'started'), 'utf8').catch(() => '') === 'yes') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'MCP_CLEANUP' });
    await expect(result.close()).rejects.toThrow('sandbox cleanup failed');
  });
});
