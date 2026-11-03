import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import type { ToolRegistration } from '../src/tools/registry.js';
import { binding, call, calls, fixture, scripted } from './helpers.js';

describe('application lifetime with cancelled host effects', () => {
  it.each(['close', 'shutdown'] as const)('refuses %s and preserves store ownership until an ignored-signal write settles', async action => {
    const { app, root } = fixture(scripted(calls(call('host.late_write', {}))));
    const file = path.join(root, 'external-state.txt');
    const directory = app.store.directory;
    const lock = path.join(directory, 'owner.lock');
    const owner = readFileSync(lock, 'utf8');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const definition: ToolRegistration = {
      name: 'host.late_write', description: 'Persist an external record.', permission: 'write', effect: 'write',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        writeFileSync(file, 'intermediate');
        entered();
        await gate;
        writeFileSync(file, 'committed');
        return { committed: true };
      },
    };
    app.registerTool(definition);
    const card = app.parseCard(`---\nschema_version: 1\nid: test/late-writer\nversion: 1.0.0\nname: Late writer\ndescription: Exercise application lifetime while a host effect remains live.\ncapabilities:\n  tools: [host.late_write]\n---\nPersist the requested external record.`);
    const run = app.createRun({ objective: 'Persist one record.', workspace: root, binding, permissions: ['read', 'write'], card });
    const execution = app.run(run.id);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await started;
      app.coordinator.cancel(run.id);
      const finished = await Promise.race([execution, new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('cancellation did not return while the host callback remained live')), 2000);
      })]);
      clearTimeout(watchdog);
      expect(finished.status).toBe('cancelled');
      expect(app.coordinator.busy).toBe(false);
      expect(app.coordinator.tools.hasPendingEffects()).toBe(true);
      expect(app.store.calls(run.id).find(entry => entry.kind === 'tool')?.status).toBe('unknown');
      expect(readFileSync(file, 'utf8')).toBe('intermediate');
      if (action === 'close') expect(() => app.close()).toThrow(expect.objectContaining({ code: 'RUNTIME_ACTIVE' }));
      else await expect(app.shutdown()).rejects.toMatchObject({ code: 'RUNTIME_ACTIVE' });
      expect(readFileSync(lock, 'utf8')).toBe(owner);
      expect(() => new Application(directory, scripted(), undefined, { tools: [definition] })).toThrow(expect.objectContaining({ code: 'DATA_LOCKED' }));
      expect(app.store.run(run.id).status).toBe('cancelled');
      release();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(app.coordinator.tools.hasPendingEffects()).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe('committed');
      await app.shutdown();
      expect(existsSync(lock)).toBe(false);
      const restored = new Application(directory, scripted(), undefined, { tools: [definition] });
      try {
        expect(restored.coordinator.tools.hasPendingEffects()).toBe(false);
        expect(restored.store.run(run.id).status).toBe('cancelled');
        expect(restored.store.calls(run.id).find(entry => entry.kind === 'tool')?.status).toBe('unknown');
        expect(readFileSync(file, 'utf8')).toBe('committed');
      } finally { await restored.shutdown(); }
    } finally {
      clearTimeout(watchdog);
      release();
      await execution;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });
});
