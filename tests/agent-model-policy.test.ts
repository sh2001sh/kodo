import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application/index.js';
import type { ApplicationOptions } from '../src/application/index.js';
import { Mailbox } from '../src/messaging/index.js';
import type { Message, ModelBinding, Provider, Run } from '../src/runtime/types.js';
import { answer, binding, scripted, temp } from './helpers.js';

const apps: Application[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.shutdown(); });
function setup(options: ApplicationOptions = {}, provider: Provider = scripted(), directory = path.join(temp(), '.state')) {
  const app = new Application(directory, provider, undefined, { compaction: false, instructions: { global: false }, ...options, agentFactors: { D: false, E: false, B: false, ...options.agentFactors } });
  apps.push(app);
  return { app, root: path.dirname(directory), directory };
}
const aliases = (): Record<string, ModelBinding> => ({
  cheap: { ...binding, model: 'fast-model', provider: 'fast-provider', limits: { context: 16_000, output: 1000 } },
  careful: { ...binding, model: 'strong-model', provider: 'strong-provider', limits: { context: 512_000, output: 16_000 } },
});
function operate(mailbox: Mailbox, parent: Run, name: string, args: Record<string, unknown>): { id: string } {
  const result = mailbox.execute(parent, crypto.randomUUID(), name, mailbox.validate(parent, name, JSON.stringify(args))) as { id: string };
  return result;
}
function child(app: Application, parent: Run, args: Record<string, unknown> = {}): Run {
  const result = operate(app.coordinator.mailbox, parent, 'spawn_agent', { objective: 'Inspect one bounded question', ...args });
  return app.store.run(result.id);
}
function selected(app: Application, run: Run) { return app.store.events(run.id, { types: ['agent.model_selected'] }).map(event => event.data); }

describe('session-frozen child model policy', () => {
  it('freezes alias bindings, role mappings and user descriptions independently of caller mutation', () => {
    const models = aliases(), descriptions = { cheap: 'Fast for narrow investigations', careful: '' };
    const roles: ApplicationOptions['modelRoles'] = { fast: 'cheap', strong: 'careful' };
    const { app, root } = setup({ modelBindings: models, modelBindingDescriptions: descriptions, modelRoles: roles });
    const parent = app.createRun({ objective: 'Coordinate a bounded task', workspace: root, binding });
    models.cheap!.model = 'changed-after-construction'; descriptions.cheap = 'changed description'; roles.fast = 'careful';
    const session = app.store.session(parent.sessionId);
    expect(session.modelBindings).toEqual(aliases());
    expect(session.modelBindingDescriptions).toEqual({ cheap: 'Fast for narrow investigations', careful: '' });
    expect(session.modelRoles).toEqual({ fast: 'cheap', strong: 'careful' });
    const specs = app.coordinator.mailbox.specs(parent);
    for (const name of ['spawn_agent', 'followup_task']) {
      const parameters = specs.find(tool => tool.name === name)!.parameters;
      expect(parameters).toMatchObject({ properties: { model_binding: { enum: ['cheap', 'careful'], description: expect.stringContaining('Fast for narrow investigations') } } });
      expect(JSON.stringify(parameters)).not.toContain(binding.baseURL);
      expect(JSON.stringify(parameters)).not.toContain(binding.apiKeyEnv);
      expect(JSON.stringify(parameters)).not.toContain('changed description');
    }
  });

  it('distinguishes an explicitly empty frozen policy from omitted legacy host policy', () => {
    for (const frozen of [false, true]) {
      const { app, root } = setup(frozen ? { modelBindings: {}, modelBindingDescriptions: {} } : {});
      const parent = app.createRun({ objective: 'Coordinate a bounded task', workspace: root, binding });
      const session = app.store.session(parent.sessionId);
      expect(Object.hasOwn(session, 'modelBindings')).toBe(frozen);
      expect(Object.hasOwn(session, 'modelBindingDescriptions')).toBe(frozen);
      const mailbox = new Mailbox(app.store, () => {}, { modelBindings: aliases() });
      const create = () => mailbox.spawnHost(parent.id, { objective: 'Inspect a bounded question', model_binding: 'cheap' });
      if (frozen) {
        expect(session.modelBindings).toEqual({});
        expect(() => create()).toThrow('host-approved');
        expect(mailbox.specs(parent).find(tool => tool.name === 'spawn_agent')!.parameters).toMatchObject({ properties: expect.not.objectContaining({ model_binding: expect.anything() }) });
        expect(app.store.listRuns()).toHaveLength(1);
      } else expect(app.store.run(String(create().id)).binding.model).toBe('fast-model');
    }
  });

  it('uses the original session allowlist and descriptions after reopening with different host aliases', async () => {
    const { app, root, directory } = setup({ modelBindings: aliases(), modelBindingDescriptions: { cheap: 'Original user description' }, modelRoles: { fast: 'cheap' } });
    const parent = app.createRun({ objective: 'Preserve the original choices', workspace: root, binding });
    await app.shutdown();
    const changed = aliases(); changed.cheap = { ...changed.cheap!, model: 'replacement-model' }; changed.newAlias = { ...binding, model: 'new-model' };
    const reopened = setup({ modelBindings: changed, modelBindingDescriptions: { cheap: 'New host description' }, modelRoles: { fast: 'careful' } }, scripted(), directory).app;
    const originalParent = reopened.store.run(parent.id);
    const params = reopened.coordinator.mailbox.specs(originalParent).find(tool => tool.name === 'spawn_agent')!.parameters;
    expect(params).toMatchObject({ properties: { model_binding: { enum: ['cheap', 'careful'], description: expect.stringContaining('Original user description') } } });
    expect(JSON.stringify(params)).not.toContain('New host description');
    const spawned = reopened.spawnAgent(parent.sessionId, { objective: 'Continue within the frozen policy', model_binding: 'cheap' });
    expect(spawned.binding.model).toBe('fast-model');
    expect(() => reopened.spawnAgent(parent.sessionId, { objective: 'Use an unapproved new alias', model_binding: 'newAlias' })).toThrow('host-approved');
    expect(reopened.store.session(parent.sessionId).modelRoles).toEqual({ fast: 'cheap' });
  });

  it('selects new children by explicit alias or inheritance and never changes the main model', () => {
    const complete = vi.fn<Provider['complete']>();
    const { app, root } = setup({ modelBindings: aliases(), modelBindingDescriptions: { cheap: 'Fast for bounded reads' }, modelRoles: { fast: 'cheap' } }, { complete });
    const parent = app.createRun({ objective: 'Use specialized child models', workspace: root, binding });
    const explicit = child(app, parent, { model_binding: 'careful' });
    const inherited = child(app, parent);
    expect(explicit).toMatchObject({ modelBindingId: 'careful', binding: { model: 'strong-model' }, modelLimits: { context: 512_000, output: 16_000 } });
    expect(inherited.binding).toEqual(binding);
    expect(inherited.modelBindingId).toBeUndefined();
    expect(selected(app, explicit)).toEqual([{ alias: 'careful', model: 'strong-model', provider: 'strong-provider', reason: 'explicit' }]);
    expect(selected(app, inherited)).toEqual([{ model: binding.model, reason: 'inherit' }]);
    expect(app.store.run(parent.id).binding).toEqual(binding); expect(complete).not.toHaveBeenCalled();
  });

  it('keeps role mappings session-frozen while children inherit the main binding', () => {
    const { app, root } = setup({ modelBindings: aliases(), modelRoles: { fast: 'cheap' } });
    const parent = app.createRun({ objective: 'Coordinate a role without a mapping', workspace: root, binding });
    expect(app.store.session(parent.sessionId).modelRoles).toEqual({ fast: 'cheap' });
    const spawned = child(app, parent);
    expect(spawned.binding).toEqual(binding); expect(spawned.modelBindingId).toBeUndefined();
    expect(selected(app, spawned)).toEqual([{ model: binding.model, reason: 'inherit' }]);
  });

  it.each(['continuation', 'followup'])('keeps the model and complete context on %s without reapplying a card role default', async mode => {
    const { app, root } = setup({ modelBindings: aliases(), modelRoles: { fast: 'cheap' } }, scripted(answer('ORIGINAL_CONTEXT_MARKER')));
    const parent = app.createRun({ objective: 'Coordinate specialist reuse', workspace: root, binding });
    const first = child(app, parent, { model_binding: 'careful' });
    const firstResult = await app.coordinator.wake(first.id);
    expect(firstResult.status, firstResult.error).toBe('completed');
    const original = app.store.run(first.id); const before = app.store.listRuns().length;
    const reuse = (alias?: string) => mode === 'continuation'
      ? child(app, parent, { continuation_of: first.id, ...(alias ? { model_binding: alias } : {}) })
      : app.store.run(operate(app.coordinator.mailbox, parent, 'followup_task', { target: first.agentId!, objective: 'Clarify the previous finding', ...(alias ? { model_binding: alias } : {}) }).id);
    expect(() => reuse('cheap')).toThrow('fresh child');
    expect(app.store.listRuns()).toHaveLength(before);
    const next = reuse();
    expect(next).toMatchObject({ modelBindingId: 'careful', binding: original.binding, agentId: first.agentId, historyFrom: first.id });
    const messages = app.store.readBlob<Message[]>(next.contextRef);
    expect(messages.filter(message => message.role === 'assistant' && message.content === 'ORIGINAL_CONTEXT_MARKER')).toHaveLength(1);
    expect(messages.some(message => message.content?.includes(`Previous run ${first.id}`))).toBe(true);
    expect(selected(app, next)).toEqual([{ alias: 'careful', model: 'strong-model', provider: 'strong-provider', reason: 'reuse' }]);
    expect(app.store.run(first.id)).toEqual(original);
  });

  it('permits explicitly affirming the same alias while preserving the previous binding', async () => {
    const { app, root } = setup({ modelBindings: aliases() }, scripted(answer('prior context')));
    const parent = app.createRun({ objective: 'Coordinate one reusable teammate', workspace: root, binding });
    const first = child(app, parent, { model_binding: 'cheap' }); await app.coordinator.wake(first.id);
    const next = app.store.run(operate(app.coordinator.mailbox, parent, 'followup_task', { target: first.agentId!, objective: 'Continue the investigation', model_binding: 'cheap' }).id);
    expect(next.binding).toEqual(first.binding); expect(selected(app, next)[0]?.reason).toBe('reuse');
  });

  it('rejects unknown aliases from direct host and unvalidated mailbox calls without creating children', () => {
    const { app, root } = setup({ modelBindings: aliases() });
    const parent = app.createRun({ objective: 'Coordinate within the configured choices', workspace: root, binding });
    expect(() => app.spawnAgent(parent.sessionId, { objective: 'Unknown alias', model_binding: 'missing' })).toThrow('host-approved');
    expect(() => app.coordinator.mailbox.spawnHost(parent.id, { objective: 'Unknown alias', model_binding: 'missing' })).toThrow('host-approved');
    expect(() => app.coordinator.mailbox.execute(parent, 'direct', 'spawn_agent', { objective: 'Unknown alias', model_binding: 'missing' })).toThrow('host-approved');
    expect(app.store.listRuns()).toHaveLength(1);
    expect(app.store.events(parent.id, { types: ['agent.model_selected'] })).toEqual([]);
  });

  it('preserves a legacy teammate on omission and rejects the same alias if its host binding changed', () => {
    const { app, root } = setup(); const parent = app.createRun({ objective: 'Reuse a legacy teammate', workspace: root, binding });
    const original = new Mailbox(app.store, () => {}, { modelBindings: aliases() });
    const first = app.store.run(String(original.spawnHost(parent.id, { objective: 'Original legacy task', model_binding: 'cheap' }).id));
    // Isolated synthetic completed fixture; no real result or external records are altered.
    app.store.updateRun(first.id, { status: 'completed', resultRef: app.store.blob({ text: 'SYNTHETIC_LEGACY_CONTEXT' }) });
    const changed = aliases(); changed.cheap = { ...changed.cheap!, model: 'changed-host-model' };
    const mailbox = new Mailbox(app.store, () => {}, { modelBindings: changed });
    expect(() => mailbox.spawnHost(parent.id, { objective: 'Try changed alias', continuation_of: first.id, model_binding: 'cheap' })).toThrow('fresh child');
    const next = app.store.run(String(mailbox.spawnHost(parent.id, { objective: 'Keep the original connection', continuation_of: first.id }).id));
    expect(next.binding).toEqual(first.binding);
    expect(app.store.readBlob<Message[]>(next.contextRef).some(message => message.content === 'SYNTHETIC_LEGACY_CONTEXT')).toBe(true);
  });

  it.each(['bad name', '_leading', 'constructor', 'toString', 'x'.repeat(65)])('rejects invalid configured alias %s before opening storage', alias => {
    const directory = path.join(temp(), '.state');
    expect(() => new Application(directory, scripted(), undefined, { modelBindings: { [alias]: binding } })).toThrow('aliases');
  });

  it.each(['x'.repeat(241), 'line\nbreak', 'hidden\u200bformat'])('rejects invalid model descriptions (%#)', text => {
    expect(() => setup({ modelBindings: aliases(), modelBindingDescriptions: { cheap: text } })).toThrow('model descriptions');
  });

  it('accepts empty descriptions and the 240-character boundary but rejects descriptions and roles for unknown aliases', () => {
    const { app, root } = setup({ modelBindings: aliases(), modelBindingDescriptions: { cheap: '', careful: 'x'.repeat(240) } });
    const parent = app.createRun({ objective: 'Exercise description boundaries', workspace: root, binding });
    expect(app.store.session(parent.sessionId).modelBindingDescriptions).toEqual({ cheap: '', careful: 'x'.repeat(240) });
    expect(() => setup({ modelBindings: aliases(), modelBindingDescriptions: { missing: 'Unknown alias' } })).toThrow('approved aliases');
    expect(() => setup({ modelBindings: aliases(), modelRoles: { fast: 'missing' } })).toThrow('host-approved');
  });
});
