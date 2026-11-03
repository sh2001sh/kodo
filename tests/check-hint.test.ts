import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './helpers.js';
import { recordCheckStart, recordSuitePass, repeatedCheckHint, suitePassedNotice } from '../src/runtime/check-hint.js';
import * as snapshot from '../src/runtime/workspace-manifest.js';
import type { Call } from '../src/runtime/types.js';

afterEach(() => vi.restoreAllMocks());

function setup() {
  vi.spyOn(snapshot, 'workspaceManifest').mockReturnValue({ entries: [], excluded: 0, digest: 'known' });
  const f = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-solo', taskProtocol: 3, instructions: { global: false } });
  const store = f.app.store, run = store.run(f.runId), session = store.session(run.sessionId);
  const start = (id: string) => recordCheckStart(store, run, session, id, 'pytest -q');
  const finish = (result: unknown, overrides: Partial<Call> = {}, event = true) => {
    store.putCall({ id: 'first', runId: run.id, step: 0, kind: 'tool', name: 'shell.exec', status: 'succeeded', effect: 'write',
      requestRef: store.blob({ name: 'shell.exec', arguments: '{"command":"pytest -q"}' }), resultRef: store.blob(result), reservedTokens: 0, ...overrides });
    if (event) store.event(run.id, 'tool.finished', { callId: 'first', status: overrides.status ?? 'succeeded' });
  };
  return { store, run, session, start, finish };
}

it.each([
  { result: { exitCode: 1 } },
  { result: { exitCode: 0, timedOut: true } },
  { result: { exitCode: 0, cancelled: true } },
  { result: { exitCode: 0, processId: 'background' } },
  { result: { exitCode: 0 }, overrides: { effectOutcome: 'unknown' as const } },
  { result: { exitCode: 0 }, overrides: { status: 'running' as const } },
])('does not advertise a successful prior check with incomplete or failing evidence: %j', ({ result, overrides }) => {
  const f = setup();
  f.start('first'); f.finish(result, overrides);
  expect(f.start('second')).toBeUndefined();
});

it.each([false, true])('requires and reports the recorded success time (available: %s)', available => {
  const f = setup();
  f.start('first'); f.finish({ exitCode: 0 }, {}, available);
  const hint = f.start('second');
  if (!available) { expect(hint).toBeUndefined(); return; }
  const finished = f.store.latestEvent(f.run.id, { types: ['tool.finished'] })!;
  expect(hint).toContain(repeatedCheckHint);
  expect(hint).toContain(`Previous success: ${finished.time}.`);
});

it('records child versions for auditing without issuing main-agent reminders', () => {
  const f = setup();
  const child = { ...f.run, parentId: 'parent' };
  recordCheckStart(f.store, child, f.session, 'first', 'pytest -q');
  f.finish({ exitCode: 0 });
  expect(recordCheckStart(f.store, child, f.session, 'second', 'pytest -q')).toBeUndefined();
  expect(f.store.events(f.run.id, { types: ['check.started'] })).toHaveLength(2);
  expect(f.store.events(f.run.id, { types: ['check.repeat_hinted'] })).toHaveLength(0);
});

it('matches one check across different output filters and ignores intervening shell commands', () => {
  const f = setup();
  const command = (filter: string) => `cd /app && timeout 240 python -m pytest -q > /tmp/out.txt 2>&1; code=$?; grep -E "${filter}" /tmp/out.txt | tail -5; exit $code`;
  recordCheckStart(f.store, f.run, f.session, 'first', command('TOTAL|passed'));
  f.finish({ exitCode: 0 });
  f.store.putCall({ id: 'probe', runId: f.run.id, step: 1, kind: 'tool', name: 'shell.exec', status: 'succeeded', effect: 'write', requestRef: f.store.blob({}), reservedTokens: 0 });
  f.store.event(f.run.id, 'tool.started', { callId: 'probe' });
  expect(recordCheckStart(f.store, f.run, f.session, 'second', command('failed|passed'))).toContain(repeatedCheckHint);
});

it('still withholds the repeat hint after a native write', () => {
  const f = setup();
  f.start('first'); f.finish({ exitCode: 0 });
  f.store.putCall({ id: 'edit', runId: f.run.id, step: 1, kind: 'tool', name: 'file.patch', status: 'succeeded', effect: 'write', requestRef: f.store.blob({}), reservedTokens: 0 });
  f.store.event(f.run.id, 'tool.started', { callId: 'edit' });
  expect(f.start('second')).toBeUndefined();
});

it.each(['same', 'changed', 'failed', 'unknown', 'branch'])('handles evidence after a native Git operation: %s', variant => {
  const f = setup();
  f.start('first'); f.finish({ exitCode: 0, outputArtifact: { id: 'prior-output', capturedComplete: true } });
  f.store.putCall({ id: 'commit', runId: f.run.id, step: 1, kind: 'tool', name: 'workspace.git',
    status: variant === 'failed' ? 'failed' : 'succeeded', effect: 'write', effectOutcome: variant === 'unknown' ? 'unknown' : 'applied',
    requestRef: f.store.blob({ name: 'workspace.git', arguments: JSON.stringify({ action: variant === 'branch' ? 'branch' : 'commit' }) }), reservedTokens: 0 });
  f.store.event(f.run.id, 'tool.started', { callId: 'commit' });
  if (variant === 'changed') vi.mocked(snapshot.workspaceManifest).mockReturnValue({ digest: 'changed', excluded: 0,
    entries: [{ path: 'source.ts', mode: '100644', hash: 'changed', blob: 'changed', size: 1, mtimeMs: 1 }] });
  const hint = f.start('second');
  if (variant !== 'same') expect(hint).toBeUndefined();
  else {
    expect(hint).toContain(repeatedCheckHint);
    expect(hint).toContain('read {"artifact":"prior-output"}');
    expect(hint).toContain('capturedComplete: true');
  }
});

it('issues the suite notice once, only for a trusted whole-suite pass in a main lean run', () => {
  const f = setup();
  expect(recordSuitePass(f.store, f.run, 'a', 'pytest tests/test_one.py', { exitCode: 0 })).toBeUndefined();
  expect(recordSuitePass(f.store, f.run, 'b', 'pytest -q', { exitCode: 1 })).toBeUndefined();
  expect(recordSuitePass(f.store, f.run, 'c', 'pytest -q > log; tail -3 log', { exitCode: 0 })).toBeUndefined();
  expect(recordSuitePass(f.store, f.run, 'c2', 'pytest -q > log; v=$?; tail log; echo EXIT:$v', { exitCode: 0, stdout: '1 failed\nEXIT:1\n' })).toBeUndefined();
  expect(recordSuitePass(f.store, f.run, 'd', 'pytest -q', { exitCode: 0, timedOut: true })).toBeUndefined();
  expect(recordSuitePass(f.store, { ...f.run, parentId: 'parent' }, 'e', 'pytest -q', { exitCode: 0 })).toBeUndefined();
  recordCheckStart(f.store, f.run, f.session, 'f', 'pytest -q > log; v=$?; tail log; echo EXIT:$v');
  expect(recordSuitePass(f.store, f.run, 'f', 'pytest -q > log; v=$?; tail log; echo EXIT:$v', { exitCode: 0, stdout: '3 passed\nEXIT:0\n' })).toBe(suitePassedNotice);
  expect(recordSuitePass(f.store, f.run, 'g', 'pytest -q', { exitCode: 0 })).toBeUndefined();
  expect(f.store.events(f.run.id, { types: ['check.suite_passed'] })).toHaveLength(1);
});

it('records unparsed compound commands without attributing their checks to an invocation-time version', () => {
  const f = setup();
  const manifest = vi.mocked(snapshot.workspaceManifest);
  manifest.mockClear();
  const command = 'node update-source.js && npm test';
  expect(recordCheckStart(f.store, f.run, f.session, 'compound', command)).toBeUndefined();
  expect(f.store.latestEvent(f.run.id, { types: ['check.started'] })?.data).toMatchObject({ callId: 'compound', command, version: null });
  expect(manifest).not.toHaveBeenCalled();
  expect(recordSuitePass(f.store, f.run, 'compound', command, { exitCode: 0 })).toBeUndefined();
});

it('withholds current-version evidence when code changed during a check and allows a later stable pass', () => {
  const f = setup();
  f.start('first');
  vi.mocked(snapshot.workspaceManifest).mockReturnValue({ digest: 'changed', excluded: 0,
    entries: [{ path: 'source.ts', mode: '100644', hash: 'changed', blob: 'changed', size: 1, mtimeMs: 1 }] });
  expect(recordSuitePass(f.store, f.run, 'first', 'pytest -q', { exitCode: 0 })).toBeUndefined();
  expect(recordSuitePass(f.store, f.run, 'missing', 'pytest -q', { exitCode: 0 })).toBeUndefined();
  f.finish({ exitCode: 0 });
  f.start('second');
  expect(recordSuitePass(f.store, f.run, 'second', 'pytest -q', { exitCode: 0 })).toBe(suitePassedNotice);
  expect(f.store.latestEvent(f.run.id, { types: ['check.suite_passed'] })?.data.version).toBeTypeOf('string');
});

it('treats a printed failing status as no prior success for the repeat hint', () => {
  const f = setup();
  const command = 'pytest -q > log; v=$?; tail log; echo EXIT:$v';
  recordCheckStart(f.store, f.run, f.session, 'first', command);
  f.finish({ exitCode: 0, stdout: '1 failed\nEXIT:1\n' });
  expect(recordCheckStart(f.store, f.run, f.session, 'second', command)).toBeUndefined();
});

it.each([
  'pytest -q; python -c "print(123)"',
  'pytest -q; v=$?; tail log || exit $v',
])('withholds both notices when outer success does not establish test success: %s', command => {
  const f = setup();
  const result = { exitCode: 0, stdout: 'EXIT:0\n' };
  recordCheckStart(f.store, f.run, f.session, 'first', command);
  f.finish(result);
  expect(recordCheckStart(f.store, f.run, f.session, 'second', command)).toBeUndefined();
  expect(recordSuitePass(f.store, f.run, 'first', command, result)).toBeUndefined();
  expect(f.store.events(f.run.id, { types: ['check.repeat_hinted', 'check.suite_passed'] })).toHaveLength(0);
});
