import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { parseCard, serializeCard } from '../src/agents/card.js';
import { exportPackage, inspectPackage } from '../src/packages/archive.js';
import { PackageRegistry } from '../src/packages/registry.js';
import type { PackageDeclaration } from '../src/packages/schema.js';
import { agentCommand } from '../src/tui/agents.js';
import type { AgentCommandContext, TuiPanel } from '../src/tui/types.js';
import { answer, binding, fixture, temp } from './helpers.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function setup(toolProfile?: 'full') {
  const complete = vi.fn(async () => answer('Synthetic fixture answer.'));
  // Exercise Application defaults unless a compatibility case requests full tools.
  const { app, root, runId } = fixture({ complete }, ['read', 'write'], { toolProfile, taskProtocol: toolProfile === 'full' ? 1 : undefined });
  const context: AgentCommandContext = {
    app, workspace: root, runId, registry: new PackageRegistry(path.join(root, '.packages')),
    startTask: vi.fn(async () => {}), wake: vi.fn(),
  };
  return { context, app, root, runId, complete };
}
const tokenOf = (panel: TuiPanel): string => {
  const action = panel.items?.find(item => item.input?.includes('/agents fill ') || item.input?.includes('/agents scope ') || item.command?.includes('/agents launch '));
  const command = action?.input ?? action?.command;
  if (!command) throw new Error('fixture expected a pending launch');
  return command.split(' ')[2]!;
};
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

describe('TUI Agent library and explicit launches', () => {
  it('lists, searches and opens cards without making a model request', async () => {
    const { context, complete } = setup();
    const list = await agentCommand(context, []);
    expect(list.items?.some(item => item.id === 'kodo/explorer@1.0.0')).toBe(true);
    expect(list.items?.some(item => item.id === 'kodo/explorer@1.2.0')).toBe(true);
    expect(list.items?.some(item => item.id === 'kodo/explorer@1.3.0')).toBe(true);
    const search = await agentCommand(context, ['search', 'explorer']);
    expect(search.items?.filter(item => item.command?.startsWith('/agents show ')).map(item => item.id)).toEqual(['kodo/explorer@1.3.0', 'kodo/explorer@1.2.0', 'kodo/explorer@1.0.0']);
    const detail = await agentCommand(context, ['show', 'kodo/explorer@1.0.0']);
    expect(detail.lines.join('\n')).toContain('Case evidence: none recorded');
    expect(detail.lines.join('\n')).toContain('Input question');
    expect(complete).not.toHaveBeenCalled();
    expect(context.startTask).not.toHaveBeenCalled();
  });

  it.each([undefined, 'full'] as const)('collects required inputs before submitting exactly one managed child (profile=%s)', async toolProfile => {
    const { context, app, runId, complete } = setup(toolProfile);
    const session = app.store.run(runId).sessionId;
    const initial = await agentCommand(context, ['run', 'kodo/explorer', 'Locate the entry point.']);
    const token = tokenOf(initial);
    expect(initial.title).toBe('Agent inputs');
    expect((await agentCommand(context, ['launch', token])).title).toBe('Agent inputs');
    expect(app.store.listRuns(session)).toHaveLength(1);
    const confirmation = await agentCommand(context, ['fill', token, 'question', 'Where does the CLI start?']);
    expect(confirmation.title).toBe('Confirm agent run');
    expect(complete).not.toHaveBeenCalled();
    await agentCommand(context, ['launch', token]);
    const child = app.store.listRuns(session).find(run => run.parentId === runId)!;
    expect(child.card.id).toBe('kodo/explorer');
    expect(child.card.version).toBe(toolProfile === 'full' ? '1.0.0' : '1.3.0');
    expect(child.objective).toBe('Locate the entry point.');
    expect(context.wake).toHaveBeenCalledWith(child.id);
    await expect(agentCommand(context, ['launch', token])).rejects.toThrow('expired');
    expect(app.store.listRuns(session)).toHaveLength(2);
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps a write Agent in the scope wizard until a write root is supplied', async () => {
    const { context, app, root, complete } = setup();
    const card = parseCard(`---
schema_version: 2
id: example/writer
version: 1.0.0
name: Writer fixture
description: Update the assigned documentation.
catalog: { path: engineering/documentation }
routing: { use_when: [Update documentation], mode: write }
capabilities: { tools: [file.read, file.patch] }
constraints: { permissions: [read, write] }
---
Change only the assigned documentation roots.
`);
    app.registerCard(card);
    const main = app.createRun({ objective: 'Update documentation.', workspace: root, binding, permissions: ['read', 'write'] });
    context.runId = main.id;
    const first = await agentCommand(context, ['run', card.id, 'Update the setup guide.']);
    const token = tokenOf(first);
    expect(first.title).toBe('Choose a write scope');
    expect((await agentCommand(context, ['launch', token])).title).toBe('Choose a write scope');
    expect(app.store.listRuns(main.sessionId)).toHaveLength(1);
    expect((await agentCommand(context, ['scope', token, 'docs'])).title).toBe('Confirm agent run');
    await agentCommand(context, ['launch', token]);
    const child = app.store.listRuns(main.sessionId).find(run => run.parentId === main.id)!;
    expect(child.scope?.write).toEqual(['docs']);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(['home', 'completed'] as const)('starts a primary flow from %s only after confirmation', async state => {
    const { context, app, runId } = setup();
    if (state === 'home') context.runId = undefined;
    else app.store.updateRun(runId, { status: 'completed' });
    const panel = await agentCommand(context, ['run', 'kodo/explorer', 'Locate the entry point.', '--slot', 'question=Where does the CLI start?']);
    expect(context.startTask).not.toHaveBeenCalled();
    await agentCommand(context, ['launch', tokenOf(panel)]);
    expect(context.startTask).toHaveBeenCalledWith('Locate the entry point.', { agent: 'kodo/explorer@1.3.0', slots: { question: 'Where does the CLI start?' }, scope: undefined });
  });

  it('keeps an explicitly selected new version outside a frozen full-profile roster', async () => {
    const { context, app, runId, complete } = setup('full');
    const pending = await agentCommand(context, ['run', 'kodo/explorer@1.2.0', 'Inspect the entry point.', '--slot', 'question=Where does the CLI start?']);
    expect(pending.lines).toContain('Agent: kodo/explorer@1.2.0');
    expect((await agentCommand(context, ['launch', tokenOf(pending)])).title).toBe('This version requires a new session');
    expect(app.store.listRuns(app.store.run(runId).sessionId)).toHaveLength(1);
    expect(context.wake).not.toHaveBeenCalled();
    expect(context.startTask).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('explains a frozen session roster when a card was registered afterwards', async () => {
    const { context, app } = setup();
    app.registerCard(portableCard());
    const pending = await agentCommand(context, ['run', 'example/portable', 'Read the material.']);
    const result = await agentCommand(context, ['launch', tokenOf(pending)]);
    expect(result.title).toBe('This version requires a new session');
    expect(context.startTask).not.toHaveBeenCalled();
    expect(context.wake).not.toHaveBeenCalled();
  });

  it('keeps the wizard available after invalid path input', async () => {
    const { context } = setup();
    const pending = await agentCommand(context, ['run', 'kodo/explorer', 'Inspect entry files.']);
    const token = tokenOf(pending);
    await expect(agentCommand(context, ['fill', token, 'entry_files', '[]'])).rejects.toThrow('non-empty paths');
    expect((await agentCommand(context, ['fill', token, 'question', 'Locate the entry files.'])).title).toBe('Confirm agent run');
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

  it('exports declared MCP resources, diagnoses missing bindings and runs the same version after local configuration', async () => {
    const source = setup(); const receiver = setup();
    const sourceZip = await packageArchive(true);
    await agentCommand(source.context, ['import', sourceZip]);
    const transferred = path.join(source.root, 'shared.zip');
    await agentCommand(source.context, ['export', 'example/remote@1.0.0', transferred]);
    const imported = await agentCommand(receiver.context, ['import', transferred]);
    expect(imported.lines.join('\n')).toContain('mcp.remote.url');
    expect((await agentCommand(receiver.context, ['run', 'example/remote', 'Read the material.'])).title).toBe('Agent needs bindings or preparation');
    expect(receiver.complete).not.toHaveBeenCalled();

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
    receiver.context.runId = undefined;
    receiver.context.activatePackage = (id, version) => receiver.context.registry.activate(receiver.app, id, version, { workspace: receiver.root });
    const executed: string[] = [];
    receiver.context.startTask = async (objective, member) => {
      const main = receiver.app.createRun({ objective, workspace: receiver.root, binding, permissions: ['read'] });
      const child = receiver.app.spawnAgent(main.sessionId, { ...member!, objective });
      expect(child.card).toMatchObject({ id: 'example/remote', version: '1.0.0', digest: (await inspectPackage(transferred)).card.digest });
      expect((await receiver.app.run(child.id)).status).toBe('completed');
      executed.push(child.id);
    };
    const pending = await agentCommand(receiver.context, ['run', 'example/remote@1.0.0', 'Read the material.']);
    expect(receiver.complete).not.toHaveBeenCalled();
    await agentCommand(receiver.context, ['launch', tokenOf(pending)]);
    expect(executed).toHaveLength(1);
    expect(receiver.complete.mock.calls.length).toBeGreaterThan(0);
    expect(await receiver.context.registry.current('example/remote')).toBeUndefined();
  });

  it('allows a host verification callback to handle package examples on confirmed activation', async () => {
    const { context } = setup();
    const archive = await packageArchive(false, true);
    await agentCommand(context, ['import', archive]); context.runId = undefined;
    context.activatePackage = vi.fn(async () => portableCard());
    const pending = await agentCommand(context, ['run', 'example/portable', 'Inspect plain text.']);
    expect(pending.title).toBe('Confirm agent run');
    expect(context.activatePackage).not.toHaveBeenCalled();
    await agentCommand(context, ['launch', tokenOf(pending)]);
    expect(context.activatePackage).toHaveBeenCalledWith('example/portable', '1.0.0');
  });
});

describe('TUI Agent drafts', () => {
  it('shows and edits a draft, then requires confirmation of its current digest after the owner finishes', async () => {
    const { context, app, runId } = setup();
    const owner = app.store.run(runId);
    const child = app.spawnAgent(owner.sessionId, { agent: 'kodo/explorer', objective: 'Inspect the fixture.', slots: { question: 'Locate the entry point.' } });
    // Isolated execution records make the retention fixture deterministic without a model request.
    app.store.putCall({ id: 'synthetic-model-attempt', runId: child.id, step: 0, kind: 'model', name: 'isolated-fixture', status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef: app.store.blob({ fixture: true }) });
    app.store.updateRun(child.id, { status: 'completed', resultRef: app.store.blob({ text: 'Synthetic fixture result.' }) });
    const draft = app.retention.propose(owner.sessionId, { run_id: child.id, name: 'Reusable fixture' }, owner.id);
    const shown = await agentCommand(context, ['drafts', 'show', draft.id]);
    expect(shown.items?.find(item => item.id === 'approve')?.disabled).toBe(true);
    await expect(agentCommand(context, ['drafts', 'approve', draft.id, '--digest', draft.digest])).rejects.toThrow('primary task to finish');
    expect(() => app.store.card(draft.card.id, draft.card.version)).toThrow();
    app.store.updateRun(runId, { status: 'completed' });
    await agentCommand(context, ['drafts', 'edit', draft.id, '--digest', draft.digest, '--name', 'Revised fixture']);
    const edited = app.retention.get(draft.id);
    expect(edited.digest).not.toBe(draft.digest);
    await expect(agentCommand(context, ['drafts', 'approve', draft.id, '--digest', draft.digest])).rejects.toThrow('draft changed');
    await agentCommand(context, ['drafts', 'approve', draft.id, '--digest', edited.digest]);
    expect(app.store.card(edited.card.id, edited.card.version).name).toBe('Revised fixture');
    expect(app.store.events(owner.id, { types: ['agent.approval'] })[0]?.data).toMatchObject({ decision: 'approve', source: 'terminal_key', draft_digest: edited.digest, user_event_id: expect.any(String) });
  });

  it('saves the actual temporary configuration as a non-adopted archive without a model', async () => {
    const { context, app, runId, root, complete } = setup();
    const owner = app.store.run(runId);
    const childId = app.store.transaction(() => {
      const args = app.coordinator.mailbox.validate(owner, 'spawn_agent', JSON.stringify({ objective: 'Inspect the fixture.', permissions: ['read'], configuration: { instructions: 'Compare documented interfaces with their callers.', tools: ['file.read', 'file.search'] } }));
      return (app.coordinator.mailbox.execute(owner, 'configuration-fixture', 'spawn_agent', args) as { id: string }).id;
    });
    app.store.updateRun(childId, { status: 'completed', resultRef: app.store.blob({ text: 'Synthetic fixture result.' }) });
    const archive = path.join(root, 'saved.zip');
    const result = await agentCommand(context, ['save-config', childId, '--id', 'example/saved', '--output', 'saved', '--source-url', 'https://example.test/saved-fixture', '--archive', archive]);
    expect(result.title).toBe('Configuration draft saved');
    const saved = await inspectPackage(archive);
    expect(saved.card.tools).toEqual(['file.read', 'file.search']);
    expect(saved.card.prompt).toContain('Compare documented interfaces with their callers.');
    expect(saved.manifest.files.map(file => file.path)).toEqual(['AGENT.md']);
    expect(await readFile(path.join(root, 'saved', 'AGENT.md'), 'utf8')).not.toContain(childId);
    expect(() => app.store.card('example/saved', '0.1.0')).toThrow();
    expect(complete).not.toHaveBeenCalled();
    expect((await agentCommand(context, ['method', childId])).title).toBe('Extract a method (model request)');
  });

  it('reports unsupported extension dependencies instead of silently dropping them from a saved configuration', async () => {
    const { context, app, root, complete } = setup();
    app.registerTool({ name: 'custom.fixture', description: 'Synthetic read fixture', permission: 'read', effect: 'read', parameters: { type: 'object' }, execute: () => ({ fixture: true }) });
    const card = app.parseCard(`---\nschema_version: 1\nid: example/extension\nversion: 1.0.0\nname: Extension fixture\ndescription: Inspect supplied fixture material.\ncapabilities: { tools: [custom.fixture] }\n---\nInspect supplied fixture material.`);
    const owner = app.createRun({ objective: 'Inspect fixture material.', workspace: root, binding, card, permissions: ['read'] });
    context.runId = owner.id;
    const childId = app.store.transaction(() => {
      const args = app.coordinator.mailbox.validate(owner, 'spawn_agent', JSON.stringify({ objective: 'Inspect fixture material.', permissions: ['read'], configuration: { instructions: 'Read the supplied fixture material.', tools: ['custom.fixture'] } }));
      return (app.coordinator.mailbox.execute(owner, 'extension-fixture', 'spawn_agent', args) as { id: string }).id;
    });
    app.store.updateRun(childId, { status: 'completed', resultRef: app.store.blob({ text: 'Synthetic fixture result.' }) });
    await expect(agentCommand(context, ['save-config', childId, '--id', 'example/saved', '--output', 'extension-draft', '--source-url', 'https://example.test/extension-fixture'])).rejects.toThrow('host extensions');
    expect(complete).not.toHaveBeenCalled();
  });
});
