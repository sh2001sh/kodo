import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { workspacesOverlap } from '../runtime/paths.js';
import { actualPath } from '../runtime/scope.js';
import { KodoError } from '../runtime/types.js';

export type LockMode = 'read' | 'write';
export type LockEvent =
  | { type: 'lock.waited'; data: { workspace: string; waitedMs: number; holderPid?: number } }
  | { type: 'lock.takeover'; data: { workspace: string; holderPid?: number; holderHost?: string; reason: string } }
  | { type: 'lock.acquired' | 'lock.released'; data: { workspace: string; roots: string[]; mode: LockMode } };
export interface WriteLockOptions {
  /** Cross-process lock directory; false keeps the lock in-process only. */
  directory: string | false;
  /** Total acquisition deadline, including the in-process queue and process lock. */
  timeoutMs?: number;
  /** Scheduler probe: never queue behind another owner. */
  tryOnly?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: LockEvent) => void;
}
interface Holder { pid?: unknown; host?: unknown; token?: unknown; started?: unknown }

/** Default cross-process lock directory: `$KODO_HOME/locks`, otherwise `~/.kodo/locks`. */
export function defaultLockDirectory(): string {
  return path.join(process.env.KODO_HOME ?? path.join(os.homedir(), '.kodo'), 'locks');
}
export const crossProcessWaitMs = 30_000;
const tornLockMs = 5_000;
const pollMs = 50;
const executeFile = promisify(execFile);
const requests = new Set<{ workspace: string; roots: string[]; mode: LockMode; done: Promise<void> }>();
interface SharedLock { count: number; token: string; ready: Promise<void>; controller: AbortController; acquired: boolean }
const held = new Map<string, SharedLock>();
let ownIdentity: Promise<string> | undefined;

const overlaps = (left: string[], right: string[]): boolean => left.some(a => right.some(b => workspacesOverlap(a, b)));
const lockKey = (workspace: string): string => process.platform === 'win32' ? workspace.toLowerCase() : workspace;
const timedOut = (): KodoError => new KodoError('LOCK_TIMEOUT', 'workspace lock acquisition exceeded its deadline; the operation was not started, retry later');
const busy = (): KodoError => new KodoError('LOCK_BUSY', 'workspace lock is occupied; the operation was not started, retry later');

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** OS-issued start identity, not an uptime estimate: a reused pid cannot impersonate its former owner. */
async function processIdentity(pid: number, signal?: AbortSignal): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
      const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return started ? `linux:${boot.trim()}:${started}` : undefined;
    }
    const result = process.platform === 'win32'
      ? await executeFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 2_000, maxBuffer: 4096, signal })
      : await executeFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2_000, maxBuffer: 4096, signal });
    const identity = result.stdout.trim();
    return identity ? `${process.platform}:${identity}` : undefined;
  } catch {
    signal?.throwIfAborted();
    // If the OS cannot identify a live process, its lock must not be stolen.
    return undefined;
  }
}

function currentIdentity(): Promise<string> {
  ownIdentity ??= processIdentity(process.pid).then(value => {
    if (!value) { ownIdentity = undefined; throw new KodoError('LOCK_IDENTITY', 'cannot read this process start identity; cross-process lock was not acquired'); }
    return value;
  });
  return ownIdentity;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Waits with the caller's single deadline; cancelling one waiter never cancels a shared owner. */
async function waitUntil<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      // Observe the owner promise even when this waiter has already left.
      if (signal?.aborted) { reject(signal.reason); return; }
      if (Date.now() >= deadline) { reject(timedOut()); return; }
      timer = setTimeout(() => reject(timedOut()), Math.max(1, deadline - Date.now()));
      abort = (): void => reject(signal!.reason);
      signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

function readHolder(file: string): { holder?: Holder; raw: string; torn: boolean } | undefined {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try { return { holder: JSON.parse(raw) as Holder, raw, torn: false }; }
  catch {
    try { return { raw, torn: Date.now() - statSync(file).mtimeMs > tornLockMs }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}

function removeIf(file: string, raw: string): void {
  try { if (readFileSync(file, 'utf8') === raw) unlinkSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function acquireFile(file: string, workspace: string, token: string, signal: AbortSignal, onAcquired: () => void, onEvent?: WriteLockOptions['onEvent'], tryOnly = false): Promise<void> {
  mkdirSync(path.dirname(file), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, host: os.hostname(), started: await currentIdentity(), token, workspace });
  let checked: { raw: string; time: number; identity?: string } | undefined;
  for (;;) {
    signal.throwIfAborted();
    try { writeFileSync(file, content, { flag: 'wx', encoding: 'utf8' }); onAcquired(); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const current = readHolder(file);
    if (!current) continue;
    const pid = typeof current.holder?.pid === 'number' && Number.isSafeInteger(current.holder.pid) && current.holder.pid > 0 ? current.holder.pid : undefined;
    const host = typeof current.holder?.host === 'string' ? current.holder.host : undefined;
    let reason = current.torn ? 'lock file was left incomplete' : undefined;
    if (!reason && pid !== undefined && host === os.hostname()) {
      if (!alive(pid)) reason = 'holder process no longer exists';
      else if (typeof current.holder?.started === 'string' && current.holder.started.startsWith(`${process.platform}:`)) {
        if (!checked || checked.raw !== current.raw || Date.now() - checked.time >= 1000) checked = { raw: current.raw, time: Date.now(), identity: pid === process.pid ? await currentIdentity() : await processIdentity(pid, signal) };
        if (checked.identity && checked.identity !== current.holder.started) reason = 'holder pid belongs to a different process start';
      }
    }
    if (reason) {
      signal.throwIfAborted();
      removeIf(file, current.raw);
      onEvent?.({ type: 'lock.takeover', data: { workspace, ...(pid === undefined ? {} : { holderPid: pid }), ...(host === undefined ? {} : { holderHost: host }), reason } });
      continue;
    }
    if (tryOnly) throw busy();
    await sleep(pollMs, signal);
  }
}

/** One workspace lock shared by this process's compatible readers and writers. */
async function processLock(workspace: string, options: WriteLockOptions & { directory: string }, deadline: number): Promise<() => void> {
  const file = path.join(options.directory, `${createHash('sha256').update(lockKey(workspace)).digest('hex')}.lock`);
  let entry = held.get(file);
  if (options.tryOnly && entry && !entry.acquired) throw busy();
  if (!entry) {
    const token = randomUUID();
    const controller = new AbortController();
    entry = { count: 0, token, controller, acquired: false, ready: Promise.resolve() };
    const created = entry;
    created.ready = acquireFile(file, workspace, token, controller.signal, () => { created.acquired = true; }, options.onEvent, options.tryOnly);
    held.set(file, created);
  }
  const current = entry;
  current.count++;
  const release = (): void => {
    if (--current.count !== 0) return;
    current.controller.abort(new KodoError('LOCK_CANCELLED', 'all workspace lock waiters left'));
    // Acquisition checks the signal immediately before its synchronous create,
    // and sets acquired before yielding, so no lock can appear after this check.
    if (held.get(file) === current) held.delete(file);
    if (current.acquired) {
      const holder = readHolder(file);
      if (holder?.holder?.token === current.token) removeIf(file, holder.raw);
    }
  };
  try { await waitUntil(current.ready, deadline, options.signal); }
  catch (error) { release(); throw error; }
  return release;
}

/**
 * Fair prefix read/write lock: readers share, overlapping writers wait in arrival
 * order. A workspace lock serializes all access across processes, conservatively
 * including readers so another process's writer cannot overlap a local read.
 */
export async function acquirePathLock(workspace: string, roots: readonly string[], mode: LockMode, options: WriteLockOptions): Promise<() => void> {
  if (!['read', 'write'].includes(mode)) throw new KodoError('LOCK_MODE', 'lock mode must be read or write');
  const timeoutMs = options.timeoutMs ?? crossProcessWaitMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new KodoError('LOCK_TIMEOUT', 'lock timeout must be a positive integer');
  const started = Date.now();
  const deadline = started + timeoutMs;
  workspace = actualPath(workspace);
  const scope = roots.length ? roots.map(root => actualPath(path.resolve(workspace, root))) : [workspace];
  const previous = [...requests].filter(entry => (mode === 'write' || entry.mode === 'write') && workspacesOverlap(workspace, entry.workspace) && overlaps(scope, entry.roots));
  options.signal?.throwIfAborted();
  if (options.tryOnly && previous.length) throw busy();
  let resolve!: () => void;
  const done = new Promise<void>(complete => { resolve = complete; });
  const entry = { workspace, roots: scope, mode, done };
  requests.add(entry);
  const ready = Promise.all(previous.map(item => item.done));
  const releaseLocal = (): void => { requests.delete(entry); resolve(); };
  let unlockFile: (() => void) | undefined;
  try {
    await waitUntil(ready, deadline, options.signal);
    if (options.directory !== false) unlockFile = await processLock(workspace, { ...options, directory: options.directory }, deadline);
    options.signal?.throwIfAborted();
    if (Date.now() - started >= pollMs) options.onEvent?.({ type: 'lock.waited', data: { workspace, waitedMs: Date.now() - started } });
    options.onEvent?.({ type: 'lock.acquired', data: { workspace, roots: scope, mode } });
  } catch (error) {
    unlockFile?.();
    // Preserve dependencies of later requests when this waiter leaves early.
    void ready.then(releaseLocal);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlockFile?.(); }
    finally { releaseLocal(); options.onEvent?.({ type: 'lock.released', data: { workspace, roots: scope, mode } }); }
  };
}

/** Compatibility entry point for native writers and recovery. */
export function acquireWriteLock(workspace: string, roots: readonly string[], options: WriteLockOptions): Promise<() => void> {
  return acquirePathLock(workspace, roots, 'write', options);
}
