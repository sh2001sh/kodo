import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { Mailbox } from '../src/messaging/index.js';
import { assertFileScope, canAccessFileScope, normalizeFileScope } from '../src/runtime/scope.js';
import type { Provider, Run } from '../src/runtime/types.js';
import type { ToolRegistration } from '../src/tools/registry.js';
import { answer, binding, call, calls, fixture, scripted, temp } from './helpers.js';

function spawn(mailbox: Mailbox, parent: Run, args: Record<string, unknown> = {}): string {
  return (mailbox.execute(parent, 'spawn', 'spawn_agent', mailbox.validate(parent, 'spawn_agent', JSON.stringify({ objective: 'Scoped child', ...args }))) as { id: string }).id;
}

describe('host-approved child models and file scopes', () => {
  it('pins a declared child model and its own limits, and exposes only safe model metadata', () => {
    const { app, runId } = fixture();
    const alternate = { ...binding, model: 'small-model', limits: { context: 16_000, output: 2048 } };
    const mailbox = new Mailbox(app.store, () => {}, { modelBindings: { small: alternate } });
    const parent = app.store.run(runId);
    const childId = spawn(mailbox, parent, { model_binding: 'small', scope: { read: ['src'], write: [] } });
    alternate.model = 'mutated-after-host-registration';
    const child = app.store.run(childId);
    expect(child).toMatchObject({ binding: { model: 'small-model' }, modelBindingId: 'small', modelLimits: { context: 16_000, output: 2048 }, scope: { read: ['src'], write: [] } });
    const peers = mailbox.execute(parent, 'list', 'list_agents', {});
    expect(JSON.stringify(peers)).toContain('small-model');
    expect(JSON.stringify(peers)).not.toContain('apiKeyEnv');
    expect(mailbox.specs(parent).find(tool => tool.name === 'spawn_agent')?.parameters).toMatchObject({ properties: { model_binding: { enum: ['small'] } } });
  });

  it.each(['unknown', '__proto__', 'constructor'])('rejects unapproved binding alias %s without creating a child', alias => {
    const { app, runId } = fixture();
    const mailbox = new Mailbox(app.store, () => {}, { modelBindings: { approved: binding } });
    expect(() => spawn(mailbox, app.store.run(runId), { model_binding: alias })).toThrow();
    expect(app.store.listRuns()).toHaveLength(1);
  });

  it('inherits narrowed permissions, scope and model in a child continuation', () => {
    const { app, runId } = fixture();
    const mailbox = new Mailbox(app.store, () => {}, { modelBindings: { small: { ...binding, model: 'small', limits: { context: 20_000, output: 1000 } } } });
    const parent = app.store.run(runId);
    const childId = spawn(mailbox, parent, { model_binding: 'small', permissions: ['read'], scope: { read: ['src'], write: [] } });
    app.store.updateRun(childId, { status: 'completed' });
    expect(() => spawn(mailbox, parent, { continuation_of: childId, permissions: ['write'] })).toThrow('subset');
    expect(() => spawn(mailbox, parent, { continuation_of: childId, scope: { read: ['.'] } })).toThrow('contained');
    const next = app.store.run(spawn(mailbox, parent, { continuation_of: childId }));
    expect(next).toMatchObject({ binding: { model: 'small' }, modelBindingId: 'small', modelLimits: { context: 20_000 }, permissions: ['read'], scope: { read: ['src'], write: [] } });
    expect(() => mailbox.validate(next, 'spawn_agent', JSON.stringify({ objective: 'escape' }))).toThrow('not available to a child');
  });

  it.each([
    { model: 'small', context: 20_000, output: 1000 },
    { model: 'large', context: 512_000, output: 16_384 },
  ])('uses the $model binding and independent output window in actual provider requests', async limits => {
    const root = temp();
    const seen: { model: string; output: number }[] = [];
    const provider: Provider = scripted(async request => {
      seen.push({ model: request.binding.model, output: request.maxOutputTokens });
      return answer('child complete');
    });
    const app = new Application(path.join(root, '.state'), provider, undefined, { agentFactors: { D: false, E: false, B: false }, modelBindings: { selected: { ...binding, model: limits.model, limits: { context: limits.context, output: limits.output } } } });
    try {
      const parent = app.createRun({ objective: 'Main', workspace: root, binding });
      const childId = spawn(app.coordinator.mailbox, parent, { model_binding: 'selected' });
      expect((await app.coordinator.wake(childId)).status).toBe('completed');
      expect(seen).toEqual([{ model: limits.model, output: limits.output }]);
    } finally { app.close(); }
  });

  it('retains an explicit host output ceiling across model selection', async () => {
    const root = temp();
    const provider = scripted(async request => {
      expect(request.binding.model).toBe('large');
      expect(request.maxOutputTokens).toBe(800);
      return answer('capped child complete');
    });
    const app = new Application(path.join(root, '.state'), provider, undefined, { agentFactors: { D: false, E: false, B: false }, modelBindings: { large: { ...binding, model: 'large', limits: { context: 512_000, output: 16_384 } } } });
    try {
      const parent = app.createRun({ objective: 'Main', workspace: root, binding, budget: { maxOutputTokens: 800 } });
      const childId = spawn(app.coordinator.mailbox, parent, { model_binding: 'large' });
      expect((await app.coordinator.wake(childId)).status).toBe('completed');
    } finally { app.close(); }
  });

  it('rejects changing a reused child model and preserves its complete result and original window', async () => {
    const root = temp();
    const marker = 'PREDECESSOR_RESULT_START';
    const largeResult = `${marker}${'x'.repeat(12_000)}PREDECESSOR_RESULT_END`;
    let sourceId = '';
    let observed = false;
    const provider = scripted(answer(largeResult), async request => {
      observed = true;
      const serialized = JSON.stringify(request.messages);
      expect(request.binding.model).toBe(binding.model);
      expect(request.maxOutputTokens).toBe(binding.limits.output);
      expect(serialized.split(marker)).toHaveLength(2);
      expect(serialized).toContain('PREDECESSOR_RESULT_END');
      expect(serialized).toContain(`Previous run ${sourceId}`);
      expect(request.messages.some(message => message.role === 'assistant' && message.content === largeResult)).toBe(true);
      return answer('continued with the same model and context');
    });
    const app = new Application(path.join(root, '.state'), provider, undefined, { agentFactors: { D: false, E: false, B: false }, modelBindings: { small: { ...binding, model: 'small-continuation', limits: { context: 10_000, output: 1000 } } } });
    try {
      const card = app.parseCard(`---
schema_version: 1
id: test/bounded-continuation
version: 1.0.0
name: Bounded continuation test
description: Use predecessor evidence within a small model window.
capabilities:
  tools: []
---
Read the predecessor evidence and report the result.
`);
      const parent = app.createRun({ objective: 'Main', workspace: root, binding, card });
      sourceId = spawn(app.coordinator.mailbox, parent);
      expect(app.store.run(sourceId).historyFrom).toBeUndefined();
      expect((await app.coordinator.wake(sourceId)).status).toBe('completed');
      expect(() => spawn(app.coordinator.mailbox, parent, { continuation_of: sourceId, model_binding: 'small' })).toThrow('fresh child');
      const successorId = spawn(app.coordinator.mailbox, parent, { continuation_of: sourceId });
      expect(app.store.run(successorId).historyFrom).toBe(sourceId);
      const result = await app.coordinator.wake(successorId);
      expect(result.status, result.error).toBe('completed');
      expect(observed).toBe(true);
    } finally { app.close(); }
  });
});

describe('canonical file scope boundaries', () => {
  it('inherits missing lists, permits narrowing, and preserves an explicit deny list', () => {
    expect(normalizeFileScope({ read: ['src\\components/'] }, { read: ['src'], write: [] })).toEqual({ read: ['src/components'], write: [] });
    expect(normalizeFileScope({}, { read: [], write: ['src'] })).toEqual({ read: [], write: ['src'] });
    expect(() => normalizeFileScope({ read: ['src-other'] }, { read: ['src'] })).toThrow('contained');
    expect(() => normalizeFileScope({ write: ['src'] }, { write: [] })).toThrow('contained');
  });

  it.each(['../secret', 'src/../secret', '/absolute', 'C:\\absolute', '\\\\server\\share', 'src:stream', 'NUL', 'aux.txt', 'src/file.', 'src/file ', 'src/*', 'src/\u0000file'])('rejects invalid root %s', root => {
    expect(() => normalizeFileScope({ read: [root] })).toThrow();
  });

  it('checks existing files, new descendants, ancestor traversal and path prefixes', () => {
    const root = temp();
    mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
    mkdirSync(path.join(root, 'src-other'));
    writeFileSync(path.join(root, 'src', 'components', 'view.ts'), 'export {}');
    const scope = { read: ['src/components'], write: ['src/components'] };
    expect(() => assertFileScope(scope, 'read', root, path.join(root, 'src', 'components', 'view.ts'))).not.toThrow();
    expect(() => assertFileScope(scope, 'write', root, path.join(root, 'src', 'components', 'new', 'file.ts'))).not.toThrow();
    expect(() => assertFileScope(scope, 'read', root, path.join(root, 'src-other'))).toThrow();
    expect(() => assertFileScope(scope, 'read', root, path.join(root, 'src'))).toThrow();
    expect(canAccessFileScope(scope, 'read', root, path.join(root, 'src'), true)).toBe(true);
    expect(canAccessFileScope({ read: [] }, 'read', root, root, true)).toBe(false);
    expect(() => assertFileScope(undefined, 'read', root, path.dirname(root))).toThrow();
  });

  it('rejects scope escapes through existing symlink ancestors, including missing targets', () => {
    const root = temp();
    mkdirSync(path.join(root, 'allowed'));
    mkdirSync(path.join(root, 'private'));
    writeFileSync(path.join(root, 'private', 'secret.txt'), 'private');
    symlinkSync(path.join(root, 'private'), path.join(root, 'allowed', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const scope = { read: ['allowed'], write: ['allowed'] };
    expect(() => assertFileScope(scope, 'read', root, path.join(root, 'allowed', 'link', 'secret.txt'))).toThrow();
    expect(() => assertFileScope(scope, 'write', root, path.join(root, 'allowed', 'link', 'new', 'file'))).toThrow();
    expect(() => assertFileScope({ read: ['allowed/link'] }, 'read', root, path.join(root, 'private', 'secret.txt'))).toThrow();
  });
});

describe('agent task progress', () => {
  it('records bounded working notes for main and child without widening authority', () => {
    const { app, runId } = fixture();
    const mailbox = app.coordinator.mailbox;
    const main = app.store.run(runId);
    const child = app.store.run(spawn(mailbox, main, { scope: { read: [], write: [] } }));
    for (const run of [main, child]) {
      const args = mailbox.validate(run, 'update_progress', JSON.stringify({ facts: ['Input loaded'], pending: ['Check the boundary case'] }));
      expect(mailbox.execute(run, 'progress', 'update_progress', args)).toEqual({ facts: ['Input loaded'], completed: [], pending: ['Check the boundary case'], evidence: [] });
      expect(app.store.events(run.id).find(event => event.type === 'task.progress.updated')?.data.progress).toEqual({ facts: ['Input loaded'], completed: [], pending: ['Check the boundary case'], evidence: [] });
    }
    expect(app.store.run(child.id).scope).toEqual({ read: [], write: [] });
    expect(() => mailbox.validate(child, 'update_progress', JSON.stringify({ run_id: main.id, facts: ['Forged peer progress'] }))).toThrow('schema');
    expect(() => mailbox.validate(child, 'update_progress', JSON.stringify({ facts: ['x'.repeat(801)] }))).toThrow('schema');
    expect(() => mailbox.execute(child, 'too-large', 'update_progress', { facts: Array.from({ length: 16 }, () => 'x'.repeat(800)) })).toThrow('8000');
    expect(app.store.events(child.id).filter(event => event.type === 'task.progress.updated')).toHaveLength(1);
  });
});

describe('child host tool contract pinning', () => {
  const customTool = (version: string, execute: ToolRegistration['execute']): ToolRegistration => ({
    name: 'custom.child', description: 'Read the host-approved child value.', version, permission: 'read', effect: 'read',
    parameters: { type: 'object', additionalProperties: false, properties: {} }, execute,
  });
  const childCard = (app: Application) => app.parseCard(`---
schema_version: 1
id: tests/custom-child
version: 1.0.0
name: Custom child
description: Exercise the pinned host tool.
capabilities:
  tools: [custom.child]
---
Read the host value using custom.child and report its evidence.
`);

  it('persists fresh child tool contracts and executes a custom tool through the child loop', async () => {
    const root = temp();
    let executions = 0;
    const app = new Application(path.join(root, '.state'), scripted(calls(call('custom.child', {})), answer('custom child complete')), undefined, { agentFactors: { D: false, E: false, B: false }, tools: [customTool('1.0.0', context => { executions++; return { runId: context.run.id, value: 'child evidence' }; })] });
    try {
      const parent = app.createRun({ objective: 'Main with a custom card', workspace: root, binding, card: childCard(app) });
      const childId = spawn(app.coordinator.mailbox, parent);
      const child = app.store.run(childId);
      expect(child.toolBindings).toEqual(app.coordinator.tools.bindingSnapshot(child.card.tools));
      expect(child.toolBindings?.['custom.child']).toMatch(/^[a-f0-9]{64}$/);
      expect((await app.coordinator.wake(childId)).status).toBe('completed');
      expect(executions).toBe(1);
      expect(app.store.calls(childId).find(operation => operation.name === 'custom.child')?.status).toBe('succeeded');
    } finally { app.close(); }
  });

  it.each(['1.0.0', '2.0.0'])('preserves predecessor contracts across restoration with host tool version %s', async version => {
    const root = temp();
    const directory = path.join(root, '.state');
    const original = new Application(directory, scripted(calls(call('custom.child', {})), answer('original complete')), undefined, { agentFactors: { D: false, E: false, B: false }, tools: [customTool('1.0.0', () => 'original value')] });
    let parentId: string;
    let childId: string;
    let originalBindings: Run['toolBindings'];
    try {
      const card = childCard(original);
      original.registerCard(card);
      const parent = original.createRun({ objective: 'Main with general card', workspace: root, binding });
      parentId = parent.id;
      childId = spawn(original.coordinator.mailbox, parent, { card_id: card.id, card_version: card.version });
      expect((await original.coordinator.wake(childId)).status).toBe('completed');
      originalBindings = original.store.run(childId).toolBindings;
    } finally { original.close(); }
    let executions = 0;
    let requests = 0;
    const delegate = scripted(calls(call('custom.child', {})), answer('continued complete'));
    const provider: Provider = { complete(...args) { requests++; return delegate.complete(...args); } };
    const restored = new Application(directory, provider, undefined, { agentFactors: { D: false, E: false, B: false }, tools: [customTool(version, () => { executions++; return 'continued value'; })] });
    try {
      const continuationId = spawn(restored.coordinator.mailbox, restored.store.run(parentId!), { continuation_of: childId! });
      const continuation = restored.store.run(continuationId);
      expect(continuation.card.id).toBe('tests/custom-child');
      expect(continuation.toolBindings).toEqual(originalBindings!);
      const result = await restored.coordinator.wake(continuationId);
      if (version === '1.0.0') {
        expect(result.status).toBe('completed');
        expect(executions).toBe(1);
        expect(requests).toBe(2);
      } else {
        expect(result.status).toBe('failed');
        expect(result.error).toContain('CAPABILITY_CHANGED');
        expect(executions).toBe(0);
        expect(requests).toBe(0);
      }
    } finally { restored.close(); }
  });
});
