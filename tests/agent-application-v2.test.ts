import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { answer, binding, scripted, temp } from './helpers.js';

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
  it('freezes project overrides and resolves project test roots from instructions', () => {
    const { root, app } = setup();
    mkdirSync(path.join(root, '.kodo', 'agents'), { recursive: true });
    writeFileSync(path.join(root, '.kodo', 'agents', 'reader.md'), source(), 'utf8');
    writeFileSync(path.join(root, 'AGENTS.md'), '---\nproject:\n  tests: [tests]\n---\nUse project conventions.\n', 'utf8');
    const run = app.createRun({ objective: 'Read material', workspace: root, binding, permissions: ['read', 'write'] });
    expect(app.store.session(run.sessionId).projectRoots).toEqual({ 'project.tests': ['tests'] });
    const frozen = app.store.cards.rosterMember(run.sessionId, 'local/reader')!;
    expect(frozen).toMatchObject({ source: 'project', availability: 'available' });
    expect(app.store.cards.rosterMember(run.sessionId, 'kodo/tester')?.resolvedScope?.write).toEqual(['tests']);
    writeFileSync(path.join(root, '.kodo', 'agents', 'reader.md'), source().replace('Reader\n', 'Changed reader\n'), 'utf8');
    expect(app.store.cards.rosterMember(run.sessionId, 'local/reader')?.card.digest).toBe(frozen.card.digest);
  });

  it('registers missing dependencies but explains their unavailability in the session roster', () => {
    const { root, app } = setup();
    const card = app.parseCard(source().replace('capabilities: {tools: [file.read]}', 'capabilities: {tools: [file.read], skills: [local/method], mcp: [{server: browser, tools: [screenshot]}]}'));
    app.registerCard(card);
    const run = app.createRun({ objective: 'Read material', workspace: root, binding });
    const member = app.store.cards.rosterMember(run.sessionId, card.id)!;
    expect(member.availability).toBe('unavailable');
    expect(member.reasons.join(' ')).toContain('local/method');
    expect(member.reasons.join(' ')).toContain('browser');
  });

  it('resolves project-only member references and lets a project override a builtin identity', () => {
    const { root, app } = setup();
    mkdirSync(path.join(root, '.kodo', 'agents'), { recursive: true });
    const project = app.parseCard(source());
    writeFileSync(path.join(root, '.kodo', 'agents', 'reader.md'), source(), 'utf8');
    writeFileSync(path.join(root, '.kodo', 'agents', 'explorer.md'), source('kodo/explorer'), 'utf8');
    const mainCard = app.parseCard(source('local/coordinator', `members: [{id: ${project.id}, version: ${project.version}, digest: ${project.digest}}]`));
    const main = app.createRun({ objective: 'Read material', workspace: root, binding, card: mainCard });
    expect(app.store.cards.rosterMember(main.sessionId, project.id)?.card.digest).toBe(project.digest);
    const ordinary = app.createRun({ objective: 'Coordinate', workspace: root, binding });
    expect(app.store.cards.rosterMember(ordinary.sessionId, 'kodo/explorer')).toMatchObject({ source: 'project', card: { name: 'Reader' } });
  });

  it('starts a host child through the same slot contract and records its origin', () => {
    const { root, app } = setup();
    app.registerCard(app.parseCard(source()));
    const main = app.createRun({ objective: 'Read material', workspace: root, binding });
    expect(() => app.spawnAgent(main.sessionId, { agent: 'local/reader', objective: 'Summarize' })).toThrow('question');
    expect(app.store.listRuns(main.sessionId)).toHaveLength(1);
    const child = app.spawnAgent(main.sessionId, { agent: 'local/reader', objective: 'Summarize', slots: { question: 'What does the README explain?' } });
    expect(child.parentId).toBe(main.id);
    expect(child.permissions).toEqual(['read']);
    expect(child.scope?.write).toEqual([]);
    expect(app.store.events(child.id).some(event => event.data.origin === 'host')).toBe(true);
  });

  it('creates a fixed team atomically and rejects incomplete teams before publishing a session', () => {
    const { root, app } = setup();
    app.registerCard(app.parseCard(source()));
    const sessionsBefore = app.sessions().items.length;
    expect(() => app.createRun({ objective: 'Read', workspace: root, binding, team: [{ agent: 'local/reader', objective: 'Read' }] })).toThrow('question');
    expect(app.sessions().items).toHaveLength(sessionsBefore);
    const main = app.createRun({ objective: 'Read', workspace: root, binding, team: [{ agent: 'local/reader', objective: 'Read', slots: { question: 'Summarize the entry point.' } }] });
    expect(app.store.listRuns(main.sessionId).filter(run => run.parentId === main.id)).toHaveLength(1);
  });

  it('stores contract revisions as distinct immutable artifacts', () => {
    const { root, app } = setup({ toolProfile: 'full', taskProtocol: 2 });
    const run = app.createRun({ objective: 'Record a contract', workspace: root, binding, permissions: ['read', 'write'] });
    const write = (content: string) => app.coordinator.tools.executeAtomic(run.id, 'artifact.write', { name: 'behavior', kind: 'contract', content }, new AbortController().signal) as { id: string };
    const before = write('Input is a path.');
    const after = write('Input is a path; an absent path returns an error.');
    expect(before.id).not.toBe(after.id);
    expect(app.store.readArtifact(run.id, before.id)).toMatchObject({ kind: 'contract', content: 'Input is a path.' });
    expect(app.store.readArtifact(run.id, after.id)).toMatchObject({ kind: 'contract', content: 'Input is a path; an absent path returns an error.' });
  });

  it('initializes contract artifacts in the same transaction as a fixed team', () => {
    const { root, app } = setup();
    app.registerCard(app.parseCard(source('local/contract-reader').replace('name: question, kind: text', 'name: contract, kind: artifact')));
    let contract = '';
    const main = app.createRun({ objective: 'Review a fixed contract', workspace: root, binding, team: run => {
      contract = app.store.artifact(run.id, app.store.blob({ kind: 'contract', name: 'Behavior', content: 'Absent inputs produce an explicit error.' }));
      return [{ agent: 'local/contract-reader', objective: 'Read this contract', slots: { contract } }];
    } });
    const child = app.store.listRuns(main.sessionId).find(run => run.parentId === main.id)!;
    expect(app.store.readArtifact(child.id, contract)).toMatchObject({ kind: 'contract', content: 'Absent inputs produce an explicit error.' });
  });
});
