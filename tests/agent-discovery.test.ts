import { describe, expect, it } from 'vitest';
import { parseCard } from '../src/agents/card.js';
import { cardSearchTool, searchCards } from '../src/agents/discovery.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { digest } from '../src/storage/index.js';
import { binding, fixture } from './helpers.js';

function card(id: string, version: string, description: string, tools = ['file.read'], skills?: string[]) {
  return parseCard(`---
schema_version: 1
id: ${id}
version: ${version}
name: ${id}
description: ${description}
capabilities:
  tools: ${JSON.stringify(tools)}
  ${skills ? `skills: ${JSON.stringify(skills)}` : ''}
---
Private prompt contents must not appear in discovery.`, { toolNames: tools, skillIds: skills });
}

describe('installed agent discovery', () => {
  it('searches literal metadata and returns immutable version references without private prompts', () => {
    const { app } = fixture();
    app.registerCard(card('test/reader', '1.0.0', 'Review TypeScript and 中文资料'));
    app.registerCard(card('test/writer', '1.0.0', 'Edit source files', ['file.read', 'file.patch']));
    const result = searchCards(app.store, { query: 'typescript' });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({ id: 'test/reader', version: '1.0.0', description: 'Review TypeScript and 中文资料', digest: expect.any(String), tools: ['file.read'] });
    expect(JSON.stringify(result)).not.toContain('Private prompt');
    expect(result.next).toBeNull();
    expect(searchCards(app.store, { query: '中文资料' }).cards).toHaveLength(1);
    expect(searchCards(app.store, { query: '%' }).cards).toHaveLength(0);
    expect(searchCards(app.store, { query: "' OR 1=1 --" }).cards).toHaveLength(0);
  });

  it('requires every capability filter and pages all installed versions deterministically', () => {
    const { app } = fixture();
    app.registerTool({ name: 'custom.read', description: 'Read host-approved review evidence.', permission: 'read', effect: 'read', parameters: { type: 'object', additionalProperties: false, properties: {} }, execute: () => ({ reviewed: true }) });
    const content = '---\nname: review\ndescription: Review source with evidence\n---\nRead relevant source before reporting findings.\n';
    app.registerSkills([{ id: 'review', description: 'Review source with evidence', content, digest: digest(content) }]);
    app.registerCard(card('test/a', '1.0.0', 'Reader', ['file.read', 'custom.read'], ['review']));
    app.registerCard(card('test/a', '2.0.0', 'Reader v2', ['file.read', 'custom.read'], ['review']));
    app.registerCard(card('test/b', '1.0.0', 'Writer', ['file.read', 'file.patch']));
    const first = searchCards(app.store, { query: 'test/', limit: 1 });
    expect(first.cards.map(item => [item.id, item.version])).toEqual([['test/a', '1.0.0']]);
    const second = searchCards(app.store, { query: 'test/', limit: 1, ...first.next! });
    expect(second.cards.map(item => [item.id, item.version])).toEqual([['test/a', '2.0.0']]);
    const third = searchCards(app.store, { query: 'test/', limit: 1, ...second.next! });
    expect(third.cards.map(item => item.id)).toEqual(['test/b']);
    expect(third.next).toBeNull();
    expect(searchCards(app.store, { tools: ['custom.read', 'file.read'], skills: ['review'] }).cards).toHaveLength(2);
    expect(searchCards(app.store, { tools: ['custom.read', 'file.patch'] }).cards).toHaveLength(0);
    expect(searchCards(app.store, { offset: 100 }).cards).toEqual([]);
  });

  it('rejects unbounded/invalid host searches and validates model arguments', () => {
    const { app } = fixture();
    for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }, { query: 'x'.repeat(201) }, { tools: [''] }, { skills: Array(33).fill('review') as string[] }]) {
      expect(() => searchCards(app.store, options)).toThrow();
    }
    const registry = new ToolRegistry();
    registry.register(cardSearchTool(app.store));
    const tool = registry.get('agent.search')!;
    expect(tool.validate({ query: 'read', limit: 2 })).toBe(true);
    expect(tool.validate({ query: 'read', limit: 101 })).toBe(false);
    expect(tool.validate({ tools: ['file.read', 'file.read'] })).toBe(false);
    expect(tool.validate({ path: '../private' })).toBe(false);
  });

  it('requires card approval and read permission when invoked through runtime tools', async () => {
    const { app, root } = fixture(undefined, ['read']);
    const installed = card('test/discovery-approval', '1.0.0', 'Discovery approval fixture');
    app.registerCard(installed);
    const runId = app.createRun({ objective: 'Inspect discovery approval.', workspace: root, binding, permissions: ['read'] }).id;
    const tools = app.coordinator.tools;
    const defaultCard = app.store.run(runId).card;
    // The host may install discovery globally; each card must still explicitly allow it.
    if (!tools.specs(['agent.search'], app.store.session(app.store.run(runId).sessionId)).some(tool => tool.name === 'agent.search')) tools.register(cardSearchTool(app.store));
    app.store.updateRun(runId, { card: { ...defaultCard, tools: defaultCard.tools.filter(name => name !== 'agent.search') } });
    await expect(tools.execute(runId, 'agent.search', {}, new AbortController().signal)).rejects.toThrow('not authorized');
    app.store.updateRun(runId, { card: { ...defaultCard, tools: [...new Set([...defaultCard.tools, 'agent.search'])] } });
    const result = await tools.execute(runId, 'agent.search', { query: installed.id, limit: 1 }, new AbortController().signal);
    expect(result).toMatchObject({ cards: [expect.objectContaining({ id: installed.id, version: installed.version, digest: installed.digest })] });
    app.store.updateRun(runId, { permissions: [] });
    await expect(tools.execute(runId, 'agent.search', {}, new AbortController().signal)).rejects.toThrow('not authorized');
  });
});
