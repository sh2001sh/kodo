import { storageTestConnection } from '../src/storage/test-access.js';
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/storage/index.js';
import type { Page, SubscriberError } from '../src/storage/index.js';
import type { Call } from '../src/runtime/types.js';
import { binding, fixture } from './helpers.js';

function collect<T>(read: (after: number) => Page<T>): T[] {
  const items: T[] = [];
  let after = 0;
  for (;;) {
    const page = read(after);
    items.push(...page.items);
    if (page.next === null) return items;
    expect(page.next).toBeGreaterThan(after);
    after = page.next;
  }
}

describe('bounded durable storage queries', () => {
  it('pages sessions, runs, calls, messages and scoped event replay without omissions', () => {
    const { app, runId, root } = fixture();
    const first = app.store.run(runId);
    const peer = { ...first, id: 'peer' };
    app.store.putRun(peer);
    const other = app.createRun({ objective: 'unrelated', workspace: root, binding });
    app.store.putRun({ ...peer, id: 'peer-two', status: 'failed' });
    for (let index = 0; index < 5; index++) {
      app.store.putCall({ id: `call-${index}`, runId, step: index, kind: 'model', name: 'test', status: 'succeeded', effect: 'read', requestRef: 'request', reservedTokens: 0 });
      app.store.putMessage({ id: `message-${index}`, sessionId: first.sessionId, from: 'user', to: index % 2 ? peer.id : runId, kind: 'input', content: `${index}` });
      app.store.event(index % 2 ? peer.id : runId, 'test.replay', { index });
    }
    expect(collect(after => app.store.sessionsPage({ after, limit: 1 })).map(session => session.id)).toEqual([first.sessionId, other.sessionId]);
    expect(collect(after => app.store.runsPage({ sessionId: first.sessionId, after, limit: 1 })).map(run => run.id)).toEqual([runId, 'peer', 'peer-two']);
    expect(app.store.runsPage({ sessionId: first.sessionId, status: 'failed' }).items.map(run => run.id)).toEqual(['peer-two']);
    expect(collect(after => app.store.callsPage(runId, { after, limit: 2 })).map(call => call.id)).toEqual(['call-0', 'call-1', 'call-2', 'call-3', 'call-4']);
    expect(collect(after => app.store.messagesPage(first.sessionId, { after, limit: 2 }))).toEqual(app.store.messages(first.sessionId));
    expect(app.store.messagesPage(first.sessionId, { recipient: peer.id }).items.map(message => message.id)).toEqual(['message-1', 'message-3']);
    const events = collect(after => app.store.eventsPage({ sessionId: first.sessionId, after, limit: 2 }));
    expect(events.every(event => event.sessionId === first.sessionId)).toBe(true);
    expect(events.filter(event => event.type === 'test.replay').map(event => event.data.index)).toEqual([0, 1, 2, 3, 4]);
    expect(app.store.eventsPage({ sessionId: other.sessionId, runId }).items).toEqual([]);
    expect(collect(after => app.store.eventsPage({ runId, after, limit: 1 }))).toEqual(app.store.events(runId));
    expect(app.store.eventsPage({ after: Number.MAX_SAFE_INTEGER }).items).toEqual([]);
  });

  it('retains cursor ordering after updates, retention, new insertions and reopening', () => {
    const { app, runId, root } = fixture();
    const first = app.store.run(runId);
    const other = app.createRun({ objective: 'second', workspace: root, binding });
    const call = (id: string): Call => ({ id, runId, step: 0, kind: 'model', name: 'model', status: 'succeeded', effect: 'read', requestRef: 'request', reservedTokens: 0 });
    app.store.putCall(call('first-call'));
    app.store.putCall(call('second-call'));
    const sessionsAfter = app.store.sessionsPage({ limit: 1 }).next!;
    const runsAfter = app.store.runsPage({ limit: 1 }).next!;
    const callsAfter = app.store.callsPage(runId, { limit: 1 }).next!;
    app.store.updateRun(runId, { objective: 'updated in place' });
    expect(app.store.runsPage({ limit: 1 }).items[0]?.id).toBe(runId);
    expect(app.store.runsPage({ limit: 1 }).next).toBe(runsAfter);
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    for (const id of [first.id, other.id]) {
      const run = app.store.run(id);
      app.store.putSession({ ...app.store.session(run.sessionId), createdAt: old });
      app.store.updateRun(id, { status: 'completed' });
    }
    storageTestConnection(app.store).prepare('UPDATE events SET time=?').run(old);
    expect(app.store.gc({ olderThanDays: 2 }).removedSessions).toBe(2);
    expect(storageTestConnection(app.store).prepare('SELECT COUNT(*) AS count FROM record_order').get()).toEqual({ count: 0 });
    const next = app.createRun({ objective: 'after retention', workspace: root, binding });
    app.store.putCall({ ...call('new-call'), runId: next.id });
    const directory = app.store.directory;
    app.close();
    const reopened = new Store(directory);
    try {
      expect(reopened.sessionsPage({ after: sessionsAfter }).items.map(session => session.id)).toEqual([next.sessionId]);
      expect(reopened.runsPage({ after: runsAfter }).items.map(run => run.id)).toEqual([next.id]);
      expect(reopened.callsPage(next.id, { after: callsAfter }).items.map(record => record.id)).toEqual(['new-call']);
    } finally { reopened.close(); }
  });

  it('backfills ordering for databases created before pagination support', () => {
    const { app, runId } = fixture();
    const directory = app.store.directory;
    storageTestConnection(app.store).exec(`
      DROP TRIGGER sessions_record_insert; DROP TRIGGER sessions_record_delete;
      DROP TRIGGER runs_record_insert; DROP TRIGGER runs_record_delete;
      DROP TRIGGER calls_record_insert; DROP TRIGGER calls_record_delete;
      DROP TABLE record_order;
    `);
    app.close();
    const reopened = new Store(directory);
    try {
      expect(reopened.runsPage().items.map(run => run.id)).toEqual([runId]);
      expect(reopened.sessionsPage().items).toHaveLength(1);
    } finally { reopened.close(); }
  });

  it.each([
    { limit: 0 }, { limit: -1 }, { limit: 1001 }, { limit: 1.5 }, { limit: Infinity },
    { after: -1 }, { after: 0.5 }, { after: NaN }, { after: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects unsafe page bounds %j consistently', options => {
    const { app, runId } = fixture();
    const sessionId = app.store.run(runId).sessionId;
    for (const query of [
      () => app.store.sessionsPage(options), () => app.store.runsPage(options),
      () => app.store.callsPage(runId, options), () => app.store.messagesPage(sessionId, options),
      () => app.store.eventsPage(options),
    ]) expect(query).toThrow('after must be a nonnegative safe integer');
  });

  it('bounds recent calibration reads to successful model calls in reverse creation order', () => {
    const { app, runId } = fixture();
    for (let index = 0; index < 40; index++) app.store.putCall({ id: `model-${index}`, runId, step: index, kind: 'model', name: 'model', status: 'succeeded', effect: 'read', requestRef: 'request', reservedTokens: 0 });
    app.store.putCall({ id: 'tool', runId, step: 41, kind: 'tool', name: 'read', status: 'succeeded', effect: 'read', requestRef: 'request', reservedTokens: 0 });
    app.store.putCall({ id: 'failed', runId, step: 42, kind: 'model', name: 'model', status: 'failed', effect: 'read', requestRef: 'request', reservedTokens: 0 });
    expect(app.store.recentModelCalls(runId).map(call => call.id)).toEqual(Array.from({ length: 32 }, (_, index) => `model-${39 - index}`));
    expect(app.store.recentModelCalls(runId, 2).map(call => call.id)).toEqual(['model-39', 'model-38']);
    expect(() => app.store.recentModelCalls(runId, 0)).toThrow('limit');
  });
});

describe('postcommit subscriber isolation', () => {
  it('reports listener errors while preserving committed state and delivering subsequent events', () => {
    const { app, runId } = fixture();
    const directory = app.store.directory;
    app.close();
    const errors: SubscriberError[] = [];
    const store = new Store(directory, { onSubscriberError: failure => errors.push(failure) });
    try {
      const failure = new Error('private subscriber detail');
      const delivered: string[] = [];
      store.subscribe(() => { throw failure; });
      store.subscribe(event => delivered.push(event.type));
      expect(store.transaction(() => {
        store.updateRun(runId, { status: 'completed' });
        store.event(runId, 'one');
        store.event(runId, 'two');
        return 'committed';
      })).toBe('committed');
      expect(store.run(runId).status).toBe('completed');
      expect(store.events(runId).slice(-2).map(event => event.type)).toEqual(['one', 'two']);
      expect(delivered).toEqual(['one', 'two']);
      expect(errors.map(error => error.error)).toEqual([failure, failure]);
    } finally { store.close(); }
  });

  it('sanitizes default reporting and errors thrown by the reporting hook', () => {
    const { app, runId } = fixture();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      app.store.subscribe(() => { throw new Error('secret default failure'); });
      expect(() => app.store.event(runId, 'reported')).not.toThrow();
      expect(JSON.stringify(warning.mock.calls)).not.toContain('secret');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('after commit'), { code: 'KODO_SUBSCRIBER_ERROR' });
      const directory = app.store.directory;
      app.close();
      const store = new Store(directory, { onSubscriberError: () => { throw new Error('secret hook failure'); } });
      try {
        const delivered: string[] = [];
        store.subscribe(() => { throw new Error('secret listener failure'); });
        store.subscribe(event => delivered.push(event.type));
        expect(() => store.event(runId, 'hook.failed')).not.toThrow();
        expect(delivered).toEqual(['hook.failed']);
        expect(JSON.stringify(warning.mock.calls)).not.toContain('secret');
      } finally { store.close(); }
    } finally { warning.mockRestore(); }
  });
});
