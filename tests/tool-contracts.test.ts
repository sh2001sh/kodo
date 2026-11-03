import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { Application } from '../src/application/index.js';
import { Tools } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolRegistration } from '../src/tools/registry.js';
import { readOnlyShell } from '../src/tools/shell.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

const registration = (overrides: Partial<ToolRegistration> = {}): ToolRegistration => ({
  name: 'custom.value', description: 'Read or update a value.', permission: 'write', effect: 'write',
  parameters: { type: 'object', required: ['mode'], properties: { mode: { enum: ['read', 'write'] } }, additionalProperties: false },
  execute: () => ({ value: 42 }), ...overrides,
});

describe('input-dependent tool contracts', () => {
  it('classifies validated inputs while unknown and undeclared input stays conservative', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()));
    try {
      const tools = app.coordinator.tools;
      tools.register(registration({ readOnly: input => input.mode === 'read', concurrencySafe: input => input.mode === 'read', destructive: false, writeScope: () => ['data.json'], interrupt: 'block' }));
      expect(tools.effect('custom.value')).toBe('write');
      expect(tools.effect('custom.value', { mode: 'read' })).toBe('read');
      expect(tools.concurrencySafe('custom.value', { mode: 'read' })).toBe(true);
      expect(tools.concurrencySafe('custom.value', { mode: 'write' })).toBe(false);
      expect(tools.destructive('custom.value', { mode: 'write' })).toBe(false);
      expect(tools.interrupt('custom.value')).toBe('block');
      expect(tools.effect('unregistered')).toBe('write');
      expect(tools.concurrencySafe('unregistered')).toBe(false);
      const run = app.createRun({ objective: 'Inspect value.', workspace: root, binding, permissions: ['read', 'write'] });
      expect(tools.effectRoots(run.id, 'custom.value', { mode: 'write' })).toEqual([path.join(root, 'data.json')]);
    } finally { await app.shutdown(); }
  });

  it('uses input validation before starting or counting the tool', async () => {
    const root = temp();
    let executed = false;
    const app = new Application(path.join(root, '.state'), scripted(calls(call('custom.value', { mode: 'write' })), answer()), undefined, {
      tools: [registration({ validate: input => input.mode === 'read' || 'maintenance is read-only', execute: () => { executed = true; return null; } })],
    });
    try {
      const run = app.createRun({ objective: 'Inspect value.', workspace: root, binding, permissions: ['read', 'write'], card: { ...app.defaultCard, tools: [...app.defaultCard.tools, 'custom.value'] } });
      expect((await app.run(run.id)).status).toBe('completed');
      expect(executed).toBe(false);
      expect(app.store.events(run.id, { types: ['tool.started'] }).filter(event => event.data.name === 'custom.value')).toHaveLength(0);
      const operation = app.store.calls(run.id).find(operation => operation.name === 'custom.value')!;
      expect(app.store.readBlob(operation.resultRef!)).toMatchObject({ error: 'TOOL_ARGUMENTS: maintenance is read-only', notStarted: true });
    } finally { await app.shutdown(); }
  });

  it('keeps shell classification limited to literal read commands', () => {
    expect(readOnlyShell('git status --short')).toBe(true);
    expect(readOnlyShell('rg -n "hello world" src')).toBe(true);
    expect(readOnlyShell('ls -al src')).toBe(true);
    expect(readOnlyShell('pwd')).toBe(true);
    expect(readOnlyShell('git add src')).toBe(false);
    expect(readOnlyShell('echo done')).toBe(true);
    expect(readOnlyShell('rg --unknown pattern src')).toBe(false);
  });

  it('lets an admitted block-interrupt callback finish before releasing its lock', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()));
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const controller = new AbortController();
    try {
      app.registerTool(registration({ interrupt: 'block', async execute(context) {
        started();
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(context.signal.aborted).toBe(false);
        return { settled: true };
      } }));
      const run = app.createRun({ objective: 'Update value.', workspace: root, binding, permissions: ['read', 'write'], card: { ...app.defaultCard, tools: [...app.defaultCard.tools, 'custom.value'] } });
      const execution = app.coordinator.tools.execute(run.id, 'custom.value', { mode: 'write' }, controller.signal);
      await entered;
      controller.abort(new Error('caller stopped'));
      await expect(execution).resolves.toEqual({ settled: true });
      expect(app.coordinator.tools.hasInFlightEffects(run.id)).toBe(false);
    } finally { await app.shutdown(); }
  });

  it.each([false, true])('records a foreground outcome before the next writer enters (failure=%s)', async fail => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()));
    const order: string[] = [];
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    try {
      app.registerTool(registration({ async execute(_context, input) {
        if (input.mode === 'write') {
          order.push('first'); entered(); await gate;
          if (fail) throw new Error('ordinary callback failure');
        } else order.push('second');
        return { value: input.mode };
      } }));
      const run = app.createRun({ objective: 'Update value.', workspace: root, binding, permissions: ['read', 'write'], card: { ...app.defaultCard, tools: [...app.defaultCard.tools, 'custom.value'] } });
      const first = app.coordinator.tools.execute(run.id, 'custom.value', { mode: 'write' }, new AbortController().signal, undefined, { settle: outcome => {
        expect(outcome.ok).toBe(!fail);
        expect(order).toEqual(['first']);
        order.push('settled');
      } }).catch(error => { if (!fail) throw error; return undefined; });
      await started;
      const second = app.coordinator.tools.execute(run.id, 'custom.value', { mode: 'read' }, new AbortController().signal);
      finish();
      await Promise.all([first, second]);
      expect(order).toEqual(['first', 'settled', 'second']);
    } finally { await app.shutdown(); }
  });

  it('validates declaration limits at registration', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(registration({ maxResultBytes: 100 }))).toThrow('maxResultBytes');
    expect(() => registry.register(registration({ interrupt: 'later' as 'block' }))).toThrow('interrupt');
  });
});

describe('bounded tool evidence and deferred schemas', () => {
  it('lets a file-read-only card retrieve an oversized page through its result artifact', async () => {
    const root = temp();
    const content = '数据'.repeat(12_000);
    writeFileSync(path.join(root, 'large.txt'), content);
    let artifactId = '';
    const app = new Application(path.join(root, '.state'), scripted(
      calls(call('file.read', { path: 'large.txt', maxChars: 32_000 })),
      async request => {
        expect(request.tools.some(tool => tool.name === 'artifact.read')).toBe(true);
        const result = JSON.parse(request.messages.findLast(message => message.role === 'tool')!.content!);
        expect(result.truncated).toBe(true);
        artifactId = result.outputArtifact.id;
        return calls(call('artifact.read', { id: artifactId, maxChars: 1024 }));
      },
      async request => {
        const result = JSON.parse(request.messages.findLast(message => message.role === 'tool')!.content!);
        expect(result.content).toContain('数据');
        expect(result.next.contentOffset).toBeGreaterThan(0);
        return answer();
      },
    ));
    try {
      const run = app.createRun({ objective: 'Read the file.', workspace: root, binding, permissions: ['read'], card: { ...app.defaultCard, tools: ['file.read'] } });
      expect((await app.run(run.id)).status).toBe('completed');
      expect(artifactId).not.toBe('');
    } finally { await app.shutdown(); }
  });

  it('preserves the full result in an artifact while enforcing the actual UTF-8 result size', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()));
    try {
      const tools = app.coordinator.tools;
      tools.register(registration({ maxResultBytes: 1024 }));
      const run = app.createRun({ objective: 'Read a large result.', workspace: root, binding });
      const result = { value: '数据 "quoted"\n'.repeat(500), count: 500 };
      const projected = tools.boundResult(run.id, 'custom.value', result) as { truncated: boolean; outputArtifact: { id: string } };
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(1024);
      expect(projected.truncated).toBe(true);
      const full = app.store.readArtifact(run.id, projected.outputArtifact.id) as { content: string };
      expect(JSON.parse(full.content)).toEqual(result);
    } finally { await app.shutdown(); }
  });

  it('exposes full schemas only after description when explicitly enabled and over budget', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()));
    try {
      const run = app.createRun({ objective: 'Inspect files.', workspace: root, binding, permissions: ['read', 'write'] });
      const session = app.store.session(run.sessionId);
      const tools = new Tools(app.store, [], { lazyTools: true, lockDirectory: false });
      const first = tools.requestSpecs(run, session, 1024);
      expect(first.map(spec => spec.name)).toEqual(['tool.describe']);
      expect(first[0]!.description).toContain('file.read:');
      const result = await tools.execute(run.id, 'tool.describe', { names: ['file.read'] }, new AbortController().signal) as { tools: { name: string; parameters: unknown }[] };
      expect(result.tools[0]!.name).toBe('file.read');
      const reopened = new Tools(app.store, [], { lazyTools: true, lockDirectory: false });
      expect(reopened.requestSpecs(run, session, 1024).map(spec => spec.name)).toEqual(['file.read', 'tool.describe']);
      expect(new Tools(app.store).requestSpecs(run, session, 1024).some(spec => spec.name === 'file.read')).toBe(true);
    } finally { await app.shutdown(); }
  });
});
