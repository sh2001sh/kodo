import { randomUUID } from 'node:crypto';
import type { Store } from '../storage/index.js';
import { errorText, KodoError } from './types.js';
import type { Call, Run } from './types.js';

/** Host operations stay in the session coordination domain while selecting their actual write roots. */
export interface WorkspaceLocks {
  workspaceWriteLock(runId: string, signal?: AbortSignal): Promise<() => void>;
  checkoutWriteLock(ownerId: string, root: string, signal?: AbortSignal): Promise<() => void>;
}

export type HostCallName = 'host.execution.commit' | 'host.execution.integrate' | 'host.task.check';
/** Call ids double as staging directory names, so they stay within `[a-zA-Z0-9-]`. */
export const newHostCallId = (): string => `host-${randomUUID()}`;
export const hostCallNames: readonly string[] = ['host.execution.commit', 'host.execution.integrate', 'host.task.check'];

/**
 * Open a host side-effect call on `run` (6.4): a write tool record outside the model view, so unknown-write
 * blocking, completion invalidation and recovery cover it. `also` runs in the same transaction (6.5 step 3).
 */
export function openHostCall(store: Store, run: Run, name: HostCallName, args: Record<string, unknown>, roots: string[], also: (call: Call) => void = () => {}, id = newHostCallId()): Call {
  const call: Call = {
    id, runId: run.id, step: run.step, kind: 'tool', name, status: 'running', effect: 'write', evidencePermission: 'read',
    requestRef: store.blob({ id, name, arguments: JSON.stringify(args) }), reservedTokens: 0,
    decisionVersion: store.session(run.sessionId).decisionVersion ?? 0, effectState: 'not_started', effectRoots: roots, host: true,
  };
  store.transaction(() => {
    store.putCall(call);
    store.event(run.id, 'tool.started', { callId: id, name, host: true });
    also(call);
  });
  return call;
}

/** Persisted before the first external write of a host call. */
export function startHostCall(store: Store, callId: string): void {
  store.putCall({ ...store.call(callId), effectState: 'started' });
}

/** Settle a host call (or a plan-backed tool call during recovery) with its result; `also` shares the transaction. */
export function finishHostCall(store: Store, callId: string, status: 'succeeded' | 'failed' | 'cancelled' | 'unknown', effectOutcome: NonNullable<Call['effectOutcome']>, result: unknown, also: () => void = () => {}): void {
  store.transaction(() => {
    const call = store.call(callId);
    const resultRef = store.blob(result);
    store.putCall({ ...call, status, effectOutcome, resultRef });
    store.event(call.runId, 'tool.finished', { callId, name: call.name, status, resultRef, ...(call.host ? { host: true } : {}) });
    also();
  });
}

/** Record a failed host step: unknown once its effect started, otherwise not applied. Returns the error for the caller to rethrow. */
export function failHostCall(store: Store, callId: string, error: unknown): unknown {
  const started = store.call(callId).effectState === 'started';
  finishHostCall(store, callId, started ? 'unknown' : 'failed', started ? 'unknown' : 'not_applied', { error: errorText(error), ...(started ? {} : { notStarted: true }) });
  return error;
}

/** A child whose checkout came from a snapshot (6.2); legacy HEAD clones never take the plan-based paths. */
export function snapshotChild(store: Store, childId: string): Run & { execution: NonNullable<Run['execution']> } {
  const child = store.run(childId);
  if (!child.execution?.snapshotRef) throw new KodoError('EXECUTION_OWNER', 'this path requires a snapshot checkout');
  return child as Run & { execution: NonNullable<Run['execution']> };
}
