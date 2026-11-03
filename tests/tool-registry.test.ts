import { describe, expect, it } from 'vitest';
import { ToolRegistry, toolFingerprint } from '../src/tools/registry.js';
import { assertRunCapabilities } from '../src/tools/bindings.js';
import { Tools } from '../src/tools/index.js';
import type { ToolRegistration } from '../src/tools/registry.js';
import { binding, fixture } from './helpers.js';

const schema = (): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties: { value: { type: 'string', minLength: 2 } }, required: ['value'] });
const registration = (name = 'custom.read'): ToolRegistration => ({ name, description: 'Read a host-approved value.', permission: 'read', effect: 'read', parameters: schema(), execute: (_context, args) => args.value });

describe('host tool registry', () => {
  it('hides unavailable host service schemas while pinning their immutable availability', () => {
    const { app, root } = fixture();
    const card = app.parseCard(`---
schema_version: 1
id: test/unavailable-services
version: 1.0.0
name: Unavailable host services
description: Preserve explicit service contracts even when their host is unavailable.
capabilities:
  tools: [web.fetch, lsp.hover]
---
Inspect service availability.
`);
    const run = app.createRun({ objective: 'Inspect unavailable services.', workspace: root, binding, card });
    const session = app.store.session(run.sessionId);
    const tools = app.coordinator.tools;
    const names = tools.specs(run.card.tools, session).map(tool => tool.name);
    expect(names).not.toContain('web.fetch');
    expect(names.some(name => name.startsWith('lsp.'))).toBe(false);
    expect(run.toolBindings).toHaveProperty('web.fetch');
    expect(run.toolBindings).toHaveProperty('lsp.hover');
    expect(() => tools.validate('web.fetch', JSON.stringify({ url: 'https://example.com' }), [], session)).toThrow('not authorized');
    const definition = { ...registration(), available: false };
    const registry = new ToolRegistry();
    registry.register(definition);
    definition.available = true;
    expect(registry.specs()).toEqual([]);
    expect(registry.get('custom.read')!.available).toBe(false);
    expect(toolFingerprint({ ...definition, available: true })).not.toBe(toolFingerprint(registry.get('custom.read')!));
    expect(() => registry.register({ ...registration('bad.available'), available: 'yes' as unknown as boolean })).toThrow('availability');
  });
  it('keeps an immutable schema and callback snapshot and rejects replacement', () => {
    const registry = new ToolRegistry();
    const definition = registration();
    registry.register(definition);
    (definition.parameters.properties as Record<string, Record<string, unknown>>).value!.minLength = 1;
    definition.name = 'changed.name';
    definition.execute = () => 'changed';
    const registered = registry.get('custom.read')!;
    expect(registered.validate({ value: 'a' })).toBe(false);
    expect(registered.validate({ value: 'ab' })).toBe(true);
    expect(registered.execute).not.toBe(definition.execute);
    expect(Object.isFrozen(registered)).toBe(true);
    const publicParameters = registry.specs()[0]!.parameters;
    expect(Object.isFrozen(publicParameters)).toBe(true);
    expect(Object.isFrozen(publicParameters.properties)).toBe(true);
    expect(() => registry.register(registration())).toThrow('reserved or collides');
    const entries = registry.definitions();
    entries.length = 0;
    expect(registry.definitions()).toHaveLength(1);
  });

  it('pins canonical schemas, permission, effects and explicit callback versions', () => {
    const definition = { ...registration(), version: '1.0.0' };
    const fingerprint = toolFingerprint(definition);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const reordered = { ...definition, parameters: { required: ['value'], properties: { value: { minLength: 2, type: 'string' } }, additionalProperties: false, type: 'object' } };
    expect(toolFingerprint(reordered)).toBe(fingerprint);
    expect(toolFingerprint({ ...definition, version: '2.0.0' })).not.toBe(fingerprint);
    expect(toolFingerprint({ ...definition, permission: 'write' })).not.toBe(fingerprint);
    expect(toolFingerprint({ ...definition, effect: 'write' })).not.toBe(fingerprint);
    expect(toolFingerprint({ ...definition, description: 'A changed contract.' })).not.toBe(fingerprint);
    expect(toolFingerprint({ ...definition, parameters: { ...schema(), required: [] } })).not.toBe(fingerprint);
    const registry = new ToolRegistry();
    registry.register(definition);
    definition.version = '2.0.0';
    expect(registry.get('custom.read')!.version).toBe('1.0.0');
    for (const version of ['', ' ', 'x'.repeat(201)]) expect(() => registry.register({ ...registration('another.tool'), version })).toThrow('tool version');
  });

  it('rejects missing or changed restored tool contracts and unpinned legacy extensions', () => {
    const { app, runId } = fixture();
    const original = new ToolRegistry();
    original.register({ ...registration(), version: '1.0.0' });
    const fingerprint = toolFingerprint(original.get('custom.read')!);
    const current = { 'custom.read': fingerprint, 'history.read': 'history-fingerprint' };
    const run = { ...app.store.run(runId), card: { ...app.store.run(runId).card, tools: ['custom.read'] }, toolBindings: current };
    const tools = { bindingSnapshot: () => ({ ...current }) };
    expect(() => assertRunCapabilities(run, tools)).not.toThrow();
    const restored = new ToolRegistry();
    restored.register({ ...registration(), version: '2.0.0' });
    expect(() => assertRunCapabilities(run, { bindingSnapshot: () => ({ ...current, 'custom.read': toolFingerprint(restored.get('custom.read')!) }) })).toThrow('pinned host contract');
    expect(() => assertRunCapabilities(run, { bindingSnapshot: () => ({ 'history.read': current['history.read'] }) })).toThrow('no longer installed');
    expect(() => assertRunCapabilities({ ...run, toolBindings: undefined }, tools)).toThrow('no pinned host contract');
    for (const name of ['shell.exec', 'image.read']) expect(() => assertRunCapabilities({ ...run, card: { ...run.card, tools: [name] }, toolBindings: undefined }, { bindingSnapshot: () => ({ [name]: 'new-tool', 'history.read': 'history' }) })).toThrow('no pinned host contract');
    const legacy = { ...run, card: { ...run.card, tools: ['file.read'] }, toolBindings: undefined };
    expect(() => assertRunCapabilities(legacy, { bindingSnapshot: () => ({ 'file.read': 'builtin', 'history.read': 'builtin-history' }) })).not.toThrow();
    expect(() => assertRunCapabilities({ ...run, card: { ...run.card, tools: [] } }, { bindingSnapshot: () => ({ 'history.read': current['history.read'] }) })).not.toThrow();
  });

  it('checks persisted bindings against fresh host registrations and read-only command declarations', () => {
    const { app, runId } = fixture();
    const tools = app.coordinator.tools;
    tools.register({ ...registration(), version: '1.0.0' });
    const original = app.store.run(runId);
    app.store.updateRun(runId, { card: { ...original.card, tools: ['custom.read'] }, toolBindings: tools.bindingSnapshot(['custom.read']) });
    const sameHost = new Tools(app.store);
    sameHost.register({ ...registration(), version: '1.0.0' });
    expect(() => assertRunCapabilities(app.store.run(runId), sameHost)).not.toThrow();
    const upgradedHost = new Tools(app.store);
    upgradedHost.register({ ...registration(), version: '2.0.0' });
    expect(() => assertRunCapabilities(app.store.run(runId), upgradedHost)).toThrow('pinned host contract');
    const commands = new Tools(app.store, [{ program: 'host-check', args: ['--read-only'] }]);
    const changedCommands = new Tools(app.store, [{ program: 'host-check', args: ['--different'] }]);
    expect(commands.bindingSnapshot(['process.run'])['process.run']).not.toBe(changedCommands.bindingSnapshot(['process.run'])['process.run']);
  });

  it('snapshots trusted command declarations against later host array and argument mutations', () => {
    const { app, runId } = fixture();
    const declarations = [{ program: 'host-check', args: ['--read-only'] }];
    const tools = new Tools(app.store, declarations);
    const session = app.store.session(app.store.run(runId).sessionId);
    const beforeSpecs = tools.specs(['process.run'], session);
    const beforeBindings = tools.bindingSnapshot(['process.run']);
    declarations[0]!.program = 'changed-program';
    declarations[0]!.args.push('--unsafe');
    declarations.push({ program: 'new-program', args: [] });
    expect(tools.specs(['process.run'], session)).toEqual(beforeSpecs);
    expect(tools.bindingSnapshot(['process.run'])).toEqual(beforeBindings);
    expect(tools.validate('process.run', JSON.stringify({ program: 'host-check', args: ['--read-only'] }), ['process.run'], session)).toEqual({ program: 'host-check', args: ['--read-only'] });
    for (const command of declarations) expect(() => tools.validate('process.run', JSON.stringify(command), ['process.run'], session)).toThrow('not declared read-only');
  });

  it('reserves builtins, coordination tools and names that collide on the provider wire', () => {
    const registry = new ToolRegistry(['file.read']);
    for (const name of ['file.read', 'file_read', 'ask_user', 'ask.user', 'spawn_agent', 'send_message']) {
      expect(() => registry.register(registration(name))).toThrow('reserved or collides');
    }
    registry.register(registration('custom.read'));
    expect(() => registry.register(registration('custom_read'))).toThrow('reserved or collides');
    for (const name of ['', 'with spaces', '1start', 'bad/name', 'a'.repeat(65)]) {
      expect(() => registry.register(registration(name))).toThrow('protocol-safe');
    }
  });

  it('rejects invalid or lossy schemas before reserving the tool name', () => {
    const registry = new ToolRegistry();
    for (const parameters of [{ type: 'array' }, { type: 'object', unknownKeyword: true }, { type: 'object', title: undefined }, { type: 'object', minimum: Infinity }]) {
      expect(() => registry.register({ ...registration(), parameters })).toThrow('valid JSON schema');
    }
    registry.register(registration());
    expect(registry.specs().map(tool => tool.name)).toEqual(['custom.read']);
    expect(() => registry.register({ ...registration('unsafe.write'), effect: 'write' })).toThrow('write or exec permission');
  });

  it('requires card approval and valid arguments before invoking a registered tool', async () => {
    const { app, runId } = fixture(undefined, ['read']);
    const tools = app.coordinator.tools;
    let executions = 0;
    tools.register({ ...registration(), execute: (context, args) => {
      executions++;
      expect(context.run.id).toBe(runId);
      expect(context.session.id).toBe(app.store.run(runId).sessionId);
      return { value: args.value };
    } });
    const signal = new AbortController().signal;
    const initial = app.store.run(runId);
    const session = app.store.session(initial.sessionId);
    expect(tools.specs(initial.card.tools, session).some(tool => tool.name === 'custom.read')).toBe(false);
    await expect(tools.execute(runId, 'custom.read', { value: 'ok' }, signal)).rejects.toThrow('not authorized');
    expect(executions).toBe(0);
    const run = app.store.run(runId);
    app.store.updateRun(runId, { card: { ...run.card, tools: [...run.card.tools, 'custom.read'] } });
    expect(tools.specs(app.store.run(runId).card.tools, session).some(tool => tool.name === 'custom.read')).toBe(true);
    await expect(tools.execute(runId, 'custom.read', { value: 'a' }, signal)).rejects.toThrow('schema');
    expect(executions).toBe(0);
    await expect(tools.execute(runId, 'custom.read', { value: 'okay', extra: true }, signal)).rejects.toThrow('schema');
    await expect(tools.execute(runId, 'custom.read', { value: 'okay' }, signal)).resolves.toEqual({ value: 'okay' });
    expect(executions).toBe(1);
    const aborted = new AbortController();
    aborted.abort(new Error('cancelled'));
    await expect(tools.execute(runId, 'custom.read', { value: 'okay' }, aborted.signal)).rejects.toThrow('cancelled');
    expect(executions).toBe(1);
  });

  it('denies registered writes under session or run permission narrowing', async () => {
    const { app, runId } = fixture();
    let executions = 0;
    const tools = app.coordinator.tools;
    tools.register({ ...registration('custom.write'), permission: 'write', effect: 'write', execute: () => { executions++; } });
    const run = app.store.run(runId);
    app.store.updateRun(runId, { permissions: ['read'], card: { ...run.card, tools: [...run.card.tools, 'custom.write'] } });
    await expect(tools.execute(runId, 'custom.write', { value: 'okay' }, new AbortController().signal)).rejects.toThrow('not authorized');
    app.store.updateRun(runId, { permissions: undefined });
    app.store.putSession({ ...app.store.session(run.sessionId), permissions: ['read'] });
    await expect(tools.execute(runId, 'custom.write', { value: 'okay' }, new AbortController().signal)).rejects.toThrow('not authorized');
    expect(executions).toBe(0);
  });

  it('isolates callback record mutations from persisted records and later tool authorization', async () => {
    const { app, runId } = fixture(undefined, ['read']);
    const tools = app.coordinator.tools;
    let unauthorizedExecutions = 0;
    tools.register({ ...registration('custom.write'), permission: 'write', effect: 'write', execute: () => { unauthorizedExecutions++; } });
    tools.register({ ...registration('custom.forbidden'), execute: () => { unauthorizedExecutions++; } });
    tools.register({ ...registration('custom.inspect'), execute: async context => {
      context.run.id = 'changed-run';
      context.run.sessionId = 'changed-session';
      context.run.permissions!.push('write', 'exec');
      context.run.card.tools.push('custom.forbidden');
      context.run.card.prompt = 'A forged authorization instruction.';
      context.run.binding.model = 'changed-model';
      context.run.binding.limits!.context = 1;
      context.run.toolBindings!['custom.write'] = 'forged-binding';
      context.run.scope!.write!.push('.');
      context.session.permissions.push('write', 'exec');
      context.session.workspace = 'changed-workspace';
      context.session.budget.maxToolCalls = 1_000_000;
      await expect(tools.execute(runId, 'custom.write', { value: 'okay' }, context.signal)).rejects.toThrow('not authorized');
      await expect(tools.execute(runId, 'custom.forbidden', { value: 'okay' }, context.signal)).rejects.toThrow('not authorized');
      return 'inspected';
    } });
    const original = app.store.run(runId);
    const card = { ...original.card, tools: [...original.card.tools, 'custom.inspect', 'custom.write'] };
    app.store.updateRun(runId, { card, permissions: ['read'], scope: { read: ['.'], write: [] }, toolBindings: tools.bindingSnapshot(card.tools) });
    const beforeRun = app.store.run(runId);
    const beforeSession = app.store.session(beforeRun.sessionId);
    await expect(tools.execute(runId, 'custom.inspect', { value: 'okay' }, new AbortController().signal)).resolves.toBe('inspected');
    expect(unauthorizedExecutions).toBe(0);
    expect(app.store.run(runId)).toEqual(beforeRun);
    expect(app.store.session(beforeRun.sessionId)).toEqual(beforeSession);
  });

  it('serializes registered writes, tracks their effects once and cancels queued work', async () => {
    const { app, runId } = fixture();
    const tools = app.coordinator.tools;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let executions = 0;
    let effects = 0;
    tools.register({ ...registration('custom.write'), permission: 'write', effect: 'write', execute: async context => {
      executions++;
      context.markEffectStarted();
      entered();
      await ready;
      return 'written';
    } });
    const run = app.store.run(runId);
    app.store.updateRun(runId, { card: { ...run.card, tools: [...run.card.tools, 'custom.write'] } });
    const first = tools.execute(runId, 'custom.write', { value: 'okay' }, new AbortController().signal, () => { effects++; });
    await started;
    const controller = new AbortController();
    const second = tools.execute(runId, 'custom.write', { value: 'okay' }, controller.signal, () => { effects++; });
    controller.abort(new Error('queued cancellation'));
    await expect(second).rejects.toThrow('queued cancellation');
    expect(executions).toBe(1);
    release();
    await expect(first).resolves.toBe('written');
    expect(effects).toBe(1);
  });
});
