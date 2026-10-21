import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { digest } from '../src/storage/index.js';
import { call, calls, fixture, scripted, answer, temp } from './helpers.js';

describe('tool execution boundary', () => {
  it('rejects a tool not granted to the run, even if called directly', async () => {
    const { app, runId } = fixture(undefined, ['read']);
    await expect(app.coordinator.tools.execute(runId, 'file.apply_patch', { path: 'new.txt', expectedHash: null, content: 'no' }, new AbortController().signal)).rejects.toThrow('not authorized');
  });
  it('uses expected-content hashes and atomic replacements', async () => {
    const { app, root, runId } = fixture();
    writeFileSync(path.join(root, 'file.txt'), 'old');
    const execute = (args: Record<string, unknown>) => app.coordinator.tools.execute(runId, 'file.apply_patch', args, new AbortController().signal);
    await expect(execute({ path: 'file.txt', expectedHash: null, content: 'wrong' })).rejects.toThrow('changed');
    expect(readFileSync(path.join(root, 'file.txt'), 'utf8')).toBe('old');
    await execute({ path: 'file.txt', expectedHash: digest('old'), content: '新的文本' });
    expect(readFileSync(path.join(root, 'file.txt'), 'utf8')).toBe('新的文本');
  });
  it('rejects traversal, runtime data, credentials and junction escapes', async () => {
    const { app, root, runId } = fixture();
    const outside = temp();
    writeFileSync(path.join(outside, 'private.txt'), 'private');
    symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const tools = app.coordinator.tools;
    for (const input of ['../private.txt', '.env', '.git/config', '.state/owner.lock', 'linked/private.txt', 'C:\\private.txt']) {
      await expect(tools.execute(runId, 'file.read', { path: input }, new AbortController().signal)).rejects.toThrow();
    }
  });
  it('checks artifact ownership', async () => {
    const { app, runId, root } = fixture();
    const id = app.store.artifact(runId, app.store.blob({ private: true }));
    const second = app.createRun({ objective: 'other', workspace: root, binding: app.store.run(runId).binding });
    await expect(app.coordinator.tools.execute(second.id, 'artifact.read', { id }, new AbortController().signal)).rejects.toThrow('does not belong');
  });
  it('checks both the requested path and its resolved target', async () => {
    const { app, root, runId } = fixture();
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, '.git', 'config'), 'private');
    symlinkSync(path.join(root, '.git'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(app.coordinator.tools.execute(runId, 'file.read', { path: 'alias/config' }, new AbortController().signal)).rejects.toThrow('protected');
  });
  it('searches literal Chinese text without searching hidden directories', async () => {
    const { app, root, runId } = fixture();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'sample.txt'), '订单详情\n可核验结论');
    const result = await app.coordinator.tools.execute(runId, 'file.search', { path: 'src', query: '订单' }, new AbortController().signal) as { matches: unknown[] };
    expect(result.matches).toHaveLength(1);
  });
  it('executes argument arrays, preserves nonzero exits and strips credential environment', async () => {
    const { app, runId } = fixture(undefined, ['read', 'exec']);
    process.env.KODO_TEST_SECRET = 'do-not-forward';
    try {
      const result = await app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', 'console.log(process.argv[1]); console.log(Boolean(process.env.KODO_TEST_SECRET)); process.exit(7)', 'literal $() ;'] }, new AbortController().signal) as { stdout: string; exitCode: number };
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toContain('literal $() ;');
      expect(result.stdout).toContain('false');
    } finally { delete process.env.KODO_TEST_SECRET; }
  });
  it('can cancel an owned process and collect its terminal result', async () => {
    const { app, runId } = fixture(undefined, ['exec']);
    const controller = new AbortController();
    const promise = app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, controller.signal);
    setTimeout(() => controller.abort(), 150);
    expect(await promise).toMatchObject({ cancelled: true });
  });
  it('rejects invalid parameters before a write occurs', async () => {
    const { app, runId } = fixture(scripted(calls(call('file.apply_patch', { path: 'x.txt', expectedHash: null })), answer()));
    expect((await app.coordinator.wake(runId)).status).toBe('completed');
    expect(app.store.calls(runId).find(x => x.name === 'file.apply_patch')?.status).toBe('failed');
    expect(app.store.events(runId).filter(x => x.type === 'tool.started')).toHaveLength(0);
  });
});
