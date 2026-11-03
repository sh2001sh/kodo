import { describe, expect, it } from 'vitest';
import { fixture } from './helpers.js';
import type { Checkpoint } from '../src/storage/checkpoints.js';

describe('bounded runtime storage', () => {
  it('selects prioritized call samples and counts one immutable request without reading call history', () => {
    const { app, runId } = fixture();
    const requestRef = app.store.blob({ request: 'first' });
    const other = app.store.blob({ request: 'second' });
    app.store.transaction(() => {
      for (let index = 0; index < 80; index++) app.store.putCall({ id: `bounded-${index}`, runId, step: index, kind: 'tool', name: 'sample', status: index === 1 ? 'unknown' : index % 2 ? 'failed' : 'running', effect: 'read', requestRef: index < 20 ? requestRef : other, reservedTokens: 0 });
    });
    expect(app.store.countCalls(runId, { requestRef })).toBe(20);
    const calls = app.store.queryCalls(runId, { kind: 'tool', status: ['unknown', 'running', 'failed'], statusOrder: ['unknown', 'running', 'failed'], limit: 5 });
    expect(calls.map(call => call.id)).toEqual(['bounded-1', 'bounded-78', 'bounded-76', 'bounded-74', 'bounded-72']);
    expect(app.store.countCalls(runId, { status: 'failed' })).toBe(39);
    expect(app.store.queryCalls(runId, { status: [], limit: 5 })).toEqual([]);
  });

  it('keeps checkpoint retention bounded, records the rewind floor, and retains file bodies through GC', () => {
    const { app, runId } = fixture();
    const firstRef = app.store.blob({ encoding: 'base64', content: 'first-checkpoint-only' });
    const lastRef = app.store.blob({ encoding: 'base64', content: 'latest-checkpoint' });
    for (let index = 0; index < 105; index++) {
      const checkpoint: Checkpoint = { id: `cp-${index}`, runId, step: index, preparationId: `prepare-${index}`, paths: { path: 'report.txt' }, before: { 'report.txt': { kind: 'file', bytes: 10, hash: 'observed', contentRef: index < 5 ? firstRef : lastRef } } };
      app.store.checkpoints.put(checkpoint);
    }
    expect(app.store.checkpoints.list(runId)).toHaveLength(100);
    expect(app.store.checkpoints.list(runId)[0]?.id).toBe('cp-104');
    expect(app.store.checkpoints.floor(runId)).toBe(4);
    app.store.checkpoints.complete('prepare-104', { 'report.txt': { kind: 'absent' } });
    expect(app.store.checkpoints.list(runId)[0]?.after).toEqual({ 'report.txt': { kind: 'absent' } });
    app.store.gc();
    expect(app.store.hasBlob(firstRef)).toBe(false);
    expect(app.store.readBlob(lastRef)).toEqual({ encoding: 'base64', content: 'latest-checkpoint' });
    app.store.checkpoints.deleteAfter(runId, 102);
    expect(app.store.checkpoints.list(runId)[0]?.step).toBe(102);
  });

  it('notifies a storage fault once and rejects subsequent writes while leaving reads available', () => {
    const { app, runId } = fixture();
    const before = app.store.run(runId);
    const failure = new Error('storage unavailable');
    const observed: unknown[] = [];
    app.store.onFault(error => observed.push(error));
    app.store.fail(failure);
    app.store.fail(new Error('second failure'));
    expect(observed).toEqual([failure]);
    expect(app.store.fault).toBe(failure);
    expect(() => app.store.updateRun(runId, { status: 'failed' })).toThrow(failure);
    expect(() => app.store.blob({ new: 'value' })).toThrow(failure);
    expect(() => app.store.checkpoints.put({ id: 'cp-blocked', runId, step: 0, preparationId: 'blocked', paths: {}, before: {} })).toThrow(failure);
    expect(app.store.run(runId)).toEqual(before);
  });
});
