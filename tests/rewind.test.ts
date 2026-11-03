import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { digest } from '../src/storage/index.js';
import { rewindRun } from '../src/runtime/rewind.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

describe('retained native file checkpoints', () => {
  it('restores exact retained bytes and refreshes native read state', async () => {
    const { app, root, runId } = fixture();
    const file = path.join(root, 'result.txt');
    const before = '\uFEFF原始内容\r\nsecond line\r\n';
    const after = 'replacement';
    writeFileSync(file, after);
    app.store.checkpoints.put({
      id: 'exact-bytes', runId, preparationId: 'exact-bytes', step: 0, paths: { path: file },
      before: { path: { kind: 'file', hash: digest(before), bytes: Buffer.byteLength(before), contentRef: app.store.blob({ encoding: 'base64', content: Buffer.from(before).toString('base64'), mode: 0o600 }) } },
      after: { path: { kind: 'file', hash: digest(after), bytes: Buffer.byteLength(after) } },
    });
    app.store.updateRun(runId, { status: 'completed', step: 1 });
    expect((await rewindRun(app.store, runId, -1)).rewound).toBe(1);
    expect(readFileSync(file)).toEqual(Buffer.from(before));
    expect(app.store.fileStates.get(runId, file)?.hash).toBe(digest(before));
  });

  it('rewinds delete and rename, then restores the earlier patched content', async () => {
    const { app, root, runId } = fixture(scripted(
      calls(call('file.read', { path: 'source.txt' })),
      calls(call('file.patch', { path: 'source.txt', expectedHash: digest('before'), edits: [{ oldText: 'before', newText: 'after' }] })),
      calls(call('file.rename', { path: 'source.txt', destination: 'target.txt', expectedHash: digest('after') })),
      calls(call('file.delete', { path: 'target.txt', expectedHash: digest('after') })),
      answer('Files updated.'),
    ));
    writeFileSync(path.join(root, 'source.txt'), 'before');
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.checkpoints.list(runId)).toHaveLength(3);
    expect(existsSync(path.join(root, 'source.txt'))).toBe(false);
    const first = await rewindRun(app.store, runId, 1);
    expect(first.rewound).toBe(2);
    expect(readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('after');
    expect(existsSync(path.join(root, 'target.txt'))).toBe(false);
    const second = await rewindRun(app.store, runId, -1);
    expect(second.rewound).toBe(1);
    expect(readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('before');
    expect(app.store.fileStates.get(runId, path.join(root, 'source.txt'))?.hash).toBe(digest('before'));
    expect(app.store.events(runId, { types: ['file.rewind.completed'] })).toHaveLength(2);
  });

  it('removes a newly created file before its newly created directory', async () => {
    const { app, root, runId } = fixture(scripted(
      calls(call('file.mkdir', { path: 'output' })),
      calls(call('file.apply_patch', { path: 'output/result.txt', expectedHash: null, content: 'result' })),
      answer('Created result.'),
    ));
    expect((await app.run(runId)).status).toBe('completed');
    expect(readFileSync(path.join(root, 'output/result.txt'), 'utf8')).toBe('result');
    expect((await rewindRun(app.store, runId, -1)).rewound).toBe(2);
    expect(existsSync(path.join(root, 'output'))).toBe(false);
  });

  it('leaves every path untouched when current contents differ from the checkpoint', async () => {
    const { app, root, runId } = fixture(scripted(
      calls(call('file.apply_patch', { path: 'result.txt', expectedHash: null, content: 'result' })), answer('Created result.'),
    ));
    expect((await app.run(runId)).status).toBe('completed');
    writeFileSync(path.join(root, 'result.txt'), 'later host edit');
    await expect(rewindRun(app.store, runId, -1)).rejects.toMatchObject({ code: 'REWIND_CHANGED' });
    expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('later host edit');
    expect(app.store.checkpoints.list(runId)).toHaveLength(1);
  });

  it('retains at most 100 checkpoints and explicitly rejects an older rewind target', async () => {
    const { app, root, runId } = fixture();
    const contentRef = app.store.blob({ encoding: 'base64', content: Buffer.from('before').toString('base64') });
    for (let step = 0; step < 101; step++) app.store.checkpoints.put({
      id: `checkpoint-${step}`, runId, preparationId: `preparation-${step}`, step,
      paths: { path: path.join(root, 'result.txt') }, before: { path: { kind: 'file', hash: digest('before'), bytes: 6, contentRef } }, after: { path: { kind: 'file', hash: digest('after'), bytes: 5 } },
    });
    app.store.updateRun(runId, { status: 'completed', step: 101 });
    expect(app.store.checkpoints.list(runId)).toHaveLength(100);
    expect(app.store.checkpoints.floor(runId)).toBe(0);
    await expect(rewindRun(app.store, runId, -1)).rejects.toMatchObject({ code: 'REWIND_HISTORY' });
  });
});
