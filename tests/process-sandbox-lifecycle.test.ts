import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { runProcess } from '../src/tools/index.js';
import { KodoError } from '../src/runtime/types.js';
import type { SandboxOptions } from '../src/sandbox/index.js';
import { answer, binding, call, calls, fixture, fullToolCard, scripted, temp } from './helpers.js';

const state = vi.hoisted(() => ({ prepareError: undefined as Error | undefined, cleanupError: undefined as Error | undefined, cleaned: 0, preparations: [] as SandboxOptions[] }));
// This fixture exercises lifecycle ordering; native enforcement has its own live tests.
vi.mock('../src/sandbox/index.js', async original => ({ ...await original<typeof import('../src/sandbox/index.js')>(), prepareSandboxCommand: async (program: string, args: string[], options: SandboxOptions & { cwd: string; env?: NodeJS.ProcessEnv }) => {
  state.preparations.push(options);
  if (state.prepareError) throw state.prepareError;
  return { program, args, cwd: options.cwd, env: { ...process.env, ...options.env }, async cleanup() { state.cleaned++; if (state.cleanupError) throw state.cleanupError; } };
} }));
afterEach(() => { state.prepareError = undefined; state.cleanupError = undefined; state.cleaned = 0; state.preparations = []; });

describe('process sandbox lifecycle', () => {
  it('keeps read-only shell output read-only while retaining writable process output', async () => {
    const resource = temp();
    const policy = { network: 'none' as const, readOnlyPaths: [resource] };
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { sandbox: policy });
    await app.coordinator.tools.execute(runId, 'shell.exec', { command: 'pwd' }, AbortSignal.timeout(30_000));
    const read = state.preparations.at(-1)!;
    expect(read.write).toBe(false);
    expect(read.outputDirectory).toBeUndefined();
    expect(read.readOnlyPaths).toHaveLength(2);
    expect(read.readOnlyPaths![0]).toBe(resource);
    await app.coordinator.tools.execute(runId, 'shell.exec', { command: 'printf result' }, AbortSignal.timeout(30_000));
    // Unknown commands retain write classification; no permission is inferred from emitted text.
    const write = state.preparations.at(-1)!;
    expect(write.outputDirectory).toBe(read.readOnlyPaths![1]);
    await app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', 'process.exit(0)'] }, AbortSignal.timeout(30_000));
    expect(state.preparations.at(-1)!.outputDirectory).toBe(write.outputDirectory);
  });
  it('fails preparation before effect start and never runs an ordinary fallback', async () => {
    const workspace = temp(); let started = false;
    state.prepareError = new KodoError('SANDBOX_UNAVAILABLE', 'test unavailable backend');
    await expect(runProcess(process.execPath, ['-e', 'process.exit(0)'], workspace, '', new AbortController().signal, { sandbox: { workspace }, onStart() { started = true; } })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(started).toBe(false); expect(state.cleaned).toBe(0);
  });
  it('cleans up a failed spawn and reports a known failure before any target execution', async () => {
    const workspace = temp(); let settled = false;
    await expect(runProcess('__missing_native_executable__', [], workspace, '', new AbortController().signal, { sandbox: { workspace }, onSettled() { settled = true; } })).rejects.toMatchObject({ code: 'PROCESS_START' });
    expect(settled).toBe(true); expect(state.cleaned).toBe(1);
  });
  it('preserves a write as unknown when sandbox cleanup fails after it happened', async () => {
    const workspace = temp();
    const app = new Application(temp(), scripted(calls(call('process.exec', { program: process.execPath, args: ['-e', "require('node:fs').writeFileSync('marker','applied')"] })), answer()), undefined, { sandbox: {} });
    try {
      const run = app.createRun({ objective: 'write marker', workspace, binding, permissions: ['read', 'write', 'exec'], card: fullToolCard });
      state.cleanupError = new KodoError('SANDBOX_CLEANUP', 'test recovery journal retained');
      expect((await app.run(run.id)).error).toContain('UNKNOWN_WRITE');
      expect(readFileSync(path.join(workspace, 'marker'), 'utf8')).toBe('applied');
      expect(app.store.calls(run.id).find(item => item.name === 'process.exec')?.status).toBe('unknown');
      expect(app.coordinator.tools.hasPendingEffects()).toBe(false);
      await expect(app.coordinator.tools.execute(run.id, 'file.mkdir', { path: 'later' }, new AbortController().signal)).rejects.toMatchObject({ code: 'UNKNOWN_WRITE' });
    } finally { await app.shutdown(); }
  });
  it('keeps the store open while an actual native write process is still running', async () => {
    const workspace = temp(); const app = new Application(temp());
    try {
      const run = app.createRun({ objective: 'native lifecycle', workspace, binding, permissions: ['read', 'write', 'exec'], card: fullToolCard });
      const pending = app.coordinator.tools.execute(run.id, 'process.exec', { program: process.execPath, args: ['-e', 'setTimeout(()=>{},200)'] }, new AbortController().signal);
      await vi.waitFor(() => expect(app.coordinator.tools.hasPendingEffects()).toBe(true));
      expect(() => app.close()).toThrow('still running');
      await pending;
      expect(app.coordinator.tools.hasPendingEffects()).toBe(false);
    } finally { await app.shutdown(); }
  });
});
