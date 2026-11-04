import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import type { ApplicationOptions } from '../src/application/index.js';
import { parseCard } from '../src/agents/card.js';
import { intersectFileScopes, resolveScopeVariables } from '../src/runtime/scope.js';
import { KodoError } from '../src/runtime/types.js';
import type { Card, Run } from '../src/runtime/types.js';
import { answer, binding, temp } from './helpers.js';

const apps: Application[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.shutdown(); });

function member(overrides: Record<string, unknown> = {}): Card {
  return parseCard(`---\n${JSON.stringify({ schema_version: 2, id: 'local/member', version: '1.0.0', name: 'Member', description: 'Inspect or implement a bounded task.', catalog: { path: 'engineering/general' }, routing: { use_when: ['Inspect a module'], mode: 'write' }, capabilities: { tools: ['file.read', 'file.list', 'file.patch', 'process.exec'] }, ...overrides })}\n---\nInspect the task data and report actual evidence.\n`);
}
function setup(card: Card, options: ApplicationOptions = {}, mainScope?: Run['scope']) {
  const root = temp();
  mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'feature', 'entry.ts'), 'export const value = 1;\n');
  const app = new Application(path.join(root, '.state'), { async complete() { return answer(); } }, undefined, options);
  apps.push(app);
  app.registerCard(card);
  const parent = app.createRun({ objective: 'Deliver the feature', workspace: root, binding, permissions: ['read', 'write', 'exec'], card, ...(mainScope ? { scope: mainScope } : {}) });
  return { app, root, parent };
}
/** Host-shaped spawn: a child inherits the parent card and may only narrow permissions/scope. */
function spawn(app: Application, parent: Run, args: Record<string, unknown> = {}): Run {
  const request = { objective: 'Inspect this module', ...args };
  const value = app.coordinator.mailbox.execute(parent, 'spawn', 'spawn_agent', app.coordinator.mailbox.validate(parent, 'spawn_agent', JSON.stringify(request))) as { id: string };
  return app.store.run(value.id);
}

describe('scope helpers', () => {
  it('intersects directory roots without expanding current files and resolves project lists', () => {
    expect(intersectFileScopes({ read: ['src', 'docs'], write: ['src'] }, { read: ['src/feature'], write: ['src/feature', 'tests'] })).toEqual({ read: ['src/feature'], write: ['src/feature'] });
    expect(intersectFileScopes({}, { write: [] })).toEqual({ write: [] });
    expect(resolveScopeVariables({ write: ['${project.tests}'] }, { 'project.tests': ['tests/unit', 'tests/integration'] })).toEqual({ write: ['tests/unit', 'tests/integration'] });
    expect(() => resolveScopeVariables({ write: ['${project.tests}'] })).toThrow('unresolved scope variable');
  });
});

describe('child inheritance and shared write admission', () => {
  it('inherits the parent card and keeps the host overlap checks from the kernel fix', () => {
    const card = member();
    const { app, parent } = setup(card);
    const child = spawn(app, parent, { scope: { write: ['src/feature'] } });
    expect(child.card.digest).toBe(parent.card.digest);
    expect(child.permissions).toEqual(app.store.session(parent.sessionId).permissions);
    expect(child.scope?.write).toEqual(['src/feature']);
    // A second live writer on the same roots is rejected whole.
    expect(() => spawn(app, parent, { scope: { write: ['src/feature/entry.ts'] } })).toThrow(/overlaps child/u);
    expect(app.store.listRuns(parent.sessionId)).toHaveLength(2);
    expect(spawn(app, parent, { scope: { write: ['docs'] } })).toHaveProperty('parentId', parent.id);
  });

  it('rejects removed card-selection arguments and unknown tools', () => {
    const { app, parent } = setup(member());
    expect(spawn(app, parent, { permissions: ['read'] }).permissions).toEqual(['read']);
    for (const removed of [{ agent: 'local/member@1.0.0' }, { slots: { goal: 'x' } }, { configuration: { instructions: 'x' } }, { card_id: 'local/member', card_version: '1.0.0' }]) {
      expect(() => spawn(app, parent, removed)).toThrow(/schema/u);
    }
    expect(() => app.registerCard({ ...member(), id: 'local/bad', tools: [...member().tools, 'workspace.integrate'] })).toThrow(KodoError);
  });
});

