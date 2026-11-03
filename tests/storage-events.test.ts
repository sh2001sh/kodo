import { storageTestConnection } from '../src/storage/test-access.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/storage/index.js';
import type { EventFilter } from '../src/storage/index.js';
import { answer, call, calls, fixture } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

const readers = ['events', 'latestEvent', 'hasEvent', 'countEvents'] as const;
type Reader = (this: Store, runId: string, filter?: number | EventFilter) => unknown;
interface Measured { steps: number; reads: number; rows: number; unfiltered: number; status: string; error?: string }

/** Runs a scripted main run that reads one distinct file per step, recording every event read the runtime makes. */
async function measure(steps: number): Promise<Measured> {
  let step = 0;
  const f = fixture({ async complete() { return step < steps ? calls(call('file.read', { path: `f-${step}.txt` }, `read-${step++}`)) : answer('done'); } });
  for (let index = 0; index < steps; index++) writeFileSync(path.join(f.root, `f-${index}.txt`), `evidence ${index}`);
  const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
  f.app.store.putSession({ ...session, budget: { ...session.budget, maxModelCalls: steps + 5, maxTokens: 10_000_000 } });
  const measured: Measured = { steps, reads: 0, rows: 0, unfiltered: 0, status: '' };
  for (const name of readers) {
    const original = Store.prototype[name] as unknown as Reader;
    vi.spyOn(Store.prototype, name).mockImplementation(function (this: Store, runId: string, filter?: number | EventFilter) {
      const result = original.call(this, runId, filter);
      measured.reads++;
      if (filter === undefined || typeof filter === 'number' || (!filter.types?.length && filter.typePrefix === undefined)) measured.unfiltered++;
      if (Array.isArray(result)) measured.rows += result.length;
      else if (result && typeof result === 'object') measured.rows++;
      return result;
    } as never);
  }
  const result = await f.app.run(f.runId);
  vi.restoreAllMocks();
  return { ...measured, status: result.status, ...(result.error ? { error: result.error } : {}) };
}

/** Counter rows recomputed from scratch, for comparison against the trigger-maintained tables. */
function recount(store: Store, runId: string): { events: Record<string, number>; calls: number } {
  const events = Object.fromEntries((storageTestConnection(store).prepare('SELECT type,count(*) AS count FROM events WHERE run_id=? GROUP BY type').all(runId) as { type: string; count: number }[]).map(row => [row.type, row.count]));
  return { events, calls: (storageTestConnection(store).prepare('SELECT count(*) AS count FROM calls WHERE run_id=?').get(runId) as { count: number }).count };
}
const toolCall = (runId: string, id: string, status: string, name = 'file.read') => ({ id, runId, kind: 'tool', name, status, effect: 'read', requestRef: '0'.repeat(64) }) as never;

describe('event filters and materialized counters', () => {
  it('filters by type, prefix, sequence and exact scalar JSON type', () => {
    const { app, runId } = fixture();
    const store = app.store;
    store.event(runId, 'probe.a', { key: 'x', flag: true, n: 1, empty: null });
    store.event(runId, 'probe.b', { key: 'x', flag: 1, n: '1' });
    store.event(runId, 'probe%c', { key: 'y' });
    const first = store.latestEvent(runId, { types: ['probe.a'] })!;
    expect(store.events(runId, { types: ['probe.a', 'probe.b'] }).map(event => event.type)).toEqual(['probe.a', 'probe.b']);
    expect(store.events(runId, { typePrefix: 'probe.' }).map(event => event.type)).toEqual(['probe.a', 'probe.b']);
    expect(store.events(runId, { typePrefix: 'probe%' }).map(event => event.type)).toEqual(['probe%c']);
    expect(store.events(runId, { typePrefix: 'probe', after: first.seq }).map(event => event.type)).toEqual(['probe.b', 'probe%c']);
    expect(store.events(runId, { match: { flag: true } }).map(event => event.type)).toEqual(['probe.a']);
    expect(store.events(runId, { match: { flag: 1 } }).map(event => event.type)).toEqual(['probe.b']);
    expect(store.events(runId, { match: { n: 1 } }).map(event => event.type)).toEqual(['probe.a']);
    expect(store.events(runId, { match: { n: '1' } }).map(event => event.type)).toEqual(['probe.b']);
    expect(store.events(runId, { match: { empty: null } }).map(event => event.type)).toEqual(['probe.a']);
    expect(store.latestEvent(runId, { match: { key: 'x' } })?.type).toBe('probe.b');
    expect(store.hasEvent(runId, { types: ['probe.a'], match: { key: 'y' } })).toBe(false);
    expect(store.events(runId, { types: [] })).toEqual([]);
    expect(store.countEvents(runId, { types: [] })).toBe(0);
    expect(() => store.events(runId, { match: { "a') OR 1=1 --": 'x' } })).toThrow('plain top-level names');
    expect(() => store.events(runId, { after: -1 })).toThrow('nonnegative');
    expect(() => store.events(runId, { typePrefix: '' })).toThrow('nonempty');
  });

  it('keeps event and call counters equal to their rows through insert, update, rollback and gc', () => {
    const { app, runId } = fixture();
    const store = app.store;
    for (let index = 0; index < 5; index++) store.event(runId, index % 2 ? 'probe.odd' : 'probe.even', { index });
    expect(store.countEvents(runId, { types: ['probe.even'] })).toBe(3);
    expect(store.countEvents(runId, { types: ['probe.odd', 'probe.even'] })).toBe(5);
    expect(store.countEvents(runId, { types: ['probe.even'], match: { index: 4 } })).toBe(1);
    expect(store.latestEventSeq(runId)).toBe(store.latestEvent(runId)!.seq);
    store.putCall(toolCall(runId, 'c1', 'running'));
    store.putCall(toolCall(runId, 'c2', 'running', 'grep'));
    expect(store.countCalls(runId, { kind: 'tool', status: 'running' })).toBe(2);
    store.putCall(toolCall(runId, 'c1', 'succeeded'));
    expect(store.countCalls(runId, { kind: 'tool', status: 'running' })).toBe(1);
    expect(store.countCalls(runId, { name: ['file.read', 'grep'], status: 'succeeded' })).toBe(1);
    expect(store.countCalls(runId, { name: [] })).toBe(0);
    expect(() => store.transaction(() => {
      store.event(runId, 'probe.even', {});
      store.putCall(toolCall(runId, 'c3', 'running'));
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(store.countEvents(runId, { types: ['probe.even'] })).toBe(3);
    expect(store.countCalls(runId)).toBe(2);
    const total = (storageTestConnection(store).prepare('SELECT coalesce(sum(count),0) AS count FROM event_counts WHERE run_id=?').get(runId) as { count: number }).count;
    expect(total).toBe(Object.values(recount(store, runId).events).reduce((sum, count) => sum + count, 0));
    storageTestConnection(store).prepare('DELETE FROM events WHERE run_id=? AND type=?').run(runId, 'probe.odd');
    storageTestConnection(store).prepare('DELETE FROM calls WHERE id=?').run('c2');
    expect(store.countEvents(runId, { types: ['probe.odd'] })).toBe(0);
    expect(storageTestConnection(store).prepare('SELECT 1 FROM event_counts WHERE run_id=? AND type=?').get(runId, 'probe.odd')).toBeUndefined();
    expect(store.countCalls(runId)).toBe(1);
  });

  it('backfills counters once when an existing v5 database first gains them', () => {
    const { app, runId } = fixture();
    const directory = app.store.directory;
    app.store.event(runId, 'probe.legacy', { index: 1 });
    app.store.putCall(toolCall(runId, 'legacy', 'succeeded'));
    const expected = recount(app.store, runId);
    storageTestConnection(app.store).exec(`DROP TRIGGER event_counts_insert; DROP TRIGGER event_counts_delete; DROP TRIGGER call_counts_insert; DROP TRIGGER call_counts_update; DROP TRIGGER call_counts_delete;
      DROP TABLE event_counts; DROP TABLE call_counts; DROP INDEX events_type; PRAGMA user_version = 5;`);
    // Rows written before the upgrade are invisible to the dropped counters.
    storageTestConnection(app.store).prepare('INSERT INTO events(session_id,run_id,type,time,data) VALUES (?,?,?,?,?)').run(app.store.run(runId).sessionId, runId, 'probe.legacy', new Date().toISOString(), '{}');
    expected.events['probe.legacy'] = (expected.events['probe.legacy'] ?? 0) + 1;
    app.close();
    const upgraded = new Store(directory);
    try {
      expect(storageTestConnection(upgraded).pragma('user_version', { simple: true })).toBe(7);
      for (const [type, count] of Object.entries(expected.events)) expect(upgraded.countEvents(runId, { types: [type] })).toBe(count);
      expect(upgraded.countCalls(runId)).toBe(expected.calls);
      expect(upgraded.countCalls(runId, { kind: 'tool', name: 'file.read', status: 'succeeded' })).toBe(1);
      expect(upgraded.latestEventSeq(runId)).toBe(upgraded.latestEvent(runId)!.seq);
    } finally { upgraded.close(); }
  });

  it('serves typed and latest lookups from the type index', () => {
    const { app, runId } = fixture();
    const plan = (sql: string, ...values: unknown[]): string => (storageTestConnection(app.store).prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as { detail: string }[]).map(row => row.detail).join('\n');
    expect(plan('SELECT * FROM events WHERE run_id=? AND type IN (?) ORDER BY seq DESC LIMIT 1', runId, 'tool.started')).toContain('events_type');
    expect(plan('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq', runId, 0)).toMatch(/USING (INDEX|PRIMARY KEY|INTEGER PRIMARY KEY)/);
  });
});

describe('indexed event reads', () => {
  it('reads a bounded number of event rows per step as the run grows', async () => {
    const short = await measure(6);
    const long = await measure(24);
    expect(short.status, short.error).toBe('completed');
    expect(long.status, long.error).toBe('completed');
    // The runtime must actually be observed reading events, through typed filters only.
    expect(short.reads).toBeGreaterThan(0);
    expect(long.unfiltered).toBe(0);
    // Per-step reads and returned rows stay flat: a 4x longer run may not read more per step.
    const perStep = (value: number, steps: number): number => value / (steps + 1);
    expect(perStep(long.reads, long.steps)).toBeLessThanOrEqual(perStep(short.reads, short.steps) * 1.25 + 1);
    expect(perStep(long.rows, long.steps)).toBeLessThanOrEqual(perStep(short.rows, short.steps) * 1.25 + 1);
  });
});
