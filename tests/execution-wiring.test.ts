import { afterEach, describe, expect, it, vi } from 'vitest';
import * as checkout from '../src/runtime/execution-checkout.js';
import { acquireWriteLock } from '../src/tools/write-locks.js';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { answer, call, calls, fixture, temp } from './helpers.js';
import type { Message, Provider, Run } from '../src/runtime/types.js';
import { cleanupSessionCheckouts, hostCommitChild, releaseChildCheckout, snapshotForChild } from '../src/runtime/execution-lean.js';
import { integrateNode, plannedIntegration, prepareIntegration, recoverHostCalls } from '../src/runtime/execution-integration.js';
import { startHostCall } from '../src/runtime/execution-host-calls.js';
import { cleanupSessionExecutions } from '../src/runtime/execution-retention.js';
import { repeatedCheckHint, suitePassedNotice } from '../src/runtime/check-hint.js';

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true, env });
const lines = (...values: string[]): string => values.map(value => `${value}\n`).join('');
const read = (root: string, file: string): string => readFileSync(path.join(root, file), 'utf8');
const signal = () => new AbortController().signal;
const sessions: { root: string; sessionId: string }[] = [];
afterEach(() => { for (const { root, sessionId } of sessions.splice(0)) cleanupSessionExecutions(root, sessionId); });

type Request = Parameters<Provider['complete']>[0];
type Step = ReturnType<typeof calls> | ((request: Request) => ReturnType<typeof calls>);

/** Lean main run on a committed repository whose private state directory is ignored. */
function lean(...steps: Step[]) {
  const requests: Request[] = [];
  const provider: Provider = { async complete(request) {
    requests.push(structuredClone(request));
    const next = steps.shift();
    if (!next) throw new Error('unexpected model request');
    return typeof next === 'function' ? next(request) : next;
  } };
  const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'lean-solo', taskProtocol: 3, instructions: { global: false } });
  git(f.root, 'init', '-q');
  writeFileSync(path.join(f.root, '.gitignore'), '.state/\n');
  writeFileSync(path.join(f.root, 'a.txt'), lines('one', 'two', 'three', 'four', 'five', 'six'));
  writeFileSync(path.join(f.root, 'b.txt'), lines('bee'));
  git(f.root, 'add', '.'); git(f.root, 'commit', '-q', '-m', 'baseline');
  const main = f.app.store.run(f.runId);
  sessions.push({ root: f.root, sessionId: main.sessionId });
  return { ...f, requests, store: f.app.store, tools: f.app.coordinator.tools, main: () => f.app.store.run(f.runId) };
}
type Lean = ReturnType<typeof lean>;

describe('execution workspace concurrency', () => {
  it('locks child roots independently while preserving family-wide exclusion', async () => {
    const f = lean();
    const a = await child(f, 'a'), b = await child(f, 'b');
    const unlockMain = await f.tools.workspaceWriteLock(f.runId);
    const unlockA = await f.tools.workspaceWriteLock(a.run.id, undefined, true);
    const unlockB = await f.tools.workspaceWriteLock(b.run.id, undefined, true);
    try {
      await expect(f.tools.workspaceWriteLock(a.run.id, undefined, true)).rejects.toMatchObject({ code: 'LOCK_BUSY' });
      await expect(acquireWriteLock(f.root, [f.root, a.root, b.root], { directory: false, tryOnly: true })).rejects.toMatchObject({ code: 'LOCK_BUSY' });
    } finally { unlockB(); unlockA(); unlockMain(); }
    const unlockFamily = await acquireWriteLock(f.root, [f.root, a.root, b.root], { directory: false });
    try { await expect(f.tools.workspaceWriteLock(a.run.id, undefined, true)).rejects.toMatchObject({ code: 'LOCK_BUSY' }); }
    finally { unlockFamily(); }
  });

  it('releases the source before checkout IO and reuses the captured version after cancellation', async () => {
    const f = lean();
    const request = { main: f.main(), nodeId: 'capture', generation: 1, childId: randomUUID() };
    const controller = new AbortController();
    const prepare = checkout.prepareSnapshotCheckout;
    const spy = vi.spyOn(checkout, 'prepareSnapshotCheckout').mockImplementationOnce(async snapshot => {
      const unlock = await f.tools.workspaceWriteLock(f.runId, undefined, true);
      try { writeFileSync(path.join(f.root, 'b.txt'), 'new main version\n'); }
      finally { unlock(); }
      expect(snapshot.manifest.entries.find(entry => entry.path === 'b.txt')).toBeDefined();
      controller.abort(new Error('cancel preparation'));
      controller.signal.throwIfAborted();
    });
    try { await expect(snapshotForChild(f.store, f.tools, request, { signal: controller.signal })).rejects.toThrow('cancel preparation'); }
    finally { spy.mockRestore(); }
    const recovered = await snapshotForChild(f.store, f.tools, request);
    expect(read(recovered.execution.root, 'b.txt')).toBe('bee\n');
    expect(read(f.root, 'b.txt')).toBe('new main version\n');
    expect(f.store.events(f.runId, { types: ['execution.snapshot.captured'] })).toHaveLength(1);
    expect(checkout.prepareSnapshotCheckout).toBe(prepare);
  });
});

async function child(f: Lean, nodeId = 'node', generation = 1) {
  const id = randomUUID();
  const snapshot = await snapshotForChild(f.store, f.tools, { main: f.main(), nodeId, generation, childId: id });
  const run: Run = { ...f.main(), id, parentId: f.runId, execution: snapshot.execution, status: 'running', scope: { read: ['.'], write: ['.'] } };
  f.store.putRun(run);
  return { run, snapshot, root: snapshot.execution.root };
}

/** A child that edits line one of a.txt and adds a file, committed by the host and finished. */
async function delivered(f: Lean, edit = (root: string) => { writeFileSync(path.join(root, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five', 'six')); writeFileSync(path.join(root, 'c.txt'), lines('sea')); }) {
  const made = await child(f);
  edit(made.root);
  const committed = hostCommitChild(f.store, f.main(), made.run.id);
  f.store.updateRun(made.run.id, { status: 'completed' });
  return { ...made, committed };
}

const indexHash = (root: string): string => createHash('sha256').update(readFileSync(path.join(root, '.git', 'index'))).digest('hex');
const hostCalls = (f: Lean, name: string) => f.store.calls(f.runId).filter(item => item.name === name);

describe('snapshot execution wiring', () => {
  it('snapshots a dirty workspace without changing the user HEAD, index or files, and records execution.snapshot', async () => {
    const f = lean();
    writeFileSync(path.join(f.root, 'a.txt'), 'uncommitted main edit\n');
    writeFileSync(path.join(f.root, 'staged.txt'), 'staged\n'); git(f.root, 'add', 'staged.txt');
    writeFileSync(path.join(f.root, 'untracked.txt'), 'untracked\n');
    const before = { head: git(f.root, 'rev-parse', 'HEAD'), index: indexHash(f.root), status: git(f.root, 'status', '--porcelain=v2', '--untracked-files=all') };
    const { snapshot, root, run } = await child(f);
    expect({ head: git(f.root, 'rev-parse', 'HEAD'), index: indexHash(f.root), status: git(f.root, 'status', '--porcelain=v2', '--untracked-files=all') }).toEqual(before);
    expect(read(root, 'a.txt')).toBe('uncommitted main edit\n');
    expect(read(root, 'untracked.txt')).toBe('untracked\n');
    expect(run.execution).toMatchObject({ snapshotRef: snapshot.record.ref, generation: 1, baseCommit: snapshot.record.commit });
    const [event] = f.store.events(f.runId, { types: ['execution.snapshot'] });
    expect(event?.data).toMatchObject({ nodeId: 'node', generation: 1, commit: snapshot.record.commit, ref: snapshot.record.ref, sourceHead: before.head.trim(), manifestDigest: snapshot.manifest.digest });
  });

  it('keeps protected files out of the object database and lets a fresh clone check out the snapshot ref', async () => {
    const f = lean();
    writeFileSync(path.join(f.root, '.env'), 'SECRET=never-store-this\n');
    writeFileSync(path.join(f.root, 'id_rsa'), 'private key material\n');
    const { snapshot } = await child(f);
    const objects = git(f.root, 'cat-file', '--batch-all-objects', '--batch-check');
    for (const file of ['.env', 'id_rsa']) expect(objects).not.toContain(git(f.root, 'hash-object', '--no-filters', file).trim());
    expect(snapshot.record.excluded).toBe(2);
    const fresh = path.join(temp(), 'fresh');
    git(path.dirname(fresh), 'clone', '-q', '--no-local', '--no-checkout', '--', f.root, fresh);
    git(fresh, 'fetch', '-q', '--no-tags', 'origin', `${snapshot.record.ref}:refs/kodo/base`);
    git(fresh, 'checkout', '-q', '--detach', 'refs/kodo/base');
    expect(git(fresh, 'rev-parse', 'HEAD').trim()).toBe(snapshot.record.commit);
    expect(existsSync(path.join(fresh, '.env'))).toBe(false);
    expect(read(fresh, 'a.txt')).toBe(read(f.root, 'a.txt'));
  });

  it('queues a snapshot behind a running background write shell', async () => {
    const f = lean();
    const started = await f.tools.execute(f.runId, 'shell.exec', { command: 'sleep 1; printf bg > bg.txt', background: true }, signal()) as { background?: { id: string } };
    expect(started.background?.id).toBeTruthy();
    const { snapshot } = await child(f);
    expect(git(f.root, 'show', `${snapshot.record.commit}:bg.txt`)).toBe('bg');
    expect(f.store.events(f.runId, { types: ['lock.waited'] }).length).toBeGreaterThan(0);
    await f.tools.backgroundSettled();
  });

  it('discards snapshots changed by an outside process and fails after three attempts', async () => {
    const f = lean();
    let attempt = 0;
    const request = { main: f.main(), nodeId: 'node', generation: 1, childId: randomUUID() };
    await expect(snapshotForChild(f.store, f.tools, request, { beforeVerify: () => { writeFileSync(path.join(f.root, 'b.txt'), `external ${attempt++}\n`); } })).rejects.toMatchObject({ code: 'EXECUTION_SNAPSHOT_CHANGED' });
    expect(attempt).toBe(3);
    expect(f.store.events(f.runId, { types: ['execution.snapshot_failed'] })).toHaveLength(1);
    expect(f.store.events(f.runId, { types: ['execution.snapshot'] })).toHaveLength(0);
  });

  it('host-commits a finished child as a host call and rejects protected paths', async () => {
    const f = lean();
    const { committed } = await delivered(f);
    expect(committed).toMatchObject({ status: 'committed', files: ['a.txt', 'c.txt'] });
    expect(hostCalls(f, 'host.execution.commit')[0]).toMatchObject({ host: true, kind: 'tool', effect: 'write', status: 'succeeded', effectOutcome: 'applied' });
    expect(f.store.events(f.runId, { types: ['execution.committed'] })).toHaveLength(1);
    const bad = await child(f, 'bad');
    writeFileSync(path.join(bad.root, '.env'), 'X=1\n');
    expect(hostCommitChild(f.store, f.main(), bad.run.id)).toMatchObject({ status: 'rejected', violations: [{ path: '.env', code: 'PATH_DENIED' }] });
    expect(hostCalls(f, 'host.execution.commit')[1]).toMatchObject({ status: 'failed', effectOutcome: 'not_applied' });
  });
});

describe('plan-based integration wiring', () => {
  it('integrates without touching the index, keeps main observations, and requires a read before editing', async () => {
    const f = lean();
    await f.tools.execute(f.runId, 'file.read', { path: 'a.txt' }, signal());
    const seen = f.store.fileStates.get(f.runId, path.join(f.root, 'a.txt'));
    const { run } = await delivered(f);
    const index = indexHash(f.root);
    const result = await integrateNode(f.store, f.tools, f.main(), run.id);
    expect(result).toMatchObject({ status: 'applied', files: ['a.txt', 'c.txt'] });
    expect(read(f.root, 'a.txt')).toContain('ONE');
    expect(indexHash(f.root)).toBe(index);
    expect(hostCalls(f, 'host.execution.integrate')[0]).toMatchObject({ host: true, status: 'succeeded', effectOutcome: 'applied', effectState: 'started' });
    expect(f.store.fileStates.get(f.runId, path.join(f.root, 'a.txt'))).toEqual(seen);
    expect(f.store.events(f.runId, { types: ['execution.integrated'] })[0]?.data).toMatchObject({ childId: run.id, version: result.status === 'applied' ? result.version : '' });
    const edit = { path: 'a.txt', edits: [{ oldText: 'two', newText: 'TWO' }] };
    await expect(f.tools.execute(f.runId, 'file.patch', edit, signal())).rejects.toMatchObject({ code: 'FILE_STALE' });
    await f.tools.execute(f.runId, 'file.read', { path: 'a.txt' }, signal());
    await f.tools.execute(f.runId, 'file.patch', edit, signal());
    expect(read(f.root, 'a.txt')).toBe(lines('ONE', 'TWO', 'three', 'four', 'five', 'six'));
  });

  it('includes parallel main edits from the actual pre-image and leaves the workspace unchanged on conflict', async () => {
    const f = lean();
    const { run } = await delivered(f);
    writeFileSync(path.join(f.root, 'a.txt'), lines('uno', 'two', 'three', 'four', 'five', 'six'));
    const before = { a: read(f.root, 'a.txt'), status: git(f.root, 'status', '--porcelain=v2', '--untracked-files=all'), index: indexHash(f.root) };
    const result = await integrateNode(f.store, f.tools, f.main(), run.id);
    expect(result.status).toBe('conflict');
    expect({ a: read(f.root, 'a.txt'), status: git(f.root, 'status', '--porcelain=v2', '--untracked-files=all'), index: indexHash(f.root) }).toEqual(before);
    expect(existsSync(path.join(f.root, 'c.txt'))).toBe(false);
    expect(hostCalls(f, 'host.execution.integrate')[0]).toMatchObject({ status: 'failed', effectOutcome: 'not_applied', effectState: 'not_started' });
    expect(f.store.unresolvedWrites(undefined, f.main().sessionId)).toHaveLength(0);
  });

  it('applies a snapshot delivery through workspace.integrate with a persisted plan; legacy clones keep git apply', async () => {
    const f = lean();
    f.store.updateRun(f.runId, { card: { ...f.main().card, tools: [...f.main().card.tools, 'workspace.integrate'] } });
    const { run } = await delivered(f);
    const index = indexHash(f.root);
    const result = await f.tools.execute(f.runId, 'workspace.integrate', { run_id: run.id, apply: true }, signal(), () => {}, { callId: 'model-1:tool-1' }) as { applied: boolean; staged: boolean };
    expect(result).toMatchObject({ applied: true, staged: false });
    expect(indexHash(f.root)).toBe(index);
    expect(plannedIntegration(f.store, f.runId, 'model-1:tool-1')?.record.files).toEqual(['a.txt', 'c.txt']);
  });
});

describe('integration crash recovery', () => {
  async function prepared(f: Lean) {
    const { run } = await delivered(f);
    const plan = prepareIntegration(f.store, f.main(), run.id);
    if (plan.status === 'conflict' || !plan.plan) throw new Error('expected a plan');
    return plan;
  }
  const post = (plan: NonNullable<Awaited<ReturnType<typeof prepared>>['plan']>, file: string): string => Buffer.from(plan.files.find(item => item.path === file)!.post.content!, 'base64').toString();

  it('step 3 (plan persisted, not started): nothing changed, recovery settles the call for re-integration', async () => {
    const f = lean();
    const plan = await prepared(f);
    expect(read(f.root, 'a.txt')).toContain('one');
    expect(await recoverHostCalls(f.store, f.tools, f.main())).toEqual([{ callId: plan.call.id, name: 'host.execution.integrate', status: 'reintegrate' }]);
    expect(f.store.call(plan.call.id)).toMatchObject({ status: 'cancelled', effectOutcome: 'not_applied' });
    expect(existsSync(path.join(f.root, 'c.txt'))).toBe(false);
    const again = await integrateNode(f.store, f.tools, f.main(), plan.delivery.runId);
    expect(again.status).toBe('applied');
  });

  it('step 4 (partially applied): recovery completes the rest from the plan, idempotently', async () => {
    const f = lean();
    const plan = await prepared(f);
    startHostCall(f.store, plan.call.id);
    writeFileSync(path.join(f.root, 'a.txt'), post(plan.plan!, 'a.txt'));
    const [first] = await recoverHostCalls(f.store, f.tools, f.main());
    expect(first?.status).toBe('applied');
    expect(read(f.root, 'c.txt')).toBe(lines('sea'));
    expect(f.store.call(plan.call.id)).toMatchObject({ status: 'succeeded', effectOutcome: 'applied' });
    expect(f.store.readBlob<{ completed: string[] }>(f.store.call(plan.call.id).resultRef!).completed).toEqual(['c.txt']);
    expect(await recoverHostCalls(f.store, f.tools, f.main())).toEqual([]);
  });

  it('step 5 (all files written, not recorded): an interrupted run reconciles through recovery.inspect', async () => {
    const f = lean();
    const plan = await prepared(f);
    startHostCall(f.store, plan.call.id);
    for (const file of plan.plan!.files) writeFileSync(path.join(f.root, file.path), post(plan.plan!, file.path));
    f.store.updateRun(f.runId, { status: 'interrupted' });
    f.app.coordinator.classifyRecovery(f.runId);
    expect(f.store.call(plan.call.id).status).toBe('unknown');
    const inspected = await f.app.coordinator.recovery.inspect(f.runId);
    expect(inspected.resolutions[0]).toMatchObject({ callId: plan.call.id, outcome: 'succeeded', source: 'verifier' });
    expect(inspected.blocked).toEqual([]);
  });

  it('a file outside both planned images makes the integration unknown, writes nothing and blocks completion', async () => {
    const f = lean();
    const plan = await prepared(f);
    startHostCall(f.store, plan.call.id);
    writeFileSync(path.join(f.root, 'a.txt'), 'written by an editor\n');
    const [result] = await recoverHostCalls(f.store, f.tools, f.main());
    expect(result?.status).toBe('unknown');
    expect(read(f.root, 'a.txt')).toBe('written by an editor\n');
    expect(existsSync(path.join(f.root, 'c.txt'))).toBe(false);
    expect(f.store.call(plan.call.id)).toMatchObject({ status: 'unknown', effectOutcome: 'unknown' });
    f.store.updateRun(f.runId, { status: 'interrupted' });
    expect(f.store.unresolvedWrites(undefined, f.main().sessionId).map(item => item.id)).toEqual([plan.call.id]);
  });

  it('an interrupted run settles a not-started host call without replaying it', async () => {
    const f = lean();
    const plan = await prepared(f);
    f.store.updateRun(f.runId, { status: 'interrupted' });
    f.app.coordinator.classifyRecovery(f.runId);
    expect(f.store.call(plan.call.id)).toMatchObject({ status: 'cancelled', effectOutcome: 'not_applied' });
    expect(f.store.unresolvedWrites(undefined, f.main().sessionId)).toHaveLength(0);
  });
});

describe('checkout retention', () => {
  it('keeps a done checkout until release, refuses active ones, and records cleanup failures as events', async () => {
    const f = lean();
    const { run, root } = await delivered(f);
    await integrateNode(f.store, f.tools, f.main(), run.id);
    expect(existsSync(root)).toBe(true);
    const ref = run.execution!.snapshotRef!;
    const released = await releaseChildCheckout(f.store, f.tools, f.main(), run.id);
    expect(released.failures).toEqual([]);
    expect(existsSync(root)).toBe(false);
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', ref).trim()).toBe('');
    const other = await child(f, 'other');
    await expect(releaseChildCheckout(f.store, f.tools, f.main(), other.run.id)).rejects.toMatchObject({ code: 'EXECUTION_ACTIVE' });
    f.store.updateRun(other.run.id, { status: 'completed', execution: { ...other.run.execution!, snapshotRef: 'refs/heads/main' } });
    const failed = await releaseChildCheckout(f.store, f.tools, f.main(), other.run.id);
    expect(failed.failures).toMatchObject([{ target: 'refs/heads/main', code: 'EXECUTION_REF' }]);
    expect(f.store.events(f.runId, { types: ['execution.cleanup_failed'] })[0]?.data).toMatchObject({ target: 'refs/heads/main', reason: 'release' });
    const ended = await cleanupSessionCheckouts(f.store, f.tools, f.main());
    expect(ended.failures).toEqual([]);
    expect(git(f.root, 'for-each-ref', 'refs/kodo/').trim()).toBe('');
  });
});

describe('repeated-check hint', () => {
  const toolText = (request: Request): string => String(request.messages.filter((message: Message) => message.role === 'tool').at(-1)?.content ?? '');

  it('appears only when the code version is unchanged and the last run succeeded', async () => {
    const check = 'PATH=.:$PATH pytest -q';
    const f = lean(
      calls(call('bash', { command: check }, 'b1')),
      calls(call('bash', { command: check }, 'b2')),
      request => { void request; writeFileSync(path.join(f.root, 'a.txt'), 'changed outside\n'); return calls(call('bash', { command: check }, 'b3')); },
      calls(call('bash', { command: 'PATH=.:$PATH pytest --fail' }, 'f1')),
      calls(call('bash', { command: 'PATH=.:$PATH pytest --fail' }, 'f2')),
      answer());
    // Isolated runner fixture; echo alone must never establish test evidence.
    writeFileSync(path.join(f.root, 'pytest'), '#!/bin/sh\nif [ "$1" = "--fail" ]; then exit 3; fi\necho ok\n', { mode: 0o755 });
    expect((await f.app.coordinator.wake(f.runId)).status).toBe('completed');
    expect(toolText(f.requests[1]!)).not.toContain(repeatedCheckHint);
    expect(toolText(f.requests[2]!)).toContain(repeatedCheckHint);
    expect(toolText(f.requests[3]!)).not.toContain(repeatedCheckHint);
    expect(toolText(f.requests[5]!)).not.toContain(repeatedCheckHint);
    const hinted = f.store.events(f.runId, { types: ['check.repeat_hinted'] });
    expect(hinted).toHaveLength(1);
    const prior = f.store.latestEvent(f.runId, { types: ['tool.finished'], match: { callId: hinted[0]!.data.previous as string } });
    expect(hinted[0]!.data.previousSucceededAt).toBe(prior!.time);
    expect(toolText(f.requests[2]!)).toContain(`Previous success: ${prior!.time}`);
    // The hint is attached to a real second execution, not a cached result.
    const repeated = f.store.call(hinted[0]!.data.callId as string);
    expect(f.store.readBlob(repeated.resultRef!)).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('ok') });
    expect(f.store.latestEvent(f.runId, { types: ['tool.finished'], match: { callId: repeated.id } })).toBeDefined();
  });

  it('adds the suite notice once, then reuses a direct check across stderr merging', async () => {
    const f = lean(
      calls(call('bash', { command: "printf '#!/bin/sh\necho 3 passed\n' > pytest && chmod +x pytest" }, 'setup')),
      calls(call('bash', { command: 'PATH=.:$PATH pytest tests/one.py' }, 's0')),
      calls(call('bash', { command: 'PATH=.:$PATH pytest -q 2>&1' }, 's1')),
      calls(call('bash', { command: 'PATH=.:$PATH pytest -q' }, 's2')),
      answer());
    expect((await f.app.coordinator.wake(f.runId)).status).toBe('completed');
    expect(toolText(f.requests[2]!)).toContain('3 passed');
    expect(toolText(f.requests[2]!)).not.toContain(suitePassedNotice);
    expect(toolText(f.requests[3]!)).toContain(suitePassedNotice);
    expect(toolText(f.requests[4]!)).not.toContain(suitePassedNotice);
    expect(toolText(f.requests[4]!)).toContain(repeatedCheckHint);
    expect(f.store.events(f.runId, { types: ['check.suite_passed'] })).toHaveLength(1);
  });

  it('does not equate different commands, even when their output and code version match', async () => {
    const f = lean(calls(call('bash', { command: 'echo ok' }, 'a')), calls(call('bash', { command: 'echo  ok' }, 'b')), answer());
    expect((await f.app.coordinator.wake(f.runId)).status).toBe('completed');
    expect(f.store.events(f.runId, { types: ['check.repeat_hinted'] })).toHaveLength(0);
  });

  it('is never recorded for legacy profiles', async () => {
    const f = fixture({ async complete() { throw new Error('unused'); } }, ['read', 'write', 'exec'], { toolProfile: 'full' });
    const run = f.app.store.run(f.runId);
    f.app.store.updateRun(run.id, { card: { ...run.card, tools: [...new Set([...run.card.tools, 'shell.exec'])] } });
    for (const id of ['x1', 'x2']) await f.app.coordinator.tools.execute(f.runId, 'shell.exec', { command: 'echo ok' }, signal(), () => {}, { callId: id });
    expect(f.app.store.events(f.runId, { types: ['check.started', 'check.repeat_hinted'] })).toHaveLength(0);
  });
});
