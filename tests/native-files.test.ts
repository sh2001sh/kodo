import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { digest } from '../src/storage/index.js';
import { fixture } from './helpers.js';

const signal = (): AbortSignal => new AbortController().signal;

function nativeFixture() {
  const result = fixture();
  const run = result.app.store.run(result.runId);
  result.app.store.updateRun(run.id, { card: { ...run.card, tools: [...new Set([...run.card.tools, 'file.patch', 'file.mkdir', 'file.rename', 'file.delete'])] } });
  const execute = (name: string, args: Record<string, unknown>, started?: () => void) => result.app.coordinator.tools.execute(run.id, name, args, signal(), started);
  return { ...result, execute };
}

describe('native filesystem completeness and scope', () => {
  it('guides shell readers through file.read before a guarded edit, accepting contained absolute paths', async () => {
    const { app, root, runId } = fixture(undefined, ['read', 'write', 'exec']);
    const tools = app.coordinator.tools;
    const execute = (name: string, args: Record<string, unknown>) => tools.execute(runId, name, args, signal());
    writeFileSync(path.join(root, 'source.txt'), 'old content');
    expect(await execute('shell.exec', { command: 'cat source.txt' })).toMatchObject({ stdout: 'old content' });
    const patch = { path: 'source.txt', expectedHash: digest('old content'), edits: [{ oldText: 'old', newText: 'new' }] };
    await expect(execute('file.patch', patch)).rejects.toThrow('shell reads do not register this prerequisite');
    expect(readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('old content');
    const read = await execute('file.read', { path: path.join(root, 'source.txt') }) as { hash: string };
    await execute('file.patch', { ...patch, expectedHash: read.hash });
    expect(readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('new content');
  });

  it('finds text past 64 KB and across UTF-8 stream chunks without reporting a false complete empty result', async () => {
    const { root, execute } = nativeFixture();
    mkdirSync(path.join(root, 'data'));
    writeFileSync(path.join(root, 'data', 'large.txt'), 'x'.repeat(65535) + '中文目标\n' + 'y'.repeat(10000) + '中文目标');
    const result = await execute('file.search', { path: 'data', query: '中文目标' });
    expect(result).toMatchObject({ matches: [{ line: 1 }, { line: 2 }], truncated: false, incomplete: false, skipped: { count: 0 } });
  });

  it('uses absolute workspace paths consistently for file creation, editing, rename, listing and deletion', async () => {
    const { root, execute } = nativeFixture();
    const directory = path.join(root, 'absolute');
    const source = path.join(directory, 'source.txt');
    const destination = path.join(directory, 'renamed.txt');
    await execute('file.mkdir', { path: directory });
    await execute('file.apply_patch', { path: source, expectedHash: null, content: 'before' });
    const read = await execute('file.read', { path: source }) as { hash: string };
    const changed = await execute('file.patch', { path: source, expectedHash: read.hash, edits: [{ oldText: 'before', newText: 'after' }] }) as { hash: string };
    await execute('file.rename', { path: source, destination, expectedHash: changed.hash });
    expect(await execute('file.search', { path: directory, query: 'after' })).toMatchObject({ matches: [{ path: path.join('absolute', 'renamed.txt') }] });
    expect(await execute('file.list', { path: directory })).toMatchObject({ entries: [{ name: 'renamed.txt' }] });
    await execute('file.delete', { path: destination, expectedHash: changed.hash });
    expect(existsSync(destination)).toBe(false);
  });

  it('keeps absolute paths subject to workspace, protected-data and run-scope limits', async () => {
    const { app, root, runId, execute } = nativeFixture();
    mkdirSync(path.join(root, 'allowed'));
    writeFileSync(path.join(root, 'outside-scope.txt'), 'ordinary fixture');
    for (const target of [path.join(path.dirname(root), 'outside.txt'), path.join(root, '.git', 'config'), path.join(root, '.env'), path.join(root, '.state')]) {
      await expect(execute('file.read', { path: target })).rejects.toMatchObject({ code: 'PATH_DENIED' });
    }
    app.store.updateRun(runId, { scope: { read: ['allowed'], write: ['allowed'] } });
    await expect(execute('file.read', { path: path.join(root, 'outside-scope.txt') })).rejects.toMatchObject({ code: 'FILE_SCOPE' });
    await expect(execute('file.apply_patch', { path: path.join(root, 'outside-write.txt'), expectedHash: null, content: 'ordinary fixture' })).rejects.toMatchObject({ code: 'FILE_SCOPE' });
  });

  it('discloses oversize, malformed UTF-8, hidden and binary omissions', async () => {
    const { root, execute } = nativeFixture();
    mkdirSync(path.join(root, 'data'));
    writeFileSync(path.join(root, 'data', 'too-large.txt'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
    writeFileSync(path.join(root, 'data', 'bad.txt'), Buffer.concat([Buffer.from('needle\n' + 'x'.repeat(70000)), Buffer.from([0xc3, 0x28])]));
    writeFileSync(path.join(root, 'data', 'binary.txt'), 'needle\n\0');
    writeFileSync(path.join(root, 'data', '.hidden'), 'needle');
    expect(await execute('file.search', { path: 'data', query: 'needle' })).toMatchObject({
      matches: [], incomplete: true, skipped: { count: 4, reasons: { size: 1, encoding: 2, excluded: 1 } },
    });
  });

  it('reports match and traversal bounds as incomplete', async () => {
    const { root, execute } = nativeFixture();
    mkdirSync(path.join(root, 'data'));
    writeFileSync(path.join(root, 'data', 'many.txt'), 'needle\n'.repeat(31));
    const result = await execute('file.search', { path: 'data', query: 'needle' }) as { matches: unknown[]; incomplete: boolean; truncated: boolean };
    expect(result.matches).toHaveLength(30);
    expect(result).toMatchObject({ incomplete: true, truncated: true });
  });

  it('pages all 205 directory entries in deterministic order without duplicates', async () => {
    const { root, execute } = nativeFixture();
    mkdirSync(path.join(root, 'data'));
    for (let index = 204; index >= 0; index--) writeFileSync(path.join(root, 'data', `${index.toString().padStart(3, '0')}.txt`), '');
    const first = await execute('file.list', { path: 'data' }) as { entries: { name: string }[]; next: { cursor: string }; truncated: boolean };
    expect(first.entries).toHaveLength(200);
    expect(first.truncated).toBe(true);
    const second = await execute('file.list', { path: 'data', ...first.next }) as { entries: { name: string }[]; next: null; complete: boolean };
    expect(second.entries).toHaveLength(5);
    expect(second.next).toBeNull();
    expect(second.complete).toBe(true);
    const names = [...first.entries, ...second.entries].map(entry => entry.name);
    expect(new Set(names).size).toBe(205);
    expect(names).toEqual([...names].sort());
    writeFileSync(path.join(root, 'data', 'new.txt'), '');
    await expect(execute('file.list', { path: 'data', ...first.next })).rejects.toMatchObject({ code: 'FILE_CURSOR' });
    await expect(execute('file.list', { path: 'data', cursor: 'invalid' })).rejects.toMatchObject({ code: 'FILE_CURSOR' });
  });

  it('patches a file larger than 64 KB with ordered local edits and a whole-file hash', async () => {
    const { root, execute } = nativeFixture();
    const before = 'x'.repeat(80000) + '\nunique old 中文\n';
    writeFileSync(path.join(root, 'large.txt'), before);
    await execute('file.read', { path: 'large.txt' });
    const result = await execute('file.patch', { path: 'large.txt', expectedHash: digest(before), edits: [
      { oldText: 'unique old', newText: 'unique new' }, { oldText: 'new 中文', newText: 'final 中文😀' },
    ] });
    const after = before.replace('unique old 中文', 'unique final 中文😀');
    expect(readFileSync(path.join(root, 'large.txt'), 'utf8')).toBe(after);
    expect(result).toMatchObject({ hash: digest(after), bytes: Buffer.byteLength(after) });
  });

  it('fails stale hashes, missing and ambiguous patches before any effect', async () => {
    const { root, execute } = nativeFixture();
    writeFileSync(path.join(root, 'file.txt'), 'same same');
    await execute('file.read', { path: 'file.txt' });
    const started = vi.fn();
    for (const [expectedHash, oldText, code] of [
      [digest('stale'), 'same', 'FILE_CONFLICT'], [digest('same same'), 'missing', 'PATCH_MATCH'], [digest('same same'), 'same', 'PATCH_MATCH'],
    ]) {
      await expect(execute('file.patch', { path: 'file.txt', expectedHash, edits: [{ oldText, newText: 'replacement' }] }, started)).rejects.toMatchObject({ code });
    }
    expect(started).not.toHaveBeenCalled();
    expect(readFileSync(path.join(root, 'file.txt'), 'utf8')).toBe('same same');
    expect((await execute('file.list', { path: '.' }) as { entries: { name: string }[] }).entries.map(entry => entry.name)).toEqual(['file.txt']);
  });

  it('rejects localized edits that would grow a file beyond 16 MiB', async () => {
    const { root, execute } = nativeFixture();
    const before = 'unique\n' + 'x'.repeat(16 * 1024 * 1024 - 7);
    writeFileSync(path.join(root, 'limit.txt'), before);
    await execute('file.read', { path: 'limit.txt' });
    const started = vi.fn();
    await expect(execute('file.patch', { path: 'limit.txt', expectedHash: digest(before), edits: [{ oldText: 'unique', newText: 'larger-unique' }] }, started)).rejects.toMatchObject({ code: 'FILE_SIZE' });
    expect(started).not.toHaveBeenCalled();
    expect(readFileSync(path.join(root, 'limit.txt'), 'utf8')).toBe(before);
  });

  it('creates a single directory and reports existing/missing-parent failures without pretending success', async () => {
    const { root, execute } = nativeFixture();
    const started = vi.fn();
    expect(await execute('file.mkdir', { path: 'created' }, started)).toMatchObject({ created: true });
    expect(started).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(root, 'created'))).toBe(true);
    await expect(execute('file.mkdir', { path: 'created' })).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    await expect(execute('file.mkdir', { path: 'missing/child' })).rejects.toThrow();
    expect(existsSync(path.join(root, 'missing'))).toBe(false);
  });

  it('renames and deletes only files with a matching hash, preserving existing destinations', async () => {
    const { root, execute } = nativeFixture();
    writeFileSync(path.join(root, 'source.txt'), 'source');
    writeFileSync(path.join(root, 'target.txt'), 'target');
    const started = vi.fn();
    await expect(execute('file.rename', { path: 'source.txt', destination: 'target.txt', expectedHash: digest('source') }, started)).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    await expect(execute('file.delete', { path: 'source.txt', expectedHash: digest('wrong') }, started)).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    expect(started).not.toHaveBeenCalled();
    expect(readFileSync(path.join(root, 'target.txt'), 'utf8')).toBe('target');
    expect(await execute('file.rename', { path: 'source.txt', destination: 'moved.txt', expectedHash: digest('source') }, started)).toMatchObject({ destination: 'moved.txt', hash: digest('source') });
    expect(existsSync(path.join(root, 'source.txt'))).toBe(false);
    expect(readFileSync(path.join(root, 'moved.txt'), 'utf8')).toBe('source');
    expect(await execute('file.delete', { path: 'moved.txt', expectedHash: digest('source') }, started)).toMatchObject({ deleted: true });
    expect(existsSync(path.join(root, 'moved.txt'))).toBe(false);
    mkdirSync(path.join(root, 'directory'));
    await expect(execute('file.delete', { path: 'directory', expectedHash: digest('') })).rejects.toMatchObject({ code: 'FILE_SIZE' });
    expect(started).toHaveBeenCalledTimes(2);
  });

  it('enforces scope on reads, patches, directory creation, rename destinations and recovery probes', async () => {
    const { app, root, runId, execute } = nativeFixture();
    mkdirSync(path.join(root, 'allowed'));
    writeFileSync(path.join(root, 'allowed', 'visible.txt'), 'needle');
    writeFileSync(path.join(root, 'private.txt'), 'needle');
    app.store.updateRun(runId, { scope: { read: ['allowed'], write: ['allowed'] } });
    await expect(execute('file.read', { path: 'private.txt' })).rejects.toMatchObject({ code: 'FILE_SCOPE' });
    await expect(execute('file.patch', { path: 'private.txt', expectedHash: digest('needle'), edits: [{ oldText: 'needle', newText: 'changed' }] })).rejects.toMatchObject({ code: 'FILE_SCOPE' });
    await expect(execute('file.mkdir', { path: 'outside' })).rejects.toMatchObject({ code: 'FILE_SCOPE' });
    await expect(execute('file.rename', { path: 'allowed/visible.txt', destination: 'outside.txt', expectedHash: digest('needle') })).rejects.toMatchObject({ code: 'FILE_SCOPE' });
    await expect(app.coordinator.tools.probePatchForRecovery(runId, { path: 'private.txt', expectedHash: digest('needle'), content: 'changed' })).rejects.toMatchObject({ code: 'FILE_SCOPE' });
    const listed = await execute('file.list', { path: '.' }) as { entries: { name: string }[] };
    expect(listed.entries.map(entry => entry.name)).toEqual(['allowed']);
    expect(await execute('file.search', { path: '.', query: 'needle' })).toMatchObject({ matches: [{ path: path.join('allowed', 'visible.txt') }], incomplete: true });
    app.store.updateRun(runId, { scope: { read: [], write: [] } });
    await expect(execute('file.read', { path: 'allowed/visible.txt' })).rejects.toMatchObject({ code: 'FILE_SCOPE' });
    await expect(execute('file.list', { path: '.' })).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });
});
