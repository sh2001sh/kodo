import { randomUUID } from 'node:crypto';
import type { EffectEvidence } from './effect-scan.js';
import { KodoError } from '../runtime/types.js';
import type { Call } from '../runtime/types.js';

/** Running background processes a run may hold at once. */
export const maxBackgroundProcesses = 8;
/** Process facts the background registry needs; a subset of the runner's output. */
export interface ProcessFacts { exitCode: number | null; signal: string | null; stdout: string; stderr: string; cancelled: boolean; timedOut?: boolean; outputLimitExceeded: boolean; effects?: EffectEvidence }
export type BackgroundState = 'running' | 'exited' | 'stopped' | 'failed';
/** Final outcome handed to the owner once a background process settles. */
export interface BackgroundFinish { id: string; runId: string; callId?: string; state: Exclude<BackgroundState, 'running'>; status: Call['status']; output?: ProcessFacts; error?: unknown; stopReason?: string }

/** Live output of one process, shared by the foreground call and its background handle. */
export class Capture {
  stdout = '';
  stderr = '';
  private readonly listeners = new Set<() => void>();
  append(stream: 'stdout' | 'stderr', text: string): void { this[stream] += text; this.notify(); }
  notify(): void { for (const listener of [...this.listeners]) listener(); }
  /** Calls `listener` on every output or state change until the returned function is called. */
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Resolves when `ready()` holds, after `ms`, or rejects when `signal` aborts. */
  waitFor(ms: number, signal: AbortSignal, ready: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (): void => { clearTimeout(timer); this.listeners.delete(check); signal.removeEventListener('abort', abort); };
      const check = (): void => { if (ready()) { done(); resolve(); } };
      const abort = (): void => { done(); reject(signal.reason); };
      const timer = setTimeout(() => { done(); resolve(); }, ms);
      this.listeners.add(check);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }
}
/** A one-shot condition raced against a running process; `dispose` detaches it. */
export interface Trigger { promise: Promise<boolean>; dispose: () => void }
/** True once the child exists and is still running; false when it settled first. */
export function whenSpawned(capture: Capture, spawned: () => boolean, settled: () => boolean): Trigger {
  let unsubscribe: (() => void) | undefined;
  const promise = new Promise<boolean>(resolve => {
    const check = (): void => { if (spawned() || settled()) { unsubscribe?.(); resolve(spawned() && !settled()); } };
    unsubscribe = capture.subscribe(check);
    check();
  });
  return { promise, dispose: () => unsubscribe?.() };
}
/** True once `signal` aborts. */
export function whenAborted(signal: AbortSignal): Trigger {
  let listener: (() => void) | undefined;
  const promise = new Promise<boolean>(resolve => {
    listener = () => resolve(true);
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) resolve(true);
  });
  return { promise, dispose: () => { if (listener) signal.removeEventListener('abort', listener); } };
}
interface Task { settled?: boolean; persistenceError?: unknown; id: string; runId: string; callId?: string; capture: Capture; controller: AbortController; finish?: BackgroundFinish; stopReason?: string; done: Promise<void> }

function slice(content: string, offset: number, maximum: number, label: string): string {
  if (offset > content.length || (offset > 0 && /[\uD800-\uDBFF]/.test(content[offset - 1]!) && /[\uDC00-\uDFFF]/.test(content[offset] ?? ''))) throw new KodoError('PROCESS_CURSOR', `${label} must identify a character boundary within the captured output`);
  let end = Math.min(content.length, offset + maximum);
  if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!) && /[\uDC00-\uDFFF]/.test(content[end]!)) end--;
  return content.slice(offset, end);
}

/**
 * Call status a settled background process leaves. A stop is known only with
 * reconciled effects; a failed start never ran; other failures stay uncertain.
 */
function finalStatus(state: BackgroundFinish['state'], output?: ProcessFacts, error?: unknown, readOnly = false): Call['status'] {
  if (state === 'exited') return 'succeeded';
  if (state === 'stopped') return readOnly || output?.effects?.verified === true ? output?.timedOut ? 'failed' : 'cancelled' : 'unknown';
  return readOnly || (error instanceof KodoError && error.code === 'PROCESS_START') ? 'failed' : 'unknown';
}

/**
 * Background processes of this application, owned by the run that started them.
 * Output stays in memory until the run ends; `onFinish` persists the outcome and
 * `onSettled` then returns the write lock, so a later writer sees the outcome first.
 */
export class BackgroundTasks {
  private readonly tasks = new Map<string, Task>();

  /** Takes over a started process; the caller's cancellation no longer reaches it. */
  adopt(runId: string, callId: string | undefined, capture: Capture, controller: AbortController, running: Promise<ProcessFacts>, hooks: { readOnly?: boolean; onFinish: (finish: BackgroundFinish) => void; onSettled: () => void }): string {
    const id = `bg-${randomUUID()}`;
    const task: Task = { id, runId, ...(callId ? { callId } : {}), capture, controller, done: Promise.resolve() };
    const settle = (state: BackgroundFinish['state'], output?: ProcessFacts, error?: unknown): void => {
      task.finish = { id, runId, ...(callId ? { callId } : {}), state, status: finalStatus(state, output, error, hooks.readOnly), ...(output ? { output } : {}), ...(error === undefined ? {} : { error }), ...(task.stopReason ? { stopReason: task.stopReason } : {}) };
    };
    task.done = running.then(output => settle(output.cancelled ? 'stopped' : 'exited', output), error => settle('failed', undefined, error))
      .then(() => hooks.onFinish(task.finish!))
      // Keep the failure observable while no reader is attached. Release failures are retained too.
      .catch(error => { task.persistenceError = error; })
      .then(() => { try { hooks.onSettled(); } catch (error) { task.persistenceError ??= error; } task.settled = true; capture.notify(); });
    this.tasks.set(id, task);
    return id;
  }

  /** Whether a background process of the run is still running. */
  running(runId: string): boolean { return this.count(runId) > 0; }
  /** Running background processes of the run. */
  count(runId: string): number { return this.owned(runId).filter(task => !task.settled).length; }

  /** Pages a run's background output from character offsets; `waitMs` waits for new output or exit. */
  async read(runId: string, args: { id: string; stdoutOffset?: number; stderrOffset?: number; maxChars?: number; waitMs?: number; stop?: boolean }, signal: AbortSignal): Promise<unknown> {
    const task = this.tasks.get(args.id);
    if (!task || task.runId !== runId) throw new KodoError('PROCESS_HANDLE', 'no background process with this id belongs to this run');
    signal.throwIfAborted();
    if (args.stop && !task.settled) {
      task.stopReason = 'requested through process.read';
      task.controller.abort(new KodoError('CANCELLED', task.stopReason));
      const stopped = whenAborted(signal);
      try { await Promise.race([task.done, stopped.promise.then(() => { throw signal.reason; })]); }
      finally { stopped.dispose(); }
    }
    const stdoutOffset = args.stdoutOffset ?? 0;
    const stderrOffset = args.stderrOffset ?? 0;
    if (task.persistenceError !== undefined) throw task.persistenceError;
    const { capture } = task;
    if (args.waitMs) await capture.waitFor(args.waitMs, signal, () => task.finish !== undefined || capture.stdout.length > stdoutOffset || capture.stderr.length > stderrOffset);
    const maximum = args.maxChars ?? 8000;
    const stdout = slice(capture.stdout, stdoutOffset, maximum, 'stdoutOffset');
    const stderr = slice(capture.stderr, stderrOffset, maximum, 'stderrOffset');
    const finish = task.finish;
    const complete = finish !== undefined && stdoutOffset + stdout.length === capture.stdout.length && stderrOffset + stderr.length === capture.stderr.length;
    return {
      id: task.id, state: finish?.state ?? 'running', stdout, stderr, stdoutOffset: stdoutOffset + stdout.length, stderrOffset: stderrOffset + stderr.length, complete,
      ...(finish?.output ? { exitCode: finish.output.exitCode, ...(finish.output.timedOut ? { timedOut: true } : {}), signal: finish.output.signal, outputLimitExceeded: finish.output.outputLimitExceeded, ...(finish.output.effects ? { effects: finish.output.effects } : {}) } : {}),
      ...(finish?.error === undefined ? {} : { error: finish.error instanceof Error ? finish.error.message : String(finish.error) }),
    };
  }

  /** Waits up to `ms` for every running process of the run; true when none is left running. */
  async wait(runId: string, ms: number, signal: AbortSignal): Promise<boolean> {
    const pending = this.owned(runId).filter(task => !task.settled);
    if (!pending.length) { this.assertPersisted(runId); return true; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.all(pending.map(task => task.done)),
        new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }),
        new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
    this.assertPersisted(runId);
    return !this.running(runId);
  }

  /** Stops the run's running processes and waits for each to settle; `forget` drops their handles. */
  async stop(runId: string, reason: string, forget = false): Promise<void> {
    const owned = this.owned(runId);
    for (const task of owned) if (!task.finish && !task.controller.signal.aborted) {
      task.stopReason = reason;
      task.controller.abort(new KodoError('CANCELLED', reason));
    }
    await Promise.all(owned.map(task => task.done));
    this.assertPersisted(runId);
    if (forget) for (const task of owned) this.tasks.delete(task.id);
  }

  /** Stops every background process of this application and waits for all of them. */
  async stopAll(reason: string): Promise<void> {
    await Promise.all([...new Set([...this.tasks.values()].map(task => task.runId))].map(runId => this.stop(runId, reason, true)));
  }

  /** Resolves once every process adopted so far has settled. */
  async settled(): Promise<void> { await Promise.all([...this.tasks.values()].map(task => task.done)); for (const task of this.tasks.values()) if (task.persistenceError !== undefined) throw task.persistenceError; }

  private assertPersisted(runId: string): void {
    for (const task of this.owned(runId)) if (task.persistenceError !== undefined) throw task.persistenceError;
  }

  private owned(runId: string): Task[] { return [...this.tasks.values()].filter(task => task.runId === runId); }
}
