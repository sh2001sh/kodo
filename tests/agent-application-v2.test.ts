import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { answer, binding, fullToolCard, scripted, temp } from './helpers.js';

const active: Application[] = [];
afterEach(async () => { while (active.length) await active.pop()!.shutdown(); });
const source = (id = 'local/reader', extra = '') => `---
schema_version: 2
id: ${id}
version: 1.0.0
name: Reader
description: Read the supplied task material.
catalog: {path: engineering/reading}
routing: {mode: read, use_when: [Read task material]}
capabilities: {tools: [file.read]}
inputs: [{name: question, kind: text, required: true}]
${extra}
---
Read the task material and report what it says.
`;
function setup(options: ConstructorParameters<typeof Application>[3] = {}) {
  const root = temp();
  const app = new Application(path.join(root, 'data'), scripted(answer()), undefined, { instructions: { global: false }, ...options });
  active.push(app);
  return { root, app };
}

describe('agent card host integration', () => {
  it('no longer discovers .kodo/agents project cards or AGENTS.md project variables', () => {
    const { root, app } = setup();
    mkdirSync(path.join(root, '.kodo', 'agents'), { recursive: true });
    writeFileSync(path.join(root, '.kodo', 'agents', 'reader.md'), source(), 'utf8');
    writeFileSync(path.join(root, 'AGENTS.md'), '---\nproject:\n  tests: [tests]\n---\nUse project conventions.\n', 'utf8');
    const run = app.createRun({ objective: 'Read material', workspace: root, binding, permissions: ['read', 'write'] });
    expect(app.store.session(run.sessionId).projectRoots).toEqual({});
    expect(app.store.registeredCards().map(card => card.id)).not.toContain('local/reader');
    // The single default card is not a roster-enhanced clone.
    expect(run.card.id).not.toMatch(/-roster/u);
  });

  it('starts host children that inherit the parent card and only narrow permissions', () => {
    const { root, app } = setup();
    const card = app.parseCard(source());
    const main = app.createRun({ objective: 'Read material', workspace: root, binding, permissions: ['read'], card });
    const child = app.spawnAgent(main.sessionId, { objective: 'Summarize the task material' });
    expect(child.parentId).toBe(main.id);
    expect(child.card.digest).toBe(main.card.digest);
    expect(child.permissions).toEqual(['read']);
    expect(app.store.events(child.id).some(event => event.data.origin === 'host')).toBe(true);
  });

  it('rejects permission escalation and removed card-selection arguments', () => {
    const { root, app } = setup();
    const main = app.createRun({ objective: 'Read material', workspace: root, binding, permissions: ['read', 'write'] });
    expect(() => app.spawnAgent(main.sessionId, { objective: 'Escalate', permissions: ['exec'] })).toThrow(/PERMISSION_ESCALATION|subset/u);
    // The deleted roster selectors are rejected by the tool schema, not silently ignored.
    expect(() => app.spawnAgent(main.sessionId, { objective: 'Pick a card', agent: 'local/reader' } as never)).toThrow(/schema/u);
    expect(() => app.spawnAgent(main.sessionId, { objective: 'Pick a card', card_id: 'local/reader', card_version: '1.0.0' } as never)).toThrow(/schema/u);
    expect(() => app.spawnAgent(main.sessionId, { objective: 'Fill slots', slots: { question: 'x' } } as never)).toThrow(/schema/u);
    expect(app.store.listRuns(main.sessionId)).toHaveLength(1);
  });

  it('requires a full child card by inheritance even when a run names a registered member card', () => {
    const { root, app } = setup();
    const member = app.parseCard(source());
    app.registerCard(member);
    const main = app.createRun({ objective: 'Read material', workspace: root, binding, permissions: ['read'] });
    const child = app.spawnAgent(main.sessionId, { objective: 'Read the contract' });
    // Members stay a parse-level field for 1e, but they no longer select a child card.
    expect(child.card.digest).toBe(main.card.digest);
    expect(child.card.id).not.toBe(member.id);
  });

  it('creates a fixed team atomically and rejects incomplete teams before publishing a session', () => {
    const { root, app } = setup();
    const sessionsBefore = app.sessions().items.length;
    expect(() => app.createRun({ objective: 'Read', workspace: root, binding, team: [{ objective: '' }] })).toThrow();
    expect(app.sessions().items).toHaveLength(sessionsBefore);
    const main = app.createRun({ objective: 'Read', workspace: root, binding, team: [{ objective: 'Summarize the entry point.' }] });
    const children = app.store.listRuns(main.sessionId).filter(run => run.parentId === main.id);
    expect(children).toHaveLength(1);
    expect(children[0]!.card.digest).toBe(main.card.digest);
  });

  it('stores contract revisions as distinct immutable artifacts', () => {
    const { root, app } = setup();
    const run = app.createRun({ objective: 'Record a contract', workspace: root, binding, permissions: ['read', 'write'], card: fullToolCard });
    const write = (content: string) => app.coordinator.tools.executeAtomic(run.id, 'artifact.write', { name: 'behavior', kind: 'contract', content }, new AbortController().signal) as { id: string };
    const before = write('Input is a path.');
    const after = write('Input is a path; an absent path returns an error.');
    expect(before.id).not.toBe(after.id);
    expect(app.store.readArtifact(run.id, before.id)).toMatchObject({ kind: 'contract', content: 'Input is a path.' });
    expect(app.store.readArtifact(run.id, after.id)).toMatchObject({ kind: 'contract', content: 'Input is a path; an absent path returns an error.' });
  });

  it('initializes contract artifacts in the same transaction as a fixed team', () => {
    const { root, app } = setup();
    let contract = '';
    const main = app.createRun({ objective: 'Review a fixed contract', workspace: root, binding, team: run => {
      contract = app.store.artifact(run.id, app.store.blob({ kind: 'contract', name: 'Behavior', content: 'Absent inputs produce an explicit error.' }));
      return [{ objective: 'Read this contract' }];
    } });
    const child = app.store.listRuns(main.sessionId).find(run => run.parentId === main.id)!;
    expect(app.store.readArtifact(child.id, contract)).toMatchObject({ kind: 'contract', content: 'Absent inputs produce an explicit error.' });
  });
});
