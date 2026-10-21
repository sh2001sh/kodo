import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { digest } from '../src/storage/index.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

type Page = { content: string; hash: string; complete: boolean; truncated: boolean; next: null | { offset: number; contentOffset: number } };
const signal = (): AbortSignal => new AbortController().signal;

describe('bounded and recoverable tool IO', () => {
  it('reconstructs a file larger than 64 KB across line and character page boundaries, hashing the whole file', async () => {
    const { app, root, runId } = fixture();
    const original = Array.from({ length: 1200 }, (_, index) => `${index}:中文😀 ${'x'.repeat(60)}\r\n`).join('');
    writeFileSync(path.join(root, 'large.txt'), original);
    let cursor: Record<string, number> = { offset: 1, contentOffset: 0 };
    let collected = '';
    let count = 0;
    do {
      const page = await app.coordinator.tools.execute(runId, 'file.read', { path: 'large.txt', ...cursor, limit: 7, maxChars: 257 }, signal()) as Page;
      expect(page.hash).toBe(digest(original));
      expect(page.content.length).toBeLessThanOrEqual(257);
      expect(page.content).not.toContain('\uFFFD');
      collected += page.content;
      expect(page.truncated).toBe(!page.complete);
      count++;
      if (!page.next) break;
      expect(page.next).not.toEqual(cursor);
      cursor = page.next;
    } while (count < 1000);
    expect(count).toBeLessThan(1000);
    expect(collected).toBe(original);
    // Enlarging read scope must not enlarge the destructive patch scope.
    await expect(app.coordinator.tools.execute(runId, 'file.apply_patch', { path: 'large.txt', expectedHash: digest(original), content: 'replacement' }, signal())).rejects.toMatchObject({ code: 'FILE_SIZE' });
    await expect(app.coordinator.tools.execute(runId, 'file.apply_patch', { path: 'new-large.txt', expectedHash: null, content: '中'.repeat(22000) }, signal())).rejects.toMatchObject({ code: 'FILE_SIZE' });
  });

  it('defaults to 8000 characters and makes a Unicode single line fully retrievable', async () => {
    const { app, root, runId } = fixture();
    const original = 'a'.repeat(7999) + '😀中文'.repeat(5000);
    writeFileSync(path.join(root, 'line.txt'), original);
    let page = await app.coordinator.tools.execute(runId, 'file.read', { path: 'line.txt' }, signal()) as Page;
    expect(page.content).toBe('a'.repeat(7999));
    expect(page.next).toEqual({ offset: 1, contentOffset: 7999 });
    let collected = page.content;
    while (page.next) {
      page = await app.coordinator.tools.execute(runId, 'file.read', { path: 'line.txt', ...page.next }, signal()) as Page;
      expect(page.content).not.toContain('\uFFFD');
      collected += page.content;
    }
    expect(collected).toBe(original);
    await expect(app.coordinator.tools.execute(runId, 'file.read', { path: 'line.txt', contentOffset: 8000 }, signal())).rejects.toMatchObject({ code: 'FILE_CURSOR' });
  });

  it('supports line offsets above 100 and rejects invalid cursors/parameters and malformed UTF-8 beyond a page', async () => {
    const { app, root, runId } = fixture();
    writeFileSync(path.join(root, 'lines.txt'), Array.from({ length: 200 }, (_, i) => `${i + 1}\n`).join(''));
    expect(await app.coordinator.tools.execute(runId, 'file.read', { path: 'lines.txt', offset: 101, limit: 1 }, signal())).toMatchObject({ content: '101\n', next: { offset: 102, contentOffset: 0 } });
    expect(await app.coordinator.tools.execute(runId, 'file.read', { path: 'lines.txt', offset: 999 }, signal())).toMatchObject({ content: '', complete: true, next: null });
    for (const args of [{ offset: 0 }, { limit: 0 }, { maxChars: 32001 }, { contentOffset: -1 }]) {
      await expect(app.coordinator.tools.execute(runId, 'file.read', { path: 'lines.txt', ...args }, signal())).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS' });
    }
    await expect(app.coordinator.tools.execute(runId, 'file.read', { path: 'lines.txt', contentOffset: 5 }, signal())).rejects.toMatchObject({ code: 'FILE_CURSOR' });
    writeFileSync(path.join(root, 'bad.txt'), Buffer.concat([Buffer.from('x'.repeat(10000)), Buffer.from([0xc3, 0x28])]));
    await expect(app.coordinator.tools.execute(runId, 'file.read', { path: 'bad.txt' }, signal())).rejects.toMatchObject({ code: 'FILE_ENCODING' });
    writeFileSync(path.join(root, 'binary.txt'), 'x'.repeat(10000) + '\0');
    await expect(app.coordinator.tools.execute(runId, 'file.read', { path: 'binary.txt' }, signal())).rejects.toMatchObject({ code: 'FILE_ENCODING' });
    writeFileSync(path.join(root, 'empty.txt'), '');
    expect(await app.coordinator.tools.execute(runId, 'file.read', { path: 'empty.txt' }, signal())).toMatchObject({ content: '', hash: digest(''), complete: true });
    writeFileSync(path.join(root, 'too-large.txt'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
    await expect(app.coordinator.tools.execute(runId, 'file.read', { path: 'too-large.txt' }, signal())).rejects.toMatchObject({ code: 'FILE_SIZE' });
  });

  it('pages text artifacts losslessly and keeps session ownership checks', async () => {
    const { app, runId, root } = fixture();
    const original = 'a'.repeat(255) + '😀中'.repeat(600);
    const written = await app.coordinator.tools.execute(runId, 'artifact.write', { name: 'unicode', content: original }, signal()) as { id: string };
    let offset = 0;
    let collected = '';
    while (true) {
      const page = await app.coordinator.tools.execute(runId, 'artifact.read', { id: written.id, contentOffset: offset, maxChars: 256 }, signal()) as { content: string; next: null | { contentOffset: number }; provenance: unknown };
      collected += page.content;
      expect(page.provenance).toBeDefined();
      if (!page.next) break;
      offset = page.next.contentOffset;
    }
    expect(collected).toBe(original);
    await expect(app.coordinator.tools.execute(runId, 'artifact.read', { id: written.id, contentOffset: 256 }, signal())).rejects.toMatchObject({ code: 'ARTIFACT_CURSOR' });
    const second = app.createRun({ objective: 'other session', workspace: root, binding: app.store.run(runId).binding });
    await expect(app.coordinator.tools.execute(second.id, 'artifact.read', { id: written.id }, signal())).rejects.toMatchObject({ code: 'ARTIFACT_DENIED' });
  });

  it('preserves long stdout/stderr as paginated private artifacts without killing successful programs', async () => {
    const { app, runId, root } = fixture(undefined, ['read', 'exec']);
    const original = '😀中文'.repeat(12000);
    const stderr = 'e'.repeat(5001);
    const result = await app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', "const b=Buffer.from('😀中文'.repeat(12000)); process.stdout.write(b.subarray(0, 1)); setTimeout(() => { process.stdout.write(b.subarray(1)); process.stderr.write('e'.repeat(5001)); }, 5);"] }, signal()) as { stdout: string; stderr: string; exitCode: number; outputLimitExceeded: boolean; outputArtifact: { id: string; capturedComplete: boolean } };
    expect(result).toMatchObject({ exitCode: 0, outputLimitExceeded: false, outputArtifact: { capturedComplete: true } });
    expect(result.stdout.length).toBeLessThanOrEqual(4000);
    expect(result.stderr.length).toBeLessThanOrEqual(4000);
    let cursor = 0;
    let full = '';
    while (true) {
      const page = await app.coordinator.tools.execute(runId, 'artifact.read', { id: result.outputArtifact.id, contentOffset: cursor }, signal()) as { content: string; next: null | { contentOffset: number } };
      full += page.content;
      if (!page.next) break;
      cursor = page.next.contentOffset;
    }
    expect(JSON.parse(full)).toMatchObject({ stdout: original, stderr, exitCode: 0, outputLimitExceeded: false });
    const other = app.createRun({ objective: 'other session', workspace: root, binding: app.store.run(runId).binding, permissions: ['read'] });
    await expect(app.coordinator.tools.execute(other.id, 'artifact.read', { id: result.outputArtifact.id }, signal())).rejects.toMatchObject({ code: 'ARTIFACT_DENIED' });
  });

  it('stops at the capture ceiling and marks stored output as incomplete', async () => {
    const { app, runId } = fixture(undefined, ['read', 'exec']);
    const result = await app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000)"] }, signal()) as { outputLimitExceeded: boolean; truncated: boolean; outputArtifact: { id: string; capturedComplete: boolean } };
    expect(result).toMatchObject({ outputLimitExceeded: true, truncated: true, outputArtifact: { capturedComplete: false } });
    const stored = app.store.readArtifact(runId, result.outputArtifact.id) as { content: string };
    const output = JSON.parse(stored.content) as { stdout: string; stderr: string };
    expect(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('classifies synchronous spawn failure as a known failure and lets the run continue', async () => {
    const { app, runId } = fixture(scripted(calls(call('process.exec', { program: 'script.mjs', args: [] })), answer('corrected after launch failure')), ['read', 'exec']);
    vi.mocked(spawn).mockImplementationOnce(() => { throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }); });
    expect((await app.coordinator.wake(runId)).status).toBe('completed');
    expect(app.store.calls(runId).find(x => x.name === 'process.exec')?.status).toBe('failed');
    expect(app.store.unresolvedWrites()).toEqual([]);
    const failed = app.store.calls(runId).find(x => x.name === 'process.exec')!;
    expect(app.store.readBlob(failed.resultRef!)).toMatchObject({ error: expect.stringContaining('PROCESS_START') });
  });

  it.skipIf(process.platform !== 'win32')('classifies an actual Windows attempt to execute an mjs file as a start failure', async () => {
    const { app, root, runId } = fixture(undefined, ['exec']);
    const program = path.join(root, 'not-an-executable.mjs');
    writeFileSync(program, "throw new Error('this script must be launched with node');");
    await expect(app.coordinator.tools.execute(runId, 'process.exec', { program, args: [] }, signal())).rejects.toMatchObject({ code: 'PROCESS_START' });
  });

  it('keeps post-start errors uncertain and rejects asynchronous launch failures as PROCESS_START', async () => {
    const { app, runId } = fixture(scripted(calls(call('process.exec', { program: 'started', args: [] })), answer('must not run')), ['exec']);
    await expect(app.coordinator.tools.execute(runId, 'process.exec', { program: '__kodo_nonexistent_program__', args: [] }, signal())).rejects.toMatchObject({ code: 'PROCESS_START' });
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new ChildProcess();
      Object.defineProperties(child, { pid: { value: 123 }, stdout: { value: new PassThrough() }, stderr: { value: new PassThrough() } });
      queueMicrotask(() => child.emit('error', new Error('failure after startup')));
      return child;
    });
    expect((await app.coordinator.wake(runId)).status).toBe('failed');
    expect(app.store.calls(runId).find(x => x.name === 'process.exec')?.status).toBe('unknown');
    expect(app.store.unresolvedWrites()).toHaveLength(1);
    expect(app.store.readBlob(app.store.calls(runId).find(x => x.name === 'process.exec')!.resultRef!)).toMatchObject({ error: expect.stringContaining('PROCESS_STOP') });
  });

  it('retains confirmed process cancellation and the output captured before stopping', async () => {
    const { app, runId } = fixture(undefined, ['read', 'exec']);
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementationOnce((...args: Parameters<typeof spawn>) => {
      const child = actual.spawn(...args);
      let received = 0;
      child.stdout!.on('data', (chunk: Buffer) => { received += chunk.length; if (received >= 12006) controller.abort(); });
      return child;
    });
    const pending = app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', "process.stdout.write('ready-' + 'x'.repeat(12000)); setInterval(() => {}, 1000)"] }, controller.signal);
    const result = await pending as { cancelled: boolean; outputArtifact: { id: string } };
    expect(result.cancelled).toBe(true);
    const stored = app.store.readArtifact(runId, result.outputArtifact.id) as { content: string };
    expect(JSON.parse(stored.content)).toMatchObject({ cancelled: true, stdout: 'ready-' + 'x'.repeat(12000) });
  });

  it('does not start a process without permission or after cancellation, and retains the unresolved-write guard', async () => {
    const { app, runId, root } = fixture(undefined, ['read']);
    await expect(app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: [] }, signal())).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    const controller = new AbortController();
    controller.abort();
    await expect(app.coordinator.tools.execute(runId, 'file.read', { path: 'missing' }, controller.signal)).rejects.toThrow();
    const execRun = app.createRun({ objective: 'exec', workspace: root, binding: app.store.run(runId).binding, permissions: ['read', 'exec'] });
    app.store.putCall({ id: 'uncertain-effect', runId: execRun.id, step: 0, kind: 'tool', name: 'process.exec', effect: 'write', status: 'unknown', requestRef: app.store.blob({}), reservedTokens: 0 });
    await expect(app.coordinator.tools.execute(execRun.id, 'process.exec', { program: process.execPath, args: [] }, signal())).rejects.toMatchObject({ code: 'UNKNOWN_WRITE' });
    writeFileSync(path.join(root, 'safe.txt'), 'safe');
    expect(await app.coordinator.tools.execute(runId, 'file.read', { path: 'safe.txt' }, signal())).toMatchObject({ content: 'safe' });
  });
});
