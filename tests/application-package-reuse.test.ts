import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { exportPackage } from '../src/packages/archive.js';
import { PackageRegistry } from '../src/packages/registry.js';
import type { PackageDeclaration } from '../src/packages/schema.js';
import { assertRunCapabilities } from '../src/tools/bindings.js';
import { binding, fixture, temp } from './helpers.js';

const probes = vi.hoisted(() => ({ workspaces: [] as string[], stdioStarts: 0, stdioCloses: 0 }));
vi.mock('../src/sandbox/execute.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sandbox/execute.js')>(),
  createSandbox: (options: { workspace: string }) => ({ run: async (_program: string, _args: string[], invocation: { stdin?: string }) => {
    probes.workspaces.push(options.workspace);
    const input = JSON.parse(invocation.stdin ?? '{}') as { context?: { workspace: string } };
    return { stdout: JSON.stringify({ protocol: 'kodo-tool-result/v1', result: { workspace: input.context?.workspace } }), stderr: '', exitCode: 0, cancelled: false, truncated: false, outputLimitExceeded: false };
  } }),
}));
vi.mock('../src/extensions/mcp.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/extensions/mcp.js')>();
  return { ...original, connectMcp: async (config: Parameters<typeof original.connectMcp>[0], options?: Parameters<typeof original.connectMcp>[1]) => {
    if (config.transport !== 'stdio') return original.connectMcp(config, options);
    probes.stdioStarts++;
    return { tools: Object.entries(config.tools).map(([name, policy]) => ({ name: `mcp.${config.id}.${name}`, description: 'Synthetic stdio fixture', permission: policy.permission, effect: policy.effect, parameters: { type: 'object' }, version: 'isolated-stdio-fixture', execute: () => ({ fixture: true }) })), close: async () => { probes.stdioCloses++; } };
  } };
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  probes.workspaces.length = 0; probes.stdioStarts = 0; probes.stdioCloses = 0;
});
async function install(options: { skill?: boolean; mcp?: 'http' | 'stdio'; examples?: boolean; version?: string } = {}) {
  const source = temp(), registry = new PackageRegistry(temp()), files = ['AGENT.md', 'tool.json', 'tool.mjs'];
  const tools = ['custom.fixture', ...(options.skill ? ['skill.list', 'skill.load'] : []), ...(options.mcp ? ['mcp.remote.echo'] : [])];
  await writeFile(path.join(source, 'AGENT.md'), `---\nschema_version: 1\nid: example/reusable\nversion: ${options.version ?? '1.0.0'}\nname: Reusable fixture\ndescription: Exercise bounded package reuse.\ncapabilities:\n  tools: ${JSON.stringify(tools)}\n${options.skill ? '  skills: [fixture]\n' : ''}---\nInspect supplied fixture material.`);
  await writeFile(path.join(source, 'tool.json'), JSON.stringify({ format: 'kodo-tool/v1', name: 'custom.fixture', description: 'Synthetic package read fixture', permission: 'read', effect: 'read', parameters: { type: 'object' } }));
  await writeFile(path.join(source, 'tool.mjs'), 'export default (_args, context) => ({workspace:context.workspace});');
  const resources: NonNullable<PackageDeclaration['resources']> = { tools: [{ name: 'custom.fixture', entry: 'tool.mjs', descriptor: 'tool.json' }] };
  if (options.skill) { files.push('SKILL.md'); await writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture\ndescription: Inspect the synthetic fixture.\n---\nRead the supplied fixture material.'); resources.skills = [{ id: 'fixture', entry: 'SKILL.md' }]; }
  if (options.mcp === 'http') resources.mcp = [{ id: 'remote', transport: 'http', url: 'https://example.test/template', tools: { echo: { permission: 'read', effect: 'read' } } }];
  if (options.mcp === 'stdio') { files.push('server.mjs'); await writeFile(path.join(source, 'server.mjs'), '// Isolated synthetic transport fixture.'); resources.mcp = [{ id: 'remote', transport: 'stdio', entry: 'server.mjs', tools: { echo: { permission: 'read', effect: 'read' } } }]; }
  const archive = path.join(source, 'agent.zip');
  await exportPackage(source, { schema_version: 1, source: { url: 'https://example.test/reusable' }, license: 'MIT', resources, files: files.map(file => ({ path: file, distributable: true })), ...(options.examples ? { examples: [{ name: 'explicit fixture verification', input: 'Inspect the fixture.' }] } : {}) }, archive);
  return { registry, installed: await registry.import(archive) };
}

describe('exact package activation reuse within one Application', () => {
  it('reuses unchanged tools and Skills across workspaces while preserving old run contracts', async () => {
    const { app } = fixture(); const { installed } = await install({ skill: true });
    const first = temp(), second = temp();
    const card = await app.activatePackage(installed, { workspace: first });
    const original = app.createRun({ objective: 'Inspect the first fixture.', workspace: first, binding, card });
    const pins = original.toolBindings;
    await app.activatePackage(installed, { workspace: second });
    const next = app.createRun({ objective: 'Inspect the second fixture.', workspace: second, binding, card });
    const signal = new AbortController().signal;
    expect(await app.coordinator.tools.execute(original.id, 'custom.fixture', {}, signal, () => {})).toEqual({ workspace: first });
    expect(await app.coordinator.tools.execute(next.id, 'custom.fixture', {}, signal, () => {})).toEqual({ workspace: second });
    expect(probes.workspaces).toEqual([first, second]);
    expect(await app.coordinator.tools.execute(next.id, 'skill.load', { id: 'fixture' }, signal, () => {})).toMatchObject({ id: 'fixture' });
    expect(original.toolBindings).toEqual(pins);
    expect(next.toolBindings).toEqual(pins);
    expect(() => assertRunCapabilities(original, app.coordinator.tools)).not.toThrow();
  });

  it('rechecks explicit examples on every activation and refuses changed execution configuration', async () => {
    const { app } = fixture(); const { installed } = await install({ examples: true });
    const verifyExamples = vi.fn(async () => ({ passed: true, evidence: 'Isolated fixture verification.' }));
    const first = temp();
    await app.activatePackage(installed, { workspace: first, verifyExamples });
    await app.activatePackage(installed, { workspace: temp(), verifyExamples });
    expect(verifyExamples).toHaveBeenCalledTimes(2);
    await expect(app.activatePackage(installed, { workspace: first, resources: { maxProcesses: 3 }, verifyExamples })).rejects.toThrow('另一组宿主配置');
    await expect(app.activatePackage(installed, { workspace: first, verifyExamples: async () => ({ passed: false, evidence: 'Fixture failed.' }) })).rejects.toThrow('did not pass');
  });

  it('keeps one HTTP MCP connection for the identical package binding', async () => {
    const { app } = fixture(); const { installed } = await install({ mcp: 'http' });
    let initializations = 0;
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += String(chunk);
      if (!body) { response.writeHead(204); response.end(); return; }
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      response.setHeader('content-type', 'application/json');
      if (message.method === 'initialize') initializations++;
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : message.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'fixture' }] } }));
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture missing address');
    const bindings = { mcp: { remote: { url: `http://127.0.0.1:${address.port}/mcp` } } };
    await app.activatePackage(installed, { workspace: temp(), bindings });
    const workspace = temp(), card = await app.activatePackage(installed, { workspace, bindings });
    const run = app.createRun({ objective: 'Read the remote fixture.', workspace, card, binding });
    expect(await app.coordinator.tools.execute(run.id, 'mcp.remote.echo', {}, new AbortController().signal, () => {})).toMatchObject({ content: [{ text: 'fixture' }] });
    expect(initializations).toBe(1);
  });

  it('reports the fixed stdio workspace and retains the original registration', async () => {
    const { app } = fixture(); const { installed } = await install({ mcp: 'stdio' });
    const workspace = temp(), stdio = { write: false, network: 'none' as const };
    const card = await app.activatePackage(installed, { workspace, stdio });
    const run = app.createRun({ objective: 'Inspect the stdio fixture.', workspace, binding, card });
    await app.activatePackage(installed, { workspace, stdio });
    await expect(app.activatePackage(installed, { workspace: temp(), stdio })).rejects.toThrow('stdio MCP 已绑定原工作区');
    expect(probes.stdioStarts).toBe(1);
    expect(probes.stdioCloses).toBe(0);
    expect(() => assertRunCapabilities(run, app.coordinator.tools)).not.toThrow();
  });
});
