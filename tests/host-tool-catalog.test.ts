import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostToolNames } from '../src/tools/catalog.js';
import { builtinToolNames } from '../src/tools/index.js';
import { createAgentDraft, writeAgentDraft } from '../src/agents/authoring.js';
import { exportPackage, importPackage } from '../src/packages/archive.js';
import type { PackageDeclaration } from '../src/packages/schema.js';
import { temp } from './helpers.js';

const card = (tools: readonly string[]) => `---\nschema_version: 1\nid: test/catalog\nversion: 1.0.0\nname: Catalog agent\ndescription: Use host capabilities without bundling replacements.\ncapabilities:\n  tools: ${JSON.stringify(tools)}\n---\nUse the current host's approved capabilities and report missing capabilities.\n`;
const declaration = (): PackageDeclaration => ({ schema_version: 1, license: 'MIT', source: { url: 'https://example.test/catalog' }, files: [{ path: 'AGENT.md', distributable: true }] });

describe('portable standard host tool catalog', () => {
  it('contains unique standard extension names and keeps built-ins separate', () => {
    expect(Object.isFrozen(hostToolNames)).toBe(true);
    expect(new Set(hostToolNames).size).toBe(hostToolNames.length);
    expect(hostToolNames.filter(name => builtinToolNames.includes(name))).toEqual([]);
    expect(hostToolNames).toEqual(expect.arrayContaining(['agent.search', 'agent.directory', 'agent.route', 'todo.read', 'todo.write', 'web.fetch', 'lsp.hover', 'lsp.definition', 'lsp.references', 'lsp.symbols', 'lsp.diagnostics', 'skill.list', 'skill.load']));
  });

  it('round-trips cards that request standard host tools without bundling their implementation', async () => {
    const source = temp(); const output = path.join(temp(), 'catalog.zip');
    const requested = [...hostToolNames, 'image.read', 'shell.exec'];
    await writeFile(path.join(source, 'AGENT.md'), card(requested), 'utf8');
    const inspected = await exportPackage(source, declaration(), output);
    expect(inspected.card.tools).toEqual(requested);
    const installed = await importPackage(output, path.join(temp(), 'registry'));
    expect(installed.card.tools).toEqual(requested);
    expect(installed.manifest.resources).toBeUndefined();
  });

  it('writes and exports authored drafts with every standard host extension', async () => {
    const draft = await createAgentDraft({ description: 'Inspect a task using host-approved evidence tools.', id: 'test/host-draft', allowedTools: hostToolNames, template: true });
    const written = await writeAgentDraft(draft, { directory: path.join(temp(), 'draft'), license: 'MIT', sourceUrl: 'https://example.test/draft' });
    expect(await readFile(written.cardPath, 'utf8')).toBe(draft.cardContent);
    const inspected = await exportPackage(written.directory, written.declaration, path.join(temp(), 'draft.zip'));
    expect(inspected.card.tools).toEqual(hostToolNames);
  });

  it.each(hostToolNames)('rejects packaged tool implementations that replace reserved host tool %s or its wire alias', async name => {
    const source = temp();
    await writeFile(path.join(source, 'AGENT.md'), card([]));
    await writeFile(path.join(source, 'tool.mjs'), 'export const execute = () => null;\n');
    for (const toolName of [name, name.replaceAll('.', '_')]) {
      await writeFile(path.join(source, 'tool.json'), JSON.stringify({ format: 'kodo-tool/v1', name: toolName, description: 'Attempted host replacement.', parameters: { type: 'object' }, permission: 'read', effect: 'read' }));
      const metadata: PackageDeclaration = { ...declaration(), files: ['AGENT.md', 'tool.json', 'tool.mjs'].map(file => ({ path: file, distributable: true })), resources: { tools: [{ name: toolName, descriptor: 'tool.json', entry: 'tool.mjs' }] } };
      await expect(exportPackage(source, metadata, path.join(temp(), 'replacement.zip'))).rejects.toMatchObject({ code: 'PACKAGE_INVALID' });
    }
  });

  it('rejects nonstandard tools absent from the package resources', async () => {
    const source = temp();
    await writeFile(path.join(source, 'AGENT.md'), card(['custom.unregistered']));
    await expect(exportPackage(source, declaration(), path.join(temp(), 'missing.zip'))).rejects.toMatchObject({ code: 'CARD_SCHEMA' });
  });
});
