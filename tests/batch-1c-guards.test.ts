import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { methodCatalogDigest, methodSkillId, sessionMethodCards } from '../src/extensions/methods.js';
import { parseCard } from '../src/agents/card.js';
import { storageTestConnection } from '../src/storage/test-access.js';
import { answer, binding, call, calls, fixture, scripted, temp } from './helpers.js';

function caught(action: () => unknown): unknown {
  try { void action(); return undefined; } catch (error) { return error; }
}

const inlineCard = (id = 'test/method') => parseCard(`---
schema_version: 2
id: ${id}
version: 1.0.0
name: Method fixture
description: Inspect the supplied material.
catalog: {path: tests/method}
routing: {use_when: [Inspect material], mode: read}
capabilities: {tools: [file.read]}
execution: {modes: [inline]}
---
Inspect the supplied material and report observed facts.
`);

describe('batch 1c guarantee: children inherit the parent card and a permission subset', () => {
  it('inherits the parent card, narrows permissions only, and rejects removed card selectors', () => {
    const { app, runId } = fixture();
    const parent = app.store.run(runId);
    const session = app.store.session(parent.sessionId);
    const child = app.spawnAgent(parent.sessionId, { objective: 'Independent review', permissions: ['read'], scope: { write: [] } });
    expect(child.card.digest).toBe(parent.card.digest);
    expect(child.permissions).toEqual(['read']);
    expect(child.scope).toEqual({ write: [] });
    // The parent card and session grant stay untouched by a child's subset request.
    expect(app.store.run(parent.id).card.digest).toBe(parent.card.digest);
    expect(app.store.session(parent.sessionId).permissions).toEqual(session.permissions);
    for (const removed of [{ agent: 'test/method' }, { card_id: 'test/method', card_version: '1.0.0' }, { slots: { q: 'x' } }, { configuration: { instructions: 'x' } }]) {
      expect(caught(() => app.spawnAgent(parent.sessionId, { objective: 'Removed selector', ...removed } as never))).toMatchObject({ code: 'TOOL_ARGUMENTS' });
    }
    // Escalation above the parent grant is refused before any child is created.
    expect(caught(() => app.spawnAgent(parent.sessionId, { objective: 'Escalate', permissions: ['exec'] }))).toMatchObject({ code: 'PERMISSION_ESCALATION' });
  });
});

describe('batch 1c guarantee: same-response spawn write scopes are validated as a group', () => {
  it('rejects every conflicting spawn in one response and creates no child', async () => {
    const { app, runId } = fixture(scripted(
      calls(
        call('spawn_agent', { objective: 'First slice', scope: { write: ['src/shared'] } }, 'spawn-a'),
        call('spawn_agent', { objective: 'Second slice', scope: { write: ['src/shared/other.ts'] } }, 'spawn-b'),
      ),
      answer('replanned with disjoint scopes'),
    ));
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.listRuns(app.store.run(runId).sessionId).filter(child => child.parentId)).toHaveLength(0);
    const results = app.store.calls(runId).filter(entry => entry.kind === 'tool').map(entry => app.store.readBlob<{ error?: string }>(entry.resultRef!));
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.error).toContain('WRITE_SCOPE_CONFLICT');
      expect(result.error).toContain('no child was created');
    }
  });
});

describe('batch 1c guarantee: the method catalog is session-scoped', () => {
  it('publishes into session.methodCards and keeps Card.execution.modes as the compatibility gate', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { inlineMethods: true, instructions: { global: false } });
    try {
      const method = inlineCard();
      app.registerCard(method);
      const run = app.createRun({ objective: 'Inspect figures.', workspace: root, binding });
      const session = app.store.session(run.sessionId);
      expect(session.methodCards).toEqual([]);
      expect(methodCatalogDigest(session.methodCards)).toBe(methodCatalogDigest([]));
      const revised = app.updateSessionMethods(run.id, { expectedDigest: methodCatalogDigest(session.methodCards), install: [method] });
      const updated = app.store.session(run.sessionId);
      expect(updated.methodCards).toEqual([{ id: method.id, version: method.version, digest: method.digest }]);
      expect(revised.digest).toBe(methodCatalogDigest(updated.methodCards));
      expect(sessionMethodCards(app.store, updated)).toMatchObject([{ card: { id: method.id, digest: method.digest } }]);
      expect(methodSkillId(method)).toContain('card-method/');
      // A card without inline execution cannot enter the session method catalog.
      const childOnly = parseCard(`---
schema_version: 2
id: test/child-only
version: 1.0.0
name: Child only
description: Runs as a child.
catalog: {path: tests/child}
routing: {use_when: [Implement], mode: write}
capabilities: {tools: [file.read]}
execution: {modes: [child]}
---
Implement the assigned change.
`);
      expect(caught(() => app.updateSessionMethods(run.id, { expectedDigest: revised.digest, install: [childOnly] }))).toMatchObject({ code: 'METHOD_CONFIG' });
    } finally { await app.shutdown(); }
  });
});

describe('batch 1c guarantee: old roster data is explicitly incompatible, read-only stays usable', () => {
  it('gates execution and child creation but keeps snapshots, listing and gc working', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Old roster task.', workspace: root, binding });
      const db = storageTestConnection(app.store);
      db.exec('CREATE TABLE roster_snapshots(session_id TEXT PRIMARY KEY, digest TEXT NOT NULL, data TEXT NOT NULL)');
      db.prepare('INSERT INTO roster_snapshots VALUES (?,?,?)').run(run.sessionId, 'd'.repeat(64), '{}');
      expect(caught(() => app.run(run.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(caught(() => app.recover(run.id))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(caught(() => app.spawnAgent(run.sessionId, { objective: 'Child' }))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(caught(() => app.submitInput(run.id, 'Continue'))).toMatchObject({ code: 'SESSION_INCOMPATIBLE' });
      expect(app.sessions().items.map(item => item.id)).toContain(run.sessionId);
      expect(app.snapshot(run.id).session.id).toBe(run.sessionId);
      expect(app.store.gc({})).toMatchObject({ removedSessions: 0 });
    } finally { await app.shutdown(); }
  });
});
