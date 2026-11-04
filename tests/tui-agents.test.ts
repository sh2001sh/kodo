import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { parseCard, serializeCard } from '../src/agents/card.js';
import { exportPackage, inspectPackage } from '../src/packages/archive.js';
import { PackageRegistry } from '../src/packages/registry.js';
import type { PackageDeclaration } from '../src/packages/schema.js';
import { agentCommand } from '../src/tui/agents.js';
import type { AgentCommandContext } from '../src/tui/types.js';
import { answer, fixture, temp } from './helpers.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function setup() {
  const complete = vi.fn(async () => answer('Synthetic fixture answer.'));
  const { app, root, runId } = fixture({ complete }, ['read', 'write']);
  const context: AgentCommandContext = {
    app, workspace: root, runId, registry: new PackageRegistry(path.join(root, '.packages')),
    startTask: vi.fn(async () => {}), wake: vi.fn(),
  };
  return { context, app, root, runId, complete };
}
const portableCard = (id = 'example/portable') => parseCard(`---
schema_version: 1
id: ${id}
version: 1.0.0
name: Portable fixture
description: Inspect the requested plain-text material.
capabilities: { tools: [file.read] }
---
Read the supplied material and report observed facts.
`);

async function packageArchive(mcp = false, examples = false): Promise<string> {
  const root = temp();
  await writeFile(path.join(root, 'AGENT.md'), mcp ? `---
schema_version: 1
id: example/remote
version: 1.0.0
name: Remote fixture
description: Use the configured read service.
capabilities: { tools: [mcp.remote.echo] }
---
Read the supplied material through the configured service.
` : serializeCard(portableCard()));
  const declaration: PackageDeclaration = {
    schema_version: 1, license: 'MIT', source: { url: 'https://example.test/portable-fixture' },
    files: [{ path: 'AGENT.md', distributable: true }],
    ...(mcp ? { resources: { mcp: [{ id: 'remote', transport: 'http', url: 'https://example.test/mcp-template', tools: { echo: { permission: 'read', effect: 'read' } } }] } } : {}),
    ...(examples ? { examples: [{ name: 'documented fixture', input: 'Inspect the supplied plain text.' }] } : {}),
  };
  const archive = path.join(root, 'source.zip');
  await exportPackage(root, declaration, archive);
  return archive;
}

describe('TUI agent library after the roster removal', () => {
  it('lists registered cards and package cards without a model request', async () => {
    const { context, app, complete } = setup();
    app.registerCard(portableCard());
    const list = await agentCommand(context, []);
    expect(list.items?.some(item => item.id === 'example/portable@1.0.0')).toBe(true);
    const search = await agentCommand(context, ['search', 'portable']);
    expect(search.items?.filter(item => item.command?.startsWith('/agents show ')).map(item => item.id)).toEqual(['example/portable@1.0.0']);
    const detail = await agentCommand(context, ['show', 'example/portable@1.0.0']);
    expect(detail.lines.join('\n')).toContain('Case evidence: none recorded');
    expect(detail.lines.join('\n')).toContain('Method:');
    expect(complete).not.toHaveBeenCalled();
    expect(context.startTask).not.toHaveBeenCalled();
  });

  it('no longer offers roster launch, fill, scope, retention drafts or session method commands', async () => {
    const { context, app } = setup();
    for (const command of [['run', 'example/portable', 'Do work'], ['fill', 'token', 'question', 'x'], ['scope', 'token', 'docs'], ['launch', 'token'], ['drafts'], ['drafts', 'show', 'id'], ['methods'], ['install-method', 'method.md', '--digest', 'd'], ['disable-method', 'test/method', '--digest', 'd']]) {
      await expect(agentCommand(context, command)).rejects.toThrow(/Unsupported agent action/u);
    }
    expect(app.store.listRuns()).toHaveLength(1);
  });
});

describe('TUI Agent portability', () => {
  it('exports only the registered definition and imports it without adopting or activating', async () => {
    const source = setup(); const receiver = setup();
    source.app.registerCard(portableCard());
    await writeFile(path.join(source.root, 'private-project-notes.txt'), 'Synthetic workspace data must stay local.');
    const archive = path.join(source.root, 'portable.zip');
    expect((await agentCommand(source.context, ['export', 'example/portable', archive])).title).toBe('Provide an export source');
    expect((await agentCommand(source.context, ['export', 'example/portable', archive, '--source-url', 'https://example.test/portable-fixture'])).title).toBe('Choose a new export version');
    await agentCommand(source.context, ['export', 'example/portable', archive, '--source-url', 'https://example.test/portable-fixture', '--version', '1.0.1']);
    const inspection = await inspectPackage(archive);
    expect(inspection.manifest.files.map(file => file.path)).toEqual(['AGENT.md']);
    expect(inspection.card).toMatchObject({ id: 'example/portable', version: '1.0.1', prompt: portableCard().prompt, tools: portableCard().tools });
    const activate = vi.fn(); receiver.context.activatePackage = activate;
    const imported = await agentCommand(receiver.context, ['import', archive]);
    expect(imported.title).toBe('Agent imported');
    expect(imported.lines.join('\n')).toContain('Adoption: not adopted');
    expect(imported.lines.join('\n')).toContain('Local: ready');
    expect(await receiver.context.registry.current('example/portable')).toBeUndefined();
    expect(activate).not.toHaveBeenCalled();
    expect(receiver.complete).not.toHaveBeenCalled();
  });

  it('exports declared MCP resources, diagnoses missing bindings and stores local configuration', async () => {
    const source = setup(); const receiver = setup();
    const sourceZip = await packageArchive(true);
    await agentCommand(source.context, ['import', sourceZip]);
    const transferred = path.join(source.root, 'shared.zip');
    await agentCommand(source.context, ['export', 'example/remote@1.0.0', transferred]);
    const imported = await agentCommand(receiver.context, ['import', transferred]);
    expect(imported.lines.join('\n')).toContain('mcp.remote.url');
    expect(imported.lines.join('\n')).toContain('needs bindings or preparation');
    const server = createServer(async (request, response) => {
      if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
      let body = ''; for await (const chunk of request) body += String(chunk);
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'isolated-fixture', version: '1' } }
        : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture missing address');
    const bindings = path.join(receiver.root, 'bindings.json');
    await writeFile(bindings, JSON.stringify({ mcp: { remote: { url: `http://127.0.0.1:${address.port}/mcp` } } }));
    await agentCommand(receiver.context, ['configure', 'example/remote@1.0.0', bindings]);
    expect((await receiver.context.registry.diagnose('example/remote', '1.0.0')).status).toBe('ready');
    expect(receiver.complete).not.toHaveBeenCalled();
  });

  it('allows a host verification callback to handle package examples on confirmed activation', async () => {
    const { context } = setup();
    const archive = await packageArchive(false, true);
    await agentCommand(context, ['import', archive]); context.runId = undefined;
    context.activatePackage = vi.fn(async () => portableCard());
    expect((await context.registry.current('example/portable'))).toBeUndefined();
    expect(context.activatePackage).not.toHaveBeenCalled();
  });
});
