import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { builtinAgentCards, defaultMemberReferences, legacyBuiltinCards } from '../src/agents/presets.js';
import { defaultCard, serializeCard } from '../src/agents/card.js';
import { cardDirectoryTool } from '../src/agents/discovery.js';
import type { Card, Run } from '../src/runtime/types.js';
import { answer, binding, scripted } from './helpers.js';

const active = new Set<Application>();
const directories: string[] = [];
afterEach(async () => {
  for (const app of active) await app.shutdown();
  active.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Digests of the published 1.0.0 cards, captured before adding shell-capable versions.
const originalDigests: Record<string, string> = {
  'kodo/explorer': 'b357d4e3cf03a884e92ead03f41eaeecc37bf5f8720a9100bccce3f22fef9664',
  'kodo/tester': '158a028ed7600421e797118dfc6f26aca06775db0fab0ad7fa7daec1f52efe6a',
  'kodo/reviewer': 'cf439ba3b4669b4804028829a7a707bde50b14d13ea10bad84afc26fc1880c78',
  'kodo/implementer': '88b3366015f4a3e06e6dcb444eed1e062f8d1742d25459cff042bae93dfb6982',
  'kodo/frontend': '5d9cd307688b7aa507cb732d5d0d5966908ff1459ad600b7c965b787cbf80a3f',
  'kodo/backend': 'f484595a36c9f92f330512750c8ddc4af93eb237cdde1cef135e93a86b2a3bcf',
};
const originalCards = builtinAgentCards.map(card => legacyBuiltinCards.find(legacy => legacy.id === card.id) ?? card);

function open(directory: string, original = false): Application {
  const app = new Application(path.join(directory, '.state'), scripted(answer()), undefined, {
    instructions: { global: false }, toolProfile: 'full', taskProtocol: 1, agentFactors: { D: false, E: false, A: !original, B: false, C: true },
  });
  active.add(app);
  return app;
}

function spawnImplementer(app: Application, parent: Run): Run {
  const contract = app.store.artifact(parent.id, app.store.blob({ kind: 'contract', name: 'Behavior', content: 'Implement only the assigned module.' }));
  return app.spawnAgent(parent.sessionId, {
    agent: 'kodo/implementer', objective: 'Implement the assigned module.',
    slots: { requirement: 'Keep the existing interface.', contract }, scope: { read: ['.'], write: ['src'] },
  });
}

describe('versioned builtin implementation presets', () => {
  it('preserves every published 1.0.0 digest and only adds shell to new write presets', () => {
    expect(Object.fromEntries(originalCards.map(card => [card.id, card.digest]))).toEqual(originalDigests);
    expect(legacyBuiltinCards.map(card => card.id).sort()).toEqual(['kodo/backend', 'kodo/frontend', 'kodo/implementer', 'kodo/tester']);
    for (const old of originalCards) {
      const current = builtinAgentCards.find(card => card.id === old.id)!;
      if (old.routing?.mode !== 'write') {
        expect(current).toEqual(old);
        continue;
      }
      expect(old.version).toBe('1.0.0');
      expect(old.tools).not.toContain('shell.exec');
      expect(current.version).toBe('1.1.0');
      expect(current.digest).not.toBe(old.digest);
      expect({ ...current, version: old.version, digest: old.digest, tools: current.tools.filter(name => name !== 'shell.exec') }).toEqual(old);
    }
    expect(defaultMemberReferences.find(card => card.id === 'kodo/implementer')?.version).toBe('1.1.0');
  });

  it('reopens a database with old cards and preserves frozen children while new rosters select only current versions', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'kodo-preset-upgrade-'));
    directories.push(directory);
    const original = open(directory, true);
    for (const card of originalCards) original.registerCard(card);
    const oldMain: Card = original.parseCard(serializeCard({
      ...defaultCard, schemaVersion: 2, id: 'test/original-main',
      catalog: { path: 'coordination/general' }, routing: { mode: 'write', use_when: ['Coordinate the original team.'] },
      members: originalCards.map(({ id, version, digest }) => ({ id, version, digest })),
    }));
    const oldRun = original.createRun({ objective: 'Continue the original session.', workspace: directory, binding, permissions: ['read', 'write', 'exec'], card: oldMain });
    const frozen = original.store.cards.rosterSnapshot(oldRun.sessionId)!;
    expect(frozen.members.find(member => member.card.id === 'kodo/implementer')?.card.version).toBe('1.0.0');
    await original.shutdown();
    active.delete(original);

    const upgraded = open(directory);
    const newRun = upgraded.createRun({ objective: 'Use the current implementation tools.', workspace: directory, binding, permissions: ['read', 'write', 'exec'] });
    for (const card of originalCards) expect(upgraded.store.card(card.id, '1.0.0').digest).toBe(originalDigests[card.id]);
    expect(upgraded.store.cards.rosterSnapshot(oldRun.sessionId)).toEqual(frozen);

    const oldChild = spawnImplementer(upgraded, upgraded.store.run(oldRun.id));
    expect(oldChild.card.version).toBe('1.0.0');
    expect(oldChild.card.tools).not.toContain('shell.exec');
    const newChild = spawnImplementer(upgraded, newRun);
    expect(newChild.card.version).toBe('1.1.0');
    expect(newChild.card.tools).toContain('shell.exec');

    const directoryResult = await cardDirectoryTool(upgraded.store).execute({
      run: newRun, session: upgraded.store.session(newRun.sessionId), signal: new AbortController().signal, markEffectStarted() {},
    }, { path: 'engineering/implementation' }) as { cards: { id: string; version: string }[] };
    expect(directoryResult.cards.map(({ id, version }) => ({ id, version }))).toEqual([{ id: 'kodo/implementer', version: '1.1.0' }]);
    expect(upgraded.store.cards.rosterMember(newRun.sessionId, 'kodo/implementer')?.source).toBe('builtin');
  });
});
