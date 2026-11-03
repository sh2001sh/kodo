import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportPackage } from '../src/packages/archive.js';
import { PackageRegistry } from '../src/packages/registry.js';
import { activatePackage } from '../src/packages/runtime.js';
import type { PackageHost } from '../src/packages/runtime.js';
import type { McpConfig, McpConnection } from '../src/extensions/mcp.js';
import { connectMcp } from '../src/extensions/mcp.js';
import type { ToolExecutionContext, ToolRegistration } from '../src/tools/registry.js';
import type { SandboxResources } from '../src/sandbox/index.js';
import { Application } from '../src/application/index.js';

const roots: string[] = [];
const connections: McpConnection[] = [];
const applications: Application[] = [];
afterEach(async () => {
  for (const app of applications.splice(0)) await app.shutdown();
  for (const connection of connections.splice(0)) await connection.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function directory(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-package-quota-')); roots.push(root); return root; }
const implementation = `import {spawnSync} from 'node:child_process';
export default args=>{
 if(args.kind==='allocate'){const values=[];for(let i=0;i<64;i++)values.push(Buffer.alloc(16*1024*1024,1));return {allocated:true};}
 if(args.kind==='spawn'){const child=spawnSync(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'});return {denied:!!child.error,status:child.status};}
 return {ready:true};
};`;
async function fixture(examples = false) {
  const source = await directory();
  await writeFile(path.join(source, 'AGENT.md'), '---\nschema_version: 1\nid: example/quota\nversion: 1.0.0\nname: Quota probe\ndescription: Verify native capability resource ceilings\ncapabilities:\n  tools: [custom.quota, mcp.quota.probe]\n---\nCheck sandbox resource constraints.\n', 'utf8');
  await writeFile(path.join(source, 'tool.json'), JSON.stringify({ format: 'kodo-tool/v1', name: 'custom.quota', description: 'Probe resource limits', parameters: { type: 'object', properties: { kind: { type: 'string' } } }, permission: 'read', effect: 'read' }), 'utf8');
  await writeFile(path.join(source, 'tool.mjs'), implementation, 'utf8');
  await writeFile(path.join(source, 'server.mjs'), `import {createInterface} from 'node:readline';import probe from './tool.mjs';
createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(!message.id)return;
const result=message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:message.method==='tools/list'?{tools:[{name:'probe',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify(probe(message.params.arguments))}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');});`, 'utf8');
  const archive = path.join(await directory(), 'quota.zip');
  await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.test/quota' }, files: ['AGENT.md', 'tool.json', 'tool.mjs', 'server.mjs'].map(file => ({ path: file, distributable: true })), ...(examples ? { examples: [{ name: 'host-checked fixture', input: 'Verify resource probe results' }] } : {}), resources: { tools: [{ name: 'custom.quota', descriptor: 'tool.json', entry: 'tool.mjs' }], mcp: [{ id: 'quota', transport: 'stdio', entry: 'server.mjs', files: ['tool.mjs'], tools: { probe: { permission: 'read', effect: 'read' } } }] } }, archive);
  const registry = new PackageRegistry(await directory());
  return { registry, installed: await registry.import(archive), workspace: await directory() };
}
function host(native = false): PackageHost & { tools: ToolRegistration[]; configurations: McpConfig[] } {
  const tools: ToolRegistration[] = []; const configurations: McpConfig[] = [];
  return { tools, configurations, registerTool(tool) { tools.push(tool); }, registerSkills() {}, registerCard() {}, async connectMcp(config) {
    configurations.push(config);
    if (native) { const connection = await connectMcp(config); connections.push(connection); tools.push(...connection.tools); }
  } };
}
function context(workspace: string): ToolExecutionContext {
  return { run: { id: 'quota-run', permissions: ['read'] }, session: { id: 'quota-session', workspace, permissions: ['read'] }, signal: AbortSignal.timeout(30000), markEffectStarted() {} } as ToolExecutionContext;
}
async function invoke(destination: ReturnType<typeof host>, workspace: string, name: string, kind: string): Promise<unknown> {
  const value = await destination.tools.find(tool => tool.name === name)!.execute(context(workspace), { kind });
  return name.startsWith('mcp.') ? JSON.parse((value as { content: { text: string }[] }).content[0]!.text) : value;
}

describe('capability package resource policy', () => {
  it('retains quotas for stdio servers, pins custom-tool identities, and freezes caller declarations', async () => {
    const { installed, workspace } = await fixture();
    const resources = { maxProcesses: 1 };
    const first = host(); await activatePackage(first, installed, { workspace, stdio: { write: false, resources } });
    resources.maxProcesses = 2;
    expect(first.configurations[0]).toMatchObject({ transport: 'stdio', sandbox: { resources: { maxProcesses: 1 } } });
    const second = host(); await activatePackage(second, installed, { workspace, stdio: { resources } });
    expect(first.tools[0]!.version).not.toBe(second.tools[0]!.version);
  });
  it('rejects invalid quotas and unsupported network allowlists before any package registration', async () => {
    const { installed, workspace } = await fixture();
    for (const stdio of [{ resources: { maxProcesses: 0 } }, { networkAllowlist: ['example.test:443'] }]) {
      const destination = host();
      await expect(activatePackage(destination, installed, { workspace, stdio })).rejects.toThrow();
      expect(destination.tools).toEqual([]); expect(destination.configurations).toEqual([]);
    }
  });
  it('tightens global ceilings without turning resource inheritance into stdio authorization', async () => {
    const { installed, workspace } = await fixture();
    const missing = host();
    await expect(activatePackage(missing, installed, { workspace, resources: { maxProcesses: 1 } })).rejects.toThrow('explicit host sandbox authorization');
    expect(missing.configurations).toEqual([]);
    const bounded = host();
    await activatePackage(bounded, installed, { workspace, resources: { maxProcesses: 1 }, stdio: { resources: { maxProcesses: 10 } } });
    expect(bounded.configurations[0]).toMatchObject({ sandbox: { resources: { maxProcesses: 1 } } });
  });
  it('pins reusable example evidence to actual host ceilings before Application-style activation', async () => {
    const { registry, installed, workspace } = await fixture(true);
    const id = installed.card.id; const version = installed.card.version;
    const original = { ...host(), packageResources: { maxProcesses: 2 } };
    await registry.activate(original, id, version, { workspace, stdio: { write: false }, verifyExamples: () => ({ passed: true, evidence: 'Host verified under process ceiling two' }) });
    await expect(registry.activate({ ...host(), packageResources: { maxProcesses: 2 } }, id, version, { workspace, stdio: { write: false }, reuseVerification: true })).resolves.toMatchObject({ id });
    const tightened = { ...host(), packageResources: { maxProcesses: 1 } };
    await expect(registry.activate(tightened, id, version, { workspace, resources: { maxProcesses: 10 }, stdio: { write: false }, reuseVerification: true })).rejects.toThrow('verification is missing or changed');
    expect(tightened.configurations).toEqual([]);
    await registry.activate(tightened, id, version, { workspace, resources: { maxProcesses: 10 }, stdio: { write: false }, verifyExamples: () => ({ passed: true, evidence: 'Reverified under tightened host ceiling one' }) });
    expect(tightened.configurations[0]).toMatchObject({ sandbox: { resources: { maxProcesses: 1 } } });
  });
});

describe.skipIf(process.platform !== 'win32')('real Windows capability package quotas', () => {
  it('inherits real Application ceilings and rejects reuse after the root policy changes', async () => {
    const { registry, installed, workspace } = await fixture(true); const data = await directory();
    const app = new Application(data, undefined, undefined, { sandbox: { network: 'none', resources: { maxProcesses: 1, memoryBytes: 384 * 1024 * 1024 } } });
    applications.push(app);
    const detached = app.packageResources!; detached.maxProcesses = 50;
    expect(app.packageResources!.maxProcesses).toBe(1);
    const card = await registry.activate(app, installed.card.id, installed.card.version, {
      workspace, resources: { maxProcesses: 20 }, stdio: { write: false, resources: { maxProcesses: 10 } },
      verifyExamples: async ({ tools }) => {
        const result = await tools[0]!.execute(context(workspace), { kind: 'spawn' });
        return { passed: JSON.stringify(result) === JSON.stringify({ denied: true, status: null }), evidence: 'Actual custom-tool child denied under inherited one-process Application ceiling' };
      },
    });
    const run = app.createRun({ objective: 'Verify inherited package quotas', workspace, card, permissions: ['read'], binding: { model: 'quota-fixture', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_QUOTA_UNUSED', limits: { context: 16000, output: 1000 } } });
    for (const name of ['custom.quota', 'mcp.quota.probe']) {
      const value = await app.coordinator.tools.execute(run.id, name, { kind: 'spawn' }, AbortSignal.timeout(30000));
      const result = name.startsWith('mcp.') ? JSON.parse((value as { content: { text: string }[] }).content[0]!.text) : value;
      expect(result).toEqual({ denied: true, status: null });
    }
    await app.shutdown(); applications.splice(applications.indexOf(app), 1);
    const changed = new Application(data, undefined, undefined, { sandbox: { network: 'none', resources: { maxProcesses: 2, memoryBytes: 384 * 1024 * 1024 } } });
    applications.push(changed);
    await expect(registry.activate(changed, installed.card.id, installed.card.version, { workspace, resources: { maxProcesses: 20 }, stdio: { write: false, resources: { maxProcesses: 10 } }, reuseVerification: true })).rejects.toThrow('verification is missing or changed');
  }, 60000);
  it('allows a second process with quota two and denies it with quota one for custom tools and MCP', async () => {
    const { installed, workspace } = await fixture();
    for (const maxProcesses of [2, 1]) {
      const destination = host(true);
      await activatePackage(destination, installed, { workspace, resources: { maxProcesses, memoryBytes: 384 * 1024 * 1024 }, stdio: { write: false, network: 'none', resources: { maxProcesses: 10, memoryBytes: 1024 * 1024 * 1024 } } });
      for (const name of ['custom.quota', 'mcp.quota.probe']) {
        expect(await invoke(destination, workspace, name, 'ready')).toEqual({ ready: true });
        expect(await invoke(destination, workspace, name, 'spawn')).toEqual(maxProcesses === 2 ? { denied: false, status: 0 } : { denied: true, status: null });
      }
    }
  }, 60000);
  it('allows normal workers but fails excess memory allocations for both package execution paths', async () => {
    const { installed, workspace } = await fixture();
    const destination = host(true); const resources: SandboxResources = { memoryBytes: 384 * 1024 * 1024 };
    await activatePackage(destination, installed, { workspace, resources, stdio: { write: false } });
    for (const name of ['custom.quota', 'mcp.quota.probe']) expect(await invoke(destination, workspace, name, 'ready')).toEqual({ ready: true });
    await expect(invoke(destination, workspace, 'custom.quota', 'allocate')).rejects.toThrow('sandboxed tool execution failed');
    await expect(invoke(destination, workspace, 'mcp.quota.probe', 'allocate')).rejects.toThrow(/MCP process exited|MCP process input closed/);
  }, 60000);
});
