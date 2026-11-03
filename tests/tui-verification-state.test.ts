import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureVerificationFiles } from '../src/tui/verification-state.js';
import type { Application } from '../src/application/index.js';
import { binding, fixture } from './helpers.js';

/** Explicit synthetic tool records exercise capture without making model requests. */
function observed(app: Application, runId: string, name: string, args: Record<string, unknown>, status: 'succeeded' | 'failed' = 'succeeded'): void {
  app.store.putCall({ id: randomUUID(), runId, name, kind: 'tool', status, effect: name === 'file.read' ? 'read' : 'write', step: 0, reservedTokens: 0, requestRef: app.store.blob({ arguments: JSON.stringify(args) }) });
}

describe('observed file versions for TUI verification', () => {
  it('captures checkpoints and successful explicit file paths across the same session only', async () => {
    const { app, root, runId } = fixture();
    const run = app.store.run(runId);
    await writeFile(path.join(root, 'edited.txt'), 'Synthetic checkpoint fixture.');
    await writeFile(path.join(root, 'read.txt'), 'Synthetic observed fixture.');
    await writeFile(path.join(root, 'unobserved.txt'), 'Synthetic unobserved fixture.');
    app.store.checkpoints.put({ id: 'fixture-checkpoint', preparationId: 'fixture-preparation', runId, step: 0, paths: { path: path.join(root, 'edited.txt') }, before: { path: { kind: 'absent' } } });
    const child = app.spawnAgent(run.sessionId, { agent: 'kodo/explorer', objective: 'Inspect synthetic fixture.', slots: { question: 'Read the fixture.' } });
    observed(app, child.id, 'file.read', { path: 'read.txt' });
    observed(app, runId, 'file.read', { path: 'unobserved.txt' }, 'failed');
    const foreign = app.createRun({ objective: 'Other session fixture.', workspace: root, binding });
    observed(app, foreign.id, 'file.read', { path: 'unobserved.txt' });
    const first = await captureVerificationFiles(app, run);
    expect(first).toMatchObject({ paths: ['edited.txt', 'read.txt'], complete: true });
    expect(first.note).toContain('recorded session paths only');
    expect(JSON.stringify(first)).not.toContain(root);
    expect(JSON.stringify(first)).not.toContain('Synthetic observed fixture.');
    expect((await captureVerificationFiles(app, run)).stamp).toBe(first.stamp);
    await writeFile(path.join(root, 'unobserved.txt'), 'Changed outside the recorded coverage.');
    expect((await captureVerificationFiles(app, run)).stamp).toBe(first.stamp);
  });

  it('detects same-length external edits even when the recorded timestamp is restored', async () => {
    const { app, root, runId } = fixture();
    const file = path.join(root, 'read.txt');
    await writeFile(file, 'before');
    observed(app, runId, 'file.read', { path: 'read.txt' });
    const info = await stat(file), run = app.store.run(runId);
    const before = await captureVerificationFiles(app, run);
    await writeFile(file, 'after!');
    await utimes(file, info.atime, info.mtime);
    expect((await stat(file)).size).toBe(info.size);
    const after = await captureVerificationFiles(app, run);
    expect(after.complete).toBe(true);
    expect(after.paths).toEqual(before.paths);
    expect(after.stamp).not.toBe(before.stamp);
  });

  it('versions deletion and recreation of a recorded path', async () => {
    const { app, root, runId } = fixture();
    const file = path.join(root, 'removed.txt'), run = app.store.run(runId);
    await writeFile(file, 'fixture');
    observed(app, runId, 'file.apply_patch', { path: 'removed.txt', content: 'fixture' });
    const before = await captureVerificationFiles(app, run);
    await rm(file);
    const removed = await captureVerificationFiles(app, run);
    expect(removed).toMatchObject({ complete: true, paths: ['removed.txt'] });
    expect(removed.stamp).not.toBe(before.stamp);
    expect((await captureVerificationFiles(app, run)).stamp).toBe(removed.stamp);
    await writeFile(file, 'fixture');
    expect((await captureVerificationFiles(app, run)).stamp).toBe(before.stamp);
  });

  it('reports incomplete coverage when the current read scope covers only part of the recorded paths', async () => {
    const { app, root, runId } = fixture();
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'readme.txt'), 'visible fixture');
    await writeFile(path.join(root, 'other.txt'), 'outside the selected read roots');
    observed(app, runId, 'file.read', { path: 'docs/readme.txt' });
    observed(app, runId, 'file.read', { path: 'other.txt' });
    const run = app.store.updateRun(runId, { scope: { read: ['docs'] } });
    const captured = await captureVerificationFiles(app, run);
    expect(captured).toMatchObject({ complete: false, paths: ['docs/readme.txt'] });
    expect(captured.note).toContain('current read scope');
    expect(JSON.stringify(captured)).not.toContain('other.txt');
    expect(JSON.stringify(captured)).not.toContain(root);
  });

  it('does not recursively inspect a recorded directory or claim full coverage without read permission', async () => {
    const { app, root, runId } = fixture();
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'nested.txt'), 'directory contents are not an inventory');
    observed(app, runId, 'file.list', { path: 'docs' });
    const run = app.store.run(runId), first = await captureVerificationFiles(app, run);
    expect(first).toMatchObject({ complete: false, paths: ['docs'] });
    expect(first.note).toContain('directories');
    await writeFile(path.join(root, 'docs', 'nested.txt'), 'changed');
    expect((await captureVerificationFiles(app, run)).stamp).toBe(first.stamp);
    const restricted = app.store.updateRun(runId, { permissions: ['write'] });
    expect(await captureVerificationFiles(app, restricted)).toMatchObject({ complete: false, paths: [] });
  });

  it('marks excessive file sizes and an empty observation set as incomplete', async () => {
    const { app, root, runId } = fixture();
    const run = app.store.run(runId);
    expect(await captureVerificationFiles(app, run)).toMatchObject({ complete: false, paths: [] });
    await writeFile(path.join(root, 'large.bin'), Buffer.alloc(16 * 1024 * 1024 + 1));
    observed(app, runId, 'file.read', { path: 'large.bin' });
    const result = await captureVerificationFiles(app, run);
    expect(result.complete).toBe(false);
    expect(result.note).toContain('limit');
  });
});
