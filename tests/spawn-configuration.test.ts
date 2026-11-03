import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Application, loadSkill } from '../src/application/index.js';
import { KodoError } from '../src/runtime/types.js';
import type { Message, Provider, Run } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, temp } from './helpers.js';

type Request = Parameters<Provider['complete']>[0];
function operation(app: Application, runId: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return app.store.transaction(() => {
    const run = app.store.run(runId);
    return app.coordinator.mailbox.execute(run, `${name}-call`, name, app.coordinator.mailbox.validate(run, name, JSON.stringify(args))) as Record<string, unknown>;
  });
}
function expectKodo(action: () => unknown, code: string): KodoError {
  try { action(); }
  catch (error) {
    expect(error).toBeInstanceOf(KodoError);
    expect((error as KodoError).code).toBe(code);
    return error as KodoError;
  }
  throw new Error(`expected KodoError ${code}`);
}
const children = (app: Application, run: Run) => app.store.listRuns(run.sessionId).filter(child => child.parentId);
const packet = (app: Application, child: Run) => JSON.stringify(app.store.readBlob<Message[]>(child.contextRef));

describe('spawn_agent configuration: ad-hoc agents without registered cards', () => {
  it('derives a narrowed child card with its own digest and leaves the registered base untouched', () => {
    const { app, runId } = fixture();
    const parent = app.store.run(runId);
    const spawned = operation(app, runId, 'spawn_agent', {
      objective: 'Review src/pager.mjs against docs/api.md',
      permissions: ['read'],
      scope: { read: ['src', 'docs'], write: [] },
      configuration: { instructions: 'Compare documented and implemented behaviour; cite both sources for each difference.', tools: ['file.search', 'file.read'] },
    }) as { id: string; card: { id: string; digest: string; derivedFrom: { id: string; version: string; digest: string } } };
    const child = app.store.run(spawned.id);
    expect(child.card.tools).toEqual(['file.read', 'file.search']);
    expect(child.card.digest).not.toBe(parent.card.digest);
    expect(child.card.derivedFrom).toEqual({ id: parent.card.id, version: parent.card.version, digest: parent.card.digest });
    expect(spawned.card).toMatchObject({ id: child.card.id, digest: child.card.digest, derivedFrom: child.card.derivedFrom });
    expect(Object.keys(child.toolBindings!).sort()).toEqual(['artifact.read', 'file.read', 'file.search', 'history.read', 'history.search', 'recovery.inspect']);
    expect(packet(app, child)).toContain('Task-specific method from the delegating agent');
    expect(packet(app, child)).toContain('cite both sources');
    // The derived card is never registered and the registered version is unchanged.
    expectKodo(() => app.store.card(child.card.id, child.card.version), 'CARD_NOT_FOUND');
    expect(app.store.card(parent.card.id, parent.card.version)).toEqual(parent.card);
  });

  it('gives different configurations different identities and the same configuration a stable one', () => {
    const { app, runId } = fixture();
    const spawn = (configuration: Record<string, unknown>) => app.store.run((operation(app, runId, 'spawn_agent', { objective: 'Check', permissions: ['read'], configuration }) as { id: string }).id).card;
    const first = spawn({ tools: ['file.read', 'file.list'] });
    const reordered = spawn({ tools: ['file.list', 'file.read'] });
    const method = spawn({ tools: ['file.read', 'file.list'], instructions: 'Only report contradictions.' });
    const none = spawn({ tools: [] });
    expect(reordered.digest).toBe(first.digest);
    expect(method.digest).not.toBe(first.digest);
    expect(none.tools).toEqual([]);
    expect(none.digest).not.toBe(first.digest);
    // Inheritance keeps the legacy child view: no configuration, no derived identity.
    const plain = app.store.run((operation(app, runId, 'spawn_agent', { objective: 'Plain' }) as { id: string }).id).card;
    expect(plain.derivedFrom).toBeUndefined();
    expect(plain.id).toBe(app.store.run(runId).card.id);
  });

  it('refuses widening, unusable or blank configurations before creating any child', () => {
    const { app, runId } = fixture();
    const run = app.store.run(runId);
    const attempt = (args: Record<string, unknown>, code: string) => expectKodo(() => operation(app, runId, 'spawn_agent', { objective: 'Try', ...args }), code);
    expect(attempt({ configuration: { tools: ['file.read', 'mcp.deploy'] } }, 'CONFIGURATION_DENIED').message).toContain('mcp.deploy');
    // Delegation tools are removed from every child view, so they cannot be re-selected.
    attempt({ configuration: { tools: ['agent.route'] } }, 'CONFIGURATION_DENIED');
    expect(attempt({ permissions: ['read'], configuration: { tools: ['file.read', 'file.patch'] } }, 'CONFIGURATION_DENIED').message).toContain('file.patch');
    attempt({ configuration: { skills: ['evidence'] } }, 'CONFIGURATION_DENIED');
    attempt({ configuration: { instructions: '   ' } }, 'TOOL_ARGUMENTS');
    attempt({ configuration: { tools: ['file.read'], model: 'x' } }, 'TOOL_ARGUMENTS');
    expect(children(app, run)).toHaveLength(0);
    expect(app.store.run(runId).waitId).toBeUndefined();
  });

  it('narrows a skill-bearing card and keeps the pinned contract across a restart', async () => {
    const root = temp();
    const file = path.join(root, 'SKILL.md');
    writeFileSync(file, '---\nname: evidence\ndescription: Inspect actual evidence\n---\nVerify the deliverable before reporting.\n', 'utf8');
    const skill = await loadSkill(file);
    const state = path.join(root, '.state');
    const childTools: string[][] = [];
    const provider: Provider = { async complete(request: Request) {
      const system = request.messages.find(message => message.role === 'system')?.content ?? '';
      const id = /Run ID: ([^. ]+)\./u.exec(system)![1]!;
      const run = second.store.run(id);
      if (run.parentId) { childTools.push(request.tools.map(tool => tool.name)); return answer('Reviewed with the evidence skill only.'); }
      if (run.step === 0) return calls(call('wait_for_events', { run_ids: [childId] }, 'wait'));
      return answer('Child finished.');
    } };
    const first = new Application(state, provider, undefined, { skills: [skill], agentFactors: { D: false, E: false, B: false } });
    const card = first.parseCard('---\nschema_version: 1\nid: local/reviewer\nversion: 1.0.0\nname: Reviewer\ndescription: Review with skills\ncapabilities:\n  tools: [file.read, file.search, skill.list, skill.load]\n  skills: [evidence]\n---\nReview carefully.\n');
    first.registerCard(card);
    const main = first.createRun({ objective: 'Review the project.', workspace: root, binding, card, permissions: ['read'] });
    expectKodo(() => operation(first, main.id, 'spawn_agent', { objective: 'x', configuration: { tools: ['file.read'], skills: ['evidence'] } }), 'CONFIGURATION_DENIED');
    const childId = (operation(first, main.id, 'spawn_agent', { objective: 'Review src', configuration: { tools: ['file.read', 'skill.load'], skills: ['evidence'] } }) as { id: string }).id;
    const created = first.store.run(childId);
    expect(created.card).toMatchObject({ tools: ['file.read', 'skill.load'], skills: ['evidence'], derivedFrom: { id: 'local/reviewer', version: '1.0.0', digest: card.digest } });
    await first.shutdown();
    const second = new Application(state, provider, undefined, { skills: [skill], agentFactors: { D: false, E: false, B: false } });
    try {
      const done = await second.run(main.id);
      expect(done.status, done.error).toBe('completed');
      expect(second.store.run(childId)).toMatchObject({ status: 'completed', card: created.card, toolBindings: created.toolBindings });
      expect(childTools[0]!.filter(name => !name.startsWith('history.') && !['list_agents', 'update_progress', 'inspect_run', 'send_message', 'wait_for_events'].includes(name)).sort()).toEqual(['artifact.read', 'file.read', 'recovery.inspect', 'skill.load']);
    } finally { await second.shutdown(); }
  });

  it('keeps explore on the same resolver: read-only view, no skills, unchanged packet contract', () => {
    const { app, runId } = fixture();
    const result = operation(app, runId, 'explore', { tasks: [{ prompt: 'Where is backoff defined?', thoroughness: 'quick' }] }) as { runs: { id: string }[] };
    const child = app.store.run(result.runs[0]!.id);
    expect(child.card.derivedFrom).toBeUndefined();
    expect(child.card.skills).toEqual([]);
    expect(child.card.tools.every(name => ['file.read', 'file.list', 'file.search', 'image.read'].includes(name))).toBe(true);
    expect(packet(app, child)).toContain('quick (fact lookup)');
  });

  it('applies an explore configuration through the same resolver and keeps the child read-only', () => {
    const { app, runId } = fixture();
    const parent = app.store.run(runId);
    const result = operation(app, runId, 'explore', { tasks: [
      { prompt: 'Where is backoff defined?', thoroughness: 'quick', configuration: { instructions: 'Only report the defining file and line.', tools: ['file.search', 'file.read'] } },
      { prompt: 'Map the storage module' },
    ] }) as { runs: { id: string }[] };
    const [configured, plain] = result.runs.map(item => app.store.run(item.id));
    expect(configured!.card).toMatchObject({ tools: ['file.read', 'file.search'], skills: [], derivedFrom: { id: parent.card.id, version: parent.card.version, digest: parent.card.digest } });
    expect(configured!.permissions).toEqual(['read']);
    expect(configured!.scope?.write).toEqual([]);
    expect(packet(app, configured!)).toContain('Only report the defining file and line.');
    expect(packet(app, configured!)).toContain('quick (fact lookup)');
    expect(plain!.card.derivedFrom).toBeUndefined();
  });

  it('refuses an explore batch whose configuration widens beyond read-only, creating no child or wait', () => {
    const { app, runId } = fixture();
    const run = app.store.run(runId);
    const attempt = (configuration: Record<string, unknown>, code: string) => expectKodo(() => operation(app, runId, 'explore', { tasks: [{ prompt: 'ok' }, { prompt: 'bad', configuration }] }), code);
    expect(attempt({ tools: ['file.read', 'file.patch'] }, 'CONFIGURATION_DENIED').message).toContain('file.patch');
    attempt({ tools: ['file.read', 'process.exec'] }, 'CONFIGURATION_DENIED');
    attempt({ tools: ['file.search'] }, 'EXPLORATION_CAPABILITY');
    attempt({ skills: ['evidence'] }, 'CONFIGURATION_DENIED');
    expect(children(app, run)).toHaveLength(0);
    expect(app.store.run(runId).waitId).toBeUndefined();
  });

  it('lets explore select a skill of the base card explicitly instead of silently dropping it', async () => {
    const root = temp();
    const file = path.join(root, 'SKILL.md');
    writeFileSync(file, '---\nname: evidence\ndescription: Inspect actual evidence\n---\nVerify the deliverable before reporting.\n', 'utf8');
    const skill = await loadSkill(file);
    const app = new Application(path.join(root, '.state'), { async complete() { return answer(); } }, undefined, { skills: [skill], agentFactors: { D: false, E: false, B: false } });
    try {
      const card = app.parseCard('---\nschema_version: 1\nid: local/reviewer\nversion: 1.0.0\nname: Reviewer\ndescription: Review with skills\ncapabilities:\n  tools: [file.read, file.search, file.patch, skill.list, skill.load]\n  skills: [evidence]\n---\nReview carefully.\n');
      app.registerCard(card);
      const main = app.createRun({ objective: 'Review.', workspace: root, binding, card, permissions: ['read', 'write'] });
      const result = operation(app, main.id, 'explore', { tasks: [{ prompt: 'Default view' }, { prompt: 'With skill', configuration: { tools: ['file.read', 'skill.load'], skills: ['evidence'] } }] }) as { runs: { id: string }[] };
      const [defaults, withSkill] = result.runs.map(item => app.store.run(item.id));
      expect(defaults!.card).toMatchObject({ tools: ['file.read', 'file.search'], skills: [] });
      expect(withSkill!.card).toMatchObject({ tools: ['file.read', 'skill.load'], skills: ['evidence'] });
      expect(Object.keys(withSkill!.toolBindings!)).toContain('skill.load');
    } finally { await app.shutdown(); }
  });
});
