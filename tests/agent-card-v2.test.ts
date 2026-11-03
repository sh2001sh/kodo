import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { defaultCard, parseCard, serializeCard } from '../src/agents/card.js';
import { digest } from '../src/storage/index.js';

const metadata = () => ({
  schema_version: 2, id: 'test/frontend', version: '1.0.0', name: 'Frontend', description: 'Implement interface components.',
  catalog: { path: 'engineering/frontend', aliases: ['界面', 'UI'] },
  routing: { use_when: ['Implement a page or component'], not_for: ['Database changes'], mode: 'write' },
  inputs: [{ name: 'requirement', kind: 'text', required: true, description: 'Interface requirement' }, { name: 'contract', kind: 'artifact', required: true }, { name: 'entry_files', kind: 'paths', required: false }],
  report: [{ name: 'changed_files', kind: 'paths', required: true }, { name: 'checks', kind: 'calls', required: true }, { name: 'open_issues', kind: 'list', required: true }],
  capabilities: { tools: ['file.read', 'file.patch'], skills: ['frontend/design-system'], mcp: [{ server: 'browser', tools: ['screenshot'] }] },
  constraints: { permissions: ['read', 'write'], scope: { write: ['web'] }, rules: ['docs/frontend-principles.md'] },
  model: { role: 'standard' }, derivation: { allowed: true }, members: [],
});
const source = (meta: unknown, prompt = 'Private implementation method.'): string => `---\n${stringify(meta)}---\n${prompt}\n`;

describe('agent card schema v2', () => {
  it('rejects the deleted inline-method execution modes instead of silently dropping them', () => {
    expect(() => parseCard(source({ ...metadata(), execution: { modes: ['inline', 'child'] } }))).toThrow(expect.objectContaining({ code: 'CARD_SCHEMA' }));
    expect(serializeCard(parseCard(source(metadata())))).not.toContain('execution');
  });
  it('preserves routing metadata, private methods and structured contracts without requiring installed skills or MCP', () => {
    const card = parseCard(source(metadata()));
    expect(card.schemaVersion).toBe(2);
    expect(card.catalog).toEqual(metadata().catalog);
    expect(card.routing).toEqual(metadata().routing);
    expect(card.inputs).toEqual(metadata().inputs);
    expect(card.report).toEqual(metadata().report);
    expect(card.constraints).toEqual(metadata().constraints);
    expect(card.skills).toEqual(['frontend/design-system']);
    expect(card.mcp).toEqual([{ server: 'browser', tools: ['screenshot'] }]);
    expect(card.prompt).toBe('Private implementation method.');
    expect(card.digest).toBe(digest(source(metadata())));
    expect(parseCard(serializeCard(card))).toMatchObject({ ...card, digest: expect.any(String) });
  });

  it.each([
    { catalog: { path: 'frontend' } },
    { catalog: { path: 'one/two/three/four/five' } },
    { routing: { use_when: [], mode: 'read' } },
    { inputs: [{ name: 'contract', kind: 'artifact', required: true }, { name: 'contract', kind: 'text', required: false }] },
    { report: [{ name: 'checks', kind: 'number', required: true }] },
    { model: { role: 'unmapped-arbitrary-role' } },
    { capabilities: { tools: ['not.registered'] } },
  ])('rejects malformed contract fields: %j', override => {
    expect(() => parseCard(source({ ...metadata(), ...override }))).toThrow();
  });

  it('accepts path roots and whole project variables for later session resolution', () => {
    const card = parseCard(source({ ...metadata(), constraints: { scope: { read: ['.'], write: ['${project.tests}', 'packages/ui'] } } }));
    expect(card.constraints?.scope).toEqual({ read: ['.'], write: ['${project.tests}', 'packages/ui'] });
    expect(() => parseCard(source({ ...metadata(), constraints: { scope: { write: ['tests/*.ts'] } } }))).toThrow();
  });

  it('checks member identities through the registering host when a resolver is supplied', () => {
    const member = { id: 'test/member', version: '1.0.0', digest: 'a'.repeat(64) };
    const card = source({ ...metadata(), members: [member] });
    expect(parseCard(card, { resolveMember: () => member }).members).toEqual([member]);
    expect(() => parseCard(card, { resolveMember: () => undefined })).toThrow('member');
    expect(() => parseCard(card, { resolveMember: () => ({ digest: 'b'.repeat(64) }) })).toThrow('digest');
  });
});

describe('legacy cards and the single default identity', () => {
  it('keeps the published general v1 representation unchanged except the 1c tool removal', () => {
    expect(defaultCard.digest).toBe('6a3d4558e55aaa927e551c9c4bc40115178a73415c8eded062aa9722eceb348d');
    expect(defaultCard).not.toHaveProperty('schemaVersion');
    expect(defaultCard).not.toHaveProperty('members');
    // The deleted roster/routing tools cannot be referenced by the builtin card.
    expect(defaultCard.tools.filter(name => name.startsWith('agent.'))).toEqual([]);
    const legacy = { schema_version: 1, id: 'test/legacy', version: '1.0.0', name: 'Legacy', description: 'Legacy card.', capabilities: { tools: ['file.read'], skills: ['known/skill'] } };
    expect(() => parseCard(source(legacy))).toThrow('skill');
    expect(parseCard(source(legacy), { skillIds: ['known/skill'] }).skills).toEqual(['known/skill']);
  });

  it('has no builtin specialist roster; delegation tools are gone from every default card', async () => {
    const { compactDefaultCard, legacySimpleDefaultCard, simpleDefaultCard, leanDefaultCard } = await import('../src/agents/card.js');
    for (const card of [defaultCard, compactDefaultCard, legacySimpleDefaultCard, simpleDefaultCard, leanDefaultCard]) {
      expect(card.tools.filter(name => ['agent.search', 'agent.directory', 'agent.route', 'agent.derive', 'agent.propose', 'agent.retain'].includes(name))).toEqual([]);
      expect(card.members).toBeUndefined();
    }
  });
});
