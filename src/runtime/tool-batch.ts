import type { Call } from './types.js';

/** Calls of one parallel batch at most. */
export const maxParallelCalls = 8;
const commandTools = new Set(['process.exec', 'process.run', 'shell.exec']);

/**
 * Splits a response's calls in order: consecutive concurrency-safe calls share a
 * batch of at most `maxParallelCalls`; every other call forms a batch of its own.
 */
export function toolBatches<T>(requests: readonly T[], safe: (request: T) => boolean): T[][] {
  const batches: T[][] = [];
  for (const request of requests) {
    const last = batches.at(-1);
    if (last && safe(request) && safe(last[0]!) && last.length < maxParallelCalls) last.push(request);
    else batches.push([request]);
  }
  return batches;
}

/** Whether an executed command call failed: a nonzero or missing exit code, a timeout, or a failed execution; a background handle has not. */
export function commandFailed(name: string, outcome: { result: unknown; status: Call['status'] }): boolean {
  // A background handle has not finished; its exit is reported separately.
  if (!commandTools.has(name) || outcome.status === 'cancelled' || outcome.status === 'running') return false;
  if (outcome.status !== 'succeeded') return true;
  const result = outcome.result;
  if (!result || typeof result !== 'object') return false;
  return ('exitCode' in result && result.exitCode !== 0) || ('timedOut' in result && result.timedOut === true);
}

/** Result of a later call that never started because a command failed earlier in the same response. */
export function siblingSkipped(failedCallId: string): { result: unknown; status: Call['status'] } {
  return { result: { error: `SIBLING_FAILED: not started because command ${failedCallId} failed earlier in this response; review its result before retrying`, notStarted: true }, status: 'cancelled' };
}

/** Result of a parallel read stopped because a command in its batch failed. */
export function siblingStopped(failedCallId: string): { result: unknown; status: Call['status'] } {
  return { result: { error: `SIBLING_FAILED: stopped because command ${failedCallId} failed in the same batch; read-only, no side effects to inspect` }, status: 'cancelled' };
}
