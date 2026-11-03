import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Application, PackageRegistry, exportPackage } from '../src/application/index.js';
import type { PackageDeclaration, SandboxPolicy } from '../src/application/index.js';
import { digest } from '../src/storage/index.js';
import { assertRunCapabilities } from '../src/tools/bindings.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

const applications: Application[] = [];
const servers: Server[] = [];
afterEach(async () => {
  while (applications.length) await applications.pop()!.shutdown();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
const application = (root = temp()): Application => { const app = new Application(path.join(root, 'private-state'), scripted(calls(call('skill.load', { id: 'first' })), answer())); applications.push(app); return app; };
async function fixture(options: { id?: string; tools?: string[]; skill?: string; mcp?: NonNullable<PackageDeclaration['resources']>['mcp']; examples?: PackageDeclaration['examples'] } = {}) {
  const source = temp(); const registry = new PackageRegistry(temp()); const files = ['AGENT.md'];
  const toolNames = options.tools ?? ['custom.first'];
  const cardTools = [...toolNames, ...(options.skill ? ['skill.list', 'skill.load'] : []), ...(options.mcp ?? []).flatMap(server => Object.keys(server.tools).map(name => `mcp.${server.id}.${name}`))];
  const card = `---\nschema_version: 1\nid: ${options.id ?? 'example/first'}\nversion: 1.0.0\nname: Package test\ndescription: Transactional package fixture\ncapabilities:\n  tools: [${cardTools.join(', ')}]\n${options.skill ? `  skills: [${options.skill}]\n` : ''}---\nUse the approved package resources.\n`;
  await writeFile(path.join(source, 'AGENT.md'), card);
  const tools = [];
  for (const [index, name] of toolNames.entries()) {
    const descriptor = `tool${index}.json`; const entry = `tool${index}.mjs`; files.push(descriptor, entry);
    await writeFile(path.join(source, descriptor), JSON.stringify({ format: 'kodo-tool/v1', name, description: 'Fixture read tool', permission: 'read', effect: 'read', parameters: { type: 'object' } }));
    await writeFile(path.join(source, entry), 'export default () => ({ok:true});');
    tools.push({ name, descriptor, entry });
  }
  if (options.skill) { files.push('SKILL.md'); await writeFile(path.join(source, 'SKILL.md'), `---\nname: ${options.skill}\ndescription: Review ${options.skill} evidence\n---\nRead original ${options.skill} evidence.\n`); }
  const archive = path.join(temp(), 'fixture.zip');
  await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.com/fixture' }, files: files.map(file => ({ path: file, distributable: true })), resources: { tools, ...(options.skill ? { skills: [{ id: options.skill, entry: 'SKILL.md' }] } : {}), ...(options.mcp ? { mcp: options.mcp } : {}) }, ...(options.examples ? { examples: options.examples } : {}) }, archive);
  return { registry, installed: await registry.import(archive) };
}

describe('transactional application package activation', () => {
  it('activates multiple packages while preserving existing per-card skill contracts', async () => {
    const first = await fixture({ skill: 'first' });
    const second = await fixture({ id: 'example/second', tools: ['custom.second'], skill: 'second' });
    const workspace = temp(); const app = application();
    const card = await first.registry.activate(app, 'example/first', '1.0.0', { workspace });
    const run = app.createRun({ objective: 'Load approved evidence.', workspace, card, binding });
    const before = app.coordinator.tools.bindingSnapshot(card.tools, card.skills);
    await app.activatePackage(second.installed, { workspace });
    expect(app.coordinator.tools.bindingSnapshot(card.tools, card.skills)).toEqual(before);
    expect(() => assertRunCapabilities(run, app.coordinator.tools)).not.toThrow();
    expect((await app.run(run.id)).status).toBe('completed');
    const load = app.calls(run.id).items.find(item => item.name === 'skill.load')!;
    expect(app.store.readBlob(load.resultRef!)).toMatchObject({ id: 'first', content: expect.stringContaining('original first evidence') });
    expect(app.store.card('example/second', '1.0.0').skills).toEqual(['second']);
  });

  it('refuses changed restored skills while allowing unrelated catalog additions', async () => {
    const root = temp(); const workspace = temp(); const first = await fixture({ skill: 'first' });
    const app = application(root); const card = await app.activatePackage(first.installed, { workspace });
    const run = app.createRun({ objective: 'Read the approved skill.', workspace, card, binding });
    await app.shutdown(); applications.splice(applications.indexOf(app), 1);
    const reopened = application(root);
    reopened.registerTool({ name: 'custom.first', description: 'Fixture read tool', permission: 'read', effect: 'read', parameters: { type: 'object' }, version: digest(`${first.installed.digest}:`), execute: () => ({ ok: true }) });
    const content = 'Changed instructions.';
    reopened.registerSkills([{ id: 'first', description: 'Review first evidence', content, digest: digest(content) }]);
    expect(() => assertRunCapabilities(reopened.store.run(run.id), reopened.coordinator.tools)).toThrow('pinned host contract');
  });

  it('leaves no tool, skill or card from a package whose later tool collides', async () => {
    const { installed } = await fixture({ tools: ['custom.fresh', 'custom.colliding'], skill: 'first', examples: [{ name: 'example', input: 'Inspect evidence' }] });
    const app = application();
    app.registerTool({ name: 'custom.colliding', description: 'Existing host capability', permission: 'read', effect: 'read', parameters: { type: 'object' }, execute: () => null });
    let verified = false;
    await expect(app.activatePackage(installed, { workspace: temp(), verifyExamples: () => { verified = true; return { passed: true, evidence: 'fixture' }; } })).rejects.toThrow('collid');
    expect(verified).toBe(false);
    expect(app.coordinator.tools.isRegistered('custom.fresh')).toBe(false);
    expect(app.coordinator.tools.isRegistered('skill.load')).toBe(false);
    expect(() => app.store.card(installed.card.id, installed.card.version)).toThrow('not registered');
  });

  it('checks persisted card identity before installing any package capability', async () => {
    const { installed } = await fixture({ skill: 'first' }); const app = application();
    app.store.registerCard({ ...installed.card, digest: 'a'.repeat(64) });
    await expect(app.activatePackage(installed, { workspace: temp() })).rejects.toThrow('different content');
    expect(app.coordinator.tools.isRegistered('custom.first')).toBe(false);
    expect(app.coordinator.tools.isRegistered('skill.list')).toBe(false);
  });

  it('keeps existing resources intact when a second package reuses an immutable skill ID', async () => {
    const first = await fixture({ skill: 'first' }); const second = await fixture({ id: 'example/second', tools: ['custom.second'], skill: 'first' });
    const app = application(); const workspace = temp(); await app.activatePackage(first.installed, { workspace });
    const before = app.coordinator.tools.bindingSnapshot(first.installed.card.tools, first.installed.card.skills);
    await expect(app.activatePackage(second.installed, { workspace })).rejects.toThrow('once');
    expect(app.coordinator.tools.isRegistered('custom.second')).toBe(false);
    expect(app.coordinator.tools.bindingSnapshot(first.installed.card.tools, first.installed.card.skills)).toEqual(before);
  });

  it('closes previously staged MCP connections when a later server fails', async () => {
    let deleted = false;
    const server = createServer(async (request, response) => {
      if (request.method === 'DELETE') { deleted = true; response.writeHead(204); response.end(); return; }
      if (request.url === '/bad') { response.writeHead(500); response.end('fixture failed'); return; }
      let body = ''; for await (const chunk of request) body += String(chunk);
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.method.startsWith('notifications/')) { response.writeHead(202); response.end(); return; }
      response.setHeader('Mcp-Session-Id', 'staged-session'); response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} } } : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } }));
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
    const base = `http://127.0.0.1:${address.port}`;
    const resources = ['one', 'two'].map(id => ({ id, transport: 'http' as const, url: 'https://template.example/mcp', tools: { echo: { permission: 'read' as const, effect: 'read' as const } } }));
    const { installed } = await fixture({ skill: 'first', mcp: resources }); const app = application();
    await expect(app.activatePackage(installed, { workspace: temp(), bindings: { mcp: { one: { url: `${base}/good` }, two: { url: `${base}/bad` } } } })).rejects.toThrow();
    expect(deleted).toBe(true);
    for (const name of ['mcp.one.echo', 'mcp.two.echo', 'custom.first', 'skill.load']) expect(app.coordinator.tools.isRegistered(name)).toBe(false);
    expect(() => app.store.card(installed.card.id, installed.card.version)).toThrow('not registered');
  });
});

describe('host sandbox contract persistence', () => {
  it('pins sandbox presence and network policy across application restarts', async () => {
    const root = temp(); const workspace = temp(); const directory = path.join(root, 'data');
    const app = new Application(directory, scripted(), undefined, { sandbox: {} });
    applications.push(app);
    const run = app.createRun({ objective: 'Inspect sandbox policy.', workspace, binding });
    const pins = run.toolBindings;
    await app.shutdown(); applications.splice(applications.indexOf(app), 1);
    for (const policy of [{ network: 'none' }, { network: 'allow' }, undefined] as (SandboxPolicy | undefined)[]) {
      const reopened = new Application(directory, scripted(), undefined, { ...(policy ? { sandbox: policy } : {}) });
      applications.push(reopened);
      const restored = reopened.store.run(run.id);
      expect(restored.toolBindings).toEqual(pins);
      if (policy?.network === 'none') expect(() => assertRunCapabilities(restored, reopened.coordinator.tools)).not.toThrow();
      else expect(() => assertRunCapabilities(restored, reopened.coordinator.tools)).toThrow('pinned host contract');
      await reopened.shutdown(); applications.splice(applications.indexOf(reopened), 1);
    }
  });

  it('releases the store lock when invalid sandbox host configuration prevents construction', () => {
    const root = temp(); const directory = path.join(root, 'data');
    expect(() => new Application(directory, scripted(), undefined, { sandbox: { network: 'invalid' as 'none' } })).toThrow('network policy');
    const app = new Application(directory, scripted()); applications.push(app);
    expect(app.sessions().items).toEqual([]);
  });
});
