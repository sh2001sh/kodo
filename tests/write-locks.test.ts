import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, utimesSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { acquirePathLock, acquireWriteLock } from '../src/tools/write-locks.js';
import type { LockEvent } from '../src/tools/write-locks.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

const lockFile = (directory: string, workspace: string): string => path.join(directory, `${createHash('sha256').update(process.platform === 'win32' ? workspace.toLowerCase() : workspace).digest('hex')}.lock`);
/** Pid of a process that has already exited on this host. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  return done;
};

describe('in-process write locks', () => {
  it('lets scheduler probes defer without joining the writer queue', async () => {
    const workspace = temp();
    const release = await acquireWriteLock(workspace, [], { directory: false });
    try {
      await expect(acquireWriteLock(workspace, [], { directory: false, tryOnly: true })).rejects.toMatchObject({ code: 'LOCK_BUSY' });
    } finally { release(); }
    const next = await acquireWriteLock(workspace, [], { directory: false, tryOnly: true });
    next();
  });

  it('defers a scheduler probe at a live external lock without disturbing its owner', async () => {
    const workspace = temp(), directory = temp();
    const file = lockFile(directory, workspace);
    const original = JSON.stringify({ pid: process.pid, host: 'another-host', token: 'external-owner' });
    writeFileSync(file, original);
    await expect(acquireWriteLock(workspace, [], { directory, tryOnly: true })).rejects.toMatchObject({ code: 'LOCK_BUSY' });
    expect(readFileSync(file, 'utf8')).toBe(original);
    unlinkSync(file);
    (await acquireWriteLock(workspace, [], { directory, tryOnly: true }))();
  });

  it('runs non-overlapping write scopes together and serializes overlapping ones', async () => {
    const workspace = temp();
    const a = path.join(workspace, 'a');
    const b = path.join(workspace, 'b');
    const first = await acquireWriteLock(workspace, [a], { directory: false });
    expect(await settled(acquireWriteLock(workspace, [b], { directory: false }).then(release => release()))).toBe(true);
    const nested = acquireWriteLock(workspace, [path.join(a, 'deep.txt')], { directory: false });
    const whole = acquireWriteLock(workspace, [], { directory: false });
    expect(await settled(nested)).toBe(false);
    expect(await settled(whole)).toBe(false);
    first();
    (await nested)();
    (await whole)();
  });

  it('keeps later waiters ordered behind a cancelled waiter', async () => {
    const workspace = temp();
    const first = await acquireWriteLock(workspace, [], { directory: false });
    const controller = new AbortController();
    const cancelled = acquireWriteLock(workspace, [], { directory: false, signal: controller.signal });
    const later = acquireWriteLock(workspace, [], { directory: false });
    controller.abort(new Error('stop'));
    await expect(cancelled).rejects.toThrow('stop');
    expect(await settled(later)).toBe(false);
    first();
    (await later)();
  });

  it('shares reads, waits for overlapping writers and gives a queued writer its turn', async () => {
    const workspace = temp();
    const file = path.join(workspace, 'a.txt');
    const reader = await acquirePathLock(workspace, [file], 'read', { directory: false });
    const otherReader = await acquirePathLock(workspace, [file], 'read', { directory: false });
    const writer = acquirePathLock(workspace, [file], 'write', { directory: false });
    const lateReader = acquirePathLock(workspace, [file], 'read', { directory: false });
    const separate = await acquirePathLock(workspace, [path.join(workspace, 'b.txt')], 'write', { directory: false });
    expect(await settled(writer)).toBe(false);
    expect(await settled(lateReader)).toBe(false);
    reader();
    expect(await settled(writer)).toBe(false);
    otherReader();
    const releaseWriter = await writer;
    expect(await settled(lateReader)).toBe(false);
    releaseWriter();
    (await lateReader)();
    separate();
  });

  it('bounds the in-process queue and emits acquired and released events once', async () => {
    const workspace = temp();
    const events: LockEvent[] = [];
    const owner = await acquirePathLock(workspace, [], 'read', { directory: false, onEvent: event => events.push(event) });
    await expect(acquireWriteLock(workspace, [], { directory: false, timeoutMs: 50 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    owner();
    owner();
    expect(events.map(event => event.type)).toEqual(['lock.acquired', 'lock.released']);
    (await acquireWriteLock(workspace, [], { directory: false }))();
  });
});

describe('cross-process write locks', () => {
  it('shares one lock file among this process and removes it after the last writer', async () => {
    const workspace = temp();
    const directory = temp();
    const one = await acquireWriteLock(workspace, [path.join(workspace, 'a')], { directory });
    const two = await acquireWriteLock(workspace, [path.join(workspace, 'b')], { directory });
    const holder = JSON.parse(readFileSync(lockFile(directory, workspace), 'utf8')) as Record<string, unknown>;
    expect(holder).toMatchObject({ pid: process.pid, host: os.hostname(), workspace });
    one();
    expect(existsSync(lockFile(directory, workspace))).toBe(true);
    two();
    two();
    expect(existsSync(lockFile(directory, workspace))).toBe(false);
  });

  it('takes over a lock left by a dead local process', async () => {
    const workspace = temp();
    const directory = temp();
    const pid = deadPid();
    writeFileSync(lockFile(directory, workspace), JSON.stringify({ pid, host: os.hostname(), token: 'old' }));
    const events: LockEvent[] = [];
    const release = await acquireWriteLock(workspace, [], { directory, onEvent: event => events.push(event) });
    expect(events).toContainEqual({ type: 'lock.takeover', data: { workspace, holderPid: pid, holderHost: os.hostname(), reason: 'holder process no longer exists' } });
    expect(JSON.parse(readFileSync(lockFile(directory, workspace), 'utf8')).pid).toBe(process.pid);
    release();
  });

  it('takes over a lock file left incomplete', async () => {
    const workspace = temp();
    const directory = temp();
    const file = lockFile(directory, workspace);
    writeFileSync(file, '{"pid":');
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const events: LockEvent[] = [];
    (await acquireWriteLock(workspace, [], { directory, onEvent: event => events.push(event) }))();
    expect(events.map(event => event.type)).toEqual(['lock.takeover', 'lock.acquired', 'lock.released']);
  });

  it('takes over a stale pid incarnation but preserves a lock of the current incarnation', async () => {
    const workspace = temp();
    const directory = temp();
    const file = lockFile(directory, workspace);
    const first = await acquireWriteLock(workspace, [], { directory });
    const holder = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; host: string; started: string; token: string };
    expect(holder.started).toMatch(new RegExp(`^${process.platform}:`));
    first();
    writeFileSync(file, JSON.stringify({ ...holder, token: 'former', started: `${process.platform}:former-incarnation` }));
    const events: LockEvent[] = [];
    (await acquireWriteLock(workspace, [], { directory, onEvent: event => events.push(event) }))();
    expect(events.find(event => event.type === 'lock.takeover')?.data.reason).toBe('holder pid belongs to a different process start');
    writeFileSync(file, JSON.stringify(holder));
    await expect(acquirePathLock(workspace, [], 'read', { directory, timeoutMs: 80 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe(holder.token);
  });

  it('fails a write held by a live or remote process after the wait limit', async () => {
    const workspace = temp();
    const directory = temp();
    for (const holder of [{ pid: process.ppid, host: os.hostname() }, { pid: deadPid(), host: `${os.hostname()}-elsewhere` }]) {
      writeFileSync(lockFile(directory, workspace), JSON.stringify({ ...holder, token: 'other' }));
      await expect(acquireWriteLock(workspace, [], { directory, timeoutMs: 150 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
      expect(JSON.parse(readFileSync(lockFile(directory, workspace), 'utf8')).token).toBe('other');
    }
  });

  it('reports a wait once the holder releases and lets an in-process retry start fresh', async () => {
    const workspace = temp();
    const directory = temp();
    writeFileSync(lockFile(directory, workspace), JSON.stringify({ pid: process.ppid, host: os.hostname(), token: 'other' }));
    await expect(acquireWriteLock(workspace, [], { directory, timeoutMs: 60 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    const events: LockEvent[] = [];
    const waiting = acquireWriteLock(workspace, [], { directory, onEvent: event => events.push(event) });
    setTimeout(() => writeFileSync(lockFile(directory, workspace), JSON.stringify({ pid: deadPid(), host: os.hostname(), token: 'gone' })), 120);
    (await waiting)();
    expect(events.map(event => event.type)).toContain('lock.takeover');
  });

  it('keeps a shared acquisition alive when only one compatible waiter cancels', async () => {
    const workspace = temp();
    const directory = temp();
    const file = lockFile(directory, workspace);
    writeFileSync(file, JSON.stringify({ pid: process.ppid, host: os.hostname(), token: 'other' }));
    const controller = new AbortController();
    const first = acquirePathLock(workspace, [path.join(workspace, 'a')], 'read', { directory, signal: controller.signal });
    const second = acquirePathLock(workspace, [path.join(workspace, 'b')], 'read', { directory });
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort(new Error('cancel one reader'));
    await expect(first).rejects.toThrow('cancel one reader');
    unlinkSync(file);
    const release = await second;
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(process.pid);
    release();
    expect(existsSync(file)).toBe(false);
  });
});

describe('tool write locking', () => {
  it('records a takeover event and writes once a dead holder lock is replaced', async () => {
    const root = temp();
    const directory = path.join(temp(), 'locks');
    const app = new Application(path.join(root, '.state'), scripted(calls(call('file.apply_patch', { path: 'out.txt', expectedHash: null, content: 'written' })), answer()), undefined, { agentFactors: { D: false, E: false, B: false }, lockDirectory: directory });
    try {
      const created = app.createRun({ objective: 'Write the file.', workspace: root, binding, permissions: ['read', 'write'] });
      const workspace = app.store.session(created.sessionId).workspace;
      mkdirSync(directory, { recursive: true });
      writeFileSync(lockFile(directory, workspace), JSON.stringify({ pid: deadPid(), host: os.hostname(), token: 'old' }));
      const run = await app.run(created.id);
      expect(run.status, run.error).toBe('completed');
      expect(readFileSync(path.join(root, 'out.txt'), 'utf8')).toBe('written');
      expect(app.store.hasEvent(run.id, { types: ['lock.takeover'] })).toBe(true);
      expect(existsSync(lockFile(directory, workspace))).toBe(false);
    } finally { await app.shutdown(); }
  });
});
