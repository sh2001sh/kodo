import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { defaultCard, parseCard, serializeCard } from '../src/agents/card.js';
import { builtinAgentCards, defaultMemberReferences } from '../src/agents/presets.js';
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
  it('round-trips explicit execution modes and retains legacy absence', () => {
    const original = parseCard(source(metadata()));
    expect(original.execution).toBeUndefined();
    const method = parseCard(source({ ...metadata(), execution: { modes: ['inline', 'child'] } }));
    expect(parseCard(serializeCard(method)).execution).toEqual({ modes: ['inline', 'child'] });
    expect(method.digest).not.toBe(original.digest);
    for (const modes of [[], ['inline', 'inline'], ['automatic']]) expect(() => parseCard(source({ ...metadata(), execution: { modes } }))).toThrow('schema');
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

describe('legacy cards and builtin members', () => {
  it('keeps the builtin general v1 digest and representation unchanged', () => {
    expect(defaultCard.digest).toBe('1758e68d91ec5e4c0fb58d21d74d0ed58110cf8ec499bb801e02dc3ebb80338f');
    expect(defaultCard).not.toHaveProperty('schemaVersion');
    expect(defaultCard).not.toHaveProperty('members');
    const legacy = { schema_version: 1, id: 'test/legacy', version: '1.0.0', name: 'Legacy', description: 'Legacy card.', capabilities: { tools: ['file.read'], skills: ['known/skill'] } };
    expect(() => parseCard(source(legacy))).toThrow('skill');
    expect(parseCard(source(legacy), { skillIds: ['known/skill'] }).skills).toEqual(['known/skill']);
  });

  it('provides distinct presets with a required tester contract and host-only review checks', () => {
    expect(builtinAgentCards.map(card => card.id)).toEqual(['kodo/explorer', 'kodo/tester', 'kodo/reviewer', 'kodo/implementer', 'kodo/frontend', 'kodo/backend']);
    expect(defaultMemberReferences.map(member => member.id)).toEqual(builtinAgentCards.slice(0, 4).map(card => card.id));
    const tester = builtinAgentCards.find(card => card.id === 'kodo/tester')!;
    expect(tester.inputs).toContainEqual(expect.objectContaining({ name: 'behavior_contract', kind: 'artifact', required: true }));
    expect(tester.constraints?.scope?.write).toEqual(['${project.tests}']);
    const reviewer = builtinAgentCards.find(card => card.id === 'kodo/reviewer')!;
    expect(reviewer.routing?.mode).toBe('review');
    expect(reviewer.constraints?.scope?.write).toEqual([]);
    expect(reviewer.tools).toContain('verify.run');
    expect(reviewer.tools).not.toContain('process.run');
    expect(reviewer.tools).not.toContain('process.exec');
    expect(builtinAgentCards.every(card => !(card.mcp?.length))).toBe(true);
  });
});
